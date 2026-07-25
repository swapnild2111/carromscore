<script lang="ts">
  import { onMount } from 'svelte';
  import { DEFAULT_CONFIG, decodeConfig, matchStateKey, teamLabel, type MatchConfig } from '../lib/match';

  type Side = { name: string; sets: number; points: number };

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });
  let sideA = $state<Side>({ name: 'Player A', sets: 0, points: 0 });
  let sideB = $state<Side>({ name: 'Player B', sets: 0, points: 0 });
  let board = $state(0);

  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    cfg = decodeConfig(q);
    sideA.name = teamLabel(cfg.playerA, cfg.playerA2, cfg.mode) || 'Player A';
    sideB.name = teamLabel(cfg.playerB, cfg.playerB2, cfg.mode) || 'Player B';

    // Cross-tab live sync: pick up state written to localStorage by the player view.
    // Keys and shape must stay compatible with what ScoreBoard writes.
    const KEY = matchStateKey(q.get('playerA') ?? '', q.get('playerB') ?? '');
    const apply = (raw: string | null) => {
      if (!raw) return;
      try {
        const s = JSON.parse(raw);
        if (typeof s?.sideA?.points === 'number') sideA.points = s.sideA.points;
        if (typeof s?.sideB?.points === 'number') sideB.points = s.sideB.points;
        if (typeof s?.sideA?.sets === 'number') sideA.sets = s.sideA.sets;
        if (typeof s?.sideB?.sets === 'number') sideB.sets = s.sideB.sets;
        if (typeof s?.board === 'number') board = s.board;
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
</script>

<div class="overlay">
  <div class="strip">
    <div class="team team-a">
      <div class="name">{sideA.name}</div>
      <div class="row">
        <span class="score">{pad2(sideA.points)}</span>
        <span class="sets">{sideA.sets}</span>
      </div>
    </div>
    <div class="board">
      <div class="board-label">BOARD</div>
      <div class="board-num">{board}</div>
    </div>
    <div class="team team-b">
      <div class="name">{sideB.name}</div>
      <div class="row">
        <span class="sets">{sideB.sets}</span>
        <span class="score">{pad2(sideB.points)}</span>
      </div>
    </div>
  </div>
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
  }
  .strip {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 2rem;
    padding: 0.85rem 1.5rem;
    background: rgba(11, 11, 11, 0.88);
    border-radius: 1rem;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    min-width: min(900px, 92vw);
    max-width: 96vw;
  }
  .team {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .team-a { text-align: left; }
  .team-b { text-align: right; }
  .name {
    font-size: clamp(0.9rem, 1.5vw, 1.15rem);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #eee;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .team-a .name { border-left: 4px solid var(--side-a); padding-left: 0.6rem; }
  .team-b .name { border-right: 4px solid var(--side-b); padding-right: 0.6rem; }

  .row {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  .team-b .row { justify-content: flex-end; }

  .score {
    font-family: 'DS-Digital', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 800;
    line-height: 1;
    font-size: clamp(3rem, 6vw, 4.5rem);
  }
  .team-a .score { color: var(--side-a); text-shadow: 0 0 12px rgba(79,195,247,0.4); }
  .team-b .score { color: var(--side-b); text-shadow: 0 0 12px rgba(255,138,101,0.4); }

  .sets {
    font-family: 'DS-Digital', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 800;
    line-height: 1;
    font-size: clamp(1.5rem, 3vw, 2.2rem);
    color: #fff;
    background: rgba(255,255,255,0.08);
    padding: 0.15rem 0.55rem;
    border-radius: 0.35rem;
  }

  .board {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 0 0.5rem;
    border-left: 1px solid rgba(255,255,255,0.15);
    border-right: 1px solid rgba(255,255,255,0.15);
  }
  .board-label {
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: rgba(255,255,255,0.55);
  }
  .board-num {
    font-family: 'DS-Digital', 'Courier New', ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
    font-weight: 800;
    font-size: clamp(2rem, 3vw, 2.5rem);
    color: var(--accent);
    line-height: 1;
  }
</style>
