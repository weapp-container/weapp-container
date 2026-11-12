//! Deterministic first-use scheduling tests. No native VM, sleep or retry is
//! used to model creation, cancellation, registry retirement or budget sharing.
use super::*;
use container_core::{
    ViewDocumentRegistry, ViewExpressionResult, ViewExpressionTask, ViewRenderBatch,
    ViewRenderResult,
};
use serde_json::json;
use std::{
    cell::RefCell,
    rc::Rc,
    sync::{atomic::Ordering, Arc},
    time::Duration,
};

#[derive(Default)]
struct State {
    creations: usize,
    loads: Vec<Vec<String>>,
    calls: Vec<(&'static str, ViewExecutionBudget)>,
    registrations: usize,
    renders: usize,
    registry: ViewDocumentRegistry,
    cancel_on_create: Option<Arc<std::sync::atomic::AtomicBool>>,
    cancel_on_load: Option<Arc<std::sync::atomic::AtomicBool>>,
}

struct Provider(Rc<RefCell<State>>);

impl ViewEngine for Provider {
    fn load_modules(
        &mut self,
        modules: &[ViewModuleSource],
        budget: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.calls.push(("load", budget.clone()));
        state
            .loads
            .push(modules.iter().map(|m| m.id.clone()).collect());
        state.registry = ViewDocumentRegistry::default();
        if let Some(cancel) = &state.cancel_on_load {
            cancel.store(true, Ordering::Release);
        }
        Ok(())
    }

    fn evaluate_batch(
        &mut self,
        _: &[ViewExpressionTask],
        _: &ViewExecutionBudget,
    ) -> Result<Vec<ViewExpressionResult>, ViewEngineError> {
        unreachable!("frontiers use registered documents")
    }

    fn render_batch(
        &mut self,
        _: &ViewRenderBatch,
        _: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        unreachable!("frontiers use registered documents")
    }

    fn register_documents(
        &mut self,
        program: &ViewDocumentProgram,
        budget: &ViewExecutionBudget,
    ) -> Result<ViewDocumentHandle, ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.calls.push(("register", budget.clone()));
        state.registrations += 1;
        let key = state.registry.reserve_key()?;
        Ok(state.registry.publish(key, program.documents()))
    }

    fn render_registered_batch(
        &mut self,
        handle: &ViewDocumentHandle,
        tasks: &[ViewRenderTask],
        budget: &ViewExecutionBudget,
    ) -> Result<Vec<ViewRenderResult>, ViewEngineError> {
        let mut state = self.0.borrow_mut();
        state.registry.key(handle)?;
        state.calls.push(("render", budget.clone()));
        state.renders += 1;
        Ok(tasks
            .iter()
            .map(|task| ViewRenderResult {
                attribute_sources: Vec::new(),
                task_id: task.task_id.clone(),
                ast: json!({"version":1,"nodes":[{
                    "kind":"text","value":"accepted","bindings":[],
                    "lexicalOrigin":{"documentId":task.document_id}
                }]}),
            })
            .collect())
    }

    fn release_scopes(
        &mut self,
        _: &[String],
        _: &ViewExecutionBudget,
    ) -> Result<(), ViewEngineError> {
        Ok(())
    }

    fn reset(&mut self) -> Result<(), ViewEngineError> {
        unreachable!("an interrupted realm must never reset itself")
    }

    fn dispose(&mut self) {}
}

fn execution() -> (ViewExecution, Rc<RefCell<State>>) {
    let state = Rc::new(RefCell::new(State::default()));
    let capture = Rc::clone(&state);
    let mut view = ViewExecution::new(EngineKind::Quickjs).unwrap();
    // This unit fixture supplies its own provider even in no-native builds.
    view.provider_available = true;
    view.provider_factory = Some(Box::new(move |engine, modern| {
        assert_eq!(engine, EngineKind::Quickjs);
        assert!(!modern);
        let mut state = capture.borrow_mut();
        state.creations += 1;
        if let Some(cancel) = &state.cancel_on_create {
            cancel.store(true, Ordering::Release);
        }
        drop(state);
        Ok(Box::new(Provider(Rc::clone(&capture))))
    }));
    (view, state)
}

