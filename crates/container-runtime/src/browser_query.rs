//! Asynchronous SelectorQuery over an authoritative evaluated document and a
//! fresh observation of its exact currently visible browser presentation.
//! Measurements never replace input geometry or invoke the View evaluator.
use super::*;
use crate::view_query::{ViewDocumentQuery, ViewQueryNode};
use crate::view_topology::{ViewTopology, ViewTopologyNode};
use container_ir::{
    BrowserGeometryBatch, BrowserNodeGeometry, PresentationKey, ViewPoint, ViewRect, ViewSize,
};

const VERSION: &str = "1.0";
const MAX_PENDING: usize = 32;
const MAX_OPERATIONS: usize = 256;
const MAX_MATCHES: usize = 100_000;
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_PENDING_BYTES: usize = 1024 * 1024;
const DEFAULT_TIMEOUT_NS: u64 = 5_000_000_000;

#[derive(Default)]
pub(super) struct BrowserQueryState {
    lease: Option<QueryLease>,
    sequence: u64,
    pending: BTreeMap<String, PendingQuery>,
    waiting: VecDeque<WaitingQuery>,
    bytes: usize,
    completions: VecDeque<(u64, BridgeError)>,
    // Independent from input geometry. Retain even across a same-key lease
    // renegotiation so a fresh request cannot replay a prior observation.
    measurement_epoch: Option<(PresentationKey, u64)>,
}

impl BrowserQueryState {
    fn accepted_measurement_epoch(&self, key: &PresentationKey) -> u64 {
        self.measurement_epoch
            .as_ref()
            .filter(|(measured_key, _)| measured_key == key)
            .map_or(0, |(_, epoch)| *epoch)
    }
}

enum QueryLease {
    /// Only a real Worker recipient negotiates this before application code.
    Session,
    /// Remote previews negotiate after ACK; ownership cannot cross a new key.
    Presentation(PresentationKey),
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct QueryOwner {
    pub(super) page_id: String,
    pub(super) scope_id: Option<String>,
}

struct QueryOperation {
    all: bool,
    operation: String,
    fields: Option<SelectorFields>,
    /// None denotes the synthetic page/viewport boundary, never a DOM id.
    matches: Vec<Option<String>>,
}

struct PendingQuery {
    api_id: u64,
    key: PresentationKey,
    owner: QueryOwner,
    after_epoch: u64,
    limits: QueryLimits,
    operations: Vec<QueryOperation>,
    bytes: usize,
}

/// A negotiated Worker may call exec during onLoad, before a document has a
/// presentation key. This captures the original lifecycle fence, never a
/// guessed future key. Timers continue while the first real ACK is pending.
struct WaitingQuery {
    api_id: u64,
    owner: QueryOwner,
    input_lifetime: u64,
    options: Map<String, Value>,
    limits: QueryLimits,
    bytes: usize,
}

/// Captured once in the originating bridge turn. Promotion after a first ACK
/// keeps both explicit and originating cancellation fences and the same
/// absolute deadline, independent of the ACK/result transport's own limits.
pub(super) struct QueryLimits {
    pub(super) deadline_ns: u64,
    cancel_tokens: Vec<String>,
}

impl QueryLimits {
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn bytes(&self) -> usize {
        self.cancel_tokens.iter().map(String::len).sum()
    }

