//! Managed admission for the supervisor's runtime, source and stage jobs.
//!
//! This store owns resources, not HTTP, coordinator state or CLI activation.
//! Calls that spawn, poll, capture, shut down or remove files belong on the
//! serialized artifact lane, never a socket turn or a shared surface mutex.
//! The fixed charges below are LOGICAL policy reservations, not allocator,
//! serde, Node RSS, or filesystem quota guarantees. See README.md.

use crate::browser_dev_artifact_job::{
    ArtifactConstructionError, ArtifactFiles, ArtifactJob, ArtifactJobCompletion,
    ArtifactJobConfig, ArtifactJobError,
};
use crate::browser_dev_coordinator::RuntimePins;
use crate::browser_dev_runtime_receipt::{
    PendingRuntimeReceipt, ProducerExpected, ReceiptError, RuntimeBody, RuntimeBundleRenderer,
    StaticRuntimeReceipt,
};
use serde_json::Value;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[path = "browser_dev_source_credit.rs"]
mod source_credit;
#[path = "browser_dev_stage_store.rs"]
mod stage_store;
pub(crate) use source_credit::{
    CreditStatus, PackSourceInput, PackStart, PortableInputLease, SourceInputLease,
    SourceStartRejection, SourceStep,
};
pub(crate) use stage_store::{StageBodyLease, StageStartInput, StageStartRejection};

#[path = "browser_dev_runtime_input.rs"]
mod runtime_input;
pub(crate) use runtime_input::RuntimeInputLease;

const MIB: u64 = 1024 * 1024;
const MAX_NAMESPACES: usize = 2;
const MAX_BODY_LEASES: usize = 64;
const MAX_INPUT_PATH_BYTES: usize = 4096;
static NEXT_STORE: AtomicU64 = AtomicU64::new(1);

/// One class-specific reservation, held in full until explicit final cleanup.
/// Metadata, scratch and request allowances are policy, not measured maxima.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Capacity {
    pub(crate) memory_bytes: u64,
    pub(crate) disk_bytes: u64,
    pub(crate) files: u32,
    pub(crate) directories: u32,
    pub(crate) namespaces: u16,
    pub(crate) finite_jobs: u16,
}

const RUNTIME_CHARGE: Capacity = Capacity {
    memory_bytes: 1024 * MIB,
    disk_bytes: 512 * MIB,
    files: 16_392,
    directories: 2050,
    namespaces: 1,
    finite_jobs: 1,
};
const LIMIT: Capacity = Capacity {
    memory_bytes: 2048 * MIB,
    disk_bytes: 1024 * MIB,
    files: 32_784,
    directories: 4100,
    namespaces: 2,
    finite_jobs: 1,
};

// Explicit source-watch profile; retain-only callers keep LIMIT unchanged.
// Logical admission recipes, not RSS/allocator or filesystem quotas. A stage
// or previous browser site is NOT admitted by this profile.
const SOURCE_LIMIT: Capacity = Capacity {
    memory_bytes: 3072 * MIB,
    disk_bytes: 3072 * MIB,
    files: 81_984,
    directories: 10_286,
    namespaces: 6,
    finite_jobs: 1,
};
const SOURCE_ROOT_CHARGE: Capacity = Capacity {
    memory_bytes: 512 * MIB,
    disk_bytes: 512 * MIB,
    files: 16_416,
    directories: 2080,
    namespaces: 1,
    finite_jobs: 0,
};

// Opt-in consuming-stage profile: one runtime, one control root, two raw
// generations, two portable generations, and two actual stage/site slots.
// Retired sites still count until their last body/input borrower is gone.
// This is a logical admission recipe, not measured RSS or a hard disk quota.
const STAGE_LIMIT: Capacity = Capacity {
    memory_bytes: 4096 * MIB,
    disk_bytes: 4096 * MIB,
    files: 114_768,
    directories: 14_386,
    namespaces: 8,
    finite_jobs: 1,
};

impl Capacity {
    fn checked_add(self, other: Self) -> Option<Self> {
        Some(Self {
            memory_bytes: self.memory_bytes.checked_add(other.memory_bytes)?,
            disk_bytes: self.disk_bytes.checked_add(other.disk_bytes)?,
            files: self.files.checked_add(other.files)?,
            directories: self.directories.checked_add(other.directories)?,
            namespaces: self.namespaces.checked_add(other.namespaces)?,
            finite_jobs: self.finite_jobs.checked_add(other.finite_jobs)?,
        })
    }

    fn checked_sub(self, other: Self) -> Option<Self> {
        Some(Self {
            memory_bytes: self.memory_bytes.checked_sub(other.memory_bytes)?,
            disk_bytes: self.disk_bytes.checked_sub(other.disk_bytes)?,
            files: self.files.checked_sub(other.files)?,
            directories: self.directories.checked_sub(other.directories)?,
            namespaces: self.namespaces.checked_sub(other.namespaces)?,
            finite_jobs: self.finite_jobs.checked_sub(other.finite_jobs)?,
        })
    }

