# Setup

## Prerequisites

| Tool | Minimum version | Why |
| --- | --- | --- |
| Node | 18 | Vite 5 baseline |
| Rust | 1.75 (stable) | Tauri v2 baseline |
| `tauri-cli` | 2.x | Pulled in as a dev dep — `npx tauri` works |

Platform extras (Tauri v2 guide covers this in more depth):

- **Linux**: `libwebkit2gtk-4.1-dev`, `libsoup-3.0-dev`, `libjavascriptcoregtk-4.1-dev`, `libappindicator3-dev`.
- **macOS**: Xcode Command Line Tools.
- **Windows**: Microsoft Edge WebView2 Runtime (usually preinstalled on Win 11), Visual Studio 2022 Build Tools with "Desktop development with C++".
- **Android**: see `ANDROID.md` — JDK 17, Android Studio (SDK + NDK), `ANDROID_HOME`, `NDK_HOME`.

## First-time install

This project uses **pnpm** (see `tauri.conf.json`'s `beforeDevCommand`). If you prefer npm or bun, swap `pnpm` below — just make sure `tauri.conf.json`'s before-command matches.

```bash
cd Leaflet-ebook-reader
pnpm install
```

## Desktop dev

```bash
pnpm tauri dev
```

The app opens against Vite's dev server at `http://localhost:1420`. HMR is live for the React side; the Rust side rebuilds automatically on save.

## Production desktop build

```bash
pnpm tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`:
- `.dmg` / `.app` on macOS
- `.msi` / `.exe` on Windows
- `.deb` / `.AppImage` / `.rpm` on Linux

## Android

See `ANDROID.md`. Quick version:

```bash
pnpm tauri android init      # one time
pnpm tauri android dev       # run on emulator / attached device
pnpm tauri android build     # AAB/APK in src-tauri/gen/android/app/build/outputs
```

## Icons

Placeholder PNGs are referenced in `src-tauri/tauri.conf.json`. Once you have a real leaf mark ready:

```bash
pnpm tauri icon path/to/leaf-1024.png
```

That regenerates every platform-specific icon size automatically.

## Troubleshooting

- **Blank window on desktop**: Vite port mismatch — check `tauri.conf.json` `build.devUrl` matches `vite.config.ts`'s `server.port`.
- **`webview_version` error on Linux**: install `libwebkit2gtk-4.1-dev` (the `-4.0` variant is for Tauri v1 only).
- **Android build "SDK not found"**: `ANDROID_HOME` must be exported *in the same shell* you run `npm run` in. In `~/.bashrc`:
  ```bash
  export ANDROID_HOME="$HOME/Android/Sdk"
  export NDK_HOME="$ANDROID_HOME/ndk/$(ls $ANDROID_HOME/ndk | sort -V | tail -1)"
  export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
  ```
