//! Public AppService lifecycle notification contracts on both native engines.
//! These deterministic Session tests do not establish browser or device acceptance.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    Route, RouteKind,
};
use container_runtime::{
    HostApiProvider, HostServicesConfig, ProviderContext, ProviderError, SandboxProvider, Session,
    SessionConfig, TrustedApplication,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const APP: &str = "module:app.js";
const SOURCE: &str = r#"
App({
  trace: [], held: [], listeners: {}, serial: 0, failHook: '',
  onLaunch(options) { this.trace.push({phase:'app.launch',options:options}); },
  onShow(options) {
    this.trace.push({phase:'app.show',options:options,args:arguments.length});
    if (this.failHook === 'show') throw Error('fixture App.onShow failure');
  },
  onHide(options) {
    this.trace.push({phase:'app.hide',options:options,args:arguments.length});
    if (this.failHook === 'hide') throw Error('fixture App.onHide failure');
  },
  onUnload() {
    this.trace.push({phase:'app.unload'});
    if (this.failHook === 'unload') throw Error('fixture App.onUnload failure');
  }
});
exports.inspect = function() { return getApp().trace.slice(); };
exports.clear = function() { getApp().trace = []; };
exports.failHook = function(value) { getApp().failHook = value; };
exports.listen = function(kind,label,throwing) {
  const app=getApp();
  const callback=function(options) {
    app.trace.push({phase:kind+'.'+label,options:options,args:arguments.length});
    if (throwing) throw Error('fixture '+kind+' listener failure');
  };
  app.listeners[label]=callback;
  return wx[kind === 'show' ? 'onAppShow' : 'onAppHide'](callback) === undefined;
};
exports.remove = function(kind,label) {
  const off=kind === 'show' ? 'offAppShow' : 'offAppHide';
  return (label === null ? wx[off]() : wx[off](getApp().listeners[label])) === undefined;
};
exports.mutatingShow = function() {
  const app=getApp();
  function later() { app.trace.push({phase:'show.later'}); }
  function removed() { app.trace.push({phase:'show.removed'}); }
  function first() {
    app.trace.push({phase:'show.first'});
    wx.offAppShow(first);
    wx.offAppShow(removed);
    wx.onAppShow(later);
  }
  wx.onAppShow(first); wx.onAppShow(removed); wx.onAppShow(first);
};
exports.installUnload = function() {
  const app=getApp();
  app.before=function(event) {
    const held=app.held.filter(function(page){return page === event.page;})[0];
    app.trace.push({phase:'before',path:event.path,routeEventId:event.routeEventId,
      actual:!!held,serial:held && held.fixtureSerial,
      setData:typeof event.page.setData,route:event.page.route});
  };
  app.after=function(event) {
    const current=getCurrentPages();
    app.trace.push({phase:'after',path:event.path,routeEventId:event.routeEventId,
      hasPage:Object.prototype.hasOwnProperty.call(event,'page'),
      currentSerials:current.map(function(page){return page.fixtureSerial;}),
      currentRoutes:current.map(function(page){return page.route;})});
  };
  return [wx.onBeforePageUnload(app.before) === undefined,
    wx.onAfterPageUnload(app.after) === undefined];
};
exports.removeUnload = function(all) {
  const app=getApp();
  return [
    (all ? wx.offBeforePageUnload() : wx.offBeforePageUnload(app.before)) === undefined,
    (all ? wx.offAfterPageUnload() : wx.offAfterPageUnload(app.after)) === undefined
  ];
};
exports.extraUnload = function() {
  wx.onBeforePageUnload(function(event) {
    getApp().trace.push({phase:'extra.before',path:event.path});
    throw Error('fixture before listener failure');
  });
  wx.onAfterPageUnload(function(event) {
    getApp().trace.push({phase:'extra.after',path:event.path});
    throw Error('fixture after listener failure');
  });
};
exports.navigate = function(method,options) {
  wx[method](options).catch(function(error) {
    getApp().trace.push({phase:'navigation.failure',code:error.code});
  });
};
exports.reentrantUnload = function() {
  wx.onAfterPageUnload(function callback(event) {
    wx.offAfterPageUnload(callback);
    getApp().trace.push({phase:'reentrant',routeEventId:event.routeEventId});
    wx.navigateTo({url:'/detail'}).catch(function(){});
  });
};
exports.failUnload = function(value) {
  const pages=getCurrentPages(); pages[pages.length-1].fixtureFailUnload=value !== false;
};
exports.pages = function() {
  return getCurrentPages().map(function(page){
    return {serial:page.fixtureSerial,route:page.route};
  });
};
exports.tamperUnloadReceiver = function() {
  const pages=getCurrentPages();
  const page=pages[pages.length-1];
  globalThis.__container_page_instances[page.__container_instance_id]={
    onUnload:function(){getApp().trace.push({phase:'fake.unload'});}
  };
  wx.onBeforePageUnload(function(event) {
    const id=event.page.__container_instance_id;
    globalThis.__container_page_instances[id]={
      onUnload:function(){getApp().trace.push({phase:'fake.unload'});}
    };
    globalThis.__container_invoke_page_instance=function(){
      getApp().trace.push({phase:'fake.invoke'});
    };
    event.page.__container_instance_id='forged';
    getApp().trace.push({phase:'tampered',actual:getApp().held.indexOf(event.page) >= 0});
  });
};
exports.notificationsRetired = function() {
  return ['onAppShow','onAppHide','onBeforePageUnload','onAfterPageUnload'].map(function(name) {
    try { wx[name](function(){}); return false; } catch (_) { return true; }
  });
};
const lifecycleMethods = {};
['AppShow','AppHide','BeforePageUnload','AfterPageUnload'].forEach(function(event) {
  lifecycleMethods['wx.on'+event]=wx['on'+event];
  lifecycleMethods['wx.off'+event]=wx['off'+event];
});
exports.methodPolicy = function(name) {
  return {can:wx.canIUse(name.slice(3)),support:__container_capabilities[name]};
};
exports.tryMethod = function(name,label) {
  try {
    const callback=function(event) {
      getApp().trace.push({phase:label,path:event.path,routeEventId:event.routeEventId,
        hasPage:Object.prototype.hasOwnProperty.call(event,'page')});
    };
    return lifecycleMethods[name](name.indexOf('wx.on')===0?callback:undefined)===undefined;
  } catch(error) { return error.code || String(error); }
};
exports.forgeMethod = function(name) {
  __container_capabilities[name]='full';
  try { lifecycleMethods[name](function(){getApp().trace.push({phase:'forged'})});return true; }
  catch(error) { return error.code || String(error); }
};
exports.tamperLifecycle = function() {
  Object.keys(lifecycleMethods).forEach(function(name){wx[name.slice(3)]=function(){throw Error('fake lifecycle method')}});
  __container_app_listeners={show:[function(){getApp().trace.push({phase:'fake'})}]};
};
// JsEngine treats a returned array as the result batch. Keep every fixture
// value inside one result so arrays and scalar returns use the same codec.
Object.keys(exports).forEach(function(name) {
  const callback=exports[name];
  exports[name]=function() { return {value:callback.apply(this,arguments)}; };
});
"#;

const PAGE: &str = r#"
Page({
  onLoad() {
    this.fixtureSerial=++getApp().serial;
    getApp().held.push(this);
    getApp().trace.push({phase:'page.load',serial:this.fixtureSerial,route:this.route});
  },
  onUnload() {
    getApp().trace.push({phase:'page.unload',serial:this.fixtureSerial,route:this.route});
    if (this.fixtureFailUnload) throw Error('fixture Page.onUnload failure');
  }
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

#[test]
fn invalid_direct_navigation_never_retires_or_notifies_the_live_page() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        let previous = fixture.call("pages", json!([]));
        for operation in [op::PAGE_REPLACE, op::PAGE_PUSH] {
            for payload in [
                json!({"path":" "}),
                json!({"path":"detail","query":[]}),
                json!({"path":"detail","data":false}),
            ] {
                let rejected = fixture.raw(operation, payload);
                assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
                assert_eq!(fixture.call("pages", json!([])), previous);
                assert!(fixture.trace().is_empty());
            }
        }
        fixture.ok(op::PAGE_POP, json!({}));
        let trace = fixture.trace();
        for phase in ["before", "page.unload", "after"] {
            assert_eq!(
                trace.iter().filter(|event| event["phase"] == phase).count(),
                1,
                "{trace:?}"
            );
        }
        assert_eq!(trace[0]["actual"], true);
    }
}

struct Fixture {
    session: Session,
    sequence: u64,
}

impl Fixture {
    fn new(engine: EngineKind, tabs: bool) -> Self {
        Self::with_policy(engine, tabs, &[], SessionConfig::default())
    }

    fn with_policy(
        engine: EngineKind,
        tabs: bool,
        policy: &[(&str, Option<CapabilitySupport>)],
        config: SessionConfig,
    ) -> Self {
        let mut manifest = ContainerManifestV1 {
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.compiler.commit = "lifecycle-notifications-local-contract".into();
        let mut modules = vec![json!({"id":APP,"source":SOURCE})];
        manifest.modules.push(Module {
            id: APP.into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        for path in ["home", "detail", "other"] {
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
                kind: if tabs && path != "detail" {
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
            "wx.onAppShow",
            "wx.offAppShow",
            "wx.onAppHide",
            "wx.offAppHide",
            "wx.onBeforePageUnload",
            "wx.offBeforePageUnload",
            "wx.onAfterPageUnload",
            "wx.offAfterPageUnload",
            "wx.navigateTo",
            "wx.navigateBack",
            "wx.redirectTo",
            "wx.reLaunch",
            "wx.switchTab",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        for (name, support) in policy {
            match support {
                Some(value) => {
                    manifest.capabilities.insert((*name).into(), *value);
                }
                None => {
                    manifest.capabilities.remove(*name);
                }
            }
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(manifest, SessionConfig { engine, ..config }).unwrap(),
            sequence: 0,
        };
        fixture.ok(op::APP_INIT, json!({"modules":modules}));
        fixture
    }

    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("lifecycle-notification-{}", self.sequence),
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
            json!({"moduleId":APP,"export":export,"args":args}),
        )["result"][0]["value"]
            .clone()
    }

    fn launch(&mut self) {
        self.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        self.ok(op::PAGE_PUSH, json!({"path":"home"}));
        self.call("clear", json!([]));
    }

    fn trace(&mut self) -> Vec<Value> {
        self.call("inspect", json!([])).as_array().unwrap().clone()
    }

    fn navigate(&mut self, method: &str, options: Value) {
        self.call("navigate", json!([method, options]));
    }
}

fn phases(trace: &[Value]) -> Vec<&str> {
    trace
        .iter()
        .map(|event| event["phase"].as_str().unwrap())
        .collect()
}

fn events<'a>(trace: &'a [Value], phase: &str) -> Vec<&'a Value> {
    trace
        .iter()
        .filter(|event| event["phase"] == phase)
        .collect()
}

#[test]
fn visibility_projects_options_and_duplicate_transitions_do_not_repeat() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        assert_eq!(fixture.call("listen", json!(["show", "a", false])), true);
        assert_eq!(fixture.call("listen", json!(["hide", "b", false])), true);
        fixture.launch();
        fixture.ok(
            op::APP_LIFECYCLE,
            json!({"event":"hide","options":{"reason":2}}),
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        let options = json!({"path":"home","query":{"from":"resume"},"scene":1001,
            "apiCategory":"default","forwardMaterials":[],"hostExtraData":{"value":7},
            "referrerInfo":{"appId":"source-app","extraData":{"x":1}},
            "chatType":1,"shareTicket":"resume-ticket"});
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show","options":options}));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        let trace = fixture.trace();
        assert_eq!(phases(&trace), ["app.hide", "hide.b", "app.show", "show.a"]);
        assert_eq!(trace[0]["options"], json!({"reason":2}));
        assert_eq!(trace[1]["options"], trace[0]["options"]);
        assert_eq!(trace[2]["options"], options);
        assert_eq!(trace[3]["options"], options);
        assert!(trace.iter().all(|event| event["args"] == 1));
    }
}

#[test]
fn visibility_listener_delivery_survives_app_hook_failure_once() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("listen", json!(["hide", "a", false]));
        fixture.call("listen", json!(["hide", "b", false]));
        fixture.call("failHook", json!(["hide"]));
        let failed = fixture.raw(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(failed
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        assert_eq!(phases(&fixture.trace()), ["app.hide", "hide.a", "hide.b"]);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_eq!(fixture.trace().len(), 3);
    }
}

#[test]
fn throwing_visibility_listener_does_not_suppress_later_listeners() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("listen", json!(["hide", "throwing", true]));
        fixture.call("listen", json!(["hide", "later", false]));
        let batch = fixture.raw(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(batch.messages.iter().any(|message| message.op == op::ERROR));
        assert_eq!(
            phases(&fixture.trace()),
            ["app.hide", "hide.throwing", "hide.later"]
        );
    }
}

