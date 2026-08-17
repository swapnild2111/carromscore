<script lang="ts">
  import { onMount } from 'svelte';
  import '@fontsource/dseg7-classic/700.css';
  import {
    DEFAULT_CONFIG,
    decodeConfig,
    isBoardsUnlimited,
    matchStateKey,
    teamLabel,
    type MatchConfig,
    type Side as SideId,
  } from '../lib/match';
  import { APP_VERSION, releaseUrl } from '../lib/version';
  import {
    finishMatch,
    loadMatchIdentity,
    loadMatchStart,
    clearMatchIdentity,
  } from '../lib/history';
  import { subscribePlayers } from '../lib/players';
  import {
    deleteLive,
    nudgeFirebaseReconnect,
    publishLive,
    type LivePayload,
    type LiveRecord,
  } from '../lib/live-sync';
  import LiveScoreboardView from './LiveScoreboardView.svelte';
  import MatchEditModal from './MatchEditModal.svelte';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { subscribeAuth, currentUser } from '../lib/auth';
  import { clearResume } from '../lib/resume';
  import { normalizeKey } from '../lib/tournaments';
  import type { MatchRecord } from '../lib/history';
  import { subscribeConnectivity, getConnectivity } from '../lib/connectivity';
  import { enqueueLive, enqueueMatch, dropLive, flushQueue } from '../lib/sync-queue';

  type Side = { name: string; note: string; sets: number; points: number };
  /*
   * Colour tokens follow the player, not the seat. When players swap sides,
   * the colour swaps with the name so the same person keeps their pill/digit
   * colour throughout the match. Defaults match CSS vars --side-a / --side-b.
   */
  type Colour = 'a' | 'b';

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<Side>({ name: 'First Player', note: '', sets: 0, points: 0 });
  let sideB = $state<Side>({ name: 'Second Player', note: '', sets: 0, points: 0 });
  // Which colour token is painted on each seat. Flipped by swapSides().
  let colourA = $state<Colour>('a');
  let colourB = $state<Colour>('b');
  // 1-indexed: `board` is the currently-being-played board. Match
  // starts on board 1 (you're already playing when the score screen
  // mounts). boardLog.length = boards completed so far.
  /**
   * Boards *completed* in the current match. Starts at 0 — that's
   * how a paper scorecard reads before the first board has finished.
   * Increments when BOARD+1 fires (snapshot of the just-finished
   * board goes into boardLog with `board: board + 1` — i.e. 1-indexed
   * so rows in the archive match "Board 1", "Board 2", … as
   * players speak of them).
   *
   * Historical note: v2.0-beta shipped this as 1-indexed to match
   * DB shape, but tournament testers (Prem + Yash, 2026-08-08) said
   * that reads as "board 1 is already done"; changed back to 0 to
   * match paper convention while keeping the archived board numbers
   * 1-indexed via the +1 at snapshot time.
   */
  let board = $state(0);

  /*
   * BREAK indicator: which side breaks (assigned once at match start).
   *   - Match starts with currentBreak = 'a' (player A holds the toss
   *     by default). If B won the toss, the organiser taps the BREAK
   *     chip once and it hops over to B's side.
   *   - BOARD +/- and SET +/- do NOT change BREAK — it's a match-long
   *     display, not per-board.
   *   - Tapping the chip toggles between 'a' and 'b'. Never null — the
   *     chip always lives next to one of the two player pills.
   */
  let currentBreak = $state<SideId>('a');

  /*
   * QUEEN indicator: who currently holds the queen this board.
   *   null → queen is on the table (uncovered or not yet pocketed)
   *   'a'  → side A has covered the queen (3 pts already in POINTS)
   *   'b'  → side B has covered the queen (3 pts already in POINTS)
   * Tapping the chip cycles null → 'a' → 'b' → null. Every BOARD +1
   * auto-resets to null (new board starts with queen at centre).
   */
  let queenHolder = $state<SideId | null>(null);

  /*
   * BOARD LOG: per-board history built up as the match progresses.
   * Each entry is a snapshot captured when the umpire taps BOARD+1
   * (which is why the log length equals `board` at any given moment).
   *   {
   *     board:     N,           // 1-indexed board number that just ended
   *     breakSide: 'a' | 'b',   // who broke this board
   *     queen:     'a' | 'b',   // who held the queen at board end
   *     pointsA:   Δ points sideA scored on this board
   *     pointsB:   Δ points sideB scored on this board
   *     endedAt:   ms timestamp
   *   }
   * We track `pointsAtBoardStart` so we can compute per-board deltas
   * when the umpire's model uses cumulative points across a set.
   * BOARD-1 pops the last entry off (undo) and restores currentBreak.
   */
  type BoardEntry = {
    // The set this board belongs to. Zero-indexed across the match so
    // clients can group entries by set in a bo3+ recap. In a bo1 all
    // entries are `set: 0`.
    set: number;
    board: number;
    breakSide: SideId;
    queen: SideId;
    pointsA: number;
    pointsB: number;
    endedAt: number;
  };
  let boardLog = $state<BoardEntry[]>([]);
  let pointsAtBoardStart = $state<{ a: number; b: number }>({ a: 0, b: 0 });
  let queenRequiredToast = $state(false);
  /**
   * Fires when the umpire taps BOARD+1 after a side has already
   * reached pointsTarget in the current set. Added 2026-08-09
   * after Prem/Yash's test session recorded a phantom 9th board on
   * a bo1-to-20 match — they hit 20 on board 8 and a stray tap
   * opened row 9. Toast points the umpire at SET+1 or End.
   */
  let setDecidedToast = $state(false);
  /**
   * Fires when a positive-delta scoring input (POINTS+, BOARD+,
   * SET+, queen tap) is attempted after endMatch has locked the
   * match. Prevents accidental scoring on a decided record.
   * Negative deltas remain enabled so real mistakes can be undone.
   */
  let matchDecidedToast = $state(false);
  /**
   * Fires when SET+1 is tapped on the losing side (per-set points
   * lower than or equal to the opponent). Real-carrom rule: the
   * winning side credits the set. This prevents a common umpire
   * mis-tap that silently crowned the wrong player (bug reported
   * 2026-08-14: 8-10 A tapped SET+, End declared A winner).
   */
  let setLoserToast = $state(false);
  /**
   * Fires when SET+1 is tapped on a tied set (per-set points equal on
   * both sides). Unlike setLoserToast (points strictly lower), a tied
   * set has NO winner — the umpire needs to route through End Match,
   * which detects the tie-at-cap and opens the deciding-board chooser.
   * Copy tells them exactly that so they don't feel stuck.
   */
  let setTiedToast = $state(false);
  /**
   * Fires when a POINTS tap would push this side past the per-board
   * ICF cap of 12 points (maximum theoretical single-board score:
   * 9 pucks × 1 + queen 3 = 12). The umpire is probably meaning to
   * tap BOARD +1 to move to the next board. Auto-dismisses.
   */
  let boardCapToast = $state(false);
  /**
   * Fires when the umpire tries to score points on side B after
   * side A has already scored on the current board (or vice versa).
   * Real carrom: only ONE side scores per board — whoever pockets
   * the last coin (with the queen covered) claims that board's
   * points. If both sides seem to have scored, the umpire has
   * probably mistapped and needs to swipe-right on the other side
   * to correct. Auto-dismisses.
   */
  let singleScorerToast = $state(false);
  /**
   * Fires when the umpire taps Swap after any board has been
   * recorded in the current match. Real carrom seat-swaps happen
   * pre-scoring; swapping mid-match would corrupt the boardLog's
   * A/B attribution (see the swapSides guard added 2026-08-18).
   * Auto-dismisses.
   */
  let swapBlockedToast = $state(false);
  /**
   * Fires when SET+ is tapped after the OTHER side has already
   * reached the match-winning set count (⌈bestOf/2⌉). Blocking
   * this stops phantom sets after the match is mathematically
   * decided — see adjustSets's match-clinch guard added 2026-08-18.
   */
  let matchClinchedToast = $state(false);
  /**
   * Set to true when finishMatch() failed to reach Firebase (network
   * dead, rules denied). Surfaces as a small non-blocking toast so
   * the umpire knows the archive attempt failed rather than
   * silently thinking History captured it. Auto-dismisses.
   *
   * Added 2026-08-09 after Prem/Yash's testing found a match that
   * played to completion but never appeared in History — the write
   * had failed silently because the RTDB rules hadn't been
   * re-published yet.
   */
  let archiveFailedToast = $state(false);

  /*
   * Practice mode: solo drill. Player runs N sets × M boards and records
   * the number of MISSED shots per board (lower is better). No winner —
   * just a final matrix at End Match.
   *
   * `practiceBoards` is a bestOf × maxBoards matrix of missed-shot counts.
   * Rebuilt whenever cfg.bestOf or cfg.maxBoards changes (see the $effect
   * further down) so the grid tracks the URL config even after edits.
   */
  const isPractice = $derived(cfg.mode === 'practice');
  let practiceBoards = $state<number[][]>([]);
  // Currently-visible set in Practice mode. Paginated: one set on screen
  // at a time, "next" / "prev" buttons advance the view. Zero-indexed.
  let practiceSetIdx = $state(0);
  // On a phone we want at most 4 boards visible per set at readable digit
  // size. Extra boards scroll horizontally in the middle track (SET column
  // and TOTAL column stay pinned as flanks so the row's edges are always
  // legible). Pips derived from scroll position, tap to jump.
  const PRACTICE_BOARDS_VISIBLE = 4;
  let practiceBoardScroll = $state(0); // current scroll offset in cells (0-indexed)
  let practiceScrollerEl: HTMLDivElement | null = $state(null);
  const practiceBoardPageCount = $derived(
    Math.max(1, Math.ceil(cfg.maxBoards / PRACTICE_BOARDS_VISIBLE)),
  );
  function onPracticeScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement;
    const cellWidth = el.scrollWidth / cfg.maxBoards;
    if (cellWidth > 0) {
      practiceBoardScroll = Math.round(el.scrollLeft / cellWidth);
    }
  }
  function jumpToBoardPage(page: number) {
    const el = practiceScrollerEl;
    if (!el) return;
    const cellWidth = el.scrollWidth / cfg.maxBoards;
    el.scrollTo({ left: cellWidth * page * PRACTICE_BOARDS_VISIBLE, behavior: 'smooth' });
  }
  const practiceCurrentBoardPage = $derived(
    Math.min(practiceBoardPageCount - 1, Math.floor(practiceBoardScroll / PRACTICE_BOARDS_VISIBLE)),
  );
  let showPracticePopup = $state(false);

  const PRACTICE_BOARD_MAX = 99;

  function blankMatrix(rows: number, cols: number): number[][] {
    return Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  }

  /*
   * currentSet is derived from actual sets won, so manual SET +/- swipes
   * keep the caption in sync. It's simply (setsA + setsB + 1), capped at
   * bestOf. When the match is decided we stop advancing.
   */
  const currentSet = $derived(Math.min(cfg.bestOf, sideA.sets + sideB.sets + 1));
  let matchResult = $state<'a' | 'b' | 'draw' | null>(null);
  /**
   * True once the umpire chose "Play deciding board" from the at-
   * maxBoards tie popup. Drives:
   * - A small "Deciding board" banner above the scoreboard.
   * - The behaviour on the next End: same endMatch() flow runs, but
   *   the maxBoards limit has been raised by one so the extra board's
   *   score is retained in the boardLog and the winner/draw path
   *   proceeds normally.
   * Cleared on resetScores() so a Reset takes the match back to a
   * pre-decider state.
   */
  let isDecidingBoard = $state(false);
  /**
   * Snapshot of cfg.maxBoards at the moment a decider was chosen —
   * so when the deciding board completes AND the set transitions
   * (SET+1 for the winner), cfg.maxBoards can be restored to its
   * original per-set cap. Without this, cfg.maxBoards accumulates
   * `+1` for every set that entered a decider, and every subsequent
   * set inherits the extended cap (bug reported 2026-08-18:
   * "Set 2 had 3 boards allowed after Set 1's decider").
   * Null when no decider is active.
   */
  let maxBoardsBeforeDecider = $state<number | null>(null);
  /**
   * Signals the winner popup should render its "Play deciding board /
   * Call it a draw" chooser instead of the normal "View scorecard"
   * single-button path. True only during the brief window between
   * endMatch() detecting an at-limit tie and the umpire resolving it.
   */
  let pendingDrawChoice = $state(false);
  let confirmExit = $state(false);
  let isPortrait = $state(false);
  let storageKey = $state<string | null>(null);

  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    cfg = decodeConfig(q);
    sideA.name = teamLabel(cfg.playerA, cfg.playerA2, cfg.mode) || 'First Player';
    sideB.name = teamLabel(cfg.playerB, cfg.playerB2, cfg.mode) || 'Second Player';
    sideA.note = cfg.noteA;
    sideB.note = cfg.noteB;
    storageKey = matchStateKey(cfg.mode, q.get('playerA') ?? '', q.get('playerB') ?? '');
    // Populate the Player identity store from Firebase so endMatch()'s
    // finishMatch() call can resolve existing player IDs (rather than
    // forking identity on a page-refreshed-mid-match device).
    // Silent-on-failure inside the module.
    void subscribePlayers();
    // NOTE: armLiveCleanup was previously called here to register a
    // Firebase onDisconnect().remove() so the /live/{mid} record
    // vanished when the umpire's tab closed. In practice mobile
    // browsers drop WebSockets constantly — screen dim, brief WiFi
    // flicker, page-visibility toggle — and every drop caused the
    // record to disappear even though the umpire was still on the
    // match. Removed 2026-08-11 (v2.2.2). Zombie cleanup falls back
    // to the passive 4-hour sweep in AdminLiveCleanup + sweepStaleLive
    // that fires on every admin's /admin/ visit. Slightly longer
    // linger for records the umpire never explicitly ended, much more
    // resilient live broadcast.

    // Role subscription — so the end-recap can render a "Fix this
    // match" link for signed-in admins. The subscription lives for
    // the lifetime of the score screen; cleanup happens on
    // component unmount via the onMount return handler.
    unsubRole = subscribeCurrentUserRole((r) => (role = r));
    // Auth subscription — force initialisation of the auth cache so
    // finishMatch() can stamp `createdBy` when we End. Without this,
    // the score screen never subscribes anywhere else and
    // currentUser() stays null through the whole match, so the
    // archive record ships without ownership metadata (which then
    // prevents self-delete on the /live/ lobby). No local state
    // needed — subscribeAuth's side effect is what we're after.
    unsubAuth = subscribeAuth(() => { /* cache populated by side effect */ });

    // Connectivity watch — flushes the offline sync queue whenever
    // we transition to online. See armConnectivityWatch above.
    armConnectivityWatch();

    // currentBreak stays null until the organiser marks board 0's breaker;
    // hydrate below can restore a live value if we're resuming a match.

    // Seed the Practice matrix from cfg. Do this BEFORE hydrating so a
    // saved matrix can overwrite the blanks below.
    if (cfg.mode === 'practice') {
      practiceBoards = blankMatrix(cfg.bestOf, cfg.maxBoards);
    }

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s?.sideA?.points === 'number') sideA.points = s.sideA.points;
        if (typeof s?.sideB?.points === 'number') sideB.points = s.sideB.points;
        if (typeof s?.sideA?.sets === 'number') sideA.sets = s.sideA.sets;
        if (typeof s?.sideB?.sets === 'number') sideB.sets = s.sideB.sets;
        if (typeof s?.board === 'number') board = s.board;
        if (s?.currentBreak === 'a' || s?.currentBreak === 'b') currentBreak = s.currentBreak;
        if (s?.queenHolder === 'a' || s?.queenHolder === 'b' || s?.queenHolder === null) queenHolder = s.queenHolder;
        if (s?.matchResult === 'a' || s?.matchResult === 'b' || s?.matchResult === 'draw' || s?.matchResult === null) matchResult = s.matchResult;
        if (Array.isArray(s?.boardLog)) boardLog = s.boardLog as BoardEntry[];
        if (typeof s?.pointsAtBoardStart?.a === 'number' && typeof s?.pointsAtBoardStart?.b === 'number') {
          pointsAtBoardStart = s.pointsAtBoardStart;
        }
        // Practice: matrix is a 2D array of ints. Only accept it if the
        // shape matches the current cfg — otherwise a stale localStorage
        // entry from a differently-shaped match would leak in.
        if (
          cfg.mode === 'practice' &&
          Array.isArray(s?.practiceBoards) &&
          s.practiceBoards.length === cfg.bestOf &&
          s.practiceBoards.every((row: unknown) =>
            Array.isArray(row) && row.length === cfg.maxBoards && row.every((v) => typeof v === 'number'),
          )
        ) {
          practiceBoards = s.practiceBoards as number[][];
        }
      }
    } catch {
      // ignore
    }

    updateOrientation();
    requestWakeLock();

    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      releaseWakeLock();
      releaseLandscape();
      unsubRole?.();
      unsubAuth?.();
      unsubConnectivity?.();
      if (flushIntervalId !== null) {
        window.clearInterval(flushIntervalId);
        flushIntervalId = null;
      }
    };
  });

  /**
   * Screen Wake Lock. Keeps the phone screen from dimming/locking during a
   * match. Android drops the lock when the tab is backgrounded (incoming
   * call, app switch, screen off), so we re-request on visibilitychange
   * and on window focus. Crucially, the browser also fires a `release`
   * event on the sentinel when it drops the lock silently — we listen
   * for that and null out our reference so the next re-acquire attempt
   * actually runs (previously our `if (!wakeLock)` guard could skip the
   * re-request because the reference was stale-but-not-null).
   */
  type WakeLockSentinelLike = {
    release: () => Promise<void>;
    addEventListener?: (type: 'release', listener: () => void) => void;
  };
  let wakeLock: WakeLockSentinelLike | null = null;

  async function requestWakeLock() {
    if (wakeLock) return; // already held
    const wl = (navigator as unknown as { wakeLock?: { request: (type: string) => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    // Wake lock can only be requested while the document is visible;
    // Chrome rejects otherwise. Skip silently and wait for the next
    // visibility change to try again.
    if (document.visibilityState !== 'visible') return;
    try {
      const sentinel = await wl.request('screen');
      wakeLock = sentinel;
      // When Android/Chrome releases the lock in the background, clear our
      // reference so onVisibilityChange / onFocus can re-request cleanly.
      sentinel.addEventListener?.('release', () => {
        if (wakeLock === sentinel) wakeLock = null;
      });
    } catch {
      // Browser refused (not visible, not secure context, etc.)
    }
  }
  async function releaseWakeLock() {
    if (!wakeLock) return;
    const held = wakeLock;
    wakeLock = null;
    try {
      await held.release();
    } catch {
      // ignore
    }
  }
  // Track when the tab was last hidden so we can decide whether to
  // force-cycle Firebase's connection on return. On aggressive Android
  // OSes (MIUI notably), the socket to firebaseio.com gets suspended
  // silently during background, and the SDK's own retry timer can be
  // slow to notice — writes queue for seconds before landing. Cycling
  // via goOffline/goOnline recovers immediately. See
  // `nudgeFirebaseReconnect` for detail.
  let hiddenSince: number | null = null;
  const HIDDEN_NUDGE_THRESHOLD_MS = 2000;
  function onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      hiddenSince = Date.now();
      return;
    }
    if (document.visibilityState === 'visible') {
      if (!wakeLock) requestWakeLock();
      if (!document.fullscreenElement) landscapeLocked = false;
      // Only nudge if we've been hidden long enough that the OS
      // could have suspended background sockets. Quick focus-blur
      // flickers (Chrome popup, notification banner) skip this.
      if (
        cfg.live &&
        cfg.mid &&
        hiddenSince !== null &&
        Date.now() - hiddenSince > HIDDEN_NUDGE_THRESHOLD_MS
      ) {
        void nudgeFirebaseReconnect();
      }
      hiddenSince = null;
    }
  }
  // Belt-and-braces backup for Android WebView / Chrome edge cases where
  // `visibilitychange` doesn't refire on unlock (some devices only send
  // `focus`). Cheap to try — requestWakeLock is a no-op if already held.
  function onFocus() {
    if (document.visibilityState === 'visible' && !wakeLock) requestWakeLock();
  }
  function onFullscreenChange() {
    if (!document.fullscreenElement && landscapeLocked) {
      landscapeLocked = false;
    }
  }

  $effect(() => {
    if (!storageKey) return;
    const s: Record<string, unknown> = {
      sideA: { points: sideA.points, sets: sideA.sets },
      sideB: { points: sideB.points, sets: sideB.sets },
      board,
      currentBreak,
      queenHolder,
      matchResult,
      boardLog,
      pointsAtBoardStart,
    };
    if (isPractice) s.practiceBoards = practiceBoards;
    try {
      localStorage.setItem(storageKey, JSON.stringify(s));
    } catch {
      // ignore
    }
    // Live broadcast: when the umpire toggled Live at Setup, mirror
    // the same payload to Firebase /live/{mid}. Spectator devices
    // subscribed to that slug receive the update ~500 ms later.
    // Silent-on-failure via publishLive.
    //
    // Offline path (v3.0): when connectivity says we can't reach
    // Firebase, hand the payload to the sync queue instead. The
    // queue coalesces per-mid so a burst of taps produces one
    // queued write, and it flushes when connectivity returns.
    if (cfg.live && cfg.mid) {
      // Practice: sideA.points isn't updated by adjustPracticeBoard —
      // the real data lives in practiceBoards[]. To keep spectator +
      // OBS-overlay views showing a running "SCORE" digit that reflects
      // what the umpire has entered, publish the grand total of missed
      // shots (sum across all sets + boards) as sideA.points.
      const publishedPointsA = isPractice
        ? practiceBoards.reduce(
            (sum, row) => sum + row.reduce((r, v) => r + (v ?? 0), 0),
            0,
          )
        : sideA.points;
      const payload: LivePayload = {
        sideA: { points: publishedPointsA, sets: sideA.sets },
        sideB: { points: sideB.points, sets: sideB.sets },
        board,
        currentBreak,
        queenHolder,
        matchResult,
        ...(!isPractice && boardLog.length > 0 ? { boardLog } : {}),
        ...(isPractice ? { practiceBoards } : {}),
      };
      // tournamentKey rides alongside tournament so the RTDB
      // /live/{mid} delete rule can look up organiser privileges
      // via /tournaments/{tournamentKey}/organisers/{auth.uid} —
      // same pattern used by /matches/{id}.
      const tournamentKey = normalizeKey(cfg.tournament ?? '');
      const meta = {
        mode: cfg.mode,
        playerA: cfg.playerA,
        playerA2: cfg.playerA2,
        playerB: cfg.playerB,
        playerB2: cfg.playerB2,
        noteA: cfg.noteA,
        noteB: cfg.noteB,
        bestOf: cfg.bestOf,
        pointsTarget: cfg.pointsTarget,
        maxBoards: cfg.maxBoards,
        tournament: cfg.tournament,
        ...(tournamentKey ? { tournamentKey } : {}),
      };
      if (getConnectivity().online) {
        void publishLive(cfg.mid, meta, payload);
      } else {
        // Offline: keep the state in the queue so it flushes when
        // we reconnect. Coalesced by mid, so this is O(1) storage
        // regardless of tap volume.
        enqueueLive({ mid: cfg.mid, meta, payload });
      }
    }
  });

  /*
   * Connectivity subscription. Two jobs:
   *   1. Whenever we transition to online, flush the sync queue so
   *      any buffered live/match writes reach Firebase promptly.
   *   2. Also fire a periodic 30 s flush while online, as a safety
   *      net for the case where the online transition somehow
   *      missed (e.g. laptop lid open with WiFi already up).
   *
   * Both triggers call flushQueue, which is idempotent + retry-safe
   * per the module contract.
   */
  let unsubConnectivity: (() => void) | null = null;
  let flushIntervalId: number | null = null;
  let prevOnline: boolean | null = null;
  function armConnectivityWatch() {
    unsubConnectivity = subscribeConnectivity((state) => {
      // First fire seeds prevOnline; only true transitions trigger
      // a flush after that.
      if (prevOnline === null) {
        prevOnline = state.online;
        if (state.online) void flushQueue();
        return;
      }
      if (!prevOnline && state.online) {
        // offline → online: flush ASAP
        void flushQueue();
      }
      prevOnline = state.online;
    });
    flushIntervalId = window.setInterval(() => {
      if (getConnectivity().online) void flushQueue();
    }, 30_000);
  }

  function updateOrientation() {
    isPortrait = window.innerHeight > window.innerWidth;
  }

  let landscapeLocked = false;
  async function tryLockLandscape() {
    if (landscapeLocked) return;
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) {
      try {
        await el.requestFullscreen();
      } catch {
        return;
      }
    }
    const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
    if (!so?.lock) {
      landscapeLocked = true;
      return;
    }
    try {
      await so.lock('landscape');
      landscapeLocked = true;
    } catch {
      // silent
    }
  }

  async function releaseLandscape() {
    landscapeLocked = false;
    const so = (screen as unknown as {
      orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void };
    }).orientation;
    if (so?.lock) {
      try { await so.lock('portrait'); } catch { /* silent */ }
    }
    if (document.fullscreenElement && document.exitFullscreen) {
      try { await document.exitFullscreen(); } catch { /* silent */ }
    }
  }

  /*
   * BOARD cap. Normally cap at maxBoards (default 8). At the cap, if points
   * are tied, allow one extra decider board (board 9 in the standard case).
   * When maxBoards === 0 the format is boards-unlimited (EuroCup doubles);
   * cap is effectively Number.MAX_SAFE_INTEGER.
   */
  const boardCap = $derived(() => {
    if (isBoardsUnlimited(cfg)) return Number.MAX_SAFE_INTEGER;
    const base = cfg.maxBoards;
    // At the cap, if points are tied, permit one decider board on top.
    if (board >= base && sideA.points === sideB.points) return base + 1;
    return base;
  });

  /**
   * True once the match is fully decided — endMatch() has run,
   * matchResult is set. All positive-delta scoring inputs freeze in
   * this state to prevent stray taps from adding phantom scoring to
   * a match that's over. BOARD-1 / SET- / POINTS- (negative deltas)
   * remain enabled so mistakes can still be undone. See
   * matchDecidedToast for the user-facing feedback.
   */
  function isMatchDecided(): boolean {
    return matchResult !== null;
  }

  /** Max points a single board can score in ICF-rules carrom:
   *  9 opponent-side pucks × 1 point + queen coverage 3 = 12. */
  const BOARD_POINT_CAP = 12;

  function adjustPoints(side: 'a' | 'b', delta: number) {
    void tryLockLandscape();
    // Post-endMatch lockout: don't accept positive deltas. Negatives
    // are still allowed as an undo — an umpire realising a stray tap
    // after End can back out without a full reset.
    if (isMatchDecided() && delta > 0) {
      matchDecidedToast = true;
      window.setTimeout(() => { matchDecidedToast = false; }, 2500);
      return;
    }
    const s = side === 'a' ? sideA : sideB;
    // Rule 4 (single-scorer-per-board): if the OTHER side has already
    // scored on this board, block the tap. Real carrom: only one side
    // pockets pucks on any given board — the umpire has probably
    // mistapped. To correct, they need to swipe-right on the other
    // side first. Negatives (undo) always allowed.
    if (delta > 0) {
      const startA = pointsAtBoardStart.a;
      const startB = pointsAtBoardStart.b;
      const otherScored = side === 'a'
        ? sideB.points > startB
        : sideA.points > startA;
      if (otherScored) {
        singleScorerToast = true;
        window.setTimeout(() => { singleScorerToast = false; }, 2500);
        return;
      }
      // Rule 1 (per-board cap 12): block a tap that would push this
      // side's per-board delta past 12. Negatives never trip it.
      const perBoard = s.points - (side === 'a' ? startA : startB);
      if (perBoard + delta > BOARD_POINT_CAP) {
        boardCapToast = true;
        window.setTimeout(() => { boardCapToast = false; }, 2500);
        return;
      }
    }
    s.points = Math.min(cfg.pointsTarget, Math.max(0, s.points + delta));
  }
  function adjustSets(side: 'a' | 'b', delta: number) {
    void tryLockLandscape();
    // Post-endMatch lockout on positive deltas. SET-1 still works
    // as an undo path (mirrors adjustBoard / adjustPoints).
    if (isMatchDecided() && delta > 0) {
      matchDecidedToast = true;
      window.setTimeout(() => { matchDecidedToast = false; }, 2500);
      return;
    }
    // Match-clinch guard: refuse SET+X when the OTHER side has
    // already reached ⌈bestOf/2⌉ sets. In bo3 that's 2 — a 0-2 or
    // 2-0 score means the match is mathematically decided; the
    // umpire should tap End rather than keep playing. Without this,
    // a phantom set can be played and its SET+ credit accepted
    // (bug reported 2026-08-17, mid=ais81o).
    // Applies to versus modes only.
    if (delta > 0 && !isPractice) {
      const winThreshold = Math.ceil(cfg.bestOf / 2);
      const otherSideSets = side === 'a' ? sideB.sets : sideA.sets;
      if (otherSideSets >= winThreshold) {
        matchClinchedToast = true;
        window.setTimeout(() => { matchClinchedToast = false; }, 3000);
        return;
      }
    }
    // Real-carrom rule: SET+1 can only credit the side that WON the
    // set (more per-set points). Tapping SET+ on the losing side
    // used to silently credit them anyway (bug reported 2026-08-14:
    // 8-10 A tapped, End declared A winner). Also reject on a tied
    // per-set score — the umpire needs to either score one more
    // point or use the End-then-decider flow to break the tie.
    // Applies to versus modes only, and only on delta > 0 (SET-1
    // undoes freely as always). Runs BEFORE the running-board
    // snapshot at ~L579 so a rejected SET+ doesn't append a phantom
    // row / mutate pointsAtBoardStart.
    if (delta > 0 && !isPractice) {
      const tappedPts = side === 'a' ? sideA.points : sideB.points;
      const otherPts = side === 'a' ? sideB.points : sideA.points;
      if (tappedPts === otherPts) {
        // Tied set — neither side has won. Point the umpire at End
        // Match; endMatch() will pop the deciding-board chooser when
        // the set is at cap, and let them commit as a draw otherwise.
        setTiedToast = true;
        window.setTimeout(() => { setTiedToast = false; }, 3500);
        return;
      }
      if (tappedPts < otherPts) {
        setLoserToast = true;
        window.setTimeout(() => { setLoserToast = false; }, 3000);
        return;
      }
    }
    // Before the SET+ handler could reset points/board/queen for the
    // new set, we need to snapshot the running (in-progress) board so
    // it lands in the boardLog — otherwise the last board of every
    // set gets silently dropped from the recap. Same rule as
    // endMatch(): if the current board has scoring, require a queen
    // holder before advancing.
    if (delta > 0 && !isPractice) {
      const currentBoardHasScore =
        sideA.points > pointsAtBoardStart.a || sideB.points > pointsAtBoardStart.b;
      // Board-cap safeguard mirrors endMatch(): once the umpire has
      // hit cfg.maxBoards worth of boards, refuse to open a phantom
      // Nth+1 row from stray points. Without this, tapping SET+ at
      // the cap with any running-board delta appended an extra board
      // AND — because we didn't update pointsAtBoardStart afterwards —
      // repeated SET+ taps kept re-firing the snapshot forever
      // (bug reported 2026-08-14). Silently roll the stray points
      // back to the last committed baseline; SET+ then proceeds to
      // credit the set without touching the archive.
      const atBoardCap =
        !isBoardsUnlimited(cfg) && board >= cfg.maxBoards && !isDecidingBoard;
      if (currentBoardHasScore && atBoardCap) {
        sideA.points = pointsAtBoardStart.a;
        sideB.points = pointsAtBoardStart.b;
      } else if (currentBoardHasScore) {
        if (queenHolder === null) {
          // Block SET+1 with the same toast BOARD+1 uses. Real carrom:
          // no board can end without a queen result.
          queenRequiredToast = true;
          window.setTimeout(() => { queenRequiredToast = false; }, 2500);
          return;
        }
        const entry: BoardEntry = {
          set: sideA.sets + sideB.sets,
          // Snapshot rows are 1-indexed (see comment on `board` state).
          board: board + 1,
          breakSide: currentBreak,
          queen: queenHolder,
          pointsA: sideA.points - pointsAtBoardStart.a,
          pointsB: sideB.points - pointsAtBoardStart.b,
          endedAt: Date.now(),
        };
        boardLog = [...boardLog, entry];
        // Advance `board` to reflect the just-captured entry so the
        // count stored on match archive matches boardLog.length —
        // the same reason endMatch() advances after its own snapshot.
        board = board + 1;
        // Re-baseline pointsAtBoardStart to the just-snapshotted
        // totals. Without this, a subsequent SET+ tap sees the
        // same points-still-ahead-of-baseline signal and captures
        // another phantom row, indefinitely.
        pointsAtBoardStart = { a: sideA.points, b: sideB.points };
      }
    }

    const s = side === 'a' ? sideA : sideB;
    const prev = s.sets;
    s.sets = Math.min(cfg.bestOf, Math.max(0, s.sets + delta));
    if (s.sets === prev) return;

    // A SET change either transitions into a NEW set (which needs
    // fresh points + board + queen), or credits the FINAL set of the
    // match (nothing more to play, no reset needed). Distinguish by
    // whether another set remains after this one.
    //
    // "Another set exists" iff the total sets played so far is still
    // below cfg.bestOf. In a bo1 (or any match's decider), SET+1
    // credits the last set and preserves the points that decided it,
    // so End can render "wins 25-18" honestly instead of "0-0".
    const totalPlayed = sideA.sets + sideB.sets;
    // Skip the fresh-set setup when THIS SET+1 clinches the match.
    // The final-set points/board need to persist so the winner
    // popup can render "Final board X–Y" honestly. The auto-clinch
    // block below then declares the match. Practice mode has no
    // clinch, so this reduces to the original condition.
    const clinchWinThreshold = Math.ceil(cfg.bestOf / 2);
    const willClinch = !isPractice && delta > 0 && s.sets >= clinchWinThreshold;
    const anotherSetRemains = delta > 0 && totalPlayed < cfg.bestOf && !willClinch;
    if (anotherSetRemains) {
      sideA.points = 0;
      sideB.points = 0;
      // Board counter resets to 0 (no board completed yet in the new
      // set). boardLog persists across sets — each entry carries `set`
      // so consumers can group.
      board = 0;
      queenHolder = null;
      pointsAtBoardStart = { a: 0, b: 0 };
      // Roll back any decider extension from the just-completed set.
      // isDecidingBoard is per-set state (the banner should not carry
      // into a new set), and cfg.maxBoards was bumped +1 for the
      // decider board — restore it so the new set gets the original
      // per-set cap. Both no-ops when the just-completed set wasn't
      // a decider.
      isDecidingBoard = false;
      if (maxBoardsBeforeDecider !== null) {
        cfg.maxBoards = maxBoardsBeforeDecider;
        maxBoardsBeforeDecider = null;
      }
      // First-break rotates every set: the player who did NOT open
      // the previous set opens the next one. Find the previous set's
      // first-board breaker from the log and flip it. If the log is
      // empty (edge case: SET+1 tapped before any board completed)
      // keep currentBreak as-is.
      const prevSetIdx = sideA.sets + sideB.sets - 1; // set that just ended, 0-indexed
      const prevSetOpener = boardLog.find((e) => e.set === prevSetIdx)?.breakSide;
      if (prevSetOpener) {
        currentBreak = prevSetOpener === 'a' ? 'b' : 'a';
      }
    }
    // Auto-clinch: if this SET+1 credit takes the side to the
    // match-winning threshold (⌈bestOf/2⌉), the match is over —
    // don't make the umpire hunt for End Match. Set matchResult,
    // pop the winner ribbon, and archive. Fires only on positive
    // delta so SET-1 undos never trigger the popup. Skipped in
    // practice mode (no winner concept). Guarded on matchResult
    // being null so an already-decided match doesn't re-fire.
    if (delta > 0 && !isPractice && matchResult === null) {
      const winThreshold = Math.ceil(cfg.bestOf / 2);
      if (s.sets >= winThreshold) {
        matchResult = side;
        showWinnerPopup = true;
        recordFinishedMatch(side);
        clearResume();
        return;
      }
    }
    // matchResult stays untouched: the WINNER ribbon only appears when the
    // organiser taps End Match, never on a SET +/- alone (except the
    // auto-clinch case above).
  }
  function adjustBoard(delta: number) {
    void tryLockLandscape();
    // Post-endMatch lockout on positive deltas. BOARD-1 still works
    // so an accidental BOARD+1 during a decided match can be popped
    // (adjustBoard's own delta<0 branch handles the boardLog pop).
    if (isMatchDecided() && delta > 0) {
      matchDecidedToast = true;
      window.setTimeout(() => { matchDecidedToast = false; }, 2500);
      return;
    }
    const next = board + delta;
    if (next < 0) return;
    if (next > boardCap()) return;

    // Practice mode doesn't have a queen/break/log concept — just
    // increment the counter and clear stale queen state.
    if (isPractice) {
      board = next;
      queenHolder = null;
      return;
    }

    if (delta > 0) {
      // BOARD+1: the just-completed board must have a queen holder.
      // ICF rule: every board ends with the queen either pocketed +
      // covered by one side, or awarded to opponent if the other side
      // cleared without pocketing it. There is no "no queen" outcome.

      // Set already has a winner (a side reached pointsTarget). BOARD+1
      // would start a phantom extra board that will land in the recap
      // as an unwanted extra row — this is what happened with
      // Prem/Yash 08-09 test: they hit 20 on board 8, then a stray
      // BOARD+1 tap opened a phantom board 9. Block with a toast so
      // the umpire taps SET+1 (or End) instead.
      const setDecided =
        sideA.points >= cfg.pointsTarget || sideB.points >= cfg.pointsTarget;
      if (setDecided) {
        setDecidedToast = true;
        window.setTimeout(() => { setDecidedToast = false; }, 3000);
        return;
      }

      if (queenHolder === null) {
        queenRequiredToast = true;
        window.setTimeout(() => { queenRequiredToast = false; }, 2500);
        return;
      }
      // Snapshot the completed board. `set` is 0-indexed for the
      // current set within the match.
      const entry: BoardEntry = {
        set: sideA.sets + sideB.sets,
        // `board` state = completed-board count (0 at fresh start).
        // Snapshot rows are 1-indexed for archival correctness —
        // "Board 1" is the first row a paper scorecard writes.
        board: board + 1,
        breakSide: currentBreak,
        queen: queenHolder,
        pointsA: sideA.points - pointsAtBoardStart.a,
        pointsB: sideB.points - pointsAtBoardStart.b,
        endedAt: Date.now(),
      };
      boardLog = [...boardLog, entry];
      // Fresh board: flip break (real carrom rules), clear queen, and
      // capture the current cumulative points as the next board's
      // starting basis so pointsA/pointsB deltas stay correct.
      board = next;
      currentBreak = currentBreak === 'a' ? 'b' : 'a';
      queenHolder = null;
      pointsAtBoardStart = { a: sideA.points, b: sideB.points };
      return;
    }

    if (delta < 0) {
      // BOARD-1: pop the last snapshot, restore its break + reset
      // queen (the previous board is back "in progress"). We don't
      // touch points — they're cumulative and correct wherever the
      // scoreboard is at.
      board = next;
      if (boardLog.length > 0) {
        const popped = boardLog[boardLog.length - 1];
        boardLog = boardLog.slice(0, -1);
        currentBreak = popped.breakSide;
        pointsAtBoardStart = {
          a: sideA.points - popped.pointsA,
          b: sideB.points - popped.pointsB,
        };
      }
      queenHolder = null;
    }
  }

  /*
   * BREAK chip is only user-toggleable before the first board is
   * played — that's the umpire's window to set who won the toss.
   * Once scoring has begun, the break flips automatically:
   *   - adjustBoard(+1) at ~L759 flips it every completed board
   *   - adjustSets(+1) at ~L687 flips it at set boundaries
   * A stray tap after that could put the archived record out of
   * sync with reality, so we ignore taps and dim the chip.
   */
  const breakToggleAllowed = $derived(
    !isPractice
    && board === 0
    && boardLog.length === 0
    && sideA.sets === 0
    && sideB.sets === 0
    && sideA.points === 0
    && sideB.points === 0
    && matchResult === null,
  );
  function cycleBreak() {
    if (!breakToggleAllowed) return;
    currentBreak = currentBreak === 'a' ? 'b' : 'a';
  }
  function cycleQueen() {
    if (queenHolder === null) queenHolder = 'a';
    else if (queenHolder === 'a') queenHolder = 'b';
    else queenHolder = null;
  }
  /*
   * tapCoin: one-shot handler per side's carrom-coin button.
   *   - If nobody has the queen (null), tapping either side's coin gives
   *     the queen to that side (coin turns red).
   *   - If the tapped side already has the queen, tapping again returns
   *     the queen to the table (both coins go grey).
   *   - If the OTHER side has the queen, tapping this side transfers
   *     ownership (this coin turns red, the other returns to grey).
   */
  function tapCoin(side: SideId) {
    // Match already decided — freeze queen marking. This prevents a
    // stray coin tap after End from repainting the recap. The lock
    // applies to both new-queen assignment and transfer; return-to-
    // table (untick) is treated the same — after End the record is
    // canonical and shouldn't shift under an accidental tap.
    if (isMatchDecided()) {
      matchDecidedToast = true;
      window.setTimeout(() => { matchDecidedToast = false; }, 2500);
      return;
    }
    if (queenHolder === side) {
      queenHolder = null;
    } else {
      queenHolder = side;
    }
  }

  function adjustPracticeBoard(setIdx: number, boardIdx: number, delta: number) {
    void tryLockLandscape();
    const row = practiceBoards[setIdx];
    if (!row) return;
    const cur = row[boardIdx] ?? 0;
    const next = Math.min(PRACTICE_BOARD_MAX, Math.max(0, cur + delta));
    // Reassign the whole row so Svelte's fine-grained reactivity picks up
    // the cell change even though we're mutating a nested array.
    const nextRow = row.slice();
    nextRow[boardIdx] = next;
    practiceBoards[setIdx] = nextRow;
  }

  function practiceSetTotal(setIdx: number): number {
    const row = practiceBoards[setIdx];
    return row ? row.reduce((a, b) => a + b, 0) : 0;
  }
  function practiceGrandTotal(): number {
    return practiceBoards.reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0);
  }

  /*
   * End Match: organiser-triggered finalisation. The ONLY thing that sets
   * matchResult — no auto-detect on set count. That way SET +/- swipes in
   * the middle of a match never flash the WINNER ribbon.
   * Precedence for picking the winner: more SETs wins; if tied, more POINTS
   * wins; if still tied, no winner (organiser resolves via manual bump).
   */
  let showWinnerPopup = $state(false);
  /**
   * Opens after the Champion popup's "View scorecard" button. Renders
   * the full board-by-board recap (same LiveScoreboardView the /live/
   * lobby uses for History cards) in a modal with a top-right close
   * button and outside-click-to-dismiss.
   */
  let showScorecardPopup = $state(false);
  /**
   * Set once finishMatch resolves to a Firebase match id. Enables the
   * "Fix this match" link on the end-recap for signed-in admins —
   * before this is set, the record doesn't yet exist in /matches, so
   * editing has nothing to write to. Cleared on Reset / Close.
   */
  let archivedMatchId = $state<string | null>(null);
  /** True while the admin edit modal is open on the just-ended match. */
  let showEditModal = $state(false);
  /** Current user's role; drives visibility of the "Fix this match" link. */
  let role = $state<Role | null>(null);
  let unsubRole: (() => void) | null = null;
  let unsubAuth: (() => void) | null = null;

  /**
   * Synthesise a MatchRecord snapshot for the edit modal from the
   * current match state, keyed on the archived match id. Called at
   * modal-open time; not reactive — the modal owns its own edit
   * buffer from that point on.
   */
  function buildMatchRecordForEdit(): MatchRecord | null {
    if (!archivedMatchId) return null;
    return {
      id: archivedMatchId,
      mode: cfg.mode,
      notes: { a: sideA.note, b: sideB.note },
      cfg: {
        bestOf: cfg.bestOf,
        maxBoards: cfg.maxBoards,
        pointsTarget: cfg.pointsTarget,
        format: cfg.format,
      },
      result: {
        winner: matchResult,
        finalPointsA: sideA.points,
        finalPointsB: sideB.points,
        setsA: sideA.sets,
        setsB: sideB.sets,
        boardCount: board,
      },
      ...(boardLog.length > 0
        ? {
            boardLog: boardLog.map((e) => ({
              set: e.set,
              board: e.board,
              breakSide: e.breakSide,
              queen: e.queen,
              pointsA: e.pointsA,
              pointsB: e.pointsB,
              endedAt: e.endedAt,
            })),
          }
        : {}),
      ...(cfg.tournament ? { tournament: cfg.tournament } : {}),
    };
  }

  /** True when the current user can edit the just-archived match. */
  const canEditArchived = $derived(() => {
    if (!archivedMatchId || !role) return false;
    if (role.isSuper) return true;
    const key = normalizeKey(cfg.tournament ?? '');
    if (!key) return false;
    return role.organiserOf.has(key);
  });
  // Fixed array of spark indices for the fireworks each-loop.
  const SPARK_INDICES = Array.from({ length: 20 }, (_, i) => i);
  function endMatch() {
    // Practice: no winner concept. Surface the recap matrix + archive
    // to /matches. Explicitly delete the /live/{mid} record so the
    // lobby stops showing this run under "Now Playing" — versus
    // matches move out via the matchResult filter, but practice has
    // no matchResult to set, so we clear the broadcast slot directly.
    if (isPractice) {
      showPracticePopup = true;
      recordFinishedMatch(null);
      if (cfg.live && cfg.mid) void deleteLive(cfg.mid);
      clearResume();
      return;
    }
    // Capture the current in-progress board if it has any points +
    // a queen holder. This handles the common flow where the umpire
    // taps End after the last board without hitting BOARD+1 first.
    const currentBoardHasScore =
      sideA.points > pointsAtBoardStart.a || sideB.points > pointsAtBoardStart.b;
    if (currentBoardHasScore) {
      // Board-cap safeguard. If the umpire has already completed
      // cfg.maxBoards boards (and this isn't the decider extension),
      // do NOT append a phantom row past the cap. Any leftover
      // per-set points on the running board are discarded — the
      // umpire tapped End, which means they want to finalise. The
      // winner-decision block below will still credit the leading
      // side an extra set via `awardExtraSet`, so the final result
      // reads honestly ("wins 1-0" for the sideA-in-front case).
      // This was the reported bug (2026-08-13, match
      // -OzuEZ0ec3ZoVZ9iw4Q3): a stray queen delta after board 8
      // was appended as a phantom board 9 because End used to
      // bypass boardCap's ceiling.
      const atBoardCap =
        !isBoardsUnlimited(cfg) && board >= cfg.maxBoards && !isDecidingBoard;
      if (atBoardCap) {
        // Roll the running board's points back to the last saved
        // baseline so the winner comparison sees only the
        // completed-board totals, and skip the append.
        sideA.points = pointsAtBoardStart.a;
        sideB.points = pointsAtBoardStart.b;
      } else {
      if (queenHolder === null) {
        // Real carrom: no board can end without a queen. Block End
        // with the same toast that adjustBoard(+1) uses.
        queenRequiredToast = true;
        window.setTimeout(() => { queenRequiredToast = false; }, 2500);
        return;
      }
      const entry: BoardEntry = {
        set: sideA.sets + sideB.sets,
        // `board` state = completed-board count (0 at fresh start).
        // Snapshot rows are 1-indexed for archival correctness —
        // "Board 1" is the first row a paper scorecard writes.
        board: board + 1,
        breakSide: currentBreak,
        queen: queenHolder,
        pointsA: sideA.points - pointsAtBoardStart.a,
        pointsB: sideB.points - pointsAtBoardStart.b,
        endedAt: Date.now(),
      };
      boardLog = [...boardLog, entry];
      // Advance `board` to include this just-captured entry, so the
      // `boardCount` we send to finishMatch matches boardLog.length.
      // Without this, the archive record undercounts by 1 whenever
      // End auto-captured a running board, and the recap trim on
      // the History side would then drop that same entry.
      board = board + 1;
      }
    }
    let winner: 'a' | 'b' | 'draw' | null = null;
    let awardExtraSet = false;
    // Match-clinch check first: has one side reached ⌈bestOf/2⌉ sets
    // BEFORE this End was tapped? If so, the match is genuinely over
    // and the set-lead is the match winner. In bo3 that's 2 sets.
    // Without this gate, End on a tied set 2 (sets 0-1) would declare
    // the 1-set-leader as match winner and skip the decider prompt
    // (bug reported 2026-08-18: Set 2 tied 6-6 at cap, End declared
    // "wins 0-1" instead of asking for a deciding board).
    const winThreshold = Math.ceil(cfg.bestOf / 2);
    const clinched = sideA.sets >= winThreshold || sideB.sets >= winThreshold;
    if (clinched && sideA.sets > sideB.sets) {
      winner = 'a';
    } else if (clinched && sideB.sets > sideA.sets) {
      winner = 'b';
    } else if (sideA.points === sideB.points && board >= cfg.maxBoards && !isDecidingBoard) {
      // At-cap tied current set (below the clinch line) — offer the
      // deciding-board prompt. This branch fires regardless of the
      // set-lead: whether sets are 0-0 (set 1), 0-1 (set 2), 1-1
      // (set 3), the current set is tied at its natural end and
      // deserves resolution before the match can be called.
      matchResult = 'draw';
      pendingDrawChoice = true;
      showWinnerPopup = true;
      return;
    } else if (sideA.sets > sideB.sets) {
      // Set-lead but not clinched, and current set isn't tied-at-cap.
      // Umpire ended early (e.g. below points/board cap). Award to
      // the current set-leader.
      winner = 'a';
    } else if (sideB.sets > sideA.sets) {
      winner = 'b';
    } else if (sideA.points > sideB.points) {
      // Sets tied — winner decided by current-set POINTS. The winning side
      // also gets credited with that decider set so the footer reads
      // e.g. "wins 2-1" rather than a misleading "wins 1-1".
      winner = 'a';
      awardExtraSet = true;
    } else if (sideB.points > sideA.points) {
      winner = 'b';
      awardExtraSet = true;
    } else {
      // Fully tied — sets AND points equal, but below cap (the at-cap
      // path was handled above). Auto-commit as draw: umpire chose
      // to End early on an equal position.
      //
      // Consistent rule: **SETS only ticks up when a side wins the
      // set**. A tied set has no winner, so neither sideA.sets nor
      // sideB.sets moves.
      winner = 'draw';
    }
    if (awardExtraSet && (winner === 'a' || winner === 'b')) {
      const s = winner === 'a' ? sideA : sideB;
      s.sets = Math.min(cfg.bestOf, s.sets + 1);
    }
    matchResult = winner;
    showWinnerPopup = true;
    recordFinishedMatch(winner);
    clearResume();
  }

  /**
   * Umpire's response to the "at-maxBoards tie" chooser in the winner
   * popup. Only fires when matchResult is 'draw' AND the tie hit the
   * board limit — set at line 911 above (which returns before writing
   * the archive record).
   *
   * `choice === 'draw'`: commit the provisional draw as-is. Award +1
   * set to both sides so SETS reads honestly, then archive.
   *
   * `choice === 'decider'`: un-end. Clear matchResult, extend
   * cfg.maxBoards by 1 (session-only — not persisted; this state was
   * hydrated from URL params at mount and lives in the component),
   * raise the isDecidingBoard flag so the banner renders, and dismiss
   * the popup. Scoring inputs come back to life via isMatchDecided()
   * flipping to false.
   */
  function handleDrawChoice(choice: 'draw' | 'decider') {
    pendingDrawChoice = false;
    if (choice === 'draw') {
      // Draws don't credit sets — a tied set has no winner, so
      // sideA.sets and sideB.sets both stay put. Consistent with the
      // below-limit auto-draw path in endMatch() (same rule applies
      // everywhere: SETS only ticks up when someone wins the set).
      // Keep popup open — user can now tap "View scorecard" like any
      // finished match. Committing the archive fires-and-forgets.
      recordFinishedMatch('draw');
      clearResume();
    } else {
      // Play deciding board. Three things happen here:
      //
      // 1. Match un-ends. matchResult back to null, popup closes,
      //    scoring inputs re-enable via isMatchDecided() flipping.
      //
      // 2. cfg.maxBoards raised by 1 for THIS session only (not
      //    persisted). The extra board is played over-and-above
      //    what was configured at setup.
      //
      // 3. Fresh-board state reset for the decider itself. Endless
      //    matched to the standard BOARD+1 path (adjustBoard's
      //    delta>0 branch): the tied final board was already
      //    snapshotted into boardLog by endMatch() above, so
      //    starting the decider means:
      //      - flip break (rotates on every board in real carrom)
      //      - clear queen (per-board state, new board = new queen)
      //      - re-baseline pointsAtBoardStart to current cumulative
      //        POINTS so the decider's scoring deltas are correct.
      //    Without this, the umpire's decider taps would be
      //    computed against the pre-tied-board baseline and produce
      //    wrong per-board deltas in the boardLog.
      matchResult = null;
      // Save the pre-extension cap so the SET+ transition below can
      // restore it. Without this, cfg.maxBoards permanently grows +1
      // per set-that-hit-a-decider, and every subsequent set gets
      // the extended cap (Set 2 allowed 3 boards after Set 1's decider).
      if (maxBoardsBeforeDecider === null) {
        maxBoardsBeforeDecider = cfg.maxBoards;
      }
      cfg.maxBoards = cfg.maxBoards + 1;
      isDecidingBoard = true;
      currentBreak = currentBreak === 'a' ? 'b' : 'a';
      queenHolder = null;
      pointsAtBoardStart = { a: sideA.points, b: sideB.points };
      showWinnerPopup = false;
    }
  }

  /**
   * Fire-and-forget write of the finished match to Firebase. Uses the
   * identity handoff (playerId resolutions saved at Setup time) so the
   * matches/{id} record refers to Player identities, not name strings.
   * Failures are absorbed silently: the user still sees the winner
   * popup, the History page will show every match Firebase managed to
   * record.
   *
   * The `winner` param mirrors the value assigned to matchResult
   * (never yet read by finishMatch — passed for future practice-record
   * shape parity).
   */
  function recordFinishedMatch(winner: 'a' | 'b' | 'draw' | null): void {
    // Practice IS archived (as mode='practice') so the umpire can see
    // their drill history. Retention is shorter than versus matches
    // (3 months vs 1 year) — handled by the client-side sweep on
    // lobby load. See history.ts sweepOldMatches().
    try {
      const key = matchStateKey(cfg.mode, cfg.playerA, cfg.playerB);
      const identity = loadMatchIdentity(key);
      const startedAt = loadMatchStart(key) ?? Date.now();
      const identityPayload = {
        aName: cfg.playerA,
        aResolvedId: identity.aResolvedId,
        a2Name: cfg.playerA2,
        a2ResolvedId: identity.a2ResolvedId,
        bName: cfg.playerB,
        bResolvedId: identity.bResolvedId,
        b2Name: cfg.playerB2,
        b2ResolvedId: identity.b2ResolvedId,
      };
      const resultPayload = {
        mode: cfg.mode,
        winner,
        sideA: { points: sideA.points, sets: sideA.sets },
        sideB: { points: sideB.points, sets: sideB.sets },
        board,
        cfg: {
          bestOf: cfg.bestOf,
          maxBoards: cfg.maxBoards,
          pointsTarget: cfg.pointsTarget,
          format: cfg.format,
        },
        notes: { a: sideA.note, b: sideB.note },
        ...(cfg.tournament ? { tournament: cfg.tournament } : {}),
        startedAt,
        endedAt: Date.now(),
        ...(boardLog.length > 0 ? { boardLog: [...boardLog] } : {}),
        ...(isPractice && practiceBoards.length > 0
          ? { practiceBoards: practiceBoards.map((row) => [...row]) }
          : {}),
      };
      // Offline path (v3.0): if we know we can't reach Firebase,
      // don't even try — enqueue directly so the archive syncs
      // when connectivity returns. Also drop the /live/{mid} queue
      // entry since the archive is now authoritative for this match.
      if (!getConnectivity().online) {
        enqueueMatch({
          identity: identityPayload,
          result: resultPayload,
          createdByAtEnqueue: currentUser()?.uid ?? null,
        });
        if (cfg.mid) dropLive(cfg.mid);
        clearMatchIdentity(key);
        // From the umpire's POV, the End tap was successful — no
        // toast, no error. The queue will replay when we reconnect.
        return;
      }
      finishMatch(identityPayload, resultPayload).then((matchId) => {
        // finishMatch resolves to null when the RTDB write failed
        // (network dead, rules denied, package failed to load).
        // If we're STILL online per connectivity, that's a real
        // failure (rules denied / bad payload) — surface it. If we
        // dropped offline mid-flight, queue and stay quiet.
        if (matchId === null) {
          if (!getConnectivity().online) {
            enqueueMatch({
              identity: identityPayload,
              result: resultPayload,
              createdByAtEnqueue: currentUser()?.uid ?? null,
            });
            if (cfg.mid) dropLive(cfg.mid);
            return;
          }
          archiveFailedToast = true;
          window.setTimeout(() => { archiveFailedToast = false; }, 6000);
          return;
        }
        // Successful archive — remember the id so the end-recap
        // "Fix this match" link can hand it to the edit modal.
        archivedMatchId = matchId;
      });
      // Clear the handoff so a "same names again" match after this one
      // doesn't accidentally reuse the same startedAt / resolutions.
      clearMatchIdentity(key);
    } catch {
      // Even the local pre-work threw — very unusual. Swallow so the
      // winner popup renders regardless of Firebase state.
    }
  }

  function swapSides() {
    // Refuse the swap once any board has been recorded. The
    // boardLog entries carry pointsA/pointsB/breakSide/queen tied
    // to the pre-swap seats; swapping the live top-row state
    // without also rewriting the log produces a corrupt-looking
    // recap (top row says A won 2-1 while the per-set tables say
    // B won every set). Guard added 2026-08-18 after mid=ais81o
    // was reported with exactly that inversion.
    //
    // If the umpire genuinely needs the players to change seats
    // mid-match, they should end + restart with the correct
    // orientation. In practice Swap is only meaningful pre-scoring
    // (accidental setup mis-order) or during Practice (which has
    // no boardLog concern — practice mode doesn't append here).
    if (!isPractice && boardLog.length > 0) {
      swapBlockedToast = true;
      window.setTimeout(() => { swapBlockedToast = false; }, 3000);
      return;
    }
    // Physical seat swap: every per-player attribute travels with the player,
    // so their names, notes, colours, SET counts, AND current-set POINTS all
    // move together. BOARD stays put — it belongs to the match, not a player.
    const tmpName = sideA.name;
    sideA.name = sideB.name;
    sideB.name = tmpName;
    const tmpNote = sideA.note;
    sideA.note = sideB.note;
    sideB.note = tmpNote;
    const tmpSets = sideA.sets;
    sideA.sets = sideB.sets;
    sideB.sets = tmpSets;
    const tmpPoints = sideA.points;
    sideA.points = sideB.points;
    sideB.points = tmpPoints;
    const tmpColour = colourA;
    colourA = colourB;
    colourB = tmpColour;
    // BREAK belongs to a player (match-long assignment), so flip it so
    // the chip visually stays with the same person after the seat swap.
    currentBreak = currentBreak === 'a' ? 'b' : 'a';
    // QUEEN is per-board and often re-negotiated after a swap-sides
    // (players re-position, previous board's queen is no longer the
    // authoritative state). Clear it to grey on both sides — organiser
    // can tap either coin to re-mark once play resumes.
    queenHolder = null;
  }

  function resetScores() {
    sideA.sets = 0;
    sideB.sets = 0;
    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    matchResult = null;
    isDecidingBoard = false;
    colourA = 'a';
    colourB = 'b';
    currentBreak = 'a';
    queenHolder = null;
    boardLog = [];
    pointsAtBoardStart = { a: 0, b: 0 };
    if (isPractice) {
      practiceBoards = blankMatrix(cfg.bestOf, cfg.maxBoards);
      practiceSetIdx = 0;
    }
  }
  let confirmReset = $state(false);
  function requestReset() {
    if (!hasProgress) return;
    confirmReset = true;
  }

  const hasProgress = $derived(
    isPractice
      ? practiceBoards.some((row) => row.some((v) => v > 0))
      : sideA.points > 0 || sideB.points > 0 || sideA.sets > 0 || sideB.sets > 0 || board > 0,
  );

  function requestExit() {
    if (!hasProgress) return exit();
    confirmExit = true;
  }
  async function exit() {
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
    await releaseLandscape();
    window.location.href = import.meta.env.BASE_URL;
  }

  /**
   * Swipe action: one gesture = one adjust.
   *   - swipe LEFT  (≥ SWIPE_PX)  → onDelta(+1)
   *   - swipe RIGHT (≥ SWIPE_PX)  → onDelta(-1)
   *   - plain tap (no horizontal movement > threshold) → onDelta(+1)
   */
  function swipeAdjust(node: HTMLElement, opts: { onDelta: (d: 1 | -1) => void }) {
    const SWIPE_PX = 32;
    let startX = 0;
    let startY = 0;
    let active = false;
    let fired = false;

    function onPointerDown(ev: PointerEvent) {
      if (!ev.isPrimary) return;
      active = true;
      fired = false;
      startX = ev.clientX;
      startY = ev.clientY;
      try { node.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    }
    function onPointerMove(ev: PointerEvent) {
      if (!active || fired) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) < Math.abs(dy)) return;
      if (Math.abs(dx) < SWIPE_PX) return;
      fired = true;
      opts.onDelta(dx < 0 ? 1 : -1);
    }
    function onPointerUp() {
      if (active && !fired) opts.onDelta(1);
      active = false;
      fired = false;
    }
    function onPointerCancel() {
      active = false;
      fired = false;
    }
    function onTouchStart(ev: TouchEvent) {
      if (ev.cancelable) ev.preventDefault();
    }

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);
    node.addEventListener('touchstart', onTouchStart, { passive: false });

    return {
      update(next: { onDelta: (d: 1 | -1) => void }) {
        opts = next;
      },
      destroy() {
        node.removeEventListener('pointerdown', onPointerDown);
        node.removeEventListener('pointermove', onPointerMove);
        node.removeEventListener('pointerup', onPointerUp);
        node.removeEventListener('pointercancel', onPointerCancel);
        node.removeEventListener('touchstart', onTouchStart);
      },
    };
  }

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const setsFmt = (n: number) => `${Math.min(9, Math.max(0, n))}`;

  const ordinal = (n: number) => (['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][n - 1] ?? `${n}th`);

  type SetPip = 'a' | 'b' | 'current' | 'pending';
  const setPips = $derived<SetPip[]>(() => {
    const total = cfg.bestOf;
    const aWins = Math.min(sideA.sets, total);
    const bWins = Math.min(sideB.sets, Math.max(0, total - aWins));
    const pips: SetPip[] = [];
    for (let i = 0; i < aWins; i += 1) pips.push('a');
    for (let i = 0; i < bWins; i += 1) pips.push('b');
    const completed = pips.length;
    for (let i = completed; i < total; i += 1) {
      const isCurrent = i === completed && !matchResult;
      pips.push(isCurrent ? 'current' : 'pending');
    }
    return pips;
  });

  /**
   * Queen advantage-lockout threshold: from (pointsTarget − queenValue)
   * onward, the queen can no longer be claimed by the leading side.
   * ICF rule: if you're within a queen's worth of winning, covering
   * the queen doesn't credit — otherwise the queen's 3 points could
   * push a side past target without their needing to pocket the
   * last coin.
   *
   * Derived from cfg.pointsTarget so any target works correctly:
   *   25 → lockout at 22; 20 → at 17; 15 → at 12.
   * Previously hardcoded to 22, only correct for the default
   * 25-point target.
   */
  const QUEEN_VALUE = 3;
  const queenLockThreshold = $derived(cfg.pointsTarget - QUEEN_VALUE);
  const queenLockedA = $derived(sideA.points >= queenLockThreshold);
  const queenLockedB = $derived(sideB.points >= queenLockThreshold);

</script>

<section class="wrap">
  {#snippet coinSvg()}
    <!--
      Carrom queen coin. Concentric ring geometry mimics the grooved
      circles on a real red wooden coin (see amzn.in/dp/B0HCNWLZ5D). The
      same paths render in both states — CSS variables --coin-face,
      --coin-ring, --coin-shadow, --coin-highlight swap between grey (no
      queen) and red (this side has the queen) via the .coin-red modifier.
    -->
    <svg viewBox="-16 -16 32 32" width="1.55em" height="1.55em" aria-hidden="true" focusable="false">
      <ellipse cx="0" cy="8" rx="12.5" ry="2" fill="var(--coin-shadow)" />
      <circle cx="0" cy="0" r="13" fill="var(--coin-face)" stroke="var(--coin-outline)" stroke-width="1.2" />
      <circle cx="0" cy="0" r="10.5" fill="none" stroke="var(--coin-ring)" stroke-width="0.9" opacity="0.9" />
      <circle cx="0" cy="0" r="7"    fill="none" stroke="var(--coin-ring)" stroke-width="0.7" opacity="0.75" />
      <circle cx="0" cy="0" r="1.6" fill="var(--coin-ring)" opacity="0.9" />
      <ellipse cx="-4.5" cy="-5.5" rx="4.2" ry="2.5" fill="var(--coin-highlight)" opacity="0.55" transform="rotate(-30)" />
    </svg>
  {/snippet}

  <button type="button" class="rotate-hint" onclick={() => tryLockLandscape()}>
    <div class="rotate-card">
      <div class="rotate-icon" aria-hidden="true">📱</div>
      <strong>Tap to start scoring</strong>
      <span>Carromscore uses landscape. Tap here and rotate your phone if it doesn't turn automatically.</span>
    </div>
  </button>

  {#if isPractice}
    <header class="head practice-head">
      <div class="head-name head-a tone-{colourA}">
        <span class="hn-name">{sideA.name}</span>
        {#if sideA.note}<span class="hn-note">{sideA.note}</span>{/if}
      </div>
      <div class="head-mid">
        <div class="set-label">
          PRACTICE
          {#if cfg.bestOf > 1}
            <span class="practice-set-marker">SET {practiceSetIdx + 1}/{cfg.bestOf}</span>
          {:else}
            <span>· 1 SET × {cfg.maxBoards} BOARD{cfg.maxBoards === 1 ? '' : 'S'}</span>
          {/if}
        </div>
        <div class="practice-total-line">
          Total missed <span class="practice-total-num">{practiceGrandTotal()}</span>
        </div>
      </div>
      <div aria-hidden="true"></div>
    </header>

    <div class="practice-grid">
      <!-- Fixed SET flank -->
      <div class="pflank pflank-set">
        <div class="pth pth-set">SET</div>
        <div class="prow-label pset-num">{practiceSetIdx + 1}</div>
      </div>

      <!-- Middle track: all N cells (one per board) render inline.
           The scroll container is retained as a defensive fallback
           for very-many-boards sets on narrow phones — CSS `--visible`
           is set to the board count so the container aims to fit
           everything; horizontal overflow only kicks in when the
           viewport can't hold the row. -->
      <div
        class="pscroll"
        bind:this={practiceScrollerEl}
        onscroll={onPracticeScroll}
        style="--visible: {cfg.maxBoards}; --board-count: {cfg.maxBoards};"
      >
        <div class="pscroll-head">
          {#each Array.from({ length: cfg.maxBoards }, (_, i) => i) as boardIdx (boardIdx)}
            <div class="pth">B{boardIdx + 1}</div>
          {/each}
        </div>
        <div class="pscroll-row">
          {#each Array.from({ length: cfg.maxBoards }, (_, i) => i) as boardIdx (boardIdx)}
            {@const cellVal = (practiceBoards[practiceSetIdx]?.[boardIdx]) ?? 0}
            <button
              type="button"
              class="pcell"
              use:swipeAdjust={{ onDelta: (d) => adjustPracticeBoard(practiceSetIdx, boardIdx, d) }}
              aria-label="Set {practiceSetIdx + 1} board {boardIdx + 1}: {cellVal} missed"
            >
              <div class="digit pdigit">{cellVal}</div>
            </button>
          {/each}
        </div>
      </div>

      <!-- Fixed TOTAL flank -->
      <div class="pflank pflank-total">
        <div class="pth pth-total">TOTAL</div>
        <div class="prow-total-num">{practiceSetTotal(practiceSetIdx)}</div>
      </div>
    </div>

    <!-- Solo practice: every board of the current set renders inline;
         no board-page chips. The scroll container still allows
         horizontal overflow for very-many-boards sets, and sets
         remain the paginated unit via the arrows below. -->



    {#if cfg.bestOf > 1}
      <div class="practice-pager">
        <button
          type="button"
          class="foot-btn practice-pager-btn"
          onclick={() => { practiceSetIdx = Math.max(0, practiceSetIdx - 1); }}
          disabled={practiceSetIdx === 0}
          aria-label="Previous set"
        >
          <span class="foot-ico" aria-hidden="true">←</span><span class="foot-lbl">Previous set</span>
        </button>
        <span class="practice-pager-pips" aria-hidden="true">
          {#each Array.from({ length: cfg.bestOf }, (_, i) => i) as pIdx (pIdx)}
            <span class="pager-pip" class:pager-pip-current={pIdx === practiceSetIdx}></span>
          {/each}
        </span>
        <button
          type="button"
          class="foot-btn practice-pager-btn"
          onclick={() => { practiceSetIdx = Math.min(cfg.bestOf - 1, practiceSetIdx + 1); }}
          disabled={practiceSetIdx === cfg.bestOf - 1}
          aria-label="Next set"
        >
          <span class="foot-lbl">Next set</span><span class="foot-ico" aria-hidden="true">→</span>
        </button>
      </div>
    {/if}
  {:else}
  {#if isDecidingBoard}
    <!--
      Deciding-board banner. Rendered when the umpire chose "Play
      deciding board" from the at-maxBoards tie chooser. Signals that
      the scoreboard is now in a tiebreaker state — one extra board
      is being played on top of the configured maxBoards limit.
      Clears when the match ends or on Reset.
    -->
    <div class="decider-banner" role="status" aria-live="polite">
      <span aria-hidden="true">⚡</span>
      <span>Deciding board</span>
    </div>
  {/if}
  <header class="head">
    <!-- Side A: [NAME PILL] [BREAK-chip?] [coin] -->
    <div class="head-side head-side-a">
      <div class="head-name head-a tone-{colourA}"
           class:decided={matchResult !== null}
           class:gold={matchResult === 'a'}
           class:silver={matchResult === 'b'}
           class:draw={matchResult === 'draw'}>
        <span class="hn-row">
          {#if matchResult === 'a'}
            <span class="medal" aria-label="First place">
              <span class="medal-icon" aria-hidden="true">🥇</span>
              <span class="medal-label">1ST</span>
            </span>
          {:else if matchResult === 'b'}
            <span class="medal" aria-label="Second place">
              <span class="medal-icon" aria-hidden="true">🥈</span>
              <span class="medal-label">2ND</span>
            </span>
          {:else if matchResult === 'draw'}
            <span class="medal" aria-label="Draw">
              <span class="medal-icon" aria-hidden="true">🤝</span>
              <span class="medal-label">DRAW</span>
            </span>
          {/if}
          <span class="hn-name">{sideA.name}</span>
        </span>
        {#if sideA.note}<span class="hn-note">{sideA.note}</span>{/if}
      </div>
      {#if currentBreak === 'a'}
        <button
          type="button"
          class="chip chip-break tone-{colourA}"
          class:chip-locked={!breakToggleAllowed}
          onclick={cycleBreak}
          disabled={!breakToggleAllowed}
          aria-label={breakToggleAllowed
            ? `${sideA.name} breaks. Tap to change.`
            : `${sideA.name} breaks this board.`}
        >
          <span class="chip-lbl">BREAK</span>
        </button>
      {/if}
      <button
        type="button"
        class="coin-btn"
        class:coin-red={queenHolder === 'a'}
        onclick={() => tapCoin('a')}
        aria-label={queenHolder === 'a' ? `${sideA.name} has the queen. Tap to return.` : `Tap when ${sideA.name} pockets the queen.`}
      >
        {@render coinSvg()}
      </button>
    </div>

    <!-- Middle: set pips + board + optional centred BREAK? chip when unassigned -->
    <div class="head-mid">
      {#if cfg.bestOf === 1}
        <div class="set-label">SINGLE SET</div>
      {:else}
        <div class="set-pips" aria-label="Set {currentSet} of {cfg.bestOf}">
          {#each setPips() as pip, i (i)}
            <span class="set-pip pip-{pip}" aria-hidden="true">
              {#if pip === 'a' || pip === 'b'}✓{/if}
            </span>
          {/each}
          <span class="set-caption">SET {ordinal(currentSet)}</span>
        </div>
      {/if}
      <div class="board-progress" aria-label="Board {board} of {isBoardsUnlimited(cfg) ? '∞' : cfg.maxBoards}">
        <span class="board-caption">BOARD</span>
        <span class="board-track">
          {#if !isBoardsUnlimited(cfg)}
            <span class="board-fill" style="width: {Math.min(100, (board / cfg.maxBoards) * 100)}%"></span>
          {/if}
        </span>
        <span class="board-count">
          {board}
          {#if !isBoardsUnlimited(cfg)}<span class="board-total">/{cfg.maxBoards}</span>{/if}
        </span>
      </div>
    </div>

    <!-- Side B: [coin] [BREAK-chip?] [NAME PILL] -->
    <div class="head-side head-side-b">
      <button
        type="button"
        class="coin-btn"
        class:coin-red={queenHolder === 'b'}
        onclick={() => tapCoin('b')}
        aria-label={queenHolder === 'b' ? `${sideB.name} has the queen. Tap to return.` : `Tap when ${sideB.name} pockets the queen.`}
      >
        {@render coinSvg()}
      </button>
      {#if currentBreak === 'b'}
        <button
          type="button"
          class="chip chip-break tone-{colourB}"
          class:chip-locked={!breakToggleAllowed}
          onclick={cycleBreak}
          disabled={!breakToggleAllowed}
          aria-label={breakToggleAllowed
            ? `${sideB.name} breaks. Tap to change.`
            : `${sideB.name} breaks this board.`}
        >
          <span class="chip-lbl">BREAK</span>
        </button>
      {/if}
      <div class="head-name head-b tone-{colourB}"
           class:decided={matchResult !== null}
           class:gold={matchResult === 'b'}
           class:silver={matchResult === 'a'}
           class:draw={matchResult === 'draw'}>
        <span class="hn-row">
          <span class="hn-name">{sideB.name}</span>
          {#if matchResult === 'b'}
            <span class="medal" aria-label="First place">
              <span class="medal-icon" aria-hidden="true">🥇</span>
              <span class="medal-label">1ST</span>
            </span>
          {:else if matchResult === 'a'}
            <span class="medal" aria-label="Second place">
              <span class="medal-icon" aria-hidden="true">🥈</span>
              <span class="medal-label">2ND</span>
            </span>
          {:else if matchResult === 'draw'}
            <span class="medal" aria-label="Draw">
              <span class="medal-icon" aria-hidden="true">🤝</span>
              <span class="medal-label">DRAW</span>
            </span>
          {/if}
        </span>
        {#if sideB.note}<span class="hn-note">{sideB.note}</span>{/if}
      </div>
    </div>
  </header>

  {#if queenLockedA || queenLockedB}
    <div class="queen-lock">
      <span class="ql-line">
        {#if queenLockedA && queenLockedB}
          <!-- Both sides locked out: compact form -->
          <span class="ql-name qa">{sideA.name}</span>
          <span class="ql-num">{cfg.pointsTarget - sideA.points}</span>
          <span class="ql-sep">·</span>
          <span class="ql-name qb">{sideB.name}</span>
          <span class="ql-num">{cfg.pointsTarget - sideB.points}</span>
          <span class="ql-trail">to win</span>
          <span class="ql-sep">·</span>
          <span class="ql-noqueen">no queen</span>
        {:else if queenLockedA}
          <span class="ql-name qa">{sideA.name}</span>
          needs
          <span class="ql-num">{cfg.pointsTarget - sideA.points}</span>
          {cfg.pointsTarget - sideA.points === 1 ? 'point' : 'points'} to win
          <span class="ql-sep">·</span>
          <span class="ql-noqueen">no queen</span>
        {:else}
          <span class="ql-name qb">{sideB.name}</span>
          needs
          <span class="ql-num">{cfg.pointsTarget - sideB.points}</span>
          {cfg.pointsTarget - sideB.points === 1 ? 'point' : 'points'} to win
          <span class="ql-sep">·</span>
          <span class="ql-noqueen">no queen</span>
        {/if}
      </span>
    </div>
  {/if}

  <div class="grid">
    <button type="button" class="col side-a tone-{colourA} set" use:swipeAdjust={{ onDelta: (d) => adjustSets('a', d) }} aria-label="{sideA.name} sets: tap or swipe left to add, swipe right to subtract">
      <div class="digit">{setsFmt(sideA.sets)}</div>
      <div class="label">SET</div>
    </button>
    <button type="button" class="col side-a tone-{colourA} pts" use:swipeAdjust={{ onDelta: (d) => adjustPoints('a', d) }} aria-label="{sideA.name} points: tap or swipe left to add, swipe right to subtract">
      <div class="digit big">{pad2(sideA.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col mid brd" use:swipeAdjust={{ onDelta: (d) => adjustBoard(d) }} aria-label="Board: tap or swipe left to add, swipe right to subtract">
      <div class="digit">{board}</div>
      <div class="label">BOARD</div>
    </button>
    <button type="button" class="col side-b tone-{colourB} pts" use:swipeAdjust={{ onDelta: (d) => adjustPoints('b', d) }} aria-label="{sideB.name} points: tap or swipe left to add, swipe right to subtract">
      <div class="digit big">{pad2(sideB.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col side-b tone-{colourB} set" use:swipeAdjust={{ onDelta: (d) => adjustSets('b', d) }} aria-label="{sideB.name} sets: tap or swipe left to add, swipe right to subtract">
      <div class="digit">{setsFmt(sideB.sets)}</div>
      <div class="label">SET</div>
    </button>
  </div>
  {/if}

  <div class="foot">
    {#if matchResult === 'draw'}
      <span class="winner">
        <span class="winner-dot"></span>
        <strong>Match tied</strong>
        {sideA.sets}–{sideB.sets} · {pad2(sideA.points)}–{pad2(sideB.points)}
      </span>
    {:else if matchResult}
      <span class="winner">
        <span class="winner-dot"></span>
        <strong>{matchResult === 'a' ? sideA.name : sideB.name}</strong>
        wins {sideA.sets}–{sideB.sets}
      </span>
    {:else}
      <span class="hint">
        © 2026 Swapnil Deshpande
        <span class="hint-sep" aria-hidden="true">·</span>
        <a
          class="hint-ver"
          href={releaseUrl()}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Carromscore v${APP_VERSION} release notes on GitHub`}
        >v{APP_VERSION}</a>
      </span>
    {/if}
    <div class="foot-actions">
      {#if !isPractice}
        <button type="button" class="foot-btn swap" onclick={swapSides} aria-label="Swap sides">
          <span class="foot-ico" aria-hidden="true">⇄</span><span class="foot-lbl">Swap</span>
        </button>
      {/if}
      <!--
        Reset button hidden 2026-08-17: umpires kept tapping this
        thinking it would undo the last board / roll back a stray
        credit, but Reset wipes everything back to 0-0-0. The correct
        undo path is a right-swipe on the individual digit (POINTS-/
        BOARD- / SET-). Bringing Reset back requires a clearer
        distinction (naming, confirmation copy, or a "roll back last
        board" affordance).

        The confirmReset state machine + resetScores() function are
        still wired — the toast "Match ended — score is locked. Use
        Reset to start over." references Reset. Left in place so a
        future re-introduction is a one-line uncomment.
      <button type="button" class="foot-btn reset" onclick={requestReset} disabled={!hasProgress} aria-label="Reset scores">
        <span class="foot-ico" aria-hidden="true">↻</span><span class="foot-lbl">Reset</span>
      </button>
      -->

      <button type="button" class="foot-btn endm" onclick={endMatch} aria-label="End match">
        <span class="foot-ico" aria-hidden="true">🏁</span><span class="foot-lbl">End</span>
      </button>
      <button type="button" class="foot-btn close" onclick={requestExit} aria-label="Close match">
        <span class="foot-ico" aria-hidden="true">✕</span><span class="foot-lbl">Close</span>
      </button>
    </div>
  </div>

  {#if showWinnerPopup && matchResult}
    <!--
      Winner popup. Outside-click closes; the "View scorecard" button
      dismisses this AND opens the board-by-board recap popup below.
    -->
    <div
      class="dialog winner-dialog"
      role="dialog"
      aria-modal="true"
      onclick={(e) => {
        // When the umpire must choose between "draw" and "decider",
        // outside-click can't dismiss — they'd bypass the choice and
        // leave the match in a half-committed state (matchResult set
        // but no archive written). Force a button press.
        if (pendingDrawChoice) return;
        if (e.target === e.currentTarget) showWinnerPopup = false;
      }}
    >
      {#if matchResult !== 'draw'}
        <div class="fireworks" aria-hidden="true">
          {#each SPARK_INDICES as i (i)}
            <span class="spark spark-{i % 8}" style="--n: {i}"></span>
          {/each}
        </div>
      {/if}
      <div class="dialog-card champion" class:draw={matchResult === 'draw'}>
        {#if !pendingDrawChoice}
          <button
            type="button"
            class="dialog-close"
            onclick={() => (showWinnerPopup = false)}
            aria-label="Close"
          >✕</button>
        {/if}
        {#if matchResult === 'draw'}
          <div class="champ-trophy" aria-hidden="true">🤝</div>
          <div class="champ-label">{pendingDrawChoice ? 'MATCH TIED?' : 'DRAW'}</div>
          <div class="champ-name">{sideA.name} · {sideB.name}</div>
        {:else}
          <div class="champ-trophy" aria-hidden="true">🏆</div>
          <div class="champ-label">CHAMPION</div>
          <div class="champ-name">{matchResult === 'a' ? sideA.name : sideB.name}</div>
        {/if}
        <div class="champ-score">
          Sets <strong>{sideA.sets}–{sideB.sets}</strong>
          <span class="champ-sep">·</span>
          Final board <strong>{pad2(sideA.points)}–{pad2(sideB.points)}</strong>
        </div>
        {#if pendingDrawChoice}
          <!--
            The at-maxBoards tie chooser. Umpire picks between playing
            one extra board to break the tie (common in some regions)
            or calling it a draw here. Outside-click and ✕ are
            suppressed above so the umpire can't dismiss and get
            stuck — one of these two must be picked.
          -->
          <p class="champ-choice-hint">
            The match reached the last board with scores level. Play a
            deciding board, or commit as a draw?
          </p>
          <div class="champ-choice">
            <button
              type="button"
              class="confirm-big confirm-secondary"
              onclick={() => handleDrawChoice('draw')}
            >Call it a draw</button>
            <button
              type="button"
              class="confirm-big"
              onclick={() => handleDrawChoice('decider')}
            >Play deciding board</button>
          </div>
        {:else}
          <button
            class="confirm-big"
            onclick={() => { showWinnerPopup = false; showScorecardPopup = true; }}
          >
            View scorecard
          </button>
        {/if}
      </div>
    </div>
  {/if}

  {#if showScorecardPopup && matchResult}
    <!--
      Board-by-board recap after End. Same LiveScoreboardView the /live/
      lobby uses for History cards — mounted in-page against a
      synthesised LiveRecord built from current match state. Outside-
      click closes; top-right ✕ closes too.
    -->
    {@const scorecardRecord = {
      matchId: '',
      updatedAt: Date.now(),
      meta: {
        mode: cfg.mode,
        playerA: cfg.playerA,
        playerA2: cfg.playerA2,
        playerB: cfg.playerB,
        playerB2: cfg.playerB2,
        noteA: cfg.noteA,
        noteB: cfg.noteB,
        bestOf: cfg.bestOf,
        pointsTarget: cfg.pointsTarget,
        maxBoards: cfg.maxBoards,
        ...(cfg.tournament ? { tournament: cfg.tournament } : {}),
      },
      liveState: {
        sideA: { points: sideA.points, sets: sideA.sets },
        sideB: { points: sideB.points, sets: sideB.sets },
        board,
        currentBreak: null,
        queenHolder: null,
        matchResult,
        ...(boardLog.length > 0 ? { boardLog } : {}),
      },
    } as LiveRecord}
    <div
      class="dialog scorecard-dialog"
      role="dialog"
      aria-modal="true"
      onclick={(e) => { if (e.target === e.currentTarget) showScorecardPopup = false; }}
    >
      <div class="dialog-card scorecard-card">
        <button
          type="button"
          class="dialog-close"
          onclick={() => (showScorecardPopup = false)}
          aria-label="Close scorecard"
        >✕</button>
        <LiveScoreboardView record={scorecardRecord} />
        {#if canEditArchived()}
          <!--
            Admin-only "Fix this match" link. Appears once the record
            has been archived to /matches (archivedMatchId != null)
            AND the current user is authorised. Opens the shared
            edit modal in-place.
          -->
          <div class="scorecard-admin">
            <button
              type="button"
              class="fix-btn"
              onclick={() => (showEditModal = true)}
            >✎ Fix this match</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  {#if showEditModal && archivedMatchId}
    {@const record = buildMatchRecordForEdit()}
    {#if record}
      <MatchEditModal
        {record}
        isSuper={!!role?.isSuper}
        onClose={() => (showEditModal = false)}
        onSaved={() => {
          showEditModal = false;
          // After a successful admin edit, close the scorecard popup
          // too so the umpire returns to the main board — reopening
          // the recap would show stale locally-cached data.
          showScorecardPopup = false;
        }}
      />
    {/if}
  {/if}

  {#if showPracticePopup}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card practice-recap">
        <div class="practice-recap-title">PRACTICE RECAP</div>
        <div class="practice-recap-name">{sideA.name}</div>
        <table class="practice-recap-table">
          <thead>
            <tr>
              <th class="rc-set-h">SET</th>
              {#each Array.from({ length: cfg.maxBoards }, (_, i) => i) as boardIdx (boardIdx)}
                <th>B{boardIdx + 1}</th>
              {/each}
              <th class="rc-total-h">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {#each practiceBoards as row, setIdx (setIdx)}
              <tr>
                <td class="rc-set">{setIdx + 1}</td>
                {#each row as cell, boardIdx (boardIdx)}
                  <td>{cell}</td>
                {/each}
                <td class="rc-total">{practiceSetTotal(setIdx)}</td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td class="rc-set" colspan={cfg.maxBoards + 1}>Total missed</td>
              <td class="rc-grand">{practiceGrandTotal()}</td>
            </tr>
          </tfoot>
        </table>
        <button class="confirm-big" onclick={() => (showPracticePopup = false)}>
          Show scoreboard
        </button>
      </div>
    </div>
  {/if}

  {#if confirmExit}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card exit">
        <h2>Exit match?</h2>
        <p class="who">Current score will be discarded.</p>
        <div class="dialog-actions">
          <button class="cancel" onclick={() => (confirmExit = false)}>Keep playing</button>
          <button class="danger" onclick={exit}>Exit</button>
        </div>
      </div>
    </div>
  {/if}

  {#if queenRequiredToast}
    <!--
      Small non-blocking toast that appears when the umpire taps
      BOARD+1 without a queen holder marked. Real-carrom rule: every
      board ends with the queen either pocketed or awarded. The toast
      auto-dismisses after 2.5s.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Mark queen before ending board
    </div>
  {/if}

  {#if setDecidedToast}
    <!--
      Surfaced when BOARD+1 is tapped after a side has reached
      pointsTarget. Set is over — the next tap should be SET+1
      (start next set) or End (finalise match). This prevents the
      phantom-9th-board bug from Prem/Yash's 08-08 test.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Set decided — tap SET+1 or End
    </div>
  {/if}

  {#if setLoserToast}
    <!--
      Surfaced when SET+1 is tapped on the losing side (per-set
      points strictly lower than the opponent). Real carrom: only
      the winning side can credit a set. Prevents the umpire from
      accidentally awarding a set to the wrong player.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Only the leading side can be credited a set
    </div>
  {/if}

  {#if setTiedToast}
    <!--
      Surfaced when SET+1 is tapped on a tied set (per-set points
      equal). A tied set has no winner; the umpire needs to tap
      End Match, which detects the tie-at-cap and pops the
      deciding-board chooser.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Set is tied — tap End Match to play a deciding board
    </div>
  {/if}


  {#if matchDecidedToast}
    <!--
      Surfaced when any positive-delta scoring input (POINTS+, BOARD+,
      SET+, tapCoin) is attempted after endMatch has decided the
      result. Prevents stray taps from adding phantom scoring after
      the match is closed. Negative deltas remain enabled as an undo.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Match ended — score is locked. Use Reset to start over.
    </div>
  {/if}

  {#if boardCapToast}
    <!--
      Fires when a POINTS tap would take this side past 12 on the
      current board. ICF-rules ceiling: 9 opponent-side pucks × 1 pt
      + queen coverage 3 = 12. Umpire probably means BOARD +1.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Max 12 points per board — tap BOARD +1 for the next board
    </div>
  {/if}

  {#if singleScorerToast}
    <!--
      Fires when the umpire tries to score points on side B after
      side A has already scored on this board (or vice versa). Real
      carrom: only ONE side scores per board — the pockets belong
      to whoever finishes with the queen covered. To correct a
      mistap, swipe right on the other side to zero out its
      per-board delta first.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Only one side scores per board — swipe right on the other side to correct
    </div>
  {/if}

  {#if swapBlockedToast}
    <!--
      Fires when Swap is tapped after any board has been recorded.
      Swap is only meaningful pre-scoring; a mid-match swap would
      leave boardLog entries attached to pre-swap A/B labels while
      the top-row SET/POINTS state flips, producing a corrupt
      recap (top says A won 2-1, tables say B won every set).
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Swap is only allowed before the first board — scores are already recorded
    </div>
  {/if}

  {#if matchClinchedToast}
    <!--
      Fires when SET+ is tapped on either side after the OTHER
      side has already clinched the match (⌈bestOf/2⌉ sets won).
      Prevents phantom sets played post-match-decision — a bo3
      match with sets 0-2 for side B cannot legally continue.
    -->
    <div class="queen-toast" role="status" aria-live="polite">
      Match already decided — tap End to finalise
    </div>
  {/if}

  {#if archiveFailedToast}
    <!--
      Surfaced when the Firebase write of the finished match failed
      (rules denied, network dead). The umpire needs to know this so
      they don't assume History captured it. Sits 6s so it's readable
      but doesn't linger.
    -->
    <div class="queen-toast archive-toast" role="status" aria-live="polite">
      Match archive failed — score visible on this device only
    </div>
  {/if}

  {#if confirmReset}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card exit">
        <h2>Reset scores?</h2>
        <p class="who">All points, sets, and boards go back to zero. Players stay the same.</p>
        <div class="dialog-actions">
          <button class="cancel" onclick={() => (confirmReset = false)}>Cancel</button>
          <button class="danger" onclick={() => { resetScores(); confirmReset = false; }}>Reset</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .wrap {
    /* Subtract the offline-banner's height (set by BaseLayout as a
       CSS variable, 0 when online) so the full-viewport score UI
       still fits under the banner without clipping the bottom.
       Without this, `100dvh` + body's padding-top from the banner
       pushes the container below the fold and overflow:hidden
       cuts the End / Reset / Close footer off. Reported 2026-08-15
       on desktop landscape at ~600px height. */
    height: calc(100dvh - var(--offline-banner-h, 0px));
    max-height: calc(100dvh - var(--offline-banner-h, 0px));
    padding: max(0.4rem, env(safe-area-inset-top)) 0.5rem
             max(0.4rem, env(safe-area-inset-bottom)) 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    user-select: none;
    -webkit-user-select: none;
    overflow: hidden;
  }

  .rotate-hint {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(11,11,11,0.98);
    align-items: center;
    justify-content: center;
    padding: 2rem;
    border: none;
    color: inherit;
    font: inherit;
    text-align: center;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .rotate-hint:active { background: rgba(20,20,20,0.98); }
  @media (orientation: portrait) and (max-width: 900px) {
    .rotate-hint { display: flex; }
  }

  /* Queen-required toast: shown when the umpire taps BOARD+1 without
     marking the queen holder on the current board. Non-blocking,
     auto-dismisses after 2.5s. Sits centred near the top so it doesn't
     hide the score digits or the footer buttons. */
  .queen-toast {
    position: fixed;
    top: max(0.75rem, env(safe-area-inset-top));
    left: 50%;
    transform: translateX(-50%);
    z-index: 300;
    padding: 0.55rem 1.1rem;
    background: linear-gradient(135deg, #3a2a10, #2a1e0a);
    border: 1px solid rgba(255, 213, 74, 0.6);
    color: var(--accent);
    font-weight: 700;
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    border-radius: 0.6rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
    animation: queenToastIn 0.2s ease-out;
  }
  .queen-toast.archive-toast {
    background: linear-gradient(135deg, #3a1010, #2a0a0a);
    border-color: rgba(239, 83, 80, 0.6);
    color: #ef8985;
  }
  @keyframes queenToastIn {
    from { opacity: 0; transform: translate(-50%, -0.4rem); }
    to   { opacity: 1; transform: translate(-50%, 0); }
  }

  .rotate-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.75rem;
    max-width: 20rem;
    color: var(--fg);
  }
  .rotate-icon {
    font-size: 4rem;
    line-height: 1;
    animation: rotate-nudge 2s ease-in-out infinite;
  }
  @keyframes rotate-nudge {
    0%, 60%, 100% { transform: rotate(0deg); }
    30%           { transform: rotate(-90deg); }
  }
  .rotate-card strong { font-size: 1.3rem; letter-spacing: 0.02em; }
  .rotate-card span { color: var(--muted); font-size: 0.9rem; }

  .head {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.75rem;
    padding: 0 0.25rem;
    flex-shrink: 0;
  }
  .head-name {
    display: inline-flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.15rem;
    /* Larger pill so player names read from across the room —
       tested at Prem-vs-Yash match 2026-08-08, phones sitting on the
       carrom rail. Was clamp(0.9,2.2vw,1.15rem). */
    font-size: clamp(1.15rem, 3.4vw, 1.7rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    /* Pill shrinks when the row is too narrow so the sibling BREAK chip
       and coin fit next to it. min-width:0 + flex:1 1 auto makes sure
       the pill (not the chips) gives up space first. */
    flex: 1 1 auto;
    min-width: 0;
    padding: 0.35rem 0.85rem 0.4rem;
    border-radius: 0.6rem;
    color: #0b0b0b;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  /* Top row of the pill: [medal?] [name]  (side A) or [name] [medal?]
     (side B). Keeps medal inline with the name; note stacks below. */
  .head-name .hn-row {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    min-width: 0;
    max-width: 100%;
  }
  .head-b.head-name .hn-row { justify-content: flex-end; }
  .head-name .hn-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    line-height: 1.05;
  }
  /* Country / region / club chip. Sits below the player name so the
     name has the full width to itself and won't be squeezed by the
     tag. Testers on 2026-08-09 said the inline layout hid short
     names on narrow phones. */
  .head-name .hn-note {
    font-size: 0.62em;
    font-weight: 700;
    letter-spacing: 0.06em;
    opacity: 0.75;
    padding: 0.02rem 0.35rem;
    border-radius: 0.3rem;
    background: rgba(0,0,0,0.18);
    flex-shrink: 0;
    line-height: 1.15;
  }
  .head-a { text-align: left;  justify-self: start; }
  .head-b { text-align: right; justify-self: end; }
  /* Right-side pill mirrors: name + note stack right-aligned. */
  .head-b.head-name { align-items: flex-end; }
  .head-name.tone-a { background: var(--side-a); }
  .head-name.tone-b { background: var(--side-b); }

  /*
   * Each side of the header is a single horizontal row: [coin]
   * [BREAK-chip?] [name-pill] (left side) or the mirror (right side).
   * Everything sits on the same baseline so the row reads as one block
   * of "who this player is + their current match indicators".
   */
  .head-side {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    /* min-width:0 lets the child pill's text ellipsis-truncate when the
       row runs out of horizontal space, instead of pushing the coin
       and BREAK chip out of the grid cell into the middle column. */
    min-width: 0;
    /* max-width:100% keeps the whole row inside its grid cell. */
    max-width: 100%;
  }
  .head-side-a { justify-self: start; }
  .head-side-b { justify-self: end;   }

  /*
   * Carrom queen coin. Renders identically on either side of the pill,
   * greyed when nobody has the queen, red when this side holds it.
   * Same SVG paths, colours swapped via CSS custom properties, so the
   * grey→red transition is a pure recolour (no layout shift).
   */
  .coin-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.1rem;
    border: none;
    background: transparent;
    cursor: pointer;
    line-height: 1;
    border-radius: 999px;
    -webkit-tap-highlight-color: transparent;
    flex-shrink: 0;
    /* Greyed / unowned default. Concrete tokens live here so the SVG
       stays a pure geometry ref. */
    --coin-face:      #4a4a4a;
    --coin-outline:   #2a2a2a;
    --coin-ring:      rgba(255, 255, 255, 0.28);
    --coin-shadow:    rgba(0, 0, 0, 0.4);
    --coin-highlight: #7a7a7a;
    opacity: 0.55;
    transition: opacity 0.15s, transform 0.08s;
  }
  .coin-btn:hover { opacity: 0.85; }
  .coin-btn:active { transform: translateY(1px); }
  .coin-btn.coin-red {
    /* Live queen: red wooden coin. Slight glow so it pops out. */
    --coin-face:      #b21818;
    --coin-outline:   #5a0808;
    --coin-ring:      rgba(255, 200, 200, 0.6);
    --coin-shadow:    rgba(0, 0, 0, 0.6);
    --coin-highlight: #f37070;
    opacity: 1;
    filter: drop-shadow(0 0 6px rgba(220, 40, 40, 0.5));
  }

  /*
   * BREAK chip. One constant colour regardless of which player is
   * breaking — the chip communicates a *state* ("someone is breaking"),
   * not the identity of the player, so tying it to the side colour
   * (cyan / coral) was confusing. Neutral accent gold works with both
   * sides and doesn't fight the pill next to it.
   *
   * The `.tone-a` / `.tone-b` class hooks are kept for the aria label
   * mapping and for possible future re-tinting, but visually both
   * variants render identically.
   */
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.22rem 0.6rem 0.22rem 0.5rem;
    color: var(--accent);
    background: linear-gradient(120deg, rgba(255, 213, 74, 0.2), rgba(255, 213, 74, 0.06));
    border: 1.5px solid var(--accent);
    border-radius: 999px;
    font-family: inherit;
    font-weight: 800;
    font-size: 0.68rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    line-height: 1;
    cursor: pointer;
    flex-shrink: 0;
    white-space: nowrap;
    box-shadow: inset 0 0 8px rgba(255, 213, 74, 0.14), 0 0 8px rgba(255, 213, 74, 0.18);
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s, transform 0.06s, box-shadow 0.15s;
  }
  .chip:hover:not(:disabled) {
    background: linear-gradient(120deg, rgba(255, 213, 74, 0.3), rgba(255, 213, 74, 0.12));
  }
  .chip:active:not(:disabled) { transform: translateY(1px); }
  /* Locked state: once the first board is played the BREAK chip
     becomes an indicator, not a control. Auto-flip via
     adjustBoard()/adjustSets() drives its side. Muted appearance
     to signal non-interactive; still readable so viewers can
     tell who's breaking this board. */
  .chip-locked {
    cursor: default;
    opacity: 0.7;
    box-shadow: none;
  }

  .chip-lbl { line-height: 1; }

  /* When a pill is in the decided (gold/silver) state, hide its
     sibling BREAK chip and coin so the medal treatment reads clean.
     Match is over — the indicators aren't useful any more. */
  .head-side:has(.head-name.decided) .chip-break,
  .head-side:has(.head-name.decided) .coin-btn { display: none; }

  /*
   * Twin-medal treatment when the match is decided.
   *
   * Structural rules (typography, spacing, ring, glow, shine, medal-bob
   * animation) live on the shared .decided / .medal base classes so gold
   * and silver render identically at the pixel level. The only difference
   * between winner and loser is the palette, fed through custom
   * properties on the .gold / .silver modifiers.
   *
   * If you want to retune the medal treatment (e.g. bigger ring, faster
   * shine), edit .head-name.decided and both sides get it for free.
   */

  /* Palette tokens. Override on .gold and .silver only. */
  .head-name.decided {
    --pill-c1: #fff;
    --pill-c2: #ccc;
    --pill-c3: #888;
    --pill-text: #111;
    --pill-ring: #ccc;
    --pill-glow: rgba(200, 200, 200, 0.5);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #fff;
  }
  .head-name.decided.gold {
    --pill-c1: #ffd54a;
    --pill-c2: #ffb300;
    --pill-c3: #ff8f00;
    --pill-text: #2b1900;
    --pill-ring: #ffd54a;
    --pill-glow: rgba(255, 213, 74, 0.65);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #fff5d5;
  }
  .head-name.decided.silver {
    --pill-c1: #f4f7fa;
    --pill-c2: #b6c2cc;
    --pill-c3: #6a7a86;
    --pill-text: #1a232b;
    --pill-ring: #d1dae0;
    --pill-glow: rgba(209, 218, 224, 0.45);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #eef4f7;
  }
  /* Draw: warm muted bronze tone. Applied to BOTH pills (draws
     have no winner, both sides get the same treatment) so the
     header still reads visually distinct from a live match. */
  .head-name.decided.draw {
    --pill-c1: #d4b489;
    --pill-c2: #b09068;
    --pill-c3: #7a5f42;
    --pill-text: #1f1610;
    --pill-ring: #c9a56f;
    --pill-glow: rgba(201, 165, 111, 0.4);
    --chip-bg: rgba(0, 0, 0, 0.3);
    --chip-text: #fff2df;
  }

  /* Shared pill structure. Applied identically to both variants. */
  .head-name.decided {
    position: relative;
    background: linear-gradient(135deg, var(--pill-c1) 0%, var(--pill-c2) 55%, var(--pill-c3) 100%);
    color: var(--pill-text);
    box-shadow:
      0 0 0 2px var(--pill-ring),
      0 0 22px var(--pill-glow),
      0 3px 12px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }

  /* Shared diagonal shine sweep. Same speed/curve on both pills. */
  .head-name.decided::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      110deg,
      transparent 30%,
      rgba(255, 255, 255, 0.4) 45%,
      rgba(255, 255, 255, 0.65) 50%,
      rgba(255, 255, 255, 0.4) 55%,
      transparent 70%
    );
    transform: translateX(-120%);
    animation: pill-shine 3.5s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes pill-shine {
    0%, 60% { transform: translateX(-120%); }
    100%    { transform: translateX(120%); }
  }

  /* Medal chip: shared shape + typography, chip colours from --chip-*. */
  .head-name .medal {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.12rem 0.5rem 0.12rem 0.25rem;
    border-radius: 999px;
    font-size: 0.68rem;
    font-weight: 900;
    letter-spacing: 0.14em;
    line-height: 1;
    flex-shrink: 0;
    background: var(--chip-bg);
    color: var(--chip-text);
  }
  .head-name .medal-icon {
    font-size: 1.15em;
    line-height: 1;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
    animation: medal-bob 2.4s ease-in-out infinite;
  }
  @keyframes medal-bob {
    0%, 100% { transform: translateY(0) rotate(-4deg); }
    50%      { transform: translateY(-2px) rotate(6deg); }
  }

  .head-mid {
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
  }
  .set-label {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.7rem;
  }

  .set-pips {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.15rem 0.65rem 0.15rem 0.35rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 999px;
    line-height: 1;
  }
  .set-pip {
    width: 0.9rem;
    height: 0.9rem;
    border-radius: 999px;
    border: 2px solid #333;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.55rem;
    font-weight: 800;
    color: #0b0b0b;
    transition: transform 0.15s, box-shadow 0.15s;
  }
  .set-pip.pip-a { background: var(--side-a); border-color: var(--side-a); box-shadow: 0 0 8px rgba(79,195,247,0.4); }
  .set-pip.pip-b { background: var(--side-b); border-color: var(--side-b); box-shadow: 0 0 8px rgba(255,138,101,0.4); }
  .set-pip.pip-current {
    background: transparent;
    border-color: var(--accent);
    box-shadow: 0 0 8px rgba(255,213,74,0.35);
    animation: pip-pulse 1.6s ease-in-out infinite;
  }
  .set-pip.pip-pending { background: transparent; border-color: rgba(255,255,255,0.15); }
  @keyframes pip-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.18); }
  }
  .set-caption {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.65rem;
    margin-left: 0.25rem;
    line-height: 1;
  }

  .board-progress {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.65rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    line-height: 1;
  }
  .board-caption { flex-shrink: 0; }
  .board-track {
    position: relative;
    width: clamp(4rem, 12vw, 7rem);
    height: 0.45rem;
    background: rgba(255,255,255,0.06);
    border-radius: 999px;
    overflow: hidden;
  }
  .board-fill {
    position: absolute;
    inset: 0 auto 0 0;
    background: linear-gradient(90deg, var(--accent), #ffb74d);
    border-radius: 999px;
    transition: width 0.2s ease-out;
  }
  .board-count {
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    color: var(--fg);
    letter-spacing: 0.02em;
  }
  .board-total { color: var(--muted); font-size: 0.7em; margin-left: 0.1rem; }

  .queen-lock {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    text-align: center;
    font-size: 0.8rem;
    color: var(--fg);
    background: linear-gradient(90deg,
      rgba(255, 213, 74, 0.05),
      rgba(255, 213, 74, 0.15) 50%,
      rgba(255, 213, 74, 0.05));
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.5rem;
    padding: 0.3rem 0.75rem;
    letter-spacing: 0.02em;
  }
  .queen-lock .ql-line {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    flex-wrap: wrap;
    justify-content: center;
  }
  .queen-lock .ql-name { font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
  .queen-lock .qa { color: var(--side-a); }
  .queen-lock .qb { color: var(--side-b); }
  .queen-lock .ql-num {
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-weight: 700;
    font-size: 1.05rem;
    color: var(--accent);
    text-shadow: 0 0 6px rgba(255, 213, 74, 0.5);
    margin: 0 0.15rem;
  }
  .queen-lock .ql-sep { color: var(--muted); opacity: 0.6; }
  .queen-lock .ql-trail { color: var(--muted); font-size: 0.75em; margin-left: 0.15rem; }
  .queen-lock .ql-noqueen {
    color: var(--accent);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-size: 0.7rem;
  }

  .grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 1fr 2fr 1.2fr 2fr 1fr;
    gap: 0.4rem;
    background: #0f0f0f;
    padding: 0.5rem 0.4rem;
    border-radius: 0.75rem;
    border: 1px solid #222;
  }
  .col {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    padding: 0.25rem;
    border-radius: 0.5rem;
    cursor: pointer;
    transition: background 0.1s, transform 0.06s;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
    /* Enable container queries on each column so the DSEG7 digits
       inside can scale to the actual column width — not just the
       viewport height. Without this, wide-short windows produce a
       POINTS digit that overflows its coloured pill (see beta bug
       report from 2026-08-08). */
    container-type: inline-size;
  }
  .col:active { transform: scale(0.97); background: rgba(255,255,255,0.06); }
  .col:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    line-height: 1;
    /* Scale to whichever is smaller: viewport-height or ~70% of the
       column width (narrow columns). Prevents single-digit values
       (SET / BOARD) from overflowing when the parent column becomes
       very narrow, and stays vh-driven on typical phone-in-portrait
       windows. */
    font-size: min(clamp(2.8rem, 20vh, 7rem), 70cqi);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
  }
  /* POINTS is the audience's focal point — make it dominate the
     panel. Cap by container width via 55cqi (a 2-glyph "00" needs
     about 2× glyph-width plus gap, and DSEG7 glyphs are ~50% of
     their em box). This is what prevents the digit spilling past
     the coloured pill on wide-short windows, while still filling
     the column on typical portrait phone windows. */
  .digit.big { font-size: min(clamp(4.5rem, 38vh, 14rem), 55cqi); }
  .col.tone-a .digit { color: var(--side-a); text-shadow: 0 0 12px rgba(79,195,247,0.35); }
  .col.tone-b .digit { color: var(--side-b); text-shadow: 0 0 12px rgba(255,138,101,0.35); }
  .mid .digit { color: var(--accent); text-shadow: 0 0 12px rgba(255,213,74,0.35); }
  .label {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.6rem;
  }

  .foot {
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding: 0.2rem 0.35rem;
    border-top: 1px solid rgba(255,255,255,0.06);
    min-height: 2.25rem;
    max-height: 3rem;
    overflow: hidden;
  }
  .hint {
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }
  .hint-sep { opacity: 0.4; margin: 0 0.3rem; }
  /*
   * Version chip: same sans-serif family as the rest of the app so it reads
   * as UI type, not seven-segment. Highlighted with a soft accent pill so
   * the number is glanceable at broadcast distance.
   */
  .hint-ver {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 999px;
    color: var(--accent);
    font-family: inherit;
    font-weight: 700;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    line-height: 1;
    vertical-align: baseline;
    /* Version-pill is now an anchor to the release notes on GitHub.
       Kill the default underline; a subtle hover-brighten hints
       tappability without competing with the rest of the footer. */
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  }
  .hint-ver:hover {
    background: rgba(255, 213, 74, 0.22);
    border-color: rgba(255, 213, 74, 0.55);
  }
  .winner {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0.75rem 0.25rem 0.5rem;
    border-radius: 999px;
    background: linear-gradient(90deg, rgba(79,195,247,0.18), rgba(255,138,101,0.18));
    color: var(--fg);
    font-size: 0.8rem;
    letter-spacing: 0.02em;
  }
  .winner strong { color: var(--accent); letter-spacing: 0.04em; }
  .winner-dot {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
    animation: winner-pulse 1.6s ease-in-out infinite;
  }
  @keyframes winner-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.6; transform: scale(1.18); }
  }

  .foot-actions { display: flex; gap: 0.4rem; }
  .foot-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: #141414;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    padding: 0.35rem 0.85rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.1s, transform 0.06s, border-color 0.15s;
  }
  .foot-btn:active { transform: translateY(1px); background: #1c1c1c; }
  .foot-btn:disabled { opacity: 0.35; cursor: not-allowed; }
  .foot-ico { font-size: 0.95rem; line-height: 1; }
  .foot-lbl { letter-spacing: 0.04em; }

  .foot-btn.swap { border-color: rgba(79,195,247,0.4); color: var(--side-a); }
  .foot-btn.reset { border-color: rgba(255,213,74,0.4); color: var(--accent); }
  .foot-btn.endm { border-color: rgba(76,175,80,0.5); color: #66bb6a; }
  .foot-btn.close { border-color: rgba(239,83,80,0.4); color: var(--danger); }

  /* Tight-height layout tweaks — labels stay visible (landscape has
     room); only the button padding and hint size get trimmed. */
  @media (max-height: 500px) {
    .foot-btn { padding: 0.3rem 0.65rem; font-size: 0.72rem; }
    .foot-ico { font-size: 0.9rem; }
    .foot { min-height: 2rem; padding: 0.15rem 0.35rem; }
    .hint { font-size: 0.65rem; }
    .winner { font-size: 0.72rem; padding: 0.15rem 0.6rem 0.15rem 0.4rem; }
  }

  .dialog {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }
  .dialog-card {
    background: #141414;
    border: 2px solid var(--accent);
    border-radius: 1rem;
    padding: 1.25rem;
    max-width: 22rem;
    width: 100%;
    text-align: center;
    position: relative;
  }
  .dialog-card.exit { border-color: var(--danger); }

  /* Top-right close for dialogs that need it (winner popup +
     scorecard recap). Matches the /live/ lobby's popup close. */
  .dialog-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 2;
    width: 2rem;
    height: 2rem;
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.12);
    color: var(--fg);
    border-radius: 999px;
    font-size: 0.95rem;
    line-height: 1;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
  }
  .dialog-close:hover {
    background: rgba(255,255,255,0.12);
    border-color: rgba(255,255,255,0.24);
  }

  /* Scorecard modal — wider than the confirmation dialogs so the
     recap table has room to breathe. Vertical scroll on tall
     content (multi-set matches). */
  .scorecard-dialog { padding: 0.75rem; }
  .scorecard-card {
    max-width: 42rem;
    width: 100%;
    max-height: 90dvh;
    overflow-y: auto;
    padding: 0.9rem 0.9rem 1rem;
    text-align: left;
  }
  /* "Fix this match" admin surface at the bottom of the scorecard
     modal. Only rendered for authorised users (super OR organiser
     of the match's tournament). Kept muted so it doesn't compete
     with the recap table. */
  .scorecard-admin {
    margin-top: 0.9rem;
    padding-top: 0.9rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    display: flex;
    justify-content: flex-end;
  }
  .fix-btn {
    background: rgba(255, 213, 74, 0.14);
    color: var(--accent);
    border: 1px solid rgba(255, 213, 74, 0.45);
    border-radius: 999px;
    padding: 0.45rem 0.95rem;
    font-weight: 700;
    font-size: 0.82rem;
    letter-spacing: 0.02em;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.12s, border-color 0.12s;
  }
  .fix-btn:hover {
    background: rgba(255, 213, 74, 0.24);
    border-color: rgba(255, 213, 74, 0.7);
  }
  .dialog-card h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .dialog-card.exit h2 { color: var(--danger); }
  .dialog-card .who { margin: 0 0 1rem; font-size: 1rem; }
  .dialog-actions { display: flex; gap: 0.5rem; }
  .dialog-actions .cancel, .dialog-actions .danger {
    flex: 1;
    padding: 0.6rem 1rem;
    font-weight: 700;
    border-radius: 999px;
    cursor: pointer;
    border: none;
    font-size: 0.95rem;
  }
  .dialog-actions .cancel { background: #1f1f1f; color: var(--fg); border: 1px solid #333; }
  .dialog-actions .danger { background: var(--danger); color: #0b0b0b; }

  /*
   * Winner popup with fireworks. Fireworks are pure CSS: 20 <span>s each
   * with its own hue, offset, and delay, using a single keyframe that
   * fires them outward from the centre of the screen. No canvas / no JS
   * animation loop — cheap and durable.
   */
  .winner-dialog { padding: 1.5rem; }
  .winner-dialog .dialog-card.champion {
    background: linear-gradient(160deg, #1a1a1a 0%, #141414 100%);
    border: 3px solid var(--accent);
    box-shadow:
      0 0 0 1px rgba(255, 213, 74, 0.35),
      0 0 60px rgba(255, 213, 74, 0.35),
      0 12px 40px rgba(0, 0, 0, 0.6);
    padding: 2rem 1.5rem 1.5rem;
    max-width: 28rem;
    position: relative;
    z-index: 2;
    overflow: hidden;
  }
  /* Draw variant of the dialog: muted bronze border, no gold glow.
     ::before shine sweep is neutralised so the card reads calm
     rather than celebratory. */
  .winner-dialog .dialog-card.champion.draw {
    border-color: #c9a56f;
    box-shadow:
      0 0 0 1px rgba(201, 165, 111, 0.35),
      0 0 40px rgba(201, 165, 111, 0.2),
      0 12px 40px rgba(0, 0, 0, 0.6);
  }
  .winner-dialog .dialog-card.champion.draw::before { display: none; }
  .winner-dialog .dialog-card.champion.draw .champ-label { color: #d4b489; }
  .winner-dialog .dialog-card.champion::before {
    /* Diagonal shine sweep across the card, once every few seconds. */
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      110deg,
      transparent 30%,
      rgba(255, 213, 74, 0.18) 45%,
      rgba(255, 255, 255, 0.28) 50%,
      rgba(255, 213, 74, 0.18) 55%,
      transparent 70%
    );
    transform: translateX(-120%);
    animation: champ-shine 3.2s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes champ-shine {
    0%, 55% { transform: translateX(-120%); }
    100%    { transform: translateX(120%); }
  }
  .champ-trophy {
    font-size: 4rem;
    line-height: 1;
    filter: drop-shadow(0 4px 12px rgba(255, 213, 74, 0.5));
    animation: champ-trophy 2s ease-in-out infinite;
  }
  @keyframes champ-trophy {
    0%, 100% { transform: translateY(0) rotate(-4deg) scale(1); }
    50%      { transform: translateY(-6px) rotate(4deg) scale(1.05); }
  }
  .champ-label {
    color: var(--accent);
    font-size: 0.8rem;
    letter-spacing: 0.35em;
    font-weight: 800;
    margin-top: 0.75rem;
    text-shadow: 0 0 12px rgba(255, 213, 74, 0.5);
  }
  .champ-name {
    font-size: clamp(1.5rem, 6vw, 2.5rem);
    font-weight: 900;
    color: var(--fg);
    letter-spacing: -0.01em;
    margin: 0.4rem 0 0.75rem;
    text-shadow: 0 2px 8px rgba(0, 0, 0, 0.6);
  }
  .champ-score {
    color: var(--muted);
    font-size: 0.95rem;
    letter-spacing: 0.02em;
    margin-bottom: 1.5rem;
  }
  .champ-score strong {
    color: var(--fg);
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    letter-spacing: 0.03em;
    padding: 0 0.15rem;
  }
  .champ-sep { color: var(--muted); opacity: 0.4; margin: 0 0.35rem; }
  .confirm-big {
    background: var(--accent);
    color: #0b0b0b;
    border: 0;
    border-radius: 999px;
    padding: 0.8rem 1.5rem;
    font-weight: 800;
    font-size: 1rem;
    letter-spacing: 0.04em;
    cursor: pointer;
    box-shadow: 0 4px 14px rgba(255, 213, 74, 0.35);
    transition: transform 0.1s;
  }
  .confirm-big:active { transform: translateY(1px); }
  /* Two-button chooser variant for the at-maxBoards draw prompt.
     Primary stays gold ("Play deciding board" is the more decisive
     act); secondary reads as an outlined muted button so the umpire
     picks intentionally. Row wraps to a column on narrow phones. */
  .champ-choice {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: center;
    margin-top: 0.2rem;
  }
  .champ-choice .confirm-big { flex: 1 1 auto; min-width: 12rem; padding: 0.7rem 1.1rem; }
  .confirm-secondary {
    background: transparent !important;
    color: var(--fg, #f5f5f5) !important;
    border: 1.5px solid rgba(255, 213, 74, 0.5) !important;
    box-shadow: none !important;
  }
  .confirm-secondary:hover { background: rgba(255, 213, 74, 0.08) !important; }
  .champ-choice-hint {
    margin: 0.1rem 0 0.4rem;
    text-align: center;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    line-height: 1.4;
  }

  /* Deciding-board banner. Muted amber, single line, sits above the
     scoreboard header. Doesn't compete with the pills but is
     unmistakably visible so umpire + spectators know this isn't a
     normal board. */
  .decider-banner {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.75rem;
    margin: 0 auto 0.5rem;
    max-width: 32rem;
    background: rgba(255, 183, 77, 0.12);
    border: 1px solid rgba(255, 183, 77, 0.4);
    border-radius: 999px;
    color: #ffb74d;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .fireworks {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 1;
    overflow: hidden;
  }
  .spark {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    opacity: 0;
    /* Each spark reads --n (its index 0..19), spreads its own launch
       angle and delay from that number. --tx/--ty are the target offsets
       set below by nth-child. */
    animation: burst 2.2s ease-out infinite;
    animation-delay: calc(var(--n) * 0.11s);
  }
  /* 8 colour classes cycle through the deck; enough that adjacent sparks
     differ but the palette stays tight. */
  .spark-0 { background: #ffd54a; box-shadow: 0 0 16px 4px rgba(255,213,74,0.7); }
  .spark-1 { background: #ff6b6b; box-shadow: 0 0 16px 4px rgba(255,107,107,0.7); }
  .spark-2 { background: #4fc3f7; box-shadow: 0 0 16px 4px rgba(79,195,247,0.7); }
  .spark-3 { background: #66bb6a; box-shadow: 0 0 16px 4px rgba(102,187,106,0.7); }
  .spark-4 { background: #ba68c8; box-shadow: 0 0 16px 4px rgba(186,104,200,0.7); }
  .spark-5 { background: #ffb74d; box-shadow: 0 0 16px 4px rgba(255,183,77,0.7); }
  .spark-6 { background: #ff8a65; box-shadow: 0 0 16px 4px rgba(255,138,101,0.7); }
  .spark-7 { background: #f06292; box-shadow: 0 0 16px 4px rgba(240,98,146,0.7); }
  /* Angles for the 20 particles, spread around a full circle. Distances
     mix short + long so the burst has depth. */
  .spark:nth-child(1)  { --tx:  240px; --ty: -140px; }
  .spark:nth-child(2)  { --tx: -260px; --ty:   40px; }
  .spark:nth-child(3)  { --tx:  100px; --ty:  280px; }
  .spark:nth-child(4)  { --tx: -180px; --ty: -240px; }
  .spark:nth-child(5)  { --tx:  300px; --ty:   60px; }
  .spark:nth-child(6)  { --tx:  -60px; --ty:  300px; }
  .spark:nth-child(7)  { --tx: -300px; --ty: -100px; }
  .spark:nth-child(8)  { --tx:  180px; --ty: -260px; }
  .spark:nth-child(9)  { --tx:  260px; --ty:  180px; }
  .spark:nth-child(10) { --tx: -220px; --ty:  200px; }
  .spark:nth-child(11) { --tx:   40px; --ty: -320px; }
  .spark:nth-child(12) { --tx: -120px; --ty: -280px; }
  .spark:nth-child(13) { --tx:  320px; --ty:  -60px; }
  .spark:nth-child(14) { --tx: -280px; --ty:  120px; }
  .spark:nth-child(15) { --tx:   80px; --ty:  320px; }
  .spark:nth-child(16) { --tx:  200px; --ty:  240px; }
  .spark:nth-child(17) { --tx: -240px; --ty: -180px; }
  .spark:nth-child(18) { --tx:  340px; --ty:   20px; }
  .spark:nth-child(19) { --tx: -100px; --ty:  340px; }
  .spark:nth-child(20) { --tx:  140px; --ty: -320px; }

  @keyframes burst {
    0% {
      opacity: 0;
      transform: translate(-50%, -50%) scale(0.4);
    }
    10% {
      opacity: 1;
      transform: translate(-50%, -50%) scale(1.6);
    }
    100% {
      opacity: 0;
      transform: translate(calc(-50% + var(--tx, 0)), calc(-50% + var(--ty, 0))) scale(0.5);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    /* Accessibility: no explosions. Just fade the sparks in place. */
    .spark, .champ-trophy, .winner-dialog .dialog-card.champion::before {
      animation: none;
    }
    .spark { opacity: 0.55; }
  }

  /*
   * Practice mode: solo drill. Grid is rows = sets, cols = boards; each
   * cell is a swipeAdjust digit. No colour split — the palette stays the
   * accent yellow so the whole grid reads as one continuous session.
   */
  .practice-set-marker {
    color: var(--accent);
    font-weight: 800;
    font-size: 0.85rem;
    letter-spacing: 0.06em;
    margin-left: 0.3rem;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.35);
  }
  /* Grid instead of flex so the two side buttons and centre pip cluster
     never drift off-centre: the pip container is centred in a full-width
     middle track, and the two side tracks are equal-width mirrors of
     each other. */
  .practice-pager {
    flex-shrink: 0;
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    padding: 0.15rem 0;
  }
  .practice-pager > .practice-pager-btn:first-child { justify-self: end; margin-right: 0.9rem; }
  .practice-pager > .practice-pager-btn:last-child { justify-self: start; margin-left: 0.9rem; }
  .practice-pager > .practice-pager-pips { justify-self: center; }
  .practice-pager-btn { padding: 0.35rem 0.85rem; }
  .practice-pager-btn:disabled { opacity: 0.3; }
  .practice-pager-pips {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
  }
  .pager-pip {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 999px;
    background: rgba(255,255,255,0.12);
    transition: background 0.15s, transform 0.15s;
  }
  .pager-pip-current {
    background: var(--accent);
    transform: scale(1.25);
    box-shadow: 0 0 8px rgba(255, 213, 74, 0.5);
  }
  .pager-pip-btn {
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .practice-board-chips {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.25rem 0;
  }
  .pchip {
    background: #141414;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 999px;
    padding: 0.3rem 0.85rem;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background 0.1s, color 0.15s, border-color 0.15s;
  }
  .pchip:hover { border-color: #3a3a3a; }
  .pchip:active { background: #1c1c1c; }
  .pchip-current {
    background: rgba(255, 213, 74, 0.14);
    color: var(--accent);
    border-color: rgba(255, 213, 74, 0.45);
    box-shadow: 0 0 8px rgba(255, 213, 74, 0.25);
  }

  .practice-total-line {
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .practice-total-num {
    color: var(--accent);
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-weight: 700;
    font-size: 1.1rem;
    margin-left: 0.25rem;
    text-shadow: 0 0 8px rgba(255, 213, 74, 0.35);
  }

  /* Practice score row: SET flank + scrollable middle + TOTAL flank.
     Middle is a scroll container laid out at (all boards) × 100/visible%
     so PRACTICE_BOARDS_VISIBLE cells fit the viewport, rest scroll. */
  .practice-grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 4rem 1fr 5rem;
    gap: 0.4rem;
    background: #0f0f0f;
    padding: 0.5rem;
    border-radius: 0.75rem;
    border: 1px solid #222;
  }
  .pflank {
    display: grid;
    grid-template-rows: 1.5rem 1fr;
    align-items: center;
    justify-items: center;
    min-height: 0;
  }
  .pth {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .pth-set, .pth-total { color: var(--accent); }
  .prow-label,
  .prow-total-num {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    line-height: 1;
  }
  .pset-num {
    font-size: 2.8rem;
    color: var(--accent);
    text-shadow: 0 0 10px rgba(255, 213, 74, 0.4);
  }
  .prow-total-num {
    font-size: 2.2rem;
    color: var(--fg);
  }
  .pscroll {
    display: grid;
    grid-template-rows: 1.5rem 1fr;
    row-gap: 0.4rem;
    overflow-x: auto;
    overflow-y: hidden;
    min-width: 0;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
  }
  .pscroll::-webkit-scrollbar { display: none; }
  .pscroll-head,
  .pscroll-row {
    /* Grid of `board-count` cells laid out so exactly `visible` fit
       inside .pscroll (the scroller's viewport slot) with the same
       0.4rem inter-cell gap. Trick: give each track a fixed width of
       `1/visible` of the SCROLLER, minus its share of the gap so the
       gap doesn't push cells off the right edge.
         cell-width = (100% - (visible-1) * gap) / visible
       No outer width override — `grid-auto-flow: column` lets the row
       expand horizontally past the scroller for board-count > visible,
       which is exactly the scrollable overflow we want. */
    --gap: 0.4rem;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: calc((100% - (var(--visible, 4) - 1) * var(--gap)) / var(--visible, 4));
    column-gap: var(--gap);
  }
  .pscroll-head { align-items: center; }
  .pscroll-row > .pcell { scroll-snap-align: start; }
  .pcell {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Very light card treatment: subtle inner fill + soft warm border so
       each B-column is a distinct rounded tile. Anchors the digit inside
       its cell and reinforces the tap target without competing with the
       digits themselves. */
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 213, 74, 0.14);
    border-radius: 0.6rem;
    color: inherit;
    cursor: pointer;
    padding: 0.1rem;
    min-width: 0;
    overflow: hidden;
    /* Container query so the digit can size to whichever dimension of
       the cell is tighter — the tallest row-height that also fits two
       digits horizontally. Robust across every (sets × boards) shape. */
    container-type: size;
    touch-action: none;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.1s, transform 0.06s, border-color 0.15s;
  }
  .pcell:hover { border-color: rgba(255, 213, 74, 0.28); }
  .pcell:active {
    transform: scale(0.97);
    background: rgba(255, 213, 74, 0.06);
    border-color: rgba(255, 213, 74, 0.4);
  }
  .pcell:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .pdigit {
    color: var(--accent);
    text-shadow: 0 0 12px rgba(255, 213, 74, 0.35);
    /* Fill the cell: whichever of (cell height) or (~half cell width for
       2 digits) is smaller. min() picks the fitting axis so digits never
       overflow — regardless of sets × boards or viewport aspect. */
    font-size: min(100cqh, 55cqw);
    line-height: 1;
  }

  .practice-recap {
    max-width: 32rem;
  }
  .practice-recap-title {
    color: var(--accent);
    font-size: 0.75rem;
    letter-spacing: 0.35em;
    font-weight: 800;
  }
  .practice-recap-name {
    font-size: clamp(1.25rem, 5vw, 1.8rem);
    font-weight: 900;
    color: var(--fg);
    margin: 0.3rem 0 1rem;
  }
  .practice-recap-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
    margin-bottom: 1.25rem;
  }
  .practice-recap-table th,
  .practice-recap-table td {
    padding: 0.35rem 0.4rem;
    font-size: 0.85rem;
    text-align: center;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .practice-recap-table th {
    color: var(--muted);
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .practice-recap-table td { color: var(--fg); font-family: 'DSEG7 Classic', 'Courier New', monospace; }
  .practice-recap-table .rc-set { color: var(--muted); font-family: inherit; font-weight: 700; }
  .practice-recap-table .rc-total { color: var(--accent); font-weight: 700; }
  .practice-recap-table .rc-grand {
    color: var(--accent);
    font-weight: 800;
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-size: 1.05rem;
    text-shadow: 0 0 8px rgba(255, 213, 74, 0.35);
  }
  .practice-recap-table tfoot .rc-set {
    text-align: right;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
    color: var(--muted);
  }
</style>
