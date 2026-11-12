//! Original-ledger accounting contracts only. These tests do not fabricate
//! accepted runtime/source input capabilities or claim a Node/browser gate.

use super::*;

fn ledger(store: u64) -> Ledger {
    Ledger {
        store,
        next_serial: 0,
        used: Capacity::default(),
        limit: Capacity {
            memory_bytes: 4096 * MIB,
            disk_bytes: 4096 * MIB,
            files: 114_768,
            directories: 14_386,
            namespaces: 8,
            finite_jobs: 1,
        },
    }
}

fn charge(ledger: &mut Ledger) -> Arc<NamespaceCharge> {
    Arc::new(NamespaceCharge {
        reservation: ledger.reserve_source(STAGE_CHARGE).unwrap(),
    })
}

fn refund(ledger: &mut Ledger, charge: Arc<NamespaceCharge>) {
    let owner = Arc::try_unwrap(charge).unwrap();
    ledger.refund(owner.reservation).unwrap();
}

#[test]
fn two_stage_slots_and_charge_are_fixed_logical_reservations() {
    assert_eq!(
        STAGE_CHARGE,
        Capacity {
            memory_bytes: 512 * MIB,
            disk_bytes: 512 * MIB,
            files: 16_392,
            directories: 2050,
            namespaces: 1,
            finite_jobs: 1,
        }
    );
    let store = StageStore::new().unwrap();
    assert_eq!(store.entries.len(), 2);
    assert!(store.is_drained());
    assert!(store.ids().is_empty());
}

#[test]
fn finite_process_slot_is_shared_with_original_runtime_ledger() {
    let mut ledger = ledger(501);
    let mut stage = charge(&mut ledger);
    let occupied = ledger.used;
    assert_eq!(ledger.reserve().unwrap_err(), AdmissionError::Capacity);
    assert_eq!(ledger.used, occupied);
    ledger.retire_process(&mut stage).unwrap();
    assert_eq!(ledger.used.memory_bytes, STAGE_CHARGE.memory_bytes);
    assert_eq!(ledger.used.namespaces, 1);
    assert_eq!(ledger.used.finite_jobs, 0);
    let runtime = Arc::new(NamespaceCharge {
        reservation: ledger.reserve().unwrap(),
    });
    assert_eq!(ledger.used.namespaces, 2);
    refund(&mut ledger, runtime);
    refund(&mut ledger, stage);
    assert_eq!(ledger.used, Capacity::default());
}

#[test]
fn source_and_runtime_ids_must_be_distinct_original_ledger_namespaces() {
    let original = ledger(502);
    let runtime = NamespaceId {
        store: 502,
        serial: 1,
    };
    let portable = NamespaceId {
        store: 502,
        serial: 2,
    };
    assert!(owned_by_ledger(&original, runtime, portable));
    assert!(!owned_by_ledger(&original, runtime, runtime));
    assert!(!owned_by_ledger(&ledger(503), runtime, portable));
    assert!(!owned_by_ledger(
        &original,
        runtime,
        NamespaceId {
            store: 503,
            serial: 2
        }
    ));
    assert!(!owned_by_ledger(
        &original,
        NamespaceId {
            store: 503,
            serial: 1
        },
        portable
    ));
}

#[test]
fn rejected_stage_capacity_preserves_original_ledger_counters() {
    let mut ledger = ledger(504);
    ledger.limit.memory_bytes = STAGE_CHARGE.memory_bytes - 1;
    let before = ledger.used;
    assert_eq!(
        ledger.reserve_source(STAGE_CHARGE).unwrap_err(),
        AdmissionError::Capacity
    );
    assert_eq!(ledger.used, before);
    assert_eq!(ledger.next_serial, 0);
}

