//! Local development surface for the Weapp Container simulator.
//!
//! [`WebSurface`] is deliberately dependency free.  It owns a non-blocking
//! TCP listener and serves a small browser UI, JSON state/snapshot endpoints,
//! a bridge POST endpoint, and an SSE event stream.  A development supervisor
//! keeps the runtime state in its own thread (or event loop) and uses the
//! [`WebSurfaceHandle`] to publish state and events without exposing runtime
//! internals to the browser.

use container_render_skia::{RenderFrame, RenderSnapshot, RenderTargetSize};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::io::{self, ErrorKind, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, Instant};

#[path = "web_dom.rs"]
mod dom;
#[path = "web_preview.rs"]
mod preview;
pub use preview::{PreviewFence, PreviewOwnerFence, PreviewRequest, QueuedBridgeRequest};
#[path = "web_sse_preview.rs"]
mod sse_preview;
pub use sse_preview::{PreviewControlReceipt, PreviewRetirement};
#[path = "web_strict_raster.rs"]
mod strict_raster;
pub use strict_raster::DevRasterWebSession;

#[cfg(test)]
#[path = "web_sse_preview_tests.rs"]
mod sse_preview_tests;

#[path = "web_resources.rs"]
mod resources;
use resources::ResourceRequestError;
pub use resources::{WebResourceBody, WebResourceResolution, WebResourceTarget};

#[cfg(test)]
#[path = "web_resources_tests.rs"]
mod resource_tests;

#[path = "web_dev_app.rs"]
mod dev_app;

#[path = "web_control_surface.rs"]
mod control;
pub use control::WebSurfaceDrainStatus;

#[cfg(test)]
#[path = "web_control_surface_tests.rs"]
mod control_tests;

#[cfg(test)]
#[path = "web_density_tests.rs"]
mod density_tests;

#[cfg(test)]
#[path = "web_logical_resize_tests.rs"]
mod logical_resize_tests;

#[cfg(test)]
#[path = "web_reservation_tests.rs"]
mod reservation_tests;

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
fn enabled_native_test_engines() -> impl Iterator<Item = container_core::EngineKind> {
    [
        #[cfg(feature = "quickjs-native")]
        container_core::EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        container_core::EngineKind::V8,
    ]
    .into_iter()
}

#[path = "web_raster_frame.rs"]
mod raster_frame;

const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 256;
const MAX_EVENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_DIAGNOSTIC_HISTORY_RECORDS: usize = 256;
const MAX_DIAGNOSTIC_HISTORY_BYTES: usize = 512 * 1024;
const MAX_SSE_CLIENTS: usize = 16;
const MAX_HTTP_CONNECTIONS: usize = 64;
const MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;
const RESPONSE_WRITE_BUDGET: usize = 256 * 1024;
const RESPONSE_DRAIN_TIME: Duration = Duration::from_millis(2);
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_FRAME_CACHE_BYTES: usize = 64 * 1024 * 1024;
const MAX_FRAME_METADATA_BYTES: usize = 4096;
const MAX_FRAME_HTTP_HEADER_BYTES: usize = 512;
const MAX_FRAME_SESSION_BYTES: usize = 256;
// Fixed JSON keys and their map nodes coexist with encoded metadata. This
// conservative allowance is separate from the real response/source capacities.
const FRAME_RESERVATION_METADATA_BYTES: usize = MAX_FRAME_METADATA_BYTES * 4;
const MAX_FRAME_RESERVATIONS: usize = 16;
const MAX_PRESENTATION_REQUESTS: usize = 16;
const MAX_BRIDGE_REQUESTS: usize = 64;
const MAX_BRIDGE_QUEUE_BYTES: usize = 8 * 1024 * 1024;
const HTTP_DEADLINE: Duration = Duration::from_secs(5);
const MAX_RENDERER_ASSET_BYTES: usize = 32 * 1024 * 1024;
const RENDERER_PINS: &str =
    include_str!("../../../examples/hosts/web-wasm/renderer-dependency-pins.json");

#[derive(Debug)]
struct CachedRenderFrame {
    session_id: String,
    generation: u64,
    revision: u64,
    response: Arc<Vec<u8>>,
    resources: BTreeMap<String, Arc<Vec<u8>>>,
}

/// One structured development diagnostic shown by the browser overlay.
#[derive(Clone, Debug, Serialize)]
pub struct DevDiagnostic {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub revision: u64,
    pub phase: String,
    pub severity: String,
    pub code: String,
    pub file: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    pub timestamp: String,
}

impl DevDiagnostic {
    pub fn error(revision: u64, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            revision,
            phase: "runtime".into(),
            severity: "error".into(),
            code: code.into(),
            file: None,
            message: message.into(),
            stack: None,
            timestamp: now_timestamp(),
        }
    }
}

/// Metadata rendered in the simulator header and returned by `/api/state`.
#[derive(Clone, Debug, Serialize)]
pub struct WebSurfaceState {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub revision: u64,
    pub status: String,
    pub route: Option<String>,
    pub engine: String,
    pub renderer: Option<String>,
    #[serde(rename = "lifecycleState")]
    pub lifecycle_state: Option<String>,
    #[serde(rename = "traceCount")]
    pub trace_count: usize,
    pub diagnostics: Vec<DevDiagnostic>,
}

impl Default for WebSurfaceState {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            status: "starting".into(),
            route: None,
            engine: "quickjs".into(),
            renderer: None,
            lifecycle_state: None,
            trace_count: 0,
            diagnostics: Vec::new(),
        }
    }
}

#[derive(Clone, Debug)]
struct WebEvent {
    #[cfg(test)]
    _drop_probe: Option<Arc<sse_preview::EventDropProbe>>,
    id: u64,
    kind: String,
    wire: Arc<[u8]>,
}

#[derive(Debug)]
struct DiagnosticRecord {
    value: Value,
    bytes: usize,
}

/// A versioned binary frame: little-endian u32 JSON header length, UTF-8
/// metadata, then tightly packed straight-alpha RGBA8. This is a whole-frame
/// handoff; no render-node calls cross the browser/runtime boundary.
#[derive(Debug)]
struct CachedFrame {
    render_revision: u64,
    snapshot: RenderSnapshot,
    metadata: Value,
    response: Arc<Vec<u8>>,
}

/// Read-only facts captured by one actual Web frame reservation. Private
/// fields and no wire/clone constructor keep this tied to its real allocation;
/// these facts do not replace live preview-owner or runtime-page validation.
#[derive(Debug)]
pub struct CapturedWebFrameIdentity {
    owner: Weak<Mutex<Shared>>,
    session_id: String,
    frame_id: u64,
    config_generation: u64,
    logical_width: f32,
    logical_height: f32,
    width: u32,
    height: u32,
    preview_epoch: u64,
}

impl CapturedWebFrameIdentity {
    /// Allocation identity only, without acquiring the Web mutex. A match is
    /// not a live lease, publication or presentation acknowledgment.
    pub fn belongs_to(&self, handle: &WebSurfaceHandle) -> bool {
        Weak::ptr_eq(&self.owner, &Arc::downgrade(&handle.shared))
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn frame_id(&self) -> u64 {
        self.frame_id
    }
    pub fn config_generation(&self) -> u64 {
        self.config_generation
    }
    pub fn logical_width(&self) -> f32 {
        self.logical_width
    }
    pub fn logical_height(&self) -> f32 {
        self.logical_height
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn preview_epoch(&self) -> u64 {
        self.preview_epoch
    }
}

/// Preallocated capacity and captured transport identity for one candidate.
/// No Web mutex is held while this value crosses application hooks or paint.
/// Another publisher may proceed; its publication invalidates this candidate.
#[derive(Debug)]
pub struct WebFrameReservation<'a> {
    handle: &'a WebSurfaceHandle,
    publication_epoch: u64,
    captured_transport_session: String,
    captured_next_transport_frame: u64,
    identity: CapturedWebFrameIdentity,
    metadata: Value,
    response: Vec<u8>,
    source_pixels: Vec<u8>,
    ledger: Vec<RetainedResponseBytes>,
    source_bytes: usize,
    next_transport_frame: u64,
    #[cfg(test)]
    cancellation_probe: Option<FrameReservationDropProbe>,
    // Rust drops fields in declaration order. Keep the charge alive until
    // every candidate allocation has actually been released on cancellation.
    claim: Arc<FrameCapacityClaim>,
}

/// Admission facts for one owner presentation change. No store lock crosses
/// runtime hooks or renderer preparation; the final prepared store checks them
/// again while holding its existing publication guard.
#[derive(Clone, Debug)]
pub struct PresentationControlFence {
    owner: Weak<Mutex<Shared>>,
    publication_epoch: Option<u64>,
    transport_session: String,
    next_transport_frame: u64,
    presentation: Value,
    renderer_profile: Option<container_ir::RendererProfile>,
    preview_enabled: bool,
    preview_session: String,
    preview_generation: u64,
    preview_authority_epoch: u64,
    preview_request: Option<Value>,
    preview: Option<PreviewFence>,
}

impl WebSurfaceHandle {
    /// Compare allocation identity before any runtime hook can execute. A
    /// reservation carries its own publication handle, so equal session and
    /// generation values cannot establish that it belongs to this surface.
    pub(crate) fn validate_logical_resize_owner(
        &self,
        control: &PresentationControlFence,
        reservation: Option<&WebFrameReservation<'_>>,
    ) -> Result<(), String> {
        if !Weak::ptr_eq(&control.owner, &Arc::downgrade(&self.shared))
            || reservation
                .is_some_and(|reservation| !Arc::ptr_eq(&reservation.handle.shared, &self.shared))
        {
            return Err("ERR_CANCELLED: logical resize belongs to another Web surface".into());
        }
        Ok(())
    }
}

#[cfg(test)]
struct FrameReservationDropProbe(Option<Box<dyn FnOnce()>>);

#[cfg(test)]
impl std::fmt::Debug for FrameReservationDropProbe {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("FrameReservationDropProbe")
    }
}

#[cfg(test)]
impl Drop for FrameReservationDropProbe {
    fn drop(&mut self) {
        if let Some(probe) = self.0.take() {
            probe();
        }
    }
}

/// The weak store entry charges live candidate allocations even when no Web
/// guard is held. Dropping a candidate never locks a poisoned/reentrant store.
#[derive(Debug)]
struct FrameCapacityClaim {
    bytes: usize,
    kind: FrameClaimKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameClaimKind {
    Candidate,
    RetiredSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FrameAllocation {
    Response,
    Source,
    Ledger,
    Claim,
}

impl<'a> WebFrameReservation<'a> {
    /// Borrow this reservation's typed capture without JSON decoding, a new
    /// lock, sequence consumption or another owner ledger. Publication remains
    /// subject to final reservation validation; owner/page proofs are separate.
    pub fn identity(&self) -> &CapturedWebFrameIdentity {
        &self.identity
    }

    /// Compatibility publisher. Preparation can reject a superseded lease;
    /// joint owners must accept runtime state only after `prepare` succeeds.
    pub fn publish(
        self,
        snapshot: &RenderSnapshot,
        render_revision: u64,
        render_ms: f64,
    ) -> Result<(), String> {
        self.prepare(snapshot, render_revision, render_ms)?
            .install();
        Ok(())
    }

    /// Validate and encode the real pixels without a store lock. Only after
    /// VM/paint and conversion finish do we lock the final publication owner,
    /// reject stale identity and prepare its bounded notification/ledger.
    pub fn prepare(
        self,
        snapshot: &RenderSnapshot,
        render_revision: u64,
        render_ms: f64,
    ) -> Result<PreparedWebPresentation<'a>, String> {
        self.prepare_encoded(snapshot, render_revision, render_ms, false)
    }

    fn prepare_encoded(
        mut self,
        snapshot: &RenderSnapshot,
        render_revision: u64,
        render_ms: f64,
        ticketed: bool,
    ) -> Result<PreparedWebPresentation<'a>, String> {
        if snapshot.width != self.identity.width
            || snapshot.height != self.identity.height
            || snapshot.stride < snapshot.width.saturating_mul(4)
            || snapshot.pixels.len() != self.source_bytes
            || snapshot.pixels.len() != snapshot.stride as usize * snapshot.height as usize
            || !matches!(snapshot.format.as_str(), "rgba8-premultiplied" | "rgba8")
        {
            return Err("ERR_RENDER: renderer violated the reserved frame contract".into());
        }
        if ticketed {
            self.metadata["sourceFrameId"] = snapshot.frame_id.to_string().into();
            self.metadata["renderRevision"] = render_revision.to_string().into();
        } else {
            self.metadata["sourceFrameId"] = snapshot.frame_id.into();
            self.metadata["renderRevision"] = render_revision.into();
        }
        self.metadata["renderMs"] = if render_ms.is_finite() && render_ms >= 0.0 {
            render_ms.into()
        } else {
            0.into()
        };
        // Session escaping and every other field have a fixed, prevalidated
        // upper bound. Slice writers cannot grow either allocation here.
        let mut header = io::Cursor::new([0_u8; MAX_FRAME_METADATA_BYTES]);
        serde_json::to_writer(&mut header, &self.metadata)
            .map_err(|_| "ERR_RENDER: frame metadata exceeds its reserved bound")?;
        let header_len = header.position() as usize;
        let packed_len = self.identity.width as usize * self.identity.height as usize * 4;
        let mut http = io::Cursor::new([0_u8; MAX_FRAME_HTTP_HEADER_BYTES]);
        let content_type = if ticketed {
            "application/vnd.weapp.frame.v2"
        } else {
            "application/vnd.weapp.frame.v1"
        };
        write!(http,"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",4+header_len+packed_len)
            .expect("fixed frame HTTP header fits its reserved upper bound");
        let http_len = http.position() as usize;
        self.response.extend_from_slice(&http.get_ref()[..http_len]);
        self.response
            .extend_from_slice(&(header_len as u32).to_le_bytes());
        self.response
            .extend_from_slice(&header.get_ref()[..header_len]);
        self.source_pixels.extend_from_slice(&snapshot.pixels);
        let premultiplied = snapshot.format == "rgba8-premultiplied";
        for row in snapshot.pixels.chunks_exact(snapshot.stride as usize) {
            for pixel in row[..self.identity.width as usize * 4].as_chunks::<4>().0 {
                let alpha = pixel[3];
                if premultiplied && alpha < 255 {
                    for channel in &pixel[..3] {
                        self.response.push(if alpha == 0 {
                            0
                        } else {
                            ((u32::from(*channel) * 255 + u32::from(alpha) / 2) / u32::from(alpha))
                                .min(255) as u8
                        });
                    }
                    self.response.push(alpha);
                } else {
                    self.response.extend_from_slice(pixel);
                }
            }
        }
        let response = Arc::new(self.response);
        self.ledger.push(RetainedResponseBytes {
            bytes: Arc::downgrade(&response),
            length: response.capacity(),
        });
        let transport_session = self.identity.session_id.clone();
        let measured_ms = self.metadata["renderMs"].as_f64().unwrap_or(0.0);
        let cached = CachedFrame {
            render_revision,
            snapshot: RenderSnapshot {
                frame_id: snapshot.frame_id,
                width: snapshot.width,
                height: snapshot.height,
                stride: snapshot.stride,
                format: snapshot.format.clone(),
                pixels: self.source_pixels,
            },
            metadata: self.metadata,
            response,
        };
        let mut shared = self
            .handle
            .shared
            .lock()
            .map_err(|_| "frame store unavailable")?;
        if shared.publication_epoch != Some(self.publication_epoch)
            || shared.transport_session != self.captured_transport_session
            || shared.next_transport_frame != self.captured_next_transport_frame
        {
            return Err("ERR_CANCELLED: Web frame capacity lease was superseded".into());
        }
        let next_publication_epoch = shared.checked_next_publication_epoch()?;
        shared.ensure_frame_capacity_excluding(self.claim.bytes, 0, 0, Some(&self.claim))?;
        shared
            .retained_response_bytes
            .try_reserve(self.ledger.len())
            .map_err(|_| "ERR_RENDER: frame cache ledger allocation failed")?;
        let event = shared.prepare_snapshot_event(&cached.metadata)?;
        let retired_source_claim = shared.prepare_retired_source_claim()?;
        Ok(PreparedWebPresentation {
            shared,
            owner: Arc::downgrade(&self.handle.shared),
            publication: Some(PreparedFramePublication {
                frame: PreparedFrame::Raster(cached),
                transport_session,
                next_transport_frame: self.next_transport_frame,
                render_ms: measured_ms,
            }),
            ledger: self.ledger,
            event: Some(event),
            presentation: None,
            next_publication_epoch,
            claim: Some(self.claim),
            retired_source_claim,
        })
    }
}

enum PreparedFrame {
    Raster(CachedFrame),
    Render(CachedRenderFrame),
}

struct PreparedFramePublication {
    frame: PreparedFrame,
    transport_session: String,
    next_transport_frame: u64,
    render_ms: f64,
}

struct PreparedSnapshotEvent {
    event: WebEvent,
    next_event_id: u64,
}

/// Exclusive transport candidate. All recoverable encoding/allocation/budget
/// failures precede construction. `install` moves only prepared owned fields;
/// it obtains no new lock and cannot invoke runtime/application code.
#[must_use = "drop keeps the accepted Web picture; install publishes the prepared one"]
pub struct PreparedWebPresentation<'a> {
    shared: MutexGuard<'a, Shared>,
    owner: Weak<Mutex<Shared>>,
    publication: Option<PreparedFramePublication>,
    ledger: Vec<RetainedResponseBytes>,
    event: Option<PreparedSnapshotEvent>,
    presentation: Option<Value>,
    next_publication_epoch: u64,
    claim: Option<Arc<FrameCapacityClaim>>,
    retired_source_claim: Option<Arc<FrameCapacityClaim>>,
}

impl PreparedWebPresentation<'_> {
    /// Final control validation shares the publication lock. A hook may have
    /// changed configuration, renderer, transport or a preview lease after
    /// HTTP admission. Reject before accepting either runtime or Web fields.
    pub fn validate_control(self, fence: &PresentationControlFence) -> Result<Self, String> {
        if !Weak::ptr_eq(&self.owner, &fence.owner) {
            return Err(
                "ERR_CANCELLED: presentation control belongs to another Web surface".into(),
            );
        }
        if self.shared.publication_epoch != fence.publication_epoch
            || self.shared.transport_session != fence.transport_session
            || self.shared.next_transport_frame != fence.next_transport_frame
            || self.shared.presentation != fence.presentation
            || self.shared.dom.profile != fence.renderer_profile
            || self.shared.dom.enabled != fence.preview_enabled
        {
            return Err("ERR_CANCELLED: presentation control lease was superseded".into());
        }
        self.shared
            .dom
            .validate_presentation_control(&self.shared.preview, fence)?;
        Ok(self)
    }

    pub fn with_presentation(mut self, presentation: Value) -> Self {
        self.presentation = Some(presentation);
        self
    }

    /// Irreversible acceptance. Queue/ledger capacity and the next epoch are
    /// prepared already. Retired large page owners move into locals, and are
    /// released only after the Web guard has explicitly been dropped.
    pub fn install(mut self) {
        let changed = self.publication.is_some() || self.presentation.is_some();
        let mut retired_picture = None;
        let mut retired_render = None;
        let mut retired_snapshot = None;
        let mut retired_session = None;
        let mut retired_settings = None;
        if let Some(publication) = self.publication {
            retired_session = Some(std::mem::replace(
                &mut self.shared.transport_session,
                publication.transport_session,
            ));
            self.shared.next_transport_frame = publication.next_transport_frame;
            self.shared.render_ms = publication.render_ms;
            retired_snapshot = self.shared.snapshot.take();
            let (raster, render) = match publication.frame {
                PreparedFrame::Raster(frame) => (Some(frame), None),
                PreparedFrame::Render(frame) => (None, Some(frame)),
            };
            retired_picture = std::mem::replace(&mut self.shared.frame, raster);
            retired_render = std::mem::replace(&mut self.shared.render_frame, render);
            self.shared.retained_response_bytes.extend(self.ledger);
        }
        if let Some(presentation) = self.presentation {
            retired_settings = Some(std::mem::replace(
                &mut self.shared.presentation,
                presentation,
            ));
        }
        if let Some(prepared) = self.event {
            self.shared.events.retain(|event| event.kind != "snapshot");
            self.shared.event_bytes = self
                .shared
                .events
                .iter()
                .map(|event| event.wire.len())
                .sum();
            self.shared.next_event_id = prepared.next_event_id;
            self.shared.event_bytes += prepared.event.wire.len();
            self.shared.events.push_back(prepared.event);
            while self.shared.events.len() > MAX_EVENTS || self.shared.event_bytes > MAX_EVENT_BYTES
            {
                if let Some(event) = self.shared.events.pop_front() {
                    self.shared.event_bytes -= event.wire.len();
                }
            }
        }
        if changed {
            self.shared.publication_epoch = Some(self.next_publication_epoch);
        }
        if let Some(claim) = &self.claim {
            let weak = Arc::downgrade(claim);
            self.shared
                .frame_capacity_claims
                .retain(|entry| !entry.ptr_eq(&weak) && entry.strong_count() > 0);
        }
        if let Some(charge) = &self.retired_source_claim {
            self.shared
                .frame_capacity_claims
                .push(Arc::downgrade(charge));
        }
        release_after_web_unlock(
            self.shared,
            (
                retired_picture,
                retired_render,
                retired_snapshot,
                retired_session,
                retired_settings,
                self.retired_source_claim,
            ),
        );
    }
}

/// Keep the unlock-before-resource-release order explicit and testable without
/// adding application callbacks to the publication critical section.
fn release_after_web_unlock<T>(shared: MutexGuard<'_, Shared>, retired: T) {
    drop(shared);
    #[cfg(test)]
    WEB_RETIREMENT_OBSERVER.with(|observer| {
        let next = observer.borrow_mut().take();
        if let Some(next) = next {
            next();
        }
    });
    drop(retired);
}

#[cfg(test)]
thread_local! {
    // Observe the actual unlocked-before-release interval without exposing a
    // production callback or requiring a custom allocator in ownership tests.
    static WEB_RETIREMENT_OBSERVER: std::cell::RefCell<Option<Box<dyn FnOnce()>>> =
        const { std::cell::RefCell::new(None) };
}

#[derive(Debug)]
struct RetainedResponseBytes {
    bytes: Weak<Vec<u8>>,
    length: usize,
}

// Private admission belongs in the ORIGINAL transport queue entry, while the
// public QueuedBridgeRequest body/preview literal remains source compatible.
struct QueuedWebBridgeRequest {
    request: QueuedBridgeRequest,
    strict: Option<strict_raster::BoundRasterAdmission>,
}

impl std::fmt::Debug for QueuedWebBridgeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueuedWebBridgeRequest")
            .field("request", &self.request)
            .field("strict", &self.strict.is_some())
            .finish()
    }
}

