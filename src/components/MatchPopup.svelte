<script lang="ts">
  /**
   * Shared match recap popup. Used by both LiveLobby (live + history
   * tab) and ReportsTab. Owns the sheet dialog, gold-border card, sticky
   * header, and LiveScoreboardView. Callers can pass extra header action
   * buttons and additional body content via Svelte 5 snippets.
   *
   * Two calling modes:
   *
   *   1. `record` + metadata props — LiveLobby, which has already
   *      converted its live/history record into a LiveRecord and computed
   *      isEnded / modeLabel / tournament / round separately.
   *
   *   2. `matchRecord` alone — ReportsTab. The component converts
   *      internally using reconcileResultFromBoardLog (same logic as
   *      LiveLobby's matchAsLiveRecord). Title metadata is derived from
   *      the MatchRecord directly.
   */
  import type { Snippet } from 'svelte';
  import LiveScoreboardView from './LiveScoreboardView.svelte';
  import type { LiveRecord } from '../lib/live-sync';
  import type { MatchRecord } from '../lib/history';
  import { reconcileResultFromBoardLog } from '../lib/history';

  type Props = {
    /** Pre-converted LiveRecord (LiveLobby usage). */
    record?: LiveRecord | null;
    /** Raw MatchRecord (ReportsTab usage — converted internally). */
    matchRecord?: MatchRecord | null;
    open: boolean;
    /** Override: is the match ended? Ignored when using matchRecord. */
    isEnded?: boolean;
    /** Override: mode label string. Ignored when using matchRecord. */
    modeLabel?: string;
    /** Override: tournament name. Ignored when using matchRecord. */
    tournament?: string;
    /** Override: round name. Ignored when using matchRecord. */
    round?: string;
    /** Extra buttons rendered before the close button in the header. */
    actions?: Snippet;
    /** Extra content rendered below LiveScoreboardView inside sheet-body. */
    children?: Snippet;
    onrequestclose: () => void;
  };

  const {
    record: recordProp = null,
    matchRecord = null,
    open,
    isEnded: isEndedProp,
    modeLabel: modeLabelProp,
    tournament: tournamentProp,
    round: roundProp,
    actions,
    children,
    onrequestclose,
  }: Props = $props();

  function matchAsLiveRecord(m: MatchRecord): LiveRecord {
    const rec = reconcileResultFromBoardLog(m);
    const log = (m.boardLog ?? []).filter((e) => !!e && typeof e === 'object');
    const lastSetIdx = log.reduce((max, e) => Math.max(max, (e as { set?: number }).set ?? 0), -1);
    const lastSetBoards = log.filter((e) => ((e as { set?: number }).set ?? 0) === lastSetIdx).length;
    const boardDisplay = lastSetBoards > 0 ? lastSetBoards : rec.boardCount;
    const playerA = m.mode === 'doubles'
      ? `${m.aName ?? ''} & ${m.a2Name ?? ''}`
      : (m.aName ?? '');
    const playerB = m.mode === 'doubles'
      ? `${m.bName ?? ''} & ${m.b2Name ?? ''}`
      : (m.bName ?? '');
    return {
      matchId: m.id,
      updatedAt: m.endedAt ?? 0,
      meta: {
        mode: m.mode,
        playerA,
        playerB,
        bestOf: m.cfg?.bestOf ?? 1,
        pointsTarget: m.cfg?.pointsTarget ?? 25,
        maxBoards: m.cfg?.maxBoards ?? 8,
      },
      liveState: {
        sideA: { points: rec.finalPointsA, sets: rec.setsA },
        sideB: { points: rec.finalPointsB, sets: rec.setsB },
        board: boardDisplay,
        currentBreak: null,
        queenHolder: null,
        matchResult: rec.winner,
        ...(m.boardLog && m.boardLog.length > 0 ? { boardLog: m.boardLog } : {}),
        ...(m.setWinners && m.setWinners.length > 0 ? { setWinners: m.setWinners } : {}),
        ...(m.practiceBoards && m.practiceBoards.length > 0 ? { practiceBoards: m.practiceBoards } : {}),
      },
    };
  }

  const record = $derived<LiveRecord | null>(
    recordProp ?? (matchRecord ? matchAsLiveRecord(matchRecord) : null)
  );

  const isEnded = $derived<boolean>(
    isEndedProp !== undefined ? isEndedProp : matchRecord !== null
  );

  function modeStr(mode: string | undefined): string {
    if (mode === 'singles') return 'Singles';
    if (mode === 'doubles') return 'Doubles';
    return 'Practice';
  }

  const modeLabel = $derived<string>(
    modeLabelProp !== undefined ? modeLabelProp : modeStr(matchRecord?.mode)
  );

  const tournament = $derived<string>(
    tournamentProp !== undefined ? tournamentProp : (matchRecord?.tournament ?? '').trim()
  );

  const round = $derived<string>(
    roundProp !== undefined ? roundProp : (matchRecord?.round ?? '').trim()
  );

  let dialog = $state<HTMLDialogElement | null>(null);

  $effect(() => {
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
    } else {
      if (dialog.open) dialog.close();
    }
  });

  function onDialogClick(e: MouseEvent): void {
    if (e.target === dialog) onrequestclose();
  }
