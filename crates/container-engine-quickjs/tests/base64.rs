#![cfg(feature = "quickjs-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_quickjs::QuickJsEngine;

#[test]
fn array_buffer_base64_round_trip_is_synchronous() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const input = new Uint8Array([0, 1, 2, 127, 128, 250, 255]).buffer;
          const encoded = wx.arrayBufferToBase64(input);
          const output = new Uint8Array(wx.base64ToArrayBuffer(encoded));
          let values = [];
          for (let i = 0; i < output.length; i++) values.push(output[i]);
          return {encoded, values, canEncode: wx.canIUse('arrayBufferToBase64'), canDecode: wx.canIUse('base64ToArrayBuffer')};
        };"#,
    )
    .unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(result[0]["encoded"], "AAECf4D6/w==");
    assert_eq!(
        result[0]["values"],
        serde_json::json!([0, 1, 2, 127, 128, 250, 255])
    );
    assert_eq!(result[0]["canEncode"], true);
    assert_eq!(result[0]["canDecode"], true);
}

#[test]
fn base64_rejects_invalid_input_without_bridge_work() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          try { wx.base64ToArrayBuffer('bad!'); return 'unexpected'; }
          catch (error) { return {code:error.code, api:error.api, errMsg:error.errMsg}; }
        };"#,
    )
    .unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(result[0]["code"], "ERR_INVALID_REQUEST");
    assert_eq!(result[0]["api"], "wx.base64ToArrayBuffer");
    assert_eq!(
        result[0]["errMsg"],
        "wx.base64ToArrayBuffer:fail base64 is invalid"
    );
    let events = engine.drain_host_events().unwrap();
    assert!(!events
        .iter()
        .filter_map(|item| item["events"].as_array())
        .flatten()
        .any(|event| event["type"] == "api.call" || event["type"] == "api.sync"));
}

#[test]
fn base64_handles_padding_all_bytes_and_capability_revocation() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const bytes = new Uint8Array(256);
          for (let i = 0; i < bytes.length; i++) bytes[i] = i;
          const roundTrip = new Uint8Array(wx.base64ToArrayBuffer(wx.arrayBufferToBase64(bytes.buffer)));
          let same = bytes.length === roundTrip.length;
          for (let i = 0; i < bytes.length; i++) same = same && bytes[i] === roundTrip[i];
          let rejected = 0;
          for (const value of ['A', 'A=', '=AAA', 'AAAA=', 'AA=A', 'AA===', 7, null]) {
            try { wx.base64ToArrayBuffer(value); } catch (error) { if (error.code === 'ERR_INVALID_REQUEST') rejected++; }
          }
          for (const value of ['text', [1], new Uint8Array([1]), null]) {
            try { wx.arrayBufferToBase64(value); } catch (error) { if (error.code === 'ERR_INVALID_REQUEST') rejected++; }
          }
          return {same, rejected, empty:wx.arrayBufferToBase64(new ArrayBuffer(0)),
            emptyDecoded:wx.base64ToArrayBuffer('').byteLength,
            one:new Uint8Array(wx.base64ToArrayBuffer('/w=='))[0],
            unpadded:new Uint8Array(wx.base64ToArrayBuffer('/w'))[0]};
        }; exports.denied = function() {
          try { wx.arrayBufferToBase64(new ArrayBuffer(0)); return 'unexpected'; }
          catch (error) { return {code:error.code, supported:wx.canIUse('arrayBufferToBase64')}; }
        };"#,
    )
    .unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(
        result[0],
        serde_json::json!({"same":true,"rejected":12,"empty":"","emptyDecoded":0,"one":255,"unpadded":255})
    );
    engine.set_capabilities(&Default::default()).unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "denied".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(
        result[0],
        serde_json::json!({"code":"ERR_UNSUPPORTED_CAPABILITY","supported":false})
    );
}

#[test]
fn base64_helpers_are_private_and_ignore_spoofed_global_aliases() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const names = ['__container_base64_error', '__container_base64_decode',
            '__container_array_buffer_to_base64', '__container_base64_to_array_buffer'];
          const hidden = names.every(name => !(name in globalThis));
          for (const name of names) globalThis[name] = function() { throw 'spoofed global helper'; };
          const encoded = wx.arrayBufferToBase64(new Uint8Array([0, 128, 255]).buffer);
          const decoded = Array.from(new Uint8Array(wx.base64ToArrayBuffer(encoded)));
          let invalid;
          try { wx.base64ToArrayBuffer('bad!'); }
          catch (error) { invalid = {code:error.code, api:error.api}; }
          let invalidBuffer;
          try { wx.arrayBufferToBase64(new Uint8Array([1])); }
          catch (error) { invalidBuffer = {code:error.code, api:error.api}; }
          return {hidden, encoded, decoded, invalid, invalidBuffer};
        };"#,
    )
    .unwrap();
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        vec![],
    )
    .unwrap();
    assert_eq!(
        result[0],
        serde_json::json!({"hidden":true,"encoded":"AID/","decoded":[0,128,255],
            "invalid":{"code":"ERR_INVALID_REQUEST","api":"wx.base64ToArrayBuffer"},
            "invalidBuffer":{"code":"ERR_INVALID_REQUEST","api":"wx.arrayBufferToBase64"}})
    );
}
