# Firebase Analytics setup

Firebase Analytics runs in the background whenever the app has a
`PUBLIC_FIREBASE_MEASUREMENT_ID` in its build environment. No
consent banner, no toggle in the app — the design decision (v3.4.0
during beta) was that we want a real signal on where the app is
used, and the data we collect is limited enough that an opt-in
prompt was more theatre than protection.

## What is collected

- **Geography** — country, region, city (Google's default;
  country is the useful signal for us).
- **Device / browser** — model, OS, browser vendor + version.
- **Session events** — `first_open`, `session_start`,
  `user_engagement`, `app_remove`.
- **Screen views** — via manual `logEvent('screen_view', …)` calls
  in each route: `home`, `lobby`, `admin`, `setup`, `score`. See
  [../../src/lib/analytics.ts](../../src/lib/analytics.ts).

## What is NOT collected

- No `setUserId`, no per-user linkage. Two sessions on one phone
  look like two anonymous sessions.
- No conversion or funnel events beyond `screen_view`.
- No `/live/{mid}` spectator views. Someone tapping a shared link
  from WhatsApp / Slack doesn't count — the client checks
  `isSpectatorView()` and drops the event before it emits.
- Nothing is sold or shared with third parties. The GA4 property
  is bound to the same Google account that owns the Firebase
  project.

## How a user opts out (browser-level, not in-app)

The app itself has no opt-out UI (removed in v3.4.0-beta.3). Users
who want to block Analytics can:

- Enable Firefox's built-in tracking protection (strict mode
  blocks Google Analytics by default).
- Install uBlock Origin / Ghostery / Privacy Badger — Firebase
  Analytics is on every common blocklist.
- Enable "Do Not Track" (Firebase Analytics honors the DNT header
  when the browser sends it).
- On mobile TWA, browsers' anti-tracking flags apply the same way
  since the TWA is Chrome under the hood.

The blocked case is graceful — `src/lib/analytics.ts` swallows the
failed init and the rest of the app works normally.

## Enabling Analytics on a fresh Firebase project

One-time super task, outside the codebase:

1. Firebase console → project → **Analytics** in the sidebar →
   **Enable Google Analytics**.
2. Accept the "Google Analytics for Firebase" terms; pick or
   create a GA4 property. Same Google account that owns the
   Firebase project.
3. Firebase console → **Project settings** → **Your apps** →
   **Web SDK snippet** → copy the `measurementId` (format
   `G-XXXXXXXXXX`).
4. Add it to two places:
   - **GitHub repo → Settings → Secrets and variables → Actions**:
     new repo secret `PUBLIC_FIREBASE_MEASUREMENT_ID` = the value.
   - Local `.env` (git-ignored): same name and value, so `npm run
     dev` and `npm run build` pick it up locally.
5. Redeploy. First data lands in the Realtime tab of the Firebase
   console within a few minutes; the full dashboard shape
   populates over ~24h.

## Turning it off entirely (super, cluster-wide)

Two ways:

- **Codebase**: remove `PUBLIC_FIREBASE_MEASUREMENT_ID` from repo
  secrets. Next deploy: `src/lib/analytics.ts` sees no measurement
  id and silently skips the SDK.
- **Firebase console**: **Analytics** → **Analytics settings** →
  disable data collection. Same effect, no redeploy required.

## Where to read the data

Firebase console → project → **Analytics** section. Useful tabs:

- **Realtime** — the last 30 minutes; check that the SDK is
  actually posting after a deploy.
- **Reports overview** — DAU / WAU / MAU by country. This is the
  primary signal driving "should we invest in Play Store + paid
  RTDB tier."
- **Screens** — screen_view counts. Answers "does anyone use
  Reports?" — look for the `admin` screen and drill into event
  parameters.
- **Retention** — needs ≥30 days of data before it's useful.
