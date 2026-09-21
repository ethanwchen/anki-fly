// Anki Fly: glue between Anki events, the LIF sim, the brain view and the fly sprite.
import { Sim, parseGraph } from './sim.js';
import { BrainView } from './brain_view.js';
import { FlySprite } from './fly_sprite.js';

const $ = (id) => document.getElementById(id);
// Anki injects window.pycmd at DocumentReady, after module scripts run, so check lazily.
const hasPy = () => typeof window.pycmd === 'function';
const py = (msg) => { if (hasPy()) window.pycmd(msg); else console.log('[pycmd]', msg.slice(0, 120)); };

const GREEN = [120, 255, 140], RED = [255, 90, 90], YELLOW = [255, 220, 90];

const FACTS = [
  'My whole nervous system has ~166,700 neurons. You gave me 9,000 of them.',
  'Each card smells different to me: its note id picks 6 of my 61 glomeruli.',
  'Only ~5% of my Kenyon cells fire for any one smell. Sparse codes don\'t collide.',
  'Dopamine doesn\'t excite my neurons here — it rewires Kenyon cell → MBON synapses.',
  'PAM neurons = reward. PPL1 neurons = punishment. You are my dopamine.',
  'My APL neuron is GABAergic and quiets my Kenyon cells so memories stay sparse.',
  'DNp01 is my giant fiber. One spike and I take off in ~5 ms.',
  'Sugar on my labellum → MN9 → proboscis out. Same wiring as the real fly.',
  'This wiring is MaleCNS v1.0 (Janelia + Google, 2026), CC BY 4.0.',
  'My neurons are leaky integrate-and-fire units: τ = 20 ms, threshold −45 mV.',
  'Glutamatergic MBONs steer me away; GABA/ACh MBONs steer me toward.',
  'Every synapse adds 0.275 mV × synapse count — the Shiu et al. 2024 model.',
  'When you press Again, my avoidance is left alone and my approach is weakened.',
  'I forget slowly: depressed synapses recover toward baseline over hours.',
  'Real flies remember a punished odor for about a day. I remember until you delete memory.json.',
];

class AnkiFly {
  constructor() {
    this.cfg = { speed: 1.0, showMemory: true, idleSeconds: 60, sleepSeconds: 240 };
    this.lastEvent = performance.now();
    this.streak = 0;
    this.currentNid = null;
    this.currentOdor = null;
    this.state = 'idle';
    this.forcedState = null; // {state, until}
    this.stats = { spikes: 0, reviews: 0 };
    this.memory = {};   // nid -> {approach, avoid, seen}
    this.dirty = false;
    this.session = { cards: 0, again: 0, synapses: 0, start: performance.now() };
    this.factIdx = Math.floor(Math.random() * FACTS.length);
    this.lastFact = performance.now();
  }

  async init() {
    const base = new URL('.', import.meta.url);
    const [meta, gbuf] = await Promise.all([
      fetch(new URL('data/meta.json', base)).then(r => r.json()),
      fetch(new URL('data/graph.bin', base)).then(r => r.arrayBuffer()),
    ]);
    this.meta = meta;
    this.g = meta.groups;
    this.sim = new Sim(parseGraph(gbuf));
    if (meta.plastic) {
      const P = meta.plastic;
      this.sim.setPlasticEdges(Int32Array.from(P.edge), Int32Array.from(P.pre), Int32Array.from(P.post), Uint8Array.from(P.cls));
    }
    this.kcSet = new Set(this.g.KC);
    meta.denseGroups = this.kcSet;
    this.brain = new BrainView($('brain'), meta);
    this.sprite = new FlySprite($('fly'));
    $('count').textContent = `${meta.n.toLocaleString()} neurons · ${meta.nnz.toLocaleString()} synapses`;
    window.addEventListener('resize', () => { this.brain.resize(); this.sprite.resize(); });
    this.wireControls();
    this.lastFrame = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    // background tonic drive so the brain is never fully silent (spontaneous activity)
    this.tonic();
    setInterval(() => this.tonic(), 2000);
    setInterval(() => this.save(), 15000);
    // Python may inject pycmd slightly after we load; retry until the bridge is up.
    for (const ev of (this.pending || [])) this.event(ev);
    this.pending = null;
    const announce = () => { if (hasPy()) py('fly:ready'); else setTimeout(announce, 100); };
    announce();
  }

