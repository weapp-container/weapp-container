//! Real Session entropy, policy, binary delivery and lifecycle regressions.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    provider::{HostApiProvider, ProviderContext, ProviderError, SandboxProvider},
    HostServicesConfig, Session, SessionConfig, TrustedApplication,
};
use serde_json::{json, Map, Value};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};

const SOURCE: &str = r#"
App({});
let trace=[],outcome=null,successValue=null,failValue=null,previousBuffer=null;
let lengthReads=0,callbackReads=0;
function reset(){trace=[];outcome=null;successValue=null;failValue=null;lengthReads=0;callbackReads=0;}
function describe(result){
  const value={byteLength:result.randomValues.byteLength,isBuffer:result.randomValues instanceof ArrayBuffer,
    separate:previousBuffer===null||previousBuffer!==result.randomValues,errMsg:result.errMsg};
  previousBuffer=result.randomValues;return value;
}
function success(result){successValue=result;trace.push('success');outcome=describe(result);}
function fail(error){failValue=error;trace.push('fail');outcome={code:error.code,errMsg:error.errMsg};}
function complete(result){
  trace.push('complete');
  if(successValue)outcome.sameResult=result===successValue;
  else outcome.sameError=result===failValue;
}
exports.begin=function(options){
  reset();options.success=success;options.fail=fail;options.complete=complete;
  return {value:wx.getRandomValues(options)===undefined};
};
exports.beginPromise=function(options){
  reset();const pending=wx.getRandomValues(options);
  pending.then(function(result){trace.push('promise');outcome=describe(result)},function(error){trace.push('reject');outcome={code:error.code,errMsg:error.errMsg}});
  return {value:pending instanceof Promise};
};
exports.structural=function(kind){
  reset();
  const prototype={get length(){lengthReads++;return 16},
    get success(){callbackReads++;return success},fail:fail,complete:complete};
  const inherited=Object.create(prototype);
  const options=kind==='proxy'?new Proxy(inherited,{get(target,key,receiver){return Reflect.get(target,key,receiver)}}):inherited;
  return {value:wx.getRandomValues(options)===undefined};
};
exports.inspect=function(){return {value:{trace:trace,outcome:outcome,canUse:wx.canIUse('getRandomValues'),lengthReads:lengthReads,callbackReads:callbackReads}};};
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

struct TrapProvider {
    fallback: SandboxProvider,
    random_calls: Arc<AtomicUsize>,
}
impl HostApiProvider for TrapProvider {
    fn name(&self) -> &'static str {
        "random-trap"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities = self.fallback.capabilities();
        // An unrelated provider inventory cannot disable runtime-owned entropy.
        capabilities.insert("wx.getRandomValues".into(), CapabilitySupport::Unsupported);
        capabilities
    }
    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if name == "wx.getRandomValues" {
            self.random_calls.fetch_add(1, Ordering::SeqCst);
            return Err(ProviderError::invalid(
                "random API reached a configurable provider",
            ));
        }
        self.fallback.call(name, payload, context)
    }
}

