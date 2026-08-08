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
  createPlayer,
  ensurePlayerInFirebase,
  loadAll,
  type Player,
} from './players';

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
  winner: 'a' | 'b' | null;
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
 * Resolve a typed name into a Firebase player id. If `resolvedId` is
 * already known from Setup, use it. Otherwise call createPlayer to
 * either find an existing local match or create a fresh record.
 * Returns null if the name is empty (used for absent doubles partners).
 */
function resolvePlayerId(name: string, resolvedId: string | null | undefined): string | null {
  const n = (name ?? '').trim();
  if (!n) return null;
  if (resolvedId) return resolvedId;
  try {
    const p = createPlayer(n);
    return p.id;
  } catch {
    // isPlausibleName rejected — very short or clearly garbage.
    // We still record the match, but with an empty playerId for this
    // side. The typed string lives on in the notes field.
    return null;
  }
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

  const playerAId = resolvePlayerId(identity.aName, identity.aResolvedId);
  const playerA2Id = isPractice
    ? null
    : resolvePlayerId(identity.a2Name ?? '', identity.a2ResolvedId);
  const playerBId = isPractice ? null : resolvePlayerId(identity.bName, identity.bResolvedId);
  const playerB2Id = isPractice
    ? null
    : resolvePlayerId(identity.b2Name ?? '', identity.b2ResolvedId);

  // If any resolved id points to a seed-only player (bundled Wikipedia
  // entry never materialised to Firebase), materialise now — otherwise
  // future History page reads would see /matches/{id}.playerAId pointing
  // at a /players/{id} that RTDB doesn't know about, and the display
  // would fall back to rendering the raw slug.
  await Promise.all(
    [playerAId, playerA2Id, playerBId, playerB2Id]
      .filter((id): id is string => !!id)
      .map((id) => ensurePlayerInFirebase(id)),
  );

  const record = {
    mode: result.mode,
    ...(playerAId ? { playerAId } : {}),
    ...(playerA2Id ? { playerA2Id } : {}),
    ...(playerBId ? { playerBId } : {}),
    ...(playerB2Id ? { playerB2Id } : {}),
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
      ? { tournament: result.tournament.trim().slice(0, 60) }
      : {}),
    startedAt: result.startedAt,
    endedAt: result.endedAt,
    ...(createdBy ? { createdBy } : {}),
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
  notes?: { a?: string; b?: string };
  cfg?: {
    bestOf?: number;
    maxBoards?: number;
    pointsTarget?: number;
    format?: string;
  };
  result?: {
    winner?: 'a' | 'b' | null;
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
export function playerName(id: string | undefined | null): string {
  if (!id) return '';
  const all: readonly Player[] = loadAll();
  const p = all.find((x) => x.id === id);
  if (p) return p.canonicalName;
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
