//! Explicit integration gate for externally pinned real Worker builds.
//! A real clean Worker producer -> embedded finite Node retain -> Rust receipt.
//! Static retention only: no Worker, AppService, HTTP server, browser or GPU.
//!
//! Explicit opt-in: cargo test -p container-simulator --locked -j4 --test retained_runtime --
//! --ignored --test-threads=1 --exact independently_pinned_worker_runtime_is_retained_and_cleaned
//! Missing/invalid environment FAILS; it never skips or synthesizes a producer.

use container_simulator::browser_dev_artifact_job::{
    ArtifactConstructionError, ArtifactJob, ArtifactJobCompletion, ArtifactJobConfig,
    ArtifactToolSnapshot,
};
use container_simulator::browser_dev_runtime_receipt::{
    PendingRuntimeReceipt, ProducerExpected, RuntimeBundleRenderer, StaticRuntimeReceipt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::error::Error;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

type TestResult<T = ()> = Result<T, Box<dyn Error>>;
const PREFIX: &str = "WEAPP_CONTAINER_RETAINED_RUNTIME_";
const EXCLUDED: &[&str] = &["index.html", "legacy.html", "app.mjs", "worker-app.mjs"];
const MAX_DESCRIPTOR_BYTES: u64 = 16 * 1024 * 1024;

fn ensure(condition: bool, message: impl Into<String>) -> TestResult {
    if condition {
        Ok(())
    } else {
        Err(io::Error::other(message.into()).into())
    }
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn required(name: &str) -> TestResult<String> {
    let full = format!("{PREFIX}{name}");
    let value = std::env::var(&full)
        .map_err(|error| io::Error::other(format!("required external input {full}: {error}")))?;
    ensure(
        !value.is_empty(),
        format!("required external input {full} is empty"),
    )?;
    Ok(value)
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_input(name: &str, directory: bool) -> TestResult<PathBuf> {
    let path = PathBuf::from(required(name)?);
    ensure(path.is_absolute(), format!("{name} must be absolute"))?;
    ensure(
        fs::canonicalize(&path)? == path,
        format!("{name} must be canonical"),
    )?;
    let metadata = fs::symlink_metadata(&path)?;
    ensure(
        !metadata.file_type().is_symlink()
            && if directory {
                metadata.is_dir()
            } else {
                metadata.is_file()
            },
        format!("{name} has the wrong filesystem type"),
    )?;
    Ok(path)
}

struct Inputs {
    producer: PathBuf,
    node: PathBuf,
    evidence_parent: PathBuf,
    expected: ProducerExpected,
    pin_authority: String,
}

impl Inputs {
    fn from_env() -> TestResult<Self> {
        let report_sha256 = required("REPORT_SHA256")?;
        let source_commit = required("SOURCE_COMMIT")?;
        let source_sha256 = required("SOURCE_SHA256")?;
        ensure(
            hex(&report_sha256, 64),
            "external REPORT_SHA256 must be lower-case SHA-256",
        )?;
        ensure(
            hex(&source_sha256, 64),
            "external SOURCE_SHA256 must be lower-case SHA-256",
        )?;
        ensure(
            hex(&source_commit, 40),
            "current producer requires exact 40-hex SOURCE_COMMIT",
        )?;
        let renderer = match required("RENDERER")?.as_str() {
            "software" => RuntimeBundleRenderer::Software,
            "canvaskit" => RuntimeBundleRenderer::Canvaskit,
            _ => return Err(io::Error::other("RENDERER must be software or canvaskit").into()),
        };
        let producer = canonical_input("BUILD_SITE", true)?;
        let node = canonical_input("NODE_BIN", false)?;
        let evidence_parent = canonical_input("EVIDENCE_PARENT", true)?;
        ensure(
            !evidence_parent.starts_with(&producer),
            "evidence must not be created inside the read-only producer",
        )?;
        Ok(Self {
            producer,
            node,
            evidence_parent,
            expected: ProducerExpected {
                report_sha256,
                source_commit,
                source_sha256,
                renderer,
            },
            pin_authority: required("PIN_AUTHORITY")?,
        })
    }

    fn renderer_name(&self) -> &'static str {
        match self.expected.renderer {
            RuntimeBundleRenderer::Software => "software",
            RuntimeBundleRenderer::Canvaskit => "canvaskit",
        }
    }
}

fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir(path)
    }
}

fn write_new(path: &Path, bytes: &[u8]) -> TestResult {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(bytes)?;
    Ok(())
}

fn write_json(path: &Path, value: &Value) -> TestResult {
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    write_new(path, &bytes)
}

