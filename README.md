# CarromScore

Live carrom scoring for players and broadcasters — a landscape-first
scoreboard that runs as a website and as an installable Android app.

[![Latest release](https://img.shields.io/github/v/release/swapnild2111/carromscore?label=release&color=ffb300)](https://github.com/swapnild2111/carromscore/releases/latest)
[![Download APK](https://img.shields.io/badge/download-Android%20APK-brightgreen?logo=android)](https://github.com/swapnild2111/carromscore/releases/latest)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fswapnild2111.github.io%2Fcarromscore%2F&label=carromscore.app&up_color=ffb300)](https://swapnild2111.github.io/carromscore/)
[![Deploy status](https://github.com/swapnild2111/carromscore/actions/workflows/deploy.yml/badge.svg)](https://github.com/swapnild2111/carromscore/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[![Astro](https://img.shields.io/badge/Astro-BC52EE?logo=astro&logoColor=white)](https://astro.build)
[![Svelte 5](https://img.shields.io/badge/Svelte-5-FF3E00?logo=svelte&logoColor=white)](https://svelte.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![PWA](https://img.shields.io/badge/PWA-installable-5A0FC8?logo=pwa&logoColor=white)](https://swapnild2111.github.io/carromscore/)
[![TWA](https://img.shields.io/badge/Android-Bubblewrap%20TWA-3DDC84?logo=android&logoColor=white)](https://github.com/GoogleChromeLabs/bubblewrap)

Aimed at replacing the buggy MCA Android scoreboard with a single web app
that also ships as an installable APK — no Play Store required.

## Features

- **Match setup:** pick format (Best of 3 / Single set / Custom), mode
  (Singles / Doubles), player-name autocomplete over a scraped player DB.
- **Scoring layout:** MCA-style `SET | POINTS | BOARD | POINTS | SET` grid
  with real 7-segment digits (DSEG7 Classic).
- **Gestures:** tap a digit for +1, swipe left for +1, swipe right for −1.
  One gesture = one adjust.
- **Landscape lock:** score screen locks to landscape on the first user
  gesture (fullscreen + Screen Orientation API); Close returns to portrait.
- **Set-end auto-detect:** 25-point target, 8-board cap, or per-set time
  limit. Silent — no popup covers the score. Winner's SET count ticks up,
  everything else resets, next set begins.
- **Draw handling:** final set tied → both player pills go silver with a
  ½ badge; footer reads "Match drawn · ½ point each".
- **Match winner:** gold "WINNER" ribbon on the winning name pill, gold
  gradient background, glossy shine sweep, wobbling 🏆.
- **Live queen-lockout ticker:** at 22+ pts, header reads
  "SWAPNIL needs 3 points to win · NO QUEEN" (compact form for both sides).
- **Colours follow players:** Swap sides moves names, SET counts, and
  colour tokens together — the same person keeps their pill colour.
- **State persistence:** in-flight match auto-saved to localStorage;
  a refresh mid-match restores. "Start match" wipes the pair's cached
  state, so replaying the same players always begins at 0-0-0.
- **Wake lock:** phone screen stays awake during a match.
- **PWA installable** on Android/desktop Chrome and **Android APK** via
  a Trusted Web Activity wrapper.
- **In-app update banner:** setup screen checks GitHub Releases and shows
  "Update available" pointing at the download.

## Install on Android

The APK is signed and hosted on this repo's Releases page — no Play
Store account, no store review.

1. On your Android phone, open
   [releases/latest](https://github.com/swapnild2111/carromscore/releases/latest).
2. Download the latest `carromscore-*.apk`.
3. Tap the downloaded file. Android will ask for "Install unknown apps"
   permission for your browser once; accept.
4. Confirm the install. **Carromscore** appears on your home screen.

The APK is a thin wrapper around the live website — every website
update is instantly in the app. You only need a new APK when the wrapper
itself changes (icon, name, target Android SDK, orientation, etc.).

## Local development

```sh
npm install
npm run dev        # http://localhost:4321/carromscore/
npm run build      # emit static site to ./dist/
```

Refresh the player-name DB (writes to `public/data/players.json`):

```sh
npm run refresh-players
```

The scraper pulls from
[Maharashtra Carrom Association](https://maharashtracarromassociation.com/international_player.php)
and (with a valid Anubis proof-of-work cookie in `.env`) from
[Sol5 LIT](https://sol5.metapensiero.it/lit).

## Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml`. Tagging a release
(`git tag v1.5.6 && git push --tags`) creates a draft GitHub Release —
build the APK locally, attach it, publish:

```sh
cd twa
./gradlew assembleRelease
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --out carromscore-v1.5.6.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

gh release upload v1.5.6 carromscore-v1.5.6.apk
gh release edit v1.5.6 --draft=false
```

Bubblewrap prerequisites (JDK 17 + Android SDK) live in `~/.bubblewrap/`.
The keystore stays local and is git-ignored — losing it means users
must uninstall + reinstall before any future update.

## License

[MIT](./LICENSE) © Swapnil Deshpande
