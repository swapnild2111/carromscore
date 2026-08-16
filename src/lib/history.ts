/**
 * Match history — records every completed match to Firebase RTDB
 * `/matches/{matchId}` and provides read access for the History page.
 *
 * A "match record" is the finished shape of a match: the identity of
 * each side (via `playerId` — never bare strings, so leaderboards work
 * across name spellings), the final scores, and the rules that were in
 * effect. Match records are write-once; they're the archival ledger.
 *
 * Player identity resolution: at match END, every side has either
 *   (a) a resolvedPlayerId already set at Setup (either because the
 *       user picked from the dropdown, or because the typed name was
 *       an exact/alias match to an existing Player, or because the
 *       user tapped the fuzzy-confirm chip), OR
 *   (b) no resolvedPlayerId, meaning "typed a new name, no existing
 *       identity found." In that case, finishMatch creates a fresh
 *       Player record from the typed name.
 *
 * Practice runs and abandoned setups do NOT create Player records —
 * only completed head-to-head matches do. Rationale: setup-time typos
 * and abandoned attempts shouldn't pollute the shared roster.
 *
 * House style: lazy Firebase import, silent-on-failure. If the network
 * is dead or rules deny, the match record is skipped. localStorage
 * mirror will be added in the "keep on device only" toggle work later.
 */
import {
  loadAll,
  type Player,
} from './players';
import { currentUser } from './auth';
import { logAudit } from './audit';
import { normalizeKey } from './tournaments';

/**
 * The full identity block passed from ScoreBoard's endMatch() to
 * finishMatch(). Each side names either a Firebase playerId (already
 * resolved) or a plain string that finishMatch will create-or-resolve.
 */
export type MatchIdentityInput = {
  aName: string;
  aResolvedId: string | null;
  a2Name?: string;
  a2ResolvedId?: string | null;
  bName: string;
  bResolvedId: string | null;
  b2Name?: string;
  b2ResolvedId?: string | null;
};

/**
 * Finished-match snapshot passed to finishMatch(). Structured so the
 * Firebase record shape and the UI's needs are both derivable.
 */
export type MatchResultInput = {
  mode: 'singles' | 'doubles' | 'practice';
  winner: 'a' | 'b' | 'draw' | null;
  sideA: { points: number; sets: number };
  sideB: { points: number; sets: number };
  board: number;
  cfg: {
    bestOf: number;
    maxBoards: number;
    pointsTarget: number;
    format: string;
  };
  notes: { a: string; b: string };
  /**
   * Tournament / event tag. Empty = untagged (grouped as "Default"
   * in the lobby, kept 3 months). Non-empty = "protected" tag
   * (grouped by name, kept 1 year for versus matches).
   */
  tournament?: string;
  /**
   * Slug form of `tournament` (the key under /tournaments/{key}/).
   * Written alongside `tournament` on every archive write so RTDB
   * rules can look up `/tournaments/{tournamentKey}/organisers/`
   * without having to slugify at rule-eval time. Absent on records
   * from before this field was introduced — those can only be
   * edited by super-admins, not tournament organisers.
   */
  tournamentKey?: string;
  startedAt: number;
  endedAt: number;
  /**
   * Board-by-board log captured across the match. Empty in Practice
   * mode. May be shorter than `board` if BOARD+1 was pressed without
   * queen (blocked) or if the umpire manually adjusted BOARD after
   * a snapshot; both are edge cases and non-fatal.
   */
  boardLog?: Array<{
    set: number;
    board: number;
    breakSide: 'a' | 'b';
    queen: 'a' | 'b';
    pointsA: number;
    pointsB: number;
    endedAt: number;
  }>;
  /**
   * Practice-only: 2D matrix of missed-shot counts. Outer index = set,
   * inner = board. Present only when mode === 'practice'.
   */
  practiceBoards?: number[][];
};

/**
 * Resolve a typed name into a Firebase player id, if one was already
 * chosen during match Setup (via the picker's exact-match / suggest
 * flow). If no `resolvedId` was captured at Setup, this returns
 * `null` — the umpire's raw typed name is preserved on the match
 * record via the aName/bName fields (see B1), and the match archives
 * without a /players/{id} link.
 *
 * The prior behaviour was to call `createPlayer(name)` here as a
 * fallback, which auto-materialised a new /players/{id} entry for
 * every never-seen-before name typed at End. That created a long
 * tail of near-duplicate records (typo variants, casing differences,
 * inconsistent initials) that admins then had to merge by hand.
 * From B2 forward, only the admin panel creates player records;
 * matches with unresolved names archive under the raw string.
 */
