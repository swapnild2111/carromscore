/**
 * Backfill completedAt + result on planned slots where the match is already
 * in history but the slot was never stamped (e.g. match started manually).
 *
 * Matching logic:
 *   - planned slot must have aResolvedId + bResolvedId and no completedAt
 *   - look for a /matches record with same tournamentKey + roundKey where
 *     (playerAId == aResolvedId && playerBId == bResolvedId) OR
 *     (playerAId == bResolvedId && playerBId == aResolvedId)
 *   - if found, PATCH the planned slot with completedAt + result
 *
 * Usage:
 *   FIREBASE_ID_TOKEN=<token> node scripts/backfill-planned-completed.mjs
 */

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';
const TOKEN = process.env.FIREBASE_ID_TOKEN;

if (!TOKEN) {
  console.error('Set FIREBASE_ID_TOKEN env var');
  process.exit(1);
}

function auth() { return `auth=${encodeURIComponent(TOKEN)}`; }

async function get(path) {
  const res = await fetch(`${DB_URL}/${path}.json?${auth()}`);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`);
  return res.json();
}

async function put(path, data) {
  const res = await fetch(`${DB_URL}/${path}.json?${auth()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

console.log('Loading /planned...');
const plannedRaw = await get('planned');
if (!plannedRaw) { console.log('No planned slots found.'); process.exit(0); }

const pending = Object.entries(plannedRaw).filter(([, v]) =>
  v && !v.completedAt && v.aResolvedId && v.bResolvedId
);
console.log(`Total planned slots: ${Object.keys(plannedRaw).length}, pending (no completedAt + has IDs): ${pending.length}`);

if (pending.length === 0) { console.log('Nothing to backfill.'); process.exit(0); }

console.log('Loading /matches...');
const matchesRaw = await get('matches');
if (!matchesRaw) { console.log('No matches found.'); process.exit(0); }
console.log(`Loaded ${Object.keys(matchesRaw).length} matches.`);

// Index matches by tournamentKey+roundKey → array of match records
const matchIndex = new Map();
for (const [mid, m] of Object.entries(matchesRaw)) {
  if (!m || !m.tournamentKey || !m.roundKey || !m.playerAId || !m.playerBId) continue;
  const key = `${m.tournamentKey}::${m.roundKey}`;
  const arr = matchIndex.get(key) ?? [];
  arr.push({ mid, ...m });
  matchIndex.set(key, arr);
}

let patched = 0, notFound = 0, errors = 0;

for (const [slotId, slot] of pending) {
  const key = `${slot.tournamentKey}::${slot.roundKey}`;
  const candidates = matchIndex.get(key) ?? [];

  const match = candidates.find(m =>
    (m.playerAId === slot.aResolvedId && m.playerBId === slot.bResolvedId) ||
    (m.playerAId === slot.bResolvedId && m.playerBId === slot.aResolvedId)
  );

  if (!match) {
    console.log(`  [${slotId}] ${slot.aName} vs ${slot.bName} (${slot.tournamentKey} / ${slot.roundKey}) — no match found in history`);
    notFound++;
    continue;
  }

  if (!match.result) {
    console.log(`  [${slotId}] ${slot.aName} vs ${slot.bName} — match ${match.mid} has no result, skipping`);
    notFound++;
    continue;
  }

  // If sides are swapped in the match vs the slot, flip the result.
  // Strip to only the fields the planned slot schema allows (setsA, setsB, winner).
  // match.result may contain boardCount/finalPointsA/finalPointsB which fail $other:false.
  const swapped = match.playerAId === slot.bResolvedId;
  const result = {
    setsA: swapped ? match.result.setsB : match.result.setsA,
    setsB: swapped ? match.result.setsA : match.result.setsB,
    winner: swapped
      ? (match.result.winner === 'a' ? 'b' : match.result.winner === 'b' ? 'a' : match.result.winner)
      : match.result.winner,
  };

  // PUT the full slot object — the DB rule requires immutable fields
  // (mode, tournamentKey, round, createdBy, createdAt) to match in newData,
  // so we must send the complete record, not a partial PATCH.
  const fullSlot = {
    ...slot,
    completedAt: match.endedAt,
    completedBy: match.createdBy ?? 'backfill',
    result,
  };
  // Remove the mid field — it's the key, not a stored field
  delete fullSlot.mid;

  console.log(`  Patching [${slotId}] ${slot.aName} vs ${slot.bName} → completedAt:${match.endedAt} result:${JSON.stringify(result)}`);
  try {
    await put(`planned/${slotId}`, fullSlot);
    patched++;
  } catch (err) {
    console.error(`  ERROR patching ${slotId}: ${err.message}`);
    errors++;
  }
}

console.log('');
console.log(`Done. Patched: ${patched}, Not found in history: ${notFound}, Errors: ${errors}`);
