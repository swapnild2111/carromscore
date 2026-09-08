/**
 * League format helpers (v4.0).
 *
 * Pure algorithms:
 *  - generateRoundRobinPairs   — circle-method scheduling for one group
 *  - potSeeding                — distribute players into groups by pot tier
 *  - computeGroupStandings     — rank players in a group from PlayerSummary
 *  - redistributeToFlights     — re-seed group finishers into knockout flights
 *  - singleEliminationPairs    — standard bracket seeding (1v16, 8v9 …)
 *
 * Orchestration:
 *  - generateLeagueSchedule    — creates rounds + planned matches for all groups
 *  - generateFlightTournaments — creates flight sub-tournaments from standings
 */

import type { LeagueCfg, LeagueGroup } from './tournaments';
import type { PlayerSummary } from './reports';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Sentinel player ID used as a bye in groups with odd/leftover player counts. */
export const PHANTOM_ID = '__phantom__';
export const PHANTOM_NAME = 'Phantom (bye)';

// ─── Types ──────────────────────────────────────────────────────────────────

export type RankedPlayer = PlayerSummary & {
  rank: number;
  groupKey: string;
  groupName: string;
};

export type GroupStandings = {
  groupKey: string;
  groupName: string;
  players: RankedPlayer[];
};

export type LeagueScheduleResult = {
  groupsCreated: number;
  matchesCreated: number;
  errors: string[];
};

export type FlightGenerationResult = {
  flightsCreated: string[];   // flight names successfully created as rounds on the parent
  errors: string[];
};

// ─── Round-robin scheduling ──────────────────────────────────────────────────

/**
 * Generate all C(N,2) pairings for N players using the circle method.
 * Returns pairs in scheduling order so no player appears in two concurrent
 * slots (important when multiple boards run simultaneously per group).
 *
 * For N even: fix player at index 0, rotate the rest N-1 times.
 * Each rotation produces floor(N/2) simultaneous pairings.
 * For N odd: pad with a bye at index 0, then strip bye pairings.
 */
export function generateRoundRobinPairs(playerIds: string[]): [string, string][] {
  const n = playerIds.length;
  if (n < 2) return [];

  const isOdd = n % 2 !== 0;
  const circle = isOdd ? ['__bye__', ...playerIds] : [...playerIds];
  const size = circle.length; // always even
  const rounds = size - 1;
  const pairs: [string, string][] = [];

  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < size / 2; i++) {
      const a = circle[i]!;
      const b = circle[size - 1 - i]!;
      if (a !== '__bye__' && b !== '__bye__') {
        pairs.push([a, b]);
      }
    }
    // Rotate circle[1..n-1] one step clockwise, keep circle[0] fixed
    const last = circle[size - 1]!;
    for (let i = size - 1; i > 1; i--) {
      circle[i] = circle[i - 1]!;
    }
    circle[1] = last;
  }

  return pairs;
}

// ─── Pot-based seeding ───────────────────────────────────────────────────────

/**
 * Distribute `playerIds` into `groupCount` groups using pot-based seeding.
 * Players are sorted by `potScore` DESC (higher = stronger). The top
 * `groupCount` players form pot 1 (one per group), next `groupCount` form
 * pot 2, etc. Within each pot, players are shuffled randomly before
 * assignment so champions don't always land in G1.
 *
 * Returns a Record of groupKey → LeagueGroup.
 */
export function potSeeding(
  playerIds: string[],
  playerNames: Map<string, string>,
  potScores: Map<string, number>,
  groupCount: number,
  groupNamePrefix = 'G',
): Record<string, LeagueGroup> {
  // Sort by pot score descending (unranked players go to last pot)
  const sorted = [...playerIds].sort((a, b) => {
    const sa = potScores.get(a) ?? -Infinity;
    const sb = potScores.get(b) ?? -Infinity;
    return sb - sa;
  });

  // Split into pots of groupCount
  const pots: string[][] = [];
  for (let i = 0; i < sorted.length; i += groupCount) {
    pots.push(sorted.slice(i, i + groupCount));
  }

  // Initialise empty groups
  const groups: Record<string, LeagueGroup> = {};
  for (let g = 0; g < groupCount; g++) {
    const gKey = `g${g + 1}`;
    groups[gKey] = {
      name: `${groupNamePrefix}${g + 1}`,
      order: g + 1,
      playerIds: [],
    };
  }

  // Assign: shuffle each pot, then one player per group in pot order
  for (const pot of pots) {
    const shuffled = shuffleArray([...pot]);
    for (let g = 0; g < groupCount && g < shuffled.length; g++) {
      const gKey = `g${g + 1}`;
      const pid = shuffled[g]!;
      groups[gKey]!.playerIds.push(pid);
    }
  }

  void playerNames; // used by callers for display — not needed here
  return groups;
}