function resolvePlayerId(name: string, resolvedId: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  return resolvedId ?? null;
}

/**
 * Write a finished match to Firebase `/matches/{matchId}`. Returns the
 * generated matchId on success, or null if the write failed (network
 * dead, rules denied, Firebase package failed to load).
 *
 * Practice runs are also recorded so users can look up drill sessions
 * later. Only playerA is required; playerB* and A2 stay empty.
 */
export async function finishMatch(
  identity: MatchIdentityInput,
  result: MatchResultInput,
  createdBy?: string,
): Promise<string | null> {
  const isPractice = result.mode === 'practice';
  // Stamp `createdBy` with the signed-in user's uid when the caller
  // doesn't override. Anonymous stays anonymous (field simply absent —
  // RTDB validator accepts the omission). Added 2026-08-09 to prepare
  // the ground for admin edit permissions.
  //
  // Await the auth cache in case the umpire tapped End before the
  // Firebase auth chunk finished hydrating on this tab. Bounded wait
  // (see awaitAuthReady) so a dead network never blocks the archive.
  // Without this, a fresh page load + immediate End writes the record
  // with createdBy: undefined, breaking self-delete for the caller.
  const { awaitAuthReady } = await import('./auth');
  if (!createdBy) await awaitAuthReady();
  const finalCreatedBy = createdBy ?? currentUser()?.uid;
  // Denormalise the caller's display name onto the record too, so the
  // recap can attribute "Recorded by …" without needing to read /users
  // (which is super-read only) or exposing raw emails. Empty string
  // when the Google profile has no name — recap falls back to a
  // generic label. Historical records keep the name at write time,
  // which is the correct semantic (records reflect the moment).
  const finalCreatedByName = finalCreatedBy
    ? (currentUser()?.displayName ?? '').slice(0, 80)
    : '';

  const playerAId = resolvePlayerId(identity.aName, identity.aResolvedId);
  const playerA2Id = isPractice
    ? null
    : resolvePlayerId(identity.a2Name ?? '', identity.a2ResolvedId);
  const playerBId = isPractice ? null : resolvePlayerId(identity.bName, identity.bResolvedId);
  const playerB2Id = isPractice
    ? null
    : resolvePlayerId(identity.b2Name ?? '', identity.b2ResolvedId);

  // Seed-only player materialisation used to run here (bundled
  // Wikipedia entries that never touched Firebase). Retired with B2:
  // the picker at Setup is now the only path to a Firebase-backed
  // player id on a match, and the picker already resolves through
  // the identity store's canonical entries — anything reaching
  // finishMatch with a resolvedId is already known to Firebase.
  // ensurePlayerInFirebase in src/lib/players.ts is now dead code;
  // safe to leave until a later cleanup pass.

  // Preserve raw umpire-typed names on the record. Written alongside
  // the resolved ids so any downstream reader has an honest display
  // fallback — critical after B2 removes the id-auto-create at End
  // (records will start carrying names without ids), and useful for
  // legibility even when both are present. 80-char cap matches the
  // RTDB validator.
  const rawAName = (identity.aName ?? '').trim().slice(0, 80);
  const rawA2Name = (identity.a2Name ?? '').trim().slice(0, 80);
  const rawBName = (identity.bName ?? '').trim().slice(0, 80);
  const rawB2Name = (identity.b2Name ?? '').trim().slice(0, 80);

  const record = {
    mode: result.mode,
    ...(playerAId ? { playerAId } : {}),
    ...(playerA2Id ? { playerA2Id } : {}),
    ...(playerBId ? { playerBId } : {}),
    ...(playerB2Id ? { playerB2Id } : {}),
    ...(rawAName ? { aName: rawAName } : {}),
    ...(rawA2Name ? { a2Name: rawA2Name } : {}),
    ...(rawBName ? { bName: rawBName } : {}),
    ...(rawB2Name ? { b2Name: rawB2Name } : {}),
    notes: {
      a: (result.notes.a ?? '').slice(0, 40),
      b: (result.notes.b ?? '').slice(0, 40),
    },
    cfg: {
      bestOf: result.cfg.bestOf,
      maxBoards: result.cfg.maxBoards,
      pointsTarget: result.cfg.pointsTarget,
      format: result.cfg.format,
    },
    result: {
      winner: result.winner,
      finalPointsA: result.sideA.points,
      finalPointsB: result.sideB.points,
      setsA: result.sideA.sets,
      setsB: result.sideB.sets,
      boardCount: result.board,
    },
    ...(result.boardLog && result.boardLog.length > 0
      ? { boardLog: result.boardLog }
      : {}),
    ...(result.practiceBoards && result.practiceBoards.length > 0
      ? { practiceBoards: result.practiceBoards }
      : {}),
    ...(result.tournament?.trim()
      ? {
          tournament: result.tournament.trim().slice(0, 60),
          // Slug alongside the display name so the RTDB rule can
          // look up /tournaments/{tournamentKey}/organisers/ to
          // authorise per-tournament edits. See database.rules.json
          // on the matches/$matchId .write branch.
          tournamentKey: normalizeKey(result.tournament),
        }
      : {}),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    ...(finalCreatedBy ? { createdBy: finalCreatedBy } : {}),
    ...(finalCreatedByName ? { createdByName: finalCreatedByName } : {}),
  };

  try {
    const [{ firebaseApp }, { getDatabase, ref, push, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const matchesRef = ref(db, 'matches');
    const newRef = push(matchesRef);
    await set(newRef, record);
    return newRef.key ?? null;
  } catch {
    // Firebase unreachable / rules denied / package failed to load.
    // localStorage-only history will be added by the privacy toggle
    // work later (v2.0 Step 7).
    return null;
  }
}

/**
 * Load the full match archive from Firebase for the /history page.
 * Returns matches sorted by endedAt DESC (newest first). Errors return
 * an empty array; the UI shows an empty state.
 */
export type MatchRecord = {
  id: string;
  mode: 'singles' | 'doubles' | 'practice';
  playerAId?: string;
  playerA2Id?: string;
  playerBId?: string;
  playerB2Id?: string;
  /**
   * Umpire-typed raw names captured at End Match time. Written
   * alongside the ids so any downstream reader can render "the
   * name the umpire actually typed" even if the /players/{id}
   * store is stale or missing (e.g. player deleted, id never
   * created because auto-create was off — see finishMatch). The
   * id, when present, is still the authoritative link for
   * leaderboards and cross-name lookups; these fields are the
   * display fallback. Truncated to 80 chars per RTDB rule.
   */
  aName?: string;
  a2Name?: string;
  bName?: string;
  b2Name?: string;
  notes?: { a?: string; b?: string };
  cfg?: {
    bestOf?: number;
    maxBoards?: number;
    pointsTarget?: number;
    format?: string;
  };
  result?: {
    winner?: 'a' | 'b' | 'draw' | null;
    finalPointsA?: number;
    finalPointsB?: number;
    setsA?: number;
    setsB?: number;
    boardCount?: number;
  };
  boardLog?: Array<{
    set: number;
    board: number;
    breakSide: 'a' | 'b';
    queen: 'a' | 'b';
    pointsA: number;
    pointsB: number;
    endedAt: number;
  }>;
  practiceBoards?: number[][];
  /**
   * Tournament tag. Absent / empty → treated as "Default" bucket in
   * the lobby, and gets the shorter (3-month) retention.
   */
  tournament?: string;
  /**
   * Firebase Auth uid of whichever signed-in user recorded the match
   * (via finishMatch). Absent on records written anonymously or
   * before the auth-stamping was added. Used to gate the "Delete
   * this match" affordance on /live/ — only the creator sees it,
   * and only the creator's write passes the RTDB rule.
   */
  createdBy?: string;
  /**
   * Denormalised Google display name of the caller at write time.
   * Kept alongside `createdBy` so the recap can attribute the record
   * without needing to read /users (super-read only) or exposing
   * raw emails. Historical records keep the write-time name — a
   * later profile rename doesn't rewrite past matches, which is
   * the correct archival semantic.
   */
  createdByName?: string;
  startedAt?: number;
  endedAt?: number;
};

/**
 * Best-effort sweep: remove match records whose `endedAt` is older
 * than a mode+tournament-aware threshold. Piggybacks on the lobby
 * load — no scheduled infrastructure, no Blaze tier. Silent-on-
 * failure per house style; a failed sweep just leaves old records
 * in place until the next successful call.
 *
 * Retention thresholds:
 *   - versus WITH tournament tag: 1 year. Tagged matches are the
 *     ones a user cared enough to bucket into an event — keep them
 *     long enough that "Silver Cup 2026 → last year's final" is
 *     still a lookup that works.
 *   - versus WITHOUT tag (Default bucket): 3 months. Casual play,
 *     high-volume, short TTL keeps the lobby uncluttered.
 *   - practice: 3 months regardless of tag. Solo drills are the
 *     highest-volume record kind; tagging doesn't change that.
 *
 * Player + tournament records are NOT swept — tiny, and their
 * presence powers future identity/tag autocomplete even after the
 * referencing matches age out.
 */
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
let sweepInFlight = false;

export async function sweepOldMatches(
  taggedVsMaxAgeMs = ONE_YEAR_MS,
  untaggedMaxAgeMs = THREE_MONTHS_MS,
): Promise<number> {
  if (sweepInFlight) return 0;
  sweepInFlight = true;
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'matches'));
    const val = snap.val() as Record<string, MatchRecord> | null;
    if (!val) return 0;
    const now = Date.now();
    const taggedVsCutoff = now - taggedVsMaxAgeMs;
    const untaggedCutoff = now - untaggedMaxAgeMs;
    const stale: string[] = [];
    for (const [id, r] of Object.entries(val)) {
      if (!r || typeof r !== 'object') continue;
      const endedAt = typeof r.endedAt === 'number' ? r.endedAt : 0;
      if (endedAt <= 0) continue;
      const tagged = !!r.tournament?.trim();
      // Practice always uses the short TTL, even if someone
      // synthetically set a tag on a practice record.
      const cutoff = r.mode === 'practice' || !tagged ? untaggedCutoff : taggedVsCutoff;
      if (endedAt < cutoff) stale.push(id);
    }
    // Fire deletes in parallel. Cap the batch so a huge backlog on
    // first-ever sweep doesn't stall the caller — future lobby loads
    // will finish the rest.
    const batch = stale.slice(0, 100);
    await Promise.all(batch.map((id) => remove(ref(db, `matches/${id}`)).catch(() => {})));
    return batch.length;
  } catch {
    return 0;
  } finally {
    sweepInFlight = false;
  }
}

