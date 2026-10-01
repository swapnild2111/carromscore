<script lang="ts">
  /**
   * Group Knockout setup screen.
   *
   * Tab 1 — Groups & Draw: player assignment via drag-and-drop + Phase 1 bracket generation.
   * Tab 2 — Combined KO: group standings + Phase 2 combined knockout generation.
   */
  import { onMount, untrack } from 'svelte';
  import type { Tournament, LeagueGroup, KnockoutCfg } from '../../lib/tournaments';
  import {
    updateLeagueGroups,
    updateKnockoutCfg,
    startRound,
    deleteRound,
    clearAllRoundsAndPlanned,
    loadRounds,
    loadAssignedPlayers,
  } from '../../lib/tournaments';
  import { loadAll as loadAllPlayers, subscribeStore as subscribePlayerStore } from '../../lib/players';
  import { subscribePlannedByTournament, deletePlannedMatch, forfeitDummyMatch, loadPendingPlannedByTournament, type PlannedMatch } from '../../lib/planned';
  import { loadMatchesByTournamentKey, type MatchRecord } from '../../lib/history';
  import {
    generateGroupPhase,
    generateCombinedKnockout,
  } from '../../lib/groupknockout';

  interface Props {
    tournament: Tournament;
    myUid: string;
    onClose: () => void;
  }

  const { tournament, myUid, onClose }: Props = $props();

  // ─── Players ────────────────────────────────────────────────────────────────
  let players = $state(loadAllPlayers());
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsubPlayers: (() => void) | null = null;
  let unsubPlanned: (() => void) | null = null;

  // ─── Config ─────────────────────────────────────────────────────────────────
  const koCfg = $derived(tournament.knockoutCfg);

  const venueBoards = $derived(Math.max(1, koCfg?.venueBoards ?? koCfg?.boardsAvailable ?? 4));

  // ─── Group draw state ────────────────────────────────────────────────────────
  let localGroups = $state<Record<string, LeagueGroup>>(
    tournament.groups ? JSON.parse(JSON.stringify(tournament.groups)) : {}
  );

  // ─── Group count ─────────────────────────────────────────────────────────────
  // Derived from actual localGroups — stepper adds/removes groups directly.
  const manualGroupCount = $derived(Object.keys(localGroups).length);
  let groupCountManuallySet = $state(Object.keys(tournament.groups ?? {}).length > 0);

  let assignedPlayerIds = $state<string[]>([]);

  // ─── Dummy slots ─────────────────────────────────────────────────────────────
  // Restore dummyCount from saved groups (dummy-N IDs may already be in playerIds)
  function countSavedDummies(groups: Record<string, LeagueGroup>): number {
    let max = 0;
    for (const g of Object.values(groups)) {
      for (const id of g.playerIds) {
        const m = id.match(/^dummy-(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1]!, 10));
      }
    }
    return max;
  }
  let dummyCount = $state(countSavedDummies(tournament.groups ?? {}));

  function addDummy() {
    dummyCount += 1;
    // New dummy appears in the unassigned dummy pool (unassignedDummies derived)
    groupsDirty = true;
  }

  function isDummy(id: string): boolean {
    return /^dummy-\d+$/.test(id);
  }

  const dummyIds = $derived(
    Array.from({ length: dummyCount }, (_, i) => `dummy-${i + 1}`)
  );

  // ─── Pre-qualify marking ─────────────────────────────────────────────────────
  // preQualified: flat Set of playerIds who play in the first round (pre-qualify)
  let preQualified = $state<Set<string>>(
    (() => {
      const s = new Set<string>();
      for (const g of Object.values(tournament.groups ?? {})) {
        for (const id of g.preQualifyIds ?? []) s.add(id);
      }
      return s;
    })()
  );

  function togglePreQualify(pid: string) {
    const next = new Set(preQualified);
    if (next.has(pid)) next.delete(pid);
    else next.add(pid);
    preQualified = next;
    groupsDirty = true;
  }

  const assignedToGroup = $derived(
    new Set(Object.values(localGroups).flatMap((g) => g.playerIds))
  );
  const unassignedPlayers = $derived(
    assignedPlayerIds.filter((id) => !assignedToGroup.has(id))
  );
  const unassignedDummies = $derived(
    dummyIds.filter((id) => !assignedToGroup.has(id))
  );

  const sortedGroups = $derived(
    Object.entries(localGroups).sort(([, a], [, b]) => a.order - b.order)
  );


  // ─── Drag state ──────────────────────────────────────────────────────────────
  let dragSrc = $state<{ fromGroup: string | '__unassigned__' | '__dummies__'; playerIdx: number } | null>(null);

  function onDragStart(e: DragEvent, fromGroup: string | '__unassigned__' | '__dummies__', playerIdx: number, label: string) {
    dragSrc = { fromGroup, playerIdx };
    // Compact drag ghost: small pill so it doesn't stretch across the screen
    const ghost = document.createElement('div');
    ghost.textContent = label;
    ghost.style.cssText = [
      'position:fixed', 'top:-9999px', 'left:-9999px',
      'background:#333', 'color:#f5f5f5', 'border:1px solid rgba(255,255,255,0.25)',
      'border-radius:999px', 'padding:3px 10px', 'font-size:0.78rem',
      'white-space:nowrap', 'max-width:180px', 'overflow:hidden',
      'text-overflow:ellipsis', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(ghost);
    e.dataTransfer?.setDragImage(ghost, ghost.offsetWidth / 2, ghost.offsetHeight / 2);
    setTimeout(() => ghost.remove(), 0);
  }

  // dropTargetIdx: the chip index being hovered over (for within-group reorder highlight)
  let dropTargetGroup = $state<string | null>(null);
  let dropTargetIdx = $state<number | null>(null);

  function onDrop(toGroup: string | '__unassigned__' | '__dummies__', toIdx?: number) {
    if (!dragSrc) return;
    const { fromGroup, playerIdx } = dragSrc;

    const srcIds = fromGroup === '__unassigned__'
      ? [...unassignedPlayers]
      : fromGroup === '__dummies__'
        ? [...unassignedDummies]
        : [...(localGroups[fromGroup]?.playerIds ?? [])];
    const pid = srcIds[playerIdx];
    if (!pid) { dragSrc = null; dropTargetGroup = null; dropTargetIdx = null; return; }

    const isPoolTarget = toGroup === '__unassigned__' || toGroup === '__dummies__';

    if (fromGroup === toGroup && !isPoolTarget) {
      // Reorder within same group
      if (toIdx !== undefined && toIdx !== playerIdx) {
        const ids = [...(localGroups[toGroup]?.playerIds ?? [])];
        ids.splice(playerIdx, 1);
        ids.splice(toIdx, 0, pid);
        localGroups[toGroup] = { ...localGroups[toGroup]!, playerIds: ids };
        groupsDirty = true;
      }
    } else {
      // Move between groups (or back to a pool)
      if (fromGroup !== '__unassigned__' && fromGroup !== '__dummies__' && localGroups[fromGroup]) {
        localGroups[fromGroup] = {
          ...localGroups[fromGroup]!,
          playerIds: localGroups[fromGroup]!.playerIds.filter((id) => id !== pid),
        };
      }
      if (!isPoolTarget && localGroups[toGroup]) {
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

  // ─── Group add / remove ───────────────────────────────────────────────────────

  let removeGroupError = $state('');

  function initGroups() {
    localGroups = {
      g1: { name: 'G1', order: 1, playerIds: [] },
    };
    groupsDirty = false;
  }

  function addGroup() {
    const maxOrder = Object.values(localGroups).reduce((m, g) => Math.max(m, g.order), 0);
    const nextN = maxOrder + 1;
    // Find a key that doesn't already exist
    let gKey = `g${nextN}`;
    let n = nextN;
    while (localGroups[gKey]) { n++; gKey = `g${n}`; }
    localGroups = {
      ...localGroups,
      [gKey]: { name: `G${nextN}`, order: nextN, playerIds: [] },
    };
    groupsDirty = true;
    removeGroupError = '';
  }

  function removeLastGroup() {
    const entries = Object.entries(localGroups).sort(([, a], [, b]) => b.order - a.order);
    if (entries.length <= 1) return;
    const [lastKey, lastGroup] = entries[0]!;
    if (lastGroup.playerIds.length > 0) {
      removeGroupError = `Move all players out of ${lastGroup.name} first`;
      return;
    }
    removeGroupError = '';
    const next = { ...localGroups };
    delete next[lastKey];
    localGroups = next;
    groupsDirty = true;
  }

  function removeGroupByKey(gKey: string) {
    const group = localGroups[gKey];
    if (!group) return;
    if (group.playerIds.length > 0) {
      removeGroupError = `Move all players out of ${group.name} first`;
      return;
    }
    if (Object.keys(localGroups).length <= 1) return;
    removeGroupError = '';
    const next = { ...localGroups };
    delete next[gKey];
    localGroups = next;
    groupsDirty = true;
  }

  let redrawing = $state(false);

  // ─── Phase 1 generation ──────────────────────────────────────────────────────

  let generating = $state(false);
  let generateError = $state('');
  let generateResult = $state<{ matchesCreated: number; errors: string[] } | null>(null);
  let groupsLocked = $state(Object.keys(tournament.groups ?? {}).length > 0);
  let groupsDirty = $state(false);

  const roundsStarted = $derived(
    (tournament.rounds ?? []).some((r) => / — /.test(r.name) && !/^KO —/.test(r.name) && r.startedAt)
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

    // Delete all existing group-phase rounds (and their planned matches) before re-generating.
    // Group rounds are named "G1 — QF", "G1 — Pre-qualify", etc. — match on " — " separator.
    const existingGroupRounds = loadRounds(tournament.key).filter(
      (r) => / — /.test(r.name) && !/^KO —/.test(r.name)
    );
    await Promise.all(existingGroupRounds.map((r) => deleteRound(tournament.key, r.key)));

    // Save knockoutCfg — requires being the creator; ignore permission errors on re-generate.
    const cfg: KnockoutCfg = {
      participantCount: assignedPlayerIds.length,
      venueBoards,
      groupCount: sortedGroups.length,
      groupSize: Math.ceil(assignedPlayerIds.length / Math.max(1, sortedGroups.length)),
    };
    const cfgOutcome = await updateKnockoutCfg(tournament.key, cfg, 'knockout');
    if (!cfgOutcome.ok && (cfgOutcome.error ?? '').includes('PERMISSION_DENIED') && !groupsLocked) {
      generating = false;
      generateError = 'Permission denied — you can only edit tournaments you created.';
      return;
    }

    // Merge pre-qualify markings into groups before saving
    const groupsToSave: Record<string, LeagueGroup> = {};
    for (const [gKey, g] of Object.entries(localGroups)) {
      const groupPreQualifyIds = g.playerIds.filter((pid) => preQualified.has(pid));
      const entry: LeagueGroup = { name: g.name, order: g.order, playerIds: g.playerIds };
      if (groupPreQualifyIds.length > 0) entry.preQualifyIds = groupPreQualifyIds;
      groupsToSave[gKey] = entry;
    }

    const saveOutcome = await updateLeagueGroups(tournament.key, groupsToSave);
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
    for (const did of dummyIds) {
      playerNames.set(did, `Dummy ${did.replace('dummy-', '')}`);
    }

    const result = await generateGroupPhase({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups: groupsToSave,
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
    groupCountManuallySet = true;

    // Auto-generate combined KO when there are multiple groups
    if (sortedGroups.length > 1) {
      await generateCombinedKO();
    }
  }

  // ─── Start first group round ──────────────────────────────────────────────────

  let startingRounds = $state(false);

  async function startAllGroupRounds() {
    startingRounds = true;
    const rounds = loadRounds(tournament.key);
    const allGroupRounds = rounds
      .filter((r) => / — /.test(r.name) && !/^KO —/.test(r.name) && !r.startedAt)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    // Find the first (lowest-order) round for each group prefix (e.g. "G1", "G2")
    const firstRoundPerGroup = new Map<string, typeof allGroupRounds[0]>();
    for (const r of allGroupRounds) {
      const prefix = r.name.split(' — ')[0]!;
      if (!firstRoundPerGroup.has(prefix)) firstRoundPerGroup.set(prefix, r);
    }
    const firstRounds = [...firstRoundPerGroup.values()];

    if (firstRounds.length > 0) {
      await Promise.all(firstRounds.map((r) => startRound(tournament.key, r.key)));
      // Auto-forfeit dummy-side matches. Fetch fresh from Firebase rather than
      // reading reactive plannedMatches, which may not have propagated yet.
      const isDummySide = (m: PlannedMatch) =>
        /^dummy-\d+$/i.test(m.aResolvedId ?? m.aName ?? '') ||
        /^dummy-\d+$/i.test(m.bResolvedId ?? m.bName ?? '');
      const startedKeys = new Set(firstRounds.map((r) => r.key));
      const freshMatches = await loadPendingPlannedByTournament(tournament.key);
      const dummyMatches = freshMatches.filter(
        (m) => startedKeys.has(m.roundKey ?? '') && isDummySide(m) && !m.completedAt,
      );
      await Promise.all(dummyMatches.map((m) => forfeitDummyMatch(m.mid, myUid)));
    }
    startingRounds = false;
    onClose();
  }

  // ─── Phase 2: combined knockout ───────────────────────────────────────────────

  let koGenRunning = $state(false);
  let koGenResult = $state<{ roundsCreated: string[]; errors: string[] } | null>(null);
  let forceGenerate = $state(false);

  // KO seeding order: organiser can drag groups to reorder; defaults to sorted group order.
  // Stored as an array of group keys in seeding order (top seed first).
  let koSeedOrder = $state<string[]>([]);

  // Keep koSeedOrder in sync with sortedGroups: add new keys, remove stale ones,
  // preserving any manual reordering.
  $effect(() => {
    const currentKeys = sortedGroups.map(([k]) => k);
    // Read koSeedOrder via untrack to avoid registering it as a reactive dependency
    const prev = untrack(() => koSeedOrder);
    const filtered = prev.filter((k) => currentKeys.includes(k));
    const missing = currentKeys.filter((k) => !filtered.includes(k));
    if (missing.length > 0 || filtered.length !== prev.length) {
      koSeedOrder = [...filtered, ...missing];
    }
  });

  // Derived list of [key, group] in KO seed order
  const koSeedGroups = $derived(
    koSeedOrder
      .map((k) => [k, localGroups[k]] as [string, LeagueGroup])
      .filter(([, g]) => g != null)
  );

  let koDragSrc = $state<number | null>(null);
  let koDragOver = $state<number | null>(null);

  function onKODragStart(idx: number) { koDragSrc = idx; }
  function onKODragOver(e: DragEvent, idx: number) { e.preventDefault(); koDragOver = idx; }
  function onKODrop(toIdx: number) {
    if (koDragSrc == null || koDragSrc === toIdx) { koDragSrc = null; koDragOver = null; return; }
    const next = [...koSeedOrder];
    const [moved] = next.splice(koDragSrc, 1);
    next.splice(toIdx, 0, moved!);
    koSeedOrder = next;
    koDragSrc = null; koDragOver = null;
  }
  function onKODragEnd() { koDragSrc = null; koDragOver = null; }

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

    // Delete existing KO rounds and planned matches before re-generating
    const existingKORounds = loadRounds(tournament.key).filter((r) => /^KO —/.test(r.name));
    await Promise.all(existingKORounds.map((r) => deleteRound(tournament.key, r.key)));
    const existingKOMatches = plannedMatches.filter((m) => /^KO —/i.test(m.round ?? ''));
    await Promise.all(existingKOMatches.map((m) => deletePlannedMatch(m.mid)));

    // Group names in KO seed order (what the organiser arranged)
    const orderedGroupNames = koSeedGroups.map(([, g]) => g.name);

    const result = await generateCombinedKnockout({
      tournamentKey: tournament.key,
      tournamentName: tournament.name,
      groups: localGroups,
      groupCount: sortedGroups.length,
      groupNames: orderedGroupNames,
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
    if (isDummy(id)) return `Dummy ${id.replace('dummy-', '')}`;
    return players.find((p) => p.id === id)?.canonicalName ?? id;
  }

  function removeDummyFromGroups(dummyId: string) {
    // Remove from group if assigned
    for (const gKey of Object.keys(localGroups)) {
      if (localGroups[gKey]!.playerIds.includes(dummyId)) {
        localGroups[gKey] = {
          ...localGroups[gKey]!,
          playerIds: localGroups[gKey]!.playerIds.filter((id) => id !== dummyId),
        };
        break;
      }
    }
    // Renumber: compact remaining dummies so there are no gaps
    const m = dummyId.match(/^dummy-(\d+)$/);
    if (m) {
      const removedN = parseInt(m[1]!, 10);
      // Shift down all dummy IDs > removedN in every group
      for (const gKey of Object.keys(localGroups)) {
        localGroups[gKey] = {
          ...localGroups[gKey]!,
          playerIds: localGroups[gKey]!.playerIds.map((id) => {
            const dm = id.match(/^dummy-(\d+)$/);
            if (dm && parseInt(dm[1]!, 10) > removedN) {
              return `dummy-${parseInt(dm[1]!, 10) - 1}`;
            }
            return id;
          }),
        };
      }
      // Shift preQualify IDs if any dummy was marked (renumber shifted dummies)
      const newPreQualified = new Set<string>();
      for (const pid of preQualified) {
        const pdm = pid.match(/^dummy-(\d+)$/);
        if (pid === dummyId) continue;
        if (pdm && parseInt(pdm[1]!, 10) > removedN) newPreQualified.add(`dummy-${parseInt(pdm[1]!, 10) - 1}`);
        else newPreQualified.add(pid);
      }
      preQualified = newPreQualified;
      dummyCount -= 1;
    }
    groupsDirty = true;
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
        initGroups();
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

    <!-- ─── Groups & Draw ─────────────────────────────────────────────────────── -->
    <div class="ls-body">
        {#if roundsStarted}
          <div class="draw-controls">
            <span class="draw-locked-hint">🔒 Rounds in progress — re-generate to update brackets</span>
          </div>
        {/if}

        <!-- 3-panel area: pools on left, groups on right -->
        <div class="draw-area">

          <!-- Left: pools column -->
          <div class="pools-col">
            <!-- Players pool — hidden when all assigned -->
            {#if unassignedPlayers.length > 0 && !roundsStarted}
              <div
                class="pool-pane"
                role="list"
                aria-label="Unassigned players"
                ondragover={(e) => e.preventDefault()}
                ondrop={() => onDrop('__unassigned__')}
              >
                <div class="pool-pane-header">
                  <span>Unassigned players</span>
                  <span class="pool-pane-count">{unassignedPlayers.length}</span>
                </div>
                <div class="pool-pane-scroll">
                  {#each unassignedPlayers as pid, i (pid)}
                    <div
                      class="player-chip"
                      draggable={true}
                      role="listitem"
                      ondragstart={(e) => onDragStart(e, '__unassigned__', i, playerName(pid))}
                    ><span class="chip-name">{playerName(pid)}</span></div>
                  {/each}
                </div>
              </div>
            {/if}

            <!-- Dummy pool — shown when any dummies exist and not started -->
            {#if !roundsStarted}
              <div
                class="pool-pane pool-pane-dummy"
                role="list"
                aria-label="Dummy slots"
                ondragover={(e) => e.preventDefault()}
                ondrop={() => onDrop('__dummies__')}
              >
                <div class="pool-pane-header">
                  <span>Dummies</span>
                  <div class="dummy-stepper">
                    <button
                      type="button"
                      class="dummy-stepper-btn"
                      aria-label="Remove dummy"
                      disabled={dummyCount <= 0}
                      onclick={() => { if (dummyCount > 0) removeDummyFromGroups(`dummy-${dummyCount}`); }}
                    >−</button>
                    <span class="dummy-stepper-val">{dummyCount}</span>
                    <button
                      type="button"
                      class="dummy-stepper-btn"
                      aria-label="Add dummy"
                      onclick={addDummy}
                    >+</button>
                  </div>
                </div>
                {#if dummyCount > 0}
                  <div class="pool-pane-scroll">
                    {#each unassignedDummies as did, i (did)}
                      <div
                        class="player-chip player-chip-dummy"
                        draggable={true}
                        role="listitem"
                        ondragstart={(e) => onDragStart(e, '__dummies__', i, playerName(did))}
                      >
                        <span class="chip-name">{playerName(did)}</span>
                      </div>
                    {/each}
                    {#if unassignedDummies.length === 0}
                      <div class="pool-empty">All dummies assigned</div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- Right: groups grid -->
          <div class="groups-scroll">
            <div class="groups-grid">
              {#each sortedGroups as [gKey, group] (gKey)}
                {@const status = groupMatchStatus(gKey, group.name)}
                {@const pqCount = group.playerIds.filter((pid) => preQualified.has(pid)).length}
                {@const byeCount = group.playerIds.length - pqCount}
                {@const r2SlotCount = byeCount + Math.floor(pqCount / 2)}
                {@const hasOdd = r2SlotCount % 2 !== 0 && group.playerIds.length > 1}
                {@const isEmpty = group.playerIds.length === 0}
                <div
                  class="group-col"
                  class:group-col-locked={roundsStarted}
                  class:group-col-done={roundsStarted && status.done}
                  class:group-col-warn={hasOdd && !roundsStarted}
                  role="list"
                  aria-label="Group {group.name}"
                  ondragover={roundsStarted ? undefined : (e) => e.preventDefault()}
                  ondrop={roundsStarted ? undefined : () => onDrop(gKey)}
                >
                  <div class="group-col-header">
                    <span class="group-col-name">{group.name}</span>
                    {#if hasOdd && !roundsStarted}
                      <span class="group-col-warn-icon" title="Odd number of players — one gets a bye">⚠</span>
                    {/if}
                    <div class="group-col-header-right">
                      {#if roundsStarted}
                        <span class="group-match-status" class:group-match-done={status.done}>{status.label}</span>
                      {:else}
                        <span class="group-count">{group.playerIds.length}</span>
                        {#if sortedGroups.length > 1}
                          <button
                            type="button"
                            class="group-remove-btn"
                            aria-label="Remove {group.name}"
                            title={isEmpty ? `Remove ${group.name}` : `Move players out of ${group.name} first`}
                            disabled={!isEmpty}
                            onclick={() => removeGroupByKey(gKey)}
                          >−</button>
                        {/if}
                      {/if}
                    </div>
                  </div>
                  {#each group.playerIds as pid, i (pid)}
                    {@const isPreQualify = preQualified.has(pid)}
                    <div
                      class="player-chip"
                      class:player-chip-locked={roundsStarted}
                      class:player-chip-dummy={isDummy(pid)}
                      class:player-chip-drop-above={dropTargetGroup === gKey && dropTargetIdx === i}
                      draggable={!roundsStarted}
                      role="listitem"
                      ondragstart={roundsStarted ? undefined : (e) => onDragStart(e, gKey, i, playerName(pid))}
                      ondragover={roundsStarted ? undefined : (e) => { e.preventDefault(); dropTargetGroup = gKey; dropTargetIdx = i; }}
                      ondragleave={roundsStarted ? undefined : () => { if (dropTargetGroup === gKey && dropTargetIdx === i) { dropTargetGroup = null; dropTargetIdx = null; } }}
                      ondrop={roundsStarted ? undefined : (e) => { e.stopPropagation(); onDrop(gKey, i); }}
                    >
                      <span class="chip-name">{playerName(pid)}</span>
                      {#if !roundsStarted}
                        <button
                          type="button"
                          class="prequalify-btn"
                          class:prequalify-active={isPreQualify}
                          aria-label="{isPreQualify ? 'Unmark' : 'Mark'} {playerName(pid)} as pre-qualifier"
                          title="{isPreQualify ? 'Pre-qualify Round 1 (click to unmark)' : 'Mark as pre-qualifier (plays Round 1)'}"
                          onclick={(e) => { e.stopPropagation(); togglePreQualify(pid); }}
                        >PQ</button>
                      {:else if isPreQualify}
                        <span class="prequalify-badge">PQ</span>
                      {/if}
                      {#if isDummy(pid) && !roundsStarted}
                        <button
                          type="button"
                          class="dummy-remove-btn"
                          aria-label="Remove {playerName(pid)}"
                          onclick={(e) => { e.stopPropagation(); removeDummyFromGroups(pid); }}
                        >×</button>
                      {/if}
                    </div>
                  {/each}
                  {#if group.playerIds.length === 0}
                    <div class="group-empty">Drop players here</div>
                  {/if}
                </div>
              {/each}

              <!-- Add group card — dashed, + in center -->
              {#if !roundsStarted}
                <button
                  type="button"
                  class="group-add-card"
                  aria-label="Add group"
                  onclick={addGroup}
                >
                  <span class="group-add-icon">+</span>
                  <span class="group-add-label">Add group</span>
                </button>
              {/if}
            </div>
            {#if removeGroupError}
              <p class="group-remove-error">{removeGroupError}</p>
            {/if}
          </div>

        </div><!-- /draw-area -->

      </div>

      <!-- ─── Combined Knockout seeding order (>1 group, not started) ──────────── -->
      {#if sortedGroups.length > 1 && !roundsStarted}
        <div class="ls-body stage2-section">
          <div class="stage2-header">
            <strong class="stage2-title">Combined Knockout seeding</strong>
            <span class="stage2-hint">Drag to reorder — top vs bottom, 2nd vs 3rd, etc.</span>
          </div>
          <div class="ko-seed-list">
            {#each koSeedGroups as [gKey, g], idx (gKey)}
              <div
                class="ko-seed-chip"
                class:ko-seed-drag-over={koDragOver === idx}
                draggable={true}
                role="listitem"
                ondragstart={() => onKODragStart(idx)}
                ondragover={(e) => onKODragOver(e, idx)}
                ondragleave={() => { if (koDragOver === idx) koDragOver = null; }}
                ondrop={() => onKODrop(idx)}
                ondragend={onKODragEnd}
              >
                <span class="ko-seed-rank">{idx + 1}</span>
                <span class="ko-seed-name">{g.name}</span>
                <span class="ko-seed-drag-handle">⠿</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}

      <!-- ─── Action buttons (always at card bottom) ───────────────────────────── -->
      {#if generateError}
        <p class="ls-error ls-error-footer">{generateError}</p>
      {/if}
      {#if generateResult}
        <div class="generate-result generate-result-footer">
          <strong>Phase 1 generated:</strong> {generateResult.matchesCreated} matches.
          {#if generateResult.errors.length > 0}
            <ul class="result-errors">
              {#each generateResult.errors as e}<li>{e}</li>{/each}
            </ul>
          {/if}
        </div>
      {/if}
      <div class="ls-actions ls-actions-footer">
        {#if generating}
          <div class="generating-indicator">
            <span class="spinner" aria-hidden="true"></span>
            <span>Generating brackets…</span>
          </div>
        {:else}
          {@const hasGroupRounds = (tournament.rounds ?? []).some((r) => / — /.test(r.name) && !/^KO —/.test(r.name))}
          {@const hasUnstartedRounds = (tournament.rounds ?? []).some((r) => / — /.test(r.name) && !/^KO —/.test(r.name) && !r.startedAt)}
          {#if hasGroupRounds}
            <button
              type="button"
              class="btn btn-secondary"
              onclick={lockAndGenerate}
              disabled={sortedGroups.length === 0}
            >Re-generate brackets</button>
            {#if hasUnstartedRounds}
              <button
                type="button"
                class="btn btn-primary"
                onclick={startAllGroupRounds}
                disabled={startingRounds}
              >{startingRounds ? 'Starting…' : '▶ Start first round'}</button>
            {/if}
          {:else}
            <button
              type="button"
              class="btn btn-primary"
              onclick={lockAndGenerate}
              disabled={sortedGroups.length === 0}
            >Generate brackets</button>
          {/if}
        {/if}
      </div>
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
    /* No max-height — overlay scrolls the whole card on small screens */
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

  .ls-body {
    padding: 1rem 1.25rem;
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

  /* 3-panel draw layout */
  .draw-area {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    min-height: 0;
  }
  .pools-col {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    flex-shrink: 0;
    width: 200px;
  }
  .pool-pane {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.5rem;
    background: rgba(255, 255, 255, 0.02);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .pool-pane-dummy {
    border-color: rgba(120, 180, 255, 0.25);
    background: rgba(80, 140, 240, 0.04);
  }
  .pool-pane-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.68rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent, #ffd54a);
    padding: 0.35rem 0.5rem 0.3rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }
  .pool-pane-dummy .pool-pane-header {
    color: rgba(120, 180, 255, 0.8);
  }
  .pool-pane-count {
    font-weight: 400;
    color: var(--muted, #9aa0a6);
    font-style: normal;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.68rem;
  }
  .pool-pane-scroll {
    overflow-y: auto;
    max-height: 320px; /* ~10 chips visible */
    padding: 0.35rem;
  }
  .pool-pane-dummy .pool-pane-scroll {
    max-height: 96px; /* ~3 dummies visible */
  }
  .pool-empty {
    font-size: 0.72rem;
    color: var(--muted, #9aa0a6);
    font-style: italic;
    padding: 0.25rem 0;
    text-align: center;
  }

  /* Groups scrollable area + grid */
  .groups-scroll {
    flex: 1;
    min-width: 0;
  }
  .groups-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  @media (max-width: 60rem) {
    .draw-area { flex-direction: column; }
    .pools-col { flex-direction: row; width: 100%; }
    .pool-pane { flex: 1; }
  }
  @media (max-width: 40rem) {
    .groups-grid { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 28rem) {
    .groups-grid { grid-template-columns: 1fr; }
    .pools-col { flex-direction: column; }
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
  .group-col-warn {
    border-color: rgba(248, 113, 113, 0.4);
  }
  .group-col-name {
    flex: 1;
    min-width: 0;
  }
  .group-col-warn-icon {
    color: #f87171;
    font-size: 0.85rem;
    margin: 0 0.2rem;
    flex-shrink: 0;
    cursor: help;
  }
  .group-remove-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--muted, #9aa0a6);
    border-radius: 3px;
    width: 18px;
    height: 18px;
    font-size: 0.9rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
    transition: all 0.15s;
  }
  .group-remove-btn:hover:not(:disabled) {
    background: rgba(248, 113, 113, 0.15);
    border-color: rgba(248, 113, 113, 0.5);
    color: #f87171;
  }
  .group-remove-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
  .group-remove-error {
    font-size: 0.75rem;
    color: #f87171;
    margin: 0.25rem 0 0.5rem;
  }

  /* Add-group dashed card */
  .group-add-card {
    border: 2px dashed rgba(255, 255, 255, 0.18);
    border-radius: 0.5rem;
    min-height: 4rem;
    background: transparent;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.2rem;
    color: rgba(255, 255, 255, 0.35);
    transition: all 0.18s;
    padding: 0.5rem;
  }
  .group-add-card:hover {
    border-color: rgba(255, 213, 74, 0.45);
    color: rgba(255, 213, 74, 0.7);
    background: rgba(255, 213, 74, 0.04);
  }
  .group-add-icon {
    font-size: 1.4rem;
    line-height: 1;
    font-weight: 300;
  }
  .group-add-label {
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  /* Dummy stepper in pool header */
  .dummy-stepper {
    display: flex;
    align-items: center;
    gap: 0.2rem;
    margin-left: auto;
  }
  .dummy-stepper-btn {
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.18);
    color: inherit;
    border-radius: 3px;
    width: 20px;
    height: 20px;
    font-size: 0.9rem;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .dummy-stepper-btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
  .dummy-stepper-btn:disabled { opacity: 0.3; cursor: default; }
  .dummy-stepper-val {
    min-width: 1.1rem;
    text-align: center;
    font-size: 0.8rem;
    font-weight: 700;
    color: rgba(160, 200, 255, 0.9);
  }

  .player-chip {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.3rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.8rem;
    margin-bottom: 0.25rem;
    cursor: grab;
    user-select: none;
    display: flex;
    align-items: center;
    gap: 3px;
    min-width: 0;
  }
  .player-chip:active { cursor: grabbing; }
  .player-chip:hover { background: rgba(255, 255, 255, 0.1); }
  .player-chip-locked {
    cursor: default;
    opacity: 0.85;
  }
  .player-chip-locked:active { cursor: default; }
  .player-chip-locked:hover { background: rgba(255, 255, 255, 0.06); }
  .player-chip-drop-above {
    border-top: 2px solid var(--accent, #ffd54a);
    margin-top: -1px;
  }
  .player-chip-dummy {
    border-color: rgba(120, 180, 255, 0.35);
    background: rgba(80, 140, 240, 0.1);
    color: rgba(160, 200, 255, 0.9);
    font-style: italic;
  }
  .chip-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .prequalify-btn {
    flex-shrink: 0;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.12);
    padding: 1px 6px;
    font-size: 0.65rem;
    font-weight: 600;
    line-height: 1.4;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.3);
    border-radius: 10px;
    letter-spacing: 0.03em;
    transition: all 0.15s;
    white-space: nowrap;
  }
  .prequalify-btn:hover {
    color: rgba(80, 200, 220, 0.9);
    border-color: rgba(80, 200, 220, 0.4);
    background: rgba(80, 200, 220, 0.07);
  }
  .prequalify-btn.prequalify-active {
    color: #fff;
    background: #2196a0;
    border-color: #2196a0;
  }
  .prequalify-badge {
    flex-shrink: 0;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    color: #fff;
    background: #2196a0;
    border: 1px solid #2196a0;
    border-radius: 10px;
    padding: 1px 6px;
    white-space: nowrap;
  }
  .dummy-remove-btn {
    flex-shrink: 0;
    padding: 0 4px;
    font-size: 0.8rem;
    line-height: 1;
    background: transparent;
    border: none;
    color: rgba(160, 200, 255, 0.5);
    cursor: pointer;
    border-radius: 3px;
  }
  .dummy-remove-btn:hover { color: #f88; background: rgba(255, 100, 100, 0.12); }
  .dummy-pool .group-col-header { color: rgba(120, 180, 255, 0.8); }
  .dummy-hint {
    font-size: 0.65rem;
    font-weight: 400;
    opacity: 0.7;
    margin-left: 4px;
  }
  .odd-warn {
    color: #f87171;
    font-size: 0.85rem;
    margin-left: 4px;
    flex-shrink: 0;
  }
  .add-dummy-btn {
    font-size: 0.75rem;
    padding: 0.2rem 0.6rem;
  }
  .group-empty {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    text-align: center;
    padding: 0.5rem 0;
    font-style: italic;
  }

  /* Bracket generation progress indicator */
  .generating-indicator {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.875rem;
    padding: 0.4rem 0;
  }
  .spinner {
    display: inline-block;
    width: 1rem;
    height: 1rem;
    border: 2px solid rgba(255, 255, 255, 0.15);
    border-top-color: var(--accent, #ffd54f);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* Actions */
  .ls-actions {
    margin-top: 1rem;
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .ls-actions-footer {
    margin-top: 0;
    padding: 1rem 1.25rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
  }
  .ls-error-footer {
    padding: 0.5rem 1.25rem 0;
  }
  .generate-result-footer {
    padding: 0.5rem 1.25rem 0;
    font-size: 0.85rem;
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
  /* Stage 2 */
  .stage2-section {
    border-top: 1px solid rgba(255,255,255,0.08);
    margin-top: 0.5rem;
  }
  .stage2-title {
    font-size: 0.9rem;
    color: var(--text, #e8eaed);
  }
  .stage2-hint {
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
  }
  .stage2-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 0.75rem;
    flex-wrap: wrap;
  }
  .ko-seed-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    max-width: 280px;
  }
  .ko-seed-chip {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.45rem 0.75rem;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1);
    border-radius: 6px;
    cursor: grab;
    user-select: none;
    transition: background 0.1s;
  }
  .ko-seed-chip:hover { background: rgba(255,255,255,0.08); }
  .ko-seed-drag-over {
    border-color: #e5a623;
    background: rgba(229,166,35,0.1);
  }
  .ko-seed-rank {
    font-size: 0.75rem;
    font-weight: 700;
    color: var(--muted, #9aa0a6);
    min-width: 1rem;
    text-align: center;
  }
  .ko-seed-name {
    font-size: 0.85rem;
    font-weight: 600;
    flex: 1;
  }
  .ko-seed-drag-handle {
    font-size: 1rem;
    color: var(--muted, #9aa0a6);
    opacity: 0.5;
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
    :root:not([data-theme="dark"]) .ls-actions-footer { border-top-color: rgba(0, 0, 0, 0.08); }
    :root:not([data-theme="dark"]) .ls-close:hover { color: #111; }
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
    :root:not([data-theme="dark"]) .player-chip-dummy { background: rgba(50, 100, 220, 0.08); border-color: rgba(50, 100, 220, 0.3); color: #2255bb; }
    :root:not([data-theme="dark"]) .dummy-remove-btn { color: rgba(50, 100, 220, 0.5); }
    :root:not([data-theme="dark"]) .dummy-pool .group-col-header { color: #2255bb; }
    :root:not([data-theme="dark"]) .prequalify-btn { color: rgba(0, 0, 0, 0.3); border-color: rgba(0, 0, 0, 0.15); }
    :root:not([data-theme="dark"]) .prequalify-btn:hover { color: #005f70; border-color: rgba(0, 120, 140, 0.5); background: rgba(0, 120, 140, 0.08); }
    :root:not([data-theme="dark"]) .prequalify-btn.prequalify-active { color: #fff; background: #007a8a; border-color: #007a8a; }
    :root:not([data-theme="dark"]) .prequalify-badge { color: #fff; background: #007a8a; border-color: #007a8a; }
    :root:not([data-theme="dark"]) .odd-warn { color: #dc2626; }
  }
  :root[data-theme="light"] .gko-card { background: #fff; border-color: rgba(0, 0, 0, 0.1); color: #111; }
  :root[data-theme="light"] .ls-header { border-bottom-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .ls-actions-footer { border-top-color: rgba(0, 0, 0, 0.08); }
  :root[data-theme="light"] .ls-close:hover { color: #111; }
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
  :root[data-theme="light"] .group-count-row { background: rgba(0, 0, 0, 0.04); border-color: rgba(0, 0, 0, 0.12); }
  :root[data-theme="light"] .stepper-btn { background: rgba(0, 0, 0, 0.06); border-color: rgba(0, 0, 0, 0.15); color: #111; }
  :root[data-theme="light"] .stepper-btn:hover:not(:disabled) { background: rgba(0, 0, 0, 0.12); }
  :root[data-theme="light"] .config-stale-banner { background: rgba(200, 130, 0, 0.1); border-color: rgba(200, 130, 0, 0.4); }
  :root[data-theme="light"] .stale-msg { color: #111; }
  :root[data-theme="light"] .player-chip-dummy { background: rgba(50, 100, 220, 0.08); border-color: rgba(50, 100, 220, 0.3); color: #2255bb; }
  :root[data-theme="light"] .dummy-remove-btn { color: rgba(50, 100, 220, 0.5); }
  :root[data-theme="light"] .dummy-pool .group-col-header { color: #2255bb; }
  :root[data-theme="light"] .prequalify-btn { color: rgba(0, 0, 0, 0.3); border-color: rgba(0, 0, 0, 0.15); }
  :root[data-theme="light"] .prequalify-btn:hover { color: #005f70; border-color: rgba(0, 120, 140, 0.5); background: rgba(0, 120, 140, 0.08); }
  :root[data-theme="light"] .prequalify-btn.prequalify-active { color: #fff; background: #007a8a; border-color: #007a8a; }
  :root[data-theme="light"] .prequalify-badge { color: #fff; background: #007a8a; border-color: #007a8a; }
  :root[data-theme="light"] .odd-warn { color: #dc2626; }
</style>
