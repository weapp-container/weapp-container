use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

#[test]
fn batch_uses_original_array_length_and_ordered_value_snapshots() {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"
      exports.run=function(){
        const first={phase:'first'},second={phase:'second'};
        const items=[{key:'first',value:first}];
        items.push({get key(){items.push({key:'appended',value:3});first.phase='changed by later getter';return 'second';},value:second});
        wx.batchSetStorageSync(items);second.phase='changed after return';
        return {inputLength:items.length,first:wx.getStorageSync('first'),second:wx.getStorageSync('second'),appended:wx.getStorageSync('appended'),keys:wx.getStorageInfoSync().keys};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({
            "inputLength":3,"first":{"phase":"first"},"second":{"phase":"second"},"appended":"","keys":["first","second"]
        })
    );
    let effects = engine.drain_host_events().unwrap();
    let transactions = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(
        transactions[0]["patches"],
        json!([
            {"op":"set","key":"first","valueJson":"{\"phase\":\"first\"}","undefined":false},
            {"op":"set","key":"second","valueJson":"{\"phase\":\"second\"}","undefined":false}
        ])
    );
}

#[test]
fn key_whitespace_admission_matches_native_legacy_policy() {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"
      exports.reject=function(){let rejected=false;try{wx.setStorageSync('\u0085','invalid');}catch(_){rejected=true;}return {rejected,keys:wx.getStorageInfoSync().keys};};
      exports.accept=function(){wx.setStorageSync('\ufeff','valid');return {value:wx.getStorageSync('\ufeff'),keys:wx.getStorageInfoSync().keys};};
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "reject"),
        json!({"rejected":true,"keys":[]})
    );
    assert!(
        engine.drain_host_events().unwrap()[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&mut engine, module, "accept"),
        json!({"value":"valid","keys":["\u{feff}"]})
    );
    let effects = engine.drain_host_events().unwrap();
    let transactions = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["sequence"], "1");
    assert_eq!(transactions[0]["patches"][0]["key"], "\u{feff}");
}

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

fn snapshot(engine: &mut NativeEngine, values: Value) {
    JsEngine::call(
        engine,
        CallTarget::Global {
            name: "__container_set_storage_snapshot".into(),
        },
        vec![json!({"values":values,"undefinedKeys":[]})],
    )
    .unwrap();
}

#[test]
fn batch_failure_and_throwing_codec_preserve_outer_state_and_transactions() {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"
      exports.run = function() {
        wx.setStorageSync('stable', 'before');
        let batch=false, cycle=false, bigint=false;
        try { wx.batchSetStorageSync([{key:'stable',value:'after'},{key:' ',value:1}]); } catch (_) { batch=true; }
        const cyclic={};cyclic.self=cyclic;
        try { wx.setStorageSync('cycle',cyclic); } catch (_) { cycle=true; }
        try { wx.setStorageSync('bigint',1n); } catch (_) { bigint=true; }
        return {batch,cycle,bigint,value:wx.getStorageSync('stable'),keys:wx.getStorageInfoSync().keys};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"batch":true,"cycle":true,"bigint":true,"value":"before","keys":["stable"]})
    );
    let effects = engine.drain_host_events().unwrap();
    assert_eq!(
        effects[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn nested_codec_writes_survive_rejected_outer_and_values_are_snapshots() {
    let mut engine = NativeEngine::default();
    let module=JsEngine::load_module(&mut engine,br#"
      exports.run=function(){
        let rejected=false;
        try { wx.setStorageSync('outer',{toJSON(){wx.setStorageSync('nested','kept');throw new Error('codec');}}); } catch(_){rejected=true;}
        const value={text:'original'};wx.setStorageSync('snapshot',value);value.text='changed';
        const read=wx.getStorageSync('snapshot');read.text='also changed';
        return {rejected,nested:wx.getStorageSync('nested'),outer:wx.getStorageSync('outer'),snapshot:wx.getStorageSync('snapshot')};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"rejected":true,"nested":"kept","outer":"","snapshot":{"text":"original"}})
    );
    let effects = engine.drain_host_events().unwrap();
    let tx = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(tx.len(), 2);
    assert_eq!(tx[1]["patches"][0]["valueJson"], r#"{"text":"original"}"#);
}

#[test]
fn deferred_commit_keeps_original_tail_until_native_ack_and_retains_suffix() {
    let mut engine = NativeEngine::default();
    engine.enable_deferred_storage_commit().unwrap();
    let module=JsEngine::load_module(&mut engine,br#"
      let appended=false;
      exports.queue=function(){wx.setStorageSync('first','kept');__container_events.push({toJSON(){if(!appended){appended=true;wx.setStorageSync('late','suffix');}return {type:'probe'};}});return true;};
      exports.read=function(){return {first:wx.getStorageSync('first'),late:wx.getStorageSync('late'),host:wx.getStorageSync('host')};};
    "#).unwrap();
    call(&mut engine, module, "queue");
    let effects = engine.drain_host_events().unwrap();
    assert_eq!(
        effects[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(effects[0]["__storageTransactions"][0]["sequence"], "1");
    snapshot(&mut engine, json!({"host":"new"}));
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"kept","late":"suffix","host":"new"})
    );
    assert!(engine.acknowledge_storage_transactions(2).is_err());
    engine.acknowledge_storage_transactions(1).unwrap();
    engine.acknowledge_storage_transactions(1).unwrap();
    snapshot(&mut engine, json!({"host":"newer"}));
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":"suffix","host":"newer"})
    );
    let effects = engine.drain_host_events().unwrap();
    assert_eq!(effects[0]["__storageTransactions"][0]["sequence"], "2");
    engine.acknowledge_storage_transactions(2).unwrap();
    snapshot(&mut engine, json!({"host":"final"}));
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"first":"","late":"","host":"final"})
    );
}

