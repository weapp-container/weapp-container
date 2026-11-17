//! Host-owned WebSurface performance probe.
//!
//! This probe keeps the runtime and WebSurface on one process, then measures
//! the actual HTTP bridge boundary instead of a synthetic Node JSON roundtrip.
//! It intentionally reports a software Web host boundary: no browser frame
//! callback or GPU surface is claimed.

use container_bridge::{op, BridgeEnvelope};
use container_core::{DataPatch, EngineKind};
use container_simulator::web::WebSurface;
use container_simulator::{Simulator, SimulatorConfig};
use serde::Serialize;
use serde_json::{json, Value};
use std::env;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "windows"))]
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

const DEFAULT_ITERATIONS: usize = 20;

#[derive(Debug, Serialize, Clone)]
struct Metric {
    status: &'static str,
    unit: &'static str,
    value: f64,
    p50: f64,
    p95: f64,
    p99: f64,
}

#[derive(Debug, Serialize)]
struct NotMeasured {
    status: &'static str,
    unit: &'static str,
    reason: &'static str,
}

#[derive(Debug, Serialize)]
struct Snapshot {
    frame_id: u64,
    width: u32,
    height: u32,
    stride: u32,
    format: String,
    #[serde(rename = "pixelBytes")]
    pixel_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbeProcess {
    lifecycle: &'static str,
    cold_start: Metric,
    bridge: Metric,
    rss: serde_json::Value,
    sample_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbeRuntime {
    lifecycle_states: Vec<String>,
    first_frame: Metric,
    snapshots: Vec<Snapshot>,
    startup_sample_count: usize,
    set_data_sample_count: usize,
    set_data_entries: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostProbe {
    schema_version: u8,
    mode: &'static str,
    surface: &'static str,
    process: HostProbeProcess,
    runtime: HostProbeRuntime,
    renderer_backends: Vec<String>,
    native_surface_attached: bool,
    gpu_frame_sampler_attached: bool,
    evidence_boundary: &'static str,
}

#[derive(Debug, Serialize)]
struct Report {
    schema_version: u8,
    benchmark: &'static str,
    host: &'static str,
    engine: EngineKind,
    iterations: usize,
    metrics: Metrics,
    evidence: Evidence,
    availability: Availability,
    status: &'static str,
    host_probe: HostProbe,
    disclaimer: &'static str,
}

#[derive(Debug, Serialize)]
struct Metrics {
    cold_start_ms: Metric,
    hot_start_ms: NotMeasured,
    first_frame_ms: Metric,
    set_data_10k_ms: Metric,
    bridge_p99_ms: Metric,
    scroll_dropped_frame_rate: NotMeasured,
    steady_state_memory_mb: serde_json::Value,
    quickjs_runtime_package_mb: NotMeasured,
}

#[derive(Debug, Serialize)]
struct Evidence {
    protocol: &'static str,
    native_host: &'static str,
}

#[derive(Debug, Serialize)]
struct Availability {
    status: &'static str,
    reason: &'static str,
}

fn percentile(samples: &[f64], p: f64) -> f64 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let index = ((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1);
    sorted[index.min(sorted.len().saturating_sub(1))]
}

fn metric(samples: &[f64], unit: &'static str) -> Metric {
    let value = percentile(samples, 0.95);
    Metric {
        status: "measured",
        unit,
        value,
        p50: percentile(samples, 0.50),
        p95: percentile(samples, 0.95),
        p99: percentile(samples, 0.99),
    }
}

fn rss_mb() -> Option<f64> {
    #[cfg(target_os = "linux")]
    {
        let source =
            std::fs::read_to_string(format!("/proc/{}/status", std::process::id())).ok()?;
        let value = source
            .lines()
            .find_map(|line| line.strip_prefix("VmRSS:")?.split_whitespace().next())?
            .parse::<f64>()
            .ok()?;
        return Some(value / 1024.0);
    }
    #[cfg(any(target_os = "macos", target_os = "freebsd"))]
    {
        let output = Command::new("ps")
            .args(["-o", "rss=", "-p", &std::process::id().to_string()])
            .output()
            .ok()?;
        let kib = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f64>()
            .ok()?;
        return Some(kib / 1024.0);
    }
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "(Get-Process -Id {} -ErrorAction SilentlyContinue).WorkingSet64",
                    std::process::id()
                ),
            ])
            .output()
            .ok()?;
        let bytes = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<f64>()
            .ok()?;
        return Some(bytes / (1024.0 * 1024.0));
    }
    #[allow(unreachable_code)]
    None
}

