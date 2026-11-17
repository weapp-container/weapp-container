use container_core::{CallTarget, JsEngine};
use serde_json::{json, Value};
use std::collections::BTreeMap;

fn call(
    engine: &mut NativeEngine,
    module: container_core::ModuleId,
    export: &str,
    args: Vec<Value>,
) -> Value {
    let values = engine
        .call(
            CallTarget::Module {
                id: module,
                export: export.into(),
            },
            args,
        )
        .unwrap();
    engine.drain_microtasks().unwrap();
    values.into_iter().next().unwrap()
}

fn call_array(
    engine: &mut NativeEngine,
    module: container_core::ModuleId,
    export: &str,
    args: Vec<Value>,
) -> Value {
    let values = engine
        .call(
            CallTarget::Module {
                id: module,
                export: export.into(),
            },
            args,
        )
        .unwrap();
    engine.drain_microtasks().unwrap();
    Value::Array(values)
}

fn policy() -> BTreeMap<String, String> {
    [
        "wx.getPerformance",
        "object:Performance.getEntries",
        "object:Performance.getEntriesByName",
        "object:Performance.getEntriesByType",
        "object:EntryList.getEntries",
        "object:EntryList.getEntriesByName",
        "object:EntryList.getEntriesByType",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), "partial".to_owned()))
    .collect()
}
fn fixture(engine: &mut NativeEngine, source: &str) -> container_core::ModuleId {
    engine.set_capabilities(&policy()).unwrap();
    engine.load_module(source.as_bytes()).unwrap()
}
fn execute_without_checkpoint(engine: &mut NativeEngine, id: &str, source: &str) {
    engine
        .register_module_with_id(id, source.as_bytes(), &[], false)
        .unwrap();
    engine.evaluate_module_with_id(id).unwrap();
}

fn execute(engine: &mut NativeEngine, id: &str, source: &str) {
    engine
        .register_module_with_id(id, source.as_bytes(), &[], false)
        .unwrap();
    engine.evaluate_module_with_id(id).unwrap();
    engine.drain_microtasks().unwrap();
}

#[test]
fn performance_duration_tracks_real_native_elapsed_time() {
    struct HostPause;
    impl container_core::SyncHostApi for HostPause {
        fn supported_apis(&self) -> Vec<String> {
            vec!["test.performanceWait".into()]
        }
        fn invoke(&self, _: &str, _: Value) -> Result<Value, Value> {
            std::thread::sleep(std::time::Duration::from_millis(12));
            Ok(Value::Null)
        }
    }
    let mut engine = NativeEngine::default();
    engine
        .install_sync_host_api(std::sync::Arc::new(HostPause))
        .unwrap();
    execute(
        &mut engine,
        "module:elapsed.js",
        "__container_host_sync_call('test.performanceWait','null');",
    );
    let module = fixture(
        &mut engine,
        "exports.read=function(){return wx.getPerformance().getEntriesByType('script');};",
    );
    let entries = call_array(&mut engine, module, "read", vec![]);
    assert!(
        entries[0]["duration"].as_f64().unwrap() >= 10.0,
        "actual host wait must appear in script elapsed time"
    );
}

#[test]
fn performance_uses_actual_named_module_evaluation_and_synchronous_snapshots() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p = wx.getPerformance();
        exports.read = function() { return { stable: p === wx.getPerformance(),
          canUse: wx.canIUse('getPerformance'), entries: p.getEntries(),
          byName: p.getEntriesByName('evaluateScript', 'script'), byType: p.getEntriesByType('script'),
          absent: p.getEntriesByName('firstRender'), leakedClock: typeof __container_host_performance_now }; };
    "#,
    );
    assert_eq!(
        call(&mut engine, module, "read", vec![])["entries"],
        json!([])
    );
    execute(&mut engine, "module:metrics.js", "exports.value = 42;");
    let result = call(&mut engine, module, "read", vec![]);
    assert_eq!(result["stable"], true);
    assert_eq!(result["canUse"], true);
    assert_eq!(result["leakedClock"], "undefined");
    assert_eq!(result["entries"], result["byName"]);
    assert_eq!(result["entries"], result["byType"]);
    assert_eq!(result["entries"][0]["name"], "evaluateScript");
    assert_eq!(result["entries"][0]["fileList"], json!(["metrics.js"]));
    assert!(result["entries"][0]["startTime"].as_f64().unwrap() >= 0.0);
    assert!(result["entries"][0]["duration"].as_f64().unwrap() >= 0.0);
    assert_eq!(result["absent"], json!([]));
}

