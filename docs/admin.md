# Carromscore admin — maintainer guide

Applies to: **Carromscore v2.0.x and later**.

Carromscore's admin surface is one page (`/admin/`) plus inline
affordances (pencil on match cards, "Fix this match" on the end
recap). This doc explains who can do what, how to grant access, and
how to recover from mistakes.

---

## Roles

Two roles, both stored in RTDB:

- **super** — `/adminRoles/{uid} = "super"`. Full CRUD on every
  data path. Sees the `/admin/` page. That's you (the maintainer).
- **organiser** — `/tournaments/{key}/organisers/{uid} = true`.
  Can edit or delete any match whose `tournament` field points at
  this tournament. Cannot rename or delete the tournament itself
  (super-only). Cannot access `/admin/`.

Anyone signed in but without either role gets a "not an admin"
dialog when they tap the Admin link. Anonymous users see no admin
surface at all.

### Self-service for signed-in users

Any signed-in user (no role required) can **self-delete a match they
recorded themselves**. `finishMatch` stamps `createdBy: auth.uid` on
every archived record when the caller is signed in, and the RTDB
rule on `/matches/$id/.write` includes a
`data.child('createdBy').val() == auth.uid` branch. In the /live/
lobby's match sheet, users see a small "Delete this match" affordance
on their own records only. Requires typing DELETE to confirm.

Self-editing is **not** supported — score disputes still go through
organisers. Matches recorded before the user signed in have no
`createdBy` and are not self-deletable.

Rules are the enforcement layer: `database.rules.json` — every
mutation rule checks the role. UI gating is UX only.

---

## Granting organiser rights — by email

As of v2.0, the Roles tab accepts a **Gmail address** directly. No
more UID sharing.

1. Recipient signs in at `/carromscore/` at least once — even the
   "not authorised" outcome is fine. This writes their
   `{email, displayName}` to `/users/{uid}` (a client-side mirror
   written on every sign-in), which the admin page uses to resolve
   email → UID.
2. In `/admin/` → **Roles** tab → paste the recipient's Gmail into
   the email field.
3. Choose scope:
   - **Super** — full admin rights. Rare; use only for co-maintainers.
   - **Organiser of…** — pick one or more tournaments from the chip
     picker. Chips list every tournament in the DB, most-recent first.
4. Tap **Add**. The row appears in the "Organisers" (or "Supers")
   list below with display name + email.

**If the email isn't found:** the recipient hasn't signed in yet.
Ask them to open the Admin link once, then try again.

To revoke: **Remove** button next to their entry.

---

## Seeding the first super-admin

If you're setting up a fresh Firebase project (or the `/adminRoles`
node was wiped), the RTDB rule permits **exactly one** self-promotion:
the first authenticated user whose UID matches
`PUBLIC_BOOTSTRAP_SUPER_UID` in `.env` can write themselves in as
super. See `src/lib/roles.ts:bootstrapSuperIfNeeded`.

Alternatively, write `/adminRoles/{yourUid} = "super"` directly in
the Firebase console. This is what was done for the beta.

Once any super exists, the bootstrap window closes — subsequent
`bootstrapSuperIfNeeded` calls are refused by the rule.

---

## Admin capabilities

### Match records (inline pencil, or `/admin/` → History cleanup)

- **Super:** edit any match, delete any match. Bulk-delete supported
  in History cleanup (multi-select rows → **Delete selected**).
- **Organiser:** edit or delete only matches whose `tournament`
  field matches one of their organiser tournaments. Cannot move a
  match into a different tournament (rule enforces
  `newData.child('tournament').val() == data.child('tournament').val()`).

Both go through `updateMatch` / `deleteMatch` / `deleteMatches` in
`src/lib/history.ts`. Every write generates an audit entry.

### Players (`/admin/` → Players tab)

- **Add player** — create one or many player records. Enter names
  comma-separated (`Ravi K, Priya M, Nirmal S`) or one per line;
  mix both if easier. A **country** applies to every player in the
  batch (mandatory field). The next screen resolves any names that
  already exist in the roster: choose per-row between _Create as
  new_, _Add as alias of an existing player_, or _Skip_. Namesakes
  from different countries are legitimately distinct records —
  when the exact-name match's country doesn't match the batch
  country, the default action is _Create as new_.
- **Edit player** — the pencil chip on any row opens a dialog that
  lets you correct or add a country and manage the player's alias
  list. Single **Save** button at the bottom commits everything at
  once — no per-field save.
- **Rename** — update the display name; playerId stays the same, so
  every historical match still resolves correctly.
- **Delete** / **Bulk delete** — multi-select rows, then delete all
  at once. Match records that referenced the ids keep their playerId;
  those matches render the player as a prettified slug.
- **Merge** — pick a duplicate, pick the canonical. Every match
  that references the duplicate's playerId is rewritten atomically
  to point at the canonical. Duplicate aliases are unioned into the
  canonical. Duplicate record is deleted. Requires `Type MERGE`
  confirmation.

Merge is the most valuable admin action — use it whenever you spot
"M. Ilyas" and "Ilyas Khan" as separate entries.

Country flags surface on the home picker (beside each suggestion)
and on the singles-mode scoreboard header (beside each player's
name), so keeping the country field accurate has real user-facing
value.

### Tournaments (`/admin/` → Tournaments tab)

- **Add tournament** — create a new tournament tag ahead of the
  first match. Not required (tags auto-create on match end) but
  useful to pre-populate the picker for organisers.
- **Open / Closed state (v3.1)** — each tournament carries a
  state field. **Open** (default) accepts new matches;
  **Closed** rejects them — the home form warns the umpire that
  "Silver Cup 2026 is closed" when they pick a closed tournament,
  though the warning is advisory and can be overridden. Toggle
  state per row. Organiser assignment stays independent of state
  — closed tournaments can still be edited by their organisers.