#[test]
fn visibility_listener_snapshot_deduplicates_and_off_supports_identity_and_all() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("mutatingShow", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_eq!(
            phases(&fixture.trace()),
            ["app.show", "show.first", "show.removed"]
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_eq!(phases(&fixture.trace()), ["app.show", "show.later"]);
        assert_eq!(fixture.call("remove", json!(["show", null])), true);
        fixture.call("listen", json!(["hide", "kept", false]));
        fixture.call("listen", json!(["hide", "removed", false]));
        assert_eq!(fixture.call("remove", json!(["hide", "removed"])), true);
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_eq!(
            phases(&fixture.trace()),
            ["app.hide", "hide.kept", "app.show"]
        );
    }
}

#[test]
fn unloading_notifications_surround_the_actual_page_instance_and_its_hook() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        assert_eq!(
            fixture.call("installUnload", json!([])),
            json!([true, true])
        );
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        let trace = fixture.trace();
        assert_eq!(phases(&trace), ["before", "page.unload", "after"]);
        assert_eq!(trace[0]["path"], "detail");
        assert_eq!(trace[0]["route"], "detail");
        assert_eq!(trace[0]["actual"], true);
        assert_eq!(trace[0]["setData"], "function");
        assert_eq!(trace[0]["serial"], trace[1]["serial"]);
        assert_eq!(trace[2]["path"], "detail");
        assert_eq!(trace[2]["hasPage"], false);
        assert_eq!(trace[2]["currentSerials"], json!([1]));
        assert_eq!(trace[2]["currentRoutes"], json!(["home"]));
        assert!(!trace[0]["routeEventId"].as_str().unwrap().is_empty());
        assert_eq!(trace[0]["routeEventId"], trace[2]["routeEventId"]);
    }
}

