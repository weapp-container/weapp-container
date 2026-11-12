// Shared native-engine contract tests. These do not claim renderer evidence.
use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};
fn basic_fixture(source: &[u8]) -> (NativeEngine, ModuleId) {
    basic_fixture_with_stack(source, true)
}
fn basic_fixture_with_stack(source: &[u8], trusted: bool) -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("wx.createSelectorQuery".into(), "full".into()),
        ]))
        .unwrap();
    assert!(engine
        .dispatch_lifecycle_notification("session", &Value::Null)
        .unwrap());
    let module = JsEngine::load_module(&mut engine, source).unwrap();
    let pages = json!([{"index":0,"instanceId":1,"route":"pages/selector","options":{}}]);
    if trusted {
        basic_mirror(&mut engine, "initial", pages);
    } else {
        JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_set_current_pages".into(),
            },
            vec![json!([0]), pages],
        )
        .unwrap();
    }
    (engine, module)
}
fn basic_mirror(engine: &mut NativeEngine, token: &str, pages: Value) {
    engine.prepare_page_mirror(token, &pages).unwrap();
    engine.commit_page_mirror(token).unwrap();
}
fn basic_call(engine: &mut NativeEngine, module: ModuleId, export: &str) -> Value {
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
fn basic_deliver(engine: &mut NativeEngine, ticket: &Value, result: Value) -> bool {
    let accepted = engine
        .dispatch_lifecycle_notification(
            "selectorQuery",
            &json!({"ticket":ticket,"result":result,"error":null}),
        )
        .unwrap();
    JsEngine::drain_microtasks(engine).unwrap();
    accepted
}
#[test]
fn basic_selector_exec_preserves_mixed_batch_promise_extension_without_invented_cursor() {
    let(mut engine,module)=basic_fixture(br#"
      Page({});let trace=[],q;
      exports.queue=()=>{q=wx.createSelectorQuery();const a=q.select('#a'),b=q.selectAll('.b');a.boundingClientRect(v=>trace.push(['a',v]));b.scrollOffset(v=>trace.push(['b',v]));const r=q.exec(v=>trace.push(['exec',v]));r.then(v=>trace.push(['then',v])).finally(()=>trace.push(['finally']));return {nodes:typeof r.boundingClientRect==='function'&&typeof r.scrollOffset==='function',promise:r instanceof Promise};};
      exports.reuse=()=>{q.selectViewport().scrollOffset();q.exec();return true;};exports.state=()=>({trace});
    "#);
    assert_eq!(
        basic_call(&mut engine, module, "queue"),
        json!({"nodes":false,"promise":true})
    );
    let state = engine.capture_selector_query_requests(0).unwrap();
    let batch = &state["requests"][0];
    assert_eq!(batch["options"]["queries"][0]["selector"], json!("#a"));
    assert_eq!(batch["options"]["queries"][1]["all"], json!(true));
    assert!(basic_deliver(
        &mut engine,
        &batch["ticket"],
        json!([{"id":"a","dataset":{"n":7}},[]])
    ));
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":[["a",{"id":"a","dataset":{"n":7}}],["b",[]],["exec",[{"id":"a","dataset":{"n":7}},[]]],["then",[{"id":"a","dataset":{"n":7}},[]]],["finally"]]})
    );
    assert!(!basic_deliver(&mut engine, &batch["ticket"], json!([])));
    basic_call(&mut engine, module, "reuse");
    let next = engine.capture_selector_query_requests(1).unwrap();
    assert_eq!(next["requests"].as_array().unwrap().len(), 1);
    assert_eq!(
        next["requests"][0]["options"]["queries"][0]["target"],
        json!("viewport")
    );
}
#[test]
fn basic_selector_private_capture_and_delivery_ignore_public_aliases_and_receiver_properties() {
    let(mut engine,module)=basic_fixture(br#"
      Page({});let trace=[];
      exports.queue=()=>{const receiver=getCurrentPages()[0],q=wx.createSelectorQuery().in(receiver);q.select('#a').boundingClientRect(v=>trace.push(v));q.exec();globalThis.__container_api_pending={};globalThis.__container_events.length=0;globalThis.__container_api_call=()=>{throw Error('public call');};globalThis.__container_resolve_api=()=>{throw Error('public result');};globalThis.__container_page_instances={};globalThis.__container_component_scopes={};globalThis.__container_run_with_api_owner=()=>{throw Error('public owner');};Object.defineProperty(receiver,'__container_instance_id',{get(){throw Error('public id');}});return true;};exports.state=()=>({trace});
    "#);
    basic_call(&mut engine, module, "queue");
    let state = engine.capture_selector_query_requests(0).unwrap();
    let batch = &state["requests"][0];
    assert_eq!(
        engine.capture_selector_query_receivers(1, &[]).unwrap(),
        batch["receivers"]
    );
    assert!(basic_deliver(
        &mut engine,
        &batch["ticket"],
        json!([{"id":"","dataset":{"enabled":false}}])
    ));
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":[{"id":"","dataset":{"enabled":false}}]})
    );
}
#[test]
fn basic_selector_earlier_callback_disposal_retires_remaining_callbacks() {
    let(mut engine,module)=basic_fixture(br#"
      Page({});let trace=[];exports.queue=()=>{const q=wx.createSelectorQuery();q.select('#a').boundingClientRect(()=>{trace.push('dispose');__container_invoke_page_instance(1,0,'onUnload',[]);});q.select('#b').boundingClientRect(()=>trace.push('forbidden'));q.exec(()=>trace.push('forbidden-exec')).catch(e=>trace.push(e.code));return true;};exports.state=()=>({trace});
    "#);
    basic_call(&mut engine, module, "queue");
    let state = engine.capture_selector_query_requests(0).unwrap();
    basic_deliver(
        &mut engine,
        &state["requests"][0]["ticket"],
        json!([{}, {}]),
    );
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":["dispose","ERR_CANCELLED"]})
    );
}
#[test]
fn basic_selector_same_id_replacement_and_terminal_retirement_never_transfer_callbacks() {
    let(mut engine,module)=basic_fixture(br#"
      Page({});let trace=[];exports.queue=()=>{wx.createSelectorQuery().select('#a').boundingClientRect(()=>trace.push('old')).exec().catch(e=>trace.push(e.code));return true;};exports.unload=()=>{__container_invoke_page_instance(1,0,'onUnload',[]);return true;};exports.state=()=>({trace});
    "#);
    basic_call(&mut engine, module, "queue");
    let old = engine.capture_selector_query_requests(0).unwrap();
    basic_call(&mut engine, module, "unload");
    basic_mirror(&mut engine, "removed", json!([]));
    basic_mirror(
        &mut engine,
        "reused",
        json!([{"index":0,"instanceId":1,"route":"pages/selector","options":{}}]),
    );
    basic_deliver(&mut engine, &old["requests"][0]["ticket"], json!([{}]));
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":["ERR_CANCELLED"]})
    );
    basic_call(&mut engine, module, "queue");
    let next = engine.capture_selector_query_requests(1).unwrap();
    assert_ne!(
        old["requests"][0]["receivers"]["pageToken"],
        next["requests"][0]["receivers"]["pageToken"]
    );
    engine
        .dispatch_lifecycle_notification("retire", &Value::Null)
        .unwrap();
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert!(!basic_deliver(
        &mut engine,
        &next["requests"][0]["ticket"],
        json!([{}])
    ));
    assert_eq!(
        engine.capture_selector_query_requests(2).unwrap(),
        json!({"requests":[]})
    );
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":["ERR_CANCELLED","ERR_CANCELLED"]})
    );
}

