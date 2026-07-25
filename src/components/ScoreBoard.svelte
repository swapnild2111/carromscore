<script lang="ts">
  import { onMount } from 'svelte';
  import {
    DEFAULT_CONFIG,
    decodeConfig,
    evaluateSetEnd,
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
  let currentSet = $state(1);       // 1..bestOf
  let boardsThisSet = $state(0);    // increments on Board +
  let setStartedAt = $state<number | null>(null); // ms epoch, null until first point
  let now = $state(Date.now());
  let setEnd = $state<{ reason: SetEndReason; leader: 'a' | 'b' | null } | null>(null);
  let matchWinner = $state<'a' | 'b' | null>(null);

  let storageKey = $state<string | null>(null);

  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    cfg = decodeConfig(q);
    sideA.name = teamLabel(cfg.playerA, cfg.playerA2, cfg.mode) || 'First Player';
    sideB.name = teamLabel(cfg.playerB, cfg.playerB2, cfg.mode) || 'Second Player';
    storageKey = `carromscore:state:${q.get('playerA') ?? ''}:${q.get('playerB') ?? ''}`;

    // Restore in-flight match state (so refresh doesn't wipe the score).
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
      // ignore malformed / access-denied localStorage
    }

    const tick = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(tick);
  });

  // Persist state on every change so a refresh or the overlay tab picks it up.
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
      // localStorage quota or access issues — silently ignore
    }
  });

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
    const nextBoards = boardsThisSet + delta;
    boardsThisSet = Math.max(0, nextBoards);
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

  // Poll for time-triggered set end (points/boards check on user action; time is passive).
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
    // tied: no set awarded (organizer resolves manually with SET +/-)
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

  let confirmExit = $state(false);

  /**
   * Svelte action that recognises three gestures on the same element:
   *   - tap                          → onTap()   (+1)
   *   - long-press (≥ HOLD_MS)        → onHold()  (−1)
   *   - horizontal swipe (≥ SWIPE_PX) → onSwipe(dir)  right=+1, left=−1
   *
   * First threshold crossed wins; the other handlers don't fire.
   */
  const HOLD_MS = 500;
  const SWIPE_PX = 40;
  type TapHoldOpts = {
    onTap: () => void;
    onHold: () => void;
    onSwipe: (dir: 'left' | 'right') => void;
  };
  function tapHold(node: HTMLElement, opts: TapHoldOpts) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let startX = 0;
    let startY = 0;
    let resolved = false;
    let active = false;

    function clearTimer() {
      if (timer) clearTimeout(timer);
      timer = null;
    }

    function down(ev: PointerEvent) {
      ev.preventDefault();
      active = true;
      resolved = false;
      startX = ev.clientX;
      startY = ev.clientY;
      node.setPointerCapture?.(ev.pointerId);
      timer = setTimeout(() => {
        if (!active || resolved) return;
        resolved = true;
        opts.onHold();
      }, HOLD_MS);
    }
    function move(ev: PointerEvent) {
      if (!active || resolved) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(dy)) {
        resolved = true;
        clearTimer();
        opts.onSwipe(dx > 0 ? 'right' : 'left');
      }
    }
    function up() {
      if (!active) return;
      active = false;
      clearTimer();
      if (!resolved) opts.onTap();
    }
    function cancel() {
      active = false;
      clearTimer();
    }

    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointerleave', cancel);
    node.addEventListener('pointercancel', cancel);
    return {
      update(next: TapHoldOpts) {
        opts = next;
      },
      destroy() {
        node.removeEventListener('pointerdown', down);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointerleave', cancel);
        node.removeEventListener('pointercancel', cancel);
        clearTimer();
      },
    };
  }

  const hasProgress = $derived(
    sideA.points > 0 ||
    sideB.points > 0 ||
    sideA.sets > 0 ||
    sideB.sets > 0 ||
    board > 0 ||
    boardsThisSet > 0,
  );

  function requestExit() {
    if (!hasProgress) {
      exit();
    } else {
      confirmExit = true;
    }
  }
  function exit() {
    // Blow away in-flight state for this pairing so the next match starts clean.
    if (storageKey) {
      try {
        localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
    window.location.href = import.meta.env.BASE_URL;
  }

  function saveToGitHub() {
    const now = new Date().toISOString();
    const payload = {
      version: 1,
      completedAt: now,
      config: cfg,
      result: {
        winner: matchWinner,
        sideA: { name: sideA.name, sets: sideA.sets, finalPoints: sideA.points },
        sideB: { name: sideB.name, sets: sideB.sets, finalPoints: sideB.points },
      },
    };
    const body = [
      '<!-- Auto-generated by carromscore. Do not edit above this line. -->',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
    ].join('\n');
    const title = `Match: ${sideA.name} vs ${sideB.name} — ${now.slice(0, 10)}`;
    const params = new URLSearchParams({ title, body, labels: 'save-match' });
    // Repo is intentionally hardcoded — this app ships from that repo.
    const url = `https://github.com/swapnild2111/carromscore/issues/new?${params.toString()}`;
    window.open(url, '_blank', 'noopener');
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

  // ICF/AICF rule: the queen (3 pts) no longer scores once a side's cumulative
  // set score has reached 22. Since our +/- buttons don't distinguish "this was
  // a queen", we surface the lock as guidance rather than force it.
  const queenLockedA = $derived(sideA.points >= 22);
  const queenLockedB = $derived(sideB.points >= 22);

  const reasonText = (r: SetEndReason) => ({
    points: `${cfg.pointsTarget}-point target reached`,
    boards: `${cfg.maxBoards} boards played`,
    time: `${cfg.minutesPerSet} minute time limit reached`,
  })[r];
</script>

<section class="wrap">
  <div class="header">
    <div class="head-cell head-a">
      <div class="name">{sideA.name}</div>
    </div>
    <div class="head-cell head-b">
      <div class="name">{sideB.name}</div>
    </div>
  </div>

  <div class="status">
    <div class="status-set">{setLabel()}</div>
    {#if timerText()}
      <div class="status-timer">{timerText()}</div>
    {/if}
  </div>

  {#if queenLockedA || queenLockedB}
    <div class="queen-lock" role="status">
      Queen won't score for
      {#if queenLockedA}<span class="side-a-name"> {sideA.name}</span>{/if}
      {#if queenLockedA && queenLockedB} · {/if}
      {#if queenLockedB}<span class="side-b-name"> {sideB.name}</span>{/if}
      (past 22)
    </div>
  {/if}

  <div class="grid">
    <button type="button" class="col col-set side-a" use:tapHold={{ onTap: () => adjustSets('a', 1), onHold: () => adjustSets('a', -1), onSwipe: (d) => adjustSets('a', d === 'right' ? 1 : -1) }} aria-label="Side A sets: tap to add, long-press to subtract">
      <div class="digit">{setsFmt(sideA.sets)}</div>
      <div class="label">SET</div>
    </button>
    <button type="button" class="col col-points side-a" use:tapHold={{ onTap: () => adjustPoints('a', 1), onHold: () => adjustPoints('a', -1), onSwipe: (d) => adjustPoints('a', d === 'right' ? 1 : -1) }} aria-label="Side A points: tap to add, long-press to subtract">
      <div class="digit big">{pad2(sideA.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col col-board" use:tapHold={{ onTap: () => adjustBoard(1), onHold: () => adjustBoard(-1), onSwipe: (d) => adjustBoard(d === 'right' ? 1 : -1) }} aria-label="Board: tap to add, long-press to subtract">
      <div class="digit">{board}</div>
      <div class="label">BOARD</div>
    </button>
    <button type="button" class="col col-points side-b" use:tapHold={{ onTap: () => adjustPoints('b', 1), onHold: () => adjustPoints('b', -1), onSwipe: (d) => adjustPoints('b', d === 'right' ? 1 : -1) }} aria-label="Side B points: tap to add, long-press to subtract">
      <div class="digit big">{pad2(sideB.points)}</div>
      <div class="label">POINTS</div>
    </button>
    <button type="button" class="col col-set side-b" use:tapHold={{ onTap: () => adjustSets('b', 1), onHold: () => adjustSets('b', -1), onSwipe: (d) => adjustSets('b', d === 'right' ? 1 : -1) }} aria-label="Side B sets: tap to add, long-press to subtract">
      <div class="digit">{setsFmt(sideB.sets)}</div>
      <div class="label">SET</div>
    </button>
  </div>

  <p class="hint-line">Tap or swipe right to add 1 · Swipe left or hold to subtract 1</p>

  <footer class="foot">
    <button type="button" class="swap" onclick={swapSides}>Swap sides</button>
    <button type="button" class="close" onclick={requestExit}>Close match</button>
  </footer>

  {#if setEnd}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card">
        <h2>Set complete</h2>
        <p class="reason">{reasonText(setEnd.reason)}.</p>
        {#if setEnd.leader === null}
          <p class="who tie">Scores are tied {sideA.points}–{sideB.points}. Play a sudden-death board or tap SET+ manually below.</p>
        {:else}
          <p class="who">
            <strong>{setEnd.leader === 'a' ? sideA.name : sideB.name}</strong>
            wins the set {Math.max(sideA.points, sideB.points)}–{Math.min(sideA.points, sideB.points)}.
          </p>
        {/if}
        <button class="confirm" onclick={confirmSetEnd}>
          {setEnd.leader === null ? 'Continue' : 'Award set and start next'}
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
          wins the match {sideA.sets}–{sideB.sets}.
        </p>
        <button class="confirm" onclick={saveToGitHub}>
          Save match to GitHub
        </button>
      </div>
    </div>
  {/if}

  {#if confirmExit}
    <div class="dialog" role="dialog" aria-modal="true">
      <div class="dialog-card exit">
        <h2>Exit match?</h2>
        <p class="who">This will discard the current score and take you back to setup.</p>
        <div class="dialog-actions">
          <button class="cancel" onclick={() => (confirmExit = false)}>Keep playing</button>
          <button class="danger" onclick={exit}>Exit</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .wrap {
    padding: 1rem;
    max-width: 1024px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    user-select: none;
    -webkit-user-select: none;
  }
  .header {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }
  .head-cell {
    text-align: center;
    padding: 0.5rem;
    border-radius: 0.5rem;
    background: #141414;
    border-bottom: 3px solid transparent;
  }
  .head-a { border-color: var(--side-a); }
  .head-b { border-color: var(--side-b); }
  .name {
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-size: clamp(0.95rem, 3vw, 1.3rem);
  }

  .status {
    display: flex;
    justify-content: center;
    align-items: baseline;
    gap: 1rem;
    color: var(--muted);
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .status-timer {
    color: var(--accent);
    font-family: 'DS-Digital', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-size: 1.1rem;
    letter-spacing: 0;
  }
  .queen-lock {
    text-align: center;
    font-size: 0.8rem;
    color: var(--muted);
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.25);
    border-radius: 0.5rem;
    padding: 0.4rem 0.6rem;
    letter-spacing: 0.04em;
  }
  .queen-lock .side-a-name { color: var(--side-a); font-weight: 700; }
  .queen-lock .side-b-name { color: var(--side-b); font-weight: 700; }

  .grid {
    display: grid;
    grid-template-columns: 1fr 2fr 1.2fr 2fr 1fr;
    gap: 0.5rem;
    background: #0f0f0f;
    padding: 0.75rem 0.5rem;
    border-radius: 1rem;
    border: 1px solid #222;
  }
  .col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    /* Reset button chrome so the digit reads as a display. */
    background: transparent;
    border: none;
    color: inherit;
    font: inherit;
    padding: 0.5rem 0.25rem;
    border-radius: 0.75rem;
    cursor: pointer;
    transition: background 0.1s, transform 0.06s;
    touch-action: manipulation;
    -webkit-tap-highlight-color: transparent;
  }
  .col:hover { background: rgba(255,255,255,0.03); }
  .col:active { transform: scale(0.97); background: rgba(255,255,255,0.06); }
  .col:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .digit {
    font-family: 'DS-Digital', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 800;
    line-height: 1;
    font-size: clamp(3rem, 12vw, 5.5rem);
  }
  .digit.big {
    font-size: clamp(4rem, 18vw, 8rem);
  }
  .side-a .digit { color: var(--side-a); text-shadow: 0 0 12px rgba(79,195,247,0.35); }
  .side-b .digit { color: var(--side-b); text-shadow: 0 0 12px rgba(255,138,101,0.35); }
  .col-board .digit { color: var(--accent); text-shadow: 0 0 12px rgba(255,213,74,0.35); }
  .label {
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.7rem;
  }

  .hint-line {
    text-align: center;
    color: var(--muted);
    font-size: 0.8rem;
    margin: 0.25rem 0 0;
    letter-spacing: 0.03em;
  }

  .foot {
    display: flex;
    justify-content: center;
    gap: 0.75rem;
    padding: 0.5rem 0 1rem;
    flex-wrap: wrap;
  }
  .foot button {
    border-radius: 999px;
    padding: 0.75rem 1.4rem;
    font-size: 1rem;
    font-weight: 600;
    cursor: pointer;
  }
  .foot .swap {
    background: #1f1f1f;
    color: var(--fg);
    border: 1px solid #333;
  }
  .foot .swap:active { background: #2a2a2a; }
  .foot .close {
    background: transparent;
    color: var(--muted);
    border: 1px solid #333;
  }
  .foot .close:active { background: #1c1c1c; color: var(--fg); }

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
    padding: 1.5rem 1.5rem 1.25rem;
    max-width: 22rem;
    width: 100%;
    text-align: center;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  }
  .dialog-card.win { border-color: var(--side-a); }
  .dialog-card h2 {
    margin: 0 0 0.5rem;
    font-size: 1.4rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .dialog-card.win h2 { color: var(--side-a); }
  .dialog-card .reason { color: var(--muted); margin: 0 0 0.75rem; font-size: 0.9rem; }
  .dialog-card .who { margin: 0 0 1.25rem; font-size: 1.05rem; line-height: 1.4; }
  .dialog-card .who.tie { color: var(--muted); font-size: 0.95rem; }
  .dialog-card .confirm {
    background: var(--accent);
    color: #0b0b0b;
    border: 0;
    border-radius: 999px;
    padding: 0.75rem 1.25rem;
    font-weight: 700;
    font-size: 1rem;
    width: 100%;
    cursor: pointer;
  }
  .dialog-card.exit { border-color: var(--danger); }
  .dialog-card.exit h2 { color: var(--danger); }
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
  }
  .dialog-actions .cancel, .dialog-actions .danger {
    flex: 1;
    padding: 0.75rem 1rem;
    font-weight: 700;
    font-size: 1rem;
    border-radius: 999px;
    cursor: pointer;
    border: none;
  }
  .dialog-actions .cancel { background: #1f1f1f; color: var(--fg); border: 1px solid #333; }
  .dialog-actions .danger { background: var(--danger); color: #0b0b0b; }
</style>
