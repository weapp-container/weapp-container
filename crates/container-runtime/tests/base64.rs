//! Finite real-engine negotiation coverage; installed SDK acceptance is separate.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, CompilerInfo, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig, StrictHostProvider};
use serde_json::{json, Value};

const SOURCE: &str = r#"
  App({});
  exports.inspect = function() {
    const encoded = wx.arrayBufferToBase64(new Uint8Array([0, 128, 255]).buffer);
    return {encoded:encoded, decoded:Array.from(new Uint8Array(wx.base64ToArrayBuffer(encoded))),
      canEncode:wx.canIUse('arrayBufferToBase64'), canDecode:wx.canIUse('base64ToArrayBuffer')};
  };
  exports.denied = function() {
    try { wx.arrayBufferToBase64(new ArrayBuffer(0)); return 'unexpected'; }
    catch (error) { return {code:error.code, supported:wx.canIUse('arrayBufferToBase64')}; }
  };
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn fixture(engine: EngineKind, denied: bool) -> Session {
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "runtime-binary-conversion-gate".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        },
        modules: vec![Module {
            id: "module:app.js".into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: vec![],
        }],
        ..Default::default()
    };
    for name in [
        "wx.canIUse",
        "wx.arrayBufferToBase64",
        "wx.base64ToArrayBuffer",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        ..Default::default()
    };
    if denied {
        config.capabilities.insert(
            "wx.arrayBufferToBase64".into(),
            CapabilitySupport::Unsupported,
        );
    }
    let mut session = Session::new(manifest, config).unwrap();
    session.set_provider(Box::<StrictHostProvider>::default());
    let initialized = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "init",
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
    ));
    assert_eq!(
        initialized.messages[0].payload["ok"], true,
        "{initialized:?}"
    );
    session
}

fn call(session: &mut Session, export: &str) -> Value {
    let result = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "call",
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    ));
    assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
    if export != "denied" {
        assert!(
            !result
                .messages
                .iter()
                .any(|message| message.op == op::ERROR),
            "{result:?}"
        );
    } else {
        for message in result
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
        {
            for error in message.payload["errors"].as_array().unwrap() {
                assert_eq!(error["code"], "ERR_UNSUPPORTED_CAPABILITY");
                assert_eq!(error["api"], "wx.arrayBufferToBase64");
            }
        }
    }
    result.messages[0].payload["result"][0].clone()
}

#[test]
fn binary_conversion_survives_real_session_negotiation_without_host_services() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        assert_eq!(
            call(&mut session, "inspect"),
            json!({"encoded":"AID/","decoded":[0,128,255],"canEncode":true,"canDecode":true})
        );
        for api in ["wx.arrayBufferToBase64", "wx.base64ToArrayBuffer"] {
            let result = session.dispatch(BridgeEnvelope::request(
                "session-1",
                "capability",
                op::API_CALL,
                json!({"name":"wx.canIUse","capability":api}),
            ));
            assert_eq!(result.messages[0].payload["result"], true, "{result:?}");
            assert_eq!(result.messages[0].payload["support"], "full", "{result:?}");
        }
    }
}

#[test]
fn host_policy_can_disable_the_local_conversion_facade() {
    for engine in engines() {
        let mut session = fixture(engine, true);
        assert_eq!(
            call(&mut session, "denied"),
            json!({"code":"ERR_UNSUPPORTED_CAPABILITY","supported":false})
        );
    }
}
