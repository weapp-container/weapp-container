//! Finite listener-removal contracts through both native Sessions.
//! Tests call the existing compatibility dispatcher explicitly. They do not
//! implement or establish automatic missing-page routing/recovery production.
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

const SESSION_ID: &str = "page-not-found-listeners";
const MODULE: &str = "module:app.js";
const SOURCE: &str = r#"
App({trace:[],listeners:{}});
const on=wx.onPageNotFound,off=wx.offPageNotFound;
const dispatch=__container_dispatch_app_listeners;
exports.listen=function(label){
  const callback=function(event){getApp().trace.push(label+':'+event.path)};
  getApp().listeners[label]=callback;return on(callback)===undefined;
};
exports.remove=function(label){return (label===null?off():off(getApp().listeners[label]))===undefined};
exports.emit=function(path){dispatch('pageNotFound',[{path:path,query:{},isEntryPage:false}]);return getApp().trace};
exports.inspect=function(){return getApp().trace};
exports.clear=function(){getApp().trace=[]};
exports.snapshot=function(){
  function later(){getApp().trace.push('later')}
  function second(){getApp().trace.push('second')}
  function first(){getApp().trace.push('first');off();on(later)}
  on(first);on(second);
};
exports.tamper=function(){
  globalThis.__container_app_listeners={pageNotFound:[function(){getApp().trace.push('forged')}]};
};
exports.policy=function(){return {
  on:wx.canIUse('onPageNotFound'),off:wx.canIUse('offPageNotFound'),
  caps:[__container_capabilities['wx.onPageNotFound'],__container_capabilities['wx.offPageNotFound']]
}};
exports.tryRemove=function(){try{off();return 'allowed'}catch(error){return error.code}};
exports.forge=function(){
  __container_capabilities['wx.onPageNotFound']='full';
  __container_capabilities['wx.offPageNotFound']='full';
  try{on(function(){getApp().trace.push('revived')});return 'allowed'}catch(error){return error.code}
};
exports.tryRetired=function(){try{on(function(){});return false}catch(error){return String(error.message).indexOf('retired')>=0}};
exports.reentry=function(){
  let attempted=false;getApp().reentry=[];
  globalThis.__container_app_listeners=new Proxy({}, {defineProperty:function(target,key,descriptor){
    if(!attempted){attempted=true;
      try{on(function(){getApp().trace.push('revived')});getApp().reentry.push('on allowed')}
      catch(error){getApp().reentry.push(error.code)}
      try{off();getApp().reentry.push('off allowed')}
      catch(error){getApp().reentry.push(error.code)}
    }
    return Reflect.defineProperty(target,key,descriptor);
  }});
};
exports.reentryResult=function(){return getApp().reentry};
Object.keys(exports).forEach(function(name){
  const callback=exports[name];exports[name]=function(){return {value:callback.apply(this,arguments)}};
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

fn manifest() -> ContainerManifestV1 {
    let mut value = ContainerManifestV1::default();
    value.compiler.commit = "page-not-found-removal-fixture".into();
    value.app.app_json = "app.json".into();
    value.app.entry_module = "app.js".into();
    value.modules.push(Module {
        id: MODULE.into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: Vec::new(),
    });
    for name in ["wx.onPageNotFound", "wx.offPageNotFound"] {
        value
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    value.refresh_integrity().unwrap();
    value
}

struct Fixture {
    session: Session,
    sequence: u64,
    initial: Value,
}

impl Fixture {
    fn new(engine: EngineKind, mut value: ContainerManifestV1, host_registration: bool) -> Self {
        value.refresh_integrity().unwrap();
        let pack_root = value.integrity.root.clone();
        let mut fixture = Self {
            session: Session::new(
                value,
                SessionConfig {
                    session_id: SESSION_ID.into(),
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
            initial: Value::Null,
        };
        if host_registration {
            fixture
                .session
                .configure_host_services(HostServicesConfig {
                    application: TrustedApplication {
                        host_app_id: "listener-host".into(),
                        tenant_id: "listener-tenant".into(),
                        publisher_id: "listener-publisher".into(),
                        app_id: "listener-app".into(),
                        environment: "develop".into(),
                        version: "fixture".into(),
                        pack_root,
                    },
                    apis: Vec::new(),
                    ..Default::default()
                })
                .unwrap();
        }
        let initialized = fixture.ok(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        fixture.initial = initialized["capabilities"].clone();
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture
    }

    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION_ID,
            format!("page-not-found-{}", self.sequence),
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
}

#[test]
fn registration_and_exact_or_all_removal_keep_one_private_owner_across_host_configuration() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), true);
        assert_eq!(fixture.initial["wx.onPageNotFound"], "partial");
        assert_eq!(fixture.initial["wx.offPageNotFound"], "full");
        fixture.call("listen", json!(["first"]));
        fixture.call("listen", json!(["second"]));
        fixture.call("tamper", json!([]));
        assert_eq!(fixture.call("remove", json!(["first"])), true);
        assert_eq!(
            fixture.call("emit", json!(["missing"])),
            json!(["second:missing"])
        );
        assert_eq!(fixture.call("remove", json!([null])), true);
        assert_eq!(
            fixture.call("emit", json!(["other"])),
            json!(["second:missing"])
        );
    }
}

#[test]
fn compatibility_dispatch_keeps_ordinary_mutation_snapshot() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), false);
        fixture.call("snapshot", json!([]));
        assert_eq!(
            fixture.call("emit", json!(["one"])),
            json!(["first", "second"])
        );
        fixture.call("clear", json!([]));
        assert_eq!(fixture.call("emit", json!(["two"])), json!(["later"]));
    }
}

