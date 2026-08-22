<script lang="ts">
  import '@fontsource/dseg7-classic/700.css';
  import { flagEmoji } from '../../lib/countries';
  import { isBoardsUnlimited } from '../../lib/match';
  import type { OverlayVariantProps } from './types';

  const { cfg, sideA, sideB, board, currentBreak, practiceBoards, practiceSetIdx }: OverlayVariantProps = $props();

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const isPractice = $derived(cfg.mode === 'practice');
</script>

<!--
  V3 (rev 2) — Bottom-Left Ticker. Thin card pinned to the BOTTOM of
  the frame, content left-aligned so the bottom-right corner stays
  clear for the broadcaster's watermark (Prism Live / OBS / Twitch
  indicators). Not full-width — hugs its content plus a small right
  buffer, so a wider camera crop can breathe on the right.
-->
<div class="v3-root">
  <div class="v3-bar" class:v3-bar-practice={isPractice}>
    {#if isPractice}
      <div class="v3-solo">
        <div class="v3-team-cell">
          {#if flagEmoji(sideA.country || sideA.note)}
            <span class="v3-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
          {/if}
          <div class="v3-name-block">
            <span class="v3-name v3-name-a">{sideA.name}</span>
            {#if sideA.note}<span class="v3-note">{sideA.note}</span>{/if}
          </div>
        </div>
        {#if cfg.bestOf > 1}
          <div class="v3-mid-cell">
            <span class="v3-mid-lbl">SET</span>
            <span class="v3-mid-num">{practiceSetIdx + 1}/{cfg.bestOf}</span>
          </div>
        {/if}
        {#if !isBoardsUnlimited(cfg)}
          {@const row = practiceBoards[practiceSetIdx] ?? []}
          {@const total = row.reduce((s, v) => s + (v ?? 0), 0)}
          <div class="v3-tile-row">
            {#each Array(cfg.maxBoards) as _, i (i)}
              {@const missed = row[i] ?? 0}
              {@const isCurr = i === Math.min(board, cfg.maxBoards - 1)}
              <span class="v3-tile" class:v3-tile-current={isCurr}>
                <span class="v3-tile-lbl">B{i + 1}</span>
                <span class="v3-tile-val">{missed}</span>
              </span>
            {/each}
            <span class="v3-tile v3-tile-total">
              <span class="v3-tile-lbl">TOTAL</span>
              <span class="v3-tile-val v3-total">{total}</span>
            </span>
          </div>
        {:else}
          <div class="v3-mid-cell">
            <span class="v3-mid-lbl">BOARD</span>
            <span class="v3-mid-num">{board}</span>
          </div>
        {/if}
      </div>
    {:else}
      <div class="v3-team-cell v3-side-a" class:v3-team-breaking={currentBreak === 'a'}>
        {#if flagEmoji(sideA.country || sideA.note)}
          <span class="v3-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
        {/if}
        <div class="v3-name-block">
          <span class="v3-name v3-name-a">{sideA.name}</span>
          {#if currentBreak === 'a'}<span class="v3-break">BREAK</span>{/if}
        </div>
        <span class="v3-score v3-score-a">{pad2(sideA.points)}</span>
        {#if cfg.bestOf > 1}<span class="v3-sets" aria-label="Sets won">{sideA.sets}</span>{/if}
      </div>
      <span class="v3-vs">VS</span>
      <div class="v3-team-cell v3-side-b" class:v3-team-breaking={currentBreak === 'b'}>
        {#if flagEmoji(sideB.country || sideB.note)}
          <span class="v3-flag" aria-hidden="true">{flagEmoji(sideB.country || sideB.note)}</span>
        {/if}
        <div class="v3-name-block">
          <span class="v3-name v3-name-b">{sideB.name}</span>
          {#if currentBreak === 'b'}<span class="v3-break">BREAK</span>{/if}
        </div>
        <span class="v3-score v3-score-b">{pad2(sideB.points)}</span>
        {#if cfg.bestOf > 1}<span class="v3-sets">{sideB.sets}</span>{/if}
      </div>
      <div class="v3-mid-cell">
        <span class="v3-mid-lbl">{cfg.bestOf > 1 ? 'SET' : 'BOARD'}</span>
        <span class="v3-mid-num">{cfg.bestOf > 1 ? `${sideA.sets + sideB.sets + 1}/${cfg.bestOf}` : `${board}${isBoardsUnlimited(cfg) ? '' : `/${cfg.maxBoards}`}`}</span>
      </div>
      {#if cfg.bestOf > 1 && !isBoardsUnlimited(cfg)}
        <div class="v3-mid-cell">
          <span class="v3-mid-lbl">BOARD</span>
          <span class="v3-mid-num">{board}/{cfg.maxBoards}</span>
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  :global(html), :global(body) { background: transparent !important; }
  .v3-root {
    position: fixed; inset: 0; pointer-events: none;
    --side-a: #4fc3f7; --side-b: #ff8a65; --accent: #ffd54a;
    color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  /*
   * Pinned bottom-left. `right: auto` + `max-width: 78vw` reserves
   * the bottom-right quadrant for a broadcaster's watermark (Prism /
   * OBS / Twitch record indicator).
   */
  .v3-bar {
    position: absolute;
    bottom: 4vh; left: 3vw; right: auto;
    max-width: 78vw;
    display: flex; align-items: center; gap: clamp(0.6rem, 1.4vw, 1.2rem);
    padding: 0.6rem 1rem;
    background: linear-gradient(180deg, rgba(0,0,0,0.92), rgba(0,0,0,0.82));
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-radius: 0.75rem;
    border: 1.5px solid rgba(255,255,255,0.1);
    box-shadow: 0 8px 24px rgba(0,0,0,0.55);
  }
  .v3-bar-practice { flex-wrap: wrap; }
  /* Team cell — flag · name/break · score · sets */
  .v3-team-cell {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.35rem 0.65rem;
    border-radius: 0.5rem;
  }
  .v3-side-a { background: linear-gradient(90deg, rgba(79,195,247,0.22), rgba(79,195,247,0.04)); border-left: 3px solid var(--side-a); }
  .v3-side-b { background: linear-gradient(90deg, rgba(255,138,101,0.22), rgba(255,138,101,0.04)); border-left: 3px solid var(--side-b); }
  .v3-team-breaking { box-shadow: 0 0 0 1.5px rgba(255,213,74,0.55) inset; }
  .v3-flag { font-size: 1.5rem; line-height: 1; flex-shrink: 0; }
  .v3-name-block { display: flex; flex-direction: column; align-items: flex-start; gap: 0.15rem; min-width: 0; }
  .v3-name {
    font-size: clamp(1rem, 1.6vw, 1.35rem);
    font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; line-height: 1.05;
  }
  .v3-name-a { color: var(--side-a); }
  .v3-name-b { color: var(--side-b); }
  .v3-note {
    font-size: 0.75rem; color: rgba(255,255,255,0.65); font-weight: 600; letter-spacing: 0.02em;
    line-height: 1;
  }
  .v3-break {
    display: inline-block; padding: 0.05rem 0.4rem;
    font-size: 0.6rem; font-weight: 800; letter-spacing: 0.14em;
    color: #1a1400; background: var(--accent); border-radius: 0.25rem; line-height: 1.3;
    align-self: flex-start;
  }
  .v3-score {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: clamp(2rem, 3.6vw, 2.8rem);
    padding: 0.1rem 0.6rem; line-height: 1;
    background: rgba(0,0,0,0.5); border-radius: 0.4rem;
    border: 1.5px solid rgba(255,255,255,0.14);
  }
  .v3-score-a { color: var(--side-a); text-shadow: 0 0 12px rgba(79,195,247,0.55); }
  .v3-score-b { color: var(--side-b); text-shadow: 0 0 12px rgba(255,138,101,0.55); }
  .v3-sets {
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 1.4rem; padding: 0.1rem 0.35rem;
    font-size: 0.9rem; font-weight: 800; color: #fff;
    background: rgba(255,255,255,0.12); border-radius: 0.3rem;
  }
  .v3-vs {
    font-size: 0.75rem; letter-spacing: 0.15em; font-weight: 800; color: rgba(255,255,255,0.5);
    padding: 0 0.35rem;
  }
  .v3-mid-cell {
    display: flex; flex-direction: column; align-items: center; gap: 0.05rem;
    padding: 0.2rem 0.6rem; line-height: 1;
    border-left: 1px solid rgba(255,213,74,0.3);
  }
  .v3-mid-lbl { font-size: 0.6rem; letter-spacing: 0.16em; font-weight: 700; color: rgba(255,213,74,0.85); text-transform: uppercase; }
  .v3-mid-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.4rem; color: var(--accent);
    text-shadow: 0 0 12px rgba(255,213,74,0.5);
  }
  /* --- solo --- */
  .v3-solo { display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap; }
  .v3-tile-row { display: inline-flex; gap: 0.4rem; padding-left: 0.5rem; border-left: 1px solid rgba(255,255,255,0.15); }
  .v3-tile {
    display: inline-flex; flex-direction: column; align-items: center; gap: 0.1rem;
    padding: 0.2rem 0.55rem 0.3rem;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 0.35rem;
    line-height: 1;
  }
  .v3-tile-current { border-color: var(--accent); box-shadow: 0 0 10px rgba(255,213,74,0.3); background: rgba(255,213,74,0.08); }
  .v3-tile-total { border-color: rgba(255,213,74,0.35); }
  .v3-tile-lbl { font-size: 0.55rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,255,255,0.55); text-transform: uppercase; }
  .v3-tile-val {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.35rem; color: var(--side-a);
    text-shadow: 0 0 10px rgba(79,195,247,0.4);
  }
  .v3-total { color: var(--accent); text-shadow: 0 0 12px rgba(255,213,74,0.55); }
</style>
