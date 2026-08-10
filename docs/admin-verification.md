# Admin verification — E2E checklist

Run through this after any change to auth, roles, or admin helpers.
Applies to `/carromscore/`.

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
- [ ] `/users/{yourUid}` in RTDB has `email` + `displayName` fields
  (written on every sign-in by `upsertOwnUserMirror`).
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

## /admin/ Roles

- [ ] Roles tab is the first tab.
- [ ] Type an email that hasn't signed in → "No user with that
  email — ask them to sign in once, then try again."
- [ ] Type an email that has signed in + pick a tournament chip →
  Add → organiser row appears with display name + email + tournament
  chip.
- [ ] Add super role via email → super row appears in the Supers
  list with display name + email.
- [ ] Remove buttons work; audit log records both actions.

## /admin/ Players

- [ ] Search filters the list.
- [ ] Add player → new row appears at the top.
- [ ] Rename → new name persists, playerId stays the same.
- [ ] Merge → picks a duplicate, requires type-MERGE confirm, then
  every match that referenced the duplicate now shows the canonical
  player in the History tab.
- [ ] Multi-select 3 rows → **Delete selected** → type-DELETE
  confirm → all three rows gone.

## /admin/ Tournaments

- [ ] Add tournament → new row appears; picker in setup screen
  offers it as an autocomplete option.
- [ ] Rename in-place (case-only change) → history cards reflect
  the new casing.
- [ ] Rename with a different key → children move to the new key,
  old key gone from the list.
- [ ] Delete → type-DELETE confirm → tournament gone. Child
  matches show under "Default" bucket in the lobby, still visible.
- [ ] Multi-select 2 rows → **Delete selected** → both gone.

## /admin/ Live matches

- [ ] Default filter is "All" — lists every /live/{mid} record.
  Active broadcasts have a red **LIVE** chip; stuck ones have a
  **stuck** chip. Counts on the two filter chips match the visible
  row count when each is selected.
- [ ] Switching to "Stuck only" narrows to records with no updates
  in 4+h, or no matchResult for 2+h. Selection state resets on
  filter change (prevents stale bulk-delete targets).
- [ ] Delete → record disappears; History unaffected.
- [ ] Multi-select → **Delete selected** → all removed atomically.
- [ ] Passive auto-sweep: any signed-in super's `/admin/` visit
  triggers `sweepStaleLive` which batch-deletes up to 50 stuck
  records >4h old. Verify by seeding a stale record with
  `updatedAt = now-5h`, opening `/admin/`, and confirming it's
  gone from `/live/`. Audit log has a `live.sweep` entry.

## /admin/ History cleanup

- [ ] Flat list of every archived match; search by player /
  tournament / mid works.
- [ ] Delete a single match → row gone; audit-logged.
- [ ] Multi-select 5 rows → **Delete selected** → type-DELETE
  confirm → all 5 gone; audit log has 5 `match.delete` entries.

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
