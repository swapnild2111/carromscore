/**
 * One-shot backfill: for every /matches/{id} record that is missing
 * playerAId or playerBId (or A2/B2), look up the raw name against
 * /players and patch the missing field in-place.
 *
 * Fixes the leaderboard "duplicate player" bug where matches scored
 * without using the name-picker produced name-only keys instead of
 * Firebase player IDs.
 *
 * Uses RTDB REST directly — no Firebase SDK, no dotenv.
 *
 * Usage:
 *   1. Sign in as super on the live site. Open DevTools →
 *      Application → IndexedDB → firebaseLocalStorageDB →
 *      firebaseLocalStorage → your uid entry → expand value →
 *      value.stsTokenManager.accessToken. Copy the whole string.
 *   2. From the repo root:
 *
 *      FIREBASE_ID_TOKEN=<paste> node scripts/backfill-player-ids.mjs
 *
 *   Optional: limit to one tournament
 *      TOURNAMENT_KEY=uae-ranking-tournament-2026 FIREBASE_ID_TOKEN=<paste> node scripts/backfill-player-ids.mjs
 *
 * Idempotent: records where all present name fields already have IDs
 * are skipped. Failures on a single record are logged; loop continues.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

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

const TOKEN = process.env.FIREBASE_ID_TOKEN;
const API_KEY = process.env.PUBLIC_FIREBASE_API_KEY;
const TOURNAMENT_KEY = process.env.TOURNAMENT_KEY ?? '';

if (!TOKEN) {
  console.error('Error: FIREBASE_ID_TOKEN not set.');
  process.exit(1);
}

function authParam() {
  return `auth=${encodeURIComponent(TOKEN)}`;
}

async function rtdbGet(path) {
  const url = `${DB_URL}/${path}.json?${authParam()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function rtdbPatch(path, data) {
  const url = `${DB_URL}/${path}.json?${authParam()}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

/** Normalise a name for lookup: lowercase, collapse whitespace. */
function normName(s) {
  return (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main() {
  console.log('Loading /players…');
  const playersRaw = await rtdbGet('players');
  if (!playersRaw) {
    console.error('No players found at /players — aborting.');
    process.exit(1);
  }

  // Build a name → id map. When multiple players share a name, all
  // are kept (array). Collision is logged; the script skips ambiguous
  // names rather than guessing.
  /** @type {Map<string, string[]>} */
  const nameToIds = new Map();
  for (const [id, p] of Object.entries(playersRaw)) {
    const canonical = normName(p.canonicalName);
    if (!canonical) continue;
    const all = nameToIds.get(canonical) ?? [];
    all.push(id);
    nameToIds.set(canonical, all);
    // Also index aliases
    if (Array.isArray(p.aliases)) {
      for (const alias of p.aliases) {
        const a = normName(alias);
        if (!a || a === canonical) continue;
        const aliasAll = nameToIds.get(a) ?? [];
        aliasAll.push(id);
        nameToIds.set(a, aliasAll);
      }
    }
  }
  console.log(`Loaded ${Object.keys(playersRaw).length} players, ${nameToIds.size} name entries.`);

  console.log('Loading /matches…');
  const matchesRaw = await rtdbGet('matches');
  if (!matchesRaw) {
    console.log('No matches found — nothing to do.');
    return;
  }

  const total = Object.keys(matchesRaw).length;
  console.log(`Loaded ${total} matches.`);

  let checked = 0, patched = 0, skipped = 0, errors = 0;

  // Slots: [fieldName, idFieldName]
  const SLOTS = [
    ['aName', 'playerAId'],
    ['a2Name', 'playerA2Id'],
    ['bName', 'playerBId'],
    ['b2Name', 'playerB2Id'],
  ];

  for (const [mid, m] of Object.entries(matchesRaw)) {
    // Filter to specific tournament if requested
    if (TOURNAMENT_KEY && m.tournamentKey !== TOURNAMENT_KEY) continue;

    checked++;
    const patch = {};

    for (const [nameField, idField] of SLOTS) {
      const rawName = (m[nameField] ?? '').trim();
      if (!rawName) continue;              // empty slot (practice, singles)
      if (m[idField]) continue;            // id already present — skip

      const norm = normName(rawName);
      const ids = nameToIds.get(norm);
      if (!ids) {
        console.log(`  [${mid}] ${nameField}="${rawName}" — no match in /players (skipping)`);
        skipped++;
        continue;
      }
      if (ids.length > 1) {
        console.log(`  [${mid}] ${nameField}="${rawName}" — ambiguous (${ids.length} players), skipping`);
        skipped++;
        continue;
      }
      patch[idField] = ids[0];
    }

    if (Object.keys(patch).length === 0) continue;

    const patchDesc = Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`  Patching ${mid}: ${patchDesc}`);
    try {
      await rtdbPatch(`matches/${mid}`, patch);
      patched++;
    } catch (err) {
      console.error(`  ERROR patching ${mid}: ${err.message}`);
      errors++;
    }
  }

  console.log('');
  console.log(`Done. Checked: ${checked}, Patched: ${patched}, Skipped (ambiguous/unknown): ${skipped}, Errors: ${errors}`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
