use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn call(engine: &mut NativeEngine, module: ModuleId, name: &str) -> Value {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: name.into(),
        },
        vec![],
    )
    .unwrap()
    .remove(0)
}

fn fixture(engine: &mut NativeEngine) -> ModuleId {
    JsEngine::load_module(engine, br#"
      Page({data:{value:'initial'}});
      __container_set_current_pages([0], [{index:0,instanceId:17}]);
      __container_registration_module_id = 'module:receiver.js';
      __container_managed_component_modules['module:receiver.js'] = true;
      Component({data:{value:'component'}});
      __container_registration_module_id = null;
      const scope = 'same-scope';
      const record = {scopeId:scope,moduleId:'module:receiver.js',parentScopeId:null,ownerScopeId:null,properties:{}};
      let first, latest;
      exports.create = function() {
        __container_reconcile_components({version:1,phase:'prepare',pageId:17,instances:[record],remove:[]});
        latest = __container_component_scopes[scope];
        if (!first) first = latest;
        return true;
      };
      exports.remove = function() {
        __container_reconcile_components({version:1,phase:'dispose',pageId:17,instances:[],remove:[scope]});
        return true;
      };
      exports.update = function() { __container_page_instances['17'].setData({value:'changed'}); return true; };
      exports.reinsertFirst = function() {
        first.__container_disposed = first.__container_detached_lifecycle = false;
        __container_component_scopes[scope] = first;
        return true;
      };
      exports.restoreLatest = function() { __container_component_scopes[scope] = latest; return true; };
      exports.unload = function() { __container_invoke_page_instance(17, 0, 'onUnload', []); return true; };
      exports.recreatePage = function() {
        delete __container_page_instances['17'];
        __container_set_current_pages([0], [{index:0,instanceId:17}]);
        return true;
      };
      const saved = { WeakMap, get:WeakMap.prototype.get, set:WeakMap.prototype.set,
        getOwn:Object.getOwnPropertyDescriptor, define:Object.defineProperty,
        stringify:JSON.stringify, isArray:Array.isArray, String };
      let attacks = 0, jobs = 0, receiverDescriptor;
      function attack() { attacks++; throw new Error('application intrinsic/getter executed'); }
      exports.poison = function() {
        const page = __container_page_instances['17'];
        receiverDescriptor = saved.getOwn(page, '__container_instance_id');
        saved.define(page, '__container_instance_id', {get:attack,configurable:true});
        WeakMap.prototype.get = WeakMap.prototype.set = attack;
        globalThis.WeakMap = attack;
        Object.getOwnPropertyDescriptor = attack;
        JSON.stringify = attack;
        Array.isArray = attack;
        globalThis.String = attack;
        Object.prototype.toJSON = attack;
        globalThis.__container_capture_receiver_incarnations = attack;
        Promise.resolve().then(function() { jobs++; });
        return true;
      };
      exports.restore = function() {
        globalThis.WeakMap = saved.WeakMap;
        saved.WeakMap.prototype.get = saved.get;
        saved.WeakMap.prototype.set = saved.set;
        Object.getOwnPropertyDescriptor = saved.getOwn;
        JSON.stringify = saved.stringify;
        Array.isArray = saved.isArray;
        globalThis.String = saved.String;
        delete Object.prototype.toJSON;
        delete globalThis.__container_capture_receiver_incarnations;
        saved.define(__container_page_instances['17'], '__container_instance_id', receiverDescriptor);
        return {attacks:attacks,jobs:jobs};
      };
      let aliasDescriptor;
      exports.trapAlias = function() {
        aliasDescriptor = saved.getOwn(globalThis, '__container_page_instances');
        saved.define(globalThis, '__container_page_instances', {get:attack,configurable:true});
        return true;
      };
      exports.restoreAlias = function() {
        saved.define(globalThis, '__container_page_instances', aliasDescriptor);
        return {attacks:attacks,jobs:jobs};
      };
    "#).unwrap()
}

fn token(value: &Value) -> u64 {
    let text = value.as_str().expect("opaque token is a decimal string");
    let number = text.parse::<u64>().expect("opaque token fits u64");
    assert_ne!(number, 0);
    assert_eq!(text, number.to_string());
    number
}

#[test]
fn receiver_incarnations_cover_root_and_rebuilt_scopes_without_reviving_old_objects() {
    let mut engine = NativeEngine::default();
    let module = fixture(&mut engine);
    let scopes = vec!["same-scope".into()];
    let root = engine.capture_receiver_incarnations(17, &[]).unwrap();
    token(&root["pageToken"]);
    assert_eq!(root["scopes"], json!({}));
    assert!(engine.capture_receiver_incarnations(18, &[]).is_err());
    assert!(engine.capture_receiver_incarnations(17, &scopes).is_err());
    call(&mut engine, module, "create");
    let first = engine.capture_receiver_incarnations(17, &scopes).unwrap();
    token(&first["scopes"]["same-scope"]);
    assert_eq!(first["pageToken"], root["pageToken"]);
    call(&mut engine, module, "update");
    assert_eq!(
        engine.capture_receiver_incarnations(17, &scopes).unwrap(),
        first
    );
    call(&mut engine, module, "remove");
    assert!(engine.capture_receiver_incarnations(17, &scopes).is_err());
    call(&mut engine, module, "create");
    let second = engine.capture_receiver_incarnations(17, &scopes).unwrap();
    assert_ne!(second["scopes"], first["scopes"]);
    call(&mut engine, module, "remove");
    call(&mut engine, module, "create");
    let third = engine.capture_receiver_incarnations(17, &scopes).unwrap();
    assert_ne!(third["scopes"], first["scopes"]);
    assert_ne!(third["scopes"], second["scopes"]);
    call(&mut engine, module, "reinsertFirst");
    assert!(engine.capture_receiver_incarnations(17, &scopes).is_err());
    call(&mut engine, module, "restoreLatest");
    assert_eq!(
        engine.capture_receiver_incarnations(17, &scopes).unwrap(),
        third
    );
    call(&mut engine, module, "unload");
    assert!(engine.capture_receiver_incarnations(17, &[]).is_err());
    call(&mut engine, module, "recreatePage");
    let next_page = engine.capture_receiver_incarnations(17, &[]).unwrap();
    assert_ne!(next_page["pageToken"], root["pageToken"]);
    // The same public page ID cannot attach an existing component to the new
    // page incarnation, even while its object remains in the scope table.
    assert!(engine.capture_receiver_incarnations(17, &scopes).is_err());
    call(&mut engine, module, "remove");
    call(&mut engine, module, "create");
    let next_component = engine.capture_receiver_incarnations(17, &scopes).unwrap();
    assert_eq!(next_component["pageToken"], next_page["pageToken"]);
    assert_ne!(next_component["scopes"], third["scopes"]);
}

#[test]
fn receiver_incarnations_use_private_intrinsics_without_getters_or_job_checkpoints() {
    let mut engine = NativeEngine::default();
    let module = fixture(&mut engine);
    call(&mut engine, module, "create");
    let scopes = vec!["same-scope".into()];
    let original = engine.capture_receiver_incarnations(17, &scopes).unwrap();
    call(&mut engine, module, "poison");
    let captured = engine.capture_receiver_incarnations(17, &scopes);
    let activity = call(&mut engine, module, "restore");
    assert_eq!(captured.unwrap(), original);
    assert_eq!(activity, json!({"attacks":0,"jobs":0}));
    call(&mut engine, module, "trapAlias");
    let trapped = engine.capture_receiver_incarnations(17, &scopes);
    let activity = call(&mut engine, module, "restoreAlias");
    assert!(trapped.is_err());
    assert_eq!(activity, json!({"attacks":0,"jobs":0}));
    assert_eq!(
        engine.capture_receiver_incarnations(17, &scopes).unwrap(),
        original
    );
}

fn event_fixture(engine: &mut NativeEngine) -> ModuleId {
    JsEngine::load_module(engine, br#"
      const calls = [];
      let jobs = 0, attacks = 0, first, latest;
      const scope = 'same-scope';
      const record = {scopeId:scope,moduleId:'module:event-receiver.js',parentScopeId:null,ownerScopeId:null,properties:{}};
      function note(receiver, label) {
        calls.push({label:label,owner:__container_capture_api_owner() === receiver});
      }
      function create() {
        __container_reconcile_components({version:1,phase:'prepare',pageId:17,instances:[record],remove:[]});
        latest = __container_component_scopes[scope];
        if (!first) first = latest;
      }
      function remove() {
        __container_reconcile_components({version:1,phase:'dispose',pageId:17,instances:[],remove:[scope]});
      }
      function rebuild() { remove(); create(); }
      Page({data:{value:'initial'},
        note:function() { note(this, 'page'); },
        bare:function() { calls.push({label:'page-bare'}); },
        forbidden:function() { calls.push({label:'page-forbidden'}); },
        update:function() { note(this, 'update'); this.setData({value:'changed'}); },
        rebuild:function() { note(this, 'rebuild'); rebuild(); },
        restoreFirst:function() {
          note(this, 'restoreFirst');
          rebuild();
          first.__container_disposed = first.__container_detached_lifecycle = false;
          __container_component_scopes[scope] = first;
        },
        unload:function() { note(this, 'unload'); __container_invoke_page_instance(17, 0, 'onUnload', []); },
        enqueue:function() { note(this, 'enqueue'); Promise.resolve().then(function() { jobs++; rebuild(); }); },
        fail:function() { note(this, 'fail'); throw new Error('receiver callback failed'); },
        serializeRebuild:function() {
          note(this, 'serializeRebuild');
          return {toJSON:function() { calls.push({label:'serialize'}); rebuild(); return 'serialized'; }};
        },
        serializeUnload:function() {
          note(this, 'serializeUnload');
          return {toJSON:function() {
            calls.push({label:'serialize'});
            __container_invoke_page_instance(17, 0, 'onUnload', []);
            return 'serialized';
          }};
        }
      });
      __container_set_current_pages([0], [{index:0,instanceId:17}]);
      __container_registration_module_id = 'module:event-receiver.js';
      __container_managed_component_modules['module:event-receiver.js'] = true;
      Component({data:{value:'component'},methods:{
        note:function() { note(this, 'component'); },
        bare:function() { calls.push({label:'component-bare'}); },
        forbidden:function() { calls.push({label:'component-forbidden'}); },
        update:function() { note(this, 'component-update'); this.setData({value:'changed'}); }
      }});
      __container_registration_module_id = null;
      create();
      const saved = {getOwn:Object.getOwnPropertyDescriptor,define:Object.defineProperty,
        hasOwn:Object.prototype.hasOwnProperty,
        split:String.prototype.split,
        WeakMap,get:WeakMap.prototype.get,set:WeakMap.prototype.set,
        stringify:JSON.stringify,isArray:Array.isArray,String,
        invoke:globalThis.__container_invoke_page_event};
      function attack() { attacks++; throw new Error('unexpected application authority lookup'); }
      exports.state = function() { return {calls:calls,jobs:jobs,attacks:attacks}; };
      exports.rebuild = function() { rebuild(); return true; };
      exports.recreatePage = function() {
        __container_invoke_page_instance(17, 0, 'onUnload', []);
        delete __container_page_instances['17'];
        __container_set_current_pages([0], [{index:0,instanceId:17}]);
        return true;
      };
      exports.installRebuildingGetter = function() {
        saved.define(latest, 'replaceOnRead', {configurable:true,get:function() {
          calls.push({label:'getter',owner:__container_capture_api_owner() === latest});
          rebuild();
          return function() { note(this, 'stale-getter-hook'); };
        }});
        return true;
      };
      exports.installRetiringPathGetter = function() {
        saved.define(latest, 'path', {configurable:true,get:function() {
          calls.push({label:'path-first'});
          rebuild();
          const nested = {};
          saved.define(nested, 'next', {configurable:true,get:function() {
            calls.push({label:'path-later'});
            return function() { calls.push({label:'path-hook'}); };
          }});
          return nested;
        }});
        return true;
      };
      exports.overrideDispatcher = function() { globalThis.__container_invoke_page_event = attack; return true; };
      exports.restoreDispatcher = function() { globalThis.__container_invoke_page_event = saved.invoke; return true; };
      exports.poisonHasOwn = function() { Object.prototype.hasOwnProperty = function() { return false; }; return true; };
      exports.restoreHasOwn = function() { Object.prototype.hasOwnProperty = saved.hasOwn; return true; };
      exports.poisonSplit = function() { String.prototype.split = function() { return ['forbidden']; }; return true; };
      exports.restoreSplit = function() { String.prototype.split = saved.split; return true; };
      let instanceDescriptor;
      exports.poison = function() {
        const page = __container_page_instances['17'];
        instanceDescriptor = saved.getOwn(page, '__container_instance_id');
        saved.define(page, '__container_instance_id', {configurable:true,get:attack});
        WeakMap.prototype.get = WeakMap.prototype.set = attack;
        globalThis.WeakMap = attack;
        Object.getOwnPropertyDescriptor = attack;
        JSON.stringify = attack;
        Array.isArray = attack;
        globalThis.String = attack;
        Object.prototype.toJSON = attack;
        return true;
      };
      exports.restore = function() {
        globalThis.WeakMap = saved.WeakMap;
        saved.WeakMap.prototype.get = saved.get;
        saved.WeakMap.prototype.set = saved.set;
        Object.getOwnPropertyDescriptor = saved.getOwn;
        JSON.stringify = saved.stringify;
        Array.isArray = saved.isArray;
        globalThis.String = saved.String;
        delete Object.prototype.toJSON;
        saved.define(__container_page_instances['17'], '__container_instance_id', instanceDescriptor);
        return {calls:calls,jobs:jobs,attacks:attacks};
      };
    "#).unwrap()
}

fn receiver_event(listeners: &[(&str, Option<&str>)]) -> Value {
    let dispatches = listeners
        .iter()
        .enumerate()
        .map(|(index, (handler, scope))| {
            json!({"handler":handler,"ownerScopeId":scope,"currentTarget":format!("node-{index}"),
                "target":"target","phase":"target","dataset":{}})
        })
        .collect::<Vec<_>>();
    json!({"type":"input","detail":{"value":"typed"},"dispatches":dispatches})
}

fn event_receivers(engine: &mut NativeEngine) -> Value {
    engine
        .capture_receiver_incarnations(17, &["same-scope".into()])
        .unwrap()
}

#[test]
fn receiver_dispatch_preserves_normal_routing_owner_context_and_set_data_identity() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    let event = receiver_event(&[("update", None), ("update", Some("same-scope")), ("note", None)]);
    let outcome = engine
        .invoke_receiver_event(17, &expected, &event, false)
        .unwrap();
    assert_eq!(outcome["version"], "1.0");
    assert_eq!(outcome["retired"], false);
    assert_eq!(outcome["results"].as_array().unwrap().len(), 3);
    assert_eq!(event_receivers(&mut engine), expected);
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"calls":[{"label":"update","owner":true},
            {"label":"component-update","owner":true},{"label":"page","owner":true}],
            "jobs":0,"attacks":0})
    );
}

