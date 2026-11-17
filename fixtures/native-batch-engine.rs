// One transport contract for both native AppService adapters.
use container_core::{CallTarget, JsEngine};
use serde_json::{json, Value};

#[test]
fn native_batch_preserves_json_values_global_this_and_module_exports() {
    let mut engine = NativeEngine::default();
    let module = engine.load_module(br#"
      exports.echo = function(value) { return {globalThis:this===globalThis,value:value}; };
      exports.undefinedValue = function() {};
      exports.numbers = function() { return [NaN,Infinity,-Infinity,-0,undefined]; };
      globalThis['quoted"\\target'] = exports.echo;
    "#).unwrap();
    let input = json!({"text":"中文😀\u{2028}\u{2029}\"\\\n","nested":[null,true,1.25],"__proto__":{"x":1}});
    for target in [
        CallTarget::Module { id: module, export: "echo".into() },
        CallTarget::Global { name: "quoted\"\\target".into() },
    ] {
        let result = engine.call(target, vec![input.clone()]).unwrap();
        assert_eq!(result, vec![json!({"globalThis":true,"value":input})]);
    }
    assert_eq!(engine.call(CallTarget::Module{id:module,export:"undefinedValue".into()},vec![]).unwrap(), vec![Value::Null]);
    assert_eq!(engine.call(CallTarget::Module{id:module,export:"numbers".into()},vec![]).unwrap(), vec![Value::Null,Value::Null,Value::Null,json!(0),Value::Null]);
}

#[test]
fn native_batch_reports_exceptions_once_and_survives_mutable_global_intrinsics() {
    let mut engine = NativeEngine::default();
    let module = engine.load_module(br#"
      exports.fail = function() { throw new TypeError('batch failure'); };
      exports.tamper = function() {
        JSON.parse = JSON.stringify = Function.prototype.apply = Reflect.apply = function() { throw Error('tampered'); };
      };
      exports.echo = function(value) { return value; };
      exports.errors = function() { return __container_errors; };
    "#).unwrap();
    let call = |export:&str| CallTarget::Module{id:module,export:export.into()};
    assert!(engine.call(call("fail"),vec![]).is_err());
    let errors = engine.call(call("errors"),vec![]).unwrap();
    assert_eq!(errors.len(),1);
    assert_eq!(errors[0]["message"],"batch failure");
    assert_eq!(errors[0]["name"],"TypeError");
    engine.call(call("tamper"),vec![]).unwrap();
    assert_eq!(engine.call(call("echo"),vec![json!({"n":42})]).unwrap(),vec![json!({"n":42})]);
    assert!(engine.call(call("missing"),vec![]).is_err());
    let errors=engine.call(call("errors"),vec![]).unwrap();
    assert_eq!(errors.len(),2);
    assert_eq!(errors[1]["message"],"target is not callable");
}

#[test]
fn native_host_mirror_preflights_ordered_aliases_and_keeps_json_data_visible() {
    let mut engine = NativeEngine::default();
    let module = engine.load_module(br#"
      exports.exercise = function() {
        const sealed = Object.preventExtensions({a:1,b:2});
        const data = {count:0,left:sealed,right:sealed,items:[1,2,3]};
        const page = {data:data};
        __container_page_instances['1'] = page;
        let rejected = false;
        try {
          __container_apply_page_data_batch(1, [
            [['count'],false,99], [['left','a'],true,null], [['right','a'],false,2]
          ]);
        } catch (error) { rejected = error instanceof TypeError; }
        const atomic = rejected && data.count === 0 && sealed.a === 1;

        data.user = Object.freeze({name:'old'});
        Object.defineProperty(data,'hidden',{value:1,writable:true,configurable:true,enumerable:false});
        Object.defineProperty(data.items,1,{value:2,writable:false,configurable:true,enumerable:true});
        let setterCalls = 0;
        Object.defineProperty(Object.prototype,'inheritedSetter',{
          set:function(){setterCalls += 1;},configurable:true
        });
        const items = data.items;
        __container_apply_page_data_batch(1, [
          [['user'],false,{}], [['user','name'],false,'new'],
          [['hidden'],false,2], [['items',1],true,null],
          [['inheritedSetter'],false,5], [['__proto__','injected'],false,true]
        ]);
        delete Object.prototype.inheritedSetter;
        return {
          atomic:atomic, rootIdentity:page.data===data, arrayIdentity:data.items===items,
          name:data.user.name,hidden:data.hidden,hiddenEnumerable:Object.keys(data).includes('hidden'),
          items:data.items,setterCalls:setterCalls,inheritedSetter:data.inheritedSetter,
          prototypePolluted:Object.prototype.injected===true
        };
      };
    "#).unwrap();
    assert_eq!(engine.call(CallTarget::Module{id:module,export:"exercise".into()},vec![]).unwrap(), vec![json!({
        "atomic":true,"rootIdentity":true,"arrayIdentity":true,"name":"new",
        "hidden":2,"hiddenEnumerable":true,"items":[1,null,3],"setterCalls":0,
        "inheritedSetter":5,"prototypePolluted":false
    })]);
}
