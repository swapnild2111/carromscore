# Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml` in ~1 minute. Tagging a release
(`git tag v1.8.0 && git push --tags`) creates a draft GitHub Release
which we then build an APK for and publish.

## Every release attaches a fresh APK

**Even for pure code changes.** The TWA-auto-updates model means an
existing user's APK still works — but `/releases/latest` is a landing
page where new users install from, and it needs a downloadable APK
asset every time. Skipping the APK build breaks that landing page.

The extra ~5 min of Gradle+apksigner per release is worth the
predictable install experience.

## The release flow

```sh
# 1. Bump versions across all four files
$EDITOR src/lib/version.ts               # APP_VERSION
$EDITOR public/sw.js                     # CACHE_NAME
$EDITOR twa/twa-manifest.json            # appVersionName + appVersionCode + appVersion
$EDITOR twa/app/build.gradle             # versionCode + versionName (match manifest)

# 2. Write release notes locally
$EDITOR twa/release-notes-v1.8.0.md      # git-ignored, kept local

# 3. Commit + push + tag
git add src/lib/version.ts public/sw.js twa/twa-manifest.json
git commit -m "v1.8.0: <feature summary>"
git push origin main
git tag v1.8.0 && git push origin v1.8.0

# 4. If push-triggered workflows don't fire, kick them manually:
gh workflow run deploy.yml --ref main
gh workflow run release.yml --ref main   # (or just create the release below)

# 5. Build + sign the APK
#
# The keystore lives at twa/android.keystore (git-ignored). The
# `KEYSTORE_PASSWORD` env var below carries the alias+key password;
# keep it out of the shell history and off the repo. If you need
# to look it up, check your password manager under
# "Carromscore APK keystore".
cd twa
./gradlew --no-daemon assembleRelease
read -rsp "keystore password: " KEYSTORE_PASSWORD && echo
$ANDROID_HOME/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --ks-pass "pass:$KEYSTORE_PASSWORD" \
  --key-pass "pass:$KEYSTORE_PASSWORD" \
  --out carromscore-v1.8.0.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk
unset KEYSTORE_PASSWORD

# 6. Verify signatures, compute SHA-256 for the notes
$ANDROID_HOME/build-tools/34.0.0/apksigner verify --verbose \
  carromscore-v1.8.0.apk | grep -E '^Verifies|scheme'
shasum -a 256 carromscore-v1.8.0.apk

# 7. Fill the SHA-256 into release notes, then upload + publish
$EDITOR release-notes-v1.8.0.md
cd ..
gh release upload v1.8.0 twa/carromscore-v1.8.0.apk
gh release edit v1.8.0 --draft=false --notes-file twa/release-notes-v1.8.0.md
```

## The apk-required marker

Every release attaches an APK, but the app still needs to know
whether users should be *prompted* to download it. That's what the
`<!-- apk-required: … -->` marker in the release notes controls:

```markdown
<!-- apk-required: false -->
```

Use this when the release is a code change only and existing users on
any recent APK will get the new UI automatically via the TWA. The
app shows a soft "Carromscore just updated — tap to restart" toast on
next launch. This is the common case.

```markdown
<!-- apk-required: true -->
<!-- apk-required-reason: Icon and orientation changed. -->
```

Use this **only** when the wrapper itself changed and users must
reinstall for parity. Triggers the sharp amber "New Android version
required" banner with a Download APK CTA. Rare.

Signals that mean `apk-required: true`:

- `twa/twa-manifest.json` — icon, name, orientation, display mode,
  `startUrl` / `host`, `themeColor`, target/min SDK.
- `public/.well-known/assetlinks.json` — only if the keystore
  fingerprint changes.
- The keystore itself (never intentionally).

`versionCode` / `versionName` bumps alone do NOT need the marker on —
they change every release but don't require the user to reinstall.

Missing marker → app assumes `apk-required: false`. The markers are
invisible on the GitHub Releases page. See
[update-notifications.md](./update-notifications.md) for how the app
consumes them.

## Bubblewrap prerequisites

JDK 17 + Android SDK, both auto-installed by `bubblewrap init` under
`~/.bubblewrap/`. The keystore stays local and is git-ignored —
losing it means users must uninstall + reinstall before any future
update.

## Push-trigger flakiness

If `git push origin main` (or a tag push) doesn't trigger a workflow
run within ~30s, GitHub Actions is occasionally slow to receive the
webhook. Kick the workflow manually with:

```sh
gh workflow run deploy.yml --ref main
```

Watch progress with `gh run list --workflow=deploy.yml --limit=3`.

## Related

- [Local development](./local-development.md)
- [Update notifications](./update-notifications.md)
- [Architecture](./architecture.md)
