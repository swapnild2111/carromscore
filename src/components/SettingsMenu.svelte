<script lang="ts">
  /**
   * Home-screen Settings menu.
   *
   * A single toggle for v1: **Share usage analytics**. Placed here
   * (rather than the /admin/ area) because it applies to every
   * user, not just admins — and because /admin/ is guarded by
   * sign-in, which would put the toggle out of reach for anonymous
   * umpires who are the main audience for the app.
   *
   * Reachable via a gear icon in the home footer (see MatchSetup).
   * Opens as an inline dropdown; tapping outside or the toggle
   * itself closes it.
   */
  import { getConsent, setConsent } from '../lib/analytics';

  let open = $state(false);
  let granted = $state(false);

  // Sync the local checkbox state whenever the popover opens, so
  // the toggle reflects whatever consent was persisted (including
  // choices made from ConsentBanner in this same session).
  $effect(() => {
    if (open) granted = getConsent() === 'granted';
  });

  function toggle(): void {
    granted = !granted;
    setConsent(granted);
  }

  function close(): void {
    open = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="wrap">
  <button
    type="button"
    class="gear"
    aria-label="Open settings"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <!--
      Inline gear glyph. Keeps the button dependency-free so it
      renders on the very first paint (no icon-font wait).
    -->
    ⚙
  </button>

  {#if open}
    <!-- Backdrop click-catcher; keyboard users get Escape from svelte:window. -->
    <button
      type="button"
      class="scrim"
      aria-label="Close settings"
      onclick={close}
    ></button>
    <div class="menu" role="dialog" aria-modal="false" aria-label="Settings">
      <h3 class="menu-h">Settings</h3>
      <label class="row">
        <input
          type="checkbox"
          checked={granted}
          onchange={toggle}
        />
        <span class="row-body">
          <span class="row-title">Share usage analytics</span>
          <span class="row-note">Anonymous. Off by default. Revocable.</span>
        </span>
      </label>
    </div>
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    display: inline-flex;
  }

  .gear {
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: var(--muted);
    font: inherit;
    font-size: 0.9rem;
    line-height: 1;
    width: 1.75rem;
    height: 1.75rem;
    border-radius: 0.4rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    padding: 0;
  }
  .gear:hover { color: var(--fg); background: rgba(255,255,255,0.08); }

  .scrim {
    position: fixed;
    inset: 0;
    background: transparent;
    border: none;
    padding: 0;
    z-index: 250;
    cursor: default;
  }

  .menu {
    position: absolute;
    bottom: calc(100% + 0.35rem);
    right: 0;
    z-index: 260;
    min-width: 16rem;
    background: #141414;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.55rem;
    padding: 0.75rem;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
    text-align: left;
  }

  .menu-h {
    margin: 0 0 0.5rem;
    color: var(--muted);
    font-size: 0.7rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .row {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    padding: 0.35rem 0;
    cursor: pointer;
  }
  .row input {
    margin-top: 0.15rem;
    width: 1.05rem;
    height: 1.05rem;
    accent-color: var(--accent, #ffd54a);
    cursor: pointer;
  }
  .row-body { display: flex; flex-direction: column; }
  .row-title {
    color: var(--fg);
    font-size: 0.9rem;
    font-weight: 600;
  }
  .row-note {
    color: var(--muted);
    font-size: 0.72rem;
    margin-top: 0.15rem;
  }
</style>