// Evidence observation only. Authenticity comes from the required external
// report pin plus the actual embedded-helper/receipt verification, not this
// helper. The producer is frozen and the actual output child already retired.
fn read_descriptor(path: &Path) -> TestResult<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    ensure(
        before.is_file()
            && !before.file_type().is_symlink()
            && before.len() <= MAX_DESCRIPTOR_BYTES
            && fs::canonicalize(path)? == path,
        "descriptor is not canonical regular bounded data",
    )?;
    let mut file = File::open(path)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(before.len() as usize)?;
    bytes.resize(before.len() as usize, 0);
    file.read_exact(&mut bytes)?;
    let mut extra = [0_u8; 1];
    let read_extra = loop {
        match file.read(&mut extra) {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => break result?,
        }
    };
    let after = file.metadata()?;
    ensure(
        read_extra == 0 && after.len() == before.len() && after.modified()? == before.modified()?,
        "descriptor changed during evidence read",
    )?;
    Ok(bytes)
}

/// Actual owners stay in this record across all fallible verification work.
/// There is deliberately no Drop that recursively removes a live job's parent.
struct Run {
    evidence: PathBuf,
    work: PathBuf,
    tools_root: PathBuf,
    job_root: PathBuf,
    tools: Option<ArtifactToolSnapshot>,
    job: Option<ArtifactJob>,
    completion: Option<ArtifactJobCompletion>,
    receipt: Option<StaticRuntimeReceipt>,
    construction_failure: Option<ArtifactConstructionError>,
}

impl Run {
    fn create(inputs: &Inputs) -> TestResult<Self> {
        let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
        let evidence = inputs
            .evidence_parent
            .join(format!("retained-runtime-{}-{nonce}", std::process::id()));
        private_directory(&evidence)?; // Exclusive: never reuse/overwrite old evidence.
        let evidence = fs::canonicalize(evidence)?;
        ensure(
            !evidence.starts_with(&inputs.producer) && !inputs.producer.starts_with(&evidence),
            "new evidence directory overlaps producer",
        )?;
        let work = evidence.join("owned-work");
        private_directory(&work)?;
        Ok(Self {
            tools_root: work.join("embedded-tools"),
            job_root: work.join("retain-runtime"),
            evidence,
            work,
            tools: None,
            job: None,
            completion: None,
            receipt: None,
            construction_failure: None,
        })
    }

