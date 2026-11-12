//! This source registry's actual watcher and retryable process-tree barrier.
//! No already-spawned process, PID or caller-supplied barrier is accepted.

use crate::owned_process::OwnedProcess;
use std::io;
use std::path::PathBuf;
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    NeverStarted,
    Live,
    Barrier,
}

/// Owned by exactly one SourceCredits instance. SourceCredits constructs it
/// from its own run/control fields and keeps it until its registry drains.
pub(super) struct BoundSourceWatcher {
    control_root: PathBuf,
    run_id: String,
    phase: Phase,
    stopping: bool,
    actual: Option<Box<OwnedProcess>>,
    status: Option<ExitStatus>,
}

impl BoundSourceWatcher {
    pub(super) fn new(control_root: PathBuf, run_id: String) -> Self {
        Self {
            control_root,
            run_id,
            phase: Phase::NeverStarted,
            stopping: false,
            actual: None,
            status: None,
        }
    }

    /// Call only after root/source admission, exclusive control-root creation,
    /// exact compiler check and initial grant creation. Caller retains this
    /// object on Err; post-create Windows constructor recovery lives here.
    pub(super) fn spawn(&mut self, command: &mut Command) -> io::Result<()> {
        if self.phase != Phase::NeverStarted || self.stopping {
            return Err(io::Error::other(
                "this source run's watcher cannot be restarted",
            ));
        }
        command
            .env(
                "WEAPP_CONTAINER_SIMULATOR_SOURCE_CREDIT_DIR",
                &self.control_root,
            )
            .env("WEAPP_CONTAINER_SIMULATOR_SESSION_ID", &self.run_id);
        match OwnedProcess::spawn_finite(command) {
            Ok(actual) => {
                self.actual = Some(Box::new(actual));
                self.phase = Phase::Live;
                Ok(())
            }
            Err(failure) => {
                let (cause, actual) = failure.into_parts();
                self.phase = if actual.is_some() {
                    Phase::Live
                } else {
                    Phase::Barrier
                };
                self.actual = actual;
                Err(cause)
            }
        }
    }

    pub(super) fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.actual.as_mut().and_then(|actual| actual.take_stdout())
    }

    pub(super) fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.actual.as_mut().and_then(|actual| actual.take_stderr())
    }

    /// This replaces try_wait entirely for the managed watcher. The finite
    /// owner preserves the unreaped Unix leader/Windows Job until the actual
    /// owned tree is gone. A normal wrapper exit also retires lingering workers.
    pub(super) fn poll(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.phase == Phase::Live {
            let actual = self
                .actual
                .as_mut()
                .ok_or_else(|| io::Error::other("source watcher owner missing"))?;
            if let Some(status) = actual.poll_finite_exit()? {
                self.status = Some(status);
                self.phase = Phase::Barrier;
                // Only the actual tree barrier permits releasing this owner.
                self.actual = None;
            }
        }
        Ok(self.status)
    }

    pub(super) fn try_shutdown(&mut self) -> io::Result<bool> {
        self.stopping = true;
        if self.phase == Phase::NeverStarted {
            // No command ever executed for this exclusively owned run. Stop
            // admission permanently before allowing its grants to be removed.
            self.phase = Phase::Barrier;
        }
        if self.phase == Phase::Live {
            self.actual
                .as_mut()
                .ok_or_else(|| io::Error::other("source watcher owner missing"))?
                .terminate_finite()?;
            self.poll()?;
        }
        Ok(self.phase == Phase::Barrier)
    }

    /// Use only inside the enclosing SourceCredits implementation after poll
    /// or try_shutdown on this SAME object. This is not an external receipt.
    pub(super) fn has_actual_barrier(&self) -> bool {
        self.phase == Phase::Barrier
    }
}

// SourceCredits checks this actual barrier before parsing any malformed ACK.
// Earlier per-credit ACK release requires the trusted helper to confirm that
// no writable fd/write authority remains. An ambiguous writer close has no
// ACK; ambiguous reader/control close likewise ends the actual watcher.
