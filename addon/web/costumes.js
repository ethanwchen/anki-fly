// Fly Wardrobe: costume picker window. Mirrors exam.js: pycmd bridge to Python, dev mode when opened in a browser.
//   Python -> page:  window.wardrobe.load(name)          (currently equipped costume)
//   page -> Python:  pycmd('costume:ready'), pycmd('costume:set:' + name), pycmd('costume:close')
import { unlocked, requirement } from './unlocks.js';
const $ = (id) => document.getElementById(id);
const hasPy = () => typeof window.pycmd === 'function';
const py = (msg) => { if (hasPy()) window.pycmd(msg); else console.log('[pycmd]', msg); };

const LABELS = {
  none: ['-', 'Nothing'], sunglasses: ['😎', 'Sunglasses'], monocle: ['🧐', 'Monocle'], tophat: ['🎩', 'Top hat'], catears: ['🐱', 'Cat ears'],
  bunnyears: ['🐰', 'Bunny ears'], partyhat: ['🥳', 'Party hat'], crown: ['👑', 'Crown'], wizard: ['🧙', 'Wizard hat'], santa: ['🎅', 'Santa hat'],
  pirate: ['🏴‍☠️', 'Pirate'], halo: ['😇', 'Halo'], devil: ['😈', 'Devil horns'], viking: ['⚔️', 'Viking helm'], chef: ['👨‍🍳', 'Chef toque'],
  graduate: ['🎓', 'Grad cap'], headphones: ['🎧', 'Headphones'], bow: ['🎀', 'Bow'], flowers: ['🌸', 'Flower crown'], cowboy: ['🤠', 'Cowboy hat'],
  beret: ['🎨', 'Beret'], alien: ['👽', 'Alien boppers'], scarf: ['🧣', 'Scarf'], propeller: ['🚁', 'Propeller cap'],
};

class Wardrobe {
  async init() {
    let mod;
    try { if (!window.THREE) throw new Error('no three'); mod = await import('./fly3d.js'); } catch { mod = await import('./fly_sprite.js'); }
    this.sprite = new mod.FlySprite($('fly'));
    this.names = (mod.FlySprite.costumes || ['none']);
    if (this.sprite.setScene) { this.sprite.setScene('study'); this.sprite.setState('study'); } else this.sprite.setState('idle');
    window.addEventListener('resize', () => this.sprite.resize());
    const grid = $('grid');
    this.tiles = {};
    for (const n of this.names) {
      const [ic, nm] = LABELS[n] || ['🎁', n];
      const t = document.createElement('div'); t.className = 'tile'; t.innerHTML = `<div class="ic">${ic}</div><div class="nm">${nm}</div>`;
      t.onclick = () => this.pick(n, true); grid.appendChild(t); this.tiles[n] = t;
    }
    $('close').onclick = () => py('costume:close');
    this.pick(localStorage.getItem('flyCostume') || 'none', false);
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    const announce = () => { if (hasPy()) py('costume:ready'); else setTimeout(announce, 100); };
    announce();
  }
  load(name, stats) {
    if (stats) { this.stats = stats; for (const n of this.names) { const ok = unlocked(n, stats); this.tiles[n].classList.toggle('locked', !ok); this.tiles[n].title = ok ? '' : 'unlock: ' + requirement(n); } }
    this.pick(name || 'none', false);
  }
  pick(name, send) {
    if (!this.names.includes(name)) name = 'none';
    if (this.stats && !unlocked(name, this.stats)) { $('cur').textContent = `locked: ${requirement(name)}`; return; }
    if (this.sprite.setCostume) this.sprite.setCostume(name);
    for (const k in this.tiles) this.tiles[k].classList.toggle('sel', k === name);
    $('cur').textContent = (LABELS[name] || [0, name])[1].toLowerCase();
    try { localStorage.setItem('flyCostume', name); } catch {}
    if (send) py('costume:set:' + name);
  }
  frame(now) {
    const dt = Math.min(60, now - this.last); this.last = now;
    this.sprite.update(dt); this.sprite.draw();
    requestAnimationFrame((t) => this.frame(t));
  }
}
const wardrobe = new Wardrobe();
window.wardrobe = wardrobe;
wardrobe.init().catch(e => { $('sub').textContent = 'failed: ' + e.message; console.error(e); });
