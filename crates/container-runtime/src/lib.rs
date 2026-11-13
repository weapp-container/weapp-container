//! A host-independent session runtime for portable WeChat mini-program builds.
//!
//! `Session` is the boundary between a host adapter and the three runtime
//! layers: AppService (the core lifecycle/page/data state), View (batched
//! invalidations), and Renderer (a deterministic software renderer by default).
//! Hosts exchange only [`container_bridge::BridgeEnvelope`] values, so the same
//! session can be driven from Web, desktop, JNI, Swift, or ArkTS bindings.

use container_bridge::{
    negotiate_protocol, op, BridgeBatch, BridgeEnvelope, BridgeError, BridgeErrorCode,
    CancellationRegistry, EnvelopeKind, ProtocolVersion,
};
use container_core::{
    dispatch_event, CallTarget, ContainerRuntime, DataPatch, DataPatchBatch, EngineKind,
    EventDispatch, EventInput, LifecycleEvent, ModuleId, PageEntry, PageId, RuntimeError, TimerId,
    TimerKind, ValueBatch,
};
use container_core::{EngineError, EngineErrorCode};
use container_ir::{
    decode_wxml, parse_wxss_length, CapabilitySupport, ContainerManifestV1, ManifestError,
    ModuleFormat, WxmlAst, WxmlNode, WxssDeclaration, WxssLengthUnit,
};
#[cfg(test)]
use container_ir::{
    parse_inline_wxss, resolve_wxss_style_for_node_with_inline, WxssIr, WxssSelectorNode,
};
#[cfg(test)]
use container_render_skia::layout_tree;
use container_render_skia::{
    BoxSizing, CanvasFrame, Color, CornerRadius, DisplayMode, EdgeInsets, FlexDirection,
    LayoutStyle, PageRenderMode, PositionMode, Rect, RenderFrame, RenderNode, RenderSnapshot,
    RenderTargetSize, Renderer, SelectorError, SkiaRenderer, Transform2D,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
#[cfg(any(
    feature = "skia-gpu-gles",
    all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    )
))]
use std::ffi::c_void;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt,
    sync::Arc,
};
use thiserror::Error;

#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::{Instant, SystemTime, UNIX_EPOCH};
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use web_time::{Instant, SystemTime, UNIX_EPOCH};

mod animation_bindings;
mod animation_clock;
#[cfg(test)]
mod animation_integration_tests;
mod animation_native;
mod animation_playback;
mod animation_protocol;
#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
mod animation_provenance_tests;
mod animation_session;
mod animation_timeline;
mod async_host;
mod browser_query;
mod browser_transaction_finals;
mod browser_view;
mod buffer_urls;
#[cfg(test)]
mod capability_policy_tests;
#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native_query;
#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod private_selector;
mod random_values;
mod route_transaction;
mod selector_geometry;
pub use async_host::{HostRequest, HOST_API_RESOURCE_MAX_BYTES};
mod chrome;
mod tab_bar;
/// APIs requiring an explicitly attached system tabBar presenter.
pub const SYSTEM_TAB_BAR_APIS: [&str; 5] = tab_bar::APIS;
#[cfg(feature = "conformance-observation")]
mod conformance_observation;
#[cfg(feature = "conformance-observation")]
pub use conformance_observation::{
    ConformanceExceptionCapture, ConformanceGuestTurn, ConformanceInvocation,
    ConformancePageBinding,
};
mod components;
pub mod consent_authority;
pub mod consent_delivery;
pub use chrome::{resolve_page_chrome, ChromePage, PageChrome, TabBarChrome, TabBarItem};
mod dev_density;
mod dev_logical_resize;
mod dev_presentation;
mod dev_raster_presentation;
pub mod dev_reload;
mod distribution;
#[cfg(all(test, feature = "restricted-showcase", feature = "quickjs-native"))]
mod restricted_showcase_tests;
pub use distribution::{
    distribution_identity, is_restricted_showcase, restrict_published_capabilities,
    showcase_pack_allowed, DistributionIdentity,
};
mod engine_turn;
mod turn_scheduler;
pub use turn_scheduler::HostIdleOpportunity;
mod execution_health;
mod finite_notifications;
mod frame_input;
mod host_environment;
mod host_geometry;
mod host_services;
mod storage_transactions;
mod sync_files;
pub use sync_files::ManagedSyncFileSystem;
mod strict_provider;
pub use host_geometry::{merge_host_geometry, project_host_geometry, HOST_GEOMETRY_APIS};
pub use host_services::{
    host_api_catalog, host_api_descriptor, host_wire_bounded_integer, host_wire_u64,
    validate_host_services_config, HostAccount, HostApiCallContext, HostApiComponentTarget,
    HostApiDescriptor, HostApiEvent, HostApiFailure, HostBinaryHandle, HostComponentEvent,
    HostComponentFrame, HostComponentSnapshot, HostServicesConfig, TrustedApplication,
};
pub use strict_provider::StrictHostProvider;
mod host_layout;
pub use dev_density::{AcceptedDevDensity, PreparedDevDensity};
pub use dev_logical_resize::{
    AcceptedDevLogicalResize, DevLogicalResizeFailure, PreparedDevLogicalResize,
};
pub use dev_raster_presentation::{
    AcceptedDevRasterPresentation, DevRasterPresentationTarget, DevRasterPresentationTicket,
    PreparedDevRasterPresentation, RasterPresentationPolicy,
};
pub use execution_health::{ExecutionFault, ExecutionFaultDomain, ExecutionHealth};
mod images;
mod lifecycle_notifications;
mod modern_source_map;
mod navigation_layout;
pub use navigation_layout::NavigationLayoutRequest;
mod node_metadata;
mod observers;
mod owned_canvas;
pub mod provider;
mod render_backend;
mod scrolling;
mod skia_frame_authority;
mod style_borders;
mod style_compositing;
mod style_conditions;
mod style_flex;
mod style_stacking;
mod style_text;
mod style_transforms;
mod style_visibility;
mod styles;
mod view_document;
mod view_execution;
pub mod view_query;
mod view_topology;
mod window_metrics;
pub use browser_view::{
    BrowserCommitPermit, BrowserDocumentPermit, BrowserLiveTransactionRetention,
    BrowserLiveViewSubmission, BrowserPageInput, BrowserViewSubmission,
};
#[cfg(test)]
use components::RenderOwnership;
use components::{ManagedPage, RenderWork};
pub use engine_turn::EngineExecutionPolicy;
pub use frame_input::{ExternalFrameRecovery, ExternalFrameRecoveryExpected};
#[cfg(test)]
use node_metadata::{project_dataset, project_mark};
pub use provider::{
    DeviceInfoSnapshot, DeviceState, HostApiProvider, MiniProgramAccountInfo,
    MiniProgramRedirectRequest, NetworkType, PaymentRequest, ProviderContext, ProviderError,
    ProviderErrorCode, ProviderStart, SandboxProvider, ShareRequest, SocketState,
    SubscriptionSettingSnapshot, SystemInfoSnapshot, SystemSettingSnapshot, UserProfileSnapshot,
    VibrationRecord,
};
use render_backend::{
    AcceptedManifestFrame, AcceptedSkiaFrame, PreparedSkiaFrame, SkiaPageBackend,
    SkiaStylePreflight,
};
use skia_frame_authority::SkiaFrameAuthority;
pub use view_execution::{
    ViewExecutionMetrics, ViewExecutionPolicy, ViewFrontierMetrics, ViewPreparationMetrics,
    ViewScopeReleaseMetrics,
};
pub use window_metrics::{
    HostDeviceOrientation, HostDisplayMetrics, HostLayout, HostReservedRegion,
    HostReservedRegionKind, HostSafeArea, HostSafeInsets, HostVerticalBarEdge, HostWindowMetrics,
};

/// AppService is intentionally an alias to the host-independent core. Keeping
/// this name public makes the three-layer architecture explicit to bindings
/// without introducing a second page stack or data model.
pub type AppService = ContainerRuntime;

/// Immutable, content-verified bytes owned by one manifest/session. Cloning
/// the handle for rendering never clones resource byte buffers.
type RenderResources = Arc<BTreeMap<String, Vec<u8>>>;

/// Internal completion policy, supplied separately from untrusted event data.
/// Natural input/lifecycle dispatch keeps reporting user exceptions; an
/// explicit developer owner retirement must fail if a cancel callback fails.
#[derive(Clone, Copy, PartialEq, Eq)]
enum EventHandlerErrorPolicy {
    Report,
    Propagate,
}

/// Only listener/identity metadata on the hit ancestry is retained. A contact
/// never owns a clone of the complete render tree or any render resources.
#[derive(Clone, Debug)]
struct TouchRouteNode {
    identity: String,
    id: String,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    public_id: Option<String>,
    key: Option<String>,
    tag: Option<String>,
    owner: Option<String>,
    component: Option<String>,
    attributes: BTreeMap<String, String>,
    dataset: BTreeMap<String, Value>,
    mark: BTreeMap<String, Value>,
}

impl TouchRouteNode {
    fn from_render(node: &RenderNode) -> Self {
        Self {
            identity: node.event_identity.as_ref().unwrap_or(&node.id).clone(),
            id: node.id.clone(),
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            public_id: node
                .event_identity
                .as_ref()
                .map(|_| node.attributes.get("id").cloned().unwrap_or_default()),
            key: node.key.clone(),
            tag: node.tag.clone(),
            owner: node.event_owner_scope_id.clone(),
            component: node.component_scope_id.clone(),
            attributes: node.attributes.clone(),
            dataset: node.dataset.clone(),
            mark: node.mark.clone(),
        }
    }

    fn same_identity(&self, node: &RenderNode) -> bool {
        self.identity == *node.event_identity.as_ref().unwrap_or(&node.id)
            && self.id == node.id
            && self.key == node.key
            && self.tag == node.tag
            && self.owner == node.event_owner_scope_id
            && self.component == node.component_scope_id
    }
}

#[derive(Clone, Debug)]
struct TouchRoute {
    page: Option<PageId>,
    nodes: Vec<TouchRouteNode>,
}

impl TouchRoute {
    fn node(&self, id: &str) -> Option<&TouchRouteNode> {
        self.nodes.iter().find(|node| node.identity == id)
    }
}

struct ResolvedTouchInput {
    value: Value,
    captured: Option<Arc<TouchRoute>>,
}

#[derive(Clone, Debug)]
struct CapturedTouch {
    route: Arc<TouchRoute>,
    last_input: Map<String, Value>,
    ended: bool,
}

/// Active gestures and end-to-tap leases have independent memory budgets.
/// Expired or unknown identified events are ignored, never re-hit-tested.
const MAX_ACTIVE_TOUCHES: usize = 64;
const MAX_ENDED_TOUCHES: usize = 64;

/// Whether the runtime was compiled with a native provider for the selected
/// JavaScript engine.  Host crates depend on this value rather than checking
/// their own feature flags: Cargo may unify features of the shared runtime
/// when the whole workspace is tested (for example, the simulator enables
/// QuickJS for its runtime dependency).
pub const fn engine_provider_compiled(engine: EngineKind) -> bool {
    match engine {
        EngineKind::Quickjs => cfg!(feature = "quickjs-native"),
        EngineKind::V8 => cfg!(feature = "v8-native"),
    }
}

/// A host category is kept as data so adding a native host does not alter the
/// bridge protocol or the portable manifest.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HostKind {
    Web,
    #[default]
    Desktop,
    Android,
    Ios,
    Harmony,
    MiniProgram,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct HostMetadata {
    #[serde(default)]
    pub kind: HostKind,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub user_agent: String,
    /// Optional host-provided geometry for the WeChat menu button. Hosts that
    /// do not know the native safe-area layout leave this unset. Production
    /// providers reject unavailable geometry; only the explicit development
    /// sandbox retains its deterministic zero rectangle.
    #[serde(
        rename = "menuButtonRect",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub menu_button_rect: Option<MenuButtonRect>,
    /// Optional logical viewport dimensions used by media-query providers.
    /// Zero keeps the deterministic sandbox's historical empty-window
    /// default; native hosts should inject their CSS-pixel dimensions.
    #[serde(rename = "windowWidth", default)]
    pub window_width: u32,
    #[serde(rename = "windowHeight", default)]
    pub window_height: u32,
    /// Optional complete host display observation. Production providers use
    /// only this accepted geometry and never infer screen/DPR from a viewport.
    /// The explicit development sandbox retains its deterministic geometry.
    #[serde(
        rename = "displayMetrics",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub display_metrics: Option<HostDisplayMetrics>,
}

/// Geometry returned by `wx.getMenuButtonBoundingClientRect`, expressed in
/// logical CSS pixels. Fractional values are preserved because browser and
/// native safe-area metrics can land between device pixels.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct MenuButtonRect {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
    pub width: f64,
    pub height: f64,
}

impl Default for HostMetadata {
    fn default() -> Self {
        Self {
            kind: HostKind::Desktop,
            platform: std::env::consts::OS.to_string(),
            version: String::new(),
            user_agent: String::new(),
            menu_button_rect: None,
            window_width: 0,
            window_height: 0,
            display_metrics: None,
        }
    }
}

/// Configuration that is stable across hosts. An empty `capabilities` map
/// means that the host imposes no additional restriction; the manifest remains
/// the source of truth for capability support.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(default = "default_session_id")]
    pub session_id: String,
    #[serde(default = "default_engine")]
    pub engine: EngineKind,
    /// Page presentation ownership. Native GPU mode prepares resources at
    /// commit and leaves drawing to the host; raster remains the compatible
    /// headless/default path. This is separate from a page's semantic profile.
    #[serde(default)]
    pub page_render_mode: container_render_skia::PageRenderMode,
    #[serde(default)]
    pub renderer_override: Option<container_ir::RendererProfile>,
    /// Opt in to the owner-thread browser prepare/permit/present contract.
    /// This does not attach a DOM presenter or authorize legacy render ACKs.
    #[serde(default)]
    pub browser_view_enabled: bool,
    /// Opt-in AppService host-turn limits. Unconfigured sessions preserve the
    /// historical execution policy; unsupported engines reject finite limits.
    #[serde(default)]
    pub engine_execution: EngineExecutionPolicy,
    /// Finite isolated-View batch limits, including cold preparation. The
    /// default remains 50 ms; outer host-turn/request limits still take priority.
    #[serde(default)]
    pub view_execution: ViewExecutionPolicy,
    #[serde(default)]
    pub host: HostMetadata,
    #[serde(default)]
    pub capabilities: BTreeMap<String, CapabilitySupport>,
    /// Verify the manifest's content root when it is present. Validation is
    /// always performed, while this flag controls whether a missing root is
    /// accepted for development-generated manifests.
    #[serde(default)]
    pub require_integrity: bool,
}

fn default_engine() -> EngineKind {
    EngineKind::Quickjs
}

fn default_session_id() -> String {
    "session-1".into()
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            session_id: default_session_id(),
            engine: EngineKind::Quickjs,
            page_render_mode: container_render_skia::PageRenderMode::Raster,
            renderer_override: None,
            browser_view_enabled: false,
            engine_execution: EngineExecutionPolicy::default(),
            view_execution: ViewExecutionPolicy::default(),
            host: HostMetadata::default(),
            capabilities: BTreeMap::new(),
            require_integrity: false,
        }
    }
}

/// Borrowed facts about one accepted Skia publication. A retained frame may
/// belong to an older route; this observation grants no input, ready or browser
/// presentation authority. Reading it never allocates pixels or enters View.
#[derive(Clone, Copy, Debug)]
pub struct AcceptedPageObservation<'a> {
    pub render_revision: u64,
    pub frame: &'a RenderFrame,
    pub target: RenderTargetSize,
    pub snapshot: Option<&'a RenderSnapshot>,
}

impl<'a> AcceptedPageObservation<'a> {
    fn from_renderer(renderer: &'a SkiaRenderer) -> Option<Self> {
        Some(Self {
            render_revision: renderer.snapshot_revision(),
            frame: renderer.last_frame()?,
            target: renderer.accepted_render_target()?,
            snapshot: renderer.snapshot_ref(),
        })
    }
}

/// Passive page-backend facts. Context/surface attachment and allocation are
/// separate from browser presentation receipts and the current page's lifetime.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PageRenderStatus {
    pub mode: PageRenderMode,
    pub backend: &'static str,
    pub page_object_initialized: bool,
    pub last_render_ms: f64,
    pub native_surface: bool,
    pub gpu_surface: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ViewState {
    /// Public activity revision: accepted events and template mutations both
    /// advance this counter, independently of whether pixels need repainting.
    pub revision: u64,
    /// Accepted template-input changes only. Native scroll commits and event
    /// accounting must not invalidate WXML expressions or their View heaps.
    #[serde(default)]
    pub template_revision: u64,
    #[serde(default)]
    pub pending_patches: Vec<DataPatch>,
    #[serde(default)]
    pub event_count: u64,
    #[serde(default)]
    pub last_frame_id: Option<u64>,
}

impl ViewState {
    fn invalidate_template(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.template_revision = self.template_revision.saturating_add(1);
    }

    fn record_patches(&mut self, patches: &[DataPatch]) {
        self.record_owned_patches(patches.to_vec());
    }

    fn record_owned_patches(&mut self, patches: Vec<DataPatch>) {
        self.invalidate_template();
        self.pending_patches.extend(patches);
    }

    fn record_event_batch(&mut self, count: usize) {
        self.event_count = self.event_count.saturating_add(count as u64);
        if count != 0 {
            self.revision = self.revision.saturating_add(1);
        }
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("invalid manifest: {0}")]
    Manifest(#[from] ManifestError),
    #[error("manifest JSON: {0}")]
    ManifestJson(#[from] serde_json::Error),
    #[error("protocol negotiation failed: {0}")]
    Protocol(String),
    #[error("invalid session configuration: {0}")]
    Config(String),
    #[error("ERR_ENGINE: engine provider unavailable: {engine:?}")]
    EngineUnavailable { engine: EngineKind },
    #[error("ERR_ENGINE: isolated View provider creation failed: {0}")]
    ViewProvider(#[from] container_core::ViewEngineError),
    #[error("{0}")]
    EngineExecution(BridgeError),
    #[error("ERR_UNSUPPORTED_CAPABILITY: {0}")]
    UnsupportedCapability(String),
    #[error("ERR_UNTRUSTED_APPLICATION: {0}")]
    UntrustedApplication(String),
}

#[derive(Clone, Debug)]
struct LoadedModule {
    module_id: ModuleId,
    sha256: String,
    format: ModuleFormat,
    evaluated: bool,
}

/// Select the trusted native operation before entering the shared task boundary.
/// Module evaluation must never look up an application-replaceable global.
enum EngineTask<'a> {
    #[cfg(feature = "testing")]
    Testing(Value),
    Call {
        target: CallTarget,
        args: ValueBatch,
    },
    EvaluateModule(&'a str),
}

impl SessionError {
    fn bridge_error(&self) -> BridgeError {
        match self {
            Self::Manifest(_) | Self::ManifestJson(_) => {
                BridgeError::new(BridgeErrorCode::InvalidManifest, self.to_string())
            }
            Self::Protocol(_) => BridgeError::protocol(self.to_string()),
            Self::Config(_) => BridgeError::invalid(self.to_string()),
            Self::EngineUnavailable { .. } | Self::ViewProvider(_) => {
                BridgeError::new(BridgeErrorCode::Engine, self.to_string())
            }
            Self::EngineExecution(error) => error.clone(),
            Self::UnsupportedCapability(_) => {
                BridgeError::new(BridgeErrorCode::UnsupportedCapability, self.to_string())
            }
            Self::UntrustedApplication(_) => {
                BridgeError::new(BridgeErrorCode::PermissionDenied, self.to_string())
            }
        }
    }
}

/// The runtime session and its three coordinated layers.
pub struct Session {
    manifest: ContainerManifestV1,
    config: SessionConfig,
    protocol: ProtocolVersion,
    app_service: ContainerRuntime,
    engine_storage_stamp: Option<container_core::StorageStamp>,
    storage_transactions: storage_transactions::StorageTransactions,
    engine_host_environment: host_environment::HostEnvironmentMirror,
    engine_execution_fault: Option<BridgeError>,
    engine_turn_deadline: Option<Instant>,
    #[cfg(feature = "testing")]
    testing_time_ms: Option<u64>,
    #[cfg(feature = "conformance-observation")]
    conformance_guests: conformance_observation::ConformanceGuestState,
    animation_clock: animation_clock::AnimationClock,
    animation_writes: animation_bindings::WriteLedger,
    animation_bindings: animation_bindings::AnimationBindings,
    animation_playback: animation_playback::PlaybackState,
    pending_native_animations: Option<(u64, PreparedAnimations)>,
    retained_animation_scene: Option<render_backend::RetainedAnimationScene>,
    committed_animation_sample: Option<(u64, animation_protocol::ConsumedSample)>,
    native_animation_attempt: Option<(u64, u64)>,
    navigation_layout: navigation_layout::NavigationLayoutState,
    lifecycle_notifications: lifecycle_notifications::LifecycleNotifications,
    route_transactions: route_transaction::RouteTransactions,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    private_selectors: private_selector::PrivateSelectorState,
    owned_canvases: owned_canvas::OwnedCanvasState,
    host_calls: async_host::HostCalls,
    host_services: host_services::HostServices,
    view: ViewState,
    skia_backend: SkiaPageBackend,
    accepted_view_document: Option<container_ir::ViewDocument>,
    // Only a Session-owned manifest commit can associate the current concrete
    // renderer with its evaluated document. Legacy mutation retires this bit;
    // a replacement retains its own pixels/target but gains no page authority.
    accepted_skia_scene: bool,
    consumed_component_inputs: Option<components::ConsumedComponentInputs>,
    skia_frame_authority: Option<SkiaFrameAuthority>,
    committed_frame_input: Option<frame_input::CommittedFrameInput>,
    browser_view: browser_view::BrowserViewState,
    browser_live_finals: Option<(u64, browser_transaction_finals::BrowserTransactionFinals)>,
    browser_queries: browser_query::BrowserQueryState,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    native_queries: native_query::NativeQueryState,
    // None is a permanent, fail-closed exhausted lifetime namespace.
    input_lifetime_revision: Option<u64>,
    scrolling: scrolling::ScrollRegistry,
    touch_contacts: BTreeMap<i64, CapturedTouch>,
    ended_touch_contacts: VecDeque<i64>,
    observers: RefCell<observers::ObserverRegistry>,
    observer_frame_page: Option<PageId>,
    observer_frame_valid: bool,
    presented_revision: Option<u64>,
    pending_presentation: Option<(Option<PageId>, u64, bool)>,
    dev_raster_presentation: dev_raster_presentation::DevRasterPresentationState,
    observer_observation_pending: bool,
    canvas_frame_sequence: u64,
    cancellation: CancellationRegistry,
    initialized: bool,
    /// Launch options are session state. They must be visible through
    /// App.onLaunch, App.onShow and wx.getLaunchOptionsSync while modules are
    /// evaluated during app.init.
    launch_options: Value,
    /// Whether the registered App.onLaunch hook has been dispatched for this
    /// session.  The flag prevents a repeated app.init handshake from firing
    /// user code twice while still allowing protocol-only sessions to start.
    app_launch_invoked: bool,
    cancelled: BTreeMap<String, bool>,
    /// Manifest module ID to the provider-local module ID.  The manifest is
    /// metadata only; source bytes are supplied by the host through the
    /// batched `module.load` operation and are checked against this map before
    /// execution.
    loaded_modules: BTreeMap<String, LoadedModule>,
    /// Native eager-root tasks still required by the initial module batch.
    /// Registration and successful dependency caches do not complete a root.
    pending_initialization_roots: BTreeSet<String>,
    /// Maps the registration index captured by the JS `Page` facade to the
    /// host page id. This lets asynchronous `setData` effects update the
    /// correct page even after another page is pushed.
    page_bindings: BTreeMap<usize, PageId>,
    /// Keeps the registration index for every live (or cached tab) page
    /// instance. A route may be pushed more than once, so a route/registration
    /// index is not a unique page identity; this reverse map preserves the
    /// instance selected by lifecycle hooks and `getCurrentPages()`.
    page_registration_ids: BTreeMap<PageId, usize>,
    page_initial_data: BTreeMap<PageId, Value>,
    /// Hidden tab roots retain their page id, query and data while another
    /// tab (or a non-tab page) is visible. The cache is owned by the session
    /// so every host observes identical switchTab semantics.
    cached_tabs: BTreeMap<String, PageEntry>,
    /// Definition indices keyed by route, resolved from named module ownership.
    page_module_indices: BTreeMap<String, usize>,
    /// Verified resources and concrete component occurrences are session
    /// state, shared by every surface and retained by safe template reloads.
    render_blobs: RenderResources,
    buffer_urls: Arc<container_core::BufferUrlStore>,
    log_manager: Arc<container_core::LogManagerJournal>,
    performance_lifetime: Arc<container_core::PerformanceLifetime>,
    chrome_catalog: RefCell<Option<chrome::ResolvedChromeCatalog>>,
    tab_bar_state: tab_bar::TabBarState,
    /// Reset whenever the manifest changes. Old committed frames may remain
    /// visible, but their resource store cannot authorize the next manifest.
    render_resources_verified: bool,
    presentation_generation: u64,
    component_pages: BTreeMap<PageId, ManagedPage>,
    /// Direct manifest renders before page.push still own occurrence work.
    /// They never borrow another page's component scope or evaluation cache.
    standalone_render_work: RenderWork,
    /// The View realm is independent of AppService. Interior mutability lets
    /// the occurrence planner execute a whole reserved frontier while reading
    /// immutable component definitions; it never makes the engine Send/Sync.
    view_execution: RefCell<view_execution::ViewExecution>,
    view_deadline_ns: Cell<Option<u64>>,
    /// The current bridge turn's cancellation fence. Asynchronous DOM queries
    /// capture it before yielding; later result/ACK turns cannot rebind it.
    bridge_cancel_token: Option<String>,
    /// Page visibility belongs to the session rather than a surface. Kept
    /// separately from the component graph so a component attached later on
    /// a shown page receives its first show without replaying existing ones.
    component_visible_pages: BTreeMap<PageId, bool>,
    provider: Box<dyn HostApiProvider>,
    /// The selected native V8 isolate is owned by the session when the
    /// runtime is compiled with `v8-native`.  Keeping this here makes the
    /// host feature meaningful: loading a V8 manifest constructs the actual
    /// provider instead of only advertising metadata.
    #[cfg(feature = "v8-native")]
    v8_engine: Option<container_engine_v8::V8Engine>,
    /// The native QuickJS provider is optional for embedders.  A build
    /// without `quickjs-native` intentionally keeps the existing headless
    /// protocol session usable for tests and manifest inspection.
    #[cfg(feature = "quickjs-native")]
    quickjs_engine: Option<container_engine_quickjs::QuickJsEngine>,
}

/// Verified target/resource facts, independent of source AST or page data.
/// Backends may preflight these before View evaluation and retain the same
/// exact resource lease with the evaluated document afterwards.
struct ViewRenderInputs {
    page_input: Option<BrowserPageInput>,
    viewport: Rect,
    frame_id: u64,
    resources: RenderResources,
    template_id: String,
    route_path: String,
    style_roots: Vec<String>,
}

/// Source inputs belong only to the runtime's View/component evaluator.
struct ManifestViewInput {
    render: ViewRenderInputs,
    ast: WxmlAst,
    templates: BTreeMap<String, WxmlAst>,
    data: Value,
    animation_snapshot: Option<Arc<animation_bindings::ScopeSnapshot>>,
}

#[derive(Clone, Debug)]
struct PreparedAnimations {
    bindings: Option<animation_bindings::PreparedBindings>,
    playback: animation_playback::PreparedPlayback,
}

/// The only evaluated declaration tree passed to either backend. Source AST,
/// template maps, page data and planner ownership never cross this boundary.
struct PreparedViewDocument {
    buffer_urls: Arc<container_core::BufferUrlStore>,
    input: ViewRenderInputs,
    document: container_ir::ViewDocument,
    animations: Option<PreparedAnimations>,
}

impl fmt::Debug for Session {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Session")
            .field("session_id", &self.config.session_id)
            .field("engine", &self.config.engine)
            .field("host", &self.config.host)
            .field("protocol", &self.protocol)
            .field("initialized", &self.initialized)
            .field("pages", &self.app_service.pages().len())
            .field("view", &self.view)
            .finish_non_exhaustive()
    }
}

impl Session {
    pub fn renderer_profile_for_route(&self, route_path: &str) -> container_ir::RendererProfile {
        self.config
            .renderer_override
            .unwrap_or_else(|| self.manifest.renderer_profile_for_route(route_path))
    }

    /// The accepted evaluated document retains declaration identity and raw
    /// styles; no geometry from a Skia layout is encoded into this boundary.
    pub fn view_document(&self) -> Option<&container_ir::ViewDocument> {
        self.accepted_view_document.as_ref()
    }

    /// Whether Session accepted a manifest scene for the visible Skia page.
    /// This passive check grants no input, ready or presentation authority.
    /// Retained old-route pictures and legacy renderer replacements do not
    /// become a current scene merely by exposing an accepted frame.
    pub fn has_current_skia_scene(&self) -> bool {
        if !self.accepted_skia_scene {
            return false;
        }
        let Some(page) = self.app_service.pages().current() else {
            return false;
        };
        let profile = self.renderer_profile_for_route(&page.path);
        profile.layout_authority() == container_ir::LayoutAuthority::Rust
            && self.skia_backend.renderer.last_frame().is_some()
            && self
                .accepted_view_document
                .as_ref()
                .is_some_and(|document| {
                    document.profile == profile
                        && document.session_id == self.config.session_id
                        && document.page_id == page.id.0
                        && document.route_path == page.path
                })
    }

    /// Validate a future Skia target without constructing the lazy page object.
    /// DOM callers retain their own browser target policy; this API neither
    /// selects a page renderer nor grants a presentation capability.
    pub fn validate_skia_render_target(
        &self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, container_render_skia::RenderError> {
        self.skia_backend
            .renderer
            .validate_render_target(viewport, scale)
    }

    /// Stage configuration for the next explicit Skia draw. No page object,
    /// pixels, View execution, ready hook or browser revocation is caused here.
    /// Accepted frame/target and independent Canvas ownership remain intact.
    pub fn stage_skia_render_target(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, container_render_skia::RenderError> {
        self.skia_backend
            .renderer
            .stage_render_target(viewport, scale)
    }

    pub fn is_current_frame_presented(&self) -> bool {
        if self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.navigation_blocks_presentation()
        {
            return false;
        }
        if self.browser_route_active() {
            return self.is_browser_view_presented();
        }
        // A live page needs a Session-accepted layout for this exact input
        // lifetime. Numeric frame revisions and retained pixels alone cannot
        // authorize a coordinate system after resize or page retirement.
        if self.skia_frame_authority_required() && self.current_skia_frame_authority().is_none() {
            return false;
        }
        if self.dev_raster_presentation_required() {
            return self.dev_raster_is_currently_presented();
        }
        self.skia_backend.renderer.page_render_mode()
            == container_render_skia::PageRenderMode::Raster
            || (self.presented_revision.is_some()
                && self.presented_revision == Some(self.skia_backend.renderer.snapshot_revision())
                && self.observer_frame_page
                    == self.app_service.pages().current().map(|page| page.id))
    }

    /// Construct a session after validating the portable manifest.
    pub fn new(manifest: ContainerManifestV1, config: SessionConfig) -> Result<Self, SessionError> {
        config.engine_execution.validate()?;
        config.view_execution.validate()?;
        if config.engine_execution.is_bounded()
            && (config.engine != EngineKind::Quickjs || !cfg!(feature = "quickjs-native"))
        {
            return Err(SessionError::EngineExecution(BridgeError::new(
                BridgeErrorCode::Engine,
                "the selected engine does not implement bounded AppService execution",
            )));
        }
        manifest.validate()?;
        let mut supported_profiles = vec![
            container_ir::RendererProfile::Skia,
            container_ir::RendererProfile::SkylineCompat,
        ];
        if config.browser_view_enabled {
            supported_profiles.push(container_ir::RendererProfile::WebView);
        }
        if let Some(profile) = config.renderer_override {
            if !supported_profiles.contains(&profile) {
                return Err(SessionError::UnsupportedCapability(
                    "requested renderer has no attached presentation backend".into(),
                ));
            }
        } else if let Some(rendering) = &manifest.rendering {
            rendering
                .negotiate(container_ir::RENDERING_PROFILE_VERSION, &supported_profiles)
                .map_err(|error| SessionError::UnsupportedCapability(error.to_string()))?;
        }
        if config.session_id.trim().is_empty() {
            return Err(SessionError::Config("session_id cannot be empty".into()));
        }
        if let Some(display) = &config.host.display_metrics {
            HostWindowMetrics {
                window_width: config.host.window_width,
                window_height: config.host.window_height,
                display: display.clone(),
            }
            .validate()?;
        }
        let manifest_protocol = ProtocolVersion::parse(&manifest.protocol_version)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        let protocol = negotiate_protocol(ProtocolVersion::current(), manifest_protocol)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        if config.require_integrity {
            manifest.verify_integrity()?;
        } else if !manifest.integrity.root.is_empty() {
            // A supplied root must still be correct. The opt-out only allows a
            // development manifest with an intentionally blank root.
            manifest.verify_integrity()?;
        }
        // The distribution policy is compiled into this runtime, independent
        // of the manifest, host JSON and provider registrations. Always verify
        // the root even when a caller tries the development opt-out.
        if is_restricted_showcase() {
            manifest.verify_integrity()?;
            if !showcase_pack_allowed(&manifest.integrity.root) {
                return Err(SessionError::UntrustedApplication(
                    "pack is not part of this showcase distribution".into(),
                ));
            }
        }
        let mut skia_backend = SkiaPageBackend::new(config.page_render_mode)?;
        if config.page_render_mode == container_render_skia::PageRenderMode::Raster {
            if let Some(display) = &config.host.display_metrics {
                let viewport = Rect {
                    x: 0.0,
                    y: 0.0,
                    width: config.host.window_width as f32,
                    height: config.host.window_height as f32,
                };
                skia_backend
                    .renderer
                    .stage_render_target(viewport, display.pixel_ratio)
                    .map_err(|error| SessionError::Config(error.to_string()))?;
            }
        }
        #[cfg(feature = "v8-native")]
        let v8_engine = if config.engine == EngineKind::V8 {
            let mut engine = container_engine_v8::V8Engine::default();
            if container_engine_v8::JsEngineAdapter::mode(&engine)
                != container_engine_v8::EngineMode::V8
            {
                return Err(SessionError::EngineUnavailable {
                    engine: EngineKind::V8,
                });
            }
            engine.enable_deferred_storage_commit().map_err(|error| {
                SessionError::EngineExecution(engine_bridge_error(
                    error.into_core_error(),
                    BridgeErrorCode::Engine,
                ))
            })?;
            engine
                .dispatch_lifecycle_notification("session", &Value::Null)
                .map_err(|error| {
                    SessionError::EngineExecution(engine_bridge_error(
                        error.into_core_error(),
                        BridgeErrorCode::Engine,
                    ))
                })?;
            Some(engine)
        } else {
            None
        };
        #[cfg(not(feature = "v8-native"))]
        if config.engine == EngineKind::V8 {
            return Err(SessionError::EngineUnavailable {
                engine: EngineKind::V8,
            });
        }
        #[cfg(feature = "quickjs-native")]
        let quickjs_engine = if config.engine == EngineKind::Quickjs {
            let mut engine = container_engine_quickjs::QuickJsEngine::try_new_with_budget(
                container_engine_quickjs::QuickJsConfig::default(),
                container_core::EngineExecutionBudget {
                    timeout: config
                        .engine_execution
                        .bootstrap_timeout_ms
                        .map(std::time::Duration::from_millis),
                    ..Default::default()
                },
            )
            .map_err(|error| {
                SessionError::EngineExecution(engine_bridge_error(error, BridgeErrorCode::Engine))
            })?;
            if container_engine_quickjs::JsEngineAdapter::mode(&engine)
                != container_engine_quickjs::EngineMode::QuickJs
            {
                return Err(SessionError::EngineUnavailable {
                    engine: EngineKind::Quickjs,
                });
            }
            engine.enable_deferred_storage_commit().map_err(|error| {
                SessionError::EngineExecution(engine_bridge_error(
                    error.into_core_error(),
                    BridgeErrorCode::Engine,
                ))
            })?;
            engine
                .dispatch_lifecycle_notification("session", &Value::Null)
                .map_err(|error| {
                    SessionError::EngineExecution(engine_bridge_error(
                        error.into_core_error(),
                        BridgeErrorCode::Engine,
                    ))
                })?;
            Some(engine)
        } else {
            None
        };
        let buffer_urls = match config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => quickjs_engine
                .as_ref()
                .and_then(|engine| engine.buffer_url_store()),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => v8_engine
                .as_ref()
                .and_then(|engine| engine.buffer_url_store()),
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => None,
        }
        .unwrap_or_default();
        let log_manager = match config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => quickjs_engine
                .as_ref()
                .and_then(|engine| engine.log_manager_journal()),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => v8_engine
                .as_ref()
                .and_then(|engine| engine.log_manager_journal()),
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => None,
        }
        .unwrap_or_default();
        let performance_lifetime = match config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => quickjs_engine
                .as_ref()
                .and_then(|engine| engine.performance_lifetime()),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => v8_engine
                .as_ref()
                .and_then(|engine| engine.performance_lifetime()),
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => None,
        }
        .unwrap_or_default();
        let view_execution = RefCell::new(view_execution::ViewExecution::new(config.engine)?);
        Ok(Self {
            manifest,
            config,
            protocol,
            app_service: ContainerRuntime::default(),
            engine_storage_stamp: None,
            storage_transactions: Default::default(),
            engine_host_environment: host_environment::HostEnvironmentMirror::default(),
            engine_execution_fault: None,
            engine_turn_deadline: None,
            #[cfg(feature = "testing")]
            testing_time_ms: None,
            #[cfg(feature = "conformance-observation")]
            conformance_guests: Default::default(),
            animation_clock: animation_clock::AnimationClock::default(),
            animation_writes: animation_bindings::WriteLedger::default(),
            animation_bindings: animation_bindings::AnimationBindings::default(),
            animation_playback: animation_playback::PlaybackState::default(),
            pending_native_animations: None,
            retained_animation_scene: None,
            committed_animation_sample: None,
            native_animation_attempt: None,
            navigation_layout: Default::default(),
            lifecycle_notifications: Default::default(),
            route_transactions: Default::default(),
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            private_selectors: Default::default(),
            owned_canvases: Default::default(),
            host_calls: async_host::HostCalls::default(),
            host_services: host_services::HostServices::default(),
            view: ViewState::default(),
            skia_backend,
            accepted_view_document: None,
            accepted_skia_scene: false,
            consumed_component_inputs: None,
            skia_frame_authority: None,
            committed_frame_input: None,
            browser_view: browser_view::BrowserViewState::default(),
            browser_live_finals: None,
            browser_queries: browser_query::BrowserQueryState::default(),
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            native_queries: native_query::NativeQueryState::default(),
            input_lifetime_revision: Some(0),
            scrolling: scrolling::ScrollRegistry::default(),
            touch_contacts: BTreeMap::new(),
            ended_touch_contacts: VecDeque::new(),
            observers: RefCell::new(observers::ObserverRegistry::default()),
            observer_frame_page: None,
            observer_frame_valid: false,
            presented_revision: None,
            pending_presentation: None,
            dev_raster_presentation: dev_raster_presentation::DevRasterPresentationState::default(),
            observer_observation_pending: false,
            canvas_frame_sequence: 0,
            cancellation: CancellationRegistry::default(),
            initialized: false,
            launch_options: json!({"path": "", "query": {}, "referrerInfo": {}, "scene": 1001}),
            app_launch_invoked: false,
            cancelled: BTreeMap::new(),
            loaded_modules: BTreeMap::new(),
            pending_initialization_roots: BTreeSet::new(),
            page_bindings: BTreeMap::new(),
            page_registration_ids: BTreeMap::new(),
            page_initial_data: BTreeMap::new(),
            cached_tabs: BTreeMap::new(),
            page_module_indices: BTreeMap::new(),
            render_blobs: Arc::default(),
            buffer_urls,
            log_manager,
            performance_lifetime,
            chrome_catalog: RefCell::new(None),
            tab_bar_state: tab_bar::TabBarState::default(),
            render_resources_verified: false,
            presentation_generation: 0,
            component_pages: BTreeMap::new(),
            standalone_render_work: RenderWork::default(),
            view_execution,
            view_deadline_ns: Cell::new(None),
            bridge_cancel_token: None,
            component_visible_pages: BTreeMap::new(),
            provider: Box::new(SandboxProvider::new()),
            #[cfg(feature = "v8-native")]
            v8_engine,
            #[cfg(feature = "quickjs-native")]
            quickjs_engine,
        })
    }

    /// Parse and validate a manifest JSON document before creating a session.
    pub fn from_manifest_json(
        bytes: impl AsRef<[u8]>,
        config: SessionConfig,
    ) -> Result<Self, SessionError> {
        let manifest: ContainerManifestV1 = serde_json::from_slice(bytes.as_ref())?;
        Self::new(manifest, config)
    }

    /// Load a manifest from JSON. This is an explicit alias useful to host
    /// adapters that load sessions lazily.
    pub fn load_manifest(
        bytes: impl AsRef<[u8]>,
        config: SessionConfig,
    ) -> Result<Self, SessionError> {
        Self::from_manifest_json(bytes, config)
    }

    pub fn manifest(&self) -> &ContainerManifestV1 {
        &self.manifest
    }

    /// Reject view programs for which this runtime has no isolated execution
    /// provider. Host loaders call this before replacing a runnable session;
    /// direct protocol users are checked again before AppService startup.
    pub fn ensure_view_execution_supported(&self) -> Result<(), SessionError> {
        self.ensure_manifest_view_execution_supported(&self.manifest)
    }

    fn ensure_manifest_view_execution_supported(
        &self,
        manifest: &ContainerManifestV1,
    ) -> Result<(), SessionError> {
        let native_view = self.view_execution.borrow().is_available();
        if !native_view
            && (manifest.modern_view.is_some()
                || manifest.view_compilation.is_some()
                || !manifest.view_scripts.is_empty()
                || manifest
                    .templates
                    .iter()
                    .any(|template| !template.wxs_modules.is_empty()))
        {
            return Err(SessionError::EngineUnavailable {
                engine: self.config.engine,
            });
        }
        ensure_view_manifest_supported(manifest, native_view)
    }

    fn template_view_execution_allowed(&self, template: &str) -> bool {
        self.view_execution.borrow().is_available()
            && self.manifest.templates.iter().any(|entry| {
                entry.id == template
                    && (self.manifest.modern_view.is_some()
                        || self.manifest.view_compilation.is_some()
                        || !entry.wxs_modules.is_empty())
            })
    }

    fn validate_view_resources(
        &self,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> Result<(), BridgeError> {
        view_execution::modern_modules(&self.manifest, blobs)?;
        if let Some(compiled) = &self.manifest.view_compilation {
            for module in &compiled.modules {
                view_execution::compiled_source(
                    blobs,
                    &module.executable_sha256,
                    &module.helper,
                    &compiled.abi,
                )?;
            }
            for document in &compiled.documents {
                for expression in &document.expressions {
                    view_execution::compiled_source(
                        blobs,
                        &expression.executable_sha256,
                        &expression.helper,
                        &compiled.abi,
                    )?;
                }
            }
        }
        for script in &self.manifest.view_scripts {
            let pointer = format!("sha256:{}", script.sha256);
            let source = lookup_render_blob(blobs, &pointer)?;
            let actual = container_ir::hex_digest(source);
            if actual != script.sha256 {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("view script {} SHA-256 mismatch", script.id),
                ));
            }
            std::str::from_utf8(source).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("view script {} is not UTF-8: {error}", script.id),
                )
            })?;
        }
        for asset in self
            .manifest
            .assets
            .iter()
            .filter(|asset| asset.path.ends_with(".wxs"))
        {
            let source = lookup_render_blob(blobs, &format!("sha256:{}", asset.sha256))?;
            if container_ir::hex_digest(source) != asset.sha256 {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("legacy WXS asset {} SHA-256 mismatch", asset.path),
                ));
            }
            std::str::from_utf8(source).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("legacy WXS asset {} is not UTF-8: {error}", asset.path),
                )
            })?;
        }
        // Older v1 packs can retain <wxs> in WXML without declaring
        // viewScripts. Inspect source ASTs before conditionals/template
        // expansion can erase these declarations or any user hook can run.
        for template in &self.manifest.templates {
            let Some(bytes) = blobs.get(&template.wxml_ast) else {
                continue;
            };
            let ast = decode_wxml(bytes).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("template {} WXML IR is invalid: {error}", template.id),
                )
            })?;
            ensure_wxml_view_supported(
                &ast,
                &template.id,
                self.template_view_execution_allowed(&template.id),
            )?;
        }
        Ok(())
    }

    /// Replace the manifest metadata while retaining the live AppService,
    /// page stack, provider, timers and renderer ownership. Presentation
    /// resources and frame authority are invalidated; development callers
    /// should use `replace_dev_presentation` for atomic candidate acceptance.
    /// Module and configuration changes are rejected here: retaining loaded JavaScript
    /// registrations with a different executable manifest requires a restart.
    pub fn replace_manifest(&mut self, manifest: ContainerManifestV1) -> Result<(), SessionError> {
        if is_restricted_showcase() {
            return Err(SessionError::UnsupportedCapability(
                "development manifest replacement is disabled in this distribution".into(),
            ));
        }
        if self.requires_dev_restart() {
            return Err(SessionError::Config(
                "execution health requires a new session; live manifest replacement is forbidden"
                    .into(),
            ));
        }
        self.ensure_engine_execution_healthy()
            .map_err(SessionError::EngineExecution)?;
        manifest.validate()?;
        let manifest_protocol = ProtocolVersion::parse(&manifest.protocol_version)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        let protocol = negotiate_protocol(ProtocolVersion::current(), manifest_protocol)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        if protocol.major != self.protocol.major {
            return Err(SessionError::Protocol(
                "manifest protocol major changed during live reload".into(),
            ));
        }
        if self.config.require_integrity || !manifest.integrity.root.is_empty() {
            manifest.verify_integrity()?;
        }
        self.ensure_manifest_view_execution_supported(&manifest)?;
        if !self.manifest.can_replace_presentation_with(&manifest) {
            return Err(SessionError::Config(
                "live manifest replacement changes execution or configuration; restart the session"
                    .into(),
            ));
        }
        if self.manifest != manifest {
            self.with_engine_host_turn(None, |session| {
                session.retire_browser_contacts_before_host_mutation("manifest-replaced");
                session.ensure_engine_execution_healthy()
            })
            .map_err(SessionError::EngineExecution)?;
            if self.navigation_layout.enabled {
                self.cancel_all_navigation("manifest replaced")
                    .map_err(SessionError::EngineExecution)?;
                self.navigation_layout.closed = false;
            }
            self.render_resources_verified = false;
            // Accepted frames retain their own Arc handles. A replacement
            // manifest starts a new, independently authorized cache lifetime.
            self.skia_backend.reset_manifest_resources();
            self.animation_writes.retire_all();
            self.animation_bindings.retire_all();
            self.animation_playback.retire_all();
            self.pending_native_animations = None;
            self.retained_animation_scene = None;
            self.committed_animation_sample = None;
        }
        self.protocol = protocol;
        self.manifest = manifest;
        self.invalidate_engine_host_environment();
        Ok(())
    }
    /// Enable bounded AppService console diagnostics before loading modules.
    /// Disabled by default so normal sessions retain their historical trace.
    pub fn set_dev_console_enabled(&mut self, enabled: bool) -> Result<(), BridgeError> {
        if enabled && is_restricted_showcase() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "development console is disabled in this distribution",
            ));
        }
        self.call_engine(
            CallTarget::Global {
                name: "__container_set_dev_console_enabled".into(),
            },
            vec![json!(enabled)],
        )?;
        Ok(())
    }

    pub fn config(&self) -> &SessionConfig {
        &self.config
    }
    pub fn protocol(&self) -> ProtocolVersion {
        self.protocol.clone()
    }
    pub fn app_service(&self) -> &ContainerRuntime {
        &self.app_service
    }
    pub fn app_service_mut(&mut self) -> &mut ContainerRuntime {
        // Hosts may replace the entire store with a persisted snapshot whose
        // local revision happens to match the previous store's revision.
        // Unrestricted host mutation may replace the stack or lifecycle as
        // well as storage. Previously issued DOM authorizations cannot survive.
        let retirement = self.with_engine_host_turn(None, |session| {
            session.retire_browser_contacts_before_host_mutation("host-state-mutated");
            session.reconcile_engine_storage()
        });
        if let Err(error) = retirement {
            // This compatibility accessor cannot return a reconciliation
            // error. Keep raw host edits possible, but forbid a realm whose
            // earlier successful writes could not be ordered before them.
            self.record_execution_fault(&error);
            self.invalidate_browser_presentation();
            let diagnostic = self.error_envelope(&error, String::new(), op::ERROR);
            self.queue_browser_retirement_message(diagnostic);
        }
        self.engine_storage_stamp = None;
        &mut self.app_service
    }
    pub fn view(&self) -> &ViewState {
        &self.view
    }

    /// Whether this session owns hash-verified immutable resources for its
    /// current manifest. Hosts may then request `useSessionResources` instead
    /// of copying every blob into each render request. Changing the manifest
    /// revokes this authority; retained frames do not grant it back.
    pub fn can_reuse_render_resources(&self) -> bool {
        self.render_resources_verified && !self.render_blobs.is_empty()
    }

    fn view_execution_budget(&self) -> container_core::ViewExecutionBudget {
        let mut budget = container_core::ViewExecutionBudget::new(
            std::time::Duration::from_millis(self.config.view_execution.batch_timeout_ms),
        );
        if let Some(remaining) = self.remaining_engine_timeout() {
            budget.timeout = budget.timeout.min(remaining);
        }
        if let Some(deadline_ns) = self.view_deadline_ns.get() {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let remaining = u128::from(deadline_ns).saturating_sub(now);
            let remaining =
                std::time::Duration::from_nanos(remaining.min(u128::from(u64::MAX)) as u64);
            budget.timeout = budget.timeout.min(remaining);
        }
        budget
    }
    /// Observe an existing concrete renderer without constructing one. DOM
    /// state, metadata and empty-frame checks must use this passive accessor.
    pub fn renderer_if_initialized(&self) -> Option<&SkiaRenderer> {
        self.skia_backend.renderer.peek()
    }

    /// Configured presentation ownership, available before any Skia use.
    pub fn page_render_mode(&self) -> container_render_skia::PageRenderMode {
        self.skia_backend.renderer.page_render_mode()
    }

    /// Accepted Skia revision; zero does not construct a renderer or grant
    /// authority to a browser document's independent presentation namespace.
    pub fn render_revision(&self) -> u64 {
        self.skia_backend.renderer.snapshot_revision()
    }

    pub fn renderer_backend(&self) -> &'static str {
        self.skia_backend.renderer.backend_name()
    }

    /// Borrow one accepted frame, its exact target and any already materialized
    /// pixels from the same passive backend peek. Does not initialize Skia or
    /// infer that a retained frame is the current route's presented document.
    pub fn accepted_page_observation(&self) -> Option<AcceptedPageObservation<'_>> {
        AcceptedPageObservation::from_renderer(self.skia_backend.renderer.peek()?)
    }

    /// Observe configuration/allocation without creating a page object, raster
    /// surface, GPU context or snapshot. An empty backend reports zero/false.
    pub fn page_render_status(&self) -> PageRenderStatus {
        let renderer = self.skia_backend.renderer.peek();
        let mode = renderer.map_or(self.config.page_render_mode, SkiaRenderer::page_render_mode);
        PageRenderStatus {
            mode,
            backend: renderer.map_or_else(
                || SkiaRenderer::configured_backend_name(mode),
                Renderer::backend_name,
            ),
            page_object_initialized: renderer.is_some(),
            last_render_ms: renderer.map_or(0.0, SkiaRenderer::last_render_ms),
            native_surface: renderer.is_some_and(SkiaRenderer::has_native_surface),
            gpu_surface: renderer.is_some_and(SkiaRenderer::has_gpu_surface),
        }
    }

    /// Read the target of an exact accepted Skia revision. Application frame
    /// ids and browser document revisions are not substitute receipt tokens.
    pub fn render_target_for_revision(
        &self,
        revision: u64,
    ) -> Result<RenderTargetSize, BridgeError> {
        if revision == 0 || revision != self.render_revision() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "physical target requested for a stale render revision",
            ));
        }
        self.accepted_page_observation()
            .map(|observation| observation.target)
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    "accepted render target unavailable",
                )
            })
    }

    /// Explicit snapshot request through an existing page backend. External
    /// frame mode preserves its on-demand software diagnostic behavior; passive
    /// accepted-page observations only borrow already materialized pixels.
    pub fn render_snapshot(&self) -> Option<RenderSnapshot> {
        self.skia_backend
            .renderer
            .peek()
            .and_then(SkiaRenderer::snapshot)
    }

    /// A context is an attachment, not evidence that a surface was presented.
    /// This passive inspection never initializes a page object or Metal state.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn has_metal_context(&self) -> bool {
        self.skia_backend
            .renderer
            .peek()
            .is_some_and(SkiaRenderer::has_metal_context)
    }

    /// Inspect the current GL attachment without initializing a renderer.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn has_gles_context(&self) -> bool {
        self.skia_backend
            .renderer
            .peek()
            .is_some_and(SkiaRenderer::has_gles_context)
    }

    /// Legacy explicit Skia initialization. This is not a backend-neutral DOM
    /// layout/presentation API and does not grant presentation authority.
    /// Explicit diagnostic readback of the accepted scene at a physical size.
    /// This does not replace its frame namespace or retire presentation/input
    /// authority, unlike exposing an unrestricted mutable renderer borrow.
    pub fn capture_render_snapshot_at_size(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<RenderSnapshot, container_render_skia::RenderError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .snapshot_at_size(width, height)
    }

    pub fn renderer(&self) -> &SkiaRenderer {
        self.skia_backend.renderer.ensure()
    }

    /// A host font is execution-owner configuration, installed before app.init.
    /// The independent Canvas owner retains it without initializing a page.
    pub fn install_portable_text_font(
        &mut self,
        font: container_render_skia::PortableFontData,
    ) -> Result<container_render_skia::PortableFontIdentity, SessionError> {
        if self.initialized
            || self.config.page_render_mode != container_render_skia::PageRenderMode::ExternalFrame
        {
            return Err(SessionError::Config(
                "external text font must be installed before app.init".into(),
            ));
        }
        self.skia_backend
            .renderer
            .install_portable_text_font(font)
            .map_err(|error| SessionError::Config(error.to_string()))
    }
    /// Legacy concrete mutation initializes Skia and keeps its invalidation.
    /// A renderer borrow never constitutes a browser presentation receipt.
    pub fn renderer_mut(&mut self) -> &mut SkiaRenderer {
        // An unrestricted borrow may replace the renderer with a different
        // frame/revision namespace. Known retained repaints use Session APIs.
        self.invalidate_browser_presentation();
        self.retire_all_owned_canvases();
        self.accepted_skia_scene = false;
        // Replacement can reuse the previous renderer's revision and frameId.
        // Retire page-owned presentation/geometry authority before exposing the
        // borrow; retained repaint and target staging use the typed APIs above.
        self.retire_skia_frame_authority();
        self.skia_backend.renderer.ensure_mut()
    }

    /// Attach a host-owned Metal device and command queue to the optional
    /// Ganesh renderer. The raw handles are Objective-C objects owned by the
    /// caller; Skia retains them while the context lives.
    ///
    /// # Safety
    ///
    /// `device` and `queue` must point to live retained MTLDevice and
    /// MTLCommandQueue objects from the same Metal device.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const c_void,
        queue: *const c_void,
    ) -> Result<(), SessionError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .attach_metal_context(device, queue)
            .map_err(|error| SessionError::Config(error.to_string()))
    }

    /// Render the latest committed frame into one drawable texture owned by
    /// the host. The host acquires and presents a fresh drawable per frame.
    ///
    /// # Safety
    ///
    /// `texture` must point to a live MTLTexture belonging to the current
    /// drawable and remain alive until the host commits its command buffer.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const c_void,
        width: u32,
        height: u32,
    ) -> Result<(), SessionError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .render_last_frame_to_metal_texture(texture, width, height)
            .map_err(|error| SessionError::Config(error.to_string()))
    }

    /// Attach the current host OpenGL ES context to the runtime renderer.
    /// The host must call this on the same thread that owns the EGL context.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), SessionError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .attach_gles_context()
            .map_err(|error| SessionError::Config(error.to_string()))
    }

    /// Attach a current host GL context using its explicit platform resolver.
    /// The context and subsequent calls stay on the Session owner thread.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gl_context_with(
        &mut self,
        resolver: impl FnMut(&str) -> *const c_void,
    ) -> Result<(), SessionError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .attach_gl_context_with(resolver)
            .map_err(|error| SessionError::Config(error.to_string()))
    }

    /// Render the last committed frame into a host-owned GLES framebuffer.
    /// The host performs the EGL swap after this call returns.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn render_last_frame_to_gles_framebuffer(
        &mut self,
        framebuffer: u32,
        width: u32,
        height: u32,
    ) -> Result<(), SessionError> {
        self.skia_backend
            .renderer
            .ensure_mut()
            .render_last_frame_to_gles_framebuffer(framebuffer, width, height)
            .map_err(|error| SessionError::Config(error.to_string()))
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn detach_gles_context(&mut self) {
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.detach_gles_context();
        }
    }

    /// Release ownership after context loss without requiring a current GL context.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn abandon_gles_context(&mut self) {
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.abandon_gles_context();
        }
    }

    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn detach_metal_context(&mut self) {
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.detach_metal_context();
        }
    }

    /// Return the latest independent Canvas 2D surface by id. Canvas draws do
    /// not replace the page `RenderFrame`; hosts request this snapshot when
    /// presenting a canvas layer or when recording a conformance artifact.
    pub fn canvas_snapshot(
        &self,
        canvas_id: &str,
    ) -> Option<container_render_skia::RenderSnapshot> {
        self.skia_backend.renderer.canvas_snapshot(canvas_id)
    }
    pub fn initialized(&self) -> bool {
        self.initialized
    }

    /// Replace the deterministic provider with a host implementation. This
    /// is intentionally a single object boundary so a native host can own
    /// network, filesystem, permission and device state without exposing
    /// platform handles to the portable runtime.
    pub fn set_provider(&mut self, provider: Box<dyn HostApiProvider>) {
        self.provider = provider;
        self.invalidate_engine_host_environment();
    }

    pub fn provider_name(&self) -> &'static str {
        self.provider.name()
    }

    /// Accept an actual host surface's new logical size without replacing the
    /// AppService or JavaScript isolate. Providers and hooks observe the same
    /// geometry before the host submits its next manifest render. A repeated
    /// size is a no-op, so Android surface recreation cannot replay onResize.
    pub fn notify_viewport_resize(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.notify_viewport_resize_within_turn(width, height)
        })
    }

    fn notify_viewport_resize_within_turn(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_initialized()?;
        if let Some(mut display) = self.config.host.display_metrics.clone() {
            // A legacy size-only update cannot rebase surface-local layout.
            // Drop that optional observation until the host supplies a full snapshot.
            if self.config.host.window_width != width || self.config.host.window_height != height {
                display.host_layout = None;
            }
            return self.notify_window_metrics(HostWindowMetrics {
                window_width: width,
                window_height: height,
                display,
            });
        }
        window_metrics::validate_viewport(width, height)
            .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        self.apply_window_metrics(width, height, None)
    }

    /// Atomically validate one complete host observation, then refresh all
    /// synchronous provider values before notifying page/component hooks.
    /// Display-only changes update API snapshots without replaying onResize.
    pub fn notify_window_metrics(
        &mut self,
        metrics: HostWindowMetrics,
    ) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.notify_window_metrics_within_turn(metrics)
        })
    }

    fn notify_window_metrics_within_turn(
        &mut self,
        metrics: HostWindowMetrics,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_initialized()?;
        metrics
            .validate()
            .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        let raster = self.skia_backend.renderer.page_render_mode()
            == container_render_skia::PageRenderMode::Raster;
        let previous_scale = self.skia_backend.renderer.render_scale();
        let density_changed = raster && previous_scale != metrics.display.pixel_ratio;
        let viewport_changed = self.config.host.window_width != metrics.window_width
            || self.config.host.window_height != metrics.window_height;
        if density_changed {
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: metrics.window_width as f32,
                height: metrics.window_height as f32,
            };
            self.skia_backend
                .renderer
                .stage_render_target(viewport, metrics.display.pixel_ratio)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        }
        let next_scale = metrics.display.pixel_ratio;
        let next_display = metrics.display.clone();
        let result = self.apply_window_metrics(
            metrics.window_width,
            metrics.window_height,
            Some(metrics.display),
        );
        let batch = match result {
            Ok(batch) => batch,
            Err(error) => {
                // Geometry installation may roll host metadata back before
                // resize callbacks run. Restore its previous raster target in
                // that case; failures after the new metrics were accepted keep
                // the matching density staged for the next committed frame.
                if self.config.host.window_width != metrics.window_width
                    || self.config.host.window_height != metrics.window_height
                    || self.config.host.display_metrics.as_ref() != Some(&next_display)
                {
                    let viewport = Rect {
                        x: 0.0,
                        y: 0.0,
                        width: self.config.host.window_width as f32,
                        height: self.config.host.window_height as f32,
                    };
                    self.skia_backend
                        .renderer
                        .stage_render_target(viewport, previous_scale)
                        .map_err(|rollback| {
                            BridgeError::new(
                                BridgeErrorCode::Render,
                                format!("{error}; restoring raster target failed: {rollback}"),
                            )
                        })?;
                }
                return Err(error);
            }
        };
        if density_changed && !viewport_changed {
            self.repaint_current_skia_page(next_scale)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
        }
        Ok(batch)
    }

    fn apply_window_metrics(
        &mut self,
        width: u32,
        height: u32,
        display: Option<HostDisplayMetrics>,
    ) -> Result<BridgeBatch, BridgeError> {
        self.apply_host_geometry(
            width,
            height,
            display,
            self.config.host.menu_button_rect.clone(),
        )
    }

    fn apply_host_geometry(
        &mut self,
        width: u32,
        height: u32,
        display: Option<HostDisplayMetrics>,
        menu: Option<MenuButtonRect>,
    ) -> Result<BridgeBatch, BridgeError> {
        let viewport_changed =
            self.config.host.window_width != width || self.config.host.window_height != height;
        let layout_changed = self
            .config
            .host
            .display_metrics
            .as_ref()
            .and_then(|value| value.host_layout.as_ref())
            != display
                .as_ref()
                .and_then(|value| value.host_layout.as_ref());
        let coordinate_system_changed = viewport_changed || layout_changed;
        if !viewport_changed
            && self.config.host.display_metrics == display
            && self.config.host.menu_button_rect == menu
        {
            return Ok(BridgeBatch::new(Vec::new()));
        }
        // Withdraw developer Raster authority before environment preparation
        // can checkpoint application jobs. Failure keeps diagnostic pixels,
        // but cannot revive a receipt for the former coordinate system.
        if coordinate_system_changed {
            self.suspend_dev_raster_presentation();
            self.retire_skia_frame_authority();
            self.suspend_browser_coordinate_authority();
        }
        let previous = self.config.host.clone();
        self.mark_engine_host_environment_dirty()?;
        self.config.host.window_width = width;
        self.config.host.window_height = height;
        self.config.host.display_metrics = display;
        self.config.host.menu_button_rect = menu;
        if let Err(error) = self.prepare_geometry_environment() {
            self.config.host = previous;
            self.mark_engine_host_environment_dirty()?;
            // A failed native installation is sticky. Never repair or call
            // application jobs in that realm; a healthy owner repair is atomic.
            self.ensure_engine_execution_healthy()?;
            if let Err(rollback) = self.ensure_engine_environment_current() {
                return Err(BridgeError::new(
                    BridgeErrorCode::Engine,
                    format!("{error}; restoring host metrics failed: {rollback}"),
                ));
            }
            return Err(error);
        }
        if !coordinate_system_changed {
            return Ok(BridgeBatch::new(vec![BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::EVENT_BATCH,
                json!({"source":"host", "type":"host.windowMetrics", "displayMetrics":self.config.host.display_metrics}),
            )]));
        }
        let browser_contacts = self.settle_browser_contact_retirement("host-geometry-changed");
        self.invalidate_browser_candidate();
        browser_contacts?;
        if self.engine_provider_available() {
            // A Remote recipient belongs to the retired presentation key;
            // resize hooks must observe its capability withdrawal immediately.
            self.sync_engine_capabilities()?;
        }
        let mut messages = if viewport_changed {
            self.deliver_window_resize_hooks(width, height)?.messages
        } else {
            self.cancel_touch_ids(
                &self.touch_contacts.keys().copied().collect::<Vec<_>>(),
                "host-layout-changed",
            )?;
            self.observer_frame_valid = false;
            Vec::new()
        };
        if layout_changed {
            let layout = self
                .config
                .host
                .display_metrics
                .as_ref()
                .and_then(|value| value.host_layout.as_ref());
            let event = json!({"hostLayout": layout});
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::EVENT_BATCH,
                json!({"source":"host", "type":"host.layoutChanged", "hostLayout":layout}),
            ));
            if let Err(error) = self.dispatch_lifecycle_notification("hostLayoutChange", &event) {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if let Err(error) = self.append_engine_effects(&mut messages) {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if !messages.iter().any(effect_continuation_stopped) {
                if let Err(error) = self.notify_observers(&mut messages) {
                    messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                }
                if let Err(error) = self.append_engine_effects(&mut messages) {
                    messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                }
            }
            self.append_browser_retirement_messages(&mut messages);
        }
        Ok(BridgeBatch::new(messages))
    }

    /// One resize notification sequence after the caller installed geometry
    /// and retired its former coordinate-system authority. Developer picture
    /// transactions share these irreversible hooks without using a second
    /// old-size observation as rollback.
    fn deliver_window_resize_hooks(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<BridgeBatch, BridgeError> {
        let mut messages = Vec::new();
        self.deliver_window_resize_hooks_with_fence(width, height, None, &mut messages)?;
        Ok(BridgeBatch::new(messages))
    }

    fn deliver_window_resize_hooks_with_fence(
        &mut self,
        width: u32,
        height: u32,
        fence: Option<&dev_logical_resize::LogicalResizeFence>,
        messages: &mut Vec<BridgeEnvelope>,
    ) -> Result<(), BridgeError> {
        // A host resize changes the media-query environment immediately;
        // intersection geometry waits for a frame laid out at that size.
        let contacts = self.touch_contacts.keys().copied().collect::<Vec<_>>();
        self.cancel_touch_ids(&contacts, "viewport-resized")?;
        if let Some(fence) = fence {
            fence.validate(self)?;
        }
        self.observer_frame_valid = false;
        let size = json!({"windowWidth": width, "windowHeight": height});
        let orientation = self
            .config
            .host
            .display_metrics
            .as_ref()
            .map(|display| display.device_orientation)
            .unwrap_or(if width > height {
                HostDeviceOrientation::Landscape
            } else {
                HostDeviceOrientation::Portrait
            });
        let arguments = json!({"size": size, "deviceOrientation": orientation});
        messages.push(BridgeEnvelope::event(
            self.config.session_id.clone(),
            op::EVENT_BATCH,
            json!({"source":"host", "type":"host.resize", "size":size}),
        ));
        if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
            let page_result =
                self.invoke_page_hook_for_id(page, "onResize", vec![arguments.clone()]);
            if let Err(error) = self.ensure_engine_execution_healthy() {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                self.append_browser_retirement_messages(messages);
                return Ok(());
            }
            if let Err(error) = page_result {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if let Some(fence) = fence {
                fence.validate(self)?;
            }
            if let Err(error) =
                self.dispatch_component_page_lifetime(page, "resize", vec![arguments])
            {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if let Some(fence) = fence {
                fence.validate(self)?;
            }
        }
        // App-wide listeners receive the same committed dimensions as Page
        // and Component hooks. Native retained dispatch never reads guest
        // aliases, and this notification exists without a current Page too.
        if let Err(error) =
            self.dispatch_lifecycle_notification("windowResize", &json!({"size": size}))
        {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        if let Err(error) = self.ensure_engine_execution_healthy() {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            self.append_browser_retirement_messages(messages);
            return Ok(());
        }
        if let Some(fence) = fence {
            fence.validate(self)?;
        }
        // Register subscriptions created by resize hooks before observing the
        // new media-query environment; then drain effects of their callbacks.
        if let Err(error) = self.append_engine_effects(messages) {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        if messages.iter().any(effect_continuation_stopped) {
            self.append_browser_retirement_messages(messages);
            return Ok(());
        }
        if let Some(fence) = fence {
            fence.validate(self)?;
        }
        if let Err(error) = self.notify_observers(messages) {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        if let Some(fence) = fence {
            fence.validate(self)?;
        }
        if let Err(error) = self.append_engine_effects(messages) {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        self.append_browser_retirement_messages(messages);
        if let Some(fence) = fence {
            fence.validate(self)?;
        }
        Ok(())
    }

    /// Poll host timers and emit one batched event for the callbacks that are
    /// due. Hosts call this from their event loop; the session never creates a
    /// thread per timer. Passing an explicit clock also makes timer behavior
    /// deterministic in headless conformance tests.
    pub fn poll_timers(&mut self, now_ns: u64) -> BridgeBatch {
        self.with_engine_batch_turn(None, |session| Ok(session.poll_timers_within_turn(now_ns)))
            .unwrap_or_else(|error| self.host_turn_failure_batch(&error, String::new(), op::ERROR))
    }

    fn poll_timers_within_turn(&mut self, now_ns: u64) -> BridgeBatch {
        #[cfg(feature = "testing")]
        let now_ns = self
            .testing_time_ms
            .map(|now| now.saturating_mul(1_000_000))
            .unwrap_or(now_ns);
        if !self.initialized {
            return BridgeBatch::new(Vec::new());
        }
        let timers = self.app_service.poll_timers(now_ns);
        let mut messages = Vec::new();
        if !timers.is_empty() {
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::EVENT_BATCH,
                json!({"type": "timer", "timers": timers}),
            ));
        }
        if self.engine_provider_available() {
            let timer_result = self.prepare_engine_environment().and_then(|()| {
                self.drain_engine_turn_scheduler(None)?;
                self.call_engine(
                    CallTarget::Global {
                        name: "__container_drain_timers".into(),
                    },
                    vec![json!(now_ns / 1_000_000)],
                )
            });
            match timer_result {
                Ok(fired) if !fired.is_empty() => {
                    let engine = match self.config.engine {
                        EngineKind::Quickjs => "quickjs",
                        EngineKind::V8 => "v8",
                    };
                    messages.push(BridgeEnvelope::event(
                        self.config.session_id.clone(),
                        op::EVENT_BATCH,
                        json!({"type": format!("{engine}.timer"), "timers": fired}),
                    ));
                }
                Ok(_) => {}
                Err(error) => messages.push(self.error_envelope(&error, String::new(), op::ERROR)),
            }
            if let Err(error) = self.reconcile_intersection_queries() {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if let Err(error) = self.reconcile_media_queries() {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if self.observer_observation_pending {
                if let Err(error) = self.notify_observers(&mut messages) {
                    messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                }
            }
            if let Err(error) = self.append_engine_effects(&mut messages) {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
        }
        self.append_browser_retirement_messages(&mut messages);
        if let Err(error) = self.poll_animation_samples() {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        BridgeBatch::new(messages)
    }

    /// Deliver one host-observed network transition to registered
    /// `wx.onNetworkStatusChange` listeners. The provider snapshot is updated
    /// first, then the JavaScript callbacks and their event trace are run in a
    /// single engine batch. Hosts should call this only after their platform
    /// network service has observed a real change; the sandbox remains fully
    /// deterministic because it accepts the typed [`NetworkType`] value.
    pub fn notify_network_status_change(
        &mut self,
        network_type: NetworkType,
    ) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.notify_network_status_change_within_turn(network_type)
        })
    }

    fn notify_network_status_change_within_turn(
        &mut self,
        network_type: NetworkType,
    ) -> Result<BridgeBatch, BridgeError> {
        if self.effective_capability("wx.onNetworkStatusChange") == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.onNetworkStatusChange is unsupported on this session",
            ));
        }
        self.provider
            .update_network_type(network_type)
            .map_err(provider_bridge_error)?;
        let status = json!({
            "networkType": network_type.as_str(),
            "isConnected": network_type != NetworkType::None,
        });
        self.sync_engine_storage()?;
        self.call_engine(
            CallTarget::Global {
                name: "__container_dispatch_network_status".into(),
            },
            vec![status.clone()],
        )?;
        let mut messages = vec![BridgeEnvelope::event(
            self.config.session_id.clone(),
            op::EVENT_BATCH,
            json!({"source": "host", "networkStatus": status}),
        )];
        self.append_engine_effects(&mut messages)?;
        Ok(BridgeBatch::new(messages))
    }

    /// Report whether the engine selected by this session is backed by a
    /// compiled provider.  A successfully constructed V8 session always has
    /// a live isolate; a QuickJS session remains available through the
    /// existing host/runtime path.
    pub fn engine_provider_available(&self) -> bool {
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine.as_ref().is_some_and(|engine| {
                        container_engine_quickjs::JsEngineAdapter::mode(engine)
                            == container_engine_quickjs::EngineMode::QuickJs
                    })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    // Headless sessions remain available without a native
                    // JS provider for manifest/protocol conformance tests.
                    false
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine.as_ref().is_some_and(|engine| {
                        container_engine_v8::JsEngineAdapter::mode(engine)
                            == container_engine_v8::EngineMode::V8
                    })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    false
                }
            }
        }
    }
    pub fn is_cancelled(&self, token: &str) -> bool {
        self.cancelled.get(token).copied().unwrap_or(false) || self.cancellation.is_cancelled(token)
    }

    /// Dispatch one bridge envelope and always return a batch. Protocol and
    /// operation errors are represented as structured response envelopes so a
    /// host never has to parse a Rust error string.
    pub fn dispatch(&mut self, envelope: BridgeEnvelope) -> BridgeBatch {
        match self.dispatch_result(envelope) {
            Ok(batch) => batch,
            Err(error) => {
                self.host_turn_failure_batch(&error.bridge_error(), String::new(), op::ERROR)
            }
        }
    }

    /// Fallible variant useful to bindings that need to distinguish malformed
    /// host calls before they enter the wire protocol.
    pub fn dispatch_result(
        &mut self,
        envelope: BridgeEnvelope,
    ) -> Result<BridgeBatch, SessionError> {
        use browser_transaction_finals::{
            BrowserTransactionAdmission, BrowserTransactionFinalLimits, BrowserTransactionFinals,
        };
        if envelope.op == op::VIEW_LIVE_CONSUME {
            return Ok(self.dispatch_live_consumption(&envelope));
        }
        if self.requires_consumable_enable_dispatch(&envelope) {
            return self.dispatch_consumable_live_enable(envelope);
        }
        if !matches!(
            envelope.op.as_str(),
            op::VIEW_LIVE_PREPARE
                | op::VIEW_LIVE_PERMIT
                | op::VIEW_LIVE_PRESENTED
                | op::VIEW_LIVE_ABORT
        ) {
            return self.dispatch_result_unretained(envelope);
        }
        // A nested batch turn cannot yet seal an individual full outer final.
        // Reject before reservation/storage sync/JavaScript rather than cache
        // an inner handler result and silently lose late effects.
        let admission = (|| {
            if self.engine_turn_deadline.is_some() {
                return Err(BridgeError::protocol(
                    "live-document transactions require a standalone owner turn",
                ));
            }
            let epoch = self.live_browser_request_epoch(&envelope)?;
            if self.browser_live_finals.is_none() {
                self.browser_live_finals = Some((
                    epoch,
                    BrowserTransactionFinals::new(
                        self.config.session_id.clone(),
                        epoch,
                        BrowserTransactionFinalLimits::default(),
                    )?,
                ));
            }
            let (previous, finals) = self.browser_live_finals.as_mut().expect("installed finals");
            if *previous != epoch {
                finals.retire_epoch(epoch)?;
                *previous = epoch;
            }
            finals.reserve(epoch, &envelope, 512 * 1024)
        })();
        let reservation = match admission {
            Ok(BrowserTransactionAdmission::Replay(batch)) => return Ok(batch),
            Ok(BrowserTransactionAdmission::Execute(reservation)) => reservation,
            Ok(BrowserTransactionAdmission::Pending) => {
                return Ok(self.host_turn_failure_batch(
                    &BridgeError::new(
                        BridgeErrorCode::Render,
                        "live document transaction is already pending; no code was executed",
                    ),
                    envelope.request_id,
                    envelope.op.as_str(),
                ));
            }
            Err(error) => {
                return Ok(self.host_turn_failure_batch(
                    &error,
                    envelope.request_id,
                    envelope.op.as_str(),
                ));
            }
        };
        let request_id = envelope.request_id.clone();
        let operation = envelope.op.clone();
        let mut batch = match self.dispatch_result_unretained(envelope) {
            Ok(batch) => batch,
            Err(error) => {
                self.browser_live_finals
                    .as_mut()
                    .expect("reserved finals")
                    .1
                    .mark_indeterminate(reservation)
                    .map_err(|error| SessionError::Protocol(error.to_string()))?;
                return Err(error);
            }
        };
        if let Err(error) = self
            .browser_live_finals
            .as_mut()
            .expect("reserved finals")
            .1
            .seal_complete_turn(reservation, &mut batch)
        {
            // Report retention failure as this operation's actual final, while
            // preserving its irreversible result and all already consumed
            // effects. A client must not mistake an uncached success for a
            // recoverable transaction; retry remains indeterminate.
            let original = batch
                .messages
                .iter()
                .position(|message| {
                    message.kind == EnvelopeKind::Response
                        && message.request_id == request_id
                        && message.op == operation
                })
                .map(|index| batch.messages.remove(index).payload);
            let mut failure = self.error_envelope(&error, request_id, &operation);
            if let Some(original) = original {
                if original.get("committed") == Some(&Value::Bool(true)) {
                    failure.payload["committed"] = Value::Bool(true);
                    if let Some(key) = original.get("key") {
                        failure.payload["key"] = key.clone();
                    }
                }
                failure.payload["originalResult"] = original;
            }
            batch.messages.push(failure);
        }
        Ok(batch)
    }

    fn dispatch_result_unretained(
        &mut self,
        envelope: BridgeEnvelope,
    ) -> Result<BridgeBatch, SessionError> {
        if let Err(error) = envelope.validate() {
            return Ok(BridgeBatch::new(vec![self.error_envelope(
                &error,
                envelope.request_id.clone(),
                op::ERROR,
            )]));
        }
        if envelope.session_id != self.config.session_id {
            let error = BridgeError::invalid(format!(
                "sessionId mismatch: expected {}, got {}",
                self.config.session_id, envelope.session_id
            ));
            return Ok(BridgeBatch::new(vec![self.error_envelope(
                &error,
                envelope.request_id.clone(),
                op::ERROR,
            )]));
        }
        let peer = ProtocolVersion::parse(&envelope.protocol_version)
            .map_err(|e| SessionError::Protocol(e.to_string()))?;
        if negotiate_protocol(self.protocol.clone(), peer).is_err() {
            let error = BridgeError::protocol(format!(
                "incompatible protocol: session {}, peer {}",
                self.protocol, envelope.protocol_version
            ));
            return Ok(BridgeBatch::new(vec![self.error_envelope(
                &error,
                envelope.request_id.clone(),
                op::ERROR,
            )]));
        }
        if envelope.deadline_ns.is_some_and(deadline_expired) {
            let error = BridgeError::new(
                BridgeErrorCode::Timeout,
                "bridge request deadline has expired",
            );
            return Ok(BridgeBatch::new(vec![self.error_envelope(
                &error,
                envelope.request_id.clone(),
                &envelope.op,
            )]));
        }
        if let Some(token) = envelope.cancel_token.as_deref() {
            if self.is_cancelled(token) && envelope.op != op::CANCEL {
                let error = BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    format!("request cancelled by token {token}"),
                );
                return Ok(BridgeBatch::new(vec![self.error_envelope(
                    &error,
                    envelope.request_id.clone(),
                    &envelope.op,
                )]));
            }
        }
        // Synchronize sticky Rust-only fault state without executing JS. A
        // diagnostic/control receipt remains available on an interrupted realm.
        if matches!(
            envelope.op.as_str(),
            op::CANCEL | op::DIAGNOSTIC | op::ERROR
        ) {
            let _ = self.ensure_engine_execution_healthy();
        }
        let control = match envelope.op.as_str() {
            op::CANCEL if self.engine_execution_is_faulted() => Some(self.handle_cancel(&envelope)),
            op::DIAGNOSTIC if is_restricted_showcase() => Some(Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "debug diagnostics are disabled in this distribution",
            ))),
            op::DIAGNOSTIC => Some(self.handle_diagnostic(&envelope)),
            op::ERROR => Some(self.handle_error_passthrough(&envelope)),
            _ => None,
        };
        if let Some(result) = control {
            let mut batch = match result {
                Ok(messages) => BridgeBatch::new(messages),
                Err(error) => BridgeBatch::new(vec![self.error_envelope(
                    &error,
                    envelope.request_id.clone(),
                    &envelope.op,
                )]),
            };
            self.append_browser_retirement_messages(&mut batch.messages);
            return Ok(batch);
        }
        let result = self.with_engine_batch_turn(Some(&envelope), |session| {
            session.dispatch_within_turn(&envelope)
        });
        self.retire_faulted_view_authority();
        Ok(result.unwrap_or_else(|error| {
            self.host_turn_failure_batch(&error, envelope.request_id.clone(), &envelope.op)
        }))
    }

    fn dispatch_within_turn(
        &mut self,
        envelope: &BridgeEnvelope,
    ) -> Result<BridgeBatch, BridgeError> {
        if is_restricted_showcase()
            && matches!(envelope.op.as_str(), op::MODULE_CALL | op::DIAGNOSTIC)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "debug module calls and diagnostics are disabled in this distribution",
            ));
        }
        // Install the request scope before any engine call: importing storage
        // may itself drain microtasks that enqueue asynchronous work.
        let previous_view_deadline = self.view_deadline_ns.replace(envelope.deadline_ns);
        let previous_cancel_token =
            std::mem::replace(&mut self.bridge_cancel_token, envelope.cancel_token.clone());
        // Every host turn can execute JavaScript (events, lifecycle and
        // component hooks included), so import the authoritative storage
        // state at this boundary rather than only before module.call.
        let storage_sync = if self.initialized && self.engine_provider_available() {
            self.sync_engine_storage()
        } else {
            Ok(())
        };
        let result = storage_sync.and_then(|()| match envelope.op.as_str() {
            op::APP_INIT => self.handle_init(envelope),
            op::APP_LIFECYCLE => self.handle_lifecycle(envelope),
            op::PAGE_PUSH => self.handle_page_push(envelope),
            op::PAGE_POP => self.handle_page_pop(envelope),
            op::PAGE_REPLACE => self.handle_page_replace(envelope),
            op::DATA_PATCH_BATCH => self.handle_data_patch(envelope),
            op::EVENT_BATCH => self.handle_event_batch(envelope),
            op::RENDER_COMMIT => self.handle_render_commit(envelope),
            op::VIEW_PREPARE
            | op::VIEW_PREPARE_COMMIT
            | op::VIEW_PRESENTED
            | op::VIEW_ABORT
            | op::VIEW_GEOMETRY
            | op::VIEW_EVENTS
            | op::VIEW_ANIMATION_BASELINE
            | op::VIEW_SAMPLE_PREPARE
            | op::VIEW_SAMPLE_PRESENTED
            | op::VIEW_SAMPLE_ABORT
            | op::VIEW_LIVE_ENABLE
            | op::VIEW_LIVE_PREPARE
            | op::VIEW_LIVE_PERMIT
            | op::VIEW_LIVE_PRESENTED
            | op::VIEW_LIVE_ABORT => self.handle_browser_operation(envelope),
            op::VIEW_QUERY_ENABLE | op::VIEW_QUERY_RESULT => {
                self.handle_browser_query_operation(envelope)
            }
            op::COMPONENT_MOUNT => self.handle_component_mount(envelope),
            op::COMPONENT_UPDATE => self.handle_component_update(envelope),
            op::COMPONENT_UNMOUNT => self.handle_component_unmount(envelope),
            op::API_CALL => self.handle_api_call(envelope),
            op::API_RESULT => self.handle_api_result(envelope),
            op::MODULE_LOAD => self.handle_module_load(envelope),
            op::MODULE_CALL => self.handle_module_call(envelope),
            op::CANCEL => self.handle_cancel(envelope),
            op::DIAGNOSTIC => self.handle_diagnostic(envelope),
            op::ERROR => self.handle_error_passthrough(envelope),
            op::HOST_MESSAGE => self
                .send_host_message(envelope.payload.clone())
                .map(|batch| {
                    let mut messages =
                        vec![self.response(envelope, json!({"ok":true,"accepted":true}))];
                    messages.extend(batch.messages);
                    messages
                }),
            _ => Err(BridgeError::invalid(format!(
                "unknown bridge operation: {}",
                envelope.op
            ))),
        });
        let mut batch = match result {
            Ok(messages) => BridgeBatch::new(messages),
            Err(error) => {
                let mut messages =
                    vec![self.error_envelope(&error, envelope.request_id.clone(), &envelope.op)];
                // JavaScript writes before a thrown exception remain committed.
                // Drain the batch even on failure so the host store cannot lag
                // behind the engine after a partially executed module or hook.
                if let Err(effect_error) = self
                    .ensure_engine_execution_healthy()
                    .and_then(|()| self.append_engine_effects(&mut messages))
                {
                    messages.push(self.error_envelope(
                        &effect_error,
                        envelope.request_id.clone(),
                        op::ERROR,
                    ));
                }
                BridgeBatch::new(messages)
            }
        };
        self.append_browser_retirement_messages(&mut batch.messages);
        self.view_deadline_ns.set(previous_view_deadline);
        self.bridge_cancel_token = previous_cancel_token;
        Ok(batch)
    }

    pub fn dispatch_batch(&mut self, batch: BridgeBatch) -> BridgeBatch {
        if batch.messages.iter().any(|message| {
            matches!(
                message.op.as_str(),
                op::VIEW_LIVE_ENABLE
                    | op::VIEW_LIVE_PREPARE
                    | op::VIEW_LIVE_PERMIT
                    | op::VIEW_LIVE_PRESENTED
                    | op::VIEW_LIVE_ABORT
                    | op::VIEW_LIVE_CONSUME
            )
        }) {
            return BridgeBatch::new(batch.messages.iter().map(|message|self.error_envelope(&BridgeError::protocol("live-document transactions require standalone owner turns; batch was not executed"),message.request_id.clone(),&message.op)).collect());
        }
        // Pure control messages remain usable after interruption and do not
        // need a realm lease. All executable requests share one outer limit.
        if self.engine_execution_is_faulted()
            || batch.messages.iter().all(|message| {
                matches!(message.op.as_str(), op::CANCEL | op::DIAGNOSTIC | op::ERROR)
            })
        {
            return self.dispatch_batch_within_turn(batch);
        }
        self.with_engine_batch_turn(
            None,
            |session| Ok(session.dispatch_batch_within_turn(batch)),
        )
        .unwrap_or_else(|error| self.host_turn_failure_batch(&error, String::new(), op::ERROR))
    }

    fn dispatch_batch_within_turn(&mut self, batch: BridgeBatch) -> BridgeBatch {
        let mut output = Vec::new();
        for envelope in batch.messages {
            output.extend(self.dispatch(envelope).messages);
        }
        BridgeBatch::new(output)
    }

    /// Convenience adapter for FFI layers that expose a plain vector rather
    /// than the bridge crate's wrapper type.
    pub fn dispatch_messages(&mut self, envelope: BridgeEnvelope) -> Vec<BridgeEnvelope> {
        self.dispatch(envelope).messages
    }

    fn response(&self, request: &BridgeEnvelope, payload: Value) -> BridgeEnvelope {
        BridgeEnvelope {
            protocol_version: self.protocol.to_string(),
            session_id: self.config.session_id.clone(),
            request_id: request.request_id.clone(),
            kind: EnvelopeKind::Response,
            op: request.op.clone(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: request.trace_id.clone(),
            payload,
        }
    }

    fn diagnostic(
        &self,
        request: &BridgeEnvelope,
        level: &str,
        message: impl Into<String>,
        data: Value,
    ) -> BridgeEnvelope {
        BridgeEnvelope {
            protocol_version: self.protocol.to_string(),
            session_id: self.config.session_id.clone(),
            request_id: String::new(),
            kind: EnvelopeKind::Event,
            op: op::DIAGNOSTIC.into(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: request.trace_id.clone(),
            payload: json!({"level": level, "message": message.into(), "data": data}),
        }
    }

    fn error_envelope(
        &self,
        error: &BridgeError,
        request_id: String,
        operation: &str,
    ) -> BridgeEnvelope {
        let mut error = error.clone();
        if error.request_id.is_none() && !request_id.is_empty() {
            error.request_id = Some(request_id.clone());
        }
        let mut payload = json!({"ok": false, "error": error});
        if self.engine_execution_is_faulted() {
            payload["requiresRestart"] = Value::Bool(true);
        }
        if operation == op::RENDER_COMMIT {
            // A render error returned through dispatch rejected the frame
            // before publication. Post-publication failures are diagnostics
            // emitted by handle_render_commit alongside its success response.
            payload["committed"] = json!(false);
        }
        BridgeEnvelope {
            protocol_version: self.protocol.to_string(),
            session_id: self.config.session_id.clone(),
            request_id,
            kind: EnvelopeKind::Response,
            op: operation.into(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: None,
            payload,
        }
    }

    fn handle_init(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        let incoming_launch_options = if let Some(value) = request.payload.get("launchOptions") {
            if !value.is_object() {
                return Err(BridgeError::invalid(
                    "app.init launchOptions must be an object",
                ));
            }
            Some(value.clone())
        } else {
            None
        };
        if let Some(value) = request.payload.get("manifest") {
            let incoming: ContainerManifestV1 = serde_json::from_value(value.clone())
                .map_err(|e| BridgeError::new(BridgeErrorCode::InvalidManifest, e.to_string()))?;
            incoming
                .validate()
                .map_err(|e| BridgeError::new(BridgeErrorCode::InvalidManifest, e.to_string()))?;
            if incoming.integrity.root != self.manifest.integrity.root {
                return Err(BridgeError::new(
                    BridgeErrorCode::InvalidManifest,
                    "app.init manifest does not match the loaded session",
                ));
            }
        }
        // View scripts belong to a separate execution realm. Verify their
        // content-addressed sources and legacy WXML before any AppService
        // module can run; never submit WXS to the AppService module loader.
        if let Some(blobs) = request.payload.get("blobs") {
            let blobs = decode_render_blobs(Some(blobs))?;
            self.validate_view_resources(&blobs)?;
            self.render_blobs = Arc::new(blobs);
            self.render_resources_verified = true;
        } else {
            self.validate_view_resources(&self.render_blobs)?;
        }
        self.ensure_view_execution_supported()
            .map_err(|error| error.bridge_error())?;
        if self.view_execution.borrow().is_available() {
            let budget = self.view_execution_budget();
            #[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
            let started = std::time::Instant::now();
            #[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
            let started = web_time::Instant::now();
            let mut view = self.view_execution.borrow_mut();
            view.prepare_verified_modules(&self.manifest, &self.render_blobs, &budget)?;
            if self.manifest.view_compilation.is_some() || self.manifest.modern_view.is_some() {
                // Validate the complete executable/document registry before
                // AppService modules or launch hooks run. An empty frontier
                // compiles expressions but never instantiates WXS scopes.
                let templates = self
                    .manifest
                    .templates
                    .iter()
                    .map(|template| {
                        let bytes = lookup_render_blob(&self.render_blobs, &template.wxml_ast)?;
                        let hash = template.wxml_ast.strip_prefix("sha256:").unwrap();
                        if container_ir::hex_digest(bytes) != hash {
                            return Err(BridgeError::new(
                                BridgeErrorCode::Render,
                                format!("template {} SHA-256 mismatch", template.id),
                            ));
                        }
                        let ast = decode_wxml(bytes).map_err(|error| {
                            BridgeError::new(BridgeErrorCode::Render, error.to_string())
                        })?;
                        Ok((template.id.clone(), ast))
                    })
                    .collect::<Result<BTreeMap<_, _>, BridgeError>>()?;
                view.render_documents(
                    &self.manifest,
                    &templates,
                    &[],
                    &view_execution::remaining_budget(started, &budget)?,
                )?;
            }
        }
        if let Some(value) = incoming_launch_options {
            self.launch_options = value;
        }
        // Install the negotiated capability map and synchronous provider
        // snapshot before evaluating any app module. Generated bundles are
        // allowed to call getSystemInfoSync at module scope, so doing this
        // only after module loading would expose an observable race.
        self.prepare_engine_environment()?;
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        self.install_host_services_bridge()?;
        // A host may include the content-addressed module bytes in the
        // handshake.  This keeps app startup a single batch boundary while
        // retaining the explicit `module.load` operation for lazy loading.
        if let Some(modules) = request.payload.get("modules") {
            self.load_modules_value(modules)?;
        }
        if !self.pending_initialization_roots.is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!(
                    "app.init requires an explicit module retry to complete eager roots: {}",
                    self.pending_initialization_roots
                        .iter()
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            ));
        }
        // A failed module evaluation leaves its verified factory available
        // for retry. Omitting the module batch must not turn those unevaluated
        // route factories into an initialized application.
        self.resolve_loaded_page_modules()?;
        self.initialized = true;
        self.prepare_engine_environment()?;
        let mut app_launch_result = Value::Null;
        // Generated mini-program bundles register App(...) while app.js is
        // evaluated.  When a real engine and the entry module are available,
        // dispatch the standard onLaunch hook through the same batch engine
        // boundary used by module.call.  Headless/protocol sessions keep the
        // old handshake semantics and simply report no hook invocation.
        if !self.app_launch_invoked
            && self.engine_provider_available()
            && self.entry_module_evaluated()
        {
            let launch_options = self.launch_options.clone();
            match self.call_engine(
                CallTarget::Global {
                    name: "__container_invoke_app".into(),
                },
                vec![json!("onLaunch"), json!([launch_options])],
            ) {
                Ok(values) => {
                    app_launch_result = values.into_iter().next().unwrap_or(Value::Null);
                    self.app_launch_invoked = true;
                }
                Err(error) => {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        format!("App.onLaunch failed: {error}"),
                    ));
                }
            }
        }
        let registration = if self.engine_provider_available() && self.entry_module_evaluated() {
            self.call_engine(
                CallTarget::Global {
                    name: "__container_registration_snapshot".into(),
                },
                Vec::new(),
            )
            .ok()
            .and_then(|values| values.into_iter().next())
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        let response = self.response(
            request,
            json!({
                "ok": true,
                "sessionId": self.config.session_id,
                "protocolVersion": self.protocol.to_string(),
                "engine": self.config.engine,
                "engineProviderAvailable": self.engine_provider_available(),
                "loadedModules": self.loaded_modules.len(),
                "appLaunchInvoked": self.app_launch_invoked,
                "appLaunchResult": app_launch_result,
                "registration": registration,
                "host": self.config.host,
                "manifest": {"schemaVersion": self.manifest.schema_version, "integrity": self.manifest.integrity.root},
                "capabilities": self.effective_capabilities(),
            }),
        );
        let diagnostic = self.diagnostic(
            request,
            "info",
            "session initialized",
            json!({"engine": self.config.engine, "engineProviderAvailable": self.engine_provider_available(), "host": self.config.host.kind}),
        );
        let mut messages = vec![response, diagnostic];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn entry_module_evaluated(&self) -> bool {
        let entry = self.manifest.app.entry_module.trim();
        self.loaded_modules.iter().any(|(id, module)| {
            module.evaluated
                && (id == entry
                    || id == &format!("module:{entry}")
                    || id.strip_prefix("module:") == Some(entry))
        })
    }

    fn page_registration_index(&self, path: &str) -> usize {
        if let Some(index) = self.page_module_indices.get(path) {
            return *index;
        }
        self.manifest
            .routes
            .iter()
            .position(|route| route.path == path)
            .unwrap_or_else(|| self.app_service.pages().len().saturating_sub(1))
    }

    fn bind_page_registration(&mut self, path: &str, id: PageId) {
        let index = self.page_registration_index(path);
        self.page_registration_ids.insert(id, index);
        self.page_bindings.insert(index, id);
    }

    fn page_registration_index_for_id(&self, path: &str, id: PageId) -> usize {
        self.page_registration_ids
            .get(&id)
            .copied()
            .unwrap_or_else(|| self.page_registration_index(path))
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn page_id_for_registration(&self, index: usize) -> Option<PageId> {
        self.page_bindings.get(&index).copied()
    }

    fn unbind_page(&mut self, id: PageId) -> Result<(), BridgeError> {
        self.animation_writes.retire_page(id.0);
        self.animation_bindings.retire_page(id.0);
        self.animation_playback.retire_page(id.0);
        self.pending_native_animations = None;
        let contacts = self.cancel_browser_contacts_for_page(id, "page-unbound");
        self.invalidate_browser_page(id);
        contacts?;
        self.scrolling.release_page(id);
        self.observers.borrow_mut().release_page(id);
        self.component_visible_pages.remove(&id);
        self.dispose_page_components(id)?;
        self.page_initial_data.remove(&id);
        let index = self.page_registration_ids.remove(&id);
        let Some(index) = index else {
            self.page_bindings.retain(|_, bound| *bound != id);
            return Ok(());
        };
        if self.page_bindings.get(&index) != Some(&id) {
            return Ok(());
        }
        // If another instance of the same route remains on the stack, keep
        // that instance as the registration fallback for legacy bridge calls
        // that only carry a registration index. Prefer the visible stack and
        // then a cached tab, preserving the most recently pushed duplicate.
        let replacement = self
            .app_service
            .pages()
            .iter()
            .rev()
            .find(|page| self.page_registration_ids.get(&page.id) == Some(&index))
            .map(|page| page.id)
            .or_else(|| {
                self.cached_tabs
                    .values()
                    .rev()
                    .find(|page| self.page_registration_ids.get(&page.id) == Some(&index))
                    .map(|page| page.id)
            });
        if let Some(replacement) = replacement {
            self.page_bindings.insert(index, replacement);
        } else {
            self.page_bindings.remove(&index);
        }
        Ok(())
    }

    fn is_tab_route(&self, path: &str) -> bool {
        self.manifest
            .routes
            .iter()
            .any(|route| route.path == path && route.kind == container_ir::RouteKind::Tab)
    }

    /// Switch the visible root to a tab page while preserving tab instances.
    /// Non-tab pages are disposed from the top of the stack; the tab root is
    /// hidden and moved to `cached_tabs`, retaining its data and page id.
    /// Returning the hook values lets both the bridge API path and native
    /// engine effect path expose one identical lifecycle result.
    fn switch_tab_page(
        &mut self,
        path: &str,
        query: Option<&Value>,
    ) -> Result<(PageId, Value), BridgeError> {
        let previous = self.app_service.pages().iter().cloned().collect::<Vec<_>>();
        let current_id = previous.last().map(|page| page.id);
        let mut on_unload = Vec::new();
        let mut on_hide = Vec::new();
        // A page stack normally contains one tab root followed by zero or
        // more non-tab pages. Walking from the top mirrors WeChat's teardown
        // order when switchTab closes a nested page stack.
        for page in previous.iter().rev() {
            if self.is_tab_route(&page.path) {
                // A tab root beneath a pushed page is already hidden by the
                // preceding navigateTo. Only the currently visible tab gets
                // another onHide notification during switchTab.
                if current_id == Some(page.id) {
                    on_hide.push(self.invoke_page_hook_for_id(page.id, "onHide", Vec::new())?);
                }
            } else {
                on_unload.push(self.invoke_page_hook_for_id(page.id, "onUnload", Vec::new())?);
            }
        }

        let active = self.app_service.pages_mut().take_all();
        let mut target = None;
        for page in active {
            if page.path == path && self.is_tab_route(&page.path) {
                target = Some(page);
            } else if self.is_tab_route(&page.path) {
                // Keep a hidden tab registration alive for future switchTab.
                self.cached_tabs.insert(page.path.clone(), page);
            } else {
                self.unbind_page(page.id)?;
            }
        }
        if target.is_none() {
            target = self.cached_tabs.remove(path);
        } else {
            // An active target shadows an older cache entry left by a host
            // restart; retaining only the current PageEntry avoids ambiguity.
            self.cached_tabs.remove(path);
        }

        let (id, on_load, on_show, on_ready) = if let Some(entry) = target {
            let id = entry.id;
            self.app_service.pages_mut().activate_entry(entry);
            self.bind_page_registration(path, id);
            self.commit_navigation_geometry()?;
            let on_show = self.invoke_page_hook_for_id(id, "onShow", Vec::new())?;
            (id, Value::Null, on_show, Value::Null)
        } else {
            let id = self
                .app_service
                .push_page(path)
                .map_err(|error| runtime_error(error, BridgeErrorCode::InvalidRequest))?;
            self.bind_page_registration(path, id);
            set_query(&mut self.app_service, id, query)?;
            self.commit_navigation_geometry()?;
            let query_value = self.page_query_value(id);
            let on_load = self.invoke_page_hook_for_id(id, "onLoad", vec![query_value])?;
            let on_show = self.invoke_page_hook_for_id(id, "onShow", Vec::new())?;
            let on_ready = self.invoke_page_hook_for_id(id, "onReady", Vec::new())?;
            (id, on_load, on_show, on_ready)
        };
        Ok((
            id,
            json!({
                "onUnload": Value::Array(on_unload),
                "onHide": Value::Array(on_hide),
                "onLoad": on_load,
                "onShow": on_show,
                "onReady": on_ready,
            }),
        ))
    }

    fn page_query_value(&self, id: PageId) -> Value {
        self.app_service
            .pages()
            .get(id)
            .map(|page| {
                page.query
                    .iter()
                    .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                    .collect::<Map<String, Value>>()
            })
            .map(Value::Object)
            .unwrap_or_else(|| json!({}))
    }

    /// Both navigation entrypoints release every page owned by reLaunch.
    /// Keep the established active-stack hook order, then release hidden
    /// cached tabs exactly once before their registration metadata is cleared.
    fn unload_all_pages(&mut self) -> Result<(), BridgeError> {
        let active = self.app_service.pages().iter().cloned().collect::<Vec<_>>();
        let cached = self
            .cached_tabs
            .values()
            .filter(|page| !active.iter().any(|entry| entry.id == page.id))
            .cloned()
            .collect::<Vec<_>>();
        for page in active.iter().rev().chain(cached.iter()) {
            self.invoke_page_hook_for_id(page.id, "onUnload", Vec::new())?;
        }
        // Also release a graph retained by an earlier failed navigation. The
        // normal concrete onUnload path already disposed its own graph.
        for page in self.component_pages.keys().copied().collect::<Vec<_>>() {
            self.dispose_page_components(page)?;
        }
        self.app_service.pages_mut().clear();
        self.page_bindings.clear();
        self.page_registration_ids.clear();
        self.page_initial_data.clear();
        self.cached_tabs.clear();
        self.component_visible_pages.clear();
        Ok(())
    }

    fn invoke_page_hook(
        &mut self,
        index: usize,
        name: &str,
        args: ValueBatch,
    ) -> Result<Value, BridgeError> {
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(Value::Null);
        }
        self.sync_current_pages()?;
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_invoke_page".into(),
            },
            vec![json!(index), json!(name), Value::Array(args)],
        )?;
        Ok(values.into_iter().next().unwrap_or(Value::Null))
    }

    /// Invoke a lifecycle hook on a concrete page instance.  Registration
    /// indices identify a `Page({...})` definition, but the same route can be
    /// pushed repeatedly and each stack entry must retain its own `data`,
    /// `options`, identity and pending `setData` effects.
    fn invoke_page_hook_for_id(
        &mut self,
        id: PageId,
        name: &str,
        args: ValueBatch,
    ) -> Result<Value, BridgeError> {
        if matches!(name, "onHide" | "onUnload") {
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            self.retire_native_queries(Some(id), "native selector page was hidden or unloaded");
            let contacts = self.cancel_touches_for_page(id, name);
            self.invalidate_browser_page(id);
            contacts?;
        }
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(Value::Null);
        }
        let index = self
            .app_service
            .pages()
            .get(id)
            .map(|page| self.page_registration_index_for_id(&page.path, id))
            .or_else(|| {
                self.cached_tabs
                    .values()
                    .find(|page| page.id == id)
                    .map(|page| self.page_registration_index_for_id(&page.path, id))
            })
            .unwrap_or(0);
        self.invoke_page_hook_for_id_with_index(id, index, name, args)
    }

    fn invoke_page_hook_for_id_with_index(
        &mut self,
        id: PageId,
        index: usize,
        name: &str,
        args: ValueBatch,
    ) -> Result<Value, BridgeError> {
        if matches!(name, "onHide" | "onUnload") {
            #[cfg(feature = "conformance-observation")]
            self.conformance_guests.retire_activation();
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            self.retire_native_queries(Some(id), "native selector page was hidden or unloaded");
            let contacts = self.cancel_touches_for_page(id, name);
            self.invalidate_browser_page(id);
            contacts?;
        }
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(Value::Null);
        }
        if matches!(name, "onLoad" | "onShow" | "onHide" | "onUnload") {
            // Renderer overrides may change as navigation activates a page.
            // Refresh the synchronous JS facade before its lifecycle hooks.
            self.sync_engine_capabilities()?;
        }
        self.sync_current_pages()?;
        if name == "onLoad" {
            self.prepare_page_components(id)?;
        }
        if name == "onReady" && self.defer_component_page_ready(id, index) {
            return Ok(Value::Null);
        }
        let unload_notification = if name == "onUnload" {
            self.before_page_unload(id)?
        } else {
            None
        };
        let hook_result = self.call_engine(
            CallTarget::Global {
                name: "__container_invoke_page_instance".into(),
            },
            vec![json!(id.0), json!(index), json!(name), Value::Array(args)],
        );
        let visibility_result = if name == "onShow" {
            // The stack already owns this page. Preserve that committed
            // visibility even if its onShow throws. A background navigation
            // still waits for App show before notifying its components.
            let visible = !matches!(
                self.app_service.lifecycle().state(),
                container_core::LifecycleState::Background
                    | container_core::LifecycleState::Destroyed
            );
            self.set_component_page_visibility(id, visible)
        } else {
            Ok(())
        };
        // Cleanup belongs to the committed transition, even when user code
        // throws. Keep the original hook error while finishing retirement.
        let cleanup_result = match name {
            "onHide" => self.set_component_page_visibility(id, false),
            "onUnload" => {
                self.component_visible_pages.remove(&id);
                // Some navigation paths unbind before this hook, others
                // unload then replace the stack. Disposal is idempotent and
                // closes the latter path without moving existing hooks.
                self.dispose_page_components(id)
            }
            _ => Ok(()),
        };
        let notification_result = if name == "onUnload" && cleanup_result.is_ok() {
            self.after_page_unload(unload_notification)
        } else {
            Ok(())
        };
        let values = hook_result?;
        visibility_result?;
        cleanup_result?;
        notification_result?;
        Ok(values.into_iter().next().unwrap_or(Value::Null))
    }

    fn set_component_page_visibility(
        &mut self,
        page: PageId,
        visible: bool,
    ) -> Result<(), BridgeError> {
        self.ensure_component_page_reusable(page)?;
        let previous = self.component_visible_pages.insert(page, visible);
        if previous.unwrap_or(false) == visible {
            return Ok(());
        }
        self.animation_bindings.set_visibility(page.0, visible);
        self.animation_playback
            .set_visibility(page.0, visible, self.animation_clock.now())?;
        self.pending_native_animations = None;
        // Consume the transition before user code. The engine separately
        // consumes each occurrence's hook before invoking it, so a thrown
        // hook cannot cause a later render or repeated host event to replay.
        self.dispatch_component_page_lifetime(
            page,
            if visible { "show" } else { "hide" },
            Vec::new(),
        )
    }

    /// Keep the JavaScript `getCurrentPages()` view aligned with the Rust page
    /// stack before invoking a page lifecycle hook.  The engine receives only
    /// registration indices and serializable route/query metadata; page
    /// objects themselves stay inside the isolate so callers retain identity,
    /// `setData`, and page methods without a per-property bridge round trip.
    fn sync_current_pages(&mut self) -> Result<(), BridgeError> {
        if self.navigation_layout.enabled {
            return self.sync_current_pages_trusted();
        }
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        {
            Ok(())
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        {
            let metadata = self
                .app_service
                .pages()
                .iter()
                .map(|page| {
                    let index = self.page_registration_index_for_id(&page.path, page.id);
                    let options = page
                        .query
                        .iter()
                        .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                        .collect::<Map<String, Value>>();
                    json!({
                        "index": index,
                        "instanceId": page.id.0,
                        "route": page.path,
                        "options": Value::Object(options),
                        "data": self.page_initial_data.get(&page.id),
                    })
                })
                .collect::<Vec<_>>();
            let indices = metadata
                .iter()
                .filter_map(|entry| entry.get("index").cloned())
                .collect::<Vec<_>>();
            let snapshots = self.call_engine(
                CallTarget::Global {
                    name: "__container_set_current_pages".into(),
                },
                vec![Value::Array(indices), Value::Array(metadata)],
            )?;
            for snapshot in snapshots
                .iter()
                .filter_map(|value| value.get("created"))
                .filter_map(Value::as_array)
                .flatten()
            {
                let Some(id) = snapshot
                    .get("instanceId")
                    .and_then(Value::as_u64)
                    .map(PageId)
                else {
                    continue;
                };
                if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                    page.data = snapshot.get("data").cloned().unwrap_or_else(|| json!({}));
                    self.page_initial_data.remove(&id);
                }
            }
            Ok(())
        }
    }

    fn invoke_app_hook(&mut self, name: &str, args: ValueBatch) -> Result<Value, BridgeError> {
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(Value::Null);
        }
        let notification = match name {
            "onShow" => Some("show"),
            "onHide" => Some("hide"),
            _ => None,
        };
        let notification_payload = args.first().cloned().unwrap_or_else(|| json!({}));
        let hook_result = self.call_engine(
            CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![json!(name), Value::Array(args)],
        );
        // The lifecycle transition already happened. App hook failures do not
        // suppress independently registered app-wide listeners.
        let notification_result = notification
            .map(|kind| self.dispatch_lifecycle_notification(kind, &notification_payload))
            .transpose();
        let values = hook_result?;
        notification_result?;
        Ok(values.into_iter().next().unwrap_or(Value::Null))
    }

    fn invoke_page_path_hook(
        &mut self,
        path: &str,
        name: &str,
        args: ValueBatch,
    ) -> Result<Value, BridgeError> {
        let page_id = self
            .app_service
            .pages()
            .iter()
            .rev()
            .find(|page| page.path == path)
            .map(|page| page.id);
        if let Some(page_id) = page_id {
            return self.invoke_page_hook_for_id(page_id, name, args);
        }
        let index = self.page_registration_index(path);
        self.invoke_page_hook(index, name, args)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn event_page_registration_index(&self, value: &Value) -> usize {
        let Some(object) = value.as_object() else {
            return self
                .app_service
                .pages()
                .current()
                .map(|page| self.page_registration_index(&page.path))
                .unwrap_or(0);
        };
        if let Some(index) = object
            .get("pageIndex")
            .or_else(|| object.get("page_index"))
            .and_then(Value::as_u64)
        {
            return index as usize;
        }
        if let Some(page_id) = object
            .get("pageId")
            .or_else(|| object.get("page_id"))
            .and_then(Value::as_u64)
            .map(PageId)
        {
            if let Some((index, _)) = self
                .page_bindings
                .iter()
                .find(|(_, bound)| **bound == page_id)
            {
                return *index;
            }
        }
        self.app_service
            .pages()
            .current()
            .map(|page| self.page_registration_index(&page.path))
            .unwrap_or(0)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn invoke_page_event(&mut self, index: usize, event: Value) -> Result<Value, BridgeError> {
        self.invoke_page_event_with_error_policy(index, event, EventHandlerErrorPolicy::Report)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn invoke_page_event_with_error_policy(
        &mut self,
        index: usize,
        event: Value,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<Value, BridgeError> {
        if !self.engine_provider_available() || self.loaded_modules.is_empty() {
            return Ok(Value::Null);
        }
        self.sync_current_pages()?;
        let values = self.call_engine(
            CallTarget::Global {
                name: "__container_invoke_page_event".into(),
            },
            vec![
                json!(index),
                event,
                json!(error_policy == EventHandlerErrorPolicy::Propagate),
            ],
        )?;
        Ok(Value::Array(values))
    }

    /// Live-document input carries the actual receivers captured when that
    /// document was prepared. The native transport validates them before each
    /// listener, including after handler lookup can run application getters.
    /// One event remains one JS task: jobs drain only after the complete native
    /// dispatch, and failure effects are handled by the normal outer turn.
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn invoke_browser_receiver_event(
        &mut self,
        page_id: u64,
        expected: &Value,
        event: &Value,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<Value, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.sync_current_pages()?;
        self.ensure_engine_environment_current()?;
        let rethrow = error_policy == EventHandlerErrorPolicy::Propagate;
        let values = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    let engine = self.quickjs_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "QuickJS provider unavailable")
                    })?;
                    let result = engine
                        .invoke_receiver_event(page_id, expected, event, rethrow)
                        .map(|value| vec![value])
                        .map_err(|error| error.into_core_error());
                    if engine.is_execution_faulted() {
                        result
                            .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?
                    } else {
                        let checkpoint = container_core::JsEngine::drain_microtasks(engine);
                        complete_engine_task(result, checkpoint)
                            .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?
                    }
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = (page_id, expected, event, rethrow);
                    return Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "live receiver dispatch requires native QuickJS",
                    ));
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    let engine = self.v8_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                    })?;
                    let result = engine
                        .invoke_receiver_event(page_id, expected, event, rethrow)
                        .map(|value| vec![value])
                        .map_err(|error| {
                            let code = if error == container_engine_v8::EngineError::Interrupted {
                                container_core::EngineErrorCode::Interrupted
                            } else {
                                container_core::EngineErrorCode::Call
                            };
                            container_core::EngineError::new(code, error.to_string())
                        });
                    let checkpoint = container_core::JsEngine::drain_microtasks(engine);
                    complete_engine_task(result, checkpoint)
                        .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = (page_id, expected, event, rethrow);
                    return Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "live receiver dispatch requires native V8",
                    ));
                }
            }
        };
        let outcome = values.into_iter().next().ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Engine,
                "receiver dispatch omitted its result",
            )
        })?;
        if outcome.get("version").and_then(Value::as_str) != Some("1.0")
            || !outcome.get("results").is_some_and(Value::is_array)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "invalid native receiver dispatch outcome",
            ));
        }
        match outcome.get("retired").and_then(Value::as_bool) {
            Some(false) => {
                self.verify_browser_event_receivers(page_id, expected)?;
                Ok(outcome["results"].clone())
            }
            Some(true) => {
                // A real receiver retirement is a hard input boundary, even
                // when a callback directly changed the JS instance registry
                // without queuing a navigation effect. Keep completed writes,
                // but never authorize further input using these old pixels.
                self.invalidate_browser_presentation();
                Err(BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    "browser event receiver retired during dispatch",
                ))
            }
            None => Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "native receiver dispatch omitted its retirement state",
            )),
        }
    }

    fn ensure_initialized(&self) -> Result<(), BridgeError> {
        if self.initialized {
            Ok(())
        } else {
            Err(BridgeError::invalid("session must receive app.init first"))
        }
    }

    fn handle_lifecycle(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        let result = self.handle_lifecycle_transition(request);
        let retirement =
            if self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed {
                self.retire_lifecycle_notifications()
            } else {
                Ok(())
            };
        match result {
            Err(error) => Err(error),
            Ok(messages) => retirement.map(|()| messages),
        }
    }

    fn handle_lifecycle_transition(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let event = parse_lifecycle(request.payload.get("event").unwrap_or(&request.payload))?;
        let hide_options = if event == LifecycleEvent::Hide {
            let source = request.payload.get("options").unwrap_or(&request.payload);
            let mut options = Map::new();
            if let Some(reason) = source.get("reason") {
                if !reason.as_u64().is_some_and(|reason| reason <= 3) {
                    return Err(BridgeError::invalid("app hide reason must be 0, 1, 2 or 3"));
                }
                options.insert("reason".into(), reason.clone());
            }
            Value::Object(options)
        } else {
            Value::Null
        };
        if matches!(event, LifecycleEvent::Hide | LifecycleEvent::Unload) {
            self.suspend_host_components();
            let contacts = self.cancel_all_browser_contacts("app-hidden");
            self.invalidate_browser_presentation();
            contacts?;
            let ids = self.touch_contacts.keys().copied().collect::<Vec<_>>();
            self.cancel_touch_ids(&ids, "app-hidden")?;
        }
        if event == LifecycleEvent::Unload {
            self.retire_all_owned_canvases();
            // The old Session is terminal. A known-poisoned View must never
            // execute guest cleanup, but its independent healthy AppService
            // still owns component detached hooks, host calls and onUnload.
            self.retire_faulted_view_authority();
            self.view_execution.borrow_mut().retire_poisoned();
            self.close_host_calls_in_turn()?;
            self.component_visible_pages.clear();
            for page in self.component_pages.keys().copied().collect::<Vec<_>>() {
                self.retire_page_components(page)?;
            }
            self.retire_standalone_view_scopes()?;
        }
        let previous_state = self.app_service.lifecycle().state();
        let state = self
            .app_service
            .dispatch_lifecycle(event)
            .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
        if self.engine_provider_available() {
            self.sync_engine_capabilities()?;
        }
        // `app.init` owns the one-shot launch callback.  A lifecycle launch
        // received later does not invoke onLaunch a second time; it performs
        // the initial onShow before any page is pushed. Later visibility
        // changes retain callback return values for conformance traces.
        let hook_name = match event {
            LifecycleEvent::Launch => "onLaunch",
            LifecycleEvent::Show => "onShow",
            LifecycleEvent::Hide => "onHide",
            LifecycleEvent::Unload => "onUnload",
        };
        // WeChat supplies launch/show options as the first callback argument.
        // Initial launch/show share normalized session launch options. Resume
        // can supply updated options in its envelope. Hide carries the fixed
        // optional reason enum; unload has no documented options argument.
        let hook_args = if event == LifecycleEvent::Launch {
            vec![self.launch_options.clone()]
        } else if event == LifecycleEvent::Show {
            vec![request
                .payload
                .get("options")
                .or_else(|| request.payload.get("launchOptions"))
                .cloned()
                .unwrap_or_else(|| self.launch_options.clone())]
        } else if event == LifecycleEvent::Hide {
            vec![hide_options]
        } else {
            Vec::new()
        };
        let duplicate_visibility =
            matches!(event, LifecycleEvent::Show | LifecycleEvent::Hide) && previous_state == state;
        let hook_result =
            if duplicate_visibility || event == LifecycleEvent::Launch && self.app_launch_invoked {
                Ok(Value::Null)
            } else {
                self.invoke_app_hook(hook_name, hook_args.clone())
            };
        // Launch enters Active. Its first foreground callback belongs here,
        // before the host pushes a page; a later redundant Show cannot move
        // App.onShow behind Page.onLoad/onShow or invoke it twice.
        let initial_show = if event == LifecycleEvent::Launch {
            self.invoke_app_hook("onShow", hook_args)
        } else {
            Ok(Value::Null)
        };
        // App foreground/background visibility affects only the page at the
        // top of the stack. Cached tabs and covered pages remain hidden.
        // App resumes before its currently visible Page. Navigation already
        // handles covered/cached pages, so only a genuine foreground change
        // invokes this page's callback. That hook also owns the matching
        // component pageLifetimes notification and consumes it exactly once.
        let visibility_result = if matches!(event, LifecycleEvent::Show | LifecycleEvent::Hide)
            && !duplicate_visibility
        {
            if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
                let page_result = self.invoke_page_hook_for_id(page, hook_name, Vec::new());
                // The application transition is already committed even if
                // Page.onHide throws before its usual component notification.
                let component_result =
                    self.set_component_page_visibility(page, event == LifecycleEvent::Show);
                page_result.map(|_| ()).and(component_result)
            } else {
                Ok(())
            }
        } else {
            Ok(())
        };
        // The core foreground/background transition was committed before
        // App user code. A thrown hook must not leave components with the
        // opposite visibility; return the original hook error afterwards.
        let hook_result = hook_result?;
        let initial_show = initial_show?;
        visibility_result?;
        if event == LifecycleEvent::Launch {
            self.app_launch_invoked = true;
        }
        let mut hooks = serde_json::Map::from_iter([(hook_name.into(), hook_result)]);
        if event == LifecycleEvent::Launch {
            hooks.insert("onShow".into(), initial_show);
        }
        let payload = json!({
            "ok": true,
            "event": event,
            "state": state,
            "sequence": self.app_service.lifecycle().sequence(),
            "hooks": hooks,
            "duplicateVisibility": duplicate_visibility,
        });
        let mut messages = vec![
            self.response(request, payload),
            self.diagnostic(
                request,
                "info",
                "lifecycle",
                json!({"event": event, "state": state, "hook": hook_name}),
            ),
        ];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn handle_page_push(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        self.validate_navigation_liveness(request)?;
        let payload = object_payload(&request.payload)?.clone();
        if self.navigation_layout.enabled && !self.app_service.pages().is_empty() {
            return self.handle_navigation_api(request, "wx.navigateTo", &payload);
        }
        let prepared = self.prepare_route_transaction(
            "wx.navigateTo",
            &payload,
            route_transaction::RouteOrigin::NativePush,
        )?;
        let mut messages = self.finish_route_transaction(prepared, |session, payload| {
            let mut request = request.clone();
            request.payload = Value::Object(payload.clone());
            session.validate_navigation_liveness(&request)?;
            session.handle_page_push_in_route(&request)
        })?;
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn handle_page_push_in_route(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if self.navigation_layout.enabled && !self.app_service.pages().is_empty() {
            let payload = object_payload(&request.payload)?.clone();
            return self.handle_navigation_api(request, "wx.navigateTo", &payload);
        }
        let payload = object_payload(&request.payload)?;
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("page.push requires path"))?;
        validate_page_input(path, payload)?;
        let initial_data = payload.get("data").cloned();
        let previous = self.app_service.pages().current().cloned();
        let previous_on_hide = previous
            .as_ref()
            .map(|page| self.invoke_page_hook_for_id(page.id, "onHide", Vec::new()))
            .transpose()?;
        let id = self
            .app_service
            .push_page(path)
            .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
        self.bind_page_registration(path, id);
        set_query(&mut self.app_service, id, payload.get("query"))?;
        if let Some(data) = initial_data {
            self.page_initial_data.insert(id, data.clone());
            if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                page.data = data;
            }
        }
        let query = self.page_query_value(id);
        let hooks = json!({
            "previousOnHide": previous_on_hide.unwrap_or(Value::Null),
            "onLoad": self.invoke_page_hook_for_id(id, "onLoad", vec![query])?,
            "onShow": self.invoke_page_hook_for_id(id, "onShow", Vec::new())?,
            // The first ready notification is emitted after the page has
            // entered the visible stack. Keeping it in the same hook batch
            // preserves lifecycle order without a per-callback bridge turn.
            "onReady": self.invoke_page_hook_for_id(id, "onReady", Vec::new())?,
        });
        self.view.invalidate_template();
        let messages = vec![
            self.response(
                request,
                with_page_hooks(page_payload(&self.app_service, id, true)?, hooks)?,
            ),
            self.diagnostic(
                request,
                "info",
                "page pushed",
                json!({"pageId": id.0, "path": path}),
            ),
        ];
        Ok(messages)
    }

    fn handle_page_replace(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        self.validate_navigation_liveness(request)?;
        let payload = object_payload(&request.payload)?.clone();
        if self.navigation_layout.enabled {
            return self.handle_navigation_api(request, "wx.redirectTo", &payload);
        }
        let prepared = self.prepare_route_transaction(
            "wx.redirectTo",
            &payload,
            route_transaction::RouteOrigin::NativeReplace,
        )?;
        let mut messages = self.finish_route_transaction(prepared, |session, payload| {
            let mut request = request.clone();
            request.payload = Value::Object(payload.clone());
            session.validate_navigation_liveness(&request)?;
            session.handle_page_replace_in_route(&request)
        })?;
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn handle_page_replace_in_route(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if self.navigation_layout.enabled {
            let payload = object_payload(&request.payload)?.clone();
            return self.handle_navigation_api(request, "wx.redirectTo", &payload);
        }
        let payload = object_payload(&request.payload)?;
        let path = payload
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("page.replace requires path"))?;
        validate_page_input(path, payload)?;
        let initial_data = payload.get("data").cloned();
        let previous = self.app_service.pages().current().cloned();
        let previous_on_unload = previous
            .as_ref()
            .map(|page| self.invoke_page_hook_for_id(page.id, "onUnload", Vec::new()))
            .transpose()?;
        let id = self
            .app_service
            .replace_page(path)
            .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
        // A replaced page is disposed before its replacement is exposed.  Do
        // not leave the old registration id addressable by delayed events or
        // setData effects after its onUnload hook has run.
        if let Some(previous) = previous {
            self.unbind_page(previous.id)?;
        }
        self.bind_page_registration(path, id);
        set_query(&mut self.app_service, id, payload.get("query"))?;
        if let Some(data) = initial_data {
            self.page_initial_data.insert(id, data.clone());
            if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                page.data = data;
            }
        }
        self.flush_unload_notifications()?;
        let query = self.page_query_value(id);
        let hooks = json!({
            "previousOnUnload": previous_on_unload.unwrap_or(Value::Null),
            "onLoad": self.invoke_page_hook_for_id(id, "onLoad", vec![query])?,
            "onShow": self.invoke_page_hook_for_id(id, "onShow", Vec::new())?,
            "onReady": self.invoke_page_hook_for_id(id, "onReady", Vec::new())?,
        });
        self.view.invalidate_template();
        let messages = vec![
            self.response(
                request,
                with_page_hooks(page_payload(&self.app_service, id, true)?, hooks)?,
            ),
            self.diagnostic(
                request,
                "info",
                "page replaced",
                json!({"pageId": id.0, "path": path}),
            ),
        ];
        Ok(messages)
    }

    fn handle_page_pop(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        self.validate_navigation_liveness(request)?;
        let payload = object_payload(&request.payload)?.clone();
        if self.navigation_layout.enabled {
            return self.handle_navigation_api(request, "wx.navigateBack", &payload);
        }
        // A private final-page clear has no resulting route. Keep its legacy
        // unload/response contract without publishing a fabricated AppRoute.
        if self.app_service.pages().len() <= 1 {
            let mut messages = self.with_route_notifications(|session| {
                session.validate_navigation_liveness(request)?;
                session.handle_page_pop_in_route(request)
            })?;
            self.append_engine_effects(&mut messages)?;
            return Ok(messages);
        }
        let prepared = self.prepare_route_transaction(
            "wx.navigateBack",
            &payload,
            route_transaction::RouteOrigin::NativePop,
        )?;
        let mut messages = self.finish_route_transaction(prepared, |session, payload| {
            let mut request = request.clone();
            request.payload = Value::Object(payload.clone());
            session.validate_navigation_liveness(&request)?;
            session.handle_page_pop_in_route(&request)
        })?;
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn handle_page_pop_in_route(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if self.navigation_layout.enabled {
            let payload = object_payload(&request.payload)?.clone();
            return self.handle_navigation_api(request, "wx.navigateBack", &payload);
        }
        if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
            self.cancel_touches_for_page(page, "page-popped")?;
        }
        let page = self.app_service.pages().current().cloned().ok_or_else(|| {
            runtime_error(RuntimeError::NoCurrentPage, BridgeErrorCode::InvalidRequest)
        })?;
        let page_index = self.page_registration_index_for_id(&page.path, page.id);
        let on_unload =
            self.invoke_page_hook_for_id_with_index(page.id, page_index, "onUnload", Vec::new())?;
        self.app_service
            .pop_page()
            .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
        self.unbind_page(page.id)?;
        self.flush_unload_notifications()?;
        let on_show = self
            .app_service
            .pages()
            .current()
            .cloned()
            .map(|current| self.invoke_page_path_hook(&current.path, "onShow", Vec::new()))
            .transpose()?
            .unwrap_or(Value::Null);
        self.view.invalidate_template();
        let messages = vec![
            self.response(
                request,
                json!({"ok": true, "page": page, "hooks": {"onUnload": on_unload, "onShow": on_show}}),
            ),
            self.diagnostic(
                request,
                "info",
                "page popped",
                json!({"pageId": page.id.0, "path": page.path}),
            ),
        ];
        Ok(messages)
    }

    fn handle_data_patch(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let page_id = parse_page_id(payload.get("pageId").or_else(|| payload.get("page_id")))?;
        let patches_value = payload
            .get("patches")
            .ok_or_else(|| BridgeError::invalid("data.patch.batch requires patches"))?;
        let patches = Vec::<DataPatch>::deserialize(patches_value)
            .map_err(|e| BridgeError::invalid(format!("invalid patches: {e}")))?;
        if self.app_service.pages().get(page_id).is_none() {
            return Err(BridgeError::invalid(format!("unknown page {}", page_id.0)));
        }
        let normalized = patches
            .iter()
            .map(|patch| {
                let tokens = patch.path_tokens().ok_or_else(|| {
                    BridgeError::invalid(format!("invalid data path: {}", patch.path))
                })?;
                Ok(json!([
                    tokens,
                    patch.op == container_core::DataPatchOp::Delete,
                    patch.value
                ]))
            })
            .collect::<Result<Vec<_>, BridgeError>>()?;
        let animation_write = self.prepare_animation_host_write(page_id, &patches)?;
        let mutation = (|| -> Result<_, BridgeError> {
            // Host-originated mutations and JS setData share one ordered batch
            // boundary. Mirror the batch inside the isolate before publishing it
            // to Rust/View; otherwise the next handler reads stale this.data and
            // can overwrite the host's accepted changes. This mirror deliberately
            // bypasses setData, observers and effects, avoiding an echo loop.
            if self.engine_provider_available() && !self.loaded_modules.is_empty() {
                self.sync_current_pages()?;
                let mirrored = self.call_engine(
                    CallTarget::Global {
                        name: "__container_apply_page_data_batch".into(),
                    },
                    vec![json!(page_id.0), Value::Array(normalized)],
                )?;
                if mirrored.first() != Some(&Value::Bool(true)) {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        format!(
                            "page {} has no JavaScript instance for data synchronization",
                            page_id.0
                        ),
                    ));
                }
            }
            let batch = DataPatchBatch { page_id, patches };
            let changed = self
                .app_service
                .apply_data_patch_batch(&batch)
                .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
            Ok((changed, batch))
        })();
        let (changed, batch) = match mutation {
            Ok(value) => {
                self.finish_animation_host_write(animation_write, true)?;
                value
            }
            Err(error) => {
                self.finish_animation_host_write(animation_write, false)?;
                return Err(error);
            }
        };
        let patch_count = batch.patches.len();
        self.view.record_owned_patches(batch.patches);
        Ok(vec![self.response(request, json!({"ok": true, "pageId": page_id.0, "changed": changed, "revision": self.view.revision})), self.diagnostic(request, "debug", "data patch batch applied", json!({"pageId": page_id.0, "patches": patch_count, "changed": changed}))])
    }

    fn handle_event_batch(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "DOM input requires a versioned browser View event batch",
            ));
        }
        if !self.is_current_frame_presented() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "input awaits current frame presentation",
            ));
        }

        let event_values = match &request.payload {
            Value::Array(values) => values.clone(),
            Value::Object(map) => map
                .get("events")
                .and_then(Value::as_array)
                .cloned()
                .ok_or_else(|| {
                    BridgeError::invalid("event.batch payload must be an array or {events}")
                })?,
            _ => {
                return Err(BridgeError::invalid(
                    "event.batch payload must be an array or {events}",
                ));
            }
        };
        let mut events = Vec::with_capacity(event_values.len());
        let mut dispatches = Vec::new();
        let mut hook_results: Vec<Value> = Vec::new();
        for value in event_values {
            let Some(ResolvedTouchInput { value, captured }) = self.resolve_touch_input(value)?
            else {
                continue;
            };
            let (event, event_dispatches, hook_result) =
                self.dispatch_view_event(value.clone(), captured.as_deref())?;
            if event.event_type == "tap" {
                self.maybe_authorize_phone_tap(&event.target)?;
            }
            self.apply_scroll_default(
                &value,
                &event,
                &event_dispatches,
                hook_result.as_ref(),
                captured.as_deref(),
            )?;
            events.push(event);
            dispatches.extend(event_dispatches);
            if let Some(result) = hook_result {
                hook_results.push(result);
            }
        }
        self.view.record_event_batch(events.len());
        let mut messages = vec![
            self.response(
                request,
                json!({"ok": true, "events": events.len(), "dispatches": dispatches, "hooks": hook_results, "revision": self.view.revision}),
            ),
            self.diagnostic(
                request,
                "debug",
                "event batch consumed",
                json!({"events": events.len()}),
            ),
        ];
        self.append_scroll_notifications(&mut messages);
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    /// One listener/control implementation serves current-tree events and
    /// immutable contact routes, including lifecycle-triggered cancellation.
    fn dispatch_view_event(
        &mut self,
        value: Value,
        captured: Option<&TouchRoute>,
    ) -> Result<(EventInput, Vec<EventDispatch>, Option<Value>), BridgeError> {
        self.dispatch_view_event_with_error_policy(value, captured, EventHandlerErrorPolicy::Report)
    }

    fn dispatch_view_event_with_error_policy(
        &mut self,
        value: Value,
        captured: Option<&TouchRoute>,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<(EventInput, Vec<EventDispatch>, Option<Value>), BridgeError> {
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = error_policy;
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        let mut hook_result = None;
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let hook_result = None;
        let mut event: EventInput = serde_json::from_value(value.clone())
            .map_err(|error| BridgeError::invalid(format!("invalid event: {error}")))?;
        // Listener declarations belong to the committed View, not to the
        // host's pointer payload. A native input only needs coordinates;
        // capture listeners must still activate the same core route.
        event.capture |= event.path.iter().any(|id| {
            self.wxml_event_binding(captured, id, &event.event_type, true)
                .is_some()
        }) || self
            .wxml_event_binding(captured, &event.target, &event.event_type, true)
            .is_some();
        let mut event_dispatches = dispatch_event(&event)
            .map_err(|error| BridgeError::invalid(format!("invalid event route: {error}")))?;
        if self
            .wxml_event_binding(captured, &event.target, &event.event_type, true)
            .is_some()
        {
            if let Some(index) = event_dispatches
                .iter()
                .position(|dispatch| dispatch.phase == container_core::EventPhase::Target)
            {
                let mut capture = event_dispatches[index].clone();
                capture.phase = container_core::EventPhase::Capture;
                event_dispatches.insert(index, capture);
            }
        }
        self.enrich_event_dispatches(captured, &mut event, &mut event_dispatches);

        // Keep the original event fields (including the optional
        // `handler`, `handlers`, `pageIndex` and `pageId` hints) and add
        // normalized capture/target/bubble dispatches.  This is one
        // engine call per input event, while handlers themselves observe
        // the complete dispatch order in JavaScript.
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if self.engine_provider_available() && !self.loaded_modules.is_empty() {
            let mut event_object = object_payload(&value)?.clone();
            if !event.dataset.is_empty() {
                event_object.insert("dataset".into(), Value::Object(event.dataset.clone()));
            }
            if !event.mark.is_empty() {
                event_object.insert("mark".into(), Value::Object(event.mark.clone()));
            }
            let mut resolved_dispatches =
                serde_json::to_value(&event_dispatches).map_err(|error| {
                    BridgeError::invalid(format!("event dispatch serialization failed: {error}"))
                })?;
            for (dispatch, value) in event_dispatches.iter().zip(
                resolved_dispatches
                    .as_array_mut()
                    .expect("serialized event dispatch vector"),
            ) {
                let value = value
                    .as_object_mut()
                    .expect("serialized event dispatch object");
                if let Some(node) = self.event_route_node(captured, &dispatch.current_target) {
                    if let Some(id) = node.public_id {
                        value.insert("publicCurrentTargetId".into(), json!(id));
                    }
                }
                if let Some(node) = self.event_route_node(captured, &dispatch.target) {
                    if let Some(id) = node.public_id {
                        value.insert("publicTargetId".into(), json!(id));
                    }
                }
                let capture = dispatch.phase == container_core::EventPhase::Capture;
                if let Some((handler, catches)) = self.wxml_event_binding(
                    captured,
                    &dispatch.current_target,
                    &event.event_type,
                    capture,
                ) {
                    value.insert("handler".into(), Value::String(handler.to_owned()));
                    value.insert("catch".into(), Value::Bool(catches));
                    if let Some(owner) = self
                        .event_route_node(captured, &dispatch.current_target)
                        .and_then(|node| node.owner)
                    {
                        value.insert("ownerScopeId".into(), Value::String(owner));
                    }
                }
            }
            event_object.insert("dispatches".into(), resolved_dispatches);
            let page_index = self.event_page_registration_index(&value);
            let result = self.invoke_page_event_with_error_policy(
                page_index,
                Value::Object(event_object),
                error_policy,
            )?;
            // The core expands the complete route before entering JS so
            // capture/target/bubble remains one batched bridge call. JS
            // event methods can stop propagation, however; trim the
            // observable route at the dispatch that consumed the stop.
            trim_event_dispatches_for_control(&mut event_dispatches, &result);
            if !result.is_null() {
                hook_result = Some(result);
            }
        }
        Ok((event, event_dispatches, hook_result))
    }

    /// Resolve exactly one declared listener for this node and event phase.
    /// Explicit legacy protocol handlers remain a fallback in the engines;
    /// committed WXML bindings take precedence and never infer method names.
    fn wxml_event_binding<'a>(
        &'a self,
        captured: Option<&'a TouchRoute>,
        id: &str,
        event_type: &str,
        capture: bool,
    ) -> Option<(&'a str, bool)> {
        let attributes = if let Some(route) = captured {
            &route.node(id)?.attributes
        } else {
            &find_render_node(&self.skia_backend.renderer.last_frame()?.root, id)?.attributes
        };
        let prefix = if capture { "capture-" } else { "" };
        for (kind, catches) in [("catch", true), ("bind", false)] {
            // The fixed SDK oracle gives the compact spelling precedence,
            // independently of attribute order. Hyphenated event names only
            // accept the colon spelling (bind:my-event), unlike underscores.
            for separator in ["", ":"] {
                if separator.is_empty()
                    && !event_type
                        .chars()
                        .all(|character| character.is_ascii_alphanumeric() || character == '_')
                {
                    continue;
                }
                let attribute = format!("{prefix}{kind}{separator}{event_type}");
                if let Some(handler) = attributes.get(&attribute).map(|value| value.trim()) {
                    if !handler.is_empty() {
                        return Some((handler, catches));
                    }
                }
            }
        }
        None
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn event_route_node(&self, captured: Option<&TouchRoute>, id: &str) -> Option<TouchRouteNode> {
        if let Some(route) = captured {
            route.node(id).cloned()
        } else {
            find_render_node(&self.skia_backend.renderer.last_frame()?.root, id)
                .map(TouchRouteNode::from_render)
        }
    }

    /// Fill event datasets from the committed render tree.  A WXML event has
    /// two distinct dataset views: `target.dataset` belongs to the original
    /// hit node, while `currentTarget.dataset` belongs to the handler node as
    /// capture/bubble traversal moves through ancestors.  Keeping this
    /// normalization in the runtime means QuickJS, V8 and direct bridge
    /// consumers observe the same values without per-node host calls.
    fn enrich_event_dispatches(
        &self,
        captured: Option<&TouchRoute>,
        event: &mut EventInput,
        dispatches: &mut [EventDispatch],
    ) {
        if let Some(route) = captured {
            event.dataset = route
                .node(&event.target)
                .map(|node| {
                    node.dataset
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect()
                })
                .unwrap_or_default();
            event.mark = route.nodes.iter().fold(Map::new(), |mut mark, node| {
                mark.extend(
                    node.mark
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone())),
                );
                mark
            });
            for dispatch in dispatches {
                dispatch.dataset = route
                    .node(&dispatch.current_target)
                    .map(|node| {
                        node.dataset
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                dispatch.mark = event.mark.clone();
            }
            return;
        }
        let Some(frame) = self.skia_backend.renderer.last_frame() else {
            return;
        };
        let target_dataset: Map<String, Value> = find_render_node(&frame.root, &event.target)
            .map(|node| {
                node.dataset
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect()
            })
            .unwrap_or_default();
        if event.dataset.is_empty() && !target_dataset.is_empty() {
            event.dataset = target_dataset;
        }
        // WXML event marks inherit from the rendered root towards the hit
        // target.  A nearer mark with the same key wins.  This is distinct
        // from `dataset`: mark data is exposed as `event.mark` and is the
        // merged object for every phase of one event dispatch.
        if event.mark.is_empty() {
            let mut inherited = Map::new();
            for id in event.path.iter() {
                if let Some(node) = find_render_node(&frame.root, id) {
                    inherited.extend(
                        node.mark
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone())),
                    );
                }
            }
            if inherited.is_empty() {
                if let Some(node) = find_render_node(&frame.root, &event.target) {
                    inherited.extend(
                        node.mark
                            .iter()
                            .map(|(key, value)| (key.clone(), value.clone())),
                    );
                }
            }
            event.mark = inherited;
        }
        for dispatch in dispatches.iter_mut() {
            if dispatch.mark.is_empty() && !event.mark.is_empty() {
                dispatch.mark = event.mark.clone();
            }
        }
        for dispatch in dispatches {
            if let Some(node) = find_render_node(&frame.root, &dispatch.current_target) {
                dispatch.dataset = node
                    .dataset
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect();
            }
        }
    }

    /// Identified native contacts opt into capture by beginning with a
    /// touchstart. Standalone/legacy taps (including Web/desktop taps without
    /// changedTouches) keep the existing coordinate/explicit-route protocol.
    fn resolve_touch_input(
        &mut self,
        value: Value,
    ) -> Result<Option<ResolvedTouchInput>, BridgeError> {
        let contact = value
            .get("changedTouches")
            .and_then(Value::as_array)
            .filter(|touches| touches.len() == 1)
            .and_then(|touches| touches[0].get("identifier"))
            .and_then(Value::as_i64);
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let Some(id) = contact.filter(|_| {
            matches!(
                kind.as_str(),
                "touchstart" | "touchmove" | "touchend" | "touchcancel" | "tap"
            )
        }) else {
            return Ok(self
                .resolve_pointer_event(value)?
                .map(|value| ResolvedTouchInput {
                    value,
                    captured: None,
                }));
        };
        if kind == "touchstart" {
            if self.touch_contacts.contains_key(&id) {
                self.cancel_touch_ids(&[id], "contact-restarted")?;
            }
            if self
                .touch_contacts
                .values()
                .filter(|contact| !contact.ended)
                .count()
                >= MAX_ACTIVE_TOUCHES
            {
                return Err(BridgeError::invalid(
                    "active touch contact limit exceeded (64)",
                ));
            }
            let Some(value) = self.resolve_pointer_event(value)? else {
                return Ok(None);
            };
            let event: EventInput = serde_json::from_value(value.clone())
                .map_err(|error| BridgeError::invalid(format!("invalid event: {error}")))?;
            dispatch_event(&event)
                .map_err(|error| BridgeError::invalid(format!("invalid event route: {error}")))?;
            let frame = self.skia_backend.renderer.last_frame().ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    "touchstart requires a committed render frame",
                )
            })?;
            let page = self.app_service.pages().current().map(|page| page.id);
            // A navigation can precede its first publication. Never associate
            // old pixels with the new Page instance in that interval.
            if page != self.observer_frame_page {
                return Ok(None);
            }
            let Some(path) = find_render_path(&frame.root, &event.target) else {
                // Identified native input requires an owned committed node.
                // Unqualified explicit legacy events keep their own path.
                return Ok(None);
            };
            let route = Arc::new(TouchRoute {
                page,
                nodes: path.into_iter().map(TouchRouteNode::from_render).collect(),
            });
            let value = pin_touch_route(value, &route)?;
            self.touch_contacts.insert(
                id,
                CapturedTouch {
                    route: Arc::clone(&route),
                    last_input: object_payload(&value)?.clone(),
                    ended: false,
                },
            );
            return Ok(Some(ResolvedTouchInput {
                value,
                captured: Some(route),
            }));
        }
        let Some(contact) = self.touch_contacts.get(&id) else {
            // Unknown, already cancelled or expired contacts cannot redirect
            // a delayed terminal event onto whatever now occupies the pixels.
            return Ok(None);
        };
        let route = Arc::clone(&contact.route);
        if !self.touch_route_valid(&route) {
            self.cancel_touch_ids(&[id], "route-invalidated")?;
            return Ok(None);
        }
        if contact.ended && kind != "tap" {
            return Ok(None);
        }
        // Coordinates may be outside the viewport for move/end/cancel. They
        // still terminate the captured route; only a tap needs visible input.
        if kind == "tap" {
            if let Some(frame) = self.skia_backend.renderer.last_frame() {
                let x = value
                    .get("x")
                    .or_else(|| value.get("clientX"))
                    .and_then(Value::as_f64);
                let y = value
                    .get("y")
                    .or_else(|| value.get("clientY"))
                    .and_then(Value::as_f64);
                if let (Some(x), Some(y)) = (x, y) {
                    if !x.is_finite()
                        || !y.is_finite()
                        || !frame.viewport.contains(x as f32, y as f32)
                    {
                        self.cancel_touch_ids(&[id], "tap-outside-viewport")?;
                        return Ok(None);
                    }
                }
            }
        }
        let value = pin_touch_route(value, &route)?;
        let contact = self
            .touch_contacts
            .get_mut(&id)
            .expect("contact remains owned");
        contact.last_input = object_payload(&value)?.clone();
        match kind.as_str() {
            "touchend" => {
                contact.ended = true;
                self.ended_touch_contacts.push_back(id);
                // A drag may have no tap. Bound the retained terminal leases;
                // a later tap for an expired ID is an ignored event.
                while self.ended_touch_contacts.len() > MAX_ENDED_TOUCHES {
                    if let Some(expired) = self.ended_touch_contacts.pop_front() {
                        self.touch_contacts.remove(&expired);
                    }
                }
            }
            "touchcancel" | "tap" => {
                self.touch_contacts.remove(&id);
                self.ended_touch_contacts.retain(|ended| *ended != id);
            }
            _ => {}
        }
        Ok(Some(ResolvedTouchInput {
            value,
            captured: Some(route),
        }))
    }

    /// Geometry can move while the contact remains captured. A changed Page,
    /// keyed occurrence, listener owner or ancestor chain invalidates it;
    /// dataset/mark/listener values remain the immutable down-time snapshot.
    fn touch_route_valid(&self, route: &TouchRoute) -> bool {
        if route.page != self.app_service.pages().current().map(|page| page.id) {
            return false;
        }
        let Some(frame) = self.skia_backend.renderer.last_frame() else {
            return false;
        };
        let Some(target) = route.nodes.last() else {
            return false;
        };
        let Some(path) = find_render_path(&frame.root, &target.identity) else {
            return false;
        };
        path.len() == route.nodes.len()
            && route.nodes.iter().zip(path).all(|(captured, node)| {
                captured.same_identity(node)
                    && node.style.unwrap_or_default().display != DisplayMode::None
            })
    }

    fn cancel_invalid_touches(&mut self) -> Result<(), BridgeError> {
        let ids = self
            .touch_contacts
            .iter()
            .filter_map(|(id, contact)| (!self.touch_route_valid(&contact.route)).then_some(*id))
            .collect::<Vec<_>>();
        self.cancel_touch_ids(&ids, "route-invalidated")
    }

    fn cancel_touches_for_page(&mut self, page: PageId, reason: &str) -> Result<(), BridgeError> {
        self.abandon_phone_buttons_for_page(page);
        let browser = self.cancel_browser_contacts_for_page(page, reason);
        self.ensure_engine_execution_healthy()?;
        let ids = self
            .touch_contacts
            .iter()
            .filter_map(|(id, contact)| (contact.route.page == Some(page)).then_some(*id))
            .collect::<Vec<_>>();
        let native = self.cancel_touch_ids(&ids, reason);
        browser.and(native)
    }

    /// Called by the typed component disposal boundary before detached hooks.
    /// This sends one whole event route, never re-enters component discovery,
    /// and consumes all matching contacts before executing arbitrary user JS.
    fn cancel_touches_for_scopes(
        &mut self,
        page: PageId,
        scopes: &BTreeSet<String>,
    ) -> Result<(), BridgeError> {
        let browser = self.cancel_browser_contacts_for_scopes(page, scopes);
        self.ensure_engine_execution_healthy()?;
        let ids = self
            .touch_contacts
            .iter()
            .filter_map(|(id, contact)| {
                (contact.route.page == Some(page)
                    && contact.route.nodes.iter().any(|node| {
                        node.owner
                            .as_ref()
                            .is_some_and(|scope| scopes.contains(scope))
                            || node
                                .component
                                .as_ref()
                                .is_some_and(|scope| scopes.contains(scope))
                    }))
                .then_some(*id)
            })
            .collect::<Vec<_>>();
        let native = self.cancel_touch_ids(&ids, "component-disposed");
        browser.and(native)
    }

    fn cancel_touch_ids(&mut self, ids: &[i64], reason: &str) -> Result<(), BridgeError> {
        self.cancel_touch_ids_with_error_policy(ids, reason, EventHandlerErrorPolicy::Report)
    }

    fn cancel_touch_ids_with_error_policy(
        &mut self,
        ids: &[i64],
        reason: &str,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<(), BridgeError> {
        let pending = ids
            .iter()
            .filter_map(|id| {
                self.scrolling.release_touch(*id);
                let contact = self.touch_contacts.remove(id)?;
                self.ended_touch_contacts.retain(|ended| ended != id);
                (!contact.ended).then_some((contact.route, contact.last_input))
            })
            .collect::<Vec<_>>();
        for (route, mut input) in pending {
            // Never select a registration fallback after a page was already
            // removed. Normal hide/unload hooks cancel before this can happen.
            if route.page != self.app_service.pages().current().map(|page| page.id) {
                continue;
            }
            input.insert("type".into(), json!("touchcancel"));
            input.insert("touches".into(), json!([]));
            input.insert("detail".into(), json!({"reason": reason}));
            let value = pin_touch_route(Value::Object(input), &route)?;
            self.dispatch_view_event_with_error_policy(value, Some(&route), error_policy)?;
            self.view.record_event_batch(1);
        }
        Ok(())
    }

    /// Convert a host pointer event into the normalized event route expected
    /// by `container-core`. Hosts may send `x`/`y` (or clientX/clientY) and
    /// omit target/path; the committed render tree supplies the deepest hit
    /// node and its dataset in one local traversal. A valid coordinate event
    /// without a recipient is an accepted no-op on every host, not a malformed
    /// bridge request. Explicit routes retain their normal validation path.
    fn resolve_pointer_event(&self, value: Value) -> Result<Option<Value>, BridgeError> {
        let mut object = match value {
            Value::Object(object) => object,
            other => return Ok(Some(other)),
        };
        let target_present = object
            .get("target")
            .and_then(Value::as_str)
            .is_some_and(|target| !target.trim().is_empty());
        if target_present
            || object
                .get("path")
                .is_some_and(|path| path.as_array().is_some_and(|items| !items.is_empty()))
        {
            return Ok(Some(Value::Object(object)));
        }
        let x = object
            .get("x")
            .or_else(|| object.get("clientX"))
            .and_then(Value::as_f64);
        let y = object
            .get("y")
            .or_else(|| object.get("clientY"))
            .and_then(Value::as_f64);
        let (Some(x), Some(y)) = (x, y) else {
            return Ok(Some(Value::Object(object)));
        };
        let (x, y) = (x as f32, y as f32);
        if !x.is_finite() || !y.is_finite() {
            return Err(BridgeError::invalid(
                "pointer coordinates must be finite f32 values",
            ));
        }
        // A coordinate request may omit only the unresolved target. Validate
        // all other EventInput fields before a hit-test miss can short-circuit
        // dispatch. The empty target exists only in this validation copy; it
        // never reaches container-core or the engine as a fabricated route.
        let mut validation = object.clone();
        validation
            .entry("target")
            .or_insert_with(|| Value::String(String::new()));
        let validated: EventInput = serde_json::from_value(Value::Object(validation))
            .map_err(|error| BridgeError::invalid(format!("invalid event: {error}")))?;
        if validated.event_type.trim().is_empty() {
            return Err(BridgeError::invalid(format!(
                "invalid event route: {}",
                container_core::EventError::EmptyType
            )));
        }
        let frame = self.skia_backend.renderer.last_frame().ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "pointer event requires a committed render frame",
            )
        })?;
        // The surface only presents the logical viewport. Visible overflow
        // may cross ordinary ancestor bounds, but must not make offscreen
        // content interactive in a desktop window's padded area.
        if !frame.viewport.contains(x, y) {
            return Ok(None);
        }
        let path = frame.root.hit_test_path(x, y);
        let Some(target) = path.last() else {
            return Ok(None);
        };
        object.insert(
            "target".into(),
            Value::String(target.event_identity.as_ref().unwrap_or(&target.id).clone()),
        );
        object.insert(
            "path".into(),
            Value::Array(
                path.iter()
                    .map(|node| {
                        Value::String(node.event_identity.as_ref().unwrap_or(&node.id).clone())
                    })
                    .collect(),
            ),
        );
        object.insert(
            "dataset".into(),
            Value::Object(
                target
                    .dataset
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
        );
        Ok(Some(Value::Object(object)))
    }

    /// Build a render frame directly from the content-addressed WXML/WXSS
    /// blobs declared by the loaded manifest.  Hosts may use this path when
    /// they do not have a platform view tree yet: one `render.commit` batch
    /// carries the template data, viewport and verified blobs, and the
    /// session performs the same IR decode/evaluation/layout work for every
    /// host.  Callers still retain the explicit `frame` form for native view
    /// implementations that already have a resolved tree.
    fn build_manifest_frame(
        &mut self,
        payload: &Map<String, Value>,
    ) -> Result<PreparedSkiaFrame, BridgeError> {
        self.build_manifest_frame_with_preview(payload, None)
    }

    /// Validate a development presentation in this candidate session's
    /// renderer, using the live session's committed component snapshots.
    /// No application modules, microtasks, observers or lifecycle hooks run.
    /// Executable inputs must match; structural edits still require a fresh
    /// session and its ordinary startup validation.
    pub fn preview_dev_render(
        &mut self,
        live: &Session,
        payload: &Value,
    ) -> Result<(), BridgeError> {
        if live.requires_dev_restart() {
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "live AppService requires a new session",
            ));
        }
        self.with_engine_host_turn_deadline(live.engine_turn_deadline, |session| {
            session.preview_dev_render_within_turn(live, payload)
        })
    }

    fn preview_dev_render_within_turn(
        &mut self,
        live: &Session,
        payload: &Value,
    ) -> Result<(), BridgeError> {
        if !live.manifest.can_replace_presentation_with(&self.manifest) {
            return Err(BridgeError::invalid(
                "development render preview requires unchanged execution and configuration inputs",
            ));
        }
        let payload = payload
            .as_object()
            .ok_or_else(|| BridgeError::invalid("development render preview requires an object"))?;
        // This detached executor may already own an unrelated startup or
        // earlier preview graph. Only the live owner's accepted graph is a
        // valid source of retained component identities for this preview.
        self.component_pages.clear();
        let mut prepared = self.build_manifest_frame_with_preview(payload, Some(live))?;
        let mut scrolling = live.scrolling.clone();
        scrolling.reconcile(
            live.app_service.pages().current().map(|page| page.id),
            prepared.frame_mut(),
            true,
        )?;
        let accepted = self.skia_backend.accept(prepared)?;
        let manifest = accepted.manifest.expect("manifest preview candidate");
        // Detached previews never authorize the live page's input snapshot.
        self.record_last_frame_input(None);
        self.retire_skia_frame_authority();
        self.accepted_skia_scene = false;
        self.accepted_view_document = Some(manifest.document);
        self.render_blobs = manifest.resources;
        self.render_resources_verified = true;
        Ok(())
    }

    fn render_resources(
        &self,
        payload: &Map<String, Value>,
    ) -> Result<RenderResources, BridgeError> {
        if use_session_render_resources(payload)? {
            if !self.can_reuse_render_resources() {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    "manifest render has no verified resources for the current session manifest",
                ));
            }
            // This immutable map was hash-checked at app.init or an accepted
            // render commit. Manifest replacement invalidates authorization.
            return Ok(Arc::clone(&self.render_blobs));
        }
        let blobs = decode_render_blobs(payload.get("blobs"))?;
        self.validate_view_resources(&blobs)?;
        Ok(Arc::new(blobs))
    }

    fn load_manifest_view_input(
        &mut self,
        payload: &Map<String, Value>,
        live_preview: Option<&Session>,
    ) -> Result<ManifestViewInput, BridgeError> {
        // Reject invalid frame parameters before any user lifecycle hook can
        // attach or dispose component scopes behind the committed frame.
        let viewport = parse_render_viewport(payload.get("viewport"))?;
        if self.browser_route_active() {
            // Empty raster targets are valid in the renderer, but a DOM
            // presentation requires a positive logical viewport. Admit that
            // protocol boundary before evaluation or contact retirement, not
            // during serialization of an already-mutated candidate.
            container_ir::ViewViewport {
                width: f64::from(viewport.width),
                height: f64::from(viewport.height),
            }
            .validate()
            .map_err(|error| BridgeError::invalid(error.to_string()))?;
        }
        let frame_id = payload
            .get("frameId")
            .or_else(|| payload.get("frame_id"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| self.view.last_frame_id.unwrap_or(0).saturating_add(1));
        let blobs = self.render_resources(payload)?;
        self.ensure_view_execution_supported()
            .map_err(|error| error.bridge_error())?;
        let template_id = payload
            .get("templateId")
            .or_else(|| payload.get("template_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("manifest render requires templateId"))?;
        let route_path = template_id
            .strip_prefix("template:")
            .unwrap_or(template_id)
            .strip_suffix(".wxml")
            .unwrap_or(template_id);
        let template = self
            .manifest
            .templates
            .iter()
            .find(|template| template.id == template_id)
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("template {template_id} is not declared in the manifest"),
                )
            })?;
        let template_bytes = lookup_render_blob(&blobs, &template.wxml_ast)?;
        let ast = decode_wxml(template_bytes).map_err(|error| {
            BridgeError::new(
                BridgeErrorCode::Render,
                format!("template {template_id} WXML IR is invalid: {error}"),
            )
        })?;
        ensure_wxml_view_supported(
            &ast,
            template_id,
            self.template_view_execution_allowed(template_id),
        )?;
        let mut template_map = BTreeMap::new();
        for candidate in &self.manifest.templates {
            let Some(bytes) = blobs.get(&candidate.wxml_ast) else {
                continue;
            };
            let candidate_ast = decode_wxml(bytes).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("template {} WXML IR is invalid: {error}", candidate.id),
                )
            })?;
            ensure_wxml_view_supported(
                &candidate_ast,
                &candidate.id,
                self.template_view_execution_allowed(&candidate.id),
            )?;
            template_map.insert(candidate.id.clone(), candidate_ast.clone());
            if let Some(path) = candidate.id.strip_prefix("template:") {
                template_map.insert(path.to_owned(), candidate_ast);
            }
        }
        // Capture provenance at the same boundary as the root data clone.
        // Component hooks can write more data while this fixed snapshot is
        // evaluated, so neither prepare completion nor ACK may refresh it.
        let source = live_preview.unwrap_or(self);
        let page = source.app_service.pages().current();
        let page_input = page
            .filter(|page| {
                live_preview.is_none() && !payload.contains_key("data") && page.path == route_path
            })
            .map(|page| BrowserPageInput {
                page_id: page.id,
                route_path: page.path.clone(),
                template_revision: source.view.template_revision,
                viewport,
            });
        let animation_snapshot = page_input
            .as_ref()
            .map(|input| input.page_id)
            .map(|page| self.capture_animation_root_snapshot(page))
            .transpose()?;
        let source = live_preview.unwrap_or(self);
        let data = payload.get("data").cloned().unwrap_or_else(|| {
            source
                .app_service
                .pages()
                .current()
                .map(|page| page.data.clone())
                .unwrap_or_else(|| json!({}))
        });
        // Resolve statically declared `usingComponents` before handing the
        // tree to the renderer.  This is deliberately done in one IR pass so
        // every host sees the same component projection, including default
        // and named slots and their fallback subtrees.
        let mut style_ids = payload
            .get("styleIds")
            .or_else(|| payload.get("style_ids"))
            .map(|value| {
                value
                    .as_array()
                    .ok_or_else(|| BridgeError::invalid("styleIds must be an array"))?
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| BridgeError::invalid("styleIds must contain strings"))
                    })
                    .collect::<Result<Vec<_>, _>>()
            })
            .transpose()?;
        if style_ids.is_none() {
            let template_path = template_id.strip_prefix("template:").unwrap_or(template_id);
            let template_path = template_path.strip_suffix(".wxml").unwrap_or(template_path);
            if let Some(route) = self
                .manifest
                .routes
                .iter()
                .find(|route| route.path == template_path)
            {
                style_ids = Some(
                    self.manifest
                        .route_style_ids(&route.path)
                        .map_err(|error| {
                            BridgeError::new(BridgeErrorCode::InvalidManifest, error.to_string())
                        })?,
                );
            }
        }
        let style_roots = style_ids.unwrap_or_else(|| {
            self.manifest
                .styles
                .iter()
                .map(|style| style.id.clone())
                .collect()
        });
        Ok(ManifestViewInput {
            render: ViewRenderInputs {
                page_input,
                viewport,
                frame_id,
                resources: blobs,
                template_id: template_id.into(),
                route_path: route_path.into(),
                style_roots,
            },
            ast,
            templates: template_map,
            data,
            animation_snapshot,
        })
    }

    fn evaluate_manifest_view_input(
        &mut self,
        input: ManifestViewInput,
        live_preview: Option<&Session>,
    ) -> Result<PreparedViewDocument, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        let ManifestViewInput {
            render,
            ast,
            templates: template_map,
            data,
            animation_snapshot,
        } = &input;
        let ViewRenderInputs {
            frame_id,
            resources: blobs,
            template_id,
            route_path,
            style_roots,
            ..
        } = render;

        // Validate templates/styles before evaluating a document or executing
        // component hooks. Preparation and repeated component frontiers retain
        // the latest work for this PageId; previews own an isolated copy.
        let page = live_preview
            .unwrap_or(self)
            .app_service
            .pages()
            .current()
            .map(|page| page.id);
        if let (Some(page), Some(snapshot)) = (page, animation_snapshot) {
            self.set_animation_root_snapshot(page, Arc::clone(snapshot));
        }
        if self.view_execution.borrow().is_available() {
            let budget = self.view_execution_budget();
            let prepared =
                if self.render_resources_verified && Arc::ptr_eq(blobs, &self.render_blobs) {
                    self.view_execution.borrow_mut().prepare_verified_modules(
                        &self.manifest,
                        blobs,
                        &budget,
                    )
                } else {
                    self.view_execution
                        .borrow_mut()
                        .prepare_modules(&self.manifest, blobs, &budget)
                };
            self.retire_faulted_view_authority();
            prepared?;
        }
        let evaluated_ast = match (live_preview, page) {
            (Some(live), Some(page)) => {
                self.preview_page_template(live, page, template_id, ast, data, template_map)?
            }
            (None, Some(page)) => {
                self.evaluate_page_template(page, template_id, ast, data, template_map)?
            }
            (_, None) => self.evaluate_standalone_template(
                live_preview,
                template_id,
                ast,
                data,
                template_map,
            )?,
        };

        // Clone the owner Arc before mutable component-tree evaluation. The
        // tree builders may mutate this Session; retaining a borrowed
        // `component_source` until projection would violate that boundary.
        let component_buffer_urls = live_preview
            .map(|live| Arc::clone(&live.buffer_urls))
            .unwrap_or_else(|| Arc::clone(&self.buffer_urls));
        let has_managed_components = live_preview
            .map(|live| {
                live.engine_provider_available()
                    && !live.managed_module_ids().is_empty()
                    && live.app_service.pages().current().is_some()
            })
            .unwrap_or_else(|| {
                self.engine_provider_available()
                    && !self.managed_module_ids().is_empty()
                    && self.app_service.pages().current().is_some()
            });
        let (ast, ownership) = if let Some(live) = live_preview.filter(|_| has_managed_components) {
            let page = live.app_service.pages().current().expect("checked page").id;
            let (ast, ownership, graph) = live.preview_managed_component_tree(
                self,
                page,
                &evaluated_ast,
                template_id,
                template_map,
            )?;
            self.component_pages.insert(page, graph);
            (ast, ownership)
        } else if live_preview.is_none()
            && self.engine_provider_available()
            && !self.managed_module_ids().is_empty()
            && self.app_service.pages().current().is_some()
        {
            let page = self.app_service.pages().current().expect("checked page").id;
            self.managed_component_tree(page, &evaluated_ast, template_id, template_map)?
        } else {
            self.declarative_component_tree(
                page,
                &evaluated_ast,
                template_id,
                template_map,
                live_preview,
            )?
        };

        let mut document =
            view_document::project_view_document(view_document::ViewDocumentInput {
                ast: &ast,
                ownership: &ownership,
                manifest: &self.manifest,
                blobs,
                style_roots,
                session_id: &self.config.session_id,
                page_id: page.map(|page| page.0).unwrap_or(0),
                revision: *frame_id,
                route_path,
            })?;
        buffer_urls::project(&component_buffer_urls, &mut document)?;
        document.profile = self.renderer_profile_for_route(route_path);

        let animations = if let Some(input) = render.page_input.as_ref() {
            let bindings = self.animation_bindings.prepare(
                input.page_id.0,
                self.collect_animation_bindings(input.page_id, &ast, &ownership)?,
            )?;
            if bindings.descriptors.is_empty() && self.animation_sample_demand_revision().is_none()
            {
                None
            } else {
                let playback = self.animation_playback.prepare_bindings(
                    input.page_id.0,
                    &bindings.descriptors,
                    self.animation_clock.now(),
                    render.viewport,
                )?;
                Some(PreparedAnimations {
                    bindings: Some(bindings),
                    playback,
                })
            }
        } else {
            None
        };

        Ok(PreparedViewDocument {
            buffer_urls: component_buffer_urls,
            input: input.render,
            document,
            animations,
        })
    }

    fn build_manifest_frame_with_preview(
        &mut self,
        payload: &Map<String, Value>,
        live_preview: Option<&Session>,
    ) -> Result<PreparedSkiaFrame, BridgeError> {
        let (prepared, preflight, scroll_enabled) =
            self.prepare_manifest_skia_document(payload, live_preview)?;
        self.skia_backend
            .materialize(&self.manifest, prepared, preflight, scroll_enabled)
    }

    /// Keep isolated View execution separate from host-owned font/layout work.
    /// A development transaction can evaluate in its candidate realm and then
    /// materialize once with the retained renderer's exact font provider.
    fn prepare_manifest_skia_document(
        &mut self,
        payload: &Map<String, Value>,
        live_preview: Option<&Session>,
    ) -> Result<(PreparedViewDocument, SkiaStylePreflight, bool), BridgeError> {
        let input = self.load_manifest_view_input(payload, live_preview)?;
        if self.renderer_profile_for_route(&input.render.route_path)
            == container_ir::RendererProfile::WebView
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "webview requires an attached browser layout/presentation backend",
            ));
        }
        // The backend preflight runs before any View/component code. DOM uses
        // its independent raw stylesheet graph and never enters this resolver.
        let preflight = SkiaPageBackend::preflight(&self.manifest, &input.render)?;
        let prepared = self.evaluate_manifest_view_input(input, live_preview)?;
        let scroll_enabled =
            self.page_scroll_enabled(&prepared.input.template_id, &prepared.input.resources)?;
        Ok((prepared, preflight, scroll_enabled))
    }

    fn handle_render_commit(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "WebView pages require the browser presentation transaction",
            ));
        }
        if let Some(payload) = request.payload.as_object() {
            let top_level_resources = use_session_render_resources(payload)?;
            if let Some(frame) = payload.get("frame").and_then(Value::as_object) {
                // Reject malformed flags even for the explicit frame form, where
                // unknown render-node properties would otherwise be ignored.
                let frame_resources = use_session_render_resources(frame)?;
                if frame_resources
                    && frame.get("templateId").is_none()
                    && frame.get("template_id").is_none()
                {
                    return Err(BridgeError::invalid(
                        "useSessionResources requires a manifest templateId",
                    ));
                }
            }
            if top_level_resources
                && payload.get("templateId").is_none()
                && payload.get("template_id").is_none()
            {
                return Err(BridgeError::invalid(
                    "useSessionResources must be in the same object as templateId",
                ));
            }
        }
        let generated_payload = request
            .payload
            .as_object()
            .filter(|object| {
                object.get("templateId").is_some() || object.get("template_id").is_some()
            })
            .or_else(|| {
                request
                    .payload
                    .get("frame")
                    .and_then(Value::as_object)
                    .filter(|object| {
                        object.get("templateId").is_some() || object.get("template_id").is_some()
                    })
            });
        let generated = generated_payload.is_some();
        let (mut prepared, generated_template) = if let Some(object) = generated_payload {
            let prepared = self.build_manifest_frame(object)?;
            let template_id = object
                .get("templateId")
                .or_else(|| object.get("template_id"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            // Keep generated resources in their typed Arc-backed frame. JSON
            // roundtrips would expand every pixel into a Value and destroy
            // cache/frame sharing at the render publication boundary.
            (prepared, Some(template_id))
        } else {
            let mut value = request
                .payload
                .get("frame")
                .cloned()
                .unwrap_or_else(|| request.payload.clone());
            // Explicit bridge frames continue accepting camelCase frameId.
            if let Some(object) = value.as_object_mut() {
                if object.get("frame_id").is_none() {
                    if let Some(frame_id) = object.remove("frameId") {
                        object.insert("frame_id".into(), frame_id);
                    }
                }
            }
            let frame: RenderFrame = serde_json::from_value(value).map_err(|e| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("invalid render frame: {e}"),
                )
            })?;
            (PreparedSkiaFrame::explicit(frame), None)
        };
        let mut scrolling = self.scrolling.clone();
        scrolling.reconcile(
            self.app_service.pages().current().map(|page| page.id),
            prepared.frame_mut(),
            generated,
        )?;
        let canvas_bindings = self.prepare_owned_canvas_bindings(prepared.frame(), generated)?;
        if let Some(animations) = prepared.animations() {
            self.validate_prepared_animations(animations)?;
        }
        let AcceptedSkiaFrame {
            frame_id,
            manifest,
            retired_page,
        } = self
            .skia_backend
            .accept_with_canvas_bindings(prepared, canvas_bindings.keys.clone())?;
        self.accept_owned_canvas_bindings(canvas_bindings);
        let (page_input, generated_document, generated_resources, animations, retained_scene) =
            match manifest {
                Some(AcceptedManifestFrame {
                    page_input,
                    document,
                    resources,
                    animations,
                    retained_animation_scene,
                }) => (
                    page_input,
                    Some(document),
                    Some(resources),
                    animations,
                    retained_animation_scene,
                ),
                None => (None, None, None, None, None),
            };
        self.retained_animation_scene = retained_scene;
        self.stage_native_animations(self.skia_backend.renderer.snapshot_revision(), animations);
        // The backend has accepted the exact frame and cache candidate. Only
        // the session can now publish input provenance and resource authority.
        // Explicit frames/data renders still carry no cloned page-input proof.
        self.record_last_frame_input(page_input);
        self.scrolling = scrolling;
        self.accepted_skia_scene = generated_document.is_some();
        self.capture_consumed_component_inputs();
        self.accepted_view_document = generated_document;
        if let Some(blobs) = generated_resources {
            self.render_blobs = blobs;
            self.render_resources_verified = true;
        }
        self.view.last_frame_id = Some(frame_id);
        self.observer_frame_page = self.app_service.pages().current().map(|page| page.id);
        self.install_skia_frame_authority();
        // Release previous page images and surfaces after the renderer,
        // Canvas bindings and Session authority publish their joint state.
        drop(retired_page);
        let messages = vec![self.response(request, json!({"ok": true, "committed": true, "frameId": frame_id, "backend": self.skia_backend.renderer.backend_name(), "revision": self.view.revision, "source": if generated_template.is_some() { "manifest" } else { "frame" }, "templateId": generated_template})), self.diagnostic(request, "debug", "render committed", json!({"frameId": frame_id, "source": if generated_template.is_some() { "manifest" } else { "frame" }}))];
        self.suspend_dev_raster_presentation();
        if self.skia_backend.renderer.page_render_mode()
            != container_render_skia::PageRenderMode::Raster
            || self.dev_raster_presentation_required()
        {
            self.observer_frame_valid = false;
            self.pending_presentation = Some((self.observer_frame_page, frame_id, generated));
            return Ok(messages);
        }
        self.finish_presented_frame(request, frame_id, generated, messages)
    }

    /// Confirm a frame on the runtime owner thread after the host submitted it
    /// to its real presentation surface. HTTP acceptance/CPU preparation alone
    /// must never invoke ready hooks or expose unpresented selector geometry.
    pub fn acknowledge_presentation(&mut self, revision: u64) -> Result<BridgeBatch, BridgeError> {
        if self.dev_raster_presentation_required() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "developer Raster presentation requires its exact owner-issued ticket",
            ));
        }
        self.with_engine_batch_turn(None, |session| {
            session.acknowledge_presentation_within_turn(revision)
        })
    }

    fn acknowledge_presentation_within_turn(
        &mut self,
        revision: u64,
    ) -> Result<BridgeBatch, BridgeError> {
        self.validate_presentation_revision(revision)?;
        // Legacy ACKs are identified by the accepted renderer revision. A new
        // developer preview lease has a separate identity and must complete
        // its effects/observations even when it presents the same pixels.
        if self.presented_revision == Some(revision) {
            return Ok(BridgeBatch::new(Vec::new()));
        }
        self.complete_accepted_presentation_within_turn(revision)
    }

    fn validate_presentation_revision(&self, revision: u64) -> Result<(), BridgeError> {
        self.ensure_view_execution_healthy()?;
        if self.navigation_blocks_presentation() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "navigation layout is not presented",
            ));
        }
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "browser presentation requires its prepared commit permit",
            ));
        }
        if revision == 0 || revision != self.skia_backend.renderer.snapshot_revision() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "stale presentation revision",
            ));
        }
        if self.skia_frame_authority_required() && self.current_skia_frame_authority().is_none() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "presentation has no current accepted layout authority",
            ));
        }
        Ok(())
    }

    /// Complete one already-validated presentation identity. Legacy callers
    /// deduplicate by renderer revision; developer callers deduplicate by their
    /// exact lease ticket before entering. This drain is not revision-keyed:
    /// observers may have been registered while identical pixels had no owner.
    fn complete_accepted_presentation_within_turn(
        &mut self,
        revision: u64,
    ) -> Result<BridgeBatch, BridgeError> {
        self.validate_presentation_revision(revision)?;
        let page = self.app_service.pages().current().map(|page| page.id);
        let (frame_id, generated) =
            if let Some((owner, frame_id, generated)) = self.pending_presentation {
                if owner != page {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Cancelled,
                        "presentation belongs to an inactive page",
                    ));
                }
                (frame_id, generated)
            } else {
                let frame = self.skia_backend.renderer.last_frame().ok_or_else(|| {
                    BridgeError::new(BridgeErrorCode::Render, "no accepted frame to present")
                })?;
                // An unrestricted renderer borrow retires this owner even
                // when a replacement reuses the old numeric revision. Keep the
                // legacy no-page manual-frame path (None == None) compatible;
                // a live page requires ownership from a normal render commit.
                if self.observer_frame_page != page {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Cancelled,
                        "presentation belongs to an inactive page",
                    ));
                }
                // Presenter retirement discards the old receipt, not the
                // accepted scene's manifest origin or its pending ready work.
                // This fresh validated ACK may complete that work exactly once.
                // Manual frames and pictures from another page remain excluded.
                (frame.frame_id, self.has_current_skia_scene())
            };
        self.pending_presentation = None;
        let request = BridgeEnvelope::event(
            self.config.session_id.clone(),
            "view.presented",
            json!({"revision":revision}),
        );
        self.finish_presented_frame(&request, frame_id, generated, Vec::new())
            .map(BridgeBatch::new)
    }

    fn finish_presented_frame(
        &mut self,
        request: &BridgeEnvelope,
        frame_id: u64,
        generated: bool,
        mut messages: Vec<BridgeEnvelope>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.finish_native_animation_presentation(self.skia_backend.renderer.snapshot_revision())?;
        self.observer_frame_valid = true;
        self.presented_revision = Some(self.skia_backend.renderer.snapshot_revision());
        let touch_error = self.cancel_invalid_touches().err();
        if let Err(error) = self.ensure_engine_execution_healthy() {
            messages.push(self.render_commit_diagnostic(request, frame_id, "touchcancel", &error));
            return Ok(messages);
        }
        // Publication is irreversible: ready hooks and their callbacks can
        // mutate JavaScript state or throw after the new pixels and event
        // topology became visible. Keep the acknowledgement even on those
        // failures, so hosts never roll metadata back behind a published frame.
        let ready_error = if generated {
            self.ready_page_components().err()
        } else {
            None
        };

        if let Some(error) = touch_error {
            messages.push(self.render_commit_diagnostic(request, frame_id, "touchcancel", &error));
        }
        if let Some(error) = ready_error {
            messages.push(self.render_commit_diagnostic(request, frame_id, "ready", &error));
        }
        if let Err(error) = self.ensure_engine_execution_healthy() {
            messages.push(self.render_commit_diagnostic(request, frame_id, "ready", &error));
            return Ok(messages);
        }
        self.append_scroll_notifications(&mut messages);
        // onReady can register an observer without mutating data. Its first
        // measurement belongs to this published frame, so consume registration
        // effects before notification and consume callback writes afterward.
        if let Err(error) = self.append_engine_effects(&mut messages) {
            messages.push(self.render_commit_diagnostic(request, frame_id, "effects", &error));
        }
        if messages.iter().any(effect_continuation_stopped) {
            return Ok(messages);
        }
        if let Err(error) = self.notify_observers(&mut messages) {
            messages.push(self.render_commit_diagnostic(request, frame_id, "observers", &error));
        }
        // Drain effects even when ready threw: writes made before an exception
        // remain authoritative, and errors must reach the development overlay.
        if let Err(error) = self.append_engine_effects(&mut messages) {
            messages.push(self.render_commit_diagnostic(request, frame_id, "effects", &error));
        }
        Ok(messages)
    }

    fn render_commit_diagnostic(
        &self,
        request: &BridgeEnvelope,
        frame_id: u64,
        phase: &str,
        error: &BridgeError,
    ) -> BridgeEnvelope {
        let mut message = self.error_envelope(error, request.request_id.clone(), op::ERROR);
        message.payload["committed"] = json!(true);
        message.payload["frameId"] = json!(frame_id);
        message.payload["phase"] = json!(phase);
        message
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn component_registration_index(payload: &Map<String, Value>) -> Result<usize, BridgeError> {
        payload
            .get("componentIndex")
            .or_else(|| payload.get("component_index"))
            .or_else(|| payload.get("index"))
            .and_then(Value::as_u64)
            .map(|index| index as usize)
            .ok_or_else(|| BridgeError::invalid("component operation requires componentIndex"))
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn handle_component_mount(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let index = Self::component_registration_index(payload)?;
        let properties = payload
            .get("properties")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !properties.is_object() {
            return Err(BridgeError::invalid(
                "component.mount properties must be an object",
            ));
        }
        let result = self
            .call_engine(
                CallTarget::Global {
                    name: "__container_mount_component".into(),
                },
                vec![json!(index), properties],
            )?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let mut messages = vec![
            self.response(
                request,
                json!({"ok": true, "componentIndex": index, "instance": result}),
            ),
            self.diagnostic(
                request,
                "info",
                "component mounted",
                json!({"componentIndex": index}),
            ),
        ];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn handle_component_update(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let index = Self::component_registration_index(payload)?;
        let properties = payload
            .get("properties")
            .or_else(|| payload.get("patch"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        if !properties.is_object() {
            return Err(BridgeError::invalid(
                "component.update properties must be an object",
            ));
        }
        let result = self
            .call_engine(
                CallTarget::Global {
                    name: "__container_update_component".into(),
                },
                vec![json!(index), properties],
            )?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let mut messages = vec![
            self.response(
                request,
                json!({"ok": true, "componentIndex": index, "instance": result}),
            ),
            self.diagnostic(
                request,
                "debug",
                "component properties updated",
                json!({"componentIndex": index}),
            ),
        ];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn handle_component_unmount(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let index = Self::component_registration_index(payload)?;
        let result = self
            .call_engine(
                CallTarget::Global {
                    name: "__container_unmount_component".into(),
                },
                vec![json!(index)],
            )?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let mut messages = vec![
            self.response(
                request,
                json!({"ok": true, "componentIndex": index, "instance": result}),
            ),
            self.diagnostic(
                request,
                "info",
                "component unmounted",
                json!({"componentIndex": index}),
            ),
        ];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    fn handle_component_mount(
        &mut self,
        _request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        Err(BridgeError::new(
            BridgeErrorCode::Engine,
            "component lifecycle requires a native JavaScript provider",
        ))
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    fn handle_component_update(
        &mut self,
        _request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        Err(BridgeError::new(
            BridgeErrorCode::Engine,
            "component lifecycle requires a native JavaScript provider",
        ))
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    fn handle_component_unmount(
        &mut self,
        _request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        Err(BridgeError::new(
            BridgeErrorCode::Engine,
            "component lifecycle requires a native JavaScript provider",
        ))
    }

    fn handle_api_call(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let name = payload
            .get("name")
            .or_else(|| payload.get("api"))
            .or_else(|| payload.get("method"))
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("api.call requires name"))?;
        if name == "wx.canIUse" {
            if !distribution::showcase_capability_allowed(name) {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    "wx.canIUse is unsupported on this session",
                ));
            }
            let requested = payload
                .get("capability")
                .or_else(|| payload.get("apiName"))
                .or_else(|| payload.get("api"))
                .or_else(|| payload.get("target"))
                .or_else(|| {
                    payload
                        .get("args")
                        .and_then(Value::as_array)
                        .and_then(|args| args.first())
                });
            let support = requested
                .and_then(Value::as_str)
                .map(|candidate| {
                    let direct = self.effective_capability(candidate);
                    // WeChat accepts the public short spelling (for example
                    // `wx.canIUse("request")`) as well as `wx.request`.
                    // Component capability paths contain dots and must remain
                    // opaque, so only retry a bare API name with the wx prefix.
                    if direct == CapabilitySupport::Unsupported
                        && !candidate.contains('.')
                        && candidate != "getCurrentPages"
                    {
                        self.effective_capability(&format!("wx.{candidate}"))
                    } else {
                        direct
                    }
                })
                .unwrap_or(CapabilitySupport::Unsupported);
            return Ok(vec![self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "result": support != CapabilitySupport::Unsupported,
                    "support": support,
                }),
            )]);
        }
        let support = self.effective_capability(name);
        if support == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                format!("{name} is unsupported on this session"),
            ));
        }
        if name == random_values::API {
            let result = self.random_values_api_result(
                payload,
                request.deadline_ns,
                request.cancel_token.as_deref(),
            )?;
            return Ok(vec![self.response(
                request,
                json!({"ok":true,"name":name,"result":result,"support":support}),
            )]);
        }
        if tab_bar::is_api(name) {
            let result = self.tab_bar_api_result(
                name,
                payload,
                request.deadline_ns,
                request.cancel_token.as_deref(),
            )?;
            return Ok(vec![self.response(
                request,
                json!({"ok":true,"name":name,"result":result,"support":support}),
            )]);
        }
        if is_storage_api(name) {
            return self.handle_storage_api(request, name, payload);
        }
        if is_timer_api(name) {
            return self.handle_timer_api(request, name, payload);
        }
        if is_selector_query_api(name) {
            return self.handle_selector_query(request, name, payload);
        }
        if is_navigation_api(name) {
            let mut messages = self.handle_navigation_api(request, name, payload)?;
            self.append_engine_effects(&mut messages)?;
            return Ok(messages);
        }
        if is_observer_api(name) {
            let result = self.observer_api_result(
                name,
                payload,
                request.deadline_ns,
                request.cancel_token.as_deref(),
            )?;
            return Ok(vec![self.response(
                request,
                json!({"ok":true,"name":name,"result":result}),
            )]);
        }
        if is_provider_api(name) || self.host_service_registered(name) {
            if name == "wx.pageScrollTo" {
                let result = self.page_scroll_to(
                    payload,
                    request.deadline_ns,
                    request.cancel_token.as_deref(),
                )?;
                let mut messages = vec![self.response(
                    request,
                    json!({"ok":true,"name":name,"result":result,"support":support}),
                )];
                self.append_scroll_notifications(&mut messages);
                self.append_engine_effects(&mut messages)?;
                return Ok(messages);
            }
            return self.handle_provider_api(request, name, payload);
        }
        Err(BridgeError::new(
            BridgeErrorCode::UnsupportedCapability,
            format!("{name} has no registered provider implementation"),
        ))
    }

    fn handle_provider_api(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.validate_host_service_call(name, payload)?;
        let mut context = self.provider_context(payload, 60_000)?;
        context.deadline_ns = match (context.deadline_ns, request.deadline_ns) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        if request.cancel_token.is_some() {
            context.cancel_token = request.cancel_token.clone();
        }
        context.cancelled = context
            .cancel_token
            .as_deref()
            .is_some_and(|token| self.is_cancelled(token));
        let result = if matches!(name, "wx.getLaunchOptionsSync" | "wx.getEnterOptionsSync") {
            Ok(self.launch_options.clone())
        } else {
            let started = if name.ends_with("Sync") || name == "wx.canvas.draw" {
                ProviderStart::Ready(self.provider.call(name, payload, &context))
            } else {
                self.provider.start_call(name, payload, &context)
            };
            match started {
                ProviderStart::Ready(result) => result,
                ProviderStart::Pending => {
                    let call_id = self.queue_host_call(
                        name,
                        Value::Object(payload.clone()),
                        context,
                        async_host::CallTargetKind::Bridge {
                            request_id: request.request_id.clone(),
                            name: name.to_owned(),
                        },
                    )?;
                    return Ok(vec![self.response(
                        request,
                        json!({"ok":true,"pending":true,"callId":call_id,"name":name}),
                    )]);
                }
            }
        }
        .map_err(provider_bridge_error)?;
        let result = if name == "wx.canvas.draw" {
            let surface = self.commit_canvas_draw(payload)?;
            let mut result = result;
            if let Some(object) = result.as_object_mut() {
                object.insert("surface".into(), surface);
            }
            result
        } else {
            result
        };
        Ok(vec![
            self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "provider": self.provider.name(),
                    "result": result,
                }),
            ),
            self.diagnostic(
                request,
                "debug",
                "provider API call completed",
                json!({"name": name, "provider": self.provider.name()}),
            ),
        ])
    }

    /// Validate and replay one provider-facing `wx.canvas.draw` batch. The
    /// provider owns permissions and host-specific resource lookup; the
    /// renderer owns command semantics and surface lifetime. Keeping these
    /// boundaries separate ensures an accepted provider call cannot claim a
    /// successful draw when the Canvas service rejects a command. Offscreen
    /// drawing and snapshot reads never initialize a page renderer.
    fn commit_canvas_draw(&mut self, payload: &Map<String, Value>) -> Result<Value, BridgeError> {
        let canvas_id = payload
            .get("canvasId")
            .or_else(|| payload.get("canvas_id"))
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("wx.canvas.draw requires canvasId"))?;
        let fallback_size = self
            .skia_backend
            .renderer
            .canvas_snapshot(canvas_id)
            .map(|snapshot| (snapshot.width, snapshot.height));
        let frame_id = self
            .canvas_frame_sequence
            .max(self.view.last_frame_id.unwrap_or_default())
            .saturating_add(1);
        let frame = CanvasFrame::from_payload(payload, frame_id, fallback_size)
            .map_err(render_bridge_error)?;
        let command_count = frame.commands.len();
        let snapshot = self
            .skia_backend
            .renderer
            .commit_canvas(frame)
            .map_err(render_bridge_error)?;
        self.canvas_frame_sequence = snapshot.frame_id;
        Ok(json!({
            "frameId": snapshot.frame_id,
            "canvasId": canvas_id,
            "width": snapshot.width,
            "height": snapshot.height,
            "stride": snapshot.stride,
            "format": snapshot.format,
            "commands": command_count,
        }))
    }

    fn handle_navigation_api(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        if self.navigation_layout.enabled && navigation_layout::is_structural_navigation(name) {
            self.enqueue_navigation(
                request.clone(),
                name,
                payload.clone(),
                navigation_layout::NavigationCompletion::Bridge(request.clone()),
            )?;
            return Ok(vec![
                self.response(request, json!({"ok":true,"pending":true}))
            ]);
        }
        let result = self.navigation_result(request, name, payload, None)?;
        Ok(vec![self.response(request, result)])
    }

    fn bind_navigation_event_channel(
        &mut self,
        engine_request_id: Option<u64>,
        page_id: PageId,
    ) -> Result<(), BridgeError> {
        let Some(request_id) = engine_request_id else {
            return Ok(());
        };
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if self.engine_provider_available() && !self.loaded_modules.is_empty() {
            self.sync_current_pages()?;
            // The function handle was captured before guest evaluation. A
            // compatibility global replacement cannot redirect the binding.
            let bound = match self.config.engine {
                EngineKind::Quickjs => {
                    #[cfg(feature = "quickjs-native")]
                    {
                        self.quickjs_engine
                            .as_mut()
                            .ok_or_else(|| {
                                BridgeError::new(
                                    BridgeErrorCode::Engine,
                                    "QuickJS provider unavailable",
                                )
                            })?
                            .bind_event_channel(request_id, page_id.0)
                            .map_err(|error| {
                                engine_bridge_error(
                                    error.into_core_error(),
                                    BridgeErrorCode::Engine,
                                )
                            })?
                    }
                    #[cfg(not(feature = "quickjs-native"))]
                    {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Engine,
                            "QuickJS provider unavailable",
                        ));
                    }
                }
                EngineKind::V8 => {
                    #[cfg(feature = "v8-native")]
                    {
                        self.v8_engine
                            .as_mut()
                            .ok_or_else(|| {
                                BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                            })?
                            .bind_event_channel(request_id, page_id.0)
                            .map_err(|error| {
                                BridgeError::new(BridgeErrorCode::Engine, error.to_string())
                            })?
                    }
                    #[cfg(not(feature = "v8-native"))]
                    {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Engine,
                            "V8 provider unavailable",
                        ));
                    }
                }
            };
            if !bound {
                return Err(BridgeError::new(
                    BridgeErrorCode::Engine,
                    "navigation event channel is missing",
                ));
            }
        }
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (request_id, page_id);
        Ok(())
    }

    /// Bridge requests and engine pending calls must commit the same operation
    /// before reporting completion. Keep validation ahead of user lifecycle
    /// hooks, and publish the stack mirror before resolving JS callbacks.
    fn navigation_result(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
        engine_request_id: Option<u64>,
    ) -> Result<Value, BridgeError> {
        self.validate_navigation_admission(request, name)?;
        if navigation_layout::is_structural_navigation(name) {
            let prepared = self.prepare_route_transaction(
                name,
                payload,
                route_transaction::RouteOrigin::PublicApi,
            )?;
            self.navigation_result_prepared(request, name, engine_request_id, prepared)
        } else {
            self.with_route_notifications(|session| {
                session.navigation_result_in_route(request, name, payload, engine_request_id)
            })
        }
    }

    fn navigation_result_prepared(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        engine_request_id: Option<u64>,
        prepared: route_transaction::PreparedRoute,
    ) -> Result<Value, BridgeError> {
        self.finish_route_transaction(prepared, |session, payload| {
            session.navigation_result_in_route(request, name, payload, engine_request_id)
        })
    }

    fn navigation_result_in_route(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
        engine_request_id: Option<u64>,
    ) -> Result<Value, BridgeError> {
        self.validate_navigation_admission(request, name)?;
        let result = self.perform_navigation(request, name, payload, engine_request_id)?;
        self.sync_current_pages()?;
        // Host-only chrome changes must not reevaluate stateful View scripts.
        if !matches!(
            name,
            "wx.setNavigationBarTitle" | "wx.setNavigationBarColor"
        ) {
            self.view.invalidate_template();
        }
        Ok(result)
    }

    // Shared admission must run before a guest before-route callback and be
    // rechecked immediately before committing a prepared/deferred operation.
    fn validate_navigation_admission(
        &self,
        request: &BridgeEnvelope,
        name: &str,
    ) -> Result<(), BridgeError> {
        if self.effective_capability(name) == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                format!("{name} is unsupported on this session"),
            ));
        }
        self.validate_navigation_liveness(request)
    }

    fn validate_navigation_liveness(&self, request: &BridgeEnvelope) -> Result<(), BridgeError> {
        if request.deadline_ns.is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "navigation request deadline has expired",
            ));
        }
        if let Some(token) = request.cancel_token.as_deref() {
            if self.is_cancelled(token) {
                return Err(BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    format!("navigation request cancelled by token {token}"),
                ));
            }
        }
        Ok(())
    }

    fn perform_navigation(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
        engine_request_id: Option<u64>,
    ) -> Result<Value, BridgeError> {
        let raw_path = payload
            .get("url")
            .or_else(|| payload.get("path"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (path, query_value) = navigation_target(
            &self.manifest,
            name,
            raw_path.as_deref(),
            payload.get("query"),
        )?;
        let query = Some(&query_value);
        let (page_id, action) = match name {
            "wx.navigateTo" => {
                let path =
                    path.ok_or_else(|| BridgeError::invalid("wx.navigateTo requires url"))?;
                if let Some(previous) = self.app_service.pages().current().cloned() {
                    self.invoke_page_hook_for_id(previous.id, "onHide", Vec::new())?;
                }
                let id = self
                    .app_service
                    .push_page(path.clone())
                    .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
                self.bind_page_registration(&path, id);
                set_query(&mut self.app_service, id, query)?;
                if matches!(request.op.as_str(), op::PAGE_PUSH | op::PAGE_REPLACE) {
                    if let Some(data) = payload.get("data") {
                        self.page_initial_data.insert(id, data.clone());
                        if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                            page.data = data.clone();
                        }
                    }
                }
                self.commit_navigation_geometry()?;
                self.bind_navigation_event_channel(engine_request_id, id)?;
                let query_value = self.page_query_value(id);
                self.invoke_page_hook_for_id(id, "onLoad", vec![query_value])?;
                self.invoke_page_hook_for_id(id, "onShow", Vec::new())?;
                self.invoke_page_hook_for_id(id, "onReady", Vec::new())?;
                (id, "navigateTo")
            }
            "wx.redirectTo" => {
                let path =
                    path.ok_or_else(|| BridgeError::invalid("wx.redirectTo requires url"))?;
                if let Some(previous) = self.app_service.pages().current().cloned() {
                    self.invoke_page_hook_for_id(previous.id, "onUnload", Vec::new())?;
                }
                let old = self.app_service.pages().current().map(|page| page.id);
                let id = self
                    .app_service
                    .replace_page(path.clone())
                    .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
                if let Some(old) = old {
                    self.unbind_page(old)?;
                }
                self.bind_page_registration(&path, id);
                set_query(&mut self.app_service, id, query)?;
                if matches!(request.op.as_str(), op::PAGE_PUSH | op::PAGE_REPLACE) {
                    if let Some(data) = payload.get("data") {
                        self.page_initial_data.insert(id, data.clone());
                        if let Some(page) = self.app_service.pages_mut().get_mut(id) {
                            page.data = data.clone();
                        }
                    }
                }
                self.commit_navigation_geometry()?;
                let query_value = self.page_query_value(id);
                self.invoke_page_hook_for_id(id, "onLoad", vec![query_value])?;
                self.invoke_page_hook_for_id(id, "onShow", Vec::new())?;
                self.invoke_page_hook_for_id(id, "onReady", Vec::new())?;
                (id, "redirectTo")
            }
            "wx.reLaunch" => {
                let path =
                    path.ok_or_else(|| BridgeError::invalid(format!("{name} requires url")))?;
                self.unload_all_pages()?;
                let id = self
                    .app_service
                    .push_page(path.clone())
                    .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
                self.bind_page_registration(&path, id);
                set_query(&mut self.app_service, id, query)?;
                self.commit_navigation_geometry()?;
                let query_value = self.page_query_value(id);
                self.invoke_page_hook_for_id(id, "onLoad", vec![query_value])?;
                self.invoke_page_hook_for_id(id, "onShow", Vec::new())?;
                self.invoke_page_hook_for_id(id, "onReady", Vec::new())?;
                (id, "reLaunch")
            }
            "wx.switchTab" => {
                let path = path.ok_or_else(|| BridgeError::invalid("wx.switchTab requires url"))?;
                let (id, hooks) = self.switch_tab_page(&path, query)?;
                return Ok(json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "errMsg": "switchTab:ok",
                    "pageId": id.0,
                    "page": self.app_service.pages().get(id),
                    "stackDepth": self.app_service.pages().len(),
                    "hooks": hooks,
                }));
            }
            "wx.navigateBack" => {
                let delta = payload
                    .get("delta")
                    .and_then(Value::as_u64)
                    .unwrap_or(1)
                    .max(1);
                let atomic = self.navigation_layout.committing;
                if atomic {
                    let departing = self
                        .app_service
                        .pages()
                        .iter()
                        .rev()
                        .take(
                            delta.min(self.app_service.pages().len().saturating_sub(1) as u64)
                                as usize,
                        )
                        .map(|page| page.id)
                        .collect::<Vec<_>>();
                    for page in departing {
                        self.invoke_page_hook_for_id(page, "onUnload", Vec::new())?;
                    }
                }
                let mut popped = Vec::new();
                for _ in 0..delta {
                    if self.app_service.pages().len() <= 1 {
                        break;
                    }
                    if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
                        self.cancel_touches_for_page(page, "page-popped")?;
                    }
                    let page = self.app_service.pages().current().cloned().ok_or_else(|| {
                        runtime_error(RuntimeError::NoCurrentPage, BridgeErrorCode::InvalidRequest)
                    })?;
                    let page_index = self.page_registration_index_for_id(&page.path, page.id);
                    if !atomic {
                        self.invoke_page_hook_for_id_with_index(
                            page.id,
                            page_index,
                            "onUnload",
                            Vec::new(),
                        )?;
                    }
                    self.app_service
                        .pop_page()
                        .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?;
                    self.unbind_page(page.id)?;
                    popped.push(page);
                }
                let id = self
                    .app_service
                    .pages()
                    .current()
                    .ok_or(RuntimeError::NoCurrentPage)
                    .map_err(|e| runtime_error(e, BridgeErrorCode::InvalidRequest))?
                    .id;
                self.commit_navigation_geometry()?;
                if let Some(current) = self.app_service.pages().current().cloned() {
                    self.invoke_page_path_hook(&current.path, "onShow", Vec::new())?;
                }
                return Ok(json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "errMsg": "navigateBack:ok",
                    "delta": popped.len(),
                    "pageId": id.0,
                    "stackDepth": self.app_service.pages().len(),
                }));
            }
            "wx.preloadPage" => {
                let path =
                    path.ok_or_else(|| BridgeError::invalid("wx.preloadPage requires url"))?;
                let route_exists = self.manifest.routes.iter().any(|route| route.path == path);
                if !route_exists {
                    return Err(BridgeError::invalid(format!("unknown route {path}")));
                }
                let id = self
                    .app_service
                    .pages()
                    .current()
                    .map(|page| page.id)
                    .unwrap_or(PageId(0));
                (id, "preloadPage")
            }
            "wx.setNavigationBarTitle" => {
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        BridgeError::invalid("wx.setNavigationBarTitle requires title")
                    })?;
                let id = self
                    .app_service
                    .pages()
                    .current()
                    .map(|page| page.id)
                    .ok_or_else(|| {
                        runtime_error(RuntimeError::NoCurrentPage, BridgeErrorCode::InvalidRequest)
                    })?;
                let context = ProviderContext {
                    session_id: self.config.session_id.clone(),
                    host: self.config.host.clone(),
                    now_ns: unix_now_ns(),
                    deadline_ns: request.deadline_ns,
                    cancel_token: request.cancel_token.clone(),
                    cancelled: request
                        .cancel_token
                        .as_deref()
                        .is_some_and(|token| self.is_cancelled(token)),
                };
                self.provider
                    .set_navigation_bar_title(title, &context)
                    .map_err(provider_bridge_error)?;
                self.app_service
                    .set_navigation_bar_title(id, title)
                    .map_err(|error| runtime_error(error, BridgeErrorCode::InvalidRequest))?;
                (id, "setNavigationBarTitle")
            }
            "wx.setNavigationBarColor" => {
                let front = payload
                    .get("frontColor")
                    .and_then(Value::as_str)
                    .filter(|value| matches!(*value, "#ffffff" | "#000000"))
                    .ok_or_else(|| BridgeError::invalid("frontColor must be #ffffff or #000000"))?;
                let background = payload
                    .get("backgroundColor")
                    .and_then(Value::as_str)
                    .filter(|value| {
                        value.len() == 7
                            && value.starts_with('#')
                            && value[1..].bytes().all(|b| b.is_ascii_hexdigit())
                    })
                    .ok_or_else(|| BridgeError::invalid("backgroundColor must be #RRGGBB"))?;
                let id = self
                    .app_service
                    .pages()
                    .current()
                    .ok_or_else(|| BridgeError::invalid("no current page"))?
                    .id;
                let context = ProviderContext {
                    session_id: self.config.session_id.clone(),
                    host: self.config.host.clone(),
                    now_ns: unix_now_ns(),
                    deadline_ns: request.deadline_ns,
                    cancel_token: request.cancel_token.clone(),
                    cancelled: request
                        .cancel_token
                        .as_deref()
                        .is_some_and(|token| self.is_cancelled(token)),
                };
                self.provider
                    .call(name, payload, &context)
                    .map_err(provider_bridge_error)?;
                self.app_service
                    .pages_mut()
                    .set_navigation_bar_color(
                        id,
                        container_core::NavigationBarColor {
                            front_color: front.to_owned(),
                            background_color: background.to_owned(),
                        },
                    )
                    .map_err(|error| BridgeError::invalid(error.to_string()))?;
                (id, "setNavigationBarColor")
            }
            _ => {
                return Err(BridgeError::invalid(format!(
                    "unsupported navigation API {name}"
                )));
            }
        };
        if name == "wx.setNavigationBarColor" {
            // Preserve the provider API response envelope used before chrome
            // became page-instance state, including result.errMsg.
            return Ok(
                json!({"ok":true,"name":name,"support":self.effective_capability(name),
                "provider":self.provider.name(),"result":{"errMsg":"setNavigationBarColor:ok"}}),
            );
        }
        let page = self.app_service.pages().get(page_id).cloned();
        Ok(json!({
            "ok": true,
            "name": name,
            "support": self.effective_capability(name),
            "errMsg": format!("{action}:ok"),
            "pageId": page_id.0,
            "page": page,
            "stackDepth": self.app_service.pages().len(),
        }))
    }

    fn handle_storage_api(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.reconcile_engine_storage()?;
        let is_sync = name.ends_with("Sync");
        let is_set = matches!(name, "wx.setStorage" | "wx.setStorageSync");
        let is_get = matches!(name, "wx.getStorage" | "wx.getStorageSync");
        let is_info = matches!(name, "wx.getStorageInfo" | "wx.getStorageInfoSync");
        let is_remove = matches!(name, "wx.removeStorage" | "wx.removeStorageSync");
        let is_clear = matches!(name, "wx.clearStorage" | "wx.clearStorageSync");
        if matches!(name, "wx.setStorage" | "wx.getStorage") {
            match payload.get("encrypt") {
                Some(Value::Bool(true)) => {
                    return Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        "encrypted storage is not implemented",
                    ));
                }
                Some(Value::Bool(false)) | None => {}
                _ => return Err(BridgeError::invalid("storage encrypt must be a boolean")),
            }
        }
        if matches!(name, "wx.batchSetStorage" | "wx.batchSetStorageSync") {
            let entries = payload
                .get("kvList")
                .and_then(Value::as_array)
                .ok_or_else(|| BridgeError::invalid("batch storage requires kvList"))?;
            let mut operations = Vec::with_capacity(entries.len());
            for entry in entries {
                let key = entry
                    .get("key")
                    .and_then(Value::as_str)
                    .ok_or_else(|| BridgeError::invalid("batch storage entry requires key"))?;
                operations.push(container_core::StorageMutation::Set {
                    key: key.to_owned(),
                    value: entry
                        .get("value")
                        .cloned()
                        .map(container_core::StorageValue::Json)
                        .unwrap_or(container_core::StorageValue::Undefined),
                });
            }
            self.app_service
                .apply_storage_transaction(operations)
                .map_err(|error| BridgeError::invalid(error.to_string()))?;
            return Ok(vec![self.response(request, json!({
                "ok": true, "name": name, "support": self.effective_capability(name),
                "errMsg": format!("{name}:ok"),
                "result": if is_sync { Value::Null } else { json!({"errMsg": format!("{name}:ok")}) },
            }))]);
        }
        if is_info {
            let snapshot = self.app_service.storage().snapshot();
            let keys = snapshot.keys().cloned().collect::<Vec<_>>();
            let current_size = self.app_service.storage().usage().current_size_kib();
            return Ok(vec![self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "errMsg": format!("{name}:ok"),
                    "result": {"keys": keys, "currentSize": current_size, "limitSize": 10240, "errMsg": "getStorageInfo:ok"},
                }),
            )]);
        }
        if is_clear {
            let removed = self.app_service.clear_storage();
            return Ok(vec![self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "errMsg": format!("{name}:ok"),
                    "removed": removed,
                    "result": if is_sync { Value::Null } else { json!({"errMsg": format!("{name}:ok")}) },
                }),
            )]);
        }
        let key = payload
            .get("key")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid(format!("{name} requires key")))?;
        if key.trim().is_empty() {
            return Err(BridgeError::invalid(format!("{name} key cannot be empty")));
        }
        if is_set {
            let value = payload
                .get("data")
                .or_else(|| payload.get("value"))
                .cloned();
            let is_undefined =
                payload.get("undefined").and_then(Value::as_bool) == Some(true) || value.is_none();
            if is_undefined {
                self.app_service
                    .set_storage_undefined(key)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?;
            } else {
                self.app_service
                    .set_storage(key.to_string(), value.unwrap_or(Value::Null))
                    .map_err(|error| BridgeError::invalid(error.to_string()))?;
            }
            return Ok(vec![self.response(request, json!({
                "ok": true, "name": name, "support": self.effective_capability(name),
                "errMsg": format!("{name}:ok"),
                "result": if is_sync { Value::Null } else { json!({"errMsg": format!("{name}:ok")}) },
            }))]);
        }
        if is_get {
            let storage = self.app_service.storage();
            let found = storage.contains_key(key);
            let is_undefined = storage.is_undefined(key);
            let value = storage.get_cloned(key);
            let success = is_sync || found;
            let err_msg = if success {
                format!("{name}:ok")
            } else {
                format!("{name}:fail data not found")
            };
            let result = if is_sync {
                if found {
                    value.clone().unwrap_or(Value::Null)
                } else {
                    json!("")
                }
            } else if found {
                if is_undefined {
                    json!({"errMsg": err_msg})
                } else {
                    json!({"data": value, "errMsg": err_msg})
                }
            } else {
                Value::Null
            };
            let mut response = json!({
                "ok": success, "name": name, "support": self.effective_capability(name),
                "found": found, "undefined": is_undefined, "errMsg": err_msg,
                "result": result,
                "data": if is_sync && !found { json!("") } else { value.unwrap_or(Value::Null) },
            });
            if !success {
                response["error"] = json!({
                    "code": BridgeErrorCode::InvalidRequest,
                    "message": "data not found", "errMsg": err_msg, "api": name,
                    "retryable": false,
                });
            }
            return Ok(vec![self.response(request, response)]);
        }
        if is_remove {
            let removed = self.app_service.remove_storage(key).is_some();
            return Ok(vec![self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "removed": removed,
                    "errMsg": format!("{name}:ok"),
                    "result": if is_sync { Value::Null } else { json!({"errMsg": format!("{name}:ok")}) },
                }),
            )]);
        }
        Err(BridgeError::invalid(format!("unknown storage API {name}")))
    }

    fn handle_timer_api(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        let is_set = matches!(name, "setTimeout" | "setInterval");
        if is_set {
            let delay_ms = parse_optional_u64(
                payload.get("delayMs").or_else(|| payload.get("delay")),
                "delayMs",
            )?
            .unwrap_or(0);
            let callback_id = payload
                .get("callbackId")
                .or_else(|| payload.get("callback_id"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let kind = if name == "setTimeout" {
                TimerKind::Timeout
            } else {
                TimerKind::Interval
            };
            let timer_id = self.app_service.schedule_timer(
                kind,
                delay_ms,
                self.timer_now_ns(),
                callback_id.clone(),
            );
            return Ok(vec![self.response(
                request,
                json!({
                    "ok": true,
                    "name": name,
                    "support": self.effective_capability(name),
                    "timerId": timer_id.0,
                    "delayMs": delay_ms,
                    "callbackId": callback_id,
                    "result": timer_id.0,
                }),
            )]);
        }
        let timer_id = parse_optional_u64(
            payload
                .get("timerId")
                .or_else(|| payload.get("timer_id"))
                .or_else(|| payload.get("id")),
            "timerId",
        )?
        .ok_or_else(|| BridgeError::invalid(format!("{name} requires timerId")))?;
        let cancelled = self.app_service.cancel_timer(TimerId(timer_id));
        Ok(vec![self.response(
            request,
            json!({
                "ok": true,
                "name": name,
                "support": self.effective_capability(name),
                "timerId": timer_id,
                "cancelled": cancelled,
                "result": Value::Null,
            }),
        )])
    }

    /// Execute a one-shot `SelectorQuery` against the most recently committed
    /// render tree.  The JS-facing API normally builds a fluent query object;
    /// at the bridge boundary we represent that object as one JSON request so
    /// a host never performs a per-node round trip.  `all: true` is equivalent
    /// to `selectAll`, while the default returns the first match like
    /// `select`/`boundingClientRect`.
    fn handle_selector_query(
        &mut self,
        request: &BridgeEnvelope,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        if self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "DOM SelectorQuery requires an engine-captured live owner; direct bridge queries are unsupported",
            ));
        }
        let (selector, all, count, result) = self.selector_query_result(payload)?;
        Ok(vec![self.response(
            request,
            json!({
                "ok": true,
                "name": name,
                "support": self.effective_capability(name),
                "selector": selector,
                "all": all,
                "count": count,
                "result": result,
            }),
        )])
    }

    /// Resolve a selector query against the latest committed render tree.
    ///
    /// The same helper serves direct bridge calls and native engine effects so
    /// `wx.createSelectorQuery().exec()` has exactly one implementation of
    /// selector matching and geometry serialization.  `exec: true` wraps the
    /// operation result in the array shape used by the JavaScript API.
    fn selector_query_result(
        &self,
        payload: &Map<String, Value>,
    ) -> Result<(String, bool, usize, Value), BridgeError> {
        // Both bridge requests and native engine effects enter here. Native
        // effects do not pass through handle_api_call, so capability checks
        // must precede geometry access at this shared execution boundary.
        if self.effective_capability("wx.createSelectorQuery") == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.createSelectorQuery is unsupported on this session",
            ));
        }
        if let Some(queries) = payload.get("queries") {
            let queries = queries.as_array().ok_or_else(|| {
                BridgeError::invalid("selector query batch queries must be an array")
            })?;
            let mut results = Vec::with_capacity(queries.len());
            let mut count = 0usize;
            for query in queries {
                let query = query.as_object().ok_or_else(|| {
                    BridgeError::invalid("selector query batch entries must be objects")
                })?;
                if query.contains_key("queries")
                    || query.contains_key("query")
                    || query
                        .get("exec")
                        .is_some_and(|value| value != &Value::Bool(false))
                {
                    return Err(BridgeError::invalid(
                        "selector query batch entries must be unwrapped operations",
                    ));
                }
                let (_, _, matched, result) = self.selector_query_single_result(query)?;
                count = count.saturating_add(matched);
                results.push(result);
            }
            // One isolate/provider call captures every selection against the
            // same committed frame. Preserve null and empty-array slots so
            // JavaScript can pair callbacks with the operation that queued it.
            return Ok(("batch".into(), true, count, Value::Array(results)));
        }
        self.selector_query_single_result(payload)
    }

    fn selector_query_single_result(
        &self,
        payload: &Map<String, Value>,
    ) -> Result<(String, bool, usize, Value), BridgeError> {
        let query = payload
            .get("query")
            .filter(|value| value.is_object())
            .and_then(Value::as_object)
            .unwrap_or(payload);
        let target = query
            .get("target")
            .and_then(Value::as_str)
            .unwrap_or("node");
        if !matches!(target, "node" | "viewport") {
            return Err(BridgeError::invalid(format!(
                "unsupported selector query target: {target}"
            )));
        }
        let selector = query
            .get("selector")
            .or_else(|| query.get("select"))
            .and_then(Value::as_str)
            .filter(|selector| !selector.trim().is_empty());
        if target == "node" && selector.is_none() {
            return Err(BridgeError::invalid(
                "wx.createSelectorQuery requires selector",
            ));
        }
        let selector = selector.unwrap_or("viewport");
        let scope_id = selector_query_scope_id(query)?;
        let all = query.get("all").and_then(Value::as_bool).unwrap_or(false);
        let operation = query
            .get("operation")
            .and_then(Value::as_str)
            .unwrap_or("boundingClientRect");
        if !matches!(
            operation,
            "boundingClientRect" | "scrollOffset" | "fields" | "node"
        ) {
            return Err(BridgeError::invalid(format!(
                "unsupported selector query operation: {operation}"
            )));
        }
        if !self.is_current_frame_presented() {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "selector query awaits presentation",
            ));
        }
        let frame = self.skia_backend.renderer.last_frame().ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "selector query requires a committed render frame",
            )
        })?;
        let nodes = if target == "viewport" {
            vec![&frame.root]
        } else {
            frame
                .query_scoped(selector, all, scope_id)
                .map_err(|error| match error {
                    SelectorError::Empty | SelectorError::Unsupported(_) => {
                        BridgeError::invalid(error.to_string())
                    }
                })?
        };
        let fields = parse_selector_fields(query.get("fields"))?;
        let geometries = frame.node_geometries();
        let values: Vec<Value> = nodes
            .iter()
            .map(|node| {
                let mut result = selector_result(node, fields.as_ref(), operation);
                if target == "viewport" {
                    if let Some(object) = result.as_object_mut() {
                        // The page scroll model includes accepted content and at least
                        // its real client viewport; never derive content from size alone.
                        let (width, height) = node.scroll_content_extent();
                        for (key, extent) in [
                            (
                                "scrollWidth",
                                width.max(node.bounds.width).max(frame.viewport.width),
                            ),
                            (
                                "scrollHeight",
                                height.max(node.bounds.height).max(frame.viewport.height),
                            ),
                        ] {
                            if object.contains_key(key) {
                                object.insert(key.into(), json!(extent));
                            }
                        }
                    }
                }
                if operation != "scrollOffset" && operation != "node" {
                    if let Some(geometry) = geometries
                        .iter()
                        .find(|geometry| std::ptr::eq(geometry.node, *node))
                    {
                        if let Some(object) = result.as_object_mut() {
                            let rect = if target == "viewport" {
                                frame.viewport
                            } else {
                                geometry.bounds
                            };
                            for (key, value) in [
                                ("left", rect.x),
                                ("top", rect.y),
                                ("right", rect.x + rect.width),
                                ("bottom", rect.y + rect.height),
                                ("x", rect.x),
                                ("y", rect.y),
                                ("width", rect.width),
                                ("height", rect.height),
                            ] {
                                if object.get(key).is_some_and(Value::is_number) {
                                    object.insert(key.into(), json!(value));
                                }
                            }
                        }
                    }
                }
                result
            })
            .collect();
        let result = if all {
            Value::Array(values)
        } else {
            values.into_iter().next().unwrap_or(Value::Null)
        };
        let result = if target == "viewport" {
            reset_selector_viewport_identity(result)
        } else {
            result
        };
        let result = if query.get("exec").and_then(Value::as_bool).unwrap_or(false) {
            Value::Array(vec![result])
        } else {
            result
        };
        Ok((selector.to_owned(), all, nodes.len(), result))
    }

    fn handle_api_result(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        let payload = object_payload(&request.payload)?;
        let call_id = payload
            .get("callId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| BridgeError::invalid("api.result requires callId"))?;
        let result = if let Some(error) = payload.get("error").filter(|value| !value.is_null()) {
            Err(serde_json::from_value::<ProviderError>(error.clone())
                .map_err(|error| BridgeError::invalid(error.to_string()))?)
        } else {
            Ok(payload
                .get("result")
                .cloned()
                .ok_or_else(|| BridgeError::invalid("api.result requires result or error"))?)
        };
        let batch = self.complete_host_call(call_id, result)?;
        let accepted = !batch.messages.is_empty();
        let mut messages = vec![self.response(request, json!({"ok":true,"accepted":accepted}))];
        messages.extend(batch.messages);
        Ok(messages)
    }

    /// Load a batch of module sources supplied by a host.  The manifest owns
    /// the module ID, format, and expected digest; bridge payloads can only
    /// provide bytes for an already declared module.  This prevents a host or
    /// untrusted package from injecting an undeclared script into a session.
    fn handle_module_load(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        self.prepare_engine_environment()?;
        let modules = request.payload.get("modules").unwrap_or(&request.payload);
        self.load_modules_value(modules)?;
        let loaded = module_value_len(modules);
        let mut messages = vec![
            self.response(
                request,
                json!({
                    "ok": true,
                    "loaded": loaded,
                    "totalLoaded": self.loaded_modules.len(),
                }),
            ),
            self.diagnostic(
                request,
                "debug",
                "module batch loaded",
                json!({"loaded": loaded}),
            ),
        ];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    /// Call one exported CommonJS function.  Arguments and return values are
    /// always JSON batches at the Rust boundary, matching the core engine
    /// contract and avoiding per-value FFI calls.
    fn handle_module_call(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        // Refresh permission-scoped synchronous provider snapshots before a
        // module call.  This keeps readFileSync/accessSync coherent with
        // writes committed by the previous bridge turn while preserving the
        // single batched engine boundary.
        self.prepare_engine_environment()?;
        let payload = object_payload(&request.payload)?;
        let module_value = payload
            .get("moduleId")
            .or_else(|| payload.get("module_id"))
            .or_else(|| payload.get("id"))
            .ok_or_else(|| BridgeError::invalid("module.call requires moduleId"))?;
        let (manifest_id, module_id) = self.resolve_module_id(module_value)?;
        let export = payload
            .get("export")
            .or_else(|| payload.get("name"))
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("module.call requires export"))?;
        let args: ValueBatch = match payload.get("args") {
            None => Vec::new(),
            Some(value) => serde_json::from_value(value.clone()).map_err(|e| {
                BridgeError::invalid(format!("module.call args must be an array: {e}"))
            })?,
        };
        let result = self.call_engine(
            CallTarget::Module {
                id: module_id,
                export: export.to_string(),
            },
            args,
        )?;
        let module_format = self
            .loaded_modules
            .get(&manifest_id)
            .map(|module| module.format);
        let mut messages = vec![self.response(
            request,
            json!({
                "ok": true,
                "moduleId": manifest_id,
                "providerModuleId": module_id.0,
                "format": module_format,
                "export": export,
                "result": result,
            }),
        )];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn append_engine_effects(
        &mut self,
        messages: &mut Vec<BridgeEnvelope>,
    ) -> Result<(), BridgeError> {
        let source = match self.config.engine {
            EngineKind::Quickjs => "quickjs",
            EngineKind::V8 => "v8",
        };
        let mut all_effects = Vec::new();
        let mut errors = Vec::new();
        // A host result may resume a Promise which queues another API call.
        // Drain the continuation to quiescence rather than silently leaving
        // valid navigation chains pending after an arbitrary four batches.
        // On budget exhaustion the next batch remains in the engine queue.
        // Report a timeout event after the consumed trace: the synchronous
        // host call has completed, but its continuation is not quiescent.
        // Returning Err here would discard callers' local trace buffers and
        // make dispatch's exception cleanup drain a second budget.
        let mut quiescent = false;
        let mut stop = None;
        for _ in 0..1024 {
            if let Err(error) = self.ensure_engine_execution_healthy() {
                stop = Some(error);
                break;
            }
            if self.view_deadline_ns.get().is_some_and(deadline_expired) {
                stop = Some(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "engine effect continuation deadline has expired",
                ));
                break;
            }
            self.drain_browser_query_completions()?;
            self.ensure_engine_environment_current()?;
            if let Err(error) = self.reconcile_finite_notification_cancellations() {
                // Preserve accepted storage intent when cancellation settlement
                // fails through a guest-modified resolver/continuation.
                stop = Some(self.reconcile_engine_storage().err().unwrap_or(error));
                break;
            }
            self.reconcile_observer_queries()?;
            self.drain_private_selector_queries()?;
            let effects = match self.config.engine {
                EngineKind::Quickjs => {
                    #[cfg(feature = "quickjs-native")]
                    {
                        let engine = self.quickjs_engine.as_mut().ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS native provider is unavailable",
                            )
                        })?;
                        engine.drain_host_events().map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                    }
                    #[cfg(not(feature = "quickjs-native"))]
                    {
                        return Ok(());
                    }
                }
                EngineKind::V8 => {
                    #[cfg(feature = "v8-native")]
                    {
                        let engine = self.v8_engine.as_mut().ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "V8 native provider is unavailable",
                            )
                        })?;
                        engine.drain_host_events().map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })
                    }
                    #[cfg(not(feature = "v8-native"))]
                    {
                        return Ok(());
                    }
                }
            };
            // Public conversion can run guest toJSON, including off(). Retire
            // private native resources before handling either conversion result.
            if let Err(error) = self.reconcile_finite_notification_cancellations() {
                stop = Some(self.reconcile_engine_storage().err().unwrap_or(error));
                break;
            }
            let effects = match effects {
                Ok(effects) => effects,
                Err(error) => {
                    // A failed public toJSON must not strand successful sync
                    // writes or let a later host write overtake them.
                    if let Err(storage_error) = self.reconcile_engine_storage() {
                        stop = Some(storage_error);
                        break;
                    }
                    stop = Some(error);
                    break;
                }
            };
            for effect in &effects {
                if self.consume_animation_write_effects(effect)? {
                    self.view.invalidate_template();
                }
            }
            if let Err(error) = self.commit_engine_storage(&effects) {
                all_effects.extend(effects);
                stop = Some(error);
                break;
            }
            // The ordinary drain runs guest jobs. Capture requests produced by
            // those jobs before deciding that this continuation is quiescent.
            let private_queries = self.drain_private_selector_queries()?;
            let has_effects = effects.iter().any(|value| {
                value.as_object().is_some_and(|object| {
                    object
                        .get("__storageTransactions")
                        .and_then(Value::as_array)
                        .is_some_and(|records| !records.is_empty())
                        || object
                            .get("__componentMutations")
                            .and_then(Value::as_object)
                            .is_some_and(|records| !records.is_empty())
                        || object.get("console").is_some_and(|console| {
                            console
                                .get("entries")
                                .and_then(Value::as_array)
                                .is_some_and(|items| !items.is_empty())
                                || console.get("dropped").and_then(Value::as_u64).unwrap_or(0) > 0
                        })
                        || object
                            .get("events")
                            .and_then(Value::as_array)
                            .is_some_and(|events| !events.is_empty())
                        || object
                            .get("errors")
                            .and_then(Value::as_array)
                            .is_some_and(|values| !values.is_empty())
                })
            });
            if !has_effects {
                // A private completion may have queued more private queries or
                // guest effects after the public batch was captured. Consume a
                // fresh bounded turn before declaring this task quiescent.
                if private_queries {
                    continue;
                }
                // Consume pending writes before measuring a presented frame.
                // One completion may queue fresh setData/API effects; take a
                // new ordinary drain turn before considering another query.
                if self.drain_native_query_completions()? {
                    continue;
                }
                // Canvas consumes the retained declaration only after all
                // earlier public writes and query callbacks have quiesced.
                // One completion may synchronously setData or enqueue work;
                // return to the public drain before another owned draw.
                if self.drain_private_owned_canvases()? {
                    continue;
                }
                quiescent = true;
                break;
            }
            errors.extend(
                effects
                    .iter()
                    .filter_map(Value::as_object)
                    .filter_map(|object| object.get("errors"))
                    .filter_map(Value::as_array)
                    .flat_map(|values| values.iter().cloned()),
            );
            let applied = self.apply_engine_effects(&effects);
            all_effects.extend(effects);
            if let Err(error) = applied {
                stop = Some(error);
                break;
            }
            self.append_scroll_notifications(messages);
        }
        if !quiescent && stop.is_none() {
            stop = Some(BridgeError::new(
                BridgeErrorCode::Timeout,
                "engine effect continuation reached 1024 batches; queued work is retained until the next host turn",
            ));
        }
        self.append_host_completions(messages);
        if !all_effects.is_empty() {
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::EVENT_BATCH,
                json!({"source": source, "effects": all_effects}),
            ));
        }
        // Log-only turns and failed public toJSON still reach the real native /
        // Web diagnostic consumer. Each journal drain includes the escaped wire
        // byte budget, and preserves an unconsumed tail for the next host turn.
        let logs = self.log_manager.take();
        if !logs.records.is_empty() || logs.dropped > 0 || logs.faulted {
            let entries: Vec<Value> = logs.records.into_iter().map(|record| {
                json!({"level": record["level"], "message": record.to_string(), "source": "logManager"})
            }).collect();
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(), op::EVENT_BATCH,
                json!({"source": source, "effects": [{"console": {"entries": entries, "dropped": logs.dropped, "faulted": logs.faulted, "source": "logManager"}}]}),
            ));
        }
        if !errors.is_empty() {
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::ERROR,
                json!({"source": source, "errors": errors}),
            ));
        }
        if let Some(error) = stop {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        Ok(())
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    fn append_engine_effects(
        &mut self,
        messages: &mut Vec<BridgeEnvelope>,
    ) -> Result<(), BridgeError> {
        let _ = messages;
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn apply_engine_effects(&mut self, effects: &[Value]) -> Result<(), BridgeError> {
        // RequestTask.abort() can be issued in the same engine turn as the
        // queued api.call. Apply cancellations first so a provider observes
        // the token before dispatch; otherwise an in-flight deterministic
        // request could succeed merely because the effect list happened to
        // contain api.call before api.cancel.
        for envelope in effects {
            let Some(object) = envelope.as_object() else {
                continue;
            };
            if let Some(events) = object.get("events").and_then(Value::as_array) {
                for event in events {
                    let Some(event_object) = event.as_object() else {
                        continue;
                    };
                    if event_object.get("type").and_then(Value::as_str) != Some("api.cancel") {
                        continue;
                    }
                    if let Some(token) = event_object.get("cancelToken").and_then(Value::as_str) {
                        self.cancel_request_token(token)?;
                    }
                }
            }
        }
        for envelope in effects {
            let Some(object) = envelope.as_object() else {
                continue;
            };
            // This member is overwritten from the retained native transport
            // after public JSON conversion, before effect consumption commits.
            let mut component_mutation_scopes = BTreeSet::new();
            if let Some(records) = object
                .get("__componentMutations")
                .and_then(Value::as_object)
            {
                for record in records.values().filter_map(Value::as_object) {
                    let Some(scope) = record.get("scopeId").and_then(Value::as_str) else {
                        continue;
                    };
                    component_mutation_scopes.insert(scope);
                    if !self.component_mutation_was_consumed(scope, record) {
                        self.invalidate_component_scope(scope);
                    }
                }
            }
            if let Some(events) = object.get("events").and_then(Value::as_array) {
                for event in events {
                    let Some(event_object) = event.as_object() else {
                        continue;
                    };
                    match event_object.get("type").and_then(Value::as_str) {
                        Some("component.property.patch") => {
                            if let Some(scope) = event_object.get("scopeId").and_then(Value::as_str)
                            {
                                // Public effects remain trace data. Only native
                                // private ledger records can suppress duplicate
                                // dirty; malformed/forged public events stay dirty.
                                if !component_mutation_scopes.contains(scope) {
                                    self.invalidate_component_scope(scope);
                                }
                            }
                        }
                        Some("data.patch.batch") => {
                            let Some(patches_value) = event_object.get("patches") else {
                                continue;
                            };
                            let patches: Vec<DataPatch> =
                                serde_json::from_value(patches_value.clone()).map_err(|error| {
                                    BridgeError::invalid(format!(
                                        "native engine setData produced invalid patches: {error}"
                                    ))
                                })?;
                            let page_id = event_object
                                .get("pageId")
                                .and_then(Value::as_u64)
                                .map(PageId)
                                .or_else(|| {
                                    event_object
                                        .get("pageIndex")
                                        .and_then(Value::as_u64)
                                        .and_then(|index| {
                                            self.page_id_for_registration(index as usize)
                                        })
                                })
                                .or_else(|| self.app_service.pages().current().map(|page| page.id));
                            if let Some(page_id) = page_id {
                                // A callback can queue `setData` and then
                                // unload its page in the same bridge turn.
                                // We preserve the callback ordering but drop
                                // the stale patch once the page no longer
                                // belongs to the stack, matching the host
                                // runtime's disposed-page behavior.
                                if self.app_service.pages().get(page_id).is_some() {
                                    self.app_service
                                        .apply_data_patch_batch(&DataPatchBatch {
                                            page_id,
                                            patches: patches.clone(),
                                        })
                                        .map_err(|error| {
                                            runtime_error(error, BridgeErrorCode::InvalidRequest)
                                        })?;
                                    self.view.record_patches(&patches);
                                }
                            }
                        }
                        // Storage public events are trace data. Only native
                        // captured intent may mutate core state (precommitted
                        // before this fallible public event pass).
                        Some("storage.patch.batch") => {}
                        Some("navigation") => {
                            if let Some(name) = event_object.get("op").and_then(Value::as_str) {
                                let options = event_object
                                    .get("options")
                                    .cloned()
                                    .unwrap_or_else(|| json!({}));
                                self.apply_navigation_effect(name, &options)?;
                            }
                        }
                        Some("api.call") => {
                            self.apply_api_effect(event_object)?;
                        }
                        // Cancellation was applied in the pre-pass above;
                        // retaining the event in the batch keeps host traces
                        // auditable without dispatching it as an API call.
                        Some("api.cancel") => {}
                        Some("host.unsubscribe") => {
                            if let Some(id) =
                                event_object.get("subscriptionId").and_then(Value::as_str)
                            {
                                self.cancel_native_subscription(id)?;
                            }
                        }
                        Some("host.message") => self.queue_host_message(
                            event_object.get("payload").cloned().unwrap_or(Value::Null),
                        )?,
                        Some("api.sync") => {
                            let name = event_object
                                .get("name")
                                .and_then(Value::as_str)
                                .ok_or_else(|| {
                                    BridgeError::invalid(
                                        "native engine synchronous API call is missing name",
                                    )
                                })?;
                            let options = event_object
                                .get("options")
                                .and_then(Value::as_object)
                                .cloned()
                                .unwrap_or_default();
                            self.provider
                                .call(
                                    name,
                                    &options,
                                    &ProviderContext {
                                        session_id: self.config.session_id.clone(),
                                        host: self.config.host.clone(),
                                        now_ns: unix_now_ns(),
                                        deadline_ns: None,
                                        cancel_token: None,
                                        cancelled: false,
                                    },
                                )
                                .map_err(provider_bridge_error)?;
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn apply_api_effect(&mut self, event: &Map<String, Value>) -> Result<(), BridgeError> {
        let id = event
            .get("id")
            .and_then(Value::as_u64)
            .ok_or_else(|| BridgeError::invalid("native engine API call is missing id"))?;
        let name = event
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| BridgeError::invalid("native engine API call is missing name"))?;
        let options = event
            .get("options")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if id >= private_selector::FIRST_PRIVATE_ID {
            return Err(BridgeError::invalid(
                "public API request cannot use a private selector identity",
            ));
        }
        if name == random_values::API {
            let result = self.random_values_api_result(&options, None, None);
            return self.resolve_engine_api(id, name, result);
        }
        if self.host_service_registered(name) {
            if self.effective_capability(name) == CapabilitySupport::Unsupported {
                return self.resolve_engine_api(
                    id,
                    name,
                    Err(BridgeError::new(
                        BridgeErrorCode::UnsupportedCapability,
                        format!("{name} is unsupported on this session"),
                    )),
                );
            }
            if host_api_descriptor(name).is_some_and(|descriptor| descriptor.kind == "syncSnapshot")
            {
                let context = self.provider_context(&options, 60_000)?;
                let result = self
                    .provider
                    .call(name, &options, &context)
                    .map_err(provider_bridge_error);
                return self.resolve_engine_api(id, name, result);
            }
            let result = self
                .validate_host_service_call(name, &options)
                .and_then(|()| {
                    if self.effective_capability(name) == CapabilitySupport::Unsupported {
                        return Err(BridgeError::new(
                            BridgeErrorCode::UnsupportedCapability,
                            format!("{name} is unsupported on this session"),
                        ));
                    }
                    let context = self.provider_context(&options, 60_000)?;
                    self.queue_host_call(
                        name,
                        Value::Object(options.clone()),
                        context,
                        async_host::CallTargetKind::Engine {
                            id,
                            name: name.to_owned(),
                        },
                    )
                });
            return match result {
                Ok(_) => Ok(()),
                Err(error) => self.resolve_engine_api(id, name, Err(error)),
            };
        }
        if name == "weappContainer.invoke" {
            let method = options.get("method").and_then(Value::as_str).unwrap_or("");
            let result = if !self.has_host_method(method) {
                Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    format!("host method {method} is not registered"),
                ))
            } else {
                self.provider_context(&options, 30_000).and_then(|context| {
                    self.queue_host_call(
                        method,
                        options.get("payload").cloned().unwrap_or(Value::Null),
                        context,
                        async_host::CallTargetKind::Engine {
                            id,
                            name: name.to_owned(),
                        },
                    )
                })
            };
            return match result {
                Ok(_) => Ok(()),
                Err(error) => self.resolve_engine_api(id, name, Err(error)),
            };
        }
        if self.navigation_layout.enabled && navigation_layout::is_structural_navigation(name) {
            let request = navigation_layout::engine_navigation_request(
                &self.config.session_id,
                name,
                &options,
            )?;
            return match self.enqueue_navigation(
                request,
                name,
                options,
                navigation_layout::NavigationCompletion::Engine {
                    id,
                    name: name.to_owned(),
                },
            ) {
                Ok(()) => Ok(()),
                Err(error) => self.resolve_engine_api(id, name, Err(error)),
            };
        }
        let (value, error) = if name == "wx.pageScrollTo" {
            let deadline = options
                .get("deadlineNs")
                .or_else(|| options.get("deadline_ns"))
                .and_then(Value::as_u64);
            let cancel = options
                .get("cancelToken")
                .or_else(|| options.get("cancel_token"))
                .and_then(Value::as_str);
            match self.page_scroll_to(&options, deadline, cancel) {
                Ok(value) => (value, Value::Null),
                Err(error) => (
                    Value::Null,
                    json!({"code":error.code,"errMsg":format!("pageScrollTo:fail {}",error.message),"message":error.message,"retryable":error.retryable}),
                ),
            }
        } else if is_navigation_api(name) {
            match self.navigation_effect_result_with_request(
                name,
                &Value::Object(options.clone()),
                Some(id),
            ) {
                Ok(result) => (json!({"errMsg": result["errMsg"]}), Value::Null),
                Err(error) => (
                    Value::Null,
                    json!({
                        "code": error.code,
                        "errMsg": format!("{}:fail {}", name.trim_start_matches("wx."), error.message),
                        "message": error.message,
                        "retryable": error.retryable,
                        "api": name,
                    }),
                ),
            }
        } else if tab_bar::is_api(name) {
            let deadline = options
                .get("deadlineNs")
                .or_else(|| options.get("deadline_ns"))
                .and_then(Value::as_u64);
            let cancel = options
                .get("cancelToken")
                .or_else(|| options.get("cancel_token"))
                .and_then(Value::as_str);
            let result = self.tab_bar_api_result(name, &options, deadline, cancel);
            return self.resolve_engine_api(id, name, result);
        } else if is_observer_api(name) {
            match self.observer_effect_result(name, &options) {
                Ok(value) => (value, Value::Null),
                Err(error) => (
                    Value::Null,
                    json!({"code":error.code,"message":error.message,"errMsg":format!("{name}:fail {}",error.message),"retryable":error.retryable}),
                ),
            }
        } else if name == "wx.createSelectorQuery" {
            if self.browser_route_active() {
                match self.enqueue_browser_query(id, event.get("owner"), &options) {
                    Ok(()) => return Ok(()),
                    Err(error) => {
                        self.resolve_browser_query_api(id, Err(error))?;
                        return Ok(());
                    }
                }
            }
            return self.dispatch_native_query(id, event.get("owner"), &options);
        } else {
            let result = if matches!(name, "wx.getLaunchOptionsSync" | "wx.getEnterOptionsSync") {
                Ok(self.launch_options.clone())
            } else {
                let context = match self.provider_context(&options, 60_000) {
                    Ok(context) => context,
                    Err(error) => return self.resolve_engine_api(id, name, Err(error)),
                };
                if context.cancelled {
                    return self.resolve_engine_api(
                        id,
                        name,
                        Err(BridgeError::new(
                            BridgeErrorCode::Cancelled,
                            "host call cancelled",
                        )),
                    );
                }
                let started = if name == "wx.canvas.draw" {
                    // Canvas commits are runtime-owned synchronous transactions;
                    // a transport completion must not skip the renderer commit.
                    ProviderStart::Ready(self.provider.call(name, &options, &context))
                } else {
                    self.provider.start_call(name, &options, &context)
                };
                match started {
                    ProviderStart::Ready(result) => result,
                    ProviderStart::Pending => {
                        let queued = self.queue_host_call(
                            name,
                            Value::Object(options.clone()),
                            context,
                            async_host::CallTargetKind::Engine {
                                id,
                                name: name.to_owned(),
                            },
                        );
                        return match queued {
                            Ok(_) => Ok(()),
                            Err(error) => self.resolve_engine_api(id, name, Err(error)),
                        };
                    }
                }
            };
            match result {
                Ok(mut value) => {
                    if name == "wx.canvas.draw" {
                        match self.commit_canvas_draw(&options) {
                            Ok(surface) => {
                                if let Some(object) = value.as_object_mut() {
                                    object.insert("surface".into(), surface);
                                }
                                (value, Value::Null)
                            }
                            Err(error) => (
                                Value::Null,
                                json!({
                                    "code": error.code,
                                    "errMsg": format!("{name}:fail {error}"),
                                    "message": error.to_string(),
                                    "retryable": false,
                                }),
                            ),
                        }
                    } else {
                        (value, Value::Null)
                    }
                }
                Err(error) => {
                    let bridge = provider_bridge_error(error);
                    (
                        Value::Null,
                        json!({
                            "code": bridge.code,
                            "errMsg": format!("{name}:fail {}", bridge.message),
                            "message": bridge.message,
                            "retryable": bridge.retryable,
                        }),
                    )
                }
            }
        };
        self.call_engine(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![json!(id), value, error],
        )?;
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn apply_navigation_effect(&mut self, name: &str, options: &Value) -> Result<(), BridgeError> {
        self.navigation_effect_result(name, options).map(|_| ())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn navigation_effect_result(
        &mut self,
        name: &str,
        options: &Value,
    ) -> Result<Value, BridgeError> {
        self.navigation_effect_result_with_request(name, options, None)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn navigation_effect_result_with_request(
        &mut self,
        name: &str,
        options: &Value,
        engine_request_id: Option<u64>,
    ) -> Result<Value, BridgeError> {
        let payload = object_payload(options)?;
        let mut request = BridgeEnvelope::request(
            self.config.session_id.clone(),
            "engine-navigation",
            op::API_CALL,
            options.clone(),
        );
        if let Some(value) = payload
            .get("deadlineNs")
            .or_else(|| payload.get("deadline_ns"))
        {
            request.deadline_ns = Some(value.as_u64().ok_or_else(|| {
                BridgeError::invalid("navigation deadlineNs must be an unsigned integer")
            })?);
        }
        if let Some(value) = payload
            .get("cancelToken")
            .or_else(|| payload.get("cancel_token"))
        {
            request.cancel_token = Some(
                value
                    .as_str()
                    .ok_or_else(|| BridgeError::invalid("navigation cancelToken must be a string"))?
                    .to_owned(),
            );
        }
        request.validate()?;
        self.navigation_result(&request, name, payload, engine_request_id)
    }

    /// Parse the wire representation accepted by `app.init` and
    /// `module.load`.  A source is normally UTF-8 text; an optional `bytes`
    /// array keeps the operation usable for binary-safe FFI serializers.
    fn load_modules_value(&mut self, value: &Value) -> Result<(), BridgeError> {
        let values = match value {
            Value::Array(values) => values,
            Value::Object(object) => object
                .get("modules")
                .and_then(Value::as_array)
                .ok_or_else(|| BridgeError::invalid("module.load requires modules array"))?,
            _ => return Err(BridgeError::invalid("module.load requires modules array")),
        };
        if values.is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                "module.load requires at least one module",
            ));
        }

        // Validate every declaration before invoking the provider.  This
        // makes malformed batches deterministic and avoids loading a module
        // that follows an unknown ID or digest mismatch.
        let mut pending = Vec::with_capacity(values.len());
        for value in values {
            let object = object_payload(value)?;
            let id = object
                .get("id")
                .or_else(|| object.get("moduleId"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    BridgeError::new(BridgeErrorCode::ModuleLoad, "module id is required")
                })?;
            let declaration = self
                .manifest
                .modules
                .iter()
                .find(|module| module.id == id)
                .ok_or_else(|| {
                    BridgeError::new(
                        BridgeErrorCode::ModuleLoad,
                        format!("module {id} is not declared in the manifest"),
                    )
                })?;
            let bytes = if let Some(source) = object.get("source").and_then(Value::as_str) {
                source.as_bytes().to_vec()
            } else if let Some(bytes) = object.get("bytes") {
                serde_json::from_value::<Vec<u8>>(bytes.clone()).map_err(|e| {
                    BridgeError::new(
                        BridgeErrorCode::ModuleLoad,
                        format!("module {id} bytes are invalid: {e}"),
                    )
                })?
            } else {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {id} requires source or bytes"),
                ));
            };
            let digest = container_ir::hex_digest(&bytes);
            if digest != declaration.sha256 {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!(
                        "module {id} SHA-256 mismatch: expected {}, got {digest}",
                        declaration.sha256
                    ),
                ));
            }
            pending.push((
                id.to_string(),
                declaration.format,
                declaration.sha256.clone(),
                bytes,
            ));
        }

        // Validate the graph before registering factories. CommonJS cycles
        // are evaluated by the shared JS cache; cycles containing ESM remain
        // explicitly unsupported by the current static ESM adapter.
        let mut pending_by_id = BTreeMap::new();
        for (id, format, sha256, bytes) in pending {
            if pending_by_id.contains_key(&id) {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {id} is declared more than once in the load batch"),
                ));
            }
            pending_by_id.insert(id, (format, sha256, bytes));
        }
        let load_order = self.module_load_order(&pending_by_id)?;

        let dependency_ids = self
            .manifest
            .modules
            .iter()
            .flat_map(|module| module.dependencies.iter().cloned())
            .collect::<BTreeSet<_>>();
        let entry_id = module_reference_id(&self.manifest.app.entry_module);
        let route_ids = self
            .manifest
            .routes
            .iter()
            .map(|route| module_reference_id(&route.entry_module))
            .collect::<BTreeSet<_>>();
        let component_modules = self.managed_module_ids();
        let mut roots = load_order
            .iter()
            .filter(|id| {
                **id == entry_id
                    || route_ids.contains(*id)
                    || component_modules.contains(*id)
                    || !dependency_ids.contains(*id)
            })
            .cloned()
            .collect::<Vec<_>>();

        // Translate and syntax-check every factory before registration, so a
        // malformed later declaration cannot execute a partial application.
        for id in &load_order {
            if let Some(existing) = self.loaded_modules.get(id) {
                if existing.sha256 != pending_by_id[id].1 {
                    return Err(BridgeError::new(
                        BridgeErrorCode::ModuleLoad,
                        format!("module {id} was already loaded with a different digest"),
                    ));
                }
            }
        }
        let mut prepared = Vec::new();
        let mut json_sources = Vec::new();
        for id in load_order {
            let (format, sha256, bytes) = pending_by_id
                .remove(&id)
                .expect("module load order must reference pending modules");
            if self.loaded_modules.contains_key(&id) {
                continue;
            }
            let source = match format {
                ModuleFormat::Json => {
                    let json = std::str::from_utf8(&bytes).map_err(|e| {
                        BridgeError::new(BridgeErrorCode::ModuleLoad, e.to_string())
                    })?;
                    json_sources.push(json.to_owned());
                    format!(
                        "module.exports = JSON.parse({});",
                        serde_json::to_string(json).map_err(|e| BridgeError::new(
                            BridgeErrorCode::ModuleLoad,
                            e.to_string()
                        ))?
                    )
                    .into_bytes()
                }
                ModuleFormat::Esm => self.transpile_esm_module(&bytes, &id)?,
                ModuleFormat::Commonjs => bytes,
            };
            let source = String::from_utf8(source).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {id} is not UTF-8: {error}"),
                )
            })?;
            prepared.push((id, format, sha256, source));
        }
        if !prepared.is_empty() {
            self.call_engine_with_error_code(
                CallTarget::Global {
                    name: "__container_validate_module_sources".into(),
                },
                vec![
                    json!(prepared
                        .iter()
                        .map(|(_, _, _, source)| source)
                        .collect::<Vec<_>>()),
                    json!(json_sources),
                ],
                BridgeErrorCode::ModuleLoad,
            )?;
        }
        if !route_ids.is_empty() {
            let mut route_counts = BTreeMap::<String, usize>::new();
            for route in &self.manifest.routes {
                *route_counts
                    .entry(module_reference_id(&route.entry_module))
                    .or_default() += 1;
            }
            self.call_engine(
                CallTarget::Global {
                    name: "__container_configure_page_modules".into(),
                },
                vec![json!(route_ids), json!(route_counts)],
            )?;
        }
        if !component_modules.is_empty() {
            self.call_engine(
                CallTarget::Global {
                    name: "__container_configure_component_modules".into(),
                },
                vec![json!(component_modules)],
            )?;
        }
        if !self.initialized {
            // Source/graph validation above is side-effect free. From the
            // first factory registration onward, even an interrupted native
            // install must retain every eager-root startup obligation.
            self.pending_initialization_roots
                .extend(roots.iter().cloned());
        }
        for (id, format, sha256, source) in prepared {
            let declaration = self
                .manifest
                .modules
                .iter()
                .find(|module| module.id == id)
                .expect("load order references a declared module");
            let dependencies = declaration.dependencies.clone();
            let module_id = self.register_engine_module(
                &id,
                source.as_bytes(),
                &dependencies,
                format == ModuleFormat::Esm,
            )?;
            self.loaded_modules.insert(
                id,
                LoadedModule {
                    module_id,
                    sha256,
                    format,
                    evaluated: false,
                },
            );
        }
        // App/page/component roots and unreferenced legacy batch roots are
        // eager. A sorted dependency inventory is not the page registration
        // order: explicit page roots follow app.json/manifest route order.
        // A real require may still evaluate a dependency earlier, and the
        // module cache keeps that registration from running twice.
        let mut route_order = BTreeMap::new();
        for (index, route) in self.manifest.routes.iter().enumerate() {
            route_order
                .entry(module_reference_id(&route.entry_module))
                .or_insert(index);
        }
        if !self.initialized {
            roots.extend(self.pending_initialization_roots.iter().cloned());
        }
        let mut unique_roots = BTreeSet::new();
        roots.retain(|id| unique_roots.insert(id.clone()));
        roots.sort_by_key(|id| {
            (
                id != &entry_id,
                route_order.get(id).copied().unwrap_or(usize::MAX),
            )
        });
        for id in roots {
            self.evaluate_engine_module(&id)?;
            self.pending_initialization_roots.remove(&id);
        }
        self.resolve_loaded_page_modules()
    }

    fn resolve_loaded_page_modules(&mut self) -> Result<(), BridgeError> {
        if !self.manifest.routes.is_empty() {
            let registrations = self
                .call_engine(
                    CallTarget::Global {
                        name: "__container_page_module_registrations".into(),
                    },
                    Vec::new(),
                )?
                .into_iter()
                .next()
                .unwrap_or(Value::Null);
            let mut routes_by_module = BTreeMap::<String, Vec<_>>::new();
            for route in &self.manifest.routes {
                routes_by_module
                    .entry(module_reference_id(&route.entry_module))
                    .or_default()
                    .push(route);
            }
            let mut resolved = BTreeMap::new();
            for (module_id, routes) in routes_by_module {
                if !self.loaded_modules.contains_key(&module_id) {
                    continue;
                }
                // Historical packs may bundle several routes in one module.
                // A sole Page definition is reusable; otherwise declarations
                // pair with that module's routes in stable manifest order.
                let definitions = registrations
                    .get(&module_id)
                    .and_then(Value::as_array)
                    .filter(|values| values.len() == 1 || values.len() == routes.len())
                    .and_then(|values| values.iter().map(Value::as_u64).collect::<Option<Vec<_>>>())
                    .ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::ModuleLoad,
                            format!(
                                "page module {module_id} must register one Page definition or exactly {} route definitions",
                                routes.len()
                            ),
                        )
                    })?;
                for (offset, route) in routes.into_iter().enumerate() {
                    let index = definitions[if definitions.len() == 1 { 0 } else { offset }];
                    resolved.insert(route.path.clone(), index as usize);
                }
            }
            self.page_module_indices.extend(resolved);
        }
        Ok(())
    }

    fn module_load_order(
        &self,
        pending: &BTreeMap<String, (ModuleFormat, String, Vec<u8>)>,
    ) -> Result<Vec<String>, BridgeError> {
        let mut state = BTreeMap::new();
        let mut order = Vec::with_capacity(pending.len());
        let mut visiting = Vec::new();
        for id in pending.keys() {
            visit_module_load_order(
                id,
                pending,
                &self.loaded_modules,
                &self.manifest,
                &mut state,
                &mut order,
                &mut visiting,
            )?;
        }
        Ok(order)
    }

    fn transpile_esm_module(&self, bytes: &[u8], module_id: &str) -> Result<Vec<u8>, BridgeError> {
        transpile_esm_to_commonjs(bytes, module_id, |specifier| {
            let target = resolve_manifest_module_id(module_id, specifier, &self.manifest)?;
            let declaration = self
                .manifest
                .modules
                .iter()
                .find(|module| module.id == module_id)
                .ok_or_else(|| {
                    BridgeError::new(
                        BridgeErrorCode::ModuleLoad,
                        format!("module {module_id} is not declared in the manifest"),
                    )
                })?;
            if !declaration
                .dependencies
                .iter()
                .any(|dependency| dependency == &target)
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!(
                        "module {module_id} dependency {target} is missing from the manifest graph"
                    ),
                ));
            }
            Ok(target)
        })
    }

    fn resolve_module_id(&self, value: &Value) -> Result<(String, ModuleId), BridgeError> {
        if let Some(id) = value.as_str() {
            let loaded = self.loaded_modules.get(id).ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {id} is not loaded"),
                )
            })?;
            return Ok((id.to_string(), loaded.module_id));
        }
        let provider_id = value.as_u64().ok_or_else(|| {
            BridgeError::invalid("moduleId must be a manifest module ID or provider module number")
        })?;
        let (manifest_id, loaded) = self
            .loaded_modules
            .iter()
            .find(|(_, module)| module.module_id.0 == provider_id)
            .ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("provider module {provider_id} is not loaded"),
                )
            })?;
        Ok((manifest_id.clone(), loaded.module_id))
    }

    fn register_engine_module(
        &mut self,
        id: &str,
        source: &[u8],
        dependencies: &[String],
        esm: bool,
    ) -> Result<ModuleId, BridgeError> {
        self.ensure_engine_environment_current()?;
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    let engine = self.quickjs_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            "QuickJS native provider is unavailable",
                        )
                    })?;
                    engine
                        .register_module_with_id(id, source, dependencies, esm)
                        .map_err(|error| engine_bridge_error(error, BridgeErrorCode::ModuleLoad))
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = (id, source, dependencies, esm);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "QuickJS native provider is unavailable in this build",
                    ))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    let engine = self.v8_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            "V8 native provider is unavailable",
                        )
                    })?;
                    engine
                        .register_module_with_id(id, source, dependencies, esm)
                        .map_err(|error| engine_bridge_error(error, BridgeErrorCode::ModuleLoad))
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = (id, source, dependencies, esm);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "V8 native provider is unavailable in this build",
                    ))
                }
            }
        }
    }

    fn evaluate_engine_module(&mut self, id: &str) -> Result<(), BridgeError> {
        self.run_engine_task(EngineTask::EvaluateModule(id), BridgeErrorCode::ModuleLoad)
            .map(|_| {
                if let Some(module) = self.loaded_modules.get_mut(id) {
                    module.evaluated = true;
                }
            })
    }

    /// Explicit test-distribution control. All guest work uses the normal
    /// checkpoint, execution deadline and effect pipeline.
    #[cfg(feature = "testing")]
    pub fn testing_control(&mut self, input: Value) -> Result<(Value, BridgeBatch), BridgeError> {
        let mut output = Value::Null;
        let batch = self.with_engine_batch_turn(None, |session| {
            let values = session
                .run_engine_task(EngineTask::Testing(input.clone()), BridgeErrorCode::Engine)?;
            if input["action"] == "clock" {
                session.testing_time_ms = input["now"].as_u64();
            }
            let mut messages = Vec::new();
            session.append_engine_effects(&mut messages)?;
            output = values.into_iter().next().unwrap_or(Value::Null);
            Ok(BridgeBatch::new(messages))
        })?;
        Ok((output, batch))
    }

    fn timer_now_ns(&self) -> u64 {
        #[cfg(feature = "testing")]
        if let Some(now) = self.testing_time_ms {
            return now.saturating_mul(1_000_000);
        }
        unix_now_ns()
    }

    fn call_engine(
        &mut self,
        target: CallTarget,
        args: ValueBatch,
    ) -> Result<ValueBatch, BridgeError> {
        self.call_engine_with_error_code(target, args, BridgeErrorCode::Engine)
    }

    /// Classify failures from an actual native JS operation in its calling
    /// context, while preserving ERR_ENGINE when no provider exists. Mapping
    /// a completed BridgeError would conflate unavailable engines with bad
    /// module syntax or evaluation failures.
    fn call_engine_with_error_code(
        &mut self,
        target: CallTarget,
        args: ValueBatch,
        default_code: BridgeErrorCode,
    ) -> Result<ValueBatch, BridgeError> {
        self.run_engine_task(EngineTask::Call { target, args }, default_code)
    }

    /// Calls and retained module evaluation share one task-end checkpoint and
    /// error boundary. An ordinary throw still drains jobs; a faulted provider
    /// must reject cleanup before entering guest code.
    fn run_engine_task(
        &mut self,
        task: EngineTask<'_>,
        default_code: BridgeErrorCode,
    ) -> Result<ValueBatch, BridgeError> {
        self.ensure_engine_environment_current()?;
        let result = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    let engine = self.quickjs_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            "QuickJS native provider is unavailable",
                        )
                    })?;
                    let result = match task {
                        EngineTask::Call { target, args } => {
                            container_core::JsEngine::call(engine, target, args)
                        }
                        #[cfg(feature = "testing")]
                        EngineTask::Testing(input) => {
                            engine.testing_call(input).map(|value| vec![value])
                        }
                        EngineTask::EvaluateModule(id) => {
                            engine.evaluate_module_with_id(id).map(|()| Vec::new())
                        }
                    };
                    // An ordinary throw still ends a JavaScript task. Drain its
                    // queued jobs under this same host deadline, including on
                    // failure; a poisoned realm must never execute cleanup JS.
                    if engine.is_execution_faulted() {
                        return result.map_err(|error| engine_bridge_error(error, default_code));
                    }
                    let checkpoint = container_core::JsEngine::drain_microtasks(engine);
                    complete_engine_task(result, checkpoint)
                        .map_err(|error| engine_bridge_error(error, default_code))
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = (task, default_code);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "QuickJS native provider is unavailable in this build",
                    ))
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    let engine = self.v8_engine.as_mut().ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            "V8 native provider is unavailable",
                        )
                    })?;
                    let result = match task {
                        EngineTask::Call { target, args } => {
                            container_core::JsEngine::call(engine, target, args)
                        }
                        #[cfg(feature = "testing")]
                        EngineTask::Testing(_) => {
                            return Err(BridgeError::new(
                                BridgeErrorCode::UnsupportedCapability,
                                "testing requires QuickJS",
                            ))
                        }
                        EngineTask::EvaluateModule(id) => {
                            engine.evaluate_module_with_id(id).map(|()| Vec::new())
                        }
                    };
                    let checkpoint = container_core::JsEngine::drain_microtasks(engine);
                    complete_engine_task(result, checkpoint)
                        .map_err(|error| engine_bridge_error(error, default_code))
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = (task, default_code);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "V8 native provider is unavailable in this build",
                    ))
                }
            }
        }?;
        Ok(result)
    }

    fn handle_cancel(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        let payload = object_payload(&request.payload)?;
        let token = payload
            .get("cancelToken")
            .or_else(|| payload.get("cancel_token"))
            .and_then(Value::as_str)
            .or(request.cancel_token.as_deref())
            .ok_or_else(|| BridgeError::invalid("cancel requires cancelToken"))?;
        let known = self.cancel_request_token(token)?;
        let mut messages = vec![self.response(
            request,
            json!({"ok": true, "cancelToken": token, "cancelled": true, "known": known}),
        )];
        self.append_host_completions(&mut messages);
        if self.engine_provider_available() && !self.engine_execution_is_faulted() {
            self.append_engine_effects(&mut messages)?;
        }
        Ok(messages)
    }

    /// Both engine RequestTask.abort() effects and bridge cancel messages
    /// must update session gates and notify the provider, even when one of
    /// them already recognizes the token.
    fn cancel_request_token(&mut self, token: &str) -> Result<bool, BridgeError> {
        let known_in_session = self.cancellation.cancel(token);
        let known_in_provider = self.provider.cancel(token);
        self.cancelled.insert(token.to_string(), true);
        let known_pending = self.cancel_host_token(token)?;
        Ok(known_in_session || known_in_provider || known_pending)
    }

    fn handle_diagnostic(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        Ok(vec![
            self.response(request, json!({"ok": true, "accepted": true, "executionFault": self.execution_fault(), "requiresRestart": self.execution_fault().is_some()}))
        ])
    }

    fn handle_error_passthrough(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        Ok(vec![self.response(
            request,
            json!({"ok": true, "accepted": true, "payload": request.payload}),
        )])
    }

    fn effective_capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        // Publish exactly the admission policy, from one provider inventory
        // snapshot. The key sources remain manifest + runtime-owned additions
        // + registered host extensions and their explicit legacy cleanup
        // declarations; a provider does not grant new keys.
        let provider = self.provider.capabilities_for_host(&self.config.host);
        let mut capabilities: BTreeMap<_, _> = self
            .manifest
            .capabilities
            .keys()
            .map(|name| {
                (
                    name.clone(),
                    self.effective_capability_with_provider(name, &provider),
                )
            })
            .collect();
        for name in SYSTEM_TAB_BAR_APIS.into_iter().chain([
            "wx.showTabBar",
            "wx.hideTabBar",
            "wx.setTabBarItem",
        ]) {
            capabilities.insert(
                name.to_owned(),
                self.effective_capability_with_provider(name, &provider),
            );
        }
        for name in route_transaction::APIS {
            capabilities.insert(
                name.to_owned(),
                self.effective_capability_with_provider(name, &provider),
            );
        }
        for name in finite_notifications::OFF_APIS {
            capabilities.insert(
                name.to_owned(),
                self.effective_capability_with_provider(name, &provider),
            );
        }
        for name in self
            .host_services
            .registered
            .iter()
            .chain(self.host_services.compatibility_cleanup_apis.iter())
        {
            capabilities.insert(
                name.clone(),
                self.effective_capability_with_provider(name, &provider),
            );
        }
        capabilities
    }

    // Window listeners consume the already accepted runtime geometry. Keep
    // each public method's own declaration and minimum trusted policy; a host
    // subscription registry or its counterpart cannot grant either method.
    fn window_resize_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !matches!(
            name,
            "wx.onWindowResize"
                | "wx.offWindowResize"
                | "wx.onHostLayoutChange"
                | "wx.offHostLayoutChange"
        ) {
            return None;
        }
        let manifest = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .map_or(manifest, |value| min_support(manifest, value));
        Some(
            provider
                .get(name)
                .copied()
                .map_or(host, |value| min_support(host, value)),
        )
    }

    // Lifecycle listeners share one retained runtime owner. Each public method
    // retains its own declaration and host/provider minimum, independently of
    // its counterpart and generic host subscription descriptors.
    fn lifecycle_notification_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !matches!(
            name,
            "wx.onAppShow"
                | "wx.offAppShow"
                | "wx.onAppHide"
                | "wx.offAppHide"
                | "wx.onBeforePageUnload"
                | "wx.offBeforePageUnload"
                | "wx.onAfterPageUnload"
                | "wx.offAfterPageUnload"
        ) {
            return None;
        }
        let manifest = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .map_or(manifest, |value| min_support(manifest, value));
        Some(
            provider
                .get(name)
                .copied()
                .map_or(host, |value| min_support(host, value)),
        )
    }

    // Public registration and removal have independent admission. Older packs
    // declare registration without removal; owner retirement always clears the hub
    // regardless of either public capability. Registration retains a Partial
    // ceiling for error projection/source and missing-page dispatch gaps.
    // Rejection registration also retains a Partial ceiling until
    // fixed-reference timing is certified.
    fn error_notification_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !matches!(
            name,
            "wx.onError"
                | "wx.offError"
                | "wx.onPageNotFound"
                | "wx.offPageNotFound"
                | "wx.onUnhandledRejection"
                | "wx.offUnhandledRejection"
        ) {
            return None;
        }
        let manifest = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .map_or(manifest, |value| min_support(manifest, value));
        let support = provider
            .get(name)
            .copied()
            .map_or(host, |value| min_support(host, value));
        Some(
            if matches!(
                name,
                "wx.onError" | "wx.onPageNotFound" | "wx.onUnhandledRejection"
            ) {
                min_support(support, CapabilitySupport::Partial)
            } else {
                support
            },
        )
    }

    // Local diagnostic projection/retention is implemented. Exact WeChat
    // persistence/upload and arbitrary-value/budget parity remain Partial.
    fn log_manager_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !matches!(
            name,
            "wx.getLogManager"
                | "object:LogManager.debug"
                | "object:LogManager.info"
                | "object:LogManager.log"
                | "object:LogManager.warn"
        ) {
            return None;
        }
        if !self.engine_provider_available()
            || self.host_calls.is_closed()
            || !self.log_manager.is_active()
        {
            return Some(CapabilitySupport::Unsupported);
        }
        let declared = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .map_or(declared, |value| min_support(declared, value));
        let support = provider
            .get(name)
            .copied()
            .map_or(host, |value| min_support(host, value));
        Some(min_support(support, CapabilitySupport::Partial))
    }

    fn effective_capability(&self, name: &str) -> CapabilitySupport {
        let provider = self.provider.capabilities_for_host(&self.config.host);
        self.effective_capability_with_provider(name, &provider)
    }

    fn effective_capability_with_provider(
        &self,
        name: &str,
        provider_capabilities: &BTreeMap<String, CapabilitySupport>,
    ) -> CapabilitySupport {
        if !distribution::showcase_capability_allowed(name) {
            return CapabilitySupport::Unsupported;
        }
        if let Some(support) = self.finite_notification_capability(name, provider_capabilities) {
            return support;
        }
        if let Some(support) = self.lifecycle_notification_capability(name, provider_capabilities) {
            return support;
        }
        if let Some(support) = self.log_manager_capability(name, provider_capabilities) {
            return support;
        }
        if matches!(name, "wx.createBufferURL" | "wx.revokeBufferURL") {
            if !self.engine_provider_available()
                || self.host_calls.is_closed()
                || self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed
            {
                return CapabilitySupport::Unsupported;
            }
            let manifest = self
                .manifest
                .capabilities
                .get(name)
                .copied()
                .unwrap_or(CapabilitySupport::Unsupported);
            let host = self
                .config
                .capabilities
                .get(name)
                .copied()
                .map_or(manifest, |value| min_support(manifest, value));
            let support = provider_capabilities
                .get(name)
                .copied()
                .map_or(host, |value| min_support(host, value));
            // Provisional source ceiling until native/WASM consumer and declaration
            // acceptance gates run; other APIs are assessed at their own boundary.
            return min_support(support, CapabilitySupport::Partial);
        }
        if let Some(support) = self.window_resize_capability(name, provider_capabilities) {
            return support;
        }
        if let Some(support) = self.route_capability(name, provider_capabilities) {
            return support;
        }
        if let Some(support) = self.error_notification_capability(name, provider_capabilities) {
            return support;
        }
        // Visibility animation and temporary/network icon replacement have no
        // complete presentation transaction yet. Manifest claims cannot enable them.
        if matches!(name, "wx.showTabBar" | "wx.hideTabBar" | "wx.setTabBarItem") {
            return CapabilitySupport::Unsupported;
        }
        // Emitting chrome metadata does not attach a presenter. Hosts opt in
        // only after installing a consumer for these dynamic system controls.
        if tab_bar::is_api(name)
            && (self.has_custom_tab_bar()
                || !self
                    .config
                    .capabilities
                    .get(name)
                    .is_some_and(|support| *support != CapabilitySupport::Unsupported))
        {
            return CapabilitySupport::Unsupported;
        }
        // A presenter admits the candidate contract; it cannot establish full
        // parity for the remaining exact-version indicator semantics.
        let ceiling =
            if tab_bar::is_api(name) || matches!(name, "wx.nextTick" | "wx.requestIdleCallback") {
                CapabilitySupport::Partial
            } else {
                CapabilitySupport::Full
            };
        if let Some(support) = self.registered_host_capability(name, provider_capabilities) {
            return min_support(support, ceiling);
        }
        if self.browser_api_unavailable(name) {
            return CapabilitySupport::Unsupported;
        }
        if matches!(
            name,
            "wx.fs.readFileSync"
                | "wx.fs.writeFileSync"
                | "wx.fs.accessSync"
                | "wx.fs.unlinkSync"
                | "wx.fs.readdirSync"
        ) && !self.provider.supports_sync_filesystem()
        {
            return CapabilitySupport::Unsupported;
        }
        let capability_key = if is_timer_api(name) {
            "wx.timer"
        } else if is_selector_query_api(name) {
            "wx.createSelectorQuery"
        } else {
            name
        };
        // File-system manager methods are exposed as `wx.fs.*` bridge
        // operations, while manifests historically declare the public
        // `wx.getFileSystemManager` capability. Resolve both spellings to the
        // most specific declaration so the JS manager can batch calls without
        // requiring every host to duplicate inventory entries.
        let capability_alias = if name.starts_with("wx.fs.")
            || matches!(
                name,
                "wx.saveFile"
                    | "wx.removeSavedFile"
                    | "wx.getFileInfo"
                    | "wx.getSavedFileInfo"
                    | "wx.getSavedFileList"
            ) {
            Some("wx.getFileSystemManager")
        } else if matches!(name, "wx.innerAudioContext" | "wx.audioContext") {
            Some(if name == "wx.audioContext" {
                "wx.createAudioContext"
            } else {
                "wx.createInnerAudioContext"
            })
        } else if name == "wx.videoContext" {
            Some("wx.createVideoContext")
        } else if matches!(name, "wx.createCameraContext" | "wx.cameraContext") {
            Some(if name == "wx.cameraContext" {
                "wx.createCameraContext"
            } else {
                "wx.cameraContext"
            })
        } else if matches!(name, "wx.socketTask.send" | "wx.socketTask.close") {
            Some("wx.connectSocket")
        } else {
            None
        };
        let manifest = self
            .manifest
            .capabilities
            .get(capability_key)
            .or_else(|| capability_alias.and_then(|alias| self.manifest.capabilities.get(alias)))
            .or_else(|| self.manifest.capabilities.get(name))
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let support = self
            .config
            .capabilities
            .get(capability_key)
            .or_else(|| capability_alias.and_then(|alias| self.config.capabilities.get(alias)))
            .or_else(|| self.config.capabilities.get(name))
            .copied()
            .map_or(manifest, |host| min_support(manifest, host));
        // Secure random generation belongs to this runtime. Provider inventories
        // cannot replace or disable its entropy source; manifest/host policy above
        // remains authoritative for whether the application may call it.
        if name == random_values::API {
            return min_support(support, ceiling);
        }
        let provider = provider_capabilities
            .get(capability_key)
            .or_else(|| capability_alias.and_then(|alias| provider_capabilities.get(alias)))
            .or_else(|| provider_capabilities.get(name))
            .copied();
        let support = provider.map_or(support, |provider| min_support(support, provider));
        let support = if self.browser_route_active() && is_selector_query_api(name) {
            min_support(support, CapabilitySupport::Partial)
        } else {
            support
        };
        min_support(support, ceiling)
    }
}

fn render_bridge_error(error: container_render_skia::RenderError) -> BridgeError {
    let code = match error {
        container_render_skia::RenderError::Unsupported(_) => {
            BridgeErrorCode::UnsupportedCapability
        }
        _ => BridgeErrorCode::Render,
    };
    BridgeError::new(code, error.to_string())
}

fn ensure_view_manifest_supported(
    manifest: &ContainerManifestV1,
    native_view: bool,
) -> Result<(), SessionError> {
    let legacy_asset = manifest.assets.iter().any(|asset| {
        asset.path.ends_with(".wxs")
            && !manifest.view_scripts.iter().any(|script| {
                script.id == format!("wxs:{}", asset.path) && script.sha256 == asset.sha256
            })
    });
    if legacy_asset
        || (!native_view
            && (!manifest.view_scripts.is_empty()
                || manifest
                    .templates
                    .iter()
                    .any(|template| !template.wxs_modules.is_empty())))
    {
        return Err(SessionError::UnsupportedCapability(
            "WXS requires an isolated View execution provider; AppService execution is forbidden"
                .into(),
        ));
    }
    Ok(())
}

fn ensure_wxml_view_supported(
    ast: &WxmlAst,
    template: &str,
    declared_native_view: bool,
) -> Result<(), BridgeError> {
    fn has_wxs(nodes: &[WxmlNode]) -> bool {
        nodes.iter().any(|node| match node {
            WxmlNode::Element { tag, children, .. } => tag == "wxs" || has_wxs(children),
            _ => false,
        })
    }
    if has_wxs(&ast.nodes) && !declared_native_view {
        return Err(BridgeError::new(
            BridgeErrorCode::UnsupportedCapability,
            format!(
                "template {template} contains WXS, which requires an isolated View execution provider"
            ),
        ));
    }
    Ok(())
}

fn use_session_render_resources(payload: &Map<String, Value>) -> Result<bool, BridgeError> {
    let requested = payload
        .get("useSessionResources")
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| BridgeError::invalid("useSessionResources must be a boolean"))
        })
        .transpose()?
        .unwrap_or(false);
    if requested && payload.contains_key("blobs") {
        return Err(BridgeError::invalid(
            "useSessionResources and explicit blobs are mutually exclusive",
        ));
    }
    Ok(requested)
}

fn decode_render_blobs(value: Option<&Value>) -> Result<BTreeMap<String, Vec<u8>>, BridgeError> {
    let value = value.ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::Render,
            "manifest render requires a blobs object with content-addressed bytes",
        )
    })?;
    let entries: Vec<(String, Value)> = match value {
        Value::Object(entries) => entries
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        Value::Array(entries) => entries
            .iter()
            .map(|entry| {
                let object = object_payload(entry)?;
                let hash = object
                    .get("sha256")
                    .or_else(|| object.get("hash"))
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Render,
                            "manifest blob entry requires sha256",
                        )
                    })?;
                let bytes = object
                    .get("bytes")
                    .cloned()
                    .ok_or_else(|| BridgeError::invalid("manifest blob entry requires bytes"))?;
                Ok((hash.to_owned(), bytes))
            })
            .collect::<Result<Vec<_>, BridgeError>>()?,
        _ => {
            return Err(BridgeError::invalid(
                "manifest render blobs must be an object or array",
            ));
        }
    };
    let mut blobs = BTreeMap::new();
    for (key, value) in entries {
        let hash = key.strip_prefix("sha256:").unwrap_or(&key);
        if !container_ir::is_sha256(hash) {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                format!("manifest blob key is not a SHA-256 digest: {key}"),
            ));
        }
        let bytes_value = value
            .as_object()
            .and_then(|object| object.get("bytes"))
            .unwrap_or(&value);
        let bytes = match bytes_value {
            // WXML/WXSS IR is canonical UTF-8 JSON, so accepting a string
            // here keeps the bridge convenient for text-oriented hosts while
            // retaining the byte-array form for binary-safe bindings.
            Value::String(source) => source.as_bytes().to_vec(),
            _ => serde_json::from_value::<Vec<u8>>(bytes_value.clone()).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("manifest blob {key} bytes are invalid: {error}"),
                )
            })?,
        };
        let actual = container_ir::hex_digest(&bytes);
        if actual != hash {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                format!("manifest blob {key} SHA-256 mismatch: expected {hash}, got {actual}"),
            ));
        }
        blobs.insert(format!("sha256:{hash}"), bytes);
    }
    Ok(blobs)
}

fn lookup_render_blob<'a>(
    blobs: &'a BTreeMap<String, Vec<u8>>,
    pointer: &str,
) -> Result<&'a [u8], BridgeError> {
    let hash = pointer.strip_prefix("sha256:").ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::Render,
            format!("manifest blob pointer must use sha256: prefix: {pointer}"),
        )
    })?;
    if !container_ir::is_sha256(hash) {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            format!("manifest blob pointer is not a SHA-256 digest: {pointer}"),
        ));
    }
    blobs.get(pointer).map(Vec::as_slice).ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::Render,
            format!("manifest blob {pointer} was not supplied"),
        )
    })
}

fn parse_render_viewport(value: Option<&Value>) -> Result<Rect, BridgeError> {
    let defaults = Rect {
        x: 0.0,
        y: 0.0,
        width: 375.0,
        height: 667.0,
    };
    let Some(value) = value else {
        return Ok(defaults);
    };
    let object = object_payload(value)?;
    let number = |key: &str, default: f32| -> Result<f32, BridgeError> {
        let Some(value) = object.get(key) else {
            return Ok(default);
        };
        let value = value.as_f64().ok_or_else(|| {
            BridgeError::invalid(format!("viewport.{key} must be a finite number"))
        })? as f32;
        if !value.is_finite() {
            return Err(BridgeError::invalid(format!(
                "viewport.{key} must be a finite number"
            )));
        }
        Ok(value)
    };
    let viewport = Rect {
        x: number("x", 0.0)?,
        y: number("y", 0.0)?,
        width: number("width", defaults.width)?,
        height: number("height", defaults.height)?,
    };
    SkiaRenderer::validate_viewport(viewport)
        .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
    Ok(viewport)
}

/// Build the data scope visible to a custom component template.
///
/// WXML attributes are the only portable property channel at render time.
/// Parent mustache expressions have already been interpolated before this
/// helper runs, therefore scalar JSON values can be recovered without
/// evaluating JavaScript in the renderer.  Event/directive attributes are
/// routing metadata and never become component data.  Unknown attributes are
/// retained as string properties so hosts can apply the component's declared
/// type conversion later.
fn component_scope_data(
    attrs: &BTreeMap<String, String>,
    bound_values: &BTreeMap<String, Value>,
) -> Value {
    let mut scope = Map::new();
    for (name, raw) in attrs {
        if name == "slot"
            || name.starts_with("wx:")
            || name.starts_with("bind")
            || name.starts_with("catch")
            || name.starts_with("capture-bind")
            || name.starts_with("capture-catch")
        {
            continue;
        }
        let value = bound_values
            .get(name)
            .cloned()
            .unwrap_or_else(|| match raw.as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                "null" => Value::Null,
                _ => raw
                    .parse::<f64>()
                    .ok()
                    .and_then(serde_json::Number::from_f64)
                    .map(Value::Number)
                    .unwrap_or_else(|| Value::String(raw.clone())),
            });
        scope.insert(name.clone(), value);
    }
    Value::Object(scope)
}

fn template_owner_config(template_id: &str) -> String {
    let path = template_id
        .strip_prefix("template:")
        .unwrap_or(template_id)
        .trim_start_matches("./");
    if let Some(path) = path.strip_suffix(".wxml") {
        format!("{path}.json")
    } else {
        format!("{path}.json")
    }
}

fn find_component_template<'a>(
    target: &str,
    templates: &'a BTreeMap<String, WxmlAst>,
) -> Option<(String, &'a WxmlAst)> {
    let target = target
        .trim()
        .trim_start_matches("./")
        .trim_start_matches('/');
    if target.starts_with("plugin://") || target.starts_with("npm:") {
        return None;
    }
    let candidates = if target.ends_with(".wxml") {
        vec![target.to_owned()]
    } else {
        vec![
            format!("{target}.wxml"),
            target.to_owned(),
            format!("{target}/index.wxml"),
            format!("{target}/index"),
        ]
    };
    candidates.iter().find_map(|candidate| {
        let id = format!("template:{candidate}");
        templates.get(&id).map(|ast| (id, ast))
    })
}

#[cfg(test)]
fn wxml_nodes_to_render(
    nodes: &[WxmlNode],
    styles: &WxssIr,
    viewport: Rect,
    path: &str,
    ancestors: &[WxssSelectorNode],
) -> Result<Vec<RenderNode>, BridgeError> {
    let mut nodes = wxml_nodes_to_render_with_context(
        nodes,
        styles,
        viewport,
        path,
        ancestors,
        None,
        &BTreeMap::new(),
    )?;
    for node in &mut nodes {
        resolve_render_color_inheritance(node, None);
        style_compositing::resolve_tree(node)?;
        style_visibility::resolve_tree(node)?;
        style_text::resolve_tree(node, viewport)?;
        style_flex::resolve_tree(node, viewport)?;
    }
    Ok(nodes)
}

// Resolve foreground and explicit border inheritance after component projection.
// Text, currentColor borders and selector reads must observe the same parent
// chain; geometry/compositing do not become implicitly inherited properties.
fn resolve_render_color_inheritance(node: &mut RenderNode, inherited: Option<&str>) {
    resolve_render_paint_inheritance(node, inherited, None);
}

fn resolve_render_paint_inheritance(
    node: &mut RenderNode,
    inherited: Option<&str>,
    inherited_style: Option<LayoutStyle>,
) {
    let specified = node.computed_style.get("color").map(String::as_str);
    let color = match specified {
        Some(value) if value.eq_ignore_ascii_case("initial") => Some("black".to_owned()),
        Some(value)
            if value.eq_ignore_ascii_case("inherit")
                || value.eq_ignore_ascii_case("unset")
                || value.eq_ignore_ascii_case("currentcolor") =>
        {
            Some(inherited.unwrap_or("black").to_owned())
        }
        Some(value) => Some(value.to_owned()),
        None => inherited.map(str::to_owned),
    };
    if let Some(color) = color.as_ref() {
        node.computed_style.insert("color".into(), color.clone());
        node.foreground = parse_render_color(color);
    }
    style_borders::resolve_inherited_borders(node, inherited_style);
    let style = node.style;
    for child in &mut node.children {
        resolve_render_paint_inheritance(child, color.as_deref(), style);
    }
}

#[cfg(test)]
#[derive(Clone, Copy)]
struct WxmlSiblingContext {
    offset: usize,
    total: usize,
}

#[cfg(test)]
fn renderable_element_count(node: &WxmlNode) -> usize {
    match node {
        WxmlNode::Element { tag, children, .. } if tag == "block" => {
            children.iter().map(renderable_element_count).sum()
        }
        WxmlNode::Element { .. } => 1,
        WxmlNode::Text { .. } | WxmlNode::Comment { .. } => 0,
    }
}

fn keyed_wxml_path_segment(scope: Option<&str>, key: &str) -> String {
    // Older evaluated v1 blobs have no source scope. Preserve their usable
    // key identity while newly evaluated source ASTs namespace each repeat.
    // Both strings are length-prefixed so punctuation in user keys cannot
    // impersonate a nested path or another scope/key pair.
    let scope = scope.unwrap_or("legacy");
    format!("k{}:{}{}:{}", scope.len(), scope, key.len(), key)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn wxml_nodes_to_render_with_context(
    nodes: &[WxmlNode],
    styles: &WxssIr,
    viewport: Rect,
    path: &str,
    ancestors: &[WxssSelectorNode],
    context: Option<WxmlSiblingContext>,
    ownership: &BTreeMap<String, RenderOwnership>,
) -> Result<Vec<RenderNode>, BridgeError> {
    let mut output = Vec::new();
    let sibling_count = context
        .map(|context| context.total)
        .unwrap_or_else(|| nodes.iter().map(renderable_element_count).sum());
    let base_offset = context.map(|context| context.offset).unwrap_or(0);
    let mut element_index = 0usize;
    for (index, node) in nodes.iter().enumerate() {
        // Positional paths make an un-keyed repeat cheap to address, but they
        // change whenever an array is reordered. A resolved `wx:key` is a
        // semantic identity, so use it as the path segment and keep generated
        // render-node ids stable across the reorder. The source scope keeps
        // independent repeats with equal keys distinct. This also applies
        // to a keyed `<block>`: the block itself is flattened below, while
        // its children inherit the stable keyed path prefix.
        let segment = match node {
            WxmlNode::Element {
                key: Some(key),
                key_scope,
                ..
            } => keyed_wxml_path_segment(key_scope.as_deref(), key),
            _ => index.to_string(),
        };
        let contribution = renderable_element_count(node);
        let (child_index, child_context) = match node {
            WxmlNode::Element { tag, .. } if tag != "block" => {
                element_index += 1;
                (Some(base_offset + element_index), None)
            }
            WxmlNode::Element { .. } => (
                None,
                Some(WxmlSiblingContext {
                    offset: base_offset + element_index,
                    total: sibling_count,
                }),
            ),
            _ => (None, None),
        };
        let node_path = if path.is_empty() {
            segment
        } else {
            format!("{path}.{segment}")
        };
        output.extend(wxml_node_to_render(
            node,
            styles,
            viewport,
            &node_path,
            ancestors,
            child_index,
            sibling_count,
            child_context,
            ownership,
        )?);
        element_index += contribution.saturating_sub(usize::from(child_index.is_some()));
    }
    Ok(output)
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn wxml_node_to_render(
    node: &WxmlNode,
    styles: &WxssIr,
    viewport: Rect,
    path: &str,
    ancestors: &[WxssSelectorNode],
    child_index: Option<usize>,
    sibling_count: usize,
    child_context: Option<WxmlSiblingContext>,
    ownership: &BTreeMap<String, RenderOwnership>,
) -> Result<Vec<RenderNode>, BridgeError> {
    match node {
        WxmlNode::Comment { .. } => Ok(Vec::new()),
        WxmlNode::Text { value, .. } => {
            let mut text = RenderNode::new(
                format!("text:{path}"),
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
            )
            .with_text(value.clone());
            // Anonymous WXML text is paint content, not a public event node.
            // Keep this true for unmanaged templates too: otherwise visible
            // text overflow can invent a target absent from the event graph.
            text.hit_testable = false;
            if let Some(owner) = ownership.get(path) {
                text.event_identity = Some(format!("event:{path}"));
                text.event_owner_scope_id = owner.event_owner.clone();
            }
            Ok(vec![text])
        }
        WxmlNode::Element {
            tag,
            attrs,
            bound_values,
            key,
            children,
            ..
        } => {
            let id = attrs
                .get("id")
                .filter(|id| !id.is_empty())
                .cloned()
                .unwrap_or_else(|| format!("node:{path}"));
            let classes: Vec<String> = attrs
                .get("class")
                .map(|value| value.split_whitespace().map(str::to_owned).collect())
                .unwrap_or_default();
            let dataset = project_dataset(attrs, bound_values);
            let mark = project_mark(attrs, bound_values);
            let selector_node = WxssSelectorNode {
                tag: Some(tag.clone()),
                id: attrs.get("id").cloned(),
                classes: classes.clone(),
                child_index,
                sibling_count: (child_index.is_some() && sibling_count > 0)
                    .then_some(sibling_count),
            };
            let inline = attrs
                .get("style")
                .map(|style| parse_inline_wxss(style))
                .unwrap_or_default();
            let declarations =
                resolve_wxss_style_for_node_with_inline(styles, &selector_node, ancestors, &inline);
            let mut render = RenderNode::new(
                id,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 0.0,
                },
            );
            render.key = key.clone();
            if tag == "scroll-view" {
                // Even an unmanaged template needs a unique occurrence for
                // persistent scrolling when public ids repeat.
                render.event_identity = Some(format!("event:{path}"));
            }
            if let Some(owner) = ownership.get(path) {
                render.event_identity = Some(format!("event:{path}"));
                render.event_owner_scope_id = owner.event_owner.clone();
                render.component_scope_id = owner.component_scope.clone();
            }
            render.tag = Some(tag.clone());
            render.classes = classes;
            render.dataset = dataset;
            render.attributes = attrs.clone();
            render.mark = mark;
            apply_render_declarations(&mut render, &declarations, viewport);
            if attrs
                .get("hidden")
                .is_some_and(|value| value.is_empty() || value.eq_ignore_ascii_case("true"))
            {
                if let Some(style) = render.style.as_mut() {
                    style.display = DisplayMode::None;
                }
            }
            let mut child_ancestors = ancestors.to_vec();
            if tag != "block" {
                child_ancestors.push(selector_node);
            }
            render.children = wxml_nodes_to_render_with_context(
                children,
                styles,
                viewport,
                path,
                &child_ancestors,
                (tag == "block").then_some(child_context).flatten(),
                ownership,
            )?;
            // `<block>` is a structural WXML container. It participates in
            // directive evaluation but does not create a render node or
            // selector target; project its children directly into the parent
            // tree so layout, hit testing and dataset paths match WeChat.
            if tag == "block" {
                return Ok(render.children);
            }
            Ok(vec![render])
        }
    }
}

fn apply_render_declarations(
    render: &mut RenderNode,
    declarations: &BTreeMap<String, WxssDeclaration>,
    viewport: Rect,
) {
    render.computed_style = declarations
        .iter()
        .map(|(property, declaration)| (property.clone(), declaration.value.clone()))
        .collect();
    render.style = Some(render_layout_style(declarations, viewport));
    render.background = declarations
        .get("background-color")
        .or_else(|| declarations.get("background"))
        .and_then(|declaration| parse_render_color(&declaration.value));
    render.foreground = declarations
        .get("color")
        .and_then(|declaration| parse_render_color(&declaration.value));
    // Primitive values are immediately useful to typed construction/tests;
    // explicit inheritance and unsupported values resolve after projection.
    render.opacity = declarations
        .get("opacity")
        .and_then(|declaration| container_ir::parse_wxss_opacity(&declaration.value).ok())
        .and_then(|value| match value {
            container_ir::WxssOpacity::Number(number) => Some(number),
            _ => None,
        })
        .unwrap_or(1.0);
    render.z_index = declarations
        .get("z-index")
        .and_then(|declaration| declaration.value.trim().parse::<i32>().ok())
        .unwrap_or(0);
}

fn render_layout_style(
    declarations: &BTreeMap<String, WxssDeclaration>,
    viewport: Rect,
) -> LayoutStyle {
    let signed_length = |property: &str| {
        declarations
            .get(property)
            .and_then(|declaration| parse_wxss_length(&declaration.value).ok())
            .and_then(|length| length.to_px(viewport.width, viewport.height, 16.0))
            .filter(|value| value.is_finite())
    };
    let length = |property: &str| signed_length(property).filter(|value| *value >= 0.0);
    let edge = |property: &str| {
        declarations
            .get(property)
            .and_then(|declaration| parse_edge_insets(&declaration.value, viewport))
    };
    let edge_or_longhands = |property: &str| {
        let fallback = edge(property).unwrap_or(EdgeInsets::ZERO);
        let side = |name: &str| {
            let key = format!("{property}-{name}");
            if property == "margin" {
                signed_length(&key)
            } else {
                length(&key)
            }
        };
        EdgeInsets {
            top: side("top").unwrap_or(fallback.top),
            right: side("right").unwrap_or(fallback.right),
            bottom: side("bottom").unwrap_or(fallback.bottom),
            left: side("left").unwrap_or(fallback.left),
        }
    };
    // Offsets and margins intentionally keep negative values; width, height
    // and padding retain their nonnegative constraints.
    let offset = signed_length;
    let direction = match declarations
        .get("flex-direction")
        .map(|declaration| declaration.value.trim())
    {
        Some("row-reverse") => FlexDirection::RowReverse,
        Some("row") => FlexDirection::Row,
        Some("column-reverse") => FlexDirection::ColumnReverse,
        _ => FlexDirection::Column,
    };
    let position = match declarations
        .get("position")
        .map(|declaration| declaration.value.trim().to_ascii_lowercase())
        .as_deref()
    {
        Some("relative") => PositionMode::Relative,
        Some("absolute") => PositionMode::Absolute,
        Some("fixed") => PositionMode::Fixed,
        _ => PositionMode::Static,
    };
    LayoutStyle {
        width: length("width"),
        height: length("height"),
        margin: edge_or_longhands("margin"),
        padding: edge_or_longhands("padding"),
        border: style_borders::parse_borders(declarations, viewport),
        box_sizing: match declarations
            .get("box-sizing")
            .map(|value| value.value.trim())
        {
            Some(value) if value.eq_ignore_ascii_case("border-box") => BoxSizing::BorderBox,
            _ => BoxSizing::ContentBox,
        },
        border_radius: parse_border_radii(declarations, viewport),
        direction,
        gap: length("gap").unwrap_or(0.0),
        display: match declarations
            .get("display")
            .map(|declaration| declaration.value.trim())
        {
            Some("none") => DisplayMode::None,
            _ => DisplayMode::Flex,
        },
        position,
        // Computed stacking is lowered after cascade and typed flow, keeping
        // auto distinct from explicit zero and resolving explicit inheritance.
        z_index: None,
        isolation: false,
        top: offset("top"),
        right: offset("right"),
        bottom: offset("bottom"),
        left: offset("left"),
        // The typed transform pass freezes font/viewport units only after
        // typography, then resolves percentages against the final border box.
        transform: None,
        transform_origin: None,
        // Cascaded typed layout is resolved only after inherited typography.
        // Preserve the legacy projection until that final lowering pass.
        flow: None,
    }
}

fn parse_border_radii(
    declarations: &BTreeMap<String, WxssDeclaration>,
    viewport: Rect,
) -> [CornerRadius; 4] {
    let mut radii = declarations
        .get("border-radius")
        .and_then(|declaration| parse_border_radius_shorthand(&declaration.value, viewport))
        .unwrap_or([CornerRadius::ZERO; 4]);
    for (index, property) in [
        "border-top-left-radius",
        "border-top-right-radius",
        "border-bottom-right-radius",
        "border-bottom-left-radius",
    ]
    .into_iter()
    .enumerate()
    {
        if let Some(radius) = declarations
            .get(property)
            .and_then(|declaration| parse_border_radius_corner(&declaration.value, viewport))
        {
            radii[index] = radius;
        }
    }
    radii
}

fn parse_border_radius_shorthand(value: &str, viewport: Rect) -> Option<[CornerRadius; 4]> {
    let (x_values, y_values) = value
        .split_once('/')
        .map(|(x, y)| (x.trim(), y.trim()))
        .unwrap_or((value.trim(), value.trim()));
    let x_values = x_values
        .split_ascii_whitespace()
        .map(|token| parse_radius_length(token, viewport, true))
        .collect::<Option<Vec<_>>>()?;
    let y_values = y_values
        .split_ascii_whitespace()
        .map(|token| parse_radius_length(token, viewport, false))
        .collect::<Option<Vec<_>>>()?;
    let x_values = expand_radius_values(x_values)?;
    let y_values = expand_radius_values(y_values)?;
    Some(std::array::from_fn(|index| CornerRadius {
        x: x_values[index],
        y: y_values[index],
    }))
}

fn parse_border_radius_corner(value: &str, viewport: Rect) -> Option<CornerRadius> {
    let values = value
        .split_ascii_whitespace()
        .map(|token| parse_radius_length(token, viewport, true))
        .collect::<Option<Vec<_>>>()?;
    match values.as_slice() {
        [x] => Some(CornerRadius { x: *x, y: *x }),
        [x, _] => Some(CornerRadius {
            x: *x,
            y: parse_radius_length(value.split_ascii_whitespace().nth(1)?, viewport, false)?,
        }),
        _ => None,
    }
}

fn expand_radius_values(values: Vec<f32>) -> Option<[f32; 4]> {
    match values.as_slice() {
        [one] => Some([*one; 4]),
        [top_bottom, right_left] => Some([*top_bottom, *right_left, *top_bottom, *right_left]),
        [top, right_left, bottom] => Some([*top, *right_left, *bottom, *right_left]),
        [top, right, bottom, left] => Some([*top, *right, *bottom, *left]),
        _ => None,
    }
}

fn parse_radius_length(value: &str, viewport: Rect, horizontal: bool) -> Option<f32> {
    let length = parse_wxss_length(value).ok()?;
    let value = match length.unit {
        WxssLengthUnit::Percent => {
            length.value
                * if horizontal {
                    viewport.width
                } else {
                    viewport.height
                }
                / 100.0
        }
        _ => length.to_px(viewport.width, viewport.height, 16.0)?,
    };
    value.is_finite().then_some(value.max(0.0))
}

fn parse_edge_insets(value: &str, viewport: Rect) -> Option<EdgeInsets> {
    let values = value
        .split_whitespace()
        .map(|part| {
            parse_wxss_length(part)
                .ok()?
                .to_px(viewport.width, viewport.height, 16.0)
        })
        .collect::<Option<Vec<_>>>()?;
    let values = match values.as_slice() {
        [one] => [*one, *one, *one, *one],
        [vertical, horizontal] => [*vertical, *horizontal, *vertical, *horizontal],
        [top, horizontal, bottom] => [*top, *horizontal, *bottom, *horizontal],
        [top, right, bottom, left] => [*top, *right, *bottom, *left],
        _ => return None,
    };
    Some(EdgeInsets {
        top: values[0],
        right: values[1],
        bottom: values[2],
        left: values[3],
    })
}

fn parse_render_color(value: &str) -> Option<Color> {
    let [red, green, blue, alpha] = container_ir::parse_wxss_color(value)?;
    Some(Color {
        red,
        green,
        blue,
        alpha,
    })
}

fn min_support(a: CapabilitySupport, b: CapabilitySupport) -> CapabilitySupport {
    fn rank(level: CapabilitySupport) -> u8 {
        match level {
            CapabilitySupport::Unsupported => 0,
            CapabilitySupport::Partial => 1,
            CapabilitySupport::Full => 2,
        }
    }
    if rank(a) <= rank(b) {
        a
    } else {
        b
    }
}

fn parse_lifecycle(value: &Value) -> Result<LifecycleEvent, BridgeError> {
    let value = value
        .as_str()
        .ok_or_else(|| BridgeError::invalid("lifecycle event must be a string"))?;
    match value.to_ascii_lowercase().as_str() {
        "launch" => Ok(LifecycleEvent::Launch),
        "show" => Ok(LifecycleEvent::Show),
        "hide" => Ok(LifecycleEvent::Hide),
        "unload" => Ok(LifecycleEvent::Unload),
        _ => Err(BridgeError::invalid(format!(
            "unknown lifecycle event {value}"
        ))),
    }
}

fn object_payload(value: &Value) -> Result<&Map<String, Value>, BridgeError> {
    value
        .as_object()
        .ok_or_else(|| BridgeError::invalid("payload must be an object"))
}

/// Apply event propagation control reported by the JavaScript engine to the
/// normalized route returned by `event.batch`. The JS side keeps the event
/// object alive for the whole dispatch and emits a control marker only on the
/// handler that called `stopPropagation` or `stopImmediatePropagation`.
/// Walking nested arrays accommodates both native engines, whose global call
/// ABI returns a one-element value batch, without introducing another bridge
/// round trip.
#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn trim_event_dispatches_for_control(dispatches: &mut Vec<EventDispatch>, hook_result: &Value) {
    fn visit(value: &Value, dispatches: &[EventDispatch], cutoff: &mut Option<usize>) {
        let Value::Object(object) = value else {
            if let Value::Array(values) = value {
                for value in values {
                    visit(value, dispatches, cutoff);
                    if cutoff.is_some() {
                        break;
                    }
                }
            }
            return;
        };
        let has_stop = object
            .get("propagationStopped")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            || object
                .get("immediatePropagationStopped")
                .and_then(Value::as_bool)
                .unwrap_or(false);
        if has_stop
            && object.get("handler").and_then(Value::as_str).is_some()
            && object
                .get("currentTarget")
                .and_then(Value::as_str)
                .is_some()
            && object.get("phase").and_then(Value::as_str).is_some()
        {
            if let Some(index) = event_control_dispatch_index(object, dispatches) {
                *cutoff = Some(cutoff.map_or(index, |previous| previous.min(index)));
            }
            return;
        }
        for value in object.values() {
            visit(value, dispatches, cutoff);
            if cutoff.is_some() {
                break;
            }
        }
    }

    let mut cutoff = None;
    visit(hook_result, dispatches, &mut cutoff);
    if let Some(index) = cutoff {
        dispatches.truncate(index.saturating_add(1));
    }
}

/// Native event records expose public WXML ids to JS, whereas the core route
/// uses unique occurrence identities. The submitted dispatch index is their
/// shared address, including the extra capture listener at a target. Never
/// resolve a public id back to the first matching rendered node.
fn event_control_dispatch_index(
    record: &Map<String, Value>,
    dispatches: &[EventDispatch],
) -> Option<usize> {
    let phase = record.get("phase").and_then(Value::as_str)?;
    record
        .get("dispatchIndex")
        .and_then(Value::as_u64)
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| {
            dispatches
                .get(*index)
                .is_some_and(|dispatch| event_phase_name(dispatch.phase) == phase)
        })
        .or_else(|| {
            // Legacy records without an index can still name an exact core
            // identity. Public ids are deliberately not searched here.
            let current = record.get("currentTarget").and_then(Value::as_str)?;
            dispatches.iter().position(|dispatch| {
                dispatch.current_target == current && event_phase_name(dispatch.phase) == phase
            })
        })
}

fn event_phase_name(phase: container_core::EventPhase) -> &'static str {
    match phase {
        container_core::EventPhase::Capture => "capture",
        container_core::EventPhase::Target => "target",
        container_core::EventPhase::Bubble => "bubble",
    }
}

fn module_value_len(value: &Value) -> usize {
    match value {
        Value::Array(values) => values.len(),
        Value::Object(object) => object
            .get("modules")
            .and_then(Value::as_array)
            .map_or(0, Vec::len),
        _ => 0,
    }
}

fn visit_module_load_order(
    id: &str,
    pending: &BTreeMap<String, (ModuleFormat, String, Vec<u8>)>,
    loaded: &BTreeMap<String, LoadedModule>,
    manifest: &ContainerManifestV1,
    state: &mut BTreeMap<String, u8>,
    order: &mut Vec<String>,
    visiting: &mut Vec<String>,
) -> Result<(), BridgeError> {
    match state.get(id).copied() {
        Some(2) => return Ok(()),
        Some(1) => {
            let cycle_start = visiting.iter().position(|active| active == id).unwrap_or(0);
            if visiting[cycle_start..].iter().any(|active| {
                pending
                    .get(active)
                    .is_some_and(|(format, _, _)| *format == ModuleFormat::Esm)
            }) {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("ESM module dependency cycle includes {id}"),
                ));
            }
            return Ok(());
        }
        _ => {}
    }
    state.insert(id.to_owned(), 1);
    visiting.push(id.to_owned());
    let declaration = manifest
        .modules
        .iter()
        .find(|module| module.id == id)
        .ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {id} is not declared in the manifest"),
            )
        })?;
    for dependency in &declaration.dependencies {
        if pending.contains_key(dependency) {
            visit_module_load_order(
                dependency, pending, loaded, manifest, state, order, visiting,
            )?;
        } else if !loaded.contains_key(dependency) {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {dependency} must be supplied before {id}"),
            ));
        }
    }
    visiting.pop();
    state.insert(id.to_owned(), 2);
    order.push(id.to_owned());
    Ok(())
}

#[derive(Debug)]
struct EsmImportDeclaration {
    specifier: String,
    default: Option<String>,
    namespace: Option<String>,
    named: Vec<(String, String)>,
}

#[derive(Debug)]
struct EsmExportFromDeclaration {
    specifier: String,
    names: Vec<(String, String)>,
}

fn is_js_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first == '_' || first == '$' || first.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn decode_js_string(value: &str, quote: char) -> Option<String> {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        let escaped = chars.next()?;
        output.push(match escaped {
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            'b' => '\u{0008}',
            'f' => '\u{000c}',
            '0' => '\0',
            '\\' => '\\',
            '\'' => '\'',
            '"' => '"',
            other => other,
        });
    }
    if quote == '\'' || quote == '"' {
        Some(output)
    } else {
        None
    }
}

fn parse_js_string_prefix<'a>(
    input: &'a str,
    module_id: &str,
) -> Result<(String, &'a str), BridgeError> {
    let input = input.trim_start();
    let quote = input.as_bytes().first().copied().ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has a missing ESM module specifier"),
        )
    })? as char;
    if quote != '\'' && quote != '"' {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} ESM specifier must be a string literal"),
        ));
    }
    let bytes = input.as_bytes();
    let mut escaped = false;
    let mut end = None;
    for (index, byte) in bytes.iter().enumerate().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if *byte == b'\\' {
            escaped = true;
            continue;
        }
        if *byte == quote as u8 {
            end = Some(index);
            break;
        }
    }
    let end = end.ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has an unterminated ESM string literal"),
        )
    })?;
    let specifier = decode_js_string(&input[1..end], quote).ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has an invalid ESM string literal"),
        )
    })?;
    Ok((specifier, &input[end + 1..]))
}

fn keyword_boundary(byte: Option<u8>) -> bool {
    byte.is_none_or(|byte| !(byte as char).is_ascii_alphanumeric() && byte != b'_' && byte != b'$')
}

fn find_esm_keyword(value: &str, keyword: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut quote = None;
    let mut escaped = false;
    let mut brace_depth = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(current_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == current_quote {
                quote = None;
            }
            index += 1;
            continue;
        }
        if byte == b'\'' || byte == b'"' {
            quote = Some(byte);
            index += 1;
            continue;
        }
        match byte {
            b'{' => brace_depth = brace_depth.saturating_add(1),
            b'}' => brace_depth = brace_depth.saturating_sub(1),
            _ => {}
        }
        if brace_depth == 0
            && bytes[index..].starts_with(keyword.as_bytes())
            && keyword_boundary(index.checked_sub(1).and_then(|i| bytes.get(i).copied()))
            && keyword_boundary(bytes.get(index + keyword.len()).copied())
        {
            return Some(index);
        }
        index += 1;
    }
    None
}

fn parse_binding_list(value: &str, module_id: &str) -> Result<Vec<(String, String)>, BridgeError> {
    let mut result = Vec::new();
    for item in value.split(',') {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        let parts = item.split_whitespace().collect::<Vec<_>>();
        let (imported, local) = match parts.as_slice() {
            [name] => (*name, *name),
            [name, "as", alias] => (*name, *alias),
            _ => {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {module_id} has an invalid ESM binding: {item}"),
                ));
            }
        };
        if !is_js_identifier(imported) || !is_js_identifier(local) {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has an invalid ESM binding: {item}"),
            ));
        }
        result.push((imported.to_owned(), local.to_owned()));
    }
    if result.is_empty() {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has an empty ESM binding list"),
        ));
    }
    Ok(result)
}

fn strip_statement_terminator(value: &str) -> &str {
    value
        .trim()
        .strip_suffix(';')
        .unwrap_or_else(|| value.trim())
        .trim()
}

fn parse_esm_import_statement(
    value: &str,
    module_id: &str,
) -> Result<Option<EsmImportDeclaration>, BridgeError> {
    let trimmed = value.trim();
    let Some(rest) = trimmed.strip_prefix("import") else {
        return Ok(None);
    };
    if !rest
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_whitespace() || *byte == b'(' || *byte == b'.')
    {
        return Ok(None);
    }
    let rest = rest.trim_start();
    if rest.starts_with('(') || rest.starts_with('.') {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} uses dynamic import or import.meta, which is unsupported"),
        ));
    }
    if rest.starts_with('\'') || rest.starts_with('"') {
        let (specifier, tail) = parse_js_string_prefix(rest, module_id)?;
        if !strip_statement_terminator(tail).is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has trailing tokens after an ESM side-effect import"),
            ));
        }
        return Ok(Some(EsmImportDeclaration {
            specifier,
            default: None,
            namespace: None,
            named: Vec::new(),
        }));
    }
    let from = find_esm_keyword(rest, "from").ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} ESM import is missing a from clause"),
        )
    })?;
    let clause = rest[..from].trim().trim_end_matches(',').trim();
    let (specifier, tail) = parse_js_string_prefix(&rest[from + "from".len()..], module_id)?;
    if !strip_statement_terminator(tail).is_empty() {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has unsupported tokens after ESM import"),
        ));
    }
    let mut default = None;
    let mut namespace = None;
    let mut named = Vec::new();
    if clause.starts_with('{') {
        let end = clause.rfind('}').ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has an unterminated ESM named import"),
            )
        })?;
        if !clause[end + 1..].trim().is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has unsupported ESM import syntax"),
            ));
        }
        named = parse_binding_list(&clause[1..end], module_id)?;
    } else if clause.starts_with('*') {
        let parts = clause.split_whitespace().collect::<Vec<_>>();
        if parts.len() != 3 || parts[0] != "*" || parts[1] != "as" || !is_js_identifier(parts[2]) {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has unsupported ESM namespace import syntax"),
            ));
        }
        namespace = Some(parts[2].to_owned());
    } else {
        let (name, remainder) = clause
            .split_once(',')
            .map(|(name, remainder)| (name.trim(), remainder.trim()))
            .unwrap_or((clause.trim(), ""));
        if !is_js_identifier(name) {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has an invalid ESM default import"),
            ));
        }
        default = Some(name.to_owned());
        if remainder.is_empty() {
            // `import value from "module"` is a complete default import.
        } else if remainder.starts_with('{') {
            let end = remainder.rfind('}').ok_or_else(|| {
                BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {module_id} has an unterminated ESM named import"),
                )
            })?;
            if !remainder[end + 1..].trim().is_empty() {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {module_id} has unsupported ESM import syntax"),
                ));
            }
            named = parse_binding_list(&remainder[1..end], module_id)?;
        } else if remainder.starts_with('*') {
            let parts = remainder.split_whitespace().collect::<Vec<_>>();
            if parts.len() != 3
                || parts[0] != "*"
                || parts[1] != "as"
                || !is_js_identifier(parts[2])
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {module_id} has unsupported ESM namespace import syntax"),
                ));
            }
            namespace = Some(parts[2].to_owned());
        } else {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has unsupported ESM import syntax"),
            ));
        }
    }
    Ok(Some(EsmImportDeclaration {
        specifier,
        default,
        namespace,
        named,
    }))
}

fn parse_esm_export_from_statement(
    value: &str,
    module_id: &str,
) -> Result<Option<EsmExportFromDeclaration>, BridgeError> {
    let trimmed = value.trim();
    let Some(rest) = trimmed.strip_prefix("export") else {
        return Ok(None);
    };
    if !rest
        .as_bytes()
        .first()
        .is_some_and(|byte| byte.is_ascii_whitespace())
    {
        return Ok(None);
    }
    let rest = rest.trim_start();
    if rest.starts_with('*') {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} uses export * re-export, which is unsupported"),
        ));
    }
    if !rest.starts_with('{') {
        return Ok(None);
    }
    let end = rest.find('}').ok_or_else(|| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has an unterminated ESM re-export"),
        )
    })?;
    let suffix = &rest[end + 1..];
    let Some(from) = find_esm_keyword(suffix, "from") else {
        // `export { local }` is handled by the existing local-export branch.
        return Ok(None);
    };
    let from = end + 1 + from;
    let (specifier, tail) = parse_js_string_prefix(&rest[from + "from".len()..], module_id)?;
    if !strip_statement_terminator(tail).is_empty() {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} has unsupported tokens after ESM re-export"),
        ));
    }
    let names = parse_binding_list(&rest[1..end], module_id)?;
    Ok(Some(EsmExportFromDeclaration { specifier, names }))
}

// Existing portable packs use both source paths and already-prefixed module
// references for entryModule. Normalize the reference once before looking up
// a factory or its captured Page registration.
fn module_reference_id(value: &str) -> String {
    format!("module:{}", value.strip_prefix("module:").unwrap_or(value))
}

fn resolve_manifest_module_id(
    from_module: &str,
    specifier: &str,
    manifest: &ContainerManifestV1,
) -> Result<String, BridgeError> {
    let files = manifest
        .modules
        .iter()
        .filter_map(|module| module.id.strip_prefix("module:"))
        .collect::<Vec<_>>();
    let from_file = from_module.strip_prefix("module:").unwrap_or(from_module);
    let dirname = from_file.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut bases = Vec::new();
    if specifier.starts_with('.') {
        bases.push(format!("{dirname}/{specifier}"));
    } else if let Some(stripped) = specifier.strip_prefix('/') {
        bases.push(stripped.to_owned());
    } else {
        bases.push(specifier.to_owned());
        bases.push(format!("miniprogram_npm/{specifier}"));
        bases.push(format!("node_modules/{specifier}"));
    }
    let mut candidates = Vec::new();
    for base in bases {
        let base = normalize_module_path(&base);
        candidates.push(base.clone());
        let has_known_extension = [".js", ".mjs", ".cjs", ".json"]
            .iter()
            .any(|suffix| base.ends_with(suffix));
        if !has_known_extension {
            for suffix in [".js", ".mjs", ".cjs", ".json"] {
                candidates.push(format!("{base}{suffix}"));
            }
            for suffix in [".js", ".mjs", ".cjs", ".json"] {
                candidates.push(format!("{base}/index{suffix}"));
            }
        }
    }
    for candidate in candidates {
        if files.iter().any(|file| *file == candidate) {
            return Ok(format!("module:{candidate}"));
        }
    }
    Err(BridgeError::new(
        BridgeErrorCode::ModuleLoad,
        format!("module {from_module} cannot resolve ESM dependency {specifier}"),
    ))
}

fn normalize_module_path(value: &str) -> String {
    let mut parts = Vec::new();
    for part in value.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

fn find_statement_semicolon(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    let mut quote = None;
    let mut escaped = false;
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut brace_depth = 0usize;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if let Some(current_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == current_quote {
                quote = None;
            }
        } else if byte == b'\'' || byte == b'"' || byte == b'`' {
            quote = Some(byte);
        } else {
            match byte {
                b'(' => paren_depth = paren_depth.saturating_add(1),
                b')' => paren_depth = paren_depth.saturating_sub(1),
                b'[' => bracket_depth = bracket_depth.saturating_add(1),
                b']' => bracket_depth = bracket_depth.saturating_sub(1),
                b'{' => brace_depth = brace_depth.saturating_add(1),
                b'}' => brace_depth = brace_depth.saturating_sub(1),
                b';' if paren_depth == 0 && bracket_depth == 0 && brace_depth == 0 => {
                    return Some(index);
                }
                _ => {}
            }
        }
    }
    None
}

fn split_esm_statements(source: &str) -> Vec<String> {
    let mut lines = Vec::new();
    for line in source.lines() {
        let mut remainder = line;
        loop {
            let trimmed = remainder.trim_start();
            let starts_esm = trimmed.starts_with("import ")
                || trimmed.starts_with("export {")
                || trimmed.starts_with("export *")
                || trimmed.starts_with("export const ")
                || trimmed.starts_with("export let ")
                || trimmed.starts_with("export var ")
                || (trimmed.starts_with("export default ")
                    && !trimmed.starts_with("export default function ")
                    && !trimmed.starts_with("export default class "));
            let Some(end) = (if starts_esm {
                find_statement_semicolon(remainder)
            } else {
                None
            }) else {
                lines.push(remainder.to_owned());
                break;
            };
            let split = end + 1;
            lines.push(remainder[..split].to_owned());
            remainder = &remainder[split..];
            if remainder.trim().is_empty() {
                break;
            }
        }
    }
    lines
}

/// Translate the static ESM subset emitted by portable fixtures into the
/// CommonJS wrapper understood by both native adapters. Dependency values use
/// the module-local JS cache by manifest ID, without provider allocation
/// assumptions or per-module FFI calls. Dynamic imports, export-star and
/// unsupported syntax return the stable module-load bridge error.
fn transpile_esm_to_commonjs<F>(
    bytes: &[u8],
    module_id: &str,
    mut resolve_dependency: F,
) -> Result<Vec<u8>, BridgeError>
where
    F: FnMut(&str) -> Result<String, BridgeError>,
{
    let source = std::str::from_utf8(bytes).map_err(|error| {
        BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} ESM is not UTF-8: {error}"),
        )
    })?;
    if source.contains("import(") || source.contains("import (") {
        return Err(BridgeError::new(
            BridgeErrorCode::ModuleLoad,
            format!("module {module_id} uses dynamic import, which is unsupported"),
        ));
    }
    let mut output = String::with_capacity(source.len() + 256);
    let mut exports = Vec::new();
    let mut re_exports = Vec::new();
    let mut dependency_aliases: Vec<(String, String)> = Vec::new();
    let mut next_dependency = 0usize;
    let mut pending_statement = String::new();
    let mut process_statement = |statement: &str,
                                 output: &mut String,
                                 re_exports: &mut Vec<(String, String, String)>,
                                 dependency_aliases: &mut Vec<(String, String)>,
                                 next_dependency: &mut usize|
     -> Result<bool, BridgeError> {
        let statement = statement.trim();
        if let Some(import) = parse_esm_import_statement(statement, module_id)? {
            let target = resolve_dependency(&import.specifier)?;
            let alias =
                if let Some((_, alias)) = dependency_aliases.iter().find(|(id, _)| id == &target) {
                    alias.clone()
                } else {
                    let alias = format!("__container_esm_dep_{}", *next_dependency);
                    *next_dependency += 1;
                    dependency_aliases.push((target.clone(), alias.clone()));
                    alias
                };
            if let Some(default) = import.default {
                output.push_str(&format!(
                    "const {default} = {alias} != null && Object.prototype.hasOwnProperty.call({alias}, \"default\") ? {alias}.default : {alias};\n"
                ));
            }
            if let Some(namespace) = import.namespace {
                output.push_str(&format!("const {namespace} = {alias};\n"));
            }
            for (imported, local) in import.named {
                output.push_str(&format!(
                    "const {local} = {alias}[{}];\n",
                    serde_json::to_string(&imported).unwrap_or_else(|_| format!("\"{imported}\""))
                ));
            }
            return Ok(true);
        }
        if let Some(export) = parse_esm_export_from_statement(statement, module_id)? {
            let target = resolve_dependency(&export.specifier)?;
            if !dependency_aliases.iter().any(|(id, _)| id == &target) {
                let alias = format!("__container_esm_dep_{}", *next_dependency);
                *next_dependency += 1;
                dependency_aliases.push((target.clone(), alias));
            }
            for (imported, exported) in export.names {
                re_exports.push((exported, imported, target.clone()));
            }
            return Ok(true);
        }
        Ok(false)
    };
    for line in split_esm_statements(source) {
        let trimmed = line.trim_start();
        let starts_esm = trimmed.starts_with("import")
            || trimmed.starts_with("export {")
            || trimmed.starts_with("export *");
        if !pending_statement.is_empty() {
            pending_statement.push('\n');
            pending_statement.push_str(trimmed);
            if pending_statement.contains(';')
                || parse_esm_import_statement(&pending_statement, module_id).is_ok()
                || parse_esm_export_from_statement(&pending_statement, module_id).is_ok()
            {
                let handled = process_statement(
                    &pending_statement,
                    &mut output,
                    &mut re_exports,
                    &mut dependency_aliases,
                    &mut next_dependency,
                )?;
                if !handled {
                    output.push_str(&pending_statement);
                    output.push('\n');
                }
                pending_statement.clear();
            }
            continue;
        }
        if starts_esm {
            match process_statement(
                &line,
                &mut output,
                &mut re_exports,
                &mut dependency_aliases,
                &mut next_dependency,
            ) {
                Ok(true) => continue,
                Ok(false) => {}
                Err(error) => {
                    if trimmed.starts_with("import ") && !trimmed.contains(" from ") {
                        pending_statement.push_str(&line);
                        continue;
                    }
                    return Err(error);
                }
            }
        }
        if let Some(rest) = trimmed.strip_prefix("export default ") {
            if let Some(named) = rest
                .strip_prefix("function ")
                .or_else(|| rest.strip_prefix("class "))
                .and_then(|value| {
                    value
                        .split(|ch: char| ch == '(' || ch == '{' || ch.is_whitespace())
                        .next()
                })
                .filter(|name| !name.is_empty())
            {
                let indent = &line[..line.len() - trimmed.len()];
                output.push_str(indent);
                output.push_str(rest);
                output.push('\n');
                output.push_str("module.exports.default = ");
                output.push_str(named);
                output.push_str(";\n");
            } else {
                output.push_str("module.exports.default = ");
                output.push_str(rest);
                output.push('\n');
            }
            continue;
        }
        let mut declaration = trimmed;
        let mut exported_name = None;
        for keyword in ["export const ", "export let ", "export var "] {
            if let Some(rest) = trimmed.strip_prefix(keyword) {
                declaration = &trimmed["export ".len()..];
                exported_name = rest
                    .split(|ch: char| ch == '=' || ch.is_whitespace())
                    .next()
                    .filter(|name| !name.is_empty());
                break;
            }
        }
        if exported_name.is_none() {
            for keyword in ["export function ", "export class "] {
                if let Some(rest) = trimmed.strip_prefix(keyword) {
                    declaration = &trimmed["export ".len()..];
                    exported_name = rest
                        .split(|ch: char| ch == '(' || ch == '{' || ch.is_whitespace())
                        .next()
                        .filter(|name| !name.is_empty());
                    break;
                }
            }
        }
        if let Some(rest) = trimmed.strip_prefix("export {") {
            if trimmed.contains(" from ") {
                return Err(BridgeError::new(
                    BridgeErrorCode::ModuleLoad,
                    format!("module {module_id} has malformed ESM re-export"),
                ));
            }
            let names = rest.split('}').next().unwrap_or_default();
            for item in names.split(',') {
                let mut parts = item.split(" as ").map(str::trim);
                let local = parts.next().filter(|name| !name.is_empty());
                let alias = parts.next().or(local);
                if let (Some(local), Some(alias)) = (local, alias) {
                    exports.push((alias.to_owned(), local.to_owned()));
                }
            }
            continue;
        }
        let indent = &line[..line.len() - trimmed.len()];
        output.push_str(indent);
        output.push_str(declaration);
        output.push('\n');
        if let Some(name) = exported_name {
            exports.push((name.to_owned(), name.to_owned()));
        }
    }
    if !pending_statement.trim().is_empty() {
        let handled = process_statement(
            &pending_statement,
            &mut output,
            &mut re_exports,
            &mut dependency_aliases,
            &mut next_dependency,
        )?;
        if !handled {
            return Err(BridgeError::new(
                BridgeErrorCode::ModuleLoad,
                format!("module {module_id} has an incomplete ESM declaration"),
            ));
        }
    }
    let mut dependency_prefix = String::new();
    for (target, alias) in dependency_aliases {
        dependency_prefix.push_str(&format!(
            "const {alias} = require({});\n",
            serde_json::to_string(&target).expect("string serialization cannot fail")
        ));
    }
    output = format!("{dependency_prefix}{output}");
    for (exported, imported, target) in re_exports {
        output.push_str("module.exports[");
        output.push_str(
            &serde_json::to_string(&exported).unwrap_or_else(|_| format!("\"{exported}\"")),
        );
        output.push_str("] = require(");
        output.push_str(&serde_json::to_string(&target).expect("string serialization cannot fail"));
        output.push_str(")[");
        output.push_str(
            &serde_json::to_string(&imported).unwrap_or_else(|_| format!("\"{imported}\"")),
        );
        output.push_str("];\n");
    }
    for (exported, local) in exports {
        output.push_str("module.exports[");
        output.push_str(
            &serde_json::to_string(&exported).unwrap_or_else(|_| format!("\"{exported}\"")),
        );
        output.push_str("] = ");
        output.push_str(&local);
        output.push_str(";\n");
    }
    Ok(output.into_bytes())
}

fn parse_page_id(value: Option<&Value>) -> Result<PageId, BridgeError> {
    let value = value.ok_or_else(|| BridgeError::invalid("pageId is required"))?;
    let number = value
        .as_u64()
        .ok_or_else(|| BridgeError::invalid("pageId must be an unsigned integer"))?;
    Ok(PageId(number))
}

// Direct bridge navigation must reject malformed input before hiding or
// retiring any live receiver. Core stack validation alone runs too late.
fn validate_page_input(path: &str, payload: &Map<String, Value>) -> Result<(), BridgeError> {
    if path.trim().is_empty() {
        return Err(BridgeError::invalid("page path cannot be empty"));
    }
    if payload.get("data").is_some_and(|data| !data.is_object()) {
        return Err(BridgeError::invalid("page initial data must be an object"));
    }
    if payload.get("query").is_some_and(|query| !query.is_object()) {
        return Err(BridgeError::invalid("query must be an object"));
    }
    Ok(())
}

fn set_query(
    runtime: &mut ContainerRuntime,
    page_id: PageId,
    value: Option<&Value>,
) -> Result<(), BridgeError> {
    let Some(value) = value else { return Ok(()) };
    let object = value
        .as_object()
        .ok_or_else(|| BridgeError::invalid("query must be an object"))?;
    let page = runtime
        .pages_mut()
        .get_mut(page_id)
        .ok_or_else(|| BridgeError::invalid("page not found after navigation"))?;
    page.query = object
        .iter()
        .map(|(key, value)| {
            (
                key.clone(),
                value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string()),
            )
        })
        .collect();
    Ok(())
}

/// Resolve a navigation URL exactly once at the runtime boundary.  WeChat
/// accepts both `url: "pages/detail?id=7"` and an explicit `query` object;
/// the path used by the page stack excludes the query and fragment while the
/// page's onLoad argument contains stringified values.  Explicit query keys
/// win over URL keys, matching the options object used by the native APIs.
fn navigation_target(
    manifest: &ContainerManifestV1,
    name: &str,
    raw_path: Option<&str>,
    explicit_query: Option<&Value>,
) -> Result<(Option<String>, Value), BridgeError> {
    navigation_target_impl(manifest, name, raw_path, explicit_query, true)
}

fn navigation_target_unchecked(
    manifest: &ContainerManifestV1,
    name: &str,
    raw_path: Option<&str>,
    explicit_query: Option<&Value>,
) -> Result<(Option<String>, Value), BridgeError> {
    navigation_target_impl(manifest, name, raw_path, explicit_query, false)
}

fn navigation_target_impl(
    manifest: &ContainerManifestV1,
    name: &str,
    raw_path: Option<&str>,
    explicit_query: Option<&Value>,
    check_route: bool,
) -> Result<(Option<String>, Value), BridgeError> {
    let Some(raw_path) = raw_path else {
        return Ok((None, json!({})));
    };
    let raw_path = raw_path.trim();
    if raw_path.is_empty() {
        return Err(BridgeError::invalid("navigation path cannot be empty"));
    }
    let (without_fragment, _) = raw_path.split_once('#').unwrap_or((raw_path, ""));
    let (path, query_text) = without_fragment
        .split_once('?')
        .map_or((without_fragment, ""), |(path, query)| (path, query));
    let path = path.trim_start_matches('/').to_owned();
    if path.is_empty() {
        return Err(BridgeError::invalid("navigation path cannot be empty"));
    }

    let mut query = Map::new();
    for pair in query_text.split('&').filter(|pair| !pair.is_empty()) {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = percent_decode_query(key)?;
        if key.is_empty() {
            return Err(BridgeError::invalid("navigation query key cannot be empty"));
        }
        query.insert(key, Value::String(percent_decode_query(value)?));
    }
    if let Some(value) = explicit_query {
        let object = value
            .as_object()
            .ok_or_else(|| BridgeError::invalid("query must be an object"))?;
        for (key, value) in object {
            query.insert(key.clone(), Value::String(stringify_query_value(value)));
        }
    }

    if check_route && !manifest.routes.is_empty() {
        let route = manifest
            .routes
            .iter()
            .find(|route| route.path == path)
            .ok_or_else(|| BridgeError::invalid(format!("unknown route {path}")))?;
        if name == "wx.switchTab" && route.kind != container_ir::RouteKind::Tab {
            return Err(BridgeError::invalid(format!(
                "wx.switchTab requires a tab route, got {path}"
            )));
        }
        // Tab-bar pages are roots that can only be selected with switchTab.
        // WeChat rejects navigateTo/redirectTo before touching the page stack;
        // accepting them here would create a second tab instance and emit
        // lifecycle callbacks that the host could never observe in DevTools.
        if matches!(name, "wx.navigateTo" | "wx.redirectTo")
            && route.kind == container_ir::RouteKind::Tab
        {
            return Err(BridgeError::invalid(format!(
                "{name} cannot target a tab route, use wx.switchTab for {path}"
            )));
        }
    }
    Ok((Some(path), Value::Object(query)))
}

fn stringify_query_value(value: &Value) -> String {
    value
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn percent_decode_query(value: &str) -> Result<String, BridgeError> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'+' => {
                output.push(b' ');
                index += 1;
            }
            b'%' => {
                if index + 2 >= bytes.len() {
                    return Err(BridgeError::invalid(
                        "navigation query has incomplete percent escape",
                    ));
                }
                let high = hex_nibble(bytes[index + 1]).ok_or_else(|| {
                    BridgeError::invalid("navigation query has invalid percent escape")
                })?;
                let low = hex_nibble(bytes[index + 2]).ok_or_else(|| {
                    BridgeError::invalid("navigation query has invalid percent escape")
                })?;
                output.push((high << 4) | low);
                index += 3;
            }
            byte => {
                output.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(output)
        .map_err(|_| BridgeError::invalid("navigation query is not valid UTF-8"))
}

fn hex_nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn page_payload(runtime: &ContainerRuntime, id: PageId, ok: bool) -> Result<Value, BridgeError> {
    let page = runtime
        .pages()
        .get(id)
        .ok_or_else(|| BridgeError::invalid("page not found after navigation"))?;
    Ok(json!({"ok": ok, "page": page, "pageId": id.0}))
}

fn with_page_hooks(mut page: Value, hooks: Value) -> Result<Value, BridgeError> {
    let object = page
        .as_object_mut()
        .ok_or_else(|| BridgeError::invalid("page payload must be an object"))?;
    object.insert("hooks".into(), hooks);
    Ok(page)
}

fn runtime_error(error: RuntimeError, code: BridgeErrorCode) -> BridgeError {
    BridgeError::new(code, error.to_string())
}

fn provider_bridge_error(error: ProviderError) -> BridgeError {
    let code = match error.code {
        ProviderErrorCode::InvalidRequest => BridgeErrorCode::InvalidRequest,
        ProviderErrorCode::PermissionDenied => BridgeErrorCode::PermissionDenied,
        ProviderErrorCode::Timeout => BridgeErrorCode::Timeout,
        ProviderErrorCode::Cancelled => BridgeErrorCode::Cancelled,
        ProviderErrorCode::Unsupported => BridgeErrorCode::UnsupportedCapability,
    };
    let mut bridge = BridgeError::new(code, error.message);
    bridge.retryable = error.retryable;
    bridge
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn complete_engine_task<T>(
    result: Result<T, EngineError>,
    checkpoint: Result<(), EngineError>,
) -> Result<T, EngineError> {
    match (result, checkpoint) {
        (_, Err(error))
            if matches!(
                error.code,
                EngineErrorCode::Timeout
                    | EngineErrorCode::Cancelled
                    | EngineErrorCode::RequiresRestart
                    | EngineErrorCode::Interrupted
            ) =>
        {
            Err(error)
        }
        (Err(error), _) | (Ok(_), Err(error)) => Err(error),
        (Ok(values), Ok(())) => Ok(values),
    }
}

fn engine_bridge_error(error: EngineError, fallback: BridgeErrorCode) -> BridgeError {
    let code = match error.code {
        EngineErrorCode::ModuleLoad => BridgeErrorCode::ModuleLoad,
        EngineErrorCode::Call
        | EngineErrorCode::Microtasks
        | EngineErrorCode::Snapshot
        | EngineErrorCode::Interrupted => fallback,
        EngineErrorCode::Timeout => BridgeErrorCode::Timeout,
        EngineErrorCode::Cancelled => BridgeErrorCode::Cancelled,
        EngineErrorCode::RequiresRestart | EngineErrorCode::UnsupportedExecutionBudget => {
            BridgeErrorCode::Engine
        }
    };
    BridgeError::new(code, error.to_string())
}

fn is_storage_api(name: &str) -> bool {
    matches!(
        name,
        "wx.setStorage"
            | "wx.setStorageSync"
            | "wx.getStorage"
            | "wx.getStorageSync"
            | "wx.getStorageInfo"
            | "wx.getStorageInfoSync"
            | "wx.removeStorage"
            | "wx.removeStorageSync"
            | "wx.clearStorage"
            | "wx.clearStorageSync"
            | "wx.batchSetStorage"
            | "wx.batchSetStorageSync"
    )
}

fn is_observer_api(name: &str) -> bool {
    matches!(
        name,
        "wx.createIntersectionObserver" | "wx.createMediaQueryObserver"
    )
}

fn effect_continuation_stopped(message: &BridgeEnvelope) -> bool {
    message
        .payload
        .get("error")
        .is_some_and(|error| error["code"] == "ERR_TIMEOUT")
}

fn is_timer_api(name: &str) -> bool {
    matches!(
        name,
        "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval"
    )
}

fn is_navigation_api(name: &str) -> bool {
    matches!(
        name,
        "wx.navigateTo"
            | "wx.redirectTo"
            | "wx.reLaunch"
            | "wx.switchTab"
            | "wx.navigateBack"
            | "wx.preloadPage"
            | "wx.setNavigationBarTitle"
            | "wx.setNavigationBarColor"
    )
}

fn is_provider_api(name: &str) -> bool {
    matches!(
        name,
        "wx.getSystemInfoSync"
            | "wx.getSystemInfo"
            | "wx.getSystemInfoAsync"
            | "wx.getAppBaseInfo"
            | "wx.getDeviceInfo"
            | "wx.getWindowInfo"
            | "wx.getSystemSetting"
            | "wx.getMenuButtonBoundingClientRect"
            | "wx.getAccountInfoSync"
            | "wx.getExtConfigSync"
            | "wx.getExtConfig"
            | "wx.getAppAuthorizeSetting"
            | "wx.getLaunchOptionsSync"
            | "wx.getEnterOptionsSync"
            | "wx.getBatteryInfo"
            | "wx.getBatteryInfoSync"
            | "wx.getScreenBrightness"
            | "wx.setScreenBrightness"
            | "wx.authorize"
            | "wx.openSetting"
            | "wx.getSetting"
            | "wx.request"
            | "wx.uploadFile"
            | "wx.downloadFile"
            | "wx.connectSocket"
            | "wx.socketTask.send"
            | "wx.socketTask.close"
            | "wx.getFileSystemManager"
            | "wx.saveFile"
            | "wx.removeSavedFile"
            | "wx.getFileInfo"
            | "wx.getSavedFileInfo"
            | "wx.getSavedFileList"
            | "wx.canvas.draw"
            | "wx.setClipboardData"
            | "wx.getClipboardData"
            | "wx.setKeepScreenOn"
            | "wx.getNetworkType"
            | "wx.vibrateShort"
            | "wx.vibrateLong"
            | "wx.login"
            | "wx.checkSession"
            | "wx.getUserProfile"
            | "wx.requestPayment"
            | "wx.redirectToMiniProgram"
            | "wx.shareAppMessage"
            | "wx.shareTimeline"
            | "wx.chooseMedia"
            | "wx.chooseImage"
            | "wx.innerAudioContext"
            | "wx.audioContext"
            | "wx.createCameraContext"
            | "wx.cameraContext"
            | "wx.videoContext"
            | "wx.getLocation"
            | "wx.createIntersectionObserver"
            | "wx.createMediaQueryObserver"
            | "wx.startLocationUpdate"
            | "wx.stopLocationUpdate"
            | "wx.scanCode"
            | "wx.showToast"
            | "wx.hideToast"
            | "wx.showLoading"
            | "wx.hideLoading"
            | "wx.showModal"
            | "wx.showActionSheet"
            | "wx.pageScrollTo"
            | "wx.setNavigationBarColor"
            | "wx.fs.readFile"
            | "wx.fs.writeFile"
            | "wx.fs.access"
            | "wx.fs.unlink"
            | "wx.fs.readdir"
            | "wx.fs.readdirSync"
    )
}

fn is_selector_query_api(name: &str) -> bool {
    matches!(name, "wx.createSelectorQuery" | "SelectorQuery")
}

fn pin_touch_route(value: Value, route: &TouchRoute) -> Result<Value, BridgeError> {
    let mut object = object_payload(&value)?.clone();
    for key in ["x", "y", "clientX", "clientY"] {
        if let Some(value) = object.get(key) {
            let coordinate = value
                .as_f64()
                .ok_or_else(|| BridgeError::invalid("touch coordinates must be numeric"))?;
            if !(coordinate as f32).is_finite() {
                return Err(BridgeError::invalid(
                    "touch coordinates must be finite f32 values",
                ));
            }
        }
    }
    let target = route
        .nodes
        .last()
        .ok_or_else(|| BridgeError::invalid("touch route is empty"))?;
    object.insert("target".into(), json!(target.identity));
    object.insert(
        "path".into(),
        json!(route
            .nodes
            .iter()
            .map(|node| &node.identity)
            .collect::<Vec<_>>()),
    );
    for key in [
        "pageIndex",
        "page_index",
        "page_id",
        "handler",
        "handlers",
        "method",
        "ownerScopeId",
        "dataset",
        "mark",
    ] {
        object.remove(key);
    }
    if let Some(page) = route.page {
        object.insert("pageId".into(), json!(page.0));
    } else {
        object.remove("pageId");
    }
    Ok(Value::Object(object))
}

fn find_render_path<'a>(node: &'a RenderNode, id: &str) -> Option<Vec<&'a RenderNode>> {
    fn find<'a>(
        node: &'a RenderNode,
        id: &str,
        identity: bool,
        path: &mut Vec<&'a RenderNode>,
    ) -> bool {
        path.push(node);
        if (identity && node.event_identity.as_deref() == Some(id)) || (!identity && node.id == id)
        {
            return true;
        }
        for child in &node.children {
            if find(child, id, identity, path) {
                return true;
            }
        }
        path.pop();
        false
    }
    let mut path = Vec::new();
    if find(node, id, true, &mut path) || find(node, id, false, &mut path) {
        Some(path)
    } else {
        None
    }
}

fn find_render_node<'a>(node: &'a RenderNode, id: &str) -> Option<&'a RenderNode> {
    fn find<'a>(node: &'a RenderNode, id: &str, identity: bool) -> Option<&'a RenderNode> {
        if (identity && node.event_identity.as_deref() == Some(id)) || (!identity && node.id == id)
        {
            return Some(node);
        }
        node.children
            .iter()
            .find_map(|child| find(child, id, identity))
    }
    find(node, id, true).or_else(|| find(node, id, false))
}

#[derive(Debug, Default)]
struct SelectorFields {
    id: bool,
    dataset: bool,
    mark: bool,
    rect: bool,
    size: bool,
    scroll_offset: bool,
    context: bool,
    node: bool,
    geometry: Vec<String>,
    properties: Vec<String>,
    computed_style: Vec<String>,
}

/// Keep capture and eventual geometry projection on exactly the same scope.
/// A present camelCase key (including null or an invalid value) takes priority;
/// snake_case is the compatibility alias only when camelCase is absent.
fn selector_query_scope_id(query: &Map<String, Value>) -> Result<Option<&str>, BridgeError> {
    match query.get("scopeId").or_else(|| query.get("scope_id")) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(scope)) if !scope.trim().is_empty() => Ok(Some(scope.as_str())),
        _ => Err(BridgeError::invalid(
            "selector query scopeId must be a nonempty string",
        )),
    }
}

fn parse_selector_fields(value: Option<&Value>) -> Result<Option<SelectorFields>, BridgeError> {
    let Some(value) = value else { return Ok(None) };
    let mut fields = SelectorFields::default();
    match value {
        Value::Null => Ok(None),
        Value::Array(values) => {
            for field in values {
                let field = field.as_str().ok_or_else(|| {
                    BridgeError::invalid("selector query fields array must contain strings")
                })?;
                match field {
                    "id" => fields.id = true,
                    "dataset" => fields.dataset = true,
                    "mark" => fields.mark = true,
                    "rect" | "boundingClientRect" => fields.rect = true,
                    "size" => fields.size = true,
                    "scrollOffset" => fields.scroll_offset = true,
                    "context" => fields.context = true,
                    "node" => fields.node = true,
                    "left" | "top" | "right" | "bottom" | "width" | "height" | "x" | "y" => {
                        fields.geometry.push(field.to_owned())
                    }
                    other => fields.properties.push(other.to_owned()),
                }
            }
            Ok(Some(fields))
        }
        Value::Object(values) => {
            for (field, enabled) in values {
                match field.as_str() {
                    "properties" => {
                        let properties = enabled.as_array().ok_or_else(|| {
                            BridgeError::invalid(
                                "selector query fields.properties must be an array",
                            )
                        })?;
                        for property in properties {
                            fields.properties.push(
                                property.as_str().map(str::to_owned).ok_or_else(|| {
                                    BridgeError::invalid(
                                        "selector query fields.properties must contain strings",
                                    )
                                })?,
                            );
                        }
                    }
                    "computedStyle" => {
                        let styles = enabled.as_array().ok_or_else(|| {
                            BridgeError::invalid(
                                "selector query fields.computedStyle must be an array",
                            )
                        })?;
                        for style in styles {
                            fields.computed_style.push(
                                style.as_str().map(str::to_owned).ok_or_else(|| {
                                    BridgeError::invalid(
                                        "selector query fields.computedStyle must contain strings",
                                    )
                                })?,
                            );
                        }
                    }
                    name => {
                        let enabled = enabled.as_bool().ok_or_else(|| {
                            BridgeError::invalid(format!(
                                "selector query fields.{name} must be boolean"
                            ))
                        })?;
                        if !enabled {
                            continue;
                        }
                        match name {
                            "id" => fields.id = true,
                            "dataset" => fields.dataset = true,
                            "mark" => fields.mark = true,
                            "rect" | "boundingClientRect" => fields.rect = true,
                            "size" => fields.size = true,
                            "scrollOffset" => fields.scroll_offset = true,
                            "context" => fields.context = true,
                            "node" => fields.node = true,
                            "left" | "top" | "right" | "bottom" | "width" | "height" | "x"
                            | "y" => fields.geometry.push(name.to_owned()),
                            _ => {}
                        }
                    }
                }
            }
            Ok(Some(fields))
        }
        _ => Err(BridgeError::invalid(
            "selector query fields must be an array or object",
        )),
    }
}

fn selector_result(
    node: &container_render_skia::RenderNode,
    fields: Option<&SelectorFields>,
    operation: &str,
) -> Value {
    if operation == "node" {
        return json!({"node": {"type": node.tag.as_deref().unwrap_or("unknown"), "id": node.id}});
    }
    if operation == "fields" && fields.is_none() {
        return Value::Object(Map::new());
    }
    if fields.is_none() && operation != "fields" {
        let scroll = node.scroll_offset.unwrap_or_default();
        let (scroll_width, scroll_height) = node.scroll_content_extent();
        return selector_geometry::basic_selector_geometry(
            Some((
                node.attributes.get("id").map(String::as_str).unwrap_or(""),
                &node.dataset,
            )),
            [
                f64::from(node.bounds.x),
                f64::from(node.bounds.y),
                f64::from(node.bounds.width),
                f64::from(node.bounds.height),
            ],
            [f64::from(scroll.scroll_left), f64::from(scroll.scroll_top)],
            Some([f64::from(scroll_width), f64::from(scroll_height)]),
            operation,
        );
    }
    // Query extents use the same accepted native content model as scroll clamping,
    // independent of the node's current scroll offset or its display transform.
    let (scroll_width, scroll_height) = node.scroll_content_extent();
    let scroll = json!({"scrollLeft": node.scroll_offset.unwrap_or_default().scroll_left, "scrollTop": node.scroll_offset.unwrap_or_default().scroll_top,
        "scrollWidth":scroll_width,"scrollHeight":scroll_height});
    if operation == "scrollOffset" {
        let Some(fields) = fields else { return scroll };
        if fields.scroll_offset {
            return scroll;
        }
        return Value::Object(Map::new());
    }
    let rect = json!({
        "left": node.bounds.x,
        "top": node.bounds.y,
        "right": node.bounds.x + node.bounds.width,
        "bottom": node.bounds.y + node.bounds.height,
        "width": node.bounds.width,
        "height": node.bounds.height,
        "x": node.bounds.x,
        "y": node.bounds.y,
    });
    let Some(fields) = fields else {
        let mut rect = rect;
        rect.as_object_mut()
            .unwrap()
            .insert("id".into(), Value::String(node.id.clone()));
        return rect;
    };
    let mut selected = Map::new();
    let rect_object = rect.as_object().unwrap();
    if fields.id {
        selected.insert(
            "id".into(),
            Value::String(node.attributes.get("id").cloned().unwrap_or_default()),
        );
    }
    if fields.dataset {
        selected.insert(
            "dataset".into(),
            Value::Object(
                node.dataset
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
        );
    }
    if fields.mark {
        selected.insert(
            "mark".into(),
            Value::Object(
                node.mark
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect(),
            ),
        );
    }
    if fields.rect {
        selected.extend(rect_object.clone());
    }
    if fields.size {
        selected.insert("width".into(), Value::from(node.bounds.width));
        selected.insert("height".into(), Value::from(node.bounds.height));
    }
    for property in &fields.geometry {
        if let Some(value) = rect_object.get(property) {
            selected.insert(property.clone(), value.clone());
        }
    }
    if fields.scroll_offset {
        selected.insert(
            "scrollLeft".into(),
            Value::from(node.scroll_offset.unwrap_or_default().scroll_left),
        );
        selected.insert(
            "scrollTop".into(),
            Value::from(node.scroll_offset.unwrap_or_default().scroll_top),
        );
        selected.insert("scrollWidth".into(), Value::from(scroll_width));
        selected.insert("scrollHeight".into(), Value::from(scroll_height));
    }
    for property in &fields.properties {
        let value = match property.as_str() {
            "id" => node.attributes.get("id").cloned().unwrap_or_default(),
            "class" => node
                .attributes
                .get("class")
                .cloned()
                .unwrap_or_else(|| node.classes.join(" ")),
            _ => match node.attributes.get(property) {
                Some(value) => value.clone(),
                None => continue,
            },
        };
        selected.insert(property.clone(), Value::String(value));
    }
    for property in &fields.computed_style {
        let value = node
            .computed_style
            .get(property)
            .cloned()
            .or_else(|| node.computed_style.get(&camel_to_kebab(property)).cloned())
            .unwrap_or_default();
        selected.insert(property.clone(), Value::String(value));
    }
    if fields.context {
        selected.insert("context".into(), json!({"type": if node.tag.as_deref() == Some("canvas") { "canvas" } else { "unsupported-context" }, "nodeId": node.id}));
    }
    if fields.node {
        selected.insert(
            "node".into(),
            json!({"type": node.tag.as_deref().unwrap_or("unknown"), "id": node.id}),
        );
    }
    Value::Object(selected)
}

fn camel_to_kebab(value: &str) -> String {
    value.chars().fold(String::new(), |mut out, ch| {
        if ch.is_ascii_uppercase() {
            out.push('-');
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
        out
    })
}

fn reset_selector_viewport_identity(value: Value) -> Value {
    match value {
        Value::Object(mut object) => {
            if object.contains_key("id") {
                object.insert("id".into(), json!(""));
            }
            if object.contains_key("dataset") {
                object.insert("dataset".into(), json!({}));
            }
            Value::Object(object)
        }
        Value::Array(values) => Value::Array(
            values
                .into_iter()
                .map(reset_selector_viewport_identity)
                .collect(),
        ),
        other => other,
    }
}

fn parse_optional_u64(value: Option<&Value>, field: &str) -> Result<Option<u64>, BridgeError> {
    let Some(value) = value else { return Ok(None) };
    value
        .as_u64()
        .map(Some)
        .ok_or_else(|| BridgeError::invalid(format!("{field} must be an unsigned integer")))
}

fn unix_now_ns() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
        .unwrap_or(u64::MAX)
}

/// `deadlineNs` is an absolute Unix-epoch timestamp in nanoseconds. Keeping
/// the comparison at the session boundary makes every host enforce the same
/// timeout semantics before an operation mutates AppService, View or
/// Renderer state. Values beyond `u64::MAX` are treated as a future deadline.
fn deadline_expired(deadline_ns: u64) -> bool {
    let now_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
        .unwrap_or(u64::MAX);
    deadline_ns <= now_ns
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::resolve_wxss_style;
    use container_ir::{
        parse_wxml, parse_wxss, AppInfo, CompilerInfo, Component, Integrity, Module, ModuleFormat,
        ModuleScope, Style, StyleScope, Template, ViewScriptModule,
    };

    include!("async_host_tests.rs");
    include!("host_services_tests.rs");
    include!("tab_bar_tests.rs");

    #[test]
    fn view_activity_and_template_input_revisions_are_independent() {
        let mut view: ViewState = serde_json::from_value(json!({"revision":7})).unwrap();
        assert_eq!(
            view.template_revision, 0,
            "older serialized View state is accepted"
        );
        view.record_event_batch(2);
        assert_eq!(view.revision, 8);
        assert_eq!(view.event_count, 2);
        assert_eq!(view.template_revision, 0);
        view.invalidate_template();
        assert_eq!(view.revision, 9);
        assert_eq!(view.template_revision, 1);
        view.record_patches(&[DataPatch::set("value", json!(1))]);
        assert_eq!(view.revision, 10);
        assert_eq!(view.template_revision, 2);
        assert_eq!(view.pending_patches.len(), 1);
        view.record_event_batch(0);
        assert_eq!((view.revision, view.template_revision), (10, 2));
    }

    fn manifest() -> ContainerManifestV1 {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "test-commit".into(),
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
        manifest
            .capabilities
            .insert("wx.setStorage".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.setStorageSync".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.getStorage".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.getStorageSync".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.removeStorage".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.removeStorageSync".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.clearStorage".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.clearStorageSync".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.timer".into(), CapabilitySupport::Full);
        manifest.capabilities.insert(
            "wx.onNetworkStatusChange".into(),
            CapabilitySupport::Partial,
        );
        manifest
            .capabilities
            .insert("wx.createSelectorQuery".into(), CapabilitySupport::Partial);
        manifest.capabilities.insert(
            "wx.getMenuButtonBoundingClientRect".into(),
            CapabilitySupport::Partial,
        );
        manifest.capabilities.insert(
            "wx.getAppAuthorizeSetting".into(),
            CapabilitySupport::Partial,
        );
        manifest.capabilities.insert(
            "wx.createIntersectionObserver".into(),
            CapabilitySupport::Partial,
        );
        manifest.capabilities.insert(
            "wx.createMediaQueryObserver".into(),
            CapabilitySupport::Partial,
        );
        manifest
            .capabilities
            .insert("wx.createCanvasContext".into(), CapabilitySupport::Partial);
        manifest.capabilities.insert(
            "wx.createInnerAudioContext".into(),
            CapabilitySupport::Partial,
        );
        manifest
            .capabilities
            .insert("wx.createAudioContext".into(), CapabilitySupport::Partial);
        manifest
            .capabilities
            .insert("wx.createCameraContext".into(), CapabilitySupport::Partial);
        manifest
            .capabilities
            .insert("wx.cameraContext".into(), CapabilitySupport::Partial);
        manifest
            .capabilities
            .insert("wx.canvas.draw".into(), CapabilitySupport::Partial);
        manifest.capabilities.insert(
            "wx.createOffscreenCanvas".into(),
            CapabilitySupport::Partial,
        );
        manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        manifest
            .capabilities
            .insert("wx.requestPayment".into(), CapabilitySupport::Unsupported);
        manifest
            .capabilities
            .insert("wx.request".into(), CapabilitySupport::Partial);
        manifest.refresh_integrity().unwrap();
        manifest
    }

    fn session() -> Session {
        Session::new(manifest(), SessionConfig::default()).unwrap()
    }

    fn observation_frame(frame_id: u64) -> RenderFrame {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 3.0,
        };
        RenderFrame {
            images: BTreeMap::new(),
            frame_id,
            viewport,
            root: RenderNode::new("observed-root", viewport),
        }
    }

    #[test]
    fn passive_page_observation_does_not_allocate_or_manufacture_a_frame() {
        let runtime = session();
        assert!(runtime.accepted_page_observation().is_none());
        assert!(runtime.render_snapshot().is_none());
        let status = runtime.page_render_status();
        assert_eq!(status.mode, PageRenderMode::Raster);
        assert_eq!(status.backend, runtime.renderer_backend());
        assert!(!status.page_object_initialized);
        assert_eq!(status.last_render_ms, 0.0);
        assert!(!status.native_surface);
        assert!(!status.gpu_surface);
        for revision in [0, 1, u64::MAX] {
            assert_eq!(
                runtime
                    .render_target_for_revision(revision)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
        }
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        assert!(!runtime.has_metal_context());
        assert!(runtime.renderer_if_initialized().is_none());
    }

    #[test]
    fn accepted_page_observation_borrows_pixels_and_follows_renderer_replacement() {
        let mut runtime = session();
        let mut replacement = SkiaRenderer::new();
        replacement.commit(observation_frame(9001)).unwrap();
        let pixels_ptr = replacement.snapshot_ref().unwrap().pixels.as_ptr();
        let target = replacement.accepted_render_target().unwrap();
        *runtime.renderer_mut() = replacement;
        let frame_ptr = std::ptr::from_ref(runtime.renderer().last_frame().unwrap());
        let observed = runtime.accepted_page_observation().unwrap();
        assert_eq!(std::ptr::from_ref(observed.frame), frame_ptr);
        assert_eq!(observed.snapshot.unwrap().pixels.as_ptr(), pixels_ptr);
        assert_eq!(observed.target, target);
        assert_eq!(observed.render_revision, 1);
        assert_eq!(runtime.render_target_for_revision(1).unwrap(), target);
        assert!(runtime.page_render_status().page_object_initialized);
        // Raster preserves its synchronous legacy presentation contract;
        // passive observations do not change that contract or imply GPU ACK.
        assert!(runtime.is_current_frame_presented());

        // The replacement's accepted state is authoritative, including a
        // different mode and namespace. A fresh replacement alone is empty.
        let mut replacement = SkiaRenderer::new_frame_export_only();
        replacement
            .configure_render_target(observation_frame(7).viewport, 2.0)
            .unwrap();
        replacement.commit(observation_frame(7)).unwrap();
        *runtime.renderer_mut() = replacement;
        let observed = runtime.accepted_page_observation().unwrap();
        assert_eq!(observed.frame.frame_id, 7);
        assert_eq!(
            observed.target,
            RenderTargetSize {
                width: 4,
                height: 6
            }
        );
        assert!(observed.snapshot.is_none());
        assert_eq!(
            runtime.page_render_status().mode,
            PageRenderMode::ExternalFrame
        );
        assert!(!runtime.is_current_frame_presented());
        *runtime.renderer_mut() = SkiaRenderer::new();
        assert!(runtime.accepted_page_observation().is_none());
        assert_eq!(runtime.render_revision(), 0);
        assert!(runtime.page_render_status().page_object_initialized);
        assert!(!runtime.page_render_status().native_surface);
    }

    #[test]
    fn legacy_renderer_borrow_keeps_raster_manual_frame_semantics() {
        let mut runtime = session();
        runtime
            .renderer_mut()
            .commit(observation_frame(9001))
            .unwrap();
        assert!(runtime.is_current_frame_presented());
        assert!(runtime.accepted_page_observation().is_some());
        assert!(runtime.view_document().is_none());
        assert!(!runtime.has_current_skia_scene());
    }

    #[test]
    fn no_page_explicit_commits_keep_external_ack_compatibility_after_legacy_borrow() {
        let mut runtime = Session::new(
            manifest(),
            SessionConfig {
                page_render_mode: PageRenderMode::ExternalFrame,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        runtime.dispatch(request("manual-init", op::APP_INIT, json!({})));
        for frame_id in [9001, 9002] {
            let _ = runtime.renderer_mut();
            assert!(!runtime.is_current_frame_presented());
            let committed = runtime.dispatch(request(
                "manual-commit",
                op::RENDER_COMMIT,
                json!({"frame":observation_frame(frame_id)}),
            ));
            assert_eq!(committed.messages[0].payload["ok"], true);
            assert_eq!(runtime.pending_presentation, Some((None, frame_id, false)));
            let revision = runtime.render_revision();
            assert!(!runtime.is_current_frame_presented());
            runtime.acknowledge_presentation(revision).unwrap();
            assert!(runtime.is_current_frame_presented());
            assert!(runtime
                .acknowledge_presentation(revision)
                .unwrap()
                .messages
                .is_empty());
            assert!(runtime.app_service().pages().current().is_none());
        }
    }

    #[test]
    fn accepted_target_query_keeps_publication_separate_from_staged_density() {
        let mut runtime = Session::new(
            manifest(),
            SessionConfig {
                page_render_mode: PageRenderMode::ExternalFrame,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let frame = observation_frame(9001);
        runtime.renderer_mut().commit(frame.clone()).unwrap();
        let revision = runtime.render_revision();
        let accepted = runtime.render_target_for_revision(revision).unwrap();
        assert_eq!(
            accepted,
            RenderTargetSize {
                width: 2,
                height: 3
            }
        );
        assert_eq!(
            runtime
                .render_target_for_revision(frame.frame_id)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        let staged = runtime
            .renderer_mut()
            .configure_render_target(frame.viewport, 2.0)
            .unwrap();
        assert_eq!(
            staged,
            RenderTargetSize {
                width: 4,
                height: 6
            }
        );
        assert_eq!(
            runtime.render_target_for_revision(revision).unwrap(),
            accepted
        );
        let mut invalid = frame.clone();
        invalid.root.opacity = f32::NAN;
        assert!(runtime.renderer_mut().commit(invalid).is_err());
        assert_eq!(
            runtime.render_target_for_revision(revision).unwrap(),
            accepted
        );
        assert!(runtime.render_snapshot().is_some());
        assert!(runtime.capture_render_snapshot().unwrap().is_some());
        assert_eq!(
            runtime.render_target_for_revision(revision).unwrap(),
            accepted
        );
        assert!(runtime
            .accepted_page_observation()
            .unwrap()
            .snapshot
            .is_none());

        runtime.renderer_mut().commit(frame.clone()).unwrap();
        let next = runtime.accepted_page_observation().unwrap();
        assert_eq!(next.frame.frame_id, frame.frame_id);
        assert_eq!(next.render_revision, revision + 1);
        assert_eq!(next.target, staged);
        assert_eq!(
            runtime
                .render_target_for_revision(revision)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
    }

    #[test]
    fn unverified_render_resources_cannot_be_reused_or_cloned_across_sessions() {
        let bytes = b"unverified".to_vec();
        let mut first = session();
        first.render_blobs = Arc::new(BTreeMap::from([(
            format!("sha256:{}", container_ir::hex_digest(&bytes)),
            bytes,
        )]));
        let payload = json!({"useSessionResources":true});
        let payload = payload.as_object().unwrap();
        assert!(!first.can_reuse_render_resources());
        assert_eq!(
            first.render_resources(payload).unwrap_err().code,
            BridgeErrorCode::Render
        );

        first.render_resources_verified = true;
        assert!(first.can_reuse_render_resources());
        let resources = first.render_resources(payload).unwrap();
        assert!(Arc::ptr_eq(&first.render_blobs, &resources));
        let second = session();
        assert!(!second.can_reuse_render_resources());
        assert_eq!(
            second.render_resources(payload).unwrap_err().code,
            BridgeErrorCode::Render
        );
        assert!(!Arc::ptr_eq(&first.render_blobs, &second.render_blobs));
    }

    #[test]
    fn host_viewport_resize_validates_and_deduplicates_actual_geometry() {
        let mut session = session();
        assert!(session.notify_viewport_resize(320, 640).is_err());
        session.dispatch(request("init", op::APP_INIT, json!({})));
        let changed = session.notify_viewport_resize(320, 640).unwrap();
        assert_eq!(changed.messages[0].payload["type"], "host.resize");
        assert_eq!(session.config().host.window_width, 320);
        assert!(session
            .notify_viewport_resize(320, 640)
            .unwrap()
            .messages
            .is_empty());
        assert!(session.notify_viewport_resize(0, 640).is_err());
        assert_eq!(session.config().host.window_width, 320);
        assert_eq!(session.config().host.window_height, 640);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_host_viewport_resize_updates_sync_provider_before_page_hook(engine: EngineKind) {
        let source = br#"
            App({});
            Page({data:{calls:0}, onResize: function(event) {
                var window = wx.getWindowInfo();
                this.setData({calls:this.data.calls+1,width:window.windowWidth,height:window.windowHeight,
                    size:event.size,orientation:event.deviceOrientation});
            }});
        "#;
        let mut manifest = manifest();
        manifest
            .capabilities
            .insert("wx.getWindowInfo".into(), CapabilitySupport::Partial);
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        manifest.routes.push(container_ir::Route {
            id: "route:home".into(),
            path: "pages/home/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "app.js".into(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js", "source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let push = session.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path":"pages/home/index"}),
        ));
        assert_eq!(push.messages[0].payload["ok"], true);
        let resized = session.notify_viewport_resize(800, 400).unwrap();
        assert!(
            !resized
                .messages
                .iter()
                .any(|message| message.op == op::ERROR),
            "{resized:?}"
        );
        let page = session.app_service().pages().current().unwrap();
        assert_eq!(page.data["calls"], 1);
        assert_eq!(page.data["width"], 800);
        assert_eq!(page.data["height"], 400);
        assert_eq!(
            page.data["size"],
            json!({"windowWidth":800,"windowHeight":400})
        );
        assert_eq!(page.data["orientation"], "landscape");
        assert!(session
            .notify_viewport_resize(800, 400)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(
            session.app_service().pages().current().unwrap().data["calls"],
            1
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_host_viewport_resize_updates_sync_provider_before_page_hook() {
        assert_host_viewport_resize_updates_sync_provider_before_page_hook(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_host_viewport_resize_updates_sync_provider_before_page_hook() {
        assert_host_viewport_resize_updates_sync_provider_before_page_hook(EngineKind::V8);
    }

    fn module_manifest(source: &[u8], format: ModuleFormat) -> ContainerManifestV1 {
        let mut manifest = manifest();
        manifest.modules.push(Module {
            id: "module:app".into(),
            sha256: container_ir::hex_digest(source),
            format,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        manifest.refresh_integrity().unwrap();
        manifest
    }

    fn view_script_manifest(source: &[u8]) -> ContainerManifestV1 {
        let mut manifest = manifest();
        manifest.view_scripts.push(ViewScriptModule {
            id: "wxs:shared/format.wxs".into(),
            sha256: container_ir::hex_digest(source),
            dependencies: Vec::new(),
        });
        manifest.refresh_integrity().unwrap();
        manifest
    }

    fn assert_view_scripts_never_enter_app_service(engine: EngineKind) {
        let wxs = b"wx.setStorageSync('wxs-executed', true); module.exports = {};";
        let app = b"wx.setStorageSync('app-executed', true); App({});";
        let mut manifest = view_script_manifest(wxs);
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(app),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        manifest.refresh_integrity().unwrap();
        let mut runtime = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();

        // A mixed module batch must fail before registering or evaluating
        // even the valid AppService entry that precedes the View script.
        let mixed = runtime
            .load_modules_value(&json!([
                {"id":"module:app.js", "bytes":app.as_slice()},
                {"id":"wxs:shared/format.wxs", "bytes":wxs.as_slice()}
            ]))
            .unwrap_err();
        assert_eq!(mixed.code, BridgeErrorCode::ModuleLoad);
        assert!(runtime.loaded_modules.is_empty());

        let pointer = format!("sha256:{}", container_ir::hex_digest(wxs));
        let response = runtime.dispatch(request(
            "wxs-init",
            op::APP_INIT,
            json!({
                "blobs": {&pointer:wxs.as_slice()},
                "modules":[{"id":"module:app.js", "bytes":app.as_slice()}]
            }),
        ));
        if runtime.engine_provider_available() {
            // Preparing the isolated View registry must not evaluate WXS or
            // expose its source as an AppService module. App initialization
            // remains available until a View document actually calls WXS.
            assert_eq!(response.messages[0].payload["ok"], true);
            assert!(runtime.initialized());
            assert!(runtime.app_launch_invoked);
            assert_eq!(runtime.loaded_modules.len(), 1);
            assert_eq!(
                runtime.app_service.storage().get("app-executed"),
                Some(&json!(true))
            );
            assert_eq!(runtime.app_service.storage().get("wxs-executed"), None);
        } else {
            assert_eq!(response.messages[0].payload["error"]["code"], "ERR_ENGINE");
            assert!(!runtime.initialized());
            assert!(runtime.loaded_modules.is_empty());
            assert!(runtime.app_service.storage().is_empty());
        }
        assert_eq!(runtime.render_blobs.get(&pointer).unwrap().as_slice(), wxs);
        assert!(runtime.skia_backend.renderer.last_frame().is_none());
    }

    #[test]
    fn quickjs_view_scripts_are_verified_without_app_service_execution() {
        assert_view_scripts_never_enter_app_service(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_view_scripts_are_verified_without_app_service_execution() {
        assert_view_scripts_never_enter_app_service(EngineKind::V8);
    }

    #[test]
    fn view_script_sources_require_present_correct_hash_and_utf8_bytes() {
        for (source, supplied) in [
            (b"module.exports = {};".as_slice(), None),
            (
                b"module.exports = {};".as_slice(),
                Some(b"different content".as_slice()),
            ),
            ([255_u8, 254].as_slice(), Some([255_u8, 254].as_slice())),
        ] {
            let mut runtime =
                Session::new(view_script_manifest(source), SessionConfig::default()).unwrap();
            let pointer = format!("sha256:{}", container_ir::hex_digest(source));
            let blobs = supplied
                .map(|bytes| json!({pointer:bytes}))
                .unwrap_or_else(|| json!({}));
            let response = runtime.dispatch(request(
                "invalid-view-source",
                op::APP_INIT,
                json!({"blobs":blobs}),
            ));
            assert_eq!(response.messages[0].payload["error"]["code"], "ERR_RENDER");
            assert!(!runtime.initialized());
            assert!(runtime.render_blobs.is_empty());
            assert!(runtime.loaded_modules.is_empty());
        }
    }

    #[test]
    fn legacy_external_wxs_assets_require_verified_content_before_unsupported() {
        let source = b"wx.setStorageSync('legacy-wxs-executed', true);";
        let pointer = format!("sha256:{}", container_ir::hex_digest(source));
        let mut manifest = manifest();
        manifest.assets.push(container_ir::Asset {
            path: "shared/legacy.wxs".into(),
            sha256: container_ir::hex_digest(source),
            mime: "application/javascript".into(),
            size: source.len() as u64,
        });
        manifest.refresh_integrity().unwrap();
        for (blobs, expected_code) in [
            (json!({}), "ERR_RENDER"),
            (
                json!({&pointer:source.as_slice()}),
                "ERR_UNSUPPORTED_CAPABILITY",
            ),
        ] {
            let mut runtime = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
            let response = runtime.dispatch(request(
                "legacy-external-wxs",
                op::APP_INIT,
                json!({"blobs":blobs}),
            ));
            assert_eq!(response.messages[0].payload["error"]["code"], expected_code);
            assert!(!runtime.initialized());
            assert!(runtime.loaded_modules.is_empty());
            assert!(runtime.app_service.storage().is_empty());
        }
    }

    fn legacy_wxs_manifest() -> (ContainerManifestV1, String, Vec<u8>) {
        // Keep the declaration under a false branch and inside an unused
        // named template: evaluated output must not hide unsupported source.
        let wxml = parse_wxml(
            "<view wx:if=\"{{false}}\"><template name=\"hidden\"><wxs module=\"format\">module.exports = {};</wxs></template></view><view>safe</view>",
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
        let mut manifest = manifest();
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: pointer.clone(),
            bindings: Vec::new(),
            wxs_modules: BTreeMap::new(),
        });
        manifest.refresh_integrity().unwrap();
        (manifest, pointer, wxml)
    }

    #[test]
    fn legacy_wxs_is_rejected_before_app_init_and_component_evaluation() {
        let (manifest, pointer, wxml) = legacy_wxs_manifest();
        let mut runtime = Session::new(manifest, SessionConfig::default()).unwrap();
        let response = runtime.dispatch(request(
            "legacy-wxs-init",
            op::APP_INIT,
            json!({"blobs": {&pointer:&wxml}}),
        ));
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert!(!runtime.initialized());
        let blobs = BTreeMap::from([(pointer, wxml)]);
        assert_eq!(
            runtime.component_templates(&blobs).unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
        runtime.render_blobs = Arc::new(blobs);
        assert_eq!(
            runtime.prepare_page_components(PageId(1)).unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
        assert!(runtime.component_pages.is_empty());
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn compiled_view_registry_is_validated_before_appservice_startup() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/isolated-view-render/golden-program.json"
        ))
        .unwrap();
        let original: ContainerManifestV1 =
            serde_json::from_value(fixture["manifest"].clone()).unwrap();
        let original_blobs: BTreeMap<String, Vec<u8>> = fixture["blobs"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(hash, source)| {
                (
                    format!("sha256:{hash}"),
                    source.as_str().unwrap().as_bytes().to_vec(),
                )
            })
            .collect();
        for engine in [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ] {
            for invalid in [
                "missing-expression",
                "invalid-executable",
                "missing-ast",
                "tampered-ast",
            ] {
                let mut manifest = original.clone();
                let mut blobs = original_blobs.clone();
                let document = &mut manifest.view_compilation.as_mut().unwrap().documents[0];
                match invalid {
                    "missing-expression" => document.expressions.clear(),
                    "invalid-executable" => {
                        let bytes = b"(".to_vec();
                        let hash = container_ir::hex_digest(&bytes);
                        document.expressions[0].executable_sha256 = hash.clone();
                        blobs.insert(format!("sha256:{hash}"), bytes);
                    }
                    "missing-ast" => {
                        blobs.remove(&document.wxml_ast);
                    }
                    "tampered-ast" => {
                        blobs.insert(document.wxml_ast.clone(), b"{}".to_vec());
                    }
                    _ => unreachable!(),
                }
                manifest.refresh_integrity().unwrap();
                let modules = manifest
                    .modules
                    .iter()
                    .map(|module| {
                        json!({
                            "id": module.id,
                            "bytes": original_blobs[&format!("sha256:{}", module.sha256)],
                        })
                    })
                    .collect::<Vec<_>>();
                let mut runtime = Session::new(
                    manifest,
                    SessionConfig {
                        engine,
                        ..SessionConfig::default()
                    },
                )
                .unwrap();
                let response = runtime.dispatch(request(
                    invalid,
                    op::APP_INIT,
                    json!({
                        "blobs": blobs, "modules": modules,
                    }),
                ));
                assert_eq!(
                    response.messages[0].payload["ok"], false,
                    "{engine:?}/{invalid}"
                );
                assert!(!runtime.initialized(), "{engine:?}/{invalid}");
                assert!(
                    runtime.loaded_modules.is_empty(),
                    "AppService evaluated for {engine:?}/{invalid}"
                );
                assert!(!runtime.app_launch_invoked);
                assert!(runtime.app_service.storage().is_empty());
            }
        }
    }

    #[test]
    fn legacy_wxs_render_rejection_retains_the_previous_frame() {
        let (manifest, pointer, wxml) = legacy_wxs_manifest();
        let mut runtime = Session::new(manifest, SessionConfig::default()).unwrap();
        let initialized = runtime.dispatch(request("init", op::APP_INIT, json!({})));
        assert_eq!(initialized.messages[0].payload["ok"], true);
        commit_pointer_input_test_frame(&mut runtime);
        let previous = runtime.skia_backend.renderer.last_frame().unwrap().clone();
        let response = runtime.dispatch(request(
            "legacy-wxs-render",
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml", "frameId":2,
                "blobs": {pointer:wxml}
            }),
        ));
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(
            runtime.skia_backend.renderer.last_frame().unwrap(),
            &previous
        );
        assert_eq!(runtime.view.last_frame_id, Some(1));
        assert!(runtime.component_pages.is_empty());
    }

    #[test]
    fn v8_selection_requires_the_native_provider_feature() {
        let config = SessionConfig {
            engine: EngineKind::V8,
            ..SessionConfig::default()
        };
        let result = Session::new(manifest(), config);
        #[cfg(feature = "v8-native")]
        {
            let session = result.expect("v8-native must construct a V8 session");
            assert!(session.engine_provider_available());
        }
        #[cfg(not(feature = "v8-native"))]
        {
            assert!(matches!(
                result,
                Err(SessionError::EngineUnavailable {
                    engine: EngineKind::V8
                })
            ));
        }
    }

    #[test]
    fn init_reports_provider_availability_without_fallback() {
        let mut session = session();
        let batch = session.dispatch(request("provider", op::APP_INIT, json!({})));
        assert_eq!(
            batch.messages[0].payload["engineProviderAvailable"],
            cfg!(feature = "quickjs-native")
        );
    }

    #[test]
    fn provider_capabilities_negotiate_with_manifest_and_can_i_use() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.getSystemInfoSync".into(), CapabilitySupport::Full);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request("provider-capabilities", op::APP_INIT, json!({})));
        assert_eq!(
            init.messages[0].payload["capabilities"]["wx.getSystemInfoSync"],
            "partial"
        );
        let query = session.dispatch(request(
            "capability-query",
            op::API_CALL,
            json!({"name": "wx.canIUse", "capability": "wx.getSystemInfoSync"}),
        ));
        assert_eq!(query.messages[0].payload["result"], true);
        assert_eq!(query.messages[0].payload["support"], "partial");
    }

    #[test]
    fn launch_options_are_session_state_and_sync_api_uses_app_init_value() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.getLaunchOptionsSync".into(), CapabilitySupport::Partial);
        app_manifest
            .capabilities
            .insert("wx.getEnterOptionsSync".into(), CapabilitySupport::Partial);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "launch-options-init",
            op::APP_INIT,
            json!({"launchOptions": {"path": "pages/home/index", "query": {"ref": "share"}, "scene": 1044}}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let call = session.dispatch(request(
            "launch-options-call",
            op::API_CALL,
            json!({"name": "wx.getLaunchOptionsSync"}),
        ));
        assert_eq!(
            call.messages[0].payload["result"],
            json!({"path": "pages/home/index", "query": {"ref": "share"}, "scene": 1044})
        );
        let enter_call = session.dispatch(request(
            "enter-options-call",
            op::API_CALL,
            json!({"name": "wx.getEnterOptionsSync"}),
        ));
        assert_eq!(
            enter_call.messages[0].payload["result"],
            json!({"path": "pages/home/index", "query": {"ref": "share"}, "scene": 1044})
        );
        let invalid = session.dispatch(request(
            "launch-options-invalid",
            op::APP_INIT,
            json!({"launchOptions": "invalid"}),
        ));
        assert_eq!(invalid.messages[0].payload["ok"], false);
        let after_invalid = session.dispatch(request(
            "launch-options-after-invalid",
            op::API_CALL,
            json!({"name": "wx.getLaunchOptionsSync"}),
        ));
        assert_eq!(
            after_invalid.messages[0].payload["result"],
            json!({"path": "pages/home/index", "query": {"ref": "share"}, "scene": 1044})
        );
    }

    #[test]
    fn module_load_rejects_missing_provider_instead_of_falling_back() {
        let source = b"exports.add = (left, right) => left + right";
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig::default(),
        )
        .unwrap();
        let batch = session.dispatch(request(
            "provider-module",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":"exports.add = (left, right) => left + right"}]}),
        ));
        #[cfg(not(feature = "quickjs-native"))]
        {
            assert_eq!(batch.messages.len(), 1);
            assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_ENGINE");
            assert!(!session.initialized());
            assert!(session.loaded_modules.is_empty());
        }
        #[cfg(feature = "quickjs-native")]
        {
            assert_eq!(batch.messages[0].payload["ok"], true);
            let call = session.dispatch(request(
                "provider-call",
                op::MODULE_CALL,
                json!({"moduleId":"module:app","export":"add","args":[2,3]}),
            ));
            assert_eq!(call.messages[0].payload["result"], json!([5]));
        }
    }

    #[cfg(not(feature = "quickjs-native"))]
    #[test]
    fn lazy_module_load_without_provider_preserves_validation_error_precedence() {
        let source = b"exports.answer = 42;";
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig::default(),
        )
        .unwrap();
        let init = session.dispatch(request("headless-init", op::APP_INIT, json!({})));
        assert_eq!(init.messages[0].payload["ok"], true);

        for module in [
            json!({"id":"module:unknown", "source":String::from_utf8_lossy(source)}),
            json!({"id":"module:app", "source":"exports.answer = 43;"}),
        ] {
            let invalid = session.dispatch(request(
                "invalid-lazy-module",
                op::MODULE_LOAD,
                json!({"modules":[module]}),
            ));
            assert_eq!(
                invalid.messages[0].payload["error"]["code"],
                "ERR_MODULE_LOAD"
            );
        }
        let unavailable = session.dispatch(request(
            "valid-lazy-module",
            op::MODULE_LOAD,
            json!({"modules":[{"id":"module:app", "source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(
            unavailable.messages[0].payload["error"]["code"],
            "ERR_ENGINE"
        );
        assert!(session.initialized());
        assert!(session.loaded_modules.is_empty());
        assert_eq!(
            session
                .evaluate_engine_module("module:app")
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_native_module_failures_keep_module_load_code(engine: EngineKind) {
        for (source, format) in [
            (&b"exports.broken = (;"[..], ModuleFormat::Commonjs),
            (&b"{\"broken\":}"[..], ModuleFormat::Json),
        ] {
            let earlier = b"wx.setStorageSync('preflight-side-effect', true);";
            let mut manifest = module_manifest(source, format);
            manifest.modules.push(Module {
                id: "module:aaa".into(),
                sha256: container_ir::hex_digest(earlier),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: Vec::new(),
            });
            manifest.refresh_integrity().unwrap();
            let mut session = Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..SessionConfig::default()
                },
            )
            .unwrap();
            let rejected = session.dispatch(request(
                "invalid-native-module-batch",
                op::APP_INIT,
                json!({"modules":[
                    {"id":"module:aaa", "source":String::from_utf8_lossy(earlier)},
                    {"id":"module:app", "source":String::from_utf8_lossy(source)}
                ]}),
            ));
            assert_eq!(
                rejected.messages[0].payload["error"]["code"],
                "ERR_MODULE_LOAD"
            );
            assert!(!session.initialized());
            assert!(session.loaded_modules.is_empty());
            assert!(!session
                .app_service()
                .storage()
                .contains_key("preflight-side-effect"));
        }

        // Syntax-valid code can still throw while its root is evaluated.
        let source = b"throw new Error('module-evaluation-failed');";
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let rejected = session.dispatch(request(
            "throwing-native-module",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app", "source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(
            rejected.messages[0].payload["error"]["code"],
            "ERR_MODULE_LOAD"
        );
        assert!(!session.initialized());
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_module_syntax_and_evaluation_errors_keep_module_load_code() {
        assert_native_module_failures_keep_module_load_code(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_module_syntax_and_evaluation_errors_keep_module_load_code() {
        assert_native_module_failures_keep_module_load_code(EngineKind::V8);
    }

    #[test]
    fn canvas_provider_draw_commits_a_real_surface_snapshot() {
        let mut session = session();
        assert!(session.renderer_if_initialized().is_none());
        let init = session.dispatch(request("canvas-init", op::APP_INIT, json!({})));
        assert_eq!(init.messages[0].payload["ok"], true);
        let draw = session.dispatch(request(
            "canvas-draw",
            op::API_CALL,
            json!({
                "name": "wx.canvas.draw",
                "canvasId": "main",
                "width": 2,
                "height": 1,
                "commands": [
                    {"op": "setFillStyle", "args": ["#ff0000"]},
                    {"op": "fillRect", "args": [0, 0, 1, 1]}
                ]
            }),
        ));
        assert_eq!(draw.messages[0].payload["ok"], true);
        assert_eq!(draw.messages[0].payload["result"]["surface"]["width"], 2);
        let snapshot = session
            .canvas_snapshot("main")
            .expect("canvas surface committed");
        assert_eq!(
            (snapshot.frame_id, snapshot.width, snapshot.height),
            (1, 2, 1)
        );
        assert_eq!(&snapshot.pixels, &[255, 0, 0, 255, 0, 0, 0, 0]);
        assert!(session.renderer_if_initialized().is_none());
        assert_eq!(session.render_revision(), 0);
        assert!(session.accepted_page_observation().is_none());
        assert!(!session.page_render_status().page_object_initialized);
        assert!(session.render_target_for_revision(1).is_err());
    }

    #[test]
    fn canvas_lifetime_survives_presentation_reload_and_resets_with_a_new_session(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let config = SessionConfig {
            browser_view_enabled: true,
            renderer_override: Some(container_ir::RendererProfile::WebView),
            page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
            ..SessionConfig::default()
        };
        let mut runtime = Session::new(manifest(), config.clone())?;
        let init = runtime.dispatch(request("canvas-lifetime-init", op::APP_INIT, json!({})));
        assert_eq!(init.messages[0].payload["ok"], true);
        let response = runtime.dispatch(request("canvas-lifetime-draw", op::API_CALL, json!({
            "name":"wx.canvas.draw", "canvasId":"retained", "width":1, "height":1,
            "commands":[{"op":"setFillStyle","args":["red"]},{"op":"fillRect","args":[0,0,1,1]}],
        })));
        assert_eq!(response.messages[0].payload["ok"], true);
        let before = runtime.canvas_snapshot("retained");
        assert!(before.is_some());
        assert!(runtime.renderer_if_initialized().is_none());
        let sequence = runtime.canvas_frame_sequence;
        let mut replacement = runtime.manifest().clone();
        replacement.assets.push(container_ir::Asset {
            path: "development.txt".into(),
            sha256: container_ir::hex_digest(b""),
            mime: "text/plain".into(),
            size: 0,
        });
        replacement.refresh_integrity()?;
        runtime.replace_manifest(replacement.clone())?;
        assert_eq!(runtime.canvas_snapshot("retained"), before);
        assert_eq!(runtime.canvas_frame_sequence, sequence);
        assert!(runtime.renderer_if_initialized().is_none());
        let restarted = Session::new(replacement, config)?;
        assert!(restarted.canvas_snapshot("retained").is_none());
        assert_eq!(restarted.canvas_frame_sequence, 0);
        assert!(restarted.renderer_if_initialized().is_none());
        Ok(())
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn esm_module_load_supports_static_exports_without_silent_commonjs_fallback() {
        let source = b"export const add = (left, right) => left + right;";
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Esm),
            SessionConfig::default(),
        )
        .unwrap();
        let init = session.dispatch(request(
            "esm-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let call = session.dispatch(request(
            "esm-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"add","args":[4,9]}),
        ));
        assert_eq!(call.messages[0].payload["result"], json!([13]));
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn esm_dependency_manifest(app_source: &[u8], dep_source: &[u8]) -> ContainerManifestV1 {
        let mut manifest = manifest();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.extend([
            Module {
                id: "module:app.js".into(),
                sha256: container_ir::hex_digest(app_source),
                format: ModuleFormat::Esm,
                scope: ModuleScope::App,
                dependencies: vec!["module:dep.js".into()],
            },
            Module {
                id: "module:dep.js".into(),
                sha256: container_ir::hex_digest(dep_source),
                format: ModuleFormat::Esm,
                scope: ModuleScope::App,
                dependencies: Vec::new(),
            },
        ]);
        manifest.refresh_integrity().unwrap();
        manifest
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn esm_imports_and_re_exports_are_loaded_in_dependency_order() {
        let dep = br#"
            export const answer = 41;
            export function plus(value) { return value + 1; }
            export default plus;
        "#;
        let app = br#"
            import plus, { answer as value } from "./dep.js";
            export { plus as increment } from "./dep.js";
            export const evaluate = (input) => plus(input) + value;
        "#;
        let mut session =
            Session::new(esm_dependency_manifest(app, dep), SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "esm-dependency-init",
            op::APP_INIT,
            json!({
                "modules": [
                    {"id": "module:app.js", "source": String::from_utf8_lossy(app)},
                    {"id": "module:dep.js", "source": String::from_utf8_lossy(dep)}
                ]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        assert_eq!(init.messages[0].payload["loadedModules"], 2);
        let evaluate = session.dispatch(request(
            "esm-import-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"evaluate","args":[1]}),
        ));
        assert_eq!(evaluate.messages[0].payload["result"], json!([43]));
        let increment = session.dispatch(request(
            "esm-re-export-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"increment","args":[4]}),
        ));
        assert_eq!(increment.messages[0].payload["result"], json!([5]));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn esm_default_import_without_named_clause_is_supported() {
        let dep = br#"export default 41;"#;
        let app = br#"import value from './dep.js'; export const answer = () => value + 1;"#;
        let mut session =
            Session::new(esm_dependency_manifest(app, dep), SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "esm-default-init",
            op::APP_INIT,
            json!({
                "modules": [
                    {"id": "module:app.js", "source": String::from_utf8_lossy(app)},
                    {"id": "module:dep.js", "source": String::from_utf8_lossy(dep)}
                ]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let call = session.dispatch(request(
            "esm-default-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"answer","args":[]}),
        ));
        assert_eq!(call.messages[0].payload["result"], json!([42]));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_uses_the_same_static_esm_dependency_contract() {
        let dep = br#"export const answer = 41; export function plus(value) { return value + 1; }"#;
        let app = br#"import { answer, plus } from './dep.js'; export const evaluate = (input) => plus(input) + answer;"#;
        let mut session = Session::new(
            esm_dependency_manifest(app, dep),
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-esm-init",
            op::APP_INIT,
            json!({
                "modules": [
                    {"id": "module:app.js", "source": String::from_utf8_lossy(app)},
                    {"id": "module:dep.js", "source": String::from_utf8_lossy(dep)}
                ]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let call = session.dispatch(request(
            "v8-esm-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"evaluate","args":[1]}),
        ));
        assert_eq!(call.messages[0].payload["result"], json!([43]));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn esm_export_star_is_rejected_with_module_load_error() {
        let dep = br#"export const answer = 41;"#;
        let app = br#"export * from './dep.js';"#;
        let mut session =
            Session::new(esm_dependency_manifest(app, dep), SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "esm-unsupported-init",
            op::APP_INIT,
            json!({
                "modules": [
                    {"id": "module:app.js", "source": String::from_utf8_lossy(app)},
                    {"id": "module:dep.js", "source": String::from_utf8_lossy(dep)}
                ]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], false);
        assert_eq!(init.messages[0].payload["error"]["code"], "ERR_MODULE_LOAD");
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn app_init_executes_registered_app_on_launch_once() {
        let source = br#"App({ onLaunch(options) { return options.scene; } });
            Page({ onLoad(query) { return query.id; }, onShow() { return "shown"; }, onReady() { return "ready"; }, onUnload() { return "gone"; } });"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "app-init",
            op::APP_INIT,
            json!({
                "launchOptions": {"scene": 1001},
                "modules": [{"id":"module:app.js", "source": String::from_utf8_lossy(source)}]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        assert_eq!(init.messages[0].payload["appLaunchInvoked"], true);
        assert_eq!(init.messages[0].payload["appLaunchResult"], 1001);
        assert_eq!(init.messages[0].payload["registration"]["app"], true);
        assert_eq!(init.messages[0].payload["registration"]["pages"], 1);

        let pushed = session.dispatch(request(
            "page-push",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index", "query":{"id":7}}),
        ));
        assert_eq!(pushed.messages[0].payload["hooks"]["onLoad"], "7");
        assert_eq!(pushed.messages[0].payload["hooks"]["onShow"], "shown");
        assert_eq!(pushed.messages[0].payload["hooks"]["onReady"], "ready");
        let popped = session.dispatch(request("page-pop", op::PAGE_POP, json!({})));
        assert_eq!(popped.messages[0].payload["hooks"]["onUnload"], "gone");

        let second = session.dispatch(request(
            "app-init-again",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(second.messages[0].payload["appLaunchInvoked"], true);
        assert_eq!(second.messages[0].payload["appLaunchResult"], Value::Null);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_lifecycle_hooks_and_event_batch_call_registered_page_methods() {
        let source = br#"
            App({
                onHide() { return "app-hidden"; },
                onShow() { return "app-shown"; }
            });
            Page({
                data: { tapped: 0 },
                onHide() { return "page-hidden"; },
                onShow() { return "page-shown"; },
                onTap(event) {
                    this.setData({ tapped: event.currentTarget.dataset.id });
                    return event.currentTarget.dataset.id;
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        session.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));

        let hide = session.dispatch(request(
            "hide",
            op::APP_LIFECYCLE,
            json!({"event": "launch"}),
        ));
        assert_eq!(hide.messages[0].payload["hooks"]["onLaunch"], Value::Null);
        let hide = session.dispatch(request(
            "hide-2",
            op::APP_LIFECYCLE,
            json!({"event": "hide"}),
        ));
        assert_eq!(hide.messages[0].payload["hooks"]["onHide"], "app-hidden");
        let show = session.dispatch(request("show", op::APP_LIFECYCLE, json!({"event": "show"})));
        assert_eq!(show.messages[0].payload["hooks"]["onShow"], "app-shown");

        let event = session.dispatch(request(
            "tap",
            op::EVENT_BATCH,
            json!({
                "events": [{
                    "type": "tap",
                    "target": "button",
                    "path": ["root", "button"],
                    "handler": "onTap",
                    "pageIndex": 0,
                    "dataset": {"id": 7},
                    "detail": {"x": 1}
                }]
            }),
        ));
        assert_eq!(event.messages[0].payload["hooks"][0][0]["result"], 7);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["tapped"],
            7
        );
        assert!(event
            .messages
            .iter()
            .any(|message| message.op == op::EVENT_BATCH));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_event_batch_applies_stop_propagation_and_prevent_default() {
        let source = br#"
            Page({
                onRoot(event) { return event.defaultPrevented; },
                onPanel(event) { return event.defaultPrevented; },
                onButton(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    return { defaultPrevented: event.defaultPrevented, cancelBubble: event.cancelBubble };
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "event-control-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "event-control-page",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));
        let event = session.dispatch(request(
            "event-control-dispatch",
            op::EVENT_BATCH,
            json!({"events": [{
                "type": "tap",
                "target": "button",
                "path": ["root", "panel", "button"],
                "capture": true,
                "bubbles": true,
                "handlers": {"root": "onRoot", "panel": "onPanel", "button": "onButton"},
                "pageIndex": 0
            }]}),
        ));
        assert_eq!(
            event.messages[0].payload["dispatches"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["propagationStopped"],
            true
        );
        assert_eq!(event.messages[0].payload["hooks"][0][2]["dispatchIndex"], 2);
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["result"]["defaultPrevented"],
            true
        );
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["result"]["cancelBubble"],
            true
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_app_show_listener_receives_lifecycle_options() {
        let source = br#"
            wx.onAppShow(function(options) { globalThis.__scene = options.scene; });
            App({ onShow(options) { return options.scene; } });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest
            .capabilities
            .insert("wx.onAppShow".into(), CapabilitySupport::Full);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "listener-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let launch = session.dispatch(request(
            "listener-launch",
            op::APP_LIFECYCLE,
            json!({"event": "launch"}),
        ));
        assert_eq!(launch.messages[0].payload["ok"], true);
        assert_eq!(launch.messages[0].payload["hooks"]["onShow"], 1001);
        let hide = session.dispatch(request(
            "listener-hide",
            op::APP_LIFECYCLE,
            json!({"event": "hide"}),
        ));
        assert_eq!(hide.messages[0].payload["ok"], true);
        let show = session.dispatch(request(
            "listener-show",
            op::APP_LIFECYCLE,
            json!({"event": "show", "options": {"scene": 1007}}),
        ));
        assert_eq!(show.messages[0].payload["hooks"]["onShow"], 1007);
        assert!(show.messages.iter().any(|message| {
            message.op == op::EVENT_BATCH
                && message.payload["effects"]
                    .as_array()
                    .is_some_and(|effects| {
                        effects.iter().any(|effect| {
                            effect["events"].as_array().is_some_and(|events| {
                                events.iter().any(|event| event["type"] == "app.listener")
                            })
                        })
                    })
        }));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_component_bridge_mount_update_unmount_preserves_lifecycle_and_properties() {
        let source = br#"
            Component({
                data: { count: 0 },
                properties: { title: { type: String, value: 'default' } },
                observers: { 'title, count': function(title, count) { this.observed = [title, count]; } },
                lifetimes: {
                    created() { this.createdMarker = true; },
                    attached() { this.attachedMarker = true; },
                    ready() { this.readyMarker = true; },
                    detached() { this.detachedMarker = true; }
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "component-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let mount = session.dispatch(request(
            "component-mount",
            op::COMPONENT_MOUNT,
            json!({"componentIndex": 0, "properties": {"title": "first", "count": 1}}),
        ));
        assert_eq!(mount.messages[0].payload["ok"], true);
        assert_eq!(
            mount.messages[0].payload["instance"]["snapshot"]["lifecycle"],
            json!(["created", "attached", "ready"])
        );
        assert_eq!(
            mount.messages[0].payload["instance"]["snapshot"]["properties"]["title"],
            "first"
        );
        let update = session.dispatch(request(
            "component-update",
            op::COMPONENT_UPDATE,
            json!({"componentIndex": 0, "properties": {"title": "second", "count": 2}}),
        ));
        assert_eq!(
            update.messages[0].payload["instance"]["changes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(update.messages.iter().any(|message| {
            message.op == op::EVENT_BATCH
                && message.payload["effects"]
                    .as_array()
                    .is_some_and(|effects| {
                        effects.iter().any(|effect| {
                            effect["events"].as_array().is_some_and(|events| {
                                events
                                    .iter()
                                    .any(|event| event["type"] == "component.property.patch")
                            })
                        })
                    })
        }));
        let unmount = session.dispatch(request(
            "component-unmount",
            op::COMPONENT_UNMOUNT,
            json!({"componentIndex": 0}),
        ));
        assert_eq!(
            unmount.messages[0].payload["instance"]["snapshot"]["lifecycle"],
            json!(["created", "attached", "ready", "detached"])
        );
        assert_eq!(
            unmount.messages[0].payload["instance"]["snapshot"]["mounted"],
            false
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_lifecycle_hooks_and_event_batch_call_registered_page_methods() {
        let source = br#"
            Page({
                data: { tapped: 0 },
                onReady() { return "ready"; },
                onTap(event) {
                    this.setData({ tapped: event.currentTarget.dataset.id });
                    return event.currentTarget.dataset.id;
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-event-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let page = session.dispatch(request(
            "v8-event-page",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));
        assert_eq!(page.messages[0].payload["hooks"]["onReady"], "ready");
        let event = session.dispatch(request(
            "v8-event-tap",
            op::EVENT_BATCH,
            json!({"events": [{
                "type": "tap",
                "target": "button",
                "handler": "onTap",
                "pageIndex": 0,
                "dataset": {"id": 7},
                "detail": {"x": 1}
            }]}),
        ));
        assert_eq!(event.messages[0].payload["hooks"][0][0]["result"], 7);
        assert_eq!(event.messages[0].payload["hooks"][0][0]["phase"], "target");
        assert_eq!(session.view().pending_patches[0].path, "tapped");
        assert_eq!(session.view().pending_patches[0].value, Some(json!(7)));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_event_batch_applies_stop_propagation_and_prevent_default() {
        let source = br#"
            Page({
                onRoot(event) { return event.defaultPrevented; },
                onPanel(event) { return event.defaultPrevented; },
                onButton(event) {
                    event.preventDefault();
                    event.stopPropagation();
                    return { defaultPrevented: event.defaultPrevented, cancelBubble: event.cancelBubble };
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-event-control-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "v8-event-control-page",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));
        let event = session.dispatch(request(
            "v8-event-control-dispatch",
            op::EVENT_BATCH,
            json!({"events": [{
                "type": "tap",
                "target": "button",
                "path": ["root", "panel", "button"],
                "capture": true,
                "bubbles": true,
                "handlers": {"root": "onRoot", "panel": "onPanel", "button": "onButton"},
                "pageIndex": 0
            }]}),
        ));
        assert_eq!(
            event.messages[0].payload["dispatches"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["propagationStopped"],
            true
        );
        assert_eq!(event.messages[0].payload["hooks"][0][2]["dispatchIndex"], 2);
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["result"]["defaultPrevented"],
            true
        );
        assert_eq!(
            event.messages[0].payload["hooks"][0][2]["result"]["cancelBubble"],
            true
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_app_show_listener_receives_lifecycle_options() {
        let source = br#"
            wx.onAppShow(function(options) { globalThis.__scene = options.scene; });
            App({ onShow(options) { return options.scene; } });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest
            .capabilities
            .insert("wx.onAppShow".into(), CapabilitySupport::Full);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-listener-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let launch = session.dispatch(request(
            "v8-listener-launch",
            op::APP_LIFECYCLE,
            json!({"event": "launch"}),
        ));
        assert_eq!(launch.messages[0].payload["ok"], true);
        assert_eq!(launch.messages[0].payload["hooks"]["onShow"], 1001);
        let hide = session.dispatch(request(
            "v8-listener-hide",
            op::APP_LIFECYCLE,
            json!({"event": "hide"}),
        ));
        assert_eq!(hide.messages[0].payload["ok"], true);
        let show = session.dispatch(request(
            "v8-listener-show",
            op::APP_LIFECYCLE,
            json!({"event": "show", "options": {"scene": 1007}}),
        ));
        assert_eq!(show.messages[0].payload["hooks"]["onShow"], 1007);
        assert!(show.messages.iter().any(|message| {
            message.op == op::EVENT_BATCH
                && message.payload["effects"]
                    .as_array()
                    .is_some_and(|effects| {
                        effects.iter().any(|effect| {
                            effect["events"].as_array().is_some_and(|events| {
                                events.iter().any(|event| event["type"] == "app.listener")
                            })
                        })
                    })
        }));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn module_load_and_call_use_v8_when_selected() {
        let source = b"exports.add = (left, right) => left + right";
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":"exports.add = (left, right) => left + right"}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let call = session.dispatch(request(
            "v8-call",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"add","args":[7,8]}),
        ));
        assert_eq!(call.messages[0].payload["result"], json!([15]));
    }

    fn request(id: &str, operation: &str, payload: Value) -> BridgeEnvelope {
        BridgeEnvelope::request("session-1", id, operation, payload)
    }

    #[test]
    fn init_loads_manifest_and_emits_diagnostic() {
        let mut session = session();
        let batch = session.dispatch(request("r1", op::APP_INIT, json!({})));
        assert_eq!(batch.messages.len(), 2);
        assert!(session.initialized());
        assert_eq!(batch.messages[0].kind, EnvelopeKind::Response);
        assert_eq!(batch.messages[1].op, op::DIAGNOSTIC);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_component_bridge_mount_update_unmount_preserves_lifecycle_and_properties() {
        let source = br#"
            Component({
                data: { count: 0 },
                properties: { title: { type: String, value: 'default' } },
                observers: { 'title, count': function(title, count) { this.observed = [title, count]; } },
                lifetimes: {
                    created() { this.createdMarker = true; },
                    attached() { this.attachedMarker = true; },
                    ready() { this.readyMarker = true; },
                    detached() { this.detachedMarker = true; }
                }
            });
        "#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "component-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let mount = session.dispatch(request(
            "component-mount",
            op::COMPONENT_MOUNT,
            json!({"componentIndex": 0, "properties": {"title": "first", "count": 1}}),
        ));
        assert_eq!(mount.messages[0].payload["ok"], true);
        assert_eq!(
            mount.messages[0].payload["instance"]["snapshot"]["lifecycle"],
            json!(["created", "attached", "ready"])
        );
        assert_eq!(
            mount.messages[0].payload["instance"]["snapshot"]["properties"]["title"],
            "first"
        );
        let update = session.dispatch(request(
            "component-update",
            op::COMPONENT_UPDATE,
            json!({"componentIndex": 0, "properties": {"title": "second", "count": 2}}),
        ));
        assert_eq!(
            update.messages[0].payload["instance"]["changes"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert!(update.messages.iter().any(|message| {
            message.op == op::EVENT_BATCH
                && message.payload["effects"]
                    .as_array()
                    .is_some_and(|effects| {
                        effects.iter().any(|effect| {
                            effect["events"].as_array().is_some_and(|events| {
                                events
                                    .iter()
                                    .any(|event| event["type"] == "component.property.patch")
                            })
                        })
                    })
        }));
        let unmount = session.dispatch(request(
            "component-unmount",
            op::COMPONENT_UNMOUNT,
            json!({"componentIndex": 0}),
        ));
        assert_eq!(
            unmount.messages[0].payload["instance"]["snapshot"]["lifecycle"],
            json!(["created", "attached", "ready", "detached"])
        );
        assert_eq!(
            unmount.messages[0].payload["instance"]["snapshot"]["mounted"],
            false
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_set_data_effect_updates_bound_page_state() {
        let source =
            br#"App({}); Page({ data: { count: 0 }, onLoad() { this.setData({ count: 2 }); } });"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.routes.push(container_ir::Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        let result = session.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));
        assert_eq!(result.messages[0].payload["ok"], true);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            2
        );
        assert!(session
            .view()
            .pending_patches
            .iter()
            .any(|patch| patch.path == "count"));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_provider_api_resolves_callbacks_and_applies_set_data() {
        let source = br#"App({}); Page({ data: { status: 0 }, onLoad() { wx.request({ url: 'https://example.test/data', success: (result) => this.setData({ status: result.statusCode }) }); } });"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        session.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path": "pages/index/index"}),
        ));
        assert_eq!(
            session.app_service().pages().current().unwrap().data["status"],
            200
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_offscreen_canvas_draw_commits_isolated_surface_snapshot() {
        let source = br#"App({}); exports.draw = function() {
            const canvas = wx.createOffscreenCanvas({ type: '2d', width: 3, height: 2 });
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#00ff00';
            ctx.fillRect(1, 0, 2, 1);
            return ctx.draw();
        };"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "offscreen-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let draw = session.dispatch(request(
            "offscreen-draw",
            op::MODULE_CALL,
            json!({"moduleId": "module:app.js", "export": "draw", "args": []}),
        ));
        assert_eq!(draw.messages[0].payload["ok"], true);
        let snapshot = session
            .canvas_snapshot("__offscreen_1")
            .expect("offscreen surface committed");
        assert_eq!((snapshot.width, snapshot.height), (3, 2));
        assert!(session.renderer_if_initialized().is_none());
        assert_eq!(session.render_revision(), 0);
        assert_eq!(
            &snapshot.pixels[0..16],
            &[0, 0, 0, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0]
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_offscreen_canvas_draw_commits_isolated_surface_snapshot() {
        let source = br#"App({}); exports.draw = function() {
            const canvas = wx.createOffscreenCanvas({ type: '2d', width: 3, height: 2 });
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#00ff00';
            ctx.fillRect(1, 0, 2, 1);
            return ctx.draw();
        };"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let config = SessionConfig {
            engine: EngineKind::V8,
            ..SessionConfig::default()
        };
        let mut session = Session::new(app_manifest, config).unwrap();
        let init = session.dispatch(request(
            "offscreen-init-v8",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let draw = session.dispatch(request(
            "offscreen-draw-v8",
            op::MODULE_CALL,
            json!({"moduleId": "module:app.js", "export": "draw", "args": []}),
        ));
        assert_eq!(draw.messages[0].payload["ok"], true);
        let snapshot = session
            .canvas_snapshot("__offscreen_1")
            .expect("offscreen surface committed");
        assert_eq!((snapshot.width, snapshot.height), (3, 2));
        assert!(session.renderer_if_initialized().is_none());
        assert_eq!(session.render_revision(), 0);
        assert_eq!(
            &snapshot.pixels[0..16],
            &[0, 0, 0, 0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 0, 0]
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_canvas_context_draw_crosses_provider_once_per_frame() {
        let source = br#"App({}); Page({}); exports.draw = function() {
            const ctx = wx.createCanvasContext('main');
            ctx.fillStyle = '#f00';
            ctx.fillRect(0, 0, 10, 20);
            return ctx.draw();
        };"#;
        let mut app_manifest = manifest();
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "canvas-init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let draw = session.dispatch(request(
            "canvas-draw",
            op::MODULE_CALL,
            json!({"moduleId": "module:app.js", "export": "draw", "args": []}),
        ));
        assert_eq!(draw.messages[0].payload["ok"], true);
        assert!(draw.messages.iter().any(|message| {
            message.op == op::EVENT_BATCH
                && message.payload["effects"]
                    .as_array()
                    .is_some_and(|effects| {
                        effects.iter().any(|effect| {
                            effect["events"].as_array().is_some_and(|events| {
                                events.iter().any(|event| event["name"] == "wx.canvas.draw")
                            })
                        })
                    })
        }));
    }

    #[test]
    fn lifecycle_and_navigation_use_core_primitives() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let lifecycle =
            session.dispatch(request("l", op::APP_LIFECYCLE, json!({"event":"launch"})));
        assert_eq!(lifecycle.messages[0].payload["state"], "Active");
        let navigation = session.dispatch(request(
            "p",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","query":{"id":7}}),
        ));
        assert_eq!(
            navigation.messages[0].payload["page"]["path"],
            "pages/index/index"
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().query["id"],
            "7"
        );
        let pop = session.dispatch(request("x", op::PAGE_POP, json!({})));
        assert_eq!(pop.messages[0].payload["page"]["path"], "pages/index/index");
    }

    #[test]
    fn page_replace_unbinds_the_disposed_registration() {
        let mut app_manifest = manifest();
        app_manifest.routes.extend([
            container_ir::Route {
                id: "route:first".into(),
                path: "pages/first/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/first/index.js".into(),
            },
            container_ir::Route {
                id: "route:second".into(),
                path: "pages/second/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/second/index.js".into(),
            },
        ]);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let first = session.dispatch(request(
            "first",
            op::PAGE_PUSH,
            json!({"path":"pages/first/index"}),
        ));
        let first_id = first.messages[0].payload["pageId"]
            .as_u64()
            .map(PageId)
            .expect("page.push returns a page id");
        let second = session.dispatch(request(
            "second",
            op::PAGE_REPLACE,
            json!({"path":"pages/second/index"}),
        ));
        let second_id = second.messages[0].payload["pageId"]
            .as_u64()
            .map(PageId)
            .expect("page.replace returns a page id");

        assert_ne!(first_id, second_id);
        assert!(!session.page_bindings.values().any(|id| *id == first_id));
        assert!(session.page_bindings.values().any(|id| *id == second_id));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_relaunch_unloads_page_stack_from_top_to_bottom() {
        let source = br#"
            globalThis.__unloadLog = [];
            App({});
            Page({ onUnload() { globalThis.__unloadLog.push('first'); } });
            Page({ onUnload() { globalThis.__unloadLog.push('second'); } });
            Page({});
            exports.readLog = () => globalThis.__unloadLog;
        "#;
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.reLaunch".into(), CapabilitySupport::Partial);
        app_manifest.routes.extend([
            container_ir::Route {
                id: "route:first".into(),
                path: "pages/first/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/first/index.js".into(),
            },
            container_ir::Route {
                id: "route:second".into(),
                path: "pages/second/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/second/index.js".into(),
            },
            container_ir::Route {
                id: "route:target".into(),
                path: "pages/target/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/target/index.js".into(),
            },
        ]);
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "first",
            op::PAGE_PUSH,
            json!({"path":"pages/first/index"}),
        ));
        session.dispatch(request(
            "second",
            op::PAGE_PUSH,
            json!({"path":"pages/second/index"}),
        ));

        let relaunched = session.dispatch(request(
            "relaunch",
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":"pages/target/index"}),
        ));
        assert_eq!(relaunched.messages[0].payload["ok"], true);
        let log = session.dispatch(request(
            "log",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"readLog","args":[]}),
        ));
        assert_eq!(
            log.messages[0].payload["result"],
            json!(["second", "first"])
        );
    }

    #[test]
    fn block_wxml_container_is_flattened_before_layout_and_hit_testing() {
        let ast = parse_wxml(
            r#"<block wx:if="{{visible}}"><view id="child"><text>hello</text></view></block>"#,
        )
        .unwrap();
        let evaluated = container_ir::evaluate_wxml(&ast, &json!({"visible": true})).unwrap();
        let nodes = wxml_nodes_to_render(
            &evaluated.nodes,
            &WxssIr::default(),
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            "",
            &[],
        )
        .unwrap();
        assert_eq!(nodes.len(), 1);
        assert_eq!(nodes[0].id, "child");
        assert_eq!(nodes[0].tag.as_deref(), Some("view"));
        assert_eq!(nodes[0].children[0].tag.as_deref(), Some("text"));
    }

    #[test]
    fn keyed_wx_for_projects_identity_into_stable_render_paths() {
        let ast = parse_wxml(
            r#"<view wx:for="{{items}}" wx:for-item="item" wx:key="id"><text>{{item.label}}</text></view>"#,
        )
        .unwrap();
        let render = |items| {
            let evaluated = container_ir::evaluate_wxml(&ast, &json!({"items": items})).unwrap();
            wxml_nodes_to_render(
                &evaluated.nodes,
                &WxssIr::default(),
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 100.0,
                },
                "",
                &[],
            )
            .unwrap()
        };
        let first = render(json!([
            {"id": "a", "label": "first"},
            {"id": "b", "label": "second"}
        ]));
        let reordered = render(json!([
            {"id": "b", "label": "second"},
            {"id": "a", "label": "first"}
        ]));

        assert_eq!(
            first
                .iter()
                .map(|node| node.key.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("a"), Some("b")]
        );
        assert_eq!(
            reordered
                .iter()
                .map(|node| node.key.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("b"), Some("a")]
        );
        // The generated identity follows the key, so a host can reconcile the
        // same item after a reorder instead of tearing down a positional node.
        assert_eq!(first[0].id, reordered[1].id);
        assert_eq!(first[1].id, reordered[0].id);
    }

    #[test]
    fn keyed_multi_root_templates_keep_render_ids_across_reorder() {
        let ast = parse_wxml(r#"<template name="pair"><text>{{label}}</text><view>{{label}}</view></template><template wx:for="{{rows}}" wx:key="id" is="pair" data="{{item}}"/>"#).unwrap();
        let render = |rows| {
            let evaluated = container_ir::evaluate_wxml_with_templates(
                &ast,
                &json!({"rows":rows}),
                &BTreeMap::new(),
            )
            .unwrap();
            wxml_nodes_to_render(
                &evaluated.nodes,
                &WxssIr::default(),
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 100.0,
                },
                "",
                &[],
            )
            .unwrap()
        };
        let first = render(json!([{"id":"a","label":"A"},{"id":"b","label":"B"}]));
        let reordered = render(json!([{"id":"b","label":"B"},{"id":"a","label":"A"}]));
        assert_eq!(first.len(), 4, "transparent blocks add no layout node");
        for (before, after) in [(0, 2), (1, 3), (2, 0), (3, 1)] {
            assert_eq!(first[before].id, reordered[after].id);
        }
        assert_ne!(first[0].id, first[1].id, "roots retain distinct identities");
    }

    #[test]
    fn independent_repeat_sites_keep_unique_stable_render_ids() {
        let ast = parse_wxml(
            r#"<view wx:for="{{left}}" wx:key="*this"/><view wx:for="{{right}}" wx:key="*this"/>"#,
        )
        .unwrap();
        let render = |items| {
            let evaluated =
                container_ir::evaluate_wxml(&ast, &json!({"left":items,"right":items})).unwrap();
            wxml_nodes_to_render(
                &evaluated.nodes,
                &WxssIr::default(),
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 100.0,
                },
                "",
                &[],
            )
            .unwrap()
        };
        let first = render(json!(["a", "b"]));
        let reordered = render(json!(["b", "a"]));
        assert_eq!(
            first
                .iter()
                .map(|node| &node.id)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
            4,
        );
        assert_eq!(first[0].key, first[2].key, "public keys remain unchanged");
        for (before, after) in [(0, 1), (1, 0), (2, 3), (3, 2)] {
            assert_eq!(first[before].id, reordered[after].id);
        }
    }

    #[test]
    fn keyed_path_encoding_cannot_impersonate_another_scope_or_nested_path() {
        let outer = keyed_wxml_path_segment(Some("repeat"), "outer");
        let inner = keyed_wxml_path_segment(Some("repeat"), "inner");
        let delimiter_key = keyed_wxml_path_segment(Some("repeat"), "outer).key(inner");
        assert_ne!(delimiter_key, format!("{outer}.{inner}"));
        assert_ne!(
            keyed_wxml_path_segment(Some("a"), "bc"),
            keyed_wxml_path_segment(Some("ab"), "c"),
        );
        assert_ne!(
            keyed_wxml_path_segment(Some("a.b"), "c"),
            format!("{}.c", keyed_wxml_path_segment(Some("a"), "b")),
        );
        assert_ne!(
            keyed_wxml_path_segment(Some("first"), "😀.key(x)"),
            keyed_wxml_path_segment(Some("second"), "😀.key(x)"),
        );
        assert_eq!(
            keyed_wxml_path_segment(None, "old"),
            keyed_wxml_path_segment(Some("legacy"), "old"),
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn expression_subset_matches_native_engine(engine: EngineKind) {
        let data = json!({"a":2,"b":3,"same":{"x":1},"other":{"x":1},"rows":[{"label":"A"},{"label":"B"}],"index":0,"column":"label"});
        let expressions = [
            "10-3-2",
            "24/4/2",
            "-a+b",
            "!a&&b",
            "[]?'yes':'no'",
            "({})?'yes':'no'",
            "null==undefined",
            "null===undefined",
            "missing===undefined",
            "'2'==2",
            "'2'===2",
            "same===same",
            "same===other",
            "rows[index+1][column]",
            "false&&(1/0)",
            "true?7:(1/0)",
            "(0/0)||7",
            "false==[]",
            "[1]==1",
            "'😀'.length",
            "'2'<10",
            "'2'<'10'",
            "({p:same}).p===same",
            "([...rows])[0]===rows[0]",
            "-0",
            "1e21",
            "1e-7",
            "'𐀀'<'\u{e000}'",
        ];
        let source = format!(
            "exports.expected=function(){{const {{a,b,same,other,rows,index,column}}={data};const missing=undefined;return [{}].map(value=>value==null?'':String(value));}};",
            expressions.join(",")
        );
        let mut session = Session::new(
            module_manifest(source.as_bytes(), ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":source}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let result = session.dispatch(request(
            "expected",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"expected"}),
        ));
        assert_eq!(result.messages[0].payload["ok"], true);
        let expected = result.messages[0].payload["result"].as_array().unwrap();
        assert_eq!(expressions.len(), expected.len());
        for (expression, expected) in expressions.into_iter().zip(expected) {
            // Text AST isolates expression semantics from XML escaping.
            let ast = container_ir::WxmlAst {
                nodes: vec![WxmlNode::Text {
                    value: format!("{{{{{expression}}}}}"),
                    bindings: vec![expression.into()],
                    lexical_origin: None,
                }],
                ..Default::default()
            };
            let rendered = container_ir::evaluate_wxml(&ast, &data).unwrap();
            let WxmlNode::Text { value, .. } = &rendered.nodes[0] else {
                panic!("text expected")
            };
            assert_eq!(
                value,
                expected.as_str().unwrap(),
                "{engine:?}: {expression}"
            );
        }
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_wxml_expression_subset_matches_native_engine() {
        expression_subset_matches_native_engine(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_wxml_expression_subset_matches_native_engine() {
        expression_subset_matches_native_engine(EngineKind::V8);
    }

    #[test]
    fn manifest_render_defaults_to_current_page_data_without_overriding_explicit_data() {
        let wxml = parse_wxml("<text id=\"label\">{{label}}</text>")
            .unwrap()
            .canonical_json()
            .unwrap();
        let hash = container_ir::hex_digest(&wxml);
        let mut manifest = manifest();
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: format!("sha256:{hash}"),
            bindings: vec!["label".into()],
            wxs_modules: Default::default(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));
        let payload = json!({"templateId":"template:pages/index/index.wxml", "viewport":{"width":100,"height":50}, "blobs":{format!("sha256:{hash}"):wxml}});
        let render = |session: &mut Session, payload: Value| {
            let result =
                session.dispatch(request("render-current-data", op::RENDER_COMMIT, payload));
            assert_eq!(result.messages[0].payload["ok"], true);
            session
                .renderer()
                .last_frame()
                .unwrap()
                .query("#label", false)
                .unwrap()[0]
                .children[0]
                .text
                .clone()
                .unwrap()
        };
        assert_eq!(render(&mut session, payload.clone()), "");
        session.dispatch(request(
            "push-first",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","data":{"label":"first"}}),
        ));
        assert_eq!(render(&mut session, payload.clone()), "first");
        session.dispatch(request(
            "push-second",
            op::PAGE_PUSH,
            json!({"path":"pages/second/index","data":{"label":"second"}}),
        ));
        assert_eq!(render(&mut session, payload.clone()), "second");
        let mut explicit = payload.clone();
        explicit["data"] = json!({"label":"override"});
        assert_eq!(render(&mut session, explicit), "override");
        let mut explicit_empty = payload.clone();
        explicit_empty["data"] = json!({});
        assert_eq!(render(&mut session, explicit_empty), "");
        assert_eq!(render(&mut session, payload.clone()), "second");
        session.dispatch(request("pop-second", op::PAGE_POP, json!({"delta":1})));
        assert_eq!(render(&mut session, payload), "first");
    }

    #[test]
    fn inline_cascade_drives_layout_paint_and_only_supported_color_inherits() {
        let ast = parse_wxml(concat!(
            "<view id=\"parent\" style=\"width:80px;height:50px;background:blue;opacity:.5;color:red\">",
            "<view id=\"child\" style=\"width:10px;height:10px;padding:1px;padding-left:3px\"/>",
            "<view id=\"locked\" style=\"width:30px;height:10px;background:blue;color:green\"/>",
            "<view id=\"initial\" style=\"color:initial\"/>",
            "<view id=\"inherited\" style=\"color:inherit\"/>",
            "</view>"
        )).unwrap();
        let styles = parse_wxss("#locked { width:8px !important; background-color:red !important; } #child { padding-left:9px; }").unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            width: Some(100.0),
            height: Some(100.0),
            ..LayoutStyle::default()
        });
        root.children = wxml_nodes_to_render(&ast.nodes, &styles, viewport, "", &[]).unwrap();
        layout_tree(&mut root, viewport);
        let parent = &root.children[0];
        assert_eq!(parent.bounds.width, 80.0);
        assert_eq!(parent.bounds.height, 50.0);
        assert_eq!(parent.opacity, 0.5);
        assert_eq!(parent.background, parse_render_color("blue"));
        let child = &parent.children[0];
        // WXSS width/height are content-box by default: 3+1 horizontal
        // padding and 1+1 vertical padding extend the border rectangle.
        assert_eq!(child.bounds.width, 14.0);
        assert_eq!(child.bounds.height, 12.0);
        assert_eq!(child.style.unwrap().padding.left, 3.0);
        assert_eq!(child.opacity, 1.0);
        assert_eq!(child.background, None);
        assert_eq!(child.foreground, parse_render_color("red"));
        assert_eq!(
            child.computed_style.get("color").map(String::as_str),
            Some("red")
        );
        assert!(!child.computed_style.contains_key("background"));
        assert!(!child.computed_style.contains_key("opacity"));
        let locked = &parent.children[1];
        assert_eq!(locked.bounds.width, 8.0);
        assert_eq!(locked.background, parse_render_color("red"));
        assert_eq!(locked.foreground, parse_render_color("green"));
        assert_eq!(parent.children[2].foreground, parse_render_color("black"));
        assert_eq!(parent.children[3].foreground, parse_render_color("red"));
    }

    #[test]
    fn inline_negative_margin_longhand_controls_geometry_without_negative_padding() {
        let ast = parse_wxml("<view id=\"box\" style=\"width:20px;height:10px;margin:4px;margin-left:-2px;padding:3px;padding-left:-1px\"/>").unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            width: Some(100.0),
            height: Some(100.0),
            ..LayoutStyle::default()
        });
        root.children =
            wxml_nodes_to_render(&ast.nodes, &WxssIr::default(), viewport, "", &[]).unwrap();
        layout_tree(&mut root, viewport);
        let node = &root.children[0];
        assert_eq!(node.bounds.x, -2.0);
        assert_eq!(node.bounds.y, 4.0);
        assert_eq!(node.style.unwrap().margin.left, -2.0);
        assert_eq!(node.style.unwrap().padding.left, 3.0);
        assert_eq!(
            node.computed_style.get("margin-left").map(String::as_str),
            Some("-2px")
        );
        assert!(root
            .hit_test(0.0, 5.0)
            .is_some_and(|target| target.id == "box"));
        assert!(root
            .hit_test(25.0, 5.0)
            .is_some_and(|target| target.id == "root"));
    }

    #[test]
    fn border_inheritance_uses_computed_width_and_resolves_box_sizing_globals() {
        let ast = parse_wxml(concat!(
            "<view id=\"parent\" style=\"width:80px;box-sizing:border-box;border:5px none green;color:red\">",
            "<view id=\"inherited\" style=\"width:20px;height:10px;padding:2px;border-width:inherit;border-style:solid;border-color:inherit;box-sizing:inherit\"/>",
            "<view id=\"initial\" style=\"width:20px;height:10px;padding:2px;border:2px solid;box-sizing:initial\"/>",
            "<view id=\"unset\" style=\"width:20px;height:10px;padding:2px;border:unset;box-sizing:unset\"/>",
            "</view>"
        )).unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle::default());
        root.children =
            wxml_nodes_to_render(&ast.nodes, &WxssIr::default(), viewport, "", &[]).unwrap();
        layout_tree(&mut root, viewport);
        let children = &root.children[0].children;
        let inherited = &children[0];
        assert_eq!(inherited.bounds.width, 20.0);
        assert_eq!(inherited.style.unwrap().border_insets(), EdgeInsets::ZERO);
        assert_eq!(inherited.computed_style["border-top-width"], "0px");
        assert_eq!(
            inherited.computed_style["border-top-color"],
            "rgb(0, 128, 0)"
        );
        assert_eq!(inherited.computed_style["box-sizing"], "border-box");
        assert_eq!(children[1].bounds.width, 28.0);
        assert_eq!(children[1].computed_style["box-sizing"], "content-box");
        assert_eq!(
            children[1].computed_style["border-top-color"],
            "rgb(255, 0, 0)"
        );
        assert_eq!(children[2].bounds.width, 24.0);
        assert_eq!(children[2].computed_style["box-sizing"], "content-box");
        assert_eq!(children[2].computed_style["border-top-style"], "none");
    }

    #[test]
    fn unmanaged_wxml_text_does_not_invent_event_targets_through_visible_overflow() {
        let ast = parse_wxml("<view id=\"panel\" style=\"width:40px;height:30px\"><text id=\"label\" style=\"height:10px\">Hi</text></view>").unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let mut root = RenderNode::new("root", viewport).with_style(LayoutStyle {
            width: Some(viewport.width),
            height: Some(viewport.height),
            ..LayoutStyle::default()
        });
        root.children =
            wxml_nodes_to_render(&ast.nodes, &WxssIr::default(), viewport, "", &[]).unwrap();
        layout_tree(&mut root, viewport);
        let label = &root.children[0].children[0];
        let anonymous = &label.children[0];
        assert!(
            anonymous.bounds.height > label.bounds.height,
            "the painted text really overflows the host"
        );
        assert!(
            !anonymous.hit_testable,
            "anonymous text is absent from public WXML event nodes"
        );
        assert_eq!(
            root.hit_test(5.0, 5.0).map(|node| node.id.as_str()),
            Some("label")
        );
        assert_eq!(
            root.hit_test(5.0, 15.0).map(|node| node.id.as_str()),
            Some("panel")
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_bound_inline_styles_reach_real_layout_pixels_selectors_and_events(
        engine: EngineKind,
    ) {
        let source = br#"Page({
            data:{width:20,color:'red',opacity:1,layer:3,pad:0,textColor:'blue',taps:0},
            onTap(){this.setData({width:40,color:'blue',opacity:0.5,layer:9,pad:2,textColor:'red',taps:this.data.taps+1});}
        });
        exports.query=function(){
            const query=wx.createSelectorQuery();
            query.select('#panel').boundingClientRect();
            query.select('#panel').fields({computedStyle:['width','height','background-color','opacity','z-index','padding-left','color']});
            query.select('#child').fields({computedStyle:['color','background-color','opacity']});
            query.exec(values=>globalThis.__styleResults=values);
        };
        exports.read=function(){return {values:globalThis.__styleResults};};"#;
        let wxml = parse_wxml(concat!(
            "<view id=\"panel\" class=\"panel\" bindtap=\"onTap\" style=\"width:{{width}}px;height:20px;background-color:{{color}};opacity:{{opacity}};z-index:{{layer}};padding:0px;padding-left:{{pad}}px;color:{{textColor}}\">",
            "<text id=\"child\" style=\"height:10px\">Hi</text></view>"
        )).unwrap().canonical_json().unwrap();
        let wxss = parse_wxss(".panel { width:90px; height:30px; background:green; opacity:.2; z-index:0; color:green; }").unwrap().canonical_json().unwrap();
        let wxml_hash = container_ir::hex_digest(&wxml);
        let wxss_hash = container_ir::hex_digest(&wxss);
        let mut manifest = module_manifest(source, ModuleFormat::Commonjs);
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: format!("sha256:{wxml_hash}"),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: format!("sha256:{wxss_hash}"),
            scope: StyleScope::Page,
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "inline-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let push = session.dispatch(request(
            "inline-push",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        assert_eq!(push.messages[0].payload["ok"], true);
        let render_payload = json!({
            "templateId":"template:pages/index/index.wxml", "frameId":1,
            "viewport":{"width":100,"height":50},
            "blobs":{format!("sha256:{wxml_hash}"):wxml, format!("sha256:{wxss_hash}"):wxss}
        });
        for (
            revision,
            expected_width,
            expected_color,
            expected_opacity,
            expected_layer,
            expected_pad,
            inherited_color,
        ) in [
            (1, 20.0, "red", "1", "3", "0px", "blue"),
            (2, 40.0, "blue", "0.5", "9", "2px", "red"),
        ] {
            let commit = session.dispatch(request(
                "inline-render",
                op::RENDER_COMMIT,
                render_payload.clone(),
            ));
            assert_eq!(
                commit.messages[0].payload["ok"], true,
                "{engine:?}: {commit:?}"
            );
            let frame = session.renderer().last_frame().unwrap();
            let panel = frame.query("#panel", false).unwrap()[0];
            let outer_width = expected_width + if revision == 2 { 2.0 } else { 0.0 };
            assert_eq!(panel.bounds.width, outer_width);
            assert_eq!(panel.bounds.height, 20.0);
            assert_eq!(panel.background, parse_render_color(expected_color));
            assert_eq!(panel.opacity.to_string(), expected_opacity);
            assert_eq!(panel.z_index.to_string(), expected_layer);
            assert_eq!(
                panel.children[0].foreground,
                parse_render_color(inherited_color)
            );
            assert!(frame
                .root
                .hit_test(outer_width - 1.0, 15.0)
                .is_some_and(|node| node.id == "panel"));
            let snapshot = session.renderer().snapshot().unwrap();
            let pixel =
                |x: usize, y: usize| &snapshot.pixels[(y * 100 + x) * 4..(y * 100 + x) * 4 + 4];
            if revision == 1 {
                assert_eq!(pixel(15, 15), &[255, 0, 0, 255]);
                assert_eq!(pixel(35, 15), &[0, 0, 0, 0]);
            } else {
                assert_eq!(pixel(35, 15), &[0, 0, 128, 128]);
                assert_eq!(pixel(45, 15), &[0, 0, 0, 0]);
            }
            let query = session.dispatch(request(
                "inline-query",
                op::MODULE_CALL,
                json!({"moduleId":"module:app","export":"query"}),
            ));
            assert_eq!(query.messages[0].payload["ok"], true);
            let read = session.dispatch(request(
                "inline-read",
                op::MODULE_CALL,
                json!({"moduleId":"module:app","export":"read"}),
            ));
            assert_eq!(read.messages[0].payload["ok"], true, "{read:?}");
            // JsEngine::call exposes a ValueBatch: a top-level JS array is
            // the batch itself. The fixture returns an object to retain an
            // unambiguous named slot for its three SelectorQuery results.
            let values = &read.messages[0].payload["result"][0]["values"];
            assert_eq!(values.as_array().map(Vec::len), Some(3), "{read:?}");
            assert_eq!(values[0]["width"], outer_width);
            assert_eq!(values[0]["height"], 20.0);
            assert_eq!(values[1]["width"], format!("{expected_width}px"));
            assert_eq!(values[1]["height"], "20px");
            assert_eq!(values[1]["background-color"], expected_color);
            assert_eq!(values[1]["opacity"], expected_opacity);
            assert_eq!(values[1]["z-index"], expected_layer);
            assert_eq!(values[1]["padding-left"], expected_pad);
            assert_eq!(values[1]["color"], inherited_color);
            assert_eq!(values[2]["color"], inherited_color);
            assert_eq!(values[2]["background-color"], "");
            assert_eq!(values[2]["opacity"], "");
            if revision == 1 {
                let tap = session.dispatch(request(
                    "inline-tap",
                    op::EVENT_BATCH,
                    json!({"events":[{"type":"tap","x":15.0,"y":15.0}]}),
                ));
                assert_eq!(tap.messages[0].payload["ok"], true);
                let data = &session.app_service().pages().current().unwrap().data;
                assert_eq!(data["width"], 40);
                assert_eq!(data["taps"], 1);
            }
        }
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_bound_inline_styles_reach_layout_pixels_selectors_and_events() {
        assert_bound_inline_styles_reach_real_layout_pixels_selectors_and_events(
            EngineKind::Quickjs,
        );
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_bound_inline_styles_reach_layout_pixels_selectors_and_events() {
        assert_bound_inline_styles_reach_real_layout_pixels_selectors_and_events(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn flex_page_state_selector_storage_and_rejection_conformance(engine: EngineKind) {
        let source = br#"Page({data:{weight:1,order:0,taps:0},onTap(){
            this.setData({weight:3,taps:this.data.taps+1});
            wx.setStorageSync('flex-weight',this.data.weight);
        }});
        exports.inspect=function(){const q=wx.createSelectorQuery();
            q.selectAll('.item').boundingClientRect();
            q.exec(values=>wx.setStorageSync('flex-rects',values[0]));
        };"#;
        let wxml = parse_wxml(concat!(
            "<view id=\"row\" style=\"display:flex;width:300px;height:30px\">",
            "<view id=\"first\" class=\"item\" bindtap=\"onTap\" style=\"flex:{{weight}};min-width:0;order:{{order}};background:red\"/>",
            "<view id=\"second\" class=\"item\" style=\"flex:2;min-width:0;background:blue\"/></view>"
        )).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
        let mut manifest = module_manifest(source, ModuleFormat::Commonjs);
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        for (id, operation, payload) in [
            (
                "flex-init",
                op::APP_INIT,
                json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
            ),
            (
                "flex-push",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ),
        ] {
            let response = session.dispatch(request(id, operation, payload));
            assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
        }
        let render_payload = json!({"templateId":"template:pages/index/index.wxml", "viewport":{"width":300,"height":60}, "blobs":{pointer:wxml}});
        for (revision, first_width, second_width) in [(1, 100.0, 200.0), (2, 180.0, 120.0)] {
            let mut payload = render_payload.clone();
            payload["frameId"] = json!(revision);
            let commit = session.dispatch(request("flex-render", op::RENDER_COMMIT, payload));
            assert_eq!(
                commit.messages[0].payload["ok"], true,
                "{engine:?}: {commit:?}"
            );
            let frame = session.renderer().last_frame().unwrap();
            let first = frame.query("#first", false).unwrap()[0];
            let second = frame.query("#second", false).unwrap()[0];
            assert!((first.bounds.width - first_width).abs() < 0.001);
            assert!((second.bounds.width - second_width).abs() < 0.001);
            assert!((second.bounds.x - first_width).abs() < 0.001);
            assert_eq!(
                frame
                    .root
                    .hit_test(first_width - 1.0, 15.0)
                    .map(|node| node.id.as_str()),
                Some("first")
            );
            let inspect = session.dispatch(request(
                "flex-inspect",
                op::MODULE_CALL,
                json!({"moduleId":"module:app","export":"inspect"}),
            ));
            assert_eq!(inspect.messages[0].payload["ok"], true, "{inspect:?}");
            let stored = session.app_service().storage().get("flex-rects").unwrap();
            assert_eq!(stored[0]["id"], "first");
            assert!((stored[0]["width"].as_f64().unwrap() - f64::from(first_width)).abs() < 0.001);
            assert_eq!(stored[1]["id"], "second");
            if revision == 1 {
                let tap = session.dispatch(request(
                    "flex-tap",
                    op::EVENT_BATCH,
                    json!({"events":[{"type":"tap","x":50.0,"y":15.0}]}),
                ));
                assert_eq!(tap.messages[0].payload["ok"], true, "{tap:?}");
                assert_eq!(
                    session.app_service().pages().current().unwrap().data["weight"],
                    3
                );
                assert_eq!(
                    session.app_service().pages().current().unwrap().data["taps"],
                    1
                );
                assert_eq!(
                    session.app_service().storage().get("flex-weight"),
                    Some(&json!(3))
                );
            }
        }
        let before = session.renderer().snapshot().unwrap();
        let page_before = session.app_service().pages().current().unwrap().clone();
        let mut unsupported = render_payload;
        unsupported["data"] = json!({"weight":3,"order":"var(--unresolved-order)"});
        let failed = session.dispatch(request("flex-rejected", op::RENDER_COMMIT, unsupported));
        assert_eq!(
            failed.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        let after = session.renderer().snapshot().unwrap();
        assert_eq!(after.frame_id, before.frame_id);
        assert_eq!(after.pixels, before.pixels);
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            page_before.data
        );
        assert_eq!(
            session.app_service().storage().get("flex-weight"),
            Some(&json!(3))
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_flex_page_state_selector_storage_and_rejection_conformance() {
        flex_page_state_selector_storage_and_rejection_conformance(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_flex_page_state_selector_storage_and_rejection_conformance() {
        flex_page_state_selector_storage_and_rejection_conformance(EngineKind::V8);
    }

    #[test]
    fn render_commit_decodes_manifest_wxml_wxss_blobs_and_builds_layout_tree() {
        let wxml = parse_wxml(
            r#"<view id="root" class="card"><text id="title">{{ title }}</text></view>"#,
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let wxss = parse_wxss(
            ".card { width: 100%; height: 100rpx; padding: 4rpx; background-color: #ff0000; } #title { color: #ffffff; }",
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let wxml_hash = container_ir::hex_digest(&wxml);
        let wxss_hash = container_ir::hex_digest(&wxss);
        let mut render_manifest = manifest();
        render_manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: format!("sha256:{wxml_hash}"),
            bindings: vec!["title".into()],
            wxs_modules: Default::default(),
        });
        render_manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: format!("sha256:{wxss_hash}"),
            scope: StyleScope::Page,
        });
        render_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(render_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "render-ir",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "frameId": 9,
                "viewport": {"width": 200, "height": 300},
                "data": {"title": "Hello"},
                "blobs": {
                    format!("sha256:{wxml_hash}"): wxml,
                    format!("sha256:{wxss_hash}"): wxss,
                }
            }),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        assert_eq!(response.messages[0].payload["source"], "manifest");
        assert_eq!(response.messages[0].payload["frameId"], 9);
        let frame = session.renderer().last_frame().unwrap();
        let title = frame.query("#title", false).unwrap();
        assert_eq!(title.len(), 1);
        assert_eq!(title[0].children[0].text.as_deref(), Some("Hello"));
        assert!(title[0].bounds.width > 190.0);
        let snapshot = session.renderer().snapshot().unwrap();
        assert_eq!(snapshot.width, 200);
        assert_eq!(&snapshot.pixels[0..4], &[255, 0, 0, 255]);
    }

    #[test]
    fn page_host_extent_resolves_after_font_padding_without_leaking_into_css_inherit() {
        let wxml =
            parse_wxml("<view id=\"child\" style=\"width:inherit;height:10px;padding:5px\"/>")
                .unwrap()
                .canonical_json()
                .unwrap();
        let wxss = parse_wxss("page { font-size:20px; padding:1em; }")
            .unwrap()
            .canonical_json()
            .unwrap();
        let wxml_pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
        let wxss_pointer = format!("sha256:{}", container_ir::hex_digest(&wxss));
        let mut manifest = manifest();
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: wxml_pointer.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: wxss_pointer.clone(),
            scope: StyleScope::App,
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));
        for (width, height) in [(300, 100), (600, 200)] {
            let result = session.dispatch(request("page-extent",op::RENDER_COMMIT,json!({
                "templateId":"template:pages/index/index.wxml", "viewport":{"width":width,"height":height},
                "blobs":{wxml_pointer.clone():wxml.clone(),wxss_pointer.clone():wxss.clone()}
            })));
            assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
            let frame = session.renderer().last_frame().unwrap();
            assert_eq!(frame.root.bounds.width, width as f32);
            assert_eq!(frame.root.bounds.height, height as f32);
            let child = frame.query("#child", false).unwrap()[0];
            assert_eq!(child.bounds.x, 20.0);
            assert_eq!(child.bounds.y, 20.0);
            assert_eq!(child.bounds.width, width as f32 - 40.0);
            assert_eq!(child.bounds.height, 20.0);
        }
    }

    #[test]
    fn transformed_fixed_containing_block_is_unsupported_and_preserves_accepted_frame() {
        let wxml = parse_wxml(concat!(
            "<view id=\"ancestor\" style=\"transform:{{transform}};width:60px;height:60px;background:red\">",
            "<view id=\"fixed\" style=\"position:fixed;left:2px;top:2px;width:10px;height:10px;background:blue\"/></view>"
        )).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
        let mut manifest = manifest();
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
        for (id, operation, payload) in [
            ("init", op::APP_INIT, json!({})),
            (
                "push",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index","data":{"transform":"none","counter":7}}),
            ),
            (
                "storage",
                op::API_CALL,
                json!({"name":"wx.setStorageSync","key":"fixed-test","data":9}),
            ),
        ] {
            let response = session.dispatch(request(id, operation, payload));
            assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
        }
        let payload = json!({"templateId":"template:pages/index/index.wxml","frameId":1,
            "viewport":{"width":100,"height":100},"blobs":{pointer:wxml}});
        let initial =
            session.dispatch(request("initial-fixed", op::RENDER_COMMIT, payload.clone()));
        assert_eq!(initial.messages[0].payload["ok"], true, "{initial:?}");
        let before = session.renderer().snapshot().unwrap();
        let page_before = session.app_service().pages().current().unwrap().clone();
        for transform in ["translateX(0px)", "translateX(10px)"] {
            let mut candidate = payload.clone();
            candidate["frameId"] = json!(2);
            candidate["data"] = json!({"transform":transform,"counter":99});
            let response =
                session.dispatch(request("unsupported-fixed", op::RENDER_COMMIT, candidate));
            assert_eq!(response.messages[0].payload["ok"], false, "{response:?}");
            assert_eq!(
                response.messages[0].payload["error"]["code"],
                "ERR_UNSUPPORTED_CAPABILITY"
            );
            assert!(response.messages[0].payload["error"]["message"]
                .as_str()
                .unwrap()
                .contains("transformed-fixed-containing-block"));
            let after = session.renderer().snapshot().unwrap();
            assert_eq!(after.frame_id, before.frame_id);
            assert_eq!(after.pixels, before.pixels);
            let page = session.app_service().pages().current().unwrap();
            assert_eq!(page.id, page_before.id);
            assert_eq!(page.data, page_before.data);
            assert_eq!(
                session.app_service().storage().get("fixed-test"),
                Some(&json!(9))
            );
            let selected = session.dispatch(request(
                "accepted-fixed",
                op::API_CALL,
                json!({"name":"wx.createSelectorQuery","selector":"#fixed"}),
            ));
            assert_eq!(selected.messages[0].payload["result"]["left"], 2.0);
            assert_eq!(selected.messages[0].payload["result"]["top"], 2.0);
        }
    }

    #[test]
    fn portable_media_queries_match_recorded_auxiliary_chrome_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../tests/fixtures/media-queries-chrome.json"))
                .unwrap();
        let cases = corpus["cases"].as_array().unwrap();
        assert_eq!(cases.len(), 184);
        for case in cases {
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: case["viewport"]["width"].as_f64().unwrap() as f32,
                height: case["viewport"]["height"].as_f64().unwrap() as f32,
            };
            let actual =
                style_conditions::media_matches(case["query"].as_str().unwrap(), viewport).unwrap();
            assert_eq!(actual, case["matches"].as_bool().unwrap(), "{case}");
        }
    }

    #[test]
    fn media_viewport_commits_update_pixels_and_reject_active_unsupported_rules_atomically() {
        let wxml = parse_wxml("<view id=\"panel\"/>")
            .unwrap()
            .canonical_json()
            .unwrap();
        let wxss = parse_wxss(concat!(
            "#panel { width:20px; height:20px; background:red; } ",
            "@media (min-width:150px) { #panel { width:40px; background:blue; } } ",
            "@media (min-width:300px) { @supports (display:flex) { #panel { height:60px; } } }"
        ))
        .unwrap()
        .canonical_json()
        .unwrap();
        let wxml_pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
        let wxss_pointer = format!("sha256:{}", container_ir::hex_digest(&wxss));
        let mut manifest = manifest();
        manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: wxml_pointer.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: wxss_pointer.clone(),
            scope: StyleScope::Page,
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
        for (id, operation, payload) in [
            ("init", op::APP_INIT, json!({})),
            (
                "push",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index","data":{"counter":7}}),
            ),
            (
                "storage",
                op::API_CALL,
                json!({"name":"wx.setStorageSync","key":"media-test","data":9}),
            ),
        ] {
            let response = session.dispatch(request(id, operation, payload));
            assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
        }
        let initial_page = session.app_service().pages().current().unwrap().clone();
        let payload = |width| {
            json!({
                "templateId":"template:pages/index/index.wxml", "viewport":{"width":width,"height":100},
                "blobs":{wxml_pointer.clone():wxml.clone(), wxss_pointer.clone():wxss.clone()}
            })
        };
        for (width, expected_width, color) in [
            (100, 20.0, [255, 0, 0, 255]),
            (200, 40.0, [0, 0, 255, 255]),
            (100, 20.0, [255, 0, 0, 255]),
        ] {
            let response =
                session.dispatch(request("media-frame", op::RENDER_COMMIT, payload(width)));
            assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
            let frame = session.renderer().last_frame().unwrap();
            assert_eq!(
                frame.query("#panel", false).unwrap()[0].bounds.width,
                expected_width
            );
            assert_eq!(&session.renderer().snapshot().unwrap().pixels[..4], &color);
            let page = session.app_service().pages().current().unwrap();
            assert_eq!(page.id, initial_page.id);
            assert_eq!(page.data, initial_page.data);
        }
        let before = session.renderer().snapshot().unwrap();
        let failed = session.dispatch(request(
            "unsupported-media",
            op::RENDER_COMMIT,
            payload(400),
        ));
        assert_eq!(failed.messages[0].payload["ok"], false);
        assert_eq!(
            failed.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        let after = session.renderer().snapshot().unwrap();
        assert_eq!(after.frame_id, before.frame_id);
        assert_eq!(after.width, before.width);
        assert_eq!(after.pixels, before.pixels);
        let storage = session.dispatch(request(
            "read-storage",
            op::API_CALL,
            json!({"name":"wx.getStorageSync","key":"media-test"}),
        ));
        assert_eq!(storage.messages[0].payload["result"], 9);
        assert_eq!(
            session.app_service().pages().current().unwrap().id,
            initial_page.id
        );
    }

    #[test]
    fn wxml_auto_height_is_measured_by_renderer_after_resolving_content_width() {
        let ast = parse_wxml(concat!(
            "<view id=\"card\"><text id=\"line\">12345678</text>",
            "<view id=\"gone\"/><view id=\"overlay\"/><view id=\"fixed\"/></view>",
            "<view id=\"after\"/>"
        ))
        .unwrap();
        let styles = parse_wxss(concat!(
            // Keep this auto-height regression deliberately wrapped: normal
            // word breaking leaves the continuous numeric word unbroken.
            "#card { padding: 4px; } #line { margin-top: 3px; word-break: break-all; } ",
            "#gone { display: none; height: 500px; margin-top: 100px; } ",
            "#overlay { position: absolute; height: 500px; } ",
            "#fixed { height: 10px; margin-top: 2px; margin-bottom: 5px; }"
        ))
        .unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 64.0,
            height: 200.0,
        };
        let nodes = wxml_nodes_to_render(&ast.nodes, &styles, viewport, "", &[]).unwrap();
        // WXML conversion owns style/tree construction, not a duplicate
        // unconstrained intrinsic-height approximation.
        assert_eq!(nodes[0].bounds.height, 0.0);
        let mut root = RenderNode::new("page", viewport).with_style(LayoutStyle {
            width: Some(viewport.width),
            height: Some(viewport.height),
            ..LayoutStyle::default()
        });
        root.children = nodes;
        layout_tree(&mut root, viewport);
        let card = &root.children[0];
        assert_eq!(card.bounds.width, 64.0);
        assert_eq!(card.children[0].bounds.width, 56.0);
        assert!((card.children[0].bounds.height - 38.4).abs() < 0.001);
        assert!((card.bounds.height - 66.4).abs() < 0.001);
        assert!((root.children[1].bounds.y - 66.4).abs() < 0.001);
        assert_eq!(card.children[1].bounds.height, 0.0);
    }

    #[test]
    fn manifest_render_rejects_template_from_unrelated_blob_without_import() {
        let page_wxml = parse_wxml(r#"<view><template is="private"/></view>"#)
            .unwrap()
            .canonical_json()
            .unwrap();
        let unrelated_wxml =
            parse_wxml(r#"<template name="private"><text>secret</text></template>"#)
                .unwrap()
                .canonical_json()
                .unwrap();
        let page_hash = container_ir::hex_digest(&page_wxml);
        let unrelated_hash = container_ir::hex_digest(&unrelated_wxml);
        let mut render_manifest = manifest();
        render_manifest.templates.extend([
            Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: format!("sha256:{page_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            },
            Template {
                id: "template:pages/other/other.wxml".into(),
                wxml_ast: format!("sha256:{unrelated_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            },
        ]);
        render_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(render_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "render-unrelated-template",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "frameId": 10,
                "viewport": {"width": 200, "height": 300},
                "blobs": {
                    format!("sha256:{page_hash}"): page_wxml,
                    format!("sha256:{unrelated_hash}"): unrelated_wxml,
                }
            }),
        ));
        assert_eq!(response.messages[0].payload["ok"], false);
        assert_eq!(response.messages[0].payload["error"]["code"], "ERR_RENDER");
        assert!(response.messages[0].payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("WXML template target not found: private"));
        assert!(session.renderer().last_frame().is_none());
    }

    #[test]
    fn render_layout_style_resolves_wxss_transform_and_origin() {
        let ast = parse_wxml(r#"<view id="box" class="box" />"#).unwrap();
        let wxss = parse_wxss(
            ".box { width: 20px; height: 10px; transform: translate(12px, 8px) rotate(90deg); transform-origin: left top; }",
        )
        .unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        };
        let mut nodes = wxml_nodes_to_render(&ast.nodes, &wxss, viewport, "", &[]).unwrap();
        let transforms = style_transforms::prepare_tree(&mut nodes[0], viewport).unwrap();
        SkiaRenderer::new()
            .layout_tree(&mut nodes[0], viewport)
            .unwrap();
        style_transforms::finish_tree(&mut nodes[0], transforms).unwrap();
        let style = nodes[0].style.expect("resolved layout style");
        let transform = style.transform.expect("resolved transform");
        assert!((transform.e - 12.0).abs() < 0.001);
        assert!((transform.f - 8.0).abs() < 0.001);
        assert!((transform.a).abs() < 0.001);
        assert!((transform.b - 1.0).abs() < 0.001);
        let origin = style.transform_origin.expect("resolved transform origin");
        assert_eq!(
            origin.x.unit,
            container_render_skia::TransformOriginUnit::Percent
        );
        assert_eq!(origin.x.value, 0.0);
        assert_eq!(origin.y.value, 0.0);
    }

    #[test]
    fn render_tree_applies_wxss_descendant_and_child_selectors_to_nested_nodes() {
        let ast = parse_wxml(
            r#"<view class="card"><view class="title"><text>hello</text></view></view>"#,
        )
        .unwrap();
        let wxss = parse_wxss(
            ".card { color: blue; } .card .title { color: red; } .card > .title { height: 24px; }",
        )
        .unwrap();
        let nodes = wxml_nodes_to_render(
            &ast.nodes,
            &wxss,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            "",
            &[],
        )
        .unwrap();
        let title = &nodes[0].children[0];
        assert_eq!(title.computed_style.get("color"), Some(&"red".into()));
        assert_eq!(title.computed_style.get("height"), Some(&"24px".into()));
        assert_eq!(
            title.children[0].computed_style.get("color"),
            Some(&"red".into())
        );
    }

    #[test]
    fn render_tree_applies_wxss_structural_pseudo_classes_to_siblings() {
        let ast = parse_wxml(
            r#"<view><text id="first">one</text><text id="middle" class="muted">two</text><text id="last">three</text></view>"#,
        )
        .unwrap();
        let wxss = parse_wxss(
            "text:first-child { color: red; } text:nth-child(2) { color: green; } text:last-child { color: blue; } text:not(.muted) { opacity: 0.5; }",
        )
        .unwrap();
        let nodes = wxml_nodes_to_render(
            &ast.nodes,
            &wxss,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            "",
            &[],
        )
        .unwrap();
        let children = &nodes[0].children;
        assert_eq!(children[0].computed_style.get("color"), Some(&"red".into()));
        assert_eq!(
            children[1].computed_style.get("color"),
            Some(&"green".into())
        );
        assert_eq!(
            children[2].computed_style.get("color"),
            Some(&"blue".into())
        );
        assert_eq!(
            children[0].computed_style.get("opacity"),
            Some(&"0.5".into())
        );
        assert_eq!(children[1].computed_style.get("opacity"), None);
    }

    #[test]
    fn render_tree_counts_flattened_block_children_for_structural_pseudos() {
        let ast = parse_wxml(
            r#"<view><block><text id="first">one</text><text id="middle">two</text></block><text id="last">three</text></view>"#,
        )
        .unwrap();
        let wxss = parse_wxss(
            "text:first-child { color: red; } text:nth-child(2) { color: green; } text:last-child { color: blue; }",
        )
        .unwrap();
        let nodes = wxml_nodes_to_render(
            &ast.nodes,
            &wxss,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            "",
            &[],
        )
        .unwrap();
        let children = &nodes[0].children;
        assert_eq!(children.len(), 3);
        assert_eq!(children[0].computed_style.get("color"), Some(&"red".into()));
        assert_eq!(
            children[1].computed_style.get("color"),
            Some(&"green".into())
        );
        assert_eq!(
            children[2].computed_style.get("color"),
            Some(&"blue".into())
        );
    }

    #[test]
    fn render_layout_style_resolves_border_radius_axes_and_longhands() {
        let wxss = parse_wxss(
            ".card { border-radius: 10px 20px / 30px 40px; border-bottom-left-radius: 5px 6px; }",
        )
        .unwrap();
        let declarations = resolve_wxss_style(&wxss, Some("view"), None, &["card"]);
        let style = render_layout_style(
            &declarations,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
        );
        assert_eq!(
            style.border_radius,
            [
                CornerRadius { x: 10.0, y: 30.0 },
                CornerRadius { x: 20.0, y: 40.0 },
                CornerRadius { x: 10.0, y: 30.0 },
                CornerRadius { x: 5.0, y: 6.0 },
            ]
        );
    }

    #[test]
    fn selector_fields_project_properties_styles_mark_node_and_context() {
        let ast = parse_wxml(
            r#"<canvas id="canvas" class="hero active" data-state="ready" mark:source="fixture" custom-prop="42" style="color: red; width: 12px" />"#,
        )
        .unwrap();
        let wxss = parse_wxss("canvas { color: blue; height: 24px; }").unwrap();
        let mut nodes = wxml_nodes_to_render(
            &ast.nodes,
            &wxss,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
            "",
            &[],
        )
        .unwrap();
        let mut root = RenderNode::new(
            "root",
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
        )
        .with_style(LayoutStyle {
            width: Some(200.0),
            height: Some(100.0),
            ..LayoutStyle::default()
        });
        root.children = std::mem::take(&mut nodes);
        layout_tree(
            &mut root,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 100.0,
            },
        );
        let node = root.children.first().unwrap();
        assert_eq!(node.attributes.get("custom-prop"), Some(&"42".into()));
        assert_eq!(node.mark.get("source"), Some(&"fixture".into()));
        assert_eq!(node.computed_style.get("color"), Some(&"red".into()));
        let fields = parse_selector_fields(Some(&json!({
            "id": true,
            "dataset": true,
            "mark": true,
            "rect": true,
            "size": true,
            "properties": ["custom-prop", "class"],
            "computedStyle": ["color", "background-color"],
            "node": true,
            "context": true,
        })))
        .unwrap();
        let value = selector_result(node, fields.as_ref(), "fields");
        assert_eq!(value["id"], "canvas");
        assert_eq!(value["dataset"]["state"], "ready");
        assert_eq!(value["mark"]["source"], "fixture");
        assert_eq!(value["custom-prop"], "42");
        assert_eq!(value["class"], "hero active");
        assert_eq!(value["color"], "red");
        assert_eq!(value["background-color"], "");
        assert_eq!(value["width"], 12.0);
        assert_eq!(value["height"], 24.0);
        assert_eq!(value["node"]["type"], "canvas");
        assert_eq!(value["context"]["type"], "canvas");
    }

    #[test]
    fn selector_fields_reject_malformed_property_and_style_lists() {
        let malformed = [
            json!({"properties": true}),
            json!({"properties": [1]}),
            json!({"computedStyle": "color"}),
            json!({"computedStyle": [false]}),
            json!({"rect": "yes"}),
        ];
        for value in malformed {
            assert!(parse_selector_fields(Some(&value)).is_err(), "{value}");
        }
    }

    #[test]
    fn render_layout_style_maps_wxss_position_offsets_and_negative_lengths() {
        let wxss = parse_wxss(
            ".dock { position: absolute; left: -2rpx; top: 4rpx; right: 10px; bottom: 6px; }",
        )
        .unwrap();
        let declarations = resolve_wxss_style(&wxss, Some("view"), None, &["dock"]);
        let style = render_layout_style(
            &declarations,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 750.0,
                height: 1_000.0,
            },
        );
        assert_eq!(style.position, PositionMode::Absolute);
        assert_eq!(style.left, Some(-2.0));
        assert_eq!(style.top, Some(4.0));
        assert_eq!(style.right, Some(10.0));
        assert_eq!(style.bottom, Some(6.0));
    }

    #[test]
    fn render_layout_style_preserves_reverse_flex_direction() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 200.0,
            height: 100.0,
        };
        for (value, expected) in [
            ("row", FlexDirection::Row),
            ("row-reverse", FlexDirection::RowReverse),
            ("column", FlexDirection::Column),
            ("column-reverse", FlexDirection::ColumnReverse),
        ] {
            let wxss = parse_wxss(&format!(".axis {{ flex-direction: {value}; }}")).unwrap();
            let declarations = resolve_wxss_style(&wxss, Some("view"), None, &["axis"]);
            assert_eq!(
                render_layout_style(&declarations, viewport).direction,
                expected
            );
        }
    }

    #[test]
    fn render_commit_expands_manifest_components_and_projects_named_slot_fallback() {
        let page_wxml = parse_wxml(
            r#"<card><text id="header" slot="header">Header</text><text wx:if="{{show}}" id="default">Default</text></card>"#,
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let component_wxml = parse_wxml(
            r#"<view id="card"><slot name="header"/><slot><text id="fallback">Default fallback</text></slot></view>"#,
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let page_hash = container_ir::hex_digest(&page_wxml);
        let component_hash = container_ir::hex_digest(&component_wxml);
        let mut render_manifest = manifest();
        render_manifest.templates.extend([
            Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: format!("sha256:{page_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            },
            Template {
                id: "template:components/card/index.wxml".into(),
                wxml_ast: format!("sha256:{component_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            },
        ]);
        render_manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components: [("card".into(), "components/card/index".into())]
                .into_iter()
                .collect(),
            multiple_slots: None,
        });
        render_manifest.components.push(Component {
            id: "components:components/card/index.json".into(),
            owner: "components/card/index.json".into(),
            using_components: BTreeMap::new(),
            multiple_slots: Some(true),
        });
        render_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(render_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "component-render",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "frameId": 12,
                "viewport": {"width": 200, "height": 300},
                "data": {"show": false},
                "blobs": {
                    format!("sha256:{page_hash}"): page_wxml,
                    format!("sha256:{component_hash}"): component_wxml,
                }
            }),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        let frame = session.renderer().last_frame().unwrap();
        assert_eq!(frame.query("#header", false).unwrap().len(), 1);
        assert_eq!(frame.query("#fallback", false).unwrap().len(), 1);
        assert_eq!(frame.query("#default", false).unwrap().len(), 0);
        assert!(frame.query("card", false).unwrap().is_empty());

        let response = session.dispatch(request(
            "component-render-default-slot",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "frameId": 13,
                "viewport": {"width": 200, "height": 300},
                "data": {"show": true},
                "blobs": {
                    format!("sha256:{page_hash}"): page_wxml,
                    format!("sha256:{component_hash}"): component_wxml,
                }
            }),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        let frame = session.renderer().last_frame().unwrap();
        assert_eq!(frame.query("#header", false).unwrap().len(), 1);
        assert_eq!(frame.query("#default", false).unwrap().len(), 1);
        assert_eq!(frame.query("#fallback", false).unwrap().len(), 0);
    }

    #[test]
    fn render_commit_isolates_repeated_component_property_scopes() {
        let page_wxml = parse_wxml(r#"<card title="A"/><card title="B"/>"#)
            .unwrap()
            .canonical_json()
            .unwrap();
        let component_wxml = parse_wxml(
            r#"<view><text id="value">{{title}}</text><text id="secret">{{secret}}</text></view>"#,
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let page_hash = container_ir::hex_digest(&page_wxml);
        let component_hash = container_ir::hex_digest(&component_wxml);
        let mut render_manifest = manifest();
        render_manifest.templates.extend([
            Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: format!("sha256:{page_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            },
            Template {
                id: "template:components/card/index.wxml".into(),
                wxml_ast: format!("sha256:{component_hash}"),
                bindings: vec!["title".into(), "secret".into()],
                wxs_modules: Default::default(),
            },
        ]);
        render_manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components: [("card".into(), "components/card/index".into())]
                .into_iter()
                .collect(),
            multiple_slots: None,
        });
        render_manifest.components.push(Component {
            id: "components:components/card/index.json".into(),
            owner: "components/card/index.json".into(),
            using_components: BTreeMap::new(),
            multiple_slots: None,
        });
        render_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(render_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "component-scope",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "frameId": 14,
                "viewport": {"width": 200, "height": 300},
                "data": {"secret": "parent-only"},
                "blobs": {
                    format!("sha256:{page_hash}"): page_wxml,
                    format!("sha256:{component_hash}"): component_wxml,
                }
            }),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        let frame = session.renderer().last_frame().unwrap();
        let values = frame.query("#value", true).unwrap();
        assert_eq!(values.len(), 2);
        assert_eq!(values[0].children[0].text.as_deref(), Some("A"));
        assert_eq!(values[1].children[0].text.as_deref(), Some("B"));
        let secrets = frame.query("#secret", true).unwrap();
        assert_eq!(secrets.len(), 2);
        assert!(secrets
            .iter()
            .all(|node| node.children[0].text.as_deref() == Some("")));
    }

    #[test]
    fn render_commit_rejects_manifest_blob_hash_mismatch() {
        let wxml = parse_wxml("<view />").unwrap().canonical_json().unwrap();
        let hash = container_ir::hex_digest(&wxml);
        let mut render_manifest = manifest();
        render_manifest.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: format!("sha256:{hash}"),
            bindings: Vec::new(),
            wxs_modules: Default::default(),
        });
        render_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(render_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "render-ir-invalid",
            op::RENDER_COMMIT,
            json!({
                "templateId": "template:pages/index/index.wxml",
                "blobs": {format!("sha256:{hash}"): [1, 2, 3]}
            }),
        ));
        assert_eq!(response.messages[0].payload["error"]["code"], "ERR_RENDER");
        assert!(session.renderer().last_frame().is_none());
    }

    #[test]
    fn data_patch_batch_updates_view_and_page() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        session.dispatch(request("p", op::PAGE_PUSH, json!({"path":"index"})));
        let response = session.dispatch(request("d", op::DATA_PATCH_BATCH, json!({"pageId":1,"patches":[{"path":"user.name","op":"set","value":"Ada"},{"path":"old","op":"delete"}]})));
        assert_eq!(response.messages[0].payload["changed"], 1);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["user"]["name"],
            "Ada"
        );
        assert_eq!(session.view().pending_patches.len(), 2);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_bridge_data_patches_remain_visible_to_javascript(engine: EngineKind) {
        let source = br#"App({}); Page({
            data: { count: 0, user: { name: 'initial' }, items: [{ count: 0 }, { count: 1 }], obsolete: true },
            onLoad() { this.savedData = this.data; this.savedItems = this.data.items; },
            observers: { count() { this.observerCount = (this.observerCount || 0) + 1; } },
            bump() { this.setData({ count: this.data.count + 1, 'items[1].count': this.data.items[1].count + 1 }); },
        });
        exports.read = function(index) {
            const page = getCurrentPages()[index];
            return { data: page.data, observers: page.observerCount || 0,
                prototypePolluted: Object.prototype.injected === true,
                dataIdentityRetained: page.savedData === page.data,
                arrayIdentityRetained: page.savedItems === page.data.items };
        };
        exports.freezeData = function(index) { Object.freeze(getCurrentPages()[index].data.user); return true; };
        exports.invalidPatch = function(index, path) {
            const page = getCurrentPages()[index];
            const patch = {count:999}; patch[path] = false;
            try { page.setData(patch); }
            catch (error) { return {rejected:true, data:page.data}; }
            return {rejected:false, data:page.data};
        };"#;
        let mut manifest = module_manifest(source, ModuleFormat::Commonjs);
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Partial);
        manifest.routes.push(container_ir::Route {
            id: "route:index".into(),
            path: "pages/index/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "app.js".into(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest.clone(),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init-sync",
            op::APP_INIT,
            json!({
                "modules": [{"id":"module:app", "source":String::from_utf8_lossy(source)}]
            }),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        // Two instances of one route must never share a data synchronization
        // target just because they share a Page registration index.
        for index in 0..2 {
            let push = session.dispatch(request(
                &format!("push-sync-{index}"),
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ));
            assert_eq!(push.messages[0].payload["ok"], true);
        }
        let ids = session
            .app_service()
            .pages()
            .iter()
            .map(|page| page.id)
            .collect::<Vec<_>>();
        let patches = vec![
            DataPatch::set("count", json!(40)),
            DataPatch::set("user.name", json!("patched")),
            DataPatch::set("items[1].count", json!(70)),
            DataPatch::delete("items[0].count"),
            DataPatch::delete("obsolete"),
            DataPatch::set("items[3].count", json!(12)),
            DataPatch::set("__proto__.injected", json!(true)),
        ];
        let response = session.dispatch(request(
            "patch-hidden",
            op::DATA_PATCH_BATCH,
            json!({"pageId": ids[0].0, "patches":patches}),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        assert_eq!(
            session.view().pending_patches.len(),
            patches.len(),
            "synchronizing JS must not emit duplicate setData effects"
        );
        let read = session.dispatch(request(
            "read-hidden",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[0]}),
        ));
        assert_eq!(read.messages[0].payload["ok"], true, "{:?}", read.messages);
        assert_eq!(
            read.messages[0].payload["result"][0]["data"],
            session.app_service().pages().get(ids[0]).unwrap().data,
            "bridge patches must update JS data as well as the Rust View"
        );
        assert_eq!(
            read.messages[0].payload["result"][0]["observers"], 0,
            "the engine mirror must not call user observers a second time"
        );
        assert_eq!(
            read.messages[0].payload["result"][0]["prototypePolluted"],
            false
        );
        assert_eq!(
            read.messages[0].payload["result"][0]["dataIdentityRetained"],
            true
        );
        assert_eq!(
            read.messages[0].payload["result"][0]["arrayIdentityRetained"],
            true
        );
        let current = session.dispatch(request(
            "read-current",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[1]}),
        ));
        assert_eq!(current.messages[0].payload["result"][0]["data"]["count"], 0);

        let response = session.dispatch(request(
            "patch-visible",
            op::DATA_PATCH_BATCH,
            json!({"pageId":ids[1].0, "patches":[
                DataPatch::set("count", json!(90)),
                DataPatch::set("items[1].count", json!(110)),
            ]}),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        // The manifest replacement used for style/template reload retains
        // both mirrors and their per-instance identity.
        session.replace_manifest(manifest).unwrap();
        let event = session.dispatch(request(
            "bump-visible",
            op::EVENT_BATCH,
            json!({
                "events":[{"type":"custom", "target":"button", "handler":"bump"}]
            }),
        ));
        assert_eq!(event.messages[0].payload["ok"], true);
        let page = session.app_service().pages().get(ids[1]).unwrap();
        assert_eq!(
            page.data["count"], 91,
            "a JS event must read the most recent bridge patch"
        );
        assert_eq!(page.data["items"][1]["count"], 111);
        assert!(
            page.data.get("items[1]").is_none(),
            "bracket paths must target arrays"
        );
        assert_eq!(
            session.app_service().pages().get(ids[0]).unwrap().data["count"],
            40
        );
        let read = session.dispatch(request(
            "read-after-event",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[1]}),
        ));
        assert_eq!(
            read.messages[0].payload["result"][0]["data"],
            session.app_service().pages().get(ids[1]).unwrap().data
        );
        assert_eq!(read.messages[0].payload["result"][0]["observers"], 1);

        let before = session
            .app_service()
            .pages()
            .get(ids[1])
            .unwrap()
            .data
            .clone();
        let rejected = session.dispatch(request(
            "reject-invalid-path",
            op::DATA_PATCH_BATCH,
            json!({"pageId":ids[1].0, "patches":[
                DataPatch::set("count", json!(999)),
                DataPatch::set("items[1", json!(false)),
            ]}),
        ));
        assert!(rejected.messages[0].payload.get("error").is_some());
        assert_eq!(
            session.app_service().pages().get(ids[1]).unwrap().data,
            before
        );
        let read = session.dispatch(request(
            "read-after-reject",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[1]}),
        ));
        assert_eq!(
            read.messages[0].payload["result"][0]["data"], before,
            "validation must reject the whole batch before touching JS"
        );

        for path in ["items[1", "items[1048576]", "items[9007199254740993]"] {
            let invalid_js = session.dispatch(request(
                "reject-js-path",
                op::MODULE_CALL,
                json!({"moduleId":"module:app", "export":"invalidPatch", "args":[1,path]}),
            ));
            assert_eq!(
                invalid_js.messages[0].payload["result"][0]["rejected"],
                true
            );
            assert_eq!(invalid_js.messages[0].payload["result"][0]["data"], before);
            let invalid_host = session.dispatch(request(
                "reject-host-path",
                op::DATA_PATCH_BATCH,
                json!({"pageId":ids[1].0,"patches":[DataPatch::set(path,json!(false))]}),
            ));
            assert!(invalid_host.messages[0].payload.get("error").is_some());
            assert_eq!(
                session.app_service().pages().get(ids[1]).unwrap().data,
                before
            );
        }

        session.dispatch(request(
            "freeze-current",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"freezeData", "args":[1]}),
        ));
        let frozen = session.dispatch(request(
            "reject-frozen-batch",
            op::DATA_PATCH_BATCH,
            json!({"pageId":ids[1].0,"patches":[
                DataPatch::set("count",json!(999)),
                DataPatch::set("user.name",json!("must not partially apply")),
            ]}),
        ));
        assert_eq!(frozen.messages[0].payload["error"]["code"], "ERR_ENGINE");
        let read = session.dispatch(request(
            "read-after-frozen-batch",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[1]}),
        ));
        assert_eq!(read.messages[0].payload["result"][0]["data"], before);
        assert_eq!(
            session.app_service().pages().get(ids[1]).unwrap().data,
            before
        );

        session.dispatch(request("pop-sync", op::PAGE_POP, json!({})));
        let stale = session.dispatch(request(
            "reject-disposed-page",
            op::DATA_PATCH_BATCH,
            json!({"pageId":ids[1].0, "patches":[DataPatch::set("count", json!(999))]}),
        ));
        assert!(stale.messages[0].payload.get("error").is_some());
        let read = session.dispatch(request(
            "read-survivor",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"read", "args":[0]}),
        ));
        assert_eq!(
            read.messages[0].payload["result"][0]["data"]["count"], 40,
            "a disposed page id must not fall back to the visible instance"
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_bridge_data_patches_remain_visible_to_javascript() {
        assert_bridge_data_patches_remain_visible_to_javascript(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_bridge_data_patches_remain_visible_to_javascript() {
        assert_bridge_data_patches_remain_visible_to_javascript(EngineKind::V8);
    }

    #[test]
    fn event_batch_returns_capture_target_bubble_dispatches() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "event",
            op::EVENT_BATCH,
            json!({
                "events": [{
                    "type": "tap",
                    "id": "tap-1",
                    "target": "button",
                    "path": ["page", "panel", "button"],
                    "capture": true,
                    "bubbles": true,
                    "dataset": {"id": "save"},
                    "detail": {"x": 4}
                }]
            }),
        ));
        assert_eq!(response.messages[0].payload["events"], 1);
        assert_eq!(
            response.messages[0].payload["dispatches"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(
            response.messages[0].payload["dispatches"][0]["phase"],
            "capture"
        );
        assert_eq!(
            response.messages[0].payload["dispatches"][2]["phase"],
            "target"
        );
        assert_eq!(
            response.messages[0].payload["dispatches"][4]["phase"],
            "bubble"
        );
        assert_eq!(
            response.messages[0].payload["dispatches"][2]["dataset"]["id"],
            "save"
        );
        assert_eq!(session.view().event_count, 1);
    }

    #[test]
    fn event_batch_rejects_a_path_that_does_not_end_at_target() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "event-invalid",
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","target":"button","path":["page","other"]}]}),
        ));
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert_eq!(session.view().event_count, 0);
    }

    #[test]
    fn unsupported_api_has_stable_error_code() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "a",
            op::API_CALL,
            json!({"name":"wx.requestPayment"}),
        ));
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
    }

    #[test]
    fn can_i_use_returns_matrix_result_for_unknown_capability() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let response = session.dispatch(request(
            "a",
            op::API_CALL,
            json!({"name":"wx.canIUse", "capability":"wx.camera"}),
        ));
        assert_eq!(response.messages[0].payload["ok"], true);
        assert_eq!(response.messages[0].payload["result"], false);
        assert_eq!(response.messages[0].payload["support"], "unsupported");

        let supported = session.dispatch(request(
            "b",
            op::API_CALL,
            json!({"name":"wx.canIUse", "capability":"wx.navigateTo"}),
        ));
        assert_eq!(supported.messages[0].payload["result"], true);
        assert_eq!(supported.messages[0].payload["support"], "partial");
    }

    #[test]
    fn can_i_use_accepts_public_short_api_names() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));

        let short = session.dispatch(request(
            "short",
            op::API_CALL,
            json!({"name": "wx.canIUse", "capability": "request"}),
        ));
        assert_eq!(short.messages[0].payload["result"], true);
        assert_eq!(short.messages[0].payload["support"], "partial");

        let component = session.dispatch(request(
            "component",
            op::API_CALL,
            json!({"name": "wx.canIUse", "capability": "button.open-type.getUserInfo"}),
        ));
        assert_eq!(component.messages[0].payload["result"], false);
        assert_eq!(component.messages[0].payload["support"], "unsupported");
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn network_status_change_updates_provider_and_invokes_quickjs_listeners() {
        let source = br#"exports.register = function() {
          globalThis.__network_statuses = [];
          wx.onNetworkStatusChange(function(status) { globalThis.__network_statuses.push(status); });
          return wx.canIUse('wx.onNetworkStatusChange');
        };
        exports.statuses = function() { return globalThis.__network_statuses || []; };"#;
        let mut app_manifest = module_manifest(source, ModuleFormat::Commonjs);
        app_manifest.capabilities.insert(
            "wx.onNetworkStatusChange".into(),
            CapabilitySupport::Partial,
        );
        app_manifest
            .capabilities
            .insert("wx.getNetworkType".into(), CapabilitySupport::Partial);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "network-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let register = session.dispatch(request(
            "network-register",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"register","args":[]}),
        ));
        assert_eq!(register.messages[0].payload["result"], json!([true]));

        let transition = session
            .notify_network_status_change(NetworkType::FourG)
            .expect("network status transition");
        assert_eq!(transition.messages[0].op, op::EVENT_BATCH);
        assert_eq!(
            transition.messages[0].payload["networkStatus"]["networkType"],
            "4g"
        );
        let effects = transition
            .messages
            .iter()
            .find(|message| {
                message.op == op::EVENT_BATCH && message.payload.get("effects").is_some()
            })
            .expect("listener effect batch");
        assert_eq!(
            effects.payload["effects"][0]["events"][0]["type"],
            "network.status.change"
        );
        assert_eq!(
            effects.payload["effects"][0]["events"][0]["status"]["networkType"],
            "4g"
        );
        let statuses = session.dispatch(request(
            "network-status",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"statuses","args":[]}),
        ));
        assert_eq!(
            statuses.messages[0].payload["result"][0]["networkType"],
            "4g"
        );
        let current = session.dispatch(request(
            "network-current",
            op::API_CALL,
            json!({"name":"wx.getNetworkType"}),
        ));
        assert_eq!(current.messages[0].payload["result"]["networkType"], "4g");
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn network_status_change_updates_provider_and_invokes_v8_listeners() {
        let source = br#"exports.register = function() {
          globalThis.__network_statuses = [];
          wx.onNetworkStatusChange(function(status) { globalThis.__network_statuses.push(status); });
          return wx.canIUse('wx.onNetworkStatusChange');
        };
        exports.statuses = function() { return globalThis.__network_statuses || []; };"#;
        let mut app_manifest = module_manifest(source, ModuleFormat::Commonjs);
        app_manifest.capabilities.insert(
            "wx.onNetworkStatusChange".into(),
            CapabilitySupport::Partial,
        );
        app_manifest
            .capabilities
            .insert("wx.getNetworkType".into(), CapabilitySupport::Partial);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "v8-network-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let register = session.dispatch(request(
            "v8-network-register",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"register","args":[]}),
        ));
        assert_eq!(register.messages[0].payload["result"], json!([true]));
        let transition = session
            .notify_network_status_change(NetworkType::FiveG)
            .expect("network status transition");
        assert_eq!(
            transition.messages[0].payload["networkStatus"]["networkType"],
            "5g"
        );
        let statuses = session.dispatch(request(
            "v8-network-status",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"statuses","args":[]}),
        ));
        assert_eq!(
            statuses.messages[0].payload["result"][0]["networkType"],
            "5g"
        );
        let current = session.dispatch(request(
            "v8-network-current",
            op::API_CALL,
            json!({"name":"wx.getNetworkType"}),
        ));
        assert_eq!(current.messages[0].payload["result"]["networkType"], "5g");
    }

    #[test]
    fn account_info_sync_uses_provider_identity_and_rejects_invalid_env_version() {
        let mut account_manifest = manifest();
        account_manifest
            .capabilities
            .insert("wx.getAccountInfoSync".into(), CapabilitySupport::Full);
        account_manifest.refresh_integrity().unwrap();

        let mut session = Session::new(account_manifest.clone(), SessionConfig::default()).unwrap();
        session.set_provider(Box::new(SandboxProvider::new().with_account_info(
            "wx-account-fixture",
            "trial",
            "2.0.0",
        )));
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let account = session.dispatch(request(
            "account",
            op::API_CALL,
            json!({"name": "wx.getAccountInfoSync"}),
        ));
        assert_eq!(account.messages[0].payload["ok"], true);
        assert_eq!(
            account.messages[0].payload["result"],
            json!({
                "miniProgram": {
                    "appId": "wx-account-fixture",
                    "envVersion": "trial",
                    "version": "2.0.0"
                },
                "plugin": {}
            })
        );
        let capability = session.dispatch(request(
            "account-capability",
            op::API_CALL,
            json!({"name": "wx.canIUse", "capability": "getAccountInfoSync"}),
        ));
        assert_eq!(capability.messages[0].payload["result"], true);
        assert_eq!(capability.messages[0].payload["support"], "full");

        let mut invalid = Session::new(account_manifest, SessionConfig::default()).unwrap();
        invalid.set_provider(Box::new(SandboxProvider::new().with_account_info(
            "wx-account-fixture",
            "preview",
            "2.0.0",
        )));
        invalid.dispatch(request("init-invalid", op::APP_INIT, json!({})));
        let response = invalid.dispatch(request(
            "account-invalid",
            op::API_CALL,
            json!({"name": "wx.getAccountInfoSync"}),
        ));
        assert_eq!(response.messages[0].payload["ok"], false);
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
    }

    #[test]
    fn provider_and_navigation_apis_return_structured_results() {
        let mut provider_manifest = manifest();
        for name in [
            "wx.getSystemInfoSync",
            "wx.getSystemInfo",
            "wx.getBatteryInfo",
            "wx.getBatteryInfoSync",
            "wx.getScreenBrightness",
            "wx.setScreenBrightness",
            "wx.getAccountInfoSync",
            "wx.getExtConfigSync",
            "wx.getExtConfig",
            "wx.request",
            "wx.setClipboardData",
            "wx.getClipboardData",
            "wx.showToast",
            "wx.hideToast",
            "wx.showModal",
            "wx.showActionSheet",
            "wx.pageScrollTo",
            "wx.setNavigationBarColor",
            "wx.setNavigationBarTitle",
            "wx.scanCode",
            "wx.startLocationUpdate",
            "wx.stopLocationUpdate",
            "wx.createInnerAudioContext",
            "wx.createVideoContext",
        ] {
            provider_manifest.capabilities.insert(
                name.into(),
                if name == "wx.getAccountInfoSync" {
                    CapabilitySupport::Full
                } else {
                    CapabilitySupport::Partial
                },
            );
        }
        provider_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(provider_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new()
                .with_system_info(SystemInfoSnapshot {
                    brand: "Weapp Container Test Device".into(),
                    model: "container-test".into(),
                    pixel_ratio: 2.0,
                    language: "en_US".into(),
                    sdk_version: "3.17.3".into(),
                    status_bar_height: 24,
                    device_orientation: "landscape".into(),
                    theme: "dark".into(),
                    font_size_setting: 20.0,
                })
                .expect("system info fixture should validate")
                .with_ext_config(json!({"source": "fixture", "revision": 2})),
        ));
        session.dispatch(request("i", op::APP_INIT, json!({})));

        let page = session.dispatch(request(
            "page",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        assert_eq!(page.messages[0].payload["ok"], true);
        let title = session.dispatch(request(
            "title",
            op::API_CALL,
            json!({"name":"wx.setNavigationBarTitle", "title":"Saved"}),
        ));
        assert_eq!(title.messages[0].payload["ok"], true);
        assert_eq!(
            title.messages[0].payload["errMsg"],
            "setNavigationBarTitle:ok"
        );
        assert_eq!(
            title.messages[0].payload["page"]["navigationBarTitle"],
            "Saved"
        );
        assert_eq!(
            session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .navigation_bar_title,
            "Saved"
        );
        let clear_title = session.dispatch(request(
            "clear-title",
            op::API_CALL,
            json!({"name":"wx.setNavigationBarTitle", "title":""}),
        ));
        assert_eq!(clear_title.messages[0].payload["ok"], true);
        assert!(clear_title.messages[0].payload["page"]
            .get("navigationBarTitle")
            .is_none());
        assert!(session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .navigation_bar_title
            .is_empty());

        let system = session.dispatch(request(
            "system",
            op::API_CALL,
            json!({"name":"wx.getSystemInfoSync"}),
        ));
        assert_eq!(system.messages[0].payload["ok"], true);
        assert_eq!(system.messages[0].payload["provider"], "sandbox");
        assert_eq!(system.messages[0].payload["result"]["SDKVersion"], "3.17.3");
        assert_eq!(
            system.messages[0].payload["result"]["brand"],
            "Weapp Container Test Device"
        );
        assert_eq!(system.messages[0].payload["result"]["pixelRatio"], 2.0);
        assert_eq!(system.messages[0].payload["result"]["theme"], "dark");

        let system_async = session.dispatch(request(
            "system-async",
            op::API_CALL,
            json!({"name":"wx.getSystemInfo"}),
        ));
        assert_eq!(system_async.messages[0].payload["ok"], true);
        assert_eq!(
            system_async.messages[0].payload["result"]["errMsg"],
            "getSystemInfo:ok"
        );
        assert_eq!(
            system_async.messages[0].payload["result"]["fontSizeSetting"],
            20.0
        );

        let battery = session.dispatch(request(
            "battery",
            op::API_CALL,
            json!({"name":"wx.getBatteryInfo"}),
        ));
        assert_eq!(battery.messages[0].payload["result"]["level"], 100);
        assert_eq!(
            battery.messages[0].payload["result"]["errMsg"],
            "getBatteryInfo:ok"
        );
        let battery_sync = session.dispatch(request(
            "battery-sync",
            op::API_CALL,
            json!({"name":"wx.getBatteryInfoSync"}),
        ));
        assert_eq!(
            battery_sync.messages[0].payload["result"]["errMsg"],
            "getBatteryInfoSync:ok"
        );

        let brightness = session.dispatch(request(
            "brightness",
            op::API_CALL,
            json!({"name":"wx.getScreenBrightness"}),
        ));
        assert_eq!(brightness.messages[0].payload["ok"], true);
        assert_eq!(
            brightness.messages[0].payload["result"]["errMsg"],
            "getScreenBrightness:ok"
        );
        assert_eq!(brightness.messages[0].payload["result"]["value"], 1.0);
        let set_brightness = session.dispatch(request(
            "brightness-set",
            op::API_CALL,
            json!({"name":"wx.setScreenBrightness", "value":0.42}),
        ));
        assert_eq!(set_brightness.messages[0].payload["ok"], true);
        assert_eq!(
            set_brightness.messages[0].payload["result"]["errMsg"],
            "setScreenBrightness:ok"
        );
        let brightness_after = session.dispatch(request(
            "brightness-after",
            op::API_CALL,
            json!({"name":"wx.getScreenBrightness"}),
        ));
        assert_eq!(
            brightness_after.messages[0].payload["result"]["value"],
            0.42
        );

        let account = session.dispatch(request(
            "account-info",
            op::API_CALL,
            json!({"name":"wx.getAccountInfoSync"}),
        ));
        assert_eq!(account.messages[0].payload["ok"], true);
        assert_eq!(
            account.messages[0].payload["result"]["miniProgram"]["envVersion"],
            "develop"
        );

        let ext_sync = session.dispatch(request(
            "ext-config-sync",
            op::API_CALL,
            json!({"name":"wx.getExtConfigSync"}),
        ));
        assert_eq!(
            ext_sync.messages[0].payload["result"]["extConfig"]["source"],
            "fixture"
        );
        let ext_async = session.dispatch(request(
            "ext-config-async",
            op::API_CALL,
            json!({"name":"wx.getExtConfig"}),
        ));
        assert_eq!(
            ext_async.messages[0].payload["result"]["extConfig"]["revision"],
            2
        );
        assert_eq!(
            ext_async.messages[0].payload["result"]["errMsg"],
            "getExtConfig:ok"
        );

        let request_result = session.dispatch(request(
            "request",
            op::API_CALL,
            json!({"name":"wx.request", "url":"https://example.test/data"}),
        ));
        assert_eq!(
            request_result.messages[0].payload["result"]["statusCode"],
            200
        );

        let clipboard = session.dispatch(request(
            "clipboard",
            op::API_CALL,
            json!({"name":"wx.setClipboardData", "data":"hello"}),
        ));
        assert_eq!(clipboard.messages[0].payload["ok"], true);
        let read_clipboard = session.dispatch(request(
            "clipboard-read",
            op::API_CALL,
            json!({"name":"wx.getClipboardData"}),
        ));
        assert_eq!(
            read_clipboard.messages[0].payload["result"]["data"],
            "hello"
        );

        let toast = session.dispatch(request(
            "toast",
            op::API_CALL,
            json!({"name":"wx.showToast", "title":"Saved"}),
        ));
        assert_eq!(
            toast.messages[0].payload["result"]["errMsg"],
            "showToast:ok"
        );
        let modal = session.dispatch(request(
            "modal",
            op::API_CALL,
            json!({"name":"wx.showModal", "content":"Continue?"}),
        ));
        assert_eq!(modal.messages[0].payload["result"]["confirm"], true);
        let action = session.dispatch(request(
            "action-sheet",
            op::API_CALL,
            json!({"name":"wx.showActionSheet", "itemList":["One"]}),
        ));
        assert_eq!(action.messages[0].payload["result"]["tapIndex"], 0);
        let scroll = session.dispatch(request(
            "scroll",
            op::API_CALL,
            json!({"name":"wx.pageScrollTo", "scrollTop":120}),
        ));
        // A provider record cannot stand in for an actual page/frame scroll.
        assert_eq!(scroll.messages[0].payload["error"]["code"], "ERR_RENDER");
        let nav_bar = session.dispatch(request(
            "nav-bar",
            op::API_CALL,
            json!({"name":"wx.setNavigationBarColor", "frontColor":"#ffffff", "backgroundColor":"#000000"}),
        ));
        assert_eq!(
            nav_bar.messages[0].payload["result"]["errMsg"],
            "setNavigationBarColor:ok"
        );
        session.set_provider(Box::new(
            SandboxProvider::new()
                .grant("photos/camera")
                .grant("location"),
        ));
        let scan = session.dispatch(request(
            "scan",
            op::API_CALL,
            json!({"name":"wx.scanCode", "scanType":["qrCode"]}),
        ));
        assert_eq!(scan.messages[0].payload["result"]["errMsg"], "scanCode:ok");
        let location_start = session.dispatch(request(
            "location-start",
            op::API_CALL,
            json!({"name":"wx.startLocationUpdate", "type":"gcj02"}),
        ));
        assert_eq!(
            location_start.messages[0].payload["result"]["errMsg"],
            "startLocationUpdate:ok"
        );
        let audio_create = session.dispatch(request(
            "audio-create",
            op::API_CALL,
            json!({"name":"wx.innerAudioContext", "contextId":"audio-1", "command":"create"}),
        ));
        assert_eq!(audio_create.messages[0].payload["result"]["paused"], true);
        let audio_play_without_source = session.dispatch(request(
            "audio-play-invalid",
            op::API_CALL,
            json!({"name":"wx.innerAudioContext", "contextId":"audio-1", "command":"play"}),
        ));
        assert_eq!(audio_play_without_source.messages[0].payload["ok"], false);
        assert_eq!(
            audio_play_without_source.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );

        let video_create = session.dispatch(request(
            "video-create",
            op::API_CALL,
            json!({"name":"wx.videoContext", "contextId":"video-1", "videoId":"hero", "command":"create"}),
        ));
        assert_eq!(video_create.messages[0].payload["ok"], true);
        let video_play = session.dispatch(request(
            "video-play",
            op::API_CALL,
            json!({"name":"wx.videoContext", "contextId":"video-1", "command":"play"}),
        ));
        assert_eq!(video_play.messages[0].payload["result"]["playing"], true);
        let video_bad_direction = session.dispatch(request(
            "video-direction",
            op::API_CALL,
            json!({"name":"wx.videoContext", "contextId":"video-1", "command":"requestFullScreen", "direction":"landscape"}),
        ));
        assert_eq!(
            video_bad_direction.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );

        let camera_can_use = session.dispatch(request(
            "camera-can-use",
            op::API_CALL,
            json!({"name":"wx.canIUse", "capability":"wx.createCameraContext"}),
        ));
        assert_eq!(camera_can_use.messages[0].payload["result"], true);
        let camera_create = session.dispatch(request(
            "camera-create",
            op::API_CALL,
            json!({"name":"wx.cameraContext", "contextId":"camera-1", "command":"create"}),
        ));
        assert_eq!(
            camera_create.messages[0].payload["result"]["recording"],
            false
        );
        let camera_capture = session.dispatch(request(
            "camera-capture",
            op::API_CALL,
            json!({"name":"wx.cameraContext", "contextId":"camera-1", "command":"takePhoto", "quality":"high"}),
        ));
        assert_eq!(camera_capture.messages[0].payload["ok"], false);
        assert_eq!(
            camera_capture.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );

        let navigate = session.dispatch(request(
            "navigate",
            op::API_CALL,
            json!({"name":"wx.navigateTo", "url":"pages/detail/index", "query":{"id":7}}),
        ));
        assert_eq!(navigate.messages[0].payload["ok"], true);
        assert_eq!(navigate.messages[0].payload["page"]["query"]["id"], "7");
    }

    #[test]
    fn permission_apis_expose_scope_state_and_stable_denials() {
        let mut permission_manifest = manifest();
        for name in [
            "wx.authorize",
            "wx.openSetting",
            "wx.getSetting",
            "wx.getAppAuthorizeSetting",
        ] {
            permission_manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        permission_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(permission_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(SandboxProvider::new().grant("location")));
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let can_use = session.dispatch(request(
            "can-use",
            op::API_CALL,
            json!({"name": "wx.canIUse", "capability": "wx.getSetting"}),
        ));
        assert_eq!(can_use.messages[0].payload["result"], true);

        let authorized = session.dispatch(request(
            "authorize",
            op::API_CALL,
            json!({"name": "wx.authorize", "scope": "scope.userLocation"}),
        ));
        assert_eq!(
            authorized.messages[0].payload["result"]["errMsg"],
            "authorize:ok"
        );

        let settings = session.dispatch(request(
            "settings",
            op::API_CALL,
            json!({"name": "wx.getSetting"}),
        ));
        assert_eq!(
            settings.messages[0].payload["result"]["errMsg"],
            "getSetting:ok"
        );
        assert_eq!(
            settings.messages[0].payload["result"]["authSetting"]["scope.userLocation"],
            true
        );
        assert_eq!(
            settings.messages[0].payload["result"]["authSetting"]["scope.camera"],
            false
        );

        let app_settings = session.dispatch(request(
            "app-settings",
            op::API_CALL,
            json!({"name": "wx.getAppAuthorizeSetting"}),
        ));
        assert_eq!(
            app_settings.messages[0].payload["result"]["locationAuthorized"],
            "authorized"
        );
        assert_eq!(
            app_settings.messages[0].payload["result"]["cameraAuthorized"],
            "not determined"
        );

        let denied = session.dispatch(request(
            "denied",
            op::API_CALL,
            json!({"name": "wx.authorize", "scope": "scope.camera"}),
        ));
        assert_eq!(
            denied.messages[0].payload["error"]["code"],
            "ERR_PERMISSION_DENIED"
        );

        let opened = session.dispatch(request(
            "open-setting",
            op::API_CALL,
            json!({"name": "wx.openSetting"}),
        ));
        assert_eq!(
            opened.messages[0].payload["result"]["errMsg"],
            "openSetting:ok"
        );
    }

    #[test]
    fn provider_auth_session_keeps_login_and_check_session_stateful() {
        let mut provider_manifest = manifest();
        for name in ["wx.login", "wx.checkSession"] {
            provider_manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        provider_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(provider_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new()
                .grant("account")
                .with_login_code("runtime-login-code"),
        ));
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let before_login = session.dispatch(request(
            "check-before-login",
            op::API_CALL,
            json!({"name": "wx.checkSession"}),
        ));
        assert_eq!(
            before_login.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert_eq!(
            before_login.messages[0].payload["error"]["message"],
            "checkSession:fail session expired"
        );

        let login = session.dispatch(request("login", op::API_CALL, json!({"name": "wx.login"})));
        assert_eq!(
            login.messages[0].payload["result"]["code"],
            "runtime-login-code"
        );
        assert_eq!(login.messages[0].payload["result"]["errMsg"], "login:ok");

        let after_login = session.dispatch(request(
            "check-after-login",
            op::API_CALL,
            json!({"name": "wx.checkSession"}),
        ));
        assert_eq!(
            after_login.messages[0].payload["result"]["errMsg"],
            "checkSession:ok"
        );
    }

    #[test]
    fn provider_user_profile_requires_desc_and_preserves_snapshot_shape() {
        let mut provider_manifest = manifest();
        provider_manifest
            .capabilities
            .insert("wx.getUserProfile".into(), CapabilitySupport::Partial);
        provider_manifest.refresh_integrity().unwrap();
        let profile = UserProfileSnapshot {
            nick_name: "Ada".into(),
            avatar_url: "https://example.test/avatar.png".into(),
            gender: 1,
            country: "US".into(),
            province: "CA".into(),
            city: "San Francisco".into(),
            language: "en".into(),
        };
        let mut session = Session::new(provider_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new()
                .grant("profile")
                .with_user_profile(profile.clone()),
        ));
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let missing_desc = session.dispatch(request(
            "profile-missing-desc",
            op::API_CALL,
            json!({"name": "wx.getUserProfile"}),
        ));
        assert_eq!(
            missing_desc.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert!(missing_desc.messages[0].payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("desc"));

        let success = session.dispatch(request(
            "profile-success",
            op::API_CALL,
            json!({"name": "wx.getUserProfile", "desc": "Personalize your profile"}),
        ));
        assert_eq!(success.messages[0].payload["ok"], true);
        assert_eq!(
            success.messages[0].payload["result"]["errMsg"],
            "getUserProfile:ok"
        );
        assert_eq!(
            success.messages[0].payload["result"]["userInfo"],
            serde_json::to_value(profile).unwrap()
        );
        let raw_data = success.messages[0].payload["result"]["rawData"]
            .as_str()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(raw_data).unwrap(),
            success.messages[0].payload["result"]["userInfo"]
        );
        assert_eq!(success.messages[0].payload["result"]["encryptedData"], "");
        assert_eq!(success.messages[0].payload["result"]["iv"], "");
    }

    #[test]
    fn provider_save_file_copies_content_and_reports_missing_temp_path() {
        let mut provider_manifest = manifest();
        // Keep only the historical manager capability here to verify that
        // legacy manifests still negotiate the global wx.saveFile alias.
        provider_manifest
            .capabilities
            .insert("wx.getFileSystemManager".into(), CapabilitySupport::Partial);
        provider_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(provider_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new().seed_file("/tmp/source.txt", "hello"),
        ));
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let saved = session.dispatch(request(
            "save",
            op::API_CALL,
            json!({
                "name": "wx.saveFile",
                "tempFilePath": "/tmp/source.txt",
                "filePath": "/saved/report.txt"
            }),
        ));
        assert_eq!(saved.messages[0].payload["ok"], true);
        assert_eq!(
            saved.messages[0].payload["result"]["savedFilePath"],
            "saved/report.txt"
        );

        let read = session.dispatch(request(
            "read",
            op::API_CALL,
            json!({"name":"wx.fs.readFile", "filePath":"/saved/report.txt"}),
        ));
        assert_eq!(read.messages[0].payload["result"]["data"], "hello");

        let missing = session.dispatch(request(
            "missing",
            op::API_CALL,
            json!({"name":"wx.saveFile", "tempFilePath":"/tmp/missing.txt"}),
        ));
        assert_eq!(
            missing.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert!(missing.messages[0].payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tempFilePath not found"));
    }

    #[test]
    fn provider_network_errors_preserve_permission_timeout_and_cancel_codes() {
        let mut provider_manifest = manifest();
        provider_manifest
            .capabilities
            .insert("wx.request".into(), CapabilitySupport::Partial);
        provider_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(provider_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let denied = session.dispatch(request(
            "denied",
            op::API_CALL,
            json!({"name":"wx.request", "url":"deny://network"}),
        ));
        assert_eq!(
            denied.messages[0].payload["error"]["code"],
            "ERR_PERMISSION_DENIED"
        );

        let timed_out = session.dispatch(request(
            "timeout",
            op::API_CALL,
            json!({"name":"wx.request", "url":"timeout://network"}),
        ));
        assert_eq!(
            timed_out.messages[0].payload["error"]["code"],
            "ERR_TIMEOUT"
        );

        session.dispatch(request(
            "cancel",
            op::CANCEL,
            json!({"cancelToken":"network-request"}),
        ));
        let mut cancelled = request(
            "cancelled-request",
            op::API_CALL,
            json!({"name":"wx.request", "url":"https://example.test"}),
        );
        cancelled.cancel_token = Some("network-request".into());
        assert_eq!(
            session.dispatch(cancelled).messages[0].payload["error"]["code"],
            "ERR_CANCELLED"
        );

        let mut expired = request(
            "expired-request",
            op::API_CALL,
            json!({"name":"wx.request", "url":"https://example.test"}),
        );
        expired.deadline_ns = Some(1);
        assert_eq!(
            session.dispatch(expired).messages[0].payload["error"]["code"],
            "ERR_TIMEOUT"
        );
    }

    #[test]
    fn navigation_target_separates_and_decodes_url_query() {
        let mut app_manifest = manifest();
        app_manifest.routes.push(container_ir::Route {
            id: "route:detail".into(),
            path: "pages/detail/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "pages/detail/index.js".into(),
        });
        let (path, query) = navigation_target(
            &app_manifest,
            "wx.navigateTo",
            Some("/pages/detail/index?id=7&name=hello%20world#ignored"),
            Some(&json!({"id": 8, "flag": true})),
        )
        .expect("navigation URL is valid");
        assert_eq!(path.as_deref(), Some("pages/detail/index"));
        assert_eq!(query["id"], "8");
        assert_eq!(query["name"], "hello world");
        assert_eq!(query["flag"], "true");
    }

    #[test]
    fn switch_tab_requires_declared_tab_route() {
        let mut app_manifest = manifest();
        app_manifest.routes.push(container_ir::Route {
            id: "route:page".into(),
            path: "pages/index/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        let error = navigation_target(
            &app_manifest,
            "wx.switchTab",
            Some("pages/index/index"),
            None,
        )
        .expect_err("switchTab must reject a non-tab route");
        assert!(error.to_string().contains("requires a tab route"));
    }

    #[test]
    fn navigate_to_and_redirect_to_reject_tab_routes_before_stack_mutation() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        app_manifest
            .capabilities
            .insert("wx.redirectTo".into(), CapabilitySupport::Partial);
        app_manifest.routes.push(container_ir::Route {
            id: "route:home".into(),
            path: "pages/home/index".into(),
            kind: container_ir::RouteKind::Tab,
            config: None,
            entry_module: "pages/home/index.js".into(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));

        for (id, name) in [
            ("navigate-tab", "wx.navigateTo"),
            ("redirect-tab", "wx.redirectTo"),
        ] {
            let result = session.dispatch(request(
                id,
                op::API_CALL,
                json!({"name": name, "url": "pages/home/index"}),
            ));
            assert_eq!(
                result.messages[0].payload["error"]["code"], "ERR_INVALID_REQUEST",
                "{name} should reject tab routes"
            );
            assert_eq!(session.app_service().pages().len(), 0);
        }
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_navigation_rejects_tab_route_before_lifecycle() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        app_manifest.routes.push(container_ir::Route {
            id: "route:home".into(),
            path: "pages/home/index".into(),
            kind: container_ir::RouteKind::Tab,
            config: None,
            entry_module: "pages/home/index.js".into(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::Quickjs,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));
        let result = session.dispatch(request(
            "navigate-tab",
            op::API_CALL,
            json!({"name": "wx.navigateTo", "url": "pages/home/index"}),
        ));
        assert_eq!(
            result.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert!(session.app_service().pages().is_empty());
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_navigation_rejects_tab_route_before_lifecycle() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        app_manifest.routes.push(container_ir::Route {
            id: "route:home".into(),
            path: "pages/home/index".into(),
            kind: container_ir::RouteKind::Tab,
            config: None,
            entry_module: "pages/home/index.js".into(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            app_manifest,
            SessionConfig {
                engine: EngineKind::V8,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));
        let result = session.dispatch(request(
            "navigate-tab",
            op::API_CALL,
            json!({"name": "wx.navigateTo", "url": "pages/home/index"}),
        ));
        assert_eq!(
            result.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert!(session.app_service().pages().is_empty());
    }

    #[test]
    fn switch_tab_unloads_nested_pages_and_reuses_cached_tab_state() {
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.switchTab".into(), CapabilitySupport::Partial);
        app_manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        app_manifest.routes.extend([
            container_ir::Route {
                id: "route:home".into(),
                path: "pages/home/index".into(),
                kind: container_ir::RouteKind::Tab,
                config: None,
                entry_module: "pages/home/index.js".into(),
            },
            container_ir::Route {
                id: "route:settings".into(),
                path: "pages/settings/index".into(),
                kind: container_ir::RouteKind::Tab,
                config: None,
                entry_module: "pages/settings/index.js".into(),
            },
            container_ir::Route {
                id: "route:detail".into(),
                path: "pages/detail/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/detail/index.js".into(),
            },
        ]);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.dispatch(request("init", op::APP_INIT, json!({})));

        let home = session.dispatch(request(
            "home",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/home/index"}),
        ));
        assert_eq!(home.messages[0].payload["ok"], true);
        let home_id = home.messages[0].payload["pageId"].as_u64().unwrap();
        session.dispatch(request(
            "patch-home",
            op::DATA_PATCH_BATCH,
            json!({
                "pageId": home_id,
                "patches": [{"path": "selected", "op": "set", "value": "home"}]
            }),
        ));

        session.dispatch(request(
            "detail",
            op::API_CALL,
            json!({"name": "wx.navigateTo", "url": "pages/detail/index"}),
        ));
        assert_eq!(session.app_service().pages().len(), 2);
        let settings = session.dispatch(request(
            "settings",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/settings/index"}),
        ));
        assert_eq!(settings.messages[0].payload["ok"], true);
        assert_eq!(session.app_service().pages().len(), 1);
        assert_eq!(
            session.app_service().pages().current().unwrap().path,
            "pages/settings/index"
        );
        assert!(session.app_service().pages().get(PageId(home_id)).is_none());

        let home_again = session.dispatch(request(
            "home-again",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/home/index"}),
        ));
        assert_eq!(home_again.messages[0].payload["ok"], true);
        assert_eq!(home_again.messages[0].payload["pageId"], home_id);
        let page = session.app_service().pages().current().unwrap();
        assert_eq!(page.path, "pages/home/index");
        assert_eq!(page.data["selected"], "home");
        assert_eq!(session.app_service().pages().len(), 1);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_switch_tab_does_not_hide_an_already_hidden_tab_root() {
        let source = br#"
            globalThis.__navLog = [];
            App({});
            Page({
              onLoad() { globalThis.__navLog.push('home.load'); },
              onShow() { globalThis.__navLog.push('home.show'); },
              onReady() { globalThis.__navLog.push('home.ready'); },
              onHide() { globalThis.__navLog.push('home.hide'); }
            });
            Page({ onUnload() { globalThis.__navLog.push('detail.unload'); } });
            Page({
              onLoad() { globalThis.__navLog.push('settings.load'); },
              onShow() { globalThis.__navLog.push('settings.show'); },
              onReady() { globalThis.__navLog.push('settings.ready'); },
              onHide() { globalThis.__navLog.push('settings.hide'); }
            });
            exports.readLog = () => globalThis.__navLog;
        "#;
        let mut app_manifest = manifest();
        app_manifest
            .capabilities
            .insert("wx.switchTab".into(), CapabilitySupport::Partial);
        app_manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.routes.extend([
            container_ir::Route {
                id: "route:home".into(),
                path: "pages/home/index".into(),
                kind: container_ir::RouteKind::Tab,
                config: None,
                entry_module: "pages/home/index.js".into(),
            },
            container_ir::Route {
                id: "route:detail".into(),
                path: "pages/detail/index".into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "pages/detail/index.js".into(),
            },
            container_ir::Route {
                id: "route:settings".into(),
                path: "pages/settings/index".into(),
                kind: container_ir::RouteKind::Tab,
                config: None,
                entry_module: "pages/settings/index.js".into(),
            },
        ]);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules": [{"id": "module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "home",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/home/index"}),
        ));
        session.dispatch(request(
            "detail",
            op::API_CALL,
            json!({"name": "wx.navigateTo", "url": "pages/detail/index"}),
        ));
        session.dispatch(request(
            "settings",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/settings/index"}),
        ));
        session.dispatch(request(
            "home-again",
            op::API_CALL,
            json!({"name": "wx.switchTab", "url": "pages/home/index"}),
        ));
        let log = session.dispatch(request(
            "log",
            op::MODULE_CALL,
            json!({"moduleId": "module:app.js", "export": "readLog", "args": []}),
        ));
        let values = log.messages[0].payload["result"].as_array().unwrap();
        assert_eq!(values[0], "home.load");
        assert_eq!(values[1], "home.show");
        assert_eq!(values[2], "home.ready");
        assert_eq!(values[3], "home.hide");
        assert_eq!(values[4], "detail.unload");
        assert_eq!(values[5], "settings.load");
        assert_eq!(values[6], "settings.show");
        assert_eq!(values[7], "settings.ready");
        assert_eq!(values[8], "settings.hide");
        assert_eq!(values[9], "home.show");
        assert_eq!(values.len(), 10);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_sync_provider_snapshot_and_filesystem_manager_are_available_to_modules() {
        let source = br#"
            const initial = wx.getSystemInfoSync();
            const appBase = wx.getAppBaseInfo();
            const device = wx.getDeviceInfo();
            const window = wx.getWindowInfo();
            const menu = wx.getMenuButtonBoundingClientRect();
            const launch = wx.getLaunchOptionsSync();
            App({});
            Page({});
            exports.run = function() {
              const manager = wx.getFileSystemManager();
              const syncData = manager.readFileSync('/hello.txt', 'utf8');
              manager.readFile({
                filePath: '/hello.txt',
                success(value) { globalThis.__file_data = value.data; },
                complete() { globalThis.__file_complete = true; }
              });
              return {
                sdk: initial.SDKVersion,
                appVersion: appBase.version,
                platform: device.platform,
                width: window.windowWidth,
                menuWidth: menu.width,
                menuHeight: menu.height,
                scene: launch.scene,
                hasRead: typeof manager.readFile === 'function',
                syncData
              };
            };
            exports.status = function() {
              return { data: globalThis.__file_data, complete: !!globalThis.__file_complete };
            };
        "#;
        let mut app_manifest = manifest();
        for name in [
            "wx.getSystemInfoSync",
            "wx.getAppBaseInfo",
            "wx.getDeviceInfo",
            "wx.getWindowInfo",
            "wx.getMenuButtonBoundingClientRect",
            "wx.getLaunchOptionsSync",
            "wx.getFileSystemManager",
        ] {
            app_manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        app_manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new().seed_file("/hello.txt", "hello"),
        ));
        let init = session.dispatch(request(
            "sync-provider-init",
            op::APP_INIT,
            json!({"modules": [{"id":"module:app.js", "source": String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let run = session.dispatch(request(
            "sync-provider-run",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js", "export":"run", "args": []}),
        ));
        assert_eq!(run.messages[0].payload["result"][0]["sdk"], "3.17.3");
        assert_eq!(run.messages[0].payload["result"][0]["width"], 0);
        assert_eq!(run.messages[0].payload["result"][0]["menuWidth"], 0);
        assert_eq!(run.messages[0].payload["result"][0]["menuHeight"], 0);
        assert_eq!(run.messages[0].payload["result"][0]["hasRead"], true);
        assert_eq!(run.messages[0].payload["result"][0]["syncData"], "hello");
        let status = session.dispatch(request(
            "sync-provider-status",
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js", "export":"status", "args": []}),
        ));
        assert_eq!(status.messages[0].payload["result"][0]["data"], "hello");
        assert_eq!(status.messages[0].payload["result"][0]["complete"], true);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn storage_engine_bridge_conformance(engine: EngineKind) {
        let source = br#"
          wx.setStorageSync('module-scope', { value: 1 });
          wx.onNetworkStatusChange(function() {
            wx.setStorageSync('network', wx.getStorageSync('host'));
          });
          exports.write = function() {
            wx.setStorageSync('script', { value: 2 });
            wx.setStorageSync('undefined', undefined);
            wx.setStorageSync('null', null);
            return true;
          };
          exports.read = function() {
            const host = wx.getStorageSync('host');
            return { module: wx.getStorageSync('module-scope'), host: host,
              script: wx.getStorageSync('script'),
              undefinedValue: wx.getStorageSync('undefined') === undefined,
              nullValue: wx.getStorageSync('null') === null };
          };
          exports.throwAfterWrite = function() {
            wx.setStorageSync('before-throw', 9);
            throw new Error('expected fixture error');
          };
          exports.remove = function() { wx.removeStorageSync('script'); };
          exports.clear = function() { wx.clearStorageSync(); };
          exports.schedule = function() {
            setTimeout(function() { wx.setStorageSync('timer', wx.getStorageSync('host')); }, 1);
          };
        "#;
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
        assert_eq!(
            session.app_service().storage().get("module-scope"),
            Some(&json!({"value":1}))
        );
        let call = |session: &mut Session, export: &str| {
            session.dispatch(request(
                export,
                op::MODULE_CALL,
                json!({"moduleId":"module:app", "export":export, "args":[]}),
            ))
        };
        assert_eq!(call(&mut session, "write").messages[0].payload["ok"], true);
        assert_eq!(
            session.app_service().storage().get("script"),
            Some(&json!({"value":2}))
        );
        assert!(session.app_service().storage().is_undefined("undefined"));
        let host = session.dispatch(request(
            "host",
            op::API_CALL,
            json!({"name":"wx.setStorageSync", "key":"host", "data":{"value":3}}),
        ));
        assert_eq!(host.messages[0].payload["result"], Value::Null);
        let read = call(&mut session, "read");
        assert_eq!(
            read.messages[0].payload["result"][0],
            json!({
                "module":{"value":1},"host":{"value":3},"script":{"value":2},
                "undefinedValue":true,"nullValue":true
            })
        );
        let get = session.dispatch(request(
            "get",
            op::API_CALL,
            json!({"name":"wx.getStorageSync", "key":"script"}),
        ));
        assert_eq!(get.messages[0].payload["result"], json!({"value":2}));
        assert_eq!(
            call(&mut session, "schedule").messages[0].payload["ok"],
            true
        );
        session.dispatch(request(
            "host-before-timer",
            op::API_CALL,
            json!({"name":"wx.setStorageSync", "key":"host", "data":{"value":4}}),
        ));
        let timer_events = session.poll_timers(u64::MAX);
        assert_eq!(
            session.app_service().storage().get("timer"),
            Some(&json!({"value":4}))
        );
        let timer_kind = if engine == EngineKind::V8 {
            "v8.timer"
        } else {
            "quickjs.timer"
        };
        assert!(timer_events
            .messages
            .iter()
            .any(|message| message.payload["type"] == timer_kind));
        assert!(session.poll_timers(u64::MAX).messages.is_empty());
        session.dispatch(request(
            "host-before-network",
            op::API_CALL,
            json!({"name":"wx.setStorageSync", "key":"host", "data":{"value":5}}),
        ));
        session
            .notify_network_status_change(NetworkType::FiveG)
            .unwrap();
        assert_eq!(
            session.app_service().storage().get("network"),
            Some(&json!({"value":5}))
        );
        let failure = call(&mut session, "throwAfterWrite");
        assert_eq!(failure.messages[0].payload["ok"], false);
        assert_eq!(
            session.app_service().storage().get("before-throw"),
            Some(&json!(9))
        );
        assert_eq!(call(&mut session, "remove").messages[0].payload["ok"], true);
        assert!(!session.app_service().storage().contains_key("script"));
        assert_eq!(call(&mut session, "clear").messages[0].payload["ok"], true);
        assert!(session.app_service().storage().is_empty());
        drop(session);

        // Lazy module.load has its own batch boundary; module-scope writes
        // must already be visible before any exported function is called.
        let mut lazy = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        lazy.dispatch(request("lazy-init", op::APP_INIT, json!({})));
        let loaded = lazy.dispatch(request(
            "lazy-load",
            op::MODULE_LOAD,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(loaded.messages[0].payload["ok"], true);
        assert_eq!(
            lazy.app_service().storage().get("module-scope"),
            Some(&json!({"value":1}))
        );
        let mut restored = container_core::MemoryStorage::default();
        restored.set("host", json!({"value":8})).unwrap();
        *lazy.app_service_mut().storage_mut() = restored;
        let read = call(&mut lazy, "read");
        assert_eq!(
            read.messages[0].payload["result"][0]["host"],
            json!({"value":8})
        );
        assert_eq!(read.messages[0].payload["result"][0]["module"], "");
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_storage_engine_and_host_share_one_store() {
        storage_engine_bridge_conformance(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_storage_engine_and_host_share_one_store() {
        storage_engine_bridge_conformance(EngineKind::V8);
    }

    #[test]
    fn storage_bridge_preserves_async_failure_and_sync_value_shapes() {
        let mut session = session();
        session.dispatch(request("init", op::APP_INIT, json!({})));
        let missing = session.dispatch(request(
            "missing",
            op::API_CALL,
            json!({"name":"wx.getStorage", "key":"absent"}),
        ));
        assert_eq!(missing.messages[0].payload["ok"], false);
        assert_eq!(missing.messages[0].payload["found"], false);
        assert_eq!(
            missing.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert_eq!(
            missing.messages[0].payload["error"]["errMsg"],
            "wx.getStorage:fail data not found"
        );
        let sync = session.dispatch(request(
            "sync",
            op::API_CALL,
            json!({"name":"wx.getStorageSync", "key":"absent"}),
        ));
        assert_eq!(sync.messages[0].payload["ok"], true);
        assert_eq!(sync.messages[0].payload["result"], "");
        session.dispatch(request(
            "undefined",
            op::API_CALL,
            json!({"name":"wx.setStorageSync", "key":"value", "undefined":true}),
        ));
        let value = session.dispatch(request(
            "get-undefined",
            op::API_CALL,
            json!({"name":"wx.getStorage", "key":"value"}),
        ));
        assert_eq!(value.messages[0].payload["ok"], true);
        assert_eq!(value.messages[0].payload["found"], true);
        assert_eq!(value.messages[0].payload["undefined"], true);
        assert!(value.messages[0].payload["result"].get("data").is_none());
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn initial_page_data_conformance(engine: EngineKind) {
        let source = br#"
          Page({ data: { title: 'registered', keep: true, nested: { default: 1 } } });
          Page({ data: { title: 'before-load', keep: true }, onLoad() {
            this.setData({ observed: this.data.title, title: 'loaded' });
          }});
          exports.snapshot = function() { return { pages: getCurrentPages().map(page => ({ route: page.route, data: page.data })) }; };
        "#;
        let mut manifest = module_manifest(source, ModuleFormat::Commonjs);
        for path in ["static", "hooks"] {
            manifest.routes.push(container_ir::Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: container_ir::RouteKind::Page,
                config: None,
                entry_module: "module:app".into(),
            });
        }
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let push = session.dispatch(request("first", op::PAGE_PUSH, json!({"path":"static"})));
        assert_eq!(push.messages[0].payload["ok"], true);
        let defaults = json!({"title":"registered", "keep":true, "nested":{"default":1}});
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            defaults
        );
        let duplicate = session.dispatch(request(
            "duplicate",
            op::PAGE_PUSH,
            json!({"path":"static","data":{"title":"injected","nested":{"override":2}}}),
        ));
        assert_eq!(duplicate.messages[0].payload["ok"], true);
        let overrides = json!({"title":"injected","keep":true,"nested":{"override":2}});
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            overrides
        );
        assert_eq!(
            session.app_service().pages().iter().next().unwrap().data,
            defaults
        );
        let snapshot = session.dispatch(request(
            "snapshot",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"snapshot","args":[]}),
        ));
        assert_eq!(
            snapshot.messages[0].payload["result"][0]["pages"][0]["data"],
            defaults
        );
        assert_eq!(
            snapshot.messages[0].payload["result"][0]["pages"][1]["data"],
            overrides
        );

        let hooks = session.dispatch(request(
            "hooks",
            op::PAGE_PUSH,
            json!({"path":"hooks","data":{"title":"cli-value","extra":3}}),
        ));
        assert_eq!(hooks.messages[0].payload["ok"], true);
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"title":"loaded","keep":true,"observed":"cli-value","extra":3})
        );
        let replacement = session.dispatch(request(
            "replace",
            op::PAGE_REPLACE,
            json!({"path":"static","data":{"title":"replacement"}}),
        ));
        assert_eq!(replacement.messages[0].payload["ok"], true);
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"title":"replacement","keep":true,"nested":{"default":1}})
        );
        let navigation = session.dispatch(request(
            "navigate",
            op::API_CALL,
            json!({"name":"wx.navigateTo","url":"static"}),
        ));
        assert_eq!(navigation.messages[0].payload["ok"], true);
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            defaults
        );
        let current_id = session.app_service().pages().current().unwrap().id;
        let invalid = session.dispatch(request(
            "invalid",
            op::PAGE_PUSH,
            json!({"path":"hooks","data":[]}),
        ));
        assert_eq!(invalid.messages[0].payload["ok"], false);
        assert_eq!(
            session.app_service().pages().current().unwrap().id,
            current_id
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_initial_page_data_is_shared_before_lifecycle() {
        initial_page_data_conformance(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_initial_page_data_is_shared_before_lifecycle() {
        initial_page_data_conformance(EngineKind::V8);
    }

    #[test]
    fn storage_api_uses_session_scoped_memory_and_reports_missing_keys() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let set = session.dispatch(request(
            "set",
            op::API_CALL,
            json!({"name":"wx.setStorage", "key":"greeting", "data":{"text":"hello"}}),
        ));
        assert_eq!(set.messages[0].payload["ok"], true);
        let get = session.dispatch(request(
            "get",
            op::API_CALL,
            json!({"name":"wx.getStorage", "key":"greeting"}),
        ));
        assert_eq!(get.messages[0].payload["found"], true);
        assert_eq!(get.messages[0].payload["data"]["text"], "hello");
        let remove = session.dispatch(request(
            "remove",
            op::API_CALL,
            json!({"name":"wx.removeStorage", "key":"greeting"}),
        ));
        assert_eq!(remove.messages[0].payload["removed"], true);
        let missing = session.dispatch(request(
            "missing",
            op::API_CALL,
            json!({"name":"wx.getStorage", "key":"greeting"}),
        ));
        assert_eq!(missing.messages[0].payload["found"], false);
        assert_eq!(session.app_service().storage().len(), 0);
    }

    #[test]
    fn timer_api_can_schedule_poll_and_cancel_without_native_threads() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let set = session.dispatch(request(
            "timer",
            op::API_CALL,
            json!({"name":"setTimeout", "delayMs":1, "callbackId":"cb"}),
        ));
        let timer_id = set.messages[0].payload["timerId"].as_u64().unwrap();
        let due_ns = session
            .app_service()
            .timers()
            .entries()
            .find(|entry| entry.id.0 == timer_id)
            .unwrap()
            .due_ns;
        let fired = session.poll_timers(due_ns);
        assert_eq!(fired.messages.len(), 1);
        assert_eq!(fired.messages[0].payload["timers"][0]["callbackId"], "cb");

        let interval = session.dispatch(request(
            "interval",
            op::API_CALL,
            json!({"name":"setInterval", "delayMs":10}),
        ));
        let interval_id = interval.messages[0].payload["timerId"].as_u64().unwrap();
        let clear = session.dispatch(request(
            "clear",
            op::API_CALL,
            json!({"name":"clearInterval", "timerId":interval_id}),
        ));
        assert_eq!(clear.messages[0].payload["cancelled"], true);
        assert!(session
            .app_service()
            .timers()
            .entries()
            .all(|entry| entry.id.0 != interval_id));
    }

    #[test]
    fn selector_query_reads_committed_frame_in_tree_order() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let frame = json!({
            "frameId": 1,
            "viewport": {"x": 0.0, "y": 0.0, "width": 320.0, "height": 640.0},
            "root": {
                "id": "root",
                "tag": "view",
                "bounds": {"x": 0.0, "y": 0.0, "width": 320.0, "height": 640.0},
                "opacity": 1.0,
                "children": [
                    {
                        "id": "hero",
                        "tag": "view",
                        "classes": ["card", "primary"],
                        "dataset": {"itemId": "42"},
                        "attributes": {"id":"hero","data-sim-scope": "component"},
                        "bounds": {"x": 10.0, "y": 20.0, "width": 100.0, "height": 40.0},
                        "opacity": 1.0,
                        "children": []
                    },
                    {
                        "id": "copy",
                        "attributes": {"id":"copy"},
                        "tag": "text",
                        "classes": ["card"],
                        "bounds": {"x": 10.0, "y": 80.0, "width": 100.0, "height": 20.0},
                        "opacity": 1.0,
                        "children": []
                    }
                ]
            }
        });
        let committed = session.dispatch(request("frame", op::RENDER_COMMIT, frame));
        assert_eq!(committed.messages[0].payload["ok"], true);
        let one = session.dispatch(request(
            "select-one",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":".card"}),
        ));
        assert_eq!(one.messages[0].payload["count"], 1);
        assert_eq!(one.messages[0].payload["result"]["id"], "hero");
        assert_eq!(one.messages[0].payload["result"]["right"], 110.0);
        let all = session.dispatch(request(
            "select-all",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":".card","all":true,"fields":["id","width"]}),
        ));
        assert_eq!(all.messages[0].payload["count"], 2);
        assert_eq!(all.messages[0].payload["result"][1]["id"], "copy");
        assert_eq!(all.messages[0].payload["result"][0]["width"], 100.0);

        let fields = session.dispatch(request(
            "select-fields",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"#hero","fields":["id","dataset"]}),
        ));
        assert_eq!(
            fields.messages[0].payload["result"]["dataset"]["itemId"],
            "42"
        );

        // mpcore's selector fields use a boolean object for projections.  A
        // size-only query must return width/height without leaking the
        // bounding rectangle or node identity, while `class` follows the
        // normalized WXML class token order.
        let projected = session.dispatch(request(
            "select-projection",
            op::API_CALL,
            json!({
                "name":"wx.createSelectorQuery",
                "selector":"#hero",
                "operation":"fields",
                "fields":{"size":true,"properties":["class"]}
            }),
        ));
        assert_eq!(projected.messages[0].payload["result"]["width"], 100.0);
        assert_eq!(projected.messages[0].payload["result"]["height"], 40.0);
        assert_eq!(
            projected.messages[0].payload["result"]["class"],
            "card primary"
        );
        assert!(projected.messages[0].payload["result"].get("id").is_none());
        assert!(projected.messages[0].payload["result"]
            .get("left")
            .is_none());

        let scoped = session.dispatch(request(
            "select-scoped",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":".card","scopeId":"component","all":true}),
        ));
        assert_eq!(scoped.messages[0].payload["count"], 1);
        assert_eq!(scoped.messages[0].payload["result"][0]["id"], "hero");

        let batch = session.dispatch(request(
            "select-batch",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","queries":[
                {"selector":"#hero","operation":"fields","fields":{"dataset":true,"id":false}},
                {"selector":".card","all":true,"fields":["id"]},
                {"selector":"#missing"},
                {"selector":".card","scopeId":"destroyed-component","all":true},
                {"target":"viewport","operation":"scrollOffset"}
            ]}),
        ));
        assert_eq!(batch.messages[0].payload["ok"], true);
        let result = &batch.messages[0].payload["result"];
        assert_eq!(result.as_array().unwrap().len(), 5);
        assert_eq!(result[0], json!({"dataset":{"itemId":"42"}}));
        assert_eq!(result[1], json!([{"id":"hero"},{"id":"copy"}]));
        assert!(result[2].is_null());
        assert_eq!(result[3], json!([]));
        assert_eq!(result[4]["scrollTop"], 0.0);

        // Missing scopes must return the same empty result through the
        // legacy direct request, never fall through to the global frame.
        let gone = session.dispatch(request(
            "select-disposed-scope",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":".card","scopeId":"destroyed-component"}),
        ));
        assert!(gone.messages[0].payload["result"].is_null());
        assert_eq!(gone.messages[0].payload["count"], 0);

        let invalid = session.dispatch(request(
            "select-invalid-batch",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","queries":[{"selector":"#hero"},{"selector":"view:hover"}]}),
        ));
        assert_eq!(invalid.messages[0].payload["ok"], false);
        assert_eq!(
            invalid.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn native_selector_batch_conformance(engine: EngineKind) {
        let source = br#"
          const trace = [];
          let result, failure;
          exports.query = function() {
            const query = wx.createSelectorQuery();
            query.select('#hero').fields({id:false,dataset:true}, value => trace.push(['fields',value]));
            query.selectAll('.card').boundingClientRect(value => trace.push(['all',value.length]));
            query.select('#missing').boundingClientRect(value => trace.push(['missing',value]));
            query.exec(values => trace.push(['exec',values.length])).then(values => {result=values;}, error => {failure=error.code;});
          };
          exports.state = function() { return {trace, result, failure:failure || null}; };
        "#;
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let init = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        let frame = session.dispatch(request("frame", op::RENDER_COMMIT, json!({
            "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},
            "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                {"id":"hero","attributes":{"id":"hero"},"classes":["card"],"dataset":{"enabled":"false"},"bounds":{"x":1.0,"y":2.0,"width":30.0,"height":40.0},"opacity":1.0,"children":[]}
            ]}
        })));
        assert_eq!(frame.messages[0].payload["ok"], true);
        let run = session.dispatch(request(
            "query",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"query"}),
        ));
        assert_eq!(run.messages[0].payload["ok"], true);
        let state = session.dispatch(request(
            "state",
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":"state"}),
        ));
        let value = &state.messages[0].payload["result"][0];
        assert_eq!(
            value["trace"],
            json!([
                ["fields",{"dataset":{"enabled":"false"}}],["all",1],["missing",null],["exec",3]
            ])
        );
        assert_eq!(value["result"][0], json!({"dataset":{"enabled":"false"}}));
        assert_eq!(value["result"][1][0]["id"], "hero");
        assert_eq!(value["result"][1][0]["width"], 30.0);
        assert!(value["result"][2].is_null());
        assert!(value["failure"].is_null());
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_selector_batch_reaches_frame_and_callbacks_through_provider() {
        native_selector_batch_conformance(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_selector_batch_reaches_frame_and_callbacks_through_provider() {
        native_selector_batch_conformance(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_native_selector_capability_denial(engine: EngineKind) {
        let source = br#"
          let callbackCount = 0;
          let result = null;
          const failures = [];
          const rawFailures = [];
          exports.query = function() {
            const supported = wx.canIUse('createSelectorQuery');
            // Deliberately call even when canIUse is false. The runtime boundary
            // must enforce negotiation rather than trusting application branches.
            const query = wx.createSelectorQuery();
            query.select('#hero').fields({id:true}, () => { callbackCount += 1; });
            query.selectAll('.card').boundingClientRect(() => { callbackCount += 1; });
            query.exec(() => { callbackCount += 1; }).then(
              value => { result = value; },
              error => { failures.push(error); }
            );
            return supported;
          };
          // Simulate an engine effect which bypasses the public facade. The
          // shared Rust helper must independently enforce the same capability.
          exports.rawQuery = function() {
            __container_api_call('wx.createSelectorQuery', {queries:[{selector:'#hero',operation:'fields',fields:{id:true}}]}).then(
              value => { result = value; callbackCount += 1; },
              error => { rawFailures.push(error); }
            );
          };
          exports.state = function() { return {callbackCount, result, failures, rawFailures}; };
        "#;
        for denial in ["manifest", "host", "undeclared"] {
            let mut manifest = module_manifest(source, ModuleFormat::Commonjs);
            let mut config = SessionConfig {
                engine,
                ..SessionConfig::default()
            };
            match denial {
                "manifest" => {
                    manifest.capabilities.insert(
                        "wx.createSelectorQuery".into(),
                        CapabilitySupport::Unsupported,
                    );
                }
                "host" => {
                    config.capabilities.insert(
                        "wx.createSelectorQuery".into(),
                        CapabilitySupport::Unsupported,
                    );
                }
                "undeclared" => {
                    manifest.capabilities.remove("wx.createSelectorQuery");
                }
                _ => unreachable!(),
            }
            manifest.refresh_integrity().unwrap();
            let mut session = Session::new(manifest, config).unwrap();
            let init = session.dispatch(request(
                "init",
                op::APP_INIT,
                json!({
                    "modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]
                }),
            ));
            assert_eq!(init.messages[0].payload["ok"], true, "{denial}");
            let frame = session.dispatch(request("frame", op::RENDER_COMMIT, json!({
                "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                    {"id":"hero","classes":["card"],"bounds":{"x":1.0,"y":2.0,"width":30.0,"height":40.0},"opacity":1.0,"children":[]}
                ]}
            })));
            assert_eq!(frame.messages[0].payload["ok"], true, "{denial}");

            // Both public bridge forms already enforce the same negotiation;
            // aliases must not reopen the capability at the common helper.
            for name in ["wx.createSelectorQuery", "SelectorQuery"] {
                for payload in [
                    json!({"name":name,"selector":"#hero"}),
                    json!({"name":name,"queries":[{"selector":"#hero"},{"selector":".card","all":true}]}),
                ] {
                    let direct = session.dispatch(request("direct-denied", op::API_CALL, payload));
                    assert_eq!(direct.messages[0].payload["ok"], false, "{denial}/{name}");
                    assert_eq!(
                        direct.messages[0].payload["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                        "{denial}/{name}"
                    );
                }
            }

            for _ in 0..2 {
                let raw = session.dispatch(request(
                    "raw-native-denied",
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app","export":"rawQuery"}),
                ));
                assert_eq!(raw.messages[0].payload["ok"], true, "{denial}");
                let run = session.dispatch(request(
                    "native-denied",
                    op::MODULE_CALL,
                    json!({
                        "moduleId":"module:app","export":"query"
                    }),
                ));
                assert_eq!(run.messages[0].payload["ok"], true, "{denial}");
                assert_eq!(
                    run.messages[0].payload["result"][0], false,
                    "canIUse: {denial}"
                );
            }
            let state = session.dispatch(request(
                "state",
                op::MODULE_CALL,
                json!({
                    "moduleId":"module:app","export":"state"
                }),
            ));
            assert_eq!(state.messages[0].payload["ok"], true, "{denial}");
            let value = &state.messages[0].payload["result"][0];
            assert_eq!(value["callbackCount"], 0, "success callbacks: {denial}");
            assert!(value["result"].is_null(), "geometry result: {denial}");
            let failures = value["failures"].as_array().unwrap();
            assert_eq!(
                failures.len(),
                2,
                "one rejection for each native query: {denial}"
            );
            for failure in failures {
                assert_eq!(failure["code"], "ERR_UNSUPPORTED_CAPABILITY", "{denial}");
                assert!(
                    failure["errMsg"]
                        .as_str()
                        .unwrap()
                        .starts_with("wx.createSelectorQuery:fail "),
                    "{denial}"
                );
            }
            let raw_failures = value["rawFailures"].as_array().unwrap();
            assert_eq!(raw_failures.len(), 2, "raw provider effects: {denial}");
            for failure in raw_failures {
                assert_eq!(failure["code"], "ERR_UNSUPPORTED_CAPABILITY", "{denial}");
                assert_eq!(failure["retryable"], false, "{denial}");
                assert!(
                    failure["errMsg"]
                        .as_str()
                        .unwrap()
                        .starts_with("wx.createSelectorQuery:fail "),
                    "{denial}"
                );
            }
            assert_eq!(
                session.skia_backend.renderer.last_frame().unwrap().frame_id,
                1,
                "{denial}"
            );
        }
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_selector_capability_denial_rejects_native_and_bridge_queries() {
        assert_native_selector_capability_denial(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_selector_capability_denial_rejects_native_and_bridge_queries() {
        assert_native_selector_capability_denial(EngineKind::V8);
    }

    #[test]
    fn pointer_event_uses_committed_hit_test_and_dataset() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        session.dispatch(request(
            "frame",
            op::RENDER_COMMIT,
            json!({
                "frameId": 1,
                "viewport": {"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "root": {"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                    {"id":"button","tag":"button","dataset":{"action":"save"},"bounds":{"x":10.0,"y":10.0,"width":40.0,"height":20.0},"opacity":1.0,"children":[]}
                ]}
            }),
        ));
        let event = session.dispatch(request(
            "tap",
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":15.0,"y":15.0}]}),
        ));
        assert_eq!(
            event.messages[0].payload["dispatches"][0]["target"],
            "button"
        );
        assert_eq!(
            event.messages[0].payload["dispatches"][0]["dataset"]["action"],
            "save"
        );
    }

    fn commit_pointer_input_test_frame(session: &mut Session) {
        let committed = session.dispatch(request(
            "pointer-frame",
            op::RENDER_COMMIT,
            json!({
                "frameId": 1,
                "viewport": {"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                // Empty space inside the viewport is also a legal miss. A
                // host-side viewport filter alone cannot implement this.
                "root": {"id":"root","bounds":{"x":10.0,"y":10.0,"width":80.0,"height":80.0},"opacity":1.0,"children":[
                    {"id":"button","attributes":{"bindtap":"onButton"},"dataset":{"action":"save"},"bounds":{"x":10.0,"y":10.0,"width":40.0,"height":20.0},"opacity":1.0,"children":[]}
                ]}
            }),
        ));
        assert_eq!(committed.messages[0].payload["ok"], true);
    }

    #[test]
    fn pointer_viewport_boundary_preserves_interior_overflow_and_rejects_padding() {
        let mut runtime = session();
        runtime.dispatch(request("init", op::APP_INIT, json!({})));
        let committed = runtime.dispatch(request(
            "overflow-frame",
            op::RENDER_COMMIT,
            json!({
                "frameId": 1,
                "viewport": {"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "root": {"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                    {"id":"component-host","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":0.0},"opacity":1.0,"children":[
                        {"id":"native-wrapper","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":0.0},"opacity":1.0,"children":[
                            {"id":"marker","bounds":{"x":24.0,"y":32.0,"width":64.0,"height":48.0},"opacity":1.0,"children":[]},
                            {"id":"top-left-overflow","bounds":{"x":-10.0,"y":-10.0,"width":20.0,"height":20.0},"opacity":1.0,"children":[]},
                            {"id":"bottom-right-overflow","bounds":{"x":90.0,"y":90.0,"width":30.0,"height":30.0},"opacity":1.0,"children":[]}
                        ]}
                    ]}
                ]}
            }),
        ));
        assert_eq!(committed.messages[0].payload["ok"], true);
        let frame = runtime.skia_backend.renderer.last_frame().unwrap();
        assert_eq!(
            frame
                .root
                .hit_test_path(40.0, 48.0)
                .iter()
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>(),
            vec!["root", "component-host", "native-wrapper", "marker"]
        );
        // These descendants genuinely overflow the frame; ordinary tree
        // targeting alone would select them beyond the presented pixels.
        for (x, y, target) in [
            (-1.0, 5.0, "top-left-overflow"),
            (5.0, -1.0, "top-left-overflow"),
            (100.0, 95.0, "bottom-right-overflow"),
            (95.0, 100.0, "bottom-right-overflow"),
            (115.0, 115.0, "bottom-right-overflow"),
        ] {
            assert_eq!(
                frame.root.hit_test(x, y).map(|node| node.id.as_str()),
                Some(target)
            );
        }
        let revision = runtime.view.revision;
        let event_count = runtime.view.event_count;
        let misses = runtime.dispatch(request(
            "padding-misses",
            op::EVENT_BATCH,
            json!({"events":[
                {"type":"tap","x":-1.0,"y":5.0},
                {"type":"tap","clientX":5.0,"clientY":-1.0},
                {"type":"tap","x":100.0,"y":95.0},
                {"type":"tap","x":95.0,"y":100.0},
                {"type":"tap","x":115.0,"y":115.0}
            ]}),
        ));
        assert_eq!(misses.messages[0].payload["ok"], true);
        assert_eq!(misses.messages[0].payload["events"], 0);
        assert_eq!(misses.messages[0].payload["dispatches"], json!([]));
        assert_eq!(misses.messages[0].payload["hooks"], json!([]));
        assert_eq!(runtime.view.revision, revision);
        assert_eq!(runtime.view.event_count, event_count);

        let interior = runtime.dispatch(request(
            "interior-overflow",
            op::EVENT_BATCH,
            json!({"events":[
                {"type":"tap","x":40.0,"y":48.0,"bubbles":true},
                {"type":"tap","x":99.0,"y":95.0,"bubbles":false}
            ]}),
        ));
        assert_eq!(interior.messages[0].payload["ok"], true);
        assert_eq!(interior.messages[0].payload["events"], 2);
        let dispatches = interior.messages[0].payload["dispatches"]
            .as_array()
            .unwrap();
        assert_eq!(
            dispatches
                .iter()
                .map(|dispatch| dispatch["current_target"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec![
                "marker",
                "native-wrapper",
                "component-host",
                "root",
                "bottom-right-overflow"
            ]
        );
    }

    #[test]
    fn pointer_misses_are_accepted_without_dispatch_or_view_invalidation() {
        let mut runtime = session();
        runtime.dispatch(request("init", op::APP_INIT, json!({})));
        commit_pointer_input_test_frame(&mut runtime);
        let revision = runtime.view.revision;
        let event_count = runtime.view.event_count;
        let frame_id = runtime.view.last_frame_id;

        let missed = runtime.dispatch(request(
            "misses",
            op::EVENT_BATCH,
            json!({"events":[
                {"type":"pointermove","x":-1.0,"y":20.0},
                {"type":"tap","x":150.0,"y":20.0},
                {"type":"wheel","clientX":5.0,"clientY":5.0}
            ]}),
        ));
        let response = &missed.messages[0].payload;
        assert_eq!(response["ok"], true);
        assert_eq!(response["events"], 0);
        assert_eq!(response["dispatches"], json!([]));
        assert_eq!(response["hooks"], json!([]));
        assert_eq!(response["revision"], revision);
        assert_eq!(runtime.view.revision, revision);
        assert_eq!(runtime.view.event_count, event_count);
        assert_eq!(runtime.view.last_frame_id, frame_id);
        assert!(missed
            .messages
            .iter()
            .all(|message| message.op != op::ERROR));
    }

    #[test]
    fn pointer_misses_keep_malformed_explicit_route_and_missing_frame_errors() {
        let mut runtime = session();
        runtime.dispatch(request("init", op::APP_INIT, json!({})));
        commit_pointer_input_test_frame(&mut runtime);
        for input in [
            json!({"x":150.0,"y":20.0}),
            json!({"type":1,"x":150.0,"y":20.0}),
            json!({"type":" ","x":150.0,"y":20.0}),
            json!({"type":"tap","x":"150","y":20.0}),
            json!({"type":"tap","x":150.0}),
            json!({"type":"tap","x":1e100,"y":20.0}),
            json!({"type":"tap","x":150.0,"y":20.0,"target":null}),
            json!({"type":"tap","x":150.0,"y":20.0,"path":"root"}),
            json!({"type":"tap","x":150.0,"y":20.0,"dataset":[]}),
            json!({"type":"tap","x":150.0,"y":20.0,"mark":false}),
            json!({"type":"tap","x":150.0,"y":20.0,"capture":"yes"}),
            json!({"type":"tap","x":150.0,"y":20.0,"bubbles":1}),
            json!({"type":"tap","x":150.0,"y":20.0,"id":{}}),
            json!({"type":"tap","x":150.0,"y":20.0,"target":"button","path":["root"]}),
        ] {
            let failed = runtime.dispatch(request(
                "malformed",
                op::EVENT_BATCH,
                json!({"events":[input.clone()]}),
            ));
            assert_eq!(
                failed.messages[0].payload["error"]["code"], "ERR_INVALID_REQUEST",
                "{input}"
            );
        }

        // Explicit routes describe an already targeted event, so coordinates
        // outside the frame must not discard a valid route or repair a bad one.
        let explicit = runtime.dispatch(request(
            "explicit",
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":150.0,"y":20.0,"target":"button","path":["root","button"]}]}),
        ));
        assert_eq!(explicit.messages[0].payload["ok"], true);
        assert_eq!(explicit.messages[0].payload["events"], 1);
        assert_eq!(
            explicit.messages[0].payload["dispatches"][0]["target"],
            "button"
        );

        let mut missing_frame = session();
        missing_frame.dispatch(request("init", op::APP_INIT, json!({})));
        let failed = missing_frame.dispatch(request(
            "missing-frame",
            op::EVENT_BATCH,
            json!({"events":[{"type":"pointermove","x":150.0,"y":20.0}]}),
        ));
        assert_eq!(failed.messages[0].payload["error"]["code"], "ERR_RENDER");
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_pointer_misses_skip_handlers_and_preserve_following_taps(engine: EngineKind) {
        let source =
            br#"Page({data:{count:0},onButton(){this.setData({count:this.data.count+1});}});"#;
        let mut runtime = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        runtime.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        runtime.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        commit_pointer_input_test_frame(&mut runtime);
        let revision = runtime.view.revision;
        let missed = runtime.dispatch(request(
            "misses",
            op::EVENT_BATCH,
            json!({"events":[
                {"type":"tap","x":150.0,"y":20.0,"handler":"onButton"},
                {"type":"tap","x":5.0,"y":5.0,"handler":"onButton"}
            ]}),
        ));
        assert_eq!(missed.messages[0].payload["ok"], true);
        assert_eq!(missed.messages[0].payload["events"], 0);
        assert_eq!(missed.messages[0].payload["hooks"], json!([]));
        assert_eq!(runtime.view.revision, revision);
        assert_eq!(
            runtime.app_service().pages().current().unwrap().data["count"],
            0
        );

        let mixed = runtime.dispatch(request(
            "miss-hit-miss",
            op::EVENT_BATCH,
            json!({"events":[
                {"type":"tap","x":150.0,"y":20.0,"handler":"onButton"},
                {"type":"tap","x":15.0,"y":15.0},
                {"type":"tap","x":5.0,"y":5.0,"handler":"onButton"}
            ]}),
        ));
        assert_eq!(mixed.messages[0].payload["ok"], true);
        assert_eq!(mixed.messages[0].payload["events"], 1);
        assert_eq!(
            mixed.messages[0].payload["dispatches"][0]["dataset"]["action"],
            "save"
        );
        assert_eq!(
            runtime.app_service().pages().current().unwrap().data["count"],
            1
        );
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_pointer_misses_skip_handlers_and_preserve_following_taps() {
        assert_pointer_misses_skip_handlers_and_preserve_following_taps(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_pointer_misses_skip_handlers_and_preserve_following_taps() {
        assert_pointer_misses_skip_handlers_and_preserve_following_taps(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_committed_wxml_bindings_control_capture_target_bubble_and_catch(engine: EngineKind) {
        let source = br#"Page({
            data:{order:[],legacy:0},
            record(label,event){this.setData({order:this.data.order.concat(label+':'+event.phase)});},
            onCapture(event){this.record('root-capture',event);},
            onTargetCapture(event){this.record('target-capture',event);},
            onButton(event){this.record('button',event);},
            onPanel(event){this.record('panel',event);},
            onRoot(event){this.record('root-bubble',event);},
            legacyFallback(){this.setData({legacy:this.data.legacy+1});}
        });"#;
        let mut session = Session::new(
            module_manifest(source, ModuleFormat::Commonjs),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        session.dispatch(request(
            "push",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        session.dispatch(request("frame",op::RENDER_COMMIT,json!({
            "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},
            "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "attributes":{"capture-bind:tap":"onCapture","bindtap":"onRoot"},
                "opacity":1.0,"children":[
                    {"id":"panel","bounds":{"x":0.0,"y":0.0,"width":80.0,"height":80.0},
                        "attributes":{"catch:tap":"onPanel"},"opacity":1.0,"children":[
                            {"id":"button","bounds":{"x":10.0,"y":10.0,"width":20.0,"height":20.0},
                                "attributes":{"bindtap":"onButton","capture-bind:tap":"onTargetCapture"},
                                "opacity":1.0,"children":[]}
                        ]}
                ]}
        })));
        let event = session.dispatch(request(
            "tap",
            op::EVENT_BATCH,
            json!({"events":[{
                "type":"tap","x":15.0,"y":15.0,
                "handler":"legacyFallback","handlers":{"button":"legacyFallback"}
            }]}),
        ));
        let data = &session.app_service().pages().current().unwrap().data;
        assert_eq!(
            data["order"],
            json!([
                "root-capture:capture",
                "target-capture:capture",
                "button:target",
                "panel:bubble"
            ])
        );
        assert_eq!(
            data["legacy"], 0,
            "bound listeners must run exactly once and take priority"
        );
        assert_eq!(
            event.messages[0].payload["dispatches"]
                .as_array()
                .unwrap()
                .last()
                .unwrap()["current_target"],
            "panel"
        );

        // A legal explicit protocol handler still works when that event has
        // no committed WXML listener. No on<Type> method is ever guessed.
        session.dispatch(request(
            "legacy",
            op::EVENT_BATCH,
            json!({"events":[{
                "type":"custom","target":"button","handler":"legacyFallback"
            }]}),
        ));
        assert_eq!(
            session.app_service().pages().current().unwrap().data["legacy"],
            1
        );
        session.dispatch(request(
            "unbound",
            op::EVENT_BATCH,
            json!({"events":[{
                "type":"legacyFallback","x":15.0,"y":15.0
            }]}),
        ));
        assert_eq!(
            session.app_service().pages().current().unwrap().data["legacy"],
            1,
            "an unbound event must never infer a page method from its type"
        );
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_committed_wxml_bindings_control_capture_target_bubble_and_catch() {
        assert_committed_wxml_bindings_control_capture_target_bubble_and_catch(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_committed_wxml_bindings_control_capture_target_bubble_and_catch() {
        assert_committed_wxml_bindings_control_capture_target_bubble_and_catch(EngineKind::V8);
    }

    #[test]
    fn selector_query_rejects_missing_frame_and_invalid_selector() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let missing = session.dispatch(request(
            "missing-frame",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"#hero"}),
        ));
        assert_eq!(missing.messages[0].payload["error"]["code"], "ERR_RENDER");
        let frame = json!({
            "frameId": 1,
            "viewport": {"x": 0.0, "y": 0.0, "width": 10.0, "height": 10.0},
            "root": {"id":"root", "bounds":{"x":0.0,"y":0.0,"width":10.0,"height":10.0}, "opacity":1.0, "children":[]}
        });
        session.dispatch(request("frame", op::RENDER_COMMIT, frame));
        let invalid = session.dispatch(request(
            "invalid-selector",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"view >"}),
        ));
        assert_eq!(
            invalid.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
    }

    #[test]
    fn selector_query_returns_scroll_offset_and_nested_combinator_matches() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        session.dispatch(request(
            "frame",
            op::RENDER_COMMIT,
            json!({
                "frameId": 2,
                "viewport": {"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "root": {"id":"root","tag":"view","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                    {"id":"scroll","attributes":{"id":"scroll"},"tag":"scroll-view","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":80.0},"opacity":1.0,"scrollOffset":{"scrollLeft":4.0,"scrollTop":12.0},"children":[
                        {"id":"row","attributes":{"id":"row"},"tag":"view","classes":["row"],"bounds":{"x":0.0,"y":0.0,"width":100.0,"height":20.0},"opacity":1.0,"children":[]}
                    ]}
                ]}
            }),
        ));
        let offset = session.dispatch(request(
            "offset",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"#scroll","operation":"scrollOffset","exec":true}),
        ));
        assert_eq!(offset.messages[0].payload["result"][0]["scrollTop"], 12.0);
        let nested = session.dispatch(request(
            "nested",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"scroll-view > .row"}),
        ));
        assert_eq!(nested.messages[0].payload["result"]["id"], "row");
    }

    #[test]
    fn pointer_event_uses_current_target_dataset_for_each_phase() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        session.dispatch(request(
            "frame",
            op::RENDER_COMMIT,
            json!({
                "frameId": 3,
                "viewport": {"x":0.0,"y":0.0,"width":100.0,"height":100.0},
                "root": {"id":"root","dataset":{"scope":"root"},"mark":{"source":"root","shared":"root"},"bounds":{"x":0.0,"y":0.0,"width":100.0,"height":100.0},"opacity":1.0,"children":[
                    {"id":"parent","dataset":{"scope":"parent"},"mark":{"shared":"parent","parentOnly":"yes"},"bounds":{"x":0.0,"y":0.0,"width":50.0,"height":50.0},"opacity":1.0,"children":[
                        {"id":"button","dataset":{"scope":"button"},"mark":{"shared":"button","targetOnly":"yes"},"bounds":{"x":5.0,"y":5.0,"width":20.0,"height":20.0},"opacity":1.0,"children":[]}
                    ]}
                ]}
            }),
        ));
        let event = session.dispatch(request(
            "tap",
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":10.0,"y":10.0,"capture":true}]}),
        ));
        let dispatches = event.messages[0].payload["dispatches"].as_array().unwrap();
        assert_eq!(dispatches[0]["current_target"], "root");
        assert_eq!(dispatches[0]["dataset"]["scope"], "root");
        assert_eq!(dispatches[1]["current_target"], "parent");
        assert_eq!(dispatches[1]["dataset"]["scope"], "parent");
        assert_eq!(dispatches[2]["current_target"], "button");
        assert_eq!(dispatches[2]["dataset"]["scope"], "button");
        assert_eq!(dispatches[3]["current_target"], "parent");
        assert_eq!(dispatches[3]["dataset"]["scope"], "parent");
        assert_eq!(dispatches[4]["current_target"], "root");
        assert_eq!(dispatches[4]["dataset"]["scope"], "root");
        assert_eq!(dispatches[2]["mark"]["source"], "root");
        assert_eq!(dispatches[2]["mark"]["shared"], "button");
        assert_eq!(dispatches[2]["mark"]["parentOnly"], "yes");
        assert_eq!(dispatches[2]["mark"]["targetOnly"], "yes");
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn selector_query_exec_effect_resolves_against_committed_frame() {
        let source = br#"Page({ query() {
          wx.createSelectorQuery().select('.card').boundingClientRect().exec((values) => {
            this.setData({ selected: values[0] && values[0].id });
          });
        } }); exports.query = () => getCurrentPages()[0].query();"#;
        let mut app_manifest = module_manifest(source, ModuleFormat::Commonjs);
        app_manifest.routes.push(container_ir::Route {
            id: "route:index".into(),
            path: "pages/index/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "app.js".into(),
        });
        app_manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Partial);
        app_manifest.refresh_integrity().unwrap();
        let mut session = Session::new(app_manifest, SessionConfig::default()).unwrap();
        let init = session.dispatch(request(
            "selector-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "selector-page",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        session.dispatch(request(
            "selector-frame",
            op::RENDER_COMMIT,
            json!({"frameId":1,"viewport":{"x":0.0,"y":0.0,"width":320.0,"height":640.0},"root":{"id":"root","tag":"view","bounds":{"x":0.0,"y":0.0,"width":320.0,"height":640.0},"opacity":1.0,"children":[{"id":"hero","attributes":{"id":"hero"},"tag":"view","classes":["card"],"bounds":{"x":10.0,"y":20.0,"width":100.0,"height":40.0},"opacity":1.0,"children":[]}]}}),
        ));
        let queried = session.dispatch(request(
            "selector-query",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"query", "args":[]}),
        ));
        assert_eq!(queried.messages[0].payload["ok"], true, "{queried:?}");
        assert_eq!(session.view().pending_patches[0].path, "selected");
        assert_eq!(session.view().pending_patches[0].value, Some(json!("hero")));
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_selector_query_exec_effect_resolves_against_committed_frame() {
        let source = br#"Page({ query() {
          wx.createSelectorQuery().select('.card').boundingClientRect().exec((values) => {
            this.setData({ selected: values[0] && values[0].id });
          });
        } }); exports.query = () => getCurrentPages()[0].query();"#;
        let mut app_manifest = module_manifest(source, ModuleFormat::Commonjs);
        app_manifest.routes.push(container_ir::Route {
            id: "route:index".into(),
            path: "pages/index/index".into(),
            kind: container_ir::RouteKind::Page,
            config: None,
            entry_module: "app.js".into(),
        });
        app_manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Partial);
        app_manifest.refresh_integrity().unwrap();
        let config = SessionConfig {
            engine: EngineKind::V8,
            ..SessionConfig::default()
        };
        let mut session = Session::new(app_manifest, config).unwrap();
        let init = session.dispatch(request(
            "v8-selector-init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":String::from_utf8_lossy(source)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true);
        session.dispatch(request(
            "v8-selector-page",
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        ));
        session.dispatch(request(
            "v8-selector-frame",
            op::RENDER_COMMIT,
            json!({"frameId":1,"viewport":{"x":0.0,"y":0.0,"width":320.0,"height":640.0},"root":{"id":"root","tag":"view","bounds":{"x":0.0,"y":0.0,"width":320.0,"height":640.0},"opacity":1.0,"children":[{"id":"hero","attributes":{"id":"hero"},"tag":"view","classes":["card"],"bounds":{"x":10.0,"y":20.0,"width":100.0,"height":40.0},"opacity":1.0,"children":[]}]}}),
        ));
        let queried = session.dispatch(request(
            "v8-selector-query",
            op::MODULE_CALL,
            json!({"moduleId":"module:app", "export":"query", "args":[]}),
        ));
        assert_eq!(queried.messages[0].payload["ok"], true, "{queried:?}");
        assert_eq!(session.view().pending_patches[0].path, "selected");
        assert_eq!(session.view().pending_patches[0].value, Some(json!("hero")));
    }

    #[test]
    fn protocol_error_is_returned_as_envelope() {
        let mut session = session();
        let mut request = request("p", op::APP_INIT, json!({}));
        request.protocol_version = "2.0".into();
        let response = session.dispatch(request);
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_PROTOCOL_VERSION"
        );
    }

    #[test]
    fn expired_deadline_returns_timeout_before_mutation() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let mut expired = request("p", op::PAGE_PUSH, json!({"path": "index"}));
        expired.deadline_ns = Some(1);
        let response = session.dispatch(expired);
        assert_eq!(response.messages[0].payload["error"]["code"], "ERR_TIMEOUT");
        assert!(session.app_service().pages().is_empty());
    }

    #[test]
    fn future_deadline_allows_the_request() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let mut push = request("p", op::PAGE_PUSH, json!({"path": "index"}));
        push.deadline_ns = Some(u64::MAX);
        let response = session.dispatch(push);
        assert_eq!(response.messages[0].payload["ok"], true);
        assert_eq!(session.app_service().pages().len(), 1);
    }

    #[test]
    fn cancellation_prevents_cancelled_request() {
        let mut session = session();
        session.dispatch(request("i", op::APP_INIT, json!({})));
        let cancelled = session.dispatch(request("c", op::CANCEL, json!({"cancelToken":"t1"})));
        assert_eq!(cancelled.messages[0].payload["cancelled"], true);
        let mut call = request("a", op::API_CALL, json!({"name":"wx.setStorage"}));
        call.cancel_token = Some("t1".into());
        let response = session.dispatch(call);
        assert_eq!(
            response.messages[0].payload["error"]["code"],
            "ERR_CANCELLED"
        );
    }

    #[test]
    fn selector_fields_reject_malformed_lists() {
        for value in [
            json!({"properties":true}),
            json!({"properties":[1]}),
            json!({"computedStyle":"color"}),
            json!({"computedStyle":[false]}),
            json!({"rect":"yes"}),
        ] {
            assert!(parse_selector_fields(Some(&value)).is_err(), "{value}");
        }
    }
}

#[cfg(all(
    test,
    any(feature = "quickjs-native", feature = "v8-native"),
    not(target_arch = "wasm32")
))]
mod turn_scheduler_native_tests;
