//! One AppService execution budget across an entire owner-thread operation.

use super::*;
use container_core::{EngineExecutionBudget, EngineTurnGuard};
use std::time::Duration;

/// Optional limits for embedders. Worker hosts must supply finite startup and
/// turn limits; historical native/headless sessions remain unbounded by default.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineExecutionPolicy {
    pub turn_timeout_ms: Option<u64>,
    pub bootstrap_timeout_ms: Option<u64>,
}

impl EngineExecutionPolicy {
    pub(super) fn is_bounded(&self) -> bool {
        self.turn_timeout_ms.is_some() || self.bootstrap_timeout_ms.is_some()
    }

    pub(super) fn validate(&self) -> Result<(), SessionError> {
        for (name, value) in [
            ("turn_timeout_ms", self.turn_timeout_ms),
            ("bootstrap_timeout_ms", self.bootstrap_timeout_ms),
        ] {
            if value.is_some_and(|value| value == 0 || value > 86_400_000) {
                return Err(SessionError::Config(format!(
                    "engine_execution.{name} must be between 1 and 86400000 ms"
                )));
            }
        }
        Ok(())
    }
}

impl Session {
    /// A faulted realm may contain partially applied JS state. It remains
    /// allocated for diagnostics and disposal, never as a headless substitute.
    pub fn execution_fault(&self) -> Option<&BridgeError> {
        self.engine_execution_fault.as_ref()
    }

    fn execution_restart_error(&self) -> Option<BridgeError> {
        if self.input_lifetime_revision.is_none() {
            return Some(BridgeError::new(
                BridgeErrorCode::Engine,
                "input lifetime revision exhausted; create a new session",
            ));
        }
        self.execution_fault().map(|fault| {
            BridgeError::new(
                BridgeErrorCode::Engine,
                format!("AppService requires a new session after {fault}"),
            )
        })
    }

    pub(super) fn record_execution_fault(&mut self, error: &BridgeError) {
        self.engine_execution_fault
            .get_or_insert_with(|| error.clone());
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        self.retire_native_queries(None, "native selector AppService requires a fresh session");
        // No JS hooks or rollback may run after interruption. The previous
        // scene is retained only for diagnostics, without input/observation.
        self.invalidate_browser_presentation();
        self.touch_contacts.clear();
        self.ended_touch_contacts.clear();
        self.observer_frame_valid = false;
        self.presented_revision = None;
        self.pending_presentation = None;
        self.observer_observation_pending = false;
    }