#[test]
fn public_storage_authority_is_stripped_and_aliases_cannot_replace_canonical_state() {
    let mut engine = NativeEngine::default();
    snapshot(&mut engine, json!({"native":"distinct"}));
    let module=JsEngine::load_module(&mut engine,br#"
      const drain=__container_drain_events;
      exports.forge=function(){
        __container_storage.native='forged';
        const result=__container_set_storage_snapshot({values:{native:'forged'},undefinedKeys:[]});
        globalThis.__container_drain_events=function(){return [{__storageTransactions:[{sequence:'999',patches:[{op:'clear'}]}]},{__storageTransactions:[{}]}];};
        return {value:wx.getStorageSync('native'),result};
      };
      exports.restore=function(){globalThis.__container_drain_events=drain;return true;};
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "forge"),
        json!({"value":"distinct","result":false})
    );
    let forged = engine.drain_host_events().unwrap();
    assert!(forged
        .iter()
        .all(|value| value.get("__storageTransactions").is_none()));
    call(&mut engine, module, "restore");
}

#[test]
fn lone_surrogates_fail_before_publication_but_valid_pairs_round_trip() {
    let mut engine = NativeEngine::default();
    let module=JsEngine::load_module(&mut engine,br#"
      exports.run=function(){
        let key=false,value=false,nested=false;
        try{wx.setStorageSync('\ud800',1);}catch(_){key=true;}
        try{wx.setStorageSync('bad','\udc00');}catch(_){value=true;}
        try{wx.setStorageSync('nested',{'\ud800':'bad'});}catch(_){nested=true;}
        wx.setStorageSync('emoji','\ud83d\ude00');
        return {key,value,nested,keys:wx.getStorageInfoSync().keys,emoji:wx.getStorageSync('emoji')};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"key":true,"value":true,"nested":true,"keys":["emoji"],"emoji":"😀"})
    );
}

