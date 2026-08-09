<script lang="ts">
  /**
   * Admin — Players tab.
   *
   * Renders the full player roster with search, per-row Rename,
   * per-row Delete, and a two-row Merge flow that rewrites every
   * match's playerAId/A2Id/BId/B2Id atomically.
   *
   * All destructive actions require type-to-confirm ("DELETE" or
   * "MERGE"). RTDB rules enforce super-only writes; this UI is UX
   * gating on top.
   */
  import { onMount } from 'svelte';
  import {
    loadAll,
    subscribePlayers,
    subscribeStore,
    updatePlayerName,
    deletePlayer,
    mergePlayers,
    type Player,
  } from '../lib/players';

  let tick = $state(0);
  let query = $state('');
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let deleteConfirmId = $state<string | null>(null);
  let deleteConfirmText = $state('');
  let mergeCanonicalId = $state<string | null>(null);
  let mergeIntoId = $state<string | null>(null);
  let mergeConfirmText = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);

  onMount(() => {
    void subscribePlayers();
    const unsub = subscribeStore(() => (tick += 1));
    return unsub;
  });

  const filtered = $derived(() => {
    void tick;
    const q = query.trim().toLowerCase();
    const all = loadAll();
    if (!q) return all.slice(0, 200);
    return all
      .filter((p) => p.canonicalName.toLowerCase().includes(q))
      .slice(0, 200);
  });

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => {
      banner = null;
    }, 4000);
  }

  function startRename(p: Player) {
    renamingId = p.id;
    renameValue = p.canonicalName;
  }
  async function saveRename() {
    if (!renamingId) return;
    saving = true;
    const outcome = await updatePlayerName(renamingId, renameValue);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Player renamed');
      renamingId = null;
    } else {
      flash('err', outcome.error);
    }
  }
  function cancelRename() {
    renamingId = null;
    renameValue = '';
  }

  function startDelete(id: string) {
    deleteConfirmId = id;
    deleteConfirmText = '';
  }
  async function confirmDelete() {
    if (!deleteConfirmId) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;
    saving = true;
    const outcome = await deletePlayer(deleteConfirmId);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Player deleted');
      deleteConfirmId = null;
    } else {
      flash('err', outcome.error);
    }
  }
  function cancelDelete() {
    deleteConfirmId = null;
    deleteConfirmText = '';
  }

  function startMerge(canonicalId: string) {
    mergeCanonicalId = canonicalId;
    mergeIntoId = null;
    mergeConfirmText = '';
  }
  async function confirmMerge() {
    if (!mergeCanonicalId || !mergeIntoId) return;
    if (mergeConfirmText.trim().toUpperCase() !== 'MERGE') return;
    saving = true;
    const outcome = await mergePlayers(mergeCanonicalId, mergeIntoId);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Players merged');
      mergeCanonicalId = null;
      mergeIntoId = null;
    } else {
      flash('err', outcome.error);
    }
  }
  function cancelMerge() {
    mergeCanonicalId = null;
    mergeIntoId = null;
    mergeConfirmText = '';
  }

  const mergeCanonical = $derived(() => {
    void tick;
    return mergeCanonicalId ? loadAll().find((p) => p.id === mergeCanonicalId) ?? null : null;
  });
  const mergeCandidates = $derived(() => {
    void tick;
    if (!mergeCanonicalId) return [];
    return loadAll().filter((p) => p.id !== mergeCanonicalId).slice(0, 50);
  });
</script>

