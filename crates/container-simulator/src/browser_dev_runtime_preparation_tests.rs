use super::*;
use crate::browser_dev_runtime_receipt::RuntimeBundleRenderer;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(unix)]
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        Self::at(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        )
    }
    fn at(timestamp: u128) -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let temporary = fs::canonicalize(std::env::temp_dir()).unwrap();
        // Clock samples can coincide across test threads. Exclusive creation
        // establishes ownership; an existing directory is never ours to erase.
        for _ in 0..32 {
            let root = temporary.join(format!(
                "browser-runtime-preparation-{}-{timestamp}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match private_directory(&root) {
                Ok(()) => return Self(root),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create private fixture: {error}"),
            }
        }
        panic!("private fixture namespace remained occupied");
    }
    fn input(&self) -> BrowserRuntimePreparation {
        let producer = self.0.join("producer");
        fs::create_dir(&producer).unwrap();
        fs::write(producer.join("build-report.json"), b"{}").unwrap();
        BrowserRuntimePreparation {
            producer_directory: producer,
            expected: ProducerExpected {
                report_sha256: "a".repeat(64),
                source_commit: "b".repeat(40),
                source_sha256: "c".repeat(64),
                renderer: RuntimeBundleRenderer::Software,
            },
        }
    }
    fn owner(&self) -> BrowserRuntimePreparationOwner {
        BrowserRuntimePreparationOwner::new(
            self.input(),
            PathBuf::from("node"),
            Duration::from_secs(1),
            self.0.join("owned"),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn parallel_fixtures_with_one_clock_sample_have_distinct_owned_roots() {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(16));
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                Fixture::at(timestamp)
            })
        })
        .collect();
    let fixtures: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    let roots: std::collections::BTreeSet<_> = fixtures.iter().map(|fixture| &fixture.0).collect();
    assert_eq!(roots.len(), 16);
    assert!(roots.iter().all(|root| root.is_dir()));
}

#[test]
fn browser_runtime_input_freeze_copies_bytes_and_leaves_original_unchanged() {
    let fixture = Fixture::new();
    let input = fixture.input();
    let target = fixture.0.join("frozen");
    let stats = freeze_producer(&input.producer_directory, &target).unwrap();
    assert_eq!((stats.bytes, stats.files.len()), (2, 1));
    fs::write(target.join("build-report.json"), b"changed copy").unwrap();
    assert_eq!(
        fs::read(input.producer_directory.join("build-report.json")).unwrap(),
        b"{}"
    );
}

#[test]
fn browser_runtime_input_freeze_rejects_oversized_file_before_copy() {
    let fixture = Fixture::new();
    let input = fixture.input();
    let file = fs::File::create(input.producer_directory.join("sparse.bin")).unwrap();
    file.set_len(MAX_FILE as u64 + 1).unwrap();
    let target = fixture.0.join("frozen");
    assert!(freeze_producer(&input.producer_directory, &target).is_err());
    assert!(!target.exists());
}

#[test]
#[cfg(unix)]
fn browser_runtime_input_freeze_rejects_symlink_before_copy() {
    let fixture = Fixture::new();
    let input = fixture.input();
    std::os::unix::fs::symlink("build-report.json", input.producer_directory.join("alias"))
        .unwrap();
    let target = fixture.0.join("frozen");
    assert!(freeze_producer(&input.producer_directory, &target).is_err());
    assert!(!target.exists());
}

#[test]
fn browser_runtime_owner_does_not_claim_existing_root() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    fs::create_dir(&owner.root).unwrap();
    fs::write(owner.root.join("foreign"), b"unowned").unwrap();
    assert!(matches!(owner.poll(), Some(PreparationUpdate::Failed(_))));
    assert!(owner.try_shutdown().unwrap());
    assert_eq!(fs::read(owner.root.join("foreign")).unwrap(), b"unowned");
}

#[test]
fn browser_runtime_owner_retains_partial_copy_for_explicit_cleanup_retry() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    // A read-only original with an oversized member fails after exclusive root
    // reservation, without handing that reservation to an error string.
    fs::File::create(owner.input.producer_directory.join("large"))
        .unwrap()
        .set_len(MAX_FILE as u64 + 1)
        .unwrap();
    assert!(matches!(owner.poll(), Some(PreparationUpdate::Failed(_))));
    assert!(owner.root_owned && owner.root.is_dir());
    assert!(owner.poll().is_none(), "failure is only reported once");
    assert!(owner.try_shutdown().unwrap());
    assert!(!owner.root.exists());
    assert!(owner.input.producer_directory.join("large").exists());
}

#[test]
#[cfg(unix)]
fn browser_runtime_failed_finite_lane_continues_cleanup_without_supervisor_shutdown() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    let transport = fixture.0.join("finite-transport.sh");
    let pid = fixture.0.join("finite.pid");
    fs::write(
        &transport,
        format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > '{}'\nwhile :; do sleep 0.02; done\n",
            pid.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&transport, fs::Permissions::from_mode(0o700)).unwrap();
    owner.node = transport;
    owner.timeout = Duration::from_secs(3);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut failed = false;
    loop {
        if let Some(PreparationUpdate::Failed(cause)) = owner.poll() {
            eprintln!("finite transport failure: {cause}");
            assert!(pid.exists(), "transport was never started: {cause}");
            failed = true;
        }
        if failed && owner.runtime.is_none() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "failed finite job must keep making cleanup progress"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(owner.store.is_drained());
    assert!(owner.is_settled());
    assert!(
        owner.root_owned,
        "input root is retained until explicit shutdown"
    );
    let process: i32 = fs::read_to_string(pid).unwrap().parse().unwrap();
    assert_eq!(
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(process), None),
        Err(nix::errno::Errno::ESRCH)
    );
    assert!(owner.try_shutdown().unwrap());
    assert!(!owner.root.exists());
}

#[test]
fn browser_runtime_root_cleanup_error_preserves_actual_owner_for_retry() {
    let fixture = Fixture::new();
    let mut owner = fixture.owner();
    fs::File::create(owner.input.producer_directory.join("oversized"))
        .unwrap()
        .set_len(MAX_FILE as u64 + 1)
        .unwrap();
    assert!(matches!(owner.poll(), Some(PreparationUpdate::Failed(_))));
    let retained = fixture.0.join("retained-root");
    fs::rename(&owner.root, &retained).unwrap();
    fs::write(&owner.root, b"temporary cleanup obstruction").unwrap();
    assert!(owner.try_shutdown().is_err());
    assert!(owner.root_owned);
    assert!(retained.is_dir());
    fs::remove_file(&owner.root).unwrap();
    fs::rename(&retained, &owner.root).unwrap();
    assert!(owner.try_shutdown().unwrap());
    assert!(!owner.root.exists());
    assert!(owner.input.producer_directory.is_dir());
}
