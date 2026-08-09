import { currentUser } from './auth';
import { logAudit } from './audit';

/**
 * Live broadcast — one-way sync of a match's live state from an
 * umpire's device (publisher) to any number of spectator devices
 * (subscribers) via Firebase Realtime Database `/live/{mid}`.
 *
 * Design notes:
 * - `mid` is a short 6-char slug generated at match-start when the
 *   umpire toggles "Live broadcast" on. It rides the URL so setup
 *   and score screens carry it forward, and it's what spectators
 *   type or click into.
 * - The publisher writes the full `liveState` object on every state
 *   change (rather than diffs). RTDB's `set()` is idempotent, and
 *   the payload is tiny (< 1 KB).
 * - The subscriber uses `onValue()` which is push-based: the umpire
 *   ships an update, the spectator's screen paints within ~500 ms.
 * - House style: lazy-load `firebase/database`, silent-on-failure.
 *   Publish errors don't affect the umpire's session; subscribe
 *   errors leave the spectator screen at its last-known state.
 * - v2.0 does NOT garbage-collect `/live/{mid}` after a match ends.
 *   RTDB records are cheap and small; if it becomes a problem we
 *   can add a Firebase scheduled function later. For now, stale
 *   live records are harmless — spectators pointed at an old mid
 *   see the final state and nothing further.
 */

/** Shape of the payload written to `/live/{mid}/liveState`. */
/**
 * One completed board's snapshot. Log grows by one entry per BOARD+1
 * tap on the umpire's device (see ScoreBoard.adjustBoard). Includes
 * break, queen holder, per-board points delta, and timestamp.
 */
export type BoardLogEntry = {
  /** Zero-indexed set within the match. bo1 → always 0. */
  set: number;
  /** 1-indexed board number within its set. */
  board: number;
  breakSide: 'a' | 'b';
  queen: 'a' | 'b';
  pointsA: number;
  pointsB: number;
  endedAt: number;
};

export type LivePayload = {
  sideA: { points: number; sets: number };
  sideB: { points: number; sets: number };
  board: number;
  currentBreak: 'a' | 'b' | null;
  queenHolder: 'a' | 'b' | null;
  matchResult: 'a' | 'b' | null;
  boardLog?: BoardLogEntry[];
  practiceBoards?: number[][];
};

/**
 * Static-for-the-match metadata that the spectator needs to render but
 * doesn't change on every state update. Published once at Start and
 * on any config edit (name typo fix at half-time, etc.).
 */
export type LiveMeta = {
  mode: 'singles' | 'doubles' | 'practice';
  playerA: string;
  playerA2?: string;
  playerB: string;
  playerB2?: string;
  noteA?: string;
  noteB?: string;
  bestOf: number;
  pointsTarget: number;
  maxBoards: number;
  /** Tournament / event tag. Blank = "Default" bucket in the lobby. */
  tournament?: string;
};

/** Metadata + payload — what actually lives at `/live/{mid}`. */
export type LiveRecord = {
  matchId?: string;
  updatedAt: number;
  meta: LiveMeta;
  liveState: LivePayload;
};

/**
 * Generate a fresh 6-character mid slug. Uses crypto.randomUUID()
 * for quality entropy and encodes the leading chars into base36.
 * 6 chars of base36 = 2.1 billion values — collision risk is
 * negligible for a hobby project's scale.
 */
export function newMid(): string {
  // crypto.getRandomValues is available in every modern browser
  // and in the Firebase SDK's Node context.
  const buf = new Uint8Array(6);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => (b % 36).toString(36))
    .join('');
}

/**
 * Write the umpire's current match state to `/live/{mid}`.
 * Idempotent — safe to call as often as state changes. On network
 * failure or rule denial, returns without throwing.
 *
 * Uses `set()` (not update) because the payload is complete and
 * fixed-shape. Every write includes an updatedAt timestamp — the
 * RTDB rule requires it to be within 60 seconds of the server
 * clock, which prevents replay of stale writes but leaves a
 * comfortable window for clock skew.
 */
