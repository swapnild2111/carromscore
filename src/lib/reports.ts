/**
 * Pure computation + serialisation for the /live/ Reports tab.
 *
 * Nothing here talks to Firebase or the DOM — LiveLobby feeds this
 * module the already-loaded `MatchRecord[]` array and it returns
 * plain data that the ReportsTab component renders.
 *
 * Practice records are excluded from every report: they have no
 * per-side stats concept, and the tournament tag is force-hidden
 * on the setup screen for practice mode, so they'd never bucket
 * into a tournament anyway. Filtered defensively at the top of
 * every builder in case a legacy record slipped through.
 */

import type { MatchRecord } from './history';
import { playerName } from './history';

/** One row of the per-match table. Mirrors the xlsx prototype. */
export type ReportRow = {
  matchId: string;      // last-6 of the RTDB push id
  endedAt: string;      // YYYY-MM-DD (UTC — matches the archive)
  endedAtRaw: number;   // epoch ms for sorting
  mode: 'Singles' | 'Doubles';
  sideA: string;        // 'Alice' or 'Alice & Bob'
  sideB: string;
  setsA: number;
  setsB: number;
  boardsWonA: number;
  boardsWonB: number;
  pointsA: number;
  pointsB: number;
  winner: 'A' | 'B' | 'Draw' | '';
  recordedBy: string;
};

/**
 * One entry in the per-player summary card. Ranked by wins DESC,
 * then boards-won DESC, then points DESC as tiebreakers.
 */
export type PlayerSummary = {
  playerId: string;   // resolved from playerAId / A2Id / BId / B2Id
  name: string;       // display name from playerName()
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  boardsWon: number;
  pointsScored: number;
};

export type TournamentReport = {
  tournament: string;
  matches: number;
  rows: ReportRow[];
  playerSummary: PlayerSummary[];
};

/**
 * Compute per-side boards-won by iterating boardLog.
 *
 * Uses `pointsA > pointsB` as the per-board winner signal — same
 * rule LiveScoreboardView applies at the set level. Trims legacy
 * phantom rows (pre-2026-08-09 records where boardLog.length can
 * exceed result.boardCount) so counts don't overshoot.
 */
function countBoardsWon(m: MatchRecord): { boardsWonA: number; boardsWonB: number } {
  let log = m.boardLog ?? [];
  const bc = m.result?.boardCount;
  if (typeof bc === 'number' && bc > 0 && log.length > bc) {
    log = log.slice(0, bc);
  }
  let a = 0;
  let b = 0;
  for (const entry of log) {
    const pa = entry.pointsA ?? 0;
    const pb = entry.pointsB ?? 0;
    if (pa > pb) a += 1;
    else if (pb > pa) b += 1;
    // ties on a single board (rare — umpire error) count for neither.
  }
  return { boardsWonA: a, boardsWonB: b };
}

/**
 * Format an endedAt epoch as YYYY-MM-DD in UTC. Timezone-neutral so
 * exports don't drift when opened on a different machine.
 */
function formatDate(endedAt: number | undefined): string {
  if (typeof endedAt !== 'number') return '';
  const d = new Date(endedAt);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

/**
 * Combined side name for a match record. Singles → single name;
 * doubles → 'Alice & Bob'. Falls back to 'Side A' / 'Side B' when
 * the player identity store hasn't hydrated yet (unusual because
 * LiveLobby primes it on mount).
 */
function teamName(m: MatchRecord, side: 'a' | 'b'): string {
  const p1Id = side === 'a' ? m.playerAId : m.playerBId;
  const p2Id = side === 'a' ? m.playerA2Id : m.playerB2Id;
  const n1 = p1Id ? playerName(p1Id) : '';
  const n2 = m.mode === 'doubles' && p2Id ? playerName(p2Id) : '';
  if (n1 && n2) return `${n1} & ${n2}`;
  return n1 || n2 || (side === 'a' ? 'Side A' : 'Side B');
}

/**
 * Build the per-match rows. Sorted newest first (matches the History
 * tab default). Practice + missing-mode records are dropped.
 */
export function buildReportRows(matches: MatchRecord[]): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const m of matches) {
    if (m.mode !== 'singles' && m.mode !== 'doubles') continue;
    const { boardsWonA, boardsWonB } = countBoardsWon(m);
    const winnerRaw = m.result?.winner ?? null;
    const winner: ReportRow['winner'] =
      winnerRaw === 'a' ? 'A'
      : winnerRaw === 'b' ? 'B'
      : winnerRaw === 'draw' ? 'Draw'
      : '';
    rows.push({
      matchId: m.id.slice(-6),
      endedAt: formatDate(m.endedAt),
      endedAtRaw: m.endedAt ?? 0,
      mode: m.mode === 'singles' ? 'Singles' : 'Doubles',
      sideA: teamName(m, 'a'),
      sideB: teamName(m, 'b'),
      setsA: m.result?.setsA ?? 0,
      setsB: m.result?.setsB ?? 0,
      boardsWonA,
      boardsWonB,
      pointsA: m.result?.finalPointsA ?? 0,
      pointsB: m.result?.finalPointsB ?? 0,
      winner,
      recordedBy: m.createdByName ?? '',
    });
  }
  rows.sort((a, b) => b.endedAtRaw - a.endedAtRaw);
  return rows;
}

