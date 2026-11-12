//! Explicit, original-runtime owner for ticketed Raster HTTP. No CLI opt-in.
use super::sse_preview::BoundSseConnection;
use super::*;
use crate::{Simulator, SimulatorConfig, SimulatorError};
use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
use container_runtime::DevRasterPresentationTicket;
use serde::Deserialize;
use std::path::Path;

const ACK_OP: &str = "dev.raster.presented";
const MAX_MESSAGES: usize = 16;
const REQUESTS_PER_TURN: usize = 4;
// Four admitted bodies plus a timer batch fit together in the existing replay
// budget. HTTP admission also proves every minimal correlated reply fits here
// before ANY runtime operation executes.
const MAX_FINAL_BYTES: usize = MAX_EVENT_BYTES / 8;
const MAX_BASE_SESSION_BYTES: usize = MAX_FRAME_SESSION_BYTES - "-reload-".len() - 20;

pub(super) struct BoundRasterAdmission {
    connection: Arc<BoundSseConnection>,
    epoch: u64,
}
impl BoundRasterAdmission {
    fn validate(&self, handle: &WebSurfaceHandle, shared: &Shared) -> Result<(), String> {
        self.connection
            .validate_owner(&handle.shared, shared, self.epoch)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundFence {
    client_id: String,
    epoch: String,
    connection_token: String,
}
struct Wire {
    fence: BoundFence,
    messages: Vec<BridgeEnvelope>,
}

pub(super) fn valid_client_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
}

pub(super) fn error_code(message: &str) -> &str {
    message
        .split(':')
        .next()
        .filter(|code| code.starts_with("ERR_"))
        .unwrap_or("ERR_ENGINE")
}

fn decode_envelope(value: Value) -> Result<BridgeEnvelope, String> {
    let fields = value
        .as_object()
        .ok_or("ERR_PROTOCOL_VERSION: envelope must be an object")?;
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            "protocolVersion"
                | "sessionId"
                | "requestId"
                | "kind"
                | "op"
                | "cancelToken"
                | "deadlineNs"
                | "traceId"
                | "payload"
        )
    }) {
        return Err("ERR_PROTOCOL_VERSION: unknown or per-message preview fields".into());
    }
    serde_json::from_value(value)
        .map_err(|_| "ERR_PROTOCOL_VERSION: invalid strict bridge envelope".into())
}

fn parse(body: &[u8]) -> Result<Wire, String> {
    if body.len() > MAX_BRIDGE_QUEUE_BYTES {
        return Err("ERR_RENDER: strict bridge byte budget exceeded".into());
    }
    let mut value: Value = serde_json::from_slice(body)
        .map_err(|_| "ERR_PROTOCOL_VERSION: invalid strict bridge JSON")?;
    let object = value
        .as_object_mut()
        .ok_or("ERR_PROTOCOL_VERSION: strict bridge requires an object")?;
    let fence: BoundFence = serde_json::from_value(
        object
            .remove("preview")
            .ok_or("ERR_PERMISSION_DENIED: bound preview is required")?,
    )
    .map_err(|_| "ERR_PROTOCOL_VERSION: invalid bound preview fence")?;
    if !valid_client_id(&fence.client_id) || fence.connection_token.len() > 85 {
        return Err("ERR_PROTOCOL_VERSION: invalid bound preview fence".into());
    }
    super::preview::decimal(&fence.epoch)?;
    let messages = if let Some(messages) = object.remove("messages") {
        if !object.is_empty() {
            return Err("ERR_PROTOCOL_VERSION: unexpected batch fields".into());
        }
        let messages = messages
            .as_array()
            .ok_or("ERR_PROTOCOL_VERSION: batch messages must be an array")?;
        if messages.len() > MAX_MESSAGES {
            return Err("ERR_PROTOCOL_VERSION: strict bridge batch count exceeded".into());
        }
        messages
            .iter()
            .cloned()
            .map(decode_envelope)
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![decode_envelope(value)?]
    };
    if messages.is_empty() || messages.len() > MAX_MESSAGES {
        return Err("ERR_PROTOCOL_VERSION: strict bridge batch count exceeded".into());
    }
    let mut request_ids = std::collections::BTreeSet::new();
    for message in &messages {
        if message.kind != EnvelopeKind::Request
            || message.protocol_version != "1.0"
            || message.request_id.is_empty()
            || message.request_id.len() > 256
            || message.session_id.is_empty()
            || message.session_id.len() > MAX_FRAME_SESSION_BYTES
            || message
                .trace_id
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || message
                .cancel_token
                .as_ref()
                .is_some_and(|value| value.len() > 256)
            || !request_ids.insert(&message.request_id)
        {
            return Err(
                "ERR_PROTOCOL_VERSION: strict bridge requires a correlated version1.0 request"
                    .into(),
            );
        }
        if !matches!(
            message.op.as_str(),
            ACK_OP | op::EVENT_BATCH | op::DIAGNOSTIC
        ) {
            return Err(
                "ERR_UNSUPPORTED_CAPABILITY: operation is unavailable in ticketed-raster-v1".into(),
            );
        }
    }
    let minimal = BridgeBatch::new(messages.iter().map(reply_budget_failure).collect());
    if serde_json::to_vec(&minimal)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_FINAL_BYTES / 2
    {
        return Err(
            "ERR_RENDER: minimal correlated final exceeds its reserved event budget".into(),
        );
    }
    drop(request_ids);
    Ok(Wire { fence, messages })
}

