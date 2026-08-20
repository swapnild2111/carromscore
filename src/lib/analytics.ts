/**
 * Firebase Analytics — always-on, dynamic-imported.
 *
 * v3.4.0-beta.3 removed the first-run consent banner and Settings
 * toggle. Analytics is on by default so we get a real signal on
 * global reach (the ask that motivated the feature). Users who
 * want to opt out entirely can use uBlock Origin / Firefox's
 * built-in tracking protection — Firebase Analytics is on every
 * common blocklist. See docs/dev/analytics-setup.md for the
 * public wording.
 *
 * The SDK is still dynamic-imported so the analytics chunk sits
 * behind a lazy load rather than bloating the initial bundle.
 * It kicks in on the first `logScreen()` call (i.e. one screen
 * mount into any page).
 *
 * Every non-analytics module in the app should stay out of
 * `firebase/analytics` and go through this module — one place
 * that owns the SDK lifecycle.
 */

import { firebaseApp } from './firebase';

/** Dynamic-imported Firebase Analytics instance. Null when the SDK
 *  hasn't been loaded yet, or when it can't init (no measurement
 *  id in the build env, network offline, blocked by extension). */
type AnalyticsInstance = unknown;
let cached: AnalyticsInstance | null = null;
let initPromise: Promise<AnalyticsInstance | null> | null = null;

async function initAnalytics(): Promise<AnalyticsInstance | null> {
  if (cached) return cached;
  // No measurementId provisioned → silently disabled. A fork of
  // the project without GA4 wiring still boots normally.
  if (!import.meta.env.PUBLIC_FIREBASE_MEASUREMENT_ID) return null;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const mod = await import('firebase/analytics');
      const instance = mod.getAnalytics(firebaseApp());
      cached = instance;
      return instance;
    } catch {
      // Blocked by an extension, offline, or the GA4 property isn't
      // provisioned yet — leave cached = null so we retry on the
      // next screen mount. Analytics failures never block the app.
      return null;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

/** Named screen for the routes we care about. */
export type ScreenName = 'home' | 'lobby' | 'admin' | 'setup' | 'score';

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
 *   - `/live/{mid}` share URLs — the primary drive-by surface.
 *     The lobby index page (`/live/` with no mid) is a legit
 *     lobby load and stays counted.
 */
export function isSpectatorView(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.get('spec') === '1') return true;
    if (url.pathname.includes('/live') && url.searchParams.get('mid')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Fire a `screen_view` event. No-op when the SDK failed to load or
 * when the current URL is a spectator view (see `isSpectatorView`).
 */
export async function logScreen(name: ScreenName): Promise<void> {
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
