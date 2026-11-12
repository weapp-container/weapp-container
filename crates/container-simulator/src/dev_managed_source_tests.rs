//! Construction and cleanup coverage for the managed-source supervisor lane.
//!
//! The producer pins below are syntactically valid startup metadata, not a
//! fabricated runtime receipt. These tests deliberately stop before the first
//! runtime-preparation poll. A completed producer -> source watcher -> portable
//! transaction requires the independently built producer integration fixture.

use super::*;
use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};

struct Fixture {
    root: PathBuf,
    project: PathBuf,
    producer: PathBuf,
    output: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = loop {
            let path = std::env::temp_dir().join(format!(
                "weapp-managed-source-supervisor-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed),
            ));
            match fs::create_dir(&path) {
                Ok(()) => break fs::canonicalize(path).unwrap(),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve managed-source fixture: {error}"),
            }
        };
        let project = root.join("project");
        let producer = root.join("producer");
        let output = root.join("output");
        fs::create_dir(&project).unwrap();
        fs::create_dir(&producer).unwrap();
        fs::write(
            project.join("app.json"),
            br#"{"pages":["pages/home/index"]}"#,
        )
        .unwrap();
        fs::write(producer.join("caller-owned"), b"unchanged producer input").unwrap();
        Self {
            root,
            project,
            producer,
            output,
        }
    }

    fn config(&self) -> DevConfig {
        let mut config = DevConfig::new(&self.project, SimulatorConfig::default());
        config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
        config.output_dir = self.output.clone();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.managed_browser_sources = true;
        config.browser_runtime = Some(BrowserRuntimePreparation {
            producer_directory: self.producer.clone(),
            expected: ProducerExpected {
                report_sha256: "a".repeat(64),
                source_commit: "b".repeat(40),
                source_sha256: "c".repeat(64),
                renderer: RuntimeBundleRenderer::Software,
            },
        });
        // Any accidentally eager launch fails instead of running ambient tools.
        config.node_bin = self.root.join("node-must-not-start");
        config
    }

    fn tool_workspace(&self, name: &str) -> PathBuf {
        let workspace = self.root.join(name);
        let packer = workspace.join("tools/container-manifest/bin/container-pack.mjs");
        fs::create_dir_all(packer.parent().unwrap()).unwrap();
        // A discovery marker only. The construction/cleanup tests never poll
        // the packer and must not accidentally invoke a production build.
        fs::write(packer, "throw new Error('fixture packer must not run');\n").unwrap();
        workspace
    }

    fn assert_unchanged_inputs(&self) {
        assert_eq!(
            fs::read(self.producer.join("caller-owned")).unwrap(),
            b"unchanged producer input"
        );
        assert_eq!(fs::read_dir(&self.producer).unwrap().count(), 1);
        assert_eq!(fs::read_dir(&self.project).unwrap().count(), 1);
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        remove_owned_directory(&self.root);
    }
}

#[test]
fn managed_constructor_rejects_missing_boundaries_before_creating_output() {
    let fixture = Fixture::new();
    let mut wrong_consumer = fixture.config();
    wrong_consumer.pack_consumer = DevPackConsumer::LocalRuntime;
    assert!(matches!(
        DevSupervisor::spawn(wrong_consumer),
        Err(DevError::BrowserRuntime(_))
    ));
    assert!(!fixture.output.exists());

    let mut no_pins = fixture.config();
    no_pins.browser_runtime = None;
    assert!(matches!(
        DevSupervisor::spawn(no_pins),
        Err(DevError::BrowserRuntime(_))
    ));
    assert!(!fixture.output.exists());

    let mut custom_compiler = fixture.config();
    custom_compiler.wv_bin = fixture.root.join("custom-wv-must-not-start");
    assert!(matches!(
        DevSupervisor::spawn(custom_compiler),
        Err(DevError::BrowserRuntime(_))
    ));
    assert!(!fixture.output.exists());

    let mut no_managed_source = fixture.config();
    no_managed_source.managed_browser_sources = false;
    no_managed_source.managed_browser_stages = true;
    assert!(matches!(
        DevSupervisor::spawn(no_managed_source),
        Err(DevError::BrowserRuntime(message)) if message.contains("actual managed source pipeline")
    ));
    assert!(!fixture.output.exists());
    fixture.assert_unchanged_inputs();
}

