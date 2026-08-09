<script lang="ts">
  /**
   * Pure-visual read-only scoreboard for a LiveRecord snapshot.
   *
   * No Firebase subscription of its own — consumers pass in the record
   * they've already subscribed to (either the standalone `/live/?mid=`
   * spectator page or the lobby's popup, which shares a single lobby
   * subscription). This means we get the full stadium-scoreboard visual
   * language in both contexts without duplicating markup or CSS.
   */
  import '@fontsource/dseg7-classic/700.css';
  import type { LiveRecord } from '../lib/live-sync';

  type Props = { record: LiveRecord };
  const { record }: Props = $props();

  const meta = $derived(record.meta);
  const state = $derived(record.liveState);

  function sideName(side: 'a' | 'b'): string {
    if (meta.mode === 'doubles') {
      const p1 = side === 'a' ? meta.playerA : meta.playerB;
      const p2 = side === 'a' ? meta.playerA2 : meta.playerB2;
      return p1 && p2 ? `${p1} & ${p2}` : p1 || p2 || (side === 'a' ? 'Team A' : 'Team B');
    }
    return (side === 'a' ? meta.playerA : meta.playerB) || (side === 'a' ? 'Side A' : 'Side B');
  }

  function sideNote(side: 'a' | 'b'): string {
    return (side === 'a' ? meta.noteA : meta.noteB) ?? '';
  }

  function pad2(n: number): string {
    return n <= 9 ? ' ' + n : String(n);
  }

  /**
   * Group the board log by set + compute per-set totals. Consumed by
   * the MCA-style set-summary strip and the collapsible board-by-board
   * table. Empty when there's no boardLog.
   *
   * The set index is 0-based (matches how BoardEntry.set was written).
   * Each group has:
   *   { setIdx, boards[], totalA, totalB, winner: 'a' | 'b' | 'tie' | null }
   * Winner uses per-set points comparison; a tied set is unusual but
   * technically possible if the umpire ends a set at equal points.
   */
  type BoardEntry = {
    set: number;
    board: number;
    breakSide: 'a' | 'b';
    queen: 'a' | 'b';
    pointsA: number;
    pointsB: number;
    endedAt: number;
  };
  type SetGroup = {
    setIdx: number;
    boards: BoardEntry[];
    totalA: number;
    totalB: number;
    winner: 'a' | 'b' | 'tie' | null;
  };
  const setGroups = $derived<SetGroup[]>(() => {
    const rawLog = state.boardLog ?? [];
    // Trim overshoot: a very small number of legacy records
    // (pre-2026-08-09 fix) captured a phantom last board when the
    // umpire tapped BOARD+1 after a set was already decided. The
    // finished-match record's `boardCount` is authoritative; if the
    // stored boardLog exceeds it, drop the tail so the recap reads
    // the same number as the match's board counter. Live records
    // (still-in-flight) have no matchResult so we leave those
    // untrimmed — the boardLog is the source of truth in flight.
    const capped =
      state.matchResult !== null &&
      typeof state.board === 'number' &&
      rawLog.length > state.board
        ? rawLog.slice(0, state.board)
        : rawLog;
    const log = capped;
    if (log.length === 0) return [];
    const bySet = new Map<number, BoardEntry[]>();
    for (const entry of log) {
      const arr = bySet.get(entry.set) ?? [];
      arr.push(entry);
      bySet.set(entry.set, arr);
    }
    const groups: SetGroup[] = [];
    // Iterate 0..bestOf-1 so unplayed sets (bo3 that ended in 2-0)
    // still emit a placeholder group with `boards: []`.
    for (let i = 0; i < meta.bestOf; i += 1) {
      const boards = bySet.get(i) ?? [];
      const totalA = boards.reduce((sum, b) => sum + b.pointsA, 0);
      const totalB = boards.reduce((sum, b) => sum + b.pointsB, 0);
      let winner: SetGroup['winner'] = null;
      if (boards.length > 0) {
        if (totalA > totalB) winner = 'a';
        else if (totalB > totalA) winner = 'b';
        else winner = 'tie';
      }
      groups.push({ setIdx: i, boards, totalA, totalB, winner });
    }
    return groups;
  });

