//! Actual native Session route contracts; not a browser/device acceptance suite.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    Route, RouteKind,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const APP: &str = "module:app.js";
const SOURCE: &str = r#"
App({trace:[],target:null,preserve:false,late:false});
wx.onBeforeAppRoute(function(event){
  const app=getApp();
  app.trace.push({phase:'before',event:event});
  if(app.target){
    const target=app.target;app.target=null;
    app.trace.push({phase:'return',void:wx.rewriteRoute({url:target,preserveQuery:app.preserve,
      success:function(result){app.trace.push({phase:'rewrite.ok',result:result})},
      fail:function(result){app.trace.push({phase:'rewrite.fail',result:result})}
    })===undefined});
  }
  if(app.late)Promise.resolve().then(function(){
    wx.rewriteRoute({url:'/other',fail:function(result){app.trace.push({phase:'late.fail',result:result})}});
  });
});
wx.onAppRoute(function(event){getApp().trace.push({phase:'after',event:event})});
wx.onBeforePageUnload(function(event){getApp().trace.push({phase:'unload.before',id:event.routeEventId})});
wx.onAfterPageUnload(function(event){getApp().trace.push({phase:'unload.after',id:event.routeEventId})});
exports.target=function(path,preserve){getApp().target=path;getApp().preserve=preserve===true;return {value:true}};
exports.inspect=function(){return {value:getApp().trace}};
exports.clear=function(){getApp().trace=[];return {value:true}};
exports.late=function(){getApp().late=true;return {value:true}};
exports.breakUnload=function(){
  const original=globalThis.__container_invoke_page_instance;
  getApp().savedInvoke=original;
  globalThis.__container_invoke_page_instance=function(id,index,name,args){
    if(name==='onUnload')throw Error('fixture rejected unload before retirement');
    return original(id,index,name,args);
  };return {value:true};
};
exports.restoreUnload=function(){globalThis.__container_invoke_page_instance=getApp().savedInvoke;delete getApp().savedInvoke;return {value:true}};

exports.navigate=function(method,options){wx[method](options).catch(function(error){getApp().trace.push({phase:'nav.fail',error:error})});return {value:true}};
"#;
const PAGE: &str = r#"
Page({onLoad:function(query){getApp().trace.push({phase:'load',path:this.route,query:query})},
  onUnload:function(){getApp().trace.push({phase:'unload',path:this.route})}});
"#;

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
    initial_capabilities: Value,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        Self::with_route_support(
            engine,
            CapabilitySupport::Partial,
            CapabilitySupport::Partial,
        )
    }
    fn with_route_support(
        engine: EngineKind,
        support: CapabilitySupport,
        rewrite: CapabilitySupport,
    ) -> Self {
        let mut manifest = ContainerManifestV1 {
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.compiler.commit = "route-transaction-local-contract".into();
        manifest.modules.push(Module {
            id: APP.into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        let mut modules = vec![json!({"id":APP,"source":SOURCE})];
        for path in ["home", "detail", "other", "tab"] {
            let id = format!("module:{path}.js");
            manifest.modules.push(Module {
                id: id.clone(),
                sha256: hex_digest(PAGE.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::Page,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"source":PAGE}));
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: if path == "tab" {
                    RouteKind::Tab
                } else {
                    RouteKind::Page
                },
                config: None,
                entry_module: format!("{path}.js"),
            });
        }
        for name in [
            "getCurrentPages",
            "wx.navigateTo",
            "wx.navigateBack",
            "wx.redirectTo",
            "wx.reLaunch",
            "wx.switchTab",
            "wx.onBeforeAppRoute",
            "wx.offBeforeAppRoute",
            "wx.onAppRoute",
            "wx.offAppRoute",
            "wx.rewriteRoute",
            "wx.onBeforePageUnload",
            "wx.offBeforePageUnload",
            "wx.onAfterPageUnload",
            "wx.offAfterPageUnload",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        for name in [
            "wx.onBeforeAppRoute",
            "wx.offBeforeAppRoute",
            "wx.onAppRoute",
            "wx.offAppRoute",
        ] {
            manifest.capabilities.insert(name.into(), support);
        }
        manifest
            .capabilities
            .insert("wx.rewriteRoute".into(), rewrite);
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
            initial_capabilities: Value::Null,
        };
        let initialized = fixture.ok(op::APP_INIT, json!({"modules":modules}));
        fixture.initial_capabilities = initialized["capabilities"].clone();
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("route-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let result = self.raw(operation, payload);
        assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
        assert!(
            !result
                .messages
                .iter()
                .any(|message| message.op == op::ERROR),
            "{result:?}"
        );
        result.messages[0].payload.clone()
    }
    fn call(&mut self, name: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":name,"args":args}),
        )["result"][0]["value"]
            .clone()
    }
    fn trace(&mut self) -> Vec<Value> {
        self.call("inspect", json!([])).as_array().unwrap().clone()
    }
    fn launch(&mut self) {
        self.ok(op::PAGE_PUSH, json!({"path":"home"}));
        self.call("clear", json!([]));
    }
}

