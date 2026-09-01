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
    toTSV,
    type ReportRow,
    type PlayerSummary,
    type TournamentReport,
  } from '../../lib/reports';
  import {
    loadAll as loadAllTournaments,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
    loadRounds,
    normalizeKey,
  } from '../../lib/tournaments';
  // BarChart removed v3.4.12 — the two horizontal bar rows above the
  // Leaderboard were redundant with the Leaderboard table itself.
  // Reports now leans on sortable + filterable tables mirroring the
  // History tab convention.

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
  const options = $derived.by<PickerOption[]>(() => {
    void tournamentTick;
    // Real tournaments first (most-recently-active), Default last
    // and de-emphasised — organisers scanning the chip strip should
    // see their real events at the front. Reported 2026-08-19:
    // "Default" cluttering the head of the row.
    const opts: PickerOption[] = [];
    for (const t of loadAllTournaments()) {
      opts.push({ key: t.name, label: t.name });
    }
    opts.push({ key: null, label: 'Default' });
    return opts;
  });

  /**
   * Selected tournament, derived directly from the parent's
   * `initialTournament` prop (v3.4.12 rewrite). Single source of
   * truth — LiveLobby owns the state and pushes it in via the
   * prop; user picks call `onSelectionChange` (which writes back
   * to the parent's reportsSelection) and the prop flows back.
   * No local `$state` shadow to keep in sync — previous versions
   * had `selection` as $state PLUS a proxy PLUS effects, which
   * created feedback loops and out-of-sync bugs.
   *
   * `null` = Default (untagged) bucket. `undefined` = nothing
   * picked (renders the "pick a tournament" empty state).
   */
  const selection = $derived<string | null | undefined>(
    initialTournament === undefined ? null : initialTournament,
  );
  const selectionProxy = $derived(
    selection === null || selection === undefined ? '__default__' : selection,
  );
  function onTournamentChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    const next = v === '__default__' ? null : v;
    // Always fire — the parent's reportsSelection may still be
    // `undefined` (fresh load, no tournament URL param) even when
    // `selection` derived to `null`. Firing on every pick pushes
    // the user's explicit choice into the parent so URL sync runs.
    onSelectionChange(next);
  }

  // Pass the tournament's round roster into buildTournamentReport so
  // per-round sub-reports get ordered R16 → QF → SF → F rather than
  // alphabetically. Empty when the selection is Default (untagged) or
  // the tournament has no rounds configured — buildTournamentReport
  // still produces roundReports if any match has a roundKey tag.
  const currentRoundRoster = $derived.by(() => {
    void tournamentTick;
    if (selection === undefined || selection === null) return [];
    return loadRounds(normalizeKey(selection));
  });

  const report = $derived<TournamentReport | null>(
    selection === undefined
      ? null
      : buildTournamentReport(matches, selection, currentRoundRoster),
  );

  /**
   * Round filter (v3.3.3). Chip strip below the tournament picker
   * lets the umpire scope the top view (summary tiles, charts,
   * leaderboard, matches table) to a single round. `null` = All
   * rounds combined (default). Resets whenever the tournament
   * selection changes so a stale round key from a previous
   * tournament doesn't carry over.
   */
  function initialRoundFilter(): string | null {
    if (typeof window === 'undefined') return null;
    const v = new URL(window.location.href).searchParams.get('round');
    return v ? v : null;
  }
  let roundFilter = $state<string | null>(initialRoundFilter());
  // Reset roundFilter on tournament change — but skip the FIRST run
  // so the URL-preloaded value survives mount. Otherwise `void selection`
  // fires on initial derivation with initialTournament and immediately
  // nulls out the round param the URL asked for.
  let roundFilterSelectionInit = false;
  $effect(() => {
    void selection;
    if (!roundFilterSelectionInit) {
      roundFilterSelectionInit = true;
      return;
    }
    roundFilter = null;
  });
  // Mirror roundFilter to URL as `round=`.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (roundFilter === null) url.searchParams.delete('round');
    else url.searchParams.set('round', roundFilter);
    window.history.replaceState({}, '', url.toString());
  });

  /**
   * Proxy binding for the Round <select> (v3.4.12) — same pattern
   * as selectionProxy. '__all__' = every round combined. Effects
   * keep roundFilter and this proxy in step; on tournament switch
   * both reset to their "all" default (via the reset effect above).
   */
  // Round select proxy (v3.4.12) — same one-way + onchange pattern
  // as selectionProxy above. '__all__' represents null (All rounds).
  const roundFilterProxy = $derived(roundFilter === null ? '__all__' : roundFilter);
  function onRoundChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    const next = v === '__all__' ? null : v;
    // Always assign — cheap, and keeps parity with onTournamentChange.
    roundFilter = next;
  }

  /**
   * The view report — either the combined tournament report or a
   * specific round's slice. When a round is picked, we synthesise a
   * lightweight report shape from the matching roundReport so
   * downstream renders (charts, leaderboard, matches table) don't
   * branch on filter state. summary tiles read from this too.
   */
  const viewReport = $derived.by<TournamentReport | null>(() => {
    if (!report) return null;
    if (roundFilter === null) return report;
    const rr = report.roundReports?.find((x) => x.roundKey === roundFilter);
    if (!rr) return report;
    return {
      tournament: report.tournament,
      matches: rr.matches,
      rows: rr.rows,
      playerSummary: rr.playerSummary,
      // Keep roundReports absent on the filtered view — the per-
      // round accordion should still render the full breakdown
      // (fed by the unfiltered `report`, not `viewReport`).
    };
  });

  /**
   * Summary-tile stats. Cheap derivations off the current view so
   * summary + charts + leaderboard all stay in step when the round
   * filter changes.
   *
   * `matchesCount` — total matches under the view scope.
   * `playersCount` — distinct players who played at least one
   *   match under the view scope.
   * `boardsCount` — sum of boardsWonA + boardsWonB across matches
   *   (i.e. total boards played under the scope).
   * `topPlayer` — the leader row (already sorted by
   *   buildPlayerSummary). Tie-broken by boards then points; if
   *   the top two are truly tied the label reads "Tied".
   */
  const summaryStats = $derived.by(() => {
    const r = viewReport;
    if (!r || r.rows.length === 0) return null;
    const matchesCount = r.matches;
    const playersCount = r.playerSummary.length;
    const boardsCount = r.rows.reduce(
      (n, row) => n + row.boardsWonA + row.boardsWonB,
      0,
    );
    const top = r.playerSummary[0] ?? null;
    const second = r.playerSummary[1] ?? null;
    const tiedAtTop =
      !!top &&
      !!second &&
      top.wins === second.wins &&
      top.boardsWon === second.boardsWon &&
      top.pointsScored === second.pointsScored;
    return {
      matchesCount,
      playersCount,
      boardsCount,
      topPlayer: top,
      tiedAtTop,
    };
  });

  /**
   * Distinct tournament count (v3.4.12) — how many tournaments the
   * archive has recorded matches for, regardless of the current
   * picker scope. Reads from the raw `matches` prop, not viewReport,
   * so the number stays stable across the picker. Includes the
   * untagged Default bucket if any untagged match exists.
   */
  const tournamentsCount = $derived.by(() => {
    const seen = new Set<string>();
    let hasUntagged = false;
    for (const m of matches) {
      const t = (m.tournament ?? '').trim();
      if (t) seen.add(t);
      else hasUntagged = true;
    }
    return seen.size + (hasUntagged ? 1 : 0);
  });

  /**
   * Per-round accordion fold state (v3.2). Session-only Set of
   * roundKeys the user has explicitly toggled — reset whenever
   * `selection` changes so switching tournaments starts with a
   * clean slate. Default open state is "all folded" so a
   * tournament with four rounds doesn't unfurl into a page-height
   * scroll on a phone the moment the picker fires.
   */
  let collapsedRounds = $state<Set<string>>(new Set());
  $effect(() => {
    // Reset whenever the selection changes. Read `selection` so
    // Svelte tracks it as a dependency of this effect.
    void selection;
    collapsedRounds = new Set();
  });
  function toggleRound(roundKey: string) {
    const next = new Set(collapsedRounds);
    if (next.has(roundKey)) next.delete(roundKey);
    else next.add(roundKey);
    collapsedRounds = next;
  }
  function isRoundOpen(roundKey: string): boolean {
    return !collapsedRounds.has(roundKey);
  }

  // pick() removed v3.4.12 — selection is now $derived off the
  // initialTournament prop, so writes go straight to the parent via
  // onSelectionChange. The Clear button and any other caller uses
  // onSelectionChange directly.

  // Copy-to-clipboard state. Ephemeral flag keyed by what was
  // copied — the main tournament table gets `__main__`, each
  // round's per-round table gets its `roundKey`. That way the
  // "✓ Copied" flash on one button doesn't light up the others.
  const MAIN_COPY_KEY = '__main__';
  let copiedKey = $state<string | null>(null);
  let copyTimer: number | null = null;

  async function copyRows(rows: ReportRow[], flashKey: string) {
    const tsv = toTSV(rows);
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
    copiedKey = flashKey;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => (copiedKey = null), 1800);
  }

  /**
   * Rank helper mirroring the carrom-thane.web.app leaderboard: the
   * first row gets its true rank, subsequent tied rows render "—"
   * so ties visually group. Tie-detection uses the same sort keys
   * buildPlayerSummary applied: wins DESC, boards DESC, points DESC.
   */
  function rankLabel(rows: PlayerSummary[], i: number): string {
    if (i === 0) return String(i + 1);
    const prev = rows[i - 1];
    const cur = rows[i];
    if (
      prev.wins === cur.wins &&
      prev.boardsWon === cur.boardsWon &&
      prev.pointsScored === cur.pointsScored
    ) {
      return '—';
    }
    return String(i + 1);
  }

  // ─────────────────────────────────────────────────────────────
  // Leaderboard + Matches sort & filter state (v3.4.12).
  //
  // Reports mirror History's toolbar: sortable columns for the
  // Leaderboard AND for the Matches table, plus a small filter row
  // shared across the two (player-name search + mode chips for
  // Matches; leaderboard picks up player-name search only).
  //
  // Persistence: only the sort keys are persisted, keyed on
  // 'carromscore.reports.prefs.v1'. Filters are transient per-
  // session — an organiser wants to jump to a player quickly but
  // shouldn't come back tomorrow with a stale filter still applied.
  // ─────────────────────────────────────────────────────────────
  type LBSortKey = 'rank' | 'name' | 'matches' | 'wins' | 'losses' | 'draws' | 'boards' | 'points';
  type MSortKey = 'endedAt' | 'mode' | 'sideA' | 'sideB' | 'setsA' | 'setsB' | 'points' | 'winner';
  const REPORTS_PREFS_KEY = 'carromscore.reports.prefs.v1';
  function loadReportsPrefs(): {
    lbSortKey: LBSortKey;
    lbSortDir: 'asc' | 'desc';
    mSortKey: MSortKey;
    mSortDir: 'asc' | 'desc';
  } {
    const fallback = {
      lbSortKey: 'rank' as LBSortKey,
      lbSortDir: 'asc' as const,
      mSortKey: 'endedAt' as MSortKey,
      mSortDir: 'desc' as const,
    };
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(REPORTS_PREFS_KEY) : null;
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const lbKeys: LBSortKey[] = ['rank', 'name', 'matches', 'wins', 'losses', 'draws', 'boards', 'points'];
      const mKeys: MSortKey[] = ['endedAt', 'mode', 'sideA', 'sideB', 'setsA', 'setsB', 'points', 'winner'];
      return {
        lbSortKey: lbKeys.includes(parsed.lbSortKey as LBSortKey) ? (parsed.lbSortKey as LBSortKey) : 'rank',
        lbSortDir: parsed.lbSortDir === 'desc' ? 'desc' : 'asc',
        mSortKey: mKeys.includes(parsed.mSortKey as MSortKey) ? (parsed.mSortKey as MSortKey) : 'endedAt',
        mSortDir: parsed.mSortDir === 'asc' ? 'asc' : 'desc',
      };
    } catch {
      return fallback;
    }
  }
  const initialReportsPrefs = loadReportsPrefs();
  let lbSortKey = $state<LBSortKey>(initialReportsPrefs.lbSortKey);
  let lbSortDir = $state<'asc' | 'desc'>(initialReportsPrefs.lbSortDir);
  let mSortKey = $state<MSortKey>(initialReportsPrefs.mSortKey);
  let mSortDir = $state<'asc' | 'desc'>(initialReportsPrefs.mSortDir);
  // Shared filter state (v3.4.12) — one bar drives both the
  // Leaderboard and the Matches table. The tournament dropdown drives
  // `selection` directly so the whole report scopes with it.
  // Initialised from URL query params so shared links preselect
  // filters, and mirrored back into the URL on every change.
  function initialFilterSearch(): string {
    if (typeof window === 'undefined') return '';
    return new URL(window.location.href).searchParams.get('rSearch') ?? '';
  }
  function initialFilterMode(): 'all' | 'singles' | 'doubles' {
    if (typeof window === 'undefined') return 'all';
    const v = new URL(window.location.href).searchParams.get('rMode');
    return v === 'singles' || v === 'doubles' ? v : 'all';
  }
  let filterSearch = $state<string>(initialFilterSearch());
  let filterMode = $state<'all' | 'singles' | 'doubles'>(initialFilterMode());
  // Mirror filter state to URL (rSearch, rMode). Guarded by !== '__init'
  // check on first run isn't needed because the initial values equal
  // whatever's already in the URL — writing them back is a no-op.
  $effect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (filterSearch.trim() === '') url.searchParams.delete('rSearch');
    else url.searchParams.set('rSearch', filterSearch);
    if (filterMode === 'all') url.searchParams.delete('rMode');
    else url.searchParams.set('rMode', filterMode);
    window.history.replaceState({}, '', url.toString());
  });
  $effect(() => {
    try {
      localStorage.setItem(
        REPORTS_PREFS_KEY,
        JSON.stringify({ lbSortKey, lbSortDir, mSortKey, mSortDir }),
      );
    } catch { /* ignore */ }
  });
  function toggleLBSort(k: LBSortKey): void {
    if (lbSortKey === k) {
      lbSortDir = lbSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      lbSortKey = k;
      // Text columns default to ascending; number columns default to
      // descending so the biggest / best row jumps to the top.
      lbSortDir = k === 'name' || k === 'rank' ? 'asc' : 'desc';
    }
  }
  function toggleMSort(k: MSortKey): void {
    if (mSortKey === k) {
      mSortDir = mSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      mSortKey = k;
      mSortDir = k === 'sideA' || k === 'sideB' || k === 'mode' || k === 'winner' ? 'asc' : 'desc';
    }
  }
  const sortedLeaderboard = $derived.by(() => {
    const r = viewReport;
    if (!r) return [];
    const q = filterSearch.trim().toLowerCase();
    const arr = r.playerSummary.filter((p) => !q || p.name.toLowerCase().includes(q));
    // Preserve buildPlayerSummary's baked-in tie-break order when
    // sorting by 'rank' (its input order IS the rank).
    if (lbSortKey === 'rank') {
      return lbSortDir === 'asc' ? arr : arr.slice().reverse();
    }
    const dir = lbSortDir === 'asc' ? 1 : -1;
    return arr.slice().sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (lbSortKey) {
        case 'name': av = a.name.toLowerCase(); bv = b.name.toLowerCase(); break;
        case 'matches': av = a.matches; bv = b.matches; break;
        case 'wins': av = a.wins; bv = b.wins; break;
        case 'losses': av = a.losses; bv = b.losses; break;
        case 'draws': av = a.draws; bv = b.draws; break;
        case 'boards': av = a.boardsWon; bv = b.boardsWon; break;
        case 'points': av = a.pointsScored; bv = b.pointsScored; break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  });
  const sortedMatches = $derived.by(() => {
    const r = viewReport;
    if (!r) return [];
    const q = filterSearch.trim().toLowerCase();
    const arr = r.rows.filter((row) => {
      if (filterMode !== 'all' && String(row.mode).toLowerCase() !== filterMode) return false;
      if (q) {
        const hay = `${row.sideA} ${row.sideB}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = mSortDir === 'asc' ? 1 : -1;
    return arr.slice().sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (mSortKey) {
        case 'endedAt': av = a.endedAtRaw ?? 0; bv = b.endedAtRaw ?? 0; break;
        case 'mode': av = String(a.mode); bv = String(b.mode); break;
        case 'sideA': av = String(a.sideA).toLowerCase(); bv = String(b.sideA).toLowerCase(); break;
        case 'sideB': av = String(a.sideB).toLowerCase(); bv = String(b.sideB).toLowerCase(); break;
        case 'setsA': av = a.setsA; bv = b.setsA; break;
        case 'setsB': av = a.setsB; bv = b.setsB; break;
        case 'points': av = a.pointsA + a.pointsB; bv = b.pointsA + b.pointsB; break;
        case 'winner': av = String(a.winner); bv = String(b.winner); break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return (b.endedAtRaw ?? 0) - (a.endedAtRaw ?? 0);
    });
  });

  const printTitle = $derived.by<string>(() => {
    if (!viewReport) return '';
    const t = viewReport.tournament ?? 'Default';
    const r = roundFilter
      ? ` · ${report?.roundReports?.find((x) => x.roundKey === roundFilter)?.roundName ?? roundFilter}`
      : '';
    const d = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
    return `${t}${r} — ${d}`;
  });
</script>

<section class="reports" data-print-title={printTitle}>
  <!--
    Shared filter bar (v3.4.12) — replaces both the top tournament
    chip strip AND the per-table search rows we had earlier.
    Player-name search + mode dropdown + tournament dropdown drive
    the whole Reports body: summary tiles, leaderboard, matches
    table. The Tournament select is now the ONLY tournament picker
    (the earlier compact-select was removed here). Tournament change
    fires pick() so URL deep-linking still works.
    Default value = null (Default bucket) — first-time visitors
    land on the untagged summary rather than the empty state.
  -->
  <div class="reports-filters" role="group" aria-label="Filter reports">
    <input
      type="search"
      class="rep-search"
      placeholder="Search player name…"
      bind:value={filterSearch}
      aria-label="Filter by player name"
    />
    <select
      class="rep-select"
      bind:value={filterMode}
      aria-label="Filter by match mode"
    >
      <option value="all">All modes</option>
      <option value="singles">Singles</option>
      <option value="doubles">Doubles</option>
    </select>
    <!--
      Tournament select (v3.4.12). Value derived from `selection`
      reactively; onchange writes back via pick() so the report
      body + URL deep-link stay in step. Earlier attempts used
      bind:value on a $state proxy backed by two syncing $effect
      blocks — worked in isolation but created subtle re-render
      loops that broke selection under certain click sequences.
      One-way + onchange is simpler and reliable.
    -->
    <select
      class="rep-select rep-select-tour"
      value={selectionProxy}
      onchange={onTournamentChange}
      aria-label="Tournament"
    >
      {#each options as opt (opt.key ?? '__default__')}
        <option value={opt.key === null ? '__default__' : opt.key}>{opt.label}</option>
      {/each}
    </select>
    {#if report && (report.roundReports?.length ?? 0) > 0}
      <!--
        Round dropdown (v3.4.12) — only rendered when the current
        tournament has round-tagged matches. Same one-way + onchange
        pattern as the tournament select above.
      -->
      <select
        class="rep-select rep-select-round"
        value={roundFilterProxy}
        onchange={onRoundChange}
        aria-label="Round"
      >
        <option value="__all__">All rounds</option>
        {#each report.roundReports ?? [] as rr (rr.roundKey)}
          <option value={rr.roundKey}>{rr.roundName}</option>
        {/each}
      </select>
    {/if}
    <!--
      Clear button (v3.4.12). Visible whenever ANY filter is off its
      default: search has text, mode isn't 'all', tournament isn't
      the Default bucket, or round isn't 'all rounds'. Reported
      2026-08-30: earlier version only tripped on search/mode
      changes, so a tournament or round pick left no way to reset
      to the base view without manually setting each dropdown back.
      Reset writes to `selection` via pick() (URL sync intact) and
      the effects push back into the proxy selects.
    -->
    {#if filterSearch.trim() !== '' || filterMode !== 'all' || selection !== null || roundFilter !== null}
      <button
        type="button"
        class="rep-clear"
        onclick={() => {
          filterSearch = '';
          filterMode = 'all';
          if (selection !== null) onSelectionChange(null);
          roundFilter = null;
        }}
        aria-label="Clear filters"
      >✕ Clear</button>
    {/if}
    {#if viewReport && viewReport.rows.length > 0}
      <button
        type="button"
        class="rep-print"
        onclick={() => window.print()}
        aria-label="Print report"
        title="Print landscape report"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true" style="flex-shrink:0">
          <rect x="2" y="5" width="10" height="6" rx="1" stroke="currentColor" stroke-width="1.3"/>
          <path d="M4 5V2.5a.5.5 0 01.5-.5h5a.5.5 0 01.5.5V5" stroke="currentColor" stroke-width="1.3"/>
          <rect x="4" y="8" width="6" height="2" rx=".3" fill="currentColor" opacity=".6"/>
          <rect x="10" y="6.5" width="1" height="1" rx=".2" fill="currentColor" opacity=".8"/>
        </svg>
        Print
      </button>
    {/if}
  </div>

  <!-- Round chip strip removed v3.4.12 — merged into the filter bar
       as a dropdown that appears conditionally when the current
       tournament has rounds. See the .reports-filters block above
       for the round <select>. -->


  {#if !viewReport}
    <div class="empty">
      <p><strong>Pick a tournament above.</strong></p>
      <p class="empty-sub">Every match tagged to that tournament will show up here with per-player summary, charts, and a copy-to-spreadsheet table.</p>
    </div>
  {:else if viewReport!.rows.length === 0}
    <div class="empty">
      <p><strong>No matches recorded {roundFilter ? 'in this round' : 'for this tournament'} yet.</strong></p>
      <p class="empty-sub">
        {#if roundFilter}
          Try another round, or clear the filter to see every match.
        {:else}
          Score a match on the home screen and tag it with <em>{viewReport!.tournament}</em>. It'll appear here as soon as it ends.
        {/if}
      </p>
    </div>
  {:else}
    {@const view = viewReport!}
    {@const stats = summaryStats}

    {#if stats}
      <!--
        Summary tiles (v3.3.3). One glance tells the umpire what
        they're looking at: matches, players, boards, and who's
        leading. Reads from `stats` which reads from viewReport so
        the round filter reshapes these tiles alongside everything
        else.
      -->
      <div class="stat-row">
        <!--
          Podium tile (v3.4.12): top three players in the current
          tournament + round scope. Each row = [medal] [Player name]
          [wins]. Medal-first per user preference so gold/silver/bronze
          anchor the row visually. Podium is the FIRST tile in the
          stat row — the eye lands here before the numeric summaries.
        -->
        <div class="stat-tile stat-tile-podium">
          <div class="stat-label podium-lbl">Top players</div>
          <div class="podium-list">
            {#each view.playerSummary.slice(0, 3) as p, i (p.playerId)}
              <div class="podium-row" class:podium-1={i === 0} class:podium-2={i === 1} class:podium-3={i === 2}>
                <span class="podium-medal" aria-hidden="true">{i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'}</span>
                <span class="podium-name" title={p.name}>{p.name}</span>
                <span class="podium-wins">{p.wins === 1 ? '1 W' : `${p.wins} W`}</span>
              </div>
            {/each}
          </div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{stats.matchesCount}</div>
          <div class="stat-label">{stats.matchesCount === 1 ? 'Match' : 'Matches'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{stats.playersCount}</div>
          <div class="stat-label">{stats.playersCount === 1 ? 'Player' : 'Players'}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-value">{stats.boardsCount}</div>
          <div class="stat-label">{stats.boardsCount === 1 ? 'Board' : 'Boards'}</div>
        </div>
      </div>
    {/if}

    <div class="tbl-hdr">
      <h3 class="section-hdr">Leaderboard</h3>
    </div>
    <!--
      Leaderboard (v3.4.12): heading lifted OUTSIDE the table wrapper
      so the tbody column layout matches the Matches table below —
      no bordered card around it. Sortable columns; rank column uses
      the buildPlayerSummary baked-in order (wins DESC → boards DESC
      → points DESC). Click any header to sort, click again to flip.
      The '—' tie-collapse only applies when the 'rank' sort is
      active — under other sorts the raw 1..N number is shown so
      re-sort doesn't relabel arbitrarily.
    -->
    <div class="tbl-scroll">
      <table class="matches-tbl leaderboard-tbl">
          <thead>
            <tr>
              <th class="col-rank hist-th-sortable" class:hist-th-sorted={lbSortKey === 'rank'} onclick={() => toggleLBSort('rank')}>
                # {#if lbSortKey === 'rank'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="col-name hist-th-sortable" class:hist-th-sorted={lbSortKey === 'name'} onclick={() => toggleLBSort('name')}>
                Player {#if lbSortKey === 'name'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'matches'} onclick={() => toggleLBSort('matches')}>
                Matches {#if lbSortKey === 'matches'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'wins'} onclick={() => toggleLBSort('wins')}>
                W {#if lbSortKey === 'wins'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'losses'} onclick={() => toggleLBSort('losses')}>
                L {#if lbSortKey === 'losses'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'draws'} onclick={() => toggleLBSort('draws')}>
                D {#if lbSortKey === 'draws'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'boards'} onclick={() => toggleLBSort('boards')}>
                Boards {#if lbSortKey === 'boards'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
              <th class="hist-th-sortable" class:hist-th-sorted={lbSortKey === 'points'} onclick={() => toggleLBSort('points')}>
                Points {#if lbSortKey === 'points'}<span class="sort-caret">{lbSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
              </th>
            </tr>
          </thead>
          <tbody>
            {#each sortedLeaderboard as p, i (p.playerId)}
              {@const raw = view.playerSummary.findIndex((x) => x.playerId === p.playerId)}
              {@const rank = lbSortKey === 'rank' ? rankLabel(view.playerSummary, raw) : String(raw + 1)}
              <tr class:leaderboard-top={lbSortKey === 'rank' && raw === 0 && lbSortDir === 'asc'}>
                <td class="col-rank">{rank}</td>
                <td class="col-name">{p.name}</td>
                <td>{p.matches}</td>
                <td>{p.wins}</td>
                <td>{p.losses}</td>
                <td>{p.draws}</td>
                <td>{p.boardsWon}</td>
                <td class="col-total">{p.pointsScored}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

    <div class="tbl-hdr">
      <h3 class="section-hdr">Matches ({sortedMatches.length}{#if sortedMatches.length !== view.matches} / {view.matches}{/if})</h3>
      <div class="tbl-actions">
        <button
          type="button"
          class="btn btn-copy"
          onclick={() => copyRows(sortedMatches, MAIN_COPY_KEY)}
          aria-label="Copy table to clipboard as tab-separated values"
        >
          {#if copiedKey === MAIN_COPY_KEY}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">⧉</span> Copy table{/if}
        </button>
      </div>
    </div>
    <!--
      Wrapper is horizontally scrollable on narrow screens so all
      columns stay readable — no wrapping cells or hidden data.
      Column headers are sortable (v3.4.12).
    -->
    <div class="tbl-scroll">
      <table class="matches-tbl">
        <thead>
          <tr>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'endedAt'} onclick={() => toggleMSort('endedAt')}>
              Ended {#if mSortKey === 'endedAt'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'mode'} onclick={() => toggleMSort('mode')}>
              Mode {#if mSortKey === 'mode'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="col-name hist-th-sortable" class:hist-th-sorted={mSortKey === 'sideA'} onclick={() => toggleMSort('sideA')}>
              Side A {#if mSortKey === 'sideA'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="col-name hist-th-sortable" class:hist-th-sorted={mSortKey === 'sideB'} onclick={() => toggleMSort('sideB')}>
              Side B {#if mSortKey === 'sideB'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'setsA'} onclick={() => toggleMSort('setsA')}>
              Sets A {#if mSortKey === 'setsA'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'setsB'} onclick={() => toggleMSort('setsB')}>
              Sets B {#if mSortKey === 'setsB'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th>Boards A</th>
            <th>Boards B</th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'points'} onclick={() => toggleMSort('points')}>
              Points A {#if mSortKey === 'points'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'points'} onclick={() => toggleMSort('points')}>
              Points B
            </th>
            <th class="hist-th-sortable" class:hist-th-sorted={mSortKey === 'winner'} onclick={() => toggleMSort('winner')}>
              Winner {#if mSortKey === 'winner'}<span class="sort-caret">{mSortDir === 'asc' ? '▲' : '▼'}</span>{/if}
            </th>
          </tr>
        </thead>
        <tbody>
          {#each sortedMatches as r (r._matchId)}
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

    <!--
      Per-round accordion (v3.2). Only renders when the tournament
      actually has rounds — buildTournamentReport returns
      `roundReports` only if at least one match carries a round tag,
      so pre-v3.2 tournaments (or tournaments an organiser hasn't
      set up rounds for yet) get the combined view above and nothing
      else. Each round's card mirrors the shape of the combined view
      but scoped to that round's matches: player summary + matches
      table. Charts are deliberately omitted per-round to keep the
      scroll length sane — the combined view has them.
    -->
    {#if roundFilter === null && report.roundReports && report.roundReports.length > 0}
      <!--
        Per-round accordion only renders when the round filter is
        "All rounds" (v3.3.3). If the umpire has narrowed the top
        view to a single round, the accordion below repeating that
        one round would be visual noise — the top view already
        shows exactly that data.
      -->
      <div class="rounds-section">
        <h3 class="section-hdr">Per-round breakdown</h3>
        {#each report.roundReports as rr (rr.roundKey)}
          {@const open = isRoundOpen(rr.roundKey)}
          <section
            class="round-report"
            class:round-report-unassigned={rr.roundKey === '__unassigned__'}
            class:round-folded={!open}
          >
            <button
              type="button"
              class="round-report-hdr"
              aria-expanded={open}
              onclick={() => toggleRound(rr.roundKey)}
            >
              <span class="round-report-caret" class:round-report-caret-folded={!open} aria-hidden="true">▾</span>
              <span class="round-report-name">{rr.roundName}</span>
              <span class="round-report-count">{rr.matches} match{rr.matches === 1 ? '' : 'es'}</span>
            </button>
            {#if open}
              {#if rr.rows.length === 0}
                <p class="round-report-empty">No matches in this round yet.</p>
              {:else}
                <div class="round-report-body">
                  <div class="summary-scroll">
                    <table class="summary-tbl leaderboard-tbl">
                      <thead>
                        <tr>
                          <th class="col-rank">#</th>
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
                        {#each rr.playerSummary as p, i (p.playerId)}
                          <tr class:leaderboard-top={i === 0}>
                            <td class="col-rank">{rankLabel(rr.playerSummary, i)}</td>
                            <td class="col-name">{p.name}</td>
                            <td>{p.matches}</td>
                            <td>{p.wins}</td>
                            <td>{p.losses}</td>
                            <td>{p.draws}</td>
                            <td>{p.boardsWon}</td>
                            <td class="col-total">{p.pointsScored}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                  <div class="round-report-actions">
                    <button
                      type="button"
                      class="btn btn-copy"
                      onclick={() => copyRows(rr.rows, rr.roundKey)}
                      aria-label="Copy this round's table to clipboard"
                    >
                      {#if copiedKey === rr.roundKey}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">⧉</span> Copy round table{/if}
                    </button>
                  </div>
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
                        {#each rr.rows as r (r._matchId)}
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
                </div>
              {/if}
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .reports {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  /* Tournament chip picker (round strip only; the top tournament
     row now uses .picker-compact + a native <select>). */
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
  /* Shared filter bar (v3.4.12) — search + mode + tournament in one
     row above the summary tiles. Same visual language as the History
     tab's filter bar. */
  .reports-filters {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.75rem;
    padding: 0.6rem 0.75rem;
    /* Gold-tint highlight (v3.4.12) to distinguish the filter bar as
       the primary scoping control for the tab — otherwise it reads
       as another neutral chrome block. */
    background: rgba(255, 213, 74, 0.05);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.7rem;
    box-shadow: 0 0 0 1px rgba(255, 213, 74, 0.06),
                0 0 18px rgba(255, 213, 74, 0.08);
  }
  .rep-search {
    flex: 1 1 12rem;
    min-width: 8rem;
    padding: 0.4rem 0.6rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.85rem;
  }
  .rep-search:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .rep-select {
    padding: 0.4rem 0.6rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }
  /* Tournament + Round selects use the same neutral fg colour as
     the Mode select. Earlier we had them in accent gold, but the
     gold clashed with the gold-tinted filter bar around them
     (reported 2026-08-30). Border and label stay neutral;
     the amber tint on the bar itself is enough emphasis. */
  .rep-select-tour {
    min-width: 12rem;
    max-width: min(24rem, 60vw);
    font-weight: 700;
  }
  .rep-select-round {
    min-width: 8rem;
    max-width: min(18rem, 50vw);
    font-weight: 700;
  }
  .rep-select:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .rep-clear {
    padding: 0.35rem 0.65rem;
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.4);
    border-radius: 0.45rem;
    color: #ef5350;
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
  }
  .rep-clear:hover { background: rgba(239, 83, 80, 0.08); }
  .rep-print {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-left: auto;
    padding: 0.35rem 0.65rem;
    background: transparent;
    border: 1px solid rgba(255, 213, 74, 0.45);
    border-radius: 0.45rem;
    color: var(--accent, #ffd54a);
    font: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
  }
  .rep-print:hover { background: rgba(255, 213, 74, 0.08); }
  @media print {
    @page { size: A4 landscape; margin: 1.5cm 1.2cm; }

    /* ── Hide all chrome except the report body ── */
    :global(.offline-banner),
    :global(nav),
    :global(.tab-bar),
    :global(.lobby-tabs),
    :global(.lobby-header),
    :global(.footer),
    :global(.foot-block),
    :global(.hdr),
    :global(.tabs),
    .reports-filters,
    .tbl-hdr .tbl-actions,
    .btn-copy,
    .round-report-actions { display: none !important; }

    :global(body) { background: #fff !important; color: #111 !important; }
    :global(.tab-content),
    :global(.reports-tab),
    :global(.reports) { padding: 0 !important; background: #fff !important; }

    /* ── Print header injected via ::before on .reports ── */
    .reports::before {
      content: attr(data-print-title);
      display: block;
      font-size: 1.5rem;
      font-weight: 900;
      color: #111;
      letter-spacing: 0.01em;
      padding-bottom: 0.5rem;
      margin-bottom: 0.8rem;
      border-bottom: 3px solid #000;
    }

    /* ── Stat tiles: horizontal strip, compact ── */
    .stat-row {
      display: flex !important;
      flex-direction: row !important;
      gap: 0.6rem !important;
      margin-bottom: 0.9rem !important;
    }
    .stat-tile {
      border: 1.5px solid #ccc !important;
      background: #fff !important;
      color: #111 !important;
      padding: 0.45rem 0.75rem !important;
      border-radius: 0.4rem !important;
      flex: 1 1 0 !important;
    }
    .stat-tile-podium {
      flex: 2 1 0 !important;
      border-color: #b8990a !important;
      background: #fffbe6 !important;
    }
    .stat-value { color: #111 !important; font-size: 1.3rem !important; }
    .stat-label { color: #555 !important; }
    .podium-lbl { color: #b8990a !important; }
    .podium-name { color: #111 !important; }
    .podium-1 .podium-name { color: #b8990a !important; }
    .podium-wins { color: #555 !important; }

    /* ── Section headings ── */
    .section-hdr {
      color: #111 !important;
      font-size: 0.75rem !important;
      border-bottom: 2px solid #000;
      padding-bottom: 0.2rem;
      margin-bottom: 0.4rem !important;
    }
    .tbl-hdr { margin-bottom: 0.3rem !important; }

    /* ── Both tables: clean black-on-white ── */
    .tbl-scroll,
    .summary-scroll {
      overflow: visible !important;
      background: transparent !important;
      border: none !important;
      border-radius: 0 !important;
    }
    .leaderboard-tbl,
    .summary-tbl,
    .matches-tbl {
      min-width: 0 !important;
      width: 100% !important;
      border-collapse: collapse !important;
      font-size: 0.8rem !important;
    }
    .leaderboard-tbl th,
    .leaderboard-tbl td,
    .summary-tbl th,
    .summary-tbl td,
    .matches-tbl th,
    .matches-tbl td {
      padding: 0.28rem 0.5rem !important;
      border: 1px solid #ddd !important;
      color: #111 !important;
      background: #fff !important;
    }
    .leaderboard-tbl th,
    .summary-tbl th,
    .matches-tbl th {
      background: #f5f5f5 !important;
      font-size: 0.68rem !important;
      color: #444 !important;
      text-transform: uppercase !important;
      letter-spacing: 0.05em !important;
    }
    /* Top leaderboard row: gold tint */
    .leaderboard-tbl tr.leaderboard-top td {
      background: #fffbe6 !important;
    }
    .leaderboard-tbl tr.leaderboard-top .col-rank,
    .leaderboard-tbl tr.leaderboard-top .col-name {
      color: #b8990a !important;
    }
    .leaderboard-tbl .col-total { color: #111 !important; font-weight: 700 !important; }
    /* Zebra for readability */
    .matches-tbl tbody tr:nth-child(even) td {
      background: #f9f9f9 !important;
    }

    /* ── Winner tags: print-safe colours ── */
    .winner-tag { border: 1px solid #bbb !important; }
    .winner-a {
      background: #e3f2fd !important;
      color: #1565c0 !important;
      border-color: #90caf9 !important;
    }
    .winner-b {
      background: #fbe9e7 !important;
      color: #bf360c !important;
      border-color: #ffab91 !important;
    }
    .winner-draw {
      background: #f5f0e6 !important;
      color: #795548 !important;
      border-color: #bcaaa4 !important;
    }

    /* ── Per-round accordion: print all open, remove chrome ── */
    .rounds-section { margin-top: 0.8rem !important; }
    .round-report {
      background: #fff !important;
      border: none !important;
      border-top: 2px solid #000 !important;
      border-radius: 0 !important;
      break-inside: avoid;
      page-break-inside: avoid;
      margin-bottom: 0.5rem !important;
    }
    .round-report-hdr {
      background: transparent !important;
      padding: 0.35rem 0 !important;
      color: #111 !important;
      font-size: 0.82rem !important;
      pointer-events: none;
    }
    .round-report-caret { display: none !important; }
    .round-report-body {
      display: flex !important;
      padding: 0 0 0.5rem !important;
    }
    /* Force all rounds to show when printing */
    .round-folded .round-report-body { display: flex !important; }
    .round-report-count {
      background: transparent !important;
      color: #555 !important;
    }
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
  /* "Default" bucket sits at the tail of the tournament row and
     reads as a fallback rather than a real event. Subtler tint so
     the eye lands on the real tournaments first. */
  .chip-default:not(.chip-on) {
    color: rgba(255, 255, 255, 0.4);
    border-color: rgba(255, 255, 255, 0.08);
    font-style: italic;
  }
  /* Round chip strip sits directly below the tournament strip, so
     tighten the top margin. */
  .picker-round {
    margin-top: -0.35rem;
  }

  /* ─── Summary tiles (v3.3.3) ─────────────────────────────────── */
  .stat-row {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 0.6rem;
  }
  /* Wider viewport: 3 number tiles + podium spanning 2 = 5 cols. */
  @media (min-width: 720px) {
    .stat-row {
      grid-template-columns: repeat(5, 1fr);
    }
    .stat-tile-podium {
      grid-column: span 2;
    }
  }
  /* Mid-width tablet: 3 number tiles in a row, podium spans full width. */
  @media (min-width: 560px) and (max-width: 719px) {
    .stat-row {
      grid-template-columns: repeat(3, 1fr);
    }
    .stat-tile-podium {
      grid-column: span 3;
    }
  }
  /* Narrow phones: number tiles 2-col, podium spans full width. */
  @media (max-width: 559px) {
    .stat-tile-podium {
      grid-column: span 2;
    }
  }
  .stat-tile {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-top: 2px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: 0.1rem;
    min-width: 0;
  }
  .stat-value {
    font-size: 1.5rem;
    font-weight: 700;
    line-height: 1.1;
    color: var(--accent, #ffd54a);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .stat-value-name {
    font-size: 1.05rem;
    color: var(--accent, #ffd54a);
  }
  .stat-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #9aa0a6);
  }
  .stat-tile-leader {
    background: rgba(255, 213, 74, 0.05);
    border-color: rgba(255, 213, 74, 0.22);
    border-top-color: rgba(255, 213, 74, 0.55);
  }
  /* Podium tile (v3.4.12) — replaces the single "Leader" tile with
     a compact top-3 list. Player column first, medal + wins on the
     right. The three rows are colour-toned so the top one visually
     dominates without shouting. */
  .stat-tile-podium {
    background: rgba(255, 213, 74, 0.05);
    border-color: rgba(255, 213, 74, 0.28);
    padding: 0.6rem 0.75rem;
    gap: 0.4rem;
  }
  .podium-lbl {
    font-size: 0.62rem;
    color: var(--accent, #ffd54a);
    opacity: 0.8;
  }
  .podium-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .podium-row {
    display: grid;
    /* medal (fixed) · name (flex) · wins (fixed). Medal-first order
       per user preference so the gold/silver/bronze anchor is the
       leftmost visual cue. */
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.15rem 0;
    min-width: 0;
  }
  .podium-name {
    font-weight: 700;
    color: var(--fg, #f5f5f5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    font-size: 0.9rem;
  }
  .podium-medal {
    font-size: 0.95rem;
    line-height: 1;
  }
  .podium-wins {
    font-size: 0.72rem;
    color: var(--muted, #9aa0a6);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  /* Row 1 stands out in gold; rows 2 and 3 stay in the neutral fg
     colour but keep the same layout so the medal column stays aligned.
     Bit of a bling-hierarchy without going overboard. */
  .podium-1 .podium-name {
    color: var(--accent, #ffd54a);
    font-size: 1rem;
  }
  .podium-1 .podium-medal {
    font-size: 1.05rem;
    filter: drop-shadow(0 0 3px rgba(255, 213, 74, 0.35));
  }
  .podium-2 .podium-name,
  .podium-3 .podium-name {
    opacity: 0.9;
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
  /* Horizontal-scroll shell so the summary table's rightmost columns
     (Boards, Points) don't clip on narrow phones when player names
     are long. Same pattern as .tbl-scroll for the Matches table. */
  .summary-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    margin: 0 -0.35rem;
  }
  .summary-tbl {
    min-width: 460px;
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

  /* ─── Leaderboard (v3.3.3, restyled off carrom-thane.web.app) ── */
  .leaderboard-tbl .col-rank {
    text-align: center !important;
    width: 2.2rem;
    color: var(--muted, #9aa0a6);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .leaderboard-tbl .col-total {
    font-weight: 700;
    color: var(--fg, #f5f5f5);
    font-variant-numeric: tabular-nums;
  }
  /* Top row (rank 1) — gets a subtle accent tint so the leader
     jumps out at a glance. Ties for first also inherit this via the
     leaderboard-top class on row 0. */
  .leaderboard-tbl tr.leaderboard-top td {
    background: rgba(255, 213, 74, 0.06);
  }
  .leaderboard-tbl tr.leaderboard-top .col-rank,
  .leaderboard-tbl tr.leaderboard-top .col-name {
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }

  /* Per-round Copy button strip inside the accordion body. Aligns
     right so it doesn't crowd the table title. */
  .round-report-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.4rem;
    margin: 0.2rem 0 0.5rem;
  }

  /* Sort + filter toolbar shared between Leaderboard and Matches
     tables (v3.4.12). Mirrors the History tab's toolbar palette so
     the two feel like one design language. */
  .tbl-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    flex-wrap: wrap;
    margin-bottom: 0.55rem;
  }
  .tbl-toolbar .section-hdr {
    margin: 0;
  }
  .tbl-filters {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0.55rem 0 0.6rem;
  }
  .tbl-search {
    flex: 1 1 12rem;
    min-width: 8rem;
    max-width: 20rem;
    padding: 0.4rem 0.6rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
  }
  .tbl-search:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .tbl-chips {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.15rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
  }
  .tbl-chip {
    padding: 0.25rem 0.55rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
  }
  .tbl-chip:hover { color: var(--fg, #f5f5f5); }
  .tbl-chip-active {
    background: rgba(255, 213, 74, 0.12);
    border-color: rgba(255, 213, 74, 0.45);
    color: var(--accent, #ffd54a);
  }
  /* Sortable header cell (both tables). Same class name as the
     History-tab tables so the visual language stays consistent. */
  .summary-tbl th.hist-th-sortable,
  .matches-tbl th.hist-th-sortable {
    cursor: pointer;
    user-select: none;
  }
  .summary-tbl th.hist-th-sortable:hover,
  .matches-tbl th.hist-th-sortable:hover {
    color: var(--fg, #f5f5f5);
  }
  .summary-tbl th.hist-th-sorted,
  .matches-tbl th.hist-th-sorted {
    color: var(--accent, #ffd54a);
  }
  .sort-caret {
    margin-left: 0.2rem;
    font-size: 0.62rem;
  }

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

  /* ─── Per-round accordion (v3.2) ─────────────────────────────── */
  .rounds-section {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin-top: 0.5rem;
  }
  .round-report {
    background: rgba(255, 213, 74, 0.04);
    border: 1px solid rgba(255, 213, 74, 0.18);
    border-radius: 0.6rem;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .round-report-hdr {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.6rem 0.9rem;
    background: transparent;
    border: 0;
    color: var(--fg, #f5f5f5);
    text-align: left;
    cursor: pointer;
    font: inherit;
    font-size: 0.92rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    transition: background 0.12s;
  }
  .round-report-hdr:hover { background: rgba(255, 213, 74, 0.08); }
  .round-report-hdr:focus-visible {
    outline: 2px solid var(--accent, #ffd54a);
    outline-offset: -2px;
  }
  /* Caret matches the History tab's round caret + the parent
     tournament caret. Filled ▾ that rotates -90° when folded;
     chip background at the same footprint as the tournament caret
     so the control reads unambiguously as a button. */
  .round-report-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.4rem;
    background: rgba(255, 213, 74, 0.14);
    color: var(--accent, #ffd54a);
    font-size: 1rem;
    line-height: 1;
    flex: 0 0 auto;
    transition: transform 0.18s ease, background 0.12s;
  }
  .round-report-caret-folded {
    transform: rotate(-90deg);
  }
  .round-report-hdr:hover .round-report-caret {
    background: rgba(255, 213, 74, 0.24);
  }
  .round-report-name { flex: 1 1 auto; }
  .round-report-count {
    font-size: 0.72rem;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.55);
    background: rgba(255, 255, 255, 0.06);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    flex: 0 0 auto;
  }
  /* Unassigned bucket — visually deprioritised vs a real round. */
  .round-report.round-report-unassigned {
    background: rgba(255, 255, 255, 0.02);
    border-color: rgba(255, 255, 255, 0.10);
  }
  .round-report-unassigned .round-report-name {
    color: rgba(255, 255, 255, 0.65);
    font-style: italic;
    font-weight: 500;
  }
  .round-report-unassigned .round-report-caret {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.55);
  }
  .round-report-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.25rem 0.85rem 0.85rem;
  }
  .round-report-empty {
    margin: 0;
    padding: 0 0.9rem 0.85rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    font-style: italic;
  }
</style>
