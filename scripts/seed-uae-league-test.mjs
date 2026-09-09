/**
 * Duplicates UAE 3rd Singles Ranking tournament data into a new
 * League-format tournament named "UAE League Test Tournament".
 *
 * Safety contract:
 *   - ZERO writes to any existing record. All source reads are read-only.
 *   - Only writes to /tournaments/uae-league-test-tournament/ and new
 *     /planned/ + /matches/ keys prefixed _UAE_TST_, tagged createdBy=_UAE_TEST.
 *   - --cleanup removes ONLY those tagged/prefixed records.
 *
 * Run:     node scripts/seed-uae-league-test.mjs
 * Cleanup: node scripts/seed-uae-league-test.mjs --cleanup
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLEANUP = process.argv.includes('--cleanup');
const TAG = '_UAE_TEST';
const TK = 'uae-league-test-tournament';
const DISPLAY_NAME = 'UAE League Test Tournament';
const CLI = '--project carrom-score --instance carrom-score-default-rtdb';

// League group sources — round name and key are fixed (group rounds)
const LEAGUE_GROUP_MAP = {
  '3rd-singles-ranking-league-a-matches': { newRound: 'Group A', newRoundKey: 'group-a', groupKey: 'g1' },
  '3rd-singles-ranking-league-b-matches': { newRound: 'Group B', newRoundKey: 'group-b', groupKey: 'g2' },
  '3rd-singles-ranking-league-c-matches': { newRound: 'Group C', newRoundKey: 'group-c', groupKey: 'g3' },
  '3rd-singles-ranking-league-d-matches': { newRound: 'Group D', newRoundKey: 'group-d', groupKey: 'g4' },
  '3rd-singles-ranking-league-e-matches': { newRound: 'Group E', newRoundKey: 'group-e', groupKey: 'g5' },
  '3rd-singles-ranking-league-f-matches': { newRound: 'Group F', newRoundKey: 'group-f', groupKey: 'g6' },
  '3rd-singles-ranking-league-g-matches': { newRound: 'Group G', newRoundKey: 'group-g', groupKey: 'g7' },
  '3rd-singles-ranking-league-h-matches': { newRound: 'Group H', newRoundKey: 'group-h', groupKey: 'g8' },
};

// Flight (knockout) sources — rounds are preserved from source, prefixed with flight name
const FLIGHT_SOURCES = [
  { srcKey: '3rd-singles-ranking-knock-out-round-of-16-gold',   flightName: 'Gold League',   flightOrder: 9  },
  { srcKey: '3rd-singles-ranking-knock-out-round-of-16-silver', flightName: 'Silver League', flightOrder: 10 },
  { srcKey: '3rd-singles-ranking-knock-out-round-of-16-bronze', flightName: 'Bronze League', flightOrder: 11 },
];

const ALL_SOURCE_KEYS = new Set([
  ...Object.keys(LEAGUE_GROUP_MAP),
  ...FLIGHT_SOURCES.map(f => f.srcKey),
]);

// ─── Firebase helpers ─────────────────────────────────────────────────────────

function fbGet(path) {
  try {
    const raw = execSync(`firebase database:get "${path}" ${CLI}`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch (e) {
    const out = typeof e.stdout === 'string' ? e.stdout : (e.stdout?.toString() || '');
    try { return JSON.parse(out); } catch { return null; }
  }
}

function fbSetBulk(path, data) {
  const tmpFile = join(tmpdir(), `fb-set-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(data));
    execSync(`firebase database:set -f "${path}" ${CLI} "${tmpFile}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
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

function fbRemove(path) {
  execSync(`firebase database:set -f "${path}" ${CLI} -d 'null'`, { stdio: 'pipe' });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanup() {
  console.log('Cleaning up UAE League Test Tournament data…');
  console.log('(Only _UAE_TEST-tagged and _UAE_TST_-prefixed records will be removed)\n');

  console.log(`Removing /tournaments/${TK}…`);
  fbRemove(`/tournaments/${TK}`);
  console.log('  done');

  console.log('Scanning /planned for _UAE_TEST-tagged records…');
  const planned = fbGet('/planned');
  const plannedNulls = {};
  if (planned) {
    for (const [mid, v] of Object.entries(planned)) {
      if (v?.createdBy === TAG) plannedNulls[mid] = null;
    }
  }
  if (Object.keys(plannedNulls).length > 0) fbUpdateBulk('/planned', plannedNulls);
  console.log(`  removed ${Object.keys(plannedNulls).length} planned matches`);

  console.log('Scanning /matches for _UAE_TST_-prefixed records…');
  const matches = fbGet('/matches');
  const matchNulls = {};
  if (matches) {
    for (const key of Object.keys(matches)) {
      if (key.startsWith('_UAE_TST_')) matchNulls[key] = null;
    }
  }
  if (Object.keys(matchNulls).length > 0) fbUpdateBulk('/matches', matchNulls);
  console.log(`  removed ${Object.keys(matchNulls).length} match history records`);

  console.log('\nCleanup complete. Refresh the app to verify.');
}

// ─── Seed ─────────────────────────────────────────────────────────────────────

function seed() {
  console.log('Seeding UAE League Test Tournament…');
  console.log('Source: 11 × 3rd Singles Ranking tournaments\n');
  const now = Date.now();

  // ── 1. Read source player IDs ────────────────────────────────────────────
  console.log('Reading source player IDs…');
  const playerIdsByTk = {};
  for (const srcKey of ALL_SOURCE_KEYS) {
    const ids = fbGet(`/tournaments/${srcKey}/assignedPlayerIds`);
    playerIdsByTk[srcKey] = ids ? Object.keys(ids) : [];
  }
  console.log('  done');

  // ── 2. Read source rounds for flights (to preserve sub-round structure) ──
  console.log('Reading source rounds for flights…');
  const flightRoundsByTk = {};
  for (const { srcKey } of FLIGHT_SOURCES) {
    const rounds = fbGet(`/tournaments/${srcKey}/rounds`);
    // Sort by order ascending so we can assign incremental order numbers
    const sorted = rounds
      ? Object.entries(rounds)
          .map(([k, v]) => ({ key: k, name: v.name || '', order: v.order ?? 0 }))
          .sort((a, b) => a.order - b.order)
      : [];
    flightRoundsByTk[srcKey] = sorted;
    console.log(`  ${srcKey.split('-').pop()}: ${sorted.length} rounds (${sorted.map(r => r.name).join(', ')})`);
  }

  // ── 3. Read source planned matches and match history ─────────────────────
  console.log('\nReading source planned matches…');
  const allPlanned = fbGet('/planned') || {};
  const sourcePlanned = Object.entries(allPlanned).filter(
    ([, v]) => ALL_SOURCE_KEYS.has(v?.tournamentKey)
  );
  console.log(`  found ${sourcePlanned.length} planned matches`);

  console.log('Reading source match history…');
  const allMatches = fbGet('/matches') || {};
  const sourceMatches = Object.entries(allMatches).filter(
    ([, v]) => ALL_SOURCE_KEYS.has(v?.tournamentKey)
  );
  console.log(`  found ${sourceMatches.length} match history records`);

  // ── 4. Build tournament rounds object ────────────────────────────────────
  // Group rounds (fixed, order 1–8)
  const rounds = {};
  const groupEntries = [
    { gKey: 'g1', srcKey: '3rd-singles-ranking-league-a-matches', roundName: 'Group A', roundKey: 'group-a', order: 1 },
    { gKey: 'g2', srcKey: '3rd-singles-ranking-league-b-matches', roundName: 'Group B', roundKey: 'group-b', order: 2 },
    { gKey: 'g3', srcKey: '3rd-singles-ranking-league-c-matches', roundName: 'Group C', roundKey: 'group-c', order: 3 },
    { gKey: 'g4', srcKey: '3rd-singles-ranking-league-d-matches', roundName: 'Group D', roundKey: 'group-d', order: 4 },
    { gKey: 'g5', srcKey: '3rd-singles-ranking-league-e-matches', roundName: 'Group E', roundKey: 'group-e', order: 5 },
    { gKey: 'g6', srcKey: '3rd-singles-ranking-league-f-matches', roundName: 'Group F', roundKey: 'group-f', order: 6 },
    { gKey: 'g7', srcKey: '3rd-singles-ranking-league-g-matches', roundName: 'Group G', roundKey: 'group-g', order: 7 },
    { gKey: 'g8', srcKey: '3rd-singles-ranking-league-h-matches', roundName: 'Group H', roundKey: 'group-h', order: 8 },
  ];
  for (const g of groupEntries) {
    rounds[g.roundKey] = { name: g.roundName, order: g.order, state: 'closed', createdBy: TAG, createdAt: now };
  }

  // Flight rounds — one round per sub-stage, prefixed with flight name
  // e.g. "Bronze League — QF - Match 1", key = "bronze-league-qf-match-1"
  // Build a mapping: srcRoundKey → { newRoundKey, newRoundName } for each flight
  const flightRoundMapping = {}; // srcTournamentKey → Map(srcRoundKey → {newRoundKey, newRoundName, order})
  let flightOrderBase = 9;
  for (const { srcKey, flightName } of FLIGHT_SOURCES) {
    const srcRounds = flightRoundsByTk[srcKey];
    const mapping = new Map();
    for (let i = 0; i < srcRounds.length; i++) {
      const sr = srcRounds[i];
      const newRoundName = `${flightName} — ${sr.name}`;
      const newRoundKey = `${flightName.toLowerCase().replace(/\s+/g, '-')}-${sr.key}`;
      const order = flightOrderBase + i;
      rounds[newRoundKey] = { name: newRoundName, order, state: 'closed', createdBy: TAG, createdAt: now };
      mapping.set(sr.key, { newRoundKey, newRoundName, order });
    }
    flightRoundMapping[srcKey] = mapping;
    flightOrderBase += srcRounds.length;
  }

  // ── 5. Build groups object ───────────────────────────────────────────────
  const groups = {};
  for (const g of groupEntries) {
    groups[g.gKey] = { playerIds: playerIdsByTk[g.srcKey], roundKey: g.roundKey };
  }

  // ── 6. Build assignedPlayerIds ───────────────────────────────────────────
  const allPlayerIds = new Set();
  for (const ids of Object.values(playerIdsByTk)) for (const id of ids) allPlayerIds.add(id);
  const assignedPlayerIds = Object.fromEntries([...allPlayerIds].map(id => [id, true]));

  // ── 7. Build new planned matches ─────────────────────────────────────────
  const newPlanned = {};
  for (const [srcKey, srcMatch] of sourcePlanned) {
    const tk = srcMatch.tournamentKey;
    let newRound, newRoundKey;

    if (LEAGUE_GROUP_MAP[tk]) {
      newRound = LEAGUE_GROUP_MAP[tk].newRound;
      newRoundKey = LEAGUE_GROUP_MAP[tk].newRoundKey;
    } else {
      // Flight: look up the specific sub-round by its roundKey
      const mapping = flightRoundMapping[tk];
      const mapped = mapping?.get(srcMatch.roundKey);
      if (!mapped) continue; // unknown round, skip
      newRound = mapped.newRoundName;
      newRoundKey = mapped.newRoundKey;
    }

    newPlanned[`_UAE_TST_${srcKey}`] = {
      mode: srcMatch.mode,
      tournament: DISPLAY_NAME,
      tournamentKey: TK,
      round: newRound,
      roundKey: newRoundKey,
      matchOrder: srcMatch.matchOrder,
      aName: srcMatch.aName,
      bName: srcMatch.bName,
      ...(srcMatch.aResolvedId ? { aResolvedId: srcMatch.aResolvedId } : {}),
      ...(srcMatch.bResolvedId ? { bResolvedId: srcMatch.bResolvedId } : {}),
      ...(srcMatch.cfg ? { cfg: srcMatch.cfg } : {}),
      ...(srcMatch.board != null ? { board: srcMatch.board } : {}),
      createdAt: srcMatch.createdAt || now,
      createdBy: TAG,
      ...(srcMatch.completedAt ? { completedAt: srcMatch.completedAt } : {}),
      ...(srcMatch.completedBy ? { completedBy: srcMatch.completedBy } : {}),
      ...(srcMatch.claimedAt ? { claimedAt: srcMatch.claimedAt } : {}),
      ...(srcMatch.claimedBy ? { claimedBy: srcMatch.claimedBy } : {}),
      ...(srcMatch.result ? { result: srcMatch.result } : {}),
    };
  }

  // ── 8. Build new match history ───────────────────────────────────────────
  const newMatches = {};
  for (const [srcKey, srcMatch] of sourceMatches) {
    const tk = srcMatch.tournamentKey;
    let newRound, newRoundKey;

    if (LEAGUE_GROUP_MAP[tk]) {
      newRound = LEAGUE_GROUP_MAP[tk].newRound;
      newRoundKey = LEAGUE_GROUP_MAP[tk].newRoundKey;
    } else {
      const mapping = flightRoundMapping[tk];
      const mapped = mapping?.get(srcMatch.roundKey);
      if (!mapped) continue;
      newRound = mapped.newRoundName;
      newRoundKey = mapped.newRoundKey;
    }

    newMatches[`_UAE_TST_${srcKey}`] = {
      ...srcMatch,
      tournament: DISPLAY_NAME,
      tournamentKey: TK,
      round: newRound,
      roundKey: newRoundKey,
    };
  }

  // ── 9. Write in bulk ─────────────────────────────────────────────────────
  const roundCount = Object.keys(rounds).length;
  console.log(`\nWriting tournament + ${roundCount} rounds + groups + assignedPlayerIds (1 write)…`);
  fbSetBulk(`/tournaments/${TK}`, {
    name: DISPLAY_NAME,
    type: 'closed',
    country: 'AE',
    format: 'league',
    createdAt: now,
    createdBy: TAG,
    lastActive: now,
    leagueCfg: {
      groupCount: 8,
      playersPerGroup: 6,
      boardsPerGroup: 6,
      flightNames: ['Gold League', 'Silver League', 'Bronze League'],
    },
    rounds,
    groups,
    assignedPlayerIds,
  });
  console.log('  done');

  console.log(`\nWriting ${Object.keys(newPlanned).length} planned matches (1 bulk write)…`);
  fbUpdateBulk('/planned', newPlanned);
  console.log('  done');

  console.log(`\nWriting ${Object.keys(newMatches).length} match history records (1 bulk write)…`);
  fbUpdateBulk('/matches', newMatches);
  console.log('  done');

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n════════════════════════════════════════');
  console.log('Seed complete!');
  console.log(`  Tournament:     ${DISPLAY_NAME}`);
  console.log(`  Players:        ${allPlayerIds.size}`);
  console.log(`  Rounds:         ${roundCount} (8 groups + ${roundCount - 8} flight sub-rounds)`);
  console.log(`  Planned:        ${Object.keys(newPlanned).length}`);
  console.log(`  Match history:  ${Object.keys(newMatches).length}`);
  console.log('════════════════════════════════════════');
  console.log('\nVerification steps:');
  console.log('  1. Admin → Tournaments → "UAE League Test Tournament" with LEAGUE chip');
  console.log('  2. League Setup → Stage 1: 8 groups × 6 players, 15 matches each');
  console.log('  3. Stage 2: standings per group');
  console.log('  4. Reports → "UAE League Test Tournament"');
  console.log('     - Group standings section (8 groups)');
  console.log('     - Per-round breakdown: Gold League rounds, Silver League rounds, Bronze League rounds');
  console.log('     - Bracket SVG visible for each flight');
  console.log('\nTo clean up: node scripts/seed-uae-league-test.mjs --cleanup');
}

CLEANUP ? cleanup() : seed();