    fn within(self, limit: Self) -> bool {
        self.memory_bytes <= limit.memory_bytes
            && self.disk_bytes <= limit.disk_bytes
            && self.files <= limit.files
            && self.directories <= limit.directories
            && self.namespaces <= limit.namespaces
            && self.finite_jobs <= limit.finite_jobs
    }
}

/// Copyable identity only. It cannot mint an owner or reservation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NamespaceId {
    store: u64,
    serial: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum AdmissionError {
    #[error("invalid bounded retain-runtime input")]
    InvalidInput,
    #[error("static runtime capacity is occupied")]
    Capacity,
    #[error("static runtime identity space exhausted")]
    IdentityExhausted,
}

/// Retain-only, fixed grammar. No arbitrary Value/JSON intake from HTTP.
#[derive(Debug)]
pub(crate) struct RetainRuntimeInput {
    pub(crate) request_id: String,
    pub(crate) built_site_directory: PathBuf,
    pub(crate) expected: ProducerExpected,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

impl RetainRuntimeInput {
    fn validate(&self, config: &ArtifactJobConfig) -> bool {
        let (parent, job_name) = config.namespace_request_parts();
        let Some(parent) = parent.to_str() else {
            return false;
        };
        let Some(producer) = self.built_site_directory.to_str() else {
            return false;
        };
        identifier(&self.request_id)
            && identifier(job_name)
            && parent.len() <= MAX_INPUT_PATH_BYTES
            && producer.len() <= MAX_INPUT_PATH_BYTES
            && self.built_site_directory.is_absolute()
            && lower_hex(&self.expected.report_sha256, 64)
            && lower_hex(&self.expected.source_sha256, 64)
            && lower_hex(&self.expected.source_commit, 40)
    }

