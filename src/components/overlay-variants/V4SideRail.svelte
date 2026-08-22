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
  V4 — Vertical Side Rail (right edge). Sidebar occupies right ~18vw
  of frame, full height. Stacked top→bottom for versus: team A → set /
  board middle block → team B. Solo: stacked player card + per-board
  tiles vertically.
-->
<div class="v4-root">
  <aside class="v4-rail">
    {#if isPractice}
      <div class="v4-solo-hero">
        {#if flagEmoji(sideA.country || sideA.note)}
          <span class="v4-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
        {/if}
        <span class="v4-solo-name">{sideA.name}</span>
        {#if sideA.note}<span class="v4-solo-note">{sideA.note}</span>{/if}
        {#if cfg.bestOf > 1}
          <span class="v4-set-caption">SET {practiceSetIdx + 1}/{cfg.bestOf}</span>
        {/if}
      </div>
      {#if !isBoardsUnlimited(cfg)}
        {@const row = practiceBoards[practiceSetIdx] ?? []}
        {@const total = row.reduce((s, v) => s + (v ?? 0), 0)}
        <div class="v4-solo-tiles">
          {#each Array(cfg.maxBoards) as _, i (i)}
            {@const missed = row[i] ?? 0}
            {@const isCurr = i === Math.min(board, cfg.maxBoards - 1)}
            <div class="v4-tile" class:v4-tile-current={isCurr}>
              <span class="v4-tile-lbl">B{i + 1}</span>
              <span class="v4-tile-val">{missed}</span>
            </div>
          {/each}
          <div class="v4-tile v4-tile-total">
            <span class="v4-tile-lbl">TOTAL</span>
            <span class="v4-tile-val v4-tile-val-accent">{total}</span>
          </div>
        </div>
      {/if}
    {:else}
      <div class="v4-team v4-team-a">
        <div class="v4-team-row">
          {#if flagEmoji(sideA.country || sideA.note)}
            <span class="v4-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
          {/if}
          <span class="v4-team-name v4-name-a">{sideA.name}</span>
        </div>
        <div class="v4-team-score v4-score-a">{pad2(sideA.points)}</div>
        {#if cfg.bestOf > 1}<div class="v4-team-sets">SETS <strong>{sideA.sets}</strong></div>{/if}
      </div>
      <div class="v4-mid">
        <div class="v4-mid-cap">{cfg.bestOf > 1 ? `SET ${sideA.sets + sideB.sets + 1}/${cfg.bestOf}` : 'SINGLE SET'}</div>
        <div class="v4-mid-board">BOARD <strong>{board}</strong>{isBoardsUnlimited(cfg) ? '' : ` / ${cfg.maxBoards}`}</div>
      </div>
      <div class="v4-team v4-team-b">
        <div class="v4-team-row">
          {#if flagEmoji(sideB.country || sideB.note)}
            <span class="v4-flag" aria-hidden="true">{flagEmoji(sideB.country || sideB.note)}</span>
          {/if}
          <span class="v4-team-name v4-name-b">{sideB.name}</span>
        </div>
        <div class="v4-team-score v4-score-b">{pad2(sideB.points)}</div>
        {#if cfg.bestOf > 1}<div class="v4-team-sets">SETS <strong>{sideB.sets}</strong></div>{/if}
      </div>
    {/if}
  </aside>
</div>

<style>
  :global(html), :global(body) { background: transparent !important; }
  .v4-root {
    position: fixed; inset: 0; pointer-events: none;
    --side-a: #4fc3f7; --side-b: #ff8a65; --accent: #ffd54a;
    color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .v4-rail {
    position: absolute; top: 3vh; right: 2vw; bottom: 3vh; width: clamp(14rem, 20vw, 22rem);
    display: flex; flex-direction: column; align-items: stretch; justify-content: center;
    gap: 0.9rem;
    padding: 1.2rem 1rem;
    background: rgba(0,0,0,0.88); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-radius: 1rem; border: 1.5px solid rgba(255,213,74,0.35);
    box-shadow: 0 8px 32px rgba(0,0,0,0.55);
  }
  .v4-team { display: flex; flex-direction: column; align-items: center; gap: 0.35rem; padding: 0.75rem; border-radius: 0.6rem; }
  .v4-team-a { background: linear-gradient(180deg, rgba(79,195,247,0.15), rgba(79,195,247,0.05)); border-left: 3px solid var(--side-a); }
  .v4-team-b { background: linear-gradient(180deg, rgba(255,138,101,0.15), rgba(255,138,101,0.05)); border-left: 3px solid var(--side-b); }
  .v4-team-row { display: flex; align-items: center; gap: 0.4rem; }
  .v4-flag { font-size: 1.4rem; line-height: 1; }
  .v4-team-name {
    font-size: 1rem; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase;
    text-align: center; line-height: 1.2;
  }
  .v4-name-a { color: var(--side-a); }
  .v4-name-b { color: var(--side-b); }
  .v4-team-score {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 4.5rem; line-height: 0.9;
  }
  .v4-score-a { color: var(--side-a); text-shadow: 0 0 22px rgba(79,195,247,0.6); }
  .v4-score-b { color: var(--side-b); text-shadow: 0 0 22px rgba(255,138,101,0.6); }
  .v4-team-sets { font-size: 0.75rem; color: rgba(255,255,255,0.7); letter-spacing: 0.12em; font-weight: 600; }
  .v4-team-sets strong { color: #fff; font-weight: 800; }
  .v4-mid {
    display: flex; flex-direction: column; align-items: center; gap: 0.2rem;
    padding: 0.5rem 0; border-top: 1px solid rgba(255,213,74,0.25); border-bottom: 1px solid rgba(255,213,74,0.25);
  }
  .v4-mid-cap { font-size: 0.7rem; letter-spacing: 0.14em; font-weight: 700; color: var(--accent); }
  .v4-mid-board { font-size: 0.85rem; color: rgba(255,255,255,0.85); font-weight: 700; letter-spacing: 0.06em; }
  .v4-mid-board strong { color: var(--accent); font-size: 1.05rem; }
  /* solo */
  .v4-solo-hero {
    display: flex; flex-direction: column; align-items: center; gap: 0.35rem;
    padding: 0.6rem 0 1rem; border-bottom: 1px solid rgba(255,213,74,0.25);
  }
  .v4-solo-name { font-size: 1.2rem; font-weight: 800; letter-spacing: 0.04em; text-transform: uppercase; color: var(--side-a); text-align: center; line-height: 1.15; }
  .v4-solo-note { font-size: 0.85rem; color: rgba(255,255,255,0.7); font-weight: 600; }
  .v4-set-caption { font-size: 0.7rem; letter-spacing: 0.16em; font-weight: 700; color: var(--accent); padding-top: 0.25rem; }
  .v4-solo-tiles { display: flex; flex-direction: column; gap: 0.4rem; overflow: hidden; }
  .v4-tile {
    display: grid; grid-template-columns: auto 1fr; align-items: baseline; gap: 0.6rem;
    padding: 0.55rem 0.75rem;
    background: rgba(0,0,0,0.55); border-radius: 0.4rem;
    border: 1.5px solid rgba(255,255,255,0.1);
  }
  .v4-tile-current { border-color: var(--accent); box-shadow: 0 0 12px rgba(255,213,74,0.3); }
  .v4-tile-total { border-color: rgba(255,213,74,0.4); }
  .v4-tile-lbl { font-size: 0.7rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,255,255,0.6); }
  .v4-tile-val {
    justify-self: end;
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.8rem; line-height: 1; color: var(--side-a);
    text-shadow: 0 0 14px rgba(79,195,247,0.45);
  }
  .v4-tile-val-accent { color: var(--accent); text-shadow: 0 0 14px rgba(255,213,74,0.5); }
</style>
