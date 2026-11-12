//! One serial owner of the original supervisor, coordinator and control ledger.
//! Successful browser-reported close is disabled by default. Trusted startup
//! may explicitly bind the elected manager's control surface; accepting its
//! report still does not independently prove Worker termination.

use crate::browser_dev_control::{
    ControlError, ControlLedger, ControlLimits, ControlLookup, ErrorFact, ExecutionTicket, Lane,
    MAX_CONTROL_REQUEST_BYTES,
};
pub use crate::browser_dev_control_lane::OwnerObservation;
use crate::browser_dev_control_lane::{
    BrowserReportedClose, InvokeFailure, NoActualBrowser, ProtectedOwner, RetainedStageBinding,
    SerialControlLane,
};
use crate::browser_dev_coordinator::{
    BrowserDevCoordinator, CoordinatorError, CoordinatorSnapshot, PreviewLease,
    PublicationApproval, SiteDescriptor, StartupIntentPin, WireU64,
};
use crate::dev::{
    BrowserStagePoll, BrowserStageStart, DevError, DevEvent, DevSupervisor, PortablePackReport,
};
use crate::web::{WebResourceBody, WebResourceResolution, WebResourceTarget, WebSurface};
use crate::web_control::{
    ControlAcknowledgementReply, ControlHttpAuth, ControlHttpError, WebControlRequest,
    WebControlResponse,
};
use std::io;
use std::sync::Weak;

