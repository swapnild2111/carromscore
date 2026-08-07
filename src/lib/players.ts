/**
 * Player identity + alias system.
 *
 * A Player is a canonical identity for one carrom player. Multiple typed
 * name strings ("Ilyas", "M. Ilyas", "Mohammed Ilyas Khan") can all be
 * aliases for the same Player. Matches store the stable playerId, not
 * the typed string, so renaming a player later updates every historical
 * match automatically.
 *
 * Storage: Firebase Realtime Database's `/players/{playerId}` path (once
 * wired). Today (v2.0 pre-Firebase) the module runs against an in-memory
 * store bootstrapped from the bundled Wikipedia seed. That lets us build
 * and ship the fuzzy-match UX in isolation from the network layer.
 *
 * The Firebase-backed version will keep the same public API (loadAll,
 * rankMatches, createPlayer, addAlias) — components import from this
 * file and never need to know where the store lives.
 */

/**
 * A single player in the identity store. `canonicalName` is the display
 * form; `aliases` is a set (represented as an object keyed by normalised
 * strings, matching RTDB's map semantics) of alternate spellings that
 * should resolve to this same player.
 */
export type Player = {
  id: string;
  canonicalName: string;
  aliases: Record<string, true>;
  createdAt: number;
  createdBy?: string;
};

/**
 * A hit from rankMatches(), with rank semantics:
 * - `rank: 'exact'`   — normalised query equals canonical or an alias.
 *                        Resolve silently, show muted chip "→ Name".
 * - `rank: 'fuzzy'`   — every query token matches some token of a
 *                        candidate's indexed strings. Show confirm chip:
 *                        "Same as *Name*? (tap to link)".
 * - `rank: 'prefix'`  — normalised query is a prefix of some indexed
 *                        string. Show in the existing suggestion
 *                        dropdown, same as v1 autocomplete.
 */
export type MatchRank = 'exact' | 'fuzzy' | 'prefix';

export type PlayerMatch = {
  player: Player;
  rank: MatchRank;
  matchedOn: string;
};

/**
 * Canonicalise a name for identity comparison. Two strings that normalise
 * to the same value are considered the same alias.
 *
 * - Lowercased.
 * - Diacritics stripped (`Björn` → `bjorn`).
 * - Punctuation stripped (`M. Ilyas` → `m ilyas`).
 * - Whitespace collapsed and trimmed.
 *
 * This is intentionally aggressive: "M. Ilyas", "m ilyas", "M   Ilyas"
 * all resolve to `m ilyas`. The trade-off is that genuinely distinct
 * players with punctuation-only differences ("Andy .Sr." vs "Andy .Jr.")
 * become collisions — but those cases are rare enough that the alias-
 * confirm-chip UX will surface them for manual resolution.
 */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build the searchable-strings list for a player: normalised canonical
 * name plus every alias key. Used inside rankMatches() and when writing
 * to Firebase as `normalisedIndex` for server-side prefix queries.
 */
export function normalisedIndex(p: Player): string[] {
  const canon = normalize(p.canonicalName);
  const aliases = Object.keys(p.aliases);
  return canon ? [canon, ...aliases] : aliases;
}

/**
 * Rank the whole player set against a typed query. Returns at most
 * `limit` hits, best-rank first. Empty query → empty result.
 *
 * Rank hierarchy: exact > fuzzy > prefix. Within the same rank, players
 * are returned in canonical-name alphabetical order (stable, deterministic
 * — matters for the confirm chip so the same query always suggests the
 * same top candidate).
 *
 * Fuzzy is defined as "every whitespace-separated token in the query
 * appears as a token in at least one indexed string of the player."
 * That catches:
 *   query "ilyas khan" → hits "Ilyas Khan" (canonical)
 *   query "m ilyas"    → hits "Ilyas Khan" via alias "m ilyas"
 *   query "khan ilyas" → hits "Ilyas Khan" (token-order-insensitive)
 * But does not overreach:
 *   query "ilyas khan the great" → no fuzzy hit (extra tokens don't match)
 */
