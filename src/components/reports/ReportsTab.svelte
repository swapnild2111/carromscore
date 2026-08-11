<script lang="ts">
  /**
   * /live/ Reports tab body.
   *
   * Consumes an already-loaded MatchRecord[] from LiveLobby (same
   * data the History tab reads) and offers a per-tournament report:
   * picker → summary card + charts + table + copy/download.
   *
   * No new Firebase reads here. Everything is computed client-side
   * from the passed-in matches array. Practice records are filtered
   * out inside `buildTournamentReport()` — they have no per-side
   * stats concept.
   */

  import { onMount } from 'svelte';
  import type { MatchRecord } from '../../lib/history';
  import {
    buildTournamentReport,
    toCSV,
    toTSV,
    downloadTextFile,
    slugifyName,
    type TournamentReport,
  } from '../../lib/reports';
  import {
    loadAll as loadAllTournaments,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
  } from '../../lib/tournaments';
  import BarChart from './BarChart.svelte';

  type Props = {
    matches: MatchRecord[];
    /**
     * Initial picker state:
     * - `undefined` = nothing picked yet, render the "Pick a
     *   tournament above" empty-state hint.
     * - `null` = the Default (untagged) bucket selected.
     * - string = a specific tournament name selected.
     */
    initialTournament: string | null | undefined;
    /**
     * Fires when the user picks a tournament — LiveLobby uses this to
     * reflect the selection back into the URL query string so the
     * page is deep-linkable.
     */
    onSelectionChange: (tournament: string | null) => void;
  };
  const { matches, initialTournament, onSelectionChange }: Props = $props();

  // Tournaments store tick — same reactive pattern as AdminRoles.
  // loadAllTournaments() reads the local cache; the tick nudges the
  // $derived recomputation when the store changes.
  let tournamentTick = $state(0);
  onMount(() => {
    // Kick off the Firebase load — mirrors AdminRoles / MatchSetup /
    // AdminTournaments. `subscribeStore` alone just registers a
    // listener; the async loader is what actually fills memoryStore.
    // Silent-on-failure in tournaments.ts; the picker just stays
    // showing "Default (untagged)" if RTDB is unreachable.
    void subscribeTournaments();
    const unsub = subscribeTournamentsStore(() => (tournamentTick += 1));
    return () => unsub();
  });

  /**
   * Picker options. Order:
   * 1. "Default (untagged)" — matches with empty tournament tag.
   * 2. Every tournament from the store, most-recently-active first.
   *
   * All tournaments appear regardless of whether they have matches
   * — the empty state renders "No matches recorded for this
   * tournament yet" inside the report body.
   */
  type PickerOption = { key: string | null; label: string };
  const options = $derived<PickerOption[]>(() => {
    void tournamentTick;
    // Default bucket first (matches how History labels the untagged
    // group — one consistent term across both tabs). Then real
    // tournaments most-recently-active first.
    const opts: PickerOption[] = [{ key: null, label: 'Default' }];
    for (const t of loadAllTournaments()) {
      opts.push({ key: t.name, label: t.name });
    }
    return opts;
  });

  // Selected tournament. `null` = the Default bucket (untagged
  // matches — mirrors the History tab's terminology). Auto-selects
  // Default on first Reports open so users see data straight away
  // instead of a "pick a tournament" empty state. Deep-link via
  // ?tournament=... overrides — those callers know what they want.
  let selection = $state<string | null | undefined>(
    initialTournament === undefined ? null : initialTournament,
  );

  const report = $derived<TournamentReport | null>(
    selection === undefined ? null : buildTournamentReport(matches, selection),
  );

  function pick(key: string | null) {
    selection = key;
    onSelectionChange(key);
  }

  // Copy-to-clipboard state. Ephemeral tick like the /live/ Share
  // popup uses so the button flashes "✓ Copied" briefly then reverts.
  let copiedTick = $state(false);
  let copyTimer: number | null = null;
  async function copyTable(rep: TournamentReport) {
    const tsv = toTSV(rep.rows);
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      // Fallback for iframes / non-secure contexts. Same pattern
      // used by the Share popup at LiveLobby.svelte:280-290.
      const el = document.createElement('textarea');
      el.value = tsv;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* silent */ }
      el.remove();
    }
    copiedTick = true;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copiedTick = false), 1800);
  }

  function downloadCSV(rep: TournamentReport) {
    const csv = toCSV(rep.rows);
    const filename = `${slugifyName(rep.tournament)}-carromscore.csv`;
    downloadTextFile(filename, 'text/csv;charset=utf-8', csv);
  }

  // Player-summary chart data. Ranked list already sorted in
  // buildPlayerSummary() by wins desc → boards desc → points desc.
  const winsChart = $derived(
    report ? report.playerSummary.map((p, i) => ({
      label: p.name,
      value: p.wins,
      // Alternate palette between the two side colours so the chart
      // reads visually distinct from a solid bar block.
      colour: i % 2 === 0 ? 'var(--side-a, #4fc3f7)' : 'var(--side-b, #ff8a65)',
    })) : [],
  );
  const pointsChart = $derived(
    report ? report.playerSummary
      .slice()
      .sort((a, b) => b.pointsScored - a.pointsScored)
      .map((p, i) => ({
        label: p.name,
        value: p.pointsScored,
        colour: i % 2 === 0 ? 'var(--side-a, #4fc3f7)' : 'var(--side-b, #ff8a65)',
      })) : [],
  );