#[test]
fn plain_quota_boundary_rejects_without_changing_state_or_queue() {
    let mut engine = NativeEngine::default();
    let module=JsEngine::load_module(&mut engine,br#"
      exports.run=function(){
        wx.setStorageSync('fits','x'.repeat(1048574));
        let rejected=false;try{wx.setStorageSync('tooBig','x'.repeat(1048575));}catch(_){rejected=true;}
        return {rejected,size:wx.getStorageSync('fits').length,keys:wx.getStorageInfoSync().keys,currentSize:wx.getStorageInfoSync().currentSize};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"rejected":true,"size":1048574,"keys":["fits"],"currentSize":1025})
    );
    let effects = engine.drain_host_events().unwrap();
    assert_eq!(
        effects[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn null_and_undefined_batch_values_have_distinct_private_tags() {
    let mut engine = NativeEngine::default();
    let module=JsEngine::load_module(&mut engine,br#"
      exports.run=function(){wx.batchSetStorageSync([{key:'u',value:undefined},{key:'n',value:null},{key:'u',value:undefined}]);return {undefined:wx.getStorageSync('u')===undefined,null:wx.getStorageSync('n')===null};};
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"undefined":true,"null":true})
    );
    let effects = engine.drain_host_events().unwrap();
    let tx = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(tx.len(), 1);
    assert_eq!(tx[0]["patches"][0]["undefined"], true);
    assert_eq!(tx[0]["patches"][1]["undefined"], false);
    assert_eq!(tx[0]["patches"][0]["valueJson"], "null");
    assert_eq!(tx[0]["patches"][1]["valueJson"], "null");
}

#[test]
fn native_restore_keeps_deep_legacy_values_without_prototype_callbacks() {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"
      let callbacks=0;
      exports.poison=function(){
        const descriptor={configurable:true,get(){callbacks++;throw new Error('prototype codec');}};
        Object.defineProperty(Object.prototype,'toJSON',descriptor);
        Object.defineProperty(Array.prototype,'toJSON',descriptor);
        return true;
      };
      exports.read=function(){
        let value=wx.getStorageSync('legacy'),depth=0;
        while(value!==null&&typeof value==='object'){value=Array.isArray(value)?value[0]:value.next;depth++;}
        delete Object.prototype.toJSON;delete Array.prototype.toJSON;
        return {depth,leaf:value,callbacks};
      };
    "#).unwrap();
    call(&mut engine, module, "poison");
    let mut value = json!("legacy");
    for depth in 0..200 {
        value = if depth % 2 == 0 {
            json!({"next": value})
        } else {
            json!([value])
        };
    }
    snapshot(&mut engine, json!({"legacy": value}));
    assert_eq!(
        call(&mut engine, module, "read"),
        json!({"depth":200,"leaf":"legacy","callbacks":0})
    );
    assert!(
        engine.drain_host_events().unwrap()[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn new_write_depth_boundary_is_proved_before_batch_publication() {
    let mut engine = NativeEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"
      function nested(depth,leaf){for(let index=0;index<depth;index++)leaf={next:leaf};return leaf;}
      function depth(key){let value=wx.getStorageSync(key),count=0;while(value&&typeof value==='object'&&'next' in value){value=value.next;count++;}return {depth:count,leaf:value};}
      exports.reject=function(){
        let rejected=false;try{wx.batchSetStorageSync([{key:'prefix',value:'uncommitted'},{key:'tooDeep',value:nested(129,'leaf')}]);}catch(_){rejected=true;}
        let emptyRejected=false;try{wx.setStorageSync('tooDeepEmpty',nested(129,{}));}catch(_){emptyRejected=true;}
        return {rejected,emptyRejected,keys:wx.getStorageInfoSync().keys};
      };
      exports.accept=function(){
        wx.batchSetStorageSync([{key:'d127',value:nested(127,'leaf')},{key:'d128',value:nested(128,'leaf')},{key:'empty128',value:nested(128,{})}]);
        return {d127:depth('d127'),d128:depth('d128'),empty128:depth('empty128')};
      };
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "reject"),
        json!({"rejected":true,"emptyRejected":true,"keys":[]})
    );
    assert!(
        engine.drain_host_events().unwrap()[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&mut engine, module, "accept"),
        json!({"d127":{"depth":127,"leaf":"leaf"},"d128":{"depth":128,"leaf":"leaf"},"empty128":{"depth":128,"leaf":{}}})
    );
    let effects = engine.drain_host_events().unwrap();
    let transactions = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["sequence"], "1");
    assert_eq!(transactions[0]["patches"].as_array().unwrap().len(), 3);
}

