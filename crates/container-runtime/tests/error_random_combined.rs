//! Both public families through real native Session delivery; root executes it.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    HostApiProvider, HostServicesConfig, ProviderContext, ProviderError, Session, SessionConfig,
    TrustedApplication,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

const MODULE: &str = "module:app.js";
const SOURCE: &str = r#"
App({});
let trace=[],notifications=[];
const savedRandom=wx.getRandomValues,savedOn=wx.onError,savedOff=wx.offError;
savedOn(message=>notifications.push(message));
globalThis.__container_report_error=()=>{throw Error('retargeted reporter')};
exports.begin=function(failed){
  trace=[];notifications=[];
  return {value:savedRandom({length:failed?-1:1,
    success(result){trace.push('success:'+result.randomValues.byteLength);throw Error('combined success callback')},
    fail(error){trace.push('fail:'+error.code);throw Error('combined fail callback')},
    complete(){trace.push('complete')}})===undefined};
};
exports.inspect=function(){return {value:{trace:trace,notifications:notifications,
  capabilities:Object.assign({},__container_capabilities),
  identity:weappContainer.identity.getState(),
  core:[wx.getRandomValues===savedRandom,wx.onError===savedOn,wx.offError===savedOff]}};};
exports.canUse=function(name){return {value:wx.canIUse(name)};};
exports.remove=function(){savedOff();return {value:true};};
"#;

struct TrapProvider {
    calls: Arc<AtomicUsize>,
}
impl HostApiProvider for TrapProvider {
    fn name(&self) -> &'static str {
        "combined-provider-trap"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        BTreeMap::from([("wx.getRandomValues".into(), CapabilitySupport::Unsupported)])
    }
    fn call(
        &mut self,
        name: &str,
        _: &Map<String, Value>,
        _: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if name == "wx.getRandomValues" {
            self.calls.fetch_add(1, Ordering::SeqCst);
        }
        Err(ProviderError::invalid(
            "combined core APIs must not reach the host provider",
        ))
    }
}

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
struct Fixture {
    session: Session,
    sequence: u64,
    initial: Value,
    calls: Arc<AtomicUsize>,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "combined-error-random-native-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.push(Module {
            id: MODULE.into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        for name in [
            "wx.getRandomValues",
            "wx.onError",
            "wx.offError",
            "wx.getStorageSync",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let root = manifest.integrity.root.clone();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..Default::default()
            },
        )
        .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        session.set_provider(Box::new(TrapProvider {
            calls: calls.clone(),
        }));
        session.configure_host_services(HostServicesConfig {
            application:TrustedApplication {host_app_id:"host".into(),tenant_id:"tenant".into(),publisher_id:"publisher".into(),app_id:"combined-app".into(),environment:"develop".into(),version:"1".into(),pack_root:root},
            apis:vec!["wx.getBatteryInfo".into(),"weappContainer.identity.getState".into()],
            sync_values:BTreeMap::from([("weappContainer.identity.getState".into(),json!({"hostLoggedIn":false,"appLoggedIn":false,"profileAuthorized":false,"phoneAuthorized":false}))]),
            ..Default::default()
        }).unwrap();
        let mut result = Self {
            session,
            sequence: 0,
            initial: Value::Null,
            calls,
        };
        let initialized = result.raw(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        assert_eq!(
            initialized.messages[0].payload["ok"], true,
            "{initialized:?}"
        );
        result.initial = initialized.messages[0].payload["capabilities"].clone();
        result
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("combined-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call(&mut self, name: &str, args: Value) -> (Value, BridgeBatch) {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":name,"args":args}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        (
            batch.messages[0].payload["result"][0]["value"].clone(),
            batch,
        )
    }
}
fn diagnostics(batch: &BridgeBatch) -> Vec<String> {
    batch
        .messages
        .iter()
        .filter(|m| m.op == op::ERROR)
        .flat_map(|m| m.payload["errors"].as_array().into_iter().flatten())
        .filter_map(|e| e["message"].as_str().map(str::to_owned))
        .collect()
}

#[test]
fn real_rng_callback_throws_report_once_complete_and_preserve_ordinary_host_services() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        for failed in [false, true] {
            let (returned, begin) = fixture.call("begin", json!([failed]));
            assert_eq!(returned, true);
            let (value, inspect) = fixture.call("inspect", json!([]));
            assert_eq!(
                value["trace"],
                json!([
                    if failed {
                        "fail:ERR_INVALID_REQUEST"
                    } else {
                        "success:1"
                    },
                    "complete"
                ])
            );
            let message = if failed {
                "combined fail callback"
            } else {
                "combined success callback"
            };
            assert_eq!(value["notifications"], json!([message]));
            assert_eq!(value["core"], json!([true, true, true]));
            assert_eq!(
                value["identity"],
                json!({"hostLoggedIn":false,"appLoggedIn":false,"profileAuthorized":false,"phoneAuthorized":false})
            );
            let mut all = diagnostics(&begin);
            all.extend(diagnostics(&inspect));
            assert_eq!(all, vec![message]);
            let (_, later) = fixture.call("inspect", json!([]));
            assert!(diagnostics(&later).is_empty());
            assert!(fixture.session.execution_fault().is_none());
        }
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
        fixture.call("remove", json!([]));
    }
}

#[test]
fn published_keys_match_direct_and_js_policy_with_registered_extra_identity_keys() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        for (name, expected) in [
            ("wx.getRandomValues", "full"),
            ("wx.onError", "partial"),
            ("wx.offError", "full"),
            ("wx.getBatteryInfo", "partial"),
            ("weappContainer.identity.getState", "partial"),
            ("wx.getAccountInfoSync", "partial"),
        ] {
            assert_eq!(fixture.initial[name], expected, "{name}");
        }
        let entries = fixture.initial.as_object().unwrap().clone();
        for (name, support) in entries {
            let direct = fixture.raw(op::API_CALL, json!({"name":"wx.canIUse","capability":name}));
            assert_eq!(direct.messages[0].payload["support"], support, "{name}");
            let (guest, _) = fixture.call("canUse", json!([name]));
            assert_eq!(guest, support != "unsupported", "{name}");
        }
        assert_eq!(fixture.calls.load(Ordering::SeqCst), 0);
    }
}
