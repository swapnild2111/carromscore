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

- **Add player** — create a new player record with a display name +
  optional aliases. Rare; usually the roster grows organically at
  match end.
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

### Tournaments (`/admin/` → Tournaments tab)

- **Add tournament** — create a new tournament tag ahead of the
  first match. Not required (tags auto-create on match end) but
  useful to pre-populate the picker for organisers.
- **Rename** — updates the tournament's display name. If the new
  name normalises to the same key, we just update `name`. If it
  normalises differently, we clone to a new key, rewrite every
  child match's `tournament` field, and delete the old record.
- **Delete** / **Bulk delete** — multi-select rows, then delete all
  at once. Child matches keep their tag string but fall to the
  "Default" bucket. Retention shortens from 1 year → 3 months for
  those matches.

### Live cleanup (`/admin/` → Live cleanup tab)

- Lists `/live/{mid}` records that look stuck: no updates in 4+
  hours, or no `matchResult` for 2+ hours.
- **Delete** / **Bulk delete** — multi-select rows, then delete
  all at once. `/matches` is unaffected.
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
