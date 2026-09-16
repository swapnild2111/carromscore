<script lang="ts">
  /**
   * Searchable country combobox. Replaces the plain <select> that produced
   * an unscrollable 176-item native dropdown. Features:
   *   - Type to filter by name or ISO code
   *   - Flag emoji + name in each option
   *   - Keyboard nav: ArrowUp/Down, Enter to confirm, Escape to close
   *   - Dropdown anchors to viewport top/bottom so it never goes off-screen
   *   - Dark theme matching the admin panel
   */
  import { COUNTRIES, flagEmoji } from '../lib/countries';

  interface Props {
    value: string;
    required?: boolean;
    disabled?: boolean;
    placeholder?: string;
    ariaLabel?: string;
  }
  let {
    value = $bindable(''),
    required = false,
    disabled = false,
    placeholder = 'Select country…',
    ariaLabel = 'Country',
  }: Props = $props();

  let open = $state(false);
  let query = $state('');
  let activeIdx = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  let listEl = $state<HTMLUListElement | null>(null);
  let wrapEl = $state<HTMLDivElement | null>(null);

  const selected = $derived(COUNTRIES.find((c) => c.code === value) ?? null);

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COUNTRIES as typeof COUNTRIES;
    return COUNTRIES.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.code.toLowerCase().startsWith(q),
    );
  });

  // Display label in the trigger button
  const triggerLabel = $derived(
    selected ? `${flagEmoji(selected.code)} ${selected.name}` : placeholder,
  );

  function openDropdown() {
    if (disabled) return;
    open = true;
    query = '';
    activeIdx = selected ? filtered.findIndex((c) => c.code === value) : 0;
    // Focus the search input on next tick
    setTimeout(() => inputEl?.focus(), 0);
  }

  function close() {
    open = false;
    query = '';
    activeIdx = -1;
  }

  function select(code: string) {
    value = code;
    close();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        openDropdown();
      }
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = Math.min(activeIdx + 1, filtered.length - 1);
      scrollActiveIntoView();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = Math.max(activeIdx - 1, 0);
      scrollActiveIntoView();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && filtered[activeIdx]) select(filtered[activeIdx].code);
    } else if (e.key === 'Tab') {
      close();
    }
  }

  function scrollActiveIntoView() {
    setTimeout(() => {
      const li = listEl?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
      li?.scrollIntoView({ block: 'nearest' });
    }, 0);
  }

  function onQueryInput() {
    activeIdx = filtered.length > 0 ? 0 : -1;
  }

  function onOutsideClick(e: MouseEvent) {
    if (!wrapEl?.contains(e.target as Node)) close();
  }
</script>

<svelte:window onmousedown={onOutsideClick} />

<!-- Hidden native select keeps form validation / submit value working -->
<select
  class="cs-hidden-select"
  bind:value
  {required}
  aria-hidden="true"
  tabindex="-1"
