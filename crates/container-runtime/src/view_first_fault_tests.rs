//! Deterministic provenance tests. No native VM, sleeps, retries or device IO.
use super::*;
use container_core::{
    view_probe::{ViewBatchBreakdown, ViewBatchDiagnostics, ViewBatchPhases, ViewProbeOperation},
    LifecycleEvent, TimerKind, ViewDocumentRegistry, ViewExpressionResult, ViewExpressionTask,
    ViewRenderBatch, ViewRenderResult,
};
use serde_json::{json, Value};
use std::{cell::RefCell, rc::Rc, sync::Arc};

#[derive(Default)]
struct State {
    calls: Vec<ViewProbeOperation>,
    failure: Option<(ViewProbeOperation, ViewEngineError)>,
    last: Option<ViewEngineTimings>,
    instrumented: bool,
    registry: ViewDocumentRegistry,
}

struct Provider(Rc<RefCell<State>>);

impl State {
    fn complete(&mut self, operation: ViewProbeOperation) -> Result<(), ViewEngineError> {
        self.calls.push(operation);
        self.last = self.instrumented.then(|| {
            let batch: ViewBatchDiagnostics = serde_json::from_value(json!({
                "schemaVersion":1, "engine":"quickjs", "modern":false,
                "operation":operation, "batchSequence":self.calls.len().to_string(),
                "ownerThreadId":"deterministic-owner", "monotonicStartNs":"101",
                "monotonicEndNs":"113", "errorCode":self.failure.as_ref()
                    .filter(|(op, _)| *op == operation).map(|(_, error)| error.code.as_str()),
                "androidTraceEmitted":false
            }))
            .unwrap();
            let breakdown = ViewBatchBreakdown::from_batch(
                &batch,
                ViewBatchPhases {
                    output_bytes: Some("23".into()),
                    ..Default::default()
                },
            );
            ViewEngineTimings {
                batches: 1,
                elapsed_ns: 12,
                last_batch: Some(batch),
                last_batch_breakdown: Some(breakdown),
                ..Default::default()
            }
        });
        match &self.failure {
            Some((failed, error)) if *failed == operation => Err(error.clone()),
            _ => Ok(()),
        }
    }
}

impl ViewEngine for Provider {
    fn last_timings(&self) -> Option<ViewEngineTimings> {
        self.0.borrow().last.clone()
    }
    fn load_modules(
        &mut self,
        _: &[ViewModuleSource],
        _: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.complete(ViewProbeOperation::Load)?;
        state.registry = ViewDocumentRegistry::default();
        Ok(())
    }
    fn evaluate_batch(
        &mut self,
        _: &[ViewExpressionTask],
        _: &ViewExecutionBudget,
    ) -> Result<Vec<ViewExpressionResult>, ViewEngineError> {
        unreachable!()
    }
    fn render_batch(
        &mut self,
        _: &ViewRenderBatch,
        _: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        unreachable!()
    }
    fn register_documents(
        &mut self,
        program: &ViewDocumentProgram,
        _: &ViewExecutionBudget,
    ) -> Result<ViewDocumentHandle, ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.complete(ViewProbeOperation::RegisterDocuments)?;
        let key = state.registry.reserve_key()?;
        Ok(state.registry.publish(key, program.documents()))
    }
    fn render_registered_batch(
        &mut self,
        handle: &ViewDocumentHandle,
        tasks: &[ViewRenderTask],
        _: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.registry.key(handle)?;
        state.complete(ViewProbeOperation::RenderRegistered)?;
        Ok(tasks.iter().map(|task| ViewRenderResult {
            attribute_sources: Vec::new(),
            task_id:task.task_id.clone(),
            ast:json!({"version":1,"nodes":[{"kind":"text","value":"ok","bindings":[],"lexicalOrigin":{"documentId":task.document_id}}]}),
        }).collect())
    }
    fn release_scopes(
        &mut self,
        _: &[String],
        _: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        self.0
            .borrow_mut()
            .complete(ViewProbeOperation::ReleaseScopes)
    }
    fn reset(&mut self) -> Result<(), ViewEngineError> {
        panic!("fault observation cannot reset a realm")
    }
    fn dispose(&mut self) {}
}

