//! One-time import from the production EasyCLIProxyAPI install.
//!
//! Copies its accounts, GUI and core config, usage history and Codex model catalog into
//! CPA Desk, so CPA Desk takes over the same port and API key and every client keeps
//! working. Production files are only read. The import refuses to run while production
//! (app or core) is running: both apps holding the same Claude account would rotate each
//! other's refresh tokens. CPA Desk's previous data is moved to a backup folder, and the
//! import can only run once, since afterwards production's tokens are the stale copy.

use super::*;
use std::process::Command;

const PRODUCTION_IDENTIFIER: &str = "com.cpa.gui";
const PRODUCTION_APP_MARKER: &str = "/EasyCLIProxyAPI.app/Contents/MacOS/";
const MIGRATED_MARKER: &str = "migrated-from-production";
const STAGING_DIR: &str = ".migration-staging";

/// Paths copied from production, relative to the data dir. Directories are copied whole
/// except for the entries in `SKIPPED_NAMES`.
const MIGRATED_PATHS: &[&str] = &[
    "config.toml",
    "cpa-core/config.yaml",
    "oauth",
    "codex_models",
    "usage-records/usage.db",
    "usage-records/usage.db-wal",
    "usage-records/usage.db-shm",
];
/// Old core logs and usage backups stay behind; they are large and not needed.
const SKIPPED_NAMES: &[&str] = &["logs", "backups"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationStatus {
    /// Production data dir exists and has a config to import.
    available: bool,
    production_dir: String,
    /// Running production processes, e.g. "86630 cli-proxy-api". Empty when it's safe.
    production_processes: Vec<String>,
    /// Set once the import has run; the import is not offered again.
    migrated_at: Option<String>,
    credentials: usize,
    usage_bytes: u64,
    port: Option<u16>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationReport {
    copied: Vec<String>,
    backup_dir: String,
}

fn production_dir() -> Result<PathBuf, String> {
    let home = env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to determine the home directory".to_string())?;
    Ok(home.join("Library").join("Application Support").join(PRODUCTION_IDENTIFIER))
}

/// Production processes in `ps -axww -o pid=,command=` output: the app itself, or any
/// process (its core) running from production's data dir.
pub(crate) fn production_processes_from_ps(output: &str) -> Vec<String> {
    let data_marker = format!("/Application Support/{PRODUCTION_IDENTIFIER}/");
    output
        .lines()
        .map(str::trim)
        .filter(|line| line.contains(PRODUCTION_APP_MARKER) || line.contains(&data_marker))
        .filter_map(|line| {
            let (pid, command) = line.split_once(' ')?;
            // Arguments start at the first " -"; the path itself may contain spaces.
            let executable = command.split(" -").next().unwrap_or(command);
            let name = executable.rsplit('/').next().unwrap_or(executable);
            Some(format!("{pid} {name}"))
        })
        .collect()
}

fn running_production_processes() -> Result<Vec<String>, String> {
    let output = Command::new("ps")
        .args(["-axww", "-o", "pid=,command="])
        .output()
        .map_err(|error| format!("Failed to list processes: {error}"))?;
    Ok(production_processes_from_ps(&String::from_utf8_lossy(&output.stdout)))
}

fn read_port(config_toml: &Path) -> Option<u16> {
    let text = fs::read_to_string(config_toml).ok()?;
    text.lines()
        .find_map(|line| line.trim().strip_prefix("port")?.trim().strip_prefix('=')?.trim().parse().ok())
}

fn count_credentials(oauth_dir: &Path) -> usize {
    fs::read_dir(oauth_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .count()
        })
        .unwrap_or(0)
}

pub(crate) fn migration_status_between(production: &Path, desk: &Path, processes: Vec<String>) -> MigrationStatus {
    let usage_bytes = ["usage.db", "usage.db-wal"]
        .iter()
        .filter_map(|name| fs::metadata(production.join("usage-records").join(name)).ok())
        .map(|metadata| metadata.len())
        .sum();
    MigrationStatus {
        available: production.join("config.toml").is_file(),
        production_dir: production.to_string_lossy().into_owned(),
        production_processes: processes,
        migrated_at: fs::read_to_string(desk.join(MIGRATED_MARKER))
            .ok()
            .and_then(|text| text.lines().next().map(str::to_string)),
        credentials: count_credentials(&production.join("oauth")),
        usage_bytes,
        port: read_port(&production.join("config.toml")),
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    if source.is_dir() {
        fs::create_dir_all(target).map_err(|error| format!("Failed to create {}: {error}", target.display()))?;
        for entry in fs::read_dir(source).map_err(|error| format!("Failed to read {}: {error}", source.display()))? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            if SKIPPED_NAMES.iter().any(|skipped| name == *skipped) {
                continue;
            }
            copy_tree(&entry.path(), &target.join(name))?;
        }
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("Failed to create {}: {error}", parent.display()))?;
    }
    fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| format!("Failed to copy {}: {error}", source.display()))
}

