/**
 * Group Knockout tournament format.
 *
 * Phase 1: players split into groups; each group plays a mini
 * single-elimination bracket. Top 2 per group advance.
 *
 * Phase 2: combined knockout drawn with cross-pairing:
 *   match k pairs A[k] vs B[G+1-k]  (1-indexed)
 * Same-group players can only meet in the Final for G ≤ 4.
 */

import type { LeagueGroup } from './tournaments';

export type GroupPhaseResult = {
  roundsCreated: string[];
  matchesCreated: number;
  errors: string[];
};

export type CombinedKOResult = {
  roundsCreated: string[];
  matchesCreated: number;
  errors: string[];
};

// ─── Group recommendation ─────────────────────────────────────────────────────

/**
 * Recommend a group structure that maximises board utilisation.
 *
 * A group of size S has floor(S/2) simultaneous matches in round 1.
 * With G groups the venue needs G * floor(S/2) boards.
 * We score candidates by how closely they hit venueBoards.
 */
export function recommendGroups(
  totalPlayers: number,
  venueBoards: number,
): { groupCount: number; groupSize: number } {
  if (totalPlayers < 2) return { groupCount: 1, groupSize: totalPlayers };

  const MAX_GROUPS = 4; // guarantees same-group players only meet in Final
  const candidates: Array<{ groupCount: number; groupSize: number; score: number }> = [];

  for (let g = 2; g <= Math.min(MAX_GROUPS, Math.floor(totalPlayers / 2)); g++) {
    const size = Math.ceil(totalPlayers / g);
    // R1 matches per group (groups play sequentially if boards < total R1 matches).
    // Score by how well a single group's R1 fills the available boards.
    const r1PerGroup = Math.floor(size / 2);
    const score = Math.abs(r1PerGroup - venueBoards); // 0 = one group fills boards perfectly
    candidates.push({ groupCount: g, groupSize: size, score });
  }

  // Lowest score = one group's R1 fills boards most fully; break ties in favour of more groups
  candidates.sort((a, b) => a.score - b.score || b.groupCount - a.groupCount);
  return { groupCount: candidates[0]!.groupCount, groupSize: candidates[0]!.groupSize };
}

// ─── Phase 1: per-group knockout brackets ────────────────────────────────────

export type GroupPhaseParams = {
  tournamentKey: string;
  tournamentName: string;
  groups: Record<string, LeagueGroup>;
  playerNames: Map<string, string>;
  defaults: {
    mode: 'singles' | 'doubles';
    bestOf: number;
    pointsTarget: number;
    maxBoards: number;
    timerDuration?: number;
  };
  myUid: string;
};

/**
 * Generate Phase 1: one single-elimination bracket per group.
 *
 * Pre-qualify aware:
 *   - Players in group.preQualifyIds play Round 1 (sequential pairs: 1v2, 3v4…).
 *   - Players NOT in preQualifyIds receive a bye and enter directly at Round 2.
 *   - Pre-qualify round winners fill the remaining Round 2 slots in order.
 *   - If no preQualifyIds are set, the old behaviour applies: all players enter
 *     at Round 1 (sequential pairs), with an odd-one-out bye if group is odd.
 *
 * Group of 2: single match (both qualify — winner=1st, loser=2nd).
 * Group of 1: validation error.
 */
