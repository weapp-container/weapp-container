//! HarmonyOS ArkUI/N-API/FFI host boundary. ArkUI binding remains opt-in.

use container_bridge::{BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_core::LifecycleState;
use container_host_common::{HostSession, HostSessionError};
use container_runtime::{engine_provider_compiled, HostKind, SessionConfig};

pub mod ffi;
mod managed_files;

#[cfg(test)]
mod live_tests;

#[cfg(any(
    test,
    all(
        feature = "skia-backend",
        target_env = "ohos",
        not(feature = "restricted-showcase")
    )
))]
mod system_fonts;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurfaceBackend {
    Stub,
    ArkUi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCapabilities {
    pub harmony: bool,
    pub native_surface: bool,
    pub renderer: &'static str,
    pub gpu_surface: bool,
    pub quickjs: bool,
    pub v8: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostInfo {
    pub platform: &'static str,
    pub surface: SurfaceBackend,
    pub capabilities: HostCapabilities,
}

impl HostInfo {
    pub const fn current() -> Self {
        let native_skia = cfg!(all(feature = "harmony", feature = "skia-backend"));
        Self {
            platform: "harmony",
            surface: if cfg!(feature = "arkui") {
                SurfaceBackend::ArkUi
            } else {
                SurfaceBackend::Stub
            },
            capabilities: HostCapabilities {
                harmony: true,
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
pub struct HarmonyHost {
    initialized: bool,
    session: HostSession,
    services_config: Option<container_runtime::HostServicesConfig>,
    managed_files_root: Option<std::path::PathBuf>,
    managed_files: Option<managed_files::ManagedFiles>,
    services_revoked: bool,
    #[cfg(all(
        feature = "skia-backend",
        target_env = "ohos",
        not(feature = "restricted-showcase")
    ))]
    font_sources: Option<Vec<container_render_skia::NativeFontData>>,
}

impl HarmonyHost {
    pub const fn new() -> Self {
        Self {
            initialized: false,
            session: HostSession::empty(),
            services_config: None,
            managed_files_root: None,
            managed_files: None,
            services_revoked: false,
            #[cfg(all(
                feature = "skia-backend",
                target_env = "ohos",
                not(feature = "restricted-showcase")
            ))]
            font_sources: None,
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

    /// ArkTS/N-API callers exchange one serialized bridge batch per call.
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
        config.host.kind = HostKind::Harmony;
        #[cfg(all(
            feature = "skia-backend",
            target_env = "ohos",
            not(feature = "restricted-showcase")
        ))]
        {
            let sources = &mut self.font_sources;
            self.session
                .load_manifest_json_with_renderer(manifest_json, config, |renderer| {
                    if sources.is_none() {
                        *sources = Some(system_fonts::installed_sources()?);
                    }
                    renderer
                        .install_native_fonts(sources.as_deref().expect("font sources loaded"))?;
                    Ok(())
                })?;
        }
        #[cfg(any(
            feature = "restricted-showcase",
            not(all(feature = "skia-backend", target_env = "ohos"))
        ))]
        self.session.load_manifest_json(manifest_json, config)?;
        self.session
            .session_mut()
            .expect("loaded Harmony session")
            .set_provider(Box::new(container_runtime::StrictHostProvider::default()));
        self.services_config = None;
        self.managed_files = None;
        self.services_revoked = false;
        self.initialized = true;
        Ok(())
    }

    pub fn has_session(&self) -> bool {
        self.session.has_session()
    }

    /// Additive native protocol; every call runs on this host's owning thread.
    /// Platform callbacks must enqueue data in ArkTS and enter here at drain.
    pub fn host_services_json(&mut self, command: &[u8]) -> Result<Vec<u8>, HostSessionError> {
        let command: serde_json::Value = serde_json::from_slice(command)?;
        let operation = command
            .get("operation")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                container_runtime::SessionError::UnsupportedCapability(
                    "host services operation required".into(),
                )
            })?;
        if operation == "protocol" {
            return Ok(serde_json::to_vec(
                &serde_json::json!({"version":"1.0","trustedContext":true,"ownerThreadCompletion":true,"events":true,"components":true,"snapshots":true,"revocation":true}),
            )?);
        }
        let payload = command
            .get("payload")
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        let invalid = |message: String| {
            HostSessionError::from(container_runtime::SessionError::UnsupportedCapability(
                message,
            ))
        };
        if operation == "managedFilesRoot" {
            if self.services_config.is_some() {
                return Err(invalid(
                    "set host-private managed root before configure".into(),
                ));
            }
            let root = payload
                .get("root")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| invalid("managed root required".into()))?;
            let path = std::path::PathBuf::from(root);
            if !path.is_absolute() {
                return Err(invalid(
                    "managed root must be host-private absolute path".into(),
                ));
            }
            self.managed_files_root = Some(path);
            return Ok(serde_json::to_vec(&serde_json::json!({"ok":true}))?);
        }
        if matches!(operation, "managedFileScope" | "managedFile") {
            if self.services_revoked {
                return Err(invalid("managed file owner retired".into()));
            }
            let config = self
                .services_config
                .as_ref()
                .ok_or_else(|| invalid("trusted host services must be configured".into()))?;
            if self.managed_files.is_none() {
                let root = self
                    .managed_files_root
                    .as_deref()
                    .ok_or_else(|| invalid("host-private managed root not configured".into()))?;
                self.managed_files =
                    Some(managed_files::ManagedFiles::open(root, config).map_err(invalid)?);
            }
            let files = self
                .managed_files
                .as_ref()
                .expect("managed scope established");
            let value = if operation == "managedFileScope" {
                files.describe()
            } else {
                let context: container_runtime::HostApiCallContext = serde_json::from_value(
                    payload
                        .get("context")
                        .cloned()
                        .ok_or_else(|| invalid("trusted native context required".into()))?,
                )?;
                let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
                files
                    .validate(&context, &session.config().session_id)
                    .map_err(invalid)?;
                let method = payload
                    .get("method")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| invalid("managed file method required".into()))?;
                files
                    .perform(
                        method,
                        payload.get("payload").unwrap_or(&serde_json::Value::Null),
                    )
                    .map_err(invalid)?
            };
            return Ok(serde_json::to_vec(&value)?);
        }
        if operation == "configure" {
            let mut config: container_runtime::HostServicesConfig =
                serde_json::from_value(payload)?;
            let files = if let Some(root) = self.managed_files_root.as_deref() {
                Some(managed_files::ManagedFiles::open(root, &config).map_err(invalid)?)
            } else {
                None
            };
            let session = self
                .session
                .session_mut()
                .ok_or(HostSessionError::NotLoaded)?;
            if let Some(files) = &files {
                use container_core::SyncHostApi;
                let provider = std::sync::Arc::new(
                    container_runtime::ManagedSyncFileSystem::new(files.root())
                        .map_err(|e| invalid(e.to_string()))?,
                );
                for api in provider.supported_apis() {
                    if !config.apis.contains(&api) {
                        config.apis.push(api);
                    }
                }
                session.bind_sync_host_api(provider)?;
            }
            session.configure_host_services(config.clone())?;
            let session_id = session.config().session_id.clone();
            self.services_config = Some(config);
            self.managed_files = files;
            self.services_revoked = false;
            return Ok(serde_json::to_vec(
                &serde_json::json!({"ok":true,"sessionId":session_id}),
            )?);
        }
        let session = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?;
        let value = match operation {
            "take" => serde_json::json!({"requests":session.take_host_requests()}),
            "complete" => {
                let call_id = payload
                    .get("callId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        container_runtime::SessionError::UnsupportedCapability(
                            "callId required".into(),
                        )
                    })?;
                let result = if let Some(error) = payload.get("error") {
                    Err(serde_json::from_value(error.clone())?)
                } else {
                    Ok(payload
                        .get("result")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null))
                };
                serde_json::json!({"batch":session.complete_host_api_call(call_id,result)?})
            }
            "event" => {
                serde_json::json!({"batch":session.dispatch_host_api_event(serde_json::from_value(payload)?)?})
            }
            "component" => {
                serde_json::json!({"batch":session.dispatch_host_component_event(serde_json::from_value(payload)?)?})
            }
            "phone" => {
                let node_id = payload
                    .get("nodeId")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        container_runtime::SessionError::UnsupportedCapability(
                            "nodeId required".into(),
                        )
                    })?;
                serde_json::json!({"batch":session.authorize_phone_button(node_id)?})
            }
            "snapshots" => {
                session.update_host_service_snapshots(serde_json::from_value(payload)?)?;
                serde_json::json!({"ok":true})
            }
            "revoke" => {
                self.services_revoked = true;
                serde_json::json!({"cancellations":session.revoke_host_services()})
            }
            _ => {
                return Err(
                    container_runtime::SessionError::UnsupportedCapability(format!(
                        "unknown host services operation: {operation}"
                    ))
                    .into(),
                )
            }
        };
        Ok(serde_json::to_vec(&value)?)
    }

    /// Called on the runtime owner thread after the platform submits this
    /// exact frame for presentation. GPU completion is a separate observation.
    pub fn acknowledge_presentation_json(
        &mut self,
        revision: u64,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.acknowledge_presentation_json(revision)
    }

    /// Return build-time and runtime surface capabilities in one stable JSON
    /// object.  ArkUI surface attachment and GPU evidence are deliberately
    /// separate from the portable Skia raster snapshot.
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
        let surface = match info.surface {
            SurfaceBackend::Stub => "stub",
            SurfaceBackend::ArkUi => "arkui",
        };
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "distributionProfile": container_runtime::distribution_identity().distribution_profile,
            "policySha256": container_runtime::distribution_identity().policy_sha256,
            "platform": info.platform,
            "surfaceBackend": surface,
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

    /// Observe presentation ownership without entering JavaScript or advancing
    /// timers. Restricted distributions return only the owner/page revisions
    /// needed by the rendering pump; full builds include development details.
    pub fn inspect_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        if container_runtime::is_restricted_showcase() {
            let page = session
                .app_service()
                .pages()
                .current()
                .map(|page| serde_json::json!({"id": page.id.0, "route": page.path}));
            return Ok(serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "sessionId": session.config().session_id,
                "page": page,
                "viewRevision": session.view().revision,
                "renderRevision": session.render_revision(),
            }))?);
        }
        #[cfg(feature = "skia-backend")]
        let native_fonts = session.renderer_if_initialized().map_or_else(
            || serde_json::json!({"installedFaces": 0, "families": []}),
            |renderer| {
            let info = renderer.native_font_info();
            serde_json::json!({"installedFaces": info.installed_faces, "families": info.families})
            },
        );
        #[cfg(not(feature = "skia-backend"))]
        let native_fonts = serde_json::Value::Null;
        let page = session.app_service().pages().current().map(
            |page| serde_json::json!({"id": page.id.0, "route": page.path, "data": page.data}),
        );
        Ok(serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session.config().session_id,
            "engine": session.config().engine,
            "lifecycle": self.session.lifecycle_state()?,
            "lifecycleSequence": self.session.lifecycle_sequence()?,
            "viewport": {
                "width": session.config().host.window_width,
                "height": session.config().host.window_height,
            },
            "page": page,
            "frameId": session.accepted_page_observation().map(|observation| observation.frame).map(|frame| frame.frame_id),
            "viewRevision": session.view().revision,
            "renderRevision": session.render_revision(),
            "nativeFonts": native_fonts,
        }))?)
    }

    /// Update logical geometry and dispatch page/component resize callbacks
    /// without replacing the AppService. The owner commits the next frame.
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
    /// display uptime or session-relative elapsed time is not this clock.
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

    /// Dispatch the canonical bridge batch shape in one ArkTS/N-API boundary
    /// crossing. Batch validation happens before runtime mutation.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_batch_json(batch_json)
    }

    /// Read one complete RGBA snapshot for upload to an ArkUI surface.
    pub fn render_snapshot_json(&mut self) -> Result<Vec<u8>, HostSessionError> {
        if container_runtime::is_restricted_showcase() {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "diagnostic snapshots are disabled in this distribution".into(),
            )
            .into());
        }
        // Explicit diagnostic capture; normal native presentation uses frame metadata.
        Ok(serde_json::to_vec(
            &self.session.capture_render_snapshot()?,
        )?)
    }

    /// True only after ArkUI supplies a GPU-backed surface to the renderer.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_gpu_surface()
    }

    /// Attach the EGL/GLES context that owns an ArkUI XComponent surface.
    ///
    /// The ArkTS/native surface owner must make its EGL context current before
    /// crossing this boundary. A context alone does not advertise a GPU
    /// surface; `render_last_frame_to_gles_framebuffer` must submit a committed
    /// frame to the current window framebuffer first.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session.attach_gles_context()
    }

    /// Render the latest committed frame into the current ArkUI EGL window
    /// framebuffer. The surface owner performs `eglSwapBuffers` afterwards.
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

    /// Forget a lost or unusable EGL context without issuing GL calls. Normal
    /// teardown should detach while the owned context is current instead.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn abandon_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session.abandon_gles_context()
    }

    /// Read one complete Canvas 2D surface snapshot by id for ArkUI upload.
    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        if container_runtime::is_restricted_showcase() {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "canvas snapshots are disabled in this distribution".into(),
            )
            .into());
        }
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

    #[cfg(feature = "restricted-showcase")]
    #[test]
    fn restricted_showcase_identity_and_diagnostic_boundary() {
        let mut host = HarmonyHost::new();
        let identity: serde_json::Value =
            serde_json::from_slice(&host.capabilities_json().unwrap()).unwrap();
        assert_eq!(identity["distributionProfile"], "restricted-showcase");
        assert_eq!(
            identity["policySha256"],
            container_runtime::distribution_identity()
                .policy_sha256
                .unwrap()
        );
        assert!(host
            .render_snapshot_json()
            .unwrap_err()
            .to_string()
            .contains("ERR_UNSUPPORTED_CAPABILITY"));
        assert!(host
            .canvas_snapshot_json("any-canvas")
            .unwrap_err()
            .to_string()
            .contains("ERR_UNSUPPORTED_CAPABILITY"));
        let mut unapproved: container_ir::ContainerManifestV1 = serde_json::from_str(include_str!(
            "../../container-runtime/tests/fixtures/showcase-manifest.json"
        ))
        .unwrap();
        unapproved.compiler.commit = "unapproved-showcase-pack".into();
        unapproved.refresh_integrity().unwrap();
        assert!(host
            .load_manifest_json(
                serde_json::to_vec(&unapproved).unwrap(),
                SessionConfig::default()
            )
            .unwrap_err()
            .to_string()
            .contains("ERR_UNTRUSTED_APPLICATION"));
        assert!(!host.has_session());
        host.load_manifest_json(
            include_bytes!("../../container-runtime/tests/fixtures/showcase-manifest.json"),
            SessionConfig::default(),
        )
        .unwrap();
        let state: serde_json::Value =
            serde_json::from_slice(&host.inspect_state_json().unwrap()).unwrap();
        assert_eq!(
            state
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            [
                "page",
                "renderRevision",
                "schemaVersion",
                "sessionId",
                "viewRevision"
            ]
        );
    }

    #[test]
    fn renderer_profile_preflight_preserves_the_previous_native_session() {
        let mut host = HarmonyHost::new();
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

    fn manifest() -> Vec<u8> {
        serde_json::json!({
            "schemaVersion": 1,
            "protocolVersion": "1.0",
            "compiler": {"name": "weapp-vite", "commit": "harmony-ffi-test", "platform": "weapp"},
            "app": {"appJson": "app.json", "entryModule": "app.js"},
            "capabilities": {"wx.canvas.draw": "partial"},
            "integrity": {"algorithm": "sha256", "root": ""}
        })
        .to_string()
        .into_bytes()
    }

    #[test]
    fn exposes_harmony_platform_metadata() {
        assert_eq!(HostInfo::current().platform, "harmony");
        assert_eq!(
            HostInfo::current().capabilities.native_surface,
            cfg!(all(feature = "harmony", feature = "skia-backend"))
        );
        assert_eq!(
            HostInfo::current().capabilities.renderer,
            if cfg!(all(feature = "harmony", feature = "skia-backend")) {
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
        let host = HarmonyHost::new();
        let report: serde_json::Value = serde_json::from_slice(&host.capabilities_json().unwrap())
            .expect("capability report is JSON");
        assert_eq!(report["schemaVersion"], 1);
        assert_eq!(report["platform"], "harmony");
        assert_eq!(report["runtime"]["loaded"], false);
        assert_eq!(report["runtime"]["gpuSurface"], false);
        assert_eq!(report["build"]["gpuSurface"], false);
    }

    #[test]
    fn ffi_loads_manifest_and_returns_one_batch() {
        let host = ffi::weapp_container_harmony_host_new();
        let mut capabilities = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_harmony_host_capabilities(host, &mut capabilities) },
            0
        );
        let capability_value: serde_json::Value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(capabilities.data, capabilities.len)
        })
        .unwrap();
        assert_eq!(capability_value["platform"], "harmony");
        unsafe { ffi::weapp_container_harmony_buffer_free(&mut capabilities) };
        let manifest = manifest();
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_load_manifest(
                    host,
                    manifest.as_ptr(),
                    manifest.len(),
                )
            },
            0
        );
        let request = b"harmony-test";
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_start(
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
            ffi::weapp_container_harmony_buffer_free(&mut output);
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
                ffi::weapp_container_harmony_host_dispatch_batch_json(
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
        unsafe { ffi::weapp_container_harmony_buffer_free(&mut batch_output) };
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
                ffi::weapp_container_harmony_host_dispatch_json(
                    host,
                    render.as_ptr(),
                    render.len(),
                    &mut render_output,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_harmony_buffer_free(&mut render_output);
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
                ffi::weapp_container_harmony_host_dispatch_json(
                    host,
                    canvas.as_ptr(),
                    canvas.len(),
                    &mut canvas_dispatch,
                )
            },
            0
        );
        unsafe {
            ffi::weapp_container_harmony_buffer_free(&mut canvas_dispatch);
        }
        let canvas_id = b"main";
        let mut canvas_snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe {
                ffi::weapp_container_harmony_host_canvas_snapshot(
                    host,
                    canvas_id.as_ptr(),
                    canvas_id.len(),
                    &mut canvas_snapshot,
                )
            },
            -1,
            "strict Harmony hosts cannot fabricate a sandbox canvas provider result"
        );
        unsafe {
            ffi::weapp_container_harmony_buffer_free(&mut canvas_snapshot);
        }
        let mut snapshot = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi::weapp_container_harmony_host_render_snapshot(host, &mut snapshot) },
            0
        );
        let snapshot_bytes = unsafe { slice::from_raw_parts(snapshot.data, snapshot.len) };
        assert!(std::str::from_utf8(snapshot_bytes)
            .unwrap()
            .contains("rgba8-premultiplied"));
        unsafe {
            ffi::weapp_container_harmony_buffer_free(&mut snapshot);
            ffi::weapp_container_harmony_host_free(host);
        }
    }
}
