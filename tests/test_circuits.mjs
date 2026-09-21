import { Sim, parseGraph } from '../addon/web/sim.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const meta = JSON.parse(readFileSync(new URL('../addon/web/data/meta.json', import.meta.url)));
const G = meta.groups;
const load = () => { const sim = new Sim(parseGraph(readFileSync(new URL('../addon/web/data/graph.bin', import.meta.url)).buffer.slice(0)));
  const P = meta.plastic; sim.setPlasticEdges(Int32Array.from(P.edge), Int32Array.from(P.pre), Int32Array.from(P.post), Uint8Array.from(P.cls)); for (const i of G.APL_DPM) sim.noQuench[i] = 1; return sim; };
const count = (sim, idx) => idx.reduce((s, i) => s + sim.spikeCounts[i], 0);

{ const sim = load(); sim.stimulate(G.GRN_sugar, 150, 1000); sim.run(1000);
  console.log(`sugar: GRN spikes=${count(sim, G.GRN_sugar)} interneurons=${count(sim, G.GRN_interneurons)} MN=${count(sim, G.MN_proboscis)} MNrate=${sim.meanRate(G.MN_proboscis).toFixed(1)}Hz`);
  assert.ok(count(sim, G.MN_proboscis) > 0, 'sugar should drive proboscis MNs'); }
{ const sim = load(); sim.stimulate(G.LC4, 150, 300); sim.run(400);
  console.log(`loom: LC4 spikes=${count(sim, G.LC4)} GF=${count(sim, G.GF)}`);
  assert.ok(count(sim, G.GF) > 0, 'looming should drive giant fiber'); }
{ const sim = load(); const keys = Object.keys(G.PN_glomeruli); const odor = keys.slice(0, 6).flatMap(k => G.PN_glomeruli[k]);
  sim.stimulate(odor, 150, 1500); sim.run(1500);
  const kcA = G.KC.filter(i => sim.spikeCounts[i] > 0).length;
  const mbon = count(sim, G.MBON), apl = count(sim, G.APL_DPM);
  const elig = G.KC.filter(i => sim.elig[i] > 0.2);
  const kcs = new Set(elig);
  const before = [sim.memoryDrive(kcs, 0), sim.memoryDrive(kcs, 1)];
  const ch = sim.dopamine(1);
  const after = [sim.memoryDrive(kcs, 0), sim.memoryDrive(kcs, 1)];
  console.log(`odor(6 glom, ${odor.length} PNs): KC active=${kcA} MBON spikes=${mbon} APL/DPM=${apl} eligible KC=${elig.length}; PAM changed ${ch} edges; drive approach ${before[0].toFixed(3)}->${after[0].toFixed(3)} avoid ${before[1].toFixed(3)}->${after[1].toFixed(3)}`);
  assert.ok(kcA > 20 && kcA < 600); assert.ok(mbon > 0, 'MBONs should respond to odor'); assert.ok(ch > 0); assert.ok(after[1] < before[1] && after[0] === before[0]);
  // second odor should be a different KC set
  const sim2 = load(); const odor2 = keys.slice(20, 26).flatMap(k => G.PN_glomeruli[k]); sim2.stimulate(odor2, 150, 1500); sim2.run(1500);
  const setA = new Set(G.KC.filter(i => sim.spikeCounts[i] > 0)), setB = G.KC.filter(i => sim2.spikeCounts[i] > 0);
  const overlap = setB.filter(i => setA.has(i)).length;
  console.log(`odor2 KC active=${setB.length}, overlap with odor1=${overlap}`);
  assert.ok(overlap < Math.min(setA.size, setB.length) * 0.5); }
{ // runaway check: tonic random drive for 5s shouldn't explode
  const sim = load(); const n = meta.n; const idx = []; for (let k = 0; k < n / 200; k++) idx.push((Math.random() * n) | 0);
  sim.stimulate(idx, 12, 5000); const sp = sim.run(5000);
  console.log(`tonic: ${sp} spikes in 5s = ${(sp / 5 / n).toFixed(3)} Hz/neuron`);
  assert.ok(sp / 5 / n < 5, 'network should not run away'); }
{ // recovery: strong looming / sugar drive must not leave the network stuck (QA found a permanent LC4/GF runaway)
  for (const [name, grp, rate, ms, read] of [['loom', G.LC4, 150, 150, G.GF], ['sugar', G.GRN_sugar, 150, 900, G.MN_proboscis]]) {
    const sim = load(); sim.stimulate(grp, rate, ms); sim.run(ms + 5000);
    const hot = [...Array(meta.n).keys()].filter(i => sim.rate[i] > 100).length;
    console.log(`${name} +5s: readout ${sim.meanRate(read).toFixed(1)} Hz, neurons >100 Hz: ${hot}`);
    assert.ok(sim.meanRate(read) < 5, `${name}: readout should be quiet 5 s later`); assert.ok(hot < 5, `${name}: no saturated neurons`); }
}
console.log('circuits ok');
