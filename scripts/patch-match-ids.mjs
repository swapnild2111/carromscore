/**
 * Targeted patch: write playerAId/playerBId onto specific match records.
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
