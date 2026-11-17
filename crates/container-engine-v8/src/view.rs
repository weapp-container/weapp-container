//! An isolated View realm. This module never constructs `NativeV8` and never
//! installs the AppService bootstrap or any host API bindings.

use super::V8Config;
use container_core::{
    ViewDocumentHandle, ViewDocumentProgram, ViewEngine, ViewEngineError, ViewEngineErrorCode,
    ViewEngineTimings, ViewExecutionBudget, ViewExpressionResult, ViewExpressionTask,
    ViewModuleSource, ViewRenderBatch, ViewRenderResult, ViewRenderTask,
};

#[derive(Debug)]
pub struct V8ViewEngine {
    config: V8Config,
    last_timings: Option<ViewEngineTimings>,
    #[cfg(feature = "v8-native")]
    documents: container_core::ViewDocumentRegistry,
    #[cfg(feature = "v8-native")]
    native: Option<NativeView>,
    #[cfg(feature = "v8-native")]
    modern: bool,
}

impl V8ViewEngine {
    pub fn new(config: V8Config) -> Result<Self, ViewEngineError> {
        Self::with_profile(config, false)
    }

    /// Create an independent synchronous ECMAScript View realm. Standard
    /// intrinsics remain mutable; transport operations are privately captured.
    pub fn new_modern(config: V8Config) -> Result<Self, ViewEngineError> {
        Self::with_profile(config, true)
    }

