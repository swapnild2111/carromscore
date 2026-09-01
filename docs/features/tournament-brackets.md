# Tournament brackets (v3.6)

**One QR sticker per physical board. Permanent for the entire
tournament. Umpires scan the same code every round and the app
auto-loads whichever match is currently assigned to that board.**

This is Carromscore's tournament-day feature. If you're running a
club night, a ranking event, or a knockout with a printed draw,
this replaces the "shout the next fixture across the hall" model
with a printed sticker on every board.

<p align="center">
  <img src="../screenshots/50-tournament-row.png" alt="Tournament row in the admin table with Players / Rounds / Bracket / Print / Delete buttons" width="720" />
</p>

## The mental model

1. You create the tournament (once) with its **defaults** — mode,
   best-of, points target, max boards. Every planned match
   inherits these.
2. You add **rounds** (Round of 16 → Quarter-finals → Semi-final →
   Final). Umpires later pick one of these when they open a match.
3. You add **matches** to the bracket, one per round, each
   assigned to a physical **board number**. The organiser knows
   the draw; the app just needs to know which two players are on
   which board in which round.
4. You **print the pack** — a cover sheet (tournament name,
   config, player roster with flags) plus one page per board.
   Cut along the borders and stick each Board N page to the
   physical carrom board.
5. Match day: an umpire opens the app, scans **their board's
   sticker**, sees the current match's players + config prefilled,
   taps **Start**. When they end the match, the app auto-loads
   the next round's Board N match on the next scan.

Zero admin work between rounds. No changing stickers. No
regenerating QRs.

## Setting up a tournament

