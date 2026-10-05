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
const r16p = planned.filter(m => m.round==='G1 — R16').sort((a,b)=>(a.matchOrder??0)-(b.matchOrder??0));
const r16h = history.filter(h => h.round==='G1 — R16');

console.log('R16 history records (raw):');
for (const h of r16h.sort((a,b) => (a.aName??'').localeCompare(b.aName??''))) {
  console.log(`  hist: "${h.aName}" vs "${h.bName}" winner=${h.result?.winner} id=${h.id}`);
}

console.log('\nR16 planned vs history match:');
for (const p of r16p) {
  const h = r16h.find(h => {
    const pa = p.aName?.trim().toLowerCase(), pb = p.bName?.trim().toLowerCase();
    const ha = (h.aName??'').trim().toLowerCase(), hb = (h.bName??'').trim().toLowerCase();
    return (ha===pa&&hb===pb)||(ha===pb&&hb===pa);
  });
  const planWinner = p.result?.winner === 'a' ? p.aName : p.result?.winner === 'b' ? p.bName : 'none';
  const histWinner = h ? (h.result?.winner === 'a' ? h.aName : h.bName) : 'NO_HIST';
  const matched = h ? 'matched' : 'UNMATCHED';
  console.log(`  R16-${p.matchOrder} planned:(${p.aName} vs ${p.bName}) planWinner=${planWinner} | hist:(${h?.aName??'-'} vs ${h?.bName??'-'}) histWinner=${histWinner} [${matched}]`);
}
process.exit(0);
