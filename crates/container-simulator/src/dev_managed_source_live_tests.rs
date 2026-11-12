//! Explicit real compiler/producer gate. Never counted as an ordinary unit
//! pass when its independently pinned input or compiler dependencies are absent.
use super::*;
use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};

fn wait_portable(supervisor: &mut DevSupervisor) -> Result<PortablePackReport, String> {
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        match supervisor.poll().map_err(|e| e.to_string())? {
            Some(DevEvent::PortableReady { report, .. }) => return Ok(report),
            Some(DevEvent::Diagnostic(d)) => return Err(format!("{}: {}", d.code, d.message)),
            Some(DevEvent::Exited(status)) => return Err(format!("watcher exited: {status}")),
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    Err("real managed source generation timed out".into())
}

#[test]
#[cfg(unix)]
#[ignore = "requires independently pinned completed runtime, Node and fixed compiler dependencies; no browser or Worker execution"]
fn managed_sources_real_watch_error_retention_and_same_bytes_recovery() -> Result<(), String> {
    let required = |name| {
        std::env::var(format!("WEAPP_CONTAINER_RETAINED_RUNTIME_{name}"))
            .map_err(|_| format!("missing independent input {name}"))
    };
    if required("PIN_AUTHORITY")?.is_empty() {
        return Err("independent pin authority required".into());
    }
    let producer = fs::canonicalize(required("BUILD_SITE")?).map_err(|e| e.to_string())?;
    let renderer = match required("RENDERER")?.as_str() {
        "software" => RuntimeBundleRenderer::Software,
        "canvaskit" => RuntimeBundleRenderer::Canvaskit,
        _ => return Err("unknown independently pinned renderer".into()),
    };
    let expected = ProducerExpected {
        report_sha256: required("REPORT_SHA256")?,
        source_commit: required("SOURCE_COMMIT")?,
        source_sha256: required("SOURCE_SHA256")?,
        renderer,
    };
    let original_producer =
        fs::read(producer.join("build-report.json")).map_err(|e| e.to_string())?;
    if container_ir::hex_digest(&original_producer) != expected.report_sha256 {
        return Err("independent producer report pin mismatch".into());
    }
    let root = fs::canonicalize(std::env::temp_dir())
        .map_err(|e| e.to_string())?
        .join(format!(
            "weapp-managed-source-live-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ));
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let project = root.join("project");
    fs::create_dir(&project).map_err(|e| e.to_string())?;
    fs::create_dir_all(project.join("pages/home")).map_err(|e| e.to_string())?;
    for (path, contents) in [
        (
            "project.config.json",
            r#"{"compileType":"miniprogram","miniprogramRoot":"dist/","srcMiniprogramRoot":".","appid":"touristappid"}"#,
        ),
        ("app.json", r#"{"pages":["pages/home/index"]}"#),
        ("app.js", "App({});"),
        ("app.wxss", "page { background: #f5f5f5; }"),
        ("pages/home/index.json", "{}"),
        ("pages/home/index.js", "Page({data:{title:'fixture'}});"),
        ("pages/home/index.wxml", "<view>{{title}}</view>"),
        ("pages/home/index.wxss", "view { color: #000; }"),
    ] {
        fs::write(project.join(path), contents).map_err(|e| e.to_string())?;
    }
    let mut config = DevConfig::new(&project, SimulatorConfig::default());
    config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    config.output_dir = root.join("output");
    config.node_bin = PathBuf::from(required("NODE_BIN")?);
    config.pack_consumer = DevPackConsumer::BrowserWorker;
    config.managed_browser_sources = true;
    config.browser_runtime = Some(BrowserRuntimePreparation {
        producer_directory: producer.clone(),
        expected,
    });
    let (mut supervisor, _) = DevSupervisor::spawn(config).map_err(|e| e.to_string())?;
    let artifact_root = supervisor.run_root.join("browser-artifacts");
    let preparation_root = supervisor.preparation_root.path.clone();
    // This closure has no assertions/panics: both successful and failed checks
    // flow through the same exact owner shutdown before fixture removal.
    let outcome = (|| -> Result<_, String> {
        if supervisor.child.is_some() || artifact_root.exists() {
            return Err("watcher/files started before first poll".into());
        }
        let first = wait_portable(&mut supervisor)?;
        if supervisor.simulator().is_some() {
            return Err("managed preparation started an AppService".into());
        }
        if !supervisor.check_portable_publication(&first).authorized {
            return Err("first portable is stale".into());
        }
        fs::write(
            project.join("pages/home/index.wxml"),
            "<view>{{title}}</view><text>watch update</text>",
        )
        .map_err(|e| e.to_string())?;
        let second = wait_portable(&mut supervisor)?;
        if second.revision <= first.revision || second.manifest_sha256 == first.manifest_sha256 {
            return Err("actual WXML edit did not produce a new portable generation".into());
        }
        let script = project.join("pages/home/index.js");
        let original_script = fs::read(&script).map_err(|e| e.to_string())?;
        fs::write(&script, "Page({data: });").map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match supervisor.poll().map_err(|e| e.to_string())? {
                Some(DevEvent::Diagnostic(d)) if d.code == "BUILD_FAILED" => break,
                Some(DevEvent::Exited(status)) => {
                    return Err(format!("watcher exited during failure: {status}"))
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err("missing actual compiler error".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if supervisor.portable_pack() != Some(&second)
            || !second.pack_directory.join("manifest.json").is_file()
        {
            return Err("failed watch lost previous valid portable".into());
        }
        if supervisor.check_portable_publication(&second).authorized {
            return Err("error retained publication authority".into());
        }
        fs::write(&script, original_script).map_err(|e| e.to_string())?;
        let recovered = wait_portable(&mut supervisor)?;
        if recovered.manifest_sha256 != second.manifest_sha256
            || recovered.integrity_root != second.integrity_root
            || recovered.publication_token == second.publication_token
        {
            return Err(
                "same-bytes recovery did not preserve content and refresh publication token".into(),
            );
        }
        if supervisor.check_portable_publication(&second).authorized
            || !supervisor.check_portable_publication(&recovered).authorized
        {
            return Err("publication generation check failed".into());
        }
        // Identical sequence/kind alone cannot authorize publication: compare
        // the complete accepted cursor immediately, before another owner poll.
        let status_path = artifact_root.join("source-control/status.json");
        let original_status = fs::read(&status_path).map_err(|e| e.to_string())?;
        let status: serde_json::Value =
            serde_json::from_slice(&original_status).map_err(|e| e.to_string())?;
        for field in ["compilerCommit", "creditId"] {
            let mut changed = status.clone();
            changed[field] = serde_json::Value::String("different-owner".into());
            fs::write(
                &status_path,
                serde_json::to_vec(&changed).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            if supervisor
                .managed_source
                .as_ref()
                .unwrap()
                .publication_current(&supervisor)
            {
                return Err(format!(
                    "same-sequence changed {field} retained publication authority"
                ));
            }
        }
        let rejected = supervisor.poll().map_err(|e| e.to_string())?;
        fs::write(&status_path, original_status).map_err(|e| e.to_string())?;
        if !matches!(rejected, Some(DevEvent::Diagnostic(ref d)) if d.message.contains("without a new sequence"))
        {
            return Err(format!(
                "same-sequence cursor mutation was not diagnosed: {rejected:?}"
            ));
        }
        if supervisor.check_portable_publication(&recovered).authorized {
            return Err(
                "restoring a rejected cursor silently restored its invalidated token".into(),
            );
        }
        let body = supervisor
            .browser_runtime_resource("runtime-config.json")
            .map_err(|e| e.to_string())?
            .ok_or("missing original runtime resource")?;
        let deadline = Instant::now() + Duration::from_secs(10);
        // Watcher barrier may need multiple owner turns before the body borrow
        // becomes the sole remaining blocker. Keep the same supervisor.
        while preparation_root.exists() && Instant::now() < deadline {
            if supervisor.try_shutdown().map_err(|e| e.to_string())? {
                return Err("shutdown ignored actual runtime borrower".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !artifact_root.exists() {
            return Err("borrowed runtime parent deleted early".into());
        }
        drop(body);
        Ok((first, second, recovered))
    })();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match supervisor.try_shutdown() {
            Ok(true) => break,
            result if Instant::now() >= deadline => {
                return Err(format!(
                    "cleanup failed; retained {}: {result:?}; outcome={outcome:?}",
                    root.display()
                ))
            }
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
    if artifact_root.exists() || preparation_root.exists() {
        return Err("owned parent survived successful shutdown".into());
    }
    if fs::read(producer.join("build-report.json")).map_err(|e| e.to_string())? != original_producer
    {
        return Err("input producer changed".into());
    }
    fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    let (first, second, recovered) = outcome?;
    eprintln!(
        "{}",
        serde_json::json!({"schemaVersion":1,"scope":"actual-managed-source-watch-portable",
        "first":first,"updated":second,"sameBytesRecovery":recovered,
        "buildFailureRetainedOldPack":true,"borrowerBlockedShutdown":true,"cleanupComplete":true,
        "workerExecuted":false,"browserExecuted":false,"gpu":"unknown"})
    );
    Ok(())
}
