use super::QuickJsEngine as Engine;
use container_core::{ApiDeliveryOutcome, ApiDeliveryProvider, CallTarget, JsEngine, SyncHostApi};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
struct DeliveryFixture {
    generation: AtomicU64,
    claims: AtomicUsize,
}

impl ApiDeliveryProvider for DeliveryFixture {
    fn claim(&self, request_id: u64, ticket: &str) -> ApiDeliveryOutcome {
        self.claims.fetch_add(1, Ordering::SeqCst);
        if ticket == "panic" {
            panic!("native delivery provider test panic");
        }
        if ticket == "retired" {
            return ApiDeliveryOutcome::Retired;
        }
        if ticket == "raw-failure" {
            return ApiDeliveryOutcome::Failure(json!({
                "code":"permission_denied", "errCode":-8701,
                "errMsg":"getUserProfile:fail user denied", "publicDetail":{"limited":true}
            }));
        }
        if ticket == "null-failure" {
            return ApiDeliveryOutcome::Failure(Value::Null);
        }
        if ticket == "false-failure" {
            return ApiDeliveryOutcome::Failure(json!(false));
        }
        if self.generation.load(Ordering::SeqCst) != 0 {
            return ApiDeliveryOutcome::Failure(json!({
                "code":"permission_denied", "errCode":-8702,
                "errMsg":"getUserProfile:fail consent revoked"
            }));
        }
        if ticket == "invalid-binary" {
            return ApiDeliveryOutcome::Success(
                json!({"__weappBinary":{"type":"ArrayBuffer","bytes":[256]}}),
            );
        }
        if ticket == "request-bytes" || ticket == "invalid-request-bytes" {
            return ApiDeliveryOutcome::Success(json!({
                "dataEncoding":"bytes", "data":if ticket == "request-bytes" {vec![7,11]} else {vec![256]}
            }));
        }
        if ticket == "large-request-bytes" {
            return ApiDeliveryOutcome::Success(json!({
                "dataEncoding":"bytes", "data":vec![7; 1_048_577]
            }));
        }
        ApiDeliveryOutcome::Success(json!({
            "requestId":request_id,
            "data":{"__weappBinary":{"type":"ArrayBuffer","bytes":[7,11]}}
        }))
    }
}

impl SyncHostApi for DeliveryFixture {
    fn supported_apis(&self) -> Vec<String> {
        vec!["test.revoke".into()]
    }
    fn invoke(&self, name: &str, _: Value) -> Result<Value, Value> {
        assert_eq!(name, "test.revoke");
        self.generation.fetch_add(1, Ordering::SeqCst);
        Ok(Value::Null)
    }
}

