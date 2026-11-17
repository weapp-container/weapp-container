//! Batched, cancellable host bridge.
//!
//! The wire types are intentionally independent from any one UI toolkit. A
//! host can carry the JSON representation over JNI, Swift FFI, N-API, WASM,
//! or an in-process channel without changing protocol semantics.

use container_ir::CapabilitySupport;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fmt,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};

pub const PROTOCOL_MAJOR: u16 = 1;
pub const PROTOCOL_MINOR: u16 = 0;
pub const PROTOCOL_VERSION: &str = "1.0";

pub mod op {
    pub const APP_INIT: &str = "app.init";
    pub const APP_LIFECYCLE: &str = "app.lifecycle";
    pub const PAGE_PUSH: &str = "page.push";
    pub const PAGE_POP: &str = "page.pop";
    pub const PAGE_REPLACE: &str = "page.replace";
    pub const DATA_PATCH_BATCH: &str = "data.patch.batch";
    pub const EVENT_BATCH: &str = "event.batch";
    pub const RENDER_COMMIT: &str = "render.commit";
    /// Browser presentation protocol v1. Payload identities and epochs are
    /// lossless decimal strings; acceptance never implies presentation.
    pub const VIEW_PREPARE: &str = "view.prepare";
    pub const VIEW_PREPARE_COMMIT: &str = "view.prepare.commit";
    pub const VIEW_PRESENTED: &str = "view.presented";
    pub const VIEW_ABORT: &str = "view.abort";
    pub const VIEW_GEOMETRY: &str = "view.geometry";
    pub const VIEW_EVENTS: &str = "view.events";
    /// Runtime-sampled numeric animation styles. Baseline observations never
    /// supply time, and sample publication retains the accepted document.
    pub const VIEW_ANIMATION_BASELINE: &str = "view.animation.baseline";
    pub const VIEW_SAMPLE_PREPARE: &str = "view.sample.prepare";
    pub const VIEW_SAMPLE_PRESENTED: &str = "view.sample.presented";
    pub const VIEW_SAMPLE_ABORT: &str = "view.sample.abort";
    /// Explicit live-document v2 transactions. V1 operations never accept
    /// document-only permits or delayed live geometry.
    pub const VIEW_LIVE_ENABLE: &str = "view.live.enable";
    pub const VIEW_LIVE_PREPARE: &str = "view.live.prepare";
    pub const VIEW_LIVE_PERMIT: &str = "view.live.permit";
    pub const VIEW_LIVE_PRESENTED: &str = "view.live.presented";
    pub const VIEW_LIVE_ABORT: &str = "view.live.abort";
    pub const VIEW_LIVE_CONSUME: &str = "view.live.consume";
    /// Explicit, versioned DOM query recipient negotiation and one batched
    /// fresh measurement result. Requests are runtime-produced events only.
    pub const VIEW_QUERY_ENABLE: &str = "view.query.enable";
    pub const VIEW_QUERY_REQUEST: &str = "view.query.request";
    pub const VIEW_QUERY_RESULT: &str = "view.query.result";
    /// Mount a registered Component definition as a host view instance.
    /// The payload carries the registration index and initial properties;
    /// lifecycle callbacks are invoked in the engine's deterministic batch.
    pub const COMPONENT_MOUNT: &str = "component.mount";
    /// Apply a batched property update to a mounted Component instance.
    pub const COMPONENT_UPDATE: &str = "component.update";
    /// Detach a mounted Component instance and release its host view binding.
    pub const COMPONENT_UNMOUNT: &str = "component.unmount";
    pub const API_CALL: &str = "api.call";
    pub const API_RESULT: &str = "api.result";
    pub const HOST_MESSAGE: &str = "host.message";
    /// Load one or more content-addressed CommonJS/JSON modules into the
    /// selected JavaScript provider.  Sources cross the bridge in one batch
    /// so hosts never need to perform a per-module FFI round trip.
    pub const MODULE_LOAD: &str = "module.load";
    /// Invoke one exported function with a JSON value batch.
    pub const MODULE_CALL: &str = "module.call";
    pub const DIAGNOSTIC: &str = "diagnostic";
    pub const ERROR: &str = "error";
    pub const CANCEL: &str = "cancel";

