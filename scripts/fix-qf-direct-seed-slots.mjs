/**
 * Fix for QF slots that have placeholders due to the direct-seed bracket shift.
 *
 * When a group has direct seeds (non-PQ players) at the start of playerIds, the
 * bracket generator places PQ pair winners in QF slots that don't match the
 * `ceil(matchOrder/2)` propagation formula. PQ matches 2 and 6 (every group that
 * has 2 direct seeds + 6 PQ pairs) need manual patching after they're played.
 *
 * Specifically for both G1 and G2:
 *   - PQ match 2 winner → QF match 2 side A  (not QF1 as the formula suggests)
 *   - PQ match 6 winner → QF match 4 side A  (not QF3 as the formula suggests)
 *
 * Run AFTER the respective PQ matches have been completed.
 * Safe to run repeatedly — skips already-filled slots and unplayed matches.
 */

import { execSync } from 'node:child_process';

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';
const TOURNAMENT_KEY = 'tdca-carrom-ranking-tournament-2026';

function getToken() {
  return execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
}
function fbGet(path, token) {
  const url = `${DB_URL}${path}.json?access_token=${token}`;
  return JSON.parse(execSync(`curl -s "${url}"`, { encoding: 'utf8' }));
}
function fbPatch(path, data, token) {
  const url = `${DB_URL}${path}.json?access_token=${token}`;
  const body = JSON.stringify(data);
  return JSON.parse(execSync(`curl -s -X PATCH -H 'Content-Type: application/json' -d '${body}' "${url}"`, { encoding: 'utf8' }));
}

const isPlaceholder = (name, resolvedId) =>
  !resolvedId || /^dummy-\d+$/i.test(resolvedId) ||
  /(?:Winner\s+\d+|Pre-qualify\s+Winner|Bye|dummy-\d+)/i.test(name ?? '');

const token = getToken();

const allPlanned = fbGet('/planned', token);
const matches = Object.entries(allPlanned)
  .filter(([, v]) => v.tournamentKey === TOURNAMENT_KEY)
  .map(([mid, v]) => ({ mid, ...v }));

// Groups: each has pqRoundKey, qfRoundKey, and the two "broken" PQ→QF mappings
const GROUPS = [
  { name: 'G1', pqRoundKey: 'g1-pre-qualify', qfRoundKey: 'g1-qf' },
  { name: 'G2', pqRoundKey: 'g2-pre-qualify', qfRoundKey: 'g2-qf' },
];

// For each group: PQ match 2 → QF match 2 side A, PQ match 6 → QF match 4 side A
const MANUAL_MAPPINGS = [
  { pqMatchOrder: 2, qfMatchOrder: 2, side: 'a' },
  { pqMatchOrder: 6, qfMatchOrder: 4, side: 'a' },
];

let totalPatched = 0;

for (const group of GROUPS) {
  console.log(`\n=== ${group.name} ===`);
  for (const mapping of MANUAL_MAPPINGS) {
    const pqMatch = matches.find(
      m => m.roundKey === group.pqRoundKey && m.matchOrder === mapping.pqMatchOrder
    );
    if (!pqMatch) {
      console.log(`  PQ match ${mapping.pqMatchOrder}: not found — skipping`);
      continue;
    }

    if (!pqMatch.completedAt || !pqMatch.result) {
      console.log(`  PQ match ${mapping.pqMatchOrder} (${pqMatch.aName} vs ${pqMatch.bName}): not yet played — skipping`);
      continue;
    }

    const winner = pqMatch.result.winner;
    if (winner === 'draw') {
      console.log(`  PQ match ${mapping.pqMatchOrder}: ended in draw — skipping`);
      continue;
    }

    const winnerName = winner === 'a' ? pqMatch.aName : pqMatch.bName;
    const winnerResolvedId = winner === 'a' ? pqMatch.aResolvedId : pqMatch.bResolvedId;

    const qfMatch = matches.find(
      m => m.roundKey === group.qfRoundKey && m.matchOrder === mapping.qfMatchOrder
    );
    if (!qfMatch) {
      console.log(`  QF match ${mapping.qfMatchOrder}: not found — skipping`);
      continue;
    }

    const currentName = mapping.side === 'a' ? qfMatch.aName : qfMatch.bName;
    const currentResolvedId = mapping.side === 'a' ? qfMatch.aResolvedId : qfMatch.bResolvedId;

    if (!isPlaceholder(currentName, currentResolvedId)) {
      console.log(`  QF${mapping.qfMatchOrder}${mapping.side.toUpperCase()}: already has real player "${currentName}" — skipping`);
      continue;
    }

    if (currentResolvedId === winnerResolvedId) {
      console.log(`  QF${mapping.qfMatchOrder}${mapping.side.toUpperCase()}: already set to ${winnerName} — no change`);
      continue;
    }

    const patch = {};
    if (mapping.side === 'a') {
      patch.aName = winnerName;
      if (winnerResolvedId) patch.aResolvedId = winnerResolvedId;
    } else {
      patch.bName = winnerName;
      if (winnerResolvedId) patch.bResolvedId = winnerResolvedId;
    }

    console.log(`  PATCH QF${mapping.qfMatchOrder}${mapping.side.toUpperCase()}: "${currentName}" → "${winnerName}"`);
    fbPatch(`/planned/${qfMatch.mid}`, patch, token);
    // Update local cache
    if (mapping.side === 'a') { qfMatch.aName = winnerName; qfMatch.aResolvedId = winnerResolvedId; }
    else { qfMatch.bName = winnerName; qfMatch.bResolvedId = winnerResolvedId; }
    totalPatched++;
  }
}

console.log(`\nDone — patched ${totalPatched} slot(s).`);
