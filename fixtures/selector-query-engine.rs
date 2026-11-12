// Included by both native-engine test modules to enforce one facade contract.
use container_core::{CallTarget, JsEngine, ModuleId, ValueBatch};
use serde_json::{json, Value};

fn fixture() -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, include_bytes!("selector-query-engine.js"))
        .expect("selector fixture evaluates in the native engine");
    (engine, module)
}

fn call(engine: &mut NativeEngine, module: ModuleId, export: &str) -> ValueBatch {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: export.into(),
        },
        Vec::new(),
    )
    .expect("selector fixture method executes")
}

fn queued(engine: &mut NativeEngine) -> Vec<Value> {
    engine
        .drain_host_events()
        .expect("host effects drain")
        .into_iter()
        .flat_map(|batch| batch["events"].as_array().cloned().unwrap_or_default())
        .collect()
}

fn resolve(engine: &mut NativeEngine, id: &Value, result: Value, error: Value) -> ValueBatch {
    let value = JsEngine::call(
        engine,
        CallTarget::Global {
            name: "__container_resolve_api".into(),
        },
        vec![id.clone(), result, error],
    )
    .expect("provider completion resolves");
    JsEngine::drain_microtasks(engine).expect("selector callback jobs drain");
    value
}

#[test]
fn ordered_batch_preserves_selections_projection_and_callback_values() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1, "one provider call for the entire query");
    assert_eq!(events[0]["name"], "wx.createSelectorQuery");
    assert_eq!(
        events[0]["options"],
        json!({"queries": [
            {"selector":"#first","target":"node","all":false,"fields":{"dataset":true,"id":false},"operation":"fields","scopeId":"test-scope"},
            {"selector":".card","target":"node","all":true,"fields":null,"operation":"boundingClientRect","scopeId":"test-scope"},
            {"selector":"#missing","target":"node","all":false,"fields":null,"operation":"scrollOffset","scopeId":"test-scope"}
        ]})
    );
    assert_eq!(call(&mut engine, module, "state")[0]["trace"], json!([]));
    let values = json!([{"dataset":{"enabled":false,"empty":null}}, [], null]);
    assert_eq!(
        resolve(&mut engine, &events[0]["id"], values.clone(), Value::Null),
        vec![json!(true)]
    );
    assert_eq!(
        call(&mut engine, module, "state"),
        vec![json!({
            "trace":[["fields",values[0]],["rect",[]],["offset",null],["exec",values]],
            "result":values,
            "failure":null
        })]
    );
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        resolve(&mut engine, &events[0]["id"], json!([]), Value::Null),
        vec![json!(false)]
    );
}

#[test]
fn failed_batch_consumes_callbacks_and_query_reuse_has_only_fresh_operations() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "failing");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    resolve(
        &mut engine,
        &events[0]["id"],
        Value::Null,
        json!({"code":"ERR_RENDER","message":"frame is unavailable"}),
    );
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_RENDER"})
    );
    call(&mut engine, module, "reuse");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["options"]["queries"].as_array().unwrap().len(), 1);
    assert_eq!(events[0]["options"]["queries"][0]["selector"], "#fresh");
    resolve(&mut engine, &events[0]["id"], json!([false]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["fresh", false], ["fresh-exec", [false]]])
    );
    call(&mut engine, module, "empty");
    JsEngine::drain_microtasks(&mut engine).expect("empty exec callback drains");
    assert!(
        queued(&mut engine).is_empty(),
        "empty exec has no stale bridge work"
    );
    let state = call(&mut engine, module, "state");
    assert_eq!(
        state[0]["trace"],
        json!([
            ["fresh", false],
            ["fresh-exec", [false]],
            ["empty-exec", []]
        ])
    );
    assert_eq!(state[0]["result"], json!([]));
}