#[test]
fn performance_observer_batches_at_checkpoint_and_disconnect_invalidates_detached_delivery() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance(),log=[];
      let second;
      p.createObserver(function(list){log.push(['first',list.getEntries().length,list.getEntriesByType('script').length,list.getEntriesByName('evaluateScript','script').length]);second.disconnect();}).observe({type:'script'});
      second=p.createObserver(function(){log.push(['second']);});second.observe({type:'script'});
      exports.read=function(){return log;};
    "#,
    );
    execute_without_checkpoint(&mut engine, "module:first.js", "exports.value=1;");
    execute_without_checkpoint(&mut engine, "module:second.js", "exports.value=2;");
    engine.drain_microtasks().unwrap();
    assert_eq!(
        call_array(&mut engine, module, "read", vec![]),
        json!([["first", 2, 2, 2]])
    );
}

#[test]
fn performance_buffer_is_bounded_resizable_and_independent_of_observers() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance();let observed=0;
      p.createObserver(function(list){observed+=list.getEntries().length;}).observe({type:'script'});
      exports.read=function(){return p.getEntries();};
      exports.resize=function(size){p.setBufferSize(size);return p.getEntries();};
      exports.observed=function(){return observed;};
    "#,
    );
    for index in 0..35 {
        execute_without_checkpoint(
            &mut engine,
            &format!("module:{index}.js"),
            "exports.value=1;",
        );
    }
    engine.drain_microtasks().unwrap();
    let entries = call_array(&mut engine, module, "read", vec![]);
    assert_eq!(entries.as_array().unwrap().len(), 30);
    assert_eq!(entries[0]["fileList"], json!(["5.js"]));
    assert_eq!(call(&mut engine, module, "observed", vec![]), 35);
    let entries = call_array(&mut engine, module, "resize", vec![json!(2)]);
    assert_eq!(entries.as_array().unwrap().len(), 2);
    assert_eq!(entries[0]["fileList"], json!(["33.js"]));
    assert_eq!(
        call_array(&mut engine, module, "resize", vec![json!(0)]),
        json!([])
    );
    execute(&mut engine, "module:later.js", "exports.value=1;");
    assert_eq!(call_array(&mut engine, module, "read", vec![]), json!([]));
    assert_eq!(call(&mut engine, module, "observed", vec![]), 36);
}

#[test]
fn performance_entries_and_supported_types_are_owned_snapshots() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p = wx.getPerformance(); let saved;
        const observer = p.createObserver(function(list) { if (!saved) saved = list; });
        observer.observe({type:'script'});
        exports.mutate = function() {
          const old = p.getEntries(); old[0].name = 'forged'; old[0].fileList[0] = 'forged'; old.length=0;
          const types = observer.supportedEntryTypes; types[0] = 'render';
          return {entries:p.getEntries(), supported:observer.supportedEntryTypes};
        };
        exports.saved = function() { const a=saved.getEntries(); a[0].fileList[0]='forged'; return saved.getEntries(); };
    "#,
    );
    execute(&mut engine, "module:one.js", "exports.value = 1;");
    let result = call(&mut engine, module, "mutate", vec![]);
    assert_eq!(result["entries"][0]["name"], "evaluateScript");
    assert_eq!(result["entries"][0]["fileList"], json!(["one.js"]));
    assert_eq!(result["supported"], json!(["navigation", "script"]));
    execute(&mut engine, "module:two.js", "exports.value = 2;");
    let result = call_array(&mut engine, module, "saved", vec![]);
    assert_eq!(result.as_array().unwrap().len(), 1);
    assert_eq!(result[0]["fileList"], json!(["one.js"]));
}

