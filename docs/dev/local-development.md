# Local development

Everything you need to hack on Carromscore locally.

## Prerequisites

- **Node.js 22.12+** (check with `node --version`)
- **npm** (bundled with Node)

That's it. No Docker, no database, no cloud accounts.

## Setup

```sh
git clone git@github.com:swapnild2111/carromscore.git
cd carromscore
npm install
```

## Running the dev server

```sh
npm run dev
```

Opens on `http://localhost:4321/carromscore/`. Astro's HMR reloads
Svelte components as you edit — you rarely need to refresh manually.

**Note**: the base path is `/carromscore/`, not `/`. This matches
GitHub Pages hosting. Don't try to access the root — you'll get a 404
from Astro's dev server.

## Building the static site

```sh
npm run build
```

Emits to `./dist/`. This is what GitHub Actions deploys to Pages.

Preview locally with:

```sh
npm run preview
```

## Repo layout

```
src/
  components/
    MatchSetup.svelte       # setup screen (mode + rules + player pickers)
    ScoreBoard.svelte       # main score screen for singles/doubles/practice
    OverlayBoard.svelte     # broadcast overlay strip
  lib/
    match.ts                # MatchConfig type + URL encoding + storage keys
    version.ts              # APP_VERSION + latest-release fetcher
    known-players.ts        # per-device roster in localStorage
  layouts/BaseLayout.astro  # HTML shell + SW registration
  pages/
    index.astro             # setup screen route (/)
    score.astro             # score/overlay route (/score/)

public/
  sw.js                     # service worker (cache-first, precache shell)

docs/
  features/                 # user-facing walkthroughs
  dev/                      # this folder
  screenshots/              # PNGs referenced by README + docs

scripts/
  screenshots.ts            # Playwright capture script

twa/
  twa-manifest.json         # committed. Bubblewrap regenerates the
                            # Android project from this manifest.
  release-notes-v*.md       # git-ignored, kept locally
  android.keystore          # git-ignored, secret
```

## Regenerating README screenshots

```sh
# Terminal 1
npm run dev

# Terminal 2
npx tsx scripts/screenshots.ts
```

Writes 15 PNGs to `docs/screenshots/`. Every user-facing UI change
should be followed by a screenshot regen so the docs stay in sync
with reality.

## Where state lives

- **URL query string** — the match config (players, sets, points,
  mode). See `encodeConfig`/`decodeConfig` in `src/lib/match.ts`. A
  match link is refresh-safe and shareable.
- **`localStorage`** — in-flight match state (scores, break, queen,
  match result). See `matchStateKey` in the same file. Cleared when
  the organiser taps "Start match" for the same pair again.
- **Per-device known players** — remembered names typed at setup.
  See `src/lib/known-players.ts`.

**No cloud, no server, no accounts.** Everything is on the device.

## The service worker

`public/sw.js` implements a cache-first strategy with a network
fallback for navigation requests. On each release, bump the
`CACHE_NAME` constant so old caches are purged automatically.

The SW is registered by `BaseLayout.astro`. When a new SW takes over
mid-session (i.e., a new bundle was fetched), the layout dispatches a
`carrom:sw-updated` event that `MatchSetup.svelte` listens for and
shows a "just updated — tap to restart" toast.

## The Astro + Svelte 5 stack

- **Astro 7** for static site generation and routing.
- **Svelte 5** for the interactive score / setup components (runes:
  `$state`, `$derived`, `$effect`).
- **No CSS framework.** Hand-rolled component-scoped CSS. Design
  tokens (`--side-a`, `--side-b`, `--accent`) live in a shared layout
  or are duplicated at each usage — grep for them if you're changing
  colours.

## Related

- [Deployment](./deployment.md)
- [Update notifications](./update-notifications.md)
- [Architecture](./architecture.md)