    pub(super) fn is_cancelled(&self, session: &Session) -> bool {
        self.cancel_tokens
            .iter()
            .any(|token| session.is_cancelled(token))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryEnable {
    version: String,
    scope: String,
    key: Option<PresentationKey>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryResult {
    version: String,
    request_id: String,
    key: PresentationKey,
    geometry: Option<BrowserGeometryBatch>,
    viewport_scroll: Option<ViewPoint>,
    viewport_extent: Option<ViewSize>,
    error: Option<QueryFailure>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryFailure {
    code: String,
    message: String,
}

fn cancelled(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

fn unsupported(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::UnsupportedCapability, message)
}

fn canonical_u64(value: &str, name: &str) -> Result<u64, BridgeError> {
    let parsed = value.parse::<u64>().map_err(|_| {
        BridgeError::invalid(format!("{name} must be a canonical u64 decimal string"))
    })?;
    if parsed.to_string() != value {
        return Err(BridgeError::invalid(format!("{name} must be canonical")));
    }
    Ok(parsed)
}

impl Session {
    pub(super) fn browser_queries_enabled(&self) -> bool {
        self.config.browser_view_enabled
            && match &self.browser_queries.lease {
                Some(QueryLease::Session) => true,
                Some(QueryLease::Presentation(key)) => self
                    .browser_query_snapshot()
                    .is_ok_and(|(submission, _, _)| &submission.key == key),
                None => false,
            }
    }

    /// Invalidation is pure: cancellation callbacks run at the next normal
    /// owner-thread effect drain, never inside a layout/presentation getter.
    pub(super) fn retire_browser_queries(&mut self, reason: &str) {
        for (_, pending) in std::mem::take(&mut self.browser_queries.pending) {
            self.browser_queries.bytes -= pending.bytes;
            self.browser_queries
                .completions
                .push_back((pending.api_id, cancelled(reason)));
        }
        if matches!(
            self.browser_queries.lease,
            Some(QueryLease::Presentation(_))
        ) {
            self.browser_queries.lease = None;
        }
    }

    pub(super) fn retire_browser_query_waiters(&mut self, reason: &str) {
        for waiting in self.browser_queries.waiting.drain(..) {
            self.browser_queries.bytes -= waiting.bytes;
            self.browser_queries
                .completions
                .push_back((waiting.api_id, cancelled(reason)));
        }
    }

    fn browser_query_owner_current(&self, owner: &QueryOwner) -> bool {
        let Ok(id) = canonical_u64(&owner.page_id, "query owner pageId") else {
            return false;
        };
        self.app_service.lifecycle().state() == container_core::LifecycleState::Active
            && self
                .app_service
                .pages()
                .current()
                .is_some_and(|page| page.id.0 == id)
            && owner.scope_id.as_deref().is_none_or(|scope| {
                self.component_pages
                    .get(&PageId(id))
                    .is_some_and(|page| page.contains_observer_scope(scope))
            })
    }

    fn browser_query_owner_live(&self, owner: &QueryOwner, key: &PresentationKey) -> bool {
        let Ok(id) = canonical_u64(&owner.page_id, "query owner pageId") else {
            return false;
        };
        id == key.page_id && self.browser_query_owner_current(owner)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn enqueue_browser_query_waiter(
        &mut self,
        api_id: u64,
        owner: QueryOwner,
        options: &Map<String, Value>,
        limits: QueryLimits,
    ) -> Result<(), BridgeError> {
        if !matches!(self.browser_queries.lease, Some(QueryLease::Session))
            || !self.browser_query_owner_current(&owner)
        {
            return Err(cancelled(
                "DOM query has no live owner/recipient while awaiting presentation",
            ));
        }
        let input_lifetime = self
            .input_lifetime_revision
            .ok_or_else(|| cancelled("DOM query input lifetime is exhausted"))?;
        let bytes = serde_json::to_vec(options)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len();
        let queries = options
            .get("queries")
            .and_then(Value::as_array)
            .ok_or_else(|| BridgeError::invalid("DOM query requires an exec operation batch"))?;
        if queries.is_empty() || queries.len() > MAX_OPERATIONS || bytes > MAX_REQUEST_BYTES {
            return Err(BridgeError::invalid(
                "DOM query waiting payload exceeds operation/byte budget",
            ));
        }
        let options = options.clone();
        let bytes = serde_json::to_vec(&options)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len()
            .saturating_add(limits.bytes())
            .saturating_add(owner.page_id.len())
            .saturating_add(owner.scope_id.as_ref().map_or(0, String::len));
        if bytes > MAX_REQUEST_BYTES
            || self.browser_queries.pending.len()
                + self.browser_queries.waiting.len()
                + self.browser_queries.completions.len()
                >= MAX_PENDING
            || self.browser_queries.bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "DOM query waiting queue exceeds its byte/count budget",
            ));
        }
        self.browser_queries.waiting.push_back(WaitingQuery {
            api_id,
            owner,
            input_lifetime,
            options,
            limits,
            bytes,
        });
        self.browser_queries.bytes += bytes;
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn selector_query_limits(
        &self,
        options: &Map<String, Value>,
    ) -> Result<QueryLimits, BridgeError> {
        let now = unix_now_ns();
        let requested = options
            .get("deadlineNs")
            .or_else(|| options.get("deadline_ns"))
            .map(|value| match value {
                Value::String(value) => canonical_u64(value, "deadlineNs"),
                _ => value
                    .as_u64()
                    .ok_or_else(|| BridgeError::invalid("deadlineNs must be u64")),
            })
            .transpose()?;
        let deadline = requested
            .unwrap_or(u64::MAX)
            .min(self.view_deadline_ns.get().unwrap_or(u64::MAX))
            .min(now.saturating_add(DEFAULT_TIMEOUT_NS));
        let explicit_cancel = options
            .get("cancelToken")
            .or_else(|| options.get("cancel_token"))
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| BridgeError::invalid("cancelToken must be a nonempty string"))
            })
            .transpose()?;
        let mut cancel_tokens = Vec::with_capacity(2);
        if let Some(token) = explicit_cancel {
            cancel_tokens.push(token);
        }
        if let Some(token) = &self.bridge_cancel_token {
            if !cancel_tokens.contains(token) {
                cancel_tokens.push(token.clone());
            }
        }
        if deadline <= now {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "DOM query deadline expired",
            ));
        }
        let limits = QueryLimits {
            deadline_ns: deadline,
            cancel_tokens,
        };
        if limits.is_cancelled(self) {
            return Err(cancelled("DOM query was cancelled"));
        }
        Ok(limits)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn enqueue_browser_query(
        &mut self,
        api_id: u64,
        owner: Option<&Value>,
        options: &Map<String, Value>,
    ) -> Result<(), BridgeError> {
        let limits = self.selector_query_limits(options)?;
        self.enqueue_browser_query_with_limits(api_id, owner, options, limits)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn enqueue_browser_query_with_limits(
        &mut self,
        api_id: u64,
        owner: Option<&Value>,
        options: &Map<String, Value>,
        limits: QueryLimits,
    ) -> Result<(), BridgeError> {
        if self.effective_capability("wx.createSelectorQuery") == CapabilitySupport::Unsupported {
            return Err(unsupported(
                "no negotiated DOM query recipient for this presentation",
            ));
        }
        let owner: QueryOwner = serde_json::from_value(
            owner
                .cloned()
                .ok_or_else(|| cancelled("DOM query has no engine-captured owner"))?,
        )
        .map_err(|error| BridgeError::invalid(format!("invalid DOM query owner: {error}")))?;
        canonical_u64(&owner.page_id, "query owner pageId")?;
        if owner
            .scope_id
            .as_ref()
            .is_some_and(|scope| scope.trim().is_empty())
        {
            return Err(BridgeError::invalid("query owner scopeId cannot be empty"));
        }
        if self.browser_query_snapshot().is_err() {
            return self.enqueue_browser_query_waiter(api_id, owner, options, limits);
        }
        let (submission, _, admitted) = self.browser_query_snapshot()?;
        if !self.browser_query_owner_live(&owner, &submission.key) {
            return Err(cancelled("DOM query owner is no longer current and live"));
        }
        let key = submission.key.clone();
        if key.session_id.len() > 256 {
            return Err(BridgeError::invalid(
                "DOM query session id exceeds the browser contract",
            ));
        }
        let after_epoch = admitted
            .epoch
            .max(self.browser_queries.accepted_measurement_epoch(&key));
        let queries = options
            .get("queries")
            .and_then(Value::as_array)
            .ok_or_else(|| BridgeError::invalid("DOM query requires an exec operation batch"))?;
        if queries.is_empty() || queries.len() > MAX_OPERATIONS {
            return Err(BridgeError::invalid(
                "DOM query must contain 1..=256 operations",
            ));
        }
        let request_bytes = serde_json::to_vec(options)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len();
        if request_bytes > MAX_REQUEST_BYTES {
            return Err(BridgeError::invalid(
                "DOM query payload exceeds its byte budget",
            ));
        }
        let query = ViewDocumentQuery::from_document(&submission.document)
            .map_err(|error| BridgeError::invalid(error.to_string()))?;
        let mut operations = Vec::with_capacity(queries.len());
        let mut ids = BTreeSet::new();
        let mut matched = 0usize;
        let mut bytes = request_bytes.saturating_add(limits.bytes());
        for value in queries {
            let value = value
                .as_object()
                .ok_or_else(|| BridgeError::invalid("query operation must be an object"))?;
            let target = value
                .get("target")
                .and_then(Value::as_str)
                .unwrap_or("node");
            if !matches!(target, "node" | "viewport")
                || value.contains_key("queries")
                || value.contains_key("query")
            {
                return Err(BridgeError::invalid(
                    "invalid DOM query target or nested batch",
                ));
            }
            let operation = value
                .get("operation")
                .and_then(Value::as_str)
                .unwrap_or("boundingClientRect");
            if !matches!(operation, "boundingClientRect" | "scrollOffset" | "fields") {
                return Err(unsupported(
                    "DOM query node/context handles are not implemented",
                ));
            }
            let fields = parse_selector_fields(value.get("fields"))?;
            if fields.as_ref().is_some_and(|fields| {
                fields.node
                    || fields.context
                    || !fields.computed_style.is_empty()
                    || fields
                        .properties
                        .iter()
                        .any(|name| !matches!(name.as_str(), "id" | "class"))
            }) {
                return Err(unsupported("DOM query supports declaration id/class properties; computedStyle, node, context and live platform properties are not implemented"));
            }
            let all = value.get("all").and_then(Value::as_bool).unwrap_or(false);
            let scope = match value.get("scopeId") {
                None | Some(Value::Null) => None,
                Some(Value::String(scope)) if !scope.trim().is_empty() => Some(scope.as_str()),
                _ => {
                    return Err(BridgeError::invalid(
                        "query scopeId must be null or a nonempty string",
                    ))
                }
            };
            if scope.is_some_and(|scope| {
                !self
                    .component_pages
                    .get(&PageId(key.page_id))
                    .is_some_and(|page| page.contains_observer_scope(scope))
            }) {
                return Err(cancelled("DOM query selection scope has been detached"));
            }
            let matches = if target == "viewport" {
                vec![None]
            } else {
                let selector = value
                    .get("selector")
                    .and_then(Value::as_str)
                    .filter(|selector| !selector.trim().is_empty())
                    .ok_or_else(|| BridgeError::invalid("DOM node query requires selector"))?;
                query
                    .query(selector, all, scope)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?
                    .into_iter()
                    .map(|node| match node {
                        ViewQueryNode::Page(_) => None,
                        ViewQueryNode::Occurrence(node) => Some(node.occurrence_id().to_owned()),
                    })
                    .collect::<Vec<_>>()
            };
            matched = matched.saturating_add(matches.len());
            if matched > MAX_MATCHES {
                return Err(BridgeError::invalid("DOM query match budget exceeded"));
            }
            for id in matches.iter().flatten() {
                if id.len() > 1024 {
                    return Err(BridgeError::invalid(
                        "DOM query occurrence id exceeds the browser contract",
                    ));
                }
                bytes = bytes.saturating_add(id.len() + std::mem::size_of::<String>());
                ids.insert(id.clone());
            }
            operations.push(QueryOperation {
                all,
                operation: operation.into(),
                fields,
                matches,
            });
        }
        if self.browser_queries.pending.len()
            + self.browser_queries.waiting.len()
            + self.browser_queries.completions.len()
            >= MAX_PENDING
            || bytes > MAX_REQUEST_BYTES
            || self.browser_queries.bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "DOM query pending queue is full",
            ));
        }
        let sequence = self
            .browser_queries
            .sequence
            .checked_add(1)
            .ok_or_else(|| {
                BridgeError::new(BridgeErrorCode::Render, "DOM query sequence exhausted")
            })?;
        let request_id = format!("dom-query:{sequence}");
        let mut request_payload = json!({"version":VERSION,"requestId":request_id,"key":key,"afterEpoch":after_epoch.to_string(),
            "deadlineNs":limits.deadline_ns.to_string(),"occurrenceIds":ids});
        // Only the new extent-dependent operation asks for the additive field.
        // Older runtime requests keep their exact strict result envelope.
        if operations.iter().any(|operation| {
            operation.matches.iter().any(Option::is_none)
                && (operation.operation == "scrollOffset"
                    || operation
                        .fields
                        .as_ref()
                        .is_some_and(|fields| fields.scroll_offset))
        }) {
            request_payload["includeViewportExtent"] = json!(true);
        }
        let wire_bytes = serde_json::to_vec(&request_payload)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len();
        bytes = bytes
            .saturating_add(wire_bytes)
            .saturating_add(owner.page_id.len())
            .saturating_add(owner.scope_id.as_ref().map_or(0, String::len));
        if wire_bytes > MAX_REQUEST_BYTES
            || bytes > MAX_PENDING_BYTES
            || self.browser_queries.bytes.saturating_add(bytes) > MAX_PENDING_BYTES
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "DOM query serialized batch exceeds its byte budget",
            ));
        }
        self.browser_queries.pending.insert(
            request_id.clone(),
            PendingQuery {
                api_id,
                key: key.clone(),
                owner,
                after_epoch,
                limits,
                operations,
                bytes,
            },
        );
        self.browser_queries.sequence = sequence;
        self.browser_queries.bytes += bytes;
        self.queue_browser_retirement_message(BridgeEnvelope::event(
            self.config.session_id.clone(),
            op::VIEW_QUERY_REQUEST,
            request_payload,
        ));
        Ok(())
    }

    pub(super) fn handle_browser_query_operation(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        if request.op == op::VIEW_QUERY_ENABLE {
            let enable: QueryEnable = serde_json::from_value(request.payload.clone())
                .map_err(|error| BridgeError::invalid(error.to_string()))?;
            if enable.version != VERSION {
                return Err(BridgeError::protocol("unsupported DOM query contract"));
            }
            if !self.config.browser_view_enabled {
                return Err(unsupported("browser presentation is not enabled"));
            }
            let lease = match enable.scope.as_str() {
                "session" if !self.initialized && enable.key.is_none() => Some(QueryLease::Session),
                "presentation" => {
                    let (submission, _, _) = self.browser_query_snapshot()?;
                    if enable.key.as_ref() != Some(&submission.key) { return Err(cancelled("query recipient does not own the presented key")); }
                    Some(QueryLease::Presentation(submission.key.clone()))
                }
                "disabled" if enable.key.is_none() => None,
                _ => return Err(BridgeError::invalid("session query negotiation must precede app.init; presentation negotiation requires its exact key")),
            };
            self.retire_browser_queries("DOM query recipient changed");
            self.retire_browser_query_waiters("DOM query recipient changed");
            self.browser_queries.lease = lease;
            if self.initialized && self.engine_provider_available() {
                self.sync_engine_capabilities()?;
            }
            let mut messages = vec![self.response(request, json!({"ok":true,"version":VERSION,"scope":enable.scope,"enabled":self.browser_queries_enabled(),"key":enable.key}))];
            self.append_engine_effects(&mut messages)?;
            return Ok(messages);
        }
        self.ensure_initialized()?;
        let result: QueryResult = serde_json::from_value(request.payload.clone())
            .map_err(|error| BridgeError::invalid(format!("invalid DOM query result: {error}")))?;
        if result.version != VERSION {
            return Err(BridgeError::protocol(
                "unsupported DOM query result version",
            ));
        }
        let suffix = result
            .request_id
            .strip_prefix("dom-query:")
            .ok_or_else(|| BridgeError::invalid("invalid query requestId"))?;
        if canonical_u64(suffix, "query requestId")? == 0 {
            return Err(BridgeError::invalid("query requestId must be nonzero"));
        }
        let pending = self
            .browser_queries
            .pending
            .get(&result.request_id)
            .ok_or_else(|| cancelled("DOM query has already completed or retired"))?;
        if pending.key != result.key {
            return Err(cancelled("DOM query result key mismatch"));
        }
        let (submission, topology, _) = self.browser_query_snapshot()?;
        if submission.key != result.key
            || !self.browser_queries_enabled()
            || !self.browser_query_owner_live(&pending.owner, &pending.key)
        {
            return Err(cancelled("DOM query presentation or owner has retired"));
        }
        let (mut outcome, measured_epoch) = if pending.limits.deadline_ns <= unix_now_ns() {
            (
                Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "DOM query deadline expired",
                )),
                None,
            )
        } else if pending.limits.is_cancelled(self) {
            (Err(cancelled("DOM query was cancelled")), None)
        } else {
            match (
                result.geometry,
                result.viewport_scroll,
                result.viewport_extent,
                result.error,
            ) {
                (Some(geometry), Some(scroll), extent, None) => {
                    crate::browser_view::validate_geometry(submission, topology, &geometry)?;
                    scroll
                        .validate()
                        .map_err(|error| BridgeError::invalid(error.to_string()))?;
                    if let Some(extent) = extent {
                        extent
                            .validate()
                            .map_err(|error| BridgeError::invalid(error.to_string()))?;
                    }
                    if geometry.epoch
                        <= pending.after_epoch.max(
                            self.browser_queries
                                .accepted_measurement_epoch(&pending.key),
                        )
                    {
                        return Err(cancelled(
                            "DOM query measurement is not newer than its request and prior observations",
                        ));
                    }
                    (
                        Ok(project_query(pending, topology, &geometry, scroll, extent)?),
                        Some(geometry.epoch),
                    )
                }
                (None, None, None, Some(error)) => {
                    if error.message.len() > 4096 {
                        return Err(BridgeError::invalid("DOM query error exceeds byte budget"));
                    }
                    let code = match error.code.as_str() {
                        "ERR_RENDER" => BridgeErrorCode::Render,
                        "ERR_TIMEOUT" => BridgeErrorCode::Timeout,
                        "ERR_CANCELLED" => BridgeErrorCode::Cancelled,
                        "ERR_INVALID_REQUEST" => BridgeErrorCode::InvalidRequest,
                        _ => {
                            return Err(BridgeError::invalid(
                                "unsupported DOM query observation error",
                            ))
                        }
                    };
                    (Err(BridgeError::new(code, error.message)), None)
                }
                _ => {
                    return Err(BridgeError::invalid(
                        "DOM query result must contain geometry+viewportScroll or error",
                    ))
                }
            }
        };
        // A large batch may spend time validating/projecting its geometry.
        // Recheck the original fence at the atomic completion point, before
        // publishing a successful observation or entering application JS.
        if pending.limits.deadline_ns <= unix_now_ns() {
            outcome = Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "DOM query deadline expired",
            ));
        } else if pending.limits.is_cancelled(self) {
            outcome = Err(cancelled("DOM query was cancelled"));
        }
        // Validate the entire keyed batch first; then retire exactly once before
        // arbitrary application JS can navigate, detach or create another query.
        let pending = self
            .browser_queries
            .pending
            .remove(&result.request_id)
            .expect("validated pending query");
        self.browser_queries.bytes -= pending.bytes;
        if let (Ok(_), Some(epoch)) = (&outcome, measured_epoch) {
            self.browser_queries.measurement_epoch = Some((pending.key, epoch));
        }
        self.resolve_browser_query_api(pending.api_id, outcome)?;
        let mut messages =
            vec![self.response(request, json!({"ok":true,"requestId":result.request_id}))];
        self.append_engine_effects(&mut messages)?;
        Ok(messages)
    }

    fn sweep_browser_queries(&mut self) {
        let now = unix_now_ns();
        for waiting in std::mem::take(&mut self.browser_queries.waiting) {
            let error = if waiting.limits.deadline_ns <= now {
                Some(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "DOM query deadline expired before presentation",
                ))
            } else if !matches!(self.browser_queries.lease, Some(QueryLease::Session))
                || !self.browser_route_active()
                || self.input_lifetime_revision != Some(waiting.input_lifetime)
                || !self.browser_query_owner_current(&waiting.owner)
                || waiting.limits.is_cancelled(self)
            {
                Some(cancelled("DOM query waiting lifecycle/owner was retired"))
            } else {
                None
            };
            if let Some(error) = error {
                self.browser_queries.bytes -= waiting.bytes;
                self.browser_queries
                    .completions
                    .push_back((waiting.api_id, error));
            } else {
                self.browser_queries.waiting.push_back(waiting);
            }
        }
        let retired = self
            .browser_queries
            .pending
            .iter()
            .filter_map(|(id, pending)| {
                let error = if pending.limits.deadline_ns <= now {
                    Some(BridgeError::new(
                        BridgeErrorCode::Timeout,
                        "DOM query deadline expired",
                    ))
                } else if !self.browser_queries_enabled()
                    || !self.browser_query_owner_live(&pending.owner, &pending.key)
                    || !self
                        .browser_query_snapshot()
                        .is_ok_and(|(submission, _, _)| submission.key == pending.key)
                    || pending.limits.is_cancelled(self)
                {
                    Some(cancelled(
                        "DOM query owner, recipient or presentation retired",
                    ))
                } else {
                    None
                };
                error.map(|error| (id.clone(), error))
            })
            .collect::<Vec<_>>();
        for (id, error) in retired {
            if let Some(pending) = self.browser_queries.pending.remove(&id) {
                self.browser_queries.bytes -= pending.bytes;
                self.browser_queries
                    .completions
                    .push_back((pending.api_id, error));
            }
        }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn drain_browser_query_completions(&mut self) -> Result<(), BridgeError> {
        self.sweep_browser_queries();
        if self.browser_query_snapshot().is_ok() {
            for waiting in std::mem::take(&mut self.browser_queries.waiting) {
                self.browser_queries.bytes -= waiting.bytes;
                let owner = serde_json::to_value(&waiting.owner)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?;
                if let Err(error) = self.enqueue_browser_query_with_limits(
                    waiting.api_id,
                    Some(&owner),
                    &waiting.options,
                    waiting.limits,
                ) {
                    self.browser_queries
                        .completions
                        .push_back((waiting.api_id, error));
                }
            }
        }
        while let Some((id, error)) = self.browser_queries.completions.pop_front() {
            self.resolve_browser_query_api(id, Err(error))?;
        }
        Ok(())
    }

    pub(super) fn resolve_browser_query_api(
        &mut self,
        id: u64,
        result: Result<Value, BridgeError>,
    ) -> Result<(), BridgeError> {
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if id >= private_selector::FIRST_PRIVATE_ID {
            return self.resolve_engine_api(id, "wx.createSelectorQuery", result);
        }
        let (value, error) = match result {
            Ok(value) => (value, Value::Null),
            Err(error) => (
                Value::Null,
                json!({"code":error.code,"message":error.message,
                "errMsg":format!("createSelectorQuery:fail {}",error.message),"retryable":error.retryable}),
            ),
        };
        self.call_engine(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![json!(id), value, error],
        )?;
        Ok(())
    }
}