#[test]
fn throwing_unload_hook_reports_error_and_still_retires_the_page_once() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("failUnload", json!([]));
        fixture.call("clear", json!([]));
        let completed = fixture.raw(op::PAGE_POP, json!({}));
        assert_eq!(completed.messages[0].payload["ok"], true, "{completed:?}");
        assert!(completed
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        let first = fixture.trace();
        assert_eq!(phases(&first), ["before", "page.unload", "after"]);
        assert_eq!(first[0]["serial"], first[1]["serial"]);
        assert_eq!(first[2]["routeEventId"], first[0]["routeEventId"]);
        assert_eq!(first[2]["currentSerials"], json!([1]));
        assert_eq!(first[2]["currentRoutes"], json!(["home"]));
        assert_eq!(
            fixture.call("pages", json!([])),
            json!([{"serial":1,"route":"home"}])
        );
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.ok(op::PAGE_POP, json!({}));
        let second = fixture.trace();
        assert_eq!(phases(&second), ["before", "page.unload", "after"]);
        assert_ne!(second[0]["serial"], first[0]["serial"]);
        assert_ne!(second[0]["routeEventId"], first[0]["routeEventId"]);
        assert_eq!(second[2]["routeEventId"], second[0]["routeEventId"]);
        assert_eq!(second[2]["currentSerials"], json!([1]));
        assert_eq!(second[2]["currentRoutes"], json!(["home"]));
    }
}