fn fixture(install_provider: bool) -> (Engine, Arc<DeliveryFixture>, container_core::ModuleId) {
    let mut engine = Engine::default();
    let provider = Arc::new(DeliveryFixture::default());
    if install_provider {
        engine
            .install_api_delivery_provider(provider.clone())
            .unwrap();
    }
    engine.install_sync_host_api(provider.clone()).unwrap();
    let module = engine.load_module(br#"
      const log = [], values = [];
      const originalPush = Array.prototype.push, originalHelper = __container_invoke_api_callback;
      const originalSome = Array.prototype.some, originalForEach = Array.prototype.forEach;
      const originalIsArray = Array.isArray, originalKeys = Object.keys, originalDefine = Object.defineProperty;
      const originalNumber = Number, originalUint8 = Uint8Array, originalArrayBuffer = ArrayBuffer;
      const originalIterator = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator);
      const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
      const originalBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer');
      let hostileLog = '', hostileValue;
      let largeRequest;
      function hostileError(mode) {
        const error = {};
        Object.defineProperty(error, 'message', {get:function() {
          if (mode === 'freeze-errors') Object.freeze(__container_errors);
          else Array.prototype.push = function(){throw new Error('replaced array push');};
          throw new Error('unreportable callback value');
        }});
        throw error;
      }
      exports.startHostile = function(mode) {
        const promise = __container_api_call('wx.getUserProfile', {
          success:function(value) { hostileValue = value; hostileLog += 'success;'; hostileError(mode); },
          fail:function(value) { hostileValue = value; hostileLog += 'fail;'; hostileError(mode); },
          complete:function() { hostileLog += 'complete;'; hostileError(mode); }
        });
        promise.then(function(){hostileLog+='resolve;';},function(){hostileLog+='reject;';});
        return __container_api_id;
      };
      exports.restoreHostile = function() {
        Array.prototype.push = originalPush;
        globalThis.__container_invoke_api_callback = originalHelper;
      };
      exports.readHostile = function() { return {log:hostileLog,value:hostileValue,errors:__container_errors.length}; };
      exports.replaceHelper = function() { globalThis.__container_invoke_api_callback = function(){throw new Error('replaced callback helper');}; };
      exports.startLargeRequest = function() {
        const promise = __container_api_call('wx.request', {
          success:function(value) {
            const bytes = new originalUint8(value.data);
            largeRequest = {length:value.data.byteLength,first:bytes[0],last:bytes[bytes.length - 1]};
          },
          fail:function(error) { largeRequest = {error:error}; }
        });
        promise.catch(function(){});
        return __container_api_id;
      };
      exports.readLargeRequest = function() { return largeRequest; };
      exports.start = function(label, mode, name) {
        const promise = __container_api_call(name || 'wx.getUserProfile', {
          success: function(value) {
            log.push(label + '.success'); values.push(value);
            if (mode === 'revoke') __container_host_sync_call('test.revoke', '{}');
            if (mode === 'throw') throw new Error('callback failed');
          },
          fail: function(error) { log.push(label + '.fail'); values.push(error); },
          complete: function() { log.push(label + '.complete'); }
        });
        promise.then(function(){log.push(label+'.resolve');},function(){log.push(label+'.reject');});
        return __container_api_id;
      };
      exports.read = function() {
        return {log:log,values:values.map(function(value) {
          if (value && value.data instanceof ArrayBuffer) return {requestId:value.requestId,bytes:Array.from(new Uint8Array(value.data))};
          return value;
        }),errors:__container_errors.length};
      };
      exports.tamper = function() {
        try { globalThis.__container_host_api_delivery_claim = function(){return '{"status":"success","result":{"forged":true}}';}; } catch (_) {}
        try { Object.defineProperty(globalThis,'__container_host_api_delivery_claim',{value:function(){return '{}';}}); } catch (_) {}
        JSON.parse = function(){return {status:'success',result:{forged:true}};};
        const descriptor = Object.getOwnPropertyDescriptor(globalThis,'__container_host_api_delivery_claim');
        return {writable:descriptor.writable,configurable:descriptor.configurable};
      };
      exports.queueWithPoisonedScheduler = function(id, ticket, mode) {
        const constructor = Object.getOwnPropertyDescriptor(Promise.prototype, 'constructor');
        const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
        try {
          if (mode === 'constructor') {
            Object.defineProperty(Promise.prototype, 'constructor', {configurable:true,get:function(){throw new Error('replaced constructor getter');}});
          } else {
            Object.defineProperty(Promise, Symbol.species, {configurable:true,get:function(){throw new Error('replaced species getter');}});
          }
          return __container_resolve_api(id, null, null, ticket);
        } finally {
          Object.defineProperty(Promise.prototype, 'constructor', constructor);
          Object.defineProperty(Promise, Symbol.species, species);
        }
      };
      exports.queueWithForgedDecoder = function(id, ticket) {
        return __container_resolve_api(id, {forged:true}, null, ticket, function(){return {forged:true};});
      };
      exports.poisonDecode = function(mode) {
        if (mode === 'some') Array.prototype.some = function(){return false;};
        if (mode === 'forEach') Array.prototype.forEach = function(){};
        if (mode === 'isArray') Array.isArray = function(){return false;};
        if (mode === 'keys') Object.keys = function(){return [];};
        if (mode === 'defineProperty') Object.defineProperty = function(value){return value;};
        if (mode === 'number') globalThis.Number = function(){return 777;};
        if (mode === 'uint8') globalThis.Uint8Array = function(){return {buffer:'forged-buffer'};};
        if (mode === 'arrayBuffer') globalThis.ArrayBuffer = function(){throw new Error('replaced ArrayBuffer');};
        if (mode === 'iterator') Object.defineProperty(Array.prototype, Symbol.iterator, {configurable:true,value:function*(){yield 99;}});
        if (mode === 'buffer') Object.defineProperty(typedArrayPrototype, 'buffer', {configurable:true,get:function(){return 'forged-buffer';}});
      };
      exports.restoreDecode = function() {
        Array.prototype.some = originalSome; Array.prototype.forEach = originalForEach;
        Array.isArray = originalIsArray; Object.keys = originalKeys; Object.defineProperty = originalDefine;
        globalThis.Number = originalNumber; globalThis.Uint8Array = originalUint8; globalThis.ArrayBuffer = originalArrayBuffer;
        Object.defineProperty(Array.prototype, Symbol.iterator, originalIterator);
        Object.defineProperty(typedArrayPrototype, 'buffer', originalBuffer);
      };
    "#).unwrap();
    (engine, provider, module)
}

