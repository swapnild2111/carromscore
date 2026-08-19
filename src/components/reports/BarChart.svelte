<script lang="ts">
  /**
   * Horizontal bar chart, hand-rolled inline SVG.
   *
   * Explicitly not a library — two charts on one page didn't justify
   * a 30-50KB dependency (see plan). The whole component is under
   * 100 lines and renders in a single reactive pass; label overflow
   * ellipsis is handled by CSS on a foreignObject fallback.
   *
   * The SVG uses a locked viewBox so it scales fluidly with its
   * container. Bar widths are computed as percentages of the max
   * value in the series, so a series with wildly different scales
   * still reads.
   */

  type Bar = { label: string; value: number; colour?: string };
  type Props = {
    title: string;
    subtitle?: string;
    bars: Bar[];
    /**
     * Value shown on hover / for accessibility. Default: the raw
     * value. Override for e.g. "5 wins" or "213 points".
     */
    formatValue?: (v: number) => string;
    /**
     * Max bars to render before scrolling. Keeps very-many-players
     * charts from pushing the table off the screen — the chart card
     * gets a max-height and overflows internally instead.
     */
    maxRows?: number;
  };
  const { title, subtitle, bars, formatValue, maxRows = 15 }: Props = $props();

  const shown = $derived(bars.slice(0, maxRows));
  const maxValue = $derived(Math.max(1, ...shown.map((b) => b.value)));
  // Layout switched to "label above the bar" so long player names
  // don't clip against the SVG's left edge (reported 2026-08-19:
  // "Yuvaraj Eshwaramoorthy" rendered as "uvaraj Eshwaramoorthy"
  // because a right-anchored SVG text at x=labelWidth ran off the
  // 0-origin viewBox). Each row is now two lines high: name on top,
  // bar + numeric value below. Reads better on narrow phones too.
  const labelHeight = 18;
  const barBandHeight = 20;
  const rowHeight = labelHeight + barBandHeight;
  const gap = 8;
  const valueWidth = 44;
  const chartWidth = 380;
  const totalHeight = $derived(shown.length * (rowHeight + gap));
  const barsPixelWidth = $derived(chartWidth - valueWidth);

  function fmt(v: number): string {
    return formatValue ? formatValue(v) : String(v);
  }
</script>

<figure class="chart">
  <figcaption>
    <span class="title">{title}</span>
    {#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
  </figcaption>
  {#if shown.length === 0}
    <p class="empty">No data yet</p>
  {:else}
    <svg
      class="svg"
      viewBox={`0 0 ${chartWidth} ${totalHeight}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={title}
    >
      {#each shown as bar, i (bar.label + i)}
        {@const barLen = (bar.value / maxValue) * barsPixelWidth}
        {@const y = i * (rowHeight + gap)}
        {@const colour = bar.colour ?? '#4fc3f7'}
        {@const labelY = y + labelHeight - 4}
        {@const barY = y + labelHeight}
        <g>
          <text
            x="0"
            y={labelY}
            class="lbl"
            text-anchor="start"
            dominant-baseline="alphabetic"
          >{bar.label}</text>
          <rect
            x="0"
            y={barY + 2}
            width={Math.max(2, barLen)}
            height={barBandHeight - 4}
            fill={colour}
            rx="3"
          >
            <title>{bar.label}: {fmt(bar.value)}</title>
          </rect>
          <text
            x={barLen + 6}
            y={barY + barBandHeight / 2}
            class="val"
            text-anchor="start"
            dominant-baseline="middle"
          >{fmt(bar.value)}</text>
        </g>
      {/each}
    </svg>
  {/if}
  {#if bars.length > maxRows}
    <p class="overflow-note">Showing top {maxRows} of {bars.length}</p>
  {/if}
</figure>

<style>
  .chart {
    margin: 0;
    padding: 0.85rem 1rem 1rem;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 0.6rem;
  }
  figcaption {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.6rem;
    gap: 0.6rem;
  }
  .title {
    font-size: 0.85rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg, #f5f5f5);
  }
  .subtitle {
    font-size: 0.75rem;
    color: var(--muted, #9aa0a6);
  }
  .svg {
    width: 100%;
    height: auto;
    display: block;
  }
  .lbl {
    fill: var(--fg, #f5f5f5);
    font-size: 12px;
    font-family: system-ui, sans-serif;
  }
  .val {
    fill: var(--muted, #9aa0a6);
    font-size: 11px;
    font-family: monospace;
    font-weight: 700;
  }
  .empty {
    margin: 0;
    padding: 0.6rem 0;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    text-align: center;
  }
  .overflow-note {
    margin: 0.4rem 0 0;
    text-align: center;
    color: var(--muted, #9aa0a6);
    font-size: 0.7rem;
  }
</style>
