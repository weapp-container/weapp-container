//! Finite error-listener ownership contracts through both real native Sessions.
//! These tests preserve the stage-one wx string projection. They do not establish
//! App.onError, complete uncaught-source coverage, or Promise rejection tracking.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    HostApiProvider, HostServicesConfig, ProviderContext, ProviderError, SandboxProvider, Session,
    SessionConfig, TrustedApplication,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const SESSION_ID: &str = "error-listener-contract";
const MODULE: &str = "module:app.js";
const ORIGINAL: &str = "fixture original error";
const PRIMITIVE: &str = "fixture original primitive";
const SOURCE: &str = r#"
App({trace:[],listeners:{},failUnload:false,
  onUnload:function(){
    this.trace.push({label:'unload'});
    if(this.failUnload)throw Error('fixture unload error');
  }
});
const borrowedOn=wx.onError;
const borrowedOff=wx.offError;
function record(label,message){
  getApp().trace.push({label:label,message:message,type:typeof message});
}
exports.inspect=function(){return getApp().trace.slice()};
exports.clear=function(){getApp().trace=[]};
exports.listen=function(label,throwing){
  const listener=function(message){
    record(label,message);
    if(throwing)throw Error('fixture listener error');
  };
  getApp().listeners[label]=listener;
  return borrowedOn(listener)===undefined;
};
exports.remove=function(label){
  return (label===null?borrowedOff():borrowedOff(getApp().listeners[label]))===undefined;
};
exports.snapshot=function(){
  function later(message){record('later',message)}
  function second(message){record('second',message)}
  function first(message){
    record('first',message);
    borrowedOff(first);borrowedOff(second);borrowedOn(later);
  }
  borrowedOn(first);borrowedOn(second);
};
exports.fail=function(primitive){
  if(primitive)throw 'fixture original primitive';
  throw Error('fixture original error');
};
exports.tamper=function(){
  globalThis.__container_error_handlers=[];
  globalThis.__container_report_error=function(){record('fake.report','forged')};
};
exports.policy=function(){
  return {on:wx.canIUse('onError'),off:wx.canIUse('offError'),
    caps:[__container_capabilities['wx.onError'],__container_capabilities['wx.offError']]};
};
exports.forgeAndTryBorrowed=function(){
  __container_capabilities['wx.onError']='full';
  __container_capabilities['wx.offError']='full';
  const errors=[];
  for(const method of [borrowedOn,borrowedOff]){
    try{method(function(){});errors.push('allowed')}
    catch(error){errors.push(error.code)}
  }
  return errors;
};
exports.failUnload=function(){getApp().failUnload=true};
exports.tryRemove=function(){
  try{borrowedOff();return 'allowed'}catch(error){return error.code}
};
exports.listenerCount=function(){return __container_error_handlers.length};
exports.tryRetiredBorrowed=function(){
  try{borrowedOn(function(message){record('revived',message)});return false}
  catch(error){return String(error.message).indexOf('retired')>=0}
};
// JsEngine treats a returned array as a result batch; use one stable codec.
Object.keys(exports).forEach(function(name){
  const callback=exports[name];
  exports[name]=function(){return {value:callback.apply(this,arguments)}};
});
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn error_manifest() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "error-listener-local-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.modules.push(Module {
        id: MODULE.into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: Vec::new(),
    });
    for name in ["wx.onError", "wx.offError"] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    manifest
}

fn host_configuration(pack_root: String, apis: &[&str]) -> HostServicesConfig {
    HostServicesConfig {
        application: TrustedApplication {
            host_app_id: "error-host".into(),
            tenant_id: "error-tenant".into(),
            publisher_id: "error-publisher".into(),
            app_id: "error-app".into(),
            environment: "develop".into(),
            version: "fixture".into(),
            pack_root,
        },
        apis: apis.iter().map(|name| (*name).to_owned()).collect(),
        ..Default::default()
    }
}

struct Fixture {
    session: Session,
    sequence: u64,
    initial_capabilities: Value,
}