#[derive(Debug)]
struct Shared {
    dom: dom::DomState,
    preview: preview::PreviewState,
    strict_raster: bool,
    state: WebSurfaceState,
    state_override: Option<Value>,
    /// Diagnostics are retained independently from the current typed or
    /// supervisor-provided state.  A browser can connect after a build error
    /// (or refresh while the watcher is still running) and still obtain the
    /// same overlay through `/api/state` instead of relying on an SSE event
    /// that was emitted before the connection existed.
    diagnostics: Vec<Value>,
    // Active diagnostics drive the overlay; this separate bounded journal
    // survives recovery so fixing an error does not erase the debugging log.
    diagnostic_history: VecDeque<DiagnosticRecord>,
    diagnostic_history_bytes: usize,
    diagnostic_history_total: u64,
    diagnostic_history_dropped: u64,
    snapshot: Option<Arc<Value>>,
    frame: Option<CachedFrame>,
    render_frame: Option<CachedRenderFrame>,
    renderer_assets: BTreeMap<String, Arc<Vec<u8>>>,
    transport_session: String,
    next_transport_frame: u64,
    retained_response_bytes: Vec<RetainedResponseBytes>,
    frame_capacity_claims: Vec<Weak<FrameCapacityClaim>>,
    publication_epoch: Option<u64>,
    presentation: Value,
    render_ms: f64,
    presentation_requests: VecDeque<Value>,
    render_presented: VecDeque<Value>,
    confirmed_render_presented: Option<Value>,
    events: VecDeque<WebEvent>,
    event_bytes: usize,
    next_event_id: u64,
    bridge_requests: VecDeque<QueuedWebBridgeRequest>,
}

impl Default for Shared {
    fn default() -> Self {
        Self {
            dom: dom::DomState::default(),
            preview: preview::PreviewState::default(),
            strict_raster: false,
            state: WebSurfaceState::default(),
            state_override: None,
            diagnostics: Vec::new(),
            diagnostic_history: VecDeque::new(),
            diagnostic_history_bytes: 0,
            diagnostic_history_total: 0,
            diagnostic_history_dropped: 0,
            snapshot: None,
            frame: None,
            render_frame: None,
            renderer_assets: BTreeMap::new(),
            transport_session: String::new(),
            next_transport_frame: 1,
            retained_response_bytes: Vec::new(),
            frame_capacity_claims: Vec::new(),
            publication_epoch: Some(1),
            presentation: json!({"schemaVersion":1,"revision":0,"generation":0,
                "logicalWidth":375,"logicalHeight":667,"renderScale":"auto",
                "effectiveScale":1,"fps":60}),
            render_ms: 0.0,
            presentation_requests: VecDeque::new(),
            render_presented: VecDeque::new(),
            confirmed_render_presented: None,
            events: VecDeque::new(),
            event_bytes: 0,
            next_event_id: 1,
            bridge_requests: VecDeque::new(),
        }
    }
}

/// Cloneable publisher used by a development supervisor.
#[derive(Clone, Debug)]
pub struct WebSurfaceHandle {
    shared: Arc<Mutex<Shared>>,
}

impl WebSurfaceHandle {
    pub fn take_render_presented(&self) -> Vec<Value> {
        self.shared
            .lock()
            .map(|mut shared| shared.render_presented.drain(..).collect())
            .unwrap_or_default()
    }
    /// Called by the runtime owner after consuming an HTTP presentation receipt.
    /// HTTP queue admission alone never authorizes input against a new hit tree.
    pub fn confirm_render_presented(&self, receipt: &Value) -> Result<(), String> {
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if !shared.matches_render_receipt(receipt) {
            return Err("ERR_CANCELLED: stale or invalid render presentation receipt".into());
        }
        shared.confirmed_render_presented = Some(json!({
            "sessionId":receipt["sessionId"], "renderRevision":receipt["renderRevision"],
            "configGeneration":receipt["configGeneration"]
        }));
        Ok(())
    }

    /// Recheck immediately before runtime dispatch: queue admission may have
    /// preceded another request's accepted frame or presentation settings.
    pub fn validate_render_input(
        &self,
        request: &container_bridge::BridgeEnvelope,
    ) -> Result<(), String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if shared.render_fields_are_current(&request.op, &request.session_id, &request.payload) {
            Ok(())
        } else {
            Err("ERR_CANCELLED: input requires the current confirmed render presentation".into())
        }
    }
    /// Publish a complete committed layout frame for browser-local CanvasKit.
    /// Image bytes are addressed by their decoded RGBA digest, independently
    /// of the manifest's encoded asset identities. No page raster is created.
    pub fn publish_render_frame(
        &self,
        session_id: &str,
        config_generation: u64,
        frame: &RenderFrame,
        render_revision: u64,
        render_ms: f64,
    ) -> Result<(), String> {
        let effective_scale = self.presentation()["effectiveScale"]
            .as_f64()
            .unwrap_or(1.0);
        self.publish_render_frame_at_scale(
            session_id,
            config_generation,
            frame,
            render_revision,
            render_ms,
            effective_scale,
        )
    }

    /// Compatibility publisher. No accepted runtime page is changed here.
    pub fn publish_render_frame_at_scale(
        &self,
        session_id: &str,
        config_generation: u64,
        frame: &RenderFrame,
        render_revision: u64,
        render_ms: f64,
        effective_scale: f64,
    ) -> Result<(), String> {
        self.prepare_render_frame_at_scale(
            session_id,
            config_generation,
            frame,
            render_revision,
            render_ms,
            effective_scale,
        )?
        .install();
        Ok(())
    }

    /// Prepare resource bodies, layout encoding, ledger slots and the SSE wire
    /// under one held store lock, without changing the accepted publication.
    pub fn prepare_render_frame_at_scale(
        &self,
        session_id: &str,
        config_generation: u64,
        frame: &RenderFrame,
        render_revision: u64,
        render_ms: f64,
        effective_scale: f64,
    ) -> Result<PreparedWebPresentation<'_>, String> {
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        let next_publication_epoch = shared.checked_next_publication_epoch()?;
        if session_id.is_empty() || session_id.len() > MAX_FRAME_SESSION_BYTES {
            return Err("ERR_RENDER: invalid render frame session".into());
        }
        if let Some(previous) = &shared.render_frame {
            if previous.session_id == session_id {
                if config_generation < previous.generation
                    || (config_generation == previous.generation
                        && render_revision < previous.revision)
                {
                    return Err("ERR_RENDER: stale render frame publication".into());
                }
                if config_generation == previous.generation && render_revision == previous.revision
                {
                    return Ok(PreparedWebPresentation {
                        shared,
                        owner: Arc::downgrade(&self.shared),
                        publication: None,
                        ledger: Vec::new(),
                        event: None,
                        presentation: None,
                        next_publication_epoch,
                        claim: None,
                        retired_source_claim: None,
                    });
                }
            }
        }
        let target = RenderTargetSize::for_viewport(frame.viewport, effective_scale)
            .map_err(|error| error.to_string())?;
        let session_key = format!("{:x}", Sha256::digest(session_id.as_bytes()));
        let mut descriptors = BTreeMap::new();
        let mut resources = BTreeMap::new();
        let mut image_bytes = 0_usize;
        let previous_resources: BTreeMap<&str, &Arc<Vec<u8>>> = shared
            .render_frame
            .as_ref()
            .map(|old| {
                old.resources
                    .iter()
                    .filter_map(|(path, bytes)| path.rsplit('/').next().map(|hash| (hash, bytes)))
                    .collect()
            })
            .unwrap_or_default();
        if frame.images.len() > 1024 {
            return Err("ERR_RENDER: render resource count exceeded".into());
        }
        for (id, resource) in &frame.images {
            let expected = (resource.width as usize)
                .checked_mul(resource.height as usize)
                .and_then(|size| size.checked_mul(4));
            if resource.width == 0
                || resource.height == 0
                || resource.width > 8192
                || resource.height > 8192
                || expected != Some(resource.pixels.len())
            {
                return Err("ERR_RENDER: invalid decoded render resource".into());
            }
            image_bytes = image_bytes.saturating_add(resource.pixels.len());
            if image_bytes > MAX_FRAME_CACHE_BYTES {
                return Err("ERR_RENDER: render resource byte budget exceeded".into());
            }
            let hash = format!("{:x}", Sha256::digest(&resource.pixels));
            let url = format!(
                "/api/render-resources/{session_key}/{config_generation}/{render_revision}/{hash}"
            );
            let old = previous_resources
                .get(hash.as_str())
                .map(|bytes| Arc::clone(bytes));
            resources.entry(url.clone()).or_insert_with(|| {
                old.unwrap_or_else(|| {
                    Arc::new(encode_response(
                        200,
                        "application/octet-stream",
                        &resource.pixels,
                    ))
                })
            });
            descriptors.insert(
                id.clone(),
                json!({"sha256":hash,"url":url,"width":resource.width,"height":resource.height,
                "format":"rgba8","byteLength":resource.pixels.len()}),
            );
        }
        let mut exported = frame.clone();
        exported.images.clear();
        let transport_frame = if shared.transport_session == session_id {
            shared.next_transport_frame
        } else {
            1
        };
        let next_transport_frame = transport_frame
            .checked_add(1)
            .ok_or("ERR_RENDER: transport frame sequence exhausted")?;
        let envelope = json!({"schemaVersion":1,"protocolVersion":"1.0","format":"render-frame-v1",
            "sessionId":session_id,"frameId":transport_frame,"sourceFrameId":frame.frame_id,
            "configGeneration":config_generation,"renderRevision":render_revision,
            "logicalWidth":frame.viewport.width,"logicalHeight":frame.viewport.height,
            "width":target.width,"height":target.height,"renderMs":render_ms,
            "frame":exported,"resources":descriptors});
        let body = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
        if body.len() > MAX_FRAME_BYTES {
            return Err("ERR_RENDER: render frame metadata budget exceeded".into());
        }
        let response = Arc::new(encode_response(200, "application/json", &body));
        shared
            .retained_response_bytes
            .retain(|entry| entry.bytes.strong_count() > 0);
        let retained = shared
            .retained_response_bytes
            .iter()
            .map(|entry| entry.length)
            .sum::<usize>();
        let additional = resources
            .values()
            .chain(std::iter::once(&response))
            .filter(|bytes| {
                let weak = Arc::downgrade(bytes);
                !shared
                    .retained_response_bytes
                    .iter()
                    .any(|entry| entry.bytes.ptr_eq(&weak))
            })
            .map(|bytes| bytes.capacity())
            .sum::<usize>();
        // The old raster's source pixels coexist until installation. Include
        // them and any slow-client response Arcs in the joint cache budget.
        let old_source = shared
            .frame
            .as_ref()
            .map_or(0, |frame| frame.snapshot.pixels.capacity());
        if retained
            .saturating_add(additional)
            .saturating_add(old_source)
            .saturating_add(shared.live_frame_claim_bytes(None))
            > MAX_FRAME_CACHE_BYTES
        {
            return Err("ERR_RENDER: Web render frame cache budget exceeded".into());
        }
        let mut ledger = Vec::new();
        ledger
            .try_reserve(resources.len() + 1)
            .map_err(|_| "ERR_RENDER: candidate cache ledger allocation failed")?;
        for bytes in resources.values().chain(std::iter::once(&response)) {
            let weak = Arc::downgrade(bytes);
            if !shared
                .retained_response_bytes
                .iter()
                .chain(ledger.iter())
                .any(|entry: &RetainedResponseBytes| entry.bytes.ptr_eq(&weak))
            {
                ledger.push(RetainedResponseBytes {
                    bytes: weak,
                    length: bytes.capacity(),
                });
            }
        }
        shared
            .retained_response_bytes
            .try_reserve(ledger.len())
            .map_err(|_| "ERR_RENDER: frame cache ledger allocation failed")?;
        let notice = json!({"schemaVersion":1,"format":"render-frame-v1",
            "url":"/api/render-frame","sessionId":session_id,"frameId":transport_frame,
            "configGeneration":config_generation,"renderRevision":render_revision});
        let event = shared.prepare_snapshot_event(&notice)?;
        let retired_source_claim = shared.prepare_retired_source_claim()?;
        let cached = CachedRenderFrame {
            session_id: session_id.to_owned(),
            generation: config_generation,
            revision: render_revision,
            response,
            resources,
        };
        Ok(PreparedWebPresentation {
            shared,
            owner: Arc::downgrade(&self.shared),
            publication: Some(PreparedFramePublication {
                frame: PreparedFrame::Render(cached),
                transport_session: session_id.to_owned(),
                next_transport_frame,
                render_ms,
            }),
            ledger,
            event: Some(event),
            presentation: None,
            next_publication_epoch,
            claim: None,
            retired_source_claim,
        })
    }

    /// Replace the typed simulator metadata.
    pub fn set_state(&self, state: WebSurfaceState) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.diagnostics = state
                .diagnostics
                .iter()
                .filter_map(|diagnostic| serde_json::to_value(diagnostic).ok())
                .collect();
            shared.state = state;
            shared.state_override = None;
        }
    }

    /// Set an arbitrary state object while integrating a supervisor that has
    /// additional fields. `/api/state` returns this value verbatim.
    pub fn set_state_json(&self, state: Value) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.state_override = Some(state);
        }
    }

    /// Clear active diagnostics after a successful generation. The journal
    /// remains available in `diagnosticHistory` for the development session.
    /// The UI
    /// clears its overlay on the corresponding `reload` event, while this
    /// persisted list keeps `/api/state` and newly connected browsers in
    /// sync with that state.
    pub fn clear_diagnostics(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.diagnostics.clear();
        }
    }

    pub fn state(&self) -> Value {
        self.shared
            .lock()
            .map(|shared| shared.state_value())
            .unwrap_or_else(|_| json!({"schemaVersion": 1, "status": "unavailable"}))
    }

    /// Replace the complete serialized render snapshot returned by
    /// `/api/snapshot`. The value should be the `RenderSnapshot` JSON object.
    pub fn set_snapshot(&self, snapshot: Value) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.advance_publication_epoch();
            shared.snapshot = Some(Arc::new(snapshot));
            shared.frame = None;
        }
    }

    /// Budget-only compatibility query. Call [`Self::reserve_frame`] before
    /// mutating a presentation target: a capacity check alone does not reserve
    /// actual allocations or protect the claim against another publisher.
    pub fn check_frame_capacity(&self, width: u32, height: u32) -> Result<(), String> {
        let packed = (width as usize)
            .checked_mul(height as usize)
            .and_then(|size| size.checked_mul(4))
            .ok_or("frame size overflow")?;
        if width == 0 || height == 0 || width > 4096 || height > 4096 || packed > MAX_FRAME_BYTES {
            return Err("ERR_RENDER: invalid or over-budget presentation frame".into());
        }
        let mut shared = self.shared.lock().map_err(|_| "frame store unavailable")?;
        shared.ensure_frame_capacity(packed, packed, 4096)
    }

    /// Publish only a changed committed frame. Conversion to presentation RGBA
    /// happens once; all clients share the immutable HTTP body. The legacy
    /// snapshot JSON is encoded only if that endpoint is requested. This
    /// compatibility wrapper expects source frame ids to advance per pixel
    /// commit; renderer-backed publishers use `publish_frame_with_revision`
    /// so scrolling without a new source frame id is also observable.
    pub fn publish_frame(
        &self,
        session_id: &str,
        generation: u64,
        logical_width: f32,
        logical_height: f32,
        snapshot: &RenderSnapshot,
    ) -> Result<bool, String> {
        self.publish_frame_with_revision(
            session_id,
            generation,
            logical_width,
            logical_height,
            snapshot,
            snapshot.frame_id,
        )
    }

    /// Publish using the renderer's pixel revision, which advances for scroll
    /// rerasterization even when the native source frame id remains unchanged.
    /// Transport sequence ids are independent and monotonic within a session.
    pub fn publish_frame_with_revision(
        &self,
        session_id: &str,
        generation: u64,
        logical_width: f32,
        logical_height: f32,
        snapshot: &RenderSnapshot,
        render_revision: u64,
    ) -> Result<bool, String> {
        let shared = self.shared.lock().map_err(|_| "frame store unavailable")?;
        if shared.frame.as_ref().is_some_and(|frame| {
            frame.render_revision == render_revision
                && frame.metadata["sessionId"] == session_id
                && frame.metadata["configGeneration"] == generation
        }) {
            return Ok(false);
        }
        let packed_len = (snapshot.width as usize)
            .checked_mul(snapshot.height as usize)
            .and_then(|n| n.checked_mul(4))
            .ok_or("frame size overflow")?;
        if snapshot.width == 0
            || snapshot.height == 0
            || snapshot.width > 4096
            || snapshot.height > 4096
            || packed_len > MAX_FRAME_BYTES
            || snapshot.pixels.len() > MAX_FRAME_BYTES
            || snapshot.stride < snapshot.width.saturating_mul(4)
            || snapshot.pixels.len() != snapshot.stride as usize * snapshot.height as usize
            || !matches!(snapshot.format.as_str(), "rgba8-premultiplied" | "rgba8")
        {
            return Err("ERR_RENDER: invalid or over-budget presentation frame".into());
        }
        let render_ms = shared.render_ms;
        drop(shared);
        self.reserve_frame_using(
            session_id,
            generation,
            logical_width,
            logical_height,
            snapshot.width,
            snapshot.height,
            snapshot.pixels.len(),
            |_| Ok(()),
        )?
        .publish(snapshot, render_revision, render_ms)?;
        Ok(true)
    }

    /// Preallocate bounded candidate buffers and capture transport identity.
    /// The lease holds no Web lock and does not consume a transport sequence.
    /// Final `prepare` rejects intervening publications before joint runtime
    /// acceptance; dropping the lease releases capacity without locking.
    pub fn reserve_frame(
        &self,
        session_id: &str,
        generation: u64,
        logical_width: f32,
        logical_height: f32,
        width: u32,
        height: u32,
    ) -> Result<WebFrameReservation<'_>, String> {
        let source_bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|size| size.checked_mul(4))
            .ok_or("frame size overflow")?;
        self.reserve_frame_using(
            session_id,
            generation,
            logical_width,
            logical_height,
            width,
            height,
            source_bytes,
            |_| Ok(()),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn reserve_frame_using(
        &self,
        session_id: &str,
        generation: u64,
        logical_width: f32,
        logical_height: f32,
        width: u32,
        height: u32,
        source_bytes: usize,
        mut before_allocation: impl FnMut(FrameAllocation) -> Result<(), String>,
    ) -> Result<WebFrameReservation<'_>, String> {
        let packed_len = (width as usize)
            .checked_mul(height as usize)
            .and_then(|size| size.checked_mul(4))
            .ok_or("frame size overflow")?;
        if width == 0
            || height == 0
            || width > 4096
            || height > 4096
            || packed_len > MAX_FRAME_BYTES
            || source_bytes < packed_len
            || source_bytes > MAX_FRAME_BYTES
            || session_id.len() > MAX_FRAME_SESSION_BYTES
            || !logical_width.is_finite()
            || !logical_height.is_finite()
            || logical_width <= 0.0
            || logical_height <= 0.0
        {
            return Err("ERR_RENDER: invalid or over-budget presentation frame".into());
        }
        let mut shared = self.shared.lock().map_err(|_| "frame store unavailable")?;
        let next_publication_epoch = shared.checked_next_publication_epoch()?;
        let publication_epoch = next_publication_epoch - 1;
        shared
            .frame_capacity_claims
            .retain(|claim| claim.strong_count() > 0);
        if shared.live_frame_claim_count(FrameClaimKind::Candidate) >= MAX_FRAME_RESERVATIONS {
            return Err("ERR_RENDER: Web frame capacity lease count exceeded".into());
        }
        let transport_frame = if shared.transport_session == session_id {
            shared.next_transport_frame
        } else {
            1
        };
        let next_transport_frame = transport_frame
            .checked_add(1)
            .ok_or("transport frame sequence exhausted")?;
        let overhead = 4 + MAX_FRAME_METADATA_BYTES + MAX_FRAME_HTTP_HEADER_BYTES;
        shared.ensure_frame_capacity(
            packed_len,
            source_bytes,
            overhead + FRAME_RESERVATION_METADATA_BYTES,
        )?;
        let mut response = Vec::new();
        before_allocation(FrameAllocation::Response)?;
        response
            .try_reserve_exact(packed_len + overhead)
            .map_err(|_| "ERR_RENDER: frame allocation failed")?;
        let mut source_pixels = Vec::new();
        before_allocation(FrameAllocation::Source)?;
        source_pixels
            .try_reserve_exact(source_bytes)
            .map_err(|_| "ERR_RENDER: frame source allocation failed")?;
        before_allocation(FrameAllocation::Ledger)?;
        let mut ledger = Vec::new();
        ledger
            .try_reserve_exact(1)
            .map_err(|_| "ERR_RENDER: candidate cache ledger allocation failed")?;
        shared
            .retained_response_bytes
            .try_reserve(1)
            .map_err(|_| "ERR_RENDER: frame cache ledger allocation failed")?;
        let identity = CapturedWebFrameIdentity {
            owner: Arc::downgrade(&self.shared),
            session_id: session_id.to_owned(),
            frame_id: transport_frame,
            config_generation: generation,
            logical_width,
            logical_height,
            width,
            height,
            preview_epoch: shared.preview.epoch,
        };
        let mut metadata = json!({"schemaVersion":1,"sessionId":identity.session_id,
            "frameId":identity.frame_id,"sourceFrameId":u64::MAX,
            "renderRevision":u64::MAX,"configGeneration":identity.config_generation,
            "logicalWidth":identity.logical_width,"logicalHeight":identity.logical_height,
            "width":identity.width,"height":identity.height,"stride":identity.width * 4,"format":"rgba8",
            "byteLength":packed_len,"renderMs":f64::MAX,"url":"/api/frame"});
        let mut bounded_header = io::Cursor::new([0_u8; MAX_FRAME_METADATA_BYTES]);
        serde_json::to_writer(&mut bounded_header, &metadata)
            .map_err(|_| "ERR_RENDER: frame metadata exceeds its reserved bound")?;
        metadata["renderMs"] = 0.into();
        let captured_transport_session = shared.transport_session.clone();
        let claim_bytes = response
            .capacity()
            .saturating_add(source_pixels.capacity())
            .saturating_add(FRAME_RESERVATION_METADATA_BYTES)
            .saturating_add(captured_transport_session.capacity())
            .saturating_add(identity.session_id.capacity())
            .saturating_add(std::mem::size_of::<CapturedWebFrameIdentity>())
            .saturating_add(ledger.capacity() * std::mem::size_of::<RetainedResponseBytes>())
            .saturating_add(std::mem::size_of::<FrameCapacityClaim>())
            .saturating_add(std::mem::size_of::<Weak<FrameCapacityClaim>>());
        // Account for allocator capacities and all live candidate metadata,
        // not only the packed length eventually visible to the browser.
        shared.ensure_frame_capacity(claim_bytes, 0, 0)?;
        before_allocation(FrameAllocation::Claim)?;
        shared
            .frame_capacity_claims
            .try_reserve(1)
            .map_err(|_| "ERR_RENDER: frame capacity lease allocation failed")?;
        let claim = Arc::new(FrameCapacityClaim {
            bytes: claim_bytes,
            kind: FrameClaimKind::Candidate,
        });
        shared.frame_capacity_claims.push(Arc::downgrade(&claim));
        let captured_next_transport_frame = shared.next_transport_frame;
        drop(shared);
        Ok(WebFrameReservation {
            handle: self,
            publication_epoch,
            captured_transport_session,
            captured_next_transport_frame,
            identity,
            metadata,
            response,
            source_pixels,
            ledger,
            source_bytes,
            next_transport_frame,
            #[cfg(test)]
            cancellation_probe: None,
            claim,
        })
    }

    /// Set the renderer-measured prepare/raster/readback duration for the next
    /// frame. Callers must not substitute whole runtime/bridge execution time.
    pub fn set_render_time(&self, milliseconds: f64) {
        if milliseconds.is_finite() && milliseconds >= 0.0 {
            if let Ok(mut shared) = self.shared.lock() {
                shared.render_ms = milliseconds;
            }
        }
    }

    /// Acquire the final store once for a settings-only joint acceptance.
    /// The caller has already serialized the value and retains runtime ownership.
    pub fn prepare_presentation(
        &self,
        presentation: Value,
    ) -> Result<PreparedWebPresentation<'_>, String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        let next_publication_epoch = shared.checked_next_publication_epoch()?;
        Ok(PreparedWebPresentation {
            shared,
            owner: Arc::downgrade(&self.shared),
            publication: None,
            ledger: Vec::new(),
            event: None,
            presentation: Some(presentation),
            next_publication_epoch,
            claim: None,
            retired_source_claim: None,
        })
    }

    pub fn set_presentation(&self, presentation: Value) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.advance_publication_epoch();
            shared.presentation = presentation;
        }
    }

    pub fn presentation(&self) -> Value {
        self.shared
            .lock()
            .map(|shared| shared.presentation.clone())
            .unwrap_or(Value::Null)
    }

    pub fn take_presentation_requests(&self) -> Vec<Value> {
        self.shared
            .lock()
            .map(|mut shared| shared.presentation_requests.drain(..).collect())
            .unwrap_or_default()
    }

    pub fn clear_snapshot(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.retire_raster_publication();
        }
    }

    /// Publish an SSE event. A full `snapshot` payload updates only the latest
    /// frame store; the retained event contains metadata and `/api/snapshot`.
    /// Existing browser clients receive it on their next poll.
    pub fn publish(&self, kind: impl Into<String>, payload: Value) -> u64 {
        self.shared
            .lock()
            .map(|mut shared| shared.publish(kind.into(), payload))
            .unwrap_or(0)
    }

    pub fn publish_diagnostic(&self, diagnostic: DevDiagnostic) -> u64 {
        let payload = serde_json::to_value(diagnostic).unwrap_or_else(|_| json!({}));
        self.shared
            .lock()
            .map(|mut shared| {
                shared.push_diagnostic(payload.clone());
                shared.publish("diagnostic".into(), payload)
            })
            .unwrap_or(0)
    }

    /// Drain bridge requests received by POST `/api/bridge` when no callback
    /// was installed. This is useful for a supervisor that drives the
    /// simulator from its own loop.
    pub fn take_bridge_requests(&self) -> Vec<Vec<u8>> {
        self.shared
            .lock()
            .map(|mut shared| {
                if shared.strict_raster {
                    return Vec::new();
                }
                shared
                    .bridge_requests
                    .drain(..)
                    .map(|entry| entry.request.body)
                    .collect()
            })
            .unwrap_or_default()
    }
}

