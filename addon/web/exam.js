// Fly Exam: the fly's brain is presented with each card's odor; its answer blends Anki's memory
// model (FSRS retrievability, the science) with the fly's own connectome memory (the toy).
import { Sim, parseGraph, mulberry32 } from './sim.js';
import { BrainView } from './brain_view.js';

const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => { console.warn('[anki-fly exam]', e.message); e.preventDefault(); });
window.addEventListener('unhandledrejection', (e) => { console.warn('[anki-fly exam]', e.reason); e.preventDefault(); });
const hasPy = () => typeof window.pycmd === 'function';
const py = (msg) => { if (hasPy()) window.pycmd(msg); else console.log('[pycmd]', msg); };
const pct = (x) => `${Math.round(x * 100)}%`;
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const FLY_WEIGHT = 0.25; // share of the answer probability that comes from the fly's own synapses

class Exam {
  async init() {
    const base = new URL('.', import.meta.url);
    let spriteMod;
    try { if (!window.THREE) throw new Error('no three'); spriteMod = await import('./fly3d.js'); } catch { spriteMod = await import('./fly_sprite.js'); }
    const Sprite2D = (await import('./fly_sprite.js')).FlySprite;
    const mk = (canvas) => {
      if (spriteMod.FlySprite === Sprite2D) return new Sprite2D(canvas);
      try { const sp = new spriteMod.FlySprite(canvas); sp.update(0); sp.draw(); return sp; }
      catch (e) {
        console.warn('[anki-fly exam] 3D failed, 2D fallback', e);
        const c = document.createElement('canvas'); c.id = canvas.id; canvas.replaceWith(c);   // WebGL-claimed canvas can't give a 2D context
        return new Sprite2D(c);
      }
    };
    const [meta, gbuf] = await Promise.all([
      fetch(new URL('data/meta.json', base)).then(r => r.json()),
      fetch(new URL('data/graph.bin', base)).then(r => r.arrayBuffer()),
    ]);
    this.meta = meta; this.g = meta.groups;
    this.sim = new Sim(parseGraph(gbuf));
    const P = meta.plastic;
    this.sim.setPlasticEdges(Int32Array.from(P.edge), Int32Array.from(P.pre), Int32Array.from(P.post), Uint8Array.from(P.cls));
    meta.denseGroups = new Set(this.g.KC);
    this.brain = new BrainView($('brain'), meta);
    this.sprite = mk($('fly'));
    this.desk = !!this.sprite.setScene;
    if (this.desk) this.sprite.setScene('exam');
    this.sprite.setState(this.desk ? 'think' : 'idle');
    window.addEventListener('resize', () => { this.brain.resize(); this.sprite.resize(); });
    $('close').onclick = () => py('exam:close');
    $('again').onclick = () => this.start(this.payload, (this.seed | 0) + 1);
    this.last = performance.now();
    requestAnimationFrame(t => this.frame(t));
    const announce = () => { if (hasPy()) py('exam:ready'); else setTimeout(announce, 100); };
    announce();
  }

  frame(now) {
    const dt = Math.min(50, now - this.last); this.last = now;
    try { if (!this.running) this.sim.run(dt); this.brain.draw(dt); }
    catch (e) { if (!this._err) { this._err = true; console.warn('[anki-fly exam] frame error', e); } }
    try { this.sprite.update(dt); this.sprite.draw(); }
    catch (e) { if (!this._spriteErr) { this._spriteErr = true; console.warn('[anki-fly exam] sprite error', e); } }
    requestAnimationFrame(t => this.frame(t));
  }