export async function generateGroupPhase(
  params: GroupPhaseParams,
): Promise<GroupPhaseResult> {
  const { addRound, normalizeKey } = await import('./tournaments');
  const { createPlannedMatch } = await import('./planned');

  const { tournamentKey, tournamentName, groups, playerNames, defaults, myUid } = params;
  const result: GroupPhaseResult = { roundsCreated: [], matchesCreated: 0, errors: [] };

  const cfg = {
    bestOf: defaults.bestOf,
    pointsTarget: defaults.pointsTarget,
    maxBoards: defaults.maxBoards,
    ...(defaults.timerDuration != null ? { format: `t${defaults.timerDuration}` } : {}),
  };

  const sortedGroups = Object.values(groups).sort((a, b) => a.order - b.order);

  for (const group of sortedGroups) {
    const { name: groupName, playerIds, preQualifyIds } = group;
    const size = playerIds.length;

    if (size < 1) continue;
    if (size === 1) {
      result.errors.push(`Group "${groupName}" has only 1 player — move them to another group`);
      continue;
    }

    const pqSet = new Set(preQualifyIds ?? []);
    const hasPQ = pqSet.size >= 2; // need at least 2 to form a pre-qualify round

    if (!hasPQ) {
      // ── No pre-qualify: classic bracket (all players, sequential pairs) ──────
      await generateClassicGroupBracket({
        groupName, playerIds, playerNames, tournamentKey, tournamentName,
        defaults, cfg, myUid, result, addRound, normalizeKey, createPlannedMatch,
      });
      continue;
    }

    // ── Pre-qualify bracket ───────────────────────────────────────────────────
    // pqPlayers: subset of playerIds that are in preQualifyIds (in playerIds order)
    // byePlayers: the rest (in playerIds order)
    const pqPlayers = playerIds.filter((id) => pqSet.has(id));
    const byePlayers = playerIds.filter((id) => !pqSet.has(id));
    const pqPairs = seededPairs(pqPlayers);
    const pqWinnerCount = pqPairs.length; // one winner per R1 match

    // Total R2 slots = byePlayers + pqWinnerCount
    const r2TotalSlots = byePlayers.length + pqWinnerCount;

    // Build the full bracket from R2 upwards
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(r2TotalSlots, 2))));

    // Round labels: R1 (pre-qualify), then the main bracket rounds from R2 up
    const mainRoundDefs = buildGroupRoundDefs(groupName, bracketSize, false);
    // mainRoundDefs[0] is the "first round" of the main bracket (R2 in our scenario)
    // Prepend the Pre-qualify round
    const pqRoundLabel = `${groupName} — Pre-qualify`;
    const allRoundDefs = [{ label: pqRoundLabel }, ...mainRoundDefs];

    const roundKeys: string[] = [];
    for (const rd of allRoundDefs) {
      const rOut = await addRound(tournamentKey, rd.label);
      if (!rOut.ok) result.errors.push(`${rd.label}: addRound failed`);
      roundKeys.push(normalizeKey(rd.label));
      result.roundsCreated.push(rd.label);
    }

    // ── Round 1: pre-qualify matches (real players) ───────────────────────────
    const pqRKey = roundKeys[0]!;
    for (let i = 0; i < pqPairs.length; i++) {
      const [aId, bId] = pqPairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: pqRoundLabel, roundKey: pqRKey, matchOrder: i + 1, board: i + 1,
        aName: playerNames.get(aId) ?? aId, aResolvedId: aId,
        bName: playerNames.get(bId) ?? bId, bResolvedId: bId,
        cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // ── Round 2 (main bracket R1): players in original sequence ──────────────
    // Maintain the original playerIds order: each consecutive PQ pair is replaced
    // by one winner placeholder in the same position. This ensures the adjacent
    // bye player faces the PQ winner, matching the sequential bracket in the PDF.
    // Example: [1,2,3,4,5,6, 7,8, 9,10] with {7,8} and {9,10} as PQ →
    //   r2 = [1,2,3,4,5,6, pqW1, pqW2] (winners replace their pairs in sequence)
    const r2Label = mainRoundDefs[0]!.label;
    const r2Key = roundKeys[1]!;

    // Walk playerIds in order, replacing each consecutive PQ pair with a winner slot
    let pqPairIdx = 0;
    const r2Slots: Array<{ name: string; resolvedId?: string }> = [];
    {
      let i = 0;
      while (i < playerIds.length) {
        const id = playerIds[i]!;
        if (pqSet.has(id)) {
          // This player is PQ — consume them and the next PQ player as a pair
          r2Slots.push({ name: `${groupName} Pre-qualify Winner ${pqPairIdx + 1}` });
          pqPairIdx++;
          // Skip both players in this PQ pair
          i += 2;
        } else {
          r2Slots.push({ name: playerNames.get(id) ?? id, resolvedId: id });
          i++;
        }
      }
    }

    const r2PairsWithIds: Array<[{ name: string; resolvedId?: string }, { name: string; resolvedId?: string }]> = [];
    for (let i = 0; i + 1 < r2Slots.length; i += 2) {
      r2PairsWithIds.push([r2Slots[i]!, r2Slots[i + 1]!]);
    }

    let r2MatchOrder = 1;
    for (const [slotA, slotB] of r2PairsWithIds) {
      const mo = r2MatchOrder++;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: r2Label, roundKey: r2Key, matchOrder: mo, board: mo,
        aName: slotA.name, ...(slotA.resolvedId ? { aResolvedId: slotA.resolvedId } : {}),
        bName: slotB.name, ...(slotB.resolvedId ? { bResolvedId: slotB.resolvedId } : {}),
        cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }
    // If r2Slots has odd count, last slot gets a bye placeholder match
    if (r2Slots.length % 2 !== 0) {
      const lastSlot = r2Slots.at(-1)!;
      const mo = r2MatchOrder++;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: r2Label, roundKey: r2Key, matchOrder: mo, board: mo,
        aName: lastSlot.name, ...(lastSlot.resolvedId ? { aResolvedId: lastSlot.resolvedId } : {}),
        bName: `${groupName} Bye`,
        cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // ── Subsequent rounds: placeholder halving ────────────────────────────────
    let prevCount = r2PairsWithIds.length + (r2Slots.length % 2 !== 0 ? 1 : 0);
    for (let ri = 2; ri < allRoundDefs.length; ri++) {
      const rd = allRoundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const slotCount = Math.max(1, Math.ceil(prevCount / 2));
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode, tournament: tournamentName, tournamentKey,
          round: rd.label, roundKey: rKey, matchOrder: i + 1, board: i + 1,
          aName: `${groupName} Winner ${i * 2 + 1}`,
          bName: `${groupName} Winner ${i * 2 + 2}`,
          cfg, createdBy: myUid,
        });
      }
      result.matchesCreated += slotCount;
      prevCount = slotCount;
    }
  }

  return result;
}

