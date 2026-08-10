# Screenshots capture list — v2.0

Two mirrored copies of every screenshot exist:

- `docs/screenshots/*.png` — referenced by README and every markdown doc under `docs/features/`.
- `public/help/*.png` — referenced by the in-app `/help/` page.

Both must be updated in lockstep — same filename, same content in both trees.

For a fresh v2.0 pass, capture on the beta channel (`/carromscore/beta/`)
after signing in as super so the pencil affordance is visible. Landscape
device or 1920×1080 browser at DPR 2 for the score-screen shots.

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