  wireControls() {
    $('btn-min').onclick = (e) => { e.stopPropagation(); py('fly:minimize'); };
    $('btn-close').onclick = (e) => { e.stopPropagation(); py('fly:close'); };
    $('btn-exam').onclick = (e) => { e.stopPropagation(); py('fly:exam'); };
    $('panel').onclick = () => { if (document.body.classList.contains('mini')) py('fly:restore'); };
    // hover over the brain: name the nearest neuron
    const brain = $('brain');
    brain.addEventListener('mousemove', (e) => {
      const r = brain.getBoundingClientRect(), d = this.brain.dpr;
      const x = (e.clientX - r.left) * d, y = (e.clientY - r.top) * d;
      let best = -1, bd = 36 * d * d;
      const px = this.brain.px, py_ = this.brain.py;
      for (let i = 0; i < this.meta.n; i++) { const dx = px[i] - x, dy = py_[i] - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
      if (best >= 0) this.setStatus(`${this.meta.type[best] || 'unnamed'} · ${this.meta.nt[best]} · ${this.groupOf(best)}`, true);
    });
    brain.addEventListener('mouseleave', () => { this.hoverStatus = null; if (this.statusText) $('status').textContent = this.statusText; });
  }

  groupOf(i) {
    if (this.groupIndex === undefined) {
      this.groupIndex = new Map();
      for (const [k, v] of Object.entries(this.g)) {
        if (k === 'PN_glomeruli') for (const [gl, idx] of Object.entries(v)) idx.forEach(j => this.groupIndex.set(j, 'PN ' + gl));
        else v.forEach(j => this.groupIndex.set(j, k));
      }
    }
    return this.groupIndex.get(i) || 'brain';
  }

  say(text, ms = 3200) {
    if (!this.cfg.bubbles) return;
    const b = $('bubble');
    b.textContent = text; b.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  tonic() {
    // Low spontaneous activity across a random sample of neurons.
    const n = this.meta.n, idx = [];
    for (let k = 0; k < Math.max(20, n / 200); k++) idx.push((Math.random() * n) | 0);
    const asleep = this.state === 'sleep';
    this.sim.stimulate(idx, asleep ? 4 : 12, 2100);
  }

  // ---------- events from Anki ----------
  event(ev) {
    if (!this.sim) { (this.pending = this.pending || []).push(ev); return; }   // brain still loading
    this.lastEvent = performance.now();
    const g = this.g, sim = this.sim;
    switch (ev.type) {
      case 'config':
        Object.assign(this.cfg, ev.cfg || {});
        $('memory').style.display = this.cfg.showMemory ? '' : 'none';
        document.body.classList.toggle('mini', !!this.cfg.minimized);
        this.brain.resize(); this.sprite.resize();
        break;
      case 'amnesia':
        this.memory = {}; this.streak = 0; this.stats = { spikes: 0, reviews: 0 };
        if (this.sim.plastic) { const P = this.sim.plastic; for (let k = 0; k < P.edgeIdx.length; k++) this.sim.w[P.edgeIdx[k]] = this.sim.w0[P.edgeIdx[k]]; }
        this.dirty = true; this.updateMemoryBar(); this.say('…who are you?');
        break;
      case 'question': {
        this.currentNid = String(ev.nid);
        this.currentOdor = this.odorFor(this.currentNid);
        this.clearOdor();
        this.odorIdx = this.currentOdor.flatMap(k => g.PN_glomeruli[k]);
        sim.stimulate(this.odorIdx, 150, 60000);
        this.wakeIfNeeded();
        this.updateMemoryBar();
        this.setStatus(`sniffing card · glomeruli ${this.currentOdor.join(' ')}`);
        const m = this.memory[this.currentNid];
        if (!m) this.say(`*sniff* new smell: ${this.currentOdor.slice(0, 3).join(', ')}…`);
        else if (this.pref(m) > 0.3) this.say(`oh, this one. ${ev.lapses > 2 ? 'we struggled, but' : ''} I like this one.`);
        else if (this.pref(m) < -0.3) this.say(`hm. this smell stings. seen ${m.seen}×.`);
        else this.say(`I've smelled this ${m.seen}× before…`);
        break;
      }
      case 'answer':
        // odor persists; nothing else.
        break;
      case 'rate': {
        const ease = ev.ease | 0;
        this.stats.reviews++;
        const kcActive = g.KC.filter(i => sim.elig[i] > 0.2);
        this.session.cards++;
        const secs = ev.ms ? (ev.ms / 1000).toFixed(0) + 's' : '';
        if (ease >= 3) {
          sim.stimulate(g.PAM, 60, 400);
          const changed = sim.dopamine(1, ease === 4 ? 1.3 : 1.0);
          this.session.synapses += changed;
          this.brain.pulse(g.PAM, GREEN);
          this.streak++;
          this.setStatus(`reward · PAM dopamine · ${changed} KC→MBON synapses depressed`);
          this.say(ease === 4 ? `easy! ${changed} synapses rewired. streak ${this.streak}` : `sweet. PAM fired, ${changed} synapses weaker. ${secs}`);
          if (this.streak > 0 && this.streak % 5 === 0) this.sugar();
        } else if (ease === 1) {
          sim.stimulate(g.PPL1, 60, 400);
          const changed = sim.dopamine(0, 1.0);
          this.session.synapses += changed; this.session.again++;
          this.brain.pulse(g.PPL1, RED);
          this.streak = 0;
          this.setStatus(`punishment · PPL1 dopamine · ${changed} synapses depressed`);
          this.say(`ouch. PPL1 fired. I'll approach this smell less. ${secs}`);
        } else {
          sim.stimulate(g.PPL1, 25, 250);
          const changed = sim.dopamine(0, 0.4);
          this.session.synapses += changed;
          this.brain.pulse(g.PPL1, YELLOW);
          this.setStatus('hard · weak PPL1 dopamine');
          this.say(`hard one. a little PPL1. ${secs}`);
        }
        if (this.currentNid) {
          const kcs = new Set(kcActive);
          const m = this.memory[this.currentNid] || { seen: 0 };
          m.seen++;
          m.approach = sim.memoryDrive(kcs, 0);
          m.avoid = sim.memoryDrive(kcs, 1);
          this.memory[this.currentNid] = m;
          this.dirty = true;
        }
        this.clearOdor();
        this.updateMemoryBar();
        break;
      }
      case 'wake': this.loom(); break;
      case 'sugar': this.sugar(); break;
      case 'session_end': {
        this.clearOdor();
        const s = this.session, mins = ((performance.now() - s.start) / 60000).toFixed(0);
        this.setStatus(`session over · ${s.cards} cards · ${s.synapses} synapses rewired`);
        if (s.cards) this.say(`we did ${s.cards} cards in ${mins} min. ${s.again} stung. ${s.synapses} synapses changed.`, 6000);
        this.session = { cards: 0, again: 0, synapses: 0, start: performance.now() };
        this.save();
        break;
      }
      case 'loadMemory':
        this.loadMemory(ev.data);
        break;
    }
  }

  odorFor(nid) {
    const keys = Object.keys(this.g.PN_glomeruli);
    // deterministic hash -> 3 distinct glomeruli
    let h = 2166136261;
    for (const ch of nid) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const out = [];
    while (out.length < Math.min(6, keys.length)) {
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const k = keys[h % keys.length];
      if (!out.includes(k)) out.push(k);
    }
    return out;
  }

  clearOdor() { if (this.odorIdx) this.sim.clearStim(this.odorIdx); this.odorIdx = null; }

  loom() {
    const g = this.g;
    if (g.LC4?.length) this.sim.stimulate(g.LC4, 150, 150);
    if (g.GF?.length) this.sim.stimulate(g.GF, 200, 60);
    this.force('startle', 700);
    this.setStatus('looming shadow · giant fiber escape');
  }

  sugar() {
    const g = this.g;
    if (g.GRN_sugar?.length) this.sim.stimulate(g.GRN_sugar, 150, 900);
    this.force('proboscis', 1600);
    this.setStatus('sugar! · proboscis extension');
  }

  force(state, ms) { this.forcedState = { state, until: performance.now() + ms }; }

  wakeIfNeeded() { if (this.state === 'sleep') this.loom(); }

  // ---------- behavior readout ----------
  chooseState(now) {
    if (this.forcedState) {
      if (now < this.forcedState.until) return this.forcedState.state;
      this.forcedState = null;
    }
    const sim = this.sim, g = this.g;
    const r = (k) => (g[k]?.length ? sim.meanRate(g[k]) : 0);
    const gf = r('GF'), mn9 = r('MN_proboscis'), groom = r('DNg11'), walk = r('DNp09') + r('MDN');
    if (gf > 20) return 'startle';
    if (mn9 > 15) return 'proboscis';
    const idleMs = now - this.lastEvent;
    if (idleMs > this.cfg.sleepSeconds * 1000) return 'sleep';
    if (groom > 8) return 'groom';
    if (walk > 8) return 'walk';
    if (idleMs > this.cfg.idleSeconds * 1000) {
      // scripted idle behaviors, gently stimulating the real circuits so the brain shows it
      const phase = Math.floor(idleMs / 9000) % 3;
      if (phase === 1) { if (g.DNg11?.length && Math.random() < 0.02) sim.stimulate(g.DNg11, 40, 800); return 'groom'; }
      if (phase === 2) { if (g.DNp09?.length && Math.random() < 0.02) sim.stimulate(g.DNp09, 40, 800); return 'walk'; }
      return 'idle';
    }
    return this.odorIdx ? 'idle' : (Math.sin(now / 7000) > 0.6 ? 'walk' : 'idle');
  }

  // ---------- frame loop ----------
  frame(now) {
    const wall = Math.min(60, now - this.lastFrame);
    this.lastFrame = now;
    const simMs = wall * this.cfg.speed * (this.state === 'sleep' ? 0.4 : 1);
    const steps = Math.max(1, Math.round(simMs / this.sim.p.dt));
    let spikes = 0;
    for (let s = 0; s < steps; s++) {
      const sp = this.sim.tick();
      if (sp.length) { this.brain.addSpikes(sp); spikes += sp.length; }
    }
    this.stats.spikes += spikes;
    this.sim.recover(simMs);
    const st = this.chooseState(now);
    if (st !== this.state) { this.state = st; document.body.dataset.state = st; }
    this.sprite.setState(st);
    this.sprite.update(wall);
    this.sprite.draw();
    this.brain.draw(wall);
    if (now - this.lastEvent > 20000 && now - this.lastFact > 45000 && st !== 'sleep' && !document.body.classList.contains('mini')) {
      this.lastFact = now;
      this.say(FACTS[this.factIdx++ % FACTS.length], 7000);
    }
    if ((this.frameNo = (this.frameNo | 0) + 1) % 15 === 0) {
      $('hz').textContent = `${st} · ${(spikes * 1000 / Math.max(1, simMs) / this.meta.n).toFixed(2)} Hz/neuron`;
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  setStatus(s, hover = false) {
    if (hover) { this.hoverStatus = s; $('status').textContent = s; return; }
    this.statusText = s;
    if (!this.hoverStatus) $('status').textContent = s;
  }

  // Preference in [-1, 1]: reward depresses avoid drive, punishment depresses approach drive.
  pref(m) { return Math.max(-1, Math.min(1, ((1 - m.avoid) - (1 - m.approach)) * 2.5)); }

  updateMemoryBar() {
    const bar = $('membar'), lab = $('memlabel');
    const m = this.currentNid && this.memory[this.currentNid];
    if (!m) { bar.style.width = '50%'; bar.className = 'neutral'; lab.textContent = 'new card'; return; }
    const pref = this.pref(m);
    bar.style.width = `${50 + pref * 50}%`;
    bar.className = pref > 0.05 ? 'good' : (pref < -0.05 ? 'bad' : 'neutral');
    lab.textContent = `fly memory · seen ${m.seen}× · ${pref > 0.3 ? 'likes it' : pref < -0.3 ? 'dreads it' : 'unsure'}`;
  }

  // ---------- persistence ----------
  save() {
    if (!this.dirty || !this.sim.plastic) return;
    const P = this.sim.plastic, w = [];
    for (let k = 0; k < P.edgeIdx.length; k++) w.push(+ (this.sim.w[P.edgeIdx[k]] / this.sim.w0[P.edgeIdx[k]]).toFixed(3));
    py('fly:save:' + JSON.stringify({ v: 1, ratio: w, memory: this.memory, stats: this.stats, streak: this.streak }));
    this.dirty = false;
  }
  loadMemory(data) {
    if (!data || data.v !== 1) return;
    const P = this.sim.plastic;
    if (P && Array.isArray(data.ratio) && data.ratio.length === P.edgeIdx.length) {
      for (let k = 0; k < P.edgeIdx.length; k++) this.sim.w[P.edgeIdx[k]] = this.sim.w0[P.edgeIdx[k]] * data.ratio[k];
    }
    this.memory = data.memory || {};
    this.stats = data.stats || this.stats;
    this.streak = data.streak || 0;
    this.setStatus(`remembering ${Object.keys(this.memory).length} cards`);
  }
}

const fly = new AnkiFly();
window.fly = fly;
fly.init().catch(e => { $('status').textContent = 'failed to load brain: ' + e.message; console.error(e); });

// Dev panel when opened directly in a browser (no pycmd).
if (new URLSearchParams(location.search).has('dev') || location.protocol === 'file:') {
  const dev = $('dev'); dev.style.display = 'flex';
  let nid = 1000;
  const btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.onclick = fn; dev.appendChild(b); };
  btn('Q', () => fly.event({ type: 'question', nid: nid }));
  btn('Q+', () => fly.event({ type: 'question', nid: ++nid }));
  btn('Again', () => fly.event({ type: 'rate', ease: 1 }));
  btn('Hard', () => fly.event({ type: 'rate', ease: 2 }));
  btn('Good', () => fly.event({ type: 'rate', ease: 3 }));
  btn('Easy', () => fly.event({ type: 'rate', ease: 4 }));
  btn('Loom', () => fly.event({ type: 'wake' }));
  btn('Sugar', () => fly.event({ type: 'sugar' }));
  btn('Sleep', () => { fly.lastEvent = performance.now() - 1e6; });
}
