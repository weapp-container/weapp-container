//! Opt-in native owner delivery boundary. The eventloop candidate derives its
//! witness from NativeSession accepted presentation; isolated runtime tests
//! still use synthetic witnesses and cannot prove a native surface ACK.
//! Every returned effects batch is already applied and must be journaled once,
//! including on error; dispatching it again would repeat irreversible effects.
use container_bridge::{BridgeBatch, BridgeError, BridgeErrorCode};
use container_core::ConformanceGuestObservation as Observation;
use container_runtime::{
    ConformanceGuestTurn, ConformanceInvocation, ConformancePageBinding, Session,
};
use serde_json::Value;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::thread::{self, ThreadId};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_OWNERS: usize = 1024;

/// Preserve the existing IPC distinction between a number and a string id.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RequestId {
    Number(u64),
    Text(String),
}

#[derive(Clone, Debug)]
pub struct DeliveryPermit {
    owner: Arc<()>,
    index: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Reserved,
    Pending,
    Ready,
    Unknown,   // Permanently retired: no retry or re-Begin.
    InFlight,  // Terminal consumed; immutable frame enqueued, not yet delivered.
    Delivered, // Complete frame written within its retained transport deadline.
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PollStatus {
    Pending,
    Terminal,
}

/// The owner reserves a new action and next pump before invoking a method.
/// It cannot relax that barrier while awaiting the Promise or presentation.
#[derive(Clone, Copy, Debug)]
pub struct DeliveryBarrier {
    pub action_sequence: u64,
    pub required_pump_sequence: u64,
}

/// Future native integration must construct this from the current accepted
/// frame on the owner thread, rather than deserialize it from a client claim.
#[derive(Clone, Debug)]
pub struct PresentationWitness {
    pub page_id: u64,
    pub route: String,
    pub template_revision: u64,
    pub consumed_template_revision: u64,
    pub frame_id: u64,
    pub render_revision: u64,
    pub acknowledged_revision: u64,
    pub action_sequence: u64,
    pub owner_pump_sequence: u64,
    pub required_pump_sequence: u64,
    pub presented: bool,
}

impl PresentationWitness {
    fn verify(
        &self,
        binding: &ConformancePageBinding,
        barrier: DeliveryBarrier,
        session: &Session,
    ) -> Result<(), BridgeError> {
        if self.page_id != binding.page_id().0
            || self.route != binding.route()
            || self.template_revision != session.view().template_revision
            || self.consumed_template_revision != self.template_revision
            || self.frame_id == 0
            || self.render_revision == 0
            || self.acknowledged_revision != self.render_revision
            || self.action_sequence != barrier.action_sequence
            || self.required_pump_sequence != barrier.required_pump_sequence
            || self.owner_pump_sequence < barrier.required_pump_sequence
            || !self.presented
        {
            return Err(cancelled(
                "method result has no matching current owner presentation witness",
            ));
        }
        Ok(())
    }
}

struct Record {
    source_invocation_id: String,
    binding: ConformancePageBinding,
    deadline_ns: u64,
    barrier: DeliveryBarrier,
    phase: Phase,
    invocation: Option<ConformanceInvocation>,
    terminal: Option<Observation>,
    output_ticket: Option<u64>,
}

pub struct DeliveryLedger {
    owner: Arc<()>,
    owner_thread: ThreadId,
    request_ids: BTreeSet<RequestId>,
    source_ids: BTreeSet<String>,
    records: Vec<Record>,
}

impl Default for DeliveryLedger {
    fn default() -> Self {
        Self {
            owner: Arc::new(()),
            owner_thread: thread::current().id(),
            request_ids: BTreeSet::new(),
            source_ids: BTreeSet::new(),
            records: Vec::new(),
        }
    }
}

fn invalid(message: &str) -> BridgeError {
    BridgeError::invalid(message)
}

fn cancelled(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

fn deadline(deadline_ns: u64) -> Result<(), BridgeError> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_nanos()).ok())
        .unwrap_or(u64::MAX);
    if deadline_ns <= now {
        Err(BridgeError::new(
            BridgeErrorCode::Timeout,
            "method delivery exceeded its original absolute deadline",
        ))
    } else {
        Ok(())
    }
}

fn empty_turn<T>(error: BridgeError) -> ConformanceGuestTurn<T> {
    ConformanceGuestTurn {
        result: Err(error),
        effects: BridgeBatch::new(vec![]),
    }
}

impl DeliveryLedger {
    fn on_owner_thread(&self) -> Result<(), BridgeError> {
        if self.owner_thread != thread::current().id() {
            Err(cancelled(
                "method delivery is bound to its native owner thread",
            ))
        } else {
            Ok(())
        }
    }