    fn with_profile(config: V8Config, modern: bool) -> Result<Self, ViewEngineError> {
        #[cfg(feature = "v8-native")]
        {
            let native = NativeView::new(&config, modern).map_err(|message| {
                ViewEngineError::new(ViewEngineErrorCode::Unavailable, message)
            })?;
            Ok(Self {
                config,
                last_timings: None,
                documents: container_core::ViewDocumentRegistry::default(),
                native: Some(native),
                modern,
            })
        }
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = (config, modern);
            Err(unavailable())
        }
    }

    pub fn config(&self) -> &V8Config {
        &self.config
    }

    #[cfg(feature = "v8-native")]
    fn execute_batch<T>(
        &mut self,
        entrypoint: &str,
        budget: &ViewExecutionBudget,
        encode: impl FnOnce() -> Result<String, serde_json::Error>,
        decode: impl FnOnce(serde_json::Value) -> Result<T, ViewEngineError>,
    ) -> Result<T, ViewEngineError> {
        self.last_timings = None;
        // Serialization and diagnostics share the unchanged original deadline.
        let started = std::time::Instant::now();
        let probe = container_core::view_probe::ViewBatchProbe::begin(
            container_core::view_probe::ViewProbeEngine::V8,
            self.modern,
            entrypoint,
        );
        let result = (|| {
            let input = encode().map_err(|error| {
                let error =
                    ViewEngineError::new(ViewEngineErrorCode::InvalidBatch, error.to_string());
                if entrypoint == "__weappContainer_view_register_documents" {
                    error.document_program_rejected()
                } else {
                    error
                }
            })?;
            self.call_batch(entrypoint, &input, budget, started, decode)
        })();
        let diagnostic = probe.finish(result.as_ref().err().map(|error| error.code));
        if let Some(timings) = self.last_timings.as_mut() {
            timings.last_batch = diagnostic;
        } else if diagnostic.is_some() {
            // Preserve historical None on early returns when observation is
            // disabled/unavailable; only a real probe adds an early receipt.
            self.last_timings = Some(ViewEngineTimings {
                batches: 1,
                elapsed_ns: timing_ns(started),
                last_batch: diagnostic,
                ..ViewEngineTimings::default()
            });
        }
        result
    }

    #[cfg(feature = "v8-native")]
    fn call_batch<T>(
        &mut self,
        entrypoint: &str,
        input: &str,
        budget: &ViewExecutionBudget,
        started: std::time::Instant,
        decode: impl FnOnce(serde_json::Value) -> Result<T, ViewEngineError>,
    ) -> Result<T, ViewEngineError> {
        use std::sync::atomic::Ordering;
        use std::time::Instant;

        self.last_timings = None;
        let mut timings = ViewEngineTimings {
            batches: 1,
            input_encode_ns: timing_ns(started),
            input_bytes: input.len() as u64,
            document_registrations: u64::from(
                entrypoint == "__weappContainer_view_register_documents",
            ),
            registered_render_batches: u64::from(
                entrypoint == "__weappContainer_view_render_registered",
            ),
            ..ViewEngineTimings::default()
        };
        let native = self.native.as_mut().ok_or_else(requires_reset)?;
        let deadline = started.checked_add(budget.timeout).ok_or_else(|| {
            ViewEngineError::new(
                ViewEngineErrorCode::InvalidBatch,
                "View budget is too large",
            )
        })?;
        if budget.cancellation.load(Ordering::Acquire) {
            self.native = None;
            return Err(interrupted(Interruption::Cancelled));
        }
        if Instant::now() >= deadline {
            self.native = None;
            return Err(interrupted(Interruption::Timeout));
        }
        let watchdog = TurnWatchdog::start(
            native.isolate.thread_safe_handle(),
            deadline,
            std::sync::Arc::clone(&budget.cancellation),
        )
        .map_err(|message| ViewEngineError::new(ViewEngineErrorCode::Execution, message))?;
        let output = native
            .call_entrypoint(entrypoint, input, self.modern, &mut timings)
            .map_err(|message| ViewEngineError::new(ViewEngineErrorCode::Execution, message));
        let result = output.and_then(|encoded| {
            let stage = Instant::now();
            let decoded = serde_json::from_str::<serde_json::Value>(&encoded)
                .map_err(|error| {
                    ViewEngineError::new(
                        ViewEngineErrorCode::Execution,
                        format!("V8 View returned invalid JSON: {error}"),
                    )
                })
                .and_then(|wire| {
                    if wire.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
                        let error = ViewEngineError::from_wire(&wire["error"]);
                        Err(
                            if entrypoint == "__weappContainer_view_register_documents"
                                && wire
                                    .get("documentProgramRejected")
                                    .and_then(serde_json::Value::as_bool)
                                    == Some(true)
                            {
                                error.document_program_rejected()
                            } else {
                                error
                            },
                        )
                    } else {
                        decode(wire)
                    }
                });
            timings.output_decode_ns = timing_ns(stage);
            decoded
        });
        timings.elapsed_ns = timing_ns(started);
        self.last_timings = Some(timings);
        if let Some(reason) = watchdog.finish() {
            // Never cancel termination and reuse a partially executed realm.
            // Drop it only after its watchdog can no longer deliver a signal.
            self.native = None;
            return Err(interrupted(reason));
        }
        result
    }
}

