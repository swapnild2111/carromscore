# Offline-first scoring

Carromscore works with no internet. Score a full match on a train, in
a hall with dead WiFi, in the middle of a data-throttle — every tap
lands, the scoreboard renders correctly, and the recap works normally.
When the network returns, everything syncs to the shared server.

## What triggers offline mode

Carromscore watches two signals and enters offline mode when either
one says "no network":

- **Your device says the network is down** (airplane mode, WiFi off,
  no cellular).
- **Firebase can't be reached** (captive portal, DNS issue, blocked
  in the venue).

When it goes offline, a small amber banner appears at the top of
every screen: *"You're offline — matches save on this device and
sync when you're back online."* The lobby chip on the home screen
also turns grey.

## What still works offline

- **Start a match.** Setup, mode, rules, tournament tag — all local.
- **Score every board.** Points, sets, break, queen, board advance
  — full behaviour.
- **End a match.** Recap dialog, matrix, medals — same as online.
- **Resume a mid-match reload.** Close the browser and reopen — the
  score screen picks up where you left off from local storage.
- **Practice mode.** Solo drills track missed shots and generate a
  full recap, entirely offline.

## What doesn't work offline

- **Broadcasting live to spectators.** Live requires an internet
  connection at both ends — the umpire's device to publish, the
  viewer's device to subscribe. Score locally now; sync when back
  online.
- **Signing in.** The Google sign-in popup needs the network to
  complete. Sign in *before* the outage if you want your match
  attributed to your account.
- **Real-time cross-device syncing.** Two devices watching the same
  match need internet — offline scoring is single-device.

## What syncs when you're back online

The moment the network returns:

- **In-progress matches** publish their latest state to `/live/{id}`
  in Firebase — spectators can now subscribe.
- **Ended matches** archive to `/matches/{id}` — the History tab in
  the lobby shows them normally.

The queue is on your device (localStorage), so you can close the
browser, come back an hour later, and the sync still happens when
you next open the app on that device.

## What happens if the queue never flushes

If you switch to a different device before reconnecting, the queued
match stays on the original device until you reopen the app there.
The umpire's device is the source of truth — no other device knows
about matches that never reached Firebase.

## Tips

- **Umpires expecting patchy networks**: keep the score tab open.
  The queue survives page reloads on the same device, but closing
  the browser tab entirely is riskier if you never come back.
- **Tournaments in bad-network venues**: pre-sign-in on WiFi before
  the venue, then let each umpire's device sync when the network
  cooperates. Organiser edits on the lobby still need internet.
- **First-time install**: install Carromscore on your device
  *while online at least once* — the app files need to reach the
  device before offline mode can serve them.