</script>

<section class="reports">
  <div class="picker">
    <span class="picker-lbl">Tournament</span>
    <div class="chips" role="tablist" aria-label="Choose tournament">
      {#each options() as opt (opt.key ?? '__default__')}
        <button
          type="button"
          role="tab"
          class="chip"
          class:chip-on={selection === opt.key}
          aria-selected={selection === opt.key}
          onclick={() => pick(opt.key)}
        >{opt.label}</button>
      {/each}
    </div>
  </div>

  {#if !report}
    <div class="empty">
      <p><strong>Pick a tournament above.</strong></p>
      <p class="empty-sub">Every match tagged to that tournament will show up here with per-player summary, charts, and a downloadable CSV.</p>
    </div>
  {:else if report.rows.length === 0}
    <div class="empty">
      <p><strong>No matches recorded for this tournament yet.</strong></p>
      <p class="empty-sub">Score a match on the home screen and tag it with <em>{report.tournament}</em>. It'll appear here as soon as it ends.</p>
    </div>
  {:else}
    <div class="charts">
      <BarChart
        title="Wins per player"
        subtitle="Draws not counted"
        bars={winsChart}
        formatValue={(v) => (v === 1 ? '1 win' : `${v} wins`)}
      />
      <BarChart
        title="Points scored per player"
        subtitle="Cumulative across the tournament"
        bars={pointsChart}
      />
    </div>

    <div class="summary">
      <h3 class="section-hdr">Player summary</h3>
      <table class="summary-tbl">
        <thead>
          <tr>
            <th class="col-name">Player</th>
            <th>Matches</th>
            <th>W</th>
            <th>L</th>
            <th>D</th>
            <th>Boards</th>
            <th>Points</th>
          </tr>
        </thead>
        <tbody>
          {#each report.playerSummary as p (p.playerId)}
            <tr>
              <td class="col-name">{p.name}</td>
              <td>{p.matches}</td>
              <td>{p.wins}</td>
              <td>{p.losses}</td>
              <td>{p.draws}</td>
              <td>{p.boardsWon}</td>
              <td>{p.pointsScored}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="tbl-hdr">
      <h3 class="section-hdr">Matches ({report.matches})</h3>
      <div class="tbl-actions">
        <button
          type="button"
          class="btn btn-copy"
          onclick={() => copyTable(report)}
          aria-label="Copy table to clipboard as tab-separated values"
        >
          {#if copiedTick}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">⧉</span> Copy table{/if}
        </button>
        <button
          type="button"
          class="btn btn-download"
          onclick={() => downloadCSV(report)}
          aria-label="Download as CSV"
        >
          <span aria-hidden="true">↓</span> Download CSV
        </button>
      </div>
    </div>
    <!--
      Wrapper is horizontally scrollable on narrow screens so all
      columns stay readable — no wrapping cells or hidden data.
    -->
    <div class="tbl-scroll">
      <table class="matches-tbl">
        <thead>
          <tr>
            <th>Ended</th>
            <th>Mode</th>
            <th class="col-name">Side A</th>
            <th class="col-name">Side B</th>
            <th>Sets A</th>
            <th>Sets B</th>
            <th>Boards A</th>
            <th>Boards B</th>
            <th>Points A</th>
            <th>Points B</th>
            <th>Winner</th>
          </tr>
        </thead>
        <tbody>
          {#each report.rows as r (r._matchId)}
            <tr>
              <td>{r.endedAt}</td>
              <td>{r.mode}</td>
              <td class="col-name">{r.sideA}</td>
              <td class="col-name">{r.sideB}</td>
              <td>{r.setsA}</td>
              <td>{r.setsB}</td>
              <td>{r.boardsWonA}</td>
              <td>{r.boardsWonB}</td>
              <td>{r.pointsA}</td>
              <td>{r.pointsB}</td>
              <td class="winner-cell">
                {#if r.winner === 'Draw'}<span class="winner-tag winner-draw">Draw</span>
                {:else if r.winner === 'A'}<span class="winner-tag winner-a">A</span>
                {:else if r.winner === 'B'}<span class="winner-tag winner-b">B</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  .reports {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Tournament chip picker */
  .picker {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .picker-lbl {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted, #9aa0a6);
  }
  .chips {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .chip {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--muted, #9aa0a6);
    padding: 0.4rem 0.9rem;
    border-radius: 999px;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .chip:hover { background: rgba(255, 255, 255, 0.06); }
  .chip-on {
    background: rgba(255, 213, 74, 0.15);
    border-color: rgba(255, 213, 74, 0.55);
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }

  /* Empty states */
  .empty {
    padding: 1.5rem;
    text-align: center;
    color: var(--muted, #9aa0a6);
    background: rgba(255, 255, 255, 0.02);
    border: 1px dashed rgba(255, 255, 255, 0.1);
    border-radius: 0.6rem;
  }
  .empty p { margin: 0.2rem 0; }
  .empty-sub { font-size: 0.85rem; line-height: 1.5; }

  /* Charts row */
  .charts {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
  @media (min-width: 720px) {
    .charts { grid-template-columns: 1fr 1fr; }
  }

  /* Summary card */
  .section-hdr {
    margin: 0 0 0.4rem;
    font-size: 0.85rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg, #f5f5f5);
  }
  .summary {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.6rem;
    padding: 0.85rem 1rem 1rem;
  }
  .summary-tbl,
  .matches-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.85rem;
  }
  .summary-tbl th,
  .summary-tbl td,
  .matches-tbl th,
  .matches-tbl td {
    padding: 0.4rem 0.6rem;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .summary-tbl th,
  .matches-tbl th {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.7rem;
    color: var(--muted, #9aa0a6);
    font-weight: 700;
    background: rgba(255, 255, 255, 0.03);
  }
  .col-name { text-align: left !important; }
  .summary-tbl tr:last-child td,
  .matches-tbl tr:last-child td { border-bottom: 0; }

  /* Matches table + toolbar */
  .tbl-hdr {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .tbl-actions {
    display: flex;
    gap: 0.4rem;
  }
  .btn {
    background: transparent;
    border: 1px solid rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
    padding: 0.35rem 0.85rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s;
    font-family: inherit;
  }
  .btn:hover { background: rgba(255, 213, 74, 0.08); }
  .tbl-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.6rem;
  }
  .matches-tbl {
    min-width: 620px;
  }
  .winner-cell { padding: 0.3rem !important; }
  .winner-tag {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }
  .winner-a {
    background: rgba(79, 195, 247, 0.15);
    color: var(--side-a, #4fc3f7);
    border: 1px solid rgba(79, 195, 247, 0.35);
  }
  .winner-b {
    background: rgba(255, 138, 101, 0.15);
    color: var(--side-b, #ff8a65);
    border: 1px solid rgba(255, 138, 101, 0.35);
  }
  .winner-draw {
    background: rgba(201, 165, 111, 0.15);
    color: #c9a56f;
    border: 1px solid rgba(201, 165, 111, 0.35);
  }
</style>