impl Fixture {
    fn new(engine: EngineKind) -> Self {
        Self::with_host_services(engine, false)
    }

    fn with_host_services(engine: EngineKind, configured: bool) -> Self {
        Self::with_manifest(engine, error_manifest(), configured)
    }

    fn with_manifest(engine: EngineKind, manifest: ContainerManifestV1, configured: bool) -> Self {
        let pack_root = manifest.integrity.root.clone();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    session_id: SESSION_ID.into(),
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
            initial_capabilities: Value::Null,
        };
        if configured {
            fixture
                .session
                .configure_host_services(host_configuration(pack_root, &[]))
                .expect("ordinary host services preserve core error capabilities");
        }
        let initialized = fixture.ok(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        fixture.initial_capabilities = initialized["capabilities"].clone();
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture
    }

    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION_ID,
            format!("error-listener-{}", self.sequence),
            operation,
            payload,
        ))
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let batch = self.raw(operation, payload);
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert!(
            !batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
        batch.messages[0].payload.clone()
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":export,"args":args}),
        )["result"][0]["value"]
            .clone()
    }

    fn call_with_diagnostics(&mut self, export: &str, args: Value) -> Value {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":export,"args":args}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload["result"][0]["value"].clone()
    }

    fn fail(&mut self, primitive: bool) -> BridgeBatch {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"fail","args":[primitive]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], false, "{batch:?}");
        assert_eq!(
            batch.messages[0].payload["error"]["code"], "ERR_ENGINE",
            "{batch:?}"
        );
        assert_ne!(batch.messages[0].payload["requiresRestart"], true);
        assert!(self.session.execution_fault().is_none());
        batch
    }

    fn trace(&mut self) -> Vec<Value> {
        self.call("inspect", json!([])).as_array().unwrap().clone()
    }
}

fn errors_with_message(batch: &BridgeBatch, expected: &str) -> usize {
    batch
        .messages
        .iter()
        .filter(|message| message.op == op::ERROR)
        .flat_map(|message| message.payload["errors"].as_array().into_iter().flatten())
        .filter(|error| error["message"] == expected)
        .count()
}

fn labels(trace: &[Value]) -> Vec<&str> {
    trace
        .iter()
        .map(|event| event["label"].as_str().unwrap())
        .collect()
}

#[test]
fn retained_call_reports_once_and_preserves_primitive_failure_after_alias_tampering() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        assert_eq!(fixture.call("listen", json!(["kept", false])), true);
        fixture.call("tamper", json!([]));
        for (primitive, expected) in [(false, ORIGINAL), (true, PRIMITIVE)] {
            fixture.call("clear", json!([]));
            let failed = fixture.fail(primitive);
            assert!(
                failed.messages[0].payload["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains(expected),
                "{failed:?}"
            );
            assert_eq!(errors_with_message(&failed, expected), 1, "{failed:?}");
            assert_eq!(
                fixture.trace(),
                vec![json!({"label":"kept","message":expected,"type":"string"})]
            );
            fixture.call("clear", json!([]));
            assert!(fixture.trace().is_empty());
        }
    }
}

#[test]
fn dispatch_snapshot_and_exact_or_all_removal_share_the_private_listener_list() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("snapshot", json!([]));
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["first", "second"]);
        fixture.call("clear", json!([]));
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["later"]);
        assert_eq!(fixture.call("remove", json!([null])), true);
        fixture.call("clear", json!([]));
        fixture.fail(false);
        assert!(fixture.trace().is_empty());
        fixture.call("listen", json!(["removed", false]));
        fixture.call("listen", json!(["kept", false]));
        assert_eq!(fixture.call("remove", json!(["removed"])), true);
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["kept"]);
    }
}

#[test]
fn throwing_error_listener_is_isolated_and_keeps_the_original_call_failure() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("listen", json!(["throwing", true]));
        fixture.call("listen", json!(["later", false]));
        let failed = fixture.fail(true);
        assert_eq!(errors_with_message(&failed, PRIMITIVE), 1);
        assert_eq!(errors_with_message(&failed, "fixture listener error"), 1);
        assert_eq!(labels(&fixture.trace()), ["throwing", "later"]);
        fixture.call("clear", json!([]));
        assert!(fixture.trace().is_empty());
    }
}

