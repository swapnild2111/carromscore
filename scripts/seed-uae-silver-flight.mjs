/**
 * Seeds Silver League matches into UAE League Test Tournament by copying
 * from 3rd-singles-ranking-knock-out-round-of-16-silver — same pattern
 * as seed-uae-league-test.mjs used for Gold and Bronze.
 *
 * Safety: ZERO writes to any existing record. Only writes new _UAE_TST_-prefixed
 * records and adds Silver League rounds to /tournaments/uae-league-test-tournament.
 *
 * Run: node scripts/seed-uae-silver-flight.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = '--project carrom-score --instance carrom-score-default-rtdb';
const SRC_KEY = '3rd-singles-ranking-knock-out-round-of-16-silver';
const TK = 'uae-league-test-tournament';
const DISPLAY_NAME = 'UAE League Test Tournament';
const FLIGHT = 'Silver League';
const TAG = '_UAE_TEST';

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

// ── Winner-progression round assignment (same logic as patch-uae-gold-silver-rounds.mjs) ──
function assignRoundsByProgression(matches) {
  const sorted = [...matches].sort((a, b) => (a.endedAt ?? a.startedAt ?? 0) - (b.endedAt ?? b.startedAt ?? 0));
  const seenPairs = new Set();
  const deduped = [];
  for (const m of sorted) {
    const pair = [m.playerAId, m.playerBId].sort().join('|');
    if (seenPairs.has(pair)) {
      console.log(`  [dedup] skipping duplicate: ${m.key} (${m.aName} vs ${m.bName})`);
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
        const winnerId = m.result?.winner === 'a' ? m.playerAId : m.result?.winner === 'b' ? m.playerBId : null;
        if (winnerId) wins[winnerId] = (wins[winnerId] ?? 0) + 1;
      }
    }
  }
  // Fallback for still-unassigned
  for (const m of deduped) {
    if (assigned.has(m.key)) continue;
    const wA = wins[m.playerAId] ?? 0;
    const wB = wins[m.playerBId] ?? 0;
    const depth = Math.min(wA, wB);
    assignments[m.key] = depth;
    console.log(`  [fallback] ${m.key}: depth ${depth}`);
    assigned.add(m.key);
    const winnerId = m.result?.winner === 'a' ? m.playerAId : m.result?.winner === 'b' ? m.playerBId : null;
    if (winnerId) wins[winnerId] = (wins[winnerId] ?? 0) + 1;
  }
  return { assignments, deduped };
}

// ── Round defs matching real Silver tournament structure ──
// depth 0 = R16, 1 = QF, 2 = SF, 3 = Final
const ROUND_DEFS = [
  { depth: 0, srcKey: 'round-of-16-match-2-4-6-8', srcName: 'Round of 16 - Match 2, 4, 6, 8' },
  { depth: 1, srcKey: 'qf-match-1',                srcName: 'QF - Match 1' },
  { depth: 2, srcKey: 'sf-match-1',                srcName: 'SF - Match 1' },
  { depth: 3, srcKey: 'final',                     srcName: 'Final' },
];

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('1. Fetching real Silver tournament rounds…');
const srcRounds = fbGet(`/tournaments/${SRC_KEY}/rounds`) || {};
const sortedSrcRounds = Object.entries(srcRounds)
  .map(([k, v]) => ({ key: k, name: v.name || '', order: v.order ?? 0 }))
  .sort((a, b) => a.order - b.order);
console.log(`   ${sortedSrcRounds.length} rounds: ${sortedSrcRounds.map(r => r.name).join(', ')}`);

console.log('\n2. Fetching real Silver match history…');
const allMatches = fbGet('/matches') || {};
const srcMatches = Object.entries(allMatches)
  .filter(([, v]) => v?.tournamentKey === SRC_KEY)
  .map(([key, v]) => ({ key, ...v }));
console.log(`   Found ${srcMatches.length} matches`);

console.log('\n3. Fetching real Silver planned matches…');
const allPlanned = fbGet('/planned') || {};
const srcPlanned = Object.entries(allPlanned)
  .filter(([, v]) => v?.tournamentKey === SRC_KEY)
  .map(([key, v]) => ({ key, ...v }));
console.log(`   Found ${srcPlanned.length} planned matches`);

console.log('\n4. Assigning rounds via winner-progression…');
const { assignments, deduped } = assignRoundsByProgression(srcMatches);
const depthCounts = {};
for (const d of Object.values(assignments)) depthCounts[d] = (depthCounts[d] ?? 0) + 1;
console.log('   Depth counts:', depthCounts);

// ── Build round key mapping: srcRoundKey → { newRoundKey, newRoundName, order } ──
// Use the same naming convention as Gold/Bronze in the seed script
const existingRounds = fbGet(`/tournaments/${TK}/rounds`) || {};
const maxOrder = Object.values(existingRounds).reduce((m, r) => Math.max(m, r.order ?? 0), 0);

const srcRoundToNew = new Map();
const newRoundsPatch = {};
sortedSrcRounds.forEach((sr, i) => {
  const newRoundName = `${FLIGHT} — ${sr.name}`;
  const newRoundKey = `${FLIGHT.toLowerCase().replace(/\s+/g, '-')}-${sr.key}`;
  const order = maxOrder + i + 1;
  srcRoundToNew.set(sr.key, { newRoundKey, newRoundName, order });
  newRoundsPatch[newRoundKey] = {
    name: newRoundName,
    order,
    state: 'closed',
    createdBy: TAG,
    createdAt: Date.now(),
  };
});

console.log('\n5. Round mapping:');
for (const [k, v] of srcRoundToNew) {
  console.log(`   ${k} → ${v.newRoundName} (order ${v.order})`);
}

// ── Build _UAE_TST_ match history copies with corrected round tags ──────────
console.log('\n6. Building new match history records…');
const newMatches = {};
const dupKeys = new Set(srcMatches
  .filter(m => !deduped.some(d => d.key === m.key))
  .map(m => m.key));

for (const m of srcMatches) {
  if (dupKeys.has(m.key)) {
    console.log(`   [skip dup] ${m.key}`);
    continue;
  }
  const depth = assignments[m.key];
  if (depth === undefined) { console.warn(`   [warn] unassigned: ${m.key}`); continue; }
  const rd = ROUND_DEFS[depth];
  if (!rd) { console.warn(`   [warn] no ROUND_DEF for depth ${depth}`); continue; }
  const mapped = srcRoundToNew.get(rd.srcKey);
  if (!mapped) { console.warn(`   [warn] no mapping for ${rd.srcKey}`); continue; }

  const newKey = `_UAE_TST_${m.key}`;
  newMatches[newKey] = {
    ...m,
    key: undefined,  // remove the key field we added for processing
    tournament: DISPLAY_NAME,
    tournamentKey: TK,
    round: mapped.newRoundName,
    roundKey: mapped.newRoundKey,
  };
  delete newMatches[newKey].key;
  console.log(`   ${m.aName} vs ${m.bName} → ${mapped.newRoundName}`);
}

// ── Build _UAE_TST_ planned match copies ────────────────────────────────────
console.log('\n7. Building new planned match records…');
const newPlanned = {};
for (const m of srcPlanned) {
  const srcRoundKey = m.roundKey || '';
  const mapped = srcRoundToNew.get(srcRoundKey);
  if (!mapped) {
    console.log(`   [skip] planned ${m.key}: unknown roundKey '${srcRoundKey}'`);
    continue;
  }
  const newKey = `_UAE_TST_${m.key}`;
  newPlanned[newKey] = {
    mode: m.mode,
    tournament: DISPLAY_NAME,
    tournamentKey: TK,
    round: mapped.newRoundName,
    roundKey: mapped.newRoundKey,
    matchOrder: m.matchOrder,
    aName: m.aName,
    bName: m.bName,
    ...(m.aResolvedId ? { aResolvedId: m.aResolvedId } : {}),
    ...(m.bResolvedId ? { bResolvedId: m.bResolvedId } : {}),
    ...(m.cfg ? { cfg: m.cfg } : {}),
    createdAt: m.createdAt || Date.now(),
    createdBy: TAG,
    ...(m.completedAt ? { completedAt: m.completedAt } : {}),
    ...(m.result ? { result: m.result } : {}),
  };
  console.log(`   planned: ${m.aName} vs ${m.bName} → ${mapped.newRoundName}`);
}

// ── Write ────────────────────────────────────────────────────────────────────
const matchCount = Object.keys(newMatches).length;
const plannedCount = Object.keys(newPlanned).length;
const roundCount = Object.keys(newRoundsPatch).length;

console.log(`\n8. Writing ${roundCount} rounds, ${matchCount} match history, ${plannedCount} planned…`);

if (roundCount > 0) {
  fbUpdateBulk(`/tournaments/${TK}/rounds`, newRoundsPatch);
  console.log(`   ✓ Rounds added`);
}
if (matchCount > 0) {
  fbUpdateBulk('/matches', newMatches);
  console.log(`   ✓ Match history written`);
}
if (plannedCount > 0) {
  fbUpdateBulk('/planned', newPlanned);
  console.log(`   ✓ Planned matches written`);
}

console.log('\nDone. Refresh Reports tab — Silver League should now appear.');
