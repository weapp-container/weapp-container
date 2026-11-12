//! Opt-in real compiler + independently pinned completed producer gate.
//! Static staging only: never executes a Worker, HTTP server or presenter.
use crate::browser_dev_coordinator::{
    BrowserDevCoordinator, PublicationApproval, StageArtifact, StageTicket, StartupIntentPin,
    WireU64,
};
use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use crate::dev::{
    BrowserRuntimePreparation, BrowserStageId, BrowserStagePoll, BrowserStageStart, DevConfig,
    DevEvent, DevPackConsumer, DevSupervisor, PortablePackReport,
};
use crate::SimulatorConfig;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    Err("real managed stage source generation timed out".into())
}

fn current_ticket(
    supervisor: &mut DevSupervisor,
    coordinator: &mut BrowserDevCoordinator,
    report: &PortablePackReport,
) -> Result<StageTicket, String> {
    let check = supervisor.check_portable_publication(report);
    let approval =
        PublicationApproval::from_supervisor_check(report, coordinator.control_revision(), &check)
            .map_err(|e| {
                format!(
                    "stage publication changed before ticket: {e}; events={:?}",
                    check.events
                )
            })?;
    coordinator
        .accept_portable(approval)
        .map_err(|e| e.to_string())?;
    coordinator
        .begin_stage(coordinator.control_revision())
        .map_err(|e| e.to_string())
}

