/**
 * Playwright capture script for short "how it works" videos.
 *
 * Runs against the local dev server (`npm run dev`) — start that in
 * another terminal first. Writes .webm files to `docs/videos/`,
 * one per flow. Each flow uses the same demo players as
 * `scripts/screenshots.ts` so captions read consistently:
 *   - Swapnil Deshpande vs Yuvaraj Eshwaramoorthy
 *
 * Usage:
 *   npm run dev                     # in one terminal
 *   npx tsx scripts/videos.ts       # in another
 *
 * Design decisions:
 * - Portrait phone viewport (Pixel 7 shape) for the setup flow;
 *   landscape for the scoreboard flow so the score grid renders
 *   at its intended aspect ratio.
 * - Playwright records the ENTIRE context lifespan as one video,
 *   so each flow uses its own newContext() + close() to bound
 *   the clip. Close is where the .webm is finalised on disk.
 * - Human-pace pauses between actions (250–800 ms). Instant taps
 *   look robotic and skip past the interactions we're trying
 *   to demonstrate. If you tighten these too far the resulting
 *   .webm reads as an animated infomercial glitch, not a demo.
 * - The videos land as raw .webm — GitHub markdown embeds them
 *   natively via <video> tags. For .gif or .mp4 you need ffmpeg
 *   (out of scope for this first pass; see docs/dev if you add
 *   the converter step later).
 *
 * Adding a new flow: copy one of the recordFlow() calls at the
 * bottom, give it a unique name (used as the .webm filename), and
 * inside its callback drive Playwright with the shared locators.
 */