fn execution(instrumented: bool) -> (ViewExecution, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State {
        instrumented,
        ..Default::default()
    }));
    let capture = Rc::clone(&state);
    let mut view = ViewExecution::new(EngineKind::Quickjs).unwrap();
    view.provider_available = true;
    view.provider_factory = Some(Box::new(move |_, modern| {
        assert!(!modern);
        Ok(Box::new(Provider(Rc::clone(&capture))))
    }));
    (view, state)
}

fn program(
    with_module: bool,
) -> (
    ContainerManifestV1,
    crate::RenderResources,
    BTreeMap<String, WxmlAst>,
    Vec<ViewRenderTask>,
) {
    let ast = container_ir::parse_wxml("<view>{{value}}</view>").unwrap();
    let bytes = ast.canonical_json().unwrap();
    let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "first-fault-unit".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.templates.push(container_ir::Template {
        id: "template:main.wxml".into(),
        wxml_ast: pointer.clone(),
        bindings: vec!["value".into()],
        wxs_modules: BTreeMap::new(),
    });
    let mut blobs = BTreeMap::from([(pointer, bytes)]);
    if with_module {
        let bytes = b"exports.value=1;".to_vec();
        let hash = container_ir::hex_digest(&bytes);
        blobs.insert(format!("sha256:{hash}"), bytes);
        manifest.view_scripts.push(container_ir::ViewScriptModule {
            id: "wxs:tools.wxs".into(),
            sha256: hash,
            dependencies: vec![],
        });
    }
    manifest.refresh_integrity().unwrap();
    (
        manifest,
        Arc::new(blobs),
        BTreeMap::from([("template:main.wxml".into(), ast)]),
        vec![ViewRenderTask {
            task_id: "main".into(),
            scope_id: "page:one".into(),
            document_id: "main.wxml".into(),
            data: json!({"value":1}),
        }],
    )
}

fn fail(state: &Rc<RefCell<State>>, operation: ViewProbeOperation, code: ViewEngineErrorCode) {
    state.borrow_mut().failure = Some((
        operation,
        ViewEngineError::new(code, "injected first fault").with_stack("first.view.js:9"),
    ));
}
fn witness(view: &ViewExecution) -> Value {
    serde_json::to_value(view.first_fault().expect("first transition witness")).unwrap()
}
fn exact_provider(view: &ViewExecution, wire: &Value) {
    assert_eq!(
        wire["provider"]["lastBatch"],
        wire["metrics"]["providerStages"]["lastBatch"]
    );
    assert_eq!(
        wire["provider"]["lastBatchBreakdown"],
        wire["metrics"]["providerStages"]["lastBatchBreakdown"]
    );
    assert!(view.first_fault().is_some());
}

