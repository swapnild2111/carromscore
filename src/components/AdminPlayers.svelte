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
    deletePlayer,
    deletePlayers,
    mergePlayers,
    rankMatches,
    addAlias,
    type Player,
    type PlayerMatch,
  } from '../lib/players';
  import AdminBulkBar from './AdminBulkBar.svelte';
  import CountrySelect from './CountrySelect.svelte';
  import { countryName, flagEmoji } from '../lib/countries';

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
   *  which share a country. Individual overrides come later via a
   *  per-record edit dialog (v3.2). Mandatory; blocks the Add button
   *  when empty. */
  let addingCountry = $state('');
  /**
   * Optional per-batch metadata. The bulk-add flow was designed as
   * "one country per batch"; the optional age/email/phone fields
   * follow the same "if you enter it, it applies to every player in
   * the batch" rule. Rare use case (usually blank on a bulk paste
   * from a delegation roster), so the fields are collapsed by
   * default behind a "More details" toggle to keep the fast path
   * fast. All three are optional; email + phone are strings, age is
   * a number 0-120.
   */
  let addingMoreOpen = $state(false);
  let addingAge = $state<string>('');
  let addingEmail = $state('');
  let addingPhone = $state('');

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

  function toggleSel(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    const rows = filtered();
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
    const rows = filtered();
    return rows.length > 0 && rows.every((p) => selected.has(p.id));
  });

  function openAdd() {
    addingOpen = true;
    addingInput = '';
    addingCountry = '';
    addingMoreOpen = false;
    addingAge = '';
    addingEmail = '';
    addingPhone = '';
    conflicts = [];
    cleanCandidates = [];
    addStep = 'input';
  }
  function closeAdd() {
    addingOpen = false;
    addingInput = '';
    addingCountry = '';
    addingMoreOpen = false;
    addingAge = '';
    addingEmail = '';
    addingPhone = '';
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
      // Default action: exact match → alias (safe merge — the
      // umpire typed a name identical after normalisation to an
      // existing player, so we should link, not duplicate). Fuzzy
      // and prefix → create (safer to keep separate; admin flips
      // to alias explicitly when they know it's the same person).
      const defaultAction: ConflictAction =
        top.rank === 'exact' ? 'alias' : 'create';
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
    // Snapshot the batch metadata at commit time so a race with a
    // follow-up dialog change can't leak between batches. Country
    // is mandatory; the optional fields land on every player in the
    // batch only when the "More details" toggle is used AND the
    // field has a value.
    const batchCountry = addingCountry;
    const batchAgeRaw = addingAge.trim();
    const batchAgeNum = batchAgeRaw ? Number(batchAgeRaw) : NaN;
    const batchEmail = addingEmail.trim();
    const batchPhone = addingPhone.trim();
    const meta: {
      country?: string;
      age?: number;
      email?: string;
      phone?: string;
    } = {};
    if (batchCountry) meta.country = batchCountry;
    if (Number.isFinite(batchAgeNum) && batchAgeNum >= 0 && batchAgeNum <= 120) {
      meta.age = batchAgeNum;
    }
    if (batchEmail) meta.email = batchEmail;
    if (batchPhone) meta.phone = batchPhone;
    let created = 0;
    let aliased = 0;
    let skipped = 0;
    let failed = 0;
    try {
      // 1) Clean candidates → straight create (with batch country).
      for (const typed of cleanCandidates) {
        try {
          createPlayer(typed, meta);
          created += 1;
        } catch {
          failed += 1;
        }
      }
      // 2) Resolved conflicts.
      for (const c of conflicts) {
        try {
          if (c.action === 'skip') {
            skipped += 1;
            continue;
          }
          if (c.action === 'create') {
            createPlayer(c.typed, meta);
            created += 1;
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
        } catch {
          failed += 1;
        }
      }
    } finally {
      saving = false;
    }
    const parts: string[] = [];
    if (created) parts.push(`${created} created`);
    if (aliased) parts.push(`${aliased} aliased`);
    if (skipped) parts.push(`${skipped} skipped`);
    if (failed) parts.push(`${failed} failed`);
    flash(failed ? 'err' : 'ok', parts.length ? parts.join(', ') : 'Nothing to do');
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
        <li class="row" class:row-selected={selected.has(p.id)}>
          <label class="row-check">
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onchange={() => toggleSel(p.id)}
              aria-label={`Select ${p.canonicalName}`}
            />
          </label>
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
                {#if p.country}
                  <span class="chip chip-country" title={countryName(p.country)}>
                    <span aria-hidden="true">{flagEmoji(p.country)}</span>
                    {countryName(p.country)}
                  </span>
                {/if}
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
          <button
            type="button"
            class="more-details-toggle"
            onclick={() => (addingMoreOpen = !addingMoreOpen)}
          >
            {addingMoreOpen ? '▾' : '▸'} More details (age / email / phone — applied to every player in this batch)
          </button>
          {#if addingMoreOpen}
            <div class="more-details">
              <label class="more-field">
                <span>Age</span>
                <input
                  type="number"
                  min="0"
                  max="120"
                  bind:value={addingAge}
                  aria-label="Batch age"
                />
              </label>
              <label class="more-field">
                <span>Email</span>
                <input
                  type="email"
                  bind:value={addingEmail}
                  maxlength="128"
                  aria-label="Batch email"
                />
              </label>
              <label class="more-field">
                <span>Phone</span>
                <input
                  type="tel"
                  bind:value={addingPhone}
                  maxlength="32"
                  aria-label="Batch phone"
                />
              </label>
              <p class="more-hint">
                Optional. Only fill these when the batch is a single
                person — otherwise leave blank and edit per record
                later.
              </p>
            </div>
          {/if}
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
  /* Collapsed "More details" toggle above the textarea's action row.
     Discloses the optional age/email/phone fields when expanded. */
  .more-details-toggle {
    background: transparent;
    border: 0;
    padding: 0.4rem 0;
    color: var(--muted);
    font: inherit;
    font-size: 0.78rem;
    text-align: left;
    cursor: pointer;
    width: 100%;
  }
  .more-details-toggle:hover { color: var(--fg); }
  .more-details {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.4rem;
    margin: 0 0 0.5rem;
  }
  .more-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.8rem;
    color: var(--muted);
  }
  .more-field input {
    background: #0f0f0f;
    color: var(--fg);
    border: 1px solid #2a2a2a;
    border-radius: 0.4rem;
    padding: 0.4rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
  }
  .more-field input:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  .more-hint {
    font-size: 0.72rem;
    color: var(--muted);
    margin: 0;
    line-height: 1.4;
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
