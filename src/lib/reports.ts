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

/**
 * One row of the per-match table. The Firebase push id is retained
 * as `_matchId` for row-key stability in Svelte's `{#each}` block
 * but never surfaced to users — it's noise (a hex string) and the
 * user-visible identity of a match is (Ended + Side A + Side B).
 * Underscore prefix marks it as internal.
 */
export type ReportRow = {
  _matchId: string;     // Firebase push id, keyed on the row, not shown
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
  /**
   * Per-round breakdowns (v3.2). Empty when the tournament has no
   * matches with a round tag, so pre-v3.2 tournament reports render
   * exactly as before (just the combined view). Ordered by the
   * tournament's `rounds` array from tournaments.ts when available,
   * falling back to alphabetical for tags that don't map to a known
   * round record. An "Unassigned" bucket lands at the tail for
   * matches with a tournament tag but no round tag.
   */
  roundReports?: RoundReport[];
};

/**
 * One round's slice of the tournament report. `roundKey` matches the
 * archived match's `roundKey` field (or the sentinel
 * UNASSIGNED_ROUND_KEY for the tail bucket); `roundName` is the
 * display header text.
 */
export type RoundReport = {
  roundKey: string;
  roundName: string;
  matches: number;
  rows: ReportRow[];
  playerSummary: PlayerSummary[];
};

/** Sentinel roundKey for the "matches under this tournament with no
 *  round tag" bucket. Mirrors LiveLobby's UNASSIGNED_ROUND_KEY. */
export const UNASSIGNED_ROUND_KEY = '__unassigned__';

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
    // RTDB stores arrays as sparse maps — an admin delete of a
    // single boardLog index in Firebase Console leaves a null hole
    // rather than compacting the array. `entry.pointsA` on that
    // null throws (reported 2026-08-30: selecting Friendly Match
    // tournament crashed the Reports tab because one of its matches
    // had a null hole in the boardLog). Same defensive filter every
    // other boardLog consumer uses.
    if (!entry || typeof entry !== 'object') continue;
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
 * doubles → 'Alice & Bob'. Uses the denormalised aName/bName/a2Name/
 * b2Name stamped on the match record as fallback so a record whose
 * playerId points at a deleted or unhydrated player still renders
 * the umpire-typed name — matching what the History card shows.
 */
function teamName(m: MatchRecord, side: 'a' | 'b'): string {
  const p1Id = side === 'a' ? m.playerAId : m.playerBId;
  const p2Id = side === 'a' ? m.playerA2Id : m.playerB2Id;
  const fb1 = side === 'a' ? m.aName : m.bName;
  const fb2 = side === 'a' ? m.a2Name : m.b2Name;
  const n1 = playerName(p1Id, fb1);
  const n2 = m.mode === 'doubles' ? playerName(p2Id, fb2) : '';
  if (n1 && n2) return `${n1} & ${n2}`;
  return n1 || n2 || (side === 'a' ? 'Side A' : 'Side B');
}

/**
 * Build the per-match rows. Sorted newest first (matches the History
 * tab default). Practice + missing-mode records are dropped.
 */
const WINNER_LABEL: Record<'a' | 'b' | 'draw', ReportRow['winner']> = {
  a: 'A',
  b: 'B',
  draw: 'Draw',
};

