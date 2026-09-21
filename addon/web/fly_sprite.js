// Procedural 2D fruit fly sprite with behavior states read out from the brain.
// States: idle, walk, groom, proboscis, sleep, startle, fly
export class FlySprite {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = window.devicePixelRatio || 1;
    this.state = 'idle';
    this.stateT = 0;
    this.x = 0.52; this.y = 0.6; this.dir = 1;
    this.t = 0;
    this.blink = 0;
    this.resize();
  }
  resize() {
    const w = this.canvas.clientWidth || 110, h = this.canvas.clientHeight || 160;
    this.canvas.width = Math.round(w * this.dpr); this.canvas.height = Math.round(h * this.dpr);
  }
  setState(s) {
    if (s !== this.state) { this.state = s; this.stateT = 0; }
  }
  update(dt) {
    this.t += dt; this.stateT += dt;
    const s = this.state;
    if (s === 'walk') {
      this.x += this.dir * dt * 0.00012;
      if (this.x > 0.8) { this.dir = -1; } else if (this.x < 0.2) { this.dir = 1; }
    } else if (s === 'fly') {
      this.x = 0.5 + Math.sin(this.t / 260) * 0.25;
      this.y = 0.45 + Math.cos(this.t / 190) * 0.12;
    } else if (s === 'startle') {
      this.y = 0.62 - Math.min(1, this.stateT / 120) * 0.25 * (1 - Math.min(1, Math.max(0, (this.stateT - 250) / 350)));
    } else {
      this.y += (0.62 - this.y) * Math.min(1, dt / 200);
    }
    if (Math.random() < dt / 4000) this.blink = 120;
    this.blink = Math.max(0, this.blink - dt);
  }
  draw() {
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height, d = this.dpr;
    ctx.clearRect(0, 0, W, H);
    const cx = this.x * W, cy = this.y * H;
    const S = Math.min(W / 78, H / 120); // scale unit (W/H are device px already)
    const s = this.state, t = this.t;
    const bob = (s === 'sleep') ? Math.sin(t / 900) * 1.2 : (s === 'idle' ? Math.sin(t / 500) * 0.8 : 0);
    ctx.save();
    ctx.translate(cx, cy + bob * S);
    ctx.scale(this.dir, 1);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(0, 22 * S - (0.62 - this.y) * H * 0.0, 16 * S, 4 * S, 0, 0, Math.PI * 2); ctx.fill();

    // legs
    ctx.strokeStyle = '#3a2a1e'; ctx.lineWidth = 1.6 * S; ctx.lineCap = 'round';
    const legPhase = (s === 'walk') ? t / 70 : 0;
    for (let i = 0; i < 3; i++) {
      const lx = -8 * S + i * 8 * S;
      const swing = (s === 'walk') ? Math.sin(legPhase + i * 2.1) * 4 * S : 0;
      const tuck = (s === 'fly' || s === 'startle') ? -6 * S : 0;
      ctx.beginPath(); ctx.moveTo(lx, 8 * S); ctx.lineTo(lx + swing - 3 * S, 16 * S + tuck); ctx.lineTo(lx + swing - 4 * S, 21 * S + tuck); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lx, 8 * S); ctx.lineTo(lx - swing + 3 * S, 16 * S + tuck); ctx.lineTo(lx - swing + 4 * S, 21 * S + tuck); ctx.stroke();
    }
    // grooming: front legs rub head
    if (s === 'groom') {
      const g = Math.sin(t / 90) * 3 * S;
      ctx.beginPath(); ctx.moveTo(10 * S, 4 * S); ctx.lineTo(20 * S + g, -2 * S); ctx.lineTo(24 * S - g, -8 * S); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(10 * S, 4 * S); ctx.lineTo(20 * S - g, 0); ctx.lineTo(25 * S + g, -6 * S); ctx.stroke();
    }

    // wings
    const flap = (s === 'fly' || s === 'startle') ? Math.sin(t / 18) * 0.9 : 0.15;
    ctx.fillStyle = 'rgba(210,230,255,0.55)'; ctx.strokeStyle = 'rgba(160,190,230,0.9)'; ctx.lineWidth = 0.8 * S;
    for (const side of [-1, 1]) {
      ctx.save(); ctx.translate(-4 * S, -4 * S); ctx.rotate(-0.35 * side * flap - 0.15 * side - (flap === 0.15 ? 0.05 : 0));
      ctx.beginPath(); ctx.ellipse(-12 * S, -2 * S * side, 15 * S, 5.5 * S, 0.1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // abdomen (striped)
    ctx.fillStyle = '#c9963c';
    ctx.beginPath(); ctx.ellipse(-11 * S, 3 * S, 13 * S, 9 * S, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#5a3d1a'; ctx.lineWidth = 2 * S;
    for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(-11 * S - i * 4 * S, 3 * S, 8.5 * S - i * 0.5 * S, -1.1, 1.1); ctx.stroke(); }
    // thorax
    ctx.fillStyle = '#d4a854';
    ctx.beginPath(); ctx.ellipse(2 * S, 0, 9 * S, 8 * S, 0, 0, Math.PI * 2); ctx.fill();
    // head
    ctx.fillStyle = '#d9b262';
    ctx.beginPath(); ctx.ellipse(14 * S, -3 * S, 8 * S, 7.5 * S, 0, 0, Math.PI * 2); ctx.fill();
    // eye
    ctx.fillStyle = '#c0392b';
    ctx.beginPath(); ctx.ellipse(17 * S, -4 * S, 5 * S, 5.6 * S, 0, 0, Math.PI * 2); ctx.fill();
    if (s === 'sleep' || this.blink > 0) {
      ctx.fillStyle = '#d9b262'; ctx.beginPath(); ctx.ellipse(17 * S, -6 * S, 5.4 * S, 4 * S, 0, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(18.5 * S, -6 * S, 1.6 * S, 0, Math.PI * 2); ctx.fill();
      // facets
      ctx.fillStyle = 'rgba(120,20,20,0.5)';
      for (let i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(15.5 * S + (i % 2) * 2.5 * S, -2.5 * S + i * 1.2 * S, 0.7 * S, 0, Math.PI * 2); ctx.fill(); }
    }
    // antennae
    ctx.strokeStyle = '#5a3d1a'; ctx.lineWidth = 1.2 * S;
    ctx.beginPath(); ctx.moveTo(18 * S, -9 * S); ctx.quadraticCurveTo(21 * S, -13 * S, 19 * S, -15 * S); ctx.stroke();
    // proboscis
    const pro = (s === 'proboscis') ? 6 * S * Math.min(1, this.stateT / 250) : 0;
    ctx.strokeStyle = '#4a3320'; ctx.lineWidth = 2.2 * S;
    ctx.beginPath(); ctx.moveTo(17 * S, 3 * S); ctx.lineTo(19 * S, 6 * S + pro); ctx.stroke();
    if (pro > 0) { ctx.fillStyle = '#6b4a2b'; ctx.beginPath(); ctx.ellipse(19 * S, 6.5 * S + pro, 2.6 * S, 1.6 * S, 0, 0, Math.PI * 2); ctx.fill(); }

    ctx.restore();

    // sleep zzz
    if (s === 'sleep') {
      ctx.fillStyle = 'rgba(200,210,255,0.85)';
      ctx.font = `${10 * S}px ui-sans-serif, system-ui`;
      const k = (t / 700) % 3;
      for (let i = 0; i < 3; i++) {
        const a = Math.max(0, 1 - Math.abs(((t / 700 + i) % 3) - 1.5) / 1.5);
        ctx.globalAlpha = a;
        ctx.fillText('z', cx + this.dir * (22 + i * 6) * S, cy - (20 + i * 8 + ((t / 700 + i) % 3) * 4) * S);
      }
      ctx.globalAlpha = 1;
      void k;
    }
    // happy sparkles during proboscis
    if (s === 'proboscis' && this.stateT < 1200) {
      ctx.fillStyle = 'rgba(255,230,120,0.9)';
      for (let i = 0; i < 5; i++) {
        const ang = i * 1.256 + t / 400, rr = (18 + (this.stateT / 1200) * 14) * S;
        ctx.beginPath(); ctx.arc(cx + Math.cos(ang) * rr, cy - 6 * S + Math.sin(ang) * rr * 0.6, 1.5 * S, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}
