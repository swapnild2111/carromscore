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
  /**
   * Rounds carried by this tournament — a real tournament has stages
   * (Round of 16 → Quarter-finals → Semi-finals → Final). Optional;
   * a tournament without any rounds behaves like every tournament did
   * before v3.2 (flat match list). Local mirror of
   * `/tournaments/{key}/rounds/{roundKey}`; kept sorted by `order`
   * inside `loadRounds`.
   */
  rounds?: Round[];
  /**
   * Tournament-level match defaults (v3.6). Inherited by pre-created
   * planned matches (see /planned/{mid}) when they don't override
   * per-match. Also read by the score-setup flow to prefill the
   * config form. Absent field = fall back to the app defaults
   * (bo3 / 25 / 8 singles).
   */
  defaults?: {
    mode?: 'singles' | 'doubles';
    bestOf?: number;
    pointsTarget?: number;
    maxBoards?: number;
  };
};

/**
 * One stage of a tournament (Round of 16, Final, etc). Matches
 * optionally carry a `roundKey` that references one of these.
 *
 * Data model choice: rounds are first-class children of the parent
 * tournament, not free-text tags on the match. That gives us:
 *   - typo-free grouping in History / Reports
 *   - per-round open/closed state (an organiser can close R16 once
 *     QF starts so the setup picker only surfaces still-live rounds)
 *   - a natural place to hang per-round metadata (order for display)
 *
 * Labels only — no bracket / auto-advance logic. A round is a named
 * bucket; the umpire picks it at setup.
 */
export type Round = {
  key: string;             // slug — normalised, safe as a Firebase key
  name: string;            // display name (what the organiser typed)
  order: number;           // 1-indexed display order (R16=1, QF=2, …)
  state: 'open' | 'closed';
  createdAt: number;
  /**
   * Epoch ms when the organiser hit ▶ Start on this round. Absent
   * means the round is still pending (created but not started yet).
   * Combined with `state` this yields a three-state lifecycle in
   * the UI:
   *   - pending: state='open' AND !startedAt   (▶ enabled, ⏹ disabled)
   *   - running: state='open' AND startedAt    (▶ disabled, ⏹ enabled)
   *   - closed:  state='closed'                 (terminal — no reopen)
   * Rounds from v3.6.1 and earlier never carry startedAt; the UI
   * treats them as pending (organiser can start or close manually).
   * Added 2026-08-31.
   */
  startedAt?: number;
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
 * Find a tournament by its key in the local memoryStore. Returns
 * null when the key is unknown or the store hasn't hydrated yet.
 * Cheap: memoryStore is an array of at most a few hundred records
 * so a linear scan is fine.
 *
 * Used by v3.3's own-only auth gates — callers know a match's
 * tournamentKey and need to look up the tournament's `createdBy`
 * to decide "can this user edit this match?".
 */
export function findByKey(key: string): Tournament | null {
  if (!key) return null;
  return memoryStore.find((t) => t.key === key) ?? null;
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
 * Result of a create-or-touch call. `record` is null when the name
 * failed client-side validation (empty / no signed-in user for a
 * fresh create). `ok: false` means the RTDB write was rejected —
 * the local push has already been rolled back and the caller
 * should surface the error to the umpire.
 */
export type CreateTournamentOutcome =
  | { ok: true; record: Tournament }
  | { ok: false; record: null; error: string };

/**
 * Ensure a tournament with the given canonical name exists in the
 * store + Firebase. Idempotent — repeat calls just bump lastActive.
 * Empty / whitespace-only names produce a `record: null` outcome
 * (indicating "no tournament tag").
 *
 * v3.3: creating a NEW tournament requires an authenticated user —
 * the RTDB rule for `/tournaments/{key}` now demands
 * `newData.createdBy == auth.uid` on the fresh-create branch, and
 * an anonymous write would be denied server-side. We short-circuit
 * client-side to give the caller a clear failure and avoid a
 * silent partial state. If the RTDB write fails for any other
 * reason (rule denied, network dead, quota) we ROLL BACK the local
 * push before returning so the admin list doesn't show a phantom
 * record that vanishes on next page load.
 */
export async function createOrTouchTournament(
  name: string,
  meta?: CreateTournamentMeta,
): Promise<CreateTournamentOutcome> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, record: null, error: 'Name is empty' };
  const key = normalizeKey(trimmed);
  if (!key) return { ok: false, record: null, error: 'Name did not produce a valid key' };
  const now = Date.now();
  const existing = memoryStore.find((t) => t.key === key);
  const creator = currentUser()?.uid;
  // v3.3 auth guard: fresh creates require a signed-in user so
  // `createdBy` gets stamped and the RTDB rule accepts the write.
  if (!existing && !creator) {
    return {
      ok: false,
      record: null,
      error: 'You must be signed in to create a tournament',
    };
  }
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
  // Snapshot the pre-write state so we can roll back on rule-denial.
  const priorSnapshot = existing ? { ...existing } : null;
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
  const outcome = await writeTournamentToFirebase(record);
  if (!outcome.ok) {
    // Roll back — restore the prior state so the admin list doesn't
    // show a phantom record.
    if (priorSnapshot && existing) {
      Object.assign(existing, priorSnapshot);
    } else {
      const idx = memoryStore.findIndex((t) => t.key === key);
      if (idx !== -1) memoryStore.splice(idx, 1);
    }
    notify();
    return { ok: false, record: null, error: outcome.error };
  }
  return { ok: true, record };
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
        // Empty snapshot (tree cleared): treat as "no remote records"
        // and let mergeRemote reconcile — it'll drop every local
        // record whose key isn't in the empty set. Reported
        // 2026-09-01: remote deletes weren't reflecting across
        // tabs / devices because the null branch short-circuited.
        mergeRemote(raw ?? {});
      },
      () => {},
    );
  } catch {
    // Firebase unreachable — local store still works.
  }
}

