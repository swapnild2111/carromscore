# Screenshots capture list — v2.2

Two mirrored copies of every screenshot exist:

- `docs/screenshots/*.png` — referenced by README and every markdown doc under `docs/features/`.
- `public/help/*.png` — referenced by the in-app `/help/` page.

Both must be updated in lockstep — same filename, same content in both trees.

`scripts/screenshots.ts` automates every capture that doesn't need
authenticated Firebase state. Run against a local `astro dev` server:

```
npx astro dev --background
npx tsx scripts/screenshots.ts
cp docs/screenshots/*.png public/help/
```

## v2.2 captured (automated) ✅

Refreshed against the current codebase in the v2.2 pass:

- `01-setup-blank.png` / `02-setup-filled.png` — home with Lobby pill + 1-set default + Tournament tag
- `03-score-fresh.png` / `04-score-midset.png` / `05-score-queen-lockout.png`
- `06-end-match-popup.png` / `07-end-match-medals.png`
- `08-practice-setup.png` / `09-practice-single-set.png` / `10-practice-multi-scroll.png` / `11-practice-recap.png`
- `13-overlay-bare.png` / `14-overlay-composited.png` / `15-overlay-endgame.png`
- `16-feedback-popup.png`
- `33-match-end-lockout.png`

New v2.2 captures:

- `34-doubles-setup.png` — Doubles mode with the blue/coral Team A/B tinting
- `35-lobby-tabs.png` — Lobby with three tabs (Now Playing / History / Reports)
- `36-decider-popup.png` — "MATCH TIED?" chooser with the two-button prompt
- `37-decider-banner.png` — Deciding-board banner + un-frozen scoreboard
- `38-reports-tab.png` — Full Reports tab (picker, charts, summary, table)

## Still to capture manually 🟡

Screens that need authenticated Firebase state (super sign-in) or a
live match to be running — automation can't set these up in headless
Chromium.

## 1. Refresh the existing set (16 files)

## 1. Refresh the existing set (16 files)

These filenames already exist in both trees and are referenced by the
docs. The content has drifted in v2 — recapture on the current beta.

| Filename | What to capture |
|---|---|
| `01-setup-blank.png` | Home screen, mode chips visible, form empty. Portrait phone. |
| `02-setup-filled.png` | Same, but with two players filled in + a tournament tag. Portrait. |
| `03-score-fresh.png` | Landscape score screen, singles, 0–0–0, BREAK on left, no queen. |
| `04-score-midset.png` | Landscape mid-set, non-trivial POINTS values, BREAK chip, one queen coin red. |
| `05-score-queen-lockout.png` | Toast visible: "Mark queen first" after tapping BOARD +1 with both coins grey. |
| `06-end-match-popup.png` | End-of-match recap dialog with 4+ boards, +Q suffixes, running Score column. |
| `07-end-match-medals.png` | Landscape score screen post-End: gold 🥇 1ST and silver 🥈 2ND medal treatment. |
| `08-practice-setup.png` | Setup with Practice mode chip active, single player row, no tournament tag field. |
| `09-practice-single-set.png` | Practice scoreboard, 1 set × 4 boards, some miss counts entered. |
| `10-practice-multi-scroll.png` | Practice scoreboard with 8+ boards, page chips visible, SET/TOTAL pinned. |
| `11-practice-recap.png` | Practice end recap: 3 sets × 8 boards matrix + per-set totals + grand total. |
| `12-share-popup.png` | Share popup on score screen with both rows: spectator URL + OBS overlay URL, one with Copy ✓ state. |
| `13-overlay-bare.png` | OBS overlay strip on a transparent background — pills, DSEG7, set pips, BREAK, queen. |
| `14-overlay-composited.png` | Same overlay strip composited over a mock carrom-table video frame. |
| `15-overlay-endgame.png` | Overlay strip with gold/silver medal treatment on the pills at match end. |
| `16-feedback-popup.png` | Home screen with Feedback popup: Copy / Gmail / Mail / GitHub Discussion buttons. |

## 2. New v2.0-only screens

These are referenced in docs but no PNG exists yet. Add them to both
trees.

| Proposed filename | What to capture | Referenced in |
|---|---|---|
| `20-home-signed-in.png` | Home footer with avatar + name pill, dropdown open, "Open admin panel ⇗" + Sign out visible. | help.astro, admin.md |
| `21-lobby-history.png` | Live lobby History tab, tournaments as collapsible groups, one card with ✎ pencil visible (super signed in). | help.astro |
| `22-lobby-now-playing.png` | Live lobby Now Playing tab, two ongoing matches with LIVE dots. | help.astro |
| `23-match-edit-modal.png` | MatchEditModal open showing scalars (read-only), boardLog table, Danger zone. | admin.md, admin-verification.md |
| `24-admin-home.png` | `/admin/` with tab bar: Roles, Players, Tournaments, Live cleanup, History cleanup, Audit log. | admin.md |
| `25-admin-roles.png` | Roles tab: email input + tournament chip picker + populated Supers/Organisers lists. | admin.md, admin-verification.md |
| `26-admin-players.png` | Players tab: search box, some rows checkbox-selected, sticky bulk bar visible with "Delete selected". | admin.md |
| `27-admin-merge.png` | Merge dialog: two-row canonical picker + Type MERGE confirm. | admin.md |
| `28-admin-tournaments.png` | Tournaments tab: rows, checkboxes, Add Tournament button. | admin.md |
| `29-admin-live-cleanup.png` | Live cleanup tab: stuck records list, multi-select active. | admin.md |
| `30-admin-history-cleanup.png` | History cleanup tab: flat searchable list, bulk selection. | admin.md |
| `31-admin-audit-log.png` | Audit log tab: reverse-chrono list with one row expanded showing before/after diff. | admin.md |
| `32-practice-overlay.png` | Practice OBS overlay: SOLO badge + player pill + per-set rows with board tiles + TOTAL. | practice-mode.md, broadcast-overlay.md |
| `33-match-end-lockout.png` | Score screen post-End with lockout toast: "Match ended — score is locked. Use Reset to start over." | keeping-the-score.md, admin-verification.md |