fn call(
    engine: &mut Engine,
    module: container_core::ModuleId,
    export: &str,
    args: Vec<Value>,
) -> Value {
    let mut result = engine
        .call(
            CallTarget::Module {
                id: module,
                export: export.into(),
            },
            args,
        )
        .unwrap();
    assert_eq!(result.len(), 1);
    result.remove(0)
}

fn start(engine: &mut Engine, module: container_core::ModuleId, label: &str, mode: &str) -> u64 {
    call(engine, module, "start", vec![json!(label), json!(mode)])
        .as_u64()
        .unwrap()
}

fn queue(engine: &mut Engine, id: u64, ticket: &str) -> bool {
    engine
        .call(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                json!(id),
                json!({"forged":true}),
                Value::Null,
                json!(ticket),
            ],
        )
        .unwrap()
        == vec![json!(true)]
}

#[test]
fn api_delivery_claim_checks_after_queued_completion_before_callback() {
    let (mut engine, provider, module) = fixture(true);
    let id = start(&mut engine, module, "first", "");
    assert!(queue(&mut engine, id, "success"));
    assert_eq!(provider.claims.load(Ordering::SeqCst), 0);
    assert_eq!(call(&mut engine, module, "read", vec![])["log"], json!([]));
    provider.generation.store(1, Ordering::SeqCst);
    engine.drain_microtasks().unwrap();
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(
        state["log"],
        json!(["first.fail", "first.complete", "first.reject"])
    );
    assert_eq!(state["values"][0]["errCode"], -8702);
    assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
}

#[test]
fn api_delivery_callback_revoke_fences_later_microtask_without_reentry() {
    let (mut engine, provider, module) = fixture(true);
    let first = start(&mut engine, module, "first", "revoke");
    let second = start(&mut engine, module, "second", "");
    assert!(queue(&mut engine, first, "success"));
    assert!(queue(&mut engine, second, "success"));
    engine.drain_microtasks().unwrap();
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(
        state["log"],
        json!([
            "first.success",
            "first.complete",
            "second.fail",
            "second.complete",
            "first.resolve",
            "second.reject"
        ])
    );
    assert_eq!(
        state["values"][0],
        json!({"requestId":first,"bytes":[7,11]})
    );
    assert_eq!(state["values"][1]["errCode"], -8702);
    assert_eq!(provider.generation.load(Ordering::SeqCst), 1);
    assert_eq!(provider.claims.load(Ordering::SeqCst), 2);
}

#[test]
fn api_delivery_retired_and_duplicates_never_invoke_old_callbacks() {
    let (mut engine, provider, module) = fixture(true);
    let id = start(&mut engine, module, "old", "");
    assert!(queue(&mut engine, id, "retired"));
    assert!(!queue(&mut engine, id, "success"));
    engine.drain_microtasks().unwrap();
    assert!(!queue(&mut engine, id, "success"));
    engine.drain_microtasks().unwrap();
    assert_eq!(call(&mut engine, module, "read", vec![])["log"], json!([]));
    assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
}

#[test]
fn api_delivery_preserves_raw_and_falsy_failures() {
    for (ticket, expected) in [
        (
            "raw-failure",
            json!({"code":"permission_denied","errCode":-8701,"errMsg":"getUserProfile:fail user denied","publicDetail":{"limited":true}}),
        ),
        ("null-failure", Value::Null),
        ("false-failure", json!(false)),
    ] {
        let (mut engine, _, module) = fixture(true);
        let id = start(&mut engine, module, "call", "");
        assert!(queue(&mut engine, id, ticket));
        engine.drain_microtasks().unwrap();
        let state = call(&mut engine, module, "read", vec![]);
        assert_eq!(
            state["log"],
            json!(["call.fail", "call.complete", "call.reject"])
        );
        assert_eq!(state["values"][0], expected);
    }
}

