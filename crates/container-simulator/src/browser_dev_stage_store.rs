//! Stage jobs share the aggregate's ORIGINAL ledger and namespace owners.
//!
//! Two fixed slots include construction failures, running jobs, captured static
//! bytes and every retirement retry. No publication/readiness authority lives
//! here. All operations belong on the serialized artifact lane.

use super::{
    identifier, AccessError, AdmissionError, Capacity, Ledger, NamespaceCharge, NamespaceId,
    PortableInputLease, Reservation, RetiredResources, RuntimeInputLease, Step, StoreFailure,
    MAX_BODY_LEASES, MAX_INPUT_PATH_BYTES, MIB,
};
use crate::browser_dev_artifact_job::{
    ArtifactConstructionError, ArtifactJob, ArtifactJobCompletion, ArtifactJobConfig,
};
use crate::browser_dev_coordinator::{StageArtifact, StageTicket};
use crate::browser_dev_runtime_receipt::RuntimeBundleRenderer;
use crate::browser_dev_stage_receipt::{
    PendingStageReceipt, StageBindingInput, StageBody, StaticStageReceipt,
};
use serde_json::Value;
use std::sync::Arc;

const STAGE_SLOTS: usize = 2;
const STARTUP_BYTES: usize = 64 * 1024;

/// Logical admission, not an allocator/RSS or filesystem quota assertion.
pub(super) const STAGE_CHARGE: Capacity = Capacity {
    memory_bytes: 512 * MIB,
    disk_bytes: 512 * MIB,
    files: 16_392,
    directories: 2050,
    namespaces: 1,
    finite_jobs: 1,
};

#[derive(Debug)]
pub(crate) struct StageStartInput {
    pub(crate) run_id: String,
    pub(crate) request_id: String,
    pub(crate) ticket: StageTicket,
    pub(crate) startup_intent: Vec<u8>,
    pub(crate) runtime: RuntimeInputLease,
    pub(crate) portable_input: PortableInputLease,
}

fn owned_by_ledger(ledger: &Ledger, runtime: NamespaceId, portable: NamespaceId) -> bool {
    runtime.store == ledger.store && portable.store == ledger.store && runtime != portable
}

impl StageStartInput {
    // All borrowed checks precede admission. Actual paths/pins come from the
    // owned leases; caller-provided directory/report metadata cannot mint one.
    fn validate(&self, ledger: &Ledger, config: &ArtifactJobConfig) -> bool {
        let (parent, job_name) = config.namespace_request_parts();
        let Some(parent_text) = parent.to_str() else {
            return false;
        };
        let Some(portable_path) = self.portable_input.directory().to_str() else {
            return false;
        };
        let report = self.portable_input.report();
        !self.run_id.is_empty()
            && self.run_id == self.ticket.run_id()
            && self.run_id.len() <= 128
            && self
                .run_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            && identifier(&self.request_id)
            && identifier(job_name)
            && parent.is_absolute()
            && parent_text.len() <= MAX_INPUT_PATH_BYTES
            && portable_path.len() <= MAX_INPUT_PATH_BYTES
            && self.portable_input.directory().is_absolute()
            && owned_by_ledger(
                ledger,
                self.runtime.namespace(),
                self.portable_input.namespace(),
            )
            && self.ticket.runtime_pins() == self.runtime.pins()
            && self.ticket.pack_report() == report
            && report
                .selected_route
                .as_ref()
                .is_some_and(|route| !route.is_empty())
            && !self.startup_intent.is_empty()
            && self.startup_intent.len() <= STARTUP_BYTES
            && std::str::from_utf8(&self.startup_intent).is_ok()
            && container_ir::hex_digest(&self.startup_intent)
                == self.ticket.startup_intent_pin().sha256
    }

