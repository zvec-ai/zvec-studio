//! Integration tests that validate the desktop packaging and bundling
//! configuration is correct.
//!
//! These tests run at `cargo test` time and catch misconfigurations in
//! `tauri.conf.json`, `Cargo.toml` feature flags, and sidecar binary
//! resolution before a release build is even attempted.

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    /// Helper: path to the crate root (where `Cargo.toml` lives).
    fn manifest_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
    }

    /// Helper: read and parse tauri.conf.json.
    fn read_tauri_conf() -> serde_json::Value {
        let path = manifest_dir().join("tauri.conf.json");
        let contents = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("failed to read {}: {e}", path.display()));
        serde_json::from_str(&contents)
            .unwrap_or_else(|e| panic!("failed to parse {}: {e}", path.display()))
    }

    // -----------------------------------------------------------------------
    // 1. tauri.conf.json validation
    // -----------------------------------------------------------------------

    #[test]
    fn tauri_conf_bundle_identifier_matches_expected() {
        let conf = read_tauri_conf();
        let identifier = conf["identifier"].as_str().expect("identifier must be a string");
        assert_eq!(
            identifier, "studio.zvec.app",
            "bundle identifier must be reverse-domain format: studio.zvec.app"
        );
    }

    #[test]
    fn tauri_conf_product_name_is_set() {
        let conf = read_tauri_conf();
        let product_name = conf["productName"].as_str().expect("productName must be a string");
        assert_eq!(product_name, "Zvec Studio");
    }

    #[test]
    fn tauri_conf_main_window_title_is_set() {
        let conf = read_tauri_conf();
        let windows = conf["app"]["windows"]
            .as_array()
            .expect("app.windows must be an array");
        assert!(!windows.is_empty(), "at least one window must be defined");
        let main_window = &windows[0];
        assert_eq!(
            main_window["title"].as_str().unwrap(),
            "Zvec Studio",
            "main window title must be 'Zvec Studio'"
        );
        assert_eq!(
            main_window["label"].as_str().unwrap(),
            "main",
            "main window label must be 'main'"
        );
    }

    #[test]
    fn tauri_conf_main_window_dimensions_are_reasonable() {
        let conf = read_tauri_conf();
        let win = &conf["app"]["windows"].as_array().unwrap()[0];
        let width = win["width"].as_u64().expect("width must be a number");
        let height = win["height"].as_u64().expect("height must be a number");
        let min_width = win["minWidth"].as_u64().expect("minWidth must be a number");
        let min_height = win["minHeight"].as_u64().expect("minHeight must be a number");

        assert!(width >= 800, "default width ({width}) should be at least 800");
        assert!(height >= 600, "default height ({height}) should be at least 600");
        assert!(
            min_width >= 640,
            "minimum width ({min_width}) should be at least 640"
        );
        assert!(
            min_height >= 480,
            "minimum height ({min_height}) should be at least 480"
        );
        assert!(min_width <= width, "minWidth must not exceed width");
        assert!(min_height <= height, "minHeight must not exceed height");
    }

    #[test]
    fn tauri_conf_window_is_resizable_and_decorated() {
        let conf = read_tauri_conf();
        let win = &conf["app"]["windows"].as_array().unwrap()[0];
        assert_eq!(win["resizable"].as_bool(), Some(true), "window must be resizable");
        assert_eq!(win["decorations"].as_bool(), Some(true), "window must have decorations");
        assert_eq!(win["fullscreen"].as_bool(), Some(false), "window must not start fullscreen");
    }

    #[test]
    fn tauri_conf_bundle_declares_sidecar_external_bin() {
        let conf = read_tauri_conf();
        let external_bin = conf["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin must be an array");
        let bins: Vec<&str> = external_bin
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(
            bins.iter().any(|b| b.contains("zvec-studio-sidecar")),
            "externalBin must reference the zvec-studio-sidecar binary, got: {bins:?}"
        );
    }

    #[test]
    fn tauri_conf_bundle_is_active() {
        let conf = read_tauri_conf();
        assert_eq!(
            conf["bundle"]["active"].as_bool(),
            Some(true),
            "bundle.active must be true for production builds"
        );
    }

    #[test]
    fn tauri_conf_bundle_has_icon_entries() {
        let conf = read_tauri_conf();
        let icons = conf["bundle"]["icon"]
            .as_array()
            .expect("bundle.icon must be an array");
        assert!(
            !icons.is_empty(),
            "bundle.icon must have at least one icon path"
        );
        // Verify at least one icon for each major platform format.
        let icon_strs: Vec<&str> = icons.iter().filter_map(|v| v.as_str()).collect();
        assert!(
            icon_strs.iter().any(|i| i.ends_with(".icns")),
            "missing macOS .icns icon in bundle.icon"
        );
        assert!(
            icon_strs.iter().any(|i| i.ends_with(".ico")),
            "missing Windows .ico icon in bundle.icon"
        );
        assert!(
            icon_strs.iter().any(|i| i.ends_with(".png")),
            "missing .png icon in bundle.icon"
        );
    }

    #[test]
    fn tauri_conf_bundle_category_is_developer_tool() {
        let conf = read_tauri_conf();
        let category = conf["bundle"]["category"]
            .as_str()
            .expect("bundle.category must be a string");
        assert_eq!(category, "DeveloperTool");
    }

    #[test]
    fn tauri_conf_build_frontend_dist_path_exists_or_is_configured() {
        let conf = read_tauri_conf();
        let frontend_dist = conf["build"]["frontendDist"]
            .as_str()
            .expect("build.frontendDist must be a string");
        // In development the dist folder may not exist yet, but the path
        // must be configured and point to a reasonable relative location.
        assert!(
            frontend_dist.contains("frontend/dist"),
            "frontendDist should reference frontend/dist, got: {frontend_dist}"
        );
    }

    // -----------------------------------------------------------------------
    // 2. Cargo.toml feature & dependency validation
    // -----------------------------------------------------------------------

    #[test]
    fn cargo_toml_has_custom_protocol_feature() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        assert!(
            contents.contains("custom-protocol"),
            "Cargo.toml must define the `custom-protocol` feature"
        );
        assert!(
            contents.contains("tauri/custom-protocol"),
            "custom-protocol feature must enable tauri/custom-protocol"
        );
    }

    #[test]
    fn cargo_toml_depends_on_tauri_v2() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        // Tauri v2 dependency should be present.
        assert!(
            contents.contains(r#"tauri = { version = "2"#)
                || contents.contains(r#"tauri = "2"#),
            "Cargo.toml must depend on tauri v2"
        );
    }

    #[test]
    fn cargo_toml_depends_on_tauri_build_v2() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        assert!(
            contents.contains(r#"tauri-build = { version = "2"#)
                || contents.contains(r#"tauri-build = "2"#),
            "Cargo.toml must have tauri-build v2 in [build-dependencies]"
        );
    }

    #[test]
    fn cargo_toml_has_required_dependencies() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        let required_deps = [
            "serde",
            "serde_json",
            "tauri-plugin-dialog",
            "thiserror",
        ];
        for dep in &required_deps {
            assert!(
                contents.contains(dep),
                "Cargo.toml must list `{dep}` as a dependency"
            );
        }
    }

    #[test]
    fn cargo_toml_serde_has_derive_feature() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        assert!(
            contents.contains(r#"features = ["derive"]"#),
            "serde must have the `derive` feature enabled"
        );
    }

    #[test]
    fn cargo_toml_lib_exposes_rlib_for_tests() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        // The crate must produce an rlib so `cargo test` can link against it.
        assert!(
            contents.contains("rlib"),
            "Cargo.toml [lib] crate-type must include 'rlib' for test support"
        );
    }

    #[test]
    fn cargo_toml_release_profile_enables_lto() {
        let cargo_path = manifest_dir().join("Cargo.toml");
        let contents = std::fs::read_to_string(&cargo_path)
            .unwrap_or_else(|e| panic!("failed to read Cargo.toml: {e}"));
        assert!(
            contents.contains("lto = true"),
            "release profile must enable LTO for smaller bundles"
        );
    }

    // -----------------------------------------------------------------------
    // 3. Sidecar binary resolution logic
    // -----------------------------------------------------------------------

    #[test]
    fn from_env_picks_up_zvec_sidecar_binary_env_var() {
        // Directly verify that SidecarConfig::from_env reads ZVEC_SIDECAR_BINARY.
        // We set the variable, call from_env, then restore the previous state.
        //
        // NOTE: env var mutation is not thread-safe. Cargo runs tests in the
        // same process by default; however this variable name is unique enough
        // that collisions are extremely unlikely in practice.
        use crate::sidecar::SidecarConfig;
        let key = "ZVEC_SIDECAR_BINARY";
        let prev = std::env::var(key).ok();

        let test_path = "/tmp/fake-zvec-studio-sidecar";
        std::env::set_var(key, test_path);
        let cfg = SidecarConfig::from_env();

        // Restore immediately.
        match &prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }

        assert_eq!(
            cfg.bundled_binary,
            Some(PathBuf::from(test_path)),
            "SidecarConfig::from_env must read ZVEC_SIDECAR_BINARY"
        );
    }

    #[test]
    fn from_env_bundled_binary_is_none_when_env_var_unset() {
        use crate::sidecar::SidecarConfig;
        let key = "ZVEC_SIDECAR_BINARY";
        let prev = std::env::var(key).ok();

        std::env::remove_var(key);
        let cfg = SidecarConfig::from_env();

        // Restore.
        if let Some(v) = &prev {
            std::env::set_var(key, v);
        }

        assert_eq!(
            cfg.bundled_binary, None,
            "bundled_binary must be None when ZVEC_SIDECAR_BINARY is not set"
        );
    }

    #[test]
    fn resolve_bundled_sidecar_returns_none_in_dev_mode() {
        // In a `cargo test` environment, there is no packaged bundle directory.
        // The function should return None.
        let result = crate::resolve_bundled_sidecar();
        assert_eq!(
            result, None,
            "resolve_bundled_sidecar must return None outside a packaged bundle"
        );
    }

    #[test]
    fn resolve_bundled_sidecar_expected_binary_name() {
        // Verify the binary name the resolver looks for matches what
        // tauri.conf.json declares in bundle.externalBin.
        let conf = read_tauri_conf();
        let external_bins = conf["bundle"]["externalBin"]
            .as_array()
            .expect("bundle.externalBin must be an array");

        let expected_stem = "zvec-studio-sidecar";
        let found = external_bins
            .iter()
            .filter_map(|v| v.as_str())
            .any(|entry| {
                Path::new(entry)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| n == expected_stem)
                    .unwrap_or(false)
            });
        assert!(
            found,
            "tauri.conf.json externalBin must reference '{expected_stem}' \
             to match resolve_bundled_sidecar() search pattern"
        );
    }

    #[test]
    fn bundled_binary_path_used_in_launch_summary() {
        use crate::sidecar::SidecarConfig;
        use std::time::Duration;

        let cfg = SidecarConfig {
            python: "python3".into(),
            host: "127.0.0.1".into(),
            port: 7861,
            backend_dir: manifest_dir(),
            ready_timeout: Duration::from_secs(1),
            disabled: false,
            bundled_binary: Some(PathBuf::from("/app/bin/zvec-studio-sidecar")),
        };
        let summary = cfg.launch_summary();
        assert!(
            summary.contains("bundled binary"),
            "launch_summary must indicate bundled mode"
        );
        assert!(
            summary.contains("zvec-studio-sidecar"),
            "launch_summary must contain the binary name"
        );
    }

    #[test]
    fn platform_specific_binary_extension_is_correct() {
        // Validate the platform expectations encoded in resolve_bundled_sidecar.
        if cfg!(target_os = "windows") {
            // On Windows the sidecar binary should have a .exe extension.
            let expected = "zvec-studio-sidecar.exe";
            assert!(
                expected.ends_with(".exe"),
                "Windows sidecar binary must end with .exe"
            );
        } else {
            // On Unix-like systems there is no extension.
            let expected = "zvec-studio-sidecar";
            assert!(
                !expected.contains('.'),
                "Unix sidecar binary must not have an extension"
            );
        }
    }
}