    /// Permanently reserve both identities before any Session Begin/getter/VM.
    /// Rejected aliases consume their fresh IPC id too, within the same cap.
    /// A fresh IPC id never permits retrying an existing source invocation.
    pub fn reserve(
        &mut self,
        request_id: RequestId,
        source_invocation_id: &str,
        binding: &ConformancePageBinding,
        deadline_ns: u64,
        barrier: DeliveryBarrier,
    ) -> Result<DeliveryPermit, BridgeError> {
        self.on_owner_thread()?;
        if source_invocation_id.is_empty()
            || source_invocation_id.len() > 128
            || matches!(&request_id, RequestId::Text(value) if value.is_empty() || value.len() > 128)
            || barrier.action_sequence == 0
            || barrier.required_pump_sequence == 0
        {
            return Err(invalid("method delivery owner exceeds its input domain"));
        }
        if self.request_ids.len() >= MAX_OWNERS || !self.request_ids.insert(request_id) {
            return Err(invalid("method IPC id reused or delivery ledger exhausted"));
        }
        if !self.source_ids.insert(source_invocation_id.into()) {
            return Err(invalid(
                "source invocation id cannot be retried with another IPC id",
            ));
        }
        let index = self.records.len();
        self.records.push(Record {
            source_invocation_id: source_invocation_id.into(),
            binding: binding.clone(),
            deadline_ns,
            barrier,
            phase: Phase::Reserved,
            invocation: None,
            terminal: None,
            output_ticket: None,
        });
        Ok(DeliveryPermit {
            owner: self.owner.clone(),
            index,
        })
    }

    fn record(&mut self, permit: &DeliveryPermit) -> Result<&mut Record, BridgeError> {
        self.on_owner_thread()?;
        if !Arc::ptr_eq(&self.owner, &permit.owner) {
            return Err(cancelled(
                "method delivery permit belongs to another native owner",
            ));
        }
        self.records
            .get_mut(permit.index)
            .ok_or_else(|| cancelled("method delivery owner is unavailable"))
    }

    pub fn phase(&mut self, permit: &DeliveryPermit) -> Result<Phase, BridgeError> {
        self.record(permit).map(|record| record.phase)
    }

    /// A terminal Poll requires a fresh owner pump after its consumed effects.
    /// This can only strengthen the original barrier; it never renews time or
    /// changes the reserved action/receiver/activation/source owner.
    pub fn advance_presentation_barrier(
        &mut self,
        permit: &DeliveryPermit,
        required_pump_sequence: u64,
    ) -> Result<(), BridgeError> {
        let record = self.record(permit)?;
        if record.phase != Phase::Ready
            || required_pump_sequence <= record.barrier.required_pump_sequence
        {
            return Err(invalid(
                "terminal presentation barrier can only advance a ready owner",
            ));
        }
        record.barrier.required_pump_sequence = required_pump_sequence;
        Ok(())
    }

    /// Retire native observation only. Already committed guest work is not
    /// cancelled or rolled back. No abandoned source owner can be reserved again.
    pub fn abandon(&mut self, permit: &DeliveryPermit) -> Result<(), BridgeError> {
        let record = self.record(permit)?;
        if matches!(record.phase, Phase::Delivered | Phase::InFlight) {
            return Err(cancelled("delivered owner cannot be abandoned or revived"));
        }
        record.phase = Phase::Unknown;
        Ok(())
    }

    /// Only this path can stage an opaque invocation. It calls the real
    /// Session method once, so a client cannot supply a fabricated terminal.
    /// The deadline is a delivery fence, not native V8 guest preemption.
    pub fn begin(
        &mut self,
        permit: &DeliveryPermit,
        session: &mut Session,
        method: &str,
        args: Vec<Value>,
    ) -> ConformanceGuestTurn<()> {
        let record = match self.record(permit) {
            Ok(record) if record.phase == Phase::Reserved => record,
            Ok(_) => return empty_turn(cancelled("method delivery begin was already attempted")),
            Err(error) => return empty_turn(error),
        };
        record.phase = Phase::Unknown;
        if let Err(error) = deadline(record.deadline_ns) {
            return empty_turn(error);
        }
        let turn = session.begin_conformance_guest(
            &record.binding,
            &record.source_invocation_id,
            method,
            args,
        );
        let result = turn.result.and_then(|invocation| {
            record.invocation = Some(invocation);
            deadline(record.deadline_ns)?;
            record.phase = Phase::Pending;
            Ok(())
        });
        ConformanceGuestTurn {
            result,
            effects: turn.effects,
        }
    }

