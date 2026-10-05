import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
const DRY_RUN = process.argv.includes('--dry-run');
const TOURNAMENT = 'inter-ministry-carrom-tournament-2026-27';
initializeApp({ credential: applicationDefault(), databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com' });
const db = getDatabase();

// Get all players to build name → id map
const [plannedSnap, playersSnap] = await Promise.all([
  db.ref('planned').orderByChild('tournamentKey').equalTo(TOURNAMENT).once('value'),
  db.ref('players').once('value'),
]);
const planned = Object.entries(plannedSnap.val() ?? {}).map(([mid, v]) => ({ mid, ...v }));
const playersByName = new Map();
for (const [id, p] of Object.entries(playersSnap.val() ?? {})) {
  if (p?.canonicalName) playersByName.set(p.canonicalName.trim().toLowerCase(), id);
}

// R16 planned — only slots with real names + result
const r16 = planned.filter(m => m.round === 'G1 — R16').sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));
const r16Winners = {}; // matchOrder → { name, resolvedId }
for (const m of r16) {
  const isPlaceholder = (n) => /Winner \d+|Finalist \d+/i.test(n ?? '');
  if (isPlaceholder(m.aName) || isPlaceholder(m.bName)) continue;
  const w = m.result?.winner;
  if (!w) continue;
  const winnerName = w === 'a' ? m.aName : m.bName;
  const winnerResolvedId = w === 'a' ? m.aResolvedId : m.bResolvedId;
  r16Winners[m.matchOrder] = { name: winnerName, resolvedId: winnerResolvedId };
}

const qf = planned.filter(m => m.round === 'G1 — QF').sort((a,b) => (a.matchOrder??0)-(b.matchOrder??0));
const patches = [];
for (const m of qf) {
  const correctA = r16Winners[m.matchOrder * 2 - 1];
  const correctB = r16Winners[m.matchOrder * 2];
  const patch = {};

  if (correctA) {
    // Check if aResolvedId points to wrong player OR aName is wrong
    const currentAResolved = m.aResolvedId;
    const wrongResolved = correctA.resolvedId && currentAResolved && currentAResolved !== correctA.resolvedId;
    const wrongName = m.aName !== correctA.name;
    if (wrongName || wrongResolved) {
      console.log(`QF order=${m.matchOrder} A: name="${m.aName}"(resolvedId=${m.aResolvedId}) → "${correctA.name}"(${correctA.resolvedId})`);
      patch.aName = correctA.name;
      if (correctA.resolvedId) patch.aResolvedId = correctA.resolvedId;
      else patch.aResolvedId = null; // remove wrong resolvedId
    }
  }
  if (correctB) {
    const currentBResolved = m.bResolvedId;
    const wrongResolved = correctB.resolvedId && currentBResolved && currentBResolved !== correctB.resolvedId;
    const wrongName = m.bName !== correctB.name;
    if (wrongName || wrongResolved) {
      console.log(`QF order=${m.matchOrder} B: name="${m.bName}"(resolvedId=${m.bResolvedId}) → "${correctB.name}"(${correctB.resolvedId})`);
      patch.bName = correctB.name;
      if (correctB.resolvedId) patch.bResolvedId = correctB.resolvedId;
      else patch.bResolvedId = null;
    }
  }
  if (Object.keys(patch).length > 0) patches.push({ mid: m.mid, patch });
}

if (patches.length === 0) { console.log('No fixes needed.'); process.exit(0); }
if (DRY_RUN) { console.log('\n[DRY RUN]'); process.exit(0); }

for (const { mid, patch } of patches) {
  // Firebase admin doesn't support null to delete — use explicit remove
  const update = {};
  for (const [k, v] of Object.entries(patch)) {
    update[k] = v === null ? null : v;
  }
  await db.ref(`planned/${mid}`).update(update);
  console.log(`Patched ${mid}:`, update);
}
console.log('Done.');
process.exit(0);
