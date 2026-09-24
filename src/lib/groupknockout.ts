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
 * Generate Phase 1: one mini single-elimination bracket per group.
 *
 * Odd-sized group: top seed (position 0 in group.playerIds) receives a bye
 * in round 1 and enters directly at the group final.
 *
 * Group of 2: single match, both players qualify (winner=1st, loser=2nd).
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
    const { name: groupName, playerIds } = group;
    const size = playerIds.length;

    if (size < 1) continue;

    if (size === 1) {
      result.errors.push(`Group "${groupName}" has only 1 player — move them to another group`);
      continue;
    }

    if (size === 2) {
      // Single match; both qualify — no bracket needed
      const roundLabel = `${groupName} — Final`;
      const rOut = await addRound(tournamentKey, roundLabel);
      if (!rOut.ok) result.errors.push(`${roundLabel}: addRound failed`);
      result.roundsCreated.push(roundLabel);

      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: roundLabel,
        roundKey: normalizeKey(roundLabel),
        matchOrder: 1,
        aName: playerNames.get(playerIds[0]!) ?? playerIds[0]!,
        aResolvedId: playerIds[0]!,
        bName: playerNames.get(playerIds[1]!) ?? playerIds[1]!,
        bResolvedId: playerIds[1]!,
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
      continue;
    }

    // Odd group: top seed gets a bye — remove from R1, add directly to Final slot
    const hasBye = size % 2 !== 0;
    const byeSeedId = hasBye ? playerIds[0]! : null;
    const activeR1Ids = hasBye ? playerIds.slice(1) : [...playerIds];

    // Build bracket rounds for the active players
    const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(activeR1Ids.length, 2))));
    const roundDefs = buildGroupRoundDefs(groupName, bracketSize, hasBye);

    // Create rounds
    const roundKeys: string[] = [];
    for (const rd of roundDefs) {
      const rOut = await addRound(tournamentKey, rd.label);
      if (!rOut.ok) result.errors.push(`${rd.label}: addRound failed`);
      roundKeys.push(normalizeKey(rd.label));
      result.roundsCreated.push(rd.label);
    }

    // First round: seeded real pairs from activeR1Ids
    const pairs = seededPairs(activeR1Ids);
    const r1Label = roundDefs[0]!.label;
    const r1Key = roundKeys[0]!;
    for (let i = 0; i < pairs.length; i++) {
      const [aId, bId] = pairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: r1Label,
        roundKey: r1Key,
        matchOrder: i + 1,
        aName: playerNames.get(aId) ?? aId,
        aResolvedId: aId,
        bName: playerNames.get(bId) ?? bId,
        bResolvedId: bId,
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Subsequent rounds: placeholder slots (winner propagation fills them later)
    let prevCount = pairs.length;
    for (let ri = 1; ri < roundDefs.length; ri++) {
      const rd = roundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const isFinal = ri === roundDefs.length - 1;
      const slotCount = isFinal ? 1 : Math.max(1, Math.ceil(prevCount / 2));

      if (isFinal && hasBye && byeSeedId) {
        // Top-seeded bye enters the Final as one of the two slots
        await createPlannedMatch({
          mode: defaults.mode,
          tournament: tournamentName,
          tournamentKey,
          round: rd.label,
          roundKey: rKey,
          matchOrder: 1,
          aName: playerNames.get(byeSeedId) ?? byeSeedId,
          aResolvedId: byeSeedId,
          bName: `${groupName} Winner`,
          cfg,
          createdBy: myUid,
        });
      } else {
        for (let i = 0; i < slotCount; i++) {
          await createPlannedMatch({
            mode: defaults.mode,
            tournament: tournamentName,
            tournamentKey,
            round: rd.label,
            roundKey: rKey,
            matchOrder: i + 1,
            aName: `${groupName} Winner ${i * 2 + 1}`,
            bName: `${groupName} Winner ${i * 2 + 2}`,
            cfg,
            createdBy: myUid,
          });
        }
      }
      result.matchesCreated += slotCount;
      prevCount = slotCount;
    }
  }

  return result;
}

// ─── Phase 2: combined knockout ───────────────────────────────────────────────

