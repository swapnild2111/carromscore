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
  import { flagEmoji } from '../lib/countries';
  import V2CornerCards from './overlay-variants/V2CornerCards.svelte';
  import V3TopTicker from './overlay-variants/V3TopTicker.svelte';
  import V4SideRail from './overlay-variants/V4SideRail.svelte';
  import V5Scorebug from './overlay-variants/V5Scorebug.svelte';

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

  // Variant switching: /score/?view=overlay&variant=1..5 picks a
  // layout. 1 = current lower-third strip (default), 2 = corner
  // cards, 3 = top ticker, 4 = right side rail, 5 = scorebug.
  // Demo backdrop: &bg=demo paints a subtle checker so the umpire
  // can see overlay transparency against something in Chrome
  // instead of an all-black chrome window.
  let variant = $state(1);
  let demoBg = $state(false);
  // Middle-column sub-variant selector for V1 versus overlay.
  // 0 = current (SET pips + BOARD digit); 1..3 = per-set score
  // panel variants. Ignored for practice mode.
  let centreVariant = $state(0);
  // Per-side per-set score chips. Default on for versus bo>1;
  // disable with `?sets=0`. Each side sees its own row of small
  // set-totals sitting between the name pill and the current-set
  // digit — a compact "match history" per player.
  let showSideSets = $state(true);
  // Per-board history — needed to derive per-set final points.
  // Comes from ScoreBoard's writeLocalStorage / publishLive.
  type BoardEntry = { set: number; board: number; breakSide: 'a' | 'b'; queen: 'a' | 'b'; pointsA: number; pointsB: number; endedAt: number };
  let boardLog = $state<BoardEntry[]>([]);

  type SideState = { name: string; namePartA: string; namePartB: string; note: string; country: string; sets: number; points: number };

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<SideState>({ name: 'Player A', namePartA: '', namePartB: '', note: '', country: '', sets: 0, points: 0 });
  let sideB = $state<SideState>({ name: 'Player B', namePartA: '', namePartB: '', note: '', country: '', sets: 0, points: 0 });
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

  /**
   * Per-set final-points summary derived from `boardLog`. Used by
   * the centre-panel sub-variants (centre=1..3). Returns one row
   * per set index in [0, bestOf-1]; each row totals side-A / side-B
   * board points for that set. Unplayed sets read as 0-0.
   */
  const setSummary = $derived.by(() => {
    const rows: { setIdx: number; a: number; b: number; played: boolean; winner: Side | 'tie' | null }[] = [];
    for (let i = 0; i < cfg.bestOf; i += 1) rows.push({ setIdx: i, a: 0, b: 0, played: false, winner: null });
    for (const e of boardLog) {
      if (!e || typeof e.set !== 'number') continue;
      const r = rows[e.set];
      if (!r) continue;
      r.a += e.pointsA ?? 0;
      r.b += e.pointsB ?? 0;
      r.played = true;
    }
    for (const r of rows) {
      if (!r.played) continue;
      if (r.a > r.b) r.winner = 'a';
      else if (r.b > r.a) r.winner = 'b';
      else r.winner = 'tie';
    }
    return rows;
  });

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
    // Solo pill has room for the full player name (renders on its
    // own row above the tile grid, full viewport width). Singles /
    // doubles pills sit inline next to the score digit and BREAK
    // chip → first-name-only, otherwise long names spill off-frame.
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
    // Country codes ride on LiveMeta as of v3.4.5; independent of the
    // note field which doubles as a round tag. Set after applyConfig
    // so we don't wipe them.
    sideA.country = m.countryA ?? '';
    sideB.country = m.countryB ?? '';
    const s = r.liveState;
    sideA.points = s.sideA.points;
    sideB.points = s.sideB.points;
    sideA.sets = s.sideA.sets;
    sideB.sets = s.sideB.sets;
    board = s.board;
    // Firebase RTDB strips explicit-null values before write, so on
    // read the key is `undefined` rather than `null`. The template
    // gates the winner-medal / silver / decided classes on
    // `matchResult !== null` — an undefined would slip through and
    // paint fresh matches with the winner treatment. Coerce here.
    currentBreak = s.currentBreak ?? null;
    queenHolder = s.queenHolder ?? null;
    matchResult = s.matchResult ?? null;
    // boardLog powers the per-set score panel (centreVariant 1..3).
    // Empty-safe: absent → empty array.
    boardLog = Array.isArray(s.boardLog) ? (s.boardLog as BoardEntry[]) : [];
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
    // Country codes ride on the URL as `countryA` / `countryB`
    // (ISO alpha-2, e.g. `DK`). Independent from `noteA` / `noteB`
    // which double as round tags.
    sideA.country = q.get('countryA') ?? '';
    sideB.country = q.get('countryB') ?? '';
    // Variant + demo-backdrop URL flags (see the top-of-file
    // comment for the mapping). Live-record path (/live/?...) can't
    // set the variant from a URL because the parent LiveLobby
    // renders OverlayBoard as a child; leave those on variant=1
    // for now, we can expose a prop later if the umpire wants it.
    const vParam = Number.parseInt(q.get('variant') ?? '', 10);
    if (Number.isFinite(vParam) && vParam >= 1 && vParam <= 5) variant = vParam;
    demoBg = q.get('bg') === 'demo';
    // Middle-column sub-variant for V1 versus: ?centre=1..3 picks
    // a per-set-scores panel design; 0/absent = current SET-pips +
    // BOARD digit block.
    const cParam = Number.parseInt(q.get('centre') ?? '', 10);
    if (Number.isFinite(cParam) && cParam >= 0 && cParam <= 3) centreVariant = cParam;
    if (q.get('sets') === '0') showSideSets = false;
    // Demo-scores seed. `?demo=1` fills the overlay with a
    // plausible mid-match state so the design can be evaluated
    // without driving a real scoreboard. Set 1 won by A (25-16),
    // set 2 won by B (25-12), set 3 in progress (A 18 · B 22).
    // Only fires when the URL doesn't already carry state.
    if (q.get('demo') === '1') {
      sideA.sets = 1;
      sideB.sets = 1;
      sideA.points = 18;
      sideB.points = 22;
      board = 5;
      currentBreak = 'a';
      boardLog = [
        // Set 0: A wins 25-16 across 5 boards.
        { set: 0, board: 1, breakSide: 'a', queen: 'a', pointsA: 7,  pointsB: 0, endedAt: 1 },
        { set: 0, board: 2, breakSide: 'b', queen: 'b', pointsA: 0,  pointsB: 4, endedAt: 2 },
        { set: 0, board: 3, breakSide: 'a', queen: 'a', pointsA: 6,  pointsB: 0, endedAt: 3 },
        { set: 0, board: 4, breakSide: 'b', queen: 'a', pointsA: 5,  pointsB: 0, endedAt: 4 },
        { set: 0, board: 5, breakSide: 'a', queen: 'b', pointsA: 7,  pointsB: 12, endedAt: 5 },
        // Set 1: B wins 25-12.
        { set: 1, board: 1, breakSide: 'b', queen: 'b', pointsA: 0,  pointsB: 8, endedAt: 6 },
        { set: 1, board: 2, breakSide: 'a', queen: 'a', pointsA: 5,  pointsB: 0, endedAt: 7 },
        { set: 1, board: 3, breakSide: 'b', queen: 'b', pointsA: 0,  pointsB: 9, endedAt: 8 },
        { set: 1, board: 4, breakSide: 'a', queen: 'b', pointsA: 3,  pointsB: 8, endedAt: 9 },
        { set: 1, board: 5, breakSide: 'b', queen: 'a', pointsA: 4,  pointsB: 0, endedAt: 10 },
        // Set 2 (in progress): 4 boards done, A: 18, B: 22.
        { set: 2, board: 1, breakSide: 'a', queen: 'a', pointsA: 8,  pointsB: 0, endedAt: 11 },
        { set: 2, board: 2, breakSide: 'b', queen: 'b', pointsA: 0,  pointsB: 10, endedAt: 12 },
        { set: 2, board: 3, breakSide: 'a', queen: 'a', pointsA: 6,  pointsB: 0, endedAt: 13 },
        { set: 2, board: 4, breakSide: 'b', queen: 'b', pointsA: 4,  pointsB: 12, endedAt: 14 },
      ];
      // Solo/practice also gets a plausible miss-count matrix so
      // the tile row + TOTAL show real numbers. Rows = bestOf,
      // cols = maxBoards. Uses cfg after decodeConfig, so respects
      // the URL's shape.
      if (cfg.mode === 'practice') {
        const rows = Math.max(1, cfg.bestOf);
        const cols = Math.max(1, cfg.maxBoards);
        practiceBoards = Array.from({ length: rows }, (_, r) =>
          Array.from({ length: cols }, (_, b) => {
            // Vary the misses so the row isn't uniform.
            if (r < practiceSetIdx) return (b + r + 1) % 4;
            if (r === practiceSetIdx) return b < board ? (b % 3) + 1 : 0;
            return 0;
          }),
        );
        // Also stamp a plausible current-set index + board.
        practiceSetIdx = Math.min(1, rows - 1);
        board = 2;
      }
    }
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
        if (Array.isArray(s?.boardLog)) boardLog = s.boardLog as BoardEntry[];
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

