<script lang="ts">
  /**
   * Admin — History cleanup tab.
   *
   * Flat list of every archived match, sorted by endedAt DESC.
   * Search filters by player name or tournament tag. Multi-select
   * + bulk delete via the shared AdminBulkBar; single-row delete
   * still available on each row.
   *
   * Doesn't group by tournament (that's how the /live/ lobby
   * renders); the admin surface is denser and search does the
   * grouping-by-hand when the maintainer needs it.
   */
  import { onMount } from 'svelte';
  import {
    loadHistory,
    deleteMatch,
    deleteMatches,
    playerName,
    type MatchRecord,
  } from '../lib/history';
  import { subscribePlayers, subscribeStore } from '../lib/players';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';
  import AdminBulkBar from './AdminBulkBar.svelte';

  let matches = $state<MatchRecord[]>([]);
  let loading = $state(true);
  let query = $state('');
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let selected = $state<Set<string>>(new Set());
  let confirmId = $state<string | null>(null);
  let identityTick = $state(0);
  let role = $state<Role | null>(null);

  /**
   * Mirrors the /matches/{id} delete rule for UI gating: super, or
   * organiser of the record's tournamentKey, or the record's creator.
   * The rule also allows time-decayed deletes for old records; we do
   * NOT surface that in the UI (it's a stranding-prevention fallback,
   * not a common action) — organisers who need to delete a very old
   * record another way can ping a super. Rows outside these categories
   * still hide their Delete affordance; RTDB is the actual enforcement.
   */
  function canDeleteMatch(m: MatchRecord): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    if (m.tournamentKey && role.organiserOf.has(m.tournamentKey)) return true;
    const uid = currentUser()?.uid;
    if (uid && m.createdBy === uid) return true;
    return false;
  }

  onMount(() => {
    void subscribePlayers();
    const unsubStore = subscribeStore(() => (identityTick += 1));
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    void reload();
    return () => {
      unsubStore();
      unsubRole();
    };
  });

  async function reload() {
    loading = true;
    matches = await loadHistory();
    loading = false;
  }

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 4000);
  }

  function sideNameMatch(m: MatchRecord, side: 'a' | 'b'): string {
    void identityTick;
    if (m.mode === 'doubles') {
      const p1 = playerName(
        side === 'a' ? m.playerAId : m.playerBId,
        side === 'a' ? m.aName : m.bName,
      );
      const p2 = playerName(
        side === 'a' ? m.playerA2Id : m.playerB2Id,
        side === 'a' ? m.a2Name : m.b2Name,
      );
      return p1 && p2 ? `${p1} & ${p2}` : p1 || p2 || (side === 'a' ? 'Team A' : 'Team B');
    }
    if (m.mode === 'practice' && side === 'b') return '';
    return (
      playerName(
        side === 'a' ? m.playerAId : m.playerBId,
        side === 'a' ? m.aName : m.bName,
      ) || (side === 'a' ? 'Side A' : 'Side B')
    );
  }

  function fmtDate(ts: number | undefined): string {
    if (!ts) return '?';
    return new Date(ts).toLocaleDateString();
  }

  const filtered = $derived(() => {
    void identityTick;
    const q = query.trim().toLowerCase();
    if (!q) return matches;
    return matches.filter((m) => {
      if ((m.tournament ?? '').toLowerCase().includes(q)) return true;
      if (sideNameMatch(m, 'a').toLowerCase().includes(q)) return true;
      if (sideNameMatch(m, 'b').toLowerCase().includes(q)) return true;
      return false;
    });
  });

  function toggleSel(id: string) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    // Only rows the current user can delete are selectable via
    // Select-all. Organisers see it as "select every match on my
    // tournaments that's currently visible" — matches from other
    // tournaments in the same list stay untouched.
    const rows = filtered().filter((m) => canDeleteMatch(m));
    if (rows.length > 0 && rows.every((m) => selected.has(m.id))) {
      selected = new Set();
    } else {
      selected = new Set(rows.map((m) => m.id));
    }
  }
  function clearSelection() {
    selected = new Set();
  }
  async function performBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    saving = true;
    const outcome = await deleteMatches(ids);
    saving = false;
    if (outcome.ok) {
      flash('ok', `${outcome.deleted} match${outcome.deleted === 1 ? '' : 'es'} deleted`);
    } else {
      flash(
        'err',
        `${outcome.deleted} deleted, ${outcome.failed} failed${outcome.error ? ` — ${outcome.error}` : ''}`,
      );
    }
    selected = new Set();
    await reload();
  }
  async function performSingleDelete() {
    if (!confirmId) return;
    saving = true;
    const outcome = await deleteMatch(confirmId);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Match deleted');
      confirmId = null;
      await reload();
    } else {
      flash('err', outcome.error);
    }
  }

  const allSelected = $derived(() => {
    void identityTick;
    // Matches allSelected on Tournaments: "all selected" from this
    // user's manageable-rows perspective. Under super this is every
    // filtered row; under organiser it's only their tournaments' rows.
    const rows = filtered().filter((m) => canDeleteMatch(m));
    return rows.length > 0 && rows.every((m) => selected.has(m.id));
  });