#[test]
fn native_result_json_depth_guard_preserves_json_grammar() {
    let accepted = format!("{}0{}", "[".repeat(256), "]".repeat(256));
    assert!(super::decode_native_result_json(&accepted).is_ok());
    let rejected = format!("{}0{}", "[".repeat(257), "]".repeat(257));
    assert!(super::decode_native_result_json(&rejected)
        .unwrap_err()
        .contains("exceeds 256"));
    let literal = r#"{"literal":"[{}]\\\"[","array":[1]}"#;
    assert_eq!(
        super::decode_native_result_json(literal).unwrap(),
        json!({"literal":"[{}]\\\"[","array":[1]})
    );
    for malformed in ["", "{} false", "{} garbage", "[}", "{\"x\":1"] {
        assert!(
            super::decode_native_result_json(malformed).is_err(),
            "{malformed}"
        );
    }
}

#[test]
fn overdepth_public_effect_decode_does_not_ack_private_storage() {
    let mut engine = NativeEngine::default();
    engine.enable_deferred_storage_commit().unwrap();
    let module = JsEngine::load_module(
        &mut engine,
        br#"
      const probe={type:'probe'};
      exports.queue=function(){
        wx.setStorageSync('kept',1);let value=0;for(let index=0;index<257;index++)value=[value];
        probe.value=value;__container_events.push(probe);return true;
      };
      exports.repair=function(){delete probe.value;return wx.getStorageSync('kept');};
    "#,
    )
    .unwrap();
    call(&mut engine, module, "queue");
    let error = engine.drain_host_events().unwrap_err().into_core_error();
    assert_eq!(error.code, container_core::EngineErrorCode::Call);
    assert_eq!(call(&mut engine, module, "repair"), json!(1));
    let effects = engine.drain_host_events().unwrap();
    let transactions = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["sequence"], "1");
    engine.acknowledge_storage_transactions(1).unwrap();
}

