/**
 * Role resolution for the current authenticated user.
 *
 * Data model (RTDB):
 *   /adminRoles/{uid}                       → "super"
 *   /tournaments/{key}/organisers/{uid}     → true
 *
 * The client subscribes to both paths, filtered to the currently
 * signed-in user, and merges the results into a single reactive
 * `Role` view. Any component that renders admin affordances can
 * gate on this — the rules in `database.rules.json` are what
 * actually enforce it; UI-only gating is theatre.
 *
 * Lazy-imports `firebase/database` on first subscribe. Silent-on-
 * failure per house style — if Firebase is unreachable, subscribers
 * see `null` (i.e. anonymous view) and everything downstream just
 * doesn't show admin controls.
 */

export type Role = {
  isSuper: boolean;
  /** Set of tournament keys (normalised slug) where this user is an organiser. */
  organiserOf: Set<string>;
};

// Module-level state keyed by uid so switching accounts (rare, but
// possible) refreshes the subscription cleanly.
let activeUid: string | null = null;
let cachedRole: Role | null = null;
let listeners = new Set<(r: Role | null) => void>();
let adminRolesUnsub: (() => void) | null = null;
let tournamentsUnsub: (() => void) | null = null;

function notify(): void {
  for (const fn of listeners) fn(cachedRole);
}

/**
 * Subscribe to the current user's role. Fires synchronously once
 * with the cached role (or `null` if not yet resolved / signed out),
 * then on every subsequent change.
 *
 * The caller MUST also drive the auth subscription elsewhere so
 * `setCurrentUidForRoles()` gets called when auth state changes —
 * `SignInButton.svelte` handles that plumbing.
 */
export function subscribeCurrentUserRole(fn: (r: Role | null) => void): () => void {
  listeners.add(fn);
  fn(cachedRole);
  return () => listeners.delete(fn);
}

/**
 * Notify the roles module that the auth user has changed. Called by
 * the auth-subscribed sign-in button. Handles three transitions:
 *
 *   null    → uid    : start listening on /adminRoles/{uid} + /tournaments
 *   uid     → uid'   : stop old listens, start new
 *   uid     → null   : stop listens, clear cached role
 */
export function setCurrentUidForRoles(uid: string | null): void {
  if (uid === activeUid) return;
  activeUid = uid;
  // Tear down previous listens if any.
  adminRolesUnsub?.();
  adminRolesUnsub = null;
  tournamentsUnsub?.();
  tournamentsUnsub = null;
  if (!uid) {
    cachedRole = null;
    notify();
    return;
  }
  // Fresh subscription. Emit an empty role immediately so subscribers
  // can render an "empty admin" state while we wait for the two
  // RTDB reads to settle; they'll be updated as the snapshots arrive.
  cachedRole = { isSuper: false, organiserOf: new Set() };
  notify();
  void attachListeners(uid);
}

async function attachListeners(uid: string): Promise<void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // Guard against a fast-follow uid change while imports were resolving.
    if (activeUid !== uid) return;

    // Super-admin listen: /adminRoles/{uid} → "super" | null
    adminRolesUnsub = onValue(
      ref(db, `adminRoles/${uid}`),
      (snap) => {
        if (activeUid !== uid || !cachedRole) return;
        const val = snap.val();
        cachedRole = { ...cachedRole, isSuper: val === 'super' };
        notify();
      },
      () => {
        // Read denied (unauthenticated in a race) — leave existing.
      },
    );

    // Organiser listen: full /tournaments snapshot, filtered to
    // entries with organisers/{uid} == true. Tournaments node is tiny
    // (dozens of records at most) so subscribing to the whole map is
    // cheap. If we ever cross into hundreds, invert this into
    // /userTournaments/{uid} — noted in the plan.
    tournamentsUnsub = onValue(
      ref(db, 'tournaments'),
      (snap) => {
        if (activeUid !== uid || !cachedRole) return;
        const raw = snap.val() as Record<string, unknown> | null;
        const next = new Set<string>();
        if (raw) {
          for (const [key, val] of Object.entries(raw)) {
            if (!val || typeof val !== 'object') continue;
            const organisers = (val as { organisers?: Record<string, unknown> })
              .organisers;
            if (organisers && organisers[uid] === true) {
              next.add(key);
            }
          }
        }
        cachedRole = { ...cachedRole, organiserOf: next };
        notify();
      },
      () => {},
    );
  } catch {
    // Firebase unreachable — role stays empty, admin controls stay hidden.
  }
}

/**
 * One-time self-promotion: if `/adminRoles` is empty AND the incoming
 * uid matches the bootstrap env var (`PUBLIC_BOOTSTRAP_SUPER_UID`),
 * write `/adminRoles/{uid} = "super"`. Silent-on-failure. Returns
 * `true` on success, `false` otherwise.
 *
 * The rule at `/adminRoles/{$uid}` mirrors this check server-side so
 * a client tampering with the env var can't self-promote once a super
 * already exists.
 */
export async function bootstrapSuperIfNeeded(uid: string): Promise<boolean> {
  const target = (import.meta.env.PUBLIC_BOOTSTRAP_SUPER_UID as string | undefined)?.trim();
  if (!target) return false;
  if (target !== uid) return false;
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'adminRoles'));
    if (snap.exists()) return false;
    await set(ref(db, `adminRoles/${uid}`), 'super');
    return true;
  } catch {
    return false;
  }
}

/**
 * Admin-only: one-shot load of every `/adminRoles/{uid}` entry.
 * Returned as a plain map keyed by UID. Fine to call from the
 * admin panel; not a subscription — callers reload manually.
 */
export async function loadAllAdminRoles(): Promise<Record<string, 'super'>> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'adminRoles'));
    const raw = snap.val() as Record<string, unknown> | null;
    if (!raw) return {};
    const out: Record<string, 'super'> = {};
    for (const [uid, val] of Object.entries(raw)) {
      if (val === 'super') out[uid] = 'super';
    }
    return out;
  } catch {
    return {};
  }
}

/** Test hook — reset state between assertions. */
export function _resetForTests(): void {
  activeUid = null;
  cachedRole = null;
  listeners = new Set();
  adminRolesUnsub?.();
  adminRolesUnsub = null;
  tournamentsUnsub?.();
  tournamentsUnsub = null;
}