fn project_query(
    pending: &PendingQuery,
    topology: &ViewTopology,
    geometry: &BrowserGeometryBatch,
    viewport_scroll: ViewPoint,
    viewport_extent: Option<ViewSize>,
) -> Result<Value, BridgeError> {
    let nodes = geometry
        .nodes
        .iter()
        .map(|node| (node.occurrence_id.as_str(), node))
        .collect::<BTreeMap<_, _>>();
    let mut result = Vec::with_capacity(pending.operations.len());
    for operation in &pending.operations {
        let mut slots = Vec::with_capacity(operation.matches.len());
        for id in &operation.matches {
            let (metadata, measured) = if let Some(id) = id {
                (
                    Some(
                        topology
                            .node(id)
                            .ok_or_else(|| cancelled("query declaration no longer exists"))?,
                    ),
                    Some(
                        *nodes
                            .get(id.as_str())
                            .ok_or_else(|| BridgeError::invalid("query geometry is incomplete"))?,
                    ),
                )
            } else {
                (None, None)
            };
            slots.push(project_node(
                operation,
                metadata,
                measured,
                geometry,
                viewport_scroll,
                viewport_extent,
            )?);
        }
        result.push(if operation.all {
            Value::Array(slots)
        } else {
            slots.into_iter().next().unwrap_or(Value::Null)
        });
    }
    Ok(Value::Array(result))
}

