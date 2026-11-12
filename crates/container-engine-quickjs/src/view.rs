//! Isolated, synchronous View execution. This module owns its own QuickJS
//! runtime and installs neither AppService globals nor a host bridge.

use super::QuickJsConfig;
#[cfg(all(
    feature = "quickjs-native",
    not(all(target_arch = "wasm32", target_os = "unknown"))
))]
use std::time::Instant;
#[cfg(all(
    feature = "quickjs-native",
    target_arch = "wasm32",
    target_os = "unknown"
))]
use web_time::Instant;

use container_core::{
    ViewDocumentHandle, ViewDocumentProgram, ViewEngine, ViewEngineError, ViewEngineErrorCode,
    ViewEngineTimings, ViewExecutionBudget, ViewExpressionResult, ViewExpressionTask,
    ViewModuleSource, ViewRenderBatch, ViewRenderResult, ViewRenderTask,
};

#[derive(Debug)]
pub struct QuickJsViewEngine {
    config: QuickJsConfig,
    last_timings: Option<ViewEngineTimings>,
    #[cfg(feature = "quickjs-native")]
    documents: container_core::ViewDocumentRegistry,
    #[cfg(feature = "quickjs-native")]
    native: Option<NativeView>,
    #[cfg(feature = "quickjs-native")]
    modern: bool,
}

impl QuickJsViewEngine {
    /// Construction fails explicitly when the native backend is unavailable.
    pub fn new(config: QuickJsConfig) -> Result<Self, ViewEngineError> {
        Self::with_profile(config, false)
    }

    /// Create an independent synchronous ECMAScript View realm. Standard
    /// intrinsics remain mutable; transport operations are privately captured.
    pub fn new_modern(config: QuickJsConfig) -> Result<Self, ViewEngineError> {
        Self::with_profile(config, true)
    }

    fn with_profile(config: QuickJsConfig, modern: bool) -> Result<Self, ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            let native = NativeView::new(&config, modern)?;
            Ok(Self {
                config,
                last_timings: None,
                documents: container_core::ViewDocumentRegistry::default(),
                native: Some(native),
                modern,
            })
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (config, modern);
            Err(unavailable())
        }
    }

    pub fn config(&self) -> &QuickJsConfig {
        &self.config
    }

    #[cfg(feature = "quickjs-native")]
    fn execute_batch<T>(
        &mut self,
        entrypoint: &str,
        budget: &ViewExecutionBudget,
        encode: impl FnOnce() -> Result<String, serde_json::Error>,
        decode: impl FnOnce(serde_json::Value) -> Result<T, ViewEngineError>,
    ) -> Result<T, ViewEngineError> {
        self.last_timings = None;
        // Keep the original deadline origin before optional diagnostic work.
        let started = Instant::now();
        let probe = container_core::view_probe::ViewBatchProbe::begin(
            container_core::view_probe::ViewProbeEngine::Quickjs,
            self.modern,
            entrypoint,
        );
        let mut phases = container_core::view_probe::ViewBatchPhaseSamples::default();
        let result =
            self.execute_batch_inner(entrypoint, budget, started, encode, decode, &mut phases);
        let diagnostic = probe.finish(result.as_ref().err().map(|error| error.code));
        if let Some(timings) = self.last_timings.as_mut() {
            timings.last_batch_breakdown = diagnostic
                .as_ref()
                .map(|batch| phases.into_breakdown(batch));
            timings.last_batch = diagnostic;
        } else if diagnostic.is_some() {
            // Preserve historical None on early returns when observation is
            // disabled/unavailable; only a real probe adds an early receipt.
            self.last_timings = Some(ViewEngineTimings {
                batches: 1,
                elapsed_ns: timing_ns(started),
                last_batch_breakdown: diagnostic
                    .as_ref()
                    .map(|batch| phases.into_breakdown(batch)),
                last_batch: diagnostic,
                ..ViewEngineTimings::default()
            });
        }
        result
    }

    #[cfg(feature = "quickjs-native")]
    fn execute_batch_inner<T>(
        &mut self,
        entrypoint: &str,
        budget: &ViewExecutionBudget,
        started: Instant,
        encode: impl FnOnce() -> Result<String, serde_json::Error>,
        decode: impl FnOnce(serde_json::Value) -> Result<T, ViewEngineError>,
        phases: &mut container_core::view_probe::ViewBatchPhaseSamples,
    ) -> Result<T, ViewEngineError> {
        let mut timings = ViewEngineTimings {
            batches: 1,
            ..ViewEngineTimings::default()
        };
        let native = self.native.as_ref().ok_or_else(requires_reset)?;
        let deadline = started.checked_add(budget.timeout).ok_or_else(|| {
            ViewEngineError::new(
                ViewEngineErrorCode::InvalidBatch,
                "QuickJS View execution budget is out of range",
            )
        })?;
        native.arm(deadline, &budget.cancellation);
        // Keep the same deadline armed for both transport directions,
        // compilation, require, evaluation, error getters and result decoding.
        let result = (|| {
            if let Some(reason) = native.interruption() {
                return Err(reason.error());
            }
            let stage = Instant::now();
            let encoded = encode();
            timings.input_encode_ns = timing_ns(stage);
            let input = encoded.map_err(|error| {
                let error = ViewEngineError::new(
                    ViewEngineErrorCode::InvalidBatch,
                    format!("QuickJS View batch could not be encoded: {error}"),
                );
                if entrypoint == "__weappContainer_view_register_documents" {
                    error.document_program_rejected()
                } else {
                    error
                }
            })?;
            timings.input_bytes = input.len() as u64;
            timings.document_registrations =
                u64::from(entrypoint == "__weappContainer_view_register_documents");
            timings.registered_render_batches =
                u64::from(entrypoint == "__weappContainer_view_render_registered");
            if let Some(reason) = native.interruption() {
                return Err(reason.error());
            }
            let output =
                native.call_entrypoint(entrypoint, &input, self.modern, &mut timings, phases)?;
            let stage = Instant::now();
            let decoded = (|| {
                let reply: serde_json::Value = serde_json::from_str(&output).map_err(|error| {
                    ViewEngineError::new(
                        ViewEngineErrorCode::Execution,
                        format!("QuickJS View returned invalid JSON: {error}"),
                    )
                })?;
                match reply.get("ok").and_then(serde_json::Value::as_bool) {
                    Some(true) => decode(reply),
                    Some(false) => {
                        let error = ViewEngineError::from_wire(&reply["error"]);
                        Err(
                            if entrypoint == "__weappContainer_view_register_documents"
                                && reply
                                    .get("documentProgramRejected")
                                    .and_then(serde_json::Value::as_bool)
                                    == Some(true)
                            {
                                error.document_program_rejected()
                            } else {
                                error
                            },
                        )
                    }
                    None => Err(ViewEngineError::new(
                        ViewEngineErrorCode::Execution,
                        "QuickJS View returned an invalid batch envelope",
                    )),
                }
            })();
            timings.output_decode_ns = timing_ns(stage);
            decoded
        })();
        timings.elapsed_ns = timing_ns(started);
        self.last_timings = Some(timings);
        let phase = container_core::view_probe::ViewPhaseProbe::begin();
        let interruption = native.finish();
        phases.final_deadline_check = phase.finish(true);
        if let Some(reason) = interruption {
            // Interrupted execution can leave partially initialized modules
            // and mutated globals. No operation may reuse that realm.
            let phase = container_core::view_probe::ViewPhaseProbe::begin();
            self.native = None;
            phases.poison_drop = phase.finish(true);
            Err(reason.error())
        } else {
            result
        }
    }
}