    fn complete_job_shutdown(&mut self) -> TestResult {
        let deadline = Instant::now() + Duration::from_secs(30);
        while let Some(job) = &mut self.job {
            if job.shutdown()? {
                drop(self.job.take());
                return Ok(());
            }
            ensure(
                Instant::now() < deadline,
                "owned finite job shutdown is unresolved",
            )?;
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }

    fn cleanup(&mut self) -> TestResult {
        if let Some(failure) = &mut self.construction_failure {
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                if failure.retry_cleanup()? {
                    break;
                }
                ensure(
                    Instant::now() < deadline,
                    "actual construction recovery remains owned",
                )?;
                std::thread::sleep(Duration::from_millis(5));
            }
        }
        self.construction_failure = None;
        self.complete_job_shutdown()?;
        if self.receipt.is_some() {
            ensure(
                self.completion.is_none(),
                "two actual completions cannot share one run slot",
            )?;
            self.completion = Some(
                self.receipt
                    .take()
                    .expect("checked receipt")
                    .into_completion(),
            );
        }
        if let Some(completion) = &mut self.completion {
            let owner = Arc::get_mut(&mut completion.files).ok_or_else(|| {
                io::Error::other("runtime body borrow still prevents file cleanup")
            })?;
            owner.cleanup()?;
        }
        self.completion = None;
        ensure(
            !self.job_root.try_exists()?,
            "actual job namespace remains after explicit cleanup",
        )?;
        // The public tool API has no explicit cleanup method. Release its last
        // actual lease and VERIFY removal; Drop alone is not a success claim.
        drop(self.tools.take());
        ensure(
            !self.tools_root.try_exists()?,
            "actual embedded-tool namespace remains after last lease",
        )?;
        fs::remove_dir(&self.work)?; // Empty only: never recursively mask a leaked owner.
        ensure(!self.work.try_exists()?, "owned work directory remains")
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
struct FilePin {
    path: String,
    sha256: String,
    size: u64,
}

fn report_allowlist(report: &Value) -> TestResult<BTreeMap<String, FilePin>> {
    let mut result = BTreeMap::new();
    let mut add = |pin: FilePin| -> TestResult {
        ensure(
            !pin.path.is_empty() && hex(&pin.sha256, 64),
            "invalid pinned report file",
        )?;
        ensure(
            result.insert(pin.path.clone(), pin).is_none(),
            "duplicate report serve path",
        )
    };
    for name in ["browserAssets", "generatedPackage"] {
        let files = report[name]["files"]
            .as_array()
            .ok_or_else(|| io::Error::other(format!("missing pinned {name} files")))?;
        for file in files {
            let pin: FilePin = serde_json::from_value(file.clone())?;
            if name != "browserAssets" || !EXCLUDED.contains(&pin.path.as_str()) {
                add(pin)?;
            }
        }
    }
    let renderer = &report["rendererDependencies"];
    let config = &renderer["runtimeConfig"];
    add(FilePin {
        path: config["path"]
            .as_str()
            .ok_or_else(|| io::Error::other("missing config path"))?
            .into(),
        sha256: config["sha256"]
            .as_str()
            .ok_or_else(|| io::Error::other("missing config pin"))?
            .into(),
        size: config["bytes"]
            .as_u64()
            .ok_or_else(|| io::Error::other("missing config size"))?,
    })?;
    for file in renderer["files"]
        .as_array()
        .ok_or_else(|| io::Error::other("missing renderer files"))?
    {
        add(FilePin {
            path: file["url"]
                .as_str()
                .ok_or_else(|| io::Error::other("missing renderer URL"))?
                .into(),
            sha256: file["sha256"]
                .as_str()
                .ok_or_else(|| io::Error::other("missing renderer pin"))?
                .into(),
            size: file["size"]
                .as_u64()
                .ok_or_else(|| io::Error::other("missing renderer size"))?,
        })?;
    }
    Ok(result)
}

fn exercise(inputs: &Inputs, run: &mut Run) -> TestResult<Value> {
    let original_report = read_descriptor(&inputs.producer.join("build-report.json"))?;
    ensure(
        sha(&original_report) == inputs.expected.report_sha256,
        "external producer report pin mismatch",
    )?;
    let report: Value = serde_json::from_slice(&original_report)?;
    ensure(
        report["plan"]["execution"] == "worker",
        "producer is not a Worker build",
    )?;
    ensure(
        report["source"]["workingTreeDirty"] == false,
        "producer source was dirty",
    )?;
    ensure(
        report["source"]["sourceStable"] == true,
        "producer source was unstable",
    )?;
    ensure(
        report["source"]["sourceCommit"] == inputs.expected.source_commit,
        "external source commit mismatch",
    )?;
    ensure(
        report["source"]["sourceSha256"] == inputs.expected.source_sha256,
        "external source inventory pin mismatch",
    )?;
    let allowlist = report_allowlist(&report)?;
    ensure(
        allowlist.contains_key("runtime-worker.mjs"),
        "pinned runtime Worker resource absent",
    )?;
    write_new(
        &run.evidence.join("producer-build-report.original.json"),
        &original_report,
    )?;
    write_json(
        &run.evidence.join("inputs.json"),
        &json!({
            "scope":"externally-authorized-static-runtime-retention-inputs",
            "builtSiteDirectory":inputs.producer, "nodeBin":inputs.node,
            "pinAuthority":inputs.pin_authority,
            "expected":{"reportSha256":inputs.expected.report_sha256,
                "sourceCommit":inputs.expected.source_commit,"sourceSha256":inputs.expected.source_sha256,
                "renderer":inputs.renderer_name()},
            "pinOrigin":"required external environment; never inferred from producer/result",
            "runtimeReady":false,"presentedReady":false
        }),
    )?;

    let tools = match ArtifactToolSnapshot::stage(&run.work, "embedded-tools") {
        Ok(tools) => tools,
        Err(failure) => {
            let message = failure.to_string();
            run.construction_failure = Some(failure);
            return Err(io::Error::other(message).into());
        }
    };
    run.tools = Some(tools);
    ensure(
        run.tools
            .as_ref()
            .expect("actual tools")
            .root()
            .to_path_buf()
            == run.tools_root,
        "tool owner root mismatch",
    )?;
    write_new(
        &run.evidence.join("tool-snapshot.original.json"),
        &read_descriptor(&run.tools_root.join("tool-snapshot.json"))?,
    )?;
    let request_id = format!("retained-runtime-{}", std::process::id());
    let request = json!({"schemaVersion":1,"requestId":request_id,"op":"retain-runtime",
        "runtime":{"builtSiteDirectory":inputs.producer,"expected":{
            "reportSha256":inputs.expected.report_sha256,"sourceCommit":inputs.expected.source_commit,
            "sourceSha256":inputs.expected.source_sha256,"renderer":inputs.renderer_name()}}});
    let config = ArtifactJobConfig::new(
        inputs.node.clone(),
        run.tools.as_ref().expect("actual tools").clone(),
        run.work.clone(),
        "retain-runtime".into(),
        Duration::from_secs(300),
    );
    let job = match ArtifactJob::spawn(config, request) {
        Ok(job) => job,
        Err(failure) => {
            let message = failure.to_string();
            run.construction_failure = Some(failure);
            return Err(io::Error::other(message).into());
        }
    };
    run.job = Some(job);
    let job = run.job.as_ref().expect("actual job");
    ensure(
        job.files().root().to_path_buf() == run.job_root,
        "actual job root mismatch",
    )?;
    let request_bytes = read_descriptor(&job.files().root().join("request.json"))?;
    write_new(&run.evidence.join("request.original.json"), &request_bytes)?;
    let request_sha256 = sha(&request_bytes); // Hash ORIGINAL owner-emitted bytes.
    let pending = PendingRuntimeReceipt::bind(
        job,
        request_id,
        request_sha256.clone(),
        inputs.expected.clone(),
    )?;
    let deadline = Instant::now() + Duration::from_secs(330);
    loop {
        if let Some(completion) = run.job.as_mut().expect("actual running job").poll()? {
            run.completion = Some(completion);
            break;
        }
        ensure(
            Instant::now() < deadline,
            "actual finite retirement deadline exceeded",
        )?;
        std::thread::sleep(Duration::from_millis(5));
    }
    let completion = run.completion.as_ref().expect("actual poll completion");
    let raw_result = match &completion.result {
        Ok(bytes) => bytes.clone(),
        Err(error) => return Err(io::Error::other(error.to_string()).into()),
    };
    write_new(
        &run.evidence.join("result.original.json"),
        raw_result.as_slice(),
    )?;
    ensure(
        completion.stopped.is_none() && completion.exit_status.success(),
        "real retain job stopped or exited unsuccessfully",
    )?;
    ensure(
        completion.request_sha256 == request_sha256,
        "actual request bytes binding changed",
    )?;
    let retained_bundle = read_descriptor(&completion.files.output().join("runtime-bundle.json"))?;
    let retained_report = read_descriptor(&completion.files.output().join("build-report.json"))?;
    write_new(
        &run.evidence.join("runtime-bundle.original.json"),
        &retained_bundle,
    )?;
    write_new(
        &run.evidence.join("retained-build-report.original.json"),
        &retained_report,
    )?;
    match pending.accept(
        run.completion
            .take()
            .expect("actual completion consumed once"),
    ) {
        Ok(receipt) => run.receipt = Some(receipt),
        Err(failure) => {
            let message = failure.to_string();
            run.completion = Some(failure.into_completion());
            return Err(io::Error::other(message).into());
        }
    }
    let receipt = run.receipt.as_ref().expect("accepted actual receipt");
    ensure(
        receipt.raw_result() == raw_result.as_slice(),
        "raw result was reencoded",
    )?;
    ensure(
        receipt.raw_bundle() == retained_bundle,
        "raw bundle was reencoded",
    )?;
    ensure(
        receipt.raw_report() == original_report && receipt.raw_report() == retained_report,
        "original report bytes changed",
    )?;
    ensure(
        receipt.renderer() == inputs.expected.renderer,
        "accepted renderer changed",
    )?;
    let pins = receipt.pins();
    ensure(
        pins.bundle_sha256 == sha(&retained_bundle),
        "bundle pin is not full descriptor bytes",
    )?;
    ensure(
        pins.producer_report_sha256 == inputs.expected.report_sha256
            && pins.source_commit == inputs.expected.source_commit
            && pins.source_inventory_sha256 == inputs.expected.source_sha256,
        "accepted independent pins changed",
    )?;
    let bundle: Value = serde_json::from_slice(&retained_bundle)?;
    let result: Value = serde_json::from_slice(raw_result.as_slice())?;
    let wanted: Vec<_> = allowlist.values().cloned().collect();
    let bundled: Vec<FilePin> = serde_json::from_value(bundle["runtimeFiles"].clone())?;
    let returned: Vec<FilePin> = serde_json::from_value(result["runtime"]["runtimeFiles"].clone())?;
    ensure(
        bundled == wanted && returned == wanted,
        "runtime allowlist differs from externally pinned report",
    )?;
    ensure(
        result["runtimeReady"] == false && result["presentedReady"] == false,
        "static receipt claimed readiness",
    )?;
    for (path, pin) in &allowlist {
        let body = receipt
            .resource(path)
            .ok_or_else(|| io::Error::other(format!("missing allowed body: {path}")))?;
        ensure(
            body.bytes().len() as u64 == pin.size && sha(body.bytes()) == pin.sha256,
            format!("immutable runtime body differs from externally pinned report: {path}"),
        )?;
    }
    for denied in [
        "build-report.json",
        "runtime-bundle.json",
        "source/Cargo.toml",
        "index.html",
        "legacy.html",
        "app.mjs",
        "worker-app.mjs",
        "pkg/../source/Cargo.toml",
    ] {
        ensure(
            receipt.resource(denied).is_none(),
            format!("unserved resource leaked: {denied}"),
        )?;
    }
    let bundle_sha256 = pins.bundle_sha256.clone();
    let borrower = receipt
        .resource("runtime-worker.mjs")
        .expect("checked allowed body");
    run.complete_job_shutdown()?; // Remove the job's EXTRA Arc before testing body ownership.
    run.completion = Some(
        run.receipt
            .take()
            .expect("actual receipt")
            .into_completion(),
    );
    let completion = run.completion.as_mut().expect("actual completion retained");
    ensure(
        Arc::ptr_eq(borrower.owned_files(), &completion.files),
        "body detached from actual file owner",
    )?;
    ensure(
        Arc::strong_count(&completion.files) == 2,
        "unexpected file owners invalidate borrower-only proof",
    )?;
    ensure(
        Arc::get_mut(&mut completion.files).is_none(),
        "live body failed to block exclusive cleanup",
    )?;
    ensure(
        run.job_root.is_dir(),
        "actual namespace vanished while body was borrowed",
    )?;
    drop(borrower);
    let owner = Arc::get_mut(&mut completion.files).ok_or_else(|| {
        io::Error::other("body release did not restore actual exclusive file owner")
    })?;
    owner.cleanup()?;
    ensure(
        !run.job_root.try_exists()?,
        "actual namespace remained after explicit cleanup",
    )?;
    ensure(
        read_descriptor(&inputs.producer.join("build-report.json"))? == original_report,
        "producer report changed during static retention",
    )?;
    Ok(
        json!({"requestSha256":request_sha256,"bundleSha256":bundle_sha256,
        "allowedRuntimeFiles":allowlist.len(),"actualJobRetired":true,
        "bodyBorrowBlockedCleanup":true,"borrowReleaseRestoredExclusiveCleanup":true,
        "actualJobNamespaceRemoved":true,"producerReportUnchanged":true}),
    )
}

#[test]
#[ignore = "requires independently pinned clean Worker producer"]
fn independently_pinned_worker_runtime_is_retained_and_cleaned() -> TestResult {
    let inputs = Inputs::from_env()?; // Required env missing => FAIL, never auto-skip.
    let mut run = Run::create(&inputs)?;
    let outcome = exercise(&inputs, &mut run);
    let cleanup = run.cleanup(); // Runs even after verification/evidence-writing failure.
    let report = json!({"schemaVersion":1,"scope":"real-static-runtime-retention-integration",
        "status":if outcome.is_ok() && cleanup.is_ok() {"passed"} else {"failed"},
        "renderer":inputs.renderer_name(),"producerReportSha256":inputs.expected.report_sha256,
        "sourceCommit":inputs.expected.source_commit,"sourceInventorySha256":inputs.expected.source_sha256,
        "result":outcome.as_ref().ok(),"error":outcome.as_ref().err().map(ToString::to_string),
        "cleanup":{"status":if cleanup.is_ok(){"passed"}else{"failed"},
            "error":cleanup.as_ref().err().map(ToString::to_string),
            "jobNamespaceAbsent":!run.job_root.try_exists()?,
            "toolNamespaceAbsent":!run.tools_root.try_exists()?,
            "workDirectoryAbsent":!run.work.try_exists()?},
        "evidenceDirectory":run.evidence,"runtimeReady":false,"presentedReady":false,
        "worker":"not-run","browser":"not-run","gpu":"unknown",
        "limitations":["external pin authenticity/independence remains operator responsibility",
            "Node statically verifies pinned parser/module/WASM closure; no runtime starts",
            "static byte acceptance grants no freshness, HTTP, runtime or presentation authority"]});
    let report_write = write_json(&run.evidence.join("report.json"), &report);
    eprintln!("static retention evidence: {}", run.evidence.display());
    // No recursive cleanup is attempted after an unresolved actual owner.
    // Real owner fields remain in run until this test exits and use their own
    // existing last-resort Drop behavior; no success is claimed for that path.
    cleanup?;
    report_write?;
    outcome.map(|_| ())
}
