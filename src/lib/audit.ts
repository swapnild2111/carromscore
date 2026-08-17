/**
 * Admin audit log. Every mutation coming from an admin write helper
 * (match edits, player merges/renames, tournament rename/delete,
 * organiser add/remove, live record cleanup) pushes an entry to
 * `/audit/{pushId}` so a super-admin can review who did what, when,
 * with before/after values.
 *
 * Convention: **mutate first, audit second**. If the audit write
 * fails after a successful mutation, log a `console.warn` and move
 * on — the mutation still stands and the ledger has a gap. Rare in
 * practice because the audit rule only requires auth and freshness,
 * neither of which fails after the mutation just succeeded.
 *
 * Rules-side notes (see database.rules.json):
 * - Read: super-admin only. Regular signed-in users cannot see
 *   who edited what.
 * - Write: any authenticated user, but `who` must equal auth.uid
 *   (forgery-proof). No delete branch — append-only.
 * - indexOn: 'when' so `subscribeAudit` can query newest-first.
 */

import { currentUser } from './auth';

export type AuditAction =
  | 'match.update'
  | 'match.delete'
  | 'match.self_delete'
  | 'player.rename'
  | 'player.merge'
  | 'player.delete'
  | 'tournament.rename'
  | 'tournament.delete'
  | 'organiser.add'
  | 'organiser.remove'
  | 'player.assign'
  | 'player.unassign'
  | 'live.delete';

export type AuditEntry = {
  who: string;
  whoEmail?: string;
  when: number;
  action: AuditAction;
  /** Human-readable RTDB path or slug the write touched. Max 200 chars. */
  path: string;
  before?: unknown;
  after?: unknown;
};

/**
 * Cap serialised before/after payloads so a huge boardLog doesn't
 * bloat the audit record. If truncated, we substitute a small marker
 * so consumers can still see something happened.
 */
const AUDIT_MAX_PAYLOAD_BYTES = 8 * 1024;

function clampPayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  try {
    const serialised = JSON.stringify(payload);
    if (serialised.length <= AUDIT_MAX_PAYLOAD_BYTES) return payload;
    return { truncated: true, sizeBytes: serialised.length };
  } catch {
    return { truncated: true, unserialisable: true };
  }
}

/**
 * Push an audit entry to RTDB. Fire-and-forget from the caller's
 * perspective — return the resolved promise if you want to await
 * (e.g. for tests) but the admin write helper typically doesn't.
 *
 * Silent-on-failure with a console.warn: audit gaps are worth
 * knowing about in local dev but not worth blocking the mutation
 * on. If the caller is anonymous (no auth.uid) we skip the write
 * entirely — the rule would reject it anyway.
 */
export async function logAudit(entry: Omit<AuditEntry, 'who' | 'whoEmail' | 'when'>): Promise<void> {
  const user = currentUser();
  if (!user?.uid) {
    console.warn('[carromscore] logAudit skipped — no signed-in user');
    return;
  }
  const record: AuditEntry = {
    who: user.uid,
    ...(user.email ? { whoEmail: user.email } : {}),
    when: Date.now(),
    action: entry.action,
    path: entry.path.slice(0, 200),
    ...(entry.before !== undefined ? { before: clampPayload(entry.before) } : {}),
    ...(entry.after !== undefined ? { after: clampPayload(entry.after) } : {}),
  };
  try {
    const [{ firebaseApp }, { getDatabase, ref, push, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const newRef = push(ref(db, 'audit'));
    await set(newRef, record);
  } catch (err) {
    console.warn('[carromscore] logAudit write failed:', err);
  }
}

/**
 * Subscribe to the most-recent N audit entries, newest-first. Uses
 * RTDB's orderByChild + limitToLast on the `when` field — Firebase
 * returns them ascending, so the callback resorts to descending
 * before firing. Only super-admins can read this path; unauthorised
 * callers receive an empty list silently (per house pattern).
 */
export async function subscribeAudit(
  limit: number,
  fn: (entries: Array<AuditEntry & { id: string }>) => void,
): Promise<() => void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue, query, orderByChild, limitToLast }] =
      await Promise.all([import('./firebase'), import('firebase/database')]);
    const db = getDatabase(firebaseApp());
    const q = query(ref(db, 'audit'), orderByChild('when'), limitToLast(limit));
    const unsub = onValue(
      q,
      (snap) => {
        const val = snap.val() as Record<string, AuditEntry> | null;
        if (!val) {
          fn([]);
          return;
        }
        const list = Object.entries(val)
          .map(([id, e]) => ({ id, ...e }))
          .sort((a, b) => b.when - a.when);
        fn(list);
      },
      () => {
        fn([]);
      },
    );
    return unsub;
  } catch {
    return () => {};
  }
}
