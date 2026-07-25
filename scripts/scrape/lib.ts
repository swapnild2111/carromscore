/**
 * Shared utilities for player scrapers.
 */

export type Player = {
  name: string;
  country?: string;
  city?: string;
  club?: string;
  source: string;
};

/**
 * Names are considered "clean" if they contain only:
 *   letters (Latin-1 diacritics allowed), spaces, dots, hyphens, apostrophes.
 * Anything else (digits, brackets, slashes, other punctuation) drops the row.
 */
const CLEAN_NAME_RE = /^[\p{L}][\p{L}\s.\-']{1,79}$/u;

export function isCleanName(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return false;
  if (trimmed.length > 80) return false;
  return CLEAN_NAME_RE.test(trimmed);
}

export function normalizeName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => (w.length ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export function dedupePlayers(players: Player[]): Player[] {
  const byKey = new Map<string, Player>();
  for (const p of players) {
    const key = p.name.toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, p);
      continue;
    }
    // Merge: prefer existing but fill blanks from the newer record.
    byKey.set(key, {
      name: existing.name,
      country: existing.country ?? p.country,
      city: existing.city ?? p.city,
      club: existing.club ?? p.club,
      source: existing.source === p.source ? existing.source : `${existing.source}+${p.source}`,
    });
  }
  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; carromscore-scraper/0.1; +https://github.com/swapnild2111/carromscore)',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!res.ok) {
    throw new Error(`fetch ${url} failed: ${res.status} ${res.statusText}`);
  }
  return await res.text();
}