#[test]
fn receiver_dispatch_prevalidates_all_receivers_before_any_callback() {
    for stale_page in [false, true] {
        let mut engine = NativeEngine::default();
        let module = event_fixture(&mut engine);
        let expected = event_receivers(&mut engine);
        call(
            &mut engine,
            module,
            if stale_page { "recreatePage" } else { "rebuild" },
        );
        let outcome = engine
            .invoke_receiver_event(
                17,
                &expected,
                &receiver_event(&[("note", None), ("note", Some("same-scope"))]),
                false,
            )
            .unwrap();
        assert_eq!(outcome["retired"], true);
        assert_eq!(outcome["results"], json!([]));
        assert_eq!(call(&mut engine, module, "state")["calls"], json!([]));
    }
}

#[test]
fn receiver_dispatch_rechecks_each_callback_after_component_rebuild_or_page_unload() {
    for first in ["rebuild", "unload", "restoreFirst"] {
        let mut engine = NativeEngine::default();
        let module = event_fixture(&mut engine);
        let expected = event_receivers(&mut engine);
        let outcome = engine
            .invoke_receiver_event(
                17,
                &expected,
                &receiver_event(&[(first, None), ("note", Some("same-scope"))]),
                false,
            )
            .unwrap();
        assert_eq!(outcome["retired"], true, "first callback: {first}");
        assert_eq!(outcome["results"].as_array().unwrap().len(), 1);
        assert_eq!(
            call(&mut engine, module, "state")["calls"],
            json!([{"label":first,"owner":true}])
        );
    }
}

