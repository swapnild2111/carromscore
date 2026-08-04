<script lang="ts">
  import {
    DEFAULT_CONFIG,
    encodeConfig,
    matchStateKey,
    type MatchConfig,
    type Mode,
    type PlayerRow,
  } from '../lib/match';
  import { APP_VERSION, fetchLatestReleaseTag, isNewerVersion } from '../lib/version';

  const base: string = import.meta.env.BASE_URL;

  let cfg = $state<MatchConfig>({ ...DEFAULT_CONFIG });

  let players = $state<PlayerRow[]>([]);
  let loadingPlayers = $state(true);

  $effect(() => {
    fetch(`${base}data/players.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: PlayerRow[]) => {
        players = rows;
      })
      .catch(() => {
        players = [];
      })
      .finally(() => {
        loadingPlayers = false;
      });
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
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 8);
  }

  // Which picker's suggestions are currently visible (by key).
  let openPicker = $state<string | null>(null);

  function pick(key: keyof MatchConfig, name: string) {
    (cfg[key] as string) = name;
    openPicker = null;
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
  let latestTag = $state<string | null>(null);
  const hasUpdate = $derived(latestTag !== null && isNewerVersion(APP_VERSION, latestTag));
  const releaseUrl = $derived(latestTag
    ? `https://github.com/swapnild2111/carromscore/releases/tag/${latestTag}`
    : 'https://github.com/swapnild2111/carromscore/releases/latest');

  $effect(() => {
    fetchLatestReleaseTag().then((t) => (latestTag = t));
  });
</script>

{#snippet picker(label: string, key: keyof MatchConfig)}
  <label class="picker">
    <span>{label}</span>
    <input
      type="text"
      autocomplete="off"
      placeholder="Type a name…"
      value={cfg[key] as string}
      oninput={(e) => ((cfg[key] as string) = (e.currentTarget as HTMLInputElement).value)}
      onfocus={() => (openPicker = key)}
      onblur={() => setTimeout(() => { if (openPicker === key) openPicker = null; }, 200)}
    />
    {#if openPicker === key && suggest(cfg[key] as string).length > 0}
      <ul class="suggest">
        {#each suggest(cfg[key] as string) as p (p.name + p.source)}
          <li>
            <button type="button" onclick={() => pick(key, p.name)}>
              <span class="pname">{p.name}</span>
            </button>
          </li>
        {/each}
      </ul>
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

  {#if hasUpdate}
    <a class="update-banner" href={releaseUrl} target="_blank" rel="noopener">
      <span class="upd-dot" aria-hidden="true"></span>
      <span class="upd-body">
        <strong class="upd-title">New version available</strong>
        <span class="upd-sub">
          <span class="upd-from">v{APP_VERSION}</span>
          <span class="upd-arrow" aria-hidden="true">→</span>
          <span class="upd-to">{latestTag}</span>
          <span class="upd-cta">· Tap to download the new APK</span>
        </span>
      </span>
    </a>
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
  </p>
</form>

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
   * Update-available banner. Amber gold gradient with a soft pulsing dot
   * on the left so it catches the eye. Rows: title on top, version delta
   * on the bottom.
   */
  .update-banner {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.8rem 1rem;
    background: linear-gradient(120deg, rgba(255, 213, 74, 0.18), rgba(255, 143, 0, 0.12));
    border: 1px solid var(--accent);
    border-radius: 0.75rem;
    color: var(--fg);
    text-decoration: none;
    box-shadow: 0 0 24px rgba(255, 213, 74, 0.15);
  }
  .update-banner:hover { background: linear-gradient(120deg, rgba(255, 213, 74, 0.25), rgba(255, 143, 0, 0.18)); }
  .upd-dot {
    flex-shrink: 0;
    width: 0.75rem;
    height: 0.75rem;
    border-radius: 999px;
    background: var(--accent);
    box-shadow: 0 0 0 4px rgba(255, 213, 74, 0.25), 0 0 12px var(--accent);
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
    color: var(--accent);
    font-size: 0.95rem;
    letter-spacing: 0.02em;
    font-weight: 800;
  }
  .upd-sub {
    color: var(--muted);
    font-size: 0.8rem;
    letter-spacing: 0.02em;
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
  .upd-to { background: rgba(255, 213, 74, 0.2); color: var(--accent); border: 1px solid rgba(255, 213, 74, 0.4); }
  .upd-arrow { margin: 0 0.3rem; opacity: 0.6; }
  .upd-cta { margin-left: 0.25rem; }

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

  @media (max-width: 520px) {
    fieldset { grid-template-columns: 1fr; }
    fieldset.fmt-mode { grid-template-columns: 1fr 1fr 1fr; }
    .row2 { grid-template-columns: 1fr; }
    .row3 { grid-template-columns: 1fr 1fr; }
    .player-row { grid-template-columns: 1fr; }
  }
</style>
