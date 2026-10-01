<script lang="ts">
  import { onMount } from 'svelte';

  const DB_URL = 'https://carrom-score-default-rtdb.firebaseio.com';

  // Firebase Spark (free) plan limits for Realtime Database
  const SPARK_STORAGE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB
  const SPARK_DOWNLOAD_BYTES_MONTH = 10 * 1024 * 1024 * 1024; // 10 GB/month
  const SPARK_CONNECTIONS = 100;

  type CollectionStat = {
    path: string;
    label: string;
    count: number | null;
    estBytes: number | null;
    error?: string;
  };

  type Stats = {
    fetchedAt: Date;
    collections: CollectionStat[];
    totalCount: number;
    totalEstBytes: number;
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
    { path: '/audit',       label: 'Audit log entries' },
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

  async function fetchShallowCount(path: string, token: string): Promise<number> {
    const res = await fetch(`${DB_URL}${path}.json?shallow=true&auth=${token}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(await res.text());
    if (data === null) return 0;
    return Object.keys(data).length;
  }

  async function fetchSampleSize(path: string, token: string, sampleN = 5): Promise<number> {
    const res = await fetch(`${DB_URL}${path}.json?orderBy="$key"&limitToFirst=${sampleN}&auth=${token}`);
    if (!res.ok) return 0;
    const text = await res.text();
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object') return 0;
    const n = Object.keys(data).length;
    if (n === 0) return 0;
    return Math.round(text.length / n);
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
            const count = await fetchShallowCount(path, token);
            let estBytes = 0;
            if (count > 0) {
              const avgBytes = await fetchSampleSize(path, token, Math.min(5, count));
              estBytes = avgBytes * count;
            }
            return { path, label, count, estBytes } satisfies CollectionStat;
          } catch (e: any) {
            return { path, label, count: null, estBytes: null, error: e.message } satisfies CollectionStat;
          }
        })
      );

      const totalEstBytes = results.reduce((s, r) => s + (r.estBytes ?? 0), 0);

      stats = {
        fetchedAt: new Date(),
        collections: results,
        totalCount: results.reduce((s, r) => s + (r.count ?? 0), 0),
        totalEstBytes,
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

  function storagePct(bytes: number): number {
    return Math.min(100, (bytes / SPARK_STORAGE_BYTES) * 100);
  }

  function gaugeColor(pct: number): string {
    if (pct >= 80) return '#ef5350';
    if (pct >= 50) return '#ffa726';
    return '#56cb82';
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
    <p class="stats-time">Last fetched at {fmtTime(stats.fetchedAt)} · {stats.totalCount.toLocaleString()} total records</p>

    <!-- Storage gauge -->
    {@const pct = storagePct(stats.totalEstBytes)}
    {@const color = gaugeColor(pct)}
    <div class="gauge-card">
      <div class="gauge-header">
        <span class="gauge-title">Storage used <span class="gauge-plan">Spark free plan · 1 GB limit</span></span>
        <span class="gauge-value" style="color: {color}">{fmtBytes(stats.totalEstBytes)}</span>
      </div>
      <div class="gauge-bar-wrap">
        <div class="gauge-bar" style="width: {pct}%; background: {color}"></div>
      </div>
      <div class="gauge-footer">
        <span class="gauge-pct" style="color: {color}">{pct.toFixed(2)}% used</span>
        <span class="gauge-remaining">{fmtBytes(SPARK_STORAGE_BYTES - stats.totalEstBytes)} remaining (est.)</span>
      </div>
      {#if pct >= 80}
        <p class="gauge-warn">⚠ Storage over 80% — consider upgrading to Firebase Blaze (pay-as-you-go).</p>
      {:else if pct >= 50}
        <p class="gauge-warn-amber">Storage over 50% — keep an eye on growth.</p>
      {/if}
    </div>

    <!-- Spark plan limits -->
    <div class="limits-card">
      <p class="limits-title">Firebase Spark plan quotas</p>
      <div class="limits-grid">
        <div class="limit-item">
          <span class="limit-label">Storage</span>
          <span class="limit-val">1 GB</span>
        </div>
        <div class="limit-item">
          <span class="limit-label">Download / month</span>
          <span class="limit-val">10 GB</span>
        </div>
        <div class="limit-item">
          <span class="limit-label">Simultaneous connections</span>
          <span class="limit-val">{SPARK_CONNECTIONS}</span>
        </div>
      </div>
      <p class="limits-note">
        Storage estimate is approximate (5-record sample × count).
        For exact figures see the <a href="https://console.firebase.google.com" target="_blank" rel="noopener">Firebase Console → Usage tab</a>.
      </p>
    </div>

    <!-- Per-collection table -->
    <table class="stats-table">
      <thead>
        <tr>
          <th>Collection</th>
          <th class="num">Records</th>
          <th class="num">Est. size</th>
          <th class="size-bar-th">Size share</th>
        </tr>
      </thead>
      <tbody>
        {#each stats.collections as col}
          {@const colPct = stats.totalEstBytes > 0 ? ((col.estBytes ?? 0) / stats.totalEstBytes) * 100 : 0}
          <tr class:row-error={!!col.error}>
            <td class="col-label">{col.label}</td>
            <td class="num">
              {#if col.error}
                <span class="err-badge" title={col.error}>Error</span>
              {:else}
                {col.count?.toLocaleString() ?? '—'}
              {/if}
            </td>
            <td class="num">{fmtBytes(col.estBytes)}</td>
            <td class="size-bar-td">
              {#if !col.error && col.estBytes !== null && col.estBytes > 0}
                <div class="size-bar-wrap">
                  <div class="size-bar" style="width: {colPct.toFixed(1)}%"></div>
                </div>
                <span class="size-bar-pct">{colPct.toFixed(0)}%</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
      <tfoot>
        <tr class="row-total">
          <td>Total</td>
          <td class="num">{stats.totalCount.toLocaleString()}</td>
          <td class="num">{fmtBytes(stats.totalEstBytes)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>

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

  .refresh-icon { font-size: 1rem; display: inline-block; }
  .refresh-icon.spinning { animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .stats-time {
    margin: 0 0 1rem;
    font-size: 0.8rem;
    color: var(--muted, #9aa0a6);
  }

  /* ── Storage gauge ── */
  .gauge-card {
    background: rgba(255,255,255,0.04);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.5rem;
    padding: 0.85rem 1rem;
    margin-bottom: 0.75rem;
  }
  .gauge-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.5rem;
  }
  .gauge-title {
    font-size: 0.88rem;
    font-weight: 600;
  }
  .gauge-plan {
    font-size: 0.75rem;
    font-weight: 400;
    color: var(--muted, #9aa0a6);
    margin-left: 0.4rem;
  }
  .gauge-value {
    font-size: 1.1rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .gauge-bar-wrap {
    height: 10px;
    background: rgba(255,255,255,0.08);
    border-radius: 99px;
    overflow: hidden;
    margin-bottom: 0.4rem;
  }
  .gauge-bar {
    height: 100%;
    border-radius: 99px;
    transition: width 0.5s ease;
    min-width: 2px;
  }
  .gauge-footer {
    display: flex;
    justify-content: space-between;
    font-size: 0.78rem;
  }
  .gauge-pct { font-weight: 600; }
  .gauge-remaining { color: var(--muted, #9aa0a6); }
  .gauge-warn {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    color: #ef5350;
    background: rgba(239,83,80,0.08);
    border: 1px solid rgba(239,83,80,0.25);
    border-radius: 0.3rem;
    padding: 0.3rem 0.6rem;
  }
  .gauge-warn-amber {
    margin: 0.5rem 0 0;
    font-size: 0.8rem;
    color: #ffa726;
    background: rgba(255,167,38,0.08);
    border: 1px solid rgba(255,167,38,0.25);
    border-radius: 0.3rem;
    padding: 0.3rem 0.6rem;
  }

  /* ── Spark limits card ── */
  .limits-card {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 0.5rem;
    padding: 0.75rem 1rem;
    margin-bottom: 1.5rem;
  }
  .limits-title {
    margin: 0 0 0.6rem;
    font-size: 0.78rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted, #9aa0a6);
  }
  .limits-grid {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
  }
  .limit-item {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
  }
  .limit-label {
    font-size: 0.75rem;
    color: var(--muted, #9aa0a6);
  }
  .limit-val {
    font-size: 1rem;
    font-weight: 700;
  }
  .limits-note {
    margin: 0;
    font-size: 0.75rem;
    color: var(--muted, #9aa0a6);
    line-height: 1.5;
  }
  .limits-note a { color: var(--accent, #ffd54a); }

  /* ── Per-collection table ── */
  .stats-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88rem;
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
  .stats-table th.num, .stats-table td.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .size-bar-th { width: 140px; padding-left: 0.6rem; }
  .size-bar-td {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.55rem 0.6rem;
  }
  .size-bar-wrap {
    flex: 1;
    height: 6px;
    background: rgba(255,255,255,0.07);
    border-radius: 99px;
    overflow: hidden;
  }
  .size-bar {
    height: 100%;
    background: var(--accent, #ffd54a);
    border-radius: 99px;
    min-width: 2px;
    opacity: 0.7;
  }
  .size-bar-pct {
    font-size: 0.72rem;
    color: var(--muted, #9aa0a6);
    font-variant-numeric: tabular-nums;
    width: 2.2rem;
    text-align: right;
  }
  .col-label { font-weight: 600; }
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