#[test]
fn initial_native_push_rewrites_before_original_page_is_instantiated() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("target", json!(["/other?new=2", true]));
        f.ok(op::PAGE_PUSH, json!({"path":"home","query":{"original":1}}));
        let trace = f.trace();
        assert_eq!(trace[0]["phase"], "before");
        assert_eq!(trace[0]["event"]["openType"], "appLaunch");
        let loads: Vec<_> = trace
            .iter()
            .filter(|event| event["phase"] == "load")
            .collect();
        assert_eq!(loads.len(), 1);
        assert_eq!(loads[0]["path"], "other");
        assert_eq!(loads[0]["query"], json!({"original":"1"}));
        let after = trace
            .iter()
            .find(|event| event["phase"] == "after")
            .unwrap();
        assert_eq!(
            after["event"]["routeEventId"],
            trace[0]["event"]["routeEventId"]
        );
        assert_eq!(after["event"]["path"], "other");
        assert_eq!(after["event"]["timeStamp"], trace[0]["event"]["timeStamp"]);
    }
}

#[test]
fn missing_route_can_be_recovered_without_constructing_the_missing_page() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.call("target", json!(["/other", false]));
        f.call(
            "navigate",
            json!(["navigateTo",{"url":"/missing?from=old"}]),
        );
        let trace = f.trace();
        assert_eq!(trace[0]["event"]["notFound"], true);
        assert!(!trace.iter().any(|event| event["phase"] == "nav.fail"));
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "other"
        );
    }
}

#[test]
fn native_replace_uses_the_same_id_for_route_and_unload_notifications() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.ok(op::PAGE_REPLACE, json!({"path":"detail"}));
        let trace = f.trace();
        let id = trace[0]["event"]["routeEventId"].clone();
        for phase in ["unload.before", "unload.after"] {
            assert_eq!(
                trace.iter().find(|event| event["phase"] == phase).unwrap()["id"],
                id
            );
        }
        assert_eq!(trace.last().unwrap()["phase"], "after");
        assert_eq!(trace.last().unwrap()["event"]["routeEventId"], id);
    }
}

#[test]
fn deferred_layout_request_is_built_for_the_chosen_target() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.session.set_deferred_navigation_enabled(true).unwrap();
        f.call("target", json!(["/other", false]));
        f.call("navigate", json!(["navigateTo",{"url":"/detail"}]));
        let pending = f.session.pending_navigation().unwrap();
        assert_eq!(pending.target_route, "other");
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "home"
        );
        let trace = f.trace();
        assert_eq!(
            trace
                .iter()
                .filter(|event| event["phase"] == "before")
                .count(),
            1
        );
        assert!(!trace
            .iter()
            .any(|event| event["phase"] == "load" || event["phase"] == "after"));
    }
}

#[test]
fn promise_jobs_cannot_rewrite_the_route_after_the_before_lease_closes() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.call("late", json!([]));
        f.call("navigate", json!(["navigateTo",{"url":"/detail"}]));
        let trace = f.trace();
        assert!(trace.iter().any(|event| event["phase"] == "late.fail"));
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "detail"
        );
    }
}

#[test]
fn native_bridge_keeps_tab_targets_and_uses_one_pop_even_with_delta() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.ok(op::PAGE_PUSH, json!({"path":"tab","query":{"native":7}}));
        f.ok(op::PAGE_PUSH, json!({"path":"detail"}));
        f.call("clear", json!([]));
        f.ok(op::PAGE_POP, json!({"delta":99}));
        assert_eq!(f.session.app_service().pages().len(), 2);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "tab"
        );
        let trace = f.trace();
        assert_eq!(trace[0]["event"]["path"], "tab");
        assert_eq!(trace.last().unwrap()["event"]["path"], "tab");
        f.ok(op::PAGE_POP, json!({}));
        f.call("clear", json!([]));
        f.ok(op::PAGE_POP, json!({}));
        assert!(f.session.app_service().pages().is_empty());
        let trace = f.trace();
        assert!(!trace
            .iter()
            .any(|event| event["phase"] == "before" || event["phase"] == "after"));
        assert!(trace.iter().any(|event| event["phase"] == "unload.after"));
    }
}

