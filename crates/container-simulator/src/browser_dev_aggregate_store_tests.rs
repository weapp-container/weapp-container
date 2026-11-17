//! Logical accounting and private-state identity contracts. Actual finite-job
//! and body retirement contracts also run through DevSupervisor.

use super::*;

fn ledger(store: u64) -> Ledger {
    Ledger {
        store,
        next_serial: 0,
        used: Capacity::default(),
        limit: LIMIT,
    }
}

fn charge(ledger: &mut Ledger) -> Arc<NamespaceCharge> {
    Arc::new(NamespaceCharge {
        reservation: ledger.reserve().unwrap(),
    })
}

fn refund(ledger: &mut Ledger, charge: Arc<NamespaceCharge>) {
    let owner = Arc::try_unwrap(charge).unwrap();
    ledger.refund(owner.reservation).unwrap();
}

#[test]
fn runtime_reservation_already_includes_result_capture_and_cleanup_slot() {
    let mut ledger = ledger(10);
    let charge = charge(&mut ledger);
    assert_eq!(ledger.used, RUNTIME_CHARGE);
    assert_eq!(charge.reservation.remaining.finite_jobs, 1);
    assert_eq!(charge.reservation.remaining.namespaces, 1);
    assert!(charge.reservation.remaining.memory_bytes >= 272 * MIB);
    // This test makes no allocation/RSS claim for the policy margin.
    refund(&mut ledger, charge);
    assert_eq!(ledger.used, Capacity::default());
}

#[test]
fn finite_slot_is_independent_of_retained_namespace() {
    let mut ledger = ledger(11);
    let mut first = charge(&mut ledger);
    let occupied = ledger.used;
    assert_eq!(ledger.reserve().unwrap_err(), AdmissionError::Capacity);
    assert_eq!(ledger.used, occupied);
    ledger.retire_process(&mut first).unwrap();
    assert_eq!(ledger.used.memory_bytes, RUNTIME_CHARGE.memory_bytes);
    assert_eq!(ledger.used.namespaces, 1);
    assert_eq!(ledger.used.finite_jobs, 0);
    let mut second = charge(&mut ledger);
    ledger.retire_process(&mut second).unwrap();
    let both_occupied = ledger.used;
    assert_eq!(ledger.reserve().unwrap_err(), AdmissionError::Capacity);
    assert_eq!(ledger.used, both_occupied);
    refund(&mut ledger, first);
    refund(&mut ledger, second);
    assert_eq!(ledger.used, Capacity::default());
}

#[test]
fn finite_slot_retires_once_and_error_does_not_mutate_accounting() {
    let mut ledger = ledger(12);
    let mut charge = charge(&mut ledger);
    ledger.retire_process(&mut charge).unwrap();
    let occupied = ledger.used;
    assert!(ledger.retire_process(&mut charge).is_err());
    assert_eq!(ledger.used, occupied);
    assert_eq!(charge.reservation.remaining.finite_jobs, 0);
    refund(&mut ledger, charge);
}

#[test]
fn unexpected_charge_borrow_cannot_retire_job_slot() {
    let mut ledger = ledger(13);
    let mut charge = charge(&mut ledger);
    let borrower = charge.clone();
    assert!(ledger.retire_process(&mut charge).is_err());
    assert_eq!(ledger.used, RUNTIME_CHARGE);
    drop(borrower);
    ledger.retire_process(&mut charge).unwrap();
    refund(&mut ledger, charge);
}

#[test]
fn foreign_refund_returns_original_token_without_mutating_either_ledger() {
    let mut first = ledger(14);
    let mut second = ledger(15);
    let reservation = first.reserve().unwrap();
    let id = reservation.id;
    let reservation = second.refund(reservation).unwrap_err();
    assert_eq!(reservation.id, id);
    assert_eq!(first.used, RUNTIME_CHARGE);
    assert_eq!(second.used, Capacity::default());
    first.refund(reservation).unwrap();
}

#[test]
fn dropped_token_does_not_imply_successful_cleanup_or_refund() {
    let mut ledger = ledger(16);
    let reservation = ledger.reserve().unwrap();
    drop(reservation);
    assert_eq!(ledger.used, RUNTIME_CHARGE);
    // Expected abandoned-reservation log; this isolated test ledger is not a
    // recovery service and the case intentionally cannot mint a refund token.
}

#[test]
fn namespace_ids_are_not_reused_after_refund() {
    let mut ledger = ledger(17);
    let first = ledger.reserve().unwrap();
    let first_id = first.id;
    ledger.refund(first).unwrap();
    let second = ledger.reserve().unwrap();
    assert_ne!(first_id, second.id);
    ledger.refund(second).unwrap();
}

