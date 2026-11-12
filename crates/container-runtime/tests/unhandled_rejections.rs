//! Actual engine rejection-hook -> checkpoint -> retained App/wx listener path.
//! This source is prepared without executing Cargo or either native engine.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    HostApiProvider, ProviderContext, ProviderError, SandboxProvider, Session, SessionConfig,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const MODULE: &str = "module:app.js";
const SOURCE: &str = r#"
App({trace:[],listeners:{},expected:[],onUnhandledRejection:function(event){
  this.trace.push({label:'app',promise:event.promise===this.expected[0],reason:event.reason===this.expected[1],type:typeof event.reason});
}});
const app=getApp(),on=wx.onUnhandledRejection,off=wx.offUnhandledRejection;
exports.listen=function(label,throwing){
  const callback=function(event){app.trace.push({label:label,promise:event.promise===app.expected[0],reason:event.reason===app.expected[1],type:typeof event.reason});if(throwing)throw Error('listener failure')};
  app.listeners[label]=callback;return on(callback)===undefined;
};
exports.remove=function(label){return(label===null?off():off(app.listeners[label]))===undefined};
exports.reject=function(kind,handled){
  const reason=kind==='error'?new Error('native identity'):kind==='undefined'?undefined:kind==='null'?null:17;
  const promise=Promise.reject(reason);app.expected=[promise,reason];
  if(handled===true)promise.catch(function(){});
  else if(handled==='microtask')Promise.resolve().then(function(){promise.catch(function(){})});
  return true;
};
exports.chain=function(){
  const reason=new Error('chained');const parent=Promise.reject(reason);const child=parent.then(function(){});
  app.expected=[child,reason];return true;
};
exports.lateHandle=function(){app.expected[0].catch(function(){});return true};
exports.inspect=function(){return app.trace};
exports.clear=function(){app.trace=[]};
exports.timer=function(){setTimeout(function(){const reason=new Error('timer');const p=Promise.reject(reason);app.expected=[p,reason]},1);return true};
exports.tamper=function(){globalThis.__container_app={onUnhandledRejection:function(){throw Error('forged app')}};globalThis.__container_app_listeners={unhandledRejection:[function(){throw Error('forged listener')}]};return true};
exports.policy=function(){return{on:wx.canIUse('onUnhandledRejection'),off:wx.canIUse('offUnhandledRejection'),caps:[__container_capabilities['wx.onUnhandledRejection'],__container_capabilities['wx.offUnhandledRejection']]}};
exports.forge=function(){__container_capabilities['wx.onUnhandledRejection']='full';try{on(function(){});return'allowed'}catch(error){return error.code}};
exports.retired=function(){try{on(function(){});return false}catch(error){return String(error.message).indexOf('retired')>=0}};
Object.keys(exports).forEach(function(name){const f=exports[name];exports[name]=function(){return{value:f.apply(this,arguments)}}});
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
    value.compiler.commit = "native-rejection-hook-fixture".into();
    value.app.app_json = "app.json".into();
    value.app.entry_module = "app.js".into();
    value.modules.push(Module {
        id: MODULE.into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: Vec::new(),
    });
    for name in ["wx.onUnhandledRejection", "wx.offUnhandledRejection"] {
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
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let mut f = Self {
            session: Session::new(
                manifest(),
                SessionConfig {
                    session_id: "native-rejection".into(),
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        f.ok(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        f.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        f
    }
    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "native-rejection",
            format!("rejection-{}", self.sequence),
            operation,
            payload,
        ));
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload.clone()
    }
    fn call(&mut self, name: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":name,"args":args}),
        )["result"][0]["value"]
            .clone()
    }
}
fn event(label: &str, kind: &str) -> Value {
    json!({"label":label,"promise":true,"reason":true,"type":kind})
}

#[test]
fn actual_native_rejection_hooks_keep_original_promise_and_error_reason_identity() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["wx", false]));
        f.call("tamper", json!([]));
        f.call("reject", json!(["error", false]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object"), event("wx", "object")])
        );
        f.call("lateHandle", json!([]));
        assert_eq!(f.call("inspect", json!([])).as_array().unwrap().len(), 2);
    }
}
#[test]
fn actual_same_turn_and_microtask_handlers_cancel_before_notification() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["wx", false]));
        f.call("reject", json!(["error", true]));
        f.call("reject", json!(["error", "microtask"]));
        assert_eq!(f.call("inspect", json!([])), json!([]));
        f.call("chain", json!([]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object"), event("wx", "object")])
        );
    }
}
#[test]
fn actual_native_primitive_reasons_and_listener_failures_preserve_remaining_delivery() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["throwing", true]));
        f.call("listen", json!(["later", false]));
        for (reason, kind) in [
            ("undefined", "undefined"),
            ("null", "object"),
            ("number", "number"),
        ] {
            f.call("clear", json!([]));
            f.call("reject", json!([reason, false]));
            assert_eq!(
                f.call("inspect", json!([])),
                json!([
                    event("app", kind),
                    event("throwing", kind),
                    event("later", kind)
                ])
            );
        }
    }
}
#[test]
fn actual_exact_and_all_removal_use_the_native_delivery_list() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["first", false]));
        f.call("listen", json!(["second", false]));
        assert_eq!(f.call("remove", json!(["first"])), true);
        f.call("reject", json!(["error", false]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object"), event("second", "object")])
        );
        f.call("clear", json!([]));
        assert_eq!(f.call("remove", json!([null])), true);
        f.call("reject", json!(["error", false]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object")])
        );
    }
}
struct PolicyProvider {
    fallback: SandboxProvider,
}
impl HostApiProvider for PolicyProvider {
    fn name(&self) -> &'static str {
        "rejection-policy"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut p = self.fallback.capabilities();
        p.insert(
            "wx.onUnhandledRejection".into(),
            CapabilitySupport::Unsupported,
        );
        p
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
fn native_notification_policy_revocation_and_terminal_retirement_do_not_revive_wx_listeners() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["old", false]));
        f.session.set_provider(Box::new(PolicyProvider {
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(f.call("forge", json!([])), "ERR_UNSUPPORTED_CAPABILITY");
        f.call("reject", json!(["error", false]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object")])
        );
        f.session.set_provider(Box::new(SandboxProvider::default()));
        f.call("clear", json!([]));
        f.call("reject", json!(["error", false]));
        assert_eq!(
            f.call("inspect", json!([])),
            json!([event("app", "object")])
        );
        f.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(f.call("retired", json!([])), true);
        f.call("clear", json!([]));
        f.call("reject", json!(["error", false]));
        assert_eq!(f.call("inspect", json!([])), json!([]));
    }
}
#[test]
fn native_rejection_queues_are_isolated_between_sessions() {
    for engine in engines() {
        let mut a = Fixture::new(engine);
        let mut b = Fixture::new(engine);
        a.call("listen", json!(["a", false]));
        b.call("listen", json!(["b", false]));
        a.call("reject", json!(["error", false]));
        assert_eq!(b.call("inspect", json!([])), json!([]));
        assert_eq!(
            a.call("inspect", json!([])),
            json!([event("app", "object"), event("a", "object")])
        );
        drop(a);
        b.call("reject", json!(["error", false]));
        assert_eq!(
            b.call("inspect", json!([])),
            json!([event("app", "object"), event("b", "object")])
        );
    }
}