fn request(address: SocketAddr, body: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut stream = TcpStream::connect(address)?;
    // Match the latency-sensitive browser/server transport. Sending a small
    // header followed by a large body with Nagle enabled can wait for a
    // delayed ACK, measuring the probe's TCP policy instead of runtime work.
    stream.set_nodelay(true)?;
    let header = format!(
        "POST /api/bridge HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body)?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    Ok(response)
}

fn roundtrip(
    surface: &mut WebSurface,
    body: Vec<u8>,
) -> Result<(Value, f64), Box<dyn std::error::Error>> {
    let address = surface.local_addr();
    let started = Instant::now();
    // The HTTP client must run beside the single owner of the surface/runtime.
    // Scope the thread so a failed poll cannot leave an unowned test client.
    let response = thread::scope(|scope| -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let client = scope.spawn(move || request(address, &body));
        while !client.is_finished() {
            surface.poll()?;
            thread::yield_now();
        }
        client
            .join()
            .map_err(|_| "Web bridge client panicked")?
            .map_err(Into::into)
    })?;
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    if !response.starts_with(b"HTTP/1.1 200 OK") {
        return Err(format!(
            "Web bridge returned an unexpected response: {}",
            String::from_utf8_lossy(&response)
        )
        .into());
    }
    let split = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or("Web bridge response is missing HTTP headers")?;
    let batch: Value = serde_json::from_slice(&response[split + 4..])?;
    let messages = batch["messages"]
        .as_array()
        .ok_or("Web bridge returned no message batch")?;
    if messages
        .iter()
        .any(|message| message["payload"]["ok"] == false || message["op"] == "error")
    {
        return Err(format!("Web bridge rejected benchmark request: {batch}").into());
    }
    Ok((batch, elapsed_ms))
}

fn parse_engine(value: &str) -> Result<EngineKind, String> {
    match value {
        "quickjs" | "quick-js" => Ok(EngineKind::Quickjs),
        "v8" => Ok(EngineKind::V8),
        other => Err(format!("unknown engine {other}")),
    }
}

