/**
 * Fix R16 planned slots using R32 history as ground truth.
 *
 * Problem: propagateBracketWinner used the planned slot's side ordering to
 * determine the winner, but many R32 history records have sides swapped vs
 * the planned slot. This caused the wrong player (the loser) to be propagated
 * into R16.
 *
 * Fix: for each R32 history match, determine the true winner and patch the
 * corresponding R16 planned slot's aName/bName/resolvedId. Also flip
 * result.winner on any R16 slot whose result is now on the wrong side.
 *
 * R16 pairings: R32 match orders 1+2 → R16-1, 3+4 → R16-2, ..., 15+16 → R16-8
 *   Within each pair: odd R32 order → Side A of R16, even → Side B
 *
 * Run: node scripts/fix-r16-from-r32-history.mjs [--dry-run]
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

const r32p = planned.filter(m => m.round==='G1 — R32').sort((a,b)=>(a.matchOrder??0)-(b.matchOrder??0));
const r32h = history.filter(h => h.round==='G1 — R32');
const r16p = planned.filter(m => m.round==='G1 — R16').sort((a,b)=>(a.matchOrder??0)-(b.matchOrder??0));

// Build: R32 matchOrder → true winner name (from history, ground truth)
const r32TrueWinner = new Map(); // matchOrder → winnerName
for (const p of r32p) {
  const h = r32h.find(h => {
    const pa = p.aName?.trim().toLowerCase(), pb = p.bName?.trim().toLowerCase();
    const ha = (h.aName??'').trim().toLowerCase(), hb = (h.bName??'').trim().toLowerCase();
    return (ha===pa&&hb===pb)||(ha===pb&&hb===pa);
  });
  if (h) {
    const winner = h.result?.winner === 'a' ? h.aName : h.bName;
    r32TrueWinner.set(p.matchOrder, winner);
  } else if (p.result?.winner) {
    // No history — use planned result (R32-1 Rashmi vs Dummy, R32-2, R32-14, R32-16)
    const winner = p.result.winner === 'a' ? p.aName : p.bName;
    r32TrueWinner.set(p.matchOrder, winner);
  }
}

console.log('R32 true winners:');
for (const [o,w] of [...r32TrueWinner.entries()].sort((a,b)=>a[0]-b[0])) {
  console.log(`  R32-${o}: ${w}`);
}

// Build expected R16 slots: R16 order N gets winner of R32-(2N-1) as Side A, winner of R32-(2N) as Side B
const patches = [];
console.log('\nR16 analysis:');
for (const r16 of r16p) {
  const n = r16.matchOrder;
  const expectedA = r32TrueWinner.get(2*n - 1);
  const expectedB = r32TrueWinner.get(2*n);
  const currentA = r16.aName, currentB = r16.bName;
  const currentWinner = r16.result?.winner; // 'a'|'b'|undefined

  const aWrong = expectedA && currentA !== expectedA;
  const bWrong = expectedB && currentB !== expectedB;

  if (!aWrong && !bWrong) {
    console.log(`  R16-${n}: OK (${currentA} vs ${currentB})`);
    continue;
  }

  const patch = {};
  if (aWrong) { patch.aName = expectedA; patch.aResolvedId = rid(expectedA); }
  if (bWrong) { patch.bName = expectedB; patch.bResolvedId = rid(expectedB); }

  // If R16 result exists, check if the winner side needs flipping.
  // The result points to whoever actually won the match that was played.
  // We find their name in the current slot and re-map to the new side.
  if (currentWinner === 'a' || currentWinner === 'b') {
    const winnerName = currentWinner === 'a' ? currentA : currentB;
    const newA = patch.aName ?? currentA;
    const newB = patch.bName ?? currentB;
    let newWinnerSide;
    if (winnerName?.trim().toLowerCase() === newA?.trim().toLowerCase()) newWinnerSide = 'a';
    else if (winnerName?.trim().toLowerCase() === newB?.trim().toLowerCase()) newWinnerSide = 'b';
    else newWinnerSide = currentWinner; // can't remap — keep as-is
    if (newWinnerSide !== currentWinner) {
      patch.result = { ...r16.result, winner: newWinnerSide };
      console.log(`  R16-${n}: fix sides + flip result.winner ${currentWinner}→${newWinnerSide} (${winnerName} still wins)`);
    } else {
      console.log(`  R16-${n}: fix sides, result.winner stays ${currentWinner}`);
    }
  } else {
    console.log(`  R16-${n}: fix sides (no result yet)`);
  }

  if (aWrong) console.log(`    aName: "${currentA}" → "${expectedA}"`);
  if (bWrong) console.log(`    bName: "${currentB}" → "${expectedB}"`);

  patches.push({ mid: r16.mid, patch });
}

if (patches.length === 0) {
  console.log('\nAll R16 slots correct — nothing to patch.');
  process.exit(0);
}

if (DRY_RUN) {
  console.log(`\n[DRY RUN — ${patches.length} slot(s) would be patched]`);
  process.exit(0);
}

for (const { mid, patch } of patches) {
  await db.ref('planned/' + mid).update(patch);
  console.log(`Patched ${mid}`);
}
console.log(`\nDone. ${patches.length} slot(s) patched.`);
process.exit(0);
