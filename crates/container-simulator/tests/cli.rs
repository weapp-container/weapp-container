use std::process::Command;

struct Fixture(std::path::PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "weapp-browser-cli-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&root).unwrap();
        std::fs::create_dir_all(root.join("project/.weapp-container")).unwrap();
        std::fs::create_dir(root.join("producer")).unwrap();
        std::fs::write(root.join("pins.json"), br#"{"expected":{}}"#).unwrap();
        // Browser execution must not consult remote raster presentation state.
        std::fs::write(
            root.join("project/.weapp-container/presentation.json"),
            b"not JSON",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let node = root.join("must-not-run-node");
            std::fs::write(
                &node,
                b"#!/bin/sh\n: > \"$WEAPP_BROWSER_CLI_NODE_MARKER\"\nexit 97\n",
            )
            .unwrap();
            std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        Self(root)
    }

    fn command(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_weapp-simulator"));
        command
            .env_remove("WEAPP_CONTAINER_RENDERER_ASSETS")
            .env("WEAPP_BROWSER_CLI_NODE_MARKER", self.0.join("node-invoked"))
            .args(["dev", "--web-runtime", "browser", "--renderer", "webview"]);
        for (flag, path) in [
            ("--project", self.0.join("project")),
            ("--browser-runtime-dir", self.0.join("producer")),
            ("--browser-runtime-pins", self.0.join("pins.json")),
            ("--out-dir", self.0.join("output")),
            ("--node-bin", self.0.join("must-not-run-node")),
        ] {
            command.arg(flag).arg(path);
        }
        command
    }

    fn rejected(&self, arguments: &[&str], expected: &str) -> std::process::Output {
        let output = self
            .command()
            .args(arguments)
            .output()
            .expect("execute CLI preflight");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success(), "unexpected success: {stderr}");
        assert!(
            stderr.contains(expected),
            "expected {expected:?}, got {stderr}"
        );
        assert!(
            output.stdout.is_empty(),
            "preflight must not emit listening/staged output"
        );
        assert!(!self.0.join("output").exists(), "preflight wrote output");
        assert!(
            !self.0.join("project/.weapp-container/dev").exists(),
            "preflight wrote default development output"
        );
        assert!(
            !self.0.join("node-invoked").exists(),
            "preflight invoked the owned Node sentinel"
        );
        assert!(!stderr.contains("watching weapp-vite"), "{stderr}");
        output
    }

    fn rejected_exact(&self, arguments: &[&str], expected: &str) {
        let output = self.rejected(arguments, expected);
        assert_eq!(
            String::from_utf8(output.stderr).unwrap(),
            format!("weapp-simulator: {expected}\n")
        );
    }

    fn pin_producer(&self, report: &serde_json::Value, renderer: &str) {
        let bytes = serde_json::to_vec(report).unwrap();
        std::fs::write(self.0.join("producer/build-report.json"), &bytes).unwrap();
        std::fs::write(
            self.0.join("pins.json"),
            serde_json::to_vec(&serde_json::json!({"expected": {
                "reportSha256": container_ir::hex_digest(&bytes),
                "sourceCommit": "b".repeat(40), "sourceSha256": "c".repeat(64),
                "renderer": renderer,
            }}))
            .unwrap(),
        )
        .unwrap();
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).expect("remove only owned CLI fixture");
    }
}

#[test]
fn help_accepts_package_manager_separators_without_starting_a_watcher() {
    for arguments in [
        vec!["--help"],
        vec!["--", "--help"],
        vec!["dev", "--help"],
        vec!["dev", "--", "--help"],
        vec!["--", "dev", "--", "--help"],
        vec!["run", "--", "--help"],
        vec!["dispatch", "--", "--help"],
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_weapp-simulator"))
            .args(&arguments)
            .output()
            .expect("execute simulator help");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            output.status.success(),
            "help failed for {arguments:?}: {stderr}"
        );
        assert!(stderr.contains("Usage: weapp-simulator"), "{stderr}");
        assert!(!stderr.contains("web surface"), "{stderr}");
        assert!(!stderr.contains("watching weapp-vite"), "{stderr}");
    }
}

#[test]
fn browser_cli_rejects_unattached_modes_before_any_watcher_or_output() {
    let fixture = Fixture::new();
    let cases = [
        (vec!["--engine", "v8"], "ERR_ENGINE"),
        (
            vec!["--surface", "desktop"],
            "--surface web --renderer webview",
        ),
        (
            vec!["--surface", "both"],
            "--surface web --renderer webview",
        ),
        (
            vec!["--renderer", "auto"],
            "--surface web --renderer webview",
        ),
        (vec!["--software"], "without --software"),
        (vec!["--host", "0.0.0.0"], "IPv4 loopback"),
        (vec!["--host", "::1"], "IPv4 loopback"),
        (vec!["--wv-bin", "custom-wv"], "fixed vendor compiler"),
        (
            vec!["--renderer-assets", "custom-assets"],
            "pinned runtime producer",
        ),
        (vec!["--web-runtime", "invalid"], "remote or browser"),
    ];
    for profile in ["webview", "skia"] {
        for (arguments, expected) in &cases {
            let mut selected = vec!["--renderer", profile];
            selected.extend_from_slice(arguments);
            fixture.rejected(&selected, expected);
        }
    }
}

#[test]
fn browser_dom_cli_rejects_every_explicit_render_scale_before_resources() {
    let fixture = Fixture::new();
    for scale in ["auto", "1", "1.5", "2", "3", "4"] {
        fixture.rejected_exact(
            &["--renderer", "webview", "--render-scale", scale],
            "ERR_UNSUPPORTED_CAPABILITY: DOM density belongs to the browser; --render-scale requires --renderer skia; no watcher was started",
        );
    }
}