impl ViewEngine for QuickJsViewEngine {
    fn last_timings(&self) -> Option<ViewEngineTimings> {
        self.last_timings.clone()
    }
    fn load_modules(
        &mut self,
        modules: &[ViewModuleSource],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            let result = self.execute_batch(
                "__weappContainer_view_load",
                budget,
                || serde_json::to_string(modules),
                |_| Ok(()),
            );
            if result.is_ok() {
                self.documents.invalidate();
            }
            result
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (modules, budget);
            Err(unavailable())
        }
    }

    fn evaluate_batch(
        &mut self,
        tasks: &[ViewExpressionTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewExpressionResult>, ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.execute_batch(
                "__weappContainer_view_evaluate",
                budget,
                || serde_json::to_string(tasks),
                |reply| {
                    let results: Vec<ViewExpressionResult> =
                        serde_json::from_value(reply["results"].clone()).map_err(|error| {
                            ViewEngineError::new(
                                ViewEngineErrorCode::Execution,
                                format!("QuickJS View returned an invalid result batch: {error}"),
                            )
                        })?;
                    if results.len() != tasks.len()
                        || results
                            .iter()
                            .zip(tasks)
                            .any(|(result, task)| result.task_id != task.task_id)
                    {
                        return Err(ViewEngineError::new(
                            ViewEngineErrorCode::InvalidBatch,
                            "QuickJS View result batch does not match the submitted task order",
                        ));
                    }
                    Ok(results)
                },
            )
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (tasks, budget);
            Err(unavailable())
        }
    }

    fn render_batch(
        &mut self,
        batch: &ViewRenderBatch,
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.execute_batch(
                "__weappContainer_view_render",
                budget,
                || serde_json::to_string(batch),
                |reply| {
                    let results: Vec<ViewRenderResult> =
                        serde_json::from_value(reply["results"].clone()).map_err(|error| {
                            ViewEngineError::new(
                                ViewEngineErrorCode::Execution,
                                format!("QuickJS View returned an invalid render batch: {error}"),
                            )
                        })?;
                    let mut ids = std::collections::BTreeSet::new();
                    if results.len() != batch.tasks.len()
                        || results.iter().zip(&batch.tasks).any(|(result, task)| {
                            result.task_id != task.task_id
                                || !ids.insert(&result.task_id)
                                || !result.ast.is_object()
                        })
                    {
                        return Err(ViewEngineError::new(
                            ViewEngineErrorCode::InvalidBatch,
                            "QuickJS View render batch does not match the submitted task order or AST shape",
                        ));
                    }
                    let documents = batch.documents.iter()
                        .map(|document| document.document_id.clone())
                        .collect::<std::collections::BTreeSet<_>>();
                    for result in &results {
                        container_core::validate_view_render_provenance(&result.ast, &documents)?;
                    }
                    Ok(results)
                },
            )
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (batch, budget);
            Err(unavailable())
        }
    }

    fn register_documents(
        &mut self,
        program: &ViewDocumentProgram,
        budget: &ViewExecutionBudget,
    ) -> Result<ViewDocumentHandle, ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.last_timings = None;
            if self.native.is_none() {
                return Err(requires_reset());
            }
            let key = self.documents.reserve_key()?;
            let result = self.execute_batch(
                "__weappContainer_view_register_documents",
                budget,
                || {
                    container_core::encode_view_document_registration(
                        container_core::ViewDocumentRegistration {
                            program_id: &key,
                            documents: program.documents(),
                        },
                    )
                },
                |reply| {
                    if reply.get("programId").and_then(serde_json::Value::as_str)
                        != Some(key.as_str())
                    {
                        return Err(ViewEngineError::new(
                            ViewEngineErrorCode::RequiresReset,
                            "View document registration receipt identity mismatch",
                        ));
                    }
                    Ok(())
                },
            );
            if let Err(error) = result {
                if !error.is_document_program_rejection() {
                    self.native = None;
                    self.documents.invalidate();
                }
                return Err(error);
            }
            Ok(self.documents.publish(key, program.documents()))
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (program, budget);
            Err(unavailable())
        }
    }

    fn render_registered_batch(
        &mut self,
        handle: &ViewDocumentHandle,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.last_timings = None;
            if self.native.is_none() {
                return Err(requires_reset());
            }
            let key = self.documents.key(handle)?;
            self.execute_batch(
                "__weappContainer_view_render_registered",
                budget,
                || {
                    serde_json::to_string(&container_core::ViewRegisteredRenderBatch {
                        program_id: &key,
                        tasks,
                    })
                },
                |reply| {
                    let results: Vec<ViewRenderResult> =
                        serde_json::from_value(reply["results"].clone()).map_err(|_| {
                            ViewEngineError::new(
                                ViewEngineErrorCode::Execution,
                                "View returned an invalid registered render receipt",
                            )
                        })?;
                    let mut ids = std::collections::BTreeSet::new();
                    if results.len() != tasks.len()
                        || results.iter().zip(tasks).any(|(result, task)| {
                            result.task_id != task.task_id
                                || !ids.insert(&result.task_id)
                                || !result.ast.is_object()
                        })
                    {
                        return Err(ViewEngineError::new(
                            ViewEngineErrorCode::InvalidBatch,
                            "View registered render receipt task order or AST shape mismatch",
                        ));
                    }
                    for result in &results {
                        container_core::validate_view_render_provenance(
                            &result.ast,
                            handle.document_ids(),
                        )?;
                    }
                    Ok(results)
                },
            )
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (handle, tasks, budget);
            Err(unavailable())
        }
    }

    fn release_scopes(
        &mut self,
        scopes: &[String],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.execute_batch(
                "__weappContainer_view_release_scopes",
                budget,
                || serde_json::to_string(scopes),
                |_| Ok(()),
            )
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            let _ = (scopes, budget);
            Err(unavailable())
        }
    }

    fn reset(&mut self) -> Result<(), ViewEngineError> {
        #[cfg(feature = "quickjs-native")]
        {
            self.last_timings = None;
            self.documents.invalidate();
            self.native = None;
            self.native = Some(NativeView::new(&self.config, self.modern)?);
            Ok(())
        }
        #[cfg(not(feature = "quickjs-native"))]
        {
            Err(unavailable())
        }
    }

    fn dispose(&mut self) {
        #[cfg(feature = "quickjs-native")]
        {
            self.native = None;
            self.documents.invalidate();
        }
    }
}

