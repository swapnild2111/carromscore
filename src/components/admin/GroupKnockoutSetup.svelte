<script lang="ts">
  /**
   * Group Knockout setup screen.
   *
   * Tab 1 — Groups & Draw: player assignment via drag-and-drop + Phase 1 bracket generation.
   * Tab 2 — Combined KO: group standings + Phase 2 combined knockout generation.
   */
  import { onMount } from 'svelte';
  import type { Tournament, LeagueGroup, KnockoutCfg } from '../../lib/tournaments';
  import {
    updateLeagueGroups,
    updateKnockoutCfg,
    startRound,
    clearAllRoundsAndPlanned,
    loadRounds,
    loadAssignedPlayers,
  } from '../../lib/tournaments';
  import { loadAll as loadAllPlayers, subscribeStore as subscribePlayerStore } from '../../lib/players';
  import { subscribePlannedByTournament, deletePlannedMatch, type PlannedMatch } from '../../lib/planned';
  import { loadMatchesByTournamentKey, type MatchRecord } from '../../lib/history';
  import { potSeeding } from '../../lib/league';
  import {
    recommendGroups,
    generateGroupPhase,
    generateCombinedKnockout,
  } from '../../lib/groupknockout';

  interface Props {
    tournament: Tournament;
    myUid: string;
    onClose: () => void;
  }

  const { tournament, myUid, onClose }: Props = $props();

  // ─── Tab ────────────────────────────────────────────────────────────────────
  let activeTab = $state<'draw' | 'knockout'>('draw');

  // ─── Players ────────────────────────────────────────────────────────────────
  let players = $state(loadAllPlayers());
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsubPlayers: (() => void) | null = null;
  let unsubPlanned: (() => void) | null = null;

  // ─── Config ─────────────────────────────────────────────────────────────────
  const koCfg = $derived(tournament.knockoutCfg);

  const venueBoards = $derived(Math.max(1, koCfg?.venueBoards ?? koCfg?.boardsAvailable ?? 4));

  // ─── Group count (configurable) ──────────────────────────────────────────────

  const recommendedGroupCount = $derived(
    recommendGroups(assignedPlayerIds.length, venueBoards).groupCount
  );

  // Read knockoutCfg directly (not via $derived) so it's available at $state init time.
  const initKoCfg = tournament.knockoutCfg;
  const initBoards = Math.max(1, initKoCfg?.venueBoards ?? initKoCfg?.boardsAvailable ?? 4);

  // Organizer can override; prefer explicit saved groupCount, else recommendation.
  // Note: assignedPlayerIds isn't populated yet at init, so use groups as proxy for player count.
  let manualGroupCount = $state<number>(
    initKoCfg?.groupCount ?? recommendGroups(
      Object.values(tournament.groups ?? {}).flatMap((g) => g.playerIds).length || 0,
      initBoards
    ).groupCount
  );

  // Track whether the organizer has manually touched the stepper this session.
  let groupCountManuallySet = $state(initKoCfg?.groupCount != null);

  // When no groups are saved yet AND organizer hasn't manually set a count, follow recommendation
  // once player list loads. Never clobber a manual choice.
  const hasExistingGroupsSaved = $derived(Object.keys(tournament.groups ?? {}).length > 0);

  $effect(() => {
    if (!hasExistingGroupsSaved && !groupCountManuallySet) {
      manualGroupCount = recommendedGroupCount;
    }
  });

  // ─── Group draw state ────────────────────────────────────────────────────────
  let localGroups = $state<Record<string, LeagueGroup>>(
    tournament.groups ? JSON.parse(JSON.stringify(tournament.groups)) : {}
  );

  let assignedPlayerIds = $state<string[]>([]);

  const assignedToGroup = $derived(
    new Set(Object.values(localGroups).flatMap((g) => g.playerIds))
  );
  const unassignedPlayers = $derived(
    assignedPlayerIds.filter((id) => !assignedToGroup.has(id))
  );

  const sortedGroups = $derived(
    Object.entries(localGroups).sort(([, a], [, b]) => a.order - b.order)
  );


  // ─── Drag state ──────────────────────────────────────────────────────────────
  let dragSrc = $state<{ fromGroup: string | '__unassigned__'; playerIdx: number } | null>(null);

  function onDragStart(fromGroup: string | '__unassigned__', playerIdx: number) {
    dragSrc = { fromGroup, playerIdx };
  }

  // dropTargetIdx: the chip index being hovered over (for within-group reorder highlight)
  let dropTargetGroup = $state<string | null>(null);
  let dropTargetIdx = $state<number | null>(null);

  function onDrop(toGroup: string | '__unassigned__', toIdx?: number) {
    if (!dragSrc) return;
    const { fromGroup, playerIdx } = dragSrc;

    const srcIds = fromGroup === '__unassigned__'
      ? [...unassignedPlayers]
      : [...(localGroups[fromGroup]?.playerIds ?? [])];
    const pid = srcIds[playerIdx];
    if (!pid) { dragSrc = null; dropTargetGroup = null; dropTargetIdx = null; return; }

    if (fromGroup === toGroup && toGroup !== '__unassigned__') {
      // Reorder within same group
      if (toIdx !== undefined && toIdx !== playerIdx) {
        const ids = [...(localGroups[toGroup]?.playerIds ?? [])];
        ids.splice(playerIdx, 1);
        ids.splice(toIdx, 0, pid);
        localGroups[toGroup] = { ...localGroups[toGroup]!, playerIds: ids };
        groupsDirty = true;
      }
    } else {
      // Move between groups
      if (fromGroup !== '__unassigned__' && localGroups[fromGroup]) {
        localGroups[fromGroup] = {
          ...localGroups[fromGroup]!,
          playerIds: localGroups[fromGroup]!.playerIds.filter((id) => id !== pid),
        };
      }
      if (toGroup !== '__unassigned__' && localGroups[toGroup]) {
        const ids = [...localGroups[toGroup]!.playerIds];
        if (toIdx !== undefined) {
          ids.splice(toIdx, 0, pid);
        } else {
          ids.push(pid);
        }
        localGroups[toGroup] = { ...localGroups[toGroup]!, playerIds: ids };
      }
      groupsDirty = true;
    }

    dragSrc = null;
    dropTargetGroup = null;
    dropTargetIdx = null;
  }

  // ─── Random draw ─────────────────────────────────────────────────────────────

  function doRandomDraw() {
    const playerName = (id: string) => players.find((p) => p.id === id)?.canonicalName ?? id;
    const playerNames = new Map(assignedPlayerIds.map((id) => [id, playerName(id)]));
    const potScores = new Map<string, number>();
    localGroups = potSeeding(assignedPlayerIds, playerNames, potScores, manualGroupCount);
    groupsDirty = false;
  }

  let redrawing = $state(false);

  async function doRedraw() {
    if (redrawing || generating) return;
    redrawing = true;
    // Bulk-delete ALL rounds + planned matches directly from Firebase —
    // bypasses memoryStore so no stale-snapshot duplicates.
    await clearAllRoundsAndPlanned(tournament.key);

    // Keep the current stepper count — don't reset to recommendation on re-generate.
    groupCountManuallySet = true;
    doRandomDraw();
    generateResult = null;
    groupsLocked = false;
    await lockAndGenerate();
    await startAllGroupRounds();
    redrawing = false;
  }

  // ─── Phase 1 generation ──────────────────────────────────────────────────────

  let generating = $state(false);
  let generateError = $state('');
  let generateResult = $state<{ matchesCreated: number; errors: string[] } | null>(null);
  let groupsLocked = $state(Object.keys(tournament.groups ?? {}).length > 0);
  let groupsDirty = $state(false);

  const roundsStarted = $derived(
    (tournament.rounds ?? []).some((r) => /^Group /i.test(r.name) && r.startedAt)
  );

  // Stale-config: groups are locked but tournament boards changed → recommendation shifted.
  const savedGroupCount = $derived(koCfg?.groupCount ?? 0);
  const configStale = $derived(
    groupsLocked &&
    !roundsStarted &&
    savedGroupCount > 0 &&
    recommendedGroupCount !== savedGroupCount
  );

  async function lockAndGenerate() {
    if (generating) return;
    // Validate
    for (const [, g] of sortedGroups) {
      if (g.playerIds.length < 2) {
        generateError = `Group ${g.name} needs at least 2 players`;
        return;
      }
      if (g.playerIds.length === 1) {
        generateError = `Group ${g.name} has 1 player — move them to another group`;
        return;
      }
    }
    generating = true;
    generateError = '';
    generateResult = null;

    // Delete existing group-phase planned matches before re-generating
    const existingGroupMatches = plannedMatches.filter((m) => /^Group /i.test(m.round ?? ''));
    await Promise.all(existingGroupMatches.map((m) => deletePlannedMatch(m.mid)));

    // Save config + groups
    const cfg: KnockoutCfg = {
      participantCount: assignedPlayerIds.length,
      venueBoards,
      groupCount: sortedGroups.length,
      groupSize: Math.ceil(assignedPlayerIds.length / Math.max(1, sortedGroups.length)),
    };
    const cfgOutcome = await updateKnockoutCfg(tournament.key, cfg, 'knockout');
    if (!cfgOutcome.ok) {
      generating = false;
      const raw = cfgOutcome.error ?? '';
      generateError = raw.includes('PERMISSION_DENIED')
        ? 'Permission denied — you can only edit tournaments you created.'
        : raw || 'Failed to save config';
      return;
    }

    const saveOutcome = await updateLeagueGroups(tournament.key, localGroups);
    if (!saveOutcome.ok) {
      generating = false;
      const raw = saveOutcome.error ?? '';
      generateError = raw.includes('PERMISSION_DENIED')
        ? 'Permission denied — you can only edit tournaments you created.'
        : raw || 'Failed to save groups';
      return;
    }
    groupsLocked = true;

    const playerName = (id: string) => players.find((p) => p.id === id)?.canonicalName ?? id;
    const playerNames = new Map(assignedPlayerIds.map((id) => [id, playerName(id)]));

    const result = await generateGroupPhase({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups: localGroups,
      playerNames,
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
        timerDuration: tournament.defaults?.timerDuration,
      },
      myUid,
    });
    generateResult = { matchesCreated: result.matchesCreated, errors: result.errors };
    groupsDirty = false;
    generating = false;
    // Freeze stepper to the count we just saved so the $effect doesn't clobber it.
    manualGroupCount = sortedGroups.length;
    groupCountManuallySet = true;
  }

  // ─── Start all group rounds ───────────────────────────────────────────────────

  let startingRounds = $state(false);

  async function startAllGroupRounds() {
    startingRounds = true;
    // Read directly from memoryStore (not tournament prop) so freshly-created
    // rounds are included without waiting for a Svelte re-render cycle.
    const rounds = loadRounds(tournament.key);
    const groupRounds = rounds.filter((r) => /^Group /i.test(r.name) && !r.startedAt);
    for (const r of groupRounds) {
      await startRound(tournament.key, r.key);
    }
    startingRounds = false;
  }

  // ─── Phase 2: combined knockout ───────────────────────────────────────────────

  let koGenRunning = $state(false);
  let koGenResult = $state<{ roundsCreated: string[]; errors: string[] } | null>(null);
  let forceGenerate = $state(false);

  // Progress tracking for group phase
  const groupMatchCounts = $derived.by(() => {
    const counts = new Map<string, { total: number; completed: number }>();
    for (const [gKey, g] of sortedGroups) {
      const forGroup = plannedMatches.filter((m) => m.round?.startsWith(`${g.name} —`) ?? false);
      counts.set(gKey, {
        total: forGroup.length,
        completed: forGroup.filter((m) => m.completedAt !== undefined).length,
      });
    }
    return counts;
  });

  const totalGroupMatches = $derived(
    sortedGroups.reduce((sum, [gKey]) => sum + (groupMatchCounts.get(gKey)?.total ?? 0), 0)
  );
  const completedGroupMatches = $derived(
    sortedGroups.reduce((sum, [gKey]) => sum + (groupMatchCounts.get(gKey)?.completed ?? 0), 0)
  );
  const allGroupsDone = $derived(
    totalGroupMatches > 0 && completedGroupMatches === totalGroupMatches
  );

  // Per-group final status: did the group produce a champion + runner-up?
  const groupFinalCounts = $derived.by(() => {
    const counts = new Map<string, { total: number; completed: number }>();
    for (const [gKey, g] of sortedGroups) {
      const finals = plannedMatches.filter(
        (m) => m.round === `${g.name} — Final`
      );
      counts.set(gKey, {
        total: finals.length,
        completed: finals.filter((m) => m.completedAt !== undefined).length,
      });
    }
    return counts;
  });

  async function generateCombinedKO() {
    if (koGenRunning) return;
    koGenRunning = true;
    koGenResult = null;

    // Delete existing KO— planned matches before re-generating
    const existingKOMatches = plannedMatches.filter((m) => /^KO —/i.test(m.round ?? ''));
    await Promise.all(existingKOMatches.map((m) => deletePlannedMatch(m.mid)));

    const result = await generateCombinedKnockout({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups: localGroups,
      groupCount: sortedGroups.length,
      defaults: {
        mode: tournament.defaults?.mode ?? 'singles',
        bestOf: tournament.defaults?.bestOf ?? 3,
        pointsTarget: tournament.defaults?.pointsTarget ?? 25,
        maxBoards: tournament.defaults?.maxBoards ?? 8,
        timerDuration: tournament.defaults?.timerDuration,
      },
      myUid,
    });
    koGenResult = { roundsCreated: result.roundsCreated, errors: result.errors };
    koGenRunning = false;
  }

  // ─── Archived matches ────────────────────────────────────────────────────────
  let archivedMatches = $state<MatchRecord[]>([]);

  // ─── Player name helper ───────────────────────────────────────────────────────
  function playerName(id: string): string {
    return players.find((p) => p.id === id)?.canonicalName ?? id;
  }

  function groupMatchStatus(gKey: string, gName: string) {
    const counts = groupMatchCounts.get(gKey);
    if (!counts || counts.total === 0) return { label: 'No matches yet', done: false };
    return {
      label: `${counts.completed} / ${counts.total} complete`,
      done: counts.completed === counts.total,
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────────
  onMount(() => {
    unsubPlayers = subscribePlayerStore(() => { players = loadAllPlayers(); });
    (async () => {
      const assigned = await loadAssignedPlayers(tournament.key);
      assignedPlayerIds = assigned.size > 0
        ? [...assigned]
        : players.map((p) => p.id);

      unsubPlanned = await subscribePlannedByTournament(tournament.key, (arr) => {
        plannedMatches = arr;
      });
      archivedMatches = await loadMatchesByTournamentKey(tournament.key);

      if (assignedPlayerIds.length > 0 && Object.keys(localGroups).length === 0) {
        doRandomDraw();
      }
    })();
    return () => {
      unsubPlayers?.();
      unsubPlanned?.();
    };
  });
</script>

<div class="gko-overlay" role="dialog" aria-modal="true" aria-label="Group Knockout Setup">
  <div class="gko-card">
    <div class="ls-header">
      <h2 class="ls-title">Group Knockout — {tournament.name}</h2>
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
        class:ls-tab-active={activeTab === 'knockout'}
        role="tab"
        aria-selected={activeTab === 'knockout'}
        onclick={() => { activeTab = 'knockout'; }}
      >Combined Knockout</button>
    </div>

    <!-- ─── Groups & Draw ─────────────────────────────────────────────────────── -->
    {#if activeTab === 'draw'}
      <div class="ls-body">
        <div class="draw-controls">
          {#if !roundsStarted}
            <div class="group-count-row">
              <span class="group-count-label">Groups</span>
              <div class="group-count-stepper">
                <button
                  type="button"
                  class="stepper-btn"
                  aria-label="Fewer groups"
                  disabled={manualGroupCount <= 1 || redrawing || generating}
                  onclick={() => { groupCountManuallySet = true; manualGroupCount = Math.max(1, manualGroupCount - 1); doRandomDraw(); }}
                >−</button>
                <span class="stepper-value">{manualGroupCount}</span>
                <button
                  type="button"
                  class="stepper-btn"
                  aria-label="More groups"
                  disabled={manualGroupCount >= 4 || manualGroupCount >= Math.floor(assignedPlayerIds.length / 2) || redrawing || generating}
                  onclick={() => { groupCountManuallySet = true; manualGroupCount = Math.min(4, manualGroupCount + 1); doRandomDraw(); }}
                >+</button>
              </div>
              {#if recommendedGroupCount !== manualGroupCount}
                <span class="group-count-hint">recommended: {recommendedGroupCount}</span>
              {:else}
                <span class="group-count-hint">recommended</span>
              {/if}
            </div>
          {/if}
          {#if roundsStarted}
            <span class="draw-locked-hint">🔒 Groups locked — rounds in progress</span>
          {:else if groupsLocked && !groupsDirty}
            <span class="draw-auto-hint">Drag players to adjust, then re-generate</span>
          {/if}
          {#if unassignedPlayers.length > 0}
            <span class="draw-warn">⚠ {unassignedPlayers.length} player{unassignedPlayers.length !== 1 ? 's' : ''} unassigned</span>
          {/if}
        </div>

        {#if configStale}
          <div class="config-stale-banner">
            <span class="stale-icon">⚠</span>
            <span class="stale-msg">Tournament config changed — recommendation is now <strong>{recommendedGroupCount} group{recommendedGroupCount !== 1 ? 's' : ''}</strong> (was {savedGroupCount}). Re-generate brackets to apply.</span>
            <button type="button" class="btn btn-primary btn-sm" onclick={doRedraw} disabled={redrawing || generating}>{redrawing ? 'Re-generating…' : '↺ Re-generate'}</button>
          </div>
        {/if}

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
        <div class="groups-grid" style="grid-template-columns: repeat({Math.min(sortedGroups.length, 4)}, 1fr)">
          {#each sortedGroups as [gKey, group] (gKey)}
            {@const status = groupMatchStatus(gKey, group.name)}
            {@const hasOddBye = group.playerIds.length % 2 !== 0 && group.playerIds.length > 1}
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
                  class:player-chip-bye={hasOddBye && i === 0}
                  class:player-chip-drop-above={dropTargetGroup === gKey && dropTargetIdx === i}
                  draggable={!roundsStarted}
                  role="listitem"
                  title={hasOddBye && i === 0 ? 'Top seed — receives bye in Round 1' : undefined}
                  ondragstart={roundsStarted ? undefined : () => onDragStart(gKey, i)}
                  ondragover={roundsStarted ? undefined : (e) => { e.preventDefault(); dropTargetGroup = gKey; dropTargetIdx = i; }}
                  ondragleave={roundsStarted ? undefined : () => { if (dropTargetGroup === gKey && dropTargetIdx === i) { dropTargetGroup = null; dropTargetIdx = null; } }}
                  ondrop={roundsStarted ? undefined : (e) => { e.stopPropagation(); onDrop(gKey, i); }}
                >
                  {playerName(pid)}{hasOddBye && i === 0 ? ' 👑' : ''}
                </div>
              {/each}
              {#if group.playerIds.length === 0}
                <div class="group-empty">Drop players here</div>
              {/if}
              {#if hasOddBye && !roundsStarted}
                <div class="bye-note">Top seed skips Round 1</div>
              {/if}
            </div>
          {/each}
        </div>

        {#if generateError}
          <p class="ls-error">{generateError}</p>
        {/if}

        {#if generateResult}
          <div class="generate-result">
            <strong>Phase 1 generated:</strong> {generateResult.matchesCreated} matches.
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
            <!-- no actions — groups locked, rounds in progress -->
          {:else if generating}
            <button type="button" class="btn btn-primary" disabled>Generating…</button>
          {:else if groupsDirty}
            <button
              type="button"
              class="btn btn-primary"
              onclick={lockAndGenerate}
              disabled={sortedGroups.length === 0}
            >Lock groups &amp; generate brackets</button>
          {:else if groupsLocked}
            {#if (tournament.rounds ?? []).some((r) => /^Group /i.test(r.name) && !r.startedAt)}
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
              disabled={redrawing || generating}
            >{redrawing ? 'Re-generating…' : '↺ Re-generate brackets'}</button>
          {:else if !groupsLocked && sortedGroups.length > 0}
            <button
              type="button"
              class="btn btn-primary"
              onclick={lockAndGenerate}
            >Generate brackets</button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- ─── Combined Knockout ─────────────────────────────────────────────────── -->
    {#if activeTab === 'knockout'}
      <div class="ls-body">
        {#if !groupsLocked}
          <p class="ls-info">Complete Stage 1 draw first — lock groups and generate group brackets to enable Phase 2.</p>
        {:else}
          <div class="stage2-header">
            <span class="stage2-progress">
              Group phase: <strong>{completedGroupMatches} / {totalGroupMatches}</strong> matches complete
            </span>
            {#if !allGroupsDone}
              <label class="force-toggle">
                <input type="checkbox" bind:checked={forceGenerate} />
                Force generate (incomplete results)
              </label>
            {/if}
          </div>

          <!-- Per-group final status -->
          {#if sortedGroups.length > 0}
            <div class="ko-seeding-table">
              <div class="ko-seeding-header">Combined KO seeding (champion × runner-up cross-pairing)</div>
              <table class="seeding-tbl">
                <thead>
                  <tr>
                    <th>Match</th>
                    <th>Player A</th>
                    <th>vs</th>
                    <th>Player B</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {#each sortedGroups as [gKey, g], k (gKey)}
                    {@const mirrorIdx = sortedGroups.length - 1 - k}
                    {@const mirrorGroup = sortedGroups[mirrorIdx]?.[1]}
                    {@const aFinal = groupFinalCounts.get(gKey)}
                    {@const bFinal = mirrorGroup ? groupFinalCounts.get(sortedGroups[mirrorIdx]![0]) : undefined}
                    {#if k <= Math.floor((sortedGroups.length - 1) / 2)}
                      <tr>
                        <td class="ko-match-label">QF {k + 1}</td>
                        <td class="ko-slot-a">{g.name} Champion</td>
                        <td class="ko-vs">vs</td>
                        <td class="ko-slot-b">{mirrorGroup?.name ?? '?'} Runner-Up</td>
                        <td class="ko-status">
                          {#if (aFinal?.completed ?? 0) > 0 && (bFinal?.completed ?? 0) > 0}
                            <span class="status-ready">Ready</span>
                          {:else}
                            <span class="status-pending">Pending</span>
                          {/if}
                        </td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          <div class="stage2-controls">
            <button
              type="button"
              class="btn btn-primary"
              onclick={generateCombinedKO}
              disabled={koGenRunning || (!allGroupsDone && !forceGenerate)}
            >{koGenRunning ? 'Generating KO draw…' : 'Generate Combined KO →'}</button>
          </div>

          {#if koGenResult}
            <div class="generate-result">
              {#if koGenResult.roundsCreated.length > 0}
                <strong>Rounds added:</strong> {koGenResult.roundsCreated.join(', ')}.
                Open the Bracket view to see the seeded draw.
              {/if}
              {#if koGenResult.errors.length > 0}
                <ul class="result-errors">
                  {#each koGenResult.errors as e}<li>{e}</li>{/each}
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
  .gko-overlay {
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
  .gko-card {
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

  .ls-body {
    padding: 1rem 1.25rem;
    overflow-y: auto;
    flex: 1;
  }

  /* Boards input + recommendation */
  .draw-controls {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.5rem;
    flex-wrap: wrap;
  }

  /* Group count stepper */
  .group-count-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    padding: 4px 10px 4px 10px;
  }
  .group-count-label {
    font-size: 0.75rem;
    color: var(--muted, #9aa0a6);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 600;
  }
  .group-count-stepper {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .stepper-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: inherit;
    border-radius: 4px;
    width: 24px;
    height: 24px;
    font-size: 1rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: background 0.15s;
  }
  .stepper-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
  .stepper-btn:disabled { opacity: 0.35; cursor: default; }
  .stepper-value {
    font-size: 1rem;
    font-weight: 700;
    min-width: 1.4rem;
    text-align: center;
    color: #f0c040;
  }
  .group-count-hint {
    font-size: 0.7rem;
    color: var(--muted, #9aa0a6);
    font-style: italic;
  }

  /* Stale-config warning banner */
  .config-stale-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    background: rgba(229, 166, 35, 0.12);
    border: 1px solid rgba(229, 166, 35, 0.4);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .stale-icon { font-size: 1rem; color: #e5a623; flex-shrink: 0; }
  .stale-msg { font-size: 0.82rem; color: var(--fg, #e8eaf0); flex: 1; min-width: 180px; }
  .btn-sm { padding: 4px 12px; font-size: 0.8rem; }

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
  .group-match-done { color: #56cb82; }
  .group-col-locked { cursor: default; }
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
  .player-chip-bye {
    border-color: rgba(255, 213, 74, 0.3);
    background: rgba(255, 213, 74, 0.06);
  }
  .player-chip-drop-above {
    border-top: 2px solid var(--accent, #ffd54a);
    margin-top: -1px;
  }
  .bye-note {
    font-size: 0.65rem;
    color: rgba(255, 213, 74, 0.6);
    font-style: italic;
    text-align: center;
    margin-top: 0.25rem;
  }
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

  /* KO seeding table */
  .ko-seeding-table {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
    margin-bottom: 1rem;
  }
  .ko-seeding-header {
    background: rgba(255, 213, 74, 0.08);
    color: var(--accent, #ffd54a);
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.4rem 0.75rem;
  }
  .seeding-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8rem;
  }
  .seeding-tbl th,
  .seeding-tbl td {
    padding: 0.3rem 0.6rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }
  .seeding-tbl th {
    background: rgba(255, 255, 255, 0.04);
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted, #9aa0a6);
  }
  .seeding-tbl tr:last-child td { border-bottom: 0; }
  .ko-match-label { color: var(--muted, #9aa0a6); font-size: 0.75rem; white-space: nowrap; }
  .ko-slot-a { font-weight: 600; }
  .ko-slot-b { font-weight: 600; }
  .ko-vs { text-align: center; color: var(--muted, #9aa0a6); font-size: 0.72rem; }
  .ko-status { text-align: center; }
  .status-ready { color: #56cb82; font-size: 0.72rem; font-weight: 600; }
  .status-pending { color: var(--muted, #9aa0a6); font-size: 0.72rem; }

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

  /* Light theme — covers system light AND explicit [data-theme="light"] */
  @media (prefers-color-scheme: light) {
    :root:not([data-theme="dark"]) .gko-card { background: #fff; border-color: rgba(0, 0, 0, 0.1); color: #111; }
    :root:not([data-theme="dark"]) .ls-header { border-bottom-color: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .ls-close:hover { color: #111; }
    :root:not([data-theme="dark"]) .ls-tabs { border-bottom-color: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .ls-tab:hover { color: #111; }
    :root:not([data-theme="dark"]) .group-col { background: rgba(0, 0, 0, 0.02); border-color: rgba(0, 0, 0, 0.1); }
    :root:not([data-theme="dark"]) .group-col-header { border-bottom-color: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .group-count { background: rgba(0, 0, 0, 0.06); }
    :root:not([data-theme="dark"]) .player-chip { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.1); color: #111; }
    :root:not([data-theme="dark"]) .player-chip:hover { background: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .player-chip-locked:hover { background: rgba(0, 0, 0, 0.04); }
    :root:not([data-theme="dark"]) .btn { background: rgba(0, 0, 0, 0.06); color: #111; }
    :root:not([data-theme="dark"]) .btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
    :root:not([data-theme="dark"]) .btn-secondary { background: rgba(0, 0, 0, 0.06); }
    :root:not([data-theme="dark"]) .btn { border-color: rgba(0, 0, 0, 0.15); }
    :root:not([data-theme="dark"]) .generate-result { background: rgba(0, 0, 0, 0.03); border-color: rgba(0, 0, 0, 0.1); }
    :root:not([data-theme="dark"]) .ko-seeding-table { border-color: rgba(0, 0, 0, 0.1); }
    :root:not([data-theme="dark"]) .seeding-tbl th { background: rgba(0, 0, 0, 0.04); border-bottom-color: rgba(0, 0, 0, 0.07); }
    :root:not([data-theme="dark"]) .seeding-tbl td { border-bottom-color: rgba(0, 0, 0, 0.07); }
    :root:not([data-theme="dark"]) .draw-locked-hint { color: rgba(160, 100, 0, 0.8); }
    :root:not([data-theme="dark"]) .bye-note { color: rgba(160, 100, 0, 0.7); }
    :root:not([data-theme="dark"]) .group-count-row { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.12); }
    :root:not([data-theme="dark"]) .stepper-btn { background: rgba(0, 0, 0, 0.06); border-color: rgba(0, 0, 0, 0.15); color: #111; }
    :root:not([data-theme="dark"]) .stepper-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
    :root:not([data-theme="dark"]) .config-stale-banner { background: rgba(200, 130, 0, 0.1); border-color: rgba(200, 130, 0, 0.4); }
    :root:not([data-theme="dark"]) .stale-msg { color: #111; }
  }
  :root[data-theme="light"] .gko-card { background: #fff; border-color: rgba(0, 0, 0, 0.1); color: #111; }
  :root[data-theme="light"] .ls-header { border-bottom-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .ls-close:hover { color: #111; }
  :root[data-theme="light"] .ls-tabs { border-bottom-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .ls-tab:hover { color: #111; }
  :root[data-theme="light"] .group-col { background: rgba(0, 0, 0, 0.02); border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .group-col-header { border-bottom-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .group-count { background: rgba(0, 0, 0, 0.06); }
  :root[data-theme="light"] .player-chip { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.1); color: #111; }
  :root[data-theme="light"] .player-chip:hover { background: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .player-chip-locked:hover { background: rgba(0, 0, 0, 0.04); }
  :root[data-theme="light"] .btn { background: rgba(0, 0, 0, 0.06); color: #111; border-color: rgba(0, 0, 0, 0.15); }
  :root[data-theme="light"] .btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
  :root[data-theme="light"] .btn-secondary { background: rgba(0, 0, 0, 0.06); }
  :root[data-theme="light"] .generate-result { background: rgba(0, 0, 0, 0.03); border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .ko-seeding-table { border-color: rgba(0, 0, 0, 0.1); }
  :root[data-theme="light"] .seeding-tbl th { background: rgba(0, 0, 0, 0.04); border-bottom-color: rgba(0, 0, 0, 0.07); }
  :root[data-theme="light"] .seeding-tbl td { border-bottom-color: rgba(0, 0, 0, 0.07); }
  :root[data-theme="light"] .draw-locked-hint { color: rgba(160, 100, 0, 0.8); }
  :root[data-theme="light"] .bye-note { color: rgba(160, 100, 0, 0.7); }
  :root[data-theme="light"] .group-count-row { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.12); }
  :root[data-theme="light"] .stepper-btn { background: rgba(0, 0, 0, 0.06); border-color: rgba(0, 0, 0, 0.15); color: #111; }
  :root[data-theme="light"] .stepper-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
  :root[data-theme="light"] .config-stale-banner { background: rgba(200, 130, 0, 0.1); border-color: rgba(200, 130, 0, 0.4); }
  :root[data-theme="light"] .stale-msg { color: #111; }
</style>