    pub fn is_known(value: &str) -> bool {
        matches!(
            value,
            APP_INIT
                | APP_LIFECYCLE
                | PAGE_PUSH
                | PAGE_POP
                | PAGE_REPLACE
                | DATA_PATCH_BATCH
                | EVENT_BATCH
                | RENDER_COMMIT
                | VIEW_PREPARE
                | VIEW_PREPARE_COMMIT
                | VIEW_PRESENTED
                | VIEW_ABORT
                | VIEW_GEOMETRY
                | VIEW_EVENTS
                | VIEW_ANIMATION_BASELINE
                | VIEW_SAMPLE_PREPARE
                | VIEW_SAMPLE_PRESENTED
                | VIEW_SAMPLE_ABORT
                | VIEW_LIVE_ENABLE
                | VIEW_LIVE_PREPARE
                | VIEW_LIVE_PERMIT
                | VIEW_LIVE_PRESENTED
                | VIEW_LIVE_ABORT
                | VIEW_LIVE_CONSUME
                | VIEW_QUERY_ENABLE
                | VIEW_QUERY_REQUEST
                | VIEW_QUERY_RESULT
                | COMPONENT_MOUNT
                | COMPONENT_UPDATE
                | COMPONENT_UNMOUNT
                | API_CALL
                | API_RESULT
                | HOST_MESSAGE
                | MODULE_LOAD
                | MODULE_CALL
                | DIAGNOSTIC
                | ERROR
                | CANCEL
        )
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnvelopeKind {
    Request,
    Response,
    Event,
    Batch,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeEnvelope {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "requestId")]
    pub request_id: String,
    pub kind: EnvelopeKind,
    pub op: String,
    #[serde(rename = "cancelToken", skip_serializing_if = "Option::is_none")]
    pub cancel_token: Option<String>,
    #[serde(rename = "deadlineNs", skip_serializing_if = "Option::is_none")]
    pub deadline_ns: Option<u64>,
    #[serde(rename = "traceId", skip_serializing_if = "Option::is_none")]
    pub trace_id: Option<String>,
    pub payload: serde_json::Value,
}

impl BridgeEnvelope {
    pub fn request(
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        op: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.into(),
            session_id: session_id.into(),
            request_id: request_id.into(),
            kind: EnvelopeKind::Request,
            op: op.into(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: None,
            payload,
        }
    }

    pub fn event(
        session_id: impl Into<String>,
        op: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.into(),
            session_id: session_id.into(),
            request_id: String::new(),
            kind: EnvelopeKind::Event,
            op: op.into(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: None,
            payload,
        }
    }

    pub fn batch(
        session_id: impl Into<String>,
        request_id: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION.into(),
            session_id: session_id.into(),
            request_id: request_id.into(),
            kind: EnvelopeKind::Batch,
            op: "batch".into(),
            cancel_token: None,
            deadline_ns: None,
            trace_id: None,
            payload,
        }
    }

    pub fn validate(&self) -> Result<(), BridgeError> {
        ProtocolVersion::parse(&self.protocol_version)
            .map_err(|e| BridgeError::protocol(e.to_string()))?;
        if self.session_id.trim().is_empty() {
            return Err(BridgeError::invalid("sessionId cannot be empty"));
        }
        if self.op.trim().is_empty() {
            return Err(BridgeError::invalid("op cannot be empty"));
        }
        if !matches!(self.kind, EnvelopeKind::Event) && self.request_id.trim().is_empty() {
            return Err(BridgeError::invalid(
                "requestId is required for requests, responses and batches",
            ));
        }
        if self.deadline_ns == Some(0) {
            return Err(BridgeError::invalid("deadlineNs must be greater than zero"));
        }
        if self
            .cancel_token
            .as_ref()
            .is_some_and(|token| token.trim().is_empty())
        {
            return Err(BridgeError::invalid("cancelToken cannot be empty"));
        }
        Ok(())
    }