#[test]
fn api_delivery_decode_error_and_missing_provider_settle_once() {
    for (installed, ticket, code) in [
        (true, "invalid-binary", "ERR_INVALID_RESPONSE"),
        (false, "success", "ERR_API_DELIVERY"),
        (true, "panic", "ERR_API_DELIVERY"),
    ] {
        let (mut engine, _, module) = fixture(installed);
        let id = start(&mut engine, module, "call", "");
        assert!(queue(&mut engine, id, ticket));
        engine.drain_microtasks().unwrap();
        let state = call(&mut engine, module, "read", vec![]);
        assert_eq!(
            state["log"],
            json!(["call.fail", "call.complete", "call.reject"])
        );
        assert_eq!(state["values"][0]["code"], code);
    }
}

#[test]
fn api_delivery_callback_throw_keeps_complete_and_promise_order() {
    let (mut engine, _, module) = fixture(true);
    let id = start(&mut engine, module, "call", "throw");
    assert!(queue(&mut engine, id, "success"));
    engine.drain_microtasks().unwrap();
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(
        state["log"],
        json!(["call.success", "call.complete", "call.resolve"])
    );
    assert_eq!(state["errors"], 1);
}

#[test]
fn api_delivery_sealed_hook_and_captured_parser_reject_guest_replacement() {
    let (mut engine, provider, module) = fixture(true);
    assert!(engine
        .install_api_delivery_provider(Arc::new(DeliveryFixture::default()))
        .is_err());
    let id = start(&mut engine, module, "call", "");
    assert_eq!(
        call(
            &mut engine,
            module,
            "queueWithForgedDecoder",
            vec![json!(id), json!("success")]
        ),
        true
    );
    assert_eq!(
        call(&mut engine, module, "tamper", vec![]),
        json!({"writable":false,"configurable":false})
    );
    provider.generation.store(1, Ordering::SeqCst);
    engine.drain_microtasks().unwrap();
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(
        state["log"],
        json!(["call.fail", "call.complete", "call.reject"])
    );
    assert_eq!(state["values"][0]["errCode"], -8702);
}

