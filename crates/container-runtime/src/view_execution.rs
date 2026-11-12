//! Session-owned, thread-affine View execution. The AppService engine is never
//! borrowed here: native providers own a separate runtime/isolate and heap.

use container_bridge::{BridgeError, BridgeErrorCode};
use container_core::{
    validate_view_render_provenance, EngineKind, ViewCompiledExpression, ViewCompiledSource,
    ViewDocumentHandle, ViewDocumentProgram, ViewEngine, ViewEngineError, ViewEngineErrorCode,
    ViewEngineTimings, ViewExecutionBudget, ViewModuleSource, ViewRenderDocument, ViewRenderTask,
};
use container_ir::{validate_wxml, ContainerManifestV1, WxmlAst, WxmlLexicalOrigin};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
#[cfg(not(all(target_arch = "wasm32", target_os = "unknown")))]
use std::time::Instant;
#[cfg(all(target_arch = "wasm32", target_os = "unknown"))]
use web_time::Instant;

/// A finite per-batch limit for the isolated View realm. AppService host-turn
/// and bridge deadlines may shorten this allowance, never extend it.
fn validate_attribute_sources(
    ast: &WxmlAst,
    sources: &[container_ir::WxmlAttributeSource],
) -> Result<(), ViewEngineError> {
    fn sites(nodes: &[container_ir::WxmlNode], output: &mut BTreeSet<(String, String)>) {
        for node in nodes {
            if let container_ir::WxmlNode::Element {
                source_site: Some(site),
                bound_values,
                children,
                ..
            } = node
            {
                for name in bound_values.keys() {
                    output.insert((site.clone(), name.clone()));
                }
                sites(children, output);
            }
        }
    }
    if sources.len() > 100_000 {
        return Err(invalid_view_receipt(
            "View attribute provenance budget exceeded",
        ));
    }
    let mut allowed = BTreeSet::new();
    sites(&ast.nodes, &mut allowed);
    let mut seen = BTreeSet::new();
    for source in sources {
        if !allowed.contains(&(source.source_site.clone(), source.attribute.clone()))
            || !seen.insert((source.source_site.clone(), source.attribute.clone()))
            || source.paths.len() > 4096
            || source.paths.iter().any(|path| path.len() > 256)
            || source
                .direct_path
                .as_ref()
                .is_some_and(|path| !source.paths.contains(path))
        {
            return Err(invalid_view_receipt(
                "invalid View attribute provenance receipt",
            ));
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ViewExecutionPolicy {
    pub batch_timeout_ms: u64,
}

impl Default for ViewExecutionPolicy {
    fn default() -> Self {
        Self {
            batch_timeout_ms: 50,
        }
    }
}

impl ViewExecutionPolicy {
    pub(crate) fn validate(&self) -> Result<(), crate::SessionError> {
        if self.batch_timeout_ms == 0 || self.batch_timeout_ms > 86_400_000 {
            return Err(crate::SessionError::Config(
                "view_execution.batch_timeout_ms must be between 1 and 86400000 ms".into(),
            ));
        }
        Ok(())
    }
}

/// Owner-thread timings for the most recent View operations. Provider work is
/// measured as a whole and, when the provider instruments it, at actual native
/// transport boundaries. Compilation inside the VM remains explicitly unknown.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewExecutionMetrics {
    pub preparation: ViewPreparationMetrics,
    pub frontier: ViewFrontierMetrics,
    pub scope_release: ViewScopeReleaseMetrics,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPreparationMetrics {
    pub elapsed_ns: u64,
    /// Realm construction/bootstrap as a whole; lazy compile is not isolated.
    pub provider_initialization_ns: u64,
    pub validation_encoding_ns: u64,
    pub provider_ns: u64,
    pub provider_stages: Option<ViewEngineTimings>,
    pub cache_hit: bool,
    pub succeeded: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewFrontierMetrics {
    pub elapsed_ns: u64,
    pub document_validation_encoding_ns: u64,
    /// Includes deferred first-use realm construction and empty registry load.
    /// provider_stages begins at native batches and excludes realm construction.
    pub provider_ns: u64,
    pub provider_stages: Option<ViewEngineTimings>,
    pub receipt_validation_ns: u64,
    pub document_cache_hit: bool,
    pub registration_cache_hits: u64,
    pub document_registrations: u64,
    pub succeeded: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewScopeReleaseMetrics {
    pub elapsed_ns: u64,
    pub provider_ns: u64,
    pub provider_stages: Option<ViewEngineTimings>,
    pub succeeded: bool,
}

/// Immutable evidence for the first healthy-to-poisoned operation. The latest
/// metrics remain independently observable and may change after this snapshot.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewFirstFaultWitness {
    #[serde(serialize_with = "serialize_fault_decimal")]
    fault_sequence: u64,
    #[serde(serialize_with = "serialize_fault_decimal")]
    operation_sequence: u64,
    /// Relative to this ViewExecution instance, never a cross-process clock.
    #[serde(serialize_with = "serialize_fault_decimal")]
    monotonic_elapsed_ns: u64,
    #[serde(flatten)]
    operation: ViewFaultOperationMetrics,
    /// These are taken only from this operation's local provider timings.
    /// Missing observations stay null, including in non-instrumented builds.
    provider: ViewFaultProviderWitness,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "operation", content = "metrics", rename_all = "camelCase")]
enum ViewFaultOperationMetrics {
    Prepare(ViewPreparationMetrics),
    Render(ViewFrontierMetrics),
    Release(ViewScopeReleaseMetrics),
}

impl ViewFaultOperationMetrics {
    fn provider_stages(&self) -> Option<&ViewEngineTimings> {
        match self {
            Self::Prepare(metrics) => metrics.provider_stages.as_ref(),
            Self::Render(metrics) => metrics.provider_stages.as_ref(),
            Self::Release(metrics) => metrics.provider_stages.as_ref(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewFaultProviderWitness {
    last_batch: Option<container_core::view_probe::ViewBatchDiagnostics>,
    last_batch_breakdown: Option<container_core::view_probe::ViewBatchBreakdown>,
}

fn serialize_fault_decimal<S: serde::Serializer>(
    value: &u64,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&value.to_string())
}

fn collect_provider_timings(
    target: &mut Option<ViewEngineTimings>,
    source: Option<ViewEngineTimings>,
) {
    if let Some(source) = source {
        if let Some(target) = target {
            target.accumulate(&source);
        } else {
            *target = Some(source);
        }
    } else if let Some(target) = target {
        // Preserve legacy cumulative stages when the provider is unknown, but
        // do not attribute an earlier batch's absolute clocks to this call.
        target.last_batch = None;
        target.last_batch_breakdown = None;
    }
}

#[cfg(test)]
mod timing_collection_tests {
    use super::*;

    fn timed_batch() -> ViewEngineTimings {
        ViewEngineTimings {
            batches: 2,
            elapsed_ns: 17,
            input_encode_ns: 3,
            input_bytes: 21,
            document_registrations: 1,
            registered_render_batches: 0,
            vm_input_parse_ns: 4,
            execute_including_lazy_compile_ns: 5,
            vm_output_encode_ns: 2,
            output_decode_ns: 3,
            compile_ns: Some(1),
            last_batch_breakdown: None,
            last_batch: Some(
                serde_json::from_value(serde_json::json!({
                    "schemaVersion": 1, "engine": "quickjs", "modern": false,
                    "operation": "render", "batchSequence": "7",
                    "androidTraceEmitted": false
                }))
                .unwrap(),
            ),
        }
    }

    #[test]
    fn unknown_last_provider_clears_only_optional_batch_diagnostics() {
        let initial = timed_batch();
        let mut target = Some(initial.clone());
        collect_provider_timings(&mut target, None);
        let mut expected = initial;
        expected.last_batch = None;
        assert_eq!(target, Some(expected));
    }

    #[test]
    fn known_uninstrumented_provider_still_accumulates_legacy_stages() {
        let mut target = Some(timed_batch());
        let next = ViewEngineTimings {
            batches: 1,
            elapsed_ns: 11,
            ..ViewEngineTimings::default()
        };
        let mut expected = target.clone().unwrap();
        expected.accumulate(&next);
        collect_provider_timings(&mut target, Some(next));
        assert_eq!(target, Some(expected));
        assert!(target.unwrap().last_batch.is_none());
    }

    #[test]
    fn first_provider_receipt_and_absent_receipts_keep_original_collection_rules() {
        let mut target = None;
        collect_provider_timings(&mut target, None);
        assert!(target.is_none());
        let next = timed_batch();
        collect_provider_timings(&mut target, Some(next.clone()));
        assert_eq!(target, Some(next));
    }
}

struct VerifiedProgram {
    manifest: ContainerManifestV1,
    // Holding a strong lease makes Arc::get_mut impossible on caller clones;
    // Arc::make_mut produces a new identity and must be verified again.
    resources: crate::RenderResources,
}

struct EncodedDocuments {
    templates: BTreeMap<String, WxmlAst>,
    programs: [Option<std::sync::Arc<ViewDocumentProgram>>; 2],
    document_ids: BTreeSet<String>,
}

struct RegisteredDocuments {
    program: std::sync::Arc<ViewDocumentProgram>,
    handle: ViewDocumentHandle,
}

#[cfg(test)]
type TestProviderFactory =
    Box<dyn FnMut(EngineKind, bool) -> Result<Box<dyn ViewEngine>, BridgeError>>;

pub(crate) struct ViewExecution {
    // Intentionally no Send/Sync bound. Both native realms stay on the Session
    // owner thread; only the budget's atomic cancellation crosses threads.
    engine: Option<Box<dyn ViewEngine>>,
    modern_engine: Option<Box<dyn ViewEngine>>,
    // A verified empty legacy program needs no VM until a document frontier.
    // Existing realms always receive program changes, including empty loads.
    pending_empty_legacy: bool,
    #[cfg(test)]
    provider_factory: Option<TestProviderFactory>,
    engine_kind: EngineKind,
    provider_available: bool,
    source_maps: crate::modern_source_map::ModernSourceMaps,
    module_digest: Option<String>,
    compiled_documents: BTreeMap<String, Vec<ViewCompiledExpression>>,
    scope_leases: BTreeSet<String>,
    poisoned: Option<ViewEngineError>,
    first_fault: Option<ViewFirstFaultWitness>,
    operation_sequence: u64,
    created_at: Instant,
    fault_authority_retired: bool,
    verified_program: Option<VerifiedProgram>,
    encoded_documents: Option<EncodedDocuments>,
    registered_documents: [Option<RegisteredDocuments>; 2],
    metrics: ViewExecutionMetrics,
}

impl std::fmt::Debug for ViewExecution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ViewExecution")
            .field("available", &self.is_available())
            .field("module_digest", &self.module_digest)
            .field("scope_leases", &self.scope_leases)
            .field("poisoned", &self.poisoned)
            .finish_non_exhaustive()
    }
}

impl ViewExecution {
    pub(crate) fn new(engine: EngineKind) -> Result<Self, ViewEngineError> {
        if engine == EngineKind::V8 && !cfg!(feature = "v8-native") {
            return Err(ViewEngineError::new(
                ViewEngineErrorCode::Unavailable,
                "V8 native View provider is unavailable in this build",
            ));
        }
        let provider_available = match engine {
            EngineKind::Quickjs => cfg!(feature = "quickjs-native"),
            EngineKind::V8 => cfg!(feature = "v8-native"),
        };
        Ok(Self {
            engine: None,
            modern_engine: None,
            pending_empty_legacy: false,
            #[cfg(test)]
            provider_factory: None,
            engine_kind: engine,
            provider_available,
            source_maps: Default::default(),
            module_digest: None,
            compiled_documents: BTreeMap::new(),
            scope_leases: BTreeSet::new(),
            poisoned: None,
            first_fault: None,
            operation_sequence: 0,
            created_at: Instant::now(),
            fault_authority_retired: false,
            verified_program: None,
            encoded_documents: None,
            registered_documents: [None, None],
            metrics: ViewExecutionMetrics::default(),
        })
    }

    pub(crate) fn is_available(&self) -> bool {
        self.provider_available
    }

    pub(crate) fn metrics(&self) -> ViewExecutionMetrics {
        self.metrics.clone()
    }

    pub(crate) fn first_fault(&self) -> Option<&ViewFirstFaultWitness> {
        self.first_fault.as_ref()
    }

    fn begin_measured_operation(&mut self) -> (u64, bool) {
        // Diagnostic sequence never wraps or changes an execution result.
        self.operation_sequence = self.operation_sequence.saturating_add(1);
        (self.operation_sequence, self.poisoned.is_none())
    }

    fn capture_first_fault(
        &mut self,
        was_healthy: bool,
        operation_sequence: u64,
        operation: impl FnOnce() -> ViewFaultOperationMetrics,
    ) {
        if !was_healthy || self.poisoned.is_none() || self.first_fault.is_some() {
            return;
        }
        let operation = operation();
        let stages = operation.provider_stages();
        let provider = ViewFaultProviderWitness {
            last_batch: stages.and_then(|stages| stages.last_batch.clone()),
            last_batch_breakdown: stages.and_then(|stages| stages.last_batch_breakdown.clone()),
        };
        self.first_fault = Some(ViewFirstFaultWitness {
            fault_sequence: 1,
            operation_sequence,
            monotonic_elapsed_ns: elapsed_ns(self.created_at),
            operation,
            provider,
        });
    }

    pub(crate) fn is_faulted(&self) -> bool {
        self.poisoned.is_some()
    }

    /// Final session retirement is invalidation, not a guest acknowledgement.
    /// A poisoned realm cannot execute another release batch. Consume its
    /// native owners exactly once, while retaining the original fault and
    /// first-fault witness for diagnostics on this old Session.
    pub(crate) fn retire_poisoned(&mut self) -> bool {
        if !self.is_faulted() {
            return false;
        }
        for mut engine in [self.engine.take(), self.modern_engine.take()]
            .into_iter()
            .flatten()
        {
            engine.dispose();
        }
        self.scope_leases.clear();
        self.compiled_documents.clear();
        self.verified_program = None;
        self.encoded_documents = None;
        self.registered_documents = [None, None];
        self.pending_empty_legacy = false;
        true
    }

    /// Preserve the original interruption as typed data. A subsequent attempt
    /// reports RequiresReset, but must not overwrite the first fault or stack.
    pub(crate) fn fault(&self) -> Option<ViewEngineError> {
        self.poisoned.as_ref().map(|error| {
            let mut mapped = error.clone();
            if let Some(stack) = &error.stack {
                mapped.stack = Some(self.source_maps.map_stack(stack, 3));
            }
            mapped
        })
    }

    pub(crate) fn take_unretired_fault(&mut self) -> bool {
        if self.poisoned.is_none() || self.fault_authority_retired {
            return false;
        }
        self.fault_authority_retired = true;
        true
    }

    #[cfg(test)]
    pub(crate) fn inject_fault_for_test(&mut self, error: ViewEngineError) {
        self.poisoned = Some(error);
        self.fault_authority_retired = false;
    }

    /// Verify every source again even for an unchanged program. Reusing the
    /// digest avoids resetting stateful per-occurrence module caches on each
    /// frame, while altered or missing content still fails before execution.
    pub(crate) fn prepare_modules(
        &mut self,
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
        budget: &ViewExecutionBudget,
    ) -> Result<(), BridgeError> {
        self.prepare_modules_measured(manifest, blobs, None, budget)
    }

    /// Only Session's accepted immutable resource lease may use this path.
    /// Cache identity includes the entire manifest value, not just its claimed
    /// integrity root. The first use still verifies all executable bytes.
    pub(crate) fn prepare_verified_modules(
        &mut self,
        manifest: &ContainerManifestV1,
        resources: &crate::RenderResources,
        budget: &ViewExecutionBudget,
    ) -> Result<(), BridgeError> {
        self.prepare_modules_measured(manifest, resources, Some(resources), budget)
    }

    fn prepare_modules_measured(
        &mut self,
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
        trusted: Option<&crate::RenderResources>,
        budget: &ViewExecutionBudget,
    ) -> Result<(), BridgeError> {
        let started = Instant::now();
        let (operation_sequence, was_healthy) = self.begin_measured_operation();
        let mut metrics = ViewPreparationMetrics::default();
        let result = (|| {
            // Even an exact immutable cache hit cannot revive an interrupted
            // heap, or bypass the caller's cancellation/outer deadline.
            self.ensure_healthy()?;
            remaining_budget(started, budget)?;
            if trusted.is_some_and(|resources| {
                self.verified_program.as_ref().is_some_and(|program| {
                    &program.manifest == manifest
                        && std::sync::Arc::ptr_eq(resources, &program.resources)
                })
            }) {
                remaining_budget(started, budget)?;
                metrics.cache_hit = true;
                return Ok(());
            }
            self.verified_program = None;
            self.encoded_documents = None;
            self.prepare_modules_inner(manifest, blobs, budget, started, &mut metrics)?;
            if let Some(resources) = trusted {
                self.verified_program = Some(VerifiedProgram {
                    manifest: manifest.clone(),
                    resources: std::sync::Arc::clone(resources),
                });
            }
            Ok(())
        })();
        metrics.elapsed_ns = elapsed_ns(started);
        metrics.succeeded = result.is_ok();
        // Failed validation can return before the provider boundary.
        metrics.validation_encoding_ns = metrics
            .elapsed_ns
            .saturating_sub(metrics.provider_ns)
            .saturating_sub(metrics.provider_initialization_ns);
        self.capture_first_fault(was_healthy, operation_sequence, || {
            ViewFaultOperationMetrics::Prepare(metrics.clone())
        });
        self.metrics.preparation = metrics;
        result
    }

    fn prepare_modules_inner(
        &mut self,
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
        budget: &ViewExecutionBudget,
        started: Instant,
        metrics: &mut ViewPreparationMetrics,
    ) -> Result<(), BridgeError> {
        self.ensure_healthy()?;
        validate_manifest(manifest)?;
        let modern_modules = modern_modules(manifest, blobs)?;
        let mut modules = Vec::with_capacity(manifest.view_scripts.len());
        for module in &manifest.view_scripts {
            let pointer = format!("sha256:{}", module.sha256);
            let bytes = crate::lookup_render_blob(blobs, &pointer)?;
            if container_ir::hex_digest(bytes) != module.sha256 {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("view script {} SHA-256 mismatch", module.id),
                ));
            }
            let source = std::str::from_utf8(bytes).map_err(|error| {
                BridgeError::new(
                    BridgeErrorCode::Render,
                    format!("view script {} is not UTF-8: {error}", module.id),
                )
            })?;
            let mut dependencies = module.dependencies.clone();
            dependencies.sort();
            modules.push(ViewModuleSource {
                id: module.id.clone(),
                source: source.into(),
                dependencies,
                compilation: manifest
                    .view_compilation
                    .as_ref()
                    .map(|compiled| {
                        let declaration = compiled
                            .modules
                            .iter()
                            .find(|item| item.id == module.id)
                            .expect("validated compilation module mapping");
                        compiled_source(
                            blobs,
                            &declaration.executable_sha256,
                            &declaration.helper,
                            &compiled.abi,
                        )
                    })
                    .transpose()?,
            });
        }
        let mut compiled_documents = BTreeMap::new();
        if let Some(compiled) = &manifest.view_compilation {
            for document in &compiled.documents {
                let expressions = document
                    .expressions
                    .iter()
                    .map(|expression| {
                        Ok(ViewCompiledExpression {
                            source: expression.source.clone(),
                            shorthand: expression.shorthand,
                            compilation: compiled_source(
                                blobs,
                                &expression.executable_sha256,
                                &expression.helper,
                                &compiled.abi,
                            )?,
                        })
                    })
                    .collect::<Result<Vec<_>, BridgeError>>()?;
                compiled_documents.insert(document.document_id.clone(), expressions);
            }
        }
        modules.sort_by(|left, right| left.id.cmp(&right.id));
        let digest = program_digest(manifest)?;
        if self.module_digest.as_deref() == Some(digest.as_str()) {
            return Ok(());
        }
        let source_maps = crate::modern_source_map::ModernSourceMaps::load(manifest, blobs)
            .map_err(invalid_batch)?;
        if !self.is_available() {
            if !modules.is_empty()
                || !modern_modules.is_empty()
                || manifest.view_compilation.is_some()
            {
                return Err(view_error(&unavailable()));
            }
            self.module_digest = Some(digest);
            self.compiled_documents = compiled_documents;
            return Ok(());
        }
        self.registered_documents = [None, None];
        let mut registry_changed = false;
        let needs_legacy = !modules.is_empty()
            || manifest
                .templates
                .iter()
                .any(|template| !manifest.is_modern_document(&template.id));
        let defer_empty_legacy = needs_legacy
            && self.engine.is_none()
            && modules.is_empty()
            && manifest.view_compilation.is_none();
        let prepared = (|| {
            if needs_legacy && self.engine.is_none() && !defer_empty_legacy {
                let initialization_started = Instant::now();
                let engine = self.create_provider(false);
                metrics.provider_initialization_ns = metrics
                    .provider_initialization_ns
                    .saturating_add(elapsed_ns(initialization_started));
                self.engine = Some(engine?);
            }
            if let Some(engine) = self.engine.as_mut() {
                let remaining = remaining_budget(started, budget)?;
                let provider_started = Instant::now();
                let loaded = engine.load_modules(&modules, &remaining);
                collect_provider_timings(&mut metrics.provider_stages, engine.last_timings());
                metrics.provider_ns = metrics
                    .provider_ns
                    .saturating_add(elapsed_ns(provider_started));
                if let Err(error) = loaded {
                    self.record_interruption(&error);
                    return Err(self.mapped_error(&error));
                }
                registry_changed = true;
            }
            if !modern_modules.is_empty() {
                if self.modern_engine.is_none() {
                    let initialization_started = Instant::now();
                    let engine = self.create_provider(true);
                    metrics.provider_initialization_ns = metrics
                        .provider_initialization_ns
                        .saturating_add(elapsed_ns(initialization_started));
                    self.modern_engine = Some(engine?);
                }
                let remaining = remaining_budget(started, budget)?;
                let provider_started = Instant::now();
                let loaded = self
                    .modern_engine
                    .as_mut()
                    .expect("modern provider")
                    .load_modules(&modern_modules, &remaining);
                collect_provider_timings(
                    &mut metrics.provider_stages,
                    self.modern_engine
                        .as_ref()
                        .expect("modern provider")
                        .last_timings(),
                );
                metrics.provider_ns = metrics
                    .provider_ns
                    .saturating_add(elapsed_ns(provider_started));
                if let Err(error) = loaded {
                    self.record_interruption(&error);
                    return Err(self.mapped_error(&error));
                }
                registry_changed = true;
            } else if let Some(mut engine) = self.modern_engine.take() {
                engine.dispose();
                registry_changed = true;
            }
            remaining_budget(started, budget)?;
            Ok(())
        })();
        if let Err(error) = prepared {
            if registry_changed {
                self.poison_partial_operation(&error);
            }
            return Err(error);
        }
        self.pending_empty_legacy = defer_empty_legacy;
        self.source_maps = source_maps;
        self.module_digest = Some(digest);
        self.compiled_documents = compiled_documents;
        self.scope_leases.clear();
        Ok(())
    }

    fn create_provider(&mut self, modern: bool) -> Result<Box<dyn ViewEngine>, BridgeError> {
        #[cfg(test)]
        if let Some(factory) = self.provider_factory.as_mut() {
            return factory(self.engine_kind, modern);
        }
        native_provider(self.engine_kind, modern)
    }

    /// First use stays inside the frontier's existing clock and cancellation
    /// allowance. Verification/cache hits never prewarm a realm outside it.
    fn initialize_deferred_legacy(
        &mut self,
        started: Instant,
        budget: &ViewExecutionBudget,
        metrics: &mut ViewFrontierMetrics,
    ) -> Result<(), BridgeError> {
        if !self.pending_empty_legacy {
            return Ok(());
        }
        remaining_budget(started, budget)?;
        let provider_started = Instant::now();
        let initialized = (|| {
            if self.engine.is_none() {
                self.engine = Some(self.create_provider(false)?);
            }
            let remaining = remaining_budget(started, budget)?;
            let engine = self.engine.as_mut().expect("created legacy provider");
            let loaded = engine.load_modules(&[], &remaining);
            collect_provider_timings(&mut metrics.provider_stages, engine.last_timings());
            if let Err(error) = loaded {
                self.record_interruption(&error);
                return Err(self.mapped_error(&error));
            }
            remaining_budget(started, budget)?;
            self.pending_empty_legacy = false;
            self.registered_documents[0] = None;
            Ok(())
        })();
        metrics.provider_ns = metrics
            .provider_ns
            .saturating_add(elapsed_ns(provider_started));
        initialized
    }

    /// Validate and transport one complete render frontier. No AST is exposed
    /// until every task receipt, lexical origin and decoded IR is valid.
    pub(crate) fn render_documents(
        &mut self,
        manifest: &ContainerManifestV1,
        templates: &BTreeMap<String, WxmlAst>,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<(String, WxmlAst)>, BridgeError> {
        self.render_documents_with_sources(manifest, templates, tasks, budget)
            .map(|results| {
                results
                    .into_iter()
                    .map(|(id, result)| (id, result.ast))
                    .collect()
            })
    }

    pub(crate) fn render_documents_with_sources(
        &mut self,
        manifest: &ContainerManifestV1,
        templates: &BTreeMap<String, WxmlAst>,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<(String, container_ir::EvaluatedWxml)>, BridgeError> {
        let started = Instant::now();
        let (operation_sequence, was_healthy) = self.begin_measured_operation();
        let mut metrics = ViewFrontierMetrics::default();
        let result =
            self.render_documents_inner(manifest, templates, tasks, budget, started, &mut metrics);
        metrics.elapsed_ns = elapsed_ns(started);
        metrics.succeeded = result.is_ok();
        if metrics.document_validation_encoding_ns == 0 {
            metrics.document_validation_encoding_ns = metrics
                .elapsed_ns
                .saturating_sub(metrics.provider_ns)
                .saturating_sub(metrics.receipt_validation_ns);
        }
        self.capture_first_fault(was_healthy, operation_sequence, || {
            ViewFaultOperationMetrics::Render(metrics.clone())
        });
        self.metrics.frontier = metrics;
        result
    }

    fn render_documents_inner(
        &mut self,
        manifest: &ContainerManifestV1,
        templates: &BTreeMap<String, WxmlAst>,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
        started: Instant,
        metrics: &mut ViewFrontierMetrics,
    ) -> Result<Vec<(String, container_ir::EvaluatedWxml)>, BridgeError> {
        self.ensure_healthy()?;
        if !self.is_available() {
            return Err(view_error(&unavailable()));
        }
        let trusted = self
            .verified_program
            .as_ref()
            .is_some_and(|program| &program.manifest == manifest);
        if !trusted {
            validate_manifest(manifest)?;
            let expected_digest = program_digest(manifest)?;
            if self.module_digest.as_deref() != Some(expected_digest.as_str()) {
                return Err(view_error(&ViewEngineError::new(
                    ViewEngineErrorCode::Module,
                    "the current View module program must be prepared before rendering",
                )));
            }
        }

        let (programs, document_ids) = if let Some(encoded) = self
            .encoded_documents
            .as_ref()
            .filter(|encoded| trusted && &encoded.templates == templates)
        {
            metrics.document_cache_hit = true;
            (encoded.programs.clone(), encoded.document_ids.clone())
        } else {
            let mut documents = Vec::with_capacity(manifest.templates.len());
            let mut document_ids = BTreeSet::new();
            for template in &manifest.templates {
                let document_id = canonical_document(&template.id)?;
                if !document_ids.insert(document_id.to_owned()) {
                    return Err(invalid_batch("duplicate canonical View document"));
                }
                let by_id = templates.get(&template.id);
                let by_path = templates.get(document_id);
                if by_id
                    .zip(by_path)
                    .is_some_and(|(left, right)| left != right)
                {
                    return Err(invalid_batch(format!(
                        "View document aliases disagree for {document_id}"
                    )));
                }
                let ast = by_id.or(by_path).ok_or_else(|| {
                    invalid_batch(format!("View document {document_id} was not supplied"))
                })?;
                validate_wxml(ast).map_err(|error| {
                    invalid_batch(format!("View document {document_id} is invalid: {error}"))
                })?;
                documents.push(ViewRenderDocument {
                    document_id: document_id.into(),
                    ast: serde_json::to_value(ast).map_err(|error| {
                        invalid_batch(format!(
                            "cannot encode View document {document_id}: {error}"
                        ))
                    })?,
                    bindings: modern_bindings(manifest, document_id)
                        .unwrap_or_else(|| template.wxs_modules.clone()),
                    compilation: self.compiled_documents.get(document_id).cloned(),
                });
            }
            // Caller maps may contain both template:<path> and <path> aliases.
            // Extra undeclared documents cannot become a second lexical registry.
            for supplied in templates.keys() {
                let document_id = canonical_document(supplied)?;
                if !document_ids.contains(document_id) {
                    return Err(invalid_batch(format!(
                        "View document {document_id} is not declared in the manifest"
                    )));
                }
            }
            validate_document_profiles(manifest, templates)?;
            let mut grouped: [Vec<ViewRenderDocument>; 2] = [Vec::new(), Vec::new()];
            for document in documents {
                let profile = usize::from(manifest.is_modern_document(&document.document_id));
                grouped[profile].push(document);
            }
            let programs = grouped.map(|documents| {
                (!documents.is_empty())
                    .then(|| std::sync::Arc::new(ViewDocumentProgram::new(documents)))
            });
            if trusted {
                self.encoded_documents = Some(EncodedDocuments {
                    templates: templates.clone(),
                    programs: programs.clone(),
                    document_ids: document_ids.clone(),
                });
            }
            (programs, document_ids)
        };
        let mut task_ids = BTreeSet::new();
        for task in tasks {
            if task.task_id.is_empty()
                || task.scope_id.is_empty()
                || !task.data.is_object()
                || !task_ids.insert(task.task_id.clone())
                || !document_ids.contains(&task.document_id)
            {
                return Err(invalid_batch(
                    "invalid View task, duplicate task id or undeclared document",
                ));
            }
        }
        metrics.document_validation_encoding_ns = elapsed_ns(started);
        self.scope_leases
            .extend(tasks.iter().map(|task| task.scope_id.clone()));
        let mut groups = Vec::new();
        // Every profile is fully registered before any stateful task executes.
        // These Arc leases originate only after full static/graph validation.
        // A matching claimed root without matching actual bytes cannot hit.
        for (profile, program) in programs.into_iter().enumerate() {
            let Some(program) = program else {
                continue;
            };
            let modern = profile == 1;
            let profile_tasks = tasks
                .iter()
                .filter(|task| manifest.is_modern_document(&task.document_id) == modern)
                .cloned()
                .collect::<Vec<_>>();
            if let Err(error) = remaining_budget(started, budget) {
                self.poison_partial_operation(&error);
                return Err(error);
            }
            if !modern {
                if let Err(error) = self.initialize_deferred_legacy(started, budget, metrics) {
                    self.poison_partial_operation(&error);
                    return Err(error);
                }
            }
            let cached = self.registered_documents[profile]
                .as_ref()
                .filter(|registered| {
                    std::sync::Arc::ptr_eq(&registered.program, &program)
                        || registered.program == program
                });
            let handle = if let Some(registered) = cached {
                metrics.registration_cache_hits += 1;
                registered.handle.clone()
            } else {
                let remaining = match remaining_budget(started, budget) {
                    Ok(remaining) => remaining,
                    Err(error) => {
                        self.poison_partial_operation(&error);
                        return Err(error);
                    }
                };
                let provider = if modern {
                    self.modern_engine.as_mut()
                } else {
                    self.engine.as_mut()
                }
                .ok_or_else(|| view_error(&unavailable()))?;
                let provider_started = Instant::now();
                let registered = provider.register_documents(&program, &remaining);
                collect_provider_timings(&mut metrics.provider_stages, provider.last_timings());
                metrics.provider_ns = metrics
                    .provider_ns
                    .saturating_add(elapsed_ns(provider_started));
                let handle = match registered {
                    Ok(handle) => handle,
                    Err(error) => {
                        if !error.is_document_program_rejection() {
                            self.poisoned = Some(error.clone());
                        }
                        return Err(self.mapped_error(&error));
                    }
                };
                metrics.document_registrations += 1;
                self.registered_documents[profile] = Some(RegisteredDocuments {
                    program,
                    handle: handle.clone(),
                });
                handle
            };
            groups.push((modern, handle, profile_tasks));
        }
        // A startup frontier may intentionally contain no tasks. Cancellation
        // after the final registration still invalidates that incomplete turn.
        if let Err(error) = remaining_budget(started, budget) {
            self.poison_partial_operation(&error);
            return Err(error);
        }
        let mut by_id = BTreeMap::new();
        for (modern, handle, profile_tasks) in &groups {
            if profile_tasks.is_empty() {
                continue;
            }
            let remaining = match remaining_budget(started, budget) {
                Ok(remaining) => remaining,
                Err(error) => {
                    self.poisoned = Some(ViewEngineError::new(
                        if error.code == BridgeErrorCode::Cancelled {
                            ViewEngineErrorCode::Cancelled
                        } else {
                            ViewEngineErrorCode::Timeout
                        },
                        error.message.clone(),
                    ));
                    return Err(error);
                }
            };
            let provider = if *modern {
                self.modern_engine.as_mut()
            } else {
                self.engine.as_mut()
            }
            .expect("validated profile provider");
            let provider_started = Instant::now();
            let rendered = provider.render_registered_batch(handle, profile_tasks, &remaining);
            collect_provider_timings(&mut metrics.provider_stages, provider.last_timings());
            metrics.provider_ns = metrics
                .provider_ns
                .saturating_add(elapsed_ns(provider_started));
            match rendered {
                Ok(results) => {
                    if results.len() != profile_tasks.len()
                        || results
                            .iter()
                            .zip(profile_tasks)
                            .any(|(result, task)| result.task_id != task.task_id)
                    {
                        let error = invalid_view_receipt(
                            "View profile receipt does not match submitted tasks",
                        );
                        self.poisoned = Some(error.clone());
                        return Err(self.mapped_error(&error));
                    }
                    for result in results {
                        if by_id.insert(result.task_id.clone(), result).is_some() {
                            return Err(invalid_batch("duplicate profile receipt"));
                        }
                    }
                }
                Err(error) => {
                    self.record_interruption(&error);
                    return Err(self.mapped_error(&error));
                }
            }
        }
        let results = tasks
            .iter()
            .filter_map(|task| by_id.remove(&task.task_id))
            .collect::<Vec<_>>();
        let receipt_started = Instant::now();
        let decoded = (|| {
            if results.len() != tasks.len() {
                return Err(invalid_view_receipt("View render receipt count mismatch"));
            }
            let mut received = BTreeSet::new();
            let mut decoded = Vec::with_capacity(results.len());
            for (result, task) in results.into_iter().zip(tasks) {
                if result.task_id != task.task_id || !received.insert(result.task_id.clone()) {
                    return Err(invalid_view_receipt(
                        "View render receipts do not exactly match submitted task order",
                    ));
                }
                validate_view_render_provenance(&result.ast, &document_ids)?;
                let ast: WxmlAst = serde_json::from_value(result.ast).map_err(|error| {
                    invalid_view_receipt(format!(
                        "View task {} returned an invalid WXML AST: {error}",
                        task.task_id
                    ))
                })?;
                validate_wxml(&ast).map_err(|error| {
                    invalid_view_receipt(format!(
                        "View task {} returned an invalid WXML AST: {error}",
                        task.task_id
                    ))
                })?;
                let attribute_sources: Vec<container_ir::WxmlAttributeSource> =
                    serde_json::from_value(serde_json::Value::Array(result.attribute_sources))
                        .map_err(|error| {
                            invalid_view_receipt(format!(
                                "View task {} returned invalid attribute provenance: {error}",
                                task.task_id
                            ))
                        })?;
                validate_attribute_sources(&ast, &attribute_sources)?;
                decoded.push((
                    result.task_id,
                    container_ir::EvaluatedWxml {
                        ast,
                        attribute_sources,
                    },
                ));
            }
            Ok(decoded)
        })();
        metrics.receipt_validation_ns = elapsed_ns(receipt_started);
        match decoded {
            Ok(decoded) => {
                // Result decoding and final acceptance share the same deadline.
                if let Err(error) = remaining_budget(started, budget) {
                    self.poison_partial_operation(&error);
                    return Err(error);
                }
                Ok(decoded)
            }
            Err(error) => {
                // The native turn may already have mutated state. A malformed
                // or incomplete acknowledgement cannot establish a checkpoint.
                self.poisoned = Some(error.clone());
                Err(self.mapped_error(&error))
            }
        }
    }

    /// Native release is one validated batch. Ownership changes only after a
    /// complete acknowledgement; failed cleanup poisons further rendering.
    pub(crate) fn release_scopes(
        &mut self,
        scopes: &[String],
        budget: &ViewExecutionBudget,
    ) -> Result<(), BridgeError> {
        let started = Instant::now();
        let (operation_sequence, was_healthy) = self.begin_measured_operation();
        let mut metrics = ViewScopeReleaseMetrics::default();
        let result = self.release_scopes_inner(scopes, budget, started, &mut metrics);
        metrics.elapsed_ns = elapsed_ns(started);
        metrics.succeeded = result.is_ok();
        self.capture_first_fault(was_healthy, operation_sequence, || {
            ViewFaultOperationMetrics::Release(metrics.clone())
        });
        self.metrics.scope_release = metrics;
        result
    }

    fn release_scopes_inner(
        &mut self,
        scopes: &[String],
        budget: &ViewExecutionBudget,
        started: Instant,
        metrics: &mut ViewScopeReleaseMetrics,
    ) -> Result<(), BridgeError> {
        self.ensure_healthy()?;
        let mut requested = BTreeSet::new();
        if scopes
            .iter()
            .any(|scope| scope.is_empty() || !requested.insert(scope.clone()))
        {
            return Err(invalid_batch("invalid or duplicate View release scope"));
        }
        if scopes.is_empty() {
            return Ok(());
        }
        let mut cleanup_started = false;
        let released = (|| {
            for modern in [false, true] {
                let engine = if modern {
                    self.modern_engine.as_mut()
                } else {
                    self.engine.as_mut()
                };
                if let Some(engine) = engine {
                    let remaining = remaining_budget(started, budget)?;
                    cleanup_started = true;
                    let provider_started = Instant::now();
                    let released = engine.release_scopes(scopes, &remaining);
                    collect_provider_timings(&mut metrics.provider_stages, engine.last_timings());
                    metrics.provider_ns = metrics
                        .provider_ns
                        .saturating_add(elapsed_ns(provider_started));
                    if let Err(error) = released {
                        self.poisoned = Some(error.clone());
                        return Err(self.mapped_error(&error));
                    }
                }
            }
            Ok(())
        })();
        if let Err(error) = released {
            if cleanup_started {
                self.poison_partial_operation(&error);
            }
            return Err(error);
        }
        for scope in scopes {
            self.scope_leases.remove(scope);
        }
        Ok(())
    }

    pub(crate) fn ensure_healthy(&self) -> Result<(), BridgeError> {
        if let Some(error) = &self.poisoned {
            let mut reset = ViewEngineError::new(
                ViewEngineErrorCode::RequiresReset,
                format!(
                    "View execution requires session restart after {}: {}",
                    error.code.as_str(),
                    error.message
                ),
            );
            reset.stack.clone_from(&error.stack);
            return Err(self.mapped_error(&reset));
        }
        Ok(())
    }

    fn poison_partial_operation(&mut self, error: &BridgeError) {
        if self.poisoned.is_none() {
            self.poisoned = Some(ViewEngineError::new(
                ViewEngineErrorCode::RequiresReset,
                format!("partial View operation: {error}"),
            ));
        }
    }

    fn mapped_error(&self, error: &ViewEngineError) -> BridgeError {
        let mut mapped = error.clone();
        if let Some(stack) = &error.stack {
            let offset = match self.engine_kind {
                EngineKind::Quickjs => 3,
                EngineKind::V8 => 3,
            };
            mapped.stack = Some(self.source_maps.map_stack(stack, offset));
        }
        view_error(&mapped)
    }

    fn record_interruption(&mut self, error: &ViewEngineError) {
        if matches!(
            error.code,
            ViewEngineErrorCode::Timeout
                | ViewEngineErrorCode::Cancelled
                | ViewEngineErrorCode::RequiresReset
                | ViewEngineErrorCode::Unavailable
                // Native adapters use InvalidBatch for malformed receipts as
                // well as input validation. Once the native boundary has been
                // crossed we cannot prove that no user code ran.
                | ViewEngineErrorCode::InvalidBatch
        ) {
            self.poisoned = Some(error.clone());
        }
    }
}

impl Drop for ViewExecution {
    fn drop(&mut self) {
        if let Some(engine) = &mut self.engine {
            engine.dispose();
        }
        if let Some(engine) = &mut self.modern_engine {
            engine.dispose();
        }
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    use crate::{EngineExecutionPolicy, Session, SessionConfig, SessionError};
    use serde_json::json;
    use std::time::Duration;

    fn manifest() -> ContainerManifestV1 {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "view-execution-policy".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.refresh_integrity().unwrap();
        manifest
    }

    fn configured_session() -> Session {
        Session::new(
            manifest(),
            SessionConfig {
                view_execution: crate::ViewExecutionPolicy {
                    batch_timeout_ms: 2_000,
                },
                ..Default::default()
            },
        )
        .unwrap()
    }

    #[test]
    fn omitted_view_policy_preserves_fifty_ms_and_legacy_engine_defaults() {
        for config in [
            SessionConfig::default(),
            serde_json::from_value(json!({})).unwrap(),
            serde_json::from_value(json!({"view_execution": {}})).unwrap(),
        ] {
            assert_eq!(config.view_execution, ViewExecutionPolicy::default());
            assert_eq!(config.view_execution.batch_timeout_ms, 50);
            assert_eq!(config.engine_execution, EngineExecutionPolicy::default());
            let session = Session::new(manifest(), config).unwrap();
            assert_eq!(
                session.view_execution_budget().timeout,
                Duration::from_millis(50)
            );
        }
        assert_eq!(
            ViewExecutionBudget::default().timeout,
            Duration::from_millis(50)
        );
        assert!(serde_json::from_value::<ViewExecutionPolicy>(
            json!({"batch_timeout_ms": 50, "typo": true})
        )
        .is_err());
    }

    #[test]
    fn view_policy_rejects_zero_and_excessive_limits_before_engine_creation() {
        for value in [0, 86_400_001, u64::MAX] {
            for engine in [EngineKind::Quickjs, EngineKind::V8] {
                let config = SessionConfig {
                    engine,
                    view_execution: ViewExecutionPolicy {
                        batch_timeout_ms: value,
                    },
                    ..Default::default()
                };
                assert!(matches!(
                    Session::new(manifest(), config),
                    Err(SessionError::Config(_))
                ));
            }
        }
        for value in [1, 86_400_000] {
            ViewExecutionPolicy {
                batch_timeout_ms: value,
            }
            .validate()
            .unwrap();
        }
    }

    #[test]
    fn explicit_view_policy_roundtrips_and_reaches_the_effective_batch_budget() {
        let session = configured_session();
        let encoded = serde_json::to_value(session.config()).unwrap();
        assert_eq!(encoded["view_execution"]["batch_timeout_ms"], 2_000);
        let decoded: SessionConfig = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded.view_execution, session.config().view_execution);
        assert_eq!(
            session.view_execution_budget().timeout,
            Duration::from_secs(2)
        );
    }

    #[test]
    fn configured_view_policy_cannot_extend_outer_engine_or_bridge_deadlines() {
        let mut session = configured_session();
        session.engine_turn_deadline = Instant::now().checked_add(Duration::from_millis(250));
        assert!(session.engine_turn_deadline.is_some());
        assert!(session.view_execution_budget().timeout <= Duration::from_millis(250));
        session.engine_turn_deadline = None;
        let now_ns = crate::SystemTime::now()
            .duration_since(crate::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        session
            .view_deadline_ns
            .set(Some(u64::try_from(now_ns + 125_000_000).unwrap()));
        assert!(session.view_execution_budget().timeout <= Duration::from_millis(125));
        session.view_deadline_ns.set(Some(1));
        assert_eq!(session.view_execution_budget().timeout, Duration::ZERO);
        session.engine_turn_deadline = Instant::now().checked_add(Duration::from_secs(1));
        assert_eq!(session.view_execution_budget().timeout, Duration::ZERO);
        session.view_deadline_ns.set(None);
        session.engine_turn_deadline = Some(Instant::now());
        assert_eq!(session.view_execution_budget().timeout, Duration::ZERO);
        session.engine_turn_deadline = None;
        assert_eq!(
            session.view_execution_budget().timeout,
            Duration::from_secs(2)
        );
    }

    #[test]
    fn configured_view_policy_does_not_reset_frontier_time_or_cancellation() {
        let session = configured_session();
        let parent = session.view_execution_budget();
        let child = remaining_budget(Instant::now(), &parent).unwrap();
        assert!(child.timeout <= parent.timeout);
        parent
            .cancellation
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(child.cancellation.load(std::sync::atomic::Ordering::SeqCst));
        session.view_deadline_ns.set(Some(1));
        let exhausted = session.view_execution_budget();
        assert_eq!(
            remaining_budget(Instant::now(), &exhausted)
                .unwrap_err()
                .code,
            BridgeErrorCode::Timeout
        );
    }

    #[test]
    fn view_policy_does_not_enable_unsupported_bounded_appservice_engines() {
        let result = Session::new(
            manifest(),
            SessionConfig {
                engine: EngineKind::V8,
                engine_execution: EngineExecutionPolicy {
                    turn_timeout_ms: Some(250),
                    bootstrap_timeout_ms: None,
                },
                view_execution: ViewExecutionPolicy {
                    batch_timeout_ms: 2_000,
                },
                ..Default::default()
            },
        );
        match result {
            Err(SessionError::EngineExecution(error)) => {
                assert_eq!(error.code, BridgeErrorCode::Engine)
            }
            _ => {
                panic!("View policy must not bypass the existing bounded AppService engine policy")
            }
        }
    }
}

pub(crate) fn remaining_budget(
    started: Instant,
    budget: &ViewExecutionBudget,
) -> Result<ViewExecutionBudget, BridgeError> {
    if budget
        .cancellation
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(view_error(&ViewEngineError::new(
            ViewEngineErrorCode::Cancelled,
            "View frontier was cancelled before native entry",
        )));
    }
    let timeout = budget
        .timeout
        .checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| {
            view_error(&ViewEngineError::new(
                ViewEngineErrorCode::Timeout,
                "View frontier deadline expired",
            ))
        })?;
    Ok(ViewExecutionBudget {
        timeout,
        cancellation: budget.cancellation.clone(),
    })
}

fn native_provider(kind: EngineKind, modern: bool) -> Result<Box<dyn ViewEngine>, BridgeError> {
    let _ = modern;
    match kind {
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs => (if modern {
            container_engine_quickjs::QuickJsViewEngine::new_modern(
                container_engine_quickjs::QuickJsConfig::default(),
            )
        } else {
            container_engine_quickjs::QuickJsViewEngine::new(
                container_engine_quickjs::QuickJsConfig::default(),
            )
        })
        .map(|engine| Box::new(engine) as Box<dyn ViewEngine>)
        .map_err(|error| view_error(&error)),
        #[cfg(feature = "v8-native")]
        EngineKind::V8 => (if modern {
            container_engine_v8::V8ViewEngine::new_modern(container_engine_v8::V8Config::default())
        } else {
            container_engine_v8::V8ViewEngine::new(container_engine_v8::V8Config::default())
        })
        .map(|engine| Box::new(engine) as Box<dyn ViewEngine>)
        .map_err(|error| view_error(&error)),
        #[allow(unreachable_patterns)]
        _ => Err(view_error(&unavailable())),
    }
}

pub(crate) fn modern_modules(
    manifest: &ContainerManifestV1,
    blobs: &BTreeMap<String, Vec<u8>>,
) -> Result<Vec<ViewModuleSource>, BridgeError> {
    let Some(modern) = &manifest.modern_view else {
        return Ok(Vec::new());
    };
    for hash in modern.blob_hashes() {
        let bytes = crate::lookup_render_blob(blobs, &format!("sha256:{hash}"))?;
        if container_ir::hex_digest(bytes) != hash {
            return Err(invalid_batch("modern View blob SHA-256 mismatch"));
        }
        std::str::from_utf8(bytes).map_err(|_| invalid_batch("modern View source is not UTF-8"))?;
    }
    crate::modern_source_map::ModernSourceMaps::load(manifest, blobs).map_err(invalid_batch)?;
    modern
        .units
        .iter()
        .map(|unit| {
            let source =
                crate::lookup_render_blob(blobs, &format!("sha256:{}", unit.executable_sha256))?;
            Ok(ViewModuleSource {
                id: unit.id.clone(),
                source: String::from_utf8(source.to_vec())
                    .map_err(|_| invalid_batch("modern executable is not UTF-8"))?,
                dependencies: Vec::new(),
                compilation: None,
            })
        })
        .collect()
}

fn modern_bindings(
    manifest: &ContainerManifestV1,
    document_id: &str,
) -> Option<BTreeMap<String, String>> {
    let unit = manifest
        .modern_view
        .as_ref()?
        .unit_for_document(document_id)?;
    let document = unit
        .documents
        .iter()
        .find(|entry| entry.document_id == document_id)?;
    Some(
        document
            .aliases
            .iter()
            .map(|alias| (alias.clone(), unit.id.clone()))
            .collect(),
    )
}

fn validate_document_profiles(
    manifest: &ContainerManifestV1,
    templates: &BTreeMap<String, WxmlAst>,
) -> Result<(), BridgeError> {
    fn visit(
        manifest: &ContainerManifestV1,
        owner: &str,
        nodes: &[container_ir::WxmlNode],
    ) -> Result<(), BridgeError> {
        for node in nodes {
            if let container_ir::WxmlNode::Element {
                tag,
                attrs,
                children,
                ..
            } = node
            {
                if tag == "wxs" && manifest.is_modern_document(owner) {
                    return Err(invalid_batch("modern documents cannot declare WXS"));
                }
                if tag == "include" || tag == "import" {
                    let request = attrs
                        .get("src")
                        .ok_or_else(|| invalid_batch("missing template dependency"))?;
                    let request = request.strip_prefix("template:").unwrap_or(request);
                    let mut parts = if request.starts_with('/') {
                        Vec::new()
                    } else {
                        owner.split('/').collect::<Vec<_>>()
                    };
                    if !request.starts_with('/') {
                        parts.pop();
                    }
                    for part in request.split('/') {
                        match part {
                            "" | "." => {}
                            ".." => {
                                if parts.pop().is_none() {
                                    return Err(invalid_batch("template dependency escapes root"));
                                }
                            }
                            part => parts.push(part),
                        }
                    }
                    let resolved = parts.join("/");
                    let direct = request.trim_start_matches("./").trim_start_matches('/');
                    let target = if manifest
                        .templates
                        .iter()
                        .any(|entry| entry.id == format!("template:{resolved}"))
                    {
                        resolved.as_str()
                    } else {
                        direct
                    };
                    if manifest.is_modern_document(owner) != manifest.is_modern_document(target) {
                        return Err(invalid_batch(
                            "WXML import/include cannot cross View profiles",
                        ));
                    }
                    if let Some(modern) = &manifest.modern_view {
                        if let (Some(source), Some(target)) = (
                            modern.unit_for_document(owner),
                            modern.unit_for_document(target),
                        ) {
                            if source.id != target.id {
                                return Err(invalid_batch(
                                    "one modern template graph must use one execution unit",
                                ));
                            }
                        }
                    }
                }
                visit(manifest, owner, children)?;
            }
        }
        Ok(())
    }
    for (id, ast) in templates {
        visit(manifest, canonical_document(id)?, &ast.nodes)?;
    }
    Ok(())
}

fn validate_manifest(manifest: &ContainerManifestV1) -> Result<(), BridgeError> {
    manifest
        .validate()
        .map_err(|error| BridgeError::new(BridgeErrorCode::InvalidManifest, error.to_string()))
}

fn program_digest(manifest: &ContainerManifestV1) -> Result<String, BridgeError> {
    let mut modules = manifest
        .view_scripts
        .iter()
        .map(|module| {
            let mut dependencies = module.dependencies.clone();
            dependencies.sort();
            (module.id.clone(), module.sha256.clone(), dependencies)
        })
        .collect::<Vec<_>>();
    modules.sort_by(|left, right| left.0.cmp(&right.0));
    // Lexical bindings are fixed per (scope, document) in the native realm.
    // Changing them also changes the executable View program, even when all
    // source hashes are unchanged. Ordinary WXML edits do not reset caches.
    let bindings = manifest
        .templates
        .iter()
        .filter(|template| !template.wxs_modules.is_empty())
        .map(|template| (template.id.clone(), template.wxs_modules.clone()))
        .collect::<BTreeMap<_, _>>();
    let bytes = serde_json::to_vec(&(
        modules,
        bindings,
        &manifest.view_compilation,
        &manifest.modern_view,
    ))
    .map_err(|error| {
        BridgeError::new(
            BridgeErrorCode::Render,
            format!("cannot fingerprint View module program: {error}"),
        )
    })?;
    Ok(container_ir::hex_digest(&bytes))
}

pub(crate) fn compiled_source(
    blobs: &BTreeMap<String, Vec<u8>>,
    sha256: &str,
    helper: &str,
    abi: &str,
) -> Result<ViewCompiledSource, BridgeError> {
    let bytes = crate::lookup_render_blob(blobs, &format!("sha256:{sha256}"))?;
    if container_ir::hex_digest(bytes) != sha256 {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            "compiled View source SHA-256 mismatch",
        ));
    }
    let code = std::str::from_utf8(bytes).map_err(|error| {
        BridgeError::new(
            BridgeErrorCode::Render,
            format!("compiled View source is not UTF-8: {error}"),
        )
    })?;
    Ok(ViewCompiledSource {
        code: code.into(),
        helper: helper.into(),
        abi: abi.into(),
    })
}

fn canonical_document(template: &str) -> Result<&str, BridgeError> {
    let document = template.strip_prefix("template:").unwrap_or(template);
    WxmlLexicalOrigin::from_document(document).map_err(|error| invalid_batch(error.to_string()))?;
    Ok(document)
}

fn unavailable() -> ViewEngineError {
    ViewEngineError::new(
        ViewEngineErrorCode::Unavailable,
        "selected native View provider is unavailable; no fallback is permitted",
    )
}

fn invalid_view_receipt(message: impl Into<String>) -> ViewEngineError {
    ViewEngineError::new(ViewEngineErrorCode::InvalidBatch, message)
}

fn invalid_batch(message: impl Into<String>) -> BridgeError {
    view_error(&invalid_view_receipt(message))
}

fn elapsed_ns(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_nanos()).unwrap_or(u64::MAX)
}

