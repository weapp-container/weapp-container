//! Bounded correlation and final receipts for the browser development owner.
//!
//! No clock, filesystem, socket, process, thread, callback or coordinator mutation.
//! `std::io::Write` below writes only into a capped in-memory Vec. The owner loop
//! supplies deadlines, source barriers, authenticated run/client identity and actual
//! coordinator results. Never call a coordinator operation again to recover a reply.

use crate::browser_dev_coordinator::{
    ActivationPermit, BeginActivation, CloseTicket, CoordinatorSnapshot, EvidenceOrigin, OwnerKey,
    OwnerStartPermit, OwnerTuple, PresentedReceipt, PreviewLease, RpcIdentity, RuntimeReadyReceipt,
    StartTicket, WireU64, BROWSER_DEV_VERSION,
};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Arc;

pub const MAX_CONTROL_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_CONTROL_FINAL_BYTES: usize = 256 * 1024;
pub const MAX_CONTROL_RETIREMENT_BYTES: usize = 4096;
pub const MAX_CONTROL_RETIREMENT_ENTRIES: usize = 64;
pub const BROWSER_WORKER_CLOSE_VERSION: &str = "1.0";
const MAX_JSON_DEPTH: usize = 32;
const MAX_JSON_NODES: usize = 4096;
// Per-entry fixed accounting includes small DTO strings, hashes and map metadata.
// This is a conservative logical retained-byte charge, not an allocator/RSS claim.
const ENTRY_OVERHEAD: usize = 4096;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ControlError {
    #[error("ERR_PROTOCOL_VERSION: invalid {0}")]
    Invalid(&'static str),
    #[error("ERR_PERMISSION_DENIED: wrong control run/client")]
    WrongIdentity,
    #[error("ERR_PROTOCOL_VERSION: requestId reused with different command/payload")]
    Conflict,
    #[error("ERR_CANCELLED: old unseen/retired request; mutation replay is forbidden")]
    RetiredOrUnseen,
    #[error("ERR_CANCELLED: control capacity exhausted before execution")]
    Capacity,
    #[error("ERR_CANCELLED: request is not queued")]
    NotQueued,
    #[error("ERR_CANCELLED: execution ticket is stale or no longer executing")]
    NotExecuting,
    #[error("ERR_PROTOCOL_VERSION: control value exceeds its retained-byte bound")]
    TooLarge,
    #[error("ERR_CANCELLED: final acknowledgement does not match retained bytes")]
    AckMismatch,
}
type Result<T> = std::result::Result<T, ControlError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlCommand {
    Snapshot,
    IssueActivation,
    CancelActivation,
    BeginActivation,
    FinishClose,
    AbandonStart,
    StartOwner,
    FailOwner,
    RuntimeReady,
    PresentedReady,
    RetryClose,
    Stop,
}
impl ControlCommand {
    fn lane(self) -> Lane {
        match self {
            Self::CancelActivation
            | Self::FinishClose
            | Self::AbandonStart
            | Self::FailOwner
            | Self::RetryClose
            | Self::Stop => Lane::Cleanup,
            _ => Lane::Normal,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lane {
    Normal,
    Cleanup,
}
impl Lane {
    fn namespace(self) -> &'static str {
        match self {
            Self::Normal => "control",
            Self::Cleanup => "cleanup",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IncomingRequest {
    version: String,
    request_id: String,
    command: ControlCommand,
    payload: Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmptyPayload {}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueActivationPayload {
    pub preview: PreviewLease,
    pub site_id: WireU64,
    pub expected_control_revision: WireU64,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CancelActivationPayload {
    pub preview: PreviewLease,
    pub permit: ActivationPermit,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BeginActivationPayload {
    pub permit: ActivationPermit,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartOwnerPayload {
    pub ticket: StartTicket,
    pub client_owner_id: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AbandonStartPayload {
    pub ticket: StartTicket,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FailOwnerPayload {
    pub owner_key: OwnerKey,
    pub message: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryClosePayload {
    pub preview: PreviewLease,
    pub expected_control_revision: WireU64,
    pub expected_terminal_cleanup_revision: WireU64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorFact {
    pub code: String,
    pub message: String,
}
impl ErrorFact {
    pub fn new(code: &str, message: &str) -> Result<Self> {
        if code.is_empty() || code.len() > 128 || message.is_empty() || message.len() > 2048 {
            return Err(ControlError::Invalid("bounded error fact"));
        }
        Ok(Self {
            code: code.to_owned(),
            message: message.to_owned(),
        })
    }
    fn validate(&self) -> Result<()> {
        Self::new(&self.code, &self.message).map(|_| ())
    }
}

/// Shape only. A report of the SAME wrapper's actual close barrier, including
/// RPC allocation before pack admission. These fields cannot prove cleanup or
/// grant authority. The integrating owner must retain the actual local barrier.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserWorkerCloseReceipt {
    pub version: String,
    pub closed: bool,
    pub worker_closed: bool,
    pub owned_mount_removed: bool,
    #[serde(deserialize_with = "required_nullable")]
    pub owner: Option<OwnerTuple>,
    #[serde(deserialize_with = "required_nullable")]
    pub rpc_identity: Option<RpcIdentity>,
    #[serde(deserialize_with = "required_nullable")]
    pub worker_final: Option<Value>,
}

// deserialize_with deliberately makes these fields REQUIRED even though null
// is valid. Serde's default Option handling would accept a missing identity.
fn required_nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

impl BrowserWorkerCloseReceipt {
    fn validate_shape(&self) -> Result<()> {
        if self.version != BROWSER_WORKER_CLOSE_VERSION
            || !self.closed
            || !self.worker_closed
            || !self.owned_mount_removed
        {
            return Err(ControlError::Invalid("worker close receipt"));
        }
        if let Some(rpc) = &self.rpc_identity {
            rpc.validate()
                .map_err(|_| ControlError::Invalid("worker close RPC identity"))?;
            if !self
                .worker_final
                .as_ref()
                .and_then(Value::as_object)
                .is_some_and(|result| result.get("closed") == Some(&Value::Bool(true)))
            {
                return Err(ControlError::Invalid("worker close final"));
            }
        } else if self.worker_final.is_some() {
            return Err(ControlError::Invalid("worker final without RPC allocation"));
        }
        if let Some(owner) = &self.owner {
            owner
                .validate()
                .map_err(|_| ControlError::Invalid("worker close owner tuple"))?;
            let Some(rpc) = &self.rpc_identity else {
                return Err(ControlError::Invalid(
                    "worker close owner without RPC identity",
                ));
            };
            if owner.worker_epoch != rpc.worker_epoch || owner.session_id != rpc.session_id {
                return Err(ControlError::Invalid("worker close identity mismatch"));
            }
        }
        Ok(())
    }
}

/// Shape only. These are untrusted browser reports. The actual HTTP owner adapter
/// must correlate the exact registered intent/local barrier before deriving the
/// boolean passed to coordinator.finish_close. This DTO grants no JS authority.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCloseReport {
    pub evidence_origin: EvidenceOrigin,
    pub success: bool,
    pub pending_actual: bool,
    pub owner_key: Option<OwnerKey>,
    pub outcome: Option<String>,
    pub receipt: Option<BrowserWorkerCloseReceipt>,
    pub worker_closed: Option<bool>,
    pub owned_mount_removed: Option<bool>,
    pub error: Option<ErrorFact>,
}
impl BrowserCloseReport {
    fn validate_shape(&self, ticket: &CloseTicket) -> Result<()> {
        if !self.success {
            if self.owner_key.is_some()
                || self.outcome.is_some()
                || self.receipt.is_some()
                || self.worker_closed.is_some()
                || self.owned_mount_removed.is_some()
            {
                return Err(ControlError::Invalid("failure close report"));
            }
            return self
                .error
                .as_ref()
                .ok_or(ControlError::Invalid("close error"))?
                .validate();
        }
        if self.pending_actual
            || self.owner_key.as_ref() != Some(&ticket.owner)
            || self.error.is_some()
        {
            return Err(ControlError::Invalid("success close report"));
        }
        match self.outcome.as_deref() {
            Some("closed")
                if self.worker_closed.is_none() && self.owned_mount_removed.is_none() =>
            {
                self.receipt
                    .as_ref()
                    .ok_or(ControlError::Invalid("worker close receipt missing"))?
                    .validate_shape()
            }
            Some("never-constructed")
                if self.receipt.is_none()
                    && self.worker_closed == Some(true)
                    && self.owned_mount_removed == Some(true) =>
            {
                Ok(())
            }
            _ => Err(ControlError::Invalid("close outcome")),
        }
    }
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FinishClosePayload {
    pub ticket: CloseTicket,
    pub close_final: BrowserCloseReport,
}

#[derive(Clone, Debug)]
pub enum ControlOperation {
    Snapshot(EmptyPayload),
    IssueActivation(IssueActivationPayload),
    CancelActivation(CancelActivationPayload),
    BeginActivation(BeginActivationPayload),
    FinishClose(FinishClosePayload),
    AbandonStart(AbandonStartPayload),
    StartOwner(StartOwnerPayload),
    FailOwner(FailOwnerPayload),
    RuntimeReady(RuntimeReadyReceipt),
    PresentedReady(PresentedReceipt),
    RetryClose(RetryClosePayload),
    Stop(EmptyPayload),
}
fn decode_payload(command: ControlCommand, payload: Value) -> Result<ControlOperation> {
    fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T> {
        serde_json::from_value(value).map_err(|_| ControlError::Invalid("typed control payload"))
    }
    let operation = match command {
        ControlCommand::Snapshot => ControlOperation::Snapshot(decode(payload)?),
        ControlCommand::IssueActivation => ControlOperation::IssueActivation(decode(payload)?),
        ControlCommand::CancelActivation => ControlOperation::CancelActivation(decode(payload)?),
        ControlCommand::BeginActivation => ControlOperation::BeginActivation(decode(payload)?),
        ControlCommand::FinishClose => ControlOperation::FinishClose(decode(payload)?),
        ControlCommand::AbandonStart => ControlOperation::AbandonStart(decode(payload)?),
        ControlCommand::StartOwner => ControlOperation::StartOwner(decode(payload)?),
        ControlCommand::FailOwner => ControlOperation::FailOwner(decode(payload)?),
        ControlCommand::RuntimeReady => ControlOperation::RuntimeReady(decode(payload)?),
        ControlCommand::PresentedReady => ControlOperation::PresentedReady(decode(payload)?),
        ControlCommand::RetryClose => ControlOperation::RetryClose(decode(payload)?),
        ControlCommand::Stop => ControlOperation::Stop(decode(payload)?),
    };
    match &operation {
        ControlOperation::FinishClose(value) => value.close_final.validate_shape(&value.ticket)?,
        ControlOperation::FailOwner(value)
            if value.message.is_empty() || value.message.len() > 2048 =>
        {
            return Err(ControlError::Invalid("owner failure message"));
        }
        ControlOperation::StartOwner(value) => valid_identifier(&value.client_owner_id, 128)?,
        _ => {}
    }
    Ok(operation)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlIdentity {
    pub version: &'static str,
    pub run_id: String,
    pub request_id: String,
    pub command: ControlCommand,
    pub payload_sha256: String,
    // Local identity used for ordering; no new commandId field on the JS wire.
    #[serde(skip)]
    serial: WireU64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedReceipt {
    #[serde(flatten)]
    pub identity: ControlIdentity,
    pub status: &'static str,
}
#[derive(Clone, Debug)]
struct BoundRequest {
    identity: ControlIdentity,
    canonical: Arc<[u8]>,
}
impl BoundRequest {
    fn decode(&self) -> Result<ControlOperation> {
        let request: IncomingRequest = serde_json::from_slice(&self.canonical)
            .map_err(|_| ControlError::Invalid("retained request"))?;
        decode_payload(request.command, request.payload)
    }
    fn queued(&self) -> QueuedReceipt {
        QueuedReceipt {
            identity: self.identity.clone(),
            status: "queued",
        }
    }
}

/// Exact result DTOs; each variant is serialized as its inner DTO (or null), not
/// as an invented enum wrapper. `Unit` matches only operations returning null.
#[derive(Clone, Debug)]
pub enum ControlResult {
    Snapshot(Box<CoordinatorSnapshot>),
    IssueActivation(ActivationPermit),
    BeginActivation(BeginActivation),
    FinishClose(Option<StartTicket>),
    StartOwner(OwnerStartPermit),
    FailOwner(CloseTicket),
    RetryClose(CloseTicket),
    Stop(Option<CloseTicket>),
    Unit,
}
impl ControlResult {
    fn matches(&self, command: ControlCommand) -> bool {
        matches!(
            (self, command),
            (Self::Snapshot(_), ControlCommand::Snapshot)
                | (Self::IssueActivation(_), ControlCommand::IssueActivation)
                | (Self::BeginActivation(_), ControlCommand::BeginActivation)
                | (Self::FinishClose(_), ControlCommand::FinishClose)
                | (Self::StartOwner(_), ControlCommand::StartOwner)
                | (Self::FailOwner(_), ControlCommand::FailOwner)
                | (Self::RetryClose(_), ControlCommand::RetryClose)
                | (Self::Stop(_), ControlCommand::Stop)
                | (
                    Self::Unit,
                    ControlCommand::CancelActivation
                        | ControlCommand::AbandonStart
                        | ControlCommand::RuntimeReady
                        | ControlCommand::PresentedReady
                )
        )
    }
}
impl Serialize for ControlResult {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Snapshot(value) => value.serialize(serializer),
            Self::IssueActivation(value) => value.serialize(serializer),
            Self::BeginActivation(value) => value.serialize(serializer),
            Self::FinishClose(value) => value.serialize(serializer),
            Self::StartOwner(value) => value.serialize(serializer),
            Self::FailOwner(value) | Self::RetryClose(value) => value.serialize(serializer),
            Self::Stop(value) => value.serialize(serializer),
            Self::Unit => serializer.serialize_unit(),
        }
    }
}
#[derive(Clone, Debug)]
pub enum FinalOutcome {
    Ok(Box<ControlResult>),
    Error(ErrorFact),
}
#[derive(Clone, Debug)]
pub struct FinalDraft {
    pub snapshot: CoordinatorSnapshot,
    pub outcome: FinalOutcome,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FinalEnvelope<'a> {
    version: &'static str,
    request_id: &'a str,
    command: ControlCommand,
    status: &'static str,
    snapshot: &'a CoordinatorSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<&'a ControlResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'a ErrorFact>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TombstoneKind {
    NeverExecuted,
    ExecutionUncertain,
    FinalCompacted,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlTombstone {
    pub identity: ControlIdentity,
    pub kind: TombstoneKind,
    pub error: ErrorFact,
    pub final_sha256: Option<String>,
}
#[derive(Clone, Debug)]
pub enum ControlLookup {
    Queued(QueuedReceipt),
    Executing(QueuedReceipt),
    Final(Arc<Vec<u8>>),
    Tombstone(ControlTombstone),
}
#[derive(Clone, Debug)]
enum EntryState {
    Queued,
    Executing,
    Prepared(Arc<Vec<u8>>),
    Final(Arc<Vec<u8>>),
    Tombstone(ControlTombstone),
}
#[derive(Clone, Debug)]
struct Entry {
    request: BoundRequest,
    state: EntryState,
    charge: usize,
}
impl Entry {
    fn lookup(&self) -> ControlLookup {
        match &self.state {
            EntryState::Queued => ControlLookup::Queued(self.request.queued()),
            EntryState::Executing | EntryState::Prepared(_) => {
                ControlLookup::Executing(self.request.queued())
            }
            EntryState::Final(bytes) => ControlLookup::Final(Arc::clone(bytes)),
            EntryState::Tombstone(value) => ControlLookup::Tombstone(value.clone()),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LaneLimit {
    pub max_entries: usize,
    pub max_bytes: usize,
}
#[derive(Clone, Copy, Debug)]
pub struct ControlLimits {
    pub normal: LaneLimit,
    pub cleanup: LaneLimit,
}
impl Default for ControlLimits {
    fn default() -> Self {
        Self {
            normal: LaneLimit {
                max_entries: 4096,
                max_bytes: 16 * 1024 * 1024,
            },
            cleanup: LaneLimit {
                max_entries: 16_416,
                max_bytes: 8 * 1024 * 1024,
            },
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LaneUsage {
    pub entries: usize,
    pub bytes: usize,
}

#[derive(Clone, Debug)]
pub struct ExecutionTicket {
    identity: ControlIdentity,
}
impl ExecutionTicket {
    pub fn identity(&self) -> &ControlIdentity {
        &self.identity
    }
}
#[derive(Debug)]
pub struct BegunControl {
    pub ticket: ExecutionTicket,
    pub operation: ControlOperation,
}
#[derive(Debug)]
#[must_use = "commit the retained final, or recover it using the exact execution ticket"]
pub struct PreparedFinal {
    ticket: ExecutionTicket,
}
/// An authenticated acknowledgement compacts an original retained final only.
/// Retired/unseen IDs are errors: their original final hash is no longer known.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum FinalAckOutcome {
    Compacted,
    AlreadyCompacted,
}

#[derive(Clone, Debug)]
pub struct FinalAcknowledgement {
    pub identity: ControlIdentity,
    pub final_sha256: String,
}

/// An explicitly negotiated retirement transaction, outside mutation serials.
/// All decimal fields use the same canonical string encoding as control IDs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRetirementRequest {
    pub version: String,
    pub lane: Lane,
    pub previous_through: WireU64,
    pub through_serial: WireU64,
    pub prefix_sha256: String,
}
impl ControlRetirementRequest {
    pub fn validate(&self) -> Result<()> {
        if self.version != BROWSER_DEV_VERSION
            || self.through_serial.get() <= self.previous_through.get()
            || self.prefix_sha256.len() != 64
            || !self
                .prefix_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ControlError::Invalid("retirement request"));
        }
        Ok(())
    }
}

/// The original success is retained once per lane. Exact lost-reply retries
/// return this same value; no new mutation or recursive final ACK is created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlRetirementReply {
    pub version: &'static str,
    pub run_id: String,
    pub client_id: String,
    pub lane: Lane,
    pub previous_through: WireU64,
    pub through_serial: WireU64,
    pub prefix_sha256: String,
    pub retired_count: usize,
    pub outcome: &'static str,
}

#[derive(Debug, Default)]
struct RetirementState {
    through: u64,
    // Fixed count: one bounded request/reply per lane, never a growing ledger.
    latest: Option<(ControlRetirementRequest, ControlRetirementReply)>,
}

/// One run + one authenticated/elected manager client. A replacement client
/// requires the owner adapter's lease transfer/cleanup protocol and a NEW ledger;
/// never reset this ledger to make an ambiguous old request appear new.
#[derive(Debug)]
pub struct ControlLedger {
    run_id: String,
    client_id: String,
    normal_highest: WireU64,
    cleanup_highest: WireU64,
    entries: BTreeMap<(Lane, u64), Entry>,
    limits: ControlLimits,
    normal: LaneUsage,
    cleanup: LaneUsage,
    normal_retirement: RetirementState,
    cleanup_retirement: RetirementState,
}
impl ControlLedger {
    pub fn new(run_id: String, client_id: String, limits: ControlLimits) -> Result<Self> {
        valid_identifier(&run_id, 128)?;
        valid_identifier(&client_id, 64)?;
        for limit in [limits.normal, limits.cleanup] {
            if limit.max_entries == 0
                || limit.max_entries > 65_536
                || limit.max_bytes < ENTRY_OVERHEAD + MAX_CONTROL_FINAL_BYTES
                || limit.max_bytes > 256 * 1024 * 1024
            {
                return Err(ControlError::Invalid("finite lane limits"));
            }
        }
        Ok(Self {
            run_id,
            client_id,
            normal_highest: WireU64::new(0),
            cleanup_highest: WireU64::new(0),
            entries: BTreeMap::new(),
            limits,
            normal: LaneUsage::default(),
            cleanup: LaneUsage::default(),
            normal_retirement: RetirementState::default(),
            cleanup_retirement: RetirementState::default(),
        })
    }
    pub fn usage(&self, lane: Lane) -> LaneUsage {
        match lane {
            Lane::Normal => self.normal,
            Lane::Cleanup => self.cleanup,
        }
    }
    /// Read-only delivery cleanup gate over both original lanes. An empty
    /// ledger or acknowledged/compacted finals may remain; neither querying
    /// this gate nor dropping a response acknowledges or retires an entry.
    ///
    /// NeverExecuted proves absence of execution, but has no acknowledged
    /// final, so it still blocks delivery cleanup. Queued, executing, prepared,
    /// unacknowledged final and execution-uncertain entries also remain blocked.
    pub fn cleanup_ready(&self) -> bool {
        self.entries.values().all(|entry| {
            matches!(&entry.state, EntryState::Tombstone(tombstone)
                if tombstone.kind == TombstoneKind::FinalCompacted)
        })
    }
    pub fn seen_through(&self, lane: Lane) -> WireU64 {
        match lane {
            Lane::Normal => self.normal_highest,
            Lane::Cleanup => self.cleanup_highest,
        }
    }
    fn lane_mut(&mut self, lane: Lane) -> &mut LaneUsage {
        match lane {
            Lane::Normal => &mut self.normal,
            Lane::Cleanup => &mut self.cleanup,
        }
    }
    fn bind(&self, run_id: &str, bytes: &[u8]) -> Result<BoundRequest> {
        if run_id != self.run_id {
            return Err(ControlError::WrongIdentity);
        }
        if bytes.len() > MAX_CONTROL_REQUEST_BYTES {
            return Err(ControlError::TooLarge);
        }
        let unique: UniqueValue =
            serde_json::from_slice(bytes).map_err(|_| ControlError::Invalid("control request"))?;
        let request: IncomingRequest = serde_json::from_value(unique.0)
            .map_err(|_| ControlError::Invalid("control request envelope"))?;
        if request.version != BROWSER_DEV_VERSION {
            return Err(ControlError::Invalid("version"));
        }
        let prefix = format!("{}:{}-", self.client_id, request.command.lane().namespace());
        let suffix = request
            .request_id
            .strip_prefix(&prefix)
            .ok_or(ControlError::WrongIdentity)?;
        let serial = suffix
            .parse::<u64>()
            .map_err(|_| ControlError::Invalid("request serial"))?;
        if serial == 0 || serial.to_string() != suffix {
            return Err(ControlError::Invalid("canonical positive request serial"));
        }
        let mut nodes = 0;
        check_json(&request.payload, 0, &mut nodes)?;
        // Decode now, before reserving capacity or advancing high-water. Full
        // coordinator authority/receipt validation still belongs to owner loop.
        decode_payload(request.command, request.payload.clone())?;
        let payload_bytes =
            encode_bounded(&CanonicalValue(&request.payload), MAX_CONTROL_REQUEST_BYTES)?;
        let payload_sha256 = format!("{:x}", Sha256::digest(&payload_bytes));
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct CanonicalRequest<'a> {
            version: &'static str,
            request_id: &'a str,
            command: ControlCommand,
            payload: CanonicalValue<'a>,
        }
        let canonical = encode_bounded(
            &CanonicalRequest {
                version: BROWSER_DEV_VERSION,
                request_id: &request.request_id,
                command: request.command,
                payload: CanonicalValue(&request.payload),
            },
            MAX_CONTROL_REQUEST_BYTES,
        )?;
        Ok(BoundRequest {
            identity: ControlIdentity {
                version: BROWSER_DEV_VERSION,
                run_id: self.run_id.clone(),
                request_id: request.request_id,
                command: request.command,
                payload_sha256,
                serial: WireU64::new(serial),
            },
            canonical: Arc::from(canonical),
        })
    }
    /// New admission or exact retained replay. Conflicts/retired misses never
    /// enqueue, advance high-water, mint owner IDs or allocate another owner.
    pub fn admit(&mut self, run_id: &str, bytes: &[u8]) -> Result<ControlLookup> {
        let request = self.bind(run_id, bytes)?;
        let serial = request.identity.serial.get();
        let lane = request.identity.command.lane();
        let key = (lane, serial);
        if let Some(entry) = self.entries.get(&key) {
            if entry.request.identity != request.identity
                || entry.request.canonical != request.canonical
            {
                return Err(ControlError::Conflict);
            }
            return Ok(entry.lookup());
        }
        if serial <= self.seen_through(lane).get() {
            return Err(ControlError::RetiredOrUnseen);
        }
        let limit = match lane {
            Lane::Normal => self.limits.normal,
            Lane::Cleanup => self.limits.cleanup,
        };
        let usage = self.usage(lane);
        let charge = ENTRY_OVERHEAD + request.canonical.len() + MAX_CONTROL_FINAL_BYTES;
        if usage.entries >= limit.max_entries
            || usage
                .bytes
                .checked_add(charge)
                .is_none_or(|n| n > limit.max_bytes)
        {
            return Err(ControlError::Capacity);
        }
        let receipt = request.queued();
        self.entries.insert(
            key,
            Entry {
                request,
                state: EntryState::Queued,
                charge,
            },
        );
        match lane {
            Lane::Normal => self.normal_highest = WireU64::new(serial),
            Lane::Cleanup => self.cleanup_highest = WireU64::new(serial),
        };
        let usage = self.lane_mut(lane);
        usage.entries += 1;
        usage.bytes += charge;
        Ok(ControlLookup::Queued(receipt))
    }
    /// Exact replay lookup is read-only and cannot admit an unseen command.
    pub fn lookup(&self, run_id: &str, bytes: &[u8]) -> Result<ControlLookup> {
        let request = self.bind(run_id, bytes)?;
        let entry = self
            .entries
            .get(&(
                request.identity.command.lane(),
                request.identity.serial.get(),
            ))
            .ok_or(ControlError::RetiredOrUnseen)?;
        if entry.request.identity != request.identity
            || entry.request.canonical != request.canonical
        {
            return Err(ControlError::Conflict);
        }
        Ok(entry.lookup())
    }
    fn exact(&self, identity: &ControlIdentity) -> Result<&Entry> {
        if identity.run_id != self.run_id {
            return Err(ControlError::WrongIdentity);
        }
        let entry = self
            .entries
            .get(&(identity.command.lane(), identity.serial.get()))
            .ok_or(ControlError::RetiredOrUnseen)?;
        if entry.request.identity != *identity {
            return Err(ControlError::Conflict);
        }
        Ok(entry)
    }
    pub fn begin(&mut self, identity: &ControlIdentity) -> Result<BegunControl> {
        let entry = self.exact(identity)?;
        if !matches!(entry.state, EntryState::Queued) {
            return Err(ControlError::NotQueued);
        }
        let operation = entry.request.decode()?;
        self.entries
            .get_mut(&(identity.command.lane(), identity.serial.get()))
            .expect("checked exact entry")
            .state = EntryState::Executing;
        Ok(BegunControl {
            ticket: ExecutionTicket {
                identity: identity.clone(),
            },
            operation,
        })
    }
    fn final_bytes(
        &self,
        identity: &ControlIdentity,
        final_value: &FinalDraft,
    ) -> Result<Arc<Vec<u8>>> {
        if final_value.snapshot.version != BROWSER_DEV_VERSION
            || final_value.snapshot.run_id != self.run_id
        {
            return Err(ControlError::WrongIdentity);
        }
        let (status, result, error) = match &final_value.outcome {
            FinalOutcome::Ok(boxed) => {
                let value = boxed.as_ref();
                if !value.matches(identity.command) {
                    return Err(ControlError::Invalid("command/result pairing"));
                }
                if let ControlResult::IssueActivation(permit) = value {
                    if permit.control_revision != final_value.snapshot.control_revision {
                        return Err(ControlError::Invalid("permit/final revision"));
                    }
                }
                if let ControlResult::Snapshot(snapshot) = value {
                    if encode_bounded(snapshot, MAX_CONTROL_FINAL_BYTES)?
                        != encode_bounded(&final_value.snapshot, MAX_CONTROL_FINAL_BYTES)?
                    {
                        return Err(ControlError::Invalid("snapshot result projection"));
                    }
                }
                ("ok", Some(value), None)
            }
            FinalOutcome::Error(value) => {
                value.validate()?;
                ("error", None, Some(value))
            }
        };
        Ok(Arc::new(encode_bounded(
            &FinalEnvelope {
                version: BROWSER_DEV_VERSION,
                request_id: &identity.request_id,
                command: identity.command,
                status,
                snapshot: &final_value.snapshot,
                result,
                error,
            },
            MAX_CONTROL_FINAL_BYTES,
        )?))
    }
    /// Optional preflight while the caller still owns uncommitted candidate work.
    /// Normal trusted coordinator DTOs are bounded far below the reserved final
    /// cap; this also fails closed if future DTO growth violates that boundary.
    pub fn prepare_final(
        &mut self,
        ticket: &ExecutionTicket,
        final_value: FinalDraft,
    ) -> Result<PreparedFinal> {
        if !matches!(self.exact(&ticket.identity)?.state, EntryState::Executing) {
            return Err(ControlError::NotExecuting);
        }
        let bytes = self.final_bytes(&ticket.identity, &final_value)?;
        self.entries
            .get_mut(&(ticket.identity.command.lane(), ticket.identity.serial.get()))
            .expect("checked execution")
            .state = EntryState::Prepared(bytes);
        Ok(PreparedFinal {
            ticket: ticket.clone(),
        })
    }
    /// Retain before emitting any HTTP/SSE response. The returned Arc and all
    /// exact replays reference the same immutable bytes, including old snapshot.
    pub fn commit_prepared_final(&mut self, prepared: PreparedFinal) -> Result<Arc<Vec<u8>>> {
        self.commit_retained_final(&prepared.ticket)
    }
    /// Recover a lost PreparedFinal token using the exact original execution
    /// ticket. Only the already serialized bytes can commit; no mutation is
    /// decoded or executed again and an executing/uncertain slot is refused.
    pub fn commit_retained_final(&mut self, ticket: &ExecutionTicket) -> Result<Arc<Vec<u8>>> {
        let identity = &ticket.identity;
        let EntryState::Prepared(bytes) = &self.exact(identity)?.state else {
            return Err(ControlError::NotExecuting);
        };
        let bytes = Arc::clone(bytes);
        self.replace_state(identity, EntryState::Final(Arc::clone(&bytes)));
        Ok(bytes)
    }
    pub fn finish(
        &mut self,
        ticket: &ExecutionTicket,
        final_value: FinalDraft,
    ) -> Result<Arc<Vec<u8>>> {
        let prepared = self.prepare_final(ticket, final_value)?;
        self.commit_prepared_final(prepared)
    }
    /// Caller-provided expiry/cancel, only while never executed. A serialization
    /// failure still seals a never-executed tombstone; late begin cannot mutate.
    pub fn cancel_queued(
        &mut self,
        identity: &ControlIdentity,
        snapshot: CoordinatorSnapshot,
        error: ErrorFact,
    ) -> Result<Arc<Vec<u8>>> {
        error.validate()?;
        if error.code != "ERR_CANCELLED" && error.code != "ERR_TIMEOUT" {
            return Err(ControlError::Invalid("queue cancel code"));
        }
        if !matches!(self.exact(identity)?.state, EntryState::Queued) {
            return Err(ControlError::NotQueued);
        }
        let bytes = self.final_bytes(
            identity,
            &FinalDraft {
                snapshot,
                outcome: FinalOutcome::Error(error.clone()),
            },
        );
        match bytes {
            Ok(bytes) => {
                self.replace_state(identity, EntryState::Final(Arc::clone(&bytes)));
                Ok(bytes)
            }
            Err(failure) => {
                self.replace_state(
                    identity,
                    EntryState::Tombstone(ControlTombstone {
                        identity: identity.clone(),
                        kind: TombstoneKind::NeverExecuted,
                        error,
                        final_sha256: None,
                    }),
                );
                Err(failure)
            }
        }
    }
    /// No retry transition exists. A timeout after begin may be uncertain; only
    /// exact late finish while still Executing may produce a final. Once sealed
    /// uncertain, reconciliation is external and can never create a new owner.
    pub fn mark_uncertain(&mut self, ticket: &ExecutionTicket, error: ErrorFact) -> Result<()> {
        error.validate()?;
        if !matches!(self.exact(&ticket.identity)?.state, EntryState::Executing) {
            return Err(ControlError::NotExecuting);
        }
        self.replace_state(
            &ticket.identity,
            EntryState::Tombstone(ControlTombstone {
                identity: ticket.identity.clone(),
                kind: TombstoneKind::ExecutionUncertain,
                error,
                final_sha256: None,
            }),
        );
        Ok(())
    }
    fn replace_state(&mut self, identity: &ControlIdentity, state: EntryState) {
        let entry = self
            .entries
            .get_mut(&(identity.command.lane(), identity.serial.get()))
            .expect("caller checked exact entry");
        let retained = match &state {
            EntryState::Final(bytes) => bytes.len(),
            EntryState::Tombstone(_) => 0,
            _ => MAX_CONTROL_FINAL_BYTES,
        };
        let charge = ENTRY_OVERHEAD + entry.request.canonical.len() + retained;
        let old = entry.charge;
        entry.charge = charge;
        entry.state = state;
        let usage = self.lane_mut(identity.command.lane());
        usage.bytes = usage.bytes - old + charge;
    }
    /// Bind an authenticated client's original request without a second identity
    /// store. The client must first retain and adopt the exact raw final for its
    /// lifetime; transport delivery alone is never an acknowledgement.
    ///
    /// Retries match the original compacted tombstone's SHA. This method does
    /// not retire entries: high-water alone cannot verify a retired final hash.
    pub fn acknowledge_final(
        &mut self,
        authenticated_run_id: &str,
        original_request_bytes: &[u8],
        exact_raw_final_sha256: &str,
    ) -> Result<FinalAckOutcome> {
        let request = self.bind(authenticated_run_id, original_request_bytes)?;
        if exact_raw_final_sha256.len() != 64
            || !exact_raw_final_sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err(ControlError::Invalid(
                "canonical final acknowledgement SHA-256",
            ));
        }
        let entry = self.exact(&request.identity)?;
        if entry.request.canonical != request.canonical {
            return Err(ControlError::Conflict);
        }
        match &entry.state {
            EntryState::Final(_) => {}
            EntryState::Tombstone(tombstone)
                if tombstone.kind == TombstoneKind::FinalCompacted
                    && tombstone.final_sha256.as_deref() == Some(exact_raw_final_sha256) =>
            {
                return Ok(FinalAckOutcome::AlreadyCompacted);
            }
            _ => return Err(ControlError::AckMismatch),
        }
        // Do not use lookup(): its cloned Final Arc would itself prevent the
        // original compact_final strong-count barrier from ever succeeding.
        self.compact_final(&FinalAcknowledgement {
            identity: request.identity,
            final_sha256: exact_raw_final_sha256.to_owned(),
        })?;
        Ok(FinalAckOutcome::Compacted)
    }

    /// Only call after an authenticated, exact client acknowledgement that its
    /// immutable final is durably retained for this client lifetime. Disconnect,
    /// SSE delivery, timeout and a newer snapshot are never acknowledgements.
    pub fn compact_final(&mut self, ack: &FinalAcknowledgement) -> Result<()> {
        let entry = self.exact(&ack.identity)?;
        let EntryState::Final(bytes) = &entry.state else {
            return Err(ControlError::AckMismatch);
        };
        // A pending HTTP response can retain the same body after server/client
        // acknowledgement. Do not free its byte charge while it is borrowed.
        if Arc::strong_count(bytes) != 1 {
            return Err(ControlError::Capacity);
        }
        let digest = format!("{:x}", Sha256::digest(bytes.as_slice()));
        if digest != ack.final_sha256 {
            return Err(ControlError::AckMismatch);
        }
        self.replace_state(
            &ack.identity,
            EntryState::Tombstone(ControlTombstone {
                identity: ack.identity.clone(),
                kind: TombstoneKind::FinalCompacted,
                error: ErrorFact::new(
                    "ERR_CANCELLED",
                    "exact acknowledged final compacted; never replay mutation",
                )?,
                final_sha256: Some(digest),
            }),
        );
        Ok(())
    }
    /// Atomically forget one acknowledged prefix. Cursor and latest exact
    /// transaction survive independently of admission high-water. Numeric gaps
    /// below high-water are already permanently inadmissible, never new work.
    pub fn retire_prefix(
        &mut self,
        authenticated_run_id: &str,
        request: &ControlRetirementRequest,
    ) -> Result<ControlRetirementReply> {
        if authenticated_run_id != self.run_id {
            return Err(ControlError::WrongIdentity);
        }
        request.validate()?;
        let state = match request.lane {
            Lane::Normal => &self.normal_retirement,
            Lane::Cleanup => &self.cleanup_retirement,
        };
        if let Some((original, reply)) = &state.latest {
            if original == request {
                return Ok(reply.clone());
            }
        }
        if request.previous_through.get() != state.through {
            return Err(ControlError::RetiredOrUnseen);
        }
        let through = request.through_serial.get();
        if through > self.seen_through(request.lane).get() {
            return Err(ControlError::RetiredOrUnseen);
        }
        let lane_name = match request.lane {
            Lane::Normal => "normal",
            Lane::Cleanup => "cleanup",
        };
        let mut digest = Sha256::new();
        digest.update(format!(
            "weapp-control-retirement-v1\n{}\n{}\n{lane_name}\n{}\n{through}\n",
            self.run_id,
            self.client_id,
            request.previous_through.get(),
        ));
        let mut keys = Vec::with_capacity(MAX_CONTROL_RETIREMENT_ENTRIES);
        for (&key, entry) in self
            .entries
            .range((request.lane, request.previous_through.get() + 1)..=(request.lane, through))
        {
            if keys.len() == MAX_CONTROL_RETIREMENT_ENTRIES {
                return Err(ControlError::TooLarge);
            }
            let EntryState::Tombstone(tombstone) = &entry.state else {
                return Err(ControlError::AckMismatch);
            };
            let Some(final_sha256) = tombstone
                .final_sha256
                .as_deref()
                .filter(|_| tombstone.kind == TombstoneKind::FinalCompacted)
            else {
                return Err(ControlError::AckMismatch);
            };
            digest.update(format!(
                "{}:{final_sha256}\n",
                entry.request.identity.request_id
            ));
            keys.push(key);
        }
        if keys.last().map(|key| key.1) != Some(through) {
            return Err(ControlError::RetiredOrUnseen);
        }
        if format!("{:x}", digest.finalize()) != request.prefix_sha256 {
            return Err(ControlError::AckMismatch);
        }
        let reply = ControlRetirementReply {
            version: BROWSER_DEV_VERSION,
            run_id: self.run_id.clone(),
            client_id: self.client_id.clone(),
            lane: request.lane,
            previous_through: request.previous_through,
            through_serial: request.through_serial,
            prefix_sha256: request.prefix_sha256.clone(),
            retired_count: keys.len(),
            outcome: "retired",
        };
        // Bound both retained wire projections before deleting a single entry.
        // Two lanes reserve at most four <=4 KiB projections, independently of
        // the mutation ledger's reclaimed byte and entry charges.
        encode_bounded(request, MAX_CONTROL_RETIREMENT_BYTES)?;
        encode_bounded(&reply, MAX_CONTROL_RETIREMENT_BYTES)?;
        let mut reclaimed = 0;
        for key in &keys {
            reclaimed += self
                .entries
                .remove(key)
                .expect("preflighted prefix entry")
                .charge;
        }
        let usage = self.lane_mut(request.lane);
        usage.entries -= keys.len();
        usage.bytes -= reclaimed;
        let state = match request.lane {
            Lane::Normal => &mut self.normal_retirement,
            Lane::Cleanup => &mut self.cleanup_retirement,
        };
        state.through = through;
        state.latest = Some((request.clone(), reply.clone()));
        Ok(reply)
    }

    pub fn retired_through(&self, lane: Lane) -> WireU64 {
        WireU64::new(match lane {
            Lane::Normal => self.normal_retirement.through,
            Lane::Cleanup => self.cleanup_retirement.through,
        })
    }

    /// Free an already acknowledged final tombstone. High-water persists, so a
    /// forgotten old ID (even with a new payload) is refused, never new work.
    /// ExecutionUncertain/NeverExecuted tombstones have no such retirement path.
    pub fn retire_compacted(&mut self, identity: &ControlIdentity) -> Result<()> {
        if !matches!(&self.exact(identity)?.state,
            EntryState::Tombstone(value) if value.kind == TombstoneKind::FinalCompacted)
        {
            return Err(ControlError::AckMismatch);
        }
        let entry = self
            .entries
            .remove(&(identity.command.lane(), identity.serial.get()))
            .expect("checked exact entry");
        let usage = self.lane_mut(identity.command.lane());
        usage.entries -= 1;
        usage.bytes -= entry.charge;
        Ok(())
    }
}

fn valid_identifier(value: &str, max: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > max
        || !value.as_bytes()[0].is_ascii_alphanumeric()
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        Err(ControlError::Invalid("identifier"))
    } else {
        Ok(())
    }
}
fn check_json(value: &Value, depth: usize, nodes: &mut usize) -> Result<()> {
    *nodes += 1;
    if depth > MAX_JSON_DEPTH || *nodes > MAX_JSON_NODES {
        return Err(ControlError::TooLarge);
    }
    match value {
        Value::Array(values) => {
            for value in values {
                check_json(value, depth + 1, nodes)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                check_json(value, depth + 1, nodes)?;
            }
        }
        _ => {}
    }
    Ok(())
}
/// Unlike serde_json::Value's default map decoding, control input rejects
/// duplicate object keys at every depth rather than silently choosing a value.
struct UniqueValue(Value);
impl<'de> Deserialize<'de> for UniqueValue {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
            type Value = UniqueValue;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("JSON with unique object keys")
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Bool(value)))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::from(value)))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::from(value)))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|value| UniqueValue(Value::Number(value)))
                    .ok_or_else(|| E::custom("nonfinite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(value.to_owned())))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::String(value)))
            }
            fn visit_none<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueValue(Value::Null))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueValue>()? {
                    values.push(value.0);
                }
                Ok(UniqueValue(Value::Array(values)))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                use serde::de::Error;
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(A::Error::custom("duplicate control JSON key"));
                    }
                    values.insert(key, map.next_value::<UniqueValue>()?.0);
                }
                Ok(UniqueValue(Value::Object(values)))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}
struct CanonicalValue<'a>(&'a Value);
impl Serialize for CanonicalValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self.0 {
            Value::Array(values) => {
                let mut sequence = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    sequence.serialize_element(&CanonicalValue(value))?;
                }
                sequence.end()
            }
            Value::Object(values) => {
                let mut entries: Vec<_> = values.iter().collect();
                entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
                let mut map = serializer.serialize_map(Some(entries.len()))?;
                for (key, value) in entries {
                    map.serialize_entry(key, &CanonicalValue(value))?;
                }
                map.end()
            }
            value => value.serialize(serializer),
        }
    }
}
struct CappedMemory {
    bytes: Vec<u8>,
    limit: usize,
    exceeded: bool,
}
impl Write for CappedMemory {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
            self.exceeded = true;
            return Err(std::io::Error::other("bounded memory encoding"));
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn encode_bounded<T: Serialize + ?Sized>(value: &T, limit: usize) -> Result<Vec<u8>> {
    let mut writer = CappedMemory {
        bytes: Vec::new(),
        limit,
        exceeded: false,
    };
    let result = serde_json::to_writer(&mut writer, value);
    if writer.exceeded {
        return Err(ControlError::TooLarge);
    }
    result.map_err(|_| ControlError::Invalid("bounded JSON encoding"))?;
    Ok(writer.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser_dev_coordinator::{
        CoordinatorDiagnostic, PresentationPhase, RuntimePhase, SitePhase,
    };
    fn ledger() -> ControlLedger {
        ControlLedger::new("run-1".into(), "client-1".into(), ControlLimits::default()).unwrap()
    }
    fn snapshot(revision: u64) -> CoordinatorSnapshot {
        CoordinatorSnapshot {
            version: BROWSER_DEV_VERSION,
            run_id: "run-1".into(),
            control_revision: WireU64::new(revision),
            terminal_cleanup_revision: WireU64::new(0),
            stopped: false,
            portable: None,
            portable_current: false,
            site_phase: SitePhase::Absent,
            offered_site: None,
            preview: None,
            owner_key: None,
            owner_phase: None,
            owner_matches_source: false,
            runtime_phase: RuntimePhase::Absent,
            presentation_phase: PresentationPhase::Absent,
            activation_id: None,
            activation_phase: None,
            runtime_ready: None,
            presented_ready: None,
            source_diagnostic: None,
            site_diagnostic: None,
            owner_diagnostic: None,
            previous_owner_closed: false,
        }
    }
    fn request(serial: u64, command: &str, payload: Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "version": "1.0",
            "requestId": format!("client-1:{}-{serial}", serde_json::from_value::<ControlCommand>(Value::String(command.to_owned())).unwrap().lane().namespace()), "command": command, "payload": payload })).unwrap()
    }
    fn empty(serial: u64) -> Vec<u8> {
        request(serial, "snapshot", serde_json::json!({}))
    }
    fn admit(ledger: &mut ControlLedger, bytes: &[u8]) -> ControlIdentity {
        let ControlLookup::Queued(receipt) = ledger.admit("run-1", bytes).unwrap() else {
            panic!("new queued receipt");
        };
        receipt.identity
    }
    fn ok_snapshot(revision: u64) -> FinalDraft {
        FinalDraft {
            snapshot: snapshot(revision),
            outcome: FinalOutcome::Ok(Box::new(ControlResult::Snapshot(Box::new(snapshot(
                revision,
            ))))),
        }
    }
    fn cancelled() -> ErrorFact {
        ErrorFact::new("ERR_CANCELLED", "expired before execution").unwrap()
    }

    fn compacted(ledger: &mut ControlLedger, serial: u64, command: &str) -> (String, String) {
        let bytes = request(serial, command, serde_json::json!({}));
        let identity = admit(ledger, &bytes);
        let final_bytes = ledger
            .cancel_queued(&identity, snapshot(serial), cancelled())
            .unwrap();
        let hash = format!("{:x}", Sha256::digest(final_bytes.as_slice()));
        drop(final_bytes);
        ledger.acknowledge_final("run-1", &bytes, &hash).unwrap();
        (identity.request_id, hash)
    }

    fn retirement(
        lane: Lane,
        previous: u64,
        through: u64,
        entries: &[(String, String)],
    ) -> ControlRetirementRequest {
        let lane_text = if lane == Lane::Normal {
            "normal"
        } else {
            "cleanup"
        };
        let mut transcript = format!(
            "weapp-control-retirement-v1\nrun-1\nclient-1\n{lane_text}\n{previous}\n{through}\n"
        );
        for (request_id, hash) in entries {
            transcript.push_str(&format!("{request_id}:{hash}\n"));
        }
        ControlRetirementRequest {
            version: "1.0".into(),
            lane,
            previous_through: WireU64::new(previous),
            through_serial: WireU64::new(through),
            prefix_sha256: format!("{:x}", Sha256::digest(transcript.as_bytes())),
        }
    }

    #[test]
    fn retirement_reclaims_prefix_retries_exact_reply_and_preserves_high_water() {
        let mut ledger = ledger();
        let entries = [
            compacted(&mut ledger, 1, "snapshot"),
            compacted(&mut ledger, 3, "snapshot"),
        ];
        let request = retirement(Lane::Normal, 0, 3, &entries);
        let reply = ledger.retire_prefix("run-1", &request).unwrap();
        assert_eq!(reply.retired_count, 2);
        assert_eq!(reply.outcome, "retired");
        assert_eq!(reply.run_id, "run-1");
        assert_eq!(reply.client_id, "client-1");
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
        assert_eq!(ledger.retired_through(Lane::Normal).get(), 3);
        assert_eq!(ledger.seen_through(Lane::Normal).get(), 3);
        assert!(ledger.cleanup_ready());
        assert_eq!(
            serde_json::to_vec(&reply).unwrap(),
            serde_json::to_vec(&ledger.retire_prefix("run-1", &request).unwrap()).unwrap()
        );
        for serial in 1..=3 {
            assert_eq!(
                ledger.admit("run-1", &empty(serial)).unwrap_err(),
                ControlError::RetiredOrUnseen
            );
        }
        assert_eq!(
            ledger.lookup("run-1", &empty(1)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &empty(1), &entries[0].1)
                .unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        let fourth = compacted(&mut ledger, 4, "snapshot");
        let next = retirement(Lane::Normal, 3, 4, &[fourth]);
        ledger.retire_prefix("run-1", &next).unwrap();
        assert_eq!(
            ledger.retire_prefix("run-1", &request).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(ledger.retired_through(Lane::Normal).get(), 4);
    }

    #[test]
    fn retirement_rejects_every_unacknowledged_state_atomically() {
        for state in 0..7 {
            let mut ledger = ledger();
            let first = compacted(&mut ledger, 1, "snapshot");
            let bytes = empty(2);
            let second = admit(&mut ledger, &bytes);
            let mut borrowed = None;
            match state {
                0 => {} // Queued.
                1 => {
                    ledger.begin(&second).unwrap();
                }
                2 => {
                    let ticket = ledger.begin(&second).unwrap().ticket;
                    let _prepared = ledger.prepare_final(&ticket, ok_snapshot(2)).unwrap();
                }
                3 | 6 => {
                    let ticket = ledger.begin(&second).unwrap().ticket;
                    let body = ledger.finish(&ticket, ok_snapshot(2)).unwrap();
                    if state == 3 {
                        borrowed = Some(body);
                    }
                }
                4 => {
                    let ticket = ledger.begin(&second).unwrap().ticket;
                    ledger.mark_uncertain(&ticket, cancelled()).unwrap();
                }
                5 => {
                    let mut wrong = snapshot(2);
                    wrong.run_id = "another-run".into();
                    assert!(ledger.cancel_queued(&second, wrong, cancelled()).is_err());
                }
                _ => unreachable!(),
            }
            let request = retirement(
                Lane::Normal,
                0,
                2,
                &[first, (second.request_id, "0".repeat(64))],
            );
            let usage = ledger.usage(Lane::Normal);
            assert_eq!(
                ledger.retire_prefix("run-1", &request).unwrap_err(),
                ControlError::AckMismatch
            );
            assert_eq!(ledger.usage(Lane::Normal), usage);
            assert_eq!(ledger.retired_through(Lane::Normal).get(), 0);
            assert_eq!(ledger.seen_through(Lane::Normal).get(), 2);
            assert!(matches!(
                ledger.lookup("run-1", &empty(1)).unwrap(),
                ControlLookup::Tombstone(_)
            ));
            assert!(!ledger.cleanup_ready());
            drop(borrowed);
        }
    }

    #[test]
    fn retirement_cannot_bypass_original_final_borrower_ack_barrier() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let hash = format!("{:x}", Sha256::digest(body.as_slice()));
        let request = retirement(Lane::Normal, 0, 1, &[(identity.request_id, hash.clone())]);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &bytes, &hash)
                .unwrap_err(),
            ControlError::Capacity
        );
        assert_eq!(
            ledger.retire_prefix("run-1", &request).unwrap_err(),
            ControlError::AckMismatch
        );
        drop(body);
        ledger.acknowledge_final("run-1", &bytes, &hash).unwrap();
        ledger.retire_prefix("run-1", &request).unwrap();
        assert!(ledger.cleanup_ready());
    }

    #[test]
    fn retirement_validates_identity_cursor_digest_and_actual_last_entry_before_mutation() {
        let mut ledger = ledger();
        let entries = [
            compacted(&mut ledger, 1, "snapshot"),
            compacted(&mut ledger, 3, "snapshot"),
        ];
        let valid = retirement(Lane::Normal, 0, 3, &entries);
        let usage = ledger.usage(Lane::Normal);
        assert_eq!(
            ledger.retire_prefix("foreign-run", &valid).unwrap_err(),
            ControlError::WrongIdentity
        );
        let mut malformed = valid.clone();
        malformed.prefix_sha256 = "0".repeat(64);
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::AckMismatch
        );
        malformed = valid.clone();
        malformed.previous_through = WireU64::new(1);
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        malformed = valid.clone();
        malformed.through_serial = WireU64::new(2);
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        malformed = valid.clone();
        malformed.through_serial = WireU64::new(4);
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        malformed = valid.clone();
        malformed.lane = Lane::Cleanup;
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(ledger.usage(Lane::Normal), usage);
        assert_eq!(ledger.retired_through(Lane::Normal).get(), 0);
        ledger.retire_prefix("run-1", &valid).unwrap();
        malformed = valid.clone();
        malformed.prefix_sha256 = "f".repeat(64);
        assert_eq!(
            ledger.retire_prefix("run-1", &malformed).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
    }

    #[test]
    fn retirement_batch_limit_is_atomic_and_each_lane_keeps_its_own_latest_reply() {
        let mut ledger = ledger();
        let rows: Vec<_> = (1..=65)
            .map(|serial| compacted(&mut ledger, serial, "snapshot"))
            .collect();
        let oversized = retirement(Lane::Normal, 0, 65, &rows);
        let usage = ledger.usage(Lane::Normal);
        assert_eq!(
            ledger.retire_prefix("run-1", &oversized).unwrap_err(),
            ControlError::TooLarge
        );
        assert_eq!(ledger.usage(Lane::Normal), usage);
        let first = retirement(Lane::Normal, 0, 64, &rows[..64]);
        ledger.retire_prefix("run-1", &first).unwrap();
        let last = retirement(Lane::Normal, 64, 65, &rows[64..]);
        let normal_reply = ledger.retire_prefix("run-1", &last).unwrap();
        let cleanup_row = compacted(&mut ledger, 1, "stop");
        let cleanup = retirement(Lane::Cleanup, 0, 1, &[cleanup_row]);
        let cleanup_reply = ledger.retire_prefix("run-1", &cleanup).unwrap();
        assert_eq!(ledger.retire_prefix("run-1", &last).unwrap(), normal_reply);
        assert_eq!(
            ledger.retire_prefix("run-1", &cleanup).unwrap(),
            cleanup_reply
        );
        assert_eq!(ledger.retired_through(Lane::Normal).get(), 65);
        assert_eq!(ledger.retired_through(Lane::Cleanup).get(), 1);
        assert_eq!(ledger.seen_through(Lane::Normal).get(), 65);
        assert_eq!(ledger.seen_through(Lane::Cleanup).get(), 1);
        assert!(ledger.cleanup_ready());
    }

    #[test]
    fn retirement_uses_canonical_u64_and_never_wraps_the_admission_high_water() {
        let mut ledger = ledger();
        let entry = compacted(&mut ledger, u64::MAX, "snapshot");
        let request = retirement(Lane::Normal, 0, u64::MAX, &[entry]);
        ledger.retire_prefix("run-1", &request).unwrap();
        assert_eq!(ledger.seen_through(Lane::Normal).get(), u64::MAX);
        assert_eq!(ledger.retired_through(Lane::Normal).get(), u64::MAX);
        assert_eq!(
            ledger.admit("run-1", &empty(u64::MAX)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        let mut wrapped = request;
        wrapped.previous_through = WireU64::new(u64::MAX);
        assert!(matches!(
            ledger.retire_prefix("run-1", &wrapped),
            Err(ControlError::Invalid(_))
        ));
        for bad in [
            serde_json::json!(1),
            serde_json::json!("01"),
            serde_json::json!("18446744073709551616"),
        ] {
            let mut value = serde_json::json!({"version":"1.0","lane":"normal","previousThrough":"0","throughSerial":"1","prefixSha256":"a".repeat(64)});
            value["throughSerial"] = bad;
            assert!(serde_json::from_value::<ControlRetirementRequest>(value).is_err());
        }
    }

    #[test]
    fn cleanup_gate_waits_for_exact_ack_and_all_execution_states() {
        let mut ledger = ledger();
        assert!(ledger.cleanup_ready());
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        assert!(!ledger.cleanup_ready()); // Queued.
        let begun = ledger.begin(&identity).unwrap();
        assert!(!ledger.cleanup_ready()); // Executing.
        let prepared = ledger.prepare_final(&begun.ticket, ok_snapshot(1)).unwrap();
        assert!(!ledger.cleanup_ready()); // Retained preparation is not delivery.
        let final_bytes = ledger.commit_prepared_final(prepared).unwrap();
        assert!(!ledger.cleanup_ready());
        let hash = format!("{:x}", Sha256::digest(final_bytes.as_slice()));
        drop(final_bytes); // Losing the transport borrower is not an ACK.
        assert!(!ledger.cleanup_ready());
        assert_eq!(
            ledger.acknowledge_final("run-1", &bytes, &hash).unwrap(),
            FinalAckOutcome::Compacted
        );
        assert!(ledger.cleanup_ready());
        assert_eq!(ledger.usage(Lane::Normal).entries, 1); // Tombstone remains.
        let usage = ledger.usage(Lane::Normal);
        let high_water = ledger.seen_through(Lane::Normal);
        assert!(ledger.cleanup_ready());
        assert_eq!(ledger.usage(Lane::Normal), usage);
        assert_eq!(ledger.seen_through(Lane::Normal), high_water);
        assert!(
            matches!(ledger.lookup("run-1", &bytes).unwrap(), ControlLookup::Tombstone(value)
            if value.kind == TombstoneKind::FinalCompacted)
        );
        ledger.retire_compacted(&identity).unwrap();
        assert!(ledger.cleanup_ready());
    }

    #[test]
    fn cleanup_gate_checks_both_lanes_and_cancel_finals_still_need_ack() {
        let mut ledger = ledger();
        let normal = empty(1);
        let normal_id = admit(&mut ledger, &normal);
        let ticket = ledger.begin(&normal_id).unwrap().ticket;
        let final_bytes = ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let hash = format!("{:x}", Sha256::digest(final_bytes.as_slice()));
        drop(final_bytes);
        ledger.acknowledge_final("run-1", &normal, &hash).unwrap();
        assert!(ledger.cleanup_ready());

        let cleanup = request(1, "stop", serde_json::json!({}));
        let cleanup_id = admit(&mut ledger, &cleanup);
        assert!(!ledger.cleanup_ready());
        let final_bytes = ledger
            .cancel_queued(&cleanup_id, snapshot(2), cancelled())
            .unwrap();
        assert!(!ledger.cleanup_ready());
        let hash = format!("{:x}", Sha256::digest(final_bytes.as_slice()));
        drop(final_bytes);
        ledger.acknowledge_final("run-1", &cleanup, &hash).unwrap();
        assert!(ledger.cleanup_ready());
        assert_eq!(ledger.usage(Lane::Cleanup).entries, 1);
        assert_eq!(ledger.usage(Lane::Normal).entries, 1);
    }

    #[test]
    fn never_executed_and_uncertain_tombstones_do_not_grant_delivery_cleanup() {
        let mut never = ledger();
        let bytes = empty(1);
        let identity = admit(&mut never, &bytes);
        let mut wrong_snapshot = snapshot(1);
        wrong_snapshot.run_id = "other-run".into();
        assert_eq!(
            never
                .cancel_queued(&identity, wrong_snapshot, cancelled())
                .unwrap_err(),
            ControlError::WrongIdentity
        );
        assert!(
            matches!(never.lookup("run-1", &bytes).unwrap(), ControlLookup::Tombstone(value)
            if value.kind == TombstoneKind::NeverExecuted)
        );
        assert!(!never.cleanup_ready());
        assert!(!never.cleanup_ready());
        assert_eq!(never.begin(&identity).unwrap_err(), ControlError::NotQueued);

        let mut uncertain = ledger();
        let identity = admit(&mut uncertain, &bytes);
        let begun = uncertain.begin(&identity).unwrap();
        uncertain
            .mark_uncertain(&begun.ticket, cancelled())
            .unwrap();
        assert!(!uncertain.cleanup_ready());
        assert!(
            matches!(uncertain.lookup("run-1", &bytes).unwrap(), ControlLookup::Tombstone(value)
            if value.kind == TombstoneKind::ExecutionUncertain)
        );
    }

    #[test]
    fn queued_is_not_a_final_and_begin_is_exactly_once() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        assert!(matches!(
            ledger.lookup("run-1", &bytes).unwrap(),
            ControlLookup::Queued(_)
        ));
        let begun = ledger.begin(&identity).unwrap();
        assert!(matches!(begun.operation, ControlOperation::Snapshot(_)));
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        assert!(matches!(
            ledger.admit("run-1", &bytes).unwrap(),
            ControlLookup::Executing(_)
        ));
    }
    #[test]
    fn exact_final_survives_response_drop_and_replays_original_snapshot_bytes() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let original = ledger.finish(&ticket, ok_snapshot(7)).unwrap();
        let expected = original.to_vec();
        drop(original); // Transport response disconnected.
        let ControlLookup::Final(replayed) = ledger.admit("run-1", &bytes).unwrap() else {
            panic!("retained final");
        };
        assert_eq!(&*replayed, &expected);
        let json: Value = serde_json::from_slice(&replayed).unwrap();
        assert_eq!(json["status"], "ok");
        assert_eq!(json["snapshot"]["controlRevision"], "7");
        assert_eq!(json["snapshot"]["terminalCleanupRevision"], "0");
        assert_eq!(
            ledger.finish(&ticket, ok_snapshot(99)).unwrap_err(),
            ControlError::NotExecuting
        );
    }
    #[test]
    fn canonical_nested_payload_replay_has_stable_binding() {
        let mut ledger = ledger();
        let first = br#"{"version":"1.0","requestId":"client-1:cleanup-1","command":"failOwner","payload":{"ownerKey":{"activationId":"1","ownerSerial":"2","clientOwnerId":"owner-1"},"message":"failure"}}"#;
        let second = br#"{ "payload": { "message": "failure", "ownerKey": { "clientOwnerId": "owner-1", "ownerSerial": "2", "activationId": "1" } }, "command":"failOwner", "requestId":"client-1:cleanup-1", "version":"1.0" }"#;
        let first_id = admit(&mut ledger, first);
        let ControlLookup::Queued(replay) = ledger.admit("run-1", second).unwrap() else {
            panic!("same queued request");
        };
        assert_eq!(first_id, replay.identity);
    }
    #[test]
    fn conflicting_command_never_reuses_an_admitted_id() {
        let mut ledger = ledger();
        admit(&mut ledger, &empty(1));
        let masquerade = request(1, "stop", serde_json::json!({}));
        let masquerade = String::from_utf8(masquerade)
            .unwrap()
            .replace(":cleanup-1", ":control-1");
        assert_eq!(
            ledger.admit("run-1", masquerade.as_bytes()).unwrap_err(),
            ControlError::WrongIdentity
        );
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(1));
    }
    #[test]
    fn conflicting_payload_never_mutates_retained_request() {
        let mut ledger = ledger();
        let payload = serde_json::json!({"ownerKey":{"activationId":"1","ownerSerial":"2","clientOwnerId":"owner-1"},"message":"a"});
        let original = request(1, "failOwner", payload.clone());
        admit(&mut ledger, &original);
        let mut changed = payload;
        changed["message"] = Value::String("b".into());
        assert_eq!(
            ledger
                .admit("run-1", &request(1, "failOwner", changed))
                .unwrap_err(),
            ControlError::Conflict
        );
        assert!(matches!(
            ledger.lookup("run-1", &original).unwrap(),
            ControlLookup::Queued(_)
        ));
    }
    #[test]
    fn run_client_version_and_canonical_serial_are_bound_before_admission() {
        let mut ledger = ledger();
        assert_eq!(
            ledger.admit("another-run", &empty(1)).unwrap_err(),
            ControlError::WrongIdentity
        );
        for serial in ["0", "01", "+1", "18446744073709551616"] {
            let value = serde_json::json!({"version":"1.0","requestId":format!("client-1:control-{serial}"),"command":"snapshot","payload":{}});
            assert!(ledger
                .admit("run-1", &serde_json::to_vec(&value).unwrap())
                .is_err());
        }
        let foreign = br#"{"version":"1.0","requestId":"client-2:control-1","command":"snapshot","payload":{}}"#;
        assert_eq!(
            ledger.admit("run-1", foreign).unwrap_err(),
            ControlError::WrongIdentity
        );
        let wrong_version = br#"{"version":"2.0","requestId":"client-1:control-1","command":"snapshot","payload":{}}"#;
        assert!(ledger.admit("run-1", wrong_version).is_err());
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(0));
    }
    #[test]
    fn local_noninvocation_can_skip_serials_but_late_unseen_gaps_cannot_execute() {
        let mut ledger = ledger();
        admit(&mut ledger, &empty(8));
        assert_eq!(
            ledger.admit("run-1", &empty(7)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(
            ledger.lookup("run-1", &empty(9)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(8));
    }
    #[test]
    fn queued_timeout_retains_error_final_and_prevents_late_execution() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let final_bytes = ledger
            .cancel_queued(
                &identity,
                snapshot(3),
                ErrorFact::new(
                    "ERR_TIMEOUT",
                    "deadline elapsed before owner-loop execution",
                )
                .unwrap(),
            )
            .unwrap();
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        let value: Value = serde_json::from_slice(&final_bytes).unwrap();
        assert_eq!(value["status"], "error");
        assert_eq!(value["error"]["code"], "ERR_TIMEOUT");
        let ControlLookup::Final(replay) = ledger.lookup("run-1", &bytes).unwrap() else {
            panic!("cancel final");
        };
        assert!(Arc::ptr_eq(&final_bytes, &replay));
    }
    #[test]
    fn timeout_after_begin_cannot_claim_never_executed_or_revoke_actual_result() {
        let mut ledger = ledger();
        let identity = admit(&mut ledger, &empty(1));
        let ticket = ledger.begin(&identity).unwrap().ticket;
        assert_eq!(
            ledger
                .cancel_queued(&identity, snapshot(1), cancelled())
                .unwrap_err(),
            ControlError::NotQueued
        );
        assert!(ledger.finish(&ticket, ok_snapshot(2)).is_ok());
    }
    #[test]
    fn uncertain_tombstone_is_never_requeued_compacted_or_retired() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        ledger
            .mark_uncertain(
                &ticket,
                ErrorFact::new("ERR_ENGINE", "owner-loop result unavailable").unwrap(),
            )
            .unwrap();
        assert!(matches!(
            ledger.admit("run-1", &bytes).unwrap(),
            ControlLookup::Tombstone(ControlTombstone {
                kind: TombstoneKind::ExecutionUncertain,
                ..
            })
        ));
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        assert_eq!(
            ledger.finish(&ticket, ok_snapshot(2)).unwrap_err(),
            ControlError::NotExecuting
        );
        assert_eq!(
            ledger.retire_compacted(&identity).unwrap_err(),
            ControlError::AckMismatch
        );
    }
    #[test]
    fn independent_cleanup_count_capacity_survives_normal_exhaustion() {
        let mut limits = ControlLimits::default();
        limits.normal.max_entries = 1;
        let mut ledger = ControlLedger::new("run-1".into(), "client-1".into(), limits).unwrap();
        admit(&mut ledger, &empty(1));
        assert_eq!(
            ledger.admit("run-1", &empty(2)).unwrap_err(),
            ControlError::Capacity
        );
        admit(&mut ledger, &request(3, "stop", serde_json::json!({})));
        assert_eq!(ledger.usage(Lane::Normal).entries, 1);
        assert_eq!(ledger.usage(Lane::Cleanup).entries, 1);
    }
    #[test]
    fn independent_cleanup_byte_capacity_survives_normal_exhaustion() {
        let mut limits = ControlLimits::default();
        limits.normal.max_bytes =
            ENTRY_OVERHEAD + MAX_CONTROL_FINAL_BYTES + MAX_CONTROL_REQUEST_BYTES;
        let mut ledger = ControlLedger::new("run-1".into(), "client-1".into(), limits).unwrap();
        admit(&mut ledger, &empty(1));
        assert_eq!(
            ledger.admit("run-1", &empty(2)).unwrap_err(),
            ControlError::Capacity
        );
        admit(&mut ledger, &request(3, "stop", serde_json::json!({})));
        assert!(ledger.usage(Lane::Cleanup).bytes > MAX_CONTROL_FINAL_BYTES);
    }
    #[test]
    fn final_capacity_is_reserved_at_admission_and_released_only_to_retained_size() {
        let mut ledger = ledger();
        let identity = admit(&mut ledger, &empty(1));
        let admitted = ledger.usage(Lane::Normal).bytes;
        assert!(admitted > MAX_CONTROL_FINAL_BYTES);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let prepared = ledger.prepare_final(&ticket, ok_snapshot(1)).unwrap();
        assert_eq!(ledger.usage(Lane::Normal).bytes, admitted);
        assert!(ledger.prepare_final(&ticket, ok_snapshot(1)).is_err());
        let bytes = ledger.commit_prepared_final(prepared).unwrap();
        assert_eq!(
            ledger.usage(Lane::Normal).bytes,
            admitted - MAX_CONTROL_FINAL_BYTES + bytes.len()
        );
    }
    #[test]
    fn command_result_pairing_and_run_mismatch_do_not_consume_execution_ticket() {
        let mut ledger = ledger();
        let identity = admit(&mut ledger, &empty(1));
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let mismatched = FinalDraft {
            snapshot: snapshot(1),
            outcome: FinalOutcome::Ok(Box::new(ControlResult::Unit)),
        };
        assert!(ledger.prepare_final(&ticket, mismatched).is_err());
        let mut wrong_run = ok_snapshot(1);
        wrong_run.snapshot.run_id = "other".into();
        assert_eq!(
            ledger.prepare_final(&ticket, wrong_run).unwrap_err(),
            ControlError::WrongIdentity
        );
        assert!(ledger.finish(&ticket, ok_snapshot(1)).is_ok());
    }
    #[test]
    fn snapshot_result_must_be_exact_same_projection() {
        let mut ledger = ledger();
        let identity = admit(&mut ledger, &empty(1));
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let draft = FinalDraft {
            snapshot: snapshot(2),
            outcome: FinalOutcome::Ok(Box::new(ControlResult::Snapshot(Box::new(snapshot(1))))),
        };
        assert!(ledger.prepare_final(&ticket, draft).is_err());
    }
    fn oversized_snapshot() -> CoordinatorSnapshot {
        let mut value = snapshot(1);
        // Deliberately violates the coordinator's bounded diagnostic invariant.
        // The ledger must still cap serialization instead of allocating unbounded bytes.
        value.owner_diagnostic = Some(CoordinatorDiagnostic {
            version: BROWSER_DEV_VERSION,
            control_revision: WireU64::new(1),
            terminal_cleanup_revision: WireU64::new(0),
            code: "X".into(),
            message: "x".repeat(MAX_CONTROL_FINAL_BYTES),
        });
        value
    }
    #[test]
    fn oversized_final_cannot_install_partial_bytes_or_implicitly_retry_mutation() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let charged = ledger.usage(Lane::Normal);
        let draft = FinalDraft {
            snapshot: oversized_snapshot(),
            outcome: FinalOutcome::Error(cancelled()),
        };
        assert_eq!(
            ledger.prepare_final(&ticket, draft).unwrap_err(),
            ControlError::TooLarge
        );
        assert_eq!(ledger.usage(Lane::Normal), charged);
        assert!(matches!(
            ledger.lookup("run-1", &bytes).unwrap(),
            ControlLookup::Executing(_)
        ));
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        ledger
            .mark_uncertain(
                &ticket,
                ErrorFact::new("ERR_ENGINE", "invariant violation; reconcile actual result")
                    .unwrap(),
            )
            .unwrap();
    }
    #[test]
    fn failed_cancel_encoding_still_seals_never_executed_tombstone() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        assert_eq!(
            ledger
                .cancel_queued(&identity, oversized_snapshot(), cancelled())
                .unwrap_err(),
            ControlError::TooLarge
        );
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        assert!(matches!(
            ledger.lookup("run-1", &bytes).unwrap(),
            ControlLookup::Tombstone(ControlTombstone {
                kind: TombstoneKind::NeverExecuted,
                ..
            })
        ));
    }
    #[test]
    fn request_bound_ack_is_idempotent_and_hashes_exact_final_bytes() {
        let mut ledger = ledger();
        let first = br#"{"version":"1.0","requestId":"client-1:cleanup-1","command":"failOwner","payload":{"ownerKey":{"activationId":"1","ownerSerial":"2","clientOwnerId":"owner-1"},"message":"failure"}}"#;
        let reordered = br#"{ "payload": { "message": "failure", "ownerKey": { "clientOwnerId": "owner-1", "ownerSerial": "2", "activationId": "1" } }, "command":"failOwner", "requestId":"client-1:cleanup-1", "version":"1.0" }"#;
        let identity = admit(&mut ledger, first);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger
            .finish(
                &ticket,
                FinalDraft {
                    snapshot: snapshot(1),
                    outcome: FinalOutcome::Error(cancelled()),
                },
            )
            .unwrap();
        let digest = format!("{:x}", Sha256::digest(body.as_slice()));
        let parsed: Value = serde_json::from_slice(body.as_slice()).unwrap();
        let reencoded = serde_json::to_vec_pretty(&parsed).unwrap();
        let wrong = format!("{:x}", Sha256::digest(&reencoded));
        assert_ne!(digest, wrong);
        drop(body);
        let charged = ledger.usage(Lane::Cleanup);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", first, &wrong)
                .unwrap_err(),
            ControlError::AckMismatch
        );
        assert_eq!(ledger.usage(Lane::Cleanup), charged);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", reordered, &digest)
                .unwrap(),
            FinalAckOutcome::Compacted
        );
        let compacted = ledger.usage(Lane::Cleanup);
        assert_eq!(compacted.entries, charged.entries);
        assert!(compacted.bytes < charged.bytes);
        assert_eq!(
            ledger.acknowledge_final("run-1", first, &digest).unwrap(),
            FinalAckOutcome::AlreadyCompacted
        );
        assert_eq!(ledger.usage(Lane::Cleanup), compacted);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", first, &wrong)
                .unwrap_err(),
            ControlError::AckMismatch
        );
        assert!(matches!(
            ledger.lookup("run-1", first).unwrap(),
            ControlLookup::Tombstone(ControlTombstone {
                kind: TombstoneKind::FinalCompacted,
                ..
            })
        ));
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
    }

    #[test]
    fn request_bound_ack_preserves_original_response_borrower_barrier() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let digest = format!("{:x}", Sha256::digest(body.as_slice()));
        let charged = ledger.usage(Lane::Normal);
        // Original compact_final checks outstanding bodies before hash mismatch.
        // The helper must retain this order and the same original byte charge.
        for hash in [digest.as_str(), &"0".repeat(64)] {
            assert_eq!(
                ledger.acknowledge_final("run-1", &bytes, hash).unwrap_err(),
                ControlError::Capacity
            );
            assert_eq!(ledger.usage(Lane::Normal), charged);
        }
        let ControlLookup::Final(replay) = ledger.lookup("run-1", &bytes).unwrap() else {
            panic!("original final remains retained");
        };
        assert!(Arc::ptr_eq(&body, &replay));
        drop(body);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &bytes, &digest)
                .unwrap_err(),
            ControlError::Capacity
        );
        drop(replay);
        assert_eq!(
            ledger.acknowledge_final("run-1", &bytes, &digest).unwrap(),
            FinalAckOutcome::Compacted
        );
    }

    #[test]
    fn request_bound_ack_cannot_ack_queued_executing_or_prepared_work() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let hash = "0".repeat(64);
        let charged = ledger.usage(Lane::Normal);
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &bytes, &hash)
                .unwrap_err(),
            ControlError::AckMismatch
        );
        let ticket = ledger.begin(&identity).unwrap().ticket;
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &bytes, &hash)
                .unwrap_err(),
            ControlError::AckMismatch
        );
        let prepared = ledger.prepare_final(&ticket, ok_snapshot(2)).unwrap();
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &bytes, &hash)
                .unwrap_err(),
            ControlError::AckMismatch
        );
        assert_eq!(ledger.usage(Lane::Normal), charged);
        let body = ledger.commit_prepared_final(prepared).unwrap();
        let digest = format!("{:x}", Sha256::digest(body.as_slice()));
        drop(body);
        assert_eq!(
            ledger.acknowledge_final("run-1", &bytes, &digest).unwrap(),
            FinalAckOutcome::Compacted
        );
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(1));
    }

    #[test]
    fn request_bound_ack_never_compacts_nonfinal_tombstones() {
        let mut ledger = ledger();
        let uncertain = empty(1);
        let identity = admit(&mut ledger, &uncertain);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        ledger
            .mark_uncertain(
                &ticket,
                ErrorFact::new("ERR_ENGINE", "actual result remains unknown").unwrap(),
            )
            .unwrap();
        let never_executed = empty(2);
        let queued = admit(&mut ledger, &never_executed);
        assert_eq!(
            ledger
                .cancel_queued(&queued, oversized_snapshot(), cancelled())
                .unwrap_err(),
            ControlError::TooLarge
        );
        let charged = ledger.usage(Lane::Normal);
        for (bytes, kind) in [
            (&uncertain, TombstoneKind::ExecutionUncertain),
            (&never_executed, TombstoneKind::NeverExecuted),
        ] {
            assert_eq!(
                ledger
                    .acknowledge_final("run-1", bytes, &"0".repeat(64))
                    .unwrap_err(),
                ControlError::AckMismatch
            );
            let ControlLookup::Tombstone(tombstone) = ledger.lookup("run-1", bytes).unwrap() else {
                panic!("nonfinal tombstone is retained");
            };
            assert_eq!(tombstone.kind, kind);
        }
        assert_eq!(ledger.usage(Lane::Normal), charged);
    }

    #[test]
    fn request_bound_ack_rejects_identity_conflicts_and_noncanonical_hashes() {
        let mut ledger = ledger();
        let payload = serde_json::json!({"ownerKey":{"activationId":"1","ownerSerial":"2","clientOwnerId":"owner-1"},"message":"original"});
        let bytes = request(1, "failOwner", payload.clone());
        admit(&mut ledger, &bytes);
        let charged = ledger.usage(Lane::Cleanup);
        let hash = "a".repeat(64);
        assert_eq!(
            ledger
                .acknowledge_final("other-run", &bytes, &hash)
                .unwrap_err(),
            ControlError::WrongIdentity
        );
        let wrong_client = String::from_utf8(bytes.clone())
            .unwrap()
            .replace("client-1:cleanup-1", "client-2:cleanup-1");
        assert_eq!(
            ledger
                .acknowledge_final("run-1", wrong_client.as_bytes(), &hash)
                .unwrap_err(),
            ControlError::WrongIdentity
        );
        let wrong_lane = String::from_utf8(bytes.clone())
            .unwrap()
            .replace(":cleanup-1", ":control-1");
        assert_eq!(
            ledger
                .acknowledge_final("run-1", wrong_lane.as_bytes(), &hash)
                .unwrap_err(),
            ControlError::WrongIdentity
        );
        let mut changed = payload;
        changed["message"] = Value::String("different".into());
        assert_eq!(
            ledger
                .acknowledge_final("run-1", &request(1, "failOwner", changed), &hash)
                .unwrap_err(),
            ControlError::Conflict
        );
        for malformed in ["A".repeat(64), "a".repeat(63), "g".repeat(64)] {
            assert_eq!(
                ledger
                    .acknowledge_final("run-1", &bytes, &malformed)
                    .unwrap_err(),
                ControlError::Invalid("canonical final acknowledgement SHA-256")
            );
        }
        assert_eq!(ledger.usage(Lane::Cleanup), charged);
        assert_eq!(ledger.seen_through(Lane::Cleanup), WireU64::new(1));
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(0));
    }

    #[test]
    fn request_bound_ack_distinguishes_compacted_from_retired_or_unseen() {
        let mut ledger = ledger();
        let bytes = empty(2);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let digest = format!("{:x}", Sha256::digest(body.as_slice()));
        drop(body);
        assert_eq!(
            ledger.acknowledge_final("run-1", &bytes, &digest).unwrap(),
            FinalAckOutcome::Compacted
        );
        assert_eq!(
            ledger.acknowledge_final("run-1", &bytes, &digest).unwrap(),
            FinalAckOutcome::AlreadyCompacted
        );
        ledger.retire_compacted(&identity).unwrap();
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
        // A retired ID, skipped lower gap and future unseen ID are all unknown
        // to ACK. High-water protects execution but cannot prove any final hash.
        for unknown in [&bytes, &empty(1), &empty(3)] {
            assert_eq!(
                ledger
                    .acknowledge_final("run-1", unknown, &digest)
                    .unwrap_err(),
                ControlError::RetiredOrUnseen
            );
        }
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(2));
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
        assert_eq!(
            ledger.admit("run-1", &bytes).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(
            ledger.admit("run-1", &empty(1)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert!(matches!(
            ledger.admit("run-1", &empty(3)).unwrap(),
            ControlLookup::Queued(_)
        ));
        assert!(matches!(
            ledger
                .admit("run-1", &request(1, "stop", serde_json::json!({})))
                .unwrap(),
            ControlLookup::Queued(_)
        ));
    }

    #[test]
    fn compaction_requires_exact_ack_and_no_outstanding_response_body_lease() {
        let mut ledger = ledger();
        let bytes = empty(1);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let ack = FinalAcknowledgement {
            identity: identity.clone(),
            final_sha256: format!("{:x}", Sha256::digest(body.as_slice())),
        };
        assert_eq!(
            ledger.compact_final(&ack).unwrap_err(),
            ControlError::Capacity
        );
        drop(body);
        let wrong = FinalAcknowledgement {
            identity: identity.clone(),
            final_sha256: "0".repeat(64),
        };
        assert_eq!(
            ledger.compact_final(&wrong).unwrap_err(),
            ControlError::AckMismatch
        );
        ledger.compact_final(&ack).unwrap();
        assert!(matches!(
            ledger.lookup("run-1", &bytes).unwrap(),
            ControlLookup::Tombstone(ControlTombstone {
                kind: TombstoneKind::FinalCompacted,
                ..
            })
        ));
        ledger.retire_compacted(&identity).unwrap();
        assert_eq!(
            ledger.admit("run-1", &bytes).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert!(matches!(
            ledger
                .admit("run-1", &request(1, "stop", serde_json::json!({})))
                .unwrap(),
            ControlLookup::Queued(_)
        ));
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
    }
    #[test]
    fn numeric_wire_revision_and_unknown_fields_are_rejected_before_queueing() {
        let mut ledger = ledger();
        let payload = serde_json::json!({"preview":{"version":"1.0","runId":"run-1","previewId":"p-1","leaseRevision":"1"},
            "expectedControlRevision":1,"expectedTerminalCleanupRevision":"0"});
        assert!(ledger
            .admit("run-1", &request(1, "retryClose", payload))
            .is_err());
        assert!(ledger
            .admit(
                "run-1",
                &request(1, "snapshot", serde_json::json!({"extra":true}))
            )
            .is_err());
        let extra = br#"{"version":"1.0","requestId":"client-1:control-1","command":"snapshot","payload":{},"ownerId":"invented"}"#;
        assert!(ledger.admit("run-1", extra).is_err());
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(0));
    }
    #[test]
    fn duplicate_keys_at_nested_and_envelope_levels_are_rejected() {
        let mut ledger = ledger();
        let duplicate = br#"{"version":"1.0","requestId":"client-1:control-1","command":"stop","command":"snapshot","payload":{}}"#;
        assert!(ledger.admit("run-1", duplicate).is_err());
        let nested = br#"{"version":"1.0","requestId":"client-1:cleanup-1","command":"failOwner","payload":{"ownerKey":{"activationId":"1","ownerSerial":"2","ownerSerial":"3","clientOwnerId":"o"},"message":"x"}}"#;
        assert!(ledger.admit("run-1", nested).is_err());
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(0));
    }
    #[test]
    fn request_body_budget_rejects_before_retention() {
        let mut ledger = ledger();
        assert_eq!(
            ledger
                .admit("run-1", &vec![b' '; MAX_CONTROL_REQUEST_BYTES + 1])
                .unwrap_err(),
            ControlError::TooLarge
        );
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
    }
    #[test]
    fn maximum_serial_replays_but_does_not_wrap_or_authorize_old_work() {
        let mut ledger = ledger();
        let bytes = empty(u64::MAX);
        let identity = admit(&mut ledger, &bytes);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        ledger.finish(&ticket, ok_snapshot(u64::MAX)).unwrap();
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(u64::MAX));
        assert!(matches!(
            ledger.admit("run-1", &bytes).unwrap(),
            ControlLookup::Final(_)
        ));
        assert_eq!(
            ledger.admit("run-1", &empty(1)).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
    }
    #[test]
    fn normal_serial_exhaustion_cannot_consume_the_exact_cleanup_namespace() {
        let mut ledger = ledger();
        let normal = admit(&mut ledger, &empty(u64::MAX));
        let ticket = ledger.begin(&normal).unwrap().ticket;
        ledger.finish(&ticket, ok_snapshot(1)).unwrap();
        let stop = request(1, "stop", serde_json::json!({}));
        let identity = admit(&mut ledger, &stop);
        let ticket = ledger.begin(&identity).unwrap().ticket;
        let body = ledger
            .finish(
                &ticket,
                FinalDraft {
                    snapshot: snapshot(2),
                    outcome: FinalOutcome::Ok(Box::new(ControlResult::Stop(None))),
                },
            )
            .unwrap();
        let ControlLookup::Final(replay) = ledger.lookup("run-1", &stop).unwrap() else {
            panic!("cleanup replay");
        };
        assert!(Arc::ptr_eq(&body, &replay));
        let retry = request(
            2,
            "retryClose",
            serde_json::json!({
            "preview":{"version":"1.0","runId":"run-1","previewId":"p-1","leaseRevision":"1"},
            "expectedControlRevision":"2","expectedTerminalCleanupRevision":"0"}),
        );
        let identity = admit(&mut ledger, &retry);
        assert!(matches!(
            ledger.begin(&identity).unwrap().operation,
            ControlOperation::RetryClose(_)
        ));
        assert_eq!(ledger.seen_through(Lane::Normal), WireU64::new(u64::MAX));
        assert_eq!(ledger.seen_through(Lane::Cleanup), WireU64::new(2));
    }
    #[test]
    fn cleanup_retirement_and_exhaustion_never_alias_the_normal_lane() {
        let mut ledger = ledger();
        let normal = admit(&mut ledger, &empty(1));
        let cleanup_bytes = request(1, "stop", serde_json::json!({}));
        let cleanup = admit(&mut ledger, &cleanup_bytes);
        let ticket = ledger.begin(&cleanup).unwrap().ticket;
        let body = ledger
            .finish(
                &ticket,
                FinalDraft {
                    snapshot: snapshot(1),
                    outcome: FinalOutcome::Ok(Box::new(ControlResult::Stop(None))),
                },
            )
            .unwrap();
        let ack = FinalAcknowledgement {
            identity: cleanup.clone(),
            final_sha256: format!("{:x}", Sha256::digest(body.as_slice())),
        };
        drop(body);
        ledger.compact_final(&ack).unwrap();
        ledger.retire_compacted(&cleanup).unwrap();
        assert!(matches!(
            ledger.lookup("run-1", &empty(1)).unwrap(),
            ControlLookup::Queued(_)
        ));
        assert!(matches!(
            ledger.begin(&normal).unwrap().operation,
            ControlOperation::Snapshot(_)
        ));
        let maximum = request(u64::MAX, "stop", serde_json::json!({}));
        admit(&mut ledger, &maximum);
        assert!(matches!(
            ledger.admit("run-1", &maximum).unwrap(),
            ControlLookup::Queued(_)
        ));
        assert_eq!(
            ledger.admit("run-1", &cleanup_bytes).unwrap_err(),
            ControlError::RetiredOrUnseen
        );
        assert_eq!(ledger.seen_through(Lane::Cleanup), WireU64::new(u64::MAX));
        admit(&mut ledger, &empty(2));
        let masquerade = String::from_utf8(empty(3))
            .unwrap()
            .replace(":control-3", ":cleanup-3");
        assert_eq!(
            ledger.admit("run-1", masquerade.as_bytes()).unwrap_err(),
            ControlError::WrongIdentity
        );
    }
    #[test]
    fn lost_prepared_token_can_commit_only_the_retained_final_without_reexecution() {
        let mut ledger = ledger();
        let identity = admit(&mut ledger, &empty(1));
        let ticket = ledger.begin(&identity).unwrap().ticket;
        drop(ledger.prepare_final(&ticket, ok_snapshot(7)).unwrap());
        assert_eq!(
            ledger.begin(&identity).unwrap_err(),
            ControlError::NotQueued
        );
        let bytes = ledger.commit_retained_final(&ticket).unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["snapshot"]["controlRevision"], "7");
        assert_eq!(
            ledger.commit_retained_final(&ticket).unwrap_err(),
            ControlError::NotExecuting
        );
    }
    #[test]
    fn retry_close_requires_both_canonical_expected_fences() {
        let mut ledger = ledger();
        let payload = serde_json::json!({"preview":{"version":"1.0","runId":"run-1","previewId":"p-1","leaseRevision":"1"},
            "expectedControlRevision":"18446744073709551615","expectedTerminalCleanupRevision":"2"});
        let identity = admit(&mut ledger, &request(1, "retryClose", payload.clone()));
        let ControlOperation::RetryClose(value) = ledger.begin(&identity).unwrap().operation else {
            panic!("actual retry payload");
        };
        assert_eq!(value.expected_control_revision, WireU64::new(u64::MAX));
        assert_eq!(value.expected_terminal_cleanup_revision, WireU64::new(2));
        let mut missing = payload;
        missing
            .as_object_mut()
            .unwrap()
            .remove("expectedTerminalCleanupRevision");
        assert!(ledger
            .admit("run-1", &request(2, "retryClose", missing))
            .is_err());
    }
    fn worker_close_receipt() -> Value {
        serde_json::json!({
            "version":"1.0", "closed":true, "workerClosed":true, "ownedMountRemoved":true,
            "owner":{"workerEpoch":"epoch-1","sessionId":"session-1",
                "packSha256":"a".repeat(64),"transportBackend":"browser-view"},
            "rpcIdentity":{"workerEpoch":"epoch-1","sessionId":"session-1"},
            "workerFinal":{"closed":true,"diagnostics":[]}
        })
    }
    fn closed_report_payload(receipt: Value) -> Value {
        let owner =
            serde_json::json!({"activationId":"1","ownerSerial":"2","clientOwnerId":"owner-1"});
        let ticket = serde_json::json!({"version":"1.0","closeRevision":"9","terminalCleanupRevision":"2",
            "preview":{"version":"1.0","runId":"run-1","previewId":"p-1","leaseRevision":"1"},
            "owner":owner,"replacesWithActivation":null});
        serde_json::json!({"ticket":ticket,"closeFinal":{"evidenceOrigin":"browser-reported",
            "success":true,"pendingActual":false,"ownerKey":owner,"outcome":"closed","receipt":receipt}})
    }
    fn reject_close_payload_without_admission(payload: Value) {
        let mut ledger = ledger();
        assert!(ledger
            .admit("run-1", &request(1, "finishClose", payload))
            .is_err());
        assert_eq!(ledger.usage(Lane::Cleanup), LaneUsage::default());
        assert_eq!(ledger.seen_through(Lane::Cleanup), WireU64::new(0));
    }
    #[test]
    fn close_report_is_bounded_typed_evidence_not_a_cleanup_success_decision() {
        let mut ledger = ledger();
        let payload = closed_report_payload(worker_close_receipt());
        let identity = admit(&mut ledger, &request(1, "finishClose", payload.clone()));
        let ControlOperation::FinishClose(value) = ledger.begin(&identity).unwrap().operation
        else {
            panic!("actual close report");
        };
        assert_eq!(value.ticket.terminal_cleanup_revision, WireU64::new(2));
        // Typed shape is still untrusted. No coordinator or actual close was called.
        let receipt = value.close_final.receipt.unwrap();
        assert_eq!(receipt.owner.unwrap().pack_sha256, "a".repeat(64));
        assert_eq!(receipt.rpc_identity.unwrap().worker_epoch, "epoch-1");
        let mut impossible = payload;
        impossible["closeFinal"]["pendingActual"] = Value::Bool(true);
        reject_close_payload_without_admission(impossible);
    }
    #[test]
    fn closed_receipt_preserves_unloaded_preadmission_and_admitted_shapes() {
        let mut unloaded = worker_close_receipt();
        unloaded["owner"] = Value::Null;
        unloaded["rpcIdentity"] = Value::Null;
        unloaded["workerFinal"] = Value::Null;
        let mut preadmission = worker_close_receipt();
        preadmission["owner"] = Value::Null;
        for (receipt, has_rpc, has_owner) in [
            (unloaded, false, false),
            (preadmission, true, false),
            (worker_close_receipt(), true, true),
        ] {
            let mut ledger = ledger();
            let identity = admit(
                &mut ledger,
                &request(1, "finishClose", closed_report_payload(receipt)),
            );
            let ControlOperation::FinishClose(value) = ledger.begin(&identity).unwrap().operation
            else {
                panic!("typed close report");
            };
            assert_eq!(value.close_final.outcome.as_deref(), Some("closed"));
            let receipt = value.close_final.receipt.unwrap();
            assert_eq!(receipt.rpc_identity.is_some(), has_rpc);
            assert_eq!(receipt.owner.is_some(), has_owner);
        }
    }
    #[test]
    fn closed_receipt_requires_explicit_nullable_identity_and_final_fields() {
        for field in ["owner", "rpcIdentity", "workerFinal"] {
            let mut receipt = worker_close_receipt();
            receipt.as_object_mut().unwrap().remove(field);
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
    }
    #[test]
    fn closed_receipt_rejects_malformed_rpc_and_owner_identity_fields() {
        for field in ["workerEpoch", "sessionId"] {
            for invalid in ["", "bad identity", "-bad", &"x".repeat(129)] {
                for target in ["owner", "rpcIdentity"] {
                    let mut receipt = worker_close_receipt();
                    receipt[target][field] = Value::String(invalid.to_owned());
                    reject_close_payload_without_admission(closed_report_payload(receipt));
                }
            }
            for target in ["owner", "rpcIdentity"] {
                let mut receipt = worker_close_receipt();
                receipt[target].as_object_mut().unwrap().remove(field);
                reject_close_payload_without_admission(closed_report_payload(receipt));
            }
        }
        for invalid in ["a".repeat(63), "A".repeat(64), "g".repeat(64)] {
            let mut receipt = worker_close_receipt();
            receipt["owner"]["packSha256"] = Value::String(invalid);
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
        for invalid in [Value::String("software".into()), Value::Null] {
            let mut receipt = worker_close_receipt();
            receipt["owner"]["transportBackend"] = invalid;
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
    }
    #[test]
    fn closed_receipt_rejects_owner_rpc_mismatch_or_missing_allocation() {
        for field in ["workerEpoch", "sessionId"] {
            let mut receipt = worker_close_receipt();
            receipt["rpcIdentity"][field] = Value::String("other-identity".into());
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
        let mut receipt = worker_close_receipt();
        receipt["rpcIdentity"] = Value::Null;
        receipt["workerFinal"] = Value::Null;
        reject_close_payload_without_admission(closed_report_payload(receipt));
        let mut receipt = worker_close_receipt();
        receipt["owner"] = Value::Null;
        receipt["rpcIdentity"] = Value::Null;
        reject_close_payload_without_admission(closed_report_payload(receipt));
    }
    #[test]
    fn closed_receipt_requires_successful_versioned_wrapper_and_worker_results() {
        for field in ["closed", "workerClosed", "ownedMountRemoved"] {
            for invalid in [
                Value::Bool(false),
                Value::Null,
                Value::String("true".into()),
            ] {
                let mut receipt = worker_close_receipt();
                receipt[field] = invalid;
                reject_close_payload_without_admission(closed_report_payload(receipt));
            }
        }
        for invalid in [Value::String("2.0".into()), Value::Null] {
            let mut receipt = worker_close_receipt();
            receipt["version"] = invalid;
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
        for invalid in [
            Value::Null,
            serde_json::json!({}),
            serde_json::json!({"closed":false}),
            serde_json::json!({"closed":"true"}),
            Value::Bool(true),
        ] {
            let mut receipt = worker_close_receipt();
            receipt["workerFinal"] = invalid;
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
    }
    #[test]
    fn closed_receipt_rejects_unknown_or_duplicate_identity_fields_before_admission() {
        for target in ["", "owner", "rpcIdentity"] {
            let mut receipt = worker_close_receipt();
            let value = if target.is_empty() {
                &mut receipt
            } else {
                &mut receipt[target]
            };
            value["invented"] = Value::Bool(true);
            reject_close_payload_without_admission(closed_report_payload(receipt));
        }
        let mut ledger = ledger();
        let text = String::from_utf8(request(
            1,
            "finishClose",
            closed_report_payload(worker_close_receipt()),
        ))
        .unwrap();
        let duplicate = text.replacen(
            "\"sessionId\":\"session-1\"",
            "\"sessionId\":\"session-1\",\"sessionId\":\"session-1\"",
            1,
        );
        assert_ne!(duplicate, text);
        assert!(ledger.admit("run-1", duplicate.as_bytes()).is_err());
        assert_eq!(ledger.usage(Lane::Cleanup), LaneUsage::default());
        assert_eq!(ledger.seen_through(Lane::Cleanup), WireU64::new(0));
    }
    #[test]
    fn typed_closed_receipt_cannot_be_relabelled_as_never_constructed_or_failure() {
        let mut never = closed_report_payload(worker_close_receipt());
        never["closeFinal"]["outcome"] = Value::String("never-constructed".into());
        never["closeFinal"]["workerClosed"] = Value::Bool(true);
        never["closeFinal"]["ownedMountRemoved"] = Value::Bool(true);
        reject_close_payload_without_admission(never.clone());
        never["closeFinal"]
            .as_object_mut()
            .unwrap()
            .remove("receipt");
        let mut ledger = ledger();
        admit(&mut ledger, &request(1, "finishClose", never));

        let mut failure = closed_report_payload(worker_close_receipt());
        failure["closeFinal"]["success"] = Value::Bool(false);
        failure["closeFinal"]["error"] =
            serde_json::json!({"code":"ERR_RENDER","message":"actual close failed"});
        reject_close_payload_without_admission(failure);
        let mut contradictory = closed_report_payload(worker_close_receipt());
        contradictory["closeFinal"]["error"] =
            serde_json::json!({"code":"ERR_RENDER","message":"failure remains"});
        reject_close_payload_without_admission(contradictory);
    }
    #[test]
    fn errors_use_utf8_byte_bounds_and_nonempty_values() {
        assert!(ErrorFact::new("ERR_ENGINE", &"错".repeat(682)).is_ok());
        assert!(ErrorFact::new("ERR_ENGINE", &"错".repeat(683)).is_err());
        assert!(ErrorFact::new("", "message").is_err());
        assert!(ErrorFact::new("ERR_ENGINE", "").is_err());
        assert!(ErrorFact::new(&"X".repeat(129), "message").is_err());
    }
    #[test]
    fn deeply_nested_payload_is_refused_before_typed_dispatch_or_capacity_charge() {
        let mut ledger = ledger();
        let mut payload = Value::Null;
        for _ in 0..MAX_JSON_DEPTH + 2 {
            payload = serde_json::json!({"nested":payload});
        }
        assert_eq!(
            ledger
                .admit("run-1", &request(1, "snapshot", payload))
                .unwrap_err(),
            ControlError::TooLarge
        );
        assert_eq!(ledger.usage(Lane::Normal), LaneUsage::default());
    }
}
