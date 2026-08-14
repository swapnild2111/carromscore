/**
 * Firebase initialisation. One-time bootstrap for the whole app.
 *
 * The config below is safe to commit — these keys identify the Firebase
 * project (Google-side plumbing to route requests), not the user. Every
 * request is gated by the Realtime Database security rules in
 * `database.rules.json`. Public rules → anyone with the config can read
 * matches + players; write rules cap what shapes they can push. That's
 * the entire security model. See Firebase's own doc:
 *   https://firebase.google.com/docs/projects/api-keys
 *
 * Analytics: intentionally NOT imported. We don't want Firebase's
 * page-view tracking loaded in the client — it doesn't fit the app's
 * "no accounts, no cloud" story.
 *
 * Bundle-size discipline: this module is small (config + init only).
 * The heavy `firebase/database` import is dynamic-loaded lazily by
 * `players.ts` / `history.ts` / `live-sync.ts` on first use, so users
 * who never open a live match or the History page don't pay for it.
 */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';

// Firebase Web API keys are public identifiers, NOT secrets — per
// https://firebase.google.com/docs/projects/api-keys — access control
// is enforced by database.rules.json, not by this key. The key is
// also shipped verbatim in the client bundle to every visitor.
// Suppresses false-positive alerts from generic secret scanners
// (gitleaks, trufflehog, GitHub secret scanning).
const firebaseConfig = {
  apiKey: 'AIzaSyAljLdG7WHQEcxUiVtX-KoASUe-VQP1BXw', // gitleaks:allow  pragma: allowlist secret  trufflehog:ignore
  authDomain: 'carrom-score.firebaseapp.com',
  databaseURL: 'https://carrom-score-default-rtdb.firebaseio.com',
  projectId: 'carrom-score',
  storageBucket: 'carrom-score.firebasestorage.app',
  messagingSenderId: '890319805819',
  appId: '1:890319805819:web:4ff96133e0bca93f5bb1de',
};

let cached: FirebaseApp | null = null;

export function firebaseApp(): FirebaseApp {
  if (cached) return cached;
  // getApps() guards against duplicate-init when the module gets
  // imported via multiple entry points (SSR + client hydration).
  const existing = getApps();
  cached = existing.length > 0 ? existing[0]! : initializeApp(firebaseConfig);
  return cached;
}
