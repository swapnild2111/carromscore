/**
 * Tournament / event tag store. Mirrors the players.ts pattern:
 *   - Firebase RTDB `/tournaments/{key}` is the source of truth
 *   - In-memory list drives the picker in MatchSetup
 *   - Silent-on-failure per house style; the app keeps working
 *     against the local list if Firebase is unreachable
 *
 * Purpose: users can tag matches with a tournament / event name
 * (e.g. "Silver Cup 2026") so the /live/ lobby can group Now Playing
 * + History under section headers, and retention differs by tag
 * (tagged → 1 year, blank/"Default" → 3 months, Practice → 3 months
 * always).
 */

export type Tournament = {
  key: string;             // slug — normalised, safe as a Firebase key
  name: string;            // canonical display name (what the user typed)
  createdAt: number;
  lastActive: number;      // touched on every match Start referencing it
};

/**
 * Normalise a typed tournament name into a safe key for Firebase.
 * Lowercased, ASCII-diacritic-stripped, punctuation collapsed to
 * dashes. Firebase disallows `. # $ / [ ]` in keys — this normaliser
 * avoids all of them by design.
 */
export function normalizeKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

let memoryStore: Tournament[] = [];
let listeners = new Set<() => void>();
let firebaseUnsubscribe: (() => void) | null = null;

function notify(): void {
  for (const fn of listeners) fn();
}

export function subscribeStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadAll(): Tournament[] {
  // Returns most-recently active first — that's the useful order in
  // the picker (last tournament you played in is the most likely one
  // for the next match too).
  return [...memoryStore].sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Rank tournaments against a typed query. Simple prefix + substring
 * match on the normalised name. Empty query returns the whole list
 * (sorted by recent activity via loadAll). Case-insensitive.
 */
export function rankTournaments(query: string, limit = 8): Tournament[] {
  const q = query.trim().toLowerCase();
  const all = loadAll();
  if (!q) return all.slice(0, limit);
  const norm = q.toLowerCase();
  const prefix: Tournament[] = [];
  const substring: Tournament[] = [];
  for (const t of all) {
    const n = t.name.toLowerCase();
    if (n.startsWith(norm)) prefix.push(t);
    else if (n.includes(norm)) substring.push(t);
  }
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Ensure a tournament with the given canonical name exists in the
 * store + Firebase. Idempotent — repeat calls just bump lastActive.
 * Returns the resolved Tournament record. Empty / whitespace-only
 * names return null (indicating "no tournament tag").
 */
export function createOrTouchTournament(name: string): Tournament | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const key = normalizeKey(trimmed);
  if (!key) return null;
  const now = Date.now();
  const existing = memoryStore.find((t) => t.key === key);
  const record: Tournament = existing
    ? { ...existing, name: trimmed, lastActive: now }
    : { key, name: trimmed, createdAt: now, lastActive: now };
  if (existing) {
    Object.assign(existing, { name: trimmed, lastActive: now });
  } else {
    memoryStore.push(record);
  }
  notify();
  void writeTournamentToFirebase(record);
  return record;
}

/**
 * Subscribe to /tournaments in Firebase RTDB. Populates the in-
 * memory store as records arrive. Idempotent — safe to call from
 * multiple mount points; the second call is a no-op.
 */
export async function subscribeTournaments(): Promise<void> {
  if (firebaseUnsubscribe) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const tRef = ref(db, 'tournaments');
    firebaseUnsubscribe = onValue(
      tRef,
      (snap) => {
        const raw = snap.val() as Record<string, unknown> | null;
        if (!raw) return;
        mergeRemote(raw);
      },
      () => {},
    );
  } catch {
    // Firebase unreachable — local store still works.
  }
}

function mergeRemote(raw: Record<string, unknown>): void {
  for (const [key, val] of Object.entries(raw)) {
    if (!val || typeof val !== 'object') continue;
    const v = val as Record<string, unknown>;
    const name = typeof v.name === 'string' ? v.name.trim() : '';
    if (!name) continue;
    const createdAt = typeof v.createdAt === 'number' ? v.createdAt : 0;
    const lastActive = typeof v.lastActive === 'number' ? v.lastActive : 0;
    const existing = memoryStore.find((t) => t.key === key);
    if (existing) {
      existing.name = name;
      existing.createdAt = createdAt || existing.createdAt;
      // Take the newer lastActive between what we have and what
      // arrived, so a stale local touch doesn't demote a fresher one.
      existing.lastActive = Math.max(existing.lastActive, lastActive);
    } else {
      memoryStore.push({ key, name, createdAt, lastActive });
    }
  }
  notify();
}

async function writeTournamentToFirebase(t: Tournament): Promise<void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    // `update` merges — if the record already exists we just bump
    // lastActive + refresh name (in case of typo correction), without
    // touching createdAt.
    await update(ref(db, `tournaments/${t.key}`), {
      name: t.name,
      lastActive: t.lastActive,
      createdAt: t.createdAt,
    });
  } catch {
    // Silent — local record persists.
  }
}

/** Test hook — reset store between assertions. */
export function _resetForTests(): void {
  memoryStore = [];
  listeners = new Set();
  firebaseUnsubscribe?.();
  firebaseUnsubscribe = null;
}
