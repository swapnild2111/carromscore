# Carromscore admin — maintainer guide

Applies to: **Carromscore v2.0.x** (the beta channel and future GA).

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

## Granting organiser rights

Organisers can't be added by email (Google→UID resolution needs
serverless, unavailable on Spark tier). The recipient shares their
UID with you:

1. Recipient signs in at `/carromscore/beta/` (Admin link in the
   footer, Google sign-in).
2. Recipient taps their avatar pill on the home footer → dropdown
   opens → they read out their UID from the "SUPER"/"ORGANISER"
   badge area … *wait, that's not there yet.*

   Actually right now the UID is only shown to signed-in-but-no-role
   users (the "not an admin" dialog). If you're granting a first-time
   organiser, ask them to sign in and take a screenshot of that
   dialog — the UID is at the bottom.

3. In `/carromscore/beta/admin/` → **Tournaments** tab → find the
   tournament → **Organisers** → paste the UID → **Add**.

To revoke: same tab, click Remove next to the UID.

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

### Match records (inline pencil, or `/admin/` future extension)

- **Super:** edit any match, delete any match.
- **Organiser:** edit or delete only matches whose `tournament`
  field matches one of their organiser tournaments. Cannot move a
  match into a different tournament (rule enforces
  `newData.child('tournament').val() == data.child('tournament').val()`).

Both go through `updateMatch` / `deleteMatch` in
`src/lib/history.ts`. Both write an audit entry.

### Players (`/admin/` → Players tab)

- **Rename** — update the display name; playerId stays the same, so
  every historical match still resolves correctly.
- **Delete** — remove the player record. Match records that
  referenced the id keep their playerId; those matches will render
  the player as a prettified slug.
- **Merge** — pick a duplicate, pick the canonical. Every match
  that references the duplicate's playerId is rewritten atomically
  to point at the canonical. Duplicate aliases are unioned into the
  canonical. Duplicate record is deleted.

Merge is the most valuable admin action — use it whenever you spot
"M. Ilyas" and "Ilyas Khan" as separate entries.

### Tournaments (`/admin/` → Tournaments tab)

- **Rename** — updates the tournament's display name. If the new
  name normalises to the same key, we just update `name`. If it
  normalises differently, we clone to a new key, rewrite every
  child match's `tournament` field, and delete the old record.
- **Delete** — removes the tournament record. Child matches keep
  their tag string but fall to the "Default" bucket. Retention
  shortens from 1 year → 3 months for those matches.
- **Manage organisers** — add or remove organiser UIDs.

### Live cleanup (`/admin/` → Live cleanup tab)

- Lists `/live/{mid}` records that look stuck: no updates in 4+
  hours, or no `matchResult` for 2+ hours.
- **Delete** — removes the record. `/matches` is unaffected.

---

## Audit log

Every admin write (match update/delete, player rename/merge/delete,
tournament rename/delete, organiser add/remove, live delete) pushes
an entry to `/audit/{pushId}`. Read-only super. Append-only via
rules — no delete branch on `/audit/$id/.write`.

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
- Admin helpers: `updateMatch/deleteMatch` in `src/lib/history.ts`,
  `mergePlayers/updatePlayerName/deletePlayer` in `src/lib/players.ts`,
  `renameTournament/deleteTournament/addOrganiser/removeOrganiser`
  in `src/lib/tournaments.ts`, `deleteLive` in `src/lib/live-sync.ts`.
- Admin UI: `src/pages/admin/index.astro` +
  `src/components/AdminHome.svelte` + `AdminPlayers.svelte` +
  `AdminTournaments.svelte` + `AdminLiveCleanup.svelte` +
  `AdminAuditLog.svelte`.
