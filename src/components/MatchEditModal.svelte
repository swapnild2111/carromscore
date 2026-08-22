<script lang="ts">
  /**
   * Admin edit modal for a single match record.
   *
   * Layout: modal sits on top of everything, close on backdrop click,
   * top-right ✕. Sections:
   *   1. Scalars   — setsA/B, finalPointsA/B, boardCount, tournament.
   *                  Tournament field is `readonly` unless user is
   *                  super — the RTDB rule refuses an organiser's
   *                  attempt to change it, but disabling the input
   *                  saves them a round-trip.
   *   2. Board log — one row per entry; edit points/queen/break/side.
   *                  Add + delete rows.
   *   3. Danger   — delete-match with "Type DELETE" confirmation.
   *
   * On save, calls `updateMatch(id, patch)` which returns
   * { ok } | { ok:false, error }. Failures render inline so the admin
   * can retry — the rest of the module is silent-on-failure, but
   * admin flows must surface denials clearly (the whole point of the
   * modal is to fix data, so it must not lie about success).
   *
   * `endedAt` and `createdBy` are never sent in the patch — retention
   * ages the record correctly, and provenance stays with the original
   * creator.
   */
  import {
    updateMatch,
    deleteMatch,
    playerName,
    type MatchPatch,
    type MatchRecord,
  } from '../lib/history';

  type BoardRow = {
    set: number;
    board: number;
    breakSide: 'a' | 'b';
    queen: 'a' | 'b';
    pointsA: number;
    pointsB: number;
    endedAt: number;
  };

  interface Props {
    record: MatchRecord;
    isSuper: boolean;
    onClose: () => void;
    onSaved: () => void;
  }
  const { record, isSuper, onClose, onSaved }: Props = $props();

  // Local edit state, seeded from the incoming record. All fields
  // clamp on input; validation happens on Save.
  //
  // The scoring model has two layers:
  //   - `rows` (boardLog): per-board coin deltas + queen + break
  //   - `finalPointsA/B`, `boardCount`: top-level summary
  //
  // These MUST stay consistent — the recap table sums boardLog to
  // show per-board totals, while the header DSEG7 shows finalPoints.
  // Historically both were editable independently and admins could
  // (accidentally) create a mismatch: edit the header but leave the
  // rows, and the popup would show 16 up top and 7 in the table.
  //
  // Now the source of truth is `rows`. `finalPointsA/B` and
  // `boardCount` are DERIVED from row sums and shown read-only, so
  // admins have exactly one place to fix a score. `setsA/B` and
  // `winner` stay editable — those aren't summable from boardLog.
  const initial = record.result ?? {};

  /**
   * Human-readable per-side names for the modal. We prefer actual
   * player names over "A" / "B" so admins fixing a match don't have
   * to translate in their head — a doubles match especially reads
   * much better as "Prem & Yash" vs "A".
   *
   * Doubles unions the two teammates with an ampersand, matching
   * LiveLobby.sideNameMatch and the recap header shape. Falls back
   * to "Side A" / "Side B" if identity lookup produces nothing —
   * shouldn't happen for a well-formed record, but the fallback
   * keeps the UI readable during identity-store rehydration.
   */
  function computeSideName(side: 'a' | 'b'): string {
    if (record.mode === 'doubles') {
      const p1 = playerName(
        side === 'a' ? record.playerAId : record.playerBId,
        side === 'a' ? record.aName : record.bName,
      );
      const p2 = playerName(
        side === 'a' ? record.playerA2Id : record.playerB2Id,
        side === 'a' ? record.a2Name : record.b2Name,
      );
      return p1 && p2 ? `${p1} & ${p2}` : p1 || p2 || (side === 'a' ? 'Team A' : 'Team B');
    }
    return (
      playerName(
        side === 'a' ? record.playerAId : record.playerBId,
        side === 'a' ? record.aName : record.bName,
      ) || (side === 'a' ? 'Side A' : 'Side B')
    );
  }
  const nameA = computeSideName('a');
  const nameB = computeSideName('b');
  /**
   * Compact per-column heading. Full player name in the top scalars
   * block; heading in the tight board-log table uses first-word only
   * so the column doesn't force horizontal scroll on phones.
   */
  const shortA = nameA.split(/[\s&]/)[0] || 'A';
  const shortB = nameB.split(/[\s&]/)[0] || 'B';

  let setsA = $state<number>(Number(initial.setsA ?? 0));
  let setsB = $state<number>(Number(initial.setsB ?? 0));
  let winner = $state<'a' | 'b' | ''>(
    initial.winner === 'a' || initial.winner === 'b' ? initial.winner : '',
  );
  let tournament = $state<string>(record.tournament ?? '');
  let noteA = $state<string>(record.notes?.a ?? '');
  let noteB = $state<string>(record.notes?.b ?? '');
  let rows = $state<BoardRow[]>(
    // Filter out null/undefined slots. Firebase RTDB stores arrays
    // as sparse maps, and an admin delete of a single boardLog index
    // in the Console leaves `null` at that slot rather than
    // compacting; the modal's per-row .map would then throw on
    // `null.set`. Same defensive filter LiveScoreboardView uses.
    (record.boardLog ?? []).filter((e): e is NonNullable<typeof e> => !!e && typeof e === 'object').map((e) => ({
      set: e.set,
      board: e.board,
      breakSide: e.breakSide,
      queen: e.queen,
      pointsA: e.pointsA,
      pointsB: e.pointsB,
      endedAt: e.endedAt,
    })),
  );

  /**
   * Derived per-side final points. In the storage convention (see
   * ScoreBoard.svelte's snapshot writes), each row's `pointsA/B` is
   * the per-board delta of the cumulative sideA/B.points as tracked
   * during play — which ALREADY includes the queen bonus when that
   * side pocketed the queen. So the running total is simply the
   * sum of row.pointsA (no `+3` correction; that would double-count).
   *
   * The popup recap (LiveScoreboardView) DISPLAYS these differently:
   * it shows "coins" (= pointsA - 3 when queen === 'a') plus a
   * separate "+Q" badge. That's presentation, not storage — the
   * stored number stays the total.
   */
  const finalPointsA = $derived(rows.reduce((sum, r) => sum + r.pointsA, 0));
  const finalPointsB = $derived(rows.reduce((sum, r) => sum + r.pointsB, 0));
  const boardCount = $derived(rows.length);

  let saving = $state(false);
  let deletingConfirm = $state(false);
  let deleteConfirmText = $state('');
  let inlineError = $state<string | null>(null);

  function backdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function addRow() {
    // New row starts at the currently-highest set number and one past
    // the current highest board in that set. Small ergonomic — admins
    // almost never want a row at the top.
    const setsSeen = rows.length > 0 ? Math.max(...rows.map((r) => r.set)) : 0;
    const boardsInSet = rows.filter((r) => r.set === setsSeen);
    const nextBoard = boardsInSet.length > 0
      ? Math.max(...boardsInSet.map((r) => r.board)) + 1
      : 1;
    rows = [
      ...rows,
      {
        set: setsSeen,
        board: nextBoard,
        breakSide: 'a',
        queen: 'a',
        pointsA: 0,
        pointsB: 0,
        endedAt: Date.now(),
      },
    ];
  }

  function removeRow(idx: number) {
    rows = rows.filter((_, i) => i !== idx);
  }

  async function save() {
    inlineError = null;
    saving = true;
    const patch: MatchPatch = {
      result: {
        setsA: Math.max(0, Math.floor(setsA)),
        setsB: Math.max(0, Math.floor(setsB)),
        // finalPointsA/B and boardCount are derived from `rows`, so
        // they're always in sync with the boardLog we're about to
        // write. Clamps aren't needed — the derivation itself
        // guarantees non-negative integers.
        finalPointsA,
        finalPointsB,
        boardCount,
        winner: winner === '' ? null : winner,
      },
      notes: { a: noteA, b: noteB },
      // Empty string clears the tag entirely (retention shortens).
      // Non-empty writes the trimmed value.
      tournament: isSuper ? tournament.trim() : record.tournament ?? '',
      boardLog: rows,
    };
    const outcome = await updateMatch(record.id, patch);
    saving = false;
    if (outcome.ok) {
      onSaved();
      onClose();
    } else {
      inlineError = outcome.error;
    }
  }

  async function performDelete() {
    inlineError = null;
    saving = true;
    const outcome = await deleteMatch(record.id);
    saving = false;
    if (outcome.ok) {
      onSaved();
      onClose();
    } else {
      inlineError = outcome.error;
    }
  }

  const deleteArmed = $derived(deleteConfirmText.trim().toUpperCase() === 'DELETE');
