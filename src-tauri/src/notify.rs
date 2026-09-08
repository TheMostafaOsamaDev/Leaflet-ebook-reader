// Bridge from the frontend to the Android-side DownloadNotifier class.
// Two commands:
//
//   update_download_notification — set / update the running download
//     notification. Calls into Kotlin via JNI on Android. No-op on
//     other platforms (frontend's transport layer doesn't call this
//     command on non-Android anyway, so the no-op is just a safety
//     net).
//
//   consume_launch_intent — drain the launch-intent extra stashed by
//     MainActivity. Returns Some("queue") or None. Used by the
//     frontend's useLaunchIntent hook on mount.
//
// Both commands are infallible from the frontend's perspective in the
// sense that they always return a Result; the frontend can log a
// warning and continue.

use tauri::AppHandle;

#[cfg(target_os = "android")]
use jni::objects::{JObject, JValue};
#[cfg(target_os = "android")]
use jni::sys::{jboolean, jint, JNI_FALSE, JNI_TRUE};

/// Update the download-progress notification. Parameters mirror
/// `DownloadNotifier.update(...)` on the Android side.
#[tauri::command]
pub async fn update_download_notification(
    app: AppHandle,
    id: i32,
    title: String,
    body: String,
    progress: i32,
    max: i32,
    indeterminate: bool,
    ongoing: bool,
    taps_to_queue: bool,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_call_update(
            &app, id, title, body, progress, max, indeterminate, ongoing,
            taps_to_queue,
        )
        .map_err(|e| format!("android notify failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        // No-op on non-Android. The frontend's transport falls back to
        // the Tauri notification plugin before invoking this command,
        // so this branch should be unreachable in practice. Keep the
        // command registered for symmetric capability declarations.
        let _ = (
            app, id, title, body, progress, max, indeterminate, ongoing,
            taps_to_queue,
        );
        Ok(())
    }
}

/// Match the native window chrome to the in-app reading theme, which is
/// independent of the OS DayNight setting.
///
/// `dark_icons = true` paints dark status/navigation-bar icons for a light
/// theme (sepia / light); `false` paints light icons for a dark theme
/// (dark / oled).
///
/// `background` is the theme's `bg` as `#rrggbb`. MainActivity stashes it and
/// paints it as the window background on the NEXT cold launch — that window is
/// what fills the screen between the launcher handing off and the webview's
/// first frame, and without this it is the Material DayNight default (near
/// black on a dark OS), which is the black flash users see at startup.
///
/// No-op on non-Android.
#[tauri::command]
pub async fn set_status_bar_style(
    app: AppHandle,
    dark_icons: bool,
    background: String,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let argb = parse_hex_rgb(&background)
            .ok_or_else(|| format!("bad background colour: {background}"))?;
        android_set_bar_appearance(&app, dark_icons, argb)
            .map_err(|e| format!("android status bar failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, dark_icons, background);
        Ok(())
    }
}

/// Hide or restore Android's status and navigation bars, for the reader's
/// full-screen mode.
///
/// The app draws edge-to-edge, so the system bars are painted over the reader
/// rather than beside it. When the reader tapped its own chrome away the bars
/// stayed put, leaving the clock and battery icons on top of the first line of
/// the page. Hiding them with the chrome is what makes full screen full.
///
/// The bars return on an edge swipe (transient) and whenever the reader brings
/// its chrome back, so nothing is ever unreachable.
///
/// No-op on non-Android.
#[tauri::command]
pub async fn set_immersive_mode(app: AppHandle, immersive: bool) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        android_set_immersive_mode(&app, immersive)
            .map_err(|e| format!("android immersive mode failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, immersive);
        Ok(())
    }
}

/// `#rrggbb` → opaque ARGB, as the `jint` Android's `ColorDrawable` wants.
/// Returns None for anything that isn't exactly six hex digits behind a `#`,
/// so a malformed value leaves the previously stashed colour alone rather
/// than painting the launch window some arbitrary shade.
#[cfg(target_os = "android")]
fn parse_hex_rgb(hex: &str) -> Option<jint> {
    let digits = hex.strip_prefix('#')?;
    if digits.len() != 6 {
        return None;
    }
    let rgb = u32::from_str_radix(digits, 16).ok()?;
    // Widen through u32 and reinterpret: 0xff000000 | rgb overflows i32's
    // positive range, and `as` on the u32 is the defined two's-complement
    // reinterpretation Android expects for a colour int.
    Some((0xff00_0000_u32 | rgb) as jint)
}

/// Start the Android foreground TaskService (keeps the process/webview
/// alive while background work runs). No-op on non-Android.
#[tauri::command]
pub async fn start_task_service(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app;
        android_task_service("start").map_err(|e| format!("start service failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Stop the Android foreground TaskService. No-op on non-Android.
#[tauri::command]
pub async fn stop_task_service(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let _ = &app;
        android_task_service("stop").map_err(|e| format!("stop service failed: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// Drain the pending launch-intent extra. Returns `Some(extra)` once,
/// then `None` until the next intent arrives. Used by the frontend
/// `useLaunchIntent` hook on mount.
#[tauri::command]
pub async fn consume_launch_intent(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        return Ok(android_consume_intent(&app).ok());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Drain the book URI stashed by MainActivity when another app asked us to
/// open a file ("Open with" or the share sheet). Returns the `content://`
/// or `file://` URI, or None.
#[tauri::command]
pub async fn consume_open_uri(app: AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        return Ok(android_consume_open_uri(&app).ok());
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

/// Look up an app class via the activity's classloader. JNI-attached
/// Rust threads default to the **system** classloader, which only
/// resolves Android framework classes — `env.find_class("com/.../MainActivity")`
/// hits `ClassNotFoundException`. Going through the activity's loader
/// (which is the app's `PathClassLoader`) is the standard workaround.
///
/// `dot_name` must be dot-separated (e.g. `"com.leaflet.reader.MainActivity"`)
/// because `ClassLoader.loadClass` takes a binary name, not a JNI signature.
#[cfg(target_os = "android")]
fn find_app_class<'local>(
    env: &mut jni::JNIEnv<'local>,
    activity: &JObject<'local>,
    dot_name: &str,
) -> Result<jni::objects::JClass<'local>, Box<dyn std::error::Error>> {
    let loader = env
        .call_method(activity, "getClassLoader", "()Ljava/lang/ClassLoader;", &[])?
        .l()?;
    let name_j = env.new_string(dot_name)?;
    let class_obj = env
        .call_method(
            &loader,
            "loadClass",
            "(Ljava/lang/String;)Ljava/lang/Class;",
            &[JValue::Object(&name_j)],
        )?
        .l()?;
    Ok(jni::objects::JClass::from(class_obj))
}

/// Drain any Java exception left pending on this thread.
///
/// A failed JNI call (missing method, wrong descriptor, a Java-side throw)
/// raises its exception and leaves it **armed** on the attached thread. The
/// `jni` crate reports the failure as a plain `Err`, but the exception is still
/// there — and when the thread detaches, ART reports it as an uncaught
/// `FATAL EXCEPTION` and kills the whole process. That is how a recoverable
/// bridge failure turns into "the app just closed" with no dialog.
///
/// Draining here downgrades every such failure to an ordinary `Err`, which the
/// commands map to a `String` and the frontend already catches (see
/// `syncService` in src/store/backgroundTasks.ts, which simply logs and keeps
/// downloading without the keep-alive service).
///
/// `ExceptionCheck` / `Describe` / `Clear` are the JNI calls that are legal
/// while an exception is pending, so this is safe to call unconditionally.
#[cfg(target_os = "android")]
fn drain_pending_exception(env: &mut jni::JNIEnv<'_>) {
    if let Ok(true) = env.exception_check() {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
}

/// Resolve an app class through the activity's classloader and invoke one of
/// its `void` statics. Every Rust->Kotlin call in this module goes through
/// here so they share one failure shape; callers pair it with
/// [`drain_pending_exception`].
#[cfg(target_os = "android")]
fn call_app_static_void<'local>(
    env: &mut jni::JNIEnv<'local>,
    activity: &JObject<'local>,
    class_name: &str,
    method: &str,
    sig: &str,
    args: &[JValue<'_, '_>],
) -> Result<(), Box<dyn std::error::Error>> {
    let class = find_app_class(env, activity, class_name)?;
    env.call_static_method(&class, method, sig, args)?;
    Ok(())
}

#[cfg(target_os = "android")]
fn android_call_update(
    _app: &AppHandle,
    id: i32,
    title: String,
    body: String,
    progress: i32,
    max: i32,
    indeterminate: bool,
    ongoing: bool,
    taps_to_queue: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity =
        unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    let title_j = env.new_string(title)?;
    let body_j = env.new_string(body)?;

    let res = call_app_static_void(
        &mut env,
        &activity,
        "com.leaflet.reader.DownloadNotifier",
        "update",
        "(Landroid/content/Context;ILjava/lang/String;Ljava/lang/String;IIZZZ)V",
        &[
            JValue::Object(&activity),
            JValue::Int(id as jint),
            JValue::Object(&title_j),
            JValue::Object(&body_j),
            JValue::Int(progress as jint),
            JValue::Int(max as jint),
            JValue::Bool(if indeterminate { JNI_TRUE } else { JNI_FALSE } as jboolean),
            JValue::Bool(if ongoing { JNI_TRUE } else { JNI_FALSE } as jboolean),
            JValue::Bool(if taps_to_queue { JNI_TRUE } else { JNI_FALSE } as jboolean),
        ],
    );
    // A missing/renamed notifier method must not take the process down with it.
    drain_pending_exception(&mut env);
    res
}

#[cfg(target_os = "android")]
fn android_task_service(op: &str) -> Result<(), Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity = unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    let method = if op == "stop" { "stop" } else { "start" };
    // The descriptor here, TaskService.kt's @JvmStatic companion methods, and
    // the -keep rule in gen/android/app/proguard-rules.pro have to agree.
    // When they didn't, R8 pruned start/stop from release builds and this
    // lookup threw NoSuchMethodError — which, left pending, killed the app the
    // moment any download was queued.
    let res = call_app_static_void(
        &mut env,
        &activity,
        "com.leaflet.reader.TaskService",
        method,
        "(Landroid/content/Context;)V",
        &[JValue::Object(&activity)],
    );
    // Losing the keep-alive service is survivable — downloads still run while
    // the app is foregrounded. Dying is not. Clear before returning.
    drain_pending_exception(&mut env);
    res
}

#[cfg(target_os = "android")]
fn android_set_bar_appearance(
    _app: &AppHandle,
    dark_icons: bool,
    background: jint,
) -> Result<(), Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity =
        unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    // Kotlin's `lightIcons` flag means "light (white) icons for a dark
    // background" — the inverse of our `dark_icons`. The Activity passed
    // in IS the MainActivity instance (ndk_context's context()), so we
    // hand it straight to the static method.
    let light_icons = !dark_icons;
    // The descriptor here, the Kotlin signature, and the -keep rule in
    // gen/android/app/proguard-rules.pro have to agree. When they don't, R8
    // strips the method out of release builds and this lookup throws.
    let res = call_app_static_void(
        &mut env,
        &activity,
        "com.leaflet.reader.MainActivity",
        "setBarAppearance",
        "(Landroid/app/Activity;ZI)V",
        &[
            JValue::Object(&activity),
            JValue::Bool(if light_icons { JNI_TRUE } else { JNI_FALSE } as jboolean),
            JValue::Int(background),
        ],
    );
    // Keeps a signature mismatch to what it should be — the bars just don't
    // get restyled.
    drain_pending_exception(&mut env);
    res
}

#[cfg(target_os = "android")]
fn android_set_immersive_mode(
    _app: &AppHandle,
    immersive: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity =
        unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    // Same three-way agreement as android_set_bar_appearance: the descriptor
    // here, the Kotlin signature, and the -keep rule in
    // gen/android/app/proguard-rules.pro. When they drift, R8 strips the method
    // from release builds and this lookup throws — debug builds stay fine,
    // which is what makes the mismatch easy to ship.
    let res = call_app_static_void(
        &mut env,
        &activity,
        "com.leaflet.reader.MainActivity",
        "setImmersiveMode",
        "(Landroid/app/Activity;Z)V",
        &[
            JValue::Object(&activity),
            JValue::Bool(if immersive { JNI_TRUE } else { JNI_FALSE } as jboolean),
        ],
    );
    // A stripped or renamed method means the system bars simply stay as they
    // are — full screen keeps the reader's own chrome hidden and nothing
    // crashes.
    drain_pending_exception(&mut env);
    res
}

#[cfg(target_os = "android")]
fn android_consume_intent(_app: &AppHandle) -> Result<String, Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity =
        unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    let res = read_pending_intent(&mut env, &activity);
    // Same rule as everywhere else in this module: a field lookup that R8
    // renamed away must degrade to "no launch intent", not to a dead process.
    drain_pending_exception(&mut env);
    res
}

/// Field-access half of [`android_consume_intent`], split out so the caller can
/// drain a pending exception on every exit path.
#[cfg(target_os = "android")]
fn read_pending_intent<'local>(
    env: &mut jni::JNIEnv<'local>,
    activity: &JObject<'local>,
) -> Result<String, Box<dyn std::error::Error>> {
    let class = find_app_class(env, activity, "com.leaflet.reader.MainActivity")?;
    let value = env.get_static_field(&class, "pendingLaunchIntent", "Ljava/lang/String;")?;
    let obj: JObject = value.l()?;

    if obj.is_null() {
        return Err("no pending intent".into());
    }

    let jstr: jni::objects::JString = obj.into();
    let rust_str: String = env.get_string(&jstr)?.into();

    // Clear so subsequent calls return None. `set_static_field` in jni
    // 0.21 expects a `JStaticFieldID`, not a (name, sig) tuple — look
    // up the field id explicitly here.
    let field_id =
        env.get_static_field_id(&class, "pendingLaunchIntent", "Ljava/lang/String;")?;
    env.set_static_field(&class, field_id, JValue::Object(&JObject::null()))?;

    Ok(rust_str)
}

#[cfg(target_os = "android")]
fn android_consume_open_uri(
    _app: &AppHandle,
) -> Result<String, Box<dyn std::error::Error>> {
    let ctx = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity =
        unsafe { JObject::from_raw(ctx.context() as jni::sys::jobject) };

    let res = read_pending_open_uri(&mut env, &activity);
    // Same rule as everywhere else in this module: a field lookup R8
    // renamed away must degrade to "no pending file", not a dead process.
    drain_pending_exception(&mut env);
    res
}

/// Field-access half of [`android_consume_open_uri`], split out so the
/// caller can drain a pending exception on every exit path.
#[cfg(target_os = "android")]
fn read_pending_open_uri<'local>(
    env: &mut jni::JNIEnv<'local>,
    activity: &JObject<'local>,
) -> Result<String, Box<dyn std::error::Error>> {
    let class = find_app_class(env, activity, "com.leaflet.reader.MainActivity")?;
    let value = env.get_static_field(&class, "pendingOpenUri", "Ljava/lang/String;")?;
    let obj: JObject = value.l()?;

    if obj.is_null() {
        return Err("no pending open uri".into());
    }

    let jstr: jni::objects::JString = obj.into();
    let rust_str: String = env.get_string(&jstr)?.into();

    // Clear so subsequent calls return None. `set_static_field` in jni
    // 0.21 expects a `JStaticFieldID`, not a (name, sig) tuple — look up
    // the field id explicitly here.
    let field_id =
        env.get_static_field_id(&class, "pendingOpenUri", "Ljava/lang/String;")?;
    env.set_static_field(&class, field_id, JValue::Object(&JObject::null()))?;

    Ok(rust_str)
}

/// Bridge the Android Activity into `ndk_context`'s global so the JNI helpers
/// above can locate the JavaVM + Context.
///
/// tao 0.34 (the version Tauri used before the 2.11 bump) called
/// `ndk_context::initialize_android_context(...)` from its activity `create`.
/// tao 0.35 — pulled in by Tauri 2.11 — dropped that, so the global is left
/// uninitialized and the very first JNI call (`set_status_bar_style` /
/// `consume_launch_intent` on frontend mount) hits
/// `android_context().expect("android context was not initialized")`. With
/// `panic = "abort"` that aborts the whole process on launch.
///
/// We restore the old behaviour ourselves: `MainActivity.onCreate` calls this
/// once, before the WebView/frontend mounts. The `Once` guard makes a (rare,
/// given the broad `configChanges`) activity re-create a no-op, because
/// `initialize_android_context` asserts it is only ever set once.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_leaflet_reader_MainActivity_initRustNdkContext<'local>(
    env: jni::JNIEnv<'local>,
    activity: JObject<'local>,
) {
    use std::sync::Once;
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        let vm = match env.get_java_vm() {
            Ok(vm) => vm,
            Err(_) => return,
        };
        let global = match env.new_global_ref(&activity) {
            Ok(global) => global,
            Err(_) => return,
        };
        // SAFETY: `vm` and `activity` are valid for the duration of this JNI
        // call; leaking the global ref keeps the Activity alive for the whole
        // process, and the broad `configChanges` in AndroidManifest means the
        // Activity is not recreated, so this context stays valid.
        unsafe {
            ndk_context::initialize_android_context(
                vm.get_java_vm_pointer() as *mut _,
                global.as_obj().as_raw() as *mut _,
            );
        }
        std::mem::forget(global);
    });
}
