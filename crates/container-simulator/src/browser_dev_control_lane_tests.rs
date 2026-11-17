//! Correlation contracts only: these do not execute a browser or prove teardown.
use super::*;
use serde_json::{json, Value};

fn fixture() -> (PreviewLease, RegisteredBrowserOwner, OwnerKey, CloseTicket) {
    let preview = PreviewLease {
        version: "1.0".into(),
        run_id: "run-a".into(),
        preview_id: "preview-a".into(),
        lease_revision: WireU64::new(1),
    };
    let registration = RegisteredBrowserOwner {
        client_id: "client-a".into(),
        binding: ActivationBinding {
            version: "1.0".into(),
            run_id: "run-a".into(),
            site_id: WireU64::new(2),
            token_id: "a".repeat(64),
            activation_id: WireU64::new(3),
            preview: preview.clone(),
            startup_revision: WireU64::new(1),
            runtime_bundle_sha256: "b".repeat(64),
            index_sha256: "c".repeat(64),
        },
        transport_backend: TransportBackend::BrowserView,
    };
    let key = OwnerKey {
        activation_id: WireU64::new(3),
        owner_serial: WireU64::new(4),
        client_owner_id: "client-a:owner-unique".into(),
    };
    let ticket = CloseTicket {
        version: "1.0".into(),
        close_revision: WireU64::new(5),
        terminal_cleanup_revision: WireU64::new(0),
        preview: preview.clone(),
        owner: key.clone(),
        replaces_with_activation: Some(WireU64::new(6)),
    };
    (preview, registration, key, ticket)
}

fn owner() -> OwnerTuple {
    OwnerTuple {
        worker_epoch: "epoch-a".into(),
        session_id: "session-a".into(),
        pack_sha256: "c".repeat(64),
        transport_backend: TransportBackend::BrowserView,
    }
}

fn report(key: &OwnerKey, owner: Option<&OwnerTuple>, rpc: Option<Value>) -> BrowserCloseReport {
    serde_json::from_value(json!({
        "evidenceOrigin": "browser-reported", "success": true, "pendingActual": false,
        "ownerKey": key, "outcome": "closed", "receipt": {
            "version": "1.0", "closed": true, "workerClosed": true, "ownedMountRemoved": true,
            "owner": owner, "rpcIdentity": rpc,
            "workerFinal": rpc.as_ref().map(|_| json!({"closed": true}))
        }
    }))
    .unwrap()
}

fn rpc() -> Value {
    json!({"workerEpoch": "epoch-a", "sessionId": "session-a"})
}

#[test]
fn browser_reported_preadmission_rpc_close_needs_no_runtime_ready() {
    let (preview, registration, key, ticket) = fixture();
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: None,
    };
    let result = report(&key, None, Some(rpc()));
    assert!(policy
        .correlate_registration(&ticket, &result, &key, &registration)
        .unwrap());
    assert!(policy.runtime_owner.is_none());
    assert!(result.receipt.unwrap().owner.is_none());
}

#[test]
fn constructed_wrapper_and_admitted_unready_owner_are_distinct_valid_closes() {
    let (preview, registration, key, ticket) = fixture();
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: None,
    };
    for result in [
        report(&key, None, None),
        report(&key, Some(&owner()), Some(rpc())),
    ] {
        assert!(policy
            .correlate_registration(&ticket, &result, &key, &registration)
            .unwrap());
        assert_eq!(result.outcome.as_deref(), Some("closed"));
    }
}

#[test]
fn recorded_runtime_tuple_cannot_be_downgraded_or_replaced_during_close() {
    let (preview, registration, key, ticket) = fixture();
    let known = owner();
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: Some(&known),
    };
    assert!(policy
        .correlate_registration(
            &ticket,
            &report(&key, Some(&known), Some(rpc())),
            &key,
            &registration
        )
        .unwrap());
    let mut other = known.clone();
    other.worker_epoch = "epoch-other".into();
    other.session_id = "session-other".into();
    let different_rpc = json!({"workerEpoch": "epoch-other", "sessionId": "session-other"});
    for result in [
        report(&key, None, None),
        report(&key, None, Some(rpc())),
        report(&key, Some(&other), Some(different_rpc)),
    ] {
        assert!(policy
            .correlate_registration(&ticket, &result, &key, &registration)
            .is_err());
    }
    assert_eq!(policy.runtime_owner, Some(&known));
}

