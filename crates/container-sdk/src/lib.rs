//! Native SDK ownership boundary. UI adapters own surfaces; this crate owns
//! verified pack startup, navigation, JS, persistence and asynchronous work.
mod chrome;
mod dev_attempt;
mod host_layout;
mod http;
pub use chrome::{ContentRect, HostChromeGeometry};
pub use dev_attempt::{
    AcceptedPackIdentity, DevPackAttemptMissing, DevPackAttemptMissingStatus, DevPackAttemptQuery,
    DevPackAttemptReceipt,
};
pub use host_layout::{HostLayout, HostLayoutConfig, HostLayoutObservation, HostSurfaceIdentity};
mod account;
mod managed_files;
mod pack;
mod render_diagnostics;
#[cfg(all(test, feature = "restricted-showcase", feature = "quickjs-native"))]
mod restricted_showcase_tests;
mod retirement;
mod storage;
#[cfg(feature = "testing")]
pub mod testing;
pub use account::{
    storage_namespace, AccountSwitchPhase, AccountSwitchReceipt, HostAccountManager,
};
pub use container_runtime::{
    HostAccount, HostApiCallContext, HostApiEvent, HostApiFailure, HostComponentEvent,
    HostServicesConfig, TrustedApplication,
};

use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
pub use container_core::EngineKind;
use container_ir::CapabilitySupport;
use container_render_skia::{Rect, RenderFrame, RenderSnapshot, Renderer, SkiaRenderer};
pub use container_runtime::dev_reload::DevReloadKind;
use container_runtime::{
    engine_provider_compiled, HostApiProvider, HostRequest, HostWindowMetrics, ProviderContext,
    ProviderError, ProviderErrorCode, ProviderStart, Session, SessionConfig,
};
pub use container_runtime::{HostKind, HostMetadata};
pub use pack::PackSource;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    marker::PhantomData,
    path::PathBuf,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread::{self, ThreadId},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_EVENTS: usize = 512;
const MAX_HTTP_REQUESTS: usize = 64;
const MAX_RETIRED_HTTP_OWNERS: usize = 8;
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[error("{code}: {message}")]
pub struct SdkError {
    pub code: String,
    pub message: String,
}
impl SdkError {
    pub fn new(code: impl Into<String>, message: impl std::fmt::Display) -> Self {
        Self {
            code: code.into(),
            message: message.to_string(),
        }
    }
    pub fn code(&self) -> &str {
        &self.code
    }
    fn invalid(message: impl std::fmt::Display) -> Self {
        Self::new("ERR_INVALID_REQUEST", message)
    }
    fn pack(message: impl std::fmt::Display) -> Self {
        Self::new("ERR_INVALID_MANIFEST", message)
    }
    fn storage(message: impl std::fmt::Display) -> Self {
        Self::new("ERR_STORAGE", message)
    }
}
impl From<container_bridge::BridgeError> for SdkError {
    fn from(error: container_bridge::BridgeError) -> Self {
        Self::new(error.code.as_str(), error.message)
    }
}
impl From<container_runtime::SessionError> for SdkError {
    fn from(error: container_runtime::SessionError) -> Self {
        if matches!(
            error,
            container_runtime::SessionError::UntrustedApplication(_)
        ) {
            return Self::new("ERR_UNTRUSTED_APPLICATION", error);
        }
        Self::new("ERR_ENGINE", error)
    }
}