    /// Allocated only after the original aggregate reserves STAGE_CHARGE.
    /// Serialized expectations derive from actual retained runtime/source
    /// owners; the ticket supplies only the already-bound startup correlation.
    fn request(&self) -> Value {
        let pins = self.runtime.pins();
        let report = self.portable_input.report();
        let renderer = match self.runtime.renderer() {
            RuntimeBundleRenderer::Software => "software",
            RuntimeBundleRenderer::Canvaskit => "canvaskit",
        };
        let intent = std::str::from_utf8(&self.startup_intent)
            .expect("stage admission checked original UTF-8 bytes");
        serde_json::json!({
            "schemaVersion": 1,
            "requestId": self.request_id,
            "op": "stage-pack",
            "runtime": {
                "directory": self.runtime.directory(),
                "expectedBundleSha256": pins.bundle_sha256,
                "expected": {
                    "reportSha256": pins.producer_report_sha256,
                    "sourceCommit": pins.source_commit,
                    "sourceSha256": pins.source_inventory_sha256,
                    "renderer": renderer,
                },
            },
            "stage": {
                "packDirectory": self.portable_input.directory(),
                "expected": {
                    "revision": report.revision.to_string(),
                    "manifestSha256": report.manifest_sha256,
                    "integrityRoot": report.integrity_root,
                    "compilerCommit": report.compiler_commit,
                    "selectedRoute": report.selected_route,
                    "startupIntentSha256": self.ticket.startup_intent_pin().sha256,
                },
                "runId": self.run_id,
                "siteId": self.ticket.site_id(),
                "publicationToken": {
                    "sourceRevision": report.publication_token.source_revision.to_string(),
                    "compilerReceiptSequence": report.publication_token.compiler_receipt_sequence.to_string(),
                },
                "inputBindingSha256": self.ticket.input_binding_sha256(),
                "startupIntentJson": intent,
            },
        })
    }

    fn into_binding(self, request_sha256: String) -> StageBindingInput {
        let Self {
            run_id,
            request_id,
            ticket,
            startup_intent,
            runtime,
            portable_input,
        } = self;
        StageBindingInput {
            run_id,
            request_id,
            request_sha256,
            ticket,
            startup_intent,
            runtime,
            portable_input,
        }
    }
}

/// Rejection has acquired no stage reservation and returns both ORIGINAL
/// capabilities and the actual config/tool borrower without reconstruction.
#[must_use]
#[derive(Debug)]
pub(crate) struct StageStartRejection {
    pub(crate) cause: AdmissionError,
    pub(crate) config: ArtifactJobConfig,
    pub(crate) input: StageStartInput,
}

#[derive(Debug)]
struct ChargedConstruction {
    actual: ArtifactConstructionError,
    input: StageStartInput,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct ChargedJob {
    actual: ArtifactJob,
    pending: PendingStageReceipt,
    charge: Arc<NamespaceCharge>,
}

/// Pending receipt's Weak files reference must be removed after the process
/// barrier and before exclusive files cleanup, while its input stays owned.
#[derive(Debug)]
enum RetiringInput {
    Pending(Box<PendingStageReceipt>),
    Binding(Box<StageBindingInput>),
}

impl RetiringInput {
    fn into_binding(self) -> StageBindingInput {
        match self {
            Self::Pending(pending) => (*pending).into_input(),
            Self::Binding(input) => *input,
        }
    }
}

#[derive(Debug)]
struct RetiringJob {
    actual: ArtifactJob,
    completion: Option<Box<ArtifactJobCompletion>>,
    input: RetiringInput,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct CapturedStage {
    receipt: StaticStageReceipt,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
struct RetiredStage {
    resources: RetiredResources,
    // Runtime/source inputs outlive actual stage output cleanup, including
    // failures and outstanding output byte borrowers.
    input: StageBindingInput,
    charge: Arc<NamespaceCharge>,
}

#[derive(Debug)]
enum State {
    Construction(Box<ChargedConstruction>),
    Running(Box<ChargedJob>),
    RetiringJob(Box<RetiringJob>),
    Captured(Box<CapturedStage>),
    Retired(Box<RetiredStage>),
    Cleaned(Arc<NamespaceCharge>),
    RefundPending(Reservation),
}

#[derive(Debug)]
struct Entry {
    id: NamespaceId,
    state: State,
    diagnostic: Option<StoreFailure>,
}

/// Only the original stage charge is shared. No Clone/Weak/raw Arc or receipt
/// extraction can bypass the aggregate's per-stage borrower cap.
pub(crate) struct StageBodyLease {
    body: Arc<StageBody>,
    charge: Arc<NamespaceCharge>,
}

impl StageBodyLease {
    pub(crate) fn bytes(&self) -> &[u8] {
        self.body.bytes()
    }
    pub(crate) fn namespace(&self) -> NamespaceId {
        self.charge.reservation.id
    }
}

impl std::fmt::Debug for StageBodyLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("StageBodyLease")
            .field("namespace", &self.namespace())
            .field("length", &self.bytes().len())
            .finish()
    }
}

#[must_use = "retire and drain every stage before source/runtime shutdown"]
#[derive(Debug)]
pub(super) struct StageStore {
    entries: Vec<Option<Entry>>,
}

impl StageStore {
    pub(super) fn new() -> Result<Self, StoreFailure> {
        let mut entries = Vec::new();
        entries
            .try_reserve_exact(STAGE_SLOTS)
            .map_err(|_| StoreFailure::Invariant("cannot reserve stage cleanup slots"))?;
        for _ in 0..STAGE_SLOTS {
            entries.push(None);
        }
        Ok(Self { entries })
    }

