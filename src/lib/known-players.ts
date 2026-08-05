/**
 * Per-device local roster of player names, kept in localStorage.
 *
 * When a user starts a match, the names they entered are stored here.
 * The setup picker unions this list with the bundled `public/data/players.json`
 * seed so the picker gets more useful as the user plays more matches.
 *
 * Zero server involvement — the list is per-device and never leaves the
 * browser. This is deliberate: no server ⇒ no data protection surface,
 * no accounts, no privacy story to manage.
 */
import type { PlayerRow } from './match';

const KEY = 'carromscore:known-players';
const MAX = 500; // sanity cap so a runaway loop can't blow localStorage

function readSet(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
}

function writeSet(names: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(names)));
  } catch {
    // localStorage quota exceeded / disabled — silently ignore. The
    // picker still works without the local roster; users just don't
    // get autocomplete for previously-typed names on next session.
  }
}

/**
 * Load the user's local roster as PlayerRow[] shaped like the bundled JSON.
 * Suitable for concatenating with the seed list before running the
 * picker's suggest() filter.
 */
export function loadKnownPlayers(): PlayerRow[] {
  return Array.from(readSet()).map((name) => ({ name, source: 'local' }));
}

/**
 * Remember one or more names. No-op for empty / whitespace-only entries
 * and for names that already exist in the roster. Trims whitespace.
 * Called from MatchSetup on `start()` so only names attached to an
 * actually-started match get remembered (avoids typo pollution from
 * abandoned setup sessions).
 */
export function rememberPlayers(...names: string[]): void {
  const set = readSet();
  let changed = false;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    if (set.has(name)) continue;
    set.add(name);
    changed = true;
  }
  if (!changed) return;

  // Enforce the sanity cap: keep the newest entries (Set iteration order
  // is insertion order in JS, so drop from the front).
  if (set.size > MAX) {
    const arr = Array.from(set);
    writeSet(new Set(arr.slice(arr.length - MAX)));
    return;
  }
  writeSet(set);
}
