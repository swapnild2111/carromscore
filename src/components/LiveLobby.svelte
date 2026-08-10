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
  import { subscribeAllLive, sweepStaleLive, type LobbyEntry } from '../lib/live-sync';
  import {
    loadHistory,
    playerName,
    selfDeleteMatch,
    sweepOldMatches,
    type MatchRecord,
  } from '../lib/history';
  import { subscribePlayers, subscribeStore } from '../lib/players';
  import { APP_VERSION } from '../lib/version';
  import LiveScoreboardView from './LiveScoreboardView.svelte';
  import SignInButton from './SignInButton.svelte';
  import MatchEditModal from './MatchEditModal.svelte';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';

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

  // Collapsed tournament groups, per tab. Persisted in localStorage as
  // an explicit override map: bucket key → true/false where the value
  // is the user's *intentional* state. Buckets not in the map fall
  // back to the tab's default (see DEFAULT_COLLAPSED).
  //
  // Why an explicit-override map instead of "just a Set of collapsed
  // buckets"? History has a lot of buckets and the useful default is
  // "everything folded — open what you care about". If we stored only
  // "collapsed" flags, an unfolded group would look identical to a
  // never-seen one, so the default couldn't be "collapsed" without
  // fighting the user's expand click. This shape distinguishes:
  //   "user opened it"      → override = false
  //   "user closed it"      → override = true
  //   "never touched"       → not in map → use DEFAULT_COLLAPSED[tab]
  const COLLAPSED_KEY = 'carromscore:lobby-collapsed-v2';
  const DEFAULT_COLLAPSED: Record<Tab, boolean> = {
    live: false,     // Live: default open — few groups, want them visible
    history: true,   // History: default folded — many groups, low visual weight
  };
  let groupOverride = $state<Map<string, boolean>>(loadOverride());

  function loadOverride(): Map<string, boolean> {
    try {
      const raw = localStorage.getItem(COLLAPSED_KEY);
      if (!raw) return new Map();
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return new Map();
      const out = new Map<string, boolean>();
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === 'string' && typeof v === 'boolean') out.set(k, v);
      }
      return out;
    } catch {
      return new Map();
    }
  }

  function persistOverride(): void {
    try {
      const obj: Record<string, boolean> = {};
      for (const [k, v] of groupOverride) obj[k] = v;
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(obj));
    } catch {
      // quota exceeded / disabled — overrides stay in-memory only
    }
  }

  function toggleGroup(tabName: Tab, bucket: string): void {
    const key = `${tabName}::${bucket}`;
    // Flip against the currently-effective state (default or override),
    // then record the flipped value as the user's intent.
    const now = isCollapsed(tabName, bucket);
    groupOverride.set(key, !now);
    // Reassign so Svelte's fine-grained reactivity fires — Map
    // mutations alone don't trigger $state updates.
    groupOverride = new Map(groupOverride);
    persistOverride();
  }

  function isCollapsed(tabName: Tab, bucket: string): boolean {
    const key = `${tabName}::${bucket}`;
    const override = groupOverride.get(key);
    if (typeof override === 'boolean') return override;
    return DEFAULT_COLLAPSED[tabName];
  }

  // Popup can render either a LobbyEntry (live tab) or a MatchRecord
  // (history tab). We normalise both into a LiveRecord-shaped object
  // for LiveScoreboardView to consume.
  //
  // Historically the History-tab variant captured the MatchRecord
  // object directly. That broke after admin edits — an edit reloads
  // `matches` from Firebase, but the captured object still pointed
  // at the stale array entry, so the popup showed pre-edit data
  // while the card showed post-edit. Now we hold only the id and
  // resolve against the current `matches` array at render time.
  type PopupKind = { source: 'live'; entry: LobbyEntry } | { source: 'match'; matchId: string };
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
    // Best-effort sweep of >1-year-old match records. Fire-and-forget
    // — no UI, no blocking on failure. Piggybacks on lobby loads so
    // we don't need scheduled infra.
    void sweepOldMatches();
    // Same idea for stuck /live/{mid} records (updatedAt older than
    // 4h). Killing zombie live records here keeps the Now Playing
    // list honest for casual viewers who never visit /admin/.
    void sweepStaleLive();
    const unsubStore = subscribeStore(() => (identityTick += 1));

    const nowTick = window.setInterval(() => (now = Date.now()), 30_000);
    // Role subscription — SignInButton owns the auth ↔ roles wiring
    // via setCurrentUidForRoles(); here we just read the resulting
    // stream so we can decide whether to render the edit affordance
    // on each card. Role is null when logged out or before the
    // subscription rehydrates.
    const unsubRole = subscribeCurrentUserRole((r) => (role = r));
    return () => {
      unsub?.();
      unsubStore();
      unsubRole();
      window.clearInterval(nowTick);
    };
  });

  // Role reactive state + edit-modal open target.
  let role = $state<Role | null>(null);
  let editing = $state<MatchRecord | null>(null);

  /**
   * Compute whether the current user is authorised to edit a record
   * (super OR organiser of the record's tournament). Kept close to
   * the call sites so the predicate stays easy to audit. This is
   * UI-only — the RTDB rule at /matches/$id is the actual enforcement.
   */
  function canEditMatch(m: MatchRecord): boolean {
    if (!role) return false;
    if (role.isSuper) return true;
    const tour = (m.tournament ?? '').trim();
    if (!tour) return false;
    // Tournament KEYS are the normalised form. But records store the
    // display name in `m.tournament` (as written by
    // finishMatch → tournament.trim().slice(0,60)). We need to look
    // up the key. Cheapest: normalise here inline (mirrors
    // tournaments.ts normalizeKey), no cross-module import.
    const key = tour
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9\s-]/g, ' ')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    return role.organiserOf.has(key);
  }

  /**
   * Whether the currently-signed-in user can self-delete this record.
   * True whenever the record was written by this uid — independent of
   * admin/organiser status. Super/organiser also see the ✎ pencil
   * (for score edits), but the self-delete affordance is an equally
   * available shortcut for "this is my match, wipe it" that skips
   * the edit modal entirely. UI convenience — the RTDB rule at
   * /matches/$id/.write is the enforcement layer.
   */
  function canSelfDelete(m: MatchRecord | null): boolean {
    if (!m) return false;
    const uid = currentUser()?.uid;
    if (!uid) return false;
    return m.createdBy === uid;
  }

  // Self-delete UI state. Kept close to the sheet-dialog markup below.
  // `selfDeleteConfirm` toggles the inline confirmation input; the
  // submit is gated on the user typing DELETE exactly.
  let selfDeleteConfirm = $state(false);
  let selfDeleteInput = $state('');
  let selfDeleteBusy = $state(false);
  let selfDeleteError = $state<string | null>(null);
  function resetSelfDeleteState() {
    selfDeleteConfirm = false;
    selfDeleteInput = '';
    selfDeleteBusy = false;
    selfDeleteError = null;
  }
  async function commitSelfDelete(matchId: string) {
    if (selfDeleteInput.trim().toUpperCase() !== 'DELETE') {
      selfDeleteError = 'Type DELETE to confirm.';
      return;
    }
    selfDeleteBusy = true;
    selfDeleteError = null;
    const outcome = await selfDeleteMatch(matchId);
    selfDeleteBusy = false;
    if (!outcome.ok) {
      selfDeleteError = outcome.error ?? 'Delete failed.';
      return;
    }
    // Success → close the sheet, drop the record from local state,
    // then reload History from Firebase to reconcile.
    resetSelfDeleteState();
    openPopup = null;
    matches = matches.filter((m) => m.id !== matchId);
    void loadHistory().then((m) => (matches = m));
  }

  function openEdit(m: MatchRecord, e: Event) {
    // Cards are big <button> elements that also open the popup on
    // click. Stop the event so opening the pencil doesn't also
    // open the popup underneath.
    e.stopPropagation();
    editing = m;
  }
  function closeEdit() {
    editing = null;
  }
  function afterSaved() {
    // Refresh History from Firebase so the modal's changes show.
    // Cheap — RTDB caches locally.
    void loadHistory().then((m) => (matches = m));
  }

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
    openPopup = { source: 'match', matchId: match.id };
  }
  function closePopup() {
    openPopup = null;
    resetSelfDeleteState();
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

  // Tournament bucket label. Blank tag → "Default" bucket. Same
  // logic is applied on live entries + archived matches so cards
  // group consistently across tabs.
  const DEFAULT_BUCKET = 'Default';
  function bucketOfLive(e: LobbyEntry): string {
    return (e.meta.tournament ?? '').trim() || DEFAULT_BUCKET;
  }
  function bucketOfMatch(m: MatchRecord): string {
    return (m.tournament ?? '').trim() || DEFAULT_BUCKET;
  }

  /**
   * Group an ordered list of items by their tournament bucket,
   * preserving the incoming order within each bucket. Result is a
   * list of `[bucketName, items]` pairs, ordered by the buckets'
   * most-recent activity (first appearance in the pre-sorted list).
   */
  function groupByTournament<T>(items: T[], bucketOf: (x: T) => string): Array<[string, T[]]> {
    const seen = new Map<string, T[]>();
    for (const item of items) {
      const b = bucketOf(item);
      const arr = seen.get(b) ?? [];
      arr.push(item);
      seen.set(b, arr);
    }
    return Array.from(seen.entries());
  }

  const liveGroups = $derived(groupByTournament(live, bucketOfLive));
  const historyGroups = $derived(groupByTournament(matches, bucketOfMatch));

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
        ...(m.boardLog && m.boardLog.length > 0 ? { boardLog: m.boardLog } : {}),
        ...(m.practiceBoards && m.practiceBoards.length > 0
          ? { practiceBoards: m.practiceBoards }
          : {}),
      },
    };
  }

  /**
   * Resolve the MatchRecord for the currently-open History-tab
   * popup, or null if none / not History. Re-derives whenever the
   * `matches` array is replaced (e.g. after an admin edit reload),
   * so the popup stays in sync with the underlying data. If the
   * matching record has since been deleted from Firebase, returns
   * null and the popup effectively empties.
   */
  const openMatchRecord = $derived(
    openPopup?.source === 'match'
      ? matches.find((m) => m.id === openPopup.matchId) ?? null
      : null,
  );

  const popupRecord = $derived(
    openPopup === null
      ? null
      : openPopup.source === 'live'
        ? openPopup.entry
        : openMatchRecord
          ? matchAsLiveRecord(openMatchRecord)
          : null,
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
        : openMatchRecord
          ? modeLabelMatch(openMatchRecord)
          : '',
  );
  // Tournament tag on the popup header. Empty when the record is
  // untagged (Default bucket) — no point echoing "Default" in the
  // header where the section header already made that clear.
  const popupTournament = $derived(
    openPopup === null
      ? ''
      : openPopup.source === 'live'
        ? (openPopup.entry.meta.tournament ?? '').trim()
        : (openMatchRecord?.tournament ?? '').trim(),
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
    <!--
      SignInButton mounted in `signedInOnly` mode: renders the avatar +
      menu ONLY when a user is already signed in. Anonymous visitors
      see no sign-in prompt on the lobby — sign-in lives on the home
      footer, which is the single-entry design goal.
    -->
    <SignInButton signedInOnly />
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
      {#each liveGroups as [bucket, entriesInBucket] (bucket)}
        {@const folded = isCollapsed('live', bucket)}
        <section class="tour-group" class:folded>
          <button
            type="button"
            class="tour-hdr"
            aria-expanded={!folded}
            onclick={() => toggleGroup('live', bucket)}
          >
            <span class="tour-caret" class:tour-caret-folded={folded} aria-hidden="true">▾</span>
            <span class="tour-name">{bucket}</span>
            <span class="tour-count">{entriesInBucket.length}</span>
          </button>
          {#if !folded}
          <ul class="grid">
            {#each entriesInBucket as e (e.mid)}
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
                {#if e.meta.mode === 'practice'}
                  <!-- Practice: solo drill, side B doesn't exist. -->
                  <span class="team-block team-a" style="grid-column: 1 / -1">
                    <span class="team-name">{sideNameLive(e, 'a')}</span>
                  </span>
                {:else}
                  <span class="team-block team-a">
                    <span class="team-name">{sideNameLive(e, 'a')}</span>
                    {#if s.currentBreak === 'a'}<span class="brk">BREAK</span>{/if}
                  </span>
                  <span class="team-vs">vs</span>
                  <span class="team-block team-b">
                    <span class="team-name">{sideNameLive(e, 'b')}</span>
                    {#if s.currentBreak === 'b'}<span class="brk">BREAK</span>{/if}
                  </span>
                {/if}
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
                  <!--
                    Practice: sideA.points isn't meaningful (real data
                    lives in the practiceBoards matrix). Show only
                    board number + a Solo Drill label so lobby cards
                    read consistently without inventing numbers.
                  -->
                  <span class="score-block">
                    <span class="score-lbl">BOARD</span>
                    <span class="score-val">{s.board}</span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">MODE</span>
                    <span class="score-val" style="font-size: 0.85rem">Solo drill</span>
                  </span>
                {/if}
              </div>
                </button>
              </li>
            {/each}
          </ul>
          {/if}
        </section>
      {/each}
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
      {#each historyGroups as [bucket, matchesInBucket] (bucket)}
        {@const folded = isCollapsed('history', bucket)}
        <section class="tour-group" class:folded>
          <button
            type="button"
            class="tour-hdr"
            aria-expanded={!folded}
            onclick={() => toggleGroup('history', bucket)}
          >
            <span class="tour-caret" class:tour-caret-folded={folded} aria-hidden="true">▾</span>
            <span class="tour-name">{bucket}</span>
            <span class="tour-count">{matchesInBucket.length}</span>
          </button>
          {#if !folded}
          <ul class="grid">
            {#each matchesInBucket as m (m.id)}
              {@const r = m.result}
              {@const winner = r?.winner}
              {@const editable = canEditMatch(m)}
              <li class="card-li">
                {#if editable}
                  <!--
                    Pencil sits absolutely-positioned in the card's
                    top-right corner. Sibling of the main card button
                    (nesting buttons is invalid HTML) with a higher
                    z-index so the click reaches it first. Only
                    renders when the current user is authorised to
                    edit this record.
                  -->
                  <button
                    type="button"
                    class="card-edit"
                    onclick={(e) => openEdit(m, e)}
                    aria-label="Edit match"
                  >✎</button>
                {/if}
                <button
                  type="button"
                  class="card card-ended"
                  class:has-winner={!!winner}
                  class:winner-a={winner === 'a'}
                  class:winner-b={winner === 'b'}
                  onclick={() => openMatch(m)}
                >
              <div class="card-hdr">
                {#if m.mode === 'practice'}
                  <span class="card-badge card-badge-practice">Practice</span>
                {:else}
                  <span class="card-badge card-badge-ended">Ended</span>
                {/if}
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
        </section>
      {/each}
    {/if}
  {/if}
</main>

<dialog bind:this={dialog} class="sheet" onclick={onDialogClick} onclose={closePopup}>
  {#if popupRecord}
    <div class="sheet-inner" role="document">
      <header class="sheet-hdr">
        <span class="sheet-title">
          {#if popupIsEnded}Ended · {:else}<span class="sheet-live"><span class="dot" aria-hidden="true"></span>LIVE · </span>{/if}
          {popupMode}{#if popupTournament} · <span class="sheet-tour">{popupTournament}</span>{/if}
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
        {#if openPopup?.source === 'match'}
          {@const rec = openMatchRecord}
          {#if rec}
            {@const uid = currentUser()?.uid}
            {@const owns = !!uid && rec.createdBy === uid}
            {#if rec.createdBy}
              <p class="recorded-by">
                Recorded by <strong>{rec.createdByName || 'a signed-in player'}</strong>
              </p>
            {/if}
            {#if owns}
            <div class="self-delete-zone">
              {#if !selfDeleteConfirm}
                <button
                  type="button"
                  class="self-delete-btn"
                  onclick={() => (selfDeleteConfirm = true)}
                >
                  <span aria-hidden="true">🗑</span> Delete this match
                </button>
                <p class="self-delete-hint">You recorded this match. Removing it takes it out of History for everyone.</p>
              {:else}
                <p class="self-delete-prompt">Type <strong>DELETE</strong> to confirm removal. This can't be undone.</p>
                <div class="self-delete-form">
                  <input
                    type="text"
                    class="self-delete-input"
                    bind:value={selfDeleteInput}
                    placeholder="DELETE"
                    aria-label="Type DELETE to confirm"
                    autocomplete="off"
                    autocapitalize="characters"
                    disabled={selfDeleteBusy}
                  />
                  <button
                    type="button"
                    class="self-delete-cancel"
                    onclick={resetSelfDeleteState}
                    disabled={selfDeleteBusy}
                  >Cancel</button>
                  <button
                    type="button"
                    class="self-delete-confirm"
                    onclick={() => commitSelfDelete(rec.id)}
                    disabled={selfDeleteBusy || selfDeleteInput.trim().toUpperCase() !== 'DELETE'}
                  >{selfDeleteBusy ? 'Deleting…' : 'Delete'}</button>
                </div>
                {#if selfDeleteError}
                  <p class="self-delete-error">{selfDeleteError}</p>
                {/if}
              {/if}
            </div>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</dialog>

{#if editing}
  <!--
    Admin edit modal. Sibling of the recap dialog so it can stack on
    top when needed. Visible only after the pencil affordance is
    clicked — which itself only renders for authorised users. The
    modal calls `updateMatch` / `deleteMatch` and reports success
    via the callback so we can refresh the list.
  -->
  <MatchEditModal
    record={editing}
    isSuper={!!role?.isSuper}
    onClose={closeEdit}
    onSaved={afterSaved}
  />
{/if}
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
    background: rgba(15, 15, 15, 0.75) !important;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  :global(.overlay-wrap .name) {
    font-size: 1.5rem !important;
  }
  :global(.overlay-wrap .note) {
    font-size: 0.9rem !important;
    /* Overlay context: muted grey gets swallowed by the semi-
       transparent pill tile over a busy camera feed. Bump to
       near-white with a hard text-shadow so the country/region
       reads on any background. */
    color: rgba(240, 240, 240, 0.9) !important;
    font-weight: 600 !important;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.9);
    letter-spacing: 0.02em;
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
    background: rgba(15, 15, 15, 0.75) !important;
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
  /* Overlay is the broadcast strip, not the deep-dive. Hide the
     board-by-board versus scorecard so it doesn't push the strip
     off-screen. Broadcast viewers can find the full recap in the
     /live/?mid=xxx popup instead. Practice mode's per-set rows
     already fit compactly, so they render in overlay unchanged. */
  :global(.overlay-wrap .scorecard) {
    display: none !important;
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

  /* Tournament section wrapper. Each group gets a soft-bordered
     panel so multi-tournament lobbies read as distinct buckets,
     not one long list. Header is clickable to collapse — the
     folded state persists across reloads via localStorage. */
  .tour-group {
    margin: 0 0 1rem;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 0.75rem;
    background: rgba(255,255,255,0.015);
    overflow: hidden;
  }
  .tour-group:last-of-type { margin-bottom: 0; }
  .tour-group.folded {
    background: rgba(255,255,255,0.03);
  }
  .tour-hdr {
    /* Reset button defaults — this is a full-width row-header. */
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.6rem;
    margin: 0;
    padding: 0.6rem 0.85rem;
    background: transparent;
    border: none;
    color: rgba(255,255,255,0.72);
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s;
    -webkit-tap-highlight-color: transparent;
  }
  .tour-hdr:hover { background: rgba(255,255,255,0.04); }
  .tour-hdr:focus-visible {
    outline: 2px solid var(--accent, #ffd54f);
    outline-offset: -2px;
  }
  .tour-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.6rem;
    height: 1.6rem;
    border-radius: 0.4rem;
    background: rgba(255,213,74,0.14);
    color: var(--accent, #ffd54f);
    font-size: 1.1rem;
    line-height: 1;
    flex: 0 0 auto;
    transition: transform 0.18s ease, background 0.12s;
  }
  .tour-caret-folded {
    transform: rotate(-90deg);
  }
  .tour-hdr:hover .tour-caret {
    background: rgba(255,213,74,0.22);
  }
  .tour-name { flex: 1 1 auto; }
  .tour-count {
    font-size: 0.75rem;
    font-weight: 500;
    color: rgba(255,255,255,0.6);
    background: rgba(255,255,255,0.08);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    letter-spacing: 0.02em;
    flex: 0 0 auto;
  }
  /* Grid inside a group gets its own inner padding so cards don't
     hug the section border. */
  .tour-group .grid {
    padding: 0 0.6rem 0.75rem;
  }

  /* Responsive grid: 1 col on phones, 2 on wider phones/tablets,
     3 on landscape/desktop, 4 on very wide monitors so a tournament
     scoreboard on a laptop shows more matches at a glance. */
  .grid {
    list-style: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
    align-items: stretch;
  }
  @media (min-width: 560px) {
    .grid { grid-template-columns: 1fr 1fr; }
    main { max-width: 1200px; }
  }
  @media (min-width: 900px) {
    .grid { grid-template-columns: repeat(3, 1fr); }
    main { max-width: 1400px; }
  }
  @media (min-width: 1200px) {
    .grid { grid-template-columns: repeat(4, 1fr); }
    main { max-width: 1600px; }
  }
  .grid > li { display: flex; }
  /* `.card-li` positions the pencil affordance absolutely against
     the list item, so it lands in the card's bottom-right corner
     regardless of card content height. Bottom-right chosen because
     top-right is already occupied by the relative-time meta pill.
     Only present on cards that render an edit affordance (guarded
     in the template). */
  .card-li {
    position: relative;
  }
  .card-edit {
    position: absolute;
    bottom: 0.5rem;
    right: 0.5rem;
    z-index: 3;
    width: 1.9rem;
    height: 1.9rem;
    padding: 0;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.45);
    color: var(--accent, #ffd54a);
    border-radius: 0.5rem;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.12s, border-color 0.12s, transform 0.08s;
  }
  .card-edit:hover {
    background: rgba(255, 213, 74, 0.24);
    border-color: rgba(255, 213, 74, 0.7);
  }
  .card-edit:active {
    transform: scale(0.94);
  }

  .card {
    display: flex;
    flex-direction: column;
    width: 100%;
    text-align: left;
    padding: 0.9rem 1rem;
    background: #141414;
    /* Slightly stronger card border so the cards feel like distinct
       objects on a dark page (previous #262626 washed into the bg
       almost invisibly). Still restrained — full-brightness borders
       compete with the winner-gold accent. */
    border: 1px solid rgba(255, 255, 255, 0.09);
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
  /* Distinct amber tint for finished Practice sessions so users can
     tell them apart from vs-match cards at a glance. */
  .card-badge-practice {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
    border-color: rgba(255, 213, 74, 0.35);
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
  /* Medal treatment for ended cards — winner = gold, loser = plain
     white (not "silver-dim", which read as punishing). Reserves the
     side colours (cyan/coral) for live matches where they still mean
     "side of the table". Only applies when a winner is declared;
     truly tied matches (no `.has-winner`) keep their side colours. */
  .card-ended.has-winner .team-block.winner .team-name {
    color: var(--accent, #ffd54a);
    filter: brightness(1.05);
  }
  .card-ended.has-winner .team-block:not(.winner) .team-name {
    color: var(--fg, #f5f5f5);
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
  .card-ended.winner-a .digit-b { color: var(--fg, #f5f5f5); }
  .card-ended.winner-b .digit-a { color: var(--fg, #f5f5f5); }
  .card-ended.winner-b .digit-b { color: var(--accent, #ffd54a); }

  /* Centred popup. Sits at viewport centre with a mild margin from
     each edge. Constrained by explicit max-width AND max-height so
     it never reaches the screen edge on any device. On landscape or
     wide screens the max-width caps it at 560px; on portrait phones
     the calc respects safe-area insets so the popup stays inside
     the notch / rounded corners. */
  dialog.sheet {
    padding: 0;
    border: none;
    margin: auto;
    background: transparent;
    color: inherit;
    box-sizing: border-box;
    width: min(560px, calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
    max-width: 100%;
    max-height: min(90dvh, 44rem);
    position: fixed;
    inset: 0;
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
  .sheet-tour {
    color: var(--gold, #ffd54f);
    letter-spacing: 0.02em;
    text-transform: none;
    font-weight: 600;
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

  /* Small attribution line above the self-delete area. Only visible
     when the record carries a createdBy uid. displayName is the write-
     time Google profile name (denormalised onto the match record),
     never the email — /users is super-read only. */
  .recorded-by {
    margin: 1rem 0 0;
    font-size: 0.75rem;
    color: var(--muted, #9aa0a6);
    text-align: right;
  }
  .recorded-by strong {
    color: var(--fg, #f5f5f5);
    font-weight: 600;
  }

  /* Self-delete zone at the bottom of the match sheet — muted so it
     doesn't distract from the recap, but reachable when the caller
     recognises "this is my match, I want to remove it". */
  .self-delete-zone {
    margin-top: 1.5rem;
    padding: 0.9rem 1rem 1rem;
    border-top: 1px solid #1f1f1f;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .self-delete-btn {
    align-self: flex-start;
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.35);
    color: rgba(239, 83, 80, 0.9);
    padding: 0.4rem 0.85rem;
    border-radius: 999px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    cursor: pointer;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .self-delete-btn:hover {
    background: rgba(239, 83, 80, 0.08);
    border-color: rgba(239, 83, 80, 0.7);
    color: var(--danger, #ef5350);
  }
  .self-delete-hint {
    margin: 0;
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
    line-height: 1.4;
  }
  .self-delete-prompt {
    margin: 0;
    color: var(--fg, #f5f5f5);
    font-size: 0.8rem;
    line-height: 1.4;
  }
  .self-delete-prompt strong { color: var(--danger, #ef5350); letter-spacing: 0.06em; }
  .self-delete-form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .self-delete-input {
    flex: 1 1 8rem;
    min-width: 8rem;
    background: #0f0f0f;
    border: 1px solid #262626;
    color: var(--fg, #f5f5f5);
    padding: 0.45rem 0.7rem;
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.85rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .self-delete-input:focus {
    outline: none;
    border-color: rgba(239, 83, 80, 0.6);
  }
  .self-delete-cancel,
  .self-delete-confirm {
    padding: 0.45rem 0.85rem;
    border-radius: 6px;
    font-size: 0.78rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    cursor: pointer;
    font-family: inherit;
    border: 1px solid;
    transition: opacity 0.15s;
  }
  .self-delete-cancel {
    background: transparent;
    border-color: #262626;
    color: var(--fg, #f5f5f5);
  }
  .self-delete-cancel:hover { background: #1a1a1a; }
  .self-delete-confirm {
    background: rgba(239, 83, 80, 0.9);
    border-color: rgba(239, 83, 80, 0.9);
    color: #0b0b0b;
  }
  .self-delete-confirm:hover { background: var(--danger, #ef5350); }
  .self-delete-confirm:disabled,
  .self-delete-cancel:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .self-delete-error {
    margin: 0.1rem 0 0;
    color: var(--danger, #ef5350);
    font-size: 0.75rem;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }
</style>