fn view_error(error: &ViewEngineError) -> BridgeError {
    let code = match error.code {
        ViewEngineErrorCode::Unavailable | ViewEngineErrorCode::RequiresReset => {
            BridgeErrorCode::Engine
        }
        ViewEngineErrorCode::Timeout => BridgeErrorCode::Timeout,
        ViewEngineErrorCode::Cancelled => BridgeErrorCode::Cancelled,
        ViewEngineErrorCode::Module => BridgeErrorCode::ModuleLoad,
        ViewEngineErrorCode::Execution
        | ViewEngineErrorCode::UnsupportedValue
        | ViewEngineErrorCode::InvalidBatch => BridgeErrorCode::Render,
    };
    let message = match &error.stack {
        Some(stack) => format!("{}: {}\n{stack}", error.code.as_str(), error.message),
        None => format!("{}: {}", error.code.as_str(), error.message),
    };
    BridgeError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_core::{
        ViewExpressionResult, ViewExpressionTask, ViewRenderBatch, ViewRenderResult,
    };
    use serde_json::json;
    use std::{cell::RefCell, rc::Rc, time::Duration};

    #[derive(Default)]
    struct MockState {
        loads: usize,
        renders: Vec<ViewRenderBatch>,
        registrations: Vec<Vec<ViewRenderDocument>>,
        documents: Vec<ViewRenderDocument>,
        document_registry: container_core::ViewDocumentRegistry,
        releases: Vec<Vec<String>>,
        disposals: usize,
        load_error: Option<ViewEngineError>,
        render_error: Option<ViewEngineError>,
        registration_error: Option<ViewEngineError>,
        cancel_after_registration: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
        release_error: Option<ViewEngineError>,
        receipts: Option<Vec<ViewRenderResult>>,
        load_delay: Duration,
        release_delay: Duration,
    }

    struct MockEngine(Rc<RefCell<MockState>>);

    impl ViewEngine for MockEngine {
        fn load_modules(
            &mut self,
            _: &[ViewModuleSource],
            _: &ViewExecutionBudget,
        ) -> Result<(), ViewEngineError> {
            let mut state = self.0.borrow_mut();
            state.loads += 1;
            std::thread::sleep(state.load_delay);
            state.load_error.clone().map_or(Ok(()), Err)
        }

        fn evaluate_batch(
            &mut self,
            _: &[ViewExpressionTask],
            _: &ViewExecutionBudget,
        ) -> Result<Vec<ViewExpressionResult>, ViewEngineError> {
            Err(invalid_view_receipt("unexpected expression call"))
        }

        fn render_batch(
            &mut self,
            batch: &ViewRenderBatch,
            _: &ViewExecutionBudget,
        ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
            let mut state = self.0.borrow_mut();
            state.renders.push(batch.clone());
            if let Some(error) = &state.render_error {
                return Err(error.clone());
            }
            Ok(state.receipts.take().unwrap_or_else(|| {
                batch
                    .tasks
                    .iter()
                    .map(|task| receipt(&task.task_id, &task.document_id))
                    .collect()
            }))
        }

        fn register_documents(
            &mut self,
            program: &ViewDocumentProgram,
            _: &ViewExecutionBudget,
        ) -> Result<ViewDocumentHandle, ViewEngineError> {
            let mut state = self.0.borrow_mut();
            state.registrations.push(program.documents().to_vec());
            if let Some(error) = &state.registration_error {
                return Err(error.clone());
            }
            let key = state.document_registry.reserve_key()?;
            let handle = state.document_registry.publish(key, program.documents());
            state.documents = program.documents().to_vec();
            if let Some(cancel) = &state.cancel_after_registration {
                cancel.store(true, std::sync::atomic::Ordering::Release);
            }
            Ok(handle)
        }

        fn render_registered_batch(
            &mut self,
            handle: &ViewDocumentHandle,
            tasks: &[ViewRenderTask],
            budget: &ViewExecutionBudget,
        ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
            let documents = {
                let state = self.0.borrow();
                state.document_registry.key(handle)?;
                state.documents.clone()
            };
            self.render_batch(
                &ViewRenderBatch {
                    documents,
                    tasks: tasks.to_vec(),
                },
                budget,
            )
        }

        fn release_scopes(
            &mut self,
            scopes: &[String],
            _: &ViewExecutionBudget,
        ) -> Result<(), ViewEngineError> {
            let mut state = self.0.borrow_mut();
            state.releases.push(scopes.to_vec());
            std::thread::sleep(state.release_delay);
            state.release_error.clone().map_or(Ok(()), Err)
        }

        fn reset(&mut self) -> Result<(), ViewEngineError> {
            panic!("ViewExecution must not reset a stateful realm automatically")
        }

        fn dispose(&mut self) {
            self.0.borrow_mut().disposals += 1;
        }
    }

    fn execution() -> (ViewExecution, Rc<RefCell<MockState>>) {
        let state = Rc::new(RefCell::new(MockState::default()));
        (
            ViewExecution {
                engine: Some(Box::new(MockEngine(Rc::clone(&state)))),
                modern_engine: None,
                pending_empty_legacy: false,
                provider_factory: None,
                engine_kind: EngineKind::Quickjs,
                provider_available: true,
                source_maps: Default::default(),
                module_digest: None,
                compiled_documents: BTreeMap::new(),
                scope_leases: BTreeSet::new(),
                poisoned: None,
                first_fault: None,
                operation_sequence: 0,
                created_at: Instant::now(),
                fault_authority_retired: false,
                verified_program: None,
                encoded_documents: None,
                registered_documents: [None, None],
                metrics: ViewExecutionMetrics::default(),
            },
            state,
        )
    }

    fn compiled_fixture() -> (ContainerManifestV1, BTreeMap<String, Vec<u8>>) {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../conformance/fixtures/isolated-view-render/golden-program.json"
        ))
        .unwrap();
        let manifest = serde_json::from_value(fixture["manifest"].clone()).unwrap();
        let blobs = fixture["blobs"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(hash, source)| {
                (
                    format!("sha256:{hash}"),
                    source.as_str().unwrap().as_bytes().to_vec(),
                )
            })
            .collect();
        (manifest, blobs)
    }

    fn fixture() -> (ContainerManifestV1, BTreeMap<String, Vec<u8>>) {
        let (mut manifest, blobs) = compiled_fixture();
        manifest.view_compilation = None;
        (manifest, blobs)
    }

    fn mixed_fixture() -> (ContainerManifestV1, BTreeMap<String, Vec<u8>>) {
        let (mut manifest, mut blobs) = fixture();
        let ast = container_ir::parse_wxml("<view>{{tools.value}}</view>").unwrap();
        let ast_bytes = serde_json::to_vec(&ast).unwrap();
        let ast_hash = container_ir::hex_digest(&ast_bytes);
        blobs.insert(format!("sha256:{ast_hash}"), ast_bytes);
        manifest.templates.push(container_ir::Template {
            id: "template:modern.wxml".into(),
            wxml_ast: format!("sha256:{ast_hash}"),
            bindings: vec!["tools.value".into()],
            wxs_modules: BTreeMap::new(),
        });
        let executable = b"module.exports={\"modern.wxml\":{tools:{value:1}}};".to_vec();
        let executable_sha256 = container_ir::hex_digest(&executable);
        let source = b"export const value = 1;".to_vec();
        let source_sha256 = container_ir::hex_digest(&source);
        let source_map = serde_json::to_vec(&json!({
            "version":3,"sources":["tools.view.ts"],"names":[],"mappings":""
        }))
        .unwrap();
        let source_map_sha256 = container_ir::hex_digest(&source_map);
        for (hash, bytes) in [
            (&executable_sha256, executable),
            (&source_sha256, source),
            (&source_map_sha256, source_map),
        ] {
            blobs.insert(format!("sha256:{hash}"), bytes);
        }
        manifest.schema_version = 2;
        manifest.modern_view = Some(container_ir::ModernViewCompilation {
            compiler: "weapp-container-modern-view".into(),
            version: "1.0.0".into(),
            abi: "1.0".into(),
            target: "es2022".into(),
            units: vec![container_ir::ModernViewUnit {
                id: format!("modern:{executable_sha256}"),
                executable_sha256,
                source_map_sha256,
                sources: vec![container_ir::ModernViewSource {
                    path: "tools.view.ts".into(),
                    sha256: source_sha256,
                }],
                documents: vec![container_ir::ModernViewDocument {
                    document_id: "modern.wxml".into(),
                    aliases: vec!["tools".into()],
                }],
            }],
        });
        (manifest, blobs)
    }

    fn attach_modern_mock(view: &mut ViewExecution) -> Rc<RefCell<MockState>> {
        let state = Rc::new(RefCell::new(MockState::default()));
        view.modern_engine = Some(Box::new(MockEngine(Rc::clone(&state))));
        state
    }

    fn mixed_tasks(manifest: &ContainerManifestV1) -> Vec<ViewRenderTask> {
        let mut tasks = tasks(manifest);
        tasks.insert(
            0,
            ViewRenderTask {
                task_id: "task:modern".into(),
                scope_id: "modern-page".into(),
                document_id: "modern.wxml".into(),
                data: json!({}),
            },
        );
        tasks
    }

    #[test]
    fn immutable_program_and_source_encoding_reuse_never_skips_native_frontiers() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let resources = std::sync::Arc::new(blobs);
        let source = templates(&manifest, &resources);
        let budget = ViewExecutionBudget::default();

        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        assert!(!view.metrics().preparation.cache_hit);
        view.render_documents(&manifest, &source, &tasks(&manifest), &budget)
            .unwrap();
        assert!(!view.metrics().frontier.document_cache_hit);
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        assert!(view.metrics().preparation.cache_hit);
        let mut next_tasks = tasks(&manifest);
        next_tasks[0].data = json!({"value":"new data every batch"});
        view.render_documents(&manifest, &source, &next_tasks, &budget)
            .unwrap();
        let metrics = view.metrics();
        assert!(metrics.frontier.document_cache_hit);
        assert!(metrics.frontier.succeeded);
        assert!(metrics.frontier.elapsed_ns >= metrics.frontier.provider_ns);
        assert!(metrics.frontier.elapsed_ns >= metrics.frontier.receipt_validation_ns);
        assert_eq!(state.borrow().loads, 1);
        assert_eq!(
            state.borrow().renders.len(),
            2,
            "stateful guest functions still execute on every frontier"
        );
        assert_eq!(state.borrow().renders[1].tasks[0].data, next_tasks[0].data);

        let mut changed_source = source.clone();
        let first = changed_source.values_mut().next().unwrap();
        *first = container_ir::parse_wxml("<view>changed source</view>").unwrap();
        view.render_documents(&manifest, &changed_source, &next_tasks, &budget)
            .unwrap();
        assert!(!view.metrics().frontier.document_cache_hit);
        assert_eq!(state.borrow().renders.len(), 3);
    }

    #[test]
    fn verified_cache_binds_full_manifest_and_arc_lease_and_raw_path_rechecks_bytes() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let mut resources = std::sync::Arc::new(blobs);
        let budget = ViewExecutionBudget::default();
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        assert!(
            std::sync::Arc::get_mut(&mut resources).is_none(),
            "cached bytes retain an immutable lease"
        );

        let mut forged = manifest.clone();
        forged.view_scripts[0].sha256 = "0".repeat(64);
        assert_eq!(forged.integrity.root, manifest.integrity.root);
        assert!(view
            .prepare_verified_modules(&forged, &resources, &budget)
            .is_err());
        assert!(!view.metrics().preparation.cache_hit);
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        let module = &manifest.view_scripts[0];
        let pointer = format!("sha256:{}", module.sha256);
        std::sync::Arc::make_mut(&mut resources)
            .get_mut(&pointer)
            .unwrap()
            .push(b' ');
        assert!(
            view.prepare_verified_modules(&manifest, &resources, &budget)
                .is_err(),
            "make_mut changed identity; stale SHA must fail"
        );
        assert!(!view.metrics().preparation.cache_hit);
        assert!(!view.metrics().preparation.succeeded);

        let (_, valid) = fixture();
        let valid = std::sync::Arc::new(valid);
        view.prepare_verified_modules(&manifest, &valid, &budget)
            .unwrap();
        let mut mutable = (*valid).clone();
        mutable.get_mut(&pointer).unwrap().push(b' ');
        assert!(view.prepare_modules(&manifest, &mutable, &budget).is_err());
        assert!(view.verified_program.is_none());
        assert_eq!(
            state.borrow().loads,
            1,
            "unchanged program keeps native module identity"
        );
    }

    #[test]
    fn immutable_cache_cannot_bypass_deadline_cancellation_or_sticky_fault() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let resources = std::sync::Arc::new(blobs);
        let budget = ViewExecutionBudget::default();
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        assert_eq!(
            view.prepare_verified_modules(
                &manifest,
                &resources,
                &ViewExecutionBudget::new(Duration::ZERO)
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::Timeout
        );
        budget
            .cancellation
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            view.prepare_verified_modules(&manifest, &resources, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        budget
            .cancellation
            .store(false, std::sync::atomic::Ordering::Release);
        view.inject_fault_for_test(ViewEngineError::new(
            ViewEngineErrorCode::Timeout,
            "original interruption",
        ));
        assert_eq!(
            view.prepare_verified_modules(&manifest, &resources, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert!(!view.metrics().preparation.cache_hit);
        assert!(view
            .fault()
            .unwrap()
            .message
            .contains("original interruption"));
        assert_eq!(state.borrow().loads, 1);
    }

    #[test]
    fn registry_deadline_after_legacy_success_requires_restart() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        legacy.borrow_mut().load_delay = Duration::from_millis(20);
        let budget = ViewExecutionBudget::new(Duration::from_millis(10));
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Timeout
        );
        assert_eq!(legacy.borrow().loads, 1);
        assert_eq!(modern.borrow().loads, 0);
        assert!(view.module_digest.is_none());
        assert!(view.poisoned.is_some());
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert_eq!(legacy.borrow().loads, 1);
        assert_eq!(modern.borrow().loads, 0);
    }

    #[test]
    fn modern_registry_failure_after_legacy_success_requires_restart() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        modern.borrow_mut().load_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::Module,
            "modern candidate failed",
        ));
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::ModuleLoad
        );
        assert_eq!(legacy.borrow().loads, 1);
        assert_eq!(modern.borrow().loads, 1);
        assert!(view.poisoned.is_some());
        assert_eq!(
            view.release_scopes(&["page-one".into()], &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert!(legacy.borrow().releases.is_empty());
        assert!(modern.borrow().releases.is_empty());
    }

    #[cfg(not(feature = "v8-native"))]
    #[test]
    fn provider_construction_failure_after_legacy_success_requires_restart() {
        let (mut view, legacy) = execution();
        let (manifest, blobs) = mixed_fixture();
        view.engine_kind = EngineKind::V8;
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert_eq!(legacy.borrow().loads, 1);
        assert!(view.modern_engine.is_none());
        assert!(view.poisoned.is_some());
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert_eq!(legacy.borrow().loads, 1);
    }

    #[test]
    fn release_deadline_after_first_profile_preserves_leases_and_requires_restart() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(
            &manifest,
            &templates(&manifest, &blobs),
            &mixed_tasks(&manifest),
            &budget,
        )
        .unwrap();
        let previous_leases = view.scope_leases.clone();
        legacy.borrow_mut().release_delay = Duration::from_millis(20);
        assert_eq!(
            view.release_scopes(
                &["page-one".into(), "modern-page".into()],
                &ViewExecutionBudget::new(Duration::from_millis(10)),
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::Timeout
        );
        assert_eq!(legacy.borrow().releases.len(), 1);
        assert!(modern.borrow().releases.is_empty());
        assert_eq!(view.scope_leases, previous_leases);
        assert!(view.poisoned.is_some());
        assert_eq!(
            view.release_scopes(&["page-one".into()], &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        assert_eq!(legacy.borrow().releases.len(), 1);
    }

    #[test]
    fn mixed_profiles_validate_every_document_before_any_stateful_task() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        modern.borrow_mut().registration_error = Some(
            ViewEngineError::new(ViewEngineErrorCode::Execution, "invalid modern expression")
                .document_program_rejected(),
        );
        assert_eq!(
            view.render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &mixed_tasks(&manifest),
                &budget,
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::Render
        );
        assert!(
            !view.is_faulted(),
            "ordinary proven static rejection preserves healthy realms"
        );
        for state in [&legacy, &modern] {
            let state = state.borrow();
            assert_eq!(state.registrations.len(), 1);
            assert!(state.renders.is_empty());
        }
    }

    #[test]
    fn mixed_profile_receipts_preserve_frontier_order() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        let tasks = mixed_tasks(&manifest);
        let results = view
            .render_documents(&manifest, &templates(&manifest, &blobs), &tasks, &budget)
            .unwrap();
        assert_eq!(
            results.iter().map(|(id, _)| id).collect::<Vec<_>>(),
            tasks.iter().map(|task| &task.task_id).collect::<Vec<_>>()
        );
        for state in [&legacy, &modern] {
            let state = state.borrow();
            assert_eq!(state.registrations.len(), 1);
            assert_eq!(state.renders.len(), 1);
            assert!(!state.renders[0].tasks.is_empty());
        }
    }

    #[test]
    fn registered_empty_frontier_validates_and_warm_frontiers_reuse_one_program() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let resources = std::sync::Arc::new(blobs);
        let source = templates(&manifest, &resources);
        let budget = ViewExecutionBudget::default();
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        view.render_documents(&manifest, &source, &[], &budget)
            .unwrap();
        assert_eq!(
            state.borrow().registrations.len(),
            1,
            "startup must validate even with no tasks"
        );
        assert!(state.borrow().renders.is_empty());
        assert_eq!(view.metrics.frontier.document_registrations, 1);
        for value in [1, 2, 1] {
            let mut dynamic = tasks(&manifest);
            dynamic[0].data = json!({"value":value});
            view.render_documents(&manifest, &source, &dynamic, &budget)
                .unwrap();
            assert_eq!(view.metrics.frontier.registration_cache_hits, 1);
            assert_eq!(view.metrics.frontier.document_registrations, 0);
        }
        assert_eq!(state.borrow().registrations.len(), 1);
        assert_eq!(
            state.borrow().renders.len(),
            3,
            "registration never memoizes stateful results"
        );
    }

    #[test]
    fn registered_mixed_rejection_preserves_accepted_program_and_can_reregister_first_profile() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        let source = templates(&manifest, &blobs);
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(&manifest, &source, &mixed_tasks(&manifest), &budget)
            .unwrap();
        legacy.borrow_mut().renders.clear();
        modern.borrow_mut().renders.clear();
        let mut changed = source.clone();
        for ast in changed.values_mut() {
            ast.nodes.extend(
                container_ir::parse_wxml("<!--different static program-->")
                    .unwrap()
                    .nodes,
            );
        }
        modern.borrow_mut().registration_error = Some(
            ViewEngineError::new(
                ViewEngineErrorCode::InvalidBatch,
                "rejected static candidate",
            )
            .document_program_rejected(),
        );
        assert!(view
            .render_documents(&manifest, &changed, &mixed_tasks(&manifest), &budget)
            .is_err());
        assert!(!view.is_faulted());
        assert!(legacy.borrow().renders.is_empty());
        assert!(
            modern.borrow().renders.is_empty(),
            "no profile may execute before all static preflight succeeds"
        );
        modern.borrow_mut().registration_error = None;
        view.render_documents(&manifest, &source, &mixed_tasks(&manifest), &budget)
            .unwrap();
        assert_eq!(
            legacy.borrow().registrations.len(),
            3,
            "accepted prior first profile must register again after its explicit replacement"
        );
        assert_eq!(
            modern.borrow().registrations.len(),
            2,
            "failed candidate never retired the prior second-profile handle"
        );
        assert_eq!(legacy.borrow().renders.len(), 1);
        assert_eq!(modern.borrow().renders.len(), 1);
    }

    #[test]
    fn registered_unexpected_native_failure_is_not_ordinary_static_rejection() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        state.borrow_mut().registration_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::Execution,
            "untrusted native receipt",
        ));
        assert!(view
            .render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget
            )
            .is_err());
        assert!(view.is_faulted());
        assert!(state.borrow().renders.is_empty());
        let calls = state.borrow().registrations.len();
        assert!(view
            .render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget
            )
            .is_err());
        assert_eq!(
            state.borrow().registrations.len(),
            calls,
            "sticky fault cannot be revived by cached static input"
        );
    }

    #[test]
    fn registered_final_profile_cancellation_rejects_empty_and_nonempty_frontiers() {
        for empty in [true, false] {
            let (mut view, state) = execution();
            let (manifest, blobs) = fixture();
            let budget = ViewExecutionBudget::default();
            view.prepare_modules(&manifest, &blobs, &budget).unwrap();
            state.borrow_mut().cancel_after_registration =
                Some(std::sync::Arc::clone(&budget.cancellation));
            let dynamic = if empty { Vec::new() } else { tasks(&manifest) };
            let error = view
                .render_documents(&manifest, &templates(&manifest, &blobs), &dynamic, &budget)
                .unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::Cancelled);
            assert!(view.is_faulted());
            assert_eq!(state.borrow().registrations.len(), 1);
            assert!(
                state.borrow().renders.is_empty(),
                "last registration must be checked even if no tasks run"
            );
            assert!(!view.metrics.frontier.succeeded);
        }
    }

    #[test]
    fn registered_mixed_cancellation_between_profiles_uses_same_budget_and_never_executes_tasks() {
        let (mut view, legacy) = execution();
        let modern = attach_modern_mock(&mut view);
        let (manifest, blobs) = mixed_fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        legacy.borrow_mut().cancel_after_registration =
            Some(std::sync::Arc::clone(&budget.cancellation));
        let error = view
            .render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &mixed_tasks(&manifest),
                &budget,
            )
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Cancelled);
        assert!(view.is_faulted());
        assert_eq!(legacy.borrow().registrations.len(), 1);
        assert!(modern.borrow().registrations.is_empty());
        assert!(legacy.borrow().renders.is_empty());
        assert!(modern.borrow().renders.is_empty());
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn modern_only_program_never_allocates_a_legacy_realm() {
        let (mut manifest, blobs) = mixed_fixture();
        manifest
            .templates
            .retain(|template| template.id == "template:modern.wxml");
        manifest.view_scripts.clear();
        let mut view = ViewExecution::new(EngineKind::Quickjs).unwrap();
        assert!(view.engine.is_none());
        assert!(view.modern_engine.is_none());
        let budget = ViewExecutionBudget::new(Duration::from_secs(2));
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert!(view.engine.is_none());
        assert!(view.modern_engine.is_some());
        let document_templates = templates(&manifest, &blobs);
        view.render_documents(&manifest, &document_templates, &[], &budget)
            .unwrap();
        view.render_documents(&manifest, &document_templates, &tasks(&manifest), &budget)
            .unwrap();
        assert!(view.engine.is_none());
    }

    #[test]
    fn compiled_program_rechecks_every_blob_and_fingerprints_executable_identity() {
        let (mut view, state) = execution();
        let (mut manifest, mut blobs) = compiled_fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(state.borrow().loads, 1);
        assert_eq!(view.compiled_documents.len(), manifest.templates.len());
        let digest = view.module_digest.clone();
        let declaration = manifest.view_compilation.as_ref().unwrap();
        let module_pointer = format!("sha256:{}", declaration.modules[0].executable_sha256);
        let source = blobs.remove(&module_pointer).unwrap();
        assert!(view.prepare_modules(&manifest, &blobs, &budget).is_err());
        blobs.insert(module_pointer.clone(), b"wrong executable".to_vec());
        assert!(view.prepare_modules(&manifest, &blobs, &budget).is_err());
        blobs.insert(module_pointer, source);
        let expression = declaration
            .documents
            .iter()
            .flat_map(|document| &document.expressions)
            .next()
            .unwrap();
        let expression_pointer = format!("sha256:{}", expression.executable_sha256);
        let source = blobs
            .insert(expression_pointer.clone(), b"wrong expression".to_vec())
            .unwrap();
        assert!(view.prepare_modules(&manifest, &blobs, &budget).is_err());
        blobs.insert(expression_pointer, source);
        assert_eq!(state.borrow().loads, 1);
        assert_eq!(view.module_digest, digest);
        let executable = b"module.exports={compiled:2};".to_vec();
        let sha = container_ir::hex_digest(&executable);
        manifest.view_compilation.as_mut().unwrap().modules[0].executable_sha256 = sha.clone();
        blobs.insert(format!("sha256:{sha}"), executable);
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(state.borrow().loads, 2);
        assert_ne!(view.module_digest, digest);
    }

    fn templates(
        manifest: &ContainerManifestV1,
        blobs: &BTreeMap<String, Vec<u8>>,
    ) -> BTreeMap<String, WxmlAst> {
        manifest
            .templates
            .iter()
            .map(|template| {
                (
                    template.id.clone(),
                    container_ir::decode_wxml(&blobs[&template.wxml_ast]).unwrap(),
                )
            })
            .collect()
    }

    fn tasks(manifest: &ContainerManifestV1) -> Vec<ViewRenderTask> {
        let document = canonical_document(&manifest.templates[0].id).unwrap();
        ["page-one", "page-two"]
            .into_iter()
            .map(|scope| ViewRenderTask {
                task_id: format!("task:{scope}"),
                scope_id: scope.into(),
                document_id: document.into(),
                data: json!({"count":1}),
            })
            .collect()
    }

    fn receipt(task: &str, document: &str) -> ViewRenderResult {
        ViewRenderResult {
            attribute_sources: Vec::new(),
            task_id: task.into(),
            ast: json!({"version":1,"nodes":[{
                "kind":"text","value":task,"bindings":[],
                "lexicalOrigin":{"documentId":document}
            }]}),
        }
    }

    #[test]
    fn unchanged_verified_program_does_not_reload_or_drop_scope_leases() {
        let (mut view, state) = execution();
        let (mut manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        let tasks = tasks(&manifest);
        view.render_documents(&manifest, &templates(&manifest, &blobs), &tasks, &budget)
            .unwrap();
        manifest.view_scripts.reverse();
        for module in &mut manifest.view_scripts {
            module.dependencies.reverse();
        }
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(state.borrow().loads, 1);
        assert_eq!(view.scope_leases.len(), 2);
    }

    #[test]
    fn changed_lexical_program_requires_prepare_and_only_then_replaces_scopes() {
        let (mut view, state) = execution();
        let (mut manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(
            &manifest,
            &templates(&manifest, &blobs),
            &tasks(&manifest),
            &budget,
        )
        .unwrap();
        let module = manifest
            .view_scripts
            .iter()
            .find(|module| !module.id.contains('#'))
            .unwrap()
            .id
            .clone();
        manifest.templates[0]
            .wxs_modules
            .insert("newProgramAlias".into(), module);
        assert_eq!(
            view.render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget,
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::ModuleLoad
        );
        assert_eq!(state.borrow().renders.len(), 1);
        assert_eq!(view.scope_leases.len(), 2);
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(state.borrow().loads, 2);
        assert!(view.scope_leases.is_empty());
    }

    #[test]
    fn unchanged_digest_still_rejects_bad_or_missing_source_bytes() {
        let (mut view, state) = execution();
        let (manifest, mut blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        let pointer = format!("sha256:{}", manifest.view_scripts[0].sha256);
        let original = blobs
            .insert(pointer.clone(), b"wrong bytes".to_vec())
            .unwrap();
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Render
        );
        blobs.remove(&pointer);
        assert!(view.prepare_modules(&manifest, &blobs, &budget).is_err());
        blobs.insert(pointer, original);
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(state.borrow().loads, 1);
        assert!(view.poisoned.is_none());
    }

    #[test]
    fn module_graph_and_utf8_fail_before_native_load() {
        let (mut view, state) = execution();
        let (mut manifest, mut blobs) = fixture();
        manifest.view_scripts[0]
            .dependencies
            .push("wxs:missing.wxs".into());
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidManifest
        );
        manifest.view_scripts[0].dependencies.pop();
        let bytes = vec![0xff, 0xfe];
        let hash = container_ir::hex_digest(&bytes);
        manifest.view_scripts[0].sha256 = hash.clone();
        blobs.insert(format!("sha256:{hash}"), bytes);
        let error = view
            .prepare_modules(&manifest, &blobs, &ViewExecutionBudget::default())
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Render);
        assert!(error.message.contains("UTF-8"));
        assert_eq!(state.borrow().loads, 0);
    }

    #[test]
    fn failed_module_candidate_preserves_last_program_and_leases() {
        let (mut view, state) = execution();
        let (mut manifest, mut blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(
            &manifest,
            &templates(&manifest, &blobs),
            &tasks(&manifest),
            &budget,
        )
        .unwrap();
        let previous = view.module_digest.clone();
        let bytes = b"module.exports = {};".to_vec();
        let hash = container_ir::hex_digest(&bytes);
        manifest.view_scripts[0].sha256 = hash.clone();
        blobs.insert(format!("sha256:{hash}"), bytes);
        state.borrow_mut().load_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::Module,
            "rejected candidate",
        ));
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::ModuleLoad
        );
        assert_eq!(view.module_digest, previous);
        assert_eq!(view.scope_leases.len(), 2);
        assert!(view.poisoned.is_none());
    }

    #[test]
    fn full_frontier_uses_one_batch_with_manifest_lexical_bindings() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        let mut documents = templates(&manifest, &blobs);
        for (id, ast) in documents.clone() {
            documents.insert(id.strip_prefix("template:").unwrap().into(), ast);
        }
        let tasks = tasks(&manifest);
        let result = view
            .render_documents(&manifest, &documents, &tasks, &budget)
            .unwrap();
        assert_eq!(
            result.iter().map(|(id, _)| id).collect::<Vec<_>>(),
            tasks.iter().map(|task| &task.task_id).collect::<Vec<_>>()
        );
        let state = state.borrow();
        assert_eq!(state.renders.len(), 1);
        assert_eq!(state.renders[0].tasks.len(), 2);
        assert_eq!(state.renders[0].documents.len(), manifest.templates.len());
        for document in &state.renders[0].documents {
            let declaration = manifest
                .templates
                .iter()
                .find(|template| {
                    template.id.strip_prefix("template:") == Some(document.document_id.as_str())
                })
                .unwrap();
            assert_eq!(document.bindings, declaration.wxs_modules);
        }
    }

    #[test]
    fn invalid_inputs_are_rejected_before_scope_registration_and_execution() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        let mut tasks = tasks(&manifest);
        tasks[1].task_id = tasks[0].task_id.clone();
        assert!(view
            .render_documents(&manifest, &templates(&manifest, &blobs), &tasks, &budget)
            .is_err());
        assert!(view.scope_leases.is_empty());
        assert!(state.borrow().renders.is_empty());
    }

    #[test]
    fn incomplete_or_invalid_receipt_poisons_without_exposing_partial_asts() {
        for kind in ["missing", "order", "provenance", "ast"] {
            let (mut view, state) = execution();
            let (manifest, blobs) = fixture();
            let budget = ViewExecutionBudget::default();
            let tasks = tasks(&manifest);
            view.prepare_modules(&manifest, &blobs, &budget).unwrap();
            let mut receipts = tasks
                .iter()
                .map(|task| receipt(&task.task_id, &task.document_id))
                .collect::<Vec<_>>();
            match kind {
                "missing" => {
                    receipts.pop();
                }
                "order" => receipts.reverse(),
                "provenance" => {
                    receipts[1].ast["nodes"][0]["lexicalOrigin"]["documentId"] =
                        json!("undeclared.wxml")
                }
                "ast" => receipts[1].ast["version"] = json!(999),
                _ => unreachable!(),
            }
            state.borrow_mut().receipts = Some(receipts);
            assert!(
                view.render_documents(&manifest, &templates(&manifest, &blobs), &tasks, &budget)
                    .is_err(),
                "{kind}"
            );
            assert_eq!(view.scope_leases.len(), 2);
            assert!(view.poisoned.is_some());
            assert_eq!(
                view.render_documents(&manifest, &templates(&manifest, &blobs), &tasks, &budget)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Engine
            );
            assert_eq!(state.borrow().renders.len(), 1);
        }
    }

    #[test]
    fn ordinary_execution_error_keeps_leases_for_explicit_cleanup_without_retry() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        state.borrow_mut().render_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::Execution,
            "user exception",
        ));
        assert_eq!(
            view.render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::Render
        );
        assert_eq!(state.borrow().renders.len(), 1);
        assert!(view.poisoned.is_none());
        assert_eq!(view.scope_leases.len(), 2);
        view.release_scopes(&["page-one".into()], &budget).unwrap();
        assert_eq!(view.scope_leases, BTreeSet::from(["page-two".into()]));
    }

    #[test]
    fn interruption_preserves_native_error_and_requires_session_restart() {
        for (native_code, bridge_code) in [
            (ViewEngineErrorCode::Timeout, BridgeErrorCode::Timeout),
            (ViewEngineErrorCode::Cancelled, BridgeErrorCode::Cancelled),
        ] {
            let (mut view, state) = execution();
            let (manifest, blobs) = fixture();
            let budget = ViewExecutionBudget::default();
            view.prepare_modules(&manifest, &blobs, &budget).unwrap();
            state.borrow_mut().render_error =
                Some(ViewEngineError::new(native_code, "stopped").with_stack("native-stack"));
            let error = view
                .render_documents(
                    &manifest,
                    &templates(&manifest, &blobs),
                    &tasks(&manifest),
                    &budget,
                )
                .unwrap_err();
            assert_eq!(error.code, bridge_code);
            assert!(error.message.contains(native_code.as_str()));
            assert!(error.message.contains("native-stack"));
            assert_eq!(
                view.release_scopes(&["page-one".into()], &budget)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Engine
            );
            assert!(state.borrow().releases.is_empty());
            assert_eq!(view.scope_leases.len(), 2);
        }
    }

    #[test]
    fn typed_view_interruption_revokes_old_frame_without_backgrounding_appservice() {
        use crate::{ExternalFrameRecoveryExpected, Session, SessionConfig};
        use container_core::{LifecycleEvent, LifecycleState, TimerKind};
        use container_render_skia::{PageRenderMode, Rect, RenderFrame, RenderNode, Renderer};

        let (mut view, state) = execution();
        let (mut manifest, blobs) = fixture();
        #[cfg(feature = "quickjs-native")]
        const APP_SOURCE: &str = "App({ticks:0,hides:0,onHide(){this.hides++}});setTimeout(()=>{getApp().ticks++},0);exports.inspect=()=>({ticks:getApp().ticks,hides:getApp().hides});";
        #[cfg(feature = "quickjs-native")]
        {
            manifest
                .modules
                .iter_mut()
                .find(|module| module.id == "module:app.js")
                .unwrap()
                .sha256 = container_ir::hex_digest(APP_SOURCE.as_bytes());
        }
        manifest.refresh_integrity().unwrap();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();

        let mut session = Session::new(
            manifest.clone(),
            SessionConfig {
                page_render_mode: PageRenderMode::ExternalFrame,
                host: crate::HostMetadata {
                    window_width: 375,
                    window_height: 667,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        session.prepare_engine_environment().unwrap();
        #[cfg(feature = "quickjs-native")]
        {
            session
                .load_modules_value(&json!([{"id":"module:app.js","source":APP_SOURCE}]))
                .unwrap();
            let app = session.loaded_modules["module:app.js"].module_id;
            assert_eq!(
                session
                    .call_engine(
                        container_core::CallTarget::Module {
                            id: app,
                            export: "inspect".into()
                        },
                        vec![]
                    )
                    .unwrap()[0],
                json!({"ticks":0,"hides":0})
            );
        }
        session.initialized = true;
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Launch)
            .unwrap();
        let route = "pages/home/index";
        let page = session.app_service.push_page(route).unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: session.config.host.window_width as f32,
            height: session.config.host.window_height as f32,
        };
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .commit(RenderFrame {
                frame_id: 1,
                viewport,
                root: RenderNode::new("root", viewport),
                images: Default::default(),
            })
            .unwrap();
        session.observer_frame_page = Some(page);
        session.observer_frame_valid = true;
        session.presented_revision = Some(1);
        session.view.last_frame_id = Some(1);
        session.record_last_frame_input(Some(crate::BrowserPageInput {
            page_id: page,
            route_path: route.into(),
            template_revision: session.view.template_revision,
            viewport,
        }));
        session.install_skia_frame_authority();
        assert!(session.is_current_frame_presented());
        let expected = ExternalFrameRecoveryExpected {
            session_id: session.config.session_id.clone(),
            page_id: page.0.to_string(),
            route_path: route.into(),
            viewport,
            renderer_profile: container_ir::RendererProfile::Skia,
            template_revision: session.view.template_revision.to_string(),
            render_revision: "1".into(),
            input_lifetime_revision: session.input_lifetime_revision.unwrap().to_string(),
        };
        let timer = session.app_service.schedule_timer(
            TimerKind::Timeout,
            10,
            0,
            Some("still-live".into()),
        );
        let lifecycle = session.app_service.lifecycle().state();
        let page_before = session.app_service.pages().current().unwrap().clone();

        state.borrow_mut().render_error = Some(
            ViewEngineError::new(
                ViewEngineErrorCode::Timeout,
                "deterministic interrupted frontier",
            )
            .with_stack("fixture.view.js:7"),
        );
        let error = view
            .render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget,
            )
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Timeout);
        session.view_execution.replace(view);

        let health = session.execution_health();
        assert!(health.requires_restart);
        assert!(health.app_service_fault.is_none());
        let fault = health.view_fault.unwrap();
        assert_eq!(fault.domain, crate::ExecutionFaultDomain::View);
        assert_eq!(fault.code, "ERR_TIMEOUT");
        assert_eq!(fault.stack.as_deref(), Some("fixture.view.js:7"));
        assert!(
            session.requires_dev_restart(),
            "even an unchanged pack must restart a poisoned View"
        );
        assert!(!session.is_current_frame_presented());
        assert!(session.last_frame_input(1).is_none());
        let request = container_bridge::BridgeEnvelope::event(
            session.config.session_id.clone(),
            container_bridge::op::EVENT_BATCH,
            json!({"events":[]}),
        );
        let events_before = session.view.event_count;
        assert_eq!(
            session.handle_event_batch(&request).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(session.view.event_count, events_before);
        assert!(session.acknowledge_presentation(1).is_err());
        assert!(session.recover_external_frame(&expected).is_err());
        // Late receipts, transport errors and cleanup cannot rewrite the cause.
        assert_eq!(session.execution_health().view_fault.unwrap(), fault);

        session.ended_touch_contacts.push_back(99);
        let lifetime = session.input_lifetime_revision;
        assert!(session.retire_faulted_view_authority());
        assert!(!session.retire_faulted_view_authority());
        assert_eq!(
            session.input_lifetime_revision,
            lifetime.and_then(|value| value.checked_add(1))
        );
        assert!(session.ended_touch_contacts.is_empty());
        assert!(!session.observer_frame_valid);
        assert!(session.presented_revision.is_none());
        assert!(
            session.renderer().last_frame().is_some(),
            "diagnostic pixels/scene remain available"
        );
        assert_eq!(
            session.app_service.lifecycle().state(),
            LifecycleState::Active
        );
        assert_eq!(session.app_service.lifecycle().state(), lifecycle);
        assert_eq!(session.app_service.pages().current(), Some(&page_before));
        let now_ns = u64::try_from(
            crate::SystemTime::now()
                .duration_since(crate::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        )
        .unwrap();
        let timers = session.poll_timers(now_ns.saturating_add(10_000_000));
        assert!(
            timers.messages.iter().any(|message| message
                .payload
                .get("type")
                .and_then(serde_json::Value::as_str)
                == Some("timer")),
            "healthy AppService scheduling must continue: {timers:?}"
        );
        assert!(!session.app_service.cancel_timer(timer));
        #[cfg(feature = "quickjs-native")]
        {
            let app = session.loaded_modules["module:app.js"].module_id;
            assert_eq!(
                session
                    .call_engine(
                        container_core::CallTarget::Module {
                            id: app,
                            export: "inspect".into()
                        },
                        vec![]
                    )
                    .unwrap()[0],
                json!({"ticks":1,"hides":0}),
                "real AppService timer remains live and no onHide is synthesized"
            );
        }
    }

    #[test]
    fn final_poisoned_retirement_disposes_both_profiles_without_guest_release_or_fault_rewrite() {
        for kind in [EngineKind::Quickjs, EngineKind::V8] {
            let (mut view, legacy) = execution();
            view.engine_kind = kind;
            let (manifest, blobs) = fixture();
            let budget = ViewExecutionBudget::default();
            view.prepare_modules(&manifest, &blobs, &budget).unwrap();
            view.render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget,
            )
            .unwrap();
            let modern = attach_modern_mock(&mut view);
            assert!(!view.retire_poisoned(), "healthy ownership needs an ACK");
            assert!(!view.scope_leases.is_empty());
            assert_eq!(legacy.borrow().disposals, 0);
            assert_eq!(modern.borrow().disposals, 0);
            legacy.borrow_mut().render_error = Some(
                ViewEngineError::new(ViewEngineErrorCode::Timeout, "old View interrupted")
                    .with_stack("retired.view.js:7"),
            );
            assert!(view
                .render_documents(
                    &manifest,
                    &templates(&manifest, &blobs),
                    &tasks(&manifest),
                    &budget,
                )
                .is_err());
            let fault = view.fault();
            let witness = view.first_fault.clone();
            let metrics = view.metrics();
            let operations = view.operation_sequence;
            let renders = legacy.borrow().renders.len();
            assert!(witness.is_some());
            assert!(view.retire_poisoned());
            assert!(view.retire_poisoned(), "final invalidation is idempotent");
            assert!(view.engine.is_none());
            assert!(view.modern_engine.is_none());
            assert!(view.scope_leases.is_empty());
            assert!(view.compiled_documents.is_empty());
            assert!(view.registered_documents.iter().all(Option::is_none));
            assert_eq!(view.fault(), fault);
            assert_eq!(view.first_fault, witness);
            assert_eq!(view.metrics(), metrics);
            assert_eq!(view.operation_sequence, operations);
            assert!(
                view.release_scopes(&["page-one".into()], &budget).is_err(),
                "ordinary cleanup still refuses a poisoned realm"
            );
            assert!(legacy.borrow().releases.is_empty());
            assert!(modern.borrow().releases.is_empty());
            assert_eq!(legacy.borrow().renders.len(), renders);
            drop(view);
            assert_eq!(legacy.borrow().disposals, 1);
            assert_eq!(modern.borrow().disposals, 1);
        }
    }

    #[test]
    fn final_retirement_of_a_healthy_view_still_requires_a_complete_release_ack() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(
            &manifest,
            &templates(&manifest, &blobs),
            &tasks(&manifest),
            &budget,
        )
        .unwrap();
        state.borrow_mut().release_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::InvalidBatch,
            "healthy final release omitted its ACK",
        ));
        let mut manifest = manifest;
        manifest.refresh_integrity().unwrap();
        let mut session = crate::Session::new(manifest, crate::SessionConfig::default()).unwrap();
        session.view_execution.replace(view);
        let error = session
            .retire_page_components(container_core::PageId(1))
            .unwrap_err();
        assert!(error
            .message
            .contains("healthy final release omitted its ACK"));
        assert_eq!(state.borrow().releases, vec![vec!["page:1".to_owned()]]);
        assert_eq!(state.borrow().disposals, 0);
        assert_eq!(session.view_execution.borrow().scope_leases.len(), 2);
        assert!(session.view_execution_is_faulted());
        drop(session);
        assert_eq!(state.borrow().disposals, 1);
    }

    #[test]
    fn cleanup_failure_retains_every_lease_and_blocks_further_turns() {
        let (mut view, state) = execution();
        let (manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        view.render_documents(
            &manifest,
            &templates(&manifest, &blobs),
            &tasks(&manifest),
            &budget,
        )
        .unwrap();
        state.borrow_mut().release_error = Some(ViewEngineError::new(
            ViewEngineErrorCode::Execution,
            "partial cleanup is unacknowledged",
        ));
        assert!(view
            .release_scopes(&["page-one".into(), "page-two".into()], &budget)
            .is_err());
        assert_eq!(view.scope_leases.len(), 2);
        assert!(view.prepare_modules(&manifest, &blobs, &budget).is_err());
        assert_eq!(state.borrow().loads, 1);
        drop(view);
        assert_eq!(state.borrow().disposals, 1);
    }

    #[test]
    fn unavailable_native_view_never_renders_or_substitutes_an_engine() {
        let mut view = ViewExecution {
            engine: None,
            modern_engine: None,
            pending_empty_legacy: false,
            provider_factory: None,
            engine_kind: EngineKind::Quickjs,
            provider_available: false,
            source_maps: Default::default(),
            module_digest: None,
            compiled_documents: BTreeMap::new(),
            scope_leases: BTreeSet::new(),
            poisoned: None,
            first_fault: None,
            operation_sequence: 0,
            created_at: Instant::now(),
            fault_authority_retired: false,
            verified_program: None,
            encoded_documents: None,
            registered_documents: [None, None],
            metrics: ViewExecutionMetrics::default(),
        };
        let (mut manifest, blobs) = fixture();
        let budget = ViewExecutionBudget::default();
        assert!(!view.is_available());
        assert_eq!(
            view.prepare_modules(&manifest, &blobs, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Engine
        );
        manifest.view_scripts.clear();
        for template in &mut manifest.templates {
            template.wxs_modules.clear();
        }
        view.prepare_modules(&manifest, &blobs, &budget).unwrap();
        assert_eq!(
            view.render_documents(
                &manifest,
                &templates(&manifest, &blobs),
                &tasks(&manifest),
                &budget
            )
            .unwrap_err()
            .code,
            BridgeErrorCode::Engine
        );
    }

    #[cfg(not(feature = "v8-native"))]
    #[test]
    fn v8_without_native_feature_fails_during_construction() {
        assert_eq!(
            ViewExecution::new(EngineKind::V8).unwrap_err().code,
            ViewEngineErrorCode::Unavailable
        );
    }

    #[test]
    fn drop_always_disposes_the_owned_provider() {
        let (view, state) = execution();
        drop(view);
        assert_eq!(state.borrow().disposals, 1);
    }
}

#[cfg(test)]
#[path = "view_lazy_tests.rs"]
mod lazy_provider_tests;

#[cfg(test)]
#[path = "view_first_fault_tests.rs"]
mod first_fault_tests;