fn require_full_distribution() -> Result<(), SdkError> {
    if container_runtime::is_restricted_showcase() {
        return Err(SdkError::new("ERR_UNSUPPORTED_CAPABILITY",
            "development, inspection and installed-pack authorization are disabled in this distribution"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ContainerConfig {
    pub engine: EngineKind,
    pub host: HostMetadata,
    pub session_id: Option<String>,
    pub storage_key: Option<String>,
    pub storage_root: Option<PathBuf>,
    /// Native-only managed files, independent from in-memory key/value storage.
    pub managed_files_root: Option<PathBuf>,
    /// None preserves the feature-selected legacy behavior. Explicit true
    /// requires a native GPU build; false requests the diagnostic raster path.
    pub gpu_required: Option<bool>,
    /// Opt-in bounded AppService console diagnostics for development clients.
    pub dev_diagnostics: bool,
    /// Embedding host has attached a system tabBar presenter for dynamic badges,
    /// dots and style. Event forwarding alone must leave this disabled.
    #[serde(skip_serializing_if = "system_tab_bar_disabled")]
    pub system_tab_bar: bool,
    /// Explicit opt-in: observed native metrics are committed with measured
    /// chrome, never by separate legacy commands.
    pub host_layout: Option<HostLayoutConfig>,
    /// Trusted installation/account metadata supplied by the embedding host.
    /// It is verified against the accepted pack, never inferred from guest JS.
    pub host_services: Option<HostServicesConfig>,
}
impl Default for ContainerConfig {
    fn default() -> Self {
        Self {
            engine: EngineKind::Quickjs,
            host: HostMetadata {
                window_width: 375,
                window_height: 667,
                ..HostMetadata::default()
            },
            session_id: None,
            storage_key: None,
            storage_root: None,
            managed_files_root: None,
            gpu_required: None,
            dev_diagnostics: false,
            system_tab_bar: false,
            host_layout: None,
            host_services: None,
        }
    }
}
fn system_tab_bar_disabled(value: &bool) -> bool {
    !value
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevReloadResult {
    pub reload_kind: DevReloadKind,
    /// Startup/frame acceptance only. Native GPU presentation is acknowledged
    /// independently and is never implied by this result.
    pub state: Value,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct LoadOptions {
    pub route: Option<String>,
    pub options: Map<String, Value>,
    /// Optional measured layout for a replacement candidate. It becomes live
    /// only after successful startup; the accepted owner is not resized first.
    pub initial_host_chrome: Option<HostChromeGeometry>,
    pub initial_host_layout: Option<HostLayout>,
}

struct NativeProvider;
impl NativeProvider {
    fn metadata(name: &str, host: &HostMetadata) -> Option<Value> {
        if !matches!(
            name,
            "wx.getSystemInfo" | "wx.getSystemInfoAsync" | "wx.getSystemInfoSync"
        ) {
            return None;
        }
        let mut observed = json!({"SDKVersion":env!("CARGO_PKG_VERSION")});
        if !host.platform.is_empty() {
            observed["platform"] = json!(host.platform);
        }
        if !host.version.is_empty() {
            observed["system"] = json!(host.version);
        }
        Some(observed)
    }
}
impl HostApiProvider for NativeProvider {
    fn name(&self) -> &'static str {
        "weapp-sdk"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        [
            "wx.request",
            "wx.getSystemInfo",
            "wx.getSystemInfoAsync",
            "wx.getSystemInfoSync",
            "wx.getWindowInfo",
            "wx.getDeviceInfo",
            "wx.getAppBaseInfo",
            "wx.getSystemSetting",
            "wx.getMenuButtonBoundingClientRect",
            "wx.setNavigationBarTitle",
            "wx.setNavigationBarColor",
        ]
        .into_iter()
        .map(|name| (name.into(), CapabilitySupport::Partial))
        .collect()
    }
    fn capabilities_for_host(&self, host: &HostMetadata) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities = self.capabilities();
        if host.platform.is_empty() && host.version.is_empty() {
            capabilities.insert("wx.getDeviceInfo".into(), CapabilitySupport::Unsupported);
        }
        for name in container_runtime::HOST_GEOMETRY_APIS {
            let support =
                if container_runtime::merge_host_geometry(name, Self::metadata(name, host), host)
                    .is_ok_and(|value| value.is_some())
                {
                    CapabilitySupport::Partial
                } else {
                    CapabilitySupport::Unsupported
                };
            capabilities.insert(name.into(), support);
        }
        capabilities
    }
    fn call(
        &mut self,
        name: &str,
        _: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if matches!(
            name,
            "wx.setNavigationBarTitle" | "wx.setNavigationBarColor"
        ) {
            // Runtime validates and commits page-instance state; this provider
            // authorizes the host chrome observation consumed by native UI.
            return Ok(json!({"errMsg":format!("{}:ok", name.trim_start_matches("wx."))}));
        }
        let host = &context.host;
        if matches!(
            name,
            "wx.getSystemInfo"
                | "wx.getSystemInfoAsync"
                | "wx.getSystemInfoSync"
                | "wx.getWindowInfo"
                | "wx.getSystemSetting"
                | "wx.getMenuButtonBoundingClientRect"
        ) {
            // Real non-geometry metadata can be partial before first layout;
            // physical screen/DPR still require a complete accepted display.
            if let Some(value) =
                container_runtime::merge_host_geometry(name, Self::metadata(name, host), host)?
            {
                return Ok(value);
            }
        }
        if name == "wx.getDeviceInfo" {
            let mut observed = Map::new();
            if !host.platform.is_empty() {
                observed.insert("platform".into(), json!(host.platform));
            }
            if !host.version.is_empty() {
                observed.insert("system".into(), json!(host.version));
            }
            if !observed.is_empty() {
                return Ok(Value::Object(observed));
            }
        }
        if name == "wx.getAppBaseInfo" {
            return Ok(json!({"SDKVersion":env!("CARGO_PKG_VERSION")}));
        }
        Err(ProviderError {
            code: ProviderErrorCode::Unsupported,
            message: format!("native capability unavailable: {name}"),
            retryable: false,
        })
    }
    fn start_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> ProviderStart {
        if name == "wx.request" {
            ProviderStart::Pending
        } else {
            ProviderStart::Ready(self.call(name, payload, context))
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct RenderInputIdentity {
    page_id: u64,
    route: String,
    view_revision: u64,
    input_lifetime: Option<u64>,
}

struct Active {
    session: Session,
    pack: pack::VerifiedPack,
    request: u64,
    rendered: Option<RenderInputIdentity>,
    foreground: bool,
    stored_stamp: Option<container_core::StorageStamp>,
    pending_console: Vec<Value>,
}
impl Active {
    fn request_batch(&mut self, operation: &str, payload: Value) -> Result<BridgeBatch, SdkError> {
        self.request = self
            .request
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("request sequence exhausted"))?;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            self.session.config().session_id.clone(),
            format!("sdk-{}", self.request),
            operation,
            payload,
        ));
        self.pending_console.extend(console_events(&batch));
        if self.pending_console.len() > MAX_EVENTS {
            self.pending_console
                .drain(..self.pending_console.len() - MAX_EVENTS);
        }
        Ok(batch)
    }
    fn dispatch(&mut self, operation: &str, payload: Value) -> Result<BridgeBatch, SdkError> {
        let batch = self.request_batch(operation, payload)?;
        validate_batch(&batch)?;
        if !batch.messages.iter().any(|m| {
            m.kind == EnvelopeKind::Response
                && m.op == operation
                && m.payload.get("ok") == Some(&Value::Bool(true))
        }) {
            return Err(SdkError::new(
                "ERR_ENGINE",
                format!("missing acknowledgement for {operation}"),
            ));
        }
        Ok(batch)
    }
    fn token(&self) -> Option<RenderInputIdentity> {
        self.session
            .app_service()
            .pages()
            .current()
            .map(|p| RenderInputIdentity {
                page_id: p.id.0,
                route: p.path.clone(),
                view_revision: self.session.view().revision,
                // Hiding or retiring a presenter revokes its coordinate
                // authority even when the page and template data are unchanged.
                // A new accepted frame must own the current input lifetime.
                input_lifetime: self.session.input_lifetime_revision(),
            })
    }
    fn render(&mut self, force: bool) -> Result<bool, SdkError> {
        let token = self.token();
        if token.is_none() || (!force && token == self.rendered) {
            return Ok(false);
        }
        let route = token.as_ref().unwrap().route.clone();
        let frame = self
            .session
            .view()
            .last_frame_id
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| SdkError::new("ERR_RENDER", "frame sequence exhausted"))?;
        let host = &self.session.config().host;
        let mut payload = json!({"templateId":self.pack.template(&route)?,"styleIds":self.pack.manifest.route_style_ids(&route).map_err(SdkError::pack)?,
            "viewport":Rect{x:0.,y:0.,width:host.window_width as f32,height:host.window_height as f32},"frameId":frame});
        if self.session.can_reuse_render_resources() {
            payload["useSessionResources"] = Value::Bool(true);
        } else {
            // app.init and accepted render commits authorize Session's lease.
            // A changed manifest (including rollback) must submit and verify
            // its own pack before that lease can be reused again.
            payload["blobs"] = self.pack.blobs();
        }
        let batch = self.request_batch(op::RENDER_COMMIT, payload)?;
        let accepted = batch.messages.iter().any(|message| {
            message.kind == EnvelopeKind::Response
                && message.op == op::RENDER_COMMIT
                && message.payload.get("ok") == Some(&Value::Bool(true))
                && message.payload.get("frameId").and_then(Value::as_u64) == Some(frame)
        });
        if accepted {
            self.rendered = token;
        }
        validate_batch(&batch)?;
        if !accepted {
            return Err(SdkError::new(
                "ERR_RENDER",
                "render returned no accepted frame acknowledgement",
            ));
        }
        Ok(true)
    }
}

/// A thread-affine application session, independent from a particular UI
/// toolkit. It is deliberately !Send/!Sync. All callbacks are queued events.
pub struct ContainerSession {
    #[cfg(test)]
    test_view_execution: Option<container_runtime::ViewExecutionPolicy>,
    #[cfg(feature = "testing")]
    test_options: Option<testing::TestOptions>,
    config: ContainerConfig,
    owner: ThreadId,
    base_id: String,
    sdk_owner_id: u64,
    generation: u64,
    active: Option<Active>,
    methods: BTreeSet<String>,
    storage: Option<storage::PersistentStorage>,
    managed_file_scope: Option<managed_files::ManagedFileScope>,
    http: Option<http::HttpService>,
    retired_http: Vec<http::HttpService>,
    http_calls: BTreeSet<String>,
    events: VecDeque<Value>,
    revision: u64,
    observed_frame: Option<(String, u64)>,
    observed_navigation: Option<(String, Vec<(u64, String)>)>,
    observed_chrome: Option<Value>,
    observed_execution_health: Option<Value>,
    observed_pending_navigation: Option<Value>,
    chrome_revision: u64,
    host_chrome: Option<HostChromeGeometry>,
    preview_occluded: bool,
    observed_viewport: (u32, u32),
    observed_window_metrics: Option<HostWindowMetrics>,
    staged_chrome_pending: bool,
    host_layout_state: host_layout::HostLayoutState,
    accepted_pack_revision: u64,
    dev_attempts: dev_attempt::DevAttemptJournal,
    snapshot_cache: Option<(u64, u32, u32, Arc<RenderSnapshot>)>,
    render_diagnostics: render_diagnostics::RenderDiagnostics,
    surface: Option<String>,
    closed: bool,
    closing: Option<u64>,
    close_result: Option<Result<(), String>>,
    account_manager: Option<HostAccountManager>,
    account_switch: Option<account::PendingAccountSwitch>,
    account_receipts: VecDeque<AccountSwitchReceipt>,
    identity_rebuilding: bool,
    application_revision: account::ApplicationRevision,
    pending_host_apis: BTreeMap<String, (String, Option<u64>)>,
    authorized_applications: BTreeMap<String, TrustedApplication>,
    _thread_affinity: PhantomData<Rc<()>>,
}

impl ContainerSession {
    pub fn new(config: ContainerConfig) -> Result<Self, SdkError> {
        if config.dev_diagnostics {
            require_full_distribution()?;
        }
        if !engine_provider_compiled(config.engine) {
            return Err(SdkError::new(
                "ERR_ENGINE",
                format!("engine provider unavailable: {:?}", config.engine),
            ));
        }
        if config.host.window_width == 0 || config.host.window_height == 0 {
            return Err(SdkError::invalid(
                "host windowWidth/windowHeight must be positive",
            ));
        }
        let account_manager = config
            .host_services
            .as_ref()
            .map(|services| {
                HostAccountManager::for_domain(
                    &services.application.host_app_id,
                    &services.application.tenant_id,
                    services.account.clone(),
                )
            })
            .transpose()?;
        let storage = match (&config.storage_key, &config.storage_root) {
            (Some(key), Some(root)) => {
                let key = config
                    .host_services
                    .as_ref()
                    .map(|services| {
                        storage_namespace(&services.application, &services.account, key)
                    })
                    .transpose()?
                    .unwrap_or_else(|| key.clone());
                Some(storage::PersistentStorage::open(
                    &config
                        .host_services
                        .as_ref()
                        .map(|services| {
                            account::storage_directory(
                                root,
                                &services.application,
                                &services.account,
                            )
                        })
                        .transpose()?
                        .unwrap_or_else(|| root.clone()),
                    &key,
                )?)
            }
            (None, None) => None,
            _ => {
                return Err(SdkError::invalid(
                    "storageKey and storageRoot must be provided together",
                ))
            }
        };
        if let Some(layout) = &config.host_layout {
            layout.validate()?;
        }
        if let (Some(manager), Some(services), Some(root)) = (
            &account_manager,
            &config.host_services,
            &config.storage_root,
        ) {
            manager.record_storage_root(root, &services.application)?;
        }
        let sdk_owner_id = NEXT_SESSION.fetch_add(1, Ordering::Relaxed);
        let base_id = config
            .session_id
            .clone()
            .unwrap_or_else(|| format!("sdk-{}-{}", std::process::id(), sdk_owner_id));
        if base_id.trim().is_empty() {
            return Err(SdkError::invalid("sessionId cannot be empty"));
        }
        if let (Some(manager), Some(services), Some(root)) = (
            &account_manager,
            &config.host_services,
            &config.managed_files_root,
        ) {
            manager.record_storage_root(root, &services.application)?;
        }
        let application_revision = account_manager
            .as_ref()
            .map(|manager| manager.snapshot())
            .transpose()?
            .and_then(|state| {
                config
                    .host_services
                    .as_ref()
                    .map(|s| state.application_revision(&s.application))
            })
            .unwrap_or_default();
        let observed_viewport = (config.host.window_width, config.host.window_height);
        let observed_window_metrics =
            config
                .host
                .display_metrics
                .clone()
                .map(|display| HostWindowMetrics {
                    window_width: observed_viewport.0,
                    window_height: observed_viewport.1,
                    display,
                });
        let authorized_applications = config
            .host_services
            .as_ref()
            .map(|services| {
                BTreeMap::from([(
                    services.application.pack_root.clone(),
                    services.application.clone(),
                )])
            })
            .unwrap_or_default();
        Ok(Self {
            #[cfg(test)]
            test_view_execution: None,
            #[cfg(feature = "testing")]
            test_options: None,
            config,
            owner: thread::current().id(),
            base_id,
            sdk_owner_id,
            generation: 0,
            active: None,
            methods: BTreeSet::new(),
            storage,
            managed_file_scope: None,
            http: None,
            retired_http: Vec::new(),
            http_calls: BTreeSet::new(),
            events: VecDeque::new(),
            revision: 0,
            observed_frame: None,
            observed_navigation: None,
            observed_chrome: None,
            observed_execution_health: None,
            observed_pending_navigation: None,
            chrome_revision: 0,
            host_chrome: None,
            preview_occluded: false,
            observed_viewport,
            observed_window_metrics,
            staged_chrome_pending: false,
            host_layout_state: host_layout::HostLayoutState::default(),
            accepted_pack_revision: 0,
            dev_attempts: dev_attempt::DevAttemptJournal::default(),
            snapshot_cache: None,
            render_diagnostics: Default::default(),
            surface: None,
            closed: false,
            closing: None,
            close_result: None,
            account_manager,
            account_switch: None,
            account_receipts: VecDeque::new(),
            identity_rebuilding: false,
            application_revision,
            pending_host_apis: BTreeMap::new(),
            authorized_applications,
            _thread_affinity: PhantomData,
        })
    }

    pub fn load(&mut self, source: PackSource, options: LoadOptions) -> Result<(), SdkError> {
        self.ensure_open()?;
        let pack = pack::VerifiedPack::load(source)?;
        self.load_verified(pack, options)
    }

    fn load_verified(
        &mut self,
        pack: pack::VerifiedPack,
        options: LoadOptions,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.poll_http_retirement();
        if self.retired_http.len() >= MAX_RETIRED_HTTP_OWNERS {
            return Err(SdkError::new(
                "ERR_NETWORK",
                "previous HTTP owners are still draining",
            ));
        }
        let mut candidate_services = self.services_for_pack(&pack.manifest.integrity.root)?;
        if self.surface.is_some() {
            return Err(SdkError::new(
                "ERR_SURFACE_ATTACHED",
                "detach the surface before replacing its runtime",
            ));
        }
        if options.initial_host_chrome.is_some() && options.initial_host_layout.is_some() {
            return Err(SdkError::invalid(
                "initialHostChrome and initialHostLayout are mutually exclusive",
            ));
        }
        let initial_layout = if self.atomic_host_layout() {
            if options.initial_host_chrome.is_some() {
                return Err(SdkError::new(
                    "ERR_UNSUPPORTED_CAPABILITY",
                    "atomic layout requires initialHostLayout, not initialHostChrome",
                ));
            }
            let layout = options.initial_host_layout.clone().ok_or_else(|| {
                SdkError::invalid("atomic startup requires a complete measured initialHostLayout")
            })?;
            if self.host_layout_state.pending.is_none() {
                return Err(SdkError::new(
                    "ERR_CANCELLED",
                    "atomic startup requires a new native layout observation",
                ));
            }
            self.validate_host_layout(&layout)?;
            Some(layout)
        } else {
            if options.initial_host_layout.is_some() {
                return Err(SdkError::new(
                    "ERR_UNSUPPORTED_CAPABILITY",
                    "atomic layout was not enabled before startup",
                ));
            }
            None
        };
        if initial_layout.is_none()
            && options.initial_host_chrome.is_none()
            && !self.chrome_geometry_matches()
        {
            return Err(SdkError::invalid(
                "initial host chrome dimensions differ from window metrics",
            ));
        }
        let route = pack.route(options.route.as_deref())?;
        let accepted_pack_revision = self
            .accepted_pack_revision
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("accepted pack revision exhausted"))?;
        // Validate host presentation configuration before any guest startup or
        // accepted-session replacement. A malformed candidate cannot retire it.
        container_runtime::resolve_page_chrome(
            &pack.manifest,
            &pack.blobs,
            &route,
            None,
            Vec::new(),
            None,
        )?;
        let mut candidate_host = self.config.host.clone();
        let mut initial_chrome = options.initial_host_chrome;
        if let Some(layout) = &initial_layout {
            candidate_host.window_width = layout.window_metrics.window_width;
            candidate_host.window_height = layout.window_metrics.window_height;
            candidate_host.display_metrics = Some(layout.window_metrics.display.clone());
            candidate_host.menu_button_rect = Some(layout.chrome.menu_button_rect.clone());
        }
        if let Some(geometry) = &initial_chrome {
            geometry.validate()?;
            self.validate_host_chrome_owner(geometry)?;
            candidate_host.window_width = geometry.content_rect.width.round() as u32;
            candidate_host.window_height = geometry.content_rect.height.round() as u32;
            candidate_host.menu_button_rect = Some(geometry.menu_button_rect.clone());
        }
        let generation = self
            .generation
            .checked_add(1)
            .ok_or_else(|| SdkError::invalid("session generation exhausted"))?;
        let mut session = Session::new(
            pack.manifest.clone(),
            SessionConfig {
                #[cfg(test)]
                view_execution: self.test_view_execution.clone().unwrap_or_default(),
                session_id: format!("{}-{generation}", self.base_id),
                engine: self.config.engine,
                #[cfg(feature = "testing")]
                engine_execution: self
                    .test_options
                    .as_ref()
                    .map(|options| options.execution_policy())
                    .unwrap_or_default(),
                host: candidate_host,
                require_integrity: true,
                page_render_mode: self.configured_render_mode()?,
                capabilities: container_runtime::SYSTEM_TAB_BAR_APIS
                    .into_iter()
                    .map(|name| {
                        (
                            name.to_owned(),
                            if self.config.system_tab_bar {
                                CapabilitySupport::Partial
                            } else {
                                CapabilitySupport::Unsupported
                            },
                        )
                    })
                    .collect(),
                ..SessionConfig::default()
            },
        )?;
        // GPU adapters present accepted frames directly. Native CPU raster and
        // readback occur only when a consumer explicitly asks for a snapshot.
        session.ensure_view_execution_supported()?;
        session.set_dev_console_enabled(self.config.dev_diagnostics)?;
        session.set_provider(Box::new(NativeProvider));
        #[cfg(feature = "testing")]
        if let Some(options) = &self.test_options {
            session.testing_control(json!({"action":"clock", "now":options.now_ms}))?;
        }
        session.set_host_methods(self.methods.iter().cloned().collect())?;
        if let Some(services) = &mut candidate_services {
            if self.config.managed_files_root.is_some()
                && services.apis.iter().any(|api| {
                    api == "wx.getFileSystemManager" || api.starts_with("object:FileSystemManager.")
                })
            {
                if self.managed_file_scope.is_none() {
                    let mut scoped_config = self.config.clone();
                    scoped_config.host_services = Some(services.clone());
                    self.managed_file_scope =
                        Some(managed_files::ManagedFileScope::open(&scoped_config)?);
                }
                let provider = container_runtime::ManagedSyncFileSystem::new(
                    self.managed_file_scope.as_ref().unwrap().user_root(),
                )
                .map_err(SdkError::storage)?;
                for api in container_core::SyncHostApi::supported_apis(&provider) {
                    if !services.apis.contains(&api) {
                        services.apis.push(api);
                    }
                }
                if !services
                    .apis
                    .iter()
                    .any(|api| api == "wx.getFileSystemManager")
                {
                    services.apis.push("wx.getFileSystemManager".into());
                }
                session.bind_sync_host_api(std::sync::Arc::new(provider))?;
            }
            session.configure_host_services(services.clone())?;
        }
        let snapshot = self
            .active
            .as_ref()
            .map(|a| a.session.storage_snapshot())
            .or_else(|| self.storage.as_ref().map(|s| s.initial.clone()))
            .unwrap_or_default();
        session.restore_storage(snapshot)?;
        let mut candidate = Active {
            session,
            pack,
            request: 0,
            rendered: None,
            foreground: true,
            stored_stamp: None,
            pending_console: Vec::new(),
        };
        if self.atomic_host_layout() {
            // Launch hooks may request navigation. Queue that intent before
            // any application code; the prepared initial page is the only
            // direct startup exception, never the launch-requested target.
            candidate.session.set_deferred_navigation_enabled(true)?;
        }
        let mut launch = options.options;
        launch.insert("path".into(), json!(route));
        let _startup = [
            candidate.dispatch(op::APP_INIT,json!({"modules":candidate.pack.modules(),"blobs":candidate.pack.blobs(),"launchOptions":launch}))?,
            candidate.dispatch(op::APP_LIFECYCLE, json!({"event":"launch","options":launch}))?,
            candidate.dispatch(op::PAGE_PUSH, json!({"path":route,"query":launch.get("query").cloned().unwrap_or(json!({}))}))?,
        ];
        candidate.render(true)?;
        if self.atomic_host_layout() {
            candidate.session.set_deferred_navigation_enabled(true)?;
        }
        // Create the new owner's isolated connection pool before retiring the
        // live owner. A setup failure preserves the previous accepted runtime.
        let candidate_http = http::HttpService::new()?;
        // Queued host effects and key/value snapshots publish only after the
        // candidate frame is accepted. Authorized synchronous local file work
        // is already durable and is not rolled back on startup failure.
        self.cancel_active_navigation("accepted pack replaced");
        let _ = self.unload_active_for_retirement();
        self.retire_active();
        self.config.host = candidate.session.config().host.clone();
        if let Some(geometry) = &mut initial_chrome {
            geometry.session_id = Some(candidate.session.config().session_id.clone());
            geometry.page_id = candidate
                .session
                .app_service()
                .pages()
                .current()
                .map(|page| page.id.0);
            self.staged_chrome_pending =
                (geometry.content_rect.width - f64::from(self.observed_viewport.0)).abs() > 0.5
                    || (geometry.content_rect.height - f64::from(self.observed_viewport.1)).abs()
                        > 0.5;
        }
        if initial_chrome.is_some() {
            self.host_chrome = initial_chrome;
        }
        self.active = Some(candidate);
        self.http = Some(candidate_http);
        self.config.host_services = candidate_services;
        self.generation = generation;
        self.accepted_pack_revision = accepted_pack_revision;
        self.cancel_prepared_dev_attempts();
        if let Some(layout) = initial_layout {
            self.accept_host_layout(layout);
        }
        self.push_event(json!({"type":"ready","state":self.state()?}));
        // The first accepted frame is the publication point. Later observer
        // work or host transport errors are runtime events, not a failed load
        // that falsely promises the previous instance is still active.
        if let Err(error) = self.finish_operation_with_render(false) {
            self.push_event(json!({"type":"error","error":error}));
        }
        Ok(())
    }

    fn configured_render_mode(&self) -> Result<container_render_skia::PageRenderMode, SdkError> {
        let compiled = cfg!(feature = "skia-gpu-gles")
            || cfg!(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ));
        if self.config.gpu_required == Some(true) && !compiled {
            return Err(SdkError::new(
                "ERR_UNSUPPORTED_CAPABILITY",
                "this runtime has no native GPU presenter",
            ));
        }
        Ok(if self.config.gpu_required.unwrap_or(compiled) {
            container_render_skia::PageRenderMode::NativeGpu
        } else {
            container_render_skia::PageRenderMode::Raster
        })
    }

    /// Inspect a verified candidate without mutating the live runtime. This
    /// result is advisory: apply_dev_pack verifies and classifies again.
    pub fn classify_dev_pack(&self, source: PackSource) -> Result<DevReloadKind, SdkError> {
        require_full_distribution()?;
        self.ensure_open()?;
        let next = pack::VerifiedPack::load(source)?;
        Ok(self.classify_verified_dev_pack(&next))
    }

    fn classify_verified_dev_pack(&self, next: &pack::VerifiedPack) -> DevReloadKind {
        self.active
            .as_ref()
            .filter(|active| !active.session.requires_dev_restart())
            .map(|active| {
                container_runtime::dev_reload::classify_pack_reload(
                    &active.pack.manifest,
                    &active.pack.blobs,
                    &next.manifest,
                    &next.blobs,
                )
            })
            .unwrap_or(DevReloadKind::Restart)
    }

    /// Apply an already downloaded immutable pack. Safe presentation edits
    /// retain the live JS heap, page stack, timers, storage and attached GPU.
    /// A restart uses load's isolated candidate and requires the host to detach
    /// its surface first. No accepted frame is described as GPU-presented.
    pub fn apply_dev_pack(
        &mut self,
        source: PackSource,
        options: LoadOptions,
    ) -> Result<DevReloadResult, SdkError> {
        require_full_distribution()?;
        self.ensure_open()?;
        let next = pack::VerifiedPack::load(source)?;
        self.apply_verified_dev_pack(next, options)
    }

    fn apply_verified_dev_pack(
        &mut self,
        next: pack::VerifiedPack,
        mut options: LoadOptions,
    ) -> Result<DevReloadResult, SdkError> {
        self.ensure_open()?;
        let reload_kind = self.classify_verified_dev_pack(&next);
        let candidate_services = self.services_for_pack(&next.manifest.integrity.root)?;
        if reload_kind == DevReloadKind::InPlace
            && (options.initial_host_chrome.is_some() || options.initial_host_layout.is_some())
        {
            return Err(SdkError::invalid(
                "initial host layout is only valid for a restart",
            ));
        }
        if reload_kind == DevReloadKind::Restart {
            // Preserve the visible route when it still exists. A deleted route
            // falls back to the first declaration, as at ordinary startup.
            if options.route.is_none() {
                options.route = self
                    .active
                    .as_ref()
                    .and_then(|a| a.session.app_service().pages().current())
                    .map(|p| p.path.clone())
                    .filter(|route| next.manifest.routes.iter().any(|r| &r.path == route));
            }
            let foreground = self.active.as_ref().is_none_or(|a| a.foreground);
            self.load_verified(next, options)?;
            if !foreground {
                if let Err(error) = self.set_foreground(false) {
                    self.push_event(json!({"type":"error","error":error}));
                }
            }
        } else {
            let accepted_pack_revision = self
                .accepted_pack_revision
                .checked_add(1)
                .ok_or_else(|| SdkError::invalid("accepted pack revision exhausted"))?;
            let active = self
                .active
                .as_mut()
                .expect("in-place reload requires active session");
            let route = active.token().map(|token| token.route).ok_or_else(|| {
                SdkError::new("ERR_RENDER", "no current page for development reload")
            })?;
            let frame = active
                .session
                .view()
                .last_frame_id
                .unwrap_or(0)
                .checked_add(1)
                .ok_or_else(|| SdkError::new("ERR_RENDER", "frame sequence exhausted"))?;
            let host = &active.session.config().host;
            let payload = json!({"templateId":next.template(&route)?,
                "styleIds":next.manifest.route_style_ids(&route).map_err(SdkError::pack)?,
                "blobs":next.blobs(), "frameId":frame,
                "viewport":Rect{x:0.,y:0.,width:host.window_width as f32,height:host.window_height as f32}});
            let mut preview = Session::new(next.manifest.clone(), active.session.config().clone())?;
            let mut rendered = active.token();
            let batch = active
                .session
                .replace_dev_presentation(&mut preview, &payload)?;
            if let Some(token) = &mut rendered {
                // Replacement accepts this captured page/data snapshot under a
                // new input lifetime. Keep its original page and view revision
                // so ready/callback mutations still require a later render.
                token.input_lifetime = active.session.input_lifetime_revision();
            }
            // The exact candidate is now published. Ready/callback diagnostics
            // belong to it; they cannot restore the previous pack metadata.
            active.pack = next;
            active.rendered = rendered;
            active.pending_console.extend(console_events(&batch));
            if active.pending_console.len() > MAX_EVENTS {
                active
                    .pending_console
                    .drain(..active.pending_console.len() - MAX_EVENTS);
            }
            let render_result = validate_batch(&batch);
            self.accepted_pack_revision = accepted_pack_revision;
            self.cancel_prepared_dev_attempts();
            let trusted_result = if let Some(services) = &candidate_services {
                self.active
                    .as_mut()
                    .expect("accepted in-place owner")
                    .session
                    .update_trusted_application(services.application.clone())
                    .map_err(SdkError::from)
            } else {
                Ok(())
            };
            self.config.host_services = candidate_services;
            if let Err(error) = trusted_result {
                self.push_event(json!({"type":"error","error":error}));
            }
            // An accepted frame can also carry ready/callback diagnostics.
            // Their effects belong to the new generation and cannot roll back.
            if let Err(error) = render_result {
                self.push_event(json!({"type":"error","error":error}));
            }
            if let Err(error) = self.finish_operation_with_render(false) {
                self.push_event(json!({"type":"error","error":error}));
            }
        }
        let state = self.state()?;
        self.push_event(json!({"type":"devReload","reloadKind":reload_kind,"state":state}));
        Ok(DevReloadResult { reload_kind, state })
    }

    pub fn register_host_method(&mut self, name: &str) -> Result<(), SdkError> {
        require_full_distribution()?;
        self.ensure_open()?;
        if self.active.is_some() {
            return Err(SdkError::invalid("register host methods before load"));
        }
        if name.trim().is_empty()
            || name.starts_with("wx.")
            || name.len() > 128
            || self.methods.len() >= 256
        {
            return Err(SdkError::invalid(
                "invalid/reserved host method name or method limit exceeded",
            ));
        }
        self.methods.insert(name.into());
        Ok(())
    }

    /// Configure trusted host APIs before loading. Separate from arbitrary
    /// business methods: catalog/runtime-owned names can never be overridden.
    pub fn configure_host_services(&mut self, config: HostServicesConfig) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.active.is_some() {
            return Err(SdkError::invalid("configure host services before load"));
        }
        // Validate the entire configuration before touching account or storage.
        container_runtime::validate_host_services_config(&config)?;
        let manager = HostAccountManager::for_domain(
            &config.application.host_app_id,
            &config.application.tenant_id,
            config.account.clone(),
        )?;
        if let Some(storage) = self.storage.take() {
            storage.close()?;
        }
        self.storage = match (&self.config.storage_root, &self.config.storage_key) {
            (Some(root), Some(key)) => Some(storage::PersistentStorage::open(
                &account::storage_directory(root, &config.application, &config.account)?,
                &storage_namespace(&config.application, &config.account, key)?,
            )?),
            _ => None,
        };
        if let Some(root) = &self.config.storage_root {
            manager.record_storage_root(root, &config.application)?;
        }
        if let Some(root) = &self.config.managed_files_root {
            manager.record_storage_root(root, &config.application)?;
        }
        self.account_manager = Some(manager);
        self.authorized_applications = BTreeMap::from([(
            config.application.pack_root.clone(),
            config.application.clone(),
        )]);
        self.config.host_services = Some(config);
        Ok(())
    }

    pub fn register_api_handler(&mut self, name: &str) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.active.is_some() {
            return Err(SdkError::invalid("register API handlers before load"));
        }
        let mut config = self.config.host_services.clone().ok_or_else(|| {
            SdkError::invalid("configure trusted host services before registering APIs")
        })?;
        if !config.apis.iter().any(|api| api == name) {
            config.apis.push(name.into());
        }
        container_runtime::validate_host_services_config(&config)?;
        self.config.host_services = Some(config);
        Ok(())
    }

    pub fn account_manager(&self) -> Option<HostAccountManager> {
        self.account_manager.clone()
    }

    fn services_for_pack(&self, root: &str) -> Result<Option<HostServicesConfig>, SdkError> {
        let Some(mut services) = self.config.host_services.clone() else {
            return Ok(None);
        };
        services.application =
            self.authorized_applications
                .get(root)
                .cloned()
                .ok_or_else(|| {
                    SdkError::new(
                        "ERR_UNTRUSTED_APPLICATION",
                        "pack does not match a host-authenticated installation record",
                    )
                })?;
        Ok(Some(services))
    }

    /// The host authenticates the new installation before authorizing its bytes.
    pub fn authorize_installed_pack(
        &mut self,
        application: TrustedApplication,
    ) -> Result<(), SdkError> {
        require_full_distribution()?;
        self.ensure_open()?;
        let mut config = self
            .config
            .host_services
            .clone()
            .ok_or_else(|| SdkError::invalid("host services not configured"))?;
        let previous = &config.application;
        if previous.host_app_id != application.host_app_id
            || previous.tenant_id != application.tenant_id
            || previous.publisher_id != application.publisher_id
            || previous.app_id != application.app_id
            || previous.environment != application.environment
        {
            return Err(SdkError::new(
                "ERR_UNTRUSTED_APPLICATION",
                "a pack upgrade cannot change its installed identity or data namespace",
            ));
        }
        config.application = application;
        container_runtime::validate_host_services_config(&config)?;
        if self.authorized_applications.len() >= 64
            && !self
                .authorized_applications
                .contains_key(&config.application.pack_root)
        {
            return Err(SdkError::invalid(
                "trusted installation authorization limit exceeded",
            ));
        }
        self.authorized_applications
            .insert(config.application.pack_root.clone(), config.application);
        Ok(())
    }

    /// Explicit host-authorized migration, only into an empty scoped namespace.
    pub fn migrate_legacy_storage(&mut self, source_key: &str) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.active.is_some() {
            return Err(SdkError::invalid("migrate storage before load"));
        }
        let services = self
            .config
            .host_services
            .as_ref()
            .ok_or_else(|| SdkError::invalid("scoped host services required for migration"))?;
        let root = self
            .config
            .storage_root
            .as_ref()
            .ok_or_else(|| SdkError::invalid("persistent storage required"))?;
        let key = self.config.storage_key.as_ref().unwrap();
        let destination = storage_namespace(&services.application, &services.account, key)?;
        if source_key == destination {
            return Err(SdkError::invalid("migration source and destination differ"));
        }
        let store = self
            .storage
            .as_mut()
            .ok_or_else(|| SdkError::invalid("storage is not open"))?;
        if !store.initial.values.is_empty() || !store.initial.undefined_keys.is_empty() {
            return Err(SdkError::new(
                "ERR_STORAGE_CONFLICT",
                "migration destination must be empty",
            ));
        }
        let source = storage::PersistentStorage::open(root, source_key)?;
        let snapshot = source.initial.clone();
        source.close()?;
        store.queue(snapshot.clone())?;
        store.flush()?;
        store.initial = snapshot;
        self.push_event(json!({"type":"legacyStorageMigrated","scope":destination}));
        Ok(())
    }

    pub fn complete_host_api_call(
        &mut self,
        call_id: &str,
        result: Result<Value, HostApiFailure>,
    ) -> Result<(), SdkError> {
        self.ensure_open()?;
        let method = self.pending_host_apis.get(call_id);
        // Logout revocation precedes any guest continuation. The SDK's special
        // retirement path must still honor the runtime's original deadline;
        // a late backend success is settled by the normal timeout path below.
        if result.is_ok()
            && method.is_some_and(|(name, deadline)| {
                name == "weappContainer.identity.logout"
                    && deadline.is_none_or(|deadline| deadline > clock_now_ns())
            })
        {
            let application = &self
                .config
                .host_services
                .as_ref()
                .ok_or_else(|| SdkError::invalid("host services not configured"))?
                .application;
            self.account_manager
                .as_ref()
                .unwrap()
                .revoke_application_scope(application)?;
            self.pending_host_apis.remove(call_id);
            return self.poll_account_switch();
        }
        let batch = self
            .active_mut()?
            .session
            .complete_host_api_call(call_id, result)?;
        self.pending_host_apis.remove(call_id);
        self.observe_batch(&batch)?;
        self.finish_operation()
    }

    pub fn dispatch_host_api_event(&mut self, event: HostApiEvent) -> Result<(), SdkError> {
        self.ensure_open()?;
        let batch = self.active_mut()?.session.dispatch_host_api_event(event)?;
        self.observe_batch(&batch)?;
        self.finish_operation()
    }

    /// Read only the source authorized by an exact in-flight API context. JSON
    /// transports copy at most one MiB per command; they never choose a path or
    /// register a resource handle that could outlive the original setter.
    pub fn host_api_resource_chunk(
        &self,
        context: &HostApiCallContext,
        offset: usize,
        length: usize,
    ) -> Result<Value, SdkError> {
        self.ensure_open()?;
        if length == 0 || length > 1024 * 1024 {
            return Err(SdkError::invalid(
                "API resource chunks require 1..=1048576 bytes",
            ));
        }
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| SdkError::new("ERR_NOT_LOADED", "no pack loaded"))?;
        let bytes = active.session.host_api_resource(context)?;
        if offset > bytes.len() {
            return Err(SdkError::invalid(
                "API resource offset exceeds the asset length",
            ));
        }
        let end = offset.saturating_add(length).min(bytes.len());
        Ok(json!({"bytes":&bytes[offset..end],"totalBytes":bytes.len()}))
    }

    pub fn dispatch_host_component_event(
        &mut self,
        event: HostComponentEvent,
    ) -> Result<(), SdkError> {
        self.ensure_open()?;
        let batch = self
            .active_mut()?
            .session
            .dispatch_host_component_event(event)?;
        self.observe_batch(&batch)?;
        self.finish_operation()
    }

    pub fn set_foreground(&mut self, visible: bool) -> Result<(), SdkError> {
        self.ensure_open()?;
        let active = self.active_mut()?;
        if active.foreground == visible {
            return Ok(());
        }
        active.foreground = visible;
        active.dispatch(
            op::APP_LIFECYCLE,
            json!({"event":if visible {"show"} else {"hide"}}),
        )?;
        self.finish_operation()
    }

    pub fn navigate(&mut self, route: &str, query: Value, replace: bool) -> Result<(), SdkError> {
        self.ensure_open()?;
        if !query.is_object() {
            return Err(SdkError::invalid("query must be an object"));
        }
        let active = self.active_mut()?;
        active.pack.route(Some(route))?;
        active.dispatch(
            if replace {
                op::PAGE_REPLACE
            } else {
                op::PAGE_PUSH
            },
            json!({"path":route,"query":query}),
        )?;
        self.finish_operation()
    }
    pub fn back(&mut self) -> Result<(), SdkError> {
        self.ensure_open()?;
        let active = self.active_mut()?;
        if active.session.app_service().pages().len() <= 1 {
            return Err(SdkError::invalid("cannot pop the last page"));
        }
        active.dispatch(op::PAGE_POP, json!({}))?;
        self.finish_operation()
    }
    pub fn send_message(&mut self, payload: Value) -> Result<(), SdkError> {
        self.ensure_open()?;
        let batch = self.active_mut()?.session.send_host_message(payload)?;
        self.observe_batch(&batch)?;
        self.finish_operation()
    }
    pub fn complete_host_call(
        &mut self,
        call_id: &str,
        result: Result<Value, ProviderError>,
    ) -> Result<(), SdkError> {
        self.ensure_open()?;
        let batch = self
            .active_mut()?
            .session
            .complete_host_call(call_id, result)?;
        self.observe_batch(&batch)?;
        self.finish_operation()
    }
    pub fn input(&mut self, mut events: Vec<Value>) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.requires_dev_restart())
        {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "execution fault revoked presentation input; restart the session",
            ));
        }
        if self.preview_occluded
            || self.staged_chrome_pending
            || !self.chrome_geometry_matches()
            || !self.host_layout_ready()
        {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "preview is occluded or geometry is pending",
            ));
        }
        let active = self.active_mut()?;
        if !active.foreground {
            return Err(SdkError::new(
                "ERR_BACKGROUND",
                "input is disabled while hidden",
            ));
        }
        for event in &mut events {
            if matches!(
                event.get("type").and_then(Value::as_str),
                Some("keydown" | "keyup")
            ) && !event
                .get("target")
                .and_then(Value::as_str)
                .is_some_and(|target| !target.is_empty())
            {
                let root = active
                    .session
                    .renderer()
                    .last_frame()
                    .ok_or_else(|| {
                        SdkError::new("ERR_NO_FRAME", "keyboard input requires an accepted frame")
                    })?
                    .root
                    .id
                    .clone();
                let event = event
                    .as_object_mut()
                    .ok_or_else(|| SdkError::invalid("input event must be an object"))?;
                event.insert("target".into(), json!(root));
                event.insert("path".into(), json!([root]));
                event.entry("detail").or_insert(json!({}));
            }
        }
        active.dispatch(op::EVENT_BATCH, json!({"events":events}))?;
        self.finish_operation()
    }
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.atomic_host_layout() {
            return Err(SdkError::new(
                "ERR_UNSUPPORTED_CAPABILITY",
                "atomic layout requires a complete hostLayout; resize cannot bypass observation",
            ));
        }
        if width == 0 || height == 0 {
            return Err(SdkError::invalid("viewport dimensions must be positive"));
        }
        let previous = self.active_mut()?.session.config().host.clone();
        let result = self
            .active_mut()?
            .session
            .notify_viewport_resize(width, height);
        self.finish_window_update(previous, result)
    }
    pub fn pump(&mut self, now_ns: u64) -> Result<(), SdkError> {
        self.check_owner()?;
        self.poll_storage();
        if self.closed || self.closing.is_some() {
            return Ok(());
        }
        self.poll_account_switch()?;
        if self.identity_blocked() {
            return Ok(());
        }
        self.poll_host_layout_timeout(now_ns);
        let mut failure = None;
        if self.active.is_some() {
            let completions = self
                .http
                .as_ref()
                .map(|http| http.take_results())
                .unwrap_or_default();
            for completion in completions {
                if self.http_calls.remove(&completion.call_id) {
                    let result = self
                        .active_mut()?
                        .session
                        .complete_host_call(&completion.call_id, completion.result);
                    let result = result
                        .map_err(SdkError::from)
                        .and_then(|batch| self.observe_batch(&batch));
                    if let Err(error) = result {
                        if failure.is_none() {
                            failure = Some(error);
                        }
                    }
                }
            }
            let result = self
                .active_mut()?
                .session
                .poll_host_timeouts(now_ns)
                .map_err(SdkError::from)
                .and_then(|batch| self.observe_batch(&batch));
            if let Err(error) = result {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            let result = self
                .active_mut()?
                .session
                .poll_navigation_timeouts(now_ns)
                .map_err(SdkError::from)
                .and_then(|batch| self.observe_batch(&batch));
            if let Err(error) = result {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
            if self.active.as_ref().is_some_and(|a| a.foreground) {
                let batch = self.active_mut()?.session.poll_timers(now_ns);
                if let Err(error) = self.observe_batch(&batch) {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
            if let Err(error) = self.finish_operation() {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn update_window_metrics(&mut self, metrics: HostWindowMetrics) -> Result<(), SdkError> {
        self.ensure_open()?;
        if self.atomic_host_layout() {
            return Err(SdkError::new(
                "ERR_UNSUPPORTED_CAPABILITY",
                "atomic layout requires observeHostLayout followed by hostLayout",
            ));
        }
        metrics.validate().map_err(SdkError::invalid)?;
        self.observed_viewport = (metrics.window_width, metrics.window_height);
        self.observed_window_metrics = Some(metrics.clone());
        if self.staged_chrome_pending {
            if !self.chrome_geometry_matches() {
                return Ok(());
            }
            self.staged_chrome_pending = false;
        }
        if self.active.is_none() {
            self.config.host.window_width = metrics.window_width;
            self.config.host.window_height = metrics.window_height;
            self.config.host.display_metrics = Some(metrics.display);
            return Ok(());
        }
        let previous = self.active_mut()?.session.config().host.clone();
        let result = self.active_mut()?.session.notify_window_metrics(metrics);
        self.finish_window_update(previous, result)
    }
    fn finish_window_update(
        &mut self,
        previous: HostMetadata,
        result: Result<BridgeBatch, container_bridge::BridgeError>,
    ) -> Result<(), SdkError> {
        // Hooks execute after metrics commit. Read the authoritative runtime
        // observation even when user code fails after that commit.
        self.config.host = self.active_mut()?.session.config().host.clone();
        self.observed_viewport = (
            self.config.host.window_width,
            self.config.host.window_height,
        );
        let mut failure = result
            .map_err(SdkError::from)
            .and_then(|batch| self.observe_batch(&batch))
            .err();
        if self.config.host != previous {
            self.snapshot_cache = None;
            if let Err(error) = self.active_mut()?.render(true) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        if let Err(error) = self.finish_operation() {
            if failure.is_none() {
                failure = Some(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }
    pub fn begin_flush_storage(&mut self) -> Result<Value, SdkError> {
        self.ensure_open()?;
        self.queue_storage()?;
        if let Some(storage) = &self.storage {
            Ok(json!({"pending":true,"ticket":storage.begin_flush()?}))
        } else {
            Ok(json!({"pending":false}))
        }
    }
    pub fn begin_close(&mut self) -> Result<Value, SdkError> {
        self.check_owner()?;
        if self.closed {
            return Ok(json!({"pending":false,"status":"closed"}));
        }
        if let Some(ticket) = self.closing {
            return Ok(json!({"pending":true,"ticket":ticket}));
        }
        if self.surface.is_some() {
            return Err(SdkError::new(
                "ERR_SURFACE_ATTACHED",
                "detach the surface before close",
            ));
        }
        self.cancel_prepared_dev_attempts();
        let revoked = self.identity_blocked();
        if !revoked {
            self.cancel_active_navigation("SDK owner closing");
            let _ = self.unload_active_for_retirement();
        }
        self.queue_storage()?;
        if revoked {
            self.retire_revoked_active();
        }
        if !revoked {
            self.retire_active();
        }
        // The HTTP worker may still be dropping a live request/connection or
        // waiting for blocking DNS. Pump advances this barrier without joining
        // a running thread and keeps both storage and file leases meanwhile.
        self.closing = Some(0);
        if self
            .storage
            .as_ref()
            .is_none_or(|storage| storage.is_closing())
        {
            self.close_result = Some(
                self.storage
                    .as_ref()
                    .and_then(|s| s.last_error())
                    .map_or(Ok(()), Err),
            );
        }
        self.poll_storage();
        Ok(
            json!({"pending":!self.closed,"status":if self.closed {"closed"} else {"closing"},"ticket":self.closing}),
        )
    }

    pub fn flush_storage(&mut self) -> Result<(), SdkError> {
        self.check_owner()?;
        self.queue_storage()?;
        if let Some(storage) = &self.storage {
            storage.flush()?;
        }
        Ok(())
    }
    /// Explicit synchronous final barrier. UI bindings use command("close")
    /// to retire the runtime and observe persistence completion via pump.
    pub fn close(&mut self) -> Result<(), SdkError> {
        self.check_owner()?;
        if self.closed {
            return Ok(());
        }
        if self.surface.is_some() {
            return Err(SdkError::new(
                "ERR_SURFACE_ATTACHED",
                "detach the surface before close",
            ));
        }
        self.cancel_prepared_dev_attempts();
        let revoked = self.identity_blocked();
        let mut error = if revoked {
            None
        } else {
            self.cancel_active_navigation("SDK owner closed");
            self.unload_active_for_retirement().err()
        };
        if let Err(e) = self.queue_storage() {
            if error.is_none() {
                error = Some(e);
            }
        }
        if revoked {
            self.retire_revoked_active();
        } else {
            self.retire_active();
        }
        for http in &mut self.retired_http {
            http.wait_drained();
        }
        self.retired_http.clear();
        if let Some(storage) = &self.storage {
            if let Err(e) = storage.close() {
                if error.is_none() {
                    error = Some(e);
                }
            }
        }
        self.closed = true;
        self.closing = None;
        self.storage.take();
        self.managed_file_scope.take();
        self.push_event(json!({"type":"closed"}));
        error.map_or(Ok(()), Err)
    }

    pub fn state(&self) -> Result<Value, SdkError> {
        self.check_owner()?;
        let active = self.active.as_ref().filter(|_| !self.account_epoch_stale());
        let page = active
            .and_then(|a| a.session.app_service().pages().current())
            .map(|p| json!({"id":p.id.0,"route":p.path}));
        Ok(
            json!({"schemaVersion":1,"status":if self.closed {"closed"} else if self.closing.is_some(){"closing"}else if self.identity_blocked(){"identitySwitching"}else if active.is_some() {"ready"} else {"empty"},
            "sessionId":active.map(|a|a.session.config().session_id.as_str()),"generation":self.generation,"engine":self.config.engine,
            "page":page,"frameRevision":self.revision,"frameId":active.and_then(|a|a.session.view().last_frame_id),
            "foreground":active.is_some_and(|a|a.foreground),"storagePersistent":self.config.storage_key.is_some(),
            "surface":self.surface,"inputEnabled":!self.identity_blocked() && !self.preview_occluded && !self.staged_chrome_pending && self.chrome_geometry_matches() && self.host_layout_ready() && active.is_some_and(|a|a.foreground && !a.session.requires_dev_restart() && a.session.pending_navigation().is_none() && a.session.is_current_frame_presented()),
            "acceptedPackIdentity":self.accepted_pack_identity()?,"ownerId":self.sdk_owner_id.to_string(),
            "executionHealth":active.map(|a|a.session.execution_health()),
            "accountSwitch":self.account_switch_status(None)?,"accountEpoch":self.account_manager.as_ref().map(|m|m.account().map(|a|a.epoch.to_string())).transpose()?,
            "hostServicesState":self.config.host_services.as_ref().map(|s|json!({"application":s.application,"account":self.account_manager.as_ref().and_then(|m|m.account().ok()).unwrap_or_else(||s.account.clone())})),
            "viewExecutionMetrics":active.map(|a|a.session.view_execution_metrics()),
            "presentationEnabled":!self.preview_occluded && !self.staged_chrome_pending && self.chrome_geometry_matches() && self.host_layout_ready() && active.is_some_and(|a|a.foreground && !a.session.requires_dev_restart() && a.session.pending_navigation().is_none()),
            "pendingNavigation":active.and_then(|a|a.session.pending_navigation()),
            "hostSurface":self.host_layout_state.surface,"acceptedLayout":self.host_layout_state.accepted,"pendingHostLayout":self.host_layout_state.pending,
            "previewOccluded":self.preview_occluded,"hostChrome":self.host_chrome,"chrome":self.chrome_state()?,
            "chromeGeometryReady":!self.staged_chrome_pending && self.chrome_geometry_matches() && self.host_layout_ready(),
            "observedViewport":{"width":self.observed_viewport.0,"height":self.observed_viewport.1},
            "presentationRequired":active.is_some_and(|a|a.session.page_render_mode()!=container_render_skia::PageRenderMode::Raster),"viewport":{"width":self.config.host.window_width,"height":self.config.host.window_height}}),
        )
    }
    pub fn capabilities(&self) -> Result<Value, SdkError> {
        self.check_owner()?;
        let mut methods = NativeProvider.capabilities_for_host(&self.config.host);
        container_runtime::restrict_published_capabilities(&mut methods);
        Ok(
            json!({"schemaVersion":1,"sdkVersion":env!("CARGO_PKG_VERSION"),"protocolVersion":container_bridge::PROTOCOL_VERSION,
            "distributionProfile":container_runtime::distribution_identity().distribution_profile,
            "policySha256":container_runtime::distribution_identity().policy_sha256,
            "build":{"quickjs":engine_provider_compiled(EngineKind::Quickjs),"v8":engine_provider_compiled(EngineKind::V8),
            "skiaCpu":cfg!(feature="skia-backend"),"gles":cfg!(feature="skia-gpu-gles"),"metal":cfg!(all(feature="skia-gpu-metal",any(target_os="macos",target_os="ios")))},
            "runtime":{"renderer":self.active.as_ref().map(|a|a.session.renderer().backend_name()),"gpuSurface":self.active.as_ref().is_some_and(|a|a.session.renderer().has_gpu_surface())},
            "hostMethods":self.methods,"nativeApis":methods,"http":{"request":!container_runtime::is_restricted_showcase(),"uploadFile":false,"downloadFile":false,"webSocket":false,"maxConcurrent":MAX_HTTP_REQUESTS,"maxBodyBytes":8*1024*1024},
            "hostServices":{"protocolVersion":"1.0","enabled":self.config.host_services.is_some(),"registeredApis":self.config.host_services.as_ref().map(|s|&s.apis),"trustedContext":true,"events":true,"accountSwitch":true,"binaryHandles":true,"snapshotOwnerContext":"1.0","apiResourceChunks":"1.0","apiResourceChunkBytes":1048576,"apiResourceMaxBytes":container_runtime::HOST_API_RESOURCE_MAX_BYTES},
            "chrome":{"protocolVersion":"1.0","geometry":true,"inspectPack":!container_runtime::is_restricted_showcase(),"occlusion":true,"transactionalRestart":!container_runtime::is_restricted_showcase(),"atomicLayout":{"protocolVersion":"1.0","enabled":self.atomic_host_layout(),"initialLayout":true,"sdkObservationIdentity":true}},
            "diagnostics":{"retirementErrorOrigin":{"schemaVersion":1}},
            "storage":{"persistent":self.config.storage_key.is_some(),"losslessUndefined":true},"input":{"batch":true},"pack":{"directory":true,"remoteUrl":false,"devReload":{"protocolVersion":"1.0","inPlace":!container_runtime::is_restricted_showcase(),"restart":!container_runtime::is_restricted_showcase(),"attemptJournal":{"protocolVersion":"1.0","terminalRetention":64,"acceptedIdentity":true}}}}),
        )
    }
    pub fn take_events(&mut self) -> Vec<Value> {
        if let Err(error) = self.check_owner() {
            return vec![json!({"type":"error","error":error})];
        }
        if !self.closed && self.closing.is_none() {
            if let Err(error) = self.poll_account_switch() {
                self.push_event(json!({"type":"error","error":error}));
            }
        }
        self.events.drain(..).collect()
    }
    pub fn frame(&self) -> Result<Option<&RenderFrame>, SdkError> {
        self.check_owner()?;
        self.ensure_current_account_epoch()?;
        Ok(self
            .active
            .as_ref()
            .and_then(|a| a.session.renderer().last_frame()))
    }
    pub fn renderer(&self) -> Result<Option<&SkiaRenderer>, SdkError> {
        self.check_owner()?;
        self.ensure_current_account_epoch()?;
        Ok(self.active.as_ref().map(|a| a.session.renderer()))
    }
    pub fn renderer_mut(&mut self) -> Result<Option<&mut SkiaRenderer>, SdkError> {
        self.check_owner()?;
        self.ensure_current_account_epoch()?;
        Ok(self.active.as_mut().map(|a| a.session.renderer_mut()))
    }

    /// Attach a host-owned GPU context without replacing the accepted scene.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        self.active_mut()?
            .session
            .attach_gles_context()
            .map_err(|error| SdkError::new("ERR_RENDER", error))
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gl_context_with(
        &mut self,
        resolver: impl FnMut(&str) -> *const std::ffi::c_void,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        self.active_mut()?
            .session
            .attach_gl_context_with(resolver)
            .map_err(|error| SdkError::new("ERR_RENDER", error))
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn render_last_frame_to_gles_framebuffer(
        &mut self,
        framebuffer: u32,
        width: u32,
        height: u32,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        self.active_mut()?
            .session
            .render_last_frame_to_gles_framebuffer(framebuffer, width, height)
            .map_err(|error| SdkError::new("ERR_RENDER", error))
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn detach_gles_context(&mut self, abandon: bool) -> Result<(), SdkError> {
        self.check_owner()?;
        let session = &mut self.active_mut()?.session;
        if abandon {
            session.abandon_gles_context();
        } else {
            session.detach_gles_context();
        }
        Ok(())
    }

    /// # Safety
    /// Device and queue are live retained Metal objects from the same device.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const std::ffi::c_void,
        queue: *const std::ffi::c_void,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        unsafe {
            self.active_mut()?
                .session
                .attach_metal_context(device, queue)
        }
        .map_err(|error| SdkError::new("ERR_RENDER", error))
    }

    /// # Safety
    /// Texture belongs to the attached device and remains live through completion.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const std::ffi::c_void,
        width: u32,
        height: u32,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        unsafe {
            self.active_mut()?
                .session
                .render_last_frame_to_metal_texture(texture, width, height)
        }
        .map_err(|error| SdkError::new("ERR_RENDER", error))
    }

    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn detach_metal_context(&mut self) -> Result<(), SdkError> {
        self.check_owner()?;
        self.active_mut()?.session.detach_metal_context();
        Ok(())
    }
    pub fn frame_snapshot(&mut self) -> Result<Option<(u64, RenderSnapshot)>, SdkError> {
        Ok(self
            .frame_snapshot_shared()?
            .map(|(revision, snapshot)| (revision, (*snapshot).clone())))
    }

    /// Acquire immutable CPU pixels for this exact revision and physical size.
    /// Repeated acquisitions share storage; retained frames survive later draws
    /// and session shutdown without retaining the runtime or GPU context.
    pub fn frame_snapshot_shared(
        &mut self,
    ) -> Result<Option<(u64, Arc<RenderSnapshot>)>, SdkError> {
        self.check_owner()?;
        self.ensure_current_account_epoch()?;
        if self
            .active
            .as_ref()
            .is_none_or(|a| a.session.renderer().last_frame().is_none())
        {
            return Ok(None);
        }
        // Use the accepted target, not a second host-size × DPR conversion.
        // Fractional DPR and host chrome can otherwise request a different
        // snapshot size than the frame's actual renderer publication.
        let target = self
            .active
            .as_ref()
            .unwrap()
            .session
            .accepted_page_observation()
            .ok_or_else(|| SdkError::new("ERR_RENDER", "no accepted physical target"))?
            .target;
        let (width, height) = (target.width, target.height);
        if let Some((revision, w, h, snapshot)) = &self.snapshot_cache {
            if *revision == self.revision && *w == width && *h == height {
                self.render_diagnostics.snapshot(self.revision, None);
                return Ok(Some((*revision, snapshot.clone())));
            }
        }
        let started = std::time::Instant::now();
        let snapshot = Arc::new(
            self.active_mut()?
                .session
                .capture_render_snapshot_at_size(width, height)
                .map_err(|e| SdkError::new("ERR_RENDER", e))?,
        );
        self.snapshot_cache = Some((self.revision, width, height, snapshot.clone()));
        self.render_diagnostics.snapshot(
            self.revision,
            Some(started.elapsed().as_secs_f64() * 1000.0),
        );
        Ok(Some((self.revision, snapshot)))
    }
    pub fn attach_surface(&mut self, id: &str) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        if id.is_empty() {
            return Err(SdkError::invalid("surface id cannot be empty"));
        }
        if self.surface.is_some() {
            return Err(SdkError::new(
                "ERR_SURFACE_ATTACHED",
                "session already has an attached surface",
            ));
        }
        if self.active.is_none() {
            return Err(SdkError::new(
                "ERR_NOT_LOADED",
                "load a pack before attaching its surface",
            ));
        }
        self.surface = Some(id.to_owned());
        if self.active.as_ref().is_some_and(|active| {
            active.session.page_render_mode() != container_render_skia::PageRenderMode::Raster
        }) {
            // A recreated surface gets a new accepted revision. Receipts from
            // the previous surface cannot grant the new presenter authority.
            let rendered = self.active_mut()?.render(true);
            let finished = self.finish_operation();
            if let Err(error) = rendered.and(finished) {
                self.surface = None;
                return Err(error);
            }
        }
        Ok(())
    }
    /// A trusted host confirms the exact frame after successful presentation.
    /// Drawing/reading pixels alone does not complete this boundary. A receipt
    /// for a replaced pack or an older frame can never acknowledge newer work.
    pub fn acknowledge_presented(
        &mut self,
        generation: u64,
        revision: u64,
    ) -> Result<(), SdkError> {
        if self.atomic_host_layout() {
            return Err(SdkError::new(
                "ERR_UNSUPPORTED_CAPABILITY",
                "atomic presentation requires the complete accepted layout identity",
            ));
        }
        self.acknowledge_presented_inner(generation, revision)
    }

    fn acknowledge_presented_inner(
        &mut self,
        generation: u64,
        revision: u64,
    ) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        self.ensure_current_account_epoch()?;
        if self.preview_occluded
            || self.staged_chrome_pending
            || !self.chrome_geometry_matches()
            || !self.host_layout_ready()
            || self
                .active
                .as_ref()
                .is_some_and(|active| active.session.requires_dev_restart())
            || self.surface.is_none()
            || generation != self.generation
            || revision != self.revision
        {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "stale or unattached presentation receipt",
            ));
        }
        let active = self
            .active
            .as_ref()
            .ok_or_else(|| SdkError::new("ERR_CANCELLED", "no current page frame"))?;
        let runtime_revision = active.session.render_revision();
        let identity = (active.session.config().session_id.clone(), runtime_revision);
        if runtime_revision == 0 || self.observed_frame.as_ref() != Some(&identity) {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "presentation receipt has no matching accepted frame",
            ));
        }
        let result = self
            .active_mut()?
            .session
            .acknowledge_presentation(runtime_revision);
        let acknowledgement = match result {
            Ok(batch) => {
                self.render_diagnostics.acknowledged(generation, revision);
                self.observe_batch(&batch)
            }
            Err(error) => Err(error.into()),
        };
        // Ready callbacks can change data, enqueue I/O or fail after a committed
        // effect. Finish all native bookkeeping before returning the first error.
        let finish = self.finish_operation();
        let switched = self.poll_account_switch();
        acknowledgement.and(finish).and(switched)
    }

    pub fn detach_surface(&mut self, id: &str) -> Result<(), SdkError> {
        self.check_owner()?;
        match self.surface.as_deref() {
            None => Ok(()),
            Some(current) if current == id => {
                self.surface = None;
                if self.active.as_ref().is_some_and(|active| {
                    active.session.page_render_mode()
                        != container_render_skia::PageRenderMode::Raster
                }) {
                    let result = self
                        .active_mut()?
                        .session
                        .retire_page_presenter("sdk-surface-detached");
                    let retired = match result {
                        Ok(batch) => self.observe_batch(&batch),
                        Err(error) => Err(error.into()),
                    };
                    let finished = self.finish_operation_with_render(false);
                    let switched = self.poll_account_switch();
                    return retired.and(finished).and(switched);
                }
                self.poll_account_switch()
            }
            _ => Err(SdkError::invalid("surface identity mismatch")),
        }
    }

    pub fn command(&mut self, operation: &str, payload: Value) -> Result<Value, SdkError> {
        self.check_owner()?;
        if matches!(
            operation,
            "devState"
                | "clearDevStorage"
                | "classifyDevPack"
                | "applyDevPack"
                | "inspectPackChrome"
                | "authorizeInstalledPack"
                | "beginDevPackAttempt"
                | "queryDevPackAttempt"
                | "applyDevPackAttempt"
                | "cancelDevPackAttempt"
                | "registerHostMethod"
        ) {
            require_full_distribution()?;
        }
        if self.identity_blocked()
            && !matches!(
                operation,
                "state"
                    | "renderDiagnostics"
                    | "capabilities"
                    | "hostComponents"
                    | "managedFileScope"
                    | "pump"
                    | "takeEvents"
                    | "close"
                    | "switchAccount"
                    | "queryAccountSwitch"
                    | "cancelAccountSwitch"
                    | "retryAccountSwitch"
                    | "updateAccountSwitchLaunch"
                    | "acknowledgeAccountCleanup"
                    | "prepareAccountHostServiceSnapshots"
                    | "updateHostServiceSnapshots"
                    | "hostSurface"
                    | "observeHostLayout"
                    | "hostLayout"
                    | "presented"
                    | "detachSurface"
                    | "attachSurface"
            )
        {
            return Err(SdkError::new(
                "ERR_IDENTITY_SWITCHING",
                "business commands are blocked during account replacement",
            ));
        }
        match operation {
            "hostComponents" => {
                if self.identity_blocked() {
                    return Ok(json!([]));
                }
                return serde_json::to_value(
                    self.active
                        .as_ref()
                        .map(|active| active.session.host_component_snapshots())
                        .unwrap_or_default(),
                )
                .map_err(SdkError::invalid);
            }
            "managedFileScope" => {
                self.ensure_lifecycle_open()?;
                if self.identity_blocked()
                    && !self.account_switch.as_ref().is_some_and(|pending| {
                        pending.receipt.phase == AccountSwitchPhase::AwaitingPresentation
                    })
                {
                    return Err(SdkError::new(
                        "ERR_IDENTITY_SWITCHING",
                        "managed files require the new account owner to start",
                    ));
                }
                if self.managed_file_scope.is_none() {
                    self.managed_file_scope =
                        Some(managed_files::ManagedFileScope::open(&self.config)?);
                }
                return Ok(self
                    .managed_file_scope
                    .as_ref()
                    .unwrap()
                    .describe(&self.config));
            }
            "configureHostServices" => self.configure_host_services(
                serde_json::from_value(payload).map_err(SdkError::invalid)?,
            )?,
            "registerApiHandler" => self.register_api_handler(required_str(&payload, "name")?)?,
            "authorizeInstalledPack" => self.authorize_installed_pack(
                serde_json::from_value(payload).map_err(SdkError::invalid)?,
            )?,
            "migrateLegacyStorage" => {
                self.migrate_legacy_storage(required_str(&payload, "sourceKey")?)?
            }
            "deleteAccountData" => {
                self.ensure_open()?;
                let principal = required_str(&payload, "principalId")?;
                let count = self
                    .account_manager
                    .as_ref()
                    .ok_or_else(|| SdkError::invalid("host services not configured"))?
                    .delete_principal_data(principal)?;
                self.push_event(json!({"type":"accountDataDeleted","principalId":principal,"deletedScopes":count,"backendRevocationRequired":true}));
                return Ok(json!({"deletedScopes":count}));
            }
            "switchAccount" => {
                let account = serde_json::from_value(
                    payload
                        .get("account")
                        .cloned()
                        .ok_or_else(|| SdkError::invalid("switchAccount requires account"))?,
                )
                .map_err(SdkError::invalid)?;
                let launches =
                    serde_json::from_value(payload.get("launches").cloned().unwrap_or(json!({})))
                        .map_err(SdkError::invalid)?;
                return serde_json::to_value(self.switch_account(account, launches)?)
                    .map_err(SdkError::invalid);
            }
            "queryAccountSwitch" => {
                return serde_json::to_value(
                    self.account_switch_status(payload.get("operationId").and_then(Value::as_str))?,
                )
                .map_err(SdkError::invalid)
            }
            "cancelAccountSwitch" => {
                self.cancel_account_switch(required_str(&payload, "operationId")?)?
            }
            "retryAccountSwitch" => self.retry_account_switch(
                serde_json::from_value(payload.get("options").cloned().unwrap_or(json!({})))
                    .map_err(SdkError::invalid)?,
            )?,
            "updateAccountSwitchLaunch" => self.update_account_switch_launch(
                serde_json::from_value(payload.get("options").cloned().unwrap_or(json!({})))
                    .map_err(SdkError::invalid)?,
            )?,
            "acknowledgeAccountCleanup" => {
                self.acknowledge_account_cleanup(required_str(&payload, "operationId")?)?
            }
            "prepareAccountHostServiceSnapshots" => {
                self.ensure_lifecycle_open()?;
                self.poll_account_switch()?;
                let operation = required_str(&payload, "operationId")?;
                let pending = self
                    .account_switch
                    .as_ref()
                    .ok_or_else(|| SdkError::invalid("no account replacement is pending"))?;
                if pending.receipt.operation_id != operation || pending.cleanup_acknowledged {
                    return Err(SdkError::new(
                        "ERR_CANCELLED",
                        "snapshot preparation belongs to an inactive cleanup operation",
                    ));
                }
                let values: BTreeMap<String, Value> = serde_json::from_value(
                    payload
                        .get("values")
                        .cloned()
                        .ok_or_else(|| SdkError::invalid("fresh snapshots are required"))?,
                )
                .map_err(SdkError::invalid)?;
                let mut config = self
                    .config
                    .host_services
                    .clone()
                    .ok_or_else(|| SdkError::invalid("host services not configured"))?;
                config.sync_values.extend(values);
                container_runtime::validate_host_services_config(&config)?;
                self.config.host_services = Some(config);
            }
            "updateHostServiceSnapshots" => {
                let values: BTreeMap<String, Value> =
                    serde_json::from_value(payload.get("values").cloned().unwrap_or(json!({})))
                        .map_err(SdkError::invalid)?;
                self.ensure_lifecycle_open()?;
                self.ensure_current_account_epoch()?;
                if self.identity_blocked()
                    && !self.account_switch.as_ref().is_some_and(|pending| {
                        pending.receipt.phase == AccountSwitchPhase::AwaitingPresentation
                    })
                {
                    return Err(SdkError::new(
                        "ERR_IDENTITY_SWITCHING",
                        "live snapshots require the new account owner to start",
                    ));
                }
                if let Some(context) = payload.get("context") {
                    self.validate_native_snapshot_owner(context)?;
                }
                let mut config = self
                    .config
                    .host_services
                    .clone()
                    .ok_or_else(|| SdkError::invalid("host services not configured"))?;
                config.sync_values.extend(values.clone());
                container_runtime::validate_host_services_config(&config)?;
                if let Some(active) = self.active.as_mut() {
                    active.session.update_host_service_snapshots(values)?;
                }
                self.config.host_services = Some(config);
            }
            "hostApiEvent" => self.dispatch_host_api_event(
                serde_json::from_value(payload).map_err(SdkError::invalid)?,
            )?,
            "hostComponentFrame" => {
                self.ensure_open()?;
                let frame = serde_json::from_value(payload).map_err(SdkError::invalid)?;
                let accepted = self
                    .active_mut()?
                    .session
                    .submit_host_component_frame(frame)?;
                if accepted {
                    self.finish_operation()?;
                }
                return Ok(json!({"accepted":accepted,"revision":self.revision.to_string()}));
            }
            "hostComponentEvent" => self.dispatch_host_component_event(
                serde_json::from_value(payload).map_err(SdkError::invalid)?,
            )?,
            "authorizePhoneButton" => {
                self.ensure_open()?;
                let batch = self
                    .active_mut()?
                    .session
                    .authorize_phone_button(required_str(&payload, "nodeId")?)?;
                self.observe_batch(&batch)?;
                self.finish_operation()?;
            }
            "hostApiResource" => {
                // Native Value transports can encode their exact integer
                // numbers as JSON 1048576.0. Accept those within the fixed
                // resource bound; fractions, negative and unsafe values fail.
                fn resource_index<'de, D: serde::Deserializer<'de>>(
                    deserializer: D,
                ) -> Result<usize, D::Error> {
                    let value = Value::deserialize(deserializer)?;
                    container_runtime::host_wire_bounded_integer(
                        &value,
                        container_runtime::HOST_API_RESOURCE_MAX_BYTES,
                    )
                    .ok_or_else(|| {
                        serde::de::Error::custom(
                            "resource indices must be exact bounded nonnegative integers",
                        )
                    })
                }
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct ResourceChunkRequest {
                    context: HostApiCallContext,
                    #[serde(default, deserialize_with = "resource_index")]
                    offset: usize,
                    #[serde(deserialize_with = "resource_index")]
                    length: usize,
                }
                let request: ResourceChunkRequest =
                    serde_json::from_value(payload).map_err(SdkError::invalid)?;
                return self.host_api_resource_chunk(
                    &request.context,
                    request.offset,
                    request.length,
                );
            }
            "createHostBinary" => {
                self.ensure_open()?;
                let values = payload
                    .get("bytes")
                    .and_then(Value::as_array)
                    .ok_or_else(|| SdkError::invalid("createHostBinary requires a byte array"))?;
                if values.len() > 1024 * 1024 {
                    return Err(SdkError::invalid(
                        "binary transport chunks are limited to 1 MiB",
                    ));
                }
                let bytes = values
                    .iter()
                    .map(|byte| {
                        bounded_wire_integer(byte, 255, "binary byte").map(|byte| byte as u8)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                return serde_json::to_value(
                    self.active_mut()?.session.register_host_binary(bytes)?,
                )
                .map_err(SdkError::invalid);
            }
            "readHostBinary" => {
                self.ensure_open()?;
                let id = required_str(&payload, "id")?;
                let offset = payload
                    .get("offset")
                    .map(|value| bounded_wire_integer(value, 32 * 1024 * 1024, "binary offset"))
                    .transpose()?
                    .unwrap_or(0);
                let length = bounded_wire_integer(
                    payload
                        .get("length")
                        .ok_or_else(|| SdkError::invalid("readHostBinary requires length"))?,
                    1024 * 1024,
                    "binary length",
                )?;
                return Ok(json!(self
                    .active_mut()?
                    .session
                    .read_host_binary(id, offset, length)?));
            }
            "retainHostBinary" => {
                self.ensure_open()?;
                self.active_mut()?
                    .session
                    .retain_host_binary(required_str(&payload, "id")?)?;
            }
            "releaseHostBinary" => {
                self.ensure_open()?;
                self.active_mut()?
                    .session
                    .release_host_binary(required_str(&payload, "id")?)?;
            }
            "beginDevPackAttempt" => {
                return serde_json::to_value(self.begin_dev_pack_attempt(payload)?)
                    .map_err(SdkError::invalid)
            }
            "applyDevPackAttempt" => {
                return serde_json::to_value(self.apply_dev_pack_attempt(payload)?)
                    .map_err(SdkError::invalid)
            }
            "queryDevPackAttempt" => {
                return serde_json::to_value(self.query_dev_pack_attempt(
                    required_str(&payload, "ownerId")?,
                    required_str(&payload, "attemptId")?,
                )?)
                .map_err(SdkError::invalid)
            }
            "acceptedPackIdentity" => {
                return serde_json::to_value(self.accepted_pack_identity()?)
                    .map_err(SdkError::invalid)
            }
            "cancelDevPackAttempt" => {
                return serde_json::to_value(self.cancel_dev_pack_attempt(
                    required_str(&payload, "ownerId")?,
                    required_str(&payload, "attemptId")?,
                )?)
                .map_err(SdkError::invalid)
            }
            "hostSurface" => match required_str(&payload, "action")? {
                "attach" => {
                    return serde_json::to_value(self.begin_host_surface()?)
                        .map_err(SdkError::invalid)
                }
                "detach" => self.end_host_surface(&HostSurfaceIdentity {
                    owner_id: required_str(&payload, "ownerId")?.into(),
                    surface_generation: required_str(&payload, "surfaceGeneration")?.into(),
                })?,
                _ => {
                    return Err(SdkError::invalid(
                        "hostSurface action must be attach or detach",
                    ))
                }
            },
            "observeHostLayout" => {
                if payload.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
                    return Err(SdkError::new(
                        "ERR_PROTOCOL_VERSION",
                        "host layout observation schema must be 1",
                    ));
                }
                let identity = HostSurfaceIdentity {
                    owner_id: required_str(&payload, "ownerId")?.into(),
                    surface_generation: required_str(&payload, "surfaceGeneration")?.into(),
                };
                let metrics = serde_json::from_value(
                    payload
                        .get("windowMetrics")
                        .cloned()
                        .ok_or_else(|| SdkError::invalid("observation requires windowMetrics"))?,
                )
                .map_err(SdkError::invalid)?;
                return serde_json::to_value(self.observe_host_layout(identity, metrics)?)
                    .map_err(SdkError::invalid);
            }
            "hostLayout" => self
                .update_host_layout(serde_json::from_value(payload).map_err(SdkError::invalid)?)?,
            "completeNavigationLayout" => {
                let ticket = required_str(&payload, "ticket")?.to_owned();
                let layout =
                    serde_json::from_value(payload.get("layout").cloned().ok_or_else(|| {
                        SdkError::invalid("completeNavigationLayout requires layout")
                    })?)
                    .map_err(SdkError::invalid)?;
                self.complete_navigation_host_layout(&ticket, layout)?;
            }
            "cancelNavigation" => {
                self.ensure_open()?;
                let ticket = required_str(&payload, "ticket")?.to_owned();
                let batch = self.active_mut()?.session.cancel_navigation(
                    &ticket,
                    container_bridge::BridgeErrorCode::Cancelled,
                    "host cancelled navigation",
                )?;
                self.observe_batch(&batch)?;
                self.finish_operation()?;
            }
            "load" => {
                let path = required_str(&payload, "packPath")?;
                let options = LoadOptions {
                    initial_host_layout: payload
                        .get("initialHostLayout")
                        .map(|value| {
                            serde_json::from_value(value.clone()).map_err(SdkError::invalid)
                        })
                        .transpose()?,
                    initial_host_chrome: payload
                        .get("initialHostChrome")
                        .map(|value| {
                            serde_json::from_value(value.clone()).map_err(SdkError::invalid)
                        })
                        .transpose()?,
                    route: payload
                        .get("route")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    options: payload
                        .get("options")
                        .map(|v| {
                            v.as_object()
                                .cloned()
                                .ok_or_else(|| SdkError::invalid("options must be an object"))
                        })
                        .transpose()?
                        .unwrap_or_default(),
                };
                self.load(PackSource::Directory(path.into()), options)?;
            }
            "classifyDevPack" => {
                let path = required_str(&payload, "packPath")?;
                return Ok(
                    json!({"reloadKind":self.classify_dev_pack(PackSource::Directory(path.into()))?}),
                );
            }
            "applyDevPack" => {
                let path = required_str(&payload, "packPath")?;
                let options = LoadOptions {
                    initial_host_layout: payload
                        .get("initialHostLayout")
                        .map(|value| {
                            serde_json::from_value(value.clone()).map_err(SdkError::invalid)
                        })
                        .transpose()?,
                    initial_host_chrome: payload
                        .get("initialHostChrome")
                        .map(|value| {
                            serde_json::from_value(value.clone()).map_err(SdkError::invalid)
                        })
                        .transpose()?,
                    route: payload
                        .get("route")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    options: payload
                        .get("options")
                        .map(|value| {
                            value
                                .as_object()
                                .cloned()
                                .ok_or_else(|| SdkError::invalid("options must be an object"))
                        })
                        .transpose()?
                        .unwrap_or_default(),
                };
                return serde_json::to_value(
                    self.apply_dev_pack(PackSource::Directory(path.into()), options)?,
                )
                .map_err(SdkError::invalid);
            }
            "inspectPackChrome" => {
                let path = required_str(&payload, "packPath")?;
                return self.inspect_pack_chrome(
                    PackSource::Directory(path.into()),
                    payload.get("route").and_then(Value::as_str),
                );
            }
            "hostChrome" => self
                .update_host_chrome(serde_json::from_value(payload).map_err(SdkError::invalid)?)?,
            "setPreviewOccluded" => self.set_preview_occluded(
                payload
                    .get("occluded")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| SdkError::invalid("occluded must be boolean"))?,
            )?,
            "switchTab" => {
                let route = required_str(&payload, "route")?;
                let active = self.active_mut()?;
                active.pack.route(Some(route))?;
                active.dispatch(op::API_CALL, json!({"name":"wx.switchTab", "url":route}))?;
                self.finish_operation()?;
            }
            "clearDevStorage" => {
                self.ensure_open()?;
                self.active_mut()?.session.app_service_mut().clear_storage();
                self.queue_storage()?;
            }
            "devState" => {
                self.ensure_open()?;
                let pages = self
                    .active
                    .as_ref()
                    .map(|active| {
                        active
                            .session
                            .app_service()
                            .pages()
                            .iter()
                            .map(|page| json!({"id":page.id.0,"route":page.path,"data":page.data}))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                return Ok(json!({"state":self.state()?,"pages":pages}));
            }
            "lifecycle" => {
                let event = required_str(&payload, "event")?;
                match event {
                    "show" => self.set_foreground(true)?,
                    "hide" => self.set_foreground(false)?,
                    _ => return Err(SdkError::invalid("lifecycle event must be show or hide")),
                }
            }
            "navigate" => self.navigate(
                required_str(&payload, "route")?,
                payload.get("query").cloned().unwrap_or(json!({})),
                payload
                    .get("replace")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )?,
            "back" => self.back()?,
            "sendMessage" => {
                self.send_message(payload.get("message").cloned().unwrap_or(Value::Null))?
            }
            "registerHostMethod" => self.register_host_method(required_str(&payload, "name")?)?,
            "completeHostCall" => {
                let result = if let Some(error) = payload.get("error") {
                    Err(serde_json::from_value(error.clone()).map_err(SdkError::invalid)?)
                } else {
                    Ok(payload.get("result").cloned().unwrap_or(Value::Null))
                };
                self.complete_host_api_call(required_str(&payload, "callId")?, result)?;
            }
            "presented" => {
                self.validate_presentation_layout(&payload)?;
                self.acknowledge_presented_inner(
                    payload
                        .get("generation")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| SdkError::invalid("presented requires generation"))?,
                    payload
                        .get("revision")
                        .and_then(Value::as_u64)
                        .ok_or_else(|| SdkError::invalid("presented requires revision"))?,
                )?;
            }
            "pump" => self.pump(
                payload
                    .get("nowNs")
                    .and_then(Value::as_u64)
                    .unwrap_or_else(clock_now_ns),
            )?,
            "flushStorage" => return self.begin_flush_storage(),
            "close" => return self.begin_close(),
            "takeEvents" => return Ok(json!(self.take_events())),
            "state" => return self.state(),
            "renderDiagnostics" => return Ok(self.render_diagnostics.report()),
            "capabilities" => return self.capabilities(),
            "input" => self.input(
                payload
                    .get("events")
                    .and_then(Value::as_array)
                    .cloned()
                    .ok_or_else(|| SdkError::invalid("input requires events array"))?,
            )?,
            "resize" => self.resize(
                required_u32(&payload, "width")?,
                required_u32(&payload, "height")?,
            )?,
            "windowMetrics" => {
                if self.atomic_host_layout() {
                    return Err(SdkError::new(
                        "ERR_UNSUPPORTED_CAPABILITY",
                        "atomic layout requires observeHostLayout followed by hostLayout",
                    ));
                }
                self.update_window_metrics(
                    serde_json::from_value(payload).map_err(SdkError::invalid)?,
                )?;
            }
            _ => {
                return Err(SdkError::invalid(format!(
                    "unknown SDK command: {operation}"
                )))
            }
        }
        self.state()
    }

    fn check_owner(&self) -> Result<(), SdkError> {
        if self.owner == thread::current().id() {
            Ok(())
        } else {
            Err(SdkError::new(
                "ERR_WRONG_THREAD",
                "session must remain on its creating thread",
            ))
        }
    }
    fn ensure_open(&self) -> Result<(), SdkError> {
        self.ensure_lifecycle_open()?;
        if self.identity_blocked() && !self.identity_rebuilding {
            return Err(SdkError::new("ERR_IDENTITY_SWITCHING", "host account changed; this controller is blocked until its new identity is presented"));
        }
        Ok(())
    }
    fn ensure_lifecycle_open(&self) -> Result<(), SdkError> {
        self.check_owner()?;
        if self.closed || self.closing.is_some() {
            Err(SdkError::new("ERR_CLOSED", "session is closing or closed"))
        } else {
            Ok(())
        }
    }
    fn ensure_current_account_epoch(&self) -> Result<(), SdkError> {
        if self.account_epoch_stale() {
            Err(SdkError::new(
                "ERR_IDENTITY_SWITCHING",
                "revoked account cannot render or accept native work",
            ))
        } else {
            Ok(())
        }
    }
    /// Native refreshes are not pending guest API calls. They freeze their
    /// trusted owner before starting asynchronous work, and may only publish
    /// into that exact accepted application/account/session incarnation.
    fn validate_native_snapshot_owner(&self, context: &Value) -> Result<(), SdkError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct SnapshotOwner {
            application: TrustedApplication,
            account: HostAccount,
            session_id: String,
        }
        // Full API contexts may carry extra call metadata. Those fields neither
        // authorize this update nor require a still-pending guest call.
        let expected: SnapshotOwner =
            serde_json::from_value(context.clone()).map_err(SdkError::invalid)?;
        let services = self
            .config
            .host_services
            .as_ref()
            .ok_or_else(|| SdkError::invalid("host services not configured"))?;
        let active = self.active.as_ref().ok_or_else(|| {
            SdkError::new("ERR_NOT_LOADED", "native snapshot owner is not loaded")
        })?;
        if expected.application != services.application
            || expected.account != services.account
            || expected.session_id != active.session.config().session_id
            || expected.application.pack_root != active.pack.manifest.integrity.root
        {
            return Err(SdkError::new(
                "ERR_CANCELLED",
                "native snapshot belongs to a retired application, account or session",
            ));
        }
        Ok(())
    }
    fn active_mut(&mut self) -> Result<&mut Active, SdkError> {
        self.active
            .as_mut()
            .ok_or_else(|| SdkError::new("ERR_NOT_LOADED", "no pack loaded"))
    }
    fn push_event(&mut self, event: Value) {
        if self.events.len() >= MAX_EVENTS {
            self.events.pop_front();
            if let Some(front) = self.events.front_mut() {
                *front = json!({"type":"error","error":{"code":"ERR_EVENT_OVERFLOW","message":"SDK event queue overflow; consume events regularly"}});
            }
        }
        self.events.push_back(event);
    }
    fn observe_batch(&mut self, batch: &BridgeBatch) -> Result<(), SdkError> {
        for event in console_events(batch) {
            self.push_event(event);
        }
        for message in &batch.messages {
            if message.op == op::ERROR {
                self.push_event(json!({"type":"error","error":message.payload}));
            }
        }
        validate_batch(batch)
    }
    fn finish_operation(&mut self) -> Result<(), SdkError> {
        self.finish_operation_with_render(true)
    }
    fn finish_operation_with_render(&mut self, render: bool) -> Result<(), SdkError> {
        let mut failure = None;
        let layout_ready = self.host_layout_ready();
        if let Some(active) = self.active.as_mut() {
            if render
                && active.foreground
                && !self.preview_occluded
                && layout_ready
                && !active.session.requires_dev_restart()
                && active.session.pending_navigation().is_none()
            {
                if let Err(error) = active.render(false) {
                    failure = Some(error);
                }
            }
        }
        let console = self
            .active
            .as_mut()
            .map(|active| std::mem::take(&mut active.pending_console))
            .unwrap_or_default();
        for event in console {
            self.push_event(event);
        }
        let health = self.active.as_ref().map(|active| {
            serde_json::to_value(active.session.execution_health()).expect("execution health JSON")
        });
        if health != self.observed_execution_health {
            self.observed_execution_health = health.clone();
            self.push_event(json!({"type":"executionHealth","schemaVersion":1,"sessionId":self.active.as_ref().map(|a|a.session.config().session_id.as_str()),"generation":self.generation,"health":health}));
        }
        let pending_navigation = self
            .active
            .as_ref()
            .and_then(|active| active.session.pending_navigation())
            .map(|request| serde_json::to_value(request).expect("navigation layout JSON"));
        if pending_navigation != self.observed_pending_navigation {
            self.observed_pending_navigation = pending_navigation.clone();
            self.push_event(json!({"type":"navigationLayout", "request":pending_navigation}));
        }
        let navigation = self.active.as_ref().map(|a| {
            (
                a.session.config().session_id.clone(),
                a.session
                    .app_service()
                    .pages()
                    .iter()
                    .map(|p| (p.id.0, p.path.clone()))
                    .collect::<Vec<_>>(),
            )
        });
        if navigation != self.observed_navigation {
            self.observed_navigation = navigation;
            if let Some((session_id, stack)) = &self.observed_navigation {
                let pages: Vec<_> = stack
                    .iter()
                    .map(|(id, route)| json!({"id":id,"route":route}))
                    .collect();
                self.push_event(json!({"type":"navigation","sessionId":session_id,"page":pages.last(),"stack":pages}));
            }
        }
        let chrome = self
            .active
            .as_ref()
            .map(|active| active.session.page_chrome())
            .transpose()?
            .flatten();
        let observed = chrome.map(|value| serde_json::to_value(value).expect("chrome JSON"));
        if observed != self.observed_chrome {
            self.observed_chrome = observed;
            self.chrome_revision = self
                .chrome_revision
                .checked_add(1)
                .ok_or_else(|| SdkError::invalid("chrome revision exhausted"))?;
            self.push_event(
                json!({"type":"chrome","chrome":self.chrome_state()?,"generation":self.generation}),
            );
        }
        let identity = self.active.as_ref().and_then(|a| {
            a.session.view().last_frame_id.map(|_| {
                (
                    a.session.config().session_id.clone(),
                    a.session.renderer().snapshot_revision(),
                )
            })
        });
        if identity != self.observed_frame {
            self.observed_frame = identity;
            self.snapshot_cache = None;
            self.revision = self
                .revision
                .checked_add(1)
                .ok_or_else(|| SdkError::new("ERR_RENDER", "frame revision exhausted"))?;
            if let Some(active) = self.active.as_ref() {
                let status = active.session.page_render_status();
                let observation = active.session.accepted_page_observation();
                self.render_diagnostics.accepted(self.generation, self.revision, json!({
                    "backend":status.backend,"mode":status.mode,"gpuSurface":status.gpu_surface,
                    "prepareMs":status.last_render_ms,
                    "logicalWidth":observation.map(|value|value.frame.viewport.width),
                    "logicalHeight":observation.map(|value|value.frame.viewport.height),
                    "physicalWidth":observation.map(|value|value.target.width),
                    "physicalHeight":observation.map(|value|value.target.height),
                    "pixelRatio":self.config.host.display_metrics.as_ref().map_or(1.0,|value|value.pixel_ratio),
                }));
            }
            self.push_event(json!({"type":"frame","revision":self.revision,"frameId":self.active.as_ref().and_then(|a|a.session.view().last_frame_id)}));
        }
        if let Err(error) = self.queue_storage() {
            if failure.is_none() {
                failure = Some(error);
            }
        }
        if let Err(error) = self.dispatch_effects() {
            if failure.is_none() {
                failure = Some(error);
            }
        }
        if let Some(error) = failure {
            self.push_event(json!({"type":"error","error":error}));
            Err(error)
        } else {
            Ok(())
        }
    }
    fn queue_storage(&mut self) -> Result<(), SdkError> {
        if let (Some(storage), Some(active)) = (&self.storage, &mut self.active) {
            let stamp = active.session.storage_stamp();
            if active.stored_stamp.as_ref() != Some(&stamp) {
                storage.queue(active.session.storage_snapshot())?;
                active.stored_stamp = Some(stamp);
            }
        }
        Ok(())
    }
    fn poll_storage(&mut self) {
        self.poll_http_retirement();
        // Storage closing releases its lock on its worker, so do not even
        // start that close until every retired network executor has exited.
        if self.closing.is_some() && self.http.is_none() && self.retired_http.is_empty() {
            self.managed_file_scope.take();
            if let Some(storage) = &self.storage {
                if !storage.is_closing() {
                    match storage.begin_close() {
                        Ok(ticket) => self.closing = Some(ticket),
                        Err(error) => self.close_result = Some(Err(error.message)),
                    }
                }
            }
        }
        let events = self
            .storage
            .as_ref()
            .map(|s| s.take_events())
            .unwrap_or_default();
        for event in events {
            // A close begun during account retirement awaits the existing writer
            // instead of issuing a second barrier. Its late failures still own
            // the close result, including unticketed writes.
            if self.closing == Some(0) {
                if let Err(error) = &event.result {
                    self.close_result = Some(Err(error.clone()));
                }
            }
            if let Some(pending) = self.account_switch.as_mut() {
                if let Err(error) = &event.result {
                    pending.storage_error = Some(error.clone());
                }
            }
            if event.ticket == self.closing && self.closing.is_some() {
                self.close_result = Some(event.result);
            } else if let Some(ticket) = event.ticket {
                self.push_event(json!({"type":"storageFlushed","ticket":ticket,"ok":event.result.is_ok(),"error":event.result.err().map(SdkError::storage)}));
            } else if let Err(error) = event.result {
                self.push_event(json!({"type":"error","error":SdkError::storage(error)}));
            }
        }
        if self.closing.is_some()
            && self.close_result.is_some()
            && self.http.is_none()
            && self.retired_http.is_empty()
            && self.storage.as_ref().is_none_or(|s| s.is_released())
        {
            let result = self.close_result.take().unwrap();
            self.storage.take();
            self.closing = None;
            self.closed = true;
            self.push_event(json!({"type":"closed","ok":result.is_ok(),"error":result.err().map(SdkError::storage)}));
        }
    }
    fn dispatch_effects(&mut self) -> Result<(), SdkError> {
        let requests = self
            .active
            .as_mut()
            .map(|a| a.session.take_host_requests())
            .unwrap_or_default();
        let mut failure = None;
        for request in requests {
            // The entire outbox has already been drained. A failed user
            // continuation must not discard later host work or cancellations.
            if let Err(error) = self.dispatch_effect(request) {
                if failure.is_none() {
                    failure = Some(error);
                }
            }
        }
        failure.map_or(Ok(()), Err)
    }
    fn dispatch_effect(&mut self, request: HostRequest) -> Result<(), SdkError> {
        match request {
            HostRequest::Call {
                call_id,
                method,
                payload,
                deadline_ns,
                cancel_token,
                context,
            } => {
                if context.is_some() && method == "weappContainer.identity.logout" {
                    self.pending_host_apis
                        .insert(call_id.clone(), (method.clone(), deadline_ns));
                }
                if method == "wx.request"
                    && !self
                        .config
                        .host_services
                        .as_ref()
                        .is_some_and(|config| config.apis.contains(&method))
                {
                    if self.http_calls.len() >= MAX_HTTP_REQUESTS {
                        let batch = self.active_mut()?.session.complete_host_call(
                            &call_id,
                            Err(ProviderError::invalid("HTTP concurrency limit exceeded")),
                        )?;
                        self.observe_batch(&batch)?;
                    } else {
                        match self
                            .http
                            .as_ref()
                            .ok_or_else(|| SdkError::new("ERR_NETWORK", "HTTP owner is retired"))
                            .and_then(|http| http.start(call_id.clone(), payload, deadline_ns))
                        {
                            Ok(()) => {
                                self.http_calls.insert(call_id);
                            }
                            Err(error) => {
                                let batch = self.active_mut()?.session.complete_host_call(
                                    &call_id,
                                    Err(ProviderError::invalid(error.message)),
                                )?;
                                self.observe_batch(&batch)?;
                            }
                        }
                    }
                } else {
                    let retain =
                        container_runtime::host_api_descriptor(&method).is_some_and(|descriptor| {
                            matches!(descriptor.kind.as_str(), "object" | "task")
                                || (descriptor.kind == "subscription"
                                    && descriptor
                                        .name
                                        .rsplit('.')
                                        .next()
                                        .is_some_and(|name| name.starts_with("on")))
                        });
                    self.push_event(json!({"type":"hostCall","callId":call_id,"method":method,"payload":payload,"deadlineNs":deadline_ns.map(|deadline|deadline.to_string()),"cancelToken":cancel_token,"context":context,"retainUntilCancelled":retain}));
                }
            }
            HostRequest::Message { payload } => {
                self.push_event(json!({"type":"message","message":payload}))
            }
            HostRequest::Cancel { call_id } => {
                self.pending_host_apis.remove(&call_id);
                if let Some(http) = &self.http {
                    http.cancel(&call_id);
                }
                self.http_calls.remove(&call_id);
                self.push_event(json!({"type":"hostCallCancelled","callId":call_id}));
            }
        }
        Ok(())
    }
    fn retire_revoked_active(&mut self) {
        if let Some(mut active) = self.active.take() {
            for request in active.session.revoke_host_services() {
                if let HostRequest::Cancel { call_id } = request {
                    self.push_event(json!({"type":"hostCallCancelled","callId":call_id,"reason":"account_revoked"}));
                }
            }
        }
        self.pending_host_apis.clear();
        self.begin_http_retirement();
    }
    fn retire_active(&mut self) {
        self.pending_host_apis.clear();
        // Freeze provenance before taking the runtime. Event consumers can
        // drain these errors after a replacement has already become active.
        let identity = self.accepted_pack_metadata();
        if let Some(mut active) = self.active.take() {
            if active.session.execution_fault().is_some() {
                for request in active.session.revoke_host_services() {
                    if let HostRequest::Cancel { call_id } = request {
                        self.push_event(json!({"type":"hostCallCancelled","callId":call_id,"reason":"execution_fault"}));
                    }
                }
                self.begin_http_retirement();
                return;
            }
            let navigation = active
                .session
                .cancel_all_navigation("SDK runtime retired")
                .map_err(SdkError::from);
            self.observe_retirement_result(
                navigation,
                identity.as_ref(),
                retirement::RetirementOperation::CancelNavigation,
            );
            let host_calls = active.session.cancel_host_calls().map_err(SdkError::from);
            self.observe_retirement_result(
                host_calls,
                identity.as_ref(),
                retirement::RetirementOperation::CancelHostCalls,
            );
            for request in active.session.take_host_requests() {
                if let HostRequest::Cancel { call_id } = request {
                    self.push_event(json!({"type":"hostCallCancelled","callId":call_id}));
                }
            }
        }
        self.begin_http_retirement();
    }

    fn begin_http_retirement(&mut self) {
        self.http_calls.clear();
        if let Some(mut http) = self.http.take() {
            http.begin_shutdown();
            if !http.poll_drained() {
                self.retired_http.push(http);
            }
        }
        self.poll_http_retirement();
    }
    fn poll_http_retirement(&mut self) -> bool {
        self.retired_http.retain_mut(|http| !http.poll_drained());
        self.http.is_none() && self.retired_http.is_empty()
    }

    fn cancel_active_navigation(&mut self, reason: &str) {
        if self
            .active
            .as_ref()
            .is_some_and(|active| active.session.execution_fault().is_some())
        {
            return;
        }
        let identity = self.accepted_pack_metadata();
        let cancelled = self
            .active
            .as_mut()
            .map(|active| active.session.cancel_all_navigation(reason));
        if let Some(result) = cancelled {
            self.observe_retirement_result(
                result.map_err(SdkError::from),
                identity.as_ref(),
                retirement::RetirementOperation::CancelNavigation,
            );
        }
    }
}

impl Drop for ContainerSession {
    fn drop(&mut self) {
        if self.identity_blocked() {
            self.retire_revoked_active();
        } else {
            self.retire_active();
        }
        if !self.retired_http.is_empty() {
            let leases = std::sync::Arc::new((self.storage.take(), self.managed_file_scope.take()));
            for http in &mut self.retired_http {
                http.retain_until_drained(leases.clone());
            }
        }
    }
}

// The engine produces only bounded strings using captured intrinsics. Do not
// forward arbitrary API payloads or AppService state into device diagnostics.
fn console_events(batch: &BridgeBatch) -> Vec<Value> {
    let mut result = Vec::new();
    for message in &batch.messages {
        if message.op != op::EVENT_BATCH {
            continue;
        }
        let Some(effects) = message.payload.get("effects").and_then(Value::as_array) else {
            continue;
        };
        for effect in effects {
            let Some(console) = effect.get("console") else {
                continue;
            };
            if let Some(entries) = console.get("entries").and_then(Value::as_array) {
                for entry in entries.iter().take(128) {
                    if result.len() >= MAX_EVENTS - 1 {
                        result.push(json!({"type":"console","sessionId":message.session_id,"level":"warn","message":"Additional console batches dropped by SDK diagnostic budget"}));
                        return result;
                    }
                    if let (Some(level), Some(text)) = (
                        entry.get("level").and_then(Value::as_str),
                        entry.get("message").and_then(Value::as_str),
                    ) {
                        result.push(json!({"type":"console","sessionId":message.session_id,"level":level,"message":text}));
                    }
                }
            }
            if let Some(dropped) = console
                .get("dropped")
                .and_then(Value::as_u64)
                .filter(|count| *count > 0)
            {
                result.push(json!({"type":"console","sessionId":message.session_id,"level":"warn","message":format!("{dropped} console messages dropped by diagnostic budget")}));
            }
        }
    }
    result
}

fn validate_batch(batch: &BridgeBatch) -> Result<(), SdkError> {
    for message in &batch.messages {
        if message.op == op::ERROR
            || (message.kind == EnvelopeKind::Response
                && message.payload.get("ok") == Some(&Value::Bool(false)))
        {
            let error = message
                .payload
                .get("error")
                .or_else(|| {
                    message
                        .payload
                        .get("errors")
                        .and_then(Value::as_array)
                        .and_then(|errors| errors.first())
                })
                .unwrap_or(&message.payload);
            return Err(SdkError::new(
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .unwrap_or("ERR_ENGINE"),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("runtime operation failed"),
            ));
        }
    }
    Ok(())
}
fn bounded_wire_integer(value: &Value, maximum: usize, name: &str) -> Result<usize, SdkError> {
    container_runtime::host_wire_bounded_integer(value, maximum).ok_or_else(|| {
        SdkError::invalid(format!(
            "{name} must be an exact nonnegative integer at most {maximum}"
        ))
    })
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str, SdkError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| SdkError::invalid(format!("{key} must be a string")))
}
fn required_u32(value: &Value, key: &str) -> Result<u32, SdkError> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| SdkError::invalid(format!("{key} must be a UInt32")))
}
pub fn clock_now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
        .min(u64::MAX as u128) as u64
}

