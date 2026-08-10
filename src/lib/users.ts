/**
 * User mirror. Firebase Auth's user records are locked behind the
 * Admin SDK (server-side, unavailable on our Spark tier), so the
 * client has no way to look up "who is uid X" for anyone but the
 * signed-in user themselves.
 *
 * Workaround: on sign-in, each user writes their own record to
 * `/users/{uid}` = { email, displayName, photoURL, lastSignIn }.
 * The map is super-readable, so the admin panel can render a
 * human name/email next to any UID it sees in /adminRoles or
 * /tournaments/{key}/organisers. It also enables an email->UID lookup
 * so the maintainer can invite by email once the recipient has
 * signed in at least once.
 *
 * Self-write only: rules gate `/users/{$uid}/.write` on
 * `auth.uid == $uid`, so an authenticated user can only touch
 * their own record. Anonymous users don't hit this path at all.
 */

import { currentUser, type AuthUser } from './auth';

/**
 * User mirror shape as stored in RTDB. `lastSignIn` is what powers
 * the "stale invites" check — an invite pointing at an email whose
 * owner never signed in stays pending until they do.
 */
export type UserRecord = {
  uid: string;
  email: string;
  displayName?: string;
  photoURL?: string | null;
  lastSignIn: number;
};

/**
 * Write the current signed-in user's mirror record. Fire-and-
 * forget from the caller's perspective; silent-on-failure per
 * house style. Called once per sign-in from the auth-subscription
 * plumbing in SignInButton.
 */
export async function upsertOwnUserMirror(user: AuthUser): Promise<void> {
  if (!user.uid) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // `update` merges — preserves any fields we don't touch (there
    // aren't any yet but future-proofs the record shape).
    await update(ref(db, `users/${user.uid}`), {
      email: user.email ?? '',
      ...(user.displayName ? { displayName: user.displayName } : {}),
      ...(user.photoURL ? { photoURL: user.photoURL } : {}),
      lastSignIn: Date.now(),
    });
  } catch {
    // Silent — the panel just shows the raw UID as a fallback.
  }
}

/**
 * Convenience: upsert using the currently-cached auth user.
 * No-op when signed out.
 */
export async function upsertOwnUserMirrorNow(): Promise<void> {
  const u = currentUser();
  if (!u) return;
  await upsertOwnUserMirror(u);
}

/**
 * Admin-only: one-shot read of the full `/users` map. Super-read
 * per RTDB rules; non-super callers receive an empty object.
 */
export async function loadAllUsers(): Promise<Record<string, UserRecord>> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'users'));
    const raw = snap.val() as Record<string, unknown> | null;
    if (!raw) return {};
    const out: Record<string, UserRecord> = {};
    for (const [uid, val] of Object.entries(raw)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      out[uid] = {
        uid,
        email: typeof v.email === 'string' ? v.email : '',
        ...(typeof v.displayName === 'string' ? { displayName: v.displayName } : {}),
        ...(typeof v.photoURL === 'string' ? { photoURL: v.photoURL } : {}),
        lastSignIn: typeof v.lastSignIn === 'number' ? v.lastSignIn : 0,
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Normalise an email so different casings hit the same key. Firebase
 * doesn't allow `.` in keys, so we replace with `,` on the way in and
 * the reverse on the way out. Matches Google Auth's lowercasing
 * behaviour so alice@Gmail.com === alice@gmail.com.
 */
export function emailToKey(email: string): string {
  return email.trim().toLowerCase().replaceAll('.', ',');
}
export function keyToEmail(key: string): string {
  return key.replaceAll(',', '.');
}
