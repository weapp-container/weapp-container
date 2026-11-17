//! Synthetic byte/owner contracts for the static runtime receipt boundary.
//! Unix artifact-job-owned test factory provides a REAL finite job and original result bytes.
//! The producer report/bundle are explicitly synthetic. No Node assembler,
//! source-inventory recipe, module validation, Worker or presenter is exercised.
#![cfg(all(test, unix))]

use super::*;
use crate::browser_dev_artifact_job::runtime_receipt_test_support::{self, JOB_NAME, REQUEST_ID};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "runtime-receipt-synthetic-{}-{nonce}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(fs::canonicalize(root).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn json_bytes(value: &Value) -> Vec<u8> {
    let mut bytes = serde_json::to_vec_pretty(value).unwrap();
    bytes.push(b'\n');
    bytes
}
fn file_pin(path: &str, bytes: &[u8]) -> Value {
    json!({"path":path,"sha256":sha(bytes),"size":bytes.len()})
}
struct Synthetic {
    expected: ProducerExpected,
    files: BTreeMap<String, Vec<u8>>,
    result: Value,
}
impl Synthetic {
    fn new(output: &Path) -> Self {
        let mut files = BTreeMap::new();
        let mut source = BTreeMap::new();
        for path in [
            "Cargo.toml",
            "Cargo.lock",
            "rust-toolchain.toml",
            "scripts/build-web-wasm.mjs",
            "scripts/generated-package-closure.mjs",
            "examples/hosts/web-wasm/renderer-dependency-pins.json",
            "scripts/portable-pack.mjs",
            "scripts/modern-view-pack-resources.mjs",
            "tools/container-manifest/src/json-integrity.mjs",
        ] {
            source.insert(
                path.to_owned(),
                format!("synthetic source {path}\n").into_bytes(),
            );
        }
        for path in WEB_FILES {
            let bytes = format!("// synthetic, not executable acceptance: {path}\n").into_bytes();
            source.insert(format!("examples/hosts/web-wasm/{path}"), bytes.clone());
            files.insert((*path).to_owned(), bytes);
        }
        let source_hashes: BTreeMap<_, _> = source
            .iter()
            .map(|(path, bytes)| (path.clone(), sha(bytes)))
            .collect();
        for (path, bytes) in source {
            files.insert(format!("source/{path}"), bytes);
        }
        files.insert(
            "pkg/container_host_web.js".into(),
            b"// synthetic generated glue, never imported\n".to_vec(),
        );
        files.insert(
            "pkg/container_host_web_bg.wasm".into(),
            b"synthetic bytes, never instantiated".to_vec(),
        );
        files.insert(
            "validation/generated-module-parser/dist/acorn.mjs".into(),
            b"// synthetic parser, never evaluated\n".to_vec(),
        );
        files.insert(
            "runtime-config.json".into(),
            json_bytes(&json!({"schemaVersion":1,"renderer":"software","fallback":"error"})),
        );
        let browser_files: Vec<_> = WEB_FILES.iter().map(|path| json!({"path":path,
            "sourcePath":format!("examples/hosts/web-wasm/{path}"),"sha256":sha(&files[*path]),"size":files[*path].len()})).collect();
        let generated: Vec<_> = [
            "pkg/container_host_web.js",
            "pkg/container_host_web_bg.wasm",
        ]
        .into_iter()
        .map(|path| file_pin(path, &files[path]))
        .collect();
        let parser = file_pin(
            "dist/acorn.mjs",
            &files["validation/generated-module-parser/dist/acorn.mjs"],
        );
        let config = &files["runtime-config.json"];
        // Deliberately synthetic external marker, not a claimed JS recipe.
        // The production factory relies on a trusted Node-helper launch for the
        // exact metadata recipe; this fixture only tests byte/ownership intake.
        let source_sha256 = "c".repeat(64);
        let source_commit = "a".repeat(40);
        let report = json!({"schemaVersion":1,"scope":"quickjs-browser-wasm-build","status":"passed",
            "buildStatus":"passed","ready":true,"plan":{"execution":"worker","renderer":"software"},
            "source":{"status":"passed","workingTreeDirty":false,"sourceStable":true,
                "sourceCommit":source_commit,"sourceSha256":source_sha256,"sourceFiles":source_hashes},
            "browserAssets":{"status":"passed","retainedStatus":"passed","files":browser_files},
            "generatedPackage":{"status":"passed","retainedStatus":"passed","files":generated},
            "generatedModuleParser":{"status":"passed","retainedStatus":"passed","files":[parser]},
            "rendererDependencies":{"status":"passed","retainedStatus":"passed","renderer":"software",
                "files":[],"runtimeConfig":{"path":"runtime-config.json","sha256":sha(config),"bytes":config.len()}}});
        let report_bytes = json_bytes(&report);
        let expected = ProducerExpected {
            report_sha256: sha(&report_bytes),
            source_commit,
            source_sha256,
            renderer: RuntimeBundleRenderer::Software,
        };
        files.insert("build-report.json".into(), report_bytes);
        let producer = json!({"reportSha256":expected.report_sha256,"sourceCommit":expected.source_commit,
            "sourceSha256":expected.source_sha256,"renderer":"software"});
        let inventory: Vec<_> = files
            .iter()
            .map(|(path, bytes)| file_pin(path, bytes))
            .collect();
        let runtime_files: Vec<_> = files
            .iter()
            .filter(|(path, _)| {
                (WEB_FILES.contains(&path.as_str())
                    && !EXCLUDED_WEB_ENTRIES.contains(&path.as_str()))
                    || path.starts_with("pkg/")
                    || path.as_str() == "runtime-config.json"
            })
            .map(|(path, bytes)| file_pin(path, bytes))
            .collect();
        let bundle_id = "b".repeat(64); // Informational synthetic marker, no unsigned JSON hash recipe.
        let bundle = json!({"schemaVersion":1,"scope":"browser-runtime-bundle","producer":producer,
            "files":inventory,"runtimeFiles":runtime_files,"appService":"not-run","presentation":"not-run",
            "gpu":"unknown","bundleId":bundle_id});
        let bundle_bytes = json_bytes(&bundle);
        let result = json!({"schemaVersion":1,"requestId":REQUEST_ID,"op":"retain-runtime","status":"staged-static",
            "runtime":{"directory":output,"bundleId":bundle_id,"descriptorSha256":sha(&bundle_bytes),
                "producer":producer,"runtimeFiles":runtime_files,"provenance":{"status":"retained-static-verified",
                    "appService":"not-run","presentation":"not-run","gpu":"unknown","producerGlueInterfaceReexecuted":false}},
            "runtimeReady":false,"presentedReady":false});
        files.insert("runtime-bundle.json".into(), bundle_bytes);
        Self {
            expected,
            files,
            result,
        }
    }
}

