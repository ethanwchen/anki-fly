import { Sim, buildCSR, parseGraph } from '../addon/web/sim.js';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('ok -', name); }

test('single neuron fires under Poisson drive', () => {
  const g = buildCSR(1, [], [], []);
  const sim = new Sim(g);
  sim.stimulate([0], 200, 1000);
  const spikes = sim.run(1000);
  assert.ok(spikes > 5, `expected spikes, got ${spikes}`);
  assert.ok(sim.rate[0] > 1);
});

test('excitatory chain propagates with delay', () => {
  // 0 -> 1 -> 2 with strong weights (g-jump of 100 mV ~ 16 mV peak PSP)
  const g = buildCSR(3, [0, 1], [1, 2], [100, 100]);
  const sim = new Sim(g);
  sim.v[0] = -44;
  const s0 = sim.tick(); assert.deepEqual(s0, [0]);
  const s1 = sim.tick(); assert.deepEqual(s1, []);      // delay is 2 steps
  const s2 = sim.tick(); assert.deepEqual(s2, []);      // delivered into g; v needs a step to rise
  let first1 = -1, first2 = -1;
  for (let t = 3; t < 40; t++) { const sp = sim.tick(); if (sp.includes(1) && first1 < 0) first1 = t; if (sp.includes(2) && first2 < 0) first2 = t; }
  assert.ok(first1 > 2 && first1 < 10, `neuron 1 fired at ${first1}`);
  assert.ok(first2 > first1 + 2, `neuron 2 fired at ${first2}`);
  assert.equal(sim.spikeCounts[0], 1);
});

test('inhibition prevents firing', () => {
  const g = buildCSR(2, [0], [1], [-60]);
  const sim = new Sim(g);
  sim.stimulate([0, 1], 300, 500);
  sim.run(500);
  assert.ok(sim.spikeCounts[0] > 0);
  assert.ok(sim.spikeCounts[1] < sim.spikeCounts[0] / 2, `inhibited neuron fired ${sim.spikeCounts[1]} vs ${sim.spikeCounts[0]}`);
});

test('dopamine depresses eligible plastic edges only', () => {
  // KC0 -> MBON_avoid(2), KC1 -> MBON_avoid(3); only KC0 active
  const g = buildCSR(4, [0, 1], [2, 3], [5, 5]);
  const sim = new Sim(g);
  sim.setPlasticEdges(Int32Array.from([0, 1]), Int32Array.from([0, 1]), Int32Array.from([2, 3]), Uint8Array.from([1, 1]));
  sim.stimulate([0], 100, 300);
  sim.run(300);
  assert.ok(sim.elig[0] > 0.3);
  const changed = sim.dopamine(1);
  assert.equal(changed, 1);
  assert.ok(sim.w[0] < 5 && sim.w[1] === 5);
  // memory drive for KC0's set decreased
  assert.ok(sim.memoryDrive(new Set([0]), 1) < 1);
  assert.equal(sim.memoryDrive(new Set([1]), 1), 1);
  // repeated dopamine floors at wMin
  for (let i = 0; i < 100; i++) { sim.elig[0] = 1; sim.dopamine(1); }
  assert.ok(Math.abs(sim.w[0] - 5 * sim.p.wMin) < 1e-4);
  // recovery moves back toward baseline
  sim.recover(1e6, 1e-6);
  assert.ok(sim.w[0] > 5 * sim.p.wMin + 0.5);
});

test('parseGraph round-trips with extractor layout', () => {
  const n = 3, pre = [0, 0, 1], post = [1, 2, 2], w = [1.5, -2, 0.25];
  const csr = buildCSR(n, pre, post, w);
  const nnz = csr.col.length;
  const buf = new ArrayBuffer(12 + 4 * (n + 1) + 8 * nnz);
  const dv = new DataView(buf);
  [...'FLYG'].forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
  dv.setUint32(4, n, true); dv.setUint32(8, nnz, true);
  new Int32Array(buf, 12, n + 1).set(csr.rowptr);
  new Int32Array(buf, 12 + 4 * (n + 1), nnz).set(csr.col);
  new Float32Array(buf, 12 + 4 * (n + 1) + 4 * nnz, nnz).set(csr.w);
  const g = parseGraph(buf);
  assert.deepEqual([...g.rowptr], [...csr.rowptr]);
  assert.deepEqual([...g.col], [...csr.col]);
  assert.deepEqual([...g.w], [...csr.w]);
});

const real = new URL('../addon/web/data/graph.bin', import.meta.url);
if (existsSync(real)) {
  test('real subgraph: odor drives sparse KC response, stable baseline', () => {
    const meta = JSON.parse(readFileSync(new URL('../addon/web/data/meta.json', import.meta.url)));
    const g = parseGraph(readFileSync(real).buffer.slice(0));
    const sim = new Sim(g);
    assert.equal(g.n, meta.n);
    // baseline: nothing should fire without input
    const t0 = performance.now();
    const base = sim.run(500);
    const ms = performance.now() - t0;
    console.log(`   n=${g.n} nnz=${g.col.length} baseline spikes=${base} 500ms sim in ${ms.toFixed(0)}ms wall`);
    assert.equal(base, 0);
    const odor = Object.keys(meta.groups.PN_glomeruli).slice(0, 6).flatMap(k => meta.groups.PN_glomeruli[k]);
    sim.stimulate(odor, 150, 500);
    sim.run(500);
    const kc = meta.groups.KC;
    const active = kc.filter(i => sim.spikeCounts[i] > 0).length;
    console.log(`   PNs=${odor.length} KC active=${active}/${kc.length}`);
    assert.ok(active > 0 && active < kc.length * 0.5, 'KC response should be sparse but nonzero');
  });
}

console.log(`\n${passed} tests passed`);
