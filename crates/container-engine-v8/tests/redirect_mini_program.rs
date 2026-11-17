#![cfg(feature = "v8-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_v8::V8Engine;
use serde_json::json;

#[test]
fn redirect_to_mini_program_uses_one_batched_provider_call() {
    let mut engine = V8Engine::default();
    engine
        .set_capabilities(
            &[("wx.redirectToMiniProgram".to_owned(), "partial".to_owned())]
                .into_iter()
                .collect(),
        )
        .expect("redirect capability installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          wx.redirectToMiniProgram({
            appId: 'wx-target',
            path: 'pages/home/index?from=weapp-container',
            extraData: { source: 'fixture' },
            envVersion: 'trial',
            success(value) { globalThis.__success = value; },
            complete(value) { globalThis.__complete = value.errMsg; }
          });
          return { canUse: wx.canIUse('redirectToMiniProgram'), type: typeof wx.redirectToMiniProgram };
        };
        exports.status = function() {
          return { success: globalThis.__success || null, complete: globalThis.__complete || null };
        };"#,
    )
    .expect("redirect facade evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("redirect facade calls");
    assert_eq!(result[0]["canUse"], true);
    assert_eq!(result[0]["type"], "function");

    let events = engine.drain_host_events().expect("redirect event drains");
    let event = &events[0]["events"][0];
    assert_eq!(event["name"], "wx.redirectToMiniProgram");
    assert_eq!(event["options"]["appId"], "wx-target");
    assert_eq!(event["options"]["envVersion"], "trial");
    let request_id = event["id"].as_u64().expect("request id");
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_resolve_api".into(),
        },
        vec![
            request_id.into(),
            json!({"errMsg": "redirectToMiniProgram:ok"}),
            serde_json::Value::Null,
        ],
    )
    .expect("redirect callback resolves");
    JsEngine::drain_microtasks(&mut engine).expect("redirect callback drains");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("redirect status reads");
    assert_eq!(status[0]["success"]["errMsg"], "redirectToMiniProgram:ok");
    assert_eq!(status[0]["complete"], "redirectToMiniProgram:ok");
}