</script>

<div class="wrap" class:wrap-practice={meta.mode === 'practice'}>
{#if meta.mode === 'practice'}
  <!--
    Practice mode has two layers:
      - `practice-hdr` + `practice-board` : overlay-friendly strip
        that mirrors the singles/doubles visual language (single
        name pill + DSEG7 digits for SET / BOARD / MISSES). This
        is what OBS composites over the camera feed.
      - `practice-details` : the full per-set × per-board matrix,
        useful in the spectator popup for a deep dive. Hidden in
        overlay mode via the LiveLobby-scoped .overlay-wrap CSS.
    Grand-total misses is what a viewer wants to see live — a
    high number means the drill is going poorly; low means the
    player's dialling in. Board + set contextualise where in the
    session they are.
  -->
  {@const boards = state.practiceBoards ?? []}
  {@const grandTotal = boards.reduce(
    (s, row) => s + row.reduce((r, v) => r + (v ?? 0), 0),
    0,
  )}
  {@const currentSet = Math.max(1, state.board)}

  <header class="hdr practice-hdr">
    <div class="pill pill-a solo-pill">
      <span class="name">
        <span class="practice-badge" aria-label="Solo practice">SOLO</span>
        {sideName('a')}
      </span>
      {#if sideNote('a')}<span class="note">{sideNote('a')}</span>{/if}
    </div>
  </header>

  <section class="board practice-board">
    <div class="col col-set">
      <div class="lbl">SET</div>
      <div class="digit digit-a">{currentSet}</div>
    </div>
    <div class="col col-board">
      <div class="lbl">BOARD</div>
      <div class="digit digit-mid">{state.board}</div>
    </div>
    <div class="col col-points">
      <div class="lbl">MISSES</div>
      <div class="digit digit-a">{pad2(grandTotal)}</div>
    </div>
  </section>

  <div class="practice-view practice-details">
    {#if boards.length > 0}
      {@const cols = Math.max(...boards.map((row) => row.length), 0)}
      {@const setTotal = (i) => (boards[i] ?? []).reduce((s, v) => s + (v ?? 0), 0)}
      <div class="practice-scroll">
        <table class="practice-table">
          <thead>
            <tr>
              <th class="pt-set-h">SET</th>
              {#each Array.from({ length: cols }, (_, i) => i) as bIdx (bIdx)}
                <th>B{bIdx + 1}</th>
              {/each}
              <th class="pt-total-h">TOTAL</th>
            </tr>
          </thead>
          <tbody>
            {#each boards as row, sIdx (sIdx)}
              <tr class:pt-current={sIdx + 1 === state.board}>
                <td class="pt-set">{sIdx + 1}</td>
                {#each Array.from({ length: cols }, (_, i) => i) as bIdx (bIdx)}
                  <td class="pt-cell">{row[bIdx] ?? 0}</td>
                {/each}
                <td class="pt-total">{setTotal(sIdx)}</td>
              </tr>
            {/each}
          </tbody>
          <tfoot>
            <tr>
              <td class="pt-grand-lbl" colspan={cols + 1}>Total missed</td>
              <td class="pt-grand">{grandTotal}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    {:else}
      <p class="practice-empty">Warming up… no misses recorded yet.</p>
    {/if}
  </div>
{:else}
  <header class="hdr">
    <div
      class="pill pill-a"
      class:gold={state.matchResult === 'a'}
      class:silver={state.matchResult === 'b'}
    >
      <span class="name">
        {#if state.matchResult === 'a'}<span class="trophy" aria-label="Winner">🏆</span>{/if}
        {sideName('a')}
      </span>
      <span class="accs">
        {#if state.currentBreak === 'a'}<span class="chip chip-break">BREAK</span>{/if}
        {#if !state.matchResult}
          <!-- Queen coin: live-only. Once the match ends there's no
               "current queen holder" concept — per-board queen data
               lives in the board-log recap below. -->
          <span
            class="coin"
            class:coin-on={state.queenHolder === 'a'}
            aria-label={state.queenHolder === 'a' ? 'Queen held by side A' : 'Queen not held'}
          ></span>
        {/if}
      </span>
      {#if sideNote('a')}<span class="note">{sideNote('a')}</span>{/if}
    </div>
    <div class="vs">vs</div>
    <div
      class="pill pill-b"
      class:gold={state.matchResult === 'b'}
      class:silver={state.matchResult === 'a'}
    >
      <!-- Pill B: accessories first in DOM so grid `auto 1fr` puts them
           on the LEFT (outer edge, far from vs). Coin comes before
           BREAK so the queen coin ends up at the far-left, matching
           the umpire's score-screen mirror layout. -->
      <span class="accs">
        {#if !state.matchResult}
          <span
            class="coin"
            class:coin-on={state.queenHolder === 'b'}
            aria-label={state.queenHolder === 'b' ? 'Queen held by side B' : 'Queen not held'}
          ></span>
        {/if}
        {#if state.currentBreak === 'b'}<span class="chip chip-break">BREAK</span>{/if}
      </span>
      <span class="name">
        {#if state.matchResult === 'b'}<span class="trophy" aria-label="Winner">🏆</span>{/if}
        {sideName('b')}
      </span>
      {#if sideNote('b')}<span class="note">{sideNote('b')}</span>{/if}
    </div>
  </header>

  <section
    class="board"
    class:winner-a={state.matchResult === 'a'}
    class:winner-b={state.matchResult === 'b'}
  >
    <div class="col col-set">
      <div class="lbl">SET</div>
      <div class="digit digit-a">{state.sideA.sets}</div>
    </div>
    <div class="col col-points">
      <div class="lbl">POINTS</div>
      <div class="digit digit-a">{pad2(state.sideA.points)}</div>
    </div>
    <div class="col col-board">
      <div class="lbl">BOARD</div>
      <div class="digit digit-mid">{state.board}</div>
    </div>
    <div class="col col-points">
      <div class="lbl">POINTS</div>
      <div class="digit digit-b">{pad2(state.sideB.points)}</div>
    </div>
    <div class="col col-set">
      <div class="lbl">SET</div>
      <div class="digit digit-b">{state.sideB.sets}</div>
    </div>
  </section>

  {#if meta.bestOf > 1}
    <div
      class="pips"
      aria-label="Set {state.sideA.sets + state.sideB.sets + 1} of {meta.bestOf}"
    >
      {#each Array.from({ length: meta.bestOf }, (_, i) => i) as pIdx (pIdx)}
        {@const filledByA = pIdx < state.sideA.sets}
        {@const filledByB = pIdx >= state.sideA.sets && pIdx < state.sideA.sets + state.sideB.sets}
        <span class="pip" class:pip-a={filledByA} class:pip-b={filledByB}></span>
      {/each}
    </div>
  {/if}

  <!--
    Board-by-board scorecard. One matrix per set, mirroring a
    tournament scorecard: each board has a row, showing per-side
    per-board Points (delta) and cumulative Score, with the board
    number in the centre. A small ► arrow on the breaking side of
    each row indicates who broke that board; the queen icon 🔴 sits
    next to whichever side pocketed the queen. Total row at the
    bottom highlights the set winner.

    Always expanded (no collapse) so viewers get the full picture
    at a glance. On narrow screens the table can scroll horizontally
    if the fixed cell widths overflow.
  -->
  {#if setGroups().length > 0 && (setGroups()[0].boards.length > 0)}
    {@const groups = setGroups()}
    <div class="scorecard">
      {#each groups as g (g.setIdx)}
        {#if g.boards.length > 0}
          {@const cumulA = []}
          {@const cumulB = []}
          {@const firstBreaker = g.boards[0].breakSide}
          <div class="sc-set">
            <div class="sc-set-head">
              <span class="sc-set-lbl">Set {g.setIdx + 1}</span>
              <span class="sc-set-break">
                First break:
                <strong
                  class:side-a={firstBreaker === 'a'}
                  class:side-b={firstBreaker === 'b'}
                >{sideName(firstBreaker)}</strong>
              </span>
            </div>
            <div class="sc-table" role="table" aria-label="Set {g.setIdx + 1} scorecard">
              <div class="sc-row sc-head" role="row">
                <!--
                  Column semantics — paper-scorecard convention:
                    Score = cumulative running total across boards (bright)
                    Coins = per-board score (coins + queen for that board)
                          rendered dimmer since it's the delta feeding
                          the running Score.
                  Middle `#` is the board number. Queen shown as a small
                  gold `+Q` suffix on the Coins cell of the pocketing
                  side.
                -->
                <span class="sc-cell sc-a-pts" role="columnheader">Score</span>
                <span class="sc-cell sc-a-score" role="columnheader">Coins</span>
                <span class="sc-cell sc-num" role="columnheader">#</span>
                <span class="sc-cell sc-b-score" role="columnheader">Coins</span>
                <span class="sc-cell sc-b-pts" role="columnheader">Score</span>
              </div>
              {#each g.boards as entry (`${entry.set}-${entry.board}`)}
                {@const _cumA = (cumulA.push((cumulA[cumulA.length - 1] ?? 0) + entry.pointsA), cumulA[cumulA.length - 1])}
                {@const _cumB = (cumulB.push((cumulB[cumulB.length - 1] ?? 0) + entry.pointsB), cumulB[cumulB.length - 1])}
                {@const queenA = entry.queen === 'a'}
                {@const queenB = entry.queen === 'b'}
                <!--
                  Column semantics (paper-scorecard convention):
                    Score = cumulative running total across boards
                    Coins = per-board COIN count only (excludes the 3
                            queen points). When this side pocketed the
                            queen, we subtract 3 from their board score
                            to recover the coin count and render a
                            small `+Q` suffix. Displayed as `coins`
                            (or `coins+Q` when queen).
                  Middle `#` is the board number, clean.
                -->
                {@const coinsA = queenA ? Math.max(0, entry.pointsA - 3) : entry.pointsA}
                {@const coinsB = queenB ? Math.max(0, entry.pointsB - 3) : entry.pointsB}
                <div class="sc-row" role="row">
                  <span class="sc-cell sc-a-pts side-a" role="cell">{_cumA}</span>
                  <span class="sc-cell sc-a-score side-a" role="cell">
                    {coinsA}{#if queenA}<span class="sc-q-tag" aria-label="Queen">+Q</span>{/if}
                  </span>
                  <span class="sc-cell sc-num" role="cell">{entry.board}</span>
                  <span class="sc-cell sc-b-score side-b" role="cell">
                    {coinsB}{#if queenB}<span class="sc-q-tag" aria-label="Queen">+Q</span>{/if}
                  </span>
                  <span class="sc-cell sc-b-pts side-b" role="cell">{_cumB}</span>
                </div>
              {/each}
              <div class="sc-row sc-total" role="row">
                <span
                  class="sc-cell sc-a-pts sc-total-val side-a"
                  class:sc-winner={g.winner === 'a'}
                  role="cell"
                >{g.totalA}</span>
                <span class="sc-cell sc-a-score sc-total-empty" role="cell"></span>
                <span class="sc-cell sc-num sc-total-lbl" role="cell">Total</span>
                <span class="sc-cell sc-b-score sc-total-empty" role="cell"></span>
                <span
                  class="sc-cell sc-b-pts sc-total-val side-b"
                  class:sc-winner={g.winner === 'b'}
                  role="cell"
                >{g.totalB}</span>
              </div>
              {#if g.winner === 'a' || g.winner === 'b'}
                <div class="sc-row sc-winner-row" role="row">
                  <span class="sc-cell sc-winner-line" role="cell" style="grid-column: 1 / -1;">
                    <span class="sc-trophy">🏆</span>
                    Set won by
                    <strong class:side-a={g.winner === 'a'} class:side-b={g.winner === 'b'}>
                      {sideName(g.winner)}
                    </strong>
                  </span>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
    </div>
  {/if}
{/if}
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    color: var(--fg, #f5f5f5);
  }

  .hdr {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 1rem;
    padding: 0.25rem 0 0.75rem;
  }

  /* Practice (solo drill) view: mirrors the umpire's own End-of-
     Practice recap dialog. Player name + per-set × per-board table.
     No DSEG7 digits, no side B. Fits inside the popup width; long
     matches (many boards or sets) can scroll horizontally via
     .practice-scroll. */
  .practice-view {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  /*
   * Practice header: reuses the `.pill` / `.hdr` conventions from
   * the singles branch so overlay compositing rules apply
   * automatically. Only one pill (solo player), stretched full-width
   * on wide viewports for visual balance with the singles two-pill
   * layout.
   */
  .practice-hdr {
    display: flex;
    justify-content: center;
    padding: 0.2rem 0 0.5rem;
  }
  .practice-hdr .pill.solo-pill {
    /* Wider than a per-side pill (no vs. mid column) so the name has
       room to breathe. Cap at 32rem so it stays readable in overlay.
       Overrides pill-a's `1fr auto` grid so the name spans full
       width and centres — there's no accessories column in solo. */
    max-width: 32rem;
    width: 100%;
    grid-template-columns: 1fr;
    grid-template-areas: 'name' 'note';
  }
  .practice-hdr .pill.solo-pill .name {
    text-align: center;
  }
  .practice-hdr .pill.solo-pill .note {
    text-align: center;
  }
  .practice-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.05rem 0.4rem;
    margin-right: 0.4rem;
    background: rgba(79, 195, 247, 0.16);
    color: var(--side-a, #4fc3f7);
    border: 1px solid rgba(79, 195, 247, 0.4);
    border-radius: 999px;
    font-size: 0.6rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-weight: 800;
    vertical-align: middle;
  }
  /*
   * 3-column DSEG7 strip for practice: SET · BOARD · MISSES. Reuses
   * .board / .col / .digit tokens from the singles branch so overlay
   * compositing overrides (background tile, compact padding, digit
   * clamp) apply for free.
   */
  .practice-board {
    grid-template-columns: 1fr 1.2fr 1fr;
  }

  .practice-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    background: #101010;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
  }
  .practice-table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
    font-size: 0.9rem;
    min-width: 20rem;
  }
  .practice-table th,
  .practice-table td {
    padding: 0.45rem 0.5rem;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    border-right: 1px solid rgba(255, 255, 255, 0.04);
  }
  .practice-table th:last-child,
  .practice-table td:last-child { border-right: none; }
  .practice-table thead th {
    background: #161616;
    color: var(--muted, #9aa0a6);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    font-weight: 700;
    padding: 0.3rem 0.5rem;
  }
  .practice-table .pt-set-h { color: var(--accent, #ffd54a); }
  .practice-table .pt-total-h { color: var(--fg, #f5f5f5); }
  .practice-table .pt-set {
    color: var(--accent, #ffd54a);
    font-weight: 800;
    background: #0a0a0a;
    width: 2.5rem;
  }
  .practice-table .pt-cell {
    color: var(--side-a, #4fc3f7);
    font-weight: 600;
  }
  .practice-table .pt-total {
    color: var(--fg, #f5f5f5);
    font-weight: 800;
    background: #141414;
  }
  .practice-table tr.pt-current td {
    background: rgba(255, 213, 74, 0.05);
  }
  .practice-table tr.pt-current td.pt-set {
    background: rgba(255, 213, 74, 0.15);
  }
  .practice-table tfoot td {
    background: rgba(255, 213, 74, 0.06);
    border-top: 1px solid rgba(255, 213, 74, 0.35);
    border-bottom: none;
  }
  .practice-table .pt-grand-lbl {
    color: var(--muted, #9aa0a6);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    font-weight: 700;
    text-align: right;
    padding-right: 0.85rem;
  }
  .practice-table .pt-grand {
    color: var(--accent, #ffd54a);
    font-weight: 800;
    font-size: 1rem;
  }

  .practice-empty {
    text-align: center;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    padding: 1.5rem 0.5rem;
    margin: 0;
  }
  /* Pills use a 2-row CSS grid so `note` (country/region) tucks neatly
     under the name while BREAK + queen coin ride on the name's row.

     Pill A (grid areas):        Pill B (grid areas):
       "name accs"                 "accs name"
       "note note"                 "note note"

     `.accs` (accessories) contains the BREAK chip and the queen coin,
     always sitting on the pill's OUTER edge (far from vs). */
  .pill {
    display: grid;
    align-items: center;
    row-gap: 0.15rem;
    column-gap: 0.5rem;
    padding: 0.55rem 0.85rem;
    background: #141414;
    border: 1.5px solid #232323;
    border-radius: 0.7rem;
    min-width: 0;
  }
  /* Two-row layout by default: name + accessories on top, note under.
     On narrow phones the accessories drop to their own third row so
     the name gets the full pill width (otherwise it word-breaks one
     letter at a time). */
  .pill-a {
    border-color: rgba(79, 195, 247, 0.6);
    grid-template-columns: 1fr auto;
    grid-template-areas: 'name accs' 'note note';
  }
  .pill-b {
    border-color: rgba(255, 138, 101, 0.6);
    grid-template-columns: auto 1fr;
    grid-template-areas: 'accs name' 'note note';
  }
  .name {
    grid-area: name;
    font-weight: 700;
    font-size: 1rem;
    line-height: 1.2;
    min-width: 0;
  }
  .pill-a .name { color: var(--side-a); }
  .pill-b .name { color: var(--side-b); text-align: right; }
  .note {
    grid-area: note;
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
    line-height: 1.1;
  }
  .pill-b .note { text-align: right; }
  .accs {
    grid-area: accs;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    flex-shrink: 0;
  }
  .chip {
    padding: 0.12rem 0.4rem;
    font-size: 0.65rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    border-radius: 0.35rem;
    background: linear-gradient(120deg, rgba(255, 213, 74, 0.2), rgba(255, 213, 74, 0.06));
    border: 1px solid rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
    flex-shrink: 0;
  }
  .coin {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border-radius: 50%;
    background: radial-gradient(circle at 30% 30%, #444, #222);
    border: 2px solid #666;
    flex-shrink: 0;
  }
  .coin-on {
    background: radial-gradient(circle at 30% 30%, #ff6b5b, #b71c1c);
    border-color: #ef5350;
    box-shadow: 0 0 8px rgba(239, 83, 80, 0.4);
  }
  .vs {
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  /* Winner pill — much bolder than the previous subtle border tint.
     Solid amber border, warm gold gradient background, gold text on
     the name, glow ring. The trophy emoji inline further hammers it
     home. Reads as "this is the winner" from across a room. */
  .pill.gold {
    border-color: rgba(255, 213, 74, 0.95);
    background: linear-gradient(135deg, #3d3418 0%, #221c0c 100%);
    box-shadow:
      0 0 0 1px rgba(255, 213, 74, 0.5),
      0 0 28px rgba(255, 213, 74, 0.35),
      inset 0 1px 0 rgba(255, 220, 100, 0.15);
  }
  .pill.gold .name { color: var(--accent, #ffd54a); }
  .trophy {
    display: inline-block;
    font-size: 1em;
    margin-right: 0.15rem;
    filter: drop-shadow(0 0 4px rgba(255, 213, 74, 0.6));
  }

  /* Loser pill — stays plain (neutral border, plain white name).
     Winner does all the emphasis; the loser doesn't get "punished"
     with a dim treatment. Cleaner and less patronising. */
  .pill.silver {
    border-color: rgba(160, 160, 160, 0.35);
    background: linear-gradient(135deg, #171717 0%, #101010 100%);
  }
  .pill.silver .name { color: var(--fg, #f5f5f5); }

  /* Score-digit medal treatment: winner side digits shine gold.
     Loser side stays plain white (not dimmed) so the score is still
     clearly readable at a glance. */
  .board.winner-a .digit-a { color: var(--accent, #ffd54a); text-shadow: 0 0 12px rgba(255, 213, 74, 0.35); }
  .board.winner-a .digit-b { color: var(--fg, #f5f5f5); }
  .board.winner-b .digit-b { color: var(--accent, #ffd54a); text-shadow: 0 0 12px rgba(255, 213, 74, 0.35); }
  .board.winner-b .digit-a { color: var(--fg, #f5f5f5); }

  .board {
    display: grid;
    grid-template-columns: 1fr 1.5fr 1fr 1.5fr 1fr;
    gap: 0.4rem;
    padding: 0.5rem 0;
    min-height: 8rem;
  }
  .col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 0.25rem;
    background: #0f0f0f;
    border: 1px solid #1e1e1e;
    border-radius: 0.6rem;
    min-width: 0;
  }
  .lbl {
    color: var(--muted, #9aa0a6);
    font-size: 0.65rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    margin-bottom: 0.35rem;
  }
  .digit {
    font-family: 'DSEG7 Classic', ui-monospace, monospace;
    font-weight: 700;
    font-size: clamp(2.2rem, 8vw, 3.8rem);
    line-height: 1;
    font-variant-numeric: tabular-nums;
    white-space: pre;
  }
  .digit-a { color: var(--side-a); }
  .digit-b { color: var(--side-b); }
  .digit-mid { color: var(--fg, #f5f5f5); }

  .pips {
    display: flex;
    justify-content: center;
    gap: 0.4rem;
    padding: 0.3rem 0 0.4rem;
  }
  .pip {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: #262626;
  }
  .pip-a { background: var(--side-a); }
  .pip-b { background: var(--side-b); }

  /* Narrow-screen (phone popup) refuge: when the pill is too thin
     for name + accessories side-by-side, restack the accessories on
     their own row underneath — accessories anchored to the outer edge
     of the pill (right for pill-a, left for pill-b). */
  @media (max-width: 440px) {
    .pill-a {
      grid-template-columns: 1fr;
      grid-template-areas: 'name' 'accs' 'note';
    }
    .pill-b {
      grid-template-columns: 1fr;
      grid-template-areas: 'name' 'accs' 'note';
    }
    .pill-a .accs { justify-self: end; }
    .pill-b .accs { justify-self: start; }
  }

  /* MCA-style set-summary strip. One horizontal row of small pills
     per side, separated by a `B` divider. Winning-set cells go green,
     losing-set red, unplayed set grey with `–`. Same shorthand
     carrom players already recognise from tournament results. */
  /* Board-by-board scorecard: one matrix per set, styled after a
     classic tournament scorecard printout. Columns mirror around
     the middle 'board number' column so each side reads outward
     from centre. Fixed-width table with horizontal overflow scroll
     on very narrow screens. */
  .scorecard {
    margin-top: 0.65rem;
    padding-top: 0.5rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
    display: flex;
    flex-direction: column;
    gap: 0.85rem;
  }
  .sc-set-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.35rem;
    padding: 0 0.1rem;
  }
  .sc-set-lbl {
    color: var(--accent, #ffd54a);
    font-size: 0.72rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.09em;
  }
  /* "First break: X" note in the set header. Break alternates each
     board, so this one label captures the whole rotation. */
  .sc-set-break {
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
  }
  .sc-set-break strong { font-weight: 700; }
  .sc-set-break .side-a { color: var(--side-a, #4fc3f7); }
  .sc-set-break .side-b { color: var(--side-b, #ff8a65); }

  /* Set wrapper allows the scorecard grid to scroll horizontally
     when the popup is narrower than the min column widths. Padding
     kept minimal so the border sits flush with the popup body. */
  .sc-set {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
  /* The scorecard grid — 5 columns:
        [Points A] [Score A] [# / queen] [Score B] [Points B]
     Each row is a board (+ header + total + winner-line rows).
     Fixed-min-width cells so numbers stay legible; parent .sc-set
     scrolls horizontally if the sum exceeds available width. */
  .sc-table {
    display: grid;
    grid-template-columns:
      minmax(3.75rem, 1fr)   /* A Points */
      minmax(3.75rem, 1fr)   /* A Score  */
      minmax(3.5rem, auto)   /* # / queen */
      minmax(3.75rem, 1fr)   /* B Score  */
      minmax(3.75rem, 1fr);  /* B Points */
    row-gap: 0;
    background: #101010;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
    font-variant-numeric: tabular-nums;
    min-width: 19rem;
  }
  .sc-row {
    display: contents;
  }
  .sc-cell {
    padding: 0.35rem 0.45rem;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    border-right: 1px solid rgba(255, 255, 255, 0.04);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    min-width: 0;
    white-space: nowrap;
  }
  .sc-cell:nth-child(5n) { border-right: none; }
  .sc-row.sc-head .sc-cell,
  .sc-row.sc-total .sc-cell,
  .sc-row.sc-winner-row .sc-cell {
    background: #161616;
  }
  .sc-row.sc-head .sc-cell {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    color: var(--muted, #9aa0a6);
    font-weight: 700;
    padding: 0.3rem 0.35rem;
  }
  .sc-num {
    color: var(--muted, #9aa0a6);
    font-weight: 700;
    background: #0a0a0a;
  }
  .sc-a-pts.side-a,
  .sc-a-score.side-a { color: var(--side-a, #4fc3f7); }
  .sc-b-pts.side-b,
  .sc-b-score.side-b { color: var(--side-b, #ff8a65); }
  .sc-a-score,
  .sc-b-score {
    font-size: 0.72rem;
    color: rgba(255, 255, 255, 0.55);
    font-weight: 500;
  }
  .sc-a-score.side-a { color: rgba(79, 195, 247, 0.7); font-size: 0.75rem; }
  .sc-b-score.side-b { color: rgba(255, 138, 101, 0.7); font-size: 0.75rem; }

  /* Queen indicator: small "+Q" suffix on the Score cell of the side
     that pocketed the queen. Gold-tinted so it reads as a bonus
     modifier without stealing focus from the numeric score. Sits
     tight against the number with a subtle superscript feel. */
  .sc-q-tag {
    font-size: 0.6rem;
    font-weight: 800;
    letter-spacing: 0.03em;
    color: var(--accent, #ffd54a);
    margin-left: 0.15rem;
    vertical-align: baseline;
  }

  /* Total row: highlight the set winner with a gold pill. */
  .sc-row.sc-total .sc-total-lbl {
    color: var(--muted, #9aa0a6);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    font-weight: 700;
  }
  .sc-total-val {
    font-size: 1rem;
    font-weight: 800;
  }
  .sc-total-val.sc-winner {
    color: var(--accent, #ffd54a) !important;
    background: rgba(255, 213, 74, 0.14);
  }
  .sc-total-empty { background: #161616; }

  /* Winner banner row — spans the whole grid width. */
  .sc-winner-row .sc-winner-line {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.4rem 0.5rem;
    background: linear-gradient(90deg, rgba(255, 213, 74, 0.05), rgba(255, 213, 74, 0.14), rgba(255, 213, 74, 0.05));
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    border-bottom: none;
    border-right: none;
    white-space: normal;
  }
  .sc-winner-row .sc-winner-line strong {
    font-weight: 800;
  }
  .sc-winner-row .sc-winner-line .side-a { color: var(--side-a, #4fc3f7); }
  .sc-winner-row .sc-winner-line .side-b { color: var(--side-b, #ff8a65); }
  .sc-trophy { font-size: 0.9rem; }

  /* Narrow-screen: shrink font + padding so the 5-column grid fits
     without horizontal scroll on typical phone widths. */
  @media (max-width: 440px) {
    .sc-cell {
      padding: 0.28rem 0.25rem;
      font-size: 0.78rem;
      gap: 0.15rem;
    }
    .sc-row.sc-head .sc-cell { font-size: 0.55rem; padding: 0.25rem 0.2rem; }
    .sc-total-val { font-size: 0.9rem; }
    .sc-a-score, .sc-b-score { font-size: 0.7rem; }
  }

  @media (orientation: landscape) and (min-height: 400px) {
    .board { min-height: 12rem; }
    .digit { font-size: clamp(3rem, 12vw, 5rem); }
  }
</style>
