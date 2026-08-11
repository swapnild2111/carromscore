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
board, for organisers running club nights and tournaments, and for
anyone streaming to YouTube or Facebook.

Runs on your phone, tablet, laptop, or projector. Casual scoring stays
anonymous — no accounts required. Sign in only if you want to run a
tournament as an organiser. Same code on every device.

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
  **tap** (or swipe left) on a digit to add a point; **swipe right**
  on a digit to reduce — that's how you undo a mistake or roll back a
  wrong-side credit. Same gesture works on POINTS, SET, and BOARD.
  Big high-contrast numbers for camera legibility. BOARD starts at 0
  and advances only when you tap; queen marker guards BOARD +1 so no
  board goes past half-scored.
- 🎱 **[Break and queen indicators](./docs/features/break-and-queen.md)** —
  a small chip shows who's breaking; a coloured queen coin shows who
  pocketed it. Never lose track mid-match.
- 🏓 **[Practice mode](./docs/features/practice-mode.md)** — solo drill
  format. Track missed shots per board, get a full recap at the end.
  Lower total = better session. Broadcasts to Live like versus matches.
- 🏷️ **Tournament tag** — tag a match with an event name and every
  match sharing that tag groups together in the lobby. Auto-suggests
  from your prior tags. Tagged versus matches keep for a year;
  untagged matches and practice runs keep for 3 months.
- 📡 **Live broadcast + spectator URL** — toggle "Live" on setup and
  every state change publishes to a shareable URL. Friends and family
  open the URL on any phone; the score updates within a second of
  every tap.
- 📺 **[Broadcast overlay](./docs/features/broadcast-overlay.md)** —
  point OBS or Prism at a URL and get a transparent scoreboard strip
  live-composited over your camera feed.
- 📜 **Lobby** — one place to browse ongoing broadcasts, every match
  you've ever finished, and per-tournament reports. Three tabs:
  Now Playing / History / Reports. Grouped by tournament tag,
  collapsible; Practice runs get their own section in History.
- 📊 **Reports** — pick a tournament from the chip picker and see
  per-player wins/losses/draws, cumulative boards + points, plus two
  bar charts and a copy-pasteable match table. ⧉ Copy or ↓ Download
  CSV for use in any spreadsheet.
- 🤝 **Draw match + deciding board** — if the last board of a match
  ends with sets AND points level, End opens a chooser: play one
  deciding board to break the tie, or commit as a draw. Different
  regions decide ties differently; the umpire picks.
- 🛠️ **Admin panel for organisers** — signed-in super-admins get a
  full `/admin/` surface (Players, Tournaments, Live matches with
  All/Stuck filter, History cleanup, Audit log). Tournament organisers
  get inline ✎ edit affordances on their event's matches. Signed-in
  casual users can self-delete their own recorded matches.
- 🔗 **[Share URL](./docs/features/share-url.md)** — one-tap copy of
  spectator + OBS overlay URLs from the lobby's match sheet.

Everything else — landscape lock, wake lock, offline play, mid-match
refresh restoration — just works.

## How to use it

**Set up the match.** Pick Singles, Doubles, or Practice. Enter
players and where they represent. Optionally tag the match with a
tournament name. Tap Start match.

<p align="center">
  <img src="docs/screenshots/01-setup-blank.png" alt="Blank setup screen" width="320" />
  &nbsp;
  <img src="docs/screenshots/02-setup-filled.png" alt="Setup filled with two players" width="320" />
</p>

**Score the match.** Two gestures, that's the whole set:

- **Tap a digit** (or swipe left on it) → **+1**
- **Swipe right on a digit** → **−1** (undo / reduce)

Works on every digit — SET, POINTS, BOARD. Mark the queen holder by
tapping the coin above their pill — BOARD +1 requires the queen to
be marked (or "no queen" confirmed) before it'll advance.

<p align="center">
  <img src="docs/screenshots/03-score-fresh.png" alt="Fresh score screen at 0-0-0" width="800" />
</p>

**End the match.** Tap the 🏁 End button. Recap dialog shows the
paper-scorecard matrix with per-board queen decoration. Winner medals
lock onto the pills. Scoring inputs freeze — a toast reminds you to
use Reset if you actually want to start over.

<p align="center">
  <img src="docs/screenshots/06-end-match-popup.png" alt="End-match recap: paper-scorecard matrix" width="800" />
</p>

For the full walkthrough, open the in-app **How to use** page (footer
link on the home screen) or read
[Keeping the score](./docs/features/keeping-the-score.md).

## Streaming a match

Toggle "Live" on setup, then paste the overlay URL from the score
screen's Share popup into OBS or Prism as a Browser Source. Both
URLs — spectator (full read-only scoreboard) and OBS (transparent
strip) — update within ~1 s of every tap on the umpire's device.

<p align="center">
  <img src="docs/screenshots/13-overlay-bare.png" alt="Broadcast overlay strip" width="900" />
</p>

Full guide: [Broadcast overlay](./docs/features/broadcast-overlay.md).

## Running a tournament

Sign in with Google via the **Admin** link in the home footer. If
you're already an authorised organiser, matches tagged to your
tournament(s) show a ✎ pencil in the lobby History tab — tap to fix
scores, correct board-log entries, or delete a bad match. To become
an organiser, share your Firebase UID with a super-admin (visible in
the "not authorised" dialog on first sign-in) and they'll assign you
to your tournament.

The super-admin (Carromscore's maintainer) has a full `/admin/`
surface with Roles, Players, Tournaments, Live cleanup, History
cleanup, and an audit log covering every administrative write. See
[docs/admin.md](./docs/admin.md) for the maintainer guide and
[docs/admin-verification.md](./docs/admin-verification.md) for the
E2E verification checklist.

## Credits

Player-name autocomplete is seeded with a small hand-curated list of
top international carrom players who have their own Wikipedia articles.
Each entry links to its Wikipedia source — see
[`public/data/players.json`](./public/data/players.json).

- **[Wikipedia contributors](https://en.wikipedia.org/wiki/Category:Indian_carrom_players)**
  — content licensed CC-BY-SA. Only player names and article URLs are
  used.

Beyond the seed, every name you type at match setup is written to a
shared Firebase-backed player roster so a second match with the same
person picks the right identity. The typed name creates a Player
record on match end (never on typing, so setup-time typos don't
pollute the roster).

## Developing Carromscore

See [`docs/dev/`](./docs/dev/) for developer-facing docs:

- [Local development](./docs/dev/local-development.md)
- [Deployment + release flow](./docs/dev/deployment.md)
- [Update notifications](./docs/dev/update-notifications.md)
- [Architecture rationale](./docs/dev/architecture.md)

## Contact

Bug reports, feature ideas, or just "hey, I use this at my club" — all
welcome.

- 📧 Email: **swapnild2111 [at] gmail [dot] com**
- 💬 [Start a GitHub Discussion](https://github.com/swapnild2111/carromscore/discussions/new?category=general)
- 🐞 GitHub Issues: <https://github.com/swapnild2111/carromscore/issues>

Inside the app, the home screen footer has a **Feedback ⇗** link. It
opens a popup with Copy / Open in Gmail / Use my mail app / Start a
GitHub Discussion — see [Contact](./docs/contact.md) for details.

<p align="center">
  <img src="docs/screenshots/16-feedback-popup.png" alt="Send feedback popup on the home screen" width="360" />
</p>

## License

[MIT](./LICENSE) © Swapnil Deshpande