fn argument(name: &str) -> Option<String> {
    let mut args = env::args().skip(1);
    while let Some(value) = args.next() {
        if value == name {
            return args.next();
        }
    }
    None
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let pack = argument("--pack").ok_or("--pack is required")?;
    let engine = parse_engine(&argument("--engine").unwrap_or_else(|| "quickjs".into()))?;
    let iterations = argument("--iterations")
        .map(|value| value.parse::<usize>())
        .transpose()?
        .unwrap_or(DEFAULT_ITERATIONS);
    if iterations < DEFAULT_ITERATIONS {
        return Err("--iterations must be an integer >= 20".into());
    }

    let config = SimulatorConfig {
        engine,
        ..SimulatorConfig::default()
    };
    let mut startup_samples = Vec::with_capacity(iterations);
    let mut frame_samples = Vec::with_capacity(iterations);
    let mut last_startup = None;
    for index in 0..iterations {
        let startup = Instant::now();
        let mut simulator = Simulator::from_pack_dir(PathBuf::from(&pack), config.clone())?;
        let initial = simulator.run()?;
        // This clock includes pack validation, engine/session construction,
        // module execution, lifecycle and the first software RGBA frame.
        let first_frame_ms = startup.elapsed().as_secs_f64() * 1000.0;
        if initial.snapshot.is_none() || initial.lifecycle_state.as_deref() != Some("Active") {
            return Err("Startup did not produce an active session and RGBA frame".into());
        }
        startup_samples.push(first_frame_ms);
        frame_samples.push(first_frame_ms);
        // Keep only the final session for bridge measurements. Native V8
        // isolates are entered on construction and must leave in reverse
        // creation order, so independent startup samples must not overlap.
        if index + 1 == iterations {
            last_startup = Some((simulator, initial));
        }
    }
    let (simulator, initial) = last_startup.ok_or("No startup samples collected")?;
    let page_id = simulator
        .host()
        .session()
        .and_then(|session| session.app_service().pages().current())
        .ok_or("Startup did not create a page")?
        .id
        .0;
    let mut surface = WebSurface::localhost(0)?;
    let session_id = simulator.session_id().to_owned();
    let mut bridge_simulator = simulator;
    surface.set_local_bridge_handler(Box::new(move |body| {
        let batch = bridge_simulator
            .dispatch_json(body)
            .map_err(|error| error.to_string())?;
        serde_json::to_vec(&batch).map_err(|error| error.to_string())
    }));

    let bridge_body = serde_json::to_vec(&BridgeEnvelope::request(
        &session_id,
        "web-host-perf-1",
        op::DIAGNOSTIC,
        Value::Object(Default::default()),
    ))?;
    let mut bridge_samples = Vec::with_capacity(iterations);
    let mut patch_samples = Vec::with_capacity(iterations);
    let mut rss_samples = Vec::with_capacity(iterations);
    for index in 0..iterations {
        let mut body = bridge_body.clone();
        // Keep request IDs unique so this is representative of a real host
        // bridge and cannot be collapsed by a transport cache.
        let request_id = format!("web-host-perf-{}", index + 1);
        let mut envelope: Value = serde_json::from_slice(&body)?;
        envelope["requestId"] = Value::String(request_id);
        body = serde_json::to_vec(&envelope)?;
        let (_, elapsed) = roundtrip(&mut surface, body)?;
        bridge_samples.push(elapsed);
        let patches = (0..10_000)
            .map(|entry| DataPatch::set(format!("perfEntries[{entry}]"), json!(index + entry)))
            .collect::<Vec<_>>();
        let body = serde_json::to_vec(&BridgeEnvelope::request(
            &session_id,
            format!("web-host-set-data-{}", index + 1),
            op::DATA_PATCH_BATCH,
            json!({"pageId": page_id, "patches": patches}),
        ))?;
        let (response, elapsed) = roundtrip(&mut surface, body)?;
        if response["messages"][0]["payload"]["changed"] != 10_000 {
            return Err("setData benchmark did not apply all 10000 entries".into());
        }
        patch_samples.push(elapsed);
        if let Some(value) = rss_mb() {
            rss_samples.push(value);
        }
    }

    let renderer = initial.renderer.clone().unwrap_or_else(|| "unknown".into());
    let lifecycle = initial
        .lifecycle_state
        .clone()
        .into_iter()
        .collect::<Vec<_>>();
    let snapshots = initial
        .snapshot
        .clone()
        .into_iter()
        .map(|snapshot| Snapshot {
            frame_id: snapshot.frame_id,
            width: snapshot.width,
            height: snapshot.height,
            stride: snapshot.stride,
            format: snapshot.format,
            pixel_bytes: snapshot.pixel_bytes,
        })
        .collect::<Vec<_>>();
    let first_frame = metric(&frame_samples, "ms");
    let cold_start = metric(&startup_samples, "ms");
    let bridge = metric(&bridge_samples, "ms");
    let set_data = metric(&patch_samples, "ms");
    let protocol_pass = set_data.p95 <= 8.0 && bridge.p99 <= 2.0;
    let rss = if rss_samples.is_empty() {
        serde_json::to_value(NotMeasured {
            status: "not_measured",
            unit: "MiB",
            reason: "The current platform did not expose a process RSS sampler",
        })?
    } else {
        serde_json::to_value(metric(&rss_samples, "MiB"))?
    };
    let report = Report {
        schema_version: 1,
        benchmark: "container-performance",
        host: "web",
        engine,
        iterations,
        metrics: Metrics {
            cold_start_ms: cold_start.clone(),
            hot_start_ms: NotMeasured {
                status: "not_measured",
                unit: "ms",
                reason: "A persistent hot-start lifecycle is not attached to this probe",
            },
            first_frame_ms: first_frame.clone(),
            set_data_10k_ms: set_data,
            bridge_p99_ms: bridge.clone(),
            scroll_dropped_frame_rate: NotMeasured {
                status: "not_measured",
                unit: "ratio",
                reason: "A browser frame callback and long-list fixture are not attached",
            },
            steady_state_memory_mb: rss.clone(),
            quickjs_runtime_package_mb: NotMeasured {
                status: "not_measured",
                unit: "MiB",
                reason: "Measured by release artifact packaging",
            },
        },
        evidence: Evidence {
            protocol: if protocol_pass { "passed" } else { "failed" },
            native_host: "not_measured",
        },
        availability: Availability {
            status: "available",
            reason: "Host-owned local WebSurface measured lifecycle, software frame and HTTP bridge on this build machine",
        },
        status: if protocol_pass { "incomplete" } else { "failed" },
        host_probe: HostProbe {
            schema_version: 1,
            mode: "simulator-process",
            surface: "web-software",
            process: HostProbeProcess {
                lifecycle: "measured",
                cold_start,
                bridge,
                rss,
                sample_count: iterations,
            },
            runtime: HostProbeRuntime {
                lifecycle_states: lifecycle,
                first_frame,
                snapshots,
                startup_sample_count: startup_samples.len(),
                set_data_sample_count: patch_samples.len(),
                set_data_entries: 10_000,
            },
            renderer_backends: vec![renderer],
            native_surface_attached: false,
            gpu_frame_sampler_attached: false,
            evidence_boundary: "WebSurface HTTP and software RGBA snapshot only; no browser GPU frame callback",
        },
        disclaimer: "WebSurface host measurements are real local software evidence; they do not certify browser, GPU, DevTools or device performance.",
    };
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
