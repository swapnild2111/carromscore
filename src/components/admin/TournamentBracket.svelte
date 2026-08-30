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
  import { qrToDataUri } from '../../lib/qrcode';
  import type { Tournament, Round } from '../../lib/tournaments';

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
  const mode = $derived<'singles' | 'doubles'>(
    tournament.defaults?.mode ?? 'singles',
  );
  let addAName = $state<string>('');
  let addA2Name = $state<string>('');
  let addBName = $state<string>('');
  let addB2Name = $state<string>('');
  let addBusy = $state(false);
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

  // QR generation. Cached per mid so we don't regenerate every render.
  // Map: mid → dataURI. Kept as $state so the template reruns when a
  // new QR resolves.
  let qrByMid = $state<Record<string, string>>({});
  const scoreBase = (() => {
    if (typeof window === 'undefined') return '';
    // Use current origin + BASE_URL so QR works on beta/production
    // without hard-coding a host.
    const base = import.meta.env.BASE_URL ?? '/';
    return `${window.location.origin}${base}score/`;
  })();
  $effect(() => {
    // Generate QR for any row that doesn't have one yet. Fires on
    // rows list change; existing entries stay cached.
    for (const m of rowsForRound) {
      if (qrByMid[m.mid]) continue;
      const url = `${scoreBase}?planned=${encodeURIComponent(m.mid)}`;
      void qrToDataUri(url, 96).then((data) => {
        // Immutable-copy assignment to trigger reactivity.
        qrByMid = { ...qrByMid, [m.mid]: data };
      });
    }
  });

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
          Mode inherits from tournament defaults: <strong>{mode}</strong>.
          {#if tournament.defaults?.bestOf || tournament.defaults?.pointsTarget || tournament.defaults?.maxBoards}
            Config:
            {#if tournament.defaults?.bestOf}bo{tournament.defaults.bestOf}{/if}
            {#if tournament.defaults?.pointsTarget}, target {tournament.defaults.pointsTarget}{/if}
            {#if tournament.defaults?.maxBoards}, max {tournament.defaults.maxBoards} boards{/if}.
          {/if}
        </p>

        <div class="bracket-add">
          <div class="add-grid" class:add-grid-doubles={mode === 'doubles'}>
            <label>
              <span>Side A {mode === 'doubles' ? '— player 1' : ''}</span>
              <input
                type="text"
                bind:value={addAName}
                placeholder="Player name"
                maxlength="80"
                disabled={addBusy}
              />
            </label>
            {#if mode === 'doubles'}
              <label>
                <span>Side A — player 2</span>
                <input
                  type="text"
                  bind:value={addA2Name}
                  placeholder="Partner name"
                  maxlength="80"
                  disabled={addBusy}
                />
              </label>
            {/if}
            <label>
              <span>Side B {mode === 'doubles' ? '— player 1' : ''}</span>
              <input
                type="text"
                bind:value={addBName}
                placeholder="Player name"
                maxlength="80"
                disabled={addBusy}
              />
            </label>
            {#if mode === 'doubles'}
              <label>
                <span>Side B — player 2</span>
                <input
                  type="text"
                  bind:value={addB2Name}
                  placeholder="Partner name"
                  maxlength="80"
                  disabled={addBusy}
                />
              </label>
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
                  <th class="col-qr">QR</th>
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
                    <td class="col-qr">
                      {#if qrByMid[m.mid]}
                        <img
                          src={qrByMid[m.mid]}
                          alt="QR for {m.aName} vs {m.bName}"
                          width="64"
                          height="64"
                          class="qr-inline"
                        />
                      {:else}
                        <span class="qr-loading" aria-hidden="true">…</span>
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
  .add-grid label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
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
    white-space: nowrap;
  }
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
  .col-qr { width: 5rem; text-align: center; }
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

  .qr-inline {
    display: block;
    width: 4rem;
    height: 4rem;
    background: #fff;
    border-radius: 0.3rem;
    margin: 0 auto;
  }
  .qr-loading {
    color: var(--muted, #9aa0a6);
    font-size: 1rem;
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