export async function publishLive(
  mid: string,
  meta: LiveMeta,
  payload: LivePayload,
  matchId?: string,
): Promise<void> {
  if (!mid || mid.length < 4) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // Firebase RTDB rejects `undefined` values (they'd be treated as
    // deletions). Filter to only defined keys before writing.
    const liveState: LivePayload = {
      sideA: payload.sideA,
      sideB: payload.sideB,
      board: payload.board,
      currentBreak: payload.currentBreak,
      queenHolder: payload.queenHolder,
      matchResult: payload.matchResult,
      ...(payload.boardLog && payload.boardLog.length > 0
        ? { boardLog: payload.boardLog }
        : {}),
      ...(payload.practiceBoards ? { practiceBoards: payload.practiceBoards } : {}),
    };
    const metaClean: Record<string, unknown> = {
      mode: meta.mode,
      playerA: meta.playerA,
      playerB: meta.playerB,
      bestOf: meta.bestOf,
      pointsTarget: meta.pointsTarget,
      maxBoards: meta.maxBoards,
    };
    if (meta.playerA2) metaClean.playerA2 = meta.playerA2;
    if (meta.playerB2) metaClean.playerB2 = meta.playerB2;
    if (meta.noteA) metaClean.noteA = meta.noteA;
    if (meta.noteB) metaClean.noteB = meta.noteB;
    if (meta.tournament) metaClean.tournament = meta.tournament;
    // Stamp `createdBy` when signed in. Anonymous stays anonymous —
    // field absent. RTDB validator on live/$mid/createdBy accepts a
    // string ≤ 64 chars (rules updated 2026-08-09).
    const createdBy = currentUser()?.uid;
    await set(ref(db, `live/${mid}`), {
      ...(matchId ? { matchId } : {}),
      ...(createdBy ? { createdBy } : {}),
      updatedAt: Date.now(),
      meta: metaClean,
      liveState,
    });
  } catch {
    // Silent-on-failure — publisher keeps playing.
  }
}

/**
 * Subscribe to updates at `/live/{mid}`. Calls `onData` immediately
 * with the current snapshot (if any) and again on every remote change.
 * Returns an unsubscribe function.
 *
 * If Firebase fails to load entirely, `onData` is never called and
 * the returned function is a no-op. The spectator UI should show a
 * "connecting…" state and then a "no live match at this URL" state
 * on a timeout.
 */
export async function subscribeLive(
  mid: string,
  onData: (record: LiveRecord | null) => void,
): Promise<() => void> {
  if (!mid || mid.length < 4) return () => {};
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const liveRef = ref(db, `live/${mid}`);
    const unsub = onValue(
      liveRef,
      (snap) => {
        const val = snap.val() as LiveRecord | null;
        onData(val);
      },
      // Silent-on-error — leave the last known state on screen.
      () => onData(null),
    );
    return unsub;
  } catch {
    return () => {};
  }
}

/**
 * Register a cleanup that fires when the umpire's device disconnects
 * from Firebase (tab close, offline, phone sleep). Firebase RTDB's
 * `onDisconnect` API pre-registers a write that the server executes
 * server-side if the WebSocket drops without a graceful goodbye.
 *
 * Why this exists: match records live at `/live/{mid}` for viewers.
 * If the umpire closes their tab mid-match without tapping End, we
 * want the ghost entry to disappear from the lobby quickly rather
 * than sit around until the 4h stale filter kicks in.
 *
 * Behaviour:
 * - Call at match start (or on ScoreBoard mount after a refresh).
 * - Firebase remembers the pending write until this session's WS
 *   disconnects. A brief network hiccup won't trigger it — RTDB
 *   waits for a real close.
 * - Umpire refreshes the tab: cleanup fires on the old session, then
 *   the new session re-arms. No visible flicker in practice because
 *   RTDB batches disconnect processing.
 * - Umpire taps End: the match state gets `matchResult` set which
 *   moves it to "Recently finished" in the lobby. Cleanup still
 *   fires when they close the tab — fine, ended matches are
 *   preserved as archived MatchRecord entries via history.ts.
 */
export async function armLiveCleanup(mid: string): Promise<void> {
  if (!mid || mid.length < 4) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, onDisconnect }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // .remove() on onDisconnect deletes the whole /live/{mid} node
    // when the session drops. Idempotent — re-arming replaces any
    // prior registration.
    await onDisconnect(ref(db, `live/${mid}`)).remove();
  } catch {
    // Firebase unreachable / rules denied. The 4h stale filter is the
    // fallback, so cleanup is best-effort.
  }
}

/**
 * A lobby entry: one live record annotated with the mid slug so the
 * lobby view can build links back to individual matches.
 */
export type LobbyEntry = LiveRecord & { mid: string };

/**
 * Subscribe to the entire `/live` tree. Called by the lobby view to
 * show every ongoing (and recently ended) match at once. `onData`
 * fires with the current snapshot after connect and again on every
 * change — a match starting, a point being scored, a match ending.
 *
 * The caller is responsible for filtering by `updatedAt` if they want
 * to hide stale records — e.g., only show entries whose last update
 * is within the past few hours.
 */