#[test]
fn before_listener_cannot_replace_the_page_receiver_used_by_unload() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("tamperUnloadReceiver", json!([]));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        let trace = fixture.trace();
        assert_eq!(
            phases(&trace),
            ["before", "tampered", "page.unload", "after"]
        );
        assert_eq!(trace[0]["actual"], true);
        assert_eq!(trace[1]["actual"], true);
        assert_eq!(trace[0]["serial"], trace[2]["serial"]);
        assert_eq!(trace[0]["routeEventId"], trace[3]["routeEventId"]);
        assert_eq!(trace[3]["currentSerials"], json!([1]));
        assert_eq!(trace[3]["currentRoutes"], json!(["home"]));
    }
}

#[test]
fn terminal_app_unload_releases_notifications_even_when_the_hook_throws() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("listen", json!(["hide", "kept", false]));
        fixture.call("installUnload", json!([]));
        fixture.call("failHook", json!(["unload"]));
        let unloaded = fixture.raw(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert!(unloaded
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        assert_eq!(phases(&fixture.trace()), ["app.unload"]);
        assert_eq!(
            fixture.call("notificationsRetired", json!([])),
            json!([true, true, true, true])
        );
    }
}

#[test]
fn one_route_event_owns_all_pages_destroyed_by_a_multi_page_back() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.navigate("navigateTo", json!({"url":"/other"}));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":2}));
        let first = fixture.trace();
        let before = events(&first, "before");
        assert_eq!(before.len(), 2, "{first:?}");
        assert_eq!(events(&first, "page.unload").len(), 2, "{first:?}");
        assert_eq!(events(&first, "after").len(), 2, "{first:?}");
        assert_ne!(before[0]["serial"], before[1]["serial"]);
        for event in &before {
            let before_index = first
                .iter()
                .position(|candidate| candidate == *event)
                .unwrap();
            let unload_index = first
                .iter()
                .position(|candidate| {
                    candidate["phase"] == "page.unload" && candidate["serial"] == event["serial"]
                })
                .unwrap();
            let after_index = first
                .iter()
                .position(|candidate| {
                    candidate["phase"] == "after" && candidate["path"] == event["path"]
                })
                .unwrap();
            assert!(
                before_index < unload_index && unload_index < after_index,
                "{first:?}"
            );
            assert!(!first[after_index]["currentSerials"]
                .as_array()
                .unwrap()
                .contains(&event["serial"]));
        }
        let id = before[0]["routeEventId"].clone();
        for event in first.iter().filter(|event| event["phase"] != "page.unload") {
            assert_eq!(event["routeEventId"], id);
        }
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        let second = fixture.trace();
        assert_ne!(events(&second, "before")[0]["routeEventId"], id);
    }
}

