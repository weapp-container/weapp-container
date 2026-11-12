//! Cross-desktop host boundary. Native window and GPU bindings are opt-in features.

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_core::LifecycleState;
use container_host_common::{HostSession, HostSessionError};
use container_render_skia::RenderSnapshot;
use container_runtime::{engine_provider_compiled, HostKind, SessionConfig};
use serde_json::{json, Value};
#[cfg(all(feature = "skia-gpu-metal", target_os = "macos"))]
use std::ffi::c_void;

#[cfg(feature = "window")]
mod window;

#[cfg(all(feature = "metal-window", target_os = "macos"))]
mod metal_window;

#[cfg(all(feature = "gl-window", any(target_os = "windows", target_os = "linux")))]
mod gl_window;

#[cfg(all(feature = "gl-window", any(target_os = "windows", target_os = "linux")))]
pub use gl_window::{GlWindowPresenter, GlWindowPresenterError};

#[cfg(feature = "window")]
pub use window::{DesktopWindowPresenter, WindowPresenterError, WindowSurfaceCapabilities};

#[cfg(all(feature = "metal-window", target_os = "macos"))]
pub use metal_window::{
    MetalWindowPresenter, MetalWindowPresenterError, MetalWindowSurfaceCapabilities,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopTarget {
    Macos,
    Windows,
    Linux,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCapabilities {
    pub desktop: bool,
    pub window_surface: bool,
    pub renderer: &'static str,
    /// A feature-enabled Skia raster surface is not a GPU context. This bit
    /// remains false until the host attaches a platform GPU surface.
    pub gpu_surface: bool,
    pub quickjs: bool,
    pub v8: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostInfo {
    pub platform: &'static str,
    pub target: DesktopTarget,
    pub capabilities: HostCapabilities,
}

/// Modifier state normalized by desktop event adapters before crossing the
/// runtime boundary.  The runtime receives one stable shape on macOS,
/// Windows and Linux even though each window toolkit names modifiers
/// differently.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct DesktopModifiers {
    pub shift: bool,
    pub control: bool,
    pub alt: bool,
    pub meta: bool,
}

impl DesktopModifiers {
    fn to_value(self) -> Value {
        json!({
            "shift": self.shift,
            "ctrl": self.control,
            "alt": self.alt,
            "meta": self.meta,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopPointerPhase {
    Down,
    Up,
    Move,
    Cancel,
}

impl DesktopPointerPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Down => "pointerdown",
            Self::Up => "pointerup",
            Self::Move => "pointermove",
            Self::Cancel => "pointercancel",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DesktopKeyPhase {
    Down,
    Up,
}

impl DesktopKeyPhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Down => "keydown",
            Self::Up => "keyup",
        }
    }
}

/// A platform-neutral desktop input event.  Adapters translate their native
/// winit/AppKit/Win32/X11 event into this value, then submit a whole vector
/// through [`DesktopHost::dispatch_input_batch`].
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopInputEvent {
    Pointer {
        phase: DesktopPointerPhase,
        x: f64,
        y: f64,
        button: Option<u8>,
        buttons: u16,
        modifiers: DesktopModifiers,
    },
    Wheel {
        x: f64,
        y: f64,
        delta_x: f64,
        delta_y: f64,
        modifiers: DesktopModifiers,
    },
    Key {
        phase: DesktopKeyPhase,
        code: String,
        key: String,
        repeat: bool,
        modifiers: DesktopModifiers,
    },
}

impl DesktopInputEvent {
    fn to_value(&self) -> Value {
        match self {
            Self::Pointer {
                phase,
                x,
                y,
                button,
                buttons,
                modifiers,
            } => json!({
                "type": phase.as_str(),
                "x": x,
                "y": y,
                "button": button,
                "buttons": buttons,
                "modifiers": modifiers.to_value(),
            }),
            Self::Wheel {
                x,
                y,
                delta_x,
                delta_y,
                modifiers,
            } => json!({
                "type": "wheel",
                "x": x,
                "y": y,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "modifiers": modifiers.to_value(),
            }),
            Self::Key {
                phase,
                code,
                key,
                repeat,
                modifiers,
            } => json!({
                "type": phase.as_str(),
                "code": code,
                "key": key,
                "repeat": repeat,
                "modifiers": modifiers.to_value(),
            }),
        }
    }
}

impl HostInfo {
    pub const fn for_target(target: DesktopTarget) -> Self {
        // `metal-window` forwards `skia-gpu-metal` and owns a native window,
        // but does not enable the plain `skia-backend` alias on this crate.
        // Report the compiled Skia boundary accurately; gpu_surface changes
        // only after a drawable receives a rendered frame.
        let native_skia = cfg!(all(
            feature = "window",
            any(feature = "skia-backend", feature = "skia-gpu-metal")
        ));
        Self {
            platform: "desktop",
            target,
            capabilities: HostCapabilities {
                desktop: true,
                // The optional winit/softbuffer presenter owns a native
                // platform window even when the runtime renderer is the
                // software fallback.  Keep this build capability separate
                // from `renderer` and `gpu_surface`: the latter only reports
                // the renderer/context that actually produced a frame.
                window_surface: cfg!(feature = "window"),
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

#[derive(Debug)]
pub struct DesktopHost {
    info: HostInfo,
    initialized: bool,
    session: HostSession,
}

impl DesktopHost {
    pub const fn new(target: DesktopTarget) -> Self {
        Self {
            info: HostInfo::for_target(target),
            initialized: false,
            session: HostSession::empty(),
        }
    }
    pub fn info(&self) -> HostInfo {
        self.info
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

    /// Load a portable manifest for the native window/event loop.
    pub fn load_manifest_json(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        mut config: SessionConfig,
    ) -> Result<(), HostSessionError> {
        config.host.kind = HostKind::Desktop;
        self.session.load_manifest_json(manifest_json, config)?;
        self.initialized = true;
        Ok(())
    }

    pub fn has_session(&self) -> bool {
        self.session.has_session()
    }

    pub fn session_initialized(&self) -> bool {
        self.session.initialized()
    }

    /// Keep all desktop events batch-oriented at the runtime boundary.
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

    pub fn dispatch_json(
        &mut self,
        envelope_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_json(envelope_json)
    }

    /// Dispatch one complete bridge batch after validating all envelopes.
    /// Native window loops should use this for input/data/render bursts.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_batch_json(batch_json)
    }

    /// Convert native desktop input values into one bridge event batch.
    /// Pointer coordinates are intentionally left in logical viewport units;
    /// the runtime resolves them against the committed render tree and adds
    /// target/path/dataset fields before dispatching handlers.
    pub fn dispatch_input_batch<I>(
        &mut self,
        request_id: impl Into<String>,
        events: I,
    ) -> Result<BridgeBatch, HostSessionError>
    where
        I: IntoIterator<Item = DesktopInputEvent>,
    {
        let session_id = self
            .session
            .session()
            .ok_or(HostSessionError::NotLoaded)?
            .config()
            .session_id
            .clone();
        let payload = Value::Array(events.into_iter().map(|event| event.to_value()).collect());
        self.dispatch(BridgeEnvelope::request(
            session_id,
            request_id,
            op::EVENT_BATCH,
            payload,
        ))
    }

    /// Read one complete RGBA snapshot for upload to the native desktop
    /// window surface.  The event loop remains the owner of presentation.
    pub fn render_snapshot_json(&self) -> Result<Vec<u8>, HostSessionError> {
        self.session.render_snapshot_json()
    }

    /// Read one complete committed frame for a native presenter without a
    /// JSON encode/decode round trip. The window/compositor remains owned by
    /// the platform event loop; this method is the batch handoff it presents.
    pub fn render_snapshot(&self) -> Result<RenderSnapshot, HostSessionError> {
        self.session.render_snapshot()
    }

    /// Read one independent Canvas 2D surface snapshot for the desktop
    /// presenter. Canvas surfaces retain their own command history.
    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        self.session.canvas_snapshot_json(canvas_id)
    }

    pub fn canvas_snapshot(&self, canvas_id: &str) -> Result<RenderSnapshot, HostSessionError> {
        self.session.canvas_snapshot(canvas_id)
    }

    /// Renderer selected by this build (`skia` when the native feature is
    /// enabled, otherwise `software-fallback`).  The event loop can include
    /// this marker in diagnostics alongside its presented frame.
    pub fn renderer_backend(&self) -> Result<&'static str, HostSessionError> {
        self.session.renderer_backend()
    }

    /// True after a committed frame has reached a Skia raster surface.  A
    /// host can use this as a smoke-test assertion before presenting bytes to
    /// a winit/raw-window or platform surface.
    pub fn has_native_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_native_surface()
    }

    /// True only after a platform event loop has attached a real GPU
    /// context. `skia-backend` by itself currently provides a CPU raster
    /// surface and therefore does not satisfy this gate.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_gpu_surface()
    }

    /// Attach a host-owned Metal device and queue to the runtime's explicit
    /// Ganesh backend. Compiled only for the opt-in macOS feature.
    ///
    /// # Safety
    ///
    /// The handles must point to live retained MTLDevice and MTLCommandQueue
    /// objects from the same Metal device.
    #[cfg(all(feature = "skia-gpu-metal", target_os = "macos"))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const c_void,
        queue: *const c_void,
    ) -> Result<(), HostSessionError> {
        self.session.attach_metal_context(device, queue)
    }

    /// Render the latest frame into the host-owned Metal drawable texture.
    ///
    /// # Safety
    ///
    /// `texture` must point to a live MTLTexture from the current drawable and
    /// remain alive until the host commits its command buffer.
    #[cfg(all(feature = "skia-gpu-metal", target_os = "macos"))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const c_void,
        width: u32,
        height: u32,
    ) -> Result<(), HostSessionError> {
        self.session
            .render_last_frame_to_metal_texture(texture, width, height)
    }

    #[cfg(all(feature = "skia-gpu-metal", target_os = "macos"))]
    pub fn detach_metal_context(&mut self) -> Result<(), HostSessionError> {
        self.session.detach_metal_context()
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
    fn describes_each_desktop_target() {
        for target in [
            DesktopTarget::Macos,
            DesktopTarget::Windows,
            DesktopTarget::Linux,
        ] {
            assert_eq!(DesktopHost::new(target).info().platform, "desktop");
        }
        let info = DesktopHost::new(DesktopTarget::Macos).info();
        assert_eq!(info.capabilities.window_surface, cfg!(feature = "window"));
        assert_eq!(
            info.capabilities.renderer,
            if cfg!(all(
                feature = "window",
                any(feature = "skia-backend", feature = "skia-gpu-metal")
            )) {
                "skia-raster"
            } else {
                "software-fallback"
            }
        );
        assert!(!info.capabilities.gpu_surface);
        assert_eq!(
            info.capabilities.quickjs,
            engine_provider_compiled(EngineKind::Quickjs)
        );
        assert_eq!(
            info.capabilities.v8,
            engine_provider_compiled(EngineKind::V8)
        );
    }

    #[test]
    fn native_host_owns_one_validated_runtime_session() {
        use container_bridge::op;
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use serde_json::json;

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "desktop-host-test".into(),
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
        let mut host = DesktopHost::new(DesktopTarget::Macos);
        host.load_manifest_json(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
        )
        .unwrap();
        let response = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "r1",
                op::APP_INIT,
                json!({}),
            ))
            .unwrap();
        assert_eq!(response.messages[0].payload["ok"], true);
        assert!(host.session_initialized());
        assert_eq!(response.messages[0].payload["host"]["kind"], "desktop");
    }

    #[test]
    fn input_adapter_batches_pointer_and_wheel_events_with_hit_testing() {
        use container_bridge::op;
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use serde_json::json;

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "desktop-input-test".into(),
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
        let mut host = DesktopHost::new(DesktopTarget::Linux);
        host.load_manifest_json(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
        )
        .unwrap();
        host.start_session("init").unwrap();
        host.dispatch(BridgeEnvelope::request(
            "session-1",
            "frame",
            op::RENDER_COMMIT,
            json!({
                "frame": {
                    "frameId": 1,
                    "viewport": {"x": 0.0, "y": 0.0, "width": 20.0, "height": 20.0},
                    "root": {
                        "id": "root",
                        "bounds": {"x": 0.0, "y": 0.0, "width": 20.0, "height": 20.0},
                        "opacity": 1.0,
                        "children": []
                    }
                }
            }),
        ))
        .unwrap();

        let response = host
            .dispatch_input_batch(
                "input-1",
                [
                    DesktopInputEvent::Pointer {
                        phase: DesktopPointerPhase::Down,
                        x: 4.0,
                        y: 5.0,
                        button: Some(0),
                        buttons: 1,
                        modifiers: DesktopModifiers {
                            shift: true,
                            ..DesktopModifiers::default()
                        },
                    },
                    DesktopInputEvent::Wheel {
                        x: 4.0,
                        y: 5.0,
                        delta_x: 0.0,
                        delta_y: 32.0,
                        modifiers: DesktopModifiers::default(),
                    },
                ],
            )
            .unwrap();
        assert_eq!(response.messages[0].op, op::EVENT_BATCH);
        assert_eq!(response.messages[0].payload["events"], 2);
        assert_eq!(
            response.messages[0].payload["dispatches"][0]["target"],
            "root"
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_desktop_host_loop_commits_and_reads_a_skia_surface() {
        use container_bridge::op;
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use serde_json::json;

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "desktop-native-surface-test".into(),
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
        let mut host = DesktopHost::new(DesktopTarget::Macos);
        host.load_manifest_json(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
        )
        .unwrap();
        host.start_session("init").unwrap();
        let commit = BridgeEnvelope::request(
            "session-1",
            "frame",
            op::RENDER_COMMIT,
            json!({
                "frame": {
                    "frameId": 5,
                    "viewport": {"x": 0.0, "y": 0.0, "width": 2.0, "height": 1.0},
                    "root": {
                        "id": "root",
                        "bounds": {"x": 0.0, "y": 0.0, "width": 2.0, "height": 1.0},
                        "background": {"red": 9, "green": 19, "blue": 29, "alpha": 255},
                        "opacity": 1.0,
                        "children": []
                    }
                }
            }),
        );
        host.dispatch(commit).unwrap();
        assert_eq!(host.renderer_backend().unwrap(), "skia-raster");
        assert!(host.has_native_surface().unwrap());
        let snapshot = host.render_snapshot().unwrap();
        assert_eq!(snapshot.pixels, vec![9, 19, 29, 255, 9, 19, 29, 255]);
    }
}
