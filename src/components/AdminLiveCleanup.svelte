<script lang="ts">
  /**
   * Admin — Live cleanup tab.
   *
   * Lists /live/{mid} records the app subscribes to via
   * subscribeAllLive. The lobby filters records with
   * (now - updatedAt >= 4h) out of the "Now Playing" view — those
   * are considered stale. This tab shows those same stale entries
   * plus any active-but-abandoned ones (matchResult === null) so a
   * super-admin can force-delete records that armLiveCleanup's
   * onDisconnect handler didn't catch (force-quit, connectivity
   * blip, etc.).
   *
   * A "healthy" live match (recently updated, or already
   * matchResult set) is hidden — this tab is for cleanup, not
   * inspection. To browse live matches, use the lobby.
   */
  import { onMount } from 'svelte';
  import { subscribeAllLive, deleteLive, type LobbyEntry } from '../lib/live-sync';

  const STALE_WINDOW_MS = 4 * 60 * 60 * 1000;

  let entries = $state<LobbyEntry[]>([]);
  let now = $state(Date.now());
  let saving = $state(false);
  let banner = $state<{ kind: 'ok' | 'err'; message: string } | null>(null);
  let confirmMid = $state<string | null>(null);

  onMount(() => {
    let unsub: (() => void) | null = null;
    void subscribeAllLive((e) => (entries = e)).then((fn) => {
      unsub = fn;
    });
    const tick = window.setInterval(() => (now = Date.now()), 30_000);
    return () => {
      unsub?.();
      window.clearInterval(tick);
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

  const stuck = $derived(
    entries.filter(isStuck).sort((a, b) => a.updatedAt - b.updatedAt),
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
</script>

<section class="live">
  {#if banner}
    <div class="banner" class:banner-err={banner.kind === 'err'} role="status">
      {banner.message}
    </div>
  {/if}

  <p class="lead">
    Shows /live records that are stuck: no updates for &gt;4 h, or
    &gt;2 h without a match result. Healthy live matches are hidden —
    browse those in the lobby.
  </p>

  {#if stuck.length === 0}
    <p class="empty">Nothing to clean up.</p>
  {:else}
    <ul class="list">
      {#each stuck as e (e.mid)}
        <li class="row">
          <div class="row-name">
            <div class="row-title">
              <span class="mid">{e.mid}</span>
              <span class="chip">{e.meta.mode}</span>
              {#if e.meta.tournament}
                <span class="chip">{e.meta.tournament}</span>
              {/if}
            </div>
            <div class="row-sub">
              {sideName(e, 'a')}
              {#if sideName(e, 'b')}<span class="vs">vs</span> {sideName(e, 'b')}{/if}
              <span class="age">· updated {relTime(e.updatedAt)}</span>
              {#if !e.liveState.matchResult}<span class="chip chip-warn">no result</span>{/if}
            </div>
          </div>
          <button
            type="button"
            class="btn btn-danger"
            onclick={() => (confirmMid = e.mid)}
          >Delete</button>
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
  .row-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
  }
  .mid {
    color: var(--fg);
    font-weight: 700;
    font-family: monospace;
    font-size: 0.9rem;
  }
  .chip {
    font-size: 0.7rem;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
  }
  .chip-warn {
    color: #ffb74d;
    background: rgba(255, 183, 77, 0.1);
    border-color: rgba(255, 183, 77, 0.3);
  }
  .row-sub {
    color: var(--muted);
    font-size: 0.8rem;
    margin-top: 0.25rem;
  }
  .vs { opacity: 0.6; margin: 0 0.2rem; }
  .age { opacity: 0.7; }

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