#[test]
fn cached_tabs_are_hidden_and_relaunch_destroys_each_live_instance_once() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, true);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        fixture.navigate("switchTab", json!({"url":"/other"}));
        assert!(events(&fixture.trace(), "before").is_empty());
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.navigate("reLaunch", json!({"url":"/home"}));
        let trace = fixture.trace();
        let before = events(&trace, "before");
        let after = events(&trace, "after");
        assert_eq!(before.len(), 3, "{engine:?}: {trace:?}");
        assert_eq!(after.len(), 3, "{engine:?}: {trace:?}");
        let mut paths = before
            .iter()
            .map(|event| event["path"].as_str().unwrap())
            .collect::<Vec<_>>();
        paths.sort_unstable();
        assert_eq!(paths, ["detail", "home", "other"]);
        let id = &before[0]["routeEventId"];
        assert!(before
            .iter()
            .chain(after.iter())
            .all(|event| &event["routeEventId"] == id));
        let mut serials = before
            .iter()
            .map(|event| event["serial"].as_u64().unwrap())
            .collect::<Vec<_>>();
        serials.sort_unstable();
        serials.dedup();
        assert_eq!(serials.len(), 3);
    }
}

#[test]
fn unload_off_removes_same_listener_or_all_and_listener_errors_are_isolated() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        assert_eq!(
            fixture.call("removeUnload", json!([false])),
            json!([true, true])
        );
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        assert_eq!(phases(&fixture.trace()), ["page.unload"]);
        fixture.call("extraUnload", json!([]));
        fixture.call("installUnload", json!([]));
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        // Reported callback errors must not abort teardown or other listeners.
        fixture.raw(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"navigate","args":["navigateBack",{"delta":1}]}),
        );
        assert_eq!(
            phases(&fixture.trace()),
            [
                "extra.before",
                "before",
                "page.unload",
                "extra.after",
                "after"
            ]
        );
        assert_eq!(
            fixture.call("removeUnload", json!([true])),
            json!([true, true])
        );
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        assert_eq!(phases(&fixture.trace()), ["page.unload"]);
    }
}

