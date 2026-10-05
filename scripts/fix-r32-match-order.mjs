/**
 * Fix R32 history record for "Geeta Sarwan vs Vandana" which is missing matchOrder.
 * Planned order=10, so history matchOrder should be 10.
 * Without it, the record sorts last (idx=15 instead of 9), breaking all connectors
 * for matches 10–16.
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const DRY_RUN = process.argv.includes('--dry-run');
const TOURNAMENT = 'inter-ministry-carrom-tournament-2026-27';

initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();

const histSnap = await db.ref('matches').orderByChild('tournamentKey').equalTo(TOURNAMENT).once('value');
const history = Object.entries(histSnap.val() ?? {}).map(([id,v]) => ({id,...v}));

const r32h = history.filter(h => h.round === 'G1 — R32');

// Find all records missing matchOrder
const missing = r32h.filter(h => h.matchOrder == null);
console.log(`R32 history records missing matchOrder: ${missing.length}`);
for (const h of missing) {
  console.log(`  id=${h.id} "${h.aName}" vs "${h.bName}" winner=${h.result?.winner}`);
}

// Geeta Sarwan vs Vandana → planned order=10
const patches = [];
for (const h of missing) {
  const names = [h.aName?.trim().toLowerCase(), h.bName?.trim().toLowerCase()];
  if (names.includes('geeta sarwan') && names.includes('vandana')) {
    console.log(`\nPatching Geeta Sarwan vs Vandana: matchOrder → 10`);
    patches.push({ id: h.id, patch: { matchOrder: 10 } });
  } else {
    console.log(`\nUnknown record without matchOrder — manual investigation needed: ${h.aName} vs ${h.bName}`);
  }
}

if (patches.length === 0) { console.log('Nothing to patch.'); process.exit(0); }
if (DRY_RUN) { console.log('\n[DRY RUN]'); process.exit(0); }

for (const { id, patch } of patches) {
  await db.ref('matches/' + id).update(patch);
  console.log(`Patched matches/${id}`);
}
console.log('\nDone.');
process.exit(0);
