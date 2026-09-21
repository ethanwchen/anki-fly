#!/usr/bin/env python3
"""Build an Anki Fly data pack ({graph.bin,meta.json}) from a connectome served by neuprint-cns.janelia.org.

    --dataset male    MaleCNS v1.0 ("male-cns:v1.0", CC BY 4.0)          -> addon/web/data/          (default)
    --dataset female  FlyWire FAFB v783b ("flywire-fafb:v783b", CC BY-NC 4.0) -> addon/web/data/female/

Both packs have the same binary/JSON layout, the same group names and the same plastic-edge convention,
so fly.js / exam.js can load either one unchanged.

Subcircuit:
  * olfactory uniglomerular projection neurons (grouped by glomerulus)   -> odor input
  * Kenyon cells, APL, DPM, MBONs, PAM + PPL1 dopaminergic neurons        -> mushroom body learning
  * LC4 -> DNp01 (giant fiber)                                            -> looming escape
  * sugar GRNs (flywireType LB3) + interneurons -> MN9/MN1/MN6           -> proboscis extension
  * DNp09, DNg11, MDN, DNa01, DNa02                                       -> walk / groom / backup / turn
  * a random sample of other central-brain neurons for the silhouette

All ConnectsTo edges among the selected bodies with weight >= MIN_W are kept.
Synaptic weight (mV per presynaptic spike) = 0.275 * count * sign(NT)  (Shiu et al. 2024).
"""
import hashlib, json, os, re, struct, sys, random, time
import requests

API = "https://neuprint-cns.janelia.org/api/custom/custom"
HERE = os.path.dirname(os.path.abspath(__file__))

# Per-dataset differences. Everything else (weights, APL scaling, open-loop silhouette, MIN_W) is shared.
DATASETS = {
    "male": {
        "dataset": "male-cns:v1.0",
        "out": os.path.join(HERE, "..", "addon", "web", "data"),
        "cache": os.path.join(HERE, "cache"),
        "source": "MaleCNS v1.0 (Janelia FlyEM / Google Research), CC BY 4.0, via neuprint-cns.janelia.org",
        "nt_prop": "n.consensusNt",
        "central": "cb_intrinsic",                  # superclass of central-brain intrinsic neurons
        "silhouette_sc": ["cb_intrinsic", "visual_projection", "descending_neuron", "ol_intrinsic", "visual_centrifugal"],
        "gf": "n.type = 'DNp01'",
        "grn_sugar": "n.flywireType = 'LB3' AND n.class = 'gustatory'",
        "mn": "n.type IN ['MN9','MN1','MN6']",
        "xyz_scale": (1, 1, 1),                     # somaLocation already in a uniform unit
        "apl_scale": 0.5,                           # see APL_SCALE note below
        "drop_autapses": False,                     # only 6 tiny self-edges in the male subgraph; kept as-is
        "fill_nt": {},                              # group -> NT used when the prediction is missing
        "force_nt": {},                             # group -> NT applied regardless of prediction
    },
    "female": {
        "dataset": "flywire-fafb:v783b",
        "out": os.path.join(HERE, "..", "addon", "web", "data", "female"),
        "cache": os.path.join(HERE, "cache", "female"),
        "source": "FlyWire FAFB v783b (Dorkenwald et al. 2024; Schlegel et al. 2024 annotations), CC BY-NC 4.0, via neuprint-cns.janelia.org",
        "nt_prop": "n.predictedNt",                 # FlyWire has no consensusNt; Eckstein et al. 2024 predictions
        "central": "central",
        "silhouette_sc": ["central", "visual_projection", "descending", "optic", "visual_centrifugal"],
        "gf": "n.type = 'DNp01'",                   # hemibrainType 'Giant Fiber'
        "grn_sugar": "n.type = 'LB3' AND n.class = 'gustatory'",   # subclass 'sugar/water'
        "mn": "n.type IN ['CB0701','CB0720','CB0858']",             # = MN9, MN1, MN6
        "xyz_scale": (4, 4, 40),                    # FAFB somaLocation is in 4x4x40 nm voxels -> nm
        # Tuned like the male value: with self-edges dropped (below) APL_SCALE 0.5 leaves ~3% of KCs active and
        # the MBONs silent, 0.25 gives ~10%; 0.35 gives ~6.5% KC activation per 6-glomerulus odor with clear
        # MBON responses (tests/test_circuits_female.mjs).
        "apl_scale": 0.35,
        # The FlyWire import on neuprint-cns carries a ConnectsTo self-edge on essentially every neuron
        # (154k of 168k neurons, weight ~5% of the cell's synapses: KC ~27, APL ~3000). These are synapse-
        # detector self-contacts, not real autapses; a KC re-exciting itself by 7 mV per spike and an APL
        # silencing itself by 850 mV make the mushroom body run away / go quiet, so they are dropped.
        "drop_autapses": True,
        # FlyWire NT predictions on sensory axons and small DNs are patchy (38/122 sugar GRNs have none,
        # a few are called Glu/5-HT). Sugar GRNs are cholinergic (Gr5a/Gr64f), so the group is forced to ACh;
        # for the other groups only a missing prediction is filled with the known transmitter.
        "fill_nt": {"KC": "acetylcholine", "LC4": "acetylcholine", "GF": "acetylcholine", "PAM": "dopamine",
                    "PPL1": "dopamine", "MN_proboscis": "acetylcholine"},
        "force_nt": {"GRN_sugar": "acetylcholine"},
    },
}
CFG = DATASETS["male"]
DATASET = CFG["dataset"]
OUT = CFG["out"]
CACHE = CFG["cache"]
MIN_W = 3
W_UNIT = 0.275
APL_SCALE = 0.5  # default; overridden per dataset via DATASETS[...]["apl_scale"]
SIGN = {"acetylcholine": 1.0, "gaba": -1.0, "glutamate": -1.0, "dopamine": 0.0, "serotonin": 0.0, "octopamine": 0.0}
NT_CODE = {"acetylcholine": "ACH", "gaba": "GABA", "glutamate": "GLUT", "dopamine": "DA", "serotonin": "SER", "octopamine": "OCT"}
SILHOUETTE_N = 4000
random.seed(7)


