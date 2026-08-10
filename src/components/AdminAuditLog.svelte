<script lang="ts">
  /**
   * Admin — Audit tab.
   *
   * Renders the last N audit entries newest-first, with an
   * expandable diff showing before/after payloads. Super-read-only
   * per rules; a non-super user hitting this component sees an
   * empty list (the subscribe returns no data silently).
   */
  import { onMount } from 'svelte';
  import { subscribeAudit, type AuditEntry } from '../lib/audit';

  const AUDIT_LIMIT = 200;

  let entries = $state<Array<AuditEntry & { id: string }>>([]);
  let expanded = $state<Set<string>>(new Set());
  let loaded = $state(false);

  onMount(() => {
    let unsub: (() => void) | null = null;
    void subscribeAudit(AUDIT_LIMIT, (list) => {
      entries = list;
      loaded = true;
    }).then((fn) => {
      unsub = fn;
    });
    return () => unsub?.();
  });

  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    expanded = new Set(expanded);
  }

  function fmtTime(ts: number): string {
    if (!ts) return '?';
    const d = new Date(ts);
    return d.toLocaleString();
  }

  function pretty(payload: unknown): string {
    if (payload === undefined) return '(none)';
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      return String(payload);
    }
  }

  function actionColor(action: string): string {
    if (action.endsWith('.delete')) return 'action-delete';
    if (action.endsWith('.merge')) return 'action-merge';
    if (action.endsWith('.rename') || action.endsWith('.update')) return 'action-update';
    if (action.endsWith('.add')) return 'action-add';
    if (action.endsWith('.remove')) return 'action-delete';
    return 'action-default';
  }
</script>

<section class="audit">
  <p class="lead">
    Last {AUDIT_LIMIT} admin actions, newest first. Read-only view;
    audit entries are append-only in the DB. Click a row to expand
    the before/after diff.
  </p>

  {#if !loaded}
    <p class="empty">Loading…</p>
  {:else if entries.length === 0}
    <p class="empty">No admin activity yet.</p>
  {:else}
    <ul class="list">
      {#each entries as e (e.id)}
        {@const isOpen = expanded.has(e.id)}
        <li class="row">
          <button type="button" class="row-head" onclick={() => toggle(e.id)} aria-expanded={isOpen}>
            <span class="row-time">{fmtTime(e.when)}</span>
            <span class="action-chip {actionColor(e.action)}">{e.action}</span>
            <span class="row-path" title={e.path}>{e.path}</span>
            <span class="row-who" title={e.who}>{e.whoEmail || e.who.slice(0, 8)}</span>
            <span class="row-caret">{isOpen ? '▾' : '▸'}</span>
          </button>
          {#if isOpen}
            <div class="row-diff">
              <div class="diff-col">
                <div class="diff-label">before</div>
                <pre>{pretty(e.before)}</pre>
              </div>
              <div class="diff-col">
                <div class="diff-label">after</div>
                <pre>{pretty(e.after)}</pre>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .audit { display: flex; flex-direction: column; gap: 0.75rem; }
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
    gap: 0.3rem;
  }
  .row {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.5rem;
    overflow: hidden;
  }
  .row-head {
    display: grid;
    grid-template-columns: 9rem auto 1fr auto 1rem;
    gap: 0.5rem;
    align-items: center;
    width: 100%;
    padding: 0.5rem 0.7rem;
    background: transparent;
    border: none;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row-head:hover { background: rgba(255, 255, 255, 0.03); }
  .row-time {
    color: var(--muted);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }
  .action-chip {
    font-size: 0.68rem;
    letter-spacing: 0.04em;
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    font-weight: 700;
    text-transform: uppercase;
    justify-self: start;
  }
  .action-delete {
    background: rgba(239, 83, 80, 0.12);
    color: var(--danger);
    border: 1px solid rgba(239, 83, 80, 0.4);
  }
  .action-update {
    background: rgba(79, 195, 247, 0.12);
    color: var(--side-a);
    border: 1px solid rgba(79, 195, 247, 0.4);
  }
  .action-merge {
    background: rgba(255, 138, 101, 0.12);
    color: var(--side-b);
    border: 1px solid rgba(255, 138, 101, 0.4);
  }
  .action-add {
    background: rgba(102, 187, 106, 0.12);
    color: #66bb6a;
    border: 1px solid rgba(102, 187, 106, 0.4);
  }
  .action-default {
    background: rgba(255, 255, 255, 0.06);
    color: var(--muted);
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .row-path {
    font-size: 0.78rem;
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: monospace;
  }
  .row-who {
    font-size: 0.72rem;
    color: var(--muted);
    justify-self: end;
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-caret { color: var(--muted); font-size: 0.85rem; }

  .row-diff {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    padding: 0.5rem 0.7rem 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }
  @media (max-width: 640px) {
    .row-diff { grid-template-columns: 1fr; }
    .row-head { grid-template-columns: 1fr auto 1rem; }
    .row-head .row-time,
    .row-head .row-who,
    .row-head .row-path { grid-column: 1 / -1; }
    .row-head .row-time { font-size: 0.7rem; }
  }
  .diff-col {
    background: rgba(0, 0, 0, 0.3);
    border-radius: 0.4rem;
    padding: 0.4rem 0.5rem;
  }
  .diff-label {
    color: var(--muted);
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 700;
    margin-bottom: 0.25rem;
  }
  .diff-col pre {
    margin: 0;
    color: var(--fg);
    font-size: 0.72rem;
    line-height: 1.4;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 20rem;
    overflow: auto;
  }
</style>
