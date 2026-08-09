<script lang="ts">
  /**
   * Admin — Tournaments tab.
   *
   * Per row:
   *   Rename — updates the display name; if the normalised key
   *     changes we clone to a new record and rewrite every match's
   *     `tournament` display-name.
   *   Delete — removes the tournament record. Child matches keep
   *     their tag string but fall to the "Default" bucket in the
   *     lobby (deliberate — no silent match rewrites on delete).
   *   Manage organisers — loads the organiser UID list, allows
   *     adding a new UID or removing an existing one. Gmail→UID
   *     is not supported on Spark tier (no serverless); the
   *     recipient signs in, copies their UID, and shares it.
   */
  import { onMount } from 'svelte';
  import {
    loadAll,
    subscribeStore,
    subscribeTournaments,
    renameTournament,
    deleteTournament,
    addOrganiser,
    removeOrganiser,
    loadOrganisers,
    type Tournament,
  } from '../lib/tournaments';

  let tick = $state(0);
  let renamingKey = $state<string | null>(null);
  let renameValue = $state('');
  let deleteConfirmKey = $state<string | null>(null);
  let deleteConfirmText = $state('');
  let managingKey = $state<string | null>(null);
  let organiserUids = $state<string[]>([]);
  let organiserLoading = $state(false);
  let addUidValue = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);

  onMount(() => {
    void subscribeTournaments();
    const unsub = subscribeStore(() => (tick += 1));
    return unsub;
  });

  const list = $derived(() => {
    void tick;
    return loadAll();
  });

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 4000);
  }

  function startRename(t: Tournament) {
    renamingKey = t.key;
    renameValue = t.name;
  }
  async function saveRename() {
    if (!renamingKey) return;
    saving = true;
    const outcome = await renameTournament(renamingKey, renameValue);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Tournament renamed');
      renamingKey = null;
    } else {
      flash('err', outcome.error);
    }
  }
  function cancelRename() {
    renamingKey = null;
    renameValue = '';
  }

  function startDelete(key: string) {
    deleteConfirmKey = key;
    deleteConfirmText = '';
  }
  async function confirmDelete() {
    if (!deleteConfirmKey) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;
    saving = true;
    const outcome = await deleteTournament(deleteConfirmKey);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Tournament deleted');
      deleteConfirmKey = null;
    } else {
      flash('err', outcome.error);
    }
  }

  async function startManage(t: Tournament) {
    managingKey = t.key;
    organiserLoading = true;
    organiserUids = await loadOrganisers(t.key);
    organiserLoading = false;
    addUidValue = '';
  }
  function stopManage() {
    managingKey = null;
    organiserUids = [];
    addUidValue = '';
  }
  async function addUid() {
    if (!managingKey || !addUidValue.trim()) return;
    saving = true;
    const uid = addUidValue.trim();
    const outcome = await addOrganiser(managingKey, uid);
    saving = false;
    if (outcome.ok) {
      if (!organiserUids.includes(uid)) organiserUids = [...organiserUids, uid];
      addUidValue = '';
      flash('ok', 'Organiser added');
    } else {
      flash('err', outcome.error);
    }
  }
  async function removeUid(uid: string) {
    if (!managingKey) return;
    saving = true;
    const outcome = await removeOrganiser(managingKey, uid);
    saving = false;
    if (outcome.ok) {
      organiserUids = organiserUids.filter((u) => u !== uid);
      flash('ok', 'Organiser removed');
    } else {
      flash('err', outcome.error);
    }
  }
</script>

<section class="tourns">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  {#if list().length === 0}
    <p class="empty">No tournaments yet.</p>
  {:else}
    <ul class="list">
      {#each list() as t (t.key)}
        <li class="row">
          {#if renamingKey === t.key}
            <div class="row-edit">
              <input
                type="text"
                bind:value={renameValue}
                aria-label="New tournament name"
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
              <div class="row-name-text">{t.name}</div>
              <div class="row-name-meta">
                <span class="chip">key: <code>{t.key}</code></span>
                <span class="chip">last active {new Date(t.lastActive).toLocaleDateString()}</span>
              </div>
            </div>
            <div class="row-actions">
              <button type="button" class="btn" onclick={() => startRename(t)}>Rename</button>
              <button type="button" class="btn" onclick={() => startManage(t)}>Organisers</button>
              <button
                type="button"
                class="btn btn-danger"
                onclick={() => startDelete(t.key)}
              >Delete</button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if deleteConfirmKey}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) (deleteConfirmKey = null); }}>
      <div class="dialog-card">
        <h3>Delete tournament?</h3>
        <p>
          The tournament record is removed. Match records that were
          tagged with this tournament keep the tag string but fall to
          the "Default" bucket in the lobby. Retention shortens from
          1 year → 3 months for those matches.
        </p>
        <p>Type <strong>DELETE</strong> to confirm.</p>
        <input type="text" bind:value={deleteConfirmText} placeholder="DELETE" aria-label="Type DELETE" />
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={() => (deleteConfirmKey = null)} disabled={saving}>Cancel</button>
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

  {#if managingKey}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) stopManage(); }}>
      <div class="dialog-card dialog-card-wide">
        <h3>Manage organisers</h3>
        <p>
          Organisers can edit any match tagged to this tournament.
          Add by Firebase UID — the recipient signs in, opens their
          account menu, and shares their UID with you.
        </p>
        {#if organiserLoading}
          <p class="empty">Loading…</p>
        {:else}
          <ul class="uid-list">
            {#each organiserUids as uid (uid)}
              <li class="uid-row">
                <code>{uid}</code>
                <button
                  type="button"
                  class="btn btn-danger btn-sm"
                  onclick={() => removeUid(uid)}
                  disabled={saving}
                >Remove</button>
              </li>
            {/each}
            {#if organiserUids.length === 0}
              <li class="empty">No organisers yet.</li>
            {/if}
          </ul>
        {/if}
        <div class="uid-add">
          <input
            type="text"
            bind:value={addUidValue}
            placeholder="Firebase UID"
            aria-label="Firebase UID"
            maxlength="64"
          />
          <button
            type="button"
            class="btn btn-primary"
            onclick={addUid}
            disabled={saving || !addUidValue.trim()}
          >Add</button>
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopManage} disabled={saving}>Close</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .tourns { display: flex; flex-direction: column; gap: 0.75rem; }

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
  .row-actions {
    display: flex;
    gap: 0.35rem;
    flex-shrink: 0;
    flex-wrap: wrap;
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
  .btn-sm { padding: 0.25rem 0.6rem; font-size: 0.75rem; }

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
  .dialog-card-wide {
    max-width: 32rem;
    border-color: rgba(255, 213, 74, 0.4);
  }
  .dialog-card h3 {
    margin: 0 0 0.5rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.9rem;
  }
  .dialog-card:not(.dialog-card-wide) h3 { color: var(--danger); }
  .dialog-card-wide h3 { color: var(--accent); }
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
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }

  .uid-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .uid-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.55rem;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 0.4rem;
  }
  .uid-row code {
    flex: 1;
    font-size: 0.75rem;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .uid-add {
    display: flex;
    gap: 0.35rem;
    margin: 0.75rem 0 0.25rem;
  }
  .uid-add input {
    flex: 1;
    margin: 0;
  }
</style>
