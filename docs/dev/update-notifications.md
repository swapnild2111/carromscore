# Update notifications

Carromscore has two distinct update signals: a **soft toast** when the
service worker installs a new bundle, and a **sharp banner** when the
native wrapper itself needs to be reinstalled. Users almost always see
the toast; the banner is reserved for the rare wrapper-level release.

## The soft toast

When the service worker fetches a new bundle in the background (and
takes over as the controller), `BaseLayout.astro` dispatches a
`carrom:sw-updated` event on `window`.

`MatchSetup.svelte` listens for it and shows this:

> ✨ **Carromscore just updated.** Tap to restart and see the latest.

Tapping the toast reloads the page, at which point the fresh code
takes over.

## The sharp banner

When the setup screen mounts, it calls `fetchLatestRelease()` in
`src/lib/version.ts`. That fetches the latest GitHub Release and
parses two HTML-comment markers from the body:

```markdown
<!-- apk-required: true -->
<!-- apk-required-reason: Icon and orientation changed. -->
```

If `apk-required: true` **and** the latest release tag is newer than
the running `APP_VERSION`, the setup screen shows an amber-red banner:

> ⚠ **New Android version required**
> v1.7.9 → v1.8.0 · Tap to download the new APK
> *Why: Icon and orientation changed.*

Tapping the banner opens the GitHub Release page.

**Missing marker → assumed `apk-required: false`.** The safe default:
history shows most releases don't need an APK rebuild.

## Why two signals?

Because the app is a TWA (Trusted Web Activity), the vast majority of
releases are pure web-layer changes that update automatically. Signal
inflation on those would train users to ignore the banner when a real
APK-required release finally does happen. Two distinct visual weights
(soft gold pill vs sharp amber banner) let users learn *"gold pill =
harmless refresh, amber banner = time to reinstall."*

## Adding markers to a release

In `twa/release-notes-vX.Y.Z.md`, add the marker anywhere in the body
(convention: near the bottom, after the changelog):

```markdown
<!-- apk-required: false -->
```

The GitHub Releases workflow publishes the release body verbatim via
`gh release edit --notes-file`, so the markers travel through
untouched. See [deployment.md](./deployment.md) for the full flow.

## Testing

- **Toast**: In DevTools console on the setup page,
  `window.dispatchEvent(new CustomEvent('carrom:sw-updated'))`.
- **Banner**: Intercept the GitHub API request in DevTools' Local
  Overrides (or via a Playwright `page.route()` mock) and return
  `{"tag_name":"v9.9.9","body":"<!-- apk-required: true -->\n<!-- apk-required-reason: test -->"}`
  → reload.

## Related

- [Deployment](./deployment.md)
- [Local development](./local-development.md)
