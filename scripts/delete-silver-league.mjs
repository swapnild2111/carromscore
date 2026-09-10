/**
 * Deletes all Silver League data from UAE League Test Tournament so it can be
 * re-generated with the corrected 8-player seeding.
 *
 * Removes:
 *   - All /planned matches with tournamentKey=uae-league-test-tournament and round starting with "Silver League"
 *   - All /matches records with tournamentKey=uae-league-test-tournament and round starting with "Silver League"
 *   - All silver-league-* round keys from /tournaments/uae-league-test-tournament/rounds
 *
 * Run: node scripts/delete-silver-league.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = '--project carrom-score --instance carrom-score-default-rtdb';
const TOURNAMENT_KEY = 'uae-league-test-tournament';

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

function fbDelete(path) {
  // Use update with null to delete a node (avoids --confirm flag issues with some CLI versions)
  const tmpFile = join(tmpdir(), `fb-delete-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, 'null');
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

// ── 1. Delete Silver League planned matches ───────────────────────────────────
console.log('\n1. Fetching /planned…');
const planned = fbGet('/planned');
const silverPlanned = Object.entries(planned || {}).filter(([, v]) =>
  v && v.tournamentKey === TOURNAMENT_KEY && v.round && v.round.startsWith('Silver League')
);
console.log(`   Found ${silverPlanned.length} planned Silver League matches`);

for (const [key] of silverPlanned) {
  console.log(`   Deleting /planned/${key}`);
  fbDelete(`/planned/${key}`);
}

// ── 2. Delete Silver League archived matches ──────────────────────────────────
console.log('\n2. Fetching /matches…');
const matches = fbGet('/matches');
const silverArchived = Object.entries(matches || {}).filter(([, v]) =>
  v && v.tournamentKey === TOURNAMENT_KEY && v.round && v.round.startsWith('Silver League')
);
console.log(`   Found ${silverArchived.length} archived Silver League matches`);

for (const [key] of silverArchived) {
  console.log(`   Deleting /matches/${key}`);
  fbDelete(`/matches/${key}`);
}

// ── 3. Delete Silver League rounds from tournament ────────────────────────────
console.log('\n3. Fetching tournament rounds…');
const rounds = fbGet(`/tournaments/${TOURNAMENT_KEY}/rounds`);
const silverRoundKeys = Object.keys(rounds || {}).filter((k) => k.startsWith('silver-league'));
console.log(`   Found ${silverRoundKeys.length} Silver League rounds:`, silverRoundKeys);

const nullPatch = {};
for (const k of silverRoundKeys) {
  nullPatch[k] = null;
}
if (Object.keys(nullPatch).length > 0) {
  fbUpdateBulk(`/tournaments/${TOURNAMENT_KEY}/rounds`, nullPatch);
  console.log('   Deleted round keys via null patch');
}

console.log('\nDone. Silver League data removed.');
console.log('Now open the League Matches tab for UAE League Test Tournament');
console.log('and click "Generate league matches →" to re-seed with correct 8 players.');