#[test]
fn managed_constructor_rejects_v8_and_invalid_pins_without_tool_side_effects() {
    let fixture = Fixture::new();
    let mut v8 = fixture.config();
    v8.engine = EngineKind::V8;
    assert!(matches!(
        DevSupervisor::spawn(v8),
        Err(DevError::BrowserEngineUnavailable)
    ));
    assert!(!fixture.output.exists());

    let mut invalid = fixture.config();
    invalid
        .browser_runtime
        .as_mut()
        .unwrap()
        .expected
        .report_sha256 = "unverified".into();
    assert!(matches!(
        DevSupervisor::spawn(invalid),
        Err(DevError::BrowserRuntime(_))
    ));
    assert!(!fixture.output.exists());
    fixture.assert_unchanged_inputs();
}

#[test]
fn managed_constructor_rejects_an_actual_different_compiler_checkout_before_output() {
    let fixture = Fixture::new();
    let workspace = fixture.tool_workspace("different-workspace");
    let vendor = workspace.join("vendor/weapp-vite");
    let hooks = fixture.root.join("empty-hooks");
    fs::create_dir_all(&vendor).unwrap();
    fs::create_dir(&hooks).unwrap();
    let init = Command::new("git")
        .args(["init", "--quiet", "--template"])
        .arg(&hooks)
        .arg(&vendor)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(
        init.status.success(),
        "initialize isolated compiler fixture"
    );
    let commit = Command::new("git")
        .arg("-c")
        .arg(format!("core.hooksPath={}", hooks.display()))
        .args([
            "-c",
            "user.name=Managed Source Test",
            "-c",
            "user.email=managed-source-test@example.invalid",
            "-c",
            "commit.gpgSign=false",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "isolated compiler identity",
        ])
        .current_dir(&vendor)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(commit.status.success(), "create isolated compiler identity");

    let mut config = fixture.config();
    config.workspace_root = Some(workspace);
    let error = DevSupervisor::spawn(config).unwrap_err();
    assert!(error.to_string().contains("frozen baseline"));
    assert!(!fixture.output.exists());
    fixture.assert_unchanged_inputs();
}

#[test]
fn managed_constructor_rejects_modern_inputs_and_mismatched_claim_before_output() {
    let fixture = Fixture::new();
    let mut different_claim = fixture.config();
    different_claim.compiler_commit = Some("d".repeat(40));
    let error = DevSupervisor::spawn(different_claim).unwrap_err();
    assert!(error.to_string().contains("claim differs"));
    assert!(!fixture.output.exists());

    fs::write(fixture.project.join("container.config.json"), b"{}").unwrap();
    let error = DevSupervisor::spawn(fixture.config()).unwrap_err();
    assert!(error.to_string().contains("modern View"));
    assert!(!fixture.output.exists());
    assert_eq!(
        fs::read(fixture.project.join("container.config.json")).unwrap(),
        b"{}"
    );
    assert_eq!(
        fs::read(fixture.producer.join("caller-owned")).unwrap(),
        b"unchanged producer input"
    );
}

#[test]
fn managed_shutdown_before_first_poll_has_no_child_or_runtime_files() {
    let fixture = Fixture::new();
    let (mut supervisor, event) = DevSupervisor::spawn(fixture.config()).unwrap();
    assert!(matches!(event, DevEvent::BuildStarted));
    assert!(supervisor.child.is_none());
    assert!(supervisor.output_readers.is_empty());
    assert!(supervisor
        .browser_runtime
        .as_ref()
        .unwrap()
        .report()
        .is_none());
    let source = supervisor.managed_source.as_ref().unwrap();
    assert!(!source.started);
    assert!(source.command.is_some());
    assert!(source.issued.is_none());
    assert!(source.raw.is_none());
    assert!(source.packing.is_none());
    assert!(source.current.is_none());
    assert!(!source.publication_current(&supervisor));

    let preparation = supervisor.preparation_root.path.clone();
    let runtime = supervisor.run_root.join("browser-artifacts");
    assert!(preparation.is_dir());
    assert!(!runtime.exists());
    assert!(supervisor.try_shutdown().unwrap());
    assert!(!preparation.exists());
    assert!(!runtime.exists());
    assert!(supervisor.browser_runtime.is_none());
    let source = supervisor.managed_source.as_ref().unwrap();
    assert!(source.command.is_none());
    assert!(source.sender.is_none());
    assert!(supervisor.child.is_none());
    assert!(supervisor.try_shutdown().unwrap());
    drop(supervisor);
    fixture.assert_unchanged_inputs();
}

