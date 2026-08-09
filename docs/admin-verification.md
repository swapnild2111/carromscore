# Admin verification — E2E checklist

Run through this on the beta channel after any change to auth,
roles, or admin helpers. Applies to `/carromscore/beta/`.

## Setup

- [ ] Rules published in Firebase console match `database.rules.json`
  in this branch. RTDB → Rules tab shows a "Published" timestamp
  newer than the commit hash you're testing.
- [ ] Google sign-in provider is enabled (Firebase → Auth →
  Sign-in method).
- [ ] `swapnild2111.github.io` is in the Auth authorised-domains
  list.
- [ ] `/adminRoles/{yourUid}` = `"super"` in the RTDB.

## Anonymous flow (nothing should change for casual users)

- [ ] Home page loads without any auth-related chrome except the
  small "Admin" footer link.
- [ ] Setup → Start a Singles match, score a few points, tap End.
  The match completes and appears in the Live lobby History tab.
- [ ] Live lobby loads: no sign-in pill in the header, no pencil
  on any cards.
- [ ] `/admin/` shows "Sign in with Google" gate.

## Sign-in flow

- [ ] Home footer "Admin" pill → tap opens Google popup (desktop)
  or full-screen picker (mobile).
- [ ] After sign-in, footer pill becomes an avatar + name.
- [ ] Tapping the avatar opens an inline dropdown (upward on home).
- [ ] Dropdown shows SUPER badge next to your name.
- [ ] Dropdown includes "Open admin panel ⇗" link (super only) and
  "Sign out".
- [ ] Sign out returns the pill to "Admin" state.

## Lobby (signed in as super)

- [ ] Header shows avatar + name pill.
- [ ] Every match card in History has a ✎ pencil in the bottom-right.
- [ ] Tap pencil → MatchEditModal opens with real player names on
  the labels ("Sets — Swapnil Deshpande").

## Match edit modal

- [ ] Final points A/B and Board count are read-only dashed cells.
- [ ] Edit a boardLog row → the read-only totals update live.
- [ ] Save → popup closes, card in lobby shows updated points.
- [ ] Open the popup for the same card → recap table + header DSEG7
  now match the edit.
- [ ] Delete → type-DELETE confirm → row removed from list.

## /admin/ Players

- [ ] Search filters the list.
- [ ] Rename → new name persists, playerId stays the same.
- [ ] Merge → picks a duplicate, requires type-MERGE confirm, then
  every match that referenced the duplicate now shows the canonical
  player in the History tab.

## /admin/ Tournaments

- [ ] Rename in-place (case-only change) → history cards reflect
  the new casing.
- [ ] Rename with a different key → children move to the new key,
  old key gone from the list.
- [ ] Manage organisers → add a UID from another Google account →
  from that other account, that account can now edit matches
  tagged to this tournament.
- [ ] Delete → type-DELETE confirm → tournament gone. Child
  matches show under "Default" bucket in the lobby, still visible.

## /admin/ Live cleanup

- [ ] Only shows records with no updates in 4+h, or no
  matchResult for 2+h.
- [ ] Delete → record disappears; History unaffected.

## /admin/ Audit log

- [ ] Every action above produced an entry, newest first.
- [ ] Click a row → before/after diff expands.
- [ ] Regular (non-super) signed-in user visiting `/admin/` sees
  "You're signed in — but this page is super-admin only." Their
  UID is shown.

## Match-end lockout

- [ ] Play a match to completion → tap End → winner popup.
- [ ] After End, tap POINTS+ → toast: "Match ended — score is
  locked. Use Reset to start over."
- [ ] After End, tap BOARD+1 → same toast.
- [ ] After End, tap SET+1 → same toast.
- [ ] After End, tap the queen coin → same toast.
- [ ] POINTS-1 / BOARD-1 / SET-1 still work as undo.

## Bundle discipline

- [ ] `npm run build` produces per-page chunks.
- [ ] Home page bundle (`dist/_astro/MatchSetup.*.js`) contains
  **zero** references to `firebase/auth` (`grep -c 'firebase/auth'`
  returns 0).
- [ ] Same for LiveLobby, ScoreBoard, AdminHome bundles — the
  auth chunk is only lazy-loaded on first `subscribeAuth` /
  `signIn` call.
