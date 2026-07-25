# Carromscore

Live carrom scoring for players and broadcasters.
Website: <https://swapnild2111.github.io/carromscore/>

Aimed at replacing the buggy MCA Android scoreboard with a web-first app
that also works as an installable Android APK.

## Features

- Match setup: pick format (Best of 3 / Single set / Custom), mode
  (Singles / Doubles), player-name autocomplete over a scraped player DB.
- Scoring: MCA-style **SET | POINTS | BOARD | POINTS | SET** grid. Tap a
  number to add 1; tap the `−` below it to subtract. Landscape-locked on
  mobile.
- Set-end triggers: 25-point target, 8-board cap, or per-set time limit
  — auto-detected, winner picked by points (ties surface a manual dialog).
- Swap sides: single button, swaps SET counts and player names, resets
  POINTS + BOARD.
- 22-point queen-lockout warning strip.
- Broadcast overlay: same URL with `?view=overlay` renders a transparent
  bottom-third strip for OBS browser sources; syncs across tabs on the
  same device.
- Match history: pre-fills a GitHub Issue on match end; a workflow
  commits it to `data/matches/YYYY/*.json`.
- PWA install + optional Android APK (see below).

## Install on Android

You do **not** need the Play Store. The APK is signed and hosted on this
repo's Releases page.

1. On your Android phone, open <https://github.com/swapnild2111/carromscore/releases>
2. Download the latest `carromscore-*.apk`.
3. Tap the downloaded file. Android will ask you to allow "Install unknown
   apps" from your browser — accept once, only for this source.
4. Confirm the install. Carromscore appears on your home screen.

The APK is a lightweight wrapper around the same website. Every website
update is automatically reflected in the app. You only need to update the
APK if we change the wrapper itself (icon, name, target Android SDK).

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
[maharashtracarromassociation.com](https://maharashtracarromassociation.com/international_player.php)
and (with a valid Anubis PoW cookie in `.env`) from
[sol5.metapensiero.it/lit](https://sol5.metapensiero.it/lit).

## Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml`.

Tagging a release (`git tag v1.5.1 && git push --tags`) creates a draft
GitHub Release. Build the APK locally and attach it:

```sh
cd twa
./gradlew assembleRelease
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --out app-release-signed.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

gh release upload v1.5.1 app-release-signed.apk
gh release edit v1.5.1 --draft=false
```

Bubblewrap prerequisites (JDK 17 + Android SDK) live in `~/.bubblewrap/`.

## License

TBD.
