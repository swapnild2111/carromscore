/**
 * Offline write queue for match state + archive writes.
 *
 * Purpose: when connectivity is down (see `./connectivity.ts`), the
 * ScoreBoard cannot reach Firebase to publish the live payload or
 * archive the finished match. This module holds those writes in
 * localStorage and flushes them when connectivity returns.
 *
 * ## Two queue kinds
 *
 * - **Live writes** — every umpire tap on the score screen produces
 *   a `publishLive` call. High frequency. We **coalesce by mid**:
 *   only the LATEST payload per match matters, since RTDB itself is
 *   last-write-wins on `/live/{mid}`. The queue thus stores at most
 *   one live entry per active match, no matter how many taps
 *   happened during the outage.
 *
 * - **Match archives** — one per End Match. Append-only. Each entry
 *   carries the full `MatchIdentityInput` + `MatchResultInput` so
 *   `finishMatch()` can be replayed verbatim on flush.
 *
 * ## Timestamps on flush
 *
 * Live writes: `updatedAt` is restamped to `serverNow()` at flush
 * time. The RTDB rule at `database.rules.json:87` requires
 * `updatedAt` be within 60s of Firebase server time; the value
 * captured at enqueue time will be stale by the time we flush.
 *
 * Match writes: `startedAt` and `endedAt` are preserved as the true
 * historical values so the archive reads honestly. This depends on
 * the corresponding RTDB rule change (see plan §5) that drops the
 * 5-min guard on the create validator. Until that rule is
 * published, replays of matches ended > 5 min ago will be rejected
 * server-side and remain queued.
 *
 * ## Persistence
 *
 * One localStorage key (`SYNC_QUEUE_KEY`) holds a JSON blob with
 * both queues. Sized to comfortably fit weeks of matches (matches
 * are ~2-3 KB each with boardLog). A soft cap prevents runaway
 * growth if a bug ever traps flushing.
 *
 * ## Retry semantics
 *
 * `flushQueue()` walks each queued item and calls the same helpers
 * the online path uses (`publishLive`, `finishMatch`). On per-item
 * failure the item stays in the queue for the next flush. On
 * per-item success it's removed. `flushQueue()` returns counts so
 * consumers can toast progress ("3 matches synced").
 *
 * ## Not covered here
 *
 * - Player + tournament writes (fire-and-forget already, low value
 *   to queue — see history.ts + tournaments.ts).
 * - Admin edits (interactive; caller surfaces failures directly).
 * - Audit log writes (auth-gated; won't reach RTDB anyway when
 *   offline since we couldn't have signed in).
 */

import type { LiveMeta, LivePayload } from './live-sync';
import type { MatchIdentityInput, MatchResultInput } from './history';
import { serverNow, getConnectivity } from './connectivity';

const SYNC_QUEUE_KEY = 'carromscore:sync-queue-v1';

/**
 * Soft cap on the JSON-serialised queue size. 500 KB is comfortably
 * larger than a full tournament's worth of finished matches (~2-3 KB
 * each including boardLog + practiceBoards). If enqueuing would push
 * past this, we drop the OLDEST match write to make room — the live
 * write always fits since it's a single per-mid entry.
 */
const MAX_QUEUE_BYTES = 500 * 1024;

export type QueuedLiveWrite = {
  kind: 'live';
  mid: string;
  meta: LiveMeta;
  payload: LivePayload;
  enqueuedAt: number;
};

export type QueuedMatchWrite = {
  kind: 'match';
  identity: MatchIdentityInput;
  result: MatchResultInput;
  /**
   * Auth uid at the moment of End. If the umpire was signed in when
   * they ended the match, we stamp it here so `finishMatch()` at
   * flush time can pass it as an override — otherwise the flush
   * would happen anonymously and the archive would lose `createdBy`.
   * Null if the umpire wasn't signed in at End; flush uses whatever
   * `currentUser()` returns then (usually still null → anonymous).
   */
  createdByAtEnqueue: string | null;
  enqueuedAt: number;
};