impl Shared {
    /// Drop only this surface's ownership of a retired raster publication.
    /// HTTP responses keep their immutable Arc bytes and remain charged to
    /// the weak ledger until delivery or disconnect. Transport sequences are
    /// preserved so returning to Skia cannot reuse an old frame identity.
    fn retire_raster_publication(&mut self) {
        self.advance_publication_epoch();
        self.snapshot = None;
        self.frame = None;
        self.render_frame = None;
        self.confirmed_render_presented = None;
        self.render_presented.clear();
        self.render_ms = 0.0;
    }

    fn matches_render_receipt(&self, value: &Value) -> bool {
        value.is_object()
            && value["backend"] == "canvaskit-webgl2"
            && value["gpuSurface"] == true
            && self.render_frame.as_ref().is_some_and(|frame| {
                value["sessionId"].as_str() == Some(frame.session_id.as_str())
                    && value["renderRevision"].as_u64() == Some(frame.revision)
                    && value["configGeneration"].as_u64() == Some(frame.generation)
            })
    }

    fn render_input_is_current(&self, body: &[u8]) -> bool {
        if self.render_frame.is_none() && self.renderer_assets.is_empty() {
            return true;
        }
        let Ok(value) = serde_json::from_slice::<Value>(body) else {
            return true; // Normal bridge validation retains malformed-input errors.
        };
        let messages = value["messages"]
            .as_array()
            .map_or_else(|| std::slice::from_ref(&value), Vec::as_slice);
        messages
            .iter()
            .all(|message| self.render_envelope_is_current(message))
    }

    fn render_envelope_is_current(&self, message: &Value) -> bool {
        self.render_fields_are_current(
            message["op"].as_str().unwrap_or_default(),
            message["sessionId"].as_str().unwrap_or_default(),
            &message["payload"],
        )
    }

    fn render_fields_are_current(&self, op: &str, session_id: &str, payload: &Value) -> bool {
        if op != "event.batch" || (self.render_frame.is_none() && self.renderer_assets.is_empty()) {
            return true;
        }
        let Some(frame) = &self.render_frame else {
            return false;
        };
        let Some(confirmed) = &self.confirmed_render_presented else {
            return false;
        };
        session_id == frame.session_id
            && payload["renderRevision"].as_u64() == Some(frame.revision)
            && payload["configGeneration"].as_u64() == Some(frame.generation)
            && confirmed["sessionId"] == session_id
            && confirmed["renderRevision"] == payload["renderRevision"]
            && confirmed["configGeneration"] == payload["configGeneration"]
    }

    fn track_response(&mut self, bytes: &Arc<Vec<u8>>) {
        let weak = Arc::downgrade(bytes);
        if !self
            .retained_response_bytes
            .iter()
            .any(|entry| entry.bytes.ptr_eq(&weak))
        {
            self.retained_response_bytes.push(RetainedResponseBytes {
                bytes: weak,
                length: bytes.capacity(),
            });
        }
    }
    fn checked_next_publication_epoch(&self) -> Result<u64, String> {
        self.publication_epoch
            .and_then(|epoch| epoch.checked_add(1))
            .ok_or_else(|| "ERR_RENDER: Web publication epoch exhausted".into())
    }

    fn advance_publication_epoch(&mut self) {
        // Void legacy setters may retire identity at exhaustion, but cannot
        // resurrect an old epoch. Prepared publishers reject before accepting.
        self.publication_epoch = self
            .publication_epoch
            .and_then(|epoch| epoch.checked_add(1));
    }

    fn prepare_retired_source_claim(&mut self) -> Result<Option<Arc<FrameCapacityClaim>>, String> {
        let bytes = self
            .frame
            .as_ref()
            .map_or(0, |frame| frame.snapshot.pixels.capacity());
        if bytes == 0 {
            return Ok(None);
        }
        self.frame_capacity_claims
            .retain(|claim| claim.strong_count() > 0);
        if self.live_frame_claim_count(FrameClaimKind::RetiredSource) >= MAX_FRAME_RESERVATIONS {
            return Err("ERR_RENDER: retired source accounting count exceeded".into());
        }
        self.frame_capacity_claims
            .try_reserve(1)
            .map_err(|_| "ERR_RENDER: retired source accounting allocation failed")?;
        // Not registered until install actually moves this source out. Before
        // then the current frame itself is the sole source accounting owner.
        Ok(Some(Arc::new(FrameCapacityClaim {
            bytes,
            kind: FrameClaimKind::RetiredSource,
        })))
    }

    fn live_frame_claim_count(&self, kind: FrameClaimKind) -> usize {
        self.frame_capacity_claims
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|claim| claim.kind == kind)
            .count()
    }

    fn live_frame_claim_bytes(&self, excluding: Option<&Arc<FrameCapacityClaim>>) -> usize {
        self.frame_capacity_claims
            .iter()
            .filter_map(Weak::upgrade)
            .filter(|claim| !excluding.is_some_and(|excluded| Arc::ptr_eq(excluded, claim)))
            .fold(0_usize, |total, claim| total.saturating_add(claim.bytes))
    }

    fn ensure_frame_capacity(
        &mut self,
        packed: usize,
        source: usize,
        overhead: usize,
    ) -> Result<(), String> {
        self.ensure_frame_capacity_excluding(packed, source, overhead, None)
    }

    fn ensure_frame_capacity_excluding(
        &mut self,
        packed: usize,
        source: usize,
        overhead: usize,
        excluding: Option<&Arc<FrameCapacityClaim>>,
    ) -> Result<(), String> {
        self.retained_response_bytes
            .retain(|entry| entry.bytes.strong_count() > 0);
        self.frame_capacity_claims
            .retain(|claim| claim.strong_count() > 0);
        let retained = self
            .retained_response_bytes
            .iter()
            .fold(0_usize, |total, entry| total.saturating_add(entry.length));
        let old_source = self
            .frame
            .as_ref()
            .map_or(0, |frame| frame.snapshot.pixels.capacity());
        if retained
            .saturating_add(old_source)
            .saturating_add(self.live_frame_claim_bytes(excluding))
            .saturating_add(packed)
            .saturating_add(source)
            .saturating_add(overhead)
            > MAX_FRAME_CACHE_BYTES
        {
            Err("ERR_RENDER: Web frame cache budget exceeded".into())
        } else {
            Ok(())
        }
    }

    fn state_value(&self) -> Value {
        let mut value = self.state_override.clone().unwrap_or_else(|| {
            serde_json::to_value(&self.state).unwrap_or_else(|_| json!({"schemaVersion": 1}))
        });
        self.dom.extend_state(&mut value, &self.preview);
        if let Some(object) = value.as_object_mut() {
            if self.strict_raster {
                object.insert("preview".into(), self.preview.preview_value());
            }
            object.insert("diagnostics".into(), Value::Array(self.diagnostics.clone()));
            object.insert("presentation".into(), self.presentation.clone());
            if !self.dom.enabled {
                // Installed renderer assets express a capability. Auto mode
                // has no selected renderer until the runtime loads a page;
                // report that gap explicitly instead of requesting CPU pixels.
                let renderer = if self.render_frame.is_some()
                    || (self.dom.profile.is_some() && !self.renderer_assets.is_empty())
                {
                    "canvaskit"
                } else if self.dom.profile.is_some()
                    || self.frame.is_some()
                    || self.snapshot.is_some()
                {
                    "software"
                } else {
                    "pending"
                };
                object.insert("webRenderer".into(), json!(renderer));
            }
            if let Some(receipt) = self
                .confirmed_render_presented
                .as_ref()
                .filter(|_| !self.dom.enabled)
            {
                object.insert("renderPresented".into(), receipt.clone());
            }
            object.insert(
                "diagnosticHistory".into(),
                json!({
                    "schemaVersion": 1,
                    "records": self.diagnostic_history.iter().map(|record| &record.value).collect::<Vec<_>>(),
                    "totalRecords": self.diagnostic_history_total,
                    "droppedRecords": self.diagnostic_history_dropped,
                    "complete": self.diagnostic_history_dropped == 0,
                }),
            );
            // Runtime pumping can publish another successful frame while an
            // earlier error is still active. Keep its status aligned with the
            // overlay until a successful generation explicitly clears it.
            if object.get("status").and_then(Value::as_str) == Some("ready")
                && self.diagnostics.iter().any(|diagnostic| {
                    diagnostic.get("severity").and_then(Value::as_str) == Some("error")
                })
            {
                object.insert("status".into(), json!("error"));
            }
        }
        value
    }

    fn push_diagnostic(&mut self, diagnostic: Value) {
        self.diagnostic_history_total = self.diagnostic_history_total.saturating_add(1);
        let bytes = serde_json::to_vec(&diagnostic)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if bytes > MAX_DIAGNOSTIC_HISTORY_BYTES {
            self.diagnostic_history_dropped = self.diagnostic_history_dropped.saturating_add(1);
        } else {
            self.diagnostic_history_bytes += bytes;
            self.diagnostic_history.push_back(DiagnosticRecord {
                value: diagnostic.clone(),
                bytes,
            });
            while self.diagnostic_history.len() > MAX_DIAGNOSTIC_HISTORY_RECORDS
                || self.diagnostic_history_bytes > MAX_DIAGNOSTIC_HISTORY_BYTES
            {
                if let Some(record) = self.diagnostic_history.pop_front() {
                    self.diagnostic_history_bytes -= record.bytes;
                    self.diagnostic_history_dropped =
                        self.diagnostic_history_dropped.saturating_add(1);
                }
            }
        }
        self.diagnostics.push(diagnostic);
        // Keep enough history for a useful refreshed overlay without making
        // `/api/state` grow without bound during a long watch session.
        const MAX_DIAGNOSTICS: usize = 64;
        if self.diagnostics.len() > MAX_DIAGNOSTICS {
            let drain = self.diagnostics.len() - MAX_DIAGNOSTICS;
            self.diagnostics.drain(..drain);
        }
    }

    fn prepare_snapshot_event(&mut self, payload: &Value) -> Result<PreparedSnapshotEvent, String> {
        let id = self.next_event_id;
        let next_event_id = id
            .checked_add(1)
            .ok_or("ERR_RENDER: SSE event sequence exhausted")?;
        let data = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        let wire: Arc<[u8]> = format!("id: {id}\nevent: snapshot\ndata: {data}\n\n")
            .into_bytes()
            .into();
        if wire.len() > MAX_EVENT_BYTES {
            return Err("ERR_RENDER: snapshot event byte budget exceeded".into());
        }
        self.events
            .try_reserve(1)
            .map_err(|_| "ERR_RENDER: snapshot event allocation failed")?;
        Ok(PreparedSnapshotEvent {
            event: WebEvent {
                #[cfg(test)]
                _drop_probe: None,
                id,
                kind: "snapshot".into(),
                wire,
            },
            next_event_id,
        })
    }

    fn publish(&mut self, kind: String, payload: Value) -> u64 {
        self.publish_with_retirement(kind, payload, None)
    }

    fn publish_with_retirement(
        &mut self,
        mut kind: String,
        mut payload: Value,
        mut retired: Option<&mut Vec<WebEvent>>,
    ) -> u64 {
        let id = self.next_event_id;
        self.next_event_id = self.next_event_id.saturating_add(1);
        if kind == "snapshot" {
            if payload.get("pixels").is_some() {
                self.advance_publication_epoch();
                self.snapshot = Some(Arc::new(payload));
                self.frame = None;
                payload = Value::Null;
            }
            payload = if matches!(
                payload.get("url").and_then(Value::as_str),
                Some("/api/frame" | "/api/render-frame")
            ) {
                payload
            } else {
                self.snapshot.as_deref().map_or_else(
                    || json!({"schemaVersion": 1, "url": "/api/snapshot"}),
                    snapshot_notification,
                )
            };
            // Frames are a latest-value stream. Replaying intermediate
            // notifications cannot recover their pixels after replacement.
            if let Some(retired) = retired.as_deref_mut() {
                for event in std::mem::take(&mut self.events) {
                    if event.kind == "snapshot" {
                        retired.push(event);
                    } else {
                        self.events.push_back(event);
                    }
                }
            } else {
                self.events.retain(|event| event.kind != "snapshot");
            }
            self.event_bytes = self.events.iter().map(|event| event.wire.len()).sum();
        }
        let encode = |kind: &str, payload: &Value| -> Arc<[u8]> {
            let data = serde_json::to_string(payload).unwrap_or_else(|_| "{}".into());
            format!("id: {id}\nevent: {kind}\ndata: {data}\n\n")
                .into_bytes()
                .into()
        };
        let mut wire = encode(&kind, &payload);
        if wire.len() > MAX_EVENT_BYTES {
            payload = json!({
                "code": "ERR_DEV_EVENT_TOO_LARGE",
                "message": "SSE event exceeded the development replay byte budget",
                "eventKind": kind,
            });
            kind = "error".into();
            wire = encode(&kind, &payload);
        }
        self.event_bytes += wire.len();
        self.events.push_back(WebEvent {
            #[cfg(test)]
            _drop_probe: None,
            id,
            kind,
            wire,
        });
        while self.events.len() > MAX_EVENTS || self.event_bytes > MAX_EVENT_BYTES {
            if let Some(event) = self.events.pop_front() {
                self.event_bytes -= event.wire.len();
                if let Some(retired) = retired.as_deref_mut() {
                    retired.push(event);
                }
            }
        }
        id
    }
}

fn snapshot_notification(snapshot: &Value) -> Value {
    json!({
        "schemaVersion": 1,
        "frameId": snapshot.get("frame_id").or_else(|| snapshot.get("frameId")),
        "width": snapshot.get("width"),
        "height": snapshot.get("height"),
        "stride": snapshot.get("stride"),
        "format": snapshot.get("format"),
        "url": "/api/snapshot",
    })
}

/// Callback invoked for bridge requests received through the web UI.
pub type BridgeHandler = Box<dyn FnMut(&[u8]) -> Result<Vec<u8>, String> + Send>;

/// A same-thread bridge callback for embedders that keep a thread-affine
/// runtime (for example QuickJS) next to [`WebSurface`]. This variant makes
/// the single-threaded host boundary explicit instead of forcing a
/// non-thread-safe engine behind an unsafe wrapper.
pub type LocalBridgeHandler = Box<dyn FnMut(&[u8]) -> Result<Vec<u8>, String>>;

struct SseClient {
    stream: TcpStream,
    cursor: u64,
    pending: VecDeque<SsePending>,
    binding: Option<Arc<sse_preview::BoundSseConnection>>,
}

impl Drop for SseClient {
    fn drop(&mut self) {
        if let Some(connection) = self.binding.take() {
            connection.retire();
        }
    }
}

struct SsePending {
    id: u64,
    bytes: Arc<[u8]>,
    offset: usize,
}

impl SseClient {
    fn is_connected(&self) -> bool {
        match self.stream.peek(&mut [0]) {
            Ok(0) => false,
            Ok(_) => true,
            Err(error) => error.kind() == ErrorKind::WouldBlock,
        }
    }

    fn queue_events(&mut self, events: &VecDeque<WebEvent>) {
        if self.pending.is_empty() {
            self.pending
                .extend(
                    events
                        .iter()
                        .filter(|event| event.id > self.cursor)
                        .map(|event| SsePending {
                            id: event.id,
                            bytes: Arc::clone(&event.wire),
                            offset: 0,
                        }),
                );
        }
    }
}

struct PendingRequest {
    stream: TcpStream,
    buffer: Vec<u8>,
    accepted_at: Instant,
}

struct PendingResourceRequest {
    stream: TcpStream,
    target: WebResourceTarget,
    accepted_at: Instant,
}

/// Borrower ownership stays on the actual response, outside shared handle
/// queues. Dropping a completed, failed or expired write releases the original
/// artifact charge only when the store's final borrower has gone away.
enum ResponseBody {
    Shared(Arc<Vec<u8>>),
    Control(Arc<Vec<u8>>),
    Runtime(crate::dev::BrowserRuntimeResource),
    Stage(crate::dev::BrowserStageResource),
}

impl ResponseBody {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Shared(bytes) | Self::Control(bytes) => bytes.as_slice(),
            Self::Runtime(body) => body.bytes(),
            Self::Stage(body) => body.bytes(),
        }
    }
}

impl From<WebResourceBody> for ResponseBody {
    fn from(body: WebResourceBody) -> Self {
        match body {
            WebResourceBody::Runtime(body) => Self::Runtime(body),
            WebResourceBody::Stage(body) => Self::Stage(body),
        }
    }
}

struct PendingResponse {
    stream: TcpStream,
    header: Option<Arc<Vec<u8>>>,
    header_offset: usize,
    body: ResponseBody,
    offset: usize,
    queued_at: Instant,
}

/// Non-blocking local HTTP/SSE development server.
pub struct WebSurface {
    listener: TcpListener,
    addr: SocketAddr,
    // Metadata only: never shared strongly outside this exact surface. A Weak
    // identity can outlive its listener without retaining any socket or store.
    instance_identity: Arc<()>,
    shared: Arc<Mutex<Shared>>,
    clients: Vec<SseClient>,
    pending_requests: Vec<PendingRequest>,
    pending_resource_requests: VecDeque<PendingResourceRequest>,
    pending_control_requests: VecDeque<control::PendingControlRequest>,
    pending_responses: Vec<PendingResponse>,
    resource_only: bool,
    control_auth: Option<crate::web_control::ControlHttpAuth>,
    browser_dev_app: Option<dev_app::BrowserDevApp>,
    accepting: bool,
    has_accepted: bool,
    bridge_handler: Option<BridgeHandler>,
    local_bridge_handler: Option<LocalBridgeHandler>,
    readiness: mio::Poll,
    ready_events: mio::Events,
}

impl std::fmt::Debug for WebSurface {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebSurface")
            .field("addr", &self.addr)
            .field("clients", &self.clients.len())
            .finish_non_exhaustive()
    }
}

