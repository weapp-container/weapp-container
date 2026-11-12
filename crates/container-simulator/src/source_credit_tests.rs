use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    root: PathBuf,
    credits: SourceCredits,
    ledger: Ledger,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "weapp-source-credit-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
        fs::create_dir(&root).unwrap();
        let control = root.join("control");
        fs::create_dir(&control).unwrap();
        Self {
            credits: SourceCredits::new(control, "source-test-run".into(), "a".repeat(40)).unwrap(),
            root,
            ledger: Ledger {
                store: NEXT.fetch_add(1, Ordering::Relaxed) + 100_000,
                next_serial: 0,
                used: Capacity::default(),
                limit: Capacity {
                    memory_bytes: 3 * 1024 * MIB,
                    disk_bytes: 3 * 1024 * MIB,
                    files: 81_984,
                    directories: 10_286,
                    namespaces: 6,
                    finite_jobs: 1,
                },
            },
        }
    }

    fn issue(&mut self) -> NamespaceId {
        self.credits.issue_raw(&mut self.ledger).unwrap()
    }

    fn directory(&self, id: NamespaceId) -> PathBuf {
        self.credits.entries[self.credits.index(id).unwrap()]
            .as_ref()
            .unwrap()
            .owner
            .files
            .root
            .clone()
    }

    fn claim(&self, id: NamespaceId) {
        let root = self.directory(id);
        fs::rename(root.join("grant.json"), root.join("claimed.json")).unwrap();
    }

    fn ready_raw(&mut self) -> NamespaceId {
        let id = self.issue();
        self.claim(id);
        let root = self.directory(id);
        fs::create_dir(root.join("pack")).unwrap();
        fs::write(root.join("pack/app.json"), b"{}").unwrap();
        let name = root.file_name().unwrap().to_str().unwrap();
        fs::write(root.join("result.json"), serde_json::to_vec(&serde_json::json!({
            "protocolVersion": VERSION, "runId": "source-test-run", "creditId": name,
            "sequence": "1", "kind": "success", "writerDone": true,
            "compilerCommit": "a".repeat(40), "inventory": {"bytes": "2", "files": 1, "directories": 1},
        })).unwrap()).unwrap();
        let status = CreditStatus {
            protocol_version: VERSION.into(),
            run_id: "source-test-run".into(),
            sequence: "1".into(),
            kind: "success".into(),
            credit_id: Some(name.into()),
            compiler_commit: Some("a".repeat(40)),
            message: None,
        };
        assert_eq!(self.credits.accept_raw_status(&status).unwrap(), id);
        id
    }

    fn cleanup(&mut self, id: NamespaceId) -> SourceStep {
        self.credits.cleanup(&mut self.ledger, id).unwrap()
    }

    fn stop_watcher(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.credits.try_stop_watcher().unwrap() {
            assert!(
                Instant::now() < deadline,
                "actual watcher tree did not retire"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    fn pack_intent(&self, body: &str, timeout: Duration) -> PackStart {
        let packer = self.root.join("packer.sh");
        fs::write(&packer, body).unwrap();
        PackStart {
            node_bin: PathBuf::from("/bin/sh"),
            packer,
            revision: 1,
            route: None,
            publication_token: PortablePublicationToken {
                source_revision: 1,
                compiler_receipt_sequence: 1,
            },
            modern_project_requested: false,
            pack_timeout: timeout,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let stopped = self.credits.try_stop_watcher().unwrap_or(false);
            for id in self.credits.ids() {
                let _ = self.credits.retire(id);
                let _ = self.credits.cleanup(&mut self.ledger, id);
            }
            if stopped && self.credits.is_drained() {
                fs::remove_dir_all(&self.root).unwrap();
                break;
            }
            if Instant::now() >= deadline {
                eprintln!(
                    "source fixture retains incomplete actual cleanup: {}",
                    self.root.display()
                );
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}

#[test]
fn source_credit_admission_precedes_grant_side_effects_and_uses_selected_limit() {
    let mut fixture = Fixture::new();
    fixture.ledger.limit = RAW_CHARGE;
    let id = fixture.issue();
    let root = fixture.directory(id);
    let grant: serde_json::Value =
        serde_json::from_slice(&fs::read(root.join("grant.json")).unwrap()).unwrap();
    assert_eq!(grant["protocolVersion"], VERSION);
    assert_eq!(grant["runId"], "source-test-run");
    assert_eq!(grant["limits"]["bytes"], RAW_PAYLOAD_BYTES.to_string());
    let before = fs::read_dir(fixture.credits.control_root())
        .unwrap()
        .count();
    let rejection = fixture.credits.issue_raw(&mut fixture.ledger).unwrap_err();
    assert_eq!(rejection.cause, AdmissionError::Capacity);
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    assert_eq!(
        fs::read_dir(fixture.credits.control_root())
            .unwrap()
            .count(),
        before
    );
    fixture.credits.retire(id).unwrap();
    assert_eq!(fixture.cleanup(id), SourceStep::Released); // Unclaimed grant is atomically revoked.
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
fn source_credit_claim_without_ack_keeps_original_owner_and_charge() {
    let mut fixture = Fixture::new();
    let id = fixture.issue();
    fixture.claim(id);
    let root = fixture.directory(id);
    fixture.credits.retire(id).unwrap();
    assert_eq!(fixture.cleanup(id), SourceStep::CleanupPending);
    assert!(root.is_dir());
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    fixture.stop_watcher(); // This run never spawned a writer; no-child shutdown is terminal.
    assert_eq!(fixture.cleanup(id), SourceStep::Released);
    assert!(!root.exists());
}

#[test]
fn source_credit_missing_owned_root_refunds_only_after_writer_and_borrowers_retire() {
    let mut fixture = Fixture::new();
    let id = fixture.ready_raw();
    let root = fixture.directory(id);
    let borrower = fixture.credits.borrow(id).unwrap();
    fixture.credits.retire(id).unwrap();
    fs::remove_dir_all(&root).unwrap();
    assert_eq!(fixture.cleanup(id), SourceStep::CleanupPending);
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    drop(borrower);
    assert_eq!(fixture.cleanup(id), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
fn source_credit_other_owned_root_cleanup_errors_retain_original_charge_for_retry() {
    let mut fixture = Fixture::new();
    let id = fixture.ready_raw();
    let root = fixture.directory(id);
    fixture.credits.retire(id).unwrap();
    fs::remove_dir_all(&root).unwrap();
    fs::write(&root, b"not a directory").unwrap();
    assert!(fixture.credits.cleanup(&mut fixture.ledger, id).is_err());
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    assert!(root.is_file());
    fs::remove_file(&root).unwrap();
    assert_eq!(fixture.cleanup(id), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
fn source_credit_borrowers_pin_actual_bytes_and_prevent_refund() {
    let mut fixture = Fixture::new();
    let id = fixture.ready_raw();
    let mut borrowers = Vec::new();
    for _ in 0..MAX_SOURCE_BORROWERS {
        borrowers.push(fixture.credits.borrow(id).unwrap());
    }
    assert!(fixture.credits.borrow(id).is_err());
    assert_eq!(borrowers[0].namespace(), id);
    assert_eq!(borrowers[0].compiler(), "a".repeat(40));
    assert_eq!(borrowers[0].raw_sequence(), Some(1));
    assert!(borrowers[0].portable().is_none());
    assert_eq!(
        fs::read(borrowers[0].directory().join("app.json")).unwrap(),
        b"{}"
    );
    fixture.credits.retire(id).unwrap();
    assert!(fixture.credits.borrow(id).is_err());
    assert_eq!(fixture.cleanup(id), SourceStep::CleanupPending);
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    drop(borrowers);
    assert_eq!(fixture.cleanup(id), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
fn portable_only_input_rejects_ready_raw_without_minting_borrower() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let index = fixture.credits.index(raw).unwrap();
    let owner = &fixture.credits.entries[index].as_ref().unwrap().owner;
    let before = Arc::strong_count(owner);
    assert!(fixture.credits.borrow_portable(raw).is_err());
    assert_eq!(
        Arc::strong_count(&fixture.credits.entries[index].as_ref().unwrap().owner),
        before
    );
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
}

#[test]
fn source_credit_root_never_adopts_previous_control_files() {
    let fixture = Fixture::new();
    fs::write(
        fixture.credits.control_root().join("foreign"),
        b"owned elsewhere",
    )
    .unwrap();
    assert!(SourceCredits::new(
        fixture.credits.control_root().into(),
        "another-run".into(),
        "b".repeat(40)
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.credits.control_root().join("foreign")).unwrap(),
        b"owned elsewhere"
    );
}

#[test]
fn source_credit_exact_sequences_do_not_lose_u64_precision() {
    assert_eq!(decimal("18446744073709551615").unwrap(), u64::MAX);
    for invalid in ["", "01", "-1", "1.0", "18446744073709551616"] {
        assert!(decimal(invalid).is_err());
    }
}

#[test]
fn source_credit_rejects_third_raw_without_new_namespace() {
    let mut fixture = Fixture::new();
    let first = fixture.issue();
    let second = fixture.issue();
    assert_eq!(fixture.credits.active_raw_count(), 2);
    assert_eq!(
        fixture
            .credits
            .issue_raw(&mut fixture.ledger)
            .unwrap_err()
            .cause,
        AdmissionError::Capacity
    );
    assert_eq!(fixture.credits.ids(), vec![first, second]);
}

#[test]
#[cfg(unix)]
fn source_credit_malformed_ack_cannot_block_actual_watcher_shutdown_barrier() {
    use std::process::Stdio;
    let mut fixture = Fixture::new();
    let id = fixture.issue();
    fixture.claim(id);
    let root = fixture.directory(id);
    fs::write(root.join("result.json"), b"{invalid ack").unwrap();
    let marker = fixture.root.join("watcher-started");
    let mut command = Command::new("/bin/sh");
    // Existence is the readiness signal: publish it only after both values are written.
    command.args(["-c", "printf '%s\\n%s' \"$WEAPP_CONTAINER_SIMULATOR_SESSION_ID\" \"$WEAPP_CONTAINER_SIMULATOR_SOURCE_CREDIT_DIR\" > \"$1.tmp\" && mv \"$1.tmp\" \"$1\" || exit 8; while :; do sleep 0.02; done", "source-watcher"])
        .arg(&marker).stdout(Stdio::null()).stderr(Stdio::null());
    fixture.credits.spawn_watcher(&mut command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !marker.exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        fs::read_to_string(&marker).unwrap(),
        format!(
            "source-test-run\n{}",
            fixture.credits.control_root().display()
        )
    );
    fixture.credits.retire(id).unwrap();
    assert!(fixture.credits.cleanup(&mut fixture.ledger, id).is_err());
    assert!(root.is_dir());
    assert_eq!(fixture.ledger.used, RAW_CHARGE);
    fixture.stop_watcher();
    assert_eq!(fixture.cleanup(id), SourceStep::Released); // Does not parse the malformed ACK again.
    assert_eq!(fixture.ledger.used, Capacity::default());
    assert!(fixture.credits.spawn_watcher(&mut command).is_err());
    assert_eq!(
        fixture
            .credits
            .issue_raw(&mut fixture.ledger)
            .unwrap_err()
            .cause,
        AdmissionError::InvalidInput
    );
}

#[test]
#[cfg(unix)]
fn source_credit_natural_wrapper_exit_retires_actual_descendant_writer_before_releasing_claim() {
    use std::process::Stdio;
    let mut fixture = Fixture::new();
    let id = fixture.issue();
    fixture.claim(id);
    let heartbeat = fixture.directory(id).join("heartbeat");
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "(while :; do printf x >> \"$1\"; sleep 0.02; done) & while [ ! -s \"$1\" ]; do sleep 0.01; done; exit 7", "source-watcher"])
        .arg(&heartbeat).stdout(Stdio::null()).stderr(Stdio::null());
    fixture.credits.spawn_watcher(&mut command).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = fixture.credits.poll_watcher().unwrap() {
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "actual process tree barrier did not complete"
        );
        std::thread::sleep(Duration::from_millis(5));
    };
    assert_eq!(status.code(), Some(7));
    let bytes = fs::read(&heartbeat).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    assert_eq!(
        fs::read(&heartbeat).unwrap(),
        bytes,
        "descendant still wrote after the returned barrier"
    );
    fixture.credits.retire(id).unwrap();
    assert_eq!(fixture.cleanup(id), SourceStep::Released);
}

#[test]
#[cfg(unix)]
fn source_pack_failure_keeps_raw_input_and_original_output_until_explicit_cleanup() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let intent = fixture.pack_intent("exit 7\n", Duration::from_secs(5));
    let pack = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap();
    assert_eq!(fixture.ledger.used.finite_jobs, 1);
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::CleanupPending);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let step = fixture
            .credits
            .poll_pack(&mut fixture.ledger, pack)
            .unwrap();
        if step == SourceStep::Failed {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fixture.ledger.used.finite_jobs, 0);
    assert_eq!(fixture.ledger.used.namespaces, 2);
    assert_eq!(fixture.cleanup(raw), SourceStep::CleanupPending);
    fixture.credits.retire(pack).unwrap();
    assert_eq!(fixture.cleanup(pack), SourceStep::Released);
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
#[cfg(unix)]
fn source_pack_capacity_rejection_returns_unconsumed_input_without_output_side_effects() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    fixture.ledger.limit = RAW_CHARGE;
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let intent = fixture.pack_intent("exit 0\n", Duration::from_secs(5));
    let rejection = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap_err();
    assert_eq!(rejection.cause, AdmissionError::Capacity);
    let returned = rejection.inputs.unwrap();
    assert_eq!(returned.raw.namespace(), raw);
    assert_eq!(fixture.credits.ids(), vec![raw]);
    assert_eq!(
        fs::read(returned.raw.directory().join("app.json")).unwrap(),
        b"{}"
    );
}

#[test]
#[cfg(unix)]
fn source_pack_deadline_terminates_but_keeps_actual_owner_input_and_finite_charge_until_barrier() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let intent = fixture.pack_intent("while :; do sleep 0.02; done\n", Duration::from_millis(1));
    let pack = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap();
    std::thread::sleep(Duration::from_millis(5));
    let error = fixture
        .credits
        .poll_pack(&mut fixture.ledger, pack)
        .unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    let entry = fixture.credits.entries[fixture.credits.index(pack).unwrap()]
        .as_ref()
        .unwrap();
    assert!(entry.writer.as_ref().unwrap().actual.is_some());
    assert!(entry.inputs.is_some());
    assert_eq!(fixture.ledger.used.finite_jobs, 1);
    fixture.credits.retire(pack).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while fixture.cleanup(pack) != SourceStep::Released {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fixture.ledger.used.finite_jobs, 0);
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
}

#[test]
#[cfg(unix)]
fn source_pack_prechild_failure_retains_inputs_and_reservation_for_cleanup() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let mut intent = fixture.pack_intent("exit 0\n", Duration::from_secs(5));
    intent.node_bin = fixture.root.join("missing-node");
    let pack = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap();
    assert_eq!(fixture.credits.step(pack).unwrap(), SourceStep::Failed);
    assert!(fixture.credits.diagnostic(pack).unwrap().is_some());
    assert_eq!(fixture.ledger.used.finite_jobs, 1);
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::CleanupPending);
    fixture.credits.retire(pack).unwrap();
    assert_eq!(fixture.cleanup(pack), SourceStep::Released);
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
#[cfg(unix)]
fn source_pack_validated_publish_keeps_same_owner_and_namespace_and_pins_portable_borrower() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let mut manifest = container_ir::ContainerManifestV1 {
        compiler: container_ir::CompilerInfo {
            name: "weapp-vite".into(),
            commit: "a".repeat(40),
            platform: "weapp".into(),
        },
        app: container_ir::AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        },
        ..Default::default()
    };
    manifest.refresh_integrity().unwrap();
    let manifest_bytes = serde_json::to_vec(&manifest).unwrap();
    fs::write(fixture.root.join("expected-manifest.json"), &manifest_bytes).unwrap();
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let intent = fixture.pack_intent(
        "cp \"$(dirname \"$0\")/expected-manifest.json\" \"$3/manifest.json\"\n",
        Duration::from_secs(5),
    );
    let pack = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap();
    let owner_before = Arc::as_ptr(
        &fixture.credits.entries[fixture.credits.index(pack).unwrap()]
            .as_ref()
            .unwrap()
            .owner,
    );
    let root = fixture.directory(pack);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if fixture
            .credits
            .poll_pack(&mut fixture.ledger, pack)
            .unwrap()
            == SourceStep::Ready
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let entry = fixture.credits.entries[fixture.credits.index(pack).unwrap()]
        .as_ref()
        .unwrap();
    assert_eq!(Arc::as_ptr(&entry.owner), owner_before);
    assert!(entry.inputs.is_none());
    assert_eq!(
        fixture
            .credits
            .portable_report(pack)
            .unwrap()
            .pack_directory,
        root.join("pack")
    );
    assert_eq!(
        fixture
            .credits
            .portable_report(pack)
            .unwrap()
            .manifest_sha256,
        container_ir::hex_digest(&manifest_bytes)
    );
    assert!(!root.join(".staging").exists());
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
    let portable = fixture.credits.borrow_portable(pack).unwrap();
    assert_eq!(portable.namespace(), pack);
    assert_eq!(
        portable.report(),
        fixture.credits.portable_report(pack).unwrap()
    );
    assert_eq!(
        fs::read(portable.directory().join("manifest.json")).unwrap(),
        manifest_bytes
    );
    // Typed and generic borrowers share one original quota and namespace.
    let mut other = Vec::new();
    for _ in 1..MAX_SOURCE_BORROWERS {
        other.push(fixture.credits.borrow(pack).unwrap());
    }
    assert!(fixture.credits.borrow_portable(pack).is_err());
    drop(other);
    fixture.credits.retire(pack).unwrap();
    assert!(fixture.credits.borrow_portable(pack).is_err());
    assert_eq!(fixture.cleanup(pack), SourceStep::CleanupPending);
    drop(portable);
    assert_eq!(fixture.cleanup(pack), SourceStep::Released);
    assert_eq!(fixture.ledger.used, Capacity::default());
}

#[test]
#[cfg(unix)]
fn source_pack_invalid_child_success_fails_validation_and_is_still_retryably_retained() {
    let mut fixture = Fixture::new();
    let raw = fixture.ready_raw();
    let input = PackSourceInput {
        raw: fixture.credits.borrow(raw).unwrap(),
    };
    let intent = fixture.pack_intent(
        "printf '{invalid manifest' > \"$3/manifest.json\"\n",
        Duration::from_secs(5),
    );
    let pack = fixture
        .credits
        .start_pack(&mut fixture.ledger, intent, input)
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if fixture
            .credits
            .poll_pack(&mut fixture.ledger, pack)
            .is_err()
        {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(fixture.credits.step(pack).unwrap(), SourceStep::Failed);
    assert_eq!(
        fixture
            .credits
            .poll_pack(&mut fixture.ledger, pack)
            .unwrap(),
        SourceStep::Failed
    );
    assert!(fixture.credits.portable_report(pack).is_err());
    assert_eq!(fixture.ledger.used.finite_jobs, 0);
    fixture.credits.retire(raw).unwrap();
    assert_eq!(fixture.cleanup(raw), SourceStep::CleanupPending);
    fixture.credits.retire(pack).unwrap();
    assert_eq!(fixture.cleanup(pack), SourceStep::Released);
    assert_eq!(fixture.cleanup(raw), SourceStep::Released);
}