def cypher(q, key):
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, key + ".json")
    if os.path.exists(path):
        return json.load(open(path))
    for attempt in range(4):
        r = requests.post(API, json={"cypher": q, "dataset": DATASET}, timeout=300)
        if r.ok:
            break
        time.sleep(3 * (attempt + 1))
    r.raise_for_status()
    data = r.json()
    json.dump(data, open(path, "w"))
    return data


NODE_RETURN = None  # set in main() from CFG


def node_return():
    return (f"RETURN n.bodyId AS id, n.type AS type, n.instance AS inst, {CFG['nt_prop']} AS nt, n.somaLocation AS soma, "
            f"n.superclass AS sc, n.flywireType AS fwt, n.class AS cls, n.subclass AS subcls")


def row_to_node(cols, row):
    d = dict(zip(cols, row))
    if d["soma"] and d["soma"].get("coordinates"):
        sx, sy, sz = CFG["xyz_scale"]
        x, y, z = d["soma"]["coordinates"]
        d["xyz"] = [x * sx, y * sy, z * sz]
    else:
        d["xyz"] = None
    del d["soma"]
    return d


def nodes(where, key):
    res = cypher(f"MATCH (n:Neuron) WHERE {where} {NODE_RETURN}", key)
    return [row_to_node(res["columns"], row) for row in res["data"]]


