# Break and queen indicators

Two small chips next to each player's pill on the score screen tell you
who's breaking and who has the queen. Both exist to answer "I forget
who's breaking mid-match" and "did I remember to credit the queen to
whoever pocketed it?"

<p align="center">
  <img src="../screenshots/04-score-midset.png" alt="Break chip next to Swapnil, grey coins on both sides" width="720" />
</p>

## The BREAK chip

A gold pill labelled **BREAK** sits inline with one player's name pill —
the player who breaks the current match. Same gold colour regardless of
which side, because the chip is telling you *a state* ("this player is
breaking"), not identifying a team.

**How to change who's breaking:**
- The chip defaults to **Player A** at the start of a match. That covers
  the common case where whoever set up the match is playing as A.
- If B won the toss, just tap the BREAK chip. It hops to the other side.

**When it changes automatically:** never. Once assigned, BREAK stays with
that player for the whole match — through every board and every set.
This matches how a real carrom match works: the toss winner keeps the
break-first advantage across boards; alternation between boards is a
convention some groups follow but not something the scoreboard should
enforce.

**Reset scores** puts BREAK back on Player A.

**Swap sides** flips BREAK with the players (still lives next to the
same person after the swap).

## The queen coin

Each player has a small **carrom queen coin** icon in front of their
pill. Two states:

- **Grey coin (default)** — the queen is on the table, uncovered.
- **Red coin** — this player has pocketed and covered the queen.

**How to mark who has the queen:** tap the coin next to whichever player
pocketed the queen. It turns red. To move ownership to the other side,
tap the other player's grey coin. To return the queen to the table
(uncovered again — happens if the pocketing player misses the cover),
tap the red coin.

Real carrom always has *one* queen. That's why only one coin is ever red
at a time; the other side's coin stays grey.

## The queen guard on BOARD +1

To prevent a common umpire mistake — advancing the board while forgetting
to credit the queen — **BOARD +1 is blocked until the queen state is
resolved for the current board**. Two ways to resolve it:

1. **Tap a coin** to mark whichever player pocketed the queen (red), or
2. **Confirm "no queen this board"** via the small dialog that appears
   when you tap BOARD +1 with both coins grey.

Once the umpire commits to one of those, BOARD +1 goes through. In the
end-of-match recap, whichever side pocketed the queen picks up a small
**+Q** suffix next to their Coins column for that board — so a board
where side A scored 4 coins plus the queen reads as `4 +Q` (Score = 7).

Boards without a queen simply have no +Q in the recap. The information
is captured but never inferred.

## When the queen resets

The queen auto-clears back to grey on both sides in three situations:

1. **You bump the BOARD number** (up or down). A new board begins with
   the queen at the centre — nobody has it yet.
2. **You bump a SET number**. New set = new board = queen at centre.
3. **You tap Swap sides**. After a swap, players re-position and it's
   worth marking the queen again from scratch.

These auto-resets exist because the queen is per-board state, not
per-match — carrying it across a board transition would almost always be
wrong.

## What if I make a mistake?

Both indicators are always tappable. If you accidentally marked the
queen on the wrong player, tap the correct player's coin. If you had
BREAK on the wrong side after starting the match, tap the chip to move
it. There is no confirmation dialog — the correction is instant.

## Why we don't track more queen state

Some digital scoreboards model the full queen state machine (uncovered
/ pocketed-awaiting-cover / covered / returned-to-centre). Carromscore
doesn't, on purpose:

- The organiser sees the physical board and knows the state.
- Modelling it in the app doubles the number of buttons on-screen.
- Every extra button is another chance for an accidental tap during a
  fast rally.

The coin's grey ↔ red toggle is the smallest thing that helps memory
without adding complexity. It's an *aide-memoire*, not a rules engine.

## Overlay

If you're streaming with the [broadcast overlay](./broadcast-overlay.md),
both indicators show up there too:

<p align="center">
  <img src="../screenshots/13-overlay-bare.png" alt="Broadcast overlay with BREAK chip on A and red queen coin on B" width="720" />
</p>

Same visual language as the phone. Broadcast viewers see who's
breaking and who has the queen at a glance.

## Related

- [Keeping the score](./keeping-the-score.md) — the main score-screen guide.
- [Broadcast overlay](./broadcast-overlay.md).
