import * as cheerio from 'cheerio';
import { fetchHtml, isCleanName, normalizeName, type Player } from './lib.ts';

const SOURCE = 'mca-international';
const URL = 'https://maharashtracarromassociation.com/international_player.php';

/**
 * MCA international players page layout (as of Jul 2026):
 *   <div class="effect ..."> holds one player card. Inside:
 *     <img alt="Player Name" title="Player Name">
 *     <div class="photoName">Player Name</div>   <-- 1st photoName = name
 *     <div class="photoDesi">Club / Employer</div>
 *     <div class="photoName">City</div>          <-- 2nd photoName = city
 *
 * We rely on <img alt> since it uniquely identifies each card and skips
 * ambiguous secondary photoName rows (which reoccur down the page as
 * medal-count labels).
 */
export async function scrapeMcaInternational(): Promise<Player[]> {
  const html = await fetchHtml(URL);
  const $ = cheerio.load(html);
  const players: Player[] = [];

  $('div.effect').each((_, el) => {
    const $el = $(el);
    const img = $el.find('img').first();
    const alt = (img.attr('alt') ?? '').trim();
    if (!alt) return;
    // The layout has two <img>s per player card — the player photo and the
    // club logo. We want only the player photo, which is inside a div that
    // also contains photoName children. Cards with only a club-logo image
    // have no photoName children.
    const photoNames = $el.find('.photoName');
    if (photoNames.length === 0) return;

    const name = normalizeName(alt);
    if (!isCleanName(name)) return;

    const club = ($el.find('.photoDesi').first().text() ?? '').trim() || undefined;
    // 2nd photoName within the same card is the city
    const city = (photoNames.eq(1).text() ?? '').trim() || undefined;

    players.push({
      name,
      country: 'India',
      city,
      club,
      source: SOURCE,
    });
  });

  return players;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const players = await scrapeMcaInternational();
  console.log(`Scraped ${players.length} players from ${SOURCE}`);
  console.log(JSON.stringify(players, null, 2));
}
