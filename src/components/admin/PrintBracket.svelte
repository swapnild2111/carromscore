<script lang="ts">
  /**
   * Printer-friendly bracket sheet body (v3.6). Reads
   * ?tournament=<key>&round=<key> and renders one page per planned
   * match — big centered QR + player names + round + tournament.
   *
   * The organiser hits browser Print (or ⌘P), the browser fits one
   * match per page, and the organiser cuts along the borders and
   * sticks each to a carrom board.
   *
   * No sign-in required to view (planned records are publicly
   * readable — same posture as /live). The sheet is intended for
   * private / one-off use during a tournament setup; anyone
   * scanning a QR without organiser context just hits MatchSetup's
   * planned deep-link handler, which claims and prefills normally.
   */
  import { onMount } from 'svelte';
  import {
    subscribePlannedByTournament,
    type PlannedMatch,
  } from '../../lib/planned';
  import { qrToSVG } from '../../lib/qrcode';

  let tournamentKey = $state<string>('');
  let roundKey = $state<string>('');
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsub: (() => void) | null = null;
  let ready = $state(false);

  onMount(() => {
    if (typeof window === 'undefined') return () => {};
    const params = new URLSearchParams(window.location.search);
    tournamentKey = params.get('tournament') ?? '';
    roundKey = params.get('round') ?? '';
    if (!tournamentKey) {
      ready = true;
      return () => {};
    }
    (async () => {
      unsub = await subscribePlannedByTournament(tournamentKey, (arr) => {
        plannedMatches = arr;
        ready = true;
      });
    })();
    return () => {
      unsub?.();
    };
  });

  const rows = $derived(
    plannedMatches
      .filter((m) => !roundKey || m.roundKey === roundKey)
      .sort((a, b) => (a.matchOrder ?? 0) - (b.matchOrder ?? 0)),
  );

  // QR SVG cache — one entry per mid. Regenerated on first render.
  let qrByMid = $state<Record<string, string>>({});
  const scanBase = (() => {
    if (typeof window === 'undefined') return '';
    // Target the app root (MatchSetup), NOT /score/ — the scan must
    // land on the setup form so the umpire sees a preview and taps
    // Start. See TournamentBracket.svelte for the full rationale
    // (fix for 2026-08-30 issues #4, #5, #6).
    const base = import.meta.env.BASE_URL ?? '/';
    return `${window.location.origin}${base}`;
  })();
  $effect(() => {
    for (const m of rows) {
      if (qrByMid[m.mid]) continue;
      const url = `${scanBase}?planned=${encodeURIComponent(m.mid)}`;
      void qrToSVG(url, 400).then((svg) => {
        qrByMid = { ...qrByMid, [m.mid]: svg };
      });
    }
  });

  function labelPair(m: PlannedMatch): { a: string; b: string } {
    const a = m.a2Name ? `${m.aName} & ${m.a2Name}` : m.aName;
    const b = m.b2Name ? `${m.bName} & ${m.b2Name}` : m.bName;
    return { a, b };
  }
</script>

<div class="print-wrap">
  {#if !tournamentKey}
    <p class="hint">Provide a <code>?tournament=&lt;key&gt;</code> URL param.</p>
  {:else if !ready}
    <p class="hint">Loading…</p>
  {:else if rows.length === 0}
    <p class="hint">No planned matches for this scope.</p>
  {:else}
    <div class="print-actions no-print">
      <button type="button" onclick={() => window.print()}>🖨 Print</button>
      <p class="hint">
        Each page below prints as one carrom-board sticker. Cut along
        the border after printing.
      </p>
    </div>
    {#each rows as m (m.mid)}
      {@const pair = labelPair(m)}
      <section class="page">
        <div class="hdr">
          <p class="tour">{m.tournament}</p>
          <p class="round">{m.round}{m.matchOrder ? ` · Match ${m.matchOrder}` : ''}</p>
        </div>
        <div class="players">
          <div class="side">
            <p class="side-name">{pair.a}</p>
          </div>
          <div class="vs">vs</div>
          <div class="side">
            <p class="side-name">{pair.b}</p>
          </div>
        </div>
        <div class="qr-holder">
          {#if qrByMid[m.mid]}
            {@html qrByMid[m.mid]}
          {:else}
            <div class="qr-placeholder">generating…</div>
          {/if}
        </div>
        <p class="cta">Scan to open scoreboard</p>
      </section>
    {/each}
  {/if}
</div>

<style>
  .print-wrap {
    max-width: 60rem;
    margin: 0 auto;
    padding: 1rem;
    color: #000;
    background: #fff;
  }
  .hint {
    color: #555;
    font-size: 0.9rem;
    text-align: center;
    padding: 2rem 0;
  }
  .print-actions {
    background: #f8f8f8;
    border: 1px dashed #bbb;
    padding: 1rem;
    text-align: center;
    margin-bottom: 1rem;
  }
  .print-actions button {
    background: #ffd54a;
    border: 1px solid #b8990a;
    padding: 0.6rem 1.4rem;
    font-size: 1rem;
    font-weight: 700;
    border-radius: 0.4rem;
    cursor: pointer;
  }
  .print-actions button:hover { background: #ffe07a; }
  .print-actions .hint { padding: 0.75rem 0 0; color: #666; }

  .page {
    background: #fff;
    color: #000;
    padding: 2rem;
    border: 1px solid #ccc;
    margin: 1rem 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 22rem;
    text-align: center;
    /* One page per match when printing. `break-after: page`
       ensures each row lands on its own printable sheet. */
    break-after: page;
    page-break-after: always;
  }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .hdr {
    margin-bottom: 1rem;
  }
  .tour {
    margin: 0;
    font-size: 1rem;
    color: #444;
    font-weight: 600;
  }
  .round {
    margin: 0.2rem 0 0;
    font-size: 1.4rem;
    font-weight: 800;
    color: #000;
  }
  .players {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 1rem;
    margin: 1.4rem 0 1rem;
    width: 100%;
    max-width: 40rem;
  }
  .side-name {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    color: #000;
    line-height: 1.2;
  }
  .vs {
    color: #666;
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  .qr-holder {
    margin: 1rem 0;
    background: #fff;
    padding: 0.5rem;
    border: 2px solid #000;
    line-height: 0;
  }
  .qr-holder :global(svg) {
    width: 260px;
    height: 260px;
    display: block;
  }
  .qr-placeholder {
    width: 260px;
    height: 260px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 0.9rem;
    border: 1px dashed #ccc;
  }
  .cta {
    margin: 0.5rem 0 0;
    color: #333;
    font-size: 0.95rem;
  }

  /* Print styles: hide the toolbar, remove the outer border, one
     match per page. Chrome/Safari respect `break-after` in a print
     context; Firefox uses `page-break-after` as a fallback. */
  @media print {
    :global(body) { background: #fff; }
    .no-print { display: none !important; }
    .page {
      border: none;
      margin: 0;
      padding: 1.5rem;
      min-height: 0;
    }
  }
</style>