#[test]
fn basic_selector_ordinary_stack_keeps_private_owner_and_revokes_stale_callbacks() {
    let (mut engine, module) = basic_fixture_with_stack(
        br#"
      Page({});let trace=[];
      exports.queue=function(){
        const page=getCurrentPages()[0];
        globalThis.__container_current_page_instances=[];
        const q=wx.createSelectorQuery();
        q.select('#a').boundingClientRect(function(){
          trace.push(['first',__container_capture_api_owner()===page]);
          __container_invoke_page_instance('1',0,'onUnload',[]);
        });
        q.select('#b').boundingClientRect(function(value){trace.push(['stale',value]);});
        q.exec().catch(function(error){trace.push(error.code);});
        return true;
      };
      exports.state=function(){return {trace};};
    "#,
        false,
    );
    basic_call(&mut engine, module, "queue");
    let state = engine.capture_selector_query_requests(0).unwrap();
    let request = &state["requests"][0];
    assert_eq!(request["owner"], json!({"pageId":"1","scopeId":null}));
    assert!(request["receivers"]["pageToken"].is_string());
    assert!(basic_deliver(
        &mut engine,
        &request["ticket"],
        json!([{"id":"a"},{"id":"b"}])
    ));
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        // Private Page authority survives poisoned aliases, while an unscoped
        // context-free query keeps the legacy absence of callback owner context.
        json!({"trace":[["first",false],"ERR_CANCELLED"]})
    );
}

