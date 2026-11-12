//! Default-off, native-owned method/result observation. This is a Rust host
//! boundary, not a wx API or bridge operation. Presentation remains a separate
//! host transaction; a fulfilled guest Promise does not certify a visible frame.
use super::*;
use container_core::{
    ConformanceGuestObservation as Observation, ConformanceGuestRequest as Request,
    ConformanceReceiverBinding as Receiver,
};

const MAX_INVOCATIONS: usize = 1024;
const MAX_ARGUMENT_BYTES: usize = 262_144;

#[derive(Clone, Debug)]
pub struct ConformancePageBinding {
    owner: Arc<()>,
    activation: u64,
    page: PageId,
    route: String,
    receiver: Receiver,
}

impl ConformancePageBinding {
    pub fn page_id(&self) -> PageId {
        self.page
    }
    pub fn route(&self) -> &str {
        &self.route
    }
    pub fn receiver_token(&self) -> &str {
        &self.receiver.token
    }
}

#[derive(Clone, Debug)]
pub struct ConformanceInvocation {
    owner: Arc<()>,
    id: String,
}
impl ConformanceInvocation {
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Consumed engine effects survive even when delivery is revoked or an outer
/// budget expires. Hosts must process this batch on success and failure alike.
#[derive(Debug)]
pub struct ConformanceGuestTurn<T> {
    pub result: Result<T, BridgeError>,
    pub effects: BridgeBatch,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Delivery {
    Unknown,
    Waiting,
    Consumed,
    Cancelled,
}
struct InvocationRecord {
    binding: ConformancePageBinding,
    ticket: Option<String>,
    delivery: Delivery,
}
pub(super) struct ConformanceGuestState {
    owner: Arc<()>,
    activation: Option<u64>,
    invocations: BTreeMap<String, InvocationRecord>,
}
impl Default for ConformanceGuestState {
    fn default() -> Self {
        Self {
            owner: Arc::new(()),
            activation: Some(0),
            invocations: BTreeMap::new(),
        }
    }
}
impl ConformanceGuestState {
    pub(super) fn retire_activation(&mut self) {
        self.activation = self.activation.and_then(|value| value.checked_add(1));
        for record in self.invocations.values_mut() {
            if record.delivery == Delivery::Waiting {
                record.delivery = Delivery::Unknown;
            }
        }
    }
}

fn revoked(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

impl Session {
    /// Revalidate a previously acquired foreground activation immediately before
    /// authorizing an immutable result for transport. This retained Acquire has
    /// no guest method lookup, job drain, terminal read, effect dispatch or frame
    /// presentation. A host must not pump/await between success and accepting
    /// the frame into its bounded writer. An asynchronous writer retains the
    /// original deadline; its completion retires delivery without guest reentry.
    ///
    /// The original absolute deadline is checked outside the optional engine
    /// budget as well: historical unbounded Sessions otherwise ignore request
    /// deadlines, including native V8, which has no finite execution budget.
    pub fn validate_conformance_binding(
        &mut self,
        binding: &ConformancePageBinding,
        deadline_ns: u64,
    ) -> Result<(), BridgeError> {
        let check_deadline = || {
            if deadline_expired(deadline_ns) {
                Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "conformance result delivery exceeded its original absolute deadline",
                ))
            } else {
                Ok(())
            }
        };
        check_deadline()?;
        self.with_engine_host_turn(Some(deadline_ns), |session| {
            session.verify_conformance_receiver(binding)
        })?;
        check_deadline()
    }

    fn check_conformance_binding(
        &mut self,
        binding: &ConformancePageBinding,
    ) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !Arc::ptr_eq(&binding.owner, &self.conformance_guests.owner)
            || self.conformance_guests.activation != Some(binding.activation)
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || !self
                .app_service
                .pages()
                .current()
                .is_some_and(|page| page.id == binding.page && page.path == binding.route)
        {
            return Err(revoked(
                "conformance page is no longer the actual current activation",
            ));
        }
        Ok(())
    }

