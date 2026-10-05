import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const DRY_RUN = process.argv.includes('--dry-run');
const TOURNAMENT = 'inter-ministry-carrom-tournament-2026-27';

initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();

const [plannedSnap, playersSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo(TOURNAMENT).once('value'),
  db.ref('players').once('value'),
]);

const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid,v]) => ({mid,...v}));
const playerIdByName = new Map(Object.entries(playersSnap.val() ?? {}).map(([id,p]) =>
  [p?.canonicalName?.trim().toLowerCase(), id]
));
const rid = name => playerIdByName.get(name.trim().toLowerCase()) ?? null;

const r16Planned = planned.filter(m => m.round==='G1 — R16').sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));

// Correct R16 state derived from actual history records:
// order → { aName, bName, winner, setsA, setsB }
const corrections = {
  2: { aName: 'Parul',              bName: 'Vineeta Sachdeva',  winner: 'b', setsA: 2, setsB: 0 }, // Vineeta won (she was hist side 'a' with 2-0, but planned has her as 'b')
  3: { aName: 'Veena Sharma',       bName: 'Sheetal Sharma',    winner: 'b', setsA: 0, setsB: 2 }, // Sheetal won
  4: { aName: 'B C Rymbai',         bName: 'Vaishali Gupta',    winner: 'b', setsA: 0, setsB: 2 }, // Vaishali won
  5: { aName: 'Gayatri Chatterjee', bName: 'Vandana',           winner: 'a', setsA: 2, setsB: 0 }, // Gayatri won
  6: { aName: 'Anu Sood',           bName: 'Mingma Doma',       winner: 'a', setsA: 2, setsB: 0 }, // Anu Sood won
  7: { aName: 'Honey Koli',         bName: 'L Jyothi',          winner: 'b', setsA: 0, setsB: 2 }, // L Jyothi won
  8: { aName: 'Debajani Tamuly',    bName: 'Rekha Kumari',      winner: 'a', setsA: 2, setsB: 0 }, // Debajani won
};

const patches = [];
for (const m of r16Planned) {
  const c = corrections[m.matchOrder];
  if (!c) continue;
  const patch = {};
  if (m.aName !== c.aName || m.aResolvedId !== rid(c.aName)) {
    patch.aName = c.aName; patch.aResolvedId = rid(c.aName);
  }
  if (m.bName !== c.bName || m.bResolvedId !== rid(c.bName)) {
    patch.bName = c.bName; patch.bResolvedId = rid(c.bName);
  }
  if (!m.result?.winner) {
    patch.result = { winner: c.winner, setsA: c.setsA, setsB: c.setsB };
  }
  if (Object.keys(patch).length) {
    console.log('R16 order='+m.matchOrder+': patch', JSON.stringify(patch));
    patches.push({ mid: m.mid, patch });
  } else {
    console.log('R16 order='+m.matchOrder+': OK');
  }
}

if (DRY_RUN || patches.length === 0) { console.log(DRY_RUN ? '\n[DRY RUN]' : '\nNothing to patch.'); process.exit(0); }

for (const { mid, patch } of patches) {
  await db.ref('planned/'+mid).update(patch);
  console.log('Patched', mid);
}
console.log('\nDone.');
process.exit(0);