impl ViewEngine for V8ViewEngine {
    fn last_timings(&self) -> Option<ViewEngineTimings> {
        self.last_timings.clone()
    }
    fn load_modules(
        &mut self,
        modules: &[ViewModuleSource],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        #[cfg(feature = "v8-native")]
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
        #[cfg(not(feature = "v8-native"))]
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
        #[cfg(feature = "v8-native")]
        {
            self.execute_batch(
                "__weappContainer_view_evaluate",
                budget,
                || serde_json::to_string(tasks),
                |wire| {
                    let results: Vec<ViewExpressionResult> =
                        serde_json::from_value(wire["results"].clone()).map_err(|error| {
                            ViewEngineError::new(
                                ViewEngineErrorCode::Execution,
                                format!("V8 View returned an invalid result batch: {error}"),
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
                            "V8 View result batch does not match the submitted task order",
                        ));
                    }
                    Ok(results)
                },
            )
        }
        #[cfg(not(feature = "v8-native"))]
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
        #[cfg(feature = "v8-native")]
        {
            self.execute_batch(
                "__weappContainer_view_render",
                budget,
                || serde_json::to_string(batch),
                |wire| {
                    let results: Vec<ViewRenderResult> =
                        serde_json::from_value(wire["results"].clone()).map_err(|error| {
                            ViewEngineError::new(
                                ViewEngineErrorCode::Execution,
                                format!("V8 View returned an invalid render batch: {error}"),
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
                            "V8 View render batch does not match the submitted task order or AST shape",
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
        #[cfg(not(feature = "v8-native"))]
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
        #[cfg(feature = "v8-native")]
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
        #[cfg(not(feature = "v8-native"))]
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
        #[cfg(feature = "v8-native")]
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
        #[cfg(not(feature = "v8-native"))]
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
        #[cfg(feature = "v8-native")]
        {
            self.execute_batch(
                "__weappContainer_view_release_scopes",
                budget,
                || serde_json::to_string(scopes),
                |_| Ok(()),
            )
        }
        #[cfg(not(feature = "v8-native"))]
        {
            let _ = (scopes, budget);
            Err(unavailable())
        }
    }

    fn reset(&mut self) -> Result<(), ViewEngineError> {
        self.last_timings = None;
        #[cfg(feature = "v8-native")]
        {
            self.documents.invalidate();
            self.native = None;
            self.native = Some(
                NativeView::new(&self.config, self.modern).map_err(|message| {
                    ViewEngineError::new(ViewEngineErrorCode::Unavailable, message)
                })?,
            );
            Ok(())
        }
        #[cfg(not(feature = "v8-native"))]
        {
            Err(unavailable())
        }
    }

    fn dispose(&mut self) {
        #[cfg(feature = "v8-native")]
        {
            self.native = None;
            self.documents.invalidate();
        }
    }
}

#[cfg(not(feature = "v8-native"))]
fn unavailable() -> ViewEngineError {
    ViewEngineError::new(
        ViewEngineErrorCode::Unavailable,
        "V8 native View backend is unavailable in this build",
    )
}

#[cfg(feature = "v8-native")]
fn timing_ns(started: std::time::Instant) -> u64 {
    started.elapsed().as_nanos().min(u128::from(u64::MAX)) as u64
}

#[cfg(feature = "v8-native")]
fn requires_reset() -> ViewEngineError {
    ViewEngineError::new(
        ViewEngineErrorCode::RequiresReset,
        "V8 View realm was disposed or interrupted; reset is required",
    )
}

#[cfg(feature = "v8-native")]
fn interrupted(reason: Interruption) -> ViewEngineError {
    match reason {
        Interruption::Timeout => ViewEngineError::new(
            ViewEngineErrorCode::Timeout,
            "V8 View execution exceeded its time budget; realm discarded",
        ),
        Interruption::Cancelled => ViewEngineError::new(
            ViewEngineErrorCode::Cancelled,
            "V8 View execution was cancelled; realm discarded",
        ),
    }
}

#[cfg(feature = "v8-native")]
struct NativeView {
    context: v8::Global<v8::Context>,
    isolate: v8::SharedIsolate,
    _owner: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(feature = "v8-native")]
impl std::fmt::Debug for NativeView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("NativeView").finish_non_exhaustive()
    }
}

#[cfg(feature = "v8-native")]
impl NativeView {
    fn new(config: &V8Config, modern: bool) -> Result<Self, String> {
        super::initialize_v8_platform();
        let mut params = v8::CreateParams::default();
        if let Some(limit) = config.heap_limit_bytes {
            params = params.set_max_old_generation_size_in_bytes(limit);
        }
        let mut isolate = v8::Isolate::new(params);
        // View code is synchronous. Queued Promise jobs are never pumped,
        // including when another AppService isolate drains its own queue.
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_allow_atomics_wait(false);
        let context = {
            v8::scope!(let scope, &mut isolate);
            let context = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, context)
        };
        // SAFETY: no scopes, callbacks, external allocations, weak handles or
        // embedder slots survive construction. The realm remains thread-
        // affine; every later Local is opened under its own isolate Locker.
        let isolate = match unsafe { isolate.try_into_shared() } {
            Ok(isolate) => isolate,
            Err(error) => {
                let message = format!("V8 View shared-isolate conversion failed: {error}");
                drop(error.into_isolate());
                return Err(message);
            }
        };
        let mut native = Self {
            context,
            isolate,
            _owner: std::marker::PhantomData,
        };
        native.run_script(
            if modern {
                container_core::MODERN_VIEW_SCRIPT_BOOTSTRAP
            } else {
                container_core::VIEW_SCRIPT_BOOTSTRAP
            },
            false,
        )?;
        Ok(native)
    }

    fn run_script(&mut self, source: &str, encode_result: bool) -> Result<String, String> {
        let context_global = &self.context;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, context_global);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let source = v8::String::new(try_catch, source)
            .ok_or_else(|| "V8 View could not allocate script source".to_owned())?;
        let script = v8::Script::compile(try_catch, source, None).ok_or_else(|| {
            super::exception_message(try_catch)
                .unwrap_or_else(|| "V8 View script compilation failed".into())
        })?;
        let result = script.run(try_catch).ok_or_else(|| {
            super::exception_message(try_catch)
                .unwrap_or_else(|| "V8 View script execution failed".into())
        })?;
        if !encode_result {
            return Ok(String::new());
        }
        let result = result.to_string(try_catch).ok_or_else(|| {
            super::exception_message(try_catch)
                .unwrap_or_else(|| "V8 View result is not a string".into())
        })?;
        Ok(result.to_rust_string_lossy(try_catch))
    }

    fn call_entrypoint(
        &mut self,
        name: &str,
        input: &str,
        modern: bool,
        timings: &mut ViewEngineTimings,
    ) -> Result<String, String> {
        let context_global = &self.context;
        let mut isolate = self.isolate.lock();
        v8::scope!(let scope, &mut *isolate);
        let context = v8::Local::new(scope, context_global);
        v8::scope_with_context!(let scope, scope, context);
        v8::tc_scope!(let try_catch, scope);
        let stage = std::time::Instant::now();
        let prepared = (|| {
            let input = v8::String::new(try_catch, input)
                .ok_or_else(|| "V8 View could not allocate input batch".to_owned())?;
            let input = v8::json::parse(try_catch, input)
                .ok_or_else(|| "V8 View input batch is invalid JSON".to_owned())?;
            let key = v8::String::new(try_catch, name)
                .ok_or_else(|| "V8 View could not allocate entrypoint name".to_owned())?;
            let global = context.global(try_catch);
            let function = global
                .get(try_catch, key.into())
                .and_then(|value| v8::Local::<v8::Function>::try_from(value).ok())
                .ok_or_else(|| format!("V8 View entrypoint {name} is unavailable"))?;
            Ok::<_, String>((input, global, function))
        })();
        timings.vm_input_parse_ns = timing_ns(stage);
        let (input, global, function) = prepared?;
        let stage = std::time::Instant::now();
        let executed = function
            .call(try_catch, global.into(), &[input])
            .ok_or_else(|| {
                super::exception_message(try_catch)
                    .unwrap_or_else(|| format!("V8 View entrypoint {name} failed"))
            });
        timings.execute_including_lazy_compile_ns = timing_ns(stage);
        let result = executed?;
        let stage = std::time::Instant::now();
        let encoded = (|| {
            if modern {
                let result = v8::Local::<v8::String>::try_from(result).map_err(|_| {
                    "modern V8 View returned a non-string reply envelope".to_owned()
                })?;
                return Ok(result.to_rust_string_lossy(try_catch));
            }
            // Use V8's intrinsic JSON APIs rather than mutable global JSON
            // properties that an evaluated module could replace.
            let result = v8::json::stringify(try_catch, result).ok_or_else(|| {
                super::exception_message(try_catch)
                    .unwrap_or_else(|| "V8 View returned an unserializable result".into())
            })?;
            Ok(result.to_rust_string_lossy(try_catch))
        })();
        timings.vm_output_encode_ns = timing_ns(stage);
        encoded
    }
}

/// Each deadline owns a watchdog that is cancelled and joined before the
/// turn returns. The state lock also covers the termination request: a late
/// timeout cannot escape cancellation and terminate a subsequent turn.
#[cfg(feature = "v8-native")]
struct TurnWatchdog {
    state: std::sync::Arc<(std::sync::Mutex<WatchdogState>, std::sync::Condvar)>,
    worker: Option<std::thread::JoinHandle<()>>,
    deadline: std::time::Instant,
    cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

#[cfg(feature = "v8-native")]
#[derive(Default)]
struct WatchdogState {
    completed: bool,
    interruption: Option<Interruption>,
}

#[cfg(feature = "v8-native")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Interruption {
    Timeout,
    Cancelled,
}

#[cfg(feature = "v8-native")]
impl TurnWatchdog {
    fn start(
        handle: v8::IsolateHandle,
        deadline: std::time::Instant,
        cancellation: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<Self, String> {
        use std::sync::atomic::Ordering;
        use std::sync::{Arc, Condvar, Mutex};
        use std::time::{Duration, Instant};

        let state = Arc::new((Mutex::new(WatchdogState::default()), Condvar::new()));
        let worker_state = Arc::clone(&state);
        let worker_cancellation = Arc::clone(&cancellation);
        let worker = std::thread::Builder::new()
            .name("weapp-v8-view-budget".into())
            .spawn(move || {
                let (lock, changed) = &*worker_state;
                let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
                loop {
                    if state.completed {
                        break;
                    }
                    let now = Instant::now();
                    let interruption = if worker_cancellation.load(Ordering::Acquire) {
                        Some(Interruption::Cancelled)
                    } else if now >= deadline {
                        Some(Interruption::Timeout)
                    } else {
                        None
                    };
                    if let Some(interruption) = interruption {
                        state.interruption = Some(interruption);
                        // Holding the token lock prevents finish() from
                        // completing until this request has been delivered.
                        handle.terminate_execution();
                        break;
                    }
                    state = changed
                        .wait_timeout(
                            state,
                            deadline
                                .saturating_duration_since(now)
                                .min(Duration::from_millis(1)),
                        )
                        .unwrap_or_else(|error| error.into_inner())
                        .0;
                }
            })
            .map_err(|error| format!("V8 View watchdog could not start: {error}"))?;
        Ok(Self {
            state,
            worker: Some(worker),
            deadline,
            cancellation,
        })
    }

    fn finish(self) -> Option<Interruption> {
        self.finish_with_clock(std::time::Instant::now)
    }

    fn finish_with_clock(
        mut self,
        now: impl FnOnce() -> std::time::Instant,
    ) -> Option<Interruption> {
        // The execution budget ends after result conversion, before joining
        // the watchdog. A descheduled worker may take arbitrarily long to
        // acknowledge completion; that cleanup cannot make an on-time batch
        // retroactively expire. A delivered interruption still wins below.
        let completed_at = now();
        self.stop().or_else(|| {
            if self.cancellation.load(std::sync::atomic::Ordering::Acquire) {
                Some(Interruption::Cancelled)
            } else if completed_at >= self.deadline {
                Some(Interruption::Timeout)
            } else {
                None
            }
        })
    }

    fn stop(&mut self) -> Option<Interruption> {
        let (lock, changed) = &*self.state;
        let interruption = {
            let mut state = lock.lock().unwrap_or_else(|error| error.into_inner());
            state.completed = true;
            changed.notify_one();
            state.interruption
        };
        if let Some(worker) = self.worker.take() {
            // The worker owns only an isolate handle and cannot run user
            // callbacks. Joining also prevents stale handles after reset.
            if worker.join().is_err() {
                return Some(Interruption::Timeout);
            }
        }
        interruption
    }
}

#[cfg(feature = "v8-native")]
impl Drop for TurnWatchdog {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(all(test, feature = "v8-native"))]
mod watchdog_tests {
    use super::{Interruption, TurnWatchdog, WatchdogState};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    };
    use std::time::{Duration, Instant};

    /// No isolate, sleep or real short deadline is needed to model cleanup.
    /// The worker cannot exit until stop() publishes completion, and its exit
    /// advances the test clock across the deadline.
    fn completion_worker(
        deadline: Instant,
        interruption: Option<Interruption>,
        cancel_on_exit: bool,
    ) -> (TurnWatchdog, Arc<AtomicBool>) {
        let state = Arc::new((
            Mutex::new(WatchdogState {
                completed: false,
                interruption,
            }),
            Condvar::new(),
        ));
        let worker_state = Arc::clone(&state);
        let cancellation = Arc::new(AtomicBool::new(false));
        let worker_cancellation = Arc::clone(&cancellation);
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = Arc::clone(&exited);
        let worker = std::thread::spawn(move || {
            let (lock, changed) = &*worker_state;
            let mut state = lock.lock().unwrap();
            while !state.completed {
                state = changed.wait(state).unwrap();
            }
            if cancel_on_exit {
                worker_cancellation.store(true, Ordering::Release);
            }
            worker_exited.store(true, Ordering::Release);
        });
        (
            TurnWatchdog {
                state,
                worker: Some(worker),
                deadline,
                cancellation,
            },
            exited,
        )
    }

    #[test]
    fn on_time_completion_does_not_expire_while_joining_the_watchdog() {
        let deadline = Instant::now() + Duration::from_secs(1);
        let (watchdog, exited) = completion_worker(deadline, None, false);
        let result = watchdog.finish_with_clock(|| {
            if exited.load(Ordering::Acquire) {
                deadline + Duration::from_millis(1)
            } else {
                deadline - Duration::from_millis(1)
            }
        });
        assert_eq!(result, None);
        assert!(exited.load(Ordering::Acquire), "finish must still join");
    }

    #[test]
    fn completion_at_or_after_the_deadline_still_times_out() {
        let deadline = Instant::now() + Duration::from_secs(1);
        for elapsed in [Duration::ZERO, Duration::from_millis(1)] {
            let (watchdog, exited) = completion_worker(deadline, None, false);
            assert_eq!(
                watchdog.finish_with_clock(|| deadline + elapsed),
                Some(Interruption::Timeout)
            );
            assert!(exited.load(Ordering::Acquire));
        }
    }

    #[test]
    fn recorded_interruption_wins_over_an_on_time_completion() {
        let deadline = Instant::now() + Duration::from_secs(1);
        for reason in [Interruption::Timeout, Interruption::Cancelled] {
            let (watchdog, exited) = completion_worker(deadline, Some(reason), false);
            assert_eq!(
                watchdog.finish_with_clock(|| deadline - Duration::from_millis(1)),
                Some(reason)
            );
            assert!(exited.load(Ordering::Acquire));
        }
    }

    #[test]
    fn cancellation_before_completion_or_during_join_is_preserved() {
        let deadline = Instant::now() + Duration::from_secs(1);
        for cancel_on_exit in [false, true] {
            let (watchdog, exited) = completion_worker(deadline, None, cancel_on_exit);
            if !cancel_on_exit {
                watchdog.cancellation.store(true, Ordering::Release);
            }
            assert_eq!(
                watchdog.finish_with_clock(|| deadline - Duration::from_millis(1)),
                Some(Interruption::Cancelled)
            );
            assert!(exited.load(Ordering::Acquire));
        }
    }
}

#[cfg(all(test, feature = "v8-native"))]
mod native_tests {
    use super::*;

    fn engine() -> V8ViewEngine {
        V8ViewEngine::new(V8Config::default()).expect("isolated native View")
    }

    mod render_contract {
        include!("../../container-core/tests/support/view_render.rs");
        view_render_contract_tests!(super::engine());
    }
}

#[cfg(all(test, feature = "v8-native"))]
mod modern_contract {
    include!("../../container-core/tests/support/modern_view.rs");
    modern_view_contract_tests!(
        super::V8ViewEngine::new_modern(super::V8Config::default()).expect("isolated modern View")
    );
}

#[cfg(all(test, not(feature = "v8-native")))]
#[test]
fn modern_view_never_falls_back_without_native_feature() {
    assert_eq!(
        V8ViewEngine::new_modern(V8Config::default())
            .unwrap_err()
            .code,
        ViewEngineErrorCode::Unavailable,
    );
}

#[cfg(all(test, feature = "v8-native"))]
mod native_performance {
    // Test-local historical baseline; production always uses its compiled-in
    // bootstrap and cannot load a caller-selected trusted runtime script.
    fn legacy_from_bootstrap(script: &str) -> super::V8ViewEngine {
        use super::{NativeView, V8Config, V8ViewEngine};
        let config = V8Config::default();
        super::super::initialize_v8_platform();
        let mut params = v8::CreateParams::default();
        if let Some(limit) = config.heap_limit_bytes {
            params = params.set_max_old_generation_size_in_bytes(limit);
        }
        let mut isolate = v8::Isolate::new(params);
        isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
        isolate.set_allow_atomics_wait(false);
        let context = {
            v8::scope!(let scope,&mut isolate);
            let context = v8::Context::new(scope, Default::default());
            v8::Global::new(scope, context)
        };
        // SAFETY: identical to the production constructor. No scopes or
        // callbacks survive, and this engine remains thread-affine.
        let isolate = match unsafe { isolate.try_into_shared() } {
            Ok(isolate) => isolate,
            Err(error) => panic!("benchmark isolate: {error}"),
        };
        let mut native = NativeView {
            context,
            isolate,
            _owner: std::marker::PhantomData,
        };
        native.run_script(script, false).unwrap();
        V8ViewEngine {
            config,
            last_timings: None,
            documents: container_core::ViewDocumentRegistry::default(),
            native: Some(native),
            modern: false,
        }
    }
    include!("../../container-core/tests/support/view_perf.rs");
    view_native_benchmark!(
        "v8",
        super::V8ViewEngine::new_modern(super::V8Config::default()).unwrap(),
        super::V8ViewEngine::new(super::V8Config::default()).unwrap(),
        legacy_from_bootstrap
    );
}

#[cfg(all(test, feature = "v8-native"))]
mod probe_contract {
    include!("../../container-core/tests/support/view_probe.rs");
    view_probe_contract!(
        super::V8ViewEngine::new(super::V8Config::default()).unwrap(),
        super::V8ViewEngine::new_modern(super::V8Config::default()).unwrap()
    );
}

#[cfg(all(test, feature = "v8-native"))]
mod registered_legacy_contract {
    include!("../../container-core/tests/support/registered_view.rs");
    registered_view_contract_tests!(
        super::V8ViewEngine::new(super::V8Config::default()).unwrap(),
        false
    );
}

#[cfg(all(test, feature = "v8-native"))]
mod registered_modern_contract {
    include!("../../container-core/tests/support/registered_view.rs");
    registered_view_contract_tests!(
        super::V8ViewEngine::new_modern(super::V8Config::default()).unwrap(),
        true
    );
}

#[cfg(all(test, feature = "v8-native"))]
mod registered_modern_safety {
    include!("../../container-core/tests/support/registered_modern.rs");
    registered_modern_safety_tests!(
        super::V8ViewEngine::new_modern(super::V8Config::default()).unwrap()
    );
}
