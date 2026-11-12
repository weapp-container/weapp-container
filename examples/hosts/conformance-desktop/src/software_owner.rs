//! A window owner's publication ledger. Metadata tests never claim a draw/ACK.
use crate::pack::Result;
use container_runtime::{DevRasterPresentationTarget, DevRasterPresentationTicket};
#[derive(Clone, Debug)]
pub struct SoftwareSubmission {
    ticket: DevRasterPresentationTicket,
}
pub struct SoftwarePublicationOwner {
    id: String,
    generation: u64,
    next_frame: u64,
    candidate: Option<DevRasterPresentationTarget>,
    submitted: Option<DevRasterPresentationTicket>,
}
impl SoftwarePublicationOwner {
    pub fn new(id: String) -> Self {
        Self {
            id,
            generation: 1,
            next_frame: 1,
            candidate: None,
            submitted: None,
        }
    }
    pub fn prepare(
        &mut self,
        session_id: String,
        source_frame_id: u64,
        render_revision: u64,
        logical: (u32, u32),
        pixels: (u32, u32),
    ) -> Result<DevRasterPresentationTarget> {
        if self.candidate.is_some() || self.submitted.is_some() {
            return Err("software publication already in flight".into());
        }
        let sequence = self.next_frame;
        self.next_frame = sequence
            .checked_add(1)
            .ok_or("software publication sequence exhausted")?;
        let target = DevRasterPresentationTarget {
            session_id,
            preview_id: self.id.clone(),
            preview_generation: self.generation,
            frame_id: sequence,
            source_frame_id,
            render_revision,
            config_generation: self.generation,
            logical_width: logical.0,
            logical_height: logical.1,
            width: pixels.0,
            height: pixels.1,
        };
        self.candidate = Some(target.clone());
        Ok(target)
    }
    /// Production caller invokes this only after its real softbuffer submit.
    /// It grants a single-use local receipt, not runtime presented/ready state.
    pub fn record_submission(
        &mut self,
        ticket: DevRasterPresentationTicket,
    ) -> Result<SoftwareSubmission> {
        if self.candidate.as_ref() != Some(&ticket.target) || self.submitted.is_some() {
            return Err("software submission differs from current owner publication".into());
        }
        self.candidate = None;
        self.submitted = Some(ticket.clone());
        Ok(SoftwareSubmission { ticket })
    }
    pub fn consume(
        &mut self,
        submission: SoftwareSubmission,
    ) -> Result<DevRasterPresentationTicket> {
        if self.submitted.as_ref() != Some(&submission.ticket)
            || submission.ticket.target.preview_id != self.id
            || submission.ticket.target.preview_generation != self.generation
            || submission.ticket.target.config_generation != self.generation
        {
            return Err(
                "software submission is stale, duplicated or belongs to another window owner"
                    .into(),
            );
        }
        Ok(self.submitted.take().unwrap())
    }
    pub fn abort(&mut self) {
        self.candidate = None;
        self.submitted = None;
    }
    pub fn invalidate(&mut self) -> Result<()> {
        self.abort();
        self.generation = self
            .generation
            .checked_add(1)
            .ok_or("software window generation exhausted")?;
        Ok(())
    }
}
/// Arm on the existing runtime, then call the surface owner's real submit.
/// Failure retires both local authority and the pending runtime ticket without
/// executing ready/observer hooks. This seam also permits a negative-only unit
/// test which fails submission and never fabricates a native presentation ACK.
pub fn submit_raster_publication(
    owner: &mut SoftwarePublicationOwner,
    session: &mut container_runtime::Session,
    target: DevRasterPresentationTarget,
    submit: impl FnOnce() -> Result<()>,
) -> Result<SoftwareSubmission> {
    let result = (|| {
        let ticket = session.arm_dev_raster_presentation(target)?;
        submit()?;
        owner.record_submission(ticket)
    })();
    if result.is_err() {
        owner.abort();
        session.suspend_dev_raster_presentation();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    // Pure ledger metadata, deliberately synthetic; no Session/window/ACK.
    fn ticket(owner: &mut SoftwarePublicationOwner) -> DevRasterPresentationTicket {
        DevRasterPresentationTicket {
            version: "synthetic-ledger-test-only".into(),
            presentation_epoch: "1".into(),
            target: owner
                .prepare("test-session".into(), 11, 7, (375, 667), (375, 667))
                .unwrap(),
        }
    }
    #[test]
    fn duplicate_receipt_is_consumed_once_and_foreign_owner_is_rejected() {
        let mut owner = SoftwarePublicationOwner::new("window-a".into());
        let t = ticket(&mut owner);
        let receipt = owner.record_submission(t.clone()).unwrap();
        let duplicate = receipt.clone();
        let mut foreign = SoftwarePublicationOwner::new("window-b".into());
        assert!(foreign.consume(receipt.clone()).is_err());
        assert_eq!(owner.consume(receipt).unwrap(), t);
        assert!(owner.consume(duplicate).is_err());
    }
    #[test]
    fn resize_invalidates_exact_old_receipt_and_allocates_new_generation() {
        let mut owner = SoftwarePublicationOwner::new("window-a".into());
        let old = ticket(&mut owner);
        let receipt = owner.record_submission(old.clone()).unwrap();
        owner.invalidate().unwrap();
        assert!(owner.consume(receipt).is_err());
        let new = ticket(&mut owner);
        assert!(new.target.preview_generation > old.target.preview_generation);
        assert!(new.target.frame_id > old.target.frame_id);
        assert!(owner.record_submission(old).is_err());
        owner.record_submission(new).unwrap();
    }
    #[test]
    fn failed_submit_cannot_publish_a_receipt_and_wrong_pixels_are_rejected() {
        let mut owner = SoftwarePublicationOwner::new("window-a".into());
        let old = ticket(&mut owner);
        owner.abort();
        assert!(owner.record_submission(old).is_err());
        let mut wrong = ticket(&mut owner);
        wrong.target.width += 1;
        assert!(owner.record_submission(wrong).is_err());
        owner.abort();
    }
}
