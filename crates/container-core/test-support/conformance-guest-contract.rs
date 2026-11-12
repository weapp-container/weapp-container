use container_core::{
    ConformanceGuestObservation as Observation, ConformanceGuestRequest as Request,
    ConformanceGuestValue as GuestValue, ConformanceReceiverBinding as Binding,
    ConformanceThrownValue as Thrown,
};
use serde_json::{json, Value};

pub trait Harness {
    fn observe(&mut self, request: Request) -> Result<Observation, String>;
    fn call(&mut self, export: &str, args: Vec<Value>) -> Vec<Value>;
    fn activate(&mut self, id: u64);
    fn drain(&mut self);
}

pub const FIXTURE: &[u8] = br#"
const states = new WeakMap();
let calls = 0, serialized = 0, protoSerialized = 0, errorReads = 0, thenCalls = 0, getterReads = 0;
let resolvePending, rejectPending;
const thrown = Object.create(null, {
  message: { get(){ errorReads++; throw new Error('message must not be read'); } },
  constructor: { get(){ errorReads++; throw new Error('constructor must not be read'); } }
});
Page({
  data: {},
  onLoad(){ states.set(this, {value:1}); },
  onUnload(){ states.delete(this); },
  increment(){ calls++; states.get(this).value++; },
  snapshot(){ return {value:states.get(this).value, nested:[false,0,'',null,[1,2]]}; },
  array(){ return [1,[2,3],{value:4}]; },
  nil(){ return null; },
  promise(){ calls++; return new Promise(function(resolve,reject){resolvePending=resolve;rejectPending=reject;}); },
  doublePromise(){ return new Promise(function(resolve,reject){ resolve('first'); reject('later'); resolve('last'); }); },
  throwPrimitive(){ calls++; throw 'actual throw'; },
  throwObject(){ calls++; throw thrown; },
  rejectPrimitive(){ return Promise.reject('actual rejection'); },
  rejectObject(){ return Promise.reject(thrown); },
  thenable(){ return {then(resolve,reject){thenCalls++;resolve('first');reject('later');}}; },
  thenGetter(){ return Object.create(null,{then:{get(){thenCalls++;return function(){};}}}); },
  customPromiseThen(){ const value=Promise.resolve('native');value.then=function(){thenCalls++;};return value; },
  nullPromiseThen(){ const value=Promise.resolve('native');value.then=null;return value; },
  badPromiseSpecies(){ const value=Promise.resolve('native');Object.defineProperty(value,'constructor',{get(){throw new Error('actual species getter');}});return value; },
  retiringPromiseSpecies(id){calls++;const value=Promise.resolve('native');Object.defineProperty(value,'constructor',{get(){thenCalls++;__container_invoke_page_instance(id,0,'onUnload',[]);return Promise;}});return value;},
  projected(){ return {toJSON(){ serialized++; return {value:7}; }}; },
  retirePromise(id){ const value=Promise.resolve('retired');Object.defineProperty(value,'constructor',{get(){thenCalls++;return Promise;}});__container_invoke_page_instance(id,0,'onUnload',[]);return value; },
  projectedRetire(id){return {toJSON(){serialized++;__container_invoke_page_instance(id,0,'onUnload',[]);return {actual:1};}};},
  bad(mode){
    calls++;
    if(mode==='nested-undefined')return {value:undefined};
    if(mode==='hole')return new Array(1);
    if(mode==='nan')return NaN;
    if(mode==='infinity')return Infinity;
    if(mode==='negative-zero')return -0;
    if(mode==='boxed-nan')return new Number(NaN);
    if(mode==='boxed-negative-zero')return new Number(-0);
    if(mode==='function')return function(){};
    if(mode==='symbol')return Symbol('value');
    if(mode==='bigint')return 1n;
    if(mode==='cycle'){const value={};value.self=value;return value;}
    if(mode==='toJSON-undefined')return {toJSON(){serialized++;return undefined;}};
    if(mode==='toJSON-function')return {toJSON(){serialized++;return function(){};}};
    if(mode==='toJSON-symbol')return {toJSON(){serialized++;return Symbol('projected');}};
    if(mode==='oversized')return 'x'.repeat(262145);
    if(mode==='projection-hides-undefined')return {unsupported:undefined,toJSON(){serialized++;return {actual:1};}};
    if(mode==='boxed-projection')return {number:new Number(7),boolean:new Boolean(false),string:new String('x')};
    if(mode==='json-projection'){
      const value={visible:1};Object.defineProperty(value,'hidden',{value:2});value[Symbol('key')]=3;return value;
    }
  }
});
exports.mountComponent=function(pageId,scopeId,value){
 __container_registration_module_id='conformance:data-component';
 __container_managed_component_modules['conformance:data-component']=true;
 Component({properties:{value:{type:Number,value:0}},data:{independent:'component-instance'}});
 __container_registration_module_id=null;
 __container_reconcile_components({version:1,phase:'prepare',pageId:pageId,instances:[{scopeId:scopeId,moduleId:'conformance:data-component',parentScopeId:null,ownerScopeId:null,properties:{value:value}}],remove:[]});
};
exports.configureData=function(value){const page=getCurrentPages()[0];page.data.value=value;return null;};
exports.dataAccessor=function(){Object.defineProperty(getCurrentPages()[0].data,'value',{get(){getterReads++;throw new Error('data accessor must not execute');},configurable:true});};
exports.logs=function(mode){
 if(mode==='ordinary'){console.log('native-info');console.warn('native-warning');console.error('native-error');__container_report_error(new Error('native-exception'));}
 if(mode==='sabotage'){__container_errors=[];JSON.stringify=function(){throw new Error('mutable stringify');};Object.getOwnPropertyDescriptor=function(){throw new Error('mutable own');};console.error('after-public-sabotage');}
 if(mode==='text-budget'){console.log('x'.repeat(32768));console.log('y'.repeat(32768));console.log('z');}
 if(mode==='stack-hook'){const error=new Error('stack-hook');Error.prepareStackTrace=function(){getterReads++;return 'custom';};console.error(error);}
 if(mode==='empty-object'){console.error({});console.group('actual group');console.groupEnd();}
 if(mode==='overflow'){for(let at=0;at<1025;at++)console.log('bounded');}
 if(mode==='accessor'){console.error(Object.create(null,{value:{enumerable:true,get(){getterReads++;throw new Error('log accessor must not execute');}}}));console.error(Object.create(null,{stack:{get(){getterReads++;throw new Error('custom stack getter must not execute');}}}));}
};
exports.errorLog=function(){const error=new Error('native-object-error');console.error(error);return {name:error.name,message:error.message,stack:error.stack};};
exports.resolve=function(value){resolvePending(value);};
exports.reject=function(value){rejectPending(value);};
exports.resolveProjected=function(){resolvePending({toJSON(){serialized++;return {late:true};}});};
exports.calls=function(){return calls;};
exports.serialized=function(){return serialized;};
exports.protoSerialized=function(){return protoSerialized;};
exports.errorReads=function(){return errorReads;};
exports.thenCalls=function(){return thenCalls;};
exports.getterReads=function(){return getterReads;};
exports.installReentrantGetter=function(){
  Object.defineProperty(getCurrentPages()[0],'reentrantLookup',{get(){
    getterReads++;this.increment();return function(){calls++;return {value:states.get(this).value};};
  }});
};
exports.installRetiringGetter=function(){
  Object.defineProperty(getCurrentPages()[0],'retireBeforeApply',{get(){
    __container_invoke_page_instance(1,0,'onUnload',[]);
    return function(){calls++;};
  }});
};
exports.sabotageIntrinsics=function(){
  JSON.stringify=function(){throw new Error('mutable stringify');};
  Reflect.apply=function(){throw new Error('mutable apply');};
  Array.prototype.indexOf=function(){throw new Error('mutable indexOf');};
  Object.getOwnPropertyDescriptor=function(){throw new Error('mutable descriptor');};
  Object.getPrototypeOf=function(){throw new Error('mutable prototype');};
  Promise.prototype.then=function(){throw new Error('mutable then');};
};
exports.installPrototypeToJSON=function(){
  Object.prototype.toJSON=function(){protoSerialized++;return 'second serialization';};
};
exports.publicObserver=function(){return typeof globalThis.__container_conformance_guest;};
"#;

