# Broadcast overlay (OBS / Prism)

Carromscore ships with a broadcast overlay: a transparent bottom-third
scoreboard strip that streaming software (OBS, Prism, Streamlabs, etc.)
can layer on top of a live camera feed.

<p align="center">
  <img src="../screenshots/13-overlay-bare.png" alt="Broadcast overlay: name pills, DSEG7 digits, set pips, BREAK and queen coin" width="900" />
</p>

Same visual language as the phone scoreboard — coloured player pills,
7-segment digits, set pips, BREAK / queen indicators. A broadcast
viewer sees the same thing your score-keeper sees.

## What it does

- **Fully transparent background** — composites cleanly over camera
  footage.
- **Live-updates from the phone** when both tabs are open in the same
  browser (see "How live sync works" below).
- **Adapts to match state** — shows the current set, board number,
  points, sets-won count, BREAK chip and queen coin.
- **Winner medal treatment** — when the match ends and you tap
  🏁 End Match, the overlay pills switch to gold/silver just like the
  phone. Broadcast viewers see the result on-screen.

## Setting up in Prism Live Studio

Prism has a Browser Source scene item — identical setup to OBS.

1. In the Carromscore app, tap **⧉ Share URL** in the footer.
2. The **Overlay URL** row has a **Copy** button — tap it. That's the
   URL you'll paste into Prism.
3. In Prism, add a new source: **Browser Source** (called "Browser" or
   "Web" depending on your version).
4. Configure:
   - **URL**: paste the overlay URL.
   - **Width**: `1920`
   - **Height**: `1080`
   - **Custom CSS**: leave empty (the overlay ships its own transparent
     background).
   - **Shutdown source when not visible**: uncheck.
   - **Refresh browser when scene becomes active**: uncheck.
5. Click OK. The overlay appears in the scene preview, positioned at
   the bottom third of the frame with a transparent top.

Layer the sources so the camera feed is *below* the Browser Source:

- Camera (webcam / capture card): lower in the sources list.
- Browser Source (the overlay): above the camera.

Prism composites top-of-list on top, so this puts the score strip over
the video.

## Setting up in OBS Studio

Same steps — the source type is called **Browser** (or "Browser Source"
in some versions). Everything else is identical.

## How live sync works

**The score-keeper and the overlay both need to be on the same laptop /
same browser.** When both tabs share the same browser's local storage,
score changes on the phone (or in the score-keeper's tab) update the
overlay tab instantly — sub-100ms in practice.

The recommended setup:
- **Score-keeper's laptop** runs the streaming software (Prism/OBS) and
  the scoring tab, both in Chrome (or Chromium-based browser). Score in
  the tab; the overlay picks up changes automatically.

**What doesn't work today**: scoring on your phone while the overlay
runs on a different laptop. That would need cross-device live sync,
which is on the roadmap for a future release.

<p align="center">
  <img src="../screenshots/14-overlay-composited.png" alt="Overlay strip composited over a mock carrom-table background" width="900" />
</p>

## Sizing the overlay

The overlay is designed for a **1920×1080** stream canvas. It occupies
the bottom third of the frame. For a 720p canvas, use 1280×720 for the
Browser Source dimensions and it scales down proportionally.

If you want the overlay in a corner or across a wider band, use Prism's
built-in transform:
- Right-click the Browser Source → **Transform** → **Edit Transform**
- Adjust the crop / scale / position numerically or by dragging
  handles.

The transparent background keeps compositing clean whatever you do.

## When the match ends

<p align="center">
  <img src="../screenshots/15-overlay-endgame.png" alt="Overlay end-of-match with gold and silver medal treatment on the pills" width="900" />
</p>

Tap 🏁 End Match on the phone. The overlay pills pick up the gold and
silver medal treatment automatically — 🥇 1ST on the winner, 🥈 2ND on
the loser. BREAK chip and queen coin disappear (match is over, they're
no longer meaningful).

Perfect way to end a live broadcast on a clean, celebratory frame.

## Troubleshooting

**"Overlay isn't updating when I tap the phone"** — the phone and the
overlay are on different devices, or the streaming software's Browser
Source is using a different browser context than your scoring tab. Move
scoring to the streaming laptop (same browser as Prism/OBS).

**"There's a URL bar showing at the top of the overlay"** — you pasted
the score URL instead of the overlay URL. Get the correct URL from the
**⧉ Share URL** button on the phone.

**"The overlay shows old scores after a while"** — right-click the
Browser Source → Properties → Refresh. Shouldn't be needed in normal
operation.

**"Player names are cut off"** — happens if the pill width is too
narrow for very long names. The pill truncates with an ellipsis. Try a
short display name in the Setup screen (e.g., "S. Deshpande" instead of
the full name).

## Related

- [Share URL](./share-url.md) — how the Share popup works.
- [Keeping the score](./keeping-the-score.md).
- [Break and queen](./break-and-queen.md).
