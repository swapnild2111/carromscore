/**
 * Per-device pointer to the umpire's last-started live match, so a
 * user who accidentally closes the /score/ tab can pick up where they
 * left off from the home page.
 *
 * Why this exists: `mid` is minted in MatchSetup.start() and lives
 * only in the /score/?...&mid=... URL. Close the tab and the mid is
 * gone — the /live/{mid} record continues broadcasting until the 4h
 * sweep, but the umpire has no way to reach it. This helper
 * stores {mid, scoreUrl, meta} in localStorage on Start and clears
 * it on End (and on Discard from the Home chip).
 *
 * Single-slot: starting a new match overwrites the pointer. If a
 * user has two matches open in two tabs, the second Start wins and
 * the first becomes only reachable via the /live/ lobby (spectator
 * view; not resumable via this path).
 */

import type { Mode } from './match';

const KEY = 'carromscore:resumeMid';

export type ResumeMeta = {
  mode: Mode;
  playerA: string;
  playerA2?: string;
  playerB: string;
  playerB2?: string;
  tournament?: string;
};

export type ResumeRecord = {
  mid: string;
  scoreUrl: string;
  startedAt: number;
  meta: ResumeMeta;
};

export function saveResume(record: ResumeRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // quota exceeded / disabled / SSR — resume is a nice-to-have, not
    // critical. The rest of the flow keeps working.
  }
}

export function loadResume(): ResumeRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.mid !== 'string' ||
      typeof parsed.scoreUrl !== 'string' ||
      typeof parsed.startedAt !== 'number' ||
      !parsed.meta ||
      typeof parsed.meta.mode !== 'string'
    ) {
      clearResume();
      return null;
    }
    return parsed as ResumeRecord;
  } catch {
    clearResume();
    return null;
  }
}

export function clearResume(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
