//! Native storage for consent-protected results until their actual guest claim.
//!
//! This is an execution primitive, not a host capability advertisement. A host
//! must also wire owner retirement, snapshots, I/O drain and coordinator ACKs
//! before it can enable the consent-revocation protocol on a transport.

use crate::consent_authority::{
    ConsentAuthorityError, ConsentKind, ConsentOwner, ConsentPermit, ConsentStamp,
    NativeConsentAuthority,
};
use container_core::{ApiDeliveryOutcome, ApiDeliveryProvider};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Mutex,
    thread::ThreadId,
};

const MAX_DELIVERIES: usize = 256;
const MAX_RETAINED_BYTES: usize = 64 * 1024 * 1024;
const MAX_REQUEST_ID: u64 = 9_007_199_254_740_991;

struct Delivery {
    request_id: u64,
    api: String,
    stamp: ConsentStamp,
    result: Result<Value, Value>,
    deadline_ns: Option<u64>,
    bytes: usize,
}

#[derive(Default)]
struct State {
    deliveries: BTreeMap<String, Delivery>,
    bytes: usize,
    permits: BTreeMap<ConsentKind, ConsentPermit>,
    active_claimed: BTreeSet<ConsentKind>,
    retired: bool,
}

impl State {
    /// Pending tickets and entered callbacks share one drain reservation per
    /// kind. A reservation authorizes no data; every disclosure checks its own
    /// stamp at the actual guest claim boundary.
    fn take_idle_permits(&mut self) -> Vec<ConsentPermit> {
        let idle = self
            .permits
            .keys()
            .filter(|kind| {
                !self.active_claimed.contains(kind)
                    && !self
                        .deliveries
                        .values()
                        .any(|delivery| delivery.stamp.fence().kind == **kind)
            })
            .copied()
            .collect::<Vec<_>>();
        idle.into_iter()
            .filter_map(|kind| self.permits.remove(&kind))
            .collect()
    }
}

/// A result can enter JS only by consuming a native ticket at the real
/// microtask boundary. Copying a JSON fence never constructs a `ConsentStamp`.
///
/// Install this object through `JsEngine::install_api_delivery_provider` and
/// pass the ticket as the resolver's fourth argument. The embedding owner must
/// call `finish_checkpoint` on every success, throw and interrupt path; it must
/// not ACK a revocation before that checkpoint and the native resource drain.
pub struct NativeConsentDelivery {
    authority: NativeConsentAuthority,
    owner: ConsentOwner,
    thread: ThreadId,
    state: Mutex<State>,
}

impl NativeConsentDelivery {
    pub fn new(
        authority: NativeConsentAuthority,
        owner: ConsentOwner,
    ) -> Result<Self, ConsentAuthorityError> {
        if !authority.owner_activity(&owner)? {
            return Err(ConsentAuthorityError::RetiredOwner);
        }
        Ok(Self {
            authority,
            owner,
            thread: std::thread::current().id(),
            state: Mutex::new(State::default()),
        })
    }