struct Fixture {
    session: Session,
    sequence: u64,
    random_calls: Arc<AtomicUsize>,
}
impl Fixture {
    fn new(
        engine: EngineKind,
        manifest_support: CapabilitySupport,
        host_support: Option<CapabilitySupport>,
    ) -> Self {
        Self::with_host_services(engine, manifest_support, host_support, false)
    }
    fn with_host_services(
        engine: EngineKind,
        manifest_support: CapabilitySupport,
        host_support: Option<CapabilitySupport>,
        configure: bool,
    ) -> Self {
        let mut manifest = ContainerManifestV1 {
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.compiler.commit = "secure-random-runtime-contract".into();
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        manifest
            .capabilities
            .insert("wx.getRandomValues".into(), manifest_support);
        manifest.refresh_integrity().unwrap();
        let pack_root = manifest.integrity.root.clone();
        let mut config = SessionConfig {
            engine,
            ..Default::default()
        };
        if let Some(support) = host_support {
            config
                .capabilities
                .insert("wx.getRandomValues".into(), support);
        }
        let mut session = Session::new(manifest, config).unwrap();
        let random_calls = Arc::new(AtomicUsize::new(0));
        session.set_provider(Box::new(TrapProvider {
            fallback: SandboxProvider::default(),
            random_calls: random_calls.clone(),
        }));
        if configure {
            let configuration = |apis: Vec<String>| HostServicesConfig {
                application: TrustedApplication {
                    host_app_id: "random-host".into(),
                    tenant_id: "random-tenant".into(),
                    publisher_id: "random-publisher".into(),
                    app_id: "random-app".into(),
                    environment: "develop".into(),
                    version: "fixture".into(),
                    pack_root: pack_root.clone(),
                },
                apis,
                ..Default::default()
            };
            let denied = session
                .configure_host_services(configuration(vec!["wx.getRandomValues".into()]))
                .unwrap_err();
            assert!(
                denied.message.contains("owned by the runtime"),
                "{denied:?}"
            );
            session
                .configure_host_services(configuration(Vec::new()))
                .unwrap();
        }
        let mut fixture = Self {
            session,
            sequence: 0,
            random_calls,
        };
        let batch = fixture.raw(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
        );
        fixture.assert_ok(&batch);
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("random-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn assert_ok(&self, batch: &BridgeBatch) {
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert!(
            !batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
    }
    fn call(&mut self, export: &str, args: Value) -> Value {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        );
        self.assert_ok(&batch);
        batch.messages[0].payload["result"][0]["value"].clone()
    }
    fn begin_and_inspect(&mut self, options: Value) -> Value {
        assert_eq!(self.call("begin", json!([options])), true);
        self.call("inspect", json!([]))
    }
    fn assert_no_provider_random(&self) {
        assert_eq!(self.random_calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn real_session_csprng_delivers_maximum_buffers_through_both_public_modes_at_default_limits() {
    for engine in engines() {
        for export in ["begin", "beginPromise"] {
            let mut fixture = Fixture::new(engine, CapabilitySupport::Full, None);
            for length in [0, 1, 16, 65_535, 65_536, 65_537, 1_048_576] {
                assert_eq!(fixture.call(export, json!([{"length":length}])), true);
                let result = fixture.call("inspect", json!([]));
                assert_eq!(result["canUse"], true);
                assert_eq!(result["outcome"]["byteLength"], length);
                assert_eq!(result["outcome"]["isBuffer"], true);
                assert_eq!(result["outcome"]["separate"], true);
                assert_eq!(result["outcome"]["errMsg"], "getRandomValues:ok");
                if export == "begin" {
                    assert_eq!(result["trace"], json!(["success", "complete"]));
                    assert_eq!(result["outcome"]["sameResult"], true);
                } else {
                    assert_eq!(result["trace"], json!(["promise"]));
                }
            }
            fixture.assert_no_provider_random();
        }
    }
}

#[test]
fn inherited_and_proxy_getters_are_snapshotted_once_through_real_sessions() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, CapabilitySupport::Full, None);
        for kind in ["inherited", "proxy"] {
            assert_eq!(fixture.call("structural", json!([kind])), true);
            let result = fixture.call("inspect", json!([]));
            assert_eq!(result["trace"], json!(["success", "complete"]));
            assert_eq!(result["lengthReads"], 1);
            assert_eq!(result["callbackReads"], 1);
            assert_eq!(result["outcome"]["byteLength"], 16);
            assert_eq!(result["outcome"]["sameResult"], true);
        }
        fixture.assert_no_provider_random();
    }
}

#[test]
fn invalid_lengths_and_expired_or_cancelled_controls_fail_once_through_native_session() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, CapabilitySupport::Full, None);
        for options in [
            json!({}),
            json!({"length":null}),
            json!({"length":"16"}),
            json!({"length":true}),
            json!({"length":-1}),
            json!({"length":1.5}),
            json!({"length":1_048_577}),
        ] {
            let result = fixture.begin_and_inspect(options);
            assert_eq!(result["trace"], json!(["fail", "complete"]));
            assert_eq!(result["outcome"]["code"], "ERR_INVALID_REQUEST");
            assert_eq!(result["outcome"]["sameError"], true);
        }
        let result = fixture.begin_and_inspect(json!({"length":16,"deadlineNs":1}));
        assert_eq!(result["trace"], json!(["fail", "complete"]));
        assert_eq!(result["outcome"]["code"], "ERR_TIMEOUT");
        let cancelled = fixture.raw(op::CANCEL, json!({"cancelToken":"random-cancelled"}));
        fixture.assert_ok(&cancelled);
        let result =
            fixture.begin_and_inspect(json!({"length":16,"cancelToken":"random-cancelled"}));
        assert_eq!(result["trace"], json!(["fail", "complete"]));
        assert_eq!(result["outcome"]["code"], "ERR_CANCELLED");
        fixture.assert_no_provider_random();
    }
}