#[test]
fn reentrant_after_listener_starts_a_new_route_without_replaying_retirement() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("installUnload", json!([]));
        fixture.navigate("navigateTo", json!({"url":"/detail"}));
        fixture.call("reentrantUnload", json!([]));
        fixture.call("clear", json!([]));
        fixture.navigate("navigateBack", json!({"delta":1}));
        let trace = fixture.trace();
        assert_eq!(events(&trace, "before").len(), 1, "{trace:?}");
        assert_eq!(events(&trace, "after").len(), 1, "{trace:?}");
        assert_eq!(events(&trace, "page.unload").len(), 1, "{trace:?}");
        assert_eq!(events(&trace, "reentrant").len(), 1, "{trace:?}");
        assert_eq!(events(&trace, "page.load").len(), 1, "{trace:?}");
        assert_ne!(
            events(&trace, "before")[0]["serial"],
            events(&trace, "page.load")[0]["serial"]
        );
    }
}

const LIFECYCLE_METHODS: [&str; 8] = [
    "wx.onAppShow",
    "wx.offAppShow",
    "wx.onAppHide",
    "wx.offAppHide",
    "wx.onBeforePageUnload",
    "wx.offBeforePageUnload",
    "wx.onAfterPageUnload",
    "wx.offAfterPageUnload",
];

struct LifecyclePolicyProvider {
    overrides: BTreeMap<String, CapabilitySupport>,
    fallback: SandboxProvider,
}