#[derive(Debug, thiserror::Error)]
pub enum OwnerError {
    #[error("ERR_UNSUPPORTED_CAPABILITY: {0}")]
    Unavailable(&'static str),
    #[error(transparent)]
    Supervisor(#[from] DevError),
    #[error(transparent)]
    Coordinator(#[from] CoordinatorError),
    #[error(transparent)]
    Control(#[from] ControlError),
}

/// Initialization failure retains the SAME supervisor for explicit cleanup.
/// Returning an error must not replace an unresolved process/store owner.
#[must_use]
pub struct OwnerInitFailure {
    pub supervisor: DevSupervisor,
    pub error: OwnerError,
}
impl std::fmt::Debug for OwnerInitFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OwnerInitFailure")
            .field("error", &self.error)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserStageStartStatus {
    Started { site_id: WireU64 },
    SourcePending,
    Busy,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum StagePhase {
    Empty,
    Building,
    Offered,
    Retiring,
}

pub struct BrowserDevOwner {
    supervisor: DevSupervisor,
    coordinator: BrowserDevCoordinator,
    ledger: ControlLedger,
    stages: [Option<RetainedStageBinding>; 2],
    phases: [StagePhase; 2],
    protected: Option<ProtectedOwner>,
    source_probe: Option<PortablePackReport>,
    startup_intent: Vec<u8>,
    run_id: String,
    client_id: String,
    runtime_bundle_sha256: String,
    browser_reported_control: Option<Weak<()>>,
    control_retirement_enabled: bool,
    // The original execution ticket survives a final-retention failure. No new
    // invoke may hide it by executing the same mutation or replacing the ledger.
    unresolved_final: Option<ExecutionTicket>,
}

impl BrowserDevOwner {
    /// Call on the supervisor's owning thread after its pinned runtime is ready.
    /// Identities come from trusted local startup, never from an HTTP request.
    /// This claims exactly one preview; no takeover/bootstrap endpoint exists.
    pub fn new(
        supervisor: DevSupervisor,
        startup_intent: Vec<u8>,
        client_id: String,
        preview_id: String,
        limits: ControlLimits,
    ) -> Result<Self, Box<OwnerInitFailure>> {
        let initialized = (|| {
            if startup_intent.is_empty() || startup_intent.len() > MAX_CONTROL_REQUEST_BYTES {
                return Err(OwnerError::Unavailable("startup intent exceeds its bound"));
            }
            let run_id = supervisor
                .browser_stage_run_id()
                .ok_or(OwnerError::Unavailable(
                    "managed browser stage policy is required",
                ))?
                .to_owned();
            let runtime = supervisor
                .browser_runtime()
                .ok_or(OwnerError::Unavailable("pinned runtime is not prepared"))?;
            let mut coordinator = BrowserDevCoordinator::new(
                run_id.clone(),
                runtime.pins.clone(),
                StartupIntentPin {
                    revision: WireU64::new(1),
                    sha256: container_ir::hex_digest(&startup_intent),
                    metrics_revision: WireU64::new(0),
                },
            )?;
            let ledger = ControlLedger::new(run_id.clone(), client_id.clone(), limits)?;
            coordinator.claim_preview(coordinator.control_revision(), preview_id)?;
            Ok((
                run_id,
                runtime.pins.bundle_sha256.clone(),
                coordinator,
                ledger,
            ))
        })();
        match initialized {
            Ok((run_id, runtime_bundle_sha256, coordinator, ledger)) => {
                let source_probe = supervisor.portable_pack().cloned();
                Ok(Self {
                    supervisor,
                    coordinator,
                    ledger,
                    stages: [None, None],
                    phases: [StagePhase::Empty; 2],
                    protected: None,
                    source_probe,
                    startup_intent,
                    run_id,
                    client_id,
                    runtime_bundle_sha256,
                    browser_reported_control: None,
                    control_retirement_enabled: false,
                    unresolved_final: None,
                })
            }
            Err(error) => Err(Box::new(OwnerInitFailure { supervisor, error })),
        }
    }

    pub fn snapshot(&self) -> CoordinatorSnapshot {
        self.coordinator.snapshot()
    }

    /// Read-only gate for the original control ledger's acknowledged cleanup.
    /// This neither consumes ACKs nor proves supervisor/HTTP/Worker shutdown;
    /// the caller must also finish this same owner's `try_shutdown` and drain
    /// its original surface before dropping the server.
    pub fn control_cleanup_ready(&self) -> bool {
        self.unresolved_final.is_none() && self.ledger.cleanup_ready()
    }

    pub fn preview(&self) -> PreviewLease {
        self.coordinator
            .snapshot()
            .preview
            .expect("latched preview")
    }

    /// Observe through the original supervisor; callbacks receive every event.
    /// A callback cannot borrow this owner to recursively stage a new report.
    pub fn poll(&mut self, observe: &mut impl FnMut(OwnerObservation)) -> Result<(), OwnerError> {
        match self.supervisor.poll() {
            Ok(Some(event)) => self.observe_source(event, observe),
            Ok(None) => {}
            Err(error) => {
                self.source_failed(observe);
                return Err(error.into());
            }
        }
        self.recover_final()?;
        self.retire_pending()?;
        Ok(())
    }

    pub fn stage_latest(
        &mut self,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<BrowserStageStartStatus, OwnerError> {
        if self.coordinator.snapshot().stopped {
            return Err(CoordinatorError::Stopped.into());
        }
        self.retire_pending()?;
        let Some(report) = self.source_probe.clone() else {
            return Ok(BrowserStageStartStatus::SourcePending);
        };
        if self.stages.iter().flatten().any(|stage| {
            stage.ticket.pack_report() == &report
                && self.phases[self
                    .slot_for(stage.ticket.site_id())
                    .expect("retained slot")]
                    != StagePhase::Retiring
        }) {
            return Ok(BrowserStageStartStatus::Busy);
        }
        let Some(slot) = self.stages.iter().position(Option::is_none) else {
            return Ok(BrowserStageStartStatus::Busy);
        };
        let approval = match self.fresh(&report, observe) {
            Ok(approval) => approval,
            Err(OwnerError::Coordinator(CoordinatorError::Unauthorized)) => {
                return Ok(BrowserStageStartStatus::SourcePending);
            }
            Err(error) => return Err(error),
        };
        self.coordinator.accept_portable(approval)?;
        let ticket = self
            .coordinator
            .begin_stage(self.coordinator.control_revision())?;
        let site_id = ticket.site_id();
        match self
            .supervisor
            .begin_browser_stage(ticket.clone(), self.startup_intent.clone())
        {
            Ok(BrowserStageStart::Started(actual_stage)) => {
                self.stages[slot] = Some(RetainedStageBinding {
                    actual_stage,
                    ticket,
                });
                self.phases[slot] = StagePhase::Building;
                Ok(BrowserStageStartStatus::Started { site_id })
            }
            Ok(BrowserStageStart::SourcePending { events }) => {
                self.invalidate(observe);
                for event in events {
                    self.observe_source(event, observe);
                }
                Ok(BrowserStageStartStatus::SourcePending)
            }
            Err(error) => {
                if let Err(coordination) = self.coordinator.fail_stage(
                    &ticket,
                    "STAGE_START_FAILED",
                    "actual managed stage could not start",
                ) {
                    observe(OwnerObservation::Coordination(coordination));
                }
                Err(error.into())
            }
        }
    }

    /// At most two metadata results. Static capture is not runtime/presented
    /// readiness. A fresh original source barrier precedes each finish_stage.
    pub fn poll_stages(
        &mut self,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<Vec<SiteDescriptor>, OwnerError> {
        let mut ready = Vec::with_capacity(2);
        for slot in 0..2 {
            if self.phases[slot] != StagePhase::Building {
                continue;
            }
            let stage = self.stages[slot].as_ref().expect("building slot");
            let id = stage.actual_stage;
            let ticket = stage.ticket.clone();
            let result = self.supervisor.poll_browser_stage(id);
            match result {
                Ok(BrowserStagePoll::Running) => {}
                Ok(BrowserStagePoll::CapturedStatic {
                    artifact,
                    runtime_ready,
                    presented_ready,
                }) => {
                    if runtime_ready || presented_ready {
                        self.fail_stage(
                            slot,
                            "STAGE_CAPTURE_INVALID",
                            "static capture claimed execution",
                            observe,
                        );
                        return Err(OwnerError::Unavailable("static capture claimed execution"));
                    }
                    let approval = match self.fresh(ticket.pack_report(), observe) {
                        Ok(approval) => approval,
                        Err(error) => {
                            self.fail_stage(
                                slot,
                                "STAGE_SOURCE_CHANGED",
                                "source changed before stage publication",
                                observe,
                            );
                            return Err(error);
                        }
                    };
                    match self.coordinator.finish_stage(ticket, *artifact, approval) {
                        Ok(site) => {
                            self.phases[slot] = StagePhase::Offered;
                            ready.push(site);
                        }
                        Err(error) => {
                            self.fail_stage(
                                slot,
                                "STAGE_PUBLICATION_FAILED",
                                "captured stage was not accepted",
                                observe,
                            );
                            return Err(error.into());
                        }
                    }
                }
                Ok(_) => {
                    self.fail_stage(
                        slot,
                        "STAGE_CAPTURE_ENDED",
                        "stage ended before static capture",
                        observe,
                    );
                }
                Err(error) => {
                    self.fail_stage(
                        slot,
                        "STAGE_CAPTURE_FAILED",
                        "actual stage capture failed",
                        observe,
                    );
                    return Err(error.into());
                }
            }
        }
        Ok(ready)
    }

    pub fn enable_control(
        &self,
        surface: &mut WebSurface,
        origin: String,
        secret: String,
    ) -> Result<(), ControlHttpError> {
        surface.enable_control(ControlHttpAuth::new(
            self.run_id.clone(),
            self.client_id.clone(),
            secret,
            surface.local_addr().to_string(),
            origin,
        )?)
    }

    /// Opt in once from trusted local startup, before this surface accepts any
    /// socket. The caller must bootstrap exactly one real owner manager with
    /// this owner's run/client/preview and the same control credential. The
    /// manager must retain its exact wrapper and await its real close barrier.
    ///
    /// This accepts correlated browser-reported cleanup, not independent proof
    /// of Worker termination. Ordinary `enable_control` remains fail-closed.
    /// No HTTP command can enable this policy or choose a different owner.
    pub fn enable_browser_reported_control(
        &mut self,
        surface: &mut WebSurface,
        origin: String,
        secret: String,
    ) -> Result<(), ControlHttpError> {
        if self.browser_reported_control.is_some()
            || self.protected.is_some()
            || self.coordinator.snapshot().owner_key.is_some()
        {
            return Err(ControlHttpError::InvalidContext);
        }
        // Only successful binding of the ORIGINAL authenticated surface grants
        // the opt-in. A failed setup must leave the default close policy intact.
        self.enable_control(surface, origin, secret)?;
        self.browser_reported_control = Some(surface.instance_identity());
        Ok(())
    }

    /// Trusted startup-only opt-in, negotiated separately from ordinary ACK.
    /// No request may enable retirement after a command has been admitted.
    pub fn enable_control_retirement(&mut self) -> Result<(), ControlHttpError> {
        if self.control_retirement_enabled
            || self.ledger.seen_through(Lane::Normal).get() != 0
            || self.ledger.seen_through(Lane::Cleanup).get() != 0
            || self.coordinator.snapshot().owner_key.is_some()
            || self.unresolved_final.is_some()
        {
            return Err(ControlHttpError::InvalidContext);
        }
        self.control_retirement_enabled = true;
        Ok(())
    }

    pub fn resolve_controls(
        &mut self,
        surface: &mut WebSurface,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> io::Result<usize> {
        let browser_reported_close = self
            .browser_reported_control
            .as_ref()
            .is_some_and(|identity| identity.ptr_eq(&surface.instance_identity()));
        surface.resolve_control_requests(|auth, request| {
            if auth.run_id() != self.run_id || auth.client_id() != self.client_id {
                return WebControlResponse::Refused(ControlHttpError::Denied);
            }
            match request {
                WebControlRequest::Observe => {
                    WebControlResponse::Observation(Box::new(self.coordinator.snapshot()))
                }
                WebControlRequest::Retire(request) => {
                    if !self.control_retirement_enabled {
                        return WebControlResponse::Refused(ControlHttpError::Unavailable);
                    }
                    match self.ledger.retire_prefix(&self.run_id, request) {
                        Ok(reply) => WebControlResponse::Retired(reply),
                        Err(ControlError::WrongIdentity) => {
                            WebControlResponse::Refused(ControlHttpError::Denied)
                        }
                        Err(_) => WebControlResponse::Refused(ControlHttpError::InvalidRetirement),
                    }
                }
                WebControlRequest::Acknowledge(ack) => {
                    // Direct ACK: no lookup creates a new final body borrower.
                    match self.ledger.acknowledge_final(
                        &self.run_id,
                        ack.original_request_bytes(),
                        ack.final_sha256(),
                    ) {
                        Ok(outcome) => {
                            // The original ledger already validated and bound this
                            // <=64 KiB request. Extract metadata only AFTER ACK.
                            let value: serde_json::Value =
                                match serde_json::from_slice(ack.original_request_bytes()) {
                                    Ok(value) => value,
                                    Err(_) => {
                                        return WebControlResponse::Refused(
                                            ControlHttpError::InvalidAcknowledgement,
                                        )
                                    }
                                };
                            let Some(request_id) =
                                value.get("requestId").and_then(serde_json::Value::as_str)
                            else {
                                return WebControlResponse::Refused(
                                    ControlHttpError::InvalidAcknowledgement,
                                );
                            };
                            WebControlResponse::Acknowledged(ControlAcknowledgementReply {
                                version: "1.0",
                                request_id: request_id.to_owned(),
                                final_sha256: ack.final_sha256().to_owned(),
                                outcome,
                            })
                        }
                        Err(_) => {
                            WebControlResponse::Refused(ControlHttpError::InvalidAcknowledgement)
                        }
                    }
                }
                WebControlRequest::Replay(bytes) => {
                    // Exact replay is lookup-only, including the outer owner:
                    // no source poll, prepared-final recovery or retirement.
                    let lane = SerialControlLane {
                        supervisor: &mut self.supervisor,
                        coordinator: &mut self.coordinator,
                        ledger: &mut self.ledger,
                        stages: &self.stages,
                        protected: &mut self.protected,
                        source_probe: self.source_probe.as_ref(),
                        run_id: &self.run_id,
                        client_id: &self.client_id,
                    };
                    match lane.replay(bytes.bytes()) {
                        Ok(ControlLookup::Final(bytes)) => WebControlResponse::Final(bytes),
                        Err(ControlError::WrongIdentity) => {
                            WebControlResponse::Refused(ControlHttpError::Denied)
                        }
                        _ => WebControlResponse::Refused(ControlHttpError::Unavailable),
                    }
                }
                WebControlRequest::Invoke(bytes) => {
                    if self.recover_final().is_err() {
                        return WebControlResponse::Refused(ControlHttpError::Unavailable);
                    }
                    let mut changed = false;
                    let mut latest = None;
                    let mut lane_observe = |event| {
                        if let OwnerObservation::Source(source) = &event {
                            changed |= matches!(
                                source.as_ref(),
                                DevEvent::BuildStarted
                                    | DevEvent::PortableReady { .. }
                                    | DevEvent::Diagnostic(_)
                                    | DevEvent::Exited(_)
                            );
                            if let DevEvent::PortableReady { report, .. } = source.as_ref() {
                                latest = Some(report.clone());
                            }
                        }
                        observe(event);
                    };
                    let previous_protection = self
                        .protected
                        .as_ref()
                        .map(|owner| (owner.site_id, owner.actual_stage));
                    let before = self.coordinator.snapshot();
                    // Stop currently retains the original lease. Still avoid
                    // demanding one for every command: a missing future lease
                    // must fail close authority, not panic snapshot/cleanup.
                    let mut reported_close = before
                        .preview
                        .as_ref()
                        .filter(|_| browser_reported_close)
                        .map(|preview| BrowserReportedClose {
                            run_id: &self.run_id,
                            client_id: &self.client_id,
                            preview,
                            runtime_owner: before
                                .runtime_ready
                                .as_ref()
                                .map(|receipt| &receipt.owner),
                        });
                    let mut lane = SerialControlLane {
                        supervisor: &mut self.supervisor,
                        coordinator: &mut self.coordinator,
                        ledger: &mut self.ledger,
                        stages: &self.stages,
                        protected: &mut self.protected,
                        source_probe: self.source_probe.as_ref(),
                        run_id: &self.run_id,
                        client_id: &self.client_id,
                    };
                    let result = if let Some(close) = &mut reported_close {
                        lane.invoke(bytes.bytes(), close, &mut lane_observe)
                    } else {
                        lane.invoke(bytes.bytes(), &mut NoActualBrowser, &mut lane_observe)
                    };
                    if let Some(report) = latest {
                        self.source_probe = Some(report);
                    }
                    if changed || !self.coordinator.snapshot().portable_current {
                        self.retire_unprotected();
                    }
                    // Only an opt-in correlated report and the coordinator's
                    // exact original CloseTicket transition can release this
                    // protection. Retire ONLY that old actual stage, preserving
                    // a fresh replacement's offer and original body borrowers.
                    if let Some((site, actual)) = previous_protection {
                        if self.protected.is_none() {
                            if let Some(slot) = self.slot_for(site) {
                                if self.stages[slot]
                                    .as_ref()
                                    .is_some_and(|stage| stage.actual_stage == actual)
                                {
                                    self.phases[slot] = StagePhase::Retiring;
                                }
                            }
                        }
                    }
                    match result {
                        Ok(ControlLookup::Final(bytes)) => WebControlResponse::Final(bytes),
                        Ok(_) => WebControlResponse::Refused(ControlHttpError::Unavailable),
                        Err(InvokeFailure::Ledger(error)) => {
                            let code = match error {
                                ControlError::WrongIdentity => ControlHttpError::Denied,
                                _ => ControlHttpError::Unavailable,
                            };
                            WebControlResponse::Refused(code)
                        }
                        Err(InvokeFailure::FinalNotRetained { ticket, error }) => {
                            // Retain the original ticket even when serialization
                            // failed after mutation. It is never re-executed.
                            self.unresolved_final = Some(*ticket);
                            observe(OwnerObservation::Coordination(CoordinatorError::Invalid(
                                match error {
                                    ControlError::TooLarge => {
                                        "retained control final exceeded bound"
                                    }
                                    _ => "control final retention failed",
                                },
                            )));
                            WebControlResponse::Refused(ControlHttpError::Unavailable)
                        }
                    }
                }
            }
        })
    }

    /// URLs select only already retained metadata on this exact supervisor.
    /// No pathname opens files or constructs a stage/resource owner.
    pub fn resolve_resource(&mut self, target: &WebResourceTarget) -> WebResourceResolution {
        let requested = match target {
            WebResourceTarget::Runtime {
                bundle_sha256,
                path,
            } if bundle_sha256 == &self.runtime_bundle_sha256 => {
                return match self.supervisor.browser_runtime_resource(path) {
                    Ok(Some(body)) => WebResourceResolution::Found(WebResourceBody::Runtime(body)),
                    Ok(None) => WebResourceResolution::NotFound,
                    Err(_) => WebResourceResolution::Unavailable,
                };
            }
            WebResourceTarget::Pack {
                run_id,
                site_id,
                path,
            } if run_id == &self.run_id => (*site_id, path.as_str()),
            WebResourceTarget::Site { run_id, site_id } if run_id == &self.run_id => {
                (*site_id, "site.json")
            }
            _ => return WebResourceResolution::NotFound,
        };
        let Some(slot) = self.slot_for(requested.0) else {
            return WebResourceResolution::NotFound;
        };
        if self.phases[slot] != StagePhase::Offered {
            return WebResourceResolution::NotFound;
        }
        let stage = self.stages[slot].as_ref().expect("retained slot");
        match self
            .supervisor
            .browser_stage_resource(stage.actual_stage, requested.1)
        {
            Ok(Some(body)) => WebResourceResolution::Found(WebResourceBody::Stage(body)),
            Ok(None) => WebResourceResolution::NotFound,
            Err(_) => WebResourceResolution::Unavailable,
        }
    }

    /// Retries use the original supervisor and stage IDs. A possible browser
    /// owner blocks shutdown even after source errors or failed HTTP delivery.
    pub fn try_shutdown(
        &mut self,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<bool, OwnerError> {
        self.coordinator.stop()?;
        self.retire_unprotected();
        self.recover_final()?;
        // Replacement cleanup must progress on shutdown retries even while
        // the old exact browser remains protected and possibly executing.
        self.retire_pending()?;
        if self.protected.is_some() || self.coordinator.snapshot().owner_key.is_some() {
            return Ok(false);
        }
        if self.stages.iter().any(Option::is_some) {
            return Ok(false);
        }
        let done = self.supervisor.try_shutdown()?;
        // Cleanup does not silently consume any pending source observations.
        if !done {
            if let Some(event) = self.supervisor.poll()? {
                self.observe_source(event, observe);
            }
        }
        Ok(done)
    }

    fn recover_final(&mut self) -> Result<(), OwnerError> {
        let Some(ticket) = &self.unresolved_final else {
            return Ok(());
        };
        match self.ledger.commit_retained_final(ticket) {
            Ok(bytes) => {
                drop(bytes);
                self.unresolved_final = None;
            }
            Err(ControlError::NotExecuting) => {
                self.ledger.mark_uncertain(
                    ticket,
                    ErrorFact::new(
                        "ERR_CANCELLED",
                        "control mutation completed without retained final; never re-execute",
                    )?,
                )?;
                self.unresolved_final = None;
            }
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn slot_for(&self, site_id: WireU64) -> Option<usize> {
        self.stages.iter().position(|stage| {
            stage
                .as_ref()
                .is_some_and(|stage| stage.ticket.site_id() == site_id)
        })
    }

    fn retire_unprotected(&mut self) {
        for slot in 0..2 {
            if let Some(stage) = &self.stages[slot] {
                if !self.is_protected(stage) {
                    self.phases[slot] = StagePhase::Retiring;
                }
            }
        }
    }

    fn retire_pending(&mut self) -> Result<(), OwnerError> {
        for slot in 0..2 {
            if self.phases[slot] == StagePhase::Retiring {
                let stage = self.stages[slot].as_ref().expect("retiring slot");
                if self.is_protected(stage) {
                    continue;
                }
                if self.supervisor.retire_browser_stage(stage.actual_stage)? {
                    self.stages[slot] = None;
                    self.phases[slot] = StagePhase::Empty;
                }
            }
        }
        Ok(())
    }

    fn is_protected(&self, stage: &RetainedStageBinding) -> bool {
        // Either identity match conservatively retains a slot even if an
        // internal metadata invariant is broken. HTTP cannot edit these fields.
        self.protected.as_ref().is_some_and(|owner| {
            owner.actual_stage == stage.actual_stage || owner.site_id == stage.ticket.site_id()
        })
    }

    fn fail_stage(
        &mut self,
        slot: usize,
        code: &str,
        message: &str,
        observe: &mut impl FnMut(OwnerObservation),
    ) {
        let stage = self.stages[slot].as_ref().expect("failed stage slot");
        if let Err(error) = self.coordinator.fail_stage(&stage.ticket, code, message) {
            observe(OwnerObservation::Coordination(error));
        }
        self.phases[slot] = StagePhase::Retiring;
    }

    fn source_failed(&mut self, observe: &mut impl FnMut(OwnerObservation)) {
        if let Err(error) = self.coordinator.source_error(
            "SOURCE_OBSERVATION_FAILED",
            "source observation changed or failed; new publication is revoked",
        ) {
            observe(OwnerObservation::Coordination(error));
        }
        self.retire_unprotected();
    }

    fn invalidate(&mut self, observe: &mut impl FnMut(OwnerObservation)) {
        if let Err(error) = self.coordinator.source_building() {
            observe(OwnerObservation::Coordination(error));
        }
        self.retire_unprotected();
    }

    fn observe_source(&mut self, event: DevEvent, observe: &mut impl FnMut(OwnerObservation)) {
        match &event {
            DevEvent::BuildStarted => self.invalidate(observe),
            DevEvent::PortableReady { report, .. } => {
                self.invalidate(observe);
                self.source_probe = Some(report.clone());
            }
            DevEvent::Diagnostic(_) | DevEvent::Exited(_) => {
                self.source_failed(observe);
            }
            _ => {}
        }
        observe(OwnerObservation::Source(Box::new(event)));
    }

    fn fresh(
        &mut self,
        report: &PortablePackReport,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<PublicationApproval, OwnerError> {
        let check = self.supervisor.check_portable_publication(report);
        let clean = check.authorized && check.events.is_empty();
        let approval = PublicationApproval::from_supervisor_check(
            report,
            self.coordinator.control_revision(),
            &check,
        );
        if !clean {
            self.invalidate(observe);
        }
        for event in check.events {
            self.observe_source(event, observe);
        }
        Ok(approval?)
    }
}

#[cfg(all(test, unix))]
#[path = "browser_dev_owner_live_tests.rs"]
mod live_tests;
