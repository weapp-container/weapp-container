//! Web host metadata and lifecycle boundary.
//!
//! CanvasKit/WASM integration is intentionally feature-gated. The default crate is
//! useful for protocol and capability tests without requiring a browser toolchain.

use container_bridge::{BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_core::LifecycleState;
use container_host_common::{HostSession, HostSessionError};
use container_ir::CapabilitySupport;
use container_ir::PresentationKey;
use container_render_skia::RenderSnapshot;
use container_runtime::{engine_provider_compiled, HostKind, SessionConfig};
use container_runtime::{HostApiProvider, ProviderContext, ProviderError, ProviderErrorCode};
use std::collections::BTreeMap;

/// The browser embedding never inherits deterministic sandbox identity, payment,
/// files or hardware. Only real configuration snapshots are available before an
/// explicit browser host adapter installs the host-services protocol.
struct BrowserNativeProvider;
impl HostApiProvider for BrowserNativeProvider {
    fn name(&self) -> &'static str {
        "browser-native"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        [
            "wx.getSystemInfo",
            "wx.getSystemInfoAsync",
            "wx.getSystemInfoSync",
            "wx.getWindowInfo",
            "wx.getDeviceInfo",
            "wx.getAppBaseInfo",
            "wx.getSystemSetting",
            "wx.setNavigationBarTitle",
            "wx.setNavigationBarColor",
        ]
        .into_iter()
        .map(|name| (name.into(), CapabilitySupport::Partial))
        .collect()
    }
    fn call(
        &mut self,
        name: &str,
        _: &serde_json::Map<String, serde_json::Value>,
        context: &ProviderContext,
    ) -> Result<serde_json::Value, ProviderError> {
        let host = &context.host;
        match name {
            "wx.getSystemInfo"
            | "wx.getSystemInfoAsync"
            | "wx.getSystemInfoSync"
            | "wx.getWindowInfo" => {
                let mut value = serde_json::json!({"windowWidth":host.window_width,"windowHeight":host.window_height});
                if name != "wx.getWindowInfo" {
                    value["platform"] = serde_json::json!(host.platform);
                    value["system"] = serde_json::json!(host.version);
                }
                if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync") {
                    value["errMsg"] =
                        serde_json::json!(format!("{}:ok", name.trim_start_matches("wx.")));
                }
                if let Some(display) = &host.display_metrics {
                    for (key, field) in serde_json::to_value(display)
                        .expect("serializable host metrics")
                        .as_object()
                        .unwrap()
                    {
                        value[key] = field.clone();
                    }
                }
                Ok(value)
            }
            "wx.getDeviceInfo" => {
                Ok(serde_json::json!({"platform":host.platform,"system":host.version}))
            }
            "wx.getAppBaseInfo" => Ok(
                serde_json::json!({"SDKVersion":env!("CARGO_PKG_VERSION"),"host":host.kind,"version":host.version,"enableDebug":false}),
            ),
            "wx.getSystemSetting" => Ok(host
                .display_metrics
                .as_ref()
                .map(|display| serde_json::json!({"deviceOrientation":display.device_orientation}))
                .unwrap_or(serde_json::json!({}))),
            // The runtime commits navigation chrome state. A browser host may
            // render that state; this does not claim an OS or payment action.
            "wx.setNavigationBarTitle" | "wx.setNavigationBarColor" => {
                Ok(serde_json::json!({"errMsg":format!("{}:ok",name.trim_start_matches("wx."))}))
            }
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("browser capability is not installed: {name}"),
                retryable: false,
            }),
        }
    }
}

mod renderer_transition;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebBackend {
    Stub,
    CanvasKitWasm,
    ExternalFrameExport,
    BrowserViewExport,
}

/// Selection of the Rust page presentation boundary. An external presenter
/// proves its own rendering separately; exporting frames never claims a GPU.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum WebRendererMode {
    #[default]
    Software,
    ExternalFrame,
    /// Export evaluated documents to an explicitly attached DOM transaction
    /// client. Legacy callers force WebView; explicit policy separates this
    /// transport selection from each route's semantic renderer profile.
    BrowserView,
}

impl WebRendererMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Software => "software",
            Self::ExternalFrame => "external-frame",
            Self::BrowserView => "browser-view",
        }
    }
}

/// An explicit semantic choice, independent of the frame/document transport.
/// Absence retains the legacy low-level browser-view force behavior.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebRendererPolicy {
    Manifest,
    Force {
        profile: container_ir::RendererProfile,
    },
}

impl WebRendererPolicy {
    fn parse(value: &serde_json::Value) -> Result<Self, String> {
        let invalid = || {
            "ERR_RENDER: renderer_policy must be {mode:manifest} or {mode:force,profile}"
                .to_string()
        };
        let object = value.as_object().ok_or_else(invalid)?;
        match object.get("mode").and_then(serde_json::Value::as_str) {
            Some("manifest") if object.len() == 1 => Ok(Self::Manifest),
            Some("force") if object.len() == 2 => {
                let profile = object.get("profile").ok_or_else(invalid)?;
                Ok(Self::Force {
                    profile: serde_json::from_value(profile.clone()).map_err(|_| invalid())?,
                })
            }
            _ => Err(invalid()),
        }
    }

