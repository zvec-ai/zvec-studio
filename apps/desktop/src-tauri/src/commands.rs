//! Tauri `invoke` commands exposed to the React webview.
//!
//! Keep this surface tiny: anything we expose here turns into a permanent
//! contract with the SPA. Most "native" features should live behind an
//! explicit user story.
use serde::Serialize;
use tauri::State;

use crate::AppState;

/// Status of the embedded Python sidecar process.
#[derive(Debug, Serialize)]
pub struct SidecarStatus {
    pub running: bool,
    pub pid: Option<u32>,
    pub base_url: String,
}

#[tauri::command]
pub fn sidecar_status(state: State<'_, AppState>) -> SidecarStatus {
    let guard = state.sidecar.lock().expect("sidecar mutex poisoned");
    match guard.as_ref() {
        Some(handle) => SidecarStatus {
            running: true,
            pid: Some(handle.child.id()),
            base_url: state.config.base_url(),
        },
        None => SidecarStatus {
            running: false,
            pid: None,
            base_url: state.config.base_url(),
        },
    }
}

#[tauri::command]
pub fn sidecar_url(state: State<'_, AppState>) -> String {
    state.config.base_url()
}
