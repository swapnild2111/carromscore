import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();
const snap = await db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value');
const all = Object.values(snap.val()??{});
console.log('=== R16 history ===');
all.filter(r=>r.round==='G1 — R16').forEach(r=>
  console.log(`  ${r.aName}(a) vs ${r.bName}(b) winner=${r.result?.winner} → WINNER: ${r.result?.winner==='a'?r.aName:r.bName}`)
);
process.exit(0);