export function rankMatches(
  players: readonly Player[],
  query: string,
  limit = 8,
): PlayerMatch[] {
  const q = normalize(query);
  if (!q) return [];
  const qTokens = q.split(' ');

  const buckets: Record<MatchRank, PlayerMatch[]> = { exact: [], fuzzy: [], prefix: [] };

  for (const player of players) {
    const hit = classifyPlayer(player, q, qTokens);
    if (hit) buckets[hit.rank].push(hit);
  }

  const byCanonical = (a: PlayerMatch, b: PlayerMatch) =>
    a.player.canonicalName.localeCompare(b.player.canonicalName);
  buckets.exact.sort(byCanonical);
  buckets.fuzzy.sort(byCanonical);
  buckets.prefix.sort(byCanonical);

  return [...buckets.exact, ...buckets.fuzzy, ...buckets.prefix].slice(0, limit);
}

function classifyPlayer(
  player: Player,
  q: string,
  qTokens: readonly string[],
): PlayerMatch | null {
  const idx = normalisedIndex(player);
  if (idx.length === 0) return null;

  // Rank 1/2: exact normalised match on canonical or alias.
  const exactHit = idx.find((s) => s === q);
  if (exactHit) return { player, rank: 'exact', matchedOn: exactHit };

  // Rank 3: every query token is a token of some indexed string. Only
  // meaningful with >= 2 tokens; a single-token "fuzzy" match is
  // indistinguishable from a prefix hit and is handled by rank 4.
  if (qTokens.length >= 2) {
    const fuzzyHit = idx.find((s) => allTokensMatch(qTokens, s));
    if (fuzzyHit) return { player, rank: 'fuzzy', matchedOn: fuzzyHit };
  }

  // Rank 4: prefix match on any indexed string. Requires >= 2 chars so
  // one keystroke doesn't fire every player onto the picker.
  if (q.length >= 2) {
    const prefixHit = idx.find((s) => s.startsWith(q));
    if (prefixHit) return { player, rank: 'prefix', matchedOn: prefixHit };
  }
  return null;
}

function allTokensMatch(qTokens: readonly string[], indexed: string): boolean {
  const sTokens = new Set(indexed.split(' '));
  return qTokens.every((t) => sTokens.has(t));
}

/**
 * Generate a stable player id from a canonical name. Kebab-cased
 * normalised form plus a 4-character random suffix for collision safety.
 * Callers should ensure the id doesn't already exist in the store
 * (Firebase transactional write handles that in the wired version;
 * the in-memory store simply retries).
 */
