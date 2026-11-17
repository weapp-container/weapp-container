#![cfg(all(feature = "v8-native", feature = "conformance-observation"))]
use container_core::{
    CallTarget, ConformanceExceptionObservation as Observation,
    ConformanceExceptionRequest as Request, JsEngine, ModuleId,
};
use container_engine_v8::V8Engine as Engine;
use serde_json::{json, Value};
const FIXTURE: &[u8] = br#"
const report = __container_report_error;
exports.fail = function(message) { throw Error(message); };
exports.report = function(message) { report(Error(message)); return null; };
exports.many = function(count) { for(let at=0;at<count;at++)report(Error('message '+at));return null; };
exports.unhandled = function(handled) { const p=Promise.reject(Error('actual unhandled'));if(handled)p.catch(()=>{});return null; };
exports.tamper = function(){__container_errors=[];Object.freeze(__container_errors);__container_report_error=function(){};return null;};
exports.intrinsics = function(){Object.prototype.toJSON=function(){throw Error('guest toJSON')};Array.prototype.toJSON=function(){throw Error('guest array toJSON')};JSON.stringify=function(){throw Error('guest stringify')};Reflect.apply=function(){throw Error('guest apply')};Object.getOwnPropertyDescriptor=function(){throw Error('guest descriptor')};return null;};
exports.listenerFailure = function(){wx.onError(()=>{throw Error('actual listener error')});report(Error('outer error'));return null;};
exports.reentrantReport = function(){wx.onError(()=>report(Error('nested report')));report(Error('outer error'));return null;};
exports.public = function(){return typeof globalThis.__container_conformance_exceptions;};
"#;
fn fixture() -> (Engine, ModuleId) {
    let mut engine = Engine::default();
    let module = JsEngine::load_module(&mut engine, FIXTURE).unwrap();
    (engine, module)
}
fn call(
    engine: &mut Engine,
    module: ModuleId,
    name: &str,
    args: Vec<Value>,
) -> Result<Vec<Value>, container_core::EngineError> {
    JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: name.into(),
        },
        args,
    )
}
fn begin(engine: &mut Engine) -> (String, u64) {
    match engine
        .observe_conformance_exceptions(&Request::Begin {
            max_events: 256,
            max_message_bytes: 65536,
        })
        .unwrap()
    {
        Observation::Begun {
            token,
            start_cursor,
        } => (token, start_cursor),
        other => panic!("{other:?}"),
    }
}
fn end(engine: &mut Engine, binding: (String, u64)) -> Observation {
    engine
        .observe_conformance_exceptions(&Request::End {
            token: binding.0,
            start_cursor: binding.1,
        })
        .unwrap()
}
#[test]
fn actual_empty_interval_and_irreversible_terminal() {
    let (mut engine, module) = fixture();
    assert_eq!(
        call(&mut engine, module, "public", vec![]).unwrap(),
        vec![json!("undefined")]
    );
    call(
        &mut engine,
        module,
        "report",
        vec![json!("before source subscription")],
    )
    .unwrap();
    let binding = begin(&mut engine);
    assert!(engine
        .observe_conformance_exceptions(&Request::Begin {
            max_events: 256,
            max_message_bytes: 65536
        })
        .is_err());
    assert!(engine
        .observe_conformance_exceptions(&Request::End {
            token: "other".into(),
            start_cursor: binding.1
        })
        .is_err());
    assert!(
        matches!(end(&mut engine,binding.clone()),Observation::Ended{complete:true,overflow:false,start_cursor:0,end_cursor:0,ref events,..}if events.is_empty())
    );
    assert!(engine
        .observe_conformance_exceptions(&Request::End {
            token: binding.0,
            start_cursor: binding.1
        })
        .is_err());
    assert!(engine
        .observe_conformance_exceptions(&Request::Begin {
            max_events: 256,
            max_message_bytes: 65536
        })
        .is_err());
}
#[test]
fn actual_errors_survive_public_queue_replacement_and_freezing() {
    let (mut engine, module) = fixture();
    let binding = begin(&mut engine);
    call(&mut engine, module, "tamper", vec![]).unwrap();
    assert!(call(
        &mut engine,
        module,
        "fail",
        vec![json!("actual synchronous error")]
    )
    .is_err());
    match end(&mut engine, binding) {
        Observation::Ended {
            complete: true,
            overflow: false,
            end_cursor: 1,
            events,
            ..
        } => {
            assert_eq!(events[0].cursor, 0);
            assert_eq!(events[0].message, "actual synchronous error");
        }
        other => panic!("{other:?}"),
    }
}
#[test]
fn actual_unhandled_rejection_is_retained_without_public_subscriber() {
    for handled in [false, true] {
        let (mut engine, module) = fixture();
        let binding = begin(&mut engine);
        call(&mut engine, module, "unhandled", vec![json!(handled)]).unwrap();
        JsEngine::drain_microtasks(&mut engine).unwrap();
        match end(&mut engine, binding) {
            Observation::Ended {
                complete: true,
                overflow: false,
                events,
                ..
            } => {
                assert_eq!(events.len(), if handled { 0 } else { 1 });
                if !handled {
                    assert_eq!(events[0].message, "actual unhandled");
                }
            }
            other => panic!("{other:?}"),
        }
    }
}
#[test]
fn count_and_utf8_overflow_never_certify_an_empty_interval() {
    for message in [None, Some("界".repeat(21846))] {
        let (mut engine, module) = fixture();
        let binding = begin(&mut engine);
        if let Some(message) = message {
            call(&mut engine, module, "report", vec![json!(message)]).unwrap();
        } else {
            call(&mut engine, module, "many", vec![json!(257)]).unwrap();
        }
        match end(&mut engine, binding) {
            Observation::Ended {
                complete: false,
                overflow: true,
                end_cursor,
                events,
                ..
            } => {
                assert_eq!(end_cursor, if events.is_empty() { 1 } else { 257 });
                assert!(events.len() <= 256);
            }
            other => panic!("{other:?}"),
        }
    }
}
#[test]
fn transport_uses_captured_intrinsics_and_no_guest_projection() {
    let (mut engine, module) = fixture();
    let binding = begin(&mut engine);
    call(
        &mut engine,
        module,
        "report",
        vec![json!("before intrinsic sabotage")],
    )
    .unwrap();
    let _ = call(&mut engine, module, "intrinsics", vec![]);
    match end(&mut engine, binding) {
        Observation::Ended {
            complete: true,
            overflow: false,
            events,
            ..
        } => assert_eq!(events[0].message, "before intrinsic sabotage"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn listener_failures_remain_real_events_without_recursive_public_delivery() {
    let (mut engine, module) = fixture();
    let binding = begin(&mut engine);
    call(&mut engine, module, "listenerFailure", vec![]).unwrap();
    match end(&mut engine, binding) {
        Observation::Ended {
            complete: true,
            overflow: false,
            events,
            ..
        } => {
            assert_eq!(
                events
                    .iter()
                    .map(|event| event.message.as_str())
                    .collect::<Vec<_>>(),
                vec!["outer error", "actual listener error"]
            );
        }
        other => panic!("{other:?}"),
    }
}
#[test]
fn suppressed_nested_reports_invalidate_completeness_without_fabricating_a_message() {
    let (mut engine, module) = fixture();
    let binding = begin(&mut engine);
    call(&mut engine, module, "reentrantReport", vec![]).unwrap();
    match end(&mut engine, binding) {
        Observation::Ended {
            complete: false,
            overflow: true,
            events,
            ..
        } => {
            assert_eq!(events.len(), 1);
            assert_eq!(events[0].message, "outer error");
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn private_final_checkpoint_survives_public_retirement_and_handled_cancellation() {
    for handled in [false, true] {
        let (mut engine, module) = fixture();
        let binding = begin(&mut engine);
        engine
            .dispatch_lifecycle_notification("retire", &Value::Null)
            .unwrap();
        call(&mut engine, module, "unhandled", vec![json!(handled)]).unwrap();
        JsEngine::drain_microtasks(&mut engine).unwrap();
        match end(&mut engine, binding) {
            Observation::Ended {
                complete: true,
                overflow: false,
                events,
                ..
            } => {
                assert_eq!(events.len(), if handled { 0 } else { 1 });
                if !handled {
                    assert_eq!(events[0].message, "actual unhandled");
                }
            }
            other => panic!("{other:?}"),
        }
    }
}
