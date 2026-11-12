//! Explicit experimental Raster HTTP library host. This does not enable the
//! ordinary simulator CLI. It serves a separate ticketed binary frame v2 UI.
use container_core::EngineKind;
use container_render_skia::PageRenderMode;
use container_simulator::{web::DevRasterWebSession, SimulatorConfig};
use std::net::{IpAddr, Ipv4Addr};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const USAGE:&str="serve_dev_raster --pack PATH [--host IP] [--port U16] [--engine quickjs|v8] [--duration-seconds 1..86400]";

fn main() -> Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let mut values = std::collections::BTreeMap::new();
    while let Some(flag) = arguments.next() {
        if flag == "--help" || flag == "-h" {
            println!("{USAGE}");
            return Ok(());
        }
        let key = flag.to_str().ok_or("flags must be UTF-8")?;
        if ![
            "--pack",
            "--host",
            "--port",
            "--engine",
            "--duration-seconds",
        ]
        .contains(&key)
        {
            return Err(format!("unknown flag {key}; {USAGE}").into());
        }
        let value = arguments
            .next()
            .ok_or_else(|| format!("{key} requires a value"))?;
        if values.insert(key.to_owned(), value).is_some() {
            return Err(format!("duplicate flag {key}").into());
        }
    }
    let pack = PathBuf::from(values.get("--pack").ok_or(USAGE)?);
    let text = |key: &str| -> Result<Option<&str>> {
        values
            .get(key)
            .map(|value| {
                value
                    .to_str()
                    .ok_or_else(|| format!("{key} must be UTF-8").into())
            })
            .transpose()
    };
    let host = text("--host")?
        .map(str::parse::<IpAddr>)
        .transpose()?
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let port = text("--port")?
        .map(str::parse::<u16>)
        .transpose()?
        .unwrap_or(0);
    let engine = match text("--engine")?.unwrap_or("quickjs") {
        "quickjs" => EngineKind::Quickjs,
        "v8" => EngineKind::V8,
        other => return Err(format!("unknown engine {other}").into()),
    };
    let duration = text("--duration-seconds")?
        .map(str::parse::<u64>)
        .transpose()?;
    if duration.is_some_and(|seconds| !(1..=86400).contains(&seconds)) {
        return Err("duration must be 1..86400 seconds".into());
    }
    // Install only this example's signal handler before opening any resource.
    let stopping = Arc::new(AtomicBool::new(false));
    let signal = Arc::clone(&stopping);
    ctrlc::set_handler(move || signal.store(true, Ordering::SeqCst))?;
    let mut owner = DevRasterWebSession::bind_from_pack_dir(
        pack,
        SimulatorConfig {
            engine,
            page_render_mode: PageRenderMode::Raster,
            ..Default::default()
        },
        host,
        port,
    )?;
    println!(
        "{}",
        serde_json::json!({"profile":"ticketed-raster-v1","url":owner.url(),
        "browserUiAttached":true,"inputProfile":"experimental-tap-only","gpuEvidence":false})
    );
    let started = Instant::now();
    let mut next_frame = Instant::now();
    let running: Result<()> = (|| {
        while !stopping.load(Ordering::SeqCst)
            && !duration.is_some_and(|seconds| started.elapsed() >= Duration::from_secs(seconds))
        {
            let now = Instant::now();
            let allow_render = now >= next_frame;
            if allow_render {
                next_frame = now + Duration::from_secs_f64(1.0 / 60.0);
            }
            let now_ns = u64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos())
                .unwrap_or(u64::MAX);
            owner.poll(now_ns, allow_render)?;
            owner.wait(Duration::from_millis(10))?;
        }
        Ok(())
    })();
    let shutdown = owner.shutdown();
    if let Err(error) = &shutdown {
        eprintln!("shutdown failed after owned sockets closed: {error}");
        match owner.drain_diagnostics() {
            Ok(diagnostics) => eprintln!("{}", serde_json::to_string(&diagnostics)?),
            Err(diagnostic_error) => {
                eprintln!("original runtime diagnostics unavailable: {diagnostic_error}")
            }
        }
    }
    println!(
        "{}",
        serde_json::json!({"state":owner.state(),"traceSummary":owner.trace_summary()})
    );
    running?;
    shutdown?;
    Ok(())
}
