use container_core::ViewEngineErrorCode;
use container_engine_v8::{V8Config, V8ViewEngine};

#[cfg(not(feature = "v8-native"))]
#[test]
fn view_provider_never_falls_back_to_a_stub() {
    let error = V8ViewEngine::new(V8Config::default()).unwrap_err();
    assert_eq!(error.code, ViewEngineErrorCode::Unavailable);
    assert!(error.to_string().starts_with("ERR_ENGINE:"));
}

#[cfg(feature = "v8-native")]
mod native {
    use super::*;
    use container_core::{
        CallTarget, JsEngine, ViewEngine, ViewExecutionBudget, ViewExpressionTask,
        ViewModuleSource, ViewValue,
    };
    use container_engine_v8::V8Engine;
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        sync::{atomic::Ordering, Arc},
        time::Duration,
    };

    fn budget() -> ViewExecutionBudget {
        ViewExecutionBudget::new(Duration::from_secs(2))
    }

    fn module(source: &str) -> ViewModuleSource {
        ViewModuleSource {
            compilation: None,
            id: "wxs:shared/main.wxs".into(),
            source: source.into(),
            dependencies: Vec::new(),
        }
    }

    fn task(id: &str, scope: &str, expression: &str) -> ViewExpressionTask {
        ViewExpressionTask {
            task_id: id.into(),
            scope_id: scope.into(),
            document_id: "pages/index/index.wxml".into(),
            expression: expression.into(),
            data: json!({}),
            bindings: BTreeMap::from([("tools".into(), "wxs:shared/main.wxs".into())]),
        }
    }

    #[test]
    fn view_uses_an_independent_realm_and_scope_owned_lazy_module_caches() {
        let mut app = V8Engine::new(V8Config::default());
        let app_module = JsEngine::load_module(
            &mut app,
            b"globalThis.__appservice_only = 'secret'; exports.value = function(){return 7;};",
        )
        .unwrap();
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        let budget = budget();
        view.load_modules(
            &[module(
                "var count = 0; module.exports = {next: function(){return ++count;}, globals: function(){return [typeof wx, typeof App, typeof Page, typeof Component, typeof getApp, typeof setTimeout, typeof setInterval, typeof __container_storage, typeof __appservice_only];}};",
            )],
            &budget,
        )
        .unwrap();
        let results = view
            .evaluate_batch(
                &[
                    task("first", "page:1", "tools.next()"),
                    task("second", "page:1", "tools.next()"),
                    task("separate", "page:2", "tools.next()"),
                    task("globals", "page:1", "tools.globals()"),
                ],
                &budget,
            )
            .unwrap();
        assert_eq!(results[0].value, ViewValue::Number(1.0));
        assert_eq!(results[1].value, ViewValue::Number(2.0));
        assert_eq!(results[2].value, ViewValue::Number(1.0));
        assert_eq!(
            results[3].value,
            ViewValue::Array(vec![ViewValue::String("undefined".into()); 9])
        );
        assert_eq!(Arc::strong_count(&budget.cancellation), 1);

        let mut candidate = V8ViewEngine::new(V8Config::default()).unwrap();
        candidate
            .load_modules(
                &[module("module.exports = {next: function(){return 100;}};")],
                &budget,
            )
            .unwrap();
        drop(candidate);
        assert_eq!(
            view.evaluate_batch(&[task("retained", "page:1", "tools.next()")], &budget)
                .unwrap()[0]
                .value,
            ViewValue::Number(3.0)
        );
        assert_eq!(
            JsEngine::call(
                &mut app,
                CallTarget::Module {
                    id: app_module,
                    export: "value".into()
                },
                Vec::new(),
            )
            .unwrap(),
            vec![json!(7)]
        );
    }

    #[test]
    fn view_and_appservice_microtask_queues_are_not_pumped_by_view_calls() {
        let mut app = V8Engine::new(V8Config::default());
        let app_module = JsEngine::load_module(
            &mut app,
            b"var ready = 0; Promise.resolve().then(function(){ready = 1;}); exports.read = function(){return ready;};",
        )
        .unwrap();
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        let budget = budget();
        view.load_modules(
            &[module("var ready = 0; Promise.resolve().then(function(){ready = 1;}); exports.read = function(){return ready;};")],
            &budget,
        )
        .unwrap();
        for id in ["before-app-drain", "after-app-drain"] {
            assert_eq!(
                view.evaluate_batch(&[task(id, "page:1", "tools.read()")], &budget)
                    .unwrap()[0]
                    .value,
                ViewValue::Number(0.0)
            );
            if id == "before-app-drain" {
                assert_eq!(
                    JsEngine::call(
                        &mut app,
                        CallTarget::Module {
                            id: app_module,
                            export: "read".into()
                        },
                        Vec::new()
                    )
                    .unwrap(),
                    vec![json!(0)]
                );
                JsEngine::drain_microtasks(&mut app).unwrap();
            }
        }
        assert_eq!(
            JsEngine::call(
                &mut app,
                CallTarget::Module {
                    id: app_module,
                    export: "read".into()
                },
                Vec::new()
            )
            .unwrap(),
            vec![json!(1)]
        );
        let asynchronous = view
            .evaluate_batch(&[task("promise", "page:1", "Promise.resolve(1)")], &budget)
            .unwrap_err();
        assert_eq!(asynchronous.code, ViewEngineErrorCode::UnsupportedValue);
    }

    #[test]
    fn view_transport_uses_intrinsics_after_modules_replace_global_json() {
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        let budget = budget();
        view.load_modules(&[module("globalThis.JSON={parse:function(){while(true){}},stringify:function(){while(true){}}}; exports.read = function(){return 42;};")], &budget).unwrap();
        for id in ["first", "second"] {
            assert_eq!(
                view.evaluate_batch(&[task(id, "page:1", "tools.read()")], &budget)
                    .unwrap()[0]
                    .value,
                ViewValue::Number(42.0)
            );
        }
    }

    #[test]
    fn view_timeout_covers_module_require_and_diagnostic_getters_and_requires_reset() {
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        for source in [
            "while(true){}",
            "throw Object.defineProperty({}, 'message', {get:function(){while(true){}}});",
            "module.exports = {get value(){while(true){}}};",
        ] {
            view.load_modules(&[module(source)], &budget()).unwrap();
            let short = ViewExecutionBudget::new(Duration::from_millis(30));
            let error = view
                .evaluate_batch(&[task("timeout", "page:1", "tools.value")], &short)
                .unwrap_err();
            assert_eq!(error.code, ViewEngineErrorCode::Timeout);
            assert_eq!(Arc::strong_count(&short.cancellation), 1);
            assert_eq!(
                view.evaluate_batch(&[], &budget()).unwrap_err().code,
                ViewEngineErrorCode::RequiresReset
            );
            assert_eq!(
                view.load_modules(&[], &budget()).unwrap_err().code,
                ViewEngineErrorCode::RequiresReset
            );
            view.reset().unwrap();
            view.load_modules(&[module("exports.value = 9;")], &budget())
                .unwrap();
            assert_eq!(
                view.evaluate_batch(&[task("fresh", "page:1", "tools.value")], &budget())
                    .unwrap()[0]
                    .value,
                ViewValue::Number(9.0)
            );
        }
    }

    #[test]
    fn cancellation_interrupts_only_the_current_view_realm_and_joins_its_watchdog() {
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        view.load_modules(&[module("while(true){}")], &budget())
            .unwrap();
        let cancellation_budget = budget();
        let cancellation = Arc::clone(&cancellation_budget.cancellation);
        let worker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            cancellation.store(true, Ordering::Release);
        });
        let result = view.evaluate_batch(
            &[task("cancel", "page:1", "tools.value")],
            &cancellation_budget,
        );
        worker.join().unwrap();
        assert_eq!(result.unwrap_err().code, ViewEngineErrorCode::Cancelled);
        assert_eq!(Arc::strong_count(&cancellation_budget.cancellation), 1);
        assert_eq!(
            view.load_modules(&[], &budget()).unwrap_err().code,
            ViewEngineErrorCode::RequiresReset
        );
        view.reset().unwrap();
        view.load_modules(&[module("exports.value = 5;")], &budget())
            .unwrap();
        assert_eq!(
            view.evaluate_batch(&[task("after-reset", "page:1", "tools.value")], &budget())
                .unwrap()[0]
                .value,
            ViewValue::Number(5.0)
        );
        view.dispose();
        assert_eq!(
            view.evaluate_batch(&[], &budget()).unwrap_err().code,
            ViewEngineErrorCode::RequiresReset
        );
    }

    #[test]
    fn expired_and_precancelled_load_budgets_dispose_the_realm() {
        let mut view = V8ViewEngine::new(V8Config::default()).unwrap();
        assert_eq!(
            view.load_modules(&[], &ViewExecutionBudget::new(Duration::ZERO))
                .unwrap_err()
                .code,
            ViewEngineErrorCode::Timeout
        );
        view.reset().unwrap();
        let cancelled = budget();
        cancelled.cancellation.store(true, Ordering::Release);
        assert_eq!(
            view.load_modules(&[], &cancelled).unwrap_err().code,
            ViewEngineErrorCode::Cancelled
        );
        assert_eq!(
            view.evaluate_batch(&[], &budget()).unwrap_err().code,
            ViewEngineErrorCode::RequiresReset
        );
    }
}
