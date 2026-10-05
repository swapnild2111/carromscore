import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();
const [plannedSnap, histSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
  db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
]);
const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid, v]) => ({ mid, ...v }));
const history = Object.entries(histSnap.val() ?? {}).map(([id, v]) => ({ id, ...v }));

// Show all rounds with their current status
const rounds = ['G1 — R32', 'G1 — R16', 'G1 — QF', 'G1 — SF', 'G1 — Final'];
for (const round of rounds) {
  const pm = planned.filter(m => m.round === round).sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));
  const hm = history.filter(h => h.round === round);
  console.log(`\n${round} (${pm.length} planned, ${hm.length} history):`);
  for (const m of pm) {
    const hw = hm.find(h => {
      const an = (h.aName??'').trim().toLowerCase(); const bn = (h.bName??'').trim().toLowerCase();
      const pa = (m.aName??'').trim().toLowerCase(); const pb = (m.bName??'').trim().toLowerCase();
      return (an===pa&&bn===pb)||(an===pb&&bn===pa);
    });
    const w = m.result?.winner ?? (hw ? `hist:${hw.result?.winner}` : '');
    const done = m.completedAt ? '✓planned' : hw ? '✓hist' : '✗';
    console.log(`  order=${m.matchOrder} ${done} | ${m.aName} vs ${m.bName} | winner=${w||'none'}`);
  }
}
process.exit(0);
