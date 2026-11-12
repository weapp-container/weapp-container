//! Shared, native-only disclosure admission and consent revocation barriers.
//!
//! The mutex protects only bookkeeping. A permit, never a mutex guard, crosses
//! an engine turn. JSON fences are descriptions, not authority-bearing handles.
use crate::{HostAccount, Instant, TrustedApplication};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard, Weak},
    time::Duration,
};

const LIMIT: usize = 64;
const MAX_CAPTURE_AGE: Duration = Duration::from_secs(300);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct StrictU64(u64);

impl StrictU64 {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
}
impl From<u64> for StrictU64 {
    fn from(value: u64) -> Self {
        Self(value)
    }
}
impl TryFrom<&str> for StrictU64 {
    type Error = ConsentAuthorityError;
    fn try_from(value: &str) -> Result<Self, Self::Error> {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(ConsentAuthorityError::InvalidInput);
        }
        value
            .parse()
            .map(Self)
            .map_err(|_| ConsentAuthorityError::InvalidInput)
    }
}
impl Serialize for StrictU64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for StrictU64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::try_from(value.as_str()).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentKind {
    Profile,
    Phone,
}
impl ConsentKind {
    const fn index(self) -> usize {
        match self {
            Self::Profile => 0,
            Self::Phone => 1,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, try_from = "FenceWire")]
pub struct ConsentFence {
    pub protocol_version: String,
    pub scope_id: String,
    pub kind: ConsentKind,
    pub generation: StrictU64,
    pub revision: Option<StrictU64>,
    pub owner_revision: StrictU64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FenceWire {
    protocol_version: String,
    scope_id: String,
    kind: ConsentKind,
    generation: StrictU64,
    #[serde(deserialize_with = "required_revision")]
    revision: Option<StrictU64>,
    owner_revision: StrictU64,
}
fn required_revision<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<StrictU64>, D::Error> {
    Option::<StrictU64>::deserialize(deserializer)
}
impl TryFrom<FenceWire> for ConsentFence {
    type Error = ConsentAuthorityError;
    fn try_from(wire: FenceWire) -> Result<Self, Self::Error> {
        if wire.protocol_version != "1.0" || !container_ir::is_sha256(&wire.scope_id) {
            return Err(ConsentAuthorityError::InvalidInput);
        }
        Ok(Self {
            protocol_version: wire.protocol_version,
            scope_id: wire.scope_id,
            kind: wire.kind,
            generation: wire.generation,
            revision: wire.revision,
            owner_revision: wire.owner_revision,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConsentState {
    pub revision: StrictU64,
    pub granted: bool,
    pub expires_in: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ConsentAuthorityError {
    #[error("invalid consent input")]
    InvalidInput,
    #[error("consent handle belongs to another authority")]
    WrongAuthority,
    #[error("consent owner has retired")]
    RetiredOwner,
    #[error("consent authority has no trusted baseline")]
    Uninitialized,
    #[error("consent is not granted or revocation is draining")]
    NotGranted,
    #[error("consent fence is stale")]
    StaleFence,
    #[error("consent authority requires explicit reconciliation")]
    ReconciliationRequired,
    #[error("consent observation, decision or grant expired")]
    Expired,
    #[error("consent authority bounded capacity reached")]
    Capacity,
    #[error("consent authority monotonic counter exhausted")]
    Exhausted,
    #[error("consent handle or operation was not found")]
    NotFound,
    #[error("consent receipt conflicts with the registered request")]
    Conflict,
    #[error("consent owner still has admitted disclosures")]
    NotDrained,
    #[error("consent authority mutex is poisoned")]
    Poisoned,
}
impl ConsentAuthorityError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidInput | Self::WrongAuthority | Self::Conflict => "ERR_CONSENT_PROTOCOL",
            Self::RetiredOwner => "ERR_CONSENT_OWNER_RETIRED",
            Self::Uninitialized => "ERR_CONSENT_UNINITIALIZED",
            Self::NotGranted => "ERR_CONSENT_REVOKED",
            Self::StaleFence => "ERR_CONSENT_STALE",
            Self::ReconciliationRequired => "ERR_CONSENT_RECONCILIATION_REQUIRED",
            Self::Expired => "ERR_CONSENT_EXPIRED",
            Self::Capacity => "ERR_CONSENT_CAPACITY",
            Self::Exhausted => "ERR_CONSENT_EXHAUSTED",
            Self::NotFound => "ERR_CONSENT_NOT_FOUND",
            Self::NotDrained => "ERR_CONSENT_NOT_DRAINED",
            Self::Poisoned => "ERR_CONSENT_POISONED",
        }
    }
}
type Result<T, E = ConsentAuthorityError> = std::result::Result<T, E>;

#[derive(Clone, Debug)]
pub struct NativeConsentAuthority(Arc<Mutex<AuthorityState>>);
#[derive(Clone, Debug)]
pub struct ConsentOwner {
    authority: Weak<Mutex<AuthorityState>>,
    revision: u64,
    application: TrustedApplication,
    account: HostAccount,
    session_id: String,
    scope_id: String,
}
impl ConsentOwner {
    pub fn application(&self) -> &TrustedApplication {
        &self.application
    }
    pub fn account(&self) -> &HostAccount {
        &self.account
    }
    pub fn session_id(&self) -> &str {
        &self.session_id
    }
    pub fn owner_revision(&self) -> StrictU64 {
        self.revision.into()
    }
    pub fn scope_id(&self) -> &str {
        &self.scope_id
    }
}
#[derive(Clone, Debug)]
pub struct ConsentStamp {
    owner: ConsentOwner,
    fence: ConsentFence,
    captured_at: Instant,
}
impl ConsentStamp {
    pub fn fence(&self) -> &ConsentFence {
        &self.fence
    }
    pub fn owner(&self) -> &ConsentOwner {
        &self.owner
    }
}
#[derive(Clone, Debug)]
pub struct ConsentObservation {
    id: u64,
    stamp: ConsentStamp,
}
impl ConsentObservation {
    pub fn id(&self) -> StrictU64 {
        self.id.into()
    }
    pub fn fence(&self) -> &ConsentFence {
        self.stamp.fence()
    }
}
#[derive(Clone, Debug)]
pub struct ConsentDecisionAttempt {
    id: u64,
    stamp: ConsentStamp,
    call_id: String,
    decision_id: String,
}
impl ConsentDecisionAttempt {
    pub fn id(&self) -> StrictU64 {
        self.id.into()
    }
    pub fn call_id(&self) -> &str {
        &self.call_id
    }
    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }
}
#[derive(Clone, Debug)]
pub struct ConsentRevocationAttempt {
    authority: Weak<Mutex<AuthorityState>>,
    operation_id: String,
    decision_id: String,
    attempt: u64,
}
impl ConsentRevocationAttempt {
    pub fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub fn decision_id(&self) -> &str {
        &self.decision_id
    }
    pub fn attempt(&self) -> StrictU64 {
        self.attempt.into()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentOperationStatus {
    Pending,
    Complete,
    Failed,
    Superseded,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConsentOperationPhase {
    Backend,
    Draining,
    Complete,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentOwnerReceipt {
    pub owner_revision: StrictU64,
    pub acknowledged: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsentOperationReceipt {
    pub operation_id: String,
    pub scope_id: String,
    pub kind: ConsentKind,
    pub generation: StrictU64,
    pub attempt: StrictU64,
    pub status: ConsentOperationStatus,
    pub phase: ConsentOperationPhase,
    pub backend_committed: bool,
    /// Unresolved decisions for this scope/kind, including older operations.
    pub backend_pending: StrictU64,
    pub revision: Option<StrictU64>,
    /// The highest verified backend revision known for the shared authority.
    pub authority_revision: Option<StrictU64>,
    pub owners: Vec<ConsentOwnerReceipt>,
    pub cleanup_pending: StrictU64,
    pub error: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AuthorityStatus {
    Uninitialized,
    Current,
    Fenced,
    ReconciliationRequired,
}
#[derive(Debug)]
struct KindState {
    generation: u64,
    revision: Option<u64>,
    granted: bool,
    expires_at: Option<Instant>,
    status: AuthorityStatus,
    active_operation: Option<String>,
    terminal_faults: BTreeSet<u64>,
}
impl Default for KindState {
    fn default() -> Self {
        Self {
            generation: 0,
            revision: None,
            granted: false,
            expires_at: None,
            status: AuthorityStatus::Uninitialized,
            active_operation: None,
            terminal_faults: BTreeSet::new(),
        }
    }
}
#[derive(Debug, Default)]
struct Scope {
    kinds: [KindState; 2],
}
#[derive(Debug)]
struct OwnerRecord {
    scope_id: String,
    active: bool,
    retired_drained: bool,
    installed: [Option<u64>; 2],
    cleaned: [Option<u64>; 2],
    permits: [u64; 2],
}
#[derive(Debug)]
struct ObservationRecord {
    stamp: ConsentStamp,
    deadline: Instant,
}
#[derive(Debug)]
struct DecisionRecord {
    handle: ConsentDecisionAttempt,
    deadline: Instant,
    result: Option<ConsentStamp>,
}
#[derive(Debug, PartialEq, Eq)]
enum RevocationRequester {
    Owner(u64),
    Native {
        version: String,
        pack_root: String,
        epoch: u64,
    },
}
#[derive(Debug)]
struct Operation {
    scope_id: String,
    kind: ConsentKind,
    generation: u64,
    decision_id: String,
    requester: RevocationRequester,
    expected_revision: Option<u64>,
    attempt: u64,
    backend_revision: Option<u64>,
    owners: BTreeMap<u64, bool>,
    status: ConsentOperationStatus,
    error: Option<String>,
}
#[derive(Debug, Default)]
struct AuthorityState {
    exhausted: bool,
    next_owner: u64,
    next_capture: u64,
    next_operation: u64,
    scopes: BTreeMap<String, Scope>,
    owners: BTreeMap<u64, OwnerRecord>,
    observations: BTreeMap<u64, ObservationRecord>,
    decisions: BTreeMap<u64, DecisionRecord>,
    operations: BTreeMap<String, Operation>,
    terminal_order: Vec<String>,
}

impl Default for NativeConsentAuthority {
    fn default() -> Self {
        Self::new()
    }
}
impl NativeConsentAuthority {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(AuthorityState::default())))
    }
    fn lock(&self) -> Result<MutexGuard<'_, AuthorityState>> {
        self.0.lock().map_err(|_| ConsentAuthorityError::Poisoned)
    }
    fn owns(&self, owner: &ConsentOwner) -> Result<()> {
        if Weak::ptr_eq(&owner.authority, &Arc::downgrade(&self.0)) {
            Ok(())
        } else {
            Err(ConsentAuthorityError::WrongAuthority)
        }
    }
    pub fn register_owner(
        &self,
        application: TrustedApplication,
        account: HostAccount,
        session_id: String,
    ) -> Result<ConsentOwner> {
        validate_identity(&application, &account)?;
        bounded_text(&session_id, 512)?;
        let scope_id = durable_scope(&application, &account)?;
        let mut state = self.lock()?;
        if state.exhausted {
            return Err(ConsentAuthorityError::Exhausted);
        }
        if state.owners.len() >= LIMIT
            || (!state.scopes.contains_key(&scope_id) && state.scopes.len() >= LIMIT)
        {
            return Err(ConsentAuthorityError::Capacity);
        }
        let revision = next_counter(&mut state, Counter::Owner)?;
        state.scopes.entry(scope_id.clone()).or_default();
        state.owners.insert(
            revision,
            OwnerRecord {
                scope_id: scope_id.clone(),
                active: true,
                retired_drained: false,
                installed: [None; 2],
                cleaned: [None; 2],
                permits: [0; 2],
            },
        );
        for operation in state
            .operations
            .values_mut()
            .filter(|operation| operation.scope_id == scope_id && !terminal(operation.status))
        {
            operation.owners.insert(revision, false);
        }
        Ok(ConsentOwner {
            authority: Arc::downgrade(&self.0),
            revision,
            application,
            account,
            session_id,
            scope_id,
        })
    }
    pub fn owner_is_active(&self, owner: &ConsentOwner) -> bool {
        self.owner_activity(owner).unwrap_or(false)
    }
    /// Errors must remain distinguishable from a retired owner at disclosure.
    pub fn owner_activity(&self, owner: &ConsentOwner) -> Result<bool> {
        self.owns(owner)?;
        let state = self.lock()?;
        Ok(state
            .owners
            .get(&owner.revision)
            .is_some_and(|record| record.active))
    }
    pub fn retire_owner(&self, owner: &ConsentOwner) -> Result<()> {
        self.owns(owner)?;
        let mut state = self.lock()?;
        let record = state
            .owners
            .get_mut(&owner.revision)
            .ok_or(ConsentAuthorityError::RetiredOwner)?;
        record.active = false;
        state
            .observations
            .retain(|_, value| value.stamp.owner.revision != owner.revision);
        state
            .decisions
            .retain(|_, value| value.handle.stamp.owner.revision != owner.revision);
        // Do not remove the record, acknowledge its lane, or zero its permits.
        refresh_operations(&mut state);
        Ok(())
    }
    pub fn acknowledge_retired_owner(&self, owner: &ConsentOwner) -> Result<()> {
        self.owns(owner)?;
        let mut state = self.lock()?;
        let generations = state
            .scopes
            .get(&owner.scope_id)
            .ok_or(ConsentAuthorityError::NotFound)?
            .kinds
            .each_ref()
            .map(|kind| kind.generation);
        let record = state
            .owners
            .get_mut(&owner.revision)
            .ok_or(ConsentAuthorityError::RetiredOwner)?;
        if record.active {
            return Err(ConsentAuthorityError::Conflict);
        }
        if record.permits != [0; 2] {
            return Err(ConsentAuthorityError::NotDrained);
        }
        record.retired_drained = true;
        record.installed = generations.map(Some);
        record.cleaned = generations.map(Some);
        for kind in &mut state
            .scopes
            .get_mut(&owner.scope_id)
            .expect("registered scope")
            .kinds
        {
            // A failed terminal reservation can only be cleared by the real
            // owner close barrier, not by an optimistic live projection ACK.
            kind.terminal_faults.remove(&owner.revision);
        }
        refresh_operations(&mut state);
        prune_retired(&mut state);
        Ok(())
    }
    /// Called by the runtime lane after installing the safe projection and
    /// after actual native resources have completed, never by a guest receipt.
    pub fn acknowledge_owner(
        &self,
        owner: &ConsentOwner,
        kind: ConsentKind,
        generation: StrictU64,
        native_cleanup_complete: bool,
    ) -> Result<()> {
        self.owns(owner)?;
        let mut state = self.lock()?;
        live_owner(&state, owner)?;
        if state.scopes[&owner.scope_id].kinds[kind.index()].generation != generation.get() {
            return Err(ConsentAuthorityError::StaleFence);
        }
        let record = state
            .owners
            .get_mut(&owner.revision)
            .expect("validated owner");
        record.installed[kind.index()] = Some(generation.get());
        if native_cleanup_complete {
            record.cleaned[kind.index()] = Some(generation.get());
        }
        refresh_operations(&mut state);
        Ok(())
    }
    pub fn capture(&self, owner: &ConsentOwner, kind: ConsentKind) -> Result<ConsentStamp> {
        self.owns(owner)?;
        let state = self.lock()?;
        live_owner(&state, owner)?;
        Ok(mint_stamp(&state, owner, kind, Instant::now()))
    }
    pub fn check(&self, stamp: &ConsentStamp) -> Result<()> {
        self.owns(&stamp.owner)?;
        let state = self.lock()?;
        validate_stamp(&state, stamp, true, Instant::now())
    }
    pub fn claim(&self, stamp: &ConsentStamp) -> Result<ConsentPermit> {
        self.owns(&stamp.owner)?;
        let mut state = self.lock()?;
        validate_stamp(&state, stamp, true, Instant::now())?;
        reserve_permit(&mut state, &stamp.owner, stamp.fence.kind)?;
        Ok(ConsentPermit {
            authority: self.0.clone(),
            owner: stamp.owner.revision,
            kind: stamp.fence.kind,
        })
    }
    /// An execution/drain reservation only. It does not authorize disclosure;
    /// every successful delivery must separately pass `check` or `claim` with
    /// its private stamp at the actual delivery linearization point.
    pub fn claim_terminal(&self, owner: &ConsentOwner, kind: ConsentKind) -> Result<ConsentPermit> {
        self.owns(owner)?;
        let mut state = self.lock()?;
        live_owner(&state, owner)?;
        if let Err(error) = reserve_permit(&mut state, owner, kind) {
            let current = &mut state
                .scopes
                .get_mut(&owner.scope_id)
                .expect("registered scope")
                .kinds[kind.index()];
            current.status = AuthorityStatus::Fenced;
            current.terminal_faults.insert(owner.revision);
            return Err(error);
        }
        Ok(ConsentPermit {
            authority: self.0.clone(),
            owner: owner.revision,
            kind,
        })
    }
    pub fn capture_observation(
        &self,
        owner: &ConsentOwner,
        kind: ConsentKind,
        ttl: Duration,
    ) -> Result<ConsentObservation> {
        self.owns(owner)?;
        let now = Instant::now();
        let deadline = capture_deadline(now, ttl)?;
        let mut state = self.lock()?;
        live_owner(&state, owner)?;
        reap_captures(&mut state, now);
        if state.observations.len() >= LIMIT {
            return Err(ConsentAuthorityError::Capacity);
        }
        let id = next_counter(&mut state, Counter::Capture)?;
        let stamp = mint_stamp(&state, owner, kind, now);
        state.observations.insert(
            id,
            ObservationRecord {
                stamp: stamp.clone(),
                deadline,
            },
        );
        Ok(ConsentObservation { id, stamp })
    }
    pub fn initialize(
        &self,
        observation: &ConsentObservation,
        receipt: ConsentState,
    ) -> Result<ConsentFence> {
        self.apply_observation_inner(observation, receipt, true)
    }
    pub fn apply_observation(
        &self,
        observation: &ConsentObservation,
        receipt: ConsentState,
    ) -> Result<ConsentFence> {
        self.apply_observation_inner(observation, receipt, false)
    }
    fn apply_observation_inner(
        &self,
        observation: &ConsentObservation,
        receipt: ConsentState,
        initialize: bool,
    ) -> Result<ConsentFence> {
        self.owns(&observation.stamp.owner)?;
        let now = Instant::now();
        let mut state = self.lock()?;
        let saved = state
            .observations
            .remove(&observation.id)
            .ok_or(ConsentAuthorityError::NotFound)?;
        if saved.deadline <= now {
            return Err(ConsentAuthorityError::Expired);
        }
        validate_stamp(&state, &saved.stamp, false, now)?;
        // A verified observation can shorten an existing grant to zero. Do not
        // return Expired before installing that restriction or recognizing a
        // revision conflict, or another already captured call could disclose.
        let expires_at = receipt_deadline(&saved.stamp, receipt)?;
        let kind = &mut state
            .scopes
            .get_mut(&saved.stamp.owner.scope_id)
            .expect("registered scope")
            .kinds[saved.stamp.fence.kind.index()];
        if initialize {
            if kind.status != AuthorityStatus::Uninitialized
                || kind.revision.is_some()
                || kind.active_operation.is_some()
            {
                return Err(ConsentAuthorityError::Conflict);
            }
            if receipt.granted && saved.stamp.owner.account.principal_id.is_none() {
                return Err(ConsentAuthorityError::NotGranted);
            }
            if receipt.granted && expires_at.is_none_or(|expiry| expiry <= now) {
                return Err(ConsentAuthorityError::Expired);
            }
            kind.revision = Some(receipt.revision.get());
            kind.granted = receipt.granted;
            kind.expires_at = expires_at;
            kind.status = AuthorityStatus::Current;
        } else {
            if kind.status == AuthorityStatus::Uninitialized {
                return Err(ConsentAuthorityError::Uninitialized);
            }
            if kind.active_operation.is_some() || kind.status == AuthorityStatus::Fenced {
                return Err(ConsentAuthorityError::NotGranted);
            }
            if kind.status == AuthorityStatus::ReconciliationRequired {
                return Err(ConsentAuthorityError::ReconciliationRequired);
            }
            if kind.revision != Some(receipt.revision.get()) || kind.granted != receipt.granted {
                kind.status = AuthorityStatus::ReconciliationRequired;
                return Err(ConsentAuthorityError::ReconciliationRequired);
            }
            kind.expires_at = match (kind.expires_at, expires_at) {
                (Some(old), Some(new)) => Some(old.min(new)),
                (old, _) => old,
            };
            if kind.granted && kind.expires_at.is_none_or(|expiry| expiry <= now) {
                return Err(ConsentAuthorityError::Expired);
            }
        }
        Ok(mint_stamp(&state, &saved.stamp.owner, saved.stamp.fence.kind, now).fence)
    }
    pub fn prepare_decision(
        &self,
        stamp: &ConsentStamp,
        call_id: &str,
        decision_id: &str,
        expected_revision: Option<StrictU64>,
        ttl: Duration,
    ) -> Result<ConsentDecisionAttempt> {
        self.owns(&stamp.owner)?;
        bounded_text(call_id, 512)?;
        validate_decision_id(decision_id)?;
        let now = Instant::now();
        let deadline = capture_deadline(now, ttl)?;
        let mut state = self.lock()?;
        validate_stamp(&state, stamp, false, now)?;
        decision_admission(&state, stamp)?;
        if stamp.fence.revision != expected_revision {
            return Err(ConsentAuthorityError::Conflict);
        }
        reap_captures(&mut state, now);
        if let Some(saved) = state.decisions.values().find(|saved| {
            saved.handle.stamp.owner.scope_id == stamp.owner.scope_id
                && saved.handle.stamp.fence.kind == stamp.fence.kind
                && saved.handle.decision_id == decision_id
        }) {
            if saved.handle.call_id == call_id
                && saved.handle.stamp.owner.revision == stamp.owner.revision
                && saved.handle.stamp.fence == stamp.fence
                && saved.result.is_none()
            {
                return Ok(saved.handle.clone());
            }
            return Err(ConsentAuthorityError::Conflict);
        }
        if state.decisions.len() >= LIMIT {
            return Err(ConsentAuthorityError::Capacity);
        }
        let id = next_counter(&mut state, Counter::Capture)?;
        // Expiration is anchored before the UI/backend work, not at receipt.
        let mut captured = stamp.clone();
        captured.captured_at = now;
        let handle = ConsentDecisionAttempt {
            id,
            stamp: captured,
            call_id: call_id.into(),
            decision_id: decision_id.into(),
        };
        state.decisions.insert(
            id,
            DecisionRecord {
                handle: handle.clone(),
                deadline,
                result: None,
            },
        );
        Ok(handle)
    }
    pub fn check_decision(&self, attempt: &ConsentDecisionAttempt) -> Result<()> {
        self.owns(&attempt.stamp.owner)?;
        let state = self.lock()?;
        let saved = state
            .decisions
            .get(&attempt.id)
            .ok_or(ConsentAuthorityError::NotFound)?;
        validate_decision(&state, saved, Instant::now())
    }
    pub fn commit_decision(
        &self,
        attempt: &ConsentDecisionAttempt,
        decision_id: &str,
        revision: StrictU64,
        expires_in: u32,
    ) -> Result<ConsentStamp> {
        self.owns(&attempt.stamp.owner)?;
        let now = Instant::now();
        let mut state = self.lock()?;
        let saved = state
            .decisions
            .get(&attempt.id)
            .ok_or(ConsentAuthorityError::NotFound)?;
        if saved.deadline <= now {
            return Err(ConsentAuthorityError::Expired);
        }
        if saved.handle.decision_id != decision_id {
            return Err(ConsentAuthorityError::Conflict);
        }
        if let Some(result) = &saved.result {
            if result.fence.revision != Some(revision) {
                return Err(ConsentAuthorityError::Conflict);
            }
            validate_stamp(&state, result, true, now)?;
            return Ok(result.clone());
        }
        validate_decision(&state, saved, now)?;
        let stamp = saved.handle.stamp.clone();
        let expected = stamp
            .fence
            .revision
            .ok_or(ConsentAuthorityError::Uninitialized)?
            .get();
        if expected.checked_add(1) != Some(revision.get()) {
            return Err(ConsentAuthorityError::Conflict);
        }
        let expiry = receipt_expiry(
            &stamp,
            ConsentState {
                revision,
                granted: true,
                expires_in,
            },
            now,
        )?;
        let kind = &mut state
            .scopes
            .get_mut(&stamp.owner.scope_id)
            .expect("registered scope")
            .kinds[stamp.fence.kind.index()];
        kind.revision = Some(revision.get());
        kind.granted = true;
        kind.expires_at = expiry;
        let adopted = mint_stamp(&state, &stamp.owner, stamp.fence.kind, stamp.captured_at);
        state
            .decisions
            .get_mut(&attempt.id)
            .expect("registered attempt")
            .result = Some(adopted.clone());
        Ok(adopted)
    }
    pub fn begin_revocation(
        &self,
        owner: &ConsentOwner,
        kind: ConsentKind,
        decision_id: &str,
    ) -> Result<ConsentRevocationAttempt> {
        self.owns(owner)?;
        let mut state = self.lock()?;
        live_owner(&state, owner)?;
        begin_revocation_locked(
            &self.0,
            &mut state,
            &owner.scope_id,
            kind,
            decision_id,
            RevocationRequester::Owner(owner.revision),
        )
    }
    pub fn begin_scope_revocation(
        &self,
        application: &TrustedApplication,
        account: &HostAccount,
        kind: ConsentKind,
        decision_id: &str,
    ) -> Result<ConsentRevocationAttempt> {
        validate_identity(application, account)?;
        validate_decision_id(decision_id)?;
        let scope = durable_scope(application, account)?;
        let mut state = self.lock()?;
        if !state.scopes.contains_key(&scope) {
            if state.scopes.len() >= LIMIT {
                return Err(ConsentAuthorityError::Capacity);
            }
            state.scopes.insert(scope.clone(), Scope::default());
        }
        begin_revocation_locked(
            &self.0,
            &mut state,
            &scope,
            kind,
            decision_id,
            RevocationRequester::Native {
                version: application.version.clone(),
                pack_root: application.pack_root.clone(),
                epoch: account.epoch,
            },
        )
    }
    pub fn commit_revocation(
        &self,
        attempt: &ConsentRevocationAttempt,
        decision_id: &str,
        revision: StrictU64,
    ) -> Result<ConsentOperationReceipt> {
        self.check_operation_authority(attempt)?;
        let mut state = self.lock()?;
        let operation = operation_attempt(&mut state, attempt)?;
        if operation.decision_id != decision_id {
            return Err(ConsentAuthorityError::Conflict);
        }
        if let Some(committed) = operation.backend_revision {
            if committed != revision.get() {
                return Err(ConsentAuthorityError::Conflict);
            }
        } else {
            if terminal(operation.status) || operation.status == ConsentOperationStatus::Failed {
                return Err(ConsentAuthorityError::Conflict);
            }
            if let Some(expected) = operation.expected_revision {
                // Deny has no expectedRevision CAS. Other deny/policy
                // transactions may have advanced the backend in between.
                if revision.get() <= expected {
                    return Err(ConsentAuthorityError::Conflict);
                }
            }
            operation.backend_revision = Some(revision.get());
        }
        let scope_id = operation.scope_id.clone();
        let kind = operation.kind;
        let current = &mut state
            .scopes
            .get_mut(&scope_id)
            .expect("operation scope")
            .kinds[kind.index()];
        if current.revision.is_none_or(|known| revision.get() > known) {
            current.revision = Some(revision.get());
            current.granted = false;
            current.expires_at = None;
            if current.active_operation.is_none() {
                // A verified previously unknown deny cannot be ignored even
                // after a local terminal operation. Fence any unexpected
                // reconciliation gap rather than preserving a newer grant.
                let Some(generation) = current.generation.checked_add(1) else {
                    state.exhausted = true;
                    return Err(ConsentAuthorityError::Exhausted);
                };
                current.generation = generation;
                current.status = AuthorityStatus::ReconciliationRequired;
            }
        }
        refresh_operations(&mut state);
        operation_receipt(&state, attempt.operation_id())
    }
    pub fn fail_revocation(
        &self,
        attempt: &ConsentRevocationAttempt,
        error: &str,
    ) -> Result<ConsentOperationReceipt> {
        self.check_operation_authority(attempt)?;
        bounded_text(error, 4096)?;
        let mut state = self.lock()?;
        let operation = operation_attempt(&mut state, attempt)?;
        if terminal(operation.status) {
            return Err(ConsentAuthorityError::Conflict);
        }
        if operation.status == ConsentOperationStatus::Failed {
            // The first failure is this attempt's terminal error. An ambiguous
            // transport failure does not resolve its backend decision; retry
            // must obtain the same decision's idempotent transaction receipt.
            return operation_receipt(&state, attempt.operation_id());
        }
        operation.status = ConsentOperationStatus::Failed;
        operation.error = Some(error.into());
        operation_receipt(&state, attempt.operation_id())
    }
    pub fn retry_revocation(&self, operation_id: &str) -> Result<ConsentRevocationAttempt> {
        let mut state = self.lock()?;
        let operation = state
            .operations
            .get_mut(operation_id)
            .ok_or(ConsentAuthorityError::NotFound)?;
        if operation.status != ConsentOperationStatus::Failed {
            return Err(ConsentAuthorityError::Conflict);
        }
        let Some(attempt) = operation.attempt.checked_add(1) else {
            state.exhausted = true;
            return Err(ConsentAuthorityError::Exhausted);
        };
        operation.attempt = attempt;
        operation.status = ConsentOperationStatus::Pending;
        operation.error = None;
        let handle = revocation_handle(&self.0, operation_id, operation);
        refresh_operations(&mut state);
        Ok(handle)
    }
    pub fn query_operation(&self, operation_id: &str) -> Result<ConsentOperationReceipt> {
        let mut state = self.lock()?;
        refresh_operations(&mut state);
        operation_receipt(&state, operation_id)
    }
    fn check_operation_authority(&self, attempt: &ConsentRevocationAttempt) -> Result<()> {
        if Weak::ptr_eq(&attempt.authority, &Arc::downgrade(&self.0)) {
            Ok(())
        } else {
            Err(ConsentAuthorityError::WrongAuthority)
        }
    }
}

#[derive(Debug)]
pub struct ConsentPermit {
    authority: Arc<Mutex<AuthorityState>>,
    owner: u64,
    kind: ConsentKind,
}
impl Drop for ConsentPermit {
    fn drop(&mut self) {
        let mut state = match self.authority.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(owner) = state.owners.get_mut(&self.owner) {
            let permits = &mut owner.permits[self.kind.index()];
            if *permits > 0 {
                *permits -= 1;
            } else {
                state.exhausted = true;
            }
        } else {
            state.exhausted = true;
        }
        refresh_operations(&mut state);
        prune_retired(&mut state);
    }
}

fn bounded_text(value: &str, max: usize) -> Result<()> {
    if value.is_empty() || value.len() > max || value.chars().any(char::is_control) {
        Err(ConsentAuthorityError::InvalidInput)
    } else {
        Ok(())
    }
}
fn validate_decision_id(value: &str) -> Result<()> {
    if !(22..=128).contains(&value.len())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        Err(ConsentAuthorityError::InvalidInput)
    } else {
        Ok(())
    }
}
fn validate_identity(application: &TrustedApplication, account: &HostAccount) -> Result<()> {
    for value in [
        &application.host_app_id,
        &application.tenant_id,
        &application.publisher_id,
        &application.app_id,
        &application.environment,
        &application.version,
    ] {
        bounded_text(value, 512)?;
    }
    if !container_ir::is_sha256(&application.pack_root) {
        return Err(ConsentAuthorityError::InvalidInput);
    }
    if let Some(principal) = &account.principal_id {
        bounded_text(principal, 512)?;
    }
    Ok(())
}
fn durable_scope(application: &TrustedApplication, account: &HostAccount) -> Result<String> {
    let encoded = serde_json::to_vec(&serde_json::json!([
        "consent-scope-v1",
        application.host_app_id,
        application.tenant_id,
        application.publisher_id,
        account.principal_id,
        application.app_id,
        application.environment
    ]))
    .map_err(|_| ConsentAuthorityError::InvalidInput)?;
    Ok(container_ir::hex_digest(&encoded))
}
fn live_owner(state: &AuthorityState, owner: &ConsentOwner) -> Result<()> {
    if state.exhausted {
        return Err(ConsentAuthorityError::Exhausted);
    }
    match state.owners.get(&owner.revision) {
        Some(record) if record.active && record.scope_id == owner.scope_id => Ok(()),
        _ => Err(ConsentAuthorityError::RetiredOwner),
    }
}
fn reserve_permit(
    state: &mut AuthorityState,
    owner: &ConsentOwner,
    kind: ConsentKind,
) -> Result<()> {
    let index = kind.index();
    let total: u64 = state
        .owners
        .values()
        .map(|owner| owner.permits[index])
        .sum();
    if total >= LIMIT as u64 {
        return Err(ConsentAuthorityError::Capacity);
    }
    state
        .owners
        .get_mut(&owner.revision)
        .expect("validated owner")
        .permits[index] += 1;
    Ok(())
}
fn mint_stamp(
    state: &AuthorityState,
    owner: &ConsentOwner,
    kind: ConsentKind,
    now: Instant,
) -> ConsentStamp {
    let authority = &state.scopes[&owner.scope_id].kinds[kind.index()];
    ConsentStamp {
        owner: owner.clone(),
        captured_at: now,
        fence: ConsentFence {
            protocol_version: "1.0".into(),
            scope_id: owner.scope_id.clone(),
            kind,
            generation: authority.generation.into(),
            revision: authority.revision.map(Into::into),
            owner_revision: owner.revision.into(),
        },
    }
}
fn validate_stamp(
    state: &AuthorityState,
    stamp: &ConsentStamp,
    grant: bool,
    now: Instant,
) -> Result<()> {
    live_owner(state, &stamp.owner)?;
    let current = &state.scopes[&stamp.owner.scope_id].kinds[stamp.fence.kind.index()];
    if current.generation != stamp.fence.generation.get()
        || current.revision.map(Into::into) != stamp.fence.revision
    {
        return Err(ConsentAuthorityError::StaleFence);
    }
    if grant {
        match current.status {
            AuthorityStatus::Uninitialized => return Err(ConsentAuthorityError::Uninitialized),
            AuthorityStatus::ReconciliationRequired => {
                return Err(ConsentAuthorityError::ReconciliationRequired)
            }
            AuthorityStatus::Fenced => return Err(ConsentAuthorityError::NotGranted),
            AuthorityStatus::Current => {}
        }
        if !current.granted
            || stamp.owner.account.principal_id.is_none()
            || current.active_operation.is_some()
        {
            return Err(ConsentAuthorityError::NotGranted);
        }
        if current.expires_at.is_none_or(|expiry| expiry <= now) {
            return Err(ConsentAuthorityError::Expired);
        }
    }
    Ok(())
}
fn decision_admission(state: &AuthorityState, stamp: &ConsentStamp) -> Result<()> {
    let kind = &state.scopes[&stamp.owner.scope_id].kinds[stamp.fence.kind.index()];
    if stamp.owner.account.principal_id.is_none() {
        return Err(ConsentAuthorityError::NotGranted);
    }
    match kind.status {
        AuthorityStatus::Uninitialized => Err(ConsentAuthorityError::Uninitialized),
        AuthorityStatus::ReconciliationRequired => {
            Err(ConsentAuthorityError::ReconciliationRequired)
        }
        AuthorityStatus::Fenced => Err(ConsentAuthorityError::NotGranted),
        AuthorityStatus::Current if kind.active_operation.is_none() => Ok(()),
        _ => Err(ConsentAuthorityError::NotGranted),
    }
}
fn validate_decision(state: &AuthorityState, saved: &DecisionRecord, now: Instant) -> Result<()> {
    if saved.deadline <= now {
        return Err(ConsentAuthorityError::Expired);
    }
    if saved.result.is_some() {
        return Err(ConsentAuthorityError::Conflict);
    }
    validate_stamp(state, &saved.handle.stamp, false, now)?;
    decision_admission(state, &saved.handle.stamp)
}
fn capture_deadline(now: Instant, ttl: Duration) -> Result<Instant> {
    if ttl.is_zero() || ttl > MAX_CAPTURE_AGE {
        return Err(ConsentAuthorityError::InvalidInput);
    }
    now.checked_add(ttl)
        .ok_or(ConsentAuthorityError::InvalidInput)
}
fn receipt_expiry(
    stamp: &ConsentStamp,
    receipt: ConsentState,
    now: Instant,
) -> Result<Option<Instant>> {
    let expiry = receipt_deadline(stamp, receipt)?;
    if receipt.granted && expiry.is_none_or(|expiry| expiry <= now) {
        return Err(ConsentAuthorityError::Expired);
    }
    Ok(expiry)
}
fn receipt_deadline(stamp: &ConsentStamp, receipt: ConsentState) -> Result<Option<Instant>> {
    if !receipt.granted {
        return if receipt.expires_in == 0 {
            Ok(None)
        } else {
            Err(ConsentAuthorityError::InvalidInput)
        };
    }
    let expiry = stamp
        .captured_at
        .checked_add(Duration::from_secs(u64::from(receipt.expires_in)))
        .ok_or(ConsentAuthorityError::InvalidInput)?;
    Ok(Some(expiry))
}
enum Counter {
    Owner,
    Capture,
    Operation,
}
fn next_counter(state: &mut AuthorityState, counter: Counter) -> Result<u64> {
    if state.exhausted {
        return Err(ConsentAuthorityError::Exhausted);
    }
    let value = match counter {
        Counter::Owner => &mut state.next_owner,
        Counter::Capture => &mut state.next_capture,
        Counter::Operation => &mut state.next_operation,
    };
    if let Some(next) = value.checked_add(1) {
        *value = next;
        Ok(next)
    } else {
        state.exhausted = true;
        Err(ConsentAuthorityError::Exhausted)
    }
}
fn reap_captures(state: &mut AuthorityState, now: Instant) {
    state.observations.retain(|_, value| value.deadline > now);
    state.decisions.retain(|_, value| value.deadline > now);
}
fn begin_revocation_locked(
    authority: &Arc<Mutex<AuthorityState>>,
    state: &mut AuthorityState,
    scope_id: &str,
    kind: ConsentKind,
    decision_id: &str,
    requester: RevocationRequester,
) -> Result<ConsentRevocationAttempt> {
    validate_decision_id(decision_id)?;
    if state.exhausted {
        return Err(ConsentAuthorityError::Exhausted);
    }
    if let Some((id, operation)) = state
        .operations
        .iter()
        .find(|(_, operation)| operation.decision_id == decision_id)
    {
        if operation.scope_id != scope_id
            || operation.kind != kind
            || operation.requester != requester
        {
            return Err(ConsentAuthorityError::Conflict);
        }
        return Ok(revocation_handle(authority, id, operation));
    }
    if state
        .operations
        .values()
        .filter(|operation| !terminal(operation.status))
        .count()
        >= LIMIT
    {
        // Capacity cannot leave the current grant usable after a failed revoke.
        state
            .scopes
            .get_mut(scope_id)
            .expect("registered scope")
            .kinds[kind.index()]
        .status = AuthorityStatus::Fenced;
        return Err(ConsentAuthorityError::Capacity);
    }
    let sequence = next_counter(state, Counter::Operation)?;
    let current = &mut state
        .scopes
        .get_mut(scope_id)
        .expect("registered scope")
        .kinds[kind.index()];
    let Some(generation) = current.generation.checked_add(1) else {
        state.exhausted = true;
        return Err(ConsentAuthorityError::Exhausted);
    };
    let operation_id = format!("consent-{sequence}");
    let expected_revision = current.revision;
    current.generation = generation;
    current.granted = false;
    current.expires_at = None;
    current.status = AuthorityStatus::Fenced;
    current.active_operation = Some(operation_id.clone());
    let owners = state
        .owners
        .iter()
        .filter(|(_, owner)| owner.scope_id == scope_id)
        .map(|(id, _)| (*id, false))
        .collect();
    let operation = Operation {
        scope_id: scope_id.into(),
        kind,
        generation,
        decision_id: decision_id.into(),
        expected_revision,
        requester,
        attempt: 1,
        backend_revision: None,
        owners,
        status: ConsentOperationStatus::Pending,
        error: None,
    };
    let handle = revocation_handle(authority, &operation_id, &operation);
    state.operations.insert(operation_id, operation);
    Ok(handle)
}
fn revocation_handle(
    authority: &Arc<Mutex<AuthorityState>>,
    operation_id: &str,
    operation: &Operation,
) -> ConsentRevocationAttempt {
    ConsentRevocationAttempt {
        authority: Arc::downgrade(authority),
        operation_id: operation_id.into(),
        decision_id: operation.decision_id.clone(),
        attempt: operation.attempt,
    }
}
fn operation_attempt<'a>(
    state: &'a mut AuthorityState,
    attempt: &ConsentRevocationAttempt,
) -> Result<&'a mut Operation> {
    let operation = state
        .operations
        .get_mut(attempt.operation_id())
        .ok_or(ConsentAuthorityError::NotFound)?;
    if operation.attempt != attempt.attempt || operation.decision_id != attempt.decision_id {
        return Err(ConsentAuthorityError::StaleFence);
    }
    Ok(operation)
}
fn terminal(status: ConsentOperationStatus) -> bool {
    matches!(
        status,
        ConsentOperationStatus::Complete | ConsentOperationStatus::Superseded
    )
}
fn refresh_operations(state: &mut AuthorityState) {
    // A begin order is not a backend execution order. Even an operation with
    // no owners can still execute a delayed deny after a newer HTTP response.
    // Failed attempts remain unresolved until the same decision's idempotent
    // backend receipt is known, so a newer fence cannot reopen admission early.
    let mut unresolved: BTreeMap<(String, ConsentKind), u64> = BTreeMap::new();
    for operation in state
        .operations
        .values()
        .filter(|operation| operation.backend_revision.is_none())
    {
        unresolved
            .entry((operation.scope_id.clone(), operation.kind))
            .and_modify(|generation| *generation = (*generation).min(operation.generation))
            .or_insert(operation.generation);
    }
    for (id, operation) in &mut state.operations {
        if terminal(operation.status) {
            continue;
        }
        for (owner_id, drained) in &mut operation.owners {
            if let Some(owner) = state.owners.get(owner_id) {
                let index = operation.kind.index();
                *drained = owner.installed[index]
                    .is_some_and(|generation| generation >= operation.generation)
                    && owner.cleaned[index]
                        .is_some_and(|generation| generation >= operation.generation)
                    && owner.permits[index] == 0
                    && (owner.active || owner.retired_drained);
            }
            // An absent, never-acknowledged owner stays false, never drained.
        }
        if operation.status != ConsentOperationStatus::Failed
            && operation.backend_revision.is_some()
            && operation.owners.values().all(|drained| *drained)
        {
            let current = &mut state
                .scopes
                .get_mut(&operation.scope_id)
                .expect("operation scope")
                .kinds[operation.kind.index()];
            operation.status = if current.active_operation.as_deref() == Some(id) {
                if !current.terminal_faults.is_empty() {
                    continue;
                }
                if unresolved
                    .get(&(operation.scope_id.clone(), operation.kind))
                    .is_some_and(|generation| *generation <= operation.generation)
                {
                    continue;
                }
                current.active_operation = None;
                current.status = AuthorityStatus::Current;
                ConsentOperationStatus::Complete
            } else {
                ConsentOperationStatus::Superseded
            };
            state.terminal_order.push(id.clone());
        }
    }
    while state.terminal_order.len() > LIMIT {
        let evicted = state.terminal_order.remove(0);
        state.operations.remove(&evicted);
    }
}
fn prune_retired(state: &mut AuthorityState) {
    let removable: BTreeSet<_> = state
        .owners
        .iter()
        .filter(|(id, owner)| {
            !owner.active
                && owner.retired_drained
                && owner.permits == [0; 2]
                && state
                    .operations
                    .values()
                    .all(|operation| operation.owners.get(id).is_none_or(|drained| *drained))
        })
        .map(|(id, _)| *id)
        .collect();
    state.owners.retain(|id, _| !removable.contains(id));
}
fn operation_receipt(
    state: &AuthorityState,
    operation_id: &str,
) -> Result<ConsentOperationReceipt> {
    let operation = state
        .operations
        .get(operation_id)
        .ok_or(ConsentAuthorityError::NotFound)?;
    let pending = operation
        .owners
        .values()
        .filter(|drained| !**drained)
        .count();
    let backend_pending = state
        .operations
        .values()
        .filter(|candidate| {
            candidate.scope_id == operation.scope_id
                && candidate.kind == operation.kind
                && candidate.generation <= operation.generation
                && candidate.backend_revision.is_none()
        })
        .count();
    Ok(ConsentOperationReceipt {
        operation_id: operation_id.into(),
        scope_id: operation.scope_id.clone(),
        kind: operation.kind,
        generation: operation.generation.into(),
        attempt: operation.attempt.into(),
        status: operation.status,
        phase: if terminal(operation.status) {
            ConsentOperationPhase::Complete
        } else if backend_pending == 0 {
            ConsentOperationPhase::Draining
        } else {
            ConsentOperationPhase::Backend
        },
        backend_committed: operation.backend_revision.is_some(),
        backend_pending: (backend_pending as u64).into(),
        revision: operation.backend_revision.map(Into::into),
        authority_revision: state.scopes[&operation.scope_id].kinds[operation.kind.index()]
            .revision
            .map(Into::into),
        owners: operation
            .owners
            .iter()
            .map(|(id, acknowledged)| ConsentOwnerReceipt {
                owner_revision: (*id).into(),
                acknowledged: *acknowledged,
            })
            .collect(),
        cleanup_pending: (pending as u64).into(),
        error: operation.error.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    const TTL: Duration = Duration::from_secs(30);

    fn application() -> TrustedApplication {
        TrustedApplication {
            host_app_id: "host".into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: "app".into(),
            environment: "production".into(),
            version: "1".into(),
            pack_root: "a".repeat(64),
        }
    }
    fn account() -> HostAccount {
        HostAccount {
            principal_id: Some("alice".into()),
            epoch: 9_007_199_254_740_993,
        }
    }
    fn owner(authority: &NativeConsentAuthority, session: &str) -> ConsentOwner {
        authority
            .register_owner(application(), account(), session.into())
            .unwrap()
    }
    fn baseline(
        authority: &NativeConsentAuthority,
        owner: &ConsentOwner,
        kind: ConsentKind,
        revision: u64,
        granted: bool,
    ) -> ConsentStamp {
        let observation = authority.capture_observation(owner, kind, TTL).unwrap();
        authority
            .initialize(
                &observation,
                ConsentState {
                    revision: revision.into(),
                    granted,
                    expires_in: if granted { 120 } else { 0 },
                },
            )
            .unwrap();
        authority.capture(owner, kind).unwrap()
    }
    fn finish(
        authority: &NativeConsentAuthority,
        owner: &ConsentOwner,
        attempt: &ConsentRevocationAttempt,
        revision: u64,
    ) -> ConsentOperationReceipt {
        let receipt = authority
            .commit_revocation(attempt, attempt.decision_id(), revision.into())
            .unwrap();
        authority
            .acknowledge_owner(owner, receipt.kind, receipt.generation, true)
            .unwrap();
        authority.query_operation(attempt.operation_id()).unwrap()
    }

    #[test]
    fn wire_uses_only_canonical_strings_and_exact_protocol() {
        for invalid in [
            "0",
            "1",
            "-1",
            "1.0",
            "null",
            "true",
            "\"01\"",
            "\"+1\"",
            "\" 1\"",
            "\"18446744073709551616\"",
            "\"١\"",
        ] {
            assert!(
                serde_json::from_str::<StrictU64>(invalid).is_err(),
                "{invalid}"
            );
        }
        let max: StrictU64 = serde_json::from_str("\"18446744073709551615\"").unwrap();
        assert_eq!(max.get(), u64::MAX);
        assert_eq!(
            serde_json::to_string(&max).unwrap(),
            "\"18446744073709551615\""
        );
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let fence = authority
            .capture(&owner, ConsentKind::Profile)
            .unwrap()
            .fence;
        let mut wire = serde_json::to_value(&fence).unwrap();
        assert_eq!(wire["generation"], "0");
        assert!(wire["revision"].is_null());
        assert!(serde_json::from_value::<ConsentFence>(wire.clone()).is_ok());
        wire.as_object_mut().unwrap().remove("revision");
        assert!(serde_json::from_value::<ConsentFence>(wire).is_err());
        let mut wire = serde_json::to_value(fence).unwrap();
        wire["protocolVersion"] = "2.0".into();
        assert!(serde_json::from_value::<ConsentFence>(wire).is_err());
    }

    #[test]
    fn durable_scope_shares_upgrades_and_epoch_but_isolates_all_six_axes() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "one");
        let mut upgraded = application();
        upgraded.version = "2".into();
        upgraded.pack_root = "b".repeat(64);
        let mut refreshed = account();
        refreshed.epoch += 1;
        let second = authority
            .register_owner(upgraded, refreshed, "two".into())
            .unwrap();
        assert_eq!(first.scope_id(), second.scope_id());
        assert!(first.owner_revision() < second.owner_revision());
        baseline(&authority, &first, ConsentKind::Profile, 5, true);
        assert!(authority
            .claim(&authority.capture(&second, ConsentKind::Profile).unwrap())
            .is_ok());
        for axis in 0..6 {
            let mut app = application();
            let mut user = account();
            match axis {
                0 => app.host_app_id = "other".into(),
                1 => app.tenant_id = "other".into(),
                2 => app.publisher_id = "other".into(),
                3 => user.principal_id = Some("bob".into()),
                4 => app.app_id = "other".into(),
                _ => app.environment = "staging".into(),
            }
            let isolated = authority
                .register_owner(app, user, format!("isolated-{axis}"))
                .unwrap();
            assert_ne!(first.scope_id(), isolated.scope_id());
            assert_eq!(
                authority
                    .claim(&authority.capture(&isolated, ConsentKind::Profile).unwrap())
                    .unwrap_err(),
                ConsentAuthorityError::Uninitialized
            );
        }
    }

    #[test]
    fn typed_owner_and_stamp_cannot_cross_authorities_or_survive_retirement() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "one");
        let stamp = baseline(&authority, &first, ConsentKind::Profile, 5, true);
        let other = NativeConsentAuthority::new();
        assert_eq!(
            other.claim(&stamp).unwrap_err(),
            ConsentAuthorityError::WrongAuthority
        );
        assert_eq!(
            other.retire_owner(&first),
            Err(ConsentAuthorityError::WrongAuthority)
        );
        authority.retire_owner(&first).unwrap();
        assert!(!authority.owner_is_active(&first));
        assert_eq!(
            authority.claim(&stamp).unwrap_err(),
            ConsentAuthorityError::RetiredOwner
        );
        assert_eq!(
            authority.capture(&first, ConsentKind::Profile).unwrap_err(),
            ConsentAuthorityError::RetiredOwner
        );
    }

