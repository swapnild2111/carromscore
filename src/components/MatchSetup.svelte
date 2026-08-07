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
    APP_VERSION,
    fetchLatestRelease,
    isNewerVersion,
    type ReleaseInfo,
  } from '../lib/version';

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

  function setMode(m: Mode) {
    const wasPractice = cfg.mode === 'practice';
    cfg.mode = m;
    if (m === 'singles') {
      cfg.playerA2 = '';
      cfg.playerB2 = '';
      // Restore match-shape defaults if we're coming back from Practice.
      if (wasPractice) {
        cfg.bestOf = 3;
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
      cfg.bestOf = 3;
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
    try {
      localStorage.removeItem(matchStateKey(cfg.mode, cfg.playerA, cfg.playerB));
    } catch {
      // ignore
    }
    // Remember these names in the per-device roster so the picker
    // autocompletes them next time. Practice mode contributes only
    // playerA; Doubles contributes all four.
    rememberPlayers(cfg.playerA, cfg.playerA2, cfg.playerB, cfg.playerB2);
    window.location.href = `${base}score/?${encodeConfig(cfg)}`;
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

  /*
   * Feedback popup. We don't rely on `mailto:` alone because many
   * modern browsers (especially on desktop) have no default mail app
   * registered and silently no-op the click. Instead we show a small
   * dialog with the address visible, a Copy button, a "Compose in
   * Gmail (web)" link (works in any browser), and — for people who DO
   * have a mail app configured — a plain mailto link.
   *
   * The address is assembled at click time from three fragments so
   * naive HTML-scraping bots (which don't run JS) can't harvest it
   * from the deployed bundle. Sophisticated scrapers can still find
   * it — this is a mitigation, not a barrier.
   */
  let showFeedbackPopup = $state(false);
  let feedbackCopied = $state(false);
  let feedbackCopiedTimer: number | null = null;

  const feedbackEmail = 'swapnild2111' + '@' + 'gmail.com';
  const feedbackSubject = $derived(`Carromscore v${APP_VERSION} feedback`);
  const feedbackMailto = $derived(
    `mailto:${feedbackEmail}?subject=${encodeURIComponent(feedbackSubject)}`,
  );
  const feedbackGmailWeb = $derived(
    `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(feedbackEmail)}&su=${encodeURIComponent(feedbackSubject)}`,
  );
  // Public GitHub Discussion, pre-filled title/body so the thread lands
  // in the "General" category with a version-tagged title. Users can
  // still edit both before submitting.
  const feedbackDiscussionUrl = $derived(
    `https://github.com/swapnild2111/carromscore/discussions/new?category=general&title=${encodeURIComponent(`Carromscore v${APP_VERSION} — `)}&body=${encodeURIComponent(`Running Carromscore v${APP_VERSION}.\n\n<!-- Add your question / idea / observation here -->\n`)}`,
  );

  function openFeedback(e: Event) {
    e.preventDefault();
    showFeedbackPopup = true;
  }
  async function copyFeedbackEmail() {
    try {
      await navigator.clipboard.writeText(feedbackEmail);
    } catch {
      const el = document.createElement('input');
      el.value = feedbackEmail;
      document.body.appendChild(el);
      el.select();
      try { document.execCommand('copy'); } catch { /* silent */ }
      el.remove();
    }
    feedbackCopied = true;
    if (feedbackCopiedTimer !== null) clearTimeout(feedbackCopiedTimer);
    feedbackCopiedTimer = window.setTimeout(() => { feedbackCopied = false; }, 1500);
  }
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


<form class="setup" onsubmit={start}>
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
        {cfg.mode === 'practice' ? 'Boards per set' : 'Max boards'}
        {#if cfg.mode !== 'practice'}<em class="hint-inline">(0 = ∞)</em>{/if}
      </span>
      <input type="number" min={cfg.mode === 'practice' ? 1 : 0} step="1" bind:value={cfg.maxBoards} />
    </label>
  </fieldset>

  <fieldset class="fmt fmt-mode">
    <legend>Mode</legend>
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
    <div class="team-block">
      <h3>Team A</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerA')}
        {@render picker('Player 2', 'playerA2')}
      </div>
      {@render noteInput('Team A represents', 'noteA')}
    </div>
    <div class="team-block">
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

  <p class="version-line">
    © 2026 Swapnil Deshpande
    <span class="hint-sep" aria-hidden="true">·</span>
    <span class="hint-ver">v{APP_VERSION}</span>
    <span class="hint-sep" aria-hidden="true">·</span>
    <a
      href="#feedback"
      class="feedback-link"
      onclick={openFeedback}
      aria-label="Send feedback about Carromscore"
    >Feedback ⇗</a>
  </p>
</form>

{#if showFeedbackPopup}
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="fb-title">
    <div class="dialog-card fb-card">
      <h2 id="fb-title">Send feedback</h2>
      <p class="fb-intro">
        Bug reports, feature ideas, or "hey I use this at my club" — all
        welcome. Version {APP_VERSION} will be included in the subject.
      </p>

      <div class="fb-email-row">
        <input
          type="text"
          readonly
          value={feedbackEmail}
          class="fb-email"
          aria-label="Feedback email address"
          onclick={(e) => (e.currentTarget as HTMLInputElement).select()}
        />
        <button type="button" class="fb-copy" onclick={copyFeedbackEmail}>
          {feedbackCopied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div class="fb-actions">
        <a
          href={feedbackGmailWeb}
          target="_blank"
          rel="noopener"
          class="fb-btn fb-btn-primary"
        >Open in Gmail</a>
        <a
          href={feedbackMailto}
          class="fb-btn fb-btn-secondary"
        >Use my mail app</a>
      </div>

      <p class="fb-alt">
        Prefer a public thread?
        <a href={feedbackDiscussionUrl} target="_blank" rel="noopener">
          Start a GitHub Discussion
        </a>.
      </p>

      <div class="dialog-actions">
        <button class="cancel" onclick={() => (showFeedbackPopup = false)}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .setup {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
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
    color: var(--muted);
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
    color: var(--muted);
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

  label.picker, .note-input, .row3 label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    position: relative;
  }
  label > span {
    color: var(--muted);
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
  .version-line {
    text-align: center;
    color: var(--muted);
    font-size: 0.75rem;
    margin: 0;
    letter-spacing: 0.02em;
  }
  .hint-sep { opacity: 0.4; margin: 0 0.3rem; }
  .hint-ver {
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
    vertical-align: baseline;
  }
  .feedback-link {
    color: var(--muted);
    text-decoration: none;
    border-bottom: 1px dotted rgba(255,255,255,0.35);
    transition: color 0.15s, border-color 0.15s;
  }
  .feedback-link:hover {
    color: var(--accent);
    border-bottom-color: var(--accent);
  }

  /*
   * Feedback popup. Same base .dialog + .dialog-card shape as the score
   * screen's confirmations so both screens read as one product.
   * Duplicated here (rather than shared) because Svelte scopes styles
   * per-component and MatchSetup didn't previously need dialog styles.
   */
  .dialog {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }
  .dialog-card {
    background: #141414;
    border: 2px solid var(--accent);
    border-radius: 1rem;
    padding: 1.25rem;
    max-width: 24rem;
    width: 100%;
    text-align: center;
  }
  .dialog-card h2 {
    margin: 0 0 0.5rem;
    font-size: 1.2rem;
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .fb-intro {
    color: var(--muted);
    font-size: 0.85rem;
    line-height: 1.4;
    margin: 0 0 1rem;
    text-align: left;
  }
  .fb-email-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .fb-email {
    flex: 1;
    min-width: 0;
    padding: 0.5rem 0.7rem;
    background: #0b0b0b;
    border: 1px solid #2a2a2a;
    border-radius: 0.5rem;
    color: var(--fg);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 0.85rem;
  }
  .fb-email:focus { outline: none; border-color: var(--accent); }
  .fb-copy {
    flex-shrink: 0;
    padding: 0.5rem 0.9rem;
    background: var(--accent);
    color: #0b0b0b;
    border: none;
    border-radius: 0.5rem;
    font-family: inherit;
    font-weight: 800;
    font-size: 0.85rem;
    cursor: pointer;
    transition: filter 0.1s;
  }
  .fb-copy:hover { filter: brightness(1.1); }

  .fb-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-bottom: 0.85rem;
  }
  .fb-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.6rem 0.85rem;
    border-radius: 0.5rem;
    font-family: inherit;
    font-weight: 800;
    font-size: 0.85rem;
    letter-spacing: 0.02em;
    text-decoration: none;
    text-align: center;
    line-height: 1.2;
    transition: background 0.1s, border-color 0.15s;
  }
  .fb-btn-primary {
    background: var(--accent);
    color: #0b0b0b;
    border: 1px solid var(--accent);
  }
  .fb-btn-primary:hover { filter: brightness(1.1); }
  .fb-btn-secondary {
    background: transparent;
    color: var(--fg);
    border: 1px solid #333;
  }
  .fb-btn-secondary:hover { border-color: var(--accent); color: var(--accent); }

  .fb-alt {
    color: var(--muted);
    font-size: 0.78rem;
    margin: 0 0 0.85rem;
    line-height: 1.4;
  }
  .fb-alt a { color: var(--accent); }
  .fb-alt a:hover { text-decoration: underline; }

  .dialog-actions { display: flex; gap: 0.5rem; }
  .dialog-actions .cancel {
    flex: 1;
    padding: 0.6rem 1rem;
    font-weight: 700;
    font-size: 0.95rem;
    border-radius: 999px;
    background: #1f1f1f;
    color: var(--fg);
    border: 1px solid #333;
    cursor: pointer;
    font-family: inherit;
  }

  @media (max-width: 520px) {
    fieldset { grid-template-columns: 1fr; }
    fieldset.fmt-mode { grid-template-columns: 1fr 1fr 1fr; }
    .row2 { grid-template-columns: 1fr; }
    .row3 { grid-template-columns: 1fr 1fr; }
    .player-row { grid-template-columns: 1fr; }
  }
</style>