fn response(request: &BridgeEnvelope, payload: Value) -> BridgeEnvelope {
    let mut response = BridgeEnvelope::request(
        &request.session_id,
        &request.request_id,
        &request.op,
        payload,
    );
    response.kind = EnvelopeKind::Response;
    response.trace_id = request.trace_id.clone();
    response
}

fn committed_ack_response(
    request: &BridgeEnvelope,
    mut payload: Value,
    effects: &BridgeBatch,
) -> BridgeEnvelope {
    let errors = || {
        effects
            .messages
            .iter()
            .filter(|effect| effect.op == op::ERROR)
    };
    // Raw JS diagnostics can precede the typed failure that stops a turn.
    // Preserve that terminal error and its restart requirement in the final.
    let diagnostic = errors()
        .find(|effect| {
            effect.payload["error"].is_object() && effect.payload["requiresRestart"] == true
        })
        .or_else(|| errors().find(|effect| effect.payload["error"].is_object()))
        .or_else(|| errors().next());
    if let Some(diagnostic) = diagnostic {
        payload["ok"] = json!(false);
        payload["committed"] = json!(true);
        payload["error"] = diagnostic
            .payload
            .get("error")
            .filter(|error| error.is_object())
            .cloned()
            .unwrap_or_else(|| {
                json!({"code":"ERR_ENGINE","message":"A committed presentation effect failed; inspect the original runtime diagnostics"})
            });
        payload["error"]["request_id"] = json!(request.request_id);
        for field in ["phase", "frameId"] {
            if let Some(value) = diagnostic.payload.get(field) {
                payload[field] = value.clone();
            }
        }
        if errors().any(|effect| effect.payload["requiresRestart"] == true) {
            payload["requiresRestart"] = json!(true);
            payload["inputEnabled"] = json!(false);
        }
    }
    response(request, payload)
}

fn reply_budget_failure(request: &BridgeEnvelope) -> BridgeEnvelope {
    response(
        request,
        json!({"ok":false,"operationMayHaveCommitted":true,
        "error":{"code":"ERR_RENDER","message":"Strict Raster final exceeded its transport budget; inspect the original runtime trace and traceSummary for committed effects and any retention loss"}}),
    )
}
fn rejection(request: &BridgeEnvelope, message: &str) -> BridgeEnvelope {
    let code = error_code(message);
    response(
        request,
        json!({"ok":false,"error":{"code":code,"message":message}}),
    )
}
fn ticket(message: &BridgeEnvelope) -> Result<DevRasterPresentationTicket, String> {
    serde_json::from_value(
        message
            .payload
            .get("presentationTicket")
            .cloned()
            .ok_or("ERR_CANCELLED: exact presentation ticket is required")?,
    )
    .map_err(|_| "ERR_PROTOCOL_VERSION: invalid presentation ticket".into())
}

fn require_raster_routes(
    manifest: &container_ir::ContainerManifestV1,
    override_profile: Option<container_ir::RendererProfile>,
) -> Result<(), SimulatorError> {
    if override_profile == Some(container_ir::RendererProfile::WebView)
        || (override_profile.is_none()
            && manifest.routes.iter().any(|route| {
                manifest.renderer_profile_for_route(&route.path)
                    == container_ir::RendererProfile::WebView
            }))
    {
        return Err(SimulatorError::Config(
            "ERR_UNSUPPORTED_CAPABILITY: strict Raster HTTP cannot own WebView routes".into(),
        ));
    }
    Ok(())
}