/**
 * Aggregate per-player stats across a tournament's matches. Iterates
 * every player-slot (A/A2/B/B2) on each match; a doubles pair
 * contributes to both players' summaries. Draws don't count as wins
 * or losses for either side.
 */
export function buildPlayerSummary(matches: MatchRecord[]): PlayerSummary[] {
  const map = new Map<string, PlayerSummary>();

  function ensure(pid: string): PlayerSummary {
    let s = map.get(pid);
    if (!s) {
      s = {
        playerId: pid,
        name: playerName(pid),
        matches: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        boardsWon: 0,
        pointsScored: 0,
      };
      map.set(pid, s);
    }
    return s;
  }

  for (const m of matches) {
    if (m.mode !== 'singles' && m.mode !== 'doubles') continue;
    const { boardsWonA, boardsWonB } = countBoardsWon(m);
    const winner = m.result?.winner ?? null;
    const pointsA = m.result?.finalPointsA ?? 0;
    const pointsB = m.result?.finalPointsB ?? 0;

    const sideAIds = [m.playerAId, m.playerA2Id].filter((x): x is string => !!x);
    const sideBIds = [m.playerBId, m.playerB2Id].filter((x): x is string => !!x);

    for (const pid of sideAIds) {
      const s = ensure(pid);
      s.matches += 1;
      s.boardsWon += boardsWonA;
      s.pointsScored += pointsA;
      if (winner === 'a') s.wins += 1;
      else if (winner === 'b') s.losses += 1;
      else if (winner === 'draw') s.draws += 1;
    }
    for (const pid of sideBIds) {
      const s = ensure(pid);
      s.matches += 1;
      s.boardsWon += boardsWonB;
      s.pointsScored += pointsB;
      if (winner === 'b') s.wins += 1;
      else if (winner === 'a') s.losses += 1;
      else if (winner === 'draw') s.draws += 1;
    }
  }

  const out = Array.from(map.values());
  out.sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    if (b.boardsWon !== a.boardsWon) return b.boardsWon - a.boardsWon;
    return b.pointsScored - a.pointsScored;
  });
  return out;
}

/**
 * Top-level: filter matches to a tournament + build both reports.
 * `tournament === null` means untagged matches (Default bucket).
 */
export function buildTournamentReport(
  allMatches: MatchRecord[],
  tournament: string | null,
): TournamentReport {
  const filtered = allMatches.filter((m) => {
    if (m.mode === 'practice') return false;
    const tag = (m.tournament ?? '').trim();
    return tournament === null ? tag === '' : tag === tournament;
  });
  return {
    tournament: tournament ?? 'Default (untagged)',
    matches: filtered.length,
    rows: buildReportRows(filtered),
    playerSummary: buildPlayerSummary(filtered),
  };
}

// ─── Serialisation ──────────────────────────────────────────────

const CSV_HEADERS = [
  'Match ID',
  'Ended',
  'Mode',
  'Side A',
  'Side B',
  'Sets A',
  'Sets B',
  'Boards won A',
  'Boards won B',
  'Points A',
  'Points B',
  'Winner',
  'Recorded by',
];

function rowValues(r: ReportRow): (string | number)[] {
  return [
    r.matchId,
    r.endedAt,
    r.mode,
    r.sideA,
    r.sideB,
    r.setsA,
    r.setsB,
    r.boardsWonA,
    r.boardsWonB,
    r.pointsA,
    r.pointsB,
    r.winner,
    r.recordedBy,
  ];
}

/**
 * RFC-4180 CSV: quote fields that contain commas, quotes, or newlines.
 * Double any embedded quotes. Line terminator is CRLF for maximum
 * compatibility with Excel on Windows (Sheets/macOS Excel accept
 * either).
 */
function csvEscape(v: string | number): string {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}
export function toCSV(rows: ReportRow[]): string {
  const header = CSV_HEADERS.map(csvEscape).join(',');
  const body = rows.map((r) => rowValues(r).map(csvEscape).join(',')).join('\r\n');
  return body ? `${header}\r\n${body}` : header;
}

/**
 * TSV for clipboard. Sheets / Excel / Notion / etc. all parse
 * tab-separated pasted content into cells. No quoting needed —
 * tabs and newlines inside cells would break things, but neither
 * appears in our field set (names are trimmed at write time).
 */
export function toTSV(rows: ReportRow[]): string {
  const header = CSV_HEADERS.join('\t');
  const body = rows.map((r) => rowValues(r).join('\t')).join('\n');
  return body ? `${header}\n${body}` : header;
}

/**
 * Trigger a browser download for a text blob. Standard pattern —
 * anchor + createObjectURL + click + revoke. No library dep.
 */
export function downloadTextFile(filename: string, mime: string, contents: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * URL-safe slug from a tournament display name. Used for the CSV
 * filename. Mirrors the tournament key normaliser roughly but
 * simpler — this doesn't need to hit RTDB, just be filename-safe.
 */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'tournament';
}
