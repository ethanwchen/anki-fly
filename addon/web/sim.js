// Leaky integrate-and-fire simulation over a connectome subgraph.
// Parameters follow Shiu et al. 2024 (Nature), "A leaky integrate-and-fire computational
// model based on the connectome of the entire adult Drosophila brain".
//
// Graph is CSR over OUTGOING edges: rowptr[n+1], col[nnz], w[nnz] (mV per spike, signed).
// Time step is fixed (dt ms). Synaptic delay is rounded to whole steps.

export const DEFAULT_PARAMS = {
  dt: 1.0,          // ms
  tau: 20.0,        // membrane time constant, ms
  vRest: -52.0,     // mV
  vThresh: -45.0,   // mV
  vReset: -52.0,    // mV
  refrac: 2.2,      // ms
  delay: 1.8,       // ms axonal delay
  wUnit: 0.275,     // mV per synapse per spike (already baked into w by the extractor)
  tauElig: 3000.0,  // ms; KC eligibility trace for dopamine-gated plasticity
  eta: 0.15,        // fraction of KC->MBON weight removed per dopamine-gated event
  wMin: 0.05,       // floor as fraction of original weight
};

export class Sim {
  constructor(graph, params = {}) {
    this.p = { ...DEFAULT_PARAMS, ...params };
    this.n = graph.n;
    this.rowptr = graph.rowptr;
    this.col = graph.col;
    this.w = graph.w;           // live weights (plastic edges mutate this)
    this.w0 = graph.w0 || Float32Array.from(graph.w);
    this.v = new Float32Array(this.n).fill(this.p.vRest);
    this.iIn = new Float32Array(this.n);       // input arriving this step
    this.refracUntil = new Float32Array(this.n);
    this.lastSpike = new Float32Array(this.n).fill(-1e9);
    this.t = 0;
    this.step = 0;
    this.delaySteps = Math.max(1, Math.round(this.p.delay / this.p.dt));
    // ring buffer of spike lists, one per delay step
    this.ring = Array.from({ length: this.delaySteps }, () => []);
    this.spiked = new Uint8Array(this.n);
    this.spikesThisStep = [];
    this.spikeCounts = new Uint32Array(this.n); // cumulative, for rate readouts
    this.rate = new Float32Array(this.n);       // exponentially smoothed Hz
    this.rateTau = 200;                          // ms
    // External drive: per-neuron Poisson rate (Hz) applied until an expiry time.
    this.extRate = new Float32Array(this.n);
    this.extUntil = new Float32Array(this.n);
    this.extAmp = 4.0; // mV per external event, enough to reliably fire from rest in a few events
    // Plasticity
    this.elig = new Float32Array(this.n);
    this.plastic = null; // { edgeIdx: Int32Array, pre: Int32Array, post: Int32Array, cls: Uint8Array }
    this._rng = mulberry32(12345);
  }

  seed(s) { this._rng = mulberry32(s); }

  // Set Poisson drive on a set of neurons for `durMs`.
  stimulate(indices, rateHz, durMs) {
    const until = this.t + durMs;
    for (const i of indices) {
      this.extRate[i] = rateHz;
      this.extUntil[i] = until;
    }
  }

  clearStim(indices) {
    for (const i of indices) { this.extRate[i] = 0; this.extUntil[i] = 0; }
  }

  // Define which edges are plastic. cls: 0 = KC->approach-MBON (depressed by PPL1),
  // 1 = KC->avoid-MBON (depressed by PAM).
  setPlasticEdges(edgeIdx, pre, post, cls) {
    this.plastic = { edgeIdx, pre, post, cls };
  }

  // Dopamine event: depress plastic edges of class `cls` from eligible KCs.
  // Returns number of edges modified.
  dopamine(cls, strength = 1.0) {
    if (!this.plastic) return 0;
    const { edgeIdx, pre, cls: ecls } = this.plastic;
    const { eta, wMin } = this.p;
    let changed = 0;
    for (let k = 0; k < edgeIdx.length; k++) {
      if (ecls[k] !== cls) continue;
      const e = edgeIdx[k];
      const el = this.elig[pre[k]];
      if (el < 0.05) continue;
      const floor = this.w0[e] * wMin;
      const nw = this.w[e] * (1 - eta * strength * Math.min(1, el));
      this.w[e] = Math.max(floor, nw);
      changed++;
    }
    return changed;
  }

  // Slow recovery of plastic weights toward baseline (forgetting). rate per ms.
  recover(ms, ratePerMs = 1e-6) {
    if (!this.plastic) return;
    const f = ratePerMs * ms;
    const { edgeIdx } = this.plastic;
    for (let k = 0; k < edgeIdx.length; k++) {
      const e = edgeIdx[k];
      this.w[e] += (this.w0[e] - this.w[e]) * f;
    }
  }

