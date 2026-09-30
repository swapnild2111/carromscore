/**
 * Backfill winner propagation for TDCA 2026 tournament.
 * Finds all completed planned matches whose next-round slot still has
 * a placeholder name, and patches the correct winner name + resolvedId in.
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

const token = getToken();

const rounds = fbGet(`/tournaments/${TOURNAMENT_KEY}/rounds`, token);
// roundKey → order
const roundOrder = Object.fromEntries(Object.entries(rounds).map(([k, v]) => [k, v.order]));

const allPlanned = fbGet('/planned', token);
const matches = Object.entries(allPlanned)
  .filter(([, v]) => v.tournamentKey === TOURNAMENT_KEY)
  .map(([mid, v]) => ({ mid, ...v }));

const isPlaceholder = (name) => !name || /(?:Winner\s+\d+|Pre-qualify\s+Winner|Bye|dummy-\d+)/i.test(name);

let patched = 0;
for (const m of matches) {
  if (!m.completedAt || !m.result) continue; // not completed
  const winner = m.result.winner;
  if (winner === 'draw') continue;

  const winnerName     = winner === 'a' ? m.aName    : m.bName;
  const winnerResolved = winner === 'a' ? m.aResolvedId : m.bResolvedId;
  if (!winnerName) continue;

  // Find next round (order + 1)
  const thisOrder = roundOrder[m.roundKey];
  if (!thisOrder) continue;
  const nextRoundKey = Object.entries(roundOrder).find(([, o]) => o === thisOrder + 1)?.[0];
  if (!nextRoundKey) continue; // final round, no next

  // Primary: find target by placeholder name matching (handles direct-seed bracket shift)
  const roundLabel = Object.values(rounds).find((v, i) => Object.keys(rounds)[i] === m.roundKey)?.name
    ?? Object.entries(rounds).find(([k]) => k === m.roundKey)?.[1]?.name ?? '';
  const groupNameMatch = roundLabel.match(/^([A-Za-z0-9]+)\s*[—-]/);
  const groupName = groupNameMatch?.[1];
  const placeholderName = groupName ? `${groupName} Pre-qualify Winner ${m.matchOrder}` : null;

  const nextRoundMatches = matches.filter(t => t.roundKey === nextRoundKey);

  let target = null;
  let side = null;

  if (placeholderName) {
    const byPlaceholder = nextRoundMatches.find(t => t.aName === placeholderName || t.bName === placeholderName);
    if (byPlaceholder) {
      target = byPlaceholder;
      side = byPlaceholder.aName === placeholderName ? 'a' : 'b';
    }
  }

  if (!target) {
    // Fallback: ceil(matchOrder / 2) formula with real-player side detection
    const targetOrder = Math.ceil(m.matchOrder / 2);
    target = nextRoundMatches.find(t => t.matchOrder === targetOrder);
    if (!target) continue;
    const aIsReal = !!target.aResolvedId;
    const bIsReal = !!target.bResolvedId;
    if (aIsReal && !bIsReal) side = 'b';
    else if (bIsReal && !aIsReal) side = 'a';
    else if (!aIsReal && !bIsReal) side = m.matchOrder % 2 === 1 ? 'a' : 'b';
    else {
      console.log(`SKIP (both sides real): ${target.aName} vs ${target.bName}`);
      continue;
    }
  }

  const currentName = side === 'a' ? target.aName : target.bName;
  const currentResolved = side === 'a' ? target.aResolvedId : target.bResolvedId;

  // Skip if already correctly filled
  if (currentResolved === winnerResolved && currentName === winnerName) continue;
  // Skip if slot already has a real resolved player that isn't a placeholder
  if (currentResolved && currentResolved !== winnerResolved && !isPlaceholder(currentName)) {
    console.log(`SKIP ${target.mid} ${side}: already has real player ${currentName}`);
    continue;
  }

  const patch = {};
  if (side === 'a') {
    patch.aName = winnerName;
    if (winnerResolved) patch.aResolvedId = winnerResolved;
  } else {
    patch.bName = winnerName;
    if (winnerResolved) patch.bResolvedId = winnerResolved;
  }

  console.log(`PATCH ${target.mid} (round ${nextRoundKey} match ${target.matchOrder} side ${side}): ${currentName || '(empty)'} → ${winnerName}`);
  fbPatch(`/planned/${target.mid}`, patch, token);
  // Update local cache so subsequent iterations see the patched value
  if (side === 'a') { target.aName = winnerName; target.aResolvedId = winnerResolved; }
  else              { target.bName = winnerName; target.bResolvedId = winnerResolved; }
  patched++;
}

console.log(`\nDone — patched ${patched} slot(s).`);