fn binding(harness: &mut impl Harness, id: u64) -> Binding {
    match harness
        .observe(Request::Acquire {
            page_id: id.to_string(),
        })
        .unwrap()
    {
        Observation::Acquired { binding } => binding,
        other => panic!("expected actual receiver acquisition, got {other:?}"),
    }
}

fn begin(
    harness: &mut impl Harness,
    binding: &Binding,
    owner: &str,
    method: &str,
    args: Vec<Value>,
) -> String {
    match harness
        .observe(Request::Begin {
            binding: binding.clone(),
            invocation_id: owner.into(),
            method: method.into(),
            args,
        })
        .unwrap()
    {
        Observation::Begun { ticket } => ticket,
        other => panic!("expected actual invocation ticket, got {other:?}"),
    }
}

fn poll(harness: &mut impl Harness, binding: &Binding, ticket: &str) -> Observation {
    harness
        .observe(Request::Poll {
            binding: binding.clone(),
            ticket: ticket.into(),
        })
        .unwrap()
}

fn fulfilled(
    harness: &mut impl Harness,
    binding: &Binding,
    owner: &str,
    method: &str,
    args: Vec<Value>,
) -> GuestValue {
    let ticket = begin(harness, binding, owner, method, args);
    match poll(harness, binding, &ticket) {
        Observation::Fulfilled { value, .. } => value,
        other => panic!("expected real synchronous result, got {other:?}"),
    }
}

