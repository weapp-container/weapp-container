//! A deterministic developer simulator for packed `weapp-vite` applications.
//!
//! The simulator deliberately uses the same [`container_host_common::HostSession`]
//! as native and Web hosts.  It adds only development concerns: loading a pack
//! directory, supplying content-addressed module/WXML/WXSS blobs, a virtual
//! viewport, and a traceable JSONL dispatch loop.  It does not claim to be the
//! official WeChat DevTools runtime or a GPU/device conformance result.

use container_bridge::{op, BridgeBatch, BridgeEnvelope, BridgeError};
use container_core::EngineKind;
use container_host_common::{HostSession, HostSessionError};
use container_ir::{
    hex_digest, ContainerManifestV1, ManifestError, PresentationKey, RendererProfile,
};
use container_render_skia::{Rect, RenderTargetSize};
use container_runtime::{
    engine_provider_compiled, HostKind, HostMetadata, RasterPresentationPolicy, SessionConfig,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;
use thiserror::Error;

pub mod web;

/// Strict, opt-in browser control transport. This does not elect a preview,
/// construct a Worker, or enable browser watch development by itself.
pub mod web_control;

pub mod presentation;

pub mod dev;

/// The shared, explicitly configured Browser Worker development loop. Owns
/// preparation, publication and the original authenticated shutdown barriers.
pub mod browser_dev_runner;

/// Browser development ownership coordination. This does not construct a
/// runtime or enable the browser development CLI by itself.
pub mod browser_dev_coordinator;

/// Bounded, replayable receipts for the browser development owner loop.
pub mod browser_dev_control;

mod browser_dev_control_lane;
/// Opt-in serial owner for managed browser stages and authenticated control.
/// Browser close correlation is an explicit policy selected by the runner.
pub mod browser_dev_owner;

/// Finite, owned artifact preparation. Static results grant no runtime or
/// presentation readiness and require independent publication validation.
pub mod browser_dev_artifact_job;

mod browser_dev_aggregate_store;
mod browser_dev_read;
mod browser_dev_runtime_preparation;
/// Capture a finite tool's retained runtime as immutable, owner-bound static
/// bytes. This grants no runtime, presentation, or publication authority.
pub mod browser_dev_runtime_receipt;

// A consuming static stage receipt. This does not enable stage admission,
// publication, HTTP serving, Worker execution or presentation by itself.
mod browser_dev_stage_receipt;

mod owned_process;

mod dev_density;
mod dev_logical_resize;
mod dev_reload;

/// Shared reload scope used by native SDKs and development surfaces.
pub use container_runtime::dev_reload::DevReloadKind;

#[derive(Debug, Error)]
pub enum SimulatorError {
    #[error("pack path is not a directory: {0}")]
    InvalidPack(PathBuf),
    #[error("I/O while reading pack: {0}")]
    Io(#[from] io::Error),
    #[error("manifest JSON: {0}")]
    ManifestJson(#[from] serde_json::Error),
    #[error("manifest validation: {0}")]
    Manifest(#[from] ManifestError),
    #[error("host session: {0}")]
    Host(#[from] HostSessionError),
    #[error("bridge: {0}")]
    Bridge(#[from] BridgeError),
    #[error("pack blob {pointer} is missing")]
    MissingBlob { pointer: String },
    #[error("pack blob {pointer} has digest {actual}, expected {expected}")]
    BlobDigest {
        pointer: String,
        expected: String,
        actual: String,
    },
    #[error("simulator configuration: {0}")]
    Config(String),
    /// The caller explicitly selected an engine that this simulator binary
    /// was not compiled to provide.  Keep this as a simulator-level error so
    /// `run`, `dispatch`, and `dev` expose the same stable `ERR_ENGINE`
    /// boundary instead of accidentally constructing a different engine.
    #[error(
        "ERR_ENGINE: requested engine provider is not compiled: enable `{feature}`",
        feature = engine_feature(*engine)
    )]
    EngineUnavailable { engine: EngineKind },
    #[error("JSONL line {line}: {message}")]
    Jsonl { line: usize, message: String },
}

/// Compare two manifests while ignoring their compiler revision and integrity
/// root (both are expected to change for every successful build).  The
/// resulting classification is deterministic and is also used by the Web and
/// desktop development surfaces to decide whether to preserve UI state.
pub use container_runtime::dev_reload::classify_manifest_reload;

fn route_for_manifest(
    configured: Option<&str>,
    current: Option<&str>,
    manifest: &ContainerManifestV1,
) -> Option<String> {
    // Public mini-program URLs are commonly written with a leading slash
    // (`/pages/index/index`), while app.json and the portable manifest store
    // route paths without it.  Normalize only at this selection boundary and
    // return the manifest's canonical spelling so page registration, template
    // lookup and reload diagnostics all use one stable route identity.
    let find = |candidate: Option<&str>| {
        let candidate = candidate?.trim().trim_start_matches('/');
        manifest
            .routes
            .iter()
            .find(|route| route.path == candidate)
            .map(|route| route.path.clone())
    };
    find(configured)
        .or_else(|| find(current))
        .or_else(|| manifest.routes.first().map(|route| route.path.clone()))
}

#[derive(Clone, Debug)]
pub struct SimulatorConfig {
    pub engine: EngineKind,
    /// Page pixels are optional: external and GPU presenters consume accepted
    /// frames without causing an implicit software snapshot during dev ticks.
    pub page_render_mode: container_render_skia::PageRenderMode,
    pub renderer_override: Option<container_ir::RendererProfile>,
    /// Enable browser owner transactions. Automatic presentation only queues
    /// requests and produces no Skia frame; lifecycle component preparation
    /// may still evaluate View inputs before the browser owner transacts.
    pub browser_view_enabled: bool,
    pub session_id: String,
    pub viewport: Rect,
    /// Physical page raster density, independent from logical viewport/DPR.
    pub render_scale: f64,
    pub route: Option<String>,
    pub launch_options: Value,
    pub initial_data: Value,
    /// Finite View execution policy forwarded to the runtime, including across
    /// development reloads. Defaults to the runtime's 50 ms batch limit; outer
    /// engine and bridge deadlines can only shorten this allowance.
    pub view_execution: container_runtime::ViewExecutionPolicy,
}

impl Default for SimulatorConfig {
    fn default() -> Self {
        Self {
            engine: EngineKind::Quickjs,
            page_render_mode: container_render_skia::PageRenderMode::Raster,
            renderer_override: None,
            browser_view_enabled: false,
            session_id: "simulator-1".to_owned(),
            viewport: Rect {
                x: 0.0,
                y: 0.0,
                width: 375.0,
                height: 667.0,
            },
            render_scale: 1.0,
            route: None,
            launch_options: json!({}),
            initial_data: json!({}),
            view_execution: container_runtime::ViewExecutionPolicy::default(),
        }
    }
}

/// Trace retention is independent of the runtime session. Headless runs keep
/// complete evidence by default; long-running development sessions use a
/// bounded recent history and expose every loss in [`TraceSummary`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum TraceRetention {
    #[default]
    Full,
    Bounded {
        #[serde(rename = "maxRecords")]
        max_records: usize,
        #[serde(rename = "maxBytes")]
        max_bytes: usize,
    },
}

impl TraceRetention {
    /// Keep at most 1,024 encoded records and 8 MiB of record payloads.
    pub const fn development() -> Self {
        Self::Bounded {
            max_records: 1024,
            max_bytes: 8 * 1024 * 1024,
        }
    }
}

/// Coverage of the normalized trace, including evictions and oversized
/// records. `complete == false` must not be used as complete conformance
/// evidence, even after retention is changed back to `Full`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub schema_version: u32,
    pub retention: TraceRetention,
    pub complete: bool,
    pub total_records: u64,
    pub retained_records: usize,
    pub retained_bytes: usize,
    pub dropped_records: u64,
    pub dropped_bytes: u64,
    pub first_sequence: Option<u64>,
    pub last_sequence: Option<u64>,
    pub diagnostic_code: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TraceRecord {
    sequence: u64,
    request: BridgeEnvelope,
    response: BridgeBatch,
}

#[derive(Debug)]
struct EncodedTraceRecord {
    sequence: u64,
    bytes: Box<[u8]>,
}

/// Store compact encoded records, rather than retaining each render payload's
/// expanded `serde_json::Value` arrays (including every blob byte). The byte
/// limit covers these owned allocations; the record limit bounds deque and
/// metadata overhead. Caller-owned requests/responses and the live runtime
/// are outside this history budget.
#[derive(Debug, Default)]
struct TraceHistory {
    retention: TraceRetention,
    records: VecDeque<EncodedTraceRecord>,
    bytes: usize,
    total_records: u64,
    dropped_records: u64,
    dropped_bytes: u64,
}

impl TraceHistory {
    fn len(&self) -> usize {
        self.records.len()
    }

    fn set_retention(&mut self, retention: TraceRetention) {
        self.retention = retention;
        self.evict();
        // Reclaim a formerly larger allocation when the caller lowers the
        // budget, without reallocating the deque on every steady-state push.
        self.records.shrink_to_fit();
    }

    fn push(&mut self, request: &BridgeEnvelope, response: &BridgeBatch) {
        self.total_records = self.total_records.saturating_add(1);
        self.encode(self.total_records, request, response);
    }

    fn encode(&mut self, sequence: u64, request: &BridgeEnvelope, response: &BridgeBatch) {
        #[derive(Serialize)]
        struct Wire<'a> {
            sequence: u64,
            request: &'a BridgeEnvelope,
            response: &'a BridgeBatch,
        }
        // Continue counting an oversized record without allocating its full
        // serialized representation. This also avoids a transient full trace
        // clone on every frame while preserving a precise dropped byte count.
        let limit = match self.retention {
            TraceRetention::Full => None,
            TraceRetention::Bounded { max_bytes, .. } => Some(max_bytes),
        };
        let mut writer = TraceEncoder {
            bytes: Vec::new(),
            count: 0,
            limit,
        };
        serde_json::to_writer(
            &mut writer,
            &Wire {
                sequence,
                request,
                response,
            },
        )
        .expect("bridge trace records are serializable");
        if limit.is_some_and(|limit| writer.count > limit) {
            self.dropped_records = self.dropped_records.saturating_add(1);
            self.dropped_bytes = self.dropped_bytes.saturating_add(writer.count as u64);
            return;
        }
        self.bytes += writer.bytes.len();
        self.records.push_back(EncodedTraceRecord {
            sequence,
            bytes: writer.bytes.into_boxed_slice(),
        });
        self.evict();
    }

    fn evict(&mut self) {
        let TraceRetention::Bounded {
            max_records,
            max_bytes,
        } = self.retention
        else {
            return;
        };
        while self.records.len() > max_records || self.bytes > max_bytes {
            if let Some(record) = self.records.pop_front() {
                self.bytes -= record.bytes.len();
                self.dropped_records = self.dropped_records.saturating_add(1);
                self.dropped_bytes = self.dropped_bytes.saturating_add(record.bytes.len() as u64);
            }
        }
    }

    fn append(&mut self, next: Self, request_offset: u64) {
        let sequence_offset = self.total_records;
        self.total_records = self.total_records.saturating_add(next.total_records);
        self.dropped_records = self.dropped_records.saturating_add(next.dropped_records);
        self.dropped_bytes = self.dropped_bytes.saturating_add(next.dropped_bytes);
        for record in next.records {
            let mut record: TraceRecord = serde_json::from_slice(&record.bytes)
                .expect("retained trace records contain valid JSON");
            record.sequence = sequence_offset.saturating_add(record.sequence);
            rebase_trace_request_ids(&mut record, request_offset);
            self.encode(record.sequence, &record.request, &record.response);
        }
    }

    fn summary(&self) -> TraceSummary {
        TraceSummary {
            schema_version: 1,
            retention: self.retention,
            complete: self.dropped_records == 0,
            total_records: self.total_records,
            retained_records: self.records.len(),
            retained_bytes: self.bytes,
            dropped_records: self.dropped_records,
            dropped_bytes: self.dropped_bytes,
            first_sequence: self.records.front().map(|record| record.sequence),
            last_sequence: self.records.back().map(|record| record.sequence),
            diagnostic_code: (self.dropped_records > 0).then_some("TRACE_HISTORY_TRUNCATED"),
        }
    }
}

struct TraceEncoder {
    bytes: Vec<u8>,
    count: usize,
    limit: Option<usize>,
}

impl Write for TraceEncoder {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.count = self.count.saturating_add(bytes.len());
        if self.limit.is_none_or(|limit| self.count <= limit) {
            self.bytes.extend_from_slice(bytes);
        } else if !self.bytes.is_empty() {
            // Free the partial buffer as soon as this record cannot fit.
            self.bytes = Vec::new();
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct SimulatorReport {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub status: String,
    pub engine: EngineKind,
    /// Compiler identity carried by the verified active pack, rather than
    /// inferred from whichever vendor checkout happens to be nearby.
    pub compiler: container_ir::CompilerInfo,
    pub route: Option<String>,
    pub renderer: Option<String>,
    #[serde(rename = "lifecycleState")]
    pub lifecycle_state: Option<String>,
    #[serde(rename = "traceCount")]
    pub trace_count: usize,
    #[serde(rename = "traceSummary")]
    pub trace_summary: TraceSummary,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
    pub snapshot: Option<SnapshotSummary>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct SnapshotSummary {
    pub frame_id: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub format: String,
    #[serde(rename = "pixelBytes")]
    pub pixel_bytes: usize,
}

/// Latest owner-thread request to prepare a browser document. The revision is
/// a canonical decimal string and increases monotonically within one session.
/// Page data is read when `view.prepare` executes, never captured in this queue.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserRenderRequest {
    pub version: String,
    pub revision: String,
    pub render: Value,
}

/// Page instance, route, and template revision consumed by one View evaluation.
type RenderStateIdentity = (u64, String, u64);

#[derive(Debug)]
struct PendingBrowserDevPack {
    root: PathBuf,
    manifest: ContainerManifestV1,
    blobs: BTreeMap<String, Vec<u8>>,
    elapsed_ms: u128,
    accepted_generation: u64,
    previous_request: Option<BrowserRenderRequest>,
    previous_requested_state: Option<RenderStateIdentity>,
    previous_rendered_state: Option<RenderStateIdentity>,
    previous_attempt: Option<RenderStateIdentity>,
    previous_prepared: Option<(PresentationKey, Option<RenderStateIdentity>)>,
}

#[derive(Debug)]
pub struct Simulator {
    root: PathBuf,
    manifest: ContainerManifestV1,
    blobs: BTreeMap<String, Vec<u8>>,
    host: HostSession,
    config: SimulatorConfig,
    /// Stable prefix for full development reload session identifiers.
    /// Template/style updates keep the current id; a JavaScript/config
    /// restart receives a new id so stale host envelopes cannot target it.
    session_base_id: String,
    session_generation: u64,
    next_request: u64,
    trace: TraceHistory,
    /// Error events consumed by internal startup/reload dispatches instead
    /// of being returned to a surface through dispatch or pump.
    dev_errors: Vec<BridgeEnvelope>,
    started: bool,
    elapsed_ms: u128,
    /// Identity and View revision used for the last manifest-backed frame.
    /// Checking this small token avoids cloning page data on every idle tick.
    rendered_state: Option<RenderStateIdentity>,
    /// Automatic rendering consumes each invalidation once, including failed
    /// attempts. The accepted frame remains separate: retrying unchanged input
    /// cannot repair it and can repeatedly execute stateful View expressions.
    last_render_attempt: Option<RenderStateIdentity>,
    browser_render_request: Option<BrowserRenderRequest>,
    browser_requested_state: Option<RenderStateIdentity>,
    next_browser_render_revision: u64,
    prepared_browser_state: Option<(PresentationKey, Option<RenderStateIdentity>)>,
    pending_browser_dev_pack: Option<PendingBrowserDevPack>,
}

impl Simulator {
    /// Load a `container-pack` output directory.
    pub fn from_pack_dir(
        path: impl AsRef<Path>,
        config: SimulatorConfig,
    ) -> Result<Self, SimulatorError> {
        Self::from_pack_dir_with_raster_policy(path, config, RasterPresentationPolicy::Synchronous)
    }

    /// Load a developer Raster session whose ready/input authority requires
    /// exact owner-issued presentation receipts. The policy is enabled before
    /// app.init and follows the current Session across development reloads.
    /// This does not attach HTTP/RAF/input consumers or change the CLI default.
    pub fn from_dev_raster_pack_dir(
        path: impl AsRef<Path>,
        config: SimulatorConfig,
    ) -> Result<Self, SimulatorError> {
        Self::from_pack_dir_with_raster_policy(path, config, RasterPresentationPolicy::ExplicitDev)
    }

    fn from_pack_dir_with_raster_policy(
        path: impl AsRef<Path>,
        config: SimulatorConfig,
        policy: RasterPresentationPolicy,
    ) -> Result<Self, SimulatorError> {
        let root = path.as_ref().to_path_buf();
        if !root.is_dir() {
            return Err(SimulatorError::InvalidPack(root));
        }
        if config.session_id.trim().is_empty() {
            return Err(SimulatorError::Config("session_id cannot be empty".into()));
        }
        if !engine_provider_compiled(config.engine) {
            return Err(SimulatorError::EngineUnavailable {
                engine: config.engine,
            });
        }
        let ValidatedPack {
            manifest_bytes,
            manifest,
            blobs,
        } = read_validated_pack(&root)?;
        let host_config = SessionConfig {
            session_id: config.session_id.clone(),
            engine: config.engine,
            page_render_mode: config.page_render_mode,
            renderer_override: config.renderer_override,
            browser_view_enabled: config.browser_view_enabled,
            view_execution: config.view_execution.clone(),
            host: HostMetadata {
                kind: HostKind::Desktop,
                platform: "simulator".to_owned(),
                version: "weapp-simulator/0.1".to_owned(),
                window_width: config.viewport.width.max(0.0) as u32,
                window_height: config.viewport.height.max(0.0) as u32,
                ..HostMetadata::default()
            },
            ..SessionConfig::default()
        };
        let mut host = HostSession::from_manifest_json(&manifest_bytes, host_config)?;
        match policy {
            RasterPresentationPolicy::Synchronous => {}
            RasterPresentationPolicy::ExplicitDev => host
                .session_mut()
                .ok_or(HostSessionError::NotLoaded)?
                .enable_dev_raster_presentation()?,
        }
        let route = route_for_manifest(config.route.as_deref(), None, &manifest);
        let profile = config.renderer_override.unwrap_or_else(|| {
            manifest.renderer_profile_for_route(route.as_deref().unwrap_or_default())
        });
        if profile == RendererProfile::WebView {
            RenderTargetSize::for_viewport(config.viewport, config.render_scale)
                .map_err(HostSessionError::from)?;
        } else {
            host.validate_skia_render_target(config.viewport, config.render_scale)?;
            host.stage_skia_render_target(config.viewport, config.render_scale)?;
        }
        let session_base_id = config.session_id.clone();
        Ok(Self {
            root,
            manifest,
            blobs,
            host,
            config,
            session_base_id,
            session_generation: 0,
            next_request: 1,
            trace: TraceHistory::default(),
            dev_errors: Vec::new(),
            started: false,
            elapsed_ms: 0,
            rendered_state: None,
            last_render_attempt: None,
            browser_render_request: None,
            browser_requested_state: None,
            next_browser_render_revision: 1,
            prepared_browser_state: None,
            pending_browser_dev_pack: None,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn manifest(&self) -> &ContainerManifestV1 {
        &self.manifest
    }

    /// Return the active bridge session identifier for host input adapters.
    ///
    /// Web and desktop surfaces use this to construct pointer envelopes that
    /// enter the same session as lifecycle, data and render messages. Keeping
    /// the value here avoids hard-coding the default `simulator-1` id in a
    /// surface implementation.
    pub fn session_id(&self) -> &str {
        &self.config.session_id
    }

    pub fn host(&self) -> &HostSession {
        &self.host
    }

    pub fn host_mut(&mut self) -> &mut HostSession {
        &mut self.host
    }

    pub fn viewport(&self) -> Rect {
        self.config.viewport
    }

    pub fn render_scale(&self) -> f64 {
        self.config.render_scale
    }

    pub fn current_renderer_profile(&self) -> RendererProfile {
        if let Some(profile) = self.config.renderer_override {
            return profile;
        }
        if let Some(page) = self
            .host
            .session()
            .and_then(|session| session.app_service().pages().current())
        {
            return self.manifest.renderer_profile_for_route(&page.path);
        }
        // Before startup, use the same canonical route selection as run().
        // Public route options may contain a leading slash or name a route
        // removed by a reload; profile selection must follow the actual page.
        let route = route_for_manifest(self.config.route.as_deref(), None, &self.manifest);
        self.manifest
            .renderer_profile_for_route(route.as_deref().unwrap_or_default())
    }

    /// Whether the retained manifest scene belongs to the visible Skia page.
    /// Navigation changes page authority before its next scheduled render;
    /// an older native frame can still exist while a DOM page owns the View.
    /// Presentation settings may be staged in that interval, but must not
    /// repaint or publish the previous page as the new page's accepted scene.
    pub fn has_current_skia_scene(&self) -> bool {
        self.host
            .session()
            .is_some_and(|session| session.has_current_skia_scene())
    }

    /// Reading a request does not consume it. Owners compare its revision and
    /// dispatch `view.prepare` through this simulator when ready to transact.
    pub fn browser_render_request(&self) -> Option<&BrowserRenderRequest> {
        (self.current_renderer_profile() == RendererProfile::WebView)
            .then_some(self.browser_render_request.as_ref())
            .flatten()
    }

    /// End old browser input authority before a primary preview transfer or
    /// disconnect. Cancellation hooks settle before the next document request.
    pub fn retire_browser_preview(&mut self, reason: &str) -> Result<BridgeBatch, SimulatorError> {
        let batch = self.host.retire_browser_preview(reason)?;
        self.record_preview_retirement(batch, reason)
    }

    /// Trusted owner-lane retirement for either presenter. It consumes
    /// software touch/scroll captures as well as browser contacts, without
    /// cloning a Session or starting a second runtime.
    pub fn retire_dev_preview(&mut self, reason: &str) -> Result<BridgeBatch, SimulatorError> {
        let batch = self.host.retire_dev_preview(reason)?;
        self.record_preview_retirement(batch, reason)
    }

    fn record_preview_retirement(
        &mut self,
        batch: BridgeBatch,
        reason: &str,
    ) -> Result<BridgeBatch, SimulatorError> {
        self.reconcile_browser_dev_pack();
        let request_id = format!("sim-{}", self.next_request);
        self.next_request = self.next_request.saturating_add(1);
        self.trace.push(
            &BridgeEnvelope::request(
                self.config.session_id.clone(),
                request_id,
                "view.retire",
                json!({"reason":reason}),
            ),
            &batch,
        );
        if self.current_renderer_profile() == RendererProfile::WebView {
            self.prepared_browser_state = None;
            self.rendered_state = None;
            self.last_render_attempt = None;
            self.browser_requested_state = None;
            if self.started {
                self.queue_browser_render()?;
            }
        }
        Ok(batch)
    }

    /// Apply development presentation settings on the runtime's owning thread.
    /// Density alone repaints the accepted tree, preserving stateful View
    /// expressions and device pixelRatio. Logical resize invokes host hooks.
    /// Target/backend validation happens before callbacks or state mutation.
    pub fn apply_presentation(
        &mut self,
        viewport: Rect,
        render_scale: f64,
    ) -> Result<BridgeBatch, SimulatorError> {
        if viewport.width <= 0.0
            || viewport.height <= 0.0
            || viewport.width.fract() != 0.0
            || viewport.height.fract() != 0.0
            || viewport.x != 0.0
            || viewport.y != 0.0
        {
            return Err(SimulatorError::Config(
                "presentation requires positive integer logical dimensions at origin".into(),
            ));
        }
        if self.current_renderer_profile() == RendererProfile::WebView {
            RenderTargetSize::for_viewport(viewport, render_scale)
                .map_err(HostSessionError::from)?;
            if viewport == self.config.viewport {
                // Browser density/zoom does not evaluate the View program or
                // mutate simulated device DPR. DOM owns its physical pixels.
                self.config.render_scale = render_scale;
                return Ok(BridgeBatch::new(Vec::new()));
            }
            let bytes = match self
                .host
                .notify_viewport_resize_json(viewport.width as u32, viewport.height as u32)
            {
                Ok(bytes) => bytes,
                Err(error) => {
                    // An engine/boundary failure can occur after provider
                    // geometry and old input authority changed. JavaScript
                    // hook diagnostics normally return an accepted batch.
                    // For this transport failure restore host dimensions,
                    // retaining all application side effects, and request a
                    // fresh browser transaction for the accepted dimensions.
                    self.reconcile_browser_dev_pack();
                    let restore = self.host.notify_viewport_resize_json(
                        self.config.viewport.width as u32,
                        self.config.viewport.height as u32,
                    );
                    self.prepared_browser_state = None;
                    if self.started && self.current_renderer_profile() == RendererProfile::WebView {
                        self.queue_browser_render()?;
                    }
                    return Err(match restore {
                        Ok(_) => SimulatorError::Host(error),
                        Err(restore) => SimulatorError::Config(format!(
                            "{error}; restoring browser viewport reported: {restore}"
                        )),
                    });
                }
            };
            let batch = serde_json::from_slice(&bytes)?;
            self.reconcile_browser_dev_pack();
            self.config.viewport = viewport;
            self.config.render_scale = render_scale;
            self.prepared_browser_state = None;
            if self.started && self.current_renderer_profile() == RendererProfile::WebView {
                self.queue_browser_render()?;
            }
            return Ok(batch);
        }
        self.host
            .validate_skia_render_target(viewport, render_scale)?;
        if viewport == self.config.viewport {
            if self.host.repaint_current_skia_page(render_scale)?.is_none() {
                // The first scene is scheduled by the normal owner pump.
                // Stage its validated target without evaluating View early
                // or committing a retained frame from a different page.
                self.host.stage_skia_render_target(viewport, render_scale)?;
            }
            self.config.render_scale = render_scale;
            return Ok(BridgeBatch::new(Vec::new()));
        }
        self.apply_skia_logical_resize(viewport, render_scale)
    }

    /// Replace the loaded pack during development and execute its deterministic
    /// startup sequence.  A fully constructed candidate is prepared before it
    /// replaces the current instance, so invalid manifests or missing blobs
    /// leave the previous running app untouched.
    pub fn apply_dev_pack(
        &mut self,
        path: impl AsRef<Path>,
    ) -> Result<(DevReloadKind, SimulatorReport), SimulatorError> {
        self.reconcile_browser_dev_pack();
        if self.pending_browser_dev_pack.is_some() {
            return Err(SimulatorError::Config(
                "browser development pack awaits its presentation outcome".into(),
            ));
        }
        let reload_started = Instant::now();
        // Session is the only policy source. In particular, a caller may have
        // used the runtime's pre-init opt-in through host_mut; no simulator
        // mirror flag/config may silently reset it during candidate startup.
        let previous_session = self.host.session().ok_or(HostSessionError::NotLoaded)?;
        let raster_policy = previous_session.raster_presentation_policy();
        // Public dispatch/host access can activate a Session before run()
        // reaches its final simulator bookkeeping, including partial startup.
        // Replacing that runtime under the same identity would let stale
        // same-valued tickets/envelopes target the replacement.
        let previously_active = self.started
            || previous_session.initialized()
            || !previous_session.app_service().pages().is_empty();
        let mut next =
            Self::from_pack_dir_with_raster_policy(&path, self.config.clone(), raster_policy)?;
        next.set_trace_retention(self.trace.retention);
        let reload = if (!previously_active || self.started)
            && classify_manifest_reload(&self.manifest, &next.manifest) == DevReloadKind::InPlace
            && !dev_reload::requires_view_script_restart(
                &self.manifest,
                &self.blobs,
                &next.manifest,
                &next.blobs,
            )
            && !dev_reload::requires_component_restart(
                &self.manifest,
                &self.blobs,
                &next.manifest,
                &next.blobs,
            ) {
            DevReloadKind::InPlace
        } else {
            DevReloadKind::Restart
        };
        // Keep the configured route when it still exists, otherwise preserve
        // the visible page if the new pack contains it, and finally fall back
        // to the first declared route. This makes a route deletion during HMR
        // deterministic instead of accidentally rendering an unrelated first
        // template under an invalid path.
        let current_route = self
            .host
            .session()
            .and_then(|session| session.app_service().pages().current())
            .map(|page| page.path.as_str());
        let selected_route =
            route_for_manifest(next.config.route.as_deref(), current_route, &next.manifest)
                .ok_or_else(|| {
                    SimulatorError::Config("manifest has no routes; pass --route".into())
                })?;
        next.config.route = Some(selected_route.clone());
        // Full restarts receive a new session id before their isolated startup
        // run. This lets the candidate validate the exact bridge identity that
        // will be published to Web/desktop hosts, while stale envelopes from
        // the previous session fail the runtime session check.
        let next_generation = if previously_active && reload == DevReloadKind::Restart {
            self.session_generation.checked_add(1).ok_or_else(|| {
                SimulatorError::Config(
                    "ERR_RENDER: development session generation exhausted".into(),
                )
            })?
        } else {
            self.session_generation
        };
        if previously_active && reload == DevReloadKind::Restart {
            next.config.session_id = format!("{}-reload-{}", self.session_base_id, next_generation);
            next =
                Self::from_pack_dir_with_raster_policy(path, next.config.clone(), raster_policy)?;
            next.set_trace_retention(self.trace.retention);
            next.config.route = Some(selected_route);
        }
        // A pristine pre-run runtime has no state to keep. An activated runtime
        // without completed simulator bookkeeping was classified Restart above
        // and must retire with a fresh identity before its host is replaced.
        if !self.started || reload == DevReloadKind::Restart {
            // Full startup belongs only to a replacement session. Replaying
            // app modules or lifecycle hooks while validating a style/template
            // update would duplicate initialization effects in a throwaway
            // instance, even though the live AppService remains unchanged.
            next.run()?;
            if previously_active {
                if raster_policy == RasterPresentationPolicy::ExplicitDev {
                    self.retire_dev_preview("session-restarted")?;
                } else if self.current_renderer_profile() == RendererProfile::WebView {
                    self.retire_browser_preview("session-restarted")?;
                }
            }
            // Keep the supervisor's normalized trace across a full session
            // restart.  `next` is intentionally isolated while it is
            // validated and started, but replacing the running instance must
            // not erase the history that the Web/desktop diagnostics expose.
            // Request sequencing also remains monotonic so a new session
            // cannot reuse an id that already appears in the trace.
            let previous_next_request = self.next_request;
            let candidate_requests = next.next_request.saturating_sub(1);
            self.trace
                .append(next.trace, previous_next_request.saturating_sub(1));
            self.dev_errors = next.dev_errors;
            self.root = next.root;
            self.manifest = next.manifest;
            self.blobs = next.blobs;
            self.host = next.host;
            self.config = next.config;
            self.session_generation = next_generation;
            self.next_request = previous_next_request.saturating_add(candidate_requests);
            self.started = next.started;
            self.elapsed_ms = next.elapsed_ms;
            self.rendered_state = next.rendered_state;
            self.last_render_attempt = next.last_render_attempt;
            self.browser_render_request = next.browser_render_request;
            self.browser_requested_state = next.browser_requested_state;
            self.next_browser_render_revision = next.next_browser_render_revision;
            self.prepared_browser_state = next.prepared_browser_state;
            self.pending_browser_dev_pack = None;
            return Ok((reload, self.report("passed")));
        }

        if self.current_renderer_profile() == RendererProfile::WebView {
            let route = self
                .host
                .session()
                .and_then(|session| session.app_service().pages().current())
                .map(|page| page.path.clone())
                .ok_or_else(|| {
                    SimulatorError::Config("no visible browser page to reload".into())
                })?;
            let payload = json!({
                "templateId":next.template_for_route(&route)?,
                "blobs":next.render_blobs_value(),
                "styleIds":next.manifest.route_style_ids(&route)?,
                "viewport":self.config.viewport,
            });
            // Candidate preflight projects accepted component snapshots and
            // validated style IR. Browser layout/pixels are never synthesized
            // here. Rejected input leaves the old metadata and lease intact.
            let accepted_generation = self
                .host
                .session()
                .expect("live session")
                .browser_dev_presentation_generation()
                .checked_add(1)
                .ok_or_else(|| SimulatorError::Config("development generation exhausted".into()))?;
            let revision = self.next_browser_render_revision;
            let next_revision = revision.checked_add(1).ok_or_else(|| {
                SimulatorError::Config("browser render request revision exhausted".into())
            })?;
            let batch = self
                .host
                .replace_browser_dev_presentation(&mut next.host, &payload)?;
            self.dev_errors = batch
                .messages
                .into_iter()
                .filter(|message| message.op == op::ERROR)
                .collect();
            let mut render = payload;
            let object = render.as_object_mut().expect("development render object");
            object.remove("blobs");
            object.insert("useSessionResources".into(), json!(true));
            self.next_browser_render_revision = next_revision;
            self.pending_browser_dev_pack = Some(PendingBrowserDevPack {
                root: next.root,
                manifest: next.manifest,
                blobs: next.blobs,
                elapsed_ms: reload_started.elapsed().as_millis(),
                accepted_generation,
                previous_request: self.browser_render_request.take(),
                previous_requested_state: self.browser_requested_state.take(),
                previous_rendered_state: self.rendered_state.take(),
                previous_attempt: self.last_render_attempt.take(),
                previous_prepared: self.prepared_browser_state.take(),
            });
            self.browser_render_request = Some(BrowserRenderRequest {
                version: container_ir::VIEW_PRESENTATION_VERSION.into(),
                revision: revision.to_string(),
                render,
            });
            self.browser_requested_state = self.current_render_state();
            return Ok((reload, self.report("staged")));
        }

        // Prepare and accept one isolated presentation candidate. Failed
        // evaluation never invalidates the active manifest, input or resources.
        let route = self
            .host
            .session()
            .and_then(|session| {
                session
                    .app_service()
                    .pages()
                    .current()
                    .map(|page| page.path.clone())
            })
            .or_else(|| self.config.route.clone())
            .or_else(|| next.manifest.routes.first().map(|entry| entry.path.clone()))
            .ok_or_else(|| SimulatorError::Config("manifest has no routes; pass --route".into()))?;
        let template_id = next.template_for_route(&route)?;
        let frame_id = self
            .host
            .session()
            .and_then(|session| {
                session
                    .accepted_page_observation()
                    .map(|observation| observation.frame)
            })
            .map(|frame| frame.frame_id.saturating_add(1))
            .unwrap_or(1);
        let render_payload = json!({
            "templateId": template_id,
            "blobs": next.render_blobs_value(),
            "styleIds": next.manifest.route_style_ids(&route)?,
            "viewport": self.config.viewport,
            "frameId": frame_id,
        });

        let rendered_state = self.current_render_state();
        let request_id = format!("sim-{}", self.next_request);
        self.next_request = self.next_request.saturating_add(1);
        let reload_request = BridgeEnvelope::request(
            self.config.session_id.clone(),
            request_id,
            "view.reload",
            json!({"integrity":next.manifest.integrity.root}),
        );
        let request_id = format!("sim-{}", self.next_request);
        self.next_request = self.next_request.saturating_add(1);
        let render_request = BridgeEnvelope::request(
            self.config.session_id.clone(),
            request_id,
            op::RENDER_COMMIT,
            render_payload,
        );
        let render_batch = self
            .host
            .replace_dev_presentation_request(&mut next.host, &render_request)?;
        self.trace
            .push(&reload_request, &BridgeBatch::new(Vec::new()));
        // Retain reload metadata separately from the actual presentation
        // transaction. Its response batch acknowledges this exact render
        // payload, so recording it against view.reload loses operation identity.
        self.trace.push(&render_request, &render_batch);
        self.dev_errors = render_batch
            .messages
            .into_iter()
            .filter(|message| message.op == op::ERROR)
            .collect();

        self.root = next.root;
        self.manifest = next.manifest;
        self.blobs = next.blobs;
        self.elapsed_ms = reload_started.elapsed().as_millis();
        // Ready hooks can invalidate state after this frame was built. Keep
        // the consumed input revision so the next pump renders their writes.
        self.last_render_attempt = rendered_state.clone();
        self.rendered_state = rendered_state;
        Ok((reload, self.report("passed")))
    }

    /// Materialize the retained normalized records. Headless runs retain all
    /// records by default. Consult [`Self::trace_summary`] before treating
    /// this list as complete evidence when using bounded retention.
    pub fn trace(&self) -> Vec<Value> {
        self.trace
            .records
            .iter()
            .map(|record| {
                serde_json::from_slice(&record.bytes)
                    .expect("retained trace records contain valid JSON")
            })
            .collect()
    }

    /// Drain error events from successful internal startup/reload dispatches.
    /// Externally returned dispatch/pump batches are never copied here, so a
    /// development surface can publish each error once without parsing trace
    /// history or duplicating timer/input failures.
    pub fn take_dev_errors(&mut self) -> BridgeBatch {
        BridgeBatch::new(std::mem::take(&mut self.dev_errors))
    }

    /// Configure retained history without changing app, timer or bridge
    /// state. Lowering the budget immediately evicts older records. Any loss
    /// remains visible after switching back to full retention.
    pub fn set_trace_retention(&mut self, retention: TraceRetention) {
        self.trace.set_retention(retention);
    }

    pub fn trace_summary(&self) -> TraceSummary {
        self.trace.summary()
    }

    pub fn blob(&self, pointer: &str) -> Option<&[u8]> {
        self.blobs.get(pointer).map(Vec::as_slice)
    }

    /// Execute the deterministic startup path used by the app embedding
    /// examples: app.init (with all declared modules), launch, page.push, then
    /// either a manifest-backed Skia commit or a browser presentation request.
    pub fn run(&mut self) -> Result<SimulatorReport, SimulatorError> {
        if self.started {
            return Ok(self.report("passed"));
        }
        let started = Instant::now();
        let route = self.selected_route()?;
        let launch_options = if self.config.launch_options.is_object() {
            self.config.launch_options.clone()
        } else {
            return Err(SimulatorError::Config(
                "launch_options must be a JSON object".into(),
            ));
        };
        let mut init = Map::new();
        init.insert("launchOptions".into(), launch_options);
        // Preload verified view resources in the same startup batch so the
        // runtime can attach concrete components before Page.onLoad.
        init.insert("blobs".into(), self.render_blobs_value());
        let modules = self.module_payload()?;
        if !modules.is_empty() {
            init.insert("modules".into(), Value::Array(modules));
        }
        self.dispatch_startup(op::APP_INIT, Value::Object(init))?;
        self.dispatch_startup(
            op::APP_LIFECYCLE,
            json!({"event": "launch", "options": self.config.launch_options}),
        )?;
        self.dispatch_startup(
            op::PAGE_PUSH,
            json!({"path": route, "query": self.config.launch_options.get("query").cloned().unwrap_or_else(|| json!({})), "data": self.config.initial_data}),
        )?;
        let rendered_state = self.current_render_state();
        let rendered = self.render_current_page()?;
        if self.current_renderer_profile() != RendererProfile::WebView {
            if let Some(error) = dev_render_error(&rendered) {
                return Err(error);
            }
        }
        self.dev_errors.extend(
            rendered
                .messages
                .into_iter()
                .filter(|message| message.op == op::ERROR),
        );
        self.started = true;
        if self.current_renderer_profile() != RendererProfile::WebView {
            self.last_render_attempt = rendered_state.clone();
            self.rendered_state = rendered_state;
        }
        self.elapsed_ms = started.elapsed().as_millis();
        Ok(self.report("passed"))
    }

    /// Advance the host clock once and refresh the manifest frame only when
    /// the visible page or its template inputs changed. Web and desktop call
    /// this same batch boundary; idle ticks produce no trace or frame traffic.
    /// `now_ns` is Unix time because native JS timers use `Date.now()`.
    pub fn pump(&mut self, now_ns: u64) -> Result<BridgeBatch, SimulatorError> {
        self.pump_with_render(now_ns, true)
    }

    /// Poll timers every host tick while independently capping automatic
    /// repaint. Explicit bridge/render operations retain their own semantics.
    pub fn pump_with_render(
        &mut self,
        now_ns: u64,
        allow_render: bool,
    ) -> Result<BridgeBatch, SimulatorError> {
        if !self.started
            || self.host.lifecycle_state().ok() == Some(container_core::LifecycleState::Destroyed)
        {
            return Ok(BridgeBatch::new(Vec::new()));
        }
        let mut batch = self.host.poll_timers(now_ns)?;
        if !batch.messages.is_empty() {
            let request_id = format!("sim-{}", self.next_request);
            self.next_request = self.next_request.saturating_add(1);
            self.trace.push(
                &BridgeEnvelope::request(
                    self.config.session_id.clone(),
                    request_id,
                    op::EVENT_BATCH,
                    json!({"source": "host-clock", "nowNs": now_ns, "events": []}),
                ),
                &batch,
            );
        }
        let state = self.current_render_state();
        self.reconcile_browser_dev_pack();
        if allow_render
            && self.pending_browser_dev_pack.is_none()
            && state.is_some()
            && state != self.rendered_state
            && state != self.last_render_attempt
            && (self.current_renderer_profile() != RendererProfile::WebView
                || state != self.browser_requested_state)
        {
            if self.current_renderer_profile() != RendererProfile::WebView {
                self.last_render_attempt = state;
            }
            batch.messages.extend(self.render_current_page()?.messages);
        }
        Ok(batch)
    }

    fn render_current_page(&mut self) -> Result<BridgeBatch, SimulatorError> {
        if self.current_renderer_profile() == RendererProfile::WebView {
            self.queue_browser_render()?;
            return Ok(BridgeBatch::new(Vec::new()));
        }
        self.browser_render_request = None;
        self.browser_requested_state = None;
        self.prepared_browser_state = None;
        // A DOM page never mutates the native render target. Navigation back
        // to a Skia route must therefore import the latest presentation size
        // before drawing, even if the session originally started in a browser.
        self.host
            .stage_skia_render_target(self.config.viewport, self.config.render_scale)?;
        let state = self.current_render_state();
        let page = self
            .host
            .session()
            .and_then(|session| session.app_service().pages().current())
            .ok_or_else(|| SimulatorError::Config("no visible page to render".into()))?;
        let template_id = self.template_for_route(&page.path)?;
        let style_ids = self.manifest.route_style_ids(&page.path)?;
        // The simulator owns this root-data clone and its scheduling token.
        // Keep ordinary draws explicit; runtime input provenance is reserved
        // for payloads whose clone boundary belongs to the runtime itself.
        let data = page.data.clone();
        let rendered = self.dispatch_request(
            op::RENDER_COMMIT,
            json!({
                "templateId": template_id,
                "data": data,
                // app.init and accepted reload commits verify and retain this
                // immutable resource map; do not recopy every blob each frame.
                "useSessionResources": true,
                "styleIds": style_ids,
                "viewport": self.config.viewport,
            }),
        )?;
        if render_commit_published(&rendered) {
            self.rendered_state = state;
        }
        Ok(rendered)
    }

    fn queue_browser_render(&mut self) -> Result<(), SimulatorError> {
        if !self.config.browser_view_enabled {
            return Err(SimulatorError::Bridge(container_bridge::BridgeError::new(
                container_bridge::BridgeErrorCode::UnsupportedCapability,
                "browser renderer requires an enabled browser presentation owner",
            )));
        }
        let page = self
            .host
            .session()
            .and_then(|session| session.app_service().pages().current())
            .ok_or_else(|| SimulatorError::Config("no visible browser page to render".into()))?;
        let render = json!({
            "templateId":self.template_for_route(&page.path)?,
            "useSessionResources":true,
            "styleIds":self.manifest.route_style_ids(&page.path)?,
            "viewport":self.config.viewport,
        });
        let revision = self.next_browser_render_revision;
        let next = revision.checked_add(1).ok_or_else(|| {
            SimulatorError::Config("browser render request revision exhausted".into())
        })?;
        self.browser_render_request = Some(BrowserRenderRequest {
            version: container_ir::VIEW_PRESENTATION_VERSION.into(),
            revision: revision.to_string(),
            render,
        });
        self.browser_requested_state = self.current_render_state();
        self.next_browser_render_revision = next;
        Ok(())
    }

    /// A staged development pack becomes visible only after the runtime's
    /// exact browser ACK. The supervisor uses this owner status to defer ready.
    pub fn browser_dev_pack_pending(&self) -> bool {
        self.pending_browser_dev_pack.is_some()
    }

    fn reconcile_browser_dev_pack(&mut self) {
        let Some(pending) = self.pending_browser_dev_pack.as_ref() else {
            return;
        };
        let Some(session) = self.host.session() else {
            return;
        };
        if session.browser_dev_presentation_pending() {
            return;
        }
        let committed = session.browser_dev_presentation_generation()
            == pending.accepted_generation
            && session.manifest().integrity.root == pending.manifest.integrity.root;
        let pending = self
            .pending_browser_dev_pack
            .take()
            .expect("pending development pack");
        if committed {
            self.root = pending.root;
            self.manifest = pending.manifest;
            self.blobs = pending.blobs;
            self.elapsed_ms = pending.elapsed_ms;
            let request_id = format!("sim-{}", self.next_request);
            self.next_request = self.next_request.saturating_add(1);
            self.trace.push(
                &BridgeEnvelope::request(
                    self.config.session_id.clone(),
                    request_id,
                    "view.reload",
                    json!({"integrity":self.manifest.integrity.root}),
                ),
                &BridgeBatch::new(Vec::new()),
            );
        } else {
            self.browser_render_request = pending.previous_request;
            self.browser_requested_state = pending.previous_requested_state;
            self.rendered_state = pending.previous_rendered_state;
            self.last_render_attempt = pending.previous_attempt;
            self.prepared_browser_state = pending.previous_prepared;
        }
    }

    fn current_render_state(&self) -> Option<RenderStateIdentity> {
        let session = self.host.session()?;
        let page = session.app_service().pages().current()?;
        Some((
            page.id.0,
            page.path.clone(),
            session.view().template_revision,
        ))
    }

    /// Dispatch one bridge envelope and retain its normalized trace according
    /// to the selected policy. This is the app embedding boundary shared by
    /// every platform sample; the returned batch is never truncated.
    /// A host receipt enters the same retained trace as bridge operations.
    /// Session/generation admission remains owned by the surface adapter.
    pub fn acknowledge_presentation(
        &mut self,
        revision: u64,
    ) -> Result<BridgeBatch, SimulatorError> {
        let request = BridgeEnvelope::request(
            self.session_id(),
            format!("presented-{revision}"),
            "view.presented",
            json!({"revision":revision}),
        );
        let bytes = self.host.acknowledge_presentation_json(revision)?;
        let batch: BridgeBatch = serde_json::from_slice(&bytes)?;
        self.trace.push(&request, &batch);
        Ok(batch)
    }

    pub fn dispatch(&mut self, request: BridgeEnvelope) -> Result<BridgeBatch, SimulatorError> {
        let was_active =
            self.host.lifecycle_state().ok() == Some(container_core::LifecycleState::Active);
        let consumed = (matches!(
            request.op.as_str(),
            op::VIEW_PREPARE | op::VIEW_LIVE_PREPARE
        ) && request.session_id == self.session_id()
            && self.current_renderer_profile() == RendererProfile::WebView)
            .then(|| self.current_render_state());
        let response = self.host.dispatch(request.clone())?;
        let success = response.messages.iter().find(|message| {
            message.request_id == request.request_id
                && message.op == request.op
                && message.payload.get("ok") == Some(&Value::Bool(true))
        });
        if let Some(consumed) = consumed {
            // A failed attempt retains the pre-dispatch scheduling lower
            // bound. A successful candidate instead carries the runtime's
            // actual data snapshot: contact cancellation can re-read it, while
            // component/ready writes must still schedule the next document.
            self.last_render_attempt = consumed;
            self.prepared_browser_state = None;
            if let Some(key) = success
                .and_then(|message| message.payload.pointer("/submission/key"))
                .and_then(|key| serde_json::from_value::<PresentationKey>(key.clone()).ok())
            {
                let consumed = self
                    .host
                    .session()
                    .and_then(|session| session.browser_page_input(&key))
                    .filter(|input| input.viewport == self.config.viewport)
                    .map(|input| {
                        (
                            input.page_id.0,
                            input.route_path.clone(),
                            input.template_revision,
                        )
                    });
                self.last_render_attempt = consumed.clone();
                if consumed.is_none() {
                    // An explicit payload or a different logical viewport
                    // cannot satisfy the scheduled authoritative page render.
                    self.browser_requested_state = None;
                }
                self.prepared_browser_state = Some((key, consumed));
            }
        }
        if matches!(
            request.op.as_str(),
            op::VIEW_PRESENTED | op::VIEW_LIVE_PRESENTED
        ) && success.is_some()
        {
            if let Some((key, consumed)) = self.prepared_browser_state.as_ref() {
                let matches = request
                    .payload
                    .get("key")
                    .or_else(|| request.payload.pointer("/permit/key"))
                    .is_some_and(|request_key| {
                        serde_json::from_value::<PresentationKey>(request_key.clone())
                            .is_ok_and(|request_key| request_key == *key)
                    });
                if matches {
                    self.rendered_state = consumed.clone();
                    self.prepared_browser_state = None;
                }
            }
        }
        self.trace.push(&request, &response);
        self.reconcile_browser_dev_pack();
        if self.started
            && !was_active
            && self.host.lifecycle_state().ok() == Some(container_core::LifecycleState::Active)
            && self.current_renderer_profile() == RendererProfile::WebView
        {
            self.queue_browser_render()?;
        }
        Ok(response)
    }

    pub fn dispatch_json(
        &mut self,
        input: impl AsRef<[u8]>,
    ) -> Result<BridgeBatch, SimulatorError> {
        let value: Value = serde_json::from_slice(input.as_ref())?;
        if value.get("messages").is_some() {
            let batch: BridgeBatch = serde_json::from_value(value)?;
            let mut output = Vec::new();
            for request in batch.messages {
                output.extend(self.dispatch(request)?.messages);
            }
            Ok(BridgeBatch::new(output))
        } else {
            let request: BridgeEnvelope = serde_json::from_value(value)?;
            self.dispatch(request)
        }
    }

    /// Execute one JSONL script. Blank lines and `#` comments are ignored;
    /// each non-empty line is one envelope or `{messages:[...]}` batch.
    pub fn dispatch_jsonl(&mut self, source: &str) -> Result<Vec<BridgeBatch>, SimulatorError> {
        let mut output = Vec::new();
        for (index, line) in source.lines().enumerate() {
            let line_number = index + 1;
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            output.push(
                self.dispatch_json(line)
                    .map_err(|error| SimulatorError::Jsonl {
                        line: line_number,
                        message: error.to_string(),
                    })?,
            );
        }
        Ok(output)
    }

    pub fn write_trace(&self, path: impl AsRef<Path>) -> Result<(), SimulatorError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        // Stream the already encoded history instead of expanding every
        // blob byte back into a JSON Value and cloning the complete trace.
        let mut output = io::BufWriter::new(fs::File::create(path)?);
        output.write_all(b"{\"schemaVersion\":1,\"engine\":")?;
        serde_json::to_writer(&mut output, &self.config.engine)?;
        output.write_all(b",\"traceSummary\":")?;
        serde_json::to_writer(&mut output, &self.trace_summary())?;
        output.write_all(b",\"records\":[")?;
        for (index, record) in self.trace.records.iter().enumerate() {
            if index > 0 {
                output.write_all(b",")?;
            }
            output.write_all(&record.bytes)?;
        }
        output.write_all(b"]}\n")?;
        output.flush()?;
        Ok(())
    }

    pub fn write_snapshot(&self, path: impl AsRef<Path>) -> Result<(), SimulatorError> {
        let snapshot = self.host.render_snapshot().map_err(SimulatorError::Host)?;
        write_json(path, &snapshot)
    }

    pub fn report(&self, status: &str) -> SimulatorReport {
        let snapshot = self
            .host
            .render_snapshot_ref()
            .ok()
            .map(|snapshot| SnapshotSummary {
                frame_id: snapshot.frame_id,
                width: snapshot.width,
                height: snapshot.height,
                stride: snapshot.stride,
                format: snapshot.format.clone(),
                pixel_bytes: snapshot.pixels.len(),
            });
        SimulatorReport {
            schema_version: 1,
            session_id: self.config.session_id.clone(),
            status: status.to_owned(),
            engine: self.config.engine,
            compiler: self.manifest.compiler.clone(),
            route: self
                .host
                .session()
                .and_then(|session| session.app_service().pages().current())
                .map(|page| page.path.clone())
                .or_else(|| self.config.route.clone())
                .or_else(|| self.manifest.routes.first().map(|route| route.path.clone())),
            renderer: self.host.renderer_backend().ok().map(str::to_owned),
            lifecycle_state: self.host.lifecycle_state().ok().map(|state| format!("{state:?}")),
            trace_count: self.trace.len(),
            trace_summary: self.trace_summary(),
            elapsed_ms: self.elapsed_ms,
            snapshot,
            notes: [
                "Headless developer simulator only; this report does not certify WeChat DevTools, GPU, emulator, or device parity.".into(),
                "The same bridge batches and content-addressed blobs are consumed by native and Web hosts.".into(),
            ].into_iter().chain((self.trace.dropped_records > 0).then(|| {
                "TRACE_HISTORY_TRUNCATED: bounded development history is incomplete; use a separate full-retention run for complete conformance evidence.".into()
            })).collect(),
        }
    }

    fn dispatch_startup(&mut self, operation: &str, payload: Value) -> Result<(), SimulatorError> {
        let batch = self.dispatch_request(operation, payload)?;
        let failure = if operation == op::RENDER_COMMIT {
            dev_render_error(&batch)
        } else {
            bridge_batch_failure(&batch, operation)
        };
        if let Some(error) = failure {
            return Err(error);
        }
        self.dev_errors.extend(
            batch
                .messages
                .into_iter()
                .filter(|message| message.op == op::ERROR),
        );
        Ok(())
    }

    fn dispatch_request(
        &mut self,
        operation: &str,
        payload: Value,
    ) -> Result<BridgeBatch, SimulatorError> {
        let request_id = format!("sim-{}", self.next_request);
        self.next_request = self.next_request.saturating_add(1);
        self.dispatch(BridgeEnvelope::request(
            self.config.session_id.clone(),
            request_id,
            operation,
            payload,
        ))
    }

    fn selected_route(&self) -> Result<String, SimulatorError> {
        route_for_manifest(self.config.route.as_deref(), None, &self.manifest)
            .ok_or_else(|| SimulatorError::Config("manifest has no routes; pass --route".into()))
    }

    fn template_for_route(&self, route: &str) -> Result<String, SimulatorError> {
        let candidate = format!("template:{route}.wxml");
        if self
            .manifest
            .templates
            .iter()
            .any(|template| template.id == candidate)
        {
            return Ok(candidate);
        }
        self.manifest
            .templates
            .first()
            .map(|template| template.id.clone())
            .ok_or_else(|| SimulatorError::Config("manifest has no WXML templates".into()))
    }

    fn module_payload(&self) -> Result<Vec<Value>, SimulatorError> {
        self.manifest
            .modules
            .iter()
            .map(|module| {
                let pointer = format!("sha256:{}", module.sha256);
                let bytes =
                    self.blobs
                        .get(&pointer)
                        .ok_or_else(|| SimulatorError::MissingBlob {
                            pointer: pointer.clone(),
                        })?;
                Ok(json!({"id": module.id, "bytes": bytes}))
            })
            .collect()
    }

    fn render_blobs_value(&self) -> Value {
        Value::Object(
            self.blobs
                .iter()
                .map(|(pointer, bytes)| {
                    (
                        pointer.clone(),
                        Value::Array(bytes.iter().map(|byte| Value::from(*byte)).collect()),
                    )
                })
                .collect(),
        )
    }
}

fn dev_render_error(batch: &BridgeBatch) -> Option<SimulatorError> {
    if render_commit_published(batch) {
        None
    } else {
        bridge_batch_failure(batch, "render commit").or_else(|| {
            Some(SimulatorError::Config(
                "render commit returned no publication acknowledgement".into(),
            ))
        })
    }
}

fn render_commit_published(batch: &BridgeBatch) -> bool {
    batch.messages.iter().any(|message| {
        message.kind == container_bridge::EnvelopeKind::Response
            && message.op == op::RENDER_COMMIT
            && message.payload.get("ok") == Some(&Value::Bool(true))
            // Accept the existing success response from older runtimes too;
            // committed is an additive protocol field, never a new envelope.
            && message.payload.get("committed") != Some(&Value::Bool(false))
    })
}

fn bridge_batch_failure(batch: &BridgeBatch, phase: &str) -> Option<SimulatorError> {
    batch.messages.iter().find_map(|message| {
        (message.payload.get("ok") == Some(&Value::Bool(false))).then(|| {
            SimulatorError::Config(format!(
                "{phase} failed: {}: {}",
                message
                    .payload
                    .get("error")
                    .and_then(|error| error.get("code"))
                    .and_then(Value::as_str)
                    .unwrap_or("ERR_ENGINE"),
                message
                    .payload
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown render error")
            ))
        })
    })
}

/// Pack validation has no engine or host-session side effects. Development
/// consumers that publish packs to a browser Worker use the same integrity
/// boundary as a local simulator without running a second AppService.
struct ValidatedPack {
    manifest_bytes: Vec<u8>,
    manifest: ContainerManifestV1,
    blobs: BTreeMap<String, Vec<u8>>,
}

fn read_validated_pack(root: &Path) -> Result<ValidatedPack, SimulatorError> {
    if !root.is_dir() {
        return Err(SimulatorError::InvalidPack(root.to_owned()));
    }
    let manifest_bytes = fs::read(root.join("manifest.json"))?;
    let manifest: ContainerManifestV1 = serde_json::from_slice(&manifest_bytes)?;
    // Schema/blob hashes alone cannot authorize a changed route/module/style
    // while retaining an old integrity root. Validate all three together.
    manifest.verify_integrity()?;
    let blobs = load_blobs(root, &manifest)?;
    Ok(ValidatedPack {
        manifest_bytes,
        manifest,
        blobs,
    })
}

fn load_blobs(
    root: &Path,
    manifest: &ContainerManifestV1,
) -> Result<BTreeMap<String, Vec<u8>>, SimulatorError> {
    let dir = root.join("blobs").join("sha256");
    let mut blobs = BTreeMap::new();
    if dir.is_dir() {
        for entry in fs::read_dir(&dir)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if !container_ir::is_sha256(&name) {
                continue;
            }
            let bytes = fs::read(entry.path())?;
            let actual = hex_digest(&bytes);
            if actual != name {
                return Err(SimulatorError::BlobDigest {
                    pointer: format!("sha256:{name}"),
                    expected: name,
                    actual,
                });
            }
            blobs.insert(format!("sha256:{name}"), bytes);
        }
    }
    for pointer in declared_blob_pointers(manifest) {
        if !blobs.contains_key(&pointer) {
            return Err(SimulatorError::MissingBlob { pointer });
        }
    }
    Ok(blobs)
}

fn declared_blob_pointers(manifest: &ContainerManifestV1) -> Vec<String> {
    let mut pointers = Vec::new();
    if let Some(modern) = &manifest.modern_view {
        pointers.extend(modern.blob_hashes().map(|hash| format!("sha256:{hash}")));
    }
    if let Some(compiled) = &manifest.view_compilation {
        pointers.extend(
            compiled
                .modules
                .iter()
                .map(|module| format!("sha256:{}", module.executable_sha256)),
        );
        pointers.extend(
            compiled
                .documents
                .iter()
                .flat_map(|document| &document.expressions)
                .map(|expression| format!("sha256:{}", expression.executable_sha256)),
        );
    }
    pointers.extend(
        manifest
            .templates
            .iter()
            .map(|template| template.wxml_ast.clone()),
    );
    pointers.extend(manifest.styles.iter().map(|style| style.wxss_ir.clone()));
    pointers.extend(
        manifest
            .modules
            .iter()
            .map(|module| format!("sha256:{}", module.sha256)),
    );
    pointers.extend(
        manifest
            .view_scripts
            .iter()
            .map(|module| format!("sha256:{}", module.sha256)),
    );
    pointers.extend(
        manifest
            .assets
            .iter()
            .map(|asset| format!("sha256:{}", asset.sha256)),
    );
    pointers.sort();
    pointers.dedup();
    pointers
}

fn write_json(path: impl AsRef<Path>, value: &impl Serialize) -> Result<(), SimulatorError> {
    let path = path.as_ref();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

/// A candidate session starts its private startup sequence at `sim-1`. Once
/// that candidate becomes the active session, its trace entries are appended
/// to the existing history, so request IDs must be rebased as well. Keeping
/// this normalization local to the simulator avoids exposing a second bridge
/// protocol for development reloads.
fn rebase_trace_request_ids(record: &mut TraceRecord, offset: u64) {
    rebase_envelope_request_id(&mut record.request, offset);
    for message in &mut record.response.messages {
        rebase_envelope_request_id(message, offset);
    }
}

fn rebase_envelope_request_id(envelope: &mut BridgeEnvelope, offset: u64) {
    let Some(number) = envelope
        .request_id
        .strip_prefix("sim-")
        .and_then(|value| value.parse::<u64>().ok())
    else {
        return;
    };
    let rebased = format!("sim-{}", number.saturating_add(offset));
    let old = std::mem::replace(&mut envelope.request_id, rebased.clone());
    let error_matches = envelope
        .payload
        .get("error")
        .and_then(Value::as_object)
        .and_then(|error| error.get("requestId"))
        .and_then(|value| value.as_str())
        .is_some_and(|request_id| request_id == old);
    if error_matches {
        if let Some(request_id) = envelope
            .payload
            .get_mut("error")
            .and_then(Value::as_object_mut)
            .and_then(|error| error.get_mut("requestId"))
        {
            *request_id = Value::String(rebased);
        }
    }
}

/// Helper for embedders that need the same deterministic default host config.
pub fn default_session_config(config: &SimulatorConfig) -> SessionConfig {
    SessionConfig {
        session_id: config.session_id.clone(),
        engine: config.engine,
        page_render_mode: config.page_render_mode,
        renderer_override: config.renderer_override,
        browser_view_enabled: config.browser_view_enabled,
        view_execution: config.view_execution.clone(),
        host: HostMetadata {
            kind: HostKind::Desktop,
            platform: "simulator".to_owned(),
            ..HostMetadata::default()
        },
        ..SessionConfig::default()
    }
}

const fn engine_feature(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Quickjs => "quickjs-native",
        EngineKind::V8 => "v8-native",
    }
}

#[cfg(test)]
mod tests {
    mod dev_raster_factory;
    use super::*;
    use container_core::{DataPatch, DataPatchBatch, PageId, TimerKind};
    use container_ir::{
        parse_wxml, parse_wxss, AppInfo, CompilerInfo, Integrity, Route, RouteKind, Style,
        StyleScope, Template,
    };
    use container_render_skia::Renderer;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn simulator_view_policy_defaults_match_runtime() {
        let config = SimulatorConfig::default();
        assert_eq!(config.view_execution.batch_timeout_ms, 50);
        assert_eq!(
            default_session_config(&config).view_execution,
            container_runtime::ViewExecutionPolicy::default()
        );
    }

    static TEST_PACK_ID: AtomicU64 = AtomicU64::new(0);

    fn test_pack() -> (PathBuf, String) {
        let nonce = TEST_PACK_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "weapp-simulator-test-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("blobs/sha256")).unwrap();
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "sim-test".into(),
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
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(root.join("manifest.json"), bytes).unwrap();
        manifest.refresh_integrity().unwrap();
        let path = root.join("manifest.json");
        fs::write(&path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        (root, manifest.integrity.root)
    }

    fn render_pack(path: &Path, route: &str, wxml_source: &str, wxss_source: &str) {
        fs::create_dir_all(path.join("blobs/sha256")).unwrap();
        let wxml = parse_wxml(wxml_source).unwrap().canonical_json().unwrap();
        let wxss = parse_wxss(wxss_source).unwrap().canonical_json().unwrap();
        let wxml_hash = hex_digest(&wxml);
        let wxss_hash = hex_digest(&wxss);
        fs::write(path.join("blobs/sha256").join(&wxml_hash), &wxml).unwrap();
        fs::write(path.join("blobs/sha256").join(&wxss_hash), &wxss).unwrap();
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "sim-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "page.js".into(),
            }],
            templates: vec![Template {
                id: format!("template:{route}.wxml"),
                wxml_ast: format!("sha256:{wxml_hash}"),
                bindings: vec!["title".into()],
                wxs_modules: Default::default(),
            }],
            styles: vec![Style {
                id: format!("style:{route}.wxss"),
                wxss_ir: format!("sha256:{wxss_hash}"),
                scope: StyleScope::Page,
            }],
            integrity: Integrity {
                algorithm: "sha256".into(),
                root: String::new(),
            },
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        fs::write(
            path.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn install_app_modules(path: &Path, app_source: &str, page_source: &str) {
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(path.join("manifest.json")).unwrap()).unwrap();
        manifest.app.entry_module = "module:app.js".into();
        manifest.routes[0].entry_module = "module:page.js".into();
        manifest
            .modules
            .retain(|module| module.id != "module:app.js" && module.id != "module:page.js");
        for (id, scope, source) in [
            ("module:app.js", container_ir::ModuleScope::App, app_source),
            (
                "module:page.js",
                container_ir::ModuleScope::Page,
                page_source,
            ),
        ] {
            let hash = hex_digest(source.as_bytes());
            fs::write(path.join("blobs/sha256").join(&hash), source).unwrap();
            manifest.modules.push(container_ir::Module {
                id: id.into(),
                sha256: hash,
                format: container_ir::ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
        }
        manifest.refresh_integrity().unwrap();
        fs::write(
            path.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_coordinate_taps_invoke_wxml_handler_once_and_repaint(engine: EngineKind) {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            r#"<view id="increment" bindtap="onTap"><text id="counter">count{{count}}</text></view>"#,
            "view { width: 200px; height: 80px; background-color: #ffffff; } text { color: #123456; font-size: 24px; line-height: 32px; }",
        );
        install_app_modules(
            &root,
            "App({});",
            "Page({data:{count:0},onTap(){this.setData({count:this.data.count+1});}});",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                engine,
                viewport: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 200.0,
                    height: 80.0,
                },
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();

        let frame_text = |simulator: &Simulator| {
            serde_json::to_string(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer()
                    .last_frame()
                    .unwrap(),
            )
            .unwrap()
        };
        assert!(frame_text(&simulator).contains("count0"));
        let initial_snapshot = simulator.host().render_snapshot().unwrap();
        #[cfg(feature = "skia-raster")]
        assert!(
            initial_snapshot.pixels.chunks(4).any(|pixel| {
                pixel[3] > 0 && pixel[0] < 200 && pixel[1] < 200 && pixel[2] < 200
            }),
            "Skia must rasterize the counter text, not only its white background"
        );
        let mut previous_snapshot = initial_snapshot;

        for expected_count in [1, 2] {
            // Read coordinates from the committed frame, exactly as a host
            // surface does. The bridge receives no target or handler hints:
            // WXML bindings alone must select and invoke Page.onTap.
            let bounds = simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap()
                .query("#increment", false)
                .unwrap()[0]
                .bounds;
            assert!(bounds.width > 0.0 && bounds.height > 0.0);
            let event = simulator
                .dispatch_request(
                    op::EVENT_BATCH,
                    json!({"events":[{
                        "type":"tap",
                        "x":bounds.x + bounds.width / 2.0,
                        "y":bounds.y + bounds.height / 2.0,
                        "bubbles":true
                    }]}),
                )
                .unwrap();
            assert_eq!(event.messages[0].payload["ok"], true);
            simulator.pump(u64::MAX).unwrap();
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["count"],
                expected_count,
                "a coordinate tap must invoke the WXML handler exactly once"
            );
            assert!(frame_text(&simulator).contains(&format!("count{expected_count}")));
            let snapshot = simulator.host().render_snapshot().unwrap();
            assert!(snapshot.frame_id > previous_snapshot.frame_id);
            #[cfg(feature = "skia-raster")]
            assert_ne!(
                snapshot.pixels, previous_snapshot.pixels,
                "changing only counter text must change rasterized pixels"
            );
            previous_snapshot = snapshot;
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_coordinate_taps_invoke_wxml_handler_once_and_repaint() {
        assert_coordinate_taps_invoke_wxml_handler_once_and_repaint(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_coordinate_taps_invoke_wxml_handler_once_and_repaint() {
        assert_coordinate_taps_invoke_wxml_handler_once_and_repaint(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_internal_startup_errors_are_drained_once_and_replaced_on_recovery(
        engine: EngineKind,
    ) {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            r#"<view id="tap" bindtap="onTap">{{count}}</view>"#,
            "view { width: 100px; height: 100px; }",
        );
        install_app_modules(
            &root,
            "App({});",
            "Page({data:{count:0},observers:{count(){throw new Error('observer failed')}},onLoad(){this.setData({count:1})},onTap(){this.setData({count:2})}});",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let startup = simulator.take_dev_errors();
        assert!(!startup.messages.is_empty());
        assert!(startup
            .messages
            .iter()
            .all(|message| message.op == op::ERROR));
        assert!(serde_json::to_string(&startup)
            .unwrap()
            .contains("observer failed"));
        assert!(simulator.take_dev_errors().messages.is_empty());

        // Input failures already return to the surface through their batch;
        // collecting them again would duplicate the overlay/history entry.
        let input = simulator
            .dispatch_request(
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":10,"y":10,"bubbles":true}]}),
            )
            .unwrap();
        assert!(input.messages.iter().any(|message| message.op == op::ERROR));
        assert!(simulator.take_dev_errors().messages.is_empty());

        // Leave a new startup error pending, then verify a healthy restart
        // replaces it instead of publishing an error from an old session.
        install_app_modules(
            &root,
            "App({});",
            "Page({data:{count:0},observers:{count(){throw new Error('new startup failed')}},onLoad(){this.setData({count:3})}});",
        );
        assert_eq!(
            simulator.apply_dev_pack(&root).unwrap().0,
            DevReloadKind::Restart
        );
        assert!(!simulator.dev_errors.is_empty());
        install_app_modules(&root, "App({});", "Page({data:{count:4}});");
        assert_eq!(
            simulator.apply_dev_pack(&root).unwrap().0,
            DevReloadKind::Restart
        );
        assert!(simulator.take_dev_errors().messages.is_empty());
        let session = simulator.session_id().to_owned();

        // A failed candidate may itself have generated an error before the
        // fatal hook. None of its diagnostics belong to the accepted session.
        install_app_modules(
            &root,
            "App({onLaunch(){throw new Error('candidate rejected')}});",
            "Page({data:{count:5}});",
        );
        assert!(simulator.apply_dev_pack(&root).is_err());
        assert_eq!(simulator.session_id(), session);
        assert!(simulator.take_dev_errors().messages.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_internal_startup_errors_are_drained_once_and_replaced_on_recovery() {
        assert_internal_startup_errors_are_drained_once_and_replaced_on_recovery(
            EngineKind::Quickjs,
        );
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_internal_startup_errors_are_drained_once_and_replaced_on_recovery() {
        assert_internal_startup_errors_are_drained_once_and_replaced_on_recovery(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_in_place_reload_uses_live_data_without_replaying_startup(engine: EngineKind) {
        let (old_root, _) = test_pack();
        let (new_root, _) = test_pack();
        render_pack(
            &old_root,
            "pages/index/index",
            "<text>{{title}}</text>",
            "text { color: #123456; }",
        );
        render_pack(
            &new_root,
            "pages/index/index",
            r#"<template name="live"><text>{{title}}</text></template><template is="{{which}}" data="{{ title: title }}"/>"#,
            "text { color: #abcdef; }",
        );
        for root in [&old_root, &new_root] {
            install_app_modules(
                root,
                "App({});",
                "Page({data:{which:'cold',title:'startup'},onLoad(){this.setData({title:'loaded'});}});",
            );
        }
        let mut simulator = Simulator::from_pack_dir(
            &old_root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["title"],
            "loaded"
        );
        simulator
            .dispatch_request(
                op::DATA_PATCH_BATCH,
                json!({"pageId":1,"patches":[
                    {"path":"which","op":"set","value":"live"},
                    {"path":"title","op":"set","value":"edited"}
                ]}),
            )
            .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .schedule_timer(TimerKind::Timeout, 1000, 0, Some("retained".into()));
        let session_id = simulator.session_id().to_owned();
        let trace_len = simulator.trace.len();
        let lifecycle_sequence = simulator.host().lifecycle_sequence().unwrap();

        // A full candidate startup would select the absent "cold" template
        // and incorrectly reject this valid update. Only the live data can
        // resolve the newly introduced template invocation.
        let (kind, _) = simulator.apply_dev_pack(&new_root).unwrap();
        assert_eq!(kind, DevReloadKind::InPlace);
        assert_eq!(simulator.session_id(), session_id);
        assert_eq!(
            simulator.host().lifecycle_sequence().unwrap(),
            lifecycle_sequence
        );
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .timers()
                .pending(),
            1
        );
        let trace = simulator.trace();
        let appended = &trace[trace_len..];
        assert_eq!(appended.len(), 2);
        assert_eq!(appended[0]["request"]["op"], "view.reload");
        assert_eq!(appended[0]["response"]["messages"], json!([]));
        assert_eq!(appended[1]["request"]["op"], op::RENDER_COMMIT);
        assert_eq!(
            appended[1]["request"]["payload"]["templateId"],
            "template:pages/index/index.wxml"
        );
        assert_eq!(
            appended[1]["response"]["messages"][0]["requestId"],
            appended[1]["request"]["requestId"]
        );
        assert_eq!(
            appended[1]["response"]["messages"][0]["op"],
            op::RENDER_COMMIT
        );
        assert_eq!(
            appended[1]["response"]["messages"][0]["payload"]["committed"],
            true
        );
        let frame = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap();
        assert!(serde_json::to_string(frame).unwrap().contains("edited"));

        // Invalid render IR must fail in the isolated preview, before the
        // active manifest, pixels, or bridge history can change.
        let before_integrity = simulator.manifest.integrity.root.clone();
        let before_snapshot = simulator.host().render_snapshot().unwrap();
        let before_trace_len = simulator.trace.len();
        let mut invalid_manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(new_root.join("manifest.json")).unwrap()).unwrap();
        let invalid_template = parse_wxml(r#"<template is="missing"/>"#)
            .unwrap()
            .canonical_json()
            .unwrap();
        let invalid_hash = hex_digest(&invalid_template);
        fs::write(
            new_root.join("blobs/sha256").join(&invalid_hash),
            invalid_template,
        )
        .unwrap();
        invalid_manifest.templates[0].wxml_ast = format!("sha256:{invalid_hash}");
        invalid_manifest.refresh_integrity().unwrap();
        fs::write(
            new_root.join("manifest.json"),
            serde_json::to_vec(&invalid_manifest).unwrap(),
        )
        .unwrap();
        let error = simulator.apply_dev_pack(&new_root).unwrap_err();
        assert!(
            error.to_string().contains("template target not found"),
            "unexpected candidate error: {error}"
        );
        assert_eq!(simulator.manifest.integrity.root, before_integrity);
        assert_eq!(simulator.host().render_snapshot().unwrap(), before_snapshot);
        assert_eq!(simulator.trace.len(), before_trace_len);
        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_dev_render_preview_does_not_execute_modules_or_lifecycle(engine: EngineKind) {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            "<text>{{title}}</text>",
            "text { color: #123456; }",
        );
        install_app_modules(
            &root,
            "throw new Error('app module must not execute during render preview');",
            "throw new Error('page module must not execute during render preview');",
        );
        let mut candidate = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        let live = Simulator::from_pack_dir(&root, candidate.config.clone()).unwrap();
        let payload = json!({
            "templateId": candidate.manifest.templates[0].id,
            "blobs": candidate.render_blobs_value(),
            "data": {"title": "live preview"},
            "viewport": candidate.config.viewport,
            "frameId": 1,
        });
        candidate
            .host_mut()
            .session_mut()
            .unwrap()
            .preview_dev_render(live.host().session().unwrap(), &payload)
            .unwrap();
        let session = candidate.host().session().unwrap();
        assert!(session.app_service().pages().is_empty());
        assert_eq!(session.app_service().timers().pending(), 0);
        assert_eq!(session.app_service().lifecycle().sequence(), 0);
        assert_eq!(candidate.trace.len(), 0);
        assert_eq!(live.trace.len(), 0);
        assert!(!session.initialized());
        assert!(
            serde_json::to_string(session.renderer().last_frame().unwrap())
                .unwrap()
                .contains("live preview")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_in_place_reload_uses_live_data_without_replaying_startup() {
        assert_in_place_reload_uses_live_data_without_replaying_startup(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_in_place_reload_uses_live_data_without_replaying_startup() {
        assert_in_place_reload_uses_live_data_without_replaying_startup(EngineKind::V8);
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_dev_render_preview_does_not_execute_modules_or_lifecycle() {
        assert_dev_render_preview_does_not_execute_modules_or_lifecycle(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_dev_render_preview_does_not_execute_modules_or_lifecycle() {
        assert_dev_render_preview_does_not_execute_modules_or_lifecycle(EngineKind::V8);
    }

    #[test]
    fn loads_pack_and_dispatches_app_init() {
        let (root, _) = test_pack();
        let mut simulator = Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap();
        let output = simulator
            .dispatch(BridgeEnvelope::request(
                "simulator-1",
                "init",
                op::APP_INIT,
                json!({}),
            ))
            .unwrap();
        assert!(output
            .messages
            .iter()
            .any(|message| message.payload["ok"] == true));
        assert_eq!(simulator.trace().len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn presentation_configuration_stays_lazy_until_the_normal_first_draw() {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            "<text>{{title}}</text>",
            "text { color: #123456; }",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
                render_scale: 2.0,
                initial_data: json!({"title":"initial"}),
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        let viewport = simulator.viewport();
        assert!(!simulator.has_current_skia_scene());
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer_if_initialized()
            .is_none());
        simulator.apply_presentation(viewport, 3.0).unwrap();
        assert_eq!(simulator.render_scale(), 3.0);
        assert!(simulator.apply_presentation(viewport, f64::NAN).is_err());
        assert_eq!(simulator.render_scale(), 3.0);
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer_if_initialized()
            .is_none());
        assert!(simulator.trace().is_empty());

        simulator.run().unwrap();
        assert!(simulator.has_current_skia_scene());
        let observation = simulator
            .host()
            .session()
            .unwrap()
            .accepted_page_observation()
            .unwrap();
        let frame = observation.frame.clone();
        assert_eq!(
            observation.target,
            RenderTargetSize::for_viewport(viewport, 3.0).unwrap()
        );
        let revision = observation.render_revision;
        // Simulator renders explicit page data, so a scene must not require a
        // consumed-input proof to support a density-only repaint.
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .last_frame_input(revision)
            .is_none());
        let trace_len = simulator.trace().len();
        simulator.apply_presentation(viewport, 2.0).unwrap();
        let observation = simulator
            .host()
            .session()
            .unwrap()
            .accepted_page_observation()
            .unwrap();
        assert_eq!(observation.frame, &frame);
        assert_eq!(observation.render_revision, revision + 1);
        assert_eq!(
            observation.target,
            RenderTargetSize::for_viewport(viewport, 2.0).unwrap()
        );
        assert_eq!(simulator.trace().len(), trace_len);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn bounded_trace_limits_encoded_payloads_and_preserves_explicit_loss() {
        let mut history = TraceHistory::default();
        history.set_retention(TraceRetention::Bounded {
            max_records: 16,
            max_bytes: 8 * 1024,
        });
        let request = BridgeEnvelope::request(
            "bounded",
            "request",
            op::RENDER_COMMIT,
            json!({"blobs":{"sha256:fixture": vec![255_u8; 1000]}}),
        );
        let response = BridgeBatch::new(Vec::new());
        for _ in 0..2048 {
            history.push(&request, &response);
            let summary = history.summary();
            assert!(summary.retained_bytes <= 8 * 1024);
            assert!(summary.retained_records <= 16);
            assert_eq!(
                summary.total_records,
                summary.retained_records as u64 + summary.dropped_records
            );
        }
        let summary = history.summary();
        assert!(!summary.complete);
        assert_eq!(summary.total_records, 2048);
        assert_eq!(summary.last_sequence, Some(2048));
        assert_eq!(summary.diagnostic_code, Some("TRACE_HISTORY_TRUNCATED"));
        assert!(summary.dropped_bytes > 0);

        // An individual payload larger than the entire byte budget is counted
        // and omitted, without allocating its complete encoded representation
        // or erasing the previous usable history.
        let old_records = history.len();
        let old_bytes = history.bytes;
        let oversized = BridgeEnvelope::request(
            "bounded",
            "oversized",
            op::RENDER_COMMIT,
            json!({"pixels": vec![255_u8; 64 * 1024]}),
        );
        history.push(&oversized, &response);
        assert_eq!(history.len(), old_records);
        assert_eq!(history.bytes, old_bytes);
        assert_eq!(history.summary().total_records, 2049);
        assert!(history.summary().dropped_bytes > summary.dropped_bytes + 64 * 1024);

        // Raising retention cannot turn a partial capture into full evidence.
        history.set_retention(TraceRetention::Full);
        history.push(&request, &response);
        assert!(!history.summary().complete);
        assert_eq!(history.summary().last_sequence, Some(2050));
    }

    #[test]
    fn full_trace_serialization_is_exact_and_repeatable() {
        let request = BridgeEnvelope::request(
            "full",
            "input",
            op::RENDER_COMMIT,
            json!({"data":{"text":"中文","items":[1,2,3]},"blobs":{"fixture":[0,128,255]}}),
        );
        let response = BridgeBatch::new(vec![BridgeEnvelope::request(
            "full",
            "output",
            op::API_RESULT,
            json!({"ok":false,"error":{"code":"ERR_ENGINE","requestId":"input"}}),
        )]);
        let mut first = TraceHistory::default();
        let mut second = TraceHistory::default();
        for sequence in 1..=64 {
            first.push(&request, &response);
            second.push(&request, &response);
            let expected = serde_json::to_value(TraceRecord {
                sequence,
                request: request.clone(),
                response: response.clone(),
            })
            .unwrap();
            assert_eq!(
                serde_json::from_slice::<Value>(&first.records.back().unwrap().bytes).unwrap(),
                expected
            );
        }
        assert!(first.summary().complete);
        assert_eq!(first.len(), 64);
        assert_eq!(first.summary().dropped_records, 0);
        for (first, second) in first.records.iter().zip(second.records.iter()) {
            assert_eq!(first.bytes, second.bytes);
        }
    }

    #[test]
    fn trace_export_reports_truncation_without_changing_dispatch_results() {
        let (root, _) = test_pack();
        let mut simulator = Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap();
        simulator.set_trace_retention(TraceRetention::Bounded {
            max_records: 2,
            max_bytes: 1,
        });
        let response = simulator.dispatch_request(op::APP_INIT, json!({})).unwrap();
        assert_eq!(response.messages[0].payload["ok"], true);
        assert!(simulator.trace().is_empty());
        let report = simulator.report("passed");
        assert!(!report.trace_summary.complete);
        assert!(report
            .notes
            .iter()
            .any(|note| note.contains("TRACE_HISTORY_TRUNCATED")));
        let path = root.join("trace.json");
        simulator.write_trace(&path).unwrap();
        let exported: Value = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(exported["schemaVersion"], 1);
        assert_eq!(exported["records"], json!([]));
        assert_eq!(exported["traceSummary"]["complete"], false);
        assert_eq!(exported["traceSummary"]["totalRecords"], 1);
        assert_eq!(exported["traceSummary"]["droppedRecords"], 1);
        assert_eq!(
            exported["traceSummary"]["diagnosticCode"],
            "TRACE_HISTORY_TRUNCATED"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn development_history_stays_bounded_during_interaction_pump_and_restart() {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            "<view bindtap=\"increment\" />",
            "view { width: 8px; height: 8px; background-color: #123456; }",
        );
        install_app_modules(
            &root,
            "App({});",
            "Page({data:{count:0},increment(){this.setData({count:this.data.count+1});}});",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                viewport: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 8.0,
                    height: 8.0,
                },
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.set_trace_retention(TraceRetention::Bounded {
            max_records: 12,
            max_bytes: 16 * 1024,
        });
        simulator.run().unwrap();
        for expected_count in 1..=256 {
            let response = simulator
                .dispatch_request(
                    op::EVENT_BATCH,
                    json!({"events":[{"type":"tap","x":4,"y":4,"bubbles":true}]}),
                )
                .unwrap();
            assert_eq!(response.messages[0].payload["ok"], true);
            simulator.pump(u64::MAX).unwrap();
            let summary = simulator.trace_summary();
            assert!(summary.retained_records <= 12);
            assert!(summary.retained_bytes <= 16 * 1024);
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["count"],
                expected_count
            );
        }
        let before_idle = simulator.trace_summary().total_records;
        for _ in 0..4096 {
            assert!(simulator.pump(u64::MAX).unwrap().messages.is_empty());
        }
        assert_eq!(simulator.trace_summary().total_records, before_idle);
        assert!(simulator.trace_summary().dropped_records > 0);

        // Restart history uses total sequence/request counters, never the
        // shrinking retained length. A candidate's own eviction remains
        // visible in the combined report.
        simulator.set_trace_retention(TraceRetention::Bounded {
            max_records: 3,
            max_bytes: 16 * 1024,
        });
        for generation in 1..=4 {
            install_app_modules(
                &root,
                "App({});",
                &format!("Page({{data:{{count:{generation}}}}});"),
            );
            let before = simulator.trace_summary().total_records;
            let (kind, report) = simulator.apply_dev_pack(&root).unwrap();
            assert_eq!(kind, DevReloadKind::Restart);
            assert_eq!(report.trace_summary.total_records, before + 4);
            assert_eq!(report.trace_summary.retained_records, 3);
            assert_eq!(report.trace_summary.last_sequence, Some(before + 4));
            assert!(!report.trace_summary.complete);
            let records = simulator.trace();
            let mut previous = 0;
            for record in records {
                let sequence = record["sequence"].as_u64().unwrap();
                assert!(sequence > previous);
                previous = sequence;
                assert_eq!(record["request"]["requestId"], format!("sim-{sequence}"));
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn assert_pump_runs_timer_callbacks_and_renders_only_changed_state(engine: EngineKind) {
        let (root, _) = test_pack();
        render_pack(
            &root,
            "pages/index/index",
            "<text>{{title}}</text>",
            "text { color: #123456; }",
        );
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        manifest.app.entry_module = "module:app.js".into();
        manifest.routes[0].entry_module = "module:page.js".into();
        for (id, scope, source) in [
            ("module:app.js", container_ir::ModuleScope::App, "App({});"),
            ("module:page.js", container_ir::ModuleScope::Page,
                "Page({data:{title:'initial'},onLoad(){this.setData({title:'loaded'});setInterval(()=>this.setData({title:'timer-fired'}),50);}});"),
        ] {
            let hash = hex_digest(source.as_bytes());
            fs::write(root.join("blobs/sha256").join(&hash), source).unwrap();
            manifest.modules.push(container_ir::Module {
                id: id.into(), sha256: hash, format: container_ir::ModuleFormat::Commonjs,
                scope, dependencies: Vec::new(),
            });
        }
        manifest.refresh_integrity().unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let frame_text = |simulator: &Simulator| {
            serde_json::to_string(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer()
                    .last_frame()
                    .unwrap(),
            )
            .unwrap()
        };
        assert!(
            frame_text(&simulator).contains("loaded"),
            "first frame must include onLoad setData"
        );
        let previous_session = simulator.session_id().to_owned();
        let updated_style = parse_wxss("text { color: #abcdef; }")
            .unwrap()
            .canonical_json()
            .unwrap();
        let updated_style_hash = hex_digest(&updated_style);
        fs::write(
            root.join("blobs/sha256").join(&updated_style_hash),
            updated_style,
        )
        .unwrap();
        manifest.styles[0].wxss_ir = format!("sha256:{updated_style_hash}");
        manifest.refresh_integrity().unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            simulator.apply_dev_pack(&root).unwrap().0,
            DevReloadKind::InPlace
        );
        assert_eq!(simulator.session_id(), previous_session);
        assert!(frame_text(&simulator).contains("loaded"));
        let initial_frame = simulator.host().render_snapshot().unwrap().frame_id;
        let fired = simulator.pump(u64::MAX).unwrap();
        assert!(!fired.messages.is_empty());
        assert!(frame_text(&simulator).contains("timer-fired"));
        assert!(simulator.host().render_snapshot().unwrap().frame_id > initial_frame);
        let settled_frame = simulator.host().render_snapshot().unwrap().frame_id;
        let settled_trace = simulator.trace().len();
        assert!(
            simulator.pump(u64::MAX).unwrap().messages.is_empty(),
            "idle pump must not publish empty timer wrappers"
        );
        assert_eq!(
            simulator.host().render_snapshot().unwrap().frame_id,
            settled_frame
        );
        assert_eq!(simulator.trace().len(), settled_trace);

        simulator.dispatch_request(op::DATA_PATCH_BATCH,
            json!({"pageId":1,"patches":[{"path":"title","op":"set","value":"bridge-updated"}]})).unwrap();
        let changed = simulator.pump(u64::MAX).unwrap();
        assert!(!changed.messages.is_empty());
        assert!(frame_text(&simulator).contains("bridge-updated"));

        let restarted_source = "Page({data:{title:'restarted'}});";
        let restarted_hash = hex_digest(restarted_source.as_bytes());
        fs::write(
            root.join("blobs/sha256").join(&restarted_hash),
            restarted_source,
        )
        .unwrap();
        manifest.modules[1].sha256 = restarted_hash;
        manifest.refresh_integrity().unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert_eq!(
            simulator.apply_dev_pack(&root).unwrap().0,
            DevReloadKind::Restart
        );
        assert_ne!(simulator.session_id(), previous_session);
        assert!(frame_text(&simulator).contains("restarted"));
        assert!(
            simulator.pump(u64::MAX).unwrap().messages.is_empty(),
            "restart must drop the previous engine's repeating timer"
        );

        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .schedule_timer(TimerKind::Timeout, 0, 0, None);
        simulator
            .dispatch_request(op::APP_LIFECYCLE, json!({"event":"unload"}))
            .unwrap();
        let trace_after_unload = simulator.trace().len();
        assert!(simulator.pump(u64::MAX).unwrap().messages.is_empty());
        assert_eq!(simulator.trace().len(), trace_after_unload);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[cfg(feature = "quickjs-native")]
    fn quickjs_pump_runs_timer_callbacks_and_renders_only_changed_state() {
        assert_pump_runs_timer_callbacks_and_renders_only_changed_state(EngineKind::Quickjs);
    }

    #[test]
    #[cfg(feature = "v8-native")]
    fn v8_pump_runs_timer_callbacks_and_renders_only_changed_state() {
        assert_pump_runs_timer_callbacks_and_renders_only_changed_state(EngineKind::V8);
    }

    #[test]
    fn rejects_bad_blob_digest() {
        let (root, _) = test_pack();
        let digest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        fs::write(root.join("blobs/sha256").join(digest), b"wrong").unwrap();
        let error = Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap_err();
        assert!(matches!(error, SimulatorError::BlobDigest { .. }));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn explicit_engines_match_the_compiled_native_provider() {
        let (root, _) = test_pack();
        for engine in [EngineKind::Quickjs, EngineKind::V8] {
            let result = Simulator::from_pack_dir(
                &root,
                SimulatorConfig {
                    engine,
                    ..SimulatorConfig::default()
                },
            );
            // Cargo can unify the runtime's native feature through another
            // workspace package even when the simulator feature is not selected.
            // Verify the actual provider boundary in both configurations.
            if engine_provider_compiled(engine) {
                let simulator =
                    result.expect("a compiled engine provider must construct a native session");
                assert!(simulator
                    .host()
                    .session()
                    .unwrap()
                    .engine_provider_available());
            } else {
                let error = result.unwrap_err();
                assert!(matches!(
                    &error,
                    SimulatorError::EngineUnavailable { engine: requested } if *requested == engine
                ));
                assert!(error.to_string().starts_with("ERR_ENGINE:"));
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_manifest_integrity_mismatch() {
        let (root, _) = test_pack();
        let manifest_path = root.join("manifest.json");
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        manifest.compiler.commit = "tampered".into();
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        let error = Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap_err();
        assert!(matches!(
            error,
            SimulatorError::Manifest(ManifestError::InvalidIntegrity(_))
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn classifies_template_style_and_asset_changes_as_in_place() {
        let previous = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "sim-test".into(),
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
        let mut template_change = previous.clone();
        template_change.templates.push(Template {
            id: "template:pages/index/index.wxml".into(),
            wxml_ast: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .into(),
            bindings: Vec::new(),
            wxs_modules: Default::default(),
        });
        assert_eq!(
            classify_manifest_reload(&previous, &template_change),
            DevReloadKind::InPlace
        );

        let mut module_change = previous;
        module_change.modules.push(container_ir::Module {
            id: "module:pages/index/index.js".into(),
            sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into(),
            format: container_ir::ModuleFormat::Commonjs,
            scope: container_ir::ModuleScope::Page,
            dependencies: Vec::new(),
        });
        assert_eq!(
            classify_manifest_reload(&template_change, &module_change),
            DevReloadKind::Restart
        );
    }

    #[test]
    fn view_script_source_graph_and_document_bindings_require_restart() {
        let previous = ContainerManifestV1 {
            view_scripts: vec![container_ir::ViewScriptModule {
                id: "wxs:shared/format.wxs".into(),
                sha256: "a".repeat(64),
                dependencies: vec![],
            }],
            templates: vec![Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: format!("sha256:{}", "b".repeat(64)),
                bindings: vec![],
                wxs_modules: BTreeMap::from([("format".into(), "wxs:shared/format.wxs".into())]),
            }],
            ..Default::default()
        };
        let mut next = previous.clone();
        next.templates[0].wxml_ast = format!("sha256:{}", "c".repeat(64));
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        next.view_scripts[0].sha256 = "d".repeat(64);
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        next = previous.clone();
        next.view_scripts[0]
            .dependencies
            .push("wxs:shared/util.wxs".into());
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        next = previous.clone();
        next.templates[0].wxs_modules.clear();
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        next = previous.clone();
        next.templates[0].id = "template:shared/card.wxml".into();
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        next = previous.clone();
        next.view_scripts.clear();
        next.templates[0].wxs_modules.clear();
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
    }

    #[test]
    fn legacy_wxs_assets_are_executable_reload_inputs() {
        let previous = ContainerManifestV1::default();
        let mut next = previous.clone();
        next.assets.push(container_ir::Asset {
            path: "shared/format.wxs".into(),
            sha256: "a".repeat(64),
            mime: "application/octet-stream".into(),
            size: 1,
        });
        assert_eq!(
            classify_manifest_reload(&previous, &next),
            DevReloadKind::Restart
        );
        let mut changed = next.clone();
        changed.assets[0].sha256 = "b".repeat(64);
        assert_eq!(
            classify_manifest_reload(&next, &changed),
            DevReloadKind::Restart
        );
    }

    #[test]
    fn view_script_blobs_must_exist_and_match_their_digest() {
        let (root, _) = test_pack();
        let source = b"module.exports.value = 1;";
        let sha256 = hex_digest(source);
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(root.join("manifest.json")).unwrap()).unwrap();
        manifest.view_scripts.push(container_ir::ViewScriptModule {
            id: "wxs:shared/format.wxs".into(),
            sha256: sha256.clone(),
            dependencies: vec![],
        });
        manifest.refresh_integrity().unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(matches!(
            Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap_err(),
            SimulatorError::MissingBlob { pointer } if pointer == format!("sha256:{sha256}")
        ));
        fs::write(root.join("blobs/sha256").join(&sha256), b"tampered").unwrap();
        assert!(matches!(
            Simulator::from_pack_dir(&root, SimulatorConfig::default()).unwrap_err(),
            SimulatorError::BlobDigest { expected, .. } if expected == sha256
        ));
        fs::write(root.join("blobs/sha256").join(&sha256), source).unwrap();
        assert_eq!(
            load_blobs(&root, &manifest).unwrap()[&format!("sha256:{sha256}")],
            source
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn failed_view_script_pack_keeps_the_previous_live_generation() {
        let (root, _) = test_pack();
        let (candidate_root, _) = test_pack();
        render_pack(&root, "pages/index/index", "<text>{{title}}</text>", "");
        render_pack(
            &candidate_root,
            "pages/index/index",
            "<text>{{format.fail(title)}}</text>",
            "",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                initial_data: json!({"title": "retained"}),
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let previous_id = simulator.session_id().to_owned();
        let previous_root = simulator.manifest().integrity.root.clone();
        let previous_pixels = simulator.host().render_snapshot().unwrap();
        let previous_trace = simulator.trace.len();
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(candidate_root.join("manifest.json")).unwrap())
                .unwrap();
        let source = b"throw new Error('WXS must not execute as AppService');";
        let hash = hex_digest(source);
        fs::write(candidate_root.join("blobs/sha256").join(&hash), source).unwrap();
        manifest.view_scripts.push(container_ir::ViewScriptModule {
            id: "wxs:shared/format.wxs".into(),
            sha256: hash,
            dependencies: vec![],
        });
        manifest.templates[0]
            .wxs_modules
            .insert("format".into(), "wxs:shared/format.wxs".into());
        manifest.refresh_integrity().unwrap();
        fs::write(
            candidate_root.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let error = simulator.apply_dev_pack(&candidate_root).unwrap_err();
        let expected = if cfg!(feature = "quickjs-native") {
            "WXS must not execute as AppService"
        } else {
            "ERR_ENGINE"
        };
        assert!(error.to_string().contains(expected), "{error}");
        assert_eq!(simulator.session_id(), previous_id);
        assert_eq!(simulator.manifest().integrity.root, previous_root);
        assert_eq!(simulator.host().render_snapshot().unwrap(), previous_pixels);
        assert_eq!(simulator.trace.len(), previous_trace);
        let batch = simulator
            .dispatch_request(
                op::DATA_PATCH_BATCH,
                json!({
                    "pageId": 1,
                    "patches": [{"path":"title", "op":"set", "value":"still responsive"}]
                }),
            )
            .unwrap();
        assert!(!batch
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false));
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["title"],
            "still responsive"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(candidate_root).unwrap();
    }

    #[test]
    fn public_leading_slash_route_is_resolved_to_manifest_path() {
        let nonce = TEST_PACK_ID.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "weapp-simulator-route-normalization-{}-{nonce}",
            std::process::id()
        ));
        render_pack(
            &root,
            "pages/index/index",
            r#"<view><text>route</text></view>"#,
            "view { width: 100px; }",
        );
        let mut simulator = Simulator::from_pack_dir(
            &root,
            SimulatorConfig {
                route: Some(" /pages/index/index ".into()),
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        let report = simulator.run().unwrap();
        assert_eq!(report.route.as_deref(), Some("pages/index/index"));
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .path,
            "pages/index/index"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn in_place_reload_preserves_page_data_storage_and_timers() {
        let nonce = TEST_PACK_ID.fetch_add(1, Ordering::Relaxed);
        let old_root = std::env::temp_dir().join(format!(
            "weapp-simulator-reload-old-{}-{nonce}",
            std::process::id()
        ));
        let new_root = std::env::temp_dir().join(format!(
            "weapp-simulator-reload-new-{}-{nonce}",
            std::process::id()
        ));
        render_pack(
            &old_root,
            "pages/index/index",
            r#"<view id="root"><text>{{title}}</text></view>"#,
            "view { width: 100px; }",
        );
        render_pack(
            &new_root,
            "pages/index/index",
            r#"<view id="root"><text class="updated">{{title}}</text></view>"#,
            "view { width: 200px; }",
        );
        let mut simulator = Simulator::from_pack_dir(
            &old_root,
            SimulatorConfig {
                initial_data: json!({"title": "initial"}),
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        let page_id = simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id;
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .apply_data_patch_batch(&DataPatchBatch {
                page_id,
                patches: vec![DataPatch::set("title", json!("edited"))],
            })
            .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("token", json!("persisted"))
            .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .schedule_timer(TimerKind::Timeout, 500, 0, Some("tick".into()));
        let lifecycle_sequence = simulator.host().lifecycle_sequence().unwrap();
        let (kind, _) = simulator.apply_dev_pack(&new_root).unwrap();
        assert_eq!(kind, DevReloadKind::InPlace);
        let session = simulator.host().session().unwrap();
        assert_eq!(
            session.app_service().lifecycle().sequence(),
            lifecycle_sequence
        );
        assert_eq!(session.app_service().pages().current().unwrap().id, page_id);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["title"],
            "edited"
        );
        assert_eq!(
            session.app_service().storage().get("token"),
            Some(&json!("persisted"))
        );
        assert_eq!(session.app_service().timers().pending(), 1);
        assert_eq!(
            session
                .renderer()
                .last_frame()
                .unwrap()
                .query(".updated", false)
                .unwrap()
                .len(),
            1
        );
        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn restart_reload_discards_page_data_storage_and_timers() {
        let nonce = TEST_PACK_ID.fetch_add(1, Ordering::Relaxed);
        let old_root = std::env::temp_dir().join(format!(
            "weapp-simulator-restart-old-{}-{nonce}",
            std::process::id()
        ));
        let new_root = std::env::temp_dir().join(format!(
            "weapp-simulator-restart-new-{}-{nonce}",
            std::process::id()
        ));
        render_pack(
            &old_root,
            "pages/index/index",
            r#"<view id="root"><text>{{title}}</text></view>"#,
            "view { width: 100px; }",
        );
        render_pack(
            &new_root,
            "pages/other/index",
            r#"<view id="root"><text>restarted</text></view>"#,
            "view { width: 200px; }",
        );
        let mut simulator =
            Simulator::from_pack_dir(&old_root, SimulatorConfig::default()).unwrap();
        simulator.run().unwrap();
        let previous_session_id = simulator.session_id().to_owned();
        let previous_trace = simulator.trace();
        let page_id = simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id;
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .apply_data_patch_batch(&DataPatchBatch {
                page_id,
                patches: vec![DataPatch::set("title", json!("edited"))],
            })
            .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("token", json!("discard"))
            .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .app_service_mut()
            .schedule_timer(TimerKind::Timeout, 500, 0, None);
        let (kind, _) = simulator.apply_dev_pack(&new_root).unwrap();
        assert_eq!(kind, DevReloadKind::Restart);
        assert_ne!(simulator.session_id(), previous_session_id);
        assert_eq!(simulator.session_id(), "simulator-1-reload-1");
        let stale_response = simulator
            .dispatch(BridgeEnvelope::request(
                previous_session_id,
                "stale-input",
                op::DIAGNOSTIC,
                json!({}),
            ))
            .unwrap();
        assert_eq!(stale_response.messages[0].op, op::ERROR);
        assert_eq!(stale_response.messages[0].payload["ok"], false);
        let session = simulator.host().session().unwrap();
        assert_eq!(
            session.app_service().pages().current().unwrap().path,
            "pages/other/index"
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().id,
            PageId(1)
        );
        assert!(session.app_service().storage().get("token").is_none());
        assert_eq!(session.app_service().timers().pending(), 0);
        let trace = simulator.trace();
        assert!(
            trace.len() > previous_trace.len(),
            "restart startup must append to the existing normalized trace"
        );
        assert_eq!(&trace[..previous_trace.len()], &previous_trace[..]);
        for (index, record) in trace.iter().enumerate() {
            assert_eq!(record["sequence"], json!(index as u64 + 1));
        }
        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }

    #[test]
    fn invalid_reload_keeps_previous_session_running() {
        let nonce = TEST_PACK_ID.fetch_add(1, Ordering::Relaxed);
        let old_root = std::env::temp_dir().join(format!(
            "weapp-simulator-invalid-old-{}-{nonce}",
            std::process::id()
        ));
        let new_root = std::env::temp_dir().join(format!(
            "weapp-simulator-invalid-new-{}-{nonce}",
            std::process::id()
        ));
        render_pack(
            &old_root,
            "pages/index/index",
            r#"<view><text>old</text></view>"#,
            "view { width: 100px; }",
        );
        render_pack(
            &new_root,
            "pages/index/index",
            r#"<view><text>new</text></view>"#,
            "view { width: 200px; }",
        );
        let mut simulator =
            Simulator::from_pack_dir(&old_root, SimulatorConfig::default()).unwrap();
        simulator.run().unwrap();
        let before = simulator.report("ready");
        let next_manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(new_root.join("manifest.json")).unwrap()).unwrap();
        let missing = next_manifest.templates[0]
            .wxml_ast
            .strip_prefix("sha256:")
            .unwrap();
        fs::remove_file(new_root.join("blobs/sha256").join(missing)).unwrap();

        let error = simulator.apply_dev_pack(&new_root).unwrap_err();
        assert!(matches!(error, SimulatorError::MissingBlob { .. }));
        assert_eq!(simulator.report("ready").route, before.route);
        assert!(simulator.host().initialized());

        let _ = fs::remove_dir_all(old_root);
        let _ = fs::remove_dir_all(new_root);
    }
}