  odorFor(nid) {
    const keys = Object.keys(this.g.PN_glomeruli);
    let h = 2166136261;
    for (const ch of String(nid)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
    const out = [];
    while (out.length < Math.min(6, keys.length)) {
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      const k = keys[h % keys.length];
      if (!out.includes(k)) out.push(k);
    }
    return out.flatMap(k => this.g.PN_glomeruli[k]);
  }

  loadMemory(data) {
    const P = this.sim.plastic;
    for (let k = 0; k < P.edgeIdx.length; k++) this.sim.w[P.edgeIdx[k]] = this.sim.w0[P.edgeIdx[k]];
    if (data && data.v === 1 && Array.isArray(data.ratio) && data.ratio.length === P.edgeIdx.length) {
      for (let k = 0; k < P.edgeIdx.length; k++) this.sim.w[P.edgeIdx[k]] = this.sim.w0[P.edgeIdx[k]] * data.ratio[k];
      return Object.keys(data.memory || {}).length;
    }
    return 0;
  }

  async start(payload, seed = 7) {
    try { await this._start(payload, seed); }
    catch (e) { console.warn('[anki-fly exam] failed', e); this.running = false; $('phase').textContent = 'The exam hit a snag: ' + (e && e.message); }
  }

  async _start(payload, seed) {
    if (this.running) return;                     // ignore double starts
    if (!payload || !Array.isArray(payload.cards) || !payload.cards.length) { $('phase').textContent = 'No cards to test.'; return; }
    this.payload = payload; this.seed = seed; this.running = true;
    $('report').style.display = 'none'; $('again').style.display = 'none';
    $('ticker').innerHTML = '';
    const cards = payload.cards;
    const known = this.loadMemory(payload.memory);
    $('sub').textContent = `${cards.length}${payload.total_matching > cards.length ? ' of ' + payload.total_matching.toLocaleString() : ''} cards · ${payload.search}`;
    $('phase').textContent = `The fly has studied ${known} of your cards before. Sniffing…`;
    const rng = mulberry32(seed);
    const results = [];
    // pace the exam so you can watch the fly work: ~150 ms per card, at most ~10 s in total
    const paceMs = Math.min(150, 10000 / cards.length);
    this.sprite.setState(this.desk ? 'think' : 'walk');
    const t0 = performance.now();
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const odor = this.odorFor(c.nid);
      // present the odor for 300 ms of brain time and read the mushroom-body output
      this.sim.stimulate(odor, 150, 300);
      const sp = this.sim.run(300);
      this.sim.clearStim(odor);
      this.brain.addSpikes(this.g.KC.filter(k => this.sim.elig[k] > 0.2).slice(0, 80));
      const kcs = new Set(this.g.KC.filter(k => this.sim.elig[k] > 0.2));
      const approach = this.sim.memoryDrive(kcs, 0), avoid = this.sim.memoryDrive(kcs, 1);
      const pref = Math.max(-1, Math.min(1, ((1 - avoid) - (1 - approach)) * 2.5));
      const flyP = 0.5 + 0.5 * pref;
      const p = c.model === 'new' ? 0.02 : (1 - FLY_WEIGHT) * c.r + FLY_WEIGHT * flyP;
      const u = rng();
      const correct = u < p;               // the fly's answer (blended)
      const fsrsCorrect = u < c.r;         // what FSRS alone predicts, same random draw
      results.push({ ...c, pref, flyP, p, correct, fsrsCorrect, kc: kcs.size, spikes: sp });
      this.sim.run(120); // let it settle
      if (paceMs >= 40 || i % 4 === 0 || i === cards.length - 1) {
        $('progress').firstElementChild.style.width = `${(i + 1) / cards.length * 100}%`;
        const row = document.createElement('div');
        row.className = correct ? 'ok' : 'no';
        row.innerHTML = `<span>${correct ? '✓' : '✗'}</span><b>${esc(c.front)}</b><span>${pct(p)}</span>`;
        $('ticker').prepend(row);
        while ($('ticker').children.length > 40) $('ticker').lastChild.remove();
        this.sprite.setState(this.desk ? (i % 2 ? 'write' : 'think') : (correct ? 'proboscis' : 'groom'));
        await new Promise(r => setTimeout(r, paceMs));
      }
    }
    this.running = false;
    const sc = results.filter(r => r.correct).length / results.length;
    this.sprite.setState(this.desk ? (sc >= 0.8 ? 'celebrate' : 'think') : 'idle');
    $('phase').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    this.report(results);
  }