#[test]
fn receiver_dispatch_rechecks_after_handler_getter_before_invoking_hook() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "installRebuildingGetter");
    let outcome = engine
        .invoke_receiver_event(
            17,
            &expected,
            &receiver_event(&[("replaceOnRead", Some("same-scope")), ("note", None)]),
            false,
        )
        .unwrap();
    assert_eq!(outcome["retired"], true);
    assert_eq!(outcome["results"], json!([]));
    let state = call(&mut engine, module, "state");
    assert_eq!(state["calls"].as_array().unwrap().len(), 1);
    assert_eq!(state["calls"][0]["label"], "getter");
}

#[test]
fn receiver_dispatch_retains_private_entrypoint_without_microtask_checkpoints() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "overrideDispatcher");
    let outcome = engine
        .invoke_receiver_event(
            17,
            &expected,
            &receiver_event(&[("enqueue", None), ("note", Some("same-scope"))]),
            false,
        )
        .unwrap();
    call(&mut engine, module, "restoreDispatcher");
    assert_eq!(outcome["retired"], false);
    assert_eq!(outcome["results"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&mut engine, module, "state"),
        json!({"calls":[{"label":"enqueue","owner":true},{"label":"component","owner":true}],
            "jobs":0,"attacks":0})
    );
    assert_eq!(event_receivers(&mut engine), expected);
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert_eq!(call(&mut engine, module, "state")["jobs"], 1);
    assert_ne!(event_receivers(&mut engine), expected);
}