#[cfg(not(feature = "quickjs-native"))]
fn unavailable() -> ViewEngineError {
    ViewEngineError::new(
        ViewEngineErrorCode::Unavailable,
        "QuickJS View requires the quickjs-native feature; no fallback is available",
    )
}

#[cfg(feature = "quickjs-native")]
fn requires_reset() -> ViewEngineError {
    ViewEngineError::new(
        ViewEngineErrorCode::RequiresReset,
        "QuickJS View realm was disposed or interrupted; call reset before reusing it",
    )
}

#[cfg(feature = "quickjs-native")]
fn timing_ns(started: Instant) -> u64 {
    started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

#[cfg(feature = "quickjs-native")]
struct NativeView {
    // Context must be released before the Runtime that owns its jobs and heap.
    context: rquickjs::Context,
    _runtime: rquickjs::Runtime,
    turn: std::sync::Arc<std::sync::Mutex<TurnState>>,
}

#[cfg(feature = "quickjs-native")]
impl std::fmt::Debug for NativeView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("NativeView").finish_non_exhaustive()
    }
}

#[cfg(feature = "quickjs-native")]
#[derive(Default)]
struct TurnState {
    deadline: Option<Instant>,
    cancellation: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    interrupted: Option<Interruption>,
}

#[cfg(feature = "quickjs-native")]
#[derive(Clone, Copy)]
enum Interruption {
    Timeout,
    Cancelled,
}

#[cfg(feature = "quickjs-native")]
impl Interruption {
    fn error(self) -> ViewEngineError {
        match self {
            Self::Timeout => ViewEngineError::new(
                ViewEngineErrorCode::Timeout,
                "QuickJS View execution exceeded its monotonic deadline",
            ),
            Self::Cancelled => ViewEngineError::new(
                ViewEngineErrorCode::Cancelled,
                "QuickJS View execution was cancelled",
            ),
        }
    }
}

#[cfg(feature = "quickjs-native")]
impl TurnState {
    fn check(&mut self) -> Option<Interruption> {
        if self.interrupted.is_none() {
            if self
                .cancellation
                .as_ref()
                .is_some_and(|flag| flag.load(std::sync::atomic::Ordering::Acquire))
            {
                self.interrupted = Some(Interruption::Cancelled);
            } else if self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            {
                self.interrupted = Some(Interruption::Timeout);
            }
        }
        self.interrupted
    }
}

