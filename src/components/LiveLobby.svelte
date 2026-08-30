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
    reconcileResultFromBoardLog,
    selfDeleteMatch,
    sweepOldMatches,
    type MatchRecord,
  } from '../lib/history';
  import { subscribePlayers, subscribeStore } from '../lib/players';
  import { APP_VERSION, releaseUrl } from '../lib/version';
  import LiveScoreboardView from './LiveScoreboardView.svelte';
  import OverlayBoard from './OverlayBoard.svelte';
  import SignInButton from './SignInButton.svelte';
  // FeedbackPopup removed — v3.4.8 merged the lobby footer's
  // separate "Feedback" link into the "Help" entry, which points
  // at /help/ where the popup now lives.
  import MatchEditModal from './MatchEditModal.svelte';
  import ReportsTab from './reports/ReportsTab.svelte';
  import { logScreen } from '../lib/analytics';
  import { subscribeCurrentUserRole, type Role } from '../lib/roles';
  import { currentUser } from '../lib/auth';
  import {
    normalizeKey,
    loadRounds,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
    findByKey,
    type Round,
  } from '../lib/tournaments';
  import { subscribeConnectivity } from '../lib/connectivity';
  import { peekLive, SYNC_QUEUE_STORAGE_KEY } from '../lib/sync-queue';
  import { loadResume } from '../lib/resume';

  const base: string = import.meta.env.BASE_URL;
  const STALE_WINDOW_MS = 4 * 60 * 60 * 1000;

  type Tab = 'live' | 'history' | 'reports';
  let tab = $state<Tab>('live');
  /**
   * Selected tournament in the Reports tab. `null` = the Default
   * (untagged) bucket; `undefined` = nothing picked yet. Held here
   * (not inside ReportsTab) so it survives tab-switches and can be
   * mirrored to the URL for deep-linking.
   */
  let reportsSelection = $state<string | null | undefined>(undefined);
  let liveLoading = $state(true);
  /**
   * Mirrors src/lib/connectivity.ts's canonical online signal.
   * When false, we clear liveLoading immediately (Firebase's
   * subscribeAllLive callback would otherwise never fire and the
   * "Loading…" spinner would sit forever) and swap the empty-state
   * copy to something offline-aware.
   */
  let online = $state(true);
  let historyLoading = $state(false);
  let historyLoaded = $state(false);
  let entries = $state<LobbyEntry[]>([]);
  /**
   * Locally-synthesised lobby entries backed by the offline sync
   * queue. When the umpire is scoring an offline match on device A
   * and opens /live/ in another tab on the same device, they should
   * see their own active match in the lobby before it flushes to
   * Firebase. Populated from sync-queue's peekLive() + resume.ts's
   * saved scoreUrl. Merged into `live` (below) alongside Firebase
   * entries; marked with `_local: true` so the render can tag them
   * with an OFFLINE chip and tap-through to the umpire's own
   * score screen instead of the spectator popup.
   *
   * Kept in sync with the queue via a `storage` event listener
   * that fires when any tab (including the scoring tab) writes to
   * the queue's localStorage key. Same-origin only — the offline
   * umpire is by definition on one device.
   */
  let localOfflineEntries = $state<LobbyEntry[]>([]);
  /** Set of mids whose lobby entry is locally-synthesised (offline
   *  queue), so card renderers can style them differently and the
   *  tap handler can route them to /score/ instead of the popup. */
  const localOfflineMids = $derived(new Set(localOfflineEntries.map((e) => e.mid)));
  let matches = $state<MatchRecord[]>([]);

  /*
   * History table state (v3.4.12). The tab is table-only now — the
   * card layout was removed after landing on beta because the table
   * covered every use case (scan, sort, filter) more directly.
   *
   * `historySortKey` + `historySortDir` control the sort. Defaults to
   * endedAt DESC. Persisted to localStorage so the umpire's ordering
   * preference sticks across sessions.
   *
   * Filters:
   *  - `filterSearch`: substring match against any of aName / a2Name /
   *    bName / b2Name (case-insensitive).
   *  - `filterMode`: 'all' or one of 'singles' | 'doubles' | 'practice'.
   *  - `filterTournament`: '' = all, DEFAULT_BUCKET = untagged only,
   *    or a specific tournament name.
   *  - `filterDays`: 0 = all, or a rolling window in days (7 / 30 / 90).
   */
  type HistorySortKey = 'endedAt' | 'mode' | 'sideA' | 'sideB' | 'sets' | 'boards' | 'points';
  const HISTORY_PREFS_KEY = 'carromscore.history.prefs.v1';
  function loadHistoryPrefs(): {
    sortKey: HistorySortKey;
    sortDir: 'asc' | 'desc';
    filterMode: 'all' | 'singles' | 'doubles' | 'practice';
    filterTournament: string;
    filterDays: number;
    filterSearch: string;
  } {
    const fallback = {
      sortKey: 'endedAt' as HistorySortKey,
      sortDir: 'desc' as const,
      filterMode: 'all' as const,
      filterTournament: '',
      filterDays: 0,
      filterSearch: '',
    };
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(HISTORY_PREFS_KEY) : null;
      if (!raw) return fallback;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        sortKey: (['endedAt','mode','sideA','sideB','sets','boards','points'] as const)
          .includes(parsed.sortKey as HistorySortKey)
          ? (parsed.sortKey as HistorySortKey)
          : 'endedAt',
        sortDir: parsed.sortDir === 'asc' ? 'asc' : 'desc',
        filterMode: (['all','singles','doubles','practice'] as const)
          .includes(parsed.filterMode as 'all' | 'singles' | 'doubles' | 'practice')
          ? (parsed.filterMode as 'all' | 'singles' | 'doubles' | 'practice')
          : 'all',
        filterTournament: typeof parsed.filterTournament === 'string' ? parsed.filterTournament : '',
        filterDays: typeof parsed.filterDays === 'number' && parsed.filterDays >= 0
          ? parsed.filterDays
          : 0,
        filterSearch: typeof parsed.filterSearch === 'string' ? parsed.filterSearch : '',
      };
    } catch {
      return fallback;
    }
  }
  const initialHistoryPrefs = loadHistoryPrefs();
  let historySortKey = $state<HistorySortKey>(initialHistoryPrefs.sortKey);
  let historySortDir = $state<'asc' | 'desc'>(initialHistoryPrefs.sortDir);
  let filterMode = $state<'all' | 'singles' | 'doubles' | 'practice'>(initialHistoryPrefs.filterMode);
  let filterTournament = $state<string>(initialHistoryPrefs.filterTournament);
  let filterDays = $state<number>(initialHistoryPrefs.filterDays);
  let filterSearch = $state<string>(initialHistoryPrefs.filterSearch);
  $effect(() => {
    try {
      const payload = {
        sortKey: historySortKey,
        sortDir: historySortDir,
        filterMode,
        filterTournament,
        filterDays,
        filterSearch,
      };
      localStorage.setItem(HISTORY_PREFS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  });
  let now = $state(Date.now());
  let identityTick = $state(0);
  // Tick bumped whenever the /tournaments store notifies (v3.2). Read
  // by round-grouping derived so History re-renders when a round is
  // added / renamed / closed / deleted from another device.
  let tournamentTick = $state(0);

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
    reports: true,   // Reports: no groups, unused — kept in type for exhaustiveness
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
  // openPopup stores an IDENTIFIER (mid for live, matchId for history)
  // and resolves the current record via `$derived` on each render. That
  // way subscribeAllLive updates propagate to the open sheet dialog —
  // previously the live variant captured the entry object by value at
  // click time, so the sheet was a frozen snapshot instead of a
  // live view. Fixed 2026-08-11.
  type PopupKind = { source: 'live'; mid: string } | { source: 'match'; matchId: string };
  let openPopup = $state<PopupKind | null>(null);
  let dialog: HTMLDialogElement | null = $state(null);
  // Deep-link support: /live/?mid=xxx auto-opens the popup for that
  // match. Cleared once the popup opens (or when the user manually
  // closes it) so subsequent updates to `entries` don't re-open it.
  let pendingMid = $state<string | null>(null);
  // Deep-link support for history archives: /live/?match=<id>. Held
  // until loadHistory() completes; opened as soon as the matching
  // record appears in the `matches` array. Cleared on open.
  let pendingMatchId = $state<string | null>(null);
  // Overlay mode: /live/?mid=xxx&view=overlay renders ONLY the
  // scoreboard strip on a transparent background. Meant for OBS /
  // Prism as a Browser Source over a live camera feed.
  let overlayMid = $state<string | null>(null);

  /**
   * Mirror the current tab + Reports selection into the URL query
   * string so the page is deep-linkable. Uses replaceState so the
   * browser history doesn't fill up with per-tab entries — the Back
   * button still takes the user to the home screen, not through
   * every tab they touched.
   */
  function syncUrl(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    // Preserve mid/view for overlay flows; touch only tab + tournament.
    if (tab === 'live') url.searchParams.delete('tab');
    else url.searchParams.set('tab', tab);
    if (tab === 'reports') {
      if (reportsSelection === undefined) url.searchParams.delete('tournament');
      else if (reportsSelection === null) url.searchParams.set('tournament', '');
      else url.searchParams.set('tournament', reportsSelection);
    } else {
      url.searchParams.delete('tournament');
    }
    window.history.replaceState({}, '', url.toString());
  }

  onMount(() => {
    // v3.4: log screen_view for the lobby (no-op without consent).
    // The isSpectatorView() guard inside analytics.ts drops
    // ?mid=... shares so a WhatsApp click doesn't inflate DAU.
    void logScreen('lobby');
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

    // Deep-link for Reports: /live/?tab=reports[&tournament=<name>].
    // `tab=reports` opens the Reports tab straight away; `tournament`
    // pre-selects a picker chip. Unknown tournament names fall
    // through to null and the picker shows nothing selected.
    const tabParam = params.get('tab');
    if (tabParam === 'history') tab = 'history';
    else if (tabParam === 'reports') tab = 'reports';
    const tournamentParam = params.get('tournament');
    if (tournamentParam !== null) {
      // Empty-string tournament param = the Default (untagged)
      // bucket. Non-empty = a real tournament name.
      reportsSelection = tournamentParam || null;
    }

    // Deep-link for a specific history record: /live/?match=<id> (or
    // ?tab=history&match=<id>). Matches on MatchRecord.id (a Firebase
    // push-id). Held as pendingMatchId until loadHistory() finishes;
    // opened when the record appears in the loaded matches array.
    const matchParam = params.get('match');
    if (matchParam && /^[A-Za-z0-9_-]{6,40}$/.test(matchParam)) {
      pendingMatchId = matchParam;
      // If the URL didn't ask for a specific tab, default to history
      // — otherwise respect the explicit tab= choice above.
      if (!tabParam) tab = 'history';
    }

    let unsub: (() => void) | null = null;
    void subscribeAllLive((e) => {
      entries = e;
      liveLoading = false;
    }).then((fn) => {
      unsub = fn;
    });

    // Connectivity mirror. When offline, we can't get a callback
    // from subscribeAllLive so `liveLoading` would stay true and
    // the "Loading…" spinner would never clear. Force it off the
    // moment we know we're offline; the empty-state block then
    // shows an offline-aware message instead of a stuck spinner.
    const unsubConn = subscribeConnectivity((state) => {
      online = state.online;
      if (!state.online) {
        liveLoading = false;
        historyLoading = false;
      }
      // Any connectivity change may have triggered a queue flush
      // (see BaseLayout's global handler). Refresh the local-offline
      // entries in case the flush drained something.
      refreshLocalOffline();
    });

    // Local offline entries — populated from sync-queue's peekLive()
    // and refreshed on cross-tab storage events. See the field
    // declaration above for the "why."
    refreshLocalOffline();
    const onStorage = (ev: StorageEvent) => {
      // Re-read on writes to the sync queue, the resume pointer,
      // OR any per-match state key (`carromscore:state:*`). The
      // score state key changes on every tap on Tab A even before
      // the offline enqueue fires, so it's a more reliable signal
      // for "user did something." A null key means "clear all
      // storage" — refresh in that case too.
      if (
        ev.key === null ||
        ev.key === SYNC_QUEUE_STORAGE_KEY ||
        ev.key === 'carromscore:resumeMid' ||
        (typeof ev.key === 'string' && ev.key.startsWith('carromscore:state:'))
      ) {
        refreshLocalOffline();
      }
    };
    window.addEventListener('storage', onStorage);
    // Poll fallback: `storage` events are the primary signal but
    // some browser/SW combinations delay them or drop them
    // entirely on the same origin. 1s poll picks up the state
    // fast enough for a live-lobby feel without being wasteful.
    const localOfflinePoll = window.setInterval(refreshLocalOffline, 1000);

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
    // Subscribe to /tournaments so the History tab knows about each
    // tournament's rounds (v3.2). Without this the two-level grouping
    // would render every match as "Unassigned" because loadRounds()
    // returns [] against an unhydrated store.
    void subscribeTournaments();
    const unsubStore = subscribeStore(() => (identityTick += 1));
    const unsubTournaments = subscribeTournamentsStore(() => (tournamentTick += 1));

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
      unsubTournaments();
      unsubRole();
      unsubConn();
      window.removeEventListener('storage', onStorage);
      window.clearInterval(nowTick);
      window.clearInterval(localOfflinePoll);
    };
  });

  /**
   * Read the offline sync queue's `live` entries and synthesise
   * LobbyEntry-shaped rows from them, so the /live/ lobby can
   * show an active offline match to a same-device second tab.
   *
   * `enqueuedAt` becomes updatedAt so the entry sorts alongside
   * Firebase entries and passes the STALE_WINDOW_MS filter.
   * `matchId` stays undefined — this record isn't archived yet.
   */
  function refreshLocalOffline(): void {
    if (typeof window === 'undefined') return;
    let queued: ReturnType<typeof peekLive>;
    try {
      queued = peekLive();
    } catch {
      queued = [];
    }
    // Always reassign. An earlier version added a shallow same-shape
    // guard on (mid, updatedAt) to skip no-op renders, but that
    // made the lobby miss same-mid updates when the payload changed
    // but the coalesce didn't bump updatedAt in a shape our guard
    // could see. Cheap to always rebuild; the array is short
    // (usually 1 entry) and Svelte's reactivity does its own diff.
    localOfflineEntries = queued.map((q) => ({
      mid: q.mid,
      updatedAt: q.enqueuedAt,
      meta: q.meta,
      liveState: q.payload,
    }));
  }

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
    if (!role.isOrganiser) return false;
    // Own-only auth (v3.3): organiser can edit only when they created
    // the parent tournament. Look up the tournament record from the
    // store; if it isn't loaded yet (initial hydration race), the
    // gate stays false — pencil doesn't render until we know.
    const key = m.tournamentKey ?? normalizeKey(m.tournament ?? '');
    if (!key) return false;
    const t = findByKey(key);
    if (!t) return false;
    const myUid = currentUser()?.uid;
    return !!(myUid && t.createdBy === myUid);
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
  // are cheap — Firebase caches the read. Also fires on Reports
  // switch because Reports reads the same /matches tree.
  $effect(() => {
    if ((tab !== 'history' && tab !== 'reports') || historyLoaded) return;
    historyLoading = true;
    void loadHistory().then((m) => {
      matches = m;
      historyLoading = false;
      historyLoaded = true;
    });
  });

  // Mirror tab + Reports selection into the URL query string.
  $effect(() => {
    // Reactive deps: touch tab and reportsSelection so the effect
    // re-runs on either change.
    void tab;
    void reportsSelection;
    syncUrl();
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
    openPopup = { source: 'live', mid: match.mid };
    pendingMid = null;
  });

  // Same shape for history archives: /live/?match=<id> opens the
  // sheet dialog with the matching MatchRecord.
  $effect(() => {
    if (!pendingMatchId) return;
    const match = matches.find((m) => m.id === pendingMatchId);
    if (!match) return;
    openPopup = { source: 'match', matchId: match.id };
    pendingMatchId = null;
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
    return openPopup.mid;
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
  /**
   * Copy the shareable /live/?tab=history&match=... URL for the
   * currently-open history-match popup (v3.4.12). Wired to the popup
   * header's Share button. The tap-through URL scheme mirrors the
   * per-card copy — anyone opening it lands on the same popup.
   */
  async function copyMatchShareUrl() {
    if (openPopup?.source !== 'match') return;
    const id = openPopup.matchId;
    const url = `${window.location.origin}${base}live/?tab=history&match=${encodeURIComponent(id)}`;
    await writeClipboard(url);
    copiedKind = 'share';
    if (copiedTimer !== null) window.clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copiedKind = null; }, 1500);
  }

  function openEntry(entry: LobbyEntry) {
    // Local offline entry: no Firebase record to subscribe the
    // popup to. Instead, hop to the umpire's own /score/?... URL
    // stored by resume.ts at match Start. Same-device only —
    // scoreUrl points at localhost/production of THIS device.
    if (localOfflineMids.has(entry.mid)) {
      const rec = loadResume();
      if (rec && rec.mid === entry.mid) {
        window.location.href = rec.scoreUrl;
        return;
      }
      // If the resume pointer is stale (e.g. multiple offline
      // matches were queued and only the latest's scoreUrl is
      // remembered), fall through to the popup — it'll show
      // "no live match at this URL," which is at least a real
      // signal instead of a silent no-op.
    }
    openPopup = { source: 'live', mid: entry.mid };
    copiedKind = null;
  }
  // Per-card copied tick. Tracks which card's copy button was last
  // tapped so only that button's icon flips. Separate from copiedKind
  // above (which tracks the sheet dialog's Share/OBS buttons). Value
  // is the card identifier ("live:<mid>" or "match:<id>") so the two
  // tabs' cards can't accidentally share a checkmark.
  let copiedCardKey = $state<string | null>(null);
  let copiedCardTimer: number | null = null;
  async function copyLiveMidUrl(mid: string, event: Event): Promise<void> {
    // Stop propagation so the surrounding card doesn't also open the
    // sheet dialog on the same tap.
    event.stopPropagation();
    const url = `${window.location.origin}${base}live/?mid=${encodeURIComponent(mid)}`;
    await writeClipboard(url);
    copiedCardKey = `live:${mid}`;
    if (copiedCardTimer !== null) window.clearTimeout(copiedCardTimer);
    copiedCardTimer = window.setTimeout(() => { copiedCardKey = null; }, 1500);
  }
  async function copyMatchIdUrl(id: string, event: Event): Promise<void> {
    event.stopPropagation();
    const url = `${window.location.origin}${base}live/?tab=history&match=${encodeURIComponent(id)}`;
    await writeClipboard(url);
    copiedCardKey = `match:${id}`;
    if (copiedCardTimer !== null) window.clearTimeout(copiedCardTimer);
    copiedCardTimer = window.setTimeout(() => { copiedCardKey = null; }, 1500);
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
  //
  // Merges Firebase-backed entries with any locally-synthesised
  // offline entries (from the sync queue). Firebase entries win on
  // duplicate mids — once a live match syncs, the offline synthesis
  // fades out on the next refreshLocalOffline() call. Offline entries
  // don't have a matchResult so they always pass the ongoing filter.
  const live = $derived.by(() => {
    const firebaseMids = new Set(entries.map((e) => e.mid));
    const offlineOnly = localOfflineEntries.filter((e) => !firebaseMids.has(e.mid));
    return [...entries, ...offlineOnly]
      .filter((e) => !e.liveState.matchResult)
      .filter((e) => now - e.updatedAt < STALE_WINDOW_MS)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  });

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
  // Split the History tab into versus buckets + a separate Practice
  // section below. Practice records don't belong under any tournament
  // (setup hides the tag field for solo drills), so lumping them into
  // the "Default" bucket alongside untagged versus matches was
  // visually confusing — different stats, different render shape.
  // Now: tournament groups render first, Practice section renders
  // after them if any practice records exist.
  // For card view: derive versus + practice from the filtered set so
  // the toolbar's filters affect both views. Table view uses its own
  // `sortedHistoryTable` derived below.
  const versusMatches = $derived(filteredHistory.filter((m) => m.mode !== 'practice'));
  const practiceMatches = $derived(
    filteredHistory.filter((m) => m.mode === 'practice')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)),
  );
  const historyGroups = $derived(groupByTournament(versusMatches, bucketOfMatch));

  /**
   * Derived helpers for the history filter + table view (v3.4.12).
   *
   * `tournamentBuckets`: distinct tournament labels seen in the
   * current archive. Feeds the tournament filter dropdown. Ordered
   * with DEFAULT_BUCKET first (matches the visual convention).
   *
   * `filteredHistory`: `matches` after applying the four filters —
   * search, mode, tournament, date range. Both card and table views
   * consume this as their base list. Practice matches pass through
   * unless filterMode explicitly excludes them.
   *
   * `sortedHistoryTable`: `filteredHistory` sorted by the current
   * column + direction. Table view only.
   */
  const tournamentBuckets = $derived.by(() => {
    const seen = new Set<string>();
    seen.add(DEFAULT_BUCKET);
    for (const m of matches) {
      const t = (m.tournament ?? '').trim();
      if (t) seen.add(t);
    }
    return Array.from(seen);
  });
  /**
   * Full name of side A / side B for filter search + table columns.
   * Uses the same helper the card renderer uses so team-name shape
   * is identical across views.
   */
  function sideFullNameForFilter(m: MatchRecord, side: 'a' | 'b'): string {
    return sideNameMatch(m, side).toLowerCase();
  }
  const filteredHistory = $derived.by(() => {
    const q = filterSearch.trim().toLowerCase();
    const cutoff = filterDays > 0 ? Date.now() - filterDays * 24 * 60 * 60 * 1000 : 0;
    return matches.filter((m) => {
      if (filterMode !== 'all' && m.mode !== filterMode) return false;
      if (filterTournament) {
        const tb = (m.tournament ?? '').trim() || DEFAULT_BUCKET;
        if (tb !== filterTournament) return false;
      }
      if (cutoff > 0 && (m.endedAt ?? 0) < cutoff) return false;
      if (q) {
        const hay = `${sideFullNameForFilter(m, 'a')} ${sideFullNameForFilter(m, 'b')}`;
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });
  const sortedHistoryTable = $derived.by(() => {
    const arr = [...filteredHistory];
    const dir = historySortDir === 'asc' ? 1 : -1;
    const key = historySortKey;
    arr.sort((a, b) => {
      let av: number | string = 0;
      let bv: number | string = 0;
      switch (key) {
        case 'endedAt':
          av = a.endedAt ?? 0; bv = b.endedAt ?? 0; break;
        case 'mode':
          av = a.mode; bv = b.mode; break;
        case 'sideA':
          av = sideNameMatch(a, 'a').toLowerCase();
          bv = sideNameMatch(b, 'a').toLowerCase();
          break;
        case 'sideB':
          av = sideNameMatch(a, 'b').toLowerCase();
          bv = sideNameMatch(b, 'b').toLowerCase();
          break;
        case 'sets':
          av = (a.result?.setsA ?? 0) + (a.result?.setsB ?? 0);
          bv = (b.result?.setsA ?? 0) + (b.result?.setsB ?? 0);
          break;
        case 'boards':
          av = a.result?.boardCount ?? 0;
          bv = b.result?.boardCount ?? 0;
          break;
        case 'points':
          av = (a.result?.finalPointsA ?? 0) + (a.result?.finalPointsB ?? 0);
          bv = (b.result?.finalPointsA ?? 0) + (b.result?.finalPointsB ?? 0);
          break;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tiebreak on endedAt DESC so equal keys stay newest-first.
      return ((b.endedAt ?? 0) - (a.endedAt ?? 0));
    });
    return arr;
  });
  function toggleSort(k: HistorySortKey): void {
    if (historySortKey === k) {
      historySortDir = historySortDir === 'asc' ? 'desc' : 'asc';
    } else {
      historySortKey = k;
      historySortDir = k === 'sideA' || k === 'sideB' || k === 'mode' ? 'asc' : 'desc';
    }
  }
  function clearFilters(): void {
    filterSearch = '';
    filterMode = 'all';
    filterTournament = '';
    filterDays = 0;
    // Reset sort to the default (endedAt DESC) whenever filters are
    // cleared. Reported 2026-08-30: after sorting by a column and
    // then clearing filters, the table stayed on the manual sort
    // instead of returning to a "just show me recent" view.
    historySortKey = 'endedAt';
    historySortDir = 'desc';
  }
  const anyFilterActive = $derived(
    filterSearch.trim() !== '' ||
    filterMode !== 'all' ||
    filterTournament !== '' ||
    filterDays > 0
  );

  /**
   * Sentinel key for the "matches without a round" sub-group inside a
   * tournament. Used both as the round-key returned from
   * groupByRound() and as the isCollapsed-Map key so the umpire's
   * "unassigned" fold state is remembered per tournament. `__` prefix
   * matches the same convention as PRACTICE_BUCKET; normalizeKey
   * disallows leading/trailing dashes and lowercases everything, so a
   * real round can never collide.
   */
  const UNASSIGNED_ROUND_KEY = '__unassigned__';

  /**
   * Sub-group matches within a single tournament bucket by their
   * roundKey. Returned entries are [roundKey, roundName, matches[]]
   * — the roundKey drives the collapsed-state map + `key=` on the
   * `{#each}`; roundName is the display header text.
   *
   * Ordering rule: rounds defined in the tournament record are
   * listed in their `order` field's ascending order (R16 → QF → SF
   * → F). Any un-ordered/unknown round tag lands in a bucket sorted
   * by first-seen (which mirrors the incoming versusMatches order —
   * most-recent endedAt first). Unassigned always lands last so the
   * organiser's structured rounds sit at the top and the loose bits
   * are visually deprioritised.
   *
   * When the tournament has NO rounds at all, returns a single-entry
   * list with roundKey === UNASSIGNED_ROUND_KEY and roundName === '' —
   * template detects this shape and falls back to the flat render
   * (no round sub-headers), preserving pre-v3.2 UX.
   */
  function groupByRound(
    tournamentKey: string,
    matches: MatchRecord[],
  ): Array<[string, string, MatchRecord[]]> {
    void tournamentTick;
    const roster = loadRounds(tournamentKey);
    if (roster.length === 0) {
      return [['', '', matches]];
    }
    // rounds arrive already-sorted by `order` from loadRounds
    const orderMap = new Map<string, { name: string; order: number }>();
    for (const r of roster) orderMap.set(r.key, { name: r.name, order: r.order });
    const known = new Map<string, MatchRecord[]>();
    const unknown = new Map<string, { name: string; items: MatchRecord[] }>();
    const unassigned: MatchRecord[] = [];
    for (const m of matches) {
      const rk = (m.roundKey ?? '').trim();
      if (!rk) {
        unassigned.push(m);
        continue;
      }
      if (orderMap.has(rk)) {
        const list = known.get(rk) ?? [];
        list.push(m);
        known.set(rk, list);
      } else {
        // A round tag that references a round no longer in the
        // tournament roster (organiser deleted the round record).
        // Render under a bucket labelled by whatever the match's
        // display-name `round` field was — data faithful, and the
        // umpire can still spot the ghost group.
        const bucket = unknown.get(rk) ?? { name: (m.round ?? '').trim() || rk, items: [] };
        bucket.items.push(m);
        unknown.set(rk, bucket);
      }
    }
    const out: Array<[string, string, MatchRecord[]]> = [];
    // Known rounds in the tournament's order.
    for (const r of roster) {
      const items = known.get(r.key);
      if (items && items.length > 0) out.push([r.key, r.name, items]);
    }
    // Then ghost rounds (deleted from the tournament but still tagged
    // on matches). Sorted alphabetically for stability.
    const ghostKeys = Array.from(unknown.keys()).sort();
    for (const gk of ghostKeys) {
      const b = unknown.get(gk)!;
      out.push([gk, b.name, b.items]);
    }
    // Unassigned tail.
    if (unassigned.length > 0) {
      out.push([UNASSIGNED_ROUND_KEY, 'Unassigned', unassigned]);
    }
    return out;
  }

  /**
   * v3.3.5: live-side counterpart of groupByRound. Same logic —
   * split entries into (known rounds in tournament order, ghost
   * rounds alphabetically, unassigned tail) — but keyed on the
   * live entry's meta.round / meta.roundKey. Returned as the same
   * `[roundKey, roundName, entries]` shape so the render template
   * can iterate uniformly.
   *
   * Returns `[['', '', entries]]` when the tournament has no rounds
   * roster loaded — the render template detects this and skips the
   * round sub-header, keeping the pre-v3.3.5 flat layout intact
   * for tournaments that don't use rounds.
   */
  function groupLiveByRound(
    tournamentKey: string,
    entries: LobbyEntry[],
  ): Array<[string, string, LobbyEntry[]]> {
    void tournamentTick;
    const roster = loadRounds(tournamentKey);
    if (roster.length === 0) {
      return [['', '', entries]];
    }
    const orderMap = new Map<string, { name: string; order: number }>();
    for (const r of roster) orderMap.set(r.key, { name: r.name, order: r.order });
    const known = new Map<string, LobbyEntry[]>();
    const unknown = new Map<string, { name: string; items: LobbyEntry[] }>();
    const unassigned: LobbyEntry[] = [];
    for (const e of entries) {
      const rk = (e.meta.roundKey ?? '').trim();
      if (!rk) {
        unassigned.push(e);
        continue;
      }
      if (orderMap.has(rk)) {
        const list = known.get(rk) ?? [];
        list.push(e);
        known.set(rk, list);
      } else {
        const bucket = unknown.get(rk) ?? { name: (e.meta.round ?? '').trim() || rk, items: [] };
        bucket.items.push(e);
        unknown.set(rk, bucket);
      }
    }
    const out: Array<[string, string, LobbyEntry[]]> = [];
    for (const r of roster) {
      const items = known.get(r.key);
      if (items && items.length > 0) out.push([r.key, r.name, items]);
    }
    const ghostKeys = Array.from(unknown.keys()).sort();
    for (const gk of ghostKeys) {
      const b = unknown.get(gk)!;
      out.push([gk, b.name, b.items]);
    }
    if (unassigned.length > 0) {
      out.push([UNASSIGNED_ROUND_KEY, 'Unassigned', unassigned]);
    }
    return out;
  }
  // Bucket key reserved for the Practice collapsible section. Not a
  // real tournament name; matched against the same collapsed-state
  // Map so the practice section remembers its open/closed state.
  const PRACTICE_BUCKET = '__practice__';

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
  /**
   * Compact stats for a practice-mode live card. Returns:
   *   - playedBoards: number of boards with any recorded miss so far
   *   - totalBoards: capacity across all configured sets
   *   - totalMisses: sum of misses across every recorded board
   *
   * Uses `practiceBoards` when present (bestOf × maxBoards matrix of
   * miss counts). Falls back to (board+1, meta.bestOf * meta.maxBoards,
   * sideA.points) when the matrix is missing from an older payload.
   */
  function practiceSummary(s: import('../lib/live-sync').LivePayload):
    { playedBoards: number; totalBoards: number; totalMisses: number } {
    const matrix = s.practiceBoards;
    if (Array.isArray(matrix) && matrix.length > 0 && Array.isArray(matrix[0])) {
      let played = 0;
      let misses = 0;
      for (const row of matrix) {
        for (const v of row) {
          if (typeof v === 'number' && v > 0) {
            played += 1;
            misses += v;
          }
        }
      }
      const total = matrix.length * matrix[0].length;
      return { playedBoards: played, totalBoards: total, totalMisses: misses };
    }
    return {
      playedBoards: s.board + 1,
      totalBoards: 0,
      totalMisses: s.sideA?.points ?? 0,
    };
  }

  // Convert a MatchRecord into a LiveRecord shape so LiveScoreboardView
  // can render it. Match records don't include the live-play fields
  // (currentBreak, queenHolder) — those weren't persisted in v2.0 v1.
  // We fill them with `null` so the pill BREAK/queen chips just don't
  // render for archived matches. The final points/sets/board are all
  // preserved from the match's result field.
  function matchAsLiveRecord(m: MatchRecord): import('../lib/live-sync').LiveRecord {
    // Prefer boardLog-derived setsA/setsB/winner over stored values.
    // Historical records occasionally have divergent stored fields
    // when a stray SET+ tap during play committed a phantom set the
    // umpire never corrected (see reconcileResultFromBoardLog in
    // lib/history for the reasoning). boardLog is untouched by such
    // mistakes and stays the authoritative source of truth. When
    // boardLog is missing (legacy records), the helper falls back to
    // the stored fields — no behaviour change for those.
    const rec = reconcileResultFromBoardLog(m);
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
        sideA: { points: rec.finalPointsA, sets: rec.setsA },
        sideB: { points: rec.finalPointsB, sets: rec.setsB },
        board: rec.boardCount,
        currentBreak: null,
        queenHolder: null,
        matchResult: rec.winner,
        ...(m.boardLog && m.boardLog.length > 0 ? { boardLog: m.boardLog } : {}),
        ...(m.setWinners && m.setWinners.length > 0
          ? { setWinners: m.setWinners }
          : {}),
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
  // Resolve the current live entry from the live-subscription array
  // by mid, on every render — this is what makes the open sheet
  // dialog update live as subscribeAllLive pushes new snapshots.
  // Returns null if the record has since disappeared from /live/
  // (umpire closed the tab, onDisconnect fired, admin swept it).
  const openLiveEntry = $derived(
    openPopup?.source === 'live'
      ? entries.find((e) => e.mid === openPopup.mid) ?? null
      : null,
  );

  const popupRecord = $derived(
    openPopup === null
      ? null
      : openPopup.source === 'live'
        ? openLiveEntry
        : openMatchRecord
          ? matchAsLiveRecord(openMatchRecord)
          : null,
  );
  const popupIsEnded = $derived(
    openPopup === null
      ? false
      : openPopup.source === 'match' ||
        !!(openPopup.source === 'live' && openLiveEntry?.liveState.matchResult),
  );
  const popupMode = $derived(
    openPopup === null
      ? ''
      : openPopup.source === 'live'
        ? (openLiveEntry ? modeLabelLive(openLiveEntry) : '')
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
        ? (openLiveEntry?.meta.tournament ?? '').trim()
        : (openMatchRecord?.tournament ?? '').trim(),
  );
  /**
   * Round tag for the popup header. Both sources carry a round tag
   * now — /matches/{id} always did; /live/{mid}/meta gained round
   * + roundKey in v3.3.5. Empty when the match wasn't tagged with
   * a round.
   */
  const popupRound = $derived(
    openPopup === null
      ? ''
      : openPopup.source === 'live'
        ? (openLiveEntry?.meta.round ?? '').trim()
        : (openMatchRecord?.round ?? '').trim(),
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
    lobby. Renders the v3.4.2 broadcast strip (OverlayBoard) driven
    by the Firebase /live/{mid} subscription rather than the older
    LiveScoreboardView boxed-tile layout.
  -->
  {#if overlayEntry}
    <div class="overlay-wrap">
      <OverlayBoard record={overlayEntry} />
    </div>
  {/if}
{:else}
<main>
  <header class="hdr">
    <a class="back" href={base}>← Back</a>
    <h1>Lobby</h1>
    <!--
      Header used to carry a signed-in avatar chip and a version pill.
      Both moved into the footer (2026-08-11) so the lobby's chrome
      matches the home screen. Auth entry now lives at the bottom
      alongside How-to-use / Feedback, exactly like /.
    -->
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
    <button
      type="button"
      role="tab"
      class="tab"
      class:tab-active={tab === 'reports'}
      aria-selected={tab === 'reports'}
      onclick={() => (tab = 'reports')}
    >
      Reports
    </button>
  </div>

  {#if tab === 'live'}
    {#if liveLoading}
      <p class="state">Loading…</p>
    {:else if !online && live.length === 0}
      <div class="empty">
        <p><strong>You're offline.</strong></p>
        <p class="empty-sub">The lobby needs an internet connection to show what others are playing. Your own matches on this device still work — start a match and it'll sync when you're back online.</p>
      </div>
    {:else if live.length === 0}
      <div class="empty">
        <p><strong>No live matches right now.</strong></p>
        <p class="empty-sub">Every match started in Carromscore appears here automatically while it's being played. Come back when someone's on the board.</p>
      </div>
    {:else}
      {#each liveGroups as [bucket, entriesInBucket] (bucket)}
        {@const folded = isCollapsed('live', bucket)}
        {@const tKey = bucket === DEFAULT_BUCKET ? '' : normalizeKey(bucket)}
        {@const roundGroups = groupLiveByRound(tKey, entriesInBucket)}
        {@const hasRounds = roundGroups.length > 1 || (roundGroups[0] && roundGroups[0][0] !== '')}
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
          {#each roundGroups as [roundKey, roundName, roundEntries] (roundKey || 'flat')}
            {@const showRoundHeader = hasRounds && roundKey !== ''}
            {@const roundFolded = showRoundHeader && isCollapsed('live', `${bucket}::${roundKey}`)}
            <section
              class="round-group"
              class:round-unassigned={roundKey === UNASSIGNED_ROUND_KEY}
              class:round-flat={!showRoundHeader}
              class:folded={roundFolded}
            >
              {#if showRoundHeader}
              <button
                type="button"
                class="round-hdr"
                aria-expanded={!roundFolded}
                onclick={() => toggleGroup('live', `${bucket}::${roundKey}`)}
              >
                <span class="round-caret" class:round-caret-folded={roundFolded} aria-hidden="true">▾</span>
                <span class="round-name">{roundName}</span>
                <span class="round-count">{roundEntries.length}</span>
              </button>
              {/if}
              {#if !roundFolded}
              <ul class="grid">
                {#each roundEntries as e (e.mid)}
                  {@const s = e.liveState}
              <li class="card-li">
                <button
                  type="button"
                  class="card-copy"
                  aria-label="Copy share URL for this match"
                  title="Copy share URL"
                  onclick={(ev) => copyLiveMidUrl(e.mid, ev)}
                >
                  {#if copiedCardKey === `live:${e.mid}`}
                    <span aria-hidden="true">✓</span>
                  {:else}
                    <span aria-hidden="true">🔗</span>
                  {/if}
                </button>
                <button type="button" class="card card-live" class:card-offline={localOfflineMids.has(e.mid)} onclick={() => openEntry(e)}>
                  <div class="card-hdr">
                    {#if localOfflineMids.has(e.mid)}
                      <!-- Offline-only entry synthesised from the
                           sync queue. No Firebase record yet; this
                           card is visible only on the umpire's own
                           device (same-origin storage events). -->
                      <span class="card-badge card-badge-offline">
                        <span class="dot" aria-hidden="true"></span>
                        OFFLINE
                      </span>
                    {:else}
                      <span class="card-badge">
                        <span class="dot" aria-hidden="true"></span>
                        LIVE
                      </span>
                    {/if}
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
                    Practice card summary: boards actually played + total
                    misses so far. `practiceBoards` is a bestOf × maxBoards
                    matrix of missed-shot counts; a "played" board is one
                    with any positive value, and misses sum across the
                    whole matrix. sideA.points also carries the running
                    misses count but only reflects the current board, so
                    the matrix sum is the honest all-set total. Falls
                    back gracefully if the payload is old/missing the
                    matrix.
                  -->
                  {@const summary = practiceSummary(s)}
                  <span class="score-block">
                    <span class="score-lbl">BOARDS</span>
                    <span class="score-val">{summary.playedBoards}<span class="score-of">/{summary.totalBoards}</span></span>
                  </span>
                  <span class="score-block">
                    <span class="score-lbl">MISSES</span>
                    <span class="score-val">{summary.totalMisses}</span>
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
        </section>
      {/each}
    {/if}
  {:else if tab === 'history'}
    <!-- History tab -->
    {#if !online && matches.length === 0}
      <div class="empty">
        <p><strong>You're offline.</strong></p>
        <p class="empty-sub">Your match history lives on Firebase — connect to see past matches. Any match you record on this device meanwhile will sync automatically when you're back online.</p>
      </div>
    {:else if historyLoading}
      <p class="state">Loading…</p>
    {:else if matches.length === 0}
      <div class="empty">
        <p><strong>No matches yet.</strong></p>
        <p class="empty-sub">Every match you complete lands here so you can look back at scores, opponents, and who won.</p>
      </div>
    {:else}
      <!--
        History toolbar (v3.4.12): filters + view toggle. Filters
        apply to both the table and cards view. Sort is table-only
        — cards keep their tournament-grouped-then-endedAt-DESC order.
      -->
      <div class="hist-toolbar">
        <div class="hist-filters">
          <input
            type="search"
            class="hist-search"
            placeholder="Search player name…"
            bind:value={filterSearch}
            aria-label="Search matches by player name"
          />
          <select
            class="hist-select"
            bind:value={filterMode}
            aria-label="Filter by mode"
          >
            <option value="all">All modes</option>
            <option value="singles">Singles</option>
            <option value="doubles">Doubles</option>
            <option value="practice">Practice</option>
          </select>
          <select
            class="hist-select"
            bind:value={filterTournament}
            aria-label="Filter by tournament"
          >
            <option value="">All tournaments</option>
            {#each tournamentBuckets as bucket (bucket)}
              <option value={bucket}>{bucket}</option>
            {/each}
          </select>
          <div class="hist-chips" role="group" aria-label="Filter by date range">
            {#each [ { d: 0, label: 'All' }, { d: 7, label: '7d' }, { d: 30, label: '30d' }, { d: 90, label: '90d' } ] as opt (opt.d)}
              <button
                type="button"
                class="hist-chip"
                class:hist-chip-active={filterDays === opt.d}
                onclick={() => (filterDays = opt.d)}
              >{opt.label}</button>
            {/each}
          </div>
          {#if anyFilterActive}
            <button
              type="button"
              class="hist-clear"
              onclick={clearFilters}
              aria-label="Clear all filters"
            >✕ Clear</button>
          {/if}
        </div>
      </div>

      {#if sortedHistoryTable.length === 0}
          <div class="empty">
            <p><strong>No matches match these filters.</strong></p>
            <p class="empty-sub">Try clearing the search or widening the date range.</p>
          </div>
        {:else}
          <div class="hist-tbl-scroll">
            <table class="hist-tbl">
              <thead>
                <tr>
                  <th
                    class="hist-th hist-th-sortable"
                    class:hist-th-sorted={historySortKey === 'endedAt'}
                    onclick={() => toggleSort('endedAt')}
                  >
                    Ended
                    {#if historySortKey === 'endedAt'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable"
                    class:hist-th-sorted={historySortKey === 'mode'}
                    onclick={() => toggleSort('mode')}
                  >
                    Mode
                    {#if historySortKey === 'mode'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable hist-th-name"
                    class:hist-th-sorted={historySortKey === 'sideA'}
                    onclick={() => toggleSort('sideA')}
                  >
                    Side A
                    {#if historySortKey === 'sideA'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable hist-th-name"
                    class:hist-th-sorted={historySortKey === 'sideB'}
                    onclick={() => toggleSort('sideB')}
                  >
                    Side B
                    {#if historySortKey === 'sideB'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable"
                    class:hist-th-sorted={historySortKey === 'sets'}
                    onclick={() => toggleSort('sets')}
                  >
                    Sets
                    {#if historySortKey === 'sets'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable"
                    class:hist-th-sorted={historySortKey === 'points'}
                    onclick={() => toggleSort('points')}
                  >
                    Points
                    {#if historySortKey === 'points'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                  <th
                    class="hist-th hist-th-sortable"
                    class:hist-th-sorted={historySortKey === 'boards'}
                    onclick={() => toggleSort('boards')}
                  >
                    Boards
                    {#if historySortKey === 'boards'}<span class="sort-caret">{historySortDir === 'asc' ? '▲' : '▼'}</span>{/if}
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each sortedHistoryTable as m (m.id)}
                  {@const rec = reconcileResultFromBoardLog(m)}
                  {@const winner = rec.winner}
                  <tr
                    class="hist-tr"
                    class:winner-a={winner === 'a'}
                    class:winner-b={winner === 'b'}
                    onclick={() => openMatch(m)}
                  >
                    <td class="hist-td hist-td-when">{relTime(m.endedAt)}</td>
                    <td class="hist-td hist-td-mode">
                      <span class="hist-mode-chip">{modeLabelMatch(m)}</span>
                      {#if m.tournament}
                        <span class="hist-tour-chip">{m.tournament}</span>
                      {/if}
                    </td>
                    <td class="hist-td hist-td-name" class:hist-td-winner={winner === 'a'}>
                      {#if winner === 'a'}<span class="hist-crown">🏆</span>{/if}
                      {sideNameMatch(m, 'a')}
                    </td>
                    <td class="hist-td hist-td-name" class:hist-td-winner={winner === 'b'}>
                      {#if winner === 'b'}<span class="hist-crown">🏆</span>{/if}
                      {sideNameMatch(m, 'b')}
                    </td>
                    <td class="hist-td hist-td-score">
                      <span class="digit-a">{rec.setsA}</span>–<span class="digit-b">{rec.setsB}</span>
                    </td>
                    <td class="hist-td hist-td-score">
                      {#if m.mode === 'practice'}
                        —
                      {:else}
                        <span class="digit-a">{rec.finalPointsA}</span>–<span class="digit-b">{rec.finalPointsB}</span>
                      {/if}
                    </td>
                    <td class="hist-td hist-td-num">{rec.boardCount}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
    {/if}
  {:else if tab === 'reports'}
    <!--
      Reports tab. Waits for the same /matches load the History tab
      relies on (see the $effect at line ~338 that fires loadHistory
      on switching to either 'history' or 'reports'). Emits selection
      changes back so LiveLobby can mirror them into the URL query
      string via syncUrl().
    -->
    {#if !online && matches.length === 0}
      <div class="empty">
        <p><strong>You're offline.</strong></p>
        <p class="empty-sub">Reports aggregate match records from Firebase — connect to see totals, per-player stats, and per-tournament trends.</p>
      </div>
    {:else if historyLoading}
      <p class="state">Loading…</p>
    {:else}
      <ReportsTab
        matches={matches}
        initialTournament={reportsSelection}
        onSelectionChange={(t) => (reportsSelection = t)}
      />
    {/if}
  {/if}

  <!--
    Lobby footer. Mirrors the home-screen footer for visual continuity
    across the app. Row 1: actionable links (Help, Donate,
    Admin/sign-in). Row 2: version + copyright, low contrast.
    Everything on this row is the same component the home footer uses,
    so a change in one place propagates to both.
    v3.4.8: "How to use" + "Feedback" merged into one Help entry.
  -->
  <div class="foot-block">
    <div class="foot-links">
      <a
        href={`${base}help/`}
        class="foot-link"
        aria-label="Help — how to use Carromscore + send feedback"
      >Help ⇗</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <a
        href="https://ko-fi.com/carromscore"
        target="_blank"
        rel="noopener noreferrer"
        class="foot-link foot-link-support"
        aria-label="Donate to Carromscore on Ko-fi"
      >Donate ❤</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <SignInButton dropUp />
    </div>
    <p class="foot-meta">
      <a
        class="foot-ver"
        href={releaseUrl()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Carromscore v${APP_VERSION} release notes on GitHub`}
      >v{APP_VERSION}</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      © 2026 Swapnil Deshpande
    </p>
  </div>
</main>

<dialog bind:this={dialog} class="sheet" onclick={onDialogClick} onclose={closePopup}>
  {#if popupRecord}
    <div class="sheet-inner" role="document">
      <header class="sheet-hdr">
        <!--
          Header title stacks on two rows when there's a tournament
          or round tag: top row = LIVE/Ended + mode (always short);
          bottom row = tournament + round tags. Prevents the long
          single-line title from pushing the Share/OBS action
          buttons off the right edge on phones (reported 2026-08-20:
          OBS button hidden behind viewport clip when the popup
          opened for a live match under a tournament with rounds).
        -->
        <div class="sheet-title-wrap">
          <span class="sheet-title">
            {#if popupIsEnded}Ended · {:else}<span class="sheet-live"><span class="dot" aria-hidden="true"></span>LIVE · </span>{/if}{popupMode}
          </span>
          {#if popupTournament || popupRound}
            <span class="sheet-subtitle">
              {#if popupTournament}<span class="sheet-tour">{popupTournament}</span>{/if}{#if popupTournament && popupRound} · {/if}{#if popupRound}<span class="sheet-round">{popupRound}</span>{/if}
            </span>
          {/if}
        </div>
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
          {:else if openPopup?.source === 'match'}
            <!--
              History-match popup Share button (v3.4.12). Copies a
              deep-link URL that opens the same popup for anyone who
              clicks it. Reported 2026-08-30: after History switched
              to table layout the per-card 🔗 button disappeared, so
              there was no way to share a specific archived match.
              This puts a Share affordance back in the popup header.
            -->
            <button
              type="button"
              class="sheet-share"
              onclick={copyMatchShareUrl}
              aria-label="Copy match URL"
              title="Copy the match URL to share"
            >
              {#if copiedKind === 'share'}<span aria-hidden="true">✓</span> Copied{:else}<span aria-hidden="true">⧉</span> Share{/if}
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
    /*
     * v3.4.6: no padding. The overlay wrap previously reserved
     * ~12rem on the right for a stream-app watermark safe-zone
     * (Prism / OBS / Twitch record indicators), but the umpire now
     * positions their branding independently in the streaming app
     * itself — the reserved buffer was just eating usable overlay
     * width in every mode. Let the overlay use the full container.
     */
    padding: 0;
  }
  /*
   * Overlay-wrap :global overrides were LiveScoreboardView-era
   * tuning. Since v3.4.3 the /live/?view=overlay route renders
   * OverlayBoard instead, which owns its own sizing. Leaving the
   * old rules in place clobbered singles/doubles digits with
   * `font-size: clamp(1.4rem, 4vw, 2.4rem) !important` because
   * OverlayBoard also uses the `.digit` class. All overrides
   * removed in v3.4.5.
   */
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
    /* Anchor override: no default underline; hover-brighten to hint
       tappability. Opens the release notes for the running version. */
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  }
  .ver:hover {
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.5);
  }

  /* Segmented control */
  .tabs {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
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
  /*
   * `.empty .empty-sub` (nested selector) instead of the plain
   * `.empty-sub` because `.empty p { margin: 0.5rem 0 }` above
   * has specificity 0,2,1 (two classes + one element) whereas
   * `.empty-sub` alone is 0,2,0. The `p` shorthand includes
   * `margin-left: 0; margin-right: 0` which would override
   * `.empty-sub`'s `margin-left: auto`, breaking the horizontal
   * centering — the block would collapse against the left edge
   * of the .empty container instead of centering under the
   * "You're offline." header. Nesting bumps specificity to
   * 0,3,0 so this rule wins cleanly.
   */
  .empty .empty-sub {
    max-width: 22rem;
    margin-left: auto;
    margin-right: auto;
    text-align: center;
  }

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

  /* ─── Round sub-groups inside a tournament (v3.2) ─────────────────
     A round is rendered as its own bordered card, indented inside
     the tournament wrapper so the tournament > round nesting reads
     visually. The card + header combo mirrors the Reports tab's
     per-round card so both surfaces share one visual language. The
     `.round-flat` variant (tournament with no rounds configured)
     drops the wrapper entirely — pre-v3.2 flat render preserved. */
  .round-group {
    display: block;
  }
  .round-group.folded .grid {
    display: none;
  }
  .round-group.round-flat > .grid {
    /* No visual box around the flat case — the tour-group wrapper
       already provides the outer chrome. */
    padding: 0 0.6rem 0.75rem;
  }
  /* Bordered card, only in the has-rounds variant. Left-indented so
     the nesting under the tournament header reads at a glance. */
  .round-group:not(.round-flat) {
    margin: 0.5rem 0.6rem;
    background: rgba(255, 213, 74, 0.04);
    border: 1px solid rgba(255, 213, 74, 0.18);
    border-radius: 0.5rem;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
  }
  .round-hdr {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.55rem 0.85rem;
    background: transparent;
    color: var(--fg, #f5f5f5);
    border: 0;
    font: inherit;
    font-size: 0.92rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    cursor: pointer;
    text-align: left;
    transition: background 0.12s;
  }
  .round-hdr:hover { background: rgba(255,213,74,0.08); }
  .round-hdr:focus-visible {
    outline: 2px solid var(--accent, #ffd54a);
    outline-offset: -2px;
  }
  /* Round caret: filled ▾ that rotates -90° when the round is
     folded. Sized to match the tournament caret's chrome so it
     reads unambiguously as a button — hierarchy is carried by the
     row height + card treatment, not by shrinking the caret to
     invisibility. */
  .round-caret {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 0.4rem;
    background: rgba(255,213,74,0.14);
    color: var(--accent, #ffd54a);
    font-size: 1rem;
    line-height: 1;
    flex: 0 0 auto;
    transition: transform 0.18s ease, background 0.12s;
  }
  .round-caret-folded {
    transform: rotate(-90deg);
  }
  .round-hdr:hover .round-caret {
    background: rgba(255,213,74,0.24);
  }
  .round-name { flex: 1 1 auto; }
  .round-count {
    font-size: 0.72rem;
    font-weight: 500;
    color: rgba(255,255,255,0.65);
    background: rgba(255,255,255,0.08);
    padding: 0.1rem 0.5rem;
    border-radius: 999px;
    flex: 0 0 auto;
  }
  /* Unassigned bucket rendered at the tail of a rounds-having
     tournament. Slightly muted vs a real round card to visually
     deprioritise "these matches lack the structured tag". */
  .round-group.round-unassigned {
    background: rgba(255, 255, 255, 0.02);
    border-color: rgba(255, 255, 255, 0.10);
  }
  .round-group.round-unassigned .round-name {
    color: rgba(255,255,255,0.65);
    font-style: italic;
    font-weight: 500;
  }
  .round-group.round-unassigned .round-caret {
    background: rgba(255,255,255,0.08);
    color: rgba(255,255,255,0.55);
  }
  .round-group:not(.round-flat) > .grid {
    padding: 0 0.6rem 0.5rem;
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
  /* Copy-share-URL button sits absolutely-positioned in the card's
     top-right corner. Sibling of the main card button (nested
     buttons are invalid HTML) with a higher z-index so its tap
     wins over the surrounding card. Reuses `.card-li { position:
     relative }` for the anchor. */
  .card-copy {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    z-index: 3;
    width: 1.9rem;
    height: 1.9rem;
    padding: 0;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.14);
    color: var(--muted, #9aa0a6);
    border-radius: 0.5rem;
    font-size: 0.95rem;
    line-height: 1;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    -webkit-tap-highlight-color: transparent;
    transition: background 0.12s, border-color 0.12s, color 0.12s, transform 0.08s;
  }
  .card-copy:hover {
    background: rgba(255, 213, 74, 0.14);
    border-color: rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
  }
  .card-copy:active {
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
    /* Reserve space at the right for the absolutely-positioned
       `.card-copy` button so the relative-time meta doesn't collide
       with it. Width matches .card-copy (1.9rem) + a small breathing
       gap. */
    padding-right: 2.35rem;
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
  /* Locally-synthesised offline entry (from the sync queue). Amber
     to hint "queued, not yet shared with anyone." No pulse — the
     match hasn't reached Firebase and there's no external activity
     to reflect. Card itself gets a matching amber border tone so
     the whole card reads as "your device only" at a glance. */
  .card-badge-offline {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.1);
    border-color: rgba(255, 213, 74, 0.45);
  }
  .card-badge-offline .dot {
    background: var(--accent, #ffd54a);
    animation: none;
  }
  .card-offline { border-color: rgba(255, 213, 74, 0.35); }
  .card-offline:hover { border-color: rgba(255, 213, 74, 0.6); }
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
  .score-of {
    color: var(--muted, #9aa0a6);
    font-weight: 500;
    font-size: 0.75rem;
    margin-left: 0.1rem;
  }
  .digit-a { color: var(--side-a, #4fc3f7); }
  .digit-b { color: var(--side-b, #ff8a65); }

  /* Polished ended-match card layout (v3.4.12) — takes over from
     .card-teams / .card-scores for ended-versus cards. Live cards
     and practice cards retain the older layout. */
  .card-teams-c {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.65rem;
    flex: 1 1 auto;
  }
  .team-pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    padding: 0.4rem 0.65rem;
    border-radius: 0.55rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    min-width: 0;
    max-width: 100%;
    text-align: center;
    transition: border-color 0.15s, background 0.15s;
  }
  .team-name-c {
    font-weight: 700;
    font-size: 0.95rem;
    line-height: 1.2;
    word-break: break-word;
    min-width: 0;
  }
  .team-pill-a .team-name-c { color: var(--side-a, #4fc3f7); }
  .team-pill-b .team-name-c { color: var(--side-b, #ff8a65); }
  /* Winner pill: soft gold outline + glow, gold text. Loser pill
     stays neutral. Fully-tied matches keep both sides' side colours. */
  .card-ended.has-winner .team-pill.winner {
    background: rgba(255, 213, 74, 0.06);
    border-color: rgba(255, 213, 74, 0.5);
    box-shadow: 0 0 0 1px rgba(255, 213, 74, 0.12), 0 0 12px rgba(255, 213, 74, 0.06);
  }
  .card-ended.has-winner .team-pill.winner .team-name-c {
    color: var(--accent, #ffd54a);
  }
  .card-ended.has-winner .team-pill:not(.winner) .team-name-c {
    color: var(--fg, #f5f5f5);
  }
  .vs-chip {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--muted, #9aa0a6);
    padding: 0.15rem 0.4rem;
    border-radius: 0.3rem;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }
  /* Big centred SETS score. This IS the outcome — everything else is
     supporting. Uses tabular-nums so 1-1 and 2-0 align vertically
     across the grid. */
  .card-sets-c {
    display: flex;
    align-items: baseline;
    justify-content: center;
    gap: 0.35rem;
    padding: 0.15rem 0 0.35rem;
    font-variant-numeric: tabular-nums;
  }
  .sets-digit {
    font-size: 1.65rem;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.02em;
  }
  .sets-sep {
    color: var(--muted, #9aa0a6);
    font-size: 1.35rem;
    font-weight: 700;
    line-height: 1;
  }
  .card-ended.winner-a .sets-digit.sets-w,
  .card-ended.winner-b .sets-digit.sets-w {
    color: var(--accent, #ffd54a);
    text-shadow: 0 0 12px rgba(255, 213, 74, 0.25);
  }
  .card-ended.winner-a .sets-digit:not(.sets-w),
  .card-ended.winner-b .sets-digit:not(.sets-w) {
    color: var(--fg, #f5f5f5);
    opacity: 0.7;
  }
  /* Secondary line: "Points 21–13 · 8 boards". Muted; sits below
     the big SETS score and gives the additional context without
     competing for attention. */
  .card-secondary-c {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0.35rem 0.55rem;
    padding-top: 0.4rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
  }
  .sec-item {
    display: inline-flex;
    align-items: baseline;
    gap: 0.3rem;
  }
  .sec-lbl {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--muted, #9aa0a6);
    font-weight: 700;
  }
  .sec-val {
    font-weight: 700;
    color: var(--fg, #f5f5f5);
    font-variant-numeric: tabular-nums;
  }
  .sec-dot {
    color: rgba(255, 255, 255, 0.2);
  }

  /* ─── History toolbar + table view (v3.4.12) ──────────────────── */
  .hist-toolbar {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    flex-wrap: wrap;
    justify-content: space-between;
    margin: 0 0 1rem;
    padding: 0.6rem 0.75rem;
    /* Gold-tint highlight (v3.4.12) to distinguish the filter bar
       as the primary scoping control for the tab. Same treatment
       lives on the Reports .reports-filters. */
    background: rgba(255, 213, 74, 0.05);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.7rem;
    box-shadow: 0 0 0 1px rgba(255, 213, 74, 0.06),
                0 0 18px rgba(255, 213, 74, 0.08);
  }
  .hist-filters {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    flex: 1 1 auto;
    min-width: 0;
  }
  .hist-search {
    flex: 1 1 12rem;
    min-width: 8rem;
    padding: 0.4rem 0.6rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
  }
  .hist-search:focus {
    outline: none;
    border-color: rgba(255, 213, 74, 0.5);
  }
  .hist-select {
    padding: 0.4rem 0.6rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.45rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.85rem;
    cursor: pointer;
  }
  .hist-chips {
    display: inline-flex;
    gap: 0.25rem;
    padding: 0.15rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.5rem;
  }
  .hist-chip {
    padding: 0.25rem 0.55rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 0.35rem;
    color: var(--muted, #9aa0a6);
    font-size: 0.8rem;
    font-weight: 700;
    cursor: pointer;
  }
  .hist-chip:hover { color: var(--fg, #f5f5f5); }
  .hist-chip-active {
    background: rgba(255, 213, 74, 0.12);
    border-color: rgba(255, 213, 74, 0.45);
    color: var(--accent, #ffd54a);
  }
  .hist-clear {
    padding: 0.35rem 0.65rem;
    background: transparent;
    border: 1px solid rgba(239, 83, 80, 0.4);
    border-radius: 0.45rem;
    color: #ef5350;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
  }
  .hist-clear:hover { background: rgba(239, 83, 80, 0.08); }
  /* .hist-view-toggle / .hist-view-btn removed with the card view
     (v3.4.12) — history is table-only. */

  /* Table view. Horizontally scrollable on narrow phones so the
     row fits without wrapping cells. Header row is sticky when the
     lobby's own scroll container scrolls. Winner side coloured
     amber; non-winner stays neutral. */
  .hist-tbl-scroll {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.6rem;
    background: #101010;
  }
  .hist-tbl {
    width: 100%;
    border-collapse: collapse;
    min-width: 620px;
    font-size: 0.85rem;
  }
  .hist-tbl th,
  .hist-tbl td {
    padding: 0.55rem 0.65rem;
    text-align: left;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
    white-space: nowrap;
  }
  .hist-tbl tr:last-child td { border-bottom: 0; }
  .hist-th {
    background: rgba(255, 255, 255, 0.03);
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    position: sticky;
    top: 0;
    z-index: 1;
  }
  .hist-th-sortable {
    cursor: pointer;
    user-select: none;
  }
  .hist-th-sortable:hover { color: var(--fg, #f5f5f5); }
  .hist-th-sorted { color: var(--accent, #ffd54a); }
  .sort-caret {
    margin-left: 0.2rem;
    font-size: 0.62rem;
  }
  .hist-th-name { min-width: 8rem; }
  .hist-tr {
    cursor: pointer;
    transition: background 0.12s;
  }
  .hist-tr:hover { background: rgba(255, 255, 255, 0.03); }
  .hist-td-when {
    color: var(--muted, #9aa0a6);
    font-size: 0.78rem;
  }
  .hist-td-mode {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .hist-mode-chip {
    font-size: 0.62rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 0.12rem 0.4rem;
    border-radius: 0.3rem;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: var(--muted, #9aa0a6);
  }
  .hist-tour-chip {
    font-size: 0.68rem;
    color: var(--accent, #ffd54a);
    font-weight: 700;
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hist-td-name {
    font-weight: 700;
    color: var(--fg, #f5f5f5);
    max-width: 12rem;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hist-td-winner {
    color: var(--accent, #ffd54a);
  }
  .hist-crown {
    font-size: 0.85rem;
    margin-right: 0.2rem;
  }
  .hist-td-score {
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    text-align: center;
  }
  .hist-td-num {
    text-align: center;
    color: var(--muted, #9aa0a6);
    font-variant-numeric: tabular-nums;
  }

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
    /* Higher opacity than the earlier 0.65 (reported 2026-08-29:
       history-card numbers behind the popup were still legible on
       mobile Chrome, mixing visually with the popup content as the
       user scrolled). Combined with a stronger blur, the lobby is
       now clearly a secondary surface. */
    background: rgba(0, 0, 0, 0.88);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .sheet-inner {
    background: #0f0f0f;
    border: 1px solid rgba(255, 213, 74, 0.55);
    border-radius: 1rem;
    padding: 0.85rem 1rem 1.1rem;
    max-height: min(90dvh, 44rem);
    overflow-y: auto;
    /* Explicit overflow-x: hidden so the box-shadow horizontal-
       spread applied to sticky bands (`.hdr`, `.board`) is clipped
       by sheet-inner's border-radius. Without this, the shadow bg
       leaked past the rounded gold border on scroll (reported
       2026-08-30) because overflow-y: auto only clips the Y axis. */
    overflow-x: hidden;
    /* sheet-inner is the scroll container. Names pill and top-row
       summary inside LiveScoreboardView are made position: sticky so
       they pin to the top while per-set tables scroll under them.
       sheet-hdr uses sticky too so the "Ended · Singles" line + close
       button stay pinned. */
    position: relative;
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
    padding: 0.5rem 0 0.75rem;
    margin: 0 -1rem 0.5rem;
    padding-left: 1rem;
    padding-right: 1rem;
    border-bottom: 1px solid #1e1e1e;
    background: #0f0f0f;
    position: sticky;
    top: -0.85rem; /* offset the sheet-inner top padding so the header sits flush */
    z-index: 3;
  }
  /*
   * Sticky-band bridge (v3.4.12). The header, names pill, and
   * score summary each pin at slightly different rem offsets while
   * scrolling. Any mismatch between one band's rendered bottom edge
   * and the next band's sticky `top` produces a thin horizontal gap
   * where the per-set table's numbers slide through visibly
   * (reported 2026-08-30). Two fixes stacked:
   *   1) Names pill and summary pin ABUTTING the previous band with
   *      a small negative-overlap so no gap can appear on any device.
   *   2) The sheet-inner itself gets a ::before pseudo-element that
   *      layers behind the sticky bands, painting a solid strip
   *      between sheet-hdr and .board so even a browser-side
   *      subpixel rounding can't leak the content behind.
   * Names pill (.hdr) and top-row summary (.board) inside
   * LiveScoreboardView pinned so long per-set tables scroll behind.
   */
  /*
   * Sticky policy in the recap popup (v3.4.12 rewrite).
   *
   * Prior versions tried to keep BOTH the names pill (.hdr) and the
   * DSEG7 score panel (.board) sticky at two different top offsets.
   * That approach broke on long names — .hdr's rendered height
   * exceeded the gap between the two top values (2.5rem), so on
   * scroll the two bands visually overlapped inside the popup
   * (reported 2026-08-30).
   *
   * New policy: only the sheet-hdr ("Ended · Singles / ✕" row)
   * stays sticky. The names pill and score panel scroll away as one
   * unit with the per-set tables below them. If the umpire wants to
   * see names + score again, they scroll back up. This eliminates
   * the overlap class of bug entirely by removing sticky pinning
   * on .hdr / .board, and matches how spectator popups on most
   * sports apps behave.
   */
  .sheet-inner :global(.hdr),
  .sheet-inner :global(.board) {
    position: static;
    background: #0f0f0f;
  }
  /* Two-row title container. First row = LIVE/Ended + mode.
     Second row = tournament + round tags when present. min-width:0
     lets the title area shrink instead of pushing the actions
     off-screen when the tournament name is long. */
  .sheet-title-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
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
  /* Second-row tags (tournament + round). Wraps within its own row,
     never crowds the actions strip. Softer weight so mode stays the
     primary read. */
  .sheet-subtitle {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    line-height: 1.25;
    display: block;
    overflow-wrap: anywhere;
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
  /* Round tag renders after the tournament, softer weight so the
     tournament stays primary. Reported 2026-08-19: the popup header
     showed only the tournament; the round tag was missing. */
  .sheet-round {
    color: rgba(255, 213, 74, 0.75);
    letter-spacing: 0.02em;
    text-transform: none;
    font-weight: 500;
  }
  .sheet-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    /* Never shrink — the Share / OBS / Close buttons must stay
       reachable no matter how long the tournament / round tags are. */
    flex-shrink: 0;
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

  /* Footer — copied verbatim from MatchSetup so the home screen and
     the lobby share the same look. Duplicated (not shared) because
     Svelte scopes styles per component. Change any of these? Change
     both files. */
  .foot-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    margin: 1.5rem 0 0.75rem;
  }
  .foot-links {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.35rem;
    margin: 0;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .foot-meta {
    text-align: center;
    color: var(--muted);
    font-size: 0.72rem;
    margin: 0;
    letter-spacing: 0.02em;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.3rem;
    flex-wrap: wrap;
  }
  .foot-sep { opacity: 0.4; }
  .foot-ver {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 999px;
    color: var(--accent);
    font-family: inherit;
    font-weight: 700;
    font-size: 0.7rem;
    letter-spacing: 0.06em;
    line-height: 1;
    text-decoration: none;
    transition: background 0.15s, border-color 0.15s;
  }
  .foot-ver:hover {
    background: rgba(255, 213, 74, 0.22);
    border-color: rgba(255, 213, 74, 0.55);
  }
  .foot-link {
    color: var(--fg);
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 600;
    transition: color 0.15s, background 0.15s;
  }
  .foot-link:hover {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.08);
  }
  /* Support link — golden accent tint (matches the version pill,
     BREAK chip, primary buttons). Not red — red is the "danger"
     register in this app. Same block duplicated across the three
     footer surfaces (Svelte-scoped styles). */
  .foot-link-support {
    color: var(--accent, #ffd54a);
  }
  .foot-link-support:hover {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.14);
  }
</style>
