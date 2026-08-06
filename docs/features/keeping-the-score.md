# Keeping the score

The score screen is the heart of Carromscore. It stays on your phone during
the whole match, big and bright enough to be readable from across the room.
Here's everything you can do on it.

<p align="center">
  <img src="../screenshots/03-score-fresh.png" alt="Fresh score screen at 0-0-0" width="720" />
</p>

## The layout

Left to right: **SET · POINTS · BOARD · POINTS · SET**.

- **POINTS** — big 7-segment digits, one column per player. This is the
  live score of the current board.
- **BOARD** — the middle column shows which board of the current set you're
  on. Fills the little progress bar as boards go by.
- **SET** — the outer columns count how many sets each player has won.
- **Player pills** — the two coloured name pills at the top: cyan for
  side A, coral for side B.

## Updating the score

Every digit is a control. There's just one gesture set to remember:

- **Tap a digit** → +1
- **Swipe left on a digit** → +1
- **Swipe right on a digit** → −1 (undo a mistake)

One gesture = one adjust. Deliberately small so an accidental touch never
resets a whole board.

Nothing auto-completes. Points don't jump to the next set when you hit 25 —
you decide when the set ends by tapping the **SET** column. The board
number goes up when *you* tap it. The app displays; the human decides.

<p align="center">
  <img src="../screenshots/04-score-midset.png" alt="Mid-match: 12-8, board 4" width="720" />
</p>

## Break and queen indicators

Two small chips next to each player pill tell you who's breaking and who
has the queen. See [Break and queen](./break-and-queen.md) for details.

## The queen-lockout ticker

Once a side crosses 22 points, a small banner appears under the
scoreboard reminding the table that the queen no longer scores for the
leader (they need 3 more points from open pieces to win).

<p align="center">
  <img src="../screenshots/05-score-queen-lockout.png" alt="Queen-lockout ticker firing at 22+ points" width="720" />
</p>

## The footer buttons

Five buttons across the bottom, always visible in landscape:

| Button | What it does |
|---|---|
| **⧉ Share URL** | Opens a popup with the overlay URL for OBS/Prism. See [Share URL](./share-url.md). |
| **⇄ Swap** | Physical swap-sides between sets. Names, notes, colours, sets, and current points travel with the players. Board stays put. Queen resets to grey. |
| **↻ Reset** | Zero everything: sets, points, board, queen. Break stays where it was. Asks for confirmation. |
| **🏁 End** | Ends the match. Fireworks popup names the champion, then medals stick on the winner/loser pills. |
| **✕ Close** | Quit the match and return to the setup screen. Asks for confirmation if there's unsaved progress. |

## End of match

Tap **🏁 End** — a fireworks popup names the champion:

<p align="center">
  <img src="../screenshots/06-end-match-popup.png" alt="Fireworks popup: Swapnil Deshpande CHAMPION" width="720" />
</p>

Dismiss the popup and the two player pills switch to a **gold** and
**silver** medal treatment for the rest of the session — one for the
winner (🥇 1ST), one for the loser (🥈 2ND).

<p align="center">
  <img src="../screenshots/07-end-match-medals.png" alt="Twin-medal treatment on the pills after End Match" width="720" />
</p>

The medal design is deliberately the same for both — same shape, same
typography, same subtle shine animation — only the palette differs.
Winning shouldn't feel visually different from losing; only the label
should.

## What happens if I refresh?

Nothing bad. The whole match state is saved on your phone as you play,
so an accidental refresh, a phone call, or the app being backgrounded
all restore exactly where you were. The screen stays awake through the
match too, so you don't have to keep tapping it.

## Related

- [Break and queen indicators](./break-and-queen.md)
- [Practice mode](./practice-mode.md) — solo drill with no opponent.
- [Broadcast overlay](./broadcast-overlay.md) — for streaming with OBS/Prism.
- [Share URL](./share-url.md) — how to hand off the overlay to a streamer.
- [Contact](../contact.md) — email, GitHub Discussions, feedback.
