//! Actual consuming stage entry points on the existing supervisor. These
//! prepare immutable bytes only; a later owner must separately authorize a
//! publication and observe real Worker and presenter receipts.

use super::*;
use crate::browser_dev_aggregate_store::{NamespaceId, StageBodyLease, Step};
use crate::browser_dev_coordinator::{StageArtifact, StageTicket};

/// Opaque identity in this supervisor's original aggregate store. Copying the
/// identity cannot construct files, an input lease, or publication authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BrowserStageId(NamespaceId);

#[derive(Debug)]
pub enum BrowserStageStart {
    Started(BrowserStageId),
    /// Deliver these source events before retrying with a current ticket.
    SourcePending {
        events: Vec<DevEvent>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum BrowserStagePoll {
    Running,
    CapturedStatic {
        artifact: Box<StageArtifact>,
        runtime_ready: bool,
        presented_ready: bool,
    },
    Retiring,
    Released,
}

/// Shared original bytes and SAME original stage charge, suitable for a
/// future socket body. A live borrower blocks stage and parent cleanup.
#[derive(Debug)]
pub struct BrowserStageResource(StageBodyLease);

impl BrowserStageResource {
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

impl DevSupervisor {
    pub fn browser_stage_run_id(&self) -> Option<&str> {
        (self.config.managed_browser_stages && !self.stopped).then_some(&self.receipt_session)
    }

    /// Borrow only the actual current generation after an immediate source
    /// observation. Caller-made reports/paths cannot mint the input. Starting
    /// a finite job grants no authority to publish its eventual completion.
    pub fn begin_browser_stage(
        &mut self,
        ticket: StageTicket,
        startup_intent: Vec<u8>,
    ) -> Result<BrowserStageStart, DevError> {
        if self.stopped {
            return Err(DevError::Shutdown);
        }
        if !self.config.managed_browser_stages || ticket.run_id() != self.receipt_session {
            return Err(DevError::BrowserRuntime(
                "consuming stage policy or run identity differs".into(),
            ));
        }
        let check = self.check_portable_publication(ticket.pack_report());
        if !check.authorized || !check.events.is_empty() {
            return Ok(BrowserStageStart::SourcePending {
                events: check.events,
            });
        }
        let owner = self
            .browser_runtime
            .as_mut()
            .ok_or_else(|| DevError::BrowserRuntime("runtime owner unavailable".into()))?;
        let source = self
            .managed_source
            .as_ref()
            .ok_or_else(|| DevError::BrowserRuntime("managed source owner unavailable".into()))?;
        let portable_input = source.stage_input(owner, ticket.pack_report())?;
        let id = owner
            .start_stage(
                self.receipt_session.clone(),
                ticket,
                startup_intent,
                portable_input,
            )
            .map_err(DevError::BrowserRuntime)?;
        Ok(BrowserStageStart::Started(BrowserStageId(id)))
    }

    pub fn poll_browser_stage(&mut self, id: BrowserStageId) -> Result<BrowserStagePoll, DevError> {
        let Some(owner) = self.browser_runtime.as_mut() else {
            return Ok(BrowserStagePoll::Released);
        };
        let step = owner.poll_stage(id.0).map_err(DevError::BrowserRuntime)?;
        Ok(match step {
            Step::Running => BrowserStagePoll::Running,
            Step::CapturedStatic => BrowserStagePoll::CapturedStatic {
                artifact: Box::new(
                    owner
                        .stage_artifact(id.0)
                        .map_err(DevError::BrowserRuntime)?
                        .clone(),
                ),
                runtime_ready: false,
                presented_ready: false,
            },
            Step::Retiring | Step::CleanupPending => BrowserStagePoll::Retiring,
            Step::Released => BrowserStagePoll::Released,
        })
    }

    /// Stage allowlist excludes generated executable config and every input
    /// pathname. Retired stages immediately stop accepting new body borrows.
    pub fn browser_stage_resource(
        &mut self,
        id: BrowserStageId,
        path: &str,
    ) -> Result<Option<BrowserStageResource>, DevError> {
        match self.browser_runtime.as_mut() {
            Some(owner) => owner
                .stage_resource(id.0, path)
                .map(|body| body.map(BrowserStageResource))
                .map_err(DevError::BrowserRuntime),
            None => Ok(None),
        }
    }

    /// Retry on the same supervisor until true. Outstanding bodies retain the
    /// original stage slot AND the runtime/source inputs it still depends on.
    pub fn retire_browser_stage(&mut self, id: BrowserStageId) -> Result<bool, DevError> {
        match self.browser_runtime.as_mut() {
            Some(owner) => owner.retire_stage(id.0).map_err(DevError::BrowserRuntime),
            None => Ok(true),
        }
    }
}

#[cfg(test)]
#[path = "dev_browser_stage_live_tests.rs"]
mod live_tests;
