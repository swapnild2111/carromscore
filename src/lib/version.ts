/**
 * Current app version. Kept in sync with twa/twa-manifest.json's
 * appVersionName. The update-check compares this string against the
 * `tag_name` on the latest GitHub Release.
 */
export const APP_VERSION = '3.4.1';

const REPO = 'swapnild2111/carromscore';

/**
 * URL to a specific version's release page on GitHub. Rendered as
 * the click target for every version pill in the app (home footer,
 * scoreboard footer, lobby header) so users can read the release
 * notes for the build they're running with one tap.
 *
 * Accepts a version like "2.1.2" or "v2.1.2" — normalises the leading
 * "v". Falls back to /releases if the version is empty.
 */
export function releaseUrl(version: string = APP_VERSION): string {
  if (!version) return `https://github.com/${REPO}/releases`;
  const tag = version.startsWith('v') ? version : `v${version}`;
  return `https://github.com/${REPO}/releases/tag/${tag}`;
}

/**
 * Metadata about the latest release, extracted from the GitHub Release
 * body. `apkRequired` distinguishes:
 *   - false (default): a code-only release. Users on an older APK still
 *     get the update automatically via the TWA — no download needed,
 *     just relaunch. The banner should say so calmly.
 *   - true: the wrapper itself changed (icon, orientation, target SDK,
 *     URL, keystore) and users must install the new APK to get parity.
 *     The banner should be sharp and stick.
 *
 * The marker is a plain HTML comment in the release body so it's
 * invisible to readers on GitHub but easy for us to parse:
 *
 *     <!-- apk-required: true -->
 *     <!-- apk-required-reason: Icon and orientation changed. -->
 *
 * Missing marker → apkRequired: false. That's the safe default; historically
 * only 1 in ~10 releases has ever required a new APK.
 */
export type ReleaseInfo = {
  tag: string;
  apkRequired: boolean;
  apkRequiredReason: string | null;
};

// Match a `<!-- key: value -->` marker. `[^\n<]{0,200}` bounds the value
// so the regex is linear (no super-linear backtracking) and can't span
// newlines or nest inside another HTML comment.
const MARKER_RE = /<!--\s*([a-z-]+):([^\n<]{0,200})-->/gi;

function parseApkRequired(body: string): { required: boolean; reason: string | null } {
  let required = false;
  let reason: string | null = null;
  for (const m of body.matchAll(MARKER_RE)) {
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'apk-required') required = value.toLowerCase() === 'true';
    else if (key === 'apk-required-reason' && value) reason = value;
  }
  return { required, reason };
}

/**
 * Fetches the latest release from GitHub. Returns null on network or
 * rate-limit failure — the caller silently hides the update banner in that
 * case (never surface an infrastructure error to a player mid-scoring).
 */
export async function fetchLatestRelease(): Promise<ReleaseInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tag = data?.tag_name;
    if (typeof tag !== 'string') return null;
    const body = typeof data?.body === 'string' ? data.body : '';
    const { required, reason } = parseApkRequired(body);
    return { tag, apkRequired: required, apkRequiredReason: reason };
  } catch {
    return null;
  }
}

/**
 * @deprecated retained for backwards compatibility with any callers that
 * only care about the tag. Prefer `fetchLatestRelease` — it also tells
 * you whether the release requires a new APK.
 */
export async function fetchLatestReleaseTag(): Promise<string | null> {
  const info = await fetchLatestRelease();
  return info?.tag ?? null;
}

/**
 * Returns true if `latest` describes a newer version than `current`.
 * Both are expected to look like "v1.5.1" or "1.5.1"; missing fields are
 * treated as zero, so "1.5" vs "1.5.1" compares as older.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) =>
    v.replace(/^v/, '').split('.').map((s) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    });
  const a = parse(current);
  const b = parse(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (bi > ai) return true;
    if (bi < ai) return false;
  }
  return false;
}
