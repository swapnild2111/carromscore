/**
 * Post-build asset manifest generator.
 *
 * Runs after `astro build`. Walks dist/ and emits dist/asset-manifest.json:
 *
 *   {
 *     "version": "2.2.5",
 *     "buildId": "1786611234567",
 *     "assets": [
 *       "/carromscore/_astro/MatchSetup.C6gaFUHC.js",
 *       "/carromscore/_astro/MatchSetup.B0IfGdHw.css",
 *       ...
 *     ],
 *     "pages": [
 *       "/carromscore/",
 *       "/carromscore/score/",
 *       "/carromscore/live/",
 *       "/carromscore/admin/"
 *     ]
 *   }
 *
 * The service worker fetches this on install and precaches every listed
 * URL via `cache.addAll`. That way the app works fully offline after a
 * single successful visit — no more "half a page" when the network
 * flakes out mid-JS-fetch.
 *
 * Why not just precache `dist/*` blindly? Some files are unneeded on
 * every route (icons for a specific size, screenshots in docs) and
 * precaching them wastes device storage. This script picks the assets
 * we actually depend on: _astro/*, favicon.svg, icon-512.png,
 * manifest.webmanifest, data/players.json, dseg7 fonts.
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const BASE = process.env.PUBLIC_BASE || '/carromscore/';

/**
 * Walk a directory tree, returning every file's absolute path.
 * No node_modules / dotfile filtering needed — we're only ever
 * called on dist/, which is a clean build output.
 */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

/**
 * Convert an absolute path under dist/ to the public URL the browser
 * will request. E.g. dist/_astro/foo.js → /carromscore/_astro/foo.js.
 */
function toPublicUrl(abs) {
  const rel = relative(DIST, abs).split(sep).join('/');
  return BASE + rel;
}

/**
 * True if the asset is worth precaching. We include:
 *   - Every JS/CSS in _astro/ (Astro's hashed bundles)
 *   - Every font in _astro/ (dseg7 subsets)
 *   - Top-level static files the app needs on any route:
 *     favicon, icons, manifest, players seed
 *
 * We EXCLUDE:
 *   - .html files (already in the pages list — handled separately
 *     so the SW's `fetch` handler with `mode === 'navigate'` can
 *     network-first for freshness).
 *   - sw.js itself (Chrome caches the SW independently).
 *   - asset-manifest.json (that's how we found this list).
 *   - Screenshots / docs images (huge, only used in help pages).
 */
function shouldPrecache(abs) {
  const rel = relative(DIST, abs).split(sep).join('/');
  if (rel.endsWith('.html')) return false;
  if (rel === 'sw.js') return false;
  if (rel === 'asset-manifest.json') return false;
  if (rel === 'robots.txt' || rel === '.nojekyll') return false;
  // _astro/ tree: always in.
  if (rel.startsWith('_astro/')) return true;
  // Small top-level static that every route may reach for.
  if (rel === 'favicon.svg') return true;
  if (rel === 'manifest.webmanifest') return true;
  if (rel === 'icon-192.png' || rel === 'icon-512.png') return true;
  // Everything else (help screenshots, other misc) — skip. The
  // SW's runtime `cacheFirst` will still cache them on first
  // fetch if the user visits a page that needs them.
  return false;
}

/**
 * Collect page routes we want precached so navigation works offline.
 * Astro emits each route as `<slug>/index.html`; the browser will
 * request that as `<slug>/`. We list the pretty URLs, not the raw
 * .html paths.
 */
function collectPages(allFiles) {
  const pages = [];
  for (const abs of allFiles) {
    const rel = relative(DIST, abs).split(sep).join('/');
    if (!rel.endsWith('/index.html') && rel !== 'index.html') continue;
    if (rel === 'index.html') pages.push(BASE);
    else pages.push(BASE + rel.replace(/index\.html$/, ''));
  }
  return pages;
}

function main() {
  const all = walk(DIST);
  const assets = all
    .filter(shouldPrecache)
    .map(toPublicUrl)
    .sort();
  const pages = collectPages(all).sort();

  // Version + buildId become the SW's cache key. `version` comes from
  // src/lib/version.ts; `buildId` is a per-build epoch stamp so a
  // rebuild with the same version still busts the cache.
  const versionSrc = readFileSync(join(ROOT, 'src', 'lib', 'version.ts'), 'utf8');
  const versionMatch = versionSrc.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  const version = versionMatch ? versionMatch[1] : '0.0.0';
  const buildId = String(Date.now());

  const manifest = { version, buildId, assets, pages };
  writeFileSync(
    join(DIST, 'asset-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(
    `[build-manifest] wrote asset-manifest.json — version ${version}, ${assets.length} assets, ${pages.length} pages`,
  );
}

main();
