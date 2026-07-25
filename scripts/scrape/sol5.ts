import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as cheerio from 'cheerio';
import { isCleanName, normalizeName, type Player } from './lib.ts';

const SOURCE = 'sol5-lit';
const BASE = 'https://sol5.metapensiero.it';
const ROOT = `${BASE}/lit`;

/**
 * Countries to crawl. Start narrow (Denmark only); expand as needed.
 */
const COUNTRY_CODES: readonly string[] = ['DNK'];

const CLUB_HREF_RE = /^\/lit\/club\/([0-9a-f]{32})$/;

/**
 * Sol5 LIT is protected by the "Anubis" proof-of-work challenge. A single
 * browser-issued session cookie `techaro.lol-anubis-auth` passes it for
 * ~30-60 min. The scraper reads that cookie from `.env` at the repo root —
 * the file should hold just the raw cookie value (no KEY= prefix).
 *
 * If the cookie is missing or expired, the fetch lands on the challenge page
 * and this scraper contributes zero players (does not throw).
 *
 * Structure of the site:
 *   /lit                      -> lists country codes
 *   /lit/country/<CODE>       -> lists that country's clubs
 *   /lit/club/<UUID>/players  -> lists player <a> tags for that club
 */

function readCookie(): string | null {
  const path = resolve(process.cwd(), '.env');
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    // Support both raw-value and KEY=value forms. Only treat '=' as a
    // separator when the tail looks like a JWT.
    const eq = raw.lastIndexOf('=');
    if (eq !== -1 && raw.slice(eq + 1).startsWith('eyJ')) {
      return raw.slice(eq + 1).trim();
    }
    return raw;
  } catch {
    return null;
  }
}

async function get(url: string, cookie: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
      Cookie: `techaro.lol-anubis-auth=${cookie}`,
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });
  if (!res.ok) {
    console.warn(`[${SOURCE}] ${res.status} on ${url}`);
    return null;
  }
  const text = await res.text();
  if (text.includes('Making sure you') && text.includes('Anubis')) {
    console.error(
      `[${SOURCE}] response is the Anubis challenge page — cookie expired or invalid. Refresh .env from a real browser session.`,
    );
    return null;
  }
  return text;
}

function extractClubIds(html: string): string[] {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  $('a[href^="/lit/club/"]').each((_, a) => {
    const href = $(a).attr('href') ?? '';
    const m = CLUB_HREF_RE.exec(href);
    if (m) ids.add(m[1]);
  });
  return Array.from(ids);
}

function extractClubPlayers(html: string): { name: string; club?: string }[] {
  const $ = cheerio.load(html);
  const club = $('h2.title.centered a').first().text().trim() || undefined;
  const players: { name: string; club?: string }[] = [];
  $('a[href^="/lit/player/"]').each((_, a) => {
    const name = $(a).text().trim();
    if (name) players.push({ name, club });
  });
  return players;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function scrapeCountry(code: string, cookie: string): Promise<Player[]> {
  const countryHtml = await get(`${ROOT}/country/${code}`, cookie);
  if (!countryHtml) return [];
  const clubs = extractClubIds(countryHtml);
  console.log(`[${SOURCE}] ${code}: ${clubs.length} clubs`);

  const out: Player[] = [];
  for (const clubId of clubs) {
    await sleep(200);
    const clubHtml = await get(`${ROOT}/club/${clubId}/players`, cookie);
    if (!clubHtml) continue;
    for (const entry of extractClubPlayers(clubHtml)) {
      const name = normalizeName(entry.name);
      if (!isCleanName(name)) continue;
      out.push({ name, country: code, club: entry.club, source: SOURCE });
    }
  }
  return out;
}

export async function scrapeSol5Lit(): Promise<Player[]> {
  const cookie = readCookie();
  if (!cookie) {
    console.warn(
      `[${SOURCE}] no cookie found in .env — skipping. Paste the browser's techaro.lol-anubis-auth value into .env to enable.`,
    );
    return [];
  }

  const all: Player[] = [];
  for (const code of COUNTRY_CODES) {
    const rows = await scrapeCountry(code, cookie);
    all.push(...rows);
  }
  console.log(`[${SOURCE}] collected ${all.length} name-rows before dedup`);
  return all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const players = await scrapeSol5Lit();
  console.log(`Scraped ${players.length} players from ${SOURCE}`);
}
