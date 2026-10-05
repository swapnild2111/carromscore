/**
 * Fix R16 history (matches) records that still carry wrong player names.
 *
 * These 4 history records were created when the wrong players were in the
 * bracket draw. The planned slots are now correct; this patches the history
 * records to match so the SVG report renders the right names.
 *
 * Ground truth: planned slots (already fixed by fix-r16-from-r32-history.mjs)
 *
 * Run: node scripts/fix-r16-history.mjs [--dry-run]
 */
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const DRY_RUN = process.argv.includes('--dry-run');
const TOURNAMENT = 'inter-ministry-carrom-tournament-2026-27';

initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();

const [plannedSnap, histSnap, playersSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo(TOURNAMENT).once('value'),
  db.ref('matches').orderByChild('tournamentKey').equalTo(TOURNAMENT).once('value'),
  db.ref('players').once('value'),
]);

const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid,v]) => ({mid,...v}));
const history = Object.entries(histSnap.val() ?? {}).map(([id,v]) => ({id,...v}));
const playerIdByName = new Map(
  Object.entries(playersSnap.val() ?? {}).map(([id,p]) => [p?.canonicalName?.trim().toLowerCase(), id])
);
const rid = name => playerIdByName.get(name?.trim().toLowerCase()) ?? null;

const r16p = planned.filter(m => m.round==='G1 — R16').sort((a,b)=>(a.matchOrder??0)-(b.matchOrder??0));
const r16h = history.filter(h => h.round==='G1 — R16');

// R16-2: history has "Vineeta Sachdeva vs Parul" winner=a (Vineeta)
//   but actual match was Parul vs Shreshtha Saurabh, Shreshtha won (winner=b of planned)
//   History winner=a=Vineeta, planned winner=b=Shreshtha → loser of history = Parul
//   Correct: aName→Parul, bName→Shreshtha, winner stays a (Parul's slot) -- NO
//   Actually: planned aName=Parul, bName=Shreshtha, winner=b → Shreshtha won
//   History: aName=Vineeta, bName=Parul, winner=a → Vineeta won (wrong)
//   Fix: rename history to aName=Parul, bName=Shreshtha, winner=b
// R16-4: history has "B C Rymbai vs Vaishali Gupta" winner=b (Vaishali)
//   planned: aName=Neetu Gupta, bName=Nivedhita, winner=b → Nivedhita won
//   Fix: rename history to aName=Neetu Gupta, bName=Nivedhita, winner=b
const EXPLICIT_FIXES = [
  {
    histId: '-P30yW2Or2sF1LMfjOcA', // "Vineeta Sachdeva vs Parul" winner=a
    newA: 'Parul', newB: 'Shreshtha Saurabh', newWinner: 'b',
    label: 'R16-2',
  },
  {
    histId: '-P30zWppu0EWZi9fj_u6', // "B C Rymbai vs Vaishali Gupta" winner=b
    newA: 'Neetu Gupta', newB: 'Nivedhita', newWinner: 'b',
    label: 'R16-4',
  },
];

// For each planned R16 slot, find any history record that doesn't match
// by name but matches by the actual winner (since winner is ground truth).
// Planned slots are now correct — use them as the source of truth for names.
const patches = [];

