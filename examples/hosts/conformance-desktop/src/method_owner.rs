//! Internal source-labelled method ownership on the actual NativeSession.
//! Source metadata is a caller declaration; it is not an official SDK oracle.
use super::*;
use crate::method_delivery::{
    DeliveryBarrier, DeliveryPermit, PollStatus, PresentationWitness, RequestId,
};
use container_runtime::ConformancePageBinding;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) struct PendingMethod {
    id: Value,
    source_invocation_id: String,
    source_declaration: Value,
    request_sha256: String,
    binding: ConformancePageBinding,
    permit: DeliveryPermit,
    deadline_ns: u64,
    monotonic_deadline: Instant,
    polls: u64,
    ready: bool,
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("method.call requires nonempty {key}").into())
}

fn wall_now_ns() -> Result<u64> {
    Ok(u64::try_from(
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos(),
    )?)
}

/// Anchor before both wall samples. All time spent sampling/scheduled out is
/// charged against the original budget. A rollback observed while sampling
/// fails closed; later wall changes cannot extend the fixed Instant deadline.
fn capture_method_deadline(
    deadline_ns: u64,
    mut monotonic_now: impl FnMut() -> Instant,
    mut unix_now: impl FnMut() -> Result<u64>,
) -> Result<Instant> {
    let anchor = monotonic_now();
    let wall_before = unix_now()?;
    let wall_after = unix_now()?;
    let sampled_at = monotonic_now();
    if wall_after < wall_before {
        return Err("wall clock moved backwards while sampling method deadline".into());
    }
    let remaining = deadline_ns
        .checked_sub(wall_after)
        .filter(|remaining| *remaining > 0)
        .ok_or("original method deadline expired during clock sampling")?;
    let deadline = anchor
        .checked_add(Duration::from_nanos(remaining))
        .ok_or("method deadline is outside the monotonic clock domain")?;
    if sampled_at >= deadline {
        return Err("original method budget expired while sampling clocks".into());
    }
    Ok(deadline)
}

impl PendingMethod {
    fn evidence(&self) -> Value {
        json!({"kind":"source-labelled-native-method-owner-v1",
            "sourceInvocationId":self.source_invocation_id,
            "sourceDeclaration":self.source_declaration,
            "sourceDeclarationTrust":"caller-declared-not-official-oracle",
            "requestSha256":self.request_sha256,
            "route":self.binding.route(),"pageId":self.binding.page_id().0.to_string(),
            "receiverTokenSha256":hex_digest(self.binding.receiver_token().as_bytes()),
            "originalDeadlineNs":self.deadline_ns.to_string(),
            "deadlineClock":"original-unix-deadline-plus-once-anchored-monotonic-budget",
            "sessionBeginAttempts":1,"sessionPollAttempts":self.polls})
    }

    fn failure(&self, error: impl ToString) -> Value {
        json!({"id":self.id,"ok":false,"error":error.to_string(),"owner":self.evidence()})
    }
}

impl NativeSession {
    pub(super) fn record_method_effects(
        &mut self,
        source: &str,
        owner: &str,
        effects: BridgeBatch,
    ) {
        // These messages were already applied by the real Session turn. This
        // records them on both success and failure and never dispatches again.
        self.transcript.push(json!({"seq":self.transcript.len()+1,
            "source":source,"sourceInvocationId":owner,"effects":effects,
            "effectsAlreadyApplied":true,"effectsRedispatched":false}));
    }