pub fn actual_receiver_values(mut harness: impl Harness) {
    assert!(harness
        .observe(Request::Acquire {
            page_id: "999".into()
        })
        .is_err());
    let binding = binding(&mut harness, 1);
    let ticket = begin(&mut harness, &binding, "effect-1", "increment", vec![]);
    assert!(harness
        .observe(Request::Begin {
            binding: binding.clone(),
            invocation_id: "effect-1".into(),
            method: "increment".into(),
            args: vec![]
        })
        .is_err());
    assert_eq!(
        poll(&mut harness, &binding, &ticket),
        Observation::Fulfilled {
            ticket: ticket.clone(),
            value: GuestValue::Undefined
        }
    );
    assert!(harness
        .observe(Request::Poll {
            binding: binding.clone(),
            ticket
        })
        .is_err());
    assert_eq!(harness.call("calls", vec![]), vec![json!(1)]);
    assert_eq!(
        fulfilled(&mut harness, &binding, "snapshot-1", "snapshot", vec![]),
        GuestValue::Json {
            value: json!({"value":2,"nested":[false,0,"",null,[1,2]]})
        }
    );
    assert_eq!(
        fulfilled(&mut harness, &binding, "array-1", "array", vec![]),
        GuestValue::Json {
            value: json!([1,[2,3],{"value":4}])
        }
    );
    assert_eq!(
        fulfilled(&mut harness, &binding, "null-1", "nil", vec![]),
        GuestValue::Json { value: Value::Null }
    );
    assert_eq!(
        harness.call("publicObserver", vec![]),
        vec![json!("undefined")]
    );
}

pub fn pending_settlement_and_cancellation(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    let ticket = begin(&mut harness, &binding, "promise-1", "promise", vec![]);
    for _ in 0..2 {
        assert_eq!(
            poll(&mut harness, &binding, &ticket),
            Observation::Pending {
                ticket: ticket.clone()
            }
        );
    }
    assert_eq!(harness.call("calls", vec![]), vec![json!(1)]);
    harness.call("resolve", vec![json!({"settled":[1,2]})]);
    assert_eq!(
        poll(&mut harness, &binding, &ticket),
        Observation::Pending {
            ticket: ticket.clone()
        }
    );
    harness.drain();
    assert_eq!(
        poll(&mut harness, &binding, &ticket),
        Observation::Fulfilled {
            ticket: ticket.clone(),
            value: GuestValue::Json {
                value: json!({"settled":[1,2]})
            }
        }
    );
    let cancelled = begin(&mut harness, &binding, "promise-2", "promise", vec![]);
    assert_eq!(
        harness
            .observe(Request::Cancel {
                ticket: cancelled.clone()
            })
            .unwrap(),
        Observation::Cancelled {
            ticket: cancelled.clone()
        }
    );
    harness.call("resolveProjected", vec![]);
    harness.drain();
    assert_eq!(harness.call("serialized", vec![]), vec![json!(0)]);
    assert!(harness
        .observe(Request::Poll {
            binding: binding.clone(),
            ticket: cancelled
        })
        .is_err());
    assert!(harness
        .observe(Request::Begin {
            binding: binding.clone(),
            invocation_id: "promise-2".into(),
            method: "increment".into(),
            args: vec![]
        })
        .is_err());
    let double = begin(
        &mut harness,
        &binding,
        "native-first-wins",
        "doublePromise",
        vec![],
    );
    harness.drain();
    assert_eq!(
        poll(&mut harness, &binding, &double),
        Observation::Fulfilled {
            ticket: double.clone(),
            value: GuestValue::Json {
                value: json!("first")
            }
        }
    );
}