impl WebSurface {
    /// Load an immutable, allowlisted set of locally prepared CanvasKit bytes.
    /// Hash pins are shared with the standalone WASM builder; arbitrary
    /// runtime-config hashes cannot authorize another script or font.
    pub fn configure_canvaskit_assets(&mut self, root: &Path) -> io::Result<()> {
        let root = root.canonicalize()?;
        let pins: Value = serde_json::from_str(RENDERER_PINS).map_err(io::Error::other)?;
        let pins = pins
            .as_object()
            .ok_or_else(|| io::Error::other("invalid renderer pins"))?;
        let mut assets = BTreeMap::new();
        let mut descriptors = BTreeMap::new();
        let mut total = 0_usize;
        for (key, pin) in pins {
            let relative = pin["url"]
                .as_str()
                .ok_or_else(|| io::Error::other("invalid pinned renderer path"))?;
            let path = root.join(relative);
            let metadata = path.symlink_metadata()?;
            let size = pin["size"]
                .as_u64()
                .ok_or_else(|| io::Error::other("invalid pinned renderer size"))?;
            if !metadata.is_file()
                || metadata.len() != size
                || !path.canonicalize()?.starts_with(&root)
            {
                return Err(io::Error::other(format!(
                    "ERR_RENDER: invalid pinned renderer input {key}"
                )));
            }
            total = total.saturating_add(size as usize);
            if total > MAX_RENDERER_ASSET_BYTES {
                return Err(io::Error::other(
                    "ERR_RENDER: renderer asset budget exceeded",
                ));
            }
            let bytes = std::fs::read(&path)?;
            let hash = format!("{:x}", Sha256::digest(&bytes));
            if Some(hash.as_str()) != pin["sha256"].as_str() {
                return Err(io::Error::other(format!(
                    "ERR_RENDER: pinned renderer integrity mismatch: {key}"
                )));
            }
            let url = format!("/renderer-assets/{relative}");
            let content_type = match key.as_str() {
                "javascript" => "text/javascript; charset=utf-8",
                "wasm" => "application/wasm",
                "font" => "font/ttf",
                "package" => "application/json",
                _ => "text/plain; charset=utf-8",
            };
            assets.insert(
                url.clone(),
                Arc::new(encode_response(200, content_type, &bytes)),
            );
            let mut descriptor = pin.clone();
            descriptor["url"] = json!(url);
            descriptors.insert(key.as_str(), descriptor);
        }
        let expected = json!({"schemaVersion":1,"renderer":"canvaskit","fallback":"error",
            "canvaskit":{"version":"0.42.0","variant":"full","javascript":descriptors["javascript"],
                "wasm":descriptors["wasm"],"license":descriptors["license"],"package":descriptors["package"]},
            "font":{"binary":descriptors["font"],"license":descriptors["fontLicense"]}});
        let config_path = root.join("runtime-config.json");
        if !config_path.symlink_metadata()?.is_file() || config_path.metadata()?.len() > 16 * 1024 {
            return Err(io::Error::other(
                "ERR_RENDER: invalid renderer configuration file",
            ));
        }
        let config: Value =
            serde_json::from_slice(&std::fs::read(config_path)?).map_err(io::Error::other)?;
        if config != expected {
            return Err(io::Error::other(
                "ERR_RENDER: renderer configuration differs from pinned dependencies",
            ));
        }
        assets.insert(
            "/api/renderer-config".into(),
            Arc::new(encode_response(
                200,
                "application/json",
                &serde_json::to_vec(&expected).map_err(io::Error::other)?,
            )),
        );
        self.shared
            .lock()
            .map_err(|_| io::Error::other("Web surface unavailable"))?
            .renderer_assets = assets;
        Ok(())
    }

    /// Bind a local development server. Pass port `0` to let the OS choose a
    /// free port (especially useful for integration tests).
    pub fn bind(host: IpAddr, port: u16) -> io::Result<Self> {
        let listener = TcpListener::bind(SocketAddr::new(host, port))?;
        listener.set_nonblocking(true)?;
        let addr = listener.local_addr()?;
        Ok(Self {
            listener,
            addr,
            instance_identity: Arc::new(()),
            shared: Arc::new(Mutex::new(Shared::default())),
            clients: Vec::new(),
            pending_requests: Vec::new(),
            pending_resource_requests: VecDeque::new(),
            pending_control_requests: VecDeque::new(),
            pending_responses: Vec::new(),
            resource_only: false,
            control_auth: None,
            browser_dev_app: None,
            accepting: true,
            has_accepted: false,
            bridge_handler: None,
            local_bridge_handler: None,
            readiness: mio::Poll::new()?,
            ready_events: mio::Events::with_capacity(MAX_HTTP_CONNECTIONS + 1),
        })
    }

    /// Bind an opt-in immutable resource transport. No simulator UI, bridge,
    /// SSE, control mutation, browser bootstrap or runtime is enabled. Only
    /// canonical runtime/pack/site GETs are queued for the existing owner's
    /// synchronous resolution through [`Self::resolve_resource_requests`].
    /// Drive each event-loop turn as `poll -> resolve_resource_requests -> wait`;
    /// unresolved owner work makes `wait` return immediately.
    pub fn bind_resource_only(host: IpAddr, port: u16) -> io::Result<Self> {
        let mut surface = Self::bind(host, port)?;
        surface.resource_only = true;
        Ok(surface)
    }