  report(res) {
    const P = this.payload, pat = P.pattern || {};
    const n = res.length;
    const score = res.filter(r => r.correct).length / n;
    const expected = res.reduce((s, r) => s + r.p, 0) / n;
    const fsrsScore = res.filter(r => r.fsrsCorrect).length / n;
    const fsrsExpected = res.reduce((s, r) => s + r.r, 0) / n;
    const band = 1.96 * Math.sqrt(res.reduce((s, r) => s + r.r * (1 - r.r), 0)) / n;
    const studied = res.filter(r => r.model !== 'new');
    const coverage = studied.length / n;
    const meanR = studied.length ? studied.reduce((s, r) => s + r.r, 0) / studied.length : 0;
    const knowledge = studied.reduce((s, r) => s + r.r, 0);
    const heuristic = studied.length && studied.every(r => r.model !== 'fsrs');
    const dr = P.desired_retention;
    const bins = new Array(10).fill(0);
    for (const r of studied) bins[Math.min(9, Math.floor(r.r * 10))]++;
    const maxBin = Math.max(1, ...bins);
    const totalS = studied.reduce((s, r) => s + r.stability, 0);
    const minutes = pat.minutes_total || 0;
    const effic = minutes > 0 ? totalS / minutes : null;
    const againRate30 = pat.again_rate_review_30d ?? (pat.reviews_30d ? pat.again_30d / pat.reviews_30d : null);
    const retPerMin = minutes > 0 ? knowledge / minutes : null;
    const flyAgree = res.filter(r => r.model !== 'new' && ((r.flyP > 0.5) === (r.r > 0.85))).length / Math.max(1, studied.length);

    const tiles = [
      ['What FSRS predicts', `${pct(fsrsScore)}`, `expected ${pct(fsrsExpected)} ± ${pct(band)} · ${heuristic ? 'SM-2 heuristic' : 'FSRS'}`],
      ['What the fly got', pct(score), `expected ${pct(expected)} · 25% fly brain · seed ${this.seed}`],
      ['Predicted retention now', pct(meanR), dr ? `target ${pct(dr)} · ${knowledge.toFixed(0)} cards\' worth known` : `${knowledge.toFixed(0)} cards\' worth known`],
      ['Coverage', pct(coverage), `${studied.length} of ${n} cards ever reviewed`],
      ['True retention (30 d)', pat.true_retention_30d == null ? '—' : pct(pat.true_retention_30d), pat.true_retention_mature_30d == null ? `${pat.true_retention_n_30d || 0} reviews` : `mature ${pct(pat.true_retention_mature_30d)} · ${pat.true_retention_n_30d} reviews`],
      ['Again rate (30 d)', againRate30 == null ? '—' : pct(againRate30), `${pat.reviews_30d || 0} reviews · ${(pat.minutes_30d || 0).toFixed(0)} min`],
      ...(heuristic ? [] : [['Stability per minute', effic == null ? '—' : `${effic.toFixed(1)} d/min`, 'days of memory stability bought per minute, all time']]),
      ['Retention per minute', retPerMin == null ? '—' : retPerMin.toFixed(2), 'cards remembered now per minute ever invested'],
      ['Consistency (30 d)', `${pat.days_studied_30d || 0}/${Math.min(30, Math.max(1, Math.ceil(pat.first_review_days_ago || 30)))}`, 'days with at least one review'],
      ['Overdue', `${pat.overdue || 0}${pat.review_cards ? ' / ' + pat.review_cards : ''}`, 'review cards past due'],
      ['Fly ↔ FSRS agreement', pct(flyAgree), 'fly likes it ⇔ FSRS says ≥85%'],
    ];
    const diags = this.diagnose({ meanR, dr, againRate30, pat, studied, res, coverage });
    const weakest = [...studied].sort((a, b) => a.p - b.p).slice(0, 12);

    // ---- plain-language summary first, details after
    const plain = [];
    if (studied.length === 0) {
      plain.push('None of these cards have been reviewed yet, so there is nothing to predict. Study them first, then come back.');
    } else {
      plain.push(`If you were tested on these ${n} cards right now, you would get about <b>${pct(fsrsExpected)}</b> right${heuristic ? ' (rough estimate, FSRS is off)' : ''}. The fly got <b>${pct(score)}</b>.`);
      plain.push(`You currently remember about <b>${knowledge.toFixed(0)} of the ${studied.length}</b> cards you have studied in this set.`);
      if (dr) plain.push(meanR >= dr - 0.03 ? `That is right where Anki aims (your target is ${pct(dr)}).` : `Anki aims for ${pct(dr)}; you are <b>${pct(dr - meanR)} below</b> that${meanR < dr - 0.08 ? ', mostly because of overdue or decayed cards' : ', which is close enough'}.`);
      if (pat.true_retention_30d != null) plain.push(`Over the last 30 days you remembered <b>${pct(pat.true_retention_30d)}</b> of the cards Anki showed you.`);
      if (againRate30 != null) plain.push(`You pressed Again on about <b>${pct(againRate30)}</b> of reviews.`);
      const span = Math.min(30, Math.max(1, Math.ceil(pat.first_review_days_ago || 30)));
      if (span >= 7) plain.push(`You studied on <b>${pat.days_studied_30d || 0} of the last ${span} days</b>${(pat.days_studied_30d || 0) / span >= 0.8 ? ', nice and steady.' : '.'}`);
      if ((pat.overdue || 0) > 0) plain.push(`<b>${pat.overdue}</b> cards are overdue.`);
      if (coverage < 1) plain.push(`${n - studied.length} cards in this set have never been reviewed.`);
    }
    $('report').innerHTML = `
      <h2>In plain words</h2>
      <ul class="plain">${plain.map(t => `<li>${t}</li>`).join('')}</ul>
      <h2>What to do</h2>
      ${diags.map(d => `<div class="diag ${d.level}"><div class="ic">${d.level === 'good' ? '✓' : d.level === 'warn' ? '!' : '✗'}</div><div class="t"><b>${d.title}</b><small>${d.why}</small></div></div>`).join('')}
      <details class="more" open>
        <summary>Details and numbers</summary>
        <div class="tiles">${tiles.map(([k, v, d]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('')}</div>
        <h2>Retrievability of studied cards (FSRS)</h2>
        <div class="hist">${bins.map((b, i) => `<div class="bar" data-n="${b}" title="${i * 10}–${i * 10 + 10}%: ${b} cards" style="height:${Math.max(2, b / maxBin * 100)}%"></div>`).join('')}</div>
        <div class="hist-x">${bins.map((_, i) => `<span>${i * 10}–${i * 10 + 10}%</span>`).join('')}</div>
        <h2>Cards the fly is least sure about</h2>
        <table><thead><tr><th>Card</th><th>Deck</th><th class="num">FSRS R</th><th class="num">Fly</th><th class="num">Lapses</th><th class="num">Stability</th></tr></thead>
        <tbody>${weakest.map(r => `<tr><td><a data-cid="${r.cid}">${esc(r.front) || '(empty)'}</a></td><td>${esc(r.deck)}</td><td class="num">${pct(r.r)}</td><td class="num">${r.pref > 0.3 ? 'likes' : r.pref < -0.3 ? 'dreads' : 'unsure'}</td><td class="num">${r.lapses}</td><td class="num">${r.stability ? r.stability.toFixed(0) + ' d' : '—'}</td></tr>`).join('')}</tbody></table>
        <div class="foot">How this works: "What FSRS predicts" samples each card as correct with probability R (Anki's own retrievability, R = (1 + factor·t/S)^(−decay), evaluated now); that row is the real gauge. "What the fly got" blends in the fly's toy brain at ${pct(FLY_WEIGHT)} (new cards ≈ 2%). Retention, efficiency and consistency come straight from your collection and review log using Anki's own definitions (true retention counts rated, scheduling-affecting reviews; mature = interval ≥ 21 d). Thresholds in the advice are conventions, each with its research reason. Cards without FSRS memory state use an SM-2 heuristic (0.9^(elapsed/interval)) and are labelled as such.</div>
      </details>`;
    $('report').style.display = 'block'; $('right').scrollTop = 0;
    $('again').style.display = 'inline-block';
    $('report').querySelectorAll('a[data-cid]').forEach(a => a.onclick = () => py('exam:browse:cid:' + a.dataset.cid));
  }