/**
 * Parse the tournament's `defaults` sub-node. Absent → undefined
 * (caller keeps app defaults). Present with any subset of fields
 * → return the sanitised subset. Silent-skip on invalid values.
 */
function parseDefaults(raw: unknown): Tournament['defaults'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const out: NonNullable<Tournament['defaults']> = {};
  if (v.mode === 'singles' || v.mode === 'doubles') out.mode = v.mode;
  const bestOf = Number(v.bestOf);
  if (Number.isFinite(bestOf) && bestOf >= 1 && bestOf <= 15) out.bestOf = Math.floor(bestOf);
  const points = Number(v.pointsTarget);
  if (Number.isFinite(points) && points >= 1 && points <= 100) out.pointsTarget = Math.floor(points);
  const maxBoards = Number(v.maxBoards);
  if (Number.isFinite(maxBoards) && maxBoards >= 0 && maxBoards <= 50) out.maxBoards = Math.floor(maxBoards);
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRounds(raw: unknown): Round[] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const rounds: Round[] = [];
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) continue;
    const order = typeof v.order === 'number' && Number.isFinite(v.order) ? v.order : 0;
    const state = v.state === 'closed' ? 'closed' : 'open';
    const createdAt = typeof v.createdAt === 'number' ? v.createdAt : 0;
    const startedAt =
      typeof v.startedAt === 'number' && Number.isFinite(v.startedAt)
        ? v.startedAt
        : undefined;
    rounds.push({
      key,
      name,
      order,
      state,
      createdAt,
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
  }
  // Sort by `order` ascending — that's the display order both in
  // History (R16 → QF → SF → F) and in the setup round picker.
  rounds.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return rounds;
}

function mergeRemote(raw: Record<string, unknown>): void {
  // v3.6.3: reconcile local memoryStore with the snapshot — drop
  // records whose key isn't in the incoming set. Previously only
  // added / updated; deletes on other clients silently accumulated
  // stale rows in this client's memory. Reported 2026-09-01.
  const remoteKeys = new Set(Object.keys(raw));
  for (let i = memoryStore.length - 1; i >= 0; i -= 1) {
    const t = memoryStore[i];
    if (t && !remoteKeys.has(t.key)) {
      memoryStore.splice(i, 1);
    }
  }
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
    const rounds = parseRounds(v.rounds);
    const defaults = parseDefaults(v.defaults);
    const existing = memoryStore.find((t) => t.key === key);
    if (existing) {
      existing.name = name;
      existing.createdAt = createdAt || existing.createdAt;
      // Take the newer lastActive between what we have and what
      // arrived, so a stale local touch doesn't demote a fresher one.
      existing.lastActive = Math.max(existing.lastActive, lastActive);
      // v3.6.3: the snapshot is authoritative — treat absent fields
      // as a REMOVAL, not a "keep local." Previously an admin
      // clearing type / country / defaults on tournament X wouldn't
      // reflect in other tabs / devices because the merger kept
      // the stale local value.
      if (createdBy) existing.createdBy = createdBy;
      else delete existing.createdBy;
      if (type) existing.type = type;
      else delete existing.type;
      if (country) existing.country = country;
      else delete existing.country;
      // Rounds are authoritative from the snapshot — if the remote
      // dropped a round, we drop it locally too. `parseRounds` returns
      // undefined only when the `rounds` sub-node is absent; a present
      // but empty object still yields `[]`, which correctly wipes any
      // stale local list.
      if (rounds !== undefined) existing.rounds = rounds;
      else delete existing.rounds;
      if (defaults !== undefined) existing.defaults = defaults;
      else delete existing.defaults;
    } else {
      memoryStore.push({
        key,
        name,
        createdAt,
        lastActive,
        ...(createdBy ? { createdBy } : {}),
        ...(type ? { type } : {}),
        ...(country ? { country } : {}),
        ...(rounds !== undefined ? { rounds } : {}),
        ...(defaults !== undefined ? { defaults } : {}),
      });
    }
  }
  notify();
}

