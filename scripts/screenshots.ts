/**
 * Playwright capture script for README screenshots. Runs against the local
 * dev server (`npm run dev`) — start that first. Writes PNGs to
 * `docs/screenshots/`. Each shot uses the two demo players Swapnil
 * Deshpande and Yuvaraj Eshwaramoorthy so captions read consistently.
 *
 * Usage:
 *   npm run dev             # in one terminal
 *   npx tsx scripts/screenshots.ts   # in another
 */
import { chromium, devices } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'http://localhost:4321/carromscore';
const OUT = resolve(process.cwd(), 'docs/screenshots');
mkdirSync(OUT, { recursive: true });

// Portrait phone for the setup screen (Pixel 7 ratio).
const PORTRAIT = { width: 412, height: 900 };
// Landscape phone for the score screen. Slightly wider than a real phone so
// the layout has breathing room and reads well as a README image.
const LANDSCAPE = { width: 960, height: 440 };

const PLAYER_A = 'Swapnil Deshpande';
const PLAYER_B = 'Yuvaraj Eshwaramoorthy';
const NOTE_A = 'Denmark';
const NOTE_B = 'India';

const config = new URLSearchParams({
  mode: 'singles',
  playerA: PLAYER_A,
  playerB: PLAYER_B,
  noteA: NOTE_A,
  noteB: NOTE_B,
  bestOf: '3',
  pointsTarget: '25',
  maxBoards: '8',
}).toString();
const SCORE_URL = `${BASE}/score/?${config}`;

async function main() {
  const browser = await chromium.launch();

  // Setup screen (portrait phone)
  const phone = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: PORTRAIT,
    reducedMotion: 'reduce',   // stop the update-banner dot pulsing mid-capture
  });
  const p1 = await phone.newPage();
  await p1.goto(BASE + '/', { waitUntil: 'networkidle' });
  // Wait for player fetch to resolve so the picker autocomplete works.
  await p1.waitForTimeout(400);
  await p1.screenshot({ path: `${OUT}/01-setup-blank.png` });
  console.log('01-setup-blank.png');

  // Fill in the form so a second shot shows a realistic setup ready to start.
  await p1.locator('input[placeholder="Type a name…"]').first().fill(PLAYER_A);
  await p1.locator('input[placeholder="Country, state, club…"]').first().fill(NOTE_A);
  await p1.locator('input[placeholder="Type a name…"]').nth(1).fill(PLAYER_B);
  await p1.locator('input[placeholder="Country, state, club…"]').nth(1).fill(NOTE_B);
  await p1.locator('body').click({ position: { x: 10, y: 10 } });  // dismiss any suggestion
  await p1.waitForTimeout(200);
  await p1.screenshot({ path: `${OUT}/02-setup-filled.png` });
  console.log('02-setup-filled.png');

  await phone.close();

  // Score screen (landscape phone). Uses a fresh context so the SW cache
  // and any state from p1 don't leak in.
  const tv = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p2 = await tv.newPage();

  // 0-0-0 opening shot with the rotate-hint dismissed. Because the landscape
  // viewport is wider than tall, the rotate-hint media query never fires and
  // the score grid renders directly.
  await p2.goto(SCORE_URL, { waitUntil: 'networkidle' });
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/03-score-fresh.png` });
  console.log('03-score-fresh.png');

  /*
   * Playwright + tsx has a known collision on downlevelled `_name` helpers:
   * passing a compiled TS arrow into page.evaluate() can hit a
   * "__name is not defined" in the browser context. We work around it by
   * shipping the whole bump sequence as a plain string of JS to
   * page.evaluate(). Same effect, no transpile lineage.
   */
  const BUMP_SCRIPT = `
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        if (!btn) return;
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      await tap('.col.side-a.pts', 12);
      await tap('.col.side-b.pts', 8);
      await tap('.col.mid.brd', 4);
    })();
  `;
  // Simulate a mid-set: A 12, B 8, board 4.
  await p2.evaluate(BUMP_SCRIPT);
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: `${OUT}/04-score-midset.png` });
  console.log('04-score-midset.png');

  // Push side A from 12 to 22 to fire the queen-lockout ticker.
  await p2.evaluate(`
    (async () => {
      const btn = document.querySelector('.col.side-a.pts');
      for (let i = 0; i < 10; i += 1) {
        btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
        btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
        await new Promise((r) => setTimeout(r, 4));
      }
    })();
  `);
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: `${OUT}/05-score-queen-lockout.png` });
  console.log('05-score-queen-lockout.png');

  // End match → fireworks popup. Sequence matters: bumping SET zeroes both
  // POINTS (adjustSets resets so the next set starts fresh), so we bump
  // sets FIRST, then bump points to a realistic decider score. That gives
  // the popup a meaningful "Final board 25-18".
  await p2.evaluate(`
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      // Simulate 2-1 in sets, then a decider set that ended 25-18.
      await tap('.col.side-a.set', 2);
      await tap('.col.side-b.set', 1);
      await tap('.col.side-a.pts', 25);
      await tap('.col.side-b.pts', 18);
      await tap('.col.mid.brd', 7);
    })();
  `);
  await p2.locator('.foot-btn.endm').click();
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/06-end-match-popup.png` });
  console.log('06-end-match-popup.png');

  // Dismiss the popup → show the twin-medal treatment on the name pills.
  await p2.locator('.confirm-big').click();
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: `${OUT}/07-end-match-medals.png` });
  console.log('07-end-match-medals.png');

  await browser.close();
  console.log(`Wrote screenshots to ${OUT}`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