#[test]
fn receiver_dispatch_stale_preflight_uses_private_intrinsics_without_receiver_getters() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "rebuild");
    call(&mut engine, module, "poison");
    let result = engine.invoke_receiver_event(
        17,
        &expected,
        &receiver_event(&[("note", None), ("note", Some("same-scope"))]),
        false,
    );
    let activity = call(&mut engine, module, "restore");
    let outcome = result.unwrap();
    assert_eq!(outcome["retired"], true);
    assert_eq!(outcome["results"], json!([]));
    assert_eq!(activity, json!({"calls":[],"jobs":0,"attacks":0}));
}

#[test]
fn receiver_dispatch_keeps_existing_callback_error_policy() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    let event = receiver_event(&[("fail", None), ("note", Some("same-scope"))]);
    let outcome = engine
        .invoke_receiver_event(17, &expected, &event, false)
        .unwrap();
    assert_eq!(outcome["retired"], false);
    assert_eq!(outcome["results"].as_array().unwrap().len(), 2);
    assert!(outcome["results"][0]["error"]
        .as_str()
        .unwrap()
        .contains("receiver callback failed"));
    assert!(engine
        .invoke_receiver_event(17, &expected, &event, true)
        .is_err());
    assert_eq!(
        call(&mut engine, module, "state")["calls"],
        json!([{"label":"fail","owner":true},{"label":"component","owner":true},
            {"label":"fail","owner":true}])
    );
}

