<script lang="ts">
  /**
   * Admin — Live matches tab.
   *
   * Lists every /live/{mid} record the app is subscribed to via
   * subscribeAllLive. Filter chips let the admin switch between:
   *   - "All": every live record, active or stuck (default)
   *   - "Stuck only": records with no updates in >4 h, or no
   *     matchResult set for >2 h (the pre-v2.0 "Live cleanup"
   *     scope, retained as a filter option)
   *
   * Multi-select + bulk delete works on whatever the current filter
   * shows. Delete removes the /live/{mid} ephemeral broadcast only —
   * archived /matches records are unaffected, and admins can bulk-
   * delete those separately from the History cleanup tab.
   */
  import { onMount } from 'svelte';
  import {
    subscribeAllLive,
    deleteLive,
    deleteLiveMany,
    sweepStaleLive,
    type LobbyEntry,
  } from '../lib/live-sync';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';
  import { findByKey, subscribeStore as subscribeTournamentsStore, subscribeTournaments } from '../lib/tournaments';
  import AdminBulkBar from './AdminBulkBar.svelte';

  let role = $state<Role | null>(null);

  /**
   * Mirrors the /live/{mid} delete rule for UI gating (see rules
   * for the canonical expression): super, or organiser of the
   * record's meta.tournamentKey, or the umpire who stamped
   * createdBy on publish. Anonymous live records (no createdBy)
   * can only be deleted by super — UI honours that.
   */
  function canDeleteLive(e: LobbyEntry): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    const uid = currentUser()?.uid;
    if (uid && e.createdBy === uid) return true;
    // v3.3: organiser role gates on parent tournament's createdBy.
    if (role.isOrganiser && e.meta.tournamentKey) {
      const t = findByKey(e.meta.tournamentKey);
      if (t && uid && t.createdBy === uid) return true;
    }
    return false;
  }

  const STALE_WINDOW_MS = 4 * 60 * 60 * 1000;

  let entries = $state<LobbyEntry[]>([]);
  let now = $state(Date.now());
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let confirmMid = $state<string | null>(null);
  /**
   * Which subset of live records to show. 'all' is the default (v2.0.x+
   * rework); 'stuck' is the pre-rework filter that only showed records
   * needing cleanup. Selection state is cleared when the filter flips
   * so a bulk-delete on the newly-filtered set doesn't accidentally
   * catch rows the admin has stopped looking at.
   */
  let filter = $state<'all' | 'stuck'>('all');
  function setFilter(next: 'all' | 'stuck') {
    if (filter === next) return;
    filter = next;
    selected = new Set();
  }
  /**
   * Selected midss for bulk delete. Kept as a Set for O(1)
   * membership tests as the list re-renders on every subscribeAllLive
   * push (~ every few seconds). Selection is preserved across
   * re-renders because we reassign the Set (Svelte 5 reactivity
   * requires a new reference).
   */
  let selected = $state<Set<string>>(new Set());

  onMount(() => {
    // Best-effort passive sweep of stuck /live/{mid} records
    // (updatedAt older than 4h). Fires once on mount, silent-on-
    // failure. The subscription below will then re-fetch cleanly.
    void sweepStaleLive();
    let unsub: (() => void) | null = null;
    void subscribeAllLive((e) => (entries = e)).then((fn) => {
      unsub = fn;
    });
    // Subscribe to tournaments so findByKey() in canDeleteLive has
    // the store populated when the check runs (v3.3 own-only auth).
    void subscribeTournaments();
    const unsubTournaments = subscribeTournamentsStore(() => {
      // Trigger a re-render by touching an existing state slot.
      // entries is the natural pick; assigning it to itself is
      // effectively a nudge for Svelte's reactivity.
      entries = entries;
    });
    const tick = window.setInterval(() => (now = Date.now()), 30_000);
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    return () => {
      unsub?.();
      unsubTournaments();
      window.clearInterval(tick);
      unsubRole();
    };
  });

  function relTime(ts: number): string {
    const diff = now - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))}h ago`;
    return `${Math.floor(diff / (24 * 60 * 60_000))}d ago`;
  }

  function isStuck(e: LobbyEntry): boolean {
    const age = now - e.updatedAt;
    if (age >= STALE_WINDOW_MS) return true;
    if (!e.liveState.matchResult && age >= 2 * 60 * 60_000) return true;
    return false;
  }

  /**
   * Rows the admin currently sees, sorted oldest-updatedAt first
   * (matches the pre-rework ordering — stale/stuck records surface
   * naturally at the top of an unfiltered list).
   */
  const visible = $derived(
    entries
      .filter((e) => (filter === 'stuck' ? isStuck(e) : true))
      .sort((a, b) => a.updatedAt - b.updatedAt),
  );

  function flash(kind: 'ok' | 'err', message: string) {
    banner = { kind, message };
    window.setTimeout(() => (banner = null), 4000);
  }

  function sideName(e: LobbyEntry, side: 'a' | 'b'): string {
    const m = e.meta;
    if (m.mode === 'practice' && side === 'b') return '';
    return (side === 'a' ? m.playerA : m.playerB) || (side === 'a' ? 'Side A' : 'Side B');
  }

  async function performDelete() {
    if (!confirmMid) return;
    saving = true;
    const outcome = await deleteLive(confirmMid);
    saving = false;
    if (outcome.ok) {
      flash('ok', 'Live record deleted');
      confirmMid = null;
    } else {
      flash('err', outcome.error);
    }
  }

  function toggleSel(mid: string) {
    if (selected.has(mid)) selected.delete(mid);
    else selected.add(mid);
    selected = new Set(selected);
  }
  function toggleSelectAll() {
    // Only rows the current user can delete are select-all-eligible.
    // Under super this is every visible row; under organiser it's
    // only their tournaments' live records (or their own anonymous
    // publishes).
    const manageable = visible.filter((e) => canDeleteLive(e));
    if (manageable.length > 0 && manageable.every((e) => selected.has(e.mid))) {
      selected = new Set();
    } else {
      selected = new Set(manageable.map((e) => e.mid));
    }
  }
  function clearSelection() {
    selected = new Set();
  }
  async function performBulkDelete() {
    const mids = [...selected];
    if (mids.length === 0) return;
    saving = true;
    const outcome = await deleteLiveMany(mids);
    saving = false;
    if (outcome.ok) {
      flash('ok', `${outcome.deleted} live record${outcome.deleted === 1 ? '' : 's'} deleted`);
    } else {
      flash(
        'err',
        `${outcome.deleted} deleted, ${outcome.failed} failed${outcome.error ? ` — ${outcome.error}` : ''}`,
      );
    }
    selected = new Set();
  }

  const allSelected = $derived.by(() => {
    // "All selected" from the manageable perspective — same
    // pattern as Tournaments and History cleanup.
    const manageable = visible.filter((e) => canDeleteLive(e));
    return manageable.length > 0 && manageable.every((e) => selected.has(e.mid));
  });
</script>

<section class="live">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <p class="lead">
    Every /live/{'{mid}'} record in Firebase. Use the filter to narrow
    to stuck records only (no updates &gt;4 h, or &gt;2 h without a
    match result). Delete removes the ephemeral broadcast only —
    archived matches live under History cleanup.
  </p>

  <div class="filter-bar" role="tablist" aria-label="Filter live records">
    <button
      type="button"
      class="filter-chip"
      class:filter-chip-on={filter === 'all'}
      onclick={() => setFilter('all')}
      role="tab"
      aria-selected={filter === 'all'}
    >All <span class="filter-count">{entries.length}</span></button>
    <button
      type="button"
      class="filter-chip"
      class:filter-chip-on={filter === 'stuck'}
      onclick={() => setFilter('stuck')}
      role="tab"
      aria-selected={filter === 'stuck'}
    >Stuck only <span class="filter-count">{entries.filter(isStuck).length}</span></button>
  </div>

  <AdminBulkBar
    count={selected.size}
    itemLabel="live record"
    saving={saving}
    onConfirmDelete={performBulkDelete}
    onClearSelection={clearSelection}
  />

  {#if visible.length === 0}
    <p class="empty">
      {#if filter === 'stuck'}Nothing to clean up.{:else}No live matches right now.{/if}
    </p>
  {:else}
    <div class="select-hdr">
      <label class="sel-all">
        <input
          type="checkbox"
          checked={allSelected}
          onchange={toggleSelectAll}
          aria-label={allSelected ? 'Deselect all' : 'Select all'}
        />
        Select all
      </label>
    </div>
    <ul class="list">
      {#each visible as e (e.mid)}
        <li class="row" class:row-selected={selected.has(e.mid)}>
          {#if canDeleteLive(e)}
            <label class="row-check">
              <input
                type="checkbox"
                checked={selected.has(e.mid)}
                onchange={() => toggleSel(e.mid)}
                aria-label={`Select ${e.mid}`}
              />
            </label>
          {:else}
            <span class="row-check row-check-spacer" aria-hidden="true"></span>
          {/if}
          <div class="row-name">
            <div class="row-title">
              <span class="chip chip-mode">{e.meta.mode}</span>
              {#if e.meta.tournament}
                <span class="chip">{e.meta.tournament}</span>
              {/if}
              <span class="row-date">updated {relTime(e.updatedAt)}</span>
              {#if isStuck(e)}
                <span class="chip chip-warn">stuck</span>
              {:else if e.liveState.matchResult}
                <!--
                  Explicit "ended" state — the umpire tapped End so the
                  match has a winner, but the /live/{mid} record wasn't
                  cleaned up. Public lobby's Now Playing filters these
                  OUT (only matches with !matchResult show). Surface it
                  here so admins understand why these rows don't appear
                  on the umpire-facing lobby.
                -->
                <span class="chip chip-ended">ended</span>
              {:else}
                <span class="chip chip-live">LIVE</span>
              {/if}
            </div>
            <div class="row-sub">
              <span class="side-names">
                {sideName(e, 'a')}
                {#if sideName(e, 'b')}<span class="vs">vs</span> {sideName(e, 'b')}{/if}
              </span>
            </div>
            <div class="row-meta">
              <span class="meta-label">mid</span>
              <code class="mid">{e.mid}</code>
              <span class="meta-sep">·</span>
              <span class="meta-label">by</span>
              {#if e.createdByName}
                <span class="meta-value">{e.createdByName}</span>
              {:else if e.createdBy}
                <code class="meta-uid" title={e.createdBy}>{e.createdBy.slice(0, 8)}…</code>
              {:else}
                <span class="meta-anon">anonymous</span>
              {/if}
            </div>
          </div>
          {#if canDeleteLive(e)}
            <button
              type="button"
              class="btn btn-danger"
              onclick={() => (confirmMid = e.mid)}
            >Delete</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}

  {#if confirmMid}
    <div class="dialog" role="dialog" aria-modal="true" onclick={(e) => { if (e.target === e.currentTarget) (confirmMid = null); }}>
      <div class="dialog-card">
        <h3>Delete live record?</h3>
        <p>
          The /live/{confirmMid} record is removed. Match archives in
          /matches are unaffected. This is only for cleaning up
          zombie broadcast slots — the actual match record (if the
          umpire ever tapped End) lives elsewhere.
        </p>
        <div class="dialog-actions">
          <button type="button" class="btn" onclick={() => (confirmMid = null)} disabled={saving}>Cancel</button>
          <button
            type="button"
            class="btn btn-danger"
            onclick={performDelete}
            disabled={saving}
          >{saving ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  {/if}
</section>

<style>
  .live { display: flex; flex-direction: column; gap: 0.75rem; }

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

  .lead {
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.5;
    margin: 0;
  }
  .empty { color: var(--muted); text-align: center; padding: 1.5rem; }

  /* Select-all header sits just above the row list. Compact so it
     doesn't compete with the bulk-action bar on top. */
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
    padding: 0.6rem 0.75rem;
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
  /* Row-title now leads with mode + tournament chips + updated
     timestamp, matching the History tab's shape. Mid is demoted to
     the row-meta line below (monospace, muted). */
  .row-date {
    color: var(--muted);
    font-size: 0.72rem;
    margin-left: 0.15rem;
  }
  .side-names {
    color: var(--fg);
    font-weight: 600;
    font-size: 0.9rem;
  }
  /* Mid + createdBy attribution line under the player names. Muted
     because it's identifying metadata, not the primary read. */
  .row-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem;
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 0.25rem;
  }
  .meta-label {
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.62rem;
    opacity: 0.7;
  }
  .meta-value {
    color: var(--fg);
    opacity: 0.85;
  }
  .meta-uid {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.05rem 0.35rem;
    border-radius: 0.3rem;
    font-size: 0.68rem;
  }
  .meta-anon {
    font-style: italic;
    opacity: 0.7;
  }
  .meta-sep { opacity: 0.4; }
  .mid {
    background: rgba(255, 255, 255, 0.05);
    padding: 0.05rem 0.35rem;
    border-radius: 0.3rem;
    font-size: 0.68rem;
    color: var(--fg);
    opacity: 0.85;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  /* Match-mode chip — uses the app accent so the mode reads at a
     glance without stealing focus from the player names. */
  .chip-mode {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.3);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.65rem;
    font-weight: 700;
  }
  .chip-warn {
    color: #ffb74d;
    background: rgba(255, 183, 77, 0.1);
    border-color: rgba(255, 183, 77, 0.3);
  }
  /* Live chip: red dot + red-tinted "LIVE" text. Matches the /live/
     lobby's "Now Playing" style so admins recognise it instantly. */
  .chip-live {
    color: #ef8985;
    background: rgba(239, 83, 80, 0.1);
    border-color: rgba(239, 83, 80, 0.3);
    font-weight: 700;
    letter-spacing: 0.06em;
  }
  /* Ended chip: muted grey. These records have a matchResult set so
     the public lobby filters them out; they're only visible here
     for admin cleanup. */
  .chip-ended {
    color: var(--muted);
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.12);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
  }

  /* Filter tabs — bar of tab-like chips above the bulk bar. */
  .filter-bar {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .filter-chip {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: var(--muted);
    padding: 0.35rem 0.75rem;
    border-radius: 999px;
    font: inherit;
    font-size: 0.78rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
  }
  .filter-chip:hover { background: rgba(255, 255, 255, 0.06); }
  .filter-chip-on {
    background: rgba(255, 213, 74, 0.12);
    border-color: rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
  }
  .filter-count {
    font-weight: 700;
    font-family: monospace;
    color: inherit;
    opacity: 0.85;
    background: rgba(0, 0, 0, 0.25);
    padding: 0.02rem 0.35rem;
    border-radius: 999px;
    font-size: 0.72rem;
  }
  .row-sub {
    font-size: 0.9rem;
    margin-top: 0.3rem;
    color: var(--fg);
  }
  .vs {
    color: var(--muted);
    opacity: 0.6;
    margin: 0 0.2rem;
    font-weight: 400;
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
