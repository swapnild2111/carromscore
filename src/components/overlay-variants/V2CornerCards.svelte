<script lang="ts">
  import '@fontsource/dseg7-classic/700.css';
  import { flagEmoji } from '../../lib/countries';
  import { isBoardsUnlimited } from '../../lib/match';
  import type { OverlayVariantProps } from './types';

  const { cfg, sideA, sideB, board, practiceBoards, practiceSetIdx }: OverlayVariantProps = $props();

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const isPractice = $derived(cfg.mode === 'practice');
</script>

<!--
  V2 — Split Corner Cards. Two rounded card panels pinned to the top
  corners; frees the bottom two thirds of the frame. Solo: single
  top-centre card with the per-board tile row directly beneath.
-->
<div class="v2-root" class:v2-practice={isPractice}>
  {#if isPractice}
    <div class="v2-solo-header">
      <div class="v2-solo-card">
        {#if flagEmoji(sideA.country || sideA.note)}
          <span class="v2-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
        {/if}
        <div class="v2-solo-txt">
          <span class="v2-solo-name">{sideA.name}</span>
          {#if sideA.note}<span class="v2-solo-note">{sideA.note}</span>{/if}
        </div>
        {#if cfg.bestOf > 1}
          <div class="v2-set-chip">
            <span class="v2-set-lbl">SET</span>
            <span class="v2-set-num">{practiceSetIdx + 1}/{cfg.bestOf}</span>
          </div>
        {/if}
      </div>
    </div>
    {#if !isBoardsUnlimited(cfg)}
      {@const row = practiceBoards[practiceSetIdx] ?? []}
      {@const total = row.reduce((s, v) => s + (v ?? 0), 0)}
      <div class="v2-solo-tiles">
        {#each Array(cfg.maxBoards) as _, i (i)}
          {@const missed = row[i] ?? 0}
          {@const isCurr = i === Math.min(board, cfg.maxBoards - 1)}
          <div class="v2-tile" class:v2-tile-current={isCurr}>
            <span class="v2-tile-lbl">B{i + 1}</span>
            <span class="v2-tile-val">{missed}</span>
          </div>
        {/each}
        <div class="v2-tile v2-tile-total">
          <span class="v2-tile-lbl">TOT</span>
          <span class="v2-tile-val v2-tile-val-accent">{total}</span>
        </div>
      </div>
    {/if}
  {:else}
    <div class="v2-card v2-card-a">
      {#if flagEmoji(sideA.country || sideA.note)}
        <span class="v2-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
      {/if}
      <div class="v2-card-name">{sideA.name}</div>
      <div class="v2-card-digit v2-digit-a">{pad2(sideA.points)}</div>
      {#if cfg.bestOf > 1}<div class="v2-card-sets">SETS {sideA.sets}</div>{/if}
    </div>
    <div class="v2-card v2-card-b">
      {#if flagEmoji(sideB.country || sideB.note)}
        <span class="v2-flag" aria-hidden="true">{flagEmoji(sideB.country || sideB.note)}</span>
      {/if}
      <div class="v2-card-name">{sideB.name}</div>
      <div class="v2-card-digit v2-digit-b">{pad2(sideB.points)}</div>
      {#if cfg.bestOf > 1}<div class="v2-card-sets">SETS {sideB.sets}</div>{/if}
    </div>
    <div class="v2-middle">
      <div class="v2-mid-lbl">{cfg.bestOf > 1 ? `SET ${sideA.sets + sideB.sets + 1}` : 'SINGLE SET'}</div>
      <div class="v2-mid-board">BOARD {board}{isBoardsUnlimited(cfg) ? '' : ` / ${cfg.maxBoards}`}</div>
    </div>
  {/if}
</div>

<style>
  :global(html), :global(body) { background: transparent !important; }
  .v2-root {
    position: fixed; inset: 0; pointer-events: none;
    --side-a: #4fc3f7; --side-b: #ff8a65; --accent: #ffd54a;
    color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .v2-card {
    position: absolute; top: 3vh;
    display: flex; flex-direction: column; align-items: center;
    gap: 0.5rem; padding: 1rem 1.4rem 1.2rem;
    background: rgba(0,0,0,0.88); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border-radius: 1rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    min-width: 12rem;
  }
  .v2-card-a { left: 2vw; border: 2px solid var(--side-a); }
  .v2-card-b { right: 2vw; border: 2px solid var(--side-b); }
  .v2-flag { font-size: 2rem; line-height: 1; }
  .v2-card-name {
    font-size: clamp(1.1rem, 1.8vw, 1.5rem);
    font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; text-align: center;
    line-height: 1.15;
  }
  .v2-card-digit {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: clamp(4rem, 8vw, 6.5rem); line-height: 0.9;
    letter-spacing: 0.05em;
  }
  .v2-digit-a { color: var(--side-a); text-shadow: 0 0 24px rgba(79,195,247,0.55); }
  .v2-digit-b { color: var(--side-b); text-shadow: 0 0 24px rgba(255,138,101,0.55); }
  .v2-card-sets {
    font-size: 0.75rem; letter-spacing: 0.16em; color: rgba(255,255,255,0.7); font-weight: 700;
  }
  .v2-middle {
    position: absolute; top: 3vh; left: 50%; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
    padding: 0.75rem 1.4rem; background: rgba(0,0,0,0.85);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border-radius: 0.75rem; border: 1.5px solid rgba(255,213,74,0.4);
  }
  .v2-mid-lbl {
    font-size: 0.75rem; letter-spacing: 0.16em; text-transform: uppercase;
    font-weight: 700; color: var(--accent);
  }
  .v2-mid-board {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.8rem; color: var(--accent);
    text-shadow: 0 0 18px rgba(255,213,74,0.5);
  }
  /* --- solo variant --- */
  .v2-solo-header {
    position: absolute; top: 3vh; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center;
  }
  .v2-solo-card {
    display: inline-flex; align-items: center; gap: 0.9rem;
    padding: 0.9rem 1.4rem;
    background: rgba(0,0,0,0.88); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border: 2px solid var(--side-a); border-radius: 1rem;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  }
  .v2-solo-txt {
    display: flex; flex-direction: column; align-items: flex-start; gap: 0.2rem;
    line-height: 1.1;
  }
  .v2-solo-name {
    font-size: clamp(1.3rem, 2.2vw, 1.8rem);
    font-weight: 800; letter-spacing: 0.05em; text-transform: uppercase; color: var(--side-a);
  }
  .v2-solo-note {
    font-size: 0.9rem; color: rgba(255,255,255,0.75); font-weight: 600; letter-spacing: 0.02em;
  }
  .v2-set-chip {
    display: flex; flex-direction: column; align-items: center; gap: 0.15rem;
    padding: 0.35rem 0.75rem; border-left: 1.5px solid rgba(255,213,74,0.35);
    margin-left: 0.5rem;
  }
  .v2-set-lbl { font-size: 0.65rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,213,74,0.85); }
  .v2-set-num {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.5rem; color: var(--accent);
  }
  .v2-solo-tiles {
    position: absolute; top: 14vh; left: 50%; transform: translateX(-50%);
    display: flex; gap: 0.6rem; padding: 0.5rem;
  }
  .v2-tile {
    display: flex; flex-direction: column; align-items: center; gap: 0.25rem;
    padding: 0.7rem 0.9rem 0.8rem; min-width: 3.5rem;
    background: rgba(0,0,0,0.85); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    border: 1.5px solid rgba(255,255,255,0.14); border-radius: 0.6rem;
  }
  .v2-tile-current { border-color: var(--accent); box-shadow: 0 0 14px rgba(255,213,74,0.35); }
  .v2-tile-total { border-color: rgba(255,213,74,0.4); }
  .v2-tile-lbl { font-size: 0.7rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,255,255,0.6); }
  .v2-tile-val {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: clamp(2.4rem, 4vw, 3.4rem); color: var(--side-a);
    text-shadow: 0 0 18px rgba(79,195,247,0.45); line-height: 1;
  }
  .v2-tile-val-accent { color: var(--accent); text-shadow: 0 0 18px rgba(255,213,74,0.5); }
</style>
