//! Create one real macOS/Windows/Linux winit + softbuffer surface, present a
//! deterministic RGBA frame, and emit auditable capability evidence.
//!
//! This smoke intentionally proves only the native window/presentation
//! boundary. `softbuffer` is CPU-backed; `gpuSurface` therefore remains false
//! until a platform GPU presenter is connected.

use container_host_desktop::DesktopWindowPresenter;
use container_render_skia::RenderSnapshot;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use winit::event::Event;
use winit::event_loop::EventLoop;

fn snapshot() -> RenderSnapshot {
    // Four pixels with distinct colors make accidental channel/stride swaps
    // visible in the digest while keeping the smoke fast and deterministic.
    let pixels = vec![
        0xf0, 0x20, 0x30, 0xff, // red
        0x20, 0xf0, 0x40, 0xff, // green
        0x30, 0x40, 0xf0, 0xff, // blue
        0xf0, 0xf0, 0x40, 0xff, // yellow
    ];
    RenderSnapshot {
        frame_id: 1,
        width: 2,
        height: 2,
        stride: 8,
        format: "rgba8-premultiplied".into(),
        pixels,
    }
}

fn sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn parse_out(args: impl IntoIterator<Item = String>) -> Option<PathBuf> {
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        if arg == "--out" {
            return args.next().map(PathBuf::from);
        }
    }
    None
}

fn write_report(path: &Path, report: &Value) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, serde_json::to_vec_pretty(report)?)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = parse_out(std::env::args().skip(1));
    let event_loop = EventLoop::new()?;
    let frame = snapshot();
    let frame_digest = sha256(&frame.pixels);
    let mut presenter =
        DesktopWindowPresenter::new(&event_loop, "Weapp Container surface smoke", 2, 2)?;
    let capabilities = presenter.capabilities();
    let report = Arc::new(Mutex::new(None));
    let report_slot = Arc::clone(&report);

    #[allow(deprecated)]
    event_loop.run(move |event, target| {
        if matches!(event, Event::AboutToWait) {
            let present = presenter.present(&frame);
            *report_slot.lock().expect("report mutex is not poisoned") = Some(match present {
                Ok(()) => json!({
                    "schemaVersion": 1,
                    "status": "passed",
                    "scope": "desktop-native-window-surface",
                    "platform": std::env::consts::OS,
                    "surfaceBackend": capabilities.renderer,
                    "nativeSurface": capabilities.native_surface,
                    "gpuSurface": capabilities.gpu_surface,
                    "presentedFrame": true,
                    "frameId": frame.frame_id,
                    "width": frame.width,
                    "height": frame.height,
                    "pixelSha256": frame_digest,
                    "notes": [
                        "winit created a native platform window and softbuffer attached its presentation surface",
                        "softbuffer-raster is CPU evidence; it does not satisfy a Skia/Metal/Vulkan GPU gate",
                    ],
                }),
                Err(error) => json!({
                    "schemaVersion": 1,
                    "status": "failed",
                    "scope": "desktop-native-window-surface",
                    "platform": std::env::consts::OS,
                    "surfaceBackend": capabilities.renderer,
                    "nativeSurface": capabilities.native_surface,
                    "gpuSurface": capabilities.gpu_surface,
                    "presentedFrame": false,
                    "error": error.to_string(),
                }),
            });
            // Request one redraw so the compositor sees the same frame before
            // the event loop exits; the report still relies on `present()`'
            // successful buffer submission, not a screenshot heuristic.
            presenter.request_redraw();
            target.exit();
        }
    })?;

    let report = Arc::try_unwrap(report)
        .expect("event loop retains no report handles")
        .into_inner()
        .expect("report mutex is not poisoned")
        .expect("event loop should observe AboutToWait");
    if let Some(path) = out {
        write_report(&path, &report)?;
    }
    println!("{}", serde_json::to_string(&report)?);
    if report["status"] != "passed" {
        return Err("desktop surface smoke failed".into());
    }
    Ok(())
}