    /// Accept one native result without exposing any of its data to the guest.
    /// Provider failures remain the original failure even if consent changes
    /// before delivery. Retirement always suppresses the old owner's callback.
    pub fn prepare(
        &self,
        request_id: u64,
        api: &str,
        stamp: ConsentStamp,
        result: Result<Value, Value>,
        deadline_ns: Option<u64>,
    ) -> Result<String, ConsentAuthorityError> {
        if request_id == 0 || request_id > MAX_REQUEST_ID || api.is_empty() || api.len() > 256 {
            return Err(ConsentAuthorityError::InvalidInput);
        }
        // A caller cannot move a stamp to a different execution owner, even if
        // that owner happens to share the same durable consent domain.
        if stamp.fence().owner_revision != self.owner.owner_revision()
            || stamp.fence().scope_id != self.owner.scope_id()
            || !self.authority.owner_activity(stamp.owner())?
            || stamp.owner().application() != self.owner.application()
            || stamp.owner().account() != self.owner.account()
            || stamp.owner().session_id() != self.owner.session_id()
        {
            return Err(ConsentAuthorityError::WrongAuthority);
        }
        // Freeze the terminal winner at native admission. A provider failure
        // accepted before its deadline must not become a timeout merely because
        // the guest checkpoint was delayed. Already expired completions lose to
        // the deadline, and a still-successful result is checked again at claim.
        let result = if deadline_ns.is_some_and(|deadline| deadline <= crate::unix_now_ns()) {
            Err(failure_value(
                api,
                "ERR_TIMEOUT",
                "host call deadline exceeded",
            ))
        } else {
            result
        };
        struct ByteCount(usize);
        impl std::io::Write for ByteCount {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                if bytes.len() > MAX_RETAINED_BYTES.saturating_sub(self.0) {
                    return Err(std::io::Error::other("native delivery byte limit exceeded"));
                }
                self.0 += bytes.len();
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let mut count = ByteCount(0);
        serde_json::to_writer(
            &mut count,
            match &result {
                Ok(value) | Err(value) => value,
            },
        )
        .map_err(|_| ConsentAuthorityError::Capacity)?;
        let bytes = count.0;
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| ConsentAuthorityError::InvalidInput)?;
        let ticket = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut state = self
            .state
            .lock()
            .map_err(|_| ConsentAuthorityError::Poisoned)?;
        if state.retired || !self.authority.owner_activity(&self.owner)? {
            return Err(ConsentAuthorityError::RetiredOwner);
        }
        if state
            .deliveries
            .values()
            .any(|delivery| delivery.request_id == request_id)
        {
            return Err(ConsentAuthorityError::Conflict);
        }
        if state.deliveries.len() >= MAX_DELIVERIES
            || bytes > MAX_RETAINED_BYTES.saturating_sub(state.bytes)
            || state.deliveries.contains_key(&ticket)
        {
            return Err(ConsentAuthorityError::Capacity);
        }
        let kind = stamp.fence().kind;
        if let std::collections::btree_map::Entry::Vacant(entry) = state.permits.entry(kind) {
            // Admission into settling is part of drain accounting, including
            // failure callbacks that have not yet entered the VM. It must not
            // be deferred until the microtask actually starts.
            entry.insert(self.authority.claim_terminal(&self.owner, kind)?);
        }
        state.deliveries.insert(
            ticket.clone(),
            Delivery {
                request_id,
                api: api.to_owned(),
                stamp,
                result,
                deadline_ns,
                bytes,
            },
        );
        state.bytes += bytes;
        Ok(ticket)
    }

    /// If the engine rejects queueing (for example, its request was already
    /// settled), the owner must abandon the native ticket and retained bytes.
    pub fn discard(&self, ticket: &str) -> Result<bool, ConsentAuthorityError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ConsentAuthorityError::Poisoned)?;
        let Some(delivery) = state.deliveries.remove(ticket) else {
            return Ok(false);
        };
        state.bytes -= delivery.bytes;
        let permits = state.take_idle_permits();
        drop(state);
        drop(permits);
        Ok(true)
    }

    /// Drop unpublished sensitive data immediately. In-flight callbacks retain
    /// their permits until the owner has actually left the checkpoint.
    pub fn retire(&self) -> Result<(), ConsentAuthorityError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| ConsentAuthorityError::Poisoned)?;
        state.retired = true;
        state.deliveries.clear();
        state.bytes = 0;
        let permits = state.take_idle_permits();
        drop(state);
        drop(permits);
        Ok(())
    }

    /// The owner lane calls this after its call + complete microtask checkpoint
    /// (or after an engine fault has stopped execution). Drop outside our lock.
    pub fn finish_checkpoint(&self) -> Result<(), ConsentAuthorityError> {
        if std::thread::current().id() != self.thread {
            return Err(ConsentAuthorityError::InvalidInput);
        }
        let permits = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| ConsentAuthorityError::Poisoned)?;
            state.active_claimed.clear();
            state.take_idle_permits()
        };
        drop(permits);
        Ok(())
    }

    /// Counts native retained results, not native HTTP/UI resources. Their
    /// independent drain and ACK must still be tracked by the owning session.
    pub fn retained(&self) -> Result<(usize, usize), ConsentAuthorityError> {
        let state = self
            .state
            .lock()
            .map_err(|_| ConsentAuthorityError::Poisoned)?;
        Ok((state.deliveries.len(), state.bytes))
    }
}

