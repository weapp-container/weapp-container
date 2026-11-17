use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn fixture(source: &[u8]) -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("wx.createMediaQueryObserver".into(), "full".into()),
        ]))
        .unwrap();
    assert!(engine
        .dispatch_lifecycle_notification("session", &Value::Null)
        .unwrap());
    let module = JsEngine::load_module(&mut engine, source).unwrap();
    mirror(
        &mut engine,
        "initial",
        json!([{"index":0,"instanceId":1,"route":"pages/media","options":{}}]),
    );
    (engine, module)
}

fn mirror(engine: &mut NativeEngine, id: &str, pages: Value) {
    engine.prepare_page_mirror(id, &pages).unwrap();
    engine.commit_page_mirror(id).unwrap();
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

fn notifications(snapshot: &Value, matches: bool) -> Value {
    Value::Array(snapshot["subscriptions"].as_array().unwrap().iter().map(|entry| json!({
        "observerId":entry["observerId"], "subscriptionId":entry["subscriptionId"],
        "ownerToken":entry["ownerToken"], "pageToken":entry["pageToken"], "value":{"matches":matches}
    })).collect())
}

#[test]
fn private_media_state_and_callbacks_survive_public_alias_replacement() {
    let (mut engine, module) = fixture(br#"
      let trace=[],reads=0,serialized=0;
      Page({});
      exports.observe=function(){
        const descriptor={minWidth:undefined,orientation:'portrait',toJSON(){serialized++;throw Error('codec');}};
        Object.defineProperty(descriptor,'width',{get(){reads++;return 100;}});
        descriptor.unknown=descriptor;
        const observer=getCurrentPages()[0].createMediaQueryObserver();
        const first=observer.observe(descriptor,function(value){'use strict';trace.push({value,unbound:this===undefined});value.matches=false;});
        const second=observer.observe({width:100},function(value){'use strict';trace.push({value,unbound:this===undefined});});
        globalThis.__container_observers={};globalThis.__container_observer_id=999;
        globalThis.__container_observer_subscription_id=999;
        globalThis.__container_notify_observers=function(){throw Error('public notifier');};
        globalThis.__container_events.length=0;
        return {first:first===undefined,second:second===undefined};
      };
      exports.state=function(){return {trace,reads,serialized};};
    "#);
    assert_eq!(
        call(&mut engine, module, "observe"),
        json!({"first":true,"second":true})
    );
    let state = engine.capture_media_query_state(None).unwrap();
    let subscriptions = state["subscriptions"].as_array().unwrap();
    assert_eq!(subscriptions.len(), 2);
    assert_eq!(
        subscriptions[0]["descriptor"],
        json!({"width":100,"orientation":"portrait"})
    );
    assert_ne!(
        subscriptions[0]["subscriptionId"],
        subscriptions[1]["subscriptionId"]
    );
    let revision = state["revision"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        engine.capture_media_query_state(Some(revision)).unwrap(),
        json!({"revision":revision.to_string(),"unchanged":true})
    );
    assert!(engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&state, true))
        .unwrap());
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"trace":[
        {"value":{"matches":false},"unbound":true},{"value":{"matches":true},"unbound":true}
    ],"reads":1,"serialized":0})
    );
}

#[test]
fn media_descriptor_survives_failed_public_serialization_and_nested_admission() {
    let (mut engine,module)=fixture(br#"
      Page({});let trace=[],once=false;
      const probe={toJSON(){if(!once){once=true;getCurrentPages()[0].createMediaQueryObserver().observe({height:200},value=>trace.push(['nested',value]));}throw Error('public codec');}};
      exports.queue=function(){
        const descriptor={width:100};getCurrentPages()[0].createMediaQueryObserver().observe(descriptor,value=>trace.push(['original',value]));
        descriptor.width=999;__container_events.push(probe);return true;
      };
      exports.repair=function(){__container_events.length=0;return true;};
      exports.state=function(){return {trace};};
    "#);
    call(&mut engine, module, "queue");
    let before = engine.capture_media_query_state(None).unwrap();
    assert_eq!(
        before["subscriptions"][0]["descriptor"],
        json!({"width":100})
    );
    assert!(engine.drain_host_events().is_err());
    let after = engine.capture_media_query_state(None).unwrap();
    assert_eq!(after["subscriptions"].as_array().unwrap().len(), 2);
    assert_eq!(
        after["subscriptions"][0]["descriptor"],
        json!({"width":100})
    );
    call(&mut engine, module, "repair");
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&after, true))
        .unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"trace":[["original",{"matches":true}],["nested",{"matches":true}]]})
    );
}