// Only the trusted modern bootstrap captures this compiler. Its temporary
// global is deleted before untrusted unit execution; compilation happens within
// the same armed batch deadline and does not expose a host provider or IO.
#[cfg(feature = "quickjs-native")]
fn compile_modern_factory<'js>(
    ctx: rquickjs::Ctx<'js>,
    source: String,
    filename: String,
) -> rquickjs::Result<rquickjs::Function<'js>> {
    let mut options = rquickjs::context::EvalOptions::default();
    options.strict = false;
    options.filename = Some(filename);
    ctx.eval_with_options(source, options)
}

#[cfg(feature = "quickjs-native")]
impl NativeView {
    fn new(config: &QuickJsConfig, modern: bool) -> Result<Self, ViewEngineError> {
        let runtime = rquickjs::Runtime::new().map_err(|error| {
            ViewEngineError::new(
                ViewEngineErrorCode::Unavailable,
                format!("QuickJS View runtime could not be created: {error}"),
            )
        })?;
        if let Some(limit) = config.memory_limit_bytes {
            runtime.set_memory_limit(limit);
        }
        if let Some(limit) = config.max_stack_bytes {
            runtime.set_max_stack_size(limit);
        }
        let turn = std::sync::Arc::new(std::sync::Mutex::new(TurnState::default()));
        let interrupt_turn = std::sync::Arc::clone(&turn);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupt_turn
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .check()
                .is_some()
        })));
        let context = rquickjs::Context::full(&runtime).map_err(|error| {
            ViewEngineError::new(
                ViewEngineErrorCode::Unavailable,
                format!("QuickJS View context could not be created: {error}"),
            )
        })?;
        let native = Self {
            context,
            _runtime: runtime,
            turn,
        };
        native.context.with(|ctx| {
            if modern {
                let compiler = rquickjs::Function::new(ctx.clone(), compile_modern_factory)
                    .map_err(|error| native.native_error(&ctx, error))?;
                ctx.globals()
                    .set("__weappContainer_compileModernFactory", compiler)
                    .map_err(|error| native.native_error(&ctx, error))?;
            }
            ctx.eval::<(), _>(if modern {
                container_core::MODERN_VIEW_SCRIPT_BOOTSTRAP
            } else {
                container_core::VIEW_SCRIPT_BOOTSTRAP
            })
            .map_err(|error| native.native_error(&ctx, error))
        })?;
        Ok(native)
    }

    fn arm(&self, deadline: Instant, cancellation: &std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let mut turn = self.turn.lock().unwrap_or_else(|error| error.into_inner());
        *turn = TurnState {
            deadline: Some(deadline),
            cancellation: Some(std::sync::Arc::clone(cancellation)),
            interrupted: None,
        };
    }

    fn interruption(&self) -> Option<Interruption> {
        self.turn
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .check()
    }

    fn finish(&self) -> Option<Interruption> {
        let mut turn = self.turn.lock().unwrap_or_else(|error| error.into_inner());
        let interruption = turn.check();
        turn.deadline = None;
        turn.cancellation = None;
        interruption
    }

    fn call_entrypoint(
        &self,
        name: &str,
        input: &str,
        modern: bool,
        timings: &mut ViewEngineTimings,
        phases: &mut container_core::view_probe::ViewBatchPhaseSamples,
    ) -> Result<String, ViewEngineError> {
        let phase = container_core::view_probe::ViewPhaseProbe::begin();
        let reply = self.context.with(|ctx| {
            let mut call = || -> rquickjs::Result<String> {
                let stage = Instant::now();
                let parsed = (|| -> rquickjs::Result<_> {
                    Ok((
                        ctx.json_parse(input)?,
                        ctx.globals().get::<_, rquickjs::Function>(name)?,
                    ))
                })();
                timings.vm_input_parse_ns = timing_ns(stage);
                let (input, function) = parsed?;
                let stage = Instant::now();
                let executed = function.call::<_, rquickjs::Value>((input,));
                timings.execute_including_lazy_compile_ns = timing_ns(stage);
                let result = executed?;
                let stage = Instant::now();
                let encoded = (|| {
                    if modern {
                        // Modern's private writer is measured in execution.
                        let phase = container_core::view_probe::ViewPhaseProbe::begin();
                        let encoded = result
                            .as_string()
                            .ok_or_else(|| {
                                rquickjs::Error::new_into_js_message(
                                    "modern View reply",
                                    "JSON string",
                                    "non-string reply envelope",
                                )
                            })
                            .and_then(|output| output.to_string());
                        phases.utf8_copy_api = phase.finish(encoded.is_ok());
                        return encoded;
                    }
                    // Includes the wrapper's input Value drop. Keep the
                    // existing ownership/lifetime; do not call this pure C time.
                    let phase = container_core::view_probe::ViewPhaseProbe::begin();
                    let output = ctx.json_stringify(result).and_then(|output| {
                        output.ok_or_else(|| {
                            rquickjs::Error::new_into_js_message(
                                "View batch result",
                                "JSON string",
                                "undefined result envelope",
                            )
                        })
                    });
                    phases.json_stringify_api = phase.finish(output.is_ok());
                    let output = output?;
                    let phase = container_core::view_probe::ViewPhaseProbe::begin();
                    let encoded = output.to_string();
                    phases.utf8_copy_api = phase.finish(encoded.is_ok());
                    encoded
                })();
                timings.vm_output_encode_ns = timing_ns(stage);
                phases.output_bytes = encoded.as_ref().ok().map(|output| output.len() as u64);
                encoded
            };
            call().map_err(|error| self.native_error(&ctx, error))
        });
        phases.context_call = phase.finish(reply.is_ok());
        reply
    }

    fn native_error(&self, ctx: &rquickjs::Ctx<'_>, error: rquickjs::Error) -> ViewEngineError {
        if let Some(interruption) = self.interruption() {
            // Clear the thrown value without reading user-controlled getters
            // after an interrupt; the entire realm is about to be discarded.
            if matches!(error, rquickjs::Error::Exception) {
                let _ = ctx.catch();
            }
            return interruption.error();
        }
        match rquickjs::CaughtError::from_error(ctx, error) {
            rquickjs::CaughtError::Exception(error) => {
                let message = error
                    .message()
                    .unwrap_or_else(|| "QuickJS View execution failed".into());
                if let Some(interruption) = self.interruption() {
                    let _ = ctx.catch();
                    return interruption.error();
                }
                let stack = error.stack();
                // Error getters are allowed to throw. Clear that secondary
                // exception before this realm accepts another ordinary turn.
                let _ = ctx.catch();
                if let Some(interruption) = self.interruption() {
                    return interruption.error();
                }
                let mut result = ViewEngineError::new(ViewEngineErrorCode::Execution, message);
                if let Some(stack) = stack {
                    result = result.with_stack(stack);
                }
                result
            }
            error => ViewEngineError::new(
                ViewEngineErrorCode::Execution,
                format!("QuickJS View execution failed: {error}"),
            ),
        }
    }
}

