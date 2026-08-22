/**
 * Props shape all overlay variants share. The parent OverlayBoard
 * component owns the reactive state (URL / localStorage / Firebase
 * subscription) and passes a normalised snapshot to whichever
 * variant is active. Each variant is a pure rendering layer.
 */
import type { MatchConfig, Side } from '../../lib/match';

export type OverlaySideState = {
  name: string;
  namePartA: string;
  namePartB: string;
  note: string;
  country: string;
  sets: number;
  points: number;
};

export type OverlayVariantProps = {
  cfg: MatchConfig;
  sideA: OverlaySideState;
  sideB: OverlaySideState;
  board: number;
  currentBreak: Side | null;
  queenHolder: Side | null;
  matchResult: Side | 'draw' | null;
  practiceBoards: number[][];
  practiceSetIdx: number;
};