#[test]
fn performance_native_clock_and_scheduler_ignore_guest_date_and_promise_species() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p = wx.getPerformance(); let observed = 0;
        const originalDate = Date.now, originalMax=Math.max;
        const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
        const observer=p.createObserver(function(list){observed+=list.getEntries().length;});
        observer.observe({type:'script'});
        exports.poison = function() {
          Date.now = function(){ throw new Error('guest clock'); };
          Math.max = function(){ return -999; };
          Object.defineProperty(Promise, Symbol.species, {configurable:true,get:function(){throw new Error('species');}});
          return null;
        };
        exports.restore = function() { Date.now=originalDate; Math.max=originalMax; Object.defineProperty(Promise,Symbol.species,species); return null; };
        exports.read = function() { return {observed:observed,entries:p.getEntries()}; };
    "#,
    );
    call(&mut engine, module, "poison", vec![]);
    execute(&mut engine, "module:clock.js", "exports.value = 1;");
    call(&mut engine, module, "restore", vec![]);
    let result = call(&mut engine, module, "read", vec![]);
    assert_eq!(result["observed"], 1);
    assert!(result["entries"][0]["duration"].as_f64().unwrap() >= 0.0);
}

#[test]
fn performance_observe_rejects_unsupported_metrics_and_never_invents_them() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p=wx.getPerformance(); let calls=0;
        const o=p.createObserver(function(){calls++;});
        exports.invalid = function() {
          const cases=[{}, {type:'script',entryTypes:['script']}, {type:'render'}, {type:'resource'}, {entryTypes:[]}, {entryTypes:['script','render']}];
          let rejected=0;
          for(const value of cases) { try{o.observe(value);}catch(_){rejected++;} }
          for(const size of [-1, 1.5, 4097, '1']) {try{p.setBufferSize(size);}catch(_){rejected++;}}
          return rejected;
        };
        exports.read = function(){return {calls:calls,render:p.getEntriesByType('render'),navigation:p.getEntriesByType('navigation')};};
    "#,
    );
    assert_eq!(call(&mut engine, module, "invalid", vec![]), 10);
    execute(&mut engine, "module:unsupported.js", "exports.value=1;");
    assert_eq!(
        call(&mut engine, module, "read", vec![]),
        json!({"calls":0,"render":[],"navigation":[]})
    );
}

#[test]
fn performance_failed_module_is_not_reported_as_completed_script() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        "exports.read=function(){return wx.getPerformance().getEntries();};",
    );
    engine
        .register_module_with_id(
            "module:failed.js",
            b"throw new Error('failure');",
            &[],
            false,
        )
        .unwrap();
    assert!(engine.evaluate_module_with_id("module:failed.js").is_err());
    assert_eq!(call_array(&mut engine, module, "read", vec![]), json!([]));
}

#[test]
fn performance_launch_is_measured_once_and_other_owner_has_independent_timeline() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        App({onLaunch:function(){}});
        exports.read=function(){return wx.getPerformance().getEntriesByName('appLaunch','navigation');};
    "#,
    );
    engine
        .call(
            CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![json!("onLaunch"), json!([{"path":"pages/home"}])],
        )
        .unwrap();
    engine
        .call(
            CallTarget::Global {
                name: "__container_invoke_app".into(),
            },
            vec![json!("onLaunch"), json!([{"path":"pages/other"}])],
        )
        .unwrap();
    let entries = call_array(&mut engine, module, "read", vec![]);
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["path"], "pages/home");
    assert!(entries[0]["duration"].as_f64().unwrap() > 0.0);
    let mut other = NativeEngine::default();
    let module = fixture(
        &mut other,
        "exports.read=function(){return wx.getPerformance().getEntries();};",
    );
    assert_eq!(call_array(&mut other, module, "read", vec![]), json!([]));
}

