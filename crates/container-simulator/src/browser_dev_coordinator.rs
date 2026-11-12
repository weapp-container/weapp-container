//! Pure coordination of the existing browser Worker owner, never a runtime.
//!
//! This module has no filesystem, clock, process, socket, timer or UI calls.
//! The owner loop must run DevSupervisor::check_portable_publication immediately
//! before minting each PublicationApproval, and must deliver its diagnostics.
//! Browser receipts are correlation-checked browser reports, not verified GPU,
//! pixels, runtime conformance, performance or device evidence.

use crate::dev::{PortablePackReport, PortablePublicationCheck};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};

pub const BROWSER_DEV_VERSION: &str = "1.0";
const MAX_MESSAGE: usize = 2048;
// Match the real Worker product and admission loader, not the blob budget.
const MAX_INDEX_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum CoordinatorError {
    #[error("ERR_PROTOCOL_VERSION: {0}")]
    Invalid(&'static str),
    #[error("ERR_CANCELLED: stale {0}")]
    Stale(&'static str),
    #[error("ERR_PERMISSION_DENIED: publication is not authorized")]
    Unauthorized,
    #[error("ERR_CANCELLED: another owner transition must finish first")]
    Busy,
    #[error("ERR_RENDER: owner close is unresolved; no second AppService may start")]
    CloseUncertain,
    #[error("ERR_CANCELLED: coordinator stopped or sequence exhausted")]
    Stopped,
}
type Result<T> = std::result::Result<T, CoordinatorError>;

/// JSON counters are always canonical decimal strings, including u64::MAX.
/// Numeric JSON, leading zeroes, signs, whitespace and overflow are rejected.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub struct WireU64(u64);
impl WireU64 {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }
    pub const fn get(self) -> u64 {
        self.0
    }
}
impl Serialize for WireU64 {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for WireU64 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        use serde::de::Error;
        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(D::Error::custom)?;
        if value.to_string() != text {
            return Err(D::Error::custom("noncanonical u64 string"));
        }
        Ok(Self(value))
    }
}

