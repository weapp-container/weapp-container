//! One borrowed, serial control lane over the original development owners.
//! This does not create a supervisor, ledger, stage store or browser. The
//! integrating owner must retain these same objects through cleanup retries.

use crate::browser_dev_control::{
    BrowserCloseReport, ControlError, ControlLedger, ControlLookup, ControlOperation,
    ControlResult, ErrorFact, ExecutionTicket, FinalDraft, FinalOutcome,
};
use crate::browser_dev_coordinator::{
    ActivationBinding, BrowserDevCoordinator, CloseTicket, CoordinatorError, OwnerKey, OwnerTuple,
    PreviewLease, PublicationApproval, StageTicket, TransportBackend, WireU64,
};
use crate::dev::{BrowserStageId, DevEvent, DevSupervisor, PortablePackReport};

/// Metadata only. Actual stage bytes, borrowers and charges remain on the
/// original supervisor. The integrating owner retains at most two bindings.
pub(crate) struct RetainedStageBinding {
    pub(crate) actual_stage: BrowserStageId,
    pub(crate) ticket: StageTicket,
}

/// Recorded before a successful start final can leave the original ledger.
/// Starting and never-constructed wrappers protect their original stage too.
pub(crate) struct ProtectedOwner {
    pub(crate) key: OwnerKey,
    pub(crate) site_id: WireU64,
    pub(crate) actual_stage: BrowserStageId,
    registration: RegisteredBrowserOwner,
}

/// Original server-side metadata, captured before the start final can leave.
/// This is not another resource owner or a browser-supplied identity registry.
struct RegisteredBrowserOwner {
    client_id: String,
    binding: ActivationBinding,
    transport_backend: TransportBackend,
}

/// The caller must correlate the elected manager's registered wrapper and
/// actual close barrier. A shape-valid HTTP report alone grants no success.
pub(crate) trait ExactCloseBarrier {
    fn correlate(
        &mut self,
        ticket: &CloseTicket,
        report: &BrowserCloseReport,
        protected: &ProtectedOwner,
    ) -> Result<bool, ErrorFact>;
}

/// No actual browser closure has been connected to this owner yet. Neither
/// `closed` nor `never-constructed` reports can unlock the protected stage.
pub(crate) struct NoActualBrowser;

impl ExactCloseBarrier for NoActualBrowser {
    fn correlate(
        &mut self,
        _ticket: &CloseTicket,
        report: &BrowserCloseReport,
        _protected: &ProtectedOwner,
    ) -> Result<bool, ErrorFact> {
        if report.success {
            Err(fact(
                "ERR_UNSUPPORTED_CAPABILITY",
                "actual exact browser close barrier is not wired",
            ))
        } else {
            Ok(false)
        }
    }
}

/// Explicit trusted-startup policy. A successful result means only that the
/// elected manager's browser-reported close matches its original registration.
/// Actual Worker termination remains a separate browser evidence requirement.
pub(crate) struct BrowserReportedClose<'a> {
    pub(crate) run_id: &'a str,
    pub(crate) client_id: &'a str,
    pub(crate) preview: &'a PreviewLease,
    pub(crate) runtime_owner: Option<&'a OwnerTuple>,
}

