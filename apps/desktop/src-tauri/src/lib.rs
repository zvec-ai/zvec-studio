//! Zvec Studio desktop shell (Tauri v2).
//!
//! Responsibilities:
//! - Spawn the Python FastAPI sidecar (`python -m zvec_studio.cli`) and wait
//!   for it to bind to its TCP port before the webview is allowed to load.
//! - Hand the webview a long-lived backend so the SPA can talk to it via the
//!   same `/api/v1/*` routes the Web build uses.
//! - Tear the sidecar down on window close so the user is not left with a
//!   stray Python process.
//!
//! The shell stays intentionally thin: all business logic lives in the Python
//! backend and the React SPA. Native capabilities (file dialogs, etc.) will
//! be surfaced through Tauri commands when concrete user stories require them.
pub mod commands;
pub mod sidecar;

use std::env;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use sidecar::{SidecarConfig, SidecarHandle};

/// Application-scoped state shared across Tauri commands and run-loop hooks.
pub struct AppState {
    pub sidecar: Mutex<Option<SidecarHandle>>,
    pub config: SidecarConfig,
}

/// Try to locate the PyInstaller-frozen sidecar that ships next to the
/// desktop executable inside a packaged Tauri bundle. On macOS this is
/// `Contents/MacOS/zvec-studio-sidecar`; on Linux/Windows it sits next to
/// the main `.exe`/binary. Returns `None` in dev mode where only the source
/// tree is present.
pub fn resolve_bundled_sidecar() -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let names: &[&str] = if cfg!(target_os = "windows") {
        &["zvec-studio-sidecar.exe"]
    } else {
        &["zvec-studio-sidecar"]
    };
    for name in names {
        let candidate = exe_dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .format_timestamp_secs()
        .init();

    let mut config = SidecarConfig::from_env();

    // Auto-detect the bundled binary so packaged builds don't need any
    // env-var hand-holding. The env var still wins so packaging scripts
    // (Task 13) and downstream distros can override the location.
    if config.bundled_binary.is_none() && !config.disabled {
        if let Some(path) = resolve_bundled_sidecar() {
            log::info!("Detected bundled sidecar binary at {path:?}");
            config.bundled_binary = Some(path);
        }
    }

    log::info!(
        "Zvec Studio desktop shell starting (sidecar={}:{}, mode={}, disabled={})",
        config.host,
        config.port,
        config.launch_summary(),
        config.disabled
    );

    let handle = sidecar::spawn(&config).unwrap_or_else(|err| {
        eprintln!("\n[zvec-studio-desktop] failed to launch Python sidecar: {err}\n");
        eprintln!(
            "Hint: ensure the sidecar is reachable. Tried: {}\n  Set ZVEC_SIDECAR_DISABLED=1 to attach to an externally managed backend.\n",
            config.launch_summary()
        );
        std::process::exit(1);
    });

    let app_state = AppState {
        sidecar: Mutex::new(Some(handle)),
        config: config.clone(),
    };

    let context = tauri::generate_context!();

    #[cfg(target_os = "windows")]
    let context = {
        let mut context = context;
        if let Ok(additional_args) = env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
            let additional_args = additional_args.trim();
            if !additional_args.is_empty() {
                for window in &mut context.config_mut().app.windows {
                    window.additional_browser_args =
                        Some(match window.additional_browser_args.take() {
                            Some(configured_args) => format!("{configured_args} {additional_args}"),
                            None => format!(
                                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection {additional_args}"
                            ),
                        });
                }
            }
        }
        context
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::sidecar_status,
            commands::sidecar_url,
        ])
        .build(context)
        .expect("failed to build the Tauri application")
        .run(|app_handle, event| {
            let should_shutdown = matches!(
                &event,
                RunEvent::WindowEvent {
                    event: WindowEvent::CloseRequested { .. },
                    ..
                } | RunEvent::Exit
            );
            if should_shutdown {
                if let Some(state) = app_handle.try_state::<AppState>() {
                    if let Ok(mut guard) = state.sidecar.lock() {
                        if let Some(handle) = guard.take() {
                            log::info!("Shutting down Python sidecar");
                            sidecar::shutdown(handle);
                        }
                    }
                }
            }
        });
}