#[test]
fn browser_skia_cli_accepts_every_render_scale_through_independent_pin_validation() {
    let fixture = Fixture::new();
    for scale in ["auto", "1", "1.5", "2", "3", "4"] {
        // Invalid independent pins stop the CLI before Node, a listener or a
        // watcher can start. This proves argument acceptance, not presentation.
        fixture.rejected_exact(
            &["--renderer", "skia", "--render-scale", scale],
            "missing independent expected pin renderer",
        );
    }
}

#[test]
fn browser_cli_rejects_every_fps_for_both_renderers_before_resources() {
    let fixture = Fixture::new();
    for profile in ["webview", "skia"] {
        for fps in ["15", "30", "60", "120"] {
            fixture.rejected_exact(
                &["--renderer", profile, "--fps", fps],
                "ERR_UNSUPPORTED_CAPABILITY: Browser development does not yet apply --fps; no watcher was started",
            );
        }
    }
}

#[test]
fn browser_cli_reaches_independent_pin_validation_without_native_engine_or_saved_preferences() {
    let fixture = Fixture::new();
    for profile in ["webview", "skia"] {
        fixture.rejected(&["--renderer", profile], "pin");
        fixture.rejected(
            &[
                "--renderer",
                profile,
                "--route",
                "/pages/secondary/index",
                "--data-json",
                "{\"count\":41}",
                "--viewport",
                "412x732",
            ],
            "pin",
        );
    }
}

#[test]
fn browser_skia_cli_requires_pinned_canvaskit_before_any_resource_is_created() {
    let fixture = Fixture::new();
    let report = serde_json::json!({
        "status":"passed", "buildStatus":"passed", "ready":true,
        "plan":{"execution":"worker","renderer":"software"},
        "source":{"status":"passed","sourceStable":true,"workingTreeDirty":false,
            "sourceCommit":"b".repeat(40),"sourceSha256":"c".repeat(64)},
    });
    fixture.pin_producer(&report, "software");
    fixture.rejected(&["--renderer", "skia"], "independently pinned CanvasKit");
}

#[test]
fn browser_skia_cli_rejects_renderer_mismatch_unstable_source_and_changed_report() {
    let fixture = Fixture::new();
    let completed = serde_json::json!({
        "status":"passed", "buildStatus":"passed", "ready":true,
        "plan":{"execution":"worker","renderer":"canvaskit"},
        "source":{"status":"passed","sourceStable":true,"workingTreeDirty":false,
            "sourceCommit":"b".repeat(40),"sourceSha256":"c".repeat(64)},
    });
    let mutations: [fn(&mut serde_json::Value); 4] = [
        |report| report["plan"]["renderer"] = serde_json::json!("software"),
        |report| report["source"]["sourceStable"] = serde_json::json!(false),
        |report| report["source"]["workingTreeDirty"] = serde_json::json!(true),
        |report| report["ready"] = serde_json::json!(false),
    ];
    for mutate in mutations {
        let mut report = completed.clone();
        mutate(&mut report);
        fixture.pin_producer(&report, "canvaskit");
        fixture.rejected(&["--renderer", "skia"], "completed, stable pinned Worker");
    }
    fixture.pin_producer(&completed, "canvaskit");
    std::fs::write(fixture.0.join("producer/build-report.json"), b"changed").unwrap();
    fixture.rejected(&["--renderer", "skia"], "SHA-256 mismatch");
}

#[test]
fn browser_cli_requires_both_independent_runtime_arguments_before_resources() {
    let fixture = Fixture::new();
    for (runtime_flag, expected) in [
        (None, "requires --browser-runtime-dir"),
        (
            Some("--browser-runtime-dir"),
            "requires --browser-runtime-pins",
        ),
    ] {
        let mut command = Command::new(env!("CARGO_BIN_EXE_weapp-simulator"));
        command
            .env_remove("WEAPP_CONTAINER_RENDERER_ASSETS")
            .args([
                "dev",
                "--web-runtime",
                "browser",
                "--renderer",
                "webview",
                "--project",
            ])
            .arg(fixture.0.join("project"));
        if let Some(flag) = runtime_flag {
            command.arg(flag).arg(fixture.0.join("producer"));
        }
        let output = command.output().expect("execute missing runtime preflight");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(!output.status.success());
        assert!(stderr.contains(expected), "{stderr}");
        assert!(output.stdout.is_empty());
        assert!(!fixture.0.join("project/.weapp-container/dev").exists());
    }
}

#[test]
fn browser_cli_validates_inputs_and_remote_rejects_browser_configuration() {
    let fixture = Fixture::new();
    fixture.rejected(&["--viewport", "0x667"], "positive integer dimensions");
    fixture.rejected(&["--viewport", "375.5x667"], "positive integer dimensions");
    fixture.rejected(&["--viewport", "4097x667"], "positive integer dimensions");
    fixture.rejected(&["--data-json", "[]"], "JSON object");
    fixture.rejected(
        &["--web-runtime", "remote"],
        "require --web-runtime browser",
    );
    for profile in ["webview", "skia"] {
        let output = fixture
            .command()
            .args(["--renderer", profile])
            .env("WEAPP_CONTAINER_RENDERER_ASSETS", "inherited-assets")
            .output()
            .expect("execute inherited-assets preflight");
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("WEAPP_CONTAINER_RENDERER_ASSETS"));
        assert!(!fixture.0.join("output").exists());
    }
}
