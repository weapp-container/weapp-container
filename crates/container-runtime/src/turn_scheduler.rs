//! Host event-loop admission for the shared AppService turn scheduler.
use super::*;

/// One host-observed idle window. This value is consumed by `poll_idle`; it is
/// neither serializable nor a guest bridge message. The embedder must obtain
/// the deadline from its real event loop after pending input/render work.
#[derive(Debug)]
pub struct HostIdleOpportunity {
    deadline: Instant,
}
impl HostIdleOpportunity {
    pub fn until(deadline: Instant) -> Self {
        Self { deadline }
    }
}

impl Session {
    /// Consume one genuine idle opportunity. At most one idle callback runs;
    /// its effects return to the host before another opportunity is admitted.
    /// An expired window admits next-turn/timeout fallback only.
    pub fn poll_idle(&mut self, opportunity: HostIdleOpportunity) -> BridgeBatch {
        self.with_engine_batch_turn(None, |session| {
            if !session.initialized {
                return Ok(BridgeBatch::new(Vec::new()));
            }
            let mut messages = Vec::new();
            if session.engine_provider_available() {
                session.prepare_engine_environment()?;
                session.drain_engine_turn_scheduler(Some(opportunity.deadline))?;
                session.reconcile_intersection_queries()?;
                session.reconcile_media_queries()?;
                if session.observer_observation_pending {
                    session.notify_observers(&mut messages)?;
                }
                session.append_engine_effects(&mut messages)?;
            }
            session.append_browser_retirement_messages(&mut messages);
            Ok(BridgeBatch::new(messages))
        })
        .unwrap_or_else(|error| self.host_turn_failure_batch(&error, String::new(), op::ERROR))
    }

    pub(super) fn drain_engine_turn_scheduler(
        &mut self,
        idle_deadline: Option<Instant>,
    ) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        #[cfg(feature = "quickjs-native")]
        if let Some(engine) = self.quickjs_engine.as_mut() {
            return engine
                .poll_turn_scheduler(idle_deadline)
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
        }
        #[cfg(feature = "v8-native")]
        if let Some(engine) = self.v8_engine.as_mut() {
            return engine
                .poll_turn_scheduler(idle_deadline)
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
        }
        let _ = idle_deadline;
        Ok(())
    }
}
