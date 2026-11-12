//! Real native producers and the Session bridge diagnostic consumer.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const SOURCE: &str = r#"
const logger=wx.getLogManager();
App({onLaunch:function(){},onShow:function(){}});
exports.log=function(){logger.log('x'.repeat(100000),...Array.from({length:24},function(_,i){return i}));return {ok:true}};
exports.levelOne=function(){wx.getLogManager({level:1});return true};
exports.noop=function(){return true};
exports.flood=function(){for(let i=0;i<3;i++)logger.log('\\'.repeat(49000),i);return true};
exports.sabotage=function(){logger.warn('before public JSON failure');Object.prototype.toJSON=function(){throw Error('public JSON')};return {}};
exports.restore=function(){delete Object.prototype.toJSON;return true};
exports.admission=function(){let saved="",factory="";try{logger.log("late")}catch(e){saved=e.code}try{wx.getLogManager()}catch(e){factory=e.code}return [saved,factory]};
"#;
fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn records(batch: &BridgeBatch) -> Vec<Value> {
    batch
        .messages
        .iter()
        .filter(|m| m.op == op::EVENT_BATCH)
        .flat_map(|m| m.payload["effects"].as_array().into_iter().flatten())
        .flat_map(|e| e["console"]["entries"].as_array().into_iter().flatten())
        .filter_map(|e| serde_json::from_str::<Value>(e["message"].as_str()?).ok())
        .filter(|v| v["source"] == "logManager")
        .collect()
}
struct Fixture {
    session: Session,
    sequence: u64,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "log-manager-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        for name in [
            "wx.getLogManager",
            "object:LogManager.debug",
            "object:LogManager.info",
            "object:LogManager.log",
            "object:LogManager.warn",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: "log-manager".into(),
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        let initialized = fixture.raw(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
        );
        assert_eq!(
            initialized.messages[0].payload["ok"], true,
            "{initialized:?}"
        );
        for name in [
            "wx.getLogManager",
            "object:LogManager.debug",
            "object:LogManager.info",
            "object:LogManager.log",
            "object:LogManager.warn",
        ] {
            assert_eq!(
                initialized.messages[0].payload["capabilities"][name],
                "partial"
            );
        }
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "log-manager",
            format!("log-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call(&mut self, export: &str) -> BridgeBatch {
        self.raw(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":[]}),
        )
    }
}
#[test]
fn session_log_only_turn_delivers_full_native_record_with_partial_ceiling() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let batch = fixture.call("log");
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        let logs = records(&batch);
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0]["arguments"]["roots"].as_array().unwrap().len(), 25);
        assert_eq!(
            logs[0]["arguments"]["nodes"][0]["value"]
                .as_str()
                .unwrap()
                .len(),
            100000
        );
        assert!(serde_json::to_vec(&batch).unwrap().len() < 512 * 1024);
        assert!(records(&fixture.call("noop")).is_empty());
    }
}
#[test]
fn session_default_auto_lifecycle_and_level_one_use_real_native_producers() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let launch = fixture.raw(op::APP_LIFECYCLE, json!({"event":"launch"}));
        assert!(
            records(&launch)
                .iter()
                .any(|v| v["kind"] == "lifecycle" && v["name"] == "App.onShow"),
            "{launch:?}"
        );
        fixture.call("levelOne");
        assert!(records(&fixture.raw(op::APP_LIFECYCLE, json!({"event":"show"}))).is_empty());
    }
}
#[test]
fn session_byte_bound_retains_tail_and_public_json_failure_cannot_erase_native_record() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("levelOne");
        for (index, export) in ["flood", "noop", "noop"].into_iter().enumerate() {
            let batch = fixture.call(export);
            let logs = records(&batch);
            assert_eq!(logs.len(), 1, "{engine:?}/{index}");
            assert_eq!(logs[0]["arguments"]["nodes"][1]["value"], index);
            assert!(serde_json::to_vec(&batch).unwrap().len() < 512 * 1024);
        }
        let failure = fixture.call("sabotage");
        let logs = records(&failure);
        assert_eq!(logs.len(), 1, "{failure:?}");
        assert_eq!(
            logs[0]["arguments"]["nodes"][0]["value"],
            "before public JSON failure"
        );
        fixture.call("restore");
        assert!(records(&fixture.call("noop")).is_empty());
    }
}

#[test]
fn session_terminal_revoke_and_cancel_discard_queued_tail_and_never_revive_admission() {
    for engine in engines() {
        for cancel in [false, true] {
            let mut fixture = Fixture::new(engine);
            fixture.call("levelOne");
            // The escaped-wire drain consumes one record, leaving two queued.
            assert_eq!(records(&fixture.call("flood")).len(), 1);
            if cancel {
                assert!(records(&fixture.session.cancel_host_calls().unwrap()).is_empty());
            } else {
                fixture.session.revoke_host_services();
            }
            for _ in 0..2 {
                // Each real MODULE_CALL refreshes the trusted manifest policy.
                let batch = fixture.call("admission");
                assert!(records(&batch).is_empty(), "{engine:?}/{cancel}: {batch:?}");
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                assert_eq!(
                    batch.messages[0].payload["result"],
                    json!(["ERR_UNSUPPORTED_CAPABILITY", "ERR_UNSUPPORTED_CAPABILITY"]),
                    "{batch:?}"
                );
                assert!(records(&fixture.call("noop")).is_empty());
            }
        }
    }
}