fn project_node(
    operation: &QueryOperation,
    metadata: Option<&ViewTopologyNode>,
    measured: Option<&BrowserNodeGeometry>,
    geometry: &BrowserGeometryBatch,
    viewport_scroll: ViewPoint,
    viewport_extent: Option<ViewSize>,
) -> Result<Value, BridgeError> {
    let rect = measured.map(|node| node.border_box).unwrap_or(ViewRect {
        x: 0.0,
        y: 0.0,
        width: geometry.viewport.width,
        height: geometry.viewport.height,
    });
    let scroll = measured
        .map(|node| node.scroll_offset)
        .unwrap_or(viewport_scroll);
    let scroll_extent = measured.map(|node| node.scroll_extent).or(viewport_extent);
    let needs_scroll = operation.operation == "scrollOffset"
        || operation
            .fields
            .as_ref()
            .is_some_and(|fields| fields.scroll_offset);
    if needs_scroll && scroll_extent.is_none() {
        return Err(BridgeError::invalid(
            "DOM viewport scroll query requires an actual content extent",
        ));
    }
    let rect_fields = json!({"left":rect.x,"top":rect.y,"right":rect.x+rect.width,"bottom":rect.y+rect.height,
        "width":rect.width,"height":rect.height,"x":rect.x,"y":rect.y});
    let id = metadata
        .and_then(|node| node.public_id.as_deref())
        .unwrap_or("");
    let mut result = Map::new();
    let Some(fields) = &operation.fields else {
        if operation.operation == "fields" {
            return Ok(Value::Object(result));
        }
        return Ok(selector_geometry::basic_selector_geometry(
            metadata.map(|node| (id, &node.dataset)),
            [rect.x, rect.y, rect.width, rect.height],
            [scroll.x, scroll.y],
            scroll_extent.map(|extent| [extent.width, extent.height]),
            &operation.operation,
        ));
    };
    if fields.id {
        result.insert("id".into(), json!(id));
    }
    if fields.dataset {
        result.insert(
            "dataset".into(),
            metadata
                .map(|node| json!(node.dataset))
                .unwrap_or_else(|| json!({})),
        );
    }
    if fields.mark {
        result.insert(
            "mark".into(),
            metadata
                .map(|node| json!(node.mark))
                .unwrap_or_else(|| json!({})),
        );
    }
    if fields.rect {
        result.extend(rect_fields.as_object().expect("rect object").clone());
    }
    if fields.size {
        result.insert("width".into(), json!(rect.width));
        result.insert("height".into(), json!(rect.height));
    }
    for name in &fields.geometry {
        if let Some(value) = rect_fields.get(name) {
            result.insert(name.clone(), value.clone());
        }
    }
    if fields.scroll_offset {
        result.insert("scrollLeft".into(), json!(scroll.x));
        result.insert("scrollTop".into(), json!(scroll.y));
        let extent = scroll_extent.expect("scroll query extent was validated");
        result.insert("scrollWidth".into(), json!(extent.width));
        result.insert("scrollHeight".into(), json!(extent.height));
    }
    for name in &fields.properties {
        let value = if name == "id" {
            json!(id)
        } else {
            metadata
                .and_then(|node| node.typed_attrs.get(name))
                .cloned()
                .or_else(|| {
                    metadata
                        .and_then(|node| node.attrs.get(name))
                        .map(|value| json!(value))
                })
                .unwrap_or(Value::Null)
        };
        result.insert(name.clone(), value);
    }
    Ok(Value::Object(result))
}