export async function loadHistory(): Promise<MatchRecord[]> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'matches'));
    const val = snap.val() as Record<string, unknown> | null;
    if (!val) return [];
    const out: MatchRecord[] = [];
    for (const [id, r] of Object.entries(val)) {
      if (!r || typeof r !== 'object') continue;
      out.push({ id, ...(r as Omit<MatchRecord, 'id'>) });
    }
    out.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    return out;
  } catch {
    return [];
  }
}

/**
 * Fields of a match record that admin edits may change. Excludes:
 *   - `id` (identity, not payload)
 *   - `mode`, `startedAt` (structural, editing them is out of scope)
 *   - `createdBy` (provenance, never rewritten by admin)
 * Includes:
 *   - Result scalars (final points, sets, board count, winner)
 *   - `notes` (side A / B notes)
 *   - `tournament` (organiser cannot change it; super can — the rule
 *     enforces this. Passing `undefined` here removes the tag.)
 *   - `boardLog` (per-board rows). Practice matches would edit
 *     `practiceBoards` instead — not exposed in this patch since the
 *     Prem/Yash-class bug we're solving is versus-mode scoring, not
 *     solo drill misses.
 *   - `endedAt` — deliberately preserved on the record (retention
 *     ages the record correctly). Not part of the patch shape.
 */