#[test]
fn expired_cancelled_and_invalid_route_kind_requests_never_enter_before_listener() {
    for engine in engines() {
        for deferred in [false, true] {
            let mut f = Fixture::new(engine);
            f.launch();
            f.session.set_deferred_navigation_enabled(deferred).unwrap();
            f.call(
                "navigate",
                json!(["navigateTo",{"url":"/detail","deadlineNs":1}]),
            );
            f.ok(op::CANCEL, json!({"cancelToken":"route-cancelled"}));
            f.call(
                "navigate",
                json!(["navigateTo",{"url":"/detail","cancelToken":"route-cancelled"}]),
            );
            f.call("navigate", json!(["navigateTo",{"url":"/tab"}]));
            let trace = f.trace();
            assert!(!trace.iter().any(|event| event["phase"] == "before"));
            assert_eq!(
                trace
                    .iter()
                    .filter(|event| event["phase"] == "nav.fail")
                    .count(),
                3
            );
            assert_eq!(
                f.session.app_service().pages().current().unwrap().path,
                "home"
            );
            assert!(f.session.pending_navigation().is_none());
        }
    }
}

#[test]
fn guest_global_page_hook_alias_cannot_suppress_retained_unload() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.launch();
        f.call("breakUnload", json!([]));
        f.ok(op::PAGE_REPLACE, json!({"path":"detail"}));
        f.call("restoreUnload", json!([]));
        let trace = f.trace();
        assert_eq!(
            trace
                .iter()
                .filter(|e| e["phase"] == "unload.before")
                .count(),
            1
        );
        assert_eq!(trace.iter().filter(|e| e["phase"] == "unload").count(), 1);
        assert_eq!(
            trace
                .iter()
                .filter(|e| e["phase"] == "unload.after")
                .count(),
            1
        );
        assert_eq!(trace.iter().filter(|e| e["phase"] == "after").count(), 1);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "detail"
        );
    }
}

#[test]
fn accepted_root_back_intent_keeps_page_identity_and_emits_no_new_load() {
    // This locks container behavior; official no-op intent notifications still
    // require the fixed device oracle before claiming parity.
    for engine in engines() {
        for deferred in [false, true] {
            let mut f = Fixture::new(engine);
            f.launch();
            let id = f.session.app_service().pages().current().unwrap().id;
            f.session.set_deferred_navigation_enabled(deferred).unwrap();
            f.call("navigate", json!(["navigateBack", {}]));
            assert_eq!(f.session.app_service().pages().len(), 1);
            assert_eq!(f.session.app_service().pages().current().unwrap().id, id);
            let trace = f.trace();
            assert_eq!(trace.iter().filter(|e| e["phase"] == "before").count(), 1);
            assert!(!trace
                .iter()
                .any(|e| e["phase"] == "load" || e["phase"] == "unload"));
            assert_eq!(
                trace.iter().filter(|e| e["phase"] == "after").count(),
                usize::from(!deferred)
            );
            if !deferred {
                let before = trace.iter().find(|e| e["phase"] == "before").unwrap();
                let after = trace.iter().find(|e| e["phase"] == "after").unwrap();
                assert_eq!(
                    before["event"]["routeEventId"],
                    after["event"]["routeEventId"]
                );
            }
        }
    }
}

#[test]
fn session_caps_producers_preserves_cleanup_grade_and_rejects_unsupported_rewrite() {
    for engine in engines() {
        let full =
            Fixture::with_route_support(engine, CapabilitySupport::Full, CapabilitySupport::Full);
        for name in [
            "wx.onBeforeAppRoute",
            "wx.offBeforeAppRoute",
            "wx.onAppRoute",
            "wx.offAppRoute",
            "wx.rewriteRoute",
        ] {
            let expected = if matches!(name, "wx.offBeforeAppRoute" | "wx.offAppRoute") {
                "full"
            } else {
                "partial"
            };
            assert_eq!(full.initial_capabilities[name], expected);
        }
        let mut denied = Fixture::with_route_support(
            engine,
            CapabilitySupport::Partial,
            CapabilitySupport::Unsupported,
        );
        denied.launch();
        denied.call("target", json!(["/other", false]));
        denied.ok(op::PAGE_PUSH, json!({"path":"detail"}));
        assert_eq!(
            denied.session.app_service().pages().current().unwrap().path,
            "detail"
        );
        let trace = denied.trace();
        let failure = trace.iter().find(|e| e["phase"] == "rewrite.fail").unwrap();
        assert_eq!(failure["result"]["code"], "ERR_UNSUPPORTED_CAPABILITY");
        assert_eq!(trace.iter().filter(|e| e["phase"] == "after").count(), 1);
    }
}