    // Called only AFTER reserve(). Fixed strings and bounded UTF-8 path inputs
    // keep even 6x JSON escaping far below the transport's 2 MiB request cap.
    fn request(&self) -> Value {
        let renderer = match self.expected.renderer {
            RuntimeBundleRenderer::Software => "software",
            RuntimeBundleRenderer::Canvaskit => "canvaskit",
        };
        serde_json::json!({
            "schemaVersion": 1,
            "requestId": self.request_id,
            "op": "retain-runtime",
            "runtime": {
                "builtSiteDirectory": self.built_site_directory,
                "expected": {
                    "reportSha256": self.expected.report_sha256,
                    "sourceCommit": self.expected.source_commit,
                    "sourceSha256": self.expected.source_sha256,
                    "renderer": renderer,
                },
            },
        })
    }
}

/// Admission rejection returns the actual unconsumed config/tool borrower.
/// A caller must retain/retry or explicitly clean that owner; a string is not
/// a replacement for this value. Rejection acquired no runtime reservation.
#[must_use]
#[derive(Debug)]
pub(crate) struct StartRejection {
    pub(crate) cause: AdmissionError,
    pub(crate) config: ArtifactJobConfig,
    pub(crate) input: RetainRuntimeInput,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum StoreFailure {
    #[error("{0}")]
    Job(ArtifactJobError),
    #[error("{0}")]
    Receipt(ReceiptError),
    #[error("{0}")]
    StageReceipt(crate::browser_dev_stage_receipt::StageReceiptError),
    #[error("{0}")]
    Cleanup(io::Error),
    #[error("{0}")]
    Invariant(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub(crate) enum AccessError {
    #[error("namespace does not belong to this store or was already released")]
    UnknownNamespace,
    #[error("namespace is not a captured static runtime")]
    NotCaptured,
    #[error("namespace runtime borrower quota is occupied")]
    BorrowerCapacity,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Running,
    CapturedStatic,
    Retiring,
    CleanupPending,
    Released,
}

#[derive(Debug)]
struct Reservation {
    id: NamespaceId,
    remaining: Capacity,
    active: bool,
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if self.active {
            // No refund in Drop. The live store ledger entry stays charged
            // on accidental loss; normal shutdown must drain every owner.
            eprintln!(
                "weapp-simulator: abandoned charged static namespace {:?}",
                self.id
            );
        }
    }
}

#[derive(Debug)]
struct NamespaceCharge {
    reservation: Reservation,
}

#[derive(Debug)]
struct Ledger {
    store: u64,
    next_serial: u64,
    used: Capacity,
    limit: Capacity,
}

impl Ledger {
    fn reserve(&mut self) -> Result<Reservation, AdmissionError> {
        let used = self
            .used
            .checked_add(RUNTIME_CHARGE)
            .ok_or(AdmissionError::Capacity)?;
        if !used.within(self.limit) {
            return Err(AdmissionError::Capacity);
        }
        let serial = self
            .next_serial
            .checked_add(1)
            .ok_or(AdmissionError::IdentityExhausted)?;
        self.next_serial = serial;
        self.used = used;
        Ok(Reservation {
            id: NamespaceId {
                store: self.store,
                serial,
            },
            remaining: RUNTIME_CHARGE,
            active: true,
        })
    }

    fn retire_process(&mut self, charge: &mut Arc<NamespaceCharge>) -> Result<(), StoreFailure> {
        let owner = Arc::get_mut(charge).ok_or(StoreFailure::Invariant(
            "running charge unexpectedly borrowed",
        ))?;
        let token = &mut owner.reservation;
        if !token.active || token.id.store != self.store || token.remaining.finite_jobs != 1 {
            return Err(StoreFailure::Invariant(
                "finite slot was not owned exactly once",
            ));
        }
        let jobs = self
            .used
            .finite_jobs
            .checked_sub(1)
            .ok_or(StoreFailure::Invariant("finite slot ledger underflow"))?;
        // All checks precede either mutation: errors retain unchanged charge.
        self.used.finite_jobs = jobs;
        token.remaining.finite_jobs = 0;
        Ok(())
    }

    fn refund(&mut self, mut token: Reservation) -> Result<(), Reservation> {
        if !token.active || token.id.store != self.store {
            return Err(token);
        }
        let Some(used) = self.used.checked_sub(token.remaining) else {
            return Err(token);
        };
        self.used = used;
        token.active = false;
        Ok(())
    }
}

#[derive(Debug)]
struct ChargedJob {
    actual: ArtifactJob,
    pending: PendingRuntimeReceipt,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct RetiringJob {
    actual: ArtifactJob,
    // A terminal completion retained on an invariant error is never discarded
    // merely because it could not be accepted. No caller can supply this.
    completion: Option<Box<ArtifactJobCompletion>>,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct ChargedConstructionFailure {
    actual: ArtifactConstructionError,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct ChargedRuntime {
    receipt: Arc<StaticRuntimeReceipt>,
    charge: Arc<NamespaceCharge>,
}

/// Private original Arc<RuntimeBody>, not another read or Vec allocation.
/// No Clone/Deref/raw Arc/files/receipt/charge extraction is provided.
pub(crate) struct BodyLease {
    // Field order matters: a borrower's bytes/files drop before its charge Arc.
    body: Arc<RuntimeBody>,
    charge: Arc<NamespaceCharge>,
}

impl std::fmt::Debug for BodyLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("BodyLease")
            .field("namespace", &self.namespace())
            .field("length", &self.bytes().len())
            .finish()
    }
}

impl BodyLease {
    pub(crate) fn bytes(&self) -> &[u8] {
        self.body.bytes()
    }

    pub(crate) fn namespace(&self) -> NamespaceId {
        self.charge.reservation.id
    }
}

#[derive(Debug)]
enum RetiredResources {
    Completion(Box<ArtifactJobCompletion>),
    Files(Arc<ArtifactFiles>),
    // Unreachable for today's private actual.poll path. Preserve BOTH actual
    // owners if an invariant changes, rather than dropping the unexpected one.
    Split {
        job_files: Arc<ArtifactFiles>,
        completion: Box<ArtifactJobCompletion>,
    },
}

fn cleanup_files(files: &mut Arc<ArtifactFiles>) -> Result<bool, StoreFailure> {
    let Some(owner) = Arc::get_mut(files) else {
        return Ok(false);
    };
    owner.cleanup().map_err(StoreFailure::Cleanup)?;
    if !owner.is_retired() {
        return Err(StoreFailure::Invariant(
            "cleanup did not retire the actual file owner",
        ));
    }
    Ok(true)
}

impl RetiredResources {
    fn cleanup(&mut self) -> Result<bool, StoreFailure> {
        match self {
            Self::Completion(completion) => cleanup_files(&mut completion.files),
            Self::Files(files) => cleanup_files(files),
            Self::Split {
                job_files,
                completion,
            } => {
                if !cleanup_files(job_files)? {
                    return Ok(false);
                }
                cleanup_files(&mut completion.files)
            }
        }
    }
}

#[derive(Debug)]
struct RetiredNamespace {
    resources: RetiredResources,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
enum State {
    Running(Box<ChargedJob>),
    Construction(Box<ChargedConstructionFailure>),
    RetiringJob(Box<RetiringJob>),
    Captured(Box<ChargedRuntime>),
    // New lookup is revoked. Owned runtime inputs retain the original receipt
    // and files under this same namespace charge until their complete drop.
    RetiringCaptured(Box<ChargedRuntime>),
    Retired(Box<RetiredNamespace>),
    // Actual cleanup and byte-owner drop already succeeded, but a conservative
    // charge can remain if an impossible internal ownership invariant fails.
    Cleaned(Arc<NamespaceCharge>),
    RefundPending(Reservation),
}

#[derive(Debug)]
struct Entry {
    id: NamespaceId,
    state: State,
    diagnostic: Option<StoreFailure>,
}

/// Owns every admitted state in a pre-sized bounded slot array. No naked
/// completion/receipt/reservation is accepted. No current/publication pointer
/// exists: the future coordinator owns that decision independently.
#[must_use = "explicitly retire and drain this store before owner-lane shutdown"]
pub(crate) struct StaticRuntimeStore {
    ledger: Ledger,
    entries: Vec<Option<Entry>>,
    sources: Option<source_credit::SourceCredits>,
    source_root: Option<Reservation>,
    stages: Option<stage_store::StageStore>,
}

impl std::fmt::Debug for StaticRuntimeStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StaticRuntimeStore")
            .field("used", &self.ledger.used)
            .field(
                "occupied",
                &self.entries.iter().filter(|entry| entry.is_some()).count(),
            )
            .finish()
    }
}

impl StaticRuntimeStore {
    pub(crate) fn new() -> Result<Self, StoreFailure> {
        Self::with_source_policy(false, false)
    }

    pub(crate) fn with_sources() -> Result<Self, StoreFailure> {
        Self::with_source_policy(true, false)
    }

    pub(crate) fn with_stages() -> Result<Self, StoreFailure> {
        Self::with_source_policy(true, true)
    }

    fn with_source_policy(managed: bool, stages: bool) -> Result<Self, StoreFailure> {
        let store = NEXT_STORE
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| StoreFailure::Invariant("store identity space exhausted"))?;
        let mut entries = Vec::new();
        let runtime_slots = if managed { 1 } else { MAX_NAMESPACES };
        entries
            .try_reserve_exact(runtime_slots)
            .map_err(|_| StoreFailure::Invariant("cannot reserve cleanup entry array"))?;
        for _ in 0..runtime_slots {
            entries.push(None);
        }
        let mut store = Self {
            ledger: Ledger {
                store,
                next_serial: 0,
                used: Capacity::default(),
                limit: if stages {
                    STAGE_LIMIT
                } else if managed {
                    SOURCE_LIMIT
                } else {
                    LIMIT
                },
            },
            entries,
            sources: None,
            source_root: None,
            stages: if stages {
                Some(stage_store::StageStore::new()?)
            } else {
                None
            },
        };
        if managed {
            store.source_root = Some(
                store
                    .ledger
                    .reserve_source(SOURCE_ROOT_CHARGE)
                    .map_err(|_| StoreFailure::Invariant("source root admission rejected"))?,
            );
        }
        Ok(store)
    }

    pub(crate) fn source_root_policy(&self) -> Option<Capacity> {
        self.source_root
            .as_ref()
            .map(|reservation| reservation.remaining)
    }

    pub(crate) fn capacity(&self) -> (Capacity, Capacity) {
        (self.ledger.used, self.ledger.limit)
    }

    pub(crate) fn install_sources(
        &mut self,
        root: PathBuf,
        run: String,
        compiler: String,
    ) -> io::Result<()> {
        if self.source_root.is_none() || self.sources.is_some() {
            return Err(io::Error::other(
                "source policy was not admitted or already installed",
            ));
        }
        self.sources = Some(source_credit::SourceCredits::new(root, run, compiler)?);
        Ok(())
    }

    fn sources(&self) -> io::Result<&source_credit::SourceCredits> {
        self.sources
            .as_ref()
            .ok_or_else(|| io::Error::other("source registry not installed"))
    }
    fn sources_mut(&mut self) -> io::Result<&mut source_credit::SourceCredits> {
        self.sources
            .as_mut()
            .ok_or_else(|| io::Error::other("source registry not installed"))
    }
    pub(crate) fn issue_raw(&mut self) -> Result<NamespaceId, Box<SourceStartRejection>> {
        self.sources
            .as_mut()
            .expect("admitted source registry")
            .issue_raw(&mut self.ledger)
    }
    pub(crate) fn source_status(&self) -> io::Result<Option<CreditStatus>> {
        self.sources()?.read_status()
    }
    pub(crate) fn accept_raw(&mut self, status: &CreditStatus) -> io::Result<NamespaceId> {
        self.sources_mut()?.accept_raw_status(status)
    }
    pub(crate) fn source_borrow(&mut self, id: NamespaceId) -> io::Result<SourceInputLease> {
        self.sources_mut()?.borrow(id)
    }
    pub(crate) fn portable_input(&mut self, id: NamespaceId) -> io::Result<PortableInputLease> {
        self.sources_mut()?.borrow_portable(id)
    }
    pub(crate) fn start_source_pack(
        &mut self,
        intent: PackStart,
        input: PackSourceInput,
    ) -> Result<NamespaceId, Box<SourceStartRejection>> {
        self.sources
            .as_mut()
            .expect("admitted source registry")
            .start_pack(&mut self.ledger, intent, input)
    }
    pub(crate) fn poll_source_pack(&mut self, id: NamespaceId) -> io::Result<SourceStep> {
        self.sources
            .as_mut()
            .ok_or_else(|| io::Error::other("source registry not installed"))?
            .poll_pack(&mut self.ledger, id)
    }
    pub(crate) fn source_report(
        &self,
        id: NamespaceId,
    ) -> io::Result<&crate::dev::PortablePackReport> {
        self.sources()?.portable_report(id)
    }
    pub(crate) fn source_step(&self, id: NamespaceId) -> io::Result<SourceStep> {
        self.sources()?.step(id)
    }
    pub(crate) fn source_diagnostic(&self, id: NamespaceId) -> io::Result<Option<&str>> {
        self.sources()?.diagnostic(id)
    }
    pub(crate) fn retire_source(&mut self, id: NamespaceId) -> io::Result<()> {
        self.sources_mut()?.retire(id)
    }
    pub(crate) fn cleanup_source(&mut self, id: NamespaceId) -> io::Result<SourceStep> {
        self.sources
            .as_mut()
            .ok_or_else(|| io::Error::other("source registry not installed"))?
            .cleanup(&mut self.ledger, id)
    }
    pub(crate) fn source_ids(&self) -> Vec<NamespaceId> {
        self.sources
            .as_ref()
            .map_or_else(Vec::new, |source| source.ids())
    }
    pub(crate) fn spawn_source_watcher(
        &mut self,
        command: &mut std::process::Command,
    ) -> io::Result<()> {
        self.sources_mut()?.spawn_watcher(command)
    }
    pub(crate) fn source_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.sources.as_mut()?.take_watcher_stdout()
    }
    pub(crate) fn source_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.sources.as_mut()?.take_watcher_stderr()
    }
    pub(crate) fn poll_source_watcher(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.sources_mut()?.poll_watcher()
    }
    pub(crate) fn stop_source_watcher(&mut self) -> io::Result<bool> {
        match self.sources.as_mut() {
            Some(source) => source.try_stop_watcher(),
            None => Ok(true),
        }
    }

