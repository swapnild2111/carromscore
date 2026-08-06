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
  await p1.locator('body').click({ position: { x: 10, y: 10 }, force: true });  // dismiss any suggestion
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
  await p2.locator('.foot-btn.endm').click({ force: true });
  await p2.waitForTimeout(400);
  await p2.screenshot({ path: `${OUT}/06-end-match-popup.png` });
  console.log('06-end-match-popup.png');

  // Dismiss the popup → show the twin-medal treatment on the name pills.
  await p2.locator('.confirm-big').click({ force: true });
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: `${OUT}/07-end-match-medals.png` });
  console.log('07-end-match-medals.png');

  await tv.close();

  /*
   * Practice mode shots. Solo drill flow: setup → single-set scoreboard
   * → multi-set with horizontal board scroll → End Match recap matrix.
   */

  // 08 Setup with Practice mode selected (portrait phone).
  const phone2 = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: PORTRAIT,
    reducedMotion: 'reduce',
  });
  const p3 = await phone2.newPage();
  await p3.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p3.waitForTimeout(400);
  await p3.locator('label:has(input[value="practice"])').click({ force: true });
  await p3.waitForTimeout(150);
  await p3.locator('input[placeholder="Type a name…"]').first().fill(PLAYER_A);
  await p3.locator('input[placeholder="Country, state, club…"]').first().fill(NOTE_A);
  await p3.locator('body').click({ position: { x: 10, y: 10 }, force: true });
  await p3.waitForTimeout(200);
  await p3.screenshot({ path: `${OUT}/08-practice-setup.png` });
  console.log('08-practice-setup.png');
  await phone2.close();

  // 09 Practice single-set (1 × 4). Landscape phone-ish viewport.
  const tv2 = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p4 = await tv2.newPage();
  const practiceSingleUrl = `${BASE}/score/?${new URLSearchParams({
    mode: 'practice',
    playerA: PLAYER_A,
    noteA: NOTE_A,
    bestOf: '1',
    maxBoards: '4',
  }).toString()}`;
  await p4.goto(practiceSingleUrl, { waitUntil: 'networkidle' });
  await p4.waitForTimeout(400);
  await p4.evaluate(`
    (async () => {
      const cells = document.querySelectorAll('.pcell');
      const tap = async (i, n) => {
        for (let k = 0; k < n; k += 1) {
          cells[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          cells[i].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      await tap(0, 3); await tap(1, 5); await tap(2, 2); await tap(3, 4);
    })();
  `);
  await p4.waitForTimeout(200);
  await p4.screenshot({ path: `${OUT}/09-practice-single-set.png` });
  console.log('09-practice-single-set.png');
  await tv2.close();

  // 10 Practice multi-set with 8 boards → horizontal scroll + chips + pager.
  const tv3 = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p5 = await tv3.newPage();
  const practiceMultiUrl = `${BASE}/score/?${new URLSearchParams({
    mode: 'practice',
    playerA: PLAYER_A,
    noteA: NOTE_A,
    bestOf: '3',
    maxBoards: '8',
  }).toString()}`;
  await p5.goto(practiceMultiUrl, { waitUntil: 'networkidle' });
  await p5.waitForTimeout(400);
  const bumpMulti = async (page: import('playwright').Page, pairs: [number, number][]) => {
    await page.evaluate(`
      (async () => {
        const cells = document.querySelectorAll('.pcell');
        const tap = async (i, n) => {
          for (let k = 0; k < n; k += 1) {
            cells[i].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
            cells[i].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
            await new Promise((r) => setTimeout(r, 4));
          }
        };
        const pairs = ${JSON.stringify(pairs)};
        for (const [i, n] of pairs) await tap(i, n);
      })();
    `);
  };
  // Fill B1–B4 in set 1
  await bumpMulti(p5, [[0, 3], [1, 5], [2, 2], [3, 4]]);
  await p5.waitForTimeout(200);
  await p5.screenshot({ path: `${OUT}/10-practice-multi-scroll.png` });
  console.log('10-practice-multi-scroll.png');

  // Fill B5–B8, advance to set 2, set 3, then End Match
  await bumpMulti(p5, [[4, 1], [5, 6], [6, 2], [7, 3]]);
  await p5.locator('.practice-pager .practice-pager-btn').nth(1).click({ force: true });
  await p5.waitForTimeout(200);
  await bumpMulti(p5, [[0, 2], [1, 3], [2, 1], [3, 4], [4, 2], [5, 5], [6, 3], [7, 2]]);
  await p5.locator('.practice-pager .practice-pager-btn').nth(1).click({ force: true });
  await p5.waitForTimeout(200);
  await bumpMulti(p5, [[0, 4], [1, 2], [2, 3], [3, 1], [4, 5], [5, 2], [6, 4], [7, 3]]);
  await p5.locator('.foot-btn.endm').click({ force: true });
  await p5.waitForTimeout(400);
  await p5.screenshot({ path: `${OUT}/11-practice-recap.png` });
  console.log('11-practice-recap.png');
  await tv3.close();

  /*
   * 12 Share URL popup. Score screen (singles), tap Share URL button.
   * Shows both URL rows (overlay ready, live spectator coming soon).
   */
  const tv4 = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p6 = await tv4.newPage();
  await p6.goto(SCORE_URL, { waitUntil: 'networkidle' });
  await p6.waitForTimeout(400);
  await p6.locator('.foot-btn.share').click({ force: true });
  await p6.waitForTimeout(300);
  await p6.screenshot({ path: `${OUT}/12-share-popup.png` });
  console.log('12-share-popup.png');
  await tv4.close();

  /*
   * 13 Overlay bare (1920×1080 broadcast canvas). Mid-match state seeded
   * via localStorage so the DSEG7 digits, coloured pills, set pips,
   * BREAK chip, and red queen coin are all visible in one shot.
   */
  const stream = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
  });
  const p7 = await stream.newPage();
  const overlayUrl = `${SCORE_URL}&view=overlay`;
  await p7.goto(overlayUrl, { waitUntil: 'networkidle' });
  await p7.waitForTimeout(300);
  await p7.evaluate(`
    localStorage.setItem(
      'carromscore:state:singles:${PLAYER_A}:${PLAYER_B}',
      JSON.stringify({
        sideA: { points: 18, sets: 1 },
        sideB: { points: 12, sets: 0 },
        board: 5,
        currentBreak: 'a',
        queenHolder: 'b',
        matchResult: null,
      }),
    );
  `);
  await p7.reload({ waitUntil: 'networkidle' });
  await p7.waitForTimeout(400);
  await p7.screenshot({ path: `${OUT}/13-overlay-bare.png` });
  console.log('13-overlay-bare.png');

  /*
   * 14 Overlay composited over a mock carrom-green camera feed. Shows
   * how the transparent strip lands on top of live footage in OBS/Prism.
   */
  await p7.evaluate(`
    document.documentElement.style.background = 'linear-gradient(180deg, #2c4b1e 0%, #1a2c11 100%)';
    document.body.style.background = 'transparent';
  `);
  await p7.waitForTimeout(150);
  await p7.screenshot({ path: `${OUT}/14-overlay-composited.png` });
  console.log('14-overlay-composited.png');

  /*
   * 15 Overlay end-of-match with winner medal treatment. Same 1920×1080
   * canvas so the twin-medal pill design reads at broadcast scale.
   */
  await p7.evaluate(`
    localStorage.setItem(
      'carromscore:state:singles:${PLAYER_A}:${PLAYER_B}',
      JSON.stringify({
        sideA: { points: 25, sets: 2 },
        sideB: { points: 18, sets: 1 },
        board: 7,
        currentBreak: 'a',
        queenHolder: null,
        matchResult: 'a',
      }),
    );
  `);
  await p7.reload({ waitUntil: 'networkidle' });
  await p7.waitForTimeout(400);
  await p7.evaluate(`
    document.documentElement.style.background = 'linear-gradient(180deg, #2c4b1e 0%, #1a2c11 100%)';
    document.body.style.background = 'transparent';
  `);
  await p7.waitForTimeout(150);
  await p7.screenshot({ path: `${OUT}/15-overlay-endgame.png` });
  console.log('15-overlay-endgame.png');
  await stream.close();

  await browser.close();
  console.log(`Wrote screenshots to ${OUT}`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