    /// Acquire is private, captured-intrinsic-only and has no guest callback or
    /// microtask checkpoint. Check it again after effects before delivering.
    fn verify_conformance_receiver(
        &mut self,
        binding: &ConformancePageBinding,
    ) -> Result<(), BridgeError> {
        self.check_conformance_binding(binding)?;
        match self
            .conformance_transport(&Request::Acquire {
                page_id: binding.page.0.to_string(),
            })
            .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))?
        {
            Observation::Acquired { binding: actual } if actual == binding.receiver => Ok(()),
            _ => Err(revoked(
                "conformance actual receiver changed before delivery",
            )),
        }
    }

    fn conformance_turn<T>(
        &mut self,
        operation: impl FnOnce(&mut Self) -> Result<T, BridgeError>,
        verify: impl FnOnce(&mut Self, &T) -> Result<(), BridgeError>,
    ) -> ConformanceGuestTurn<T> {
        let mut effects = Vec::new();
        let result = self.with_engine_host_turn(None, |session| {
            let result = operation(session);
            // Ordinary failure still completes consumed API/storage/navigation
            // work. A faulted realm must never be entered for cleanup.
            let completion = if session.engine_execution_is_faulted() {
                Ok(())
            } else {
                session.append_engine_effects(&mut effects)
            };
            let value = result?;
            completion?;
            verify(session, &value)?;
            Ok(value)
        });
        ConformanceGuestTurn {
            result,
            effects: BridgeBatch::new(effects),
        }
    }

    /// No route/definition fallback: only this Session's actual foreground
    /// PageId and the native retained receiver can create an opaque binding.
    pub fn acquire_conformance_page(
        &mut self,
        route: &str,
    ) -> ConformanceGuestTurn<ConformancePageBinding> {
        self.conformance_turn(
            |session| {
                session.ensure_engine_execution_healthy()?;
                let activation = session
                    .conformance_guests
                    .activation
                    .ok_or_else(|| revoked("conformance activation namespace exhausted"))?;
                let page = session
                    .app_service
                    .pages()
                    .current()
                    .ok_or_else(|| revoked("conformance has no current page"))?;
                if route != page.path
                    || session.app_service.lifecycle().state()
                        != container_core::LifecycleState::Active
                {
                    return Err(revoked(
                        "conformance route is not the actual foreground page",
                    ));
                }
                let page_id = page.id;
                session.sync_current_pages()?;
                let receiver = match session.conformance_kernel_task(&Request::Acquire {
                    page_id: page_id.0.to_string(),
                })? {
                    Observation::Acquired { binding } => binding,
                    _ => {
                        return Err(BridgeError::invalid(
                            "conformance acquisition returned an unexpected outcome",
                        ));
                    }
                };
                Ok(ConformancePageBinding {
                    owner: session.conformance_guests.owner.clone(),
                    activation,
                    page: page_id,
                    route: route.into(),
                    receiver,
                })
            },
            |session, binding| session.verify_conformance_receiver(binding),
        )
    }

    /// Read the actual private Page/component receiver under its live Session
    /// activation. Source paths are flat names in the current reviewed profile.
    pub fn read_conformance_data(
        &mut self,
        binding: &ConformancePageBinding,
        scope_id: Option<String>,
        path: String,
    ) -> ConformanceGuestTurn<Observation> {
        self.conformance_turn(
            |session| {
                session.verify_conformance_receiver(binding)?;
                session.conformance_kernel_task(&Request::ReadData {
                    binding: binding.receiver.clone(),
                    scope_id,
                    path,
                })
            },
            |session, _| session.verify_conformance_receiver(binding),
        )
    }

    /// The journal starts at native realm bootstrap before application modules.
    /// Reset is an explicit source operation; snapshots never drain the journal.
    pub fn read_conformance_runtime_logs(
        &mut self,
        reset: bool,
    ) -> ConformanceGuestTurn<Observation> {
        self.conformance_turn(
            |session| {
                session.ensure_engine_execution_healthy()?;
                session
                    .conformance_transport(&Request::RuntimeLogs { reset })
                    .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))
            },
            |_, _| Ok(()),
        )
    }

    pub fn close_conformance_runtime_logs(&mut self) -> ConformanceGuestTurn<Observation> {
        if self.app_service.lifecycle().state() == container_core::LifecycleState::Destroyed {
            return ConformanceGuestTurn {
                result: Err(revoked("runtime log Session is already closed")),
                effects: BridgeBatch::new(vec![]),
            };
        }
        let cleanup = self.close_conformance_guest_cleanup();
        let effects = cleanup.effects;
        let closed = cleanup.result.unwrap_or(false);
        let result = self
            .with_engine_host_turn(None, |session| {
                session
                    .conformance_transport(&Request::RuntimeLogs { reset: false })
                    .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))
            })
            .and_then(|mut observed| {
                if let Observation::RuntimeLogs { complete, .. } = &mut observed {
                    *complete &= closed;
                    Ok(observed)
                } else {
                    Err(revoked("runtime journal close returned another outcome"))
                }
            });
        ConformanceGuestTurn { result, effects }
    }

    /// Reserve the native owner before any host-budget entry or VM operation.
    /// Every error keeps a tombstone: an absent ticket cannot mean "not called".
    pub fn begin_conformance_guest(
        &mut self,
        binding: &ConformancePageBinding,
        invocation_id: &str,
        method: &str,
        args: ValueBatch,
    ) -> ConformanceGuestTurn<ConformanceInvocation> {
        let reserve = (|| {
            if invocation_id.is_empty()
                || invocation_id.len() > 128
                || method.is_empty()
                || method.len() > 256
                || serde_json::to_vec(&args)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?
                    .len()
                    > MAX_ARGUMENT_BYTES
            {
                return Err(BridgeError::invalid(
                    "conformance invocation exceeds its input domain",
                ));
            }
            if self
                .conformance_guests
                .invocations
                .contains_key(invocation_id)
                || self.conformance_guests.invocations.len() >= MAX_INVOCATIONS
            {
                return Err(BridgeError::invalid(
                    "conformance invocation owner reused or ledger exhausted",
                ));
            }
            self.conformance_guests.invocations.insert(
                invocation_id.into(),
                InvocationRecord {
                    binding: binding.clone(),
                    ticket: None,
                    delivery: Delivery::Unknown,
                },
            );
            Ok(ConformanceInvocation {
                owner: self.conformance_guests.owner.clone(),
                id: invocation_id.into(),
            })
        })();
        let invocation = match reserve {
            Ok(value) => value,
            Err(error) => {
                return ConformanceGuestTurn {
                    result: Err(error),
                    effects: BridgeBatch::new(vec![]),
                };
            }
        };
        let turn = self.conformance_turn(
            |session| {
                session.check_conformance_binding(binding)?;
                session.sync_current_pages()?;
                session.verify_conformance_receiver(binding)?;
                let ticket = match session.conformance_kernel_task(&Request::Begin {
                    binding: binding.receiver.clone(),
                    invocation_id: invocation.id.clone(),
                    method: method.into(),
                    args,
                })? {
                    Observation::Begun { ticket } => ticket,
                    _ => {
                        return Err(BridgeError::invalid(
                            "conformance begin returned an unexpected outcome",
                        ));
                    }
                };
                session
                    .conformance_guests
                    .invocations
                    .get_mut(&invocation.id)
                    .unwrap()
                    .ticket = Some(ticket);
                Ok(invocation.clone())
            },
            |session, _| session.verify_conformance_receiver(binding),
        );
        if turn.result.is_ok() {
            self.conformance_guests
                .invocations
                .get_mut(&invocation.id)
                .unwrap()
                .delivery = Delivery::Waiting;
        }
        turn
    }

    pub fn poll_conformance_guest(
        &mut self,
        invocation: &ConformanceInvocation,
    ) -> ConformanceGuestTurn<Observation> {
        let prepared = (|| {
            if !Arc::ptr_eq(&invocation.owner, &self.conformance_guests.owner) {
                return Err(revoked(
                    "conformance invocation belongs to another Session/realm",
                ));
            }
            let record = self
                .conformance_guests
                .invocations
                .get_mut(&invocation.id)
                .ok_or_else(|| revoked("conformance invocation unavailable"))?;
            if record.delivery != Delivery::Waiting {
                return Err(revoked(
                    "conformance invocation consumed, revoked or unknown",
                ));
            }
            // A failed/aborted poll cannot be retried as if no terminal native
            // observation might have been consumed before its outer timeout.
            record.delivery = Delivery::Unknown;
            Ok((
                record.binding.clone(),
                record
                    .ticket
                    .clone()
                    .ok_or_else(|| revoked("conformance invocation ticket unknown"))?,
            ))
        })();
        let (binding, ticket) = match prepared {
            Ok(value) => value,
            Err(error) => {
                return ConformanceGuestTurn {
                    result: Err(error),
                    effects: BridgeBatch::new(vec![]),
                };
            }
        };
        let turn = self.conformance_turn(
            |session| {
                session.verify_conformance_receiver(&binding)?;
                session.conformance_kernel_task(&Request::Poll {
                    binding: binding.receiver.clone(),
                    ticket,
                })
            },
            |session, _| session.verify_conformance_receiver(&binding),
        );
        if let Ok(outcome) = &turn.result {
            self.conformance_guests
                .invocations
                .get_mut(&invocation.id)
                .unwrap()
                .delivery = if matches!(outcome, Observation::Pending { .. }) {
                Delivery::Waiting
            } else {
                Delivery::Consumed
            };
        }
        turn
    }

    /// Cancels observation only. Guest work/Promise effects are irreversible;
    /// a late settlement never revives the native owner or permits begin retry.
    pub fn cancel_conformance_guest(
        &mut self,
        invocation: &ConformanceInvocation,
    ) -> ConformanceGuestTurn<Observation> {
        let prepared = (|| {
            if !Arc::ptr_eq(&invocation.owner, &self.conformance_guests.owner) {
                return Err(revoked(
                    "conformance invocation belongs to another Session/realm",
                ));
            }
            let record = self
                .conformance_guests
                .invocations
                .get_mut(&invocation.id)
                .ok_or_else(|| revoked("conformance invocation unavailable"))?;
            if record.delivery != Delivery::Waiting {
                return Err(revoked(
                    "conformance invocation consumed, revoked or unknown",
                ));
            }
            record.delivery = Delivery::Cancelled;
            record
                .ticket
                .clone()
                .ok_or_else(|| revoked("conformance invocation ticket unknown"))
        })();
        let ticket = match prepared {
            Ok(value) => value,
            Err(error) => {
                return ConformanceGuestTurn {
                    result: Err(error),
                    effects: BridgeBatch::new(vec![]),
                };
            }
        };
        self.conformance_turn(
            |session| session.conformance_kernel_task(&Request::Cancel { ticket }),
            |_, _| Ok(()),
        )
    }

    fn conformance_kernel_task(&mut self, request: &Request) -> Result<Observation, BridgeError> {
        self.ensure_engine_environment_current()?;
        let result = self.conformance_transport(request);
        #[cfg(feature = "quickjs-native")]
        if let Some(engine) = self.quickjs_engine.as_mut() {
            if engine.is_execution_faulted() {
                return result.map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
            }
            let checkpoint = container_core::JsEngine::drain_microtasks(engine);
            return complete_engine_task(result, checkpoint)
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
        }
        #[cfg(feature = "v8-native")]
        if let Some(engine) = self.v8_engine.as_mut() {
            let checkpoint = container_core::JsEngine::drain_microtasks(engine);
            return complete_engine_task(result, checkpoint)
                .map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine));
        }
        result.map_err(|error| engine_bridge_error(error, BridgeErrorCode::Engine))
    }

    fn conformance_transport(&mut self, request: &Request) -> Result<Observation, EngineError> {
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => self
                .quickjs_engine
                .as_mut()
                .ok_or_else(|| {
                    EngineError::new(
                        EngineErrorCode::Call,
                        "conformance QuickJS provider unavailable",
                    )
                })?
                .observe_conformance_guest(request)
                .map_err(|error| error.into_core_error()),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => self
                .v8_engine
                .as_mut()
                .ok_or_else(|| {
                    EngineError::new(EngineErrorCode::Call, "conformance V8 provider unavailable")
                })?
                .observe_conformance_guest(request)
                .map_err(|error| error.into_core_error()),
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => {
                let _ = request;
                Err(EngineError::new(
                    EngineErrorCode::Call,
                    "conformance requires the selected actual native engine",
                ))
            }
        }
    }
}

#[path = "conformance_exceptions.rs"]
mod exception_capture;
pub use exception_capture::ConformanceExceptionCapture;
