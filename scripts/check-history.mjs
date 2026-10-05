import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();
const snap = await db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value');
const raw = snap.val();
if (!raw) { console.log('no history'); process.exit(0); }
const recs = Object.entries(raw).map(([id, v]) => ({ id, ...v }));
const qf = recs.filter(r => r.round?.includes('QF'));
console.log('History QF matches:');
for (const r of qf) {
  console.log(`  ${r.id}: ${r.aName} vs ${r.bName} → winner=${r.result?.winner} round="${r.round}"`);
}
const r16 = recs.filter(r => r.round?.includes('R16'));
console.log('\nHistory R16 matches:');
for (const r of r16.sort((a,b)=>(a.round??'').localeCompare(b.round??''))) {
  console.log(`  ${r.aName} vs ${r.bName} → winner=${r.result?.winner} round="${r.round}"`);
}
process.exit(0);
