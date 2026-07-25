<script lang="ts">
  import { onMount } from 'svelte';
  import '@fontsource/dseg7-classic/700.css';
  import {
    DEFAULT_CONFIG,
    decodeConfig,
    evaluateSetEnd,
    matchStateKey,
    setLeader,
    teamLabel,
    type MatchConfig,
  } from '../lib/match';

  type Side = { name: string; sets: number; points: number };
  /*
   * Colour tokens follow the player, not the seat. When players swap sides,
   * the colour swaps with the name so the same person keeps their pill/digit
   * colour throughout the match. Defaults match CSS vars --side-a / --side-b.
   */
  type Colour = 'a' | 'b';

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<Side>({ name: 'First Player', sets: 0, points: 0 });
  let sideB = $state<Side>({ name: 'Second Player', sets: 0, points: 0 });
  // Which colour token is painted on each seat. Flipped by swapSides().
  let colourA = $state<Colour>('a');
  let colourB = $state<Colour>('b');
  let board = $state(0);
  let boardsThisSet = $state(0);

  /*
   * currentSet is derived from actual sets won, so manual SET +/- swipes
   * keep the caption in sync. It's simply (setsA + setsB + 1), capped at
   * bestOf. When the match is decided we stop advancing.
   */
  const currentSet = $derived(Math.min(cfg.bestOf, sideA.sets + sideB.sets + 1));
  let setStartedAt = $state<number | null>(null);
  let now = $state(Date.now());
  /*
   * Match result:
   *   'a' | 'b' — a side won the required number of sets
   *   'draw'   — the final set ended tied (equal points, boards fully played)
   *              tournaments count this as 0.5 match points each side
   *   null     — undecided
   */
  let matchResult = $state<'a' | 'b' | 'draw' | null>(null);
  let confirmExit = $state(false);
  let isPortrait = $state(false);
  let storageKey = $state<string | null>(null);

  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    cfg = decodeConfig(q);
    sideA.name = teamLabel(cfg.playerA, cfg.playerA2, cfg.mode) || 'First Player';
    sideB.name = teamLabel(cfg.playerB, cfg.playerB2, cfg.mode) || 'Second Player';
    storageKey = matchStateKey(q.get('playerA') ?? '', q.get('playerB') ?? '');

    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const s = JSON.parse(raw);
        if (typeof s?.sideA?.points === 'number') sideA.points = s.sideA.points;
        if (typeof s?.sideB?.points === 'number') sideB.points = s.sideB.points;
        if (typeof s?.sideA?.sets === 'number') sideA.sets = s.sideA.sets;
        if (typeof s?.sideB?.sets === 'number') sideB.sets = s.sideB.sets;
        if (typeof s?.board === 'number') board = s.board;
        if (typeof s?.boardsThisSet === 'number') boardsThisSet = s.boardsThisSet;
        // currentSet is derived from sideA.sets + sideB.sets, not persisted.
        if (typeof s?.setStartedAt === 'number' || s?.setStartedAt === null) setStartedAt = s.setStartedAt;
      }
    } catch {
      // ignore
    }

    updateOrientation();
    tryLockLandscape();
    requestWakeLock();

    const tick = setInterval(() => (now = Date.now()), 1000);
    window.addEventListener('resize', updateOrientation);
    window.addEventListener('orientationchange', updateOrientation);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(tick);
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      releaseWakeLock();
      releaseLandscape();
    };
  });

  /**
   * Screen Wake Lock. Keeps the phone screen from dimming/locking during a
   * match. Android drops the lock when the tab is backgrounded, so we
   * re-request on visibilitychange when we come back to the foreground.
   * iOS Safari doesn't yet support Wake Lock; the API silently no-ops there.
   */
  type WakeLockSentinelLike = { release: () => Promise<void> };
  let wakeLock: WakeLockSentinelLike | null = null;

  async function requestWakeLock() {
    const wl = (navigator as unknown as { wakeLock?: { request: (type: string) => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    try {
      wakeLock = await wl.request('screen');
    } catch {
      // Browser refused (unsupported, permission denied, tab not visible)
    }
  }
  async function releaseWakeLock() {
    if (!wakeLock) return;
    try {
      await wakeLock.release();
    } catch {
      // ignore
    }
    wakeLock = null;
  }
  function onVisibilityChange() {
    if (document.visibilityState === 'visible' && !wakeLock) {
      requestWakeLock();
    }
  }

  $effect(() => {
    if (!storageKey) return;
    const s = {
      sideA: { points: sideA.points, sets: sideA.sets },
      sideB: { points: sideB.points, sets: sideB.sets },
      board,
      boardsThisSet,
      setStartedAt,
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(s));
    } catch {
      // ignore
    }
  });

  function updateOrientation() {
    isPortrait = window.innerHeight > window.innerWidth;
  }

  /**
   * Landscape lock. Bubblewrap TWAs run in fullscreen so this succeeds;
   * PWAs / regular browser tabs need to enter fullscreen first (best-effort).
   * iOS Safari refuses in all cases — we fall back to the rotate-hint overlay.
   */
  let attemptedLandscapeLock = false;
  async function tryLockLandscape() {
    if (attemptedLandscapeLock) return;
    attemptedLandscapeLock = true;
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        await el.requestFullscreen().catch(() => {});
      }
      const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } }).orientation;
      if (so?.lock) await so.lock('landscape');
    } catch {
      // silent
    }
  }

  /**
   * On Close / unmount, actively lock the device to portrait so Android
   * physically rotates back before we navigate. Setup then calls unlock()
   * on load, freeing rotation. A plain unlock() alone is not enough: the
   * OS keeps the current physical orientation until something asks for a
   * different one.
   */
  async function releaseLandscape() {
    try {
      const so = (screen as unknown as {
        orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void };
      }).orientation;
      // Attempt portrait lock while we still hold the fullscreen context
      // that made lock() legal on the way in.
      if (so?.lock) {
        await so.lock('portrait').catch(() => {});
      }
    } catch {
      // silent
    }
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        await document.exitFullscreen().catch(() => {});
      }
    } catch {
      // silent
    }
  }

  const elapsedSeconds = $derived(setStartedAt === null ? 0 : Math.floor((now - setStartedAt) / 1000));

  function markStartedIfIdle() {
    if (setStartedAt === null) setStartedAt = Date.now();
  }

  /*
   * Only the transient set-end dialog blocks input. Once a match is won,
   * scoring stays fully enabled — the winner banner in the footer signals
   * the state and organisers may keep adjusting (players can play more
   * sets, corrections happen, etc). Nothing should ever hide the score.
   */
  function adjustPoints(side: 'a' | 'b', delta: number) {
    if (delta > 0) markStartedIfIdle();
    const s = side === 'a' ? sideA : sideB;
    // Points are clamped to [0, pointsTarget]. Standard match caps at 25.
    s.points = Math.min(cfg.pointsTarget, Math.max(0, s.points + delta));
    checkSetEnd();
  }
  function adjustSets(side: 'a' | 'b', delta: number) {
    const s = side === 'a' ? sideA : sideB;
    // Sets are clamped to [0, bestOf]. A match can never award more than
    // bestOf sets to a single side. Standard India match tops at 3.
    s.sets = Math.min(cfg.bestOf, Math.max(0, s.sets + delta));
    checkMatchResult();
  }
  function adjustBoard(delta: number) {
    if (delta > 0) markStartedIfIdle();
    const nextBoard = board + delta;
    // Board count has no upper cap — draws or sudden-death rounds mean a
    // set can legitimately run past cfg.maxBoards. Only floor is enforced.
    if (nextBoard < 0) return;
    board = nextBoard;
    boardsThisSet = Math.max(0, boardsThisSet + delta);
    checkSetEnd();
  }

  /*
   * When a set-end condition is hit (25 points reached, 8 boards played, or
   * per-set time expired), we silently:
   *   - award the set to the leader (if any),
   *   - detect a draw if this was the final set and points are tied,
   *   - zero out points/board/timer so the next set starts fresh.
   * No dialog. The score screen stays untouched — audience keeps reading
   * the numbers. Set counter ticks up as the only "notification".
   */
  function checkSetEnd() {
    const reason = evaluateSetEnd({
      pointsA: sideA.points,
      pointsB: sideB.points,
      boardsPlayed: boardsThisSet,
      elapsedSeconds,
      cfg,
    });
    if (!reason) return;

    const leader = setLeader(sideA.points, sideB.points);
    const isFinalSet = sideA.sets + sideB.sets + 1 >= cfg.bestOf;

    if (leader === 'a') sideA.sets += 1;
    else if (leader === 'b') sideB.sets += 1;
    else if (isFinalSet) matchResult = 'draw';
    // (Tied non-final set: no side awarded. Organiser can adjust SET manually
    // if a tie-breaker was played off-scoreboard.)

    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    boardsThisSet = 0;
    setStartedAt = null;
    checkMatchResult();
  }

  $effect(() => {
    if (matchResult) return;
    if (cfg.minutesPerSet === null) return;
    if (setStartedAt === null) return;
    if (elapsedSeconds >= cfg.minutesPerSet * 60) checkSetEnd();
  });

  /**
   * Reset every score to zero but keep player names + match config. Used
   * after the match is decided so the players can play another match with
   * the same setup without going back to the setup screen. Also clears
   * the persistent match-winner banner state.
   */
  function resetScores() {
    sideA.sets = 0;
    sideB.sets = 0;
    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    boardsThisSet = 0;
    setStartedAt = null;
    matchResult = null;
    // Reset colours to their default pairing (A→a, B→b) too, so a fresh
    // match starts visually identical every time regardless of swaps in the
    // previous match. currentSet is derived; auto-becomes 1 when sets go to 0.
    colourA = 'a';
    colourB = 'b';
  }
  let confirmReset = $state(false);
  function requestReset() {
    if (!hasProgress) return; // nothing to reset
    confirmReset = true;
  }

  function checkMatchResult() {
    const needed = Math.floor(cfg.bestOf / 2) + 1;
    if (sideA.sets >= needed) {
      matchResult = 'a';
    } else if (sideB.sets >= needed) {
      matchResult = 'b';
    } else {
      // Draw is latched by checkSetEnd() when the final set ends tied, not
      // recomputed here. Only clear the result if neither side won yet AND
      // no draw was previously latched.
      if (matchResult !== 'draw') matchResult = null;
    }
  }

  function swapSides() {
    const tmpName = sideA.name;
    sideA.name = sideB.name;
    sideB.name = tmpName;
    const tmpSets = sideA.sets;
    sideA.sets = sideB.sets;
    sideB.sets = tmpSets;
    const tmpColour = colourA;
    colourA = colourB;
    colourB = tmpColour;
    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    boardsThisSet = 0;
    setStartedAt = null;
  }

  const hasProgress = $derived(
    sideA.points > 0 || sideB.points > 0 || sideA.sets > 0 || sideB.sets > 0 || board > 0 || boardsThisSet > 0,
  );

  function requestExit() {
    if (!hasProgress) return exit();
    confirmExit = true;
  }
  async function exit() {
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
    // Ask the OS to rotate to portrait before we navigate. Setup page then
    // unlocks orientation on load. Awaiting the lock call gives the OS a
    // beat to actually rotate; otherwise setup can flash landscape first.
    await releaseLandscape();
    window.location.href = import.meta.env.BASE_URL;
  }

  /**
   * Svelte action: change a numeric field by horizontal swipe or tap.
   *   - swipe LEFT  (>= SWIPE_PX)  → onDelta(+1)
   *   - swipe RIGHT (>= SWIPE_PX)  → onDelta(-1)
   *   - plain tap (no horizontal movement > threshold) → onDelta(+1)
   *
   * On phones we intentionally allow the swipe to fire repeatedly during a
   * single continuous drag: cross the threshold once → +1, keep dragging
   * another SWIPE_PX in the same direction → +1 again. Makes big
   * corrections one-gesture-only.
   */
  function swipeAdjust(node: HTMLElement, opts: { onDelta: (d: 1 | -1) => void }) {
    const SWIPE_PX = 32;
    let startX = 0;
    let startY = 0;
    let lastFireX = 0;
    let active = false;
    let didSwipe = false;

    function onPointerDown(ev: PointerEvent) {
      // Only handle primary pointer (ignore right-clicks, multi-touch beyond 1st).
      if (!ev.isPrimary) return;
      active = true;
      didSwipe = false;
      startX = ev.clientX;
      startY = ev.clientY;
      lastFireX = ev.clientX;
      // pointer capture keeps events flowing to us even if the finger drifts
      // out of the button's bounding box mid-swipe.
      try { node.setPointerCapture?.(ev.pointerId); } catch { /* ignore */ }
    }
    function onPointerMove(ev: PointerEvent) {
      if (!active) return;
      const totalDx = ev.clientX - startX;
      const totalDy = ev.clientY - startY;
      // Suppress if the gesture is trending more vertical than horizontal.
      if (Math.abs(totalDx) < Math.abs(totalDy)) return;
      // Fire once per SWIPE_PX of horizontal travel from the last fire point.
      const stepDx = ev.clientX - lastFireX;
      if (Math.abs(stepDx) < SWIPE_PX) return;
      didSwipe = true;
      lastFireX = ev.clientX;
      // Swipe LEFT (stepDx < 0) → +1. Swipe RIGHT → -1.
      opts.onDelta(stepDx < 0 ? 1 : -1);
    }
    function onPointerUp() {
      // Simple tap (no horizontal travel) still adds 1.
      if (active && !didSwipe) opts.onDelta(1);
      active = false;
      didSwipe = false;
    }
    function onPointerCancel() {
      active = false;
      didSwipe = false;
    }

    // touchstart with preventDefault stops the browser from starting its own
    // scroll/edge-swipe gesture on Chrome Android.
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

  const timerText = $derived(() => {
    if (cfg.minutesPerSet === null) return null;
    const remaining = Math.max(0, cfg.minutesPerSet * 60 - elapsedSeconds);
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    return `${pad2(mm)}:${pad2(ss)}`;
  });

  const ordinal = (n: number) => (['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][n - 1] ?? `${n}th`);
  /**
   * Per-set-slot indicator: filled with the winner's side colour, or shown
   * as the "current" pip (accent-outlined) or a pending empty pip.
   *   'a' → filled with side-a colour
   *   'b' → filled with side-b colour
   *   'current' → outlined in accent, pulsing
   *   'pending' → empty muted outline
   */
  type SetPip = 'a' | 'b' | 'current' | 'pending';
  const setPips = $derived<SetPip[]>(() => {
    // Total pip slots is always exactly bestOf. Sets can't go beyond bestOf
    // (adjustSets clamps them), and we never grow the pip strip past the
    // configured match length.
    const total = cfg.bestOf;
    // Filled slots for sets already won. Order isn't tracked, so we simply
    // fill A's wins first then B's — visually reads as "how many pips of
    // each colour", which is what matters.
    const aWins = Math.min(sideA.sets, total);
    const bWins = Math.min(sideB.sets, Math.max(0, total - aWins));
    const pips: SetPip[] = [];
    for (let i = 0; i < aWins; i += 1) pips.push('a');
    for (let i = 0; i < bWins; i += 1) pips.push('b');
    const completed = pips.length;
    for (let i = completed; i < total; i += 1) {
      // If the match is decided (or drawn), don't show a "current" pulsing
      // pip — nothing is currently being played.
      const isCurrent = i === completed && !matchResult;
      pips.push(isCurrent ? 'current' : 'pending');
    }
    return pips;
  });

  const queenLockedA = $derived(sideA.points >= 22);
  const queenLockedB = $derived(sideB.points >= 22);
</script>

<section class="wrap">
  <div class="rotate-hint" aria-hidden="true">
    <div class="rotate-card">
      <div class="rotate-icon">📱</div>
      <strong>Rotate your phone</strong>
      <span>Carromscore is a landscape scoreboard.</span>
    </div>
  </div>

  <header class="head">
    <div class="head-name head-a tone-{colourA}"
         class:winner={matchResult === 'a'}
         class:draw={matchResult === 'draw'}>
      {#if matchResult === 'a'}<span class="trophy" aria-hidden="true">🏆</span>{/if}
      {#if matchResult === 'draw'}<span class="draw-badge" aria-hidden="true">½</span>{/if}
      {sideA.name}
    </div>
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
      <div class="board-progress" aria-label="Board {boardsThisSet} of {cfg.maxBoards}">
        <span class="board-caption">BOARD</span>
        <span class="board-track">
          <span class="board-fill" style="width: {Math.min(100, (boardsThisSet / cfg.maxBoards) * 100)}%"></span>
        </span>
        <span class="board-count">{boardsThisSet}<span class="board-total">/{cfg.maxBoards}</span></span>
      </div>
      {#if timerText()}<div class="head-timer">{timerText()}</div>{/if}
    </div>
    <div class="head-name head-b tone-{colourB}"
         class:winner={matchResult === 'b'}
         class:draw={matchResult === 'draw'}>
      {sideB.name}
      {#if matchResult === 'b'}<span class="trophy" aria-hidden="true">🏆</span>{/if}
      {#if matchResult === 'draw'}<span class="draw-badge" aria-hidden="true">½</span>{/if}
    </div>
  </header>

  {#if queenLockedA || queenLockedB}
    <div class="queen-lock">
      <span class="ql-line">
        {#if queenLockedA && queenLockedB}
          <!-- Both sides in the lockout: single compact line, one shared trailer. -->
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

  <div class="foot">
    {#if matchResult === 'draw'}
      <span class="winner drawn">
        <span class="winner-dot"></span>
        Match drawn · ½ point each
      </span>
    {:else if matchResult === 'a' || matchResult === 'b'}
      <span class="winner">
        <span class="winner-dot"></span>
        <strong>{matchResult === 'a' ? sideA.name : sideB.name}</strong>
        wins {sideA.sets}–{sideB.sets}
      </span>
    {:else}
      <span class="hint">© 2026 Swapnil Deshpande</span>
    {/if}
    <div class="foot-actions">
      <button type="button" class="foot-btn swap" onclick={swapSides} aria-label="Swap sides">
        <span class="foot-ico" aria-hidden="true">⇄</span><span class="foot-lbl">Swap</span>
      </button>
      <button type="button" class="foot-btn reset" onclick={requestReset} disabled={!hasProgress} aria-label="Reset scores">
        <span class="foot-ico" aria-hidden="true">↻</span><span class="foot-lbl">Reset</span>
      </button>
      <button type="button" class="foot-btn close" onclick={requestExit} aria-label="Close match">
        <span class="foot-ico" aria-hidden="true">✕</span><span class="foot-lbl">Close</span>
      </button>
    </div>
  </div>

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
  /* v1.5.1 score screen: everything must fit in one landscape phone view.
     Sizes use vh/vw so digits scale with the viewport. */

  .wrap {
    height: 100dvh;
    max-height: 100dvh;
    /* Honour Android/iOS safe-area insets so the footer isn't hidden behind
       the system gesture bar in landscape. Only the vertical insets matter
       here; the horizontal padding stays fixed. */
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
  }
  @media (orientation: portrait) and (max-width: 900px) {
    .rotate-hint { display: flex; }
  }
  .rotate-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.75rem;
    max-width: 20rem;
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
    font-size: clamp(0.9rem, 2.2vw, 1.15rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 0.3rem 0.75rem;
    border-radius: 0.5rem;
    color: #0b0b0b;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  /* Seat classes: layout / alignment only. */
  .head-a { text-align: left;  justify-self: start; }
  .head-b { text-align: right; justify-self: end; }
  /* Tone classes: colour. Applied to whichever seat the player is on. */
  .head-name.tone-a { background: var(--side-a); }
  .head-name.tone-b { background: var(--side-b); }
  .head-name .trophy,
  .head-name .draw-badge {
    display: inline-block;
    font-size: 1.05em;
    line-height: 1;
    margin: 0 0.35rem;
    vertical-align: -0.05em;
  }

  /*
   * Winner card: gold gradient background, gold ring, a glossy shine that
   * sweeps across every few seconds, plus a "WINNER" ribbon tab at the top.
   * The audience should be able to spot the winner from across a room.
   */
  .head-name.winner {
    position: relative;
    background: linear-gradient(135deg, #ffd54a 0%, #ffb300 55%, #ff8f00 100%);
    color: #2b1900;
    box-shadow:
      0 0 0 2px #ffd54a,
      0 0 22px rgba(255, 213, 74, 0.65),
      0 3px 12px rgba(0, 0, 0, 0.45);
    overflow: hidden;
  }
  .head-name.winner::before {
    /* WINNER ribbon tab */
    content: 'WINNER';
    position: absolute;
    top: -0.9rem;
    left: 50%;
    transform: translateX(-50%);
    background: #2b1900;
    color: #ffd54a;
    font-size: 0.55rem;
    letter-spacing: 0.18em;
    padding: 0.15rem 0.55rem;
    border-radius: 999px;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
    pointer-events: none;
  }
  .head-name.winner::after {
    /* Glossy shine that sweeps left→right every few seconds */
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      110deg,
      transparent 30%,
      rgba(255, 255, 255, 0.45) 45%,
      rgba(255, 255, 255, 0.7) 50%,
      rgba(255, 255, 255, 0.45) 55%,
      transparent 70%
    );
    transform: translateX(-120%);
    animation: winner-shine 3.5s ease-in-out infinite;
    pointer-events: none;
  }
  @keyframes winner-shine {
    0%, 60% { transform: translateX(-120%); }
    100%    { transform: translateX(120%); }
  }
  .head-name.winner .trophy {
    animation: winner-trophy 2.4s ease-in-out infinite;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.3));
  }
  @keyframes winner-trophy {
    0%, 100% { transform: translateY(0) rotate(-4deg); }
    50%      { transform: translateY(-3px) rotate(6deg); }
  }

  /* Draw: both sides get a matched silver treatment with a "½" badge. */
  .head-name.draw {
    background: linear-gradient(135deg, #cfd8dc 0%, #90a4ae 100%);
    color: #263238;
    box-shadow:
      0 0 0 2px #b0bec5,
      0 0 14px rgba(176, 190, 197, 0.35),
      0 2px 8px rgba(0, 0, 0, 0.35);
  }
  .head-name.draw .draw-badge {
    font-weight: 900;
    font-size: 1.25em;
    color: #37474f;
    letter-spacing: 0;
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

  /* SET indicator: dots per set-in-match, filled with winner's colour. */
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
  .set-pip.pip-a {
    background: var(--side-a);
    border-color: var(--side-a);
    box-shadow: 0 0 8px rgba(79,195,247,0.4);
  }
  .set-pip.pip-b {
    background: var(--side-b);
    border-color: var(--side-b);
    box-shadow: 0 0 8px rgba(255,138,101,0.4);
  }
  .set-pip.pip-current {
    background: transparent;
    border-color: var(--accent);
    box-shadow: 0 0 8px rgba(255,213,74,0.35);
    animation: pip-pulse 1.6s ease-in-out infinite;
  }
  .set-pip.pip-pending {
    background: transparent;
    border-color: rgba(255,255,255,0.15);
  }
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

  /* BOARD progress bar: labeled bar showing boardsThisSet / maxBoards. */
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

  .head-timer {
    color: var(--accent);
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 0.95rem;
    letter-spacing: 0.02em;
  }

  /*
   * Queen-lock ticker: when a side crosses 22 pts, the queen's 3-point bonus
   * no longer counts (ICF rule). Frame it as a live-commentator line so the
   * scoreboard reads like a broadcast, not a legal footnote.
   */
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
    touch-action: none;         /* let the scroll/drag action handle vertical gestures */
    -webkit-tap-highlight-color: transparent;
    overflow: hidden;
  }
  .col:active { transform: scale(0.97); background: rgba(255,255,255,0.06); }
  .col:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    line-height: 1;
    font-size: clamp(2rem, 12vh, 5rem);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
  }
  .digit.big { font-size: clamp(3rem, 22vh, 8rem); }
  /* Digit colours follow the tone class (which swaps with the player), not
     the seat class (which stays with the layout). */
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
    /* Cap the footer height so a long winner banner cannot push it below
       the grid. If content overflows horizontally, ellipsis kicks in. */
    max-height: 3rem;
    overflow: hidden;
  }
  .hint {
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
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
  .winner.drawn {
    background: linear-gradient(90deg, rgba(176,190,197,0.18), rgba(176,190,197,0.18));
    color: #cfd8dc;
  }
  .winner.drawn .winner-dot { background: #b0bec5; box-shadow: 0 0 8px rgba(176,190,197,0.6); }
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
  .foot-btn.swap:not(:disabled):hover { border-color: var(--side-a); }
  .foot-btn.reset { border-color: rgba(255,213,74,0.4); color: var(--accent); }
  .foot-btn.reset:not(:disabled):hover { border-color: var(--accent); }
  .foot-btn.close { border-color: rgba(239,83,80,0.4); color: var(--danger); }
  .foot-btn.close:not(:disabled):hover { border-color: var(--danger); }

  /*
   * Compact-height rules for landscape phones. Landscape width is ~720-900px
   * on modern phones, and vertical space is what's actually scarce. Use a
   * height-based media query so desktop landscape stays full-size but phone
   * landscape collapses.
   */
  @media (max-height: 500px) {
    .foot-lbl { display: none; }
    .foot-btn { padding: 0.35rem 0.55rem; }
    .foot-ico { font-size: 1rem; }
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
  }
  .dialog-card.win { border-color: var(--side-a); }
  .dialog-card.exit { border-color: var(--danger); }
  .dialog-card h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .dialog-card.win h2 { color: var(--side-a); }
  .dialog-card.exit h2 { color: var(--danger); }
  .dialog-card .who { margin: 0 0 1rem; font-size: 1rem; }
  .dialog-card .confirm {
    background: var(--accent);
    color: #0b0b0b;
    border: 0;
    border-radius: 999px;
    padding: 0.6rem 1.25rem;
    font-weight: 700;
    font-size: 0.95rem;
    width: 100%;
    cursor: pointer;
  }
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
</style>
