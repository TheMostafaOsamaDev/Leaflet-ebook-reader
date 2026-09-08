mod archive;
mod notify;
mod opened;
mod sources;

// Only needed to call `get_webview_window` from the desktop-only open-path
// handlers below (single-instance callback, RunEvent::Opened) — gated so it
// doesn't warn as unused on the Android build, where neither call site
// compiles.
#[cfg(desktop)]
use tauri::Manager;

/// Book paths out of a command line, skipping argv[0] and anything that
/// isn't a file that exists.
///
/// Windows and Linux deliver a "Open with" cold start as plain arguments,
/// mixed in with whatever flags the launcher added. Requiring the file to
/// exist is what keeps a stray `--flag` from being queued as a book.
#[cfg(desktop)]
fn book_paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| std::path::Path::new(a).is_file())
        .cloned()
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // MUST be the first plugin registered — the plugin's own requirement.
    // Fires in the ALREADY-RUNNING instance when a second launch happens,
    // which is how Windows and Linux deliver "Open with" to a live window.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, argv, _cwd| {
            opened::push(app, book_paths_from_argv(&argv));
            // The whole point of this callback firing is that a second
            // launch handed us a book while Riwaq was already running,
            // typically behind other windows — the plugin's own documented
            // usage calls set_focus() here. Without it the import lands in
            // a window the user can't see and the second process just
            // exits, so nothing visibly happened.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        },
    ));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            sources::source_fetch,
            sources::source_fetch_bytes,
            sources::source_render_and_extract,
            sources::source_session_fetch,
            notify::update_download_notification,
            notify::set_status_bar_style,
            notify::set_immersive_mode,
            notify::consume_launch_intent,
            notify::consume_open_uri,
            notify::start_task_service,
            notify::stop_task_service,
            archive::stage_import_file,
            archive::zip_entries,
            archive::zip_read_texts,
            archive::zip_extract,
            archive::zip_read_bytes,
            archive::read_file_range,
            archive::write_chunk_b64,
            archive::rename_staged,
            archive::delete_staged,
            opened::take_pending_opens,
            opened::classify_drop,
        ])
        .setup(|app| {
            // Cold start on Windows / Linux: the file double-clicked in the
            // file manager arrives as an argument. macOS doesn't use argv
            // for this — it sends RunEvent::Opened, handled below.
            #[cfg(desktop)]
            {
                // args(), not args_os(): panics on ANY non-UTF-8 argument,
                // on every desktop launch — not just an Open-with one. A
                // lossy conversion turns a mangled argument into garbage
                // that harmlessly fails the is_file() filter below instead
                // of aborting the whole process before it can even show a
                // window.
                let argv: Vec<String> = std::env::args_os()
                    .map(|a| a.to_string_lossy().into_owned())
                    .collect();
                opened::push_silent(book_paths_from_argv(&argv));
            }

            // Dev harness for the session-webview transport. Off unless
            // LEAFLET_SESSION_SELFTEST names a URL to fetch, so normal
            // runs are unaffected.
            //
            // Desktop-only: it calls the `#[cfg(desktop)]` two-argument
            // `source_session_fetch`, whereas the mobile build compiles the
            // one-argument stub. Without this gate the Android target fails
            // to build at all.
            #[cfg(desktop)]
            if let Ok(target) = std::env::var("LEAFLET_SESSION_SELFTEST") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    // Twice: the first call pays session creation + the
                    // Cloudflare clear, the second reuses the warm session.
                    // Sequential pass first: cold (session build +
                    // challenge) then warm (reuse).
                    for label in ["cold", "warm"] {
                        let input = serde_json::from_value(serde_json::json!({
                            "url": target.clone(),
                        }))
                        .expect("selftest input");
                        let t0 = std::time::Instant::now();
                        match sources::source_session_fetch(handle.clone(), input).await {
                            Ok(resp) => println!(
                                "[selftest:{label}] status={} bytes={} elapsed={:?}",
                                resp.status_for_test(),
                                resp.text_for_test().len(),
                                t0.elapsed(),
                            ),
                            Err(e) => println!("[selftest:{label}] ERROR: {e}"),
                        }
                    }

                    // Then the case the sequential pass cannot catch: the
                    // app fires overlapping fetches per novel (page, then
                    // admin-ajax). The bridge has one payload slot, so
                    // without per-origin serialization these clobber each
                    // other and the transfer comes up short.
                    let mut set = Vec::new();
                    for i in 0..4 {
                        let h = handle.clone();
                        let u = target.clone();
                        set.push(tauri::async_runtime::spawn(async move {
                            let input = serde_json::from_value(serde_json::json!({ "url": u }))
                                .expect("selftest input");
                            let t0 = std::time::Instant::now();
                            match sources::source_session_fetch(h, input).await {
                                Ok(r) => format!(
                                    "[selftest:concurrent{i}] status={} bytes={} elapsed={:?}",
                                    r.status_for_test(),
                                    r.text_for_test().len(),
                                    t0.elapsed()
                                ),
                                Err(e) => format!("[selftest:concurrent{i}] ERROR: {e}"),
                            }
                        }));
                    }
                    for j in set {
                        match j.await {
                            Ok(line) => println!("{line}"),
                            Err(e) => println!("[selftest:concurrent] join error: {e}"),
                        }
                    }
                    println!("[selftest] done");
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, _event| {
            // macOS delivers "Open with" here, for BOTH cold and warm
            // launches — never as argv. The urls are file:// and have to be
            // converted back to paths before staging can open them.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &_event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                opened::push(_app, paths);
                // A book opened by double-click while Riwaq sits minimized
                // activates the app (RunEvent::Opened already implies
                // that) but previously left the window itself minimized in
                // the Dock — the import happened somewhere the user
                // couldn't see it land.
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });
}