    fn begin_engine_host_turn(
        &mut self,
        timeout: Option<Duration>,
    ) -> Result<EngineTurnGuard, BridgeError> {
        if let Some(error) = self.execution_restart_error() {
            return Err(error);
        }
        let budget = EngineExecutionBudget {
            timeout,
            ..Default::default()
        };
        #[cfg(feature = "quickjs-native")]
        if let Some(engine) = self.quickjs_engine.as_mut() {
            return container_core::JsEngine::begin_host_turn(engine, budget)
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
        }
        if budget.is_unbounded() {
            Ok(EngineTurnGuard::unbounded())
        } else {
            Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "selected AppService provider does not support an execution budget",
            ))
        }
    }

    pub(super) fn remaining_engine_timeout(&self) -> Option<Duration> {
        self.engine_turn_deadline
            .map(|deadline| deadline.saturating_duration_since(Instant::now()))
    }

    /// Reflect the engine's sticky interrupt before a caller can run error,
    /// rollback or lifecycle JavaScript inside the still-active outer scope.
    pub(super) fn engine_execution_is_faulted(&self) -> bool {
        if self.input_lifetime_revision.is_none() || self.engine_execution_fault.is_some() {
            return true;
        }
        #[cfg(feature = "quickjs-native")]
        if let Some(engine) = &self.quickjs_engine {
            return engine.is_execution_faulted();
        }
        false
    }

    pub(super) fn ensure_engine_execution_healthy(&mut self) -> Result<(), BridgeError> {
        if let Some(error) = self.execution_restart_error() {
            return Err(error);
        }
        #[cfg(feature = "quickjs-native")]
        if let Some(fault) = self
            .quickjs_engine
            .as_ref()
            .and_then(|engine| engine.execution_fault())
        {
            let error = engine_bridge_error(fault, BridgeErrorCode::Engine);
            self.record_execution_fault(&error);
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn with_engine_host_turn<T>(
        &mut self,
        request_deadline_ns: Option<u64>,
        operation: impl FnOnce(&mut Self) -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        let request_deadline = if self.config.engine_execution.is_bounded() {
            request_deadline_ns.map(|deadline| {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_nanos();
                let remaining = Duration::from_nanos(
                    u128::from(deadline)
                        .saturating_sub(now)
                        .min(u128::from(u64::MAX)) as u64,
                );
                Instant::now()
                    .checked_add(remaining)
                    .unwrap_or_else(Instant::now)
            })
        } else {
            None
        };
        self.with_engine_host_turn_deadline(request_deadline, operation)
    }

    /// Share an absolute owner deadline with a candidate realm. Nested calls
    /// may shorten it, never renew the parent's allowance.
    pub(super) fn with_engine_host_turn_deadline<T>(
        &mut self,
        shared_deadline: Option<Instant>,
        operation: impl FnOnce(&mut Self) -> Result<T, BridgeError>,
    ) -> Result<T, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        let now = Instant::now();
        let policy = self
            .config
            .engine_execution
            .turn_timeout_ms
            .and_then(|ms| now.checked_add(Duration::from_millis(ms)));
        let deadline = [policy, shared_deadline, self.engine_turn_deadline]
            .into_iter()
            .flatten()
            .min();
        let timeout = deadline.map(|deadline| deadline.saturating_duration_since(now));
        let guard = self.begin_engine_host_turn(timeout)?;
        let previous = self.engine_turn_deadline;
        let previous_animation_time = self.animation_clock.begin_turn();
        self.engine_turn_deadline = deadline;
        let result = self
            .ensure_engine_environment_current()
            .and_then(|()| operation(self));
        let completion = guard.finish();
        self.engine_turn_deadline = previous;
        self.animation_clock.end_turn(previous_animation_time);
        if let Err(error) = completion {
            let error = engine_bridge_error(error, BridgeErrorCode::Engine);
            self.record_execution_fault(&error);
            return Err(error);
        }
        result
    }

    pub(super) fn host_turn_failure_batch(
        &mut self,
        error: &BridgeError,
        request_id: String,
        operation: &str,
    ) -> BridgeBatch {
        let mut messages = vec![self.error_envelope(error, request_id, operation)];
        self.append_browser_retirement_messages(&mut messages);
        BridgeBatch::new(messages)
    }

    /// Preserve effects already consumed by Rust if a subsequent JS step or
    /// final completion check expires. A success response for the interrupted
    /// request must not survive; earlier batch requests retain their results.
    pub(super) fn with_engine_batch_turn(
        &mut self,
        request: Option<&BridgeEnvelope>,
        operation: impl FnOnce(&mut Self) -> Result<BridgeBatch, BridgeError>,
    ) -> Result<BridgeBatch, BridgeError> {
        let mut output = None;
        let completion = self.with_engine_host_turn(
            request.and_then(|request| request.deadline_ns),
            |session| {
                output = Some(operation(session));
                Ok(())
            },
        );
        match (completion, output) {
            (Ok(()), Some(result)) => result,
            (Err(error), Some(Ok(mut batch))) => {
                let mut committed = None;
                if let Some(request) = request {
                    // Preserve irreversible publication and consumed diagnostics;
                    // replace only this request's final response, never rewrite
                    // a committed frame as a rejected one after a ready timeout.
                    committed = batch
                        .messages
                        .iter()
                        .find(|message| {
                            message.request_id == request.request_id
                                && message.payload.get("committed") == Some(&Value::Bool(true))
                        })
                        .map(|message| {
                            (
                                message.payload.get("frameId").cloned(),
                                message.payload.get("key").cloned(),
                            )
                        });
                    batch.messages.retain(|message| {
                        message.kind != EnvelopeKind::Response
                            || message.request_id != request.request_id
                            || message.op != request.op
                    });
                }
                let mut failure = self.error_envelope(
                    &error,
                    request
                        .map(|request| request.request_id.clone())
                        .unwrap_or_default(),
                    request.map_or(op::ERROR, |request| request.op.as_str()),
                );
                if let Some((frame_id, key)) = committed {
                    failure.payload["committed"] = Value::Bool(true);
                    if let Some(frame_id) = frame_id {
                        failure.payload["frameId"] = frame_id;
                    }
                    if let Some(key) = key {
                        failure.payload["key"] = key;
                        failure.payload["inputEnabled"] = Value::Bool(false);
                    }
                }
                batch.messages.push(failure);
                self.append_browser_retirement_messages(&mut batch.messages);
                Ok(batch)
            }
            (Err(error), _) => Err(error),
            (Ok(()), None) => unreachable!("host turn completed without invoking its operation"),
        }
    }
}