/**
 * Returned outcome from writeTournamentToFirebase so callers can
 * surface a real error to the umpire instead of silent success on a
 * denied RTDB write. `ok: false` means the local memoryStore push
 * won't survive a page reload — the caller should undo the local
 * push and flash an error banner.
 *
 * Silent-swallow was the v3.0-v3.2 posture: fire-and-forget with the
 * assumption that anonymous creates never fail. v3.3's own-only auth
 * rules can and do deny writes (missing organiser role, missing
 * createdBy on a legacy record, etc.), so callers need to know.
 */
type FirebaseWriteOutcome = { ok: true } | { ok: false; error: string };

async function writeTournamentToFirebase(t: Tournament): Promise<FirebaseWriteOutcome> {
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
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Firebase write failed' };
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
 * Admin-only: patch a tournament's type/country/state without
 * touching its name. Used by the consolidated Edit dialog when the
 * organiser flips open↔closed or picks a different country.
 *
 * `type` and `country` are treated as an atomic pair per the v3.1
 * data-model shape (a closed tournament always has a country). When
 * transitioning from closed → open, `country` can be cleared by
 * passing `null`. Absence of either field in the patch leaves the
 * existing value untouched.
 *
 * Returns the outcome so the dialog can flash inline errors on
 * rule-denied writes.
 */
export async function updateTournamentMeta(
  key: string,
  patch: { type?: 'open' | 'closed'; country?: string | null },
): Promise<TournamentWriteOutcome> {
  if (!key) return { ok: false, error: 'Missing tournament key' };
  const t = memoryStore.find((x) => x.key === key);
  if (!t) return { ok: false, error: 'Tournament not found in local store' };
  const nextType = patch.type ?? t.type ?? 'open';
  // Country: explicit null clears; string sets; undefined keeps.
  const nextCountry =
    patch.country === null
      ? undefined
      : patch.country !== undefined
        ? patch.country.trim()
        : t.country;
  // Consistency guardrail: closed tournaments require a country.
  // A caller can't ship "closed + no country" — the rule set demands
  // one, and the assignment UI would blow up trying to filter.
  if (nextType === 'closed' && !nextCountry) {
    return { ok: false, error: 'Closed tournaments must have a country' };
  }
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // Multi-path update over the two scalars. We can't use a nested
    // update object with `country: null` — Firebase treats that as
    // "delete the child". Use two explicit path writes: one for
    // type, one for country (delete or set).
    const payload: Record<string, unknown> = {
      [`tournaments/${key}/type`]: nextType,
      [`tournaments/${key}/lastActive`]: Date.now(),
    };
    if (patch.country === null) {
      payload[`tournaments/${key}/country`] = null;
    } else if (nextCountry !== undefined) {
      payload[`tournaments/${key}/country`] = nextCountry;
    }
    await update(ref(db, '/'), payload);
    t.type = nextType;
    if (patch.country === null) delete t.country;
    else if (nextCountry !== undefined) t.country = nextCountry;
    t.lastActive = Date.now();
    notify();
    void logAudit({
      action: 'tournament.update',
      path: `tournaments/${key}`,
      before: {
        type: t.type,
        ...(t.country ? { country: t.country } : {}),
      },
      after: {
        type: nextType,
        ...(nextCountry ? { country: nextCountry } : {}),
      },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Update failed' };
  }
}

/**
 * Update tournament-level match defaults (v3.6). Same rule surface
 * as updateTournamentMeta — organiser owns their tournament, super
 * can touch any. Callers pass a partial patch; only present fields
 * are written, rest are left untouched. Pass `null` on a specific
 * field to remove that individual default (fall back to app default).
 */
export async function updateTournamentDefaults(
  key: string,
  patch: Partial<{
    mode: 'singles' | 'doubles' | null;
    bestOf: number | null;
    pointsTarget: number | null;
    maxBoards: number | null;
  }>,
): Promise<TournamentWriteOutcome> {
  if (!key) return { ok: false, error: 'Missing tournament key' };
  const t = memoryStore.find((x) => x.key === key);
  if (!t) return { ok: false, error: 'Tournament not found in local store' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const payload: Record<string, unknown> = {
      [`tournaments/${key}/lastActive`]: Date.now(),
    };
    const nextLocal: NonNullable<Tournament['defaults']> = { ...(t.defaults ?? {}) };
    for (const [field, value] of Object.entries(patch)) {
      const path = `tournaments/${key}/defaults/${field}`;
      if (value === null) {
        payload[path] = null;
        delete (nextLocal as Record<string, unknown>)[field];
      } else if (value !== undefined) {
        payload[path] = value;
        (nextLocal as Record<string, unknown>)[field] = value;
      }
    }
    await update(ref(db, '/'), payload);
    if (Object.keys(nextLocal).length > 0) t.defaults = nextLocal;
    else delete t.defaults;
    t.lastActive = Date.now();
    notify();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Update failed' };
  }
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

// ─── Rounds (v3.2) ─────────────────────────────────────────────────

/**
 * Read the rounds attached to a tournament from the in-memory store.
 * Returns `[]` for a tournament with no rounds (or an unknown key) —
 * callers use `.length === 0` to decide whether to show the round
 * picker in setup / two-level grouping in History.
 */
export function loadRounds(tournamentKey: string): Round[] {
  if (!tournamentKey) return [];
  const t = memoryStore.find((x) => x.key === tournamentKey);
  return t?.rounds ? [...t.rounds] : [];
}

/**
 * Rank rounds under one tournament against a typed query, following
 * the same prefix + substring shape as `rankTournaments`. Closed
 * rounds are excluded so the setup picker never suggests a round the
 * organiser has explicitly closed to new matches. Empty query returns
 * every open round in display order.
 */
export function rankRounds(
  tournamentKey: string,
  query: string,
  limit = 8,
): Round[] {
  const all = loadRounds(tournamentKey).filter((r) => r.state !== 'closed');
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const prefix: Round[] = [];
  const substring: Round[] = [];
  for (const r of all) {
    const n = r.name.toLowerCase();
    if (n.startsWith(q)) prefix.push(r);
    else if (n.includes(q)) substring.push(r);
  }
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Find a round by its display name inside a tournament. Case-
 * insensitive on the trimmed name. Used at match Start to resolve
 * the umpire's typed / picked round to its canonical key.
 */
export function findRoundByName(tournamentKey: string, name: string): Round | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return null;
  const rounds = loadRounds(tournamentKey);
  return rounds.find((r) => r.name.toLowerCase() === trimmed) ?? null;
}

/**
 * Admin-only: create a round under a tournament. Auto-assigns
 * `order = max(existing) + 1` so rounds append at the end by
 * default. Idempotent on the (tournamentKey, roundKey) pair — if
 * the round already exists we just refresh its display name.
 */
export async function addRound(
  tournamentKey: string,
  name: string,
): Promise<TournamentWriteOutcome> {
  const trimmed = name.trim();
  if (!tournamentKey) return { ok: false, error: 'Missing tournament key' };
  if (!trimmed || trimmed.length > 60)
    return { ok: false, error: 'Name must be 1-60 characters' };
  const roundKey = normalizeKey(trimmed);
  if (!roundKey) return { ok: false, error: 'Name did not produce a valid key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const existingRounds = loadRounds(tournamentKey);
    const existing = existingRounds.find((r) => r.key === roundKey);
    const maxOrder = existingRounds.reduce((m, r) => Math.max(m, r.order), 0);
    const nextRecord: Round = existing
      ? { ...existing, name: trimmed }
      : {
          key: roundKey,
          name: trimmed,
          order: maxOrder + 1,
          state: 'open',
          createdAt: Date.now(),
        };
    await update(ref(db, `tournaments/${tournamentKey}/rounds/${roundKey}`), {
      name: nextRecord.name,
      order: nextRecord.order,
      state: nextRecord.state,
      createdAt: nextRecord.createdAt,
    });
    // Local mirror — the Firebase snapshot listener will eventually
    // reconcile, but we update in-place so admins see the row appear
    // immediately without waiting for the round-trip.
    const local = memoryStore.find((t) => t.key === tournamentKey);
    if (local) {
      const rs = local.rounds ? [...local.rounds] : [];
      const idx = rs.findIndex((r) => r.key === roundKey);
      if (idx >= 0) rs[idx] = nextRecord;
      else rs.push(nextRecord);
      rs.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      local.rounds = rs;
      notify();
    }
    void logAudit({
      action: existing ? 'round.rename' : 'round.add',
      path: `tournaments/${tournamentKey}/rounds/${roundKey}`,
      after: { name: trimmed, order: nextRecord.order, state: nextRecord.state },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Add round failed' };
  }
}

/**
 * Mark a round as started by stamping `startedAt = now`. Idempotent
 * — a subsequent call refreshes the timestamp. Called by the ▶
 * Start button on the round row (v3.6.2). Rounds without a
 * startedAt render as 'pending' in the admin UI; rounds with one
 * render as 'running' until the organiser closes them.
 */
export async function startRound(
  tournamentKey: string,
  roundKey: string,
): Promise<TournamentWriteOutcome> {
  if (!tournamentKey || !roundKey)
    return { ok: false, error: 'Missing tournament or round key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const startedAt = Date.now();
    // Also ensure state=open — a round can't be running and closed
    // at the same time. This is a no-op if the round is already open.
    await update(ref(db, `tournaments/${tournamentKey}/rounds/${roundKey}`), {
      startedAt,
      state: 'open',
    });
    const local = memoryStore.find((t) => t.key === tournamentKey);
    if (local?.rounds) {
      const r = local.rounds.find((x) => x.key === roundKey);
      if (r) {
        r.startedAt = startedAt;
        r.state = 'open';
        notify();
      }
    }
    void logAudit({
      action: 'round.start',
      path: `tournaments/${tournamentKey}/rounds/${roundKey}`,
      after: { startedAt },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Start round failed' };
  }
}

/**
 * Toggle a round's open/closed state. Closed rounds are excluded
 * from the setup picker so the umpire can't add new matches to a
 * stage the organiser has moved on from.
 */
export async function setRoundState(
  tournamentKey: string,
  roundKey: string,
  state: 'open' | 'closed',
): Promise<TournamentWriteOutcome> {
  if (!tournamentKey || !roundKey)
    return { ok: false, error: 'Missing tournament or round key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    await update(ref(db, `tournaments/${tournamentKey}/rounds/${roundKey}`), { state });
    const local = memoryStore.find((t) => t.key === tournamentKey);
    if (local?.rounds) {
      const r = local.rounds.find((x) => x.key === roundKey);
      if (r) {
        r.state = state;
        notify();
      }
    }
    void logAudit({
      action: 'round.state',
      path: `tournaments/${tournamentKey}/rounds/${roundKey}`,
      after: { state },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Toggle round state failed' };
  }
}

/**
 * Rename a round. If the new name normalises to the same roundKey,
 * we just refresh the `name` field. Otherwise we clone to a new
 * roundKey, rewrite every match whose (tournamentKey, roundKey)
 * pair pointed at the old key, and delete the old round record.
 * Multi-path update keeps the rewrite atomic.
 */
export async function renameRound(
  tournamentKey: string,
  oldRoundKey: string,
  newName: string,
): Promise<TournamentWriteOutcome> {
  const trimmed = newName.trim();
  if (!tournamentKey || !oldRoundKey)
    return { ok: false, error: 'Missing tournament or round key' };
  if (!trimmed || trimmed.length > 60)
    return { ok: false, error: 'Name must be 1-60 characters' };
  const newRoundKey = normalizeKey(trimmed);
  if (!newRoundKey) return { ok: false, error: 'Name did not produce a valid key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, update, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const oldPath = `tournaments/${tournamentKey}/rounds/${oldRoundKey}`;
    const oldSnap = await get(ref(db, oldPath));
    if (!oldSnap.exists()) return { ok: false, error: 'Round not found' };
    const oldRec = oldSnap.val() as Record<string, unknown>;
    const oldName = typeof oldRec.name === 'string' ? oldRec.name : '';

    if (newRoundKey === oldRoundKey) {
      await update(ref(db, oldPath), { name: trimmed });
      const local = memoryStore.find((t) => t.key === tournamentKey);
      if (local?.rounds) {
        const r = local.rounds.find((x) => x.key === oldRoundKey);
        if (r) {
          r.name = trimmed;
          notify();
        }
      }
      void logAudit({
        action: 'round.rename',
        path: oldPath,
        before: { name: oldName },
        after: { name: trimmed },
      });
      return { ok: true };
    }

    // Clone to a new key + rewrite child matches. Multi-path update.
    const matchesSnap = await get(ref(db, 'matches'));
    const matches =
      (matchesSnap.val() as Record<string, Record<string, unknown>> | null) ?? {};
    const rewrites: Record<string, unknown> = {};
    let matchCount = 0;
    for (const [matchId, m] of Object.entries(matches)) {
      if (
        typeof m.tournamentKey === 'string' &&
        m.tournamentKey === tournamentKey &&
        typeof m.roundKey === 'string' &&
        m.roundKey === oldRoundKey
      ) {
        rewrites[`matches/${matchId}/round`] = trimmed;
        rewrites[`matches/${matchId}/roundKey`] = newRoundKey;
        matchCount += 1;
      }
    }
    rewrites[`tournaments/${tournamentKey}/rounds/${newRoundKey}`] = {
      name: trimmed,
      order: typeof oldRec.order === 'number' ? oldRec.order : 0,
      state: oldRec.state === 'closed' ? 'closed' : 'open',
      createdAt: typeof oldRec.createdAt === 'number' ? oldRec.createdAt : Date.now(),
    };
    await update(ref(db, '/'), rewrites);
    await remove(ref(db, oldPath));

    const local = memoryStore.find((t) => t.key === tournamentKey);
    if (local?.rounds) {
      local.rounds = local.rounds
        .filter((r) => r.key !== oldRoundKey)
        .concat({
          key: newRoundKey,
          name: trimmed,
          order: typeof oldRec.order === 'number' ? oldRec.order : 0,
          state: oldRec.state === 'closed' ? 'closed' : 'open',
          createdAt: typeof oldRec.createdAt === 'number' ? oldRec.createdAt : Date.now(),
        });
      local.rounds.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
      notify();
    }
    void logAudit({
      action: 'round.rename',
      path: `${oldPath} → tournaments/${tournamentKey}/rounds/${newRoundKey}`,
      before: { key: oldRoundKey, name: oldName },
      after: { key: newRoundKey, name: trimmed, matchesRewritten: matchCount },
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Rename round failed' };
  }
}

/**
 * Delete a round from a tournament. Child matches keep their
 * `round` / `roundKey` fields — they'll render under an
 * "Unassigned" sub-group in History (round record gone, tag string
 * survives). Preserves the tag string in case an organiser
 * accidentally deletes and wants to recover; deleting the round
 * record is a cheaper action than a cascade wipe.
 */
export async function deleteRound(
  tournamentKey: string,
  roundKey: string,
): Promise<TournamentWriteOutcome> {
  if (!tournamentKey || !roundKey)
    return { ok: false, error: 'Missing tournament or round key' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `tournaments/${tournamentKey}/rounds/${roundKey}`;
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    await remove(ref(db, path));
    const local = memoryStore.find((t) => t.key === tournamentKey);
    if (local?.rounds) {
      local.rounds = local.rounds.filter((r) => r.key !== roundKey);
      notify();
    }
    void logAudit({
      action: 'round.delete',
      path,
      before: existing ?? undefined,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Delete round failed' };
  }
}

/**
 * Count matches currently tagged under (tournamentKey, roundKey).
 * Used by the admin panel's delete-round dialog to warn "this round
 * has N matches — they'll be un-tagged" before the organiser
 * confirms. Silent-on-failure returns 0.
 */
export async function countMatchesByRoundKey(
  tournamentKey: string,
  roundKey: string,
): Promise<number> {
  if (!tournamentKey || !roundKey) return 0;
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'matches'));
    const all = snap.val() as Record<string, { tournamentKey?: string; roundKey?: string }> | null;
    if (!all) return 0;
    let count = 0;
    for (const m of Object.values(all)) {
      if (
        m &&
        typeof m === 'object' &&
        m.tournamentKey === tournamentKey &&
        m.roundKey === roundKey
      ) {
        count += 1;
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/** Test hook — reset store between assertions. */
export function _resetForTests(): void {
  memoryStore = [];
  listeners = new Set();
  firebaseUnsubscribe?.();
  firebaseUnsubscribe = null;
}