#[test]
fn media_descriptor_reentrancy_and_disconnect_getters_publish_no_partial_subscription() {
    let (mut engine,module)=fixture(br#"
      Page({});
      exports.run=function(){
        const page=getCurrentPages()[0],observer=page.createMediaQueryObserver();let reentrant;
        const descriptor={get width(){try{observer.observe({},function(){});}catch(error){reentrant=error.code;}return 100;}};
        observer.observe(descriptor,function(){});
        const closing=page.createMediaQueryObserver();let cancelled;
        try{closing.observe({get width(){closing.disconnect();return 100;}},function(){});}catch(error){cancelled=error.code;}
        const invalid=page.createMediaQueryObserver();let throwing;
        try{invalid.observe({get width(){throw Error('getter');}},function(){});}catch(error){throwing=error.code;}
        return {reentrant,cancelled,throwing};
      };
    "#);
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"reentrant":"ERR_INVALID_REQUEST","cancelled":"ERR_INVALID_REQUEST","throwing":"ERR_INVALID_REQUEST"})
    );
    let state = engine.capture_media_query_state(None).unwrap();
    assert_eq!(state["subscriptions"].as_array().unwrap().len(), 1);
    assert_eq!(
        state["subscriptions"][0]["descriptor"],
        json!({"width":100})
    );
}

#[test]
fn media_disconnect_fences_siblings_and_callback_errors_preserve_other_observers() {
    let (mut engine,module)=fixture(br#"
      Page({});let trace=[];
      exports.run=function(){
        const page=getCurrentPages()[0],first=page.createMediaQueryObserver();
        first.observe({},function(){trace.push('first');first.disconnect();throw Error('callback');});
        first.observe({},function(){trace.push('revoked');});
        page.createMediaQueryObserver().observe({},function(value){'use strict';trace.push(this===undefined&&value.matches?'other':'wrong');});
        return true;
      };
      exports.state=function(){return {trace};};
    "#);
    call(&mut engine, module, "run");
    let state = engine.capture_media_query_state(None).unwrap();
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&state, true))
        .unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"trace":["first","other"]})
    );
    let next = engine.capture_media_query_state(None).unwrap();
    assert_eq!(next["subscriptions"].as_array().unwrap().len(), 1);
}

#[test]
fn media_page_unload_and_same_textual_id_reuse_cannot_revive_old_callbacks() {
    let (mut engine,module)=fixture(br#"
      Page({});let held,trace=[];
      exports.old=function(){held=getCurrentPages()[0];held.createMediaQueryObserver().observe({},()=>trace.push('old'));return true;};
      exports.replacement=function(){getCurrentPages()[0].createMediaQueryObserver().observe({},()=>trace.push('new'));let rejected;try{held.createMediaQueryObserver();}catch(error){rejected=error.code;}return {rejected};};
      exports.state=function(){return {trace};};
    "#);
    call(&mut engine, module, "old");
    let old = engine.capture_media_query_state(None).unwrap();
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_invoke_page_instance".into(),
        },
        vec![json!(1), json!(0), json!("onUnload"), json!([])],
    )
    .unwrap();
    assert!(
        engine.capture_media_query_state(None).unwrap()["subscriptions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    mirror(&mut engine, "removed", json!([]));
    mirror(
        &mut engine,
        "reused",
        json!([{"index":0,"instanceId":1,"route":"pages/media","options":{}}]),
    );
    assert_eq!(
        call(&mut engine, module, "replacement"),
        json!({"rejected":"ERR_INVALID_REQUEST"})
    );
    let new = engine.capture_media_query_state(None).unwrap();
    assert_ne!(
        old["subscriptions"][0]["ownerToken"],
        new["subscriptions"][0]["ownerToken"]
    );
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&old, true))
        .unwrap();
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&new, true))
        .unwrap();
    assert_eq!(call(&mut engine, module, "state"), json!({"trace":["new"]}));
}