impl WebSurface {
    fn enable_strict_raster(&mut self) -> Result<(), String> {
        if self.bridge_handler.is_some() || self.local_bridge_handler.is_some() {
            return Err(
                "ERR_UNSUPPORTED_CAPABILITY: legacy callbacks cannot own strict Raster HTTP".into(),
            );
        }
        self.enable_sse_preview_binding()?;
        self.shared
            .lock()
            .map_err(|_| "Web surface unavailable")?
            .strict_raster = true;
        Ok(())
    }
    pub(super) fn queue_strict_raster_bridge(
        &mut self,
        stream: &mut TcpStream,
        body: &[u8],
    ) -> io::Result<()> {
        let result = (|| -> Result<(), String> {
            if self.bridge_handler.is_some() || self.local_bridge_handler.is_some() {
                return Err("ERR_UNSUPPORTED_CAPABILITY: legacy callbacks cannot process strict Raster requests".into());
            }
            let wire = parse(body)?;
            let epoch = super::preview::decimal(&wire.fence.epoch)?;
            // Construct and release parsed payload allocations outside the Web lock.
            let queued = QueuedBridgeRequest {
                body: body.to_vec(),
                preview: None,
            };
            drop(wire.messages);
            let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
            let connection = shared.capture_bound_owner(
                &self.shared,
                &wire.fence.client_id,
                epoch,
                &wire.fence.connection_token,
            )?;
            if shared.bridge_requests.len() >= MAX_BRIDGE_REQUESTS
                || shared
                    .bridge_requests
                    .iter()
                    .map(|entry| entry.request.body.len())
                    .sum::<usize>()
                    .saturating_add(queued.body.len())
                    > MAX_BRIDGE_QUEUE_BYTES
            {
                return Err("ERR_RENDER: bridge queue budget exceeded".into());
            }
            shared.bridge_requests.push_back(QueuedWebBridgeRequest {
                request: queued,
                strict: Some(BoundRasterAdmission { connection, epoch }),
            });
            Ok(())
        })();
        let (status, value) = match result {
            Ok(()) => (202, json!({"queued":true})),
            Err(message) => {
                let code = error_code(&message);
                let status = if code == "ERR_RENDER" {
                    503
                } else if code == "ERR_PROTOCOL_VERSION" {
                    400
                } else {
                    409
                };
                (
                    status,
                    json!({"ok":false,"error":{"code":code,"message":message}}),
                )
            }
        };
        self.queue_response(
            stream,
            status,
            "application/json",
            &serde_json::to_vec(&value).map_err(io::Error::other)?,
        )
    }
}

/// Closed owner lane for one explicitly selected developer Raster session.
/// No mutable runtime, raw surface, queue or legacy callback escapes this API.
/// Browser modules and an actual connection/RAF consumer remain separate assets.
pub struct DevRasterWebSession {
    simulator: Simulator,
    surface: Option<WebSurface>,
    handle: WebSurfaceHandle,
    url: String,
}

