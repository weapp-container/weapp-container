//! iOS staticlib/Swift bridge boundary. Metal integration is opt-in.

use container_bridge::{BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_core::LifecycleState;
use container_host_common::{HostSession, HostSessionError};
use container_runtime::{engine_provider_compiled, HostKind, SessionConfig};
#[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
use std::ffi::c_void;

pub mod ffi;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GraphicsBackend {
    Stub,
    Metal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCapabilities {
    pub ios: bool,
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
        let graphics = if cfg!(feature = "metal") {
            GraphicsBackend::Metal
        } else {
            GraphicsBackend::Stub
        };
        // The `metal` feature forwards `skia-gpu-metal`; it does not need
        // the plain `skia-backend` alias to compile the Ganesh attachment
        // path. Keep build metadata aligned with the compiled boundary while
        // `gpu_surface` remains false until a drawable receives a frame.
        let native_skia = cfg!(all(
            feature = "ios",
            any(feature = "skia-backend", feature = "skia-gpu-metal")
        ));
        Self {
            platform: "ios",
            graphics,
            capabilities: HostCapabilities {
                ios: true,
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
pub struct IosHost {
    initialized: bool,
    session: HostSession,
}

impl IosHost {
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

    /// Swift/Objective-C callers use the same JSON bridge contract as other
    /// hosts; the renderer and Metal surface stay outside this boundary.
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
        config.host.kind = HostKind::Ios;
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

    /// Return build-time and runtime renderer capabilities in one stable JSON
    /// object.  A CPU raster surface is reported separately from a GPU
    /// context so host probes cannot treat a readable snapshot as Metal
    /// evidence.
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
            GraphicsBackend::Metal => "metal",
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

    /// Lightweight live navigation and render metadata for the native event
    /// loop. This never serializes the view tree or an RGBA snapshot.
    pub fn session_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let page = session
            .app_service()
            .pages()
            .current()
            .map(|page| serde_json::json!({"id": page.id.0, "route": page.path}));
        let frame_id = session
            .accepted_page_observation()
            .map(|observation| observation.frame)
            .map(|frame| frame.frame_id);
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session.config().session_id,
            "viewport": {
                "width": session.config().host.window_width,
                "height": session.config().host.window_height,
            },
            "page": page,
            "frameId": frame_id,
            "viewRevision": session.view().revision,
            "renderRevision": session.render_revision(),
        }))
        .expect("session metadata is serializable"))
    }

    /// Opt-in development observation of the current page as one batch. This
    /// does not enter JS, advance timers or include pixels/the render tree.
    /// Applications must not expose their data through public accessibility
    /// values; the embedding verification app explicitly enables that mode.
    pub fn inspect_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let page = session.app_service().pages().current().map(
            |page| serde_json::json!({"id": page.id.0, "route": page.path, "data": page.data}),
        );
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session.config().session_id,
            "page": page,
            "frameId": session.accepted_page_observation().map(|observation| observation.frame).map(|frame| frame.frame_id),
            "viewRevision": session.view().revision,
        }))?)
    }

    /// Update logical viewport geometry and dispatch resize hooks without
    /// replacing the AppService. The caller owns the next render commit.
    pub fn notify_viewport_resize_json(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.notify_viewport_resize_json(width, height)
    }

    pub fn dispatch(&mut self, envelope: BridgeEnvelope) -> Result<BridgeBatch, HostSessionError> {
        self.session.dispatch(envelope)
    }

    /// Poll all due timers using Unix-epoch nanoseconds and return one
    /// complete bridge batch. The host event loop should call this regularly;
    /// display-link uptime or session-relative elapsed time is not this clock.
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

    pub fn dispatch_json(
        &mut self,
        envelope_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_json(envelope_json)
    }

    /// Dispatch the canonical bridge batch shape in one Swift/Objective-C
    /// boundary crossing. Batch validation happens before runtime mutation.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_batch_json(batch_json)
    }

    /// Read one complete RGBA snapshot for upload to a Metal-backed surface.
    pub fn render_snapshot_json(&mut self) -> Result<Vec<u8>, HostSessionError> {
        // Explicit diagnostic capture; normal native presentation uses frame metadata.
        Ok(serde_json::to_vec(
            &self.session.capture_render_snapshot()?,
        )?)
    }

    /// True only after the iOS host attaches a Metal-backed surface.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_gpu_surface()
    }

    /// Attach the app-owned Metal device and command queue to the Rust Skia
    /// renderer. The context remains thread-affine to the caller's Metal
    /// surface owner; attaching it alone does not report a GPU surface.
    ///
    /// # Safety
    ///
    /// `device` and `queue` must be live Objective-C `MTLDevice` and
    /// `MTLCommandQueue` objects from the same device. They must remain valid
    /// for the lifetime of the loaded host session.
    #[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const c_void,
        queue: *const c_void,
    ) -> Result<(), HostSessionError> {
        self.session.attach_metal_context(device, queue)
    }

    /// Render the last committed frame directly into a CAMetalLayer drawable
    /// texture. The caller owns drawable presentation and command-buffer
    /// commit; the runtime only records and flushes Skia Ganesh commands.
    ///
    /// # Safety
    ///
    /// `texture` must be a live `MTLTexture` from the current drawable and
    /// remain alive until the caller commits its command buffer.
    #[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const c_void,
        width: u32,
        height: u32,
    ) -> Result<(), HostSessionError> {
        self.session
            .render_last_frame_to_metal_texture(texture, width, height)
    }

    #[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
    pub fn detach_metal_context(&mut self) -> Result<(), HostSessionError> {
        self.session.detach_metal_context()
    }

    /// Read one complete Canvas 2D surface snapshot by id for Metal upload.
    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        self.session.canvas_snapshot_json(canvas_id)
    }

    /// JSON batch counterpart for bindings that cross a native/WASM boundary.
    pub fn poll_timers_json(&mut self, now_ns: u64) -> Result<Vec<u8>, HostSessionError> {
        self.session.poll_timers_json(now_ns)
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
        let mut host = IosHost::new();
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
    use container_bridge::op;
    use container_host_common::{FfiBuffer, FFI_ERR, FFI_INVALID_ARGUMENT, FFI_OK};
    use serde_json::{json, Value};
    use std::slice;

    fn manifest() -> Vec<u8> {
        serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": "1.0",
            "compiler": {"name": "weapp-vite", "commit": "ios-ffi-test", "platform": "weapp"},
            "app": {"appJson": "app.json", "entryModule": "app.js"},
            "capabilities": {"wx.canvas.draw": "partial"},
            "integrity": {"algorithm": "sha256", "root": ""}
        })
        .to_string()
        .into_bytes()
    }

    fn take_json(output: &mut FfiBuffer) -> Value {
        assert!(!output.data.is_null());
        let value =
            serde_json::from_slice(unsafe { slice::from_raw_parts(output.data, output.len) })
                .unwrap();
        unsafe { ffi::weapp_container_ios_buffer_free(output) };
        assert!(output.data.is_null());
        assert_eq!(output.len, 0);
        value
    }

    #[test]
    fn lightweight_state_and_resize_require_a_loaded_session() {
        let mut host = IosHost::new();
        assert!(matches!(
            host.session_state_json(),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.inspect_state_json(),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.notify_viewport_resize_json(320, 480),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.poll_timers_json(1_000_000_000),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn resize_keeps_session_page_data_and_last_commit_and_state_follows_navigation() {
        let mut host = IosHost::new();
        let config = SessionConfig {
            session_id: "ios-live".into(),
            ..SessionConfig::default()
        };
        host.load_manifest_json(manifest(), config).unwrap();
        let empty: Value = serde_json::from_slice(&host.session_state_json().unwrap()).unwrap();
        assert_eq!(empty["schemaVersion"], 1);
        assert_eq!(empty["sessionId"], "ios-live");
        assert!(empty["page"].is_null());
        assert!(empty["frameId"].is_null());
        host.start_session("init").unwrap();
        host.dispatch_lifecycle("launch", "launch").unwrap();
        let page = host
            .dispatch(BridgeEnvelope::request(
                "ios-live",
                "first-page",
                op::PAGE_PUSH,
                json!({"path":"pages/first", "data":{"count":3}}),
            ))
            .unwrap();
        assert_eq!(page.messages[0].payload["ok"], true);
        let page_id = host
            .session
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id;
        let rendered = host
            .dispatch(BridgeEnvelope::request(
                "ios-live",
                "frame",
                op::RENDER_COMMIT,
                json!({
                    "frameId":41,
                    "viewport":{"x":0,"y":0,"width":2,"height":3},
                    "root":{"id":"root", "bounds":{"x":0,"y":0,"width":2,"height":3},
                        "opacity":1,"children":[]}
                }),
            ))
            .unwrap();
        assert_eq!(rendered.messages[0].payload["committed"], true);
        let before: Value = serde_json::from_slice(&host.session_state_json().unwrap()).unwrap();
        assert_eq!(
            before["page"],
            json!({"id":page_id.0,"route":"pages/first"})
        );
        assert_eq!(before["frameId"], 41);
        assert_eq!(
            before["viewRevision"],
            host.session.session().unwrap().view().revision
        );
        assert_eq!(before["renderRevision"], 1);
        assert_ne!(before["renderRevision"], before["frameId"]);
        assert_eq!(before["renderRevision"], host.session.render_revision());
        let mut fields: Vec<&str> = before
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        fields.sort_unstable();
        assert_eq!(
            fields,
            [
                "frameId",
                "page",
                "renderRevision",
                "schemaVersion",
                "sessionId",
                "viewRevision",
                "viewport"
            ]
        );
        let inspected: Value = serde_json::from_slice(&host.inspect_state_json().unwrap()).unwrap();
        assert_eq!(inspected["schemaVersion"], 1);
        assert_eq!(inspected["sessionId"], "ios-live");
        assert_eq!(inspected["page"]["data"], json!({"count":3}));
        assert_eq!(inspected["page"]["id"], page_id.0);
        assert_eq!(inspected["frameId"], 41);
        assert!(inspected.get("frame").is_none());
        assert_eq!(
            host.session_state_json().unwrap(),
            serde_json::to_vec(&before).unwrap()
        );

        let resized: BridgeBatch =
            serde_json::from_slice(&host.notify_viewport_resize_json(390, 844).unwrap()).unwrap();
        assert_eq!(resized.messages[0].payload["type"], "host.resize");
        let after: Value = serde_json::from_slice(&host.session_state_json().unwrap()).unwrap();
        assert_eq!(after["sessionId"], before["sessionId"]);
        assert_eq!(after["page"], before["page"]);
        assert_eq!(after["frameId"], 41); // Geometry updates do not invent a new frame.
        assert_eq!(after["viewport"], json!({"width":390,"height":844}));
        assert_eq!(host.lifecycle_state().unwrap(), LifecycleState::Active);
        assert_eq!(
            host.session
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data,
            json!({"count":3})
        );
        assert!(host.notify_viewport_resize_json(0, 844).is_err());
        assert_eq!(
            host.session_state_json().unwrap(),
            serde_json::to_vec(&after).unwrap()
        );
        let duplicate: BridgeBatch =
            serde_json::from_slice(&host.notify_viewport_resize_json(390, 844).unwrap()).unwrap();
        assert!(duplicate.messages.is_empty());

        let pushed = host
            .dispatch(BridgeEnvelope::request(
                "ios-live",
                "second-page",
                op::PAGE_PUSH,
                json!({"path":"pages/second"}),
            ))
            .unwrap();
        assert_eq!(pushed.messages[0].payload["ok"], true);
        let navigated: Value = serde_json::from_slice(&host.session_state_json().unwrap()).unwrap();
        assert_eq!(navigated["page"]["route"], "pages/second");
        assert_ne!(navigated["page"]["id"], before["page"]["id"]);
        assert_eq!(navigated["frameId"], 41);
    }

    #[test]
    fn ffi_session_operations_validate_null_handles_and_output_slots() {
        let host = ffi::weapp_container_ios_host_new();
        let mut output = FfiBuffer::empty();
        unsafe {
            assert_eq!(
                ffi::weapp_container_ios_host_session_state(host, std::ptr::null_mut()),
                FFI_INVALID_ARGUMENT
            );
            assert_eq!(
                ffi::weapp_container_ios_host_inspect_state(host, std::ptr::null_mut()),
                FFI_INVALID_ARGUMENT
            );
            assert_eq!(
                ffi::weapp_container_ios_host_resize_viewport(host, 1, 1, std::ptr::null_mut()),
                FFI_INVALID_ARGUMENT
            );
            assert_eq!(
                ffi::weapp_container_ios_host_poll_timers(host, 0, std::ptr::null_mut()),
                FFI_INVALID_ARGUMENT
            );
            assert_eq!(
                ffi::weapp_container_ios_host_session_state(std::ptr::null(), &mut output),
                FFI_ERR
            );
        }
        assert_eq!(take_json(&mut output)["error"], "host handle is null");
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_inspect_state(std::ptr::null(), &mut output) },
            FFI_ERR
        );
        assert_eq!(take_json(&mut output)["error"], "host handle is null");
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_inspect_state(host, &mut output) },
            FFI_ERR
        );
        assert!(take_json(&mut output)["error"]
            .as_str()
            .unwrap()
            .contains("loaded"));
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_resize_viewport(
                    std::ptr::null_mut(),
                    1,
                    1,
                    &mut output,
                )
            },
            FFI_ERR
        );
        assert_eq!(take_json(&mut output)["error"], "host handle is null");
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_poll_timers(std::ptr::null_mut(), 0, &mut output)
            },
            FFI_ERR
        );
        assert_eq!(take_json(&mut output)["error"], "host handle is null");
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_unload(std::ptr::null_mut()) },
            FFI_INVALID_ARGUMENT
        );
        unsafe { ffi::weapp_container_ios_host_free(host) };
    }

    #[test]
    fn ffi_state_resize_and_idempotent_unload_preserve_handle_and_release_session() {
        let mut owner = Box::new(IosHost::new());
        owner
            .load_manifest_json(manifest(), SessionConfig::default())
            .unwrap();
        owner.start_session("init").unwrap();
        let host = Box::into_raw(owner);
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_session_state(host, &mut output) },
            FFI_OK
        );
        assert_eq!(take_json(&mut output)["sessionId"], "session-1");
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_resize_viewport(host, 320, 480, &mut output) },
            FFI_OK
        );
        assert_eq!(
            take_json(&mut output)["messages"][0]["payload"]["type"],
            "host.resize"
        );
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_session_state(host, &mut output) },
            FFI_OK
        );
        assert_eq!(
            take_json(&mut output)["viewport"],
            json!({"width":320,"height":480})
        );
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_unload(host) },
            FFI_OK
        );
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_unload(host) },
            FFI_OK
        );
        assert!(!unsafe { &*host }.has_session());
        assert!(!unsafe { &*host }.is_initialized());
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_session_state(host, &mut output) },
            FFI_ERR
        );
        assert_eq!(
            take_json(&mut output)["error"],
            "host session has no loaded manifest"
        );
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_resize_viewport(host, 320, 480, &mut output) },
            FFI_ERR
        );
        assert_eq!(
            take_json(&mut output)["error"],
            "host session has no loaded manifest"
        );
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_poll_timers(host, u64::MAX, &mut output) },
            FFI_ERR
        );
        assert_eq!(
            take_json(&mut output)["error"],
            "host session has no loaded manifest"
        );
        unsafe { &mut *host }
            .load_manifest_json(manifest(), SessionConfig::default())
            .unwrap();
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_session_state(host, &mut output) },
            FFI_OK
        );
        assert!(take_json(&mut output)["frameId"].is_null());
        unsafe { ffi::weapp_container_ios_host_free(host) };
    }

    #[test]
    fn ios_timer_poll_uses_epoch_deadlines_in_one_complete_batch() {
        let mut host = IosHost::new();
        let mut manifest: Value = serde_json::from_slice(&manifest()).unwrap();
        // Public timer names resolve through the manifest's wx.timer
        // capability. A canvas-only fixture correctly rejects setTimeout.
        manifest["capabilities"]["wx.timer"] = json!("partial");
        host.load_manifest_json(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
        )
        .unwrap();
        let init = host.start_session("init").unwrap();
        assert_eq!(init.messages[0].payload["ok"], true);
        let set = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "timer",
                op::API_CALL,
                json!({"name":"setTimeout", "delayMs":1, "callbackId":"ios-callback"}),
            ))
            .unwrap();
        assert_eq!(set.messages.len(), 1);
        assert_eq!(set.messages[0].op, op::API_CALL);
        assert_eq!(set.messages[0].request_id, "timer");
        let acknowledgement = &set.messages[0].payload;
        assert_eq!(acknowledgement["ok"], true, "{acknowledgement}");
        assert_eq!(acknowledgement["name"], "setTimeout");
        assert_eq!(acknowledgement["support"], "partial");
        let timer_id = acknowledgement["timerId"]
            .as_u64()
            .expect("a successful setTimeout response contains a numeric timerId");
        let due_ns = host
            .session
            .session()
            .unwrap()
            .app_service()
            .timers()
            .entries()
            .find(|timer| timer.id.0 == timer_id)
            .unwrap()
            .due_ns;
        assert!(due_ns > 1_000_000_000_000_000_000);
        let early: BridgeBatch =
            serde_json::from_slice(&host.poll_timers_json(1_000_000_000).unwrap()).unwrap();
        assert!(early.messages.is_empty());
        let fired: BridgeBatch =
            serde_json::from_slice(&host.poll_timers_json(due_ns).unwrap()).unwrap();
        assert_eq!(fired.messages[0].payload["type"], "timer");
        assert_eq!(
            fired.messages[0].payload["timers"][0]["callbackId"],
            "ios-callback"
        );
    }

    #[test]
    fn exposes_ios_platform_metadata() {
        assert_eq!(HostInfo::current().platform, "ios");
        assert_eq!(
            HostInfo::current().capabilities.native_surface,
            cfg!(all(
                feature = "ios",
                any(feature = "skia-backend", feature = "skia-gpu-metal")
            ))
        );
        assert_eq!(
            HostInfo::current().capabilities.renderer,
            if cfg!(all(
                feature = "ios",
                any(feature = "skia-backend", feature = "skia-gpu-metal")
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
        let host = IosHost::new();
        let report: serde_json::Value = serde_json::from_slice(&host.capabilities_json().unwrap())
            .expect("capability report is JSON");
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["platform"], "ios");
        assert_eq!(report["runtime"]["loaded"], false);
        assert_eq!(report["runtime"]["gpuSurface"], false);
        assert_eq!(report["build"]["gpuSurface"], false);
    }

    #[test]
    fn ffi_explicit_configuration_selects_session_and_preserves_it_on_invalid_engine() {
        let host = ffi::weapp_container_ios_host_new();
        let manifest = manifest();
        let config = br#"{"engine":"quickjs","session_id":"ios-explicit"}"#;
        let mut output = FfiBuffer::empty();
        if !engine_provider_compiled(EngineKind::Quickjs) {
            assert_eq!(
                unsafe {
                    ffi::weapp_container_ios_host_load_manifest_with_config(
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
                ffi::weapp_container_ios_buffer_free(&mut output);
                ffi::weapp_container_ios_host_free(host);
            }
            return;
        }
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_load_manifest_with_config(
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
                ffi::weapp_container_ios_host_load_manifest_with_config(
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
        unsafe { ffi::weapp_container_ios_buffer_free(&mut output) };
        let request = b"configured-start";
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_start(
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
        assert_eq!(batch["messages"][0]["sessionId"], "ios-explicit");
        unsafe {
            ffi::weapp_container_ios_buffer_free(&mut output);
            ffi::weapp_container_ios_host_free(host);
        }
    }

    #[test]
    fn ffi_loads_manifest_and_returns_one_batch() {
        let host = ffi::weapp_container_ios_host_new();
        let mut capabilities = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_capabilities(host, &mut capabilities) },
            0
        );
        let capability_value: serde_json::Value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(capabilities.data, capabilities.len)
        })
        .unwrap();
        assert_eq!(capability_value["platform"], "ios");
        unsafe { ffi::weapp_container_ios_buffer_free(&mut capabilities) };
        let manifest = manifest();
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_load_manifest(host, manifest.as_ptr(), manifest.len())
            },
            0
        );
        let request = b"ios-test";
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_start(
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
            ffi::weapp_container_ios_buffer_free(&mut output);
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
                ffi::weapp_container_ios_host_dispatch_batch_json(
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
        unsafe { ffi::weapp_container_ios_buffer_free(&mut batch_output) };
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
                ffi::weapp_container_ios_host_dispatch_json(
                    host,
                    render.as_ptr(),
                    render.len(),
                    &mut render_output,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_ios_buffer_free(&mut render_output);
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
                ffi::weapp_container_ios_host_dispatch_json(
                    host,
                    canvas.as_ptr(),
                    canvas.len(),
                    &mut canvas_dispatch,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_ios_buffer_free(&mut canvas_dispatch);
        }
        let canvas_id = b"main";
        let mut canvas_snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_ios_host_canvas_snapshot(
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
            ffi::weapp_container_ios_buffer_free(&mut canvas_snapshot);
        }
        let mut snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_ios_host_render_snapshot(host, &mut snapshot) },
            0
        );
        let snapshot_bytes = unsafe { slice::from_raw_parts(snapshot.data, snapshot.len) };
        assert!(std::str::from_utf8(snapshot_bytes)
            .unwrap()
            .contains("rgba8-premultiplied"));
        unsafe {
            ffi::weapp_container_ios_buffer_free(&mut snapshot);
            ffi::weapp_container_ios_host_free(host);
        }
    }
}
