<script lang="ts">
  /**
   * League Setup admin screen (v4.0).
   *
   * Stage 1 tab: player draw → group assignment → schedule generation.
   * Stage 2 tab: group standings → flight generation (knockout sub-tournaments).
   *
   * Props: same contract as TournamentBracket.svelte.
   */
  import { onMount } from 'svelte';
  import type { Tournament } from '../../lib/tournaments';
  import {
    updateLeagueGroups,
    startRound,
    loadAssignedPlayers,
    type LeagueGroup,
  } from '../../lib/tournaments';
  import { loadAll as loadAllPlayers, subscribeStore as subscribePlayerStore } from '../../lib/players';
  import { subscribePlannedByTournament, deletePlannedMatch, type PlannedMatch } from '../../lib/planned';
  import { loadMatchesByTournamentKey, type MatchRecord } from '../../lib/history';
  import {
    potSeeding,
    shuffleArray,
    computeGroupStandings,
    redistributeToFlights,
    generateLeagueSchedule,
    generateFlightTournaments,
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

  // ─── Tab ────────────────────────────────────────────────────────────────────
  let activeTab = $state<'draw' | 'flights'>('draw');

  // ─── Players ────────────────────────────────────────────────────────────────
  let players = $state(loadAllPlayers());
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsubPlayers: (() => void) | null = null;
  let unsubPlanned: (() => void) | null = null;

  // ─── Group draw state ────────────────────────────────────────────────────────
  const leagueCfg = $derived(tournament.leagueCfg);
  const groupCount = $derived(leagueCfg?.groupCount ?? 8);
  const playersPerGroup = $derived(leagueCfg?.playersPerGroup ?? 6);

  // Local editable group assignments (not yet saved to Firebase)
  let localGroups = $state<Record<string, LeagueGroup>>(
    tournament.groups ? JSON.parse(JSON.stringify(tournament.groups)) : {}
  );

  // Loaded async from Firebase — falls back to all players for open tournaments
  let assignedPlayerIds = $state<string[]>([]);

  // Players not yet in any group
  const assignedToGroup = $derived(
    new Set(Object.values(localGroups).flatMap((g) => g.playerIds))
  );
  const unassignedPlayers = $derived(
    assignedPlayerIds.filter((id) => !assignedToGroup.has(id))
  );

  // Sorted groups for display
  const sortedGroups = $derived(
    Object.entries(localGroups).sort(([, a], [, b]) => a.order - b.order)
  );

  // ─── Drag state ──────────────────────────────────────────────────────────────
  let dragSrc = $state<{ fromGroup: string | '__unassigned__'; playerIdx: number } | null>(null);

  function onDragStart(fromGroup: string | '__unassigned__', playerIdx: number) {
    dragSrc = { fromGroup, playerIdx };
  }

  function onDrop(toGroup: string | '__unassigned__') {
    if (!dragSrc) return;
    const { fromGroup, playerIdx } = dragSrc;
    if (fromGroup === toGroup) { dragSrc = null; return; }

    const srcIds = fromGroup === '__unassigned__'
      ? [...unassignedPlayers]
      : [...(localGroups[fromGroup]?.playerIds ?? [])];
    const pid = srcIds[playerIdx];
    if (!pid) { dragSrc = null; return; }

    // Remove from source
    if (fromGroup !== '__unassigned__' && localGroups[fromGroup]) {
      localGroups[fromGroup] = {
        ...localGroups[fromGroup]!,
        playerIds: localGroups[fromGroup]!.playerIds.filter((id) => id !== pid),
      };
    }
    // Add to destination
    if (toGroup !== '__unassigned__' && localGroups[toGroup]) {
      localGroups[toGroup] = {
        ...localGroups[toGroup]!,
        playerIds: [...localGroups[toGroup]!.playerIds, pid],
      };
    }
    dragSrc = null;
    groupsDirty = true;
  }

  // ─── Random draw ─────────────────────────────────────────────────────────────

  function doRandomDraw() {
    const gc = groupCount;
    const playerName = (id: string) => players.find((p) => p.id === id)?.canonicalName ?? id;
    const playerNames = new Map(assignedPlayerIds.map((id) => [id, playerName(id)]));
    const potScores = new Map<string, number>();
    localGroups = potSeeding(assignedPlayerIds, playerNames, potScores, gc);
    groupsDirty = false;
  }

  async function doRedraw() {
    doRandomDraw();
    generateResult = null;
    groupsLocked = false;
    await lockAndGenerate();
    await startAllGroupRounds();
  }

  // ─── Schedule generation ─────────────────────────────────────────────────────

  let generating = $state(false);
  let generateError = $state('');
  let generateResult = $state<{ groupsCreated: number; matchesCreated: number; errors: string[] } | null>(null);
  let groupsLocked = $state(Object.keys(tournament.groups ?? {}).length > 0);
  // True once user has dragged a player — shows the manual lock button
  let groupsDirty = $state(false);

  // True once any group round has been started — locks drag-and-drop
  const roundsStarted = $derived(
    (tournament.rounds ?? []).some((r) => /^group /i.test(r.name) && r.startedAt)
  );

  async function lockAndGenerate() {
    if (generating) return;
    // Validate
    for (const [, g] of sortedGroups) {
      if (g.playerIds.length < 2) {
        generateError = `Group ${g.name} needs at least 2 players`;
        return;
      }
    }
    generating = true;
    generateError = '';
    generateResult = null;

    // Delete ALL existing planned matches for this tournament's group rounds before
    // re-generating — including completed ones — so re-draws don't accumulate stale matches.
    const existingGroupMatches = plannedMatches.filter((m) => /^group /i.test(m.round));
    await Promise.all(existingGroupMatches.map((m) => deletePlannedMatch(m.mid)));

    const saveOutcome = await updateLeagueGroups(tournament.key, localGroups);
    if (!saveOutcome.ok) {
      generating = false;
      generateError = saveOutcome.error;
      return;
    }
    groupsLocked = true;

    const playerName = (id: string) => players.find((p) => p.id === id)?.canonicalName ?? id;
    const playerNames = new Map(assignedPlayerIds.map((id) => [id, playerName(id)]));

    const cfg = leagueCfg ?? { groupCount: groupCount, playersPerGroup: playersPerGroup, boardsPerGroup: 2, flightNames: ['Flight A', 'Flight B', 'Flight C'] };

    const result = await generateLeagueSchedule({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups: localGroups,
      leagueCfg: cfg,
      playerNames,
      playerResolvedIds: new Map(assignedPlayerIds.map((id) => [id, id])),
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
      },
      myUid,
    });
    generateResult = result;
    groupsDirty = false;
    generating = false;
  }

  // ─── Start all group rounds ───────────────────────────────────────────────────

  let startingRounds = $state(false);

  async function startAllGroupRounds() {
    startingRounds = true;
    const rounds = tournament.rounds ?? [];
    const groupRounds = rounds.filter((r) => r.name.startsWith('Group ') && !r.startedAt);
    for (const r of groupRounds) {
      await startRound(tournament.key, r.key);
    }
    startingRounds = false;
  }

  // ─── Stage 2: standings & flight generation ───────────────────────────────────

  let flightGenRunning = $state(false);
  let flightGenResult = $state<{ flightsCreated: string[]; errors: string[] } | null>(null);
  let forceGenerate = $state(false);
  let archivedMatches = $state<MatchRecord[]>([]);

  type FlightCfgEdit = { bestOf: string; pointsTarget: string; maxBoards: string; timerDuration: string };
  const defaultFlightCfgEdit = (): FlightCfgEdit => ({ bestOf: '', pointsTarget: '', maxBoards: '', timerDuration: '' });
  let flightCfgEdits = $state<Record<string, FlightCfgEdit>>({});

  // Recomputes automatically whenever plannedMatches or groups change
  const standings = $derived.by<GroupStandings[]>(() => {
    if (sortedGroups.length === 0) return [];
    const summaries = buildStandingsFromPlanned();
    return sortedGroups.map(([, g]) => computeGroupStandings(g, summaries));
  });

  const matchesPerGroup = $derived(
    playersPerGroup >= 2 ? (playersPerGroup * (playersPerGroup - 1)) / 2 : 0
  );

  const groupMatchCounts = $derived(() => {
    const counts = new Map<string, { total: number; completed: number }>();
    for (const [gKey, g] of sortedGroups) {
      const roundName = `Group ${g.name}`;
      const forGroup = plannedMatches.filter((m) => m.round === roundName);
      counts.set(gKey, {
        total: forGroup.length,
        completed: forGroup.filter((m) => m.completedAt !== undefined).length,
      });
    }
    return counts;
  });

  const totalGroupMatches = $derived(
    sortedGroups.reduce((sum, [gKey]) => sum + (groupMatchCounts().get(gKey)?.total ?? 0), 0)
  );
  const completedGroupMatches = $derived(
    sortedGroups.reduce((sum, [gKey]) => sum + (groupMatchCounts().get(gKey)?.completed ?? 0), 0)
  );
  const allGroupsDone = $derived(
    totalGroupMatches > 0 && completedGroupMatches === totalGroupMatches
  );

  function buildStandingsFromPlanned(): PlayerSummary[] {
    const map = new Map<string, PlayerSummary>();
    const ensurePlayer = (id: string, name: string) => {
      if (!map.has(id)) {
        map.set(id, {
          playerId: id,
          name,
          matches: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          boardsWon: 0,
          pointsScored: 0,
          strikePoints: 0,
          netPoints: 0,
        });
      }
      return map.get(id)!;
    };

    for (const m of plannedMatches) {
      if (!m.completedAt || !m.result) continue;
      const aId = m.aResolvedId;
      const bId = m.bResolvedId;
      if (!aId || !bId) continue;
      const a = ensurePlayer(aId, m.aName);
      const b = ensurePlayer(bId, m.bName);
      const { setsA, setsB, winner } = m.result;
      a.matches++;
      b.matches++;
      if (winner === 'a') {
        a.wins++; a.strikePoints += 2;
        b.losses++;
      } else if (winner === 'b') {
        b.wins++; b.strikePoints += 2;
        a.losses++;
      } else {
        a.draws++; a.strikePoints += 1;
        b.draws++; b.strikePoints += 1;
      }
      a.boardsWon += setsA;
      b.boardsWon += setsB;
      a.netPoints += setsA - setsB;
      b.netPoints += setsB - setsA;
    }

    // Also process archived matches (completed matches moved from /planned to /matches)
    const seenMids = new Set(plannedMatches.map((m) => m.mid));
    for (const m of archivedMatches) {
      if (!m.round || !/^Group /i.test(m.round)) continue;
      if (!m.result || !m.playerAId || !m.playerBId) continue;
      if (seenMids.has(m.id)) continue;
      const a = ensurePlayer(m.playerAId, m.aName ?? m.playerAId);
      const b = ensurePlayer(m.playerBId, m.bName ?? m.playerBId);
      const { setsA, setsB, winner } = m.result;
      a.matches++;
      b.matches++;
      if (winner === 'a') {
        a.wins++; a.strikePoints += 2;
        b.losses++;
      } else if (winner === 'b') {
        b.wins++; b.strikePoints += 2;
        a.losses++;
      } else {
        a.draws++; a.strikePoints += 1;
        b.draws++; b.strikePoints += 1;
      }
      a.boardsWon += setsA;
      b.boardsWon += setsB;
      a.netPoints += setsA - setsB;
      b.netPoints += setsB - setsA;
    }

    return [...map.values()].filter((s) => s.playerId !== PHANTOM_ID);
  }

  async function generateFlights() {
    if (flightGenRunning) return;
    flightGenRunning = true;
    flightGenResult = null;

    const cfg = leagueCfg ?? { groupCount: groupCount, playersPerGroup: playersPerGroup, boardsPerGroup: 2, flightNames: ['Flight A', 'Flight B', 'Flight C'] };
    const standingsMap = new Map(standings.map((s) => [s.groupName, s]));
    const flightSeeds = redistributeToFlights(
      sortedGroups.map(([, g]) => g),
      standingsMap,
      cfg.flightNames,
    );

    const playerName = (id: string) => players.find((p) => p.id === id)?.canonicalName ?? id;
    const playerNames = new Map(
      [...flightSeeds.values()].flat().map((id) => [id, playerName(id)])
    );

    // Build per-flight cfg from UI edits
    const flightCfg: Record<string, { bestOf?: number; pointsTarget?: number; maxBoards?: number; timerDuration?: number }> = {};
    for (const [fname, edit] of Object.entries(flightCfgEdits)) {
      const entry: { bestOf?: number; pointsTarget?: number; maxBoards?: number; timerDuration?: number } = {};
      const bo = Number(edit.bestOf); if (bo >= 1) entry.bestOf = Math.floor(bo);
      const pt = Number(edit.pointsTarget); if (pt >= 1) entry.pointsTarget = Math.floor(pt);
      const mb = Number(edit.maxBoards); if (mb >= 1) entry.maxBoards = Math.floor(mb);
      const td = Number(edit.timerDuration); if (td >= 1) entry.timerDuration = Math.floor(td);
      if (Object.keys(entry).length > 0) flightCfg[fname] = entry;
    }

    // Delete any existing planned matches for these flights before re-seeding
    const flightNameSet = new Set(cfg.flightNames);
    const existingFlightMatches = plannedMatches.filter((m) => {
      const dashIdx = m.round?.indexOf(' — ');
      return dashIdx !== undefined && dashIdx > 0 && flightNameSet.has(m.round!.slice(0, dashIdx));
    });
    await Promise.all(existingFlightMatches.map((m) => deletePlannedMatch(m.mid)));

    const result = await generateFlightTournaments({
      parentTournamentKey: tournament.key,
      parentTournamentName: tournament.name,
      flightSeeds,
      playerNames,
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
        timerDuration: tournament.defaults?.timerDuration,
      },
      flightCfg: Object.keys(flightCfg).length > 0 ? flightCfg : undefined,
      myUid,
    });
    flightGenResult = result;
    flightGenRunning = false;
  }

  // ─── Player name helper ───────────────────────────────────────────────────────
  function playerName(id: string): string {
    return players.find((p) => p.id === id)?.canonicalName ?? id;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    unsubPlayers = subscribePlayerStore(() => { players = loadAllPlayers(); });
    (async () => {
      // Load assigned players first — open tournaments fall back to all players
      const assigned = await loadAssignedPlayers(tournament.key);
      assignedPlayerIds = assigned.size > 0
        ? [...assigned]
        : players.map((p) => p.id);

      unsubPlanned = await subscribePlannedByTournament(tournament.key, (arr) => {
        plannedMatches = arr;
      });
      archivedMatches = await loadMatchesByTournamentKey(tournament.key);
      // Auto-draw and generate if players are assigned but no groups exist yet
      if (assignedPlayerIds.length > 0 && Object.keys(localGroups).length === 0) {
        doRandomDraw();
        await lockAndGenerate();
        await startAllGroupRounds();
      }
    })();
    return () => {
      unsubPlayers?.();
      unsubPlanned?.();
    };
  });

  // ─── Per-group match counts display ──────────────────────────────────────────
  function groupMatchStatus(gKey: string, gName: string) {
    const counts = groupMatchCounts().get(gKey);
    if (!counts || counts.total === 0) {
      const expectedMatches = matchesPerGroup;
      return { label: `0 / ${expectedMatches} scheduled`, done: false };
    }
    return {
      label: `${counts.completed} / ${counts.total} complete`,
      done: counts.completed === counts.total,
    };
  }
