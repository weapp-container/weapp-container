//! Android JNI/NDK host boundary. Native surface binding remains feature-gated.

use container_bridge::{BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_core::LifecycleState;
use container_host_common::{HostSession, HostSessionError};
use container_runtime::{engine_provider_compiled, HostKind, SessionConfig};

pub mod ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsBackend {
    Stub,
    OpenGlEs,
    Vulkan,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCapabilities {
    pub android: bool,
    pub native_surface: bool,
    pub renderer: &'static str,
    pub gpu_surface: bool,
    pub quickjs: bool,
    pub v8: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostInfo {
    pub platform: &'static str,
    pub graphics: GraphicsBackend,
    pub capabilities: HostCapabilities,
}

impl HostInfo {
    pub const fn current() -> Self {
        let graphics = if cfg!(feature = "vulkan") {
            GraphicsBackend::Vulkan
        } else if cfg!(feature = "gles") {
            GraphicsBackend::OpenGlEs
        } else {
            GraphicsBackend::Stub
        };
        // `skia-gpu-gles` forwards the Skia feature to the renderer and
        // runtime crates without enabling the plain `skia-backend` alias on
        // this host. Report the compiled renderer boundary accurately.
        let native_skia = cfg!(all(
            feature = "android",
            any(feature = "skia-backend", feature = "skia-gpu-gles")
        ));
        Self {
            platform: "android",
            graphics,
            capabilities: HostCapabilities {
                android: true,
                native_surface: native_skia,
                renderer: if native_skia {
                    "skia-raster"
                } else {
                    "software-fallback"
                },
                gpu_surface: false,
                // Query the shared runtime: Cargo can enable its native
                // providers through another workspace consumer.
                quickjs: engine_provider_compiled(EngineKind::Quickjs),
                // Session construction also checks that the compiled V8
                // provider actually creates a native isolate.
                v8: engine_provider_compiled(EngineKind::V8),
            },
        }
    }
}

#[derive(Debug, Default)]
pub struct AndroidHost {
    initialized: bool,
    session: HostSession,
}

impl AndroidHost {
    pub const fn new() -> Self {
        Self {
            initialized: false,
            session: HostSession::empty(),
        }
    }
    pub fn info(&self) -> HostInfo {
        HostInfo::current()
    }
    pub fn initialize(&mut self) {
        self.initialized = true;
    }
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// Runtime lifecycle state after host transitions (launch/show/hide/unload).
    /// This distinguishes a loaded session from an active app and lets
    /// platform event loops produce an accurate parity trace.
    pub fn lifecycle_state(&self) -> Result<LifecycleState, HostSessionError> {
        self.session.lifecycle_state()
    }

    pub fn lifecycle_sequence(&self) -> Result<u64, HostSessionError> {
        self.session.lifecycle_sequence()
    }

    /// JNI callers load a validated manifest before attaching a native
    /// surface.  A failed reload leaves the currently running session intact.
    pub fn load_manifest_json(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        mut config: SessionConfig,
    ) -> Result<(), HostSessionError> {
        // Native hosts currently implement Skia profiles only. Validate this
        // before replacing a live session; WebView must never fall back to Skia.
        let manifest_json = manifest_json.as_ref();
        let manifest: container_ir::ContainerManifestV1 = serde_json::from_slice(manifest_json)?;
        if let Some(rendering) = &manifest.rendering {
            rendering
                .negotiate(
                    container_ir::RENDERING_PROFILE_VERSION,
                    &[
                        container_ir::RendererProfile::Skia,
                        container_ir::RendererProfile::SkylineCompat,
                    ],
                )
                .map_err(|error| {
                    container_runtime::SessionError::UnsupportedCapability(error.to_string())
                })?;
        }
        config.host.kind = HostKind::Android;
        self.session.load_manifest_json(manifest_json, config)?;
        self.initialized = true;
        Ok(())
    }

    pub fn has_session(&self) -> bool {
        self.session.has_session()
    }

    /// Called on the runtime owner thread after the platform submits this
    /// exact frame for presentation. GPU completion is a separate observation.
    pub fn acknowledge_presentation_json(
        &mut self,
        revision: u64,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.acknowledge_presentation_json(revision)
    }

    /// Return the build-time and session-time renderer capabilities as one
    /// versioned JSON value.  `build.nativeSurface` describes the compiled
    /// Skia boundary, while `runtime.nativeSurface` only becomes true after a
    /// frame has been committed.  `gpuSurface` remains false until a platform
    /// adapter attaches an actual GPU context; a raster readback is never
    /// promoted to device evidence.
    pub fn capabilities_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let info = self.info();
        let runtime = if self.session.has_session() {
            let renderer = self.session.renderer_backend()?;
            let native_surface = self.session.has_native_surface()?;
            let gpu_surface = self.session.has_gpu_surface()?;
            serde_json::json!({
                "loaded": true,
                "renderer": renderer,
                "nativeSurface": native_surface,
                "gpuSurface": gpu_surface,
            })
        } else {
            serde_json::json!({
                "loaded": false,
                "renderer": serde_json::Value::Null,
                "nativeSurface": false,
                "gpuSurface": false,
            })
        };
        let graphics = match info.graphics {
            GraphicsBackend::Stub => "stub",
            GraphicsBackend::OpenGlEs => "gles",
            GraphicsBackend::Vulkan => "vulkan",
        };
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "platform": info.platform,
            "graphicsBackend": graphics,
            "build": {
                "nativeSurface": info.capabilities.native_surface,
                "renderer": info.capabilities.renderer,
                "gpuSurface": info.capabilities.gpu_surface,
                "quickjs": info.capabilities.quickjs,
                "v8": info.capabilities.v8,
            },
            "runtime": runtime,
        }))
        .expect("host capabilities are serializable"))
    }

    pub fn session_initialized(&self) -> bool {
        self.session.initialized()
    }

    pub fn dispatch(&mut self, envelope: BridgeEnvelope) -> Result<BridgeBatch, HostSessionError> {
        self.session.dispatch(envelope)
    }

    /// Poll all due timers using the host-provided clock and return one
    /// complete bridge batch. The host event loop should call this regularly.
    pub fn poll_timers(&mut self, now_ns: u64) -> Result<BridgeBatch, HostSessionError> {
        self.session.poll_timers(now_ns)
    }

    pub fn start_session(
        &mut self,
        request_id: impl Into<String>,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.session.start(request_id)
    }

    pub fn dispatch_lifecycle(
        &mut self,
        request_id: impl Into<String>,
        event: impl Into<String>,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.session.lifecycle(request_id, event)
    }

    /// JNI/NDK bindings should marshal one complete batch per call.
    pub fn dispatch_json(
        &mut self,
        envelope_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_json(envelope_json)
    }

    /// Dispatch the canonical bridge batch shape in one JNI/NDK boundary
    /// crossing. Batch validation happens before runtime mutation.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_batch_json(batch_json)
    }

    /// Read one complete RGBA snapshot for upload to an Android surface.
    pub fn render_snapshot_json(&mut self) -> Result<Vec<u8>, HostSessionError> {
        // Explicit diagnostic capture; normal native presentation uses frame metadata.
        Ok(serde_json::to_vec(
            &self.session.capture_render_snapshot()?,
        )?)
    }

    /// True only when the Android host has attached a GLES/Vulkan-backed GPU
    /// context. A Skia CPU raster readback remains diagnostic evidence.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_gpu_surface()
    }

    /// Attach the current EGL/GLES context to the shared Skia Ganesh
    /// renderer. The call must run on the thread where EGL made the context
    /// current; a context probe or GLES texture blit alone is insufficient.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session.attach_gles_context()
    }

    /// Render the last committed frame into the currently bound window FBO.
    /// The Android surface owner performs `eglSwapBuffers` after this call.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn render_last_frame_to_gles_framebuffer(
        &mut self,
        framebuffer: u32,
        width: u32,
        height: u32,
    ) -> Result<(), HostSessionError> {
        self.session
            .render_last_frame_to_gles_framebuffer(framebuffer, width, height)
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn detach_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session.detach_gles_context()
    }

    /// Invalidate GPU handles without GL calls after an unbindable/lost context.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn abandon_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session.abandon_gles_context()
    }

    /// Read one complete Canvas 2D surface snapshot by id for GLES/Vulkan
    /// upload. This remains one JSON/byte boundary crossing per draw batch.
    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        self.session.canvas_snapshot_json(canvas_id)
    }

    /// JSON batch counterpart for bindings that cross a native/WASM boundary.
    pub fn poll_timers_json(&mut self, now_ns: u64) -> Result<Vec<u8>, HostSessionError> {
        self.session.poll_timers_json(now_ns)
    }

    pub fn notify_viewport_resize_json(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.notify_viewport_resize_json(width, height)
    }

    pub fn notify_window_metrics_json(
        &mut self,
        input: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.notify_window_metrics_json(input)
    }

    /// Lightweight committed-frame metadata for normal presentation. No pixels,
    /// page data or render-tree nodes cross this boundary.
    pub fn presentation_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let frame = session
            .accepted_page_observation()
            .map(|observation| observation.frame)
            .map(
                |frame| serde_json::json!({"frame_id": frame.frame_id, "viewport": frame.viewport}),
            );
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session.config().session_id,
            "viewport": {"width": session.config().host.window_width, "height": session.config().host.window_height},
            "viewRevision": session.view().revision,
            "renderRevision": session.render_revision(),
            "frame": frame,
        }))?)
    }

    /// Development inspection is one complete snapshot, with no engine calls
    /// and no per-node JNI traffic. The sample writes it only in debug builds.
    pub fn inspect_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let page = session.app_service().pages().current().map(
            |page| serde_json::json!({"id": page.id.0, "route": page.path, "data": page.data}),
        );
        Ok(serde_json::to_vec(&serde_json::json!({
            "sessionId": session.config().session_id,
            "viewport": {"width": session.config().host.window_width, "height": session.config().host.window_height},
            "displayMetrics": session.config().host.display_metrics,
            "page": page,
            "frame": session.accepted_page_observation().map(|observation| observation.frame),
        }))?)
    }

    pub fn unload(&mut self) {
        self.session.unload();
        self.initialized = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renderer_profile_preflight_preserves_the_previous_native_session() {
        let mut host = AndroidHost::new();
        host.load_manifest_json(manifest(), SessionConfig::default())
            .unwrap();
        let mut next: serde_json::Value = serde_json::from_slice(&manifest()).unwrap();
        next["schemaVersion"] = serde_json::json!(3);
        next["rendering"] =
            serde_json::json!({"version": "1.0", "default": "webview", "pages": {}});
        let error = host
            .load_manifest_json(serde_json::to_vec(&next).unwrap(), SessionConfig::default())
            .unwrap_err();
        assert!(matches!(
            error,
            HostSessionError::Session(container_runtime::SessionError::UnsupportedCapability(_))
        ));
        assert!(host.has_session());
        for profile in ["skia", "skyline-compat"] {
            next["rendering"]["default"] = serde_json::json!(profile);
            host.load_manifest_json(serde_json::to_vec(&next).unwrap(), SessionConfig::default())
                .unwrap();
        }
    }
    use container_host_common::FfiBuffer;
    use std::slice;

    #[cfg(feature = "skia-gpu-gles")]
    #[test]
    fn abandon_gles_ffi_is_idempotent_before_load_without_current_context() {
        assert_eq!(
            unsafe { ffi::weapp_container_android_host_abandon_gles_context(std::ptr::null_mut()) },
            container_host_common::FFI_INVALID_ARGUMENT
        );
        let host = ffi::weapp_container_android_host_new();
        // No EGL context or manifest exists. Error cleanup must still be safe
        // to call repeatedly, including before asynchronous loading completes.
        for _ in 0..2 {
            assert_eq!(
                unsafe { ffi::weapp_container_android_host_abandon_gles_context(host) },
                container_host_common::FFI_OK
            );
        }
        unsafe { ffi::weapp_container_android_host_free(host) };
    }

    #[test]
    fn configured_ffi_retains_session_after_invalid_engine_and_preserves_session_id() {
        if !engine_provider_compiled(EngineKind::Quickjs) {
            return;
        }
        let host = ffi::weapp_container_android_host_new();
        let manifest = manifest();
        let config = br#"{"engine":"quickjs","session_id":"android-explicit"}"#;
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_load_manifest_with_config(
                    host,
                    manifest.as_ptr(),
                    manifest.len(),
                    config.as_ptr(),
                    config.len(),
                    &mut output,
                )
            },
            0
        );
        let invalid = br#"{"engine":"unavailable-engine"}"#;
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_load_manifest_with_config(
                    host,
                    manifest.as_ptr(),
                    manifest.len(),
                    invalid.as_ptr(),
                    invalid.len(),
                    &mut output,
                )
            },
            -1
        );
        let error: serde_json::Value =
            serde_json::from_slice(unsafe { slice::from_raw_parts(output.data, output.len) })
                .unwrap();
        assert_eq!(error["error"]["code"], "ERR_ENGINE");
        unsafe { ffi::weapp_container_android_buffer_free(&mut output) };
        let request = b"configured-start";
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_start(
                    host,
                    request.as_ptr(),
                    request.len(),
                    &mut output,
                )
            },
            0
        );
        let batch: serde_json::Value =
            serde_json::from_slice(unsafe { slice::from_raw_parts(output.data, output.len) })
                .unwrap();
        assert_eq!(batch["messages"][0]["sessionId"], "android-explicit");
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut output);
            ffi::weapp_container_android_host_free(host);
        }
    }

    #[test]
    fn configured_ffi_reports_unavailable_native_engines_without_fallback() {
        for engine in [EngineKind::Quickjs, EngineKind::V8] {
            if engine_provider_compiled(engine) {
                continue;
            }
            let host = ffi::weapp_container_android_host_new();
            let manifest = manifest();
            let config = serde_json::to_vec(
                &serde_json::json!({"engine": engine, "session_id": "android-native"}),
            )
            .unwrap();
            let mut output = FfiBuffer::empty();
            assert_eq!(
                unsafe {
                    ffi::weapp_container_android_host_load_manifest_with_config(
                        host,
                        manifest.as_ptr(),
                        manifest.len(),
                        config.as_ptr(),
                        config.len(),
                        &mut output,
                    )
                },
                -1
            );
            let error: serde_json::Value =
                serde_json::from_slice(unsafe { slice::from_raw_parts(output.data, output.len) })
                    .unwrap();
            assert_eq!(error["error"]["code"], "ERR_ENGINE");
            assert!(!unsafe { &*host }.has_session());
            unsafe {
                ffi::weapp_container_android_buffer_free(&mut output);
                ffi::weapp_container_android_host_free(host);
            }
        }
    }

    #[test]
    fn window_metrics_ffi_updates_whole_observation_and_retains_state_on_invalid_json() {
        let mut adapter = AndroidHost::default();
        adapter
            .load_manifest_json(manifest(), SessionConfig::default())
            .unwrap();
        adapter.start_session("init").unwrap();
        let host = Box::into_raw(Box::new(adapter));
        let valid = br#"{"windowWidth":393,"windowHeight":800,"pixelRatio":2.75,"screenWidth":393,"screenHeight":873,"statusBarHeight":24,"screenTop":0,"deviceOrientation":"portrait"}"#;
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_update_window_metrics_json(
                    host,
                    valid.as_ptr(),
                    valid.len(),
                    &mut output,
                )
            },
            0
        );
        unsafe { ffi::weapp_container_android_buffer_free(&mut output) };
        let before = unsafe { &*host }.inspect_state_json().unwrap();
        let observed: serde_json::Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(observed["viewport"]["width"], 393);
        assert_eq!(observed["displayMetrics"]["pixelRatio"], 2.75);
        assert!(observed["displayMetrics"].get("safeArea").is_none());
        let invalid = br#"{"windowWidth":1,"windowHeight":2,"pixelRatio":0}"#;
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_update_window_metrics_json(
                    host,
                    invalid.as_ptr(),
                    invalid.len(),
                    &mut output,
                )
            },
            -1
        );
        assert_eq!(unsafe { &*host }.inspect_state_json().unwrap(), before);
        let error: serde_json::Value =
            serde_json::from_slice(unsafe { slice::from_raw_parts(output.data, output.len) })
                .unwrap();
        assert_eq!(error["error"]["code"], "ERR_RENDER");
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut output);
            ffi::weapp_container_android_host_free(host);
        }
    }

    fn manifest() -> Vec<u8> {
        serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": "1.0",
            "compiler": {"name": "weapp-vite", "commit": "android-ffi-test", "platform": "weapp"},
            "app": {"appJson": "app.json", "entryModule": "app.js"},
            "capabilities": {"wx.canvas.draw": "partial"},
            "integrity": {"algorithm": "sha256", "root": ""}
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn does_not_claim_device_validation() {
        assert_eq!(HostInfo::current().platform, "android");
        assert_eq!(
            HostInfo::current().capabilities.native_surface,
            cfg!(all(
                feature = "android",
                any(feature = "skia-backend", feature = "skia-gpu-gles")
            ))
        );
        assert_eq!(
            HostInfo::current().capabilities.renderer,
            if cfg!(all(
                feature = "android",
                any(feature = "skia-backend", feature = "skia-gpu-gles")
            )) {
                "skia-raster"
            } else {
                "software-fallback"
            }
        );
        assert_eq!(
            HostInfo::current().capabilities.quickjs,
            engine_provider_compiled(EngineKind::Quickjs)
        );
        assert_eq!(
            HostInfo::current().capabilities.v8,
            engine_provider_compiled(EngineKind::V8)
        );
    }

    #[test]
    fn capabilities_report_keeps_build_and_runtime_surfaces_separate() {
        let host = AndroidHost::new();
        let report: serde_json::Value = serde_json::from_slice(&host.capabilities_json().unwrap())
            .expect("capability report is JSON");
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["platform"], "android");
        assert_eq!(report["runtime"]["loaded"], false);
        assert_eq!(report["runtime"]["gpuSurface"], false);
        assert_eq!(report["build"]["gpuSurface"], false);
    }

    #[test]
    fn ffi_loads_manifest_and_returns_one_batch() {
        let host = ffi::weapp_container_android_host_new();
        let mut capabilities = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_android_host_capabilities(host, &mut capabilities) },
            0
        );
        let capability_value: serde_json::Value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(capabilities.data, capabilities.len)
        })
        .unwrap();
        assert_eq!(capability_value["platform"], "android");
        unsafe { ffi::weapp_container_android_buffer_free(&mut capabilities) };
        let manifest = manifest();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_load_manifest(
                    host,
                    manifest.as_ptr(),
                    manifest.len(),
                )
            },
            0
        );
        let request = b"android-test";
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_start(
                    host,
                    request.as_ptr(),
                    request.len(),
                    &mut output,
                )
            },
            0
        );
        let bytes = unsafe { slice::from_raw_parts(output.data, output.len) };
        assert!(std::str::from_utf8(bytes).unwrap().contains("app.init"));
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut output);
        }
        let batch = serde_json::json!({
            "messages": [
                {"protocolVersion":"1.0", "sessionId":"session-1", "requestId":"diag-1",
                 "kind":"request", "op":"diagnostic", "payload":{}},
                {"protocolVersion":"1.0", "sessionId":"session-1", "requestId":"diag-2",
                 "kind":"request", "op":"diagnostic", "payload":{}}
            ]
        })
        .to_string();
        let mut batch_output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_dispatch_batch_json(
                    host,
                    batch.as_ptr(),
                    batch.len(),
                    &mut batch_output,
                )
            },
            0
        );
        let batch_bytes = unsafe { slice::from_raw_parts(batch_output.data, batch_output.len) };
        let parsed: serde_json::Value = serde_json::from_slice(batch_bytes).unwrap();
        assert_eq!(parsed["messages"].as_array().unwrap().len(), 2);
        unsafe { ffi::weapp_container_android_buffer_free(&mut batch_output) };
        let render = serde_json::json!({
            "protocolVersion": "1.0", "sessionId": "session-1", "requestId": "render-1",
            "kind": "request", "op": "render.commit", "payload": {
                "frameId": 1,
                "viewport": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                "root": {"id": "root", "bounds": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                    "background": {"red": 1, "green": 2, "blue": 3, "alpha": 255},
                    "opacity": 1.0, "children": []}
            }
        })
        .to_string();
        let mut render_output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_dispatch_json(
                    host,
                    render.as_ptr(),
                    render.len(),
                    &mut render_output,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut render_output);
        }
        let canvas = serde_json::json!({
            "protocolVersion": "1.0", "sessionId": "session-1", "requestId": "canvas-1",
            "kind": "request", "op": "api.call", "payload": {
                "name": "wx.canvas.draw", "canvasId": "main", "width": 1, "height": 1,
                "commands": [
                    {"op": "setFillStyle", "args": ["#0a141e"]},
                    {"op": "fillRect", "args": [0, 0, 1, 1]}
                ]
            }
        })
        .to_string();
        let mut canvas_dispatch = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_dispatch_json(
                    host,
                    canvas.as_ptr(),
                    canvas.len(),
                    &mut canvas_dispatch,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut canvas_dispatch);
        }
        let canvas_id = b"main";
        let mut canvas_snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_android_host_canvas_snapshot(
                    host,
                    canvas_id.as_ptr(),
                    canvas_id.len(),
                    &mut canvas_snapshot,
                )
            },
            0
        );
        let canvas_bytes =
            unsafe { slice::from_raw_parts(canvas_snapshot.data, canvas_snapshot.len) };
        assert!(std::str::from_utf8(canvas_bytes)
            .unwrap()
            .contains("\"width\":1"));
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut canvas_snapshot);
        }
        let mut snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_android_host_render_snapshot(host, &mut snapshot) },
            0
        );
        let snapshot_bytes = unsafe { slice::from_raw_parts(snapshot.data, snapshot.len) };
        assert!(std::str::from_utf8(snapshot_bytes)
            .unwrap()
            .contains("rgba8-premultiplied"));
        unsafe {
            ffi::weapp_container_android_buffer_free(&mut snapshot);
            ffi::weapp_container_android_host_free(host);
        }
    }
}
