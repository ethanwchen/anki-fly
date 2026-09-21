// Fly race: weekly leaderboard on Anki's deck list (inside an iframe). Cards reviewed this week per
// person, with each fly's face icon. Nothing about individual answers or cards is shown.
const $ = (id) => document.getElementById(id);
window.addEventListener('error', (e) => { console.warn('[fly race]', e.message); e.preventDefault(); });
const bridge = () => (window.parent && typeof window.parent.pycmd === 'function') ? window.parent.pycmd : null;
const ask = (cmd) => new Promise((res) => { const p = bridge(); if (!p) return res(null); try { p('flyfriends:' + cmd, res); } catch { res(null); } });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

class Race {
  async init() {
    try { if (!window.THREE) throw 0; this.mod = await import('./fly3d.js'); } catch { this.mod = null; }
    this.icons = new Map();
    $('add').onclick = () => ask('add');
    $('code').onclick = () => ask('code');
    await this.refresh();
    setTimeout(() => this.refresh(), 3000);
    setInterval(() => this.refresh(), 60000);
  }

  async icon(species, costume) {
    const key = `${species}|${costume}`;
    if (this.icons.has(key)) return this.icons.get(key);
    let url = '';
    try { if (this.mod && this.mod.FlySprite.icon) url = await this.mod.FlySprite.icon({ costume, species, size: 72 }); } catch (e) { console.warn('[fly race] icon', e); }
    this.icons.set(key, url);
    return url;
  }

  async refresh() {
    const data = await ask('list');
    if (!data) return;
    $('code').textContent = data.me.code || 'no code yet';
    $('week').textContent = data.week ? `week ${data.week.split('-W')[1]}` : '';
    const rows = [{ ...data.me, me: true }, ...(data.friends || [])];
    rows.sort((a, b) => (b.weekReviews || 0) - (a.weekReviews || 0) || (b.weekDays || 0) - (a.weekDays || 0));
    const max = Math.max(1, ...rows.map(r => r.weekReviews || 0));
    const list = $('list'); list.innerHTML = '';
    let rank = 0;
    for (const r of rows) {
      rank++;
      const el = document.createElement('div');
      el.className = 'row' + (r.me ? ' me' : '') + (r.online ? ' on' : '');
      el.innerHTML = `<div class="rk">${rank}</div><img class="ic" alt=""><div class="nm">${esc(r.name || r.code)}${r.me ? ' <span class="you">you</span>' : ''}</div>
        <div class="bar"><div style="width:${Math.round((r.weekReviews || 0) / max * 100)}%"></div></div>
        <div class="num">${(r.weekReviews || 0).toLocaleString()} cards</div><div class="days">${r.weekDays || 0}/7 days</div>`;
      list.appendChild(el);
      this.icon(r.species || 'wild', r.costume || 'none').then(u => { if (u) el.querySelector('.ic').src = u; });
    }
    $('empty').hidden = rows.length > 1;
  }
}
new Race().init();