export function buildReportRows(matches: MatchRecord[]): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const m of matches) {
    // Skip malformed / null entries — defensive against RTDB null
    // holes (rare, but a single one crashes the whole report).
    if (!m || typeof m !== 'object') continue;
    if (m.mode !== 'singles' && m.mode !== 'doubles') continue;
    const { boardsWonA, boardsWonB } = countBoardsWon(m);
    const winnerRaw = m.result?.winner ?? null;
    const winner: ReportRow['winner'] = winnerRaw ? WINNER_LABEL[winnerRaw] : '';
    rows.push({
      _matchId: m.id,
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
/** Fresh zeroed summary for a newly-seen player id. */
function emptyPlayerSummary(pid: string): PlayerSummary {
  return {
    playerId: pid,
    name: playerName(pid),
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    boardsWon: 0,
    pointsScored: 0,
  };
}

/**
 * Accumulate one side's contribution to each of its players' rolling
 * summaries. Called twice per match (side A + side B) with the values
 * relevant to that side. Draws increment `draws`; wins on the OTHER
 * side become `losses` here.
 */
function accumulateSide(
  map: Map<string, PlayerSummary>,
  playerIds: string[],
  boardsWon: number,
  pointsScored: number,
  wasWin: boolean,
  wasLoss: boolean,
  wasDraw: boolean,
): void {
  for (const pid of playerIds) {
    const s = map.get(pid) ?? emptyPlayerSummary(pid);
    s.matches += 1;
    s.boardsWon += boardsWon;
    s.pointsScored += pointsScored;
    if (wasWin) s.wins += 1;
    else if (wasLoss) s.losses += 1;
    else if (wasDraw) s.draws += 1;
    map.set(pid, s);
  }
}

// Guard added v3.4.12: same null-hole defence as buildReportRows /
// countBoardsWon.
export function buildPlayerSummary(matches: MatchRecord[]): PlayerSummary[] {
  const map = new Map<string, PlayerSummary>();

  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    if (m.mode !== 'singles' && m.mode !== 'doubles') continue;
    const { boardsWonA, boardsWonB } = countBoardsWon(m);
    const winner = m.result?.winner ?? null;
    const pointsA = m.result?.finalPointsA ?? 0;
    const pointsB = m.result?.finalPointsB ?? 0;

    const sideAIds = [m.playerAId, m.playerA2Id].filter((x): x is string => !!x);
    const sideBIds = [m.playerBId, m.playerB2Id].filter((x): x is string => !!x);
    const isDraw = winner === 'draw';

    accumulateSide(map, sideAIds, boardsWonA, pointsA, winner === 'a', winner === 'b', isDraw);
    accumulateSide(map, sideBIds, boardsWonB, pointsB, winner === 'b', winner === 'a', isDraw);
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
 *
 * `roundRoster` (v3.2) is the list of rounds attached to the
 * tournament record — passed in from the caller (LiveLobby /
 * ReportsTab reads it via loadRounds). Used to sort roundReports in
 * the tournament's declared order (R16 → QF → SF → F). Optional; a
 * missing roster produces reports ordered alphabetically by round
 * name.
 */
export function buildTournamentReport(
  allMatches: MatchRecord[],
  tournament: string | null,
  roundRoster?: Array<{ key: string; name: string; order: number }>,
): TournamentReport {
  const filtered = allMatches.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (m.mode === 'practice') return false;
    const tag = (m.tournament ?? '').trim();
    return tournament === null ? tag === '' : tag === tournament;
  });
  const roundReports = buildRoundReports(filtered, roundRoster ?? []);
  return {
    tournament: tournament ?? 'Default',
    matches: filtered.length,
    rows: buildReportRows(filtered),
    playerSummary: buildPlayerSummary(filtered),
    ...(roundReports.length > 0 ? { roundReports } : {}),
  };
}

/**
 * Group the tournament's filtered matches by roundKey and build a
 * sub-report per bucket. Rounds present in `roundRoster` appear
 * first, in the roster's `order` field; ghost rounds (tagged on
 * matches but absent from the roster — organiser deleted the round)
 * follow alphabetically; the Unassigned bucket lands last.
 *
 * Returns [] when NO match in the input carries a roundKey — that
 * signals the tournament isn't using rounds at all, and the outer
 * report should render just its combined view without the accordion.
 */
function buildRoundReports(
  matches: MatchRecord[],
  roundRoster: Array<{ key: string; name: string; order: number }>,
): RoundReport[] {
  const hasAnyRound = matches.some((m) => !!m && (m.roundKey ?? '').trim() !== '');
  if (!hasAnyRound) return [];
  const rosterMap = new Map(roundRoster.map((r) => [r.key, r]));
  const known = new Map<string, MatchRecord[]>();
  const ghost = new Map<string, { name: string; items: MatchRecord[] }>();
  const unassigned: MatchRecord[] = [];
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const rk = (m.roundKey ?? '').trim();
    if (!rk) {
      unassigned.push(m);
      continue;
    }
    if (rosterMap.has(rk)) {
      const list = known.get(rk) ?? [];
      list.push(m);
      known.set(rk, list);
    } else {
      const bucket = ghost.get(rk) ?? { name: (m.round ?? '').trim() || rk, items: [] };
      bucket.items.push(m);
      ghost.set(rk, bucket);
    }
  }
  const out: RoundReport[] = [];
  const rosterSorted = [...roundRoster].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  for (const r of rosterSorted) {
    const items = known.get(r.key);
    if (items && items.length > 0) {
      out.push({
        roundKey: r.key,
        roundName: r.name,
        matches: items.length,
        rows: buildReportRows(items),
        playerSummary: buildPlayerSummary(items),
      });
    }
  }
  const ghostKeys = Array.from(ghost.keys()).sort();
  for (const gk of ghostKeys) {
    const b = ghost.get(gk)!;
    out.push({
      roundKey: gk,
      roundName: b.name,
      matches: b.items.length,
      rows: buildReportRows(b.items),
      playerSummary: buildPlayerSummary(b.items),
    });
  }
  if (unassigned.length > 0) {
    out.push({
      roundKey: UNASSIGNED_ROUND_KEY,
      roundName: 'Unassigned',
      matches: unassigned.length,
      rows: buildReportRows(unassigned),
      playerSummary: buildPlayerSummary(unassigned),
    });
  }
  return out;
}

// ─── Serialisation ──────────────────────────────────────────────

const CSV_HEADERS = [
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
];

function rowValues(r: ReportRow): (string | number)[] {
  return [
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
