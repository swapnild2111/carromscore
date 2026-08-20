# Architecture

Design decisions and rationale. Short read; useful for a future
contributor (or future me) trying to understand why the shape is what
it is.

## The stack

- **Astro 7** — static-site generator with a Svelte island for the
  interactive score / setup / overlay screens. Static-by-default
  matches GitHub Pages hosting; islands give us one interactive
  component per page instead of a whole SPA framework.
- **Svelte 5** with runes (`$state`, `$derived`, `$effect`) — the
  score screen is genuinely stateful (BREAK, queen, sets, points,
  board, undo boundaries). Runes give fine-grained reactivity
  without a store library.
- **Hand-rolled CSS** — no Tailwind, no component library. The app is
  small enough that the CSS fits in the component files (`<style>`
  blocks are Svelte-scoped, no CSS-in-JS runtime).
- **TypeScript** — types on the state model (`MatchConfig`,
  `PlayerRow`, `Side`), untyped inline for anything else.

## Why not a SPA framework (SvelteKit / Next)?

Two static routes (`/` = setup, `/score/` = score/overlay) don't need
a router, layouts framework, or SSR/serverless-function scaffolding.
Astro emits the two HTML files and gets out of the way. GitHub Pages
serves them for free.

## Why a TWA (Trusted Web Activity) for Android instead of a native app?

A TWA is a thin Android APK that renders the live website inside a
Chrome Custom Tab. The APK is ~1 MB and contains an icon, splash
screen, orientation lock, and Digital Asset Links. Everything else
(the app itself) lives on the website. Consequences:

- **Web-layer changes ship instantly.** Push to `main`, GitHub Pages
  deploys in ~1 min, next app launch picks up the new code. No Play
  Store review, no forced updates, no APK download for users.
- **APKs only for wrapper changes.** Icon, orientation, target SDK.
  Rare.
- **No Play Store required.** APK is signed and hosted on GitHub
  Releases. One-time "install unknown apps" prompt for users;
  familiar to anyone who's sideloaded before.
- **Single codebase for web + Android + iOS.** iPhone users install
  via Safari's "Add to Home Screen" and get the same PWA experience.

The tax: a Play Store install would be one tap; sideload is three. We
accept that trade in exchange for keeping the project simple and
free.

## Where state lives

**Three tiers, all client-side:**

1. **URL query string** — the match config (players, sets, points,
   mode). Refresh-safe, shareable, no server involvement. See
   `encodeConfig` / `decodeConfig` in `src/lib/match.ts`.
2. **`localStorage`** — in-flight match state (scores, break, queen,
   match result). Keyed by mode + player names via `matchStateKey`.
   Cleared when the organiser starts a new match with the same pair.
3. **`localStorage` (separate key)** — per-device roster of
   remembered names typed at match setup, so the picker
   autocompletes recent players. See `src/lib/known-players.ts`.

**No server, no cloud, no accounts.** Consequences:

- ✅ Anonymous by default: no login required to score. Sign-in is
  additive — for editing your own matches or being onboarded as an
  organiser. Casual scoring never touches an account.
- ✅ Minimal PII surface. Sign-in mirrors `{email, displayName, photoURL}`
  to `/users/{uid}` for the roles system; nothing else is collected
  from that flow. See `src/lib/users.ts`.
- ⚙️ Firebase Analytics runs in the background — geography, device
  type, screen views — so the maintainer can see which regions use
  the app. No account linkage (`setUserId` is never called), no
  ad tracking, no data sold. Users who want to block it entirely
  can use uBlock Origin / Firefox tracking protection — Firebase
  Analytics is on every common blocklist. See
  `src/lib/analytics.ts` and `docs/dev/analytics-setup.md`.
- ✅ Works fully offline once loaded.
- ✅ Zero recurring cost.
- ⚠️ No cross-device live sync. A phone-scored match doesn't stream
  to a remote spectator device. Planned for a future release
  (Firebase Realtime or Supabase Realtime free tier).
- ⚠️ No match history. Once a match ends and the state is cleared, it
  can't be replayed.

## Live sync within one browser

The score screen and the broadcast overlay live at different URLs
(`/score/?...` vs `/score/?...&view=overlay`) but on the same origin.
The score screen writes to `localStorage`; the overlay listens for
the `storage` event and re-renders on every change. Sub-100ms
latency in practice.

This is why the broadcast setup instructions say "run both tabs on
the same browser / same laptop." Cross-device sync would need a
different transport.

## The service worker

`public/sw.js` is a minimal hand-written SW:

- **Cache-first** for asset requests.
- **Network-first with cache fallback** for navigations (offline
  shell).
- **Precaches** the two routes (`/`, `/score/`) + favicon +
  manifest.
- **skipWaiting()** + **clients.claim()** so a new SW takes over
  immediately when it installs.

`CACHE_NAME` is bumped on every release, which purges old caches
during the `activate` handler.

Not using workbox / vite-plugin-pwa because Astro's dual-Vite build
made those flaky in early attempts. Hand-writing the SW turned out
to be simpler.

## Design tokens

- **Side colours** — `--side-a: #4fc3f7` (cyan), `--side-b: #ff8a65`
  (coral). Chosen for high contrast on a dark background and
  colourblind-safe distinguishability.
- **Accent** — `--accent: #ffd54a` (gold). Used for BOARD digits,
  BREAK chip, share badge, update banner.
- **Danger** — `--danger: #ef5350` (red). Reset / Close buttons,
  APK-required banner.

## What we deliberately don't do

- **Auto-detect match end** at 25 points or 8 boards. The organiser
  taps 🏁 End Match. Prevents the "app declared me the winner while
  we were still playing" bug.
- **Long-press or double-tap gestures.** Only tap + horizontal swipe.
  Fewer accidents.
- **Sync scores between two devices.** Not yet. Planned as a
  Firebase/Supabase Realtime channel in a future release.
- **Player accounts / login.** No user identity anywhere.
- **Ads.** Ever.

## Related

- [Local development](./local-development.md)
- [Deployment](./deployment.md)
- [Update notifications](./update-notifications.md)