pub fn thrown_and_rejected_values(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    let thrown = begin(
        &mut harness,
        &binding,
        "throw-primitive",
        "throwPrimitive",
        vec![],
    );
    assert_eq!(
        poll(&mut harness, &binding, &thrown),
        Observation::Threw {
            ticket: thrown.clone(),
            reason: Thrown::Json {
                value: json!("actual throw")
            }
        }
    );
    let object = begin(
        &mut harness,
        &binding,
        "throw-object",
        "throwObject",
        vec![],
    );
    assert_eq!(
        poll(&mut harness, &binding, &object),
        Observation::Threw {
            ticket: object.clone(),
            reason: Thrown::Uninspectable {
                value_type: "object".into()
            }
        }
    );
    let rejected = begin(
        &mut harness,
        &binding,
        "reject-primitive",
        "rejectPrimitive",
        vec![],
    );
    assert_eq!(
        poll(&mut harness, &binding, &rejected),
        Observation::Pending {
            ticket: rejected.clone()
        }
    );
    harness.drain();
    assert_eq!(
        poll(&mut harness, &binding, &rejected),
        Observation::Rejected {
            ticket: rejected.clone(),
            reason: Thrown::Json {
                value: json!("actual rejection")
            }
        }
    );
    let object = begin(
        &mut harness,
        &binding,
        "reject-object",
        "rejectObject",
        vec![],
    );
    harness.drain();
    assert_eq!(
        poll(&mut harness, &binding, &object),
        Observation::Rejected {
            ticket: object.clone(),
            reason: Thrown::Uninspectable {
                value_type: "object".into()
            }
        }
    );
    assert_eq!(harness.call("errorReads", vec![]), vec![json!(0)]);
    assert_eq!(harness.call("calls", vec![]), vec![json!(2)]);
}

pub fn strict_json_and_thenable_domain(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    for mode in [
        "nested-undefined",
        "hole",
        "nan",
        "infinity",
        "negative-zero",
        "boxed-nan",
        "boxed-negative-zero",
        "function",
        "symbol",
        "bigint",
        "cycle",
        "toJSON-undefined",
        "toJSON-function",
        "toJSON-symbol",
        "oversized",
    ] {
        let ticket = begin(&mut harness, &binding, mode, "bad", vec![json!(mode)]);
        assert_eq!(
            poll(&mut harness, &binding, &ticket),
            Observation::SerializationFailed {
                ticket: ticket.clone(),
                code: "ERR_CONFORMANCE_RESULT_SERIALIZATION".into()
            },
            "{mode}"
        );
    }
    assert_eq!(harness.call("calls", vec![]), vec![json!(15)]);
    // This is explicitly the JSON projection, not full JS object equivalence.
    assert_eq!(
        fulfilled(
            &mut harness,
            &binding,
            "projection",
            "bad",
            vec![json!("json-projection")]
        ),
        GuestValue::Json {
            value: json!({"visible":1})
        }
    );
    assert_eq!(
        fulfilled(
            &mut harness,
            &binding,
            "projection-hides-undefined",
            "bad",
            vec![json!("projection-hides-undefined")]
        ),
        GuestValue::Json {
            value: json!({"actual":1})
        }
    );
    assert_eq!(
        fulfilled(
            &mut harness,
            &binding,
            "boxed-projection",
            "bad",
            vec![json!("boxed-projection")]
        ),
        GuestValue::Json {
            value: json!({"number":7,"boolean":false,"string":"x"})
        }
    );
    for method in [
        "thenable",
        "thenGetter",
        "customPromiseThen",
        "nullPromiseThen",
        "badPromiseSpecies",
    ] {
        let ticket = begin(&mut harness, &binding, method, method, vec![]);
        assert_eq!(
            poll(&mut harness, &binding, &ticket),
            Observation::Unsupported {
                ticket: ticket.clone(),
                code: "ERR_CONFORMANCE_THENABLE".into()
            }
        );
    }
    assert_eq!(harness.call("thenCalls", vec![]), vec![json!(0)]);
}