<section class="players">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <div class="controls">
    <input
      type="search"
      placeholder="Search players…"
      bind:value={query}
      aria-label="Search players"
    />
    <span class="count">{filtered().length}</span>
  </div>

  {#if filtered().length === 0}
    <p class="empty">
      {query ? 'No players match that search.' : 'No players yet.'}
    </p>
  {:else}
    <ul class="list">
      {#each filtered() as p (p.id)}
        <li class="row">
          {#if renamingId === p.id}
            <div class="row-edit">
              <input
                type="text"
                bind:value={renameValue}
                aria-label="New canonical name"
                maxlength="60"
              />
              <button
                type="button"
                class="btn btn-primary"
                onclick={saveRename}
                disabled={saving || !renameValue.trim()}
              >Save</button>
              <button
                type="button"
                class="btn"
                onclick={cancelRename}
                disabled={saving}
              >Cancel</button>
            </div>
          {:else}
            <div class="row-name">
              <div class="row-name-text">{p.canonicalName}</div>
              <div class="row-name-meta">
                <span class="chip">id: <code>{p.id}</code></span>
                {#if Object.keys(p.aliases).length > 0}
                  <span class="chip">{Object.keys(p.aliases).length} alias{Object.keys(p.aliases).length === 1 ? '' : 'es'}</span>
                {/if}
              </div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn" onclick={() => startRename(p)}>Rename</button>
              <button type="button" class="btn" onclick={() => startMerge(p.id)}>Merge…</button>
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => startDelete(p.id)}
              >Delete</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if deleteConfirmId}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}>
      <div class="dialog-card">
        <h3>Delete player?</h3>
        <p>
          The player record is removed. Match records that referenced
          this player will keep their playerId — the History page
          will render the raw slug instead of a name. This is
          irreversible via the app; a Firebase console restore is the
          only recovery.
        </p>
        <p>Type <strong>DELETE</strong> to confirm.</p>
        <input type="text" bind:value={deleteConfirmText} placeholder="DELETE" aria-label="Type DELETE" />
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={cancelDelete} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-danger"
            onclick={confirmDelete}
            disabled={saving || deleteConfirmText.trim().toUpperCase() !== 'DELETE'}
          >{saving ? 'Deleting…' : 'Confirm delete'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if mergeCanonicalId}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelMerge(); }}>
      <div class="dialog-card dialog-card-wide">
        <h3>Merge into <em>{mergeCanonical()?.canonicalName ?? '?'}</em></h3>
        <p>
          Pick the DUPLICATE player. Every match that references the
          duplicate's id is atomically rewritten to point at
          <strong>{mergeCanonical()?.canonicalName}</strong>. The
          duplicate's aliases are merged into the canonical, and the
          duplicate record is deleted.
        </p>
        <label class="merge-picker">
          <span>Duplicate player</span>
          <select bind:value={mergeIntoId} aria-label="Duplicate player">
            <option value={null}>(pick one)</option>
            {#each mergeCandidates() as c (c.id)}
              <option value={c.id}>{c.canonicalName}</option>
            {/each}
          </select>
        </label>
        <p>Type <strong>MERGE</strong> to confirm.</p>
        <input type="text" bind:value={mergeConfirmText} placeholder="MERGE" aria-label="Type MERGE" />
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={cancelMerge} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-danger"
            onclick={confirmMerge}
            disabled={saving || !mergeIntoId || mergeConfirmText.trim().toUpperCase() !== 'MERGE'}
          >{saving ? 'Merging…' : 'Confirm merge'}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .players { display: flex; flex-direction: column; gap: 0.75rem; }

  .banner {
    padding: 0.5rem 0.75rem;
    background: rgba(76, 175, 80, 0.12);
    border: 1px solid rgba(76, 175, 80, 0.4);
    color: #66bb6a;
    border-radius: 0.5rem;
    font-size: 0.85rem;
  }
  .banner-err {
    background: rgba(239, 83, 80, 0.12);
    border-color: rgba(239, 83, 80, 0.4);
    color: #ef8985;
  }

  .controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .controls input {
    flex: 1;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .controls input:focus {
    outline: none;
    border-color: var(--accent);
  }
  .count {
    color: var(--muted);
    font-size: 0.8rem;
    padding: 0.15rem 0.5rem;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 999px;
  }

  .empty { color: var(--muted); text-align: center; padding: 1.5rem; }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
  }
  .row-name { flex: 1; min-width: 0; }
  .row-name-text {
    color: var(--fg);
    font-weight: 600;
    font-size: 0.95rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-name-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.25rem;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  .chip code {
    font-size: 0.9em;
  }
  .row-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
  }
  .row-edit {
    flex: 1;
    display: flex;
    gap: 0.35rem;
    align-items: center;
  }
  .row-edit input {
    flex: 1;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid var(--accent);
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.9rem;
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
  .btn-primary {
    background: var(--accent);
    color: #0b0b0b;
    border-color: var(--accent);
  }
  .btn-primary:hover:not(:disabled) { background: #ffe07a; }
  .btn-danger {
    background: rgba(239, 83, 80, 0.14);
    color: var(--danger);
    border-color: rgba(239, 83, 80, 0.4);
  }
  .btn-danger:hover:not(:disabled) { background: rgba(239, 83, 80, 0.22); }

  .dialog {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 400;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }
  .dialog-card {
    background: #141414;
    border: 1px solid rgba(239, 83, 80, 0.4);
    border-radius: 0.75rem;
    padding: 1rem;
    max-width: 28rem;
    width: 100%;
  }
  .dialog-card-wide { max-width: 32rem; }
  .dialog-card h3 {
    margin: 0 0 0.5rem;
    color: var(--danger);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.9rem;
  }
  .dialog-card p {
    margin: 0.5rem 0;
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.5;
  }
  .dialog-card input[type="text"] {
    width: 100%;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    margin: 0.25rem 0 0.75rem;
  }
  .merge-picker {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.5rem 0;
  }
  .merge-picker span {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg);
    font-weight: 700;
  }
  .merge-picker select {
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.5rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
</style>
