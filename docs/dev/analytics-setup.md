# Firebase Analytics setup

Optional. Off by default in every user's browser until they tap
**Allow** on the first-run consent banner.

## What is collected (per user, when opted in)

Firebase Analytics is not scoped-down-able — once initialised it
collects:

- **Geography** — country, region, city (Google's default).
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
  from WhatsApp/Slack doesn't count — the client checks
  `isSpectatorView()` and drops the event before it emits.

## Consent lifecycle

1. First launch after v3.4.0 → consent banner appears above the
   setup form on `/`.
2. **Allow** → localStorage `carromscore:analytics-consent = 'granted'`.
   The Analytics SDK is dynamic-imported and initialises. First
   screen_view fires within ~2s.
3. **No thanks** → `'denied'` + a timestamp under
   `carromscore:analytics-declined-at`. Banner is suppressed for
   30 days, then re-surfaces as a soft ask.
4. User revokes from Home → Settings → **Share usage analytics**
   toggle. `setAnalyticsCollectionEnabled(false)` fires
   immediately; beacons stop.

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
  id and silently skips the SDK. Consent banner still shows but
  taps go nowhere.
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
