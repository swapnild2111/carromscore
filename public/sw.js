/*
 * Minimal service worker for Carromscore.
 *
 * Not using workbox / vite-plugin-pwa's SW generation because Astro's dual-Vite
 * build makes those unreliable. This ships from public/ as a static asset.
 *
 * Strategy: cache-first for GET requests, fall back to network. On offline,
 * navigation requests serve the cached index. Every deploy busts the cache
 * because CACHE_NAME uses BUILD_ID (bumped whenever we change the SW).
 */

/*
 * Bump this whenever we want to force clients to re-fetch. The `activate`
 * handler already deletes any cache whose name != CACHE_NAME, so bumping is
 * enough to purge everything old.
 */
const CACHE_NAME = 'carromscore-v1.7.3';
const OFFLINE_URL = '/carromscore/';
const PRECACHE = [
  '/carromscore/',
  '/carromscore/score/',
  '/carromscore/favicon.svg',
  '/carromscore/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  // Navigation requests: network first, cached index fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }

  // All other GETs: cache first, then network, then cache the network response.
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.status === 200 && res.type === 'basic') {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
    }
    return res;
  } catch {
    return Response.error();
  }
}