struct PolicyProvider {
    revoked: &'static str,
    fallback: SandboxProvider,
}

impl HostApiProvider for PolicyProvider {
    fn name(&self) -> &'static str {
        "page-not-found-policy"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut result = self.fallback.capabilities();
        result.insert(self.revoked.into(), CapabilitySupport::Unsupported);
        result
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
fn trusted_registration_revocation_clears_and_public_forgery_cannot_restore_listener_authority() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), false);
        fixture.call("listen", json!(["old"]));
        fixture.session.set_provider(Box::new(PolicyProvider {
            revoked: "wx.onPageNotFound",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":false,"off":true,"caps":["unsupported","full"]})
        );
        assert_eq!(
            fixture.call("forge", json!([])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(fixture.call("tryRemove", json!([])), "allowed");
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        assert_eq!(fixture.call("emit", json!(["late"])), json!([]));
    }
}

#[test]
fn legacy_registration_without_public_removal_still_has_unconditional_terminal_cleanup() {
    for engine in engines() {
        let mut value = manifest();
        value.capabilities.remove("wx.offPageNotFound");
        let mut fixture = Fixture::new(engine, value, false);
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":true,"off":false,"caps":["partial","unsupported"]})
        );
        fixture.call("listen", json!(["old"]));
        assert_eq!(
            fixture.call("tryRemove", json!([])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(fixture.call("tryRetired", json!([])), true);
        fixture.call("clear", json!([]));
        assert_eq!(fixture.call("emit", json!(["late"])), json!([]));
    }
}

#[test]
fn trusted_removal_revocation_preserves_registration_until_terminal_owner_cleanup() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), false);
        fixture.call("listen", json!(["old"]));
        fixture.session.set_provider(Box::new(PolicyProvider {
            revoked: "wx.offPageNotFound",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("tryRemove", json!([])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(fixture.call("emit", json!(["one"])), json!(["old:one"]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        assert_eq!(fixture.call("tryRetired", json!([])), true);
        fixture.call("clear", json!([]));
        assert_eq!(fixture.call("emit", json!(["late"])), json!([]));
        assert_eq!(fixture.call("tryRemove", json!([])), "allowed");
    }
}

#[test]
fn trusted_admission_changes_precede_reentrant_diagnostic_projection_traps() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), false);
        fixture.call("listen", json!(["old"]));
        fixture.call("reentry", json!([]));
        fixture.session.set_provider(Box::new(PolicyProvider {
            revoked: "wx.onPageNotFound",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("reentryResult", json!([])),
            json!(["ERR_UNSUPPORTED_CAPABILITY", "off allowed"])
        );
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        assert_eq!(fixture.call("emit", json!(["late"])), json!([]));
    }
}
