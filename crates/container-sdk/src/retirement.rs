//! Errors from a known retiring runtime keep their original ownership even
//! when hosts drain the queue after a successful replacement. Unattributed
//! errors retain the ordinary fail-safe error shape.
use crate::{console_events, AcceptedPackIdentity, ContainerSession, SdkError};
use container_bridge::{op, BridgeBatch, EnvelopeKind};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum RetirementOperation {
    Unload,
    CancelNavigation,
    CancelHostCalls,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RetirementErrorOrigin<'a> {
    schema_version: u32,
    phase: &'static str,
    operation: RetirementOperation,
    session_id: &'a str,
    accepted_pack_identity: &'a AcceptedPackIdentity,
}

impl ContainerSession {
    pub(super) fn push_retirement_error(
        &mut self,
        error: impl Serialize,
        identity: Option<&AcceptedPackIdentity>,
        operation: RetirementOperation,
    ) {
        let mut event = json!({"type":"error", "error":error});
        if let Some(identity) = identity {
            event["origin"] = json!(RetirementErrorOrigin {
                schema_version: 1,
                phase: "retirement",
                operation,
                session_id: &identity.session_id,
                accepted_pack_identity: identity,
            });
        }
        self.push_event(event);
    }

    pub(super) fn unload_active_for_retirement(&mut self) -> Result<(), SdkError> {
        let identity = self.accepted_pack_metadata();
        let result = self
            .active
            .as_mut()
            .map(|active| active.dispatch(op::APP_LIFECYCLE, json!({"event":"unload"})));
        if let Some(Err(error)) = result {
            self.push_retirement_error(&error, identity.as_ref(), RetirementOperation::Unload);
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn observe_retirement_result(
        &mut self,
        result: Result<BridgeBatch, SdkError>,
        identity: Option<&AcceptedPackIdentity>,
        operation: RetirementOperation,
    ) {
        match result {
            Err(error) => self.push_retirement_error(error, identity, operation),
            Ok(batch) => {
                for event in console_events(&batch) {
                    self.push_event(event);
                }
                for message in &batch.messages {
                    if message.op == op::ERROR
                        || (message.kind == EnvelopeKind::Response
                            && message.payload.get("ok") == Some(&Value::Bool(false)))
                    {
                        // A malformed or foreign envelope cannot acquire the
                        // retiring instance's authority merely by sharing its
                        // batch. Keep it unattributed and therefore fail-safe.
                        let owner = identity.filter(|owner| owner.session_id == message.session_id);
                        let error = message.payload.get("error").unwrap_or(&message.payload);
                        self.push_retirement_error(error, owner, operation);
                    }
                }
            }
        }
    }
}