  diagnose({ meanR, dr, againRate30, pat, studied, res, coverage }) {
    const out = [];
    const push = (level, title, why) => out.push({ level, title, why });
    if (studied.length === 0) { push('warn', 'No studied cards in this set', 'The fly can only be tested on cards you have reviewed at least once.'); return out; }
    if (dr && meanR < dr - 0.08) push('bad', `Retention is ${pct(dr - meanR)} below your target`, 'Many cards are overdue or decayed. Clearing the backlog restores retention fastest; FSRS predicts recall from elapsed time vs. stability.');
    else if (dr && meanR < dr - 0.03) push('warn', `Retention is ${pct(dr - meanR)} below your target`, 'Slightly behind. Keep up with due reviews and it will recover on its own.');
    else if (dr && meanR > dr + 0.05) push('good', 'Retention is above target', 'You are reviewing ahead of the forgetting curve. If workload feels high, a lower desired retention (0.85–0.9) usually costs little recall per review.');
    else push('good', 'Retention is on target', 'Predicted recall of this set matches your desired retention.');
    if (dr && dr >= 0.95) push('warn', `Desired retention ${pct(dr)} is expensive`, 'Above ~0.9 the number of reviews grows steeply for each extra percent of recall (FSRS workload simulations). 0.8–0.9 is the usual sweet spot.');
    if (againRate30 != null && (pat.reviews_30d || 0) >= 50) {
      if (againRate30 > 0.25) push('bad', `Again rate ${pct(againRate30)} is high`, 'Cards are too hard or too dense. Split cloze/multi-fact cards, and let leeches be suspended — retrieval practice only helps when retrieval sometimes succeeds.');
      else if (againRate30 > 0.15) push('warn', `Again rate ${pct(againRate30)}`, 'A little high. Check for leeches and overly long cards.');
      else push('good', `Again rate ${pct(againRate30)} is healthy`, 'Forgetting some cards is expected — desirable difficulty keeps the testing effect working.');
    }
    if (pat.mature_secs_per_review != null && pat.mature_secs_per_review > 20) push('warn', `${pat.mature_secs_per_review.toFixed(0)} s per mature review`, 'Slow recall on mature cards suggests cards that require reasoning rather than retrieval. Aim for atomic cards answered in a few seconds.');
    if (pat.young_easy_rate != null && pat.young_easy_rate > 0.3) push('warn', `${pct(pat.young_easy_rate)} of young reviews rated Easy`, 'Easy inflates intervals on cards you haven\'t proven yet. Reserve Easy for instant, certain recall.');
    const days = pat.days_studied_30d || 0, span = Math.min(30, Math.max(1, Math.ceil(pat.first_review_days_ago || 30)));
    if (span < 7) push('good', `Only ${span} day(s) of history`, 'Too early to judge consistency.');
    else if (days / span < 0.5) push('bad', `Studied ${days} of the last ${span} days`, 'Spacing only works if reviews happen near their due date; gaps turn spaced practice into cramming (Cepeda et al. 2006).');
    else if (days / span < 0.8) push('warn', `Studied ${days} of the last ${span} days`, 'Fairly consistent. Daily short sessions beat occasional long ones.');
    else push('good', `Studied ${days} of the last ${span} days`, 'Consistent daily practice — the spacing effect is working for you.');
    if (coverage < 0.6) push('warn', `${pct(1 - coverage)} of these cards were never reviewed`, 'The exam score is dominated by zeros. Unique cards seen is what predicted exam performance in the med-school Anki studies (Deng et al. 2015).');
    if ((pat.overdue || 0) > Math.max(1, (pat.review_cards || studied.length)) * 0.2) push('bad', `${pat.overdue} cards overdue`, 'Overdue cards decay below target; FSRS will reschedule them, but a big backlog is the main reason predicted retention drops.');
    if (!pat.fsrs_enabled) push('warn', 'FSRS is off', 'Retrievability is estimated with an SM-2 heuristic (0.9^(elapsed/interval)). Enabling FSRS in deck options gives the fly a real memory model.');
    const dread = res.filter(r => r.pref < -0.3).length;
    if (dread > 0) push('warn', `The fly dreads ${dread} cards`, 'These smells have been paired with PPL1 punishment (Again) more than PAM reward. They are probably your leeches.');
    return out;
  }
}

const exam = new Exam();
window.exam = exam;
exam.init().catch(e => { $('phase').textContent = 'failed to load brain: ' + e.message; console.error(e); });

if (location.protocol === 'file:' || new URLSearchParams(location.search).has('dev')) {
  // standalone demo data
  setTimeout(() => {
    const cards = Array.from({ length: 60 }, (_, i) => ({ cid: i, nid: 1000 + i, front: 'Demo card ' + i, deck: 'Demo', type: 2, ivl: 10, reps: 5, lapses: i % 7 === 0 ? 3 : 0, stability: 5 + i, difficulty: 5, elapsed: i % 9, r: Math.max(0.2, 1 - (i % 9) / 12), model: 'fsrs' }));
    exam.start({ cards, search: 'demo', pattern: { reviews_30d: 400, again_30d: 60, minutes_30d: 55, minutes_total: 300, true_retention_30d: 0.86, days_studied_30d: 22, overdue: 3, fsrs_enabled: true, mature_secs_per_review: 8 }, desired_retention: 0.9, memory: null });
  }, 1500);
}
