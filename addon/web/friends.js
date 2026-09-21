// Fly friends panel (lives in an iframe on Anki's deck list). Asks Python for the friend list through
// the parent page's pycmd bridge and renders each online friend's fly in a lightweight canvas.
const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => { console.warn('[fly friends]', e.message); e.preventDefault(); });
const bridge = () => (window.parent && typeof window.parent.pycmd === 'function') ? window.parent.pycmd : null;
const ask = (cmd) => new Promise((res) => { const p = bridge(); if (!p) return res(null); try { p('flyfriends:' + cmd, res); } catch { res(null); } });

const MOOD_WORDS = { study: 'studying', pressAgain: 'pressed Again', pressHard: 'pressed Hard', pressGood: 'pressed Good', pressEasy: 'pressed Easy',
  celebrate: 'on a streak', dance: 'dancing', zoomies: 'zoomies!', crashout: 'crashing out', sulk: 'sulking', sleepDesk: 'asleep', still: 'deep focus', idle: 'idle', offline: 'offline' };
const ago = (s) => s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;

class Panel {
  async init() {
    try { if (!window.THREE) throw 0; this.mod = await import('./fly3d.js'); } catch { this.mod = await import('./fly_sprite.js'); }
    this.sprites = new Map();
    $('add').onclick = () => ask('add');
    $('code').onclick = () => ask('code');
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    await this.refresh();
    setTimeout(() => this.refresh(), 3000);
    setInterval(() => this.refresh(), 30000);
  }

  async refresh() {
    const data = await ask('list');
    if (!data) return;
    $('code').textContent = data.me.code || 'no code yet';
    $('code').title = 'your fly code (click to show)';
    const row = $('row'); const seen = new Set();
    const list = data.friends || [];
    $('empty').hidden = list.length > 0;
    for (const f of list) {
      seen.add(f.code);
      let el = row.querySelector(`[data-code="${f.code}"]`);
      if (!el) {
        el = document.createElement('div'); el.dataset.code = f.code;
        el.innerHTML = `<canvas></canvas><div class="nm"></div><div class="st"></div>`;
        row.appendChild(el);
        try {
          const sp = new this.mod.FlySprite(el.querySelector('canvas'), { lite: true });
          if (sp.setLite) sp.setLite(true);
          if (sp.setScene) sp.setScene('study');
          this.sprites.set(f.code, sp);
        } catch (e) { console.warn('[fly friends] sprite', e); }
      }
      el.className = 'fr ' + (f.online ? 'on' : 'off');
      el.querySelector('.nm').textContent = f.name || f.code;
      el.querySelector('.st').textContent = f.online ? `${MOOD_WORDS[f.mood] || f.mood}${f.cardsPerMin ? ` · ${f.cardsPerMin} cards/min` : ''}` : `offline · ${ago(Math.max(0, data.now - (f.lastSeen || 0)))}`;
      const sp = this.sprites.get(f.code);
      if (sp) {
        if (sp.setSpecies) sp.setSpecies(f.species === 'female' ? 'female' : 'wild');
        if (sp.setCostume) sp.setCostume(f.costume || 'none');
        sp.setState(f.online ? (f.mood === 'offline' ? 'study' : f.mood) : 'sleepDesk');
      }
    }
    for (const el of [...row.children]) if (!seen.has(el.dataset.code)) { el.remove(); this.sprites.delete(el.dataset.code); }
  }

  frame(now) {
    const dt = Math.min(60, now - this.last); this.last = now;
    for (const sp of this.sprites.values()) { try { sp.update(dt); sp.draw(); } catch {} }
    requestAnimationFrame((t) => this.frame(t));
  }
}
new Panel().init();