#[test]
fn invalid_selector_rejects_entire_batch_without_dispatching_or_stale_callbacks() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "invalid");
    JsEngine::drain_microtasks(&mut engine).expect("invalid query rejection drains");
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_INVALID_REQUEST"})
    );
    call(&mut engine, module, "reuse");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["options"]["queries"].as_array().unwrap().len(), 1);
    resolve(&mut engine, &events[0]["id"], json!([null]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["fresh", null], ["fresh-exec", [null]]])
    );
}

#[test]
fn malformed_provider_result_invokes_no_success_callbacks() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    resolve(
        &mut engine,
        &events[0]["id"],
        json!([{"dataset":{}}]),
        Value::Null,
    );
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_INVALID_REQUEST"})
    );
    call(&mut engine, module, "empty");
    JsEngine::drain_microtasks(&mut engine).expect("empty exec callback drains");
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["empty-exec", []]])
    );
}

#[test]
fn callback_exception_is_reported_and_remaining_batch_callbacks_complete() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "throwing");
    let events = queued(&mut engine);
    resolve(
        &mut engine,
        &events[0]["id"],
        json!([false, null]),
        Value::Null,
    );
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({
            "trace":[["after-throw",null],["exec",[false,null]]],
            "result":[false,null],"failure":null
        })
    );
    let effects = engine
        .drain_host_events()
        .expect("callback diagnostics drain");
    assert!(effects
        .iter()
        .flat_map(|batch| batch["errors"].as_array().into_iter().flatten())
        .any(|error| error["message"]
            .as_str()
            .is_some_and(|message| message.contains("selector callback failed"))));
}

#[test]
fn retained_nodes_refs_keep_their_original_targets_and_selection_scopes() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "retained");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    let queries = events[0]["options"]["queries"].as_array().unwrap();
    assert_eq!(queries.len(), 2, "an unused NodesRef adds no operation");
    assert_eq!(queries[0]["selector"], "#later");
    assert_eq!(queries[1]["selector"], "#retained");
    assert!(queries
        .iter()
        .all(|query| query["scopeId"] == "initial-scope"));
    resolve(
        &mut engine,
        &events[0]["id"],
        json!([false, null]),
        Value::Null,
    );
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["second", false], ["first", null], ["exec", [false, null]]])
    );
}

#[test]
fn unresolvable_scope_never_falls_back_to_an_unscoped_query() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "invalidScope");
    JsEngine::drain_microtasks(&mut engine).expect("invalid scope rejection drains");
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({
            "trace":[],"result":null,"failure":"ERR_INVALID_REQUEST"
        })
    );
}

#[test]
fn unsupported_execution_rejects_empty_and_queued_work_without_callbacks() {
    let (mut engine, module) = fixture();
    let mut capabilities = std::collections::BTreeMap::new();
    capabilities.insert(
        "wx.createSelectorQuery".to_owned(),
        "unsupported".to_owned(),
    );
    engine
        .set_capabilities(&capabilities)
        .expect("unsupported capability installs");
    call(&mut engine, module, "failing");
    JsEngine::drain_microtasks(&mut engine).expect("queued execution rejects");
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({
            "trace":[],"result":null,"failure":"ERR_UNSUPPORTED_CAPABILITY"
        })
    );
    call(&mut engine, module, "empty");
    JsEngine::drain_microtasks(&mut engine).expect("empty execution rejects");
    assert!(queued(&mut engine).is_empty());
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({
            "trace":[],"result":null,"failure":"ERR_UNSUPPORTED_CAPABILITY"
        })
    );
    capabilities.insert("wx.createSelectorQuery".to_owned(), "partial".to_owned());
    engine
        .set_capabilities(&capabilities)
        .expect("supported capability installs");
    call(&mut engine, module, "reuse");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["options"]["queries"].as_array().unwrap().len(), 1);
    assert_eq!(events[0]["options"]["queries"][0]["selector"], "#fresh");
    resolve(&mut engine, &events[0]["id"], json!([null]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["fresh", null], ["fresh-exec", [null]]])
    );
}