pub fn retired_binding_and_new_incarnation(mut harness: impl Harness) {
    let old = binding(&mut harness, 1);
    let pending = begin(&mut harness, &old, "old-promise", "promise", vec![]);
    harness.activate(2);
    assert_eq!(
        poll(&mut harness, &old, &pending),
        Observation::Revoked {
            ticket: pending.clone()
        }
    );
    assert!(harness
        .observe(Request::Acquire {
            page_id: "1".into()
        })
        .is_err());
    assert!(harness
        .observe(Request::Begin {
            binding: old.clone(),
            invocation_id: "stale".into(),
            method: "increment".into(),
            args: vec![]
        })
        .is_err());
    let fresh = binding(&mut harness, 2);
    assert_ne!(old.token, fresh.token);
    assert_eq!(
        fulfilled(&mut harness, &fresh, "fresh-snapshot", "snapshot", vec![]),
        GuestValue::Json {
            value: json!({"value":1,"nested":[false,0,"",null,[1,2]]})
        }
    );
    harness.call("resolve", vec![json!("late old page")]);
    harness.drain();
    assert!(harness
        .observe(Request::Poll {
            binding: old,
            ticket: pending
        })
        .is_err());
}

pub fn lookup_revalidates_before_apply(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    harness.call("installRetiringGetter", vec![]);
    let ticket = begin(
        &mut harness,
        &binding,
        "retiring-getter",
        "retireBeforeApply",
        vec![],
    );
    assert_eq!(
        poll(&mut harness, &binding, &ticket),
        Observation::Revoked {
            ticket: ticket.clone()
        }
    );
    assert_eq!(harness.call("calls", vec![]), vec![json!(0)]);
    assert!(harness
        .observe(Request::Begin {
            binding,
            invocation_id: "retiring-getter".into(),
            method: "increment".into(),
            args: vec![]
        })
        .is_err());
}

pub fn captured_intrinsics_and_single_projection(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    harness.call("sabotageIntrinsics", vec![]);
    harness.call("installPrototypeToJSON", vec![]);
    assert_eq!(
        fulfilled(&mut harness, &binding, "project-once", "projected", vec![]),
        GuestValue::Json {
            value: json!({"value":7})
        }
    );
    assert_eq!(harness.call("serialized", vec![]), vec![json!(1)]);
    assert_eq!(harness.call("protoSerialized", vec![]), vec![json!(0)]);
}

pub fn retirement_before_promise_or_projection(mut harness: impl Harness) {
    let first = binding(&mut harness, 1);
    let ticket = begin(
        &mut harness,
        &first,
        "retire-before-then",
        "retirePromise",
        vec![json!(1)],
    );
    assert_eq!(
        poll(&mut harness, &first, &ticket),
        Observation::Revoked {
            ticket: ticket.clone()
        }
    );
    assert_eq!(harness.call("thenCalls", vec![]), vec![json!(0)]);
    harness.activate(2);
    let second = binding(&mut harness, 2);
    let ticket = begin(
        &mut harness,
        &second,
        "retire-during-projection",
        "projectedRetire",
        vec![json!(2)],
    );
    assert_eq!(
        poll(&mut harness, &second, &ticket),
        Observation::Revoked {
            ticket: ticket.clone()
        }
    );
    assert_eq!(harness.call("serialized", vec![]), vec![json!(1)]);
    assert!(harness
        .observe(Request::Poll {
            binding: second,
            ticket
        })
        .is_err());
}

pub fn reentrant_method_getter_and_owner_tombstone(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    harness.call("installReentrantGetter", vec![]);
    assert_eq!(
        fulfilled(
            &mut harness,
            &binding,
            "getter-once",
            "reentrantLookup",
            vec![]
        ),
        GuestValue::Json {
            value: json!({"value":2})
        }
    );
    assert!(harness
        .observe(Request::Begin {
            binding,
            invocation_id: "getter-once".into(),
            method: "reentrantLookup".into(),
            args: vec![]
        })
        .is_err());
    assert_eq!(harness.call("getterReads", vec![]), vec![json!(1)]);
    assert_eq!(harness.call("calls", vec![]), vec![json!(2)]);
}

