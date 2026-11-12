use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn fixture(source: &[u8]) -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("wx.nextTick".into(), "full".into()),
            ("wx.requestIdleCallback".into(), "full".into()),
            ("wx.cancelIdleCallback".into(), "full".into()),
            ("wx.onError".into(), "full".into()),
        ]))
        .unwrap();
    let module = JsEngine::load_module(&mut engine, source).unwrap();
    (engine, module)
}
fn call(engine: &mut NativeEngine, module: ModuleId, export: &str) -> Value {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: export.into(),
        },
        vec![],
    )
    .unwrap()
    .remove(0)
}
fn idle(engine: &mut NativeEngine) {
    engine
        .poll_turn_scheduler(Some(Instant::now() + Duration::from_millis(50)))
        .unwrap();
}

#[test]
fn scheduler_native_frontier_and_per_task_microtask_checkpoint() {
    let (mut engine,module)=fixture(br#"
      let trace=[];exports.queue=function(){const result=wx.nextTick(function(){trace.push('first');Promise.resolve().then(function(){trace.push('micro');wx.nextTick(function(){trace.push('later')})})});wx.nextTick(function(){trace.push('second')});return result===undefined;};
      exports.state=function(){return [trace]};
    "#);
    assert_eq!(call(&mut engine, module, "queue"), json!(true));
    assert_eq!(call(&mut engine, module, "state"), json!([]));
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!(["first", "micro", "second"])
    );
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!(["first", "micro", "second", "later"])
    );
}

#[test]
fn scheduler_native_idle_requires_host_window_and_returns_after_one() {
    let (mut engine,module)=fixture(br#"
      let trace=[];exports.queue=function(){wx.requestIdleCallback(function(v){trace.push(v)});wx.requestIdleCallback(function(v){trace.push(v)});return true};exports.state=()=>[trace];
    "#);
    call(&mut engine, module, "queue");
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!([]));
    engine
        .poll_turn_scheduler(Some(Instant::now() - Duration::from_millis(1)))
        .unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!([]));
    idle(&mut engine);
    assert_eq!(
        call(&mut engine, module, "state"),
        json!([{"errMsg":"requestIdleCallback:ok"}])
    );
    idle(&mut engine);
    assert_eq!(
        call(&mut engine, module, "state").as_array().unwrap().len(),
        2
    );
}

#[test]
fn scheduler_native_timer_readiness_blocks_idle_but_timeout_fallback_runs() {
    let (mut engine,module)=fixture(br#"
      let trace=[];exports.queue=function(){setTimeout(function(){},0);wx.requestIdleCallback(function(){trace.push('idle')});wx.requestIdleCallback(function(){trace.push('timeout')},{timeout:0});return true};exports.state=()=>[trace];
    "#);
    call(&mut engine, module, "queue");
    idle(&mut engine);
    assert_eq!(call(&mut engine, module, "state"), json!(["timeout"]));
}

#[test]
fn scheduler_native_cancellation_policy_and_terminal_retirement() {
    let (mut engine,module)=fixture(br#"
      let trace=[];exports.queue=function(){wx.nextTick(function(){trace.push('tick')});wx.cancelIdleCallback(1);const id=wx.requestIdleCallback(function(){trace.push('cancelled')});wx.cancelIdleCallback(id);return true};exports.state=()=>[trace];
    "#);
    call(&mut engine, module, "queue");
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!(["tick"]));
    call(&mut engine, module, "queue");
    engine
        .dispatch_lifecycle_notification("retire", &Value::Null)
        .unwrap();
    idle(&mut engine);
    assert_eq!(call(&mut engine, module, "state"), json!(["tick"]));
}

#[test]
fn scheduler_native_page_incarnation_and_public_owner_alias_tampering() {
    let (mut engine,module)=fixture(br#"
      let trace=[];Page({queue:function(){wx.nextTick(function(){trace.push('old')})}});exports.state=()=>[trace];
      exports.poison=function(){__container_run_with_api_owner=function(owner,fn){return fn()};__container_capture_api_owner=()=>null;return true};
    "#);
    engine
        .prepare_page_mirror(
            "initial",
            &json!([{"index":0,"instanceId":11,"route":"scheduler"}]),
        )
        .unwrap();
    engine.commit_page_mirror("initial").unwrap();
    call(&mut engine, module, "poison");
    for hook in ["queue", "onUnload"] {
        JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_invoke_page_instance".into(),
            },
            vec![json!(11), json!(0), json!(hook), json!([])],
        )
        .unwrap();
    }
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!([]));
}

#[test]
fn scheduler_native_hide_show_and_callback_error_isolation() {
    let (mut engine,module)=fixture(br#"
      let trace=[];wx.onError(function(){trace.push('error')});exports.queue=function(){wx.nextTick(function(){throw Error('task')});wx.nextTick(function(){trace.push('after')});return true};exports.state=()=>[trace];
    "#);
    call(&mut engine, module, "queue");
    engine
        .dispatch_lifecycle_notification("hide", &Value::Null)
        .unwrap();
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!([]));
    engine
        .dispatch_lifecycle_notification("show", &Value::Null)
        .unwrap();
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!(["error", "after"])
    );
}

#[test]
fn scheduler_native_retained_driver_ignores_guest_aliases() {
    let (mut engine,module)=fixture(br#"
      let result=false;exports.queue=function(){wx.nextTick(function(){result=true});globalThis.__container_turn_scheduler={capture:function(){throw Error('forged')}};globalThis.__container_scheduler_timer_ready=function(){return false};globalThis.__receiver_capture=function(){throw Error('forged')};return true};exports.state=()=>result;
    "#);
    call(&mut engine, module, "queue");
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!(true));
}

#[test]
fn scheduler_native_dispatch_budget_preserves_pending_backlog() {
    let (mut engine,module)=fixture(br#"
      let count=0;exports.queue=function(){for(let i=0;i<65;i++)wx.nextTick(function(){count++});return true};exports.state=()=>count;
    "#);
    call(&mut engine, module, "queue");
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!(64));
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!(65));
}
