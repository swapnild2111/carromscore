/**
 * Patches Gold and Silver flight matches in the UAE League Test Tournament
 * to have proper sub-round structure (R16, QF, SF, Final) matching Bronze.
 *
 * Strategy:
 *   - Gold: use winner-progression algorithm (clean data, works perfectly)
 *   - Silver: use timestamp ordering (data has an irregular entry, progression fails)
 *
 * Safety: only touches _UAE_TST_-prefixed records in /matches.
 * Does NOT touch any original tournament data.
 *
 * Run: node scripts/patch-uae-gold-silver-rounds.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = '--project carrom-score --instance carrom-score-default-rtdb';

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

// ── Round definitions (same as Bronze) ────────────────────────────────────────
// depth 0 = R16 (8 matches), 1 = QF (4), 2 = SF (2), 3 = Final (1)
const ROUND_INFO = {
  0: { key: 'round-of-16-match-2-4-6-8', name: 'Round of 16 - Match 2, 4, 6, 8' },
  1: { key: 'qf-match-1',               name: 'QF - Match 1' },
  2: { key: 'sf-match-1',               name: 'SF - Match 1' },
  3: { key: 'final',                     name: 'Final' },
};

// ── Assign rounds to Gold via winner-progression ───────────────────────────────
function assignByWinnerProgression(matches) {
  // matches: [{key, pA, pB, winner}]
  const wins = {};
  const assignments = {};
  const assigned = new Set();

  // Iterative passes: assign matches where both players have equal win counts
  for (let pass = 0; pass < 10; pass++) {
    for (const m of matches) {
      if (assigned.has(m.key)) continue;
      const wA = wins[m.pA] ?? 0;
      const wB = wins[m.pB] ?? 0;
      if (wA === wB) {
        assignments[m.key] = wA; // depth = wins each player had entering
        assigned.add(m.key);
        if (m.winner) wins[m.winner] = (wins[m.winner] ?? 0) + 1;
      }
    }
  }
  return assignments; // matchKey → depth (0–3)
}

// ── Assign rounds via winner-progression with dedup + relaxed fallback ────────
// Used for Silver which has one duplicate match entry and one out-of-order match.
function assignByProgressionWithDedup(matches) {
  // Step 1: remove exact duplicate player-pair matches (keep the first by time)
  const sorted = [...matches].sort((a, b) => (a.endedAt ?? a.createdAt ?? 0) - (b.endedAt ?? b.createdAt ?? 0));
  const seenPairs = new Set();
  const deduped = [];
  for (const m of sorted) {
    const pair = [m.pA, m.pB].sort().join('|');
    if (seenPairs.has(pair)) {
      console.log(`  [dedup] skipping duplicate: ${m.key}`);
      continue;
    }
    seenPairs.add(pair);
    deduped.push(m);
  }

  // Step 2: winner-progression on deduped list
  const wins = {};
  const assignments = {};
  const assigned = new Set();
  for (let pass = 0; pass < 10; pass++) {
    for (const m of deduped) {
      if (assigned.has(m.key)) continue;
      const wA = wins[m.pA] ?? 0;
      const wB = wins[m.pB] ?? 0;
      if (wA === wB) {
        assignments[m.key] = wA;
        assigned.add(m.key);
        if (m.winner) wins[m.winner] = (wins[m.winner] ?? 0) + 1;
      }
    }
  }

  // Step 3: for any still-unassigned (players at unequal depth), use min-depth
  for (const m of deduped) {
    if (assigned.has(m.key)) continue;
    const wA = wins[m.pA] ?? 0;
    const wB = wins[m.pB] ?? 0;
    const depth = Math.min(wA, wB);
    assignments[m.key] = depth;
    console.log(`  [fallback] ${m.key}: depth ${depth} (wA=${wA} wB=${wB})`);
    assigned.add(m.key);
    if (m.winner) wins[m.winner] = (wins[m.winner] ?? 0) + 1;
  }

  return assignments;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('Fetching /matches…');
const allMatches = fbGet('/matches');
if (!allMatches) { console.error('Failed to fetch /matches'); process.exit(1); }

// Find _UAE_TST_-prefixed records for Gold and Silver
const goldMatches = [], silverMatches = [];
for (const [key, v] of Object.entries(allMatches)) {
  if (!key.startsWith('_UAE_TST_')) continue;
  if (typeof v !== 'object' || !v) continue;
  const rk = v.roundKey ?? '';
  if (rk.startsWith('gold-league-')) {
    goldMatches.push({
      key, srcKey: key.slice('_UAE_TST_'.length),
      pA: v.playerAId ?? '', pB: v.playerBId ?? '',
      winner: v.result?.winner === 'a' ? v.playerAId : v.result?.winner === 'b' ? v.playerBId : null,
      endedAt: v.endedAt ?? null, createdAt: v.startedAt ?? v.createdAt ?? null,
    });
  } else if (rk.startsWith('silver-league-')) {
    silverMatches.push({
      key, srcKey: key.slice('_UAE_TST_'.length),
      pA: v.playerAId ?? '', pB: v.playerBId ?? '',
      winner: v.result?.winner === 'a' ? v.playerAId : v.result?.winner === 'b' ? v.playerBId : null,
      endedAt: v.endedAt ?? null, createdAt: v.startedAt ?? v.createdAt ?? null,
    });
  }
}

console.log(`Found ${goldMatches.length} Gold matches, ${silverMatches.length} Silver matches`);

// Assign rounds
console.log('\nAssigning Gold rounds via winner-progression…');
const goldDepths = assignByWinnerProgression(goldMatches);
const goldCounts = {};
for (const d of Object.values(goldDepths)) goldCounts[d] = (goldCounts[d] ?? 0) + 1;
console.log('  Gold depth counts:', goldCounts);

console.log('Assigning Silver rounds via winner-progression + dedup…');
const silverDepths = assignByProgressionWithDedup(silverMatches);
const silverCounts = {};
for (const d of Object.values(silverDepths)) silverCounts[d] = (silverCounts[d] ?? 0) + 1;
console.log('  Silver depth counts:', silverCounts);

// Build PATCH object for /matches
// Only update round + roundKey fields (leave all other fields intact)
const patch = {};

for (const m of goldMatches) {
  const depth = goldDepths[m.key];
  if (depth === undefined) { console.warn(`  [warn] Gold unassigned: ${m.key}`); continue; }
  const info = ROUND_INFO[depth];
  const flightPrefix = 'Gold League';
  patch[`${m.key}/round`]    = `${flightPrefix} — ${info.name}`;
  patch[`${m.key}/roundKey`] = `gold-league-${info.key}`;
}

for (const m of silverMatches) {
  const depth = silverDepths[m.key];
  if (depth === undefined) { console.warn(`  [warn] Silver unassigned: ${m.key}`); continue; }
  const info = ROUND_INFO[depth];
  const flightPrefix = 'Silver League';
  patch[`${m.key}/round`]    = `${flightPrefix} — ${info.name}`;
  patch[`${m.key}/roundKey`] = `silver-league-${info.key}`;
}

console.log(`\nWriting ${Object.keys(patch).length} field patches to /matches…`);
fbUpdateBulk('/matches', patch);
console.log('Done. Refresh the app to verify Gold and Silver league brackets.');
