#![cfg(feature = "quickjs-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_quickjs::QuickJsEngine;
use serde_json::json;

#[test]
fn storage_sync_missing_key_matches_wechat_contract() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const missing = wx.getStorageSync('missing');
          wx.setStorageSync('undefined-value', undefined);
          const explicitUndefined = wx.getStorageSync('undefined-value');
          return {
            missing,
            missingType: typeof missing,
            explicitUndefinedType: typeof explicitUndefined,
            explicitUndefined: explicitUndefined === undefined
          };
        };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("storage facade evaluates");
    assert_eq!(result[0]["missing"], "");
    assert_eq!(result[0]["missingType"], "string");
    assert_eq!(result[0]["explicitUndefinedType"], "undefined");
    assert_eq!(result[0]["explicitUndefined"], true);
}

#[test]
fn storage_async_missing_key_has_structured_failure_and_promise_rejection() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          wx.getStorage({
            key: 'missing',
            fail(error) { globalThis.__storageFail = error; },
            complete(error) { globalThis.__storageComplete = error; }
          }).catch(function(error) { globalThis.__storageReject = error; });
          wx.getStorage({}).catch(function(error) { globalThis.__storageInvalid = error; });
          return true;
        };
        exports.status = function() { return {
          fail: globalThis.__storageFail || null,
          complete: globalThis.__storageComplete || null,
          reject: globalThis.__storageReject || null,
          invalid: globalThis.__storageInvalid || null
        }; };"#,
    )
    .expect("storage async fixture evaluates");
    JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("storage async fixture calls");
    JsEngine::drain_microtasks(&mut engine).expect("storage callbacks drain");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("storage status reads");
    assert_eq!(
        status[0]["fail"]["errMsg"],
        "wx.getStorage:fail data not found"
    );
    assert_eq!(status[0]["fail"]["code"], "ERR_INVALID_REQUEST");
    assert_eq!(status[0]["fail"]["api"], "wx.getStorage");
    assert_eq!(status[0]["complete"], status[0]["fail"]);
    assert_eq!(status[0]["reject"], status[0]["fail"]);
    assert_eq!(
        status[0]["invalid"]["errMsg"],
        "wx.getStorage:fail key must be a non-empty string"
    );
    assert_eq!(status[0]["invalid"]["code"], "ERR_INVALID_REQUEST");
    assert_eq!(status[0]["invalid"]["api"], "wx.getStorage");
}

#[test]
fn save_file_global_and_manager_share_bridge_and_callback_contract() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[("wx.getFileSystemManager".into(), "partial".into())]
                .into_iter()
                .collect(),
        )
        .expect("capability map installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const manager = wx.getFileSystemManager();
          wx.saveFile({ tempFilePath: '/tmp/source.txt', filePath: '/saved/global.txt', success(value) {
            globalThis.__global_saved = value.savedFilePath;
          }, complete() { globalThis.__global_complete = true; } });
          manager.saveFile({ tempFilePath: '/tmp/source.txt', filePath: '/saved/manager.txt', success(value) {
            globalThis.__manager_saved = value.savedFilePath;
          }, complete() { globalThis.__manager_complete = true; } });
          return { hasGlobal: typeof wx.saveFile === 'function', hasManager: typeof manager.saveFile === 'function' };
        };
        exports.status = function() { return {
          global: globalThis.__global_saved,
          globalComplete: !!globalThis.__global_complete,
          manager: globalThis.__manager_saved,
          managerComplete: !!globalThis.__manager_complete
        }; };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("saveFile facade evaluates");
    assert_eq!(result[0]["hasGlobal"], true);
    assert_eq!(result[0]["hasManager"], true);
    let events = engine.drain_host_events().expect("saveFile calls drain");
    let calls = events[0]["events"].as_array().expect("batched calls");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0]["name"], "wx.saveFile");
    assert_eq!(calls[1]["name"], "wx.saveFile");
    for (index, call) in calls.iter().enumerate() {
        let request_id = call["id"].as_u64().expect("request id");
        let path = if index == 0 {
            "/saved/global.txt"
        } else {
            "/saved/manager.txt"
        };
        JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request_id.into(),
                json!({"errMsg":"saveFile:ok", "savedFilePath": path}),
                serde_json::Value::Null,
            ],
        )
        .expect("saveFile callback resolves");
    }
    JsEngine::drain_microtasks(&mut engine).expect("saveFile callbacks drain");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("saveFile callback status reads");
    assert_eq!(status[0]["global"], "/saved/global.txt");
    assert_eq!(status[0]["globalComplete"], true);
    assert_eq!(status[0]["manager"], "/saved/manager.txt");
    assert_eq!(status[0]["managerComplete"], true);
}

#[test]
fn save_file_missing_capability_rejects_and_runs_fail_complete() {
    let mut engine = QuickJsEngine::default();
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const manager = wx.getFileSystemManager();
          manager.saveFile({ tempFilePath: '/tmp/source.txt', fail(value) {
            globalThis.__error = value.code + ':' + value.errMsg;
          }, complete() { globalThis.__complete = true; } });
          return { canUse: wx.canIUse('wx.saveFile'), hasManager: typeof manager.saveFile === 'function' };
        };
        exports.status = function() { return { error: globalThis.__error, complete: !!globalThis.__complete }; };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("unsupported saveFile facade evaluates");
    assert_eq!(result[0]["canUse"], false);
    assert_eq!(result[0]["hasManager"], true);
    JsEngine::drain_microtasks(&mut engine).expect("unsupported callbacks drain");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("unsupported callback status reads");
    assert!(status[0]["error"]
        .as_str()
        .unwrap()
        .starts_with("ERR_UNSUPPORTED_CAPABILITY:"));
    assert_eq!(status[0]["complete"], true);
}

