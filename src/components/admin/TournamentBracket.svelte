<script lang="ts">
  /**
   * Tournament bracket admin modal (v3.6). Opened from the Edit
   * tournament dialog's section nav — see AdminTournaments.svelte.
   *
   * Purpose: let the tournament's organiser (or a super admin)
   * pre-create match slots for a round of a tournament. Each row
   * carries player names + optional resolved ids; the row renders
   * a QR code inline (encodes the score URL with ?planned=<mid>).
   * On match day the umpire scans, the score screen fetches the
   * planned record, prefills setup, and the umpire taps Start.
   *
   * Scope for v3.6: create + delete + inline QR + round switch.
   * No bracket topology (winnerAdvancesTo etc.), no bulk import,
   * no seeding tools. See docs/plan/tournament-brackets.md.
   */

  import { onMount } from 'svelte';
  import {
    createPlannedMatch,
    deletePlannedMatch,
    subscribePlannedByTournament,
    type PlannedMatch,
  } from '../../lib/planned';
  import type { Tournament, Round } from '../../lib/tournaments';
  import { loadAssignedPlayers } from '../../lib/tournaments';
  import { loadAll as loadAllPlayers, subscribeStore as subscribePlayerStore } from '../../lib/players';
  import { flagEmoji, countryName } from '../../lib/countries';

  interface Props {
    tournament: Tournament;
    /** All rounds for this tournament (already sorted by order). */
    rounds: Round[];
    /** uid of the caller — stamped on createdBy. */
    myUid: string;
    onClose: () => void;
  }
  const { tournament, rounds, myUid, onClose }: Props = $props();

  // Current round in the picker. Default to the first `open` round
  // if any, else the first round overall. When the tournament has
  // no rounds at all, we render an "add a round first" hint instead
  // of the bracket UI — planned matches without a round tag are
  // out of scope for v3.6.
  const initialRound = $derived<Round | null>(
    rounds.find((r) => r.state === 'open') ?? rounds[0] ?? null,
  );
  let selectedRoundKey = $state<string>(initialRound?.key ?? '');
  $effect(() => {
    if (!selectedRoundKey && initialRound) selectedRoundKey = initialRound.key;
  });
  const selectedRound = $derived<Round | null>(
    rounds.find((r) => r.key === selectedRoundKey) ?? null,
  );

  // Live subscription to /planned filtered by this tournament.
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsub: (() => void) | null = null;
  onMount(() => {
    (async () => {
      unsub = await subscribePlannedByTournament(tournament.key, (arr) => {
        plannedMatches = arr;
      });
    })();
    return () => {
      unsub?.();
    };
  });

  // Rows for the current round.
  const rowsForRound = $derived(
    plannedMatches
      .filter((m) => m.roundKey === selectedRoundKey)
      .sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0)),
  );

  // Add-row form state. Only appears when a round is selected.
  //
  // Per-match mode override (v3.6.1): the tournament default seeds the
  // toggle, but the organiser can flip a single row to the other mode
  // without changing the tournament-wide default. Useful for mixed
  // events (e.g. singles league + doubles knockout under one
  // tournament tag).
  const defaultMode = $derived<'singles' | 'doubles'>(
    tournament.defaults?.mode ?? 'singles',
  );
  let mode = $state<'singles' | 'doubles'>(defaultMode);
  $effect(() => {
    // Re-seed the toggle when the tournament's default changes (e.g.
    // organiser edits defaults in another tab). Only when the form is
    // empty — otherwise a mid-typing default change would wipe input.
    if (!addAName && !addA2Name && !addBName && !addB2Name) {
      mode = defaultMode;
    }
  });
  let addAName = $state<string>('');
  let addA2Name = $state<string>('');
  let addBName = $state<string>('');
  let addB2Name = $state<string>('');
  // Physical board number this match is scheduled on (1..99). Auto-
  // suggests as (max existing board in the tournament) + 1, so the
  // organiser filling out Round 1 sees Board 1, 2, 3… roll forward.
  // Then Round 2 Match 1 defaults back to Board 1 (highest board
  // currently on Round 2 is 0 → 1) — the organiser can override.
  let addBoard = $state<number>(1);
  let addBusy = $state(false);

  // ─── Player name autocomplete (v3.6.1) ─────────────────────────────
  // Reuses the /players Firebase identity store so bracket entry uses
  // the same roster the score-setup form autocompletes from. Subscribe
  // once on mount so newly-added players surface in the dropdown
  // without a modal reopen.
  //
  // Kept intentionally simpler than MatchSetup's picker: substring
  // match, top 8, no fuzzy-alias chip, no closed-tournament country
  // warnings. Organisers filling a bracket already know the roster;
  // they need speed of typing, not identity-mismatch guardrails.
  let identityTick = $state(0);
  onMount(() => {
    const unsubStore = subscribePlayerStore(() => {
      identityTick += 1;
    });
    return () => unsubStore();
  });

  // Assigned-player roster for invite-only tournaments. Empty set
  // when the tournament is open (roster gate disabled). Loaded once
  // on mount and refreshed if the tournament flips type in another
  // tab (defensively — actual re-open of the modal is the common
  // path, so this stays cheap).
  let assignedPlayerIds = $state<Set<string>>(new Set());
  const isInviteOnly = $derived<boolean>(tournament.type === 'closed');
  onMount(() => {
    if (!isInviteOnly) return;
    void loadAssignedPlayers(tournament.key).then((set) => {
      assignedPlayerIds = set;
    }).catch(() => {
      // Silent — an empty set means "nothing assigned" from the UI's
      // POV, which is safer than pretending everyone is assigned.
      assignedPlayerIds = new Set();
    });
  });
  type Suggestion = { id: string; name: string; country?: string };
  function suggestPlayers(query: string): Suggestion[] {
    // Read tick so the derivation re-runs on store updates.
    void identityTick;
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Invite-only: only suggest players who are on the tournament's
    // roster. Free-text is still allowed in the input (so the
    // organiser can type ahead of an assignment), but the add-row
    // guard below will reject unresolved / off-roster picks.
    const pool = loadAllPlayers().filter((p) => {
      if (!p.canonicalName.toLowerCase().includes(q)) return false;
      if (isInviteOnly && !assignedPlayerIds.has(p.id)) return false;
      return true;
    });
    return pool.slice(0, 8).map((p) => ({
      id: p.id,
      name: p.canonicalName,
      ...(p.country ? { country: p.country } : {}),
    }));
  }
  // Which of the four inputs' dropdown is currently open. Null = none.
  type PickerKey = 'aName' | 'a2Name' | 'bName' | 'b2Name';
  let openPicker = $state<PickerKey | null>(null);
  // Keyboard-highlighted suggestion index (-1 = none).
  let highlightedIdx = $state<number>(-1);
  // When true, suppress the blur-close so keyboard interactions don't
  // accidentally dismiss the dropdown mid-navigation.
  let suppressBlurClose = false;
  function setField(key: PickerKey, value: string) {
    if (key === 'aName') addAName = value;
    else if (key === 'a2Name') addA2Name = value;
    else if (key === 'bName') addBName = value;
    else if (key === 'b2Name') addB2Name = value;
  }
  function getField(key: PickerKey): string {
    if (key === 'aName') return addAName;
    if (key === 'a2Name') return addA2Name;
    if (key === 'bName') return addBName;
    return addB2Name;
  }
  // Resolved player id per input, captured when a suggestion is
  // tapped or when the typed text is an exact-normalised match. Sent
  // with the planned match so post-scan setup can render country
  // flags on first paint without re-resolving.
  let resolvedIds = $state<Record<PickerKey, string | null>>({
    aName: null,
    a2Name: null,
    bName: null,
    b2Name: null,
  });
  function pickSuggestion(key: PickerKey, s: Suggestion) {
    setField(key, s.name);
    resolvedIds = { ...resolvedIds, [key]: s.id };
    openPicker = null;
  }
  function onNameInput(key: PickerKey, value: string) {
    setField(key, value);
    // Clear the resolved id — the user is editing, so any stale
    // resolution is invalid. If the new value happens to be an exact
    // match, auto-resolve to that player id.
    const norm = value.trim().toLowerCase();
    let hit: string | null = null;
    if (norm) {
      for (const p of loadAllPlayers()) {
        if (p.canonicalName.trim().toLowerCase() === norm) {
          hit = p.id;
          break;
        }
      }
    }
    resolvedIds = { ...resolvedIds, [key]: hit };
    openPicker = key;
  }
  function onPickerKeydown(key: PickerKey, e: KeyboardEvent) {
    const suggestions = suggestPlayers(getField(key));
    const open = openPicker === key && suggestions.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suppressBlurClose = true;
      if (!open) { openPicker = key; highlightedIdx = 0; }
      else highlightedIdx = Math.min(highlightedIdx + 1, suggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suppressBlurClose = true;
      highlightedIdx = Math.max(highlightedIdx - 1, 0);
    } else if ((e.key === 'Enter' || e.key === ' ') && open && highlightedIdx >= 0) {
      e.preventDefault();
      suppressBlurClose = true;
      const s = suggestions[highlightedIdx];
      if (s) { pickSuggestion(key, s); suppressBlurClose = false; }
    } else if (e.key === 'Escape') {
      suppressBlurClose = false;
      openPicker = null;
      highlightedIdx = -1;
    } else if (e.key === 'Tab') {
      // Tab: if a suggestion is highlighted, select it first then move focus.
      if (open && highlightedIdx >= 0) {
        e.preventDefault();
        suppressBlurClose = true;
        const s = suggestions[highlightedIdx];
        if (s) { pickSuggestion(key, s); suppressBlurClose = false; }
      } else {
        suppressBlurClose = false;
        openPicker = null;
        highlightedIdx = -1;
      }
    } else {
      // Any other key: reset highlight to first item when dropdown is open.
      if (open) highlightedIdx = 0;
    }
  }

  let clearBusy = $state(false);
  let clearConfirm = $state(false);
  async function clearAllPlanned() {
    if (!clearConfirm) { clearConfirm = true; return; }
    clearBusy = true;
    clearConfirm = false;
    try {
      const [{ getDatabase, ref, get }, { firebaseApp }] = await Promise.all([
        import('firebase/database'),
        import('../../lib/firebase'),
      ]);
      const db = getDatabase(firebaseApp());
      const snap = await get(ref(db, 'planned'));
      const raw = snap.val() as Record<string, { tournamentKey?: string }> | null;
      let deleted = 0;
      if (raw) {
        for (const [mid, v] of Object.entries(raw)) {
          if (v?.tournamentKey === tournament.key) {
            await deletePlannedMatch(mid);
            deleted++;
          }
        }
      }
      flash(`Cleared ${deleted} planned record${deleted === 1 ? '' : 's'}`);
    } catch {
      inlineError = 'Clear failed — check permissions';
    } finally {
      clearBusy = false;
    }
  }

  let inlineError = $state<string | null>(null);
  let flashOk = $state<string | null>(null);
  let flashTimer: number | null = null;
  function flash(msg: string) {
    flashOk = msg;
    if (flashTimer) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => (flashOk = null), 1800);
  }

  function resetAddForm() {
    addAName = '';
    addA2Name = '';
    addBName = '';
    addB2Name = '';
    resolvedIds = { aName: null, a2Name: null, bName: null, b2Name: null };
    mode = defaultMode;
    // Auto-suggest next board number for this round: highest board
    // used in the current round + 1. If no matches yet, start at 1.
    // Organiser can override before adding.
    const maxBoardInRound = rowsForRound.reduce(
      (m, r) => (r.board && r.board > m ? r.board : m),
      0,
    );
    addBoard = Math.max(1, maxBoardInRound + 1);
  }

  // Also seed addBoard when the round changes / rows arrive so a
  // brand-new modal opens with the right suggestion.
  $effect(() => {
    if (!addAName && !addA2Name && !addBName && !addB2Name) {
      const maxBoardInRound = rowsForRound.reduce(
        (m, r) => (r.board && r.board > m ? r.board : m),
        0,
      );
      addBoard = Math.max(1, maxBoardInRound + 1);
    }
  });

  async function addRow() {
    inlineError = null;
    const aName = addAName.trim();
    const bName = addBName.trim();
    if (!aName || !bName) {
      inlineError = 'Both sides need a name';
      return;
    }
    if (mode === 'doubles' && (!addA2Name.trim() || !addB2Name.trim())) {
      inlineError = 'Doubles needs two players per side';
      return;
    }
    // Invite-only roster gate: every named side must resolve to an
    // assigned player. Free-text (unresolved) or a resolved-but-not-
    // assigned player is rejected here rather than at scan-time —
    // catching the mistake at bracket build time saves the organiser
    // a re-print when they discover it on match day.
    if (isInviteOnly) {
      const offenders: string[] = [];
      const check = (label: string, name: string, key: PickerKey, active: boolean) => {
        if (!active) return;
        if (!name.trim()) return; // covered by name-required checks above
        const rid = resolvedIds[key];
        if (!rid) offenders.push(`${label} (${name.trim()}) — pick from suggestions`);
        else if (!assignedPlayerIds.has(rid)) offenders.push(`${label} (${name.trim()}) — not assigned to this tournament`);
      };
      check('Side A', addAName, 'aName', true);
      check('Side A partner', addA2Name, 'a2Name', mode === 'doubles');
      check('Side B', addBName, 'bName', true);
      check('Side B partner', addB2Name, 'b2Name', mode === 'doubles');
      if (offenders.length > 0) {
        inlineError = `Invite-only tournament: ${offenders.join('; ')}. Add them to the roster first via the tournament's Players button.`;
        return;
      }
    }
    if (!selectedRound) {
      inlineError = 'Pick a round first';
      return;
    }
    const board = Math.floor(addBoard);
    if (!Number.isFinite(board) || board < 1 || board > 99) {
      inlineError = 'Board number must be between 1 and 99';
      return;
    }
    // Duplicate board check inside the current round: two matches
    // both assigned to Board 3 in Round 1 would leave the QR scanner
    // ambiguous. Auto-advance would pick the lowest matchOrder, but
    // that's a surprise — flag it here instead.
    const conflict = rowsForRound.find((r) => r.board === board);
    if (conflict) {
      inlineError = `Board ${board} already has a match in ${selectedRound.name} (${conflict.aName} vs ${conflict.bName}). Delete it first or pick another board.`;
      return;
    }
    addBusy = true;
    const nextOrder = (rowsForRound[rowsForRound.length - 1]?.matchOrder ?? 0) + 1;
    const outcome = await createPlannedMatch({
      mode,
      tournament: tournament.name,
      tournamentKey: tournament.key,
      round: selectedRound.name,
      roundKey: selectedRound.key,
      matchOrder: nextOrder,
      board,
      aName,
      a2Name: mode === 'doubles' ? addA2Name.trim() : undefined,
      bName,
      b2Name: mode === 'doubles' ? addB2Name.trim() : undefined,
      ...(resolvedIds.aName ? { aResolvedId: resolvedIds.aName } : {}),
      ...(mode === 'doubles' && resolvedIds.a2Name
        ? { a2ResolvedId: resolvedIds.a2Name }
        : {}),
      ...(resolvedIds.bName ? { bResolvedId: resolvedIds.bName } : {}),
      ...(mode === 'doubles' && resolvedIds.b2Name
        ? { b2ResolvedId: resolvedIds.b2Name }
        : {}),
      cfg: {
        ...(tournament.defaults?.bestOf !== undefined
          ? { bestOf: tournament.defaults.bestOf }
          : {}),
        ...(tournament.defaults?.pointsTarget !== undefined
          ? { pointsTarget: tournament.defaults.pointsTarget }
          : {}),
        ...(tournament.defaults?.maxBoards !== undefined
          ? { maxBoards: tournament.defaults.maxBoards }
          : {}),
      },
      createdBy: myUid,
    });
    addBusy = false;
    if (outcome.ok) {
      resetAddForm();
      flash('Match added');
    } else {
      inlineError = outcome.error;
    }
  }

  async function deleteRow(m: PlannedMatch) {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete this planned match?\n${m.aName} vs ${m.bName}`)) return;
    const outcome = await deletePlannedMatch(m.mid);
    if (!outcome.ok) inlineError = outcome.error;
    else flash('Match removed');
  }

  function statusOf(m: PlannedMatch): 'planned' | 'claimed' | 'complete' {
    if (m.completedAt) return 'complete';
    return m.claimedBy ? 'claimed' : 'planned';
  }

  function claimAge(m: PlannedMatch): string {
    if (!m.claimedAt) return '';
    const diff = Date.now() - m.claimedAt;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ago`;
  }
