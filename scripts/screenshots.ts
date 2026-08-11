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
  // v2: fill the Tournament tag field too
  const tournamentInput = p1.locator('label.tournament-input input');
  if (await tournamentInput.count()) {
    await tournamentInput.fill('Silver Cup 2026');
  }
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
      // v2: BOARD is 0-indexed. Complete two boards by advancing BOARD +1
      // twice, marking a queen holder before each advance (guard requires it).
      // Then leave the third board mid-play: A 12, B 8, queen on A.
      // Queen coin uses onclick (not use:swipeAdjust like the score columns),
      // so it needs a real .click() — dispatched PointerEvents are ignored.
      const tapCoin = async () => {
        const c = document.querySelector('.head-side .coin-btn');
        if (c && !c.classList.contains('coin-red')) {
          c.click();
          await new Promise((r) => setTimeout(r, 40));
        }
      };
      // Board 1 → mark queen → BOARD +1
      await tap('.col.side-a.pts', 4);
      await tap('.col.side-b.pts', 3);
      await tapCoin();
      await tap('.col.mid.brd', 1);
      // Board 2 → mark queen → BOARD +1
      await tap('.col.side-a.pts', 5);
      await tap('.col.side-b.pts', 2);
      await tapCoin();
      await tap('.col.mid.brd', 1);
      // Board 3 mid-play: A 12 (already at 9, add 3), B 8 (already at 5, add 3), queen on A.
      await tap('.col.side-a.pts', 3);
      await tap('.col.side-b.pts', 3);
      await tapCoin();
    })();
  `;
  // Simulate a mid-set: A 12, B 8, queen on A, 2 boards done + one in progress.
  await p2.evaluate(BUMP_SCRIPT);
  await p2.waitForTimeout(200);
  await p2.screenshot({ path: `${OUT}/04-score-midset.png` });
  console.log('04-score-midset.png');

  // 05: queen-guard toast. Return queen to table (both coins grey), then
  // add fresh points and tap BOARD +1 — the app blocks with the guard toast.
  await p2.evaluate(`
    (async () => {
      // Un-toggle the currently-red coin so queen is null.
      const red = document.querySelector('.head-side .coin-btn.coin-red');
      if (red) {
        red.click();
        await new Promise((r) => setTimeout(r, 40));
      }
      // Add a couple of fresh points so pointsAtBoardStart < current, otherwise
      // BOARD +1 would simply skip the guard (no in-progress score to snapshot).
      const bumpPoints = (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
        }
      };
      bumpPoints('.col.side-a.pts', 2);
      bumpPoints('.col.side-b.pts', 1);
      await new Promise((r) => setTimeout(r, 60));
      // Fire BOARD +1 — guard should surface the toast.
      const brd = document.querySelector('.col.mid.brd');
      brd.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
      brd.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
    })();
  `);
  await p2.waitForTimeout(300);
  await p2.screenshot({ path: `${OUT}/05-score-queen-lockout.png` });
  console.log('05-score-queen-lockout.png');

  // End match → recap popup. Fresh score-screen context so p2's accumulated
  // state (from shots 04/05) doesn't fight the guards. v2 requires a queen
  // holder before every SET+ / BOARD+ boundary that has fresh points, and
  // blocks positive deltas once matchResult is set. So we replay the whole
  // sequence marking queen before each boundary.
  await tv.close();
  const tvEnd = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p2e = await tvEnd.newPage();
  await p2e.goto(SCORE_URL, { waitUntil: 'networkidle' });
  await p2e.waitForTimeout(400);
  await p2e.evaluate(`
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      const tapQueen = async () => {
        const c = document.querySelector('.head-side .coin-btn');
        if (c && !c.classList.contains('coin-red')) {
          c.click();
          await new Promise((r) => setTimeout(r, 40));
        }
      };
      // Set 1 (A wins 25-15): 3 boards, then SET+1 A.
      await tap('.col.side-a.pts', 8); await tap('.col.side-b.pts', 5); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 9); await tap('.col.side-b.pts', 5); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 8); await tap('.col.side-b.pts', 5); await tapQueen();
      await tap('.col.side-a.set', 1);
      // Set 2 (B wins 25-20): 3 boards, then SET+1 B.
      await tap('.col.side-a.pts', 7); await tap('.col.side-b.pts', 8); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 6); await tap('.col.side-b.pts', 9); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 7); await tap('.col.side-b.pts', 8); await tapQueen();
      await tap('.col.side-b.set', 1);
      // Set 3 (decider — A ahead 25-18 mid-board when End is tapped).
      await tap('.col.side-a.pts', 9); await tap('.col.side-b.pts', 6); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 8); await tap('.col.side-b.pts', 7); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 8); await tap('.col.side-b.pts', 5); await tapQueen();
    })();
  `);
  await p2e.waitForTimeout(200);
  await p2e.locator('.foot-btn.endm').click({ force: true });
  await p2e.waitForTimeout(400);
  // v2 flow: End → winner dialog first. Click "View scorecard" → scorecard.
  await p2e.locator('.winner-dialog .confirm-big').click({ force: true });
  await p2e.waitForTimeout(400);
  await p2e.screenshot({ path: `${OUT}/06-end-match-popup.png` });
  console.log('06-end-match-popup.png');

  // Close the scorecard popup → show the twin-medal treatment on the name pills.
  await p2e.locator('.scorecard-dialog .dialog-close').click({ force: true });
  await p2e.waitForTimeout(300);
  await p2e.screenshot({ path: `${OUT}/07-end-match-medals.png` });
  console.log('07-end-match-medals.png');

  await tvEnd.close();

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
   * 12 Share popup. In v2 the two share buttons (spectator + OBS) live
   * on the /live/ lobby match-sheet dialog, not the score screen. That
   * needs a live Firebase record to open. Skipping headless capture —
   * keep the existing 12-share-popup.png committed to the repo.
   */
  console.log('12-share-popup.png (skipped — needs live match; existing PNG kept)');

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

  /*
   * 16 Feedback popup on the home footer. Portrait phone.
   */
  const phoneFb = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: PORTRAIT,
    reducedMotion: 'reduce',
  });
  const p8 = await phoneFb.newPage();
  await p8.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p8.waitForTimeout(400);
  await p8.locator('a.foot-link', { hasText: 'Feedback' }).click({ force: true });
  await p8.waitForTimeout(300);
  await p8.screenshot({ path: `${OUT}/16-feedback-popup.png` });
  console.log('16-feedback-popup.png');
  await phoneFb.close();

  /*
   * 32 Practice overlay lives inside LiveScoreboardView on the /live/?mid=…
   * spectator URL — the /score/?view=overlay path just shows a "no live
   * overlay" placeholder for practice. Capture requires a live Firebase
   * record, so we skip it and let the file be captured manually from a
   * running match later.
   */
  console.log('32-practice-overlay.png (skipped — needs live match)');

  /*
   * 33 Match-end lockout: after End is fired, tapping POINTS+ shows a toast.
   * Landscape score screen.
   */
  const lockoutCtx = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p10 = await lockoutCtx.newPage();
  await p10.goto(SCORE_URL, { waitUntil: 'networkidle' });
  await p10.waitForTimeout(400);
  // Drive to a decided match and tap End. Real click() for the coin
  // (onclick handler), PointerEvents for score columns (swipeAdjust).
  await p10.evaluate(`
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      const tapQueen = async () => {
        const c = document.querySelector('.head-side .coin-btn');
        if (c && !c.classList.contains('coin-red')) {
          c.click();
          await new Promise((r) => setTimeout(r, 40));
        }
      };
      // Set 1 (A wins): 2 boards, then SET+1 A.
      await tap('.col.side-a.pts', 12); await tap('.col.side-b.pts', 8); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 13); await tap('.col.side-b.pts', 8); await tapQueen();
      await tap('.col.side-a.set', 1);
      // Set 2 (A wins again — 2-0 sweep): 2 boards + queen for the running one.
      await tap('.col.side-a.pts', 14); await tap('.col.side-b.pts', 9); await tapQueen(); await tap('.col.mid.brd', 1);
      await tap('.col.side-a.pts', 11); await tap('.col.side-b.pts', 9); await tapQueen();
    })();
  `);
  await p10.locator('.foot-btn.endm').click({ force: true });
  await p10.waitForTimeout(400);
  // Dismiss winner dialog via its close ✕
  const winnerClose = p10.locator('.winner-dialog .dialog-close');
  if (await winnerClose.count()) await winnerClose.click({ force: true });
  await p10.waitForTimeout(200);
  // Also close scorecard if it appeared
  const scorecardClose = p10.locator('.scorecard-dialog .dialog-close');
  if (await scorecardClose.count()) await scorecardClose.click({ force: true });
  await p10.waitForTimeout(200);
  // Tap POINTS+ to trigger the lockout toast
  await p10.locator('.col.side-a.pts').click({ force: true });
  await p10.waitForTimeout(300);
  await p10.screenshot({ path: `${OUT}/33-match-end-lockout.png` });
  console.log('33-match-end-lockout.png');
  await lockoutCtx.close();

  /*
   * 34 Doubles setup — team A + team B blocks tinted blue/coral to
   * preview the on-scoreboard identity. Portrait phone, home page,
   * Doubles mode picked, both team blocks populated.
   */
  const doublesCtx = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: PORTRAIT,
    reducedMotion: 'reduce',
  });
  const p11 = await doublesCtx.newPage();
  await p11.goto(BASE + '/', { waitUntil: 'networkidle' });
  await p11.waitForTimeout(400);
  await p11.locator('label:has(input[value="doubles"])').click({ force: true });
  await p11.waitForTimeout(300);
  const doublesInputs = p11.locator('input[placeholder="Type a name…"]');
  await doublesInputs.nth(0).fill('Swapnil Deshpande');
  await doublesInputs.nth(1).fill('Yuvaraj Eshwaramoorthy');
  await doublesInputs.nth(2).fill('Prem Kumar');
  await doublesInputs.nth(3).fill('Yash Patel');
  await p11.locator('input[placeholder="Country, state, club…"]').nth(0).fill('Denmark');
  await p11.locator('input[placeholder="Country, state, club…"]').nth(1).fill('India');
  await p11.locator('body').click({ position: { x: 10, y: 10 }, force: true });
  await p11.waitForTimeout(300);
  await p11.screenshot({ path: `${OUT}/34-doubles-setup.png` });
  console.log('34-doubles-setup.png');
  await doublesCtx.close();

  /*
   * 35 Lobby view — showing three tabs (Now Playing / History /
   * Reports) and the new home-parity footer. Portrait phone.
   */
  const lobbyCtx = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 412, height: 1200 },
    reducedMotion: 'reduce',
  });
  const p12 = await lobbyCtx.newPage();
  await p12.goto(BASE + '/live/', { waitUntil: 'networkidle' });
  await p12.waitForTimeout(1500);
  await p12.screenshot({ path: `${OUT}/35-lobby-tabs.png`, fullPage: true });
  console.log('35-lobby-tabs.png');
  await lobbyCtx.close();

  /*
   * 36 Deciding-board chooser popup. Drive to a maxBoards-reached tie
   * with 2 boards, then tap End — the "Match tied?" chooser appears
   * with two buttons: Call it a draw / Play deciding board.
   */
  const deciderCtx = await browser.newContext({
    viewport: LANDSCAPE,
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });
  const p13 = await deciderCtx.newPage();
  const shortMatchUrl = `${BASE}/score/?${new URLSearchParams({
    mode: 'singles',
    playerA: PLAYER_A,
    playerB: PLAYER_B,
    noteA: NOTE_A,
    noteB: NOTE_B,
    bestOf: '1',
    pointsTarget: '25',
    maxBoards: '2',
  }).toString()}`;
  await p13.goto(shortMatchUrl, { waitUntil: 'networkidle' });
  await p13.waitForTimeout(400);
  await p13.evaluate(`
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      const tapQueen = async () => {
        const c = document.querySelector('.head-side .coin-btn');
        if (c && !c.classList.contains('coin-red')) {
          c.click();
          await new Promise((r) => setTimeout(r, 40));
        }
      };
      // Board 1: tie 5-5
      await tap('.col.side-a.pts', 5);
      await tap('.col.side-b.pts', 5);
      await tapQueen();
      await tap('.col.mid.brd', 1);
      // Board 2: tie 3-3 (cumulative 8-8) at maxBoards → End triggers chooser
      await tap('.col.side-a.pts', 3);
      await tap('.col.side-b.pts', 3);
      await tapQueen();
    })();
  `);
  await p13.waitForTimeout(200);
  await p13.locator('.foot-btn.endm').click({ force: true });
  await p13.waitForTimeout(500);
  await p13.screenshot({ path: `${OUT}/36-decider-popup.png` });
  console.log('36-decider-popup.png');

  /*
   * 37 Deciding-board banner in play. From the same match, click
   * "Play deciding board" and screenshot the un-frozen scoreboard
   * with the amber banner at the top.
   */
  await p13.locator('.champ-choice .confirm-big:not(.confirm-secondary)').click({ force: true });
  await p13.waitForTimeout(400);
  // Score a few points on the decider so the digits aren't all zero.
  await p13.evaluate(`
    (async () => {
      const tap = async (sel, n) => {
        const btn = document.querySelector(sel);
        for (let i = 0; i < n; i += 1) {
          btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, clientX: 0, clientY: 0 }));
          await new Promise((r) => setTimeout(r, 4));
        }
      };
      await tap('.col.side-a.pts', 4);
      await tap('.col.side-b.pts', 2);
    })();
  `);
  await p13.waitForTimeout(300);
  await p13.screenshot({ path: `${OUT}/37-decider-banner.png` });
  console.log('37-decider-banner.png');
  await deciderCtx.close();

  /*
   * 38 Reports tab — picker + summary card + charts + table.
   * Opens the deep-link URL directly so the Reports tab loads
   * pre-selected. Full-page screenshot on wide viewport to catch
   * the whole layout in one image.
   */
  const reportsCtx = await browser.newContext({
    viewport: { width: 1200, height: 1400 },
    reducedMotion: 'reduce',
  });
  const p14 = await reportsCtx.newPage();
  await p14.goto(`${BASE}/live/?tab=reports`, { waitUntil: 'networkidle' });
  // Wait long enough for /matches to load + tournaments store to hydrate.
  await p14.waitForTimeout(2500);
  await p14.screenshot({ path: `${OUT}/38-reports-tab.png`, fullPage: true });
  console.log('38-reports-tab.png');
  await reportsCtx.close();

  await browser.close();
  console.log(`Wrote screenshots to ${OUT}`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