#[test]
fn performance_capability_revocation_rejects_existing_handles_and_drops_pending_delivery() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p=wx.getPerformance(); let calls=0;
        const observer=p.createObserver(function(){calls++;}); observer.observe({type:'script'});
        exports.revoke=function(){
          let rejected=0;
          for(const operation of [function(){wx.getPerformance();},function(){p.getEntries();},function(){observer.observe({type:'script'});}]) {
            try{operation();}catch(e){if(e.code==='ERR_UNSUPPORTED_CAPABILITY') rejected++;}
          }
          return rejected;
        };
        exports.read=function(){observer.disconnect();return calls;};
    "#,
    );
    execute_without_checkpoint(&mut engine, "module:pending.js", "exports.value=1;");
    engine
        .set_capabilities(&BTreeMap::from([(
            "wx.getPerformance".into(),
            "unsupported".into(),
        )]))
        .unwrap();
    assert_eq!(call(&mut engine, module, "revoke", vec![]), 3);
    assert_eq!(call(&mut engine, module, "read", vec![]), 0);
}

#[test]
fn performance_retained_entry_list_obeys_capability_revocation() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
        const p=wx.getPerformance(); let saved;
        const observer=p.createObserver(function(list){saved=list;}); observer.observe({type:'script'});
        exports.revoke=function(){
          let rejected=0;
          for(const operation of [function(){saved.getEntries();},function(){saved.getEntriesByName('evaluateScript');},function(){saved.getEntriesByType('script');}]) {
            try{operation();}catch(e){if(e.code==='ERR_UNSUPPORTED_CAPABILITY') rejected++;}
          }
          observer.disconnect(); return rejected;
        };
    "#,
    );
    execute(&mut engine, "module:retained.js", "exports.value=1;");
    engine
        .set_capabilities(&BTreeMap::from([(
            "wx.getPerformance".into(),
            "unsupported".into(),
        )]))
        .unwrap();
    assert_eq!(call(&mut engine, module, "revoke", vec![]), 3);
}

#[test]
fn performance_instrumentation_cannot_fail_successful_modules_through_guest_prototypes() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance(),define=Object.defineProperty;
      const oldZero=Object.getOwnPropertyDescriptor(Array.prototype,'0'),oldNavigation=Object.getOwnPropertyDescriptor(Object.prototype,'navigationStart');
      globalThis.executed=0;let getterReads=0;
      exports.poison=function(){
        define(Array.prototype,'0',{configurable:true,set:function(){throw Error('numeric setter');}});
        define(Object.prototype,'navigationStart',{configurable:true,get:function(){getterReads++;throw Error('inherited metric getter');}});
      };
      exports.restore=function(){
        if(oldZero)define(Array.prototype,'0',oldZero);else delete Array.prototype['0'];
        if(oldNavigation)define(Object.prototype,'navigationStart',oldNavigation);else delete Object.prototype.navigationStart;
      };
      exports.read=function(){const list=p.getEntries();return {executed:executed,getterReads:getterReads,publicArray:Array.isArray(list)&&typeof list.map==='function',entries:list.length};};
    "#,
    );
    call(&mut engine, module, "poison", vec![]);
    execute(&mut engine, "module:prototype.js", "globalThis.executed++;");
    call(&mut engine, module, "restore", vec![]);
    assert_eq!(
        call(&mut engine, module, "read", vec![]),
        json!({"executed":1,"getterReads":0,"publicArray":true,"entries":1})
    );
}

#[test]
fn performance_instrumentation_captures_launch_path_before_hook_mutation() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      let executions=0,pathReads=0;
      App({onLaunch:function(options){
        executions++;
        Object.defineProperty(options,'path',{configurable:true,get:function(){pathReads++;throw Error('launch path getter');}});
        return 17;
      }});
      exports.read=function(){return {executions:executions,pathReads:pathReads,entries:wx.getPerformance().getEntriesByName('appLaunch','navigation')};};
    "#,
    );
    let result = engine.call(
        CallTarget::Global {
            name: "__container_invoke_app".into(),
        },
        vec![json!("onLaunch"), json!([{"path":"pages/home"}])],
    );
    assert_eq!(
        result.unwrap(),
        vec![json!(17)],
        "measurement must preserve the successful lifecycle result"
    );
    engine.drain_microtasks().unwrap();
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(state["executions"], 1);
    assert_eq!(state["pathReads"], 0);
    assert_eq!(state["entries"][0]["path"], "pages/home");
}

