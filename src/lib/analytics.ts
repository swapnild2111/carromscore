/**
 * Firebase Analytics — opt-in, dynamic-imported.
 *
 * The whole SDK is lazy-loaded so that users who decline the
 * first-run consent banner never download `firebase/analytics` at
 * all. The consent flag lives in localStorage; `setConsent(true)`
 * kicks off the one-shot init, `setConsent(false)` disables the
 * SDK's collection flag if it has already loaded.
 *
 * Every non-analytics module in the app should stay out of
 * `firebase/analytics` and go through this module — that's how the
 * consent gate stays load-bearing rather than decorative.
 *
 * Public promise (see docs/dev/architecture.md, README.md): analytics
 * is OFF by default. First-run consent banner asks; the user's
 * answer sticks in localStorage; they can revoke it any time from
 * Settings.
 */

import { firebaseApp } from './firebase';

/** localStorage key for the persisted consent state. */
const CONSENT_KEY = 'carromscore:analytics-consent';
/** localStorage key for the epoch-ms the user last declined; used to
 *  re-surface the banner after ~30 days (soft re-ask, not hostile). */
const DECLINED_AT_KEY = 'carromscore:analytics-declined-at';

/** How long a "No thanks" answer suppresses the banner before we
 *  ask again. 30 days matches typical browser-consent UX. */
export const RE_ASK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Consent state.
 *   - 'granted' → SDK is initialised, events flow.
 *   - 'denied'  → SDK is NOT loaded (we've never called import()).
 *   - 'unknown' → never asked; the banner should surface.
 */
export type ConsentState = 'granted' | 'denied' | 'unknown';

export function getConsent(): ConsentState {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    if (v === 'granted' || v === 'denied') return v;
    return 'unknown';
  } catch {
    // localStorage disabled (private tab) — treat as unknown; the
    // banner will keep re-showing until the user tries to persist.
    // That's acceptable — no worse than a hostile private-mode UX
    // elsewhere on the web.
    return 'unknown';
  }
}

/**
 * True when the "No thanks" cooldown has expired and it's OK to
 * re-surface the banner. Absent decline-timestamp = ask now
 * (someone who cleared storage should see the banner again).
 */
export function shouldReAskAfterDecline(): boolean {
  try {
    const raw = localStorage.getItem(DECLINED_AT_KEY);
    if (!raw) return true;
    const declinedAt = Number(raw);
    if (!Number.isFinite(declinedAt)) return true;
    return Date.now() - declinedAt > RE_ASK_MS;
  } catch {
    return true;
  }
}

/**
 * Whether the consent banner should render right now.
 *   - Unknown consent → yes.
 *   - Declined but past the re-ask window → yes.
 *   - Granted, or declined recently → no.
 */
export function shouldShowConsentBanner(): boolean {
  const state = getConsent();
  if (state === 'granted') return false;
  if (state === 'unknown') return true;
  return shouldReAskAfterDecline();
}

/** Dynamic-imported Firebase Analytics instance. Null when the SDK
 *  hasn't been loaded (either consent not granted, or first-init
 *  hasn't started yet). */
type AnalyticsInstance = unknown;
let cached: AnalyticsInstance | null = null;
let initPromise: Promise<AnalyticsInstance | null> | null = null;

/** Idempotent init. Loads `firebase/analytics` only when consent is
 *  granted; on subsequent calls returns the cached instance.
 *  Silent-on-failure — if analytics can't init (e.g. blocked by an
 *  ad-blocker), the rest of the app still works. */
