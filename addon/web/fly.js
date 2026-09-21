// Anki Fly: glue between Anki events, the LIF sim, the brain view and the fly sprite.
import { Sim, parseGraph } from './sim.js';
import { BrainView } from './brain_view.js';
import { FlySprite as FlySprite2D } from './fly_sprite.js';

const $ = (id) => document.getElementById(id);
// Anki shows a scary error dialog for any uncaught error in an add-on page; keep ours in the console.
window.addEventListener('error', (e) => { console.warn('[anki-fly]', e.message); e.preventDefault(); });
window.addEventListener('unhandledrejection', (e) => { console.warn('[anki-fly]', e.reason); e.preventDefault(); });
// Anki injects window.pycmd at DocumentReady, after module scripts run, so check lazily.
const hasPy = () => typeof window.pycmd === 'function';
const py = (msg) => { if (hasPy()) window.pycmd(msg); else console.log('[pycmd]', msg.slice(0, 120)); };

const GREEN = [120, 255, 140], RED = [255, 90, 90], YELLOW = [255, 220, 90];

// Voice lines: short, picked at random, spoken on a cadence rather than every event.
const VOICE = {
  newCard: ['new smell.', 'hm, new one.', 'never smelled this.', '*sniff*', 'first time?'],
  likedCard: ['oh, this one.', 'I know this.', 'easy one.', 'we like this.', 'seen it.'],
  dreadCard: ['ugh. this one.', 'this one stings.', 'not again…', 'nervous.', 'we struggle here.'],
  seenCard: ['smelled this before.', 'familiar.', 'again? ok.', 'hm, I think I know it.'],
  good: ['sweet.', 'yes.', 'got it.', 'nice.', 'good good.', 'rewired.', 'tasty.'],
  easy: ['easy!', 'too easy.', 'ha.', 'more please.', 'yum.'],
  again: ['ouch.', 'stings.', 'oof.', 'that hurt.', 'we\'ll get it.', 'noted.'],
  hard: ['hard one.', 'close.', 'hmm.', 'almost.', 'tricky.'],
  streak: ['streak {n}!', '{n} in a row.', 'on fire.', 'unstoppable.'],
  streakBroken: ['streak gone.', 'well.', 'that one got us.'],
  sugar: ['sugar!', 'sweet sweet sugar.', 'proboscis time.'],
  loom: ['eek!', 'shadow!', 'jump!'],
  sleepy: ['zzz…', 'sleepy.', 'desk is comfy.'],
  wake: ['huh? oh, hi.', 'I\'m up. I\'m up.', 'back to it.'],
  idle: ['still here.', 'waiting.', 'take your time.', 'cards?', 'I\'ll wait.'],
  sessionEnd: ['{cards} cards. good session.', 'done for now.', '{cards} cards, {again} stung.'],
  amnesia: ['…who are you?', 'blank.', 'what deck?'],
  synced: ['I remember now.', 'so many smells.', '{n} cards. wow.'],
};
const pick = (key, vars = {}) => { const pool = VOICE[key]; const t = pool[Math.floor(Math.random() * pool.length)]; return t.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ''); };

const NT_WORDS = { ACH: 'acetylcholine, excites', GABA: 'GABA, inhibits', GLUT: 'glutamate, inhibits', DA: 'dopamine', SER: 'serotonin', OCT: 'octopamine', UNK: 'unknown transmitter' };
const GROUP_WORDS = { KC: 'memory cell (Kenyon cell)', MBON: 'memory output neuron', PAM: 'reward dopamine neuron', PPL1: 'punishment dopamine neuron', APL_DPM: 'keeps memories sparse',
  LC4: 'looming detector', GF: 'giant fiber, escape', GRN_sugar: 'sugar taste neuron', GRN_interneurons: 'taste relay', MN_proboscis: 'proboscis muscle neuron',
  DNp09: 'walk command', DNg11: 'grooming command', MDN: 'back-up command', DNa01: 'turn command', DNa02: 'turn command', background: 'other brain neuron' };

