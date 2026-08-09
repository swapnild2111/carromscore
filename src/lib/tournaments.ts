import { currentUser } from './auth';
import { logAudit } from './audit';

/**
 * Tournament / event tag store. Mirrors the players.ts pattern:
 *   - Firebase RTDB `/tournaments/{key}` is the source of truth
 *   - In-memory list drives the picker in MatchSetup
 *   - Silent-on-failure per house style; the app keeps working
 *     against the local list if Firebase is unreachable
 *
 * Purpose: users can tag matches with a tournament / event name
 * (e.g. "Silver Cup 2026") so the /live/ lobby can group Now Playing
 * + History under section headers, and retention differs by tag
 * (tagged → 1 year, blank/"Default" → 3 months, Practice → 3 months
 * always).
 */

export type Tournament = {
  key: string;             // slug — normalised, safe as a Firebase key
  name: string;            // canonical display name (what the user typed)
  createdAt: number;
  lastActive: number;      // touched on every match Start referencing it
  /**
   * Firebase auth uid of the account that created this record. Absent
   * when the tournament was created anonymously (default v2.0 flow).
   * Preserved verbatim on subsequent anonymous touches — see
   * writeTournamentToFirebase.
   */
  createdBy?: string;
};

/**
 * Normalise a typed tournament name into a safe key for Firebase.
 * Lowercased, ASCII-diacritic-stripped, punctuation collapsed to
 * dashes. Firebase disallows `. # $ / [ ]` in keys — this normaliser
 * avoids all of them by design.
 */
export function normalizeKey(name: string): string {
  return name
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

let memoryStore: Tournament[] = [];
let listeners = new Set<() => void>();
let firebaseUnsubscribe: (() => void) | null = null;

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadAll(): Tournament[] {
  // Returns most-recently active first — that's the useful order in
  // the picker (last tournament you played in is the most likely one
  // for the next match too).
  return [...memoryStore].sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Rank tournaments against a typed query. Simple prefix + substring
 * match on the normalised name. Empty query returns the whole list
 * (sorted by recent activity via loadAll). Case-insensitive.
 */
export function rankTournaments(query: string, limit = 8): Tournament[] {
  const q = query.trim().toLowerCase();
  const all = loadAll();
  if (!q) return all.slice(0, limit);
  const norm = q.toLowerCase();
  const prefix: Tournament[] = [];
  const substring: Tournament[] = [];
  for (const t of all) {
    const n = t.name.toLowerCase();
    if (n.startsWith(norm)) prefix.push(t);
    else if (n.includes(norm)) substring.push(t);
  }
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Ensure a tournament with the given canonical name exists in the
 * store + Firebase. Idempotent — repeat calls just bump lastActive.
 * Returns the resolved Tournament record. Empty / whitespace-only
 * names return null (indicating "no tournament tag").
 */
export function createOrTouchTournament(name: string): Tournament | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const key = normalizeKey(trimmed);
  if (!key) return null;
  const now = Date.now();
  const existing = memoryStore.find((t) => t.key === key);
  // Stamp `createdBy` only on the fresh-creation path. Subsequent
  // touches on an existing record must not overwrite the original
  // creator — that field is the record's provenance.
  const creator = currentUser()?.uid;
  const record: Tournament = existing
    ? { ...existing, name: trimmed, lastActive: now }
    : {
        key,
        name: trimmed,
        createdAt: now,
        lastActive: now,
        ...(creator ? { createdBy: creator } : {}),
      };
  if (existing) {
    Object.assign(existing, { name: trimmed, lastActive: now });
  } else {
    memoryStore.push(record);
  }
  notify();
  void writeTournamentToFirebase(record);
  return record;
}

/**
 * Subscribe to /tournaments in Firebase RTDB. Populates the in-
 * memory store as records arrive. Idempotent — safe to call from
 * multiple mount points; the second call is a no-op.
 */
export async function subscribeTournaments(): Promise<void> {
  if (firebaseUnsubscribe) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const tRef = ref(db, 'tournaments');
    firebaseUnsubscribe = onValue(
      tRef,
      (snap) => {
        const raw = snap.val() as Record<string, unknown> | null;
        if (!raw) return;
        mergeRemote(raw);
      },
      () => {},
    );
  } catch {
    // Firebase unreachable — local store still works.
  }
}

function mergeRemote(raw: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) continue;
    const createdAt = typeof v.createdAt === 'number' ? v.createdAt : 0;
    const lastActive = typeof v.lastActive === 'number' ? v.lastActive : 0;
    const createdBy = typeof v.createdBy === 'string' ? v.createdBy : undefined;
    const existing = memoryStore.find((t) => t.key === key);
    if (existing) {
      existing.name = name;
      existing.createdAt = createdAt || existing.createdAt;
      // Take the newer lastActive between what we have and what
      // arrived, so a stale local touch doesn't demote a fresher one.
      existing.lastActive = Math.max(existing.lastActive, lastActive);
      if (createdBy && !existing.createdBy) existing.createdBy = createdBy;
    } else {
      memoryStore.push({
        key,
        name,
        createdAt,
        lastActive,
        ...(createdBy ? { createdBy } : {}),
      });
    }
  }
  notify();
}

