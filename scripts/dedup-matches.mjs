/**
 * Dedup matches in Firebase RTDB.
 *
 * Uses firebase-admin with Application Default Credentials (your
 * `firebase login` session) — bypasses security rules entirely.
 *
 * Duplicate detection: two matches are duplicates when they share the
 * same aName, bName, mode, startedAt and endedAt. Among duplicates,
 * the record with the MOST data (longest JSON) is kept; the rest are
 * deleted.
 *
 * Usage:
 *   node scripts/dedup-matches.mjs [--dry-run]
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

const DRY_RUN = process.argv.includes('--dry-run');

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com',
});

const db = getDatabase();

console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no deletions)' : 'LIVE (will delete)'}\n`);

const snap = await db.ref('matches').once('value');
const raw = snap.val();
if (!raw) {
  console.log('No matches found.');
  process.exit(0);
}

const records = Object.entries(raw).map(([id, v]) => ({ id, ...v }));
console.log(`Loaded ${records.length} match records.`);

// Debug: print all matches for the Inter_Ministry tournament sorted by endedAt
const tournament = process.argv.find(a => a.startsWith('--tournament='))?.split('=')[1];
if (tournament) {
  const filtered = records
    .filter(r => (r.tournamentKey ?? '').toLowerCase().includes(tournament.toLowerCase()) || (r.tournament ?? '').toLowerCase().includes(tournament.toLowerCase()))
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  console.log(`\n=== ${filtered.length} matches for tournament "${tournament}" ===`);
  for (const r of filtered) {
    console.log(`  ${r.id}  ${r.aName} vs ${r.bName}  started=${r.startedAt}  ended=${r.endedAt}  sets=${r.result?.setsA}-${r.result?.setsB}`);
  }
  process.exit(0);
}

// Group by composite key: mode|aName|bName|startedAt
// Deliberately excludes endedAt — double-submissions from a shaky
// connection can produce two records with the same startedAt but
// endedAt values a few seconds/minutes apart.
const groups = new Map();
for (const r of records) {
  const key = [
    r.mode ?? '',
    r.aName ?? '',
    r.bName ?? '',
    String(r.startedAt ?? ''),
  ].join('|');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const dupeGroups = [...groups.values()].filter((g) => g.length > 1);
console.log(`Found ${dupeGroups.length} duplicate group(s).\n`);

if (dupeGroups.length === 0) {
  console.log('Nothing to delete.');
  process.exit(0);
}

let totalDeleted = 0;
for (const group of dupeGroups) {
  // Keep the record with the most data (largest JSON size).
  group.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length);
  const [keep, ...toDelete] = group;

  console.log(`--- Duplicate group (${group.length} records) ---`);
  console.log(`  KEEP   ${keep.id}  ${keep.aName} vs ${keep.bName}  started=${keep.startedAt}`);
  for (const r of toDelete) {
    console.log(`  DELETE ${r.id}  ${r.aName} vs ${r.bName}  started=${r.startedAt}`);
    if (!DRY_RUN) {
      await db.ref(`matches/${r.id}`).remove();
    }
    totalDeleted++;
  }
}

console.log(`\n${DRY_RUN ? '[DRY RUN] Would delete' : 'Deleted'} ${totalDeleted} duplicate record(s).`);
process.exit(0);
