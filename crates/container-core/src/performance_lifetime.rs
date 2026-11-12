//! Native liveness fence shared by a Session and its performance realm.
//! Retirement never requires entering JavaScript or borrowing the Session.
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Debug)]
pub struct PerformanceLifetime {
    active: AtomicBool,
}

impl Default for PerformanceLifetime {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(true),
        }
    }
}

impl PerformanceLifetime {
    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub fn retire(&self) {
        self.active.store(false, Ordering::Release);
    }
}
