/**
 * Planned matches — pre-created match slots for tournament brackets
 * (v3.6). An organiser fills these in ahead of a tournament, one
 * per bracket slot, and prints their QR codes. On match day the
 * umpire scans the QR, the score screen fetches this record,
 * populates setup, and the umpire taps Start to promote it to a
 * live match.
 *
 * Data model: /planned/{mid} under RTDB. See database.rules.json
 * for the write authority (tournament organiser or super, plus
 * claimedBy self-write for the umpire flow). See
 * docs/plan/tournament-brackets.md for the full plan.
 *
 * Silent-on-failure like the rest of the module — failed writes
 * return { ok: false, error }, no throws.
 */

import { firebaseApp } from './firebase';

/** Match config shape stored on a planned record. Same field names
 *  as MatchConfig / MatchRecord.cfg. Any missing field falls back
 *  to the parent tournament's `defaults` on scan. */
export type PlannedCfg = {
  bestOf?: number;
  pointsTarget?: number;
  maxBoards?: number;
  format?: string;
};

export type PlannedMatch = {
  /** Firebase push id of this planned slot. Never rendered — used
   *  as the QR's identifier only. */
  mid: string;
  mode: 'singles' | 'doubles';
  tournament: string;
  tournamentKey: string;
  round: string;
  roundKey: string;
  /** 1-based order within the round, for the organiser's own sort. */
  matchOrder: number;
  /** Set when the match has been played and archived (v3.6.2+). */
  completedAt?: number;
  completedBy?: string;
  result?: { setsA: number; setsB: number; winner: 'a' | 'b' | 'draw' };
  /** 1..99 physical board number this match is scheduled on.
   *  Optional for backwards compatibility with v3.6.0 planned records,
   *  but the bracket UI (v3.6.1+) always sets it. The board number is
   *  what makes the QR sticker reusable across rounds: Board 1's QR
   *  encodes `?tournament=<key>&board=1` and stays valid every round;
   *  each scan resolves to the lowest-ordered unclaimed match for
   *  that board (see resolvePlannedByBoard). */
  board?: number;
  // Side A
  aName: string;
  a2Name?: string;
  aResolvedId?: string;
  a2ResolvedId?: string;
  // Side B
  bName: string;
  b2Name?: string;
  bResolvedId?: string;
  b2ResolvedId?: string;
  /** Per-match config overrides. Empty → inherits tournament defaults. */
  cfg?: PlannedCfg;
  createdBy: string;
  createdAt: number;
  /** uid of the umpire currently scoring this match. null/absent = free. */
  claimedBy?: string;
  /** epoch ms when claimedBy was set. */
  claimedAt?: number;
};

export type PlannedWriteOutcome =
  | { ok: true; mid: string }
  | { ok: false; error: string };

export type PlannedReadOutcome =
  | { ok: true; match: PlannedMatch | null }
  | { ok: false; error: string };

/**
 * Create a new planned match slot under a tournament. Caller passes
 * everything except `mid` (Firebase push-id assigned here) + system
 * fields (createdBy, createdAt).
 */
export async function createPlannedMatch(input: {
  mode: 'singles' | 'doubles';
  tournament: string;
  tournamentKey: string;
  round: string;
  roundKey: string;
  matchOrder: number;
  board?: number;
  aName: string;
  a2Name?: string;
  aResolvedId?: string;
  a2ResolvedId?: string;
  bName: string;
  b2Name?: string;
  bResolvedId?: string;
  b2ResolvedId?: string;
  cfg?: PlannedCfg;
  createdBy: string;
}): Promise<PlannedWriteOutcome> {
  try {
    const [{ getDatabase, ref, push, set }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const newRef = push(ref(db, 'planned'));
    if (!newRef.key) return { ok: false, error: 'no push key' };
    // Trim + slice string fields to fit the .validate rules.
    const trim80 = (s: string | undefined) => (s ?? '').trim().slice(0, 80);
    const trim60 = (s: string) => s.trim().slice(0, 60);
    const trim64 = (s: string | undefined) => (s ?? '').trim().slice(0, 64);
    const record: Record<string, unknown> = {
      mode: input.mode,
      tournament: trim60(input.tournament),
      tournamentKey: trim60(input.tournamentKey),
      round: trim60(input.round),
      roundKey: trim60(input.roundKey),
      matchOrder: Math.max(1, Math.min(999, Math.floor(input.matchOrder))),
      aName: trim80(input.aName),
      bName: trim80(input.bName),
      createdBy: trim64(input.createdBy),
      createdAt: Date.now(),
    };
    if (typeof input.board === 'number' && Number.isFinite(input.board)) {
      // 1..99 — same range as matchOrder's upper bound (999) is overkill;
      // physical tournaments rarely exceed 20 boards in one venue.
      const b = Math.max(1, Math.min(99, Math.floor(input.board)));
      record.board = b;
    }
    if (input.a2Name?.trim()) record.a2Name = trim80(input.a2Name);
    if (input.b2Name?.trim()) record.b2Name = trim80(input.b2Name);
    if (input.aResolvedId?.trim()) record.aResolvedId = trim64(input.aResolvedId);
    if (input.a2ResolvedId?.trim()) record.a2ResolvedId = trim64(input.a2ResolvedId);
    if (input.bResolvedId?.trim()) record.bResolvedId = trim64(input.bResolvedId);
    if (input.b2ResolvedId?.trim()) record.b2ResolvedId = trim64(input.b2ResolvedId);
    if (input.cfg && Object.keys(input.cfg).length > 0) record.cfg = { ...input.cfg };
    await set(newRef, record);
    return { ok: true, mid: newRef.key };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'create failed' };
  }
}

