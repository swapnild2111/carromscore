# Share URL

The **⧉ Share URL** button in the score-screen footer opens a small
popup with URLs you can hand off to a streamer or (in future) a
spectator.

<p align="center">
  <img src="../screenshots/12-share-popup.png" alt="Share match URL popup with Overlay URL and Live spectator URL" width="720" />
</p>

Two URLs are on offer.

## Overlay URL — ready to use today

Paste this into **OBS**, **Prism Live Studio**, or any streaming
software's Browser Source. It renders the transparent bottom-third
scoreboard strip that's designed to composite over a camera feed of
your carrom board.

Tap the **Copy** button — the URL lands on your clipboard, the button
flashes ✓ Copied, and you're done. See the full walkthrough in
[Broadcast overlay](./broadcast-overlay.md).

## Live spectator URL — coming soon

The second row is a URL for sending to friends/family so they can watch
the live score on their own phone. The Copy button is disabled today
because **cross-device live sync isn't shipped yet** — a URL alone
isn't enough to sync scores from your phone to someone else's phone.

We're planning to add a live-sync backend (probably Firebase's free
tier or Supabase Realtime) in a future release so this actually works.
When it does, the button will turn on and existing spectator URLs will
start working — no re-share needed.

Until then, if you want to share the current score with someone remote,
either:
- Take a screenshot and send it, or
- Point them at the live broadcast (if you're streaming with the
  overlay).

## What's actually in the URL

Both URLs are just the current match's setup encoded in the query
string — player names, "Represents" fields, sets, points target, board
cap, mode. Anyone who opens them sees a scoreboard set up for those
players. The difference:

- Overlay URL has `&view=overlay` appended → renders as a transparent
  broadcast strip.
- Live spectator URL has no `view` parameter → renders as the normal
  score screen.

Nothing sensitive is in the URL. There are no tokens, no accounts, no
credentials. Sharing the URL is exactly like sharing a link to a
public webpage.

## Related

- [Broadcast overlay](./broadcast-overlay.md) — how to use the overlay URL.
- [Keeping the score](./keeping-the-score.md).
