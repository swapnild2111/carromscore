/**
 * Connectivity + server-time source of truth.
 *
 * Combines three signals that every offline-aware write path needs:
 *
 *   1. `navigator.onLine` — cheap, early "definitely no network"
 *      signal. Fires `online`/`offline` window events.
 *   2. Firebase RTDB `/.info/connected` — canonical "we can actually
 *      reach Firebase" signal. `true` when the SDK's WebSocket to
 *      Firebase is alive. Complements navigator.onLine, which can
 *      lie (WiFi with captive portal, DNS down, etc).
 *   3. Firebase RTDB `/.info/serverTimeOffset` — how far the local
 *      Date.now() drifts from Firebase's server clock. Load-bearing
 *      for queued writes replayed later: the RTDB rules in
 *      database.rules.json validate `updatedAt` (60s window) and
 *      `endedAt` (5-min window on create) against server time, so
 *      queue flushes need `serverNow()` for the restamp.
 *
 * The store's `online` is `navigator.onLine !== false` AND (if we've
 * ever observed .info/connected) `firebaseConnected === true`. If
 * either says "offline," we treat the app as offline. This is the
 * "when to write directly vs when to queue" toggle.
 *
 * House style: same lazy-import + silent-on-failure pattern as
 * live-sync.ts. If Firebase never loads (extreme first-visit-
 * offline case), we fall back to navigator.onLine alone.
 */

export type ConnectivityState = {
  /**
   * True when the app should attempt Firebase writes. False when
   * either navigator.onLine === false OR the Firebase socket is
   * definitively down.
   */
  online: boolean;
  /**
   * Which signal is driving the current `online` value. Purely for
   * debugging / banner copy ("You're offline — no network" vs
   * "You're offline — can't reach Firebase"). The two are usually
   * the same value; when they diverge, `navigator` wins.
   */
  source: 'navigator' | 'firebase' | 'unknown';
};

type Subscriber = (state: ConnectivityState) => void;

// Module-level state. Two independent signals, combined at read time.
let navigatorOnline = typeof navigator !== 'undefined' ? navigator.onLine : true;
// null = we've never heard from .info/connected. Treat as pending
// until either the SDK reports state OR a boot-time timer expires
// (see FIRST_CONNECT_TIMEOUT below). This matters because
// `navigator.onLine` is UNRELIABLE — it stays true when Chrome
// DevTools' Network → Offline is toggled, and doesn't reflect
// captive-portal / DNS-out cases. If the Firebase WebSocket can't
// establish within a reasonable window, we treat the app as offline
// even if navigator says otherwise.
let firebaseConnected: boolean | null = null;
let serverOffsetMs = 0;

/**
 * If Firebase hasn't confirmed a connection within this window at
 * boot, we flip firebaseConnected to false explicitly. Firebase's
 * SDK only emits `.info/connected: true` on a successful
 * WebSocket; it does NOT emit `false` when it's been unable to
 * connect since boot, so without this timer the module would stay
 * in the "pending" state forever on a cold-start offline visit.
 * 5 s is enough for a good network to negotiate the socket and
 * short enough to feel responsive when the umpire is offline.
 */
const FIRST_CONNECT_TIMEOUT = 5000;

const subscribers = new Set<Subscriber>();
let bootstrapped = false;

function currentState(): ConnectivityState {
  // If we've never heard from Firebase, trust navigator.
  if (firebaseConnected === null) {
    return {
      online: navigatorOnline,
      source: 'navigator',
    };
  }
  // Both signals present: require BOTH true to consider ourselves
  // online. Either "no" wins.
  const online = navigatorOnline && firebaseConnected;
  const source: ConnectivityState['source'] = !navigatorOnline
    ? 'navigator'
    : !firebaseConnected
      ? 'firebase'
      : 'navigator';
  return { online, source };
}

function notify(): void {
  const state = currentState();
  for (const sub of subscribers) {
    try {
      sub(state);
    } catch {
      // Subscriber threw — don't let it break the others. Swallow
      // silently; this store is a shared signal, not a place for
      // per-caller error surfacing.
    }
  }
}