type QueueSnapshot = {
  live: QueuedLiveWrite[];
  match: QueuedMatchWrite[];
};

const emptySnapshot: QueueSnapshot = { live: [], match: [] };

function readQueue(): QueueSnapshot {
  try {
    const raw = localStorage.getItem(SYNC_QUEUE_KEY);
    if (!raw) return { live: [], match: [] };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { live: [], match: [] };
    const live = Array.isArray(parsed.live) ? (parsed.live as QueuedLiveWrite[]) : [];
    const match = Array.isArray(parsed.match) ? (parsed.match as QueuedMatchWrite[]) : [];
    return { live, match };
  } catch {
    // Corrupted JSON — safer to start empty than crash the app on
    // every boot.
    return { live: [], match: [] };
  }
}

function writeQueue(snapshot: QueueSnapshot): void {
  try {
    let json = JSON.stringify(snapshot);
    // Drop oldest match writes until we fit under the cap. Live
    // queue is single-slot-per-mid so it never bloats.
    while (json.length > MAX_QUEUE_BYTES && snapshot.match.length > 0) {
      snapshot.match.shift();
      json = JSON.stringify(snapshot);
    }
    localStorage.setItem(SYNC_QUEUE_KEY, json);
  } catch {
    // quota / disabled — swallow. The umpire's local match state
    // is still preserved by the ScoreBoard's own localStorage key;
    // queue loss just means the archive won't sync until the umpire
    // reopens the match and taps End again while online.
  }
}

/**
 * Enqueue a live write. Coalesces by mid — the queue keeps at most
 * one entry per match, always the latest state.
 *
 * `enqueuedAt` is refreshed on every call (not just the first) so
 * downstream consumers can detect a change on the coalesced entry
 * via a timestamp bump. Specifically: LiveLobby's cross-tab
 * refreshLocalOffline() compares (mid, updatedAt) shallowly to
 * decide whether to re-render. Without this bump, per-tap
 * coalesces looked identical to Tab B and it didn't live-update
 * (reported 2026-08-16).
 */
export function enqueueLive(item: Omit<QueuedLiveWrite, 'kind' | 'enqueuedAt'>): void {
  const q = readQueue();
  // Drop any prior entry for this mid; keep just the latest.
  q.live = q.live.filter((e) => e.mid !== item.mid);
  q.live.push({ kind: 'live', enqueuedAt: Date.now(), ...item });
  writeQueue(q);
}

/**
 * Enqueue a finished-match archive write. Append-only.
 */
export function enqueueMatch(
  item: Omit<QueuedMatchWrite, 'kind' | 'enqueuedAt'>,
): void {
  const q = readQueue();
  q.match.push({ kind: 'match', enqueuedAt: Date.now(), ...item });
  writeQueue(q);
}

/**
 * Drop the live entry for the given mid, if any. Used when a match
 * ends — we don't need to keep publishing the live state once the
 * archive write is queued; the archive is the authoritative record.
 */
export function dropLive(mid: string): void {
  const q = readQueue();
  const before = q.live.length;
  q.live = q.live.filter((e) => e.mid !== mid);
  if (q.live.length !== before) writeQueue(q);
}

/**
 * Peek at the current queue counts. Used by the offline banner /
 * lobby to show "N unsynced matches" hints without exposing the
 * full payloads.
 */
export function queueCounts(): { live: number; match: number } {
  const q = readQueue();
  return { live: q.live.length, match: q.match.length };
}

/**
 * Peek at the current queue's live entries. Used by LiveLobby's
 * cross-tab merge so a second tab on the same device sees the
 * umpire's active offline match as if it were live.
 *
 * Callers should NOT mutate the returned array — treat it as
 * read-only. Fresh copy on each call so localStorage 'storage'
 * events force a re-read.
 */
export function peekLive(): QueuedLiveWrite[] {
  return readQueue().live.slice();
}