    pub fn localhost(port: u16) -> io::Result<Self> {
        Self::bind(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), port)
    }

    /// Resolve queued resource identities on the supervisor's owner lane.
    /// The callback must only match retained identities and borrow captured
    /// memory from the original stores; it must not stage, pack or read files.
    /// No token/body can outlive this surface through a shared handle queue.
    /// Return the number of non-expired requests submitted to the resolver.
    pub fn resolve_resource_requests(
        &mut self,
        mut resolve: impl FnMut(&WebResourceTarget) -> WebResourceResolution,
    ) -> io::Result<usize> {
        let mut resolved = 0;
        while let Some(request) = self.pending_resource_requests.pop_front() {
            if request.accepted_at.elapsed() >= HTTP_DEADLINE {
                continue;
            }
            let resolution = resolve(&request.target);
            resolved += 1;
            // Owner lookup is synchronous, but even an unexpectedly slow
            // callback cannot refresh the request's original deadline.
            if request.accepted_at.elapsed() >= HTTP_DEADLINE {
                drop(resolution);
                continue;
            }
            let result = match resolution {
                WebResourceResolution::Found(body) if request.target.accepts(&body) => self
                    .queue_resource_body(
                        &request.stream,
                        request.target.content_type(),
                        body,
                        request.accepted_at,
                    ),
                WebResourceResolution::Found(body) => {
                    drop(body);
                    self.queue_resource_error(
                        &request.stream,
                        ResourceRequestError::Unavailable,
                        request.accepted_at,
                    )
                }
                WebResourceResolution::Unavailable => self.queue_resource_error(
                    &request.stream,
                    ResourceRequestError::Unavailable,
                    request.accepted_at,
                ),
                WebResourceResolution::NotFound => self.queue_resource_error(
                    &request.stream,
                    ResourceRequestError::NotFound,
                    request.accepted_at,
                ),
                WebResourceResolution::Denied => self.queue_resource_error(
                    &request.stream,
                    ResourceRequestError::Denied,
                    request.accepted_at,
                ),
            };
            match result {
                Err(error) if is_client_disconnect(&error) => {}
                Err(error) => return Err(error),
                Ok(()) => {}
            }
        }
        Ok(resolved)
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.addr
    }

    /// A non-owning identity for this surface's lifetime, unaffected by moves.
    /// Rebinding the same address creates a distinct identity; keeping this
    /// Weak cannot keep the listener, shared queues or resource borrowers alive.
    pub(crate) fn instance_identity(&self) -> Weak<()> {
        Arc::downgrade(&self.instance_identity)
    }

    pub fn url(&self) -> String {
        // `IpAddr::to_string()` omits the brackets required by an IPv6 URL.
        // Keep the printed endpoint usable when callers bind `--host ::1` or
        // another IPv6 address; the default IPv4 URL remains unchanged.
        format!("http://{}/", self.addr)
    }

    pub fn handle(&self) -> WebSurfaceHandle {
        WebSurfaceHandle {
            shared: self.shared.clone(),
        }
    }

    pub fn set_bridge_handler(&mut self, handler: BridgeHandler) {
        self.bridge_handler = Some(handler);
    }

    /// Install a bridge callback that is invoked on the same thread as
    /// [`Self::poll`]. This is intended for thread-affine runtimes and keeps
    /// the callback within the host event loop's ownership boundary.
    pub fn set_local_bridge_handler(&mut self, handler: LocalBridgeHandler) {
        self.local_bridge_handler = Some(handler);
    }

    /// Decide admission at the accepted-stream boundary. Expiration and
    /// response progress belong to the surrounding poll, not this decision.
    fn admit_http_stream(&mut self, stream: TcpStream) -> io::Result<bool> {
        self.has_accepted = true;
        if self.pending_requests.len()
            + self.pending_resource_requests.len()
            + self.pending_control_requests.len()
            + self.pending_responses.len()
            + self.clients.len()
            >= MAX_HTTP_CONNECTIONS
        {
            return Ok(false);
        }
        stream.set_nonblocking(true)?;
        // Whole-frame bodies can end with a short TCP segment, and SSE sends
        // small notices. Cloned response/SSE sockets inherit this setting.
        stream.set_nodelay(true)?;
        self.pending_requests.push(PendingRequest {
            stream,
            buffer: Vec::with_capacity(if self.control_auth.is_some() {
                control::MAX_CONTROL_WIRE_BYTES
            } else {
                4096
            }),
            accepted_at: Instant::now(),
        });
        Ok(true)
    }

    /// Process all currently readable connections and flush SSE events.
    /// Call this from the supervisor loop; it never blocks on network I/O.
    pub fn poll(&mut self) -> io::Result<usize> {
        let mut processed = 0;
        self.pending_resource_requests
            .retain(|request| request.accepted_at.elapsed() < HTTP_DEADLINE);
        self.pending_control_requests
            .retain(|request| request.accepted_at.elapsed() < HTTP_DEADLINE);
        // Bound admission work even if another process continuously connects.
        for _ in 0..MAX_HTTP_CONNECTIONS {
            if !self.accepting {
                break;
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if self.admit_http_stream(stream)? {
                        processed += 1;
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::Interrupted
                            | ErrorKind::ConnectionAborted
                            | ErrorKind::ConnectionReset
                    ) =>
                {
                    continue;
                }
                Err(error) => return Err(error),
            }
        }
        self.process_pending_requests()?;
        self.flush_responses();
        self.flush_events();
        Ok(processed)
    }

    /// Sleep until socket readiness or the next runtime deadline. Each socket
    /// gets a bounded write turn in `poll`; a writable large response wakes the
    /// next turn immediately instead of paying a fixed frame interval per chunk.
    pub fn wait(&mut self, timeout: Duration) -> io::Result<()> {
        // These sockets await synchronous owner work, not a writable event.
        // Let the caller resolve/expire them before waiting for network I/O.
        if !self.pending_resource_requests.is_empty()
            || !self.pending_control_requests.is_empty()
            || self.shared.lock().is_ok_and(|shared| {
                shared.preview.sse_binding_enabled && !shared.preview.requests.is_empty()
            })
        {
            return Ok(());
        }
        use mio::{Interest, Token};
        let mut listener = mio::net::TcpListener::from_std(self.listener.try_clone()?);
        if self.accepting {
            self.readiness
                .registry()
                .register(&mut listener, Token(0), Interest::READABLE)?;
        }
        let mut sources = Vec::new();
        let streams = self
            .pending_requests
            .iter()
            .map(|request| (&request.stream, Interest::READABLE))
            .chain(
                self.pending_responses
                    .iter()
                    .map(|response| (&response.stream, Interest::WRITABLE)),
            )
            .chain(self.clients.iter().map(|client| {
                (
                    &client.stream,
                    if client.pending.is_empty() {
                        Interest::READABLE
                    } else {
                        Interest::READABLE | Interest::WRITABLE
                    },
                )
            }));
        for (index, (stream, interest)) in streams.enumerate() {
            let mut source = mio::net::TcpStream::from_std(stream.try_clone()?);
            self.readiness
                .registry()
                .register(&mut source, Token(index + 1), interest)?;
            sources.push(source);
        }
        let result = self.readiness.poll(&mut self.ready_events, Some(timeout));
        // Explicit deregistration is necessary on readiness systems that
        // associate registrations with an open file description (dup sockets).
        if self.accepting {
            let _ = self.readiness.registry().deregister(&mut listener);
        }
        for source in &mut sources {
            let _ = self.readiness.registry().deregister(source);
        }
        match result {
            Err(error) if error.kind() == ErrorKind::Interrupted => Ok(()),
            result => result,
        }
    }

    fn process_pending_requests(&mut self) -> io::Result<()> {
        // An accepted nonblocking socket may not have received the request
        // bytes yet. Keep it across polls instead of dropping it on the first
        // WouldBlock; dropping here races with clients under load and causes
        // intermittent ECONNRESET responses (especially for SSE).
        let pending = std::mem::take(&mut self.pending_requests);
        for request in pending {
            match self.process_request(request) {
                Ok(Some(request)) => self.pending_requests.push(request),
                Ok(None) => {}
                // A browser may cancel a snapshot fetch or close its tab
                // after receiving only part of a response. All HTTP routes
                // share this connection boundary: losing that socket must
                // not stop the development supervisor or another client.
                Err(error) if is_client_disconnect(&error) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn process_request(
        &mut self,
        mut request: PendingRequest,
    ) -> io::Result<Option<PendingRequest>> {
        if request.accepted_at.elapsed() >= HTTP_DEADLINE {
            return Ok(None);
        }
        let mut complete = None;
        let mut closed = false;
        let mut too_large = false;
        let mut chunk = [0_u8; 8192];
        let request_limit = if self.resource_only {
            if self.control_auth.is_some() {
                control::MAX_CONTROL_WIRE_BYTES
            } else {
                resources::MAX_RESOURCE_HEADER_BYTES
            }
        } else {
            MAX_REQUEST_BYTES
        };
        loop {
            match request.stream.read(&mut chunk) {
                Ok(0) => {
                    closed = true;
                    break;
                }
                Ok(read) => {
                    if request.buffer.len().saturating_add(read) > request_limit {
                        too_large = true;
                        break;
                    }
                    request.buffer.extend_from_slice(&chunk[..read]);
                    // Reserve the control namespace before all legacy framing,
                    // OPTIONS and wildcard-CORS handling, even when disabled.
                    if control::is_control_namespace(&request.buffer)
                        && !(self.browser_dev_app.is_some()
                            && dev_app::is_dev_namespace(&request.buffer))
                    {
                        return self.process_control_request(request);
                    }
                    if self.resource_only
                        && request.buffer.len() >= resources::MAX_RESOURCE_HEADER_BYTES
                        && find_bytes(&request.buffer, b"\r\n\r\n").is_none()
                    {
                        too_large = true;
                        break;
                    }
                    if let Some(header_end) = find_bytes(&request.buffer, b"\r\n\r\n") {
                        let header_len = header_end + 4;
                        if self.resource_only {
                            // Strict GET framing is checked against the raw
                            // header and every already-received trailing byte.
                            // Never consult the legacy Content-Length parser.
                            complete = Some((header_end, 0));
                            break;
                        }
                        let content_length = parse_content_length(&request.buffer[..header_end]);
                        if content_length > MAX_REQUEST_BYTES
                            || header_len.saturating_add(content_length) > MAX_REQUEST_BYTES
                        {
                            too_large = true;
                            break;
                        }
                        if request.buffer.len() >= header_len + content_length {
                            complete = Some((header_end, content_length));
                            break;
                        }
                    }
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            }
        }

        if too_large {
            if self.resource_only {
                self.queue_resource_error(
                    &request.stream,
                    ResourceRequestError::TooLarge,
                    request.accepted_at,
                )?;
            } else {
                self.queue_response(
                    &request.stream,
                    413,
                    "application/json",
                    br#"{"error":"request too large"}"#,
                )?;
            }
        } else if let Some((header_end, content_length)) = complete {
            if self.resource_only {
                let headers = &request.buffer[..header_end];
                let trailing = request.buffer.len() - header_end - 4;
                let target = if let Some(app) = &self.browser_dev_app {
                    match resources::parse_get_request(headers, trailing) {
                        Ok(get)
                            if self
                                .control_auth
                                .as_ref()
                                .is_some_and(|auth| auth.matches_dev_app_host(get.host)) =>
                        {
                            if let Some(bytes) = app.response(get.target) {
                                self.queue_shared_response_bytes_at(
                                    &request.stream,
                                    bytes,
                                    request.accepted_at,
                                )?;
                                return Ok(None);
                            }
                            resources::parse_target(get.target)
                        }
                        Ok(_) => Err(ResourceRequestError::Denied),
                        Err(error) => Err(error),
                    }
                } else {
                    resources::parse_request(headers, trailing)
                };
                match target {
                    Ok(target) => {
                        self.pending_resource_requests
                            .push_back(PendingResourceRequest {
                                stream: request.stream,
                                target,
                                accepted_at: request.accepted_at,
                            });
                    }
                    Err(error) => {
                        self.queue_resource_error(&request.stream, error, request.accepted_at)?
                    }
                }
                return Ok(None);
            }
            let header = request.buffer[..header_end].to_vec();
            let body_start = header_end + 4;
            let body = request.buffer[body_start..body_start + content_length].to_vec();
            self.route_request(&mut request.stream, &header, &body)?;
        } else if !closed {
            return Ok(Some(request));
        }
        Ok(None)
    }

    fn route_request(
        &mut self,
        stream: &mut TcpStream,
        headers: &[u8],
        body: &[u8],
    ) -> io::Result<()> {
        let request_line = headers
            .split(|byte| *byte == b'\n')
            .next()
            .and_then(|line| std::str::from_utf8(line).ok())
            .unwrap_or("")
            .trim();
        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("");
        let target = parts.next().unwrap_or("/");
        let (path, query) = target.split_once('?').unwrap_or((target, ""));
        if method == "OPTIONS" {
            self.queue_options_response(stream)?;
            return Ok(());
        }
        let strict_raster = self
            .shared
            .lock()
            .map_err(|_| io::Error::other("Web surface unavailable"))?
            .strict_raster;
        if strict_raster
            && ((method == "POST" && matches!(path, "/api/presentation" | "/api/render-presented"))
                || (method == "GET" && path == "/api/render-frame"))
        {
            self.queue_response(stream,409,"application/json",
                br#"{"ok":false,"error":{"code":"ERR_UNSUPPORTED_CAPABILITY","message":"operation is unavailable in ticketed-raster-v1"}}"#)?;
            return Ok(());
        }
        if method == "GET" && path == "/" {
            let ui = if strict_raster {
                DEV_RASTER_UI_HTML
            } else {
                UI_HTML
            };
            self.queue_response(stream, 200, "text/html; charset=utf-8", ui.as_bytes())?;
        } else if method == "GET" && browser_renderer_module(path).is_some() {
            self.queue_response(
                stream,
                200,
                "text/javascript; charset=utf-8",
                browser_renderer_module(path).expect("matched browser module"),
            )?;
        } else if method == "GET" && path.starts_with("/api/view-resources/") {
            let resource = path
                .strip_prefix("/api/view-resources/")
                .filter(|hash| container_ir::is_sha256(hash))
                .and_then(|hash| {
                    let encoded = query_parameter(query, "key")?;
                    let key = serde_json::from_str::<container_ir::PresentationKey>(
                        &dom::decode_query(encoded)?,
                    )
                    .ok()?;
                    self.shared.lock().ok()?.dom.resource(&key, hash)
                });
            if let Some((mime, bytes)) = resource {
                self.queue_shared_body(stream, 200, &mime, bytes)?;
            } else {
                self.queue_response(stream, 403, "application/json",
                    br#"{"ok":false,"error":{"code":"ERR_PERMISSION_DENIED","message":"resource does not belong to a current browser presentation"}}"#)?;
            }
        } else if method == "GET"
            && (path.starts_with("/renderer-assets/") || path == "/api/renderer-config")
        {
            let bytes = self
                .shared
                .lock()
                .ok()
                .and_then(|shared| shared.renderer_assets.get(path).cloned());
            if let Some(bytes) = bytes {
                self.queue_shared_response_bytes(stream, bytes)?;
            } else {
                self.queue_response(
                    stream,
                    404,
                    "application/json",
                    br#"{"error":"ERR_RENDER: pinned renderer assets are not configured"}"#,
                )?;
            }
        } else if method == "GET"
            && (path == "/api/render-frame" || path.starts_with("/api/render-resources/"))
        {
            let bytes = self.shared.lock().ok().and_then(|shared| {
                if shared.dom.enabled {
                    return None;
                }
                shared.render_frame.as_ref().and_then(|frame| {
                    if path == "/api/render-frame" {
                        Some(Arc::clone(&frame.response))
                    } else {
                        frame.resources.get(path).cloned()
                    }
                })
            });
            if let Some(bytes) = bytes {
                self.queue_shared_response_bytes(stream, bytes)?;
            } else {
                self.queue_response(
                    stream,
                    404,
                    "application/json",
                    br#"{"error":"render frame or current-generation resource unavailable"}"#,
                )?;
            }
        } else if method == "POST" && path == "/api/render-presented" {
            let value = serde_json::from_slice::<Value>(body).unwrap_or(Value::Null);
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            let valid = !shared.dom.enabled && shared.matches_render_receipt(&value);
            let (status, receipt) = if !valid {
                (
                    409,
                    json!({"ok":false,"error":"ERR_RENDER: stale or invalid presentation receipt"}),
                )
            } else if shared.render_presented.len() >= MAX_PRESENTATION_REQUESTS {
                (
                    503,
                    json!({"ok":false,"error":"ERR_RENDER: presentation receipt queue full"}),
                )
            } else {
                shared.render_presented.push_back(value);
                (202, json!({"queued":true}))
            };
            drop(shared);
            self.queue_response(
                stream,
                status,
                "application/json",
                &serde_json::to_vec(&receipt).map_err(io::Error::other)?,
            )?;
        } else if method == "GET" && matches!(path, "/embed" | "/embed/" | "/embed/index.html") {
            // Keep the embedding page on the same origin as the simulator so
            // it can consume the session and SSE stream without a separate
            // static server or a CORS configuration. The source lives under
            // examples/hosts/web and is compiled into the development binary;
            // production Web hosts should use WebWasmHost directly.
            self.queue_response(
                stream,
                200,
                "text/html; charset=utf-8",
                WEB_EMBED_HTML.as_bytes(),
            )?;
        } else if method == "GET" && path == "/surface-input.mjs" {
            self.queue_response(
                stream,
                200,
                "text/javascript; charset=utf-8",
                include_bytes!("../../../examples/hosts/web-wasm/surface-input.mjs"),
            )?;
        } else if method == "GET" && path == "/api/state" {
            let state = self
                .shared
                .lock()
                .map(|shared| shared.state_value())
                .unwrap_or_else(|_| json!({"schemaVersion": 1, "status": "unavailable"}));
            let bytes = serde_json::to_vec(&state).unwrap_or_else(|_| b"{}".to_vec());
            self.queue_response(stream, 200, "application/json", &bytes)?;
        } else if method == "GET" && path == "/api/presentation" {
            let value = self.handle().presentation();
            let bytes = serde_json::to_vec(&value).unwrap_or_else(|_| b"{}".to_vec());
            self.queue_response(stream, 200, "application/json", &bytes)?;
        } else if method == "GET" && path == "/api/preview" {
            let value = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?
                .preview
                .preview_value();
            self.queue_response(
                stream,
                200,
                "application/json",
                &serde_json::to_vec(&value).map_err(io::Error::other)?,
            )?;
        } else if method == "POST" && path == "/api/preview" {
            let bound = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?
                .preview
                .sse_binding_enabled;
            if bound {
                let result = self
                    .shared
                    .lock()
                    .map_err(|_| io::Error::other("Web surface unavailable"))?
                    .queue_bound_preview(body);
                let (status, value) = match result {
                    Ok(receipt) => (202, receipt),
                    Err(message) => (
                        409,
                        json!({"ok":false,"error":{"code":"ERR_CANCELLED","message":message}}),
                    ),
                };
                self.queue_response(
                    stream,
                    status,
                    "application/json",
                    &serde_json::to_vec(&value).map_err(io::Error::other)?,
                )?;
                return Ok(());
            }
            let parsed = serde_json::from_slice::<PreviewRequest>(body);
            let (status, value) = match parsed {
                Ok(request) => {
                    let receipt = json!({"queued":true,"requestId":request.request_id});
                    let result = self
                        .shared
                        .lock()
                        .map_err(|_| io::Error::other("Web surface unavailable"))?
                        .queue_preview(request);
                    match result {
                        Ok(()) => (202, receipt),
                        Err(message) => (
                            409,
                            json!({"ok":false,"error":{"code":"ERR_CANCELLED","message":message}}),
                        ),
                    }
                }
                Err(error) => (
                    400,
                    json!({"ok":false,"error":{"code":"ERR_PROTOCOL_VERSION","message":error.to_string()}}),
                ),
            };
            self.queue_response(
                stream,
                status,
                "application/json",
                &serde_json::to_vec(&value).map_err(io::Error::other)?,
            )?;
        } else if method == "POST" && path == "/api/presentation" {
            let parsed = serde_json::from_slice::<Value>(body);
            if let Ok(value) = &parsed {
                if let Err(message) = self.handle().validate_presentation_owner(value) {
                    self.queue_response(
                        stream,
                        409,
                        "application/json",
                        &serde_json::to_vec(
                            &json!({"ok":false,"error":{"code":"ERR_CANCELLED","message":message}}),
                        )
                        .map_err(io::Error::other)?,
                    )?;
                    return Ok(());
                }
            }
            let (status, response) = match parsed {
                Ok(value) if value.is_object() => {
                    let mut shared = self
                        .shared
                        .lock()
                        .map_err(|_| io::Error::other("presentation unavailable"))?;
                    let revision = shared
                        .presentation
                        .get("revision")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if value.get("revision").and_then(Value::as_u64) != Some(revision) {
                        (
                            409,
                            json!({"ok":false,"error":{"code":"ERR_PRESENTATION_REVISION","message":"stale presentation revision"},"presentation":shared.presentation}),
                        )
                    } else if shared.presentation_requests.len() >= MAX_PRESENTATION_REQUESTS {
                        (
                            503,
                            json!({"ok":false,"error":{"code":"ERR_PRESENTATION_BUSY","message":"presentation queue full"}}),
                        )
                    } else {
                        let receipt = json!({"queued":true,"requestId":value.get("requestId"),"revision":revision});
                        shared.presentation_requests.push_back(value);
                        (202, receipt)
                    }
                }
                _ => (
                    400,
                    json!({"ok":false,"error":{"code":"ERR_PRESENTATION_CONFIG","message":"expected JSON object"}}),
                ),
            };
            let bytes = serde_json::to_vec(&response).unwrap_or_default();
            self.queue_response(stream, status, "application/json", &bytes)?;
        } else if method == "GET" && path == "/api/frame" {
            let bytes = self.shared.lock().ok().and_then(|shared| {
                if shared.dom.enabled {
                    return None;
                }
                shared
                    .frame
                    .as_ref()
                    .map(|frame| Arc::clone(&frame.response))
            });
            if let Some(bytes) = bytes {
                self.queue_shared_response_bytes(stream, bytes)?;
            } else {
                self.queue_response(stream, 404, "application/json", br#"{"error":"no frame"}"#)?;
            }
        } else if method == "GET" && path == "/api/snapshot" {
            if self.shared.lock().is_ok_and(|shared| shared.dom.enabled) {
                self.queue_response(stream, 409, "application/json", br#"{"ok":false,"error":{"code":"ERR_UNSUPPORTED_CAPABILITY","message":"DOM pixels belong to the browser; capture the browser preview. This endpoint does not rasterize a CPU substitute."}}"#)?;
                return Ok(());
            }
            if self.shared.lock().is_ok_and(|shared| {
                shared.render_frame.is_some() || !shared.renderer_assets.is_empty()
            }) {
                self.queue_response(stream, 409, "application/json", br#"{"ok":false,"error":{"code":"ERR_UNSUPPORTED_CAPABILITY","message":"CanvasKit pixels belong to the browser; capture the browser canvas or explicitly request browser snapshotEvidence for diagnostics. This endpoint does not rasterize a CPU substitute."}}"#)?;
                return Ok(());
            }
            let snapshot = self
                .shared
                .lock()
                .ok()
                .map(|shared| {
                    if let Some(frame) = &shared.frame {
                        let retained = shared
                            .retained_response_bytes
                            .iter()
                            .filter(|entry| entry.bytes.strong_count() > 0)
                            .map(|entry| entry.length)
                            .sum::<usize>();
                        bounded_snapshot_json(
                            &frame.snapshot,
                            retained.saturating_add(shared.live_frame_claim_bytes(None)),
                        )
                        .map(Some)
                    } else {
                        Ok(shared
                            .snapshot
                            .as_deref()
                            .and_then(|snapshot| serde_json::to_vec(snapshot).ok()))
                    }
                })
                .unwrap_or(Ok(None));
            match snapshot {
                Ok(Some(bytes)) => {
                    self.queue_response(stream, 200, "application/json", &bytes)?;
                }
                Err(()) => self.queue_response(stream,503,"application/json",br#"{"error":"legacy snapshot JSON exceeds frame cache budget; use /api/frame"}"#)?,
                Ok(None) => self.queue_response(
                    stream,
                    404,
                    "application/json",
                    br#"{"error":"no snapshot"}"#,
                )?,
            }
        } else if method == "GET" && path == "/api/events" {
            // EventSource reconnects include Last-Event-ID.  Supporting the
            // header here makes reload/diagnostic delivery reliable across a
            // browser refresh or a short-lived network interruption while
            // keeping a fresh connection from replaying an old event backlog.
            let header_cursor = header_value(headers, "last-event-id")
                .and_then(|value| value.trim().parse::<u64>().ok());
            let query_cursor =
                query_parameter(query, "since").and_then(|value| value.parse::<u64>().ok());
            self.start_sse_for_client(
                stream,
                header_cursor.or(query_cursor),
                query_parameter(query, "clientId"),
            )?;
            return Ok(());
        } else if method == "POST" && path == "/api/bridge" {
            if self.shared.lock().is_ok_and(|shared| shared.strict_raster) {
                self.queue_strict_raster_bridge(stream, body)?;
                return Ok(());
            }
            let queued = match QueuedBridgeRequest::parse(body) {
                Ok(request) => request,
                Err(message) => {
                    self.queue_response(stream,400,"application/json",&serde_json::to_vec(&json!({"ok":false,"error":{"code":"ERR_PROTOCOL_VERSION","message":message}})).map_err(io::Error::other)?)?;
                    return Ok(());
                }
            };
            if let Err(message) = self.handle().validate_preview_request(&queued) {
                self.queue_response(
                    stream,
                    409,
                    "application/json",
                    &serde_json::to_vec(
                        &json!({"ok":false,"error":{"code":"ERR_CANCELLED","message":message}}),
                    )
                    .map_err(io::Error::other)?,
                )?;
                return Ok(());
            }
            let current = self
                .shared
                .lock()
                .is_ok_and(|shared| shared.render_input_is_current(body));
            if !current {
                self.queue_response(stream, 409, "application/json",
                    br#"{"ok":false,"error":{"code":"ERR_CANCELLED","message":"input requires the current confirmed render presentation"}}"#)?;
                return Ok(());
            }
            let result = if let Some(handler) = self.local_bridge_handler.as_mut() {
                handler(body)
            } else if let Some(handler) = self.bridge_handler.as_mut() {
                handler(body)
            } else {
                let admitted = if let Ok(mut shared) = self.shared.lock() {
                    let retained: usize = shared
                        .bridge_requests
                        .iter()
                        .map(|entry| entry.request.body.len())
                        .sum();
                    if shared.bridge_requests.len() >= MAX_BRIDGE_REQUESTS
                        || retained.saturating_add(body.len()) > MAX_BRIDGE_QUEUE_BYTES
                    {
                        false
                    } else {
                        shared.bridge_requests.push_back(QueuedWebBridgeRequest {
                            request: queued,
                            strict: None,
                        });
                        shared.publish("bridge".into(), json!({"queued": true}));
                        true
                    }
                } else {
                    false
                };
                if !admitted {
                    self.queue_response(stream,503,"application/json",br#"{"ok":false,"error":{"code":"ERR_RENDER","message":"bridge queue budget exceeded"}}"#)?;
                    return Ok(());
                }
                Ok(br#"{"queued":true}"#.to_vec())
            };
            match result {
                Ok(bytes) => {
                    // A caller-provided handler is used by embedders that
                    // drive the simulator from their own loop. Mirror the
                    // queued bridge path by publishing its result to SSE as
                    // well, so a second surface (or an inspector tab) sees
                    // the same response even when the POST client is not the
                    // only observer. The handler contract returns JSON in
                    // normal use; retain a readable raw payload if an
                    // embedding adapter returns another byte representation.
                    if self.bridge_handler.is_some() || self.local_bridge_handler.is_some() {
                        let payload =
                            serde_json::from_slice::<Value>(&bytes).unwrap_or_else(|_| {
                                json!({
                                    "raw": String::from_utf8_lossy(&bytes).into_owned()
                                })
                            });
                        if let Ok(mut shared) = self.shared.lock() {
                            shared.publish("bridge".into(), payload);
                        }
                    }
                    self.queue_response(stream, 200, "application/json", &bytes)?
                }
                Err(error) => {
                    let payload = serde_json::to_vec(&json!({"ok": false, "error": error}))
                        .unwrap_or_else(|_| br#"{"ok":false}"#.to_vec());
                    if self.bridge_handler.is_some() || self.local_bridge_handler.is_some() {
                        if let Ok(mut shared) = self.shared.lock() {
                            shared.publish(
                                "bridge".into(),
                                serde_json::from_slice(&payload)
                                    .unwrap_or_else(|_| json!({"ok": false})),
                            );
                        }
                    }
                    self.queue_response(stream, 500, "application/json", &payload)?;
                }
            }
        } else {
            self.queue_response(stream, 404, "application/json", br#"{"error":"not found"}"#)?;
        }
        Ok(())
    }

    fn queue_response(
        &mut self,
        stream: &TcpStream,
        status: u16,
        content_type: &str,
        body: &[u8],
    ) -> io::Result<()> {
        let retained = self
            .shared
            .lock()
            .map(|mut shared| {
                shared
                    .retained_response_bytes
                    .retain(|entry| entry.bytes.strong_count() > 0);
                shared
                    .retained_response_bytes
                    .iter()
                    .map(|entry| entry.length)
                    .sum::<usize>()
                    + shared
                        .frame
                        .as_ref()
                        .map_or(0, |frame| frame.snapshot.pixels.capacity())
                    + shared.live_frame_claim_bytes(None)
            })
            .unwrap_or(MAX_RESPONSE_BYTES);
        let bytes = if body.len().saturating_add(retained).saturating_add(512) > MAX_RESPONSE_BYTES
        {
            // The small rejection response is bounded by the connection cap,
            // even when all available snapshot byte capacity is occupied.
            encode_response(
                503,
                "application/json",
                br#"{"error":"development response byte budget exceeded"}"#,
            )
        } else {
            encode_response(status, content_type, body)
        };
        if retained.saturating_add(bytes.len()) > MAX_RESPONSE_BYTES {
            // If even the small rejection cannot fit, close this connection
            // at the caller's request boundary without growing the queue.
            return Ok(());
        }
        self.queue_response_bytes(stream, bytes)
    }

    fn queue_options_response(&mut self, stream: &TcpStream) -> io::Result<()> {
        self.queue_response_bytes(
            stream,
            b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type, Last-Event-ID\r\nConnection: close\r\n\r\n".to_vec(),
        )
    }

    fn queue_response_bytes(&mut self, stream: &TcpStream, bytes: Vec<u8>) -> io::Result<()> {
        self.queue_shared_response_bytes(stream, Arc::new(bytes))
    }

    /// Keep encoded application bytes shared with the accepted/pending view.
    /// Only the small HTTP header is new; in-flight resources stay charged to
    /// the same weak ledger even after their presentation is retired.
    fn queue_shared_body(
        &mut self,
        stream: &TcpStream,
        status: u16,
        mime: &str,
        bytes: Arc<Vec<u8>>,
    ) -> io::Result<()> {
        let header = Arc::new(encode_response_header(status, mime, bytes.len()));
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            let weak = Arc::downgrade(&bytes);
            let extra = if shared
                .retained_response_bytes
                .iter()
                .any(|entry| entry.bytes.ptr_eq(&weak))
            {
                0
            } else {
                bytes.capacity()
            };
            if shared
                .ensure_frame_capacity(extra, 0, header.capacity())
                .is_err()
            {
                drop(shared);
                return self.queue_response(
                    stream,
                    503,
                    "application/json",
                    br#"{"error":"development response byte budget exceeded"}"#,
                );
            }
            shared.track_response(&header);
            shared.track_response(&bytes);
        }
        let stream = stream.try_clone()?;
        stream.set_nonblocking(true)?;
        self.pending_responses.push(PendingResponse {
            stream,
            header: Some(header),
            header_offset: 0,
            body: ResponseBody::Shared(bytes),
            offset: 0,
            queued_at: Instant::now(),
        });
        Ok(())
    }

    fn queue_resource_body(
        &mut self,
        stream: &TcpStream,
        mime: &'static str,
        body: WebResourceBody,
        accepted_at: Instant,
    ) -> io::Result<()> {
        let header = Arc::new(resources::response_header(200, mime, body.bytes().len()));
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            // Payload stays on its ORIGINAL artifact charge. Only this small
            // header joins the existing ordinary HTTP response accounting.
            if shared
                .ensure_frame_capacity(0, 0, header.capacity())
                .is_err()
            {
                drop(shared);
                drop(body);
                return self.queue_resource_error(
                    stream,
                    ResourceRequestError::Unavailable,
                    accepted_at,
                );
            }
            shared.track_response(&header);
        }
        let stream = stream.try_clone()?;
        stream.set_nonblocking(true)?;
        self.pending_responses.push(PendingResponse {
            stream,
            header: Some(header),
            header_offset: 0,
            body: body.into(),
            offset: 0,
            queued_at: accepted_at,
        });
        Ok(())
    }

    fn queue_resource_error(
        &mut self,
        stream: &TcpStream,
        error: ResourceRequestError,
        accepted_at: Instant,
    ) -> io::Result<()> {
        let body = error.body();
        let mut bytes = resources::response_header(error.status(), "application/json", body.len());
        bytes.extend_from_slice(body);
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            if shared.ensure_frame_capacity(0, 0, bytes.len()).is_err() {
                // Even a bounded rejection cannot fit: close the connection.
                return Ok(());
            }
        }
        self.queue_shared_response_bytes_at(stream, Arc::new(bytes), accepted_at)
    }

    fn queue_shared_response_bytes(
        &mut self,
        stream: &TcpStream,
        bytes: Arc<Vec<u8>>,
    ) -> io::Result<()> {
        self.queue_shared_response_bytes_at(stream, bytes, Instant::now())
    }

    fn queue_shared_response_bytes_at(
        &mut self,
        stream: &TcpStream,
        bytes: Arc<Vec<u8>>,
        queued_at: Instant,
    ) -> io::Result<()> {
        let stream = stream.try_clone()?;
        stream.set_nonblocking(true)?;
        {
            let mut shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            shared
                .retained_response_bytes
                .retain(|entry| entry.bytes.strong_count() > 0);
            let weak = Arc::downgrade(&bytes);
            if !shared
                .retained_response_bytes
                .iter()
                .any(|entry| entry.bytes.ptr_eq(&weak))
            {
                if shared
                    .ensure_frame_capacity(bytes.capacity(), 0, 0)
                    .is_err()
                {
                    // Revalidate after encoding: another publisher may have
                    // reserved capacity since the ordinary response preflight.
                    return Ok(());
                }
                shared
                    .retained_response_bytes
                    .try_reserve(1)
                    .map_err(|_| io::Error::other("Web response ledger allocation failed"))?;
                shared.retained_response_bytes.push(RetainedResponseBytes {
                    bytes: weak,
                    length: bytes.capacity(),
                });
            }
        }

        self.pending_responses.push(PendingResponse {
            stream,
            header: None,
            header_offset: 0,
            body: ResponseBody::Shared(bytes),
            offset: 0,
            queued_at,
        });
        Ok(())
    }

    fn flush_responses(&mut self) {
        // A per-client byte budget is a fairness quantum, not a reason to
        // revisit the entire runtime before writing the next chunk. Drain
        // multiple round-robin turns while sockets make progress, bounded by
        // a short wall-clock slice so timers, SSE and shutdown remain live.
        let deadline = Instant::now() + RESPONSE_DRAIN_TIME;
        let mut pending: VecDeque<_> = std::mem::take(&mut self.pending_responses).into();
        let mut remaining_in_round = pending.len();
        let mut round_progress = false;
        while !pending.is_empty() && Instant::now() < deadline {
            let mut response = pending.pop_front().expect("nonempty response queue");
            let mut retain = response.queued_at.elapsed() < HTTP_DEADLINE;
            let mut budget = RESPONSE_WRITE_BUDGET;
            while retain
                && (response
                    .header
                    .as_ref()
                    .is_some_and(|header| response.header_offset < header.len())
                    || response.offset < response.body.bytes().len())
                && budget > 0
                && Instant::now() < deadline
            {
                let writing_header = response
                    .header
                    .as_ref()
                    .is_some_and(|header| response.header_offset < header.len());
                let (bytes, offset) = if writing_header {
                    (
                        response.header.as_ref().expect("pending header").as_slice(),
                        response.header_offset,
                    )
                } else {
                    (response.body.bytes(), response.offset)
                };
                let end = bytes.len().min(offset + budget);
                match response.stream.write(&bytes[offset..end]) {
                    Ok(0) => {
                        retain = false;
                    }
                    Ok(written) => {
                        if writing_header {
                            response.header_offset += written;
                        } else {
                            response.offset += written;
                        }
                        budget -= written;
                        round_progress = true;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            ErrorKind::WouldBlock | ErrorKind::Interrupted
                        ) =>
                    {
                        break
                    }
                    Err(_) => {
                        retain = false;
                    }
                }
            }
            if retain
                && (response.offset < response.body.bytes().len()
                    || response
                        .header
                        .as_ref()
                        .is_some_and(|header| response.header_offset < header.len()))
            {
                pending.push_back(response);
            }
            remaining_in_round -= 1;
            if remaining_in_round == 0 {
                if !round_progress {
                    break;
                }
                remaining_in_round = pending.len();
                round_progress = false;
            }
        }
        // Preserve round-robin order across time slices, including a slice
        // that ends midway through a round. Slow readers are tried once per
        // round and cannot occupy the loop by repeatedly returning WouldBlock.
        self.pending_responses = pending.into();
    }

    #[cfg(test)]
    fn start_sse(
        &mut self,
        stream: &mut TcpStream,
        requested_cursor: Option<u64>,
    ) -> io::Result<()> {
        self.start_sse_for_client(stream, requested_cursor, None)
    }

    fn start_sse_for_client(
        &mut self,
        stream: &mut TcpStream,
        requested_cursor: Option<u64>,
        client_id: Option<&str>,
    ) -> io::Result<()> {
        self.clients.retain(SseClient::is_connected);
        if self.clients.len() >= MAX_SSE_CLIENTS {
            return self.queue_response(
                stream,
                503,
                "application/json",
                br#"{"error":"too many event stream clients"}"#,
            );
        }
        let latest = self
            .shared
            .lock()
            .map(|shared| shared.next_event_id.saturating_sub(1))
            .unwrap_or(0);
        // With no replay request, begin at the current tail.  A reconnecting
        // client can opt into retained events with Last-Event-ID or `since`.
        let cursor = requested_cursor.unwrap_or(latest);
        let client_stream = stream.try_clone()?;
        client_stream.set_nonblocking(true)?;
        self.clients.try_reserve(1).map_err(io::Error::other)?;
        let (bound, strict) = {
            let shared = self
                .shared
                .lock()
                .map_err(|_| io::Error::other("Web surface unavailable"))?;
            (shared.preview.sse_binding_enabled, shared.strict_raster)
        };
        let binding = if bound {
            let Some(client_id) = client_id else {
                if strict {
                    return self.queue_response(stream,400,"application/json",
                    br#"{"ok":false,"error":{"code":"ERR_PROTOCOL_VERSION","message":"strict Raster SSE requires clientId"}}"#);
                }
                return self.queue_response(
                    stream,
                    400,
                    "application/json",
                    br#"{"error":"bound SSE requires clientId"}"#,
                );
            };
            match self.reserve_sse_connection(client_id) {
                Ok(binding) => Some(binding),
                Err(message) if strict => {
                    let code = strict_raster::error_code(&message);
                    let status = if code == "ERR_PROTOCOL_VERSION" {
                        400
                    } else {
                        503
                    };
                    return self.queue_response(
                        stream,
                        status,
                        "application/json",
                        &serde_json::to_vec(
                            &json!({"ok":false,"error":{"code":code,"message":message}}),
                        )
                        .map_err(io::Error::other)?,
                    );
                }
                Err(message) => {
                    return self.queue_response(
                        stream,
                        503,
                        "application/json",
                        &serde_json::to_vec(&json!({"error":message})).map_err(io::Error::other)?,
                    )
                }
            }
        } else {
            None
        };
        let mut pending = VecDeque::from([SsePending {
            id: cursor,
            bytes: Arc::from(&b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\nAccess-Control-Allow-Origin: *\r\n\r\n"[..]),
            offset:0,
        }]);
        if let Some(binding) = &binding {
            pending.push_back(SsePending {
                id: cursor,
                bytes: Arc::from(binding.init_wire()),
                offset: 0,
            });
        }
        self.clients.push(SseClient {
            stream: client_stream,
            cursor,
            // The SSE handshake follows the same partial-write rules as
            // event bodies. No accepted socket is switched to blocking mode.
            pending,
            binding,
        });
        Ok(())
    }

    fn flush_events(&mut self) {
        let events = self.shared.lock().ok().map(|shared| shared.events.clone());
        let Some(events) = events else {
            self.clients.clear();
            return;
        };
        self.clients.retain_mut(|client| {
            if !client.is_connected() {
                return false;
            }
            // Share the byte-bounded replay buffer between clients, rather
            // than serializing a second copy per connection. A slow client
            // retains at most one bounded batch; snapshot bytes never enter
            // this queue, and the connection count is limited at admission.
            client.queue_events(&events);

            let mut budget = RESPONSE_WRITE_BUDGET;
            while let Some(pending) = client.pending.front_mut() {
                if budget == 0 {
                    break;
                }
                let end = pending.bytes.len().min(pending.offset + budget);
                match client.stream.write(&pending.bytes[pending.offset..end]) {
                    Ok(0) => return false,
                    Ok(written) => {
                        pending.offset += written;
                        budget -= written;
                        if pending.offset == pending.bytes.len() {
                            let id = pending.id;
                            client.pending.pop_front();
                            client.cursor = id;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(_) => return false,
                }
            }
            true
        });
    }
}

fn is_client_disconnect(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::BrokenPipe
            | ErrorKind::ConnectionReset
            | ErrorKind::ConnectionAborted
            | ErrorKind::NotConnected
            | ErrorKind::UnexpectedEof
            | ErrorKind::WriteZero
    )
}

fn parse_content_length(headers: &[u8]) -> usize {
    headers
        .split(|byte| *byte == b'\n')
        .filter_map(|line| std::str::from_utf8(line).ok())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.trim().eq_ignore_ascii_case("content-length") {
                value.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

fn header_value<'a>(headers: &'a [u8], wanted: &str) -> Option<&'a str> {
    headers
        .split(|byte| *byte == b'\n')
        .filter_map(|line| std::str::from_utf8(line).ok())
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case(wanted)
                .then(|| value.trim())
        })
}

fn query_parameter<'a>(query: &'a str, wanted: &str) -> Option<&'a str> {
    query.split('&').find_map(|part| {
        let (name, value) = part.split_once('=')?;
        (name == wanted).then_some(value)
    })
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn encode_response(status: u16, content_type: &str, body: &[u8]) -> Vec<u8> {
    let mut bytes = encode_response_header(status, content_type, body.len());
    bytes.extend_from_slice(body);
    bytes
}

/// A JSON channel is at most three digits and a comma. Reserve that complete
/// bound first, then serialize through a slice so Vec's doubling policy cannot
/// turn a nominally bounded legacy response into an oversized temporary.
fn bounded_snapshot_json(snapshot: &RenderSnapshot, retained: usize) -> Result<Vec<u8>, ()> {
    let json_bound = snapshot.pixels.len().saturating_mul(4).saturating_add(4096);
    let source = snapshot.pixels.capacity();
    let http_bound = json_bound.saturating_add(MAX_FRAME_HTTP_HEADER_BYTES);
    if retained
        .saturating_add(source)
        .saturating_add(json_bound)
        .saturating_add(http_bound)
        > MAX_FRAME_CACHE_BYTES
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(json_bound).map_err(|_| ())?;
    // Allocators may return more capacity than requested. Check actual bytes
    // before serializing or constructing the second, HTTP response buffer.
    if retained
        .saturating_add(source)
        .saturating_add(bytes.capacity())
        .saturating_add(http_bound)
        > MAX_FRAME_CACHE_BYTES
    {
        return Err(());
    }
    bytes.resize(json_bound, 0);
    let length = {
        let mut output = io::Cursor::new(bytes.as_mut_slice());
        serde_json::to_writer(&mut output, snapshot).map_err(|_| ())?;
        output.position() as usize
    };
    bytes.truncate(length);
    Ok(bytes)
}

fn encode_response_header(status: u16, content_type: &str, body_len: usize) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        503 => "Service Unavailable",
        _ => "Response",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        body_len
    );
    header.into_bytes()
}

fn now_timestamp() -> String {
    // A monotonic-independent timestamp is sufficient for diagnostics and
    // avoids pulling a time crate into the simulator. Consumers should treat
    // it as display metadata rather than a trace clock.
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

fn browser_renderer_module(path: &str) -> Option<&'static [u8]> {
    match path {
        "/dev-raster-frame.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/dev-raster-frame.mjs"
        )),
        "/dev-raster-client.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/dev-raster-client.mjs"
        )),
        "/dev-raster-preview.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/dev-raster-preview.mjs"
        )),
        "/remote-dom.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/remote-dom.mjs"
        )),
        "/input-causal-ledger.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/input-causal-ledger.mjs"
        )),
        "/dom-presenter.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/dom-presenter.mjs"
        )),
        "/dom-session-client.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/dom-session-client.mjs"
        )),
        "/remote-canvaskit.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/remote-canvaskit.mjs"
        )),
        "/canvaskit-presenter.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/canvaskit-presenter.mjs"
        )),
        "/text-flow-plan.mjs" => Some(include_bytes!(
            "../../../examples/hosts/web-wasm/text-flow-plan.mjs"
        )),
        _ => None,
    }
}