fn retire_stage(supervisor: &mut DevSupervisor, id: BrowserStageId) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !supervisor
        .retire_browser_stage(id)
        .map_err(|e| e.to_string())?
    {
        if Instant::now() >= deadline {
            return Err("unborrowed stage did not retire".into());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Ok(())
}

fn capture_stage(
    supervisor: &mut DevSupervisor,
    coordinator: &mut BrowserDevCoordinator,
    report: &PortablePackReport,
    intent: &[u8],
) -> Result<(BrowserStageId, StageArtifact), String> {
    let ticket = current_ticket(supervisor, coordinator, report)?;
    let id = match supervisor
        .begin_browser_stage(ticket, intent.to_vec())
        .map_err(|e| e.to_string())?
    {
        BrowserStageStart::Started(id) => id,
        BrowserStageStart::SourcePending { events } => {
            return Err(format!(
                "stage source changed before actual admission: {events:?}"
            ));
        }
    };
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        match supervisor.poll().map_err(|e| e.to_string())? {
            Some(DevEvent::Diagnostic(d)) => return Err(format!("{}: {}", d.code, d.message)),
            Some(DevEvent::Exited(status)) => return Err(format!("watcher exited: {status}")),
            _ => {}
        }
        match supervisor
            .poll_browser_stage(id)
            .map_err(|e| e.to_string())?
        {
            BrowserStagePoll::Running => {}
            BrowserStagePoll::CapturedStatic {
                artifact,
                runtime_ready,
                presented_ready,
            } => {
                if runtime_ready || presented_ready {
                    return Err("static stage claimed runtime or presentation readiness".into());
                }
                if artifact.manifest_sha256 != report.manifest_sha256
                    || artifact.integrity_root != report.integrity_root
                {
                    return Err("captured artifact differs from actual portable input".into());
                }
                return Ok((id, *artifact));
            }
            state => return Err(format!("stage stopped before static capture: {state:?}")),
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Err("real managed stage capture timed out".into())
}

#[test]
#[cfg(unix)]
#[ignore = "requires independently pinned completed runtime, Node and fixed compiler dependencies; static staging only"]
fn managed_stages_real_watch_retains_old_site_and_borrowed_shutdown() -> Result<(), String> {
    let required = |name| {
        std::env::var(format!("WEAPP_CONTAINER_RETAINED_RUNTIME_{name}"))
            .map_err(|_| format!("missing independent input {name}"))
    };
    if required("PIN_AUTHORITY")?.is_empty() {
        return Err("independent pin authority required".into());
    }
    let node_bin = PathBuf::from(required("NODE_BIN")?);
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
            "weapp-managed-stage-live-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_nanos()
        ));
    fs::create_dir(&root).map_err(|e| e.to_string())?;
    let project = root.join("project");
    fs::create_dir_all(project.join("pages/home")).map_err(|e| e.to_string())?;
    for (path, contents) in [
        (
            "project.config.json",
            r#"{"compileType":"miniprogram","miniprogramRoot":"dist/","srcMiniprogramRoot":".","appid":"touristappid"}"#,
        ),
        (
            "app.json",
            r#"{"pages":["pages/home/index"],"renderer":"webview"}"#,
        ),
        ("app.js", "App({});"),
        ("app.wxss", "page { background: #f5f5f5; }"),
        ("pages/home/index.json", "{}"),
        (
            "pages/home/index.js",
            "Page({data:{title:'stage fixture'}});",
        ),
        ("pages/home/index.wxml", "<view>{{title}}</view>"),
        ("pages/home/index.wxss", "view { color: #000; }"),
    ] {
        fs::write(project.join(path), contents).map_err(|e| e.to_string())?;
    }
    let mut config = DevConfig::new(&project, SimulatorConfig::default());
    config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    config.output_dir = root.join("output");
    config.node_bin = node_bin;
    config.pack_consumer = DevPackConsumer::BrowserWorker;
    config.managed_browser_sources = true;
    config.managed_browser_stages = true;
    config.browser_runtime = Some(BrowserRuntimePreparation {
        producer_directory: producer.clone(),
        expected,
    });
    let (mut supervisor, _) = DevSupervisor::spawn(config).map_err(|e| e.to_string())?;
    let artifact_root = supervisor.run_root.join("browser-artifacts");
    let preparation_root = supervisor.preparation_root.path.clone();
    // No assertions/panics after spawn: both success and operational failure
    // drop all local borrowers, then drain this SAME supervisor before removal.
    let outcome = (|| -> Result<_, String> {
        let first = wait_portable(&mut supervisor)?;
        let runtime = supervisor
            .browser_runtime()
            .ok_or("source ready without retained runtime")?;
        if supervisor.simulator().is_some() || runtime.runtime_ready || runtime.presented_ready {
            return Err("managed stage preparation executed or claimed a live runtime".into());
        }
        let run_id = supervisor
            .browser_stage_run_id()
            .ok_or("missing actual stage run id")?
            .to_owned();
        let intent = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"webview"}}"#;
        let startup_pin = StartupIntentPin {
            revision: WireU64::new(1),
            sha256: container_ir::hex_digest(intent),
            metrics_revision: WireU64::new(0),
        };
        let mut foreign_coordinator = BrowserDevCoordinator::new(
            format!("{run_id}-other"),
            runtime.pins.clone(),
            startup_pin.clone(),
        )
        .map_err(|e| e.to_string())?;
        let mut coordinator = BrowserDevCoordinator::new(run_id, runtime.pins.clone(), startup_pin)
            .map_err(|e| e.to_string())?;
        let foreign_ticket = current_ticket(&mut supervisor, &mut foreign_coordinator, &first)?;
        let foreign_directory =
            artifact_root.join(format!("stage-{}", foreign_ticket.site_id().get()));
        match supervisor.begin_browser_stage(foreign_ticket, intent.to_vec()) {
            Err(error) if error.to_string().contains("run identity differs") => {}
            result => return Err(format!("foreign run admitted a stage: {result:?}")),
        }
        if foreign_directory.exists() {
            return Err("foreign run rejection created a stage namespace".into());
        }
        let original_ticket = current_ticket(&mut supervisor, &mut coordinator, &first)?;
        let refused_startup_directory =
            artifact_root.join(format!("stage-{}", original_ticket.site_id().get()));
        let mut different_bytes = intent.to_vec();
        different_bytes.push(b' ');
        // Same JSON meaning is insufficient: admission must bind the original
        // startup bytes. Exceed both input borrower caps to expose any unused
        // lease leak, then exercise successful admission on this same owner.
        for _ in 0..65 {
            match supervisor.begin_browser_stage(original_ticket.clone(), different_bytes.clone()) {
                Err(error) if error.to_string().contains("invalid bounded") => {}
                result => {
                    return Err(format!(
                        "changed startup pin was admitted or leaked its input borrows: {result:?}"
                    ))
                }
            }
        }
        if refused_startup_directory.exists() {
            return Err("startup pin rejection created a stage namespace".into());
        }
        let (first_id, first_artifact) =
            capture_stage(&mut supervisor, &mut coordinator, &first, intent)?;
        let first_body = supervisor
            .browser_stage_resource(first_id, "site.json")
            .map_err(|e| e.to_string())?
            .ok_or("first verified site descriptor missing")?;
        let first_pointer = first_body.bytes().as_ptr();
        if container_ir::hex_digest(first_body.bytes()) != first_artifact.descriptor_sha256 {
            return Err("first original site descriptor pin differs".into());
        }
        // The finite constructor must never adopt an existing directory. This
        // exact sentinel directory belongs to the test, not the stage owner.
        let collision_ticket = current_ticket(&mut supervisor, &mut coordinator, &first)?;
        let collision_directory =
            artifact_root.join(format!("stage-{}", collision_ticket.site_id().get()));
        fs::create_dir(&collision_directory).map_err(|e| e.to_string())?;
        let sentinel = collision_directory.join("sentinel");
        let sentinel_bytes = b"test-owned pre-existing directory, never a stage namespace";
        fs::write(&sentinel, sentinel_bytes).map_err(|e| e.to_string())?;
        let collision_id = match supervisor
            .begin_browser_stage(collision_ticket, intent.to_vec())
            .map_err(|e| e.to_string())?
        {
            BrowserStageStart::Started(id) => id,
            state => {
                return Err(format!(
                    "construction collision was not retained as an owned attempt: {state:?}"
                ))
            }
        };
        match supervisor.poll_browser_stage(collision_id) {
            Err(error) if error.to_string().contains("os error 17") => {}
            result => {
                return Err(format!(
                    "construction collision did not expose its actual EEXIST cause: {result:?}"
                ))
            }
        }
        retire_stage(&mut supervisor, collision_id)?;
        if fs::read(&sentinel).map_err(|e| e.to_string())? != sentinel_bytes {
            return Err(
                "stage retirement adopted or changed the pre-existing sentinel directory".into(),
            );
        }
        // Remove only the two exact fixture-owned entries after the rejected
        // attempt retired. Unexpected extra files cause remove_dir to fail.
        fs::remove_file(&sentinel).map_err(|e| e.to_string())?;
        fs::remove_dir(&collision_directory).map_err(|e| e.to_string())?;
        fs::write(
            project.join("pages/home/index.wxml"),
            "<view>{{title}}</view><text>stage update</text>",
        )
        .map_err(|e| e.to_string())?;
        let second = wait_portable(&mut supervisor)?;
        if second.revision <= first.revision || second.manifest_sha256 == first.manifest_sha256 {
            return Err("real WXML change did not create a new portable generation".into());
        }
        // Do not poll the supervisor between this start and fault injection:
        // its normal poll advances all stages and could capture the bytes first.
        // The real helper writes a complete success result, then the normal
        // actual finite-job barrier below must confirm exit zero before the
        // receipt validator reaches this deliberately changed output file.
        let corrupt_ticket = current_ticket(&mut supervisor, &mut coordinator, &second)?;
        let corrupt_directory =
            artifact_root.join(format!("stage-{}", corrupt_ticket.site_id().get()));
        let corrupt_id = match supervisor
            .begin_browser_stage(corrupt_ticket, intent.to_vec())
            .map_err(|e| e.to_string())?
        {
            BrowserStageStart::Started(id) => id,
            state => {
                return Err(format!(
                    "bad-receipt fixture did not start actual helper: {state:?}"
                ))
            }
        };
        let result_path = corrupt_directory.join("result.json");
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            if result_path.is_file() {
                let bytes = fs::read(&result_path).map_err(|e| e.to_string())?;
                if let Ok(result) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                    if result["status"] == "staged-static" && result["op"] == "stage-pack" {
                        break;
                    }
                    return Err(format!(
                        "real helper failed before receipt corruption: {result}"
                    ));
                }
            }
            if Instant::now() >= deadline {
                return Err("real helper did not publish a complete static success result".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let corrupt_site = corrupt_directory.join("output/site.json");
        let mut changed_site = fs::read(&corrupt_site).map_err(|e| e.to_string())?;
        changed_site.extend_from_slice(b" \n");
        fs::write(&corrupt_site, changed_site).map_err(|e| e.to_string())?;
        loop {
            match supervisor.poll_browser_stage(corrupt_id) {
                Ok(BrowserStagePoll::Running) => {}
                Err(error)
                    if error
                        .to_string()
                        .contains("original site descriptor differs") =>
                {
                    break
                }
                result => {
                    return Err(format!(
                        "actual exit-zero receipt did not reject changed site bytes: {result:?}"
                    ))
                }
            }
            if Instant::now() >= deadline {
                return Err("actual exit-zero helper did not reach receipt validation".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if !corrupt_directory.is_dir() {
            return Err(
                "failed receipt discarded its actual namespace owner before retirement".into(),
            );
        }
        retire_stage(&mut supervisor, corrupt_id)?;
        if corrupt_directory.exists() {
            return Err("failed receipt namespace survived explicit owner retirement".into());
        }
        let (second_id, second_artifact) =
            capture_stage(&mut supervisor, &mut coordinator, &second, intent)?;
        if first_artifact.site_id == second_artifact.site_id {
            return Err("distinct stages reused the coordinator site identity".into());
        }
        let second_body = supervisor
            .browser_stage_resource(second_id, "site.json")
            .map_err(|e| e.to_string())?
            .ok_or("second verified site descriptor missing")?;
        if container_ir::hex_digest(second_body.bytes()) != second_artifact.descriptor_sha256
            || first_body.bytes().as_ptr() != first_pointer
            || container_ir::hex_digest(first_body.bytes()) != first_artifact.descriptor_sha256
        {
            return Err("hot update changed the original retained first site/body".into());
        }
        let capacity_ticket = current_ticket(&mut supervisor, &mut coordinator, &second)?;
        let refused_directory =
            artifact_root.join(format!("stage-{}", capacity_ticket.site_id().get()));
        match supervisor.begin_browser_stage(capacity_ticket, intent.to_vec()) {
            Err(error) if error.to_string().contains("capacity is occupied") => {}
            result => {
                return Err(format!(
                    "third stage was not rejected by the shared two-stage capacity: {result:?}"
                ))
            }
        }
        if refused_directory.exists() {
            return Err("capacity rejection created an unadmitted stage directory".into());
        }
        // A genuine compiler failure revokes new source publication while both
        // already captured immutable stage descriptors remain readable.
        let stale_ticket = coordinator
            .begin_stage(coordinator.control_revision())
            .map_err(|e| e.to_string())?;
        fs::write(project.join("pages/home/index.js"), "Page({data: });")
            .map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match supervisor.poll().map_err(|e| e.to_string())? {
                Some(DevEvent::Diagnostic(d)) if d.code == "BUILD_FAILED" => break,
                Some(DevEvent::Exited(status)) => {
                    return Err(format!("watcher exited during compiler error: {status}"))
                }
                Some(DevEvent::Diagnostic(d)) => {
                    return Err(format!("unexpected {}: {}", d.code, d.message))
                }
                _ => {}
            }
            if Instant::now() >= deadline {
                return Err("real compiler error was not observed".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        if supervisor.check_portable_publication(&second).authorized {
            return Err("compiler failure retained source publication authority".into());
        }
        if !matches!(
            supervisor
                .begin_browser_stage(stale_ticket, intent.to_vec())
                .map_err(|e| e.to_string())?,
            BrowserStageStart::SourcePending { .. }
        ) {
            return Err("failed source admitted an obsolete stage ticket".into());
        }
        for (id, expected_sha) in [
            (first_id, &first_artifact.descriptor_sha256),
            (second_id, &second_artifact.descriptor_sha256),
        ] {
            let body = supervisor
                .browser_stage_resource(id, "site.json")
                .map_err(|e| e.to_string())?
                .ok_or("compiler failure removed a retained old site")?;
            if container_ir::hex_digest(body.bytes()) != *expected_sha {
                return Err("compiler failure mutated retained site bytes".into());
            }
        }
        drop(second_body);
        retire_stage(&mut supervisor, second_id)?;
        if supervisor
            .retire_browser_stage(first_id)
            .map_err(|e| e.to_string())?
        {
            return Err("retirement ignored first site's actual body borrower".into());
        }
        if supervisor
            .browser_stage_resource(first_id, "site.json")
            .is_ok()
        {
            return Err("retired stage minted another body borrower".into());
        }
        if first_body.bytes().as_ptr() != first_pointer
            || container_ir::hex_digest(first_body.bytes()) != first_artifact.descriptor_sha256
        {
            return Err("retirement lost the still-borrowed original body".into());
        }
        // Keep a real body alive through repeated whole-supervisor shutdowns.
        // Dropping it is the only step that can release its stage and parents.
        for _ in 0..3 {
            if supervisor.try_shutdown().map_err(|e| e.to_string())? {
                return Err(
                    "shutdown succeeded while original stage body remained borrowed".into(),
                );
            }
            if !artifact_root.exists() {
                return Err("borrowed stage parent removed early".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(first_body);
        Ok((first_artifact, second_artifact))
    })();
    let deadline = Instant::now() + Duration::from_secs(20);
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
        return Err("owned stage/source/runtime parent survived successful shutdown".into());
    }
    if fs::read(producer.join("build-report.json")).map_err(|e| e.to_string())? != original_producer
    {
        return Err("independently pinned input producer changed".into());
    }
    fs::remove_dir_all(&root).map_err(|e| e.to_string())?;
    let (first, second) = outcome?;
    eprintln!(
        "{}",
        serde_json::json!({
            "schemaVersion":1,"scope":"actual-managed-browser-static-stage-watch",
            "first":first,"updated":second,"oldSiteRetainedAcrossUpdateAndBuildError":true,
            "existingDirectoryNotAdopted":true,"actualConstructionCauseReported":true,
        "foreignRunRejectedBeforeFiles":true,"originalStartupPinRejectedWithoutBorrowLeak":true,
            "changedExitZeroReceiptRejectedAndRetired":true,"thirdStageCapacityRefusedBeforeFiles":true,
            "retireRevokedNewBorrowers":true,"originalBorrowerBlockedShutdown":true,"cleanupComplete":true,
            "workerExecuted":false,"browserExecuted":false,"httpStarted":false,"gpu":"unknown"
        })
    );
    Ok(())
}

#[cfg(unix)]
#[path = "dev_browser_stage_http_live_tests.rs"]
mod http_live_tests;
