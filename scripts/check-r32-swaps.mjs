import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();
const [plannedSnap, histSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
  db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value'),
]);
const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid,v]) => ({mid,...v}));
const history = Object.entries(histSnap.val() ?? {}).map(([id,v]) => ({id,...v}));
const r32p = planned.filter(m => m.round==='G1 — R32').sort((a,b)=>(a.matchOrder??0)-(b.matchOrder??0));
const r32h = history.filter(h => h.round==='G1 — R32');

for (const p of r32p) {
  const h = r32h.find(h => {
    const pa = p.aName?.trim().toLowerCase(), pb = p.bName?.trim().toLowerCase();
    const ha = (h.aName??'').trim().toLowerCase(), hb = (h.bName??'').trim().toLowerCase();
    return (ha===pa&&hb===pb)||(ha===pb&&hb===pa);
  });
  const plannedWinner = p.result?.winner === 'a' ? p.aName : p.result?.winner === 'b' ? p.bName : null;
  const histWinner = h ? (h.result?.winner === 'a' ? h.aName : h.bName) : 'NO_HIST';
  const swapped = h && (h.aName?.trim().toLowerCase() === p.bName?.trim().toLowerCase());
  const disagree = plannedWinner !== null && plannedWinner !== histWinner;
  const tag = swapped ? ' [sides_swapped]' : '';
  const dis = disagree ? ` *** DISAGREE planned_winner="${plannedWinner}"` : '';
  console.log(`R32-${p.matchOrder}: hist_winner="${histWinner}"${tag}${dis}`);
}
process.exit(0);
