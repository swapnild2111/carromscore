<script lang="ts">
  /**
   * Knockout / Round Robin setup screen.
   *
   * For 'knockout': one tab — seed list (drag-reorder) → Generate Bracket.
   * For 'roundrobin': two tabs — Tab 1 single-group schedule, Tab 2 standings → advance top N.
   */
  import { onMount } from 'svelte';
  import type { Tournament } from '../../lib/tournaments';
  import { startRound, loadAssignedPlayers } from '../../lib/tournaments';
  import { loadAll as loadAllPlayers, subscribeStore as subscribePlayerStore } from '../../lib/players';
  import { subscribePlannedByTournament, type PlannedMatch } from '../../lib/planned';
  import {
    shuffleArray,
    computeGroupStandings,
    generateLeagueSchedule,
    generateKnockoutBracket,
    PHANTOM_ID,
    type GroupStandings,
  } from '../../lib/league';
  import type { PlayerSummary } from '../../lib/reports';

  interface Props {
    tournament: Tournament;
    myUid: string;
    onClose: () => void;
  }

  const { tournament, myUid, onClose }: Props = $props();

  const isRR = $derived(tournament.format === 'roundrobin');

  // ─── Tab ────────────────────────────────────────────────────────────────────
  let activeTab = $state<'draw' | 'bracket'>('draw');

  // ─── Players ────────────────────────────────────────────────────────────────
  let players = $state(loadAllPlayers());
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsubPlayers: (() => void) | null = null;
  let unsubPlanned: (() => void) | null = null;
  // Full pool of players available for this tournament (assigned or country-filtered)
  let availablePlayerIds = $state<string[]>([]);
  // Players added to the bracket (right pane) — no ordering, treated as equal seeds
  let selectedIds = $state(new Set<string>());
  // Search filters — separate for each pane
  let poolSearch = $state('');
  let bracketSearch = $state('');

  function playerName(id: string): string {
    return players.find((p) => p.id === id)?.canonicalName ?? id;
  }

  // Pool (left): available players not yet in bracket
  const poolIds = $derived(
    availablePlayerIds.filter((id) => !selectedIds.has(id))
  );
  const filteredPool = $derived(
    poolIds.filter((id) => {
      if (!poolSearch.trim()) return true;
      return playerName(id).toLowerCase().includes(poolSearch.toLowerCase());
    })
  );
  // Bracket (right): selected players
  const bracketIds = $derived([...selectedIds]);
  const filteredBracket = $derived(
    bracketIds.filter((id) => {
      if (!bracketSearch.trim()) return true;
      return playerName(id).toLowerCase().includes(bracketSearch.toLowerCase());
    })
  );

  function addToBracket(id: string) {
    const next = new Set(selectedIds);
    next.add(id);
    selectedIds = next;
  }

  function removeFromBracket(id: string) {
    const next = new Set(selectedIds);
    next.delete(id);
    selectedIds = next;
  }

  function addAllToBracket() {
    selectedIds = new Set(availablePlayerIds);
  }

  function clearBracket() {
    selectedIds = new Set();
  }

  // ─── Seed list — flat array derived from selectedIds for generation ──────────
  // Seeds are unordered — treated equally. Random draw shuffles to produce a random bracket.
  let seedList = $state<string[]>([]);
  let bracketLocked = $state(false);

  function bracketHint(n: number): string {
    if (n < 2) return '';
    const size = Math.pow(2, Math.ceil(Math.log2(n)));
    const byes = size - n;
    const rounds: string[] = [];
    if (size >= 32) rounds.push('R32');
    if (size >= 16) rounds.push('R16');
    if (size >= 8)  rounds.push('QF');
    if (size >= 4)  rounds.push('SF');
    rounds.push('Final');
    const byeNote = byes > 0 ? ` (${byes} bye${byes > 1 ? 's' : ''})` : '';
    return `${n} players → ${rounds.join(' + ')}${byeNote}`;
  }

  function doRandomDraw() {
    // Shuffle all available into the bracket pane
    const shuffled = shuffleArray([...availablePlayerIds]);
    selectedIds = new Set(shuffled);
    seedList = shuffled;
    bracketLocked = false;
  }

  // ─── Bracket generation (knockout) ──────────────────────────────────────────
  let generating = $state(false);
  let generateError = $state('');
  let generateResult = $state<{ roundsCreated: string[]; matchesCreated: number; errors: string[] } | null>(null);

  async function doGenerateBracket(seeds?: string[]) {
    const finalSeeds = seeds ?? shuffleArray([...selectedIds]);
    if (generating || finalSeeds.length < 2) return;
    generating = true;
    generateError = '';
    generateResult = null;
    const playerNamesMap = new Map(finalSeeds.map((id) => [id, playerName(id)]));
    const result = await generateKnockoutBracket({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      seeds: finalSeeds,
      playerNames: playerNamesMap,
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
        timerDuration: tournament.defaults?.timerDuration,
      },
      myUid,
    });
    generateResult = result;
    if (result.errors.length === 0) bracketLocked = true;
    // Start any generated rounds
    for (const rName of result.roundsCreated) {
      const round = tournament.rounds?.find((r) => r.name === rName);
      if (round && !round.startedAt) await startRound(tournament.key, round.key);
    }
    generating = false;
  }

  // ─── Round Robin: single-group schedule ─────────────────────────────────────
  let rrGenerating = $state(false);
  let rrGenResult = $state<{ groupsCreated: number; matchesCreated: number; errors: string[] } | null>(null);
  let rrScheduleLocked = $state(false);

  async function doGenerateRRSchedule() {
    const rrParticipants = selectedIds.size > 0 ? [...selectedIds] : [...availablePlayerIds];
    seedList = rrParticipants;
    if (rrGenerating || rrParticipants.length < 2) return;
    rrGenerating = true;
    rrGenResult = null;
    const playerNamesMap = new Map(rrParticipants.map((id) => [id, playerName(id)]));
    // Single group — all players vs everyone
    const groups: Record<string, { name: string; order: number; playerIds: string[] }> = {
      'rr': { name: 'RR', order: 1, playerIds: rrParticipants },
    };
    const leagueCfg = {
      groupCount: 1,
      playersPerGroup: rrParticipants.length,
      boardsPerGroup: tournament.defaults?.maxBoards ?? 2,
      flightNames: [] as string[],
    };
    const result = await generateLeagueSchedule({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups,
      leagueCfg,
      playerNames: playerNamesMap,
      playerResolvedIds: new Map(rrParticipants.map((id) => [id, id])),
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
      },
      myUid,
    });
    rrGenResult = result;
    if (result.errors.length === 0) {
      rrScheduleLocked = true;
      // Start the RR round
      const round = tournament.rounds?.find((r) => r.name === 'Group RR');
      if (round && !round.startedAt) await startRound(tournament.key, round.key);
    }
    rrGenerating = false;
  }

  // ─── Round Robin: standings & advance ────────────────────────────────────────
  let advanceCount = $state(4);

  const rrMatches = $derived(plannedMatches.filter((m) => m.round === 'Group RR'));

  const rrCompleted = $derived(rrMatches.filter((m) => m.completedAt).length);
  const rrTotal = $derived(rrMatches.length);
  const rrAllDone = $derived(rrTotal > 0 && rrCompleted === rrTotal);

  const rrStandings = $derived.by<GroupStandings | null>(() => {
    const rrParticipants = seedList.length > 0 ? seedList : (selectedIds.size > 0 ? [...selectedIds] : [...availablePlayerIds]);
    if (rrParticipants.length < 2) return null;
    const summaries = buildStandingsFromPlanned(rrMatches);
    const group = { name: 'RR', order: 1, playerIds: rrParticipants };
    return computeGroupStandings(group, summaries);
  });

  let advanceForceGenerate = $state(false);
  let advanceGenerating = $state(false);
  let advanceGenResult = $state<{ roundsCreated: string[]; matchesCreated: number; errors: string[] } | null>(null);

  async function doAdvanceToKnockout() {
    if (!rrStandings || advanceGenerating) return;
    advanceGenerating = true;
    advanceGenResult = null;
    const topSeeds = rrStandings.players.slice(0, advanceCount).map((p) => p.playerId);
    await doGenerateBracket(topSeeds);
    advanceGenResult = generateResult;
    advanceGenerating = false;
  }

  function buildStandingsFromPlanned(matches: PlannedMatch[]): PlayerSummary[] {
    const map = new Map<string, PlayerSummary>();
    const ensure = (id: string, name: string) => {
      if (!map.has(id)) {
        map.set(id, { playerId: id, name, matches: 0, wins: 0, losses: 0, draws: 0, boardsWon: 0, pointsScored: 0, strikePoints: 0, netPoints: 0 });
      }
      return map.get(id)!;
    };
    for (const m of matches) {
      if (!m.completedAt || !m.result) continue;
      const aId = m.aResolvedId;
      const bId = m.bResolvedId;
      if (!aId || !bId) continue;
      const a = ensure(aId, m.aName);
      const b = ensure(bId, m.bName);
      const { setsA, setsB, winner } = m.result;
      a.matches++; b.matches++;
      if (winner === 'a') { a.wins++; a.strikePoints += 2; b.losses++; }
      else if (winner === 'b') { b.wins++; b.strikePoints += 2; a.losses++; }
      else { a.draws++; a.strikePoints += 1; b.draws++; b.strikePoints += 1; }
      a.boardsWon += setsA; b.boardsWon += setsB;
      a.netPoints += setsA - setsB; b.netPoints += setsB - setsA;
    }
    return [...map.values()].filter((s) => s.playerId !== PHANTOM_ID);
  }

  // ─── Bracket round summary (after generation) ────────────────────────────────
  const bracketRoundRx = /^(R32|R16|QF|SF|Final)$/i;
  const bracketMatches = $derived(plannedMatches.filter((m) => bracketRoundRx.test(m.round ?? '')));
  const bracketRounds = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    const order = ['R32', 'R16', 'QF', 'SF', 'Final'];
    for (const m of bracketMatches) if (m.round) seen.add(m.round);
    return order.filter((r) => seen.has(r));
  });

  // ─── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    unsubPlayers = subscribePlayerStore(() => { players = loadAllPlayers(); });
    (async () => {
      const assigned = await loadAssignedPlayers(tournament.key);
      if (assigned.size > 0) {
        availablePlayerIds = [...assigned];
      } else if (tournament.country) {
        availablePlayerIds = players
          .filter((p) => p.country?.toUpperCase() === tournament.country!.toUpperCase())
          .map((p) => p.id);
      } else {
        availablePlayerIds = players.map((p) => p.id);
      }
      // Start with empty bracket — user picks from left pane (or uses Random draw)
      selectedIds = new Set();
      seedList = [];

      unsubPlanned = await subscribePlannedByTournament(tournament.key, (arr) => {
        plannedMatches = arr;
        // Detect if bracket already exists
        const hasBracket = arr.some((m) => bracketRoundRx.test(m.round ?? ''));
        if (hasBracket) bracketLocked = true;
        // Detect if RR schedule exists
        const hasRR = arr.some((m) => m.round === 'Group RR');
        if (hasRR) {
          rrScheduleLocked = true;
          // Restore RR participant set from existing matches
          if (seedList.length === 0) {
            const ids = new Set<string>();
            for (const m of arr) {
              if (m.round === 'Group RR') {
                if (m.aResolvedId) ids.add(m.aResolvedId);
                if (m.bResolvedId) ids.add(m.bResolvedId);
              }
            }
            if (ids.size > 0) {
              seedList = [...ids];
              selectedIds = ids;
            }
          }
        }
      });
    })();
    return () => { unsubPlayers?.(); unsubPlanned?.(); };
  });
