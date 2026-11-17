//! Runtime/source preparation example, deliberately without HTTP or a Worker.
use container_simulator::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use container_simulator::dev::{
    BrowserRuntimePreparation, DevConfig, DevEvent, DevPackConsumer, DevSupervisor,
};
use container_simulator::SimulatorConfig;
use serde_json::Value;
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    let owned_sources = args.len() == 4 && args[3] == "--owned-sources";
    if args.len() != 3 && !owned_sources {
        return Err(
            "usage: prepare_browser_runtime <project> <producer-directory> <independent-pins.json> [--owned-sources]"
                .into(),
        );
    }
    use std::io::Read;
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
    config.managed_browser_sources = owned_sources;
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
    let deadline = Instant::now() + Duration::from_secs(180);
    let prepared = (|| -> Result<_, Box<dyn std::error::Error>> {
        loop {
            if Instant::now() > deadline {
                return Err("static preparation timed out".into());
            }
            match supervisor.poll()? {
                Some(DevEvent::BrowserRuntimePrepared { report }) => {
                    // Resource bytes come from the original verified capture.
                    let resource = supervisor
                        .browser_runtime_resource("runtime-config.json")?
                        .ok_or("verified runtime-config.json is unavailable")?;
                    println!("{}", serde_json::to_string_pretty(&report)?);
                    println!("runtime-config: {}", std::str::from_utf8(resource.bytes())?);
                    drop(resource);
                    if !owned_sources {
                        return Ok(());
                    }
                }
                Some(DevEvent::PortableReady { report, .. }) if owned_sources => {
                    let check = supervisor.check_portable_publication(&report);
                    for event in check.events {
                        if let DevEvent::Diagnostic(diagnostic) = event {
                            eprintln!("{}", diagnostic.message);
                        }
                    }
                    if !check.authorized {
                        return Err("portable publication became stale".into());
                    }
                    println!("portable: {}", serde_json::to_string_pretty(&report)?);
                    // A portable receipt still does not execute a Worker or
                    // authorize any HTTP site or rendered frame.
                    return Ok(());
                }
                Some(DevEvent::Diagnostic(d)) => return Err(d.message.into()),
                Some(DevEvent::Exited(status)) => {
                    return Err(format!("watcher exited: {status}").into())
                }
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    })();
    // Retain the same supervisor through both successful and failed cleanup
    // attempts, including when static preparation itself failed.
    let cleanup_deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let cleanup_error = match supervisor.try_shutdown() {
            Ok(true) => return prepared,
            Ok(false) => "a static resource borrower is still active".to_owned(),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= cleanup_deadline {
            let preparation = match prepared {
                Ok(()) => "static preparation succeeded".to_owned(),
                Err(error) => format!("static preparation failed: {error}"),
            };
            // This is a failure, not a cleanup receipt. Drop logs any retained
            // owned directory for manual recovery after this process exits.
            return Err(format!(
                "{preparation}; cleanup did not finish after retries: {cleanup_error}"
            )
            .into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