/**
 * Classic group bracket: all players enter at Round 1, sequential pairs (1v2, 3v4…).
 * Odd group: top seed gets a bye and enters the Final directly.
 */
async function generateClassicGroupBracket(opts: {
  groupName: string;
  playerIds: string[];
  playerNames: Map<string, string>;
  tournamentKey: string;
  tournamentName: string;
  defaults: GroupPhaseParams['defaults'];
  cfg: Record<string, unknown>;
  myUid: string;
  result: GroupPhaseResult;
  addRound: (key: string, name: string) => Promise<{ ok: boolean }>;
  normalizeKey: (name: string) => string;
  createPlannedMatch: (opts: Record<string, unknown>) => Promise<unknown>;
}): Promise<void> {
  const { groupName, playerIds, playerNames, tournamentKey, tournamentName,
    defaults, cfg, myUid, result, addRound, normalizeKey, createPlannedMatch } = opts;
  const size = playerIds.length;

  if (size === 2) {
    const roundLabel = `${groupName} — Final`;
    const rOut = await addRound(tournamentKey, roundLabel);
    if (!rOut.ok) result.errors.push(`${roundLabel}: addRound failed`);
    result.roundsCreated.push(roundLabel);
    await createPlannedMatch({
      mode: defaults.mode, tournament: tournamentName, tournamentKey,
      round: roundLabel, roundKey: normalizeKey(roundLabel), matchOrder: 1, board: 1,
      aName: playerNames.get(playerIds[0]!) ?? playerIds[0]!,
      aResolvedId: playerIds[0]!,
      bName: playerNames.get(playerIds[1]!) ?? playerIds[1]!,
      bResolvedId: playerIds[1]!,
      cfg, createdBy: myUid,
    });
    result.matchesCreated++;
    return;
  }

  const hasBye = size % 2 !== 0;
  const byeSeedId = hasBye ? playerIds[0]! : null;
  const activeR1Ids = hasBye ? playerIds.slice(1) : [...playerIds];

  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(activeR1Ids.length, 2))));
  const roundDefs = buildGroupRoundDefs(groupName, bracketSize, hasBye);
  const roundKeys: string[] = [];
  for (const rd of roundDefs) {
    const rOut = await addRound(tournamentKey, rd.label);
    if (!rOut.ok) result.errors.push(`${rd.label}: addRound failed`);
    roundKeys.push(normalizeKey(rd.label));
    result.roundsCreated.push(rd.label);
  }

  const pairs = seededPairs(activeR1Ids);
  const r1Label = roundDefs[0]!.label;
  const r1Key = roundKeys[0]!;
  for (let i = 0; i < pairs.length; i++) {
    const [aId, bId] = pairs[i]!;
    await createPlannedMatch({
      mode: defaults.mode, tournament: tournamentName, tournamentKey,
      round: r1Label, roundKey: r1Key, matchOrder: i + 1, board: i + 1,
      aName: playerNames.get(aId) ?? aId, aResolvedId: aId,
      bName: playerNames.get(bId) ?? bId, bResolvedId: bId,
      cfg, createdBy: myUid,
    });
    result.matchesCreated++;
  }

  let prevCount = pairs.length;
  for (let ri = 1; ri < roundDefs.length; ri++) {
    const rd = roundDefs[ri]!;
    const rKey = roundKeys[ri]!;
    const isFinal = ri === roundDefs.length - 1;
    const slotCount = isFinal ? 1 : Math.max(1, Math.ceil(prevCount / 2));

    if (isFinal && hasBye && byeSeedId) {
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: rd.label, roundKey: rKey, matchOrder: 1, board: 1,
        aName: playerNames.get(byeSeedId) ?? byeSeedId, aResolvedId: byeSeedId,
        bName: `${groupName} Winner`,
        cfg, createdBy: myUid,
      });
    } else {
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode, tournament: tournamentName, tournamentKey,
          round: rd.label, roundKey: rKey, matchOrder: i + 1, board: i + 1,
          aName: `${groupName} Winner ${i * 2 + 1}`,
          bName: `${groupName} Winner ${i * 2 + 2}`,
          cfg, createdBy: myUid,
        });
      }
    }
    result.matchesCreated += slotCount;
    prevCount = slotCount;
  }
}