import { chromium, devices, type BrowserContext, type Page } from 'playwright';
import { mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const BASE = 'http://localhost:4321/carromscore';
const OUT = resolve(process.cwd(), 'docs/videos');
mkdirSync(OUT, { recursive: true });

// Viewport sizes for Playwright recordVideo. Both dimensions MUST
// be divisible by 16 — VP8/VP9 encoders inside Playwright's webm
// encoder use 16-pixel macroblocks, and if a viewport isn't a clean
// multiple the encoder pads the frame with grey on the right / bottom
// (rather than cropping to the aligned size). Landed on this after
// a first attempt at 851×393 baked a grey right band into the
// score-a-board recording — 851 is not /16 → 53 px of grey.

// Portrait phone for setup + lobby flows (Pixel 7-ish, /16-aligned).
const PORTRAIT = { width: 400, height: 896 };
// Landscape phone for the score screen. 16:9-ish, /16-aligned so
// the encoder emits an edge-to-edge frame with no grey band.
const LANDSCAPE = { width: 832, height: 384 };

const PLAYER_A = 'Swapnil Deshpande';
const PLAYER_B = 'Yuvaraj Eshwaramoorthy';
const NOTE_A = 'Denmark';
const NOTE_B = 'India';

/**
 * Human-friendly pause. Playwright's page.waitForTimeout blocks for
 * exactly this long — Playwright ships it as the recommended
 * "pace the recording" primitive.
 */
async function pause(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Record one flow to <name>.webm. Bounds the recording with a fresh
 * context so the .webm covers exactly the flow, not the browser
 * boot noise.
 *
 * Playwright names its recordings with a random hash (…\.webm).
 * We rename it to <name>.webm after context.close() finalises the
 * file on disk. The rename fires only if exactly one .webm shows
 * up as new — if Playwright ever writes multiple per context we
 * bail loudly rather than picking the wrong one.
 */
async function recordFlow(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  name: string,
  viewport: { width: number; height: number },
  extra: Parameters<typeof browser.newContext>[0] | undefined,
  run: (page: Page, context: BrowserContext) => Promise<void>,
): Promise<void> {
  const before = new Set(readdirSync(OUT).filter((f) => f.endsWith('.webm')));
  const context = await browser.newContext({
    ...(extra ?? {}),
    viewport,
    recordVideo: { dir: OUT, size: viewport },
    // Freeze animations that would otherwise loop through the whole
    // recording (the LIVE-dot pulse, update-banner glow) so a 12 s
    // clip encodes cleanly and doesn't play tricks on the compressor.
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  try {
    await run(page, context);
  } finally {
    // context.close() finalises the .webm — closing the page alone
    // is not enough. Playwright docs are explicit on this.
    await context.close();
  }
  const after = readdirSync(OUT).filter((f) => f.endsWith('.webm'));
  const fresh = after.filter((f) => !before.has(f));
  if (fresh.length !== 1) {
    throw new Error(
      `Expected 1 new .webm for flow "${name}", got ${fresh.length}: ${fresh.join(', ')}`,
    );
  }
  const src = resolve(OUT, fresh[0]!);
  const dst = resolve(OUT, `${name}.webm`);
  renameSync(src, dst);
  console.log(`✓ ${name}.webm`);
}

async function main() {
  const browser = await chromium.launch();

  // ─── Flow 1: start-a-match ───────────────────────────────────────
  // Portrait phone. From the home screen: type player names, tag a
  // tournament, tap Start — land on the scoreboard. ~15 seconds.
  await recordFlow(
    browser,
    'start-a-match',
    PORTRAIT,
    { ...devices['Pixel 7'] },
    async (page) => {
      // domcontentloaded + explicit locator wait, NOT networkidle:
      // Firebase RTDB keeps a persistent WebSocket so the tab never
      // reaches "idle" by Playwright's definition, and 'networkidle'
      // would just time out waiting for a socket that stays open by
      // design.
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
      await page
        .locator('input[placeholder="Type a name…"]')
        .first()
        .waitFor({ state: 'visible', timeout: 15000 });
      // Hold on the fresh home screen for a beat so the viewer's eye
      // has time to settle on the layout before things start moving.
      await pause(page, 800);

      // Player A. Slow type so the fill reads as a person typing,
      // not a paste. Each keystroke ~60 ms; a name of length 18
      // takes ~1.1 s.
      await page
        .locator('input[placeholder="Type a name…"]')
        .first()
        .pressSequentially(PLAYER_A, { delay: 60 });
      // Small pause between fields so the layout redraws before we
      // move on — otherwise the note-input's placeholder blur happens
      // mid-navigation and the video feels jumpy.
      await pause(page, 300);
      await page
        .locator('input[placeholder="Country, state, club…"]')
        .first()
        .pressSequentially(NOTE_A, { delay: 60 });
      await pause(page, 300);

      // Player B.
      await page
        .locator('input[placeholder="Type a name…"]')
        .nth(1)
        .pressSequentially(PLAYER_B, { delay: 60 });
      await pause(page, 300);
      await page
        .locator('input[placeholder="Country, state, club…"]')
        .nth(1)
        .pressSequentially(NOTE_B, { delay: 60 });
      await pause(page, 300);

      // Tournament tag. Optional field but a nice touch that lands
      // the resulting match under a bucket in History / Reports.
      const tournamentInput = page.locator('label.tournament-input input');
      if (await tournamentInput.count()) {
        await tournamentInput.pressSequentially('Demo Cup 2026', { delay: 60 });
        // Dismiss any suggestion dropdown so the shot of the filled
        // form isn't marred by a floating menu.
        await page.locator('body').click({ position: { x: 5, y: 5 }, force: true });
        await pause(page, 250);
      }

      // Hold on the filled form for a beat so the viewer registers
      // what's about to happen before Start fires.
      await pause(page, 600);

      // Start. Fires the /score/ navigation; wait for the scoreboard
      // to actually paint before we let the recording close.
      await page.locator('button.start').click();
      await page.waitForURL(/\/score\//);
      // On a portrait viewport <900px the ScoreBoard renders its
      // rotate-hint splash ("Tap to start scoring — Carromscore
      // uses landscape") first. That IS educational for video 1 —
      // it tells the viewer what happens next. Wait for the splash
      // to be visible, then hold on it so the caption reads clearly
      // before the recording cuts. Video 2 will pick up from the
      // landscape scoreboard.
      await page
        .locator('.rotate-hint')
        .waitFor({ state: 'visible', timeout: 15000 });
      await pause(page, 2200);
    },
  );

  // ─── Flow 2: score-a-board ──────────────────────────────────────
  // Landscape phone. Jump straight to the score URL (fully-configured
  // via query params), then drive the score grid: bump points, mark
  // the queen, advance BOARD. ~12 seconds.
  const scoreConfig = new URLSearchParams({
    mode: 'singles',
    playerA: PLAYER_A,
    playerB: PLAYER_B,
    noteA: NOTE_A,
    noteB: NOTE_B,
    bestOf: '3',
    pointsTarget: '25',
    maxBoards: '8',
  }).toString();
  const scoreUrl = `${BASE}/score/?${scoreConfig}`;

  // No deviceScaleFactor override for the recording — Playwright's
  // recordVideo captures at the CSS viewport size, and a 2x DSF
  // silently drives some players to render the .webm letterboxed
  // with only half the video visible. Leaving DSF at 1 keeps the
  // encoded frame 1:1 with the viewport.
  await recordFlow(
    browser,
    'score-a-board',
    LANDSCAPE,
    undefined,
    async (page) => {
      await page.goto(scoreUrl, { waitUntil: 'domcontentloaded' });
      // Wait for the score grid to actually mount before we start
      // tapping — same RTDB-long-poll rationale as the setup flow.
      await page
        .locator('.col.side-a.pts')
        .waitFor({ state: 'visible', timeout: 15000 });
      // Hold on the fresh 0-0-0 board so the viewer sees the starting
      // layout — sides, score columns, board counter.
      await pause(page, 1000);

      // Bump A to 8, B to 5, one tap at a time so the digits animate
      // visibly. tap() below is a helper that mimics the pointer
      // events the score columns actually listen for (see
      // src/components/ScoreBoard.svelte's swipeAdjust action).
      await tap(page, '.col.side-a.pts', 8);
      await pause(page, 400);
      await tap(page, '.col.side-b.pts', 5);
      await pause(page, 400);

      // Mark queen on A. Coin button is a real onclick handler, so
      // Playwright's page.click works directly — no pointer-event
      // dispatch needed here.
      await page.locator('.head-side .coin-btn').first().click();
      await pause(page, 700);

      // Advance BOARD +1. This ends the board with A as the winner
      // (higher points + queen), commits the row, and increments
      // the board counter under the mid column.
      await tap(page, '.col.mid.brd', 1);
      await pause(page, 1200);
    },
  );

  await browser.close();
  console.log('\nDone. Videos in docs/videos/*.webm');
}

/**
 * Fire N pointerdown/pointerup pairs against the given selector.
 * The score-grid columns bind their tap-to-increment via a Svelte
 * `use:swipeAdjust` action that listens for pointer events, so a
 * plain page.click() doesn't register. Mirrors the same helper
 * used in scripts/screenshots.ts.
 */
async function tap(page: Page, selector: string, count: number): Promise<void> {
  await page.evaluate(
    ([sel, n]: [string, number]) => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) throw new Error(`no element for selector ${sel}`);
      for (let i = 0; i < n; i += 1) {
        el.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            isPrimary: true,
            clientX: 0,
            clientY: 0,
          }),
        );
        el.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            isPrimary: true,
            clientX: 0,
            clientY: 0,
          }),
        );
      }
    },
    [selector, count] as [string, number],
  );
  // Give Svelte a tick to flush the reactive updates so the recording
  // captures each tap distinctly rather than a single batched jump.
  await pause(page, 160);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
