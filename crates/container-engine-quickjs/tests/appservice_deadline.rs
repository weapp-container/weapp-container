#![cfg(all(feature = "quickjs-native", not(target_arch = "wasm32")))]

use container_core::{CallTarget, EngineError, EngineErrorCode, EngineExecutionBudget, JsEngine};
use container_engine_quickjs::{QuickJsConfig, QuickJsEngine};
use std::{
    process::{Command, Stdio},
    sync::{atomic::AtomicBool, Arc},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CHILD_CASE: &str = "WEAPP_QUICKJS_DEADLINE_CHILD";

fn budget(timeout: Duration) -> EngineExecutionBudget {
    EngineExecutionBudget {
        timeout: Some(timeout),
        cancellation: None,
    }
}

fn engine() -> QuickJsEngine {
    QuickJsEngine::try_new_with_budget(QuickJsConfig::default(), budget(Duration::from_secs(2)))
        .expect("real QuickJS bootstrap")
}

fn global(name: &str) -> CallTarget {
    CallTarget::Global { name: name.into() }
}

fn assert_poisoned(engine: &mut QuickJsEngine, original: EngineErrorCode) {
    assert!(engine.is_execution_faulted());
    assert_eq!(engine.execution_fault().unwrap().code, original);
    let failure = JsEngine::call(engine, global("__container_registration_snapshot"), vec![])
        .expect_err("faulted engine must not execute again");
    assert_eq!(failure.code, EngineErrorCode::RequiresRestart);
    assert_eq!(
        engine
            .set_capabilities(&Default::default())
            .unwrap_err()
            .into_core_error()
            .code,
        EngineErrorCode::RequiresRestart
    );
}

fn run_timeout_case(case: &str) {
    let mut engine = engine();
    if case.starts_with("scheduler-") || case == "cancel-scheduler" {
        engine
            .set_capabilities(&std::collections::BTreeMap::from([
                ("wx.nextTick".into(), "partial".into()),
                ("wx.requestIdleCallback".into(), "partial".into()),
                ("wx.cancelIdleCallback".into(), "partial".into()),
                ("wx.onError".into(), "partial".into()),
            ]))
            .unwrap();
    }
    if case == "module" {
        let scope = engine
            .begin_host_turn(budget(Duration::from_millis(40)))
            .unwrap();
        let error = JsEngine::load_module(&mut engine, b"while (true) {}")
            .expect_err("module initialization must stop");
        assert_eq!(error.code, EngineErrorCode::Timeout);
        assert_eq!(scope.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert_eq!(engine.loaded_module_count(), 0);
        assert_poisoned(&mut engine, EngineErrorCode::Timeout);
        return;
    }
    if case == "evaluate" {
        engine
            .register_module_with_id("loop.js", b"while (true) {}", &[], false)
            .unwrap();
        let scope = engine
            .begin_host_turn(budget(Duration::from_millis(40)))
            .unwrap();
        let error = engine.evaluate_module_with_id("loop.js").unwrap_err();
        assert_eq!(error.code, EngineErrorCode::Timeout);
        assert_eq!(scope.finish().unwrap_err().code, EngineErrorCode::Timeout);
        assert_poisoned(&mut engine, EngineErrorCode::Timeout);
        return;
    }
    let source = match case {
        "call" | "cancel" => "exports.run = function() { while (true) {} };",
        "getter" => "exports.run = function() { return { get value() { while (true) {} } }; };",
        "to-json" => "exports.run = function() { return { toJSON() { while (true) {} } }; };",
        // Ordinary thrown-value projection reads own data only. Exercise the
        // supported API callback compatibility projection for diagnostic
        // getters/coercion, without restoring those reads to native errors.
        "error-message" => "exports.run = function() { __container_invoke_api_callback({success:function() { throw { get message() { while (true) {} } }; }}, 'success', {}); };",
        "error-stack" => "exports.run = function() { __container_invoke_api_callback({success:function() { throw { message: 'failed', get stack() { while (true) {} } }; }}, 'success', {}); };",
        "error-coercion" => "exports.run = function() { __container_invoke_api_callback({success:function() { throw { message: { toString() { while (true) {} } } }; }}, 'success', {}); };",
        // Only wx.onError registration owns delivery; the public handler
        // array is a diagnostic snapshot and cannot register a listener.
        "error-handler" => "wx.onError(function() { while (true) {} }); exports.run = function() { throw new Error('failed'); };",
        // Host installation no longer calls mutable Object.assign. Exercise
        // its actual cancellation gate, rather than relying on that old bug.
        "cancel-capabilities" => "Object.assign = function() { while (true) {} }; exports.run = function() { return 1; };",
        "drain-serialize" => "globalThis.__container_events.push({toJSON() { while (true) {} }}); exports.run = function() { return 1; };",
        "job" => "exports.run = function() { Promise.resolve().then(function() { while (true) {} }); return 1; };",
        "job-chain" => "function again() { Promise.resolve().then(again); } exports.run = function() { again(); return 1; };",
        "scheduler-tick" | "cancel-scheduler" => "wx.nextTick(function(){while(true){}});exports.run=function(){return 1};",
        "scheduler-idle" => "wx.requestIdleCallback(function(){while(true){}},{timeout:0});exports.run=function(){return 1};",
        "scheduler-job-chain" => "function again(){Promise.resolve().then(again)}wx.nextTick(again);exports.run=function(){return 1};",
        "scheduler-error-listener" => "wx.onError(function(){while(true){}});wx.nextTick(function(){throw Error('task')});exports.run=function(){return 1};",
        "timer" => "setTimeout(function() { while (true) {} }, 0); exports.run = function() { return 1; };",
        "drain-events" => "globalThis.__container_drain_events = function() { while (true) {} }; exports.run = function() { return 1; };",
        "module-batch" => "exports.run = function() { return 1; };",
        _ => panic!("unknown child case: {case}"),
    };
    let module = JsEngine::load_module(&mut engine, source.as_bytes()).unwrap();
    let cancellation = Arc::new(AtomicBool::new(false));
    let scope = engine
        .begin_host_turn(EngineExecutionBudget {
            timeout: Some(if case == "cancel" || case == "cancel-scheduler" {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(40)
            }),
            cancellation: case.starts_with("cancel").then_some(cancellation.clone()),
        })
        .unwrap();
    let cancel_thread = (case == "cancel" || case == "cancel-scheduler").then(|| {
        let cancellation = cancellation.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            cancellation.store(true, std::sync::atomic::Ordering::Release);
        })
    });
    if case == "cancel-capabilities" {
        cancellation.store(true, std::sync::atomic::Ordering::Release);
    }
    let error: EngineError = match case {
        "cancel-capabilities" => engine
            .set_capabilities(&Default::default())
            .unwrap_err()
            .into_core_error(),
        "drain-events" | "drain-serialize" => {
            engine.drain_host_events().unwrap_err().into_core_error()
        }
        "module-batch" => {
            use container_engine_quickjs::JsEngineAdapter;
            engine
                .load_module_batch(&[b"exports.value = 1;", b"while (true) {}"])
                .unwrap_err()
                .into_core_error()
        }
        "scheduler-tick"
        | "scheduler-idle"
        | "scheduler-job-chain"
        | "scheduler-error-listener"
        | "cancel-scheduler" => engine.poll_turn_scheduler(None).unwrap_err(),
        "timer" => {
            let now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            engine
                .drain_timers(now_ms + 1_000)
                .unwrap_err()
                .into_core_error()
        }
        "job" | "job-chain" => {
            JsEngine::call(
                &mut engine,
                CallTarget::Module {
                    id: module,
                    export: "run".into(),
                },
                vec![],
            )
            .unwrap();
            JsEngine::drain_microtasks(&mut engine).unwrap_err()
        }
        _ => JsEngine::call(
            &mut engine,
            CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            vec![],
        )
        .unwrap_err(),
    };
    if let Some(thread) = cancel_thread {
        thread.join().unwrap();
    }
    let expected = if case.starts_with("cancel") {
        EngineErrorCode::Cancelled
    } else {
        EngineErrorCode::Timeout
    };
    assert_eq!(error.code, expected, "case {case}: {error}");
    assert_eq!(engine.execution_fault().unwrap().code, expected);
    assert_eq!(scope.finish().unwrap_err().code, expected);
    assert_poisoned(&mut engine, expected);
}