fn program() -> (
    ContainerManifestV1,
    crate::RenderResources,
    BTreeMap<String, WxmlAst>,
    Vec<ViewRenderTask>,
) {
    let ast = container_ir::parse_wxml("<view>{{value}}</view>").unwrap();
    let bytes = ast.canonical_json().unwrap();
    let pointer = format!("sha256:{}", container_ir::hex_digest(&bytes));
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "lazy-provider-unit".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.templates.push(container_ir::Template {
        id: "template:main.wxml".into(),
        wxml_ast: pointer.clone(),
        bindings: vec!["value".into()],
        wxs_modules: BTreeMap::new(),
    });
    manifest.refresh_integrity().unwrap();
    (
        manifest,
        Arc::new(BTreeMap::from([(pointer, bytes)])),
        BTreeMap::from([("template:main.wxml".into(), ast)]),
        vec![ViewRenderTask {
            task_id: "main".into(),
            scope_id: "page:one".into(),
            document_id: "main.wxml".into(),
            data: json!({"value":1}),
        }],
    )
}

#[test]
fn verified_empty_program_and_cache_hit_never_create_or_load_a_realm() {
    let (mut view, state) = execution();
    let (manifest, resources, _, _) = program();
    let budget = ViewExecutionBudget::default();
    for expected_hit in [false, true] {
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        assert_eq!(view.metrics.preparation.cache_hit, expected_hit);
        assert!(view.engine.is_none());
        assert!(view.pending_empty_legacy);
        assert_eq!(view.metrics.preparation.provider_initialization_ns, 0);
        assert_eq!(view.metrics.preparation.provider_ns, 0);
    }
    assert_eq!(state.borrow().creations, 0);
    assert!(state.borrow().loads.is_empty());
}

#[test]
fn a_frontier_without_any_document_profile_does_not_create_a_provider() {
    let (mut view, state) = execution();
    let (mut manifest, _, _, _) = program();
    manifest.templates.clear();
    manifest.refresh_integrity().unwrap();
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &Arc::default(), &budget)
        .unwrap();
    assert!(view
        .render_documents(&manifest, &BTreeMap::new(), &[], &budget)
        .unwrap()
        .is_empty());
    assert!(view.engine.is_none());
    assert!(!view.pending_empty_legacy);
    assert_eq!(state.borrow().creations, 0);
    assert!(state.borrow().calls.is_empty());
}

#[test]
fn first_frontier_uses_one_original_remaining_budget_for_every_native_stage() {
    let (mut view, state) = execution();
    let (manifest, resources, documents, tasks) = program();
    let budget = ViewExecutionBudget::default();
    assert_eq!(budget.timeout, Duration::from_millis(50));
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    // Model ten milliseconds already spent by this same frontier without a
    // sleep, retry, shortened native watchdog or mutable production clock.
    let started = Instant::now()
        .checked_sub(Duration::from_millis(10))
        .unwrap();
    let mut metrics = ViewFrontierMetrics::default();
    view.render_documents_inner(
        &manifest,
        &documents,
        &tasks,
        &budget,
        started,
        &mut metrics,
    )
    .unwrap();
    assert!(metrics.provider_ns > 0);
    assert!(!view.pending_empty_legacy);
    {
        let state = state.borrow();
        assert_eq!(state.creations, 1);
        assert_eq!(state.loads, vec![Vec::<String>::new()]);
        assert_eq!(state.registrations, 1);
        assert_eq!(state.renders, 1);
        assert_eq!(
            state
                .calls
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>(),
            ["load", "register", "render"]
        );
        let mut previous = Duration::from_millis(40);
        for (_, allowance) in &state.calls {
            assert!(allowance.timeout <= previous);
            assert!(Arc::ptr_eq(&allowance.cancellation, &budget.cancellation));
            previous = allowance.timeout;
        }
    }
    view.render_documents(&manifest, &documents, &tasks, &budget)
        .unwrap();
    let state = state.borrow();
    assert_eq!(state.creations, 1);
    assert_eq!(state.loads.len(), 1);
    assert_eq!(state.registrations, 1);
    assert_eq!(state.renders, 2, "stateful work still executes each time");
}

#[test]
fn cancellation_before_first_frontier_cannot_create_a_provider_or_retry_it() {
    let (mut view, state) = execution();
    let (manifest, resources, documents, tasks) = program();
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    budget.cancellation.store(true, Ordering::Release);
    assert_eq!(
        view.render_documents(&manifest, &documents, &tasks, &budget)
            .unwrap_err()
            .code,
        BridgeErrorCode::Cancelled
    );
    assert!(view.is_faulted());
    budget.cancellation.store(false, Ordering::Release);
    assert!(view
        .render_documents(&manifest, &documents, &tasks, &budget)
        .is_err());
    assert_eq!(state.borrow().creations, 0);
    assert!(state.borrow().calls.is_empty());
}

