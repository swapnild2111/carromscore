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
    createPlayer,
    isPlausibleName,
    updatePlayerName,
    updatePlayerCountry,
    deletePlayer,
    deletePlayers,
    mergePlayers,
    rankMatches,
    addAlias,
    removeAlias,
    normalize,
    type Player,
    type PlayerMatch,
  } from '../lib/players';
  import AdminBulkBar from './AdminBulkBar.svelte';
  import CountrySelect from './CountrySelect.svelte';
  import { countryName, flagEmoji } from '../lib/countries';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';

  /**
   * Current-user role gating (v3.3). Super sees every player row's
   * actions; organiser sees actions only on records they created.
   * `canManagePlayer(p)` mirrors AdminTournaments's
   * `canManageTournament(t)` pattern — the RTDB rule at
   * `/players/{id}` is the actual enforcement; UI gating is UX only.
   */
  let role = $state<Role | null>(null);
  function canManagePlayer(p: Player): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    if (!role.isOrganiser) return false;
    const myUid = currentUser()?.uid;
    return !!(myUid && p.createdBy === myUid);
  }

  let tick = $state(0);
  let query = $state('');
  let renamingId = $state<string | null>(null);
  let renameValue = $state('');
  let deleteConfirmId = $state<string | null>(null);
  let deleteConfirmText = $state('');
  let mergeCanonicalId = $state<string | null>(null);
  let mergeIntoId = $state<string | null>(null);
  let mergeConfirmText = $state('');

  /**
   * Per-player Edit dialog state (v3.1). Consolidates rename +
   * country + alias-management in a single flow — the inline
   * rename UI (renamingId/renameValue) is still supported for the
   * fast path but the primary edit affordance now opens this
   * dialog. `editingId` is null when the dialog is closed. The
   * dialog reads the player fresh from `list().find(id)` each
   * render so identity-store updates from another tab are picked
   * up without a manual reload.
   */
  let editingId = $state<string | null>(null);
  let editName = $state('');
  let editCountry = $state('');
  /** Buffer for the "Add alias" input inside the Edit dialog.
   *  Kept separate from the top-of-page free-text ranker input
   *  so state doesn't cross-contaminate. */
  let editAliasBuffer = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  /** Selected player IDs for bulk delete. Merge is one-at-a-time. */
  let selected = $state<Set<string>>(new Set());
  /**
   * Add-players dialog state. Bulk-capable — the input is a textarea
   * accepting comma-separated or newline-separated names. On Analyse
   * (or explicit "next" from the parse screen) each candidate is
   * ranked against the roster; anything with an existing exact or
   * fuzzy hit becomes a conflict the admin has to resolve per row.
   * Clean candidates create normally at commit time.
   */
  let addingOpen = $state(false);
  let addingInput = $state('');
  /** Country applied to every player in the current bulk-add batch.
   *  Whole-batch scope: a batch is usually a club roster / delegation,
   *  which share a country. Mandatory; blocks the Add button when
   *  empty. Age/email/phone were considered but dropped — see the
   *  Player type in src/lib/players.ts for optional fields still in
   *  the schema (they land on records but the admin flow doesn't
   *  set them). */
  let addingCountry = $state('');

  /** One decision the admin has to make about a candidate name that
   *  matches an existing player. */
  type ConflictAction = 'create' | 'alias' | 'skip';
  type Conflict = {
    /** Umpire-typed candidate. Kept as typed for the alias write. */
    typed: string;
    /** Top-ranked existing match (exact or fuzzy). */
    match: PlayerMatch;
    /** Runner-up matches (max 2) so the admin can see alternatives. */
    alternates: PlayerMatch[];
    /** Chosen action; defaults to 'alias' for exact hits (safe merge)
     *  and 'create' for fuzzy hits (safer to keep separate; user can
     *  flip to alias if intended). */
    action: ConflictAction;
    /** If action === 'alias', which player id to attach the alias to.
     *  Defaults to match.player.id but the admin can pick an alternate. */
    aliasTargetId: string;
  };
  let conflicts = $state<Conflict[]>([]);
  /** Candidates with no ranked match — safe to create as new records. */
  let cleanCandidates = $state<string[]>([]);
  /**
   * Which "screen" of the dialog we're on:
   *   'input'    — textarea + Analyse button
   *   'resolve'  — one row per conflict + summary of clean creates
   *   No conflicts → skip 'resolve' entirely; commit directly.
   */
  let addStep = $state<'input' | 'resolve'>('input');

  onMount(() => {
    void subscribePlayers();
    const unsub = subscribeStore(() => (tick += 1));
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    return () => {
      unsub();
      unsubRole();
    };
  });

  const filtered = $derived(() => {
    void tick;
    const q = query.trim().toLowerCase();
    let all = loadAll();
    // v3.6.2: organisers see the FULL roster (everyone's players), not
    // just their own. Rationale: a name-clash resolution (alias-onto-
    // existing) needs the organiser to see records they didn't create
    // as candidates. Row-level actions (rename/delete) stay gated to
    // canManagePlayer(p) which respects createdBy. Non-organisers still
    // see nothing — the admin page isn't for them.
    if (role && !role.isSuper && !role.isOrganiser) {
      all = [];
    }
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

  // ─── Edit Player dialog ────────────────────────────────────────

  function startEdit(p: Player) {
    editingId = p.id;
    editName = p.canonicalName;
    editCountry = p.country ?? '';
    editAliasBuffer = '';
  }
  function stopEdit() {
    editingId = null;
    editName = '';
    editCountry = '';
    editAliasBuffer = '';
  }
  /** Reactive lookup of the currently-edited player from the store,
   *  so alias-list additions/removals reflect immediately. */
  const editingPlayer = $derived<Player | null>(() => {
    void tick;
    if (!editingId) return null;
    return loadAll().find((p) => p.id === editingId) ?? null;
  });

  /**
   * True when either the Name or Country buffer differs from the
   * current stored value — enables the bottom Save button. Aliases
   * are add/remove actions with their own inline commit, so they
   * don't feed into this dirty flag.
   */
  const editDirty = $derived<boolean>(() => {
    void tick;
    const p = editingPlayer();
    if (!p) return false;
    const nameChanged = editName.trim() !== p.canonicalName && !!editName.trim();
    const countryChanged = editCountry.trim() !== (p.country ?? '');
    return nameChanged || countryChanged;
  });

  /**
   * Single save action for the Edit dialog: commits any field that
   * has changed. Runs name update first (it may block on the
   * isPlausibleName check); country second. Each field's failure is
   * flashed independently so a name-error doesn't hide a
   * country-success. Dialog stays open after save — admin can
   * continue editing aliases or make more changes.
   */
  async function saveEdit() {
    if (!editingId) return;
    const current = editingPlayer();
    if (!current) return;
    saving = true;
    let anyChanged = false;
    const results: string[] = [];
    try {
      const nameTrim = editName.trim();
      if (nameTrim && nameTrim !== current.canonicalName) {
        const r = await updatePlayerName(editingId, nameTrim);
        if (r.ok) {
          anyChanged = true;
          results.push('name');
        } else {
          flash('err', `Name: ${r.error}`);
        }
      }
      const countryTrim = editCountry.trim();
      if (countryTrim !== (current.country ?? '')) {
        const r = await updatePlayerCountry(editingId, countryTrim);
        if (r.ok) {
          anyChanged = true;
          results.push('country');
        } else {
          flash('err', `Country: ${r.error}`);
        }
      }
    } finally {
      saving = false;
    }
    if (anyChanged) {
      flash('ok', `Saved: ${results.join(', ')}`);
    }
  }
  async function saveEditAddAlias() {
    if (!editingId) return;
    const raw = editAliasBuffer.trim();
    if (!raw) return;
    saving = true;
    const p = addAlias(editingId, raw);
    saving = false;
    if (p) {
      editAliasBuffer = '';
      flash('ok', 'Alias added');
    } else {
      flash('err', 'Could not add alias');
    }
  }
  async function saveEditRemoveAlias(aliasKey: string) {
    if (!editingId) return;
    saving = true;
    const outcome = await removeAlias(editingId, aliasKey);
    saving = false;
    if (outcome.ok) flash('ok', 'Alias removed');
    else flash('err', outcome.error);
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

  function toggleSel(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    // v3.3: restrict select-all to rows the current user can actually
    // delete — otherwise bulk-delete would partial-fail on records
    // super or another organiser created.
    const rows = filtered().filter((p) => canManagePlayer(p));
    if (rows.length > 0 && rows.every((p) => selected.has(p.id))) {
      selected = new Set();
    } else {
      selected = new Set(rows.map((p) => p.id));
    }
  }
  function clearSelection() {
    selected = new Set();
  }
  async function performBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    saving = true;
    const outcome = await deletePlayers(ids);
    saving = false;
    if (outcome.ok) {
      flash('ok', `${outcome.deleted} player${outcome.deleted === 1 ? '' : 's'} deleted`);
    } else {
      flash(
        'err',
        `${outcome.deleted} deleted, ${outcome.failed} failed${outcome.error ? ` — ${outcome.error}` : ''}`,
      );
    }
    selected = new Set();
  }

  const allSelected = $derived(() => {
    void tick;
    // Same restriction as toggleSelectAll — the "Select all" checkbox
    // only reflects state across rows the current user can delete.
    const rows = filtered().filter((p) => canManagePlayer(p));
    return rows.length > 0 && rows.every((p) => selected.has(p.id));
  });

  function openAdd() {
    addingOpen = true;
    addingInput = '';
    addingCountry = '';
    conflicts = [];
    cleanCandidates = [];
    addStep = 'input';
  }
  function closeAdd() {
    addingOpen = false;
    addingInput = '';
    addingCountry = '';
    conflicts = [];
    cleanCandidates = [];
    addStep = 'input';
  }

  /**
   * Split the textarea contents into candidate names. Accepts commas,
   * newlines, or both as separators. Trims each entry, drops empties,
   * dedupes within the batch (case-insensitive on the normalised form).
   */
  function parseCandidates(raw: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of raw.split(/[,\n]/)) {
      const t = part.trim();
      if (!t) continue;
      const key = t.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  /**
   * Classify each parsed candidate against the roster:
   *   - No ranked hit → cleanCandidates (create as new).
   *   - Exact or fuzzy hit → conflicts (admin resolves per row).
   *   - Prefix-only hit → also a conflict (surface for review; a
   *     prefix match usually means the admin typed a shorter form
   *     of an existing name).
   *
   * Silently drops isPlausibleName failures with a flash banner
   * summarising how many were dropped.
   */
  function analyseAdd() {
    if (!addingCountry) {
      flash('err', 'Please select a country');
      return;
    }
    const raw = addingInput;
    const parsed = parseCandidates(raw);
    if (parsed.length === 0) {
      flash('err', 'No names to add');
      return;
    }
    const roster = loadAll();
    const nextConflicts: Conflict[] = [];
    const nextClean: string[] = [];
    let dropped = 0;
    for (const typed of parsed) {
      if (!isPlausibleName(typed)) {
        dropped += 1;
        continue;
      }
      const hits = rankMatches(roster, typed, 3);
      if (hits.length === 0) {
        nextClean.push(typed);
        continue;
      }
      const top = hits[0];
      // Default action:
      //   - Exact match with a country mismatch → create (they're
      //     namesakes from different countries — legitimately distinct
      //     records. Reported 2026-08-18: adding "Swapnil Deshpande" (SE)
      //     when DK/IN already existed silently aliased into the first
      //     match and never became its own record).
      //   - Exact match with same-or-blank country → alias (safe merge).
      //   - Fuzzy / prefix → create (admin flips to alias explicitly
      //     when they know it's the same person).
      const topCountry = top.player.country ? top.player.country.trim() : '';
      const batchCountry = addingCountry ? addingCountry.trim() : '';
      const countryMismatch =
        top.rank === 'exact' && batchCountry !== '' && topCountry !== '' && batchCountry !== topCountry;
      const defaultAction: ConflictAction =
        top.rank === 'exact' && !countryMismatch ? 'alias' : 'create';
      nextConflicts.push({
        typed,
        match: top,
        alternates: hits.slice(1),
        action: defaultAction,
        aliasTargetId: top.player.id,
      });
    }
    conflicts = nextConflicts;
    cleanCandidates = nextClean;
    if (dropped > 0) {
      flash(
        'err',
        `${dropped} name${dropped === 1 ? '' : 's'} skipped — too short or not plausible`,
      );
    }
    // No conflicts to resolve → commit directly. Any dropped-invalid
    // names already flashed; a clean-only batch just runs.
    if (nextConflicts.length === 0) {
      void commitAdd();
      return;
    }
    addStep = 'resolve';
  }

  /**
   * Apply the plan built by analyseAdd + any admin overrides on
   * conflicts. Creates run first (cheap, local + fire-and-forget
   * Firebase), then aliases (cheap same-record write). Skips do
   * nothing. Errors on individual items don't halt the batch — the
   * summary at the end reports counts.
   */
  async function commitAdd() {
    saving = true;
    // Snapshot the batch-shared country at commit time so a race with
    // a follow-up dialog change can't leak between batches.
    // Snapshot the batch country at commit time so a race with a
    // follow-up dialog change can't leak between batches. Country
    // is mandatory; no other player-level metadata is captured at
    // add time (v3.1 scope: name + country only).
    const batchCountry = addingCountry;
    const meta = batchCountry ? { country: batchCountry } : {};
    let created = 0;
    let aliased = 0;
    let skipped = 0;
    let failed = 0;
    // v3.3: createPlayer is async and returns { ok, error }. RTDB
    // rule denials (organiser without organiserRoles entry, missing
    // createdBy stamp on legacy record, etc.) flip ok:false and the
    // local push has already been rolled back — count them as
    // failed rather than as successful creates.
    let firstError: string | undefined;
    try {
      // 1) Clean candidates → straight create (with batch country).
      for (const typed of cleanCandidates) {
        const r = await createPlayer(typed, meta);
        if (r.ok) created += 1;
        else {
          failed += 1;
          if (!firstError) firstError = r.error;
        }
      }
      // 2) Resolved conflicts.
      for (const c of conflicts) {
        if (c.action === 'skip') {
          skipped += 1;
          continue;
        }
        if (c.action === 'create') {
          const r = await createPlayer(c.typed, meta);
          if (r.ok) created += 1;
          else {
            failed += 1;
            if (!firstError) firstError = r.error;
          }
          continue;
        }
        // action === 'alias' — no country on aliases; alias attaches
        // to an existing canonical player whose country is what
        // matters.
        const target = c.aliasTargetId;
        if (!target) {
          failed += 1;
          continue;
        }
        const p = addAlias(target, c.typed);
        if (p) aliased += 1;
        else failed += 1;
      }
    } finally {
      saving = false;
    }
    const parts: string[] = [];
    if (created) parts.push(`${created} created`);
    if (aliased) parts.push(`${aliased} aliased`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    const summary = parts.length ? parts.join(', ') : 'Nothing to do';
    const message = failed && firstError ? `${summary} — ${firstError}` : summary;
    flash(failed ? 'err' : 'ok', message);
    closeAdd();
  }
</script>

<section class="players">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <AdminBulkBar
    count={selected.size}
    itemLabel="player"
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
    >+ Add players</button>
  </div>

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
    <div class="select-hdr">
      <label class="sel-all">
        <input
          type="checkbox"
          checked={allSelected()}
          onchange={toggleSelectAll}
          aria-label={allSelected() ? 'Deselect all' : 'Select all visible'}
        />
        Select all
      </label>
    </div>
    <ul class="list">
      {#each filtered() as p (p.id)}
        {@const manageable = canManagePlayer(p)}
        <li class="row" class:row-selected={selected.has(p.id)}>
          {#if manageable}
            <label class="row-check">
              <input
                type="checkbox"
                checked={selected.has(p.id)}
                onchange={() => toggleSel(p.id)}
                aria-label={`Select ${p.canonicalName}`}
              />
            </label>
          {:else}
            <!-- Placeholder keeps the row grid aligned when the
                 checkbox is hidden for records the organiser didn't
                 create (v3.3 own-only auth). -->
            <span class="row-check row-check-spacer" aria-hidden="true"></span>
          {/if}
          <div class="row-name">
              <div class="row-name-text">{p.canonicalName}</div>
              <div class="row-name-meta">
                {#if p.country}
                  <span class="chip chip-country" title={countryName(p.country)}>
                    {#if flagEmoji(p.country)}
                      <span aria-hidden="true">{flagEmoji(p.country)}</span>
                    {/if}
                    {countryName(p.country)}
                  </span>
                {/if}
                {#if Object.keys(p.aliases).length > 0}
                  <span class="chip">{Object.keys(p.aliases).length} alias{Object.keys(p.aliases).length === 1 ? '' : 'es'}</span>
                {/if}
                {#if !manageable}
                  <!--
                    v3.6.2: read-only marker so organisers understand
                    why they see the row without action buttons — this
                    is another organiser's or super's record. They can
                    still alias-onto-it from the Add dialog.
                  -->
                  <span class="chip chip-readonly" title="Created by another organiser — read-only for you">
                    read-only
                  </span>
                {/if}
              </div>
            </div>
            {#if manageable}
              <div class="row-actions">
                <button type="button" class="btn btn-primary" onclick={() => startEdit(p)}>Edit</button>
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

  {#if editingId && editingPlayer()}
    <!--
      Edit Player dialog. Three sections:
        Name     — inline "Save" per-field so partial edits commit
                   independently.
        Country  — <CountrySelect>; save button appears when dirty.
        Aliases  — list of current alias keys with a remove button
                   per row; free-text input at the bottom to add.
      Backing store updates fire flash toasts. The dialog stays open
      after any save so an admin can make several changes in one
      sitting. Close via the Done button or backdrop click.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-player-title"
      onclick={(e) => { if (e.target === e.currentTarget) stopEdit(); }}
    >
      <div class="dialog-card dialog-card-wide">
        <h3 id="edit-player-title">Edit player</h3>
        <p class="dialog-lead">
          <code class="edit-id">{editingPlayer()?.id}</code>
        </p>

        <label class="edit-field">
          <span>Name</span>
          <input
            type="text"
            bind:value={editName}
            aria-label="Player name"
            maxlength="60"
          />
        </label>

        <label class="edit-field">
          <span>Country</span>
          <CountrySelect bind:value={editCountry} ariaLabel="Player country" />
        </label>

        {#if editingPlayer()}
          {@const aliasKeys = Object.keys(editingPlayer()?.aliases ?? {})}
          <div class="edit-field">
            <span>Aliases</span>
            {#if aliasKeys.length === 0}
              <p class="edit-empty">
                No aliases yet. Aliases are alternate spellings that
                resolve to this player during match Setup.
              </p>
            {:else}
              <ul class="edit-alias-list">
                {#each aliasKeys as key (key)}
                  <li class="edit-alias-row">
                    <code>{key}</code>
                    <button
                      type="button"
                      class="btn btn-sm btn-danger"
                      onclick={() => saveEditRemoveAlias(key)}
                      disabled={saving}
                    >Remove</button>
                  </li>
                {/each}
              </ul>
            {/if}
            <div class="edit-row">
              <input
                type="text"
                bind:value={editAliasBuffer}
                placeholder="Add alias (typed form)"
                aria-label="New alias"
                maxlength="60"
              />
              <button
                type="button"
                class="btn"
                onclick={saveEditAddAlias}
                disabled={saving || !editAliasBuffer.trim()}
              >Add</button>
            </div>
          </div>
        {/if}

        <div class="edit-danger">
          <!--
            Merge lives inside Edit rather than as a top-level row
            action from v3.1 forward — the home-form auto-create is
            off since v3.0, so duplicates are rare (only two admins
            adding the same player simultaneously). Kept here for
            legacy clean-up + those rare races.
          -->
          <button
            type="button"
            class="btn"
            onclick={() => {
              const id = editingId;
              stopEdit();
              if (id) startMerge(id);
            }}
            disabled={saving}
          >Merge this player into another…</button>
        </div>

        <div class="dialog-actions">
          <button type="button" class="btn" onclick={stopEdit} disabled={saving}>Close</button>
          <button
            type="button"
            class="btn btn-primary"
            onclick={async () => {
              await saveEdit();
              stopEdit();
            }}
            disabled={saving || !editDirty()}
          >{saving ? 'Saving…' : 'Save changes'}</button>
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

  {#if addingOpen}
    <!--
      Add-player dialog. Free-text name; createPlayer's
      Bulk-add players. Textarea accepts comma-separated or newline-
      separated names. On Analyse, each candidate is ranked against
      the roster (see rankMatches in src/lib/players.ts); anything
      with an exact or fuzzy match becomes a conflict the admin has
      to resolve on the second screen. Clean candidates create
      straight through. Skipped names never touch Firebase.
    -->
    <div
      class="dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-player-title"
      onclick={(e) => { if (e.target === e.currentTarget) closeAdd(); }}
    >
      <div class="dialog-card dialog-card-wide">
        {#if addStep === 'input'}
          <h3 id="add-player-title">Add players</h3>
          <p>
            Add one or many players to the shared roster. Enter names
            <strong>comma-separated</strong> (<code>Ravi K, Priya M, Nirmal S</code>)
            or one name per line — mix both if it's easier. On the next
            screen you'll resolve any names that already exist in the
            roster.
          </p>
          <label class="add-country-label">
            <span>Country (applied to every player in this batch)</span>
            <CountrySelect
              bind:value={addingCountry}
              required
              ariaLabel="Batch country"
            />
          </label>
          <textarea
            class="add-textarea"
            bind:value={addingInput}
            placeholder={'Ravi K, Priya M, Nirmal S\nDee K'}
            aria-label="Player names"
            rows="5"
          ></textarea>
          <div class="dialog-actions">
            <button type="button" class="btn" onclick={closeAdd} disabled={saving}>Cancel</button>
            <button
              type="button"
              class="btn btn-primary"
              onclick={analyseAdd}
              disabled={saving || !addingInput.trim() || !addingCountry}
            >{saving ? 'Adding…' : 'Add'}</button>
          </div>
        {:else}
          <h3 id="add-player-title">Resolve conflicts</h3>
          <p>
            {conflicts.length} name{conflicts.length === 1 ? '' : 's'}
            match{conflicts.length === 1 ? 'es' : ''} an existing player.
            Choose an action per row.
            {#if cleanCandidates.length > 0}
              <span class="muted-inline">
                · {cleanCandidates.length} clean name{cleanCandidates.length === 1 ? '' : 's'} will create as new.
              </span>
            {/if}
          </p>
          <ul class="conflict-list">
            {#each conflicts as c, i (c.typed + '|' + c.match.player.id)}
              <li class="conflict-row">
                <div class="conflict-hdr">
                  <span class="conflict-typed">"{c.typed}"</span>
                  <span class="conflict-rank chip">{c.match.rank}</span>
                </div>
                <div class="conflict-body">
                  <p class="conflict-sub">
                    Existing: <strong>{c.match.player.canonicalName}</strong>
                    <code class="conflict-id">{c.match.player.id}</code>
                  </p>
                  {#if c.alternates.length > 0}
                    <p class="conflict-alt">
                      Also matches:
                      {#each c.alternates as alt, ai (alt.player.id)}
                        <span class="conflict-alt-item">
                          {alt.player.canonicalName}
                          <span class="chip">{alt.rank}</span>
                        </span>{ai < c.alternates.length - 1 ? ', ' : ''}
                      {/each}
                    </p>
                  {/if}
                  <div class="conflict-actions">
                    <label class="radio">
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        checked={c.action === 'create'}
                        onchange={() => (conflicts[i].action = 'create')}
                      />
                      Create as new
                    </label>
                    <label class="radio">
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        checked={c.action === 'alias'}
                        onchange={() => (conflicts[i].action = 'alias')}
                      />
                      Add as alias of
                      <select
                        class="conflict-target"
                        bind:value={conflicts[i].aliasTargetId}
                        disabled={c.action !== 'alias'}
                      >
                        <option value={c.match.player.id}>{c.match.player.canonicalName}</option>
                        {#each c.alternates as alt (alt.player.id)}
                          <option value={alt.player.id}>{alt.player.canonicalName}</option>
                        {/each}
                      </select>
                    </label>
                    <label class="radio">
                      <input
                        type="radio"
                        name={`conflict-${i}`}
                        checked={c.action === 'skip'}
                        onchange={() => (conflicts[i].action = 'skip')}
                      />
                      Skip
                    </label>
                  </div>
                </div>
              </li>
            {/each}
          </ul>
          <div class="dialog-actions">
            <button type="button" class="btn" onclick={() => (addStep = 'input')} disabled={saving}>Back</button>
            <button
              type="button"
              class="btn btn-primary"
              onclick={commitAdd}
              disabled={saving}
            >{saving ? 'Applying…' : 'Apply'}</button>
          </div>
        {/if}
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

  /* Create-record button lives up top so it stays visible even
     when the list is scrolled and the sticky bulk-bar covers the
     upper edge. Right-aligned for parity with AdminTournaments. */
  .topbar {
    display: flex;
    justify-content: flex-end;
    padding: 0 0.25rem;
  }

  /* Bulk-select header + row checkbox, matching AdminLiveCleanup /
     AdminTournaments so the three admin lists behave identically. */
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
    transition: background 0.12s, border-color 0.12s;
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
  /* Country chip carries a subtle accent tint so it reads as
     identifying-metadata (higher signal than the id/alias chips). */
  .chip-country {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.3);
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  /* Read-only marker for player rows an organiser can't manage
     (created by another organiser or a super). Muted grey so it
     doesn't compete with the country chip. */
  .chip-readonly {
    color: var(--muted, #9aa0a6);
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.12);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 700;
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

  /* Edit Player dialog. Three sections: Name, Country, Aliases —
     each self-contained with an inline Save button that only enables
     when the field is dirty. */
  .dialog-lead {
    margin: 0.25rem 0 0.75rem;
    font-size: 0.75rem;
    color: var(--muted);
  }
  .edit-id {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.1rem 0.4rem;
    border-radius: 0.3rem;
    font-size: 0.8em;
  }
  .edit-field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin: 0.5rem 0 0.85rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  .edit-field > span:first-child {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.7rem;
  }
  .edit-row {
    display: flex;
    gap: 0.35rem;
    align-items: center;
    min-width: 0;
  }
  .edit-row input {
    flex: 1;
    min-width: 0;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.45rem 0.55rem;
    font: inherit;
    font-size: 0.9rem;
  }
  .edit-row input:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  .edit-empty {
    color: var(--muted);
    font-size: 0.8rem;
    font-style: italic;
    margin: 0.1rem 0 0.35rem;
  }
  .edit-alias-list {
    list-style: none;
    padding: 0;
    margin: 0 0 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .edit-alias-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.55rem;
    background: rgba(255, 255, 255, 0.04);
    border-radius: 0.4rem;
  }
  .edit-alias-row code {
    flex: 1;
    color: var(--fg);
    font-size: 0.8rem;
  }
  .btn-sm {
    padding: 0.25rem 0.6rem;
    font-size: 0.72rem;
  }
  /* Bottom section of the Edit dialog for rare / legacy operations
     (merge into another player). Visually separated with a subtle
     top divider so it reads as an "advanced" area rather than a
     primary action. */
  .edit-danger {
    margin: 0.75rem 0 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
  }

  /* Batch-country label above the textarea. Same spacing as the
     dialog's body paragraphs. */
  .add-country-label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin: 0.5rem 0 0.75rem;
    font-size: 0.85rem;
    color: var(--muted);
  }
  /* Bulk-add textarea. Same visual language as .dialog-card input[type=text];
     multi-line so it fits comma + newline batches without a scroll bar. */
  .add-textarea {
    width: 100%;
    box-sizing: border-box;
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    resize: vertical;
    min-height: 5.5rem;
  }
  .add-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* Muted inline hint used in the conflict-screen header. */
  .muted-inline {
    color: var(--muted);
  }

  /* Conflict list — one card per candidate that matched an existing
     player. Small, dense, focused on the decision to make. */
  .conflict-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    /* Enough vertical space for ~5 conflicts before this list
       itself scrolls inside the dialog card. */
    max-height: 60vh;
    overflow-y: auto;
  }
  .conflict-row {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    padding: 0.55rem 0.7rem;
  }
  .conflict-hdr {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }
  .conflict-typed {
    color: var(--fg);
    font-weight: 700;
    font-size: 0.95rem;
  }
  .conflict-rank {
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.06em;
  }
  .conflict-sub {
    margin: 0 0 0.25rem;
    color: var(--muted);
    font-size: 0.85rem;
  }
  .conflict-sub strong {
    color: var(--fg);
    font-weight: 700;
  }
  .conflict-id {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.05rem 0.35rem;
    border-radius: 0.3rem;
    font-size: 0.72rem;
    margin-left: 0.35rem;
  }
  .conflict-alt {
    margin: 0 0 0.35rem;
    color: var(--muted);
    font-size: 0.78rem;
  }
  .conflict-alt-item {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .conflict-actions {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    margin-top: 0.35rem;
  }
  .conflict-actions .radio {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: var(--fg);
    font-size: 0.85rem;
    cursor: pointer;
    /* Wrap "Add as alias of [dropdown]" nicely on narrow viewports. */
    flex-wrap: wrap;
  }
  .conflict-actions input[type="radio"] {
    accent-color: var(--accent);
    cursor: pointer;
  }
  .conflict-target {
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.35rem;
    padding: 0.2rem 0.4rem;
    font: inherit;
    font-size: 0.85rem;
  }
  .conflict-target:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
