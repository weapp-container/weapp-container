//! Byte-bound static runtime resources from one completed finite retain job.
//!
//! The caller supplies independent producer pins and the actual completion.
//! Captured bytes retain their real file owner through every resource borrow;
//! errors return that completion for explicit, fallible cleanup. This layer
//! grants no runtime, presentation, HTTP, or publication authority and does not
//! replace the frozen Node helper's source, module, or WASM validation.

use crate::browser_dev_artifact_job::{ArtifactFiles, ArtifactJob, ArtifactJobCompletion};
use crate::browser_dev_coordinator::RuntimePins;
use crate::browser_dev_read::read_exact_snapshot;
use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

const MAX_RESULT: usize = 16 * 1024 * 1024;
const MAX_DESCRIPTOR: usize = 16 * 1024 * 1024;
const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 16_384;
const MAX_DIRECTORIES: usize = 2_048;
const MAX_SOURCE_FILES: usize = 10_000;
// Exact current WEB_SAMPLE_FILES. A changed closure requires a source change,
// not permission for the child to supply a new executable serve allowlist.
const WEB_FILES: &[&str] = &[
    "index.html",
    "app.mjs",
    "canvaskit-presenter.mjs",
    "text-flow-plan.mjs",
    "render-inputs.mjs",
    "surface-input.mjs",
    "input-causal-ledger.mjs",
    "runtime-worker.mjs",
    "worker-runtime.mjs",
    "worker-session-client.mjs",
    "worker-bridge-transport.mjs",
    "dom-presenter.mjs",
    "dom-session-client.mjs",
    "legacy.html",
    "worker-app.mjs",
    "worker-web-session.mjs",
    "presentation-scheduler.mjs",
    "worker-dom-adapter.mjs",
    "worker-canvaskit-adapter.mjs",
    "worker-admission-loader.mjs",
    "browser-dev-owner-manager.mjs",
];
const EXCLUDED_WEB_ENTRIES: &[&str] = &["index.html", "legacy.html", "app.mjs", "worker-app.mjs"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeBundleRenderer {
    Software,
    Canvaskit,
}

/// Supplied by the trusted owner BEFORE launch, never decoded from the result.
/// The caller must know why this exact producer tuple is authorized.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProducerExpected {
    pub report_sha256: String,
    pub source_commit: String,
    pub source_sha256: String,
    pub renderer: RuntimeBundleRenderer,
}
impl ProducerExpected {
    fn validate(&self) -> Result<()> {
        need(
            is_sha(&self.report_sha256) && is_sha(&self.source_sha256),
            "invalid external producer pin",
        )?;
        // Match the existing Node verifyExpected contract, not a future Git mode.
        need(
            self.source_commit.len() == 40 && is_hex(&self.source_commit),
            "unsupported producer commit",
        )
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ReceiptError {
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Invalid(&'static str),
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Io(#[from] io::Error),
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Json(#[from] serde_json::Error),
}
type Result<T> = std::result::Result<T, ReceiptError>;
fn need(condition: bool, message: &'static str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(ReceiptError::Invalid(message))
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn is_hex(value: &str) -> bool {
    value
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn is_sha(value: &str) -> bool {
    value.len() == 64 && is_hex(value)
}

/// Correlate an actual running job BEFORE its poll completion is consumed.
/// No Deserialize/Clone; the Weak is only an identity binding and is dropped
/// on intake, so it cannot obstruct a later Arc::get_mut cleanup barrier.
#[must_use]
#[derive(Debug)]
pub struct PendingRuntimeReceipt {
    files: Weak<ArtifactFiles>,
    request_id: String,
    request_sha256: String,
    expected: ProducerExpected,
}
impl PendingRuntimeReceipt {
    pub fn bind(
        job: &ArtifactJob,
        request_id: String,
        // Hash of original owner-emitted request.json bytes, not reserialized JSON.
        request_sha256: String,
        expected: ProducerExpected,
    ) -> Result<Self> {
        expected.validate()?;
        need(
            !request_id.is_empty() && request_id.len() <= 128 && is_sha(&request_sha256),
            "invalid expected job binding",
        )?;
        Ok(Self {
            files: Arc::downgrade(job.files()),
            request_id,
            request_sha256,
            expected,
        })
    }

    /// Only pass the actual value returned by this job's poll(). Public struct
    /// fields are not a capability against dishonest Rust in the same process.
    pub fn accept(
        self,
        completion: ArtifactJobCompletion,
    ) -> std::result::Result<StaticRuntimeReceipt, RuntimeReceiptFailure> {
        match self.inspect(&completion) {
            Ok(captured) => Ok(StaticRuntimeReceipt {
                completion,
                captured,
            }),
            Err(cause) => Err(RuntimeReceiptFailure {
                cause,
                completion: Box::new(completion),
            }),
        }
    }

    fn inspect(&self, completion: &ArtifactJobCompletion) -> Result<CapturedRuntime> {
        need(
            self.files.ptr_eq(&Arc::downgrade(&completion.files)),
            "completion belongs to another actual job",
        )?;
        need(
            completion.request_id == self.request_id
                && completion.request_sha256 == self.request_sha256
                && completion.operation == "retain-runtime",
            "completion request binding differs",
        )?;
        need(
            completion.stopped.is_none() && completion.exit_status.success(),
            "finite job failed or was stopped",
        )?;
        let result_bytes = completion
            .result
            .as_ref()
            .map_err(|_| ReceiptError::Invalid("result bytes unavailable"))?;
        need(
            !result_bytes.is_empty() && result_bytes.len() <= MAX_RESULT,
            "result byte budget exceeded",
        )?;
        // Derived structs reject unknown AND duplicate recognized keys; no Value
        // round trip or serde reserialization enters any producer hash domain.
        let result: RetainResult = serde_json::from_slice(result_bytes)?;
        need(
            result.schema_version == 1
                && result.request_id == self.request_id
                && result.op == "retain-runtime"
                && result.status == "staged-static"
                && !result.runtime_ready
                && !result.presented_ready,
            "result is not this static retain receipt",
        )?;
        need(
            result.runtime.producer.matches(&self.expected),
            "child changed independent producer pins",
        )?;
        let provenance = &result.runtime.provenance;
        need(
            provenance.status == "retained-static-verified"
                && provenance.app_service == "not-run"
                && provenance.presentation == "not-run"
                && provenance.gpu == "unknown"
                && !provenance.producer_glue_interface_reexecuted,
            "child claims unsupported runtime authority",
        )?;

        // Never trust result.runtime.directory as an authority to read files.
        let output = completion.files.output();
        need(
            result.runtime.directory == output,
            "runtime directory left actual owned output",
        )?;
        let mut reader = Capture::new(&output)?;
        let bundle_bytes = reader.file("runtime-bundle.json", MAX_DESCRIPTOR)?;
        let bundle_sha256 = sha(&bundle_bytes);
        need(
            is_sha(&result.runtime.descriptor_sha256)
                && bundle_sha256 == result.runtime.descriptor_sha256,
            "bundle descriptor bytes differ from child receipt",
        )?;
        let bundle: RuntimeBundle = serde_json::from_slice(&bundle_bytes)?;
        need(
            bundle.schema_version == 1
                && bundle.scope == "browser-runtime-bundle"
                && bundle.producer.matches(&self.expected)
                && bundle.app_service == "not-run"
                && bundle.presentation == "not-run"
                && bundle.gpu == "unknown",
            "bundle contract differs",
        )?;
        // Logical bundleId is informational. Its JS unsigned-object recipe is
        // not reinvented here and is never used for a namespace or trust pin.
        need(
            is_sha(&bundle.bundle_id) && bundle.bundle_id == result.runtime.bundle_id,
            "logical bundle identity differs",
        )?;
        let report_bytes = reader.file("build-report.json", MAX_DESCRIPTOR)?;
        need(
            sha(&report_bytes) == self.expected.report_sha256,
            "independent original report pin differs",
        )?;
        let report: ReportProjection = serde_json::from_slice(&report_bytes)?;
        report.validate(&self.expected)?;

        // Expected paths/hashes come from the externally pinned report and the
        // frozen consumer closure, not from runtimeFiles claimed by the child.
        let expected =
            report.expected_files(report_bytes.len() as u64, &self.expected.report_sha256)?;
        let declared = pin_map(&bundle.files)?;
        need(
            declared.len() == expected.len() && declared.keys().eq(expected.keys()),
            "retained bundle inventory differs",
        )?;
        for (path, file) in &expected {
            let pin = declared
                .get(path)
                .ok_or(ReceiptError::Invalid("expected retained file is missing"))?;
            need(
                pin.sha256 == file.sha256 && file.size.is_none_or(|size| size == pin.size),
                "retained descriptor changed pinned report data",
            )?;
        }
        let serve: Vec<FilePin> = expected
            .iter()
            .filter(|(_, file)| file.serve)
            .map(|(path, _)| (*declared[path]).clone())
            .collect();
        need(
            bundle.runtime_files == serve && result.runtime.runtime_files == serve,
            "runtime serve allowlist differs from independently pinned report",
        )?;
        let mut names: BTreeSet<String> = expected.keys().cloned().collect();
        names.insert("runtime-bundle.json".into());
        need(
            scan_files(&output)? == names,
            "runtime tree has extra or missing files",
        )?;

        let mut bodies = BTreeMap::new();
        for (path, pin) in &declared {
            let bytes = if path == "build-report.json" {
                need(
                    pin.size == report_bytes.len() as u64 && pin.sha256 == sha(&report_bytes),
                    "report inventory differs",
                )?;
                continue;
            } else {
                reader.file(path, MAX_FILE)?
            };
            need(
                bytes.len() as u64 == pin.size && sha(&bytes) == pin.sha256,
                "retained file bytes differ",
            )?;
            if expected[path].serve {
                bodies.insert(
                    path.clone(),
                    Arc::new(RuntimeBody {
                        bytes,
                        files: completion.files.clone(),
                    }),
                );
            }
        }
        // Detect structural mutation during capture. All later consumers use
        // immutable captured runtime bodies, never reopen a pathname to serve.
        need(
            scan_files(&output)? == names,
            "runtime tree changed during capture",
        )?;
        Ok(CapturedRuntime {
            pins: RuntimePins {
                bundle_sha256,
                producer_report_sha256: self.expected.report_sha256.clone(),
                source_commit: self.expected.source_commit.clone(),
                // Existing Node recipe verified by the frozen finite helper.
                // Compare its externally pinned report value; do not hash Rust JSON.
                source_inventory_sha256: self.expected.source_sha256.clone(),
            },
            renderer: self.expected.renderer,
            bundle_bytes,
            report_bytes,
            bodies,
        })
    }
}

#[must_use = "retain the actual completion and its file charge until explicit cleanup"]
#[derive(Debug, thiserror::Error)]
#[error("{cause}")]
pub struct RuntimeReceiptFailure {
    #[source]
    cause: ReceiptError,
    completion: Box<ArtifactJobCompletion>,
}
impl RuntimeReceiptFailure {
    pub fn cause(&self) -> &ReceiptError {
        &self.cause
    }
    pub fn completion(&self) -> &ArtifactJobCompletion {
        &self.completion
    }
    pub fn into_completion(self) -> ArtifactJobCompletion {
        *self.completion
    }
    /// Preserve the original diagnostic and actual completion during charged
    /// wrapper retirement. This does not construct another captured body.
    pub(crate) fn into_parts(self) -> (ReceiptError, ArtifactJobCompletion) {
        (self.cause, *self.completion)
    }
}

/// A body borrower keeps the actual output namespace owner, not a bare path or
/// detached Arc<Vec>. Returning a borrowed slice prevents extracting its lease.
#[derive(Debug)]
pub struct RuntimeBody {
    bytes: Vec<u8>,
    files: Arc<ArtifactFiles>,
}
impl RuntimeBody {
    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub fn owned_files(&self) -> &Arc<ArtifactFiles> {
        &self.files
    }
}
#[derive(Debug)]
struct CapturedRuntime {
    pins: RuntimePins,
    renderer: RuntimeBundleRenderer,
    bundle_bytes: Vec<u8>,
    report_bytes: Vec<u8>,
    bodies: BTreeMap<String, Arc<RuntimeBody>>,
}

/// Static bytes only: NOT Clone, Deserialize, runtime-ready or presented-ready.
#[must_use]
#[derive(Debug)]
pub struct StaticRuntimeReceipt {
    completion: ArtifactJobCompletion,
    captured: CapturedRuntime,
}
impl StaticRuntimeReceipt {
    pub fn pins(&self) -> &RuntimePins {
        &self.captured.pins
    }
    pub fn renderer(&self) -> RuntimeBundleRenderer {
        self.captured.renderer
    }
    pub fn raw_result(&self) -> &[u8] {
        // Factory proved this result available; no reconstruction of original JSON.
        self.completion
            .result
            .as_ref()
            .expect("verified original result")
            .as_slice()
    }
    pub fn raw_bundle(&self) -> &[u8] {
        &self.captured.bundle_bytes
    }
    pub fn raw_report(&self) -> &[u8] {
        &self.captured.report_bytes
    }
    pub fn resource(&self, path: &str) -> Option<Arc<RuntimeBody>> {
        self.captured.bodies.get(path).cloned()
    }
    /// Caller retains the real completion for its existing fallible cleanup
    /// barrier. External body leases continue to prevent exclusive file removal.
    pub fn into_completion(self) -> ArtifactJobCompletion {
        self.completion
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilePin {
    path: String,
    sha256: String,
    size: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetainResult {
    schema_version: u32,
    request_id: String,
    op: String,
    status: String,
    runtime: RuntimeResult,
    runtime_ready: bool,
    presented_ready: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeResult {
    directory: PathBuf,
    bundle_id: String,
    descriptor_sha256: String,
    producer: ProducerClaim,
    runtime_files: Vec<FilePin>,
    provenance: Provenance,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProducerClaim {
    report_sha256: String,
    source_commit: String,
    source_sha256: String,
    renderer: RuntimeBundleRenderer,
}
impl ProducerClaim {
    fn matches(&self, expected: &ProducerExpected) -> bool {
        self.report_sha256 == expected.report_sha256
            && self.source_commit == expected.source_commit
            && self.source_sha256 == expected.source_sha256
            && self.renderer == expected.renderer
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Provenance {
    status: String,
    app_service: String,
    presentation: String,
    gpu: String,
    producer_glue_interface_reexecuted: bool,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeBundle {
    schema_version: u32,
    scope: String,
    producer: ProducerClaim,
    files: Vec<FilePin>,
    runtime_files: Vec<FilePin>,
    app_service: String,
    presentation: String,
    gpu: String,
    bundle_id: String,
}

// The report is externally pinned raw bytes. These are typed projections of
// fields we consume, not a rewritten schema for unrelated build diagnostics.
// Unknown report metadata is ignored and never turned into new evidence.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReportProjection {
    schema_version: u32,
    scope: String,
    status: String,
    build_status: String,
    ready: bool,
    plan: Plan,
    source: Source,
    browser_assets: BrowserAssets,
    generated_package: GeneratedPackage,
    generated_module_parser: Parser,
    renderer_dependencies: RendererDependencies,
}
#[derive(Debug, Deserialize)]
struct Plan {
    execution: String,
    renderer: RuntimeBundleRenderer,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    status: String,
    working_tree_dirty: bool,
    source_stable: bool,
    source_commit: String,
    source_sha256: String,
    #[serde(deserialize_with = "unique_source_files")]
    source_files: BTreeMap<String, String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserAssets {
    status: String,
    retained_status: String,
    files: Vec<BrowserFile>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFile {
    path: String,
    source_path: String,
    sha256: String,
    size: u64,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedPackage {
    status: String,
    retained_status: String,
    files: Vec<FilePin>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Parser {
    status: String,
    retained_status: String,
    files: Vec<FilePin>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RendererDependencies {
    status: String,
    retained_status: String,
    renderer: RuntimeBundleRenderer,
    runtime_config: RuntimeConfig,
    files: Vec<RendererFile>,
}
#[derive(Debug, Deserialize)]
struct RuntimeConfig {
    path: String,
    sha256: String,
    bytes: u64,
}
#[derive(Debug, Deserialize)]
struct RendererFile {
    id: String,
    url: String,
    sha256: String,
    size: u64,
    verified: bool,
}
#[derive(Debug)]
struct ExpectedFile {
    sha256: String,
    size: Option<u64>,
    serve: bool,
}

impl ReportProjection {
    fn validate(&self, expected: &ProducerExpected) -> Result<()> {
        need(
            self.schema_version == 1
                && self.scope == "quickjs-browser-wasm-build"
                && self.status == "passed"
                && self.build_status == "passed"
                && self.ready
                && self.plan.execution == "worker"
                && self.plan.renderer == expected.renderer,
            "producer build receipt is ineligible",
        )?;
        need(
            self.source.status == "passed"
                && !self.source.working_tree_dirty
                && self.source.source_stable
                && self.source.source_commit == expected.source_commit
                && self.source.source_sha256 == expected.source_sha256,
            "producer source identity differs",
        )?;
        for (status, retained) in [
            (
                &self.browser_assets.status,
                &self.browser_assets.retained_status,
            ),
            (
                &self.generated_package.status,
                &self.generated_package.retained_status,
            ),
            (
                &self.generated_module_parser.status,
                &self.generated_module_parser.retained_status,
            ),
            (
                &self.renderer_dependencies.status,
                &self.renderer_dependencies.retained_status,
            ),
        ] {
            need(
                status == "passed" && retained == "passed",
                "producer retained closure is ineligible",
            )?;
        }
        need(
            self.renderer_dependencies.renderer == expected.renderer,
            "renderer mode changed",
        )
    }

    fn expected_files(
        &self,
        report_size: u64,
        expected_report_sha256: &str,
    ) -> Result<BTreeMap<String, ExpectedFile>> {
        let mut files = BTreeMap::new();
        let mut add =
            |path: String, digest: String, size: Option<u64>, serve: bool| -> Result<()> {
                need(
                    safe_relative(&path)
                        && is_sha(&digest)
                        && size.is_none_or(|n| n <= MAX_FILE as u64),
                    "invalid pinned file descriptor",
                )?;
                need(files.len() < MAX_FILES, "file inventory budget exceeded")?;
                need(
                    files
                        .insert(
                            path,
                            ExpectedFile {
                                sha256: digest,
                                size,
                                serve,
                            },
                        )
                        .is_none(),
                    "duplicate pinned file path",
                )
            };
        add(
            "build-report.json".into(),
            expected_report_sha256.to_owned(),
            Some(report_size),
            false,
        )?;
        for required in [
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
            need(
                self.source.source_files.contains_key(required),
                "required frozen source is absent",
            )?;
        }
        for (path, digest) in &self.source.source_files {
            add(format!("source/{path}"), digest.clone(), None, false)?;
        }
        let browser_names: BTreeSet<&str> = self
            .browser_assets
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect();
        need(
            self.browser_assets.files.len() == WEB_FILES.len()
                && browser_names == WEB_FILES.iter().copied().collect(),
            "frozen browser source closure differs",
        )?;
        for file in &self.browser_assets.files {
            need(
                file.source_path == format!("examples/hosts/web-wasm/{}", file.path)
                    && self.source.source_files.get(&file.source_path) == Some(&file.sha256),
                "browser file not bound to pinned source",
            )?;
            add(
                file.path.clone(),
                file.sha256.clone(),
                Some(file.size),
                !EXCLUDED_WEB_ENTRIES.contains(&file.path.as_str()),
            )?;
        }
        need(
            !self.generated_package.files.is_empty(),
            "generated package is absent",
        )?;
        for file in &self.generated_package.files {
            need(
                file.path.starts_with("pkg/"),
                "generated package left pkg namespace",
            )?;
            add(
                file.path.clone(),
                file.sha256.clone(),
                Some(file.size),
                true,
            )?;
        }
        need(
            !self.generated_module_parser.files.is_empty(),
            "generated parser receipt is absent",
        )?;
        for file in &self.generated_module_parser.files {
            add(
                format!("validation/generated-module-parser/{}", file.path),
                file.sha256.clone(),
                Some(file.size),
                false,
            )?;
        }
        let config = &self.renderer_dependencies.runtime_config;
        need(
            config.path == "runtime-config.json",
            "renderer config path changed",
        )?;
        add(
            config.path.clone(),
            config.sha256.clone(),
            Some(config.bytes),
            true,
        )?;
        let renderer_files = &self.renderer_dependencies.files;
        let expected_ids: BTreeSet<&str> = match self.plan.renderer {
            RuntimeBundleRenderer::Software => BTreeSet::new(),
            RuntimeBundleRenderer::Canvaskit => [
                "javascript",
                "wasm",
                "license",
                "package",
                "font",
                "fontLicense",
            ]
            .into_iter()
            .collect(),
        };
        need(
            renderer_files.len() == expected_ids.len()
                && renderer_files
                    .iter()
                    .map(|file| file.id.as_str())
                    .collect::<BTreeSet<_>>()
                    == expected_ids,
            "renderer dependency identity set differs",
        )?;
        for file in renderer_files {
            need(
                file.verified && file.url.starts_with("vendor/"),
                "renderer dependency is unverified or out of scope",
            )?;
            add(file.url.clone(), file.sha256.clone(), Some(file.size), true)?;
        }
        Ok(files)
    }
}

fn unique_source_files<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<BTreeMap<String, String>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = BTreeMap<String, String>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter.write_str("a bounded source path to SHA-256 map without duplicate keys")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut access: M,
        ) -> std::result::Result<Self::Value, M::Error> {
            let mut files = BTreeMap::new();
            while let Some((path, digest)) = access.next_entry::<String, String>()? {
                if files.len() >= MAX_SOURCE_FILES
                    || !safe_relative(&path)
                    || !is_sha(&digest)
                    || files.insert(path, digest).is_some()
                {
                    return Err(serde::de::Error::custom(
                        "invalid/duplicate/unbounded source inventory",
                    ));
                }
            }
            Ok(files)
        }
    }
    deserializer.deserialize_map(Visitor)
}

fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 2048
        && !value.starts_with('/')
        && !value.chars().any(|character| {
            character.is_control() || character.is_whitespace() || "\\%?#:".contains(character)
        })
        && value.split('/').count() <= 64
        && value
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}
fn pin_map(files: &[FilePin]) -> Result<BTreeMap<String, &FilePin>> {
    need(files.len() <= MAX_FILES, "file inventory budget exceeded")?;
    let mut map = BTreeMap::new();
    for file in files {
        need(
            safe_relative(&file.path) && is_sha(&file.sha256) && file.size <= MAX_FILE as u64,
            "invalid retained file pin",
        )?;
        need(
            map.insert(file.path.clone(), file).is_none(),
            "duplicate retained file path",
        )?;
    }
    need(
        files.iter().map(|pin| &pin.path).eq(map.keys()),
        "file inventory order differs from UTF-8 path order",
    )?;
    Ok(map)
}

pub(crate) struct Capture<'a> {
    root: &'a Path,
    used: u64,
}
impl<'a> Capture<'a> {
    pub(crate) fn new(root: &'a Path) -> Result<Self> {
        need(
            root.is_absolute()
                && fs::canonicalize(root)? == root
                && fs::symlink_metadata(root)?.is_dir(),
            "output is not a canonical actual directory",
        )?;
        Ok(Self { root, used: 0 })
    }
    pub(crate) fn file(&mut self, relative: &str, limit: usize) -> Result<Vec<u8>> {
        let path = checked_path(self.root, relative)?;
        let mut file = open_regular(&path)?;
        let before = file.metadata()?;
        need(
            before.len() <= limit as u64 && before.len() <= MAX_TOTAL.saturating_sub(self.used),
            "capture byte budget exceeded",
        )?;
        let identity = file_identity(&file)?;
        let bytes = read_exact_snapshot(&mut file, before.len() as usize)?;
        let after = file.metadata()?;
        need(
            bytes.len() as u64 == before.len()
                && after.len() == before.len()
                && after.modified()? == before.modified()?,
            "file changed while reading",
        )?;
        let same_path = checked_path(self.root, relative)?;
        let reopened = open_regular(&same_path)?;
        need(
            file_identity(&reopened)? == identity,
            "file identity changed while capturing",
        )?;
        self.used = self
            .used
            .checked_add(bytes.len() as u64)
            .ok_or(ReceiptError::Invalid("capture budget overflow"))?;
        Ok(bytes)
    }
}
fn checked_path(root: &Path, relative: &str) -> Result<PathBuf> {
    need(safe_relative(relative), "unsafe relative artifact path")?;
    need(
        fs::canonicalize(root)? == root && fs::symlink_metadata(root)?.is_dir(),
        "output directory changed",
    )?;
    let mut path = root.to_path_buf();
    for part in relative.split('/') {
        path.push(part);
        let metadata = fs::symlink_metadata(&path)?;
        need(
            !metadata.file_type().is_symlink(),
            "symlink artifact path rejected",
        )?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            need(
                metadata.file_attributes() & 0x400 == 0,
                "reparse artifact path rejected",
            )?;
        }
    }
    need(
        fs::canonicalize(&path)? == path && fs::symlink_metadata(&path)?.is_file(),
        "artifact path is not canonical regular data",
    )?;
    Ok(path)
}
fn open_regular(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x0020_0000); /* FILE_FLAG_OPEN_REPARSE_POINT */
    }
    let file = options.open(path)?;
    need(
        file.metadata()?.is_file(),
        "opened artifact is not a regular file",
    )?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        need(
            file.metadata()?.file_attributes() & 0x400 == 0,
            "opened artifact is a reparse point",
        )?;
    }
    Ok(file)
}
#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    let metadata = file.metadata()?;
    Ok((metadata.dev(), metadata.ino()))
}
#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Information {
        attributes: u32,
        creation: FileTime,
        access: FileTime,
        write: FileTime,
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            information: *mut Information,
        ) -> i32;
    }
    let mut information = Information::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((
        information.volume as u64,
        ((information.index_high as u64) << 32) | information.index_low as u64,
    ))
}
#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> io::Result<(u64, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "native file identity unavailable",
    ))
}
pub(crate) fn scan_files(root: &Path) -> Result<BTreeSet<String>> {
    fn walk(
        root: &Path,
        relative: &str,
        depth: usize,
        directories: &mut usize,
        files: &mut BTreeSet<String>,
    ) -> Result<()> {
        *directories += 1;
        need(
            depth <= 64 && *directories <= MAX_DIRECTORIES,
            "directory scan budget exceeded",
        )?;
        let directory = if relative.is_empty() {
            root.to_path_buf()
        } else {
            root.join(relative)
        };
        need(
            fs::canonicalize(&directory)? == directory
                && fs::symlink_metadata(&directory)?.is_dir(),
            "noncanonical retained directory",
        )?;
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| ReceiptError::Invalid("non-UTF-8 retained path"))?;
            let path = if relative.is_empty() {
                name
            } else {
                format!("{relative}/{name}")
            };
            need(safe_relative(&path), "unsafe retained path")?;
            let metadata = fs::symlink_metadata(entry.path())?;
            need(
                !metadata.file_type().is_symlink(),
                "symlink in retained tree",
            )?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                need(
                    metadata.file_attributes() & 0x400 == 0,
                    "reparse point in retained tree",
                )?;
            }
            if metadata.is_dir() {
                walk(root, &path, depth + 1, directories, files)?;
            } else {
                need(
                    metadata.is_file()
                        && files.len() < MAX_FILES
                        && metadata.len() <= MAX_FILE as u64,
                    "nonregular/unbounded retained tree",
                )?;
                files.insert(path);
            }
        }
        Ok(())
    }
    let mut files = BTreeSet::new();
    walk(root, "", 0, &mut 0, &mut files)?;
    Ok(files)
}

// The test file remains a child of this module so private intake helpers stay
// private. Its finite transport fixture is constructed inside artifact_job's
// cfg(test) support child; no sibling can construct ArtifactJobConfig fields.
#[cfg(all(test, unix))]
#[path = "browser_dev_runtime_receipt_tests.rs"]
pub(crate) mod contract_tests;
