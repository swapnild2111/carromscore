/**
 * Restores the 14 real Silver tournament matches that were accidentally re-tagged
 * to 'uae-league-test-tournament' back to their original tournament.
 *
 * Run: node scripts/restore-silver-real-tournament.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = '--project carrom-score --instance carrom-score-default-rtdb';
const REAL_KEY = '3rd-singles-ranking-knock-out-round-of-16-silver';
const REAL_NAME = '3rd Singles Ranking - Knock out Round of 16 - SILVER';

function fbUpdateBulk(path, data) {
  const tmpFile = join(tmpdir(), `fb-update-${Date.now()}.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify(data));
    execSync(`firebase database:update -f "${path}" ${CLI} "${tmpFile}"`, { stdio: 'pipe' });
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

const keys = [
  '-P0qwThUKlJxrmTFc2Y2', '-P0qwd1fg2tQNc_Yyp3f', '-P0r2qibQo1LzkjxHJ5n',
  '-P0r55k5cCcSUYUUwQ_j', '-P0r5jPtf8qD_BKE1Qfo', '-P0r8VeBwoLqmPMYSFn7',
  '-P0rCD1KP9RBIUikLSOC', '-P0rJA3akVHbl6YDr_I3', '-P0rL3KmtDd5sHcXdPEG',
  '-P0rLKixJ0mY-qbrG5za', '-P0rNsGDYvetb1qA_YSu', '-P0rYIhordNZ10cGqNvu',
  '-P0rYkg-NN3ImTjKbAjb', '-P0rmR8IMEMdxaTe6jwf',
];

// Restore tournamentKey + tournament; null out the Silver League round tags we added
const patch = {};
for (const k of keys) {
  patch[`${k}/tournamentKey`] = REAL_KEY;
  patch[`${k}/tournament`]    = REAL_NAME;
  patch[`${k}/round`]         = null;
  patch[`${k}/roundKey`]      = null;
}

console.log(`Restoring ${keys.length} matches to '${REAL_KEY}'…`);
fbUpdateBulk('/matches', patch);
console.log('Done. Refresh the real Silver tournament URL to verify.');