#[test]
fn media_terminal_retirement_revokes_queued_delivery_and_future_factories() {
    let (mut engine,module)=fixture(br#"
      Page({});let trace=[],observer;
      exports.run=function(){observer=getCurrentPages()[0].createMediaQueryObserver();observer.observe({},()=>trace.push('unexpected'));return true;};
      exports.state=function(){let factory,observe;try{getCurrentPages()[0].createMediaQueryObserver();}catch(error){factory=error.code;}try{observer.observe({},function(){});}catch(error){observe=error.code;}return {trace,factory,observe,disconnect:observer.disconnect()===undefined};};
    "#);
    call(&mut engine, module, "run");
    let queued = engine.capture_media_query_state(None).unwrap();
    engine
        .dispatch_lifecycle_notification("retire", &Value::Null)
        .unwrap();
    assert!(!engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&queued, true))
        .unwrap());
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"trace":[],"factory":"ERR_INVALID_REQUEST","observe":"ERR_INVALID_REQUEST","disconnect":true})
    );
    assert!(
        engine.capture_media_query_state(None).unwrap()["subscriptions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn media_native_capture_and_delivery_ignore_poisoned_intrinsics_and_owner_properties() {
    let (mut engine,module)=fixture(br#"
      Page({});let saved,trace=[];
      exports.poison=function(){
        const page=getCurrentPages()[0];
        const descriptor={get width(){return 100;},orientation:'portrait'};
        saved={create:Object.create,getOwn:Object.getOwnPropertyDescriptor,keys:Reflect.ownKeys,apply:Reflect.apply,get:Reflect.get,
          weakGet:WeakMap.prototype.get,string:String,json:JSON.stringify,run:__container_run_with_api_owner,
          owner:__container_api_owner_for_observer};
        ['__container_page_id','__container_instance_id','scopeId','__scopeId','__container_scope_id'].forEach(function(key){
          Object.defineProperty(page,key,{configurable:true,get:function(){throw Error('public owner property');}});
        });
        Object.create=Object.getOwnPropertyDescriptor=Reflect.ownKeys=Reflect.apply=Reflect.get=WeakMap.prototype.get=JSON.stringify=function(){throw Error('guest intrinsic');};
        globalThis.String=function(){throw Error('guest string');};
        globalThis.__container_run_with_api_owner=globalThis.__container_api_owner_for_observer=function(){throw Error('guest owner helper');};
        const poison={configurable:true,get:function(){throw Error('inherited serialization');}};
        Object.defineProperty(Object.prototype,'toJSON',poison);Object.defineProperty(Array.prototype,'toJSON',poison);
        page.createMediaQueryObserver().observe(descriptor,function(value){'use strict';trace.push({matches:value.matches,unbound:this===undefined});});
        return true;
      };
      exports.restore=function(){
        Object.create=saved.create;Object.getOwnPropertyDescriptor=saved.getOwn;Reflect.ownKeys=saved.keys;Reflect.apply=saved.apply;Reflect.get=saved.get;
        WeakMap.prototype.get=saved.weakGet;globalThis.String=saved.string;JSON.stringify=saved.json;
        globalThis.__container_run_with_api_owner=saved.run;globalThis.__container_api_owner_for_observer=saved.owner;
        delete Object.prototype.toJSON;delete Array.prototype.toJSON;
        return {trace};
      };
    "#);
    assert_eq!(call(&mut engine, module, "poison"), json!(true));
    let state = engine.capture_media_query_state(None).unwrap();
    assert_eq!(
        state["subscriptions"][0]["descriptor"],
        json!({"width":100,"orientation":"portrait"})
    );
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&state, true))
        .unwrap();
    assert_eq!(
        call(&mut engine, module, "restore"),
        json!({"trace":[{"matches":true,"unbound":true}]})
    );
}

#[test]
fn media_documented_descriptor_fields_include_prototype_properties_once() {
    let (mut engine,module)=fixture(br#"
      Page({});let trace=[],reads=[],width=100,reentrant;
      exports.run=function(){
        const observer=getCurrentPages()[0].createMediaQueryObserver();
        class Descriptor {
          get width(){reads.push('width');return width;}
          get minWidth(){reads.push('minWidth');try{observer.observe({},function(){});}catch(error){reentrant=error.code;}return 90;}
          get height(){reads.push('height');return 200;}
          get orientation(){reads.push('orientation');return 'portrait';}
          get toJSON(){throw Error('unknown inherited codec read');}
          get unknown(){throw Error('unknown inherited field read');}
        }
        Descriptor.prototype.maxHeight=210;
        const descriptor=new Descriptor();descriptor.maxWidth=110;
        Object.defineProperty(descriptor,'minHeight',{get(){reads.push('minHeight');return 190;}});
        Object.defineProperty(descriptor,'unknownOwn',{get(){throw Error('unknown own field read');}});
        observer.observe(descriptor,function(value){'use strict';trace.push({matches:value.matches,unbound:this===undefined});});
        width=999;
        return {reads,reentrant};
      };
      exports.state=function(){return {trace,reads};};
    "#);
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({
            "reads":["width","minWidth","height","minHeight","orientation"],"reentrant":"ERR_INVALID_REQUEST"
        })
    );
    let state = engine.capture_media_query_state(None).unwrap();
    assert_eq!(
        state["subscriptions"][0]["descriptor"],
        json!({
            "width":100,"minWidth":90,"maxWidth":110,"height":200,"minHeight":190,"maxHeight":210,"orientation":"portrait"
        })
    );
    engine
        .dispatch_lifecycle_notification("mediaQuery", &notifications(&state, true))
        .unwrap();
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({
            "trace":[{"matches":true,"unbound":true}],"reads":["width","minWidth","height","minHeight","orientation"]
        })
    );
}