    pub fn begin_method(&mut self, request: &Value) -> Result<()> {
        self.require_presented()?;
        self.assert_route(field(request, "route")?)?;
        let source_invocation_id = field(request, "sourceInvocationId")?.to_owned();
        let method = field(request, "method")?.to_owned();
        let args = request
            .get("args")
            .and_then(Value::as_array)
            .cloned()
            .ok_or("method.call requires the actual args array")?;
        let deadline_ns: u64 = field(request, "deadlineNs")?.parse()?;
        let monotonic_deadline = capture_method_deadline(deadline_ns, Instant::now, wall_now_ns)?;
        let source = request
            .get("source")
            .and_then(Value::as_object)
            .ok_or("method.call requires source declaration")?;
        let source_sha = source
            .get("sha256")
            .and_then(Value::as_str)
            .filter(|s| container_ir::is_sha256(s))
            .ok_or("method source declaration needs SHA-256")?;
        let callsite = source
            .get("callsite")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or("method source declaration needs a bounded callsite")?;
        let source_declaration = json!({"sha256":source_sha,"callsite":callsite});
        let id = request
            .get("id")
            .cloned()
            .ok_or("method.call needs IPC id")?;
        let request_id = if let Some(number) = id.as_u64() {
            RequestId::Number(number)
        } else {
            RequestId::Text(
                id.as_str()
                    .ok_or("method IPC id must be a string or u64")?
                    .into(),
            )
        };
        let route = self.route()?;
        let turn = self
            .host
            .session_mut()
            .ok_or("native session is unloaded")?
            .acquire_conformance_page(&route);
        self.record_method_effects("native-method-acquire", &source_invocation_id, turn.effects);
        let binding = turn.result?;
        let barrier = DeliveryBarrier {
            action_sequence: self
                .action_sequence
                .checked_add(1)
                .ok_or("method action sequence exhausted")?,
            required_pump_sequence: self
                .owner_pump_sequence
                .checked_add(1)
                .ok_or("method pump sequence exhausted")?,
        };
        let permit = self.method_ledger.reserve(
            request_id,
            &source_invocation_id,
            &binding,
            deadline_ns,
            barrier,
        )?;
        if self.pending_method.is_some() {
            self.method_ledger.abandon(&permit)?;
            return Err(
                "one actual guest method owner is already pending; new owner retired without Begin"
                    .into(),
            );
        }
        self.require_next_owner_pump()?;
        if Instant::now() >= monotonic_deadline {
            self.method_ledger.abandon(&permit)?;
            return Err("original method delivery budget expired before Begin".into());
        }
        let turn = self.method_ledger.begin(
            &permit,
            self.host
                .session_mut()
                .ok_or("native session is unloaded")?,
            &method,
            args,
        );
        self.record_method_effects("native-method-begin", &source_invocation_id, turn.effects);
        turn.result?;
        let pending = PendingMethod {
            id,
            source_invocation_id,
            source_declaration,
            request_sha256: hex_digest(&serde_json::to_vec(request)?),
            binding,
            permit,
            deadline_ns,
            monotonic_deadline,
            polls: 0,
            ready: false,
        };
        self.transcript.push(json!({"seq":self.transcript.len()+1,"source":"native-method-owner","owner":pending.evidence()}));
        self.pending_method = Some(pending);
        Ok(())
    }

    /// Runs before the presentation/stability gate. It never occupies the
    /// existing reLaunch/tap pending slot and never repeats the guest method.
    pub fn poll_method(&mut self) -> Result<Option<Value>> {
        let Some(mut pending) = self.pending_method.take() else {
            return Ok(None);
        };
        if Instant::now() >= pending.monotonic_deadline || pending.polls >= 65_536 {
            self.method_ledger.abandon(&pending.permit)?;
            return Ok(Some(pending.failure(
                "original method budget expired or native poll cap exhausted",
            )));
        }
        if pending.ready {
            self.pending_method = Some(pending);
            return Ok(None);
        }
        pending.polls = pending
            .polls
            .checked_add(1)
            .ok_or("native method poll count exhausted")?;
        let turn = self.method_ledger.poll(
            &pending.permit,
            self.host
                .session_mut()
                .ok_or("native session is unloaded")?,
        );
        self.record_method_effects(
            "native-method-poll",
            &pending.source_invocation_id,
            turn.effects,
        );
        match turn.result {
            Ok(PollStatus::Pending) => {}
            Ok(PollStatus::Terminal) => {
                // Always cross a real owner pump after terminal consumption,
                // including a synchronous/undefined method with no new patch.
                let required = self
                    .owner_pump_sequence
                    .checked_add(1)
                    .ok_or("terminal method pump sequence exhausted")?;
                self.required_pump_sequence = self.required_pump_sequence.max(required);
                self.method_ledger
                    .advance_presentation_barrier(&pending.permit, self.required_pump_sequence)?;
                pending.ready = true;
            }
            Err(error) => return Ok(Some(pending.failure(error))),
        }
        self.pending_method = Some(pending);
        Ok(None)
    }

    fn actual_method_witness(&self) -> Result<PresentationWitness> {
        self.require_presented()?;
        let (page_id, route, template_revision) = self.identity()?;
        let accepted = self
            .host
            .accepted_page_observation()?
            .ok_or("method has no accepted native frame")?;
        let input = self
            .host
            .session()
            .and_then(|session| session.last_frame_input(accepted.render_revision))
            .ok_or("method accepted frame has no consumed input")?;
        Ok(PresentationWitness {
            page_id,
            route,
            template_revision,
            consumed_template_revision: input.template_revision,
            frame_id: accepted.frame.frame_id,
            render_revision: accepted.render_revision,
            acknowledged_revision: self.acknowledged_revision,
            action_sequence: self.action_sequence,
            owner_pump_sequence: self.owner_pump_sequence,
            required_pump_sequence: self.required_pump_sequence,
            presented: true,
        })
    }

