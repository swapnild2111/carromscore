<script lang="ts">
  /**
   * Live matches page — the single entry point to browse every match
   * Carromscore knows about. Tabs at the top toggle between:
   *
   *   Now Playing — ongoing broadcasts subscribed via /live/*
   *   History    — completed matches read from /matches/*
   *
   * Tapping any card opens a bottom-of-viewport centred popup with the
   * full read-only scoreboard. Same layout / component for both tabs.
   *
   * Design notes:
   * - "Recently finished" section is gone. Ended matches move directly
   *   from Now Playing into History.
   * - The Firebase /live subscription runs regardless of active tab
   *   so the live count in the "Now Playing" tab label stays current.
   * - The Firebase /matches read fires on tab switch (lazy) and again
   *   whenever we return to History after being away — cheap because
   *   RTDB caches locally.
   */
  import { onMount } from 'svelte';
  import { subscribeAllLive, type LobbyEntry } from '../lib/live-sync';
  import {
    loadHistory,
    playerName,
    type MatchRecord,
  } from '../lib/history';
  import { subscribePlayers, subscribeStore } from '../lib/players';
  import { APP_VERSION } from '../lib/version';
  import LiveScoreboardView from './LiveScoreboardView.svelte';

  const base: string = import.meta.env.BASE_URL;
  const STALE_WINDOW_MS = 4 * 60 * 60 * 1000;

  type Tab = 'live' | 'history';
  let tab = $state<Tab>('live');
  let liveLoading = $state(true);
  let historyLoading = $state(false);
  let historyLoaded = $state(false);
  let entries = $state<LobbyEntry[]>([]);
  let matches = $state<MatchRecord[]>([]);
  let now = $state(Date.now());
  let identityTick = $state(0);

  // Popup can render either a LobbyEntry (live tab) or a MatchRecord
  // (history tab). We normalise both into a LiveRecord-shaped object
  // for LiveScoreboardView to consume.
  type PopupKind = { source: 'live'; entry: LobbyEntry } | { source: 'match'; match: MatchRecord };
  let openPopup = $state<PopupKind | null>(null);
  let dialog: HTMLDialogElement | null = $state(null);
  // Deep-link support: /live/?mid=xxx auto-opens the popup for that
  // match. Cleared once the popup opens (or when the user manually
  // closes it) so subsequent updates to `entries` don't re-open it.
  let pendingMid = $state<string | null>(null);
  // Overlay mode: /live/?mid=xxx&view=overlay renders ONLY the
  // scoreboard strip on a transparent background. Meant for OBS /
  // Prism as a Browser Source over a live camera feed.
  let overlayMid = $state<string | null>(null);

  onMount(() => {
    // Read the target mid before the Firebase subscription lands.
    // We hold onto it and pop the popup open the moment its entry
    // arrives in the live-tree snapshot.
    const params = new URLSearchParams(window.location.search);
    const midParam = params.get('mid');
    const validMid = midParam && /^[a-z0-9]{4,12}$/i.test(midParam) ? midParam : null;
    if (validMid && params.get('view') === 'overlay') {
      overlayMid = validMid;
      // Make the body itself transparent for OBS's chroma-independent
      // Browser Source. Restored on unmount for good measure.
      document.documentElement.dataset.overlay = 'true';
    } else if (validMid) {
      pendingMid = validMid;
    }

    let unsub: (() => void) | null = null;
    void subscribeAllLive((e) => {
      entries = e;
      liveLoading = false;
    }).then((fn) => {
      unsub = fn;
    });

    // Identity store: needed for History tab to render player IDs as
    // canonical names. Cheap to subscribe here — the store lives in
    // memory and shares across all mounted components.
    void subscribePlayers();
    const unsubStore = subscribeStore(() => (identityTick += 1));

    const nowTick = window.setInterval(() => (now = Date.now()), 30_000);
    return () => {
      unsub?.();
      unsubStore();
      window.clearInterval(nowTick);
    };
  });

  // Load History on tab switch (once). Reloads on tab-switch-back
  // are cheap — Firebase caches the read.
  $effect(() => {
    if (tab !== 'history' || historyLoaded) return;
    historyLoading = true;
    void loadHistory().then((m) => {
      matches = m;
      historyLoading = false;
      historyLoaded = true;
    });
  });

  $effect(() => {
    if (!dialog) return;
    if (openPopup) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  });

  // Auto-open the popup when a deep-link mid finally matches a live
  // entry. Runs once per pageload — after opening, pendingMid clears
  // so this doesn't fight the user closing the popup.
  $effect(() => {
    if (!pendingMid) return;
    const match = entries.find((e) => e.mid === pendingMid);
    if (!match) return;
    openPopup = { source: 'live', entry: match };
    pendingMid = null;
  });

  // Ephemeral "✓ Copied" tick for the popup's Share + OBS buttons.
  // Tracks which URL got copied last so only that button flips.
  let copiedKind = $state<'share' | 'obs' | null>(null);
  let copiedTimer: number | null = null;
  async function writeClipboard(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const el = document.createElement('input');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* silent */ }
      el.remove();
    }
  }
  function popupMid(): string | null {
    if (openPopup?.source !== 'live') return null;
    return openPopup.entry.mid;
  }
  async function copyShareUrl() {
    const mid = popupMid();
    if (!mid) return;
    const url = `${window.location.origin}${base}live/?mid=${encodeURIComponent(mid)}`;
    await writeClipboard(url);
    copiedKind = 'share';
    if (copiedTimer !== null) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copiedKind = null; }, 1500);
  }
  async function copyObsUrl() {
    const mid = popupMid();
    if (!mid) return;
    const url = `${window.location.origin}${base}live/?mid=${encodeURIComponent(mid)}&view=overlay`;
    await writeClipboard(url);
    copiedKind = 'obs';
    if (copiedTimer !== null) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copiedKind = null; }, 1500);
  }

  function openEntry(entry: LobbyEntry) {
    openPopup = { source: 'live', entry };
    copiedKind = null;
  }
  function openMatch(match: MatchRecord) {
    openPopup = { source: 'match', match };
  }
  function closePopup() {
    openPopup = null;
  }

  function onDialogClick(e: MouseEvent) {
    if (!dialog) return;
    const rect = dialog.getBoundingClientRect();
    const outside =
      e.clientX < rect.left ||
      e.clientX > rect.right ||
      e.clientY < rect.top ||
      e.clientY > rect.bottom;
    if (outside) closePopup();
  }

  // Live cards (ongoing matches). Filters out records that haven't
  // seen an update in 4h (leaked from a closed umpire tab).
  const live = $derived(
    entries
      .filter((e) => !e.liveState.matchResult)
      .filter((e) => now - e.updatedAt < STALE_WINDOW_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );

  function sideNameLive(e: LobbyEntry, side: 'a' | 'b'): string {
    const m = e.meta;
    if (m.mode === 'doubles') {
      const p1 = side === 'a' ? m.playerA : m.playerB;
      const p2 = side === 'a' ? m.playerA2 : m.playerB2;
      return p1 && p2 ? `${p1} & ${p2}` : p1 || p2 || (side === 'a' ? 'Team A' : 'Team B');
    }
    return (side === 'a' ? m.playerA : m.playerB) || (side === 'a' ? 'Side A' : 'Side B');
  }

  function sideNameMatch(m: MatchRecord, side: 'a' | 'b'): string {
    void identityTick;
    if (m.mode === 'doubles') {
      const p1 = playerName(side === 'a' ? m.playerAId : m.playerBId);
      const p2 = playerName(side === 'a' ? m.playerA2Id : m.playerB2Id);
      return p1 && p2 ? `${p1} & ${p2}` : p1 || p2 || (side === 'a' ? 'Team A' : 'Team B');
    }
    if (m.mode === 'practice' && side === 'b') return '';
    return playerName(side === 'a' ? m.playerAId : m.playerBId) || (side === 'a' ? 'Side A' : 'Side B');
  }

  function relTime(ts: number | undefined): string {
    if (!ts) return '';
    const diff = now - ts;
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function modeLabelLive(e: LobbyEntry): string {
    if (e.meta.mode === 'singles') return 'Singles';
    if (e.meta.mode === 'doubles') return 'Doubles';
    return 'Practice';
  }
  function modeLabelMatch(m: MatchRecord): string {
    if (m.mode === 'singles') return 'Singles';
    if (m.mode === 'doubles') return 'Doubles';
    return 'Practice';
  }

  // Convert a MatchRecord into a LiveRecord shape so LiveScoreboardView
  // can render it. Match records don't include the live-play fields
  // (currentBreak, queenHolder) — those weren't persisted in v2.0 v1.
  // We fill them with `null` so the pill BREAK/queen chips just don't
  // render for archived matches. The final points/sets/board are all
  // preserved from the match's result field.
  function matchAsLiveRecord(m: MatchRecord): import('../lib/live-sync').LiveRecord {
    return {
      matchId: m.id,
      updatedAt: m.endedAt ?? 0,
      meta: {
        mode: m.mode,
        playerA: sideNameMatch(m, 'a'),
        playerB: sideNameMatch(m, 'b'),
        bestOf: m.cfg?.bestOf ?? 1,
        pointsTarget: m.cfg?.pointsTarget ?? 25,
        maxBoards: m.cfg?.maxBoards ?? 8,
      },
      liveState: {
        sideA: { points: m.result?.finalPointsA ?? 0, sets: m.result?.setsA ?? 0 },
        sideB: { points: m.result?.finalPointsB ?? 0, sets: m.result?.setsB ?? 0 },
        board: m.result?.boardCount ?? 0,
        currentBreak: null,
        queenHolder: null,
        matchResult: m.result?.winner ?? null,
      },
    };
  }

  const popupRecord = $derived(
    openPopup === null
      ? null
      : openPopup.source === 'live'
        ? openPopup.entry
        : matchAsLiveRecord(openPopup.match),
  );
  const popupIsEnded = $derived(
    openPopup === null
      ? false
      : openPopup.source === 'match' ||
        !!(openPopup.source === 'live' && openPopup.entry.liveState.matchResult),
  );
  const popupMode = $derived(
    openPopup === null
      ? ''
      : openPopup.source === 'live'
        ? modeLabelLive(openPopup.entry)
        : modeLabelMatch(openPopup.match),
  );

  // In overlay mode, find the target entry from the live subscription
  // whenever it lands. Renders as null until the first snapshot arrives,
  // which is fine — OBS shows the browser source with nothing until we
  // have data. The overlay is a plain transparent HTML view; nothing
  // else on the page renders.
  const overlayEntry = $derived(
    overlayMid ? entries.find((e) => e.mid === overlayMid) ?? null : null,
  );
</script>

{#if overlayMid}
  <!--
    OBS/Prism overlay mode. Transparent background, no chrome, no
    lobby. Just the scoreboard strip so broadcasters can composite it
    over their camera feed. The BaseLayout's default body colour gets
    overridden by the data-overlay attribute set in onMount.
  -->
  {#if overlayEntry}
    <div class="overlay-wrap">
      <LiveScoreboardView record={overlayEntry} />
    </div>
  {/if}
{:else}
<main>
  <header class="hdr">
    <a class="back" href={base}>← Back</a>
    <h1>Live matches</h1>
    <span class="ver" aria-label="Carromscore version">v{APP_VERSION}</span>
  </header>

  <!-- Segmented tabs -->
  <div class="tabs" role="tablist" aria-label="View">
    <button
      type="button"
      role="tab"
      class="tab"
      class:tab-active={tab === 'live'}
      aria-selected={tab === 'live'}
      onclick={() => (tab = 'live')}
    >
      <span class="tab-dot" aria-hidden="true"></span>
      Now playing
      <span class="tab-count">{live.length}</span>
    </button>
    <button
      type="button"
      role="tab"
      class="tab"
      class:tab-active={tab === 'history'}
      aria-selected={tab === 'history'}
      onclick={() => (tab = 'history')}
    >
      History
      {#if historyLoaded}<span class="tab-count">{matches.length}</span>{/if}
    </button>
  </div>

  {#if tab === 'live'}
    {#if liveLoading}
      <p class="state">Loading…</p>
    {:else if live.length === 0}
      <div class="empty">
        <p><strong>No live matches right now.</strong></p>
        <p class="empty-sub">Every match started in Carromscore appears here automatically while it's being played. Come back when someone's on the board.</p>
      </div>
    {:else}
      <ul class="grid">
        {#each live as e (e.mid)}
          {@const s = e.liveState}
          <li>
            <button type="button" class="card card-live" onclick={() => openEntry(e)}>
              <div class="card-hdr">
                <span class="card-badge">
                  <span class="dot" aria-hidden="true"></span>
                  LIVE
                </span>
                <span class="card-mode">{modeLabelLive(e)}</span>
                <span class="card-meta">{relTime(e.updatedAt)}</span>
              </div>

              <div class="card-teams">
                <span class="team-block team-a">
                  <span class="team-name">{sideNameLive(e, 'a')}</span>
                  {#if s.currentBreak === 'a'}<span class="brk">BREAK</span>{/if}
                </span>
                <span class="team-vs">vs</span>
                <span class="team-block team-b">
                  <span class="team-name">{sideNameLive(e, 'b')}</span>
                  {#if s.currentBreak === 'b'}<span class="brk">BREAK</span>{/if}
                </span>
              </div>

              <div class="card-scores">
                {#if e.meta.mode !== 'practice'}
                  <span class="score-block">
                    <span class="score-lbl">SETS</span>
                    <span class="score-val"><span class="digit-a">{s.sideA.sets}</span>–<span class="digit-b">{s.sideB.sets}</span></span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">POINTS</span>
                    <span class="score-val"><span class="digit-a">{s.sideA.points}</span>–<span class="digit-b">{s.sideB.points}</span></span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">BOARD</span>
                    <span class="score-val">{s.board}</span>
                  </span>
                {:else}
                  <span class="score-block">
                    <span class="score-lbl">MISSES</span>
                    <span class="score-val">{s.sideA.points}</span>
                  </span>
                {/if}
              </div>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {:else}
    <!-- History tab -->
    {#if historyLoading}
      <p class="state">Loading…</p>
    {:else if matches.length === 0}
      <div class="empty">
        <p><strong>No matches yet.</strong></p>
        <p class="empty-sub">Every match you complete lands here so you can look back at scores, opponents, and who won.</p>
      </div>
    {:else}
      <ul class="grid">
        {#each matches as m (m.id)}
          {@const r = m.result}
          {@const winner = r?.winner}
          <li>
            <button
              type="button"
              class="card card-ended"
              class:has-winner={!!winner}
              class:winner-a={winner === 'a'}
              class:winner-b={winner === 'b'}
              onclick={() => openMatch(m)}
            >
              <div class="card-hdr">
                <span class="card-badge card-badge-ended">Ended</span>
                <span class="card-mode">{modeLabelMatch(m)}</span>
                <span class="card-meta">{relTime(m.endedAt)}</span>
              </div>

              {#if m.mode === 'practice'}
                <div class="card-teams">
                  <span class="team-block team-a" style="flex:1">
                    <span class="team-name">{sideNameMatch(m, 'a')}</span>
                  </span>
                </div>
                <div class="card-scores">
                  <span class="score-block">
                    <span class="score-lbl">MISSES</span>
                    <span class="score-val">{r?.finalPointsA ?? 0}</span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">BOARDS</span>
                    <span class="score-val">{r?.boardCount ?? 0}</span>
                  </span>
                </div>
              {:else}
                <div class="card-teams">
                  <span class="team-block team-a" class:winner={winner === 'a'}>
                    <span class="team-name">
                      {#if winner === 'a'}<span class="crown">🏆</span>{/if}
                      {sideNameMatch(m, 'a')}
                    </span>
                  </span>
                  <span class="team-vs">vs</span>
                  <span class="team-block team-b" class:winner={winner === 'b'}>
                    <span class="team-name">
                      {#if winner === 'b'}<span class="crown">🏆</span>{/if}
                      {sideNameMatch(m, 'b')}
                    </span>
                  </span>
                </div>
                <div class="card-scores">
                  <span class="score-block">
                    <span class="score-lbl">SETS</span>
                    <span class="score-val"><span class="digit-a">{r?.setsA ?? 0}</span>–<span class="digit-b">{r?.setsB ?? 0}</span></span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">POINTS</span>
                    <span class="score-val"><span class="digit-a">{r?.finalPointsA ?? 0}</span>–<span class="digit-b">{r?.finalPointsB ?? 0}</span></span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">BOARD</span>
                    <span class="score-val">{r?.boardCount ?? 0}</span>
                  </span>
                </div>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</main>

<dialog bind:this={dialog} class="sheet" onclick={onDialogClick} onclose={closePopup}>
  {#if popupRecord}
    <div class="sheet-inner" role="document">
      <header class="sheet-hdr">
        <span class="sheet-title">
          {#if popupIsEnded}Ended · {:else}<span class="sheet-live"><span class="dot" aria-hidden="true"></span>LIVE · </span>{/if}
          {popupMode}
        </span>
        <div class="sheet-actions">
          {#if openPopup?.source === 'live'}
            <button
              type="button"
              class="sheet-share"
              onclick={copyShareUrl}
              aria-label="Copy match URL"
              title="Copy the match URL to share with viewers"
            >
              {#if copiedKind === 'share'}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">⧉</span> Share{/if}
            </button>
            <button
              type="button"
              class="sheet-share sheet-obs"
              onclick={copyObsUrl}
              aria-label="Copy OBS overlay URL"
              title="Copy the transparent-overlay URL for OBS or Prism Browser Source"
            >
              {#if copiedKind === 'obs'}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">📺</span> OBS{/if}
            </button>
          {/if}
          <button type="button" class="sheet-close" onclick={closePopup} aria-label="Close">✕</button>
        </div>
      </header>
      <div class="sheet-body">
        <LiveScoreboardView record={popupRecord} />
      </div>
    </div>
  {/if}
</dialog>
{/if}

<style>
  /* Overlay mode. Transparent html+body so OBS Browser Sources
     composite over the camera feed. The body is stretched to full
     viewport height and its child anchored to the bottom edge —
     broadcast bottom-third convention.
     Compact height: pills + columns get semi-transparent dark tint
     with backdrop-blur so they read on any camera background, and
     digit font shrinks so the strip only occupies ~15% of a 720p
     feed. */
  :global(html[data-overlay="true"]),
  :global(html[data-overlay="true"] body) {
    background: transparent !important;
    min-height: 100dvh;
  }
  :global(html[data-overlay="true"] body) {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    margin: 0;
    padding: 0;
  }
  .overlay-wrap {
    max-width: 1600px;
    width: 100%;
    margin: 0 auto;
    padding: 0.35rem 0.6rem 0.5rem;
  }
  /* Compact overrides for LiveScoreboardView when rendered inside
     .overlay-wrap. `:global` because the child component's styles are
     scoped and we can't otherwise reach them. */
  :global(.overlay-wrap .pill) {
    padding: 0.35rem 0.55rem !important;
    background: rgba(15, 15, 15, 0.62) !important;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  :global(.overlay-wrap .name) {
    font-size: 1.5rem !important;
  }
  :global(.overlay-wrap .note) {
    font-size: 0.85rem !important;
  }
  /* Slightly larger BREAK chip + queen coin so they read on a
     broadcast feed at a distance. */
  :global(.overlay-wrap .chip) {
    font-size: 0.75rem !important;
    padding: 0.15rem 0.5rem !important;
  }
  :global(.overlay-wrap .coin) {
    width: 1.25rem !important;
    height: 1.25rem !important;
  }
  :global(.overlay-wrap .board) {
    min-height: 0 !important;
    padding: 0.15rem 0 !important;
  }
  :global(.overlay-wrap .col) {
    background: rgba(15, 15, 15, 0.62) !important;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    padding: 0.3rem 0.2rem !important;
  }
  :global(.overlay-wrap .digit) {
    font-size: clamp(1.4rem, 4vw, 2.4rem) !important;
  }
  :global(.overlay-wrap .lbl) {
    font-size: 0.55rem !important;
    margin-bottom: 0.15rem !important;
  }
  :global(.overlay-wrap .hdr) {
    padding: 0 0 0.35rem !important;
  }
  :global(.overlay-wrap .pips) {
    padding: 0.2rem 0 0 !important;
  }

  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 1rem 1rem 3rem;
  }
  .hdr {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .hdr h1 {
    flex: 1;
    margin: 0;
    font-size: 1.35rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .back {
    color: var(--accent, #ffd54a);
    text-decoration: none;
    font-weight: 600;
    padding: 0.35rem 0.5rem;
    border-radius: 0.4rem;
  }
  .back:hover { background: rgba(255, 213, 74, 0.1); }
  .ver {
    color: var(--accent, #ffd54a);
    font-size: 0.75rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.3);
    padding: 0.15rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 700;
  }

  /* Segmented control */
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.25rem;
    padding: 0.25rem;
    background: #141414;
    border: 1px solid #232323;
    border-radius: 0.75rem;
    margin: 0 0 1rem;
  }
  .tab {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    background: transparent;
    border: 0;
    color: var(--muted, #9aa0a6);
    padding: 0.55rem 0.75rem;
    font-size: 0.88rem;
    font-weight: 700;
    cursor: pointer;
    border-radius: 0.5rem;
    transition: background 0.15s, color 0.15s;
    font-family: inherit;
  }
  .tab:hover { color: var(--fg, #f5f5f5); }
  .tab-active {
    background: #0b0b0b;
    color: var(--fg, #f5f5f5);
    box-shadow: 0 0 0 1px #2a2a2a inset;
  }
  .tab-count {
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
    background: rgba(255, 255, 255, 0.06);
    padding: 0.05rem 0.4rem;
    border-radius: 0.25rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .tab-active .tab-count {
    color: var(--fg, #f5f5f5);
    background: rgba(255, 255, 255, 0.12);
  }
  .tab-dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #ef5350;
    box-shadow: 0 0 6px rgba(239, 83, 80, 0.7);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .tab-active .tab-dot { box-shadow: 0 0 8px rgba(239, 83, 80, 0.9); }

  .state, .empty {
    color: var(--muted, #9aa0a6);
    text-align: center;
    padding: 3rem 1rem;
    font-size: 0.9rem;
  }
  .empty p { margin: 0.5rem 0; }
  .empty strong { color: var(--fg, #f5f5f5); font-weight: 700; }
  .empty-sub { max-width: 22rem; margin-left: auto; margin-right: auto; }

  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.7rem;
    align-items: stretch;
  }
  @media (min-width: 640px) {
    .grid { grid-template-columns: 1fr 1fr; }
  }
  .grid > li { display: flex; }

  .card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    padding: 0.9rem 1rem;
    background: #141414;
    border: 1px solid #262626;
    border-radius: 0.8rem;
    text-decoration: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    transition: border-color 0.15s, background 0.15s, transform 0.1s;
  }
  .card:hover { border-color: #3a3a3a; background: #181818; }
  .card:active { transform: scale(0.995); }
  .card-live { border-color: rgba(239, 83, 80, 0.35); }
  .card-live:hover { border-color: rgba(239, 83, 80, 0.6); }
  .card-ended { opacity: 0.85; }
  .card-ended:hover { opacity: 1; }

  .card-hdr {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.55rem;
  }
  .card-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    padding: 0.15rem 0.45rem;
    border-radius: 0.3rem;
    color: #ef5350;
    background: rgba(239, 83, 80, 0.12);
    border: 1px solid rgba(239, 83, 80, 0.35);
  }
  .card-badge .dot {
    display: inline-block;
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 50%;
    background: #ef5350;
    animation: pulse 1.6s ease-in-out infinite;
  }
  .card-badge-ended {
    color: var(--muted, #9aa0a6);
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.1);
  }
  .card-mode {
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  .card-meta {
    margin-left: auto;
    color: var(--muted, #9aa0a6);
    font-size: 0.72rem;
  }

  .card-teams {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.7rem;
    /* Grow to fill vertical space between the header and score row so
       cards with wrapping names line up their score rows with siblings. */
    flex: 1 1 auto;
  }
  .team-block {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    min-width: 0;
  }
  .team-a { align-items: flex-start; }
  .team-b { align-items: flex-end; text-align: right; }
  .team-name {
    font-weight: 700;
    font-size: 1rem;
    line-height: 1.2;
    display: inline;
    word-break: break-word;
    max-width: 100%;
  }
  .team-a .team-name { color: var(--side-a, #4fc3f7); }
  .team-b .team-name { color: var(--side-b, #ff8a65); }
  /* Medal treatment for ended matches — winner = gold, loser = silver.
     Reuses the language of the End-match popup (which uses gold +
     silver pills) and reserves the side colours (cyan/coral) for
     live matches where they still mean "side of the table".
     Only applies when a winner is declared (the .has-winner class,
     set from the template) — otherwise both sides keep their side
     colour so a truly tied match doesn't get an artificial silver
     loser. */
  .card-ended.has-winner .team-block.winner .team-name {
    color: var(--accent, #ffd54a);
    filter: brightness(1.05);
  }
  .card-ended.has-winner .team-block:not(.winner) .team-name {
    color: #c0c5cc;
  }
  .crown { font-size: 0.9rem; }
  .team-vs {
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    flex-shrink: 0;
  }
  .brk {
    font-size: 0.55rem;
    font-weight: 800;
    letter-spacing: 0.1em;
    padding: 0.08rem 0.3rem;
    border-radius: 0.25rem;
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.1);
    border: 1px solid rgba(255, 213, 74, 0.4);
    flex-shrink: 0;
  }

  .card-scores {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding-top: 0.4rem;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }
  .score-block {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .score-lbl {
    color: var(--muted, #9aa0a6);
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-weight: 700;
  }
  .score-val {
    font-weight: 700;
    font-size: 0.95rem;
    font-variant-numeric: tabular-nums;
  }
  .digit-a { color: var(--side-a, #4fc3f7); }
  .digit-b { color: var(--side-b, #ff8a65); }

  /* Score digits on ended cards flip to the winner-gold / loser-silver
     colour language, so the whole card reads as one medal narrative.
     `.winner-a` / `.winner-b` classes on the card indicate which side
     took the gold. Fully-tied matches (no winner class) keep the
     cyan/coral side colours since neither side "won". */
  .card-ended.winner-a .digit-a { color: var(--accent, #ffd54a); }
  .card-ended.winner-a .digit-b { color: #c0c5cc; }
  .card-ended.winner-b .digit-a { color: #c0c5cc; }
  .card-ended.winner-b .digit-b { color: var(--accent, #ffd54a); }

  /* Centred popup */
  dialog.sheet {
    padding: 0;
    border: none;
    max-width: 560px;
    width: calc(100vw - 2rem);
    background: transparent;
    color: inherit;
    max-height: min(90dvh, 44rem);
    top: 50%;
    transform: translateY(-50%);
    inset-inline: 0;
  }
  dialog.sheet::backdrop {
    background: rgba(0, 0, 0, 0.65);
    backdrop-filter: blur(3px);
    -webkit-backdrop-filter: blur(3px);
  }
  .sheet-inner {
    background: #0f0f0f;
    border: 1px solid rgba(255, 213, 74, 0.55);
    border-radius: 1rem;
    padding: 0.85rem 1rem 1.1rem;
    max-height: min(90dvh, 44rem);
    overflow-y: auto;
    /* Gold glow ring + hard drop shadow so the popup pops off the
       dimmed lobby behind. Two shadows: the inner amber halo carries
       the "match spotlight" feel; the outer black shadow anchors the
       popup on darker surfaces. */
    box-shadow:
      0 0 0 1px rgba(255, 213, 74, 0.35),
      0 0 32px rgba(255, 213, 74, 0.22),
      0 18px 60px rgba(0, 0, 0, 0.75);
    animation: fadeIn 0.18s ease-out;
  }
  @keyframes fadeIn {
    from { transform: scale(0.96); opacity: 0; }
    to   { transform: scale(1);    opacity: 1; }
  }
  .sheet-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.25rem 0 0.75rem;
    margin: 0 0 0.5rem;
    border-bottom: 1px solid #1e1e1e;
  }
  .sheet-title {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .sheet-live {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: #ef5350;
  }
  .sheet-live .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #ef5350;
    animation: pulse 1.6s ease-in-out infinite;
  }
  .sheet-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .sheet-share {
    background: transparent;
    border: 1px solid rgba(255, 213, 74, 0.4);
    color: var(--accent, #ffd54a);
    padding: 0.35rem 0.7rem;
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s;
  }
  .sheet-share:hover {
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.7);
  }
  .sheet-close {
    background: transparent;
    border: 1px solid #262626;
    color: var(--fg, #f5f5f5);
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .sheet-close:hover { background: #1a1a1a; border-color: #333; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