  // Advance one dt. Returns array of neuron indices that spiked.
  tick() {
    const { dt, tau, vRest, vThresh, vReset, refrac, tauElig } = this.p;
    const n = this.n, v = this.v, iIn = this.iIn;
    const rowptr = this.rowptr, col = this.col, w = this.w;
    const t = this.t;

    // 1. deliver delayed spikes
    const arriving = this.ring[this.step % this.delaySteps];
    for (let a = 0; a < arriving.length; a++) {
      const pre = arriving[a];
      const s = rowptr[pre], e = rowptr[pre + 1];
      for (let k = s; k < e; k++) iIn[col[k]] += w[k];
    }
    arriving.length = 0;

    // 2. external Poisson drive
    const rng = this._rng;
    const extRate = this.extRate, extUntil = this.extUntil, amp = this.extAmp;
    for (let i = 0; i < n; i++) {
      const r = extRate[i];
      if (r > 0) {
        if (t >= extUntil[i]) { extRate[i] = 0; continue; }
        if (rng() < r * dt * 1e-3) iIn[i] += amp;
      }
    }

    // 3. integrate + threshold
    const decay = dt / tau;
    const spikes = this.spikesThisStep; spikes.length = 0;
    const refracUntil = this.refracUntil, spiked = this.spiked;
    const eligDecay = Math.exp(-dt / tauElig);
    const rDecay = Math.exp(-dt / this.rateTau);
    const rate = this.rate, elig = this.elig;
    for (let i = 0; i < n; i++) {
      spiked[i] = 0;
      elig[i] *= eligDecay;
      rate[i] *= rDecay;
      if (t < refracUntil[i]) { v[i] = vReset; iIn[i] = 0; continue; }
      let vi = v[i] + (vRest - v[i]) * decay + iIn[i];
      iIn[i] = 0;
      if (vi >= vThresh) {
        vi = vReset;
        refracUntil[i] = t + refrac;
        spiked[i] = 1;
        spikes.push(i);
        this.spikeCounts[i]++;
        this.lastSpike[i] = t;
        elig[i] = Math.min(1, elig[i] + 0.34);
        rate[i] += (1000 / this.rateTau); // impulse so that steady rate ≈ Hz
      } else if (vi < -80) vi = -80;
      v[i] = vi;
    }
    // 4. schedule for delivery after delay
    // The slot read this step is the one read again `delaySteps` steps from now;
    // it was emptied above, so pushing into it delivers after exactly one delay.
    for (let k = 0; k < spikes.length; k++) arriving.push(spikes[k]);

    this.t += dt;
    this.step++;
    return spikes;
  }

  run(ms) {
    const steps = Math.round(ms / this.p.dt);
    let total = 0;
    for (let s = 0; s < steps; s++) total += this.tick().length;
    return total;
  }

  // Mean firing rate (Hz, smoothed) over a set of neurons.
  meanRate(indices) {
    if (!indices.length) return 0;
    let s = 0;
    for (const i of indices) s += this.rate[i];
    return s / indices.length;
  }

  // Sum of live plastic weights of class cls from the given KC set, relative to baseline.
  memoryDrive(kcSet, cls) {
    if (!this.plastic) return 1;
    const { edgeIdx, pre, cls: ecls } = this.plastic;
    let live = 0, base = 0;
    for (let k = 0; k < edgeIdx.length; k++) {
      if (ecls[k] !== cls || !kcSet.has(pre[k])) continue;
      const e = edgeIdx[k];
      live += this.w[e]; base += this.w0[e];
    }
    return base > 0 ? live / base : 1;
  }
}

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Build CSR from edge list (pre, post, weight). Returns {n, rowptr, col, w, w0}.
export function buildCSR(n, pre, post, weight) {
  const deg = new Int32Array(n + 1);
  for (let k = 0; k < pre.length; k++) deg[pre[k] + 1]++;
  for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
  const rowptr = deg;
  const fill = Int32Array.from(rowptr.subarray(0, n));
  const col = new Int32Array(pre.length);
  const w = new Float32Array(pre.length);
  for (let k = 0; k < pre.length; k++) {
    const idx = fill[pre[k]]++;
    col[idx] = post[k]; w[idx] = weight[k];
  }
  return { n, rowptr, col, w, w0: Float32Array.from(w) };
}

// Parse the packed binary produced by tools/extract_subgraph.py.
// Layout (little-endian): magic "FLYG", uint32 n, uint32 nnz, int32 rowptr[n+1], int32 col[nnz], float32 w[nnz]
export function parseGraph(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FLYG') throw new Error('bad graph magic');
  const n = dv.getUint32(4, true), nnz = dv.getUint32(8, true);
  let off = 12;
  const rowptr = new Int32Array(buf.slice(off, off + 4 * (n + 1))); off += 4 * (n + 1);
  const col = new Int32Array(buf.slice(off, off + 4 * nnz)); off += 4 * nnz;
  const w = new Float32Array(buf.slice(off, off + 4 * nnz));
  return { n, rowptr, col, w, w0: Float32Array.from(w) };
}