const UI_HTML: &str = include_str!("web-ui.html");
const DEV_RASTER_UI_HTML: &str = include_str!("web-dev-raster-ui.html");
/// App-side Web embedding example served by the local development surface.
/// Keeping this as an external file makes the example independently readable
/// and prevents the inspector page above from becoming the only documented
/// integration path.
const WEB_EMBED_HTML: &str = include_str!("../../../examples/hosts/web/index.html");

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::thread;
    use std::time::{Duration, Instant};

    fn request(addr: SocketAddr, request: &[u8]) -> Vec<u8> {
        let mut stream = TcpStream::connect(addr).unwrap();
        stream.write_all(request).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut output = Vec::new();
        stream.read_to_end(&mut output).unwrap();
        output
    }

    fn example_frame(id: u64) -> RenderSnapshot {
        RenderSnapshot {
            frame_id: id,
            width: 2,
            height: 1,
            stride: 12,
            format: "rgba8-premultiplied".into(),
            pixels: vec![64, 32, 16, 128, 99, 77, 55, 0, 9, 9, 9, 9],
        }
    }

    fn example_render_frame(id: u64) -> RenderFrame {
        let viewport = container_render_skia::Rect {
            x: 0.0,
            y: 0.0,
            width: 64.0,
            height: 64.0,
        };
        RenderFrame {
            frame_id: id,
            viewport,
            root: container_render_skia::RenderNode::new("page", viewport),
            images: BTreeMap::from([(
                "sha256:encoded-source".into(),
                Arc::new(container_render_skia::ImageResource {
                    width: 1,
                    height: 1,
                    pixels: vec![240, 20, 10, 255],
                }),
            )]),
        }
    }

    fn response_json(bytes: &[u8]) -> Value {
        let start = find_bytes(bytes, b"\r\n\r\n").unwrap() + 4;
        serde_json::from_slice(&bytes[start..]).unwrap()
    }

    fn exchange(surface: &mut WebSurface, wire: Vec<u8>) -> Vec<u8> {
        let address = surface.local_addr();
        let client = thread::spawn(move || request(address, &wire));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !client.is_finished() && Instant::now() < deadline {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(1));
        }
        client.join().unwrap()
    }

    #[test]
    fn surface_identity_survives_moves_but_cannot_authorize_a_rebound_listener() {
        let surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let identity = surface.instance_identity();
        let handle = surface.handle();
        assert_eq!(identity.strong_count(), 1);

        let moved = Box::new(surface);
        assert!(identity.ptr_eq(&moved.instance_identity()));
        drop(moved);

        // Neither an original shared handle nor the policy's Weak retains the
        // original surface/listener. The old allocation's identity stays unique.
        assert_eq!(identity.strong_count(), 0);
        let rebound = WebSurface::bind(address.ip(), address.port()).unwrap();
        assert_eq!(rebound.local_addr(), address);
        assert!(!identity.ptr_eq(&rebound.instance_identity()));
        drop(handle);
    }

    #[test]
    fn remote_frame_uses_raw_hash_resources_and_idempotent_small_notifications() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_presentation(json!({"effectiveScale":2}));
        let frame = example_render_frame(3);
        handle
            .publish_render_frame("remote", 5, &frame, 7, 1.5)
            .unwrap();
        let (old_response, old_resource, old_path) = {
            let shared = handle.shared.lock().unwrap();
            assert!(shared.frame.is_none());
            assert!(shared.snapshot.is_none());
            let exported = shared.render_frame.as_ref().unwrap();
            let envelope = response_json(&exported.response);
            assert_eq!(envelope["width"], 128);
            assert_eq!(envelope["logicalWidth"], 64.0);
            assert_eq!(envelope["sourceFrameId"], 3);
            assert_eq!(envelope["renderRevision"], 7);
            assert!(envelope["frame"].get("images").is_none());
            let expected = format!("{:x}", Sha256::digest([240, 20, 10, 255]));
            assert_eq!(
                envelope["resources"]["sha256:encoded-source"]["sha256"],
                expected
            );
            assert_eq!(exported.resources.len(), 1);
            assert!(shared.events[0].wire.len() < 512);
            assert!(!String::from_utf8_lossy(&shared.events[0].wire).contains("pixels"));
            let (path, resource) = exported.resources.first_key_value().unwrap();
            (
                Arc::clone(&exported.response),
                Arc::clone(resource),
                path.clone(),
            )
        };
        handle
            .publish_render_frame("remote", 5, &frame, 7, 1.5)
            .unwrap();
        {
            let shared = handle.shared.lock().unwrap();
            assert!(Arc::ptr_eq(
                &old_response,
                &shared.render_frame.as_ref().unwrap().response
            ));
            assert_eq!(shared.events.len(), 1);
        }
        handle
            .publish_render_frame("remote", 5, &frame, 8, 1.5)
            .unwrap();
        let shared = handle.shared.lock().unwrap();
        let exported = shared.render_frame.as_ref().unwrap();
        assert!(!exported.resources.contains_key(&old_path));
        assert!(
            Arc::ptr_eq(&old_resource, exported.resources.values().next().unwrap()),
            "unchanged bytes are shared while URLs authorize only the current revision"
        );
        assert_eq!(shared.events.len(), 1);
    }

    #[test]
    fn remote_frame_rejects_bad_resources_stale_revisions_and_overbudget_targets_atomically() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let frame = example_render_frame(1);
        handle
            .publish_render_frame("remote", 2, &frame, 4, 0.0)
            .unwrap();
        let accepted = Arc::clone(
            &handle
                .shared
                .lock()
                .unwrap()
                .render_frame
                .as_ref()
                .unwrap()
                .response,
        );
        assert!(handle
            .publish_render_frame("remote", 2, &frame, 3, 0.0)
            .is_err());
        let mut invalid = frame.clone();
        invalid.images.insert(
            "invalid".into(),
            Arc::new(container_render_skia::ImageResource {
                width: 2,
                height: 2,
                pixels: vec![0],
            }),
        );
        assert!(handle
            .publish_render_frame("remote", 2, &invalid, 5, 0.0)
            .is_err());
        handle.set_presentation(json!({"effectiveScale":100}));
        assert!(handle
            .publish_render_frame("remote", 3, &frame, 5, 0.0)
            .is_err());
        assert!(Arc::ptr_eq(
            &accepted,
            &handle
                .shared
                .lock()
                .unwrap()
                .render_frame
                .as_ref()
                .unwrap()
                .response
        ));
    }

    #[test]
    fn remote_candidate_scale_is_explicit_and_does_not_commit_presentation_preferences() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let settings = json!({"effectiveScale":1,"generation":1});
        handle.set_presentation(settings.clone());
        handle
            .publish_render_frame_at_scale("remote", 2, &example_render_frame(1), 1, 0.0, 2.0)
            .unwrap();
        let accepted = Arc::clone(
            &handle
                .shared
                .lock()
                .unwrap()
                .render_frame
                .as_ref()
                .unwrap()
                .response,
        );
        assert_eq!(response_json(&accepted)["width"], 128);
        assert_eq!(
            handle.presentation(),
            settings,
            "runtime owner commits settings only after publication succeeds"
        );
        assert!(handle
            .publish_render_frame_at_scale("remote", 3, &example_render_frame(1), 2, 0.0, 100.0)
            .is_err());
        assert!(Arc::ptr_eq(
            &accepted,
            &handle
                .shared
                .lock()
                .unwrap()
                .render_frame
                .as_ref()
                .unwrap()
                .response
        ));
        assert_eq!(handle.presentation(), settings);
    }

    #[test]
    fn remote_http_authorizes_current_resources_and_queues_correlated_presenter_receipts() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle
            .publish_render_frame("remote", 2, &example_render_frame(1), 4, 0.0)
            .unwrap();
        let (url, retained) = {
            let shared = handle.shared.lock().unwrap();
            let (url, bytes) = shared
                .render_frame
                .as_ref()
                .unwrap()
                .resources
                .first_key_value()
                .unwrap();
            (url.clone(), Arc::clone(bytes))
        };
        let response = exchange(
            &mut surface,
            format!("GET {url} HTTP/1.1\r\nHost: localhost\r\n\r\n").into_bytes(),
        );
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert!(response.ends_with(&[240, 20, 10, 255]));
        let envelope = response_json(&exchange(
            &mut surface,
            b"GET /api/render-frame HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(),
        ));
        assert_eq!(envelope["format"], "render-frame-v1");
        let snapshot = exchange(
            &mut surface,
            b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(),
        );
        assert!(snapshot.starts_with(b"HTTP/1.1 409"));
        assert_eq!(
            response_json(&snapshot)["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        for (revision, expected_status) in [(3, "409"), (4, "202")] {
            let body = json!({"sessionId":"remote","renderRevision":revision,"configGeneration":2,
                "backend":"canvaskit-webgl2","gpuSurface":true,"metrics":{"gpuCompletion":"not-waited"}}).to_string();
            let wire = format!("POST /api/render-presented HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}",body.len());
            let response = exchange(&mut surface, wire.into_bytes());
            assert!(String::from_utf8_lossy(&response)
                .starts_with(&format!("HTTP/1.1 {expected_status}")));
        }
        let receipts = handle.take_render_presented();
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0]["renderRevision"], 4);
        assert!(handle.take_render_presented().is_empty());
        handle
            .publish_render_frame("next-session", 2, &example_render_frame(2), 5, 0.0)
            .unwrap();
        let response = exchange(
            &mut surface,
            format!("GET {url} HTTP/1.1\r\nHost: localhost\r\n\r\n").into_bytes(),
        );
        assert!(response.starts_with(b"HTTP/1.1 404"));
        assert!(
            retained.ends_with(&[240, 20, 10, 255]),
            "already-owned responses retain their immutable bytes"
        );
    }

    #[test]
    fn missing_renderer_assets_do_not_change_the_surface_configuration() {
        let mut surface = WebSurface::localhost(0).unwrap();
        assert!(surface
            .configure_canvaskit_assets(Path::new("/definitely-missing-weapp-renderer-assets"))
            .is_err());
        assert!(surface.shared.lock().unwrap().renderer_assets.is_empty());
        let response = exchange(
            &mut surface,
            b"GET /api/renderer-config HTTP/1.1\r\nHost: localhost\r\n\r\n".to_vec(),
        );
        assert!(response.starts_with(b"HTTP/1.1 404"));
    }

    #[test]
    fn remote_input_requires_runtime_confirmation_of_the_current_presented_identity() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle
            .publish_render_frame("remote", 2, &example_render_frame(1), 4, 0.0)
            .unwrap();
        let receipt = json!({"sessionId":"remote", "renderRevision":4, "configGeneration":2,
            "backend":"canvaskit-webgl2", "gpuSurface":true});
        let input = json!({"messages":[{"sessionId":"remote", "op":"event.batch",
            "payload":{"events":[], "renderRevision":4, "configGeneration":2}}]});
        let post = |surface: &mut WebSurface, path: &str, value: &Value| {
            let body = value.to_string();
            exchange(
                surface,
                format!(
                    "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                )
                .into_bytes(),
            )
        };
        let blocked = post(&mut surface, "/api/bridge", &input);
        assert!(blocked.starts_with(b"HTTP/1.1 409"));
        assert_eq!(response_json(&blocked)["error"]["code"], "ERR_CANCELLED");
        assert!(post(&mut surface, "/api/render-presented", &receipt).starts_with(b"HTTP/1.1 202"));
        assert!(
            post(&mut surface, "/api/bridge", &input).starts_with(b"HTTP/1.1 409"),
            "HTTP queue admission is not runtime confirmation"
        );
        let queued = handle.take_render_presented();
        handle.confirm_render_presented(&queued[0]).unwrap();
        let typed_input = container_bridge::BridgeEnvelope::request(
            "remote",
            "typed-input",
            "event.batch",
            input["messages"][0]["payload"].clone(),
        );
        handle.validate_render_input(&typed_input).unwrap();
        assert!(post(&mut surface, "/api/bridge", &input).starts_with(b"HTTP/1.1 200"));
        assert_eq!(handle.take_bridge_requests().len(), 1);
        let mut missing = input.clone();
        missing["messages"][0]["payload"]
            .as_object_mut()
            .unwrap()
            .remove("renderRevision");
        assert!(post(&mut surface, "/api/bridge", &missing).starts_with(b"HTTP/1.1 409"));
        handle
            .publish_render_frame("remote", 2, &example_render_frame(2), 5, 0.0)
            .unwrap();
        assert!(
            handle.validate_render_input(&typed_input).is_err(),
            "an admitted request must be checked again at runtime dispatch"
        );
        assert!(handle.confirm_render_presented(&receipt).is_err());
        assert!(post(&mut surface, "/api/bridge", &input).starts_with(b"HTTP/1.1 409"));
        assert!(handle.take_bridge_requests().is_empty());
        let manual = json!({"sessionId":"remote", "op":"diagnostic", "payload":{}});
        assert!(
            post(&mut surface, "/api/bridge", &manual).starts_with(b"HTTP/1.1 200"),
            "non-input inspector operations retain their existing semantics"
        );
    }

    #[test]
    fn binary_frame_is_straight_alpha_packed_versioned_and_shared() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_render_time(2.5);
        let source = example_frame(7);
        assert!(handle
            .publish_frame("test-session", 3, 1.0, 0.5, &source)
            .unwrap());
        let old_wire = {
            let shared = handle.shared.lock().unwrap();
            assert!(
                shared.snapshot.is_none(),
                "no expanded numeric JSON in normal frame path"
            );
            let frame = shared.frame.as_ref().unwrap();
            assert_eq!(
                frame.snapshot, source,
                "legacy snapshot retains original premultiplication"
            );
            let wire = frame.response.as_ref();
            let start = find_bytes(wire, b"\r\n\r\n").unwrap() + 4;
            let length = u32::from_le_bytes(wire[start..start + 4].try_into().unwrap()) as usize;
            let metadata: Value =
                serde_json::from_slice(&wire[start + 4..start + 4 + length]).unwrap();
            assert_eq!(metadata["schemaVersion"], 1);
            assert_eq!(metadata["sessionId"], "test-session");
            assert_eq!(metadata["configGeneration"], 3);
            assert_eq!(metadata["logicalWidth"], 1.0);
            assert_eq!(metadata["width"], 2);
            assert_eq!(metadata["stride"], 8);
            assert_eq!(metadata["renderMs"], 2.5);
            assert_eq!(&wire[start + 4 + length..], &[128, 64, 32, 128, 0, 0, 0, 0]);
            assert_eq!(shared.events.len(), 1);
            assert!(!String::from_utf8_lossy(&shared.events[0].wire).contains("pixels"));
            Arc::clone(&frame.response)
        };
        assert!(!handle
            .publish_frame("test-session", 3, 1.0, 0.5, &source)
            .unwrap());
        let shared = handle.shared.lock().unwrap();
        assert!(Arc::ptr_eq(
            &old_wire,
            &shared.frame.as_ref().unwrap().response
        ));
        assert_eq!(shared.events.len(), 1);
    }

    #[test]
    fn failed_frame_reservations_preserve_accepted_state_and_release_the_store() {
        for failure in [
            FrameAllocation::Response,
            FrameAllocation::Source,
            FrameAllocation::Ledger,
            FrameAllocation::Claim,
        ] {
            let surface = WebSurface::localhost(0).unwrap();
            let handle = surface.handle();
            let old = example_frame(1);
            handle.publish_frame("reserved", 1, 2.0, 1.0, &old).unwrap();
            handle.set_state_json(json!({"sessionId":"reserved","traceCount":7}));
            handle.set_presentation(json!({"revision":1,"generation":1}));
            let before = handle.state();
            let old_wire = Arc::clone(
                &handle
                    .shared
                    .lock()
                    .unwrap()
                    .frame
                    .as_ref()
                    .unwrap()
                    .response,
            );
            let mut applied = false;
            let rejected = (|| -> Result<(), String> {
                let reservation = handle.reserve_frame_using(
                    "reserved",
                    2,
                    2.0,
                    1.0,
                    2,
                    1,
                    old.pixels.len(),
                    |allocation| {
                        if allocation == failure {
                            Err(format!("injected {allocation:?} allocation failure"))
                        } else {
                            Ok(())
                        }
                    },
                )?;
                applied = true;
                reservation.publish(&old, 2, 1.0)
            })();
            assert!(rejected.unwrap_err().contains("injected"));
            assert!(!applied, "{failure:?} failed before the runtime boundary");
            assert_eq!(handle.state(), before);
            {
                let shared = handle.shared.lock().unwrap();
                assert_eq!(shared.next_transport_frame, 2);
                assert_eq!(shared.events.len(), 1);
                assert_eq!(shared.frame.as_ref().unwrap().snapshot, old);
                assert!(Arc::ptr_eq(
                    &old_wire,
                    &shared.frame.as_ref().unwrap().response
                ));
            }
            // A failed source/ledger allocation drops all earlier buffers
            // and its guard. The next ordinary publication still succeeds.
            let mut next = old.clone();
            next.frame_id = 2;
            handle
                .reserve_frame_using("reserved", 2, 2.0, 1.0, 2, 1, next.pixels.len(), |_| Ok(()))
                .unwrap()
                .publish(&next, 2, 1.0)
                .unwrap();
            assert_eq!(
                handle
                    .shared
                    .lock()
                    .unwrap()
                    .frame
                    .as_ref()
                    .unwrap()
                    .metadata["frameId"],
                2
            );
        }
    }

    #[test]
    fn dropped_and_exhausted_frame_reservations_do_not_consume_a_sequence() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let old = example_frame(1);
        handle.publish_frame("reserved", 1, 2.0, 1.0, &old).unwrap();
        drop(handle.reserve_frame("reserved", 2, 2.0, 1.0, 2, 1).unwrap());
        assert_eq!(handle.shared.lock().unwrap().next_transport_frame, 2);
        handle.shared.lock().unwrap().next_transport_frame = u64::MAX;
        assert!(
            matches!(handle.reserve_frame("reserved",2,2.0,1.0,2,1),Err(error) if error.contains("sequence exhausted"))
        );
        assert!(
            matches!(handle.reserve_frame(&"x".repeat(MAX_FRAME_SESSION_BYTES+1),2,2.0,1.0,2,1),Err(error) if error.contains("invalid"))
        );
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.frame.as_ref().unwrap().snapshot, old);
        assert_eq!(shared.events.len(), 1);
    }

    #[test]
    fn reserved_metadata_bounds_cover_fully_escaped_session_ids_and_maximum_counters() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let session = "\u{0001}".repeat(MAX_FRAME_SESSION_BYTES);
        let source = RenderSnapshot {
            frame_id: u64::MAX,
            width: 1,
            height: 1,
            stride: 4,
            format: "rgba8".into(),
            pixels: vec![1, 2, 3, 4],
        };
        handle
            .reserve_frame(&session, u64::MAX, 1.0, 1.0, 1, 1)
            .unwrap()
            .publish(&source, u64::MAX, f64::MAX)
            .unwrap();
        let shared = handle.shared.lock().unwrap();
        let frame = shared.frame.as_ref().unwrap();
        assert_eq!(frame.metadata["sessionId"], session);
        assert!(frame.response.len() <= frame.response.capacity());
        assert_eq!(frame.metadata["sourceFrameId"], u64::MAX);
    }

    #[test]
    fn scrolling_publishes_changed_pixels_with_the_same_source_frame_id() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut source = example_frame(41);
        assert!(handle
            .publish_frame_with_revision("scroll", 1, 2.0, 1.0, &source, 10)
            .unwrap());
        let first = handle
            .shared
            .lock()
            .unwrap()
            .frame
            .as_ref()
            .unwrap()
            .metadata
            .clone();
        source.pixels[0] = 32;
        assert!(handle
            .publish_frame_with_revision("scroll", 1, 2.0, 1.0, &source, 11)
            .unwrap());
        let shared = handle.shared.lock().unwrap();
        let second = shared.frame.as_ref().unwrap();
        assert_eq!(first["sourceFrameId"], second.metadata["sourceFrameId"]);
        assert_eq!(first["frameId"], 1);
        assert_eq!(second.metadata["frameId"], 2);
        assert_eq!(second.metadata["renderRevision"], 11);
        assert_eq!(second.snapshot.pixels[0], 32);
        drop(shared);
        assert!(!handle
            .publish_frame_with_revision("scroll", 1, 2.0, 1.0, &source, 11)
            .unwrap());
        handle.clear_snapshot();
        assert!(handle
            .publish_frame_with_revision("scroll", 2, 2.0, 1.0, &source, 12)
            .unwrap());
        assert_eq!(
            handle
                .shared
                .lock()
                .unwrap()
                .frame
                .as_ref()
                .unwrap()
                .metadata["frameId"],
            3,
            "clearing a cached image must not reset the session sequence"
        );
        assert!(handle
            .publish_frame_with_revision("new-session", 2, 2.0, 1.0, &source, 1)
            .unwrap());
        assert_eq!(
            handle
                .shared
                .lock()
                .unwrap()
                .frame
                .as_ref()
                .unwrap()
                .metadata["frameId"],
            1
        );
    }

    #[test]
    fn invalid_frame_preserves_previous_binary_and_source_snapshot() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let source = example_frame(1);
        handle.publish_frame("a", 0, 2.0, 1.0, &source).unwrap();
        let old_wire = Arc::clone(
            &handle
                .shared
                .lock()
                .unwrap()
                .frame
                .as_ref()
                .unwrap()
                .response,
        );
        let mut invalid = source.clone();
        invalid.frame_id = 2;
        invalid.width = 4097;
        assert!(handle.publish_frame("a", 1, 2.0, 1.0, &invalid).is_err());
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.frame.as_ref().unwrap().snapshot, source);
        assert!(Arc::ptr_eq(
            &old_wire,
            &shared.frame.as_ref().unwrap().response
        ));
    }

    #[test]
    fn retained_slow_client_frames_have_a_global_cache_budget() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut frame = RenderSnapshot {
            frame_id: 0,
            width: 2048,
            height: 1024,
            stride: 8192,
            format: "rgba8-premultiplied".into(),
            pixels: vec![255; 2048 * 1024 * 4],
        };
        let mut slow_clients = Vec::new();
        for id in 1..=5 {
            frame.frame_id = id;
            handle
                .publish_frame("bounded", 0, 375.0, 667.0, &frame)
                .unwrap();
            slow_clients.push(Arc::clone(
                &handle
                    .shared
                    .lock()
                    .unwrap()
                    .frame
                    .as_ref()
                    .unwrap()
                    .response,
            ));
        }
        frame.frame_id = 6;
        assert!(handle
            .check_frame_capacity(frame.width, frame.height)
            .is_err());
        assert!(handle
            .publish_frame("bounded", 0, 375.0, 667.0, &frame)
            .unwrap_err()
            .contains("cache budget"));
        assert_eq!(
            handle
                .shared
                .lock()
                .unwrap()
                .frame
                .as_ref()
                .unwrap()
                .snapshot
                .frame_id,
            5
        );
        drop(slow_clients);
        assert!(handle
            .publish_frame("bounded", 0, 375.0, 667.0, &frame)
            .unwrap());
        let shared = handle.shared.lock().unwrap();
        let retained = shared
            .retained_response_bytes
            .iter()
            .filter(|entry| entry.bytes.strong_count() > 0)
            .map(|entry| entry.length)
            .sum::<usize>()
            + shared.frame.as_ref().unwrap().snapshot.pixels.len();
        assert!(retained <= MAX_FRAME_CACHE_BYTES);
    }

    #[test]
    fn oversized_legacy_json_is_rejected_without_expanding_the_frame() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let frame = RenderSnapshot {
            frame_id: 1,
            width: 2048,
            height: 1024,
            stride: 8192,
            format: "rgba8-premultiplied".into(),
            pixels: vec![255; 2048 * 1024 * 4],
        };
        surface
            .handle()
            .publish_frame("large-json", 0, 375.0, 667.0, &frame)
            .unwrap();
        let address = surface.local_addr();
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        while !client.is_finished() {
            surface.poll().unwrap();
            surface.wait(Duration::from_millis(2)).unwrap();
        }
        let wire = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(wire.starts_with("HTTP/1.1 503"));
        assert!(wire.contains("use /api/frame"));
        assert!(surface.handle().shared.lock().unwrap().snapshot.is_none());
    }

    #[test]
    fn legacy_json_capacity_stays_bounded_with_retained_slow_client_frames() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut source = RenderSnapshot {
            frame_id: 0,
            width: 512,
            height: 512,
            stride: 2048,
            format: "rgba8-premultiplied".into(),
            pixels: vec![255; 1024 * 1024],
        };
        let mut slow_clients = Vec::new();
        for id in 1..=54 {
            source.frame_id = id;
            handle
                .publish_frame("legacy-boundary", 1, 512.0, 512.0, &source)
                .unwrap();
            slow_clients.push(Arc::clone(
                &handle
                    .shared
                    .lock()
                    .unwrap()
                    .frame
                    .as_ref()
                    .unwrap()
                    .response,
            ));
        }
        {
            let shared = handle.shared.lock().unwrap();
            let snapshot = &shared.frame.as_ref().unwrap().snapshot;
            let retained = shared
                .retained_response_bytes
                .iter()
                .filter(|entry| entry.bytes.strong_count() > 0)
                .map(|entry| entry.length)
                .sum::<usize>();
            let body = bounded_snapshot_json(snapshot, retained).unwrap();
            // One MiB of 255s plus metadata crosses the 4 MiB power-of-two
            // boundary. serde_json::to_vec used to grow this buffer to 8 MiB.
            assert!(body.len() > 4 * 1024 * 1024);
            assert!(body.capacity() < 5 * 1024 * 1024);
            let response = encode_response(200, "application/json", &body);
            assert!(
                retained + snapshot.pixels.capacity() + body.capacity() + response.capacity()
                    <= MAX_FRAME_CACHE_BYTES
            );
            let body_start = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
            assert_eq!(&response[body_start..], body);
        }
        source.frame_id = 55;
        handle
            .publish_frame("legacy-boundary", 1, 512.0, 512.0, &source)
            .unwrap();
        slow_clients.push(Arc::clone(
            &handle
                .shared
                .lock()
                .unwrap()
                .frame
                .as_ref()
                .unwrap()
                .response,
        ));
        {
            let shared = handle.shared.lock().unwrap();
            let retained = shared
                .retained_response_bytes
                .iter()
                .filter(|entry| entry.bytes.strong_count() > 0)
                .map(|entry| entry.length)
                .sum();
            assert!(
                bounded_snapshot_json(&shared.frame.as_ref().unwrap().snapshot, retained).is_err()
            );
            assert_eq!(shared.frame.as_ref().unwrap().snapshot.frame_id, 55);
            assert!(shared.snapshot.is_none());
        }
        drop(slow_clients);
        let shared = handle.shared.lock().unwrap();
        let retained = shared
            .retained_response_bytes
            .iter()
            .filter(|entry| entry.bytes.strong_count() > 0)
            .map(|entry| entry.length)
            .sum();
        assert!(bounded_snapshot_json(&shared.frame.as_ref().unwrap().snapshot, retained).is_ok());
    }

    #[test]
    fn presentation_http_receipt_is_not_a_commit_and_stale_writes_are_rejected() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_presentation(json!({"schemaVersion":1,"revision":4,"generation":8,"logicalWidth":375,"logicalHeight":667,"renderScale":2,"effectiveScale":2,"fps":60}));
        for (revision, status) in [(3, 409), (4, 202)] {
            let address = surface.local_addr();
            let body =
                json!({"revision":revision,"requestId":"density","renderScale":3}).to_string();
            let wire=format!("POST /api/presentation HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",body.len(),body);
            let client = thread::spawn(move || request(address, wire.as_bytes()));
            while !client.is_finished() {
                surface.poll().unwrap();
                surface.wait(Duration::from_millis(2)).unwrap();
            }
            let response = String::from_utf8(client.join().unwrap()).unwrap();
            assert!(
                response.starts_with(&format!("HTTP/1.1 {status}")),
                "{response}"
            );
        }
        let requests = handle.take_presentation_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["renderScale"], 3);
        assert_eq!(
            handle.presentation()["effectiveScale"],
            2,
            "HTTP receipt cannot apply runtime configuration"
        );
        assert!(handle.take_presentation_requests().is_empty());
    }

    #[test]
    fn readiness_drains_large_frame_without_a_fixed_sleep_per_write_budget() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let frame = RenderSnapshot {
            frame_id: 1,
            width: 750,
            height: 1334,
            stride: 3000,
            format: "rgba8-premultiplied".into(),
            pixels: vec![255; 750 * 1334 * 4],
        };
        handle
            .publish_frame("readiness", 0, 375.0, 667.0, &frame)
            .unwrap();
        let address = surface.local_addr();
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/frame HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        let deadline = Instant::now() + Duration::from_secs(2);
        while !client.is_finished() && Instant::now() < deadline {
            surface.poll().unwrap();
            surface.wait(Duration::from_millis(16)).unwrap();
        }
        let response = client.join().unwrap();
        let start = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
        let metadata_len =
            u32::from_le_bytes(response[start..start + 4].try_into().unwrap()) as usize;
        assert_eq!(response.len() - start - 4 - metadata_len, 750 * 1334 * 4);
        assert!(surface.pending_responses.is_empty());
    }

    #[test]
    fn serves_state_and_snapshot() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        handle.set_state_json(json!({"revision": 3, "status": "ready"}));
        handle.set_snapshot(json!({"width": 1, "height": 1, "pixels": [1,2,3,255]}));
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/state HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let state = client.join().unwrap();
        assert!(String::from_utf8_lossy(&state).contains("\"revision\":3"));
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let snapshot = client.join().unwrap();
        assert!(String::from_utf8_lossy(&snapshot).contains("\"pixels\":[1,2,3,255]"));
    }

    #[test]
    fn formats_ipv6_url_with_authority_brackets() {
        let surface = WebSurface::bind(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST), 0).unwrap();
        assert!(
            surface.url().starts_with("http://[::1]:"),
            "{}",
            surface.url()
        );
        assert!(surface.url().ends_with('/'));
    }

    #[test]
    fn serves_same_origin_web_embedding_example() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let client = thread::spawn(move || {
            request(address, b"GET /embed HTTP/1.1\r\nHost: localhost\r\n\r\n")
        });
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("Weapp Container embedded Web host"));
        assert!(response.contains("/api/events"));
        assert!(response.contains("renderSnapshot"));
    }

    #[test]
    fn admitted_http_and_sse_connections_disable_nagle() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
        let peer_address = peer.local_addr().unwrap();
        peer.write_all(b"GET /api/st").unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            let admitted = surface.poll().unwrap();
            if !surface.pending_requests.is_empty() {
                break;
            }
            // A connect/write does not promise that this nonblocking accept
            // already observes the connection. Only wait before admission;
            // losing an admitted fragmented request remains a hard failure.
            assert_eq!(admitted, 0, "an admitted HTTP request disappeared");
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "HTTP admission readiness timed out");
            surface.wait(remaining).unwrap();
        }
        assert_eq!(surface.pending_requests.len(), 1);
        assert_eq!(
            surface.pending_requests[0].stream.peer_addr().unwrap(),
            peer_address,
            "the inspected HTTP owner must belong to this client"
        );
        assert!(surface.pending_requests[0].stream.nodelay().unwrap());
        let response_owner = surface.pending_requests[0].stream.try_clone().unwrap();
        assert!(
            response_owner.nodelay().unwrap(),
            "HTTP response clones must retain low-latency TCP configuration"
        );
        let mut events = TcpStream::connect(surface.local_addr()).unwrap();
        let events_address = events.local_addr().unwrap();
        events
            .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut events_admitted = false;
        loop {
            events_admitted |= surface.poll().unwrap() != 0;
            if !surface.clients.is_empty() {
                break;
            }
            let events_pending = surface
                .pending_requests
                .iter()
                .any(|request| request.stream.peer_addr().unwrap() == events_address);
            assert!(
                !events_admitted || events_pending,
                "an admitted SSE request disappeared before ownership transfer"
            );
            let remaining = deadline.saturating_duration_since(Instant::now());
            assert!(!remaining.is_zero(), "SSE admission readiness timed out");
            surface.wait(remaining).unwrap();
        }
        assert_eq!(surface.clients.len(), 1);
        assert_eq!(
            surface.clients[0].stream.peer_addr().unwrap(),
            events_address,
            "the inspected SSE owner must belong to this client"
        );
        assert!(
            surface.clients[0].stream.nodelay().unwrap(),
            "SSE notices must not wait for Nagle/delayed ACK"
        );
        assert_eq!(surface.pending_requests.len(), 1);
        assert_eq!(
            surface.pending_requests[0].stream.peer_addr().unwrap(),
            peer_address,
            "SSE admission must retain the original fragmented HTTP request"
        );
    }

    #[test]
    fn retains_a_fragmented_http_request_until_complete() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let mut client = TcpStream::connect(address).unwrap();
        client.write_all(b"GET /api/st").unwrap();
        // The first poll accepts the connection before the request headers
        // arrive. The server must retain the socket rather than resetting it.
        surface.poll().unwrap();
        client
            .write_all(b"ate HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();

        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut response = Vec::new();
        for _ in 0..20 {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            match client.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => response.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == ErrorKind::TimedOut => break,
                Err(error) => panic!("fragmented request failed: {error}"),
            }
            if response
                .windows(b"\r\n\r\n".len())
                .any(|window| window == b"\r\n\r\n")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(String::from_utf8_lossy(&response).contains("HTTP/1.1 200 OK"));
    }

    #[test]
    fn retains_a_fragmented_bridge_body_until_complete() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        surface.set_local_bridge_handler(Box::new(|body| {
            assert_eq!(
                body,
                br#"{"op":"diagnostic","payload":{"part":"complete"}}"#
            );
            Ok(br#"{"ok":true,"received":"complete"}"#.to_vec())
        }));

        let body = br#"{"op":"diagnostic","payload":{"part":"complete"}}"#;
        let header = format!(
            "POST /api/bridge HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
            body.len()
        );
        let split = body.len() / 2;
        let mut client = TcpStream::connect(address).unwrap();
        client.write_all(header.as_bytes()).unwrap();
        client.write_all(&body[..split]).unwrap();

        // The server must keep the accepted socket pending while the body is
        // incomplete.  A real browser can split a JSON request across several
        // TCP packets even when the headers arrived in one packet.
        surface.poll().unwrap();
        client
            .set_read_timeout(Some(Duration::from_millis(20)))
            .unwrap();
        let mut partial = [0_u8; 256];
        assert!(matches!(
            client.read(&mut partial),
            Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
        ));

        client.write_all(&body[split..]).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let mut response = Vec::new();
        for _ in 0..40 {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            match client.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => response.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) if error.kind() == ErrorKind::TimedOut => {}
                Err(error) => panic!("fragmented bridge request failed: {error}"),
            }
            if response
                .windows(b"received".len())
                .any(|window| window == b"received")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let text = String::from_utf8_lossy(&response);
        assert!(
            text.contains("HTTP/1.1 200 OK"),
            "unexpected response: {text}"
        );
        assert!(text.contains("received"), "missing bridge result: {text}");
    }

    #[test]
    fn serves_large_snapshot_without_truncation() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        let pixels = vec![255_u8; 375 * 667 * 4];
        handle.set_snapshot(json!({
            "width": 375,
            "height": 667,
            "stride": 1500,
            "format": "rgba8-premultiplied",
            "frame_id": 1,
            "pixels": pixels,
        }));
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        for _ in 0..40 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = client.join().unwrap();
        let header_end = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .expect("HTTP response headers");
        let body = response.len() - header_end - 4;
        assert!(body > 375 * 667 * 4);
        let wire = String::from_utf8(response).unwrap();
        assert!(wire.contains("\"width\":375"));
        assert!(wire.contains("\"height\":667"));
    }

    fn assert_partial_snapshot_disconnect_is_isolated(reset: bool) {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        surface
            .handle()
            .set_state_json(json!({"status": "ready", "revision": 7}));
        surface.handle().set_snapshot(json!({
            "width": 512, "height": 512, "stride": 2048,
            "pixels": vec![255_u8; 512 * 512 * 4],
        }));
        surface.listener.set_nonblocking(false).unwrap();
        let client = thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .write_all(b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n")
                .unwrap();
            let mut prefix = vec![0_u8; 8192];
            stream.read_exact(&mut prefix).unwrap();
            let header_end = find_bytes(&prefix, b"\r\n\r\n").unwrap();
            assert!(prefix.starts_with(b"HTTP/1.1 200 OK"));
            assert!(parse_content_length(&prefix[..header_end]) > prefix.len());
            #[cfg(unix)]
            if reset {
                use std::os::fd::AsRawFd;
                let linger = nix::libc::linger {
                    l_onoff: 1,
                    l_linger: 0,
                };
                // Abort the real TCP connection after part of the HTTP body
                // has arrived; this deterministically exercises ECONNRESET.
                let result = unsafe {
                    nix::libc::setsockopt(
                        stream.as_raw_fd(),
                        nix::libc::SOL_SOCKET,
                        nix::libc::SO_LINGER,
                        (&linger as *const nix::libc::linger).cast(),
                        std::mem::size_of_val(&linger) as nix::libc::socklen_t,
                    )
                };
                assert_eq!(result, 0);
            }
            if !reset {
                stream.shutdown(std::net::Shutdown::Both).unwrap();
            }
            drop(stream);
            request(
                address,
                b"GET /api/state HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        let (stream, _) = surface.listener.accept().unwrap();
        surface.listener.set_nonblocking(true).unwrap();
        stream.set_nonblocking(true).unwrap();
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let send_buffer: nix::libc::c_int = 4096;
            // Keep the response larger than the send buffer so the client
            // closes while write_all is still sending, on every test run.
            let result = unsafe {
                nix::libc::setsockopt(
                    stream.as_raw_fd(),
                    nix::libc::SOL_SOCKET,
                    nix::libc::SO_SNDBUF,
                    (&send_buffer as *const nix::libc::c_int).cast(),
                    std::mem::size_of_val(&send_buffer) as nix::libc::socklen_t,
                )
            };
            assert_eq!(result, 0);
        }
        surface.pending_requests.push(PendingRequest {
            stream,
            buffer: Vec::new(),
            accepted_at: Instant::now(),
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while !client.is_finished() && Instant::now() < deadline {
            surface
                .poll()
                .expect("one cancelled snapshot must not stop the HTTP surface");
            thread::sleep(Duration::from_millis(2));
        }
        let response = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("\"revision\":7"));
        assert!(surface.pending_requests.is_empty());
    }

    #[test]
    fn partial_snapshot_close_does_not_stop_other_http_clients() {
        assert_partial_snapshot_disconnect_is_isolated(false);
    }

    #[cfg(unix)]
    #[test]
    fn partial_snapshot_reset_does_not_stop_other_http_clients() {
        assert_partial_snapshot_disconnect_is_isolated(true);
    }

    #[test]
    fn stalled_snapshot_client_does_not_block_state_sse_or_shutdown() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        handle.set_state_json(json!({"status": "ready", "revision": 9}));
        // This opaque field keeps serialization cheap while producing a
        // response much larger than a TCP send window, like real RGBA JSON.
        handle.set_snapshot(json!({"pixels": "x".repeat(4 * 1024 * 1024)}));

        let mut stalled = TcpStream::connect(address).unwrap();
        stalled
            .write_all(b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        surface.listener.set_nonblocking(false).unwrap();
        let (stream, _) = surface.listener.accept().unwrap();
        surface.listener.set_nonblocking(true).unwrap();
        stream.set_nonblocking(true).unwrap();
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let send_buffer: nix::libc::c_int = 4096;
            let result = unsafe {
                nix::libc::setsockopt(
                    stream.as_raw_fd(),
                    nix::libc::SOL_SOCKET,
                    nix::libc::SO_SNDBUF,
                    (&send_buffer as *const nix::libc::c_int).cast(),
                    std::mem::size_of_val(&send_buffer) as nix::libc::socklen_t,
                )
            };
            assert_eq!(result, 0);
        }
        surface.pending_requests.push(PendingRequest {
            stream,
            buffer: Vec::new(),
            accepted_at: Instant::now(),
        });
        // A bounded watchdog makes a regression fail instead of hanging the
        // test runner forever inside the old blocking write_all call.
        let watchdog_stream = stalled.try_clone().unwrap();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = thread::spawn(move || {
            let _ = stop_rx.recv_timeout(Duration::from_secs(2));
            let _ = watchdog_stream.shutdown(std::net::Shutdown::Both);
        });
        let started = Instant::now();
        surface.poll().unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "a stopped snapshot reader blocked the shared event loop"
        );
        assert_eq!(surface.pending_responses.len(), 1);

        let state_client = thread::spawn(move || {
            request(
                address,
                b"GET /api/state HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        let mut events = TcpStream::connect(address).unwrap();
        events
            .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        events.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut wire = Vec::new();
        let mut published = false;
        while Instant::now() < deadline {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            match events.read(&mut chunk) {
                Ok(read) => wire.extend_from_slice(&chunk[..read]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("SSE read failed: {error}"),
            }
            if !published && find_bytes(&wire, b"\r\n\r\n").is_some() {
                handle.publish("reload", json!({"revision": 10}));
                published = true;
            }
            if state_client.is_finished()
                && String::from_utf8_lossy(&wire).contains("event: reload\n")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(String::from_utf8_lossy(&state_client.join().unwrap()).contains("\"revision\":9"));
        assert!(String::from_utf8_lossy(&wire).contains("event: reload\n"));
        // Dropping a surface must immediately close its queued sockets. This
        // is the path taken after the supervisor observes a shutdown signal.
        let shutdown_started = Instant::now();
        drop(surface);
        assert!(shutdown_started.elapsed() < Duration::from_secs(1));
        stop_tx.send(()).unwrap();
        watchdog.join().unwrap();
    }

    #[test]
    fn unfinished_http_connections_are_bounded_and_expire() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let mut peers = Vec::new();
        for _ in 0..MAX_HTTP_CONNECTIONS {
            peers.push(TcpStream::connect(surface.local_addr()).unwrap());
        }
        surface.poll().unwrap();
        assert_eq!(surface.pending_requests.len(), MAX_HTTP_CONNECTIONS);
        let mut excess = TcpStream::connect(surface.local_addr()).unwrap();
        excess.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut rejected = false;
        while Instant::now() < deadline {
            surface.poll().unwrap();
            match excess.read(&mut [0_u8; 1]) {
                Ok(0) => {
                    rejected = true;
                    break;
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                outcome => panic!("unexpected excess-connection result: {outcome:?}"),
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(rejected, "excess HTTP connection was not closed");
        for request in &mut surface.pending_requests {
            request.accepted_at = Instant::now() - HTTP_DEADLINE;
        }
        surface.poll().unwrap();
        assert!(surface.pending_requests.is_empty());

        let peer = TcpStream::connect(surface.local_addr()).unwrap();
        surface.listener.set_nonblocking(false).unwrap();
        let (stream, _) = surface.listener.accept().unwrap();
        surface.listener.set_nonblocking(true).unwrap();
        surface
            .queue_response(&stream, 200, "text/plain", b"expired")
            .unwrap();
        surface.pending_responses[0].queued_at = Instant::now() - HTTP_DEADLINE;
        surface.flush_responses();
        assert!(surface.pending_responses.is_empty());
        drop((peer, peers));
    }

    #[cfg(unix)]
    #[test]
    fn writable_clients_receive_multiple_fair_quanta_in_one_io_slice() {
        use std::os::fd::AsRawFd;
        let mut surface = WebSurface::localhost(0).unwrap();
        surface.listener.set_nonblocking(false).unwrap();
        let mut readers = Vec::new();
        const CLIENTS: usize = 2;
        const BODY: usize = 4 * 1024 * 1024;
        for byte in 0..CLIENTS {
            let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
            let (stream, _) = surface.listener.accept().unwrap();
            let capacity: nix::libc::c_int = 1024 * 1024;
            // Ensure the test exercises writable fairness turns rather than
            // the OS default's smaller send window. Real browser throughput
            // acceptance is measured independently on the development loop.
            let result = unsafe {
                nix::libc::setsockopt(
                    stream.as_raw_fd(),
                    nix::libc::SOL_SOCKET,
                    nix::libc::SO_SNDBUF,
                    (&capacity as *const nix::libc::c_int).cast(),
                    std::mem::size_of_val(&capacity) as nix::libc::socklen_t,
                )
            };
            assert_eq!(result, 0);
            surface
                .queue_response_bytes(&stream, vec![byte as u8; BODY])
                .unwrap();
            readers.push(thread::spawn(move || {
                peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                let mut bytes = Vec::new();
                peer.read_to_end(&mut bytes).unwrap();
                assert_eq!(bytes, vec![byte as u8; BODY]);
            }));
        }
        surface.listener.set_nonblocking(true).unwrap();
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut largest_slice = 0;
        while !surface.pending_responses.is_empty() && Instant::now() < deadline {
            let remaining = |surface: &WebSurface| {
                surface
                    .pending_responses
                    .iter()
                    .map(|response| response.body.bytes().len() - response.offset)
                    .sum::<usize>()
            };
            let before = remaining(&surface);
            surface.flush_responses();
            largest_slice = largest_slice.max(before - remaining(&surface));
            surface.wait(Duration::from_millis(1)).unwrap();
        }
        assert!(surface.pending_responses.is_empty());
        for reader in readers {
            reader.join().unwrap();
        }
        assert!(largest_slice>CLIENTS*RESPONSE_WRITE_BUDGET,"writable responses paid a complete host iteration for every fairness quantum: {largest_slice}");
    }

    #[test]
    fn queued_http_responses_reject_snapshot_byte_budget_overflow() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let _peer = TcpStream::connect(surface.local_addr()).unwrap();
        surface.listener.set_nonblocking(false).unwrap();
        let (stream, _) = surface.listener.accept().unwrap();
        surface.listener.set_nonblocking(true).unwrap();
        // Represent occupied response capacity without transmitting it. The
        // next request must receive a bounded rejection, not retain another
        // full frame for a client that may never read it.
        surface
            .queue_response_bytes(&stream, vec![0; MAX_RESPONSE_BYTES - 512])
            .unwrap();
        surface
            .queue_response(&stream, 200, "image/raw", &[255; 1024])
            .unwrap();
        let rejection = surface.pending_responses[1].body.bytes();
        assert!(rejection.len() < 512);
        assert!(rejection.starts_with(b"HTTP/1.1 503 Service Unavailable"));
        assert!(String::from_utf8_lossy(rejection).contains("byte budget exceeded"));
        assert!(
            surface
                .pending_responses
                .iter()
                .map(|response| response.body.bytes().len())
                .sum::<usize>()
                <= MAX_RESPONSE_BYTES
        );
    }

    #[test]
    fn only_connection_loss_errors_are_suppressed() {
        for kind in [
            ErrorKind::BrokenPipe,
            ErrorKind::ConnectionReset,
            ErrorKind::ConnectionAborted,
            ErrorKind::NotConnected,
            ErrorKind::UnexpectedEof,
            ErrorKind::WriteZero,
        ] {
            assert!(is_client_disconnect(&io::Error::from(kind)));
        }
        for kind in [
            ErrorKind::InvalidInput,
            ErrorKind::PermissionDenied,
            ErrorKind::OutOfMemory,
            ErrorKind::Unsupported,
            ErrorKind::Other,
        ] {
            assert!(!is_client_disconnect(&io::Error::from(kind)));
        }
    }

    #[test]
    fn queues_bridge_request_and_publishes_sse_event() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        let body = br#"{"op":"app.init"}"#;
        let wire_request = format!(
            "POST /api/bridge HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let client = thread::spawn(move || request(address, wire_request.as_bytes()));
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = client.join().unwrap();
        assert!(String::from_utf8_lossy(&response).contains("queued"));
        assert_eq!(handle.take_bridge_requests(), vec![body.to_vec()]);
    }

    #[test]
    fn direct_bridge_handler_publishes_response_to_sse_observers() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        surface.set_bridge_handler(Box::new(|body| {
            assert_eq!(body, br#"{"op":"app.init"}"#);
            Ok(br#"{"ok":true,"messages":[]}"#.to_vec())
        }));

        let body = br#"{"op":"app.init"}"#;
        let wire_request = format!(
            "POST /api/bridge HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let client = thread::spawn(move || request(address, wire_request.as_bytes()));
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(response.contains("\"ok\":true"));

        // The handler path must be observable by a newly connected inspector
        // just like the queued path. Requesting since=0 replays the retained
        // response event without requiring a live client during POST.
        let mut sse = TcpStream::connect(surface.local_addr()).unwrap();
        sse.write_all(b"GET /api/events?since=0 HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();
        sse.set_nonblocking(true).unwrap();
        let mut wire = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            loop {
                match sse.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => wire.extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) => panic!("SSE bridge response read failed: {error}"),
                }
            }
            if wire
                .windows(b"event: bridge\n".len())
                .any(|window| window == b"event: bridge\n")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let text = String::from_utf8_lossy(&wire);
        assert!(
            text.contains("event: bridge\n"),
            "missing bridge SSE event: {text}"
        );
        assert!(
            text.contains("\"ok\":true"),
            "missing bridge payload: {text}"
        );
    }

    #[test]
    fn local_bridge_handler_supports_thread_affine_runtime_callbacks() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        surface.set_local_bridge_handler(Box::new(|body| {
            assert_eq!(body, br#"{"op":"diagnostic"}"#);
            Ok(br#"{"ok":true,"local":true}"#.to_vec())
        }));

        let body = br#"{"op":"diagnostic"}"#;
        let wire_request = format!(
            "POST /api/bridge HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            std::str::from_utf8(body).unwrap()
        );
        let client = thread::spawn(move || request(address, wire_request.as_bytes()));
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(
            response.contains("\"local\":true"),
            "unexpected local bridge response: {response}"
        );
    }

    #[test]
    fn retains_diagnostics_in_state_until_successful_reload_clears_them() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_state_json(json!({"revision": 4, "status": "ready"}));
        handle.publish_diagnostic(DevDiagnostic::error(4, "BUILD_FAILED", "invalid manifest"));

        let state = handle.state();
        assert_eq!(state["revision"], 4);
        assert_eq!(state["diagnostics"][0]["code"], "BUILD_FAILED");

        handle.clear_diagnostics();
        assert_eq!(handle.state()["diagnostics"], json!([]));
        handle.set_state_json(json!({"revision": 5, "status": "ready"}));
        let state = handle.state();
        assert_eq!(state["status"], "ready");
        assert_eq!(state["diagnosticHistory"]["schemaVersion"], 1);
        assert_eq!(
            state["diagnosticHistory"]["records"][0]["code"],
            "BUILD_FAILED"
        );
        assert_eq!(state["diagnosticHistory"]["totalRecords"], 1);
        assert_eq!(state["diagnosticHistory"]["complete"], true);
    }

    #[test]
    fn active_errors_survive_ready_frame_publication_until_recovery() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_state_json(json!({"revision": 4, "status": "ready"}));
        handle.publish_diagnostic(DevDiagnostic::error(4, "ERR_ENGINE", "timer failed"));
        handle.set_state_json(json!({"revision": 4, "status": "ready", "traceCount": 9}));
        assert_eq!(handle.state()["status"], "error");
        assert_eq!(handle.state()["traceCount"], 9);
        handle.set_state_json(json!({"status": "stopped"}));
        assert_eq!(handle.state()["status"], "stopped");
        handle.clear_diagnostics();
        handle.set_state_json(json!({"revision": 5, "status": "ready"}));
        assert_eq!(handle.state()["status"], "ready");
        assert_eq!(
            handle.state()["diagnosticHistory"]["records"][0]["message"],
            "timer failed"
        );
    }

    #[test]
    fn diagnostic_journal_is_bounded_and_reports_evicted_history() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        for revision in 0..300 {
            handle.publish_diagnostic(DevDiagnostic::error(revision, "BUILD_FAILED", "bad build"));
        }
        let state = handle.state();
        let history = &state["diagnosticHistory"];
        assert_eq!(state["diagnostics"].as_array().unwrap().len(), 64);
        assert_eq!(history["records"].as_array().unwrap().len(), 256);
        assert_eq!(history["records"][0]["revision"], 44);
        assert_eq!(history["totalRecords"], 300);
        assert_eq!(history["droppedRecords"], 44);
        assert_eq!(history["complete"], false);
        handle.clear_diagnostics();
        assert_eq!(handle.state()["diagnosticHistory"], *history);
    }

    #[test]
    fn diagnostic_journal_limits_bytes_and_preserves_recent_small_records() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        for revision in 0..3 {
            handle.publish_diagnostic(DevDiagnostic::error(
                revision,
                "LARGE_ERROR",
                "x".repeat(200 * 1024),
            ));
        }
        // An oversized record is still an active overlay diagnostic, but
        // cannot evict the complete useful journal merely by arriving last.
        handle.publish_diagnostic(DevDiagnostic::error(
            3,
            "OVERSIZED_ERROR",
            "x".repeat(MAX_DIAGNOSTIC_HISTORY_BYTES),
        ));
        let state = handle.state();
        assert_eq!(state["diagnostics"].as_array().unwrap().len(), 4);
        let history = &state["diagnosticHistory"];
        assert_eq!(history["records"].as_array().unwrap().len(), 2);
        assert_eq!(history["records"][0]["revision"], 1);
        assert_eq!(history["records"][1]["revision"], 2);
        assert_eq!(history["totalRecords"], 4);
        assert_eq!(history["droppedRecords"], 2);
        assert_eq!(history["complete"], false);
    }

    #[test]
    fn snapshot_history_retains_only_latest_frame_and_one_small_notice() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        let mut previous = None;
        for frame in 0..64 {
            handle.publish(
                "snapshot",
                json!({
                    "frame_id": frame,
                    "width": 64,
                    "height": 64,
                    "stride": 256,
                    "format": "rgba8-premultiplied",
                    "pixels": vec![frame as u8; 64 * 64 * 4],
                }),
            );
            if let Some(previous) = previous {
                assert!(std::sync::Weak::upgrade(&previous).is_none());
            }
            let shared = handle.shared.lock().unwrap();
            let snapshot = shared.snapshot.as_ref().unwrap();
            assert_eq!(Arc::strong_count(snapshot), 1);
            assert_eq!(shared.events.len(), 1);
            assert!(shared.event_bytes < 512);
            let notice = std::str::from_utf8(&shared.events[0].wire).unwrap();
            assert!(!notice.contains("pixels"));
            let payload: Value = serde_json::from_str(
                notice
                    .lines()
                    .find_map(|line| line.strip_prefix("data: "))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(payload["frameId"], frame);
            assert_eq!(payload["url"], "/api/snapshot");
            assert_eq!(payload["width"], 64);
            previous = Some(Arc::downgrade(snapshot));
        }
    }

    #[test]
    fn published_frame_is_available_through_snapshot_endpoint() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        handle.publish("snapshot", json!({"frame_id": 1, "pixels": [0, 0, 0, 255]}));
        handle.publish("snapshot", json!({"frameId": 2, "pixels": [2, 3, 4, 255]}));
        let client = thread::spawn(move || {
            request(
                address,
                b"GET /api/snapshot HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = client.join().unwrap();
        let body = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
        let snapshot: Value = serde_json::from_slice(&response[body..]).unwrap();
        assert_eq!(snapshot["frameId"], 2);
        assert_eq!(snapshot["pixels"], json!([2, 3, 4, 255]));
        let shared = handle.shared.lock().unwrap();
        assert!(String::from_utf8_lossy(&shared.events[0].wire).contains("\"frameId\":2"));
    }

    #[test]
    fn replay_has_a_byte_budget_and_reports_oversized_events() {
        let mut shared = Shared::default();
        for _ in 0..300 {
            shared.publish(
                "diagnostic".into(),
                json!({"message": "x".repeat(16 * 1024)}),
            );
        }
        assert!(shared.events.len() < MAX_EVENTS);
        assert!(shared.event_bytes <= MAX_EVENT_BYTES);
        assert_eq!(
            shared.event_bytes,
            shared
                .events
                .iter()
                .map(|event| event.wire.len())
                .sum::<usize>()
        );
        shared.publish(
            "bridge".into(),
            json!({"data": "x".repeat(MAX_EVENT_BYTES)}),
        );
        let last = shared.events.back().unwrap();
        assert_eq!(last.kind, "error");
        assert!(String::from_utf8_lossy(&last.wire).contains("ERR_DEV_EVENT_TOO_LARGE"));
        assert!(shared.event_bytes <= MAX_EVENT_BYTES);
    }

    #[test]
    fn slow_sse_client_keeps_one_shared_bounded_batch() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let _peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (stream, _) = listener.accept().unwrap();
        let mut client = SseClient {
            stream,
            cursor: 0,
            pending: VecDeque::new(),
            binding: None,
        };
        let mut shared = Shared::default();
        for _ in 0..200 {
            shared.publish(
                "diagnostic".into(),
                json!({"message": "x".repeat(16 * 1024)}),
            );
        }
        client.queue_events(&shared.events);
        let queued = client.pending.len();
        let retained = Arc::downgrade(&client.pending[0].bytes);
        let bytes: usize = client
            .pending
            .iter()
            .map(|pending| pending.bytes.len())
            .sum();
        assert!(bytes <= MAX_EVENT_BYTES);
        assert!(Arc::ptr_eq(
            &client.pending[0].bytes,
            &shared.events[0].wire
        ));
        for _ in 0..200 {
            shared.publish(
                "diagnostic".into(),
                json!({"message": "y".repeat(16 * 1024)}),
            );
            client.queue_events(&shared.events);
        }
        assert_eq!(client.pending.len(), queued);
        assert_eq!(
            client
                .pending
                .iter()
                .map(|pending| pending.bytes.len())
                .sum::<usize>(),
            bytes
        );
        assert!(retained.upgrade().is_some());
        client.pending.clear();
        assert!(retained.upgrade().is_none());
        client.queue_events(&shared.events);
        assert!(Arc::ptr_eq(
            &client.pending[0].bytes,
            &shared.events[0].wire
        ));
    }

    #[test]
    fn sse_rejects_clients_over_connection_budget() {
        let mut surface = WebSurface::localhost(0).unwrap();
        // This test admits sockets directly without the nonblocking poll
        // loop; wait for each connect to reach the listener before accept.
        surface.listener.set_nonblocking(false).unwrap();
        let mut peers = Vec::new();
        for _ in 0..MAX_SSE_CLIENTS {
            let peer = TcpStream::connect(surface.local_addr()).unwrap();
            let (mut stream, _) = surface.listener.accept().unwrap();
            surface.start_sse(&mut stream, None).unwrap();
            peers.push(peer);
        }
        let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
        let (mut stream, _) = surface.listener.accept().unwrap();
        surface.start_sse(&mut stream, None).unwrap();
        drop(stream);
        surface.flush_responses();
        peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
        let mut response = String::new();
        peer.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert_eq!(surface.clients.len(), MAX_SSE_CLIENTS);
        drop(peers);
        // Closed, idle EventSource connections must release their admission
        // slots even when no new render events need to be written.
        let deadline = Instant::now() + Duration::from_secs(1);
        while !surface.clients.is_empty() && Instant::now() < deadline {
            surface.flush_events();
            thread::sleep(Duration::from_millis(2));
        }
        assert!(surface.clients.is_empty());
    }

    #[test]
    fn sse_keeps_reload_after_large_snapshot() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .unwrap();

        // Let the nonblocking server accept the stream before publishing the
        // large frame. Its pixels must never enter the event queue or delay
        // the reload notification behind a multi-megabyte SSE transfer.
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let pixels = vec![255_u8; 375 * 667 * 4];
        handle.publish(
            "snapshot",
            json!({"frame_id": 42, "width": 375, "height": 667, "pixels": pixels}),
        );
        handle.publish("reload", json!({"revision": 2}));
        client.set_nonblocking(true).unwrap();

        let mut wire = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 16 * 1024];
            loop {
                match client.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => wire.extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                    Err(error) => panic!("SSE read failed: {error}"),
                }
            }
            if wire
                .windows(b"event: reload\n".len())
                .any(|window| window == b"event: reload\n")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        assert!(
            wire.windows(b"event: snapshot\n".len())
                .any(|window| window == b"event: snapshot\n"),
            "large snapshot event was not delivered"
        );
        assert!(
            wire.windows(b"event: reload\n".len())
                .any(|window| window == b"event: reload\n"),
            "reload event was dropped after large snapshot"
        );
        let text = String::from_utf8(wire).unwrap();
        assert!(text.contains("\"frameId\":42"));
        assert!(text.contains("\"url\":\"/api/snapshot\""));
        assert!(!text.contains("pixels"));
        assert!(text.len() < 1024);
    }

    #[test]
    fn sse_replays_retained_events_from_last_event_id() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let handle = surface.handle();
        let first_id = handle.publish("reload", json!({"revision": 2}));
        handle.publish("diagnostic", json!({"code": "BUILD_FAILED"}));

        let mut client = TcpStream::connect(address).unwrap();
        client
            .write_all(
                format!(
                    "GET /api/events HTTP/1.1\r\nHost: localhost\r\nLast-Event-ID: {}\r\n\r\n",
                    first_id.saturating_sub(1)
                )
                .as_bytes(),
            )
            .unwrap();
        client.set_nonblocking(true).unwrap();

        let mut wire = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < deadline {
            surface.poll().unwrap();
            let mut chunk = [0_u8; 4096];
            loop {
                match client.read(&mut chunk) {
                    Ok(0) => break,
                    Ok(read) => wire.extend_from_slice(&chunk[..read]),
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) => panic!("SSE replay read failed: {error}"),
                }
            }
            if wire
                .windows(b"event: diagnostic\n".len())
                .any(|window| window == b"event: diagnostic\n")
            {
                break;
            }
            thread::sleep(Duration::from_millis(2));
        }
        let text = String::from_utf8_lossy(&wire);
        assert!(text.contains("event: reload\n"));
        assert!(text.contains("event: diagnostic\n"));
    }

    #[test]
    fn options_response_advertises_bridge_and_event_headers() {
        let mut surface = WebSurface::localhost(0).unwrap();
        let address = surface.local_addr();
        let client = thread::spawn(move || {
            request(
                address,
                b"OPTIONS /api/bridge HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
        });
        for _ in 0..20 {
            surface.poll().unwrap();
            thread::sleep(Duration::from_millis(2));
        }
        let response = String::from_utf8(client.join().unwrap()).unwrap();
        assert!(response.starts_with("HTTP/1.1 204 No Content"));
        assert!(response.contains("Access-Control-Allow-Methods: GET, POST, OPTIONS"));
        assert!(response.contains("Last-Event-ID"));
    }
}

