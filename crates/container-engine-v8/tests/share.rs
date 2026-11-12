#![cfg(feature = "v8-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_v8::V8Engine;
use serde_json::json;

#[test]
fn share_facade_keeps_one_batched_request_and_documented_result() {
    let mut engine = V8Engine::default();
    engine
        .set_capabilities(
            &[
                ("wx.shareAppMessage".to_owned(), "partial".to_owned()),
                ("wx.shareTimeline".to_owned(), "partial".to_owned()),
            ]
            .into_iter()
            .collect(),
        )
        .expect("share capabilities install");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          wx.shareAppMessage({
            title: 'Fixture',
            path: '/pages/home/index?from=share',
            extraData: { source: 'v8' },
            success(value) { globalThis.__shareResult = value; },
            complete(value) { globalThis.__shareComplete = value.errMsg; }
          });
          return {
            canUse: wx.canIUse('shareAppMessage'),
            type: typeof wx.shareAppMessage
          };
        };
        exports.status = function() {
          return { result: globalThis.__shareResult || null, complete: globalThis.__shareComplete || null };
        };"#,
    )
    .expect("share facade evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("share facade calls");
    assert_eq!(result[0]["canUse"], true);
    assert_eq!(result[0]["type"], "function");

    let events = engine.drain_host_events().expect("share event drains");
    let event = &events[0]["events"][0];
    assert_eq!(event["name"], "wx.shareAppMessage");
    assert_eq!(event["options"]["path"], "/pages/home/index?from=share");
    let request_id = event["id"].as_u64().expect("share request id");
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_resolve_api".into(),
        },
        vec![
            request_id.into(),
            json!({"errMsg": "wx.shareAppMessage:ok"}),
            serde_json::Value::Null,
        ],
    )
    .expect("share callback resolves");
    JsEngine::drain_microtasks(&mut engine).expect("share callback drains");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("share status reads");
    assert_eq!(status[0]["result"]["errMsg"], "wx.shareAppMessage:ok");
    assert_eq!(status[0]["complete"], "wx.shareAppMessage:ok");
}

#[test]
fn share_facade_rejects_non_object_options_without_a_bridge_request() {
    let mut engine = V8Engine::default();
    engine
        .set_capabilities(
            &[("wx.shareTimeline".to_owned(), "partial".to_owned())]
                .into_iter()
                .collect(),
        )
        .expect("share capability installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          return wx.shareTimeline(null).catch(function(error) {
            return { code: error.code, api: error.api, errMsg: error.errMsg };
          });
        };"#,
    )
    .expect("share invalid fixture evaluates");
    JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("share invalid fixture calls");
    JsEngine::drain_microtasks(&mut engine).expect("invalid callback drains");
    let events = engine.drain_host_events().expect("invalid events drain");
    assert!(events[0]["events"].as_array().unwrap().is_empty());
    let errors = events[0]["errors"].as_array().expect("invalid error batch");
    assert_eq!(errors[0]["code"], "ERR_INVALID_REQUEST");
    assert_eq!(errors[0]["api"], "wx.shareTimeline");
}
