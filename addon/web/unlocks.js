// Costume unlock rules, shared by the widget (fly.js) and the Wardrobe window (costumes.js).
// stats = { cards, days, bestExam, crashouts }
export const UNLOCKS = [
  { id: 'none', req: '' }, { id: 'bow', req: '' }, { id: 'beret', req: '' }, { id: 'scarf', req: '' },
  { id: 'sunglasses', cards: 100, req: '100 cards' }, { id: 'headphones', cards: 200, req: '200 cards' },
  { id: 'catears', cards: 300, req: '300 cards' }, { id: 'bunnyears', cards: 400, req: '400 cards' },
  { id: 'flowers', cards: 500, req: '500 cards' }, { id: 'cowboy', cards: 700, req: '700 cards' },
  { id: 'monocle', cards: 900, req: '900 cards' }, { id: 'chef', cards: 1200, req: '1,200 cards' },
  { id: 'pirate', cards: 1500, req: '1,500 cards' }, { id: 'crown', cards: 2000, req: '2,000 cards' },
  { id: 'viking', cards: 3000, req: '3,000 cards' }, { id: 'alien', cards: 4000, req: '4,000 cards' },
  { id: 'partyhat', days: 7, req: '7 study days' }, { id: 'propeller', days: 14, req: '14 study days' },
  { id: 'tophat', days: 30, req: '30 study days' }, { id: 'wizard', days: 60, req: '60 study days' },
  { id: 'halo', days: 100, req: '100 study days' },
  { id: 'graduate', exam: 0.9, req: 'an exam at 90%' },
  { id: 'devil', crashouts: 5, req: '5 crashouts (7 Agains in a row)' },
  { id: 'santa', month: 12, req: 'December' },
];

export function unlocked(id, st) {
  const u = UNLOCKS.find(x => x.id === id);
  if (!u) return false;
  if (u.cards && (st.cards || 0) < u.cards) return false;
  if (u.days && (st.days || 0) < u.days) return false;
  if (u.exam && (st.bestExam || 0) < u.exam) return false;
  if (u.crashouts && (st.crashouts || 0) < u.crashouts) return false;
  if (u.month && new Date().getMonth() + 1 !== u.month) return false;
  return true;
}

export const requirement = (id) => (UNLOCKS.find(x => x.id === id) || {}).req || '';