export type MatchPatch = {
  result?: {
    winner?: 'a' | 'b' | 'draw' | null;
    finalPointsA?: number;
    finalPointsB?: number;
    setsA?: number;
    setsB?: number;
    boardCount?: number;
  };
  notes?: { a?: string; b?: string };
  tournament?: string | null;
  boardLog?: Array<{
    set: number;
    board: number;
    breakSide: 'a' | 'b';
    queen: 'a' | 'b';
    pointsA: number;
    pointsB: number;
    endedAt: number;
  }>;
};

export type WriteOutcome = { ok: true } | { ok: false; error: string };

/**
 * Admin-only: apply a patch to an existing match record. The caller
 * (MatchEditModal) is responsible for confirming the user has rights;
 * the RTDB rule at `/matches/$id` is what actually enforces it — an
 * unauthorised update will fail with a permission-denied error, which
 * this helper surfaces via the returned WriteOutcome so the modal
 * can display it inline.
 *
 * Preserves `endedAt` verbatim so retention still ages the record
 * correctly. Preserves `createdBy` and `startedAt`. Fetches current
 * record first, merges the patch, writes back with `set()`.
 *
 * Silent-on-failure convention doesn't apply here — the caller (an
 * admin) needs to know the write failed. This is the intentional
 * deviation from the rest of the module.
 */