#[test]
fn api_delivery_legacy_success_failure_and_decode_error_keep_terminal_order() {
    for (result, error, expected, code) in [
        (
            json!({"value":3}),
            Value::Null,
            json!(["call.success", "call.complete", "call.resolve"]),
            None,
        ),
        (
            Value::Null,
            json!({"errCode":-9,"errMsg":"original denied"}),
            json!(["call.fail", "call.complete", "call.reject"]),
            None,
        ),
        (
            json!({"__weappBinary":{"type":"ArrayBuffer","bytes":[256]}}),
            Value::Null,
            json!(["call.fail", "call.complete", "call.reject"]),
            Some("ERR_INVALID_RESPONSE"),
        ),
    ] {
        let (mut engine, provider, module) = fixture(true);
        let id = start(&mut engine, module, "call", "");
        assert_eq!(
            engine
                .call(
                    CallTarget::Global {
                        name: "__container_resolve_api".into()
                    },
                    vec![json!(id), result, error.clone()]
                )
                .unwrap(),
            vec![json!(true)]
        );
        assert_eq!(call(&mut engine, module, "read", vec![])["log"], json!([]));
        engine.drain_microtasks().unwrap();
        let state = call(&mut engine, module, "read", vec![]);
        assert_eq!(state["log"], expected);
        if let Some(code) = code {
            assert_eq!(state["values"][0]["code"], code);
        } else if !error.is_null() {
            assert_eq!(state["values"][0], error);
        }
        assert_eq!(provider.claims.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn api_delivery_scheduler_ignores_mutable_promise_constructor_and_species() {
    for mode in ["constructor", "species"] {
        let (mut engine, provider, module) = fixture(true);
        let id = start(&mut engine, module, "call", "");
        assert_eq!(
            call(
                &mut engine,
                module,
                "queueWithPoisonedScheduler",
                vec![json!(id), json!("success"), json!(mode)]
            ),
            true
        );
        assert_eq!(provider.claims.load(Ordering::SeqCst), 0);
        engine.drain_microtasks().unwrap();
        let state = call(&mut engine, module, "read", vec![]);
        assert_eq!(
            state["log"],
            json!(["call.success", "call.complete", "call.resolve"])
        );
        assert_eq!(state["values"][0], json!({"requestId":id,"bytes":[7,11]}));
        assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn api_delivery_hostile_callback_reporting_never_skips_terminal_settlement() {
    for mode in ["poison-push", "freeze-errors"] {
        for (ticket, expected_log, expected_value) in [
            ("success", "success;complete;resolve;", None),
            ("false-failure", "fail;complete;reject;", Some(json!(false))),
            ("null-failure", "fail;complete;reject;", Some(Value::Null)),
        ] {
            let (mut engine, provider, module) = fixture(true);
            let id = call(&mut engine, module, "startHostile", vec![json!(mode)])
                .as_u64()
                .unwrap();
            assert!(queue(&mut engine, id, ticket));
            engine.drain_microtasks().unwrap();
            call(&mut engine, module, "restoreHostile", vec![]);
            let state = call(&mut engine, module, "readHostile", vec![]);
            assert_eq!(state["log"], expected_log, "{mode}/{ticket}");
            if let Some(expected_value) = expected_value {
                assert_eq!(state["value"], expected_value);
            } else {
                assert_eq!(state["value"]["requestId"], id);
            }
            assert_eq!(state["errors"], if mode == "freeze-errors" { 0 } else { 2 });
            assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
            assert!(!queue(&mut engine, id, ticket));
        }
    }
}

#[test]
fn api_delivery_captures_callback_helper_for_terminal_delivery() {
    let (mut engine, provider, module) = fixture(true);
    let id = start(&mut engine, module, "call", "");
    assert!(queue(&mut engine, id, "success"));
    call(&mut engine, module, "replaceHelper", vec![]);
    engine.drain_microtasks().unwrap();
    call(&mut engine, module, "restoreHostile", vec![]);
    let state = call(&mut engine, module, "read", vec![]);
    assert_eq!(
        state["log"],
        json!(["call.success", "call.complete", "call.resolve"])
    );
    assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
}

#[test]
fn api_delivery_native_decode_ignores_guest_intrinsics_and_array_iteration() {
    for mode in [
        "some",
        "forEach",
        "isArray",
        "keys",
        "defineProperty",
        "number",
        "uint8",
        "arrayBuffer",
        "iterator",
        "buffer",
    ] {
        for (name, ticket, expected) in [
            ("wx.getUserProfile", "success", true),
            ("wx.request", "request-bytes", false),
        ] {
            let (mut engine, provider, module) = fixture(true);
            let id = call(
                &mut engine,
                module,
                "start",
                vec![json!("call"), json!(""), json!(name)],
            )
            .as_u64()
            .unwrap();
            assert!(queue(&mut engine, id, ticket));
            call(&mut engine, module, "poisonDecode", vec![json!(mode)]);
            engine.drain_microtasks().unwrap();
            call(&mut engine, module, "restoreDecode", vec![]);
            let state = call(&mut engine, module, "read", vec![]);
            assert_eq!(
                state["log"],
                json!(["call.success", "call.complete", "call.resolve"]),
                "{mode}/{name}"
            );
            assert_eq!(state["values"][0]["bytes"], json!([7, 11]), "{mode}/{name}");
            if expected {
                assert_eq!(state["values"][0]["requestId"], id);
            }
            assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
        }
    }
}

#[test]
fn api_delivery_native_decode_rejects_invalid_bytes_despite_replaced_array_some() {
    for (name, ticket) in [
        ("wx.getUserProfile", "invalid-binary"),
        ("wx.request", "invalid-request-bytes"),
    ] {
        let (mut engine, provider, module) = fixture(true);
        let id = call(
            &mut engine,
            module,
            "start",
            vec![json!("call"), json!(""), json!(name)],
        )
        .as_u64()
        .unwrap();
        assert!(queue(&mut engine, id, ticket));
        call(&mut engine, module, "poisonDecode", vec![json!("some")]);
        engine.drain_microtasks().unwrap();
        call(&mut engine, module, "restoreDecode", vec![]);
        let state = call(&mut engine, module, "read", vec![]);
        assert_eq!(
            state["log"],
            json!(["call.fail", "call.complete", "call.reject"]),
            "{name}"
        );
        assert_eq!(state["values"][0]["code"], "ERR_INVALID_RESPONSE");
        assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
    }
}

#[test]
fn api_delivery_http_body_keeps_result_budget_above_native_chunk_limit() {
    let (mut engine, provider, module) = fixture(true);
    let id = call(&mut engine, module, "startLargeRequest", vec![])
        .as_u64()
        .unwrap();
    assert!(queue(&mut engine, id, "large-request-bytes"));
    engine.drain_microtasks().unwrap();
    assert_eq!(
        call(&mut engine, module, "readLargeRequest", vec![]),
        json!({"length":1_048_577,"first":7,"last":7})
    );
    assert_eq!(provider.claims.load(Ordering::SeqCst), 1);
}
