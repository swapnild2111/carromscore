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
  } from '../lib/match';
  import { APP_VERSION } from '../lib/version';

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
  let board = $state(0);

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
  let matchResult = $state<'a' | 'b' | null>(null);
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
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      window.removeEventListener('resize', updateOrientation);
      window.removeEventListener('orientationchange', updateOrientation);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      releaseWakeLock();
      releaseLandscape();
    };
  });

  /**
   * Screen Wake Lock. Keeps the phone screen from dimming/locking during a
   * match. Android drops the lock when the tab is backgrounded, so we
   * re-request on visibilitychange when we come back to the foreground.
   */
  type WakeLockSentinelLike = { release: () => Promise<void> };
  let wakeLock: WakeLockSentinelLike | null = null;

  async function requestWakeLock() {
    const wl = (navigator as unknown as { wakeLock?: { request: (type: string) => Promise<WakeLockSentinelLike> } }).wakeLock;
    if (!wl) return;
    try {
      wakeLock = await wl.request('screen');
    } catch {
      // Browser refused
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
    if (document.visibilityState === 'visible') {
      if (!wakeLock) requestWakeLock();
      if (!document.fullscreenElement) landscapeLocked = false;
    }
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
    };
    if (isPractice) s.practiceBoards = practiceBoards;
    try {
      localStorage.setItem(storageKey, JSON.stringify(s));
    } catch {
      // ignore
    }
  });

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

  function adjustPoints(side: 'a' | 'b', delta: number) {
    void tryLockLandscape();
    const s = side === 'a' ? sideA : sideB;
    s.points = Math.min(cfg.pointsTarget, Math.max(0, s.points + delta));
  }
  function adjustSets(side: 'a' | 'b', delta: number) {
    void tryLockLandscape();
    const s = side === 'a' ? sideA : sideB;
    const prev = s.sets;
    s.sets = Math.min(cfg.bestOf, Math.max(0, s.sets + delta));
    // If the SET count actually changed, we're transitioning between sets —
    // zero out POINTS on both sides and BOARD, ready for the next set. No
    // reset when the clamp swallowed the delta (already at cap / floor).
    if (s.sets !== prev) {
      sideA.points = 0;
      sideB.points = 0;
      board = 0;
    }
    // matchResult stays untouched: the WINNER ribbon only appears when the
    // organiser taps End Match, never on a SET +/- alone.
  }
  function adjustBoard(delta: number) {
    void tryLockLandscape();
    const next = board + delta;
    if (next < 0) return;
    if (next > boardCap()) return;
    board = next;
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
  // Fixed array of spark indices for the fireworks each-loop.
  const SPARK_INDICES = Array.from({ length: 20 }, (_, i) => i);
  function endMatch() {
    // Practice: no winner. Just surface the matrix.
    if (isPractice) {
      showPracticePopup = true;
      return;
    }
    let winner: 'a' | 'b' | null = null;
    let awardExtraSet = false;
    if (sideA.sets > sideB.sets) {
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
    }
    if (!winner) return; // fully tied — organiser must adjust manually first
    if (awardExtraSet) {
      const s = winner === 'a' ? sideA : sideB;
      s.sets = Math.min(cfg.bestOf, s.sets + 1);
    }
    matchResult = winner;
    showWinnerPopup = true;
  }

  function swapSides() {
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
  }

  function resetScores() {
    sideA.sets = 0;
    sideB.sets = 0;
    sideA.points = 0;
    sideB.points = 0;
    board = 0;
    matchResult = null;
    colourA = 'a';
    colourB = 'b';
    if (isPractice) {
      practiceBoards = blankMatrix(cfg.bestOf, cfg.maxBoards);
      practiceSetIdx = 0;
      // Scroll the boards row back to B1–4 too.
      jumpToBoardPage(0);
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

  const queenLockedA = $derived(sideA.points >= 22);
  const queenLockedB = $derived(sideB.points >= 22);

</script>

<section class="wrap">
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

      <!-- Scrollable middle track: N cells (one per board) laid out at
           the width of exactly PRACTICE_BOARDS_VISIBLE, so a phone shows
           4 at once and the rest scroll into view. -->
      <div
        class="pscroll"
        bind:this={practiceScrollerEl}
        onscroll={onPracticeScroll}
        style="--visible: {Math.min(PRACTICE_BOARDS_VISIBLE, cfg.maxBoards)}; --board-count: {cfg.maxBoards};"
      >
        <div class="pscroll-head">
          {#each Array.from({ length: cfg.maxBoards }, (_, i) => i) as boardIdx (boardIdx)}
            <div class="pth">B{boardIdx + 1}</div>
          {/each}
        </div>
        <div class="pscroll-row">
          {#each Array.from({ length: cfg.maxBoards }, (_, i) => i) as boardIdx (boardIdx)}
            <button
              type="button"
              class="pcell"
              use:swipeAdjust={{ onDelta: (d) => adjustPracticeBoard(practiceSetIdx, boardIdx, d) }}
              aria-label="Set {practiceSetIdx + 1} board {boardIdx + 1}: {(practiceBoards[practiceSetIdx]?.[boardIdx]) ?? 0} missed"
            >
              <div class="digit pdigit">{pad2((practiceBoards[practiceSetIdx]?.[boardIdx]) ?? 0)}</div>
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

    {#if practiceBoardPageCount > 1}
      <div class="practice-board-chips">
        {#each Array.from({ length: practiceBoardPageCount }, (_, i) => i) as pIdx (pIdx)}
          {@const from = pIdx * PRACTICE_BOARDS_VISIBLE + 1}
          {@const to = Math.min(cfg.maxBoards, (pIdx + 1) * PRACTICE_BOARDS_VISIBLE)}
          <button
            type="button"
            class="pchip"
            class:pchip-current={pIdx === practiceCurrentBoardPage}
            onclick={() => jumpToBoardPage(pIdx)}
            aria-label="Show boards {from} to {to}"
          >B{from === to ? from : `${from}–${to}`}</button>
        {/each}
      </div>
    {/if}

    {#if cfg.bestOf > 1}
      <div class="practice-pager">
        <button
          type="button"
          class="foot-btn practice-pager-btn"
          onclick={() => { practiceSetIdx = Math.max(0, practiceSetIdx - 1); jumpToBoardPage(0); }}
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
          onclick={() => { practiceSetIdx = Math.min(cfg.bestOf - 1, practiceSetIdx + 1); jumpToBoardPage(0); }}
          disabled={practiceSetIdx === cfg.bestOf - 1}
          aria-label="Next set"
        >
          <span class="foot-lbl">Next set</span><span class="foot-ico" aria-hidden="true">→</span>
        </button>
      </div>
    {/if}
  {:else}
  <header class="head">
    <div class="head-name head-a tone-{colourA}"
         class:decided={matchResult !== null}
         class:gold={matchResult === 'a'}
         class:silver={matchResult === 'b'}>
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
      {/if}
      <span class="hn-name">{sideA.name}</span>
      {#if sideA.note}<span class="hn-note">{sideA.note}</span>{/if}
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
    <div class="head-name head-b tone-{colourB}"
         class:decided={matchResult !== null}
         class:gold={matchResult === 'b'}
         class:silver={matchResult === 'a'}>
      <span class="hn-name">{sideB.name}</span>
      {#if sideB.note}<span class="hn-note">{sideB.note}</span>{/if}
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
      {/if}
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
    {#if matchResult}
      <span class="winner">
        <span class="winner-dot"></span>
        <strong>{matchResult === 'a' ? sideA.name : sideB.name}</strong>
        wins {sideA.sets}–{sideB.sets}
      </span>
    {:else}
      <span class="hint">
        © 2026 Swapnil Deshpande
        <span class="hint-sep" aria-hidden="true">·</span>
        <span class="hint-ver">v{APP_VERSION}</span>
      </span>
    {/if}
    <div class="foot-actions">
      {#if !isPractice}
        <button type="button" class="foot-btn swap" onclick={swapSides} aria-label="Swap sides">
          <span class="foot-ico" aria-hidden="true">⇄</span><span class="foot-lbl">Swap</span>
        </button>
      {/if}
      <button type="button" class="foot-btn reset" onclick={requestReset} disabled={!hasProgress} aria-label="Reset scores">
        <span class="foot-ico" aria-hidden="true">↻</span><span class="foot-lbl">Reset</span>
      </button>
      <button type="button" class="foot-btn endm" onclick={endMatch} disabled={!isPractice && !hasProgress} aria-label="End match">
        <span class="foot-ico" aria-hidden="true">🏁</span><span class="foot-lbl">End</span>
      </button>
      <button type="button" class="foot-btn close" onclick={requestExit} aria-label="Close match">
        <span class="foot-ico" aria-hidden="true">✕</span><span class="foot-lbl">Close</span>
      </button>
    </div>
  </div>

  {#if showWinnerPopup && matchResult}
    <div class="dialog winner-dialog" role="dialog" aria-modal="true">
      <!--
        Fireworks: 20 particles arranged around the popup, each animating
        outward on its own delay + colour. Purely decorative, dismissible
        by tap. inert on aria — the button below carries all the a11y.
      -->
      <div class="fireworks" aria-hidden="true">
        {#each SPARK_INDICES as i (i)}
          <span class="spark spark-{i % 8}" style="--n: {i}"></span>
        {/each}
      </div>
      <div class="dialog-card champion">
        <div class="champ-trophy" aria-hidden="true">🏆</div>
        <div class="champ-label">CHAMPION</div>
        <div class="champ-name">{matchResult === 'a' ? sideA.name : sideB.name}</div>
        <div class="champ-score">
          Sets <strong>{sideA.sets}–{sideB.sets}</strong>
          <span class="champ-sep">·</span>
          Final board <strong>{pad2(sideA.points)}–{pad2(sideB.points)}</strong>
        </div>
        <button class="confirm-big" onclick={() => (showWinnerPopup = false)}>
          Show scoreboard
        </button>
      </div>
    </div>
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
                  <td>{pad2(cell)}</td>
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
    height: 100dvh;
    max-height: 100dvh;
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
    align-items: center;
    gap: 0.35rem;
    font-size: clamp(0.9rem, 2.2vw, 1.15rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    max-width: 100%;
    padding: 0.3rem 0.75rem;
    border-radius: 0.5rem;
    color: #0b0b0b;
    box-shadow: 0 2px 8px rgba(0,0,0,0.35);
  }
  .head-name .hn-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .head-name .hn-note {
    font-size: 0.7em;
    font-weight: 700;
    letter-spacing: 0.06em;
    opacity: 0.75;
    padding: 0.05rem 0.4rem;
    border-radius: 0.35rem;
    background: rgba(0,0,0,0.18);
    flex-shrink: 0;
  }
  .head-a { text-align: left;  justify-self: start; }
  .head-b { text-align: right; justify-self: end; }
  .head-name.tone-a { background: var(--side-a); }
  .head-name.tone-b { background: var(--side-b); }

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
  }
  .col:active { transform: scale(0.97); background: rgba(255,255,255,0.06); }
  .col:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    line-height: 1;
    font-size: clamp(2.5rem, 16vh, 6rem);
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.03em;
  }
  /* POINTS is the audience's focal point — make it dominate the panel. */
  .digit.big { font-size: clamp(4rem, 32vh, 12rem); }
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
  .dialog-card.exit { border-color: var(--danger); }
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
    /* The row is (board-count / visible) × 100% wide of the viewport
       slot; each cell is 1/board-count of the row, which resolves to
       exactly 1/visible of the *viewport* — so `visible` cells fit and
       the rest scroll. */
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: calc(100% / var(--board-count, 4));
    column-gap: 0.4rem;
    width: calc(100% * var(--board-count, 4) / var(--visible, 4));
  }
  .pscroll-head { align-items: center; }
  .pscroll-row > .pcell { scroll-snap-align: start; }
  .pcell {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid #222;
    border-radius: 0.5rem;
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
  .pcell:active { transform: scale(0.97); background: rgba(255,255,255,0.06); }
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