</script>

<div
  class="modal-backdrop"
  role="dialog"
  aria-modal="true"
  aria-labelledby="edit-title"
  onclick={backdropClick}
>
  <div class="modal-card">
    <button
      type="button"
      class="modal-close"
      onclick={onClose}
      aria-label="Close edit modal"
    >✕</button>
    <h2 id="edit-title">
      Edit match
      {#if !isSuper}<span class="scope-badge">Organiser scope</span>{/if}
    </h2>

    <section class="section">
      <div class="grid2">
        <label>
          <span>Sets — {nameA}</span>
          <input type="number" min="0" max="9" bind:value={setsA} />
        </label>
        <label>
          <span>Sets — {nameB}</span>
          <input type="number" min="0" max="9" bind:value={setsB} />
        </label>
        <label>
          <span>
            Final points — {nameA}
            <em class="hint">(computed)</em>
          </span>
          <div class="computed-cell">{finalPointsA}</div>
        </label>
        <label>
          <span>
            Final points — {nameB}
            <em class="hint">(computed)</em>
          </span>
          <div class="computed-cell">{finalPointsB}</div>
        </label>
        <label>
          <span>
            Board count
            <em class="hint">(computed)</em>
          </span>
          <div class="computed-cell">{boardCount}</div>
        </label>
        <label>
          <span>Winner</span>
          <select bind:value={winner}>
            <option value="">(no winner)</option>
            <option value="a">{nameA}</option>
            <option value="b">{nameB}</option>
          </select>
        </label>
      </div>
      <p class="hint-block">
        Points and board count are computed from the board log below.
        <strong>{shortA}</strong> / <strong>{shortB}</strong> is the
        total that side scored on that board — coins + 3 if they
        pocketed the queen. So a board where {nameA} got 4 coins and
        the queen is stored as <strong>{shortA} = 7, Queen = {shortA}</strong>.
        Edit the rows and the totals reconcile automatically.
      </p>

      <div class="grid2 grid-notes">
        <label>
          <span>Represents — {nameA}</span>
          <input type="text" maxlength="40" bind:value={noteA} placeholder="Country, club…" />
        </label>
        <label>
          <span>Represents — {nameB}</span>
          <input type="text" maxlength="40" bind:value={noteB} placeholder="Country, club…" />
        </label>
      </div>

      <label class="tourn-input">
        <span>
          Tournament tag
          {#if !isSuper}<em class="hint">(super-admin only)</em>{/if}
        </span>
        <input
          type="text"
          maxlength="60"
          bind:value={tournament}
          readonly={!isSuper}
        />
      </label>
    </section>

    <section class="section">
      <div class="sec-hdr">
        <h3>Board log</h3>
        <button type="button" class="ghost-btn" onclick={addRow}>+ Add row</button>
      </div>
      {#if rows.length === 0}
        <p class="empty">No board rows recorded. Add rows if you need
        per-board data to appear in the recap.</p>
      {:else}
        <div class="rowtable">
          <div class="rowtable-hdr">
            <span>Set</span>
            <span>Board</span>
            <span>Break</span>
            <span>Queen</span>
            <span title={nameA}>{shortA}</span>
            <span title={nameB}>{shortB}</span>
            <span></span>
          </div>
          {#each rows as row, i (i)}
            <div class="rowtable-row">
              <input type="number" min="0" max="9" bind:value={row.set} />
              <input type="number" min="0" max="99" bind:value={row.board} />
              <select bind:value={row.breakSide} aria-label="Break side">
                <option value="a">{shortA}</option>
                <option value="b">{shortB}</option>
              </select>
              <select bind:value={row.queen} aria-label="Queen holder">
                <option value="a">{shortA}</option>
                <option value="b">{shortB}</option>
              </select>
              <input type="number" min="0" bind:value={row.pointsA} aria-label={`Points for ${nameA}`} />
              <input type="number" min="0" bind:value={row.pointsB} aria-label={`Points for ${nameB}`} />
              <button
                type="button"
                class="row-del"
                onclick={() => removeRow(i)}
                aria-label="Remove row {i + 1}"
              >✕</button>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <section class="section danger">
      <h3>Danger zone</h3>
      {#if !deletingConfirm}
        <button
          type="button"
          class="danger-btn"
          onclick={() => (deletingConfirm = true)}
        >Delete this match</button>
      {:else}
        <p class="danger-warn">
          This deletes the match record permanently. Player + tournament
          records are untouched. Type <strong>DELETE</strong> to confirm.
        </p>
        <div class="grid2 danger-row">
          <input
            type="text"
            bind:value={deleteConfirmText}
            placeholder="Type DELETE"
            aria-label="Type DELETE to confirm"
          />
          <div class="danger-actions">
            <button
              type="button"
              class="ghost-btn"
              onclick={() => {
                deletingConfirm = false;
                deleteConfirmText = '';
              }}
            >Cancel</button>
            <button
              type="button"
              class="danger-btn"
              disabled={!deleteArmed || saving}
              onclick={performDelete}
            >Confirm delete</button>
          </div>
        </div>
      {/if}
    </section>

    {#if inlineError}
      <div class="inline-err" role="alert">
        <strong>Write failed:</strong> {inlineError}
      </div>
    {/if}

    <div class="footer-actions">
      <button type="button" class="ghost-btn" onclick={onClose} disabled={saving}>Cancel</button>
      <button
        type="button"
        class="save-btn"
        onclick={save}
        disabled={saving}
      >{saving ? 'Saving…' : 'Save changes'}</button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 400;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 1rem;
    overflow-y: auto;
  }
  .modal-card {
    position: relative;
    background: #141414;
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.9rem;
    padding: 1rem 1rem 1.25rem;
    max-width: 44rem;
    width: 100%;
    max-height: 92dvh;
    overflow-y: auto;
    box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
  }
  .modal-close {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    width: 2rem;
    height: 2rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg, #f5f5f5);
    border-radius: 999px;
    font-size: 0.95rem;
    line-height: 1;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .modal-close:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  h2 {
    margin: 0 0 1rem;
    padding-right: 2.5rem;
    color: var(--accent, #ffd54a);
    font-size: 1.1rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .scope-badge {
    background: rgba(79, 195, 247, 0.18);
    color: var(--side-a, #4fc3f7);
    border: 1px solid rgba(79, 195, 247, 0.5);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    font-size: 0.65rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 800;
  }
  h3 {
    margin: 0 0 0.5rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  .section {
    margin: 0 0 1.25rem;
  }
  .section:last-of-type {
    margin-bottom: 0.5rem;
  }
  .section.danger {
    padding-top: 0.9rem;
    border-top: 1px dashed rgba(239, 83, 80, 0.28);
  }
  .section.danger h3 {
    color: var(--danger, #ef5350);
  }

  .grid2 {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.6rem;
  }
  .grid-notes {
    margin-top: 0.6rem;
  }
  @media (max-width: 480px) {
    .grid2 {
      grid-template-columns: 1fr;
    }
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  label > span {
    color: var(--fg, #f5f5f5);
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 600;
  }
  .hint {
    color: var(--muted, #9aa0a6);
    font-style: normal;
    font-size: 0.9em;
    text-transform: none;
    letter-spacing: 0;
    margin-left: 0.25rem;
  }
  input, select {
    background: #0f0f0f;
    color: var(--fg, #f5f5f5);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    min-width: 0;
    font-family: inherit;
  }
  input:focus, select:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  input:read-only {
    opacity: 0.65;
    cursor: not-allowed;
  }

  /* Non-editable derived cell — same visual weight as an input so
     the grid stays aligned, but explicitly styled to look like a
     value display, not an entry field. Used for finalPoints and
     boardCount, which are computed from the board log. */
  .computed-cell {
    background: rgba(255, 255, 255, 0.03);
    color: var(--fg, #f5f5f5);
    border: 1px dashed rgba(255, 213, 74, 0.25);
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    min-width: 0;
    font-variant-numeric: tabular-nums;
  }
  .hint-block {
    margin: 0.6rem 0 0;
    color: var(--muted, #9aa0a6);
    font-size: 0.78rem;
    line-height: 1.5;
    padding: 0.5rem 0.65rem;
    background: rgba(255, 213, 74, 0.06);
    border-left: 2px solid rgba(255, 213, 74, 0.4);
    border-radius: 0 0.3rem 0.3rem 0;
  }

  .tourn-input {
    margin-top: 0.6rem;
  }

  .sec-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .rowtable {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    width: 100%;
  }
  /*
   * Row grid — fractional units so the table fills whatever width
   * the modal has. Set / Board / Delete are fixed narrow columns
   * (single-digit content); Break + Queen selects need enough
   * room for the name text + native dropdown arrow (roughly 6rem
   * min on iOS Safari). Pts columns flex to take the remainder.
   * On narrow phones the grid gracefully shrinks via minmax().
   */
  .rowtable-hdr,
  .rowtable-row {
    display: grid;
    grid-template-columns:
      minmax(2.3rem, 0.55fr)
      minmax(2.6rem, 0.6fr)
      minmax(4.5rem, 1fr)
      minmax(4.5rem, 1fr)
      minmax(3.2rem, 1fr)
      minmax(3.2rem, 1fr)
      2rem;
    gap: 0.35rem;
    align-items: center;
    width: 100%;
  }
  .rowtable-hdr {
    color: var(--muted, #9aa0a6);
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    padding: 0 0.2rem;
    /* Header cells for name-based columns can be long — allow
       wrapping so they don't push the layout wide. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rowtable-hdr > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rowtable-row input,
  .rowtable-row select {
    padding: 0.35rem 0.45rem;
    font-size: 0.85rem;
    width: 100%;
    min-width: 0;
  }
  .row-del {
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.35);
    color: var(--danger, #ef5350);
    border-radius: 0.35rem;
    width: 2rem;
    height: 2rem;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 0.85rem;
    cursor: pointer;
  }
  .row-del:hover {
    background: rgba(239, 83, 80, 0.15);
  }
  @media (max-width: 480px) {
    /* Very narrow phones: shrink font + drop the select-option
       min-width so we don't force horizontal scroll. Native
       selects will truncate the option label but the dropdown
       still shows the full text when opened. */
    .rowtable-hdr,
    .rowtable-row {
      grid-template-columns:
        minmax(2rem, 0.5fr)
        minmax(2.3rem, 0.55fr)
        minmax(3.4rem, 0.9fr)
        minmax(3.4rem, 0.9fr)
        minmax(2.8rem, 1fr)
        minmax(2.8rem, 1fr)
        1.8rem;
      font-size: 0.7rem;
      gap: 0.25rem;
    }
    .rowtable-row input,
    .rowtable-row select {
      padding: 0.3rem 0.35rem;
      font-size: 0.78rem;
    }
  }

  .empty {
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    line-height: 1.4;
    margin: 0.5rem 0;
  }

  .danger-warn {
    color: rgba(239, 83, 80, 0.85);
    font-size: 0.82rem;
    line-height: 1.5;
    margin: 0.35rem 0 0.75rem;
  }
  .danger-row {
    align-items: center;
  }
  .danger-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .danger-btn {
    background: rgba(239, 83, 80, 0.16);
    color: var(--danger, #ef5350);
    border: 1px solid rgba(239, 83, 80, 0.5);
    padding: 0.55rem 1rem;
    border-radius: 999px;
    font-weight: 700;
    font-size: 0.85rem;
    cursor: pointer;
    font-family: inherit;
  }
  .danger-btn:hover {
    background: rgba(239, 83, 80, 0.24);
  }
  .danger-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ghost-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.16);
    color: var(--fg, #f5f5f5);
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    font-weight: 600;
    font-size: 0.85rem;
    cursor: pointer;
    font-family: inherit;
  }
  .ghost-btn:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .ghost-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .save-btn {
    background: var(--accent, #ffd54a);
    color: #0b0b0b;
    border: 1px solid var(--accent, #ffd54a);
    padding: 0.55rem 1.1rem;
    border-radius: 999px;
    font-weight: 800;
    font-size: 0.85rem;
    cursor: pointer;
    font-family: inherit;
  }
  .save-btn:hover {
    background: #ffe07a;
  }
  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .inline-err {
    margin-top: 0.9rem;
    padding: 0.65rem 0.85rem;
    background: rgba(239, 83, 80, 0.12);
    border: 1px solid rgba(239, 83, 80, 0.4);
    border-radius: 0.5rem;
    color: rgba(239, 83, 80, 0.95);
    font-size: 0.85rem;
    line-height: 1.4;
  }

  .footer-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
    margin-top: 1rem;
    padding-top: 0.9rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }
</style>
