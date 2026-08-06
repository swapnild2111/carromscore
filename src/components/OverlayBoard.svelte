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
    type Side,
  } from '../lib/match';

  /*
   * Broadcast overlay. Renders a transparent bottom-third strip that OBS
   * or Prism can layer over a live camera feed of a carrom match. Reads
   * state from the shared localStorage key that ScoreBoard writes; picks
   * up changes instantly on the same browser via the `storage` event.
   *
   * Visual language mirrors the phone scoreboard: coloured player pills,
   * DSEG7 7-segment digits, set-pip strip, and small BREAK / QUEEN
   * indicators so viewers see who's breaking and who has the queen.
   */

  type SideState = { name: string; note: string; sets: number; points: number };

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<SideState>({ name: 'Player A', note: '', sets: 0, points: 0 });
  let sideB = $state<SideState>({ name: 'Player B', note: '', sets: 0, points: 0 });
  let board = $state(0);
  let currentBreak = $state<Side | null>(null);
  let queenHolder = $state<Side | null>(null);
  let matchResult = $state<Side | null>(null);

  const currentSet = $derived(Math.min(cfg.bestOf, sideA.sets + sideB.sets + 1));

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
      pips.push(i === completed ? 'current' : 'pending');
    }
    return pips;
  });

  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    cfg = decodeConfig(q);
    sideA.name = teamLabel(cfg.playerA, cfg.playerA2, cfg.mode) || 'Player A';
    sideB.name = teamLabel(cfg.playerB, cfg.playerB2, cfg.mode) || 'Player B';
    sideA.note = cfg.noteA;
    sideB.note = cfg.noteB;

    // Cross-tab live sync: pick up state written to localStorage by the
    // player view. Keys and shape stay compatible with ScoreBoard's write.
    const KEY = matchStateKey(cfg.mode, q.get('playerA') ?? '', q.get('playerB') ?? '');
    const apply = (raw: string | null) => {
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        if (typeof s?.sideA?.points === 'number') sideA.points = s.sideA.points;
        if (typeof s?.sideB?.points === 'number') sideB.points = s.sideB.points;
        if (typeof s?.sideA?.sets === 'number') sideA.sets = s.sideA.sets;
        if (typeof s?.sideB?.sets === 'number') sideB.sets = s.sideB.sets;
        if (typeof s?.board === 'number') board = s.board;
        if (s?.currentBreak === 'a' || s?.currentBreak === 'b' || s?.currentBreak === null) {
          currentBreak = s.currentBreak;
        }
        if (s?.queenHolder === 'a' || s?.queenHolder === 'b' || s?.queenHolder === null) {
          queenHolder = s.queenHolder;
        }
        if (s?.matchResult === 'a' || s?.matchResult === 'b' || s?.matchResult === null) {
          matchResult = s.matchResult;
        }
      } catch {
        // ignore malformed state
      }
    };
    apply(localStorage.getItem(KEY));
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) apply(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  });

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const ordinal = (n: number) =>
    (['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][n - 1] ?? `${n}th`);
</script>

{#snippet coinSvg()}
  <!-- Carrom queen coin. Fills adapt via --coin-* custom properties on .coin / .coin-red. -->
  <svg viewBox="-16 -16 32 32" width="1.55em" height="1.55em" aria-hidden="true" focusable="false">
    <ellipse cx="0" cy="8" rx="12.5" ry="2" fill="var(--coin-shadow)" />
    <circle cx="0" cy="0" r="13" fill="var(--coin-face)" stroke="var(--coin-outline)" stroke-width="1.2" />
    <circle cx="0" cy="0" r="10.5" fill="none" stroke="var(--coin-ring)" stroke-width="0.9" opacity="0.9" />
    <circle cx="0" cy="0" r="7"    fill="none" stroke="var(--coin-ring)" stroke-width="0.7" opacity="0.75" />
    <circle cx="0" cy="0" r="1.6" fill="var(--coin-ring)" opacity="0.9" />
    <ellipse cx="-4.5" cy="-5.5" rx="4.2" ry="2.5" fill="var(--coin-highlight)" opacity="0.55" transform="rotate(-30)" />
  </svg>
{/snippet}

<div class="overlay">
  {#if cfg.mode === 'practice'}
    <div class="strip practice-strip">
      <span class="practice-note">Practice mode — no live overlay</span>
    </div>
  {:else}
    <div class="strip">
      <!-- Left side: player A. Row order [pill] [break] [coin] mirrors the phone. -->
      <div class="team team-a">
        <div class="name-row">
          <div class="name-pill tone-a"
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
            <span class="name-txt">{sideA.name}</span>
            {#if sideA.note}<span class="name-note">{sideA.note}</span>{/if}
          </div>
          {#if !matchResult && currentBreak === 'a'}
            <span class="mark mark-break tone-a" aria-label="{sideA.name} breaks">
              <span class="mark-lbl">BREAK</span>
            </span>
          {/if}
          {#if !matchResult}
            <span class="coin" class:coin-red={queenHolder === 'a'} aria-label={queenHolder === 'a' ? `${sideA.name} has queen` : 'Queen not held'}>
              {@render coinSvg()}
            </span>
          {/if}
        </div>
        <div class="score-row">
          <span class="digit digit-a">{pad2(sideA.points)}</span>
          <span class="sets-chip">
            <span class="sets-label">SETS</span>
            <span class="sets-num">{sideA.sets}</span>
          </span>
        </div>
      </div>

      <!-- Middle: board + set-pips -->
      <div class="middle">
        {#if cfg.bestOf > 1}
          <div class="pip-strip" aria-label="Set {currentSet} of {cfg.bestOf}">
            {#each setPips() as pip, i (i)}
              <span class="pip pip-{pip}" aria-hidden="true">
                {#if pip === 'a' || pip === 'b'}✓{/if}
              </span>
            {/each}
          </div>
          <div class="set-caption">SET {ordinal(currentSet)}</div>
        {:else}
          <div class="set-caption">SINGLE SET</div>
        {/if}
        <div class="board-block">
          <span class="board-label">BOARD</span>
          <span class="board-num">{board}</span>
          {#if !isBoardsUnlimited(cfg)}
            <span class="board-total">/{cfg.maxBoards}</span>
          {/if}
        </div>
      </div>

      <!-- Right side: player B. Row order [coin] [break] [pill] mirrors the phone. -->
      <div class="team team-b">
        <div class="name-row">
          {#if !matchResult}
            <span class="coin" class:coin-red={queenHolder === 'b'} aria-label={queenHolder === 'b' ? `${sideB.name} has queen` : 'Queen not held'}>
              {@render coinSvg()}
            </span>
          {/if}
          {#if !matchResult && currentBreak === 'b'}
            <span class="mark mark-break tone-b" aria-label="{sideB.name} breaks">
              <span class="mark-lbl">BREAK</span>
            </span>
          {/if}
          <div class="name-pill tone-b"
               class:decided={matchResult !== null}
               class:gold={matchResult === 'b'}
               class:silver={matchResult === 'a'}>
            <span class="name-txt">{sideB.name}</span>
            {#if sideB.note}<span class="name-note">{sideB.note}</span>{/if}
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
        </div>
        <div class="score-row">
          <span class="sets-chip">
            <span class="sets-label">SETS</span>
            <span class="sets-num">{sideB.sets}</span>
          </span>
          <span class="digit digit-b">{pad2(sideB.points)}</span>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body) {
    background: transparent !important;
  }
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 4vh;
    pointer-events: none;
    /* Fallbacks for the CSS custom side colours — keep in sync with the
       app's global tokens so the overlay reads identically on-air. */
    --side-a: #4fc3f7;
    --side-b: #ff8a65;
    --accent: #ffd54a;
  }

  /*
   * Bottom-third strip. Slight card lift + backdrop-blur so the score
   * stays legible even over cluttered camera footage. Broadcasters can
   * still see the underlying feed through the strip's transparency.
   */
  .strip {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: clamp(1rem, 3vw, 2.5rem);
    padding: 1rem 1.5rem;
    background: linear-gradient(180deg, rgba(11,11,11,0.75), rgba(11,11,11,0.92));
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: 2px solid rgba(255,255,255,0.06);
    border-bottom: 2px solid rgba(255,255,255,0.06);
    border-radius: 1.25rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    min-width: min(1100px, 94vw);
    max-width: 96vw;
    color: #fff;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  .team { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  .team-a { align-items: flex-start; }
  .team-b { align-items: flex-end; }

  /*
   * Name row: coloured pill + optional BREAK/QUEEN mark next to it.
   * Layout mirrors the phone scoreboard so viewers who use the app on
   * their own device recognise it instantly on-air.
   */
  .name-row {
    display: inline-flex;
    align-items: center;
    gap: 0.65rem;
    max-width: 100%;
  }
  .team-b .name-row { flex-direction: row; }
  .name-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.35rem 0.85rem;
    border-radius: 0.55rem;
    font-size: clamp(1rem, 1.8vw, 1.4rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #0b0b0b;
    box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    max-width: 100%;
  }
  .name-pill.tone-a { background: var(--side-a); }
  .name-pill.tone-b { background: var(--side-b); }

  /*
   * Winner / runner-up treatment. Mirrors the phone scoreboard's twin-medal
   * design so a broadcast viewer sees the same visual language on-air that
   * the score-keeper sees on the phone.
   *
   * Structural rules (typography, ring, glow, shine) live on .decided so
   * gold and silver render identically at the pixel level; the palette is
   * fed through --pill-c1/c2/c3/text/ring/glow custom properties that only
   * the .gold and .silver modifiers override.
   */
  .name-pill.decided {
    --pill-c1: #fff;
    --pill-c2: #ccc;
    --pill-c3: #888;
    --pill-text: #111;
    --pill-ring: #ccc;
    --pill-glow: rgba(200, 200, 200, 0.5);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #fff;
    position: relative;
    overflow: hidden;
    background: linear-gradient(135deg, var(--pill-c1) 0%, var(--pill-c2) 55%, var(--pill-c3) 100%);
    color: var(--pill-text);
    box-shadow:
      0 0 0 2px var(--pill-ring),
      0 0 22px var(--pill-glow),
      0 3px 12px rgba(0, 0, 0, 0.45);
  }
  .name-pill.decided.gold {
    --pill-c1: #ffd54a;
    --pill-c2: #ffb300;
    --pill-c3: #ff8f00;
    --pill-text: #2b1900;
    --pill-ring: #ffd54a;
    --pill-glow: rgba(255, 213, 74, 0.65);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #fff5d5;
  }
  .name-pill.decided.silver {
    --pill-c1: #f4f7fa;
    --pill-c2: #b6c2cc;
    --pill-c3: #6a7a86;
    --pill-text: #1a232b;
    --pill-ring: #d1dae0;
    --pill-glow: rgba(209, 218, 224, 0.45);
    --chip-bg: rgba(0, 0, 0, 0.28);
    --chip-text: #eef4f7;
  }
  .name-pill.decided::after {
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
  .name-pill .medal {
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
    background: var(--chip-bg, rgba(0,0,0,0.28));
    color: var(--chip-text, #fff);
  }
  .name-pill .medal-icon {
    font-size: 1.15em;
    line-height: 1;
    filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.35));
    animation: medal-bob 2.4s ease-in-out infinite;
  }
  @keyframes medal-bob {
    0%, 100% { transform: translateY(0) rotate(-4deg); }
    50%      { transform: translateY(-2px) rotate(6deg); }
  }

  /*
   * Carrom queen coin (overlay variant). Same SVG paths as the phone
   * scoreboard, same grey→red state via CSS custom properties. Non-
   * interactive on the overlay (view-only), so no button semantics.
   */
  .coin {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
    flex-shrink: 0;
    --coin-face:      #4a4a4a;
    --coin-outline:   #2a2a2a;
    --coin-ring:      rgba(255, 255, 255, 0.28);
    --coin-shadow:    rgba(0, 0, 0, 0.4);
    --coin-highlight: #7a7a7a;
    opacity: 0.55;
  }
  .coin.coin-red {
    --coin-face:      #b21818;
    --coin-outline:   #5a0808;
    --coin-ring:      rgba(255, 200, 200, 0.6);
    --coin-shadow:    rgba(0, 0, 0, 0.6);
    --coin-highlight: #f37070;
    opacity: 1;
    filter: drop-shadow(0 0 6px rgba(220, 40, 40, 0.5));
  }
  .name-txt {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .name-note {
    font-size: 0.7em;
    font-weight: 700;
    letter-spacing: 0.06em;
    opacity: 0.75;
    padding: 0.06rem 0.45rem;
    border-radius: 0.35rem;
    background: rgba(0,0,0,0.22);
    flex-shrink: 0;
  }

  /*
   * BREAK marker on overlay. One constant colour (accent gold) matches
   * the phone chip — the mark communicates a state, not a side. Larger
   * touch-agnostic padding since the overlay is view-only.
   */
  .mark {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.25rem 0.65rem 0.25rem 0.55rem;
    border-radius: 999px;
    color: var(--accent);
    background: linear-gradient(120deg, rgba(255, 213, 74, 0.22), rgba(255, 213, 74, 0.08));
    border: 1.5px solid var(--accent);
    box-shadow: inset 0 0 8px rgba(255, 213, 74, 0.14), 0 0 8px rgba(255, 213, 74, 0.2);
    font-size: clamp(0.62rem, 1vw, 0.75rem);
    font-weight: 800;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    line-height: 1;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .mark-lbl { line-height: 1; }

  /*
   * Score row: big 7-segment digit + a compact SETS chip. Sides mirror
   * horizontally: A's digit is left, B's is right, so the eye tracks
   * naturally from the players' seats on-camera.
   */
  .score-row {
    display: inline-flex;
    align-items: center;
    gap: 0.75rem;
  }
  .team-b .score-row { justify-content: flex-end; }

  .digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    line-height: 0.85;
    font-size: clamp(3.2rem, 6.5vw, 5rem);
    letter-spacing: 0.05em;
  }
  .digit-a { color: var(--side-a); text-shadow: 0 0 18px rgba(79,195,247,0.5); }
  .digit-b { color: var(--side-b); text-shadow: 0 0 18px rgba(255,138,101,0.5); }

  .sets-chip {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.3rem 0.7rem;
    background: rgba(255,255,255,0.08);
    border-radius: 0.55rem;
    line-height: 1;
  }
  .sets-label {
    font-size: 0.62rem;
    letter-spacing: 0.14em;
    color: rgba(255,255,255,0.55);
    font-weight: 700;
    text-transform: uppercase;
  }
  .sets-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-size: clamp(1.3rem, 2.5vw, 1.8rem);
    color: #fff;
    line-height: 1;
  }

  /*
   * Middle column: set-pip strip, "SET Nth" caption, and the BOARD block.
   * All centred so the numbers read as a shared reference between the
   * two teams.
   */
  .middle {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0 clamp(0.5rem, 1.5vw, 1rem);
    border-left: 1px solid rgba(255,255,255,0.12);
    border-right: 1px solid rgba(255,255,255,0.12);
  }
  .pip-strip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.2rem 0.5rem;
    background: rgba(255,255,255,0.04);
    border-radius: 999px;
    line-height: 1;
  }
  .pip {
    width: 0.85rem;
    height: 0.85rem;
    border-radius: 999px;
    border: 2px solid rgba(255,255,255,0.2);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.55rem;
    font-weight: 800;
    color: #0b0b0b;
  }
  .pip.pip-a { background: var(--side-a); border-color: var(--side-a); }
  .pip.pip-b { background: var(--side-b); border-color: var(--side-b); }
  .pip.pip-current {
    background: transparent;
    border-color: var(--accent);
    box-shadow: 0 0 8px rgba(255,213,74,0.4);
    animation: pip-pulse 1.6s ease-in-out infinite;
  }
  .pip.pip-pending { background: transparent; border-color: rgba(255,255,255,0.15); }
  @keyframes pip-pulse {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.15); }
  }
  .set-caption {
    color: rgba(255,255,255,0.55);
    font-size: 0.68rem;
    letter-spacing: 0.16em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .board-block {
    display: inline-flex;
    align-items: baseline;
    gap: 0.35rem;
    margin-top: 0.15rem;
  }
  .board-label {
    color: rgba(255,255,255,0.55);
    font-size: 0.7rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .board-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    font-size: clamp(2rem, 3.4vw, 2.6rem);
    color: var(--accent);
    line-height: 1;
    text-shadow: 0 0 14px rgba(255,213,74,0.45);
  }
  .board-total {
    color: rgba(255,255,255,0.35);
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-size: 1rem;
    line-height: 1;
  }

  /* Practice mode: overlay isn't meaningful, keep the tiny hint we shipped in v1.7. */
  .practice-strip { min-width: 0; padding: 0.6rem 1.25rem; }
  .practice-note {
    color: rgba(255,255,255,0.55);
    font-size: 0.85rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* Tighten spacing on smaller streams (720p windows, tight OBS canvases). */
  @media (max-width: 720px) {
    .strip { padding: 0.75rem 1rem; min-width: 0; gap: 0.75rem; }
    .middle { padding: 0 0.35rem; }
  }
</style>