// ─── Phase 2: combined knockout ───────────────────────────────────────────────

export type CombinedKOParams = {
  tournamentKey: string;
  tournamentName: string;
  groups: Record<string, LeagueGroup>; // used for naming only
  groupCount: number;
  groupNames?: string[]; // ordered list of group names for KO seeding (e.g. ["G1","G2","G3","G4"])
  defaults: {
    mode: 'singles' | 'doubles';
    bestOf: number;
    pointsTarget: number;
    maxBoards: number;
    timerDuration?: number;
  };
  myUid: string;
};

/**
 * Generate Phase 2: combined knockout with cross-pairing seeding.
 *
 * For G groups each producing A[g] (champion) and B[g] (runner-up):
 *   Match k: A[k] vs B[G+1-k]  (1-indexed)
 *
 * When G is odd, the lowest-seeded pair plays a Pre-QF first.
 * Produces placeholder planned matches; winner propagation fills names.
 */
export async function generateCombinedKnockout(
  params: CombinedKOParams,
): Promise<CombinedKOResult> {
  const { addRound, normalizeKey } = await import('./tournaments');
  const { createPlannedMatch } = await import('./planned');

  const { tournamentKey, tournamentName, groupCount, groupNames, defaults, myUid } = params;
  const result: CombinedKOResult = { roundsCreated: [], matchesCreated: 0, errors: [] };

  const cfg = {
    bestOf: defaults.bestOf,
    pointsTarget: defaults.pointsTarget,
    maxBoards: defaults.maxBoards,
    ...(defaults.timerDuration != null ? { format: `t${defaults.timerDuration}` } : {}),
  };

  // Use provided group names (in KO seed order) or fall back to A/B/C/D labels
  const gName = (k: number) => groupNames?.[k] ?? groupLabel(k);

  // Each group contributes 1 qualifier (the group Final winner).
  // Cross-pairing: seed[k] vs seed[G-1-k] so same-group players can only meet in the Final.
  const totalQualifiers = groupCount; // 1 per group
  const needsPreQF = !isPowerOfTwo(totalQualifiers);
  const preQFCount = needsPreQF ? totalQualifiers - nextPowerOfTwo(Math.ceil(totalQualifiers / 2)) : 0;
  const mainBracketSize = needsPreQF ? nextPowerOfTwo(Math.ceil(totalQualifiers / 2)) : Math.ceil(totalQualifiers / 2);

  // Cross-pairing: pair first vs last, second vs second-last, etc.
  // For odd count the middle seed gets a bye into the next round.
  const firstRoundPairs: Array<{ aSlot: string; bSlot: string }> = [];
  for (let k = 0; k < Math.floor(groupCount / 2); k++) {
    firstRoundPairs.push({
      aSlot: gName(k),
      bSlot: gName(groupCount - 1 - k),
    });
  }
  const byeSeed = groupCount % 2 === 1 ? gName(Math.floor(groupCount / 2)) : null;

  const roundDefs = buildCombinedRoundDefs(mainBracketSize, needsPreQF, preQFCount);

  // Create rounds
  const roundKeys: string[] = [];
  for (const rd of roundDefs) {
    const rOut = await addRound(tournamentKey, rd.label);
    if (!rOut.ok) result.errors.push(`${rd.label}: addRound failed`);
    roundKeys.push(normalizeKey(rd.label));
    result.roundsCreated.push(rd.label);
  }

  if (roundDefs.length === 0) {
    result.errors.push('No combined KO rounds to create');
    return result;
  }

  const firstRd = roundDefs[0]!;
  const firstRdKey = roundKeys[0]!;

  if (needsPreQF) {
    // Odd groupCount: the middle seed plays a Pre-QF against one of the lower seeds.
    // firstRoundPairs already has the right pairings; byeSeed advances straight to next round.
    for (let i = 0; i < firstRoundPairs.length; i++) {
      const pair = firstRoundPairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: firstRd.label, roundKey: firstRdKey, matchOrder: i + 1, board: i + 1,
        aName: pair.aSlot, bName: pair.bSlot, cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Next round: bye seed + Pre-QF winners
    const nextRd = roundDefs[1]!;
    const nextRdKey = roundKeys[1]!;
    let matchOrder = 1;
    if (byeSeed) {
      const mo = matchOrder++;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: nextRd.label, roundKey: nextRdKey, matchOrder: mo, board: mo,
        aName: byeSeed, bName: `Pre-QF Winner 1`, cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }
    for (let i = byeSeed ? 1 : 0; i < firstRoundPairs.length; i++) {
      const mo = matchOrder++;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: nextRd.label, roundKey: nextRdKey, matchOrder: mo, board: mo,
        aName: `KO Winner ${i * 2 + 1}`, bName: `KO Winner ${i * 2 + 2}`, cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Subsequent rounds: halving placeholders
    let prevCount = mainBracketSize;
    for (let ri = 2; ri < roundDefs.length; ri++) {
      const rd = roundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const slotCount = Math.max(1, Math.ceil(prevCount / 2));
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode, tournament: tournamentName, tournamentKey,
          round: rd.label, roundKey: rKey, matchOrder: i + 1, board: i + 1,
          aName: `KO Winner ${i * 2 + 1}`, bName: `KO Winner ${i * 2 + 2}`, cfg, createdBy: myUid,
        });
        result.matchesCreated++;
      }
      prevCount = slotCount;
    }
  } else {
    // Even groupCount: first round pairs all seeds directly
    for (let i = 0; i < firstRoundPairs.length; i++) {
      const pair = firstRoundPairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode, tournament: tournamentName, tournamentKey,
        round: firstRd.label, roundKey: firstRdKey, matchOrder: i + 1, board: i + 1,
        aName: pair.aSlot, bName: pair.bSlot, cfg, createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Subsequent rounds: halving placeholders
    let prevCount = firstRoundPairs.length;
    for (let ri = 1; ri < roundDefs.length; ri++) {
      const rd = roundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const slotCount = Math.max(1, Math.ceil(prevCount / 2));
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode, tournament: tournamentName, tournamentKey,
          round: rd.label, roundKey: rKey, matchOrder: i + 1, board: i + 1,
          aName: `KO Winner ${i * 2 + 1}`, bName: `KO Winner ${i * 2 + 2}`, cfg, createdBy: myUid,
        });
        result.matchesCreated++;
      }
      prevCount = slotCount;
    }
  }

  return result;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function nextPowerOfTwo(n: number): number {
  if (n <= 1) return 1;
  return Math.pow(2, Math.ceil(Math.log2(n)));
}