async function initAnalytics(): Promise<AnalyticsInstance | null> {
  if (cached) return cached;
  if (getConsent() !== 'granted') return null;
  // No measurementId provisioned yet — analytics stays off.
  // Silent skip so a fork of the project without GA4 wiring
  // still boots normally.
  if (!import.meta.env.PUBLIC_FIREBASE_MEASUREMENT_ID) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const mod = await import('firebase/analytics');
      const instance = mod.getAnalytics(firebaseApp());
      // Belt-and-braces: analytics collection is ON by default when
      // getAnalytics() resolves, but we call setAnalyticsCollectionEnabled
      // explicitly so future toggles have a clean state to flip.
      mod.setAnalyticsCollectionEnabled(instance, true);
      cached = instance;
      return instance;
    } catch {
      // Blocked by an extension, offline, or the GA4 property isn't
      // provisioned yet — leave cached = null so we retry on the
      // next screen mount. This isn't infinite because getConsent()
      // still short-circuits until the user grants.
      return null;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

/**
 * Record a consent choice.
 *   - `true` → persist 'granted' + trigger init.
 *   - `false` → persist 'denied' + stamp the decline timestamp; if
 *     the SDK is already loaded (user revoking mid-session), turn
 *     collection off so no more beacons fire.
 */
export function setConsent(granted: boolean): void {
  try {
    if (granted) {
      localStorage.setItem(CONSENT_KEY, 'granted');
      localStorage.removeItem(DECLINED_AT_KEY);
      void initAnalytics().then((instance) => {
        // Fire an initial screen_view for the current page so the
        // Realtime tab lights up immediately. Callsites don't have
        // to remember to re-emit after consent.
        if (instance) {
          const path = typeof window !== 'undefined' ? window.location.pathname : '/';
          const name = screenNameForPath(path);
          if (name) void logScreen(name);
        }
      });
    } else {
      localStorage.setItem(CONSENT_KEY, 'denied');
      localStorage.setItem(DECLINED_AT_KEY, String(Date.now()));
      if (cached) {
        // Best-effort: turn collection off on the already-loaded SDK.
        // Import is already in the bundle at this point, so re-loading
        // is free.
        void import('firebase/analytics').then((mod) => {
          try {
            mod.setAnalyticsCollectionEnabled(cached as never, false);
          } catch {
            // Nothing to do — flag stops future emit calls anyway.
          }
        });
      }
    }
  } catch {
    // localStorage unavailable — the flag stays unknown. Not much
    // else we can do; the app still works.
  }
}

/** Named screen for the routes we care about. `null` = don't log. */
export type ScreenName = 'home' | 'lobby' | 'admin' | 'setup' | 'score';

/** Map a URL pathname (BASE-stripped) to a screen name. Anything not
 *  in the map returns null so we don't accidentally log noise. */
function screenNameForPath(path: string): ScreenName | null {
  // Strip the base URL prefix (Astro's `import.meta.env.BASE_URL`)
  // so `/carromscore/beta/live/` and `/carromscore/live/` both
  // resolve to `lobby`.
  const stripped = path.replace(/^\/[^/]*\/(beta\/)?/, '/');
  if (stripped === '/' || stripped === '') return 'home';
  if (stripped.startsWith('/live')) return 'lobby';
  if (stripped.startsWith('/admin')) return 'admin';
  if (stripped.startsWith('/score')) return 'score';
  if (stripped.startsWith('/setup')) return 'setup';
  return null;
}

/**
 * True when the current URL is a public spectator link — a
 * drive-by view from a shared /live/{mid} URL, or a scoreboard
 * loaded as a broadcast overlay. Screen-view logging skips these
 * so the sample reflects umpires + curious readers, not everyone
 * who tapped a WhatsApp link.
 *
 * Signals:
 *   - explicit `?spec=1` query flag (broadcast overlay + any future
 *     read-only paths that want to opt out).
 *   - `/live/{mid}` share URLs — these are the primary drive-by
 *     surface. The lobby index page (`/live/` with no mid) is a
 *     legit lobby load and stays counted.
 */
export function isSpectatorView(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('spec') === '1') return true;
    // A `/live/<mid>` URL always has a `mid` param on the app;
    // presence of that in the query is enough to know we're on a
    // shared link. The lobby index has no `mid` and stays counted.
    if (url.pathname.includes('/live') && url.searchParams.get('mid')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Fire a `screen_view` event. No-op when consent is absent or the
 * SDK failed to load. Spectator views are silently dropped.
 */
export async function logScreen(name: ScreenName): Promise<void> {
  if (getConsent() !== 'granted') return;
  if (isSpectatorView()) return;
  const instance = await initAnalytics();
  if (!instance) return;
  try {
    const mod = await import('firebase/analytics');
    mod.logEvent(instance as never, 'screen_view', {
      screen_name: name,
      firebase_screen: name,
    });
  } catch {
    // Swallow — analytics failures never break the app.
  }
}