    #[test]
    fn initialization_is_once_and_ordinary_observations_never_grant_or_advance() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let unknown = authority.capture(&owner, ConsentKind::Profile).unwrap();
        assert_eq!(
            authority.check(&unknown),
            Err(ConsentAuthorityError::Uninitialized)
        );
        baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        let duplicate = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        assert_eq!(
            authority.initialize(
                &duplicate,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 120
                }
            ),
            Err(ConsentAuthorityError::Conflict)
        );
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        assert_eq!(
            authority.apply_observation(
                &observation,
                ConsentState {
                    revision: 6.into(),
                    granted: true,
                    expires_in: 120
                }
            ),
            Err(ConsentAuthorityError::ReconciliationRequired)
        );
        let kind = &authority.0.lock().unwrap().scopes[owner.scope_id()].kinds[0];
        assert_eq!(kind.revision, Some(5));
        assert!(!kind.granted);
        assert_eq!(kind.status, AuthorityStatus::ReconciliationRequired);
    }

    #[test]
    fn null_principal_cannot_initialize_a_grant_or_prepare_a_decision() {
        let authority = NativeConsentAuthority::new();
        let owner = authority
            .register_owner(
                application(),
                HostAccount {
                    principal_id: None,
                    epoch: 1,
                },
                "guest".into(),
            )
            .unwrap();
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        assert_eq!(
            authority.initialize(
                &observation,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 120
                }
            ),
            Err(ConsentAuthorityError::NotGranted)
        );
        let stamp = baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        assert_eq!(
            authority
                .prepare_decision(
                    &stamp,
                    "call",
                    "test_decision_decision_0000000000",
                    Some(5.into()),
                    TTL
                )
                .unwrap_err(),
            ConsentAuthorityError::NotGranted
        );
    }

    #[test]
    fn observation_expiry_is_capture_anchored_and_same_revision_cannot_extend() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        authority
            .0
            .lock()
            .unwrap()
            .observations
            .get_mut(&observation.id)
            .unwrap()
            .stamp
            .captured_at -= Duration::from_secs(10);
        assert_eq!(
            authority.initialize(
                &observation,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 5
                }
            ),
            Err(ConsentAuthorityError::Expired)
        );
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let expiry = authority.0.lock().unwrap().scopes[owner.scope_id()].kinds[0].expires_at;
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        authority
            .apply_observation(
                &observation,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 3600,
                },
            )
            .unwrap();
        assert_eq!(
            authority.0.lock().unwrap().scopes[owner.scope_id()].kinds[0].expires_at,
            expiry
        );
        assert_eq!(
            authority.apply_observation(
                &observation,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 3600
                }
            ),
            Err(ConsentAuthorityError::NotFound)
        );
    }

    #[test]
    fn grant_adopts_new_revision_only_for_its_original_call() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let original = baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        let old_other_call = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let decision = authority
            .prepare_decision(
                &original,
                "call-1",
                "test_decision_grant-1_0000000000",
                Some(5.into()),
                TTL,
            )
            .unwrap();
        assert_eq!(
            authority
                .commit_decision(&decision, "wrong", 6.into(), 120)
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        assert_eq!(
            authority
                .commit_decision(&decision, "test_decision_grant-1_0000000000", 7.into(), 120)
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        let adopted = authority
            .commit_decision(&decision, "test_decision_grant-1_0000000000", 6.into(), 120)
            .unwrap();
        assert_eq!(adopted.fence.generation, original.fence.generation);
        assert_eq!(adopted.fence.revision, Some(6.into()));
        assert!(authority.claim(&adopted).is_ok());
        assert_eq!(
            authority.check(&old_other_call),
            Err(ConsentAuthorityError::StaleFence)
        );
        let expiry = authority.0.lock().unwrap().scopes[owner.scope_id()].kinds[0].expires_at;
        authority
            .commit_decision(
                &decision,
                "test_decision_grant-1_0000000000",
                6.into(),
                3600,
            )
            .unwrap();
        assert_eq!(
            authority.0.lock().unwrap().scopes[owner.scope_id()].kinds[0].expires_at,
            expiry
        );
        authority
            .0
            .lock()
            .unwrap()
            .decisions
            .get_mut(&decision.id)
            .unwrap()
            .deadline = Instant::now();
        assert_eq!(
            authority
                .commit_decision(
                    &decision,
                    "test_decision_grant-1_0000000000",
                    6.into(),
                    3600
                )
                .unwrap_err(),
            ConsentAuthorityError::Expired
        );
    }

    #[test]
    fn decision_cannot_outlive_its_ui_window_or_revocation_generation() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let stamp = baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        let attempt = authority
            .prepare_decision(
                &stamp,
                "call",
                "test_decision_grant_0000000000",
                Some(5.into()),
                TTL,
            )
            .unwrap();
        authority
            .0
            .lock()
            .unwrap()
            .decisions
            .get_mut(&attempt.id)
            .unwrap()
            .deadline = Instant::now();
        assert_eq!(
            authority.check_decision(&attempt),
            Err(ConsentAuthorityError::Expired)
        );
        let attempt = authority
            .prepare_decision(
                &stamp,
                "call-2",
                "test_decision_grant-2_0000000000",
                Some(5.into()),
                TTL,
            )
            .unwrap();
        authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        assert_eq!(
            authority
                .commit_decision(&attempt, "test_decision_grant-2_0000000000", 6.into(), 120)
                .unwrap_err(),
            ConsentAuthorityError::StaleFence
        );
    }

    #[test]
    fn revoke_requires_backend_every_owner_actual_cleanup_and_permit_drain() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let profile = baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let phone = baseline(&authority, &owner, ConsentKind::Phone, 8, true);
        let permit = authority.claim(&profile).unwrap();
        let revoke = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        assert_eq!(
            authority.check(&profile),
            Err(ConsentAuthorityError::StaleFence)
        );
        assert!(authority.claim(&phone).is_ok());
        let receipt = authority
            .commit_revocation(&revoke, "test_decision_revoke_0000000000", 6.into())
            .unwrap();
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, receipt.generation, false)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(revoke.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, receipt.generation, true)
            .unwrap();
        let added = authority
            .register_owner(application(), account(), "late-owner".into())
            .unwrap();
        authority
            .acknowledge_owner(&added, ConsentKind::Profile, receipt.generation, true)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(revoke.operation_id())
                .unwrap()
                .cleanup_pending
                .get(),
            1
        );
        drop(permit);
        let complete = authority.query_operation(revoke.operation_id()).unwrap();
        assert_eq!(complete.status, ConsentOperationStatus::Complete);
        assert_eq!(complete.owners.len(), 2);
        assert_eq!(complete.cleanup_pending.get(), 0);
        assert_eq!(
            authority.check(&authority.capture(&added, ConsentKind::Profile).unwrap()),
            Err(ConsentAuthorityError::NotGranted)
        );
        assert!(authority.check(&phone).is_ok());
    }

    #[test]
    fn retired_owner_remains_a_barrier_until_explicit_close_acknowledgement() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let stamp = baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let permit = authority.claim(&stamp).unwrap();
        let operation = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        authority
            .commit_revocation(&operation, "test_decision_revoke_0000000000", 6.into())
            .unwrap();
        authority.retire_owner(&owner).unwrap();
        assert_eq!(
            authority.acknowledge_retired_owner(&owner),
            Err(ConsentAuthorityError::NotDrained)
        );
        drop(permit);
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        authority.acknowledge_retired_owner(&owner).unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
        assert!(authority.0.lock().unwrap().owners.is_empty());
    }

    #[test]
    fn failed_revoke_stays_closed_and_old_http_attempt_cannot_complete_a_retry() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let first = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        authority
            .fail_revocation(&first, "backend unavailable")
            .unwrap();
        let blocked = authority.capture(&owner, ConsentKind::Profile).unwrap();
        assert_eq!(
            authority
                .prepare_decision(
                    &blocked,
                    "call",
                    "test_decision_new-grant_0000000000",
                    Some(5.into()),
                    TTL
                )
                .unwrap_err(),
            ConsentAuthorityError::NotGranted
        );
        let retry = authority.retry_revocation(first.operation_id()).unwrap();
        assert_eq!(retry.attempt().get(), 2);
        assert_eq!(
            authority
                .commit_revocation(&first, "test_decision_revoke_0000000000", 6.into())
                .unwrap_err(),
            ConsentAuthorityError::StaleFence
        );
        assert_eq!(
            authority
                .fail_revocation(&first, "late old failure")
                .unwrap_err(),
            ConsentAuthorityError::StaleFence
        );
        assert_eq!(
            finish(&authority, &owner, &retry, 6).status,
            ConsentOperationStatus::Complete
        );
        let denied = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let grant = authority
            .prepare_decision(
                &denied,
                "new-call",
                "test_decision_new-grant_0000000000",
                Some(6.into()),
                TTL,
            )
            .unwrap();
        assert!(authority
            .commit_decision(&grant, "test_decision_new-grant_0000000000", 7.into(), 120)
            .is_ok());
    }

    #[test]
    fn superseded_backend_receipt_never_replaces_latest_authority() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let old = authority
            .begin_revocation(&owner, ConsentKind::Profile, "test_decision_old_0000000000")
            .unwrap();
        let latest = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_latest_0000000000",
            )
            .unwrap();
        authority
            .commit_revocation(&old, "test_decision_old_0000000000", 6.into())
            .unwrap();
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .revision,
            Some(6.into())
        );
        let complete = finish(&authority, &owner, &latest, 7);
        assert_eq!(complete.status, ConsentOperationStatus::Complete);
        assert_eq!(
            authority
                .query_operation(old.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Superseded
        );
        let denied = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let grant = authority
            .prepare_decision(
                &denied,
                "call",
                "test_decision_grant_0000000000",
                Some(7.into()),
                TTL,
            )
            .unwrap();
        let granted = authority
            .commit_decision(&grant, "test_decision_grant_0000000000", 8.into(), 120)
            .unwrap();
        authority
            .commit_revocation(&old, "test_decision_old_0000000000", 6.into())
            .unwrap();
        assert!(authority.check(&granted).is_ok());
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .revision,
            Some(8.into())
        );
    }

    #[test]
    fn revocation_ids_bind_scope_kind_and_exact_requesting_owner() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "one");
        let second = owner(&authority, "two");
        let revoke = authority
            .begin_revocation(
                &first,
                ConsentKind::Profile,
                "test_decision_same_0000000000",
            )
            .unwrap();
        assert_eq!(
            authority
                .begin_revocation(
                    &first,
                    ConsentKind::Profile,
                    "test_decision_same_0000000000"
                )
                .unwrap()
                .operation_id(),
            revoke.operation_id()
        );
        assert_eq!(
            authority
                .begin_revocation(&first, ConsentKind::Phone, "test_decision_same_0000000000")
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        assert_eq!(
            authority
                .begin_revocation(
                    &second,
                    ConsentKind::Profile,
                    "test_decision_same_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        assert_eq!(
            authority
                .begin_scope_revocation(
                    &application(),
                    &account(),
                    ConsentKind::Profile,
                    "test_decision_same_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
    }

    #[test]
    fn grants_cannot_reopen_a_committed_but_still_draining_revoke() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let operation = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        authority
            .commit_revocation(&operation, "test_decision_revoke_0000000000", 6.into())
            .unwrap();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        assert_eq!(
            authority
                .prepare_decision(
                    &stamp,
                    "call",
                    "test_decision_grant_0000000000",
                    Some(6.into()),
                    TTL
                )
                .unwrap_err(),
            ConsentAuthorityError::NotGranted
        );
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, stamp.fence.generation, true)
            .unwrap();
        assert!(authority
            .prepare_decision(
                &stamp,
                "call",
                "test_decision_grant_0000000000",
                Some(6.into()),
                TTL
            )
            .is_ok());
    }

    #[test]
    fn every_internal_collection_is_bounded_and_exhaustion_is_permanent() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "one");
        for _ in 0..LIMIT {
            authority
                .capture_observation(&first, ConsentKind::Profile, TTL)
                .unwrap();
        }
        assert_eq!(
            authority
                .capture_observation(&first, ConsentKind::Profile, TTL)
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );
        for n in 0..LIMIT {
            authority
                .begin_revocation(
                    &first,
                    ConsentKind::Profile,
                    &format!("test_decision_revoke_{n:08}"),
                )
                .unwrap();
        }
        assert_eq!(
            authority
                .begin_revocation(
                    &first,
                    ConsentKind::Profile,
                    "test_decision_overflow_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );
        assert_eq!(authority.0.lock().unwrap().operations.len(), LIMIT);
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "one");
        authority
            .0
            .lock()
            .unwrap()
            .scopes
            .get_mut(first.scope_id())
            .unwrap()
            .kinds[0]
            .generation = u64::MAX;
        assert_eq!(
            authority
                .begin_revocation(
                    &first,
                    ConsentKind::Profile,
                    "test_decision_exhaust_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Exhausted
        );
        assert_eq!(
            authority.capture(&first, ConsentKind::Phone).unwrap_err(),
            ConsentAuthorityError::Exhausted
        );
        assert!(authority.0.lock().unwrap().exhausted);
    }

    #[test]
    fn terminal_receipts_are_bounded_without_losing_running_barriers() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        baseline(&authority, &owner, ConsentKind::Profile, 0, false);
        let mut first_id = String::new();
        for n in 0..=LIMIT {
            let operation = authority
                .begin_revocation(
                    &owner,
                    ConsentKind::Profile,
                    &format!("test_decision_revoke_{n:08}"),
                )
                .unwrap();
            if n == 0 {
                first_id = operation.operation_id().into();
            }
            assert_eq!(
                finish(&authority, &owner, &operation, n as u64 + 1).status,
                ConsentOperationStatus::Complete
            );
        }
        assert_eq!(
            authority.query_operation(&first_id).unwrap_err(),
            ConsentAuthorityError::NotFound
        );
        assert_eq!(authority.0.lock().unwrap().operations.len(), LIMIT);
    }

    #[test]
    fn owner_reuse_preserves_scope_state_and_owner_revisions_never_reuse() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "first");
        baseline(&authority, &first, ConsentKind::Profile, 5, false);
        let old_revision = first.owner_revision();
        for n in 0..(LIMIT * 2) {
            let current = owner(&authority, &format!("session-{n}"));
            assert!(current.owner_revision() > old_revision);
            assert_eq!(
                authority
                    .capture(&current, ConsentKind::Profile)
                    .unwrap()
                    .fence
                    .revision,
                Some(5.into())
            );
            authority.retire_owner(&current).unwrap();
            authority.acknowledge_retired_owner(&current).unwrap();
        }
        assert_eq!(authority.0.lock().unwrap().owners.len(), 1);
        assert_eq!(authority.0.lock().unwrap().scopes.len(), 1);
    }

    #[test]
    fn decision_owner_scope_and_permit_budgets_reject_without_minting_authority() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "first");
        let denied = baseline(&authority, &first, ConsentKind::Profile, 5, false);
        for n in 0..LIMIT {
            authority
                .prepare_decision(
                    &denied,
                    &format!("call-{n}"),
                    &format!("test_decision_grant_{n:08}"),
                    Some(5.into()),
                    TTL,
                )
                .unwrap();
        }
        assert_eq!(
            authority
                .prepare_decision(
                    &denied,
                    "test_decision_overflow_0000000000",
                    "test_decision_overflow_0000000000",
                    Some(5.into()),
                    TTL
                )
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );
        assert_eq!(
            authority.check(&denied),
            Err(ConsentAuthorityError::NotGranted)
        );
        for n in 1..LIMIT {
            owner(&authority, &format!("owner-{n}"));
        }
        assert_eq!(
            authority
                .register_owner(
                    application(),
                    account(),
                    "test_decision_overflow_0000000000".into()
                )
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );

        let authority = NativeConsentAuthority::new();
        for n in 0..LIMIT {
            let mut app = application();
            app.app_id = format!("app-{n}");
            let current = authority
                .register_owner(app, account(), format!("scope-{n}"))
                .unwrap();
            authority.retire_owner(&current).unwrap();
            authority.acknowledge_retired_owner(&current).unwrap();
        }
        assert_eq!(
            authority
                .register_owner(application(), account(), "scope-overflow".into())
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );

        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "first");
        let granted = baseline(&authority, &first, ConsentKind::Profile, 5, true);
        let permits: Vec<_> = (0..LIMIT)
            .map(|_| authority.claim(&granted).unwrap())
            .collect();
        assert_eq!(
            authority.claim(&granted).unwrap_err(),
            ConsentAuthorityError::Capacity
        );
        drop(permits);
        assert!(authority.claim(&granted).is_ok());
    }

    #[test]
    fn capture_and_owner_counter_exhaustion_never_wraps_and_live_owner_stays_live() {
        for counter in [Counter::Capture, Counter::Owner] {
            let authority = NativeConsentAuthority::new();
            let first = owner(&authority, "first");
            baseline(&authority, &first, ConsentKind::Profile, 5, true);
            match counter {
                Counter::Capture => {
                    authority.0.lock().unwrap().next_capture = u64::MAX;
                    assert_eq!(
                        authority
                            .capture_observation(&first, ConsentKind::Profile, TTL)
                            .unwrap_err(),
                        ConsentAuthorityError::Exhausted
                    );
                }
                Counter::Owner => {
                    authority.0.lock().unwrap().next_owner = u64::MAX;
                    assert_eq!(
                        authority
                            .register_owner(
                                application(),
                                account(),
                                "test_decision_overflow_0000000000".into()
                            )
                            .unwrap_err(),
                        ConsentAuthorityError::Exhausted
                    );
                }
                Counter::Operation => unreachable!(),
            }
            assert!(authority.owner_is_active(&first));
            assert_eq!(
                authority.capture(&first, ConsentKind::Profile).unwrap_err(),
                ConsentAuthorityError::Exhausted
            );
            authority.retire_owner(&first).unwrap();
            authority.acknowledge_retired_owner(&first).unwrap();
        }
    }

    #[test]
    fn native_management_revocations_bind_full_epoch_and_package_request_identity() {
        let authority = NativeConsentAuthority::new();
        let operation = authority
            .begin_scope_revocation(
                &application(),
                &account(),
                ConsentKind::Profile,
                "test_decision_native_0000000000",
            )
            .unwrap();
        assert_eq!(
            authority
                .begin_scope_revocation(
                    &application(),
                    &account(),
                    ConsentKind::Profile,
                    "test_decision_native_0000000000"
                )
                .unwrap()
                .operation_id(),
            operation.operation_id()
        );
        let mut changed_account = account();
        changed_account.epoch += 1;
        assert_eq!(
            authority
                .begin_scope_revocation(
                    &application(),
                    &changed_account,
                    ConsentKind::Profile,
                    "test_decision_native_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        let mut changed_pack = application();
        changed_pack.pack_root = "b".repeat(64);
        assert_eq!(
            authority
                .begin_scope_revocation(
                    &changed_pack,
                    &account(),
                    ConsentKind::Profile,
                    "test_decision_native_0000000000"
                )
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
        let completed = authority
            .commit_revocation(&operation, "test_decision_native_0000000000", 5.into())
            .unwrap();
        assert_eq!(completed.status, ConsentOperationStatus::Complete);
        assert!(completed.owners.is_empty());
    }

    #[test]
    fn latest_native_revoke_waits_for_older_backend_decisions_even_without_owners() {
        let authority = NativeConsentAuthority::new();
        let old = authority
            .begin_scope_revocation(
                &application(),
                &account(),
                ConsentKind::Profile,
                "native_old_delayed_decision_0001",
            )
            .unwrap();
        let latest = authority
            .begin_scope_revocation(
                &application(),
                &account(),
                ConsentKind::Profile,
                "native_latest_decision_00000001",
            )
            .unwrap();
        // The later request executes first in the real backend order.
        let waiting = authority
            .commit_revocation(&latest, latest.decision_id(), 1.into())
            .unwrap();
        assert_eq!(waiting.status, ConsentOperationStatus::Pending);
        assert_eq!(waiting.backend_pending.get(), 1);
        assert_eq!(waiting.cleanup_pending.get(), 0);
        assert_eq!(waiting.authority_revision, Some(1.into()));
        let owner = owner(&authority, "registered-after-latest-http");
        let blocked = authority.capture(&owner, ConsentKind::Profile).unwrap();
        assert_eq!(
            authority
                .prepare_decision(
                    &blocked,
                    "call",
                    "new_grant_must_wait_decision_01",
                    Some(1.into()),
                    TTL
                )
                .unwrap_err(),
            ConsentAuthorityError::NotGranted
        );
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, blocked.fence.generation, true)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(latest.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        // The delayed old HTTP can still execute a distinct deny transaction.
        authority
            .commit_revocation(&old, old.decision_id(), 2.into())
            .unwrap();
        let complete = authority.query_operation(latest.operation_id()).unwrap();
        assert_eq!(complete.status, ConsentOperationStatus::Complete);
        assert_eq!(complete.backend_pending.get(), 0);
        assert_eq!(complete.revision, Some(1.into()));
        assert_eq!(complete.authority_revision, Some(2.into()));
        let denied = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let grant = authority
            .prepare_decision(
                &denied,
                "call",
                "new_grant_after_backend_drain_1",
                Some(2.into()),
                TTL,
            )
            .unwrap();
        let granted = authority
            .commit_decision(&grant, grant.decision_id(), 3.into(), 120)
            .unwrap();
        authority
            .commit_revocation(&old, old.decision_id(), 2.into())
            .unwrap();
        assert!(authority.check(&granted).is_ok());
    }

    #[test]
    fn ambiguous_backend_failure_blocks_newer_completion_until_same_decision_is_resolved() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let old = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "old_ambiguous_backend_decision_1",
            )
            .unwrap();
        let primary = authority
            .fail_revocation(&old, "primary transport error; transaction unknown")
            .unwrap();
        let duplicate = authority
            .fail_revocation(&old, "secondary error must not replace primary")
            .unwrap();
        assert_eq!(duplicate, primary);
        let latest = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "latest_backend_revoke_decision_1",
            )
            .unwrap();
        let waiting = finish(&authority, &owner, &latest, 6);
        assert_eq!(waiting.status, ConsentOperationStatus::Pending);
        assert_eq!(waiting.backend_pending.get(), 1);
        assert_eq!(
            authority.query_operation(old.operation_id()).unwrap().error,
            primary.error
        );
        let retry = authority.retry_revocation(old.operation_id()).unwrap();
        assert_eq!(
            authority
                .fail_revocation(&old, "late old attempt error")
                .unwrap_err(),
            ConsentAuthorityError::StaleFence
        );
        // The original deny may execute after the newer request; resolving the
        // same decision by idempotent retry must accept its actual r7 receipt.
        authority
            .commit_revocation(&retry, retry.decision_id(), 7.into())
            .unwrap();
        let complete = authority.query_operation(latest.operation_id()).unwrap();
        assert_eq!(complete.status, ConsentOperationStatus::Complete);
        assert_eq!(complete.authority_revision, Some(7.into()));
        let denied = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let grant = authority
            .prepare_decision(
                &denied,
                "call",
                "grant_after_known_backend_drain1",
                Some(7.into()),
                TTL,
            )
            .unwrap();
        let granted = authority
            .commit_decision(&grant, grant.decision_id(), 8.into(), 120)
            .unwrap();
        authority
            .commit_revocation(&retry, retry.decision_id(), 7.into())
            .unwrap();
        assert!(authority.claim(&granted).is_ok());
    }

    #[test]
    fn deny_receipts_follow_backend_order_and_never_regress_the_shared_revision() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let old = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "old_backend_execution_decision_1",
            )
            .unwrap();
        let latest = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "latest_backend_execution_id_001",
            )
            .unwrap();
        // Latest executes as r6, a policy update is r7, and old executes r8;
        // network response delivery arrives in the opposite order.
        authority
            .commit_revocation(&old, old.decision_id(), 8.into())
            .unwrap();
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .revision,
            Some(8.into())
        );
        let completed = finish(&authority, &owner, &latest, 6);
        assert_eq!(completed.status, ConsentOperationStatus::Complete);
        assert_eq!(completed.authority_revision, Some(8.into()));
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .revision,
            Some(8.into())
        );
        assert_eq!(
            authority
                .commit_revocation(&old, old.decision_id(), 9.into())
                .unwrap_err(),
            ConsentAuthorityError::Conflict
        );
    }

    #[test]
    fn zero_remaining_observation_expires_shared_grant_before_returning_error() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "first");
        let profile = baseline(&authority, &first, ConsentKind::Profile, 5, true);
        let phone = baseline(&authority, &first, ConsentKind::Phone, 8, true);
        let sibling = owner(&authority, "sibling");
        let sibling_profile = authority.capture(&sibling, ConsentKind::Profile).unwrap();
        let observation = authority
            .capture_observation(&first, ConsentKind::Profile, TTL)
            .unwrap();
        assert_eq!(
            authority.apply_observation(
                &observation,
                ConsentState {
                    revision: 5.into(),
                    granted: true,
                    expires_in: 0
                }
            ),
            Err(ConsentAuthorityError::Expired)
        );
        assert_eq!(
            authority.claim(&profile).unwrap_err(),
            ConsentAuthorityError::Expired
        );
        assert_eq!(
            authority.check(&sibling_profile),
            Err(ConsentAuthorityError::Expired)
        );
        assert!(authority.check(&phone).is_ok());
    }

    #[test]
    fn higher_revision_expired_observation_fences_old_grant_without_granting_new_authority() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        let old = baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let phone = baseline(&authority, &owner, ConsentKind::Phone, 8, true);
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, TTL)
            .unwrap();
        assert_eq!(
            authority.apply_observation(
                &observation,
                ConsentState {
                    revision: 6.into(),
                    granted: true,
                    expires_in: 0
                }
            ),
            Err(ConsentAuthorityError::ReconciliationRequired)
        );
        assert_eq!(
            authority.claim(&old).unwrap_err(),
            ConsentAuthorityError::ReconciliationRequired
        );
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .revision,
            Some(5.into())
        );
        assert!(authority.check(&phone).is_ok());
    }

    #[test]
    fn owner_activity_distinguishes_poison_from_retirement_and_wrong_authority() {
        let authority = NativeConsentAuthority::new();
        let active = owner(&authority, "owner");
        assert_eq!(authority.owner_activity(&active), Ok(true));
        assert_eq!(
            NativeConsentAuthority::new().owner_activity(&active),
            Err(ConsentAuthorityError::WrongAuthority)
        );
        let cloned = authority.clone();
        assert!(std::thread::spawn(move || {
            let _locked = cloned.0.lock().unwrap();
            panic!("simulated poisoned authority");
        })
        .join()
        .is_err());
        assert_eq!(
            authority.owner_activity(&active),
            Err(ConsentAuthorityError::Poisoned)
        );
        let authority = NativeConsentAuthority::new();
        let retired = owner(&authority, "retired");
        authority.retire_owner(&retired).unwrap();
        assert_eq!(authority.owner_activity(&retired), Ok(false));
        authority.acknowledge_retired_owner(&retired).unwrap();
        assert_eq!(authority.owner_activity(&retired), Ok(false));
    }

    #[test]
    fn decision_ids_enforce_the_exact_v2_alphabet_and_length() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        let denied = baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        for invalid in [
            String::new(),
            "short".into(),
            "A".repeat(21),
            "A".repeat(129),
            "a".repeat(21) + "!",
            "授权标识不得冒充后端随机ID_00000".into(),
            "A".repeat(21) + " ",
        ] {
            assert_eq!(
                authority
                    .begin_revocation(&owner, ConsentKind::Profile, &invalid)
                    .unwrap_err(),
                ConsentAuthorityError::InvalidInput
            );
            assert_eq!(
                authority
                    .prepare_decision(&denied, "call", &invalid, Some(5.into()), TTL)
                    .unwrap_err(),
                ConsentAuthorityError::InvalidInput
            );
        }
        assert_eq!(
            authority
                .capture(&owner, ConsentKind::Profile)
                .unwrap()
                .fence
                .generation
                .get(),
            0
        );
        for valid in ["_".repeat(22), "A".repeat(128)] {
            assert!(authority
                .prepare_decision(&denied, "call", &valid, Some(5.into()), TTL)
                .is_ok());
        }
        let empty = NativeConsentAuthority::new();
        assert_eq!(
            empty
                .begin_scope_revocation(&application(), &account(), ConsentKind::Profile, "short")
                .unwrap_err(),
            ConsentAuthorityError::InvalidInput
        );
        assert!(empty.0.lock().unwrap().scopes.is_empty());
    }

    #[test]
    fn terminal_reservation_counts_failed_delivery_without_authorizing_disclosure() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        let denied = baseline(&authority, &owner, ConsentKind::Profile, 5, false);
        let phone = baseline(&authority, &owner, ConsentKind::Phone, 8, true);
        let terminal_permit = authority
            .claim_terminal(&owner, ConsentKind::Profile)
            .unwrap();
        assert_eq!(
            authority.check(&denied),
            Err(ConsentAuthorityError::NotGranted)
        );
        let operation = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "failure_callback_revoke_decision_1",
            )
            .unwrap();
        assert_eq!(
            finish(&authority, &owner, &operation, 6).status,
            ConsentOperationStatus::Pending
        );
        assert!(authority.check(&phone).is_ok());
        drop(terminal_permit);
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
    }

    #[test]
    fn terminal_reservation_validates_owner_but_requires_no_grant_or_revision() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "owner");
        assert!(authority
            .claim_terminal(&owner, ConsentKind::Profile)
            .is_ok());
        assert_eq!(
            NativeConsentAuthority::new()
                .claim_terminal(&owner, ConsentKind::Profile)
                .unwrap_err(),
            ConsentAuthorityError::WrongAuthority
        );
        authority.retire_owner(&owner).unwrap();
        assert_eq!(
            authority
                .claim_terminal(&owner, ConsentKind::Profile)
                .unwrap_err(),
            ConsentAuthorityError::RetiredOwner
        );
        authority.acknowledge_retired_owner(&owner).unwrap();
    }

    #[test]
    fn terminal_capacity_fault_cannot_complete_via_optimistic_ack_and_recovers_on_actual_close() {
        let authority = NativeConsentAuthority::new();
        let first = owner(&authority, "first");
        baseline(&authority, &first, ConsentKind::Profile, 5, true);
        let permits: Vec<_> = (0..LIMIT)
            .map(|_| {
                authority
                    .claim_terminal(&first, ConsentKind::Profile)
                    .unwrap()
            })
            .collect();
        assert_eq!(
            authority
                .claim_terminal(&first, ConsentKind::Profile)
                .unwrap_err(),
            ConsentAuthorityError::Capacity
        );
        let operation = authority
            .begin_revocation(
                &first,
                ConsentKind::Profile,
                "terminal_capacity_revoke_decision1",
            )
            .unwrap();
        let pending = finish(&authority, &first, &operation, 6);
        assert_eq!(pending.status, ConsentOperationStatus::Pending);
        drop(permits);
        authority
            .acknowledge_owner(&first, ConsentKind::Profile, pending.generation, true)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        authority.retire_owner(&first).unwrap();
        authority.acknowledge_retired_owner(&first).unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
        let replacement = owner(&authority, "replacement");
        let denied = authority
            .capture(&replacement, ConsentKind::Profile)
            .unwrap();
        let grant = authority
            .prepare_decision(
                &denied,
                "call",
                "grant_after_fault_actual_close_01",
                Some(6.into()),
                TTL,
            )
            .unwrap();
        let granted = authority
            .commit_decision(&grant, grant.decision_id(), 7.into(), 120)
            .unwrap();
        assert!(authority.claim(&granted).is_ok());
    }

    #[test]
    fn permit_drop_after_panic_and_cross_thread_revoke_do_not_hold_mutex_across_work() {
        let authority = NativeConsentAuthority::new();
        let owner = owner(&authority, "one");
        let stamp = baseline(&authority, &owner, ConsentKind::Profile, 5, true);
        let (ready_send, ready_recv) = std::sync::mpsc::channel();
        let (done_send, done_recv) = std::sync::mpsc::channel();
        let cloned = authority.clone();
        let thread = std::thread::spawn(move || {
            let _permit = cloned.claim(&stamp).unwrap();
            ready_send.send(()).unwrap();
            done_recv.recv().unwrap();
            panic!("simulated engine failure");
        });
        ready_recv.recv().unwrap();
        let operation = authority
            .begin_revocation(
                &owner,
                ConsentKind::Profile,
                "test_decision_revoke_0000000000",
            )
            .unwrap();
        assert_eq!(
            finish(&authority, &owner, &operation, 6).status,
            ConsentOperationStatus::Pending
        );
        done_send.send(()).unwrap();
        assert!(thread.join().is_err());
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
    }
}