#[test]
fn manifest_and_host_policy_can_each_deny_runtime_owned_entropy() {
    for engine in engines() {
        for (manifest, host) in [
            (CapabilitySupport::Unsupported, None),
            (
                CapabilitySupport::Full,
                Some(CapabilitySupport::Unsupported),
            ),
        ] {
            let mut fixture = Fixture::new(engine, manifest, host);
            let result = fixture.begin_and_inspect(json!({"length":16}));
            assert_eq!(result["canUse"], false);
            assert_eq!(result["trace"], json!(["fail", "complete"]));
            assert_eq!(result["outcome"]["code"], "ERR_UNSUPPORTED_CAPABILITY");
            let direct = fixture.raw(
                op::API_CALL,
                json!({"name":"wx.getRandomValues","length":16}),
            );
            assert_eq!(direct.messages[0].payload["ok"], false, "{direct:?}");
            assert_eq!(
                direct.messages[0].payload["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{direct:?}"
            );
            fixture.assert_no_provider_random();
        }
    }
}

#[test]
fn direct_bridge_calls_use_the_same_csprng_and_strict_validation() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, CapabilitySupport::Full, None);
        let batch = fixture.raw(
            op::API_CALL,
            json!({"name":"wx.getRandomValues","length":16.0}),
        );
        fixture.assert_ok(&batch);
        let result = &batch.messages[0].payload["result"];
        assert_eq!(result["errMsg"], "getRandomValues:ok");
        assert_eq!(
            result["randomValues"]["__weappBinary"]["type"],
            "ArrayBuffer"
        );
        assert_eq!(
            result["randomValues"]["__weappBinary"]["bytes"]
                .as_array()
                .unwrap()
                .len(),
            16
        );
        for options in [
            json!({"length":"16"}),
            json!({"length":1.5}),
            json!({"length":1_048_577}),
        ] {
            let mut payload = options.as_object().unwrap().clone();
            payload.insert("name".into(), json!("wx.getRandomValues"));
            let batch = fixture.raw(op::API_CALL, Value::Object(payload));
            assert_eq!(batch.messages[0].payload["ok"], false, "{batch:?}");
            assert_eq!(
                batch.messages[0].payload["error"]["code"], "ERR_INVALID_REQUEST",
                "{batch:?}"
            );
        }
        let expired = fixture.raw(
            op::API_CALL,
            json!({"name":"wx.getRandomValues","length":16,"deadlineNs":1}),
        );
        assert_eq!(expired.messages[0].payload["ok"], false, "{expired:?}");
        assert_eq!(
            expired.messages[0].payload["error"]["code"], "ERR_TIMEOUT",
            "{expired:?}"
        );
        let cancelled = fixture.raw(op::CANCEL, json!({"cancelToken":"direct-random-cancelled"}));
        fixture.assert_ok(&cancelled);
        let cancelled = fixture.raw(op::API_CALL, json!({"name":"wx.getRandomValues","length":16,"cancelToken":"direct-random-cancelled"}));
        assert_eq!(cancelled.messages[0].payload["ok"], false, "{cancelled:?}");
        assert_eq!(
            cancelled.messages[0].payload["error"]["code"], "ERR_CANCELLED",
            "{cancelled:?}"
        );
        fixture.assert_no_provider_random();
    }
}

#[test]
fn callback_and_promise_failure_modes_and_configured_hosts_keep_runtime_entropy_ownership() {
    for engine in engines() {
        let mut fixture = Fixture::with_host_services(engine, CapabilitySupport::Full, None, true);
        for export in ["begin", "beginPromise"] {
            assert_eq!(fixture.call(export, json!([{"length":16}])), true);
            let result = fixture.call("inspect", json!([]));
            assert_eq!(result["outcome"]["byteLength"], 16);
            assert_eq!(result["outcome"]["isBuffer"], true);
            for (options, code) in [
                (json!({"length":-1}), "ERR_INVALID_REQUEST"),
                (json!({"length":16,"deadlineNs":1}), "ERR_TIMEOUT"),
            ] {
                assert_eq!(fixture.call(export, json!([options])), true);
                let result = fixture.call("inspect", json!([]));
                assert_eq!(result["outcome"]["code"], code);
                if export == "begin" {
                    assert_eq!(result["trace"], json!(["fail", "complete"]));
                    assert_eq!(result["outcome"]["sameError"], true);
                } else {
                    assert_eq!(result["trace"], json!(["reject"]));
                }
            }
        }
        fixture.assert_no_provider_random();
    }
}