// Provider replacement is a public trusted Session boundary. It invalidates
// the environment, and the next real MODULE_CALL installs the new policy.
struct ErrorPolicyProvider {
    revoked: &'static str,
    fallback: SandboxProvider,
}

impl HostApiProvider for ErrorPolicyProvider {
    fn name(&self) -> &'static str {
        "error-policy-fixture"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities = self.fallback.capabilities();
        capabilities.insert(self.revoked.into(), CapabilitySupport::Unsupported);
        capabilities
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.fallback.call(name, payload, context)
    }
}

#[test]
fn trusted_on_revocation_clears_listeners_while_removal_remains_independently_admitted() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        assert_eq!(fixture.initial_capabilities["wx.onError"], "partial");
        assert_eq!(fixture.initial_capabilities["wx.offError"], "full");
        fixture.call("listen", json!(["old", false]));
        fixture.session.set_provider(Box::new(ErrorPolicyProvider {
            revoked: "wx.onError",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":false,"off":true,"caps":["unsupported","full"]})
        );
        assert_eq!(
            fixture.call_with_diagnostics("forgeAndTryBorrowed", json!([])),
            json!(["ERR_UNSUPPORTED_CAPABILITY", "allowed"])
        );
        fixture.fail(false);
        assert!(fixture.trace().is_empty());
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        fixture.fail(false);
        assert!(
            fixture.trace().is_empty(),
            "revoked registration was restored"
        );
        fixture.call("listen", json!(["new", false]));
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["new"]);
    }
}

#[test]
fn trusted_off_revocation_keeps_existing_and_new_on_registrations_until_owner_retirement() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("listen", json!(["old", false]));
        fixture.session.set_provider(Box::new(ErrorPolicyProvider {
            revoked: "wx.offError",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":true,"off":false,"caps":["partial","unsupported"]})
        );
        assert_eq!(
            fixture.call_with_diagnostics("forgeAndTryBorrowed", json!([])),
            json!(["allowed", "ERR_UNSUPPORTED_CAPABILITY"])
        );
        fixture.call("listen", json!(["new", false]));
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["old", "new"]);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(fixture.call("listenerCount", json!([])), 0);
        assert_eq!(fixture.call("tryRetiredBorrowed", json!([])), true);
        fixture.call("clear", json!([]));
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        fixture.fail(false);
        assert!(
            fixture.trace().is_empty(),
            "retired listeners revived after off restoration"
        );
        assert_eq!(fixture.call("tryRemove", json!([])), "allowed");
    }
}

#[test]
fn production_default_manifest_and_legacy_on_only_manifest_keep_separate_public_admission() {
    for engine in engines() {
        for legacy in [false, true] {
            // Generated by the production buildManifest defaults, with the exact
            // SOURCE above. The Node regression rebuilds and compares all bytes.
            let mut manifest: ContainerManifestV1 =
                serde_json::from_str(include_str!("fixtures/error-default-manifest.json")).unwrap();
            assert_eq!(
                manifest.capabilities["wx.onError"],
                CapabilitySupport::Partial
            );
            assert_eq!(
                manifest.capabilities["wx.offError"],
                CapabilitySupport::Partial
            );
            if legacy {
                manifest.capabilities.remove("wx.offError");
                manifest.refresh_integrity().unwrap();
                assert!(!manifest.capabilities.contains_key("wx.offError"));
            }
            let mut fixture = Fixture::with_manifest(engine, manifest, true);
            let off = if legacy { "unsupported" } else { "partial" };
            assert_eq!(
                fixture.call("policy", json!([])),
                json!({"on":true,"off":!legacy,"caps":["partial",off]})
            );
            fixture.call("listen", json!(["kept", false]));
            fixture.fail(false);
            assert_eq!(labels(&fixture.trace()), ["kept"]);
            let removal = fixture.call_with_diagnostics("tryRemove", json!([]));
            assert_eq!(
                removal,
                if legacy {
                    "ERR_UNSUPPORTED_CAPABILITY"
                } else {
                    "allowed"
                }
            );
            if !legacy {
                fixture.call("clear", json!([]));
                fixture.fail(false);
                assert!(fixture.trace().is_empty());
                fixture.call("listen", json!(["kept", false]));
            }
            fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
            assert_eq!(fixture.call("listenerCount", json!([])), 0);
            assert_eq!(fixture.call("tryRetiredBorrowed", json!([])), true);
            fixture.call("clear", json!([]));
            fixture
                .session
                .set_provider(Box::new(SandboxProvider::default()));
            fixture.fail(false);
            assert!(
                fixture.trace().is_empty(),
                "legacy owner cleanup depended on public offError"
            );
        }
    }
}

