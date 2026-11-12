//! Real macOS Skia Ganesh Metal surface smoke.
//!
//! The macOS path creates a winit AppKit window and CAMetalLayer, attaches its
//! MTLDevice/MTLCommandQueue to the shared runtime, renders one committed frame
//! directly into the drawable texture, and presents it. Other platforms emit a
//! blocked report so cross-platform CI never mistakes a compile-only fallback
//! for GPU evidence.

#[cfg(not(target_os = "macos"))]
fn main() {
    println!(
        "{}",
        serde_json::json!({
            "schemaVersion": 1,
            "status": "blocked",
            "scope": "desktop-metal-window-surface",
            "hostSurfaceAttached": false,
            "containerSurfaceAttached": false,
            "gpuSurface": false,
            "reason": "The CAMetalLayer presenter is only available on macOS"
        })
    );
}

#[cfg(target_os = "macos")]
#[allow(deprecated)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use container_bridge::{op, BridgeEnvelope};
    use container_host_common::{HostSession, HostSessionError};
    use container_host_desktop::{MetalWindowPresenter, MetalWindowPresenterError};
    use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
    use container_runtime::SessionConfig;
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use winit::event::Event;
    use winit::event_loop::EventLoop;

    let manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "desktop-metal-smoke".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        },
        integrity: Integrity {
            algorithm: "sha256".into(),
            root: String::new(),
        },
        ..Default::default()
    };
    let event_loop = EventLoop::new()?;
    let config: SessionConfig = serde_json::from_value(json!({
        "page_render_mode": "native-gpu",
        "host": {"kind": "desktop", "platform": "macos"}
    }))?;
    let mut host = HostSession::from_manifest_json(serde_json::to_vec(&manifest)?, config)?;
    host.start("metal-smoke-init")?;
    host.dispatch(BridgeEnvelope::request(
        "session-1",
        "metal-smoke-frame",
        op::RENDER_COMMIT,
        json!({
            "frame": {
                "frameId": 37,
                "viewport": {"x": 0.0, "y": 0.0, "width": 320.0, "height": 240.0},
                "root": {
                    "id": "root",
                    "bounds": {"x": 0.0, "y": 0.0, "width": 320.0, "height": 240.0},
                    "background": {"red": 32, "green": 128, "blue": 240, "alpha": 255},
                    "opacity": 1.0,
                    "children": []
                }
            }
        }),
    ))?;
    let no_cpu_snapshot_before = matches!(
        host.render_snapshot_ref(),
        Err(HostSessionError::NoRenderFrame)
    );

    let mut presenter = match MetalWindowPresenter::new(
        &event_loop,
        "Weapp Container Skia Metal smoke",
        320,
        240,
    ) {
        Ok(value) => value,
        Err(error @ MetalWindowPresenterError::Window(_))
        | Err(error @ MetalWindowPresenterError::WindowHandleUnavailable) => {
            println!(
                "{}",
                json!({
                    "schemaVersion": 1,
                    "status": "blocked",
                    "scope": "desktop-metal-window-surface",
                    "platform": std::env::consts::OS,
                    "hostSurfaceAttached": false,
                    "containerSurfaceAttached": false,
                    "gpuSurface": false,
                    "reason": error.to_string(),
                })
            );
            return Ok(());
        }
        Err(error) => return Err(error.into()),
    };
    presenter.attach_session(&mut host)?;
    let report_slot: Arc<Mutex<Option<Value>>> = Arc::new(Mutex::new(None));
    let report_handle = Arc::clone(&report_slot);
    event_loop.run(move |event, target| {
        if matches!(event, Event::AboutToWait) {
            let mut report = match presenter.present_session(&mut host) {
                Ok(()) => {
                    let capabilities = presenter.capabilities();
                    let revision = host.render_revision();
                    let acknowledgement = host
                        .acknowledge_presentation_json(revision)
                        .and_then(|bytes| Ok(serde_json::from_slice::<Value>(&bytes)?));
                    let ack_ok = acknowledgement.as_ref().is_ok_and(|batch| {
                        batch["messages"].as_array().is_some_and(|messages| {
                            messages.iter().all(|message| {
                                message["op"] != "error" && message["payload"]["ok"] != false
                            })
                        })
                    });
                    let no_cpu_snapshot_after = matches!(
                        host.render_snapshot_ref(),
                        Err(HostSessionError::NoRenderFrame)
                    );
                    let passed = capabilities.gpu_surface
                        && host.renderer_backend().ok() == Some("skia-gpu-metal")
                        && no_cpu_snapshot_before
                        && no_cpu_snapshot_after
                        && revision > 0
                        && revision != 37
                        && ack_ok;
                    json!({
                        "schemaVersion": 1,
                        "status": if passed { "passed" } else { "failed" },
                        "scope": "desktop-metal-window-surface",
                        "platform": std::env::consts::OS,
                        "surfaceBackend": capabilities.renderer,
                        "hostSurfaceAttached": capabilities.native_surface,
                        "containerSurfaceAttached": capabilities.gpu_surface,
                        "gpuSurface": capabilities.gpu_surface,
                        "rendererBackend": host.renderer_backend().unwrap_or("unknown"),
                        "pageRenderMode": "native-gpu",
                        "presentedFrame": true,
                        "frameId": 37,
                        "renderRevision": revision,
                        "cpuSnapshotAbsentBefore": no_cpu_snapshot_before,
                        "cpuSnapshotAbsentAfter": no_cpu_snapshot_after,
                        "presentationAckAccepted": ack_ok,
                        "presentationAck": acknowledgement.unwrap_or_else(|error| json!({"error":error.to_string()})),
                        "gpuCompletion": "not-waited",
                        "notes": [
                            "CAMetalLayer drawable was wrapped as a Skia Ganesh Metal render target",
                            "the runtime rendered the committed frame directly before presentDrawable/commit",
                            "no CPU page snapshot was cached before or after presentation",
                            "the renderer-owned revision was acknowledged only after command submission; GPU completion was not awaited",
                        ],
                    })
                }
                Err(error) => json!({
                    "schemaVersion": 1,
                    "status": "failed",
                    "scope": "desktop-metal-window-surface",
                    "platform": std::env::consts::OS,
                    "hostSurfaceAttached": presenter.has_native_surface(),
                    "containerSurfaceAttached": false,
                    "gpuSurface": false,
                    "rendererBackend": host.renderer_backend().unwrap_or("unknown"),
                    "presentedFrame": false,
                    "error": error.to_string(),
                }),
            };
            let detached = presenter.detach_session(&mut host);
            host.unload();
            report["cleanup"] = json!({
                "metalContextDetached": detached.is_ok(),
                "sessionUnloaded": !host.has_session(),
            });
            if let Err(error) = detached {
                report["status"] = json!("failed");
                report["cleanup"]["error"] = json!(error.to_string());
            }
            *report_handle.lock().expect("report mutex is not poisoned") = Some(report);
            target.exit();
        }
    })?;
    let mut report = Arc::try_unwrap(report_slot)
        .expect("event loop retains no report handles")
        .into_inner()
        .expect("report mutex is not poisoned")
        .expect("event loop should emit a report");
    report["cleanup"]["eventLoopReturned"] = json!(true);
    report["cleanup"]["windowOwnerDropped"] = json!(true);
    println!("{}", serde_json::to_string(&report)?);
    if report["status"] == "failed" {
        return Err("desktop Metal surface smoke failed".into());
    }
    Ok(())
}
