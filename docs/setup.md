# Setup

Leaflet is a Tauri v2 + React 19 + TypeScript + Vite app targeting **desktop
(Linux / macOS / Windows)** and **Android**.

## Prerequisites

### Desktop (all platforms)

1. **Node.js 20+** and **pnpm 9+** — this repo uses pnpm as the package
   manager (matches how the project was scaffolded).
2. **Rust stable** with the host target installed. If you installed Rust via
   your distro's package manager (e.g. `pacman -S rust` on Arch/CachyOS), you
   already have the host target — that's all desktop builds need.
3. Platform-specific Tauri system deps, per
   <https://tauri.app/start/prerequisites/>:
   - **Linux**: `webkit2gtk-4.1`, `libappindicator-gtk3`, `librsvg2`,
     `patchelf`, and a working GTK stack.
   - **macOS**: Xcode command-line tools.
   - **Windows**: WebView2 runtime (ships with Windows 11) + MSVC build
     tools.

### Android (additional)

Android builds need a richer toolchain than desktop:

1. **rustup** (not just distro rust). The rustup multi-target story is what
   Tauri's Android build uses; distro rust doesn't support adding Android
   targets. Install from <https://rustup.rs>.
2. **Android SDK + Platform Tools + Build Tools** (API 33+ recommended).
   Easiest via Android Studio → SDK Manager.
3. **Android NDK** (25+). Install via the SDK Manager → "NDK (Side by side)".
4. **Java 17 JDK** (Tauri's Android project uses Gradle 8+, which needs 17).
5. Export these env vars in your shell (e.g. in `~/.zshrc`):
   ```sh
   export ANDROID_HOME="$HOME/Android/Sdk"
   export NDK_HOME="$ANDROID_HOME/ndk/<version>"
   export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
   ```
6. Add the four Android Rust targets:
   ```sh
   rustup target add aarch64-linux-android armv7-linux-androideabi \
                     i686-linux-android    x86_64-linux-android
   ```

## First-time setup

```sh
# From the repo root:
pnpm install
```

## Run — desktop

```sh
pnpm tauri dev          # hot-reloading dev window
pnpm tauri build        # production bundle (DMG / MSI / AppImage / deb)
```

## Run — Android

```sh
# One-time, inside the repo:
pnpm tauri android init

# Then either connect a device / start an emulator, and:
pnpm tauri android dev

# For a release APK:
pnpm tauri android build
```

`android init` writes `src-tauri/gen/android/` into the repo. Don't commit
build artifacts under it (`.gradle/`, `build/`, `app/build/`) — `.gitignore`
is configured accordingly.

## Fallback: run the UI in a plain browser

The UI is pure web, so you can iterate on the design without the Tauri
native shell:

```sh
pnpm dev        # Vite dev server at http://localhost:1420
pnpm build      # static bundle in dist/
```

This is often faster than `pnpm tauri dev` when you're just tweaking
typography / colors.

## Troubleshooting

- **`cargo check` hangs on Linux** — it's blocked on `webkit2gtk-4.1`
  link flags. Install the distro's `webkit2gtk-4.1` dev package.
- **Android build complains `rustup` not found** — distro rust isn't
  sufficient for Android cross-compilation; install rustup per above.
- **Theme flash on startup** — the selected theme is persisted in
  `localStorage` under `leaflet:tweaks:v1` and applied on first paint via a
  `useEffect` in `App.tsx`. If you clear storage you'll briefly see the sepia
  default.
