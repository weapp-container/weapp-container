//! Native resources retire at the engine's permanent fault boundary, even
//! when an outer host-turn guard finishes without re-entering JavaScript.
use std::sync::{Condvar, Mutex};

#[derive(Default)]
pub struct EngineTerminalResources {
    state: Mutex<State>,
    completed: Condvar,
}

#[derive(Default)]
struct State {
    retired: bool,
    retiring_thread: Option<std::thread::ThreadId>,
    retirements: Vec<Box<dyn FnOnce() + Send>>,
}

impl EngineTerminalResources {
    /// Register bounded, nonblocking native owner cleanup only. Cleanup must
    /// never enter a guest VM or acquire its execution-control lock. A cleanup
    /// panic is contained; late registration cannot revive this incarnation.
    pub fn register(&self, retirement: impl FnOnce() + Send + 'static) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.retired {
            drop(state);
            run_retirement(Box::new(retirement));
        } else {
            state.retirements.push(Box::new(retirement));
        }
    }

    /// Publish retirement under the lock, then attempt every native cleanup
    /// without holding it. Concurrent callers wait for completion. A cleanup
    /// reentering this registry on the draining thread returns immediately; the
    /// outer call remains responsible for completing the remaining owners.
    pub fn retire(&self) {
        let retirements = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            let current = std::thread::current().id();
            while let Some(owner) = state.retiring_thread {
                if owner == current {
                    return;
                }
                state = self
                    .completed
                    .wait(state)
                    .unwrap_or_else(|error| error.into_inner());
            }
            if state.retired {
                return;
            }
            state.retired = true;
            state.retiring_thread = Some(current);
            std::mem::take(&mut state.retirements)
        };
        let _completion = RetirementCompletion(self);
        for retirement in retirements {
            run_retirement(retirement);
        }
    }
}

// Neither an owner cleanup nor an unwind while draining may strand waiters or
// unwind through an engine interrupt callback. Current owners are Rust stores.
fn run_retirement(retirement: Box<dyn FnOnce() + Send>) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(retirement));
}
struct RetirementCompletion<'a>(&'a EngineTerminalResources);
impl Drop for RetirementCompletion<'_> {
    fn drop(&mut self) {
        let mut state = self
            .0
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        state.retiring_thread = None;
        self.0.completed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, atomic::Ordering, Arc};

    #[test]
    fn native_retirements_run_once_and_late_registration_is_immediate() {
        let owners = EngineTerminalResources::default();
        let retired = Arc::new(AtomicUsize::new(0));
        for _ in 0..2 {
            let retired = retired.clone();
            owners.register(move || {
                retired.fetch_add(1, Ordering::SeqCst);
            });
        }
        owners.retire();
        owners.retire();
        assert_eq!(retired.load(Ordering::SeqCst), 2);
        let late = retired.clone();
        owners.register(move || {
            late.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(retired.load(Ordering::SeqCst), 3);
    }
    #[test]
    fn panic_and_reentry_cannot_strand_following_owners_or_second_retirement() {
        let owners = Arc::new(EngineTerminalResources::default());
        let followed = Arc::new(AtomicUsize::new(0));
        owners.register(|| panic!("intentional native cleanup failure"));
        let reentrant = owners.clone();
        owners.register(move || reentrant.retire());
        let count = followed.clone();
        owners.register(move || {
            count.fetch_add(1, Ordering::SeqCst);
        });
        let (sent, received) = std::sync::mpsc::channel();
        let retired = owners.clone();
        std::thread::spawn(move || {
            retired.retire();
            retired.retire();
            retired.register(|| panic!("intentional late cleanup failure"));
            sent.send(()).unwrap();
        });
        received
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("retirement must complete");
        assert_eq!(followed.load(Ordering::SeqCst), 1);
        owners.retire();
    }
}
