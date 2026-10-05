/**
 * Fix R16 and QF planned names by:
 * 1. Matching each planned R16 slot to its history record by player names
 * 2. Extracting the actual winner
 * 3. Patching R16 slots with the winner from R32 (via R32 history)
 * 4. Patching QF slots with R16 winners
 *
 * The history records are the ground truth — they reflect who actually played.
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
const playerIdByName = new Map(Object.entries(playersSnap.val() ?? {}).map(([id, p]) => 
  [p?.canonicalName?.trim().toLowerCase(), id]
));

// For a history record, get { winnerName, winnerResolvedId }
function histWinner(h) {
  const name = h.result?.winner === 'a' ? h.aName : h.bName;
  return { name, resolvedId: playerIdByName.get(name?.trim().toLowerCase()) ?? null };
}

// Find history record matching a planned slot by player names (either order)
function findHist(histList, aName, bName) {
  const pa = aName.trim().toLowerCase(), pb = bName.trim().toLowerCase();
  return histList.find(h => {
    const ha = (h.aName??'').trim().toLowerCase(), hb = (h.bName??'').trim().toLowerCase();
    return (ha===pa && hb===pb) || (ha===pb && hb===pa);
  });
}

// ── Step 1: Build R16 planned order → winner, matched via R16 history ───────
const r16Planned = planned.filter(m => m.round==='G1 — R16').sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));
const r16Hist    = history.filter(h => h.round==='G1 — R16');

// For each planned R16 slot, find the actual history match by name.
// Planned slots may have placeholder names (G1 Winner N) — for those we can't name-match.
// Instead we try to match by the names that WERE played (from the history records)
// using a greedy approach: if planned has real names, name-match; otherwise skip for now.
const r16Winners = {}; // matchOrder → { name, resolvedId }
const unmatchedHist = [...r16Hist]; // consume as we match

for (const m of r16Planned) {
  const isPhA = /Winner \d+/i.test(m.aName), isPhB = /Winner \d+/i.test(m.bName);
  if (isPhA || isPhB) continue; // skip placeholder slots for now
  const h = findHist(unmatchedHist, m.aName, m.bName);
  if (h) {
    r16Winners[m.matchOrder] = histWinner(h);
    unmatchedHist.splice(unmatchedHist.indexOf(h), 1); // consume
  } else if (m.result?.winner) {
    // Planned has result (via propagateBracketWinner)
    const w = m.result.winner;
    const name = w==='a' ? m.aName : m.bName;
    const rid  = w==='a' ? (m.aResolvedId ?? playerIdByName.get(name?.trim().toLowerCase()))
                         : (m.bResolvedId ?? playerIdByName.get(name?.trim().toLowerCase()));
    r16Winners[m.matchOrder] = { name, resolvedId: rid ?? null };
  }
}

// Remaining unmatched history records → match to placeholder planned slots by position
const phSlots = r16Planned.filter(m => /Winner \d+/i.test(m.aName) || /Winner \d+/i.test(m.bName));
for (let i = 0; i < phSlots.length && unmatchedHist.length > 0; i++) {
  const h = unmatchedHist.shift();
  r16Winners[phSlots[i].matchOrder] = histWinner(h);
}

console.log('R16 winners by matchOrder:');
for (const [o, w] of Object.entries(r16Winners)) console.log(`  order=${o}: ${w.name}`);

// ── Step 2: Patch QF slots from R16 winners ───────────────────────────────────
console.log('\nQF patches:');
const qfPlanned = planned.filter(m => m.round==='G1 — QF').sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));
const patches = [];

for (const m of qfPlanned) {
  const correctA = r16Winners[m.matchOrder*2-1];
  const correctB = r16Winners[m.matchOrder*2];
  const patch = {};
  // Current effective names (resolvedId takes priority in display code)
  const curA = m.aName, curB = m.bName;
  if (correctA && (curA !== correctA.name || m.aResolvedId !== correctA.resolvedId)) {
    console.log(`  QF order=${m.matchOrder} A: "${curA}" → "${correctA.name}" (resolvedId: ${m.aResolvedId} → ${correctA.resolvedId})`);
    patch.aName = correctA.name;
    patch.aResolvedId = correctA.resolvedId;
  }
  if (correctB && (curB !== correctB.name || m.bResolvedId !== correctB.resolvedId)) {
    console.log(`  QF order=${m.matchOrder} B: "${curB}" → "${correctB.name}" (resolvedId: ${m.bResolvedId} → ${correctB.resolvedId})`);
    patch.bName = correctB.name;
    patch.bResolvedId = correctB.resolvedId;
  }
  if (Object.keys(patch).length) patches.push({ mid: m.mid, patch });
}

if (patches.length === 0) { console.log('  (none)'); }
if (DRY_RUN || patches.length === 0) { console.log(DRY_RUN ? '\n[DRY RUN]' : ''); process.exit(0); }

for (const { mid, patch } of patches) {
  await db.ref(`planned/${mid}`).update(patch);
  console.log(`Patched ${mid}`);
}
console.log('\nDone.');
process.exit(0);
