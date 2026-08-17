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
    createOrTouchTournament,
    renameTournament,
    deleteTournamentAndMatches,
    deleteTournaments,
    countMatchesByTournamentKey,
    addOrganiser,
    removeOrganiser,
    loadOrganisers,
    assignPlayer,
    unassignPlayer,
    loadAssignedPlayers,
    type Tournament,
  } from '../lib/tournaments';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import {
    loadAll as loadAllPlayers,
    subscribePlayers,
    subscribeStore as subscribePlayersStore,
    type Player,
  } from '../lib/players';
  import AdminBulkBar from './AdminBulkBar.svelte';
  import CountrySelect from './CountrySelect.svelte';
  import { countryName, flagEmoji } from '../lib/countries';

  /**
   * Current-user role gating: super sees every row's actions; a
   * plain organiser sees actions only on rows they organise. Row
   * actions are hidden — not disabled — to keep the row uncluttered.
   * RTDB rules on /tournaments/$key are the actual enforcement; this
   * gate avoids the surprise-permission-denied toast when the user
   * couldn't have succeeded anyway.
   */
  let role = $state<Role | null>(null);
  function canManageTournament(t: Tournament): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    return role.organiserOf.has(t.key);
  }

  let tick = $state(0);
  let renamingKey = $state<string | null>(null);
  let renameValue = $state('');
  let deleteConfirmKey = $state<string | null>(null);
  let deleteConfirmText = $state('');
  /** Live count of child matches that will be cascade-deleted when
   *  the confirmation goes through. `null` while the count is
   *  loading (dialog opens optimistically, count populates async).
   *  Displayed in the confirmation copy so the admin knows the
   *  blast radius. */
  let deleteConfirmChildCount = $state<number | null>(null);
  let managingKey = $state<string | null>(null);
  let organiserUids = $state<string[]>([]);
  let organiserLoading = $state(false);
  let addUidValue = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  /** Selected tournament keys for bulk delete. */
  let selected = $state<Set<string>>(new Set());
  /** Free-text filter over the tournament list. Matches on name
   *  (case-insensitive) and the slugified key so an admin can find
   *  a record by either the display name or the slug that appears
   *  in the URL / on match records. */
  let query = $state('');
  /** Add-new-tournament dialog state. Kept as a simple string + open
   *  flag; validation happens on save. */
  let addingOpen = $state(false);
  let addingName = $state('');
  let addingType = $state<'open' | 'closed'>('open');
  /** Country code — only meaningful when addingType === 'closed'.
   *  Required in that case; blocks Save. */
  let addingCountry = $state('');

  /** Per-row "Assigned players" dialog state (closed tournaments). */
  let assignOpen = $state(false);
  let assignKey = $state<string | null>(null);
  let assignedIds = $state<Set<string>>(new Set());
  let assignLoading = $state(false);
  let assignSaving = $state(false);
  let assignFilter = $state('');
  /** When true, the assignment dialog hides players whose country
   *  doesn't match the tournament's. Off shows every player (guest
   *  cases). Defaults on for closed tournaments with a country set. */
  let assignFilterByCountry = $state(true);

  /** Bump on the identity-store change, so the assignment dialog's
   *  filtered player list re-renders when a player is added elsewhere. */
  let playersTick = $state(0);

  onMount(() => {
    void subscribeTournaments();
    void subscribePlayers();
    const unsub = subscribeStore(() => (tick += 1));
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    const unsubPlayers = subscribePlayersStore(() => (playersTick += 1));
    return () => {
      unsub();
      unsubRole();
      unsubPlayers();
    };
  });

  const list = $derived(() => {
    void tick;
    return loadAll();
  });

  /** Search-filtered view of `list()`. Empty query = full list.
   *  Matches name substring OR key substring, both lowercased. */
  const filtered = $derived(() => {
    const all = list();
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (t) => t.name.toLowerCase().includes(q) || t.key.toLowerCase().includes(q),
    );
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
    deleteConfirmChildCount = null;
    // Fetch child count in the background so the dialog can surface
    // the blast radius. Non-blocking — dialog renders immediately;
    // the "N matches" text just appears when the count is in.
    void countMatchesByTournamentKey(key).then((n) => {
      // Guard against a stale response landing after the admin
      // cancelled and opened a different dialog.
      if (deleteConfirmKey === key) deleteConfirmChildCount = n;
    });
  }
  async function confirmDelete() {
    if (!deleteConfirmKey) return;
    if (deleteConfirmText.trim().toUpperCase() !== 'DELETE') return;
    saving = true;
    const outcome = await deleteTournamentAndMatches(deleteConfirmKey);
    saving = false;
    if (outcome.ok) {
      const bits = ['Tournament deleted'];
      if (outcome.matchesDeleted > 0) {
        bits.push(
          `${outcome.matchesDeleted} match${outcome.matchesDeleted === 1 ? '' : 'es'} removed`,
        );
      }
      flash('ok', bits.join(' · '));
      deleteConfirmKey = null;
      deleteConfirmChildCount = null;
    } else {
      // Partial failure — surface counts so the admin knows how much
      // landed and how much needs a follow-up.
      const bits: string[] = [];
      if (outcome.matchesDeleted > 0) bits.push(`${outcome.matchesDeleted} matches deleted`);
      if (outcome.matchesFailed > 0) bits.push(`${outcome.matchesFailed} matches skipped`);
      if (!outcome.tournamentDeleted) bits.push('tournament kept');
      const detail = bits.length ? ` — ${bits.join(', ')}` : '';
      flash('err', `${outcome.error ?? 'Delete failed'}${detail}`);
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

  function toggleSel(key: string) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    // Select-all operates on the currently-visible AND manageable
    // subset. Filter narrows the visible rows; canManageTournament
    // narrows the actionable rows. Both must be true to include.
    const manageable = filtered().filter((t) => canManageTournament(t));
    if (manageable.length > 0 && manageable.every((t) => selected.has(t.key))) {
      selected = new Set();
    } else {
      selected = new Set(manageable.map((t) => t.key));
    }
  }
  function clearSelection() {
    selected = new Set();
  }
  /** Reset the single-delete dialog state without triggering the
   *  delete. Called by the Cancel button and the backdrop-click
   *  handler. Clears the count so it doesn't leak to the next open. */
  function cancelDelete() {
    deleteConfirmKey = null;
    deleteConfirmText = '';
    deleteConfirmChildCount = null;
  }

  async function performBulkDelete() {
    const keys = [...selected];
    if (keys.length === 0) return;
    saving = true;
    const outcome = await deleteTournaments(keys);
    saving = false;
    if (outcome.ok) {
      const bits = [`${outcome.deleted} tournament${outcome.deleted === 1 ? '' : 's'} deleted`];
      if ((outcome.matchesDeleted ?? 0) > 0) {
        bits.push(
          `${outcome.matchesDeleted} match${outcome.matchesDeleted === 1 ? '' : 'es'} removed`,
        );
      }
      flash('ok', bits.join(' · '));
    } else {
      const bits = [`${outcome.deleted} deleted, ${outcome.failed} failed`];
      if ((outcome.matchesDeleted ?? 0) > 0) bits.push(`${outcome.matchesDeleted} matches deleted`);
      if ((outcome.matchesFailed ?? 0) > 0) bits.push(`${outcome.matchesFailed} matches skipped`);
      const detail = outcome.error ? ` — ${outcome.error}` : '';
      flash('err', `${bits.join(', ')}${detail}`);
    }
    selected = new Set();
  }

  const allSelected = $derived(() => {
    void tick;
    // Consistent with toggleSelectAll: "all selected" means every
    // currently-visible AND manageable row is in the selection.
    // Under super this is every filtered row; under organiser it's
    // only the filtered rows they organise.
    const manageable = filtered().filter((t) => canManageTournament(t));
    return manageable.length > 0 && manageable.every((t) => selected.has(t.key));
  });

  function openAdd() {
    addingOpen = true;
    addingName = '';
    addingType = 'open';
    addingCountry = '';
  }
  function closeAdd() {
    addingOpen = false;
    addingName = '';
    addingType = 'open';
    addingCountry = '';
  }
  async function saveAdd() {
    const trimmed = addingName.trim();
    if (!trimmed) return;
    if (addingType === 'closed' && !addingCountry) {
      flash('err', 'Closed tournaments need a country');
      return;
    }
    saving = true;
    // createOrTouchTournament writes to Firebase fire-and-forget; the
    // /tournaments subscription picks up the new record within a tick.
    // v3.1: pass type + country meta so open/closed status persists.
    const rec = createOrTouchTournament(trimmed, {
      type: addingType,
      ...(addingType === 'closed' && addingCountry ? { country: addingCountry } : {}),
    });
    saving = false;
    if (!rec) {
      flash('err', 'Name must include at least one letter or digit');
      return;
    }
    flash('ok', `"${rec.name}" added`);
    closeAdd();
  }

  // ─── Assigned Players dialog (closed tournaments only) ─────────

  async function startAssign(t: Tournament) {
    assignKey = t.key;
    assignFilter = '';
    // Default to country-filtering if the tournament has a country
    // configured; otherwise show all.
    assignFilterByCountry = !!t.country;
    assignOpen = true;
    assignLoading = true;
    try {
      assignedIds = await loadAssignedPlayers(t.key);
    } finally {
      assignLoading = false;
    }
  }
  function stopAssign() {
    assignOpen = false;
    assignKey = null;
    assignedIds = new Set();
    assignFilter = '';
  }
  async function togglePlayerAssignment(playerId: string) {
    if (!assignKey) return;
    assignSaving = true;
    try {
      if (assignedIds.has(playerId)) {
        const r = await unassignPlayer(assignKey, playerId);
        if (r.ok) {
          const next = new Set(assignedIds);
          next.delete(playerId);
          assignedIds = next;
        } else {
          flash('err', r.error);
        }
      } else {
        const r = await assignPlayer(assignKey, playerId);
        if (r.ok) {
          const next = new Set(assignedIds);
          next.add(playerId);
          assignedIds = next;
        } else {
          flash('err', r.error);
        }
      }
    } finally {
      assignSaving = false;
    }
  }

  /** Filtered player list for the assignment dialog. Reads from the
   *  identity store, applies the country filter when toggled on, and
   *  applies the free-text search. */
  const assignCandidates = $derived(() => {
    void playersTick;
    if (!assignKey) return [] as Player[];
    const tournament = list().find((t) => t.key === assignKey);
    const country = tournament?.country;
    const q = assignFilter.trim().toLowerCase();
    return loadAllPlayers()
      .filter((p) => {
        if (assignFilterByCountry && country) {
          if (p.country !== country) return false;
        }
        if (!q) return true;
        return p.canonicalName.toLowerCase().includes(q);
      })
      .slice(0, 200);
  });
</script>

<section class="tourns">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <AdminBulkBar
    count={selected.size}
    itemLabel="tournament"
    saving={saving}
    onConfirmDelete={performBulkDelete}
    onClearSelection={clearSelection}
  />

  <div class="topbar">
    <button
      type="button"
      class="btn btn-primary"
      onclick={openAdd}
      disabled={saving}
    >+ Add tournament</button>
  </div>

  <div class="controls">
    <input
      type="search"
      placeholder="Search tournaments…"
      bind:value={query}
      aria-label="Search tournaments"
    />
    <span class="count">{filtered().length}</span>
  </div>

  {#if filtered().length === 0}
    <p class="empty">
      {query ? 'No tournaments match that search.' : 'No tournaments yet.'}
    </p>
  {:else}
    <div class="select-hdr">
      <label class="sel-all">
        <input
          type="checkbox"
          checked={allSelected()}
          onchange={toggleSelectAll}
          aria-label={allSelected() ? 'Deselect all' : 'Select all'}
        />
        Select all
      </label>
    </div>
    <ul class="list">
      {#each filtered() as t (t.key)}
        <li class="row" class:row-selected={selected.has(t.key)}>
          {#if canManageTournament(t)}
            <label class="row-check">
              <input
                type="checkbox"
                checked={selected.has(t.key)}
                onchange={() => toggleSel(t.key)}
                aria-label={`Select ${t.name}`}
              />
            </label>
          {:else}
            <!-- Placeholder keeps the row grid aligned when the checkbox
                 is hidden for tournaments the organiser doesn't manage. -->
            <span class="row-check row-check-spacer" aria-hidden="true"></span>
          {/if}
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
                {#if t.type === 'closed'}
                  <span class="chip chip-closed" title="Closed tournament — country-scoped">
                    CLOSED
                  </span>
                {/if}
                {#if t.country}
                  <span class="chip chip-country" title={countryName(t.country)}>
                    {flagEmoji(t.country)} {countryName(t.country)}
                  </span>
                {/if}
                <span class="chip">key: <code>{t.key}</code></span>
                <span class="chip">last active {new Date(t.lastActive).toLocaleDateString()}</span>
              </div>
            </div>
            {#if canManageTournament(t)}
              <div class="row-actions">
                <button type="button" class="btn" onclick={() => startRename(t)}>Rename</button>
                <button type="button" class="btn" onclick={() => startManage(t)}>Organisers</button>
                {#if t.type === 'closed'}
                  <button type="button" class="btn" onclick={() => startAssign(t)}>Players</button>
                {/if}
                <button
                  type="button"
                  class="btn btn-danger"
                  onclick={() => startDelete(t.key)}
                >Delete</button>
              </div>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if deleteConfirmKey}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) cancelDelete(); }}>
      <div class="dialog-card">
        <h3>Delete tournament?</h3>
        <p>
          {#if deleteConfirmChildCount === null}
            Counting matches…
          {:else if deleteConfirmChildCount === 0}
            The tournament record will be removed. No matches are tagged under it.
          {:else}
            This will delete the tournament record <strong>and
            {deleteConfirmChildCount} tagged match{deleteConfirmChildCount === 1 ? '' : 'es'}</strong>.
            Matches you're not authorised to delete (e.g. from other
            organisers) will be skipped and left in place.
          {/if}
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

  {#if addingOpen}
    <!--
      Add-tournament dialog. Free-text name (max 60 chars); the
      tournament's key is derived server-side by normalizeKey().
      Doesn't require a match to be tagged — an organiser can be
      pre-assigned to an empty tournament and matches can start
      flowing in later via the setup screen.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-tourn-title"
      onclick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}
    >
      <div class="dialog-card dialog-card-wide">
        <h3 id="add-tourn-title">Add tournament</h3>
        <p>
          Tournaments are the top-level bucket for grouping matches.
          Choose <strong>open</strong> for casual events (any player,
          any umpire) or <strong>closed</strong> for a
          country-scoped event with an explicit assigned-player roster.
        </p>
        <input
          type="text"
          bind:value={addingName}
          placeholder="Tournament name"
          aria-label="Tournament name"
          maxlength="60"
        />
        <fieldset class="add-type">
          <legend>Type</legend>
          <label class="add-type-row">
            <input
              type="radio"
              name="add-tournament-type"
              value="open"
              bind:group={addingType}
            />
            <span>
              <strong>Open</strong>
              — casual event, no roster gating.
            </span>
          </label>
          <label class="add-type-row">
            <input
              type="radio"
              name="add-tournament-type"
              value="closed"
              bind:group={addingType}
            />
            <span>
              <strong>Closed</strong>
              — country-scoped, players assigned explicitly.
            </span>
          </label>
        </fieldset>
        {#if addingType === 'closed'}
          <label class="add-country-label">
            <span>Country</span>
            <CountrySelect
              bind:value={addingCountry}
              required
              ariaLabel="Tournament country"
            />
          </label>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={closeAdd} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={saveAdd}
            disabled={saving || !addingName.trim() || (addingType === 'closed' && !addingCountry)}
          >{saving ? 'Adding…' : 'Add'}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if assignOpen && assignKey}
    <!--
      Assigned Players dialog. Shows the identity-store roster, filtered
      by the tournament's country (toggle-off to see all), with a
      checkbox per row for assign/unassign. Reuses the shared /players
      subscription established by AdminPlayers, so the list is live-
      updated when someone adds a player in another tab.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-title"
      onclick={(e) => { if (e.target === e.currentTarget) stopAssign(); }}
    >
      <div class="dialog-card dialog-card-wide">
        <h3 id="assign-title">Assigned players</h3>
        {#await Promise.resolve(list().find((t) => t.key === assignKey)) then tournament}
          {#if tournament}
            <p>
              <strong>{tournament.name}</strong>
              {#if tournament.country}
                · {flagEmoji(tournament.country)} {countryName(tournament.country)}
              {/if}
              · {assignedIds.size} assigned
            </p>
          {/if}
        {/await}
        <div class="assign-controls">
          <input
            type="search"
            class="assign-search"
            bind:value={assignFilter}
            placeholder="Search players…"
            aria-label="Search players"
          />
          <label class="assign-country-filter">
            <input type="checkbox" bind:checked={assignFilterByCountry} />
            Match country only
          </label>
        </div>
        {#if assignLoading}
          <p class="empty">Loading assigned players…</p>
        {:else if assignCandidates().length === 0}
          <p class="empty">
            No matching players. Add players from the Players tab first.
          </p>
        {:else}
          <ul class="assign-list">
            {#each assignCandidates() as p (p.id)}
              <li class="assign-row">
                <label>
                  <input
                    type="checkbox"
                    checked={assignedIds.has(p.id)}
                    disabled={assignSaving}
                    onchange={() => togglePlayerAssignment(p.id)}
                  />
                  <span class="assign-name">{p.canonicalName}</span>
                  {#if p.country}
                    <span class="assign-country" title={countryName(p.country)}>
                      {flagEmoji(p.country)} {countryName(p.country)}
                    </span>
                  {/if}
                </label>
              </li>
            {/each}
          </ul>
        {/if}
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopAssign} disabled={assignSaving}>Done</button>
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

  /* Create-record button lives up top so it stays visible when the
     list is long and the bulk-action bar is sticky above. */
  .topbar {
    display: flex;
    justify-content: flex-end;
    padding: 0 0.25rem;
  }

  /* Search bar — same treatment as AdminPlayers / AdminHistoryCleanup. */
  .controls {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    margin-top: 0.5rem;
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

  /* Bulk-select header + row checkbox, matching AdminLiveCleanup. */
  .select-hdr {
    display: flex;
    justify-content: flex-start;
    padding: 0.25rem 0.5rem;
  }
  .sel-all {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .sel-all input {
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .row-check {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem;
    cursor: pointer;
  }
  .row-check input {
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .row-selected {
    background: rgba(255, 213, 74, 0.06) !important;
    border-color: rgba(255, 213, 74, 0.4) !important;
  }

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
    transition: background 0.12s, border-color 0.12s;
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
  /* Country chip — subtle accent tint, matches AdminPlayers row treatment. */
  .chip-country {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.3);
  }
  /* Closed-tournament chip — reads as identifying metadata alongside
     the country pill; a stronger accent that says "this tournament
     has roster gating." */
  .chip-closed {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.4);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
  }
  /* Radio group for open/closed on the add-tournament dialog. */
  fieldset.add-type {
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.45rem;
    padding: 0.5rem 0.7rem;
    margin: 0.5rem 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  fieldset.add-type legend {
    color: var(--muted);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0 0.35rem;
  }
  .add-type-row {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    font-size: 0.85rem;
    color: var(--fg);
    cursor: pointer;
  }
  .add-type-row input[type="radio"] {
    accent-color: var(--accent, #ffd54a);
    margin-top: 0.2rem;
  }
  .add-country-label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0 0 0.5rem;
    font-size: 0.85rem;
    color: var(--muted);
  }

  /* Assigned Players dialog */
  .assign-controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    margin: 0.5rem 0;
  }
  .assign-search {
    flex: 1;
    min-width: 12rem;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
  }
  .assign-country-filter {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: var(--muted);
    font-size: 0.8rem;
    cursor: pointer;
  }
  .assign-list {
    list-style: none;
    padding: 0;
    margin: 0.25rem 0;
    max-height: 55vh;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .assign-row label {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.4rem;
    cursor: pointer;
    color: var(--fg);
    font-size: 0.9rem;
  }
  .assign-row label:hover { background: rgba(255, 255, 255, 0.04); }
  .assign-row input[type="checkbox"] {
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .assign-name { flex: 1; }
  .assign-country {
    color: var(--muted);
    font-size: 0.75rem;
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