</script>

{#snippet pickerLabel(key: PickerKey, label: string)}
  {@const typed = getField(key)}
  {@const suggestions = suggestPlayers(typed)}
  {@const dropdownVisible = openPicker === key && suggestions.length > 0}
  <label class="picker">
    <span>{label}</span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Player name"
      value={typed}
      maxlength="80"
      disabled={addBusy}
      role="combobox"
      aria-expanded={dropdownVisible}
      aria-autocomplete="list"
      aria-activedescendant={dropdownVisible && highlightedIdx >= 0 ? `sug-${key}-${highlightedIdx}` : undefined}
      oninput={(e) => { highlightedIdx = 0; onNameInput(key, (e.currentTarget as HTMLInputElement).value); }}
      onfocus={() => { openPicker = key; highlightedIdx = -1; }}
      onblur={() => setTimeout(() => { if (!suppressBlurClose && openPicker === key) { openPicker = null; highlightedIdx = -1; } suppressBlurClose = false; }, 200)}
      onkeydown={(e) => onPickerKeydown(key, e)}
    />
    {#if dropdownVisible}
      <ul class="suggest" role="listbox">
        {#each suggestions as p, i (p.id)}
          <li role="option" aria-selected={i === highlightedIdx}>
            <button
              id="sug-{key}-{i}"
              type="button"
              class:suggest-highlighted={i === highlightedIdx}
              onmousedown={(e) => e.preventDefault()}
              onmouseenter={() => (highlightedIdx = i)}
              onclick={() => pickSuggestion(key, p)}
            >
              <span class="pname">{p.name}</span>
              {#if p.country && p.country !== 'Unknown'}
                <span class="pcountry" title={countryName(p.country)} aria-hidden="true">
                  {#if flagEmoji(p.country)}{flagEmoji(p.country)}{/if}
                  {countryName(p.country)}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </label>
{/snippet}

<div class="bracket-backdrop" role="dialog" aria-modal="true" aria-labelledby="bracket-title">
  <div class="bracket-card">
    <button
      type="button"
      class="bracket-close"
      onclick={onClose}
      aria-label="Close bracket"
    >✕</button>
    <h3 id="bracket-title">Bracket — {tournament.name}</h3>

    {#if rounds.length === 0}
      <p class="hint">Add rounds to this tournament first — the bracket
      needs to know which round each match belongs to.</p>
    {:else}
      {#if rounds.length <= 5}
        <div class="round-nav" role="group" aria-label="Select round">
          {#each rounds as r (r.key)}
            <button
              type="button"
              class="round-chip"
              class:round-chip-on={r.key === selectedRoundKey}
              class:round-chip-closed={r.state === 'closed'}
              onclick={() => (selectedRoundKey = r.key)}
            >{r.name}{r.state === 'closed' ? ' · closed' : ''}</button>
          {/each}
        </div>
      {:else}
        <div class="round-nav round-nav-select">
          <select
            class="round-select"
            value={selectedRoundKey}
            onchange={(e) => (selectedRoundKey = (e.currentTarget as HTMLSelectElement).value)}
            aria-label="Select round"
          >
            {#each rounds as r (r.key)}
              <option value={r.key}>{r.name}{r.state === 'closed' ? ' · closed' : ''}</option>
            {/each}
          </select>
        </div>
      {/if}

      {#if selectedRound}
        <p class="hint">
          Default mode: <strong>{defaultMode}</strong>{#if defaultMode !== mode} (this match: <strong>{mode}</strong>){/if}.
          {#if tournament.defaults?.bestOf || tournament.defaults?.pointsTarget || tournament.defaults?.maxBoards}
            Config:
            {#if tournament.defaults?.bestOf}bo{tournament.defaults.bestOf}{/if}
            {#if tournament.defaults?.pointsTarget}, target {tournament.defaults.pointsTarget}{/if}
            {#if tournament.defaults?.maxBoards}, max {tournament.defaults.maxBoards} boards{/if}.
          {/if}
        </p>

        {#if isInviteOnly}
          <p class="invite-hint" role="note">
            <span aria-hidden="true">🔒</span>
            Invite-only tournament — only players on the roster
            ({assignedPlayerIds.size} assigned) can be added to the bracket.
            {#if assignedPlayerIds.size === 0}
              Nobody assigned yet: use this tournament's <strong>Players</strong> button first.
            {/if}
          </p>
        {/if}

        <div class="bracket-add">
          <!--
            Per-match mode toggle (v3.6.1). Defaults to the tournament's
            mode, but flippable per row so a mixed tournament (e.g. a
            singles league that runs one doubles exhibition match)
            doesn't need a second tournament tag.
          -->
          <div class="mode-and-board">
            <div class="mode-toggle" role="group" aria-label="Match mode">
              <button
                type="button"
                class="mode-chip"
                class:mode-chip-on={mode === 'singles'}
                onclick={() => (mode = 'singles')}
                disabled={addBusy}
              >Singles</button>
              <button
                type="button"
                class="mode-chip"
                class:mode-chip-on={mode === 'doubles'}
                onclick={() => (mode = 'doubles')}
                disabled={addBusy}
              >Doubles</button>
            </div>
            <label class="board-picker">
              <span>Board</span>
              <input
                type="number"
                min="1"
                max="99"
                step="1"
                bind:value={addBoard}
                disabled={addBusy}
              />
            </label>
          </div>

          <div class="add-grid" class:add-grid-doubles={mode === 'doubles'}>
            {@render pickerLabel('aName', mode === 'doubles' ? 'Side A — player 1' : 'Side A')}
            {#if mode === 'doubles'}
              {@render pickerLabel('a2Name', 'Side A — player 2')}
            {/if}
            {@render pickerLabel('bName', mode === 'doubles' ? 'Side B — player 1' : 'Side B')}
            {#if mode === 'doubles'}
              {@render pickerLabel('b2Name', 'Side B — player 2')}
            {/if}
          </div>
          <button
            type="button"
            class="add-btn"
            onclick={addRow}
            disabled={addBusy}
          >+ Add match</button>
        </div>

        {#if inlineError}<p class="inline-err">{inlineError}</p>{/if}
        {#if flashOk}<p class="inline-ok">{flashOk}</p>{/if}

        {#if rowsForRound.length === 0}
          <p class="empty">No planned matches in this round yet.</p>
        {:else}
          <!--
            v3.6.1: 'Print' moved to a dedicated printer-icon button
            on the Tournaments row (AdminTournaments.svelte). Rationale:
            printing produces the tournament PACK — cover sheet + board
            QR stickers — which is a tournament-level artefact, not a
            per-round one.
          -->
          <div class="rowtable-wrap">
            <table class="rowtable">
              <thead>
                <tr>
                  <th class="col-num">#</th>
                  <th class="col-board">Board</th>
                  <th>Side A</th>
                  <th>Side B</th>
                  <th class="col-status">Status</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                {#each rowsForRound as m (m.mid)}
                  <tr>
                    <td class="col-num">{m.matchOrder ?? '—'}</td>
                    <td class="col-board">
                      {#if m.board}
                        <span class="board-badge">B{m.board}</span>
                      {:else}
                        <span class="board-missing" title="No board assigned — this match won't be reachable by QR scan">—</span>
                      {/if}
                    </td>
                    <td>
                      {m.aName}{#if m.a2Name} + {m.a2Name}{/if}
                    </td>
                    <td>
                      {m.bName}{#if m.b2Name} + {m.b2Name}{/if}
                    </td>
                    <td class="col-status">
                      {#if statusOf(m) === 'complete'}
                        {@const r = m.result}
                        <span class="pill pill-complete" title="Match complete">
                          {#if r}
                            {r.winner === 'a' ? m.aName.split(' ')[0] : r.winner === 'b' ? m.bName.split(' ')[0] : 'Draw'} · {r.setsA}–{r.setsB}
                          {:else}
                            done
                          {/if}
                        </span>
                      {:else if statusOf(m) === 'claimed'}
                        <span class="pill pill-claimed" title="Being scored right now">
                          scoring · {claimAge(m)}
                        </span>
                      {:else}
                        <span class="pill pill-planned">ready</span>
                      {/if}
                    </td>
                    <td class="col-actions">
                      <button
                        type="button"
                        class="row-del"
                        onclick={() => deleteRow(m)}
                        aria-label="Delete match"
                        title="Delete match"
                      ><svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    {/if}

    <div class="footer-actions">
      <button
        type="button"
        class="clear-bracket-btn"
        class:clear-bracket-confirm={clearConfirm}
        onclick={clearAllPlanned}
        disabled={clearBusy}
        title="Delete all planned records for this tournament (use to fix stale bracket counts)"
      >
        {#if clearBusy}Clearing…{:else if clearConfirm}Tap again to confirm{:else}Clear all bracket records{/if}
      </button>
      <button type="button" class="cancel-btn" onclick={() => { clearConfirm = false; onClose(); }}>Close</button>
    </div>
  </div>

</div>

<style>
  .bracket-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    /* Sits ABOVE the Edit tournament dialog (z-index 400 in
       AdminTournaments) since Bracket is opened FROM that dialog
       and must overlay it. Reported 2026-08-30. */
    z-index: 500;
    padding: 1rem;
  }
  .bracket-card {
    position: relative;
    background: #0f0f0f;
    border: 1px solid rgba(255, 213, 74, 0.5);
    border-radius: 0.8rem;
    padding: 1.25rem 1.25rem 1rem;
    width: min(48rem, 100%);
    max-height: 90dvh;
    overflow-y: auto;
    box-shadow: 0 0 32px rgba(255, 213, 74, 0.16),
                0 18px 60px rgba(0, 0, 0, 0.75);
  }
  .bracket-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background: transparent;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 1.2rem;
    padding: 0.4rem 0.6rem;
    cursor: pointer;
  }
  h3 {
    margin: 0 0 0.75rem;
    color: var(--accent, #ffd54a);
    font-size: 1.1rem;
    padding-right: 2rem;
  }
  .hint {
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    margin: 0.4rem 0 0.7rem;
  }
  /* Invite-only banner above the add form. Amber tint so the
     organiser notices before typing off-roster names. */
  .invite-hint {
    margin: 0 0 0.7rem;
    padding: 0.45rem 0.7rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.35);
    color: var(--accent, #ffd54a);
    border-radius: 0.4rem;
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .invite-hint strong { color: var(--accent, #ffd54a); }
  .round-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.5rem 0 0.75rem;
  }
  .round-chip {
    padding: 0.3rem 0.7rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--muted, #9aa0a6);
    border-radius: 999px;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
    font-family: inherit;
  }
  .round-chip:hover { color: var(--fg, #f5f5f5); }
  .round-chip-on {
    background: rgba(255, 213, 74, 0.14);
    border-color: rgba(255, 213, 74, 0.55);
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }
  .round-chip-closed {
    opacity: 0.7;
    font-style: italic;
  }
  .round-nav-select {
    display: flex;
    align-items: center;
  }
  .round-select {
    padding: 0.3rem 2rem 0.3rem 0.75rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--fg, #f5f5f5);
    border-radius: 0.45rem;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%239aa0a6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.65rem center;
    min-width: 12rem;
    max-width: 22rem;
  }
  .round-select:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.55);
  }

  .bracket-add {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.55rem;
    padding: 0.8rem;
    margin: 0.6rem 0 0.9rem;
  }
  .add-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }
  .add-grid-doubles {
    grid-template-columns: 1fr 1fr;
  }
  /* Narrow phones (~≤ 400 px inside the modal after padding) — go
     single-column so the autocomplete dropdown has room to render
     without spilling out of the modal. */
  @media (max-width: 32rem) {
    .add-grid, .add-grid-doubles {
      grid-template-columns: 1fr;
    }
  }
  .add-grid label, .picker {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
    position: relative;
  }
  .add-grid input {
    padding: 0.4rem 0.55rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.35rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.9rem;
  }
  .add-grid input:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .add-btn {
    padding: 0.45rem 0.9rem;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
    border-radius: 0.4rem;
    font: inherit;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    font-family: inherit;
  }
  .add-btn:hover { background: rgba(255, 213, 74, 0.24); }
  .add-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Mode toggle + board number sit on the same row above the name
     fields, since both are per-match knobs the organiser chooses in
     the same breath. On narrow phones the block wraps naturally. */
  .mode-and-board {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.7rem;
    margin-bottom: 0.6rem;
  }
  .board-picker {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
  }
  .board-picker input {
    width: 4rem;
    padding: 0.3rem 0.4rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.35rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.9rem;
  }
  .board-picker input:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .col-board { width: 4rem; text-align: center; }
  .board-badge {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    background: rgba(255, 213, 74, 0.1);
    border: 1px solid rgba(255, 213, 74, 0.4);
    color: var(--accent, #ffd54a);
    border-radius: 0.35rem;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .board-missing {
    color: rgba(239, 83, 80, 0.75);
    font-size: 0.85rem;
    cursor: help;
  }

  .mode-toggle {
    display: inline-flex;
    gap: 0.3rem;
    margin-bottom: 0;
  }
  .mode-chip {
    padding: 0.3rem 0.8rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: var(--muted, #9aa0a6);
    border-radius: 999px;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    font-family: inherit;
  }
  .mode-chip:hover { color: var(--fg, #f5f5f5); }
  .mode-chip-on {
    background: rgba(255, 213, 74, 0.14);
    border-color: rgba(255, 213, 74, 0.55);
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }
  .mode-chip:disabled { opacity: 0.5; cursor: not-allowed; }

  .picker input {
    padding: 0.4rem 0.55rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 0.35rem;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.9rem;
  }
  .picker input:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }

  /* Dropdown of matching players. Absolutely positioned under the
     input so it floats above the next form row instead of pushing
     the layout down. Same visual language as MatchSetup's picker. */
  .suggest {
    position: absolute;
    left: 0;
    right: 0;
    top: 100%;
    z-index: 5;
    list-style: none;
    margin: 0.2rem 0 0;
    padding: 0.2rem 0;
    background: #141414;
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.4rem;
    max-height: 14rem;
    overflow-y: auto;
    box-shadow: 0 10px 32px rgba(0, 0, 0, 0.7);
  }
  .suggest li { margin: 0; padding: 0; }
  .suggest button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.6rem;
    width: 100%;
    padding: 0.4rem 0.6rem;
    background: transparent;
    border: 0;
    color: var(--fg, #f5f5f5);
    font: inherit;
    font-size: 0.88rem;
    text-align: left;
    cursor: pointer;
    font-family: inherit;
  }
  .suggest button:hover,
  .suggest button.suggest-highlighted { background: #1c1c1c; outline: 2px solid rgba(255, 213, 74, 0.5); outline-offset: -2px; }
  .pname { flex: 1; }
  .pcountry {
    color: var(--muted, #9aa0a6);
    font-size: 0.78rem;
    white-space: nowrap;
  }

  .inline-err {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    background: rgba(239, 83, 80, 0.12);
    border: 1px solid rgba(239, 83, 80, 0.4);
    color: rgba(239, 83, 80, 0.95);
    border-radius: 0.4rem;
    font-size: 0.85rem;
  }
  .inline-ok {
    margin: 0.5rem 0;
    padding: 0.5rem 0.75rem;
    background: rgba(76, 175, 80, 0.14);
    border: 1px solid rgba(76, 175, 80, 0.45);
    color: #a6dfa9;
    border-radius: 0.4rem;
    font-size: 0.85rem;
  }
  .empty {
    color: var(--muted, #9aa0a6);
    font-size: 0.9rem;
    text-align: center;
    padding: 1rem 0;
  }

  .rowtable-wrap {
    overflow-x: auto;
    margin: 0.5rem 0;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
  }
  .rowtable {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.86rem;
  }
  .rowtable th, .rowtable td {
    padding: 0.5rem 0.6rem;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    /* Allow long player names to wrap to a second line instead of
       forcing horizontal scroll on narrow phones. The utility
       columns (#, status, QR, actions) keep nowrap via their own
       column-specific rules below. Reported 2026-08-30. */
    word-break: break-word;
    overflow-wrap: anywhere;
  }
  .rowtable .col-num,
  .rowtable .col-board,
  .rowtable .col-status,
  .rowtable .col-actions { white-space: nowrap; }
  .rowtable tr:last-child td { border-bottom: 0; }
  .rowtable th {
    background: rgba(255, 255, 255, 0.04);
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .col-num { width: 2rem; text-align: center; color: var(--muted, #9aa0a6); }
  .col-status { width: 8rem; }
  .col-actions { width: 2.5rem; text-align: right; }

  .pill {
    display: inline-block;
    padding: 0.15rem 0.5rem;
    font-size: 0.72rem;
    font-weight: 700;
    border-radius: 0.3rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .pill-planned {
    background: rgba(255, 213, 74, 0.1);
    border: 1px solid rgba(255, 213, 74, 0.35);
    color: var(--accent, #ffd54a);
  }
  .pill-claimed {
    background: rgba(76, 175, 80, 0.14);
    border: 1px solid rgba(76, 175, 80, 0.45);
    color: #a6dfa9;
    text-transform: none;
    letter-spacing: 0;
  }
  .pill-complete {
    background: rgba(100, 180, 230, 0.12);
    border: 1px solid rgba(100, 180, 230, 0.35);
    color: #7ec8e3;
    text-transform: none;
    letter-spacing: 0;
  }


  .row-del {
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.3);
    color: rgba(239, 83, 80, 0.8);
    padding: 0.3rem 0.5rem;
    border-radius: 0.3rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .row-del:hover {
    background: rgba(239, 83, 80, 0.1);
    border-color: rgba(239, 83, 80, 0.5);
  }


  .footer-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.5rem;
    padding-top: 0.9rem;
    margin-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    flex-wrap: wrap;
  }
  .clear-bracket-btn {
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.35);
    color: #ef5350;
    padding: 0.4rem 0.9rem;
    border-radius: 0.4rem;
    font: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }
  .clear-bracket-btn:hover { background: rgba(239, 83, 80, 0.07); }
  .clear-bracket-btn.clear-bracket-confirm {
    border-color: rgba(239, 83, 80, 0.7);
    background: rgba(239, 83, 80, 0.12);
    font-weight: 700;
  }
  .clear-bracket-btn:disabled { opacity: 0.5; cursor: default; }
  .cancel-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: var(--fg, #f5f5f5);
    padding: 0.4rem 0.9rem;
    border-radius: 0.4rem;
    font: inherit;
    cursor: pointer;
    font-family: inherit;
  }
  .cancel-btn:hover { background: rgba(255, 255, 255, 0.05); }
</style>
