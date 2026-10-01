/**
 * Patch TDCA 2026 rounds that are missing startedAt / state=closed.
 *
 * Affects KO rounds (and any group round) that were never manually started
 * via the Rounds UI — their matches were seeded directly via bracket
 * propagation so the auto-start logic in planned.ts never fired.
 *
 * For each round where:
 *   - state !== 'closed'          (round is not already closed)
 *   - startedAt is missing        (round was never started via UI)
 *   - all matches in /matches for that round exist AND all have endedAt
 *
 * We write:
 *   startedAt = min(match.startedAt) across those matches
 *   state     = 'closed'
 *
 * Run: node scripts/patch-tdca-round-states.mjs
 * Requires: gcloud auth application-default login (or gcloud auth print-access-token)
 */

import { execSync } from 'node:child_process';

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';
const TOURNAMENT_KEY = 'tdca-carrom-ranking-tournament';

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
  return JSON.parse(
    execSync(`curl -s -X PATCH -H 'Content-Type: application/json' -d '${body}' "${url}"`, {
      encoding: 'utf8',
    }),
  );
}

const token = getToken();

// ── 1. Load all rounds for the tournament ──────────────────────────────────
const rounds = fbGet(`/tournaments/${TOURNAMENT_KEY}/rounds`, token);
if (!rounds || typeof rounds !== 'object') {
  console.error('No rounds found for tournament', TOURNAMENT_KEY);
  process.exit(1);
}

// ── 2. Load all matches for the tournament ─────────────────────────────────
// /matches is indexed by match key; each has tournamentKey, roundKey, startedAt, endedAt
const allMatches = fbGet('/matches', token);
const tournamentMatches = Object.entries(allMatches ?? {})
  .filter(([, m]) => m?.tournamentKey === TOURNAMENT_KEY)
  .map(([key, m]) => ({ key, ...m }));

console.log(`Found ${Object.keys(rounds).length} rounds, ${tournamentMatches.length} matches for ${TOURNAMENT_KEY}\n`);

// ── 3. Group matches by roundKey ───────────────────────────────────────────
const matchesByRound = {};
for (const m of tournamentMatches) {
  if (!m.roundKey) continue;
  (matchesByRound[m.roundKey] ??= []).push(m);
}

// ── 4. Process each round ─────────────────────────────────────────────────
let patched = 0;

for (const [roundKey, round] of Object.entries(rounds)) {
  if (round.state === 'closed') {
    console.log(`SKIP  ${roundKey} (${round.name}) — already closed`);
    continue;
  }
  if (round.startedAt) {
    console.log(`SKIP  ${roundKey} (${round.name}) — already has startedAt`);
    continue;
  }

  const roundMatches = matchesByRound[roundKey] ?? [];
  if (roundMatches.length === 0) {
    console.log(`SKIP  ${roundKey} (${round.name}) — no matches in /matches`);
    continue;
  }

  const allEnded = roundMatches.every((m) => !!m.endedAt);
  if (!allEnded) {
    const done = roundMatches.filter((m) => !!m.endedAt).length;
    console.log(`SKIP  ${roundKey} (${round.name}) — ${done}/${roundMatches.length} matches ended (not all done)`);
    continue;
  }

  // Use earliest match startedAt as the round's startedAt.
  // Fall back to earliest endedAt if startedAt is missing on a match.
  const timestamps = roundMatches.map((m) => m.startedAt ?? m.endedAt).filter(Boolean);
  const roundStartedAt = Math.min(...timestamps);

  console.log(
    `PATCH ${roundKey} (${round.name}) — ${roundMatches.length} matches done → startedAt=${new Date(roundStartedAt).toISOString()}, state=closed`,
  );

  fbPatch(`/tournaments/${TOURNAMENT_KEY}/rounds/${roundKey}`, {
    startedAt: roundStartedAt,
    state: 'closed',
  }, token);

  patched++;
}

console.log(`\nDone — patched ${patched} round(s).`);