impl BrowserReportedClose<'_> {
    fn correlate_registration(
        &self,
        ticket: &CloseTicket,
        report: &BrowserCloseReport,
        key: &OwnerKey,
        registration: &RegisteredBrowserOwner,
    ) -> Result<bool, ErrorFact> {
        let binding = &registration.binding;
        if registration.client_id != self.client_id
            || binding.run_id != self.run_id
            || self.preview.run_id != self.run_id
            || binding.version != "1.0"
            || ticket.version != "1.0"
            || &binding.preview != self.preview
            || &ticket.preview != self.preview
            || &ticket.owner != key
            || key.activation_id != binding.activation_id
        {
            return Err(fact(
                "ERR_PERMISSION_DENIED",
                "browser close differs from the trusted registered owner",
            ));
        }
        if !report.success {
            return Ok(false);
        }
        if report.pending_actual || report.owner_key.as_ref() != Some(key) || report.error.is_some()
        {
            return Err(fact("ERR_PROTOCOL_VERSION", "browser close is not final"));
        }
        match report.outcome.as_deref() {
            Some("never-constructed") => {
                if self.runtime_owner.is_some()
                    || report.receipt.is_some()
                    || report.worker_closed != Some(true)
                    || report.owned_mount_removed != Some(true)
                {
                    return Err(fact(
                        "ERR_PROTOCOL_VERSION",
                        "known runtime cannot close as never constructed",
                    ));
                }
            }
            Some("closed") => {
                let receipt = report.receipt.as_ref().ok_or_else(|| {
                    fact("ERR_PROTOCOL_VERSION", "browser close receipt is missing")
                })?;
                if receipt.version != "1.0"
                    || !receipt.closed
                    || !receipt.worker_closed
                    || !receipt.owned_mount_removed
                {
                    return Err(fact(
                        "ERR_PROTOCOL_VERSION",
                        "browser wrapper cleanup is incomplete",
                    ));
                }
                if let Some(rpc) = &receipt.rpc_identity {
                    rpc.validate().map_err(coordinator_fact)?;
                    if !receipt
                        .worker_final
                        .as_ref()
                        .and_then(serde_json::Value::as_object)
                        .is_some_and(|value| {
                            value.get("closed") == Some(&serde_json::Value::Bool(true))
                        })
                    {
                        return Err(fact(
                            "ERR_PROTOCOL_VERSION",
                            "allocated RPC has no actual close final",
                        ));
                    }
                } else if receipt.owner.is_some() || receipt.worker_final.is_some() {
                    return Err(fact(
                        "ERR_PROTOCOL_VERSION",
                        "browser close omitted its allocated RPC identity",
                    ));
                }
                if let Some(owner) = &receipt.owner {
                    owner.validate().map_err(coordinator_fact)?;
                    if owner.pack_sha256 != binding.index_sha256
                        || owner.transport_backend != registration.transport_backend
                        || !receipt.rpc_identity.as_ref().is_some_and(|rpc| {
                            rpc.worker_epoch == owner.worker_epoch
                                && rpc.session_id == owner.session_id
                        })
                    {
                        return Err(fact(
                            "ERR_PROTOCOL_VERSION",
                            "browser close tuple differs from its original site or RPC",
                        ));
                    }
                }
                if self
                    .runtime_owner
                    .is_some_and(|known| receipt.owner.as_ref() != Some(known))
                {
                    return Err(fact(
                        "ERR_PROTOCOL_VERSION",
                        "browser close differs from the recorded runtime tuple",
                    ));
                }
                // Without a recorded runtime receipt, the same manager may
                // report a pre-admission RPC (or a wrapper never loaded). Do
                // not manufacture a runtimeReady receipt to accept cleanup.
            }
            _ => {
                return Err(fact(
                    "ERR_PROTOCOL_VERSION",
                    "browser close outcome is unsupported",
                ));
            }
        }
        Ok(true)
    }
}

impl ExactCloseBarrier for BrowserReportedClose<'_> {
    fn correlate(
        &mut self,
        ticket: &CloseTicket,
        report: &BrowserCloseReport,
        protected: &ProtectedOwner,
    ) -> Result<bool, ErrorFact> {
        if protected.site_id != protected.registration.binding.site_id {
            return Err(fact(
                "ERR_CANCELLED",
                "browser close has no exact protected site registration",
            ));
        }
        self.correlate_registration(ticket, report, &protected.key, &protected.registration)
    }
}

/// Deliver through the existing owner's source/diagnostic pipeline. In
/// particular, do not recursively stage a PortableReady during a command.
pub enum OwnerObservation {
    Source(Box<DevEvent>),
    Coordination(CoordinatorError),
}

#[derive(Debug)]
pub(crate) enum InvokeFailure {
    Ledger(ControlError),
    /// Mutation may already have happened. Preserve this exact ticket, try
    /// commit_retained_final on the original ledger, then retain uncertainty
    /// if needed. Never decode and execute the operation a second time.
    FinalNotRetained {
        ticket: Box<ExecutionTicket>,
        error: ControlError,
    },
}

impl From<ControlError> for InvokeFailure {
    fn from(error: ControlError) -> Self {
        Self::Ledger(error)
    }
}

pub(crate) struct SerialControlLane<'a> {
    pub(crate) supervisor: &'a mut DevSupervisor,
    pub(crate) coordinator: &'a mut BrowserDevCoordinator,
    pub(crate) ledger: &'a mut ControlLedger,
    pub(crate) stages: &'a [Option<RetainedStageBinding>; 2],
    pub(crate) protected: &'a mut Option<ProtectedOwner>,
    /// Latest actual PortableReady metadata, never a copied resource owner.
    pub(crate) source_probe: Option<&'a PortablePackReport>,
    /// Latched authenticated run, retained after the supervisor stops.
    pub(crate) run_id: &'a str,
    pub(crate) client_id: &'a str,
}