    pub(crate) fn start_stage(
        &mut self,
        config: ArtifactJobConfig,
        input: StageStartInput,
    ) -> Result<(NamespaceId, Step), Box<StageStartRejection>> {
        match self.stages.as_mut() {
            Some(stages) => stages.start(&mut self.ledger, config, input),
            None => Err(Box::new(StageStartRejection {
                cause: AdmissionError::InvalidInput,
                config,
                input,
            })),
        }
    }

    pub(crate) fn poll_stage(&mut self, id: NamespaceId) -> Result<Step, AccessError> {
        self.stages
            .as_mut()
            .ok_or(AccessError::UnknownNamespace)?
            .poll(&mut self.ledger, id)
    }

    pub(crate) fn stage_artifact(
        &self,
        id: NamespaceId,
    ) -> Result<&crate::browser_dev_coordinator::StageArtifact, AccessError> {
        self.stages
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?
            .artifact(id)
    }

    pub(crate) fn stage_resource(
        &mut self,
        id: NamespaceId,
        path: &str,
    ) -> Result<Option<StageBodyLease>, AccessError> {
        self.stages
            .as_mut()
            .ok_or(AccessError::UnknownNamespace)?
            .resource(id, path)
    }

    pub(crate) fn retire_stage(&mut self, id: NamespaceId) -> Result<(), AccessError> {
        self.stages
            .as_mut()
            .ok_or(AccessError::UnknownNamespace)?
            .retire(id)
    }