/** Fisher-Yates shuffle — returns a new array. */
export function shuffleArray<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// ─── Group standings ─────────────────────────────────────────────────────────

/**
 * Rank players in a single group from pre-built PlayerSummary records.
 * Sort order: strikePoints DESC → netPoints DESC → boardsWon DESC → name ASC.
 */
export function computeGroupStandings(
  group: LeagueGroup,
  playerSummaries: PlayerSummary[],
): GroupStandings {
  const byId = new Map(playerSummaries.map((p) => [p.playerId, p]));

  const ranked = group.playerIds
    .map((pid) => byId.get(pid))
    .filter((p): p is PlayerSummary => p !== undefined)
    .sort((a, b) => {
      if (b.strikePoints !== a.strikePoints) return b.strikePoints - a.strikePoints;
      if (b.netPoints !== a.netPoints) return b.netPoints - a.netPoints;
      if (b.boardsWon !== a.boardsWon) return b.boardsWon - a.boardsWon;
      return a.name.localeCompare(b.name);
    })
    .map((p, i): RankedPlayer => ({
      ...p,
      rank: i + 1,
      groupKey: `g${group.order}`,
      groupName: group.name,
    }));

  return { groupKey: `g${group.order}`, groupName: group.name, players: ranked };
}

/**
 * Redistribute group finishers into flights.
 * Rank-1 and rank-2 from each group → flight[0] (Gold / Flight A).
 * Rank-3 and rank-4 → flight[1]. Rank-5 and rank-6 → flight[2]. Etc.
 *
 * Within each flight, seeding order is: rank-1 G1, rank-1 G2, …,
 * rank-2 G1, rank-2 G2, … — so same-rank players from different groups
 * are seeded sequentially and don't meet until later rounds.
 *
 * Returns: Map<flightName, playerIds[]> in seeding order (seed 1 first).
 */
export function redistributeToFlights(
  groups: LeagueGroup[],
  standingsMap: Map<string, GroupStandings>,
  flightNames: string[],
): Map<string, string[]> {
  const sortedGroups = [...groups].sort((a, b) => a.order - b.order);
  const ranksPerFlight = 2; // 2 rank positions fill each flight tier (ranks 1-2 → Gold, 3-4 → Silver, 5-6 → Bronze)

  const flights = new Map<string, string[]>(flightNames.map((n) => [n, []]));

  for (let flightIdx = 0; flightIdx < flightNames.length; flightIdx++) {
    const flightName = flightNames[flightIdx]!;
    const flightPlayers = flights.get(flightName)!;
    const startRank = flightIdx * ranksPerFlight + 1;
    const endRank = startRank + ranksPerFlight - 1; // strict — never bleed into the next flight's ranks

    for (let rank = startRank; rank <= endRank; rank++) {
      for (const group of sortedGroups) {
        const standings = standingsMap.get(group.name) ?? standingsMap.get(`g${group.order}`);
        const player = standings?.players.find((p) => p.rank === rank);
        if (player) flightPlayers.push(player.playerId);
      }
    }
  }

  return flights;
}

// ─── Knockout bracket seeding ─────────────────────────────────────────────────

/**
 * Standard single-elimination bracket seeding for 2^n players.
 * Seeds are 1-indexed; returns pairs in match order for round 1.
 * For 16 players: [1v16, 8v9, 5v12, 4v13, 6v11, 3v14, 7v10, 2v15]
 */
export function singleEliminationPairs(seeds: string[]): [string, string][] {
  const n = seeds.length;
  // Build the seeded bracket positions recursively
  function buildBracket(size: number): number[] {
    if (size === 2) return [1, 2];
    const prev = buildBracket(size / 2);
    const result: number[] = [];
    for (const s of prev) {
      result.push(s, size + 1 - s);
    }
    return result;
  }

  // Next power of 2 >= n
  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(n, 2))));
  const positions = buildBracket(bracketSize);

  const pairs: [string, string][] = [];
  for (let i = 0; i < positions.length; i += 2) {
    const seedA = positions[i]! - 1; // 0-indexed
    const seedB = positions[i + 1]! - 1;
    const playerA = seeds[seedA] ?? '';
    const playerB = seeds[seedB] ?? '';
    if (playerA && playerB) {
      pairs.push([playerA, playerB]);
    }
  }
  return pairs;
}

// ─── Schedule generation ──────────────────────────────────────────────────────

