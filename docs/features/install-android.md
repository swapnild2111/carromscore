# Install on Android

Carromscore installs as a real Android app from a downloadable APK.
No Play Store account needed, no store review, no in-app purchases.

## Steps

1. On your Android phone, open the **[latest release page][releases]**.
2. Under **Assets**, download the latest `carromscore-*.apk` file.
3. Tap the downloaded file. Android will ask for **"Install unknown
   apps"** permission for your browser once — accept it. This is a
   one-time step per browser; you won't be asked again.
4. Confirm the install. **Carromscore** appears on your home screen.

Tap the icon and you're in.

## Updates

**Most updates arrive automatically.** The app is a thin wrapper around
the live website, so any code change ships to your phone the next time
you open it — no download needed.

You'll see a small toast on the setup screen the first time you launch
after an update: **"✨ Carromscore just updated — tap to restart"**.
Tap it once and you're on the latest version.

The rare exception is a wrapper-level change (icon, orientation, target
Android SDK). When that happens, the setup screen shows a **"New
Android version required"** banner in amber-red. Tap it to download
the new APK from the releases page.

## Uninstalling

Long-press the icon → tap uninstall. All your match state is stored
inside the app and disappears with it.

## Why not Play Store?

Distributing via GitHub Releases keeps the project fully open, free of
Play Store fees, and free of the review cycle that would slow down
iteration. The trade-off is the one-time "install unknown apps" step on
Android — a real friction step, but familiar to anyone who's sideloaded
before. On modern Android (8+) it's a per-source permission, not a
global unlock, so it's safe.

## Troubleshooting

**"Play Protect scanned this app and can't verify it's safe"** —
Google's default warning for any non-Play-Store install. The APK is
signed with a stable keystore fingerprint and doesn't request any
sensitive permissions (no location, no contacts, no camera). Tap
**Install anyway** to continue.

**"App not installed as a package"** — usually means an older
Carromscore install is signed with a *different* keystore than the new
one you're trying to install. This can happen if you had a pre-release
version. Uninstall the existing Carromscore first, then install the
new APK.

## Related

- [Install on iPhone](./install-iphone.md).
- [Keeping the score](./keeping-the-score.md).

[releases]: https://github.com/swapnild2111/carromscore/releases/latest
