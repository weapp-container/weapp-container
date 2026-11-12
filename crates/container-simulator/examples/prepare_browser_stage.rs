//! Retain a real portable pack and independently pinned runtime as a static
//! stage. This example starts no HTTP server, Worker, browser or presenter.
use container_simulator::browser_dev_coordinator::{
    BrowserDevCoordinator, PublicationApproval, StartupIntentPin, WireU64,
};
use container_simulator::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use container_simulator::dev::{
    BrowserRuntimePreparation, BrowserStagePoll, BrowserStageStart, DevConfig, DevEvent,
    DevPackConsumer, DevSupervisor,
};
use container_simulator::SimulatorConfig;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 3 {
        return Err(
            "usage: prepare_browser_stage <project> <producer-directory> <independent-pins.json>"
                .into(),
        );
    }
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
        let mut coordinator = BrowserDevCoordinator::new(
            run_id,
            runtime.pins,
            StartupIntentPin {
                revision: WireU64::new(1),
                sha256: container_ir::hex_digest(&intent),
                metrics_revision: WireU64::new(0),
            },
        )?;
        let check = supervisor.check_portable_publication(&portable);
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
                    return Ok(());
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
