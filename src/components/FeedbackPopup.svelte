<script lang="ts">
  /**
   * Shared "Send feedback" modal + trigger link.
   *
   * Extracted from MatchSetup so both the home footer and the lobby
   * footer can render the same UX without duplicating the popup
   * (which has enough moving parts — copy-to-clipboard, Gmail-web
   * link, mailto, GitHub Discussion, obfuscated email) to make
   * copy-paste error-prone.
   *
   * Usage:
   *   <FeedbackPopup />
   *
   * The component renders BOTH the trigger link (a small "Feedback ⇗"
   * anchor styled to match `.foot-link`) AND the popup itself. That
   * keeps state contained. Callers just drop <FeedbackPopup /> into
   * their footer where the link should sit.
   *
   * Email is assembled at click time from three fragments so naive
   * HTML-scraping bots (which don't run JS) can't harvest it from
   * the deployed bundle. Sophisticated scrapers still find it —
   * this is a mitigation, not a barrier.
   */
  import { APP_VERSION } from '../lib/version';

  let showPopup = $state(false);
  let copied = $state(false);
  let copiedTimer: number | null = null;

  const feedbackEmail = 'swapnild2111' + '@' + 'gmail.com';
  const feedbackSubject = $derived(`Carromscore v${APP_VERSION} feedback`);
  const feedbackMailto = $derived(
    `mailto:${feedbackEmail}?subject=${encodeURIComponent(feedbackSubject)}`,
  );
  const feedbackGmailWeb = $derived(
    `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(feedbackEmail)}&su=${encodeURIComponent(feedbackSubject)}`,
  );
  const feedbackDiscussionUrl = $derived(
    `https://github.com/swapnild2111/carromscore/discussions/new?category=general&title=${encodeURIComponent(`Carromscore v${APP_VERSION} — `)}&body=${encodeURIComponent(`Running Carromscore v${APP_VERSION}.\n\n<!-- Add your question / idea / observation here -->\n`)}`,
  );

  function openFeedback(e: Event) {
    e.preventDefault();
    showPopup = true;
  }

  async function copyEmail() {
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
    copied = true;
    if (copiedTimer !== null) clearTimeout(copiedTimer);
    copiedTimer = window.setTimeout(() => { copied = false; }, 1500);
  }
</script>

<a
  href="#feedback"
  class="foot-link"
  onclick={openFeedback}
  aria-label="Send feedback about Carromscore"
>Feedback ⇗</a>

{#if showPopup}
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
        <button type="button" class="fb-copy" onclick={copyEmail}>
          {copied ? '✓ Copied' : 'Copy'}
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
        <button class="cancel" onclick={() => (showPopup = false)}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Trigger link styled to match `.foot-link` in host footers.
     Duplicated locally so the component doesn't rely on the parent
     stylesheet having those rules. */
  .foot-link {
    color: var(--fg, #f5f5f5);
    text-decoration: none;
    padding: 0.15rem 0.5rem;
    border-radius: 0.35rem;
    font-weight: 600;
    transition: color 0.15s, background 0.15s;
  }
  .foot-link:hover {
    color: var(--accent, #ffd54a);
    background: rgba(255, 213, 74, 0.08);
  }

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
    background: transparent;
    color: var(--fg);
    border: 1px solid #333;
    border-radius: 0.5rem;
    cursor: pointer;
  }
  .dialog-actions .cancel:hover { border-color: var(--accent); color: var(--accent); }
</style>
