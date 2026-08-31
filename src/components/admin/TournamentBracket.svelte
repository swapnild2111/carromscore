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
  type Suggestion = { id: string; name: string; country?: string };
  function suggestPlayers(query: string): Suggestion[] {
    // Read tick so the derivation re-runs on store updates.
    void identityTick;
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return loadAllPlayers()
      .filter((p) => p.canonicalName.toLowerCase().includes(q))
      .slice(0, 8)
      .map((p) => ({
        id: p.id,
        name: p.canonicalName,
        ...(p.country ? { country: p.country } : {}),
      }));
  }
  // Which of the four inputs' dropdown is currently open. Null = none.
  type PickerKey = 'aName' | 'a2Name' | 'bName' | 'b2Name';
  let openPicker = $state<PickerKey | null>(null);
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
  }

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
    if (!selectedRound) {
      inlineError = 'Pick a round first';
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

  function statusOf(m: PlannedMatch): 'planned' | 'claimed' {
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
      oninput={(e) => onNameInput(key, (e.currentTarget as HTMLInputElement).value)}
      onfocus={() => (openPicker = key)}
      onblur={() => setTimeout(() => { if (openPicker === key) openPicker = null; }, 200)}
    />
    {#if dropdownVisible}
      <ul class="suggest">
        {#each suggestions as p (p.id)}
          <li>
            <button
              type="button"
              onmousedown={(e) => e.preventDefault()}
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

        <div class="bracket-add">
          <!--
            Per-match mode toggle (v3.6.1). Defaults to the tournament's
            mode, but flippable per row so a mixed tournament (e.g. a
            singles league that runs one doubles exhibition match)
            doesn't need a second tournament tag.
          -->
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
          <div class="row-actions-top">
            <a
              class="print-link"
              href={`${import.meta.env.BASE_URL}print-bracket/?tournament=${encodeURIComponent(tournament.key)}&round=${encodeURIComponent(selectedRoundKey)}`}
              target="_blank"
              rel="noopener"
            >🖨 Print sheet for this round</a>
          </div>
          <div class="rowtable-wrap">
            <table class="rowtable">
              <thead>
                <tr>
                  <th class="col-num">#</th>
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
                    <td>
                      {m.aName}{#if m.a2Name} + {m.a2Name}{/if}
                    </td>
                    <td>
                      {m.bName}{#if m.b2Name} + {m.b2Name}{/if}
                    </td>
                    <td class="col-status">
                      {#if statusOf(m) === 'claimed'}
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
                      >🗑</button>
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
      <button type="button" class="cancel-btn" onclick={onClose}>Close</button>
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

  .mode-toggle {
    display: inline-flex;
    gap: 0.3rem;
    margin-bottom: 0.55rem;
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
  .suggest button:hover { background: #1c1c1c; }
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


  .row-del {
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.3);
    color: rgba(239, 83, 80, 0.8);
    padding: 0.25rem 0.5rem;
    border-radius: 0.3rem;
    cursor: pointer;
    font-size: 0.9rem;
  }
  .row-del:hover {
    background: rgba(239, 83, 80, 0.1);
    border-color: rgba(239, 83, 80, 0.5);
  }

  .row-actions-top {
    display: flex;
    justify-content: flex-end;
    margin: 0.4rem 0 0.4rem;
  }
  .print-link {
    display: inline-block;
    padding: 0.35rem 0.75rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.35);
    color: var(--accent, #ffd54a);
    border-radius: 0.4rem;
    text-decoration: none;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 700;
  }
  .print-link:hover {
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.55);
  }

  .footer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.9rem;
    margin-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
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
