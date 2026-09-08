#!/usr/bin/env bash
#
# Prove the Rust->Kotlin JNI bridge survived R8 in a *release* (minified) APK.
#
# Why this exists. Every member listed below is reached ONLY over JNI from
# src-tauri/src/notify.rs. R8 sees no bytecode call site for any of them, so
# without an exact-signature -keep rule in gen/android/app/proguard-rules.pro it
# prunes them from release builds. Debug builds (isMinifyEnabled = false) stay
# green, so the breakage ships silently and only shows up on a real device as
#
#     java.lang.NoSuchMethodError: no static method "L<class>;.<name>(<sig>)V"
#
# which kills the process. That is exactly how downloading a chapter, a volume
# or a range came to close the app.
#
# Usage:  bash scripts/verify-jni-bridge.sh [path/to/app-release.apk]
# Default: the newest release APK under gen/android/app/build/outputs/apk/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APK_DIR="$ROOT/src-tauri/gen/android/app/build/outputs/apk"

APK="${1:-}"
if [ -z "$APK" ]; then
  APK="$(find "$APK_DIR" -path '*/release/*.apk' ! -name '*unsigned*' -print0 2>/dev/null \
         | xargs -0 ls -t 2>/dev/null | head -1)"
fi

if [ -z "$APK" ] || [ ! -f "$APK" ]; then
  echo "verify-jni-bridge: no release APK found under $APK_DIR" >&2
  echo "  build one first:  pnpm android:build" >&2
  exit 2
fi

# apkanalyzer ships with the Android command-line tools.
APKANALYZER="$(command -v apkanalyzer || true)"
for c in "$ANDROID_HOME/cmdline-tools/latest/bin/apkanalyzer" \
         "/opt/homebrew/share/android-commandlinetools/cmdline-tools/latest/bin/apkanalyzer" \
         "$HOME/Library/Android/sdk/cmdline-tools/latest/bin/apkanalyzer"; do
  [ -n "$APKANALYZER" ] && break
  [ -x "$c" ] && APKANALYZER="$c"
done
if [ -z "$APKANALYZER" ]; then
  echo "verify-jni-bridge: apkanalyzer not found (part of the Android cmdline-tools)." >&2
  exit 2
fi

echo "verify-jni-bridge: inspecting $(basename "$APK")"
DEX="$("$APKANALYZER" dex packages --defined-only "$APK" 2>/dev/null)"
if [ -z "$DEX" ]; then
  echo "verify-jni-bridge: apkanalyzer produced no dex listing for $APK" >&2
  exit 2
fi

# Each entry mirrors a JNI lookup in src-tauri/src/notify.rs. Keep the two in
# sync: adding a Rust->Kotlin call means adding a line here AND a -keep rule.
EXPECTED=(
  "com.leaflet.reader.TaskService void start(android.content.Context)"
  "com.leaflet.reader.TaskService void stop(android.content.Context)"
  "com.leaflet.reader.MainActivity void setBarAppearance(android.app.Activity,boolean,int)"
  "com.leaflet.reader.MainActivity void setImmersiveMode(android.app.Activity,boolean)"
  "com.leaflet.reader.MainActivity java.lang.String pendingLaunchIntent"
  "com.leaflet.reader.MainActivity java.lang.String pendingOpenUri"
  "com.leaflet.reader.DownloadNotifier void update(android.content.Context,int,java.lang.String,java.lang.String,int,int,boolean,boolean,boolean)"
  "com.leaflet.reader.DownloadNotifier void cancel(android.content.Context,int)"
)

FAILED=0
for want in "${EXPECTED[@]}"; do
  if grep -qF -- "$want" <<<"$DEX"; then
    echo "  ok      $want"
  else
    echo "  STRIPPED $want" >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  cat >&2 <<'MSG'

verify-jni-bridge: FAILED — R8 removed or renamed a JNI-reached member.
Add or correct an exact-signature -keep rule in
  src-tauri/gen/android/app/proguard-rules.pro
so the Kotlin signature, the JNI descriptor in src-tauri/src/notify.rs, and the
keep rule all agree, then rebuild.
MSG
  exit 1
fi

echo "verify-jni-bridge: all ${#EXPECTED[@]} JNI members survived R8"
