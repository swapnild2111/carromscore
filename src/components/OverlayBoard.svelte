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
  import type { LiveRecord } from '../lib/live-sync';

  /*
   * Broadcast overlay. Renders a transparent bottom-third strip that OBS
   * or Prism can layer over a live camera feed of a carrom match.
   *
   * Two data sources, selected via the optional `record` prop:
   *   1. Prop-driven (record supplied): used by LiveLobby's
   *      /live/?mid=X&view=overlay route. State comes from the
   *      Firebase /live/{mid} subscription — remote broadcast, umpire
   *      and streamer can be on different machines.
   *   2. Standalone (no prop): the /score/?view=overlay route. State
   *      comes from the URL query string (config) + localStorage
   *      subscription (state, cross-tab on the same device) — for
   *      single-machine setups where OBS and the phone browser sit
   *      on the same laptop.
   *
   * Visual language identical either way: coloured player pills, DSEG7
   * 7-segment digits, set-pip strip, small BREAK / QUEEN indicators.
   */

  type Props = { record?: LiveRecord | null };
  const { record = null }: Props = $props();

  type SideState = { name: string; namePartA: string; namePartB: string; note: string; sets: number; points: number };

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<SideState>({ name: 'Player A', namePartA: '', namePartB: '', note: '', sets: 0, points: 0 });
  let sideB = $state<SideState>({ name: 'Player B', namePartA: '', namePartB: '', note: '', sets: 0, points: 0 });
  let board = $state(0);
  let currentBreak = $state<Side | null>(null);
  let queenHolder = $state<Side | null>(null);
  let matchResult = $state<Side | 'draw' | null>(null);
  // Practice/solo per-board missed-shot matrix + which set is active.
  // Published by ScoreBoard's writeLocalStorage so the overlay can
  // render every board in the set instead of just the current one.
  let practiceBoards = $state<number[][]>([]);
  let practiceSetIdx = $state(0);

  // Overlay pills are tight; a full name like "Vethanayagam Antonio
  // Sylvester" wraps or clips. Show the first token only, and for
  // doubles apply per-partner before teamLabel joins them so the
  // pill reads "SWAPNIL & YUVARAJ" instead of the full four names.
  const firstName = (s: string) => (s ?? '').trim().split(/\s+/)[0] ?? '';

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

  /**
   * Compute pill labels from a config. Solo shows the full player
   * name (has its own row, room to breathe); singles/doubles use
   * first-name-only in the pill since the pill competes with the
   * digit for horizontal budget.
   */
  function applyConfig(next: MatchConfig): void {
    cfg = next;
    const soloName = next.mode === 'practice';
    const nameA1 = soloName ? next.playerA : firstName(next.playerA);
    const nameA2 = soloName ? next.playerA2 : firstName(next.playerA2);
    const nameB1 = soloName ? next.playerB : firstName(next.playerB);
    const nameB2 = soloName ? next.playerB2 : firstName(next.playerB2);
    sideA.name = teamLabel(nameA1, nameA2, next.mode) || 'Player A';
    sideB.name = teamLabel(nameB1, nameB2, next.mode) || 'Player B';
    sideA.namePartA = nameA1;
    sideA.namePartB = next.mode === 'doubles' ? nameA2 : '';
    sideB.namePartA = nameB1;
    sideB.namePartB = next.mode === 'doubles' ? nameB2 : '';
    sideA.note = next.noteA;
    sideB.note = next.noteB;
  }

  /**
   * Apply a LiveRecord (from Firebase /live/{mid}) to the reactive
   * fields. Shape mirrors LivePayload — used by the prop-driven
   * /live/?view=overlay flow. Meta may change between calls (name
   * typo fix mid-match) so we re-derive pill labels every time.
   */
  function applyRecord(r: LiveRecord): void {
    const m = r.meta;
    applyConfig({
      ...DEFAULT_CONFIG,
      mode: m.mode,
      playerA: m.playerA,
      playerA2: m.playerA2 ?? '',
      playerB: m.playerB,
      playerB2: m.playerB2 ?? '',
      noteA: m.noteA ?? '',
      noteB: m.noteB ?? '',
      bestOf: m.bestOf,
      pointsTarget: m.pointsTarget,
      maxBoards: m.maxBoards,
      tournament: m.tournament ?? '',
    });
    const s = r.liveState;
    sideA.points = s.sideA.points;
    sideB.points = s.sideB.points;
    sideA.sets = s.sideA.sets;
    sideB.sets = s.sideB.sets;
    board = s.board;
    currentBreak = s.currentBreak;
    queenHolder = s.queenHolder;
    matchResult = s.matchResult;
    if (s.practiceBoards) practiceBoards = s.practiceBoards;
    // Prefer the umpire's actual paging position from RTDB. Fallback
    // (older clients that don't publish it): infer as the last set
    // with any non-zero cell — right most of the time, one miss
    // behind reality at the start of a fresh set.
    if (typeof s.practiceSetIdx === 'number') {
      practiceSetIdx = s.practiceSetIdx;
    } else if (s.practiceBoards) {
      let last = 0;
      for (let i = 0; i < s.practiceBoards.length; i += 1) {
        if (s.practiceBoards[i]?.some((v) => v > 0)) last = i;
      }
      practiceSetIdx = last;
    }
  }

  onMount(() => {
    // Prop-driven path (/live/?mid=X&view=overlay). Parent (LiveLobby)
    // owns the Firebase subscription and passes fresh LiveRecords
    // through; a $effect below reacts to every prop update.
    if (record) {
      applyRecord(record);
      return;
    }
    // Standalone path (/score/?view=overlay): parse URL config, then
    // subscribe to the cross-tab localStorage key for state updates.
    const q = new URLSearchParams(window.location.search);
    applyConfig(decodeConfig(q));
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
        if (s?.matchResult === 'a' || s?.matchResult === 'b' || s?.matchResult === 'draw' || s?.matchResult === null) {
          matchResult = s.matchResult;
        }
        if (
          Array.isArray(s?.practiceBoards) &&
          s.practiceBoards.every((row: unknown) =>
            Array.isArray(row) && row.every((v: unknown) => typeof v === 'number'),
          )
        ) {
          practiceBoards = s.practiceBoards as number[][];
        }
        if (typeof s?.practiceSetIdx === 'number') practiceSetIdx = s.practiceSetIdx;
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

  // Prop-driven live updates. Fires every time the parent hands us a
  // new LiveRecord (Firebase subscription re-emits on each write).
  $effect(() => {
    if (record) applyRecord(record);
  });

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const ordinal = (n: number) =>
    (['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th'][n - 1] ?? `${n}th`);
</script>

{#snippet nameTxt(side: SideState)}
  {#if side.namePartB}
    <!-- Doubles: three-line stack — first partner / & / second partner. -->
    <span class="name-txt name-txt-stack">
      <span class="name-line">{side.namePartA}</span>
      <span class="name-amp">&amp;</span>
      <span class="name-line">{side.namePartB}</span>
    </span>
  {:else}
    <span class="name-txt">{side.name}</span>
  {/if}
{/snippet}

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
    <!--
      Practice / solo overlay (v3.4.8). Layout mirrors the production
      LiveScoreboardView practice grid: name pill on the left, then
      one equal-sized digit tile per board, and a TOTAL tile on the
      right — every tile the same big DSEG7 clamp so the row reads
      as one uniform score line rather than "one big score + tiny
      per-board footnotes".
    -->
    <!--
      `--tile-count` = boards + 1 (TOTAL). Drives per-tile width AND
      the digit clamp so fewer boards → bigger digits, and the strip
      always fills the horizontal budget instead of huddling in the
      middle.
    -->
    <div
      class="strip practice-strip"
      style="--tile-count: {isBoardsUnlimited(cfg) ? 2 : cfg.maxBoards + 1};"
    >
      <div class="team team-a team-inline">
        <div class="name-pill tone-a">
          {@render nameTxt(sideA)}
          {#if sideA.note}<span class="name-note">{sideA.note}</span>{/if}
        </div>
      </div>
      {#if !isBoardsUnlimited(cfg)}
        <!--
          Solo overlay always shows only the currently-active set —
          matches the umpire's phone: whichever set they're paging
          through, the overlay follows via `practiceSetIdx` on the
          Firebase / localStorage payload. A small SET header pill
          on the left of the tile row tells the viewer which set of
          the bestOf run they're watching.
        -->
        {@const row = practiceBoards[practiceSetIdx] ?? []}
        {@const setTotal = row.reduce((s, v) => s + (v ?? 0), 0)}
        <div class="active-set-row" aria-label="Set {practiceSetIdx + 1} of {cfg.bestOf}">
          {#if cfg.bestOf > 1}
            <div class="set-header-pill">
              <span class="set-header-lbl">SET</span>
              <span class="set-header-num">{practiceSetIdx + 1}<span class="set-header-total">/{cfg.bestOf}</span></span>
            </div>
          {/if}
          <div class="board-tiles">
            {#each Array(cfg.maxBoards) as _, boardIdx (boardIdx)}
              {@const missed = row[boardIdx] ?? 0}
              {@const isCurrent = boardIdx === Math.min(board, cfg.maxBoards - 1)}
              <div class="board-tile" class:board-tile-current={isCurrent}>
                <span class="board-tile-lbl">B{boardIdx + 1}</span>
                <span class="digit digit-a board-tile-digit">{missed}</span>
              </div>
            {/each}
            <div class="board-tile board-tile-total">
              <span class="board-tile-lbl">TOTAL</span>
              <span class="digit digit-mid board-tile-digit">{setTotal}</span>
            </div>
          </div>
        </div>
      {:else}
        <!--
          Unlimited-boards fallback: no fixed count to enumerate,
          so show the rolling BOARD digit + running MISSED total.
        -->
        <div class="board-tiles" aria-label="Solo practice">
          <div class="board-tile">
            <span class="board-tile-lbl">BOARD</span>
            <span class="digit digit-mid board-tile-digit">{board}</span>
          </div>
          <div class="board-tile board-tile-total">
            <span class="board-tile-lbl">MISSED</span>
            <span class="digit digit-a board-tile-digit">{pad2(sideA.points)}</span>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="strip">
      <!--
        Side A. v3.4.2 layout: single horizontal row with the name pill
        pinned to the OUTER (left) edge, digit next, SETS chip inside.
        BREAK + coin sit between the name and the digit so the strongest
        state indicators cluster near the score.
      -->
      <div class="team team-a team-inline">
        <div class="name-pill tone-a"
             class:decided={matchResult !== null}
             class:gold={matchResult === 'a'}
             class:silver={matchResult === 'b'}
             class:draw={matchResult === 'draw'}>
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
          {@render nameTxt(sideA)}
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
        <span class="digit digit-a">{pad2(sideA.points)}</span>
        <!--
          SETS chip only in best-of-N matches. In a bo=1 match SETS is
          always 0/0, and the middle column already renders "SINGLE
          SET", so the per-team chip just duplicates that info and
          adds visual clutter (v3.4.5 feedback).
        -->
        {#if cfg.bestOf > 1}
          <span class="sets-chip">
            <span class="sets-label">SETS</span>
            <span class="sets-num">{sideA.sets}</span>
          </span>
        {/if}
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

      <!--
        Side B. Mirror of A: SETS chip → digit → BREAK/coin → name pill
        pinned to the OUTER (right) edge.
      -->
      <div class="team team-b team-inline">
        {#if cfg.bestOf > 1}
          <span class="sets-chip">
            <span class="sets-label">SETS</span>
            <span class="sets-num">{sideB.sets}</span>
          </span>
        {/if}
        <span class="digit digit-b">{pad2(sideB.points)}</span>
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
             class:silver={matchResult === 'a'}
             class:draw={matchResult === 'draw'}>
          {@render nameTxt(sideB)}
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
          {:else if matchResult === 'draw'}
            <span class="medal" aria-label="Draw">
              <span class="medal-icon" aria-hidden="true">🤝</span>
              <span class="medal-label">DRAW</span>
            </span>
          {/if}
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
    gap: clamp(1.25rem, 3.5vw, 3rem);
    padding: 1.4rem 2rem;
    background: linear-gradient(180deg, rgba(11,11,11,0.75), rgba(11,11,11,0.92));
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border-top: 2px solid rgba(255,255,255,0.06);
    border-bottom: 2px solid rgba(255,255,255,0.06);
    border-radius: 1.25rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    /*
     * No fixed min-width. v3.4.4: broadcasters (notably Prism) overlay
     * their own logo in the free corner of the frame, and the reserved
     * empty space on either side of the strip was eating into that
     * corner. Let the strip collapse to its content width so the
     * external logo has all the free canvas it wants; the strip only
     * takes the room it needs.
     */
    max-width: 96vw;
    color: #fff;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }

  .team { display: flex; flex-direction: column; gap: 0.55rem; min-width: 0; }
  .team-a { align-items: flex-start; }
  .team-b { align-items: flex-end; }
  /*
   * Inline layout (v3.4.2): name pill + digit + sets chip on a single
   * horizontal row. `.team-a.team-inline` reads left→right as
   * [NAME] [BREAK] [COIN] [DIGIT] [SETS]; `.team-b.team-inline` mirrors
   * to [SETS] [DIGIT] [COIN] [BREAK] [NAME]. Both anchor the name pill
   * to the outer edge of the strip so the eye tracks name → score
   * naturally from each corner of the frame.
   */
  .team-inline {
    flex-direction: row;
    align-items: center;
    gap: clamp(0.5rem, 1.2vw, 1rem);
    min-width: 0;
  }
  .team-a.team-inline { justify-content: flex-start; }
  .team-b.team-inline { justify-content: flex-end; }
  /*
   * Practice/solo variant (v3.4.10). Two-row stack: name pill on
   * top, tiles below at full width. Matches the production
   * LiveScoreboardView layout — the name is a header, not a
   * side-anchor, so the digit tiles get both the full horizontal
   * budget and their own row of vertical space.
   */
  .practice-strip {
    grid-template-columns: 1fr;
    grid-auto-rows: auto;
    row-gap: 0.7rem;
    align-items: center;
    justify-items: center;
    width: 96vw;
  }
  .practice-strip .team-inline {
    justify-content: center;
  }
  /*
   * Solo pill: single-row horizontal layout — [NAME] [COUNTRY].
   * Overrides the vertical stack that singles/doubles use, because
   * solo has only one player so there's no need to stack the note
   * under the name to save width.
   */
  .practice-strip .name-pill {
    flex-direction: row;
    align-items: center;
    gap: 0.55rem;
    max-width: none;
    text-align: left;
  }

  /*
   * Name pill: coloured background, capped max-width so a very long
   * doubles-team label (e.g. "SWAPNIL DESHPANDE & YUVARAJ KUMAR") wraps
   * across two lines instead of squeezing the digit off-screen.
   */
  .name-pill {
    /*
     * v3.4.7: pill is a vertical stack so the country/region note
     * (`.name-note`) sits BELOW the player name instead of trailing
     * inline. Doubles pill's three-line "A / & / B" stack is a
     * single flex-column child of this pill, so it renders as one
     * unit centred above the note.
     */
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.25rem;
    padding: 0.45rem 1rem;
    border-radius: 0.6rem;
    font-size: clamp(1.1rem, 2vw, 1.6rem);
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #0b0b0b;
    box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    max-width: min(22ch, 32vw);
    line-height: 1.15;
    text-align: center;
  }
  .name-pill .name-txt {
    white-space: normal;
    word-break: break-word;
  }
  /*
   * Doubles: stack the pill as
   *   FIRST_A
   *     &
   *   FIRST_B
   * so each partner reads clearly on-camera and the "&" is visually a
   * separator, not part of a joined string (v3.4.4 feedback).
   */
  .name-pill .name-txt-stack {
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.05rem;
    line-height: 1;
  }
  .name-pill .name-line {
    display: block;
    white-space: nowrap;
  }
  .name-pill .name-amp {
    display: block;
    font-size: 0.8em;
    opacity: 0.75;
    line-height: 1;
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
  /* Draw: muted warm bronze applied to both pills. */
  .name-pill.decided.draw {
    --pill-c1: #d4b489;
    --pill-c2: #b09068;
    --pill-c3: #7a5f42;
    --pill-text: #1f1610;
    --pill-ring: #c9a56f;
    --pill-glow: rgba(201, 165, 111, 0.4);
    --chip-bg: rgba(0, 0, 0, 0.3);
    --chip-text: #fff2df;
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
   * Broadcast digit size (v3.4.2). Bumped ~1.7× above the earlier clamp
   * so the score reads at brand-word scale on-camera — comparable to a
   * board's sponsor logotype (e.g. "PRISM"). The overlay is not
   * space-constrained: no touch targets, no keyboard, no scroll — the
   * digits are the point. Line-height stays tight (0.85) so ascender
   * headroom doesn't push the strip off the bottom third.
   */
  .digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    line-height: 0.85;
    font-size: clamp(5.5rem, 11vw, 9rem);
    letter-spacing: 0.05em;
  }
  .digit-a { color: var(--side-a); text-shadow: 0 0 24px rgba(79,195,247,0.55); }
  .digit-b { color: var(--side-b); text-shadow: 0 0 24px rgba(255,138,101,0.55); }
  .digit-mid { color: var(--accent); text-shadow: 0 0 20px rgba(255,213,74,0.45); }
  /*
   * Solo/practice tile digits. Now that the name pill lives on its
   * own row above the tiles, the full 96vw goes to tiles. Formula:
   * 96vw shared across N tiles → each tile ~(96/N)vw wide → digit
   * ~65% of that → font-size ≈ 62vw / N. Clamped [3.5rem, 12rem]
   * so a 2-tile fallback stays legible without blowing off the
   * strip and a 12-tile config still reads.
   */
  .practice-strip .digit {
    font-size: clamp(3.5rem, calc(62vw / var(--tile-count, 6)), 12rem);
  }

  /*
   * Active-set row (v3.4.11). Only the currently-played set is
   * rendered — a SET header pill on the outer left tells the viewer
   * which of the bestOf sets is on-screen; the umpire's phone drives
   * `practiceSetIdx`, so the overlay follows their pagination. Grid
   * `auto 1fr` — header sizes to content, tiles claim the rest.
   */
  .active-set-row {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.7rem;
    align-items: stretch;
    width: 100%;
  }
  /* bo=1 fallback: no SET header rendered, so the row is a single
     grid column — the tiles claim it entirely. */
  .active-set-row:not(:has(.set-header-pill)) {
    grid-template-columns: 1fr;
  }
  .set-header-pill {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.15rem;
    padding: 0.5rem 1rem 0.6rem;
    background: rgba(255,213,74,0.08);
    border: 1.5px solid rgba(255,213,74,0.35);
    border-radius: 0.6rem;
    min-width: 4.5rem;
    line-height: 1;
  }
  .set-header-lbl {
    color: rgba(255,213,74,0.8);
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 700;
  }
  .set-header-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    font-size: clamp(2.2rem, 4vw, 3rem);
    color: var(--accent);
    text-shadow: 0 0 14px rgba(255,213,74,0.4);
    line-height: 1;
    display: inline-flex;
    align-items: baseline;
  }
  .set-header-total {
    font-size: 0.5em;
    color: rgba(255,213,74,0.5);
    text-shadow: none;
    margin-left: 0.15em;
  }

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
    font-size: clamp(2rem, 4vw, 3rem);
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
    font-size: clamp(3.2rem, 5.5vw, 4.4rem);
    color: var(--accent);
    line-height: 1;
    text-shadow: 0 0 18px rgba(255,213,74,0.5);
  }
  .board-total {
    color: rgba(255,255,255,0.35);
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-size: 1.4rem;
    line-height: 1;
  }

  /*
   * Practice / solo overlay (v3.4.2): single-side variant. The .strip
   * grid collapses from 1fr auto 1fr → 1fr auto so the team block
   * centres against the middle column (SET pips + BOARD). Same tokens
   * as the two-player strip so brand consistency is free.
   */
  .practice-strip .sets-chip .sets-label {
    color: rgba(255,213,74,0.85);
    letter-spacing: 0.14em;
  }
  /*
   * Per-board strip (practice/solo, fixed maxBoards). One pill per
   * board showing its missed-shot count; the active board glows in
   * the accent colour so a broadcast viewer immediately sees which
   * board is being played.
   */
  /*
   * Solo overlay tiles (v3.4.8). Row of equal-sized dark tiles —
   * one per board + a TOTAL tile — each holding a big DSEG7 digit
   * matching the singles/doubles overlay clamp. Layout mirrors the
   * production LiveScoreboardView practice grid but with the
   * overlay's larger digit language so the row is broadcast-scale
   * rather than lobby-preview-scale.
   */
  .board-tiles {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    gap: 0.6rem;
    align-items: stretch;
    min-width: 0;
    /* Claim the whole row of the parent (.practice-strip is a
       one-column grid now), so tiles share the full 96vw budget
       instead of collapsing to content width. */
    width: 100%;
    justify-self: stretch;
  }
  .board-tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    /* justify-content: flex-start pins the label to the top so the
       big DSEG7 digit (with its tall ascender glyph box) can't creep
       up over it. Was `center` — with a large digit the two children
       were centred as a group and the digit's negative-space rows
       ate into the label above it. */
    justify-content: flex-start;
    gap: 0.5rem;
    padding: 0.55rem 0.7rem 0.7rem;
    background: rgba(15,15,15,0.72);
    border: 1.5px solid rgba(255,255,255,0.14);
    border-radius: 0.6rem;
    min-width: 0;
  }
  .board-tile-lbl {
    color: rgba(255,255,255,0.55);
    font-size: 0.75rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    font-weight: 700;
    line-height: 1;
    /* Ensure the label sits ABOVE the digit's stacking context —
       belt-and-braces in case a future digit shadow spills up. */
    z-index: 1;
  }
  .board-tile-digit {
    /* Line-height 1 gives the DSEG7 glyph its full internal
       headroom so the top of the "0" / "8" doesn't overlap into
       the label's row above. Was 0.85 which packed too tight. */
    line-height: 1;
  }
  .board-tile-current {
    border-color: var(--accent);
    box-shadow: 0 0 14px rgba(255,213,74,0.35);
  }
  .board-tile-current .board-tile-lbl { color: var(--accent); }
  .board-tile-total { border-color: rgba(255,213,74,0.35); }
  .board-tile-total .board-tile-lbl { color: rgba(255,213,74,0.8); }

  /* Tighten spacing on smaller streams (720p windows, tight OBS canvases). */
  @media (max-width: 720px) {
    .strip { padding: 0.75rem 1rem; min-width: 0; gap: 0.75rem; }
    .middle { padding: 0 0.35rem; }
  }
</style>
