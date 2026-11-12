//! Actual accepted host geometry feeds the private app-wide resize registry.
//! This source is prepared for both native engines; preparation does not run it.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
    RouteKind,
};
use container_runtime::{
    HostApiProvider, HostDeviceOrientation, HostDisplayMetrics, HostServicesConfig,
    HostWindowMetrics, ProviderContext, ProviderError, SandboxProvider, Session, SessionConfig,
    TrustedApplication,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;

const SESSION_ID: &str = "window-resize-listeners";
const MODULE: &str = "module:app.js";
const SOURCE: &str = r#"
App({trace:[],listeners:{}});
const on=wx.onWindowResize,off=wx.offWindowResize;
function listen(label,kind){
  const callback=function(event){
    const snapshot=wx.getWindowInfo();
    getApp().trace.push({label:label,size:event.size,snapshot:{windowWidth:snapshot.windowWidth,windowHeight:snapshot.windowHeight},
      keys:Object.keys(event),root:this===globalThis});
    if(kind==='throw')throw Error('window-resize-listener');
    if(kind==='nextTick')wx.nextTick(function(){getApp().trace.push('nextTick:'+label)});
  };
  getApp().listeners[label]=callback;on(callback);return callback;
}
Page({data:{},onLoad:function(){listen('page-registered','nextTick')},onResize:function(event){getApp().trace.push('page:'+event.size.windowWidth)}});
exports.listen=function(label,kind){const callback=listen(label,kind);on(callback);return true};
exports.remove=function(label){return (label===null?off():off(getApp().listeners[label]))===undefined};
exports.inspect=function(){return getApp().trace};
exports.clear=function(){getApp().trace=[]};
exports.policy=function(){return {
  on:wx.canIUse('onWindowResize'),off:wx.canIUse('offWindowResize'),
  caps:[__container_capabilities['wx.onWindowResize'],__container_capabilities['wx.offWindowResize']]
}};
exports.tryRemove=function(){try{off();return 'allowed'}catch(error){return error.code}};
exports.forge=function(){
  __container_capabilities['wx.onWindowResize']='full';
  __container_capabilities['wx.offWindowResize']='full';
  try{on(function(){getApp().trace.push('forged')});return 'allowed'}catch(error){return error.code}
};
exports.tryRetired=function(){try{on(function(){});return false}catch(error){return String(error.message).indexOf('retired')>=0}};
exports.tamper=function(){
  wx.onWindowResize=function(){};wx.offWindowResize=function(){throw Error('fake')};
  __container_app_listeners={windowResize:[function(){getApp().trace.push('forged')}]};
};
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
    value.compiler.commit = "window-resize-fixture".into();
    value.app.app_json = "app.json".into();
    value.app.entry_module = "app.js".into();
    value.modules.push(Module {
        id: MODULE.into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: Vec::new(),
    });
    value.routes.push(Route {
        id: "route:home".into(),
        path: "pages/home/index".into(),
        kind: RouteKind::Page,
        config: None,
        entry_module: "app.js".into(),
    });
    for name in ["wx.onWindowResize", "wx.offWindowResize"] {
        value
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    value
        .capabilities
        .insert("wx.getWindowInfo".into(), CapabilitySupport::Partial);
    value
        .capabilities
        .insert("wx.nextTick".into(), CapabilitySupport::Partial);
    value.refresh_integrity().unwrap();
    value
}

struct Fixture {
    session: Session,
    sequence: u64,
    initial: Value,
}

impl Fixture {
    fn new(engine: EngineKind, value: ContainerManifestV1, config: SessionConfig) -> Self {
        Self::new_with_host_services(engine, value, config, None)
    }

    fn new_with_host_services(
        engine: EngineKind,
        mut value: ContainerManifestV1,
        config: SessionConfig,
        host_services: Option<HostServicesConfig>,
    ) -> Self {
        value.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(value, SessionConfig { engine, ..config }).unwrap(),
            sequence: 0,
            initial: Value::Null,
        };
        if let Some(host_services) = host_services {
            fixture
                .session
                .configure_host_services(host_services)
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
            format!("window-resize-{}", self.sequence),
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

    fn resize(&mut self, width: u32, height: u32) -> BridgeBatch {
        let batch = self.session.notify_viewport_resize(width, height).unwrap();
        assert!(
            !batch.messages.iter().any(|message| message.op == op::ERROR),
            "{batch:?}"
        );
        batch
    }
}

fn config() -> SessionConfig {
    SessionConfig {
        session_id: SESSION_ID.into(),
        ..Default::default()
    }
}

fn observation(label: &str, width: u32, height: u32) -> Value {
    json!({"label":label,"size":{"windowWidth":width,"windowHeight":height},
        "snapshot":{"windowWidth":width,"windowHeight":height},"keys":["size"],"root":true})
}

#[test]
fn actual_geometry_refreshes_snapshots_before_app_listeners_without_a_current_page() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), config());
        assert_eq!(fixture.initial["wx.onWindowResize"], "full");
        assert_eq!(fixture.initial["wx.offWindowResize"], "full");
        fixture.call("listen", json!(["first"]));
        fixture.call("listen", json!(["second"]));
        fixture.resize(800, 400);
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([
                observation("first", 800, 400),
                observation("second", 800, 400)
            ])
        );
        assert!(fixture.resize(800, 400).messages.is_empty());
        assert!(fixture.session.notify_viewport_resize(0, 400).is_err());
        assert_eq!(
            fixture.call("inspect", json!([])).as_array().unwrap().len(),
            2
        );
        fixture.call("remove", json!(["first"]));
        fixture.resize(640, 480);
        assert_eq!(
            fixture.call("inspect", json!([]))[2],
            observation("second", 640, 480)
        );
        fixture.call("remove", json!([null]));
        fixture.resize(500, 300);
        assert_eq!(
            fixture.call("inspect", json!([])).as_array().unwrap().len(),
            3
        );
    }
}

