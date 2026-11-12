//! Serve one actual managed static stage through original HTTP borrowers.
//! This example executes no Worker, browser, AppService or presenter.
use container_simulator::browser_dev_coordinator::{
    BrowserDevCoordinator, PublicationApproval, StartupIntentPin, WireU64,
};
use container_simulator::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use container_simulator::dev::{
    BrowserRuntimePreparation, BrowserStagePoll, BrowserStageStart, DevConfig, DevEvent,
    DevPackConsumer, DevSupervisor,
};
use container_simulator::web::{
    WebResourceBody, WebResourceResolution, WebResourceTarget, WebSurface,
};
use container_simulator::SimulatorConfig;
use serde_json::Value;
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !(3..=5).contains(&args.len()) {
        return Err(
            "usage: serve_browser_stage <project> <producer-directory> <independent-pins.json> [port] [duration-ms]"
                .into(),
        );
    }
    let port: u16 = args
        .get(3)
        .map(|v| {
            v.to_str()
                .ok_or("port must be UTF-8")?
                .parse()
                .map_err(|_| "invalid port")
        })
        .transpose()?
        .unwrap_or(0);
    let serve_ms: Option<u64> = args
        .get(4)
        .map(|v| {
            v.to_str()
                .ok_or("duration must be UTF-8")?
                .parse()
                .map_err(|_| "invalid duration")
        })
        .transpose()?;
    if serve_ms.is_some_and(|ms| ms == 0 || ms > 86_400_000) {
        return Err("duration must be 1..=86400000 ms".into());
    }
    let shutdown = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&shutdown);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    let mut raw = Vec::new();
    std::fs::File::open(&args[2])?
        .take(16 * 1024 + 1)
        .read_to_end(&mut raw)?;
    if raw.len() > 16 * 1024 {
        return Err("independent pins file exceeds 16 KiB".into());
    }
    let pins: Value = serde_json::from_slice(&raw)?;
    let expected = &pins["expected"];
    let field = |key| {
        expected[key]
            .as_str()
            .ok_or("missing independent expected pin")
            .map(str::to_owned)
    };
    let renderer = match field("renderer")?.as_str() {
        "software" => RuntimeBundleRenderer::Software,
        "canvaskit" => RuntimeBundleRenderer::Canvaskit,
        _ => return Err("unknown independently pinned renderer".into()),
    };
    let mut config = DevConfig::new(PathBuf::from(&args[0]), SimulatorConfig::default());
    config.pack_consumer = DevPackConsumer::BrowserWorker;
    config.managed_browser_sources = true;
    config.managed_browser_stages = true;
    config.browser_runtime = Some(BrowserRuntimePreparation {
        producer_directory: std::fs::canonicalize(&args[1])?,
        expected: ProducerExpected {
            report_sha256: field("reportSha256")?,
            source_commit: field("sourceCommit")?,
            source_sha256: field("sourceSha256")?,
            renderer,
        },
    });
    let (mut supervisor, _) = DevSupervisor::spawn(config)?;
    let prepared = (|| -> Result<(), Box<dyn std::error::Error>> {
        // Force DOM admission so both software and CanvasKit producer bundles
        // can exercise static staging without claiming a drawing/GPU pass.
        let intent = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"webview"}}"#.to_vec();
        let deadline = Instant::now() + Duration::from_secs(180);
        let (runtime, portable) = loop {
            if shutdown.load(Ordering::SeqCst) {
                return Err("static preparation interrupted".into());
            }
            if Instant::now() >= deadline {
                return Err("runtime/source preparation timed out".into());
            }
            match supervisor.poll()? {
                Some(DevEvent::Diagnostic(d)) => return Err(d.message.into()),
                Some(DevEvent::Exited(status)) => {
                    return Err(format!("watcher exited: {status}").into())
                }
                _ => {}
            }
            if let (Some(runtime), Some(portable)) =
                (supervisor.browser_runtime(), supervisor.portable_pack())
            {
                break (runtime.clone(), portable.clone());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let run_id = supervisor
            .browser_stage_run_id()
            .ok_or("managed stage run identity unavailable")?
            .to_owned();
        let bundle_sha256 = runtime.pins.bundle_sha256.clone();
        let mut coordinator = BrowserDevCoordinator::new(
            run_id.clone(),
            runtime.pins,
            StartupIntentPin {
                revision: WireU64::new(1),
                sha256: container_ir::hex_digest(&intent),
                metrics_revision: WireU64::new(0),
            },
        )?;
        let check = supervisor.check_portable_publication(&portable);
        for event in &check.events {
            if let DevEvent::Diagnostic(diagnostic) = event {
                eprintln!("{}: {}", diagnostic.code, diagnostic.message);
            }
        }
        let approval = PublicationApproval::from_supervisor_check(
            &portable,
            coordinator.control_revision(),
            &check,
        )?;
        coordinator.accept_portable(approval)?;
        let ticket = coordinator.begin_stage(coordinator.control_revision())?;
        let stage = match supervisor.begin_browser_stage(ticket, intent)? {
            BrowserStageStart::Started(id) => id,
            BrowserStageStart::SourcePending { events } => {
                for event in events {
                    if let DevEvent::Diagnostic(d) = event {
                        eprintln!("{}: {}", d.code, d.message);
                    }
                }
                return Err("source changed before static stage admission; retry with its next portable generation".into());
            }
        };
        loop {
            if shutdown.load(Ordering::SeqCst) {
                return Err("static preparation interrupted".into());
            }
            if Instant::now() >= deadline {
                return Err("static stage capture timed out".into());
            }
            match supervisor.poll()? {
                Some(DevEvent::Diagnostic(d)) => return Err(d.message.into()),
                Some(DevEvent::Exited(status)) => {
                    return Err(format!("watcher exited: {status}").into())
                }
                _ => {}
            }
            match supervisor.poll_browser_stage(stage)? {
                BrowserStagePoll::CapturedStatic {
                    artifact,
                    runtime_ready,
                    presented_ready,
                } => {
                    if runtime_ready || presented_ready {
                        return Err(
                            "static staging incorrectly claimed runtime/presentation readiness"
                                .into(),
                        );
                    }
                    let body = supervisor
                        .browser_stage_resource(stage, "site.json")?
                        .ok_or("verified static site descriptor unavailable")?;
                    if container_ir::hex_digest(body.bytes()) != artifact.descriptor_sha256 {
                        return Err("site descriptor differs from verified artifact".into());
                    }
                    println!("{}", serde_json::to_string_pretty(&artifact)?);
                    println!(
                        "static site.json: {} bytes; Worker/browser/presentation not run",
                        body.bytes().len()
                    );
                    drop(body);
                    return serve_static(
                        &mut supervisor,
                        stage,
                        &run_id,
                        &bundle_sha256,
                        &artifact,
                        StaticHttpOptions {
                            port,
                            duration_ms: serve_ms,
                        },
                        &shutdown,
                    );
                }
                BrowserStagePoll::Running => {}
                state => {
                    return Err(format!("static stage stopped before capture: {state:?}").into())
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    // Keep this exact owner through failed cleanup attempts. No cleanup path
    // removes a directory while the watcher, stage or body still owns it.
    let cleanup_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let cleanup_error = match supervisor.try_shutdown() {
            Ok(true) => return prepared,
            Ok(false) => "an actual process or static resource borrower remains active".to_owned(),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= cleanup_deadline {
            let preparation = match prepared {
                Ok(()) => "static staging succeeded".to_owned(),
                Err(error) => format!("static staging failed: {error}"),
            };
            return Err(format!(
                "{preparation}; cleanup did not finish after retries: {cleanup_error}"
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

struct StaticHttpOptions {
    port: u16,
    duration_ms: Option<u64>,
}

fn serve_static(
    supervisor: &mut DevSupervisor,
    stage: container_simulator::dev::BrowserStageId,
    run_id: &str,
    bundle_sha256: &str,
    artifact: &container_simulator::browser_dev_coordinator::StageArtifact,
    options: StaticHttpOptions,
    shutdown: &AtomicBool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Created after the original verified capture, using no new file reader,
    // resource cache, admission ledger, or runtime/session implementation.
    let mut surface =
        WebSurface::bind_resource_only(IpAddr::V4(Ipv4Addr::LOCALHOST), options.port)?;
    let site_id = artifact.site_id;
    println!(
        "{}",
        serde_json::json!({
            "event": "static-http-ready", "address": surface.local_addr().to_string(),
            "descriptorUrl": format!("http://{}/__weapp/site/{}/{}/site.json", surface.local_addr(), run_id, site_id.get()),
            "indexUrl": format!("http://{}/__weapp/pack/{}/{}/pack-index.json", surface.local_addr(), run_id, site_id.get()),
            "runtimeBaseUrl": format!("http://{}/__weapp/runtime/{}/", surface.local_addr(), bundle_sha256),
            "runtimeReady": false, "presentedReady": false,
            "publicationAuthorized": false, "sourceFreshness": "not-checked-after-stage",
        })
    );
    let deadline = options
        .duration_ms
        .map(|ms| Instant::now() + Duration::from_millis(ms));
    while !shutdown.load(Ordering::SeqCst) && deadline.is_none_or(|limit| Instant::now() < limit) {
        surface.poll()?;
        surface.resolve_resource_requests(|target| match target {
            WebResourceTarget::Runtime {
                bundle_sha256: requested,
                path,
            } if requested == bundle_sha256 => match supervisor.browser_runtime_resource(path) {
                Ok(Some(body)) => WebResourceResolution::Found(WebResourceBody::Runtime(body)),
                Ok(None) => WebResourceResolution::NotFound,
                Err(error) => {
                    eprintln!("static HTTP runtime borrow failed: {error}");
                    WebResourceResolution::Unavailable
                }
            },
            WebResourceTarget::Pack {
                run_id: requested_run,
                site_id: requested_site,
                path,
            } if requested_run == run_id && *requested_site == site_id => {
                resolve_stage(supervisor, stage, path)
            }
            WebResourceTarget::Site {
                run_id: requested_run,
                site_id: requested_site,
            } if requested_run == run_id && *requested_site == site_id => {
                resolve_stage(supervisor, stage, "site.json")
            }
            _ => WebResourceResolution::NotFound,
        })?;
        surface.poll()?;
        match supervisor.poll()? {
            Some(DevEvent::Diagnostic(diagnostic)) => {
                eprintln!("{}: {}", diagnostic.code, diagnostic.message)
            }
            Some(DevEvent::Exited(status)) => {
                return Err(format!("compiler watch exited: {status}").into())
            }
            _ => {}
        }
        surface.wait(Duration::from_millis(10))?;
    }
    // All queued sockets and original resource borrowers disappear BEFORE
    // the existing outer loop retries cleanup on this SAME supervisor.
    drop(surface);
    Ok(())
}

fn resolve_stage(
    supervisor: &mut DevSupervisor,
    stage: container_simulator::dev::BrowserStageId,
    path: &str,
) -> WebResourceResolution {
    match supervisor.browser_stage_resource(stage, path) {
        Ok(Some(body)) => WebResourceResolution::Found(WebResourceBody::Stage(body)),
        Ok(None) => WebResourceResolution::NotFound,
        Err(error) => {
            eprintln!("static HTTP stage borrow failed: {error}");
            WebResourceResolution::Unavailable
        }
    }
}