for (const p of r16p) {
  const pA = p.aName?.trim().toLowerCase();
  const pB = p.bName?.trim().toLowerCase();

  // Check if there's already a correctly-named history record
  const exactMatch = r16h.find(h => {
    const hA = (h.aName??'').trim().toLowerCase();
    const hB = (h.bName??'').trim().toLowerCase();
    return (hA===pA&&hB===pB)||(hA===pB&&hB===pA);
  });
  if (exactMatch) continue; // already correct

  // Find the history record that was played for this slot — match by the winner
  // name since that's stable. The planned result.winner tells us who won.
  if (!p.result?.winner) continue; // no result yet, nothing to fix
  const planWinnerName = p.result.winner === 'a' ? p.aName : p.bName;

  // Find a history record in R16 whose winner matches planWinnerName and
  // isn't already matched to another planned slot
  const alreadyMatched = new Set(
    r16p.flatMap(pp => {
      const ppA = pp.aName?.trim().toLowerCase(), ppB = pp.bName?.trim().toLowerCase();
      return r16h.filter(h => {
        const hA = (h.aName??'').trim().toLowerCase(), hB = (h.bName??'').trim().toLowerCase();
        return (hA===ppA&&hB===ppB)||(hA===ppB&&hB===ppA);
      }).map(h => h.id);
    })
  );

  const histRec = r16h.find(h => {
    if (alreadyMatched.has(h.id)) return false;
    const hw = h.result?.winner === 'a' ? h.aName : h.bName;
    return hw?.trim().toLowerCase() === planWinnerName?.trim().toLowerCase();
  });

  if (!histRec) {
    console.log(`R16-${p.matchOrder}: no matching history record found for winner="${planWinnerName}" — skipping`);
    continue;
  }

  // Determine correct aName/bName for the history record.
  // The planned slot is now authoritative. Map history sides to planned sides
  // by matching the winner name.
  const histWinnerIsA = histRec.result?.winner === 'a';
  const planWinnerIsA = p.result.winner === 'a';

  let newA, newB;
  if (histWinnerIsA === planWinnerIsA) {
    // Same winner side — direct mapping
    newA = p.aName;
    newB = p.bName;
  } else {
    // Winner is on different side — swap
    newA = p.bName;
    newB = p.aName;
  }

  const patch = {};
  let changed = false;
  if (histRec.aName !== newA) { patch.aName = newA; changed = true; }
  if (histRec.bName !== newB) { patch.bName = newB; changed = true; }
  // Also fix aId/bId if present
  if (changed) {
    const newAId = rid(newA);
    const newBId = rid(newB);
    if (newAId) patch.aId = newAId;
    if (newBId) patch.bId = newBId;
  }

  if (!changed) continue;

  console.log(`R16-${p.matchOrder} history (${histRec.id}):`);
  if (patch.aName) console.log(`  aName: "${histRec.aName}" → "${patch.aName}"`);
  if (patch.bName) console.log(`  bName: "${histRec.bName}" → "${patch.bName}"`);
  patches.push({ id: histRec.id, patch });
}

// Apply explicit fixes for records where the winner name itself changed
for (const fix of EXPLICIT_FIXES) {
  const h = r16h.find(h => h.id === fix.histId);
  if (!h) { console.log(`${fix.label}: history id ${fix.histId} not found — skipping`); continue; }
  const patch = {};
  if (h.aName !== fix.newA) { patch.aName = fix.newA; const id = rid(fix.newA); if (id) patch.aId = id; }
  if (h.bName !== fix.newB) { patch.bName = fix.newB; const id = rid(fix.newB); if (id) patch.bId = id; }
  if (h.result?.winner !== fix.newWinner) patch.result = { ...h.result, winner: fix.newWinner };
  if (Object.keys(patch).length === 0) { console.log(`${fix.label}: already correct`); continue; }
  console.log(`${fix.label} history (${fix.histId}):`);
  if (patch.aName) console.log(`  aName: "${h.aName}" → "${patch.aName}"`);
  if (patch.bName) console.log(`  bName: "${h.bName}" → "${patch.bName}"`);
  if (patch.result) console.log(`  result.winner: "${h.result?.winner}" → "${fix.newWinner}"`);
  patches.push({ id: fix.histId, patch });
}

if (patches.length === 0) {
  console.log('All R16 history records already correct — nothing to patch.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`\n[DRY RUN — ${patches.length} history record(s) would be patched]`);
  process.exit(0);
}

for (const { id, patch } of patches) {
  await db.ref('matches/' + id).update(patch);
  console.log(`Patched matches/${id}`);
}
console.log(`\nDone. ${patches.length} record(s) patched.`);
process.exit(0);