/**
 * Merge patched fields onto an existing match record. Pure — no I/O.
 * Extracted from updateMatch so each field's normalisation lives in
 * its own helper and the outer function stays readable.
 */
function applyMatchPatch(
  existing: Record<string, unknown>,
  patch: MatchPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...existing };
  // Opportunistic backfill: if this record predates the
  // tournamentKey field but has a tournament tag, stamp the slug
  // in now. Any admin edit of a legacy record thus makes it
  // organiser-editable going forward. Idempotent — no-op if
  // the field is already present.
  if (
    typeof next.tournament === 'string' &&
    next.tournament.trim() !== '' &&
    typeof next.tournamentKey !== 'string'
  ) {
    next.tournamentKey = normalizeKey(next.tournament);
  }
  if (patch.result) {
    const prev = (existing.result as Record<string, unknown>) ?? {};
    next.result = { ...prev, ...patch.result };
  }
  if (patch.notes) {
    next.notes = mergeNotes(existing.notes, patch.notes);
  }
  applyTournamentPatch(next, patch.tournament);
  if (patch.boardLog) {
    applyBoardLogPatch(next, patch.boardLog);
  }
  return next;
}

function mergeNotes(
  prev: unknown,
  patch: NonNullable<MatchPatch['notes']>,
): Record<string, unknown> {
  const base = (prev as Record<string, unknown>) ?? {};
  return {
    ...base,
    ...(patch.a !== undefined ? { a: patch.a.slice(0, 40) } : {}),
    ...(patch.b !== undefined ? { b: patch.b.slice(0, 40) } : {}),
  };
}

function applyTournamentPatch(
  next: Record<string, unknown>,
  tournament: MatchPatch['tournament'],
): void {
  if (tournament === null || tournament === '') {
    // Explicit clearing — remove both fields entirely so the
    // retention sweep classifies the match as untagged (3-month TTL)
    // and no stale tournamentKey survives.
    delete next.tournament;
    delete next.tournamentKey;
    return;
  }
  if (typeof tournament === 'string') {
    const trimmed = tournament.trim().slice(0, 60);
    next.tournament = trimmed;
    // Slug alongside the display name so the RTDB rule can look up
    // /tournaments/{tournamentKey}/organisers/ on organiser edits.
    // Keep tournament + tournamentKey in lockstep on every write —
    // callers must never write one without the other.
    next.tournamentKey = normalizeKey(trimmed);
  }
}

function applyBoardLogPatch(
  next: Record<string, unknown>,
  rows: NonNullable<MatchPatch['boardLog']>,
): void {
  // Trim to sensible bounds; skip malformed rows entirely.
  const cleaned = rows
    .filter((e) => e && typeof e === 'object')
    .map((e) => ({
      set: Number(e.set) || 0,
      board: Number(e.board) || 0,
      breakSide: e.breakSide === 'b' ? 'b' : 'a',
      queen: e.queen === 'b' ? 'b' : 'a',
      pointsA: Math.max(0, Number(e.pointsA) || 0),
      pointsB: Math.max(0, Number(e.pointsB) || 0),
      endedAt: Number(e.endedAt) || Date.now(),
    }));
  if (cleaned.length === 0) {
    delete next.boardLog;
  } else {
    next.boardLog = cleaned;
  }
}