#[cfg(all(test, not(feature = "quickjs-native")))]
mod tests {
    use super::*;

    #[test]
    fn view_never_falls_back_without_native_feature() {
        let error = QuickJsViewEngine::new(QuickJsConfig::default()).unwrap_err();
        assert_eq!(error.code, ViewEngineErrorCode::Unavailable);
    }
}

#[cfg(all(test, feature = "quickjs-native"))]
mod native_tests {
    use super::*;
    use container_core::{CallTarget, JsEngine, ViewValue};
    use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};

    fn engine() -> QuickJsViewEngine {
        QuickJsViewEngine::new(QuickJsConfig::default()).expect("isolated native View")
    }

    mod render_contract {
        include!("../../container-core/tests/support/view_render.rs");
        view_render_contract_tests!(super::engine());
    }

    fn module(id: &str, source: &str, dependencies: &[&str]) -> ViewModuleSource {
        ViewModuleSource {
            compilation: None,
            id: id.into(),
            source: source.into(),
            dependencies: dependencies.iter().map(|id| (*id).into()).collect(),
        }
    }

    fn task(id: &str, scope: &str, expression: &str) -> ViewExpressionTask {
        ViewExpressionTask {
            task_id: id.into(),
            scope_id: scope.into(),
            document_id: "pages/index.wxml".into(),
            expression: expression.into(),
            data: serde_json::json!({}),
            bindings: BTreeMap::new(),
        }
    }

    fn bound_task(id: &str, scope: &str, expression: &str, target: &str) -> ViewExpressionTask {
        ViewExpressionTask {
            bindings: BTreeMap::from([("tools".into(), target.into())]),
            ..task(id, scope, expression)
        }
    }

    fn evaluate(engine: &mut QuickJsViewEngine, expression: &str) -> ViewValue {
        engine
            .evaluate_batch(
                &[task("result", "constant:page", expression)],
                &ViewExecutionBudget::default(),
            )
            .expect("View expression succeeds")
            .remove(0)
            .value
    }

    fn breakdown_fixture(view: &QuickJsViewEngine, source: &str) {
        view.native
            .as_ref()
            .unwrap()
            .context
            .with(|ctx| ctx.eval::<(), _>(source))
            .unwrap();
    }

    #[test]
    fn native_output_breakdown_counts_actual_unicode_bytes_and_preserves_aggregate() {
        let mut view = engine();
        breakdown_fixture(
            &view,
            "globalThis.__breakdownFixture=function(){return {ok:true,value:'中文'}}",
        );
        view.execute_batch(
            "__breakdownFixture",
            &ViewExecutionBudget::default(),
            || Ok("null".into()),
            |_| Ok(()),
        )
        .unwrap();
        let stages = view.last_timings().unwrap();
        if container_core::view_probe::VIEW_BATCH_DIAGNOSTICS_AVAILABLE {
            let detail = stages.last_batch_breakdown.unwrap();
            assert_eq!(detail.phases.output_bytes.as_deref(), Some("28"));
            assert!(detail.phases.json_stringify_api.unwrap().completed);
            assert!(detail.phases.utf8_copy_api.unwrap().completed);
            assert!(detail.phases.context_call.unwrap().completed);
            assert!(detail.phases.final_deadline_check.unwrap().completed);
            assert!(detail.phases.poison_drop.is_none());
        } else {
            assert!(stages.last_batch_breakdown.is_none());
        }
        assert!(view.native.is_some());
    }

    #[test]
    fn failed_stringify_records_attempt_without_inventing_bytes_or_utf8_work() {
        let mut view = engine();
        breakdown_fixture(&view, "globalThis.__breakdownFixture=function(){return {get value(){throw new Error('stringify fixture')}}}");
        let error = view
            .execute_batch(
                "__breakdownFixture",
                &ViewExecutionBudget::default(),
                || Ok("null".into()),
                |_| Ok(()),
            )
            .unwrap_err();
        assert_eq!(error.code, ViewEngineErrorCode::Execution);
        assert!(view.native.is_some());
        if container_core::view_probe::VIEW_BATCH_DIAGNOSTICS_AVAILABLE {
            let detail = view.last_timings().unwrap().last_batch_breakdown.unwrap();
            assert!(!detail.phases.json_stringify_api.unwrap().completed);
            assert!(detail.phases.utf8_copy_api.is_none());
            assert!(detail.phases.output_bytes.is_none());
            assert!(!detail.phases.context_call.unwrap().completed);
            assert!(detail.phases.final_deadline_check.is_some());
            assert!(detail.phases.poison_drop.is_none());
        }
    }

    #[test]
    fn cancellation_records_final_check_and_poison_cleanup_without_entering_vm() {
        let mut view = engine();
        let budget = ViewExecutionBudget::default();
        budget
            .cancellation
            .store(true, std::sync::atomic::Ordering::Release);
        let error = view
            .execute_batch(
                "__breakdownFixture",
                &budget,
                || Ok("null".into()),
                |_| Ok(()),
            )
            .unwrap_err();
        assert_eq!(error.code, ViewEngineErrorCode::Cancelled);
        assert!(view.native.is_none());
        if container_core::view_probe::VIEW_BATCH_DIAGNOSTICS_AVAILABLE {
            let detail = view.last_timings().unwrap().last_batch_breakdown.unwrap();
            assert!(detail.phases.final_deadline_check.unwrap().completed);
            assert!(detail.phases.poison_drop.unwrap().completed);
            assert!(detail.phases.context_call.is_none());
            assert!(detail.phases.output_bytes.is_none());
        }
    }

    #[test]
    fn modern_output_breakdown_never_claims_a_native_json_writer() {
        let mut view = QuickJsViewEngine::new_modern(QuickJsConfig::default()).unwrap();
        breakdown_fixture(
            &view,
            "globalThis.__breakdownFixture=function(){return '{\"ok\":true}'}",
        );
        view.execute_batch(
            "__breakdownFixture",
            &ViewExecutionBudget::default(),
            || Ok("null".into()),
            |_| Ok(()),
        )
        .unwrap();
        if container_core::view_probe::VIEW_BATCH_DIAGNOSTICS_AVAILABLE {
            let detail = view.last_timings().unwrap().last_batch_breakdown.unwrap();
            assert!(detail.modern);
            assert!(detail.phases.json_stringify_api.is_none());
            assert!(detail.phases.utf8_copy_api.unwrap().completed);
            assert_eq!(detail.phases.output_bytes.as_deref(), Some("11"));
        }
    }

    #[test]
    fn view_has_no_appservice_globals_or_host_bindings() {
        let mut view = engine();
        view.load_modules(
            &[module(
                "wxs:globals.wxs",
                "exports.inspect=function(){return [typeof wx,typeof App,typeof Page,typeof Component,typeof getApp,typeof getCurrentPages,typeof setTimeout,typeof setInterval,typeof __container_storage]}",
                &[],
            )],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        let result = view
            .evaluate_batch(
                &[bound_task(
                    "globals",
                    "page:1",
                    "tools.inspect()",
                    "wxs:globals.wxs",
                )],
                &ViewExecutionBudget::default(),
            )
            .unwrap();
        assert_eq!(
            result[0].value,
            ViewValue::Array(vec![ViewValue::String("undefined".into()); 9])
        );
    }

    #[test]
    fn modules_require_declared_dependencies_and_cache_per_scope() {
        let mut view = engine();
        view.load_modules(
            &[
                module(
                    "wxs:a.wxs",
                    "exports.before=7;var b=require('./b.wxs');var n=0;module.exports={next:function(){return ++n+b.value},cycle:b.cycle}",
                    &["wxs:b.wxs"],
                ),
                module(
                    "wxs:b.wxs",
                    "exports.value=10;exports.cycle=require('./a.wxs').before",
                    &["wxs:a.wxs"],
                ),
            ],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        let results = view
            .evaluate_batch(
                &[
                    bound_task("first", "page:1", "tools.next()", "wxs:a.wxs"),
                    bound_task("second", "page:1", "tools.next()", "wxs:a.wxs"),
                    bound_task("cycle", "page:1", "tools.cycle", "wxs:a.wxs"),
                    bound_task("isolated", "page:2", "tools.next()", "wxs:a.wxs"),
                ],
                &ViewExecutionBudget::default(),
            )
            .unwrap();
        assert_eq!(results[0].value, ViewValue::Number(11.0));
        assert_eq!(results[1].value, ViewValue::Number(12.0));
        assert_eq!(results[2].value, ViewValue::Number(7.0));
        assert_eq!(results[3].value, ViewValue::Number(11.0));
    }

    #[test]
    fn data_arguments_are_cloned_and_special_values_are_tagged() {
        let mut view = engine();
        view.load_modules(
            &[module(
                "wxs:values.wxs",
                "exports.change=function(value){value.x=99;return value.x};exports.values=function(){return [undefined,NaN,Infinity,-Infinity,-0,null]}",
                &[],
            )],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        let mut mutation = bound_task(
            "clone",
            "page:1",
            "[tools.change(item),item.x]",
            "wxs:values.wxs",
        );
        mutation.data = serde_json::json!({"item":{"x":1}});
        let result = view
            .evaluate_batch(
                &[
                    mutation.clone(),
                    bound_task("values", "page:1", "tools.values()", "wxs:values.wxs"),
                ],
                &ViewExecutionBudget::default(),
            )
            .unwrap();
        assert_eq!(mutation.data["item"]["x"], 1);
        assert_eq!(
            result[0].value,
            ViewValue::Array(vec![ViewValue::Number(99.0), ViewValue::Number(1.0)])
        );
        assert_eq!(
            result[1].value,
            ViewValue::Array(vec![
                ViewValue::Undefined,
                ViewValue::NaN,
                ViewValue::PositiveInfinity,
                ViewValue::NegativeInfinity,
                ViewValue::NegativeZero,
                ViewValue::Null,
            ])
        );
    }

    #[test]
    fn ordinary_exceptions_preserve_stack_without_poisoning_realm() {
        let mut view = engine();
        view.load_modules(
            &[module(
                "wxs:error.wxs",
                "exports.run=function(){throw new Error('view boom')}",
                &[],
            )],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        let error = view
            .evaluate_batch(
                &[bound_task(
                    "error",
                    "page:1",
                    "tools.run()",
                    "wxs:error.wxs",
                )],
                &ViewExecutionBudget::default(),
            )
            .unwrap_err();
        assert_eq!(error.code, ViewEngineErrorCode::Execution);
        assert!(error.message.contains("view boom"));
        assert!(error.stack.is_some());
        assert_eq!(evaluate(&mut view, "2+2"), ViewValue::Number(4.0));
    }

    #[test]
    fn module_initialization_timeout_requires_a_fresh_realm() {
        let mut view = engine();
        view.load_modules(
            &[module("wxs:loop.wxs", "while(true){}", &[])],
            &ViewExecutionBudget::default(),
        )
        .expect("load compiles factories without initializing them");
        let error = view
            .evaluate_batch(
                &[bound_task("loop", "page:1", "tools.value", "wxs:loop.wxs")],
                &ViewExecutionBudget::new(Duration::from_millis(10)),
            )
            .unwrap_err();
        assert_eq!(error.code, ViewEngineErrorCode::Timeout);
        assert_eq!(
            view.load_modules(&[], &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            ViewEngineErrorCode::RequiresReset
        );
        view.reset().unwrap();
        assert_eq!(evaluate(&mut view, "6*7"), ViewValue::Number(42.0));
    }

    #[test]
    fn cancellation_interrupts_running_function_and_poisons_only_view() {
        let mut app = crate::QuickJsEngine::default();
        let app_module = JsEngine::load_module(&mut app, b"exports.run=function(){return 42}")
            .expect("AppService module");
        let mut view = engine();
        view.load_modules(
            &[module(
                "wxs:loop.wxs",
                "exports.run=function(){while(true){}}",
                &[],
            )],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        let budget = ViewExecutionBudget::new(Duration::from_secs(5));
        let cancellation = std::sync::Arc::clone(&budget.cancellation);
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(10));
            cancellation.store(true, Ordering::Release);
        });
        let result = view.evaluate_batch(
            &[bound_task(
                "cancel",
                "page:1",
                "tools.run()",
                "wxs:loop.wxs",
            )],
            &budget,
        );
        cancel.join().unwrap();
        assert_eq!(result.unwrap_err().code, ViewEngineErrorCode::Cancelled);
        assert_eq!(
            view.evaluate_batch(&[], &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            ViewEngineErrorCode::RequiresReset
        );
        let result = JsEngine::call(
            &mut app,
            CallTarget::Module {
                id: app_module,
                export: "run".into(),
            },
            vec![],
        )
        .unwrap();
        assert_eq!(result, vec![serde_json::json!(42)]);
    }

    #[test]
    fn pre_cancelled_and_zero_budget_discard_the_realm() {
        let mut view = engine();
        let budget = ViewExecutionBudget::default();
        budget.cancellation.store(true, Ordering::Release);
        assert_eq!(
            view.load_modules(&[], &budget).unwrap_err().code,
            ViewEngineErrorCode::Cancelled
        );
        view.reset().unwrap();
        assert_eq!(
            view.load_modules(&[], &ViewExecutionBudget::new(Duration::ZERO))
                .unwrap_err()
                .code,
            ViewEngineErrorCode::Timeout
        );
        assert!(view.native.is_none());
    }

    #[test]
    fn error_getters_and_result_getters_are_covered_by_the_same_budget() {
        for source in [
            "exports.run=function(){throw {get message(){while(true){}}}}",
            "exports.run=function(){return {get value(){while(true){}}}}",
        ] {
            let mut view = engine();
            view.load_modules(
                &[module("wxs:getter.wxs", source, &[])],
                &ViewExecutionBudget::default(),
            )
            .unwrap();
            assert_eq!(
                view.evaluate_batch(
                    &[bound_task(
                        "getter",
                        "page:1",
                        "tools.run()",
                        "wxs:getter.wxs"
                    )],
                    &ViewExecutionBudget::new(Duration::from_millis(10)),
                )
                .unwrap_err()
                .code,
                ViewEngineErrorCode::Timeout
            );
            assert!(view.native.is_none());
        }
    }

    #[test]
    fn microtasks_are_never_drained_and_async_results_are_rejected() {
        let mut view = engine();
        view.load_modules(
            &[module(
                "wxs:async.wxs",
                "var ran=false;Promise.resolve().then(function(){ran=true});exports.read=function(){return ran};exports.promise=function(){return Promise.resolve(1)}",
                &[],
            )],
            &ViewExecutionBudget::default(),
        )
        .unwrap();
        for id in ["first", "second"] {
            let result = view
                .evaluate_batch(
                    &[bound_task(id, "page:1", "tools.read()", "wxs:async.wxs")],
                    &ViewExecutionBudget::default(),
                )
                .unwrap();
            assert_eq!(result[0].value, ViewValue::Bool(false));
        }
        assert_eq!(
            view.evaluate_batch(
                &[bound_task(
                    "promise",
                    "page:1",
                    "tools.promise()",
                    "wxs:async.wxs"
                )],
                &ViewExecutionBudget::default(),
            )
            .unwrap_err()
            .code,
            ViewEngineErrorCode::UnsupportedValue
        );
        view.dispose();
        assert_eq!(
            view.load_modules(&[], &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            ViewEngineErrorCode::RequiresReset
        );
        view.reset().unwrap();
        assert_eq!(
            evaluate(&mut view, "typeof wx"),
            ViewValue::String("undefined".into())
        );
    }

    #[test]
    fn module_replacements_and_reset_clear_cached_exports() {
        let mut view = engine();
        let modules = [module(
            "wxs:counter.wxs",
            "var n=0;exports.next=function(){return ++n}",
            &[],
        )];
        view.load_modules(&modules, &ViewExecutionBudget::default())
            .unwrap();
        let call = [bound_task(
            "next",
            "page:1",
            "tools.next()",
            "wxs:counter.wxs",
        )];
        for value in [1.0, 2.0] {
            assert_eq!(
                view.evaluate_batch(&call, &ViewExecutionBudget::default())
                    .unwrap()[0]
                    .value,
                ViewValue::Number(value)
            );
        }
        view.load_modules(&modules, &ViewExecutionBudget::default())
            .unwrap();
        assert_eq!(
            view.evaluate_batch(&call, &ViewExecutionBudget::default())
                .unwrap()[0]
                .value,
            ViewValue::Number(1.0)
        );
        view.reset().unwrap();
        assert_eq!(
            view.evaluate_batch(&call, &ViewExecutionBudget::default())
                .unwrap_err()
                .code,
            ViewEngineErrorCode::InvalidBatch
        );
    }
}

#[cfg(all(test, feature = "quickjs-native"))]
mod modern_contract {
    include!("../../container-core/tests/support/modern_view.rs");
    modern_view_contract_tests!(super::QuickJsViewEngine::new_modern(
        super::QuickJsConfig::default()
    )
    .expect("isolated modern View"));
}

#[cfg(all(test, not(feature = "quickjs-native")))]
#[test]
fn modern_view_never_falls_back_without_native_feature() {
    assert_eq!(
        QuickJsViewEngine::new_modern(QuickJsConfig::default())
            .unwrap_err()
            .code,
        ViewEngineErrorCode::Unavailable,
    );
}

#[cfg(all(test, feature = "quickjs-native"))]
mod native_performance {
    // Deliberately test-local: an old bootstrap is never selectable by a
    // production constructor or runtime option.
    fn legacy_from_bootstrap(script: &str) -> super::QuickJsViewEngine {
        use super::{NativeView, QuickJsConfig, QuickJsViewEngine, TurnState};
        let config = QuickJsConfig::default();
        let runtime = rquickjs::Runtime::new().unwrap();
        if let Some(limit) = config.memory_limit_bytes {
            runtime.set_memory_limit(limit);
        }
        if let Some(limit) = config.max_stack_bytes {
            runtime.set_max_stack_size(limit);
        }
        let turn = std::sync::Arc::new(std::sync::Mutex::new(TurnState::default()));
        let interrupt_turn = std::sync::Arc::clone(&turn);
        runtime.set_interrupt_handler(Some(Box::new(move || {
            interrupt_turn
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .check()
                .is_some()
        })));
        let context = rquickjs::Context::full(&runtime).unwrap();
        let native = NativeView {
            context,
            _runtime: runtime,
            turn,
        };
        native
            .context
            .with(|ctx| {
                ctx.eval::<(), _>(script)
                    .map_err(|error| native.native_error(&ctx, error))
            })
            .unwrap();
        QuickJsViewEngine {
            config,
            last_timings: None,
            documents: container_core::ViewDocumentRegistry::default(),
            native: Some(native),
            modern: false,
        }
    }
    include!("../../container-core/tests/support/view_perf.rs");
    view_native_benchmark!(
        "quickjs",
        super::QuickJsViewEngine::new_modern(super::QuickJsConfig::default()).unwrap(),
        super::QuickJsViewEngine::new(super::QuickJsConfig::default()).unwrap(),
        legacy_from_bootstrap
    );
}

#[cfg(all(test, feature = "quickjs-native"))]
mod probe_contract {
    include!("../../container-core/tests/support/view_probe.rs");
    view_probe_contract!(
        super::QuickJsViewEngine::new(super::QuickJsConfig::default()).unwrap(),
        super::QuickJsViewEngine::new_modern(super::QuickJsConfig::default()).unwrap()
    );
}

#[cfg(all(test, feature = "quickjs-native"))]
mod registered_legacy_contract {
    include!("../../container-core/tests/support/registered_view.rs");
    registered_view_contract_tests!(
        super::QuickJsViewEngine::new(super::QuickJsConfig::default()).unwrap(),
        false
    );
}

#[cfg(all(test, feature = "quickjs-native"))]
mod registered_modern_contract {
    include!("../../container-core/tests/support/registered_view.rs");
    registered_view_contract_tests!(
        super::QuickJsViewEngine::new_modern(super::QuickJsConfig::default()).unwrap(),
        true
    );
}

#[cfg(all(test, feature = "quickjs-native"))]
mod registered_modern_safety {
    include!("../../container-core/tests/support/registered_modern.rs");
    registered_modern_safety_tests!(super::QuickJsViewEngine::new_modern(
        super::QuickJsConfig::default()
    )
    .unwrap());
}
