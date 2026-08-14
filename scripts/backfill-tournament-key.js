/*
 * One-time backfill for /matches/{id}/tournamentKey.
 *
 * Paste into the DevTools Console on a page where you're signed in
 * as super-admin (any /carromscore/ tab works). It:
 *   - Grabs your Firebase ID token from IndexedDB (populated by
 *     the app's already-authenticated SDK).
 *   - Reads /matches via REST with that token.
 *   - For every record with `tournament` display name but no
 *     `tournamentKey`, PATCHes just that field with the slug.
 *   - Prints a summary.
 *
 * Rerunnable — records that already have tournamentKey are skipped.
 */
(async () => {
  const REGION = 'https://carrom-score-default-rtdb.firebaseio.com';
  // Firebase Web API keys are public identifiers, NOT secrets — see
  // https://firebase.google.com/docs/projects/api-keys and the
  // matching note in src/lib/firebase.ts.
  const API_KEY = 'AIzaSyAljLdG7WHQEcxUiVtX-KoASUe-VQP1BXw'; // gitleaks:allow  pragma: allowlist secret  trufflehog:ignore

  function normalizeKey(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  // The Firebase Auth SDK persists the current user in IndexedDB
  // under `firebaseLocalStorageDb` → object store `firebaseLocalStorage` →
  // key `firebase:authUser:<apiKey>:[DEFAULT]`. Read it directly so
  // we don't need to re-authenticate.
  async function getIdToken() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('firebaseLocalStorageDb');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('firebaseLocalStorage', 'readonly');
        const store = tx.objectStore('firebaseLocalStorage');
        const getReq = store.getAll();
        getReq.onerror = () => reject(getReq.error);
        getReq.onsuccess = () => {
          const rows = getReq.result || [];
          const authRow = rows.find((r) =>
            (r.fbase_key || '').startsWith('firebase:authUser:'),
          );
          if (!authRow) {
            reject(new Error('No signed-in user in IndexedDB. Sign in first.'));
            return;
          }
          const user = authRow.value;
          const refresh = user?.stsTokenManager?.refreshToken;
          const accessToken = user?.stsTokenManager?.accessToken;
          const expirationTime = user?.stsTokenManager?.expirationTime ?? 0;
          if (accessToken && Date.now() < expirationTime - 30_000) {
            resolve({ token: accessToken, uid: user.uid, email: user.email });
            return;
          }
          if (!refresh) {
            reject(new Error('No refresh token; sign out and back in.'));
            return;
          }
          // Access token expired — exchange the refresh for a fresh one.
          const body = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refresh,
          });
          fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
          })
            .then((r) => r.json())
            .then((j) => {
              if (!j.id_token) throw new Error('refresh failed: ' + JSON.stringify(j));
              resolve({ token: j.id_token, uid: user.uid, email: user.email });
            })
            .catch(reject);
        };
      };
    });
  }

  const auth = await getIdToken();
  console.log('Signed in as', auth.uid, auth.email);

  // Fetch /matches via REST with our token
  const matchesRes = await fetch(`${REGION}/matches.json?auth=${auth.token}`);
  if (!matchesRes.ok) {
    console.error('read failed', matchesRes.status, await matchesRes.text());
    return;
  }
  const all = (await matchesRes.json()) || {};

  const toPatch = [];
  for (const [mid, m] of Object.entries(all)) {
    const tour = (m?.tournament || '').trim();
    if (!tour) continue;
    if (m?.tournamentKey) continue;
    const key = normalizeKey(tour);
    if (!key) continue;
    toPatch.push([mid, tour, key]);
  }
  console.log(
    `plan: ${Object.keys(all).length} total matches; ${toPatch.length} need backfill`,
  );

  let ok = 0;
  let fail = 0;
  const errors = [];
  for (const [mid, tour, key] of toPatch) {
    try {
      const res = await fetch(`${REGION}/matches/${mid}.json?auth=${auth.token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournamentKey: key }),
      });
      if (!res.ok) {
        fail += 1;
        const text = await res.text();
        errors.push({ mid, tour, key, status: res.status, err: text });
      } else {
        ok += 1;
        if (ok % 5 === 0) console.log(`  patched ${ok}/${toPatch.length}`);
      }
    } catch (e) {
      fail += 1;
      errors.push({ mid, tour, key, err: String(e?.message || e) });
    }
  }
  console.log(`\nDONE: ${ok} patched, ${fail} failed`);
  if (fail) console.log('failures:', errors);
})();