</script>

<div class="league-setup-overlay" role="dialog" aria-modal="true" aria-label="League Setup">
  <div class="league-setup-card">
    <div class="ls-header">
      <h2 class="ls-title">League Setup — {tournament.name}</h2>
      <button type="button" class="ls-close" onclick={onClose} aria-label="Close">✕</button>
    </div>

    <!-- Tab bar -->
    <div class="ls-tabs" role="tablist">
      <button
        type="button"
        class="ls-tab"
        class:ls-tab-active={activeTab === 'draw'}
        role="tab"
        aria-selected={activeTab === 'draw'}
        onclick={() => { activeTab = 'draw'; }}
      >Groups &amp; Draw</button>
      <button
        type="button"
        class="ls-tab"
        class:ls-tab-active={activeTab === 'flights'}
        role="tab"
        aria-selected={activeTab === 'flights'}
        onclick={() => { activeTab = 'flights'; }}
      >League Matches</button>
    </div>

    <!-- ─── Groups & Draw ───────────────────────────────────────────────────── -->
    {#if activeTab === 'draw'}
      <div class="ls-body">
        <div class="draw-controls">
          <span class="draw-hint">
            {assignedPlayerIds.length} players → {groupCount} groups of ~{playersPerGroup}
          </span>
          {#if roundsStarted}
            <span class="draw-locked-hint">🔒 Groups locked — rounds in progress</span>
          {:else if groupsLocked && !groupsDirty}
            <span class="draw-auto-hint">Drag players to adjust, then re-generate</span>
          {/if}
          {#if unassignedPlayers.length > 0}
            <span class="draw-warn">⚠ {unassignedPlayers.length} player{unassignedPlayers.length !== 1 ? 's' : ''} unassigned</span>
          {/if}
        </div>

        <!-- Unassigned pool -->
        {#if unassignedPlayers.length > 0}
          <div
            class="group-col unassigned-col"
            role="list"
            aria-label="Unassigned players"
            ondragover={roundsStarted ? undefined : (e) => e.preventDefault()}
            ondrop={roundsStarted ? undefined : () => onDrop('__unassigned__')}
          >
            <div class="group-col-header">Unassigned</div>
            {#each unassignedPlayers as pid, i (pid)}
              <div
                class="player-chip"
                class:player-chip-locked={roundsStarted}
                draggable={!roundsStarted}
                role="listitem"
                ondragstart={roundsStarted ? undefined : () => onDragStart('__unassigned__', i)}
              >{playerName(pid)}</div>
            {/each}
          </div>
        {/if}

        <!-- Group grid -->
        <div class="groups-grid" style="grid-template-columns: repeat({Math.min(groupCount, 4)}, 1fr)">
          {#each sortedGroups as [gKey, group] (gKey)}
            {@const status = groupMatchStatus(gKey, group.name)}
            <div
              class="group-col"
              class:group-col-locked={roundsStarted}
              class:group-col-done={roundsStarted && status.done}
              role="list"
              aria-label="Group {group.name}"
              ondragover={roundsStarted ? undefined : (e) => e.preventDefault()}
              ondrop={roundsStarted ? undefined : () => onDrop(gKey)}
            >
              <div class="group-col-header">
                <span>{group.name}</span>
                <div class="group-col-header-right">
                  {#if roundsStarted}
                    <span class="group-match-status" class:group-match-done={status.done}>{status.label}</span>
                  {:else}
                    <span class="group-count">{group.playerIds.length}</span>
                  {/if}
                </div>
              </div>
              {#each group.playerIds as pid, i (pid)}
                <div
                  class="player-chip"
                  class:player-chip-locked={roundsStarted}
                  draggable={!roundsStarted}
                  role="listitem"
                  ondragstart={roundsStarted ? undefined : () => onDragStart(gKey, i)}
                >{playerName(pid)}</div>
              {/each}
              {#if group.playerIds.length === 0}
                <div class="group-empty">Drop players here</div>
              {/if}
            </div>
          {/each}
        </div>

        {#if generateError}
          <p class="ls-error">{generateError}</p>
        {/if}

        {#if generateResult}
          <div class="generate-result">
            <strong>Schedule generated:</strong>
            {generateResult.groupsCreated} groups, {generateResult.matchesCreated} matches.
            {#if generateResult.errors.length > 0}
              <ul class="result-errors">
                {#each generateResult.errors as e}<li>{e}</li>{/each}
              </ul>
            {/if}
          </div>
        {/if}

        {#if groupsLocked || roundsStarted}
          <p class="bracket-hint">Close this panel and click <strong>Bracket</strong> on the tournament row to manage individual matches.</p>
        {/if}

        <div class="ls-actions">
          {#if roundsStarted}
            <!-- no actions — groups are locked, rounds in progress -->
          {:else if generating}
            <button type="button" class="btn btn-primary" disabled>Generating…</button>
          {:else if groupsDirty}
            <button
              type="button"
              class="btn btn-primary"
              onclick={lockAndGenerate}
              disabled={sortedGroups.length === 0}
            >Lock groups & generate schedule</button>
          {:else if groupsLocked}
            {#if (tournament.rounds ?? []).some((r) => /^group /i.test(r.name) && !r.startedAt)}
              <button
                type="button"
                class="btn btn-primary"
                onclick={startAllGroupRounds}
                disabled={startingRounds}
              >{startingRounds ? 'Starting…' : '▶ Start all group rounds'}</button>
            {/if}
            <button
              type="button"
              class="btn btn-secondary"
              onclick={doRedraw}
            >↺ Re-draw groups</button>
          {:else if !groupsLocked && sortedGroups.length > 0}
            <button
              type="button"
              class="btn btn-primary"
              onclick={lockAndGenerate}
            >Generate schedule</button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ─── League Flights ────────────────────────────────────────────────────── -->
    {#if activeTab === 'flights'}
      <div class="ls-body">
        {#if !groupsLocked}
          <p class="ls-info">Complete Stage 1 draw first — lock groups and generate the schedule to enable Stage 2.</p>
        {:else}
          <div class="stage2-header">
            <span class="stage2-progress">
              Group stage: <strong>{completedGroupMatches} / {totalGroupMatches}</strong> matches complete
            </span>
            {#if !allGroupsDone}
              <label class="force-toggle">
                <input type="checkbox" bind:checked={forceGenerate} />
                Force generate (incomplete results)
              </label>
            {/if}
          </div>

          <!-- Group standings tables -->
          {#if standings.length > 0}
            <div class="standings-grid" style="grid-template-columns: repeat({Math.min(standings.length, 4)}, 1fr)">
              {#each standings as gs (gs.groupKey)}
                <div class="standings-group">
                  <div class="standings-group-header">{gs.groupName}</div>
                  <table class="standings-tbl">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th class="col-name">Player</th>
                        <th title="Points: Win=2 Draw=1 Loss=0">Pts</th>
                        <th title="Net score margin">Net</th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each gs.players as p (p.playerId)}
                        <tr>
                          <td>{p.rank}</td>
                          <td class="col-name">{p.name}</td>
                          <td>{p.strikePoints}</td>
                          <td class:net-neg={p.netPoints < 0}>{p.netPoints}</td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/each}
            </div>
          {:else}
            <p class="ls-info">Standings will appear here automatically once group matches have results.</p>
          {/if}

          {#if leagueCfg && leagueCfg.flightNames.length > 0}
            <div class="flight-cfg-section">
              <p class="flight-cfg-title">Match format per flight <span class="flight-cfg-hint-txt">(leave blank to use tournament defaults)</span></p>
              {#each leagueCfg.flightNames as fname}
                {#if true}
                  {@const edit = flightCfgEdits[fname] ?? defaultFlightCfgEdit()}
                  <div class="flight-cfg-row">
                    <span class="flight-cfg-name">{fname}</span>
                    <label class="flight-cfg-field">
                      <span>Sets</span>
                      <input type="number" min="1" max="9" step="2" placeholder="{tournament.defaults?.bestOf ?? 3}"
                        value={edit.bestOf}
                        oninput={(e) => { flightCfgEdits = { ...flightCfgEdits, [fname]: { ...(flightCfgEdits[fname] ?? defaultFlightCfgEdit()), bestOf: (e.target as HTMLInputElement).value } }; }} />
                    </label>
                    <label class="flight-cfg-field">
                      <span>Points</span>
                      <input type="number" min="1" max="500" placeholder="{tournament.defaults?.pointsTarget ?? 25}"
                        value={edit.pointsTarget}
                        oninput={(e) => { flightCfgEdits = { ...flightCfgEdits, [fname]: { ...(flightCfgEdits[fname] ?? defaultFlightCfgEdit()), pointsTarget: (e.target as HTMLInputElement).value } }; }} />
                    </label>
                    <label class="flight-cfg-field">
                      <span>Boards</span>
                      <input type="number" min="1" max="50" placeholder="{tournament.defaults?.maxBoards ?? 8}"
                        value={edit.maxBoards}
                        oninput={(e) => { flightCfgEdits = { ...flightCfgEdits, [fname]: { ...(flightCfgEdits[fname] ?? defaultFlightCfgEdit()), maxBoards: (e.target as HTMLInputElement).value } }; }} />
                    </label>
                    <label class="flight-cfg-field">
                      <span>Time (min)</span>
                      <input type="number" min="1" max="300" placeholder="{tournament.defaults?.timerDuration ?? '—'}"
                        value={edit.timerDuration}
                        oninput={(e) => { flightCfgEdits = { ...flightCfgEdits, [fname]: { ...(flightCfgEdits[fname] ?? defaultFlightCfgEdit()), timerDuration: (e.target as HTMLInputElement).value } }; }} />
                    </label>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}

          <div class="stage2-controls">
            <button
              type="button"
              class="btn btn-primary"
              onclick={generateFlights}
              disabled={flightGenRunning || (!allGroupsDone && !forceGenerate)}
            >{flightGenRunning ? 'Generating league matches…' : 'Generate league matches →'}</button>
          </div>

          {#if flightGenResult}
            <div class="generate-result">
              {#if flightGenResult.flightsCreated.length > 0}
                <strong>Rounds added to this tournament:</strong>
                {flightGenResult.flightsCreated.join(', ')}.
                Open the Bracket view to see the seeded draw.
              {/if}
              {#if flightGenResult.errors.length > 0}
                <ul class="result-errors">
                  {#each flightGenResult.errors as e}<li>{e}</li>{/each}
                </ul>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .league-setup-overlay {
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
  .league-setup-card {
    background: var(--surface, #1e1e1e);
    border-radius: 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    width: 100%;
    max-width: 1100px;
    display: flex;
    flex-direction: column;
    max-height: 90vh;
    overflow: hidden;
  }
  .ls-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.25rem 0.75rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }
  .ls-title {
    font-size: 1rem;
    font-weight: 700;
    margin: 0;
  }
  .ls-close {
    background: none;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
  }
  .ls-close:hover { color: var(--fg, #f5f5f5); }

  /* Tabs */
  .ls-tabs {
    display: flex;
    gap: 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    padding: 0 1rem;
  }
  .ls-tab {
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
  .ls-tab:hover { color: var(--fg, #f5f5f5); }
  .ls-tab-active {
    color: var(--accent, #ffd54a);
    border-bottom-color: var(--accent, #ffd54a);
  }

  /* Body */
  .ls-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    flex: 1;
  }

  /* Draw controls */
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
  .draw-warn {
    font-size: 0.8rem;
    color: #e5a623;
    font-weight: 600;
  }
  .draw-auto-hint {
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
    font-style: italic;
  }
  .draw-locked-hint {
    font-size: 0.78rem;
    color: rgba(255, 213, 74, 0.7);
    font-style: italic;
  }

  /* Groups grid */
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
    min-height: 4rem;
    background: rgba(255, 255, 255, 0.02);
  }
  .group-col:focus-within,
  .group-col[aria-dropeffect] {
    border-color: rgba(255, 213, 74, 0.3);
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
    gap: 0.3rem;
  }
  .group-count {
    background: rgba(255, 255, 255, 0.08);
    border-radius: 0.8rem;
    padding: 0 0.4rem;
    font-size: 0.68rem;
    color: var(--muted, #9aa0a6);
  }
  .group-match-status {
    font-size: 0.65rem;
    font-weight: 600;
    color: var(--muted, #9aa0a6);
    text-transform: none;
    letter-spacing: 0;
  }
  .group-match-done {
    color: #56cb82;
  }
  .group-col-locked {
    cursor: default;
  }
  .group-col-done {
    border-color: rgba(86, 203, 130, 0.3);
    background: rgba(86, 203, 130, 0.04);
  }
  .unassigned-col {
    border-color: rgba(229, 166, 35, 0.25);
    margin-bottom: 0.75rem;
  }
  .unassigned-col .group-col-header { color: #e5a623; }

  .player-chip {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.3rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    cursor: grab;
    user-select: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .player-chip:active { cursor: grabbing; }
  .player-chip:hover { background: rgba(255, 255, 255, 0.1); }
  .player-chip-locked {
    cursor: default;
    opacity: 0.85;
  }
  .player-chip-locked:active { cursor: default; }
  .player-chip-locked:hover { background: rgba(255, 255, 255, 0.06); }

  .group-empty {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    text-align: center;
    padding: 0.5rem 0;
    font-style: italic;
  }

  /* Actions */
  .ls-actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .ls-error {
    color: #e05c5c;
    font-size: 0.85rem;
    margin: 0.5rem 0;
  }
  .ls-info {
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

  /* Stage 2 */
  .stage2-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .stage2-progress {
    font-size: 0.85rem;
    color: var(--muted, #9aa0a6);
  }
  .force-toggle {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
    color: #e5a623;
    cursor: pointer;
  }
  .stage2-controls {
    display: flex;
    gap: 0.75rem;
    margin-top: 1rem;
    flex-wrap: wrap;
  }

  .flight-cfg-section {
    margin-top: 1.25rem;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
  }
  .flight-cfg-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #888);
    margin: 0 0 0.6rem;
  }
  .flight-cfg-hint-txt { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .flight-cfg-row {
    display: grid;
    grid-template-columns: 9rem repeat(4, auto);
    align-items: center;
    gap: 0.5rem 1rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .flight-cfg-row:last-child { border-bottom: none; }
  .flight-cfg-name {
    font-weight: 600;
    font-size: 0.82rem;
    color: var(--accent, #ffd54f);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .flight-cfg-field {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    color: var(--muted, #888);
    white-space: nowrap;
  }
  .flight-cfg-field input {
    width: 4rem;
    padding: 0.2rem 0.4rem;
    font-size: 0.78rem;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 0.3rem;
    color: var(--fg, #f0f0f0);
  }
  .flight-cfg-field input:focus { outline: 1px solid var(--accent, #ffd54f); }

  .standings-grid {
    display: grid;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  @media (max-width: 40rem) {
    .standings-grid { grid-template-columns: 1fr 1fr !important; }
  }
  @media (max-width: 28rem) {
    .standings-grid { grid-template-columns: 1fr !important; }
  }
  .standings-group {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .standings-group-header {
    background: rgba(255, 213, 74, 0.1);
    color: var(--accent, #ffd54a);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.35rem 0.6rem;
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
  .net-neg { color: #e05c5c; }

  /* Shared button styles */
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
    :root:not([data-theme="dark"]) .league-setup-card {
      background: #fff;
      border-color: rgba(0, 0, 0, 0.1);
    }
    :root:not([data-theme="dark"]) .group-col {
      background: rgba(0, 0, 0, 0.02);
      border-color: rgba(0, 0, 0, 0.1);
    }
    :root:not([data-theme="dark"]) .player-chip {
      background: rgba(0, 0, 0, 0.04);
      border-color: rgba(0, 0, 0, 0.1);
    }
    :root:not([data-theme="dark"]) .player-chip:hover { background: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .btn { background: rgba(0, 0, 0, 0.06); color: #111; }
    :root:not([data-theme="dark"]) .btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
  }
  :root[data-theme="light"] .league-setup-card { background: #fff; border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .group-col { background: rgba(0, 0, 0, 0.02); border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .player-chip { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .btn { background: rgba(0, 0, 0, 0.06); color: #111; }
</style>