#[test]
fn elected_client_run_preview_and_registered_owner_must_all_match() {
    let (preview, registration, key, ticket) = fixture();
    let result = report(&key, None, Some(rpc()));
    let mut other_preview = preview.clone();
    other_preview.lease_revision = WireU64::new(9);
    for (run_id, client_id, lease) in [
        ("run-other", "client-a", &preview),
        ("run-a", "client-other", &preview),
        ("run-a", "client-a", &other_preview),
    ] {
        let policy = BrowserReportedClose {
            run_id,
            client_id,
            preview: lease,
            runtime_owner: None,
        };
        assert!(policy
            .correlate_registration(&ticket, &result, &key, &registration)
            .is_err());
    }
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: None,
    };
    let mut wrong_ticket = ticket.clone();
    wrong_ticket.owner.owner_serial = WireU64::new(99);
    assert!(policy
        .correlate_registration(&wrong_ticket, &result, &key, &registration)
        .is_err());
    wrong_ticket = ticket.clone();
    wrong_ticket.preview = other_preview;
    assert!(policy
        .correlate_registration(&wrong_ticket, &result, &key, &registration)
        .is_err());
    let mut wrong_key = key.clone();
    wrong_key.activation_id = WireU64::new(99);
    assert!(policy
        .correlate_registration(&ticket, &result, &wrong_key, &registration)
        .is_err());
}

#[test]
fn unready_admitted_tuple_still_requires_original_index_backend_and_rpc() {
    let (preview, registration, key, ticket) = fixture();
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: None,
    };
    for field in ["index", "backend", "epoch", "session"] {
        let mut value = owner();
        match field {
            "index" => value.pack_sha256 = "d".repeat(64),
            "backend" => value.transport_backend = TransportBackend::ExternalFrame,
            "epoch" => value.worker_epoch = "epoch-other".into(),
            "session" => value.session_id = "session-other".into(),
            _ => unreachable!(),
        }
        assert!(policy
            .correlate_registration(
                &ticket,
                &report(&key, Some(&value), Some(rpc())),
                &key,
                &registration
            )
            .is_err());
    }
}

#[test]
fn never_constructed_is_allowed_only_before_any_recorded_runtime() {
    let (preview, registration, key, ticket) = fixture();
    let result: BrowserCloseReport = serde_json::from_value(json!({
        "evidenceOrigin": "browser-reported", "success": true, "pendingActual": false,
        "ownerKey": key, "outcome": "never-constructed", "workerClosed": true,
        "ownedMountRemoved": true
    }))
    .unwrap();
    let known = owner();
    for (runtime_owner, accepted) in [(None, true), (Some(&known), false)] {
        let policy = BrowserReportedClose {
            run_id: "run-a",
            client_id: "client-a",
            preview: &preview,
            runtime_owner,
        };
        assert_eq!(
            policy
                .correlate_registration(&ticket, &result, &key, &registration)
                .is_ok(),
            accepted
        );
    }
}

#[test]
fn failed_pending_or_incomplete_close_cannot_release_registered_owner() {
    let (preview, registration, key, ticket) = fixture();
    let policy = BrowserReportedClose {
        run_id: "run-a",
        client_id: "client-a",
        preview: &preview,
        runtime_owner: None,
    };
    let failed: BrowserCloseReport = serde_json::from_value(json!({
        "evidenceOrigin": "browser-reported", "success": false, "pendingActual": true,
        "error": {"code": "ERR_RENDER", "message": "close still pending"}
    }))
    .unwrap();
    assert!(!policy
        .correlate_registration(&ticket, &failed, &key, &registration)
        .unwrap());
    for field in ["pending", "worker", "mount", "final", "rpc"] {
        let mut result = report(&key, None, Some(rpc()));
        match field {
            "pending" => result.pending_actual = true,
            "worker" => result.receipt.as_mut().unwrap().worker_closed = false,
            "mount" => result.receipt.as_mut().unwrap().owned_mount_removed = false,
            "final" => {
                result.receipt.as_mut().unwrap().worker_final = Some(json!({"closed": false}))
            }
            "rpc" => {
                result
                    .receipt
                    .as_mut()
                    .unwrap()
                    .rpc_identity
                    .as_mut()
                    .unwrap()
                    .session_id = "bad identity".into()
            }
            _ => unreachable!(),
        }
        assert!(policy
            .correlate_registration(&ticket, &result, &key, &registration)
            .is_err());
    }
}
