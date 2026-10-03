//! Over-the-air updates from this fork's GitHub Releases (tauri-plugin-updater).
//!
//! Prod checks `releases/latest/download/latest.json` shortly after launch and every few
//! hours; Dev only checks its own `dev-latest` pre-release when asked. A found update is
//! downloaded and its signature verified in the background, then held until the user
//! clicks Restart: installing restarts the app, which takes the proxy down for a few
//! seconds, so it never happens on its own. Settings, accounts and the data dir are
//! untouched; only the app bundle (with its bundled core) is replaced.

use super::*;
use tauri_plugin_updater::{Update, UpdaterExt};

pub(crate) const UPDATE_STATUS_EVENT: &str = "desk-update-status";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(60);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    /// idle, checking, downloading, ready, up-to-date or error.
    phase: &'static str,
    current_version: String,
    /// The release being downloaded or ready to install.
    version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    /// Download progress, 0 to 100, when the size is known.
    progress: Option<u8>,
    checked_at_ms: Option<i64>,
    error: Option<String>,
}

#[derive(Default)]
pub(crate) struct UpdateState {
    status: Mutex<UpdateStatus>,
    ready: Mutex<Option<(Update, Vec<u8>)>>,
    checking: AtomicBool,
}

fn publish(app: &tauri::AppHandle, change: impl FnOnce(&mut UpdateStatus)) {
    let state = app.state::<UpdateState>();
    let Ok(mut status) = state.status.lock() else {
        return;
    };
    change(&mut status);
    status.current_version = app.package_info().version.to_string();
    let _ = app.emit(UPDATE_STATUS_EVENT, status.clone());
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Checks the release feed and downloads a newer version if there is one.
async fn check_and_download(app: &tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("Updater is unavailable: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    let Some(update) = update else {
        publish(app, |status| {
            status.phase = "up-to-date";
            status.checked_at_ms = Some(now_ms());
            status.error = None;
        });
        return Ok(());
    };

    let already_ready = app
        .state::<UpdateState>()
        .ready
        .lock()
        .map(|ready| ready.as_ref().is_some_and(|(held, _)| held.version == update.version))
        .unwrap_or(false);
    if already_ready {
        publish(app, |status| status.checked_at_ms = Some(now_ms()));
        return Ok(());
    }

    let version = update.version.clone();
    let notes = update.body.clone();
    let published_at = update.date.map(|date| date.to_string());
    publish(app, |status| {
        status.phase = "downloading";
        status.version = Some(version.clone());
        status.notes = notes.clone();
        status.published_at = published_at.clone();
        status.progress = Some(0);
        status.error = None;
    });

    let progress_app = app.clone();
    let mut received = 0usize;
    let mut last_percent = 0u8;
    // Downloading also verifies the signature against the public key in tauri.conf.json.
    let bytes = update
        .download(
            move |chunk, total| {
                received += chunk;
                if let Some(total) = total.filter(|total| *total > 0) {
                    let percent = ((received as f64 / total as f64) * 100.0).min(100.0) as u8;
                    if percent >= last_percent.saturating_add(5) {
                        last_percent = percent;
                        publish(&progress_app, |status| status.progress = Some(percent));
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|error| format!("Could not download {version}: {error}"))?;

    if let Ok(mut ready) = app.state::<UpdateState>().ready.lock() {
        *ready = Some((update, bytes));
    }
    publish(app, |status| {
        status.phase = "ready";
        status.progress = Some(100);
        status.checked_at_ms = Some(now_ms());
    });
    Ok(())
}

async fn run_check(app: &tauri::AppHandle) {
    let state = app.state::<UpdateState>();
    if state.checking.swap(true, Ordering::SeqCst) {
        return;
    }
    let ready = state.ready.lock().map(|ready| ready.is_some()).unwrap_or(false);
    if !ready {
        publish(app, |status| status.phase = "checking");
    }
    if let Err(error) = check_and_download(app).await {
        publish(app, |status| {
            // A failed re-check must not hide an update that is already downloaded.
            if status.phase != "ready" {
                status.phase = "error";
            }
            status.error = Some(error);
            status.checked_at_ms = Some(now_ms());
        });
    }
    state.checking.store(false, Ordering::SeqCst);
}

/// Prod: check a minute after launch, then every six hours. Dev checks only on request.
pub(crate) fn start_update_checks(app: tauri::AppHandle) {
    publish(&app, |status| status.phase = "idle");
    if IS_DEV_BUILD {
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            run_check(&app).await;
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

#[tauri::command]
pub(crate) fn get_update_status(app: tauri::AppHandle) -> UpdateStatus {
    let state = app.state::<UpdateState>();
    let mut status = state.status.lock().map(|status| status.clone()).unwrap_or_default();
    status.current_version = app.package_info().version.to_string();
    status
}

#[tauri::command]
pub(crate) async fn check_for_update(app: tauri::AppHandle) -> UpdateStatus {
    run_check(&app).await;
    get_update_status(app)
}

/// Installs the downloaded update and restarts into it.
#[tauri::command]
pub(crate) fn install_update_and_restart(app: tauri::AppHandle) -> Result<(), String> {
    let held = app
        .state::<UpdateState>()
        .ready
        .lock()
        .map_err(|_| "Update state is unavailable".to_string())?
        .take();
    let Some((update, bytes)) = held else {
        return Err("No downloaded update to install".to_string());
    };
    if let Err(error) = update.install(&bytes) {
        let message = format!("Could not install {}: {error}", update.version);
        if let Ok(mut ready) = app.state::<UpdateState>().ready.lock() {
            *ready = Some((update, bytes));
        }
        return Err(message);
    }
    app.restart();
}