    pub(crate) fn cleanup_stage(&mut self, id: NamespaceId) -> Result<Step, AccessError> {
        self.stages
            .as_mut()
            .ok_or(AccessError::UnknownNamespace)?
            .cleanup(&mut self.ledger, id)
    }

    pub(crate) fn stage_diagnostic(&self, id: NamespaceId) -> Result<Option<String>, AccessError> {
        let stages = self.stages.as_ref().ok_or(AccessError::UnknownNamespace)?;
        if let Some(failure) = stages.construction_failure(id)? {
            return Ok(Some(failure.cause().to_string()));
        }
        Ok(stages.diagnostic(id)?.map(ToString::to_string))
    }

    pub(crate) fn stage_ids(&self) -> Vec<NamespaceId> {
        self.stages
            .as_ref()
            .map_or_else(Vec::new, |stages| stages.ids())
    }

    pub(crate) fn payloads_drained(&self) -> bool {
        self.entries.iter().all(Option::is_none)
            && self
                .stages
                .as_ref()
                .is_none_or(|stages| stages.is_drained())
            && self
                .sources
                .as_ref()
                .is_none_or(|source| source.is_drained())
    }
    /// Caller has removed its actual parent only after tool/body/source drain.
    pub(crate) fn release_source_root(&mut self) -> Result<(), StoreFailure> {
        if !self.payloads_drained() {
            return Err(StoreFailure::Invariant("source parent still borrowed"));
        }
        if let Some(token) = self.source_root.take() {
            if let Err(token) = self.ledger.refund(token) {
                self.source_root = Some(token);
                return Err(StoreFailure::Invariant("source parent refund rejected"));
            }
        }
        self.sources = None;
        Ok(())
    }