export type ScheduleParams = {
  tournamentKey: string;
  tournamentName: string;
  groups: Record<string, LeagueGroup>;
  leagueCfg: LeagueCfg;
  playerNames: Map<string, string>;   // playerId → display name
  playerResolvedIds: Map<string, string>; // playerId → same id (for planned.aResolvedId)
  defaults: {
    mode: 'singles' | 'doubles';
    bestOf: number;
    pointsTarget: number;
    maxBoards: number;
  };
  myUid: string;
};

/**
 * For each group: create a round + all C(N,2) planned matches.
 * Boards are assigned sequentially: G1 gets boards 1..boardsPerGroup,
 * G2 gets boards (boardsPerGroup+1)..(2*boardsPerGroup), etc.
 * Match pairs cycle across the group's boards by matchOrder.
 */
export async function generateLeagueSchedule(
  params: ScheduleParams,
): Promise<LeagueScheduleResult> {
  const { addRound, normalizeKey } = await import('./tournaments');
  const { createPlannedMatch } = await import('./planned');

  const {
    tournamentKey,
    tournamentName,
    groups,
    leagueCfg,
    playerNames,
    defaults,
    myUid,
  } = params;

  const { markPlannedComplete } = await import('./planned');

  const result: LeagueScheduleResult = { groupsCreated: 0, matchesCreated: 0, errors: [] };

  const sortedGroups = Object.entries(groups).sort(([, a], [, b]) => a.order - b.order);
  const targetPg = leagueCfg.playersPerGroup;
  const phantomScore = leagueCfg.walkovers?.phantomScore;
  const walkoversEnabled = typeof phantomScore === 'number';

  for (let gIdx = 0; gIdx < sortedGroups.length; gIdx++) {
    const [, group] = sortedGroups[gIdx]!;
    const roundName = `Group ${group.name}`;

    // Pad short groups with Phantom if walkovers are enabled
    const effectiveIds = [...group.playerIds];
    if (walkoversEnabled && effectiveIds.length < targetPg) {
      effectiveIds.push(PHANTOM_ID);
    }
    playerNames.set(PHANTOM_ID, PHANTOM_NAME);

    try {
      // Create the round for this group
      const roundOutcome = await addRound(tournamentKey, roundName);
      if (!roundOutcome.ok) {
        result.errors.push(`Group ${group.name}: round creation failed — ${roundOutcome.error}`);
        continue;
      }
      result.groupsCreated++;

      const roundKey = normalizeKey(roundName);
      const pairs = generateRoundRobinPairs(effectiveIds);

      // Board assignment: gIdx * boardsPerGroup + 1 = first board for this group
      const boardsPerGroup = Math.max(1, leagueCfg.boardsPerGroup);
      const firstBoard = gIdx * boardsPerGroup + 1;
      const boardCount = boardsPerGroup;

      for (let pIdx = 0; pIdx < pairs.length; pIdx++) {
        const [aId, bId] = pairs[pIdx]!;
        const aName = playerNames.get(aId) ?? aId;
        const bName = playerNames.get(bId) ?? bId;
        // Cycle boards within the group's allocation
        const board = firstBoard + (pIdx % boardCount);

        const matchOutcome = await createPlannedMatch({
          mode: defaults.mode,
          tournament: tournamentName,
          tournamentKey,
          round: roundName,
          roundKey,
          matchOrder: pIdx + 1,
          board,
          aName,
          aResolvedId: aId,
          bName,
          bResolvedId: bId,
          cfg: {
            bestOf: defaults.bestOf,
            pointsTarget: defaults.pointsTarget,
            maxBoards: defaults.maxBoards,
          },
          createdBy: myUid,
        });

        // Auto-complete phantom (bye) matches immediately
        const isPhantom = aId === PHANTOM_ID || bId === PHANTOM_ID;
        if (matchOutcome.ok && isPhantom && walkoversEnabled && matchOutcome.mid) {
          const winner = bId === PHANTOM_ID ? 'a' : 'b';
          const setsWon = Math.ceil(defaults.bestOf / 2);
          await markPlannedComplete(
            matchOutcome.mid,
            { setsA: winner === 'a' ? setsWon : 0, setsB: winner === 'b' ? setsWon : 0, winner },
            myUid,
          );
        }

        if (!matchOutcome.ok) {
          result.errors.push(
            `Group ${group.name} match ${pIdx + 1}: ${matchOutcome.error}`
          );
        } else {
          result.matchesCreated++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Group ${group.name}: ${msg}`);
    }
  }

  return result;
}

// ─── Flight generation ────────────────────────────────────────────────────────

export type FlightParams = {
  parentTournamentKey: string;
  parentTournamentName: string;
  flightSeeds: Map<string, string[]>;  // flightName → ordered playerIds (seed 1 first)
  playerNames: Map<string, string>;    // playerId → display name
  defaults: {
    mode: 'singles' | 'doubles';
    bestOf: number;
    pointsTarget: number;
    maxBoards: number;
    timerDuration?: number;
  };
  flightCfg?: Record<string, { bestOf?: number; pointsTarget?: number; maxBoards?: number; timerDuration?: number }>;
  myUid: string;
};

/**
 * Add flight knockout rounds directly onto the parent league tournament.
 * No sub-tournament records are created. Each flight gets 4 rounds named
 * "<FlightName> — R16", "<FlightName> — QF", etc., with seeded R16
 * planned matches and Winner M# placeholders for QF/SF/Final.
 */
export async function generateFlightTournaments(
  params: FlightParams,
): Promise<FlightGenerationResult> {
  const { addRound, normalizeKey } = await import('./tournaments');
  const { createPlannedMatch } = await import('./planned');

  const { parentTournamentKey, parentTournamentName, flightSeeds, playerNames, defaults, flightCfg, myUid } =
    params;

  const result: FlightGenerationResult = { flightsCreated: [], errors: [] };

  for (const [flightName, seeds] of flightSeeds) {
    if (seeds.length < 2) continue; // skip empty flights (e.g. Bronze with only 4-player groups)
    const fc = flightCfg?.[flightName] ?? {};
    try {
      // Build round structure based on actual bracket size
      const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(seeds.length, 2))));
      const allLabels = [
        { label: 'R32', matchCount: 16 },
        { label: 'R16', matchCount: 8 },
        { label: 'QF',  matchCount: 4 },
        { label: 'SF',  matchCount: 2 },
        { label: 'Final', matchCount: 1 },
      ];
      // Keep only rounds up to bracketSize (first round = bracketSize/2 matches)
      const roundDefs = allLabels
        .filter((r) => r.matchCount <= bracketSize / 2)
        .map((r) => ({ ...r, fullName: `${flightName} — ${r.label}` }));

      // Create rounds on the parent tournament
      const roundKeys: string[] = [];
      for (const rd of roundDefs) {
        const rOut = await addRound(parentTournamentKey, rd.fullName);
        if (!rOut.ok) {
          result.errors.push(`${rd.fullName}: addRound failed`);
        }
        roundKeys.push(normalizeKey(rd.fullName));
      }

      // Seed first-round planned matches
      const firstRoundKey = roundKeys[0]!;
      const firstRoundName = roundDefs[0]!.fullName;
      const timerMin = fc.timerDuration ?? defaults.timerDuration;
      const flightCfgEntry = {
        bestOf: fc.bestOf ?? defaults.bestOf,
        pointsTarget: fc.pointsTarget ?? defaults.pointsTarget,
        maxBoards: fc.maxBoards ?? defaults.maxBoards,
        ...(timerMin != null ? { format: `t${timerMin}` } : {}),
      };
      const pairs = singleEliminationPairs(seeds);
      for (let i = 0; i < pairs.length; i++) {
        const [aId, bId] = pairs[i]!;
        const aName = playerNames.get(aId) ?? aId;
        const bName = playerNames.get(bId) ?? bId;
        await createPlannedMatch({
          mode: defaults.mode,
          tournament: parentTournamentName,
          tournamentKey: parentTournamentKey,
          round: firstRoundName,
          roundKey: firstRoundKey,
          matchOrder: i + 1,
          aName,
          aResolvedId: aId,
          bName,
          bResolvedId: bId,
          cfg: flightCfgEntry,
          createdBy: myUid,
        });
      }

      // Subsequent round placeholder slots
      for (let ri = 1; ri < roundDefs.length; ri++) {
        const rd = roundDefs[ri]!;
        const rKey = roundKeys[ri]!;
        for (let i = 0; i < rd.matchCount; i++) {
          await createPlannedMatch({
            mode: defaults.mode,
            tournament: parentTournamentName,
            tournamentKey: parentTournamentKey,
            round: rd.fullName,
            roundKey: rKey,
            matchOrder: i + 1,
            aName: `Finalist ${i * 2 + 1}`,
            bName: `Finalist ${i * 2 + 2}`,
            cfg: flightCfgEntry,
            createdBy: myUid,
          });
        }
      }

      result.flightsCreated.push(flightName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`${flightName}: ${msg}`);
    }
  }

  return result;
}
