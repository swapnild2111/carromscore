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
    createOrTouchTournament,
    rankTournaments,
    subscribeStore as subscribeTournamentsStore,
    subscribeTournaments,
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

  const base: string = import.meta.env.BASE_URL;

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });

  // Bundled seed from public/data/players.json (small, Wikipedia-sourced).
  let seedPlayers = $state<PlayerRow[]>([]);
  // Per-device roster grown from past match setups. Merged with the seed at
  // render time so the picker gets more useful the more matches a user plays.
  let localPlayers = $state<PlayerRow[]>([]);
  let loadingPlayers = $state(true);

  const players = $derived<PlayerRow[]>(() => {
    // Concatenate seed + local, then dedupe by case-insensitive name.
    const seen = new Set<string>();
    const out: PlayerRow[] = [];
    for (const p of [...seedPlayers, ...localPlayers]) {
      const key = p.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
    return out;
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
    const q = text.trim();
    if (!q) return null;
    const hits = rankMatches(loadAllPlayers(), q, 1);
    const h = hits[0];
    if (!h) return null;
    if (h.rank === 'prefix') return null;
    return h;
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
    } else {
      resolvedPlayerIds[key as string] = null;
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
  }

  function pick(key: keyof MatchConfig, row: PlayerRow) {
    (cfg[key] as string) = row.name;
    openPicker = null;
    // If the picked row corresponds to an identity-store player, resolve
    // to that id. Otherwise clear — a new player record will be created
    // when the match ends.
    const q = row.name.trim();
    const hits = rankMatches(loadAllPlayers(), q, 1);
    const h = hits[0];
    resolvedPlayerIds[key as string] = h && h.rank === 'exact' ? h.player.id : null;
  }

  let canStart = $derived(() => {
    const a1 = cfg.playerA.trim().length > 0;
    if (cfg.mode === 'practice') {
      // Solo drill: one player is enough. Also need a real per-set board count
      // so the score grid has a shape — reject 0 (unlimited) here.
      return a1 && cfg.maxBoards > 0;
    }
    const b1 = cfg.playerB.trim().length > 0;
    if (cfg.mode === 'singles') return a1 && b1;
    return a1 && b1 && cfg.playerA2.trim().length > 0 && cfg.playerB2.trim().length > 0;
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
    // and register the tournament (create-if-new bumps lastActive).
    if (cfg.mode === 'practice') {
      cfg.tournament = '';
    } else {
      const trimmed = cfg.tournament.trim();
      cfg.tournament = trimmed;
      if (trimmed) {
        createOrTouchTournament(trimmed);
      }
    }
    // Clear any stale identity handoff from a previous match with these
    // same names, then persist the fresh resolutions + start timestamp
    // so the score screen can pass them into finishMatch() on End.
    clearMatchIdentity(key);
    saveMatchIdentity(key, {
      aResolvedId: resolvedPlayerIds.playerA,
      a2ResolvedId: resolvedPlayerIds.playerA2,
      bResolvedId: resolvedPlayerIds.playerB,
      b2ResolvedId: resolvedPlayerIds.playerB2,
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
        {#each suggestions as p (p.name + p.source)}
          <li>
            <button type="button" onclick={() => pick(key, p)}>
              <span class="pname">{p.name}</span>
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
      oninput={(e) => (cfg.tournament = (e.currentTarget as HTMLInputElement).value)}
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
    flex-direction: column;
    align-items: flex-start;
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