#[test]
fn stage_identity_exhaustion_does_not_charge_an_unowned_namespace() {
    let mut ledger = ledger(505);
    ledger.next_serial = u64::MAX;
    assert_eq!(
        ledger.reserve_source(STAGE_CHARGE).unwrap_err(),
        AdmissionError::IdentityExhausted
    );
    assert_eq!(ledger.used, Capacity::default());
    assert_eq!(ledger.next_serial, u64::MAX);
}

#[test]
fn charge_borrower_blocks_final_refund_and_retries_same_token() {
    let mut ledger = ledger(506);
    let charge = charge(&mut ledger);
    let id = charge.reservation.id;
    let borrower = charge.clone();
    let (state, diagnostic) = StageStore::finish_charge(&mut ledger, charge);
    assert!(diagnostic.is_some());
    assert_eq!(ledger.used, STAGE_CHARGE);
    let Some(State::Cleaned(charge)) = state else {
        panic!("same charge must be retained");
    };
    assert_eq!(charge.reservation.id, id);
    drop(borrower);
    let (state, diagnostic) = StageStore::cleanup_state(&mut ledger, State::Cleaned(charge));
    assert!(state.is_none());
    assert!(diagnostic.is_none());
    assert_eq!(ledger.used, Capacity::default());
}

#[test]
fn foreign_refund_keeps_original_token_and_occupied_stage_slot() {
    let mut original = ledger(507);
    let mut foreign = ledger(508);
    let token = original.reserve_source(STAGE_CHARGE).unwrap();
    let id = token.id;
    let mut store = StageStore::new().unwrap();
    store.entries[0] = Some(Entry {
        id,
        state: State::RefundPending(token),
        diagnostic: Some(StoreFailure::Invariant("prior failure byte owner")),
    });
    assert_eq!(
        store.cleanup(&mut foreign, id).unwrap(),
        Step::CleanupPending
    );
    assert_eq!(store.ids(), vec![id]);
    assert!(!store.is_drained());
    assert_eq!(original.used, STAGE_CHARGE);
    assert_eq!(foreign.used, Capacity::default());
    let Some(Entry {
        state: State::RefundPending(token),
        ..
    }) = &store.entries[0]
    else {
        panic!("the original refund token must remain stored");
    };
    assert_eq!(token.id, id);
    assert!(store.diagnostic(id).unwrap().is_some());
    assert_eq!(store.cleanup(&mut original, id).unwrap(), Step::Released);
    assert_eq!(original.used, Capacity::default());
    assert!(store.is_drained());
    assert_eq!(
        store.cleanup(&mut original, id).unwrap_err(),
        AccessError::UnknownNamespace
    );
}

#[test]
fn retirement_never_reopens_a_retired_or_refund_pending_namespace() {
    let mut ledger = ledger(509);
    let token = ledger.reserve_source(STAGE_CHARGE).unwrap();
    let id = token.id;
    let mut store = StageStore::new().unwrap();
    store.entries[0] = Some(Entry {
        id,
        state: State::RefundPending(token),
        diagnostic: None,
    });
    store.retire(id).unwrap();
    store.retire(id).unwrap();
    assert_eq!(store.artifact(id).unwrap_err(), AccessError::NotCaptured);
    assert_eq!(
        store.resource(id, "startup.json").unwrap_err(),
        AccessError::NotCaptured
    );
    assert_eq!(store.poll(&mut ledger, id).unwrap(), Step::Retiring);
    assert_eq!(ledger.used, STAGE_CHARGE);
    assert_eq!(store.cleanup(&mut ledger, id).unwrap(), Step::Released);
    assert!(store.is_drained());
}

#[test]
fn stage_namespace_identity_is_not_reused_after_original_refund() {
    let mut ledger = ledger(510);
    let first = ledger.reserve_source(STAGE_CHARGE).unwrap();
    let first_id = first.id;
    ledger.refund(first).unwrap();
    let second = ledger.reserve_source(STAGE_CHARGE).unwrap();
    assert_ne!(first_id, second.id);
    assert!(second.id.serial > first_id.serial);
    ledger.refund(second).unwrap();
}