/// Each deliberately infinite fixture executes only in an owned subprocess.
/// A regression fails this test after terminating that exact child process,
/// instead of hanging the Cargo test runner indefinitely.
#[test]
fn bounded_execution_has_an_external_watchdog() {
    if let Ok(case) = std::env::var(CHILD_CASE) {
        run_timeout_case(&case);
        return;
    }
    for case in [
        "module",
        "evaluate",
        "call",
        "getter",
        "to-json",
        "error-message",
        "error-stack",
        "error-coercion",
        "error-handler",
        "cancel-capabilities",
        "drain-serialize",
        "job",
        "job-chain",
        "timer",
        "drain-events",
        "module-batch",
        "scheduler-tick",
        "scheduler-idle",
        "scheduler-job-chain",
        "scheduler-error-listener",
        "cancel-scheduler",
        "cancel",
    ] {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "bounded_execution_has_an_external_watchdog",
                "--nocapture",
            ])
            .env(CHILD_CASE, case)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let stop = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                let output = child.wait_with_output().unwrap();
                assert!(
                    status.success(),
                    "deadline case {case} failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                break;
            }
            if Instant::now() >= stop {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "deadline case {case} exceeded its external watchdog: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

#[test]
fn unbounded_default_and_completed_turns_preserve_state() {
    let mut engine = engine();
    let module = JsEngine::load_module(
        &mut engine,
        b"let value = 0; exports.run = function() { return ++value; };",
    )
    .unwrap();
    for expected in [1, 2] {
        let scope = engine
            .begin_host_turn(budget(Duration::from_secs(1)))
            .unwrap();
        assert_eq!(
            JsEngine::call(
                &mut engine,
                CallTarget::Module {
                    id: module,
                    export: "run".into()
                },
                vec![],
            )
            .unwrap(),
            vec![serde_json::json!(expected)]
        );
        JsEngine::drain_microtasks(&mut engine).unwrap();
        scope.finish().unwrap();
    }
    assert!(!engine.is_execution_faulted());
}

#[test]
fn normal_exceptions_remain_recoverable() {
    let mut engine = engine();
    let module = JsEngine::load_module(
        &mut engine,
        b"exports.fail = function() { throw new Error('ordinary failure'); }; exports.ok = function() { return 42; };",
    )
    .unwrap();
    let scope = engine
        .begin_host_turn(budget(Duration::from_secs(1)))
        .unwrap();
    let error = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "fail".into(),
        },
        vec![],
    )
    .unwrap_err();
    assert_eq!(error.code, EngineErrorCode::Call);
    assert_eq!(error.message, "ordinary failure");
    scope.finish().unwrap();
    assert!(!engine.is_execution_faulted());
    assert_eq!(
        JsEngine::call(
            &mut engine,
            CallTarget::Module {
                id: module,
                export: "ok".into()
            },
            vec![],
        )
        .unwrap(),
        vec![serde_json::json!(42)]
    );
}

#[test]
fn bootstrap_failure_is_typed_and_abandonment_requires_restart() {
    let error =
        QuickJsEngine::try_new_with_budget(QuickJsConfig::default(), budget(Duration::ZERO))
            .unwrap_err();
    assert_eq!(error.code, EngineErrorCode::Timeout);
    let mut engine = engine();
    drop(
        engine
            .begin_host_turn(budget(Duration::from_secs(1)))
            .unwrap(),
    );
    assert_poisoned(&mut engine, EngineErrorCode::RequiresRestart);
}