def main():
    global CFG, DATASET, OUT, CACHE, NODE_RETURN
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=sorted(DATASETS), default="male")
    args = ap.parse_args()
    CFG = DATASETS[args.dataset]; DATASET = CFG["dataset"]; OUT = CFG["out"]; CACHE = CFG["cache"]
    NODE_RETURN = node_return()
    CENTRAL = CFG["central"]
    global APL_SCALE
    APL_SCALE = CFG.get("apl_scale", APL_SCALE)
    print(f"dataset {DATASET} -> {os.path.relpath(OUT)}")

    groups = {}
    sel = {}  # id -> node dict

    def add(ns, group=None):
        for n in ns:
            sel[n["id"]] = n
            if group:
                groups.setdefault(group, set()).add(n["id"])

    # --- olfactory PNs, grouped by glomerulus
    pns = nodes(f"n.type =~ '^[A-Za-z0-9+]+_(ad|l|lv|v|il|vl|lvPN|)PN$' AND n.superclass = '{CENTRAL}' AND n.status = 'Traced'", "pns")
    glom = {}
    for n in pns:
        g = n["type"].split("_")[0]
        if g.startswith("M") and "+" in g:  # skip multiglomerular
            continue
        glom.setdefault(g, []).append(n)
    # keep glomeruli with >= 2 PNs for robustness
    glom = {g: v for g, v in glom.items() if len(v) >= 2}
    for g, v in glom.items():
        add(v, f"PN:{g}")
    print(f"PNs: {sum(len(v) for v in glom.values())} in {len(glom)} glomeruli")

    # antennal-lobe local neurons: intrinsic neurons strongly presynaptic to many PNs (mostly GABAergic)
    pn_ids = sorted(b for g, v in glom.items() for b in (x["id"] for x in v))
    ln = cypher(
        f"MATCH (n:Neuron)-[c:ConnectsTo]->(p:Neuron) WHERE p.bodyId IN {pn_ids} AND c.weight >= 5 "
        f"AND n.superclass = '{CENTRAL}' AND NOT n.type STARTS WITH 'KC' AND NOT n.type =~ '.*PN$' "
        f"WITH n, count(DISTINCT p) AS k WHERE k >= 8 {NODE_RETURN}", "al_ln")
    ln_nodes = [row_to_node(ln["columns"], row) for row in ln["data"]]
    # NOTE: not added to the graph. Cholinergic lLN2T/lLN1 "excitatory" LNs recruit every glomerulus in a
    # LIF model (their real effect is mostly weak electrical coupling), so we drive PNs directly instead.
    print(f"AL local neurons found (excluded): {len(ln_nodes)}")

    add(nodes("n.type STARTS WITH 'KC' AND n.status = 'Traced'", "kc"), "KC")
    add(nodes("n.type IN ['APL','DPM']", "apl"), "APL_DPM")
    add(nodes("n.type STARTS WITH 'MBON'", "mbon"), "MBON")
    add(nodes("n.type =~ 'PAM[0-9][0-9].*'", "pam"), "PAM")
    add(nodes("n.type =~ 'PPL1[0-9][0-9].*'", "ppl1"), "PPL1")
    add(nodes("n.type = 'LC4'", "lc4"), "LC4")
    add(nodes(CFG["gf"], "gf"), "GF")
    for t in ["DNp09", "DNg11", "MDN", "DNa01", "DNa02"]:
        add(nodes(f"n.type = '{t}'", t.lower()), t)
    add(nodes(CFG["grn_sugar"], "grn_sugar"), "GRN_sugar")
    add(nodes(CFG["mn"], "mn"), "MN_proboscis")
    # interneurons on GRN -> ? -> MN paths
    grn_ids = sorted(groups["GRN_sugar"]); mn_ids = sorted(groups["MN_proboscis"])
    inter = cypher(
        f"MATCH (g:Neuron)-[a:ConnectsTo]->(i:Neuron)-[b:ConnectsTo]->(m:Neuron) "
        f"WHERE g.bodyId IN {grn_ids} AND m.bodyId IN {mn_ids} AND a.weight >= 5 AND b.weight >= 5 "
        f"WITH DISTINCT i AS n {NODE_RETURN}", "grn_inter")
    inter_nodes = [row_to_node(inter["columns"], row) for row in inter["data"]]
    inter2 = cypher(
        f"MATCH (g:Neuron)-[a:ConnectsTo]->(i:Neuron)-[b:ConnectsTo]->(j:Neuron)-[c:ConnectsTo]->(m:Neuron) "
        f"WHERE g.bodyId IN {grn_ids} AND m.bodyId IN {mn_ids} AND a.weight >= 8 AND b.weight >= 8 AND c.weight >= 8 "
        f"AND i.superclass = '{CENTRAL}' AND j.superclass = '{CENTRAL}' "
        f"UNWIND [i, j] AS n WITH DISTINCT n {NODE_RETURN}", "grn_inter2")
    for row in inter2["data"]:
        d = row_to_node(inter2["columns"], row)
        if d["id"] not in sel and d["id"] not in {x["id"] for x in inter_nodes}:
            inter_nodes.append(d)
    add(inter_nodes, "GRN_interneurons")
    print(f"GRN interneurons (1- and 2-hop): {len(inter_nodes)}")

    # silhouette sample
    sil = nodes(f"n.superclass IN {CFG['silhouette_sc']} AND n.status = 'Traced' AND n.somaLocation IS NOT NULL", "silhouette_all2")
    sil = [n for n in sil if n["id"] not in sel and n["xyz"]]
    random.shuffle(sil)
    add(sil[:SILHOUETTE_N], "background")
    bg_ids = set(groups["background"])
    print(f"total neurons: {len(sel)}")

    # transmitter fixes for datasets with patchy predictions (see DATASETS[...]["fill_nt"/"force_nt"])
    for g, t in CFG["force_nt"].items():
        for b in groups.get(g, ()):
            sel[b]["nt"] = t
    for g, t in CFG["fill_nt"].items():
        for b in groups.get(g, ()):
            if not sel[b]["nt"]:
                sel[b]["nt"] = t

    # --- edges among selected
    ids = sorted(sel)
    index = {bid: i for i, bid in enumerate(ids)}
    edges = []
    B = 4000
    for s in range(0, len(ids), B):
        chunk = ids[s:s + B]
        res = cypher(
            f"MATCH (a:Neuron)-[c:ConnectsTo]->(b:Neuron) WHERE a.bodyId IN {chunk} AND c.weight >= {MIN_W} "
            f"RETURN a.bodyId, b.bodyId, c.weight", f"edges_{MIN_W}_{hashlib.md5(str(chunk).encode()).hexdigest()[:10]}")
        for a, b, w in res["data"]:
            if a == b and CFG["drop_autapses"]:
                continue
            if b in index and a not in bg_ids:   # silhouette neurons are open-loop: driven by the circuit, never feed back
                edges.append((index[a], index[b], w))
        print(f"  edges so far: {len(edges)}")

    # --- neurons without a soma in the volume (sensory): place at centroid of downstream partners + jitter
    downstream = {}
    for a, b, _ in edges:
        downstream.setdefault(a, []).append(b)
    for i, b in enumerate(ids):
        if sel[b]["xyz"] is None:
            pts = [sel[ids[j]]["xyz"] for j in downstream.get(i, []) if sel[ids[j]]["xyz"]]
            if pts:
                cx = sum(p[0] for p in pts) / len(pts); cy = sum(p[1] for p in pts) / len(pts); cz = sum(p[2] for p in pts) / len(pts)
                j = 1500 * CFG["xyz_scale"][0]; sel[b]["xyz"] = [cx + random.uniform(-j, j), cy + random.uniform(-j, j), cz]
    orphan = [b for b in ids if sel[b]["xyz"] is None]
    for b in orphan:
        sel[b]["xyz"] = [0, 0, 0]
    print(f"neurons placed at partner centroid: {sum(1 for b in ids if sel[b]['xyz'] and b in {x for x in ids})}, unplaced: {len(orphan)}")

    # --- weights
    nt = [NT_CODE.get(sel[b]["nt"], "UNK") for b in ids]
    def sign(i):
        return SIGN.get(sel[ids[i]]["nt"], 0.0)
    # APL and DPM are non-spiking, graded neurons; a spiking LIF APL at its max rate over-inhibits the
    # Kenyon cells, so their output is scaled to give ~5% KC activation per odor (see tests/test_circuits.mjs).
    graded = {index[b] for b in groups["APL_DPM"]}
    pre = [e[0] for e in edges]; post = [e[1] for e in edges]
    wts = [W_UNIT * e[2] * sign(e[0]) * (APL_SCALE if e[0] in graded else 1.0) for e in edges]

    # CSR
    n = len(ids)
    order = sorted(range(len(edges)), key=lambda k: (pre[k], post[k]))
    rowptr = [0] * (n + 1)
    for k in order:
        rowptr[pre[k] + 1] += 1
    for i in range(n):
        rowptr[i + 1] += rowptr[i]
    col = [post[k] for k in order]
    w = [wts[k] for k in order]
    edge_pos = {}  # (pre,post) -> csr index
    for pos, k in enumerate(order):
        edge_pos[(pre[k], post[k])] = pos

    # plastic KC->MBON edges. cls 0 = approach MBON (GABA/ACh; depressed by PPL1), 1 = avoid (Glu; depressed by PAM)
    kc = groups["KC"]; mbon = groups["MBON"]
    plastic = {"edge": [], "pre": [], "post": [], "cls": []}
    for (a, b), pos in edge_pos.items():
        if ids[a] in kc and ids[b] in mbon:
            c = 1 if sel[ids[b]]["nt"] == "glutamate" else 0
            plastic["edge"].append(pos); plastic["pre"].append(a); plastic["post"].append(b); plastic["cls"].append(c)
    print(f"plastic KC->MBON edges: {len(plastic['edge'])}")

    # --- write graph.bin
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "graph.bin"), "wb") as f:
        f.write(b"FLYG"); f.write(struct.pack("<II", n, len(col)))
        f.write(struct.pack(f"<{n+1}i", *rowptr)); f.write(struct.pack(f"<{len(col)}i", *col)); f.write(struct.pack(f"<{len(w)}f", *w))

    # --- meta.json
    xyz = []
    for b in ids:
        x, y, z = sel[b]["xyz"]
        xyz += [x, y, z]
    G = {k: sorted(index[b] for b in v) for k, v in groups.items() if not k.startswith("PN:")}
    G["PN_glomeruli"] = {k[3:]: sorted(index[b] for b in v) for k, v in groups.items() if k.startswith("PN:")}
    meta = {
        "source": CFG["source"], "dataset": DATASET,
        "n": n, "nnz": len(col), "min_weight": MIN_W, "w_unit_mV": W_UNIT,
        "type": [sel[b]["type"] or "" for b in ids],
        "nt": nt,
        "xyz": xyz,
        "groups": G,
        "plastic": plastic,
    }
    json.dump(meta, open(os.path.join(OUT, "meta.json"), "w"), separators=(",", ":"))
    sz = os.path.getsize(os.path.join(OUT, "graph.bin")) + os.path.getsize(os.path.join(OUT, "meta.json"))
    print(f"wrote {n} neurons, {len(col)} edges, {sz/1e6:.1f} MB")
    for k, v in G.items():
        if k != "PN_glomeruli":
            print(f"  {k}: {len(v)}")
    print(f"  glomeruli: {len(G['PN_glomeruli'])}")


if __name__ == "__main__":
    main()
