<script lang="ts">
  /**
   * Fixed-list ISO country picker. Used by:
   *   - AdminPlayers Add + Bulk-add dialogs (v3.1) to attach a country
   *     to each new player record.
   *   - AdminTournaments closed-tournament create dialog to bind a
   *     tournament to its eligible-country set.
   *
   * The picker is a plain `<select>` — browsers already implement
   * type-to-jump for `<select>`, so a Chrome/Safari user can hit "d"
   * to jump to Denmark without any custom autocomplete logic. Keeps
   * bundle size + code complexity down vs a custom combobox.
   *
   * Storage value is the ISO 3166-1 alpha-2 code (e.g. "DK"). See
   * `src/lib/countries.ts` for the full list.
   */
  import { COUNTRIES } from '../lib/countries';

  interface Props {
    value: string;
    required?: boolean;
    disabled?: boolean;
    /** Placeholder shown as the first (unselectable) option. */
    placeholder?: string;
    /** aria-label / label association; caller wraps in <label> when
     *  they want a visible label. */
    ariaLabel?: string;
  }
  let {
    value = $bindable(''),
    required = false,
    disabled = false,
    placeholder = 'Select country…',
    ariaLabel = 'Country',
  }: Props = $props();
</script>

<select
  class="country-select"
  bind:value
  {required}
  {disabled}
  aria-label={ariaLabel}
>
  <option value="" disabled>{placeholder}</option>
  {#each COUNTRIES as c (c.code)}
    <option value={c.code}>{c.name}</option>
  {/each}
</select>

<style>
  .country-select {
    background: #0f0f0f;
    color: var(--fg, #f5f5f5);
    border: 1px solid #2a2a2a;
    border-radius: 0.45rem;
    padding: 0.5rem 0.65rem;
    font: inherit;
    font-size: 0.9rem;
    width: 100%;
    cursor: pointer;
    -webkit-appearance: menulist;
    appearance: menulist;
  }
  .country-select:focus {
    outline: none;
    border-color: var(--accent, #ffd54a);
  }
  .country-select:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
</style>