#[test]
fn cancellation_during_creation_or_empty_load_never_registers_or_reauthorizes() {
    for cancel_in_constructor in [true, false] {
        let (mut view, state) = execution();
        let (manifest, resources, documents, tasks) = program();
        let budget = ViewExecutionBudget::default();
        view.prepare_verified_modules(&manifest, &resources, &budget)
            .unwrap();
        if cancel_in_constructor {
            state.borrow_mut().cancel_on_create = Some(Arc::clone(&budget.cancellation));
        } else {
            state.borrow_mut().cancel_on_load = Some(Arc::clone(&budget.cancellation));
        }
        assert_eq!(
            view.render_documents(&manifest, &documents, &tasks, &budget)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert!(view.is_faulted());
        budget.cancellation.store(false, Ordering::Release);
        assert!(view
            .render_documents(&manifest, &documents, &tasks, &budget)
            .is_err());
        let state = state.borrow();
        assert_eq!(state.creations, 1);
        assert_eq!(state.loads.len(), usize::from(!cancel_in_constructor));
        assert_eq!(state.registrations, 0);
        assert_eq!(state.renders, 0);
    }
}

#[test]
fn elapsed_frontier_budget_is_not_replaced_by_an_initialization_allowance() {
    let (mut view, state) = execution();
    let (manifest, resources, documents, tasks) = program();
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    let started = Instant::now()
        .checked_sub(budget.timeout + Duration::from_millis(1))
        .unwrap();
    assert_eq!(
        view.render_documents_inner(
            &manifest,
            &documents,
            &tasks,
            &budget,
            started,
            &mut ViewFrontierMetrics::default(),
        )
        .unwrap_err()
        .code,
        BridgeErrorCode::Timeout
    );
    assert_eq!(state.borrow().creations, 0);
    assert!(state.borrow().calls.is_empty());
}

#[test]
fn an_existing_nonempty_registry_is_actually_cleared_when_the_program_becomes_empty() {
    let (mut view, state) = execution();
    let (empty, resources, documents, tasks) = program();
    let mut executable = empty.clone();
    let bytes = b"exports.value = 1;".to_vec();
    let hash = container_ir::hex_digest(&bytes);
    executable
        .view_scripts
        .push(container_ir::ViewScriptModule {
            id: "wxs:tools.wxs".into(),
            sha256: hash.clone(),
            dependencies: vec![],
        });
    executable.refresh_integrity().unwrap();
    let mut blobs = resources.as_ref().clone();
    blobs.insert(format!("sha256:{hash}"), bytes);
    let budget = ViewExecutionBudget::default();
    view.prepare_modules(&executable, &blobs, &budget).unwrap();
    assert_eq!(state.borrow().creations, 1);
    assert!(!view.pending_empty_legacy);
    view.render_documents(&executable, &documents, &tasks, &budget)
        .unwrap();
    let prior = view.registered_documents[0]
        .as_ref()
        .unwrap()
        .handle
        .clone();

    view.prepare_verified_modules(&empty, &resources, &budget)
        .unwrap();
    assert!(!view.pending_empty_legacy);
    assert!(view.registered_documents[0].is_none());
    assert!(state.borrow().registry.key(&prior).is_err());
    assert_eq!(
        state.borrow().loads,
        vec![vec!["wxs:tools.wxs".to_owned()], vec![]]
    );
    view.render_documents(&empty, &documents, &tasks, &budget)
        .unwrap();
    let state = state.borrow();
    assert_eq!(state.creations, 1, "the existing realm is retained");
    assert_eq!(state.loads.len(), 2, "empty load is not deferred again");
    assert_eq!(state.registrations, 2, "old handles must be replaced");
}

#[test]
fn invalid_first_frontier_does_not_allocate_the_deferred_provider() {
    let (mut view, state) = execution();
    let (manifest, resources, documents, mut tasks) = program();
    let budget = ViewExecutionBudget::default();
    view.prepare_verified_modules(&manifest, &resources, &budget)
        .unwrap();
    tasks.push(tasks[0].clone());
    assert!(view
        .render_documents(&manifest, &documents, &tasks, &budget)
        .is_err());
    assert!(view.engine.is_none());
    assert!(view.pending_empty_legacy);
    assert_eq!(state.borrow().creations, 0);
}