    fn to_json(self) -> serde_json::Value {
        match self {
            Self::Manifest => serde_json::json!({"mode":"manifest"}),
            Self::Force { profile } => serde_json::json!({"mode":"force","profile":profile}),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WebSessionOptions {
    pub renderer_mode: WebRendererMode,
}

impl WebSessionOptions {
    /// WASM keeps host-only presentation options outside the shared runtime
    /// SessionConfig. Invalid selections must not silently select software.
    pub fn parse_config_json(json: &str) -> Result<(SessionConfig, Self), String> {
        let (config, options, policy) = Self::parse_config_json_with_policy(json)?;
        if policy.is_some() {
            return Err("ERR_RENDER: renderer_policy requires parse_config_json_with_policy and the explicit policy load method".into());
        }
        Ok((config, options))
    }

    /// Explicit policy has its own result instead of changing the legacy public
    /// options struct or silently dropping policy through a two-value parser.
    pub fn parse_config_json_with_policy(
        json: &str,
    ) -> Result<(SessionConfig, Self, Option<WebRendererPolicy>), String> {
        let mut value: serde_json::Value = serde_json::from_str(json).map_err(|error| {
            format!("ERR_INVALID_MANIFEST: invalid session configuration: {error}")
        })?;
        let renderer_mode =
            match value.get("renderer_mode") {
                None => WebRendererMode::Software,
                Some(serde_json::Value::String(mode)) if mode == "software" => {
                    WebRendererMode::Software
                }
                Some(serde_json::Value::String(mode)) if mode == "external-frame" => {
                    WebRendererMode::ExternalFrame
                }
                Some(serde_json::Value::String(mode)) if mode == "browser-view" => {
                    WebRendererMode::BrowserView
                }
                Some(_) => return Err(
                    "ERR_RENDER: renderer_mode must be software, external-frame or browser-view"
                        .into(),
                ),
            };
        let renderer_policy = value
            .get("renderer_policy")
            .map(WebRendererPolicy::parse)
            .transpose()?;
        if let Some(object) = value.as_object_mut() {
            object.remove("renderer_mode");
            object.remove("renderer_policy");
        }
        let config = serde_json::from_value(value).map_err(|error| {
            format!("ERR_INVALID_MANIFEST: invalid session configuration: {error}")
        })?;
        Ok((config, Self { renderer_mode }, renderer_policy))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostCapabilities {
    pub web: bool,
    pub native_surface: bool,
    pub renderer: &'static str,
    /// The document/geometry/permit protocol is selected. This is a host
    /// configuration fact, not evidence that a real DOM was presented.
    pub browser_view: bool,
    /// CanvasKit may use a browser GPU context, but this crate has no
    /// attached context until the WASM adapter reports one.
    pub gpu_surface: bool,
    pub quickjs: bool,
    pub v8: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostInfo {
    pub platform: &'static str,
    pub backend: WebBackend,
    pub capabilities: HostCapabilities,
}

impl HostInfo {
    pub const fn current() -> Self {
        Self {
            platform: "web",
            // A Cargo flag reserves adapter APIs; a live external presenter
            // must report its own surface receipt after rendering a frame.
            backend: WebBackend::Stub,
            capabilities: HostCapabilities {
                web: true,
                native_surface: false,
                renderer: "software-fallback",
                browser_view: false,
                gpu_surface: false,
                // Protocol-only headless sessions do not advertise a JS
                // provider. Query the shared runtime because Cargo can
                // enable its providers through another workspace consumer.
                quickjs: engine_provider_compiled(EngineKind::Quickjs),
                // Session construction also checks that the compiled V8
                // provider actually creates a native isolate.
                v8: engine_provider_compiled(EngineKind::V8),
            },
        }
    }
}

#[derive(Debug, Default)]
pub struct WebHost {
    initialized: bool,
    session: HostSession,
    renderer_mode: WebRendererMode,
    renderer_policy: Option<WebRendererPolicy>,
    // Ordinary ready/effects errors do not fault the engine. A duplicate ACK
    // returns an empty batch, so remember input blocking for this exact token.
    external_ack_blocked: Option<(u64, bool)>,
    presenter_generation: Option<u64>,
    development_sandbox: bool,
    text_font: Option<container_render_skia::PortableFontData>,
}

impl WebHost {
    pub const fn new() -> Self {
        Self {
            initialized: false,
            session: HostSession::empty(),
            renderer_mode: WebRendererMode::Software,
            renderer_policy: None,
            external_ack_blocked: None,
            presenter_generation: None,
            development_sandbox: false,
            text_font: None,
        }
    }
    pub fn info(&self) -> HostInfo {
        let mut info = HostInfo::current();
        match self.renderer_mode {
            WebRendererMode::ExternalFrame => {
                info.backend = WebBackend::ExternalFrameExport;
                info.capabilities.renderer = "external-frame-export";
            }
            WebRendererMode::BrowserView => {
                info.backend = WebBackend::BrowserViewExport;
                info.capabilities.renderer = "browser-view-export";
                info.capabilities.browser_view = true;
            }
            WebRendererMode::Software => {}
        }
        info
    }
    pub fn initialize(&mut self) {
        self.initialized = true;
    }
    pub fn is_initialized(&self) -> bool {
        self.initialized
    }

    /// Bind the exact default-instance face before loading application JS.
    /// A new execution owner is required to select another font.
    pub fn configure_text_font(
        &mut self,
        bytes: std::sync::Arc<[u8]>,
        sha256: &str,
    ) -> Result<container_render_skia::PortableFontIdentity, HostSessionError> {
        if self.has_session() || self.text_font.is_some() {
            return Err(container_runtime::SessionError::Config(
                "text font must be configured once before loading".into(),
            )
            .into());
        }
        let font = container_render_skia::PortableFontData::new(bytes, sha256)?;
        let identity = font.identity();
        self.text_font = Some(font);
        Ok(identity)
    }

    /// Explicit test/development opt-in. It must be selected before any app is
    /// loaded; production callers use the strict default.
    pub fn enable_development_sandbox(&mut self) -> Result<(), HostSessionError> {
        if container_runtime::is_restricted_showcase() {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "development sandbox is disabled in this distribution".into(),
            )
            .into());
        }
        if self.has_session() {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "sandbox mode must be selected before loading an app".into(),
            )
            .into());
        }
        self.development_sandbox = true;
        Ok(())
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

    /// Load a validated portable manifest before the browser runtime starts.
    /// The existing session is replaced only after construction succeeds.
    pub fn load_manifest_json(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        config: SessionConfig,
    ) -> Result<(), HostSessionError> {
        self.load_manifest_json_with_options(manifest_json, config, WebSessionOptions::default())
    }

    /// Construct the session and its renderer before atomically replacing the
    /// current app. Existing callers retain the default presentation behavior.
    pub fn load_manifest_json_with_options(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        config: SessionConfig,
        options: WebSessionOptions,
    ) -> Result<(), HostSessionError> {
        self.load_manifest_with_policy(manifest_json, config, options, None)
    }

    /// Select semantic renderer policy explicitly, without changing legacy
    /// Rust options literals or interpreting transport as an implicit policy.
    pub fn load_manifest_json_with_renderer_policy(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        config: SessionConfig,
        options: WebSessionOptions,
        policy: WebRendererPolicy,
    ) -> Result<(), HostSessionError> {
        self.load_manifest_with_policy(manifest_json, config, options, Some(policy))
    }

    fn load_manifest_with_policy(
        &mut self,
        manifest_json: impl AsRef<[u8]>,
        mut config: SessionConfig,
        options: WebSessionOptions,
        renderer_policy: Option<WebRendererPolicy>,
    ) -> Result<(), HostSessionError> {
        config.host.kind = HostKind::Web;
        match renderer_policy {
            None if options.renderer_mode == WebRendererMode::BrowserView => {
                // Preserve the original low-level opt-in and smoke contract.
                config.browser_view_enabled = true;
                config.renderer_override = Some(container_ir::RendererProfile::WebView);
            }
            None => {}
            Some(WebRendererPolicy::Manifest) => {
                if config.renderer_override.is_some()
                    || options.renderer_mode == WebRendererMode::Software
                {
                    return Err(container_runtime::SessionError::UnsupportedCapability(
                        "manifest renderer policy requires an explicit document/frame transport and no renderer_override".into(),
                    ).into());
                }
                // Negotiate the complete manifest, including future WebView
                // routes. This enables the runtime protocol, not an attached DOM
                // presenter; the Worker freezes on a fixed-family mismatch.
                config.browser_view_enabled = true;
            }
            Some(WebRendererPolicy::Force { profile }) => {
                let browser = profile == container_ir::RendererProfile::WebView;
                if browser != (options.renderer_mode == WebRendererMode::BrowserView)
                    || config
                        .renderer_override
                        .is_some_and(|existing| existing != profile)
                {
                    return Err(container_runtime::SessionError::UnsupportedCapability(
                        "forced renderer policy conflicts with the selected transport or renderer_override".into(),
                    ).into());
                }
                config.renderer_override = Some(profile);
                config.browser_view_enabled |= browser;
            }
        }
        config.page_render_mode = match options.renderer_mode {
            WebRendererMode::ExternalFrame | WebRendererMode::BrowserView => {
                container_render_skia::PageRenderMode::ExternalFrame
            }
            WebRendererMode::Software => container_render_skia::PageRenderMode::Raster,
        };
        let mut next = HostSession::from_manifest_json(manifest_json, config)?;
        if let Some(font) = &self.text_font {
            next.session_mut()
                .expect("constructed host session")
                .install_portable_text_font(font.clone())?;
        }
        if !self.development_sandbox {
            next.session_mut()
                .expect("constructed host session")
                .set_provider(Box::new(BrowserNativeProvider));
        }
        self.session = next;
        self.renderer_mode = options.renderer_mode;
        self.renderer_policy = renderer_policy;
        self.external_ack_blocked = None;
        self.presenter_generation = None;
        self.initialized = true;
        Ok(())
    }

    pub fn has_session(&self) -> bool {
        self.session.has_session()
    }

    /// Install the explicit host capability protocol before app.init. The host
    /// supplies trusted installation/account scope; application JS cannot amend it.
    pub fn configure_host_services_json(&mut self, config: &[u8]) -> Result<(), HostSessionError> {
        let config: container_runtime::HostServicesConfig = serde_json::from_slice(config)?;
        self.session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .configure_host_services(config)?;
        Ok(())
    }

    pub fn take_host_requests_json(&mut self) -> Result<Vec<u8>, HostSessionError> {
        let requests = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .take_host_requests();
        Ok(serde_json::to_vec(&requests)?)
    }

    /// Completion is entered only by the runtime owner during its next drain,
    /// never directly from a browser device callback.
    pub fn complete_host_api_call_json(
        &mut self,
        call_id: &str,
        result: &[u8],
    ) -> Result<Vec<u8>, HostSessionError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Completion {
            #[serde(default)]
            result: serde_json::Value,
            #[serde(default)]
            error: Option<container_runtime::HostApiFailure>,
        }
        let completion: Completion = serde_json::from_slice(result)?;
        let result = completion.error.map_or(Ok(completion.result), Err);
        let batch = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .complete_host_api_call(call_id, result)?;
        Ok(serde_json::to_vec(&batch)?)
    }

    pub fn dispatch_host_api_event_json(
        &mut self,
        event: &[u8],
    ) -> Result<Vec<u8>, HostSessionError> {
        let event: container_runtime::HostApiEvent = serde_json::from_slice(event)?;
        let batch = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .dispatch_host_api_event(event)?;
        Ok(serde_json::to_vec(&batch)?)
    }

    /// Revocation tears down native resources without executing old-account JS.
    pub fn revoke_host_services_json(&mut self) -> Result<Vec<u8>, HostSessionError> {
        let requests = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .revoke_host_services();
        Ok(serde_json::to_vec(&requests)?)
    }

    pub fn authorize_phone_button_json(
        &mut self,
        node_id: &str,
    ) -> Result<Vec<u8>, HostSessionError> {
        let batch = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .authorize_phone_button(node_id)?;
        Ok(serde_json::to_vec(&batch)?)
    }

    pub fn dispatch_host_component_event_json(
        &mut self,
        event: &[u8],
    ) -> Result<Vec<u8>, HostSessionError> {
        let event: container_runtime::HostComponentEvent = serde_json::from_slice(event)?;
        let batch = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .dispatch_host_component_event(event)?;
        Ok(serde_json::to_vec(&batch)?)
    }

    pub fn update_host_service_snapshots_json(
        &mut self,
        values: &[u8],
    ) -> Result<(), HostSessionError> {
        let values: std::collections::BTreeMap<String, serde_json::Value> =
            serde_json::from_slice(values)?;
        self.session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .update_host_service_snapshots(values)?;
        Ok(())
    }

    /// Geometry is read only from the last accepted presentation. Pixels use a
    /// separate byte channel so RGBA never expands into a JSON number array.
    pub fn host_component_snapshots_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        Ok(serde_json::to_vec(&session.host_component_snapshots())?)
    }

    pub fn submit_host_component_frame(
        &mut self,
        metadata: &[u8],
        pixels: Vec<u8>,
    ) -> Result<bool, HostSessionError> {
        if metadata.len() > 16 * 1024 || pixels.len() > 1024 * 1024 {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "native component transport limit exceeded".into(),
            )
            .into());
        }
        let mut value: serde_json::Value = serde_json::from_slice(metadata)?;
        // Deny caller-supplied pixels and bound metadata before deserialization.
        if !value.is_object() || value.get("pixels").is_some() {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "invalid bounded native component frame transport".into(),
            )
            .into());
        }
        value["pixels"] = serde_json::json!([]);
        let mut frame: container_runtime::HostComponentFrame = serde_json::from_value(value)?;
        frame.pixels = pixels;
        Ok(self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .submit_host_component_frame(frame)?)
    }

    /// Package media bytes remain bound to the exact accepted component. A
    /// pending layout returns None so hosts retry after real presentation.
    pub fn host_component_resource(
        &self,
        metadata: &[u8],
    ) -> Result<Option<Vec<u8>>, HostSessionError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct Target {
            session_id: String,
            #[serde(with = "container_runtime::host_wire_u64")]
            account_epoch: u64,
            #[serde(with = "container_runtime::host_wire_u64")]
            page_id: u64,
            node_id: String,
        }
        if metadata.len() > 16 * 1024 {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "native media target limit exceeded".into(),
            )
            .into());
        }
        let target: Target = serde_json::from_slice(metadata)?;
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        match session.host_component_resource(
            &target.session_id,
            target.account_epoch,
            target.page_id,
            &target.node_id,
        ) {
            Ok(bytes) if bytes.len() <= 16 * 1024 * 1024 => Ok(Some(bytes.to_vec())),
            Ok(_) => Err(container_runtime::SessionError::UnsupportedCapability(
                "native media resource exceeds transfer limit".into(),
            )
            .into()),
            Err(error) if error.code == container_bridge::BridgeErrorCode::Cancelled => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// The pending API context is the authority; callers cannot supply a path.
    pub fn host_api_resource(&self, context: &[u8]) -> Result<Vec<u8>, HostSessionError> {
        if context.len() > 16 * 1024 {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "package API context limit exceeded".into(),
            )
            .into());
        }
        let context: container_runtime::HostApiCallContext = serde_json::from_slice(context)?;
        Ok(self
            .session
            .session()
            .ok_or(HostSessionError::NotLoaded)?
            .host_api_resource(&context)?
            .to_vec())
    }

    fn require_page_frame_renderer(&self) -> Result<(), HostSessionError> {
        if self.renderer_mode == WebRendererMode::BrowserView {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "browser-view uses View document transactions; Skia frame, raster and density APIs are unavailable"
                    .into(),
            )
            .into());
        }
        Ok(())
    }

    /// Export one complete, already laid out frame for a host-owned renderer.
    /// CanvasKit consumes this batch locally; it never queries runtime nodes.
    pub fn render_frame_json(&self) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.require_transition_frame_input(self.session.render_revision())?;
        let observation = self
            .session
            .accepted_page_observation()?
            .ok_or(HostSessionError::NoRenderFrame)?;
        Ok(serde_json::to_vec(observation.frame)?)
    }

    /// WCF1: four-byte magic, little-endian metadata length, JSON layout and
    /// contiguous RGBA bytes. Uses the same accepted authority as JSON export.
    pub fn render_frame_binary(&self) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.require_transition_frame_input(self.session.render_revision())?;
        let observation = self
            .session
            .accepted_page_observation()?
            .ok_or(HostSessionError::NoRenderFrame)?;
        let metadata = observation.frame.binary_metadata_json()?;
        let mut bytes = Vec::with_capacity(
            8 + metadata.len()
                + observation
                    .frame
                    .images
                    .values()
                    .map(|image| image.pixels.len())
                    .sum::<usize>(),
        );
        bytes.extend_from_slice(b"WCF1");
        bytes.extend_from_slice(&(metadata.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&metadata);
        for image in observation.frame.images.values() {
            bytes.extend_from_slice(&image.pixels);
        }
        Ok(bytes)
    }

    /// Renderer-owned revision, independent of the application's frameId.
    /// wasm-bindgen exposes u64 as BigInt, preserving the exact receipt token.
    pub fn render_revision(&self) -> Result<u64, HostSessionError> {
        self.session.session().ok_or(HostSessionError::NotLoaded)?;
        Ok(self.session.render_revision())
    }

    /// Read clone-boundary input consumed by this exact retained frame.
    /// Null proof is explicit; it is never filled from current runtime state.
    /// This read-only fact does not acknowledge presentation or enable input.
    pub fn last_frame_input_json(&self, revision: u64) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        Ok(self
            .session
            .session()
            .ok_or(HostSessionError::NotLoaded)?
            .last_frame_input_json(revision)?)
    }

    /// Physical target of this exact retained publication, not latest device
    /// metrics. Reads no pixels and never evaluates View or acknowledges it.
    pub fn render_target_json(&self, revision: u64) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let target = self.session.render_target_for_revision(revision)?;
        Ok(serde_json::to_vec(&serde_json::json!({
            "version": "1.0",
            "sessionId": session.config().session_id,
            "renderRevision": revision.to_string(),
            "width": target.width,
            "height": target.height,
        }))?)
    }

    /// Compact dirty-state observation after ready/observer callback effects.
    pub fn view_revision(&self) -> Result<u64, HostSessionError> {
        Ok(self
            .session
            .session()
            .ok_or(HostSessionError::NotLoaded)?
            .view()
            .revision)
    }

    /// Observe authoritative navigation and execution state without entering
    /// JavaScript or implying that the current view has been presented. Large
    /// application data and resource bytes never cross this diagnostic API.
    pub fn runtime_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let current_page = session.app_service().pages().current();
        let route_path = current_page.map_or("", |page| page.path.as_str());
        let renderer_profile = session.renderer_profile_for_route(route_path);
        // Transport force mode can deliberately differ from the manifest.
        // Consumers need both facts to avoid treating an override as route policy.
        let declared_renderer_profile = session.manifest().renderer_profile_for_route(route_path);
        let mut state = serde_json::json!({
            "schemaVersion": 1,
            "sessionId": session.config().session_id,
            "currentPage": current_page.map(|page| serde_json::json!({
                "pageId": page.id.0.to_string(),
                "path": page.path,
            })),
            "rendererProfile": renderer_profile,
            "declaredRendererProfile": declared_renderer_profile,
            "transportBackend": self.renderer_mode.as_str(),
            "rendererPolicy": self.renderer_policy.map(WebRendererPolicy::to_json),
            "viewport": {
                "width": session.config().host.window_width,
                "height": session.config().host.window_height,
            },
            "viewRevision": session.view().revision.to_string(),
            // Activity includes accepted input; only template_revision identifies
            // changes that require View reevaluation. Neither is consumed proof.
            "templateRevision": session.view().template_revision.to_string(),
            "renderRevision": self.session.render_revision().to_string(),
            "lifecycle": self.session.lifecycle_state()?,
            "executionFault": session.execution_fault(),
            "requiresRestart": session.execution_fault().is_some(),
        });
        // Keep the legacy observation byte-for-byte when this optional native
        // lane has never been discovered. A browser clock cannot create it.
        if let Some(revision) = session.animation_sample_demand_revision() {
            state["sampleDemandRevision"] = serde_json::Value::String(revision.to_string());
        }
        Ok(serde_json::to_vec(&state)?)
    }

    /// Pure optional handshake. The ordered lane is Worker-owned; this host
    /// supplies an exact hard-lifetime token, never response-arrival ordering.
    pub const fn observation_contract_json(&self) -> &'static str {
        r#"{"version":"1.0","inputLifetime":"1.0"}"#
    }

    /// Pure snapshot. Preserve legacy runtime_state_json bytes/shape and expose
    /// the lifetime token only through this explicitly negotiated new export.
    pub fn observation_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let state: serde_json::Value = serde_json::from_slice(&self.runtime_state_json()?)?;
        Ok(serde_json::to_vec(&serde_json::json!({
            "version": "1.0",
            "inputLifetimeRevision": session.input_lifetime_revision().map(|revision| revision.to_string()),
            "state": state,
        }))?)
    }

    /// Confirm one external presenter's successful submit/flush on the runtime
    /// owner thread and return every resulting effect/error in one batch.
    pub fn acknowledge_presentation(
        &mut self,
        revision: u64,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.require_transition_frame_input(revision)?;
        let before_page = self
            .session
            .session()
            .and_then(|session| session.app_service().pages().current())
            .map(|page| (page.id, page.path.clone()));
        let batch = self
            .session
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .acknowledge_presentation(revision)?;
        if self.renderer_mode == WebRendererMode::ExternalFrame {
            let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
            let after_page = session
                .app_service()
                .pages()
                .current()
                .map(|page| (page.id, page.path.clone()));
            let eligible = before_page.is_some()
                && before_page == after_page
                && session.app_service().lifecycle().state() == LifecycleState::Active
                && session.execution_fault().is_none()
                && session.render_revision() == revision
                && session.is_current_frame_presented()
                // This bool is a lifetime gate only. Never attach or refresh
                // consumedInput here: prepare owns that immutable snapshot.
                && session.last_frame_input(revision).is_some();
            let errors = batch.messages.iter().any(|message| {
                message.op == container_bridge::op::ERROR
                    || message.payload.get("ok") == Some(&serde_json::Value::Bool(false))
                    || message.payload.get("requiresRestart")
                        == Some(&serde_json::Value::Bool(true))
            });
            let already_blocked = self
                .external_ack_blocked
                .is_some_and(|(token, blocked)| token == revision && blocked);
            self.external_ack_blocked = Some((revision, already_blocked || !eligible || errors));
        }
        Ok(batch)
    }

    /// Pure handshake: no session, engine entry, App initialization or surface
    /// allocation. Old load/capabilities/ACK formats remain independent.
    pub const fn external_presentation_contract_json(&self) -> &'static str {
        r#"{"version":"1.0","consumedInput":"1.0","ackOutcome":"1.0","physicalTarget":"1.0"}"#
    }

    /// Independent opt-in: older WASM must reject recovery before App starts.
    pub const fn surface_recovery_contract_json(&self) -> &'static str {
        r#"{"version":"1.0","retainedExternalFrame":"1.0"}"#
    }

    /// On the runtime owner thread, mint a new publication and input lifetime
    /// for an exact retained frame. The returned receipt grants no input.
    pub fn recover_external_frame_json(
        &mut self,
        expected_json: &[u8],
    ) -> Result<Vec<u8>, HostSessionError> {
        if self.renderer_mode != WebRendererMode::ExternalFrame {
            return Err(container_bridge::BridgeError::new(
                container_bridge::BridgeErrorCode::UnsupportedCapability,
                "surface recovery requires the external-frame transport",
            )
            .into());
        }
        if expected_json.len() > 16 * 1024 {
            return Err(container_bridge::BridgeError::protocol(
                "surface recovery expected input exceeds its finite budget",
            )
            .into());
        }
        let expected = serde_json::from_slice::<container_runtime::ExternalFrameRecoveryExpected>(
            expected_json,
        )
        .map_err(|error| {
            container_bridge::BridgeError::protocol(format!(
                "invalid surface recovery expected input: {error}"
            ))
        })?;
        self.require_transition_frame_input(self.session.render_revision())?;
        let recovery = self.session.recover_external_frame(&expected)?;
        self.external_ack_blocked = None;
        Ok(serde_json::to_vec(&recovery)?)
    }

    /// Genuine external ACK final. The entire effects batch survives committed
    /// ready errors, navigation and bounded-turn faults. Scheduling proof is
    /// deliberately absent; only prepare/frame accessors may supply it.
    pub fn acknowledge_presentation_outcome_json(
        &mut self,
        revision: u64,
    ) -> Result<Vec<u8>, HostSessionError> {
        if self.renderer_mode != WebRendererMode::ExternalFrame {
            return Err(container_runtime::SessionError::UnsupportedCapability(
                "structured external ACK requires the external-frame transport".into(),
            )
            .into());
        }
        let batch = self.acknowledge_presentation(revision)?;
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let observed_state: serde_json::Value =
            serde_json::from_slice(&self.runtime_state_json()?)?;
        let requires_restart = session.execution_fault().is_some()
            || (self.presenter_generation.is_none()
                && observed_state.get("rendererProfile")
                    == Some(&serde_json::Value::String("webview".into())))
            || batch.messages.iter().any(|message| {
                message.payload.get("requiresRestart") == Some(&serde_json::Value::Bool(true))
            });
        let input_enabled = !requires_restart
            && self.external_ack_blocked == Some((revision, false))
            && session.render_revision() == revision
            && session.is_current_frame_presented()
            && session.app_service().lifecycle().state() == LifecycleState::Active
            && session.app_service().pages().current().is_some()
            && session.execution_fault().is_none()
            && session.last_frame_input(revision).is_some();
        Ok(serde_json::to_vec(&serde_json::json!({
            "version": "1.0",
            "sessionId": session.config().session_id,
            "renderRevision": revision.to_string(),
            "acknowledged": true,
            "inputEnabled": input_enabled,
            "requiresRestart": requires_restart,
            "batch": batch,
            "observedState": observed_state,
        }))?)
    }

    /// Borrow declared asset bytes only after the runtime owner validates the
    /// complete pending/presented View identity and the content digest.
    pub fn browser_view_resource(
        &self,
        key: &PresentationKey,
        sha256: &str,
    ) -> Result<&[u8], HostSessionError> {
        self.session.browser_view_resource(key, sha256)
    }

    pub fn browser_view_resource_at_path(
        &self,
        key: &PresentationKey,
        sha256: &str,
        path: &str,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session
            .browser_view_resource_at_path(key, sha256, path)
    }

    /// Revoke a browser preview on its runtime owner thread. Contact
    /// cancellation and all resulting diagnostics return as one bridge batch.
    pub fn retire_browser_preview(
        &mut self,
        reason: &str,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.session.retire_browser_preview(reason)
    }

    /// Submit one complete display/window observation through the shared
    /// validation and resize lifecycle boundary.
    pub fn notify_window_metrics_json(
        &mut self,
        input: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.notify_window_metrics_json(input)
    }

    /// Repaint accepted layout at a new physical density without entering
    /// AppService or evaluating any View expression.
    pub fn set_render_scale(&mut self, scale: f64) -> Result<(), HostSessionError> {
        self.require_page_frame_renderer()?;
        self.require_transition_frame_input(self.session.render_revision())?;
        self.session.set_render_scale(scale)
    }

    pub fn session_initialized(&self) -> bool {
        self.session.initialized()
    }

    /// Dispatch one in-process envelope. Browser bindings can use
    /// [`Self::dispatch_json`] to cross WASM/JS in one batch.
    pub fn dispatch(&mut self, envelope: BridgeEnvelope) -> Result<BridgeBatch, HostSessionError> {
        self.session.dispatch(envelope)
    }

    pub fn start_session(
        &mut self,
        request_id: impl Into<String>,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.session.start(request_id)
    }

    /// Poll all due timers using the browser-owned clock and return one
    /// complete bridge event batch. Browser integrations should call this
    /// from their animation/timer loop rather than creating one callback per
    /// timer across the WASM boundary.
    pub fn poll_timers(&mut self, now_ns: u64) -> Result<BridgeBatch, HostSessionError> {
        self.session.poll_timers(now_ns)
    }

    pub fn poll_timers_json(&mut self, now_ns: u64) -> Result<Vec<u8>, HostSessionError> {
        self.session.poll_timers_json(now_ns)
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

    /// Dispatch the canonical `{messages:[...]}` bridge payload in one WASM
    /// boundary crossing. The shared host validates session/protocol
    /// invariants before entering the runtime.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        self.session.dispatch_batch_json(batch_json)
    }

    /// Return the latest committed frame as one serialized RGBA snapshot.
    /// In external-frame mode this is explicit software diagnostic rasterization,
    /// separate from the external presenter's GPU surface/readback receipt.
    /// Browser code can upload this batch to CanvasKit or an `ImageData`
    /// surface without asking Rust for individual nodes or pixels.
    pub fn render_snapshot_json(&self) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.session.render_snapshot_json()
    }

    /// Return the last committed frame as a typed batch for a host that can
    /// upload bytes directly. The WASM wrapper exposes the pixel-only method
    /// below because `RenderSnapshot` itself is not an FFI type.
    pub fn render_snapshot(&self) -> Result<RenderSnapshot, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.session.render_snapshot()
    }

    /// Whether CanvasKit has been connected to a browser GPU context. The
    /// Rust-side fallback remains false until the browser adapter reports a
    /// real context, even when a frame snapshot is available.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        self.session.has_gpu_surface()
    }

    /// Return only the tightly packed premultiplied RGBA8 pixels.  WASM
    /// bindings can expose this as a `Uint8Array`, avoiding JSON number
    /// expansion when uploading one complete frame to CanvasKit or
    /// `ImageData`. Use `render_snapshot_json` when dimensions/stride metadata
    /// are also needed.
    pub fn render_snapshot_rgba(&self) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        Ok(self.session.render_snapshot()?.pixels)
    }

    /// Read an independent Canvas 2D surface by id. Canvas surfaces are
    /// addressable layers and do not replace the page render snapshot.
    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        self.session.canvas_snapshot_json(canvas_id)
    }

    pub fn canvas_snapshot_rgba(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        self.require_page_frame_renderer()?;
        Ok(self.session.canvas_snapshot(canvas_id)?.pixels)
    }

    pub fn unload(&mut self) {
        self.session.unload();
        self.initialized = false;
        self.renderer_mode = WebRendererMode::Software;
        self.renderer_policy = None;
        self.presenter_generation = None;
    }
}

