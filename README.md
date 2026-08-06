<h1 align="center">CarromScore</h1>

<p align="center">
  <a href="https://github.com/swapnild2111/carromscore/releases/latest"><img src="https://img.shields.io/github/v/release/swapnild2111/carromscore?label=release&color=ffb300" alt="Latest release" /></a>
  <a href="https://github.com/swapnild2111/carromscore/releases/latest"><img src="https://img.shields.io/badge/download-Android%20APK-brightgreen?logo=android" alt="Download APK" /></a>
  <a href="https://swapnild2111.github.io/carromscore/"><img src="https://img.shields.io/website?url=https%3A%2F%2Fswapnild2111.github.io%2Fcarromscore%2F&label=carromscore.app&up_color=ffb300" alt="Website" /></a>
  <a href="https://github.com/swapnild2111/carromscore/actions/workflows/deploy.yml"><img src="https://github.com/swapnild2111/carromscore/actions/workflows/deploy.yml/badge.svg" alt="Deploy status" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="https://astro.build"><img src="https://img.shields.io/badge/Astro-BC52EE?logo=astro&logoColor=white" alt="Astro" /></a>
  <a href="https://svelte.dev"><img src="https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white" alt="Svelte 5" /></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://swapnild2111.github.io/carromscore/"><img src="https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white" alt="PWA" /></a>
  <a href="https://github.com/GoogleChromeLabs/bubblewrap"><img src="https://img.shields.io/badge/Android-Bubblewrap%20TWA-3DDC84?logo=android&logoColor=white" alt="TWA" /></a>
</p>

**A free live scoreboard for carrom matches** — for players at the
board, for organisers running club nights, and for anyone streaming a
tournament to YouTube or Facebook.

Runs on your phone, tablet, laptop, or projector. No accounts, no ads,
no cloud, no subscription. Same code on every device.

<p align="center">
  <img src="docs/screenshots/04-score-midset.png" alt="Carromscore mid-match: cyan and coral player pills, big 7-segment digits, gold BREAK chip" width="800" />
</p>

## Try it now

- 🌐 **Any device with a browser** → open **https://swapnild2111.github.io/carromscore/**
- 📱 **Android** → [Install guide](./docs/features/install-android.md)
- 🍎 **iPhone / iPad** → [Install guide](./docs/features/install-iphone.md)

That's it. No account. No download from an app store.

## What it does

**Score any carrom match.** Singles, doubles, or a solo drill.

- 🎯 **[Keeping the score](./docs/features/keeping-the-score.md)** —
  tap a digit to add a point, swipe to fix a mistake. Big high-contrast
  numbers for camera legibility.
- 🎱 **[Break and queen indicators](./docs/features/break-and-queen.md)** —
  a small chip shows who's breaking and a red carrom coin shows who
  has the queen. Never lose track mid-match.
- 🏓 **[Practice mode](./docs/features/practice-mode.md)** — solo drill
  format. Track missed shots per board, get a full recap at the end.
  Lower total = better session.
- 📺 **[Broadcast overlay](./docs/features/broadcast-overlay.md)** —
  point OBS or Prism at a URL and get a transparent scoreboard strip
  live-composited over your camera feed.
- 🔗 **[Share URL](./docs/features/share-url.md)** — one-tap copy of
  the overlay URL for streaming, popup with instructions.

Everything else — landscape lock, wake lock, offline play, mid-match
refresh restoration — just works.

## How to use it

**Set up the match.** Pick Singles, Doubles, or Practice. Enter
players and where they represent. Tap Start match.

<p align="center">
  <img src="docs/screenshots/01-setup-blank.png" alt="Blank setup screen" width="320" />
  &nbsp;
  <img src="docs/screenshots/02-setup-filled.png" alt="Setup filled with two players" width="320" />
</p>

**Score the match.** Tap a digit for +1. Swipe left for +1, swipe
right for −1. That's the whole gesture set. Nothing auto-completes —
you decide when a set is over, when a board is over, when the match
is over.

<p align="center">
  <img src="docs/screenshots/03-score-fresh.png" alt="Fresh score screen, ready to play" width="800" />
</p>

**End the match.** Tap the 🏁 End button. Fireworks popup, then the
winner's pill turns gold and the loser's turns silver.

<p align="center">
  <img src="docs/screenshots/06-end-match-popup.png" alt="Fireworks popup: CHAMPION" width="800" />
</p>

For the full walkthrough, see
[Keeping the score](./docs/features/keeping-the-score.md).

## Streaming a match

Point OBS or Prism at the overlay URL for a live transparent scoreboard
composited over your camera feed:

<p align="center">
  <img src="docs/screenshots/13-overlay-bare.png" alt="Broadcast overlay strip" width="900" />
</p>

Full guide: [Broadcast overlay](./docs/features/broadcast-overlay.md).

## Credits

Player-name autocomplete is seeded with a small hand-curated list of
top international carrom players who have their own Wikipedia articles.
Each entry links to its Wikipedia source — see
[`public/data/players.json`](./public/data/players.json).

- **[Wikipedia contributors](https://en.wikipedia.org/wiki/Category:Indian_carrom_players)**
  — content licensed CC-BY-SA. Only player names and article URLs are
  used.

Beyond the seed, every name you type at match setup is remembered on
your own device (in the browser's local storage) so the picker
autocompletes your regular playing partners next time. Those names
never leave your device.

## Developing Carromscore

See [`docs/dev/`](./docs/dev/) for developer-facing docs:

- [Local development](./docs/dev/local-development.md)
- [Deployment + release flow](./docs/dev/deployment.md)
- [Update notifications](./docs/dev/update-notifications.md)
- [Architecture rationale](./docs/dev/architecture.md)

## License

[MIT](./LICENSE) © Swapnil Deshpande