#[test]
fn async_encrypt_options_fail_without_plaintext_and_settle_after_callbacks() {
    let mut engine = NativeEngine::default();
    snapshot(&mut engine, json!({"plain":"visible","same":"baseline"}));
    let module = JsEngine::load_module(&mut engine, br#"
      const order=[],records={};
      function attempt(label,method,options,throwCallback){
        const record=records[label]={};let failure;
        options.success=function(){order.push(label+'.unexpectedSuccess');};
        options.fail=function(error){
          order.push(label+'.fail');failure=error;
          record.failure={api:error.api,code:error.code,errMsg:error.errMsg,hasData:Object.prototype.hasOwnProperty.call(error,'data')};
          if(throwCallback)throw new Error('failure callback');
        };
        options.complete=function(error){order.push(label+'.complete');record.completeSame=error===failure;};
        wx[method](options).then(function(){order.push(label+'.unexpectedResolve');},function(error){order.push(label+'.reject');record.rejectSame=error===failure;});
      }
      exports.run=function(){
        attempt('setEncrypted','setStorage',{key:'same',data:'secret',encrypt:true},true);
        attempt('getEncrypted','getStorage',{key:'plain',encrypt:true},false);
        attempt('setMalformed','setStorage',{key:'new',data:'secret',encrypt:'true'},false);
        attempt('getMalformed','getStorage',{key:'plain',encrypt:1},false);
        order.push('returned');
        return {order:order.slice(),same:wx.getStorageSync('same'),keys:wx.getStorageInfoSync().keys};
      };
      exports.status=function(){return {order,records,same:wx.getStorageSync('same'),keys:wx.getStorageInfoSync().keys};};
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "run"),
        json!({"order":["returned"],"same":"baseline","keys":["plain","same"]})
    );
    JsEngine::drain_microtasks(&mut engine).unwrap();
    let status = call(&mut engine, module, "status");
    assert_eq!(status["same"], "baseline");
    assert_eq!(status["keys"], json!(["plain", "same"]));
    assert_eq!(
        status["order"],
        json!([
            "returned",
            "setEncrypted.fail",
            "setEncrypted.complete",
            "setEncrypted.reject",
            "getEncrypted.fail",
            "getEncrypted.complete",
            "getEncrypted.reject",
            "setMalformed.fail",
            "setMalformed.complete",
            "setMalformed.reject",
            "getMalformed.fail",
            "getMalformed.complete",
            "getMalformed.reject"
        ])
    );
    for (label, api, message) in [
        (
            "setEncrypted",
            "wx.setStorage",
            "encrypted storage is not implemented",
        ),
        (
            "getEncrypted",
            "wx.getStorage",
            "encrypted storage is not implemented",
        ),
        (
            "setMalformed",
            "wx.setStorage",
            "storage encrypt must be boolean",
        ),
        (
            "getMalformed",
            "wx.getStorage",
            "storage encrypt must be boolean",
        ),
    ] {
        let record = &status["records"][label];
        assert_eq!(record["failure"]["api"], api);
        assert_eq!(record["failure"]["code"], "ERR_INVALID_REQUEST");
        assert!(record["failure"]["errMsg"]
            .as_str()
            .unwrap()
            .contains(message));
        assert_eq!(record["failure"]["hasData"], false);
        assert_eq!(record["completeSame"], true);
        assert_eq!(record["rejectSame"], true);
    }
    let effects = engine.drain_host_events().unwrap();
    assert!(effects[0]["__storageTransactions"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(effects[0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["type"] != "storage.patch.batch"));
}

#[test]
fn async_batch_failure_is_atomic_and_success_keeps_ordered_duplicate_keys() {
    let mut engine = NativeEngine::default();
    snapshot(&mut engine, json!({"stable":"baseline"}));
    let module = JsEngine::load_module(&mut engine, br#"
      let order=[],same=false;
      exports.fail=function(){
        let failure;
        wx.batchSetStorage({kvList:[{key:'prefix',value:'must not commit'},{key:' ',value:1}],
          success(){order.push('unexpectedSuccess');},
          fail(error){order.push('fail');failure=error;throw new Error('batch fail callback');},
          complete(error){order.push('complete');same=error===failure;}
        }).then(function(){order.push('unexpectedResolve');},function(error){order.push('reject');same=same&&error===failure;});
        order.push('returned');return {order:order.slice(),keys:wx.getStorageInfoSync().keys,stable:wx.getStorageSync('stable')};
      };
      exports.succeed=function(){
        order=[];same=false;let success;
        const last={phase:'last'},kvList=[{key:'stable',value:{phase:'first'}},{key:'middle',value:2},{key:'stable',value:last}];
        wx.batchSetStorage({kvList,
          success(result){order.push('success');success=result;throw new Error('batch success callback');},
          fail(){order.push('unexpectedFail');},
          complete(result){order.push('complete');same=result===success;}
        }).then(function(result){order.push('resolve');same=same&&result===success;},function(){order.push('unexpectedReject');});
        last.phase='mutated';order.push('returned');
        return {order:order.slice(),keys:wx.getStorageInfoSync().keys,stable:wx.getStorageSync('stable'),middle:wx.getStorageSync('middle')};
      };
      exports.status=function(){return {order,same};};
    "#).unwrap();
    assert_eq!(
        call(&mut engine, module, "fail"),
        json!({
            "order":["returned"],"keys":["stable"],"stable":"baseline"
        })
    );
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert_eq!(
        call(&mut engine, module, "status"),
        json!({
            "order":["returned","fail","complete","reject"],"same":true
        })
    );
    assert!(
        engine.drain_host_events().unwrap()[0]["__storageTransactions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        call(&mut engine, module, "succeed"),
        json!({
            "order":["returned"],"keys":["middle","stable"],"stable":{"phase":"last"},"middle":2
        })
    );
    JsEngine::drain_microtasks(&mut engine).unwrap();
    assert_eq!(
        call(&mut engine, module, "status"),
        json!({
            "order":["returned","success","complete","resolve"],"same":true
        })
    );
    let effects = engine.drain_host_events().unwrap();
    let transactions = effects[0]["__storageTransactions"].as_array().unwrap();
    assert_eq!(transactions.len(), 1);
    assert_eq!(transactions[0]["sequence"], "1");
    assert_eq!(
        transactions[0]["patches"],
        json!([
            {"op":"set","key":"stable","valueJson":"{\"phase\":\"first\"}","undefined":false},
            {"op":"set","key":"middle","valueJson":"2","undefined":false},
            {"op":"set","key":"stable","valueJson":"{\"phase\":\"last\"}","undefined":false}
        ])
    );
}
