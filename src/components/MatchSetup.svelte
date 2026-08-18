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
    seedFromRows as seedPlayerIdentity,
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
  import { newMid, subscribeLive, type LiveRecord } from '../lib/live-sync';
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
  import FeedbackPopup from './FeedbackPopup.svelte';
  import HelpTip from './HelpTip.svelte';
  import { countryName, flagEmoji } from '../lib/countries';

  const base: string = import.meta.env.BASE_URL;

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });

  // Bundled seed from public/data/players.json (small, Wikipedia-sourced).
  let seedPlayers = $state<PlayerRow[]>([]);
  // Per-device roster grown from past match setups. Merged with the seed at
  // render time so the picker gets more useful the more matches a user plays.
  let localPlayers = $state<PlayerRow[]>([]);
  let loadingPlayers = $state(true);

  const players = $derived<PlayerRow[]>(() => {
    // Read the identityTick so this recomputes when the /players
    // Firebase-backed store changes (admin adds a player etc.).
    void identityTick;
    // Concatenate seed + local + identity-store, then dedupe by
    // case-insensitive name. Identity-store rows are shaped as
    // PlayerRow with source: 'identity' + their stored country so
    // the picker shows the flag pill on Firebase-backed players too.
    const identityRows: PlayerRow[] = loadAllPlayers().map((p) => ({
      name: p.canonicalName,
      source: 'identity',
      ...(p.country ? { country: p.country } : {}),
    }));
    // Merge-dedupe. Identity-store rows key by (name + country) so
    // legitimate namesakes from different countries stay as separate
    // picker rows (e.g. Swapnil Deshpande from DK vs SE). Seed/local
    // rows key by name only — those layers have no country column, so
    // a country-less "Swapnil Deshpande" gets folded into whichever
    // identity row shares the name AND has a country. Sources are
    // walked in order [seed, local, identity]: earlier rows win on
    // display shape, later rows fill in missing country info.
    const byKey = new Map<string, PlayerRow>();
    // Pass 1: seed + local, keyed by name only (they can't distinguish
    // namesakes anyway).
    for (const p of [...seedPlayers, ...localPlayers]) {
      const key = `n:${p.name.toLowerCase()}`;
      if (!byKey.has(key)) byKey.set(key, p);
    }
    // Pass 2: identity rows. Each identity row is unique on
    // (name, country) — that's how the admin creates namesake records.
    // Fold country-less name matches from pass 1 into the identity row
    // when there's exactly one; otherwise leave both.
    for (const p of identityRows) {
      const nameKey = `n:${p.name.toLowerCase()}`;
      const idKey = `i:${p.name.toLowerCase()}|${(p.country ?? '').toLowerCase()}`;
      const priorByName = byKey.get(nameKey);
      if (priorByName && !priorByName.country) {
        // Upgrade the country-less local/seed row to carry the
        // identity row's country, and re-key it under the id-scoped
        // key so a second same-named identity row (different country)
        // lands next to it instead of overwriting.
        byKey.delete(nameKey);
        byKey.set(idKey, { ...priorByName, country: p.country });
        continue;
      }
      if (!byKey.has(idKey)) byKey.set(idKey, p);
    }
    return Array.from(byKey.values());
  });

  $effect(() => {
    // Load local roster first — always cheap, never fails hard.
    localPlayers = loadKnownPlayers();
    fetch(`${base}data/players.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: PlayerRow[]) => {
        seedPlayers = rows;
        // Feed the same seed into the identity store so the fuzzy-match
        // ranker has something to work with even before Firebase syncs.
        seedPlayerIdentity(rows);
      })
      .catch(() => {
        seedPlayers = [];
      })
      .finally(() => {
        loadingPlayers = false;
      });
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
  function tournamentSuggestions(q: string): Tournament[] {
    // Read the tick so Svelte re-derives on remote updates.
    void tournamentTick;
    return rankTournaments(q, 8);
  }
  function pickTournament(name: string): void {
    cfg.tournament = name;
    showTournamentPicker = false;
    // Reset the round tag whenever the tournament changes — a round
    // is scoped to a specific tournament (its slug), so carrying the
    // old round string into a new tournament would archive a
    // round/roundKey pair that doesn't exist under the new parent.
    cfg.round = '';
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
  let showRoundPicker = $state(false);
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
  function roundSuggestions(q: string): Round[] {
    void tournamentTick;
    const key = currentTournamentKey();
    return key ? rankRounds(key, q, 8) : [];
  }
  function pickRound(name: string): void {
    cfg.round = name;
    showRoundPicker = false;
  }

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
    if (!resolvedId) {
      return 'Not in the roster — closed tournament expects assigned players';
    }
    if (!assignedPlayerIds.has(resolvedId)) {
      return 'Not assigned to this tournament';
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

  let canStart = $derived(() => {
    const a1 = cfg.playerA.trim().length > 0;
    if (cfg.mode === 'practice') {
      // Solo drill: one player is enough. Also need a real per-set board count
      // so the score grid has a shape — reject 0 (unlimited) here.
      return a1 && cfg.maxBoards > 0;
    }
    const b1 = cfg.playerB.trim().length > 0;
    if (cfg.mode === 'singles') return a1 && b1 && !dupError;
    return (
      a1 &&
      b1 &&
      cfg.playerA2.trim().length > 0 &&
      cfg.playerB2.trim().length > 0 &&
      !dupError
    );
  });

  function start(e: Event) {
    e.preventDefault();
    if (!canStart()) return;
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
    const aCountry = cfg.mode === 'singles' ? resolvedPlayerCountries.playerA : '';
    const bCountry = cfg.mode === 'singles' ? resolvedPlayerCountries.playerB : '';
    saveMatchIdentity(key, {
      aResolvedId: resolvedPlayerIds.playerA,
      a2ResolvedId: resolvedPlayerIds.playerA2,
      bResolvedId: resolvedPlayerIds.playerB,
      b2ResolvedId: resolvedPlayerIds.playerB2,
      ...(aCountry ? { aCountry } : {}),
      ...(bCountry ? { bCountry } : {}),
    });
    saveMatchStart(key, Date.now());
    // Remember these names in the per-device roster so the picker
    // autocompletes them next time. Practice mode contributes only
    // playerA; Doubles contributes all four.
    rememberPlayers(cfg.playerA, cfg.playerA2, cfg.playerB, cfg.playerB2);
    // Remember this match so a mistakenly-closed /score/ tab can be
    // resumed from Home. Cleared on End paths in ScoreBoard.
    const scoreUrl = `${base}score/?${encodeConfig(cfg)}`;
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
    window.location.href = scoreUrl;
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

  function restartApp() {
    // Bypass the SW cache for the reload — we want the freshest HTML shell.
    window.location.reload();
  }

  // Feedback popup extracted to a shared component so the lobby
  // footer can render the same UX without duplicating state.
  // See src/components/FeedbackPopup.svelte.
</script>

{#snippet picker(label: string, key: keyof MatchConfig)}
  {@const typed = (cfg[key] as string)}
  {@const suggestions = suggest(typed)}
  {@const dropdownVisible = openPicker === key && suggestions.length > 0}
  {@const hit = topHit(typed)}
  <label class="picker">
    <span>{label}</span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Type a name…"
      value={typed}
      oninput={(e) => onNameInput(key, (e.currentTarget as HTMLInputElement).value)}
      onfocus={() => (openPicker = key)}
      onblur={() => setTimeout(() => { if (openPicker === key) openPicker = null; }, 200)}
    />
    {#if dropdownVisible}
      <ul class="suggest">
        {#each suggestions as p (p.name + '|' + p.source + '|' + (p.country ?? ''))}
          <li>
            <button type="button" onclick={() => pick(key, p)}>
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

{#snippet noteInput(label: string, key: 'noteA' | 'noteB')}
  <label class="note-input">
    <span>{label}</span>
    <input
      type="text"
      autocomplete="off"
      maxlength="24"
      placeholder="Country, state, club…"
      value={cfg[key]}
      oninput={(e) => (cfg[key] = (e.currentTarget as HTMLInputElement).value)}
    />
  </label>
{/snippet}


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
  <fieldset class="fmt fmt-mode">
    <legend>
      Mode
      <HelpTip label="Help: match mode">
        <strong>Singles</strong> — one player per side.<br/>
        <strong>Doubles</strong> — two players per side (2v2).<br/>
        <strong>Practice</strong> — solo drill; tracks boards + misses only, no opponent.
      </HelpTip>
    </legend>
    <label class:selected={cfg.mode === 'singles'}>
      <input type="radio" name="mode" value="singles" checked={cfg.mode === 'singles'} onchange={() => setMode('singles')} />
      <span class="opt-title">Singles</span>
      <span class="opt-meta">1 vs 1</span>
    </label>
    <label class:selected={cfg.mode === 'doubles'}>
      <input type="radio" name="mode" value="doubles" checked={cfg.mode === 'doubles'} onchange={() => setMode('doubles')} />
      <span class="opt-title">Doubles</span>
      <span class="opt-meta">2 vs 2</span>
    </label>
    <label class:selected={cfg.mode === 'practice'}>
      <input type="radio" name="mode" value="practice" checked={cfg.mode === 'practice'} onchange={() => setMode('practice')} />
      <span class="opt-title">Practice</span>
      <span class="opt-meta">Solo drill</span>
    </label>
  </fieldset>

  <fieldset class="rules" class:rules-practice={cfg.mode === 'practice'}>
    <legend>Match rules</legend>
    <label>
      <span>Sets</span>
      <input type="number" min="1" max="9" step="1" bind:value={cfg.bestOf} />
    </label>
    {#if cfg.mode !== 'practice'}
      <label>
        <span>Points</span>
        <input type="number" min="1" step="1" bind:value={cfg.pointsTarget} />
      </label>
    {/if}
    <label>
      <span>
        {cfg.mode === 'practice' ? 'Boards per set' : 'Boards'}
        {#if cfg.mode !== 'practice'}<em class="hint-inline">(0 = ∞)</em>{/if}
      </span>
      <input type="number" min={cfg.mode === 'practice' ? 1 : 0} step="1" bind:value={cfg.maxBoards} />
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
  <label class="tournament-input">
    <span>
      Tournament <em class="hint-inline">(optional)</em>
      <HelpTip label="Help: tournament">
        Groups this match with others of the same event name in the Lobby. Leave blank for casual play (matches show under <strong>Default</strong>). Type an existing tournament name to reuse it, or type a new one to create it.
      </HelpTip>
    </span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Event name — Silver Cup 2026, Sunday Club Night, …"
      value={cfg.tournament}
      oninput={(e) => {
        const nextValue = (e.currentTarget as HTMLInputElement).value;
        // Clear the round tag whenever the tournament identity might
        // change (either the raw text or the resolved key). A round is
        // scoped to a specific tournament — carrying an old round
        // string into a new one would archive a mismatched pair.
        const prevKey = normalizeKey(cfg.tournament.trim());
        const nextKey = normalizeKey(nextValue.trim());
        if (prevKey !== nextKey) cfg.round = '';
        cfg.tournament = nextValue;
      }}
      onfocus={() => (showTournamentPicker = true)}
      onblur={() => setTimeout(() => (showTournamentPicker = false), 200)}
      maxlength="60"
    />
    {#if showTournamentPicker}
      {@const suggestions = tournamentSuggestions(cfg.tournament)}
      {#if suggestions.length > 0}
        <ul class="suggest">
          {#each suggestions as t (t.key)}
            <li>
              <button type="button" onclick={() => pickTournament(t.name)}>
                <span class="pname">{t.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </label>

  <!--
    Round picker (v3.2). Only shown when the resolved tournament
    carries at least one round. Free-text with dropdown suggestions
    ranked over the tournament's open rounds; closed rounds are
    filtered out at the rankRounds source so the umpire can't
    accidentally add a match to a stage the organiser has closed.
    Missing rounds field on a legacy tournament → dropdown is empty
    → the whole picker hides.
  -->
  {#if currentTournamentRounds().length > 0}
  <label class="tournament-input">
    <span>
      Round <em class="hint-inline">(optional)</em>
      <HelpTip label="Help: round">
        Which stage of the tournament this match belongs to — Round of 16, Quarter-finals, Semi-finals, Final, etc. Rounds are set up per tournament by the organiser. Leave blank if the tournament doesn't have named stages.
      </HelpTip>
    </span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Round of 16, Quarter-finals, …"
      value={cfg.round}
      oninput={(e) => (cfg.round = (e.currentTarget as HTMLInputElement).value)}
      onfocus={() => (showRoundPicker = true)}
      onblur={() => setTimeout(() => (showRoundPicker = false), 200)}
      maxlength="60"
    />
    {#if showRoundPicker}
      {@const rSuggestions = roundSuggestions(cfg.round)}
      {#if rSuggestions.length > 0}
        <ul class="suggest">
          {#each rSuggestions as r (r.key)}
            <li>
              <button type="button" onclick={() => pickRound(r.name)}>
                <span class="pname">{r.name}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </label>
  {/if}
  {/if}

  {#if cfg.mode === 'singles'}
    <div class="player-row">
      {@render picker('Player A', 'playerA')}
      {@render noteInput('Represents', 'noteA')}
    </div>
    <div class="player-row">
      {@render picker('Player B', 'playerB')}
      {@render noteInput('Represents', 'noteB')}
    </div>
  {:else if cfg.mode === 'practice'}
    <div class="player-row">
      {@render picker('Player', 'playerA')}
      {@render noteInput('Represents', 'noteA')}
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
        {@render picker('Player 1', 'playerA')}
        {@render picker('Player 2', 'playerA2')}
      </div>
      {@render noteInput('Team A represents', 'noteA')}
    </div>
    <div class="team-block team-block-b">
      <h3>Team B</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerB')}
        {@render picker('Player 2', 'playerB2')}
      </div>
      {@render noteInput('Team B represents', 'noteB')}
    </div>
  {/if}

  {#if dupError}
    <p class="dup-error" role="alert">{dupError}</p>
  {/if}

  <button class="start" type="submit" disabled={!canStart()}>
    Start match →
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
      <a
        href={`${base}help/`}
        class="foot-link"
        aria-label="How to use Carromscore"
      >How to use ⇗</a>
      <span class="foot-sep" aria-hidden="true">·</span>
      <FeedbackPopup />
      <span class="foot-sep" aria-hidden="true">·</span>
      <!--
        Support link. Opens the Ko-fi donation page in a new tab.
        Ko-fi accepts card + PayPal + Apple Pay + Google Pay; the
        repo's Sponsor button (github.com/sponsors/…) is the other
        channel for donors who prefer GitHub-native. Both funnel to
        the same maintainer bank account. Kept muted so it never
        competes with primary actions on the page.
      -->
      <a
        href="https://ko-fi.com/carromscore"
        target="_blank"
        rel="noopener noreferrer"
        class="foot-link foot-link-support"
        aria-label="Support Carromscore on Ko-fi"
      >Support ❤</a>
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
  fieldset input[type='radio'] { display: none; }
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
  @media (max-width: 380px) {
    fieldset label {
      padding: 0.5rem 0.4rem;
      min-height: 3rem;
    }
    .opt-title { font-size: 0.82rem; }
    .opt-meta { font-size: 0.62rem; }
    fieldset.rules label { padding: 0.5rem 0.55rem; }
    fieldset.rules label > span { font-size: 0.62rem; }
    fieldset.rules input[type='number'] { font-size: 1rem; }
    legend { font-size: 0.7rem; }
  }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }

  /* Match-rules row: 3 number inputs side by side. Same grid on all screen
     sizes since they're compact numeric fields. */
  fieldset.rules {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.6rem;
  }
  fieldset.rules-practice {
    grid-template-columns: 1fr 1fr;
  }
  fieldset.rules label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    background: #141414;
    border: 1.5px solid #232323;
    border-radius: 0.6rem;
    padding: 0.55rem 0.85rem;
    cursor: default;
  }
  fieldset.rules label:focus-within { border-color: var(--accent); }
  fieldset.rules label > span {
    color: var(--fg);
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  fieldset.rules input[type='number'] {
    background: transparent;
    border: none;
    color: var(--fg);
    padding: 0;
    font-size: 1.1rem;
    font-weight: 600;
    font-family: inherit;
    outline: none;
    width: 100%;
    min-width: 0;
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

  /* Singles: player-row pairs a name picker with a shorter note field.
     Note gets ~40% width so it stays clearly secondary to the name. */
  .player-row {
    display: grid;
    grid-template-columns: 3fr 2fr;
    gap: 0.6rem;
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
  /* Tournament input keeps its own spacing so it feels like a
     high-level context row, distinct from the player rows below. */
  .tournament-input {
    margin: 0.5rem 0 0;
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
  .suggest button:hover { background: #1c1c1c; }
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
    .player-row { grid-template-columns: 1fr; }
  }
</style>
