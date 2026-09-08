# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile

# ---------------------------------------------------------------------------
# JNI bridge between Rust (src-tauri/src/notify.rs) and Kotlin.
# These members are reached only over JNI, so R8 sees no bytecode call sites
# and would strip/rename them in minified release builds — which silently
# breaks download notifications, status-bar theming and launch-intent handling.
# Keep them by exact name/signature.
# ---------------------------------------------------------------------------

# Rust -> Kotlin: DownloadNotifier.update(...) / cancel(...) called via JNI.
-keep class com.leaflet.reader.DownloadNotifier { *; }

# Rust -> Kotlin: MainActivity.setBarAppearance(...) (static) and the static
# pendingLaunchIntent field, both accessed via JNI. (The class itself is kept
# by the manifest; only its JNI-touched members need pinning.)
#
# The signature below MUST mirror the one in MainActivity.kt and the JNI
# descriptor in notify.rs (`(Landroid/app/Activity;ZI)V`). These rules match by
# exact signature, so widening the method without editing here compiles and
# runs fine in debug, then dies only in release: R8 strips the now-unmatched
# method, the JNI lookup throws, and the process aborts on the next JNI call.
-keepclassmembers class com.leaflet.reader.MainActivity {
    public static void setBarAppearance(android.app.Activity, boolean, int);
    public static void setImmersiveMode(android.app.Activity, boolean);
    static java.lang.String pendingLaunchIntent;
    static java.lang.String pendingOpenUri;
}

# Kotlin -> Rust: native method invoked from MainActivity.onCreate to bootstrap
# ndk_context (also covered by the default native-methods rule; explicit here).
-keepclasseswithmembernames class com.leaflet.reader.MainActivity {
    native <methods>;
}

# Rust -> Kotlin: TaskService.start(Context) / stop(Context), the @JvmStatic
# companion methods that drive the foreground keep-alive service. The class
# itself survives via the manifest's <service> entry, but these two statics have
# no bytecode call sites — JS -> Rust -> JNI is their only caller — so R8 pruned
# them from release builds. Every download then died on
# `NoSuchMethodError: no static method "...TaskService;.start(...)"`, which took
# the whole process with it.
#
# Signatures MUST mirror the JNI descriptor in notify.rs
# (`(Landroid/content/Context;)V`); see the MainActivity note above.
-keepclassmembers class com.leaflet.reader.TaskService {
    public static void start(android.content.Context);
    public static void stop(android.content.Context);
}