pub fn irreversible_owner_ledger_exhaustion(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    for index in 0..1024 {
        assert_eq!(
            fulfilled(
                &mut harness,
                &binding,
                &format!("bounded-owner-{index}"),
                "increment",
                vec![]
            ),
            GuestValue::Undefined
        );
    }
    assert!(harness
        .observe(Request::Begin {
            binding,
            invocation_id: "overflow-owner".into(),
            method: "increment".into(),
            args: vec![]
        })
        .is_err());
    assert_eq!(harness.call("calls", vec![]), vec![json!(1024)]);
}

pub fn native_promise_species_retires_receiver(mut harness: impl Harness) {
    let binding = binding(&mut harness, 1);
    let ticket = begin(
        &mut harness,
        &binding,
        "retire-in-native-species",
        "retiringPromiseSpecies",
        vec![json!(1)],
    );
    assert_eq!(
        poll(&mut harness, &binding, &ticket),
        Observation::Revoked {
            ticket: ticket.clone()
        }
    );
    harness.drain();
    assert!(harness.observe(Request::Poll { binding, ticket }).is_err());
    assert_eq!(harness.call("calls", vec![]), vec![json!(1)]);
    assert_eq!(harness.call("thenCalls", vec![]), vec![json!(1)]);
    assert_eq!(harness.call("serialized", vec![]), vec![json!(0)]);
}

pub fn private_data_reads(mut h: impl Harness) {
    let bound = binding(&mut h, 1);
    h.call("configureData", vec![json!("actual receiver value")]);
    let request = |path: &str| Request::ReadData {
        binding: bound.clone(),
        scope_id: None,
        path: path.into(),
    };
    match h.observe(request("value")).unwrap() {
        Observation::Data {
            value: GuestValue::Json { value },
            receiver_token,
        } => {
            assert_eq!(value, json!("actual receiver value"));
            assert_eq!(receiver_token, bound.token);
        }
        other => panic!("{other:?}"),
    }
    assert!(matches!(
        h.observe(request("missing")).unwrap(),
        Observation::Data {
            value: GuestValue::Undefined,
            ..
        }
    ));
    assert!(h.observe(request("value.nested")).is_err());
    h.call("dataAccessor", vec![]);
    assert!(h.observe(request("value")).is_err());
    assert_eq!(h.call("getterReads", vec![]), vec![json!(0)]);
    h.activate(2);
    assert!(h.observe(request("value")).is_err());
}
pub fn native_runtime_log_journal(mut h: impl Harness) {
    let read = |h: &mut dyn Harness, reset| h.observe(Request::RuntimeLogs { reset }).unwrap();
    h.call("logs", vec![json!("ordinary")]);
    let before = read(&mut h, false);
    match &before {
        Observation::RuntimeLogs {
            generation,
            start_cursor,
            end_cursor,
            entries,
            complete,
            overflow,
            ..
        } => {
            assert_eq!(
                (
                    *generation,
                    *start_cursor,
                    *end_cursor,
                    *complete,
                    *overflow
                ),
                (0, 0, 4, true, false)
            );
            assert_eq!(
                entries
                    .iter()
                    .map(|entry| entry.level.as_str())
                    .collect::<Vec<_>>(),
                vec!["log", "warn", "error", "exception"]
            );
            assert_eq!(entries[0].text, "native-info");
            assert_eq!(entries[2].text, "native-error");
            assert!(entries[3].text.contains("native-exception"));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(before, read(&mut h, false));
    h.call("logs", vec![json!("sabotage")]);
    match read(&mut h, false) {
        Observation::RuntimeLogs {
            entries, complete, ..
        } => {
            assert!(complete);
            assert_eq!(entries.len(), 5);
            assert_eq!(entries[4].text, "after-public-sabotage");
        }
        other => panic!("{other:?}"),
    }
    h.activate(2);
    match read(&mut h, true) {
        Observation::RuntimeLogs {
            generation,
            start_cursor,
            end_cursor,
            reset_cursor,
            entries,
            complete,
            ..
        } => {
            assert_eq!(generation, 1);
            assert_eq!(start_cursor, 0);
            assert_eq!(end_cursor, 5);
            assert_eq!(reset_cursor, 5);
            assert_eq!(entries.len(), 5);
            assert!(complete);
        }
        other => panic!("{other:?}"),
    }
}
pub fn native_runtime_log_overflow(mut h: impl Harness) {
    h.call("logs", vec![json!("overflow")]);
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries,
            complete,
            overflow,
            end_cursor,
            ..
        } => {
            assert_eq!(entries.len(), 1024);
            assert_eq!(end_cursor, 1025);
            assert!(!complete);
            assert!(overflow);
        }
        other => panic!("{other:?}"),
    }
}
pub fn native_runtime_log_accessors(mut h: impl Harness) {
    h.call("logs", vec![json!("accessor")]);
    assert_eq!(h.call("getterReads", vec![]), vec![json!(0)]);
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries,
            complete,
            overflow,
            ..
        } => {
            assert!(entries.is_empty());
            assert!(!complete);
            assert!(overflow);
        }
        other => panic!("{other:?}"),
    }
}