#[test]
fn empty_store_does_not_adopt_foreign_metadata_handle() {
    let mut store = StaticRuntimeStore::new().unwrap();
    let foreign = NamespaceId {
        store: 0,
        serial: 1,
    };
    assert_eq!(
        store.poll(foreign).unwrap_err(),
        AccessError::UnknownNamespace
    );
    assert_eq!(
        store.cleanup(foreign).unwrap_err(),
        AccessError::UnknownNamespace
    );
    assert_eq!(
        store.runtime_input(foreign).unwrap_err(),
        AccessError::UnknownNamespace
    );
    assert_eq!(store.capacity().0, Capacity::default());
    assert!(store.is_drained());
}

#[test]
fn bounded_identity_validation_rejects_oversize_and_noncanonical_pins() {
    assert!(identifier("run-1:retain.runtime"));
    assert!(!identifier(""));
    assert!(!identifier("../run"));
    assert!(!identifier(&"a".repeat(129)));
    assert!(lower_hex(&"a".repeat(64), 64));
    assert!(!lower_hex(&"A".repeat(64), 64));
    assert!(!lower_hex(&"a".repeat(65), 64));
}

// A genuine PendingRuntimeReceipt::accept and original finite-job completion
// back these tests. Its existing Unix producer fixture is synthetic: these
// prove managed ownership/accounting, never Worker or browser readiness.
#[cfg(unix)]
fn captured_fixture() -> (
    crate::browser_dev_runtime_receipt::contract_tests::Fixture,
    StaticRuntimeStore,
    NamespaceId,
) {
    let (fixture, receipt) =
        crate::browser_dev_runtime_receipt::contract_tests::accepted_runtime_fixture();
    let mut store = StaticRuntimeStore::new().unwrap();
    let mut charge = Arc::new(NamespaceCharge {
        reservation: store.ledger.reserve().unwrap(),
    });
    // The accepted fixture has already reaped its real finite child. The
    // original receipt/completion stays intact, not re-created from metadata.
    store.ledger.retire_process(&mut charge).unwrap();
    let id = charge.reservation.id;
    store.entries[0] = Some(Entry {
        id,
        state: State::Captured(Box::new(ChargedRuntime {
            receipt: Arc::new(receipt),
            charge,
        })),
        diagnostic: None,
    });
    (fixture, store, id)
}

#[cfg(unix)]
#[test]
fn owned_runtime_input_shares_original_receipt_bodies_and_charge() {
    let (_fixture, mut store, id) = captured_fixture();
    let input = store.runtime_input(id).unwrap();
    let entry = store.entries[store.index(id).unwrap()].as_ref().unwrap();
    let State::Captured(runtime) = &entry.state else {
        panic!("expected captured runtime");
    };
    assert_eq!(Arc::strong_count(&runtime.receipt), 2);
    assert_eq!(Arc::strong_count(&runtime.charge), 2);
    assert_eq!(input.namespace(), id);
    assert_eq!(input.pins(), runtime.receipt.pins());
    assert_eq!(input.renderer(), runtime.receipt.renderer());
    assert_eq!(
        input.raw_bundle().as_ptr(),
        runtime.receipt.raw_bundle().as_ptr()
    );
    for path in ["runtime-worker.mjs", "worker-admission-loader.mjs"] {
        let original = runtime.receipt.resource(path).unwrap();
        let borrowed = input.resource(path).unwrap();
        assert_eq!(borrowed.bytes().as_ptr(), original.bytes().as_ptr());
        assert_eq!(borrowed.bytes(), original.bytes());
        assert!(input.same_files(original.owned_files()));
        assert_eq!(input.directory(), original.owned_files().output());
    }
    for forbidden in [
        "build-report.json",
        "runtime-bundle.json",
        "source/Cargo.toml",
        "pkg/container_host_web_bg.wasm",
    ] {
        assert!(input.resource(forbidden).is_none());
    }
    // This software fixture needs no CanvasKit config validation input.
    assert!(input.resource("runtime-config.json").is_none());
    drop(input);
    store.retire(id).unwrap();
    assert_eq!(store.cleanup(id).unwrap(), Step::Released);
    assert!(store.is_drained());
}