#[test]
fn page_registered_listeners_survive_hide_pop_and_run_without_inheriting_the_old_page() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), config());
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/home/index"}));
        fixture.resize(800, 400);
        assert_eq!(fixture.call("inspect", json!([]))[0], "page:800");
        assert_eq!(
            fixture.call("inspect", json!([]))[1],
            observation("page-registered", 800, 400)
        );
        fixture.session.poll_timers(u64::MAX);
        fixture.call("clear", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.ok(op::PAGE_POP, json!({"delta":1}));
        fixture.resize(640, 480);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        fixture.session.poll_timers(u64::MAX);
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([
                observation("page-registered", 640, 480),
                "nextTick:page-registered"
            ])
        );
    }
}

#[test]
fn display_only_changes_do_not_fabricate_another_size_notification() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), config());
        fixture.call("listen", json!(["actual"]));
        fixture.resize(800, 400);
        fixture.call("clear", json!([]));
        let metrics = HostWindowMetrics {
            window_width: 800,
            window_height: 400,
            display: HostDisplayMetrics {
                pixel_ratio: 2.0,
                screen_width: 1024,
                screen_height: 768,
                status_bar_height: 20.0,
                screen_top: 0.0,
                safe_area: None,
                host_layout: None,
                device_orientation: HostDeviceOrientation::Landscape,
            },
        };
        fixture.session.notify_window_metrics(metrics).unwrap();
        assert_eq!(fixture.call("inspect", json!([])), json!([]));
    }
}

struct PolicyProvider {
    revoked: &'static str,
    fallback: SandboxProvider,
}