    /// Pending polls reuse the same opaque Session invocation; they never
    /// call Begin again. A terminal is privately retained for one write.
    pub fn poll(
        &mut self,
        permit: &DeliveryPermit,
        session: &mut Session,
    ) -> ConformanceGuestTurn<PollStatus> {
        let record = match self.record(permit) {
            Ok(record) if record.phase == Phase::Pending => record,
            Ok(_) => return empty_turn(cancelled("method delivery invocation cannot be polled")),
            Err(error) => return empty_turn(error),
        };
        record.phase = Phase::Unknown;
        if let Err(error) = deadline(record.deadline_ns) {
            return empty_turn(error);
        }
        let invocation = record
            .invocation
            .as_ref()
            .expect("Pending has an opaque invocation");
        let turn = session.poll_conformance_guest(invocation);
        let result = turn.result.and_then(|observation| {
            let status = match observation {
                Observation::Pending { .. } => PollStatus::Pending,
                Observation::Fulfilled { .. }
                | Observation::Threw { .. }
                | Observation::Rejected { .. }
                | Observation::SerializationFailed { .. }
                | Observation::Unsupported { .. }
                | Observation::Revoked { .. }
                | Observation::Cancelled { .. } => {
                    record.terminal = Some(observation);
                    PollStatus::Terminal
                }
                _ => return Err(invalid("Session poll returned a non-result observation")),
            };
            deadline(record.deadline_ns)?;
            record.phase = match status {
                PollStatus::Pending => Phase::Pending,
                PollStatus::Terminal => Phase::Ready,
            };
            Ok(status)
        });
        ConformanceGuestTurn {
            result,
            effects: turn.effects,
        }
    }

    /// The consumed terminal is authorized on the runtime owner immediately
    /// before enqueue. No runtime reference crosses into the stdout worker.
    /// This retires the permit on every error, and enqueue is NOT delivery.
    pub fn enqueue_if_current(
        &mut self,
        permit: &DeliveryPermit,
        session: &mut Session,
        witness: &PresentationWitness,
        enqueue: impl FnOnce(&Observation) -> Result<u64, String>,
    ) -> Result<u64, BridgeError> {
        let record = self.record(permit)?;
        if record.phase != Phase::Ready {
            return Err(cancelled(
                "method terminal is not an unclaimed consumed result",
            ));
        }
        record.phase = Phase::Unknown;
        witness.verify(&record.binding, record.barrier, session)?;
        session.validate_conformance_binding(&record.binding, record.deadline_ns)?;
        let terminal = record
            .terminal
            .as_ref()
            .ok_or_else(|| invalid("consumed terminal unavailable"))?;
        let ticket = enqueue(terminal)
            .map_err(|error| cancelled(&format!("method frame was not enqueued: {error}")))?;
        if self
            .records
            .iter()
            .any(|record| record.output_ticket == Some(ticket))
        {
            return Err(cancelled("stdout ticket reused across method owners"));
        }
        let record = self.record(permit)?;
        record.output_ticket = Some(ticket);
        record.phase = Phase::InFlight;
        Ok(ticket)
    }

    /// Completion is an internal single-writer receipt, not an IPC field.
    /// It changes no guest state and never validates or revives a receiver.
    /// The frame's authorization point was the owner enqueue; bytes cannot be
    /// rolled back after partial output. Failed output permanently retires it.
    pub fn complete_output(
        &mut self,
        ticket: u64,
        full_written: bool,
    ) -> Result<Option<String>, BridgeError> {
        self.on_owner_thread()?;
        let Some(record) = self
            .records
            .iter_mut()
            .find(|record| record.output_ticket == Some(ticket))
        else {
            return Ok(None);
        };
        if record.phase != Phase::InFlight {
            return Err(cancelled("method output completion was already consumed"));
        }
        record.phase = if full_written {
            Phase::Delivered
        } else {
            Phase::Unknown
        };
        Ok(Some(record.source_invocation_id.clone()))
    }

    /// Unknown is committed before validation and before entering the writer.
    /// Failure/panic/partial write cannot revive the owner. The synchronous
    /// closure has no Session parameter, and safe Rust cannot borrow this same
    /// &mut Session again in it. Future integration must not await/pump here.
    pub fn emit_if_current(
        &mut self,
        permit: &DeliveryPermit,
        session: &mut Session,
        witness: &PresentationWitness,
        writer: impl FnOnce(&Observation) -> Result<(), String>,
    ) -> Result<(), BridgeError> {
        let record = self.record(permit)?;
        if record.phase != Phase::Ready {
            return Err(cancelled(
                "method result is pending, consumed, delivered or unknown",
            ));
        }
        record.phase = Phase::Unknown;
        witness.verify(&record.binding, record.barrier, session)?;
        session.validate_conformance_binding(&record.binding, record.deadline_ns)?;
        let terminal = record
            .terminal
            .as_ref()
            .ok_or_else(|| invalid("ready owner has no actual consumed terminal"))?;
        writer(terminal).map_err(|message| {
            BridgeError::new(
                BridgeErrorCode::Engine,
                format!("native method result write failed: {message}"),
            )
        })?;
        // A slow/partial writer cannot be rolled back. Do not report a timely
        // delivery after it returns outside the original deadline; Unknown
        // still prevents retransmission of bytes it may already have written.
        deadline(record.deadline_ns)?;
        record.phase = Phase::Delivered;
        Ok(())
    }
}