impl HostApiProvider for LifecyclePolicyProvider {
    fn name(&self) -> &'static str {
        "lifecycle-policy-fixture"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut result = self.fallback.capabilities();
        result.extend(self.overrides.clone());
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

fn revoke(fixture: &mut Fixture, name: &str) {
    fixture
        .session
        .set_provider(Box::new(LifecyclePolicyProvider {
            overrides: BTreeMap::from([(name.into(), CapabilitySupport::Unsupported)]),
            fallback: SandboxProvider::default(),
        }));
}

fn fire_lifecycle(fixture: &mut Fixture, event: &str) {
    if event == "AppShow" {
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
    } else if event == "AppHide" {
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
    } else {
        fixture.ok(op::PAGE_POP, json!({}));
    }
}

#[test]
fn missing_own_lifecycle_declarations_cannot_be_granted_by_host_or_public_aliases() {
    for engine in engines() {
        for name in LIFECYCLE_METHODS {
            let mut config = SessionConfig::default();
            config
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
            let mut fixture = Fixture::with_policy(engine, false, &[(name, None)], config);
            assert_eq!(
                fixture.call("methodPolicy", json!([name])),
                json!({"can":false,"support":"unsupported"})
            );
            assert_eq!(
                fixture.call("tryMethod", json!([name, "forbidden"])),
                "ERR_UNSUPPORTED_CAPABILITY"
            );
            assert_eq!(
                fixture.call("forgeMethod", json!([name])),
                "ERR_UNSUPPORTED_CAPABILITY"
            );
        }
    }
}

#[test]
fn each_lifecycle_method_preserves_its_own_manifest_host_and_provider_grade() {
    for engine in engines() {
        let policy = LIFECYCLE_METHODS.map(|name| (name, Some(CapabilitySupport::Full)));
        let mut config = SessionConfig::default();
        for name in LIFECYCLE_METHODS
            .iter()
            .filter(|name| name.starts_with("wx.on"))
        {
            config
                .capabilities
                .insert((*name).into(), CapabilitySupport::Partial);
        }
        let mut fixture = Fixture::with_policy(engine, false, &policy, config);
        for name in LIFECYCLE_METHODS {
            assert_eq!(
                fixture.call("methodPolicy", json!([name])),
                json!({"can":true,
                "support":if name.starts_with("wx.on") {"partial"} else {"full"}})
            );
        }
        fixture
            .session
            .set_provider(Box::new(LifecyclePolicyProvider {
                overrides: LIFECYCLE_METHODS
                    .iter()
                    .filter(|name| name.starts_with("wx.off"))
                    .map(|name| ((*name).into(), CapabilitySupport::Partial))
                    .collect(),
                fallback: SandboxProvider::default(),
            }));
        for name in LIFECYCLE_METHODS {
            assert_eq!(
                fixture.call("methodPolicy", json!([name])),
                json!({"can":true,"support":"partial"})
            );
        }
    }
}

#[test]
fn own_off_denial_keeps_each_real_lifecycle_listener_and_own_on_withdrawal_prunes_it() {
    for engine in engines() {
        for event in ["AppShow", "AppHide", "BeforePageUnload", "AfterPageUnload"] {
            let on = format!("wx.on{event}");
            let off = format!("wx.off{event}");
            let mut fixture = Fixture::new(engine, false);
            fixture.launch();
            assert_eq!(fixture.call("tryMethod", json!([on, "kept"])), true);
            revoke(&mut fixture, &off);
            assert_eq!(
                fixture.call("tryMethod", json!([off, "unused"])),
                "ERR_UNSUPPORTED_CAPABILITY"
            );
            fire_lifecycle(&mut fixture, event);
            assert_eq!(
                events(&fixture.trace(), "kept").len(),
                1,
                "{engine:?}: {event}"
            );

            let mut fixture = Fixture::new(engine, false);
            fixture.launch();
            assert_eq!(fixture.call("tryMethod", json!([on, "stale"])), true);
            revoke(&mut fixture, &on);
            assert_eq!(
                fixture.call("forgeMethod", json!([on])),
                "ERR_UNSUPPORTED_CAPABILITY"
            );
            assert_eq!(fixture.call("tryMethod", json!([off, "unused"])), true);
            fixture
                .session
                .set_provider(Box::new(SandboxProvider::default()));
            fire_lifecycle(&mut fixture, event);
            assert!(
                events(&fixture.trace(), "stale").is_empty(),
                "{engine:?}: {event}"
            );
            assert!(
                events(&fixture.trace(), "forged").is_empty(),
                "{engine:?}: {event}"
            );
        }
    }
}

#[test]
fn unload_bookkeeping_survives_each_public_registration_being_denied() {
    for engine in engines() {
        for (denied, allowed, has_page) in [
            ("wx.onBeforePageUnload", "wx.onAfterPageUnload", false),
            ("wx.onAfterPageUnload", "wx.onBeforePageUnload", true),
        ] {
            let mut config = SessionConfig::default();
            config
                .capabilities
                .insert(denied.into(), CapabilitySupport::Unsupported);
            let mut fixture = Fixture::with_policy(engine, false, &[], config);
            fixture.launch();
            assert_eq!(fixture.call("tryMethod", json!([allowed, "allowed"])), true);
            fixture.ok(op::PAGE_POP, json!({}));
            let trace = fixture.trace();
            assert_eq!(events(&trace, "page.unload").len(), 1);
            let allowed = events(&trace, "allowed");
            assert_eq!(allowed.len(), 1, "{engine:?}: {trace:?}");
            assert_eq!(allowed[0]["path"], "home");
            assert_eq!(allowed[0]["hasPage"], has_page);
            assert!(!allowed[0]["routeEventId"].as_str().unwrap().is_empty());
            assert_eq!(fixture.call("pages", json!([])), json!([]));
        }
    }
}

#[test]
fn native_host_registration_rejects_each_runtime_lifecycle_method() {
    for engine in engines() {
        let fixture = Fixture::new(engine, false);
        let manifest = fixture.session.manifest().clone();
        for name in LIFECYCLE_METHODS {
            let mut session = Session::new(
                manifest.clone(),
                SessionConfig {
                    engine,
                    ..Default::default()
                },
            )
            .unwrap();
            let error = session
                .configure_host_services(HostServicesConfig {
                    application: TrustedApplication {
                        host_app_id: "lifecycle-host".into(),
                        tenant_id: "lifecycle-tenant".into(),
                        publisher_id: "lifecycle-publisher".into(),
                        app_id: "lifecycle-app".into(),
                        environment: "develop".into(),
                        version: "fixture".into(),
                        pack_root: manifest.integrity.root.clone(),
                    },
                    apis: vec![name.into()],
                    ..Default::default()
                })
                .unwrap_err();
            assert!(
                error.to_string().contains("owned by the runtime"),
                "{engine:?}: {name}: {error}"
            );
        }
    }
}

#[test]
fn guest_method_poisoning_preserves_the_retained_lifecycle_owner() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, false);
        fixture.launch();
        fixture.call("tryMethod", json!(["wx.onAppHide", "actual"]));
        fixture.call("tamperLifecycle", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_eq!(events(&fixture.trace(), "actual").len(), 1);
        assert!(events(&fixture.trace(), "fake").is_empty());
        assert_eq!(
            fixture.call("tryMethod", json!(["wx.offAppHide", "unused"])),
            true
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(events(&fixture.trace(), "actual").is_empty());
    }
}