</script>

<dialog bind:this={dialog} class="sheet" onclick={onDialogClick} onclose={onrequestclose}>
  {#if record}
    <div class="sheet-inner" role="document">
      <header class="sheet-hdr">
        <div class="sheet-title-wrap">
          <span class="sheet-title">
            {#if isEnded}Ended · {:else}<span class="sheet-live"><span class="dot" aria-hidden="true"></span>LIVE · </span>{/if}{modeLabel}
          </span>
          {#if tournament || round}
            <span class="sheet-subtitle">
              {#if tournament}<span class="sheet-tour">{tournament}</span>{/if}{#if tournament && round} · {/if}{#if round}<span class="sheet-round">{round}</span>{/if}
            </span>
          {/if}
        </div>
        <div class="sheet-actions">
          {#if actions}{@render actions()}{/if}
          <button type="button" class="sheet-close" onclick={onrequestclose} aria-label="Close">✕</button>
        </div>
      </header>
      <div class="sheet-body">
        <LiveScoreboardView {record} />
        {#if children}{@render children()}{/if}
      </div>
    </div>
  {/if}
</dialog>

<style>
  dialog.sheet {
    padding: 0;
    border: none;
    margin: auto;
    background: transparent;
    color: inherit;
    box-sizing: border-box;
    width: min(560px, calc(100vw - 2rem - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
    max-width: 100%;
    max-height: min(90dvh, 44rem);
    position: fixed;
    inset: 0;
  }
  dialog.sheet::backdrop {
    background: rgba(0, 0, 0, 0.88);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }
  .sheet-inner {
    background: #0f0f0f;
    border: 1px solid rgba(255, 213, 74, 0.55);
    border-radius: 1rem;
    padding: 0.85rem 1rem 1.1rem;
    max-height: min(90dvh, 44rem);
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    box-shadow:
      0 0 0 1px rgba(255, 213, 74, 0.35),
      0 0 32px rgba(255, 213, 74, 0.22),
      0 18px 60px rgba(0, 0, 0, 0.75);
    animation: fadeIn 0.18s ease-out;
  }
  @keyframes fadeIn {
    from { transform: scale(0.96); opacity: 0; }
    to   { transform: scale(1);    opacity: 1; }
  }
  .sheet-hdr {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0 0.75rem;
    margin: 0 -1rem 0.5rem;
    padding-left: 1rem;
    padding-right: 1rem;
    border-bottom: 1px solid #1e1e1e;
    background: #0f0f0f;
    position: sticky;
    top: -0.85rem;
    z-index: 3;
  }
  .sheet-inner :global(.hdr),
  .sheet-inner :global(.board) {
    position: static;
    background: #0f0f0f;
  }
  .sheet-title-wrap {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
    flex: 1 1 auto;
  }
  .sheet-title {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .sheet-subtitle {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
    line-height: 1.25;
    display: block;
    overflow-wrap: anywhere;
  }
  .sheet-live {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: #ef5350;
  }
  .sheet-live .dot {
    display: inline-block;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: #ef5350;
    animation: pulse 1.6s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  .sheet-tour {
    color: var(--gold, #ffd54f);
    letter-spacing: 0.02em;
    text-transform: none;
    font-weight: 600;
  }
  .sheet-round {
    color: rgba(255, 213, 74, 0.75);
    letter-spacing: 0.02em;
    text-transform: none;
    font-weight: 500;
  }
  .sheet-actions {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-shrink: 0;
  }
  .sheet-close {
    background: transparent;
    border: 1px solid #262626;
    color: var(--fg, #f5f5f5);
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    font-size: 1rem;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }
  .sheet-close:hover { background: #1a1a1a; border-color: #333; }
  .sheet-body {
    /* LiveScoreboardView handles its own spacing; children use their own margins */
  }
</style>