const FACTS = [
  'I have 9,000 real neurons in here.',
  'Each card is a different smell to me.',
  'Only ~5% of my memory cells fire per smell.',
  'Good = reward dopamine. Again = punishment dopamine.',
  'Dopamine rewires my synapses. That is how I learn.',
  'My wiring is from a real fly (MaleCNS 2026).',
  'Hover my brain to see what each dot is.',
  'Deep Focus in the gear menu if I get chatty.',
  'Tools → Anki Fly → Sync to give me your history.',
  '5 in a row and I get sugar.',
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
    this.sprite = await makeSprite($('fly'));
    if (this.sprite.setScene) this.sprite.setScene('study');
    this.brainTitle = `${meta.n.toLocaleString()} neurons · ${meta.nnz.toLocaleString()} synapses from MaleCNS v1.0`;
    $('brain').title = this.brainTitle + '. Hover a dot to see which neuron it is.';
    this.updateSession();
    window.addEventListener('resize', () => { try { this.brain.resize(); this.sprite.resize(); } catch (e) { console.warn(e); } });
    $('fly').addEventListener('webglcontextlost', (e) => { e.preventDefault(); console.warn('[anki-fly] WebGL context lost; using 2D sprite'); this.sprite = new FlySprite2D($('fly')); if (this.sprite.setScene) this.sprite.setScene('study'); });
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
    const menu = $('menu');
    const closeMenu = () => menu.classList.remove('open');
    $('gear').onclick = (e) => { e.stopPropagation(); menu.classList.toggle('open'); };
    document.addEventListener('click', closeMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    const item = (id, fn) => { $(id).onclick = (e) => { e.stopPropagation(); closeMenu(); fn(); }; };
    item('m-focus', () => py(this.cfg.focus ? 'fly:focus:off' : 'fly:focus:on'));
    item('m-exam', () => py('fly:exam'));
    item('m-min', () => py('fly:minimize'));
    item('m-close', () => py('fly:close'));
    $('panel').onclick = () => { if (document.body.classList.contains('mini')) py('fly:restore'); };
    // hover over the brain: name the nearest neuron
    const brain = $('brain');
    brain.addEventListener('mousemove', (e) => {
      const r = brain.getBoundingClientRect(), d = this.brain.dpr;
      const x = (e.clientX - r.left) * d, y = (e.clientY - r.top) * d;
      let best = -1, bd = 36 * d * d;
      const px = this.brain.px, py_ = this.brain.py;
      for (let i = 0; i < this.meta.n; i++) { const dx = px[i] - x, dy = py_[i] - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = i; } }
      if (best >= 0) this.setStatus(`${this.meta.type[best] || 'unnamed neuron'} · ${NT_WORDS[this.meta.nt[best]] || this.meta.nt[best]} · ${this.groupWords(this.groupOf(best))}`, true);
    });
    brain.addEventListener('mouseleave', () => { this.hoverStatus = null; if (this.statusText) $('status').textContent = this.statusText; });
  }

  groupWords(g) {
    if (g.startsWith('PN ')) return `smell input (${g.slice(3)})`;
    return GROUP_WORDS[g] || g;
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

  // Speak only sometimes: `every` = 1 in N chance, unless `force`.
  maybeSay(key, vars = {}, { every = 3, ms = 2600, force = false } = {}) {
    const now = performance.now();
    if (!force && (Math.random() >= 1 / every || now - (this.lastSaid || 0) < 4000)) return;
    this.lastSaid = now;
    this.say(pick(key, vars), ms);
  }

  say(text, ms = 3200) {
    if (!this.cfg.bubbles || this.cfg.focus) return;
    const b = $('bubble');
    b.textContent = text; b.classList.add('show');
    clearTimeout(this.bubbleTimer);
    this.bubbleTimer = setTimeout(() => b.classList.remove('show'), ms);
  }

  tonic() {
    // Low spontaneous activity across a random sample of neurons.
    const n = this.meta.n, idx = [];
    for (let k = 0; k < Math.max(20, n / 200); k++) idx.push((Math.random() * n) | 0);
    const asleep = this.state === 'sleep' || this.state === 'sleepDesk';
    this.sim.stimulate(idx, asleep ? 4 : 12, 2100);
  }

  // ---------- events from Anki ----------
  event(ev) {
    if (!this.sim) { (this.pending = this.pending || []).push(ev); return; }   // brain still loading
    try { this._event(ev); } catch (e) { console.warn('[anki-fly] event failed', ev && ev.type, e); }
  }

  _event(ev) {
    this.lastEvent = performance.now();
    const g = this.g, sim = this.sim;
    switch (ev.type) {
      case 'config':
        Object.assign(this.cfg, ev.cfg || {});
        $('memory').style.display = this.cfg.showMemory ? '' : 'none';
        document.body.classList.toggle('mini', !!this.cfg.minimized);
        document.body.classList.toggle('focus', !!this.cfg.focus);
        $('focus-on').textContent = this.cfg.focus ? '● on' : '';
        if (this.cfg.focus) { $('bubble').classList.remove('show'); this.setStatus('deep focus · the fly is studying quietly'); }
        else if ((this.statusText || '').startsWith('deep focus')) this.setStatus('back to studying');
        this.brain.resize(); this.sprite.resize();
        break;
      case 'amnesia':
        this.memory = {}; this.streak = 0; this.stats = { spikes: 0, reviews: 0 };
        if (this.sim.plastic) { const P = this.sim.plastic; for (let k = 0; k < P.edgeIdx.length; k++) this.sim.w[P.edgeIdx[k]] = this.sim.w0[P.edgeIdx[k]]; }
        this.dirty = true; this.updateMemoryBar(); this.maybeSay('amnesia', {}, { every: 1, force: true });
        break;
      case 'question': {
        this.currentNid = String(ev.nid);
        this.currentOdor = this.odorFor(this.currentNid);
        this.clearOdor();
        this.odorIdx = this.currentOdor.flatMap(k => g.PN_glomeruli[k]);
        sim.stimulate(this.odorIdx, 150, 60000);
        this.wakeIfNeeded();
        this.updateMemoryBar();
        const m = this.memory[this.currentNid];
        const feel = !m ? 'new to the fly' : this.pref(m) > 0.3 ? 'the fly likes this one' : this.pref(m) < -0.3 ? 'the fly dreads this one' : `the fly has seen this ${m.seen}×`;
        this.setStatus(`sniffing this card · ${feel}`, false, `odor = glomeruli ${this.currentOdor.join(' ')} (from the note id)`);
        this.maybeSay(!m ? 'newCard' : this.pref(m) > 0.3 ? 'likedCard' : this.pref(m) < -0.3 ? 'dreadCard' : 'seenCard', {}, { every: 4 });
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
        this.force(['pressAgain', 'pressHard', 'pressGood', 'pressEasy'][Math.min(4, Math.max(1, ease)) - 1], 750);
        if (ease >= 3) {
          sim.stimulate(g.PAM, 60, 400);
          const changed = sim.dopamine(1, ease === 4 ? 1.3 : 1.0);
          this.session.synapses += changed;
          this.brain.pulse(g.PAM, GREEN);
          this.streak++;
          this.setStatus(`liked that · ${changed} synapses rewired${secs ? ' · ' + secs : ''}`, false, 'PAM reward dopamine depressed KC→MBON avoidance synapses');
          if (this.streak > 0 && this.streak % 5 === 0) this.sugar();
          else if (this.streak > 0 && this.streak % 3 === 0) { setTimeout(() => this.force('celebrate', 900), 800); this.maybeSay('streak', { n: this.streak }, { every: 1, force: true }); }
          else this.maybeSay(ease === 4 ? 'easy' : 'good', {}, { every: 3 });
        } else if (ease === 1) {
          sim.stimulate(g.PPL1, 60, 400);
          const changed = sim.dopamine(0, 1.0);
          this.session.synapses += changed; this.session.again++;
          this.brain.pulse(g.PPL1, RED);
          const had = this.streak; this.streak = 0;
          this.setStatus(`that stung · ${changed} synapses rewired${secs ? ' · ' + secs : ''}`, false, 'PPL1 punishment dopamine depressed KC→MBON approach synapses');
          if (had >= 3) this.maybeSay('streakBroken', {}, { every: 1, force: true }); else this.maybeSay('again', {}, { every: 2 });
        } else {
          sim.stimulate(g.PPL1, 25, 250);
          const changed = sim.dopamine(0, 0.4);
          this.session.synapses += changed;
          this.brain.pulse(g.PPL1, YELLOW);
          this.setStatus(`hard one · ${changed} synapses nudged${secs ? ' · ' + secs : ''}`, false, 'weak PPL1 dopamine');
          this.maybeSay('hard', {}, { every: 3 });
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
        this.updateSession();
        break;
      }
      case 'wake': this.loom(); break;
      case 'sugar': this.sugar(); break;
      case 'session_end': {
        this.clearOdor();
        const s = this.session, mins = ((performance.now() - s.start) / 60000).toFixed(0);
        this.setStatus(`session over · ${s.cards} cards in ${mins} min · ${s.synapses} synapses rewired`);
        if (s.cards) this.maybeSay('sessionEnd', { cards: s.cards, again: s.again }, { every: 1, force: true, ms: 5000 });
        this.session = { cards: 0, again: 0, synapses: 0, start: performance.now() };
        this.save();
        break;
      }
      case 'loadMemory':
        this.loadMemory(ev.data);
        break;
      case 'sync':
        this.syncHistory(ev.notes, ev.reviews);
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
    this.setStatus('startled', false, 'looming stimulus → LC4 → giant fiber (DNp01)');
    this.maybeSay(this.state === 'sleep' || this.state === 'sleepDesk' ? 'wake' : 'loom', {}, { every: 2 });
  }

  sugar() {
    const g = this.g;
    if (g.GRN_sugar?.length) this.sim.stimulate(g.GRN_sugar, 150, 900);
    this.force('proboscis', 1600);
    this.setStatus('sugar! 5 in a row', false, 'sugar GRNs → MN9 → proboscis extension');
    this.maybeSay('sugar', {}, { every: 1, force: true });
  }

  force(state, ms) { this.forcedState = { state, until: performance.now() + ms }; }

  wakeIfNeeded() { if (this.state === 'sleep') this.loom(); }

  // ---------- behavior readout ----------
  chooseState(now) {
    if (this.cfg.focus) return 'still';
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
    if (idleMs > this.cfg.sleepSeconds * 1000) return this.sprite.setScene ? 'sleepDesk' : 'sleep';
    if (groom > 8) return 'groom';
    if (walk > 8) return 'walk';
    if (idleMs > this.cfg.idleSeconds * 1000) {
      // scripted idle behaviors, gently stimulating the real circuits so the brain shows it
      if (this.sprite.setScene) { const ph = Math.floor(idleMs / 15000) % 4; if (ph === 3 && g.DNg11?.length && Math.random() < 0.02) sim.stimulate(g.DNg11, 40, 800); return ph === 3 ? 'groom' : 'study'; }
      const phase = Math.floor(idleMs / 9000) % 3;
      if (phase === 1) { if (g.DNg11?.length && Math.random() < 0.02) sim.stimulate(g.DNg11, 40, 800); return 'groom'; }
      if (phase === 2) { if (g.DNp09?.length && Math.random() < 0.02) sim.stimulate(g.DNp09, 40, 800); return 'walk'; }
      return 'idle';
    }
    if (this.sprite.setScene) return 'study';
    return this.odorIdx ? 'idle' : (Math.sin(now / 7000) > 0.6 ? 'walk' : 'idle');
  }

  // ---------- frame loop ----------
  frame(now) {
    try { this._frame(now); } catch (e) { if (!this._frameErr) { this._frameErr = true; console.warn('[anki-fly] frame error', e); } }
    requestAnimationFrame((t) => this.frame(t));
  }

  _frame(now) {
    const wall = Math.min(60, now - this.lastFrame);
    this.lastFrame = now;
    const asleep = this.state === 'sleep' || this.state === 'sleepDesk';
    const simMs = wall * this.cfg.speed * (asleep ? 0.4 : 1);
    const steps = this.syncing ? 0 : Math.max(1, Math.round(simMs / this.sim.p.dt));
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
    try { this.sprite.update(wall); this.sprite.draw(); }
    catch (e) { console.warn('[anki-fly] sprite failed, switching to 2D', e); this.sprite = new FlySprite2D($('fly')); }
    this.brain.draw(wall);
    if (!this.cfg.focus && now - this.lastEvent > 30000 && now - this.lastFact > 120000 && !asleep && !document.body.classList.contains('mini')) {
      this.lastFact = now;
      if (Math.random() < 0.6) this.say(FACTS[this.factIdx++ % FACTS.length], 6000); else this.maybeSay('idle', {}, { every: 1, force: true });
    }
    if (asleep && !this.saidSleepy) { this.saidSleepy = true; this.maybeSay('sleepy', {}, { every: 1, force: true }); }
    if (!asleep) this.saidSleepy = false;
    if ((this.frameNo = (this.frameNo | 0) + 1) % 15 === 0) {
      $('hz').textContent = `${(spikes * 1000 / Math.max(1, simMs) / this.meta.n).toFixed(1)} Hz`; $('hz').title = 'mean firing rate per neuron';
    }
  }

  updateSession() {
    const s = this.session, k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    $('session').textContent = s.cards ? `${s.cards} cards · ${s.again} stung · ${k(s.synapses)} synapses rewired` : `${Object.keys(this.memory).length} cards remembered`;
  }

  setStatus(s, hover = false, detail = '') {
    if (hover) { this.hoverStatus = s; $('status').textContent = s; return; }
    this.statusText = s;
    $('status').title = detail;
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

  // ---------- history replay ----------
  async syncHistory(notes, reviews) {
    const sim = this.sim, g = this.g, total = notes.length;
    this.syncing = true;
    this.say('replaying your history…', 6000);
    let done = 0, changed = 0;
    for (let i = 0; i < total; i++) {
      const n = notes[i];
      const odor = this.odorFor(String(n.nid)).flatMap(k => g.PN_glomeruli[k]);
      sim.elig.fill(0);                          // no cross-talk between notes
      sim.stimulate(odor, 150, 90); sim.run(90); sim.clearStim(odor);
      const kcs = new Set(g.KC.filter(k => sim.elig[k] > 0.2));
      // reward depresses avoidance, punishment depresses approach; saturating so a year of reviews doesn't floor everything
      const reward = Math.min(2.5, 0.35 * n.good + 0.6 * n.easy);
      const punish = Math.min(2.5, 0.6 * n.again + 0.2 * n.hard);
      if (reward > 0) changed += sim.dopamine(1, reward);
      if (punish > 0) changed += sim.dopamine(0, punish);
      const m = this.memory[String(n.nid)] || { seen: 0 };
      m.seen += n.n; m.approach = sim.memoryDrive(kcs, 0); m.avoid = sim.memoryDrive(kcs, 1);
      this.memory[String(n.nid)] = m;
      done++;
      if (i % 25 === 24) { this.setStatus(`syncing memories · ${done.toLocaleString()} / ${total.toLocaleString()} notes`); await new Promise(r => requestAnimationFrame(r)); }
    }
    sim.elig.fill(0);
    this.dirty = true; this.save(); this.syncing = false;
    this.setStatus(`synced · ${total.toLocaleString()} notes remembered`);
    this.updateSession(); this.updateMemoryBar();
    this.say(`${pick('synced', { n: Object.keys(this.memory).length.toLocaleString() })} (${reviews.toLocaleString()} reviews, ${changed.toLocaleString()} synapses)`, 7000);
    this.force('celebrate', 900);
  }

  // ---------- persistence ----------
  save() {
    if (!this.dirty || !this.sim || !this.sim.plastic) return;
    try { this._save(); } catch (e) { console.warn('[anki-fly] save failed', e); }
  }
  _save() {
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
    this.setStatus(`remembers ${Object.keys(this.memory).length} of your cards`);
    this.updateSession();
  }
}

async function makeSprite(canvas) {
  try {
    if (!window.THREE) throw new Error('three.js not loaded');
    const mod = await import('./fly3d.js');
    const sp = new mod.FlySprite(canvas);
    sp.update(0); sp.draw();   // smoke test the WebGL path before committing to it
    return sp;
  } catch (e) {
    console.warn('[anki-fly] 3D fly unavailable, using 2D sprite:', e.message);
    return new FlySprite2D(canvas);
  }
}

const fly = new AnkiFly();
window.fly = fly;
(async () => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await fly.init(); return; }
    catch (e) { console.warn('[anki-fly] init failed (attempt ' + attempt + ')', e); $('status').textContent = 'loading brain… retrying'; await new Promise(r => setTimeout(r, 1500 * attempt)); }
  }
  $('status').textContent = 'could not load the brain data. Reinstall the add-on?';
})();

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
  btn('Focus', () => fly.event({ type: 'config', cfg: { focus: !fly.cfg.focus } }));
}