/// Copies production into `desk`. Everything is staged first, so a failed copy leaves
/// CPA Desk as it was; the swap itself is a series of renames on the same volume.
pub(crate) fn migrate_between(production: &Path, desk: &Path, stamp: &str) -> Result<MigrationReport, String> {
    if desk.join(MIGRATED_MARKER).exists() {
        return Err("Already imported from EasyCLIProxyAPI. Importing again would bring back stale account tokens.".to_string());
    }
    if !production.join("config.toml").is_file() {
        return Err(format!("No EasyCLIProxyAPI data found in {}", production.display()));
    }

    let staging = desk.join(STAGING_DIR);
    let _ = fs::remove_dir_all(&staging);
    let present: Vec<&str> = MIGRATED_PATHS.iter().copied().filter(|path| production.join(path).exists()).collect();
    for path in &present {
        if let Err(error) = copy_tree(&production.join(path), &staging.join(path)) {
            let _ = fs::remove_dir_all(&staging);
            return Err(error);
        }
    }

    // Move CPA Desk's own copies aside. The usage database moves with its WAL files,
    // otherwise SQLite would replay a stale WAL onto the imported database.
    let backup = desk.join(format!("pre-migration-{stamp}"));
    for path in MIGRATED_PATHS {
        let current = desk.join(path);
        if current.exists() {
            let target = backup.join(path);
            fs::create_dir_all(target.parent().unwrap_or(&backup)).map_err(|error| error.to_string())?;
            fs::rename(&current, &target).map_err(|error| format!("Failed to back up {path}: {error}"))?;
        }
    }
    for path in &present {
        let target = desk.join(path);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        fs::rename(staging.join(path), &target).map_err(|error| format!("Failed to install {path}: {error}"))?;
    }
    let _ = fs::remove_dir_all(&staging);

    fs::write(
        desk.join(MIGRATED_MARKER),
        format!("{stamp}\nfrom {}\nbackup {}\n", production.display(), backup.display()),
    )
    .map_err(|error| format!("Failed to record the import: {error}"))?;
    Ok(MigrationReport {
        copied: present.iter().map(|path| path.to_string()).collect(),
        backup_dir: backup.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
pub(crate) fn get_migration_status() -> Result<MigrationStatus, String> {
    if IS_DEV_BUILD {
        // Never offered in Dev: Dev must not hold Prod's account tokens.
        return Ok(MigrationStatus {
            available: false,
            production_dir: String::new(),
            production_processes: Vec::new(),
            migrated_at: None,
            credentials: 0,
            usage_bytes: 0,
            port: None,
        });
    }
    Ok(migration_status_between(&production_dir()?, &core_base_dir()?, running_production_processes()?))
}

/// Runs the import, switches client configs to the real home (sandbox off), and leaves
/// the restart to `restart_after_migration` so the UI can confirm first.
#[tauri::command]
pub(crate) async fn run_production_migration(app: tauri::AppHandle) -> Result<MigrationReport, String> {
    if IS_DEV_BUILD {
        return Err("The production import is disabled in CPA Desk Dev.".to_string());
    }
    let running = running_production_processes()?;
    if !running.is_empty() {
        return Err(format!("Quit EasyCLIProxyAPI first. Still running: {}", running.join(", ")));
    }
    // The core watches its config and credential folder; stop it before swapping them.
    stop_core_process_inner(&app.state::<CoreProcessState>())?;
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let desk = core_base_dir()?;
    let report = tauri::async_runtime::spawn_blocking(move || migrate_between(&production_dir()?, &desk, &stamp))
        .await
        .map_err(|error| format!("Import task failed: {error}"))??;
    set_agent_config_live(app, true)?;
    Ok(report)
}

/// Restarts CPA Desk so it loads the imported port, keys and accounts.
#[tauri::command]
pub(crate) fn restart_after_migration(app: tauri::AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("cpa-migration-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn finds_production_app_and_core_only() {
        let ps = "\
  86549 /Applications/EasyCLIProxyAPI.app/Contents/MacOS/cpa-gui --portable-update-ack /tmp/x
  86630 /Users/me/Library/Application Support/com.cpa.gui/cpa-core/cli-proxy-api -config /Users/me/Library/Application Support/com.cpa.gui/cpa-core/config.yaml
  47592 /Applications/CPA Desk.app/Contents/MacOS/cpa-gui
  47725 /Users/me/Library/Application Support/com.rafay.cpadesk/cpa-core/cli-proxy-api";
        assert_eq!(production_processes_from_ps(ps), vec!["86549 cpa-gui", "86630 cli-proxy-api"]);
    }

    #[test]
    fn imports_production_and_backs_up_desk_data() {
        let production = temp_dir("prod");
        let desk = temp_dir("desk");
        write(&production.join("config.toml"), "port = 8317\n");
        write(&production.join("cpa-core/config.yaml"), "port: 8317\n");
        write(&production.join("cpa-core/cli-proxy-api"), "binary");
        write(&production.join("oauth/claude-a.json"), "{}");
        write(&production.join("oauth/logs/main.log"), "old");
        write(&production.join("usage-records/usage.db"), "prod-db");
        write(&desk.join("config.toml"), "port = 8327\n");
        write(&desk.join("cpa-core/cli-proxy-api"), "desk binary");
        write(&desk.join("usage-records/usage.db"), "desk-db");
        write(&desk.join("usage-records/usage.db-wal"), "desk-wal");

        let status = migration_status_between(&production, &desk, Vec::new());
        assert!(status.available && status.migrated_at.is_none());
        assert_eq!((status.credentials, status.port), (1, Some(8317)));

        let report = migrate_between(&production, &desk, "20261003-120000").unwrap();
        assert_eq!(fs::read_to_string(desk.join("config.toml")).unwrap(), "port = 8317\n");
        assert_eq!(fs::read_to_string(desk.join("usage-records/usage.db")).unwrap(), "prod-db");
        assert!(!desk.join("usage-records/usage.db-wal").exists(), "a stale WAL must not sit next to the imported db");
        assert!(desk.join("oauth/claude-a.json").is_file());
        assert!(!desk.join("oauth/logs").exists());
        assert_eq!(fs::read_to_string(desk.join("cpa-core/cli-proxy-api")).unwrap(), "desk binary");
        let backup = PathBuf::from(&report.backup_dir);
        assert_eq!(fs::read_to_string(backup.join("config.toml")).unwrap(), "port = 8327\n");
        assert_eq!(fs::read_to_string(backup.join("usage-records/usage.db-wal")).unwrap(), "desk-wal");
        assert_eq!(fs::read_to_string(production.join("config.toml")).unwrap(), "port = 8317\n");

        assert!(migration_status_between(&production, &desk, Vec::new()).migrated_at.is_some());
        assert!(migrate_between(&production, &desk, "20261003-130000").is_err(), "import runs once");
        let _ = fs::remove_dir_all(&production);
        let _ = fs::remove_dir_all(&desk);
    }
}
