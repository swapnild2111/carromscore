# Practice mode (solo drill)

Practice mode is for playing carrom alone at home. Instead of tracking
points against an opponent, you record how many **shots you missed** on
each board. Lower total = better session. There's no winner.

Great for personal training, or for a group where everyone plays the
same drill and the lowest total wins.

## Setting up

Open the app and tap the **Practice** mode chip (next to Singles and
Doubles). The form collapses to just the fields you need: number of
sets, boards per set, one player name, and one "Represents" field.

<p align="center">
  <img src="../screenshots/08-practice-setup.png" alt="Practice mode setup with a single player row" width="360" />
</p>

Defaults are **1 set × 4 boards**. Change them to match your usual
drill. Note: the Tournament tag field is hidden in Practice — it's a
versus-match concept.

## Scoring a session

Tap **Start match** and the scoreboard opens. Instead of the usual
five-column SET / POINTS / BOARD layout, you get a row of digit cells
labelled **B1, B2, B3, …** with **SET** on the left and **TOTAL** on
the right.

<p align="center">
  <img src="../screenshots/09-practice-single-set.png" alt="Practice single-set scoreboard, four boards" width="720" />
</p>

**Each cell tracks misses on one board.** Tap it once for each shot
you missed. Same gesture set as normal scoring — tap for +1, swipe
left for +1, swipe right for −1. TOTAL is calculated for you.

## Sessions with lots of boards

For more than 4 boards, the row scrolls horizontally in pages of 4.
Small chips underneath (**B1–4** / **B5–8** etc.) let you jump between
pages. SET / TOTAL columns stay pinned on either side so the totals
are always in view.

<p align="center">
  <img src="../screenshots/10-practice-multi-scroll.png" alt="Practice multi-set with scrollable boards" width="720" />
</p>

## Sessions with lots of sets

Multi-set drills page one set at a time. Prev / next arrows advance
through them, and a small pip strip in the header tells you which set
you're on. The running **Total missed** at the top of the screen
accumulates across all sets so you always see the grand total.

## Live broadcast

Toggle **Live** on the setup screen and the practice session publishes
to a shareable URL just like a versus match. The overlay renders a
compact per-set row: one wide pill with SOLO badge + player name +
country, then one row per set showing every board tile with the miss
count in DSEG7 digits, plus a TOTAL tile on the right.

This is useful for club sessions where everyone runs the same drill
and a projector shows the live scoreboard — no need to co-locate
laptop and phone, the overlay updates within ~1 s of every miss you
enter on the umpire's device.

See [Broadcast overlay](./broadcast-overlay.md) for the OBS/Prism
setup.

## Ending a session

Tap **🏁 End Match** — the recap popup shows the whole board-by-board
matrix with per-set totals and the grand total missed:

<p align="center">
  <img src="../screenshots/11-practice-recap.png" alt="Practice recap popup with three sets of eight boards" width="720" />
</p>

No fireworks, no medals — Practice never declares a winner. Take a
screenshot if you want to share with a group.

## Archive + retention

Practice runs are archived to the /matches record in Firebase alongside
versus matches, and appear in the /live/ lobby's History tab under the
"Default" bucket (practice sessions can't be tagged with a tournament
tag). Retention is **3 months** — practice runs are the highest-volume
record type, so the shorter TTL keeps the lobby uncluttered.

If a session got recorded with a typo or a mistake, a super-admin can
edit or delete the record via the /admin/ panel's History cleanup tab.

## Related

- [Keeping the score](./keeping-the-score.md) — normal Singles/Doubles scoring.
- [Broadcast overlay](./broadcast-overlay.md) — including the practice overlay layout.
- [Install on Android](./install-android.md) or [Install on iPhone](./install-iphone.md).