    pub fn is_known_operation(&self) -> bool {
        op::is_known(&self.op)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
}

impl ProtocolVersion {
    pub const fn current() -> Self {
        Self {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
        }
    }
    pub fn parse(value: &str) -> Result<Self, ProtocolError> {
        let (major, minor) = value
            .split_once('.')
            .ok_or(ProtocolError::Malformed(value.into()))?;
        if major.is_empty() || minor.is_empty() || minor.contains('.') {
            return Err(ProtocolError::Malformed(value.into()));
        }
        Ok(Self {
            major: major
                .parse()
                .map_err(|_| ProtocolError::Malformed(value.into()))?,
            minor: minor
                .parse()
                .map_err(|_| ProtocolError::Malformed(value.into()))?,
        })
    }
}

impl fmt::Display for ProtocolVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolError {
    Malformed(String),
    MajorMismatch {
        local: ProtocolVersion,
        peer: ProtocolVersion,
    },
    MinorMismatch {
        local: ProtocolVersion,
        peer: ProtocolVersion,
    },
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Malformed(v) => write!(f, "malformed protocol version {v:?}"),
            Self::MajorMismatch { local, peer } => {
                write!(f, "protocol major mismatch: local {local}, peer {peer}")
            }
            Self::MinorMismatch { local, peer } => write!(
                f,
                "no compatible protocol minor: local {local}, peer {peer}"
            ),
        }
    }
}
impl std::error::Error for ProtocolError {}

pub fn negotiate_protocol(
    local: ProtocolVersion,
    peer: ProtocolVersion,
) -> Result<ProtocolVersion, ProtocolError> {
    if local.major != peer.major {
        return Err(ProtocolError::MajorMismatch { local, peer });
    }
    // Minor versions are backwards-compatible: the lower version is the
    // common wire dialect. A zero minor is still a valid negotiated protocol.
    Ok(ProtocolVersion {
        major: local.major,
        minor: local.minor.min(peer.minor),
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BridgeErrorCode {
    #[serde(rename = "ERR_PROTOCOL_VERSION")]
    ProtocolVersion,
    #[serde(rename = "ERR_INVALID_MANIFEST")]
    InvalidManifest,
    #[serde(rename = "ERR_MODULE_LOAD")]
    ModuleLoad,
    #[serde(rename = "ERR_UNSUPPORTED_CAPABILITY")]
    UnsupportedCapability,
    #[serde(rename = "ERR_PERMISSION_DENIED")]
    PermissionDenied,
    #[serde(rename = "ERR_TIMEOUT")]
    Timeout,
    #[serde(rename = "ERR_CANCELLED")]
    Cancelled,
    #[serde(rename = "ERR_RENDER")]
    Render,
    #[serde(rename = "ERR_ENGINE")]
    Engine,
    #[serde(rename = "ERR_INVALID_REQUEST")]
    InvalidRequest,
}

impl BridgeErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProtocolVersion => "ERR_PROTOCOL_VERSION",
            Self::InvalidManifest => "ERR_INVALID_MANIFEST",
            Self::ModuleLoad => "ERR_MODULE_LOAD",
            Self::UnsupportedCapability => "ERR_UNSUPPORTED_CAPABILITY",
            Self::PermissionDenied => "ERR_PERMISSION_DENIED",
            Self::Timeout => "ERR_TIMEOUT",
            Self::Cancelled => "ERR_CANCELLED",
            Self::Render => "ERR_RENDER",
            Self::Engine => "ERR_ENGINE",
            Self::InvalidRequest => "ERR_INVALID_REQUEST",
        }
    }
}
impl fmt::Display for BridgeErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default)]
    pub retryable: bool,
}

