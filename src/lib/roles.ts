/**
 * Role resolution for the current authenticated user.
 *
 * Data model (RTDB):
 *   /adminRoles/{uid}       → "super"
 *   /organiserRoles/{uid}   → true
 *
 * The client subscribes to both paths, filtered to the currently
 * signed-in user, and merges the results into a single reactive
 * `Role` view. Any component that renders admin affordances can
 * gate on this — the rules in `database.rules.json` are what
 * actually enforce it; UI-only gating is theatre.
 *
 * v3.3 changed the organiser model from per-tournament
 * (`/tournaments/{key}/organisers/{uid}`) to a first-class global
 * role (`/organiserRoles/{uid}`). Own-only auth is applied at every
 * consumer of `Role` via the tournament / player record's
 * `createdBy` field; this module only tells you "does this user
 * hold the organiser role at all".
 *
 * Lazy-imports `firebase/database` on first subscribe. Silent-on-
 * failure per house style — if Firebase is unreachable, subscribers
 * see `null` (i.e. anonymous view) and everything downstream just
 * doesn't show admin controls.
 */

export type Role = {
  isSuper: boolean;
  /** True when the user holds the global organiser role. */
  isOrganiser: boolean;
};

// Module-level state keyed by uid so switching accounts (rare, but
// possible) refreshes the subscription cleanly.
let activeUid: string | null = null;
let cachedRole: Role | null = null;
let listeners = new Set<(r: Role | null) => void>();
let adminRolesUnsub: (() => void) | null = null;
let organiserRolesUnsub: (() => void) | null = null;

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
 *   null    → uid    : start listening on /adminRoles/{uid} + /organiserRoles/{uid}
 *   uid     → uid'   : stop old listens, start new
 *   uid     → null   : stop listens, clear cached role
 */
export function setCurrentUidForRoles(uid: string | null): void {
  if (uid === activeUid) return;
  activeUid = uid;
  // Tear down previous listens if any.
  adminRolesUnsub?.();
  adminRolesUnsub = null;
  organiserRolesUnsub?.();
  organiserRolesUnsub = null;
  if (!uid) {
    cachedRole = null;
    notify();
    return;
  }
  // Fresh subscription. Emit an empty role immediately so subscribers
  // can render an "empty admin" state while we wait for the two
  // RTDB reads to settle; they'll be updated as the snapshots arrive.
  cachedRole = { isSuper: false, isOrganiser: false };
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

    // Organiser listen: /organiserRoles/{uid} → true | null. Point
    // subscription (not a full-tree scan like v3.2) so this stays
    // constant-cost regardless of how many organisers exist.
    organiserRolesUnsub = onValue(
      ref(db, `organiserRoles/${uid}`),
      (snap) => {
        if (activeUid !== uid || !cachedRole) return;
        cachedRole = { ...cachedRole, isOrganiser: snap.val() === true };
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

/**
 * One-shot load of every `/organiserRoles/{uid}` entry. Returned as
 * a set of uids for O(1) membership checks. Mirrors
 * `loadAllAdminRoles`; super-authed reads only (rule read is
 * `auth != null` but only super has a real reason to enumerate).
 */
export async function loadAllOrganiserRoles(): Promise<Set<string>> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'organiserRoles'));
    const raw = snap.val() as Record<string, unknown> | null;
    if (!raw) return new Set();
    const out = new Set<string>();
    for (const [uid, val] of Object.entries(raw)) {
      if (val === true) out.add(uid);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Super-only: onboard a user as an organiser. Idempotent — writing
 * `true` where `true` already exists is a no-op.
 */
export async function addOrganiserRole(uid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = uid.trim();
  if (!clean || clean.length > 64) return { ok: false, error: 'UID must be 1-64 characters' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, set }, { logAudit }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
      import('./audit'),
    ]);
    const db = getDatabase(firebaseApp());
    await set(ref(db, `organiserRoles/${clean}`), true);
    void logAudit({
      action: 'organiser.onboard',
      path: `organiserRoles/${clean}`,
      after: { uid: clean },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Add organiser failed' };
  }
}

/**
 * Super-only: revoke a user's organiser role. Doesn't delete their
 * tournaments — those become super-only from then on (per v3.3
 * "orphan" policy). Idempotent.
 */
export async function removeOrganiserRole(uid: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const clean = uid.trim();
  if (!clean) return { ok: false, error: 'Missing UID' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, remove }, { logAudit }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
      import('./audit'),
    ]);
    const db = getDatabase(firebaseApp());
    await remove(ref(db, `organiserRoles/${clean}`));
    void logAudit({
      action: 'organiser.revoke',
      path: `organiserRoles/${clean}`,
      before: { uid: clean },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Remove organiser failed' };
  }
}

/** Test hook — reset state between assertions. */
export function _resetForTests(): void {
  activeUid = null;
  cachedRole = null;
  listeners = new Set();
  adminRolesUnsub?.();
  adminRolesUnsub = null;
  organiserRolesUnsub?.();
  organiserRolesUnsub = null;
}
