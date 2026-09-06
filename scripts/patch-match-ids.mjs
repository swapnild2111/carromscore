/**
 * Targeted patch: write playerAId/playerBId onto specific match records,
 * or delete duplicate match records.
 *
 * Usage:
 *   1. Sign in as super on the live site. Open DevTools →
 *      Application → IndexedDB → firebaseLocalStorageDB →
 *      firebaseLocalStorage → your uid entry → value →
 *      stsTokenManager → copy accessToken.
 *   2. FIREBASE_ID_TOKEN=<token> node scripts/patch-match-ids.mjs
 */

const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';
const TOKEN = process.env.FIREBASE_ID_TOKEN;

if (!TOKEN) {
  console.error('Set FIREBASE_ID_TOKEN env var (copy accessToken from DevTools IndexedDB)');
  process.exit(1);
}

// Patches: { mid, patch }
const PATCHES = [
  {
    mid: '-P0q13mLuaQ1cNaDKw_Z',
    patch: {
      playerAId: 'amanulla-basheer-sab-19pu',
      playerBId: 'vijay-pillai-6nqa',
    },
    desc: 'Amanulla Basheer Sab vs Vijay Pillai (League B)',
  },
];

// Deletions: duplicate match records to remove (keep only the latest/correct one)
// League D duplicates — Abdul Rahman (Ilyas) had multiple identical matches recorded within seconds
const DELETES = [
  // AR vs Shaikh Mohammed Ibrahim — 3 recorded, keep latest (-P0pE36HiDApkUELSNzl)
  { mid: '-P0p9AbDVwTU00IfmKyL', desc: 'AR(Ilyas) vs Shaikh SMI dup #1 (League D)' },
  { mid: '-P0p9GlR7-90oa519LoC', desc: 'AR(Ilyas) vs Shaikh SMI dup #2 (League D)' },
  // AR vs Vikas Anant Jadhav — 4 recorded, keep latest (-P0pIwppmm5OHqUgLeF9)
  { mid: '-P0pIhAFZhRYx-8e1F16', desc: 'AR(Ilyas) vs Vikas dup #1 (League D)' },
  { mid: '-P0pIr5dQOwOgjWzGPDZ', desc: 'AR(Ilyas) vs Vikas dup #2 (League D)' },
  { mid: '-P0pItrRRs56ckGPpU1U', desc: 'AR(Ilyas) vs Vikas dup #3 (League D)' },
  // AR vs Syed Mujahed Hussain — 2 recorded 15s apart (0-1 then 0-2), keep latest (-P0pb3s-)
  { mid: '-P0pb0EQk7lAFOl7AM1z', desc: 'AR(Ilyas) vs Syed Mujahed dup (League D)' },
];

for (const { mid, patch, desc } of PATCHES) {
  const url = `${DB_URL}/matches/${mid}.json?auth=${TOKEN}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await res.json();
  if (body?.error) {
    console.error(`✗ ${mid} (${desc}):`, body.error);
  } else {
    console.log(`✓ ${mid} (${desc}) — patched playerAId + playerBId`);
  }
}

for (const { mid, desc } of DELETES) {
  const url = `${DB_URL}/matches/${mid}.json?auth=${TOKEN}`;
  const res = await fetch(url, { method: 'DELETE' });
  if (res.ok) {
    console.log(`✓ ${mid} (${desc}) — deleted`);
  } else {
    const body = await res.json().catch(() => ({}));
    console.error(`✗ ${mid} (${desc}):`, body?.error ?? res.status);
  }
}