async function writeTournamentToFirebase(t: Tournament): Promise<void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // `update` merges — if the record already exists we just bump
    // lastActive + refresh name (in case of typo correction), without
    // touching createdAt. `createdBy` is only present on the local
    // record when we just created it, so we forward it conditionally
    // to avoid clobbering an existing record's creator.
    await update(ref(db, `tournaments/${t.key}`), {
      name: t.name,
      lastActive: t.lastActive,
      createdAt: t.createdAt,
      ...(t.createdBy ? { createdBy: t.createdBy } : {}),
    });
  } catch {
    // Silent — local record persists.
  }
}

// ─── Admin helpers (super-only) ─────────────────────────────────────

export type TournamentWriteOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Build the multi-path rewrite map for match records whose
 * `tournament` display name equals `oldName`, replacing with
 * `newName`. Returns both the map and the count for the audit.
 */
function buildTournamentMatchRewrites(
  matches: Record<string, Record<string, unknown>>,
  oldName: string,
  newName: string,
): { rewrites: Record<string, unknown>; matchCount: number } {
  const rewrites: Record<string, unknown> = {};
  let matchCount = 0;
  for (const [matchId, m] of Object.entries(matches)) {
    if (typeof m.tournament === 'string' && m.tournament === oldName) {
      rewrites[`matches/${matchId}/tournament`] = newName;
      matchCount += 1;
    }
  }
  return { rewrites, matchCount };
}

/**
 * Rename a tournament in place (same normalised key — e.g. a
 * case-only fix). Just updates `name` on the record and rewrites
 * the display-name on every match. Called by `renameTournament`
 * when the key doesn't change.
 */
async function renameTournamentInPlace(
  db: import('firebase/database').Database,
  key: string,
  trimmed: string,
  oldName: string,
): Promise<void> {
  const { ref, get, update } = await import('firebase/database');
  await update(ref(db, `tournaments/${key}`), {
    name: trimmed,
    lastActive: Date.now(),
  });
  const matchesSnap = await get(ref(db, 'matches'));
  const matches =
    (matchesSnap.val() as Record<string, Record<string, unknown>> | null) ?? {};
  const { rewrites } = buildTournamentMatchRewrites(matches, oldName, trimmed);
  if (Object.keys(rewrites).length > 0) await update(ref(db, '/'), rewrites);
  const local = memoryStore.find((t) => t.key === key);
  if (local) local.name = trimmed;
  notify();
  void logAudit({
    action: 'tournament.rename',
    path: `tournaments/${key}`,
    before: { name: oldName },
    after: { name: trimmed },
  });
}

/**
 * Rename a tournament by cloning to a new key. Creates the new
 * record with the old createdAt/createdBy/organisers preserved,
 * rewrites every child match's display name, then deletes the old
 * record. Atomic multi-path update for the create + match rewrites;
 * the old-record delete follows once everything else has landed.
 */
async function renameTournamentToNewKey(
  db: import('firebase/database').Database,
  oldKey: string,
  newKey: string,
  trimmed: string,
  oldRec: Record<string, unknown>,
  oldName: string,
): Promise<number> {
  const { ref, get, update, remove } = await import('firebase/database');
  const now = Date.now();
  const nextRec = {
    name: trimmed,
    createdAt: typeof oldRec.createdAt === 'number' ? oldRec.createdAt : now,
    lastActive: now,
    ...(typeof oldRec.createdBy === 'string' ? { createdBy: oldRec.createdBy } : {}),
    ...(oldRec.organisers ? { organisers: oldRec.organisers } : {}),
  };
  const matchesSnap = await get(ref(db, 'matches'));
  const matches =
    (matchesSnap.val() as Record<string, Record<string, unknown>> | null) ?? {};
  const { rewrites, matchCount } = buildTournamentMatchRewrites(matches, oldName, trimmed);
  rewrites[`tournaments/${newKey}`] = nextRec;
  await update(ref(db, '/'), rewrites);
  await remove(ref(db, `tournaments/${oldKey}`));

  memoryStore = memoryStore.filter((t) => t.key !== oldKey);
  memoryStore.push({
    key: newKey,
    name: trimmed,
    createdAt: nextRec.createdAt,
    lastActive: nextRec.lastActive,
    ...(nextRec.createdBy ? { createdBy: nextRec.createdBy } : {}),
  });
  notify();
  return matchCount;
}