- **Rounds (v3.2)** — every tournament can carry a list of named
  stages (Round of 16, Quarter-finals, Semi-finals, Final, ...).
  Umpires pick a round at match setup so History and Reports can
  group per-stage. Optional — a tournament without any rounds
  keeps its pre-v3.2 flat match list. The **Rounds** action per
  row opens a modal with:
    - **Add round** — creates a round; `order` auto-increments so
      new rounds append to the end.
    - **Rename** — updates the display name; if the normalised
      key changes, every match's `roundKey` field is rewritten
      atomically so the round tag survives the rename.
    - **Open / Closed state per round** — a closed round is
      excluded from the match-setup round picker, so an organiser
      can seed R16 matches, close R16, and only QF appears in the
      picker from that point on.
    - **Delete round** — removes the round record. Matches lose
      the round tag but stay in the tournament — they appear
      under an *Unassigned* sub-group in History.
- **Edit (v3.2)** — one dialog covers name, Open/Closed access,
  and country. Save applies rename first (if the normalised key
  changes, we clone to a new record and rewrite every child
  match's `tournament` / `tournamentKey` fields), then the meta
  patch for type + country. Rename inside the same modal replaces
  the pre-v3.2 inline rename affordance.
- **Delete** / **Bulk delete** — multi-select rows, then delete all
  at once. Cascade rule: deleting a tournament also removes every
  match tagged with its `tournamentKey` (matches you're not
  authorised to delete are silently skipped and reported in the
  outcome summary). Confirmation dialog shows the child-match count
  before DELETE.

### Live matches (`/admin/` → Live matches tab)

- Lists every `/live/{mid}` record in Firebase. Filter chips at the
  top switch between:
  - **All** — every live record (active broadcasts + stuck ones).
  - **Stuck only** — records with no updates in 4+ hours, or no
    `matchResult` for 2+ hours. The pre-v2.0 default view, retained
    as a filter option.
- Each row is tagged either **LIVE** (active, recent updates) or
  **stuck** so admins can distinguish at a glance.
- **Delete** / **Bulk delete** — multi-select rows, then delete
  all at once. Only the ephemeral `/live/{mid}` record is removed;
  the archived `/matches` record (if the umpire tapped End) is
  unaffected. To delete archives, use History cleanup.
- **Auto-sweep:** in addition to manual cleanup, any signed-in
  admin's page load triggers a passive sweep that batch-deletes
  up to 50 stuck records older than 4h. Cheap; runs silently. See
  `sweepStaleLive` in `src/lib/live-sync.ts`.

### History cleanup (`/admin/` → History cleanup tab)

- Flat searchable list of every archived match. Search by player,
  tournament, or match id.
- **Delete** / **Bulk delete** — same pattern as other tabs. Every
  deletion audit-logged.

Useful for wiping scrubbed test matches, an umpire's phantom-end,
or any match a super wants gone.

### Audit log (`/admin/` → Audit log tab)

- Reverse-chrono list of every admin write.
- Expand a row to see the before/after diff, the actor, and the
  targeted path.

---

## Audit log

Every admin write (match update/delete, player rename/merge/delete,
tournament rename/delete, organiser add/remove, live delete, live
bulk-delete, live auto-sweep) pushes an entry to `/audit/{pushId}`.
Read-only super. Append-only via rules — no delete branch on
`/audit/$id/.write`.

**Storage:** ~1 KB per entry. Fine for hobby scale over years on
Spark. If it ever becomes an issue, prune the oldest entries via
Firebase console.

**Gaps:** the audit write happens *after* the mutation. If the
audit write itself fails, `console.warn` fires but the mutation
still stands. Rare in practice.

---

## Recovering from a bad delete

Firebase's Realtime Database Spark tier includes **daily automated
backups** for 30 days, viewable at:
`https://console.firebase.google.com/project/carrom-score/database/backups`.

To restore:
1. Firebase console → Realtime Database → Backups.
2. Pick the most recent backup before the mistake.
3. **Export** the JSON.
4. **Do not** restore to production directly — you'd wipe every
   change since the backup. Instead:
   - Create a scratch Firebase project.
   - Import the backup there.
   - Read the specific path you need (e.g. `/matches/xxx`).
   - Copy the JSON.
   - Paste it back into production at that same path.

The audit log lets you identify the exact time you need to roll
back to.

---

## Reference

- Rules: [`database.rules.json`](../database.rules.json)
- Auth wrapper: [`src/lib/auth.ts`](../src/lib/auth.ts)
- Role wiring: [`src/lib/roles.ts`](../src/lib/roles.ts)
- Audit: [`src/lib/audit.ts`](../src/lib/audit.ts)
- User mirror (email→UID): [`src/lib/users.ts`](../src/lib/users.ts)
- Admin helpers: `updateMatch/deleteMatch/deleteMatches` in
  `src/lib/history.ts`,
  `mergePlayers/updatePlayerName/deletePlayer/deletePlayers/createPlayer`
  in `src/lib/players.ts`,
  `renameTournament/deleteTournament/deleteTournaments/addOrganiser/removeOrganiser/createOrTouchTournament`
  in `src/lib/tournaments.ts`, `deleteLive/deleteLiveMany/sweepStaleLive`
  in `src/lib/live-sync.ts`.
- Admin UI: `src/pages/admin/index.astro` +
  `src/components/AdminHome.svelte` + `AdminRoles.svelte` +
  `AdminPlayers.svelte` + `AdminTournaments.svelte` +
  `AdminLiveCleanup.svelte` + `AdminHistoryCleanup.svelte` +
  `AdminAuditLog.svelte` + `AdminBulkBar.svelte`.
