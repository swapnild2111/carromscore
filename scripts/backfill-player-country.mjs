/**
 * One-shot backfill: write `country: "Unknown"` on every /players/{id}
 * record that doesn't already carry a country. Run once before v3.1's
 * mandatory-country UI ships so legacy records don't strand.
 *
 * Uses RTDB REST directly — no Firebase SDK dependency, no dotenv,
 * just plain Node fetch. Reads PUBLIC_FIREBASE_API_KEY from .env
 * (parsed inline) and FIREBASE_ID_TOKEN from the environment.
 *
 * Usage:
 *   1. Sign in as super on the live site. In DevTools →
 *      Application → IndexedDB → firebaseLocalStorageDB →
 *      firebaseLocalStorage → your uid entry → expand value →
 *      value.stsTokenManager.accessToken. Copy the whole string
 *      (~1000 chars).
 *   2. From the repo root:
 *
 *      FIREBASE_ID_TOKEN=<paste> node scripts/backfill-player-country.mjs
 *
 * Idempotent: re-running is safe. Records with a non-empty country
 * are skipped. Failures on a single record are logged; the loop
 * continues. Summary at the end.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Config ─────────────────────────────────────────────────────────

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

// ─── Env parsing (inline; no dotenv dep) ────────────────────────────

/**
 * Parse a minimal `.env` file. Supports KEY=VALUE with optional
 * surrounding quotes, ignores blank/comment lines. Populates
 * process.env for any key not already set.
 */
function loadDotenv() {
  const envPath = resolve(process.cwd(), '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    if (process.env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}

loadDotenv();

const idToken = process.env.FIREBASE_ID_TOKEN;
if (!idToken) {
  console.error(
    'FIREBASE_ID_TOKEN not set. Grab it from your signed-in browser session:',
  );
  console.error(
    '  DevTools → Application → IndexedDB → firebaseLocalStorageDB → firebaseLocalStorage',
  );
  console.error("  → your uid entry → value.stsTokenManager.accessToken");
  process.exit(1);
}

// ─── RTDB REST helpers ──────────────────────────────────────────────

async function fetchAllPlayers() {
  const res = await fetch(`${DB_URL}/players.json?auth=${idToken}`);
  if (!res.ok) {
    throw new Error(`fetch /players failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function patchPlayer(id, patch) {
  const res = await fetch(`${DB_URL}/players/${id}.json?auth=${idToken}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    throw new Error(`patch /players/${id} failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('Loading /players from RTDB…');
  const players = await fetchAllPlayers();
  if (!players) {
    console.log('No players found. Nothing to backfill.');
    return;
  }

  const ids = Object.keys(players);
  console.log(`Found ${ids.length} player records.`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  for (const id of ids) {
    const p = players[id];
    if (!p || typeof p !== 'object') {
      skipped += 1;
      continue;
    }
    if (typeof p.country === 'string' && p.country.length > 0) {
      skipped += 1;
      continue;
    }
    try {
      await patchPlayer(id, { country: 'Unknown' });
      updated += 1;
      if (updated % 25 === 0) console.log(`  … ${updated} updated`);
    } catch (err) {
      failed += 1;
      failures.push({ id, error: err.message });
    }
  }

  console.log('');
  console.log(`Summary:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already has country): ${skipped}`);
  console.log(`  Failed: ${failed}`);
  if (failures.length > 0) {
    console.log('Failures:');
    for (const f of failures.slice(0, 10)) console.log(`  ${f.id}: ${f.error}`);
    if (failures.length > 10) console.log(`  … + ${failures.length - 10} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
