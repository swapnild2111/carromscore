<script lang="ts">
  import {
    DEFAULT_CONFIG,
    encodeConfig,
    formatPreset,
    type Format,
    type MatchConfig,
    type Mode,
    type PlayerRow,
  } from '../lib/match';

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

  function setFormat(f: Format) {
    cfg.format = f;
    Object.assign(cfg, formatPreset(f));
  }

  function setMode(m: Mode) {
    cfg.mode = m;
    if (m === 'singles') {
      cfg.playerA2 = '';
      cfg.playerB2 = '';
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
    const b1 = cfg.playerB.trim().length > 0;
    if (cfg.mode === 'singles') return a1 && b1;
    return a1 && b1 && cfg.playerA2.trim().length > 0 && cfg.playerB2.trim().length > 0;
  });

  function start(e: Event) {
    e.preventDefault();
    if (!canStart()) return;
    window.location.href = `${base}score/?${encodeConfig(cfg)}`;
  }

  function toggleTimeLimit(on: boolean) {
    cfg.minutesPerSet = on ? 20 : null;
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
    return () => window.removeEventListener('beforeinstallprompt', onBIP);
  });

  async function install() {
    if (!installEvt) return;
    await installEvt.prompt();
    installEvt = null;
  }
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
              {#if p.city || p.country}
                <span class="pmeta">{[p.city, p.country].filter(Boolean).join(' · ')}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </label>
{/snippet}

<form class="setup" onsubmit={start}>
  <fieldset class="fmt">
    <legend>Match format</legend>
    <label class:selected={cfg.format === 'india'}>
      <input type="radio" name="format" value="india" checked={cfg.format === 'india'} onchange={() => setFormat('india')} />
      <div>
        <strong>Best of 3 sets</strong>
        <small>25 pts · 8 boards per set</small>
      </div>
    </label>
    <label class:selected={cfg.format === 'europe'}>
      <input type="radio" name="format" value="europe" checked={cfg.format === 'europe'} onchange={() => setFormat('europe')} />
      <div>
        <strong>Single set</strong>
        <small>25 pts · 8 boards</small>
      </div>
    </label>
    <label class:selected={cfg.format === 'custom'}>
      <input type="radio" name="format" value="custom" checked={cfg.format === 'custom'} onchange={() => setFormat('custom')} />
      <div>
        <strong>Custom</strong>
        <small>Set your own limits</small>
      </div>
    </label>
  </fieldset>

  <fieldset class="fmt fmt-mode">
    <legend>Mode</legend>
    <label class:selected={cfg.mode === 'singles'}>
      <input type="radio" name="mode" value="singles" checked={cfg.mode === 'singles'} onchange={() => setMode('singles')} />
      <div>
        <strong>Singles</strong>
        <small>1 vs 1</small>
      </div>
    </label>
    <label class:selected={cfg.mode === 'doubles'}>
      <input type="radio" name="mode" value="doubles" checked={cfg.mode === 'doubles'} onchange={() => setMode('doubles')} />
      <div>
        <strong>Doubles</strong>
        <small>2 vs 2</small>
      </div>
    </label>
  </fieldset>

  {#if cfg.mode === 'singles'}
    <div class="row2">
      {@render picker('Player A', 'playerA')}
      {@render picker('Player B', 'playerB')}
    </div>
  {:else}
    <div class="team-block">
      <h3>Team A</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerA')}
        {@render picker('Player 2', 'playerA2')}
      </div>
    </div>
    <div class="team-block">
      <h3>Team B</h3>
      <div class="row2">
        {@render picker('Player 1', 'playerB')}
        {@render picker('Player 2', 'playerB2')}
      </div>
    </div>
  {/if}

  {#if cfg.format === 'custom'}
    <div class="row3">
      <label>
        <span>Best of (sets)</span>
        <input type="number" min="1" max="9" step="1" bind:value={cfg.bestOf} />
      </label>
      <label>
        <span>Points target</span>
        <input type="number" min="1" step="1" bind:value={cfg.pointsTarget} />
      </label>
      <label>
        <span>Max boards</span>
        <input type="number" min="1" step="1" bind:value={cfg.maxBoards} />
      </label>
    </div>
  {/if}

  <div class="time">
    <label class="check">
      <input type="checkbox" checked={cfg.minutesPerSet !== null} onchange={(e) => toggleTimeLimit((e.currentTarget as HTMLInputElement).checked)} />
      <span>Time limit per set</span>
    </label>
    {#if cfg.minutesPerSet !== null}
      <label class="mins">
        <input type="number" min="1" max="180" step="1" bind:value={cfg.minutesPerSet} />
        <span>min</span>
      </label>
    {/if}
  </div>

  <button class="start" type="submit" disabled={!canStart()}>
    Start match →
  </button>

  {#if loadingPlayers}
    <p class="hint">Loading player list…</p>
  {:else}
    <p class="hint">{players.length} players available in autocomplete. Free-text names work too.</p>
  {/if}

  {#if installEvt}
    <button class="install" type="button" onclick={install}>Install Carromscore</button>
  {:else if iOS}
    <p class="hint">Tap Share → Add to Home Screen to install.</p>
  {/if}
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
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.5rem;
  }
  fieldset.fmt-mode { grid-template-columns: 1fr 1fr; }
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
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem 0.85rem;
    background: #141414;
    border: 2px solid #262626;
    border-radius: 0.75rem;
    cursor: pointer;
  }
  fieldset label.selected { border-color: var(--accent); background: #1c1c1c; }
  fieldset input[type='radio'] { accent-color: var(--accent); }
  fieldset strong { display: block; font-size: 0.95rem; }
  fieldset small { display: block; color: var(--muted); font-size: 0.75rem; margin-top: 0.15rem; }

  .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  .row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem; }

  .team-block {
    background: #0f0f0f;
    border: 1px solid #222;
    border-radius: 0.75rem;
    padding: 0.75rem;
  }
  .team-block h3 {
    margin: 0 0 0.5rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
  }

  label.picker, .row3 label, .time .mins {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    position: relative;
  }
  label > span, .time span {
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

  .time {
    display: flex;
    align-items: end;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .check { display: flex; align-items: center; gap: 0.6rem; cursor: pointer; }
  .check input { width: 1.15rem; height: 1.15rem; accent-color: var(--accent); }
  .check span { color: var(--fg); text-transform: none; font-size: 1rem; letter-spacing: 0; }
  .time .mins { flex-direction: row; align-items: center; gap: 0.5rem; }
  .time .mins input { width: 5rem; }

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

  @media (max-width: 520px) {
    fieldset { grid-template-columns: 1fr; }
    fieldset.fmt-mode { grid-template-columns: 1fr 1fr; }
    .row2 { grid-template-columns: 1fr; }
    .row3 { grid-template-columns: 1fr 1fr; }
  }
</style>
