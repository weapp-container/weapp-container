//! Finite host-turn checkpoint behavior against the real JS providers.
//! A normal synchronous exception still finishes its queued Promise work;
//! this does not claim official runtime parity or bounded V8 execution.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const SESSION_ID: &str = "exception-checkpoint";
const MODULE: &str = "module:app.js";
const STORAGE_KEY: &str = "exception-checkpoint-count";
const ORIGINAL_ERROR: &str = "original synchronous exception";
const SOURCE: &str = r#"
App({});
exports.fail = function() {
  Promise.resolve().then(function() {
    const count = wx.getStorageSync('exception-checkpoint-count') || 0;
    wx.setStorageSync('exception-checkpoint-count', count + 1);
  });
  throw new Error('original synchronous exception');
};
exports.inspect = function() {
  return wx.getStorageSync('exception-checkpoint-count') || 0;
};
"#;

fn request(id: &str, operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request(SESSION_ID, id, operation, payload)
}

fn response<'a>(batch: &'a BridgeBatch, request: &BridgeEnvelope) -> &'a BridgeEnvelope {
    let responses: Vec<_> = batch
        .messages
        .iter()
        .filter(|message| {
            message.kind == EnvelopeKind::Response
                && message.request_id == request.request_id
                && message.op == request.op
        })
        .collect();
    assert_eq!(
        responses.len(),
        1,
        "missing or duplicate response: {batch:?}"
    );
    responses[0]
}

fn storage_writes(batch: &BridgeBatch) -> usize {
    batch
        .messages
        .iter()
        .flat_map(|message| message.payload["effects"].as_array().into_iter().flatten())
        .flat_map(|effect| effect["events"].as_array().into_iter().flatten())
        .filter(|event| event["type"] == "storage.patch.batch")
        .flat_map(|event| event["patches"].as_array().into_iter().flatten())
        .filter(|patch| patch["key"] == STORAGE_KEY && patch["op"] == "set")
        .count()
}

fn original_errors(batch: &BridgeBatch) -> usize {
    batch
        .messages
        .iter()
        .filter(|message| message.op == op::ERROR)
        .flat_map(|message| message.payload["errors"].as_array().into_iter().flatten())
        .filter(|error| error["message"] == ORIGINAL_ERROR)
        .count()
}

fn exception_checkpoint(engine: EngineKind) {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "exception-checkpoint-fixture".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.modules.push(Module {
        id: MODULE.into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: vec![],
    });
    for api in ["wx.getStorageSync", "wx.setStorageSync"] {
        manifest
            .capabilities
            .insert(api.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: SESSION_ID.into(),
            engine,
            ..Default::default()
        },
    )
    .unwrap();
    let init = request(
        "init",
        op::APP_INIT,
        json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
    );
    let initialized = session.dispatch(init.clone());
    assert_eq!(
        response(&initialized, &init).payload["ok"],
        true,
        "{initialized:?}"
    );
    assert!(session.app_service().storage().get(STORAGE_KEY).is_none());

    let failed = request(
        "fail",
        op::MODULE_CALL,
        json!({"moduleId":MODULE,"export":"fail","args":[]}),
    );
    let batch = session.dispatch(failed.clone());
    let failure = response(&batch, &failed);
    assert_eq!(failure.payload["ok"], false, "{batch:?}");
    assert_eq!(failure.payload["error"]["code"], "ERR_ENGINE", "{batch:?}");
    assert_ne!(failure.payload["requiresRestart"], true, "{batch:?}");
    assert_eq!(
        original_errors(&batch),
        1,
        "original exception was lost or replayed: {batch:?}"
    );
    assert_eq!(
        storage_writes(&batch),
        1,
        "Promise effects did not settle in the failing turn: {batch:?}"
    );
    assert_eq!(
        session.app_service().storage().get(STORAGE_KEY),
        Some(&json!(1)),
        "queued Promise write was postponed beyond the failing host turn"
    );
    assert!(session.execution_fault().is_none());

    // Two later JS turns establish both recoverability and one-time delivery.
    // Reading only the eventual store value would also pass the old behavior,
    // which incorrectly ran the pending job during the next request.
    for id in ["inspect-1", "inspect-2"] {
        let inspect = request(
            id,
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"inspect","args":[]}),
        );
        let batch = session.dispatch(inspect.clone());
        let result = response(&batch, &inspect);
        assert_eq!(result.payload["ok"], true, "{batch:?}");
        assert_eq!(result.payload["result"], json!([1]), "{batch:?}");
        assert!(
            batch
                .messages
                .iter()
                .all(|message| message.payload["ok"] != false),
            "{batch:?}"
        );
        assert_eq!(
            storage_writes(&batch),
            0,
            "a later turn replayed the cleanup write: {batch:?}"
        );
        assert_eq!(
            original_errors(&batch),
            0,
            "a later turn replayed the original exception: {batch:?}"
        );
        assert!(session.execution_fault().is_none());
    }
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_ordinary_exception_completes_its_microtask_checkpoint() {
    exception_checkpoint(EngineKind::Quickjs);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_ordinary_exception_completes_its_microtask_checkpoint() {
    exception_checkpoint(EngineKind::V8);
}