export function playerIdFor(canonicalName: string): string {
  const slug = normalize(canonicalName).replace(/\s/g, '-');
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug || 'player'}-${rand}`;
}

/**
 * Client-side shape guard for a player name. Mirrored on the RTDB
 * security rules once wired — reject empty, single-char, or clearly-
 * bogus input before it ever hits the network.
 *
 * Rules:
 * - Trimmed length 2..60 chars.
 * - Must contain at least one letter (Unicode aware).
 * - Rejects strings that look like HTML tags or URLs.
 */
export function isPlausibleName(s: string): boolean {
  const t = s.trim();
  if (t.length < 2 || t.length > 60) return false;
  if (!/\p{L}/u.test(t)) return false;
  if (/<|>|https?:\/\//i.test(t)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// In-memory store. Populated from three sources, in order:
//   1. Bundled seed (public/data/players.json) — called via seedFromRows().
//   2. Firebase RTDB /players — subscribed via subscribePlayers().
//   3. Local writes via createPlayer() / addAlias() — mirrored to RTDB
//      when the module is connected.
//
// Components import loadAll() to render the picker; that gives them a
// consistent snapshot regardless of connection state. The subscription
// updates the store in place so Svelte's reactivity picks up new players
// arriving from other users.
// ---------------------------------------------------------------------------

let memoryStore: Player[] = [];
let listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Subscribe to changes in the in-memory store. Fires whenever a Firebase
 * update arrives or a local mutation completes. Returns an unsubscribe
 * function. Svelte components typically call this from an $effect and
 * unsubscribe in the cleanup.
 */
export function subscribeStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Seed the in-memory store from the bundled `public/data/players.json`
 * seed. Idempotent — safe to call every time a component mounts.
 * Returns the current player list.
 */
export function seedFromRows(rows: readonly { name: string }[]): Player[] {
  if (memoryStore.length > 0) return memoryStore;
  memoryStore = rows
    .filter((r) => isPlausibleName(r.name))
    .map((r) => ({
      id: playerIdFor(r.name),
      canonicalName: r.name.trim(),
      aliases: {},
      createdAt: 0,
    }));
  return memoryStore;
}

export function loadAll(): Player[] {
  return memoryStore;
}

/**
 * Create a new player from a typed name. Returns the created record.
 * No-op (returns the existing match) if an exact-normalised player
 * already exists locally, so double-writes are safe.
 *
 * When Firebase is connected (see subscribePlayers), the new record
 * is also persisted to /players/{id}. Failures are logged and ignored
 * — the local record still exists and the app keeps working.
 */
export function createPlayer(canonicalName: string, createdBy?: string): Player {
  const norm = normalize(canonicalName);
  if (!isPlausibleName(canonicalName)) {
    throw new Error(`Refusing to create player with implausible name: ${canonicalName}`);
  }
  const existing = memoryStore.find(
    (p) => normalize(p.canonicalName) === norm,
  );
  if (existing) return existing;
  const p: Player = {
    id: playerIdFor(canonicalName),
    canonicalName: canonicalName.trim(),
    aliases: {},
    createdAt: Date.now(),
    ...(createdBy ? { createdBy } : {}),
  };
  memoryStore.push(p);
  notify();
  void writePlayerToFirebase(p);
  return p;
}

/**
 * Add an alias to a player. Idempotent — the alias key is normalised
 * before insertion so duplicate typed forms all collapse to one entry.
 * No-op if the alias key equals the canonical form (that's not an alias,
 * it's the same name).
 */
export function addAlias(playerId: string, typed: string): Player | null {
  const p = memoryStore.find((x) => x.id === playerId);
  if (!p) return null;
  const key = normalize(typed);
  if (!key) return p;
  if (key === normalize(p.canonicalName)) return p;
  if (p.aliases[key]) return p;
  p.aliases[key] = true;
  notify();
  void writeAliasToFirebase(playerId, key);
  return p;
}

/**
 * Test-only: reset the in-memory store. Used by unit tests to isolate
 * state between assertions. Not part of the public runtime API.
 */
export function _resetForTests(): void {
  memoryStore = [];
  listeners = new Set();
  firebaseUnsubscribe?.();
  firebaseUnsubscribe = null;
}

// ---------------------------------------------------------------------------
// Firebase-backed layer. All calls are lazy-imported so the ~40 KB gzip
// firebase/database chunk stays off the critical path for users who
// never open a live match, the history page, or setup.
//
// House style (mirrors src/lib/version.ts): try/catch, silent-on-failure,
// callers never see rejection. The app keeps working from the local
// snapshot if the network is dead or the RTDB rules deny.
// ---------------------------------------------------------------------------

let firebaseUnsubscribe: (() => void) | null = null;

/**
 * Subscribe to `/players` in Firebase RTDB. Every remote change reshapes
 * the in-memory store and fires listeners. Idempotent — calling twice
 * is a no-op after the first successful subscription.
 *
 * Returns a Promise that resolves when the initial snapshot has been
 * applied (or immediately if Firebase is unreachable). Callers can await
 * to know the picker is populated, but nothing bad happens if they don't.
 */
export async function subscribePlayers(): Promise<void> {
  if (firebaseUnsubscribe) return;
  try {
    const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    const playersRef = ref(db, 'players');
    firebaseUnsubscribe = onValue(
      playersRef,
      (snap) => {
        const raw = snap.val() as Record<string, unknown> | null;
        if (!raw) return;
        mergeRemotePlayers(raw);
      },
      // Silent on error — the local snapshot is enough to keep the picker
      // usable. Users notice missing-remote-players only when a name they
      // typed on another device doesn't autocomplete — acceptable.
      () => {},
    );
  } catch {
    // firebase package failed to load, or config is invalid, or network
    // is dead. Leave the app on the local snapshot.
  }
}

/**
 * Merge a Firebase snapshot into the in-memory store. Locally-created
 * players not present in the snapshot are preserved (they may not have
 * flushed to RTDB yet). Auto-deletion of remote-gone players is
 * deliberately not done here — v2.0 has no admin UI for deletion, so
 * any player missing from the snapshot is either brand-new-local or
 * an anomaly best handled offline.
 */
function mergeRemotePlayers(raw: Record<string, unknown>): void {
  for (const [id, val] of Object.entries(raw)) {
    mergeOneRemotePlayer(id, val);
  }
  notify();
}

function mergeOneRemotePlayer(id: string, val: unknown): void {
  if (!val || typeof val !== 'object') return;
  const v = val as Record<string, unknown>;
  const canonicalName = typeof v.canonicalName === 'string' ? v.canonicalName : '';
  if (!isPlausibleName(canonicalName)) return;
  const createdAt = typeof v.createdAt === 'number' ? v.createdAt : 0;
  const aliases = parseAliases(v.aliases);
  const existing = memoryStore.find((p) => p.id === id);
  if (existing) {
    existing.canonicalName = canonicalName;
    existing.aliases = { ...existing.aliases, ...aliases };
    existing.createdAt = createdAt || existing.createdAt;
    return;
  }
  memoryStore.push({
    id,
    canonicalName,
    aliases,
    createdAt,
    ...(typeof v.createdBy === 'string' ? { createdBy: v.createdBy } : {}),
  });
}

function parseAliases(raw: unknown): Record<string, true> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, true> = {};
  for (const k of Object.keys(raw as Record<string, unknown>)) out[k] = true;
  return out;
}

/**
 * Materialise a seed-only player (createdAt === 0, never written to
 * Firebase) into the RTDB `/players/{id}` path. No-op for players
 * already synced from Firebase or previously created via createPlayer.
 *
 * Callers pass a playerId; the function looks it up in the in-memory
 * store and writes if needed. Silent-on-failure per house style.
 *
 * Rationale: match records can reference IDs that came from the
 * bundled Wikipedia seed. Without materialising, the History page
 * reads /matches/{id}.playerAId and gets an ID Firebase doesn't know
 * about, so playerName() falls back to rendering the raw slug.
 */
export async function ensurePlayerInFirebase(playerId: string): Promise<void> {
  const p = memoryStore.find((x) => x.id === playerId);
  if (!p) return;
  if (p.createdAt !== 0) return;
  p.createdAt = Date.now();
  await writePlayerToFirebase(p);
}

async function writePlayerToFirebase(p: Player): Promise<void> {
  try {
    const [{ firebaseApp }, { getDatabase, ref, set }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    await set(ref(db, `players/${p.id}`), {
      canonicalName: p.canonicalName,
      createdAt: p.createdAt,
      ...(p.createdBy ? { createdBy: p.createdBy } : {}),
      aliases: { ...p.aliases },
      normalisedIndex: normalisedIndex(p),
    });
  } catch {
    // Firebase unreachable or rules denied — local record persists.
  }
}

async function writeAliasToFirebase(playerId: string, aliasKey: string): Promise<void> {
  const p = memoryStore.find((x) => x.id === playerId);
  if (!p) return;

  // A player with createdAt === 0 came from the bundled Wikipedia
  // seed and has never been written to Firebase. Alias-only writes on
  // it fail the rules (parent doesn't exist) so we materialise the
  // full record here first. Bumping createdAt to now() also makes the
  // create-time validation pass ("timestamp within 5 min of server").
  if (p.createdAt === 0) {
    p.createdAt = Date.now();
    await writePlayerToFirebase(p);
    return;
  }

  try {
    const [{ firebaseApp }, { getDatabase, ref, set, update }] = await Promise.all([
      import('./firebase'),
      import('firebase/database'),
    ]);
    const db = getDatabase(firebaseApp());
    await set(ref(db, `players/${playerId}/aliases/${aliasKey}`), true);
    await update(ref(db, `players/${playerId}`), {
      normalisedIndex: normalisedIndex(p),
    });
  } catch {
    // Silent — local alias still applies for the rest of this session.
  }
}