#[cfg(test)]
mod basic_projection_tests {
    use super::*;
    #[test]
    fn dom_basic_results_preserve_public_identity_typed_dataset_and_viewport_boundary() {
        let node = ViewTopologyNode {
            occurrence_id: "node:path:0".into(),
            parent: None,
            tag: Some("scroll-view".into()),
            public_id: None,
            classes: vec![],
            attrs: BTreeMap::new(),
            typed_attrs: BTreeMap::new(),
            dataset: BTreeMap::from([
                ("n".into(), json!(7)),
                ("enabled".into(), json!(false)),
                ("payload".into(), json!({"a":[1,null]})),
            ]),
            mark: BTreeMap::new(),
            ownership: container_ir::ViewOwnership::default(),
            events: vec![],
        };
        let measured = BrowserNodeGeometry {
            occurrence_id: node.occurrence_id.clone(),
            border_box: ViewRect {
                x: -7.0,
                y: 11.0,
                width: 40.0,
                height: 12.0,
            },
            scroll_offset: ViewPoint { x: 4.0, y: 9.0 },
            scroll_extent: container_ir::ViewSize {
                width: 80.0,
                height: 100.0,
            },
            client_size: container_ir::ViewSize {
                width: 40.0,
                height: 12.0,
            },
        };
        let geometry = BrowserGeometryBatch {
            version: "1.0".into(),
            key: PresentationKey {
                session_id: "session".into(),
                page_id: 1,
                document_revision: 1,
                presentation_revision: 1,
                surface_generation: 1,
                profile: container_ir::RendererProfile::WebView,
            },
            epoch: 1,
            viewport: container_ir::ViewViewport {
                width: 320.0,
                height: 480.0,
            },
            nodes: vec![measured.clone()],
        };
        let operation = QueryOperation {
            all: false,
            operation: "boundingClientRect".into(),
            fields: None,
            matches: vec![],
        };
        let rect = project_node(
            &operation,
            Some(&node),
            Some(&measured),
            &geometry,
            ViewPoint { x: 0.0, y: 0.0 },
            None,
        )
        .unwrap();
        assert_eq!(rect["id"], json!(""));
        assert_eq!(rect["dataset"], json!(node.dataset));
        assert_eq!(rect["left"], json!(-7.0));
        assert_eq!(rect["right"], json!(33.0));
        let operation = QueryOperation {
            operation: "scrollOffset".into(),
            ..operation
        };
        assert_eq!(
            project_node(
                &operation,
                Some(&node),
                Some(&measured),
                &geometry,
                ViewPoint { x: 0.0, y: 0.0 },
                None,
            )
            .unwrap(),
            json!({"id":"","dataset":node.dataset,"scrollLeft":4.0,"scrollTop":9.0,"scrollWidth":80.0,"scrollHeight":100.0})
        );
        assert!(
            project_node(
                &operation,
                None,
                None,
                &geometry,
                ViewPoint { x: 0.0, y: 0.0 },
                None
            )
            .is_err(),
            "viewport content cannot be inferred from its displayed size"
        );
        let bounds = QueryOperation {
            all: false,
            operation: "boundingClientRect".into(),
            fields: None,
            matches: vec![],
        };
        let legacy_bounds = project_node(
            &bounds,
            None,
            None,
            &geometry,
            ViewPoint { x: 0.0, y: 0.0 },
            None,
        )
        .unwrap();
        assert_eq!(legacy_bounds["width"], json!(320.0));
        assert_eq!(legacy_bounds["id"], json!(""));
        assert_eq!(legacy_bounds["dataset"], json!({}));
        assert_eq!(
            project_node(
                &operation,
                None,
                None,
                &geometry,
                ViewPoint { x: 2.0, y: 3.0 },
                Some(ViewSize {
                    width: 900.0,
                    height: 1200.0
                }),
            )
            .unwrap(),
            json!({"id":"","dataset":{},"scrollLeft":2.0,"scrollTop":3.0,"scrollWidth":900.0,"scrollHeight":1200.0})
        );
    }
}
