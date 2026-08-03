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
    const s = {
      sideA: { points: sideA.points, sets: sideA.sets },
      sideB: { points: sideB.points, sets: sideB.sets },
      board,
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
  }
  let confirmReset = $state(false);
  function requestReset() {
    if (!hasProgress) return;
    confirmReset = true;
  }

  const hasProgress = $derived(
    sideA.points > 0 || sideB.points > 0 || sideA.sets > 0 || sideB.sets > 0 || board > 0,
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

  /**
   * Live leader (who's ahead by points in the current set). null when tied,
   * or when the match is over — the WINNER ribbon takes over then.
   */
  const leader = $derived<'a' | 'b' | null>(() => {
    if (matchResult) return null;
    if (sideA.points === sideB.points) return null;
    return sideA.points > sideB.points ? 'a' : 'b';
  });
</script>

<section class="wrap">
  <button type="button" class="rotate-hint" onclick={() => tryLockLandscape()}>
    <div class="rotate-card">
      <div class="rotate-icon" aria-hidden="true">📱</div>
      <strong>Tap to start scoring</strong>
      <span>Carromscore uses landscape. Tap here and rotate your phone if it doesn't turn automatically.</span>
    </div>
  </button>

  <header class="head">
    <div class="head-name head-a tone-{colourA}"
         class:winner={matchResult === 'a'}>
      {#if matchResult === 'a'}<span class="trophy" aria-hidden="true">🏆</span>{/if}
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
         class:winner={matchResult === 'b'}>
      <span class="hn-name">{sideB.name}</span>
      {#if sideB.note}<span class="hn-note">{sideB.note}</span>{/if}
      {#if matchResult === 'b'}<span class="trophy" aria-hidden="true">🏆</span>{/if}
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
      {#if leader() === 'a'}
        <div class="lead-badge leading tone-{colourA}">LEADING</div>
      {:else if leader() === 'b'}
        <div class="lead-badge trailing">TRAILING</div>
      {/if}
    </button>
    <button type="button" class="col mid brd" use:swipeAdjust={{ onDelta: (d) => adjustBoard(d) }} aria-label="Board: tap or swipe left to add, swipe right to subtract">
      <div class="digit">{board}</div>
      <div class="label">BOARD</div>
    </button>
    <button type="button" class="col side-b tone-{colourB} pts" use:swipeAdjust={{ onDelta: (d) => adjustPoints('b', d) }} aria-label="{sideB.name} points: tap or swipe left to add, swipe right to subtract">
      <div class="digit big">{pad2(sideB.points)}</div>
      <div class="label">POINTS</div>
      {#if leader() === 'b'}
        <div class="lead-badge leading tone-{colourB}">LEADING</div>
      {:else if leader() === 'a'}
        <div class="lead-badge trailing">TRAILING</div>
      {/if}
    </button>
    <button type="button" class="col side-b tone-{colourB} set" use:swipeAdjust={{ onDelta: (d) => adjustSets('b', d) }} aria-label="{sideB.name} sets: tap or swipe left to add, swipe right to subtract">
      <div class="digit">{setsFmt(sideB.sets)}</div>
      <div class="label">SET</div>
    </button>
  </div>

  <div class="foot">
    {#if matchResult}
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
      <button type="button" class="foot-btn endm" onclick={endMatch} disabled={!hasProgress} aria-label="End match">
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

  .head-name .trophy {
    display: inline-block;
    font-size: 1.05em;
    line-height: 1;
    vertical-align: -0.05em;
  }

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

  /* Live LEADING / TRAILING pill inside each POINTS column */
  .lead-badge {
    margin-top: 0.15rem;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.12em;
    padding: 0.15rem 0.6rem;
    border-radius: 999px;
    text-transform: uppercase;
    line-height: 1;
  }
  .lead-badge.leading { color: #0b0b0b; }
  .lead-badge.leading.tone-a { background: var(--side-a); box-shadow: 0 0 10px rgba(79,195,247,0.5); }
  .lead-badge.leading.tone-b { background: var(--side-b); box-shadow: 0 0 10px rgba(255,138,101,0.5); }
  .lead-badge.trailing {
    color: var(--muted);
    background: transparent;
    border: 1px solid rgba(255,255,255,0.15);
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
</style>
