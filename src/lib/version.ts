/**
 * Current app version. Kept in sync with twa/twa-manifest.json's
 * appVersionName. The update-check compares this string against the
 * `tag_name` on the latest GitHub Release.
 */
export const APP_VERSION = '1.5.3';

const REPO = 'swapnild2111/carromscore';

/**
 * Fetches the latest release tag from GitHub. Returns null on network or
 * rate-limit failure — the caller silently hides the update banner in that
 * case (never surface an infrastructure error to a player mid-scoring).
 */
export async function fetchLatestReleaseTag(): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const tag = data?.tag_name;
    return typeof tag === 'string' ? tag : null;
  } catch {
    return null;
  }
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
