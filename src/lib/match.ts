/**
 * MatchConfig lives in the URL as a small querystring so a match link is
 * shareable and refresh-safe. Live scores live in localStorage keyed by matchId.
 */

export type Format = 'india' | 'europe' | 'custom';
export type Mode = 'singles' | 'doubles';

export type MatchConfig = {
  format: Format;
  mode: Mode;
  playerA: string;   // singles: sole player. doubles: 1st player of team A.
  playerA2: string;  // doubles only: 2nd player of team A.
  playerB: string;
  playerB2: string;
  bestOf: number;       // number of sets in the match (India=3, Europe=1)
  pointsTarget: number; // set ends when a side reaches this (default 25)
  maxBoards: number;    // set ends when this many boards have been played (default 8)
  minutesPerSet: number | null; // null = no time limit
};

export const DEFAULT_CONFIG: MatchConfig = {
  format: 'india',
  mode: 'singles',
  playerA: '',
  playerA2: '',
  playerB: '',
  playerB2: '',
  bestOf: 3,
  pointsTarget: 25,
  maxBoards: 8,
  minutesPerSet: null,
};

export function formatPreset(format: Format): Partial<MatchConfig> {
  switch (format) {
    case 'india':
      return { bestOf: 3, pointsTarget: 25, maxBoards: 8 };
    case 'europe':
      return { bestOf: 1, pointsTarget: 25, maxBoards: 8 };
    case 'custom':
      return {};
  }
}

const QUERY_KEYS: (keyof MatchConfig)[] = [
  'format',
  'mode',
  'playerA',
  'playerA2',
  'playerB',
  'playerB2',
  'bestOf',
  'pointsTarget',
  'maxBoards',
  'minutesPerSet',
];

export function encodeConfig(cfg: MatchConfig): string {
  const p = new URLSearchParams();
  for (const key of QUERY_KEYS) {
    const v = cfg[key];
    if (v === null || v === '' || v === undefined) continue;
    p.set(key, String(v));
  }
  return p.toString();
}

function parseInRange(raw: string | null, min: number, max = Infinity): number | null {
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function parseMinutes(raw: string | null): number | null | undefined {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseFormat(raw: string | null): Format | null {
  return raw === 'india' || raw === 'europe' || raw === 'custom' ? raw : null;
}

function parseMode(raw: string | null): Mode | null {
  return raw === 'singles' || raw === 'doubles' ? raw : null;
}

export function decodeConfig(query: URLSearchParams): MatchConfig {
  const out: MatchConfig = { ...DEFAULT_CONFIG };
  const fmt = parseFormat(query.get('format'));
  if (fmt) out.format = fmt;
  const mode = parseMode(query.get('mode'));
  if (mode) out.mode = mode;

  out.playerA = query.get('playerA') || out.playerA;
  out.playerA2 = query.get('playerA2') || out.playerA2;
  out.playerB = query.get('playerB') || out.playerB;
  out.playerB2 = query.get('playerB2') || out.playerB2;

  const bestOf = parseInRange(query.get('bestOf'), 1, 9);
  if (bestOf !== null) out.bestOf = bestOf;
  const pointsTarget = parseInRange(query.get('pointsTarget'), 1);
  if (pointsTarget !== null) out.pointsTarget = pointsTarget;
  const maxBoards = parseInRange(query.get('maxBoards'), 1);
  if (maxBoards !== null) out.maxBoards = maxBoards;

  const mps = parseMinutes(query.get('minutesPerSet'));
  if (mps !== undefined) out.minutesPerSet = mps;

  return out;
}

export function teamLabel(name: string, partner: string, mode: Mode): string {
  if (mode === 'singles') return name;
  const a = name.trim();
  const b = partner.trim();
  if (a && b) return `${a} & ${b}`;
  return a || b;
}

/**
 * Which side wins the current set, given the current points, or null if tied.
 */
export function setLeader(pointsA: number, pointsB: number): 'a' | 'b' | null {
  if (pointsA > pointsB) return 'a';
  if (pointsB > pointsA) return 'b';
  return null;
}

/**
 * Given the current set state, decide if the set has ended and why.
 * Returns null if the set is still in progress.
 */
export type SetEndReason = 'points' | 'boards' | 'time';
export function evaluateSetEnd(args: {
  pointsA: number;
  pointsB: number;
  boardsPlayed: number;
  elapsedSeconds: number;
  cfg: Pick<MatchConfig, 'pointsTarget' | 'maxBoards' | 'minutesPerSet'>;
}): SetEndReason | null {
  const { pointsA, pointsB, boardsPlayed, elapsedSeconds, cfg } = args;
  if (pointsA >= cfg.pointsTarget || pointsB >= cfg.pointsTarget) return 'points';
  if (boardsPlayed >= cfg.maxBoards) return 'boards';
  if (cfg.minutesPerSet !== null && elapsedSeconds >= cfg.minutesPerSet * 60) return 'time';
  return null;
}

/**
 * Player-list JSON shape (public/data/players.json). Only fields the picker cares about.
 */
export type PlayerRow = {
  name: string;
  country?: string;
  city?: string;
  club?: string;
  source: string;
};
