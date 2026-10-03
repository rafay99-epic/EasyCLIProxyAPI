use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

/// Folder inside the app data dir that stands in for $HOME while agent config is sandboxed.
const AGENT_SANDBOX_DIR: &str = "agent-sandbox-home";
/// Marker file whose presence switches agent configuration to the real home directory.
const AGENT_LIVE_MARKER: &str = "agent-config-live";

static AGENT_CONFIG_LIVE: AtomicBool = AtomicBool::new(false);

/// Whether agent configuration targets the real home directory (~/.claude, ~/.codex, ...).
/// Off by default so this fork can run next to a production install without rewriting
/// the client configs that production depends on.
pub(crate) fn agent_config_live() -> bool {
    AGENT_CONFIG_LIVE.load(Ordering::Relaxed)
}

/// Home directory that every agent-configuration read and write resolves against.
/// Returns the sandbox folder unless live mode is on.
pub(crate) fn agent_home_dir(app: &tauri::AppHandle) -> tauri::Result<PathBuf> {
    if agent_config_live() {
        return app.path().home_dir();
    }
    let sandbox = app.path().app_data_dir()?.join(AGENT_SANDBOX_DIR);
    fs::create_dir_all(&sandbox)?;
    Ok(sandbox)
}

/// Loads the persisted live/sandbox choice. Called once during app setup.
pub(crate) fn load_agent_config_target(app: &tauri::AppHandle) {
    let live = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join(AGENT_LIVE_MARKER).is_file())
        .unwrap_or(false);
    AGENT_CONFIG_LIVE.store(live, Ordering::Relaxed);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentConfigTarget {
    live: bool,
    sandbox_dir: String,
}

#[tauri::command]
pub(crate) fn get_agent_config_target(app: tauri::AppHandle) -> Result<AgentConfigTarget, String> {
    let sandbox_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(AGENT_SANDBOX_DIR);
    Ok(AgentConfigTarget {
        live: agent_config_live(),
        sandbox_dir: sandbox_dir.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn set_agent_config_live(app: tauri::AppHandle, live: bool) -> Result<AgentConfigTarget, String> {
    let data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let marker = data_dir.join(AGENT_LIVE_MARKER);
    if live {
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        fs::write(&marker, b"live\n").map_err(|error| error.to_string())?;
    } else if marker.exists() {
        fs::remove_file(&marker).map_err(|error| error.to_string())?;
    }
    AGENT_CONFIG_LIVE.store(live, Ordering::Relaxed);
    get_agent_config_target(app)
}

mod backups;
mod commands;
mod configuration;
mod deepseek_harness;
mod discovery;
mod launch;
mod native_oauth;
mod state;
mod templates;
mod transactions;
mod workbuddy;
mod antigravity;
#[cfg(target_os = "windows")]
mod windows_probe;
pub(crate) use backups::*;
pub(crate) use commands::*;
pub(crate) use configuration::*;
pub(crate) use deepseek_harness::*;
pub(crate) use discovery::*;
pub(crate) use launch::*;
pub(crate) use native_oauth::*;
pub(crate) use state::*;
pub(crate) use templates::*;
pub(crate) use transactions::*;
pub(crate) use workbuddy::*;
pub(crate) use antigravity::*;
#[cfg(target_os = "windows")]
pub(crate) use windows_probe::*;
