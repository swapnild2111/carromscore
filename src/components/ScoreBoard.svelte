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
    type SetEndReason,
  } from '../lib/match';

  type Side = { name: string; sets: number; points: number };

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<Side>({ name: 'First Player', sets: 0, points: 0 });
  let sideB = $state<Side>({ name: 'Second Player', sets: 0, points: 0 });
  let board = $state(0);
  let currentSet = $state(1);
  let boardsThisSet = $state(0);
  let setStartedAt = $state<number | null>(null);
  let now = $state(Date.now());
  let setEnd = $state<{ reason: SetEndReason; leader: 'a' | 'b' | null } | null>(null);
  let matchWinner = $state<'a' | 'b' | null>(null);
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
        if (typeof s?.currentSet === 'number') currentSet = s.currentSet;
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
      currentSet,
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

  const elapsedSeconds = $derived(setStartedAt === null ? 0 : Math.floor((now - setStartedAt) / 1000));

  function markStartedIfIdle() {
    if (setStartedAt === null) setStartedAt = Date.now();
  }

  function adjustPoints(side: 'a' | 'b', delta: number) {
    if (setEnd || matchWinner) return;
    if (delta > 0) markStartedIfIdle();
    const s = side === 'a' ? sideA : sideB;
    s.points = Math.max(0, s.points + delta);
    checkSetEnd();
  }
  function adjustSets(side: 'a' | 'b', delta: number) {
    const s = side === 'a' ? sideA : sideB;
    s.sets = Math.max(0, s.sets + delta);
    checkMatchWinner();
  }
  function adjustBoard(delta: number) {
    if (setEnd || matchWinner) return;
    if (delta > 0) markStartedIfIdle();
    const nextBoard = board + delta;
    if (nextBoard < 0) return;
    board = nextBoard;
    boardsThisSet = Math.max(0, boardsThisSet + delta);
    checkSetEnd();
  }

  function checkSetEnd() {
    if (setEnd) return;
    const reason = evaluateSetEnd({
      pointsA: sideA.points,
      pointsB: sideB.points,
      boardsPlayed: boardsThisSet,
      elapsedSeconds,
      cfg,
    });
    if (reason) {
      const leader = setLeader(sideA.points, sideB.points);
      setEnd = { reason, leader };
    }
  }

  $effect(() => {
    if (setEnd || matchWinner) return;
    if (cfg.minutesPerSet === null) return;
    if (setStartedAt === null) return;
    if (elapsedSeconds >= cfg.minutesPerSet * 60) checkSetEnd();
  });

  function confirmSetEnd() {
    if (!setEnd) return;
    if (setEnd.leader === 'a') sideA.sets += 1;
    else if (setEnd.leader === 'b') sideB.sets += 1;
    setEnd = null;
    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    boardsThisSet = 0;
    setStartedAt = null;
    currentSet = Math.min(cfg.bestOf, currentSet + 1);
    checkMatchWinner();
  }

  function checkMatchWinner() {
    const needed = Math.floor(cfg.bestOf / 2) + 1;
    if (sideA.sets >= needed) matchWinner = 'a';
    else if (sideB.sets >= needed) matchWinner = 'b';
    else matchWinner = null;
  }

  function swapSides() {
    const tmpName = sideA.name;
    sideA.name = sideB.name;
    sideB.name = tmpName;
    const tmpSets = sideA.sets;
    sideA.sets = sideB.sets;
    sideB.sets = tmpSets;
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
  function exit() {
    if (storageKey) {
      try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
    }
    window.location.href = import.meta.env.BASE_URL;
  }

  /**
   * Svelte action: change a numeric field by horizontal swipe.
   *   - swipe right (>= SWIPE_PX)  → onDelta(+1)
   *   - swipe left  (>= SWIPE_PX)  → onDelta(-1)
   *   - plain tap (no horizontal movement > threshold) → onDelta(+1)
   *
   * If the pointer drifts more vertically than horizontally, we abort the
   * gesture so the browser's own scroll can win (defensive; the score screen
   * doesn't scroll but this future-proofs the action).
   */
  function swipeAdjust(node: HTMLElement, opts: { onDelta: (d: 1 | -1) => void }) {
    const SWIPE_PX = 32;
    let startX = 0;
    let startY = 0;
    let active = false;
    let resolved = false;

    function onPointerDown(ev: PointerEvent) {
      active = true;
      resolved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      node.setPointerCapture?.(ev.pointerId);
    }
    function onPointerMove(ev: PointerEvent) {
      if (!active || resolved) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      // Only fire once the horizontal component clears threshold AND is
      // dominant over vertical drift.
      if (Math.abs(dx) < SWIPE_PX) return;
      if (Math.abs(dx) < Math.abs(dy)) return;
      resolved = true;
      opts.onDelta(dx > 0 ? 1 : -1);
    }
    function onPointerUp() {
      if (active && !resolved) opts.onDelta(1); // simple tap
      active = false;
      resolved = false;
    }
    function onPointerCancel() {
      active = false;
      resolved = false;
    }

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);

    return {
      update(next: { onDelta: (d: 1 | -1) => void }) {
        opts = next;
      },
      destroy() {
        node.removeEventListener('pointerdown', onPointerDown);
        node.removeEventListener('pointermove', onPointerMove);
        node.removeEventListener('pointerup', onPointerUp);
        node.removeEventListener('pointercancel', onPointerCancel);
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

  const setLabel = $derived(() => {
    if (cfg.bestOf === 1) return 'SINGLE SET';
    const ord = (n: number) => (['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][n - 1] ?? `${n}th`);
    return `${ord(currentSet)} OF ${cfg.bestOf} · Boards ${boardsThisSet}/${cfg.maxBoards}`;
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
    <div class="head-name head-a">{sideA.name}</div>
    <div class="head-mid">
      <div class="head-set">{setLabel()}</div>
      {#if timerText()}<div class="head-timer">{timerText()}</div>{/if}
    </div>
    <div class="head-name head-b">{sideB.name}</div>
  </header>

  {#if queenLockedA || queenLockedB}
    <div class="queen-lock">
      Queen ≤ 21 pts
      {#if queenLockedA}<span class="qa"> · {sideA.name}</span>{/if}
      {#if queenLockedB}<span class="qb"> · {sideB.name}</span>{/if}
    </div>
  {/if}

  <div class="grid">
    <button type="button" class="col side-a set" use:swipeAdjust={{ onDelta: (d) => adjustSets('a', d) }} aria-label="{sideA.name} sets: tap or swipe right to add, swipe left to subtract">
      <div class="digit">{setsFmt(sideA.sets)}</div>
      <div class="label">SET</div>
    </button>
    <button type="button" class="col side-a pts" use:swipeAdjust={{ onDelta: (d) => adjustPoints('a', d) }} aria-label="{sideA.name} points: tap or swipe right to add, swipe left to subtract">
      <div class="digit big">{pad2(sideA.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col mid brd" use:swipeAdjust={{ onDelta: (d) => adjustBoard(d) }} aria-label="Board: tap or swipe right to add, swipe left to subtract">
      <div class="digit">{board}</div>
      <div class="label">BOARD</div>
    </button>
    <button type="button" class="col side-b pts" use:swipeAdjust={{ onDelta: (d) => adjustPoints('b', d) }} aria-label="{sideB.name} points: tap or swipe right to add, swipe left to subtract">
      <div class="digit big">{pad2(sideB.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col side-b set" use:swipeAdjust={{ onDelta: (d) => adjustSets('b', d) }} aria-label="{sideB.name} sets: tap or swipe right to add, swipe left to subtract">
      <div class="digit">{setsFmt(sideB.sets)}</div>
      <div class="label">SET</div>
    </button>
  </div>

  <div class="foot">
    <span class="hint">Tap a number to add 1 · Swipe right to add, left to subtract</span>
    <div class="foot-actions">
      <button type="button" class="swap" onclick={swapSides}>Swap sides</button>
      <button type="button" class="close" onclick={requestExit}>Close</button>
    </div>
  </div>

  {#if setEnd}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card">
        <h2>Set complete</h2>
        {#if setEnd.leader === null}
          <p class="who tie">Tied {sideA.points}–{sideB.points}. Sudden-death or adjust SET manually.</p>
        {:else}
          <p class="who">
            <strong>{setEnd.leader === 'a' ? sideA.name : sideB.name}</strong>
            wins {Math.max(sideA.points, sideB.points)}–{Math.min(sideA.points, sideB.points)}
          </p>
        {/if}
        <button class="confirm" onclick={confirmSetEnd}>
          {setEnd.leader === null ? 'Continue' : 'Next set →'}
        </button>
      </div>
    </div>
  {/if}

  {#if matchWinner}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card win">
        <h2>Match complete</h2>
        <p class="who">
          <strong>{matchWinner === 'a' ? sideA.name : sideB.name}</strong>
          wins {sideA.sets}–{sideB.sets}
        </p>
        <button class="confirm" onclick={exit}>New match</button>
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
</section>

<style>
  /* v1.5.1 score screen: everything must fit in one landscape phone view.
     Sizes use vh/vw so digits scale with the viewport. */

  .wrap {
    height: 100dvh;
    max-height: 100dvh;
    padding: 0.4rem 0.5rem;
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
  .head-a {
    background: var(--side-a);
    text-align: left;
    justify-self: start;
  }
  .head-b {
    background: var(--side-b);
    text-align: right;
    justify-self: end;
  }
  .head-mid { text-align: center; }
  .head-set {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }
  .head-timer {
    color: var(--accent);
    font-family: 'DSEG7 Classic', 'Courier New', monospace;
    font-variant-numeric: tabular-nums;
    font-size: 1rem;
    margin-top: 0.15rem;
  }

  .queen-lock {
    flex-shrink: 0;
    text-align: center;
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.25);
    border-radius: 0.4rem;
    padding: 0.25rem 0.5rem;
    letter-spacing: 0.04em;
  }
  .queen-lock .qa { color: var(--side-a); font-weight: 700; }
  .queen-lock .qb { color: var(--side-b); font-weight: 700; }

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
  .side-a .digit { color: var(--side-a); text-shadow: 0 0 12px rgba(79,195,247,0.35); }
  .side-b .digit { color: var(--side-b); text-shadow: 0 0 12px rgba(255,138,101,0.35); }
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
    padding: 0 0.25rem;
  }
  .hint {
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }
  .foot-actions { display: flex; gap: 0.4rem; }
  .foot-actions button {
    border-radius: 999px;
    padding: 0.4rem 0.9rem;
    font-size: 0.8rem;
    font-weight: 600;
    cursor: pointer;
  }
  .foot-actions .swap {
    background: #1f1f1f;
    color: var(--fg);
    border: 1px solid #333;
  }
  .foot-actions .close {
    background: transparent;
    color: var(--muted);
    border: 1px solid #333;
  }
  .foot-actions button:active { background: #2a2a2a; }

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
  .dialog-card .who.tie { color: var(--muted); font-size: 0.9rem; }
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
  }
  .dialog-actions .cancel { background: #1f1f1f; color: var(--fg); border: 1px solid #333; }
  .dialog-actions .danger { background: var(--danger); color: #0b0b0b; }
</style>
