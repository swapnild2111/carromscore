<script lang="ts">
  import { onMount } from 'svelte';

  const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

  type CollectionStat = {
    path: string;
    label: string;
    count: number | null;
    sampleBytes: number | null; // bytes from a small sample fetch
    error?: string;
  };

  type Stats = {
    fetchedAt: Date;
    collections: CollectionStat[];
    totalCount: number;
  };

  let stats = $state<Stats | null>(null);
  let loading = $state(false);
  let error = $state('');

  const COLLECTIONS = [
    { path: '/players',     label: 'Players' },
    { path: '/tournaments', label: 'Tournaments' },
    { path: '/matches',     label: 'Matches' },
    { path: '/planned',     label: 'Planned matches' },
    { path: '/adminRoles',  label: 'Admin roles' },
    { path: '/auditLog',    label: 'Audit log entries' },
  ];

  async function getIdToken(): Promise<string> {
    const [{ firebaseApp }, { getAuth }] = await Promise.all([
      import('../lib/firebase'),
      import('firebase/auth'),
    ]);
    const auth = getAuth(firebaseApp());
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in');
    return user.getIdToken();
  }

  async function fetchShallowCount(path: string, token: string): Promise<{ count: number; sampleBytes: number }> {
    // ?shallow=true returns only the top-level keys as {key: true} — fast, minimal data
    const res = await fetch(`${DB_URL}${path}.json?shallow=true&auth=${token}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const data = JSON.parse(text);
    if (data === null) return { count: 0, sampleBytes: 0 };
    const keys = Object.keys(data);
    return { count: keys.length, sampleBytes: text.length };
  }

  async function fetchSampleSize(path: string, token: string, sampleN = 5): Promise<number> {
    // Fetch a small sample to estimate average record size
    const res = await fetch(`${DB_URL}${path}.json?orderBy="$key"&limitToFirst=${sampleN}&auth=${token}`);
    if (!res.ok) return 0;
    const text = await res.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') return 0;
    const n = Object.keys(data).length;
    if (n === 0) return 0;
    return Math.round(text.length / n); // avg bytes per record
  }

  async function loadStats() {
    loading = true;
    error = '';
    stats = null;
    try {
      const token = await getIdToken();

      const results = await Promise.all(
        COLLECTIONS.map(async ({ path, label }) => {
          try {
            const { count, sampleBytes } = await fetchShallowCount(path, token);
            let avgBytes = 0;
            if (count > 0) {
              avgBytes = await fetchSampleSize(path, token, Math.min(5, count));
            }
            return {
              path,
              label,
              count,
              sampleBytes: count > 0 ? avgBytes * count : 0,
            } satisfies CollectionStat;
          } catch (e: any) {
            return { path, label, count: null, sampleBytes: null, error: e.message } satisfies CollectionStat;
          }
        })
      );

      stats = {
        fetchedAt: new Date(),
        collections: results,
        totalCount: results.reduce((s, r) => s + (r.count ?? 0), 0),
      };
    } catch (e: any) {
      error = e.message ?? 'Unknown error';
    } finally {
      loading = false;
    }
  }

  function fmtBytes(n: number | null): string {
    if (n === null) return '—';
    if (n === 0) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  function fmtTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  onMount(() => { loadStats(); });
</script>

<div class="db-stats">
  <div class="stats-hdr">
    <h2>DB Stats</h2>
    <button class="btn-refresh" onclick={loadStats} disabled={loading} aria-label="Refresh stats">
      <span class="refresh-icon" class:spinning={loading}>↻</span>
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </div>

  {#if error}
    <p class="stats-error">Error: {error}</p>
  {/if}

  {#if stats}
    <p class="stats-time">Last fetched at {fmtTime(stats.fetchedAt)} · {stats.totalCount} total records</p>

    <div class="stats-note">
      <strong>Note:</strong> Record counts are exact (shallow read). Storage estimates are approximated
      from a 5-record sample × total count — actual Firebase usage may differ.
      For exact storage, see the
      <a href="https://console.firebase.google.com" target="_blank" rel="noopener">Firebase Console</a>.
    </div>

    <table class="stats-table">
      <thead>
        <tr>
          <th>Collection</th>
          <th>Path</th>
          <th class="num">Records</th>
          <th class="num">Est. size</th>
        </tr>
      </thead>
      <tbody>
        {#each stats.collections as col}
          <tr class:row-error={!!col.error}>
            <td class="col-label">{col.label}</td>
            <td class="col-path">{col.path}</td>
            <td class="num">
              {#if col.error}
                <span class="err-badge" title={col.error}>Error</span>
              {:else}
                {col.count?.toLocaleString() ?? '—'}
              {/if}
            </td>
            <td class="num">{fmtBytes(col.sampleBytes)}</td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr class="row-total">
          <td colspan="2">Total</td>
          <td class="num">{stats.totalCount.toLocaleString()}</td>
          <td class="num">
            {fmtBytes(stats.collections.reduce((s, c) => s + (c.sampleBytes ?? 0), 0))}
          </td>
        </tr>
      </tfoot>
    </table>

    <div class="stats-breakdown">
      {#each stats.collections.filter(c => c.count !== null && c.count > 0) as col}
        <div class="breakdown-row">
          <span class="breakdown-label">{col.label}</span>
          <div class="breakdown-bar-wrap">
            <div
              class="breakdown-bar"
              style="width: {Math.round(((col.count ?? 0) / stats.totalCount) * 100)}%"
            ></div>
          </div>
          <span class="breakdown-pct">
            {Math.round(((col.count ?? 0) / stats.totalCount) * 100)}%
          </span>
        </div>
      {/each}
    </div>
  {:else if loading}
    <div class="stats-loading">
      <span class="spinner"></span>
      Fetching Firebase stats…
    </div>
  {/if}
</div>

<style>
  .db-stats {
    max-width: 720px;
    padding: 0.5rem 0 2rem;
  }

  .stats-hdr {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
  }
  .stats-hdr h2 {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 700;
  }

  .btn-refresh {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.35rem 0.75rem;
    background: rgba(255,255,255,0.07);
    border: 1px solid rgba(255,255,255,0.15);
    border-radius: 0.4rem;
    color: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    transition: background 0.15s;
  }
  .btn-refresh:hover:not(:disabled) { background: rgba(255,255,255,0.12); }
  .btn-refresh:disabled { opacity: 0.5; cursor: default; }

  .refresh-icon {
    font-size: 1rem;
    display: inline-block;
    transition: transform 0.3s;
  }
  .refresh-icon.spinning {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats-time {
    margin: 0 0 0.75rem;
    font-size: 0.8rem;
    color: var(--muted, #9aa0a6);
  }

  .stats-note {
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.4rem;
    padding: 0.5rem 0.75rem;
    margin-bottom: 1.25rem;
    line-height: 1.5;
  }
  .stats-note a { color: var(--accent, #ffd54a); }

  .stats-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
    margin-bottom: 1.75rem;
  }
  .stats-table th {
    text-align: left;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #9aa0a6);
    border-bottom: 1px solid rgba(255,255,255,0.1);
    padding: 0.4rem 0.6rem;
  }
  .stats-table td {
    padding: 0.55rem 0.6rem;
    border-bottom: 1px solid rgba(255,255,255,0.06);
    vertical-align: middle;
  }
  .stats-table th.num,
  .stats-table td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .col-label { font-weight: 600; }
  .col-path {
    font-family: monospace;
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
  }
  .row-error td { color: #ef5350; }
  .err-badge {
    font-size: 0.72rem;
    background: rgba(239,83,80,0.15);
    border: 1px solid rgba(239,83,80,0.4);
    border-radius: 3px;
    padding: 0.1rem 0.35rem;
    color: #ef5350;
  }
  .row-total td {
    font-weight: 700;
    border-top: 1px solid rgba(255,255,255,0.18);
    border-bottom: none;
    padding-top: 0.65rem;
  }

  /* breakdown bar chart */
  .stats-breakdown {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .breakdown-row {
    display: grid;
    grid-template-columns: 160px 1fr 3rem;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.82rem;
  }
  .breakdown-label {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .breakdown-bar-wrap {
    height: 8px;
    background: rgba(255,255,255,0.08);
    border-radius: 99px;
    overflow: hidden;
  }
  .breakdown-bar {
    height: 100%;
    background: var(--accent, #ffd54a);
    border-radius: 99px;
    min-width: 2px;
    transition: width 0.4s ease;
  }
  .breakdown-pct {
    text-align: right;
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
  }

  .stats-error {
    color: #ef5350;
    font-size: 0.88rem;
    margin: 0.5rem 0;
  }

  .stats-loading {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.88rem;
    padding: 1rem 0;
  }
  .spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(255,255,255,0.15);
    border-top-color: var(--accent, #ffd54a);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    flex-shrink: 0;
  }
</style>