    fn index(&self, id: NamespaceId) -> Result<usize, AccessError> {
        self.entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|entry| entry.id == id))
            .ok_or(AccessError::UnknownNamespace)
    }

    /// Validation and aggregate admission precede request Value construction,
    /// actual spawn and every eventual actual.poll result-file allocation.
    /// The selected slot is already the namespace's future cleanup entry.
    pub(crate) fn start_runtime(
        &mut self,
        config: ArtifactJobConfig,
        input: RetainRuntimeInput,
    ) -> Result<(NamespaceId, Step), Box<StartRejection>> {
        if !input.validate(&config) {
            return Err(Box::new(StartRejection {
                cause: AdmissionError::InvalidInput,
                config,
                input,
            }));
        }
        let Some(index) = self.entries.iter().position(Option::is_none) else {
            return Err(Box::new(StartRejection {
                cause: AdmissionError::Capacity,
                config,
                input,
            }));
        };
        let reservation = match self.ledger.reserve() {
            Ok(reservation) => reservation,
            Err(cause) => {
                return Err(Box::new(StartRejection {
                    cause,
                    config,
                    input,
                }))
            }
        };
        let id = reservation.id;
        let charge = Arc::new(NamespaceCharge { reservation });
        let request = input.request();
        let (state, diagnostic, step) = match ArtifactJob::spawn(config, request) {
            Err(actual) => (
                State::Construction(Box::new(ChargedConstructionFailure { actual, charge })),
                None,
                Step::Retiring,
            ),
            Ok(actual) => {
                // These are the exact stored fields/hash computed from bytes
                // written by the actual constructor, without request reread.
                let (request_id, operation, request_sha256) = actual.request_binding();
                let pending = if request_id != input.request_id || operation != "retain-runtime" {
                    Err(ReceiptError::Invalid(
                        "actual request binding differs from bounded input",
                    ))
                } else {
                    PendingRuntimeReceipt::bind(
                        &actual,
                        request_id.to_owned(),
                        request_sha256.to_owned(),
                        input.expected,
                    )
                };
                match pending {
                    Ok(pending) => (
                        State::Running(Box::new(ChargedJob {
                            actual,
                            pending,
                            charge,
                        })),
                        None,
                        Step::Running,
                    ),
                    Err(cause) => (
                        State::RetiringJob(Box::new(RetiringJob {
                            actual,
                            completion: None,
                            charge,
                        })),
                        Some(StoreFailure::Receipt(cause)),
                        Step::Retiring,
                    ),
                }
            }
        };
        self.entries[index] = Some(Entry {
            id,
            state,
            diagnostic,
        });
        Ok((id, step))
    }

    pub(crate) fn diagnostic(&self, id: NamespaceId) -> Result<Option<&StoreFailure>, AccessError> {
        Ok(self.entries[self.index(id)?]
            .as_ref()
            .and_then(|entry| entry.diagnostic.as_ref()))
    }

    pub(crate) fn construction_failure(
        &self,
        id: NamespaceId,
    ) -> Result<Option<&ArtifactConstructionError>, AccessError> {
        let entry = self.entries[self.index(id)?]
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?;
        Ok(match &entry.state {
            State::Construction(failure) => Some(&failure.actual),
            _ => None,
        })
    }

    pub(crate) fn pins(&self, id: NamespaceId) -> Result<&RuntimePins, AccessError> {
        let entry = self.entries[self.index(id)?]
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?;
        match &entry.state {
            State::Captured(runtime) => Ok(runtime.receipt.pins()),
            _ => Err(AccessError::NotCaptured),
        }
    }

    /// A shared 64-lease quota covers body and owned runtime input borrowers.
    /// Exclusive store access makes checking and minting one serialized turn.
    /// Concurrent drops can only decrease the count; neither lease exposes a
    /// Clone/Weak path to mint another charge borrower. Bytes stay shared.
    pub(crate) fn resource(
        &mut self,
        id: NamespaceId,
        path: &str,
    ) -> Result<Option<BodyLease>, AccessError> {
        let entry = self.entries[self.index(id)?]
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?;
        let State::Captured(runtime) = &entry.state else {
            return Err(AccessError::NotCaptured);
        };
        if path.len() > 2048 {
            return Ok(None);
        }
        let Some(body) = runtime.receipt.resource(path) else {
            return Ok(None);
        };
        if Arc::strong_count(&runtime.charge) > MAX_BODY_LEASES {
            return Err(AccessError::BorrowerCapacity);
        }
        Ok(Some(BodyLease {
            body,
            charge: runtime.charge.clone(),
        }))
    }

    /// Move an actual captured runtime input to a pending artifact consumer.
    /// Pins and directory metadata alone cannot construct this capability.
    pub(crate) fn runtime_input(
        &mut self,
        id: NamespaceId,
    ) -> Result<RuntimeInputLease, AccessError> {
        let entry = self.entries[self.index(id)?]
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?;
        let State::Captured(runtime) = &entry.state else {
            return Err(AccessError::NotCaptured);
        };
        if Arc::strong_count(&runtime.charge) > MAX_BODY_LEASES {
            return Err(AccessError::BorrowerCapacity);
        }
        RuntimeInputLease::from_captured(runtime)
    }

    /// The ONLY managed actual.poll call. Admission is already held in this
    /// entry before poll reads result. No raw completion leaves the store.
    pub(crate) fn poll(&mut self, id: NamespaceId) -> Result<Step, AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        let (state, diagnostic, step) = match entry.state {
            State::Running(mut job) => match job.actual.poll() {
                Ok(None) => (State::Running(job), None, Step::Running),
                Err(cause) => {
                    let ChargedJob {
                        actual,
                        pending,
                        charge,
                    } = *job;
                    drop(pending);
                    (
                        State::RetiringJob(Box::new(RetiringJob {
                            actual,
                            completion: None,
                            charge,
                        })),
                        Some(StoreFailure::Job(cause)),
                        Step::Retiring,
                    )
                }
                Ok(Some(completion)) => {
                    // Same terminal turn: compare ACTUAL Arc identities before
                    // retiring the finite slot, while both owners still exist.
                    let transition = if Arc::ptr_eq(job.actual.files(), &completion.files) {
                        self.ledger.retire_process(&mut job.charge)
                    } else {
                        Err(StoreFailure::Invariant(
                            "actual job returned another files owner",
                        ))
                    };
                    let ChargedJob {
                        actual,
                        pending,
                        charge,
                    } = *job;
                    match transition {
                        Err(cause) => {
                            drop(pending);
                            (
                                State::RetiringJob(Box::new(RetiringJob {
                                    actual,
                                    completion: Some(Box::new(completion)),
                                    charge,
                                })),
                                Some(cause),
                                Step::Retiring,
                            )
                        }
                        Ok(()) => {
                            // poll has verified the process-tree barrier. Drop
                            // its extra files/tool borrow BEFORE receipt intake.
                            drop(actual);
                            match pending.accept(completion) {
                                Ok(receipt) => (
                                    State::Captured(Box::new(ChargedRuntime {
                                        receipt: Arc::new(receipt),
                                        charge,
                                    })),
                                    None,
                                    Step::CapturedStatic,
                                ),
                                Err(failure) => {
                                    let (cause, completion) = failure.into_parts();
                                    (
                                        State::Retired(Box::new(RetiredNamespace {
                                            resources: RetiredResources::Completion(Box::new(
                                                completion,
                                            )),
                                            charge,
                                        })),
                                        Some(StoreFailure::Receipt(cause)),
                                        Step::Retiring,
                                    )
                                }
                            }
                        }
                    }
                }
            },
            state => {
                let step = match &state {
                    State::Captured(_) => Step::CapturedStatic,
                    _ => Step::Retiring,
                };
                self.entries[index] = Some(Entry { state, ..entry });
                return Ok(step);
            }
        };
        entry.state = state;
        if diagnostic.is_some() {
            entry.diagnostic = diagnostic;
        }
        self.entries[index] = Some(entry);
        Ok(step)
    }

    /// Stop new resource and runtime input lookup. Existing leases retain the
    /// exact original bytes/receipt and SAME charge through consumer teardown.
    pub(crate) fn retire(&mut self, id: NamespaceId) -> Result<(), AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        entry.state = match entry.state {
            State::Captured(runtime) => State::RetiringCaptured(runtime),
            State::Running(job) => {
                let ChargedJob {
                    actual,
                    pending,
                    charge,
                } = *job;
                drop(pending);
                State::RetiringJob(Box::new(RetiringJob {
                    actual,
                    completion: None,
                    charge,
                }))
            }
            other => other,
        };
        self.entries[index] = Some(entry);
        Ok(())
    }

    /// Bounded one-record cleanup operation, outside socket/shared locks.
    /// Retrying a failure never refunds, loses or reconstructs its actual owner.
    pub(crate) fn cleanup(&mut self, id: NamespaceId) -> Result<Step, AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        // The previous diagnostic can own serde/IO error strings outside the
        // resources enum. Drop it before cleanup_state can release this
        // namespace's memory charge. An unsuccessful attempt stores its new
        // diagnostic below; history belongs to a separately budgeted sink.
        drop(entry.diagnostic.take());
        let (state, diagnostic) = self.cleanup_state(entry.state);
        let Some(state) = state else {
            return Ok(Step::Released);
        };
        entry.state = state;
        if diagnostic.is_some() {
            entry.diagnostic = diagnostic;
        }
        let step = match &entry.state {
            State::Running(_) => Step::Running,
            State::Captured(_) => Step::CapturedStatic,
            _ => Step::CleanupPending,
        };
        self.entries[index] = Some(entry);
        Ok(step)
    }

    fn cleanup_state(&mut self, state: State) -> (Option<State>, Option<StoreFailure>) {
        match state {
            State::Construction(mut failure) => match failure.actual.retry_cleanup() {
                Ok(true) => {
                    let ChargedConstructionFailure { actual, charge } = *failure;
                    drop(actual); // Config/Files/Job recovery is now empty.
                    self.finish_charge(charge)
                }
                Ok(false) => (Some(State::Construction(failure)), None),
                Err(cause) => (
                    Some(State::Construction(failure)),
                    Some(StoreFailure::Job(cause)),
                ),
            },
            State::RetiringJob(mut job) => {
                match job.actual.shutdown() {
                    Ok(false) => return (Some(State::RetiringJob(job)), None),
                    Err(cause) => {
                        return (
                            Some(State::RetiringJob(job)),
                            Some(StoreFailure::Job(cause)),
                        )
                    }
                    Ok(true) => {}
                }
                if let Err(cause) = self.ledger.retire_process(&mut job.charge) {
                    return (Some(State::RetiringJob(job)), Some(cause));
                }
                let RetiringJob {
                    actual,
                    completion,
                    charge,
                } = *job;
                let files = actual.files().clone();
                drop(actual); // confirmed process barrier; release extra refs.
                let resources = match completion {
                    None => RetiredResources::Files(files),
                    Some(completion) if Arc::ptr_eq(&files, &completion.files) => {
                        drop(files);
                        RetiredResources::Completion(completion)
                    }
                    Some(completion) => RetiredResources::Split {
                        job_files: files,
                        completion,
                    },
                };
                self.cleanup_state(State::Retired(Box::new(RetiredNamespace {
                    resources,
                    charge,
                })))
            }
            State::Retired(mut retired) => {
                // Charge barrier proves every managed body borrower is gone;
                // files barrier below also catches raw legacy files/Weak refs.
                if Arc::get_mut(&mut retired.charge).is_none() {
                    return (Some(State::Retired(retired)), None);
                }
                match retired.resources.cleanup() {
                    Ok(false) => (Some(State::Retired(retired)), None),
                    Err(cause) => (Some(State::Retired(retired)), Some(cause)),
                    Ok(true) => {
                        let RetiredNamespace { resources, charge } = *retired;
                        // IMPORTANT: result Arc<Vec>, request metadata and all
                        // other remaining byte owners drop BEFORE any refund.
                        // cleanup=true by itself is not memory retirement.
                        drop(resources);
                        self.finish_charge(charge)
                    }
                }
            }
            State::RetiringCaptured(mut runtime) => {
                // Receipt fields drop before a lease's charge. The charge
                // barrier therefore waits for the COMPLETE input/body drop,
                // not merely its earlier receipt Arc decrement on another
                // thread, before consuming the original receipt.
                if Arc::get_mut(&mut runtime.charge).is_none() {
                    return (Some(State::RetiringCaptured(runtime)), None);
                }
                let ChargedRuntime { receipt, charge } = *runtime;
                match Arc::try_unwrap(receipt) {
                    Err(receipt) => (
                        Some(State::RetiringCaptured(Box::new(ChargedRuntime {
                            receipt,
                            charge,
                        }))),
                        None,
                    ),
                    Ok(receipt) => {
                        // Captured bodies and raw bundle/report bytes drop
                        // here, before actual files cleanup and any refund.
                        let completion = receipt.into_completion();
                        self.cleanup_state(State::Retired(Box::new(RetiredNamespace {
                            resources: RetiredResources::Completion(Box::new(completion)),
                            charge,
                        })))
                    }
                }
            }
            State::Cleaned(charge) => self.finish_charge(charge),
            State::RefundPending(token) => self.finish_refund(token),
            other => (Some(other), None),
        }
    }

    fn finish_charge(
        &mut self,
        charge: Arc<NamespaceCharge>,
    ) -> (Option<State>, Option<StoreFailure>) {
        match Arc::try_unwrap(charge) {
            Ok(charge) => self.finish_refund(charge.reservation),
            Err(charge) => (
                Some(State::Cleaned(charge)),
                Some(StoreFailure::Invariant("cleaned charge still borrowed")),
            ),
        }
    }

    fn finish_refund(&mut self, token: Reservation) -> (Option<State>, Option<StoreFailure>) {
        match self.ledger.refund(token) {
            Ok(()) => (None, None),
            Err(token) => (
                Some(State::RefundPending(token)),
                Some(StoreFailure::Invariant(
                    "refund rejected; original token retained",
                )),
            ),
        }
    }

    pub(crate) fn is_drained(&self) -> bool {
        self.payloads_drained()
            && self.source_root.is_none()
            && self.ledger.used == Capacity::default()
    }
}

impl Drop for StaticRuntimeStore {
    fn drop(&mut self) {
        if !self.is_drained() {
            // No synthetic refund, close-all, cleanup-by-path or claim that a
            // directory disappeared. Explicit owner-lane drain is mandatory.
            eprintln!(
                "weapp-simulator: static runtime store dropped before explicit cleanup: {:?}",
                self.ledger.used
            );
        }
    }
}

#[cfg(test)]
#[path = "browser_dev_aggregate_store_tests.rs"]
mod tests;