impl BridgeError {
    pub fn new(code: BridgeErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            request_id: None,
            retryable: false,
        }
    }
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::new(BridgeErrorCode::ProtocolVersion, message)
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(BridgeErrorCode::InvalidRequest, message)
    }
    pub fn with_request_id(mut self, request_id: impl Into<String>) -> Self {
        self.request_id = Some(request_id.into());
        self
    }
    pub fn as_payload(&self) -> serde_json::Value {
        serde_json::to_value(self).expect("BridgeError is serializable")
    }
}
impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for BridgeError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapabilityMatrix {
    values: BTreeMap<String, CapabilitySupport>,
}
impl CapabilityMatrix {
    pub fn new(values: BTreeMap<String, CapabilitySupport>) -> Self {
        Self { values }
    }
    pub fn insert(&mut self, name: impl Into<String>, support: CapabilitySupport) {
        self.values.insert(name.into(), support);
    }
    pub fn get(&self, name: &str) -> CapabilitySupport {
        self.values
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported)
    }
    pub fn iter(&self) -> impl Iterator<Item = (&String, &CapabilitySupport)> {
        self.values.iter()
    }
    pub fn as_map(&self) -> &BTreeMap<String, CapabilitySupport> {
        &self.values
    }

    pub fn negotiate(
        &self,
        requested: &BTreeMap<String, CapabilitySupport>,
    ) -> Result<CapabilityMatrix, BridgeError> {
        let mut result = BTreeMap::new();
        for (name, minimum) in requested {
            let available = self.get(name);
            if !supports(available, *minimum) {
                return Err(BridgeError::new(
                    BridgeErrorCode::UnsupportedCapability,
                    format!("{name} requires {minimum:?}, host provides {available:?}"),
                ));
            }
            result.insert(name.clone(), available);
        }
        Ok(Self::new(result))
    }
}

