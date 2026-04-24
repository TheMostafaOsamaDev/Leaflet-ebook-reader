# Android

Tauri v2 has first-class Android support. The app's frontend is the same bundle as desktop; the shell is a native `Activity` hosting the system WebView.

## One-time environment

1. Install Android Studio. Use its SDK Manager to install:
   - Android SDK Platform 34 (or later)
   - Android SDK Build-Tools
   - NDK (side by side) — latest LTS
   - CMake
2. Accept the SDK licenses:
   ```bash
   $ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager --licenses
   ```
3. Ensure JDK 17 is the default `java` — Tauri will reject 21.
   ```bash
   java -version
   ```
4. Export env vars (see SETUP.md snippet).

## Rust Android targets

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

## Init the Android project

From the project root:

```bash
pnpm tauri android init
```

This generates `src-tauri/gen/android/` with a Gradle project. Commit this folder — it's the Android analogue of `src-tauri/`.

## Dev loop

With an emulator running or a device plugged in with USB debugging on:

```bash
pnpm tauri android dev
```

First run is slow (Gradle + NDK). Subsequent runs are a normal Vite HMR loop.

## Release build

```bash
pnpm tauri android build
```

Outputs:
- `src-tauri/gen/android/app/build/outputs/apk/release/app-release.apk`
- `src-tauri/gen/android/app/build/outputs/bundle/release/app-release.aab` (for Play Store)

You'll need to sign release builds. Tauri honours `keystore.properties` in `src-tauri/gen/android/` — see the Tauri mobile docs.

## Permissions

Leaflet needs read access to pick EPUBs:

- `android.permission.READ_EXTERNAL_STORAGE` is **not** required — we use the system file picker via `@tauri-apps/plugin-dialog`, which grants scoped access.
- No network permission is declared, because we don't fetch anything.

The manifest template at `src-tauri/gen/android/app/src/main/AndroidManifest.xml` is generated on init — don't edit it before `init` runs.

## Known rough edges

- **EPUB swipe vs. system back gesture**: on gesture-nav devices, horizontal swipe from the edge triggers Android's back. We mitigate by setting `android:windowLayoutInDisplayCutoutMode="shortEdges"` and wiring touch listeners inside a safe inset. See `Reader.tsx`.
- **WebView updates**: users on old Android WebView may see layout glitches with epub.js. We target WebView 90+ which covers ~95% of devices; older users get a friendly notice.
- **Large EPUB import**: Android intents cap at ~1MB for `content://` returns on some OEMs; Tauri's dialog plugin streams the file instead. No extra work needed.
