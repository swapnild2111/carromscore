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
import { createPlayer, loadAll, type Player } from './players';

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
  startedAt: number;
  endedAt: number;
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
  startedAt?: number;
  endedAt?: number;
};

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
 * Look up a player's display name by id. Returns the id itself as a
 * fallback if the player isn't in the in-memory store (unresolved
 * subscription, transient network issue).
 */
export function playerName(id: string | undefined | null): string {
  if (!id) return '';
  const all: readonly Player[] = loadAll();
  const p = all.find((x) => x.id === id);
  return p?.canonicalName ?? id;
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