impl SerialControlLane<'_> {
    pub(crate) fn replay(&self, bytes: &[u8]) -> Result<ControlLookup, ControlError> {
        self.ledger.lookup(self.run_id, bytes)
    }

    pub(crate) fn invoke(
        &mut self,
        bytes: &[u8],
        close: &mut impl ExactCloseBarrier,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<ControlLookup, InvokeFailure> {
        let admitted = self.ledger.admit(self.run_id, bytes)?;
        let ControlLookup::Queued(queued) = admitted else {
            return Ok(admitted);
        };
        // This lane is synchronous. Splitting it across an await would need
        // original-ledger queued cancellation/deadline handling first.
        let begun = self.ledger.begin(&queued.identity)?;
        let outcome = match self.execute(begun.operation, close, observe) {
            Ok(result) => FinalOutcome::Ok(Box::new(result)),
            Err(error) => FinalOutcome::Error(error),
        };
        let draft = FinalDraft {
            snapshot: self.coordinator.snapshot(),
            outcome,
        };
        match self.ledger.finish(&begun.ticket, draft) {
            Ok(bytes) => Ok(ControlLookup::Final(bytes)),
            Err(error) => Err(InvokeFailure::FinalNotRetained {
                ticket: Box::new(begun.ticket),
                error,
            }),
        }
    }

    fn execute(
        &mut self,
        operation: ControlOperation,
        close: &mut impl ExactCloseBarrier,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<ControlResult, ErrorFact> {
        use ControlOperation as Op;
        match operation {
            Op::Snapshot(_) => Ok(ControlResult::Snapshot(Box::new(
                self.coordinator.snapshot(),
            ))),
            Op::IssueActivation(value) => {
                let approval =
                    self.fresh_for_site(value.site_id, value.expected_control_revision, observe)?;
                self.coordinator
                    .issue_activation(&value.preview, value.site_id, approval)
                    .map(ControlResult::IssueActivation)
                    .map_err(coordinator_fact)
            }
            Op::BeginActivation(value) => {
                self.fresh_for_site(
                    value.permit.binding.site_id,
                    self.coordinator.control_revision(),
                    observe,
                )?;
                self.coordinator
                    .begin_activation(value.permit)
                    .map(ControlResult::BeginActivation)
                    .map_err(coordinator_fact)
            }
            Op::StartOwner(value) => {
                // Check metadata capacity/binding BEFORE the mutation. Once
                // start_owner succeeds, recording protection cannot fail.
                if self.protected.is_some() {
                    return Err(fact(
                        "ERR_CANCELLED",
                        "an exact browser owner still protects its stage",
                    ));
                }
                let site_id = value.ticket.binding.site_id;
                let actual_stage = self
                    .stages
                    .iter()
                    .flatten()
                    .find(|binding| binding.ticket.site_id() == site_id)
                    .map(|binding| binding.actual_stage)
                    .ok_or_else(|| {
                        fact("ERR_CANCELLED", "site has no retained actual stage binding")
                    })?;
                self.fresh_for_site(site_id, self.coordinator.control_revision(), observe)?;
                let site = self
                    .coordinator
                    .snapshot()
                    .offered_site
                    .filter(|site| site.site_id == site_id)
                    .ok_or_else(|| fact("ERR_CANCELLED", "start has no original offered site"))?;
                let permit = self
                    .coordinator
                    .start_owner(value.ticket, value.client_owner_id)
                    .map_err(coordinator_fact)?;
                *self.protected = Some(ProtectedOwner {
                    key: permit.owner.clone(),
                    site_id,
                    actual_stage,
                    registration: RegisteredBrowserOwner {
                        client_id: self.client_id.to_owned(),
                        binding: permit.binding.clone(),
                        transport_backend: site.transport_backend,
                    },
                });
                // Protection exists even if final serialization/delivery fails.
                Ok(ControlResult::StartOwner(permit))
            }
            Op::FinishClose(value) => {
                // Source failure revokes new authority, but cannot stop exact
                // old cleanup. This observation deliberately has no `?`.
                self.observe_before_close(observe);
                let protected = self
                    .protected
                    .as_ref()
                    .filter(|protected| protected.key == value.ticket.owner)
                    .ok_or_else(|| {
                        fact(
                            "ERR_CANCELLED",
                            "close has no exact protected browser owner",
                        )
                    })?;
                let success = close.correlate(&value.ticket, &value.close_final, protected)?;
                if success && !value.close_final.success {
                    return Err(fact(
                        "ERR_PROTOCOL_VERSION",
                        "failed browser report cannot become a successful close",
                    ));
                }
                let next = self
                    .coordinator
                    .finish_close(&value.ticket, success)
                    .map_err(coordinator_fact)?;
                if success {
                    // Only this exact successful coordinator transition can
                    // relinquish protection. Retirement/drain stays on owner.
                    *self.protected = None;
                }
                Ok(ControlResult::FinishClose(next))
            }
            Op::CancelActivation(value) => self
                .coordinator
                .cancel_activation(&value.preview, &value.permit)
                .map(|()| ControlResult::Unit)
                .map_err(coordinator_fact),
            Op::AbandonStart(value) => self
                .coordinator
                .abandon_start(&value.ticket)
                .map(|()| ControlResult::Unit)
                .map_err(coordinator_fact),
            Op::FailOwner(value) => self
                .coordinator
                .fail_owner(&value.owner_key, &value.message)
                .map(ControlResult::FailOwner)
                .map_err(coordinator_fact),
            Op::RuntimeReady(value) => self
                .coordinator
                .runtime_ready(value)
                .map(|()| ControlResult::Unit)
                .map_err(coordinator_fact),
            Op::PresentedReady(value) => self
                .coordinator
                .presented_ready(value)
                .map(|()| ControlResult::Unit)
                .map_err(coordinator_fact),
            Op::RetryClose(value) => self
                .coordinator
                .retry_close(
                    &value.preview,
                    value.expected_control_revision,
                    value.expected_terminal_cleanup_revision,
                )
                .map(ControlResult::RetryClose)
                .map_err(coordinator_fact),
            Op::Stop(_) => self
                .coordinator
                .stop()
                .map(ControlResult::Stop)
                .map_err(coordinator_fact),
        }
    }

    fn fresh_for_site(
        &mut self,
        site_id: WireU64,
        expected: WireU64,
        observe: &mut impl FnMut(OwnerObservation),
    ) -> Result<PublicationApproval, ErrorFact> {
        let report = self
            .stages
            .iter()
            .flatten()
            .find(|binding| binding.ticket.site_id() == site_id)
            .map(|binding| binding.ticket.pack_report().clone())
            .ok_or_else(|| fact("ERR_CANCELLED", "site has no retained actual stage binding"))?;
        let check = self.supervisor.check_portable_publication(&report);
        let clean = check.authorized && check.events.is_empty();
        // Pass the original check; draining its events before approval could
        // falsely authorize a stale stage. A clean check invokes no callback.
        let approval = PublicationApproval::from_supervisor_check(&report, expected, &check);
        self.deliver_source_check(check.events, clean, observe);
        approval.map_err(coordinator_fact)
    }

    fn observe_before_close(&mut self, observe: &mut impl FnMut(OwnerObservation)) {
        if let Some(report) = self.source_probe {
            let check = self.supervisor.check_portable_publication(report);
            let clean = check.authorized && check.events.is_empty();
            self.deliver_source_check(check.events, clean, observe);
        } else if let Err(error) = self.coordinator.source_building() {
            // Missing metadata cannot authorize a replacement, but must not
            // strand the old owner behind a source-observation failure.
            observe(OwnerObservation::Coordination(error));
        }
    }

    fn deliver_source_check(
        &mut self,
        events: Vec<DevEvent>,
        clean: bool,
        observe: &mut impl FnMut(OwnerObservation),
    ) {
        if !clean {
            let invalidation = if events
                .iter()
                .any(|event| matches!(event, DevEvent::Diagnostic(_) | DevEvent::Exited(_)))
            {
                self.coordinator.source_error(
                    "SOURCE_OBSERVATION_FAILED",
                    "source observation changed or failed; new publication is revoked",
                )
            } else {
                self.coordinator.source_building()
            };
            if let Err(error) = invalidation {
                observe(OwnerObservation::Coordination(error));
            }
        }
        for event in events {
            observe(OwnerObservation::Source(Box::new(event)));
        }
    }
}

fn fact(code: &str, message: &str) -> ErrorFact {
    // Only fixed, bounded literals from this module reach this helper.
    ErrorFact::new(code, message).expect("fixed bounded owner control error")
}

fn coordinator_fact(error: CoordinatorError) -> ErrorFact {
    match error {
        CoordinatorError::Invalid(_) => fact(
            "ERR_PROTOCOL_VERSION",
            "coordinator rejected the operation shape",
        ),
        CoordinatorError::Unauthorized => {
            fact("ERR_PERMISSION_DENIED", "publication is not authorized")
        }
        CoordinatorError::CloseUncertain => fact(
            "ERR_RENDER",
            "exact previous owner close remains unresolved",
        ),
        CoordinatorError::Stale(_) | CoordinatorError::Busy | CoordinatorError::Stopped => fact(
            "ERR_CANCELLED",
            "coordinator operation is stale, busy or stopped",
        ),
    }
}

#[cfg(test)]
#[path = "browser_dev_control_lane_tests.rs"]
mod tests;