>
  <option value=""></option>
  {#each COUNTRIES as c (c.code)}
    <option value={c.code}>{c.name}</option>
  {/each}
</select>

<div class="cs-wrap" bind:this={wrapEl}>
  <!-- Trigger -->
  <button
    type="button"
    class="cs-trigger"
    class:cs-placeholder={!selected}
    class:cs-disabled={disabled}
    class:cs-open={open}
    aria-label={ariaLabel}
    aria-haspopup="listbox"
    aria-expanded={open}
    {disabled}
    onclick={openDropdown}
    onkeydown={onKeyDown}
  >
    <span class="cs-trigger-text">{triggerLabel}</span>
    <span class="cs-chevron" aria-hidden="true">{open ? '▲' : '▼'}</span>
  </button>

  {#if open}
    <!-- Dropdown panel -->
    <div class="cs-panel" role="dialog" aria-label="Choose country">
      <div class="cs-search-wrap">
        <input
          bind:this={inputEl}
          type="text"
          class="cs-search"
          placeholder="Search…"
          autocomplete="off"
          bind:value={query}
          oninput={onQueryInput}
          onkeydown={onKeyDown}
          aria-label="Search countries"
        />
      </div>
      {#if filtered.length === 0}
        <p class="cs-empty">No match</p>
      {:else}
        <ul
          bind:this={listEl}
          class="cs-list"
          role="listbox"
          aria-label={ariaLabel}
        >
          {#each filtered as c, i (c.code)}
            <li
              role="option"
              aria-selected={c.code === value}
              class="cs-option"
              class:cs-active={i === activeIdx}
              class:cs-selected={c.code === value}
              data-idx={i}
              onmousedown={(e) => { e.preventDefault(); select(c.code); }}
              onmousemove={() => { activeIdx = i; }}
            >
              <span class="cs-flag">{flagEmoji(c.code)}</span>
              <span class="cs-name">{c.name}</span>
              {#if c.code === value}
                <span class="cs-check" aria-hidden="true">✓</span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .cs-hidden-select {
    position: absolute;
    opacity: 0;
    pointer-events: none;
    width: 1px;
    height: 1px;
    overflow: hidden;
  }

  .cs-wrap {
    position: relative;
    width: 100%;
  }

  /* ── Trigger button ─────────────────────────────────── */
  .cs-trigger {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.5rem 0.65rem;
    background: var(--surface, #111111);
    color: var(--fg, #f5f5f5);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s;
  }
  .cs-trigger:hover:not(.cs-disabled) {
    border-color: #444;
  }
  .cs-trigger.cs-open,
  .cs-trigger:focus-visible {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  .cs-trigger.cs-placeholder .cs-trigger-text {
    color: #666;
  }
  .cs-trigger.cs-disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .cs-trigger-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cs-chevron {
    font-size: 0.65rem;
    color: #666;
    margin-left: 0.5rem;
    flex-shrink: 0;
  }

  /* ── Dropdown panel ─────────────────────────────────── */
  .cs-panel {
    position: absolute;
    z-index: 999;
    left: 0;
    top: calc(100% + 4px);
    width: 100%;
    min-width: 220px;
    background: #161616;
    border: 1px solid #333;
    border-radius: 0.5rem;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    max-height: min(320px, 50vh);
    overflow: hidden;
  }

  /* ── Search ─────────────────────────────────────────── */
  .cs-search-wrap {
    padding: 0.45rem 0.5rem;
    border-bottom: 1px solid #222;
    flex-shrink: 0;
  }
  .cs-search {
    width: 100%;
    background: #0a0a0a;
    color: var(--fg, #f5f5f5);
    border: 1px solid #2a2a2a;
    border-radius: 0.35rem;
    padding: 0.35rem 0.55rem;
    font: inherit;
    font-size: 0.85rem;
    box-sizing: border-box;
  }
  .cs-search:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  .cs-search::placeholder {
    color: #555;
  }

  /* ── Option list ────────────────────────────────────── */
  .cs-list {
    list-style: none;
    margin: 0;
    padding: 0.25rem 0;
    overflow-y: auto;
    flex: 1;
    overscroll-behavior: contain;
  }
  .cs-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.38rem 0.7rem;
    cursor: pointer;
    font-size: 0.88rem;
    color: var(--fg, #f5f5f5);
    transition: background 0.08s;
    user-select: none;
  }
  .cs-option.cs-active,
  .cs-option:hover {
    background: rgba(255, 255, 255, 0.07);
  }
  .cs-option.cs-selected {
    color: var(--accent, #ffd54a);
  }
  .cs-flag {
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }
  .cs-name {
    flex: 1;
  }
  .cs-check {
    font-size: 0.8rem;
    color: var(--accent, #ffd54a);
    flex-shrink: 0;
  }

  /* ── Empty state ────────────────────────────────────── */
  .cs-empty {
    padding: 0.75rem 0.7rem;
    color: #555;
    font-size: 0.85rem;
    margin: 0;
  }
</style>