    pub(super) fn start(
        &mut self,
        ledger: &mut Ledger,
        config: ArtifactJobConfig,
        input: StageStartInput,
    ) -> Result<(NamespaceId, Step), Box<StageStartRejection>> {
        if !input.validate(ledger, &config) {
            return Err(Box::new(StageStartRejection {
                cause: AdmissionError::InvalidInput,
                config,
                input,
            }));
        }
        let Some(index) = self.entries.iter().position(Option::is_none) else {
            return Err(Box::new(StageStartRejection {
                cause: AdmissionError::Capacity,
                config,
                input,
            }));
        };
        let reservation = match ledger.reserve_source(STAGE_CHARGE) {
            Ok(reservation) => reservation,
            Err(cause) => {
                return Err(Box::new(StageStartRejection {
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
                State::Construction(Box::new(ChargedConstruction {
                    actual,
                    input,
                    charge,
                })),
                None,
                Step::Retiring,
            ),
            Ok(actual) => {
                // Do not hash the pre-constructor Value. Spawn rewrites the
                // destination; only this actual request binding is authoritative.
                let request_sha256 = actual.request_binding().2.to_owned();
                let input = input.into_binding(request_sha256);
                match PendingStageReceipt::bind(&actual, input) {
                    Ok(pending) => (
                        State::Running(Box::new(ChargedJob {
                            actual,
                            pending,
                            charge,
                        })),
                        None,
                        Step::Running,
                    ),
                    Err(failure) => (
                        State::RetiringJob(Box::new(RetiringJob {
                            actual,
                            completion: None,
                            input: RetiringInput::Binding(Box::new(failure.input)),
                            charge,
                        })),
                        Some(StoreFailure::StageReceipt(failure.cause)),
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

    fn index(&self, id: NamespaceId) -> Result<usize, AccessError> {
        self.entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|entry| entry.id == id))
            .ok_or(AccessError::UnknownNamespace)
    }

    fn captured(&self, id: NamespaceId) -> Result<&CapturedStage, AccessError> {
        let entry = self.entries[self.index(id)?]
            .as_ref()
            .ok_or(AccessError::UnknownNamespace)?;
        match &entry.state {
            State::Captured(stage) => Ok(stage),
            _ => Err(AccessError::NotCaptured),
        }
    }

    pub(super) fn artifact(&self, id: NamespaceId) -> Result<&StageArtifact, AccessError> {
        Ok(self.captured(id)?.receipt.artifact())
    }
    pub(super) fn diagnostic(&self, id: NamespaceId) -> Result<Option<&StoreFailure>, AccessError> {
        Ok(self.entries[self.index(id)?]
            .as_ref()
            .and_then(|entry| entry.diagnostic.as_ref()))
    }
    pub(super) fn construction_failure(
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
    pub(super) fn resource(
        &mut self,
        id: NamespaceId,
        path: &str,
    ) -> Result<Option<StageBodyLease>, AccessError> {
        let stage = self.captured(id)?;
        if path.len() > 2048 {
            return Ok(None);
        }
        let Some(body) = stage.receipt.resource(path) else {
            return Ok(None);
        };
        if Arc::strong_count(&stage.charge) > MAX_BODY_LEASES {
            return Err(AccessError::BorrowerCapacity);
        }
        Ok(Some(StageBodyLease {
            body,
            charge: stage.charge.clone(),
        }))
    }

    pub(super) fn poll(
        &mut self,
        ledger: &mut Ledger,
        id: NamespaceId,
    ) -> Result<Step, AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        let mut step = Step::Retiring;
        entry.state = match entry.state {
            State::Running(mut job) => match job.actual.poll() {
                Ok(None) => {
                    step = Step::Running;
                    State::Running(job)
                }
                Err(cause) => {
                    entry.diagnostic = Some(StoreFailure::Job(cause));
                    let ChargedJob {
                        actual,
                        pending,
                        charge,
                    } = *job;
                    State::RetiringJob(Box::new(RetiringJob {
                        actual,
                        completion: None,
                        input: RetiringInput::Pending(Box::new(pending)),
                        charge,
                    }))
                }
                Ok(Some(completion)) => {
                    let same_files = Arc::ptr_eq(job.actual.files(), &completion.files);
                    let finite = if same_files {
                        ledger.retire_process(&mut job.charge)
                    } else {
                        Err(StoreFailure::Invariant(
                            "stage actual completion files owner differs",
                        ))
                    };
                    match finite {
                        Err(cause) => {
                            entry.diagnostic = Some(cause);
                            let ChargedJob {
                                actual,
                                pending,
                                charge,
                            } = *job;
                            State::RetiringJob(Box::new(RetiringJob {
                                actual,
                                completion: Some(Box::new(completion)),
                                input: RetiringInput::Pending(Box::new(pending)),
                                charge,
                            }))
                        }
                        Ok(()) => {
                            let ChargedJob {
                                actual,
                                pending,
                                charge,
                            } = *job;
                            drop(actual);
                            match pending.accept(completion) {
                                Ok(receipt) => {
                                    step = Step::CapturedStatic;
                                    State::Captured(Box::new(CapturedStage { receipt, charge }))
                                }
                                Err(failure) => {
                                    let (cause, completion, input) = failure.into_parts();
                                    entry.diagnostic = Some(StoreFailure::StageReceipt(cause));
                                    State::Retired(Box::new(RetiredStage {
                                        resources: RetiredResources::Completion(completion),
                                        input,
                                        charge,
                                    }))
                                }
                            }
                        }
                    }
                }
            },
            State::Captured(stage) => {
                step = Step::CapturedStatic;
                State::Captured(stage)
            }
            other => other,
        };
        self.entries[index] = Some(entry);
        Ok(step)
    }

    /// Immediately revoke lookup. Existing StageBodyLease instances retain
    /// their actual bytes/files and SAME stage charge until complete drop.
    pub(super) fn retire(&mut self, id: NamespaceId) -> Result<(), AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        entry.state = match entry.state {
            State::Running(job) => {
                let ChargedJob {
                    actual,
                    pending,
                    charge,
                } = *job;
                State::RetiringJob(Box::new(RetiringJob {
                    actual,
                    completion: None,
                    input: RetiringInput::Pending(Box::new(pending)),
                    charge,
                }))
            }
            State::Captured(stage) => {
                let CapturedStage { receipt, charge } = *stage;
                let (completion, input) = receipt.into_retirement();
                State::Retired(Box::new(RetiredStage {
                    resources: RetiredResources::Completion(Box::new(completion)),
                    input,
                    charge,
                }))
            }
            other => other,
        };
        self.entries[index] = Some(entry);
        Ok(())
    }

    pub(super) fn cleanup(
        &mut self,
        ledger: &mut Ledger,
        id: NamespaceId,
    ) -> Result<Step, AccessError> {
        let index = self.index(id)?;
        let mut entry = self.entries[index]
            .take()
            .ok_or(AccessError::UnknownNamespace)?;
        // Error strings and metadata are byte owners too: retire them before
        // the same charge can be refunded, including successful retry turns.
        drop(entry.diagnostic.take());
        let (state, diagnostic) = Self::cleanup_state(ledger, entry.state);
        let Some(state) = state else {
            return Ok(Step::Released);
        };
        entry.state = state;
        entry.diagnostic = diagnostic;
        let step = match &entry.state {
            State::Running(_) => Step::Running,
            State::Captured(_) => Step::CapturedStatic,
            _ => Step::CleanupPending,
        };
        self.entries[index] = Some(entry);
        Ok(step)
    }

    fn cleanup_state(ledger: &mut Ledger, state: State) -> (Option<State>, Option<StoreFailure>) {
        match state {
            State::Construction(mut failure) => match failure.actual.retry_cleanup() {
                Ok(false) => (Some(State::Construction(failure)), None),
                Err(cause) => (
                    Some(State::Construction(failure)),
                    Some(StoreFailure::Job(cause)),
                ),
                Ok(true) => {
                    let ChargedConstruction {
                        actual,
                        input,
                        charge,
                    } = *failure;
                    drop(actual);
                    drop(input);
                    Self::finish_charge(ledger, charge)
                }
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
                if let Err(cause) = ledger.retire_process(&mut job.charge) {
                    return (Some(State::RetiringJob(job)), Some(cause));
                }
                let RetiringJob {
                    actual,
                    completion,
                    input,
                    charge,
                } = *job;
                let files = actual.files().clone();
                drop(actual);
                let input = input.into_binding();
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
                Self::cleanup_state(
                    ledger,
                    State::Retired(Box::new(RetiredStage {
                        resources,
                        input,
                        charge,
                    })),
                )
            }
            State::Retired(mut retired) => {
                if Arc::get_mut(&mut retired.charge).is_none() {
                    return (Some(State::Retired(retired)), None);
                }
                match retired.resources.cleanup() {
                    Ok(false) => (Some(State::Retired(retired)), None),
                    Err(cause) => (Some(State::Retired(retired)), Some(cause)),
                    Ok(true) => {
                        let RetiredStage {
                            resources,
                            input,
                            charge,
                        } = *retired;
                        drop(resources);
                        drop(input);
                        Self::finish_charge(ledger, charge)
                    }
                }
            }
            State::Cleaned(charge) => Self::finish_charge(ledger, charge),
            State::RefundPending(token) => Self::finish_refund(ledger, token),
            other => (Some(other), None),
        }
    }

    fn finish_charge(
        ledger: &mut Ledger,
        charge: Arc<NamespaceCharge>,
    ) -> (Option<State>, Option<StoreFailure>) {
        match Arc::try_unwrap(charge) {
            Ok(charge) => Self::finish_refund(ledger, charge.reservation),
            Err(charge) => (
                Some(State::Cleaned(charge)),
                Some(StoreFailure::Invariant(
                    "cleaned stage charge still borrowed",
                )),
            ),
        }
    }

    fn finish_refund(
        ledger: &mut Ledger,
        token: Reservation,
    ) -> (Option<State>, Option<StoreFailure>) {
        match ledger.refund(token) {
            Ok(()) => (None, None),
            Err(token) => (
                Some(State::RefundPending(token)),
                Some(StoreFailure::Invariant(
                    "stage refund rejected; original token retained",
                )),
            ),
        }
    }

    pub(super) fn ids(&self) -> Vec<NamespaceId> {
        self.entries
            .iter()
            .filter_map(|entry| entry.as_ref().map(|entry| entry.id))
            .collect()
    }
    pub(super) fn is_drained(&self) -> bool {
        self.entries.iter().all(Option::is_none)
    }
}

#[cfg(test)]
#[path = "browser_dev_stage_store_tests.rs"]
mod tests;