#[test]
fn off_only_manifest_can_remove_without_registering_or_delivering_errors() {
    for engine in engines() {
        let mut manifest = error_manifest();
        manifest.capabilities.remove("wx.onError");
        manifest.refresh_integrity().unwrap();
        let mut fixture = Fixture::with_manifest(engine, manifest, false);
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":false,"off":true,"caps":["unsupported","full"]})
        );
        assert_eq!(
            fixture.call_with_diagnostics("forgeAndTryBorrowed", json!([])),
            json!(["ERR_UNSUPPORTED_CAPABILITY", "allowed"])
        );
        fixture.fail(false);
        assert!(fixture.trace().is_empty());
    }
}

#[test]
fn throwing_app_unload_reports_before_terminal_retirement_and_borrowed_on_stays_retired() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("listen", json!(["kept", false]));
        fixture.call("failUnload", json!([]));
        let unloaded = fixture.raw(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(unloaded.messages[0].payload["ok"], false, "{unloaded:?}");
        assert_eq!(errors_with_message(&unloaded, "fixture unload error"), 1);
        assert_eq!(labels(&fixture.trace()), ["unload", "kept"]);
        assert_eq!(fixture.call("tryRetiredBorrowed", json!([])), true);
        fixture.call("clear", json!([]));
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        fixture.fail(false);
        assert!(
            fixture.trace().is_empty(),
            "retirement was undone by policy refresh"
        );
    }
}

#[test]
fn trusted_registry_rejects_each_error_registration_shape_before_app_init() {
    for engine in engines() {
        for apis in [
            vec!["wx.offError"],
            vec!["wx.onError"],
            vec!["wx.onError", "wx.offError"],
        ] {
            let manifest = error_manifest();
            let pack_root = manifest.integrity.root.clone();
            let mut session = Session::new(
                manifest,
                SessionConfig {
                    session_id: SESSION_ID.into(),
                    engine,
                    ..Default::default()
                },
            )
            .unwrap();
            let error = session
                .configure_host_services(host_configuration(pack_root.clone(), &apis))
                .expect_err("the runtime error pair cannot become a native subscription");
            assert!(error.message.contains("owned by the runtime"), "{error:?}");
            // A denied registry must not consume the once-only installation.
            session
                .configure_host_services(host_configuration(pack_root, &[]))
                .expect("ordinary valid host configuration remains installable");
        }
    }
}

#[test]
fn ordinary_host_configuration_keeps_error_removal_and_terminal_ownership_in_the_hub() {
    for engine in engines() {
        let mut fixture = Fixture::with_host_services(engine, true);
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":true,"off":true,"caps":["partial","full"]})
        );
        fixture.call("listen", json!(["kept", false]));
        fixture.fail(false);
        assert_eq!(labels(&fixture.trace()), ["kept"]);
        fixture.call("remove", json!([null]));
        fixture.call("clear", json!([]));
        fixture.fail(false);
        assert!(fixture.trace().is_empty());
        fixture.call("listen", json!(["unload", false]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(fixture.call("tryRetiredBorrowed", json!([])), true);
    }
}