/**
 * Read a single planned match. Returns { ok:true, match:null } when
 * the mid isn't found — distinguishes "unknown mid" (rescanned after
 * scoring completed) from a genuine network error.
 */
export async function loadPlannedMatch(mid: string): Promise<PlannedReadOutcome> {
  if (!mid || mid.length < 4 || mid.length > 24) {
    return { ok: false, error: 'invalid mid' };
  }
  try {
    const [{ getDatabase, ref, get }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, `planned/${mid}`));
    const val = snap.val() as Omit<PlannedMatch, 'mid'> | null;
    if (!val) return { ok: true, match: null };
    return { ok: true, match: { mid, ...val } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'read failed' };
  }
}

/**
 * Delete a planned slot. Called by:
 *   - the bracket admin's per-row delete button
 *   - endMatch() in ScoreBoard when a planned-launched match archives
 * The RTDB rule permits deletion by super, the tournament's
 * organiser, the record's createdBy, and (v3.6) the current
 * claimedBy — so the umpire-owned end-of-match delete works from
 * the umpire's own device.
 */
export async function deletePlannedMatch(mid: string): Promise<PlannedWriteOutcome> {
  if (!mid) return { ok: false, error: 'no mid' };
  try {
    const [{ getDatabase, ref, remove }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    await remove(ref(db, `planned/${mid}`));
    return { ok: true, mid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'delete failed' };
  }
}

/**
 * Mark a planned slot as complete after the match has been archived.
 * Replaces deletePlannedMatch at match end — the record stays so the
 * bracket shows a "done" state for every played match.
 */
export async function markPlannedComplete(
  mid: string,
  result: { setsA: number; setsB: number; winner: 'a' | 'b' | 'draw' },
  uid: string,
): Promise<PlannedWriteOutcome> {
  if (!mid) return { ok: false, error: 'no mid' };
  try {
    const [{ getDatabase, ref, get, update }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, `planned/${mid}`));
    if (!snap.exists()) return { ok: false, error: 'not found' };
    await update(ref(db, `planned/${mid}`), {
      completedAt: Date.now(),
      completedBy: uid,
      result,
    });
    return { ok: true, mid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'complete failed' };
  }
}

/**
 * Claim (or take over) a planned match by writing claimedBy: uid.
 * Called by MatchSetup when the umpire scans the QR. Bumps
 * claimedAt too so the admin UI can show "claimed 3 min ago".
 */
