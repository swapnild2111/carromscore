import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();
const histSnap = await db.ref('matches').orderByChild('tournamentKey').equalTo('inter-ministry-carrom-tournament-2026-27').once('value');
const history = Object.entries(histSnap.val() ?? {}).map(([id,v]) => ({id,...v}));

for (const round of ['G1 — R32', 'G1 — R16']) {
  const rh = history.filter(h => h.round === round);
  // Simulate buildReportRows sort: endedAt DESC
  rh.sort((a,b) => (b.endedAt??0) - (a.endedAt??0));
  console.log(`\n${round} after endedAt DESC sort (what buildReportRows produces):`);
  rh.forEach((h,i) => {
    console.log(`  idx=${i} matchOrder=${h.matchOrder??'null'} endedAt=${h.endedAt} | ${h.aName} vs ${h.bName}`);
  });

  // Then simulate groupNonGroupRounds re-sort by matchOrder (stable only if both non-null)
  const rows = rh.map(h => ({ sideA: h.aName, sideB: h.bName, matchOrder: h.matchOrder }));
  rows.sort((a,b) => a.matchOrder != null && b.matchOrder != null ? a.matchOrder - b.matchOrder : 0);
  console.log(`  After matchOrder re-sort (what SVG receives):`);
  rows.forEach((r,i) => console.log(`  idx=${i} matchOrder=${r.matchOrder??'null'} | ${r.sideA} vs ${r.sideB}`));
}
process.exit(0);