fn supports(available: CapabilitySupport, minimum: CapabilitySupport) -> bool {
    fn rank(level: CapabilitySupport) -> u8 {
        match level {
            CapabilitySupport::Unsupported => 0,
            CapabilitySupport::Partial => 1,
            CapabilitySupport::Full => 2,
        }
    }
    rank(available) >= rank(minimum)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityHandshake {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: String,
    #[serde(default)]
    pub capabilities: BTreeMap<String, CapabilitySupport>,
}

pub fn negotiate_handshake(
    local: &CapabilityHandshake,
    peer: &CapabilityHandshake,
) -> Result<CapabilityHandshake, BridgeError> {
    let local_version = ProtocolVersion::parse(&local.protocol_version)
        .map_err(|e| BridgeError::protocol(e.to_string()))?;
    let peer_version = ProtocolVersion::parse(&peer.protocol_version)
        .map_err(|e| BridgeError::protocol(e.to_string()))?;
    let version = negotiate_protocol(local_version, peer_version)
        .map_err(|e| BridgeError::protocol(e.to_string()))?;
    let local_matrix = CapabilityMatrix::new(local.capabilities.clone());
    let peer_matrix = CapabilityMatrix::new(peer.capabilities.clone());
    let mut common = BTreeMap::new();
    for name in local
        .capabilities
        .keys()
        .filter(|name| peer.capabilities.contains_key(*name))
    {
        let level = min_support(local_matrix.get(name), peer_matrix.get(name));
        common.insert(name.clone(), level);
    }
    Ok(CapabilityHandshake {
        protocol_version: version.to_string(),
        capabilities: common,
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

#[derive(Clone, Debug)]
pub struct CancellationToken {
    id: String,
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
}

#[derive(Debug, Default)]
pub struct CancellationRegistry {
    next_id: AtomicU64,
    tokens: Mutex<BTreeMap<String, CancellationToken>>,
}

impl CancellationRegistry {
    pub fn register(&self, id: impl Into<String>) -> CancellationToken {
        let token = CancellationToken::new(id);
        self.tokens
            .lock()
            .expect("cancellation registry lock poisoned")
            .insert(token.id.clone(), token.clone());
        token
    }
    pub fn register_generated(&self) -> CancellationToken {
        let id = format!(
            "cancel-{}",
            self.next_id.fetch_add(1, Ordering::Relaxed) + 1
        );
        self.register(id)
    }
    pub fn cancel(&self, id: &str) -> bool {
        self.tokens
            .lock()
            .expect("cancellation registry lock poisoned")
            .get(id)
            .map(|token| {
                token.cancel();
                true
            })
            .unwrap_or(false)
    }
    pub fn is_cancelled(&self, id: &str) -> bool {
        self.tokens
            .lock()
            .expect("cancellation registry lock poisoned")
            .get(id)
            .map(CancellationToken::is_cancelled)
            .unwrap_or(false)
    }
    pub fn remove(&self, id: &str) -> Option<CancellationToken> {
        self.tokens
            .lock()
            .expect("cancellation registry lock poisoned")
            .remove(id)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BridgeBatch {
    pub messages: Vec<BridgeEnvelope>,
}

impl BridgeBatch {
    pub fn new(messages: Vec<BridgeEnvelope>) -> Self {
        Self { messages }
    }
    pub fn validate(&self) -> Result<(), BridgeError> {
        let Some(first) = self.messages.first() else {
            return Ok(());
        };
        first.validate()?;
        for message in &self.messages[1..] {
            message.validate()?;
            if message.session_id != first.session_id
                || message.protocol_version != first.protocol_version
            {
                return Err(BridgeError::protocol(
                    "batch messages must share session and protocol version",
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn envelope_round_trips_wire_field_names() {
        let envelope =
            BridgeEnvelope::request("s1", "r1", op::DATA_PATCH_BATCH, json!({"count": 2}));
        let value = serde_json::to_value(&envelope).unwrap();
        assert_eq!(value["protocolVersion"], "1.0");
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["requestId"], "r1");
        assert!(envelope.validate().is_ok());
    }

    #[test]
    fn protocol_and_capability_negotiation_are_explicit() {
        assert_eq!(
            negotiate_protocol(
                ProtocolVersion { major: 1, minor: 3 },
                ProtocolVersion { major: 1, minor: 1 }
            )
            .unwrap()
            .to_string(),
            "1.1"
        );
        assert!(matches!(
            negotiate_protocol(
                ProtocolVersion { major: 1, minor: 0 },
                ProtocolVersion { major: 2, minor: 0 }
            ),
            Err(ProtocolError::MajorMismatch { .. })
        ));
        let mut local = BTreeMap::new();
        local.insert("storage".into(), CapabilitySupport::Full);
        local.insert("camera".into(), CapabilitySupport::Partial);
        let mut peer = BTreeMap::new();
        peer.insert("storage".into(), CapabilitySupport::Full);
        peer.insert("camera".into(), CapabilitySupport::Unsupported);
        let handshake = negotiate_handshake(
            &CapabilityHandshake {
                protocol_version: "1.0".into(),
                capabilities: local,
            },
            &CapabilityHandshake {
                protocol_version: "1.0".into(),
                capabilities: peer,
            },
        )
        .unwrap();
        assert_eq!(
            handshake.capabilities["camera"],
            CapabilitySupport::Unsupported
        );
    }

    #[test]
    fn cancellation_registry_is_shared_between_host_and_worker() {
        let registry = CancellationRegistry::default();
        let token = registry.register_generated();
        assert!(!token.is_cancelled());
        assert!(registry.cancel(token.id()));
        assert!(token.is_cancelled());
        assert!(registry.is_cancelled(token.id()));
        registry.remove(token.id());
        assert!(!registry.is_cancelled(token.id()));
    }

    #[test]
    fn batch_rejects_mixed_sessions() {
        let a = BridgeEnvelope::event("a", op::DIAGNOSTIC, json!({}));
        let b = BridgeEnvelope::event("b", op::DIAGNOSTIC, json!({}));
        assert_eq!(
            BridgeBatch::new(vec![a, b]).validate().unwrap_err().code,
            BridgeErrorCode::ProtocolVersion
        );
    }
}
