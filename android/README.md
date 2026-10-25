# Stormcoder Remote for Android

An Android app that wraps the phone app (`openvs-relay/pwa`) with [Capacitor](https://capacitorjs.com).
It is optional and self-contained: the desktop app, the relay and the root `npm` scripts do not
depend on this folder, and nothing outside it imports it.

## Why

The phone app is normally delivered by the relay, so a malicious relay could serve a modified copy
that steals the end-to-end keys (`docs/REMOTE-E2E.md`). Here the app's code is fixed inside the APK
you build, so the relay only routes sealed messages.

## How it is organised

| Path | What it is |
|---|---|
| `scripts/build-web.mjs` | Copies the PWA into `www/`: every file byte for byte, except `index.html`, which gets a strict Content-Security-Policy and the shim. The service worker, install metadata and cache headers are left out. |
| `src/native.js` | The only Android-specific code the app sees. Inside the shell it defines `globalThis.StormcoderNative` (`platform`, `scanQr()`). Outside it does nothing. |
| `capacitor.config.json` | App id `dev.stormcoder.remote`, bundled assets, HTTPS only, native HTTP enabled. |
| `android/` | The generated Android Studio project (Gradle). Edit it by hand only for manifest or build settings; `allowBackup` is off and cleartext traffic is off. |
| `assets/` | The icon source (`icon.svg`, and `icon-foreground.svg` for the adaptive icon). The launcher icons in `android/app/src/main/res/mipmap-*` are drawn from them; the launch screen is the app's own ground with the mark (`values/styles.xml`, light and `values-night` dark). |
| `www/` | Build output, not committed. |

The shared phone app has one small seam for all this (`native` in `openvs-relay/pwa/app.js`). When
`StormcoderNative` is absent the app behaves exactly as the PWA. In the shell it learns the relay's
address from the pairing link, stores it with the device, and skips the service worker (there is
no Web Push in the app).

Cross-origin calls to the relay: the app runs on `https://localhost` and the relay is elsewhere. The
relays send no CORS headers (and should not), so `CapacitorHttp` is enabled and sends the pairing
request natively. WebSockets are not subject to CORS.

## Build

Needs Node 20+, JDK 21 and the Android SDK (Android Studio installs them).

```
cd android
npm install
npm run web            # builds www/
npx cap sync android   # copies www/ and plugins into the Android project
npm run open           # opens Android Studio
npm run build:debug    # or, from the command line: android/app/build/outputs/apk/debug/
```

`npm run build:release` makes a Play Store bundle; sign it with your own key (never commit it).

## In the app

- **Back button:** closes History or the slash menu first, and sends the app to the background from a plain screen (`stormcoder:back` in `src/native.js` and `app.js`).
- **System bars:** Capacitor's `SystemBars` handles the edge-to-edge insets (`insetsHandling: css`); the app's own padding uses `env(safe-area-inset-*)`.
- **Scanner failures:** if Google Play Services is missing or the scanner module is still downloading, the app says so and the pasted link still works.
- **Header:** shows the connection and the desktop's folder name ("Connected · project"), which the desktop sends in its encrypted `config` message.

## Pairing

Open the app and tap **Scan QR code** (Google's code scanner: it needs Google Play Services and fetches its own module on first use), or paste the pairing link from
the desktop. Only `https` links are accepted. A bare key cannot work, because it does not say where
the relay is.

## Tests and limits

- `scripts/test-android-web.mjs` (in `npm test`) checks the bundle is the reviewed PWA plus the shim
  with a strict policy, and that this folder stays separate.
- `test/android-shell.mjs` (in `npm test`) runs the bundle in a phone-sized browser against a TLS
  relay on another origin with the real desktop encryption: scanning, pairing, sealed traffic,
  remembered relay, reopen, unpair.
- **Not covered by any test in this repository:** the Gradle build, the APK, the camera scanner and
  `CapacitorHttp` on a real device. Run a debug build and pair once before relying on it.
- No push notifications yet (they need Firebase Cloud Messaging and a sender on the relay).
- Keys live in the WebView's storage, not the hardware keystore.
- Updating the app means installing a new APK; it does not update itself from the relay.