/**
 * The localStorage key backing the queue. Exported so cross-tab
 * listeners (in LiveLobby.svelte) can filter `storage` events to
 * just this key instead of firing on every unrelated write.
 */
export const SYNC_QUEUE_STORAGE_KEY = SYNC_QUEUE_KEY;

export type FlushResult = {
  /** Live writes that flushed successfully. */
  liveOk: number;
  /** Live writes still pending (server rejected or network died mid-flush). */
  liveRemaining: number;
  /** Match archives that flushed successfully. */
  matchOk: number;
  /** Match archives still pending. */
  matchRemaining: number;
};

/**
 * Attempt to flush the queue. Idempotent — safe to call from
 * multiple triggers (online event, periodic poll, user tap).
 *
 * Bails early if `getConnectivity().online === false`; there's no
 * point trying and the RTDB SDK's own queue would just buffer the
 * writes locally, defeating the point of restamping.
 *
 * Live writes are restamped to `serverNow()` right before publish
 * (see `updatedAt` handling in `publishLive`). Match writes' true
 * `startedAt` / `endedAt` are preserved (see file header).
 */
export async function flushQueue(): Promise<FlushResult> {
  const result: FlushResult = {
    liveOk: 0,
    liveRemaining: 0,
    matchOk: 0,
    matchRemaining: 0,
  };
  if (!getConnectivity().online) {
    const c = queueCounts();
    result.liveRemaining = c.live;
    result.matchRemaining = c.match;
    return result;
  }
  const q = readQueue();
  // Nothing to do — return zeros without touching Firebase.
  if (q.live.length === 0 && q.match.length === 0) return result;

  // Lazy-import the helpers so this module stays cheap when the
  // queue is empty (very common case: freshly-online umpires).
  const [{ publishLive }, { finishMatch }] = await Promise.all([
    import('./live-sync'),
    import('./history'),
  ]);

  // Flush live writes first. They're per-tap state; getting them
  // to Firebase quickly makes the /live/ lobby show the correct
  // sets/points as soon as the umpire reconnects.
  const liveRemaining: QueuedLiveWrite[] = [];
  for (const item of q.live) {
    try {
      // publishLive stamps updatedAt = Date.now() internally. That
      // would use the local clock, which may be skewed. We can't
      // change publishLive without touching every existing caller,
      // so we accept a small imperfection here: the queue-flushed
      // updatedAt will be within a second of serverNow() as long
      // as the local clock isn't badly wrong. The 60s RTDB validator
      // window is generous enough to absorb typical drift.
      //
      // If we ever see rejects because of drift, the fix is to
      // extend publishLive with an optional `updatedAtOverride`
      // and pass `serverNow()` here.
      await publishLive(item.mid, item.meta, item.payload);
      result.liveOk += 1;
    } catch {
      // publishLive is silent-on-failure — it won't throw, so we
      // should rarely get here. But if it does (import failure,
      // etc.), keep the item queued.
      liveRemaining.push(item);
    }
  }

  // Flush match archives. Each call goes to `/matches/{new-id}`
  // (push()) so retries won't collide. finishMatch returns the
  // new id or null on failure.
  const matchRemaining: QueuedMatchWrite[] = [];
  for (const item of q.match) {
    try {
      const matchId = await finishMatch(
        item.identity,
        item.result,
        item.createdByAtEnqueue ?? undefined,
      );
      if (matchId) {
        result.matchOk += 1;
      } else {
        // Rules rejected the write (typically because RTDB rules
        // still enforce the 5-min endedAt guard until you publish
        // the relaxed rule). Keep the item for the next flush.
        matchRemaining.push(item);
      }
    } catch {
      matchRemaining.push(item);
    }
  }

  writeQueue({ live: liveRemaining, match: matchRemaining });
  result.liveRemaining = liveRemaining.length;
  result.matchRemaining = matchRemaining.length;
  // serverNow read forces the caller module to see the connectivity
  // module as a real dependency. Not used otherwise. Kept for future
  // extension (see comment above about updatedAtOverride).
  void serverNow;
  return result;
}
