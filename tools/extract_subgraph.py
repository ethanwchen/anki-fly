#!/usr/bin/env python3
"""Build the Anki Fly data pack (addon/web/data/{graph.bin,meta.json}) from MaleCNS v1.0.

Data: Janelia FlyEM / Google "male-cns:v1.0" via the public neuPrint Cypher endpoint
(https://neuprint-cns.janelia.org). License CC BY 4.0.

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
DATASET = "male-cns:v1.0"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "addon", "web", "data")
CACHE = os.path.join(HERE, "cache")
MIN_W = 3
W_UNIT = 0.275
APL_SCALE = 0.5
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


NODE_RETURN = "RETURN n.bodyId AS id, n.type AS type, n.instance AS inst, n.consensusNt AS nt, n.somaLocation AS soma, n.superclass AS sc, n.flywireType AS fwt, n.class AS cls, n.subclass AS subcls"


def nodes(where, key):
    res = cypher(f"MATCH (n:Neuron) WHERE {where} {NODE_RETURN}", key)
    cols = res["columns"]
    out = []
    for row in res["data"]:
        d = dict(zip(cols, row))
        if d["soma"] and d["soma"].get("coordinates"):
            d["xyz"] = d["soma"]["coordinates"]
        else:
            d["xyz"] = None
        del d["soma"]
        out.append(d)
    return out


def main():
    groups = {}
    sel = {}  # id -> node dict

    def add(ns, group=None):
        for n in ns:
            sel[n["id"]] = n
            if group:
                groups.setdefault(group, set()).add(n["id"])

    # --- olfactory PNs, grouped by glomerulus
    pns = nodes("n.type =~ '^[A-Za-z0-9+]+_(ad|l|lv|v|il|vl|lvPN|)PN$' AND n.superclass = 'cb_intrinsic' AND n.status = 'Traced'", "pns")
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
        f"AND n.superclass = 'cb_intrinsic' AND NOT n.type STARTS WITH 'KC' AND NOT n.type =~ '.*PN$' "
        f"WITH n, count(DISTINCT p) AS k WHERE k >= 8 {NODE_RETURN}", "al_ln")
    cols = ln["columns"]
    ln_nodes = []
    for row in ln["data"]:
        d = dict(zip(cols, row)); d["xyz"] = d["soma"]["coordinates"] if d["soma"] else None; del d["soma"]
        ln_nodes.append(d)
    # NOTE: not added to the graph. Cholinergic lLN2T/lLN1 "excitatory" LNs recruit every glomerulus in a
    # LIF model (their real effect is mostly weak electrical coupling), so we drive PNs directly instead.
    print(f"AL local neurons found (excluded): {len(ln_nodes)}")

    add(nodes("n.type STARTS WITH 'KC' AND n.status = 'Traced'", "kc"), "KC")
    add(nodes("n.type IN ['APL','DPM']", "apl"), "APL_DPM")
    add(nodes("n.type STARTS WITH 'MBON'", "mbon"), "MBON")
    add(nodes("n.type =~ 'PAM[0-9][0-9].*'", "pam"), "PAM")
    add(nodes("n.type =~ 'PPL1[0-9][0-9].*'", "ppl1"), "PPL1")
    add(nodes("n.type = 'LC4'", "lc4"), "LC4")
    add(nodes("n.type = 'DNp01'", "gf"), "GF")
    for t in ["DNp09", "DNg11", "MDN", "DNa01", "DNa02"]:
        add(nodes(f"n.type = '{t}'", t.lower()), t)
    add(nodes("n.flywireType = 'LB3' AND n.class = 'gustatory'", "grn_sugar"), "GRN_sugar")
    add(nodes("n.type IN ['MN9','MN1','MN6']", "mn"), "MN_proboscis")
    # interneurons on GRN -> ? -> MN paths
    grn_ids = sorted(groups["GRN_sugar"]); mn_ids = sorted(groups["MN_proboscis"])
    inter = cypher(
        f"MATCH (g:Neuron)-[a:ConnectsTo]->(i:Neuron)-[b:ConnectsTo]->(m:Neuron) "
        f"WHERE g.bodyId IN {grn_ids} AND m.bodyId IN {mn_ids} AND a.weight >= 5 AND b.weight >= 5 "
        f"WITH DISTINCT i AS n {NODE_RETURN}", "grn_inter")
    cols = inter["columns"]
    inter_nodes = []
    for row in inter["data"]:
        d = dict(zip(cols, row)); d["xyz"] = d["soma"]["coordinates"] if d["soma"] else None; del d["soma"]
        inter_nodes.append(d)
    inter2 = cypher(
        f"MATCH (g:Neuron)-[a:ConnectsTo]->(i:Neuron)-[b:ConnectsTo]->(j:Neuron)-[c:ConnectsTo]->(m:Neuron) "
        f"WHERE g.bodyId IN {grn_ids} AND m.bodyId IN {mn_ids} AND a.weight >= 8 AND b.weight >= 8 AND c.weight >= 8 "
        f"AND i.superclass = 'cb_intrinsic' AND j.superclass = 'cb_intrinsic' "
        f"UNWIND [i, j] AS n WITH DISTINCT n {NODE_RETURN}", "grn_inter2")
    cols = inter2["columns"]
    for row in inter2["data"]:
        d = dict(zip(cols, row)); d["xyz"] = d["soma"]["coordinates"] if d["soma"] else None; del d["soma"]
        if d["id"] not in sel:
            inter_nodes.append(d)
    add(inter_nodes, "GRN_interneurons")
    print(f"GRN interneurons (1- and 2-hop): {len(inter_nodes)}")

    # silhouette sample
    sil = nodes("n.superclass IN ['cb_intrinsic','visual_projection','descending_neuron','ol_intrinsic','visual_centrifugal'] AND n.status = 'Traced' AND n.somaLocation IS NOT NULL", "silhouette_all2")
    sil = [n for n in sil if n["id"] not in sel and n["xyz"]]
    random.shuffle(sil)
    add(sil[:SILHOUETTE_N], "background")
    bg_ids = set(groups["background"])
    print(f"total neurons: {len(sel)}")

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
                sel[b]["xyz"] = [cx + random.uniform(-1500, 1500), cy + random.uniform(-1500, 1500), cz]
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
        "source": "MaleCNS v1.0 (Janelia FlyEM / Google Research), CC BY 4.0, via neuprint-cns.janelia.org",
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
