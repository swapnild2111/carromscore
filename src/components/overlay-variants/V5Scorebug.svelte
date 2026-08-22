<script lang="ts">
  import '@fontsource/dseg7-classic/700.css';
  import { flagEmoji } from '../../lib/countries';
  import { isBoardsUnlimited } from '../../lib/match';
  import type { OverlayVariantProps } from './types';

  const { cfg, sideA, sideB, board, practiceBoards, practiceSetIdx }: OverlayVariantProps = $props();

  const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const isPractice = $derived(cfg.mode === 'practice');
  // Compact team abbrev — first 3 letters of first name uppercased.
  // Broadcast scorebugs use "MI vs CSK", not full team names, to fit.
  const abbrev = (name: string) => (name || '').trim().split(/\s+/)[0]?.slice(0, 3).toUpperCase() || '?';
</script>

<!--
  V5 — Sports Scorebug (broadcast TV style). Compact card in the
  bottom-LEFT corner. Two rows — one per side — with a 3-letter
  team abbrev, flag, score. Match state (SET/BOARD) tucked below.
  Solo: current board digit dominates + a sparkline of previous
  boards' misses.
-->
<div class="v5-root">
  <div class="v5-bug" class:v5-bug-practice={isPractice}>
    {#if isPractice}
      <div class="v5-solo-head">
        {#if flagEmoji(sideA.country || sideA.note)}
          <span class="v5-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
        {/if}
        <span class="v5-solo-abbrev">{abbrev(sideA.name)}</span>
        <span class="v5-solo-name">{sideA.name}</span>
      </div>
      {#if !isBoardsUnlimited(cfg)}
        {@const row = practiceBoards[practiceSetIdx] ?? []}
        {@const total = row.reduce((s, v) => s + (v ?? 0), 0)}
        {@const currentIdx = Math.min(board, cfg.maxBoards - 1)}
        {@const currentMissed = row[currentIdx] ?? 0}
        <div class="v5-solo-current">
          <div class="v5-solo-current-lbl">B{currentIdx + 1}</div>
          <div class="v5-solo-current-val">{currentMissed}</div>
          <div class="v5-solo-current-cap">MISSED</div>
        </div>
        <div class="v5-solo-history">
          <div class="v5-hist-lbl">HISTORY</div>
          <div class="v5-hist-row">
            {#each Array(cfg.maxBoards) as _, i (i)}
              {@const missed = row[i] ?? 0}
              {@const isCurr = i === currentIdx}
              <div class="v5-hist-cell" class:v5-hist-cell-current={isCurr}>{missed}</div>
            {/each}
          </div>
          <div class="v5-hist-total">
            <span>TOTAL</span>
            <strong>{total}</strong>
            {#if cfg.bestOf > 1}<span class="v5-hist-set">· SET {practiceSetIdx + 1}/{cfg.bestOf}</span>{/if}
          </div>
        </div>
      {/if}
    {:else}
      <div class="v5-row v5-row-a">
        {#if flagEmoji(sideA.country || sideA.note)}
          <span class="v5-flag" aria-hidden="true">{flagEmoji(sideA.country || sideA.note)}</span>
        {/if}
        <span class="v5-abbrev v5-abbrev-a">{abbrev(sideA.name)}</span>
        <span class="v5-full-name">{sideA.name}</span>
        {#if cfg.bestOf > 1}<span class="v5-sets">{sideA.sets}</span>{/if}
        <span class="v5-score v5-score-a">{pad2(sideA.points)}</span>
      </div>
      <div class="v5-row v5-row-b">
        {#if flagEmoji(sideB.country || sideB.note)}
          <span class="v5-flag" aria-hidden="true">{flagEmoji(sideB.country || sideB.note)}</span>
        {/if}
        <span class="v5-abbrev v5-abbrev-b">{abbrev(sideB.name)}</span>
        <span class="v5-full-name">{sideB.name}</span>
        {#if cfg.bestOf > 1}<span class="v5-sets">{sideB.sets}</span>{/if}
        <span class="v5-score v5-score-b">{pad2(sideB.points)}</span>
      </div>
      <div class="v5-footer">
        <span>{cfg.bestOf > 1 ? `SET ${sideA.sets + sideB.sets + 1}/${cfg.bestOf}` : 'SINGLE SET'}</span>
        <span class="v5-dot"></span>
        <span>BOARD {board}{isBoardsUnlimited(cfg) ? '' : ` / ${cfg.maxBoards}`}</span>
      </div>
    {/if}
  </div>
</div>

<style>
  :global(html), :global(body) { background: transparent !important; }
  .v5-root {
    position: fixed; inset: 0; pointer-events: none;
    --side-a: #4fc3f7; --side-b: #ff8a65; --accent: #ffd54a;
    color: #fff; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  }
  .v5-bug {
    position: absolute; bottom: 4vh; left: 3vw;
    display: flex; flex-direction: column;
    min-width: 20rem;
    background: linear-gradient(180deg, rgba(0,0,0,0.92), rgba(0,0,0,0.85));
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
    border-radius: 0.5rem;
    box-shadow: 0 6px 24px rgba(0,0,0,0.6);
    overflow: hidden;
  }
  .v5-row {
    display: grid; grid-template-columns: auto auto 1fr auto auto; align-items: center;
    gap: 0.7rem; padding: 0.5rem 0.9rem;
  }
  .v5-row-a { background: linear-gradient(90deg, rgba(79,195,247,0.35), rgba(79,195,247,0.08)); border-left: 4px solid var(--side-a); }
  .v5-row-b { background: linear-gradient(90deg, rgba(255,138,101,0.35), rgba(255,138,101,0.08)); border-left: 4px solid var(--side-b); }
  .v5-flag { font-size: 1.35rem; line-height: 1; }
  .v5-abbrev { font-size: 1.1rem; font-weight: 800; letter-spacing: 0.08em; }
  .v5-abbrev-a { color: var(--side-a); }
  .v5-abbrev-b { color: var(--side-b); }
  .v5-full-name {
    font-size: 0.85rem; font-weight: 600; color: rgba(255,255,255,0.75); letter-spacing: 0.02em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .v5-sets { font-size: 0.9rem; font-weight: 700; color: rgba(255,255,255,0.55); padding: 0.05rem 0.4rem; background: rgba(0,0,0,0.35); border-radius: 0.25rem; }
  .v5-score {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 1.9rem; line-height: 1;
    background: rgba(0,0,0,0.55);
    padding: 0.15rem 0.55rem; border-radius: 0.3rem;
  }
  .v5-score-a { color: var(--side-a); }
  .v5-score-b { color: var(--side-b); }
  .v5-footer {
    display: flex; align-items: center; justify-content: center; gap: 0.5rem;
    padding: 0.35rem 0.9rem;
    font-size: 0.7rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,213,74,0.85);
    background: rgba(255,213,74,0.08);
    border-top: 1px solid rgba(255,213,74,0.25);
  }
  .v5-dot { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.5; }
  /* --- solo scorebug --- */
  .v5-bug-practice { flex-direction: row; align-items: stretch; min-width: 24rem; }
  .v5-solo-head {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.35rem; padding: 0.9rem 1rem;
    background: linear-gradient(180deg, rgba(79,195,247,0.35), rgba(79,195,247,0.08));
    border-right: 2px solid rgba(255,255,255,0.08);
  }
  .v5-solo-abbrev { font-size: 1.4rem; font-weight: 800; letter-spacing: 0.08em; color: var(--side-a); }
  .v5-solo-name { font-size: 0.7rem; font-weight: 600; color: rgba(255,255,255,0.7); letter-spacing: 0.04em; text-transform: uppercase; text-align: center; max-width: 6rem; line-height: 1.2; }
  .v5-solo-current {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.15rem; padding: 0.7rem 0.9rem;
    border-right: 2px solid rgba(255,255,255,0.08);
  }
  .v5-solo-current-lbl { font-size: 0.65rem; letter-spacing: 0.14em; font-weight: 700; color: var(--accent); }
  .v5-solo-current-val {
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 3rem; line-height: 0.9; color: var(--side-a);
    text-shadow: 0 0 16px rgba(79,195,247,0.55);
  }
  .v5-solo-current-cap { font-size: 0.6rem; letter-spacing: 0.14em; font-weight: 700; color: rgba(255,255,255,0.55); }
  .v5-solo-history {
    display: flex; flex-direction: column; justify-content: center; gap: 0.35rem;
    padding: 0.7rem 0.9rem;
  }
  .v5-hist-lbl { font-size: 0.55rem; letter-spacing: 0.16em; font-weight: 700; color: rgba(255,255,255,0.5); }
  .v5-hist-row { display: flex; gap: 0.3rem; }
  .v5-hist-cell {
    width: 1.6rem; height: 1.6rem; display: flex; align-items: center; justify-content: center;
    font-family: 'DSEG7 Classic', 'Courier New', ui-monospace, monospace;
    font-weight: 700; font-size: 0.85rem; line-height: 1;
    background: rgba(255,255,255,0.06); border-radius: 0.25rem; color: rgba(255,255,255,0.85);
  }
  .v5-hist-cell-current { background: rgba(255,213,74,0.2); color: var(--accent); box-shadow: 0 0 6px rgba(255,213,74,0.35); }
  .v5-hist-total {
    display: flex; align-items: baseline; gap: 0.35rem;
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.06em; color: rgba(255,255,255,0.65);
  }
  .v5-hist-total strong { color: var(--accent); font-size: 1.05rem; }
  .v5-hist-set { color: rgba(255,213,74,0.6); font-size: 0.65rem; }
</style>
