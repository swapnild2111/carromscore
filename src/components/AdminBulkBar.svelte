<script lang="ts">
  /**
   * Shared bulk-action toolbar used by all four admin tabs
   * (Players, Tournaments, Live cleanup, History). Sticks to the
   * top of the panel and appears only when at least one row is
   * selected. Fires a `delete` intent up to the parent, which owns
   * the actual bulk write.
   *
   * Confirmation lives inside this component so every admin surface
   * gets the same type-DELETE flow. When `confirming` is true the
   * bar swaps to an input + Confirm/Cancel; otherwise it's a summary
   * + Delete button.
   */
  interface Props {
    /** Number of currently-selected rows. Bar hides when 0. */
    count: number;
    /** Human-readable label for what the count represents
     *  (e.g. "match", "player"). Pluralised in-bar. */
    itemLabel: string;
    /** True while the parent is applying the bulk delete. Disables
     *  buttons + shows a "Deleting…" state. */
    saving?: boolean;
    /** Called when the user completes the type-DELETE confirmation. */
    onConfirmDelete: () => void;
    /** Called when the user backs out. Parent should also clear the
     *  selection set from its side. */
    onClearSelection: () => void;
  }
  const {
    count,
    itemLabel,
    saving = false,
    onConfirmDelete,
    onClearSelection,
  }: Props = $props();

  let confirming = $state(false);
  let confirmText = $state('');

  const armed = $derived(confirmText.trim().toUpperCase() === 'DELETE');

  function startConfirm() {
    confirming = true;
    confirmText = '';
  }
  function cancelConfirm() {
    confirming = false;
    confirmText = '';
  }
  function performDelete() {
    if (!armed || saving) return;
    onConfirmDelete();
    confirming = false;
    confirmText = '';
  }
</script>

{#if count > 0}
  <div class="bulk" role="region" aria-label="Bulk actions">
    {#if !confirming}
      <div class="bulk-summary">
        <strong>{count}</strong>
        <span>{itemLabel}{count === 1 ? '' : 's'} selected</span>
      </div>
      <div class="bulk-actions">
        <button
          type="button"
          class="btn"
          onclick={onClearSelection}
          disabled={saving}
        >Clear</button>
        <button
          type="button"
          class="btn btn-danger"
          onclick={startConfirm}
          disabled={saving}
        >Delete {count}</button>
      </div>
    {:else}
      <div class="bulk-confirm">
        <span class="warn">Type <strong>DELETE</strong> to confirm deleting <strong>{count}</strong> {itemLabel}{count === 1 ? '' : 's'}.</span>
        <input
          type="text"
          bind:value={confirmText}
          placeholder="DELETE"
          aria-label="Type DELETE to confirm"
        />
        <button type="button" class="btn" onclick={cancelConfirm} disabled={saving}>Cancel</button>
        <button
          type="button"
          class="btn btn-danger"
          onclick={performDelete}
          disabled={!armed || saving}
        >{saving ? 'Deleting…' : 'Confirm'}</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Sticky-under-tab-bar so the toolbar remains visible as the user
     scrolls the list. Uses a subtle amber glow to match the accent
     colour — this is the destructive-action surface and should read
     as "you're mid-action". */
  .bulk {
    position: sticky;
    top: 0;
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.55rem 0.75rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.55rem;
    margin: 0 0 0.75rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .bulk-summary {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
  }
  .bulk-summary strong {
    color: var(--accent, #ffd54a);
    font-size: 0.95rem;
  }
  .bulk-actions {
    display: flex;
    gap: 0.4rem;
    margin-left: auto;
  }
  .bulk-confirm {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    width: 100%;
  }
  .bulk-confirm .warn {
    color: var(--fg, #f5f5f5);
    font-size: 0.82rem;
    line-height: 1.4;
    flex: 1 1 100%;
  }
  .bulk-confirm .warn strong {
    color: var(--accent, #ffd54a);
  }
  .bulk-confirm input {
    flex: 1;
    min-width: 8rem;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid var(--danger, #ef5350);
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
  }

  .btn {
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--fg);
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem;
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-danger {
    background: rgba(239, 83, 80, 0.14);
    color: var(--danger, #ef5350);
    border-color: rgba(239, 83, 80, 0.4);
  }
  .btn-danger:hover:not(:disabled) { background: rgba(239, 83, 80, 0.22); }
</style>