Sign in as an organiser (see [Running a tournament](../../README.md#running-a-tournament)
for how to get organiser access), open the admin panel, and
switch to the **Tournaments** tab.

Tap **+ Add tournament**. Two things to decide up front:

- **Access**: **Open** (anyone can play, no roster required) or
  **Invite-only** (players must be on an explicit roster, all
  from a specific country).
- **Country**: required for invite-only; optional for open. Used
  for the flag pill on the tournament header and roster gate
  checks.

<p align="center">
  <img src="../screenshots/51-add-tournament.png" alt="Add tournament dialog with Open / Invite-only radio group and country picker" width="480" />
</p>

Click the tournament's name in the list to open the **rename &
settings** dialog. This is where you set the **match defaults**:

- **Mode** — Singles or Doubles.
- **Best of** — number of sets per match (e.g. bo3).
- **Points target** — per-set point clamp (default 25).
- **Max boards** — per-set board cap (default 8; use `0` for
  unlimited).

<p align="center">
  <img src="../screenshots/52-tournament-defaults.png" alt="Tournament settings dialog with Match defaults fieldset" width="480" />
</p>

Every planned match created under this tournament inherits these
defaults. Umpires can still override per match if a specific
fixture runs longer or shorter.

## Rounds

From the tournament row, tap **Rounds**. Add each stage of your
tournament: "Round of 16", "Quarter Final", "Semi Final", "Final",
etc. Order = the order you add them.

<p align="center">
  <img src="../screenshots/53-rounds-modal.png" alt="Rounds modal with several rounds in various lifecycle states" width="520" />
</p>

Each round has a **lifecycle**:

- **▶ Pending** — freshly added. Not yet offered to umpires.
- **▶ Start** it → **Running** — umpires can now pick this round
  when they open a match.
- **⏹ Close** — round is done. Umpires can't add new matches to
  it. History under this round remains intact.
- **↩ Reopen** — restore a closed round to running. Confirm-gated
  in case you closed by mistake.

Click a round's name to rename it inline. `🗑` deletes the round
(matches already tagged with it fall back to an "Unassigned"
group in History — they aren't deleted).

## Bracket admin

From the tournament row, tap **Bracket**. This is where you
pre-create every match for the tournament.

<p align="center">
  <img src="../screenshots/54-bracket-empty.png" alt="Empty bracket modal for a fresh round" width="720" />
</p>

Pick a round from the chips at the top. The add-match form shows:

- **Mode toggle** — Singles / Doubles. Seeded from the
  tournament's default; flip per match if you have a mixed event.
- **Board** — the physical board number (1..99) this match will
  be played on.
- **Side A** / **Side A partner** (doubles only) — player name(s)
  with autocomplete against the identity store. Country flag
  shows next to each suggestion.
- **Side B** / **Side B partner** — same, other side.

<p align="center">
  <img src="../screenshots/55-bracket-add.png" alt="Bracket add-match form with autocomplete dropdown showing three player suggestions" width="720" />
</p>

Tap **+ Add match** and it drops into the round's table:

<p align="center">
  <img src="../screenshots/56-bracket-populated.png" alt="Bracket table with several matches, each showing board number and status pill" width="720" />
</p>

Each row shows the match order, board number, both sides, current
status (**ready** or **scoring · Nm ago** if an umpire has claimed
it), and a `🗑` to delete. Matches auto-advance across rounds —
you don't need to edit anything after a round finishes.

### Invite-only roster gate

If the tournament is **Invite-only**, bracket admin only lets you
add players who are on the assigned roster. The autocomplete
filters to that roster; if you type a name off-roster and try to
add, the form blocks with an explicit error listing the offenders.

Use the tournament row's **Players** button to build the roster
first (see [Assigning players](#assigning-players) below).

## Assigning players

For **Invite-only** tournaments, the **Players** button on the
tournament row opens the assignment dialog:

<p align="center">
  <img src="../screenshots/57-assigned-players.png" alt="Assigned players dialog with checkboxes and country filter" width="520" />
</p>

Tick the players who are in this tournament. The dialog defaults
to filtering by the tournament's country (a Danish ranking event
only shows Danish players); untick **Match country only** to see
the full roster.

You can search by name. The count on the row's **Players (N)**
badge reflects the actual roster size — refreshes live as you
assign / unassign, and updates across tabs and devices.

## Print pack

From the tournament row, tap the **🖨 printer icon**. A new tab
opens with the printable pack:

**Page 1 — Cover**: brand strip, big tournament name banner,
country flag (invite-only), meta grid (Format / Type / Boards /
Matches / Players), and the alphabetical player roster with
country flag pills. Hand this out at check-in.

<p align="center">
  <img src="../screenshots/58-print-cover.png" alt="Print pack cover page: brand, tournament name, meta grid, player roster with flags" width="600" />
</p>

**Pages 2..N — Boards**: one page per physical board. Big
"Board N" heading, tournament name, and a big central QR that
encodes `?tournament=<key>&board=N`.

<p align="center">
  <img src="../screenshots/59-print-board.png" alt="Print pack board page: tournament name, Board 1 heading, big QR sticker" width="600" />
</p>

Cut along the border and stick each Board N page to the physical
carrom board it names. Stickers are permanent for the whole
tournament — you don't reprint them between rounds.

## Match day — scanning

An umpire opens their phone's camera at a board's QR sticker.
Chrome / Safari opens the app URL. MatchSetup loads with:

- **Bracket** badge + tournament + round
- Both players (with partners for doubles)
- Mode + config (Singles · bo3 · target 25 · max 8 boards)

<p align="center">
  <img src="../screenshots/60-scan-preview.png" alt="Bracket scan preview banner in MatchSetup with players, tournament, round, format" width="420" />
</p>

The umpire eyeballs the preview (right players? right round?),
taps **Start**, and drops into the normal score screen. The match
plays out identically to any other Carromscore match — see
[Keeping the score](./keeping-the-score.md).

When the umpire taps **🏁 End Match**, the archive is written to
`/matches` (visible in History, Live tab, and Reports) and the
planned slot is deleted. Next scan of the same board's sticker
serves the next round's Board N match automatically.

### Someone already scoring this board

If another umpire scanned first and claimed the match, a
**takeover** banner shows instead of the preview. Confirm only if
you're actually taking over from the previous scorer — otherwise
they'll lose their scoring state.

### Board finished all its rounds

If every planned match assigned to Board 3 has been scored and
deleted, the next scan shows a **Match not available** banner.
That's normal — the tournament has run out of Board 3 matches.

## Sync across tabs and devices

Everything on this page is **live-synced** across every device
signed into the same organiser account, and every tab open on the
same device:

- Add a round on your laptop → phone's admin panel updates within
  a second.
- Assign a player from your phone → laptop's Players badge
  refreshes.
- An umpire ends a match → the tournament row's Bracket count
  ticks down.

No manual refresh needed. If a badge count ever looks stale,
reopen the modal or hard-refresh — but the common path is live.

## Related

- [Keeping the score](./keeping-the-score.md) — how the actual
  scoring works once an umpire is in a match.
- [Break and queen indicators](./break-and-queen.md) — the
  scoreboard's per-set signalling.
- [Broadcast overlay](./broadcast-overlay.md) — for streaming the
  final or a marquee match.
- [Install on Android](./install-android.md) or
  [Install on iPhone](./install-iphone.md).
