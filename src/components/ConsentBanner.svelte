<script lang="ts">
  /**
   * First-run analytics consent banner.
   *
   * Renders on the home screen only, above the setup form, when the
   * user hasn't answered yet — or when they declined more than 30
   * days ago (soft re-ask). Choosing Allow / No thanks dismisses
   * the banner and persists the choice; the setup form is fully
   * usable regardless of the answer.
   *
   * The banner is deliberately compact — one line of copy + two
   * buttons — so it doesn't push the setup form below the fold on
   * a small phone. Same visual weight as the update-available
   * banner already in MatchSetup.
   */
  import { setConsent, shouldShowConsentBanner } from '../lib/analytics';

  // Local visible flag. On mount we read the persisted state; a
  // choice hides the banner without disturbing the parent layout.
  let visible = $state(false);

  $effect(() => {
    visible = shouldShowConsentBanner();
  });

  function allow() {
    setConsent(true);
    visible = false;
  }

  function decline() {
    setConsent(false);
    visible = false;
  }
</script>

{#if visible}
  <div class="consent" role="region" aria-label="Analytics consent">
    <p class="consent-copy">
      Help us understand who uses Carromscore. If you agree, we’ll
      enable Firebase Analytics — geography, device type, and page
      views. No account, no personal data, revocable anytime in
      Settings.
    </p>
    <div class="consent-actions">
      <button type="button" class="btn btn-primary" onclick={allow}>
        Allow
      </button>
      <button type="button" class="btn btn-ghost" onclick={decline}>
        No thanks
      </button>
    </div>
  </div>
{/if}

<style>
  .consent {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.75rem;
    background: rgba(79, 195, 247, 0.06);
    border: 1px solid rgba(79, 195, 247, 0.28);
    border-radius: 0.55rem;
    color: var(--fg);
    font-size: 0.82rem;
    line-height: 1.4;
  }
  .consent-copy {
    flex: 1;
    min-width: 12rem;
    margin: 0;
    color: var(--muted);
  }
  .consent-actions {
    display: flex;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .btn {
    font: inherit;
    font-size: 0.8rem;
    font-weight: 600;
    padding: 0.35rem 0.75rem;
    border-radius: 0.4rem;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .btn-primary {
    background: var(--accent, #ffd54a);
    color: #1a1a1a;
    border-color: var(--accent, #ffd54a);
  }
  .btn-primary:hover { filter: brightness(1.08); }
  .btn-ghost {
    background: rgba(255, 255, 255, 0.06);
    color: var(--muted);
    border-color: rgba(255, 255, 255, 0.15);
  }
  .btn-ghost:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--fg);
  }
</style>
