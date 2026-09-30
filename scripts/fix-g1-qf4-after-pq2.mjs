/**
 * One-time fix: After G1 PQ match 2 (Devika/Aparna) is played, propagate
 * the winner into G1 QF match 4 side A.
 *
 * Background: The bracket generator placed PQ Winner 6 as QF4a placeholder,
 * but the `ceil(matchOrder/2)` propagation formula sends PQ2 winner to QF1
 * (where both sides are already filled). This script fills QF4a manually.
 *
 * Run AFTER PQ match 2 has been played and has a completedAt.
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

const allPlanned = fbGet('/planned', token);
const matches = Object.entries(allPlanned)
  .filter(([, v]) => v.tournamentKey === TOURNAMENT_KEY)
  .map(([mid, v]) => ({ mid, ...v }));

// Find G1 PQ match 2
const pq2 = matches.find(m => m.roundKey === 'g1-pre-qualify' && m.matchOrder === 2);
if (!pq2) { console.error('G1 PQ match 2 not found'); process.exit(1); }

console.log('G1 PQ Match 2:', pq2.aName, 'vs', pq2.bName);
if (!pq2.completedAt || !pq2.result) {
  console.error('Match has not been completed yet (no completedAt or result). Play the match first.');
  process.exit(1);
}

const winner = pq2.result.winner;
if (winner === 'draw') { console.error('Match ended in draw — cannot propagate'); process.exit(1); }

const winnerName = winner === 'a' ? pq2.aName : pq2.bName;
const winnerResolvedId = winner === 'a' ? pq2.aResolvedId : pq2.bResolvedId;
console.log('Winner:', winnerName, '(id:', winnerResolvedId, ')');

// Find G1 QF match 4 (the intended target)
const qf4 = matches.find(m => m.roundKey === 'g1-qf' && m.matchOrder === 4);
if (!qf4) { console.error('G1 QF match 4 not found'); process.exit(1); }

console.log('\nG1 QF Match 4 current state:');
console.log('  aName:', qf4.aName, '| aResolvedId:', qf4.aResolvedId);
console.log('  bName:', qf4.bName, '| bResolvedId:', qf4.bResolvedId);

if (qf4.aResolvedId && !/^dummy-\d+$/i.test(qf4.aResolvedId)) {
  console.error('QF4 side A already has a real resolved player:', qf4.aName, '— aborting');
  process.exit(1);
}

console.log('\nPatching QF4 side A →', winnerName);
const result = fbPatch(`/planned/${qf4.mid}`, {
  aName: winnerName,
  ...(winnerResolvedId ? { aResolvedId: winnerResolvedId } : {}),
}, token);

console.log('Result:', JSON.stringify(result));
console.log('Done — QF4 side A set to', winnerName);
