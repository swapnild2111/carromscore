<script lang="ts">
  /**
   * Compact "?" chip that reveals a small popover with a hint.
   *
   * Works uniformly across pointer and touch: hover on desktop shows
   * the popover; a click (either desktop or touch) pins it open until
   * dismissed by clicking outside, tapping the chip again, or Escape.
   * That's an intentional bit of redundancy — a hover-only tooltip
   * would leave phone users guessing, and a click-only one would
   * frustrate keyboard/desktop testers who reach for hover first.
   *
   * Positioned absolutely inside a `position: relative` wrapper on
   * the chip button; the popover anchors to the chip and sizes
   * itself to a max-width so long copy wraps rather than escaping
   * the viewport.
   *
   * Slot receives arbitrary content so a hint can be multi-line or
   * carry emphasis, e.g. <HelpTip>Set to <em>0</em> for unlimited</HelpTip>.
   */

  interface Props {
    /** Short a11y label for the "?" button. Defaults to a generic
     *  "Help". Prefer a specific label like "Help: what's a set?"
     *  so screen readers announce something meaningful. */
    label?: string;
  }
  const { label = 'Help', children }: Props & { children?: unknown } = $props();

  let open = $state(false);
  let pinned = $state(false);
  let root: HTMLSpanElement | undefined;

  function toggle(e: MouseEvent) {
    // Stop propagation so the click doesn't reach the parent <label>
    // (which would refocus the associated input and steal the tap).
    e.preventDefault();
    e.stopPropagation();
    pinned = !pinned;
    open = pinned;
  }

  function onHoverIn() {
    if (pinned) return;
    open = true;
  }
  function onHoverOut() {
    if (pinned) return;
    open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && open) {
      open = false;
      pinned = false;
    }
  }

  $effect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (root && !root.contains(e.target as Node)) {
        open = false;
        pinned = false;
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  });
</script>

<span class="wrap" bind:this={root} onkeydown={onKey}>
  <button
    type="button"
    class="chip"
    class:chip-active={open}
    aria-label={label}
    aria-expanded={open}
    onclick={toggle}
    onmouseenter={onHoverIn}
    onmouseleave={onHoverOut}
    onfocus={onHoverIn}
    onblur={onHoverOut}
  >?</button>
  {#if open}
    <span class="pop" role="tooltip">
      {@render children?.()}
    </span>
  {/if}
</span>

<style>
  .wrap {
    display: inline-flex;
    align-items: center;
    position: relative;
    margin-left: 0.35rem;
    /* Chip inherits the label's font-size; keep chip vertical rhythm
       tight to the label baseline. */
    vertical-align: middle;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.05rem;
    height: 1.05rem;
    padding: 0;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.22);
    color: var(--muted, #9aa0a6);
    font: inherit;
    font-size: 0.7rem;
    font-weight: 800;
    line-height: 1;
    cursor: help;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    -webkit-tap-highlight-color: transparent;
  }
  .chip:hover,
  .chip-active {
    background: rgba(255, 213, 74, 0.14);
    border-color: rgba(255, 213, 74, 0.5);
    color: var(--accent, #ffd54a);
  }
  .chip:focus-visible {
    outline: 2px solid var(--accent, #ffd54a);
    outline-offset: 2px;
  }
  .pop {
    /* Popover: absolute-positioned card below the chip. Left-anchored
       so short labels stay near the ? and long copy wraps to a soft
       max-width instead of stretching. Clamped max-width keeps it
       fitting even on 320px phones. */
    position: absolute;
    top: calc(100% + 0.35rem);
    left: 0;
    z-index: 60;
    min-width: 12rem;
    max-width: min(20rem, calc(100vw - 2rem));
    padding: 0.55rem 0.7rem;
    background: #1a1a1a;
    border: 1px solid rgba(255, 213, 74, 0.35);
    border-radius: 0.5rem;
    color: var(--fg, #f5f5f5);
    font-size: 0.78rem;
    font-weight: 500;
    line-height: 1.35;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
    /* Neutralise inherited legend/label styles — the popover text
       should read as body copy, not as an uppercase legend. */
    text-transform: none;
    letter-spacing: 0;
    /* Small arrow pointing back to the chip. Pure CSS triangle so
       the popover keeps its border consistent. */
  }
  .pop::before {
    content: '';
    position: absolute;
    top: -6px;
    left: 0.5rem;
    width: 10px;
    height: 10px;
    background: #1a1a1a;
    border-top: 1px solid rgba(255, 213, 74, 0.35);
    border-left: 1px solid rgba(255, 213, 74, 0.35);
    transform: rotate(45deg);
  }
</style>
