<script lang="ts">
  import {
    DEFAULT_CONFIG,
    encodeConfig,
    matchStateKey,
    type MatchConfig,
    type Mode,
    type PlayerRow,
  } from '../lib/match';
  import { loadKnownPlayers, rememberPlayers } from '../lib/known-players';
  import {
    subscribePlayers,
    subscribeStore,
    rankMatches,
    addAlias,
    loadAll as loadAllPlayers,
    type PlayerMatch,
  } from '../lib/players';
  import {
    saveMatchIdentity,
    saveMatchStart,
    clearMatchIdentity,
  } from '../lib/history';
  import { newMid, subscribeLive, deleteLive, type LiveRecord } from '../lib/live-sync';
  import { saveResume, loadResume, clearResume, type ResumeRecord } from '../lib/resume';
  import {
    rankTournaments,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
    loadAll as loadAllTournaments,
    loadAssignedPlayers,
    normalizeKey,
    loadRounds,
    rankRounds,
    type Round,
    type Tournament,
  } from '../lib/tournaments';
  import {
    APP_VERSION,
    fetchLatestRelease,
    isNewerVersion,
    releaseUrl as buildReleaseUrl,
    type ReleaseInfo,
  } from '../lib/version';
  import SignInButton from './SignInButton.svelte';
  // FeedbackPopup no longer imported here — v3.4.8 merged the home
  // footer's separate "Feedback" link into the "Help" entry, which
  // points at /help/ where the popup now lives.
  import HelpTip from './HelpTip.svelte';
  import { logScreen } from '../lib/analytics';
  import { countryName, flagEmoji } from '../lib/countries';
  import {
    loadPlannedMatch,
    loadAllPlannedByRound,
    claimPlannedMatch,
    resolvePlannedByBoard,
    type PlannedMatch,
  } from '../lib/planned';
  import { currentUser, awaitAuthReady } from '../lib/auth';

  const base: string = import.meta.env.BASE_URL;

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });

  /**
   * Planned-match deep-link state (v3.6). URL `?planned=<mid>` opens
   * the setup screen with a pre-created bracket slot's fields
   * loaded. States:
   *   - 'idle'      — no ?planned= param present; normal setup flow
   *   - 'loading'   — reading /planned/{mid} from RTDB
   *   - 'not-found' — mid didn't resolve; the slot was deleted (match
   *                   probably already scored, or organiser removed it)
   *   - 'takeover'  — slot exists but claimedBy is another uid; ask
   *                   the umpire to confirm takeover
   *   - 'loaded'    — slot fetched and cfg has been prefilled; the
   *                   normal setup renders below
   * See docs/plan/tournament-brackets.md for the flow.
   */
  type PlannedState =
    | { kind: 'idle' }
    | { kind: 'loading'; mid: string }
    | { kind: 'not-found'; mid: string; reason?: 'no-active-round' | 'all-complete' }
    | { kind: 'completed'; mid: string; match: PlannedMatch }
    | { kind: 'takeover'; mid: string; match: PlannedMatch; claimerName: string }
    | { kind: 'loaded'; mid: string };
  let plannedState = $state<PlannedState>({ kind: 'idle' });
  let plannedMid = $state<string>('');
  // Board-scan pending state: when the URL carries
  // `?tournament=<key>&board=<N>` (the stable per-board sticker), we
  // resolve to a concrete mid in an effect below, then hand off to
  // the same planned-mid flow. During the resolve we render the
  // 'loading' banner so the umpire sees feedback.
  let boardScan = $state<{ tournamentKey: string; board: number } | null>(null);
  // Read the query params synchronously so the effect below knows
  // whether to short-circuit the resume flow.
  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const mid = params.get('planned');
    if (mid && /^[A-Za-z0-9_-]{4,24}$/.test(mid)) {
      plannedMid = mid;
      plannedState = { kind: 'loading', mid };
    } else {
      // v3.6.1: per-board scan. Board 1's fixed QR encodes
      // `?tournament=<key>&board=1`. Resolve to a mid in the effect
      // below (async — the mid isn't known until we query /planned).
      const tKey = params.get('tournament') ?? '';
      const boardRaw = params.get('board') ?? '';
      const boardNum = Number(boardRaw);
      if (
        tKey &&
        Number.isFinite(boardNum) &&
        boardNum >= 1 &&
        boardNum <= 99
      ) {
        boardScan = { tournamentKey: tKey, board: Math.floor(boardNum) };
        // Render the loading banner while we resolve. The mid is
        // populated once resolvePlannedByBoard returns.
        plannedState = { kind: 'loading', mid: '' };
      }
    }
  }

  // Resolve a board scan to a concrete /planned mid, then defer to
  // the mid-based effect. Runs once on mount when boardScan is set.
  $effect(() => {
    if (!boardScan) return;
    const { tournamentKey: tKey, board } = boardScan;
    boardScan = null;
    (async () => {
      await awaitAuthReady();
      const outcome = await resolvePlannedByBoard(tKey, board);
      if (outcome.ok === false || !outcome.match) {
        const reason = outcome.ok === true ? outcome.reason : undefined;
        plannedState = { kind: 'not-found', mid: `board-${board}`, ...(reason ? { reason } : {}) };
        return;
      }
      const match = outcome.match;
      plannedMid = match.mid;
      // Hand off to the mid-based fetch pipeline. It will re-read
      // /planned/{mid}, apply cfg, and claim. The extra fetch is
      // cheap and keeps the takeover-detection code path unified.
      plannedState = { kind: 'loading', mid: match.mid };
    })();
  });
  $effect(() => {
    // Fetch the planned record once at mount and prefill cfg. Auth
    // must be ready before we call claimPlannedMatch (rule needs
    // auth.uid). awaitAuthReady bounds the wait so a broken auth
    // session doesn't hang the flow forever.
    if (plannedState.kind !== 'loading') return;
    const mid = plannedState.mid;
    // Empty mid means the board-scan resolver is still working —
    // wait for it to populate mid and re-fire this effect.
    if (!mid) return;
    (async () => {
      await awaitAuthReady();
      const outcome = await loadPlannedMatch(mid);
      if (outcome.ok === false) {
        plannedState = { kind: 'not-found', mid };
        return;
      }
      const match = outcome.match;
      if (!match) {
        plannedState = { kind: 'not-found', mid };
        return;
      }
      const uid = currentUser()?.uid;
      // Match already completed — block re-play.
      if (match.completedAt) {
        plannedState = { kind: 'completed', mid, match };
        return;
      }
      // Someone else already claimed it — offer takeover.
      if (match.claimedBy && uid && match.claimedBy !== uid) {
        plannedState = {
          kind: 'takeover',
          mid,
          match,
          claimerName: `user ${match.claimedBy.slice(0, 6)}`,
        };
        return;
      }
      applyPlannedToCfg(match);
      // Claim happens at start() — not here. Loading the setup screen
      // should not flip the bracket row to "scoring"; only actually
      // tapping Start should do that.
      plannedState = { kind: 'loaded', mid };
    })();
  });

  /**
   * Populate cfg from a fetched PlannedMatch. Falls back to the
   * tournament's defaults for any config field the planned record
   * didn't specify; app defaults from DEFAULT_CONFIG win beyond that.
   */
  function applyPlannedToCfg(m: PlannedMatch) {
    // Look up the tournament for its defaults. The tournament store
    // may not be hydrated yet at this exact moment — that's fine, we
    // fall back through to DEFAULT_CONFIG.
    const t = loadAllTournaments().find((x) => x.key === m.tournamentKey);
    const td = t?.defaults;
    cfg.mode = m.mode;
    cfg.playerA = m.aName;
    cfg.playerA2 = m.a2Name ?? '';
    cfg.playerB = m.bName;
    cfg.playerB2 = m.b2Name ?? '';
    cfg.tournament = m.tournament;
    cfg.round = m.round ?? '';
    // Config precedence: planned.cfg > tournament.defaults > DEFAULT_CONFIG.
    cfg.bestOf = m.cfg?.bestOf ?? td?.bestOf ?? DEFAULT_CONFIG.bestOf;
    cfg.pointsTarget = m.cfg?.pointsTarget ?? td?.pointsTarget ?? DEFAULT_CONFIG.pointsTarget;
    cfg.maxBoards = m.cfg?.maxBoards ?? td?.maxBoards ?? DEFAULT_CONFIG.maxBoards;
    cfg.timerDuration = m.cfg?.timerDuration ?? td?.timerDuration ?? DEFAULT_CONFIG.timerDuration;
    // Stamp resolved player ids so finishMatch stamps playerAId
    // etc. on the archive. resolvedPlayerIds is the local map that
    // MatchSetup already maintains via the picker's onSelect.
    resolvedPlayerIds.playerA = m.aResolvedId ?? null;
    resolvedPlayerIds.playerA2 = m.a2ResolvedId ?? null;
    resolvedPlayerIds.playerB = m.bResolvedId ?? null;
    resolvedPlayerIds.playerB2 = m.b2ResolvedId ?? null;
  }

  /**
   * Apply tournament defaults to match rules when a tournament is selected
   * manually (no QR). Resets to DEFAULT_CONFIG when tournament is cleared.
   * Only runs in idle (non-QR) flow — QR flow uses applyPlannedToCfg.
   */
  let lastAppliedTournamentKey = $state<string | null>(null);
  $effect(() => {
    if (plannedState.kind !== 'idle') return;
    const t = pickedTournament();
    const key = t?.key ?? null;
    if (key === lastAppliedTournamentKey) return;
    lastAppliedTournamentKey = key;
    if (t?.defaults) {
      cfg.bestOf = t.defaults.bestOf ?? DEFAULT_CONFIG.bestOf;
      cfg.pointsTarget = t.defaults.pointsTarget ?? DEFAULT_CONFIG.pointsTarget;
      cfg.maxBoards = t.defaults.maxBoards ?? DEFAULT_CONFIG.maxBoards;
      cfg.timerDuration = t.defaults.timerDuration ?? DEFAULT_CONFIG.timerDuration;
    } else if (key === null) {
      cfg.bestOf = DEFAULT_CONFIG.bestOf;
      cfg.pointsTarget = DEFAULT_CONFIG.pointsTarget;
      cfg.maxBoards = DEFAULT_CONFIG.maxBoards;
      cfg.timerDuration = DEFAULT_CONFIG.timerDuration;
    }
  });

  /**
   * User confirmed takeover from the takeover screen. Claim the slot
   * for their uid, apply the record to cfg, and drop into the normal
   * setup flow.
   */
  async function confirmTakeover() {
    if (plannedState.kind !== 'takeover') return;
    const { mid, match } = plannedState;
    const uid = currentUser()?.uid;
    if (!uid) return;
    applyPlannedToCfg(match);
    void claimPlannedMatch(mid, uid);
    plannedState = { kind: 'loaded', mid };
  }
  function cancelTakeover() {
    // Return to the plain setup screen — clear the ?planned= param
    // so a refresh doesn't re-open the same choice.
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('planned');
      window.history.replaceState({}, '', url.toString());
    }
    plannedState = { kind: 'idle' };
  }
  function dismissNotFound() {
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('planned');
      window.history.replaceState({}, '', url.toString());
    }
    plannedState = { kind: 'idle' };
  }

  function startFresh() {
    // Player wants a casual/unlinked match from the same device.
    // Clear the planned params from the URL and reset all pre-filled
    // fields so the form is a blank slate — bracket slot stays "Ready".
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('planned');
      url.searchParams.delete('tournament');
      url.searchParams.delete('board');
      window.history.replaceState({}, '', url.toString());
    }
    plannedMid = '';
    plannedState = { kind: 'idle' };
    cfg.playerA = '';
    cfg.playerA2 = '';
    cfg.playerB = '';
    cfg.playerB2 = '';
    cfg.tournament = '';
    cfg.round = '';
    resolvedPlayerIds.playerA = null;
    resolvedPlayerIds.playerA2 = null;
    resolvedPlayerIds.playerB = null;
    resolvedPlayerIds.playerB2 = null;
  }

  // Per-device roster grown from past match setups. Merged with the
  // Firebase identity store below so a name typed on this device
  // autocompletes on the next setup even before Firebase is reached.
  let localPlayers = $state<PlayerRow[]>([]);
  let loadingPlayers = $state(true);

  const players = $derived<PlayerRow[]>(() => {
    // Read the identityTick so this recomputes when the /players
    // Firebase-backed store changes (admin adds a player etc.).
    void identityTick;
    // Concatenate local + identity-store, dedupe by name+country.
    // Identity-store rows are shaped as PlayerRow with source: 'identity'
    // and (when set) their stored country so the picker shows the flag
    // pill on Firebase-backed players.
    const identityRows: PlayerRow[] = loadAllPlayers().map((p) => ({
      name: p.canonicalName,
      source: 'identity',
      ...(p.country ? { country: p.country } : {}),
    }));
    const byKey = new Map<string, PlayerRow>();
    // Pass 1: local device-history rows, keyed by name only (they have
    // no country column).
    for (const p of localPlayers) {
      const key = `n:${p.name.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, p);
    }
    // Pass 2: identity rows. Fold country-less local rows into a
    // matching identity row so it gets a flag; keep namesakes-by-country
    // (e.g. Swapnil Deshpande from DK vs SE) as separate picker rows.
    for (const p of identityRows) {
      const nameKey = `n:${p.name.toLowerCase()}`;
      const idKey = `i:${p.name.toLowerCase()}|${(p.country ?? '').toLowerCase()}`;
      const priorByName = byKey.get(nameKey);
      if (priorByName && !priorByName.country) {
        byKey.delete(nameKey);
        byKey.set(idKey, { ...priorByName, country: p.country });
        continue;
      }
      if (!byKey.has(idKey)) byKey.set(idKey, p);
    }
    return Array.from(byKey.values());
  });

  $effect(() => {
    // Load device-history roster (localStorage). Bundled seed was
    // retired in v3.3.6 — Firebase /players is the source of truth
    // for tournament rosters + display flags.
    localPlayers = loadKnownPlayers();
    loadingPlayers = false;
  });

  // Identity store: subscribe to Firebase-backed /players and bump a
  // reactivity trigger whenever the store changes. This is how the
  // ranker (which reads from module-level state) triggers re-render.
  let identityTick = $state(0);
  $effect(() => {
    const unsub = subscribeStore(() => (identityTick += 1));
    void subscribePlayers();
    return unsub;
  });

  // Tournament store: same subscribe pattern as players. Fires the
  // reactivity trigger below when a remote update arrives.
  let tournamentTick = $state(0);
  $effect(() => {
    const unsub = subscribeTournamentsStore(() => (tournamentTick += 1));
    void subscribeTournaments();
    return unsub;
  });

  /**
   * Resolve the currently-typed tournament string against the shared
   * store. Returns null when the string doesn't match any known
   * tournament (free-text tag; open tournament by definition of
   * v3.1's data model — closed tournaments must be admin-created).
   */
  const pickedTournament = $derived<Tournament | null>(() => {
    void tournamentTick;
    const raw = cfg.tournament?.trim();
    if (!raw) return null;
    const key = normalizeKey(raw);
    if (!key) return null;
    return loadAllTournaments().find((t) => t.key === key) ?? null;
  });

  /**
   * Assigned-player ids for the picked closed tournament. Loaded
   * one-shot on tournament-key change. Empty set when the tournament
   * is open or none is picked. Read by the picker's warning
   * derivation below.
   */
  let assignedPlayerIds = $state<Set<string>>(new Set());
  let lastLoadedAssignmentKey = $state<string | null>(null);
  $effect(() => {
    const t = pickedTournament();
    const key = t?.type === 'closed' ? t.key : null;
    if (key === lastLoadedAssignmentKey) return;
    lastLoadedAssignmentKey = key;
    if (!key) {
      assignedPlayerIds = new Set();
      return;
    }
    void loadAssignedPlayers(key).then((set) => {
      // Guard against a stale key: if the user picked a different
      // tournament while the fetch was in-flight, drop the result.
      if (lastLoadedAssignmentKey === key) assignedPlayerIds = set;
    });
  });

  // Planned matches for the currently selected closed-tournament + round.
  // Used to enforce bracket membership before allowing a manual match start.
  let roundPlannedMatches = $state<PlannedMatch[]>([]);
  let roundAllMatches = $state<PlannedMatch[]>([]);
  let lastLoadedRoundKey = $state<string | null>(null);
  let roundMatchesLoading = $state(false);
  $effect(() => {
    const t = pickedTournament();
    if (!t || t.type !== 'closed') {
      roundPlannedMatches = [];
      roundAllMatches = [];
      lastLoadedRoundKey = null;
      roundMatchesLoading = false;
      return;
    }
    const roundKey = cfg.round.trim();
    const cacheKey = roundKey ? `${t.key}/${roundKey}` : null;
    if (cacheKey === lastLoadedRoundKey) return;
    lastLoadedRoundKey = cacheKey;
    if (!cacheKey) {
      roundPlannedMatches = [];
      roundAllMatches = [];
      roundMatchesLoading = false;
      return;
    }
    roundMatchesLoading = true;
    void loadAllPlannedByRound(t.key, roundKey).then((all) => {
      if (lastLoadedRoundKey !== cacheKey) return;
      roundAllMatches = all;
      roundPlannedMatches = all.filter((m) => !m.completedAt);
      roundMatchesLoading = false;
    });
  });

  // Abandoned-match prompt. When the umpire taps Start and we find an
  // existing /live record for the same two players with real scoring,
  // we pause and ask: Resume (navigate to old score URL) or Fresh start
  // (delete old record, begin new match). Zero-score records are silently
  // overwritten without prompting.
  type AbandonedMatch = { mid: string; scoreUrl: string; record: LiveRecord };
  let abandonedMatch = $state<AbandonedMatch | null>(null);
  let pendingStartFn = $state<(() => void) | null>(null);

  function hasRealScoring(record: LiveRecord): boolean {
    const ls = record.liveState;
    if (!ls) return false;
    return ls.board > 0 || (ls.sideA?.points ?? 0) > 0 || (ls.sideB?.points ?? 0) > 0;
  }

  async function findAbandonedLive(playerA: string, playerB: string): Promise<AbandonedMatch | null> {
    try {
      const [{ firebaseApp }, { getDatabase, ref, get }] = await Promise.all([
        import('../lib/firebase'),
        import('firebase/database'),
      ]);
      const db = getDatabase(firebaseApp());
      const snap = await get(ref(db, 'live'));
      const raw = snap.val() as Record<string, LiveRecord> | null;
      if (!raw) return null;
      const a = playerA.trim().toLowerCase();
      const b = playerB.trim().toLowerCase();
      for (const [mid, record] of Object.entries(raw)) {
        if (!record?.meta) continue;
        const ra = record.meta.playerA?.trim().toLowerCase() ?? '';
        const rb = record.meta.playerB?.trim().toLowerCase() ?? '';
        if ((ra === a && rb === b) || (ra === b && rb === a)) {
          if (!record.liveState?.matchResult) return { mid, scoreUrl: '', record };
        }
      }
    } catch { /* silent */ }
    return null;
  }

  function resumeAbandoned() {
    if (!abandonedMatch) return;
    const m = abandonedMatch.record.meta;
    const resumeCfg: MatchConfig = {
      ...DEFAULT_CONFIG,
      live: true,
      mid: abandonedMatch.mid,
      mode: (m.mode as MatchConfig['mode']) ?? 'singles',
      playerA: m.playerA ?? '',
      playerB: m.playerB ?? '',
      tournament: m.tournament ?? '',
      round: m.round ?? '',
      bestOf: m.bestOf ?? DEFAULT_CONFIG.bestOf,
      maxBoards: m.maxBoards ?? DEFAULT_CONFIG.maxBoards,
      pointsTarget: m.pointsTarget ?? DEFAULT_CONFIG.pointsTarget,
      timerDuration: m.timerDuration ?? DEFAULT_CONFIG.timerDuration,
    };
    window.location.href = `${base}score/?${encodeConfig(resumeCfg)}`;
    abandonedMatch = null;
    pendingStartFn = null;
  }

  async function discardAndStartFresh() {
    if (!abandonedMatch) return;
    await deleteLive(abandonedMatch.mid);
    abandonedMatch = null;
    const fn = pendingStartFn;
    pendingStartFn = null;
    fn?.();
  }

  // Resume-match chip. If the last-started match is still ongoing
  // on the server (record exists, matchResult is null, updatedAt is
  // within the 4h sweep window), surface a chip above the form so
  // the umpire can jump back into the /score/ view they closed. See
  // src/lib/resume.ts for storage semantics.
  const STALE_WINDOW_MS = 4 * 60 * 60 * 1000;
  let resumeCandidate = $state<ResumeRecord | null>(null);
  let resumeLiveRecord = $state<LiveRecord | null>(null);
  const resumeVisible = $derived(
    resumeCandidate !== null &&
      resumeLiveRecord !== null &&
      resumeLiveRecord.liveState?.matchResult == null &&
      Date.now() - resumeLiveRecord.updatedAt < STALE_WINDOW_MS,
  );
  $effect(() => {
    const rec = loadResume();
    if (!rec) return;
    resumeCandidate = rec;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void subscribeLive(rec.mid, (live) => {
      if (cancelled) return;
      if (!live) {
        // Record was deleted (admin cleanup, sweep). Clear the pointer.
        clearResume();
        resumeCandidate = null;
        resumeLiveRecord = null;
        return;
      }
      resumeLiveRecord = live;
      // Fire-and-forget cleanup if the server says the match ended
      // or hasn't been touched in > 4h. The chip disappears via
      // resumeVisible; also clear localStorage so the check doesn't
      // re-run on the next visit.
      const ended = live.liveState?.matchResult != null;
      const stale = Date.now() - live.updatedAt >= STALE_WINDOW_MS;
      if (ended || stale) clearResume();
    }).then((fn) => {
      if (cancelled) fn();
      else unsub = fn;
    });
    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  });

  function onResume(): void {
    if (!resumeCandidate) return;
    window.location.href = resumeCandidate.scoreUrl;
  }
  function onDiscardResume(): void {
    clearResume();
    resumeCandidate = null;
    resumeLiveRecord = null;
  }
  function resumeSubtitle(rec: ResumeRecord): string {
    const m = rec.meta;
    if (m.mode === 'practice') {
      return `Practice · ${m.playerA}`;
    }
    const a = [m.playerA, m.playerA2].filter(Boolean).join(' & ');
    const b = [m.playerB, m.playerB2].filter(Boolean).join(' & ');
    const modeLabel = m.mode === 'doubles' ? 'Doubles' : 'Singles';
    return `${modeLabel} · ${a} vs ${b}`;
  }

  // Footer "Admin" affordance is now a <SignInButton signedOutLabel="Admin" />
  // in the template — it owns its own auth + role subscription, so no
  // per-page state is needed here. Signed-out: pill reads "Admin";
  // tap opens Google sign-in. Signed-in: pill becomes avatar + name,
  // tap opens an inline dropdown with the role badge + Sign out.

  let showTournamentPicker = $state(false);
  let tournamentHighlight = $state<number>(-1);
  let suppressTournamentBlur = false;

  function pickTournament(name: string): void {
    cfg.tournament = name;
    showTournamentPicker = false;
    tournamentHighlight = -1;
    // Reset the round tag whenever the tournament changes — a round
    // is scoped to a specific tournament (its slug), so carrying the
    // old round string into a new tournament would archive a
    // round/roundKey pair that doesn't exist under the new parent.
    cfg.round = '';
  }

  const tourSuggestions = $derived.by<Tournament[]>(() => {
    void tournamentTick;
    return rankTournaments(cfg.tournament, 8);
  });
  const tourDropdownVisible = $derived.by<boolean>(
    () => showTournamentPicker && tourSuggestions.length > 0,
  );

  function onTournamentKeydown(e: KeyboardEvent, suggestions: Tournament[]) {
    const open = showTournamentPicker && suggestions.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suppressTournamentBlur = true;
      if (!open) { showTournamentPicker = true; tournamentHighlight = 0; }
      else tournamentHighlight = Math.min(tournamentHighlight + 1, suggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suppressTournamentBlur = true;
      tournamentHighlight = Math.max(tournamentHighlight - 1, 0);
    } else if ((e.key === 'Enter' || e.key === ' ') && open && tournamentHighlight >= 0) {
      e.preventDefault();
      const s = suggestions[tournamentHighlight];
      if (s) { pickTournament(s.name); suppressTournamentBlur = false; }
    } else if (e.key === 'Escape') {
      suppressTournamentBlur = false;
      showTournamentPicker = false;
      tournamentHighlight = -1;
    } else if (e.key === 'Tab') {
      if (open && tournamentHighlight >= 0) {
        e.preventDefault();
        suppressTournamentBlur = true;
        const s = suggestions[tournamentHighlight];
        if (s) { pickTournament(s.name); suppressTournamentBlur = false; }
      } else {
        suppressTournamentBlur = false;
        showTournamentPicker = false;
        tournamentHighlight = -1;
      }
    } else {
      if (open) tournamentHighlight = 0;
    }
  }

  /**
   * Round-picker plumbing (v3.2). Mirrors the tournament picker
   * pattern above — free-text with dropdown suggestions ranked over
   * the tournament's open rounds. Free-text is preserved even when
   * no suggestion matches (same posture as tournament today) so the
   * umpire can type a round the admin hasn't set up yet — the
   * denormalised (round, roundKey) pair still lands on the archive
   * and appears under an Unassigned sub-group in History.
   */
  const currentTournamentKey = $derived(() => {
    const raw = cfg.tournament.trim();
    return raw ? normalizeKey(raw) : '';
  });
  /** Rounds attached to the currently-typed tournament, refreshed on
   *  every tournament-store notify. Empty array when the tournament
   *  is blank or has no rounds — used by the template to hide the
   *  entire round-picker field. */
  const currentTournamentRounds = $derived<Round[]>(() => {
    void tournamentTick;
    const key = currentTournamentKey();
    return key ? loadRounds(key) : [];
  });
  /**
   * v3.3.6: the round picker is a native <select> instead of a
   * free-text input with autocomplete. Umpires didn't know what
   * round names existed until they typed a substring — the
   * dropdown shows every open round explicitly. Closed rounds are
   * filtered out by rankRounds so an organiser can hide a stage
   * from new-match creation without renaming or deleting the
   * round.
   *
   * `rankRounds(key, '', N)` with an empty query returns every
   * open round in `order` ascending — same order the History and
   * Reports accordions use.
   */
  const currentTournamentOpenRounds = $derived<Round[]>(() => {
    void tournamentTick;
    const key = currentTournamentKey();
    return key ? rankRounds(key, '', 64) : [];
  });

  function setMode(m: Mode) {
    const wasPractice = cfg.mode === 'practice';
    cfg.mode = m;
    if (m === 'singles') {
      cfg.playerA2 = '';
      cfg.playerB2 = '';
      // Restore versus-match defaults if we're coming back from Practice.
      // Mirrors DEFAULT_CFG (1 set × 25 points × 8 boards) so the two
      // paths — fresh page load vs mode-switch — always seed the same
      // config for a versus match.
      if (wasPractice) {
        cfg.bestOf = 1;
        cfg.maxBoards = 8;
        cfg.pointsTarget = 25;
      }
    } else if (m === 'practice') {
      // Solo drill: clear the whole B side and the doubles partner.
      // Practice defaults: 1 set × 4 boards, points unused. Overwriting
      // here (rather than at $state init) means switching back and forth
      // between modes always seeds sensible defaults.
      cfg.playerA2 = '';
      cfg.playerB = '';
      cfg.playerB2 = '';
      cfg.noteB = '';
      cfg.bestOf = 1;
      cfg.maxBoards = 4;
    } else if (m === 'doubles' && wasPractice) {
      // Same restore as the singles path above.
      cfg.bestOf = 1;
      cfg.maxBoards = 8;
      cfg.pointsTarget = 25;
    }
  }

  function suggest(query: string): PlayerRow[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return players().filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }

  // Which picker's suggestions are currently visible (by key).
  let openPicker = $state<string | null>(null);
  // Keyboard highlight index per picker (-1 = none).
  let pickerHighlight = $state<number>(-1);
  // Suppress blur-close while keyboard-navigating the dropdown.
  let suppressPickerBlur = false;

  function onPickerKeydown(key: keyof MatchConfig, e: KeyboardEvent, suggestions: PlayerRow[]) {
    const open = openPicker === key && suggestions.length > 0;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      suppressPickerBlur = true;
      if (!open) { openPicker = key; pickerHighlight = 0; }
      else pickerHighlight = Math.min(pickerHighlight + 1, suggestions.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      suppressPickerBlur = true;
      pickerHighlight = Math.max(pickerHighlight - 1, 0);
    } else if ((e.key === 'Enter' || e.key === ' ') && open && pickerHighlight >= 0) {
      e.preventDefault();
      const s = suggestions[pickerHighlight];
      if (s) { pick(key, s); suppressPickerBlur = false; pickerHighlight = -1; }
    } else if (e.key === 'Escape') {
      suppressPickerBlur = false;
      openPicker = null;
      pickerHighlight = -1;
    } else if (e.key === 'Tab') {
      if (open && pickerHighlight >= 0) {
        e.preventDefault();
        suppressPickerBlur = true;
        const s = suggestions[pickerHighlight];
        if (s) { pick(key, s); suppressPickerBlur = false; pickerHighlight = -1; }
      } else {
        suppressPickerBlur = false;
        openPicker = null;
        pickerHighlight = -1;
      }
    } else {
      if (open) pickerHighlight = 0;
    }
  }

  // ─── Player identity resolution ───────────────────────────────────────
  // Which Firebase playerId each input field currently resolves to (or
  // null if the typed name hasn't been matched to an existing player,
  // which means "create a new player when the match is saved").
  //
  // Keyed by the four possible name-input MatchConfig fields.
  // Country codes captured alongside the resolved id so ScoreBoard can
  // render the header flag on first paint without waiting for the
  // Firebase player-store hydration. Set whenever a picker row is
  // tapped or an exact-name auto-resolve fires — cleared when the name
  // no longer resolves.
  let resolvedPlayerCountries = $state<Record<string, string>>({
    playerA: '',
    playerA2: '',
    playerB: '',
    playerB2: '',
  });
  let resolvedPlayerIds = $state<Record<string, string | null>>({
    playerA: null,
    playerA2: null,
    playerB: null,
    playerB2: null,
  });

  /**
   * Top ranker hit for a given typed name — recomputed reactively via
   * identityTick + the raw text. Returns null on empty input, on no
   * matches, or on rank 'prefix' (which is handled by the existing
   * dropdown UI, not the confirm chip).
   */
  function topHit(text: string): PlayerMatch | null {
    // Read the tick so the derivation depends on it — Svelte's reactivity
    // then re-runs this on every subscribeStore() notify.
    void identityTick;
    void tournamentTick;
    const q = text.trim();
    if (!q) return null;
    // When the picked tournament has a country (a closed tournament,
    // typically), prefer an exact identity player whose country
    // matches the tournament's — otherwise a namesake with a
    // different country gets auto-resolved and lands in the "not
    // assigned" warning even though the DK-side namesake is
    // legitimately on the roster. Reported 2026-08-18: Denmark
    // Ranking Tournament + typed "Swapnil Deshpande" auto-resolved
    // to the Sweden player id.
    const t = pickedTournament();
    const preferredCountry = t?.country ?? '';
    if (preferredCountry) {
      const all = loadAllPlayers();
      const norm = q.toLowerCase();
      const country = all.find(
        (p) =>
          p.canonicalName.trim().toLowerCase() === norm &&
          (p.country ?? '').trim() === preferredCountry,
      );
      if (country) {
        return { player: country, rank: 'exact', matchedOn: country.canonicalName };
      }
    }
    const hits = rankMatches(loadAllPlayers(), q, 1);
    const h = hits[0];
    if (!h) return null;
    if (h.rank === 'prefix') return null;
    return h;
  }

  /**
   * Closed-tournament pick-warning derivation. Returns a short
   * warning label (or null) for a given player-input key, checked
   * against the picked tournament's assignment set and country.
   *
   * Non-blocking — the umpire can still Start; the warning is
   * advisory only. Rendered as a soft amber pill below the picker.
   * Only fires when the picked tournament is closed and known;
   * open tournaments and free-text tags produce no warnings.
   */
  function pickWarning(key: keyof MatchConfig): string | null {
    void identityTick;
    void tournamentTick;
    const t = pickedTournament();
    if (!t || t.type !== 'closed') return null;
    const typed = (cfg[key] as string).trim();
    if (!typed) return null;
    const resolvedId = resolvedPlayerIds[key as string];
    // Free-text (unresolved) and roster-miss collapse to the same
    // umpire-facing message. The distinction only matters internally.
    if (!resolvedId || !assignedPlayerIds.has(resolvedId)) {
      return 'Not assigned to this tournament — contact the organiser';
    }
    if (t.country) {
      const roster = loadAllPlayers().find((p) => p.id === resolvedId);
      if (roster && roster.country && roster.country !== t.country) {
        return `Country mismatch: ${roster.country} vs tournament ${t.country}`;
      }
    }
    return null;
  }

  /**
   * On text change: clear the resolved id (user is editing) and, if the
   * new text is an exact-normalised match, auto-resolve to that player.
   * Fuzzy hits do NOT auto-resolve — the user has to tap the chip.
   */
  function onNameInput(key: keyof MatchConfig, text: string): void {
    (cfg[key] as string) = text;
    const h = topHit(text);
    if (h && h.rank === 'exact') {
      resolvedPlayerIds[key as string] = h.player.id;
      resolvedPlayerCountries[key as string] = h.player.country ?? '';
    } else {
      resolvedPlayerIds[key as string] = null;
      resolvedPlayerCountries[key as string] = '';
    }
  }

  /**
   * Handler for the gold confirm chip: user has confirmed that their
   * typed string is an alias of the suggested player. Add the alias in
   * the identity store (which mirrors to Firebase) and mark this input
   * field as resolved.
   */
  function confirmAlias(key: keyof MatchConfig, hit: PlayerMatch, typed: string): void {
    addAlias(hit.player.id, typed);
    resolvedPlayerIds[key as string] = hit.player.id;
    resolvedPlayerCountries[key as string] = hit.player.country ?? '';
  }

  function pick(key: keyof MatchConfig, row: PlayerRow) {
    (cfg[key] as string) = row.name;
    openPicker = null;
    // Country from the picker row is the immediate source of truth for
    // ScoreBoard's header flag — captured here alongside the resolved
    // id so we don't depend on the async player-store hydration.
    resolvedPlayerCountries[key as string] = row.country ?? '';
    // If the picked row corresponds to an identity-store player, resolve
    // to that id. When the row carries a country, prefer the identity
    // player with matching (name, country) — otherwise namesakes from
    // different countries would all resolve to whichever identity row
    // rankMatches happens to return first. Falls back to name-only
    // rankMatches when there's no country on the row (seed/local
    // sources) or no country-matched identity player exists.
    const q = row.name.trim();
    const qNorm = q.toLowerCase();
    if (row.country) {
      const all = loadAllPlayers();
      const byCountry = all.find(
        (p) =>
          p.canonicalName.trim().toLowerCase() === qNorm &&
          (p.country ?? '').trim() === row.country,
      );
      if (byCountry) {
        resolvedPlayerIds[key as string] = byCountry.id;
        return;
      }
    }
    const hits = rankMatches(loadAllPlayers(), q, 1);
    const h = hits[0];
    resolvedPlayerIds[key as string] = h && h.rank === 'exact' ? h.player.id : null;
  }

  /**
   * Duplicate-player detection. A player can't play against themself.
   * Same-name players from different countries ARE distinct — the
   * identity store gives them distinct ids, so we key off resolvedId
   * when available and fall back to case-folded name for typed-but-
   * unresolved entries.
   *
   * Returns a human-readable error string if the current picks would
   * put the same player in two slots, or null when the lineup is
   * valid. Wired into canStart and rendered as an inline warning
   * below the player rows.
   */
  let dupError = $derived.by((): string | null => {
    if (cfg.mode === 'practice') return null;
    const slots: Array<{ label: string; name: string; key: keyof MatchConfig }> = [
      { label: cfg.mode === 'singles' ? 'Player A' : 'Player 1 (A)', name: cfg.playerA, key: 'playerA' },
      { label: cfg.mode === 'singles' ? 'Player B' : 'Player 1 (B)', name: cfg.playerB, key: 'playerB' },
    ];
    if (cfg.mode === 'doubles') {
      slots.push({ label: 'Player 2 (A)', name: cfg.playerA2, key: 'playerA2' });
      slots.push({ label: 'Player 2 (B)', name: cfg.playerB2, key: 'playerB2' });
    }
    // Build the canonical identity for each non-empty slot: resolvedId
    // if available, otherwise a lowercased trimmed name. Two slots
    // with the same identity string = the same player.
    const seen = new Map<string, string>();
    for (const s of slots) {
      const name = s.name.trim();
      if (name.length === 0) continue;
      const id = resolvedPlayerIds[s.key as string];
      const identity = id ? `id:${id}` : `name:${name.toLowerCase()}`;
      const prior = seen.get(identity);
      if (prior) {
        return `${prior} and ${s.label} are the same player. Pick a different player.`;
      }
      seen.set(identity, s.label);
    }
    return null;
  });

  /**
   * v3.3.6: when the picked tournament has rounds configured, the
   * umpire MUST pick one before starting the match. Prior behaviour
   * left round blank as an "unassigned" archive tag — that landed
   * the match in a nameless bucket in History and Reports. The
   * organiser's request: enforce the round pick client-side so
   * every match under a rounds-having tournament always carries a
   * round tag.
   *
   * Returns null when the check passes: either the tournament has
   * no rounds (round is truly optional) or the round input is
   * non-empty.
   */
  let roundError = $derived.by((): string | null => {
    if (cfg.mode === 'practice') return null;
    void tournamentTick;
    if (currentTournamentRounds().length === 0) return null;
    if (cfg.round.trim().length > 0) return null;
    return 'Pick a round for this tournament';
  });

  /**
   * v3.3.6: for a CLOSED tournament, every active player slot must
   * resolve to a roster-assigned playerId — a typed free-text name
   * is rejected. Open tournaments are untouched (their whole point
   * is walk-in-friendly, no roster).
   *
   * Country mismatch stays advisory (the amber pickWarning below);
   * blocking there would strand a Danish visitor at a Swedish event
   * with no umpire escape hatch. Roster membership is the hard rule.
   */
  let rosterError = $derived.by((): string | null => {
    if (cfg.mode === 'practice') return null;
    void identityTick;
    void tournamentTick;
    const t = pickedTournament();
    if (!t || t.type !== 'closed') return null;
    const slots: Array<{ label: string; name: string; key: keyof MatchConfig }> = [
      { label: cfg.mode === 'singles' ? 'Player A' : 'Player 1 (A)', name: cfg.playerA, key: 'playerA' },
      { label: cfg.mode === 'singles' ? 'Player B' : 'Player 1 (B)', name: cfg.playerB, key: 'playerB' },
    ];
    if (cfg.mode === 'doubles') {
      slots.push({ label: 'Player 2 (A)', name: cfg.playerA2, key: 'playerA2' });
      slots.push({ label: 'Player 2 (B)', name: cfg.playerB2, key: 'playerB2' });
    }
    for (const s of slots) {
      const typed = s.name.trim();
      if (typed.length === 0) continue;
      const id = resolvedPlayerIds[s.key as string];
      if (!id || !assignedPlayerIds.has(id)) {
        return `${s.label} is not assigned to this tournament. Please contact the organiser.`;
      }
    }
    return null;
  });

  // For closed tournaments with bracket rounds: block Start unless the
  // two players have a pre-seeded bracket slot in this round together.
  // Only fires when the round has at least one planned match (i.e. brackets
  // have been added). Skipped for QR-scan flow (plannedState.kind !== 'idle').
  let bracketError = $derived.by((): string | null => {
    if (plannedState.kind !== 'idle') return null;
    if (cfg.mode === 'practice') return null;
    void identityTick;
    void tournamentTick;
    const t = pickedTournament();
    if (!t || t.type !== 'closed') return null;
    if (roundPlannedMatches.length === 0) return null;
    const idA = resolvedPlayerIds['playerA'];
    const idB = resolvedPlayerIds['playerB'];
    if (!idA || !idB) return null;
    const hasSlot = roundPlannedMatches.some(
      (m) =>
        (m.aResolvedId === idA && m.bResolvedId === idB) ||
        (m.aResolvedId === idB && m.bResolvedId === idA),
    );
    if (!hasSlot) return 'These players do not have a bracket slot in this round';
    return null;
  });

  // Manual flow: detect if the picked pairing already has a completed slot in this
  // round. bracketError only checks pending slots; this checks the full list so
  // we can give a specific "already played" message instead of "no bracket slot".
  const duplicateMatchError = $derived.by((): { slot: PlannedMatch } | null => {
    if (plannedState.kind !== 'idle') return null;
    if (cfg.mode === 'practice') return null;
    void identityTick;
    void tournamentTick;
    const t = pickedTournament();
    if (!t || t.type !== 'closed') return null;
    if (roundAllMatches.length === 0) return null;
    const idA = resolvedPlayerIds['playerA'];
    const idB = resolvedPlayerIds['playerB'];
    if (!idA || !idB) return null;
    const slot = roundAllMatches.find(
      (m) =>
        m.completedAt &&
        ((m.aResolvedId === idA && m.bResolvedId === idB) ||
          (m.aResolvedId === idB && m.bResolvedId === idA)),
    );
    return slot ? { slot } : null;
  });

  // For a manual match on a closed tournament, resolve the planned slot mid so
  // ScoreBoard can stamp it complete after the match — same as the QR-scan path.
  const resolvedBracketMid = $derived.by((): string => {
    if (plannedState.kind !== 'idle') return '';
    const t = pickedTournament();
    if (!t || t.type !== 'closed') return '';
    if (roundPlannedMatches.length === 0) return '';
    const idA = resolvedPlayerIds['playerA'];
    const idB = resolvedPlayerIds['playerB'];
    if (!idA || !idB) return '';
    const slot = roundPlannedMatches.find(
      (m) =>
        (m.aResolvedId === idA && m.bResolvedId === idB) ||
        (m.aResolvedId === idB && m.bResolvedId === idA),
    );
    return slot?.mid ?? '';
  });

  // QR flow: everything locks — bracket encodes the full match config.
  // Manual flow: rules lock when a known tournament is selected (its
  // defaults define the rules); players/tournament/round stay editable.
  const isQrFlow = $derived(plannedState.kind === 'loaded');
  const rulesLocked = $derived(isQrFlow || pickedTournament() !== null);
  const playersLocked = $derived(isQrFlow);
  const tournamentLocked = $derived(isQrFlow);

  let canStart = $derived(() => {
    if (roundMatchesLoading) return false;
    const a1 = cfg.playerA.trim().length > 0;
    if (cfg.mode === 'practice') {
      // Solo drill: one player is enough. Also need a real per-set board count
      // so the score grid has a shape — reject 0 (unlimited) here.
      return a1 && cfg.maxBoards > 0;
    }
    const b1 = cfg.playerB.trim().length > 0;
    if (cfg.mode === 'singles') return a1 && b1 && !dupError && !roundError && !rosterError && !bracketError && !duplicateMatchError;
    return (
      a1 &&
      b1 &&
      cfg.playerA2.trim().length > 0 &&
      cfg.playerB2.trim().length > 0 &&
      !dupError &&
      !roundError &&
      !rosterError &&
      !bracketError &&
      !duplicateMatchError
    );
  });

  function start(e: Event) {
    e.preventDefault();
    if (!canStart()) return;
    // Check for an existing /live record for the same players.
    // Zero-score records: silently delete and continue.
    // Records with real scoring: pause and show resume/fresh prompt.
    if (cfg.mode !== 'practice') {
      void findAbandonedLive(cfg.playerA, cfg.playerB).then((found) => {
        if (!found) { doStart(); return; }
        if (!hasRealScoring(found.record)) {
          void deleteLive(found.mid).then(() => doStart());
        } else {
          abandonedMatch = found;
          pendingStartFn = doStart;
        }
      });
      return;
    }
    doStart();
  }

  function doStart() {
    const key = matchStateKey(cfg.mode, cfg.playerA, cfg.playerB);
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
    // Every match — including Practice — broadcasts live to
     // /live/{mid}. The slug rides the URL to the score screen so a
     // mid-match refresh preserves the broadcast. Practice players
     // often stream online play too, so they need overlay URLs.
    cfg.live = true;
    cfg.mid = newMid();
    // Practice never carries a tournament tag; force clear so a
    // stale value doesn't ride the URL. For singles/doubles, trim
    // and pass the raw string through to /matches/{id}.tournament +
    // .tournamentKey — the lobby groups on those fields.
    //
    // Until B3, this also called createOrTouchTournament(trimmed) to
    // auto-materialise a /tournaments/{key} entry on first sight. That
    // produced a long tail of near-duplicates (typos, casing variants,
    // "Silver Cup" vs "silver cup 2026") that admins had to merge by
    // hand. Now the admin-panel "+ Add tournament" flow is the only
    // path to /tournaments/. Matches can still carry any raw string
    // — the lobby's bucket-by-string grouping keeps working. Attaching
    // organiser privileges requires the admin to create the canonical
    // entry to bind the tournamentKey → organisers/ mapping.
    if (cfg.mode === 'practice') {
      cfg.tournament = '';
    } else {
      cfg.tournament = cfg.tournament.trim();
    }
    // Clear any stale identity handoff from a previous match with these
    // same names, then persist the fresh resolutions + start timestamp
    // so the score screen can pass them into finishMatch() on End.
    clearMatchIdentity(key);
    // Snapshot the resolved player's country into the identity handoff
    // so ScoreBoard's header flag renders on first paint — no waiting
    // for the Firebase player-store hydration. Doubles gets no flag
    // (team ≠ one person), so we only snapshot for singles. We read
    // from resolvedPlayerCountries (captured by pick/onNameInput/
    // confirmAlias) rather than the async player-store, so the flag
    // survives a Setup → Score handoff on a cold cache.
    // v3.4.5: snapshot country for every mode, not singles-only.
    // Practice needs it so the solo overlay can render side-A's flag;
    // doubles benefits from side-A's country as the team-flag proxy.
    // Previous guard `cfg.mode === 'singles' ? … : ''` dropped country
    // on the floor for solo + doubles, which is why /live/ solo
    // overlays never showed a flag.
    const aCountry = resolvedPlayerCountries.playerA;
    const bCountry = cfg.mode === 'practice' ? '' : resolvedPlayerCountries.playerB;
    saveMatchIdentity(key, {
      aResolvedId: resolvedPlayerIds.playerA,
      a2ResolvedId: resolvedPlayerIds.playerA2,
      bResolvedId: resolvedPlayerIds.playerB,
      b2ResolvedId: resolvedPlayerIds.playerB2,
      ...(aCountry ? { aCountry } : {}),
      ...(bCountry ? { bCountry } : {}),
    });
    // Remember these names in the per-device roster so the picker
    // autocompletes them next time. Practice mode contributes only
    // playerA; Doubles contributes all four.
    rememberPlayers(cfg.playerA, cfg.playerA2, cfg.playerB, cfg.playerB2);
    // Remember this match so a mistakenly-closed /score/ tab can be
    // resumed from Home. Cleared on End paths in ScoreBoard.
    // v3.6: if this setup came from a planned-match QR scan, thread
    // the mid through to the score URL. ScoreBoard reads ?planned=<mid>
    // and deletes /planned/{mid} once the match archives.
    // Claim the planned slot now that the match is actually starting.
    // Silent-on-failure — a signed-out umpire can still score; they
    // just won't stamp claimedBy on the bracket row.
    const uid = currentUser()?.uid ?? '';
    const effectiveMid = plannedMid || resolvedBracketMid;
    if (effectiveMid) void claimPlannedMatch(effectiveMid, uid);
    const plannedSuffix = effectiveMid ? `&planned=${encodeURIComponent(effectiveMid)}` : '';
    const scoreUrl = `${base}score/?${encodeConfig(cfg)}${plannedSuffix}`;
    saveResume({
      mid: cfg.mid,
      scoreUrl,
      startedAt: Date.now(),
      meta: {
        mode: cfg.mode,
        playerA: cfg.playerA,
        ...(cfg.playerA2 ? { playerA2: cfg.playerA2 } : {}),
        playerB: cfg.playerB,
        ...(cfg.playerB2 ? { playerB2: cfg.playerB2 } : {}),
        ...(cfg.tournament ? { tournament: cfg.tournament } : {}),
      },
    });
    if (cfg.timerDuration > 0) {
      // saveMatchStart is called inside beginCountdown when the countdown
      // reaches 0 — stamping it now would eat the 10-second delay.
      beginCountdown(scoreUrl, key);
    } else {
      saveMatchStart(key, Date.now());
      window.location.href = scoreUrl;
    }
  }

  // 10-second "Get ready" countdown shown after Start is tapped
  // (only when timerDuration > 0). Once it hits 0 the browser
  // navigates to the score screen.
  let countdownSecs = $state<number | null>(null);
  let pendingScoreUrl = $state('');
  let countdownIntervalId: ReturnType<typeof setInterval> | null = null;

  function cancelCountdown() {
    if (countdownIntervalId !== null) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
    countdownSecs = null;
    pendingScoreUrl = '';
  }

  function beginCountdown(url: string, startKey: string) {
    countdownSecs = 5;
    pendingScoreUrl = url;
    countdownIntervalId = setInterval(() => {
      countdownSecs = (countdownSecs ?? 1) - 1;
      if ((countdownSecs ?? 0) <= 0) {
        clearInterval(countdownIntervalId!);
        countdownIntervalId = null;
        // Stamp the match start exactly when the countdown hits 0 so
        // the timer on the score screen begins from the right moment.
        saveMatchStart(startKey, Date.now());
        window.location.href = pendingScoreUrl;
      }
    }, 1000);
  }

  // PWA install prompt. Android/desktop Chrome fires `beforeinstallprompt`; iOS
  // doesn't, so we fall back to a text hint there.
  type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
  let installEvt = $state<BIPEvent | null>(null);
  let iOS = $state(false);

  $effect(() => {
    const onBIP = (e: Event) => {
      e.preventDefault();
      installEvt = e as BIPEvent;
    };
    window.addEventListener('beforeinstallprompt', onBIP);
    iOS = /iP(ad|hone|od)/.test(navigator.userAgent) && !('MSStream' in window);

    // Drop any lingering landscape lock the score screen left behind.
    try {
      const so = (screen as unknown as { orientation?: { unlock?: () => void } }).orientation;
      so?.unlock?.();
    } catch {
      // silent
    }

    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  });

  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    installEvt = null;
  }

  // Update check — one call per page load, silent on failure.
  //
  // Two very different signals live here:
  //   - `apkUpdateAvailable`: the LATEST GitHub Release has an
  //     apk-required marker AND is newer than the currently-running web
  //     APP_VERSION. This is rare — icon/orientation/SDK bumps only.
  //     Shown as a sharp amber-red banner with a download-APK CTA.
  //   - `swJustUpdated`: the service worker just installed a new
  //     bundle while the user was on the page (see BaseLayout.astro).
  //     Shown as a soft info toast — "restart to see the latest",
  //     no download involved.
  let latestRelease = $state<ReleaseInfo | null>(null);
  let swJustUpdated = $state(false);

  const apkUpdateAvailable = $derived(
    latestRelease !== null
    && latestRelease.apkRequired
    && isNewerVersion(APP_VERSION, latestRelease.tag),
  );
  const releaseUrl = $derived(latestRelease
    ? `https://github.com/swapnild2111/carromscore/releases/tag/${latestRelease.tag}`
    : 'https://github.com/swapnild2111/carromscore/releases/latest');

  $effect(() => {
    fetchLatestRelease().then((info) => (latestRelease = info));

    const onSwUpdated = () => { swJustUpdated = true; };
    window.addEventListener('carrom:sw-updated', onSwUpdated);
    return () => window.removeEventListener('carrom:sw-updated', onSwUpdated);
  });

  // v3.4: log a screen_view for the home page on mount. No-op when
  // the user hasn't opted into analytics — the callsite doesn't
  // have to know the consent state.
  $effect(() => {
    void logScreen('home');
  });

  function restartApp() {
    // Bypass the SW cache for the reload — we want the freshest HTML shell.
    window.location.reload();
  }

  // Feedback popup extracted to a shared component so the lobby
  // footer can render the same UX without duplicating state.
  // See src/components/FeedbackPopup.svelte.
</script>

{#snippet picker(label: string, key: keyof MatchConfig, disabled = false)}
  {@const typed = (cfg[key] as string)}
  {@const suggestions = suggest(typed)}
  {@const dropdownVisible = !disabled && openPicker === key && suggestions.length > 0}
  {@const hit = topHit(typed)}
  <label class="picker" class:picker-locked={disabled}>
    <span>{label}</span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Type a name…"
      value={typed}
      role="combobox"
      aria-expanded={dropdownVisible}
      aria-autocomplete="list"
      {disabled}
      oninput={(e) => { pickerHighlight = 0; onNameInput(key, (e.currentTarget as HTMLInputElement).value); }}
      onfocus={() => { openPicker = key; pickerHighlight = -1; }}
      onblur={() => setTimeout(() => { if (!suppressPickerBlur && openPicker === key) { openPicker = null; pickerHighlight = -1; } suppressPickerBlur = false; }, 200)}
      onkeydown={(e) => onPickerKeydown(key, e, suggestions)}
    />
    {#if dropdownVisible}
      <ul class="suggest">
        {#each suggestions as p, i (p.name + '|' + p.source + '|' + (p.country ?? ''))}
          <li>
            <button
              type="button"
              class:suggest-highlighted={i === pickerHighlight}
              onmouseenter={() => (pickerHighlight = i)}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => { pick(key, p); pickerHighlight = -1; }}
            >
              <span class="pname">{p.name}</span>
              {#if p.country && p.country !== 'Unknown'}
                <span class="pcountry" title={countryName(p.country)} aria-hidden="true">
                  {#if flagEmoji(p.country)}{flagEmoji(p.country)}{/if}
                  {countryName(p.country)}
                </span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}

    <!--
      Identity chip: only renders for fuzzy hits — the case where the
      typed text differs from the suggested canonical name. Exact
      matches auto-resolve silently (input value already IS the
      canonical name; no chip needed). Prefix hits are handled by the
      substring dropdown above. Hidden while the dropdown is open to
      avoid double-signalling.
    -->
    {#if hit && hit.rank === 'fuzzy' && !dropdownVisible}
      <button
        type="button"
        class="id-chip id-chip-suggest"
        onmousedown={(e) => e.preventDefault()}
        onclick={() => confirmAlias(key, hit, typed)}
      >
        Same as <strong>{hit.player.canonicalName}</strong>? Tap to link.
      </button>
    {/if}
    {#if !dropdownVisible}
      {@const warn = pickWarning(key)}
      {#if warn}
        <span class="closed-warn" role="status" aria-live="polite">
          <span aria-hidden="true">⚠</span> {warn}
        </span>
      {/if}
    {/if}
  </label>
{/snippet}

{#snippet noteInput(label: string, key: 'noteA' | 'noteB', disabled = false)}
  <label class="note-input" class:picker-locked={disabled}>
    <span>{label}{#if !disabled} <em class="hint-inline">(optional)</em>{/if}</span>
    <input
      type="text"
      autocomplete="off"
      maxlength="24"
      placeholder="Country, state, club…"
      value={cfg[key]}
      {disabled}
      oninput={(e) => (cfg[key] = (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/snippet}


{#if plannedState.kind === 'loading'}
  <aside class="planned-notice" aria-label="Loading planned match">
    <p>Loading match…</p>
  </aside>
{:else if plannedState.kind === 'not-found'}
  <aside class="planned-notice planned-notice-warn" aria-label="Planned match not available">
    {#if plannedState.reason === 'no-active-round'}
      <h3>No active round</h3>
      <p>The organiser hasn't started a round yet. Ask them to open a round — then scan again.</p>
    {:else if plannedState.reason === 'all-complete'}
      <h3>All matches done</h3>
      <p>Every match on this board is already played. The organiser may need to start the next round.</p>
    {:else}
      <h3>Match not available</h3>
      <p>This match slot isn't around anymore. It may have already been
      played, or the organiser removed it. Ask them for a fresh QR.</p>
    {/if}
  </aside>
{:else if plannedState.kind === 'completed'}
  {@const r = plannedState.match.result}
  {@const winner = r?.winner === 'a' ? plannedState.match.aName : r?.winner === 'b' ? plannedState.match.bName : null}
  <aside class="planned-notice planned-notice-warn" aria-label="Match already played">
    <h3>Match already played</h3>
    {#if r}
      <p>
        {plannedState.match.aName} <strong>{r.setsA} – {r.setsB}</strong> {plannedState.match.bName}
        {#if winner}· {winner} won{/if}
      </p>
    {/if}
    <p>This match is already recorded. Contact the organiser if the result needs to be changed.</p>
  </aside>
{:else if plannedState.kind === 'takeover'}
  <aside class="planned-notice planned-notice-warn" aria-label="Match in progress">
    <h3>Match already being scored</h3>
    <p>Someone is already scoring this match ({plannedState.claimerName}).
    If you're taking over, confirm below and continue. Otherwise cancel.</p>
    <div class="planned-actions">
      <button type="button" class="planned-btn planned-btn-primary" onclick={confirmTakeover}>
        Take over
      </button>
      <button type="button" class="planned-btn" onclick={cancelTakeover}>
        Cancel
      </button>
    </div>
  </aside>
{:else if plannedState.kind === 'loaded'}
  <!--
    Bracket-scan preview (v3.6.1). Renders the players + tournament +
    round + mode + set/board format so the umpire can double-check
    before tapping Start. If any detail is wrong they can edit the
    fields below the banner as usual, then Start.
  -->
  <aside class="planned-notice planned-notice-ok planned-preview" aria-label="Planned match ready">
    <p class="planned-title">
      <span class="planned-badge">Bracket</span>
      {#if cfg.tournament}<strong>{cfg.tournament}</strong>{/if}
      {#if cfg.round}<span class="planned-sep">·</span>{cfg.round}{/if}
    </p>
    <p class="planned-players">
      <span class="planned-side">
        {cfg.playerA}{#if cfg.playerA2} <span class="planned-and">+</span> {cfg.playerA2}{/if}
      </span>
      <span class="planned-vs">vs</span>
      <span class="planned-side">
        {cfg.playerB}{#if cfg.playerB2} <span class="planned-and">+</span> {cfg.playerB2}{/if}
      </span>
    </p>
    <p class="planned-format">
      {cfg.mode === 'doubles' ? 'Doubles' : 'Singles'} ·
      bo{cfg.bestOf} · target {cfg.pointsTarget}{cfg.maxBoards ? ` · max ${cfg.maxBoards} boards` : ''}{cfg.timerDuration ? ` · ${cfg.timerDuration} min timer` : ''}
    </p>
    <p class="planned-hint">Review below and tap Start when the players are seated.</p>
    <button type="button" class="planned-fresh-btn" onclick={startFresh}>
      Not this match? Play without bracket
    </button>
  </aside>
{/if}

{#if resumeVisible && resumeCandidate}
  <!-- Resume-match chip. Appears when the last-started /score/ tab
       was closed while a match was still ongoing. Tap Resume to jump
       back to the same /score/?... URL; Discard forgets the pointer
       (leaves the /live/{mid} record in place — 4h sweep or admin
       cleanup handles that). -->
  <aside class="resume-chip" aria-label="Resume last match">
    <div class="resume-body">
      <span class="resume-icon" aria-hidden="true">↻</span>
      <div class="resume-text">
        <strong>Resume match</strong>
        <span class="resume-sub">{resumeSubtitle(resumeCandidate)}</span>
      </div>
    </div>
    <div class="resume-actions">
      <button type="button" class="resume-btn resume-primary" onclick={onResume}>
        Resume
      </button>
      <button type="button" class="resume-btn resume-secondary" onclick={onDiscardResume}>
        Discard
      </button>
    </div>
  </aside>
{/if}

{#if abandonedMatch}
  <aside class="resume-chip abandoned-prompt" aria-label="Abandoned match found">
    <div class="resume-body">
      <span class="resume-icon" aria-hidden="true">⚠</span>
      <div class="resume-text">
        <strong>Match already in progress</strong>
        <span class="resume-sub">
          {abandonedMatch.record.meta?.playerA ?? ''} vs {abandonedMatch.record.meta?.playerB ?? ''} — resume or start fresh?
        </span>
      </div>
    </div>
    <div class="resume-actions">
      <button type="button" class="resume-btn resume-primary" onclick={resumeAbandoned}>
        Resume
      </button>
      <button type="button" class="resume-btn resume-secondary" onclick={discardAndStartFresh}>
        Start fresh
      </button>
    </div>
  </aside>
{/if}

<form class="setup" onsubmit={start}>
  <!--
    Mode selection renders BEFORE Match rules because the chosen
    mode reshapes the rules block: Practice hides the Points input
    and relabels Boards → Boards per set, and setMode() rewrites
    bestOf/pointsTarget/maxBoards defaults. Rendering Mode first
    means the umpire picks it once, then reads/edits rule values
    that already reflect the mode — no back-and-forth. Reordered
    2026-08-15.
  -->
  <fieldset class="fmt fmt-mode" class:rules-locked={rulesLocked}>
    <legend>
      Mode{#if rulesLocked}<span class="rules-lock-badge" title="Mode set by tournament">🔒</span>{/if}
      {#if !rulesLocked}
      <HelpTip label="Help: match mode">
        <strong>Singles</strong> — one player per side.<br/>
        <strong>Doubles</strong> — two players per side (2v2).<br/>
        <strong>Practice</strong> — solo drill; tracks boards + misses only, no opponent.
      </HelpTip>
      {/if}
    </legend>
    <label class:selected={cfg.mode === 'singles'} class:mode-locked={rulesLocked}>
      <input type="radio" name="mode" value="singles" checked={cfg.mode === 'singles'} onchange={() => setMode('singles')} disabled={rulesLocked} />
      <span class="opt-title">Singles</span>
      <span class="opt-meta">1 vs 1</span>
    </label>
    <label class:selected={cfg.mode === 'doubles'} class:mode-locked={rulesLocked}>
      <input type="radio" name="mode" value="doubles" checked={cfg.mode === 'doubles'} onchange={() => setMode('doubles')} disabled={rulesLocked} />
      <span class="opt-title">Doubles</span>
      <span class="opt-meta">2 vs 2</span>
    </label>
    <label class:selected={cfg.mode === 'practice'} class:mode-locked={rulesLocked}>
      <input type="radio" name="mode" value="practice" checked={cfg.mode === 'practice'} onchange={() => setMode('practice')} disabled={rulesLocked} />
      <span class="opt-title">Practice</span>
      <span class="opt-meta">Solo drill</span>
    </label>
  </fieldset>

  <fieldset class="rules" class:rules-practice={cfg.mode === 'practice'} class:rules-locked={rulesLocked}>
    <legend>Match rules{#if rulesLocked}<span class="rules-lock-badge" title="Rules set by tournament">🔒</span>{/if}</legend>
    <label>
      <span>Sets</span>
      <input type="number" min="1" max="9" step="1" bind:value={cfg.bestOf} disabled={rulesLocked} />
    </label>
    {#if cfg.mode !== 'practice'}
      <label>
        <span>Points</span>
        <input type="number" min="1" step="1" bind:value={cfg.pointsTarget} disabled={rulesLocked} />
      </label>
    {/if}
    <label>
      <span>{cfg.mode === 'practice' ? 'Boards per set' : 'Boards'}</span>
      <div class="rules-val-row">
        <input type="number" min={cfg.mode === 'practice' ? 1 : 0} step="1" bind:value={cfg.maxBoards} disabled={rulesLocked} />
      </div>
    </label>
    <label>
      <span>Timer <em class="rules-label-hint">(mins)</em></span>
      <div class="rules-val-row">
        <input
          type="number"
          min="0"
          max="300"
          step="1"
          bind:value={cfg.timerDuration}
          disabled={rulesLocked}
          onblur={(e) => {
            const v = (e.currentTarget as HTMLInputElement).value;
            if (v === '' || v === null) cfg.timerDuration = 0;
          }}
        />
      </div>
    </label>
  </fieldset>


  <!--
    Tournament / event input. Free-text; auto-suggested from the
    Firebase-backed tournaments store. Blank = untagged (grouped as
    "Default" in the lobby). Sits just above player names because
    it's the highest-level context ("which event are we playing?").
    Hidden in Practice mode — a solo drill doesn't sit inside a
    tournament in any meaningful way.
  -->
  {#if cfg.mode !== 'practice'}
  <div class="event-block">
  <label class="tournament-input" class:picker-locked={tournamentLocked}>
    <span>
      Tournament{#if !tournamentLocked} <em class="hint-inline">(optional)</em>{/if}
      {#if !tournamentLocked}
      <HelpTip label="Help: tournament">
        Groups this match with others of the same event name in the Lobby. Leave blank for casual play (matches show under <strong>Default</strong>). Type an existing tournament name to reuse it, or type a new one to create it.
      </HelpTip>
      {/if}
    </span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Event name — Silver Cup 2026, Sunday Club Night, …"
      value={cfg.tournament}
      role="combobox"
      aria-expanded={tourDropdownVisible}
      aria-autocomplete="list"
      disabled={tournamentLocked}
      oninput={(e) => {
        const nextValue = (e.currentTarget as HTMLInputElement).value;
        const prevKey = normalizeKey(cfg.tournament.trim());
        const nextKey = normalizeKey(nextValue.trim());
        if (prevKey !== nextKey) cfg.round = '';
        cfg.tournament = nextValue;
        tournamentHighlight = 0;
      }}
      onfocus={() => { showTournamentPicker = true; tournamentHighlight = -1; }}
      onblur={() => setTimeout(() => { if (!suppressTournamentBlur) { showTournamentPicker = false; tournamentHighlight = -1; } suppressTournamentBlur = false; }, 200)}
      onkeydown={(e) => onTournamentKeydown(e, tourSuggestions)}
      maxlength="60"
    />
    {#if tourDropdownVisible}
      <ul class="suggest">
        {#each tourSuggestions as t, ti (t.key)}
          <li>
            <button
              type="button"
              class:suggest-highlighted={ti === tournamentHighlight}
              onmouseenter={() => (tournamentHighlight = ti)}
              onmousedown={(e) => e.preventDefault()}
              onclick={() => pickTournament(t.name)}
            >
              <span class="pname">{t.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </label>

  <!--
    Round picker (v3.3.6 restyled from v3.2). Native <select>
    dropdown listing every OPEN round attached to the picked
    tournament. Closed rounds are filtered out by rankRounds so
    an organiser can retire a stage without deleting it. Legacy
    tournaments without any rounds hide the whole field.

    Rationale for switching from free-text-with-autocomplete to a
    strict <select>: reported 2026-08-19 — umpires didn't know
    what round names existed until they typed a substring. Native
    select is instantly discoverable, and the round field is
    tournament-scoped so a strict list is fine (unlike the
    tournament input, which stays free-text for casual events).
  -->
  {#if currentTournamentRounds().length > 0}
  <label class="tournament-input" class:picker-locked={tournamentLocked}>
    <span>
      Round{#if !tournamentLocked} <em class="hint-inline">(required)</em>{/if}
      {#if !tournamentLocked}
      <HelpTip label="Help: round">
        Which stage of the tournament this match belongs to — Round of 16, Quarter-finals, Semi-finals, Final, etc. This tournament has rounds set up, so pick one before starting the match. History and Reports group matches by round.
      </HelpTip>
      {/if}
    </span>
    <select
      class="round-select"
      bind:value={cfg.round}
      aria-label="Round"
      disabled={tournamentLocked}
    >
      <option value="" disabled>Pick a round…</option>
      {#each currentTournamentOpenRounds() as r (r.key)}
        <option value={r.name}>{r.name}</option>
      {/each}
    </select>
  </label>
  {/if}
  </div>
  {/if}

  {#if cfg.mode === 'singles'}
    <div class="players-block">
      <div class="player-card player-card-a">
        <span class="player-card-label">Player A</span>
        {@render picker('Name', 'playerA', playersLocked)}
        <details class="represents-details" open={!!cfg.noteA}>
          <summary class="represents-summary">Additional details</summary>
          {@render noteInput('Represents', 'noteA', rulesLocked)}
        </details>
      </div>
      <div class="player-card player-card-b">
        <span class="player-card-label">Player B</span>
        {@render picker('Name', 'playerB', playersLocked)}
        <details class="represents-details" open={!!cfg.noteB}>
          <summary class="represents-summary">Additional details</summary>
          {@render noteInput('Represents', 'noteB', rulesLocked)}
        </details>
      </div>
    </div>
  {:else if cfg.mode === 'practice'}
    <div class="players-block">
      <div class="player-card player-card-a">
        <span class="player-card-label">Player</span>
        {@render picker('Name', 'playerA', playersLocked)}
        <details class="represents-details" open={!!cfg.noteA}>
          <summary class="represents-summary">Additional details</summary>
          {@render noteInput('Represents', 'noteA', rulesLocked)}
        </details>
      </div>
    </div>
  {:else}
    <!--
      Doubles: two team blocks tinted with the same side-A blue and
      side-B coral used by the scoreboard pills. Makes the setup
      screen preview the on-scoreboard identity — the reader can
      already tell which team is which colour before the match
      starts.
    -->
    <div class="team-block team-block-a">
      <h3>Team A</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerA', playersLocked)}
        {@render picker('Player 2', 'playerA2', playersLocked)}
      </div>
      <details class="represents-details" open={!!cfg.noteA}>
        <summary class="represents-summary">Additional details</summary>
        {@render noteInput('Team A represents', 'noteA', rulesLocked)}
      </details>
    </div>
    <div class="team-block team-block-b">
      <h3>Team B</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerB', playersLocked)}
        {@render picker('Player 2', 'playerB2', playersLocked)}
      </div>
      <details class="represents-details" open={!!cfg.noteB}>
        <summary class="represents-summary">Additional details</summary>
        {@render noteInput('Team B represents', 'noteB', rulesLocked)}
      </details>
    </div>
  {/if}

  {#if dupError}
    <p class="dup-error" role="alert">{dupError}</p>
  {/if}

  {#if duplicateMatchError}
    {@const slot = duplicateMatchError.slot}
    {@const r = slot.result}
    <aside class="dup-played-notice" role="alert">
      <strong>Match already played</strong>
      {#if r}
        — {slot.aName} <span class="dup-score">{r.setsA}–{r.setsB}</span> {slot.bName}
        {#if r.winner === 'a'} · {slot.aName} won{:else if r.winner === 'b'} · {slot.bName} won{/if}
      {/if}
      <br />
      Contact the organiser if this needs to be changed.
    </aside>
  {/if}

  <button
    class="start"
    type="submit"
    disabled={!canStart()}
    title={roundMatchesLoading ? 'Loading bracket…' : (!canStart() ? (rosterError ?? bracketError ?? roundError ?? undefined) : undefined)}
  >
    {roundMatchesLoading ? 'Loading…' : 'Start match →'}
  </button>

  {#if loadingPlayers}
    <p class="hint">Loading player list…</p>
  {/if}

  {#if apkUpdateAvailable}
    <!--
      APK-required release. This is the rare case where the wrapper
      itself changed (icon, orientation, SDK, URL) and the user needs to
      install the new APK — the automatic web update wouldn't pick up
      wrapper-level changes.
    -->
    <a class="update-banner update-banner-apk" href={releaseUrl} target="_blank" rel="noopener">
      <span class="upd-dot" aria-hidden="true"></span>
      <span class="upd-body">
        <strong class="upd-title">New Android version required</strong>
        <span class="upd-sub">
          <span class="upd-from">v{APP_VERSION}</span>
          <span class="upd-arrow" aria-hidden="true">→</span>
          <span class="upd-to">{latestRelease?.tag}</span>
          <span class="upd-cta">· Tap to download the new APK</span>
        </span>
        {#if latestRelease?.apkRequiredReason}
          <span class="upd-reason">Why: {latestRelease.apkRequiredReason}</span>
        {/if}
      </span>
    </a>
  {/if}

  {#if swJustUpdated}
    <!--
      Web-layer refresh detected via service-worker controllerchange.
      Soft, non-blocking: the user can keep scoring; when they're ready
      they tap Restart to pick up the freshest bundle.
    -->
    <button type="button" class="sw-toast" onclick={restartApp}>
      <span class="sw-toast-icon" aria-hidden="true">✨</span>
      <span class="sw-toast-body">
        <strong>Carromscore just updated.</strong>
        Tap to restart and see the latest.
      </span>
    </button>
  {/if}

  {#if installEvt}
    <button class="install" type="button" onclick={install}>Install Carromscore</button>
  {:else if iOS}
    <p class="hint">Tap Share → Add to Home Screen to install.</p>
  {/if}

  <!--
    Footer: two rows so the useful links (How to use, Feedback) sit
    on top and don't get lost in the meta strip. Row 2 is quiet:
    version + copyright, low contrast.
  -->
  <div class="foot-block">
    <!--
      Row 1 uses <div> not <p> because SignInButton renders a <button>
      / <div> block, and <button> nested inside a <p> is invalid HTML
      (browsers auto-close the <p> and the layout breaks).
    -->
    <div class="foot-links">
      <!--
        v3.4.8: "How to use" + "Feedback" merged into a single "Help"
        entry to reduce footer clutter. The feedback popup now lives
        at the top of the /help/ page, so clicking Help lands the
        umpire on the how-to guide and gives them the same feedback
        affordance inline.
      -->
      <a
        href={`${base}help/`}
        class="foot-link"
        aria-label="Help — how to use Carromscore + send feedback"
      >Help ⇗</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <!--
        Donate link. Opens the Ko-fi donation page in a new tab.
        Renamed from "Support" in v3.4 — the earlier wording read
        as a bug-report / feedback channel to some readers, muddying
        what the link actually does. Ko-fi accepts card + PayPal +
        Apple Pay + Google Pay; the repo's Sponsor button
        (github.com/sponsors/…) is the other channel for donors who
        prefer GitHub-native. Both funnel to the same maintainer
        bank account. Kept muted so it never competes with primary
        actions on the page.
      -->
      <a
        href="https://ko-fi.com/carromscore"
        target="_blank"
        rel="noopener noreferrer"
        class="foot-link foot-link-support"
        aria-label="Donate to Carromscore on Ko-fi"
      >Donate ❤</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <!--
        Sign-in entry point. Same SignInButton component the lobby
        footer uses. Label is "Sign in" everywhere — any user can
        sign in to edit their own matches. Super-admin + organiser
        privileges are additional access, layered on top after sign-in,
        not a separate entry point.
        Signed in: pill becomes the avatar + name; tap opens an
        inline dropdown with role + Sign out.
        `dropUp` because the footer sits at the bottom of the page
        — a downward dropdown would clip below the fold.
      -->
      <SignInButton dropUp />
    </div>
    <p class="foot-meta">
      <a
        class="foot-ver"
        href={buildReleaseUrl()}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`Carromscore v${APP_VERSION} release notes on GitHub`}
      >v{APP_VERSION}</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      © 2026 Swapnil Deshpande
    </p>
  </div>
</form>

{#if countdownSecs !== null}
  <div class="countdown-overlay" role="dialog" aria-label="Match starting" aria-modal="true">
    <div class="countdown-inner">
      <p class="countdown-label">Get ready!</p>
      <div class="countdown-digit">{countdownSecs}</div>
      <p class="countdown-hint">Match starts in {countdownSecs} second{countdownSecs === 1 ? '' : 's'}</p>
      <button type="button" class="countdown-cancel" onclick={cancelCountdown}>Cancel</button>
    </div>
  </div>
{/if}

<!-- FeedbackPopup owns its own trigger + dialog; see foot-links above. -->

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  .resume-chip {
    max-width: 640px;
    margin: 0.75rem auto 0;
    padding: 0.75rem 1rem;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.45);
    border-radius: 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    box-shadow: 0 2px 12px rgba(255, 179, 0, 0.08);
  }
  .resume-body {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    min-width: 0;
  }
  .resume-icon {
    color: var(--accent, #ffd54a);
    font-size: 1.5rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .abandoned-prompt .resume-icon {
    color: #f0a500;
  }
  .resume-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .resume-text strong {
    color: var(--fg);
    font-size: 0.95rem;
    letter-spacing: 0.01em;
  }
  .resume-sub {
    color: var(--muted);
    font-size: 0.8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .resume-actions {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .resume-btn {
    padding: 0.4rem 0.75rem;
    border-radius: 0.5rem;
    font-weight: 600;
    font-size: 0.8rem;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s, border-color 0.15s, transform 0.1s;
  }
  .resume-btn:active { transform: scale(0.97); }
  .resume-primary {
    background: var(--accent, #ffd54a);
    color: #1a1a1a;
  }
  .resume-primary:hover { filter: brightness(1.08); }
  .resume-secondary {
    background: transparent;
    color: var(--muted);
    border-color: rgba(255, 255, 255, 0.12);
  }
  .resume-secondary:hover {
    color: var(--fg);
    border-color: rgba(255, 255, 255, 0.28);
  }
  @media (max-width: 480px) {
    .resume-chip {
      flex-direction: column;
      align-items: stretch;
      gap: 0.55rem;
    }
    .resume-actions { justify-content: flex-end; }
  }
  fieldset {
    border: none;
    padding: 0;
    margin: 0;
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.5rem;
  }
  @media (min-width: 480px) {
    fieldset { grid-template-columns: 1fr 1fr; }
  }
  @media (min-width: 720px) {
    fieldset { grid-template-columns: repeat(4, 1fr); }
  }
  fieldset.fmt-mode {
    grid-template-columns: 1fr 1fr 1fr;
  }
  @media (min-width: 720px) {
    fieldset.fmt-mode { grid-template-columns: 1fr 1fr 1fr; }
  }
  /* Compact chip-style option: title on one line, meta line beneath.
     No big badge column — was clutter. Selected state uses only the border
     + subtle background lift; radio bullet supplies the "picked" affordance. */
  legend {
    padding: 0;
    margin-bottom: 0.5rem;
    color: var(--fg);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
  }
  fieldset label {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.15rem;
    padding: 0.6rem 0.85rem;
    background: #141414;
    border: 1.5px solid #232323;
    border-radius: 0.6rem;
    cursor: pointer;
    min-height: 3.25rem;
    transition: border-color 0.15s, background 0.15s;
  }
  fieldset label:hover { border-color: #333; }
  fieldset label.selected {
    border-color: var(--accent);
    background: #1a1613;
  }
  fieldset input[type='radio'] {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
    margin: 0;
    pointer-events: none;
  }
  fieldset input[type='radio']:focus-visible + .opt-title {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 0.2rem;
  }
  .opt-title {
    font-weight: 700;
    font-size: 0.95rem;
    color: var(--fg);
    letter-spacing: 0.01em;
  }
  fieldset label.selected .opt-title { color: var(--accent); }
  .opt-meta {
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.02em;
  }

  /* Very narrow phones (≤ 360px): trim padding + text so the three-
     column Mode / Match-rules grids fit without spilling out of the
     container. Label text still wraps if needed. */
  @media (max-width: 480px) {
    /* 4 cols is too tight on phones — collapse to 2×2 */
    fieldset.rules { grid-template-columns: 1fr 1fr; }
    fieldset.rules-practice { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 380px) {
    fieldset label {
      padding: 0.5rem 0.4rem;
      min-height: 3rem;
    }
    .opt-title { font-size: 0.82rem; }
    .opt-meta { font-size: 0.62rem; }
    fieldset.rules label { padding: 0.5rem 0.4rem; }
    fieldset.rules label > span { font-size: 0.62rem; }
    fieldset.rules input[type='number'] { font-size: 0.95rem; }
    legend { font-size: 0.7rem; }
  }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }

  /* Match-rules row: 3 number inputs side by side. Same grid on all screen
     sizes since they're compact numeric fields. */
  fieldset.rules {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap: 0.6rem;
  }
  /* Practice hides Points, so 3 cells → 3-col keeps them wide */
  fieldset.rules-practice {
    grid-template-columns: 1fr 1fr 1fr;
  }
  fieldset.rules label {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    background: #141414;
    border: 1.5px solid #232323;
    border-radius: 0.6rem;
    padding: 0.55rem 0.75rem 0.5rem;
    cursor: default;
    text-align: center;
  }
  fieldset.rules label:focus-within { border-color: var(--accent); }
  fieldset.rules label > span {
    color: var(--fg);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    line-height: 1.2;
    white-space: nowrap;
  }
  .rules-label-hint {
    color: var(--muted);
    font-style: normal;
    font-size: 0.85em;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
  }
  .rules-val-row {
    display: flex;
    align-items: baseline;
    gap: 0.35rem;
    justify-content: center;
    width: 100%;
  }
  fieldset.rules input[type='number'] {
    background: transparent;
    border: none;
    color: var(--fg);
    padding: 0;
    font-size: 1.15rem;
    font-weight: 700;
    font-family: inherit;
    outline: none;
    width: 100%;
    text-align: center;
    line-height: 1.2;
  }
  fieldset.rules.rules-locked label {
    border-color: #2a2a2a;
    opacity: 0.6;
    cursor: not-allowed;
  }
  fieldset.rules.rules-locked input[type='number']:disabled {
    color: var(--muted);
    cursor: not-allowed;
    -webkit-text-fill-color: var(--muted);
  }
  .rules-lock-badge {
    margin-left: 0.4rem;
    font-size: 0.75rem;
    opacity: 0.8;
  }

  /* Locked mode radio labels */
  fieldset.fmt-mode.rules-locked label {
    opacity: 0.6;
    cursor: not-allowed;
    border-color: #2a2a2a;
  }
  fieldset.fmt-mode.rules-locked label:hover { border-color: #2a2a2a; }
  fieldset.fmt-mode.rules-locked label.selected {
    border-color: rgba(255, 213, 74, 0.3);
    background: #1a1613;
    opacity: 0.75;
  }

  /* Locked text / select inputs (picker, note, tournament, round) */
  label.picker-locked,
  label.note-input.picker-locked,
  label.tournament-input.picker-locked {
    opacity: 0.65;
    cursor: not-allowed;
  }
  label.picker-locked input[type='text']:disabled,
  label.note-input.picker-locked input[type='text']:disabled,
  label.tournament-input.picker-locked input[type='text']:disabled {
    color: var(--muted);
    -webkit-text-fill-color: var(--muted);
    cursor: not-allowed;
    border-color: #2a2a2a;
  }
  label.tournament-input.picker-locked .round-select:disabled,
  .round-select:disabled {
    color: var(--muted);
    -webkit-text-fill-color: var(--muted);
    cursor: not-allowed;
    border-color: #2a2a2a;
    opacity: 0.65;
  }
  .rules-hint {
    color: var(--muted);
    font-style: normal;
    font-size: 0.62rem;
    letter-spacing: 0.02em;
    opacity: 0.7;
    line-height: 1;
    white-space: nowrap;
  }
  .hint-inline {
    color: var(--muted);
    font-style: normal;
    font-size: 0.9em;
    text-transform: none;
    letter-spacing: 0;
    opacity: 0.7;
    margin-left: 0.2rem;
  }

  .represents-details {
    margin-top: 0.35rem;
  }
  .represents-summary {
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--muted);
    user-select: none;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: fit-content;
    padding: 0.2rem 0;
  }
  .represents-summary::-webkit-details-marker { display: none; }
  .represents-summary::before {
    content: '▸';
    font-size: 0.8rem;
    transition: transform 0.15s;
  }
  details[open] > .represents-summary::before {
    content: '▾';
  }
  .represents-details[open] .note-input {
    margin-top: 0.4rem;
  }

  .team-block {
    background: #0f0f0f;
    border: 1px solid #222;
    border-radius: 0.75rem;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .team-block h3 {
    margin: 0;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
  }
  /* Doubles: tint each team's block with its scoreboard colour so the
     setup screen previews the on-scoreboard identity. Same
     --side-a / --side-b custom properties the pills use, at low
     alpha so form inputs on top stay readable. Team-A blue, team-B
     coral — order fixed (never swapped) to match the pill positions
     on the scoreboard. */
  .team-block-a {
    background: rgba(79, 195, 247, 0.06);
    border-color: rgba(79, 195, 247, 0.35);
  }
  .team-block-a h3 { color: var(--side-a); }
  .team-block-b {
    background: rgba(255, 138, 101, 0.06);
    border-color: rgba(255, 138, 101, 0.35);
  }
  .team-block-b h3 { color: var(--side-b); }

  label.picker, .note-input, .row3 label, .tournament-input {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    position: relative;
  }
  /* Event group card: wraps Tournament + Round fields */
  .event-block {
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.75rem;
    padding: 0.85rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin: 0.5rem 0 0;
  }

  /* Players group: two side-coloured cards stacked */
  .players-block {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin-top: 0.5rem;
  }
  .player-card {
    border-radius: 0.75rem;
    padding: 0.75rem 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }
  .player-card-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .player-card-a {
    background: rgba(79, 195, 247, 0.06);
    border: 1px solid rgba(79, 195, 247, 0.3);
  }
  .player-card-a .player-card-label { color: var(--side-a, #4fc3f7); }
  .player-card-b {
    background: rgba(255, 138, 101, 0.06);
    border: 1px solid rgba(255, 138, 101, 0.3);
  }
  .player-card-b .player-card-label { color: var(--side-b, #ff8a65); }

  /* Tournament input keeps its own spacing so it feels like a
     high-level context row, distinct from the player rows below. */
  .tournament-input {
    margin: 0;
  }
  .tournament-input .hint-inline {
    color: var(--muted);
    font-style: normal;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.7rem;
    margin-left: 0.3rem;
  }
  label > span {
    color: var(--fg);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  input[type='text'], input[type='number'] {
    background: #141414;
    color: var(--fg);
    border: 1px solid #333;
    border-radius: 0.6rem;
    padding: 0.7rem 0.85rem;
    font-size: 1rem;
    font-family: inherit;
    outline: none;
    width: 100%;
    min-width: 0;
  }
  input[type='text']:focus, input[type='number']:focus { border-color: var(--accent); }

  /* Round <select> (v3.3.6). Matches the tournament input's field
     styling so the two rows read as a matched pair. Native select
     keeps mobile ergonomics — iOS/Android render their own wheel
     picker with big touch targets. */
  .round-select {
    background: #141414;
    color: var(--fg);
    border: 1px solid #333;
    border-radius: 0.6rem;
    padding: 0.7rem 0.85rem;
    font-size: 1rem;
    font-family: inherit;
    outline: none;
    width: 100%;
    min-width: 0;
    appearance: none;
    -webkit-appearance: none;
    /* Chevron drawn via inline SVG data URI so no external asset
       and works in both dark backdrops. */
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path d='M2 4 L6 8 L10 4' fill='none' stroke='%239aa0a6' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/></svg>");
    background-repeat: no-repeat;
    background-position: right 0.85rem center;
    background-size: 0.7rem;
    padding-right: 2rem;
    cursor: pointer;
  }
  .round-select:focus { border-color: var(--accent); }
  .round-select option { background: #141414; color: var(--fg); }

  .suggest {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
    background: #141414;
    border: 1px solid #262626;
    border-radius: 0.6rem;
    max-height: 14rem;
    overflow: auto;
    z-index: 10;
  }
  .suggest button {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.55rem 0.75rem;
    background: transparent;
    border: 0;
    color: var(--fg);
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .suggest button:hover,
  .suggest button.suggest-highlighted { background: #1c1c1c; outline: 2px solid rgba(255, 213, 74, 0.5); outline-offset: -2px; }
  .pname { font-size: 0.95rem; }
  .pmeta { color: var(--muted); font-size: 0.75rem; }
  /* Country pill in the picker dropdown — muted so it doesn't compete
     with the name. Shown only when the PlayerRow carries a country
     (seed + local rosters do; identity-store hits don't yet). */
  .pcountry {
    margin-left: auto;
    color: var(--muted);
    font-size: 0.7rem;
    opacity: 0.85;
  }

  /* "Same as X? Tap to link" chip below a name input, shown only when
     the ranker finds a fuzzy match the user should confirm. */
  .id-chip-suggest {
    display: inline-block;
    margin: 0.35rem 0 0;
    padding: 0.25rem 0.55rem;
    border-radius: 0.5rem;
    font: inherit;
    font-size: 0.78rem;
    line-height: 1.2;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: left;
    color: #ffd54a;
    background: rgba(255, 213, 74, 0.08);
    border: 1px solid rgba(255, 213, 74, 0.35);
    cursor: pointer;
  }
  .id-chip-suggest:hover { background: rgba(255, 213, 74, 0.16); }
  .id-chip-suggest strong { color: #ffd54a; }
  /* Closed-tournament warning pill — advisory only; Start button
     stays enabled. Amber like the offline banner so umpires who've
     seen that recognise this as a "heads up" affordance rather than
     an error. */
  .closed-warn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    margin-top: 0.35rem;
    padding: 0.3rem 0.55rem;
    border-radius: 0.4rem;
    font-size: 0.75rem;
    color: #ffb74d;
    background: rgba(255, 183, 77, 0.08);
    border: 1px solid rgba(255, 183, 77, 0.35);
  }
  .start {
    background: var(--accent);
    color: #0b0b0b;
    font-weight: 800;
    font-size: 1.1rem;
    padding: 1rem;
    border: none;
    border-radius: 999px;
    cursor: pointer;
  }
  .start:disabled { opacity: 0.4; cursor: not-allowed; }

  .hint { color: var(--muted); text-align: center; margin: 0; font-size: 0.85rem; }

  /* Inline duplicate-player warning above the Start button. Uses the
     danger tone so it reads as an error, not a hint — matches the
     disabled Start CTA. */
  .dup-error {
    margin: 0;
    padding: 0.55rem 0.75rem;
    border-radius: 0.5rem;
    background: color-mix(in srgb, var(--danger, #d93a3a) 12%, transparent);
    color: var(--danger, #d93a3a);
    border: 1px solid color-mix(in srgb, var(--danger, #d93a3a) 40%, transparent);
    font-size: 0.9rem;
    text-align: center;
  }

  /* Manual-start duplicate-match warning. Same amber palette as the
     planned-notice-warn block used by the QR completed state. */
  .dup-played-notice {
    margin: 0;
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    background: rgba(255, 179, 0, 0.08);
    border: 1px solid rgba(255, 179, 0, 0.35);
    color: #ffd54a;
    font-size: 0.88rem;
    line-height: 1.5;
  }
  .dup-score {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .install {
    background: transparent;
    color: var(--accent);
    border: 1px solid var(--accent);
    border-radius: 999px;
    padding: 0.7rem 1.25rem;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    align-self: center;
  }
  /*
   * APK-required banner. Reserved for the rare release where the wrapper
   * itself must be reinstalled. Warm amber-red gradient + pulsing dot so
   * it feels distinct from the softer sw-toast that fires on ordinary
   * web-layer updates.
   */
  .update-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 1rem;
    background: linear-gradient(120deg, rgba(255, 143, 0, 0.22), rgba(239, 83, 80, 0.18));
    border: 1px solid #ffb300;
    border-radius: 0.75rem;
    color: var(--fg);
    text-decoration: none;
    box-shadow: 0 0 24px rgba(255, 143, 0, 0.22);
  }
  .update-banner:hover {
    background: linear-gradient(120deg, rgba(255, 143, 0, 0.3), rgba(239, 83, 80, 0.24));
  }
  .upd-dot {
    flex-shrink: 0;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: #ffb300;
    box-shadow: 0 0 0 4px rgba(255, 143, 0, 0.28), 0 0 12px #ffb300;
    animation: upd-pulse 1.6s ease-in-out infinite;
  }
  @keyframes upd-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.75; transform: scale(1.15); }
  }
  .upd-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .upd-title {
    color: #ffb300;
    font-size: 0.95rem;
    letter-spacing: 0.02em;
    font-weight: 800;
  }
  .upd-sub {
    color: var(--muted);
    font-size: 0.8rem;
    letter-spacing: 0.02em;
  }
  .upd-reason {
    color: var(--muted);
    font-size: 0.72rem;
    font-style: italic;
    margin-top: 0.15rem;
  }
  .upd-from, .upd-to {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    font-family: inherit;
    font-weight: 700;
    letter-spacing: 0.04em;
    font-size: 0.75rem;
    vertical-align: baseline;
  }
  .upd-from { background: rgba(255,255,255,0.06); color: var(--muted); }
  .upd-to {
    background: rgba(255, 143, 0, 0.22);
    color: #ffb300;
    border: 1px solid rgba(255, 143, 0, 0.5);
  }
  .upd-arrow { margin: 0 0.3rem; opacity: 0.6; }
  .upd-cta { margin-left: 0.25rem; }

  /*
   * Web-update toast. Soft accent chip, no gradient, no scary red. Fires
   * when the service worker installs a new bundle in the background so
   * the user can tap once to reload into the fresh version. Distinct
   * enough from the APK banner that the user learns "gold pill = harmless
   * refresh, red banner = time to reinstall".
   */
  .sw-toast {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    padding: 0.6rem 0.9rem;
    background: rgba(255, 213, 74, 0.1);
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.65rem;
    color: var(--fg);
    text-align: left;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    line-height: 1.35;
    transition: background 0.15s, border-color 0.15s;
  }
  .sw-toast:hover {
    background: rgba(255, 213, 74, 0.16);
    border-color: rgba(255, 213, 74, 0.55);
  }
  .sw-toast-icon {
    font-size: 1.1rem;
    line-height: 1;
    flex-shrink: 0;
  }
  .sw-toast-body { min-width: 0; }
  .sw-toast-body strong {
    color: var(--accent);
    font-weight: 700;
    margin-right: 0.25rem;
  }

  /*
   * Footer copyright + version pill. Matches the score-screen footer so
   * both screens read as one product. Version chip: soft accent pill,
   * sans-serif, bold — glanceable but doesn't fight the copyright text.
   */
  /* Footer: two rows. Nav on top (thumb-priority), meta below. */
  .foot-nav {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 0.5rem;
    margin: 1rem 0 0.35rem;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  /* Two-row footer wrapper. Row 1 = actionable links (How to use,
     Feedback); row 2 = meta (version + copyright). Keeps both rows
     centred, with the meta row noticeably quieter than the links. */
  .foot-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.35rem;
    margin: 0.5rem 0 0;
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
    /* Anchor override: no default underline; subtle hover-emphasis
       hints that the pill is tappable (opens the release notes on
       GitHub for the current version). */
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
  /* Support link — golden tint (matches the accent palette used
     everywhere else — version pill, BREAK chip, primary buttons).
     Was red initially but red is the "danger" register in this app
     (Close, delete confirmations, lockout toasts); donations aren't
     danger. Golden reads as friendly + matches the rest of the
     visual language. */
  .foot-link-support {
    color: var(--accent);
  }
  .foot-link-support:hover {
    color: var(--accent);
    background: rgba(255, 213, 74, 0.14);
  }

  /* Feedback popup CSS now lives inside FeedbackPopup.svelte (moved
     2026-08-11 when the popup was extracted). MatchSetup previously
     duplicated `.dialog` / `.dialog-card` / `.fb-*` classes here;
     kept only the trigger-link styling via `.foot-link` below. */
  @media (max-width: 520px) {
    fieldset { grid-template-columns: 1fr; }
    fieldset.fmt-mode { grid-template-columns: 1fr 1fr 1fr; }
    .row2 { grid-template-columns: 1fr; }
    .row3 { grid-template-columns: 1fr 1fr; }
  }

  /* Planned-match banners (v3.6) — shown when the setup screen was
     opened via a bracket QR (?planned=<mid>). Same visual family
     as the resume-chip so users recognise it as an actionable
     header rather than a permanent decoration. */
  .planned-notice {
    background: rgba(255, 213, 74, 0.06);
    border: 1px solid rgba(255, 213, 74, 0.35);
    color: var(--fg, #f5f5f5);
    border-radius: 0.6rem;
    padding: 0.85rem 1rem;
    margin: 0.75rem 0;
  }
  .planned-notice h3 {
    margin: 0 0 0.4rem;
    color: var(--accent, #ffd54a);
    font-size: 1rem;
  }
  .planned-notice p { margin: 0.2rem 0; font-size: 0.9rem; line-height: 1.4; }
  .planned-notice-warn {
    background: rgba(239, 83, 80, 0.06);
    border-color: rgba(239, 83, 80, 0.4);
  }
  .planned-notice-warn h3 { color: rgba(239, 83, 80, 0.95); }
  .planned-notice-ok {
    background: rgba(76, 175, 80, 0.06);
    border-color: rgba(76, 175, 80, 0.4);
  }
  .planned-hint { color: var(--muted, #9aa0a6); font-size: 0.82rem; }
  .planned-fresh-btn {
    margin-top: 0.6rem;
    background: none;
    border: none;
    color: var(--muted, #9aa0a6);
    font-size: 0.78rem;
    text-decoration: underline;
    cursor: pointer;
    padding: 0;
    font-family: inherit;
  }
  .planned-fresh-btn:hover { color: var(--fg, #f5f5f5); }
  /* Bracket-scan preview banner — richer than the plain notice; shows
     tournament, round, both sides, and the format the umpire is about
     to start. Wraps on narrow screens (players stack vertically). */
  .planned-preview .planned-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.4rem;
    margin: 0 0 0.35rem;
    font-size: 0.95rem;
  }
  .planned-badge {
    display: inline-block;
    padding: 0.1rem 0.5rem;
    background: rgba(255, 213, 74, 0.14);
    border: 1px solid rgba(255, 213, 74, 0.55);
    color: var(--accent, #ffd54a);
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .planned-sep { color: var(--muted, #9aa0a6); }
  .planned-players {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.4rem;
    margin: 0.25rem 0;
    font-size: 1rem;
  }
  .planned-side { font-weight: 700; }
  .planned-and { color: var(--muted, #9aa0a6); font-weight: 400; }
  .planned-vs {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .planned-format {
    color: var(--muted, #9aa0a6);
    font-size: 0.82rem;
    margin: 0.15rem 0 0.4rem;
  }
  .planned-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.65rem;
    flex-wrap: wrap;
  }
  .planned-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: var(--fg, #f5f5f5);
    padding: 0.45rem 0.9rem;
    border-radius: 0.4rem;
    font: inherit;
    cursor: pointer;
    font-family: inherit;
  }
  .planned-btn:hover { background: rgba(255, 255, 255, 0.06); }
  .planned-btn-primary {
    background: rgba(255, 213, 74, 0.14);
    border-color: rgba(255, 213, 74, 0.55);
    color: var(--accent, #ffd54a);
    font-weight: 700;
  }
  .planned-btn-primary:hover { background: rgba(255, 213, 74, 0.24); }

  /* 10-second "Get ready" countdown overlay */
  .countdown-overlay {
    position: fixed;
    inset: 0;
    z-index: 9000;
    background: rgba(11, 11, 11, 0.97);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .countdown-inner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    text-align: center;
    padding: 2rem;
  }
  .countdown-label {
    font-size: 1.1rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--accent, #ffd54a);
  }
  .countdown-digit {
    font-family: 'DSEG7 Classic', monospace;
    font-size: clamp(6rem, 25vw, 10rem);
    font-weight: 700;
    color: var(--accent, #ffd54a);
    line-height: 1;
    text-shadow: 0 0 40px rgba(255, 213, 74, 0.5);
    animation: countdown-pop 0.25s ease-out;
  }
  @keyframes countdown-pop {
    from { transform: scale(1.25); opacity: 0.5; }
    to   { transform: scale(1);    opacity: 1; }
  }
  .countdown-hint {
    font-size: 0.95rem;
    color: var(--muted, #888);
    letter-spacing: 0.04em;
  }
  .countdown-cancel {
    margin-top: 0.5rem;
    background: transparent;
    border: 1px solid #333;
    color: var(--muted, #888);
    border-radius: 0.4rem;
    padding: 0.4rem 1.2rem;
    font: inherit;
    font-size: 0.85rem;
    cursor: pointer;
    transition: border-color 0.15s, color 0.15s;
  }
  .countdown-cancel:hover { border-color: #666; color: var(--fg, #eee); }
</style>
