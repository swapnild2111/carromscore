<script lang="ts">
  /**
   * Printer-friendly board QR stickers (v3.6.1). Reads
   * ?tournament=<key> and renders one page per physical board
   * (Board 1, Board 2, …), each with a big centered QR that encodes
   * `?tournament=<key>&board=<N>`.
   *
   * Why per-board, not per-match: the QR sticker is permanent —
   * printed once and stuck to the physical carrom board. Every
   * round, the umpire on Board 3 scans the same QR; the app auto-
   * advances to whichever match is currently assigned to Board 3
   * (resolvePlannedByBoard in lib/planned.ts). Zero admin work
   * between rounds. See MatchSetup's `?board=` deep-link handler.
   *
   * The set of boards printed is the union of all `board` values
   * across every /planned record for this tournament (across all
   * rounds), plus a fill from 1..maxBoard so gaps like "Board 1,
   * 2, 4" still print a Board 3 sticker (dead board today, but
   * the organiser might use it next round).
   *
   * No player names on the sticker — those change every round.
   * Only the tournament name + Board N.
   */
  import { onMount } from 'svelte';
  import {
    subscribePlannedByTournament,
    type PlannedMatch,
  } from '../../lib/planned';
  import { qrToSVG } from '../../lib/qrcode';

  let tournamentKey = $state<string>('');
  let plannedMatches = $state<PlannedMatch[]>([]);
  let unsub: (() => void) | null = null;
  let ready = $state(false);

  onMount(() => {
    if (typeof window === 'undefined') return () => {};
    const params = new URLSearchParams(window.location.search);
    tournamentKey = params.get('tournament') ?? '';
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

  // Tournament display name: any record's tournament field works
  // (they're all the same tournament). Empty when nothing planned.
  const tournamentName = $derived<string>(
    plannedMatches[0]?.tournament ?? tournamentKey,
  );

  // Board numbers to print: union of all `board` values across
  // rounds, then filled 1..max so gaps still print a sticker.
  const boards = $derived<number[]>(() => {
    const set = new Set<number>();
    let max = 0;
    for (const m of plannedMatches) {
      if (m.board && m.board >= 1 && m.board <= 99) {
        set.add(m.board);
        if (m.board > max) max = m.board;
      }
    }
    if (max === 0) return [];
    // Fill 1..max — a printed Board 3 sticker sitting unused today
    // is still useful when the organiser assigns to Board 3 later.
    const out: number[] = [];
    for (let i = 1; i <= max; i += 1) out.push(i);
    return out;
  });

  // QR SVG cache — one entry per board number. Regenerated on
  // tournamentKey change.
  let qrByBoard = $state<Record<number, string>>({});
  const scanBase = (() => {
    if (typeof window === 'undefined') return '';
    const base = import.meta.env.BASE_URL ?? '/';
    return `${window.location.origin}${base}`;
  })();
  $effect(() => {
    if (!tournamentKey) return;
    for (const b of boards()) {
      if (qrByBoard[b]) continue;
      const url = `${scanBase}?tournament=${encodeURIComponent(tournamentKey)}&board=${b}`;
      void qrToSVG(url, 400).then((svg) => {
        qrByBoard = { ...qrByBoard, [b]: svg };
      });
    }
  });
</script>

<div class="print-wrap">
  {#if !tournamentKey}
    <p class="hint">Provide a <code>?tournament=&lt;key&gt;</code> URL param.</p>
  {:else if !ready}
    <p class="hint">Loading…</p>
  {:else if boards().length === 0}
    <p class="hint">
      No boards assigned yet. Add matches to the bracket with a board
      number, then come back and print.
    </p>
  {:else}
    <div class="print-actions no-print">
      <button type="button" onclick={() => window.print()}>🖨 Print</button>
      <p class="hint">
        One page per board. Cut along the border, stick each sheet to
        its physical carrom board. Umpires scan the same sticker every
        round — the app resolves which match is currently on that
        board automatically.
      </p>
    </div>
    {#each boards() as b (b)}
      <section class="page">
        <div class="hdr">
          <p class="tour">{tournamentName}</p>
        </div>
        <p class="board-label">Board {b}</p>
        <div class="qr-holder">
          {#if qrByBoard[b]}
            {@html qrByBoard[b]}
          {:else}
            <div class="qr-placeholder">generating…</div>
          {/if}
        </div>
        <p class="cta">Scan to open the current match on this board</p>
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
    break-after: page;
    page-break-after: always;
  }
  .page:last-child { break-after: auto; page-break-after: auto; }
  .hdr { margin-bottom: 0.4rem; }
  .tour {
    margin: 0;
    font-size: 1rem;
    color: #444;
    font-weight: 600;
  }
  .board-label {
    margin: 0.4rem 0 1rem;
    font-size: 2.4rem;
    font-weight: 900;
    color: #000;
    letter-spacing: 0.02em;
  }
  .qr-holder {
    margin: 0.4rem 0 0.6rem;
    background: #fff;
    padding: 0.5rem;
    border: 2px solid #000;
    line-height: 0;
  }
  .qr-holder :global(svg) {
    width: 320px;
    height: 320px;
    display: block;
  }
  .qr-placeholder {
    width: 320px;
    height: 320px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #999;
    font-size: 0.9rem;
    border: 1px dashed #ccc;
  }
  .cta {
    margin: 0.4rem 0 0;
    color: #333;
    font-size: 0.95rem;
  }

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