    /// Called after real pump/present/ACK and after any queued source operation.
    /// The callback only enqueues bytes. Full delivery is journaled separately.
    /// The witness is derived here from actual accepted native state. No IPC
    /// field is allowed to supply frame ids, revisions, readiness or ACKs.
    pub fn emit_method(
        &mut self,
        mut writer: impl FnMut(Value, Instant) -> std::result::Result<u64, String>,
    ) -> Result<()> {
        if !self
            .pending_method
            .as_ref()
            .is_some_and(|pending| pending.ready)
        {
            return Ok(());
        }
        self.require_presented()?;
        let witness = self.actual_method_witness()?;
        let completion = self.completion()?;
        let pending = self.pending_method.take().unwrap();
        if Instant::now() >= pending.monotonic_deadline {
            self.method_ledger.abandon(&pending.permit)?;
            writer(
                pending.failure("original monotonic method budget expired before delivery"),
                Instant::now() + Duration::from_millis(500),
            )?;
            return Ok(());
        }
        let mut attempted_write = false;
        let mut owner = pending.evidence();
        owner["sessionId"] = json!(self.session_id);
        owner["engine"] = json!(self.engine);
        let result=self.method_ledger.enqueue_if_current(&pending.permit,self.host.session_mut().ok_or("native session is unloaded")?,&witness,|actual|{
            if Instant::now()>=pending.monotonic_deadline {return Err("original monotonic deadline expired at final writer entry".into())}
            attempted_write=true;
            writer(json!({"id":pending.id,"ok":true,"result":{"kind":"native-guest-method-result-v1",
                "owner":owner,"observation":actual,"completion":completion}}),pending.monotonic_deadline)
        });
        self.transcript.push(
            json!({"seq":self.transcript.len()+1,"source":"native-method-enqueue",
            "sourceInvocationId":pending.source_invocation_id,"attemptedEnqueue":attempted_write,
            "enqueued":result.is_ok(),"delivered":false,"outputTicket":result.as_ref().ok(),"error":result.as_ref().err().map(ToString::to_string)}),
        );
        match result {
            Ok(_) => Ok(()),
            Err(error) if !attempted_write => {
                // Error reporting claims no result/presentation success and
                // gets a separate bounded transport budget. Never re-Begin.
                writer(
                    pending.failure(error),
                    Instant::now() + Duration::from_millis(500),
                )?;
                Ok(())
            }
            // Output may be partial. Do not emit a second response for this id;
            // the event loop exits through its owned detach/unload barrier.
            Err(error) => Err(error.into()),
        }
    }
    /// Called only on the native owner after polling the writer's private
    /// completion channel. An enqueue ticket cannot masquerade as this receipt.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub fn complete_method_output(
        &mut self,
        report: &crate::method_output::Completion,
    ) -> Result<()> {
        if let Some(source) = self
            .method_ledger
            .complete_output(report.ticket, report.result.is_ok())?
        {
            self.transcript.push(
                json!({"seq":self.transcript.len()+1,"source":"native-method-delivery",
                "sourceInvocationId":source,"outputTicket":report.ticket,
                "phase":if report.result.is_ok(){"full-written"}else{"retired"},
                "delivered":report.result.is_ok(),"bytesWritten":report.bytes_written,
                "error":report.result.as_ref().err(),"effectsRedispatched":false}),
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod clock_tests {
    use super::*;
    use std::cell::RefCell;

    fn samples(deadline: u64, elapsed: u64, walls: [u64; 2]) -> Result<(Instant, Instant)> {
        let anchor = Instant::now();
        let mut ticks = [anchor, anchor + Duration::from_nanos(elapsed)].into_iter();
        let mut walls = walls.into_iter();
        let order = RefCell::new(Vec::new());
        let result = capture_method_deadline(
            deadline,
            || {
                order.borrow_mut().push("instant");
                ticks.next().unwrap()
            },
            || {
                order.borrow_mut().push("wall");
                Ok(walls.next().unwrap())
            },
        );
        assert_eq!(*order.borrow(), ["instant", "wall", "wall", "instant"]);
        result.map(|deadline| (anchor, deadline))
    }

    #[test]
    fn scheduling_gap_is_charged_to_the_original_budget() {
        let (anchor, deadline) = samples(1_100, 60, [1_000, 1_020]).unwrap();
        // Later wall sample is used with the earlier Instant: the 60 ns gap
        // cannot shift the deadline to anchor+140 (the old ordering bug).
        assert_eq!(deadline.duration_since(anchor), Duration::from_nanos(80));
    }

    #[test]
    fn scheduling_pause_beyond_remaining_budget_fails_closed() {
        assert!(
            samples(1_100, 100, [1_000, 1_020])
                .unwrap_err()
                .to_string()
                .contains("sampling clocks")
        );
    }

    #[test]
    fn rollback_between_wall_samples_fails_closed() {
        assert!(
            samples(1_100, 1, [1_000, 900])
                .unwrap_err()
                .to_string()
                .contains("backwards")
        );
    }

    #[test]
    fn forward_or_equal_wall_expiry_cannot_create_a_fresh_budget() {
        for walls in [[1_000, 1_100], [1_000, 1_101]] {
            assert!(samples(1_100, 0, walls).is_err());
        }
    }

    #[test]
    fn later_wall_rollback_does_not_resample_or_extend_fixed_deadline() {
        let (anchor, deadline) = samples(1_100, 1, [1_000, 1_000]).unwrap();
        // Delivery only compares this retained Instant; it has no wall-clock
        // input to turn a subsequent rollback into additional allowance.
        assert_eq!(deadline, anchor + Duration::from_nanos(100));
        assert!(anchor + Duration::from_nanos(101) >= deadline);
    }
}
