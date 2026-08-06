# Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml` in ~1 minute. Tagging a release
(`git tag v1.8.0 && git push --tags`) creates a draft GitHub Release —
the flow from there depends on **whether the release needs a new APK**.

## Do I need to rebuild the APK?

**Rule of thumb**: the APK is a thin native shell around the live
website. If your change only touches `src/`, `public/`, or docs, users
get it automatically the next time they launch the app — no APK
rebuild required.

Rebuild the APK **only** when one of these changes:

- `twa/twa-manifest.json` — icon, name, orientation, display mode,
  `startUrl` / `host`, `themeColor`, target/min SDK.
- `twa/app/build.gradle` — `versionCode` / `versionName`.
- `public/.well-known/assetlinks.json` — only if the keystore
  fingerprint changes.
- The keystore itself (never intentionally).

If in doubt: **don't** rebuild. Web-layer updates ship instantly via
the TWA.

## Web-only release (most releases)

```sh
# 1. Bump versions
sed -i '' "s/APP_VERSION = '.*'/APP_VERSION = '1.8.0'/" src/lib/version.ts
sed -i '' "s/carromscore-v.*'/carromscore-v1.8.0'/" public/sw.js

# 2. Write release notes with the apk-required:false marker
$EDITOR twa/release-notes-v1.8.0.md   # (git-ignored, local only)

# 3. Commit, push, tag
git add src/lib/version.ts public/sw.js
git commit -m "v1.8.0: <feature summary>"
git push origin main
git tag v1.8.0 && git push origin v1.8.0

# 4. Publish the GitHub Release with the notes
gh release edit v1.8.0 --draft=false --notes-file twa/release-notes-v1.8.0.md
```

Users will see the [update toast](./update-notifications.md) on
next launch.

## APK-required release (rare)

Same setup as web-only, plus:

```sh
# Bump the wrapper versions too
$EDITOR twa/twa-manifest.json    # bump appVersionName + appVersionCode
$EDITOR twa/app/build.gradle     # match versionCode + versionName

# Build the APK
cd twa
./gradlew assembleRelease

# Sign with the local keystore
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --out carromscore-v1.8.0.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk

# Attach + publish
gh release upload v1.8.0 carromscore-v1.8.0.apk
gh release edit v1.8.0 --draft=false --notes-file release-notes-v1.8.0.md
```

Release notes should include `<!-- apk-required: true -->` and a
`<!-- apk-required-reason: … -->` so the app shows the amber "download
APK" banner.

Bubblewrap prerequisites (JDK 17 + Android SDK) live in
`~/.bubblewrap/`. The keystore stays local and is git-ignored — losing
it means users must uninstall + reinstall before any future update.

## The apk-required marker

The app's setup screen distinguishes between two kinds of updates by
parsing HTML-comment markers in the GitHub Release body:

```markdown
<!-- apk-required: false -->
```

or, for the rare case where the wrapper itself changed:

```markdown
<!-- apk-required: true -->
<!-- apk-required-reason: Icon and orientation changed. -->
```

Missing marker → app assumes `apk-required: false`. The markers are
invisible on the GitHub Releases page. See
[update-notifications.md](./update-notifications.md) for how the app
consumes them.

## Related

- [Local development](./local-development.md)
- [Update notifications](./update-notifications.md)
- [Architecture](./architecture.md)
