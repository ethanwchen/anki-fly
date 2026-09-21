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
    this.data = data;
    $('code').textContent = data.me.local ? 'just you for now' : (data.me.code || 'no code yet');
    $('code').title = data.me.local ? 'add a friends server in the add-on config to race friends' : 'your fly code';
    $('week').textContent = 'this week';
    $('add').textContent = data.me.local ? 'Race friends…' : 'Add a friend';
    const rows = [{ ...data.me, me: true }, ...(data.friends || [])];
    rows.sort((a, b) => (b.weekReviews || 0) - (a.weekReviews || 0) || (b.weekDays || 0) - (a.weekDays || 0));
    const max = Math.max(1, ...rows.map(r => r.weekReviews || 0));
    const list = $('list'); list.innerHTML = '';
    let rank = 0;
    for (const r of rows) {
      rank++;
      const el = document.createElement('div');
      el.className = 'row' + (r.me ? ' me' : '') + (r.online ? ' on' : '');
      const hidden = (v) => v == null;
      el.innerHTML = `<div class="rk">${rank}</div><img class="ic" alt="" title="profile"><div class="nm">${esc(r.name || r.code)}${r.team ? ` <span class="team">${esc(r.team)}</span>` : ''}${r.me ? ' <span class="you">you</span>' : ''}${r.level ? ` <span class="lv">Lv ${r.level}</span>` : ''}${r.raceWins ? ` <span class="wins" title="race wins">🏆 ${r.raceWins}</span>` : ''}</div>
        <div class="bar"><div style="width:${hidden(r.weekReviews) ? 0 : Math.round((r.weekReviews || 0) / max * 100)}%"></div></div>
        <div class="num">${hidden(r.weekReviews) ? '—' : (r.weekReviews || 0).toLocaleString() + ' cards'}</div><div class="days">${hidden(r.weekDays) ? '' : (r.weekDays || 0) + '/7 days'}</div>`;
      list.appendChild(el);
      el.querySelector('.ic').onclick = () => this.profile(r);
      el.querySelector('.nm').onclick = () => this.profile(r);
      this.icon(r.species || 'wild', r.costume || 'none').then(u => { if (u) el.querySelector('.ic').src = u; });
    }
    $('empty').hidden = rows.length > 1;
    $('empty').textContent = data.me.local ? 'Your fly races alone for now. Set up a friends server (Tools → Add-ons → Config) to race friends.' : "Add a friend's fly code to race them on cards reviewed this week.";
  }
  profile(r) {
    const box = $('profile'); box.hidden = false;
    const since = r.joinedAt ? new Date(r.joinedAt * 1000).toLocaleDateString() : '';
    const hide = new Set((this.data.me.hide) || []);
    const stat = (label, v) => `<div class="stat"><div class="k">${label}</div><div class="v">${v == null ? '—' : v}</div></div>`;
    box.innerHTML = `<div class="pf"><img class="pic" alt=""><div class="pt"><div class="pn">${esc(r.name || r.code)}${r.team ? ` <span class="team">${esc(r.team)}</span>` : ''}</div>
        <div class="ps">${r.me ? 'your fly' : (r.online ? 'studying right now' : 'offline')}${since ? ` · since ${since}` : ''} · code ${esc(r.code)}</div></div><button class="x" id="pclose">✕</button></div>
      <div class="stats">${stat('level', r.level ? `Lv ${r.level}` : null)}${stat('cards this week', r.weekReviews)}${stat('days this week', r.weekDays == null ? null : r.weekDays + '/7')}${stat('race wins', r.raceWins ?? null)}</div>
      ${r.me ? '' : `<div class="acts"><button id="premove">Remove friend</button></div>`}
      ${r.me ? `<div class="priv"><b>What friends can see</b>
        ${['level', 'weekly', 'days', 'team', 'online'].map(k => `<label><input type="checkbox" data-h="${k}" ${hide.has(k) ? '' : 'checked'}> ${{ level: 'my level', weekly: 'cards this week', days: 'days this week', team: 'my team tag', online: 'when I am online' }[k]}</label>`).join('')}</div>` : ''}`;
    $('pclose').onclick = () => { box.hidden = true; };
    const rm = $('premove');
    if (rm) rm.onclick = async () => {
      if (!confirm(`Remove ${r.name || r.code} from your friends?`)) return;
      const d = await ask('remove:' + r.code);
      box.hidden = true;
      if (d) { this.data = d; }
      await this.refresh();
    };
    this.icon(r.species || 'wild', r.costume || 'none').then(u => { const im = box.querySelector('.pic'); if (u && im) im.src = u; });
    box.querySelectorAll('input[data-h]').forEach(cb => cb.onchange = async () => {
      const hidden = [...box.querySelectorAll('input[data-h]')].filter(c => !c.checked).map(c => c.dataset.h);
      const d = await ask('hide:' + hidden.join(',')); if (d) { this.data = d; }
    });
  }
}
new Race().init();
