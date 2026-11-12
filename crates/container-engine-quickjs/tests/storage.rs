#![cfg(feature = "quickjs-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_quickjs::QuickJsEngine;
use serde_json::{json, Value};

#[test]
fn storage_capability_gate_matches_caniuse_and_prevents_mutation() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[("wx.getStorageSync".into(), "full".into())]
                .into_iter()
                .collect(),
        )
        .unwrap();
    let source = br#"exports.run = function() {
      let syncError;
      try { wx.setStorageSync('denied', 1); } catch (error) { syncError = error; }
      wx.setStorage({key:'denied', data:2, fail(error) { globalThis.__fail = error; },
        complete(error) { globalThis.__complete = error; }}).catch(error => { globalThis.__reject = error; });
      return { canSet: wx.canIUse('setStorage'), syncError, value: wx.getStorageSync('denied') };
    }; exports.status = function() { return { fail:globalThis.__fail, complete:globalThis.__complete, reject:globalThis.__reject }; };"#;
    let module = JsEngine::load_module(&mut engine, source).unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(result[0]["canSet"], false);
    assert_eq!(result[0]["value"], "");
    assert_eq!(result[0]["syncError"]["code"], "ERR_UNSUPPORTED_CAPABILITY");
    JsEngine::drain_microtasks(&mut engine).unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(result[0]["fail"]["code"], "ERR_UNSUPPORTED_CAPABILITY");
    assert_eq!(result[0]["fail"], result[0]["complete"]);
    assert_eq!(result[0]["fail"], result[0]["reject"]);
    let events = engine.drain_host_events().unwrap();
    assert!(!events
        .iter()
        .filter_map(|item| item["events"].as_array())
        .flatten()
        .any(|event| event["type"] == "storage.patch.batch"));
}

#[test]
fn storage_undefined_resolves_async_and_snapshot_keeps_null_distinct() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(&mut engine, br#"exports.run = function() {
      wx.setStorageSync('undefined', undefined);
      wx.setStorageSync('null', null);
      wx.getStorage({key:'undefined', success(value) { globalThis.__success = value.data === undefined; }}).then(value => { globalThis.__resolved = value.data === undefined; });
      return true;
    }; exports.status = function() { return { success:globalThis.__success, resolved:globalThis.__resolved,
      undefinedValue:wx.getStorageSync('undefined') === undefined, nullValue:wx.getStorageSync('null') === null }; };"#).unwrap();
    JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    JsEngine::drain_microtasks(&mut engine).unwrap();
    let events = engine.drain_host_events().unwrap();
    let patches = events
        .iter()
        .filter_map(|item| item["events"].as_array())
        .flatten()
        .filter(|event| event["type"] == "storage.patch.batch")
        .flat_map(|event| event["patches"].as_array().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(patches.len(), 2);
    assert_eq!(patches[0]["undefined"], true);
    assert_eq!(patches[1]["undefined"], false);
    assert_eq!(patches[1]["value"], Value::Null);
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_set_storage_snapshot".into(),
        },
        vec![json!({"values":{"undefined":null,"null":null},"undefinedKeys":["undefined"]})],
    )
    .unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(
        result[0],
        json!({"success":true,"resolved":true,"undefinedValue":true,"nullValue":true})
    );
}