#[test]
fn failed_render_preserves_actual_operation_metrics_and_exact_batch() {
    let (mut view, state) = execution(true);
    let (manifest, resources, documents, tasks) = program(false);
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    fail(
        &state,
        ViewProbeOperation::RenderRegistered,
        ViewEngineErrorCode::Timeout,
    );
    assert_eq!(
        view.render_documents(&manifest, &documents, &tasks, &budget)
            .unwrap_err()
            .code,
        BridgeErrorCode::Timeout
    );
    let saved = witness(&view);
    assert_eq!(saved["operation"], "render");
    assert_eq!(saved["faultSequence"], "1");
    assert_eq!(saved["operationSequence"], "2");
    assert!(saved["monotonicElapsedNs"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .is_ok());
    assert_eq!(
        saved["metrics"],
        serde_json::to_value(view.metrics().frontier).unwrap()
    );
    assert_eq!(
        saved["provider"]["lastBatch"]["operation"],
        "renderRegistered"
    );
    assert_eq!(saved["provider"]["lastBatch"]["errorCode"], "ERR_TIMEOUT");
    exact_provider(&view, &saved);
    let original = view.fault().unwrap();
    let calls = state.borrow().calls.len();
    for _ in 0..3 {
        assert!(view.ensure_healthy().is_err());
        assert!(view
            .prepare_verified_modules(&manifest, &resources, &budget)
            .is_err());
        assert!(view
            .render_documents(&manifest, &documents, &tasks, &budget)
            .is_err());
        assert!(view.release_scopes(&["page:one".into()], &budget).is_err());
        assert_eq!(view.fault().unwrap(), original);
        assert_eq!(witness(&view), saved);
    }
    assert_eq!(state.borrow().calls.len(), calls);
    assert!(!view.metrics().frontier.succeeded);
    assert!(view.metrics().frontier.provider_stages.is_none());
}

#[test]
fn failed_prepare_and_failed_release_are_distinct_exact_operations() {
    for failed in [ViewProbeOperation::Load, ViewProbeOperation::ReleaseScopes] {
        let (mut view, state) = execution(true);
        let (manifest, resources, documents, tasks) = program(true);
        let budget = ViewExecutionBudget::default();
        if failed == ViewProbeOperation::Load {
            fail(&state, failed, ViewEngineErrorCode::Cancelled);
        }
        let prepared = view.prepare_verified_modules(&manifest, &resources, &budget);
        if failed == ViewProbeOperation::Load {
            assert_eq!(prepared.unwrap_err().code, BridgeErrorCode::Cancelled);
        } else {
            prepared.unwrap();
            view.render_documents(&manifest, &documents, &tasks, &budget)
                .unwrap();
            fail(&state, failed, ViewEngineErrorCode::Execution);
            assert_eq!(
                view.release_scopes(&["page:one".into()], &budget)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Render
            );
        }
        let saved = witness(&view);
        assert_eq!(
            saved["operation"],
            if failed == ViewProbeOperation::Load {
                "prepare"
            } else {
                "release"
            }
        );
        assert_eq!(
            saved["provider"]["lastBatch"]["operation"],
            serde_json::to_value(failed).unwrap()
        );
        exact_provider(&view, &saved);
        let expected = if failed == ViewProbeOperation::Load {
            serde_json::to_value(view.metrics().preparation).unwrap()
        } else {
            serde_json::to_value(view.metrics().scope_release).unwrap()
        };
        assert_eq!(saved["metrics"], expected);
        assert_eq!(saved["metrics"]["succeeded"], false);
    }
}

#[test]
fn no_provider_fault_has_null_receipts_even_after_a_previous_successful_batch() {
    for had_provider in [false, true] {
        let (mut view, state) = execution(true);
        let (manifest, resources, documents, tasks) = program(false);
        let budget = ViewExecutionBudget::default();
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        if had_provider {
            view.render_documents(&manifest, &documents, &tasks, &budget)
                .unwrap();
        }
        let calls = state.borrow().calls.len();
        budget
            .cancellation
            .store(true, std::sync::atomic::Ordering::Release);
        assert_eq!(
            view.render_documents(&manifest, &documents, &tasks, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        let saved = witness(&view);
        assert_eq!(saved["operation"], "render");
        assert_eq!(saved["metrics"]["providerStages"], Value::Null);
        assert_eq!(
            saved["provider"],
            json!({"lastBatch":null,"lastBatchBreakdown":null})
        );
        assert_eq!(state.borrow().calls.len(), calls);
        if !had_provider {
            assert!(view.engine.is_none());
        }
    }
}

#[test]
fn uninstrumented_provider_stays_unknown_and_sequences_are_lossless_decimal() {
    let (mut view, state) = execution(false);
    let (manifest, resources, documents, tasks) = program(false);
    let budget = ViewExecutionBudget::default();
    view.operation_sequence = 9_007_199_254_740_999;
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    fail(
        &state,
        ViewProbeOperation::RenderRegistered,
        ViewEngineErrorCode::Unavailable,
    );
    assert!(view
        .render_documents(&manifest, &documents, &tasks, &budget)
        .is_err());
    let saved = witness(&view);
    assert_eq!(saved["operationSequence"], "9007199254741001");
    assert_eq!(
        saved["provider"],
        json!({"lastBatch":null,"lastBatchBreakdown":null})
    );
    assert_eq!(saved["metrics"]["providerStages"], Value::Null);
}

#[test]
fn preflight_and_recoverable_errors_never_invent_poison_or_fault_witness() {
    let (mut view, state) = execution(true);
    let (manifest, resources, documents, tasks) = program(true);
    let budget = ViewExecutionBudget::default();
    let mut wrong = resources.as_ref().clone();
    wrong.insert(
        format!("sha256:{}", manifest.view_scripts[0].sha256),
        b"wrong".to_vec(),
    );
    assert!(view.prepare_modules(&manifest, &wrong, &budget).is_err());
    assert!(!view.is_faulted());
    assert!(view.first_fault().is_none());
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    let mut duplicate = tasks.clone();
    duplicate.push(tasks[0].clone());
    assert!(view
        .render_documents(&manifest, &documents, &duplicate, &budget)
        .is_err());
    assert!(view
        .release_scopes(&["duplicate".into(), "duplicate".into()], &budget)
        .is_err());
    assert!(!view.is_faulted());
    assert!(view.first_fault().is_none());
    fail(
        &state,
        ViewProbeOperation::RenderRegistered,
        ViewEngineErrorCode::Execution,
    );
    assert_eq!(
        view.render_documents(&manifest, &documents, &tasks, &budget)
            .unwrap_err()
            .code,
        BridgeErrorCode::Render
    );
    assert!(!view.is_faulted());
    assert!(view.first_fault().is_none());
}

#[test]
fn session_details_and_live_appservice_timers_keep_the_original_witness() {
    let (mut view, state) = execution(true);
    let (manifest, resources, documents, tasks) = program(false);
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    view.render_documents(&manifest, &documents, &tasks, &budget)
        .unwrap();
    // An exact immutable program/cache hit precedes the eventual first fault.
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    assert!(view.metrics().preparation.cache_hit);
    fail(
        &state,
        ViewProbeOperation::RenderRegistered,
        ViewEngineErrorCode::Timeout,
    );
    assert_eq!(
        view.render_documents(&manifest, &documents, &tasks, &budget)
            .unwrap_err()
            .code,
        BridgeErrorCode::Timeout
    );
    let original = witness(&view);
    let mut session = crate::Session::new(
        manifest.clone(),
        crate::SessionConfig {
            session_id: "first-fault-session".into(),
            ..Default::default()
        },
    )
    .unwrap();
    session.view_execution.replace(view);
    session
        .app_service
        .dispatch_lifecycle(LifecycleEvent::Launch)
        .unwrap();
    session.initialized = true;
    let timer = session
        .app_service
        .schedule_timer(TimerKind::Timeout, 10, 0, Some("live".into()));
    let first = session.execution_health().view_fault.unwrap();
    assert_eq!(first.code, "ERR_TIMEOUT");
    assert_eq!(first.stack.as_deref(), Some("first.view.js:9"));
    assert_eq!(
        first.details,
        Some(json!({"schemaVersion":1,"sessionId":"first-fault-session","witness":original}))
    );
    let events = session.poll_timers(10_000_000);
    assert!(events
        .messages
        .iter()
        .any(|m| m.payload.get("type").and_then(Value::as_str) == Some("timer")));
    assert!(!session.app_service.cancel_timer(timer));
    for _ in 0..3 {
        assert!(session.ensure_view_execution_healthy().is_err());
        assert_eq!(session.execution_health().view_fault.as_ref(), Some(&first));
        assert_eq!(session.view_execution_fault().as_ref(), Some(&first));
        session.view_execution_metrics();
        assert_eq!(witness(&session.view_execution.borrow()), original);
    }
    assert!(session.retire_faulted_view_authority());
    assert!(!session.retire_faulted_view_authority());
    assert_eq!(session.execution_health().view_fault.unwrap(), first);
}