#[test]
fn receiver_dispatch_final_accounts_for_retirement_during_result_serialization() {
    for handler in ["serializeRebuild", "serializeUnload"] {
        let mut engine = NativeEngine::default();
        let module = event_fixture(&mut engine);
        let expected = event_receivers(&mut engine);
        let outcome = engine
            .invoke_receiver_event(
                17,
                &expected,
                &receiver_event(&[(handler, None)]),
                false,
            )
            .unwrap();
        assert_eq!(outcome["retired"], true, "serialization: {handler}");
        assert_eq!(outcome["results"].as_array().unwrap().len(), 1);
        assert_eq!(outcome["results"][0]["result"], "serialized");
        assert_eq!(
            call(&mut engine, module, "state")["calls"],
            json!([{"label":handler,"owner":true},{"label":"serialize"}])
        );
    }
}

#[test]
fn receiver_dispatch_scope_routing_ignores_application_has_own_property_override() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "poisonHasOwn");
    let result = engine.invoke_receiver_event(
        17,
        &expected,
        &receiver_event(&[("bare", Some("same-scope")), ("bare", None)]),
        false,
    );
    call(&mut engine, module, "restoreHasOwn");
    let outcome = result.unwrap();
    assert_eq!(outcome["retired"], false);
    assert_eq!(outcome["results"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&mut engine, module, "state")["calls"],
        json!([{"label":"component-bare"},{"label":"page-bare"}])
    );
}

#[test]
fn receiver_dispatch_handler_path_ignores_application_string_split_override() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "poisonSplit");
    let result = engine.invoke_receiver_event(
        17,
        &expected,
        &receiver_event(&[("bare", Some("same-scope")), ("bare", None)]),
        false,
    );
    call(&mut engine, module, "restoreSplit");
    let outcome = result.unwrap();
    assert_eq!(outcome["retired"], false);
    assert_eq!(outcome["results"].as_array().unwrap().len(), 2);
    assert_eq!(
        call(&mut engine, module, "state")["calls"],
        json!([{"label":"component-bare"},{"label":"page-bare"}])
    );
}

#[test]
fn receiver_dispatch_stops_handler_path_lookup_after_a_getter_retires_receiver() {
    let mut engine = NativeEngine::default();
    let module = event_fixture(&mut engine);
    let expected = event_receivers(&mut engine);
    call(&mut engine, module, "installRetiringPathGetter");
    let outcome = engine
        .invoke_receiver_event(
            17,
            &expected,
            &receiver_event(&[("path.next", Some("same-scope"))]),
            false,
        )
        .unwrap();
    assert_eq!(outcome["retired"], true);
    assert_eq!(outcome["results"], json!([]));
    assert_eq!(
        call(&mut engine, module, "state")["calls"],
        json!([{"label":"path-first"}])
    );
}