#[cfg(all(test, feature = "quickjs-native"))]
mod tests;

#[cfg(all(test, feature = "quickjs-native"))]
mod storage_stamp_tests {
    use super::*;
    use container_core::MemoryStorage;

    #[test]
    fn persistence_queues_replacement_store_with_equal_numeric_revision() {
        let directory = tempfile::tempdir().unwrap();
        let key = "replacement-store";
        let config = ContainerConfig {
            storage_root: Some(directory.path().into()),
            storage_key: Some(key.into()),
            ..ContainerConfig::default()
        };
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../examples/hosts/ios/Sources/WeappContainerSmoke/Resources/portable-pack");
        let mut sdk = ContainerSession::new(config.clone()).unwrap();
        sdk.load(
            PackSource::Directory(fixture.clone()),
            LoadOptions::default(),
        )
        .unwrap();

        let mut first = MemoryStorage::default();
        first.set("value", json!("first")).unwrap();
        first.set("typed", Value::Null).unwrap();
        let revision = first.revision();
        let first_stamp = first.stamp();
        *sdk.active
            .as_mut()
            .unwrap()
            .session
            .app_service_mut()
            .storage_mut() = first;
        sdk.flush_storage().unwrap();
        let path = directory
            .path()
            .join(format!("{}.json", container_ir::hex_digest(key.as_bytes())));
        let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["values"]["value"], "first");
        assert_eq!(persisted["undefinedKeys"], json!([]));