fn failure_value(api: &str, code: &str, message: &str) -> Value {
    json!({
        "api":api,"code":code,"message":message,"errMsg":format!("{api}:fail {message}"),
    })
}
fn failure(api: &str, code: &str, message: &str) -> ApiDeliveryOutcome {
    ApiDeliveryOutcome::Failure(failure_value(api, code, message))
}

impl ApiDeliveryProvider for NativeConsentDelivery {
    fn claim(&self, request_id: u64, ticket: &str) -> ApiDeliveryOutcome {
        if std::thread::current().id() != self.thread {
            return failure(
                "host API",
                "ERR_API_DELIVERY",
                "claim requires the engine owner thread",
            );
        }
        let Ok(mut state) = self.state.lock() else {
            return failure("host API", "ERR_CANCELLED", "delivery state unavailable");
        };
        let owner_activity = self.authority.owner_activity(&self.owner);
        if state.retired || owner_activity == Ok(false) {
            state.deliveries.clear();
            state.bytes = 0;
            let permits = state.take_idle_permits();
            drop(state);
            drop(permits);
            return ApiDeliveryOutcome::Retired;
        }
        // A mismatching request must not consume another pending request's
        // ticket. A ticket is one-use after an exact request match.
        let Some(delivery) = state.deliveries.get(ticket) else {
            return ApiDeliveryOutcome::Retired;
        };
        if delivery.request_id != request_id {
            return failure(
                "host API",
                "ERR_INVALID_REQUEST",
                "delivery request mismatch",
            );
        }
        let delivery = state
            .deliveries
            .remove(ticket)
            .expect("checked native delivery");
        state.bytes -= delivery.bytes;
        let kind = delivery.stamp.fence().kind;
        state.active_claimed.insert(kind);
        debug_assert!(state.permits.contains_key(&kind));
        match delivery.result {
            Err(error) => ApiDeliveryOutcome::Failure(error),
            Ok(value) => {
                if delivery
                    .deadline_ns
                    .is_some_and(|deadline| deadline <= crate::unix_now_ns())
                {
                    return failure(&delivery.api, "ERR_TIMEOUT", "host call deadline exceeded");
                }
                if let Err(error) = owner_activity {
                    return failure(&delivery.api, error.code(), &error.to_string());
                }
                // The settling reservation keeps revocation pending; only this
                // fresh per-result check authorizes a successful disclosure.
                match self.authority.check(&delivery.stamp) {
                    Ok(()) => ApiDeliveryOutcome::Success(value),
                    Err(error) => {
                        if self.authority.owner_activity(&self.owner) == Ok(false) {
                            ApiDeliveryOutcome::Retired
                        } else {
                            failure(&delivery.api, "ERR_PERMISSION_DENIED", &error.to_string())
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::consent_authority::{ConsentKind, ConsentOperationStatus, ConsentState};
    use crate::{HostAccount, TrustedApplication};
    use std::{sync::Arc, time::Duration};

    fn fixture() -> (
        NativeConsentAuthority,
        ConsentOwner,
        Arc<NativeConsentDelivery>,
    ) {
        let authority = NativeConsentAuthority::new();
        let owner = authority
            .register_owner(
                TrustedApplication {
                    host_app_id: "delivery-host".into(),
                    tenant_id: "tenant".into(),
                    publisher_id: "publisher".into(),
                    app_id: "app".into(),
                    environment: "develop".into(),
                    version: "1".into(),
                    pack_root: "a".repeat(64),
                },
                HostAccount {
                    principal_id: Some("alice".into()),
                    epoch: 1,
                },
                "delivery-owner".into(),
            )
            .unwrap();
        let observation = authority
            .capture_observation(&owner, ConsentKind::Profile, Duration::from_secs(60))
            .unwrap();
        authority
            .initialize(
                &observation,
                ConsentState {
                    revision: 7.into(),
                    granted: true,
                    expires_in: 60,
                },
            )
            .unwrap();
        let delivery =
            Arc::new(NativeConsentDelivery::new(authority.clone(), owner.clone()).unwrap());
        (authority, owner, delivery)
    }

    #[test]
    fn consent_delivery_native_result_is_denied_after_shared_revoke_and_released_once() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp,
                Ok(json!({"userInfo":{"nickName":"Alice"}})),
                None,
            )
            .unwrap();
        let operation = authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_decision_0001")
            .unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        let ApiDeliveryOutcome::Failure(error) = delivery.claim(1, &ticket) else {
            panic!("revoked native result reached guest");
        };
        assert_eq!(error["code"], "ERR_PERMISSION_DENIED");
        assert!(error.get("userInfo").is_none());
        assert_eq!(delivery.retained().unwrap(), (0, 0));
        assert_eq!(delivery.claim(1, &ticket), ApiDeliveryOutcome::Retired);
    }

    #[test]
    fn consent_delivery_claimed_permit_blocks_ack_through_checkpoint_and_retirement() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(1, "wx.getUserProfile", stamp, Ok(json!({"ok":true})), None)
            .unwrap();
        assert_eq!(
            delivery.claim(1, &ticket),
            ApiDeliveryOutcome::Success(json!({"ok":true}))
        );
        let operation = authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_decision_0002")
            .unwrap();
        authority
            .commit_revocation(&operation, operation.decision_id(), 8.into())
            .unwrap();
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, 1.into(), true)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        // Merely marking the ledger retired cannot acknowledge an executing
        // callback or erase its admitted disclosure permit.
        delivery.retire().unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        delivery.finish_checkpoint().unwrap();
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, 1.into(), true)
            .unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
    }

    fn committed_revoke(authority: &NativeConsentAuthority, owner: &ConsentOwner) -> String {
        let operation = authority
            .begin_revocation(owner, ConsentKind::Profile, "revocation_pending_00001")
            .unwrap();
        authority
            .commit_revocation(&operation, operation.decision_id(), 8.into())
            .unwrap();
        authority
            .acknowledge_owner(owner, ConsentKind::Profile, 1.into(), true)
            .unwrap();
        operation.operation_id().to_owned()
    }

    #[test]
    fn consent_delivery_pending_terminal_blocks_early_ack_and_an_empty_checkpoint() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let original = json!({"errCode":2001,"errMsg":"getUserProfile:fail user denied"});
        let ticket = delivery
            .prepare(1, "wx.getUserProfile", stamp, Err(original.clone()), None)
            .unwrap();
        let operation = committed_revoke(&authority, &owner);
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending,
            "unclaimed terminal callbacks remain in the drain set"
        );
        assert_eq!(
            delivery.claim(1, &ticket),
            ApiDeliveryOutcome::Failure(original)
        );
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending
        );
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Complete
        );
    }

    #[test]
    fn consent_delivery_unclaimed_tickets_keep_reservation_across_checkpoints() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let first = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp.clone(),
                Ok(json!({"ok":1})),
                None,
            )
            .unwrap();
        let second = delivery
            .prepare(2, "wx.getUserProfile", stamp, Ok(json!({"ok":2})), None)
            .unwrap();
        assert_eq!(
            delivery.claim(1, &first),
            ApiDeliveryOutcome::Success(json!({"ok":1}))
        );
        delivery.finish_checkpoint().unwrap();
        let operation = committed_revoke(&authority, &owner);
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending
        );
        assert!(matches!(
            delivery.claim(2, &second),
            ApiDeliveryOutcome::Failure(_)
        ));
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Complete
        );
    }

    #[test]
    fn consent_delivery_discard_and_retire_release_idle_but_not_active_reservations() {
        for retire in [false, true] {
            let (authority, owner, delivery) = fixture();
            let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
            let ticket = delivery
                .prepare(1, "wx.getUserProfile", stamp, Ok(json!({})), None)
                .unwrap();
            let operation = committed_revoke(&authority, &owner);
            assert_eq!(
                authority.query_operation(&operation).unwrap().status,
                ConsentOperationStatus::Pending
            );
            if retire {
                delivery.retire().unwrap();
            } else {
                assert!(delivery.discard(&ticket).unwrap());
            }
            assert_eq!(
                authority.query_operation(&operation).unwrap().status,
                ConsentOperationStatus::Complete
            );
            assert_eq!(delivery.retained().unwrap(), (0, 0));
        }
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let first = delivery
            .prepare(1, "wx.getUserProfile", stamp.clone(), Ok(json!({})), None)
            .unwrap();
        let second = delivery
            .prepare(2, "wx.getUserProfile", stamp, Ok(json!({})), None)
            .unwrap();
        assert!(matches!(
            delivery.claim(1, &first),
            ApiDeliveryOutcome::Success(_)
        ));
        let operation = committed_revoke(&authority, &owner);
        assert!(delivery.discard(&second).unwrap());
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending
        );
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Complete
        );
    }

    #[test]
    fn consent_delivery_many_same_kind_callbacks_share_drain_without_skipping_checks() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let mut tickets = Vec::new();
        for id in 1..=128 {
            tickets.push((
                id,
                delivery
                    .prepare(
                        id,
                        "wx.getUserProfile",
                        stamp.clone(),
                        Ok(json!({"id":id})),
                        None,
                    )
                    .unwrap(),
            ));
        }
        for (id, ticket) in tickets.iter().take(100) {
            assert_eq!(
                delivery.claim(*id, ticket),
                ApiDeliveryOutcome::Success(json!({"id":id}))
            );
        }
        let operation = committed_revoke(&authority, &owner);
        for (id, ticket) in tickets.iter().skip(100) {
            assert!(matches!(
                delivery.claim(*id, ticket),
                ApiDeliveryOutcome::Failure(_)
            ));
        }
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending
        );
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Complete
        );
    }

    #[test]
    fn consent_delivery_preserves_original_error_and_timeout_wins_without_profile_data() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let raw = json!({"code":"permission_denied","errCode":2001,"errMsg":"getUserProfile:fail user denied","publicDetail":{"limited":true}});
        let first = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp.clone(),
                Err(raw.clone()),
                None,
            )
            .unwrap();
        let second = delivery
            .prepare(
                2,
                "wx.getUserProfile",
                stamp,
                Ok(json!({"userInfo":{"nickName":"Alice"}})),
                Some(0),
            )
            .unwrap();
        authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_decision_0003")
            .unwrap();
        assert_eq!(delivery.claim(1, &first), ApiDeliveryOutcome::Failure(raw));
        let ApiDeliveryOutcome::Failure(error) = delivery.claim(2, &second) else {
            panic!("expired disclosure");
        };
        assert_eq!(error["code"], "ERR_TIMEOUT");
        assert_eq!(delivery.retained().unwrap(), (0, 0));
    }

    #[test]
    fn consent_delivery_original_failure_wins_before_delayed_guest_checkpoint() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let original = json!({"errCode":2001,"errMsg":"getUserProfile:fail user denied","publicDetail":{"limited":true}});
        let ticket = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp.clone(),
                Err(original.clone()),
                Some(u64::MAX),
            )
            .unwrap();
        // Simulate a later guest checkpoint past its absolute deadline without
        // a timing-sensitive sleep. The error was already admitted into settling.
        delivery
            .state
            .lock()
            .unwrap()
            .deliveries
            .get_mut(&ticket)
            .unwrap()
            .deadline_ns = Some(0);
        authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_error_winner_01")
            .unwrap();
        assert_eq!(
            delivery.claim(1, &ticket),
            ApiDeliveryOutcome::Failure(original.clone())
        );
        let expired = delivery
            .prepare(2, "wx.getUserProfile", stamp, Err(original), Some(0))
            .unwrap();
        let ApiDeliveryOutcome::Failure(error) = delivery.claim(2, &expired) else {
            panic!("expired completion must fail");
        };
        assert_eq!(error["code"], "ERR_TIMEOUT");
        assert!(error.get("publicDetail").is_none());
        delivery.finish_checkpoint().unwrap();
    }

    #[test]
    fn consent_delivery_rejects_foreign_authority_errors_and_retired_owner() {
        let (_, _, delivery) = fixture();
        // Same durable scope and numeric owner revision in a second authority
        // still does not provide the first authority's native capability.
        let (foreign, owner, _) = fixture();
        let stamp = foreign.capture(&owner, ConsentKind::Profile).unwrap();
        assert_eq!(
            delivery.prepare(
                1,
                "wx.getUserProfile",
                stamp,
                Err(json!({"foreignSecret":true})),
                None
            ),
            Err(ConsentAuthorityError::WrongAuthority)
        );
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp,
                Ok(json!({"userInfo":{"nickName":"Alice"}})),
                None,
            )
            .unwrap();
        authority.retire_owner(&owner).unwrap();
        assert_eq!(delivery.claim(1, &ticket), ApiDeliveryOutcome::Retired);
        assert_eq!(delivery.retained().unwrap(), (0, 0));
    }

    #[test]
    fn consent_delivery_wrong_request_does_not_consume_and_rejected_queue_can_discard() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(
                1,
                "wx.getUserProfile",
                stamp.clone(),
                Ok(json!({"ok":true})),
                None,
            )
            .unwrap();
        assert!(matches!(
            delivery.claim(2, &ticket),
            ApiDeliveryOutcome::Failure(_)
        ));
        assert_eq!(delivery.retained().unwrap().0, 1);
        assert_eq!(
            delivery.prepare(1, "wx.getUserProfile", stamp, Ok(json!({})), None),
            Err(ConsentAuthorityError::Conflict)
        );
        assert!(delivery.discard(&ticket).unwrap());
        assert!(!delivery.discard(&ticket).unwrap());
        assert_eq!(delivery.retained().unwrap(), (0, 0));
    }

    #[test]
    fn consent_delivery_queue_backpressure_is_bounded_and_retirement_releases_bytes() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        for id in 1..=MAX_DELIVERIES as u64 {
            delivery
                .prepare(
                    id,
                    "wx.getUserProfile",
                    stamp.clone(),
                    Ok(json!({"small":true})),
                    None,
                )
                .unwrap();
        }
        assert_eq!(
            delivery.prepare(
                MAX_DELIVERIES as u64 + 1,
                "wx.getUserProfile",
                stamp,
                Ok(json!({})),
                None
            ),
            Err(ConsentAuthorityError::Capacity)
        );
        delivery.retire().unwrap();
        assert_eq!(delivery.retained().unwrap(), (0, 0));
    }

    #[test]
    fn consent_delivery_other_thread_cannot_claim_or_release_an_active_checkpoint() {
        let (authority, owner, delivery) = fixture();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(1, "wx.getUserProfile", stamp, Ok(json!({"ok":true})), None)
            .unwrap();
        let other = delivery.clone();
        let other_ticket = ticket.clone();
        let (claim, finish) =
            std::thread::spawn(move || (other.claim(1, &other_ticket), other.finish_checkpoint()))
                .join()
                .unwrap();
        assert!(matches!(claim, ApiDeliveryOutcome::Failure(_)));
        assert_eq!(finish, Err(ConsentAuthorityError::InvalidInput));
        assert_eq!(delivery.retained().unwrap().0, 1);
        assert_eq!(
            delivery.claim(1, &ticket),
            ApiDeliveryOutcome::Success(json!({"ok":true}))
        );
        let operation = authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_decision_0005")
            .unwrap();
        authority
            .commit_revocation(&operation, operation.decision_id(), 8.into())
            .unwrap();
        authority
            .acknowledge_owner(&owner, ConsentKind::Profile, 1.into(), true)
            .unwrap();
        let other = delivery.clone();
        assert_eq!(
            std::thread::spawn(move || other.finish_checkpoint())
                .join()
                .unwrap(),
            Err(ConsentAuthorityError::InvalidInput)
        );
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Pending
        );
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority
                .query_operation(operation.operation_id())
                .unwrap()
                .status,
            ConsentOperationStatus::Complete
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn real_engine_claim<E: container_core::JsEngine + Default>() {
        use container_core::CallTarget;
        let (authority, owner, delivery) = fixture();
        let mut engine = E::default();
        engine
            .install_api_delivery_provider(delivery.clone())
            .unwrap();
        let module = engine
            .load_module(
                br#"
          let log=[];
          exports.start=function(){
            __container_api_call('wx.getUserProfile',{
              success:function(v){log.push(['success',v]);},
              fail:function(v){log.push(['fail',v]);},
              complete:function(){log.push(['complete']);}
            }).then(function(){log.push(['resolved']);},function(){log.push(['rejected']);});
            return __container_api_id;
          };
          exports.read=function(){return {log:log};};
        "#,
            )
            .unwrap();
        let id = engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "start".into(),
                },
                vec![],
            )
            .unwrap()[0]
            .as_u64()
            .unwrap();
        let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
        let ticket = delivery
            .prepare(
                id,
                "wx.getUserProfile",
                stamp,
                Ok(json!({"userInfo":{"nickName":"Alice"}})),
                None,
            )
            .unwrap();
        engine
            .call(
                CallTarget::Global {
                    name: "__container_resolve_api".into(),
                },
                vec![json!(id), Value::Null, Value::Null, json!(ticket)],
            )
            .unwrap();
        assert_eq!(
            delivery.retained().unwrap().0,
            1,
            "result must stay native until checkpoint"
        );
        authority
            .begin_revocation(&owner, ConsentKind::Profile, "revocation_decision_0004")
            .unwrap();
        engine.drain_microtasks().unwrap();
        delivery.finish_checkpoint().unwrap();
        let result = engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "read".into(),
                },
                vec![],
            )
            .unwrap()
            .remove(0);
        let log = &result["log"];
        assert_eq!(log[0][0], "fail");
        assert_eq!(log[0][1]["code"], "ERR_PERMISSION_DENIED");
        assert_eq!(log[1][0], "complete");
        assert_eq!(log[2][0], "rejected");
        assert_eq!(log.as_array().unwrap().len(), 3);
        assert_eq!(delivery.retained().unwrap(), (0, 0));
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn consent_delivery_real_quickjs_uses_shared_authority_at_microtask_claim() {
        real_engine_claim::<container_engine_quickjs::QuickJsEngine>();
    }
    #[cfg(feature = "v8-native")]
    #[test]
    fn consent_delivery_real_v8_uses_shared_authority_at_microtask_claim() {
        real_engine_claim::<container_engine_v8::V8Engine>();
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn real_callback_revocation<E: container_core::JsEngine + Default>(first_error: bool) {
        use container_core::{CallTarget, SyncHostApi};
        struct RevokeDuringCallback {
            authority: NativeConsentAuthority,
            owner: ConsentOwner,
            operation: Mutex<Option<(String, ConsentOperationStatus)>>,
        }
        impl SyncHostApi for RevokeDuringCallback {
            fn supported_apis(&self) -> Vec<String> {
                vec!["test.revoke".into()]
            }
            fn invoke(&self, name: &str, _: Value) -> Result<Value, Value> {
                assert_eq!(name, "test.revoke");
                let operation = self
                    .authority
                    .begin_revocation(
                        &self.owner,
                        ConsentKind::Profile,
                        "revocation_callback_00001",
                    )
                    .unwrap();
                self.authority
                    .commit_revocation(&operation, operation.decision_id(), 8.into())
                    .unwrap();
                self.authority
                    .acknowledge_owner(&self.owner, ConsentKind::Profile, 1.into(), true)
                    .unwrap();
                let receipt = self
                    .authority
                    .query_operation(operation.operation_id())
                    .unwrap();
                *self.operation.lock().unwrap() = Some((receipt.operation_id, receipt.status));
                // Never wait for the callback's own active permit.
                Ok(Value::Null)
            }
        }
        let (authority, owner, delivery) = fixture();
        let revoke = Arc::new(RevokeDuringCallback {
            authority: authority.clone(),
            owner: owner.clone(),
            operation: Mutex::new(None),
        });
        let mut engine = E::default();
        engine
            .install_api_delivery_provider(delivery.clone())
            .unwrap();
        engine.install_sync_host_api(revoke.clone()).unwrap();
        let module = engine.load_module(br#"
          const log=[];
          exports.start=function(label){
            __container_api_call('wx.getUserProfile',{
              success:function(){log.push(label+'.success'); if(label==='first') __container_host_sync_call('test.revoke','{}');},
              fail:function(error){log.push(label+'.fail'); if(label==='first') __container_host_sync_call('test.revoke','{}');},
              complete:function(){log.push(label+'.complete');}
            }).then(function(){log.push(label+'.resolved');},function(){log.push(label+'.rejected');});
            return __container_api_id;
          };
          exports.read=function(){return {log:log};};
        "#).unwrap();
        for label in ["first", "second"] {
            let id = engine
                .call(
                    CallTarget::Module {
                        id: module,
                        export: "start".into(),
                    },
                    vec![json!(label)],
                )
                .unwrap()[0]
                .as_u64()
                .unwrap();
            let stamp = authority.capture(&owner, ConsentKind::Profile).unwrap();
            let ticket = delivery
                .prepare(
                    id,
                    "wx.getUserProfile",
                    stamp,
                    if first_error && label == "first" {
                        Err(json!({"errCode":2001,"errMsg":"getUserProfile:fail user denied"}))
                    } else {
                        Ok(json!({"userInfo":{"nickName":"Alice"}}))
                    },
                    None,
                )
                .unwrap();
            engine
                .call(
                    CallTarget::Global {
                        name: "__container_resolve_api".into(),
                    },
                    vec![json!(id), Value::Null, Value::Null, json!(ticket)],
                )
                .unwrap();
        }
        engine.drain_microtasks().unwrap();
        let (operation, status) = revoke
            .operation
            .lock()
            .unwrap()
            .clone()
            .expect("trusted callback ran revoke");
        assert_eq!(
            status,
            ConsentOperationStatus::Pending,
            "callback must not complete its own revoke barrier"
        );
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Pending
        );
        let result = engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "read".into(),
                },
                vec![],
            )
            .unwrap()
            .remove(0);
        let first_callback = if first_error {
            "first.fail"
        } else {
            "first.success"
        };
        let first_promise = if first_error {
            "first.rejected"
        } else {
            "first.resolved"
        };
        assert_eq!(
            result["log"],
            json!([
                first_callback,
                "first.complete",
                "second.fail",
                "second.complete",
                first_promise,
                "second.rejected"
            ])
        );
        delivery.finish_checkpoint().unwrap();
        assert_eq!(
            authority.query_operation(&operation).unwrap().status,
            ConsentOperationStatus::Complete
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn consent_delivery_real_quickjs_callback_revoke_blocks_next_claim_without_deadlock() {
        real_callback_revocation::<container_engine_quickjs::QuickJsEngine>(false);
    }
    #[cfg(feature = "v8-native")]
    #[test]
    fn consent_delivery_real_v8_callback_revoke_blocks_next_claim_without_deadlock() {
        real_callback_revocation::<container_engine_v8::V8Engine>(false);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn consent_delivery_real_quickjs_failure_callback_cannot_complete_own_revoke() {
        real_callback_revocation::<container_engine_quickjs::QuickJsEngine>(true);
    }
    #[cfg(feature = "v8-native")]
    #[test]
    fn consent_delivery_real_v8_failure_callback_cannot_complete_own_revoke() {
        real_callback_revocation::<container_engine_v8::V8Engine>(true);
    }
}