</script>

<div class="ks-overlay" role="dialog" aria-modal="true" aria-label="Knockout Setup">
  <div class="ks-card">
    <div class="ks-header">
      <h2 class="ks-title">
        {isRR ? 'Round Robin' : 'Knockout'} Setup — {tournament.name}
      </h2>
      <button type="button" class="ks-close" onclick={onClose} aria-label="Close">✕</button>
    </div>

    <!-- Tab bar — only show for RR -->
    {#if isRR}
      <div class="ks-tabs" role="tablist">
        <button
          type="button"
          class="ks-tab"
          class:ks-tab-active={activeTab === 'draw'}
          role="tab"
          aria-selected={activeTab === 'draw'}
          onclick={() => { activeTab = 'draw'; }}
        >Groups &amp; Draw</button>
        <button
          type="button"
          class="ks-tab"
          class:ks-tab-active={activeTab === 'bracket'}
          role="tab"
          aria-selected={activeTab === 'bracket'}
          onclick={() => { activeTab = 'bracket'; }}
        >Knockout Matches</button>
      </div>
    {/if}

    <!-- ─── Knockout draw / RR schedule tab ─────────────────────────────────── -->
    {#if !isRR || activeTab === 'draw'}
      <div class="ks-body">

        {#if !isRR}
          {#if !bracketLocked}
            <!-- Knockout: pool picker (left) + bracket players (right) — only shown before generation -->
            <div class="draw-panes">
              <!-- Left: tournament pool — click → to add to bracket -->
              <div class="picker-pane">
                <div class="picker-header">
                  <span class="picker-title">Tournament players ({poolIds.length})</span>
                  <button type="button" class="btn-link" onclick={addAllToBracket} title="Add all to bracket">Add all →</button>
                </div>
                <input
                  class="picker-search"
                  type="search"
                  placeholder="Search…"
                  bind:value={poolSearch}
                  aria-label="Search tournament players"
                />
                <div class="picker-list">
                  {#if availablePlayerIds.length === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">No players assigned. Use the <strong>Players</strong> button on the tournament row to assign players first.</p>
                  {:else if filteredPool.length === 0 && poolSearch}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">No match.</p>
                  {:else if poolIds.length === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">All players are in the bracket.</p>
                  {:else}
                    {#each filteredPool as pid (pid)}
                      <button type="button" class="pool-row" onclick={() => addToBracket(pid)}>
                        <span class="pool-name">{playerName(pid)}</span>
                        <span class="pool-add" aria-hidden="true">→</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>

              <!-- Right: bracket players — click ← to remove -->
              <div class="seed-pane">
                <div class="picker-header">
                  <span class="picker-title">Bracket ({selectedIds.size})</span>
                  <div style="display:flex;align-items:center;gap:0.5rem;">
                    <span class="draw-hint">{bracketHint(selectedIds.size)}</span>
                    {#if selectedIds.size > 0}
                      <button type="button" class="btn-link" onclick={clearBracket} title="Remove all">Clear</button>
                    {/if}
                  </div>
                </div>
                <input
                  class="picker-search"
                  type="search"
                  placeholder="Search…"
                  bind:value={bracketSearch}
                  aria-label="Search bracket players"
                />
                <div class="picker-list">
                  {#if selectedIds.size === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">Click players on the left to add them, or use Random draw.</p>
                  {:else}
                    {#each filteredBracket as pid (pid)}
                      <button type="button" class="seed-row-btn" onclick={() => removeFromBracket(pid)}>
                        <span class="pool-remove" aria-hidden="true">←</span>
                        <span class="pool-name">{playerName(pid)}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>
            </div>
          {:else}
            <!-- Bracket locked — League-style group boxes per round -->
            {@const completedCount = bracketMatches.filter(m => !!m.completedAt).length}
            {@const totalCount = bracketMatches.length}
            {@const allDone = totalCount > 0 && completedCount === totalCount}
            <div class="draw-controls">
              <span class="draw-hint">{bracketIds.length} players → {bracketHint(bracketIds.length)}</span>
              <span class="draw-locked-hint">🔒 Bracket locked — rounds in progress</span>
            </div>
            <div class="groups-grid" style="grid-template-columns: repeat({Math.min(bracketRounds.length, 4)}, 1fr)">
              {#each bracketRounds as rName}
                {@const rMatches = bracketMatches.filter((m) => m.round === rName)}
                {@const rDone = rMatches.length > 0 && rMatches.every(m => !!m.completedAt)}
                <div class="group-col" class:group-col-done={rDone}>
                  <div class="group-col-header">
                    <span>{rName}</span>
                    <div class="group-col-header-right">
                      <span class="group-match-status" class:group-match-done={rDone}>
                        {rMatches.filter(m => !!m.completedAt).length} / {rMatches.length} complete
                      </span>
                    </div>
                  </div>
                  {#each rMatches as m (m.mid)}
                    <div class="bracket-match-chip" class:completed={!!m.completedAt}>
                      <span class="bm-order">{m.matchOrder}</span>
                      <span class="bm-player" class:winner={m.result?.winner === 'a'}>{m.aName}</span>
                      <span class="bm-vs">vs</span>
                      <span class="bm-player" class:winner={m.result?.winner === 'b'}>{m.bName}</span>
                      {#if m.result}
                        <span class="bm-result">{m.result.setsA}–{m.result.setsB}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
            <p class="bracket-hint">Close this panel and click <strong>Bracket</strong> on the tournament row to play matches.</p>
          {/if}

          {#if generateError}
            <p class="ks-error">{generateError}</p>
          {/if}
          {#if generateResult}
            <div class="generate-result">
              <strong>Bracket generated:</strong>
              Rounds: {generateResult.roundsCreated.join(' → ')}.
              {generateResult.matchesCreated} matches created.
              {#if generateResult.errors.length > 0}
                <ul class="result-errors">
                  {#each generateResult.errors as e}<li>{e}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}

          <div class="ks-actions">
            {#if generating}
              <button type="button" class="btn btn-primary" disabled>Generating…</button>
            {:else if bracketLocked}
              <button
                type="button"
                class="btn btn-secondary"
                onclick={() => { bracketLocked = false; generateResult = null; doRandomDraw(); }}
              >↺ Re-draw bracket</button>
            {:else}
              <button type="button" class="btn btn-secondary" onclick={doRandomDraw}>
                ↺ Random draw
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onclick={() => doGenerateBracket()}
                disabled={selectedIds.size < 2}
              >Generate bracket →</button>
            {/if}
          </div>

        {:else}
          <!-- Round Robin -->
          {#if !rrScheduleLocked}
            <!-- Picker — only before schedule is generated -->
            <div class="draw-panes">
              <!-- Left: tournament pool -->
              <div class="picker-pane">
                <div class="picker-header">
                  <span class="picker-title">Tournament players ({poolIds.length})</span>
                  <button type="button" class="btn-link" onclick={addAllToBracket} title="Add all">Add all →</button>
                </div>
                <input
                  class="picker-search"
                  type="search"
                  placeholder="Search…"
                  bind:value={poolSearch}
                  aria-label="Search tournament players"
                />
                <div class="picker-list">
                  {#if availablePlayerIds.length === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">No players assigned. Use the <strong>Players</strong> button on the tournament row to assign players first.</p>
                  {:else if poolIds.length === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">All players are in the round robin.</p>
                  {:else}
                    {#each filteredPool as pid (pid)}
                      <button type="button" class="pool-row" onclick={() => addToBracket(pid)}>
                        <span class="pool-name">{playerName(pid)}</span>
                        <span class="pool-add" aria-hidden="true">→</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>

              <!-- Right: round robin participants -->
              <div class="seed-pane">
                <div class="picker-header">
                  <span class="picker-title">Round Robin ({selectedIds.size})</span>
                  <div style="display:flex;align-items:center;gap:0.5rem;">
                    <span class="draw-hint">
                      {#if selectedIds.size >= 2}
                        {(selectedIds.size * (selectedIds.size - 1)) / 2} matches
                      {/if}
                    </span>
                    {#if selectedIds.size > 0}
                      <button type="button" class="btn-link" onclick={clearBracket}>Clear</button>
                    {/if}
                  </div>
                </div>
                <input
                  class="picker-search"
                  type="search"
                  placeholder="Search…"
                  bind:value={bracketSearch}
                  aria-label="Search round robin players"
                />
                <div class="picker-list">
                  {#if selectedIds.size === 0}
                    <p class="ks-info" style="padding:0.5rem 0.6rem">Click players on the left to add them to the round robin.</p>
                  {:else}
                    {#each filteredBracket as pid (pid)}
                      <button type="button" class="seed-row-btn" onclick={() => removeFromBracket(pid)}>
                        <span class="pool-remove" aria-hidden="true">←</span>
                        <span class="pool-name">{playerName(pid)}</span>
                      </button>
                    {/each}
                  {/if}
                </div>
              </div>
            </div>
          {:else}
            <!-- Schedule locked — show progress -->
            <div class="locked-hint">🔒 Schedule locked — {seedList.length} players</div>
            <div class="rr-progress">
              <span class="rr-progress-label">
                Progress: <strong>{rrCompleted} / {rrTotal}</strong> matches complete
              </span>
              {#if rrAllDone}
                <span class="rr-done-badge">All done — go to Knockout Matches</span>
              {/if}
            </div>
            <p class="bracket-hint">Close this panel and click <strong>Bracket</strong> on the tournament row to play matches.</p>
          {/if}

          {#if rrGenResult}
            <div class="generate-result">
              <strong>Schedule generated:</strong>
              {rrGenResult.matchesCreated} matches created.
              {#if rrGenResult.errors.length > 0}
                <ul class="result-errors">
                  {#each rrGenResult.errors as e}<li>{e}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}

          <div class="ks-actions">
            {#if rrGenerating}
              <button type="button" class="btn btn-primary" disabled>Generating…</button>
            {:else if rrScheduleLocked}
              <button
                type="button"
                class="btn btn-secondary"
                onclick={() => { activeTab = 'bracket'; }}
              >View standings →</button>
            {:else}
              <button
                type="button"
                class="btn btn-primary"
                onclick={doGenerateRRSchedule}
                disabled={selectedIds.size < 2 && availablePlayerIds.length < 2}
              >Generate schedule →</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- ─── RR Stage 2: standings → knockout ─────────────────────────────────── -->
    {#if isRR && activeTab === 'bracket'}
      <div class="ks-body">
        {#if !rrScheduleLocked}
          <p class="ks-info">Complete Stage 1 first — generate the round-robin schedule to enable standings.</p>
        {:else}
          <div class="stage2-header">
            <span class="stage2-progress">
              Round Robin: <strong>{rrCompleted} / {rrTotal}</strong> matches complete
            </span>
            {#if !rrAllDone}
              <label class="force-toggle">
                <input type="checkbox" bind:checked={advanceForceGenerate} />
                Force generate (incomplete results)
              </label>
            {/if}
          </div>

          {#if rrStandings && rrStandings.players.length > 0}
            <div class="standings-block">
              <table class="standings-tbl">
                <thead>
                  <tr>
                    <th>#</th>
                    <th class="col-name">Player</th>
                    <th title="Win=2 Draw=1 Loss=0">Pts</th>
                    <th title="Boards won">Boards</th>
                    <th title="Net score margin">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rrStandings.players as p, i (p.playerId)}
                    <tr class:advance-row={i < advanceCount}>
                      <td>{p.rank}</td>
                      <td class="col-name">{p.name}</td>
                      <td>{p.strikePoints}</td>
                      <td>{p.boardsWon}</td>
                      <td class:net-neg={p.netPoints < 0}>{p.netPoints}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>

            <div class="advance-controls">
              <label class="advance-label">
                Advance top
                <select class="advance-select" bind:value={advanceCount}>
                  {#each [2, 4, 8, 16] as n}
                    {#if n <= availablePlayerIds.length}
                      <option value={n}>{n} players</option>
                    {/if}
                  {/each}
                </select>
                to knockout
              </label>
            </div>
          {:else}
            <p class="ks-info">Standings will appear automatically once round-robin matches have results.</p>
          {/if}

          {#if advanceGenResult}
            <div class="generate-result">
              <strong>Knockout bracket created:</strong>
              {advanceGenResult.roundsCreated.join(' → ')}.
              {#if advanceGenResult.errors.length > 0}
                <ul class="result-errors">
                  {#each advanceGenResult.errors as e}<li>{e}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}

          {#if bracketLocked && bracketRounds.length > 0}
            <div class="bracket-summary">
              {#each bracketRounds as rName}
                {@const rMatches = bracketMatches.filter((m) => m.round === rName)}
                <div class="bracket-round-block">
                  <div class="bracket-round-label">{rName}</div>
                  {#each rMatches as m (m.mid)}
                    <div class="bracket-match-row" class:completed={!!m.completedAt}>
                      <span class="bm-order">{m.matchOrder}</span>
                      <span class="bm-player" class:winner={m.result?.winner === 'a'}>{m.aName}</span>
                      <span class="bm-vs">vs</span>
                      <span class="bm-player" class:winner={m.result?.winner === 'b'}>{m.bName}</span>
                      {#if m.result}
                        <span class="bm-result">{m.result.setsA}–{m.result.setsB}</span>
                      {/if}
                    </div>
                  {/each}
                </div>
              {/each}
            </div>
            <p class="bracket-hint">Close this panel and click <strong>Bracket</strong> to play knockout matches.</p>
          {/if}

          <div class="ks-actions">
            {#if advanceGenerating}
              <button type="button" class="btn btn-primary" disabled>Generating…</button>
            {:else if !bracketLocked}
              <button
                type="button"
                class="btn btn-primary"
                onclick={doAdvanceToKnockout}
                disabled={!rrStandings || (!rrAllDone && !advanceForceGenerate)}
              >Generate knockout (top {advanceCount}) →</button>
            {:else}
              <button type="button" class="btn btn-secondary" disabled>Bracket generated</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .ks-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 2rem 1rem;
    overflow-y: auto;
  }
  .ks-card {
    background: var(--surface, #1e1e1e);
    border-radius: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    width: 100%;
    max-width: 820px;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    overflow: hidden;
  }
  .ks-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }
  .ks-title {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }
  .ks-close {
    background: none;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
  }
  .ks-close:hover { color: var(--fg, #f5f5f5); }

  .ks-tabs {
    display: flex;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    padding: 0 1rem;
  }
  .ks-tab {
    background: none;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    font-weight: 600;
    padding: 0.6rem 1rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
  }
  .ks-tab:hover { color: var(--fg, #f5f5f5); }
  .ks-tab-active {
    color: var(--accent, #ffd54a);
    border-bottom-color: var(--accent, #ffd54a);
  }

  .ks-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    flex: 1;
  }

  .draw-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .draw-hint {
    font-size: 0.8rem;
    color: var(--muted, #9aa0a6);
  }
  .locked-hint {
    font-size: 0.78rem;
    color: rgba(255, 213, 74, 0.7);
    font-style: italic;
    margin-bottom: 0.75rem;
  }
  .draw-locked-hint {
    font-size: 0.78rem;
    color: rgba(255, 213, 74, 0.7);
    font-style: italic;
  }

  /* League-style group boxes (reused for bracket rounds when locked) */
  .groups-grid {
    display: grid;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  @media (max-width: 40rem) {
    .groups-grid { grid-template-columns: 1fr 1fr !important; }
  }
  @media (max-width: 28rem) {
    .groups-grid { grid-template-columns: 1fr !important; }
  }
  .group-col {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    padding: 0.5rem;
    background: rgba(255, 255, 255, 0.02);
  }
  .group-col-done {
    border-color: rgba(86, 203, 130, 0.3);
    background: rgba(86, 203, 130, 0.04);
  }
  .group-col-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent, #ffd54a);
    margin-bottom: 0.4rem;
    padding-bottom: 0.3rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .group-col-header-right {
    display: flex;
    align-items: center;
  }
  .group-match-status {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--muted, #9aa0a6);
    text-transform: none;
    letter-spacing: 0;
  }
  .group-match-done { color: #56cb82; }

  /* Match chip inside a locked group col */
  .bracket-match-chip {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.3rem;
    padding: 0.22rem 0.45rem;
    font-size: 0.78rem;
    margin-bottom: 0.25rem;
  }
  .bracket-match-chip.completed { opacity: 0.7; }

  /* Two-pane draw layout */
  .draw-panes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  @media (max-width: 36rem) {
    .draw-panes { grid-template-columns: 1fr; }
  }

  .picker-pane,
  .seed-pane {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .picker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
    background: rgba(255, 255, 255, 0.04);
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .picker-title {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent, #ffd54a);
  }
  .picker-bulk {
    display: flex;
    gap: 0.4rem;
  }
  .btn-link {
    background: none;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
    text-decoration: underline;
  }
  .btn-link:hover { color: var(--fg, #f5f5f5); }

  .picker-search {
    margin: 0.35rem 0.5rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.3rem;
    color: var(--fg, #f0f0f0);
    flex-shrink: 0;
  }
  .picker-search:focus { outline: 1px solid var(--accent, #ffd54f); }

  .picker-list {
    overflow-y: auto;
    max-height: 22rem;
    flex: 1;
  }
  /* Pool row (left pane) — click to add to bracket */
  .pool-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.28rem 0.6rem;
    font-size: 0.82rem;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--fg, #f0f0f0);
    width: 100%;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .pool-row:hover { background: rgba(255, 255, 255, 0.06); }
  .pool-name {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pool-add {
    color: var(--accent, #ffd54a);
    font-size: 0.9rem;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .pool-row:hover .pool-add { opacity: 1; }

  /* Bracket row (right pane) — click to remove */
  .seed-row-btn {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.28rem 0.6rem;
    font-size: 0.82rem;
    cursor: pointer;
    border: none;
    background: rgba(255, 213, 74, 0.05);
    color: var(--fg, #f0f0f0);
    width: 100%;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .seed-row-btn:hover { background: rgba(220, 60, 60, 0.12); }
  .pool-remove {
    color: var(--muted, #9aa0a6);
    font-size: 0.9rem;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }
  .seed-row-btn:hover .pool-remove { opacity: 1; color: #e05252; }

  /* Bracket summary */
  .bracket-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0.75rem 0;
  }
  .bracket-round-block {
    min-width: 10rem;
    flex: 1;
  }
  .bracket-round-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent, #ffd54a);
    margin-bottom: 0.35rem;
    padding-bottom: 0.25rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  }
  .bracket-match-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0;
    font-size: 0.78rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  }
  .bracket-match-row.completed { opacity: 0.7; }
  .bm-order {
    font-size: 0.68rem;
    color: var(--muted, #9aa0a6);
    width: 1rem;
    text-align: right;
    flex-shrink: 0;
  }
  .bm-player {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-style: italic;
    color: rgba(255, 255, 255, 0.5);
  }
  .bm-player.winner { font-weight: 700; font-style: normal; color: var(--fg, #f5f5f5); }
  .bm-vs { font-size: 0.68rem; color: var(--muted, #9aa0a6); flex-shrink: 0; }
  .bm-result { font-size: 0.72rem; color: var(--muted, #9aa0a6); flex-shrink: 0; }

  /* RR progress */
  .rr-progress {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin: 0.75rem 0;
    flex-wrap: wrap;
  }
  .rr-progress-label { font-size: 0.85rem; color: var(--muted, #9aa0a6); }
  .rr-done-badge {
    font-size: 0.78rem;
    background: rgba(86, 203, 130, 0.15);
    color: #56cb82;
    border: 1px solid rgba(86, 203, 130, 0.3);
    border-radius: 0.3rem;
    padding: 0.15rem 0.5rem;
  }

  /* Stage 2 */
  .stage2-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .stage2-progress { font-size: 0.85rem; color: var(--muted, #9aa0a6); }
  .force-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #e5a623;
    cursor: pointer;
  }

  /* Standings */
  .standings-block {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .standings-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .standings-tbl th,
  .standings-tbl td {
    padding: 0.3rem 0.5rem;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .standings-tbl th {
    background: rgba(255, 255, 255, 0.05);
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #9aa0a6);
  }
  .standings-tbl .col-name { text-align: left; }
  .standings-tbl tr:last-child td { border-bottom: 0; }
  .standings-tbl .advance-row td { background: rgba(255, 213, 74, 0.05); }
  .net-neg { color: #e05c5c; }

  .advance-controls {
    margin-bottom: 1rem;
  }
  .advance-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--muted, #9aa0a6);
  }
  .advance-select {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.3rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
    padding: 0.2rem 0.4rem;
  }

  /* Actions */
  .ks-actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .ks-error {
    color: #e05c5c;
    font-size: 0.85rem;
    margin: 0.5rem 0;
  }
  .ks-info {
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    margin: 0.5rem 0;
  }
  .generate-result {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.4rem;
    padding: 0.6rem 0.85rem;
    font-size: 0.85rem;
    margin: 0.75rem 0;
  }
  .result-errors {
    color: #e05c5c;
    font-size: 0.8rem;
    padding-left: 1.2rem;
    margin: 0.4rem 0 0;
  }
  .bracket-hint {
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
    margin: 0.5rem 0 0;
  }

  /* Buttons */
  .btn {
    padding: 0.45rem 0.9rem;
    border-radius: 0.4rem;
    border: 1px solid rgba(255, 255, 255, 0.15);
    background: rgba(255, 255, 255, 0.07);
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.12); }
  .btn-primary {
    background: var(--accent, #ffd54a);
    color: #111;
    border-color: var(--accent, #ffd54a);
  }
  .btn-primary:hover:not(:disabled) { background: #ffe07a; }
  .btn-secondary { background: rgba(255, 255, 255, 0.07); }

  /* Light theme */
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) .ks-card {
      background: #fff;
      border-color: rgba(0, 0, 0, 0.1);
    }
    :root:not([data-theme="dark"]) .seed-row {
      background: rgba(0, 0, 0, 0.03);
      border-color: rgba(0, 0, 0, 0.08);
    }
    :root:not([data-theme="dark"]) .btn { background: rgba(0, 0, 0, 0.06); color: #111; }
    :root:not([data-theme="dark"]) .btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
    :root:not([data-theme="dark"]) .advance-select { background: rgba(0,0,0,0.04); color: #111; }
  }
  :root[data-theme="light"] .ks-card { background: #fff; border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .seed-row { background: rgba(0, 0, 0, 0.03); border-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .btn { background: rgba(0, 0, 0, 0.06); color: #111; }
  :root[data-theme="light"] .advance-select { background: rgba(0,0,0,0.04); color: #111; }
</style>
