/**
 * One-shot backfill: write `country: "Unknown"` on every /players/{id}
 * record that doesn't already carry a country. Run once before v3.1's
 * mandatory-country UI ships so legacy records don't strand
 * (closed-tournament country matching sees them as "Unknown" and
 * warns as expected).
 *
 * Uses the Firebase Web SDK signed in as super via a token you supply
 * — same approach as scripts/backfill-tournament-key.js which shipped
 * against v2.2.x. Reads PUBLIC_FIREBASE_API_KEY from .env; requires
 * you to be signed in as a super-admin (paste your ID token below).
 *
 * Usage:
 *   1. Sign in as super on the live site, open DevTools → Application
 *      → IndexedDB → firebaseLocalStorageDB → firebaseLocalStorage.
 *      Copy the `accessToken` string for your uid.
 *   2. `FIREBASE_ID_TOKEN=<paste> node scripts/backfill-player-country.mjs`
 *
 * Silent-on-single-record-failure: any /players/{id} that fails its
 * update (rules denial, network) is logged but the loop keeps going.
 * At the end you get a summary of skipped / updated / failed counts.
 *
 * Idempotent: re-running is safe — records with country already set
 * are skipped.
 */

import { config as dotenvConfig } from 'dotenv';
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithCustomToken } from 'firebase/auth';
import { getDatabase, ref, get, update } from 'firebase/database';

dotenvConfig();

const apiKey = process.env.PUBLIC_FIREBASE_API_KEY;
if (!apiKey) {
  console.error('PUBLIC_FIREBASE_API_KEY not set in .env — cannot proceed');
  process.exit(1);
}

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

const app = initializeApp({
  apiKey,
  authDomain: 'carrom-score.firebaseapp.com',
  databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com',
  projectId: 'carrom-score',
});

// Note: signInWithCustomToken needs a custom token minted by Firebase
// Admin SDK (server-side). For a client-side ID token, the Firebase
// Web SDK re-uses it via the internal rest transport when passed as a
// Bearer header. Simpler path: use the REST API directly since we
// already have a valid ID token.
//
// Path: https://carrom-score-default-rtdb.firebaseio.com/players.json?auth=$idToken

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

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