#[cfg(test)]
mod log_manager_wire_tests {
    use super::*;
    #[test]
    fn log_manager_near_100kib_record_survives_actual_web_replay_wire() {
        let record = json!({"version":1,"source":"logManager","level":"log","kind":"explicit","name":"LogManager.log","arguments":{"roots":[0],"nodes":[{"type":"string","value":"x".repeat(100000)}]}});
        let message = record.to_string();
        let payload = json!({"messages":[{"op":"event.batch","payload":{"effects":[{"console":{"entries":[{"level":"log","message":message}]}}]}}]});
        let mut shared = Shared::default();
        shared.publish("bridge".into(), payload.clone());
        let event = shared.events.back().unwrap();
        assert_eq!(event.kind, "bridge");
        assert!(event.wire.len() < MAX_EVENT_BYTES);
        let text = std::str::from_utf8(&event.wire).unwrap();
        let data = text
            .lines()
            .find_map(|line| line.strip_prefix("data: "))
            .unwrap();
        assert_eq!(serde_json::from_str::<Value>(data).unwrap(), payload);
        // The same full record also fits the stricter diagnostic-history sink.
        shared.push_diagnostic(json!({"source":"logManager","message":message}));
        assert_eq!(shared.diagnostic_history.len(), 1);
        assert_eq!(shared.diagnostic_history_dropped, 0);
        assert!(shared.diagnostic_history_bytes < MAX_DIAGNOSTIC_HISTORY_BYTES);
        assert_eq!(shared.diagnostic_history[0].value["message"], message);
    }
}