/** Label for group index (0→A, 1→B, …) */
function groupLabel(idx: number): string {
  return String.fromCharCode(65 + idx); // A, B, C, …
}

/**
 * Standard single-elimination seeded pairs for a list of player IDs.
 * Returns [string, string][] for round 1 matches.
 */
/** Pair players in the order the organizer arranged them: 1v2, 3v4, 5v6, … */
function seededPairs(ids: string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < ids.length; i += 2) {
    pairs.push([ids[i]!, ids[i + 1]!]);
  }
  return pairs;
}

/** Build round labels for a per-group bracket. */
function buildGroupRoundDefs(
  groupName: string,
  bracketSize: number,
  hasBye: boolean,
): Array<{ label: string; matchCount: number }> {
  // Standard labels for bracket sizes
  const all = [
    { label: `${groupName} — R32`, matchCount: 16 },
    { label: `${groupName} — R16`, matchCount: 8 },
    { label: `${groupName} — QF`,  matchCount: 4 },
    { label: `${groupName} — SF`,  matchCount: 2 },
    { label: `${groupName} — Final`, matchCount: 1 },
  ];

  // Keep only rounds at or below bracketSize/2 match count
  // (bracketSize/2 = number of R1 matches for a full bracket)
  const maxCount = bracketSize / 2;
  const defs = all.filter((r) => r.matchCount <= maxCount);

  // If odd group (has bye), the first round has fewer slots than a full bracket —
  // that's fine; we always include the Final regardless.
  if (!defs.some((r) => r.label.endsWith('Final'))) {
    defs.push({ label: `${groupName} — Final`, matchCount: 1 });
  }

  return defs;
}

/** Build round labels for the combined knockout phase.
 *  mainBracketSize = number of matches in the first non-Pre-QF round.
 *  Labels are chosen by bracket depth so they read correctly for any group count.
 */
function buildCombinedRoundDefs(
  mainBracketSize: number,
  hasPreQF: boolean,
  _preQFCount: number,
): Array<{ label: string }> {
  // Label by depth from Final: 1→Final, 2→SF+Final, 4→QF+SF+Final, 8→R16+…
  const LABELS: Record<number, string> = {
    1: 'KO — Final',
    2: 'KO — Semi Finals',
    4: 'KO — Quarter Finals',
    8: 'KO — Round of 16',
  };

  const rounds: Array<{ label: string }> = [];
  if (hasPreQF) rounds.push({ label: 'KO — Pre-QF' });

  let count = mainBracketSize;
  while (count >= 1) {
    const lbl = LABELS[count] ?? `KO — R${count * 2}`;
    rounds.push({ label: lbl });
    if (count === 1) break;
    count = Math.ceil(count / 2);
  }

  return rounds;
}