export async function claimPlannedMatch(
  mid: string,
  uid: string,
): Promise<PlannedWriteOutcome> {
  if (!mid || !uid) return { ok: false, error: 'missing mid or uid' };
  try {
    const [{ getDatabase, ref, get, set }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const snap = await get(ref(db, `planned/${mid}`));
    const val = snap.val() as Omit<PlannedMatch, 'mid'> | null;
    if (!val) return { ok: false, error: 'planned match not found' };
    const next = { ...val, claimedBy: uid, claimedAt: Date.now() };
    await set(ref(db, `planned/${mid}`), next);
    return { ok: true, mid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'claim failed' };
  }
}

/**
 * Subscribe to every planned match under a tournament. Feeds the
 * bracket admin's row list. Uses onValue on /planned (returns the
 * whole map) and filters client-side by tournamentKey — safe
 * because the planned tree is small (order of "N matches per
 * tournament × handful of active tournaments"). Same pattern the
 * live-lobby uses for /live.
 */
/**
 * Resolve which planned match a Board N QR should point at right now.
 * Called by MatchSetup when the URL carries `?tournament=<key>&board=<N>`
 * (the stable board sticker). Auto-advance behaviour:
 *
 *   - Fetch every /planned record for this tournament + board.
 *   - Prefer records that ARE NOT claimed (a claimed record is a
 *     match currently in progress on another device — offer it as a
 *     takeover candidate rather than picking a different one).
 *   - Sort by roundKey then matchOrder ascending, pick the first.
 *
 * When all board-N slots have been played (records deleted on
 * archive), returns { ok:true, match: null } — MatchSetup renders
 * the same "not found" banner as with a stale ?planned=<mid> link.
 *
 * The claimed-record fallback lets the umpire (whoever tapped the
 * board's QR first) resume mid-match by re-scanning: if their claim
 * is on the top match, they get their own match back; if someone
 * else claimed, they see the takeover banner.
 */
export async function resolvePlannedByBoard(
  tournamentKey: string,
  board: number,
): Promise<PlannedReadOutcome> {
  if (!tournamentKey || !board || board < 1 || board > 99) {
    return { ok: false, error: 'invalid tournament or board' };
  }
  try {
    const [{ getDatabase, ref, get }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());

    // Read tournament rounds and planned matches in parallel.
    const [plannedSnap, tournamentSnap] = await Promise.all([
      get(ref(db, 'planned')),
      get(ref(db, `tournaments/${tournamentKey}/rounds`)),
    ]);

    // Build set of roundKeys that are open (not closed).
    // If we can't read rounds (permissions, missing) fall back to all rounds.
    const runningRoundKeys = new Set<string>();
    let hasRoundData = false;
    const roundsRaw = tournamentSnap.val() as Record<string, {
      state?: string;
      startedAt?: number;
    }> | null;
    if (roundsRaw) {
      hasRoundData = true;
      for (const [rk, rv] of Object.entries(roundsRaw)) {
        if (!rv || typeof rv !== 'object') continue;
        // Include any round that isn't explicitly closed — pending rounds
        // (state='open', no startedAt) are still scannable so the umpire
        // can load Round 2 matches as soon as the admin creates them,
        // without waiting for the admin to tap "Start round".
        if (rv.state !== 'closed') {
          runningRoundKeys.add(rk);
        }
      }
    }

    const raw = plannedSnap.val() as Record<string, Omit<PlannedMatch, 'mid'>> | null;
    if (!raw) return { ok: true, match: null };

    const candidates: PlannedMatch[] = [];
    for (const [mid, v] of Object.entries(raw)) {
      if (!v || typeof v !== 'object') continue;
      if (v.tournamentKey !== tournamentKey) continue;
      if (v.board !== board) continue;
      // Skip completed slots — they've already been played.
      if ((v as PlannedMatch).completedAt) continue;
      // Only include matches whose round is currently running.
      // If round data is unavailable, include all (safe fallback).
      if (hasRoundData && v.roundKey && !runningRoundKeys.has(v.roundKey)) continue;
      candidates.push({ mid, ...v });
    }
    if (candidates.length === 0) return { ok: true, match: null };
    // Unclaimed first, then by matchOrder ascending within the running round.
    candidates.sort((a, b) => {
      const aClaimed = a.claimedBy ? 1 : 0;
      const bClaimed = b.claimedBy ? 1 : 0;
      if (aClaimed !== bClaimed) return aClaimed - bClaimed;
      return (a.matchOrder ?? 0) - (b.matchOrder ?? 0);
    });
    return { ok: true, match: candidates[0] ?? null };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'resolve failed' };
  }
}

export async function subscribePlannedByTournament(
  tournamentKey: string,
  cb: (matches: PlannedMatch[]) => void,
): Promise<() => void> {
  if (!tournamentKey) return () => {};
  try {
    const [{ getDatabase, ref, onValue }] = await Promise.all([
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const unsub = onValue(ref(db, 'planned'), (snap) => {
      const raw = snap.val() as Record<string, Omit<PlannedMatch, 'mid'>> | null;
      if (!raw) {
        cb([]);
        return;
      }
      const out: PlannedMatch[] = [];
      for (const [mid, v] of Object.entries(raw)) {
        if (!v || typeof v !== 'object') continue;
        if (v.tournamentKey !== tournamentKey) continue;
        out.push({ mid, ...v });
      }
      out.sort((a, b) => {
        // Group by round then matchOrder for a stable list. Coerce
        // to '' when a legacy record is missing roundKey — otherwise
        // .localeCompare on `undefined` throws and kills the whole
        // subscription callback (symptom: PrintBracket stuck on
        // 'Loading…' because `ready` never flips).
        const ak = a.roundKey ?? '';
        const bk = b.roundKey ?? '';
        if (ak !== bk) return ak.localeCompare(bk);
        return (a.matchOrder ?? 0) - (b.matchOrder ?? 0);
      });
      cb(out);
    });
    return () => unsub();
  } catch {
    return () => {};
  }
}
