//! Opt-in live-document transactions. Document authorization deliberately
//! precedes live geometry. Native editing leases are a separate contract.
use super::*;

pub const LIVE_DOCUMENT_VERSION: &str = "2.0";
pub const CONSUMABLE_LIVE_DOCUMENT_VERSION: &str = "2.1";
const DOCUMENT_PERMIT_TTL_MS: u64 = 5_000;

/// Passive protocol accounting; it grants no presentation or input authority.
/// Bytes measure retained wire data/reservations, not allocator or process RSS.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLiveTransactionRetention {
    pub retained_requests: usize,
    pub retained_bytes: usize,
    pub consumed_through: Option<String>,
    pub highest_admitted: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserLiveViewSubmission {
    pub version: String,
    pub key: PresentationKey,
    #[serde(deserialize_with = "required_nullable_key")]
    pub base_key: Option<PresentationKey>,
    pub document_token: String,
    pub input_lifetime_revision: String,
    pub runtime_identities: BTreeMap<String, String>,
    pub viewport: ViewViewport,
    pub document: ViewDocument,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserDocumentPermit {
    pub version: String,
    pub key: PresentationKey,
    #[serde(deserialize_with = "required_nullable_key")]
    pub base_key: Option<PresentationKey>,
    pub document_token: String,
    pub input_lifetime_revision: String,
    pub permit_id: String,
    pub ttl_ms: u64,
}

pub(super) struct LiveCandidate {
    token: String,
    base_key: Option<PresentationKey>,
    input_lifetime: u64,
    permit: Option<BrowserDocumentPermit>,
    deadline: Option<Instant>,
    pub(super) receiver_snapshot: Value,
}

#[derive(Default)]
pub(super) struct LiveDocumentState {
    pub(super) enabled: bool,
    explicit_consumption: bool,
    // Negotiation precedes lane issuance. Keep one bounded original negotiation
    // independently of the sequence table; replay must never mint another lane.
    enable_request: Option<BridgeEnvelope>,
    enable_final: Option<Box<[u8]>>,
    enable_lifetime: Option<u64>,
    binding_sequence: u64,
    binding_lifetime: Option<u64>,
    bindings: BTreeMap<String, (String, String)>,
}

pub(super) struct LiveBindings {
    lifetime: Option<u64>,
    bindings: BTreeMap<String, (String, String)>,
}

pub(crate) fn is_live_operation(operation: &str) -> bool {
    matches!(
        operation,
        op::VIEW_LIVE_ENABLE
            | op::VIEW_LIVE_PREPARE
            | op::VIEW_LIVE_PERMIT
            | op::VIEW_LIVE_PRESENTED
            | op::VIEW_LIVE_ABORT
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Enable {
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    version: String,
    input_lifetime_revision: String,
    surface_generation: String,
    render: Value,
    #[serde(default, rename = "transaction")]
    _transaction: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Permit {
    version: String,
    input_lifetime_revision: String,
    key: PresentationKey,
    #[serde(deserialize_with = "required_nullable_key")]
    base_key: Option<PresentationKey>,
    document_token: String,
    #[serde(default, rename = "transaction")]
    _transaction: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PresentedLive {
    version: String,
    input_lifetime_revision: String,
    permit: BrowserDocumentPermit,
    geometry: BrowserGeometryBatch,
    #[serde(default, rename = "transaction")]
    _transaction: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AbortLive {
    version: String,
    input_lifetime_revision: String,
    key: PresentationKey,
    document_token: String,
    #[serde(default, rename = "transaction")]
    _transaction: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Consume {
    version: String,
    input_lifetime_revision: String,
    lane_id: String,
    through: String,
    receipts: Vec<super::browser_transaction_finals::ConsumptionReceipt>,
}

fn decode<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, BridgeError> {
    serde_json::from_value(value.clone())
        .map_err(|error| invalid(format!("invalid live-document request: {error}")))
}

fn required_nullable_key<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<PresentationKey>, D::Error> {
    Option::deserialize(deserializer)
}

fn decimal(value: &str) -> Result<u64, BridgeError> {
    let number = value
        .parse::<u64>()
        .map_err(|_| invalid("live document identity requires a canonical u64 string"))?;
    if number.to_string() != value {
        return Err(invalid("live document identity must be canonical"));
    }
    Ok(number)
}

impl Session {
    pub(super) fn take_live_bindings(&mut self) -> LiveBindings {
        LiveBindings {
            lifetime: self.browser_view.live.binding_lifetime.take(),
            bindings: std::mem::take(&mut self.browser_view.live.bindings),
        }
    }

    pub(super) fn install_live_bindings(&mut self, state: LiveBindings) {
        self.browser_view.live.binding_lifetime = state.lifetime;
        self.browser_view.live.bindings = state.bindings;
    }

    pub fn browser_live_transaction_retention(&self) -> Option<BrowserLiveTransactionRetention> {
        self.browser_live_finals.as_ref().map(|(_, finals)| {
            let (retained_requests, retained_bytes, watermarks) = finals.retention();
            BrowserLiveTransactionRetention {
                retained_requests,
                retained_bytes,
                consumed_through: watermarks.map(|(through, _)| through.to_string()),
                highest_admitted: watermarks.map(|(_, highest)| highest.to_string()),
            }
        })
    }

    pub(crate) fn requires_consumable_enable_dispatch(&self, request: &BridgeEnvelope) -> bool {
        request.op == op::VIEW_LIVE_ENABLE
            && (self.browser_view.live.enable_request.is_some()
                || request.payload.get("version").and_then(Value::as_str)
                    == Some(CONSUMABLE_LIVE_DOCUMENT_VERSION))
    }

    fn live_document_version(&self) -> &'static str {
        if self.browser_view.live.explicit_consumption {
            CONSUMABLE_LIVE_DOCUMENT_VERSION
        } else {
            LIVE_DOCUMENT_VERSION
        }
    }

    /// This validation never synchronizes storage or enters an engine turn.
    /// Even a saturated lane must be able to reclaim a known complete prefix.
    fn validate_live_metadata(&self, request: &BridgeEnvelope) -> Result<(), BridgeError> {
        crate::browser_transaction_finals::validate_metadata_request(request, 8 * 1024)?;
        request.validate()?;
        if request.kind != EnvelopeKind::Request || request.session_id != self.config.session_id {
            return Err(invalid(
                "live metadata requires this session's request envelope",
            ));
        }
        let peer = ProtocolVersion::parse(&request.protocol_version)
            .map_err(|error| BridgeError::protocol(error.to_string()))?;
        negotiate_protocol(self.protocol.clone(), peer)
            .map_err(|error| BridgeError::protocol(error.to_string()))?;
        Ok(())
    }

    fn validate_live_metadata_control(&self, request: &BridgeEnvelope) -> Result<(), BridgeError> {
        if request.deadline_ns.is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "bridge request deadline has expired",
            ));
        }
        if request
            .cancel_token
            .as_deref()
            .is_some_and(|token| self.is_cancelled(token))
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "live metadata request was cancelled",
            ));
        }
        Ok(())
    }

    pub(crate) fn dispatch_live_consumption(&mut self, request: &BridgeEnvelope) -> BridgeBatch {
        let result = (|| {
            self.validate_live_metadata(request)?;
            if self.engine_turn_deadline.is_some() || !self.browser_view.live.explicit_consumption {
                return Err(BridgeError::protocol(
                    "explicit consumption requires a standalone negotiated live 2.1 owner",
                ));
            }
            let payload: Consume = decode(&request.payload)?;
            let epoch =
                self.check_live_version(&payload.version, &payload.input_lifetime_revision)?;
            let through = decimal(&payload.through)?;
            let control = self.validate_live_metadata_control(request);
            let (previous, finals) = self
                .browser_live_finals
                .as_mut()
                .ok_or_else(|| invalid("live transaction lane is not installed"))?;
            if *previous != epoch {
                finals.retire_epoch(epoch)?;
                *previous = epoch;
            }
            // A duplicate pure ACK has already taken effect. Recover its same
            // success even if the original envelope's deadline/token retired.
            if finals
                .retention()
                .2
                .is_none_or(|(retired, _)| through > retired)
            {
                control?;
            }
            finals.consume(epoch, &payload.lane_id, &payload.through, &payload.receipts)?;
            Ok(json!({"ok":true,"consumedThrough":payload.through}))
        })();
        // No pending effects/retirement drain here: this metadata control has
        // neither executed JS nor acquired presentation or resource authority.
        BridgeBatch::new(vec![match result {
            Ok(payload) => self.response(request, payload),
            Err(error) => self.error_envelope(&error, request.request_id.clone(), &request.op),
        }])
    }

    pub(crate) fn dispatch_consumable_live_enable(
        &mut self,
        request: BridgeEnvelope,
    ) -> Result<BridgeBatch, SessionError> {
        let validation = (|| {
            self.validate_live_metadata(&request)?;
            if self.engine_turn_deadline.is_some() {
                return Err(BridgeError::protocol(
                    "live negotiation requires a standalone owner turn",
                ));
            }
            let payload: Enable = decode(&request.payload)?;
            if payload.version != CONSUMABLE_LIVE_DOCUMENT_VERSION {
                return Err(BridgeError::protocol(
                    "live document owner cannot renegotiate its profile",
                ));
            }
            // Header and payload bytes are bounded before decode or retention;
            // negotiation is independent of the business sequence lane.
            if let Some(original) = &self.browser_view.live.enable_request {
                if self.input_lifetime_revision != self.browser_view.live.enable_lifetime {
                    return Err(stale("live negotiation native input lifetime retired"));
                }
                if original != &request {
                    return Err(BridgeError::protocol(
                        "live document owner cannot renegotiate its profile",
                    ));
                }
                return self
                    .browser_view
                    .live
                    .enable_final
                    .as_ref()
                    .ok_or_else(|| {
                        invalid("live negotiation outcome is indeterminate; replace the owner")
                    })
                    .and_then(|bytes| {
                        serde_json::from_slice(bytes)
                            .map(Some)
                            .map_err(|error| invalid(error.to_string()))
                    });
            }
            if self.browser_view.live.enabled {
                return Err(BridgeError::protocol(
                    "live document owner cannot renegotiate its profile",
                ));
            }
            self.validate_live_metadata_control(&request)?;
            Ok(None)
        })();
        match validation {
            Ok(Some(batch)) => return Ok(batch),
            Err(error) => {
                return Ok(BridgeBatch::new(vec![self.error_envelope(
                    &error,
                    request.request_id,
                    &request.op,
                )]))
            }
            Ok(None) => {}
        }
        self.browser_view.live.enable_request = Some(request.clone());
        self.browser_view.live.enable_lifetime = self.input_lifetime_revision;
        let request_id = request.request_id.clone();
        let operation = request.op.clone();
        let mut batch = self.dispatch_result_unretained(request)?;
        match super::browser_transaction_finals::encode_final(
            &batch,
            &self.config.session_id,
            &request_id,
            &operation,
            512 * 1024,
        ) {
            Ok(bytes) => self.browser_view.live.enable_final = Some(bytes),
            Err(error) => {
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
                    failure.payload["originalResult"] = original;
                }
                batch.messages.push(failure);
            }
        }
        Ok(batch)
    }

    pub(crate) fn live_browser_request_epoch(
        &self,
        request: &BridgeEnvelope,
    ) -> Result<u64, BridgeError> {
        request.validate()?;
        let peer = ProtocolVersion::parse(&request.protocol_version)
            .map_err(|error| BridgeError::protocol(error.to_string()))?;
        negotiate_protocol(self.protocol.clone(), peer)
            .map_err(|error| BridgeError::protocol(error.to_string()))?;
        if request.session_id != self.config.session_id || !self.browser_view.live.enabled {
            return Err(BridgeError::protocol(
                "live-document transactions require this session's explicit v2 negotiation",
            ));
        }
        let value = request
            .payload
            .get("inputLifetimeRevision")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("live-document transaction is missing inputLifetimeRevision"))?;
        let epoch = decimal(value)?;
        if self.input_lifetime_revision != Some(epoch) {
            return Err(stale("live-document native input lifetime retired"));
        }
        if request.payload.get("version").and_then(Value::as_str)
            != Some(self.live_document_version())
            || (!self.browser_view.live.explicit_consumption
                && request.payload.get("transaction").is_some())
        {
            return Err(BridgeError::protocol(
                "live request does not match its negotiated profile",
            ));
        }
        Ok(epoch)
    }

    fn live_contract(&self) -> Value {
        let mut contract = json!({"version":self.live_document_version(),"documentPermit":true,"liveGeometryFinalization":true,
            "nativeEditing":false,"finalReplay":true,"inputLifetimeRevision":self.input_lifetime_revision.map(|n|n.to_string()),
            "permitTtlMs":DOCUMENT_PERMIT_TTL_MS,"maxRetainedRequests":32,"maxRetainedBytes":8*1024*1024,
            "requiresOwnerReplacementWhenFull":!self.browser_view.live.explicit_consumption});
        if self.browser_view.live.explicit_consumption {
            let lane = self
                .browser_live_finals
                .as_ref()
                .expect("negotiated lane")
                .1
                .lane_id()
                .expect("consumable lane");
            contract["transactionRetention"] = json!({"version":"1.0","laneId":lane,"firstSequence":"1","explicitConsumption":true});
        }
        contract
    }

    fn check_live_version(&self, version: &str, lifetime: &str) -> Result<u64, BridgeError> {
        if !self.browser_view.live.enabled || version != self.live_document_version() {
            return Err(BridgeError::protocol("live document v2 was not negotiated"));
        }
        let lifetime = decimal(lifetime)?;
        if self.input_lifetime_revision != Some(lifetime) {
            return Err(stale("live-document native input lifetime retired"));
        }
        Ok(lifetime)
    }

    pub(crate) fn live_receiver_snapshot(
        &mut self,
        page: u64,
        scopes: &[String],
    ) -> Result<Value, BridgeError> {
        match self.config.engine {
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
                        .capture_receiver_incarnations(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
                        })
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    let _ = (page, scopes);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "live receiver identity requires native QuickJS",
                    ))
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
                        .capture_receiver_incarnations(page, scopes)
                        .map_err(|error| {
                            let error = error.into_core_error();
                            let fallback = if error.code == container_core::EngineErrorCode::Call {
                                BridgeErrorCode::Cancelled
                            } else {
                                BridgeErrorCode::Engine
                            };
                            engine_bridge_error(error, fallback)
                        })
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    let _ = (page, scopes);
                    Err(BridgeError::new(
                        BridgeErrorCode::Engine,
                        "live receiver identity requires native V8",
                    ))
                }
            }
        }
    }

    fn bind_live_receivers(
        &mut self,
        document: &ViewDocument,
        lifetime: u64,
    ) -> Result<(BTreeMap<String, String>, Value), BridgeError> {
        // A partially failed binding pass cannot leave an older identity map
        // available for an A -> failed B -> A revival.
        let mut previous = std::mem::take(&mut self.browser_view.live.bindings);
        let mut nodes = Vec::new();
        let mut pending: Vec<_> = document.nodes.iter().collect();
        let mut scopes = BTreeSet::new();
        while let Some(node) = pending.pop() {
            for scope in [
                &node.ownership().event_owner,
                &node.ownership().component_scope,
                &node.ownership().slot_owner,
            ]
            .into_iter()
            .flatten()
            {
                scopes.insert(scope.clone());
            }
            if let container_ir::ViewNode::Element { children, .. } = node {
                pending.extend(children);
            }
            nodes.push(node);
        }
        let snapshot =
            self.live_receiver_snapshot(document.page_id, &scopes.into_iter().collect::<Vec<_>>())?;
        let page_token = snapshot
            .get("pageToken")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("native receiver snapshot omitted page token"))?;
        decimal(page_token)?;
        let tokens = snapshot
            .get("scopes")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("native receiver snapshot omitted scopes"))?;
        let token = |scope: &Option<String>| -> Result<&str, BridgeError> {
            match scope {
                None => Ok(page_token),
                Some(scope) => {
                    let value = tokens
                        .get(scope)
                        .and_then(Value::as_str)
                        .ok_or_else(|| stale("native receiver scope disappeared"))?;
                    decimal(value)?;
                    Ok(value)
                }
            }
        };
        if self.browser_view.live.binding_lifetime != Some(lifetime) {
            previous.clear();
            self.browser_view.live.binding_lifetime = Some(lifetime);
        }
        let mut next = BTreeMap::new();
        let mut identities = BTreeMap::new();
        let mut binding_bytes = 0usize;
        for node in nodes {
            let owner = node.ownership();
            let declaration = match node {
                container_ir::ViewNode::Element {
                    tag,
                    key,
                    attrs,
                    typed_attrs,
                    ..
                } => json!([
                    tag,
                    key,
                    typed_attrs
                        .get("type")
                        .cloned()
                        .or_else(|| attrs.get("type").cloned().map(Value::String)),
                    typed_attrs
                        .get("password")
                        .cloned()
                        .or_else(|| attrs.get("password").cloned().map(Value::String))
                ]),
                container_ir::ViewNode::Text { .. } => json!(["#text"]),
            };
            let fingerprint = serde_json::to_string(&json!([
                document.page_id,
                page_token,
                node.occurrence_id(),
                owner,
                token(&owner.event_owner)?,
                token(&owner.component_scope)?,
                token(&owner.slot_owner)?,
                declaration
            ]))
            .map_err(|error| invalid(error.to_string()))?;
            binding_bytes = binding_bytes
                .checked_add(fingerprint.len())
                .and_then(|size| size.checked_add(node.occurrence_id().len()))
                .ok_or_else(|| invalid("live receiver binding budget exceeded"))?;
            if fingerprint.len() > 16 * 1024 || binding_bytes > 16 * 1024 * 1024 {
                return Err(invalid("live receiver binding budget exceeded"));
            }
            let identity = if let Some((_, identity)) = previous
                .get(node.occurrence_id())
                .filter(|(old, _)| old == &fingerprint)
            {
                identity.clone()
            } else {
                self.browser_view.live.binding_sequence = self
                    .browser_view
                    .live
                    .binding_sequence
                    .checked_add(1)
                    .ok_or_else(|| invalid("live receiver binding identity exhausted"))?;
                self.browser_view.live.binding_sequence.to_string()
            };
            identities.insert(node.occurrence_id().to_owned(), identity.clone());
            next.insert(node.occurrence_id().to_owned(), (fingerprint, identity));
        }
        self.browser_view.live.bindings = next;
        Ok((identities, snapshot))
    }

    pub(super) fn handle_browser_live_operation(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        let mut messages = Vec::new();
        let result = match request.op.as_str() {
            op::VIEW_LIVE_ENABLE => {
                let payload: Enable = decode(&request.payload)?;
                if !matches!(
                    payload.version.as_str(),
                    LIVE_DOCUMENT_VERSION | CONSUMABLE_LIVE_DOCUMENT_VERSION
                ) || !self.config.browser_view_enabled
                {
                    return Err(BridgeError::protocol("unsupported live-document contract"));
                }
                // No in-place protocol migration can reinterpret an existing
                // v1 permit or accepted authority. A new owner negotiates first.
                if !self.browser_view.live.enabled && self.browser_view.sequence != 0 {
                    return Err(stale(
                        "live-document negotiation requires a fresh presentation owner",
                    ));
                }
                if self.browser_view.live.enabled && payload.version != self.live_document_version()
                {
                    return Err(BridgeError::protocol(
                        "live document owner cannot renegotiate its profile",
                    ));
                }
                if payload.version == CONSUMABLE_LIVE_DOCUMENT_VERSION {
                    let epoch = self
                        .input_lifetime_revision
                        .ok_or_else(|| stale("native input lifetime retired"))?;
                    let mut lane = [0_u8; 16];
                    getrandom::fill(&mut lane).map_err(|error| {
                        BridgeError::new(
                            BridgeErrorCode::Engine,
                            format!("live lane entropy unavailable: {error}"),
                        )
                    })?;
                    let lane = lane
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect::<String>();
                    self.browser_live_finals = Some((epoch, super::browser_transaction_finals::BrowserTransactionFinals::new_consumable(
                        self.config.session_id.clone(), epoch, super::browser_transaction_finals::BrowserTransactionFinalLimits::default(), lane,
                    )?));
                    self.browser_view.live.explicit_consumption = true;
                }
                self.browser_view.live.enabled = true;
                json!({"ok":true,"contract":self.live_contract()})
            }
            op::VIEW_LIVE_PREPARE => {
                let payload: Prepare = decode(&request.payload)?;
                let lifetime =
                    self.check_live_version(&payload.version, &payload.input_lifetime_revision)?;
                let generation = decimal(&payload.surface_generation)?;
                // Replacing a permitted/applied transaction before its exact
                // final is known would strand a live patch journal.
                if self.browser_view.pending.is_some() {
                    return Err(stale("a live document transaction is already pending"));
                }
                let base_key = self
                    .browser_view
                    .presented
                    .as_ref()
                    .filter(|previous| self.browser_key_is_current(&previous.submission.key))
                    .map(|previous| previous.submission.key.clone());
                let development = self.browser_view.development.is_some();
                let submission =
                    match self.prepare_browser_view_within_turn(&payload.render, generation) {
                        Ok(submission) => submission,
                        Err(error) => {
                            if !development {
                                self.browser_view.live.bindings.clear();
                            }
                            return Err(error);
                        }
                    };
                // Development keeps the accepted binding map until ACK. The
                // monotonic identity allocator is deliberately never rewound.
                let previous_bindings = development.then(|| self.take_live_bindings());
                if development {
                    // Reuse unchanged identities when the private fingerprints
                    // agree, while retaining the exact accepted map separately.
                    let previous = previous_bindings.as_ref().expect("development bindings");
                    self.browser_view.live.binding_lifetime = previous.lifetime;
                    self.browser_view.live.bindings = previous.bindings.clone();
                }
                let bound = self.bind_live_receivers(&submission.document, lifetime);
                if let Some(previous) = previous_bindings {
                    let staged = self.take_live_bindings();
                    self.install_live_bindings(previous);
                    if bound.is_ok() {
                        self.browser_view
                            .pending
                            .as_mut()
                            .expect("development candidate")
                            .development
                            .as_mut()
                            .expect("development owner")
                            .live_bindings = Some(staged);
                    }
                }
                let (runtime_identities, receiver_snapshot) = match bound {
                    Ok(identities) => identities,
                    Err(error) => {
                        if development {
                            self.abort_browser_candidate(&submission.key)?;
                        } else {
                            self.invalidate_browser_candidate();
                        }
                        return Err(error);
                    }
                };
                let token = format!(
                    "document:{}:{}:{}",
                    submission.key.presentation_revision, generation, lifetime
                );
                self.browser_view
                    .pending
                    .as_mut()
                    .expect("prepared candidate")
                    .live = Some(LiveCandidate {
                    token: token.clone(),
                    base_key: base_key.clone(),
                    input_lifetime: lifetime,
                    permit: None,
                    deadline: None,
                    receiver_snapshot,
                });
                let live = BrowserLiveViewSubmission {
                    version: self.live_document_version().into(),
                    key: submission.key.clone(),
                    base_key,
                    document_token: token,
                    input_lifetime_revision: lifetime.to_string(),
                    runtime_identities,
                    viewport: submission.viewport,
                    document: submission.document,
                };
                // Component hooks may enqueue navigation or faults. Preserve
                // their effects, but never return a publishable retired token.
                let completion = self
                    .ensure_engine_execution_healthy()
                    .and_then(|()| self.append_engine_effects(&mut messages));
                if let Err(error) = completion {
                    self.invalidate_browser_candidate();
                    messages.insert(
                        0,
                        self.error_envelope(&error, request.request_id.clone(), &request.op),
                    );
                    return Ok(messages);
                }
                if !self.browser_key_is_current(&live.key)
                    || messages.iter().any(effect_continuation_stopped)
                {
                    self.invalidate_browser_candidate();
                    messages.insert(
                        0,
                        self.error_envelope(
                            &stale("live document changed during preparation effects"),
                            request.request_id.clone(),
                            &request.op,
                        ),
                    );
                    return Ok(messages);
                }
                json!({"ok":true,"submission":live})
            }
            op::VIEW_LIVE_PERMIT => {
                let payload: Permit = decode(&request.payload)?;
                let lifetime =
                    self.check_live_version(&payload.version, &payload.input_lifetime_revision)?;
                if !self.browser_key_is_current(&payload.key) {
                    return Err(stale("live document key retired"));
                }
                let candidate = self
                    .browser_view
                    .pending
                    .as_ref()
                    .ok_or_else(|| stale("no pending live document"))?;
                let authority = candidate
                    .live
                    .as_ref()
                    .ok_or_else(|| stale("pending candidate is not live v2"))?;
                if candidate.submission.key != payload.key
                    || authority.token != payload.document_token
                    || authority.base_key != payload.base_key
                    || authority.input_lifetime != lifetime
                {
                    return Err(stale(
                        "document permit does not own the development candidate",
                    ));
                }
                self.prepare_dev_browser_permit()?;
                let version = self.live_document_version();
                let pending = self
                    .browser_view
                    .pending
                    .as_mut()
                    .ok_or_else(|| stale("no pending live document"))?;
                let live = pending
                    .live
                    .as_mut()
                    .ok_or_else(|| stale("pending candidate is not live v2"))?;
                if pending.submission.key != payload.key
                    || live.token != payload.document_token
                    || live.base_key != payload.base_key
                    || live.input_lifetime != lifetime
                {
                    return Err(stale(
                        "document permit does not identify the exact evaluated candidate and base",
                    ));
                }
                if live
                    .deadline
                    .is_some_and(|deadline| Instant::now() >= deadline)
                {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Timeout,
                        "live document permit expired",
                    ));
                }
                let permit = live
                    .permit
                    .get_or_insert_with(|| BrowserDocumentPermit {
                        version: version.into(),
                        key: payload.key,
                        base_key: payload.base_key,
                        document_token: payload.document_token,
                        input_lifetime_revision: lifetime.to_string(),
                        permit_id: format!(
                            "live:{}:{}:{}",
                            pending.submission.key.presentation_revision,
                            pending.submission.key.surface_generation,
                            lifetime
                        ),
                        ttl_ms: DOCUMENT_PERMIT_TTL_MS,
                    })
                    .clone();
                if live.deadline.is_none() {
                    live.deadline = Some(
                        Instant::now() + std::time::Duration::from_millis(DOCUMENT_PERMIT_TTL_MS),
                    );
                }
                json!({"ok":true,"permit":permit})
            }
            op::VIEW_LIVE_PRESENTED => {
                let payload: PresentedLive = decode(&request.payload)?;
                let lifetime =
                    self.check_live_version(&payload.version, &payload.input_lifetime_revision)?;
                if !self.browser_key_is_current(&payload.permit.key) {
                    return Err(stale("live document key retired"));
                }
                payload
                    .geometry
                    .validate()
                    .map_err(|error| invalid(error.to_string()))?;
                let pending = self
                    .browser_view
                    .pending
                    .as_ref()
                    .ok_or_else(|| stale("no permitted live document"))?;
                let live = pending
                    .live
                    .as_ref()
                    .ok_or_else(|| stale("pending candidate is not live v2"))?;
                if live.input_lifetime != lifetime || live.permit.as_ref() != Some(&payload.permit)
                {
                    return Err(stale("live document permit mismatch"));
                }
                if live
                    .deadline
                    .is_none_or(|deadline| Instant::now() >= deadline)
                {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Timeout,
                        "live document permit expired",
                    ));
                }
                // All fallible geometry validation precedes publication. The
                // v1 geometry shape remains 1.0; only its admission order changes.
                validate_geometry(&pending.submission, &pending.topology, &payload.geometry)?;
                let internal = BrowserCommitPermit {
                    version: LIVE_DOCUMENT_VERSION.into(),
                    key: payload.permit.key.clone(),
                    epoch: payload.geometry.epoch.to_string(),
                    permit_id: payload.permit.permit_id.clone(),
                };
                let pending = self
                    .browser_view
                    .pending
                    .as_mut()
                    .expect("validated live candidate");
                pending.geometry = Some(payload.geometry);
                pending.permit = Some(internal.clone());
                messages.extend(
                    self.acknowledge_browser_presentation_within_turn(&internal)?
                        .messages,
                );
                json!({"ok":true,"committed":true,"key":internal.key,"inputEnabled":self.is_browser_view_presented()})
            }
            op::VIEW_LIVE_ABORT => {
                let payload: AbortLive = decode(&request.payload)?;
                self.check_live_version(&payload.version, &payload.input_lifetime_revision)?;
                let pending = self
                    .browser_view
                    .pending
                    .as_ref()
                    .ok_or_else(|| stale("no pending live document"))?;
                if pending.submission.key != payload.key
                    || pending
                        .live
                        .as_ref()
                        .is_none_or(|live| live.token != payload.document_token)
                {
                    return Err(stale("live document abort does not own the candidate"));
                }
                self.abort_browser_candidate(&payload.key)?;
                let mut result = json!({"ok":true,"key":payload.key,"inputEnabled":false});
                self.append_dev_browser_restoration(&mut result);
                result
            }
            _ => return Err(invalid("unknown live document operation")),
        };
        messages.insert(0, self.response(request, result));
        Ok(messages)
    }
}
