# Deployment

Every push to `main` deploys to GitHub Pages via
`.github/workflows/deploy.yml` in ~1 minute.

## Automated release pipeline (preferred)

`.github/workflows/release.yml` handles the full release in one click:
**Actions → Release → Run workflow** — pick `patch` / `minor` / `major`,
paste release notes, done. It:

1. Reads the current version from `src/lib/version.ts`
2. Computes the next semver, bumps all version files, commits + tags + pushes
3. Builds + signs the APK with Java 17 + Android SDK
4. Creates and publishes the GitHub Release with notes + APK + SHA-256

### One-time secret setup

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `KEYSTORE_BASE64` | `base64 -i twa/android.keystore \| pbcopy` — paste the result |
| `KEYSTORE_PASSWORD` | `carromscore-changeit` |

`PUBLIC_FIREBASE_API_KEY` and `PUBLIC_FIREBASE_MEASUREMENT_ID` should
already be present from the deploy workflow.

### Running a release

```
Actions → Release → Run workflow
  bump:  patch | minor | major
  notes: What changed (markdown, shown in the GitHub release)
```

That's it. The workflow pushes the version-bump commit to `main` (and
syncs `beta`) then publishes the release. No local steps needed.

---

## Manual release flow (fallback)

Use this only if the pipeline is broken or unavailable.

```sh
# 1. Bump versions across all four files
$EDITOR src/lib/version.ts               # APP_VERSION
$EDITOR public/sw.js                     # APP_VERSION
$EDITOR twa/twa-manifest.json            # appVersionName + appVersionCode
$EDITOR twa/app/build.gradle             # versionCode + versionName (match manifest)

# 2. Commit + push + tag
git add src/lib/version.ts public/sw.js twa/twa-manifest.json
git commit -m "vX.Y.Z: <feature summary>"
git push origin main && git push origin main:beta
git tag vX.Y.Z && git push origin vX.Y.Z

# 3. Build the APK (requires Java 17)
cd twa
JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home \
  ./gradlew --no-daemon assembleRelease

# 4. Sign + verify + SHA-256
/opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/apksigner sign \
  --ks android.keystore \
  --ks-key-alias android \
  --ks-pass pass:carromscore-changeit \
  --key-pass pass:carromscore-changeit \
  --out carromscore-vX.Y.Z.apk \
  app/build/outputs/apk/release/app-release-unsigned.apk
/opt/homebrew/share/android-commandlinetools/build-tools/34.0.0/apksigner verify \
  --verbose carromscore-vX.Y.Z.apk | grep -E 'Verifies|scheme'
shasum -a 256 carromscore-vX.Y.Z.apk

# 5. Publish release
cd ..
gh release create vX.Y.Z \
  --title "Carromscore vX.Y.Z" \
  --notes "…notes + SHA-256…" \
  twa/carromscore-vX.Y.Z.apk
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