impl HostApiProvider for PolicyProvider {
    fn name(&self) -> &'static str {
        "window-resize-policy"
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
fn trusted_on_revocation_prunes_listeners_and_public_policy_forgery_cannot_restore_them() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), config());
        fixture.call("listen", json!(["old"]));
        fixture.session.set_provider(Box::new(PolicyProvider {
            revoked: "wx.onWindowResize",
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
        fixture.resize(800, 400);
        fixture
            .session
            .set_provider(Box::new(SandboxProvider::default()));
        fixture.resize(640, 480);
        assert_eq!(fixture.call("inspect", json!([])), json!([]));
    }
}

#[test]
fn manifest_host_and_provider_admission_preserve_each_methods_own_scope() {
    for engine in engines() {
        let mut value = manifest();
        value.capabilities.remove("wx.offWindowResize");
        let mut fixture = Fixture::new(engine, value, config());
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":true,"off":false,"caps":["full","unsupported"]})
        );
        fixture.call("listen", json!(["legacy"]));
        assert_eq!(
            fixture.call("tryRemove", json!([])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        fixture.resize(800, 400);
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([observation("legacy", 800, 400)])
        );

        let mut host = config();
        host.capabilities
            .insert("wx.onWindowResize".into(), CapabilitySupport::Partial);
        host.capabilities
            .insert("wx.offWindowResize".into(), CapabilitySupport::Full);
        let mut fixture = Fixture::new(engine, manifest(), host);
        assert_eq!(
            fixture.call("policy", json!([])),
            json!({"on":true,"off":true,"caps":["partial","full"]})
        );
        fixture.call("listen", json!(["kept"]));
        fixture.session.set_provider(Box::new(PolicyProvider {
            revoked: "wx.offWindowResize",
            fallback: SandboxProvider::default(),
        }));
        assert_eq!(
            fixture.call("tryRemove", json!([])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        fixture.resize(800, 400);
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([observation("kept", 800, 400)])
        );
    }
}

#[test]
fn host_configuration_and_guest_alias_mutation_never_replace_the_private_registry() {
    for engine in engines() {
        let value = manifest();
        let pack_root = value.integrity.root.clone();
        // A configured host supplies its own accepted display observation.
        let mut host = config();
        host.host.window_width = 640;
        host.host.window_height = 480;
        host.host.display_metrics = Some(HostDisplayMetrics {
            pixel_ratio: 2.0,
            screen_width: 1024,
            screen_height: 768,
            status_bar_height: 20.0,
            screen_top: 0.0,
            safe_area: None,
            host_layout: None,
            device_orientation: HostDeviceOrientation::Landscape,
        });
        let mut fixture = Fixture::new_with_host_services(
            engine,
            value,
            host,
            Some(HostServicesConfig {
                application: TrustedApplication {
                    host_app_id: "resize-host".into(),
                    tenant_id: "resize-tenant".into(),
                    publisher_id: "resize-publisher".into(),
                    app_id: "resize-app".into(),
                    environment: "develop".into(),
                    version: "fixture".into(),
                    pack_root,
                },
                apis: Vec::new(),
                ..Default::default()
            }),
        );
        fixture.call("listen", json!(["actual"]));
        fixture.call("tamper", json!([]));
        fixture.resize(800, 400);
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([observation("actual", 800, 400)])
        );
        assert_eq!(fixture.call("remove", json!(["actual"])), true);
        fixture.resize(640, 480);
        assert_eq!(
            fixture.call("inspect", json!([])).as_array().unwrap().len(),
            1
        );
    }
}

#[test]
fn terminal_unload_clears_registry_even_when_public_removal_is_denied() {
    for engine in engines() {
        let mut value = manifest();
        value.capabilities.remove("wx.offWindowResize");
        let mut fixture = Fixture::new(engine, value, config());
        fixture.call("listen", json!(["old"]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(fixture.call("tryRetired", json!([])), true);
        let _ = fixture.session.notify_viewport_resize(800, 400);
        assert_eq!(fixture.call("inspect", json!([])), json!([]));
    }
}

#[test]
fn one_throwing_listener_does_not_prevent_later_real_resize_delivery() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, manifest(), config());
        fixture.call("listen", json!(["throwing", "throw"]));
        fixture.call("listen", json!(["later"]));
        // JavaScript's existing error reporter captures the listener exception;
        // it does not turn a committed host geometry update into a rollback.
        let _ = fixture.session.notify_viewport_resize(800, 400).unwrap();
        assert_eq!(
            fixture.call("inspect", json!([])),
            json!([
                observation("throwing", 800, 400),
                observation("later", 800, 400)
            ])
        );
    }
}