        let mut replacement = MemoryStorage::default();
        replacement.set("value", json!("replacement")).unwrap();
        replacement.set_undefined("typed").unwrap();
        assert_eq!(replacement.revision(), revision);
        assert_ne!(replacement.stamp(), first_stamp);
        let expected = replacement.snapshot_state();
        *sdk.active
            .as_mut()
            .unwrap()
            .session
            .app_service_mut()
            .storage_mut() = replacement;
        assert_eq!(
            sdk.active.as_ref().unwrap().session.storage_revision(),
            revision
        );
        sdk.flush_storage().unwrap();
        let persisted: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            persisted,
            json!({"values":{"typed":null,"value":"replacement"},"undefinedKeys":["typed"]})
        );
        sdk.close().unwrap();

        let mut reopened = ContainerSession::new(config).unwrap();
        reopened
            .load(PackSource::Directory(fixture), LoadOptions::default())
            .unwrap();
        assert_eq!(
            reopened.active.as_ref().unwrap().session.storage_snapshot(),
            expected
        );
        reopened.close().unwrap();
    }
}

#[cfg(test)]
mod log_manager_consumer_tests {
    use super::*;
    #[test]
    fn log_manager_near_100kib_record_reaches_actual_sdk_consumer_unchanged() {
        let text = "x".repeat(100000);
        let record = json!({"version":1,"source":"logManager","level":"info","kind":"explicit","name":"LogManager.info","arguments":{"roots":[0],"nodes":[{"type":"string","value":text}]}});
        let message = record.to_string();
        let batch = BridgeBatch::new(vec![BridgeEnvelope::event(
            "log-manager",
            op::EVENT_BATCH,
            json!({"source":"quickjs","effects":[{"console":{"source":"logManager","entries":[{"level":"info","message":message}]}}]}),
        )]);
        let events = console_events(&batch);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["level"], "info");
        assert_eq!(events[0]["message"], message);
        let decoded: Value = serde_json::from_str(events[0]["message"].as_str().unwrap()).unwrap();
        assert_eq!(
            decoded["arguments"]["nodes"][0]["value"]
                .as_str()
                .unwrap()
                .len(),
            100000
        );
        assert_eq!(decoded, record);
    }
}
