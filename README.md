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

## How to use

### 1. Set up the match

Open the app. Enter match rules (Sets / Points / Max boards), pick
Singles or Doubles, and fill in each player + their "Represents"
(country, state, club, whatever).

<p align="center">
  <img src="docs/screenshots/01-setup-blank.png" alt="Blank setup screen with match rules and empty player fields" width="360" />
  &nbsp;&nbsp;
  <img src="docs/screenshots/02-setup-filled.png" alt="Setup screen filled with Swapnil Deshpande (Denmark) vs Yuvaraj Eshwaramoorthy (India)" width="360" />
</p>

The picker autocompletes from ~2,000 real players scraped from MCA and
Sol5 LIT. Free-text names work if a player isn't in the DB.

### 2. Score the match

Tap **Start match** — the app locks landscape, goes full-screen, and
opens the scoreboard at 0-0-0.

<p align="center">
  <img src="docs/screenshots/03-score-fresh.png" alt="Fresh scoreboard at 0-0-0, board 0" width="720" />
</p>

**Every digit is a control.** Tap a digit for +1. Swipe left for +1,
swipe right for −1. That's the whole gesture set — deliberately small
so nothing is accidental.

<p align="center">
  <img src="docs/screenshots/04-score-midset.png" alt="Mid-set: Swapnil 12, Yuvaraj 8, board 4" width="720" />
</p>

Once a side crosses 22 points, the **queen-lockout ticker** appears
under the scoreboard to remind the table that the queen no longer
counts for the leader.

<p align="center">
  <img src="docs/screenshots/05-score-queen-lockout.png" alt="Queen-lockout ticker firing at 22+ points" width="720" />
</p>

Nothing auto-completes. The organiser bumps SET when a set ends,
POINTS as the board progresses, and BOARD when the next board starts.
The app only *displays*.

### 3. End the match

Tap the **🏁 End Match** button in the footer. A fireworks popup names
the champion and shows the final tally.

<p align="center">
  <img src="docs/screenshots/06-end-match-popup.png" alt="Fireworks popup: Swapnil Deshpande CHAMPION, Sets 2-1, Final board 25-18" width="720" />
</p>

Dismiss the popup and the winner's name pill switches to **gold**
(🥇 1ST); the loser's switches to **silver** (🥈 2ND). Same shape,
same typography — only the palette differs.

<p align="center">
  <img src="docs/screenshots/07-end-match-medals.png" alt="Twin-medal treatment on the name pills after End Match" width="720" />
</p>

## Features

### Setup screen

- **Match rules** entered as three plain number inputs: **Sets**, **Points**,
  and **Max boards** (`0` for unlimited — for EuroCup doubles-final format).
- **Mode:** Singles (1v1) or Doubles (2v2).
- **Player picker** with autocomplete over **~2,000 players** scraped from
  MCA (international + ranking tables) and Sol5 LIT (44 countries). Free-text
  names work too if a player isn't in the DB.
- **"Represents" field** per player (singles) or per team (doubles) — free
  text for country, state, club, sponsor, seed number, etc. Renders as a
  small chip next to the name pill on the scoreboard.
- **Update banner:** setup checks GitHub Releases on load; if a newer
  version is out, a pulsing gold banner shows the `current → new` version
  delta and links to the APK download.

### Score screen (human-driven)

- **Landscape only.** Score screen locks to landscape on the first user
  gesture (fullscreen + Screen Orientation API). Close returns to portrait.
- **MCA-style layout:** `SET | POINTS | BOARD | POINTS | SET` grid with
  real 7-segment digits (DSEG7 Classic). POINTS digit is enlarged
  (`clamp(4rem, 32vh, 12rem)`) for camera / projector legibility.
- **Every digit is a control.** Tap a digit for +1. Swipe left for +1,
  swipe right for −1. One gesture = one adjust.
- **Nothing auto-completes.** The organiser drives every number. No
  auto set-end at 25 points, no auto-end at 8 boards, no timer. The app
  only *displays* — the human decides when a set or match is over.
- **Board 9 decider.** In fixed-cap formats, the BOARD digit refuses to go
  past the cap unless the current-set POINTS are tied — then it unlocks
  one decider board (e.g. `9` in an 8-board format).
- **Points clamp at 25** and **sets clamp at Best-of-N**. Board has no
  upper cap in unlimited formats.
- **Set-pip strip** in the header shows sets won by each side (colour-coded
  pips), the current set as a pulsing accent pip, and pending sets as
  muted outlines.
- **Board progress bar** shows current board vs. max as a filled bar.
- **Live queen-lockout ticker** at 22+ pts, e.g. `SWAPNIL needs 3 points
  to win · NO QUEEN` (compact form when both sides are locked out).

### Sides + colours

- **Colours follow players, not seats.** Swap-sides moves names, notes,
  colours, SET counts, and current-set POINTS together. BOARD stays put
  (it's a match-wide counter). Mid-set swaps preserve the running score.

### End of match

- **End Match** button (🏁) in the footer. Picks the winner by SET count
  first, POINTS as tiebreaker. On a POINTS tiebreak, the winner is
  auto-credited the decider set so the footer reads a correct final
  tally (e.g. `wins 1–2`, not `wins 1–1`).
- **Fireworks popup:** gold gradient champion card with an animated 🏆,
  "CHAMPION" ribbon, big name, sets + final-board score, and a 20-particle
  CSS fireworks burst. Respects `prefers-reduced-motion`.
- **Twin-medal treatment** on the player pills: winner gets a **gold**
  gradient pill with a **🥇 1ST** badge; loser gets a **silver** gradient
  pill with a **🥈 2ND** badge. Structurally identical (typography,
  ring, glow, shine, medal-bob animation) — only palette differs, driven
  by CSS custom properties.
- **Winner UI is gated** on the explicit End Match tap. Manually adjusting
  SET+/- mid-match never flashes the winner treatment.

### Reliability

- **Persistence:** in-flight match auto-saved to `localStorage`; a mid-match
  refresh restores. "Start match" wipes the pair's cached state so
  replaying the same players always begins at 0-0-0.
- **Wake lock:** phone screen stays awake during a match (Screen Wake
  Lock API; re-requests on `visibilitychange` when the screen unlocks).
- **PWA installable** on Android/desktop Chrome and **Android APK** via
  a Trusted Web Activity wrapper.

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
[Maharashtra Carrom Association](https://maharashtracarromassociation.com)
(international + seasonal ranking tables) and, with a valid Anubis
proof-of-work cookie in `.env`, from
[Sol5 LIT](https://sol5.metapensiero.it/lit) across 44 countries.

## Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml`. Tagging a release
(`git tag v1.6.2 && git push --tags`) creates a draft GitHub Release —
build the APK locally, attach it, publish:

```sh
cd twa
./gradlew assembleRelease
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --out carromscore-v1.6.2.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

gh release upload v1.6.2 carromscore-v1.6.2.apk
gh release edit v1.6.2 --draft=false --notes-file release-notes-v1.6.2.md
```

Bubblewrap prerequisites (JDK 17 + Android SDK) live in `~/.bubblewrap/`.
The keystore stays local and is git-ignored — losing it means users
must uninstall + reinstall before any future update.

## License

[MIT](./LICENSE) © Swapnil Deshpande