#[test]
fn native_selector_real_page_scope_is_unscoped_and_carries_actual_owner() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "pageScope");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1, "real Page .in(this) must dispatch once");
    assert_eq!(events[0]["options"]["queries"][0]["scopeId"], Value::Null);
    assert_eq!(events[0]["owner"], json!({"pageId":"1","scopeId":null}));
    resolve(
        &mut engine,
        &events[0]["id"],
        json!([{"width":320}]),
        Value::Null,
    );
    assert_eq!(
        call(&mut engine, module, "state")[0]["failure"],
        Value::Null
    );
    assert_eq!(
        call(&mut engine, module, "state")[0]["trace"],
        json!([["page",{"width":320}],["page-exec",[{"width":320}]]])
    );
}

#[test]
fn native_selector_real_component_scope_and_owner_are_preserved() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["owner"],
        json!({"pageId":"1","scopeId":"test-scope"})
    );
    assert!(events[0]["options"]["queries"]
        .as_array()
        .unwrap()
        .iter()
        .all(|query| query["scopeId"] == "test-scope"));
}

#[test]
fn native_selector_forged_public_scope_cannot_authorize_a_query() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "forgedScope");
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert!(
        queued(&mut engine).is_empty(),
        "public identity fields cannot grant scope"
    );
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_INVALID_REQUEST"})
    );
}

#[test]
fn native_selector_late_result_does_not_call_a_hidden_page_owner() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    call(&mut engine, module, "pushPage");
    resolve(&mut engine, &events[0]["id"], json!([1, 2, 3]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_late_result_cannot_transfer_to_a_reused_page_id() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    call(&mut engine, module, "replacePage");
    resolve(&mut engine, &events[0]["id"], json!([1, 2, 3]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_on_unload_retires_owner_before_page_mirror_publication() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    call(&mut engine, module, "unloadPage");
    resolve(&mut engine, &events[0]["id"], json!([1, 2, 3]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_public_alias_reinsertion_cannot_revive_retired_receiver() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    call(&mut engine, module, "reinsertRetiredScope");
    resolve(&mut engine, &events[0]["id"], json!([1, 2, 3]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_late_result_cannot_transfer_to_a_reused_component_scope() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "batch");
    let events = queued(&mut engine);
    call(&mut engine, module, "replaceScope");
    resolve(&mut engine, &events[0]["id"], json!([1, 2, 3]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_callback_disposal_stops_remaining_success_callbacks() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "disposeInCallback");
    let events = queued(&mut engine);
    resolve(&mut engine, &events[0]["id"], json!([1, 2]), Value::Null);
    assert_eq!(
        call(&mut engine, module, "state")[0],
        json!({"trace":[["first",1]],"result":null,"failure":"ERR_CANCELLED"})
    );
}

#[test]
fn native_selector_timer_queries_keep_unscoped_compatibility_and_explicit_page_identity() {
    for (method, owner) in [
        ("timerUnscoped", Value::Null),
        ("timerPageScope", json!({"pageId":"1","scopeId":null})),
    ] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, method);
        assert!(queued(&mut engine).is_empty());
        engine.drain_timers(8_000_000_000_000_000).unwrap();
        let events = queued(&mut engine);
        assert_eq!(
            events.len(),
            1,
            "{method}: timers must not lose selector capability"
        );
        assert_eq!(events[0]["owner"], owner, "{method}");
        assert_eq!(events[0]["options"]["queries"][0]["scopeId"], Value::Null);
        resolve(
            &mut engine,
            &events[0]["id"],
            json!([{"width":533}]),
            Value::Null,
        );
        assert_eq!(
            call(&mut engine, module, "state")[0],
            json!({"trace":[["timer",{"width":533}],["timer-exec",[{"width":533}]]],
                "result":[{"width":533}],"failure":null}),
            "{method}"
        );
    }
}
