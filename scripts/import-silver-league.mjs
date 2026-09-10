/**
 * Imports Silver League match results from the real tournament
 * (3rd-singles-ranking-knock-out-round-of-16-silver) into UAE League Test Tournament
 * with proper Silver League — R16/QF/SF/Final round tagging.
 *
 * Run: node scripts/import-silver-league.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = '--project carrom-score --instance carrom-score-default-rtdb';
const SRC_KEY = '3rd-singles-ranking-knock-out-round-of-16-silver';
const DST_KEY = 'uae-league-test-tournament';
const DST_NAME = 'UAE League Test Tournament';
const FLIGHT = 'Silver League';

function fbGet(path) {
  try {
    const raw = execSync(`firebase database:get "${path}" ${CLI}`, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch (e) {
    const out = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() || '');
    try { return JSON.parse(out); } catch { return null; }
  }
}

function fbUpdateBulk(path, data) {
  const tmpFile = join(tmpdir(), `fb-update-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(data));
    execSync(`firebase database:update -f "${path}" ${CLI} "${tmpFile}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function fbSetNull(path) {
  const tmpFile = join(tmpdir(), `fb-null-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, 'null');
    execSync(`firebase database:set -f "${path}" ${CLI} "${tmpFile}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

// ── Round definitions ─────────────────────────────────────────────────────────
// depth 0 = R16 (8 matches), 1 = QF (4), 2 = SF (2), 3 = Final (1)
const ROUND_DEFS = [
  { depth: 0, label: 'Round of 16', key: `silver-league--r16`, matchCount: 8 },
  { depth: 1, label: 'QF',          key: `silver-league--qf`,  matchCount: 4 },
  { depth: 2, label: 'SF',          key: `silver-league--sf`,  matchCount: 2 },
  { depth: 3, label: 'Final',       key: `silver-league--final`, matchCount: 1 },
];

// ── Assign rounds via winner-progression with dedup + relaxed fallback ─────────
function assignRoundsByProgression(matches) {
  const sorted = [...matches].sort((a, b) => (a.endedAt ?? a.startedAt ?? 0) - (b.endedAt ?? b.startedAt ?? 0));
  const seenPairs = new Set();
  const deduped = [];
  for (const m of sorted) {
    const pair = [m.playerAId, m.playerBId].sort().join('|');
    if (seenPairs.has(pair)) {
      console.log(`  [dedup] skipping duplicate pair: ${m.key} (${m.a} vs ${m.b})`);
      continue;
    }
    seenPairs.add(pair);
    deduped.push(m);
  }

  const wins = {};
  const assignments = {};
  const assigned = new Set();
  for (let pass = 0; pass < 10; pass++) {
    for (const m of deduped) {
      if (assigned.has(m.key)) continue;
      const wA = wins[m.playerAId] ?? 0;
      const wB = wins[m.playerBId] ?? 0;
      if (wA === wB) {
        assignments[m.key] = wA;
        assigned.add(m.key);
        const winnerId = m.winner === 'a' ? m.playerAId : m.winner === 'b' ? m.playerBId : null;
        if (winnerId) wins[winnerId] = (wins[winnerId] ?? 0) + 1;
      }
    }
  }

  // Fallback for any still-unassigned
  for (const m of deduped) {
    if (assigned.has(m.key)) continue;
    const wA = wins[m.playerAId] ?? 0;
    const wB = wins[m.playerBId] ?? 0;
    const depth = Math.min(wA, wB);
    assignments[m.key] = depth;
    console.log(`  [fallback] ${m.key}: depth ${depth} (wA=${wA} wB=${wB})`);
    assigned.add(m.key);
    const winnerId = m.winner === 'a' ? m.playerAId : m.winner === 'b' ? m.playerBId : null;
    if (winnerId) wins[winnerId] = (wins[winnerId] ?? 0) + 1;
  }

  return assignments;
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('1. Fetching source Silver matches…');
const allMatches = fbGet('/matches');
const srcMatches = Object.entries(allMatches || {}).filter(([, v]) => v?.tournamentKey === SRC_KEY);
console.log(`   Found ${srcMatches.length} matches`);

const matchObjs = srcMatches.map(([key, v]) => ({
  key,
  a: v.aName, b: v.bName,
  playerAId: v.playerAId ?? '', playerBId: v.playerBId ?? '',
  winner: v.result?.winner ?? null,
  endedAt: v.endedAt ?? null,
  startedAt: v.startedAt ?? null,
  raw: v,
}));

// ── Assign rounds ────────────────────────────────────────────────────────────
console.log('\n2. Assigning rounds via winner-progression…');
const depths = assignRoundsByProgression(matchObjs);
const depthCounts = {};
for (const d of Object.values(depths)) depthCounts[d] = (depthCounts[d] ?? 0) + 1;
console.log('   Depth counts:', depthCounts);

// ── Build patch for /matches ─────────────────────────────────────────────────
console.log('\n3. Patching /matches — re-tagging to UAE League Test Tournament…');
const matchPatch = {};
const duplicateKeys = new Set();

// First pass: find which keys get assigned (deduped set)
const deduped = (() => {
  const sorted = [...matchObjs].sort((a, b) => (a.endedAt ?? a.startedAt ?? 0) - (b.endedAt ?? b.startedAt ?? 0));
  const seenPairs = new Set();
  const out = [];
  for (const m of sorted) {
    const pair = [m.playerAId, m.playerBId].sort().join('|');
    if (seenPairs.has(pair)) { duplicateKeys.add(m.key); continue; }
    seenPairs.add(pair);
    out.push(m);
  }
  return out;
})();

for (const m of deduped) {
  const depth = depths[m.key];
  if (depth === undefined) { console.warn(`  [warn] unassigned: ${m.key}`); continue; }
  const rd = ROUND_DEFS[depth];
  if (!rd) { console.warn(`  [warn] no round def for depth ${depth}`); continue; }
  const roundName = `${FLIGHT} — ${rd.label}`;
  matchPatch[`${m.key}/tournamentKey`] = DST_KEY;
  matchPatch[`${m.key}/tournament`]    = DST_NAME;
  matchPatch[`${m.key}/round`]         = roundName;
  matchPatch[`${m.key}/roundKey`]      = rd.key;
  console.log(`   ${m.a} vs ${m.b} → ${roundName}`);
}

// Null out duplicate match records (they shouldn't exist in the league context)
for (const key of duplicateKeys) {
  console.log(`   [dup] nulling ${key}`);
  matchPatch[`${key}/tournamentKey`] = null;
  matchPatch[`${key}/tournament`]    = null;
  matchPatch[`${key}/round`]         = null;
  matchPatch[`${key}/roundKey`]      = null;
}

fbUpdateBulk('/matches', matchPatch);
console.log(`   Patched ${Object.keys(matchPatch).length / 4} match records`);

// ── Create rounds on parent tournament ───────────────────────────────────────
console.log('\n4. Creating Silver League rounds on UAE League Test Tournament…');
const existingRounds = fbGet(`/tournaments/${DST_KEY}/rounds`) || {};
const maxOrder = Object.values(existingRounds).reduce((m, r) => Math.max(m, r.order ?? 0), 0);

const roundsPatch = {};
ROUND_DEFS.forEach((rd, i) => {
  const fullName = `${FLIGHT} — ${rd.label}`;
  roundsPatch[rd.key] = {
    key: rd.key,
    name: fullName,
    order: maxOrder + i + 1,
    state: 'closed',
    createdAt: Date.now(),
  };
  console.log(`   + ${fullName} (order ${maxOrder + i + 1})`);
});
fbUpdateBulk(`/tournaments/${DST_KEY}/rounds`, roundsPatch);

console.log('\nDone! Silver League matches imported and rounds created.');
console.log('Refresh the Reports tab — Silver League should now appear with correct R16/QF/SF/Final breakdown.');
