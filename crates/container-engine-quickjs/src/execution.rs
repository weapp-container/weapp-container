//! Host-turn control contains no QuickJS handles. Interrupt callbacks and
//! abandoned guards only inspect or update this Rust-owned state.
use container_core::{EngineError, EngineErrorCode, EngineExecutionBudget, EngineTurnGuard};
use std::sync::{atomic::Ordering, Arc, Mutex};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::Instant;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use web_time::Instant;

#[derive(Clone)]
pub(super) struct ExecutionControl {
    state: Arc<Mutex<State>>,
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}

#[derive(Default)]
struct State {
    sequence: u64,
    scopes: Vec<Scope>,
    fault: Option<EngineError>,
    terminal_resources: Arc<container_core::EngineTerminalResources>,
}

struct Scope {
    id: u64,
    deadline: Option<Instant>,
    cancellation: Option<Arc<std::sync::atomic::AtomicBool>>,
}

impl Default for ExecutionControl {
    fn default() -> Self {
        Self {
            state: Arc::default(),
            clock: Arc::new(Instant::now),
        }
    }
}

impl State {
    fn check(&mut self, now: Instant) -> Result<(), EngineError> {
        if self.fault.is_none() {
            if self.scopes.iter().any(|scope| {
                scope
                    .cancellation
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Acquire))
            }) {
                self.fault = Some(EngineError::new(
                    EngineErrorCode::Cancelled,
                    "QuickJS host turn was cancelled; restart the session",
                ));
            } else if self
                .scopes
                .iter()
                .any(|scope| scope.deadline.is_some_and(|deadline| now >= deadline))
            {
                self.fault = Some(EngineError::new(
                    EngineErrorCode::Timeout,
                    "QuickJS host turn exceeded its monotonic deadline; restart the session",
                ));
            }
        }
        if self.fault.is_some() {
            self.terminal_resources.retire();
        }
        match &self.fault {
            Some(fault) if !self.scopes.is_empty() => Err(fault.clone()),
            Some(_) => Err(EngineError::new(
                EngineErrorCode::RequiresRestart,
                "QuickJS AppService realm is faulted; create a new session",
            )),
            None => Ok(()),
        }
    }
}

impl ExecutionControl {
    pub(super) fn retire_on_fault(&self, retirement: impl FnOnce() + Send + 'static) {
        let terminal_resources = self
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .terminal_resources
            .clone();
        terminal_resources.register(retirement);
    }

