/**
 * Fix R32 order=15: propagation put Rekha Kumari into R16 order=8 (Side A)
 * because the planned slot has Rekha as Side A and winner=a, but the
 * history record has Sarla Mutreja as Side A with winner=a — meaning
 * Sarla actually won.
 *
 * This script:
 *   1. Confirms the discrepancy by printing current state
 *   2. Patches R16 order=8: swaps Rekha → Sarla Mutreja on Side A
 *   3. Also patches QF order=4 Side B if it currently has Rekha/Debajani wrong
 *
 * Run with --dry-run first to preview.
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

const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid, v]) => ({ mid, ...v }));
const history = Object.entries(histSnap.val() ?? {}).map(([id, v]) => ({ id, ...v }));
const playerIdByName = new Map(
  Object.entries(playersSnap.val() ?? {}).map(([id, p]) => [p?.canonicalName?.trim().toLowerCase(), id])
);
const rid = name => playerIdByName.get(name?.trim().toLowerCase()) ?? null;

// ── Diagnose R32 order=15 ─────────────────────────────────────────────────────
const r32_15_planned = planned.find(m => m.round === 'G1 — R32' && m.matchOrder === 15);
const r32_15_hist = history.find(h => {
  const names = [h.aName, h.bName].map(n => n?.trim().toLowerCase());
  return h.round === 'G1 — R32' &&
    (names.includes('rekha kumari') || names.includes('sarla mutreja'));
});

console.log('R32 order=15 planned:', r32_15_planned
  ? `aName="${r32_15_planned.aName}" bName="${r32_15_planned.bName}" result.winner=${r32_15_planned.result?.winner}`
  : 'NOT FOUND');
console.log('R32 order=15 history:', r32_15_hist
  ? `aName="${r32_15_hist.aName}" bName="${r32_15_hist.bName}" result.winner=${r32_15_hist.result?.winner}`
  : 'NOT FOUND');

// Determine true winner from history (ground truth)
let trueWinner = null;
if (r32_15_hist) {
  trueWinner = r32_15_hist.result?.winner === 'a' ? r32_15_hist.aName : r32_15_hist.bName;
  console.log(`\nTrue R32-15 winner (from history): "${trueWinner}"`);
} else {
  console.log('\nNo history record found — cannot determine true winner. Aborting.');
  process.exit(1);
}

// ── Fix R16 order=8 ───────────────────────────────────────────────────────────
const r16_8 = planned.find(m => m.round === 'G1 — R16' && m.matchOrder === 8);
if (!r16_8) { console.log('R16 order=8 planned slot NOT FOUND'); process.exit(1); }

console.log(`\nR16 order=8 current: aName="${r16_8.aName}" bName="${r16_8.bName}" result.winner=${r16_8.result?.winner ?? 'none'}`);

// R16 order=8: ceil(15/2)=8, matchOrder=15 is odd → winner goes to Side A
// Winner should be trueWinner (from R32-15 history)
// R16 order=8 Side B comes from R32 order=16 winner = Debajani Tamuly (confirmed)
const correctA = trueWinner;
const correctB = 'Debajani Tamuly'; // R32 order=16 winner (already confirmed correct)

const patches = [];

if (r16_8.aName !== correctA) {
  // Debajani Tamuly won R16-8 (history winner=a, she was Side A).
  // After swap: Sarla→Side A, Debajani→Side B, so winner must flip to 'b'.
  const currentWinner = r16_8.result?.winner; // 'a' = Debajani (old Side A)
  const newWinner = currentWinner === 'a' ? 'b' : currentWinner === 'b' ? 'a' : currentWinner;
  const patch = {
    aName: correctA,
    aResolvedId: rid(correctA),
    bName: correctB,
    bResolvedId: rid(correctB),
  };
  if (currentWinner) {
    patch['result'] = { ...r16_8.result, winner: newWinner };
  }
  console.log(`\nPatch R16 order=8 (${r16_8.mid}):`);
  console.log(`  aName: "${r16_8.aName}" → "${correctA}"`);
  console.log(`  aResolvedId: ${r16_8.aResolvedId} → ${rid(correctA)}`);
  console.log(`  bName: "${r16_8.bName}" → "${correctB}"`);
  console.log(`  bResolvedId: ${r16_8.bResolvedId} → ${rid(correctB)}`);
  console.log(`  result.winner: "${currentWinner}" → "${newWinner}" (Debajani still wins, now Side B)`);
  patches.push({ mid: r16_8.mid, patch });
} else {
  console.log(`\nR16 order=8 aName already correct ("${correctA}") — no patch needed.`);
}

// ── Fix QF order=4 if it has wrong Side B (should be Debajani Tamuly) ─────────
const qf4 = planned.find(m => m.round === 'G1 — QF' && m.matchOrder === 4);
if (qf4) {
  console.log(`\nQF order=4 current: aName="${qf4.aName}" bName="${qf4.bName}"`);
  // QF order=4: ceil(7/2)=4 side A from R16-7 winner (L Jyothi), ceil(8/2)=4 side B from R16-8 winner
  // R16-8 winner = Debajani Tamuly (history winner=a, Debajani is side A)
  const qfCorrectB = 'Debajani Tamuly';
  if (qf4.bName !== qfCorrectB) {
    const patch = { bName: qfCorrectB, bResolvedId: rid(qfCorrectB) };
    console.log(`Patch QF order=4 (${qf4.mid}):`);
    console.log(`  bName: "${qf4.bName}" → "${qfCorrectB}"`);
    patches.push({ mid: qf4.mid, patch });
  } else {
    console.log(`QF order=4 bName already correct ("${qfCorrectB}") — no patch needed.`);
  }
}

if (patches.length === 0) {
  console.log('\nNothing to patch.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log('\n[DRY RUN — no writes made]');
  process.exit(0);
}

for (const { mid, patch } of patches) {
  await db.ref('planned/' + mid).update(patch);
  console.log(`Patched ${mid}`);
}
console.log('\nDone.');
process.exit(0);