impl DevRasterWebSession {
    pub fn bind_from_pack_dir(
        path: impl AsRef<Path>,
        config: SimulatorConfig,
        host: IpAddr,
        port: u16,
    ) -> Result<Self, SimulatorError> {
        if config.session_id.len() > MAX_BASE_SESSION_BYTES {
            return Err(SimulatorError::Config("ERR_PROTOCOL_VERSION: strict base session id leaves no bounded restart identity budget".into()));
        }
        if config.page_render_mode != container_render_skia::PageRenderMode::Raster {
            return Err(SimulatorError::Config(
                "ERR_UNSUPPORTED_CAPABILITY: strict Raster HTTP requires explicit Raster mode"
                    .into(),
            ));
        }
        let mut simulator = Simulator::from_dev_raster_pack_dir(path, config)?;
        require_raster_routes(&simulator.manifest, simulator.config.renderer_override)?;
        simulator.set_trace_retention(crate::TraceRetention::development());
        let mut surface = WebSurface::bind(host, port)?;
        surface
            .enable_strict_raster()
            .map_err(SimulatorError::Config)?;
        let handle = surface.handle();
        handle.set_presentation(json!({"schemaVersion":1,"revision":0,"generation":1,
            "logicalWidth":simulator.viewport().width as u32,"logicalHeight":simulator.viewport().height as u32,
            "renderScale":simulator.render_scale(),"effectiveScale":simulator.render_scale(),"fps":60}));
        simulator.run()?;
        if simulator.current_renderer_profile() == container_ir::RendererProfile::WebView {
            return Err(SimulatorError::Config(
                "ERR_UNSUPPORTED_CAPABILITY: strict Raster HTTP cannot present a WebView route"
                    .into(),
            ));
        }
        let url = surface.url();
        let mut owner = Self {
            simulator,
            surface: Some(surface),
            handle,
            url,
        };
        let startup_errors = owner.simulator.take_dev_errors();
        if !startup_errors.messages.is_empty() {
            owner
                .publish_final(startup_errors, &[])
                .map_err(SimulatorError::Config)?;
        }
        owner.publish_state("ready");
        Ok(owner)
    }
    pub fn url(&self) -> &str {
        &self.url
    }
    pub fn state(&self) -> Value {
        self.handle.state()
    }
    pub fn trace(&self) -> Vec<Value> {
        self.simulator.trace()
    }
    pub fn trace_summary(&self) -> crate::TraceSummary {
        self.simulator.trace_summary()
    }
    /// Drain control diagnostics retained by the original runtime, including
    /// a failed shutdown retirement. This accepts no arbitrary app operation.
    pub fn drain_diagnostics(&mut self) -> Result<BridgeBatch, String> {
        self.simulator
            .dispatch_request(op::DIAGNOSTIC, json!({}))
            .map_err(|error| error.to_string())
    }
    pub fn wait(&mut self, timeout: Duration) -> io::Result<()> {
        self.surface
            .as_mut()
            .ok_or_else(|| io::Error::other("strict Raster owner is stopped"))?
            .wait(timeout)
    }
    pub fn apply_dev_pack(
        &mut self,
        path: impl AsRef<Path>,
    ) -> Result<crate::DevReloadKind, SimulatorError> {
        if self.surface.is_none() {
            return Err(SimulatorError::Config(
                "ERR_CANCELLED: strict Raster owner is stopped".into(),
            ));
        }
        let path = path.as_ref();
        let candidate = crate::read_validated_pack(path)?;
        require_raster_routes(&candidate.manifest, self.simulator.config.renderer_override)?;
        drop(candidate);
        let before = self.simulator.trace_summary().total_records;
        let applied = self.simulator.apply_dev_pack(path);
        // apply_dev_pack returns a REPORT, not a batch. Its actual startup,
        // in-place render and retirement effects are already recorded at their
        // original dispatch boundaries; forward only that new trace suffix.
        self.publish_trace_effects_since(before)
            .map_err(SimulatorError::Config)?;
        // Startup/reload errors were just forwarded through their original
        // trace suffix. Release the compatibility copy without publishing it
        // a second time or accumulating it in a long-running owner.
        drop(self.simulator.take_dev_errors());
        let (kind, report) = applied?;
        self.publish_notice(
            "reload",
            json!({"schemaVersion":1,"kind":kind,"report":report}),
        )
        .map_err(SimulatorError::Config)?;
        self.publish_state("ready");
        self.publish_frame().map_err(SimulatorError::Config)?;
        Ok(kind)
    }
    /// Poll actual sockets, retire old authority, execute bounded owner work,
    /// advance timers/render, and jointly publish the latest accepted picture.
    pub fn poll(&mut self, now_ns: u64, allow_render: bool) -> Result<usize, String> {
        self.surface
            .as_mut()
            .ok_or("ERR_CANCELLED: strict Raster owner is stopped")?
            .poll()
            .map_err(|error| error.to_string())?;
        let mut retired_effects = Vec::new();
        let retired = self.handle.resolve_preview_controls(|retirement| {
            let batch = self
                .simulator
                .retire_dev_preview(retirement.reason())
                .map_err(|error| error.to_string())?;
            retired_effects.extend(batch.messages);
            Ok(())
        });
        if !retired_effects.is_empty() {
            self.publish_final(BridgeBatch::new(retired_effects), &[])?;
        }
        retired?;
        let mut count = 0;
        for _ in 0..REQUESTS_PER_TURN {
            let queued = {
                self.handle
                    .shared
                    .lock()
                    .map_err(|_| "Web surface unavailable")?
                    .bridge_requests
                    .pop_front()
            };
            let Some(queued) = queued else {
                break;
            };
            let wire = parse(&queued.request.body)?;
            let admission = queued
                .strict
                .as_ref()
                .ok_or("ERR_PERMISSION_DENIED: unbound request reached strict owner")?;
            let mut batch = BridgeBatch::new(Vec::with_capacity(wire.messages.len()));
            for message in &wire.messages {
                let result = self.execute(admission, message);
                let response = match result {
                    Ok(response) => response,
                    Err(error) => BridgeBatch::new(vec![rejection(message, &error)]),
                };
                if message.op == ACK_OP {
                    self.simulator.trace.push(message, &response);
                }
                batch.messages.extend(response.messages);
                count += 1;
            }
            self.publish_final(batch, &wire.messages)?;
            // queued body/parsed payload destruction happens outside Web mutex.
        }
        let batch = self
            .simulator
            .pump_with_render(now_ns, allow_render)
            .map_err(|error| error.to_string())?;
        if !batch.messages.is_empty() {
            self.publish_final(batch, &[])?;
        }
        self.publish_state("ready");
        self.publish_frame()?;
        // No further socket admission here; the next poll flushes small SSE
        // responses/notices in their original ordering and bounded write budget.
        Ok(count)
    }
    pub fn shutdown(&mut self) -> Result<BridgeBatch, String> {
        // Close actual sockets/listener even when a runtime cancellation fails.
        // The retained handle aliases the ORIGINAL ledger for a retry.
        drop(self.surface.take());
        let mut messages = Vec::new();
        let queued = {
            std::mem::take(
                &mut self
                    .handle
                    .shared
                    .lock()
                    .map_err(|_| "Web surface unavailable")?
                    .bridge_requests,
            )
        };
        drop(queued);
        let result = self.handle.resolve_preview_controls(|retirement| {
            let batch = self
                .simulator
                .retire_dev_preview(retirement.reason())
                .map_err(|error| error.to_string())?;
            messages.extend(batch.messages);
            Ok(())
        });
        if let Err(error) = result {
            self.publish_state("error");
            return Err(error);
        }
        self.publish_state("stopped");
        Ok(BridgeBatch::new(messages))
    }
    fn publish_state(&mut self, status: &str) {
        let page = self
            .simulator
            .host()
            .session()
            .and_then(|session| session.app_service().pages().current())
            .map(|page| page.id.0.to_string());
        let (generation, preview) = {
            let Ok(shared) = self.handle.shared.lock() else {
                return;
            };
            (
                shared.presentation["generation"]
                    .as_u64()
                    .unwrap_or(0)
                    .to_string(),
                shared.preview.preview_value(),
            )
        };
        let state = json!({"schemaVersion":1,"status":status,"sessionId":self.simulator.session_id(),
            "webRenderer":"software","renderer":"skia","gpuSurface":false,
            "preview":preview,
            "devRaster":{"profile":"ticketed-raster-v1","protocolVersion":"1.0","binaryFrameVersion":2,
                "ackOp":ACK_OP,"connectionInitEvent":"preview-init",
                "binding":{"sessionId":self.simulator.session_id(),"pageId":page,"configGeneration":generation}}});
        // State is latest-value notification here; publication is bounded by
        // the same replay store and its evicted owners release after unlock.
        let mut retired = Vec::with_capacity(MAX_EVENTS);
        let mut old_state = None;
        let replacement = state.clone();
        if let Ok(mut shared) = self.handle.shared.lock() {
            if shared.state_override.as_ref() != Some(&state) {
                old_state = shared.state_override.replace(replacement);
                shared.publish_with_retirement("state".into(), state, Some(&mut retired));
            }
        }
        drop(retired);
        drop(old_state);
    }
    fn publish_final(&self, batch: BridgeBatch, requests: &[BridgeEnvelope]) -> Result<(), String> {
        let mut value = serde_json::to_value(batch).map_err(|error| error.to_string())?;
        if serde_json::to_vec(&value)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_FINAL_BYTES
        {
            // The operation already settled in the original runtime. Its
            // effects were recorded at the original boundary; do not pretend
            // rollback, silently replace correlation or retry the VM turn.
            let mut messages: Vec<_> = requests.iter().map(reply_budget_failure).collect();
            messages.push(BridgeEnvelope::event(self.simulator.session_id(),op::DIAGNOSTIC,
                json!({"code":"ERR_RENDER","operationMayHaveCommitted":true,
                    "message":"Strict Raster effects exceeded the final event budget; inspect original trace retention coverage",
                    "traceSummary":self.simulator.trace_summary()})));
            value = serde_json::to_value(BridgeBatch::new(messages))
                .map_err(|error| error.to_string())?;
            if serde_json::to_vec(&value)
                .map_err(|error| error.to_string())?
                .len()
                > MAX_FINAL_BYTES
            {
                return Err(
                    "ERR_RENDER: prevalidated final correlation budget was violated".into(),
                );
            }
        }
        self.publish_notice("bridge", value)
    }
    fn publish_notice(&self, kind: &str, value: Value) -> Result<(), String> {
        let mut retired = Vec::with_capacity(MAX_EVENTS);
        {
            self.handle
                .shared
                .lock()
                .map_err(|_| "Web surface unavailable")?
                .publish_with_retirement(kind.into(), value, Some(&mut retired));
        }
        drop(retired);
        Ok(())
    }
    fn publish_trace_effects_since(&self, since: u64) -> Result<(), String> {
        #[derive(Deserialize)]
        struct RecordedEffects {
            response: BridgeBatch,
        }
        let mut observed = 0_u64;
        for record in self
            .simulator
            .trace
            .records
            .iter()
            .filter(|record| record.sequence > since)
        {
            let effects: RecordedEffects =
                serde_json::from_slice(&record.bytes).map_err(|error| error.to_string())?;
            if !effects.response.messages.is_empty() {
                self.publish_final(effects.response, &[])?;
            }
            observed += 1;
        }
        let summary = self.simulator.trace_summary();
        let expected = summary.total_records.saturating_sub(since);
        if observed != expected {
            self.publish_notice("diagnostic",json!({"schemaVersion":1,"code":"ERR_RENDER",
                "operationMayHaveCommitted":true,"message":"Reload effect suffix was truncated by original runtime trace retention; complete delivery is unavailable",
                "expectedRecords":expected,"availableRecords":observed,"traceSummary":summary}))?;
        }
        Ok(())
    }
    fn publish_frame(&mut self) -> Result<bool, String> {
        if let Some(fault) = self
            .simulator
            .host()
            .session()
            .and_then(|session| session.execution_fault())
        {
            return Err(fault.to_string());
        }
        // Navigation or data invalidation can precede the next scheduled
        // layout. Retain the last picture for diagnostics, without reissuing
        // it as a current page or restoring its revoked input authority.
        if self.simulator.current_renderer_profile() != container_ir::RendererProfile::WebView
            && !self.simulator.has_current_skia_scene()
        {
            return Ok(false);
        }
        let fence = {
            let shared = self
                .handle
                .shared
                .lock()
                .map_err(|_| "Web surface unavailable")?;
            let Some(client_id) = shared.preview.owner.clone() else {
                return Ok(false);
            };
            PreviewFence {
                client_id,
                epoch: shared.preview.epoch.to_string(),
                request_revision: None,
            }
        };
        let owner = match self.handle.capture_preview_owner(&fence) {
            Ok(owner) => owner,
            // The actual socket can end, or its lease can expire, after the
            // control drain above. No live owner is normal pending work: the
            // next owner poll consumes its ORIGINAL retirement control.
            Err(error) if error_code(&error) == "ERR_CANCELLED" => return Ok(false),
            Err(error) => return Err(error),
        };
        let generation = self.handle.presentation()["generation"]
            .as_u64()
            .ok_or("ERR_RENDER: configuration generation unavailable")?;
        match self
            .simulator
            .publish_dev_raster_frame(&self.handle, &owner, generation)
        {
            Err(error)
                if error_code(&error) == "ERR_CANCELLED"
                    && self
                        .handle
                        .validate_preview_owner(&owner)
                        .is_err_and(|current| error_code(&current) == "ERR_CANCELLED") =>
            {
                Ok(false)
            }
            result => result,
        }
    }
    fn execute(
        &mut self,
        admission: &BoundRasterAdmission,
        message: &BridgeEnvelope,
    ) -> Result<BridgeBatch, String> {
        let ticket = ticket(message)?;
        self.validate(admission, message, &ticket)?;
        if message.op == ACK_OP {
            if message.deadline_ns.is_some() || message.cancel_token.is_some() {
                return Err(
                    "ERR_UNSUPPORTED_CAPABILITY: ACK scheduling metadata is unsupported".into(),
                );
            }
            let draw = message
                .payload
                .get("draw")
                .and_then(Value::as_object)
                .ok_or("ERR_PROTOCOL_VERSION: RAF draw endpoint is required")?;
            if draw.len() != 1
                || draw.get("endpoint") != Some(&json!("canvas2d-raf-draw-return"))
                || message
                    .payload
                    .as_object()
                    .is_none_or(|payload| payload.len() != 2)
            {
                return Err("ERR_PROTOCOL_VERSION: invalid RAF draw endpoint".into());
            }
            let mut batch = self
                .simulator
                .host_mut()
                .session_mut()
                .ok_or("ERR_ENGINE: session is not loaded")?
                .acknowledge_dev_raster_presentation(&ticket)
                .map_err(|error| error.to_string())?;
            let input_enabled = self.validate(admission, message, &ticket).is_ok()
                && self
                    .simulator
                    .host()
                    .session()
                    .is_some_and(|session| session.is_current_frame_presented());
            let payload =
                json!({"ok":true,"presentationTicket":ticket,"inputEnabled":input_enabled});
            // The exact publication has already committed when native ACK
            // returns a batch. Ready/observer hooks can still fail afterward.
            // Correlate that failure without dropping the original effects,
            // rolling back presentation authority or replaying the native turn.
            let final_response = committed_ack_response(message, payload, &batch);
            batch.messages.insert(0, final_response);
            Ok(batch)
        } else {
            if message.op == op::EVENT_BATCH {
                if !self
                    .simulator
                    .host()
                    .session()
                    .is_some_and(|session| session.is_current_frame_presented())
                {
                    return Err(
                        "ERR_CANCELLED: input requires an acknowledged exact presentation".into(),
                    );
                }
                let viewport = &message.payload["logicalViewport"];
                if viewport["width"].as_u64() != Some(u64::from(ticket.target.logical_width))
                    || viewport["height"].as_u64() != Some(u64::from(ticket.target.logical_height))
                {
                    return Err(
                        "ERR_CANCELLED: input viewport differs from its presentation ticket".into(),
                    );
                }
            }
            let mut request = message.clone();
            request
                .payload
                .as_object_mut()
                .ok_or("ERR_PROTOCOL_VERSION: payload must be an object")?
                .remove("presentationTicket");
            self.simulator
                .dispatch(request)
                .map_err(|error| error.to_string())
        }
    }
    fn validate(
        &self,
        admission: &BoundRasterAdmission,
        message: &BridgeEnvelope,
        ticket: &DevRasterPresentationTicket,
    ) -> Result<(), String> {
        let value = serde_json::to_value(ticket).map_err(|error| error.to_string())?;
        {
            let shared = self
                .handle
                .shared
                .lock()
                .map_err(|_| "Web surface unavailable")?;
            admission.validate(&self.handle, &shared)?;
            if !shared.frame.as_ref().is_some_and(|frame| {
                frame.metadata["schemaVersion"] == 2
                    && frame.metadata["presentationTicket"] == value
            }) {
                return Err(
                    "ERR_CANCELLED: ticket is not the immutable current Web publication".into(),
                );
            }
        }
        let session = self
            .simulator
            .host()
            .session()
            .ok_or("ERR_ENGINE: session is not loaded")?;
        if message.session_id != self.simulator.session_id()
            || session.current_dev_raster_presentation_ticket() != Some(ticket)
        {
            return Err("ERR_CANCELLED: ticket is not current in the original runtime".into());
        }
        Ok(())
    }
}

impl Drop for DevRasterWebSession {
    fn drop(&mut self) {
        // Explicit shutdown delivers cancellation effects. Fallback Drop only
        // closes owned sockets before fields release the original runtime; it
        // does not execute arbitrary application code during unwinding.
        drop(self.surface.take());
    }
}

#[cfg(test)]
#[path = "web_strict_raster_tests.rs"]
mod tests;
