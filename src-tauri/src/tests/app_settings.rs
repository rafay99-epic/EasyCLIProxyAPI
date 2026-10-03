use super::support::*;
use super::*;

#[test]
fn gui_field_edit_preserves_comments_and_unknown_configuration() {
    let home = agent_test_home("gui-field-edit");
    let path = home.join("config.toml");
    fs::write(
            &path,
            "# keep this comment\ncustom-option = \"keep\"\ncodex-session-repair-on-launch = true\nclaude-code-working-directory = \"legacy\"\nclaude-code-working-directory-prompt-disabled = true\nport = 7000\n\n[third-party]\nenabled = true\n",
        )
        .unwrap();
    let config = GuiConfigFile {
        port: 9527,
        host: "0.0.0.0".to_string(),
        allow_lan: true,
        silent_start: true,
        auth_dir: path_to_string(&home.join("custom-auth")),
        management_secret_key: "custom-secret".to_string(),
        usage_statistics_enabled: false,
        disable_cooling: true,
        download_source: VersionDownloadSource::Gitcode,
        prefer_gitcode_downloads: true,
        ..GuiConfigFile::default()
    };

    write_gui_config_to_path(&config, &path).unwrap();
    let content = fs::read_to_string(&path).unwrap();
    assert!(content.contains("# keep this comment"));
    assert!(content.contains("custom-option = \"keep\""));
    assert!(content.contains("[third-party]"));
    assert!(content.contains("port = 9527"));
    assert!(content.contains("host = \"0.0.0.0\""));
    assert!(content.contains("silent-start = true"));
    assert!(content.contains("management-secret-key = \"custom-secret\""));
    assert!(content.contains("usage-statistics-enabled = false"));
    assert!(content.contains("disable-cooling = true"));
    assert!(content.contains("download-source = \"gitcode\""));
    assert!(content.contains("prefer-gitcode-downloads = true"));
    assert!(!content.contains("codex-session-repair-on-launch"));
    assert!(!content.contains("claude-code-working-directory"));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn software_write_hash_suppresses_only_the_matching_file_content() {
    let home = agent_test_home("write-hash");
    let path = home.join("config.toml");
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    assert!(consume_software_write(&path));
    assert!(!consume_software_write(&path));
    write_bytes_directly(&path, b"port = 8317\n").unwrap();
    fs::write(&path, b"port = 9000\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::write(&path, b"port = 8317\n").unwrap();
    assert!(!consume_software_write(&path));
    fs::remove_dir_all(home).unwrap();
}

#[test]
fn configuration_watcher_uses_the_nearest_existing_parent() {
    let home = agent_test_home("watch-parent");
    let target = home.join("nested/client/config.json");

    assert_eq!(
        nearest_existing_watch_directory(&target),
        Some(home.clone())
    );
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    assert_eq!(
        nearest_existing_watch_directory(&target),
        target.parent().map(Path::to_path_buf)
    );

    fs::remove_dir_all(home).unwrap();
}

#[test]
fn gui_config_defaults_are_stable() {
    let config = GuiConfigFile::default();
    let content = toml::to_string_pretty(&config).unwrap();

    // Fork defaults: own port next to production, cache-safe routing.
    assert!(content.contains(&format!("port = {}", crate::DEFAULT_CORE_PORT)));
    assert!(content.contains("allow-lan = false"));
    assert!(content.contains("run-on-startup = false"));
    assert!(content.contains("start-core-on-launch = true"));
    assert!(content.contains("silent-start = false"));
    assert!(content.contains("close-behavior = \"ask\""));
    assert!(content.contains("default-terminal = \"auto\""));
    assert_eq!(config.default_terminal, DEFAULT_AGENT_TERMINAL);
    assert!(content.contains("window-width = 1280"));
    assert!(content.contains("window-height = 800"));
    assert!(content.contains("auth-dir = \"../oauth\""));
    assert!(content.contains("[[api-keys]]"));
    assert!(content.contains("key = \"123456\""));
    assert!(content.contains("remark = \"Default key\""));
    assert!(content.contains("management-secret-key = \"\""));
    assert!(content.contains("plugins-enabled = false"));
    assert!(content.contains("routing-strategy = \"fill-first\""));
    assert!(content.contains("routing-session-affinity = true"));
    assert!(content.contains("routing-session-affinity-ttl = \"70m\""));
    assert!(content.contains("download-source = \"github\""));
    assert!(content.contains("prefer-gitcode-downloads = false"));
    assert!(content.contains("request-retry = 3"));
    assert!(content.contains("max-retry-credentials = 0"));
    assert!(content.contains("max-retry-interval = 30"));
    assert!(content.contains("streaming-bootstrap-retries = 0"));
}

#[test]
fn gui_window_size_round_trips_through_portable_config() {
    let config = GuiConfigFile {
        window_width: Some(1440),
        window_height: Some(900),
        ..GuiConfigFile::default()
    };

    let content = toml::to_string_pretty(&config).unwrap();
    let restored = toml::from_str::<GuiConfigFile>(&content).unwrap();

    assert!(content.contains("window-width = 1440"));
    assert!(content.contains("window-height = 900"));
    assert_eq!(
        configured_window_size(&restored),
        Some(SavedWindowSize {
            width: 1440,
            height: 900,
        })
    );
}

#[test]
fn silent_start_defaults_off_and_requires_tray_support() {
    let legacy = toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap();
    assert!(legacy.start_core_on_launch);
    assert!(!legacy.silent_start);
    assert!(!should_start_hidden(&legacy));

    let enabled = GuiConfigFile {
        silent_start: true,
        ..GuiConfigFile::default()
    };
    assert_eq!(
        should_start_hidden(&enabled),
        cfg!(any(
            target_os = "linux",
            target_os = "macos",
            target_os = "windows"
        ))
    );
}

#[test]
fn core_start_on_launch_defaults_on_and_can_be_disabled() {
    let legacy = toml::from_str::<GuiConfigFile>("port = 8317\n").unwrap();
    assert!(should_start_core_on_launch(&legacy));

    let disabled = GuiConfigFile {
        start_core_on_launch: false,
        ..GuiConfigFile::default()
    };
    assert!(!should_start_core_on_launch(&disabled));
}

#[test]
fn gui_window_size_is_clamped_and_requires_both_dimensions() {
    let mut config = GuiConfigFile {
        window_width: Some(320),
        window_height: Some(30_000),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(MIN_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(MAX_SAVED_WINDOW_DIMENSION));

    config.window_height = None;
    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, None);
    assert_eq!(config.window_height, None);
}

#[test]
fn legacy_default_window_size_migrates_to_current_default() {
    let mut config = GuiConfigFile {
        window_width: Some(LEGACY_DEFAULT_MAIN_WINDOW_WIDTH),
        window_height: Some(LEGACY_DEFAULT_MAIN_WINDOW_HEIGHT),
        ..GuiConfigFile::default()
    };

    assert!(sanitize_gui_config(&mut config).unwrap());
    assert_eq!(config.window_width, Some(DEFAULT_MAIN_WINDOW_WIDTH));
    assert_eq!(config.window_height, Some(DEFAULT_MAIN_WINDOW_HEIGHT));
}

#[test]
fn physical_window_size_uses_display_scale_and_ignores_minimized_sizes() {
    let physical_size = tauri::PhysicalSize::new(1500, 1000);
    assert_eq!(
        logical_window_size_from_physical(&physical_size, 1.25),
        Some(SavedWindowSize {
            width: 1200,
            height: 800,
        })
    );
    assert!(logical_window_size_from_physical(&tauri::PhysicalSize::new(0, 0), 1.0).is_none());
    assert!(logical_window_size_from_physical(&physical_size, 0.0).is_none());
}

/// The macOS data directory is named after APP_IDENTIFIER. If it drifted back to upstream's
/// identifier, this fork would read and write the production install's data.
#[test]
fn data_dir_identifier_matches_bundle_and_never_upstream() {
    let conf: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    let dev: serde_json::Value =
        serde_json::from_str(include_str!("../../tauri.dev.conf.json")).unwrap();
    let expected = if crate::IS_DEV_BUILD { &dev["identifier"] } else { &conf["identifier"] };
    assert_eq!(*expected, crate::APP_IDENTIFIER);
    assert_ne!(crate::APP_IDENTIFIER, "com.cpa.gui");
    // Dev must be a different app from Prod: own identifier (data dir) and name.
    assert_eq!(dev["identifier"], "com.rafay.cpadesk.dev");
    assert_ne!(dev["identifier"], conf["identifier"]);
    assert_ne!(dev["productName"], conf["productName"]);
    assert_ne!(crate::DEFAULT_CORE_PORT, crate::PROD_PORT);
}

#[test]
fn dev_build_never_takes_the_prod_port() {
    let mut config = crate::GuiConfigFile { port: crate::PROD_PORT, ..Default::default() };
    let dir = std::env::temp_dir().join(format!("cpa-dev-port-{}", std::process::id()));
    let _ = crate::sanitize_gui_config_at(&mut config, &dir, &dir.join("oauth"));
    let expected = if crate::IS_DEV_BUILD { crate::DEFAULT_CORE_PORT } else { crate::PROD_PORT };
    assert_eq!(config.port, expected);
    let _ = std::fs::remove_dir_all(dir);
}