#[test]
fn performance_instrumentation_observer_poisoning_cannot_skip_neighbor_batch() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance(),define=Object.defineProperty;
      const oldZero=Object.getOwnPropertyDescriptor(Array.prototype,'0');
      let trace='';
      const first=p.createObserver(function(){
        trace+='first;';
        define(Array.prototype,'0',{configurable:true,set:function(){throw Error('observer numeric setter');}});
        throw Error('first observer fixture');
      });
      const second=p.createObserver(function(list){
        try{trace+='second:'+list.getEntries().length+';';}
        finally{if(oldZero)define(Array.prototype,'0',oldZero);else delete Array.prototype['0'];}
      });
      first.observe({type:'script'});second.observe({type:'script'});

      exports.read=function(){first.disconnect();second.disconnect();return trace;};
    "#,
    );
    execute_without_checkpoint(&mut engine, "module:first-prototype.js", "exports.value=1;");
    execute_without_checkpoint(
        &mut engine,
        "module:second-prototype.js",
        "exports.value=2;",
    );
    engine.drain_microtasks().unwrap();
    assert_eq!(
        call(&mut engine, module, "read", vec![]),
        json!("first;second:2;")
    );
}

#[test]
fn performance_public_forgery_and_replaced_globals_do_not_own_native_samples() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      __container_evaluate_named_module('module:forged.js',function(){globalThis.forgedExecuted=1;},true);
      __container_define_module('module:forged-record.js',999,[],'commonjs',function(){globalThis.forgedExecuted++;});
      __container_evaluate_module('module:forged-record.js');
      function poison(){throw Error('public alias used');}
      __container_evaluate_named_module=poison;__container_define_module=poison;__container_evaluate_module=poison;__container_module_exports=poison;
      exports.read=function(){return {forged:forgedExecuted,entries:wx.getPerformance().getEntries()};};
    "#,
    );
    assert_eq!(
        call(&mut engine, module, "read", vec![])["entries"],
        json!([])
    );
    execute(
        &mut engine,
        "module:actual.js",
        "globalThis.actualExecuted=1;",
    );
    let result = call(&mut engine, module, "read", vec![]);
    assert_eq!(result["forged"], 2);
    assert_eq!(result["entries"][0]["fileList"], json!(["actual.js"]));
}

#[test]
fn performance_saved_members_are_independently_revocable() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance(),saved=p.getEntries;
      exports.read=function(){let code='';try{saved();}catch(error){code=error.api;}return {code:code,other:p.getEntriesByType('script').length};};
    "#,
    );
    execute(&mut engine, "module:real.js", "exports.value=1;");
    let mut changed = policy();
    changed.insert("object:Performance.getEntries".into(), "unsupported".into());
    engine.set_capabilities(&changed).unwrap();
    assert_eq!(
        call(&mut engine, module, "read", vec![]),
        json!({"code":"object:Performance.getEntries","other":1})
    );
}

#[test]
fn performance_native_retirement_fences_saved_receivers_without_a_js_cleanup_turn() {
    let mut engine = NativeEngine::default();
    let module = fixture(
        &mut engine,
        r#"
      const p=wx.getPerformance(),saved=p.getEntries;
      exports.read=function(){let rejected=0;for(const operation of [function(){saved();},function(){wx.getPerformance();}]){try{operation();}catch(error){if(error.code==='ERR_UNSUPPORTED_CAPABILITY')rejected++;}}return rejected;};
    "#,
    );
    let lifetime = engine.performance_lifetime().unwrap();
    lifetime.retire();
    engine.set_capabilities(&policy()).unwrap();
    assert_eq!(call(&mut engine, module, "read", vec![]), 2);
    assert!(!lifetime.is_active());
}