#[cfg(unix)]
#[test]
fn owned_runtime_input_retirement_revokes_mint_and_waits_for_complete_release() {
    let (_fixture, mut store, id) = captured_fixture();
    let input = store.runtime_input(id).unwrap();
    let directory = input.directory();
    let bundle_pointer = input.raw_bundle().as_ptr();
    let body_pointer = input
        .resource("runtime-worker.mjs")
        .unwrap()
        .bytes()
        .as_ptr();
    let occupied = store.capacity().0;
    store.retire(id).unwrap();
    store.retire(id).unwrap();
    assert_eq!(
        store.runtime_input(id).unwrap_err(),
        AccessError::NotCaptured
    );
    assert_eq!(
        store.resource(id, "runtime-worker.mjs").unwrap_err(),
        AccessError::NotCaptured
    );
    assert_eq!(store.pins(id).unwrap_err(), AccessError::NotCaptured);
    assert_eq!(store.poll(id).unwrap(), Step::Retiring);
    for _ in 0..2 {
        assert_eq!(store.cleanup(id).unwrap(), Step::CleanupPending);
        assert_eq!(store.capacity().0, occupied);
        let entry = store.entries[store.index(id).unwrap()].as_ref().unwrap();
        assert!(matches!(entry.state, State::RetiringCaptured(_)));
        assert!(directory.is_dir());
        assert_eq!(input.raw_bundle().as_ptr(), bundle_pointer);
        assert_eq!(
            input
                .resource("runtime-worker.mjs")
                .unwrap()
                .bytes()
                .as_ptr(),
            body_pointer
        );
    }
    drop(input);
    assert_eq!(store.cleanup(id).unwrap(), Step::Released);
    assert!(!directory.exists());
    assert_eq!(store.capacity().0, Capacity::default());
    assert!(store.is_drained());
    assert_eq!(
        store.runtime_input(id).unwrap_err(),
        AccessError::UnknownNamespace
    );
}

#[cfg(unix)]
#[test]
fn runtime_input_and_body_leases_share_quota_and_hold_one_original_charge() {
    let (_fixture, mut store, id) = captured_fixture();
    let first_body = store.resource(id, "runtime-worker.mjs").unwrap().unwrap();
    let mut inputs = Vec::new();
    for _ in 1..MAX_BODY_LEASES {
        inputs.push(store.runtime_input(id).unwrap());
    }
    assert_eq!(
        store.runtime_input(id).unwrap_err(),
        AccessError::BorrowerCapacity
    );
    assert_eq!(
        store.resource(id, "runtime-worker.mjs").unwrap_err(),
        AccessError::BorrowerCapacity
    );
    // Quota refusal does not mint or clone a charge. One release permits one
    // new body lease from that same original allocation and shared budget.
    drop(inputs.pop());
    let last_body = store.resource(id, "runtime-worker.mjs").unwrap().unwrap();
    assert_eq!(first_body.bytes().as_ptr(), last_body.bytes().as_ptr());
    assert_eq!(
        store.runtime_input(id).unwrap_err(),
        AccessError::BorrowerCapacity
    );
    let occupied = store.capacity().0;
    store.retire(id).unwrap();
    drop(first_body);
    assert_eq!(store.cleanup(id).unwrap(), Step::CleanupPending);
    drop(inputs);
    assert_eq!(store.cleanup(id).unwrap(), Step::CleanupPending);
    assert_eq!(store.capacity().0, occupied);
    assert!(!last_body.bytes().is_empty());
    // The captured receipt itself remains intact until even this final
    // borrower is completely gone; into_completion cannot run earlier.
    let entry = store.entries[store.index(id).unwrap()].as_ref().unwrap();
    assert!(matches!(entry.state, State::RetiringCaptured(_)));
    drop(last_body);
    assert_eq!(store.cleanup(id).unwrap(), Step::Released);
    assert!(store.is_drained());
}

#[cfg(unix)]
#[test]
fn unexpected_receipt_borrow_retains_original_owner_without_refund() {
    let (_fixture, mut store, id) = captured_fixture();
    // Only this private-state test can take an additional raw receipt Arc.
    // Production runtime inputs expose no corresponding escape.
    let receipt = {
        let entry = store.entries[store.index(id).unwrap()].as_ref().unwrap();
        let State::Captured(runtime) = &entry.state else {
            panic!("expected captured runtime");
        };
        runtime.receipt.clone()
    };
    let occupied = store.capacity().0;
    store.retire(id).unwrap();
    assert_eq!(store.cleanup(id).unwrap(), Step::CleanupPending);
    assert_eq!(store.capacity().0, occupied);
    let entry = store.entries[store.index(id).unwrap()].as_ref().unwrap();
    let State::RetiringCaptured(runtime) = &entry.state else {
        panic!("unexpected receipt borrower lost its original owner");
    };
    assert!(Arc::ptr_eq(&runtime.receipt, &receipt));
    drop(receipt);
    assert_eq!(store.cleanup(id).unwrap(), Step::Released);
    assert!(store.is_drained());
}
