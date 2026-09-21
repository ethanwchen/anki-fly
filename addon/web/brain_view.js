// Canvas renderer for the brain: static soma layer + decaying spike flashes.
// Neurons are colored by neurotransmitter (FlyWire/MaleCNS predictions):
//   ACh cyan, GABA pink, Glu amber, DA/5-HT/OA green, unknown grey.
export const NT_COLORS = {
  ACH: [80, 220, 255], GABA: [255, 110, 190], GLUT: [255, 190, 70],
  DA: [120, 255, 140], SER: [120, 255, 140], OCT: [120, 255, 140], UNK: [160, 160, 170],
};

export class BrainView {
  constructor(canvas, meta) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.meta = meta;
    this.n = meta.n;
    this.glow = new Float32Array(this.n); // per-neuron flash intensity, decays each frame
    this.highlight = null;                // {indices, color, until}
    this.pulses = [];                     // {x,y,r,color,age}
    this.dpr = window.devicePixelRatio || 1;
    this._layoutPositions();
    this._buildStatic();
  }

  _layoutPositions() {
    // Project soma xyz (nm) to canvas: use x (left-right) and z (dorsal-ventral) -> frontal view.
    const { xyz } = this.meta;
    const n = this.n;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xyz[3 * i], y = xyz[3 * i + 1];
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (y < miny) miny = y; if (y > maxy) maxy = y;
    }
    this.bounds = { minx, maxx, miny, maxy };
    this.px = new Float32Array(n); this.py = new Float32Array(n);
    this.resize();
  }

  resize() {
    const cssW = this.canvas.clientWidth || 200, cssH = this.canvas.clientHeight || 160;
    this.canvas.width = Math.round(cssW * this.dpr); this.canvas.height = Math.round(cssH * this.dpr);
    this.w = this.canvas.width; this.h = this.canvas.height;
    const { minx, maxx, miny, maxy } = this.bounds;
    const pad = 6 * this.dpr;
    const sx = (this.w - 2 * pad) / (maxx - minx || 1), sy = (this.h - 2 * pad) / (maxy - miny || 1);
    const s = Math.min(sx, sy);
    const ox = (this.w - s * (maxx - minx)) / 2, oy = (this.h - s * (maxy - miny)) / 2;
    const { xyz } = this.meta;
    for (let i = 0; i < this.n; i++) {
      this.px[i] = ox + (xyz[3 * i] - minx) * s;
      this.py[i] = oy + (xyz[3 * i + 1] - miny) * s;
    }
    this._buildStatic();
  }

  _buildStatic() {
    if (!this.w) return;
    const off = document.createElement('canvas');
    off.width = this.w; off.height = this.h;
    const c = off.getContext('2d');
    const nt = this.meta.nt;
    const r = Math.max(0.6, 0.9 * this.dpr);
    for (let i = 0; i < this.n; i++) {
      const col = NT_COLORS[nt[i]] || NT_COLORS.UNK;
      c.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.28)`;
      c.fillRect(this.px[i] - r / 2, this.py[i] - r / 2, r, r);
    }
    this.staticLayer = off;
  }

  // Register spikes from the sim for this frame.
  addSpikes(indices) {
    for (let k = 0; k < indices.length; k++) this.glow[indices[k]] = 1;
  }

  // A transient ring around a group (e.g. dopamine burst).
  pulse(indices, color) {
    if (!indices.length) return;
    let cx = 0, cy = 0;
    for (const i of indices) { cx += this.px[i]; cy += this.py[i]; }
    this.pulses.push({ x: cx / indices.length, y: cy / indices.length, color, age: 0 });
  }

  draw(dtMs) {
    const ctx = this.ctx, n = this.n, nt = this.meta.nt, glow = this.glow;
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.drawImage(this.staticLayer, 0, 0);
    const decay = Math.exp(-dtMs / 140);
    const r = 2.2 * this.dpr;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < n; i++) {
      const g = glow[i];
      if (g < 0.03) { glow[i] = 0; continue; }
      const col = NT_COLORS[nt[i]] || NT_COLORS.UNK;
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},${g.toFixed(3)})`;
      const rr = r * (0.6 + g);
      ctx.fillRect(this.px[i] - rr / 2, this.py[i] - rr / 2, rr, rr);
      glow[i] = g * decay;
    }
    // pulses
    for (let k = this.pulses.length - 1; k >= 0; k--) {
      const p = this.pulses[k];
      p.age += dtMs;
      const a = 1 - p.age / 600;
      if (a <= 0) { this.pulses.splice(k, 1); continue; }
      ctx.strokeStyle = `rgba(${p.color[0]},${p.color[1]},${p.color[2]},${(a * 0.9).toFixed(3)})`;
      ctx.lineWidth = 1.5 * this.dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (4 + p.age / 12) * this.dpr, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}