/**
 * Subscribe to connectivity changes. Fires immediately with the
 * current state, then on every change. Returns an unsubscribe fn.
 *
 * The first call also lazy-boots the Firebase subscriptions
 * (`.info/connected` and `.info/serverTimeOffset`) so consumers
 * don't need to think about init ordering.
 */
export function subscribeConnectivity(cb: Subscriber): () => void {
  subscribers.add(cb);
  bootstrap();
  // Fire immediately with the current state (matches Svelte-store
  // ergonomics — no `.get()` needed for initial value).
  try {
    cb(currentState());
  } catch {
    // ignore
  }
  return () => {
    subscribers.delete(cb);
  };
}

/**
 * Snapshot the current state without subscribing. Handy for imperative
 * "should I write direct or queue?" branches inside handlers.
 */
export function getConnectivity(): ConnectivityState {
  bootstrap();
  return currentState();
}

/**
 * True server time = local Date.now() + the offset Firebase reports.
 * Use this for anything that will be persisted to RTDB and validated
 * against `now` — specifically the `updatedAt` on `/live/{mid}` and
 * `endedAt` on `/matches/{id}`. Purely local Date.now() risks failing
 * the RTDB validators when the device clock is skewed.
 *
 * Before Firebase has told us the offset (or if Firebase never
 * loads), returns plain Date.now() — the fallback is fine because
 * the validators use ±60s and ±5min windows, tolerant of small drift.
 */
export function serverNow(): number {
  return Date.now() + serverOffsetMs;
}

/**
 * Idempotent lazy bootstrap. Wires the two window listeners for
 * navigator.online/offline, and dynamically imports Firebase to
 * subscribe to the two .info nodes.
 */
function bootstrap(): void {
  if (bootstrapped) return;
  bootstrapped = true;

  // Window-level online/offline events. Only in a real browser.
  if (typeof window !== 'undefined') {
    const setNav = (val: boolean) => {
      if (navigatorOnline === val) return;
      navigatorOnline = val;
      notify();
    };
    window.addEventListener('online', () => setNav(true));
    window.addEventListener('offline', () => setNav(false));
  }

  // Boot-time timeout: if Firebase hasn't confirmed a connection
  // within FIRST_CONNECT_TIMEOUT, assume we're offline. The SDK
  // will still update `firebaseConnected` to true later if it
  // succeeds; this just handles the "app booted offline and the
  // socket never got anywhere" case that navigator.onLine can't
  // reliably signal (DevTools throttle, captive portal, DNS out).
  if (typeof window !== 'undefined') {
    window.setTimeout(() => {
      if (firebaseConnected === null) {
        firebaseConnected = false;
        notify();
      }
    }, FIRST_CONNECT_TIMEOUT);
  }

  // Firebase side. Silent-on-failure: if the SDK can't load (offline
  // first-visit before the bundle is cached), we stay on the
  // navigator-only signal path.
  void (async () => {
    try {
      const [{ firebaseApp }, { getDatabase, ref, onValue }] = await Promise.all([
        import('./firebase'),
        import('firebase/database'),
      ]);
      const db = getDatabase(firebaseApp());
      onValue(ref(db, '.info/connected'), (snap) => {
        const val = snap.val();
        // .info/connected emits booleans. Anything else = keep prev.
        if (val !== true && val !== false) return;
        if (firebaseConnected === val) return;
        firebaseConnected = val;
        notify();
      });
      onValue(ref(db, '.info/serverTimeOffset'), (snap) => {
        const val = snap.val();
        if (typeof val !== 'number' || !Number.isFinite(val)) return;
        serverOffsetMs = val;
        // No notify — offset changes don't affect the `online` flag
        // and no consumer subscribes to it. It's read lazily via
        // serverNow().
      });
    } catch {
      // Firebase didn't load. Stay on navigator-only. If the boot
      // timer already fired, we're already in the offline state
      // (correct — we don't have Firebase, so we can't reach it).
    }
  })();
}
