/**
 * MatchConfig lives in the URL as a small querystring so a match link is
 * shareable and refresh-safe. Live scores live in localStorage keyed by matchId.
 *
 * Auto set-end / auto match-end / timer are deliberately NOT part of this
 * model any more (see v1.6.0 changelog). The app is a display + human-driven
 * scoreboard: users bump SET / POINTS / BOARD themselves via tap or swipe.
 * The only automatic behaviour left is: (a) the winner-highlight when a
 * side manually reaches bestOf/2+1 sets, and (b) the leader badges under
 * POINTS which are pure display.
 */

/**
 * Match format — named by rules, not region, because the same rules appear in
 * multiple tournaments. Mapping to real tournaments (for the setup UI copy):
 *   - 'bo3'              → India Bo3, EuroCup singles, most national leagues
 *   - 'single'           → European league play (single set to 25, cap 8 boards)
 *   - 'single-unlimited' → EuroCup doubles final (single set, no board cap)
 */
export type Format = 'bo3' | 'single' | 'single-unlimited' | 'custom';
export type Mode = 'singles' | 'doubles' | 'practice';
export type Side = 'a' | 'b';

export type MatchConfig = {
  format: Format;
  mode: Mode;
  playerA: string;   // singles: sole player. doubles: 1st player of team A.
  playerA2: string;  // doubles only: 2nd player of team A.
  playerB: string;
  playerB2: string;
  // Free-form suffix / tag rendered next to each player pill on the scoreboard.
  // Common uses: club abbreviation, city, sponsor, seed number. Optional.
  noteA: string;
  noteB: string;
  bestOf: number;       // number of sets in the match (India=3, Europe/EuroCup=1)
  pointsTarget: number; // POINTS clamp (default 25)
  maxBoards: number;    // BOARD cap (default 8, 0 for unlimited in EuroCup)
};

export const DEFAULT_CONFIG: MatchConfig = {
  format: 'bo3',
  mode: 'singles',
  playerA: '',
  playerA2: '',
  playerB: '',
  playerB2: '',
  noteA: '',
  noteB: '',
  bestOf: 3,
  pointsTarget: 25,
  maxBoards: 8,
};

export function formatPreset(format: Format): Partial<MatchConfig> {
  switch (format) {
    case 'bo3':
      return { bestOf: 3, pointsTarget: 25, maxBoards: 8 };
    case 'single':
      return { bestOf: 1, pointsTarget: 25, maxBoards: 8 };
    case 'single-unlimited':
      // EuroCup doubles final: single set, 25 points, no board cap.
      return { bestOf: 1, pointsTarget: 25, maxBoards: 0 };
    case 'custom':
      return {};
  }
}

/**
 * True if the match has no upper limit on boards per set. Represented as
 * maxBoards === 0 in the config for URL-encoding compactness.
 */
export function isBoardsUnlimited(cfg: Pick<MatchConfig, 'maxBoards'>): boolean {
  return cfg.maxBoards === 0;
}

const QUERY_KEYS: (keyof MatchConfig)[] = [
  'format',
  'mode',
  'playerA',
  'playerA2',
  'playerB',
  'playerB2',
  'noteA',
  'noteB',
  'bestOf',
  'pointsTarget',
  'maxBoards',
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

function parseFormat(raw: string | null): Format | null {
  return raw === 'bo3' || raw === 'single' || raw === 'single-unlimited' || raw === 'custom'
    ? raw
    : null;
}

function parseMode(raw: string | null): Mode | null {
  return raw === 'singles' || raw === 'doubles' || raw === 'practice' ? raw : null;
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
  out.noteA = query.get('noteA') || out.noteA;
  out.noteB = query.get('noteB') || out.noteB;

  const bestOf = parseInRange(query.get('bestOf'), 1, 9);
  if (bestOf !== null) out.bestOf = bestOf;
  const pointsTarget = parseInRange(query.get('pointsTarget'), 1);
  if (pointsTarget !== null) out.pointsTarget = pointsTarget;
  // 0 is a valid maxBoards value (EuroCup unlimited).
  const maxBoards = parseInRange(query.get('maxBoards'), 0);
  if (maxBoards !== null) out.maxBoards = maxBoards;

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
 * localStorage key for a match's in-flight state, derived from mode + player
 * names so a refresh mid-match restores the same key. Mode is part of the key
 * so a Practice run with only playerA doesn't collide with a Singles match
 * where playerB was left blank. Setup wipes this key before starting so
 * "same players again" always begins at 0-0.
 */
export function matchStateKey(mode: Mode, playerA: string, playerB: string): string {
  return `carromscore:state:${mode}:${playerA}:${playerB}`;
}

/**
 * Player-list JSON shape (public/data/players.json).
 *
 * The bundled seed is a small hand-curated list of players who have a
 * public Wikipedia article. Users grow their local roster by simply
 * typing new names in the setup picker — those names are remembered per
 * device (see src/lib/known-players.ts). `source: 'local'` marks such
 * entries; `source: 'wikipedia'` marks bundled entries with a `wikiUrl`.
 */
export type PlayerRow = {
  name: string;
  country?: string;
  source: string;
  wikiUrl?: string;
};
