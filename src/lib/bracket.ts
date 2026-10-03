/** Matches round names that indicate a single-elimination bracket round (winner path only). */
export const BRACKET_ROUND_RX = /\b(Pre-qualify|R\d+|round.of.16|QF|SF|Final)\b/i;

/** Matches positional/loser bracket round suffixes. These must be excluded from winner-bracket logic. */
export const POSITIONAL_ROUND_RX = /— (3rd Place|3rd|5th-8th Place|5th Place|7th Place|L-SF|L-Final|L-3rd)$/i;