export async function subscribeAllLive(
  onData: (entries: LobbyEntry[]) => void,
): Promise<() => void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const liveRef = ref(db, 'live');
    const unsub = onValue(
      liveRef,
      (snap) => {
        const raw = snap.val() as Record<string, LiveRecord> | null;
        if (!raw) {
          onData([]);
          return;
        }
        const entries: LobbyEntry[] = [];
        for (const [mid, record] of Object.entries(raw)) {
          if (!record || typeof record !== 'object') continue;
          if (!record.updatedAt || !record.liveState || !record.meta) continue;
          entries.push({ ...record, mid });
        }
        onData(entries);
      },
      () => onData([]),
    );
    return unsub;
  } catch {
    return () => {};
  }
}

// ─── Admin helpers (super-only) ─────────────────────────────────────

export type LiveWriteOutcome =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Admin-only: delete a stuck live record. Used by the /admin/ Live
 * cleanup tab to kill records where the umpire closed the browser
 * without hitting End, and the onDisconnect handler didn't fire
 * (e.g. force-quit, connectivity blip). Anonymous delete is also
 * permitted by the rule as the ephemeral fallback for
 * armLiveCleanup, but this admin path is explicit + audited.
 */
export async function deleteLive(mid: string): Promise<LiveWriteOutcome> {
  if (!mid) return { ok: false, error: 'Missing mid' };
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const path = `live/${mid}`;
    const snap = await get(ref(db, path));
    const existing = snap.val() as Record<string, unknown> | null;
    await remove(ref(db, path));
    void logAudit({
      action: 'live.delete',
      path,
      before: existing ?? undefined,
    });
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg || 'Delete failed' };
  }
}

/** Rolled-up counts for a bulk delete + the first failure message. */
export type LiveBulkOutcome = {
  ok: boolean;
  deleted: number;
  failed: number;
  error?: string;
};

/**
 * Admin-only: bulk-delete a set of live records. Each removal is
 * individually audited (see deleteLive). Batches through
 * Promise.all in groups of 25 so a large stuck-live cleanup
 * doesn't fan out too aggressively against RTDB.
 */
export async function deleteLiveMany(mids: string[]): Promise<LiveBulkOutcome> {
  const clean = mids.filter((m) => typeof m === 'string' && m.length > 0);
  if (clean.length === 0) return { ok: true, deleted: 0, failed: 0 };
  const BATCH_SIZE = 25;
  let deleted = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (let i = 0; i < clean.length; i += BATCH_SIZE) {
    const slice = clean.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(slice.map((m) => deleteLive(m)));
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
 * Best-effort sweep of stuck `/live/{mid}` records. Any record that
 * hasn't been updated in `maxAgeMs` (default 4h) is removed. Same
 * shape as sweepOldMatches on /matches — no scheduled infra, no
 * Blaze tier; the sweep piggybacks on the admin panel load.
 *
 * A record with matchResult === null but a recent updatedAt is
 * NOT swept: the umpire is still broadcasting, the browser just
 * hasn't paused for 4h. The 4h window is intentionally generous —
 * a real long-format tournament match can take that long, and we'd
 * rather leak a stuck record than kill a legit broadcast.
 *
 * Anonymous delete is permitted by the rule (`/live/{mid}/.write`
 * is public — kept that way so armLiveCleanup's onDisconnect can
 * fire without auth). Silent-on-failure; a failed sweep just
 * leaves the records for the next opportunity.
 */
const LIVE_STALE_WINDOW_MS = 4 * 60 * 60 * 1000;
let liveSweepInFlight = false;

export async function sweepStaleLive(
  maxAgeMs = LIVE_STALE_WINDOW_MS,
): Promise<number> {
  if (liveSweepInFlight) return 0;
  liveSweepInFlight = true;
  try {
    const [{ firebaseApp }, { getDatabase, ref, get, remove }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, 'live'));
    const val = snap.val() as Record<string, { updatedAt?: number }> | null;
    if (!val) return 0;
    const cutoff = Date.now() - maxAgeMs;
    const stale: string[] = [];
    for (const [mid, r] of Object.entries(val)) {
      if (!r || typeof r !== 'object') continue;
      const upd = typeof r.updatedAt === 'number' ? r.updatedAt : 0;
      if (upd > 0 && upd < cutoff) stale.push(mid);
    }
    // Cap the batch so a huge backlog on first-ever sweep doesn't
    // stall the caller — the next admin load will finish the rest.
    const batch = stale.slice(0, 50);
    await Promise.all(
      batch.map((mid) => remove(ref(db, `live/${mid}`)).catch(() => {})),
    );
    return batch.length;
  } catch {
    return 0;
  } finally {
    liveSweepInFlight = false;
  }
}