fn start(
    mutate: impl FnOnce(&mut Synthetic),
) -> (
    Fixture,
    PendingRuntimeReceipt,
    ArtifactJobCompletion,
    Synthetic,
) {
    let fixture = Fixture::new();
    let output = fixture.0.join(JOB_NAME).join("output");
    let mut synthetic = Synthetic::new(&output);
    mutate(&mut synthetic);
    let result = json_bytes(&synthetic.result);
    // This cfg(test)-only sibling capability supplies no command/entrypoint,
    // request, config or tool-lease override to receipt tests. Its fixed child
    // copies these uninterpreted bytes into the REAL owned result.json.
    let mut job = runtime_receipt_test_support::spawn(&fixture.0, &result).unwrap();
    assert_eq!(job.files().root().to_path_buf(), fixture.0.join(JOB_NAME));
    assert_eq!(job.files().output(), output);
    let request_sha256 = sha(&fs::read(job.files().root().join("request.json")).unwrap());
    let pending = PendingRuntimeReceipt::bind(
        &job,
        REQUEST_ID.into(),
        request_sha256,
        synthetic.expected.clone(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let completion = loop {
        if let Some(completion) = job.poll().unwrap() {
            break completion;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(1));
    };
    drop(job); // Real finite cleanup completed; release this job's extra Arc.
    fs::create_dir(&output).unwrap();
    for (path, bytes) in &synthetic.files {
        let path = output.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    (fixture, pending, completion, synthetic)
}

// Return a receipt accepted from the actual finite fixture completion; there
// is no test-only struct constructor that can bypass the receipt validator.
pub(crate) fn accepted_runtime_fixture() -> (Fixture, StaticRuntimeReceipt) {
    let (fixture, pending, completion, _) = start(|_| {});
    (fixture, pending.accept(completion).unwrap())
}

#[test]
fn exact_raw_result_report_and_bundle_are_retained_without_reencoding() {
    let (_fixture, pending, completion, synthetic) = start(|_| {});
    let raw_result = completion.result.as_ref().unwrap().clone();
    let receipt = pending.accept(completion).unwrap();
    assert_eq!(receipt.raw_result(), raw_result.as_slice());
    assert_eq!(
        receipt.raw_report(),
        synthetic.files["build-report.json"].as_slice()
    );
    assert_eq!(
        receipt.raw_bundle(),
        synthetic.files["runtime-bundle.json"].as_slice()
    );
    assert_eq!(receipt.pins().bundle_sha256, sha(receipt.raw_bundle()));
    assert_eq!(
        receipt.pins().source_inventory_sha256,
        synthetic.expected.source_sha256
    );
    assert!(receipt.resource("runtime-worker.mjs").is_some());
    for forbidden in [
        "build-report.json",
        "source/Cargo.toml",
        "runtime-bundle.json",
        "index.html",
        "worker-app.mjs",
    ] {
        assert!(receipt.resource(forbidden).is_none());
    }
}

#[test]
fn unknown_duplicate_and_missing_result_keys_are_rejected_with_actual_completion() {
    for mutation in 0..3 {
        let (_fixture, pending, mut completion, _synthetic) = start(|value| {
            if mutation == 0 {
                value.result["stage"] = json!({});
            }
            if mutation == 1 {
                value.result.as_object_mut().unwrap().remove("runtimeReady");
            }
        });
        if mutation == 2 {
            let original = std::str::from_utf8(completion.result.as_ref().unwrap()).unwrap();
            completion.result = Ok(Arc::new(
                original
                    .replacen('{', "{\"schemaVersion\":1,", 1)
                    .into_bytes(),
            ));
        }
        let actual_files = completion.files.clone();
        let original = completion.result.as_ref().unwrap().clone();
        let failure = pending.accept(completion).unwrap_err();
        assert!(Arc::ptr_eq(&actual_files, &failure.completion().files));
        assert!(Arc::ptr_eq(
            &original,
            failure.completion().result.as_ref().unwrap()
        ));
        assert!(actual_files.output().exists());
    }
}

#[test]
fn foreign_completion_cannot_be_bound_by_matching_path_or_result_claims() {
    let (_fixture_a, pending_a, completion_a, _) = start(|_| {});
    let (_fixture_b, _pending_b, completion_b, _) = start(|_| {});
    let actual_b = completion_b.files.clone();
    let failure = pending_a.accept(completion_b).unwrap_err();
    assert!(Arc::ptr_eq(&actual_b, &failure.completion().files));
    drop(completion_a);
}

#[test]
fn child_cannot_replace_external_producer_pin_or_choose_another_directory() {
    for mutation in 0..2 {
        let (_fixture, pending, completion, _) = start(|value| {
            if mutation == 0 {
                value.result["runtime"]["producer"]["reportSha256"] = json!("e".repeat(64));
            } else {
                value.result["runtime"]["directory"] = json!("/must-never-be-opened-by-intake");
            }
        });
        assert!(pending.accept(completion).is_err());
    }
}

#[test]
fn original_report_mutation_and_symlink_with_matching_bytes_are_rejected() {
    for path in ["build-report.json", "runtime-worker.mjs"] {
        let (_fixture, pending, completion, _) = start(|_| {});
        let resource = completion.files.output().join(path);
        let mut bytes = fs::read(&resource).unwrap();
        bytes.push(b'\n');
        fs::write(resource, bytes).unwrap();
        assert!(pending.accept(completion).is_err());
    }

    let (fixture, pending, completion, _) = start(|_| {});
    let resource = completion.files.output().join("runtime-worker.mjs");
    let external = fixture.0.join("unowned-resource.mjs");
    fs::write(&external, fs::read(&resource).unwrap()).unwrap();
    fs::remove_file(&resource).unwrap();
    std::os::unix::fs::symlink(&external, resource).unwrap();
    assert!(pending.accept(completion).is_err());
}

#[test]
fn extra_tree_file_or_extra_serve_claim_and_oversized_descriptor_are_rejected() {
    for mutation in 0..3 {
        let (_fixture, pending, completion, _) = start(|value| {
            if mutation == 0 {
                value
                    .files
                    .insert("extra.mjs".into(), b"unowned allowlist extension".to_vec());
            }
            if mutation == 1 {
                value.result["runtime"]["runtimeFiles"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!({"path":"source/Cargo.toml","sha256":"d".repeat(64),"size":1}));
            }
            if mutation == 2 {
                let mut bundle: Value =
                    serde_json::from_slice(&value.files["runtime-bundle.json"]).unwrap();
                bundle["files"][0]["size"] = json!(MAX_FILE as u64 + 1);
                let bytes = json_bytes(&bundle);
                value.result["runtime"]["descriptorSha256"] = json!(sha(&bytes));
                value.files.insert("runtime-bundle.json".into(), bytes);
            }
        });
        assert!(pending.accept(completion).is_err());
    }
}

#[test]
fn resource_borrow_retains_actual_files_until_final_cleanup_can_be_exclusive() {
    let (_fixture, pending, completion, _) = start(|_| {});
    let receipt = pending.accept(completion).unwrap();
    let body = receipt.resource("runtime-worker.mjs").unwrap();
    let root = body.owned_files().root().to_path_buf();
    let mut completion = receipt.into_completion();
    assert!(Arc::get_mut(&mut completion.files).is_none());
    assert!(root.exists());
    drop(body);
    Arc::get_mut(&mut completion.files)
        .unwrap()
        .cleanup()
        .unwrap();
    assert!(!root.exists());
}

#[test]
fn cancelled_or_nonzero_exit_or_readiness_claim_cannot_make_a_static_receipt() {
    use crate::browser_dev_artifact_job::ArtifactJobStop;
    use std::os::unix::process::ExitStatusExt;
    for mutation in 0..3 {
        let (_fixture, pending, mut completion, _) = start(|value| {
            if mutation == 2 {
                value.result["runtimeReady"] = json!(true);
            }
        });
        if mutation == 0 {
            completion.stopped = Some(ArtifactJobStop::Cancelled);
        }
        if mutation == 1 {
            completion.exit_status = std::process::ExitStatus::from_raw(7 << 8);
        }
        assert!(pending.accept(completion).is_err());
    }
}