/// JavaScript-facing WASM wrapper.  The wrapper deliberately exposes complete
/// JSON bridge batches so a browser integration can keep the runtime on one
/// thread and avoid a JS↔Rust call for each WXML node or data patch.
#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
pub struct WebWasmHost {
    inner: WebHost,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen::prelude::wasm_bindgen]
impl WebWasmHost {
    #[wasm_bindgen::prelude::wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: WebHost::new(),
        }
    }

    pub fn host_services_protocol_json(&self) -> String {
        serde_json::json!({"version":"1.0", "trustedContext":true,
            "ownerThreadCompletion":true,"events":true,"revocation":true,"components":true,"snapshots":true,"componentFrames":"1.0","packagedApiResources":"1.0"}).to_string()
    }

    /// Binary font ingress is host-only and precedes load/app.init. The
    /// returned identity must match every externally painted text plan.
    pub fn configure_text_font(
        &mut self,
        bytes: Vec<u8>,
        sha256: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .configure_text_font(bytes.into(), &sha256)
            .and_then(|identity| serde_json::to_string(&identity).map_err(HostSessionError::from))
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn enable_development_sandbox(&mut self) -> Result<(), wasm_bindgen::JsValue> {
        self.inner
            .enable_development_sandbox()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn configure_host_services_json(
        &mut self,
        config: String,
    ) -> Result<(), wasm_bindgen::JsValue> {
        self.inner
            .configure_host_services_json(config.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn take_host_requests_json(&mut self) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .take_host_requests_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn complete_host_api_call_json(
        &mut self,
        call_id: String,
        result: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .complete_host_api_call_json(&call_id, result.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn dispatch_host_api_event_json(
        &mut self,
        event: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .dispatch_host_api_event_json(event.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn revoke_host_services_json(&mut self) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .revoke_host_services_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn authorize_phone_button_json(
        &mut self,
        node_id: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .authorize_phone_button_json(&node_id)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn dispatch_host_component_event_json(
        &mut self,
        event: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .dispatch_host_component_event_json(event.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn update_host_service_snapshots_json(
        &mut self,
        values: String,
    ) -> Result<(), wasm_bindgen::JsValue> {
        self.inner
            .update_host_service_snapshots_json(values.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn host_component_snapshots_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        self.inner
            .host_component_snapshots_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
            })
    }

    pub fn submit_host_component_frame(
        &mut self,
        metadata: String,
        pixels: Vec<u8>,
    ) -> Result<bool, wasm_bindgen::JsValue> {
        self.inner
            .submit_host_component_frame(metadata.as_bytes(), pixels)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn host_component_resource(
        &self,
        metadata: String,
    ) -> Result<Option<Vec<u8>>, wasm_bindgen::JsValue> {
        self.inner
            .host_component_resource(metadata.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn host_api_resource(&self, context: String) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
        self.inner
            .host_api_resource(context.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Load one portable manifest JSON document. The manifest stays owned by
    /// the Rust session after this call returns.
    pub fn load_manifest_json(
        &mut self,
        manifest_json: String,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let config = SessionConfig {
            require_integrity: true,
            ..SessionConfig::default()
        };
        self.load_manifest_with_config(
            manifest_json.as_bytes(),
            config,
            WebSessionOptions::default(),
            None,
        )
    }

    /// Select the engine and host/session metadata explicitly. A production
    /// WASM session cannot initialize against the protocol-only boundary.
    pub fn load_manifest_json_with_config(
        &mut self,
        manifest_json: String,
        config_json: String,
    ) -> Result<(), wasm_bindgen::JsValue> {
        let (config, options, policy) =
            WebSessionOptions::parse_config_json_with_policy(&config_json)
                .map_err(|error| wasm_bindgen::JsValue::from_str(&error))?;
        self.load_manifest_with_config(manifest_json.as_bytes(), config, options, policy)
    }

    /// Send the standard app.init handshake and return one serialized batch.
    pub fn start_session(&mut self, request_id: String) -> Result<String, wasm_bindgen::JsValue> {
        let batch = self
            .inner
            .start_session(request_id)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        serde_json::to_string(&batch)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Poll all timers due at the browser-provided clock value and return one
    /// serialized bridge batch. Browser scheduling remains owned by JS.
    pub fn poll_timers(&mut self, now_ns: u64) -> Result<String, wasm_bindgen::JsValue> {
        let batch = self
            .inner
            .poll_timers(now_ns)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        serde_json::to_string(&batch)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Dispatch one complete bridge envelope and return one complete batch.
    pub fn dispatch_json(
        &mut self,
        envelope_json: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .dispatch_json(envelope_json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Dispatch one complete `{messages:[...]}` bridge batch. This is kept
    /// separate from `dispatch_json` for bindings that want a typed batch
    /// API while preserving the backwards-compatible single-envelope entry.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .dispatch_batch_json(batch_json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Serialize the latest committed frame in one WASM boundary crossing.
    pub fn render_snapshot_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .render_snapshot_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// A single visual-tree batch for an external CanvasKit presenter.
    /// Exporting it does not claim an attached or accelerated GPU surface.
    pub fn render_frame_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .render_frame_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Export layout and owned binary pixels without a JSON pixel roundtrip.
    pub fn render_frame_binary(&self) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
        self.inner
            .render_frame_binary()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn render_revision(&self) -> Result<u64, wasm_bindgen::JsValue> {
        self.inner
            .render_revision()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Exact-revision scheduling facts; u64 remains a WASM BigInt token.
    pub fn last_frame_input_json(&self, revision: u64) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .last_frame_input_json(revision)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn render_target_json(&self, revision: u64) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .render_target_json(revision)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn view_revision(&self) -> Result<u64, wasm_bindgen::JsValue> {
        self.inner
            .view_revision()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Read-only runtime facts, distinct from any renderer presentation receipt.
    pub fn runtime_state_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .runtime_state_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn acknowledge_presentation(
        &mut self,
        revision: u64,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let batch = self
            .inner
            .acknowledge_presentation(revision)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        serde_json::to_string(&batch)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn observation_contract_json(&self) -> String {
        self.inner.observation_contract_json().into()
    }

    pub fn observation_state_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .observation_state_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn renderer_transition_contract_json(&self) -> String {
        self.inner.renderer_transition_contract_json().into()
    }

    pub fn enable_renderer_transitions_json(
        &mut self,
        json: &str,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .enable_renderer_transitions_json(json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn renderer_transition_state_json(&self) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .renderer_transition_state_json()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn transition_renderer_json(
        &mut self,
        json: &str,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .transition_renderer_json(json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn retire_page_presenter(
        &mut self,
        reason: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let batch = self
            .inner
            .retire_page_presenter(&reason)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        serde_json::to_string(&batch)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Pure optional contract handshake; available before loading application JS.
    pub fn external_presentation_contract_json(&self) -> String {
        self.inner.external_presentation_contract_json().into()
    }

    pub fn surface_recovery_contract_json(&self) -> String {
        self.inner.surface_recovery_contract_json().into()
    }

    pub fn recover_external_frame_json(
        &mut self,
        expected_json: &str,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .recover_external_frame_json(expected_json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Structured final ACK, separate from legacy BridgeBatch serialization.
    pub fn acknowledge_presentation_outcome_json(
        &mut self,
        revision: u64,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .acknowledge_presentation_outcome_json(revision)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Transfer one authorized asset buffer. A known hash alone does not grant
    /// access: the runtime checks the full presentation key before copying.
    pub fn browser_view_resource(
        &self,
        key_json: String,
        sha256: String,
    ) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
        let key: PresentationKey = serde_json::from_str(&key_json)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        self.inner
            .browser_view_resource(&key, &sha256)
            .map(|bytes| bytes.to_vec())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn browser_view_resource_at_path(
        &self,
        key_json: String,
        sha256: String,
        path: String,
    ) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
        let key: PresentationKey = serde_json::from_str(&key_json)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        self.inner
            .browser_view_resource_at_path(&key, &sha256, &path)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Update logical dimensions and display metadata on the runtime owner.
    /// The returned JSON contains every resize/media-query callback effect.
    pub fn notify_window_metrics_json(
        &mut self,
        json: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let bytes = self
            .inner
            .notify_window_metrics_json(json.as_bytes())
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        String::from_utf8(bytes)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// End this preview lease and return contact retirement/effects/errors.
    pub fn retire_browser_preview(
        &mut self,
        reason: String,
    ) -> Result<String, wasm_bindgen::JsValue> {
        let batch = self
            .inner
            .retire_browser_preview(&reason)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))?;
        serde_json::to_string(&batch)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Change only renderer density; this entry never invokes application JS.
    pub fn set_render_scale(&mut self, scale: f64) -> Result<(), wasm_bindgen::JsValue> {
        self.inner
            .set_render_scale(scale)
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    /// Return one typed pixel buffer for a CanvasKit/ImageData upload. The
    /// caller obtains width, height and stride from `render_snapshot_json`;
    /// this method keeps the hot pixel path free of JSON serialization.
    pub fn render_snapshot_rgba(&self) -> Result<Vec<u8>, wasm_bindgen::JsValue> {
        self.inner
            .render_snapshot_rgba()
            .map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }

    pub fn capabilities_json(&self) -> String {
        serde_json::json!({
            "host": "web",
            "distributionProfile": container_runtime::distribution_identity().distribution_profile,
            "policySha256": container_runtime::distribution_identity().policy_sha256,
            "renderer": self.inner.info().capabilities.renderer,
            "browserView": self.inner.info().capabilities.browser_view,
            "gpuSurface": self.inner.info().capabilities.gpu_surface,
            "quickjs": self.inner.info().capabilities.quickjs,
            "v8": self.inner.info().capabilities.v8,
        })
        .to_string()
    }

    pub fn unload(&mut self) {
        self.inner.unload();
    }
}

#[cfg(feature = "wasm")]
impl WebWasmHost {
    fn load_manifest_with_config(
        &mut self,
        manifest_json: &[u8],
        config: SessionConfig,
        options: WebSessionOptions,
        policy: Option<WebRendererPolicy>,
    ) -> Result<(), wasm_bindgen::JsValue> {
        if !engine_provider_compiled(config.engine) {
            return Err(wasm_bindgen::JsValue::from_str(&format!(
                "ERR_ENGINE: requested {:?} provider is unavailable in this Web build",
                config.engine
            )));
        }
        let loaded = match policy {
            Some(policy) => self.inner.load_manifest_json_with_renderer_policy(
                manifest_json,
                config,
                options,
                policy,
            ),
            None => self
                .inner
                .load_manifest_json_with_options(manifest_json, config, options),
        };
        loaded.map_err(|error| wasm_bindgen::JsValue::from_str(&error.to_string()))
    }
}

#[cfg(feature = "wasm")]
impl Default for WebWasmHost {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owner_api_manifest() -> container_ir::ContainerManifestV1 {
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1};
        ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "web-owner-api-contract".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        }
    }

    #[test]
    fn owner_operations_require_a_loaded_session() {
        let mut host = WebHost::new();
        let key = PresentationKey {
            session_id: "session-1".into(),
            page_id: 1,
            document_revision: 1,
            presentation_revision: 1,
            surface_generation: 1,
            profile: container_ir::RendererProfile::WebView,
        };
        assert!(matches!(
            host.browser_view_resource(&key, &"a".repeat(64)),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.retire_browser_preview("worker-exit"),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.set_render_scale(2.0),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.runtime_state_json(),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(!host.has_session());
    }

    #[test]
    fn runtime_state_tracks_navigation_and_effective_profile_without_exporting_page_data() {
        use container_bridge::op;
        use container_ir::{RendererProfile, RendererProfiles, Route, RouteKind};
        use serde_json::{json, Value};

        let mut manifest = owner_api_manifest();
        manifest.schema_version = 3;
        for path in ["pages/home/index", "pages/detail/index"] {
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("{path}.js"),
            });
        }
        manifest.rendering = Some(RendererProfiles {
            pages: [("pages/detail/index".into(), RendererProfile::SkylineCompat)].into(),
            ..Default::default()
        });
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
        )
        .unwrap();
        let state = |host: &WebHost| -> Value {
            serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap()
        };
        let initial = state(&host);
        assert_eq!(initial["schemaVersion"], 1);
        assert_eq!(initial["sessionId"], "session-1");
        assert_eq!(initial["currentPage"], Value::Null);
        assert_eq!(initial["rendererProfile"], "skia");
        assert_eq!(initial["declaredRendererProfile"], "skia");
        assert_eq!(initial["lifecycle"], "Created");
        assert_eq!(initial["executionFault"], Value::Null);
        assert_eq!(initial["requiresRestart"], false);
        assert_eq!(initial["viewRevision"], "0");
        assert_eq!(initial["templateRevision"], "0");
        assert_eq!(initial["renderRevision"], "0");
        assert_eq!(initial["viewport"], json!({"width": 0, "height": 0}));
        assert_eq!(initial.as_object().unwrap().len(), 14);

        host.start_session("state-init").unwrap();
        for (operation, payload) in [
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/home/index"})),
        ] {
            let batch = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    operation,
                    operation,
                    payload,
                ))
                .unwrap();
            assert!(
                batch.messages.iter().all(|m| m.payload["ok"] != false),
                "{batch:?}"
            );
        }
        let home = state(&host);
        assert_eq!(home["lifecycle"], "Active");
        assert_eq!(home["currentPage"]["path"], "pages/home/index");
        assert!(home["currentPage"]["pageId"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .is_ok());
        assert_eq!(home["currentPage"].as_object().unwrap().len(), 2);
        assert_eq!(home["rendererProfile"], "skia");
        let push = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "state-detail",
                op::PAGE_PUSH,
                json!({"path":"pages/detail/index"}),
            ))
            .unwrap();
        assert!(
            push.messages.iter().all(|m| m.payload["ok"] != false),
            "{push:?}"
        );
        let detail = state(&host);
        assert_eq!(detail["currentPage"]["path"], "pages/detail/index");
        assert_ne!(
            detail["currentPage"]["pageId"],
            home["currentPage"]["pageId"]
        );
        assert_eq!(detail["rendererProfile"], "skyline-compat");
        assert_eq!(detail["declaredRendererProfile"], "skyline-compat");
        let pop = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "state-back",
                op::PAGE_POP,
                json!({}),
            ))
            .unwrap();
        assert!(
            pop.messages.iter().all(|m| m.payload["ok"] != false),
            "{pop:?}"
        );
        let returned = state(&host);
        assert_eq!(returned["currentPage"], home["currentPage"]);
        assert_eq!(returned["rendererProfile"], "skia");
        assert_eq!(returned["declaredRendererProfile"], "skia");
        assert_eq!(
            returned["templateRevision"],
            host.session
                .session()
                .unwrap()
                .view()
                .template_revision
                .to_string()
        );
        assert_eq!(
            returned["viewRevision"],
            host.view_revision().unwrap().to_string()
        );
        assert_eq!(
            returned["renderRevision"],
            host.render_revision().unwrap().to_string()
        );
        assert_eq!(
            state(&host),
            returned,
            "observation must not enter JS or mutate state"
        );
        host.unload();
        assert!(matches!(
            host.runtime_state_json(),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn runtime_state_preserves_declared_route_profile_under_explicit_browser_force_mode() {
        use container_bridge::op;
        use container_ir::{RendererProfile, RendererProfiles, Route, RouteKind};
        use serde_json::{json, Value};
        let mut manifest = owner_api_manifest();
        manifest.schema_version = 3;
        for path in ["pages/home/index", "pages/detail/index"] {
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("{path}.js"),
            });
        }
        manifest.rendering = Some(RendererProfiles {
            pages: [("pages/detail/index".into(), RendererProfile::SkylineCompat)].into(),
            ..Default::default()
        });
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::BrowserView,
            },
        )
        .unwrap();
        host.start_session("forced-state-init").unwrap();
        host.dispatch_lifecycle("forced-state-launch", "launch")
            .unwrap();
        for (index, (path, declared)) in [
            ("pages/home/index", "skia"),
            ("pages/detail/index", "skyline-compat"),
        ]
        .into_iter()
        .enumerate()
        {
            let batch = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    format!("forced-state-push-{index}"),
                    op::PAGE_PUSH,
                    json!({"path":path,"data":{"secret":"not exported"}}),
                ))
                .unwrap();
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            let bytes = host.runtime_state_json().unwrap();
            let state: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(state["currentPage"]["path"], path);
            assert_eq!(state["rendererProfile"], "webview");
            assert_eq!(state["declaredRendererProfile"], declared);
            assert!(state["currentPage"].get("data").is_none());
            assert_eq!(
                host.runtime_state_json().unwrap(),
                bytes,
                "state observations must not enter JS or revise input"
            );
        }
    }

    #[test]
    fn runtime_state_separates_accepted_event_activity_from_template_input() {
        use container_bridge::op;
        use container_ir::{Route, RouteKind};
        use serde_json::{json, Value};
        let mut manifest = owner_api_manifest();
        manifest.routes.push(Route {
            id: "route:pages/home/index".into(),
            path: "pages/home/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/home/index.js".into(),
        });
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
        )
        .unwrap();
        host.start_session("revision-init").unwrap();
        host.dispatch_lifecycle("revision-launch", "launch")
            .unwrap();
        for (id, operation, payload) in [
            (
                "revision-page",
                op::PAGE_PUSH,
                json!({"path":"pages/home/index"}),
            ),
            (
                "revision-frame",
                op::RENDER_COMMIT,
                json!({"frame":{
                    "frameId":1,"viewport":{"x":0,"y":0,"width":10,"height":10},
                    "root":{"id":"page","bounds":{"x":0,"y":0,"width":10,"height":10},
                        "opacity":1,"children":[]}
                }}),
            ),
        ] {
            let batch = host
                .dispatch(BridgeEnvelope::request("session-1", id, operation, payload))
                .unwrap();
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        }
        host.acknowledge_presentation(host.render_revision().unwrap())
            .unwrap();
        let state = |host: &WebHost| -> Value {
            serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap()
        };
        let before = state(&host);
        let batch = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "revision-tap",
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":5,"y":5}]}),
            ))
            .unwrap();
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert_eq!(batch.messages[0].payload["events"], 1);
        let after_event = state(&host);
        assert_ne!(after_event["viewRevision"], before["viewRevision"]);
        assert_eq!(after_event["templateRevision"], before["templateRevision"]);
        let batch = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "revision-patch",
                op::DATA_PATCH_BATCH,
                json!({"pageId":1,"patches":[{"path":"count","op":"set","value":1}]}),
            ))
            .unwrap();
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        let patched = state(&host);
        assert_ne!(patched["templateRevision"], after_event["templateRevision"]);
        assert_eq!(
            state(&host),
            patched,
            "pure observation must not create another demand"
        );
    }

    #[test]
    fn explicit_policy_parser_preserves_old_options_literals_and_rejects_silent_loss() {
        use serde_json::json;
        // This exact old public literal must continue to compile without a new
        // field or a Default update in embedding applications.
        let legacy_literal = WebSessionOptions {
            renderer_mode: WebRendererMode::BrowserView,
        };
        let (_, legacy) =
            WebSessionOptions::parse_config_json(r#"{"renderer_mode":"browser-view"}"#).unwrap();
        assert_eq!(legacy, legacy_literal);
        let (_, new_legacy, no_policy) =
            WebSessionOptions::parse_config_json_with_policy(r#"{"renderer_mode":"browser-view"}"#)
                .unwrap();
        assert_eq!(new_legacy, legacy_literal);
        assert_eq!(no_policy, None);
        for (policy, expected) in [
            (json!({"mode":"manifest"}), WebRendererPolicy::Manifest),
            (
                json!({"mode":"force","profile":"webview"}),
                WebRendererPolicy::Force {
                    profile: container_ir::RendererProfile::WebView,
                },
            ),
            (
                json!({"mode":"force","profile":"skyline-compat"}),
                WebRendererPolicy::Force {
                    profile: container_ir::RendererProfile::SkylineCompat,
                },
            ),
        ] {
            let input =
                json!({"renderer_mode":"external-frame", "renderer_policy":policy}).to_string();
            let (_, options, parsed) =
                WebSessionOptions::parse_config_json_with_policy(&input).unwrap();
            assert_eq!(options.renderer_mode, WebRendererMode::ExternalFrame);
            assert_eq!(parsed, Some(expected));
            assert!(
                WebSessionOptions::parse_config_json(&input)
                    .unwrap_err()
                    .contains("requires parse_config_json_with_policy"),
                "the old two-value parser must never discard a valid explicit policy"
            );
        }
        for invalid in [
            json!(null),
            json!("manifest"),
            json!({"mode":"auto"}),
            json!({"mode":"manifest","profile":"webview"}),
            json!({"mode":"force"}),
            json!({"mode":"force","profile":"skyline"}),
            json!({"mode":"force","profile":"skia","extra":true}),
        ] {
            assert!(WebSessionOptions::parse_config_json_with_policy(
                &json!({
                    "renderer_mode":"external-frame", "renderer_policy":invalid,
                })
                .to_string()
            )
            .unwrap_err()
            .starts_with("ERR_RENDER"));
        }
    }

    fn mixed_renderer_policy_manifest() -> container_ir::ContainerManifestV1 {
        use container_ir::{RendererProfile, RendererProfiles, Route, RouteKind};
        let mut manifest = owner_api_manifest();
        manifest.schema_version = container_ir::RENDERING_MANIFEST_SCHEMA_VERSION;
        manifest.rendering = Some(RendererProfiles::default());
        for (path, profile) in [
            ("pages/native/index", RendererProfile::Skia),
            ("pages/browser/index", RendererProfile::WebView),
            ("pages/skyline/index", RendererProfile::SkylineCompat),
        ] {
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("{path}.js"),
            });
            manifest
                .rendering
                .as_mut()
                .unwrap()
                .pages
                .insert(path.into(), profile);
        }
        manifest
    }

    #[test]
    fn explicit_manifest_policy_keeps_real_route_profiles_without_transport_override() {
        use container_bridge::op;
        use serde_json::{json, Value};
        for mode in [WebRendererMode::ExternalFrame, WebRendererMode::BrowserView] {
            let mut host = WebHost::new();
            host.load_manifest_json_with_renderer_policy(
                serde_json::to_vec(&mixed_renderer_policy_manifest()).unwrap(),
                SessionConfig::default(),
                WebSessionOptions {
                    renderer_mode: mode,
                },
                WebRendererPolicy::Manifest,
            )
            .unwrap();
            assert!(
                host.session
                    .session()
                    .unwrap()
                    .config()
                    .browser_view_enabled
            );
            assert_eq!(
                host.session.session().unwrap().config().renderer_override,
                None
            );
            host.start_session("policy-init").unwrap();
            for (path, profile) in [
                ("pages/native/index", "skia"),
                ("pages/browser/index", "webview"),
                ("pages/skyline/index", "skyline-compat"),
            ] {
                let batch = host
                    .dispatch(BridgeEnvelope::request(
                        "session-1",
                        path,
                        op::PAGE_PUSH,
                        json!({"path":path}),
                    ))
                    .unwrap();
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                let state: Value =
                    serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
                assert_eq!(state["rendererProfile"], profile);
                assert_eq!(state["declaredRendererProfile"], profile);
                assert_eq!(state["rendererPolicy"], json!({"mode":"manifest"}));
                assert_eq!(state["transportBackend"], mode.as_str());
                assert_eq!(state["currentPage"]["path"], path);
                // The low-level host exposes semantic truth. Fixed-family
                // admission belongs to the serialized Worker owner.
            }
        }
    }

    #[test]
    fn explicit_force_and_conflicting_policy_loads_are_observable_and_atomic() {
        use container_ir::RendererProfile;
        use serde_json::{json, Value};
        let bytes = serde_json::to_vec(&mixed_renderer_policy_manifest()).unwrap();
        let mut host = WebHost::new();
        host.load_manifest_json_with_renderer_policy(
            &bytes,
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
            WebRendererPolicy::Force {
                profile: RendererProfile::SkylineCompat,
            },
        )
        .unwrap();
        host.start_session("force-init").unwrap();
        host.dispatch(BridgeEnvelope::request(
            "session-1",
            "force-browser",
            container_bridge::op::PAGE_PUSH,
            json!({"path":"pages/browser/index"}),
        ))
        .unwrap();
        let before = host.runtime_state_json().unwrap();
        let state: Value = serde_json::from_slice(&before).unwrap();
        assert_eq!(state["declaredRendererProfile"], "webview");
        assert_eq!(state["rendererProfile"], "skyline-compat");
        assert_eq!(
            state["rendererPolicy"],
            json!({"mode":"force","profile":"skyline-compat"})
        );
        for (config, options, policy) in [
            (
                SessionConfig::default(),
                WebSessionOptions {
                    renderer_mode: WebRendererMode::ExternalFrame,
                },
                WebRendererPolicy::Force {
                    profile: RendererProfile::WebView,
                },
            ),
            (
                SessionConfig {
                    renderer_override: Some(RendererProfile::WebView),
                    ..Default::default()
                },
                WebSessionOptions {
                    renderer_mode: WebRendererMode::ExternalFrame,
                },
                WebRendererPolicy::Manifest,
            ),
            (
                SessionConfig::default(),
                WebSessionOptions {
                    renderer_mode: WebRendererMode::Software,
                },
                WebRendererPolicy::Manifest,
            ),
        ] {
            assert!(host
                .load_manifest_json_with_renderer_policy(&bytes, config, options, policy)
                .is_err());
            assert_eq!(
                host.runtime_state_json().unwrap(),
                before,
                "a rejected policy must preserve the running host"
            );
        }
        host.unload();
        assert_eq!(host.renderer_policy, None);
        assert_eq!(host.info().backend, WebBackend::Stub);
    }

    #[test]
    fn owner_window_observation_is_atomic_and_density_does_not_change_device_metrics() {
        use container_bridge::op;
        use serde_json::json;
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&owner_api_manifest()).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
        )
        .unwrap();
        host.start_session("owner-init").unwrap();
        let observation = json!({
            "windowWidth":375,"windowHeight":667,"pixelRatio":2.75,
            "screenWidth":393,"screenHeight":873,"statusBarHeight":24.0,
            "screenTop":0.0,"deviceOrientation":"portrait"
        });
        let input = serde_json::to_vec(&observation).unwrap();
        let updated: BridgeBatch =
            serde_json::from_slice(&host.notify_window_metrics_json(&input).unwrap()).unwrap();
        assert_eq!(updated.messages[0].payload["type"], "host.resize");
        let metrics = host.session.session().unwrap().config().host.clone();
        let state: serde_json::Value =
            serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        assert_eq!(state["viewport"], json!({"width":375,"height":667}));
        let lifecycle = host.lifecycle_sequence().unwrap();
        let revision = host.view_revision().unwrap();
        host.dispatch(BridgeEnvelope::request(
            "session-1",
            "owner-render",
            op::RENDER_COMMIT,
            json!({"frame": {
                "frameId":1,"viewport":{"x":0,"y":0,"width":375,"height":667},
                "root":{"id":"page","bounds":{"x":0,"y":0,"width":375,"height":667},
                    "opacity":1,"children":[]}
            }}),
        ))
        .unwrap();
        let frame = host.render_frame_json().unwrap();
        host.set_render_scale(2.0).unwrap();
        assert_eq!(host.render_frame_json().unwrap(), frame);
        assert_eq!(host.view_revision().unwrap(), revision);
        assert_eq!(host.lifecycle_sequence().unwrap(), lifecycle);
        let actual = &host.session.session().unwrap().config().host;
        assert_eq!(actual.window_width, metrics.window_width);
        assert_eq!(actual.window_height, metrics.window_height);
        assert_eq!(actual.display_metrics, metrics.display_metrics);
        let render_revision = host.render_revision().unwrap();
        assert!(matches!(
            host.set_render_scale(f64::NAN),
            Err(HostSessionError::Render(_))
        ));
        assert_eq!(host.render_revision().unwrap(), render_revision);
        assert_eq!(host.render_frame_json().unwrap(), frame);

        let mut invalid = observation;
        invalid["pixelRatio"] = json!(0);
        assert!(host
            .notify_window_metrics_json(serde_json::to_vec(&invalid).unwrap())
            .is_err());
        assert!(host.notify_window_metrics_json(b"{").is_err());
        let state: serde_json::Value =
            serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        assert_eq!(state["viewport"], json!({"width":375,"height":667}));
        let actual = &host.session.session().unwrap().config().host;
        assert_eq!(actual.window_width, metrics.window_width);
        assert_eq!(actual.window_height, metrics.window_height);
        assert_eq!(actual.display_metrics, metrics.display_metrics);
        let duplicate: BridgeBatch =
            serde_json::from_slice(&host.notify_window_metrics_json(input).unwrap()).unwrap();
        assert!(duplicate.messages.is_empty());
    }

    #[test]
    fn owner_resource_reads_require_current_view_authority_and_retirement_revokes_it() {
        use container_bridge::op;
        use container_ir::{hex_digest, parse_wxml, Asset, Route, RouteKind, Template};
        use serde_json::json;
        let bytes = b"declared browser asset";
        let digest = hex_digest(bytes);
        let wxml = parse_wxml("<view/>").unwrap().canonical_json().unwrap();
        let template_digest = hex_digest(&wxml);
        let template_blob = format!("sha256:{template_digest}");
        let asset_blob = format!("sha256:{digest}");
        let mut manifest = owner_api_manifest();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: template_blob.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.assets.push(Asset {
            path: "assets/data.bin".into(),
            sha256: digest.clone(),
            mime: "application/octet-stream".into(),
            size: bytes.len() as u64,
        });
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::BrowserView,
            },
        )
        .unwrap();
        for (operation, payload) in [
            (
                op::APP_INIT,
                json!({"blobs":{template_blob:wxml,asset_blob:bytes.as_slice()}}),
            ),
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/index/index"})),
        ] {
            let batch = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    operation,
                    operation,
                    payload,
                ))
                .unwrap();
            assert!(
                batch
                    .messages
                    .iter()
                    .all(|message| message.payload["ok"] != false),
                "{batch:?}"
            );
        }
        let submission = host
            .session
            .session_mut()
            .unwrap()
            .prepare_browser_view(
                &json!({"templateId":"template:pages/index/index.wxml","useSessionResources":true,
                    "viewport":{"width":375,"height":667}}),
                1,
            )
            .unwrap();
        assert!(!host.session.session().unwrap().is_current_frame_presented());
        let runtime: serde_json::Value =
            serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        assert_eq!(runtime["rendererProfile"], "webview");
        assert_eq!(
            host.browser_view_resource(&submission.key, &digest)
                .unwrap(),
            bytes
        );
        assert!(host
            .browser_view_resource(&submission.key, &template_digest)
            .is_err());
        let mut stale = submission.key.clone();
        stale.surface_generation += 1;
        assert!(host.browser_view_resource(&stale, &digest).is_err());
        stale = submission.key.clone();
        stale.session_id = "other-session".into();
        assert!(host.browser_view_resource(&stale, &digest).is_err());
        assert!(host
            .load_manifest_json(b"{}", SessionConfig::default())
            .is_err());
        assert_eq!(host.info().backend, WebBackend::BrowserViewExport);
        assert_eq!(
            host.browser_view_resource(&submission.key, &digest)
                .unwrap(),
            bytes
        );
        host.retire_browser_preview("worker-exit").unwrap();
        assert!(host
            .browser_view_resource(&submission.key, &digest)
            .is_err());
    }

    #[test]
    fn web_renderer_options_are_explicit_and_reject_invalid_modes_without_fallback() {
        let (config, options) = WebSessionOptions::parse_config_json("{}").unwrap();
        assert_eq!(config.engine, EngineKind::Quickjs);
        assert_eq!(options.renderer_mode, WebRendererMode::Software);
        let (config, options) = WebSessionOptions::parse_config_json(
            r#"{"session_id":"external-web","engine":"quickjs","renderer_mode":"external-frame"}"#,
        )
        .unwrap();
        assert_eq!(config.session_id, "external-web");
        assert_eq!(options.renderer_mode, WebRendererMode::ExternalFrame);
        let (config, options) = WebSessionOptions::parse_config_json(
            r#"{"renderer_mode":"browser-view","engine_execution":{"turn_timeout_ms":250,"bootstrap_timeout_ms":5000}}"#,
        ).unwrap();
        assert_eq!(options.renderer_mode, WebRendererMode::BrowserView);
        assert_eq!(config.engine_execution.turn_timeout_ms, Some(250));
        assert_eq!(config.engine_execution.bootstrap_timeout_ms, Some(5000));
        for invalid in [
            r#"{"renderer_mode":"canvaskit"}"#,
            r#"{"renderer_mode":"auto"}"#,
            r#"{"renderer_mode":""}"#,
            r#"{"renderer_mode":null}"#,
            r#"{"renderer_mode":false}"#,
            r#"{"renderer_mode":3}"#,
        ] {
            assert!(WebSessionOptions::parse_config_json(invalid)
                .unwrap_err()
                .starts_with("ERR_RENDER:"));
        }
        assert!(WebSessionOptions::parse_config_json("not-json")
            .unwrap_err()
            .starts_with("ERR_INVALID_MANIFEST:"));
    }

    #[test]
    fn browser_view_is_an_explicit_document_export_boundary_without_raster_fallback() {
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&owner_api_manifest()).unwrap(),
            SessionConfig {
                renderer_override: Some(container_ir::RendererProfile::Skia),
                ..Default::default()
            },
            WebSessionOptions {
                renderer_mode: WebRendererMode::BrowserView,
            },
        )
        .unwrap();
        assert_eq!(host.info().backend, WebBackend::BrowserViewExport);
        assert_eq!(host.info().capabilities.renderer, "browser-view-export");
        assert!(host.info().capabilities.browser_view);
        assert!(!host.info().capabilities.gpu_surface);
        assert!(!host.info().capabilities.native_surface);
        let session = host.session.session().unwrap();
        assert!(session.config().browser_view_enabled);
        assert_eq!(
            session.config().renderer_override,
            Some(container_ir::RendererProfile::WebView)
        );
        assert_eq!(
            session.config().page_render_mode,
            container_render_skia::PageRenderMode::ExternalFrame
        );
        assert!(!session.is_current_frame_presented());
        for operation in [
            host.render_frame_json().map(|_| ()),
            host.render_snapshot_json().map(|_| ()),
            host.render_snapshot().map(|_| ()),
            host.render_snapshot_rgba().map(|_| ()),
            host.canvas_snapshot_json("canvas").map(|_| ()),
            host.canvas_snapshot_rgba("canvas").map(|_| ()),
            host.set_render_scale(2.0),
            host.acknowledge_presentation(1).map(|_| ()),
        ] {
            assert!(matches!(
                operation,
                Err(HostSessionError::Session(
                    container_runtime::SessionError::UnsupportedCapability(_)
                ))
            ));
        }
        host.unload();
        assert_eq!(host.info(), HostInfo::current());
        assert!(!host.info().capabilities.browser_view);
    }

    #[cfg(all(feature = "quickjs-native", not(target_arch = "wasm32")))]
    #[test]
    fn runtime_state_remains_readable_after_an_interrupted_appservice_turn() {
        use std::process::{Child, Command, Stdio};
        use std::time::{Duration, Instant};

        struct OwnedChild(Option<Child>);
        impl Drop for OwnedChild {
            fn drop(&mut self) {
                if let Some(mut process) = self.0.take() {
                    if let Err(error) = process.kill() {
                        eprintln!("owned Web state test child kill reported: {error}");
                    }
                    if let Err(error) = process.wait() {
                        eprintln!("owned Web state test child cleanup failed: {error}");
                    }
                }
            }
        }
        // Even the finite slow fixture has an independent exact-child watchdog:
        // failure of the engine interrupt cannot stall the rest of the suite.
        let mut owned = OwnedChild(Some(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::runtime_state_fault_child",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .env("WEAPP_CONTAINER_WEB_STATE_FAULT_CHILD", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("spawn owned Web state test child"),
        ));
        let started = Instant::now();
        loop {
            let process = owned.0.as_mut().unwrap();
            if process.try_wait().unwrap().is_some() {
                let output = owned.0.take().unwrap().wait_with_output().unwrap();
                assert!(
                    output.status.success(),
                    "stdout: {}\nstderr: {}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "Web runtime state fixture exceeded its independent watchdog"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[cfg(all(feature = "quickjs-native", not(target_arch = "wasm32")))]
    #[test]
    #[ignore = "runs only in its owned watchdog child"]
    fn runtime_state_fault_child() {
        use container_bridge::op;
        use container_ir::{hex_digest, Module, ModuleFormat, ModuleScope};
        use container_runtime::EngineExecutionPolicy;
        use serde_json::{json, Value};

        assert_eq!(
            std::env::var("WEAPP_CONTAINER_WEB_STATE_FAULT_CHILD").as_deref(),
            Ok("1")
        );
        // Finite even if interruption breaks; the owner policy should stop it
        // long before its two-second/fixed-iteration limit.
        let source = "App({}); exports.slow=function(){var end=Date.now()+2000;var i=0;for(;i<200000000 && Date.now()<end;i++){}return i;};exports.safe=function(){return 42;};";
        let mut manifest = owner_api_manifest();
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig {
                engine_execution: EngineExecutionPolicy {
                    turn_timeout_ms: Some(250),
                    bootstrap_timeout_ms: Some(5000),
                },
                ..Default::default()
            },
            WebSessionOptions {
                renderer_mode: WebRendererMode::BrowserView,
            },
        )
        .unwrap();
        let init = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "state-fault-init",
                op::APP_INIT,
                json!({"modules":[{"id":"module:app.js","source":source}]}),
            ))
            .unwrap();
        assert!(
            init.messages.iter().all(|m| m.payload["ok"] != false),
            "{init:?}"
        );
        let before: Value = serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        let fault = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "state-fault-call",
                op::MODULE_CALL,
                json!({"moduleId":"module:app.js","export":"slow","args":[]}),
            ))
            .unwrap();
        assert!(
            fault
                .messages
                .iter()
                .any(|m| m.payload["error"]["code"] == "ERR_TIMEOUT"),
            "{fault:?}"
        );
        let state: Value = serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        assert_eq!(state["requiresRestart"], true);
        assert_eq!(state["executionFault"]["code"], "ERR_TIMEOUT");
        assert_eq!(state["currentPage"], before["currentPage"]);
        assert_eq!(state["rendererProfile"], "webview");
        assert_eq!(state["viewRevision"], before["viewRevision"]);
        assert_eq!(state["renderRevision"], before["renderRevision"]);
        assert_eq!(
            host.runtime_state_json().unwrap(),
            serde_json::to_vec(&state).unwrap()
        );
        let rejected = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "state-fault-rejected",
                op::MODULE_CALL,
                json!({"moduleId":"module:app.js","export":"safe","args":[]}),
            ))
            .unwrap();
        assert!(
            rejected.messages.iter().any(|m| m.payload["ok"] == false),
            "{rejected:?}"
        );
        let after: Value = serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
        assert_eq!(after["executionFault"], state["executionFault"]);
        assert_eq!(after["requiresRestart"], true);
        host.unload();
        assert!(matches!(
            host.runtime_state_json(),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn external_consumed_input_export_is_revision_bound_and_never_uses_latest_state() {
        use container_bridge::op;
        use container_ir::{
            hex_digest, parse_wxml, AppInfo, CompilerInfo, ContainerManifestV1, Route, RouteKind,
            Template,
        };
        use serde_json::{json, Value};
        let bytes = parse_wxml(r#"<view id="root" data-count="{{count}}"/>"#)
            .unwrap()
            .canonical_json()
            .unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "external-input-wire-fixture".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: "route:pages/index/index".into(),
                path: "pages/index/index".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "pages/index/index.js".into(),
            }],
            templates: vec![Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: pointer.clone(),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            ..Default::default()
        };
        let mut host = WebHost::new();
        assert!(matches!(
            host.last_frame_input_json(1),
            Err(HostSessionError::NotLoaded)
        ));
        host.load_manifest_json_with_options(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
        )
        .unwrap();
        host.start_session("input-init").unwrap();
        host.dispatch_lifecycle("input-launch", "launch").unwrap();
        let dispatch = |host: &mut WebHost, operation, payload| {
            let batch = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    operation,
                    operation,
                    payload,
                ))
                .unwrap();
            assert!(
                batch
                    .messages
                    .iter()
                    .all(|message| message.payload["ok"] != false),
                "{batch:?}"
            );
        };
        dispatch(
            &mut host,
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","data":{"count":1}}),
        );
        dispatch(
            &mut host,
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml", "frameId":901,
                "viewport":{"x":12.5,"y":-7.25,"width":100.1,"height":50.2},
                "blobs":{pointer:bytes},
            }),
        );
        let revision = host.render_revision().unwrap();
        let encoded = host.last_frame_input_json(revision).unwrap();
        let proof: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(proof["version"], "1.0");
        assert_eq!(proof["sessionId"], "session-1");
        assert_eq!(proof["renderRevision"], revision.to_string());
        let input = &proof["consumedInput"];
        assert!(input["pageId"].is_string());
        assert!(input["templateRevision"].is_string());
        assert_eq!(input["routePath"], "pages/index/index");
        let exported: Value = serde_json::from_slice(&host.render_frame_json().unwrap()).unwrap();
        assert_eq!(input["viewport"], exported["viewport"]);
        assert_eq!(
            input["viewport"],
            json!({"x":12.5,"y":-7.25,"width":100.1,"height":50.2})
        );
        let page = host
            .session
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id;
        dispatch(
            &mut host,
            op::DATA_PATCH_BATCH,
            json!({"pageId":page.0,"patches":[{"path":"count","op":"set","value":2}]}),
        );
        assert_eq!(host.last_frame_input_json(revision).unwrap(), encoded);
        host.acknowledge_presentation(revision).unwrap();
        assert_eq!(host.last_frame_input_json(revision).unwrap(), encoded);
        host.set_render_scale(2.0).unwrap();
        let scaled = host.render_revision().unwrap();
        assert!(scaled > revision);
        assert!(
            matches!(host.last_frame_input_json(revision), Err(HostSessionError::BridgeBatch(error)) if error.code == container_bridge::BridgeErrorCode::Cancelled)
        );
        let scaled_proof: Value =
            serde_json::from_slice(&host.last_frame_input_json(scaled).unwrap()).unwrap();
        assert_eq!(scaled_proof["consumedInput"], *input);
        let manual: Value = serde_json::from_slice(&host.render_frame_json().unwrap()).unwrap();
        dispatch(&mut host, op::RENDER_COMMIT, json!({"frame":manual}));
        let manual_revision = host.render_revision().unwrap();
        let manual_proof: Value =
            serde_json::from_slice(&host.last_frame_input_json(manual_revision).unwrap()).unwrap();
        assert!(manual_proof["consumedInput"].is_null());
        assert_eq!(manual_proof["renderRevision"], manual_revision.to_string());
        host.unload();
        assert!(matches!(
            host.last_frame_input_json(manual_revision),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn external_renderer_exports_frame_and_keeps_software_diagnostics_separate() {
        use container_bridge::op;
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1};
        use serde_json::json;

        let manifest = serde_json::to_vec(&ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "web-external-frame-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        })
        .unwrap();
        let mut host = WebHost::new();
        host.load_manifest_json_with_options(
            &manifest,
            SessionConfig::default(),
            WebSessionOptions {
                renderer_mode: WebRendererMode::ExternalFrame,
            },
        )
        .unwrap();
        assert_eq!(host.info().backend, WebBackend::ExternalFrameExport);
        assert_eq!(host.info().capabilities.renderer, "external-frame-export");
        assert!(!host.info().capabilities.gpu_surface);
        host.start_session("external-init").unwrap();
        let render_request = BridgeEnvelope::request(
            "session-1",
            "external-render",
            op::RENDER_COMMIT,
            json!({"frame": {
                "frameId": 4,
                "viewport": {"x":0,"y":0,"width":1,"height":1},
                "root": {"id":"page","bounds":{"x":0,"y":0,"width":1,"height":1},
                    "background":{"red":12,"green":34,"blue":56,"alpha":255},
                    "opacity":1,"children":[]}
            }}),
        );
        let render = host.dispatch(render_request.clone()).unwrap();
        assert_eq!(
            render.messages[0].payload["backend"],
            "external-frame-export"
        );
        let exported: serde_json::Value =
            serde_json::from_slice(&host.render_frame_json().unwrap()).unwrap();
        assert_eq!(exported["frame_id"], 4);
        assert_eq!(host.render_snapshot_rgba().unwrap(), [12, 34, 56, 255]);
        assert!(!host.has_gpu_surface().unwrap());
        assert_eq!(host.info().capabilities.renderer, "external-frame-export");

        let revision = host.render_revision().unwrap();
        assert_eq!(revision, 1);
        assert!(host.acknowledge_presentation(4).is_err());
        host.acknowledge_presentation(revision).unwrap();
        assert!(host
            .acknowledge_presentation(revision)
            .unwrap()
            .messages
            .is_empty());

        // An application may reuse frameId while density/scrolling changes the
        // accepted presentation. Only the renderer-owned token can ACK it.
        host.dispatch(render_request).unwrap();
        let next_revision = host.render_revision().unwrap();
        assert!(next_revision > revision);
        assert!(host.acknowledge_presentation(revision).is_err());
        host.acknowledge_presentation(next_revision).unwrap();

        // A bad reload must retain both the old session and presentation mode.
        assert!(host
            .load_manifest_json(b"{}", SessionConfig::default())
            .is_err());
        assert_eq!(host.info().capabilities.renderer, "external-frame-export");
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&host.render_frame_json().unwrap())
                .unwrap()["frame_id"],
            4
        );

        host.load_manifest_json(&manifest, SessionConfig::default())
            .unwrap();
        assert_eq!(host.info(), HostInfo::current());
        host.unload();
        assert_eq!(host.info(), HostInfo::current());
    }

    #[test]
    fn exposes_web_capability_metadata() {
        let info = HostInfo::current();
        assert_eq!(info.platform, "web");
        assert!(info.capabilities.web);
        assert!(!info.capabilities.native_surface);
        assert_eq!(info.backend, WebBackend::Stub);
        assert_eq!(info.capabilities.renderer, "software-fallback");
        assert!(!info.capabilities.browser_view);
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
    fn loads_manifest_and_dispatches_bridge_batch() {
        use container_bridge::op;
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use serde_json::json;

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "web-host-test".into(),
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
        let mut host = WebHost::new();
        assert!(matches!(
            host.render_frame_json(),
            Err(HostSessionError::NotLoaded)
        ));
        host.load_manifest_json(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
        )
        .unwrap();
        assert!(matches!(
            host.render_frame_json(),
            Err(HostSessionError::NoRenderFrame)
        ));
        let response = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "r1",
                op::APP_INIT,
                json!({}),
            ))
            .unwrap();
        assert_eq!(response.messages.len(), 2);
        assert!(host.session_initialized());
        assert_eq!(
            host.session.session().unwrap().provider_name(),
            "browser-native"
        );
        for name in [
            "wx.login",
            "wx.checkSession",
            "wx.requestPayment",
            "wx.getLocation",
        ] {
            let denied = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    format!("missing-{name}"),
                    op::API_CALL,
                    json!({"name":name}),
                ))
                .unwrap();
            assert_eq!(
                denied.messages[0].payload["ok"], false,
                "unconfigured browser API fabricated success: {name}"
            );
            assert_eq!(
                denied.messages[0].payload["error"]["code"],
                "ERR_UNSUPPORTED_CAPABILITY"
            );
        }
        assert_eq!(response.messages[0].payload["host"]["kind"], "web");
        assert_eq!(
            response.messages[0].payload["engineProviderAvailable"],
            engine_provider_compiled(EngineKind::Quickjs)
        );
        let render = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "render-1",
                op::RENDER_COMMIT,
                json!({
                    "frame": {
                        "frameId": 3,
                        "viewport": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                        "root": {
                            "id": "root",
                            "bounds": {"x": 0.0, "y": 0.0, "width": 1.0, "height": 1.0},
                            "background": {"red": 12, "green": 34, "blue": 56, "alpha": 255},
                            "opacity": 1.0,
                            "children": []
                        }
                    }
                }),
            ))
            .unwrap();
        assert_eq!(render.messages[0].payload["frameId"], 3);
        let snapshot: serde_json::Value =
            serde_json::from_slice(&host.render_snapshot_json().unwrap()).unwrap();
        assert_eq!(snapshot["frame_id"], 3);
        assert_eq!(snapshot["width"], 1);
        assert_eq!(snapshot["pixels"], serde_json::json!([12, 34, 56, 255]));
        assert_eq!(host.render_snapshot_rgba().unwrap(), vec![12, 34, 56, 255]);
        let frame: serde_json::Value =
            serde_json::from_slice(&host.render_frame_json().unwrap()).unwrap();
        assert_eq!(frame["frame_id"], 3);
        assert_eq!(frame["root"]["background"]["green"], 34);
        assert_eq!(frame["root"]["children"], serde_json::json!([]));
        assert_eq!(host.render_snapshot_rgba().unwrap(), vec![12, 34, 56, 255]);
        host.unload();
        assert!(matches!(
            host.render_frame_json(),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn v8_session_matches_shared_runtime_provider_availability() {
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use container_runtime::SessionError;

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "web-v8-provider".into(),
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
        let config = SessionConfig {
            engine: EngineKind::V8,
            ..SessionConfig::default()
        };
        let mut host = WebHost::new();
        // The runtime's feature set can be unified through the simulator or
        // another host even when this crate's forwarding feature is absent.
        // Assert the provider that was actually compiled, including the
        // genuine provider-free build, without accepting a fallback.
        let result = host.load_manifest_json(serde_json::to_vec(&manifest).unwrap(), config);
        if engine_provider_compiled(EngineKind::V8) {
            result.expect("a compiled V8 provider must construct a native session");
            let init = host
                .start_session("v8-init")
                .expect("app.init must succeed");
            assert_eq!(init.messages[0].payload["engine"], "v8");
            assert_eq!(init.messages[0].payload["engineProviderAvailable"], true);
            assert!(host.session_initialized());
        } else {
            let error = result.expect_err("V8 must fail when the shared runtime has no provider");
            assert!(matches!(
                error,
                HostSessionError::Session(SessionError::EngineUnavailable {
                    engine: EngineKind::V8
                })
            ));
            assert!(error.to_string().contains("ERR_ENGINE"));
            assert!(!host.has_session());
            assert!(!host.is_initialized());
        }
    }
}

#[cfg(test)]
mod external_presentation_contract_tests {
    use super::*;
    use serde_json::{json, Value};

    #[test]
    fn surface_recovery_handshake_is_independent_and_pure() {
        let host = WebHost::new();
        let contract: Value = serde_json::from_str(host.surface_recovery_contract_json()).unwrap();
        assert_eq!(
            contract,
            json!({"version":"1.0","retainedExternalFrame":"1.0"})
        );
        assert!(!host.has_session());
    }

    #[test]
    fn handshake_is_pure_and_does_not_require_a_loaded_session() {
        let mut host = WebHost::new();
        let contract: Value =
            serde_json::from_str(host.external_presentation_contract_json()).unwrap();
        assert_eq!(
            contract,
            json!({"version":"1.0","consumedInput":"1.0","ackOutcome":"1.0","physicalTarget":"1.0"})
        );
        assert!(!host.has_session());
        assert!(!host.is_initialized());
        assert!(host.acknowledge_presentation_outcome_json(1).is_err());
        assert!(host.render_target_json(1).is_err());
        assert!(!host.has_session());
    }

    #[test]
    fn observation_handshake_is_pure_and_legacy_state_shape_is_separate() {
        let host = WebHost::new();
        let contract: Value = serde_json::from_str(host.observation_contract_json()).unwrap();
        assert_eq!(contract, json!({"version":"1.0","inputLifetime":"1.0"}));
        assert!(!host.has_session());
        assert!(host.observation_state_json().is_err());
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    mod native {
        use super::*;
        use container_bridge::op;
        use container_ir::*;

        const HOME: &str = "pages/home/index";
        const SECOND: &str = "pages/second/index";
        const TEMPLATE: &str = "template:pages/home/index.wxml";

        fn engines() -> Vec<EngineKind> {
            vec![
                #[cfg(feature = "quickjs-native")]
                EngineKind::Quickjs,
                #[cfg(feature = "v8-native")]
                EngineKind::V8,
            ]
        }

        fn dispatch(host: &mut WebHost, operation: &str, payload: Value) -> BridgeBatch {
            let batch = host
                .dispatch(BridgeEnvelope::request(
                    "session-1",
                    operation,
                    operation,
                    payload,
                ))
                .unwrap();
            assert!(
                batch
                    .messages
                    .iter()
                    .all(|message| message.payload["ok"] != false && message.op != op::ERROR),
                "{batch:?}"
            );
            batch
        }

        fn fixture(engine: EngineKind, ready_body: &str) -> (WebHost, Value) {
            fixture_with_policy(engine, ready_body, Default::default())
        }

        fn fixture_with_policy(
            engine: EngineKind,
            ready_body: &str,
            execution: container_runtime::EngineExecutionPolicy,
        ) -> (WebHost, Value) {
            fixture_with_renderer(
                engine,
                ready_body,
                execution,
                WebRendererMode::ExternalFrame,
            )
        }

        fn fixture_with_renderer(
            engine: EngineKind,
            ready_body: &str,
            execution: container_runtime::EngineExecutionPolicy,
            renderer_mode: WebRendererMode,
        ) -> (WebHost, Value) {
            let page = format!("Page({{data:{{count:1}},onReady(){{{ready_body}}}}});");
            let sources = [
                (
                    "module:app.js",
                    "App({ready:0});exports.inspect=()=>({ready:getApp().ready});".to_owned(),
                    ModuleScope::App,
                ),
                ("module:pages/home/index.js", page, ModuleScope::Page),
                (
                    "module:pages/second/index.js",
                    "Page({data:{count:9}});".to_owned(),
                    ModuleScope::Page,
                ),
            ];
            let mut manifest = ContainerManifestV1 {
                compiler: CompilerInfo {
                    name: "weapp-vite".into(),
                    commit: "external-ack-real-engine".into(),
                    platform: "weapp".into(),
                },
                app: AppInfo {
                    app_json: "app.json".into(),
                    entry_module: "module:app.js".into(),
                },
                capabilities: std::collections::BTreeMap::from([
                    ("wx.navigateTo".into(), CapabilitySupport::Full),
                    ("wx.setStorageSync".into(), CapabilitySupport::Full),
                ]),
                routes: [HOME, SECOND]
                    .into_iter()
                    .map(|path| Route {
                        id: format!("route:{path}"),
                        path: path.into(),
                        kind: RouteKind::Page,
                        config: None,
                        entry_module: format!("module:{path}.js"),
                    })
                    .collect(),
                ..Default::default()
            };
            let mut modules = Vec::new();
            for (id, source, scope) in sources {
                manifest.modules.push(Module {
                    id: id.into(),
                    sha256: hex_digest(source.as_bytes()),
                    format: ModuleFormat::Commonjs,
                    scope,
                    dependencies: vec![],
                });
                modules.push(json!({"id":id,"source":source}));
            }
            let bytes =
                parse_wxml(r#"<view id="root" data-count="{{count}}" style="height:1000px"/>"#)
                    .unwrap()
                    .canonical_json()
                    .unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: TEMPLATE.into(),
                wxml_ast: pointer.clone(),
                bindings: vec![],
                wxs_modules: Default::default(),
            });
            manifest.refresh_integrity().unwrap();
            let mut config = SessionConfig {
                engine,
                engine_execution: execution,
                ..Default::default()
            };
            config.host.window_width = 100;
            config.host.window_height = 50;
            let mut host = WebHost::new();
            host.load_manifest_json_with_options(
                serde_json::to_vec(&manifest).unwrap(),
                config,
                WebSessionOptions { renderer_mode },
            )
            .unwrap();
            let blobs = json!({pointer:bytes});
            dispatch(
                &mut host,
                op::APP_INIT,
                json!({"modules":modules,"blobs":blobs.clone()}),
            );
            dispatch(&mut host, op::APP_LIFECYCLE, json!({"event":"launch"}));
            dispatch(&mut host, op::PAGE_PUSH, json!({"path":HOME}));
            (
                host,
                json!({"templateId":TEMPLATE,"viewport":{"x":0,"y":0,"width":100,"height":50},"blobs":blobs}),
            )
        }

        fn render(host: &mut WebHost, payload: &Value) -> u64 {
            dispatch(host, op::RENDER_COMMIT, payload.clone());
            host.render_revision().unwrap()
        }
        fn ack(host: &mut WebHost, revision: u64) -> Value {
            serde_json::from_slice(
                &host
                    .acknowledge_presentation_outcome_json(revision)
                    .unwrap(),
            )
            .unwrap()
        }
        fn ready_count(host: &mut WebHost) -> Value {
            dispatch(
                host,
                op::MODULE_CALL,
                json!({"moduleId":"module:app.js","export":"inspect"}),
            )
            .messages[0]
                .payload["result"][0]["ready"]
                .clone()
        }

        fn recovery_expected(host: &WebHost) -> Value {
            let state: Value = serde_json::from_slice(&host.runtime_state_json().unwrap()).unwrap();
            let observation: Value =
                serde_json::from_slice(&host.observation_state_json().unwrap()).unwrap();
            json!({"sessionId":state["sessionId"],"pageId":state["currentPage"]["pageId"],
                "routePath":state["currentPage"]["path"],"rendererProfile":state["rendererProfile"],
                "templateRevision":state["templateRevision"],"renderRevision":state["renderRevision"],
                "inputLifetimeRevision":observation["inputLifetimeRevision"],
                "viewport":{"x":0,"y":0,"width":state["viewport"]["width"],"height":state["viewport"]["height"]}})
        }

        fn recover(host: &mut WebHost, expected: &Value) -> Value {
            serde_json::from_slice(
                &host
                    .recover_external_frame_json(&serde_json::to_vec(expected).unwrap())
                    .unwrap(),
            )
            .unwrap()
        }

        #[test]
        fn retained_recovery_preserves_real_engine_state_and_needs_a_new_ack() {
            for engine in engines() {
                let (mut host, payload) = fixture(
                    engine,
                    "getApp().ready++;wx.setStorageSync('recovery-keep',9);",
                );
                let first = render(&mut host, &payload);
                let expected = recovery_expected(&host);
                let frame = host.render_frame_json().unwrap();
                let binary = host.render_frame_binary().unwrap();
                assert_eq!(&binary[..4], b"WCF1");
                let metadata_len = u32::from_le_bytes(binary[4..8].try_into().unwrap()) as usize;
                assert_eq!(&binary[8..8 + metadata_len], &frame);
                assert_eq!(binary.len(), 8 + metadata_len);
                let proof: Value =
                    serde_json::from_slice(&host.last_frame_input_json(first).unwrap()).unwrap();
                let view = host.view_revision().unwrap();
                // snapshot() explicitly rasterizes external frames on demand.
                // Inspect the cache without creating diagnostic pixels.
                assert!(host
                    .session
                    .session()
                    .unwrap()
                    .renderer()
                    .snapshot_ref()
                    .is_none());
                let result = recover(&mut host, &expected);
                assert_eq!(result["kind"], "retained");
                assert_eq!(host.render_revision().unwrap(), first + 1);
                assert_eq!(host.render_frame_json().unwrap(), frame);
                assert_eq!(host.view_revision().unwrap(), view);
                assert!(!host.session.session().unwrap().is_current_frame_presented());
                assert!(host
                    .session
                    .session()
                    .unwrap()
                    .renderer()
                    .snapshot_ref()
                    .is_none());
                assert!(host.acknowledge_presentation(first).is_err());
                let current = host.render_revision().unwrap();
                let new_proof: Value =
                    serde_json::from_slice(&host.last_frame_input_json(current).unwrap()).unwrap();
                assert_eq!(new_proof["consumedInput"], proof["consumedInput"]);
                assert_eq!(ack(&mut host, current)["inputEnabled"], true);
                assert_eq!(ready_count(&mut host), 1);
                let expected = recovery_expected(&host);
                assert_eq!(recover(&mut host, &expected)["kind"], "retained");
                let current = host.render_revision().unwrap();
                assert_eq!(ack(&mut host, current)["inputEnabled"], true);
                assert_eq!(
                    ready_count(&mut host),
                    1,
                    "recovery cannot repeat the ready callback"
                );
                assert_eq!(
                    host.session
                        .session()
                        .unwrap()
                        .app_service()
                        .storage()
                        .get("recovery-keep"),
                    Some(&json!(9))
                );
            }
        }

        #[test]
        fn dirty_recovery_revokes_old_native_ack_until_normal_render() {
            for engine in engines() {
                let (mut host, payload) = fixture(engine, "getApp().ready++;");
                let first = render(&mut host, &payload);
                let page = host
                    .session
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .id;
                dispatch(
                    &mut host,
                    op::DATA_PATCH_BATCH,
                    json!({"pageId":page.0,"patches":[{"path":"count","op":"set","value":2}]}),
                );
                let expected = recovery_expected(&host);
                let result = recover(&mut host, &expected);
                assert_eq!(result["kind"], "render-required");
                assert_eq!(host.render_revision().unwrap(), first);
                assert!(host
                    .session
                    .session()
                    .unwrap()
                    .last_frame_input(first)
                    .is_none());
                assert!(host.acknowledge_presentation(first).is_err());
                let next = render(&mut host, &payload);
                assert!(next > first);
                assert_eq!(ack(&mut host, next)["inputEnabled"], true);
            }
        }

        #[test]
        fn recovery_stale_expected_inputs_are_atomic_at_the_native_boundary() {
            for engine in engines() {
                let (mut host, payload) = fixture(engine, "getApp().ready++;");
                let first = render(&mut host, &payload);
                let expected = recovery_expected(&host);
                let proof = host.last_frame_input_json(first).unwrap();
                let state = host.observation_state_json().unwrap();
                for (key, value) in [
                    ("sessionId", json!("other-session")),
                    ("pageId", json!("99")),
                    ("routePath", json!(SECOND)),
                    ("rendererProfile", json!("skyline-compat")),
                    ("templateRevision", json!("99")),
                    ("renderRevision", json!("99")),
                    ("inputLifetimeRevision", json!("99")),
                    ("viewport", json!({"x":0,"y":0,"width":101,"height":50})),
                ] {
                    let mut stale = expected.clone();
                    stale[key] = value;
                    assert!(
                        matches!(host.recover_external_frame_json(&serde_json::to_vec(&stale).unwrap()),
                        Err(HostSessionError::BridgeBatch(error)) if error.code == container_bridge::BridgeErrorCode::Cancelled),
                        "{key}"
                    );
                    assert_eq!(host.observation_state_json().unwrap(), state);
                    assert_eq!(host.last_frame_input_json(first).unwrap(), proof);
                }
            }
        }

        #[test]
        fn physical_target_is_revision_bound_and_scale_preserves_clone_input() {
            for engine in engines() {
                let (mut host, payload) = fixture(engine, "getApp().ready++;");
                let revision = render(&mut host, &payload);
                let target: Value =
                    serde_json::from_slice(&host.render_target_json(revision).unwrap()).unwrap();
                assert_eq!(target["width"], 100);
                assert_eq!(target["height"], 50);
                assert_eq!(target["renderRevision"], revision.to_string());
                let viewport = host
                    .session
                    .accepted_page_observation()
                    .unwrap()
                    .unwrap()
                    .frame
                    .viewport;
                host.session
                    .session_mut()
                    .unwrap()
                    .renderer_mut()
                    .configure_render_target(viewport, 3.0)
                    .unwrap();
                assert_eq!(host.render_revision().unwrap(), revision);
                assert_eq!(
                    serde_json::from_slice::<Value>(&host.render_target_json(revision).unwrap())
                        .unwrap(),
                    target
                );
                assert!(matches!(host.render_target_json(0),
                    Err(HostSessionError::BridgeBatch(error)) if error.code == container_bridge::BridgeErrorCode::Cancelled));
                let proof: Value =
                    serde_json::from_slice(&host.last_frame_input_json(revision).unwrap()).unwrap();
                host.set_render_scale(1.5).unwrap();
                let scaled = host.render_revision().unwrap();
                assert_ne!(scaled, revision);
                assert!(host.render_target_json(revision).is_err());
                let actual: Value =
                    serde_json::from_slice(&host.render_target_json(scaled).unwrap()).unwrap();
                assert_eq!(actual["width"], 150);
                assert_eq!(actual["height"], 75);
                assert_eq!(actual["renderRevision"], scaled.to_string());
                let retained: Value =
                    serde_json::from_slice(&host.last_frame_input_json(scaled).unwrap()).unwrap();
                assert_eq!(proof["consumedInput"], retained["consumedInput"]);
                assert_eq!(ready_count(&mut host), 0);
                assert!(host.set_render_scale(500.0).is_err());
                assert_eq!(host.render_revision().unwrap(), scaled);
                assert_eq!(
                    serde_json::from_slice::<Value>(&host.render_target_json(scaled).unwrap())
                        .unwrap(),
                    actual
                );
            }
        }

        #[test]
        fn ready_set_data_keeps_old_consumed_input_and_genuine_input_authority() {
            for engine in engines() {
                let (mut host, payload) =
                    fixture(engine, "getApp().ready++;this.setData({count:2});");
                let revision = render(&mut host, &payload);
                let before = host.last_frame_input_json(revision).unwrap();
                let proof: Value = serde_json::from_slice(&before).unwrap();
                let final_outcome = ack(&mut host, revision);
                assert_eq!(final_outcome["acknowledged"], true);
                assert_eq!(final_outcome["inputEnabled"], true);
                assert_eq!(final_outcome["requiresRestart"], false);
                assert!(final_outcome.get("consumedInput").is_none());
                assert!(final_outcome.get("scheduling").is_none());
                assert_eq!(final_outcome["renderRevision"], revision.to_string());
                let consumed = proof["consumedInput"]["templateRevision"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                let latest = final_outcome["observedState"]["templateRevision"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap();
                assert!(
                    latest > consumed,
                    "ready setData must remain a new scheduling demand"
                );
                assert_eq!(host.last_frame_input_json(revision).unwrap(), before);
                assert_eq!(ready_count(&mut host), 1);
                let duplicate = ack(&mut host, revision);
                assert_eq!(duplicate["inputEnabled"], true);
                assert_eq!(duplicate["batch"]["messages"], json!([]));
                assert_eq!(ready_count(&mut host), 1);

                let (mut legacy, legacy_payload) =
                    fixture(engine, "getApp().ready++;this.setData({count:2});");
                let legacy_revision = render(&mut legacy, &legacy_payload);
                let legacy_batch = legacy.acknowledge_presentation(legacy_revision).unwrap();
                assert_eq!(
                    final_outcome["batch"],
                    serde_json::to_value(legacy_batch).unwrap()
                );
            }
        }

        #[test]
        fn ordinary_ready_error_is_sticky_for_duplicates_without_replaying_effects() {
            for engine in engines() {
                let body = "getApp().ready++;this.setData({count:2});if(getApp().ready===1)throw new Error('ready-contract-fixture');";
                let (mut host, payload) = fixture(engine, body);
                let revision = render(&mut host, &payload);
                let final_outcome = ack(&mut host, revision);
                assert_eq!(final_outcome["acknowledged"], true);
                assert_eq!(final_outcome["inputEnabled"], false);
                assert_eq!(final_outcome["requiresRestart"], false);
                assert!(final_outcome["batch"]["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| message["op"] == op::ERROR));
                let duplicate = ack(&mut host, revision);
                assert_eq!(duplicate["inputEnabled"], false);
                assert_eq!(duplicate["batch"]["messages"], json!([]));
                assert_eq!(ready_count(&mut host), 1);
                // A real new publication is required to reconsider blocking.
                let next = render(&mut host, &payload);
                assert!(next > revision);
                assert_eq!(ack(&mut host, next)["inputEnabled"], true);

                // Mixing legacy/new entry points cannot erase a blocked token.
                let (mut legacy, payload) = fixture(engine, body);
                let revision = render(&mut legacy, &payload);
                let batch = legacy.acknowledge_presentation(revision).unwrap();
                assert!(batch.messages.iter().any(|message| message.op == op::ERROR));
                let final_outcome = ack(&mut legacy, revision);
                assert_eq!(final_outcome["inputEnabled"], false);
                assert_eq!(final_outcome["batch"]["messages"], json!([]));
            }
        }

        #[test]
        fn ready_navigation_preserves_effects_and_observes_the_new_page_without_input() {
            for engine in engines() {
                let (mut host, payload) = fixture(
                    engine,
                    "getApp().ready++;wx.navigateTo({url:'/pages/second/index'});",
                );
                let revision = render(&mut host, &payload);
                let final_outcome = ack(&mut host, revision);
                assert_eq!(final_outcome["acknowledged"], true);
                assert_eq!(final_outcome["inputEnabled"], false);
                assert_eq!(
                    final_outcome["observedState"]["currentPage"]["path"],
                    SECOND
                );
                assert!(!final_outcome["batch"]["messages"]
                    .as_array()
                    .unwrap()
                    .is_empty());
                let proof: Value =
                    serde_json::from_slice(&host.last_frame_input_json(revision).unwrap()).unwrap();
                assert!(proof["consumedInput"].is_null());
            }
        }

        #[test]
        fn hide_resize_retire_and_page_return_cannot_revive_acknowledged_old_pixels() {
            for engine in engines() {
                for boundary in ["hide-show", "resize", "retire", "page-return"] {
                    let (mut host, mut payload) = fixture(engine, "getApp().ready++;");
                    let revision = render(&mut host, &payload);
                    assert_eq!(ack(&mut host, revision)["inputEnabled"], true);
                    match boundary {
                        "hide-show" => {
                            dispatch(&mut host, op::APP_LIFECYCLE, json!({"event":"hide"}));
                            dispatch(&mut host, op::APP_LIFECYCLE, json!({"event":"show"}));
                        }
                        "resize" => {
                            host.notify_window_metrics_json(
                                serde_json::to_vec(&json!({
                                    "windowWidth":120,"windowHeight":60,"pixelRatio":1,
                                    "screenWidth":120,"screenHeight":60,"statusBarHeight":0,
                                    "screenTop":0,"deviceOrientation":"landscape"
                                }))
                                .unwrap(),
                            )
                            .unwrap();
                            payload["viewport"]["width"] = json!(120);
                            payload["viewport"]["height"] = json!(60);
                        }
                        "retire" => {
                            host.retire_browser_preview("contract-retired").unwrap();
                        }
                        "page-return" => {
                            dispatch(&mut host, op::PAGE_PUSH, json!({"path":SECOND}));
                            dispatch(&mut host, op::PAGE_POP, json!({}));
                        }
                        _ => unreachable!(),
                    }
                    // A hard boundary can retire layout authority as well as
                    // input. Legacy duplicate receipts may only return a
                    // disabled outcome or the explicit stale-owner error.
                    match host.acknowledge_presentation_outcome_json(revision) {
                        Ok(bytes) => {
                            let duplicate: Value = serde_json::from_slice(&bytes).unwrap();
                            assert_eq!(duplicate["acknowledged"], true, "{boundary}");
                            assert_eq!(duplicate["inputEnabled"], false, "{boundary}");
                        }
                        Err(HostSessionError::BridgeBatch(error)) => {
                            assert_eq!(
                                error.code,
                                container_bridge::BridgeErrorCode::Cancelled,
                                "{boundary}: {error:?}"
                            );
                            assert!(
                                !host.session.session().unwrap().is_current_frame_presented(),
                                "{boundary}"
                            );
                        }
                        Err(error) => panic!("{boundary}: {error:?}"),
                    }
                    let next = render(&mut host, &payload);
                    assert!(host
                        .acknowledge_presentation_outcome_json(revision)
                        .is_err());
                    assert_eq!(ack(&mut host, next)["inputEnabled"], true, "{boundary}");
                }
            }
        }

        #[test]
        fn manual_frame_ack_keeps_legacy_batch_but_cannot_claim_generated_input() {
            for engine in engines() {
                let (mut host, payload) = fixture(engine, "getApp().ready++;");
                let revision = render(&mut host, &payload);
                assert_eq!(ack(&mut host, revision)["inputEnabled"], true);
                let frame: Value =
                    serde_json::from_slice(&host.render_frame_json().unwrap()).unwrap();
                dispatch(&mut host, op::RENDER_COMMIT, json!({"frame":frame}));
                let revision = host.render_revision().unwrap();
                assert!(host
                    .acknowledge_presentation(revision)
                    .unwrap()
                    .messages
                    .is_empty());
                assert_eq!(ack(&mut host, revision)["inputEnabled"], false);
            }
        }

        #[cfg(feature = "quickjs-native")]
        #[test]
        fn bounded_ready_fault_preserves_committed_effects_and_requires_restart() {
            let (mut host, payload) = fixture_with_policy(
                EngineKind::Quickjs,
                "getApp().ready++;this.setData({count:2});while(true){}",
                container_runtime::EngineExecutionPolicy {
                    bootstrap_timeout_ms: Some(1000),
                    turn_timeout_ms: Some(25),
                },
            );
            let revision = render(&mut host, &payload);
            let final_outcome = ack(&mut host, revision);
            assert_eq!(final_outcome["acknowledged"], true);
            assert_eq!(final_outcome["inputEnabled"], false);
            assert_eq!(final_outcome["requiresRestart"], true);
            assert!(final_outcome["observedState"]["executionFault"].is_object());
            assert!(final_outcome["batch"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| message["payload"]["requiresRestart"] == true));
        }

        fn observation(host: &WebHost) -> Value {
            serde_json::from_slice(&host.observation_state_json().unwrap()).unwrap()
        }
        fn lifetime(host: &WebHost) -> u64 {
            observation(host)["inputLifetimeRevision"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap()
        }

        #[test]
        fn same_native_batch_hide_show_and_push_pop_keep_hard_retirement_evidence() {
            for engine in engines() {
                let (mut host, _) = fixture(engine, "");
                let initial = observation(&host);
                let before = lifetime(&host);
                let messages = vec![
                    BridgeEnvelope::request(
                        "session-1",
                        "hide-once",
                        op::APP_LIFECYCLE,
                        json!({"event":"hide"}),
                    ),
                    BridgeEnvelope::request(
                        "session-1",
                        "show-once",
                        op::APP_LIFECYCLE,
                        json!({"event":"show"}),
                    ),
                ];
                let batch: BridgeBatch = serde_json::from_slice(
                    &host
                        .dispatch_batch_json(
                            serde_json::to_vec(&json!({"messages":messages})).unwrap(),
                        )
                        .unwrap(),
                )
                .unwrap();
                assert!(!batch.messages.iter().any(|message| message.op == op::ERROR));
                assert!(lifetime(&host) > before);
                assert_eq!(
                    observation(&host)["state"]["currentPage"],
                    initial["state"]["currentPage"]
                );
                assert_eq!(observation(&host)["state"]["lifecycle"], "Active");
                let before = lifetime(&host);
                let messages = vec![
                    BridgeEnvelope::request(
                        "session-1",
                        "push-once",
                        op::PAGE_PUSH,
                        json!({"path":SECOND}),
                    ),
                    BridgeEnvelope::request("session-1", "pop-once", op::PAGE_POP, json!({})),
                ];
                let _: BridgeBatch = serde_json::from_slice(
                    &host
                        .dispatch_batch_json(
                            serde_json::to_vec(&json!({"messages":messages})).unwrap(),
                        )
                        .unwrap(),
                )
                .unwrap();
                assert!(lifetime(&host) > before);
                assert_eq!(
                    observation(&host)["state"]["currentPage"],
                    initial["state"]["currentPage"]
                );
            }
        }

        #[test]
        fn repeated_real_dom_prepare_does_not_advance_hard_input_lifetime() {
            for engine in engines() {
                let (mut host, payload) = fixture_with_renderer(
                    engine,
                    "",
                    Default::default(),
                    WebRendererMode::BrowserView,
                );
                let before = lifetime(&host);
                let mut previous = 0;
                for _ in 0..6 {
                    let batch = dispatch(
                        &mut host,
                        op::VIEW_PREPARE,
                        json!({"version":"1.0","surfaceGeneration":"1","render":payload}),
                    );
                    let revision = batch.messages[0].payload["submission"]["key"]
                        ["presentationRevision"]
                        .as_str()
                        .unwrap()
                        .parse::<u64>()
                        .unwrap();
                    assert!(revision > previous);
                    previous = revision;
                    assert_eq!(lifetime(&host), before);
                }
            }
        }

        #[test]
        fn render_ready_set_data_scale_and_diagnostic_capture_do_not_retire_logical_lifetime() {
            for engine in engines() {
                let (mut host, payload) =
                    fixture(engine, "getApp().ready++;this.setData({count:2});");
                let before = lifetime(&host);
                let revision = render(&mut host, &payload);
                let _ = ack(&mut host, revision);
                assert_eq!(lifetime(&host), before);
                host.set_render_scale(2.0).unwrap();
                assert_eq!(lifetime(&host), before);
                let _ = host
                    .session
                    .session_mut()
                    .unwrap()
                    .capture_render_snapshot();
                assert_eq!(lifetime(&host), before);
                let _ = render(&mut host, &payload);
                assert_eq!(lifetime(&host), before);
            }
        }

        #[test]
        fn failed_real_resize_retains_committed_viewport_and_lifetime_once() {
            for engine in engines() {
                let (mut host, payload) = fixture(engine,
                    "getApp().ready++;this.onResize=function(){getApp().ready++;throw new Error('resize-after-commit-once');};");
                let revision = render(&mut host, &payload);
                let _ = ack(&mut host, revision);
                assert_eq!(ready_count(&mut host), 1);
                let before = lifetime(&host);
                let metrics = json!({"windowWidth":120,"windowHeight":60,"pixelRatio":2.0,
                    "screenWidth":120,"screenHeight":60,"statusBarHeight":0.0,"screenTop":0.0,
                    "deviceOrientation":"landscape"});
                let result = host.notify_window_metrics_json(serde_json::to_vec(&metrics).unwrap());
                match result {
                    Err(error) => assert!(error.to_string().contains("resize-after-commit-once")),
                    Ok(bytes) => {
                        let batch: BridgeBatch = serde_json::from_slice(&bytes).unwrap();
                        assert!(batch.messages.iter().any(|message| message.op == op::ERROR));
                    }
                }
                let after = observation(&host);
                assert!(lifetime(&host) > before);
                assert_eq!(after["state"]["viewport"], json!({"width":120,"height":60}));
                assert_eq!(
                    ready_count(&mut host),
                    2,
                    "original failing callback must not replay during pure state refresh"
                );
            }
        }
    }
}