export type CombinedKOParams = {
  tournamentKey: string;
  tournamentName: string;
  groups: Record<string, LeagueGroup>; // used for naming only
  groupCount: number;
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

  const { tournamentKey, tournamentName, groupCount, defaults, myUid } = params;
  const result: CombinedKOResult = { roundsCreated: [], matchesCreated: 0, errors: [] };

  const cfg = {
    bestOf: defaults.bestOf,
    pointsTarget: defaults.pointsTarget,
    maxBoards: defaults.maxBoards,
    ...(defaults.timerDuration != null ? { format: `t${defaults.timerDuration}` } : {}),
  };

  const totalQualifiers = groupCount * 2; // G champions + G runners-up
  const needsPreQF = !isPowerOfTwo(totalQualifiers);
  const preQFCount = needsPreQF ? totalQualifiers - nextPowerOfTwo(totalQualifiers / 2) : 0;
  const mainBracketSize = needsPreQF ? nextPowerOfTwo(totalQualifiers / 2) : totalQualifiers / 2;

  // Build cross-pairing QF slots: A[k] vs B[G+1-k]
  // Groups sorted by order; A[0]=champion group 1, B[0]=runner-up group 1, etc.
  const qfPairs: Array<{ aSlot: string; bSlot: string }> = [];
  for (let k = 0; k < groupCount; k++) {
    const aGroup = groupLabel(k);                     // A1, A2, …
    const bGroup = groupLabel(groupCount - 1 - k);   // B(G+1-k) in 0-indexed
    qfPairs.push({
      aSlot: `${aGroup} Champion`,
      bSlot: `${bGroup} Runner-Up`,
    });
  }

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

  // First round (Pre-QF or QF): use cross-pairing slot names
  // Pre-QF: only the lowest-seeded preQFCount pairs; rest get a bye into next round
  const firstRd = roundDefs[0]!;
  const firstRdKey = roundKeys[0]!;

  if (needsPreQF) {
    // Lowest-seeded pairs play Pre-QF (last preQFCount pairs in qfPairs list)
    const preQFPairs = qfPairs.slice(qfPairs.length - preQFCount);
    for (let i = 0; i < preQFPairs.length; i++) {
      const pair = preQFPairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: firstRd.label,
        roundKey: firstRdKey,
        matchOrder: i + 1,
        aName: pair.aSlot,
        bName: pair.bSlot,
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Second round (QF): top pairs from qfPairs + Pre-QF winners
    const qfRd = roundDefs[1]!;
    const qfRdKey = roundKeys[1]!;
    const topPairs = qfPairs.slice(0, qfPairs.length - preQFCount);
    let matchOrder = 1;
    for (const pair of topPairs) {
      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: qfRd.label,
        roundKey: qfRdKey,
        matchOrder: matchOrder++,
        aName: pair.aSlot,
        bName: pair.bSlot,
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
    }
    for (let i = 0; i < preQFPairs.length; i++) {
      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: qfRd.label,
        roundKey: qfRdKey,
        matchOrder: matchOrder++,
        aName: `Pre-QF Winner ${i + 1}`,
        bName: 'KO Qualifier',
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Subsequent rounds after QF: placeholder halving
    let prevCount = mainBracketSize;
    for (let ri = 2; ri < roundDefs.length; ri++) {
      const rd = roundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const slotCount = Math.max(1, Math.ceil(prevCount / 2));
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode,
          tournament: tournamentName,
          tournamentKey,
          round: rd.label,
          roundKey: rKey,
          matchOrder: i + 1,
          aName: `KO Winner ${i * 2 + 1}`,
          bName: `KO Winner ${i * 2 + 2}`,
          cfg,
          createdBy: myUid,
        });
        result.matchesCreated++;
      }
      prevCount = slotCount;
    }
  } else {
    // No Pre-QF: first round is straight QF with cross-pairings
    for (let i = 0; i < qfPairs.length; i++) {
      const pair = qfPairs[i]!;
      await createPlannedMatch({
        mode: defaults.mode,
        tournament: tournamentName,
        tournamentKey,
        round: firstRd.label,
        roundKey: firstRdKey,
        matchOrder: i + 1,
        aName: pair.aSlot,
        bName: pair.bSlot,
        cfg,
        createdBy: myUid,
      });
      result.matchesCreated++;
    }

    // Subsequent rounds: placeholder halving
    let prevCount = qfPairs.length;
    for (let ri = 1; ri < roundDefs.length; ri++) {
      const rd = roundDefs[ri]!;
      const rKey = roundKeys[ri]!;
      const slotCount = Math.max(1, Math.ceil(prevCount / 2));
      for (let i = 0; i < slotCount; i++) {
        await createPlannedMatch({
          mode: defaults.mode,
          tournament: tournamentName,
          tournamentKey,
          round: rd.label,
          roundKey: rKey,
          matchOrder: i + 1,
          aName: `KO Winner ${i * 2 + 1}`,
          bName: `KO Winner ${i * 2 + 2}`,
          cfg,
          createdBy: myUid,
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
function seededPairs(ids: string[]): [string, string][] {
  function buildPositions(size: number): number[] {
    if (size === 2) return [1, 2];
    const prev = buildPositions(size / 2);
    const result: number[] = [];
    for (const s of prev) result.push(s, size + 1 - s);
    return result;
  }

  const bracketSize = Math.pow(2, Math.ceil(Math.log2(Math.max(ids.length, 2))));
  const positions = buildPositions(bracketSize);
  const pairs: [string, string][] = [];

  for (let i = 0; i < positions.length; i += 2) {
    const aIdx = positions[i]! - 1;
    const bIdx = positions[i + 1]! - 1;
    const a = ids[aIdx];
    const b = ids[bIdx];
    if (a && b) pairs.push([a, b]);
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

/** Build round labels for the combined knockout phase. */
function buildCombinedRoundDefs(
  mainBracketSize: number,
  hasPreQF: boolean,
  preQFCount: number,
): Array<{ label: string }> {
  const rounds: Array<{ label: string }> = [];

  if (hasPreQF) {
    rounds.push({ label: 'KO — Pre-QF' });
  }

  const all = [
    { matchCount: mainBracketSize, label: 'KO — QF' },
    { matchCount: mainBracketSize / 2, label: 'KO — SF' },
    { matchCount: 1, label: 'KO — Final' },
  ];

  for (const r of all) {
    if (r.matchCount >= 1) rounds.push({ label: r.label });
  }

  // For small brackets: 2 qualifiers = just a Final, 4 = SF+Final, etc.
  if (mainBracketSize === 1) {
    return hasPreQF
      ? [{ label: 'KO — Pre-QF' }, { label: 'KO — Final' }]
      : [{ label: 'KO — Final' }];
  }

  return rounds;
}
