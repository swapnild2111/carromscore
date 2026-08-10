/**
 * Firebase Auth — thin wrapper mirroring the lazy-import + silent-on-
 * failure pattern of `players.ts` / `history.ts` / `live-sync.ts`.
 *
 * The public surface is intentionally minimal: sign in with Google,
 * sign out, subscribe to auth state, snapshot current user. All of it
 * is on top of the `firebase/auth` module which we dynamic-import on
 * first use — casual users who never sign in do not pay for the ~35 KB
 * gzipped chunk.
 *
 * Silent-on-failure per house style: popup blocked, network dead, SDK
 * failed to load → subscribers keep receiving `null`, callers never
 * throw. Anonymous-only users see nothing new.
 *
 * iOS-Safari resilience: `signInWithPopup` sometimes fails silently on
 * iOS. We fall back to `signInWithRedirect` + `getRedirectResult` on
 * bootstrap so the sign-in flow eventually completes even when the
 * popup was blocked.
 */

export type AuthUser = {
  uid: string;
  email: string;
  displayName: string;
  photoURL: string | null;
};

// Module-level cache so synchronous consumers can peek at the last-known
// user without having to await a subscription. Updated by every fire of
// `onAuthStateChanged` and by the redirect-result bootstrap.
let cachedUser: AuthUser | null = null;
let listeners = new Set<(u: AuthUser | null) => void>();
let subscriptionInitialised = false;

function notify(): void {
  for (const fn of listeners) fn(cachedUser);
}

/**
 * Snapshot the current user synchronously. Returns `null` when
 * signed out, when the auth SDK has not yet loaded, or when it has
 * loaded but not yet rehydrated from IndexedDB. Callers that need
 * post-hydration accuracy should use `subscribeAuth` instead.
 */
export function currentUser(): AuthUser | null {
  return cachedUser;
}

/**
 * Register a callback to receive auth state updates. Fires
 * synchronously once with the currently-cached user (so subscribers
 * do not have to render a "logged out" flash while the SDK settles),
 * then on every subsequent state change.
 *
 * The first call also lazily attaches the underlying
 * `onAuthStateChanged` + processes any redirect result — this is what
 * pulls the auth chunk into the bundle. Home-page code that never
 * calls this stays clean.
 */
export function subscribeAuth(fn: (u: AuthUser | null) => void): () => void {
  listeners.add(fn);
  // Synchronous first-call so components render with the cached user
  // right away.
  fn(cachedUser);
  if (!subscriptionInitialised) {
    subscriptionInitialised = true;
    void initSubscription();
  }
  return () => listeners.delete(fn);
}

function toAuthUser(u: unknown): AuthUser | null {
  if (!u || typeof u !== 'object') return null;
  const v = u as {
    uid?: unknown;
    email?: unknown;
    displayName?: unknown;
    photoURL?: unknown;
  };
  if (typeof v.uid !== 'string' || !v.uid) return null;
  return {
    uid: v.uid,
    email: typeof v.email === 'string' ? v.email : '',
    displayName: typeof v.displayName === 'string' ? v.displayName : '',
    photoURL: typeof v.photoURL === 'string' ? v.photoURL : null,
  };
}

async function initSubscription(): Promise<void> {
  try {
    const [{ firebaseApp }, { getAuth, onAuthStateChanged, getRedirectResult }] =
      await Promise.all([import('./firebase'), import('firebase/auth')]);
    const auth = getAuth(firebaseApp());
    // Consume any pending redirect result from a previous
    // signInWithRedirect() call — iOS Safari path. Fires before
    // onAuthStateChanged emits, so we surface the user immediately.
    try {
      const redirect = await getRedirectResult(auth);
      if (redirect?.user) {
        cachedUser = toAuthUser(redirect.user);
        notify();
      }
    } catch {
      // Redirect flow failed — fall through; anonymous stays anonymous.
    }
    onAuthStateChanged(auth, (u) => {
      cachedUser = toAuthUser(u);
      notify();
    });
  } catch {
    // firebase/auth failed to load (bundle missing, network dead).
    // Subscribers stay on null; casual anonymous flow works unchanged.
  }
}

/**
 * Trigger Google sign-in. Silent-on-failure: popup blocked / user
 * closed dialog / network error → cached user stays as-is, subscribers
 * receive nothing new. On success `onAuthStateChanged` fires and
 * notifies subscribers with the new user.
 *
 * iOS Safari note: `signInWithPopup` fails silently on some iOS
 * builds. We fall back to `signInWithRedirect` when the popup path
 * throws a known "popup-blocked" style error. `getRedirectResult`
 * on next boot completes the flow.
 */
export async function signIn(): Promise<void> {
  try {
    const [
      { firebaseApp },
      { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect },
    ] = await Promise.all([import('./firebase'), import('firebase/auth')]);
    const auth = getAuth(firebaseApp());
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (popupErr: unknown) {
      // Known error codes that indicate the popup couldn't open —
      // fall back to redirect flow. Everything else (user closed the
      // dialog, network) is a legitimate cancel and we don't retry.
      let code = '';
      if (popupErr && typeof popupErr === 'object' && 'code' in popupErr) {
        const raw = (popupErr as { code: unknown }).code;
        if (typeof raw === 'string') code = raw;
      }
      const shouldFallback =
        code === 'auth/popup-blocked' ||
        code === 'auth/operation-not-supported-in-this-environment' ||
        code === 'auth/cancelled-popup-request';
      if (shouldFallback) {
        try {
          await signInWithRedirect(auth, provider);
        } catch {
          // Redirect failed too — give up silently.
        }
      }
    }
  } catch {
    // Bundle failed to load. Silent — sign-in button just does nothing.
  }
}

/**
 * Sign out the current user. Silent-on-failure. After success
 * `onAuthStateChanged` emits `null` and subscribers refresh.
 */
export async function signOut(): Promise<void> {
  try {
    const [{ firebaseApp }, { getAuth, signOut: fbSignOut }] = await Promise.all([
      import('./firebase'),
      import('firebase/auth'),
    ]);
    await fbSignOut(getAuth(firebaseApp()));
  } catch {
    // Ignore — worst case the user sees stale "signed in" chrome
    // until reload.
  }
}
