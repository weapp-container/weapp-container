use crate::EngineError;
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

/// A host-owned execution limit. Adapters convert the duration to an absolute
/// monotonic deadline once when entering the scope; nested calls inherit it.
#[derive(Clone, Debug, Default)]
pub struct EngineExecutionBudget {
    pub timeout: Option<Duration>,
    pub cancellation: Option<Arc<AtomicBool>>,
}

impl EngineExecutionBudget {
    pub fn unbounded() -> Self {
        Self::default()
    }

    pub fn is_unbounded(&self) -> bool {
        self.timeout.is_none() && self.cancellation.is_none()
    }
}

/// An owned, thread-affine scope which does not borrow the engine. Explicit
/// completion reports budget failure. Abandonment runs only Rust cleanup;
/// adapters must never execute JavaScript from the completion callback.
#[must_use = "finish the host turn and handle its execution result"]
pub struct EngineTurnGuard {
    completion: Option<TurnCompletion>,
}

type TurnCompletion = Box<dyn FnOnce(bool) -> Result<(), EngineError>>;

impl EngineTurnGuard {
    pub fn new(completion: impl FnOnce(bool) -> Result<(), EngineError> + 'static) -> Self {
        Self {
            completion: Some(Box::new(completion)),
        }
    }

    pub fn unbounded() -> Self {
        Self::new(|_| Ok(()))
    }

    pub fn finish(mut self) -> Result<(), EngineError> {
        self.completion.take().expect("host turn already finished")(true)
    }
}

impl Drop for EngineTurnGuard {
    fn drop(&mut self) {
        if let Some(completion) = self.completion.take() {
            // Cleanup must not double-panic while a caller is unwinding.
            let _ = catch_unwind(AssertUnwindSafe(|| completion(false)));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    #[test]
    fn completion_is_explicit_or_abandoned_exactly_once() {
        let completed = Rc::new(Cell::new(None));
        let observed = completed.clone();
        EngineTurnGuard::new(move |value| {
            observed.set(Some(value));
            Ok(())
        })
        .finish()
        .unwrap();
        assert_eq!(completed.get(), Some(true));
        let observed = completed.clone();
        drop(EngineTurnGuard::new(move |value| {
            observed.set(Some(value));
            Ok(())
        }));
        assert_eq!(completed.get(), Some(false));
    }

    #[test]
    fn abandoned_cleanup_does_not_propagate_a_panic() {
        drop(EngineTurnGuard::new(|_| panic!("test cleanup panic")));
    }
}
