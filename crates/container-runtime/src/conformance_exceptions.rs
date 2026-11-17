//! Session/realm-owned exception interval, ending after terminal guest cleanup.
//! Native resources/windows are released independently by the owning host.
use super::*;
use container_core::{
    ConformanceExceptionObservation as ExceptionObservation,
    ConformanceExceptionRequest as ExceptionRequest,
};

#[derive(Clone, Debug)]
pub struct ConformanceExceptionCapture {
    owner: Arc<()>,
    token: String,
    start_cursor: u64,
}
impl ConformanceExceptionCapture {
    pub fn token(&self) -> &str {
        &self.token
    }
    pub fn start_cursor(&self) -> u64 {
        self.start_cursor
    }
}

impl Session {
    pub fn begin_conformance_exceptions(
        &mut self,
    ) -> ConformanceGuestTurn<ConformanceExceptionCapture> {
        self.conformance_turn(
            |session| {
                session.ensure_initialized()?;
                if session.app_service.lifecycle().state()
                    == container_core::LifecycleState::Destroyed
                {
                    return Err(revoked(
                        "exception interval cannot start in a retired Session",
                    ));
                }
                match session.exception_transport(&ExceptionRequest::Begin {
                    max_events: 256,
                    max_message_bytes: 65536,
                })? {
                    ExceptionObservation::Begun {
                        token,
                        start_cursor,
                    } => Ok(ConformanceExceptionCapture {
                        owner: session.conformance_guests.owner.clone(),
                        token,
                        start_cursor,
                    }),
                    _ => Err(revoked(
                        "native exception begin returned an unexpected result",
                    )),
                }
            },
            |_, _| Ok(()),
        )
    }

    /// Terminal source close: actual Page/component/App unload work completes
    /// before the private queue is sealed. Any failure makes completion false.
    /// The returned effects must be retained even on a failed close.
    pub fn close_conformance_exceptions(
        &mut self,
        capture: &ConformanceExceptionCapture,
    ) -> ConformanceGuestTurn<ExceptionObservation> {
        if !Arc::ptr_eq(&capture.owner, &self.conformance_guests.owner) {
            return ConformanceGuestTurn {
                result: Err(revoked(
                    "exception interval belongs to another Session/realm",
                )),
                effects: BridgeBatch::new(vec![]),
            };
        }
        // Only this realm's successful single Begin can create the opaque
        // handle; callers cannot mutate its token/cursor or forge its Arc owner.
        // Destroyed rejects duplicate/preempted close before any teardown.
        // The private JS End validates its token/cursor/phase after cleanup;
        // there is no separate non-mutating journal peek in this protocol.
        if self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed {
            return ConformanceGuestTurn {
                result: Err(revoked("exception interval Session is already closed")),
                effects: BridgeBatch::new(vec![]),
            };
        }
        let cleanup = self.close_conformance_guest_cleanup();
        let effects = cleanup.effects;
        let closed = cleanup.result.unwrap_or(false);
        let result = self
            .with_engine_host_turn(None, |session| {
                session.exception_transport(&ExceptionRequest::End {
                    token: capture.token.clone(),
                    start_cursor: capture.start_cursor,
                })
            })
            .and_then(|mut result| {
                if let ExceptionObservation::Ended { complete, .. } = &mut result {
                    *complete &= closed;
                    Ok(result)
                } else {
                    Err(revoked(
                        "native exception end returned an unexpected result",
                    ))
                }
            });
        ConformanceGuestTurn { result, effects }
    }

    /// Common terminal guest lifecycle, while native retained journals remain
    /// available. Both callers retain all effects even after failed cleanup.
    pub(super) fn close_conformance_guest_cleanup(&mut self) -> ConformanceGuestTurn<bool> {
        let pages = self.conformance_turn(|session| session.unload_all_pages(), |_, _| Ok(()));
        let mut effects = pages.effects;
        let request = BridgeEnvelope::request(
            &self.config.session_id,
            "conformance-exceptions-close",
            op::APP_LIFECYCLE,
            json!({"event":"unload"}),
        );
        let lifecycle = self.dispatch(request);
        let lifecycle_ok = lifecycle.messages.iter().any(|message| {
            message.op == op::APP_LIFECYCLE && message.payload.get("ok") == Some(&Value::Bool(true))
        }) && !lifecycle
            .messages
            .iter()
            .any(|message| message.op == op::ERROR);
        effects.messages.extend(lifecycle.messages);
        let closed = pages.result.is_ok()
            && lifecycle_ok
            && self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed;
        ConformanceGuestTurn {
            result: Ok(closed),
            effects,
        }
    }

    fn exception_transport(
        &mut self,
        request: &ExceptionRequest,
    ) -> Result<ExceptionObservation, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => self
                .quickjs_engine
                .as_mut()
                .ok_or_else(|| revoked("exception QuickJS provider unavailable"))?
                .observe_conformance_exceptions(request)
                .map_err(|error| {
                    engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                }),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => self
                .v8_engine
                .as_mut()
                .ok_or_else(|| revoked("exception V8 provider unavailable"))?
                .observe_conformance_exceptions(request)
                .map_err(|error| {
                    engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                }),
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => {
                let _ = request;
                Err(revoked(
                    "exception capture requires the actual selected native engine",
                ))
            }
        }
    }
}