/**
 * Admin-only: rename a tournament. If the new name normalises to
 * the same key as the current one (e.g. just a case fix), we update
 * `name` in place. If it normalises to a different key we create
 * the new record, rewrite every child match, delete the old record.
 * Atomic via a single multi-path update.
 *
 * `tournament` on match records is stored as the display name (not
 * the key), so the rewrite loop scans for equality on the trimmed
 * display name.
 */
export async function renameTournament(
  oldKey: string,
  newName: string,
): Promise<TournamentWriteOutcome> {
  const trimmed = newName.trim();
  if (!oldKey) return { ok: false, error: 'Missing tournament key' };
  if (!trimmed || trimmed.length > 60)
    return { ok: false, error: 'Name must be 1-60 characters' };
  const newKey = normalizeKey(trimmed);
  if (!newKey) return { ok: false, error: 'Name did not produce a valid key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const oldSnap = await get(ref(db, `tournaments/${oldKey}`));
    if (!oldSnap.exists()) return { ok: false, error: 'Tournament not found' };
    const oldRec = oldSnap.val() as Record<string, unknown>;
    const oldName = typeof oldRec.name === 'string' ? oldRec.name : '';

    if (newKey === oldKey) {
      await renameTournamentInPlace(db, oldKey, trimmed, oldName);
      return { ok: true };
    }

    const matchCount = await renameTournamentToNewKey(
      db,
      oldKey,
      newKey,
      trimmed,
      oldRec,
      oldName,
    );
    void logAudit({
      action: 'tournament.rename',
      path: `tournaments/${oldKey} → tournaments/${newKey}`,
      before: { key: oldKey, name: oldName },
      after: { key: newKey, name: trimmed, matchesRewritten: matchCount },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Rename failed' };
  }
}

/**
 * Admin-only: delete a tournament. Match records that carry the
 * deleted tournament's display name keep the tag string; the lobby
 * groups them under "Default" because the tournament node no longer
 * exists. This is deliberate — we don't want to silently rewrite
 * historical match records when the admin's intent is "remove the
 * event bucket".
 */
export async function deleteTournament(key: string): Promise<TournamentWriteOutcome> {
  if (!key) return { ok: false, error: 'Missing tournament key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${key}`;
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    await remove(ref(db, path));
    memoryStore = memoryStore.filter((t) => t.key !== key);
    notify();
    void logAudit({
      action: 'tournament.delete',
      path,
      before: existing ?? undefined,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Delete failed' };
  }
}

/**
 * Admin-only: add a user as an organiser on this tournament. The
 * UID must be a real Firebase auth UID (max 64 chars). Idempotent —
 * writing `true` where `true` already exists is a no-op.
 */
export async function addOrganiser(
  key: string,
  uid: string,
): Promise<TournamentWriteOutcome> {
  const cleanUid = uid.trim();
  if (!key) return { ok: false, error: 'Missing tournament key' };
  if (!cleanUid || cleanUid.length > 64)
    return { ok: false, error: 'UID must be 1-64 characters' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${key}/organisers/${cleanUid}`;
    await set(ref(db, path), true);
    void logAudit({
      action: 'organiser.add',
      path,
      after: { uid: cleanUid, tournament: key },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Add organiser failed' };
  }
}

/** Admin-only: remove an organiser. Idempotent — removing a
 *  non-organiser is a no-op. */
export async function removeOrganiser(
  key: string,
  uid: string,
): Promise<TournamentWriteOutcome> {
  const cleanUid = uid.trim();
  if (!key) return { ok: false, error: 'Missing tournament key' };
  if (!cleanUid) return { ok: false, error: 'Missing UID' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${key}/organisers/${cleanUid}`;
    await remove(ref(db, path));
    void logAudit({
      action: 'organiser.remove',
      path,
      before: { uid: cleanUid, tournament: key },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Remove organiser failed' };
  }
}

/**
 * Read the organiser UID list for a tournament as a fresh one-shot
 * fetch. Only useful for the admin panel — the /admin/ Tournaments
 * tab reads it to render the manage-organisers UI. Subscribed reads
 * live on `subscribeCurrentUserRole` in roles.ts.
 */
export async function loadOrganisers(key: string): Promise<string[]> {
  if (!key) return [];
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, `tournaments/${key}/organisers`));
    const val = snap.val() as Record<string, unknown> | null;
    if (!val) return [];
    return Object.entries(val)
      .filter(([, v]) => v === true)
      .map(([uid]) => uid);
  } catch {
    return [];
  }
}

/** Test hook — reset store between assertions. */
export function _resetForTests(): void {
  memoryStore = [];
  listeners = new Set();
  firebaseUnsubscribe?.();
  firebaseUnsubscribe = null;
}