#[test]
fn managed_unpolled_drop_releases_only_its_preparation_directory() {
    let fixture = Fixture::new();
    let (supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
    let preparation = supervisor.preparation_root.path.clone();
    let publication = supervisor.run_root.clone();
    assert!(preparation.is_dir());
    drop(supervisor);
    assert!(!preparation.exists());
    assert!(publication.join("dev-session.json").is_file());
    assert!(!publication.join("browser-artifacts").exists());
    fixture.assert_unchanged_inputs();
}

#[test]
#[cfg(unix)]
fn managed_shutdown_joins_remaining_readers_after_a_reader_panics_then_retries_cleanup() {
    use std::os::unix::net::UnixStream;
    use std::sync::atomic::AtomicBool;

    struct CompletionReader {
        stream: UnixStream,
        finished: Arc<AtomicBool>,
    }

    impl Read for CompletionReader {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            self.stream.read(bytes)
        }
    }

    impl Drop for CompletionReader {
        fn drop(&mut self) {
            self.finished.store(true, Ordering::Release);
        }
    }

    let fixture = Fixture::new();
    let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
    let preparation = supervisor.preparation_root.path.clone();
    let (reader_stream, mut writer_stream) = UnixStream::pair().unwrap();
    let reader_finished = Arc::new(AtomicBool::new(false));
    let sender = supervisor
        .managed_source
        .as_ref()
        .unwrap()
        .sender
        .as_ref()
        .unwrap()
        .clone();
    let reader = spawn_output_reader(
        CompletionReader {
            stream: reader_stream,
            finished: reader_finished.clone(),
        },
        sender,
    );
    supervisor.output_readers.push(std::thread::spawn(|| {
        panic!("controlled first reader failure")
    }));
    supervisor.output_readers.push(reader);

    // Keep the real output reader pending across the first join. This is a
    // cleanup-order assertion, not an elapsed-time performance assertion.
    let writer = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(100));
        writer_stream.write_all(b"remaining reader completed\n")
    });
    let first_shutdown = supervisor.try_shutdown();
    let reader_finished_at_return = reader_finished.load(Ordering::Acquire);
    let preparation_retained_at_return = preparation.is_dir();

    // Also clean up on the buggy early-return path before asserting the
    // captured result: dropping a drained JoinHandle must not leak a test task.
    writer.join().unwrap().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !reader_finished.load(Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "actual output reader did not exit"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    let output = supervisor
        .build_output_rx
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(output.line, "remaining reader completed");
    assert!(matches!(first_shutdown, Err(DevError::BrowserRuntime(_))));
    assert!(
        reader_finished_at_return,
        "shutdown detached a pending reader"
    );
    assert!(preparation_retained_at_return);
    assert!(supervisor.preparation_root.active);
    assert!(supervisor.output_readers.is_empty());
    assert!(supervisor.browser_runtime.is_some());
    assert!(supervisor.try_shutdown().unwrap());
    assert!(!preparation.exists());
    assert!(supervisor.browser_runtime.is_none());
    drop(supervisor);
    fixture.assert_unchanged_inputs();
}