#[test]
fn basic_selector_fallback_page_authority_cannot_retarget_after_navigation_or_alias_poisoning() {
    let (mut engine, module) = basic_fixture(
        br#"
      Page({});Page({});let trace=[],builder,original;
      exports.queue=function(){
        original=getCurrentPages()[0];builder=wx.createSelectorQuery();
        builder.select('#old').boundingClientRect(()=>trace.push('forbidden-old'));
        builder.exec().catch(error=>trace.push(['pending',error.code]));return true;
      };
      exports.retarget=function(){
        const pages=getCurrentPages(),next=pages[pages.length-1];
        globalThis.__container_current_page_instances=[original];
        globalThis.__container_page_instances={'1':original};
        // Clearing an invalid selection scope cannot adopt the other Page.
        builder.in(next).in(null).select('#new').boundingClientRect(()=>trace.push('forbidden-new'));
        builder.exec().catch(error=>trace.push(['builder',error.code]));return true;
      };
      exports.state=()=>({trace});
    "#,
    );
    basic_call(&mut engine, module, "queue");
    let captured = engine.capture_selector_query_requests(0).unwrap();
    let request = &captured["requests"][0];
    assert_eq!(request["owner"], json!({"pageId":"1","scopeId":null}));
    basic_mirror(
        &mut engine,
        "navigate",
        json!([
            {"index":0,"instanceId":1,"route":"pages/selector","options":{}},
            {"index":1,"instanceId":2,"route":"pages/next","options":{}}
        ]),
    );
    basic_call(&mut engine, module, "retarget");
    assert_eq!(
        engine.capture_selector_query_requests(1).unwrap(),
        json!({"requests":[]})
    );
    assert!(basic_deliver(
        &mut engine,
        &request["ticket"],
        json!([{"id":"old"}])
    ));
    assert_eq!(
        basic_call(&mut engine, module, "state"),
        json!({"trace":[
            ["builder","ERR_CANCELLED"],["pending","ERR_CANCELLED"]
        ]})
    );
}

#[test]
fn basic_selector_private_scope_and_queues_ignore_inherited_setters() {
    let (mut engine, module) = basic_fixture(br#"
      Page({});
      __container_registration_module_id='selector:component';
      __container_managed_component_modules['selector:component']=true;
      Component({});__container_registration_module_id=null;
      exports.queue=function(){
        __container_reconcile_components({version:1,phase:'prepare',pageId:1,instances:[{scopeId:'scope',moduleId:'selector:component',parentScopeId:null,ownerScopeId:null,properties:{}}],remove:[]});
        const component=__container_component_scopes.scope;
        Object.defineProperty(Object.prototype,'scope',{configurable:true,get(){return null;},set(value){}});
        Object.defineProperty(Object.prototype,'scopeId',{configurable:true,get(){return null;},set(value){}});
        Object.defineProperty(Array.prototype,'0',{configurable:true,get(){throw Error('inherited queue index');},set(value){}});
        wx.createSelectorQuery().in(component).select('#secret').boundingClientRect().exec();
        return true;
      };
      exports.restore=function(){delete Object.prototype.scope;delete Object.prototype.scopeId;delete Array.prototype[0];return true;};
    "#);
    basic_call(&mut engine, module, "queue");
    let state = engine.capture_selector_query_requests(0).unwrap();
    assert_eq!(
        state["requests"][0]["options"]["queries"][0]["scopeId"],
        json!("scope")
    );
    assert!(state["requests"][0]["receivers"]["scopes"]["scope"].is_string());
    basic_call(&mut engine, module, "restore");
}
