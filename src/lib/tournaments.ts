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
  /**
   * Tournament mode. `'open'` (default) — any player, any umpire,
   * no roster gating; behaves like every tournament did before v3.1.
   * `'closed'` — the tournament is bound to a specific country and
   * has an explicit assigned-player list. The home form warns when
   * a picked player isn't assigned or their country doesn't match.
   * Absent field = treat as 'open' for backwards compat.
   */
  type?: 'open' | 'closed';
  /**
   * ISO 3166-1 alpha-2 country code (e.g. "DK"). Only meaningful when
   * `type === 'closed'`. Used by the home form's warning derivation
   * on the picked-player-country check.
   */
  country?: string;
};

/** Meta arg accepted by createOrTouchTournament for v3.1+. */
export type CreateTournamentMeta = {
  type?: 'open' | 'closed';
  country?: string;
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
export function createOrTouchTournament(
  name: string,
  meta?: CreateTournamentMeta,
): Tournament | null {
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
  const type = meta?.type;
  const country = meta?.country;
  const record: Tournament = existing
    ? {
        ...existing,
        name: trimmed,
        lastActive: now,
        // Meta is authoritative when explicitly passed — an admin
        // switching a tournament open↔closed goes here.
        ...(type ? { type } : {}),
        ...(country ? { country } : {}),
      }
    : {
        key,
        name: trimmed,
        createdAt: now,
        lastActive: now,
        ...(creator ? { createdBy: creator } : {}),
        ...(type ? { type } : {}),
        ...(country ? { country } : {}),
      };
  if (existing) {
    Object.assign(existing, {
      name: trimmed,
      lastActive: now,
      ...(type ? { type } : {}),
      ...(country ? { country } : {}),
    });
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
    const type =
      v.type === 'open' || v.type === 'closed' ? (v.type as 'open' | 'closed') : undefined;
    const country = typeof v.country === 'string' ? v.country : undefined;
    const existing = memoryStore.find((t) => t.key === key);
    if (existing) {
      existing.name = name;
      existing.createdAt = createdAt || existing.createdAt;
      // Take the newer lastActive between what we have and what
      // arrived, so a stale local touch doesn't demote a fresher one.
      existing.lastActive = Math.max(existing.lastActive, lastActive);
      if (createdBy && !existing.createdBy) existing.createdBy = createdBy;
      if (type) existing.type = type;
      if (country) existing.country = country;
    } else {
      memoryStore.push({
        key,
        name,
        createdAt,
        lastActive,
        ...(createdBy ? { createdBy } : {}),
        ...(type ? { type } : {}),
        ...(country ? { country } : {}),
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
      ...(t.type ? { type: t.type } : {}),
      ...(t.country ? { country: t.country } : {}),
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
 * Count of matches currently tagged under this tournament (by
 * tournamentKey). Used by the admin panel's delete-confirmation
 * dialog to warn "this will also delete N matches" before the
 * organiser types DELETE. Silent-on-failure returns 0 — better a
 * conservative undercount than a scary infrastructure error.
 */
export async function countMatchesByTournamentKey(key: string): Promise<number> {
  if (!key) return 0;
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'matches'));
    const all = snap.val() as Record<string, { tournamentKey?: string }> | null;
    if (!all) return 0;
    let count = 0;
    for (const m of Object.values(all)) {
      if (m && typeof m === 'object' && m.tournamentKey === key) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Result of a cascade tournament delete. Includes rolled-up counts
 * for the match wipe so the admin panel can surface honest feedback
 * (e.g. "10 matches deleted, 2 skipped — you can't delete matches
 * created by someone else").
 */
export type TournamentCascadeOutcome = {
  ok: boolean;
  /** true if the tournament record itself was removed. */
  tournamentDeleted: boolean;
  /** Matches successfully wiped. */
  matchesDeleted: number;
  /** Matches skipped because RTDB rejected the delete (auth). Left
   *  in place; the admin can ping a super or the record's creator. */
  matchesFailed: number;
  error?: string;
};

/**
 * Admin cascade: delete every match tagged under this tournament
 * (skipping matches the current user isn't authorised on, per the
 * /matches/{id} .write rules), then delete the tournament record
 * itself. Auth-skipped matches leave the tournament orphaned in
 * memory — we still attempt the tournament record delete; if that
 * also fails due to auth, the outcome reports it.
 *
 * The prior "soft" delete (keep matches, drop only the /tournaments
 * record) is preserved as the default for the singular helper below;
 * the cascade path is opt-in via `deleteTournamentAndMatches` so
 * bulk-delete flows stay predictable.
 */
export async function deleteTournamentAndMatches(
  key: string,
): Promise<TournamentCascadeOutcome> {
  if (!key) {
    return {
      ok: false,
      tournamentDeleted: false,
      matchesDeleted: 0,
      matchesFailed: 0,
      error: 'Missing tournament key',
    };
  }
  // Lazy-import history's deleteMatch to keep this module tree-shakable
  // for callers that don't need the cascade. Same trick used elsewhere
  // in the codebase (see finishMatch → auth import).
  const { deleteMatch, loadHistory } = await import('./history');
  const matches = await loadHistory();
  const toDelete = matches
    .filter((m) => m.tournamentKey === key)
    .map((m) => m.id);
  let deletedCount = 0;
  let failedCount = 0;
  for (const id of toDelete) {
    const r = await deleteMatch(id);
    if (r.ok) deletedCount += 1;
    else failedCount += 1;
  }
  // Delete the tournament record last so partial failure still
  // reflects on the tournament's remaining orphan matches. If the
  // tournament delete itself fails (auth), report that.
  const tOutcome = await deleteTournament(key);
  return {
    ok: tOutcome.ok && failedCount === 0,
    tournamentDeleted: tOutcome.ok,
    matchesDeleted: deletedCount,
    matchesFailed: failedCount,
    error: tOutcome.ok ? undefined : tOutcome.error,
  };
}

/**
 * Admin-only: delete a tournament record. Match records that carry
 * the deleted tournament's tag keep it — the lobby still groups
 * them by that string (grouping is by the match's raw `tournament`
 * field, not by the /tournaments/{key} node existing). If you want
 * cascade deletion of the matches too, use
 * `deleteTournamentAndMatches`.
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

/** Rolled-up counts for a bulk delete + the first failure message.
 *  matchesDeleted / matchesFailed reflect the cascade wipe of child
 *  matches per tournament — see deleteTournaments. */
export type TournamentBulkOutcome = {
  ok: boolean;
  deleted: number;
  failed: number;
  matchesDeleted?: number;
  matchesFailed?: number;
  error?: string;
};

/**
 * Admin-only: bulk-delete a set of tournaments AND every match
 * tagged under each. Each cascade is individually audited (see
 * deleteTournamentAndMatches → deleteMatch → audit; tournament
 * delete → audit). Auth-rejected match deletes are surfaced in the
 * outcome as `matchesFailed`.
 *
 * Serial per-tournament rather than Promise.all — a single tournament
 * with many matches would fan out too aggressively against RTDB if
 * we parallelised at the tournament level.
 */
export async function deleteTournaments(keys: string[]): Promise<TournamentBulkOutcome> {
  const clean = keys.filter((k) => typeof k === 'string' && k.length > 0);
  if (clean.length === 0) return { ok: true, deleted: 0, failed: 0 };
  let deleted = 0;
  let failed = 0;
  let matchesDeleted = 0;
  let matchesFailed = 0;
  let firstError: string | undefined;
  for (const k of clean) {
    const r = await deleteTournamentAndMatches(k);
    if (r.tournamentDeleted) deleted += 1;
    else {
      failed += 1;
      if (!firstError) firstError = r.error;
    }
    matchesDeleted += r.matchesDeleted;
    matchesFailed += r.matchesFailed;
  }
  return {
    ok: failed === 0 && matchesFailed === 0,
    deleted,
    failed,
    matchesDeleted,
    matchesFailed,
    ...(firstError ? { error: firstError } : {}),
  };
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

// ─── Assigned-players helpers (closed tournaments) ───────────────────

/**
 * Add a player to a closed tournament's roster. Idempotent — the
 * write is `set(true)` on `/tournaments/{key}/assignedPlayerIds/{playerId}`.
 * Auth is enforced by RTDB rules: super OR organiser-of-this-key.
 */
export async function assignPlayer(
  key: string,
  playerId: string,
): Promise<TournamentWriteOutcome> {
  const cleanPid = playerId.trim();
  if (!key) return { ok: false, error: 'Missing tournament key' };
  if (!cleanPid || cleanPid.length > 64)
    return { ok: false, error: 'playerId must be 1-64 characters' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${key}/assignedPlayerIds/${cleanPid}`;
    await set(ref(db, path), true);
    void logAudit({
      action: 'player.assign',
      path,
      after: { playerId: cleanPid, tournament: key },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Assign player failed' };
  }
}

/** Remove a player from a closed tournament's roster. Idempotent —
 *  removing a non-member is a no-op. */
export async function unassignPlayer(
  key: string,
  playerId: string,
): Promise<TournamentWriteOutcome> {
  const cleanPid = playerId.trim();
  if (!key) return { ok: false, error: 'Missing tournament key' };
  if (!cleanPid) return { ok: false, error: 'Missing playerId' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${key}/assignedPlayerIds/${cleanPid}`;
    await remove(ref(db, path));
    void logAudit({
      action: 'player.unassign',
      path,
      before: { playerId: cleanPid, tournament: key },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Unassign player failed' };
  }
}

/**
 * One-shot read of every playerId assigned to a tournament. Returns
 * a Set so caller can O(1) membership-check. Empty set on error /
 * empty map — silent-on-failure per house style.
 *
 * Public read: `/tournaments/$key` is world-readable (`.read: true`
 * on the tournaments node); this includes the assignedPlayerIds
 * sub-node.
 */
export async function loadAssignedPlayers(key: string): Promise<Set<string>> {
  if (!key) return new Set();
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, `tournaments/${key}/assignedPlayerIds`));
    const val = snap.val() as Record<string, unknown> | null;
    if (!val) return new Set();
    const out = new Set<string>();
    for (const [pid, v] of Object.entries(val)) {
      if (v === true) out.add(pid);
    }
    return out;
  } catch {
    return new Set();
  }
}

/**
 * Admin-only: fetch every organiser across every tournament in one
 * read. Returned as a nested map: uid → { tournamentKey → true }.
 * Handy for the roles-management tab which groups by UID rather
 * than by tournament.
 *
 * Requires super-admin auth per the /tournaments/$key/organisers
 * read rule (auth != null); non-super users get an empty map
 * silently.
 */
export async function loadAllOrganisers(): Promise<Record<string, Record<string, true>>> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'tournaments'));
    const raw = snap.val() as Record<string, Record<string, unknown>> | null;
    if (!raw) return {};
    const out: Record<string, Record<string, true>> = {};
    for (const [key, val] of Object.entries(raw)) {
      const organisers = (val?.organisers as Record<string, unknown> | undefined) ?? null;
      if (!organisers) continue;
      for (const [uid, v] of Object.entries(organisers)) {
        if (v !== true) continue;
        if (!out[uid]) out[uid] = {};
        out[uid][key] = true;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Test hook — reset store between assertions. */
export function _resetForTests(): void {
  memoryStore = [];
  listeners = new Set();
  firebaseUnsubscribe?.();
  firebaseUnsubscribe = null;
}
