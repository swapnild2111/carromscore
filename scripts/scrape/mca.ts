import * as cheerio from 'cheerio';
import { fetchHtml, isCleanName, normalizeName, type Player } from './lib.ts';

const SOURCE_INTL = 'mca-international';
const SOURCE_RANK = 'mca-rankings';
const BASE = 'https://maharashtracarromassociation.com';

/**
 * MCA scraper. Two flavours:
 *
 * 1. `scrapeMcaInternational()` — the international-players page. Card-based
 *    layout, each `<div class="effect">` block holds one player with an
 *    <img> alt-tagged with the name, a `.photoName` div (name), a
 *    `.photoDesi` div (club), and a second `.photoName` (city).
 *
 * 2. `scrapeMcaRankings()` — the ranking tables under `players_points_table*.php`.
 *    Rows are `<tr class="rowN">` with `<td class="column2 styleN s">Name, City</td>`.
 *    A single page holds multiple categories (Men, Women, Junior, etc.)
 *    stacked in separate `<table>`s but they all use the same cell class.
 *    We rely on the "Name, City" comma-split to extract each field.
 */

export async function scrapeMcaInternational(): Promise<Player[]> {
  const html = await fetchHtml(`${BASE}/international_player.php`);
  const $ = cheerio.load(html);
  const players: Player[] = [];

  $('div.effect').each((_, el) => {
    const $el = $(el);
    const img = $el.find('img').first();
    const alt = (img.attr('alt') ?? '').trim();
    if (!alt) return;
    // Each card contains two <img>s (player photo + club logo). The player
    // card also has .photoName children; the logo-only cards do not.
    const photoNames = $el.find('.photoName');
    if (photoNames.length === 0) return;

    const name = normalizeName(alt);
    if (!isCleanName(name)) return;

    const club = ($el.find('.photoDesi').first().text() ?? '').trim() || undefined;
    const city = (photoNames.eq(1).text() ?? '').trim() || undefined;

    players.push({ name, country: 'India', city, club, source: SOURCE_INTL });
  });

  return players;
}

const RANKING_PAGES: readonly string[] = [
  'players_points_table.php',
  'players_points_table_2025_26.php',
];

/**
 * Extract from an MCA ranking page (or from a whole-year points table).
 * Each name-cell reads: "First Last, City [(Category)]" — the parenthesised
 * trailer is optional and gets stripped. City after the last comma.
 */
function extractRankingRows(html: string): Player[] {
  const $ = cheerio.load(html);
  const out: Player[] = [];
  $('td.column2').each((_, td) => {
    // Text-only content of the cell, stripping any nested spans.
    const raw = $(td).text().trim();
    if (!raw) return;
    // Some cells use "Name, City" with a comma; others use "Name ( City )".
    // Split on either.
    let name = raw;
    let city: string | undefined;
    // Linear-time pattern: name = anything without parens, city = anything
    // without a closing paren. Both groups use character classes that
    // exclude their own boundary chars, so the engine has no room to
    // backtrack (Sonar S8786).
    const paren = /^([^()]*)\(([^)]*)\)\s*$/.exec(raw);
    if (paren) {
      name = paren[1].trim();
      city = paren[2].trim();
    } else {
      const idx = raw.lastIndexOf(',');
      if (idx > 0) {
        name = raw.slice(0, idx).trim();
        city = raw.slice(idx + 1).trim();
      }
    }
    name = normalizeName(name);
    if (!isCleanName(name)) return;
    // Strip any trailing "-Sub" / "-Jr" city qualifiers.
    if (city) {
      city = city.replace(/[-–]\s*(Sub|Jr|Junior|Senior)\s*$/i, '').trim();
      if (!city) city = undefined;
    }
    out.push({ name, country: 'India', city, source: SOURCE_RANK });
  });
  return out;
}

export async function scrapeMcaRankings(): Promise<Player[]> {
  const all: Player[] = [];
  for (const path of RANKING_PAGES) {
    try {
      const html = await fetchHtml(`${BASE}/${path}`);
      const rows = extractRankingRows(html);
      console.log(`[${SOURCE_RANK}] ${path}: ${rows.length} rows`);
      all.push(...rows);
    } catch (e) {
      console.warn(`[${SOURCE_RANK}] ${path} failed:`, (e as Error).message);
    }
  }
  return all;
}

export async function scrapeMcaAll(): Promise<Player[]> {
  const [intl, rank] = await Promise.all([
    scrapeMcaInternational().catch((e) => {
      console.warn(`[${SOURCE_INTL}] failed:`, (e as Error).message);
      return [] as Player[];
    }),
    scrapeMcaRankings().catch((e) => {
      console.warn(`[${SOURCE_RANK}] failed:`, (e as Error).message);
      return [] as Player[];
    }),
  ]);
  return [...intl, ...rank];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const players = await scrapeMcaAll();
  console.log(`Scraped ${players.length} players from MCA`);
  console.log(JSON.stringify(players.slice(0, 5), null, 2));
}