#[test]
fn synchronous_filesystem_manager_uses_permission_scoped_snapshot() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[("wx.getFileSystemManager".into(), "partial".into())]
                .into_iter()
                .collect(),
        )
        .expect("capability map installs");
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_set_sync_files".into(),
        },
        vec![json!({
            "hello.txt": {"bytes": [104, 101, 108, 108, 111], "text": "hello", "base64": "aGVsbG8="}
        })],
    )
    .expect("sync file snapshot installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const manager = wx.getFileSystemManager();
          const text = manager.readFileSync('/hello.txt', 'utf8');
          const binary = manager.readFileSync('/hello.txt');
          manager.writeFileSync('/written.txt', 'world', 'utf8');
          const written = manager.readFileSync('/written.txt', 'base64');
          manager.writeFileSync('/binary.bin', new Uint8Array([0, 255, 1]).buffer);
          const binaryWritten = manager.readFileSync('/binary.bin', 'base64');
          manager.accessSync('/written.txt');
          manager.unlinkSync('/written.txt');
          let missing = null;
          try { manager.accessSync('/written.txt'); } catch (error) { missing = error.code; }
          return { text, byteLength: binary.byteLength, written, binaryWritten, missing };
        };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("sync filesystem calls evaluate");
    assert_eq!(result[0]["text"], "hello");
    assert_eq!(result[0]["byteLength"], 5);
    assert_eq!(result[0]["written"], "d29ybGQ=");
    assert_eq!(result[0]["binaryWritten"], "AP8B");
    assert_eq!(result[0]["missing"], "ERR_INVALID_REQUEST");
    let events = engine.drain_host_events().expect("sync calls drain");
    let calls = events[0]["events"].as_array().expect("batched calls");
    assert_eq!(calls[0]["type"], "api.sync");
    assert_eq!(calls[0]["name"], "wx.fs.writeFileSync");
    assert_eq!(calls[1]["name"], "wx.fs.writeFileSync");
    assert_eq!(calls[1]["options"]["encoding"], "base64");
    assert_eq!(calls[2]["name"], "wx.fs.unlinkSync");
}

#[test]
fn permission_facade_uses_typed_provider_bridge_call() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[
                ("wx.authorize".into(), "partial".into()),
                ("wx.openSetting".into(), "partial".into()),
            ]
            .into_iter()
            .collect(),
        )
        .expect("capability map installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          wx.authorize({ scope: 'scope.userLocation', success(value) { globalThis.__authorized = value.errMsg; } });
          wx.openSetting({ success(value) { globalThis.__settings = value.authSetting['scope.userLocation']; } });
          return { canAuthorize: wx.canIUse('wx.authorize'), canOpenSetting: wx.canIUse('wx.openSetting') };
        }; exports.status = function() { return { authorized: globalThis.__authorized, location: globalThis.__settings }; };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("permission facade evaluates");
    assert_eq!(result[0]["canAuthorize"], true);
    assert_eq!(result[0]["canOpenSetting"], true);
    let events = engine.drain_host_events().expect("permission calls drain");
    let calls = events[0]["events"].as_array().expect("batched calls");
    assert_eq!(calls[0]["name"], "wx.authorize");
    assert_eq!(calls[1]["name"], "wx.openSetting");
}

#[test]
fn auth_session_facade_preserves_async_callbacks_and_capability_state() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[
                ("wx.login".into(), "partial".into()),
                ("wx.checkSession".into(), "partial".into()),
            ]
            .into_iter()
            .collect(),
        )
        .expect("capability map installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          wx.checkSession({ fail(value) {
            globalThis.__check_error = value.code + ':' + value.errMsg;
          }, complete() { globalThis.__check_complete = true; } }).catch(function() {});
          wx.login({ success(value) {
            globalThis.__login_code = value.code;
          }, complete() { globalThis.__login_complete = true; } });
          return { canLogin: wx.canIUse('wx.login'), canCheck: wx.canIUse('wx.checkSession') };
        };
        exports.status = function() { return {
          checkError: globalThis.__check_error,
          checkComplete: !!globalThis.__check_complete,
          loginCode: globalThis.__login_code,
          loginComplete: !!globalThis.__login_complete
        }; };"#,
    )
    .expect("module evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("auth facade evaluates");
    assert_eq!(result[0]["canLogin"], true);
    assert_eq!(result[0]["canCheck"], true);

    let events = engine.drain_host_events().expect("auth calls drain");
    let calls = events[0]["events"].as_array().expect("batched calls");
    assert_eq!(calls.len(), 2);
    for call in calls {
        let request_id = call["id"].as_u64().expect("request id");
        let (value, error) = match call["name"].as_str() {
            Some("wx.checkSession") => (
                serde_json::Value::Null,
                json!({"code": "ERR_INVALID_REQUEST", "errMsg": "checkSession:fail session expired"}),
            ),
            Some("wx.login") => (
                json!({"code": "fixture-login-code", "errMsg": "login:ok"}),
                serde_json::Value::Null,
            ),
            name => panic!("unexpected auth API {name:?}"),
        };
        JsEngine::call(
            &mut engine,
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![request_id.into(), value, error],
        )
        .expect("auth callback resolves");
    }
    JsEngine::drain_microtasks(&mut engine).expect("auth callbacks drain");
    let status = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "status".into(),
        },
        Vec::new(),
    )
    .expect("auth callback status reads");
    assert_eq!(
        status[0]["checkError"],
        "ERR_INVALID_REQUEST:checkSession:fail session expired"
    );
    assert_eq!(status[0]["checkComplete"], true);
    assert_eq!(status[0]["loginCode"], "fixture-login-code");
    assert_eq!(status[0]["loginComplete"], true);
}