fn version(value: &str) -> Result<()> {
    if value == BROWSER_DEV_VERSION {
        Ok(())
    } else {
        Err(CoordinatorError::Invalid("version"))
    }
}
fn identifier(value: &str) -> Result<()> {
    if !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        && value.as_bytes()[0].is_ascii_alphanumeric()
    {
        Ok(())
    } else {
        Err(CoordinatorError::Invalid("identifier"))
    }
}
fn hash(value: &str) -> Result<()> {
    if value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(CoordinatorError::Invalid("sha256"))
    }
}
fn commit(value: &str) -> Result<()> {
    if matches!(value.len(), 40 | 64)
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(CoordinatorError::Invalid("source commit"))
    }
}
fn route(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 1024
        || value.starts_with('/')
        || value
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || value
            .bytes()
            .any(|b| b.is_ascii_control() || b"\\?#%".contains(&b))
    {
        Err(CoordinatorError::Invalid("route"))
    } else {
        Ok(())
    }
}
fn message(value: &str) -> Result<()> {
    if value.is_empty() || value.len() > MAX_MESSAGE {
        Err(CoordinatorError::Invalid("message"))
    } else {
        Ok(())
    }
}
fn digest<T: Serialize>(value: &T) -> Result<String> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| CoordinatorError::Invalid("binding encoding"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
fn valid_pack(report: &PortablePackReport) -> Result<()> {
    if report.schema_version != 1
        || report.revision == 0
        || !report.pack_directory.is_absolute()
        || report.routes.is_empty()
        || report.routes.len() > 65_536
    {
        return Err(CoordinatorError::Invalid("portable report"));
    }
    hash(&report.manifest_sha256)?;
    hash(&report.integrity_root)?;
    commit(&report.compiler_commit)?;
    for item in &report.routes {
        route(item)?;
    }
    let selected = report
        .selected_route
        .as_deref()
        .ok_or(CoordinatorError::Invalid("selected route"))?;
    if !report.routes.iter().any(|item| item == selected) {
        return Err(CoordinatorError::Invalid("selected route"));
    }
    Ok(())
}

/// Pins provided by the existing runtime-bundle producer and loader. These
/// identify retained bytes; they do not mint missing toolchain/sourcemap/GPU
/// evidence. Shape validation never substitutes for byte verification.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimePins {
    /// SHA-256 of exact runtime-bundle.json bytes, not its logical bundleId.
    pub bundle_sha256: String,
    /// SHA-256 of the unchanged producer build-report.json bytes.
    pub producer_report_sha256: String,
    pub source_commit: String,
    /// Existing producer sourceSha256: UTF-8 JSON.stringify(sourceFiles).
    /// The pinned Node helper verifies this recipe; do not reserialize a Rust
    /// Value or hash source-snapshot.json and treat it as the same identity.
    pub source_inventory_sha256: String,
}
impl RuntimePins {
    fn validate(&self) -> Result<()> {
        commit(&self.source_commit)?;
        for value in [
            &self.bundle_sha256,
            &self.producer_report_sha256,
            &self.source_inventory_sha256,
        ] {
            hash(value)?;
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartupIntentPin {
    pub revision: WireU64,
    /// Exact UTF-8 startup intent bytes, before adding the generated pack index.
    /// Its hash cannot depend on the output of this stage job.
    pub sha256: String,
    pub metrics_revision: WireU64,
}
impl StartupIntentPin {
    fn validate(&self) -> Result<()> {
        hash(&self.sha256)?;
        if self.revision.get() == 0 {
            return Err(CoordinatorError::Invalid("startup revision"));
        }
        Ok(())
    }
}

/// The exact startup JSON bytes produced by the existing product config
/// serializer. Its index-dependent hash is known only after staging succeeds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupPin {
    pub revision: WireU64,
    pub sha256: String,
    pub metrics_revision: WireU64,
}

/// Not Clone, Deserialize or Serialize: every stage publication and activation
/// consumes a distinct immediate supervisor check. The trusted owner loop must
/// obtain a NEW check immediately before each mint, with no await in between.
/// This is an in-process sequencing API, not a capability against dishonest Rust.
#[derive(Debug)]
pub struct PublicationApproval {
    report: PortablePackReport,
    expected_control_revision: WireU64,
}
impl PublicationApproval {
    pub fn from_supervisor_check(
        report: &PortablePackReport,
        expected_control_revision: WireU64,
        check: &PortablePublicationCheck,
    ) -> Result<Self> {
        if !check.authorized || !check.events.is_empty() {
            return Err(CoordinatorError::Unauthorized);
        }
        valid_pack(report)?;
        Ok(Self {
            report: report.clone(),
            expected_control_revision,
        })
    }
}

/// Safe wire projection. Complete PortablePackReport, including its native
/// pack_directory, remains private in every stage and owner binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableDescriptor {
    pub version: &'static str,
    pub pack_generation: WireU64,
    pub source_revision: WireU64,
    pub compiler_receipt_sequence: WireU64,
    pub manifest_sha256: String,
    pub integrity_root: String,
    pub compiler_commit: String,
    pub selected_route: String,
}
impl From<&PortablePackReport> for PortableDescriptor {
    fn from(value: &PortablePackReport) -> Self {
        Self {
            version: BROWSER_DEV_VERSION,
            pack_generation: WireU64(value.revision),
            source_revision: WireU64(value.publication_token.source_revision),
            compiler_receipt_sequence: WireU64(value.publication_token.compiler_receipt_sequence),
            manifest_sha256: value.manifest_sha256.clone(),
            integrity_root: value.integrity_root.clone(),
            compiler_commit: value.compiler_commit.clone(),
            selected_route: value.selected_route.clone().unwrap_or_default(),
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TransportBackend {
    BrowserView,
    ExternalFrame,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexPin {
    pub sha256: String,
    pub size: WireU64,
}
impl IndexPin {
    fn validate(&self) -> Result<()> {
        hash(&self.sha256)?;
        if self.size.get() == 0 || self.size.get() > MAX_INDEX_BYTES {
            return Err(CoordinatorError::Invalid("index size"));
        }
        Ok(())
    }
}
/// Returned only after the actual immutable site builder/admission verified bytes.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageArtifact {
    pub version: String,
    pub site_id: WireU64,
    pub input_binding_sha256: String,
    pub manifest_sha256: String,
    pub integrity_root: String,
    pub index: IndexPin,
    /// Hash of the verified builder-owned site.json; the coordinator offer is
    /// a separate projection and is not recursively hashed into this file.
    pub descriptor_sha256: String,
    pub runtime_bundle_sha256: String,
    pub startup_intent_sha256: String,
    pub startup_sha256: String,
    pub transport_backend: TransportBackend,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiteDescriptor {
    pub version: &'static str,
    pub run_id: String,
    pub site_id: WireU64,
    pub token_id: String,
    pub portable: PortableDescriptor,
    pub runtime: RuntimePins,
    pub startup: StartupPin,
    pub index: IndexPin,
    pub descriptor_sha256: String,
    pub transport_backend: TransportBackend,
    pub runtime_base_url: String,
    pub index_url: String,
    pub descriptor_url: String,
}

/// Opaque stage job identity. Clone is for the owned job's correlation only;
/// the coordinator accepts at most one completion. Never send this to clients.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageTicket {
    run_id: String,
    site_id: WireU64,
    input_binding_sha256: String,
    source_epoch: WireU64,
    configuration_epoch: WireU64,
    report: PortablePackReport,
    runtime: RuntimePins,
    startup: StartupIntentPin,
}
impl StageTicket {
    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn site_id(&self) -> WireU64 {
        self.site_id
    }
    pub fn input_binding_sha256(&self) -> &str {
        &self.input_binding_sha256
    }
    pub fn pack_report(&self) -> &PortablePackReport {
        &self.report
    }
    pub fn runtime_pins(&self) -> &RuntimePins {
        &self.runtime
    }
    pub fn startup_intent_pin(&self) -> &StartupIntentPin {
        &self.startup
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct StagedSite {
    ticket: StageTicket,
    descriptor: SiteDescriptor,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewLease {
    pub version: String,
    pub run_id: String,
    pub preview_id: String,
    pub lease_revision: WireU64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationBinding {
    pub version: String,
    pub run_id: String,
    pub site_id: WireU64,
    pub token_id: String,
    pub activation_id: WireU64,
    pub preview: PreviewLease,
    pub startup_revision: WireU64,
    pub runtime_bundle_sha256: String,
    pub index_sha256: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActivationPermit {
    pub binding: ActivationBinding,
    pub control_revision: WireU64,
}
/// A server-registered wrapper identity exists BEFORE constructing/loading the
/// actual WorkerWebSession. Even partial startup must close this exact wrapper.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerKey {
    pub activation_id: WireU64,
    pub owner_serial: WireU64,
    pub client_owner_id: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartTicket {
    pub binding: ActivationBinding,
    pub start_revision: WireU64,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerStartPermit {
    pub binding: ActivationBinding,
    pub owner: OwnerKey,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloseTicket {
    pub version: String,
    pub close_revision: WireU64,
    pub terminal_cleanup_revision: WireU64,
    pub preview: PreviewLease,
    pub owner: OwnerKey,
    pub replaces_with_activation: Option<WireU64>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "instruction", rename_all = "kebab-case")]
pub enum BeginActivation {
    Close(CloseTicket),
    Start(StartTicket),
}

/// The actual RPC allocation can exist before pack admission creates an
/// OwnerTuple. It does not imply application load or runtime readiness.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcIdentity {
    pub worker_epoch: String,
    pub session_id: String,
}
impl RpcIdentity {
    pub(crate) fn validate(&self) -> Result<()> {
        identifier(&self.worker_epoch)?;
        identifier(&self.session_id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OwnerTuple {
    pub worker_epoch: String,
    pub session_id: String,
    /// Existing WorkerWebSession uses the pack INDEX SHA, not manifest SHA.
    pub pack_sha256: String,
    pub transport_backend: TransportBackend,
}
impl OwnerTuple {
    pub(crate) fn validate(&self) -> Result<()> {
        identifier(&self.worker_epoch)?;
        identifier(&self.session_id)?;
        hash(&self.pack_sha256)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceOrigin {
    BrowserReported,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RuntimeReadyReceipt {
    pub version: String,
    pub evidence_origin: EvidenceOrigin,
    pub binding: ActivationBinding,
    pub owner_key: OwnerKey,
    pub owner: OwnerTuple,
    pub engine_provider: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum PresentedPublication {
    BrowserView { page_id: String, revision: WireU64 },
    ExternalFrame { render_revision: WireU64 },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentedReceipt {
    pub version: String,
    pub evidence_origin: EvidenceOrigin,
    pub binding: ActivationBinding,
    pub owner_key: OwnerKey,
    pub owner: OwnerTuple,
    pub presentation_revision: WireU64,
    pub surface_generation: WireU64,
    pub metrics_revision: WireU64,
    pub page_id: String,
    pub route_path: String,
    pub template_revision: WireU64,
    pub publication: PresentedPublication,
    pub input_enabled: bool,
    pub accepted_current: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorDiagnostic {
    pub version: &'static str,
    pub control_revision: WireU64,
    pub terminal_cleanup_revision: WireU64,
    pub code: String,
    pub message: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum OwnerPhase {
    Starting,
    RuntimeReady,
    Presented,
    Closing,
    CloseUncertain,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SitePhase {
    Absent,
    Staging,
    Ready,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimePhase {
    Absent,
    Starting,
    Ready,
    Retiring,
    CloseUncertain,
    Failed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationPhase {
    Absent,
    WaitingForRuntime,
    WaitingForPresentation,
    Ready,
    Retiring,
    CloseUncertain,
    Failed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinatorSnapshot {
    pub version: &'static str,
    pub run_id: String,
    pub control_revision: WireU64,
    /// Cleanup may continue after authority sequence exhaustion. Clients order
    /// snapshots by this pair, never by controlRevision alone.
    pub terminal_cleanup_revision: WireU64,
    pub stopped: bool,
    pub portable: Option<PortableDescriptor>,
    pub portable_current: bool,
    pub site_phase: SitePhase,
    pub offered_site: Option<SiteDescriptor>,
    pub preview: Option<PreviewLease>,
    pub owner_key: Option<OwnerKey>,
    pub owner_phase: Option<OwnerPhase>,
    pub owner_matches_source: bool,
    pub runtime_phase: RuntimePhase,
    pub presentation_phase: PresentationPhase,
    pub activation_id: Option<WireU64>,
    pub activation_phase: Option<&'static str>,
    /// A correlated report of a past load, not an independent current-ready bit.
    pub runtime_ready: Option<RuntimeReadyReceipt>,
    pub presented_ready: Option<PresentedReceipt>,
    pub source_diagnostic: Option<CoordinatorDiagnostic>,
    pub site_diagnostic: Option<CoordinatorDiagnostic>,
    pub owner_diagnostic: Option<CoordinatorDiagnostic>,
    /// True only after a successful exact close; never claims a JS rollback.
    pub previous_owner_closed: bool,
}
#[derive(Clone, Debug)]
struct OwnerRecord {
    key: OwnerKey,
    site: StagedSite,
    binding: ActivationBinding,
    phase: OwnerPhase,
    runtime: Option<RuntimeReadyReceipt>,
    presented: Option<PresentedReceipt>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum ActivationPhase {
    Granted,
    Closing,
    StartAllowed(WireU64),
}
#[derive(Clone, Debug)]
struct Activation {
    permit: ActivationPermit,
    site: StagedSite,
    previous_owner: Option<OwnerKey>,
    phase: ActivationPhase,
}

/// One executing-or-possibly-executing owner slot. Work is bounded to one stage,
/// one offer, one activation and one close. External resources/history have
/// separate owners; this state machine never frees files or closes a Worker.
#[derive(Debug)]
pub struct BrowserDevCoordinator {
    run_id: String,
    control_revision: WireU64,
    terminal_cleanup_revision: WireU64,
    source_epoch: WireU64,
    configuration_epoch: WireU64,
    runtime: RuntimePins,
    startup: StartupIntentPin,
    stopped: bool,
    portable: Option<PortablePackReport>,
    portable_current: bool,
    stage: Option<StageTicket>,
    offer: Option<StagedSite>,
    site_phase: SitePhase,
    preview: Option<PreviewLease>,
    activation: Option<Activation>,
    owner: Option<OwnerRecord>,
    close: Option<CloseTicket>,
    source_diagnostic: Option<CoordinatorDiagnostic>,
    site_diagnostic: Option<CoordinatorDiagnostic>,
    owner_diagnostic: Option<CoordinatorDiagnostic>,
    previous_owner_closed: bool,
}
impl BrowserDevCoordinator {
    pub fn new(run_id: String, runtime: RuntimePins, startup: StartupIntentPin) -> Result<Self> {
        identifier(&run_id)?;
        runtime.validate()?;
        startup.validate()?;
        Ok(Self {
            run_id,
            runtime,
            startup,
            control_revision: WireU64(0),
            terminal_cleanup_revision: WireU64(0),
            source_epoch: WireU64(0),
            configuration_epoch: WireU64(0),
            stopped: false,
            portable: None,
            portable_current: false,
            stage: None,
            offer: None,
            site_phase: SitePhase::Absent,
            preview: None,
            activation: None,
            owner: None,
            close: None,
            source_diagnostic: None,
            site_diagnostic: None,
            owner_diagnostic: None,
            previous_owner_closed: false,
        })
    }
    pub fn control_revision(&self) -> WireU64 {
        self.control_revision
    }
    pub fn terminal_cleanup_revision(&self) -> WireU64 {
        self.terminal_cleanup_revision
    }
    fn expected(&self, expected: WireU64) -> Result<()> {
        if self.stopped {
            return Err(CoordinatorError::Stopped);
        }
        if self.control_revision != expected {
            return Err(CoordinatorError::Stale("control revision"));
        }
        Ok(())
    }
    fn bump(&mut self) -> Result<WireU64> {
        if self.stopped {
            return Err(CoordinatorError::Stopped);
        }
        let Some(next) = self.control_revision.get().checked_add(1) else {
            self.stopped = true;
            self.portable_current = false;
            self.stage = None;
            self.offer = None;
            self.site_phase = SitePhase::Absent;
            // Entering the terminal state is itself observable. No cleanup
            // revision has been used while normal authority was still live.
            self.terminal_cleanup_revision = WireU64(1);
            if self
                .activation
                .as_ref()
                .is_some_and(|a| a.phase != ActivationPhase::Closing)
            {
                self.activation = None;
            }
            return Err(CoordinatorError::Stopped);
        };
        self.control_revision = WireU64(next);
        Ok(self.control_revision)
    }
    fn cleanup_bump(&mut self) -> Result<()> {
        if !self.stopped {
            if let Some(next) = self.control_revision.get().checked_add(1) {
                self.control_revision = WireU64(next);
                return Ok(());
            }
            // This sequence can grant no more authority. Keep a separate,
            // ordered terminal lane for cleanup of the exact existing owner.
            self.stopped = true;
            self.portable_current = false;
            self.invalidate_work();
        }
        let next = self
            .terminal_cleanup_revision
            .get()
            .checked_add(1)
            .ok_or(CoordinatorError::Stopped)?;
        self.terminal_cleanup_revision = WireU64(next);
        Ok(())
    }
    fn approval(&self, approval: &PublicationApproval, report: &PortablePackReport) -> Result<()> {
        self.expected(approval.expected_control_revision)?;
        if approval.report != *report {
            return Err(CoordinatorError::Unauthorized);
        }
        Ok(())
    }
    fn lease(&self, lease: &PreviewLease) -> Result<()> {
        if self.preview.as_ref() == Some(lease) {
            Ok(())
        } else {
            Err(CoordinatorError::Stale("preview lease"))
        }
    }
    fn current_site(&self, site: &StagedSite) -> bool {
        !self.stopped
            && self.portable_current
            && self.portable.as_ref() == Some(&site.ticket.report)
            && self.source_epoch == site.ticket.source_epoch
            && self.configuration_epoch == site.ticket.configuration_epoch
            && self.runtime == site.ticket.runtime
            && self.startup == site.ticket.startup
    }
    fn invalidate_work(&mut self) {
        self.stage = None;
        self.offer = None;
        self.site_phase = SitePhase::Absent;
        // Closing is irreversible external work; retain its exact correlation.
        if self
            .activation
            .as_ref()
            .is_some_and(|a| a.phase != ActivationPhase::Closing)
        {
            self.activation = None;
        }
    }
    fn diagnostic(&self, code: &str, text: &str) -> CoordinatorDiagnostic {
        CoordinatorDiagnostic {
            version: BROWSER_DEV_VERSION,
            control_revision: self.control_revision,
            terminal_cleanup_revision: self.terminal_cleanup_revision,
            code: code.to_owned(),
            message: text.to_owned(),
        }
    }
    /// Source observation invalidates new publication; never closes/pauses owner.
    pub fn source_building(&mut self) -> Result<()> {
        self.bump()?;
        self.source_epoch = self.control_revision;
        self.portable_current = false;
        self.invalidate_work();
        Ok(())
    }
    pub fn source_error(&mut self, code: &str, text: &str) -> Result<()> {
        // Revoke publication even if the caller's diagnostic projection is
        // malformed/oversized; reporting failure cannot revive source authority.
        self.source_building()?;
        identifier(code)?;
        message(text)?;
        self.source_diagnostic = Some(self.diagnostic(code, text));
        Ok(())
    }
    /// The only operation that can clear a source diagnostic. A recovery after
    /// invalidation must have a fresh supervisor token, even for identical bytes.
    pub fn accept_portable(&mut self, approval: PublicationApproval) -> Result<()> {
        self.approval(&approval, &approval.report)?;
        let report = approval.report;
        valid_pack(&report)?;
        if let Some(previous) = &self.portable {
            if report.revision < previous.revision
                || report.publication_token.source_revision
                    < previous.publication_token.source_revision
                || report.publication_token.compiler_receipt_sequence
                    < previous.publication_token.compiler_receipt_sequence
                || (!self.portable_current
                    && report.publication_token == previous.publication_token)
            {
                return Err(CoordinatorError::Stale("portable token"));
            }
            if report.revision == previous.revision {
                let mut same_generation = previous.clone();
                same_generation.publication_token = report.publication_token.clone();
                if same_generation != report {
                    return Err(CoordinatorError::Invalid(
                        "immutable pack generation reused",
                    ));
                }
            }
            if previous != &report && report.publication_token == previous.publication_token {
                return Err(CoordinatorError::Stale("portable authorization reused"));
            }
            if previous == &report && self.portable_current {
                return Ok(());
            }
        }
        self.bump()?;
        self.source_epoch = self.control_revision;
        self.invalidate_work();
        self.portable = Some(report);
        self.portable_current = true;
        self.source_diagnostic = None;
        self.site_diagnostic = None;
        Ok(())
    }
    pub fn update_configuration(
        &mut self,
        expected: WireU64,
        runtime: RuntimePins,
        startup: StartupIntentPin,
    ) -> Result<()> {
        self.expected(expected)?;
        runtime.validate()?;
        startup.validate()?;
        if runtime == self.runtime && startup == self.startup {
            return Ok(());
        }
        if startup != self.startup && startup.revision <= self.startup.revision {
            return Err(CoordinatorError::Stale("startup revision"));
        }
        self.bump()?;
        self.configuration_epoch = self.control_revision;
        self.runtime = runtime;
        self.startup = startup;
        self.invalidate_work();
        Ok(())
    }
    /// No owner/live transaction may be transferred to another preview silently.
    pub fn claim_preview(&mut self, expected: WireU64, preview_id: String) -> Result<PreviewLease> {
        self.expected(expected)?;
        identifier(&preview_id)?;
        if self.owner.is_some() || self.activation.is_some() || self.close.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let revision = self.bump()?;
        let lease = PreviewLease {
            version: BROWSER_DEV_VERSION.to_owned(),
            run_id: self.run_id.clone(),
            preview_id,
            lease_revision: revision,
        };
        self.preview = Some(lease.clone());
        Ok(lease)
    }
    pub fn begin_stage(&mut self, expected: WireU64) -> Result<StageTicket> {
        self.expected(expected)?;
        if !self.portable_current {
            return Err(CoordinatorError::Unauthorized);
        }
        let report = self
            .portable
            .clone()
            .ok_or(CoordinatorError::Unauthorized)?;
        let site_id = self.bump()?;
        let input_binding_sha256 = digest(&(
            BROWSER_DEV_VERSION,
            &self.run_id,
            site_id,
            self.source_epoch,
            self.configuration_epoch,
            &report,
            &self.runtime,
            &self.startup,
        ))?;
        let ticket = StageTicket {
            run_id: self.run_id.clone(),
            site_id,
            input_binding_sha256,
            source_epoch: self.source_epoch,
            configuration_epoch: self.configuration_epoch,
            report,
            runtime: self.runtime.clone(),
            startup: self.startup.clone(),
        };
        if self
            .activation
            .as_ref()
            .is_some_and(|a| a.phase == ActivationPhase::Granted)
        {
            self.activation = None;
        }
        self.stage = Some(ticket.clone());
        self.offer = None;
        self.site_phase = SitePhase::Staging;
        self.site_diagnostic = None;
        Ok(ticket)
    }
    pub fn finish_stage(
        &mut self,
        ticket: StageTicket,
        artifact: StageArtifact,
        approval: PublicationApproval,
    ) -> Result<SiteDescriptor> {
        if self.stage.as_ref() != Some(&ticket) {
            return Err(CoordinatorError::Stale("stage completion"));
        }
        self.approval(&approval, &ticket.report)?;
        if !self.portable_current
            || self.portable.as_ref() != Some(&ticket.report)
            || self.source_epoch != ticket.source_epoch
            || self.configuration_epoch != ticket.configuration_epoch
            || self.runtime != ticket.runtime
            || self.startup != ticket.startup
        {
            return Err(CoordinatorError::Stale("stage source/configuration"));
        }
        version(&artifact.version)?;
        artifact.index.validate()?;
        hash(&artifact.descriptor_sha256)?;
        hash(&artifact.startup_sha256)?;
        if artifact.site_id != ticket.site_id
            || artifact.input_binding_sha256 != ticket.input_binding_sha256
            || artifact.manifest_sha256 != ticket.report.manifest_sha256
            || artifact.integrity_root != ticket.report.integrity_root
            || artifact.runtime_bundle_sha256 != ticket.runtime.bundle_sha256
            || artifact.startup_intent_sha256 != ticket.startup.sha256
        {
            return Err(CoordinatorError::Invalid("stage artifact binding"));
        }
        // Internal serialization may include the path; only this digest leaves
        // Rust. The wire projection never emits that full report or ticket.
        let token_id = digest(&(
            BROWSER_DEV_VERSION,
            &self.run_id,
            ticket.site_id,
            ticket.source_epoch,
            ticket.configuration_epoch,
            &ticket.report,
            &ticket.runtime,
            &ticket.startup,
            &artifact,
        ))?;
        let descriptor = SiteDescriptor {
            version: BROWSER_DEV_VERSION,
            run_id: self.run_id.clone(),
            site_id: ticket.site_id,
            token_id,
            portable: PortableDescriptor::from(&ticket.report),
            runtime: ticket.runtime.clone(),
            startup: StartupPin {
                revision: ticket.startup.revision,
                sha256: artifact.startup_sha256,
                metrics_revision: ticket.startup.metrics_revision,
            },
            index: artifact.index,
            descriptor_sha256: artifact.descriptor_sha256,
            transport_backend: artifact.transport_backend,
            runtime_base_url: format!("/__weapp/runtime/{}/", ticket.runtime.bundle_sha256),
            index_url: format!(
                "/__weapp/pack/{}/{}/pack-index.json",
                self.run_id,
                ticket.site_id.get()
            ),
            descriptor_url: format!(
                "/__weapp/site/{}/{}/site.json",
                self.run_id,
                ticket.site_id.get()
            ),
        };
        self.bump()?;
        self.stage = None;
        self.site_phase = SitePhase::Ready;
        self.offer = Some(StagedSite {
            ticket,
            descriptor: descriptor.clone(),
        });
        self.site_diagnostic = None;
        Ok(descriptor)
    }
    pub fn fail_stage(&mut self, ticket: &StageTicket, code: &str, text: &str) -> Result<()> {
        if self.stage.as_ref() != Some(ticket) {
            return Err(CoordinatorError::Stale("stage failure"));
        }
        identifier(code)?;
        message(text)?;
        self.bump()?;
        self.stage = None;
        self.offer = None;
        self.site_phase = SitePhase::Failed;
        self.site_diagnostic = Some(self.diagnostic(code, text));
        Ok(())
    }
    /// An offer/preflight is never permission to create another AppService.
    pub fn issue_activation(
        &mut self,
        lease: &PreviewLease,
        site_id: WireU64,
        approval: PublicationApproval,
    ) -> Result<ActivationPermit> {
        self.lease(lease)?;
        let site = self
            .offer
            .clone()
            .ok_or(CoordinatorError::Stale("site offer"))?;
        self.approval(&approval, &site.ticket.report)?;
        if site.descriptor.site_id != site_id || !self.current_site(&site) {
            return Err(CoordinatorError::Stale("site offer"));
        }
        if self.close.is_some()
            || self
                .owner
                .as_ref()
                .is_some_and(|owner| owner.phase == OwnerPhase::CloseUncertain)
        {
            return Err(CoordinatorError::CloseUncertain);
        }
        if self.activation.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let activation_id = self.bump()?;
        let binding = ActivationBinding {
            version: BROWSER_DEV_VERSION.to_owned(),
            run_id: self.run_id.clone(),
            site_id,
            token_id: site.descriptor.token_id.clone(),
            activation_id,
            preview: lease.clone(),
            startup_revision: site.ticket.startup.revision,
            runtime_bundle_sha256: site.ticket.runtime.bundle_sha256.clone(),
            index_sha256: site.descriptor.index.sha256.clone(),
        };
        let permit = ActivationPermit {
            binding,
            control_revision: self.control_revision,
        };
        self.activation = Some(Activation {
            permit: permit.clone(),
            site,
            previous_owner: self.owner.as_ref().map(|owner| owner.key.clone()),
            phase: ActivationPhase::Granted,
        });
        Ok(permit)
    }
    /// Cancel an unconsumed permit even if another owner receipt advanced the
    /// control revision. A consumed/closing permit cannot be cancelled as though
    /// its old owner were still runnable.
    pub fn cancel_activation(
        &mut self,
        lease: &PreviewLease,
        permit: &ActivationPermit,
    ) -> Result<()> {
        self.lease(lease)?;
        let activation = self
            .activation
            .as_ref()
            .ok_or(CoordinatorError::Stale("activation cancellation"))?;
        if &activation.permit != permit || activation.phase != ActivationPhase::Granted {
            return Err(CoordinatorError::Stale("activation cancellation"));
        }
        self.bump()?;
        self.activation = None;
        Ok(())
    }
    /// Release an exact unused start instruction, before registering any
    /// possibly executing wrapper. This is neither an owner-close receipt nor
    /// rollback of a previously closed heap. Source/control advancement must
    /// not strand unused authority, but no other/newer ticket may release it.
    pub fn abandon_start(&mut self, ticket: &StartTicket) -> Result<()> {
        self.lease(&ticket.binding.preview)?;
        if self.owner.is_some() || self.close.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let activation = self
            .activation
            .as_ref()
            .ok_or(CoordinatorError::Stale("start abandonment"))?;
        if activation.phase != ActivationPhase::StartAllowed(ticket.start_revision)
            || activation.permit.binding != ticket.binding
        {
            return Err(CoordinatorError::Stale("start abandonment"));
        }
        // Deliberately no expected(current control revision)/current_site gate:
        // this operation only relinquishes exact still-unused authority. A
        // source invalidation may already have removed it, which stays stale.
        self.bump()?;
        self.activation = None;
        Ok(())
    }
    pub fn begin_activation(&mut self, permit: ActivationPermit) -> Result<BeginActivation> {
        self.expected(permit.control_revision)?;
        self.lease(&permit.binding.preview)?;
        let mut activation = self
            .activation
            .clone()
            .ok_or(CoordinatorError::Stale("activation permit"))?;
        if activation.permit != permit
            || activation.phase != ActivationPhase::Granted
            || !self.current_site(&activation.site)
            || activation.previous_owner != self.owner.as_ref().map(|owner| owner.key.clone())
        {
            return Err(CoordinatorError::Stale("activation permit"));
        }
        let revision = self.bump()?;
        if let Some(owner) = self.owner.as_mut() {
            owner.phase = OwnerPhase::Closing;
            let close = CloseTicket {
                version: BROWSER_DEV_VERSION.to_owned(),
                close_revision: revision,
                terminal_cleanup_revision: self.terminal_cleanup_revision,
                preview: permit.binding.preview.clone(),
                owner: owner.key.clone(),
                replaces_with_activation: Some(permit.binding.activation_id),
            };
            activation.phase = ActivationPhase::Closing;
            self.activation = Some(activation);
            self.close = Some(close.clone());
            Ok(BeginActivation::Close(close))
        } else {
            activation.phase = ActivationPhase::StartAllowed(revision);
            self.activation = Some(activation);
            Ok(BeginActivation::Start(StartTicket {
                binding: permit.binding,
                start_revision: revision,
            }))
        }
    }
    /// Failed close leaves an uncertain LIVE slot. Only an exact retry/success
    /// can empty it. A timeout/disconnection is not an implicit success.
    pub fn finish_close(
        &mut self,
        ticket: &CloseTicket,
        success: bool,
    ) -> Result<Option<StartTicket>> {
        if self.close.as_ref() != Some(ticket)
            || self.owner.as_ref().map(|owner| &owner.key) != Some(&ticket.owner)
        {
            return Err(CoordinatorError::Stale("owner close receipt"));
        }
        self.lease(&ticket.preview)?;
        self.cleanup_bump()?;
        self.close = None;
        if !success {
            if let Some(owner) = self.owner.as_mut() {
                owner.phase = OwnerPhase::CloseUncertain;
            }
            self.activation = None;
            self.owner_diagnostic = Some(self.diagnostic(
                "OWNER_CLOSE_FAILED",
                "exact browser owner close failed; replacement is blocked",
            ));
            return Ok(None);
        }
        self.owner = None;
        self.previous_owner_closed = true;
        let Some(mut activation) = self.activation.take() else {
            return Ok(None);
        };
        if activation.phase != ActivationPhase::Closing
            || ticket.replaces_with_activation != Some(activation.permit.binding.activation_id)
            || !self.current_site(&activation.site)
        {
            return Ok(None);
        }
        let revision = self.control_revision;
        activation.phase = ActivationPhase::StartAllowed(revision);
        let next = StartTicket {
            binding: activation.permit.binding.clone(),
            start_revision: revision,
        };
        self.activation = Some(activation);
        Ok(Some(next))
    }
    /// The client may now allocate exactly one wrapper and invoke the existing
    /// WorkerWebSession.load. This records possible execution BEFORE that call.
    pub fn start_owner(
        &mut self,
        ticket: StartTicket,
        client_owner_id: String,
    ) -> Result<OwnerStartPermit> {
        identifier(&client_owner_id)?;
        self.lease(&ticket.binding.preview)?;
        if self.stopped {
            return Err(CoordinatorError::Stopped);
        }
        if self.owner.is_some() || self.close.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let activation = self
            .activation
            .clone()
            .ok_or(CoordinatorError::Stale("start ticket"))?;
        if activation.phase != ActivationPhase::StartAllowed(ticket.start_revision)
            || activation.permit.binding != ticket.binding
            || !self.current_site(&activation.site)
        {
            return Err(CoordinatorError::Stale("start ticket"));
        }
        let owner_serial = self.bump()?;
        let key = OwnerKey {
            activation_id: ticket.binding.activation_id,
            owner_serial,
            client_owner_id,
        };
        self.owner = Some(OwnerRecord {
            key: key.clone(),
            site: activation.site,
            binding: ticket.binding.clone(),
            phase: OwnerPhase::Starting,
            runtime: None,
            presented: None,
        });
        self.activation = None;
        Ok(OwnerStartPermit {
            binding: ticket.binding,
            owner: key,
        })
    }
    pub fn runtime_ready(&mut self, receipt: RuntimeReadyReceipt) -> Result<()> {
        version(&receipt.version)?;
        receipt.owner.validate()?;
        let owner = self
            .owner
            .as_ref()
            .ok_or(CoordinatorError::Stale("runtime receipt"))?;
        if owner.binding != receipt.binding
            || owner.key != receipt.owner_key
            || receipt.owner.pack_sha256 != owner.site.descriptor.index.sha256
            || receipt.owner.transport_backend != owner.site.descriptor.transport_backend
            || receipt.engine_provider != "quickjs-wasm"
            || matches!(
                owner.phase,
                OwnerPhase::Closing | OwnerPhase::CloseUncertain
            )
        {
            return Err(CoordinatorError::Stale("runtime receipt"));
        }
        self.lease(&receipt.binding.preview)?;
        if let Some(previous) = &owner.runtime {
            return if previous == &receipt {
                Ok(())
            } else {
                Err(CoordinatorError::Stale("runtime owner tuple"))
            };
        }
        self.bump()?;
        let owner = self.owner.as_mut().expect("checked owner");
        owner.phase = OwnerPhase::RuntimeReady;
        owner.runtime = Some(receipt);
        // Deliberately do not clear source/site diagnostics or make source current.
        Ok(())
    }
    pub fn presented_ready(&mut self, receipt: PresentedReceipt) -> Result<()> {
        version(&receipt.version)?;
        identifier(&receipt.page_id)?;
        route(&receipt.route_path)?;
        if !receipt.input_enabled
            || !receipt.accepted_current
            || receipt.presentation_revision.get() == 0
        {
            return Err(CoordinatorError::Invalid(
                "accepted input-enabled presentation required",
            ));
        }
        let owner = self
            .owner
            .as_ref()
            .ok_or(CoordinatorError::Stale("presentation receipt"))?;
        let runtime = owner
            .runtime
            .as_ref()
            .ok_or(CoordinatorError::Stale("runtime not ready"))?;
        if owner.binding != receipt.binding
            || owner.key != receipt.owner_key
            || runtime.owner != receipt.owner
            || receipt.metrics_revision != owner.site.ticket.startup.metrics_revision
            || !owner
                .site
                .ticket
                .report
                .routes
                .iter()
                .any(|item| item == &receipt.route_path)
            || matches!(
                owner.phase,
                OwnerPhase::Closing | OwnerPhase::CloseUncertain
            )
        {
            return Err(CoordinatorError::Stale("presentation receipt"));
        }
        self.lease(&receipt.binding.preview)?;
        match (&receipt.publication, receipt.owner.transport_backend) {
            (
                PresentedPublication::BrowserView { page_id, revision },
                TransportBackend::BrowserView,
            ) if page_id == &receipt.page_id && revision.get() > 0 => {}
            (
                PresentedPublication::ExternalFrame { render_revision },
                TransportBackend::ExternalFrame,
            ) if render_revision.get() > 0 => {}
            _ => return Err(CoordinatorError::Invalid("publication/backend mismatch")),
        }
        if let Some(previous) = &owner.presented {
            if previous == &receipt {
                return Ok(());
            }
            if receipt.presentation_revision <= previous.presentation_revision
                || receipt.surface_generation < previous.surface_generation
                || receipt.page_id == previous.page_id
                    && receipt.template_revision < previous.template_revision
            {
                return Err(CoordinatorError::Stale("presentation revision"));
            }
            match (&receipt.publication, &previous.publication) {
                (
                    PresentedPublication::ExternalFrame {
                        render_revision: next,
                    },
                    PresentedPublication::ExternalFrame {
                        render_revision: old,
                    },
                ) if next <= old => {
                    return Err(CoordinatorError::Stale("external frame publication"));
                }
                (
                    PresentedPublication::BrowserView {
                        page_id: next_page,
                        revision: next,
                    },
                    PresentedPublication::BrowserView {
                        page_id: old_page,
                        revision: old,
                    },
                ) if next_page == old_page && next <= old => {
                    return Err(CoordinatorError::Stale("DOM publication"));
                }
                _ => {}
            }
        }
        self.bump()?;
        let owner = self.owner.as_mut().expect("checked owner");
        owner.phase = OwnerPhase::Presented;
        owner.presented = Some(receipt);
        self.owner_diagnostic = None;
        Ok(())
    }
    /// A load failure can still own a Worker/realm/assets. Require exact cleanup;
    /// old JS is already gone if a previous close succeeded.
    pub fn fail_owner(&mut self, key: &OwnerKey, text: &str) -> Result<CloseTicket> {
        message(text)?;
        let owner = self
            .owner
            .as_ref()
            .ok_or(CoordinatorError::Stale("owner failure"))?;
        if &owner.key != key {
            return Err(CoordinatorError::Stale("owner failure"));
        }
        if self.close.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let preview = owner.binding.preview.clone();
        let key = owner.key.clone();
        self.cleanup_bump()?;
        let revision = self.control_revision;
        self.activation = None;
        self.owner_diagnostic = Some(self.diagnostic("BROWSER_OWNER_FAILED", text));
        self.owner.as_mut().expect("checked owner").phase = OwnerPhase::Closing;
        let ticket = CloseTicket {
            version: BROWSER_DEV_VERSION.to_owned(),
            close_revision: revision,
            preview,
            terminal_cleanup_revision: self.terminal_cleanup_revision,
            owner: key,
            replaces_with_activation: None,
        };
        self.close = Some(ticket.clone());
        Ok(ticket)
    }
    pub fn retry_close(
        &mut self,
        lease: &PreviewLease,
        expected: WireU64,
        expected_terminal_cleanup_revision: WireU64,
    ) -> Result<CloseTicket> {
        // Cleanup retry is allowed after stop; it never grants a start permit.
        if self.control_revision != expected
            || self.terminal_cleanup_revision != expected_terminal_cleanup_revision
        {
            return Err(CoordinatorError::Stale("cleanup revision"));
        }
        self.lease(lease)?;
        let owner = self
            .owner
            .as_ref()
            .ok_or(CoordinatorError::Stale("close retry"))?;
        if owner.phase != OwnerPhase::CloseUncertain || self.close.is_some() {
            return Err(CoordinatorError::Busy);
        }
        let key = owner.key.clone();
        self.cleanup_bump()?;
        let revision = self.control_revision;
        self.owner.as_mut().expect("checked owner").phase = OwnerPhase::Closing;
        let ticket = CloseTicket {
            version: BROWSER_DEV_VERSION.to_owned(),
            close_revision: revision,
            terminal_cleanup_revision: self.terminal_cleanup_revision,
            preview: lease.clone(),
            owner: key,
            replaces_with_activation: None,
        };
        self.close = Some(ticket.clone());
        Ok(ticket)
    }
    /// Explicit shutdown asks for cleanup; a source error never calls this.
    pub fn stop(&mut self) -> Result<Option<CloseTicket>> {
        if self.stopped && (self.close.is_some() || self.owner.is_none()) {
            return Ok(self.close.clone());
        }
        self.cleanup_bump()?;
        self.stopped = true;
        self.portable_current = false;
        self.stage = None;
        self.offer = None;
        self.activation = None;
        self.site_phase = SitePhase::Absent;
        if let Some(ticket) = &self.close {
            return Ok(Some(ticket.clone()));
        }
        let Some(owner) = self.owner.as_mut() else {
            return Ok(None);
        };
        owner.phase = OwnerPhase::Closing;
        let ticket = CloseTicket {
            version: BROWSER_DEV_VERSION.to_owned(),
            close_revision: self.control_revision,
            terminal_cleanup_revision: self.terminal_cleanup_revision,
            preview: owner.binding.preview.clone(),
            owner: owner.key.clone(),
            replaces_with_activation: None,
        };
        self.close = Some(ticket.clone());
        Ok(Some(ticket))
    }
    pub fn snapshot(&self) -> CoordinatorSnapshot {
        let (runtime_phase, presentation_phase) = match self.owner.as_ref().map(|owner| owner.phase)
        {
            Some(OwnerPhase::Starting) => {
                (RuntimePhase::Starting, PresentationPhase::WaitingForRuntime)
            }
            Some(OwnerPhase::RuntimeReady) => (
                RuntimePhase::Ready,
                PresentationPhase::WaitingForPresentation,
            ),
            Some(OwnerPhase::Presented) => (RuntimePhase::Ready, PresentationPhase::Ready),
            Some(OwnerPhase::Closing) => (RuntimePhase::Retiring, PresentationPhase::Retiring),
            Some(OwnerPhase::CloseUncertain) => (
                RuntimePhase::CloseUncertain,
                PresentationPhase::CloseUncertain,
            ),
            None if self.owner_diagnostic.is_some() => {
                (RuntimePhase::Failed, PresentationPhase::Failed)
            }
            None => (RuntimePhase::Absent, PresentationPhase::Absent),
        };
        CoordinatorSnapshot {
            version: BROWSER_DEV_VERSION,
            run_id: self.run_id.clone(),
            control_revision: self.control_revision,
            terminal_cleanup_revision: self.terminal_cleanup_revision,
            stopped: self.stopped,
            portable: self.portable.as_ref().map(PortableDescriptor::from),
            portable_current: self.portable_current,
            site_phase: self.site_phase,
            offered_site: self.offer.as_ref().map(|site| site.descriptor.clone()),
            preview: self.preview.clone(),
            owner_key: self.owner.as_ref().map(|owner| owner.key.clone()),
            owner_phase: self.owner.as_ref().map(|owner| owner.phase),
            owner_matches_source: self
                .owner
                .as_ref()
                .is_some_and(|owner| self.current_site(&owner.site)),
            runtime_phase,
            presentation_phase,
            activation_id: self
                .activation
                .as_ref()
                .map(|activation| activation.permit.binding.activation_id),
            activation_phase: self
                .activation
                .as_ref()
                .map(|activation| match &activation.phase {
                    ActivationPhase::Granted => "granted",
                    ActivationPhase::Closing => "closing",
                    ActivationPhase::StartAllowed(_) => "start-allowed",
                }),
            runtime_ready: self.owner.as_ref().and_then(|owner| owner.runtime.clone()),
            presented_ready: self
                .owner
                .as_ref()
                .and_then(|owner| owner.presented.clone()),
            source_diagnostic: self.source_diagnostic.clone(),
            site_diagnostic: self.site_diagnostic.clone(),
            owner_diagnostic: self.owner_diagnostic.clone(),
            previous_owner_closed: self.previous_owner_closed,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::PortablePublicationToken;
    use std::path::PathBuf;

    fn sha(letter: char) -> String {
        letter.to_string().repeat(64)
    }
    fn runtime() -> RuntimePins {
        RuntimePins {
            bundle_sha256: sha('a'),
            producer_report_sha256: sha('b'),
            source_commit: "c".repeat(40),
            source_inventory_sha256: sha('d'),
        }
    }
    #[test]
    fn runtime_pins_only_identify_existing_producer_receipts() {
        let pins = runtime();
        pins.validate().unwrap();
        let wire = serde_json::to_value(&pins).unwrap();
        assert_eq!(wire.as_object().unwrap().len(), 4);
        assert_eq!(wire["sourceInventorySha256"], sha('d'));
        for key in [
            "sourceSnapshotSha256",
            "sourceMapSha256",
            "toolchainSha256",
            "rendererAssetsSha256",
        ] {
            let mut invented = wire.clone();
            invented[key] = serde_json::Value::String(sha('e'));
            assert!(serde_json::from_value::<RuntimePins>(invented).is_err());
        }
        let mut missing = wire;
        missing
            .as_object_mut()
            .unwrap()
            .remove("sourceInventorySha256");
        assert!(serde_json::from_value::<RuntimePins>(missing).is_err());
    }
    fn startup(revision: u64) -> StartupIntentPin {
        StartupIntentPin {
            revision: WireU64(revision),
            sha256: sha('1'),
            metrics_revision: WireU64(7),
        }
    }
    fn private_path(label: &str) -> PathBuf {
        let prefix = if cfg!(windows) {
            "C:/never-open-this-private-path"
        } else {
            "/never-open-this-private-path"
        };
        PathBuf::from(format!("{prefix}/{label}"))
    }
    fn report(revision: u64, source: u64) -> PortablePackReport {
        PortablePackReport {
            schema_version: 1,
            revision,
            pack_directory: private_path(&format!("generation-{revision}")),
            manifest_sha256: sha('2'),
            integrity_root: sha('3'),
            compiler_commit: "4".repeat(40),
            routes: vec!["pages/home/index".to_owned(), "pages/next/index".to_owned()],
            requested_route: None,
            selected_route: Some("pages/home/index".to_owned()),
            publication_token: PortablePublicationToken {
                source_revision: source,
                compiler_receipt_sequence: source,
            },
        }
    }
    // Synthetic verdicts exercise ONLY this pure state machine. They are not
    // supervisor, browser, runtime, GPU, source freshness or conformance evidence.
    fn approval(c: &BrowserDevCoordinator, report: &PortablePackReport) -> PublicationApproval {
        PublicationApproval::from_supervisor_check(
            report,
            c.control_revision(),
            &PortablePublicationCheck {
                authorized: true,
                events: Vec::new(),
            },
        )
        .unwrap()
    }
    fn coordinator() -> BrowserDevCoordinator {
        BrowserDevCoordinator::new("run-test".to_owned(), runtime(), startup(1)).unwrap()
    }
    fn accept(c: &mut BrowserDevCoordinator, report: &PortablePackReport) {
        let checked = approval(c, report);
        c.accept_portable(checked).unwrap();
    }
    fn claim(c: &mut BrowserDevCoordinator) -> PreviewLease {
        c.claim_preview(c.control_revision(), "preview-test".to_owned())
            .unwrap()
    }
    fn artifact(ticket: &StageTicket) -> StageArtifact {
        StageArtifact {
            version: BROWSER_DEV_VERSION.to_owned(),
            site_id: ticket.site_id,
            input_binding_sha256: ticket.input_binding_sha256.clone(),
            manifest_sha256: ticket.report.manifest_sha256.clone(),
            integrity_root: ticket.report.integrity_root.clone(),
            index: IndexPin {
                sha256: sha('5'),
                size: WireU64(1234),
            },
            descriptor_sha256: sha('6'),
            runtime_bundle_sha256: ticket.runtime.bundle_sha256.clone(),
            startup_intent_sha256: ticket.startup.sha256.clone(),
            startup_sha256: sha('7'),
            transport_backend: TransportBackend::ExternalFrame,
        }
    }
    fn stage(c: &mut BrowserDevCoordinator, report: &PortablePackReport) -> SiteDescriptor {
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let output = artifact(&ticket);
        let checked = approval(c, report);
        c.finish_stage(ticket, output, checked).unwrap()
    }
    fn activate(
        c: &mut BrowserDevCoordinator,
        lease: &PreviewLease,
        site: &SiteDescriptor,
        report: &PortablePackReport,
    ) -> BeginActivation {
        let checked = approval(c, report);
        let permit = c.issue_activation(lease, site.site_id, checked).unwrap();
        c.begin_activation(permit).unwrap()
    }
    fn start(
        c: &mut BrowserDevCoordinator,
        lease: &PreviewLease,
        site: &SiteDescriptor,
        report: &PortablePackReport,
        name: &str,
    ) -> OwnerStartPermit {
        let BeginActivation::Start(ticket) = activate(c, lease, site, report) else {
            panic!("no previous owner");
        };
        c.start_owner(ticket, name.to_owned()).unwrap()
    }
    fn runtime_receipt(start: &OwnerStartPermit) -> RuntimeReadyReceipt {
        RuntimeReadyReceipt {
            version: BROWSER_DEV_VERSION.to_owned(),
            evidence_origin: EvidenceOrigin::BrowserReported,
            binding: start.binding.clone(),
            owner_key: start.owner.clone(),
            owner: OwnerTuple {
                worker_epoch: format!("epoch-{}", start.owner.owner_serial.get()),
                session_id: format!("session-{}", start.owner.owner_serial.get()),
                pack_sha256: start.binding.index_sha256.clone(),
                transport_backend: TransportBackend::ExternalFrame,
            },
            engine_provider: "quickjs-wasm".to_owned(),
        }
    }
    fn presented_receipt(runtime: &RuntimeReadyReceipt, revision: u64) -> PresentedReceipt {
        PresentedReceipt {
            version: BROWSER_DEV_VERSION.to_owned(),
            evidence_origin: EvidenceOrigin::BrowserReported,
            binding: runtime.binding.clone(),
            owner_key: runtime.owner_key.clone(),
            owner: runtime.owner.clone(),
            presentation_revision: WireU64(revision),
            surface_generation: WireU64(1),
            metrics_revision: WireU64(7),
            page_id: "page-1".to_owned(),
            route_path: "pages/home/index".to_owned(),
            template_revision: WireU64(1),
            publication: PresentedPublication::ExternalFrame {
                render_revision: WireU64(revision),
            },
            input_enabled: true,
            accepted_current: true,
        }
    }
    fn live() -> (
        BrowserDevCoordinator,
        PreviewLease,
        PortablePackReport,
        OwnerStartPermit,
        RuntimeReadyReceipt,
    ) {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let owner = start(&mut c, &lease, &site, &report, "first-owner");
        let runtime = runtime_receipt(&owner);
        c.runtime_ready(runtime.clone()).unwrap();
        let presented = presented_receipt(&runtime, 1);
        c.presented_ready(presented).unwrap();
        (c, lease, report, owner, runtime)
    }
    fn unused_start() -> (
        BrowserDevCoordinator,
        PreviewLease,
        PortablePackReport,
        SiteDescriptor,
        StartTicket,
    ) {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let BeginActivation::Start(ticket) = activate(&mut c, &lease, &site, &report) else {
            panic!("no previous owner");
        };
        (c, lease, report, site, ticket)
    }
    fn no_numbers(value: &serde_json::Value) {
        match value {
            serde_json::Value::Number(_) => panic!("wire descriptors must use exact strings"),
            serde_json::Value::Array(items) => {
                for value in items {
                    no_numbers(value);
                }
            }
            serde_json::Value::Object(items) => {
                for value in items.values() {
                    no_numbers(value);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn decimal_strings_reject_lossy_or_noncanonical_wire_values() {
        let high = WireU64(u64::MAX);
        assert_eq!(
            serde_json::to_string(&high).unwrap(),
            "\"18446744073709551615\""
        );
        assert_eq!(
            serde_json::from_str::<WireU64>("\"18446744073709551615\"").unwrap(),
            high
        );
        for invalid in [
            "1",
            "\"01\"",
            "\"+1\"",
            "\" 1\"",
            "\"18446744073709551616\"",
        ] {
            assert!(
                serde_json::from_str::<WireU64>(invalid).is_err(),
                "{invalid}"
            );
        }
    }
    #[test]
    fn snapshot_has_exact_string_counters_and_never_serializes_native_paths() {
        let (c, _, _, _, _) = live();
        let wire = serde_json::to_value(c.snapshot()).unwrap();
        no_numbers(&wire);
        let text = serde_json::to_string(&wire).unwrap();
        assert!(!text.contains("never-open-this-private-path"));
        assert!(!text.contains("packDirectory"));
        assert!(text.contains("browser-reported"));
        assert!(!text.contains("gpuReady"));
    }
    #[test]
    fn invalid_or_stale_supervisor_verdict_never_mints_usable_authority() {
        let mut c = coordinator();
        let report = report(1, 1);
        assert!(PublicationApproval::from_supervisor_check(
            &report,
            c.control_revision(),
            &PortablePublicationCheck {
                authorized: false,
                events: vec![]
            }
        )
        .is_err());
        let old = approval(&c, &report);
        c.source_error("BUILD_FAILED", "newer source error")
            .unwrap();
        assert!(c.accept_portable(old).is_err());
        assert!(c.snapshot().source_diagnostic.is_some());
    }
    #[test]
    fn same_manifest_hash_does_not_hide_a_different_complete_pack_report() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let output = artifact(&ticket);
        let mut changed = report.clone();
        changed.pack_directory = private_path("different-owner-same-bytes");
        let checked = approval(&c, &changed);
        assert_eq!(
            c.finish_stage(ticket, output, checked).unwrap_err(),
            CoordinatorError::Unauthorized
        );
        assert!(c.snapshot().offered_site.is_none());
    }
    #[test]
    fn only_latest_async_staging_job_may_publish_and_site_ready_is_not_runtime_ready() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let first = c.begin_stage(c.control_revision()).unwrap();
        let late = artifact(&first);
        let second = c.begin_stage(c.control_revision()).unwrap();
        let current = artifact(&second);
        let checked = approval(&c, &report);
        assert!(c.finish_stage(first, late, checked).is_err());
        let checked = approval(&c, &report);
        let site = c.finish_stage(second, current, checked).unwrap();
        let state = c.snapshot();
        assert_eq!(state.site_phase, SitePhase::Ready);
        assert_eq!(state.offered_site, Some(site));
        assert!(state.owner_key.is_none());
        assert!(state.runtime_ready.is_none());
        assert!(state.presented_ready.is_none());
    }
    #[test]
    fn stage_builder_receipt_must_bind_job_source_runtime_and_startup() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let mut wrong = artifact(&ticket);
        wrong.input_binding_sha256 = sha('9');
        let checked = approval(&c, &report);
        assert!(c.finish_stage(ticket.clone(), wrong, checked).is_err());
        let mut wrong = artifact(&ticket);
        wrong.manifest_sha256 = sha('9');
        let checked = approval(&c, &report);
        assert!(c.finish_stage(ticket.clone(), wrong, checked).is_err());
        let mut wrong = artifact(&ticket);
        wrong.runtime_bundle_sha256 = sha('9');
        let checked = approval(&c, &report);
        assert!(c.finish_stage(ticket, wrong, checked).is_err());
        assert!(c.snapshot().offered_site.is_none());
    }
    #[test]
    fn source_error_retires_only_new_work_and_never_closes_the_live_owner() {
        let (mut c, _, report, owner, runtime) = live();
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let output = artifact(&ticket);
        let checked = approval(&c, &report);
        c.source_error("BUILD_FAILED", "compiler error").unwrap();
        assert!(c.finish_stage(ticket, output, checked).is_err());
        let state = c.snapshot();
        assert_eq!(state.owner_key, Some(owner.owner));
        assert_eq!(state.owner_phase, Some(OwnerPhase::Presented));
        assert_eq!(state.runtime_ready, Some(runtime));
        assert!(state.source_diagnostic.is_some());
        assert!(!state.owner_matches_source);
        assert!(c.close.is_none());
    }
    #[test]
    fn stage_failure_preserves_live_heap_and_source_diagnostic_lifetime() {
        let (mut c, _, _, owner, _) = live();
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        c.fail_stage(&ticket, "SITE_BUILD_FAILED", "bad immutable index")
            .unwrap();
        let state = c.snapshot();
        assert_eq!(state.owner_key, Some(owner.owner));
        assert!(state.runtime_ready.is_some());
        assert!(state.presented_ready.is_some());
        assert!(state.site_diagnostic.is_some());
        assert!(state.source_diagnostic.is_none());
        assert!(c.close.is_none());
    }
    #[test]
    fn activation_permit_and_start_ticket_are_single_use_and_lease_bound() {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let mut wrong = lease.clone();
        wrong.preview_id = "other-preview".to_owned();
        let checked = approval(&c, &report);
        assert!(c.issue_activation(&wrong, site.site_id, checked).is_err());
        let checked = approval(&c, &report);
        let permit = c.issue_activation(&lease, site.site_id, checked).unwrap();
        let BeginActivation::Start(ticket) = c.begin_activation(permit.clone()).unwrap() else {
            panic!("first start");
        };
        assert!(c.begin_activation(permit).is_err());
        let owner = c
            .start_owner(ticket.clone(), "one-owner".to_owned())
            .unwrap();
        assert!(c.start_owner(ticket, "second-owner".to_owned()).is_err());
        assert_eq!(c.snapshot().owner_key, Some(owner.owner));
    }
    #[test]
    fn failed_close_never_allows_second_appservice_and_exact_retry_cannot_reuse_old_permit() {
        let (mut c, lease, old, old_owner, _) = live();
        c.source_building().unwrap();
        let next = report(2, 2);
        accept(&mut c, &next);
        let site = stage(&mut c, &next);
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &next) else {
            panic!("must close old owner");
        };
        assert_eq!(close.owner, old_owner.owner);
        assert!(c.finish_close(&close, false).unwrap().is_none());
        assert_eq!(c.snapshot().owner_phase, Some(OwnerPhase::CloseUncertain));
        let checked = approval(&c, &next);
        assert_eq!(
            c.issue_activation(&lease, site.site_id, checked)
                .unwrap_err(),
            CoordinatorError::CloseUncertain
        );
        let retry = c
            .retry_close(&lease, c.control_revision(), c.terminal_cleanup_revision())
            .unwrap();
        assert_ne!(retry.close_revision, close.close_revision);
        assert!(c.finish_close(&close, true).is_err());
        assert!(c.finish_close(&retry, true).unwrap().is_none());
        assert!(c.snapshot().owner_key.is_none());
        assert!(c.snapshot().previous_owner_closed);
        let BeginActivation::Start(start) = activate(&mut c, &lease, &site, &next) else {
            panic!("fresh permit after cleanup");
        };
        let new_owner = c.start_owner(start, "replacement".to_owned()).unwrap();
        assert_ne!(new_owner.owner, old_owner.owner);
        assert_ne!(old.revision, next.revision);
    }
    #[test]
    fn post_close_startup_failure_does_not_claim_retained_old_js() {
        let (mut c, lease, _, old_owner, _) = live();
        let next = report(2, 2);
        accept(&mut c, &next);
        let site = stage(&mut c, &next);
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &next) else {
            panic!("close");
        };
        let start = c.finish_close(&close, true).unwrap().unwrap();
        assert!(c.snapshot().owner_key.is_none());
        assert!(c.snapshot().runtime_ready.is_none());
        let new_owner = c
            .start_owner(start, "failing-new-owner".to_owned())
            .unwrap();
        assert_ne!(new_owner.owner, old_owner.owner);
        let cleanup = c
            .fail_owner(&new_owner.owner, "load rejected after old close")
            .unwrap();
        assert!(c.snapshot().runtime_ready.is_none());
        assert!(c.snapshot().previous_owner_closed);
        assert!(c.snapshot().owner_diagnostic.is_some());
        let checked = approval(&c, &next);
        assert!(c.issue_activation(&lease, site.site_id, checked).is_err());
        assert!(c.finish_close(&cleanup, true).unwrap().is_none());
        assert!(c.snapshot().owner_key.is_none());
        assert!(c.snapshot().owner_diagnostic.is_some());
    }
    #[test]
    fn source_advancing_during_old_close_prevents_stale_new_start_but_records_actual_close() {
        let (mut c, lease, _, _, _) = live();
        let next = report(2, 2);
        accept(&mut c, &next);
        let site = stage(&mut c, &next);
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &next) else {
            panic!("close");
        };
        c.source_error("BUILD_FAILED", "newer than closing activation")
            .unwrap();
        assert!(c.finish_close(&close, true).unwrap().is_none());
        let state = c.snapshot();
        assert!(state.owner_key.is_none());
        assert!(state.previous_owner_closed);
        assert!(state.source_diagnostic.is_some());
        assert!(state.runtime_ready.is_none());
    }
    #[test]
    fn matching_runtime_and_presented_reports_do_not_clear_a_newer_source_error() {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let owner = start(&mut c, &lease, &site, &report, "loading-owner");
        c.source_error("BUILD_FAILED", "source advanced during actual startup")
            .unwrap();
        let diagnostic = c.snapshot().source_diagnostic.unwrap();
        let runtime = runtime_receipt(&owner);
        c.runtime_ready(runtime.clone()).unwrap();
        c.presented_ready(presented_receipt(&runtime, 1)).unwrap();
        let state = c.snapshot();
        assert_eq!(state.source_diagnostic, Some(diagnostic));
        assert!(!state.portable_current);
        assert!(!state.owner_matches_source);
        assert!(state.runtime_ready.is_some());
        assert!(state.presented_ready.is_some());
    }
    #[test]
    fn wrong_startup_owner_pack_provider_or_backend_cannot_report_runtime_ready() {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let owner = start(&mut c, &lease, &site, &report, "loading-owner");
        let good = runtime_receipt(&owner);
        let mut bad = good.clone();
        bad.binding.startup_revision = WireU64(999);
        assert!(c.runtime_ready(bad).is_err());
        let mut bad = good.clone();
        bad.owner.pack_sha256 = report.manifest_sha256;
        assert!(c.runtime_ready(bad).is_err());
        let mut bad = good.clone();
        bad.engine_provider = "v8".to_owned();
        assert!(c.runtime_ready(bad).is_err());
        let mut bad = good.clone();
        bad.owner.transport_backend = TransportBackend::BrowserView;
        assert!(c.runtime_ready(bad).is_err());
        assert!(c.snapshot().runtime_ready.is_none());
        c.runtime_ready(good).unwrap();
    }
    #[test]
    fn presentation_requires_runtime_ack_input_and_monotonic_exact_owner_facts() {
        let (mut c, _, _, _, runtime) = live();
        let mut bad = presented_receipt(&runtime, 2);
        bad.input_enabled = false;
        assert!(c.presented_ready(bad).is_err());
        let mut bad = presented_receipt(&runtime, 2);
        bad.metrics_revision = WireU64(6);
        assert!(c.presented_ready(bad).is_err());
        let mut bad = presented_receipt(&runtime, 2);
        bad.owner.session_id = "late-other-session".to_owned();
        assert!(c.presented_ready(bad).is_err());
        let mut bad = presented_receipt(&runtime, 2);
        bad.route_path = "pages/not-in-pack/index".to_owned();
        assert!(c.presented_ready(bad).is_err());
        c.presented_ready(presented_receipt(&runtime, 3)).unwrap();
        assert!(c.presented_ready(presented_receipt(&runtime, 2)).is_err());
        let mut bad = presented_receipt(&runtime, 4);
        bad.surface_generation = WireU64(0);
        assert!(c.presented_ready(bad).is_err());
    }
    #[test]
    fn old_owner_callbacks_cannot_promote_a_replacement() {
        let (mut c, lease, _, _, old_runtime) = live();
        let next = report(2, 2);
        accept(&mut c, &next);
        let site = stage(&mut c, &next);
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &next) else {
            panic!("close");
        };
        let start = c.finish_close(&close, true).unwrap().unwrap();
        c.start_owner(start, "next-owner".to_owned()).unwrap();
        assert!(c.runtime_ready(old_runtime.clone()).is_err());
        assert!(c
            .presented_ready(presented_receipt(&old_runtime, 9))
            .is_err());
        assert!(c.snapshot().runtime_ready.is_none());
        assert!(c.snapshot().presented_ready.is_none());
    }
    #[test]
    fn same_byte_source_recovery_requires_new_token_and_does_not_relabel_old_owner() {
        let (mut c, _, old, owner, _) = live();
        c.source_error("BUILD_FAILED", "temporary error").unwrap();
        let checked = approval(&c, &old);
        assert!(c.accept_portable(checked).is_err());
        let mut recovered = old.clone();
        recovered.publication_token.source_revision += 1;
        recovered.publication_token.compiler_receipt_sequence += 1;
        accept(&mut c, &recovered);
        let state = c.snapshot();
        assert!(state.source_diagnostic.is_none());
        assert!(state.portable_current);
        assert_eq!(state.owner_key, Some(owner.owner));
        assert!(!state.owner_matches_source);
        assert!(state.runtime_ready.is_some());
        assert!(state.offered_site.is_none());
        assert_eq!(old.manifest_sha256, recovered.manifest_sha256);
    }
    #[test]
    fn startup_revision_change_invalidates_stage_and_permit_but_never_closes_live_owner() {
        let (mut c, _, old, owner, _) = live();
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let output = artifact(&ticket);
        let checked = approval(&c, &old);
        let mut next = startup(2);
        next.sha256 = sha('8');
        c.update_configuration(c.control_revision(), runtime(), next)
            .unwrap();
        assert!(c.finish_stage(ticket, output, checked).is_err());
        assert_eq!(c.snapshot().owner_key, Some(owner.owner));
        assert!(!c.snapshot().owner_matches_source);
        assert!(c.close.is_none());
    }
    #[test]
    fn unrelated_owner_callback_can_expire_permit_without_deadlocking_cancellation() {
        let (mut c, lease, report, _, runtime) = live();
        let site = stage(&mut c, &report);
        let checked = approval(&c, &report);
        let permit = c.issue_activation(&lease, site.site_id, checked).unwrap();
        c.presented_ready(presented_receipt(&runtime, 2)).unwrap();
        assert!(c.begin_activation(permit.clone()).is_err());
        c.cancel_activation(&lease, &permit).unwrap();
        assert!(c.activation.is_none());
        assert!(c.close.is_none());
        let checked = approval(&c, &report);
        assert!(c.issue_activation(&lease, site.site_id, checked).is_ok());
    }
    #[test]
    fn preview_transfer_requires_no_live_or_uncertain_owner() {
        let (mut c, _, _, owner, _) = live();
        assert_eq!(
            c.claim_preview(c.control_revision(), "second-preview".to_owned())
                .unwrap_err(),
            CoordinatorError::Busy
        );
        assert_eq!(c.snapshot().owner_key, Some(owner.owner));
    }
    #[test]
    fn sequence_exhaustion_fails_closed_without_removing_actual_live_owner() {
        let (mut c, _, _, owner, _) = live();
        c.control_revision = WireU64(u64::MAX);
        assert_eq!(
            c.begin_stage(WireU64(u64::MAX)).unwrap_err(),
            CoordinatorError::Stopped
        );
        let state = c.snapshot();
        assert!(state.stopped);
        assert!(!state.portable_current);
        assert!(state.offered_site.is_none());
        assert_eq!(state.owner_key, Some(owner.owner));
    }
    #[test]
    fn explicit_shutdown_returns_exact_owner_cleanup_and_never_ready() {
        let (mut c, _, _, owner, runtime) = live();
        let ticket = c.stop().unwrap().unwrap();
        assert_eq!(ticket.owner, owner.owner);
        assert!(c.snapshot().stopped);
        assert!(c.snapshot().offered_site.is_none());
        assert!(c.runtime_ready(runtime).is_err());
        c.finish_close(&ticket, true).unwrap();
        assert!(c.snapshot().owner_key.is_none());
        assert!(c.snapshot().runtime_ready.is_none());
        assert!(c.snapshot().presented_ready.is_none());
        assert!(c.snapshot().previous_owner_closed);
    }
    #[test]
    fn immutable_pack_generation_cannot_be_reused_for_changed_bytes() {
        let mut c = coordinator();
        let first = report(1, 1);
        accept(&mut c, &first);
        let mut collision = first.clone();
        collision.manifest_sha256 = sha('9');
        collision.publication_token.source_revision += 1;
        let checked = approval(&c, &collision);
        assert!(c.accept_portable(checked).is_err());
        assert_eq!(
            c.snapshot().portable.unwrap().manifest_sha256,
            first.manifest_sha256
        );
    }
    #[test]
    fn fresh_client_counter_cannot_relabel_an_old_actual_frame_publication() {
        let (mut c, _, _, _, runtime) = live();
        let mut late = presented_receipt(&runtime, 2);
        late.publication = PresentedPublication::ExternalFrame {
            render_revision: WireU64(1),
        };
        assert!(c.presented_ready(late).is_err());
        assert_eq!(
            c.snapshot().presented_ready.unwrap().presentation_revision,
            WireU64(1)
        );
    }

    #[test]
    fn shutdown_close_failure_can_retry_cleanup_without_authorizing_a_start() {
        let (mut c, lease, _, _, _) = live();
        let close = c.stop().unwrap().unwrap();
        assert!(c.finish_close(&close, false).unwrap().is_none());
        assert_eq!(c.snapshot().runtime_phase, RuntimePhase::CloseUncertain);
        let retry = c
            .retry_close(&lease, c.control_revision(), c.terminal_cleanup_revision())
            .unwrap();
        c.finish_close(&retry, true).unwrap();
        assert!(c.snapshot().owner_key.is_none());
        assert!(c.snapshot().stopped);
        assert!(c.begin_stage(c.control_revision()).is_err());
    }

    #[test]
    fn malformed_source_diagnostic_cannot_leave_old_publication_authorized() {
        let (mut c, _, _, owner, _) = live();
        assert!(c
            .source_error("BUILD_FAILED", &"x".repeat(MAX_MESSAGE + 1))
            .is_err());
        let state = c.snapshot();
        assert!(!state.portable_current);
        assert!(state.offered_site.is_none());
        assert_eq!(state.owner_key, Some(owner.owner));
        assert!(c.close.is_none());
    }

    #[test]
    fn exact_unused_first_start_can_be_abandoned_without_stopping_or_starting_owner() {
        let (mut c, lease, report, site, ticket) = unused_start();
        let revision = c.control_revision();
        c.abandon_start(&ticket).unwrap();
        let state = c.snapshot();
        assert_eq!(state.control_revision, WireU64(revision.get() + 1));
        assert!(!state.stopped);
        assert!(state.activation_id.is_none());
        assert!(state.owner_key.is_none());
        assert_eq!(state.offered_site, Some(site.clone()));
        assert!(state.portable_current);
        assert_eq!(state.runtime_phase, RuntimePhase::Absent);
        assert_eq!(state.presentation_phase, PresentationPhase::Absent);
        assert!(state.runtime_ready.is_none());
        assert!(state.presented_ready.is_none());
        assert!(!state.previous_owner_closed);
        assert!(c.close.is_none());
        assert!(c
            .start_owner(ticket.clone(), "never-authorized".to_owned())
            .is_err());
        assert!(c.abandon_start(&ticket).is_err());
        let BeginActivation::Start(next) = activate(&mut c, &lease, &site, &report) else {
            panic!("new first start");
        };
        assert_ne!(next.binding.activation_id, ticket.binding.activation_id);
        c.start_owner(next, "fresh-owner".to_owned()).unwrap();
    }

    #[test]
    fn post_close_start_abandonment_preserves_actual_close_without_claiming_rollback() {
        let (mut c, lease, _, old_owner, _) = live();
        let next = report(2, 2);
        accept(&mut c, &next);
        let site = stage(&mut c, &next);
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &next) else {
            panic!("close old owner");
        };
        assert_eq!(close.owner, old_owner.owner);
        let ticket = c.finish_close(&close, true).unwrap().unwrap();
        c.abandon_start(&ticket).unwrap();
        let state = c.snapshot();
        assert!(state.previous_owner_closed);
        assert!(state.owner_key.is_none());
        assert!(state.runtime_ready.is_none());
        assert!(state.presented_ready.is_none());
        assert!(state.activation_id.is_none());
        assert!(c.close.is_none());
        assert!(!state.stopped);
        let BeginActivation::Start(fresh) = activate(&mut c, &lease, &site, &next) else {
            panic!("old heap is gone");
        };
        c.start_owner(fresh, "fresh-after-close".to_owned())
            .unwrap();
    }

    #[test]
    fn abandonment_requires_every_exact_start_ticket_binding_and_revision() {
        let (mut c, _, _, _, ticket) = unused_start();
        let mut candidates = Vec::new();
        let mut wrong = ticket.clone();
        wrong.start_revision = WireU64(ticket.start_revision.get() + 1);
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.version = "2.0".to_owned();
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.run_id = "other-run".to_owned();
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.site_id = WireU64(999);
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.token_id = sha('9');
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.activation_id = WireU64(999);
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.preview.preview_id = "other-preview".to_owned();
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.preview.lease_revision = WireU64(999);
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.startup_revision = WireU64(999);
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.runtime_bundle_sha256 = sha('9');
        candidates.push(wrong);
        let mut wrong = ticket.clone();
        wrong.binding.index_sha256 = sha('9');
        candidates.push(wrong);
        let before = serde_json::to_value(c.snapshot()).unwrap();
        for wrong in candidates {
            assert!(c.abandon_start(&wrong).is_err());
            assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
            assert!(c.owner.is_none());
            assert!(c.close.is_none());
        }
        c.abandon_start(&ticket).unwrap();
    }

    #[test]
    fn granted_activation_is_not_an_unused_start_ticket() {
        let mut c = coordinator();
        let lease = claim(&mut c);
        let report = report(1, 1);
        accept(&mut c, &report);
        let site = stage(&mut c, &report);
        let checked = approval(&c, &report);
        let permit = c.issue_activation(&lease, site.site_id, checked).unwrap();
        let forged = StartTicket {
            binding: permit.binding.clone(),
            start_revision: permit.control_revision,
        };
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert!(c.abandon_start(&forged).is_err());
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        c.cancel_activation(&lease, &permit).unwrap();
    }

    #[test]
    fn registered_starting_owner_cannot_be_abandoned_even_before_client_construction() {
        let (mut c, _, _, _, ticket) = unused_start();
        let owner = c
            .start_owner(ticket.clone(), "registered-not-yet-constructed".to_owned())
            .unwrap();
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert_eq!(
            c.abandon_start(&ticket).unwrap_err(),
            CoordinatorError::Busy
        );
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        assert_eq!(c.snapshot().owner_key, Some(owner.owner.clone()));
        let close = c
            .fail_owner(&owner.owner, "cancelled after registered startup")
            .unwrap();
        assert_eq!(
            c.abandon_start(&ticket).unwrap_err(),
            CoordinatorError::Busy
        );
        assert_eq!(c.close, Some(close.clone()));
        c.finish_close(&close, true).unwrap();
        assert!(c.abandon_start(&ticket).is_err());
    }

    #[test]
    fn abandonment_never_unlocks_closing_or_uncertain_owner() {
        let (mut c, lease, report, site, old_ticket) = unused_start();
        let old_owner = c
            .start_owner(old_ticket.clone(), "old-owner".to_owned())
            .unwrap();
        let BeginActivation::Close(close) = activate(&mut c, &lease, &site, &report) else {
            panic!("close");
        };
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert_eq!(
            c.abandon_start(&old_ticket).unwrap_err(),
            CoordinatorError::Busy
        );
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        assert_eq!(c.close, Some(close.clone()));
        c.finish_close(&close, false).unwrap();
        let uncertain = serde_json::to_value(c.snapshot()).unwrap();
        assert_eq!(
            c.abandon_start(&old_ticket).unwrap_err(),
            CoordinatorError::Busy
        );
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), uncertain);
        assert_eq!(c.snapshot().owner_key, Some(old_owner.owner));
        assert_eq!(c.snapshot().owner_phase, Some(OwnerPhase::CloseUncertain));
    }

    #[test]
    fn abandoned_ticket_cannot_cancel_newer_unused_start() {
        let (mut c, lease, report, site, old) = unused_start();
        c.abandon_start(&old).unwrap();
        let BeginActivation::Start(next) = activate(&mut c, &lease, &site, &report) else {
            panic!("fresh start");
        };
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert!(c.abandon_start(&old).is_err());
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        c.abandon_start(&next).unwrap();
    }

    #[test]
    fn unused_start_can_be_abandoned_after_unrelated_control_and_staging_advancement() {
        let (mut c, lease, report, _, ticket) = unused_start();
        let stage_ticket = c.begin_stage(c.control_revision()).unwrap();
        assert!(c.control_revision() > ticket.start_revision);
        c.fail_stage(
            &stage_ticket,
            "SITE_BUILD_FAILED",
            "independent restaging failed",
        )
        .unwrap();
        let diagnostic = c.snapshot().site_diagnostic.unwrap();
        c.abandon_start(&ticket).unwrap();
        let state = c.snapshot();
        assert_eq!(state.site_diagnostic, Some(diagnostic));
        assert_eq!(state.site_phase, SitePhase::Failed);
        assert!(state.owner_key.is_none());
        assert!(!state.stopped);
        let site = stage(&mut c, &report);
        let BeginActivation::Start(next) = activate(&mut c, &lease, &site, &report) else {
            panic!("restaged start");
        };
        c.abandon_start(&next).unwrap();
    }

    #[test]
    fn source_revocation_already_releases_unused_start_and_old_ticket_cannot_cancel_recovery() {
        let (mut c, lease, _, _, old) = unused_start();
        c.source_error("BUILD_FAILED", "new source invalidated old authority")
            .unwrap();
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert!(c.abandon_start(&old).is_err());
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        let recovered = report(2, 2);
        accept(&mut c, &recovered);
        let site = stage(&mut c, &recovered);
        let BeginActivation::Start(next) = activate(&mut c, &lease, &site, &recovered) else {
            panic!("recovered start");
        };
        let recovered_state = serde_json::to_value(c.snapshot()).unwrap();
        assert!(c.abandon_start(&old).is_err());
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), recovered_state);
        c.abandon_start(&next).unwrap();
    }

    #[test]
    fn abandoned_start_allows_explicit_preview_re_election_but_old_lease_cannot_release_new_ticket()
    {
        let (mut c, _, report, site, old) = unused_start();
        c.abandon_start(&old).unwrap();
        let next_lease = c
            .claim_preview(c.control_revision(), "new-preview".to_owned())
            .unwrap();
        let BeginActivation::Start(next) = activate(&mut c, &next_lease, &site, &report) else {
            panic!("new preview start");
        };
        let before = serde_json::to_value(c.snapshot()).unwrap();
        assert!(c.abandon_start(&old).is_err());
        assert_eq!(serde_json::to_value(c.snapshot()).unwrap(), before);
        c.abandon_start(&next).unwrap();
    }

    #[test]
    fn abandonment_at_counter_exhaustion_never_wraps_or_authorizes_a_start() {
        let (mut c, _, _, _, ticket) = unused_start();
        c.control_revision = WireU64(u64::MAX);
        assert_eq!(
            c.abandon_start(&ticket).unwrap_err(),
            CoordinatorError::Stopped
        );
        let state = c.snapshot();
        assert!(state.stopped);
        assert_eq!(state.control_revision, WireU64(u64::MAX));
        assert!(state.activation_id.is_none());
        assert!(state.owner_key.is_none());
        assert!(c.close.is_none());
        assert!(c.start_owner(ticket, "must-not-start".to_owned()).is_err());
    }

    #[test]
    fn restaging_one_pack_uses_distinct_immutable_site_resource_namespaces() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let first = stage(&mut c, &report);
        let mut changed = startup(2);
        changed.sha256 = sha('8');
        c.update_configuration(c.control_revision(), runtime(), changed)
            .unwrap();
        let second = stage(&mut c, &report);
        assert_eq!(
            first.portable.pack_generation,
            second.portable.pack_generation
        );
        assert_eq!(first.index, second.index);
        assert_ne!(first.site_id, second.site_id);
        assert_ne!(first.index_url, second.index_url);
        assert_eq!(
            first.index_url,
            format!(
                "/__weapp/pack/run-test/{}/pack-index.json",
                first.site_id.get()
            )
        );
        assert_eq!(
            second.index_url,
            format!(
                "/__weapp/pack/run-test/{}/pack-index.json",
                second.site_id.get()
            )
        );
    }

    #[test]
    fn stage_binds_intent_separately_from_the_generated_index_dependent_startup() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let mut wrong = artifact(&ticket);
        wrong.startup_intent_sha256 = sha('9');
        let checked = approval(&c, &report);
        assert!(c.finish_stage(ticket.clone(), wrong, checked).is_err());
        let output = artifact(&ticket);
        assert_ne!(output.startup_sha256, ticket.startup.sha256);
        let actual = output.startup_sha256.clone();
        let checked = approval(&c, &report);
        let site = c.finish_stage(ticket, output, checked).unwrap();
        assert_eq!(site.startup.sha256, actual);
        assert_eq!(site.startup.revision, startup(1).revision);
    }

    #[test]
    fn a_site_cannot_offer_an_index_that_the_real_worker_will_reject_for_size() {
        let mut c = coordinator();
        let report = report(1, 1);
        accept(&mut c, &report);
        let ticket = c.begin_stage(c.control_revision()).unwrap();
        let mut oversized = artifact(&ticket);
        oversized.index.size = WireU64(2 * 1024 * 1024 + 1);
        let checked = approval(&c, &report);
        assert_eq!(
            c.finish_stage(ticket.clone(), oversized, checked)
                .unwrap_err(),
            CoordinatorError::Invalid("index size")
        );
        assert!(c.snapshot().offered_site.is_none());
        let mut maximum = artifact(&ticket);
        maximum.index.size = WireU64(2 * 1024 * 1024);
        let checked = approval(&c, &report);
        c.finish_stage(ticket, maximum, checked).unwrap();
    }

    #[test]
    fn authority_exhaustion_still_allows_ordered_exact_shutdown_cleanup() {
        let (mut c, _, _, owner, _) = live();
        c.control_revision = WireU64(u64::MAX);
        assert_eq!(
            c.begin_stage(WireU64(u64::MAX)).unwrap_err(),
            CoordinatorError::Stopped
        );
        let before = c.snapshot();
        let close = c.stop().unwrap().unwrap();
        assert_eq!(close.owner, owner.owner);
        assert_eq!(close.close_revision, WireU64(u64::MAX));
        assert!(close.terminal_cleanup_revision > before.terminal_cleanup_revision);
        let closing = c.snapshot();
        assert_eq!(c.stop().unwrap(), Some(close.clone()));
        assert!(c.finish_close(&close, true).unwrap().is_none());
        let closed = c.snapshot();
        assert_eq!(closed.control_revision, WireU64(u64::MAX));
        assert!(closed.terminal_cleanup_revision > closing.terminal_cleanup_revision);
        assert!(closed.owner_key.is_none());
        assert!(closed.stopped);
        assert!(closed.previous_owner_closed);
        assert!(c.finish_close(&close, true).is_err());
    }

    #[test]
    fn exhausted_authority_never_lets_a_stale_cleanup_retry_replace_the_current_one() {
        let (mut c, lease, _, owner, _) = live();
        c.control_revision = WireU64(u64::MAX);
        let close = c
            .fail_owner(&owner.owner, "failed at authority exhaustion")
            .unwrap();
        assert!(c.snapshot().stopped);
        let old_cleanup_revision = c.terminal_cleanup_revision();
        c.finish_close(&close, false).unwrap();
        assert!(c
            .retry_close(&lease, c.control_revision(), old_cleanup_revision)
            .is_err());
        let retry = c
            .retry_close(&lease, c.control_revision(), c.terminal_cleanup_revision())
            .unwrap();
        assert_eq!(retry.close_revision, close.close_revision);
        assert!(retry.terminal_cleanup_revision > close.terminal_cleanup_revision);
        assert!(c.finish_close(&close, true).is_err());
        assert!(c.finish_close(&retry, true).unwrap().is_none());
        assert!(c.snapshot().stopped);
        assert!(c.snapshot().owner_key.is_none());
    }
}