pub fn private_component_data_reads(mut h: impl Harness) {
    let bound = binding(&mut h, 1);
    h.call(
        "mountComponent",
        vec![json!(1), json!("actual-count-component"), json!(1_000_000)],
    );
    match h
        .observe(Request::ReadData {
            binding: bound.clone(),
            scope_id: Some("actual-count-component".into()),
            path: "value".into(),
        })
        .unwrap()
    {
        Observation::Data {
            value: GuestValue::Json { value },
            receiver_token,
        } => {
            assert_eq!(value, json!(1_000_000));
            assert_ne!(receiver_token, bound.token)
        }
        other => panic!("{other:?}"),
    }
    assert!(h
        .observe(Request::ReadData {
            binding: bound.clone(),
            scope_id: Some("unknown-component".into()),
            path: "value".into()
        })
        .is_err());
    h.activate(2);
    assert!(h
        .observe(Request::ReadData {
            binding: bound,
            scope_id: Some("actual-count-component".into()),
            path: "value".into()
        })
        .is_err());
}

pub fn native_runtime_log_text_budget(mut h: impl Harness) {
    h.call("logs", vec![json!("text-budget")]);
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries,
            end_cursor,
            complete,
            overflow,
            ..
        } => {
            assert_eq!(entries.len(), 2);
            assert_eq!(
                entries.iter().map(|entry| entry.text.len()).sum::<usize>(),
                65536
            );
            assert_eq!(end_cursor, 3);
            assert!(!complete);
            assert!(overflow);
        }
        other => panic!("{other:?}"),
    }
}

pub fn native_runtime_log_empty_object(mut h: impl Harness) {
    h.call("logs", vec![json!("empty-object")]);
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries, complete, ..
        } => {
            assert!(complete);
            assert_eq!(entries.len(), 2);
            assert_eq!(entries[1].level, "log");
            assert_eq!(entries[1].text, "actual group");
            assert_eq!(entries[0].level, "error");
            assert_eq!(entries[0].text, r#"{"type":"error","args":[{}]}"#);
        }
        other => panic!("{other:?}"),
    }
}

pub fn native_runtime_log_error_object(mut h: impl Harness) {
    let actual = h.call("errorLog", vec![])[0].clone();
    let summary = format!(
        "{}: {}",
        actual["name"].as_str().unwrap(),
        actual["message"].as_str().unwrap()
    );
    let stack = actual["stack"].as_str().unwrap();
    let expected = if stack.starts_with(&summary) {
        stack.to_owned()
    } else {
        format!("{summary}\n{stack}")
    };
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries, complete, ..
        } => {
            assert!(complete);
            assert_eq!(entries.len(), 1);
            assert_eq!(entries[0].level, "error");
            assert_eq!(entries[0].text, expected.trim());
        }
        other => panic!("{other:?}"),
    }
}

pub fn native_runtime_log_stack_hook(mut h: impl Harness) {
    h.call("logs", vec![json!("stack-hook")]);
    assert_eq!(h.call("getterReads", vec![]), vec![json!(0)]);
    match h.observe(Request::RuntimeLogs { reset: false }).unwrap() {
        Observation::RuntimeLogs {
            entries,
            complete,
            overflow,
            ..
        } => {
            assert!(entries.is_empty());
            assert!(!complete);
            assert!(overflow);
        }
        other => panic!("{other:?}"),
    }
}
