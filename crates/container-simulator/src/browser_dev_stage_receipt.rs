//! Consume a finite stage job into verified, immutable static bytes.
//!
//! Actual runtime and portable input borrowers stay attached to the original
//! job/completion through validation and retirement. This receipt grants no
//! admission, publication, Worker execution or presentation authority. Its
//! aggregate owner must retain the original stage charge and cap body
//! borrowers before making any captured bytes available to HTTP.

use crate::browser_dev_aggregate_store::{PortableInputLease, RuntimeInputLease};
use crate::browser_dev_artifact_job::{ArtifactFiles, ArtifactJob, ArtifactJobCompletion};
use crate::browser_dev_coordinator::{
    IndexPin, PortableDescriptor, StageArtifact, StageTicket, TransportBackend, WireU64,
};
use crate::browser_dev_runtime_receipt::{
    scan_files, Capture, ReceiptError, RuntimeBundleRenderer,
};
use container_ir::{ContainerManifestV1, ManifestError, RendererProfile};
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};

#[path = "browser_dev_stage_numbers.rs"]
mod number_semantics;
#[path = "browser_dev_stage_wire.rs"]
mod wire;

const RESULT_BYTES: usize = 16 * 1024 * 1024;
const DESCRIPTOR_BYTES: usize = 16 * 1024 * 1024;
const INDEX_BYTES: usize = 2 * 1024 * 1024;
const MANIFEST_BYTES: usize = 2 * 1024 * 1024;
const STARTUP_BYTES: usize = 64 * 1024;
const FILE_BYTES: usize = 64 * 1024 * 1024;
const DECLARED_PACK_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub(crate) enum StageReceiptError {
    #[error("ERR_BROWSER_DEV_STAGE_RECEIPT: {0}")]
    Invalid(&'static str),
    #[error("ERR_BROWSER_DEV_STAGE_RECEIPT: {0}")]
    Read(#[from] ReceiptError),
    #[error("ERR_BROWSER_DEV_STAGE_RECEIPT: {0}")]
    Json(#[from] serde_json::Error),
    #[error("ERR_BROWSER_DEV_STAGE_RECEIPT: {0}")]
    Manifest(#[from] ManifestError),
    #[error("ERR_BROWSER_DEV_STAGE_RECEIPT: {0}")]
    Number(#[from] number_semantics::NumberSemanticsError),
}
type Result<T> = std::result::Result<T, StageReceiptError>;

fn need(value: bool, message: &'static str) -> Result<()> {
    if value {
        Ok(())
    } else {
        Err(StageReceiptError::Invalid(message))
    }
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn decimal(value: &str) -> Result<u64> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| StageReceiptError::Invalid("invalid decimal counter"))?;
    need(parsed.to_string() == value, "noncanonical decimal counter")?;
    Ok(parsed)
}
fn parse<T: DeserializeOwned>(bytes: &[u8], limit: usize) -> Result<T> {
    need(
        !bytes.is_empty() && bytes.len() <= limit,
        "metadata byte budget exceeded",
    )?;
    // Reject duplicate keys even inside projected/extension data. Decode the
    // typed value from ORIGINAL bytes; never hash a reserialized Value.
    let strict: wire::StrictJson = serde_json::from_slice(bytes)?;
    validate_tree(strict.value(), 262_144, 128)?;
    drop(strict);
    Ok(serde_json::from_slice(bytes)?)
}

fn parse_semantic<T: DeserializeOwned>(
    bytes: &[u8],
    limit: usize,
    max_nodes: usize,
    max_depth: usize,
) -> Result<T> {
    need(
        !bytes.is_empty() && bytes.len() <= limit,
        "metadata byte budget exceeded",
    )?;
    // Original token -> finite IEEE754, recursively strict duplicate keys.
    // This parser avoids serde_json's optional float-roundtrip dependency.
    // Hashes ALWAYS use the original bytes, never this semantic projection.
    let semantic = number_semantics::semantic_value_from_json(bytes)?;
    validate_tree(&semantic, max_nodes, max_depth)?;
    Ok(serde_json::from_value(semantic)?)
}

/// Owned actual inputs, not copyable descriptors or lexical self-references.
/// Both capabilities retain their original actual cleanup owner and charge.
#[derive(Debug)]
pub(crate) struct StageBindingInput {
    pub(crate) run_id: String,
    pub(crate) request_id: String,
    /// Actual constructor-emitted request bytes hash. Caller must obtain this
    /// from ArtifactJob::request_binding(), NOT pre-mutation Value JSON.
    pub(crate) request_sha256: String,
    pub(crate) ticket: StageTicket,
    pub(crate) startup_intent: Vec<u8>,
    pub(crate) runtime: RuntimeInputLease,
    pub(crate) portable_input: PortableInputLease,
}

#[must_use = "caller still owns actual job and original binding inputs"]
#[derive(Debug)]
pub(crate) struct StageBindFailure {
    pub(crate) cause: StageReceiptError,
    pub(crate) input: StageBindingInput,
}

#[must_use]
#[derive(Debug)]
pub(crate) struct PendingStageReceipt {
    files: Weak<ArtifactFiles>,
    input: StageBindingInput,
    runtime_directory: PathBuf,
    intent: wire::StartupIntent,
    bundle: wire::RuntimeBundle,
    portable: PortableDescriptor,
}

impl PendingStageReceipt {
    pub(crate) fn bind(
        job: &ArtifactJob,
        input: StageBindingInput,
    ) -> std::result::Result<Self, Box<StageBindFailure>> {
        match Self::inspect_binding(job, &input) {
            Ok((runtime_directory, intent, bundle, portable)) => Ok(Self {
                files: Arc::downgrade(job.files()),
                input,
                runtime_directory,
                intent,
                bundle,
                portable,
            }),
            Err(cause) => Err(Box::new(StageBindFailure { cause, input })),
        }
    }

    /// Recover the original actual input borrowers after the owner has
    /// established its job barrier. This grants no cleanup or refund authority;
    /// the owner keeps the same stage reservation through output retirement.
    pub(crate) fn into_input(self) -> StageBindingInput {
        self.input
    }

    fn inspect_binding(
        job: &ArtifactJob,
        input: &StageBindingInput,
    ) -> Result<(
        PathBuf,
        wire::StartupIntent,
        wire::RuntimeBundle,
        PortableDescriptor,
    )> {
        need(
            input.run_id == input.ticket.run_id(),
            "ticket belongs to another run",
        )?;
        need(
            !input.run_id.is_empty()
                && input.run_id.len() <= 128
                && input
                    .run_id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "invalid exact run identity",
        )?;
        need(
            !input.request_id.is_empty()
                && input.request_id.len() <= 128
                && hash(&input.request_sha256),
            "invalid actual request binding",
        )?;
        need(
            job.request_binding()
                == (
                    input.request_id.as_str(),
                    "stage-pack",
                    input.request_sha256.as_str(),
                ),
            "binding differs from the actual constructor request",
        )?;
        need(
            input.ticket.runtime_pins() == input.runtime.pins(),
            "ticket runtime differs from actual receipt",
        )?;
        need(
            sha(&input.startup_intent) == input.ticket.startup_intent_pin().sha256,
            "original startup intent pin differs",
        )?;
        let intent = parse_startup_intent(&input.startup_intent)?;
        let bundle: wire::RuntimeBundle = parse(input.runtime.raw_bundle(), DESCRIPTOR_BYTES)?;
        need(
            sha(input.runtime.raw_bundle()) == input.runtime.pins().bundle_sha256,
            "actual runtime descriptor bytes differ",
        )?;
        // This required immutable runtime body provides ACTUAL ArtifactFiles.
        // No caller path or result.directory is used to derive the namespace.
        let runtime_directory = input.runtime.directory();
        need(
            !input.runtime.same_files(job.files()),
            "stage and runtime share actual files owner",
        )?;
        need(
            input.portable_input.report() == input.ticket.pack_report()
                && input.portable_input.directory()
                    == input.ticket.pack_report().pack_directory.as_path(),
            "ticket differs from actual owned portable generation",
        )?;
        let source = input.portable_input.directory();
        let output = job.files().output();
        validate_directories(source, &runtime_directory, &output)?;
        let portable = PortableDescriptor::from(input.portable_input.report());
        need(
            !portable.selected_route.is_empty()
                && hash(&portable.manifest_sha256)
                && hash(&portable.integrity_root),
            "invalid portable input projection",
        )?;
        Ok((runtime_directory, intent, bundle, portable))
    }

    /// Consume only this actual job's original poll completion once. The owner
    /// must retire/drop completed job's extra files borrow before cleanup.
    pub(crate) fn accept(
        self,
        completion: ArtifactJobCompletion,
    ) -> std::result::Result<StaticStageReceipt, Box<StageReceiptFailure>> {
        match self.inspect(&completion) {
            Ok(captured) => Ok(StaticStageReceipt {
                completion,
                input: self.input,
                captured,
            }),
            Err(cause) => Err(Box::new(StageReceiptFailure {
                cause,
                completion: Box::new(completion),
                input: self.input,
            })),
        }
    }

    fn inspect(&self, completion: &ArtifactJobCompletion) -> Result<CapturedStage> {
        need(
            self.files.ptr_eq(&Arc::downgrade(&completion.files)),
            "completion belongs to another actual job",
        )?;
        need(
            completion.request_id == self.input.request_id
                && completion.request_sha256 == self.input.request_sha256
                && completion.operation == "stage-pack",
            "completion request binding differs",
        )?;
        need(
            completion.stopped.is_none() && completion.exit_status.success(),
            "finite job failed or was stopped",
        )?;
        let raw = completion
            .result
            .as_ref()
            .map_err(|_| StageReceiptError::Invalid("original result unavailable"))?;
        let result: wire::StageResult = parse(raw, RESULT_BYTES)?;
        need(
            result.schema_version == 1
                && result.request_id == self.input.request_id
                && result.op == "stage-pack"
                && result.status == "staged-static"
                && !result.runtime_ready
                && !result.presented_ready,
            "not this static stage receipt",
        )?;
        let pins = self.input.runtime.pins();
        need(
            result.runtime.directory == self.runtime_directory
                && result.runtime.descriptor_sha256 == pins.bundle_sha256
                && result.runtime.bundle_id == self.bundle.bundle_id
                && result.runtime.producer == self.bundle.producer
                && result.runtime.runtime_files == self.bundle.runtime_files,
            "runtime input changed from actual retained receipt",
        )?;
        need(
            result.runtime.producer.report_sha256 == pins.producer_report_sha256
                && result.runtime.producer.source_commit == pins.source_commit
                && result.runtime.producer.source_sha256 == pins.source_inventory_sha256
                && result.runtime.producer.renderer == self.input.runtime.renderer(),
            "runtime producer pins differ",
        )?;
        let provenance = &result.runtime.provenance;
        need(
            provenance.status == "retained-static-verified"
                && provenance.app_service == "not-run"
                && provenance.presentation == "not-run"
                && provenance.gpu == "unknown"
                && !provenance.producer_glue_interface_reexecuted,
            "runtime claims unsupported authority",
        )?;

        let output = completion.files.output();
        need(
            result.stage.status == "staged" && result.stage.directory == output,
            "stage directory left actual owned output",
        )?;
        let before = scan_files(&output)?;
        let mut reader = Capture::new(&output)?;
        let mut bodies = BTreeMap::new();
        let site_bytes = capture(
            &mut reader,
            &mut bodies,
            &completion.files,
            "site.json",
            DESCRIPTOR_BYTES,
        )?;
        need(
            sha(site_bytes) == result.stage.descriptor_sha256,
            "original site descriptor differs",
        )?;
        let site: wire::SiteDescriptor = parse(site_bytes, DESCRIPTOR_BYTES)?;
        need(
            site == result.stage.descriptor,
            "result site projection differs from original descriptor",
        )?;
        self.validate_site(&site)?;

        let index_bytes = capture(
            &mut reader,
            &mut bodies,
            &completion.files,
            "pack-index.json",
            INDEX_BYTES,
        )?;
        check_file(index_bytes, &site.pack_index.sha256, site.pack_index.size)?;
        let index: wire::PackIndex = parse(index_bytes, INDEX_BYTES)?;
        need(
            index.schema_version == 1
                && index.manifest == "portable-pack/manifest.json"
                && index.manifest_sha256 == self.portable.manifest_sha256
                && index.integrity_root == self.portable.integrity_root,
            "pack index differs from portable pins",
        )?;
        let manifest_bytes = capture(
            &mut reader,
            &mut bodies,
            &completion.files,
            &index.manifest,
            MANIFEST_BYTES,
        )?;
        need(
            sha(manifest_bytes) == self.portable.manifest_sha256,
            "original portable manifest differs",
        )?;
        let manifest: ContainerManifestV1 = parse(manifest_bytes, MANIFEST_BYTES)?;
        manifest.verify_integrity()?;
        need(
            manifest.integrity.root == self.portable.integrity_root
                && manifest.compiler.commit == self.portable.compiler_commit
                && manifest
                    .routes
                    .iter()
                    .any(|r| r.path == self.portable.selected_route),
            "portable manifest binding differs",
        )?;

        let mut expected: BTreeSet<String> = [
            "site.json",
            "pack-index.json",
            "worker-product-config.json",
            "worker-product-config.mjs",
            "portable-pack/manifest.json",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let hashes = manifest_hashes(&manifest)?;
        let mut indexed = BTreeMap::new();
        let mut declared_bytes = manifest_bytes.len() as u64;
        for blob in &index.blobs {
            need(
                hash(&blob.sha256)
                    && blob.url == format!("portable-pack/blobs/sha256/{}", blob.sha256)
                    && blob.size <= FILE_BYTES as u64,
                "invalid exact blob index",
            )?;
            need(
                indexed.insert(blob.sha256.clone(), blob).is_none(),
                "duplicate indexed blob",
            )?;
            declared_bytes = declared_bytes
                .checked_add(blob.size)
                .ok_or(StageReceiptError::Invalid("declared pack size overflow"))?;
            need(
                declared_bytes <= DECLARED_PACK_BYTES,
                "Worker declared pack byte budget exceeded",
            )?;
            expected.insert(blob.url.clone());
        }
        need(
            indexed.keys().cloned().collect::<BTreeSet<_>>() == hashes,
            "index differs from manifest blob references",
        )?;
        need(
            before == expected,
            "stage output has missing or extra files",
        )?;
        for blob in indexed.values() {
            let bytes = capture(
                &mut reader,
                &mut bodies,
                &completion.files,
                &blob.url,
                FILE_BYTES,
            )?;
            check_file(bytes, &blob.sha256, blob.size)?;
        }
        for asset in &manifest.assets {
            let path = format!("portable-pack/blobs/sha256/{}", asset.sha256);
            let bytes = bodies
                .get(&path)
                .ok_or(StageReceiptError::Invalid("asset blob missing"))?;
            need(
                bytes.bytes.len() as u64 == asset.size,
                "asset blob size differs",
            )?;
        }

        let startup_bytes = capture(
            &mut reader,
            &mut bodies,
            &completion.files,
            "worker-product-config.json",
            STARTUP_BYTES,
        )?;
        check_file(
            startup_bytes,
            &site.startup_json.sha256,
            site.startup_json.size,
        )?;
        let startup: wire::StartupJson =
            parse_semantic(startup_bytes, STARTUP_BYTES, 32 * 1024, 64)?;
        self.validate_startup(&startup, &site)?;
        let startup_sha256 = sha(startup_bytes);
        let module_bytes = capture(
            &mut reader,
            &mut bodies,
            &completion.files,
            "worker-product-config.mjs",
            FILE_BYTES,
        )?;
        check_file(
            module_bytes,
            &site.product_config.sha256,
            site.product_config.size,
        )?;
        // The generated module is verified as inventory bytes, NOT imported,
        // semantically authorized as code, or included in serve allowlist.
        self.validate_admission(&site, &manifest)?;
        let mut declarations = BTreeMap::new();
        for pin in &result.stage.files {
            need(
                hash(&pin.sha256) && declarations.insert(pin.path.clone(), pin).is_none(),
                "invalid or duplicate child file inventory",
            )?;
        }
        need(
            declarations.keys().cloned().collect::<BTreeSet<_>>() == expected,
            "child inventory differs from exact output set",
        )?;
        for (path, pin) in declarations {
            let body = bodies
                .get(&path)
                .ok_or(StageReceiptError::Invalid("uncaptured inventory member"))?;
            check_file(body.bytes(), &pin.sha256, pin.size)?;
        }
        need(
            scan_files(&output)? == expected,
            "stage tree changed during capture",
        )?;
        let transport_backend = effective_backend(
            &manifest,
            &self.portable.selected_route,
            &self.intent.renderer_policy,
        );
        let artifact = StageArtifact {
            version: self.portable.version.to_owned(),
            site_id: self.input.ticket.site_id(),
            input_binding_sha256: self.input.ticket.input_binding_sha256().to_owned(),
            manifest_sha256: self.portable.manifest_sha256.clone(),
            integrity_root: self.portable.integrity_root.clone(),
            index: IndexPin {
                sha256: site.pack_index.sha256,
                size: WireU64::new(site.pack_index.size),
            },
            descriptor_sha256: result.stage.descriptor_sha256,
            runtime_bundle_sha256: pins.bundle_sha256.clone(),
            startup_intent_sha256: self.input.ticket.startup_intent_pin().sha256.clone(),
            startup_sha256,
            transport_backend,
        };
        let serve = expected
            .into_iter()
            .filter(|p| p != "worker-product-config.mjs")
            .collect();
        Ok(CapturedStage {
            artifact,
            bodies,
            serve,
        })
    }

    fn validate_site(&self, site: &wire::SiteDescriptor) -> Result<()> {
        need(
            site.schema_version == 1
                && site.scope == "browser-pack-generation"
                && site.run_id == self.input.run_id
                && decimal(&site.site_id)? == self.input.ticket.site_id().get()
                && decimal(&site.pack_revision)? == self.portable.pack_generation.get(),
            "site identity differs",
        )?;
        need(
            site.input_binding_sha256 == self.input.ticket.input_binding_sha256()
                && site.startup_intent_sha256 == self.input.ticket.startup_intent_pin().sha256,
            "site input/startup intent binding differs",
        )?;
        need(
            site.requested_route == self.intent.route
                && site.selected_route == self.portable.selected_route,
            "site requested/resolved route differs",
        )?;
        need(
            decimal(&site.publication_token.source_revision)?
                == self.portable.source_revision.get()
                && decimal(&site.publication_token.compiler_receipt_sequence)?
                    == self.portable.compiler_receipt_sequence.get(),
            "site publication token differs",
        )?;
        need(
            site.runtime_bundle.id == self.bundle.bundle_id
                && site.runtime_bundle.descriptor_sha256 == self.input.runtime.pins().bundle_sha256
                && site.manifest_sha256 == self.portable.manifest_sha256
                && site.integrity_root == self.portable.integrity_root
                && site.compiler_commit == self.portable.compiler_commit,
            "site portable/runtime pins differ",
        )?;
        need(
            site.pack_index.path == "pack-index.json"
                && site.product_config.path == "worker-product-config.mjs"
                && site.startup_json.path == "worker-product-config.json",
            "generated descriptor paths differ",
        )?;
        need(
            site.publication == "not-authorized"
                && site.runtime == "not-run"
                && site.presentation == "not-run"
                && site.gpu == "unknown",
            "site claims unsupported authority",
        )
    }

    fn validate_startup(
        &self,
        startup: &wire::StartupJson,
        site: &wire::SiteDescriptor,
    ) -> Result<()> {
        need(
            startup.schema_version == 1
                && startup.execution == "worker"
                && startup.engine == "quickjs"
                && startup.index.url == "./pack-index.json"
                && startup.index.sha256 == site.pack_index.sha256
                && startup.index.size == site.pack_index.size,
            "generated startup index/engine differs",
        )?;
        need(
            startup.viewport == self.intent.viewport
                && startup.renderer_policy == self.intent.renderer_policy
                && startup.render_scale == self.intent.render_scale
                && startup.route == self.portable.selected_route
                && startup.data == self.intent.data
                && startup.query == self.intent.query
                && startup.launch_options == self.intent.launch_options
                && startup.metrics == self.intent.metrics,
            "generated startup changed intent data",
        )?;
        match self.input.runtime.renderer() {
            RuntimeBundleRenderer::Canvaskit => {
                let body = self.input.runtime.resource("runtime-config.json").ok_or(
                    StageReceiptError::Invalid("actual pinned renderer config missing"),
                )?;
                let config: wire::StrictJson =
                    parse_semantic(body.bytes(), DESCRIPTOR_BYTES, 262_144, 128)?;
                need(
                    startup.renderer_assets.as_ref() == Some(&config),
                    "startup renderer assets differ from actual runtime",
                )
            }
            RuntimeBundleRenderer::Software => need(
                startup.renderer_assets.is_none(),
                "software bundle acquired CanvasKit assets",
            ),
        }
    }

    fn validate_admission(
        &self,
        site: &wire::SiteDescriptor,
        manifest: &ContainerManifestV1,
    ) -> Result<()> {
        let admission = &site.admission;
        let loader = self
            .input
            .runtime
            .resource("worker-admission-loader.mjs")
            .ok_or(StageReceiptError::Invalid(
                "actual admission loader missing",
            ))?;
        need(
            admission.status == "passed"
                && admission.loader_source_path
                    == "examples/hosts/web-wasm/worker-admission-loader.mjs"
                && admission.loader_sha256 == sha(loader.bytes()),
            "admission loader differs from actual runtime",
        )?;
        need(
            admission.routes.len() == manifest.routes.len(),
            "admission route count differs",
        )?;
        let mut seen = BTreeSet::new();
        let mut needs_drawing = false;
        for route in &admission.routes {
            need(
                seen.insert(route.path.clone())
                    && manifest.routes.iter().any(|r| r.path == route.path)
                    && route.declared_profile == manifest.renderer_profile_for_route(&route.path)
                    && route.transport_backend
                        == effective_backend(manifest, &route.path, &self.intent.renderer_policy),
                "admission route/profile differs",
            )?;
            needs_drawing |= route.transport_backend == TransportBackend::ExternalFrame;
        }
        need(
            admission.requires_canvaskit == needs_drawing
                && (!needs_drawing
                    || self.input.runtime.renderer() == RuntimeBundleRenderer::Canvaskit),
            "admission drawing capability differs",
        )
    }
}

fn parse_startup_intent(bytes: &[u8]) -> Result<wire::StartupIntent> {
    let intent = parse_semantic(bytes, STARTUP_BYTES, 32 * 1024, 64)?;
    validate_intent(&intent)?;
    Ok(intent)
}

/// Preflight uses the exact receipt decoder and semantic limits. This grants
/// no publication authority: the original stage repeats validation against
/// the immutable intent hash, runtime receipt and portable generation.
pub(crate) fn validate_startup_intent_bytes(bytes: &[u8]) -> Result<()> {
    parse_startup_intent(bytes).map(|_| ())
}

/// Project runner configuration with the same original-token numeric semantics
/// as the receipt, while the immutable intent remains the original bytes.
pub(crate) fn startup_intent_projection(bytes: &[u8]) -> Result<serde_json::Value> {
    validate_startup_intent_bytes(bytes)?;
    parse_semantic(bytes, STARTUP_BYTES, 32 * 1024, 64)
}

fn validate_intent(intent: &wire::StartupIntent) -> Result<()> {
    need(
        intent.schema_version == 1 && intent.execution == "worker" && intent.engine == "quickjs",
        "invalid Worker startup execution",
    )?;
    need(
        intent.viewport.width > 0
            && intent.viewport.width <= 4096
            && intent.viewport.height > 0
            && intent.viewport.height <= 4096,
        "invalid logical viewport",
    )?;
    if let Some(scale) = intent.render_scale {
        need(
            scale.effective(1.0).is_ok()
                && !matches!(
                    &intent.renderer_policy,
                    wire::RendererPolicy::Force {
                        profile: RendererProfile::WebView
                    }
                ),
            "physical render scale requires an external-frame renderer and valid density",
        )?;
        let effective = scale
            .effective(1.0)
            .map_err(|_| StageReceiptError::Invalid("invalid render scale"))?;
        need(
            container_render_skia::RenderTargetSize::for_viewport(
                container_render_skia::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: intent.viewport.width as f32,
                    height: intent.viewport.height as f32,
                },
                effective,
            )
            .is_ok(),
            "physical target exceeds the external presentation budget",
        )?;
    }
    if let Some(route) = &intent.route {
        need(
            !route.is_empty()
                && route.len() <= 1024
                && !route.starts_with('/')
                && !route
                    .chars()
                    .any(|c| c.is_control() || matches!(c, '\\' | '?' | '#' | '%'))
                && route
                    .split('/')
                    .all(|s| !s.is_empty() && s != "." && s != ".."),
            "invalid original startup route",
        )?;
    }
    if let Some(metrics) = &intent.metrics {
        let value = metrics.value();
        let number = |key: &str| -> Result<f64> {
            value
                .get(key)
                .and_then(serde_json::Value::as_f64)
                .filter(|n| n.is_finite())
                .ok_or(StageReceiptError::Invalid("invalid startup metric"))
        };
        need(
            number("windowWidth")? == intent.viewport.width as f64
                && number("windowHeight")? == intent.viewport.height as f64
                && number("pixelRatio")? > 0.0
                && number("screenWidth")? > 0.0
                && number("screenHeight")? > 0.0
                && number("statusBarHeight")? >= 0.0
                && number("screenTop")? >= 0.0
                && matches!(
                    value
                        .get("deviceOrientation")
                        .and_then(serde_json::Value::as_str),
                    Some("portrait" | "landscape")
                ),
            "startup metrics differ from logical viewport",
        )?;
    }
    Ok(())
}

fn validate_tree(value: &serde_json::Value, max_nodes: usize, max_depth: usize) -> Result<()> {
    // Validates the structure after strict parsing. This does NOT claim a
    // pre-decode allocation bound for serde; aggregate headroom remains needed.
    let mut pending = vec![(value, 0usize)];
    let mut nodes = 0usize;
    while let Some((value, depth)) = pending.pop() {
        nodes = nodes
            .checked_add(1)
            .ok_or(StageReceiptError::Invalid("JSON node count overflow"))?;
        need(
            nodes <= max_nodes && depth <= max_depth,
            "JSON structure budget exceeded",
        )?;
        match value {
            serde_json::Value::Object(values) => {
                pending.extend(values.values().map(|v| (v, depth + 1)))
            }
            serde_json::Value::Array(values) => {
                pending.extend(values.iter().map(|v| (v, depth + 1)))
            }
            _ => {}
        }
    }
    Ok(())
}

fn effective_backend(
    manifest: &ContainerManifestV1,
    route: &str,
    policy: &wire::RendererPolicy,
) -> TransportBackend {
    let profile = match policy {
        wire::RendererPolicy::Manifest => manifest.renderer_profile_for_route(route),
        wire::RendererPolicy::Force { profile } => *profile,
    };
    if profile == RendererProfile::WebView {
        TransportBackend::BrowserView
    } else {
        TransportBackend::ExternalFrame
    }
}

fn manifest_hashes(manifest: &ContainerManifestV1) -> Result<BTreeSet<String>> {
    let mut pointers = crate::declared_blob_pointers(manifest);
    // syncPortablePack also retains compiled SOURCE and document AST hashes;
    // the simulator's current helper alone enumerates executable refs only.
    if let Some(compiled) = &manifest.view_compilation {
        pointers.extend(
            compiled
                .modules
                .iter()
                .map(|m| format!("sha256:{}", m.source_sha256)),
        );
        pointers.extend(compiled.documents.iter().map(|d| d.wxml_ast.clone()));
    }
    let mut hashes = BTreeSet::new();
    for pointer in pointers {
        let value = pointer.strip_prefix("sha256:").unwrap_or(&pointer);
        need(hash(value), "invalid manifest blob reference")?;
        hashes.insert(value.to_owned());
    }
    Ok(hashes)
}

fn check_file(bytes: &[u8], digest: &str, size: u64) -> Result<()> {
    need(
        hash(digest) && bytes.len() as u64 == size && sha(bytes) == digest,
        "captured file bytes differ",
    )
}

fn validate_directories(source: &Path, runtime: &Path, output: &Path) -> Result<()> {
    need(
        !source.starts_with(output)
            && !output.starts_with(source)
            && !runtime.starts_with(source)
            && !source.starts_with(runtime)
            && !runtime.starts_with(output)
            && !output.starts_with(runtime),
        "actual input and output namespaces overlap",
    )
}

fn capture<'b>(
    reader: &mut Capture<'_>,
    bodies: &'b mut BTreeMap<String, Arc<StageBody>>,
    files: &Arc<ArtifactFiles>,
    path: &str,
    limit: usize,
) -> Result<&'b [u8]> {
    need(
        !bodies.contains_key(path),
        "attempted duplicate body capture",
    )?;
    let bytes = reader.file(path, limit)?;
    bodies.insert(
        path.to_owned(),
        Arc::new(StageBody {
            bytes,
            _files: files.clone(),
        }),
    );
    Ok(bodies
        .get(path)
        .ok_or(StageReceiptError::Invalid("captured body missing"))?
        .bytes())
}

/// Actual namespace borrower, not an aggregate BodyLease. Exposes only &[u8].
/// The aggregate store supplies the same-charge and borrower quota boundary.
#[derive(Debug)]
pub(crate) struct StageBody {
    bytes: Vec<u8>,
    // Retain actual files without exposing cleanup, mutable files or Arc access.
    _files: Arc<ArtifactFiles>,
}
impl StageBody {
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Debug)]
struct CapturedStage {
    artifact: StageArtifact,
    bodies: BTreeMap<String, Arc<StageBody>>,
    serve: BTreeSet<String>,
}

#[must_use = "retain original completion and runtime dependency until explicit retirement"]
#[derive(Debug)]
pub(crate) struct StaticStageReceipt {
    completion: ArtifactJobCompletion,
    input: StageBindingInput,
    captured: CapturedStage,
}
impl StaticStageReceipt {
    pub(crate) fn artifact(&self) -> &StageArtifact {
        &self.captured.artifact
    }
    pub(crate) fn resource(&self, path: &str) -> Option<Arc<StageBody>> {
        if self.captured.serve.contains(path) {
            self.captured.bodies.get(path).cloned()
        } else {
            None
        }
    }
    pub(crate) fn into_retirement(self) -> (ArtifactJobCompletion, StageBindingInput) {
        // Body clones may remain; actual files Arc prevents exclusive cleanup.
        // This is NOT a refund receipt. Caller retains the SAME reservation.
        let Self {
            completion,
            input,
            captured,
        } = self;
        drop(captured);
        (completion, input)
    }
}

#[must_use = "original completion and same reservation must survive validation failure"]
#[derive(Debug)]
pub(crate) struct StageReceiptFailure {
    pub(crate) cause: StageReceiptError,
    completion: Box<ArtifactJobCompletion>,
    input: StageBindingInput,
}
impl StageReceiptFailure {
    pub(crate) fn into_parts(
        self,
    ) -> (
        StageReceiptError,
        Box<ArtifactJobCompletion>,
        StageBindingInput,
    ) {
        (self.cause, self.completion, self.input)
    }
}

#[cfg(test)]
#[path = "browser_dev_stage_receipt_tests.rs"]
mod tests;
