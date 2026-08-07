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
</script>

<div class="wrap">
  <header class="hdr">
    <div
      class="pill pill-a"
      class:gold={state.matchResult === 'a'}
      class:silver={state.matchResult === 'b'}
    >
      <span class="name">{sideName('a')}</span>
      <span class="accs">
        {#if state.currentBreak === 'a'}<span class="chip chip-break">BREAK</span>{/if}
        <span
          class="coin"
          class:coin-on={state.queenHolder === 'a'}
          aria-label={state.queenHolder === 'a' ? 'Queen held by side A' : 'Queen not held'}
        ></span>
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
        <span
          class="coin"
          class:coin-on={state.queenHolder === 'b'}
          aria-label={state.queenHolder === 'b' ? 'Queen held by side B' : 'Queen not held'}
        ></span>
        {#if state.currentBreak === 'b'}<span class="chip chip-break">BREAK</span>{/if}
      </span>
      <span class="name">{sideName('b')}</span>
      {#if sideNote('b')}<span class="note">{sideNote('b')}</span>{/if}
    </div>
  </header>

  <section class="board">
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
    line-height: 1.15;
    min-width: 0;
    overflow-wrap: anywhere;
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
  .pill.gold {
    border-color: rgba(255, 213, 74, 0.8);
    background: linear-gradient(120deg, #2a2410 0%, #1a1610 100%);
    box-shadow: 0 0 24px rgba(255, 213, 74, 0.15);
  }
  .pill.silver {
    border-color: rgba(180, 180, 180, 0.5);
    background: linear-gradient(120deg, #1a1a1a 0%, #131313 100%);
  }

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

  @media (orientation: landscape) and (min-height: 400px) {
    .board { min-height: 12rem; }
    .digit { font-size: clamp(3rem, 12vw, 5rem); }
  }
</style>