</script>

<section class="history">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <AdminBulkBar
    count={selected.size}
    itemLabel="match"
    saving={saving}
    onConfirmDelete={performBulkDelete}
    onClearSelection={clearSelection}
  />

  <div class="controls">
    <input
      type="search"
      placeholder="Search player or tournament…"
      bind:value={query}
      aria-label="Search matches"
    />
    <span class="count">{filtered().length}</span>
    <button type="button" class="btn" onclick={reload} disabled={loading || saving}>
      {loading ? 'Reloading…' : 'Reload'}
    </button>
  </div>

  {#if loading && matches.length === 0}
    <p class="empty">Loading matches…</p>
  {:else if filtered().length === 0}
    <p class="empty">
      {query ? 'No matches match that search.' : 'No matches in history.'}
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
      {#each filtered() as m (m.id)}
        <li class="row" class:row-selected={selected.has(m.id)}>
          {#if canDeleteMatch(m)}
            <label class="row-check">
              <input
                type="checkbox"
                checked={selected.has(m.id)}
                onchange={() => toggleSel(m.id)}
                aria-label="Select match"
              />
            </label>
          {:else}
            <span class="row-check row-check-spacer" aria-hidden="true"></span>
          {/if}
          <div class="row-name">
            <div class="row-title">
              <span class="chip chip-mode">{m.mode}</span>
              {#if m.tournament}
                <span class="chip">{m.tournament}</span>
              {/if}
              <span class="row-date">{fmtDate(m.endedAt)}</span>
            </div>
            <div class="row-sub">
              {sideNameMatch(m, 'a')}
              {#if sideNameMatch(m, 'b')}<span class="vs">vs</span> {sideNameMatch(m, 'b')}{/if}
              {#if m.mode === 'practice'}
                <!--
                  Practice records don't have a versus-shape result.
                  `finalPointsA` is technically defined (always 0)
                  which would otherwise trip the old `!== undefined`
                  guard and render "0-0 · 0-0" — meaningless for a
                  solo drill. Show total misses + total boards from
                  the practiceBoards matrix instead, mirroring the
                  Lobby History card's shape.
                -->
                {@const rows = m.practiceBoards ?? []}
                {@const totalMisses = rows.reduce(
                  (s, row) => s + (row ?? []).reduce((a, v) => a + (v ?? 0), 0),
                  0,
                )}
                {@const boardsPerSet = m.cfg?.maxBoards ?? (rows[0]?.length ?? 0)}
                {@const totalBoards = rows.length * boardsPerSet}
                <span class="score">
                  {totalMisses} misses · {totalBoards} boards
                </span>
              {:else if m.result?.finalPointsA !== undefined}
                <span class="score">
                  {m.result?.setsA ?? 0}–{m.result?.setsB ?? 0}
                  ·
                  {m.result?.finalPointsA ?? 0}–{m.result?.finalPointsB ?? 0}
                </span>
              {/if}
            </div>
          </div>
          {#if canDeleteMatch(m)}
            <button
              type="button"
              class="btn btn-danger"
              onclick={() => (confirmId = m.id)}
            >Delete</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if confirmId}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) (confirmId = null); }}>
      <div class="dialog-card">
        <h3>Delete match?</h3>
        <p>
          The /matches record is removed. Player and tournament
          records are untouched. Recovery via Firebase console
          backup is possible (see docs/admin.md).
        </p>
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={() => (confirmId = null)} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-danger"
            onclick={performSingleDelete}
            disabled={saving}
          >{saving ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .history { display: flex; flex-direction: column; gap: 0.75rem; }

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

  /* Bulk-select toolbar mirroring other admin tabs. */
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
    padding: 0.55rem 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    transition: background 0.12s, border-color 0.12s;
  }
  .row-selected {
    background: rgba(255, 213, 74, 0.06);
    border-color: rgba(255, 213, 74, 0.4);
  }
  .row-name { flex: 1; min-width: 0; }
  .row-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .row-date {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    margin-left: auto;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  .chip-mode {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.06);
    border-color: rgba(255, 213, 74, 0.2);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-weight: 700;
    font-size: 0.65rem;
  }
  .row-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    color: var(--muted);
    font-size: 0.82rem;
    margin-top: 0.25rem;
  }
  .vs { opacity: 0.6; }
  .score {
    color: var(--fg);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
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
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
</style>