## 3. v3.6 Tournament brackets — new screens

Referenced in `docs/features/tournament-brackets.md`. All of these
need to be captured on a signed-in organiser account with at least
one closed and one open tournament pre-seeded, some rounds, and a
few planned matches. `scripts/screenshots.ts` can automate some
(post-mount UI); others (Firebase-authed admin state) are manual.

| Proposed filename | What to capture | Automatable |
|---|---|---|
| `50-tournament-row.png` | Admin → Tournaments row: name (clickable), INVITE-ONLY chip, country chip, last-active chip, Players (N) / Rounds (N) / Bracket (N) / 🖨 / 🗑 buttons. Landscape or wide viewport so the whole action bar fits inline. | Manual |
| `51-add-tournament.png` | Add tournament dialog with Open / Invite-only radio + Country picker visible (closed selected so Country is required). | Manual |
| `52-tournament-defaults.png` | Rename & settings dialog for a tournament: Name / Access / Country / Match defaults fieldset showing Mode (Singles) / Best of (3) / Points target (25) / Max boards (8). | Manual |
| `53-rounds-modal.png` | Rounds modal with 4-6 rounds in different lifecycle states — at least one PENDING (▶ enabled, ⏹ disabled), one RUNNING (▶ disabled, ⏹ enabled), one CLOSED (↩ visible). | Manual |
| `54-bracket-empty.png` | Bracket modal, round selected, empty state ("No planned matches in this round yet"). Above the add-form: mode toggle + Board picker. | Manual |
| `55-bracket-add.png` | Bracket add-match form with autocomplete dropdown open — cursor in Side A input, 3+ player suggestions with country flag pills. | Manual |
| `56-bracket-populated.png` | Bracket table with 4+ matches in a round, mix of "ready" and "scoring · Nm ago" status pills, board numbers visible. | Manual |
| `57-assigned-players.png` | Assigned Players dialog for a closed tournament: header "<Tournament> · 🇩🇰 Denmark · N assigned", search box, "Match country only" checkbox, 3+ players with checkboxes and country pills. | Manual |
| `58-print-cover.png` | Print pack cover page: CARROMSCORE brand strip, big tournament name, country line, meta grid (Format / Type / Boards / Matches / Players), alphabetical roster with country flags in 2 columns. Landscape capture. | Semi (needs prefilled tournament) |
| `59-print-board.png` | Print pack board page: tournament name at top, big "Board 1" heading, big central QR sticker, "Scan to open the current match on this board" caption. | Semi |
| `60-scan-preview.png` | MatchSetup with bracket-scan preview banner (green tint): [BRACKET] pill + tournament + round, both sides with partner names for doubles, format line. Portrait phone. | Semi |
| `61-round-lifecycle.png` | (optional) Close-up of a Rounds modal row showing the ▶ / ⏹ / 🗑 icon buttons and RUNNING chip together. | Manual |
| `62-confirm-dialog.png` | (optional) Themed askConfirm dialog: title, body, Cancel + confirm buttons on the right. Contrast against the browser's native purple confirm. | Manual |

### Capture tips (v3.6)

- The bracket modal wants at least **2 rounds** and **3+ matches
  across boards** for the "populated" shot. Use fake names so the
  screenshot isn't tied to a real event.
- For `58-print-cover.png` and `59-print-board.png`, print-to-PDF
  in Chrome or use the browser's "Screenshot full page" tool —
  the QR needs to be readable in the final PNG.
- For `60-scan-preview.png`, load a `?planned=<mid>` URL manually
  in the browser (grab a mid from the bracket admin's local state
  in devtools) rather than actually scanning.

## Where to put the files

For each new/refreshed PNG:

```
cp /path/to/new.png docs/screenshots/<filename>
cp /path/to/new.png public/help/<filename>
```

Same content, same filename, both trees. Then `git add` both paths.

## Naming conventions

- Zero-padded 2-digit prefix (`01`–`99`) — sort order matches the
  reading order in help.astro.
- Kebab-case descriptor after the prefix.
- Existing 01–16 are reserved for the original set. New v2 screens
  start at `20-` to leave headroom for future casual-user captures in
  the 17–19 range.