{#if demoBg}
  <!--
    Demo backdrop for browser preview. Painted only when
    `?bg=demo` is set, so OBS / Prism captures still get a
    transparent frame in normal use. A subtle checker + a soft
    green gradient at the top-left simulates a live camera feed
    so the umpire can see how the overlay reads against real
    content (rather than staring at Chrome's black default).
  -->
  <div class="demo-bg" aria-hidden="true"></div>
{/if}

{#if variant === 2}
  <V2CornerCards {cfg} {sideA} {sideB} {board} {currentBreak} {queenHolder} {matchResult} {practiceBoards} {practiceSetIdx} />
{:else if variant === 3}
  <V3TopTicker {cfg} {sideA} {sideB} {board} {currentBreak} {queenHolder} {matchResult} {practiceBoards} {practiceSetIdx} />
{:else if variant === 4}
  <V4SideRail {cfg} {sideA} {sideB} {board} {currentBreak} {queenHolder} {matchResult} {practiceBoards} {practiceSetIdx} />
{:else if variant === 5}
  <V5Scorebug {cfg} {sideA} {sideB} {board} {currentBreak} {queenHolder} {matchResult} {practiceBoards} {practiceSetIdx} />
{:else}
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
          <!--
            Solo pill (v3.4.5): flag glyph inline with the player
            name so a broadcast viewer sees the country at a glance.
            Same flagEmoji() helper the phone scoreboard uses; falls
            back to nothing when the note isn't a recognised country
            code / name.
          -->
          {#if flagEmoji(sideA.country || sideA.note)}
            <span class="name-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
          {/if}
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
      {#if showSideSets && cfg.bestOf > 1}
        <!--
          Set-history column for side A. Sits on the OUTER LEFT of
          the strip (grid column 1), so the reading order is
          `[history] [name/digit] [middle] [name/digit] [history]`.
          Each chip = one set of the bo-N run, showing side A's
          final points for that set. Colour-coded by winner.
        -->
        <div class="side-sets side-sets-a" aria-label="{sideA.name} per-set scores">
          {#each setSummary as row (row.setIdx)}
            {@const isCurrent = row.setIdx === (sideA.sets + sideB.sets) && !matchResult}
            <span class="side-set" class:side-set-current={isCurrent} class:side-set-won={row.winner === 'a'} class:side-set-lost={row.played && row.winner && row.winner !== 'a'}>
              <span class="side-set-lbl">S{row.setIdx + 1}</span>
              <span class="side-set-val">{row.played ? row.a : '–'}</span>
            </span>
          {/each}
        </div>
      {/if}
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
          {#if flagEmoji(sideA.country || sideA.note)}
            <span class="name-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
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
          Per-team SETS chip removed (v3.4.5). It was a third
          encoding of set-count info: the middle set-pips strip
          shows wins-per-side visually, the "SET 1st/2nd/3rd"
          caption below the pips shows which set is being played,
          and this chip added a redundant numeric on each side that
          umpires flagged as duplication.
        -->
      </div>

      <!--
        Middle column. `centreVariant` picks the design:
          0 = default (SET pips + BOARD digit block)
          1 = compact set-row grid (per-set A vs B chips stacked)
          2 = set-columns with winner highlight (S1 S2 S3 header +
              per-side digit strip)
          3 = live-focused stack (current SET/BOARD prominent +
              small history strip)
      -->
      {#if centreVariant === 1 && cfg.bestOf > 1}
        <div class="middle middle-c1" aria-label="Set-by-set scores">
          <div class="c1-header">
            <span class="c1-hdr-cap">SET</span>
            <span class="c1-hdr-cap">A</span>
            <span class="c1-hdr-cap">B</span>
          </div>
          {#each setSummary as row (row.setIdx)}
            <div class="c1-row"
                 class:c1-current={row.setIdx === (sideA.sets + sideB.sets) && !matchResult}
                 class:c1-a-win={row.winner === 'a'}
                 class:c1-b-win={row.winner === 'b'}>
              <span class="c1-set">S{row.setIdx + 1}</span>
              <span class="c1-score c1-a">{row.played ? row.a : '–'}</span>
              <span class="c1-score c1-b">{row.played ? row.b : '–'}</span>
            </div>
          {/each}
          <div class="c1-footer">
            <span class="board-label">B</span>
            <span class="c1-board-num">{board}{isBoardsUnlimited(cfg) ? '' : `/${cfg.maxBoards}`}</span>
          </div>
        </div>
      {:else if centreVariant === 2 && cfg.bestOf > 1}
        <div class="middle middle-c2" aria-label="Set-by-set scores">
          <div class="c2-set-row">
            {#each setSummary as row (row.setIdx)}
              <span class="c2-set-cap"
                    class:c2-current={row.setIdx === (sideA.sets + sideB.sets) && !matchResult}
              >S{row.setIdx + 1}</span>
            {/each}
            <span class="c2-set-cap c2-b-cap">B</span>
          </div>
          <div class="c2-digit-row c2-side-a">
            {#each setSummary as row (row.setIdx)}
              <span class="c2-digit"
                    class:c2-winner={row.winner === 'a'}
                    class:c2-loser={row.played && row.winner && row.winner !== 'a'}>
                {row.played ? row.a : '–'}
              </span>
            {/each}
            <span class="c2-digit c2-board">{board}</span>
          </div>
          <div class="c2-digit-row c2-side-b">
            {#each setSummary as row (row.setIdx)}
              <span class="c2-digit"
                    class:c2-winner={row.winner === 'b'}
                    class:c2-loser={row.played && row.winner && row.winner !== 'b'}>
                {row.played ? row.b : '–'}
              </span>
            {/each}
            <span class="c2-digit c2-board">{isBoardsUnlimited(cfg) ? '∞' : cfg.maxBoards}</span>
          </div>
        </div>
      {:else if centreVariant === 3 && cfg.bestOf > 1}
        <div class="middle middle-c3" aria-label="Set + board with history">
          <div class="c3-head">
            <div class="c3-head-cell">
              <span class="c3-cap">SET</span>
              <span class="c3-big">{sideA.sets + sideB.sets + 1}<span class="c3-total">/{cfg.bestOf}</span></span>
            </div>
            <div class="c3-divider" aria-hidden="true"></div>
            <div class="c3-head-cell">
              <span class="c3-cap">BOARD</span>
              <span class="c3-big">{board}{isBoardsUnlimited(cfg) ? '' : `/${cfg.maxBoards}`}</span>
            </div>
          </div>
          <div class="c3-history">
            {#each setSummary as row (row.setIdx)}
              {@const isCurrentSet = row.setIdx === (sideA.sets + sideB.sets) && !matchResult}
              <span class="c3-chip"
                    class:c3-chip-current={isCurrentSet}
                    class:c3-chip-a-win={row.winner === 'a'}
                    class:c3-chip-b-win={row.winner === 'b'}>
                <span class="c3-chip-lbl">S{row.setIdx + 1}</span>
                <span class="c3-chip-score">{row.played ? `${row.a}-${row.b}` : '– –'}</span>
              </span>
            {/each}
          </div>
        </div>
      {:else}
        <!-- Default centre: SET-pips + BOARD digit block (v3.4.4). -->
        <div class="middle">
          {#if cfg.bestOf > 1}
            <div class="pip-strip" aria-label="Set {currentSet} of {cfg.bestOf}">
              {#each setPips() as pip, i (i)}
                <span class="pip pip-{pip}" aria-hidden="true">
                  {#if pip === 'a' || pip === 'b'}✓{/if}
                </span>
              {/each}
            </div>
            <div class="set-caption">{ordinal(currentSet)} SET</div>
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
      {/if}

      <!--
        Side B. Mirror of A: SETS chip → digit → BREAK/coin → name pill
        pinned to the OUTER (right) edge.
      -->
      <div class="team team-b team-inline">
        <!-- Side-B SETS chip removed to match side A (v3.4.5). -->
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
          {#if flagEmoji(sideB.country || sideB.note)}
            <span class="name-flag" aria-hidden="true">{flagEmoji(sideB.country || sideB.note)}</span>
          {/if}
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
      {#if showSideSets && cfg.bestOf > 1}
        <!--
          Set-history column for side B. Grid column 5 — the OUTER
          RIGHT of the strip. Mirrors side A's outer-left history.
        -->
        <div class="side-sets side-sets-b" aria-label="{sideB.name} per-set scores">
          {#each setSummary as row (row.setIdx)}
            {@const isCurrent = row.setIdx === (sideA.sets + sideB.sets) && !matchResult}
            <span class="side-set" class:side-set-current={isCurrent} class:side-set-won={row.winner === 'b'} class:side-set-lost={row.played && row.winner && row.winner !== 'b'}>
              <span class="side-set-lbl">S{row.setIdx + 1}</span>
              <span class="side-set-val">{row.played ? row.b : '–'}</span>
            </span>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
{/if}

<style>
  :global(html), :global(body) {
    background: transparent !important;
  }
  /*
   * Demo backdrop (v3.4.8) — active only when `?bg=demo` is set on
   * the URL. Paints a subtle diagonal-stripe pattern + a soft
   * green tint so the overlay reads against something that
   * approximates a real camera feed in a Chrome tab. In OBS /
   * Prism this element never renders (URL doesn't carry `bg`).
   */
  .demo-bg {
    position: fixed; inset: 0; pointer-events: none; z-index: -1;
    background:
      radial-gradient(circle at 25% 40%, rgba(43, 89, 63, 0.55), transparent 60%),
      radial-gradient(circle at 75% 65%, rgba(89, 63, 43, 0.55), transparent 60%),
      repeating-linear-gradient(
        45deg,
        #1a1a1a 0,
        #1a1a1a 22px,
        #232323 22px,
        #232323 44px
      );
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
    /*
     * `auto 1fr auto`: pill/digit clusters hug their content on the
     * outer edges, the middle SET/BOARD column stretches to fill
     * the space between. `.strip:has(.side-sets)` below overrides
     * to five columns when the per-side set-history renders.
     */
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: clamp(0.15rem, 0.35vw, 0.4rem);
    padding: 1rem clamp(3rem, 8vw, 8rem);
    background:
      repeating-linear-gradient(
        135deg,
        rgba(255,255,255,0.025) 0,
        rgba(255,255,255,0.025) 6px,
        transparent 6px,
        transparent 12px
      ),
      linear-gradient(180deg, rgba(11,11,11,0.6), rgba(11,11,11,0.82));
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    /*
     * Rounded box floating inset from the viewport edges (1vw margin
     * all sides) — broadcast-graphic shape rather than an infinite
     * ribbon. Full-perimeter accent-gold border + drop shadow.
     */
    border: 2px solid rgba(255,213,74,0.32);
    border-radius: 0.9rem;
    box-shadow: 0 10px 28px rgba(0,0,0,0.55);
    width: calc(100vw - 2vw);
    max-width: calc(100vw - 2vw);
    color: #fff;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  /*
   * Versus bo>1 with per-side set-history: five columns
   * [SETS-A] [TEAM-A] [MIDDLE] [TEAM-B] [SETS-B].
   */
  .strip:has(.side-sets) {
    grid-template-columns: auto auto 1fr auto auto;
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
    /* v3.4.9: matches the versus strip's rounded-box shape.
       Inherits .strip's border/radius/shadow set on the base rule. */
    width: calc(100vw - 2vw);
  }
  .practice-strip .team-inline {
    justify-content: center;
  }
  /*
   * Solo pill: single-row horizontal layout —
   * [FLAG] [NAME] [COUNTRY]. Overrides the vertical stack that
   * singles/doubles use, because solo has only one player so
   * there's no need to stack the note under the name to save
   * width.
   */
  .practice-strip .name-pill {
    flex-direction: row;
    align-items: center;
    gap: 0.55rem;
    max-width: none;
    text-align: left;
  }
  .name-flag {
    font-size: 1.35em;
    line-height: 1;
    flex-shrink: 0;
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
    gap: 0.2rem;
    /* v3.4.8: pill padding scaled down alongside font-size. */
    padding: 0.4rem 0.95rem;
    border-radius: 0.55rem;
    /*
     * v3.4.7: pill font-size bumped so the name reads at brand-word
     * scale on-camera — the strip background is now transparent,
     * so the pill has to carry more visual weight. Was
     * clamp(1.1rem, 2vw, 1.6rem).
     */
    /* v3.4.8: name pill scaled ~15% down. Was clamp(1.4rem, 2.8vw, 2.4rem). */
    font-size: clamp(1.15rem, 2.3vw, 2rem);
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
    /*
     * line-height 1 (was 0.85). DSEG7's glyph box hangs slightly
     * outside its EM at tight leading — with padding + border on
     * the wrapping card, the digit's segments were bleeding above
     * and below the card's border. line-height 1 keeps the glyph
     * inside its own EM box; the wrapping tile's own padding gives
     * the breathing room.
     */
    line-height: 1;
    font-size: clamp(3.4rem, 7vw, 5.6rem);
    letter-spacing: 0.05em;
  }
  .digit-a { color: var(--side-a); text-shadow: 0 0 24px rgba(79,195,247,0.55); }
  .digit-b { color: var(--side-b); text-shadow: 0 0 24px rgba(255,138,101,0.55); }
  .digit-mid { color: var(--accent); text-shadow: 0 0 20px rgba(255,213,74,0.45); }
  /*
   * Versus-branch digit card (v3.4.7): singles/doubles digits sit
   * bare in the team-row. With the outer strip background now
   * transparent, they need their own opaque card to read against
   * a live camera feed — same treatment as the solo tile boxes.
   * Only targets direct-child `.digit` spans of `.team-inline`
   * (which live in the versus branch); solo digits sit inside
   * `.board-tile` and are unaffected.
   */
  .team-inline > .digit {
    /*
     * Card padding. Bumped vertically so the DSEG7 digit's tall
     * glyph stays inside the card border (line-height is 1 now,
     * up from 0.85; the earlier tight padding assumed the shorter
     * line box). Horizontal stays snug so the digit still hugs
     * the middle SET/BOARD column.
     */
    padding: 0.55rem 0.75rem 0.6rem;
    background:
      repeating-linear-gradient(
        135deg,
        rgba(255,255,255,0.02) 0,
        rgba(255,255,255,0.02) 6px,
        transparent 6px,
        transparent 12px
      ),
      rgba(0,0,0,0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1.5px solid rgba(255,255,255,0.14);
    border-radius: 0.5rem;
  }
  /*
   * Solo/practice tile digits. Scales with tile count via the
   * `--tile-count` custom property. Reduced twice on live feedback:
   * v3.4.6 62 → 50vw/N; v3.4.7 further to 42vw/N (~15% shrink) so
   * the tile row leaves more headroom for the name pill above.
   */
  .practice-strip .digit {
    /* v3.4.8: scaled ~18% down. Was 42vw/N, [2.4rem, 8rem]. */
    font-size: clamp(2rem, calc(34vw / var(--tile-count, 6)), 6.6rem);
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
    /*
     * v3.4.7: middle column now carries its own dark card so the
     * SET pips + BOARD digit read against a live camera feed.
     * Left/right dividers dropped — the card carries its own
     * borders now.
     */
    /* v3.4.8: middle column padding tighter + shared stripe pattern. */
    padding: 0.45rem clamp(0.6rem, 1.2vw, 1rem) 0.55rem;
    background:
      repeating-linear-gradient(
        135deg,
        rgba(255,213,74,0.03) 0,
        rgba(255,213,74,0.03) 6px,
        transparent 6px,
        transparent 12px
      ),
      rgba(0,0,0,0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    border: 1.5px solid rgba(255,213,74,0.22);
    border-radius: 0.5rem;
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
    /* v3.4.8: tile padding scaled ~20% down. */
    gap: 0.35rem;
    padding: 0.4rem 0.55rem 0.55rem;
    /*
     * Near-opaque tile background + backdrop-blur so the DSEG7
     * digit doesn't get ghosted by the wood-grain of the carrom
     * table bleeding through on live camera feeds. v3.4.8 adds a
     * subtle diagonal stripe over the flat black — reads as an
     * "informational panel" rather than a flat cutout.
     */
    background:
      repeating-linear-gradient(
        135deg,
        rgba(255,255,255,0.02) 0,
        rgba(255,255,255,0.02) 6px,
        transparent 6px,
        transparent 12px
      ),
      rgba(0,0,0,0.9);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
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
    animation: v1-tile-pulse 2.4s ease-in-out infinite;
  }
  .board-tile-current .board-tile-lbl { color: var(--accent); }
  .board-tile-total {
    border-color: rgba(255,213,74,0.4);
    background:
      linear-gradient(180deg, rgba(255,213,74,0.06), rgba(255,213,74,0.02)),
      rgba(0,0,0,0.85);
  }
  .board-tile-total .board-tile-lbl { color: rgba(255,213,74,0.85); }
  /*
   * Subtle glow pulse on the currently-playing board tile so the
   * broadcast viewer's eye finds the active board instantly. Slow
   * (2.4s cycle) so it doesn't distract from scoring; low
   * intensity so it doesn't compete with the digit's own text
   * shadow. Only the outer glow moves — border colour stays.
   */
  @keyframes v1-tile-pulse {
    0%, 100% { box-shadow: 0 0 10px rgba(255, 213, 74, 0.25); }
    50%      { box-shadow: 0 0 22px rgba(255, 213, 74, 0.55); }
  }

  /* -------------------------------------------------------------
   *  Centre panel sub-variants for the versus (singles/doubles)
   *  branch. Selected via `?centre=1..3` on the /score/ URL.
   *  Each shows per-set final points from `boardLog` so viewers
   *  see the full arc of the match, not just the current set.
   * ------------------------------------------------------------- */

  /* C1 — set-row grid. [SET | A | B] rows stacked, tiny header. */
  .middle-c1 {
    display: grid;
    grid-template-columns: auto auto auto;
    align-items: center;
    justify-items: center;
    gap: 0.15rem 0.55rem;
    padding: 0.4rem 0.75rem 0.5rem;
  }
  .c1-header {
    display: contents;
  }
  .c1-hdr-cap {
    font-size: 0.55rem; letter-spacing: 0.14em; font-weight: 700;
    color: rgba(255,213,74,0.75); text-transform: uppercase;
    padding-bottom: 0.15rem;
  }
  .c1-row {
    display: contents;
  }
  .c1-set {
    font-size: 0.7rem; letter-spacing: 0.06em; font-weight: 800;
    color: rgba(255,255,255,0.6);
    padding: 0.15rem 0.5rem;
    background: rgba(255,255,255,0.06); border-radius: 0.25rem;
    min-width: 1.6rem; text-align: center;
  }
  .c1-current .c1-set {
    color: var(--accent); background: rgba(255,213,74,0.15);
    box-shadow: 0 0 8px rgba(255,213,74,0.25);
  }
  .c1-score {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.15rem; line-height: 1;
    padding: 0.15rem 0.5rem; border-radius: 0.25rem; min-width: 1.9rem; text-align: center;
    background: rgba(255,255,255,0.04);
  }
  .c1-a { color: var(--side-a); }
  .c1-b { color: var(--side-b); }
  .c1-a-win .c1-a { background: rgba(79,195,247,0.22); }
  .c1-b-win .c1-b { background: rgba(255,138,101,0.22); }
  .c1-footer {
    grid-column: 1 / -1;
    display: inline-flex; align-items: baseline; gap: 0.35rem;
    padding-top: 0.35rem; margin-top: 0.15rem;
    border-top: 1px solid rgba(255,213,74,0.2);
    justify-self: stretch; justify-content: center;
  }
  .c1-footer .board-label { font-size: 0.6rem; letter-spacing: 0.14em; }
  .c1-board-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.4rem; color: var(--accent);
    text-shadow: 0 0 12px rgba(255,213,74,0.45);
  }

  /* C2 — set-columns with winner highlight. Header row + per-side digit rows. */
  .middle-c2 {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    padding: 0.45rem 0.7rem 0.55rem;
  }
  .c2-set-row {
    display: flex;
    gap: 0.35rem;
    justify-content: center;
  }
  .c2-set-cap {
    font-size: 0.55rem; letter-spacing: 0.14em; font-weight: 800;
    color: rgba(255,255,255,0.55); text-transform: uppercase;
    padding: 0.1rem 0.35rem; border-radius: 0.2rem;
    min-width: 1.6rem; text-align: center;
    background: rgba(255,255,255,0.05);
  }
  .c2-set-cap.c2-current { color: var(--accent); background: rgba(255,213,74,0.15); }
  .c2-b-cap { color: rgba(255,213,74,0.8); background: rgba(255,213,74,0.08); }
  .c2-digit-row {
    display: flex;
    gap: 0.35rem;
    justify-content: center;
  }
  .c2-digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.35rem; line-height: 1;
    padding: 0.15rem 0.35rem; border-radius: 0.25rem;
    min-width: 1.6rem; text-align: center;
    background: rgba(255,255,255,0.04);
    color: rgba(255,255,255,0.4);
  }
  .c2-side-a .c2-digit { color: rgba(79,195,247,0.5); }
  .c2-side-b .c2-digit { color: rgba(255,138,101,0.5); }
  .c2-side-a .c2-winner { color: var(--side-a); background: rgba(79,195,247,0.2); text-shadow: 0 0 10px rgba(79,195,247,0.5); }
  .c2-side-b .c2-winner { color: var(--side-b); background: rgba(255,138,101,0.2); text-shadow: 0 0 10px rgba(255,138,101,0.5); }
  .c2-side-a .c2-loser  { color: rgba(79,195,247,0.35); }
  .c2-side-b .c2-loser  { color: rgba(255,138,101,0.35); }
  .c2-board {
    color: var(--accent) !important; background: rgba(255,213,74,0.08) !important;
    text-shadow: 0 0 10px rgba(255,213,74,0.45);
  }

  /* C3 — live-focused stack. SET + BOARD prominent at top; small chip strip below. */
  .middle-c3 {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    padding: 0.45rem 0.8rem 0.55rem;
  }
  .c3-head {
    display: flex; align-items: center; gap: 0.5rem;
  }
  .c3-head-cell { display: flex; flex-direction: column; align-items: center; gap: 0.05rem; line-height: 1; }
  .c3-cap { font-size: 0.55rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,213,74,0.8); text-transform: uppercase; }
  .c3-big {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.9rem; color: var(--accent);
    text-shadow: 0 0 14px rgba(255,213,74,0.5); line-height: 1;
    display: inline-flex; align-items: baseline;
  }
  .c3-total { font-size: 0.55em; color: rgba(255,213,74,0.55); text-shadow: none; padding-left: 0.1em; }
  .c3-divider { width: 1px; height: 1.6rem; background: rgba(255,213,74,0.3); }
  .c3-history {
    display: inline-flex; gap: 0.3rem; padding-top: 0.15rem;
    border-top: 1px solid rgba(255,213,74,0.2); padding-top: 0.35rem; margin-top: 0.15rem;
    justify-self: stretch;
  }
  .c3-chip {
    display: inline-flex; flex-direction: column; align-items: center; gap: 0.05rem;
    padding: 0.15rem 0.45rem;
    background: rgba(255,255,255,0.04); border-radius: 0.3rem;
    border: 1px solid transparent;
    line-height: 1;
  }
  .c3-chip-current { border-color: var(--accent); background: rgba(255,213,74,0.08); }
  .c3-chip-a-win { border-color: rgba(79,195,247,0.5); background: rgba(79,195,247,0.12); }
  .c3-chip-b-win { border-color: rgba(255,138,101,0.5); background: rgba(255,138,101,0.12); }
  .c3-chip-lbl { font-size: 0.5rem; letter-spacing: 0.12em; font-weight: 800; color: rgba(255,255,255,0.6); }
  .c3-chip-score {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 0.85rem; color: rgba(255,255,255,0.9);
  }
  .c3-chip-a-win .c3-chip-score { color: var(--side-a); }
  .c3-chip-b-win .c3-chip-score { color: var(--side-b); }

  /* -------------------------------------------------------------
   *  Per-side per-set history chips. Sits between the name pill
   *  and the current-set digit; one small chip per set in the
   *  match's bestOf, showing that side's final points for the set.
   *  Currently-playing set is highlighted; won-set chip picks up
   *  its side's colour; lost-set fades to muted grey. Only renders
   *  for versus mode with bestOf > 1.
   * ------------------------------------------------------------- */
  .side-sets {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: stretch;
    align-self: center;
  }
  .side-set {
    display: grid;
    grid-template-columns: auto 1fr;
    align-items: baseline;
    gap: 0.45rem;
    padding: 0.2rem 0.55rem 0.25rem;
    min-width: 3.2rem;
    background: rgba(0,0,0,0.6);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.35rem;
    line-height: 1;
  }
  .side-set-lbl {
    font-size: 0.55rem;
    letter-spacing: 0.12em;
    font-weight: 800;
    color: rgba(255,255,255,0.55);
    text-transform: uppercase;
  }
  .side-set-val {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700;
    font-size: 1.1rem;
    color: rgba(255,255,255,0.85);
    justify-self: end;
  }
  .side-set-current {
    border-color: var(--accent);
    box-shadow: 0 0 8px rgba(255,213,74,0.3);
  }
  .side-set-current .side-set-lbl { color: var(--accent); }
  /* Side-specific colouring — team A win = blue tint, team B win = orange. */
  .side-sets-a .side-set-won {
    border-color: var(--side-a);
    background: rgba(79,195,247,0.18);
  }
  .side-sets-a .side-set-won .side-set-val {
    color: var(--side-a);
    text-shadow: 0 0 8px rgba(79,195,247,0.4);
  }
  .side-sets-b .side-set-won {
    border-color: var(--side-b);
    background: rgba(255,138,101,0.18);
  }
  .side-sets-b .side-set-won .side-set-val {
    color: var(--side-b);
    text-shadow: 0 0 8px rgba(255,138,101,0.4);
  }
  /* Lost sets fade — they still tell the story ("A got 8 in S2 but
     B got 15") but don't compete with the current set for attention. */
  .side-set-lost .side-set-val { color: rgba(255,255,255,0.35); }
  .side-set-lost .side-set-lbl { color: rgba(255,255,255,0.35); }

  /* Tighten spacing on smaller streams (720p windows, tight OBS canvases). */
  @media (max-width: 720px) {
    .strip { padding: 0.75rem 1rem; min-width: 0; gap: 0.75rem; }
    .middle { padding: 0 0.35rem; }
  }
</style>