export async function updateMatch(
  matchId: string,
  patch: MatchPatch,
): Promise<WriteOutcome> {
  if (!matchId) return { ok: false, error: 'Missing match id' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `matches/${matchId}`;
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    if (!existing) return { ok: false, error: 'Match not found' };

    const next = applyMatchPatch(existing, patch);
    await set(ref(db, path), next);
    // Mutate-then-audit: the record has been persisted successfully,
    // so we log the diff for the /admin/ Audit tab. Silent-on-failure
    // inside logAudit — a rare write failure produces a console.warn
    // but doesn't roll back the mutation.
    void logAudit({
      action: 'match.update',
      path,
      before: existing,
      after: next,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Write failed' };
  }
}

/**
 * Admin-only: delete a match record. Same silent-off convention as
 * updateMatch — the returned WriteOutcome carries the failure reason
 * so the admin modal can render it.
 *
 * NOTE: deleting a match does NOT touch any related `/live/{mid}`
 * broadcast record (those age out on their own). Callers who also
 * want to remove a stuck live record should call `deleteLive(mid)`
 * separately.
 */
export async function deleteMatch(matchId: string): Promise<WriteOutcome> {
  if (!matchId) return { ok: false, error: 'Missing match id' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `matches/${matchId}`;
    // Snapshot the current record BEFORE deleting so the audit entry
    // carries the record shape (useful when someone asks "what did
    // that Silver Cup match look like?" months later).
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    await remove(ref(db, path));
    void logAudit({
      action: 'match.delete',
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
 * User-scoped: delete a match the signed-in caller created themselves.
 * Same wire shape as `deleteMatch` but the audit action is
 * `match.self_delete` so the log clearly distinguishes user-initiated
 * removals from admin/organiser sweeps.
 *
 * Ownership is enforced by the RTDB rule at /matches/$id/.write —
 * this helper is a UI convenience for the "Delete this match" button
 * on the /live/ lobby's match sheet. If the caller isn't the owner
 * (or isn't signed in at all), the RTDB write returns a
 * permission-denied error and we surface it as a failed WriteOutcome.
 */
export async function selfDeleteMatch(matchId: string): Promise<WriteOutcome> {
  if (!matchId) return { ok: false, error: 'Missing match id' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `matches/${matchId}`;
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    await remove(ref(db, path));
    void logAudit({
      action: 'match.self_delete',
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
 * Result of a bulk delete: how many items were deleted, how many
 * failed, and the first error (if any) so the UI can surface it
 * without spamming per-row failures.
 */
export type BulkOutcome = {
  ok: boolean;
  deleted: number;
  failed: number;
  error?: string;
};

/**
 * Admin-only: bulk-delete a set of match records. Each match is
 * removed individually so per-record audit entries are preserved
 * (a super-admin often wants to see "who deleted match X" later);
 * this trades atomicity for auditability, which is the right call
 * for a rare admin operation. Batches through Promise.all in
 * groups of 25 so we don't fan out too aggressively against RTDB.
 */
export async function deleteMatches(matchIds: string[]): Promise<BulkOutcome> {
  const clean = matchIds.filter((id) => typeof id === 'string' && id.length > 0);
  if (clean.length === 0) return { ok: true, deleted: 0, failed: 0 };
  const BATCH_SIZE = 25;
  let deleted = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const slice = clean.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(slice.map((id) => deleteMatch(id)));
    for (const r of results) {
      if (r.ok) deleted += 1;
      else {
        failed += 1;
        if (!firstError) firstError = r.error;
      }
    }
  }
  return {
    ok: failed === 0,
    deleted,
    failed,
    ...(firstError ? { error: firstError } : {}),
  };
}

/**
 * Look up a player's display name by id. Returns a friendly fallback
 * if the identity store hasn't yet loaded the player — better than
 * showing the raw kebab-slug.
 *
 * The slug is derived from the canonical name (lowercased + hyphenated
 * + 4-char random suffix). We can reverse it approximately by
 * stripping the suffix and title-casing the hyphens — good enough for
 * the "player record exists in Firebase but our subscription hasn't
 * hydrated yet" case.
 */
/**
 * Resolve a player id to a display name.
 *
 * Resolution order:
 *   1. `id` → matching `/players/{id}` in the local store's
 *      canonical name (authoritative when the store has the record).
 *   2. `id` → prettified slug (best-effort fallback if the store
 *      hasn't hydrated yet).
 *   3. `fallbackName` (the raw umpire-typed name from the match
 *      record) if id is absent or slug-only-prettify would look
 *      worse than the actual typed string. Used by match-record
 *      readers where the id may be missing entirely (B2 soft-archive:
 *      matches created without id-auto-create).
 *   4. Empty string.
 *
 * Callers that hold the match record should pass `record.aName`,
 * `record.bName`, etc. as `fallbackName`. Callers that don't have
 * a record (e.g. leaderboards keying purely on id) omit it.
 */
export function playerName(
  id: string | undefined | null,
  fallbackName?: string | undefined | null,
): string {
  const fb = (fallbackName ?? '').trim();
  if (!id) return fb;
  const all: readonly Player[] = loadAll();
  const p = all.find((x) => x.id === id);
  if (p) return p.canonicalName;
  // Id points at a player the store doesn't know. Prefer the raw
  // fallback name when we have one — a typed "Ravi K" reads better
  // than a slug-prettified "Ravi K X7f2".
  if (fb) return fb;
  return prettifySlug(id);
}

function prettifySlug(slug: string): string {
  const withoutSuffix = slug.replace(/-[a-z0-9]{4}$/i, '');
  const words = withoutSuffix.split('-').filter(Boolean);
  if (words.length === 0) return slug;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Cross-page identity handoff ─────────────────────────────────────
// Setup resolves each typed name to a Firebase playerId (or leaves it
// null for "create on match end"). The score screen needs to know those
// resolutions to write the correct match record on End. We store them
// in localStorage under a per-match key so a mid-match refresh survives.

const IDENTITY_KEY_PREFIX = 'carromscore:match-identity:';
const START_KEY_PREFIX = 'carromscore:match-started:';

export type MatchIdentityState = {
  aResolvedId: string | null;
  a2ResolvedId: string | null;
  bResolvedId: string | null;
  b2ResolvedId: string | null;
};

/** Save the resolved ids from Setup so the Score screen can read them. */
export function saveMatchIdentity(matchStateKey: string, ids: MatchIdentityState): void {
  try {
    localStorage.setItem(IDENTITY_KEY_PREFIX + matchStateKey, JSON.stringify(ids));
  } catch {
    // quota exceeded / disabled — identity resolution falls back to
    // create-on-end using just the typed names.
  }
}

export function loadMatchIdentity(matchStateKey: string): MatchIdentityState {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY_PREFIX + matchStateKey);
    if (!raw) return blankIdentity();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blankIdentity();
    return {
      aResolvedId: typeof parsed.aResolvedId === 'string' ? parsed.aResolvedId : null,
      a2ResolvedId: typeof parsed.a2ResolvedId === 'string' ? parsed.a2ResolvedId : null,
      bResolvedId: typeof parsed.bResolvedId === 'string' ? parsed.bResolvedId : null,
      b2ResolvedId: typeof parsed.b2ResolvedId === 'string' ? parsed.b2ResolvedId : null,
    };
  } catch {
    return blankIdentity();
  }
}

export function clearMatchIdentity(matchStateKey: string): void {
  try {
    localStorage.removeItem(IDENTITY_KEY_PREFIX + matchStateKey);
    localStorage.removeItem(START_KEY_PREFIX + matchStateKey);
  } catch {
    // ignore
  }
}

function blankIdentity(): MatchIdentityState {
  return { aResolvedId: null, a2ResolvedId: null, bResolvedId: null, b2ResolvedId: null };
}

/** Record when a match started, so we can compute duration on End. */
export function saveMatchStart(matchStateKey: string, startedAt: number): void {
  try {
    localStorage.setItem(START_KEY_PREFIX + matchStateKey, String(startedAt));
  } catch {
    // ignore
  }
}

export function loadMatchStart(matchStateKey: string): number | null {
  try {
    const raw = localStorage.getItem(START_KEY_PREFIX + matchStateKey);
    if (!raw) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}