#[test]
fn unstarted_managed_command_is_released_without_running_or_leaking_sender() {
    let fixture = Fixture::new();
    let marker = fixture.root.join("command-must-not-run");
    let mut command = Command::new(&marker);
    command.arg("unstarted-command");
    let (sender, receiver) = mpsc::channel();
    let mut source = ManagedSourceBuild::new(command, sender);
    assert!(matches!(receiver.try_recv(), Err(TryRecvError::Empty)));
    source.release_inputs();
    source.release_inputs();
    assert!(matches!(
        receiver.try_recv(),
        Err(TryRecvError::Disconnected)
    ));
    assert!(!marker.exists());
    assert!(!source.started);
    assert!(source.command.is_none());
    assert!(source.sender.is_none());
}

#[test]
fn preparation_drop_preserves_bytes_when_the_barrier_is_incomplete() {
    let fixture = Fixture::new();
    let retained = fixture.root.join("retained-preparation");
    fs::create_dir(&retained).unwrap();
    fs::write(retained.join("writer-owned"), b"retain until barrier").unwrap();
    let mut owner = PreparationOwner::new(retained.clone());
    owner.preserve_on_drop = true;
    drop(owner);
    assert_eq!(
        fs::read(retained.join("writer-owned")).unwrap(),
        b"retain until barrier"
    );
}

#[test]
fn preparation_try_release_preserves_ownership_on_error_and_retries_same_path() {
    let fixture = Fixture::new();
    let path = fixture.root.join("retry-preparation");
    // A regular file produces a deterministic remove_dir_all error without
    // relying on permissions, administrator status, or platform open-file rules.
    fs::write(&path, b"not a directory yet").unwrap();
    let mut owner = PreparationOwner::new(path.clone());
    owner.preserve_on_drop = true;
    assert!(owner.try_release().is_err());
    assert!(owner.active);
    assert_eq!(fs::read(&path).unwrap(), b"not a directory yet");
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    fs::write(path.join("retained"), b"same recovery owner").unwrap();
    owner.try_release().unwrap();
    assert!(!owner.active);
    assert!(!path.exists());
}

#[test]
fn ordinary_preparation_drop_still_cleans_legacy_files() {
    let fixture = Fixture::new();
    let path = fixture.root.join("legacy-preparation");
    fs::create_dir(&path).unwrap();
    fs::write(path.join("owned"), b"legacy").unwrap();
    drop(PreparationOwner::new(path.clone()));
    assert!(!path.exists());
}

#[test]
#[cfg(unix)]
fn legacy_supervisor_keeps_actual_child_owner_and_stops_it_before_cleanup() {
    let fixture = Fixture::new();
    let workspace = fixture.tool_workspace("legacy-workspace");
    let scripts = workspace.join("scripts");
    fs::create_dir_all(&scripts).unwrap();
    let heartbeat = fixture.root.join("legacy-watcher-heartbeat");
    let quoted_heartbeat = format!("'{}'", heartbeat.to_string_lossy().replace('\'', "'\\''"));
    fs::write(
        scripts.join("simulator-watch.mjs"),
        format!(
            "#!/bin/sh\nset -eu\ntrap 'exit 0' TERM INT\nwhile :; do printf tick >> {quoted_heartbeat}; sleep 0.02; done\n"
        ),
    )
    .unwrap();
    let mut config = fixture.config();
    config.managed_browser_sources = false;
    config.browser_runtime = None;
    config.workspace_root = Some(workspace);
    config.node_bin = PathBuf::from("/bin/sh");
    let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
    assert!(supervisor.child.is_some());
    assert!(supervisor.managed_source.is_none());
    let preparation = supervisor.preparation_root.path.clone();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !heartbeat.exists() {
        assert!(
            Instant::now() < deadline,
            "actual legacy child did not start"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(supervisor.try_shutdown().unwrap());
    assert!(!preparation.exists());
    assert!(supervisor.output_readers.is_empty());
    assert!(supervisor
        .child
        .as_mut()
        .unwrap()
        .try_wait()
        .unwrap()
        .is_some());
    let stopped_bytes = fs::read(&heartbeat).unwrap();
    std::thread::sleep(Duration::from_millis(60));
    assert_eq!(fs::read(&heartbeat).unwrap(), stopped_bytes);
    assert!(supervisor.try_shutdown().unwrap());
    drop(supervisor);
    fixture.assert_unchanged_inputs();
}