    pub(super) fn begin(
        &self,
        budget: EngineExecutionBudget,
    ) -> Result<EngineTurnGuard, EngineError> {
        let now = (self.clock)();
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.check(now)?;
        if budget
            .cancellation
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Acquire))
        {
            return Err(EngineError::new(
                EngineErrorCode::Cancelled,
                "QuickJS host turn was cancelled before execution",
            ));
        }
        if budget.timeout.is_some_and(|timeout| timeout.is_zero()) {
            return Err(EngineError::new(
                EngineErrorCode::Timeout,
                "QuickJS host turn has no execution time remaining",
            ));
        }
        let deadline = budget
            .timeout
            .map(|timeout| {
                now.checked_add(timeout).ok_or_else(|| {
                    EngineError::new(
                        EngineErrorCode::Call,
                        "QuickJS execution timeout is out of range",
                    )
                })
            })
            .transpose()?;
        state.sequence = match state.sequence.checked_add(1) {
            Some(sequence) => sequence,
            None => {
                let fault = EngineError::new(
                    EngineErrorCode::RequiresRestart,
                    "QuickJS scope ID exhausted",
                );
                state.fault = Some(fault.clone());
                state.terminal_resources.retire();
                return Err(fault);
            }
        };
        let id = state.sequence;
        state.scopes.push(Scope {
            id,
            deadline,
            cancellation: budget.cancellation,
        });
        drop(state);
        let control = self.clone();
        Ok(EngineTurnGuard::new(move |completed| {
            control.finish(id, completed)
        }))
    }

    pub(super) fn check(&self) -> Result<(), EngineError> {
        self.state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .check((self.clock)())
    }

    pub(super) fn faulted(&self) -> bool {
        self.fault().is_some()
    }

    pub(super) fn fault(&self) -> Option<EngineError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let _ = state.check((self.clock)());
        state.fault.clone()
    }

    pub(super) fn interrupt(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.fault.get_or_insert_with(|| {
            EngineError::new(EngineErrorCode::Interrupted, "QuickJS was interrupted")
        });
        state.terminal_resources.retire();
    }

    fn finish(&self, id: u64, completed: bool) -> Result<(), EngineError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.scopes.last().map(|scope| scope.id) != Some(id) {
            state.fault.get_or_insert_with(|| {
                EngineError::new(
                    EngineErrorCode::RequiresRestart,
                    "QuickJS host scopes were completed out of order",
                )
            });
            state.terminal_resources.retire();
            // A stale guard must not disarm the newer scope.
            return Err(state.fault.as_ref().expect("fault set").clone());
        }
        if !completed {
            state.fault.get_or_insert_with(|| {
                EngineError::new(
                    EngineErrorCode::RequiresRestart,
                    "QuickJS host turn was abandoned; restart the session",
                )
            });
        }
        let result = state.check((self.clock)());
        state.scopes.pop();
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU64};
    use std::time::Duration;

    fn controlled() -> (ExecutionControl, Arc<AtomicU64>) {
        let start = Instant::now();
        let ticks = Arc::new(AtomicU64::new(0));
        let clock_ticks = ticks.clone();
        (
            ExecutionControl {
                state: Arc::default(),
                clock: Arc::new(move || {
                    start + Duration::from_millis(clock_ticks.load(Ordering::Acquire))
                }),
            },
            ticks,
        )
    }

    fn budget(ms: u64) -> EngineExecutionBudget {
        EngineExecutionBudget {
            timeout: Some(Duration::from_millis(ms)),
            cancellation: None,
        }
    }

    fn retirement(control: &ExecutionControl) -> Arc<AtomicBool> {
        let retired = Arc::new(AtomicBool::new(false));
        let marker = retired.clone();
        control.retire_on_fault(move || marker.store(true, Ordering::Release));
        retired
    }

    #[test]
    fn deadline_fault_retires_native_owners_at_outer_guard_finish() {
        let (control, ticks) = controlled();
        let retired = retirement(&control);
        let guard = control.begin(budget(5)).unwrap();
        ticks.store(5, Ordering::Release);
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert!(retired.load(Ordering::Acquire));
    }

    #[test]
    fn cancellation_fault_retires_native_owners_at_outer_guard_finish() {
        let (control, _) = controlled();
        let retired = retirement(&control);
        let cancelled = Arc::new(AtomicBool::new(false));
        let guard = control
            .begin(EngineExecutionBudget {
                timeout: None,
                cancellation: Some(cancelled.clone()),
            })
            .unwrap();
        cancelled.store(true, Ordering::Release);
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Cancelled);
        assert!(retired.load(Ordering::Acquire));
    }

    #[test]
    fn abandoned_guard_retires_native_owners_without_engine_reentry() {
        let (control, _) = controlled();
        let retired = retirement(&control);
        drop(control.begin(budget(5)).unwrap());
        assert!(retired.load(Ordering::Acquire));
    }

    #[test]
    fn explicit_interrupt_and_late_owner_registration_are_terminal() {
        let (control, _) = controlled();
        let retired = retirement(&control);
        control.interrupt();
        assert!(retired.load(Ordering::Acquire));
        assert!(retirement(&control).load(Ordering::Acquire));
    }

    #[test]
    fn preflight_rejection_preserves_healthy_native_owners() {
        let (control, _) = controlled();
        let retired = retirement(&control);
        assert!(control.begin(budget(0)).is_err());
        assert!(control
            .begin(EngineExecutionBudget {
                timeout: None,
                cancellation: Some(Arc::new(AtomicBool::new(true))),
            })
            .is_err());
        assert!(!control.faulted());
        assert!(!retired.load(Ordering::Acquire));
        control.begin(budget(5)).unwrap().finish().unwrap();
        assert!(!retired.load(Ordering::Acquire));
    }

    #[test]
    fn nested_scopes_cannot_renew_a_parent_deadline() {
        let (control, ticks) = controlled();
        let parent = control.begin(budget(10)).unwrap();
        ticks.store(8, Ordering::Release);
        let child = control.begin(budget(100)).unwrap();
        ticks.store(10, Ordering::Release);
        assert_eq!(control.check().unwrap_err().code, EngineErrorCode::Timeout);
        assert_eq!(child.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert_eq!(parent.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert_eq!(
            control.begin(budget(100)).err().unwrap().code,
            EngineErrorCode::RequiresRestart
        );
    }

    #[test]
    fn completed_child_restores_original_parent_deadline() {
        let (control, ticks) = controlled();
        let parent = control.begin(budget(100)).unwrap();
        control.begin(budget(10)).unwrap().finish().unwrap();
        ticks.store(20, Ordering::Release);
        control.check().unwrap();
        parent.finish().unwrap();
    }

    #[test]
    fn completing_a_turn_checks_the_deadline_without_an_interrupt() {
        let (control, ticks) = controlled();
        let guard = control.begin(budget(10)).unwrap();
        ticks.store(10, Ordering::Release);
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert_eq!(control.fault().unwrap().code, EngineErrorCode::Timeout);
        assert_eq!(
            control.check().unwrap_err().code,
            EngineErrorCode::RequiresRestart
        );
    }

    #[test]
    fn rejected_budgets_do_not_poison_an_unentered_realm() {
        let (control, _) = controlled();
        assert_eq!(
            control.begin(budget(0)).err().unwrap().code,
            EngineErrorCode::Timeout
        );
        assert_eq!(
            control
                .begin(EngineExecutionBudget {
                    timeout: None,
                    cancellation: Some(Arc::new(AtomicBool::new(true))),
                })
                .err()
                .unwrap()
                .code,
            EngineErrorCode::Cancelled
        );
        assert!(!control.faulted());
        control.begin(budget(100)).unwrap().finish().unwrap();
    }

    #[test]
    fn nested_calls_inherit_parent_cancellation() {
        let (control, _) = controlled();
        let flag = Arc::new(AtomicBool::new(false));
        let parent = control
            .begin(EngineExecutionBudget {
                timeout: None,
                cancellation: Some(flag.clone()),
            })
            .unwrap();
        let child = control.begin(EngineExecutionBudget::unbounded()).unwrap();
        flag.store(true, Ordering::Release);
        assert_eq!(child.finish().unwrap_err().code, EngineErrorCode::Cancelled);
        assert_eq!(
            parent.finish().unwrap_err().code,
            EngineErrorCode::Cancelled
        );
    }

    #[test]
    fn cancellation_is_sticky_and_abandonment_faults_the_realm() {
        let (control, _) = controlled();
        let flag = Arc::new(AtomicBool::new(false));
        let guard = control
            .begin(EngineExecutionBudget {
                timeout: None,
                cancellation: Some(flag.clone()),
            })
            .unwrap();
        flag.store(true, Ordering::Release);
        assert_eq!(
            control.check().unwrap_err().code,
            EngineErrorCode::Cancelled
        );
        flag.store(false, Ordering::Release);
        assert_eq!(guard.finish().unwrap_err().code, EngineErrorCode::Cancelled);
        assert_eq!(
            control.check().unwrap_err().code,
            EngineErrorCode::RequiresRestart
        );
        let (control, _) = controlled();
        drop(control.begin(EngineExecutionBudget::unbounded()).unwrap());
        assert!(control.faulted());
    }

    #[test]
    fn stale_guard_cannot_disarm_a_newer_scope() {
        let (control, _) = controlled();
        let parent = control.begin(budget(100)).unwrap();
        let child = control.begin(budget(100)).unwrap();
        assert_eq!(
            parent.finish().unwrap_err().code,
            EngineErrorCode::RequiresRestart
        );
        assert_eq!(
            child.finish().unwrap_err().code,
            EngineErrorCode::RequiresRestart
        );
    }
}
