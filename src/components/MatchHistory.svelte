<script lang="ts">
  /**
   * Match history — lists every completed match recorded to Firebase.
   *
   * Loads on mount from RTDB /matches (public read; anyone can view).
   * Player display names are resolved via the identity store so a
   * player renamed after the match still shows their current
   * canonical name (matches ledger points at playerIds, not strings).
   *
   * v2.0 renders the raw list, newest first. Filters + per-player
   * drill-downs come later.
   */
  import { onMount } from 'svelte';
  import {
    loadHistory,
    playerName,
    type MatchRecord,
  } from '../lib/history';
  import { subscribePlayers, subscribeStore } from '../lib/players';
  import { APP_VERSION } from '../lib/version';

  const base: string = import.meta.env.BASE_URL;

  let loading = $state(true);
  let matches = $state<MatchRecord[]>([]);
  let identityTick = $state(0);

  onMount(() => {
    // Player identity resolution needs the store populated so a
    // playerId gets rendered as a name, not the raw slug.
    void subscribePlayers();
    const unsub = subscribeStore(() => (identityTick += 1));

    void (async () => {
      matches = await loadHistory();
      loading = false;
    })();

    return unsub;
  });

  function sideALabel(m: MatchRecord): string {
    void identityTick; // reactive dependency
    if (m.mode === 'practice') return playerName(m.playerAId);
    const a = playerName(m.playerAId);
    if (m.mode === 'doubles') {
      const a2 = playerName(m.playerA2Id);
      return a2 ? `${a} & ${a2}` : a;
    }
    return a;
  }

  function sideBLabel(m: MatchRecord): string {
    void identityTick;
    if (m.mode === 'practice') return '';
    const b = playerName(m.playerBId);
    if (m.mode === 'doubles') {
      const b2 = playerName(m.playerB2Id);
      return b2 ? `${b} & ${b2}` : b;
    }
    return b;
  }

  function dateLabel(ts: number | undefined): string {
    if (!ts) return '';
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function scoreLabel(m: MatchRecord): string {
    const r = m.result;
    if (!r) return '';
    const setsA = r.setsA ?? 0;
    const setsB = r.setsB ?? 0;
    const ptsA = r.finalPointsA ?? 0;
    const ptsB = r.finalPointsB ?? 0;
    const boards = r.boardCount ?? 0;
    if (m.mode === 'practice') {
      const misses = ptsA;
      return `${misses} miss${misses === 1 ? '' : 'es'}`;
    }
    // Head-to-head: show both sets and final-set points so users can
    // see who won the decider. Suffix a board count when it's non-zero.
    const parts: string[] = [];
    if (setsA + setsB > 0) parts.push(`${setsA}–${setsB} sets`);
    parts.push(`${ptsA}–${ptsB} pts`);
    if (boards > 0) parts.push(`${boards} board${boards === 1 ? '' : 's'}`);
    return parts.join(' · ');
  }

  function modeLabel(mode: MatchRecord['mode']): string {
    if (mode === 'singles') return 'Singles';
    if (mode === 'doubles') return 'Doubles';
    return 'Practice';
  }
</script>

<main>
  <header class="hdr">
    <a class="back" href={base}>← Back</a>
    <h1>Match history</h1>
    <span class="ver" aria-label="Carromscore version">v{APP_VERSION}</span>
  </header>

  {#if loading}
    <p class="state">Loading…</p>
  {:else if matches.length === 0}
    <p class="state empty">
      No matches yet. When you finish a match, it appears here.
    </p>
  {:else}
    <ul class="list">
      {#each matches as m (m.id)}
        {@const winner = m.result?.winner}
        <li class="row" class:practice={m.mode === 'practice'}>
          <div class="head">
            <span class="mode">{modeLabel(m.mode)}</span>
            <span class="date">{dateLabel(m.endedAt)}</span>
          </div>
          {#if m.mode === 'practice'}
            <div class="teams">
              <span class="team single">{sideALabel(m)}</span>
              <span class="score">{scoreLabel(m)}</span>
            </div>
          {:else}
            <div class="teams">
              <span class="team a" class:won={winner === 'a'}>
                {#if winner === 'a'}<span class="crown" aria-label="winner">🏆</span>{/if}
                {sideALabel(m)}
              </span>
              <span class="vs">vs</span>
              <span class="team b" class:won={winner === 'b'}>
                {#if winner === 'b'}<span class="crown" aria-label="winner">🏆</span>{/if}
                {sideBLabel(m)}
              </span>
            </div>
            <div class="score-line">{scoreLabel(m)}</div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main {
    max-width: 680px;
    margin: 0 auto;
    padding: 1rem 1rem 3rem;
    font-family: inherit;
  }
  .hdr {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .hdr h1 {
    flex: 1;
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .back {
    color: var(--accent);
    text-decoration: none;
    font-weight: 600;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
  }
  .back:hover { background: rgba(255, 213, 74, 0.1); }
  .ver {
    color: var(--muted);
    font-size: 0.75rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.3);
    color: var(--accent);
    padding: 0.15rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 700;
  }

  .state {
    color: var(--muted);
    text-align: center;
    padding: 3rem 1rem;
    font-size: 0.9rem;
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .row {
    background: #141414;
    border: 1px solid #262626;
    border-radius: 0.6rem;
    padding: 0.75rem 0.85rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 0.5rem;
  }
  .mode {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    font-weight: 700;
  }
  .date { font-size: 0.78rem; color: var(--muted); }

  .teams {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .team {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-weight: 600;
    font-size: 0.95rem;
  }
  .team.a { color: var(--side-a); }
  .team.b { color: var(--side-b); }
  .team.single { color: var(--fg); }
  .team.won { text-shadow: 0 0 8px currentColor; }
  .vs {
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .crown { font-size: 0.85rem; }

  .score, .score-line {
    color: var(--muted);
    font-size: 0.82rem;
    font-variant-numeric: tabular-nums;
  }
  .score { margin-left: auto; font-weight: 600; }
  .score-line { padding-top: 0.15rem; }

  .practice .teams { justify-content: space-between; }
</style>
