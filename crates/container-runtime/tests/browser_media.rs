//! DOM media subscriptions use real JS engines and host logical dimensions.
//! The protocol peer is local; this is not actual browser or DevTools evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, RendererProfile, RendererProfiles, Route, RouteKind, Template,
    RENDERING_MANIFEST_SCHEMA_VERSION,
};
use container_render_skia::Renderer;
use container_runtime::{
    HostDeviceOrientation, HostDisplayMetrics, HostMetadata, HostWindowMetrics, Session,
    SessionConfig,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const HOME: &str = "pages/home/index";
const OTHER: &str = "pages/other/index";
const SKIA: &str = "pages/skia/index";
const APP: &str = "module:app.js";
const HOME_TEMPLATE: &str = "template:pages/home/index.wxml";
const SKIA_TEMPLATE: &str = "template:pages/skia/index.wxml";

const APP_JS: &str = r#"
App({trace:[],observers:{},capabilities:[]});
function current() { const pages=getCurrentPages(); return pages[pages.length-1]; }
function observe(owner,label,descriptor,disconnect) {
  const observer=owner ? owner.createMediaQueryObserver() : wx.createMediaQueryObserver();
  getApp().observers[label]=observer;
  observer.observe(descriptor,function(result) {
    'use strict';
    getApp().trace.push({label:label,result:result,unbound:this===undefined});
  });
  if (disconnect) observer.disconnect();
}
exports.media=function(label,descriptor,explicit,disconnect) {
  observe(explicit ? current() : null,label,descriptor,disconnect);
};
exports.componentMedia=function(label,descriptor) {
  current().selectComponent('#panel').observeMedia(label,descriptor);
};
exports.intersection=function(label) {
  const observer=wx.createIntersectionObserver(current(),{thresholds:[0.5]}).relativeToViewport();
  getApp().observers[label]=observer;
  observer.observe('#stale',function(result) {
    getApp().trace.push({label:label,result:result});
  });
};
exports.disconnect=function(label) { getApp().observers[label].disconnect(); };
exports.patch=function(data) { current().setData(data); };
exports.inspect=function() { return {trace:getApp().trace.slice(),capabilities:getApp().capabilities.slice()}; };
exports.clear=function() { getApp().trace=[]; };
exports.repeatMedia=function() {
  const observer=current().createMediaQueryObserver();
  getApp().observers.repeated=observer;
  const returns=[];
  ['first','second'].forEach(function(label) {
    returns.push(observer.observe({minWidth:150},function(result) {
      'use strict';
      getApp().trace.push({label:label,result:result,unbound:this===undefined});
    })===undefined);
  });
  return {returns:returns};
};
exports.invalidMedia=function() {
  const observer=current().createMediaQueryObserver();
  const descriptors=[null,[],true,1,'width',
    {width:-1},{height:Infinity},{minWidth:NaN},{maxWidth:'100'},
    {minHeight:null},{maxHeight:-1},{orientation:'square'}];
  const rejected=descriptors.map(function(descriptor) {
    try { observer.observe(descriptor,function() {}); return null; }
    catch (error) { return error.code; }
  });
  try { observer.observe({},null); rejected.push(null); }
  catch (error) { rejected.push(error.code); }
  const result=observer.disconnect()===undefined;
  try { observer.observe({},function() {}); rejected.push(null); }
  catch (error) { rejected.push(error.code); }
  return {rejected:rejected,disconnectReturnsVoid:result};
};
exports.privateMediaOwner=function() {
  const page=current();
  getApp().heldPage=page;
  const keys=['__container_page_id','__container_instance_id','scopeId','__scopeId','__container_scope_id'];
  const descriptors=keys.map(function(key) { return Object.getOwnPropertyDescriptor(page,key); });
  keys.forEach(function(key) {
    Object.defineProperty(page,key,{configurable:true,get:function() { throw new Error('public owner alias read: '+key); }});
  });
  const observer=page.createMediaQueryObserver();
  observer.observe({width:100},function(result) {
    'use strict';
    getApp().trace.push({label:'private-owner',result:result,unbound:this===undefined});
  });
  // Restore compatibility properties before the host's normal page mirror.
  keys.forEach(function(key,index) {
    if (descriptors[index]) Object.defineProperty(page,key,descriptors[index]);
    else delete page[key];
  });
  return true;
};
exports.descriptorBoundary=function() {
  const observer=current().createMediaQueryObserver();
  getApp().observers.boundary=observer;
  let serialized=0;
  const cyclic={width:100};cyclic.unknown=cyclic;
  const descriptors=[
    {width:100,toJSON:function() { serialized++;return null; }},
    {width:100,toJSON:function() { serialized++;throw new Error('must not serialize'); }},
    cyclic
  ];
  descriptors.forEach(function(descriptor,index) {
    observer.observe(descriptor,function(result) {
      'use strict';getApp().trace.push({label:'projection-'+index,result:result,unbound:this===undefined});
    });
  });
  const throwing={};
  Object.defineProperty(throwing,'width',{enumerable:true,get:function() { throw new Error('field getter'); }});
  let getterError=null;
  try { observer.observe(throwing,function() { throw new Error('invalid subscription'); }); }
  catch(error) { getterError=error.code; }
  const closing=current().createMediaQueryObserver();
  const cancelled={};
  Object.defineProperty(cancelled,'width',{enumerable:true,get:function() { closing.disconnect();return 100; }});
  let cancellation=null;
  try { closing.observe(cancelled,function() { throw new Error('disconnected subscription'); }); }
  catch(error) { cancellation=error.code; }
  return {serialized:serialized,getterError:getterError,cancellation:cancellation};
};
exports.privateMediaTransport=function() {
  // Outside a Page hook, the global factory captures the host-published
  // current Page even if the compatibility stack alias has been replaced.
  globalThis.__container_current_page_instances=[];
  const observer=wx.createMediaQueryObserver();
  const descriptor={width:100};
  getApp().observers.privateTransport=observer;
  observer.observe(descriptor,function(result) {
    'use strict';getApp().trace.push({label:'private-transport',result:result,unbound:this===undefined});
  });
  descriptor.width=999;
  getApp().mediaNotifier=__container_notify_observers;
  globalThis.__container_observers=Object.create(null);
  globalThis.__container_observer_id=999;
  globalThis.__container_observer_subscription_id=999;
  globalThis.__container_notify_observers=function() { throw new Error('public observer notifier'); };
  __container_events.length=0;
};
exports.restoreMediaTransport=function() { globalThis.__container_notify_observers=getApp().mediaNotifier; };
exports.serializationMedia=function() {
  const descriptor={width:100};
  observe(current(),'serialized-owner',descriptor,false);
  descriptor.width=999;
  getApp().mediaProbe={toJSON:function() { throw new Error('media public effect serialization'); }};
  __container_events.push(getApp().mediaProbe);
};
exports.repairMediaSerialization=function() { delete getApp().mediaProbe.toJSON; };
exports.callbackMedia=function() {
  const observer=current().createMediaQueryObserver();
  observer.observe({},function(result) {
    'use strict';getApp().trace.push({label:'first',result:result,unbound:this===undefined});
    observer.disconnect();throw new Error('media callback error');
  });
  observer.observe({},function() { throw new Error('revoked sibling called'); });
  observe(current(),'other',{},false);
};
exports.terminalMedia=function() {
  const observer=current().createMediaQueryObserver();getApp().observers.terminal=observer;
  observer.observe({},function(result) {
    'use strict';getApp().trace.push({label:'terminal',result:result,unbound:this===undefined});
  });
};
exports.holdMediaOwner=function() { getApp().heldPage=current(); };
exports.forgedMediaOwner=function() {
  const page=current();
  const fake={__container_page_id:page.__container_page_id,__container_instance_id:page.__container_instance_id};
  try { page.createMediaQueryObserver.call(fake); return null; }
  catch (error) { return error.code; }
};
exports.retiredMediaOwner=function() {
  const page=getApp().heldPage;
  page.__container_disposed=false;
  page.__container_detached_lifecycle=false;
  page.__container_page_id=current().__container_page_id;
  try { page.createMediaQueryObserver(); return null; }
  catch (error) { return error.code; }
};
"#;

const HOME_JS: &str = r#"
Page({data:{visible:true},onLoad:function(options) {
  getApp().capabilities.push({
    media:wx.canIUse('createMediaQueryObserver'),
    selector:wx.canIUse('createSelectorQuery'),
    intersection:wx.canIUse('createIntersectionObserver'),
    scroll:wx.canIUse('pageScrollTo')
  });
  if (options.autoMedia==='true') {
    const observer=wx.createMediaQueryObserver();
    getApp().observers['on-load']=observer;
    observer.observe({minWidth:150,orientation:'landscape'},function(result) {
      'use strict';
      getApp().trace.push({label:'on-load',result:result,unbound:this===undefined});
    });
  }
}});
"#;

const PANEL_JS: &str = r#"
Component({methods:{observeMedia:function(label,descriptor) {
  const observer=this.createMediaQueryObserver();
  getApp().observers[label]=observer;
  observer.observe(descriptor,function(result) {
    'use strict';
    getApp().trace.push({label:label,result:result,unbound:this===undefined});
  });
}}});
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
    engine: EngineKind,
}

impl Fixture {
    fn new(engine: EngineKind, width: u32, height: u32, auto: bool) -> Self {
        Self::with_route(engine, width, height, HOME, auto)
    }

    fn with_route(engine: EngineKind, width: u32, height: u32, route: &str, auto: bool) -> Self {
        let mut manifest = ContainerManifestV1 {
            schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
            rendering: Some(RendererProfiles {
                default: RendererProfile::WebView,
                pages: BTreeMap::from([(SKIA.into(), RendererProfile::Skia)]),
                ..Default::default()
            }),
            ..Default::default()
        };
        manifest.compiler.commit = "dom-media-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = APP.into();
        for name in [
            "getCurrentPages",
            "wx.createMediaQueryObserver",
            "wx.createIntersectionObserver",
            "wx.createSelectorQuery",
            "wx.pageScrollTo",
            "Page.selectComponent",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        for route in [HOME, OTHER, SKIA] {
            manifest.routes.push(Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: Some(format!("{route}.json")),
                entry_module: format!("module:{route}.js"),
            });
        }
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP, APP_JS, ModuleScope::App),
            ("module:pages/home/index.js", HOME_JS, ModuleScope::Page),
            (
                "module:pages/other/index.js",
                "Page({});",
                ModuleScope::Page,
            ),
            ("module:pages/skia/index.js", "Page({});", ModuleScope::Page),
            (
                "module:components/panel/index.js",
                PANEL_JS,
                ModuleScope::Component,
            ),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"source":source}));
        }
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            (HOME_TEMPLATE, r#"<panel wx:if="{{visible}}" id="panel"/>"#),
            ("template:pages/other/index.wxml", "<view/>"),
            (
                SKIA_TEMPLATE,
                r#"<view id="stale" style="width:100px;height:100px"/>"#,
            ),
            ("template:components/panel/index.wxml", "<view/>"),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.components.push(Component {
            id: format!("components:{HOME}.json"),
            owner: format!("{HOME}.json"),
            using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
            multiple_slots: None,
        });
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    browser_view_enabled: true,
                    host: HostMetadata {
                        window_width: width,
                        window_height: height,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
            engine,
        };
        fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(
            op::PAGE_PUSH,
            json!({"path":route,"query":{"autoMedia":auto.to_string()}}),
        );
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("browser-media-{}", self.sequence),
            operation,
            payload,
        ))
    }

    fn assert_no_error(&self, batch: &BridgeBatch) {
        assert!(
            batch
                .messages
                .iter()
                .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
            "{:?}: {batch:?}",
            self.engine
        );
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let batch = self.dispatch(operation, payload);
        self.assert_no_error(&batch);
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload.clone()
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn inspect(&mut self) -> Value {
        self.call("inspect", json!([]))
    }

    fn trace(&mut self) -> Vec<Value> {
        self.inspect()["trace"].as_array().unwrap().clone()
    }

    fn clear(&mut self) {
        self.call("clear", json!([]));
    }

    fn poll(&mut self) -> BridgeBatch {
        let batch = self.session.poll_timers(0);
        self.assert_no_error(&batch);
        batch
    }

    fn resize(&mut self, width: u32, height: u32) {
        let batch = self.session.notify_viewport_resize(width, height).unwrap();
        self.assert_no_error(&batch);
    }

    fn metrics(&mut self, width: u32, height: u32, pixel_ratio: f64) {
        let batch = self
            .session
            .notify_window_metrics(HostWindowMetrics {
                window_width: width,
                window_height: height,
                display: HostDisplayMetrics {
                    pixel_ratio,
                    screen_width: 800,
                    screen_height: 1200,
                    status_bar_height: 0.0,
                    screen_top: 0.0,
                    safe_area: None,
                    host_layout: None,
                    device_orientation: HostDeviceOrientation::Portrait,
                },
            })
            .unwrap();
        self.assert_no_error(&batch);
    }

    fn prepare_dom(&mut self, width: u32, height: u32) {
        self.ok(
            op::VIEW_PREPARE,
            json!({
                "version":"1.0","surfaceGeneration":"1","render":{
                    "templateId":HOME_TEMPLATE,"useSessionResources":true,
                    "viewport":{"width":width,"height":height}
                }
            }),
        );
    }
}

fn assert_media(trace: &[Value], expected: &[(&str, bool)]) {
    let actual: Vec<_> = trace
        .iter()
        .map(|entry| {
            assert_eq!(entry["unbound"], true, "{entry}");
            (
                entry["label"].as_str().unwrap(),
                entry["result"]["matches"].as_bool().unwrap(),
            )
        })
        .collect();
    assert_eq!(actual, expected, "{trace:?}");
}

#[test]
fn dom_media_onload_registration_waits_for_poll_not_a_first_presentation() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, true);
        assert!(fixture.session.renderer().last_frame().is_none());
        assert!(fixture.session.view_document().is_none());
        let before = fixture.inspect();
        assert_eq!(
            before["capabilities"],
            json!([{
                "media":true,"selector":false,"intersection":false,"scroll":false
            }])
        );
        assert_eq!(
            before["trace"],
            json!([]),
            "registration is not a measurement"
        );
        let batch = fixture.poll();
        assert!(batch
            .messages
            .iter()
            .any(|message| message.payload["type"] == "observer.batch"));
        assert_media(&fixture.trace(), &[("on-load", false)]);
        fixture.poll();
        assert_media(&fixture.trace(), &[("on-load", false)]);
        assert!(fixture.session.renderer().last_frame().is_none());
        assert!(fixture.session.view_document().is_none());
    }
}

#[test]
fn dom_media_waits_for_two_positive_host_dimensions_even_when_a_document_is_prepared() {
    for engine in engines() {
        for (width, height) in [(0, 0), (0, 200), (200, 0)] {
            let mut fixture = Fixture::new(engine, width, height, true);
            fixture.poll();
            assert!(fixture.trace().is_empty());
            fixture.prepare_dom(300, 600);
            fixture.poll();
            assert!(
                fixture.trace().is_empty(),
                "render viewport is not host evidence"
            );
            fixture.resize(200, 100);
            assert_media(&fixture.trace(), &[("on-load", true)]);
            fixture.poll();
            assert_media(&fixture.trace(), &[("on-load", true)]);
        }
    }
}

#[test]
fn dom_media_reports_match_transitions_but_not_unchanged_resize_or_dpr_only_changes() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, true);
        fixture.poll();
        fixture.resize(200, 100);
        fixture.resize(200, 100);
        fixture.resize(180, 100);
        fixture.metrics(180, 100, 2.0);
        fixture.metrics(180, 100, 3.0);
        fixture.poll();
        assert_media(&fixture.trace(), &[("on-load", false), ("on-load", true)]);
        fixture.resize(100, 200);
        assert_media(
            &fixture.trace(),
            &[("on-load", false), ("on-load", true), ("on-load", false)],
        );
    }
}

#[test]
fn dom_media_disconnect_cancels_pending_and_future_notifications_without_affecting_siblings() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("media", json!(["cancelled",{"minWidth":150},false,true]));
        fixture.call("media", json!(["live",{"minWidth":150},false,false]));
        assert!(fixture.trace().is_empty());
        fixture.poll();
        fixture.resize(200, 100);
        assert_media(&fixture.trace(), &[("live", false), ("live", true)]);
        fixture.call("disconnect", json!(["live"]));
        fixture.call("disconnect", json!(["live"]));
        fixture.resize(100, 200);
        fixture.poll();
        assert_media(&fixture.trace(), &[("live", false), ("live", true)]);
    }
}

#[test]
fn dom_media_component_detach_and_page_unload_release_their_original_owners() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("componentMedia", json!(["component",{"minWidth":150}]));
        fixture.call("media", json!(["page",{"minWidth":150},true,false]));
        fixture.call("media", json!(["fallback",{"minWidth":150},false,false]));
        fixture.poll();
        let initial = fixture.trace();
        assert_eq!(initial.len(), 3, "{engine:?}: {initial:?}");
        assert!(initial
            .iter()
            .all(|entry| entry["result"]["matches"] == false));
        fixture.call("patch", json!([{"visible":false}]));
        fixture.prepare_dom(100, 200);
        fixture.clear();
        fixture.resize(200, 100);
        let mut trace = fixture.trace();
        trace.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
        assert_media(&trace, &[("fallback", true), ("page", true)]);
        fixture.ok(op::PAGE_REPLACE, json!({"path":OTHER}));
        fixture.clear();
        fixture.resize(100, 200);
        fixture.poll();
        assert!(
            fixture.trace().is_empty(),
            "unloaded observers survived: {engine:?}"
        );
    }
}

#[test]
fn dom_media_retains_the_existing_hidden_owner_policy_until_disposal() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("media", json!(["hidden-page",{"minWidth":150},true,false]));
        fixture.call(
            "componentMedia",
            json!(["hidden-component",{"minWidth":150}]),
        );
        fixture.poll();
        fixture.clear();
        fixture.ok(op::PAGE_PUSH, json!({"path":OTHER}));
        fixture.resize(200, 100);
        let mut trace = fixture.trace();
        trace.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
        assert_media(&trace, &[("hidden-component", true), ("hidden-page", true)]);
        fixture.ok(op::PAGE_POP, json!({}));
        fixture.clear();
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
        fixture.resize(100, 200);
        let mut trace = fixture.trace();
        trace.sort_by(|left, right| left["label"].as_str().cmp(&right["label"].as_str()));
        assert_media(
            &trace,
            &[("hidden-component", false), ("hidden-page", false)],
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
        fixture.poll();
        assert_eq!(
            fixture.trace().len(),
            2,
            "show must not duplicate a stable match"
        );
    }
}

#[test]
fn dom_media_cannot_borrow_a_retained_skia_frame_or_open_other_geometry_apis() {
    for engine in engines() {
        let mut fixture = Fixture::with_route(engine, 0, 0, SKIA, false);
        fixture.ok(
            op::RENDER_COMMIT,
            json!({
                "templateId":SKIA_TEMPLATE,"useSessionResources":true,
                "viewport":{"width":900,"height":800}
            }),
        );
        fixture.call("intersection", json!(["stale-intersection"]));
        fixture.ok(op::PAGE_PUSH, json!({"path":HOME}));
        fixture.call("media", json!(["dom",{"minWidth":500},false,false]));
        assert_eq!(
            fixture
                .session
                .renderer()
                .last_frame()
                .unwrap()
                .viewport
                .width,
            900.0
        );
        fixture.poll();
        assert!(
            fixture.trace().is_empty(),
            "retained Skia viewport leaked into DOM media"
        );
        fixture.resize(100, 200);
        assert_media(&fixture.trace(), &[("dom", false)]);
        fixture.poll();
        assert_media(&fixture.trace(), &[("dom", false)]);
        for name in [
            "wx.createSelectorQuery",
            "wx.createIntersectionObserver",
            "wx.pageScrollTo",
        ] {
            let result = fixture.dispatch(
                op::API_CALL,
                json!({
                    "name":name,"selector":"#stale","scrollTop":0,"duration":0,
                    "observerId":"untrusted","action":"observe","subscriptionId":"untrusted",
                    "descriptor":{"minWidth":1}
                }),
            );
            assert_eq!(
                result.messages[0].payload["ok"], false,
                "{engine:?} {name}: {result:?}"
            );
            assert_eq!(
                result.messages[0].payload["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{result:?}"
            );
        }
        assert_eq!(
            fixture
                .session
                .renderer()
                .last_frame()
                .unwrap()
                .viewport
                .width,
            900.0
        );
    }
}

#[test]
fn dom_media_covers_all_locked_dimensions_inclusively() {
    for engine in engines() {
        for (descriptor, initial, changed) in [
            (json!({"width":100}), true, false),
            (json!({"height":200}), true, false),
            (json!({"minWidth":100}), true, true),
            (json!({"maxWidth":100}), true, false),
            (json!({"minHeight":200}), true, false),
            (json!({"maxHeight":200}), true, true),
            (
                json!({"minWidth":100,"maxWidth":100,"minHeight":200,"maxHeight":200}),
                true,
                false,
            ),
            (json!({"minWidth":101,"maxWidth":99}), false, false),
            (json!({}), true, true),
        ] {
            let mut fixture = Fixture::new(engine, 100, 200, false);
            fixture.call("media", json!(["dimensions", descriptor, true, false]));
            assert!(fixture.trace().is_empty());
            fixture.poll();
            assert_media(&fixture.trace(), &[("dimensions", initial)]);
            fixture.resize(200, 100);
            let expected = if initial == changed {
                vec![("dimensions", initial)]
            } else {
                vec![("dimensions", initial), ("dimensions", changed)]
            };
            assert_media(&fixture.trace(), &expected);
        }
    }
}

#[test]
fn dom_media_square_page_is_portrait_and_transitions_are_asynchronous() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 100, false);
        fixture.call(
            "media",
            json!(["portrait",{"orientation":"portrait"},true,false]),
        );
        fixture.call(
            "media",
            json!(["landscape",{"orientation":"landscape"},true,false]),
        );
        assert!(fixture.trace().is_empty());
        fixture.poll();
        assert_media(
            &fixture.trace(),
            &[("portrait", true), ("landscape", false)],
        );
        fixture.clear();
        fixture.resize(101, 100);
        assert_media(
            &fixture.trace(),
            &[("portrait", false), ("landscape", true)],
        );
    }
}

#[test]
fn dom_media_repeated_observe_has_independent_callbacks_and_void_results() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        assert_eq!(
            fixture.call("repeatMedia", json!([]))["returns"],
            json!([true, true])
        );
        assert!(fixture.trace().is_empty());
        fixture.poll();
        assert_media(&fixture.trace(), &[("first", false), ("second", false)]);
        fixture.clear();
        fixture.resize(200, 100);
        assert_media(&fixture.trace(), &[("first", true), ("second", true)]);
        fixture.call("disconnect", json!(["repeated"]));
        fixture.clear();
        fixture.resize(100, 200);
        assert!(fixture.trace().is_empty());
    }
}

#[test]
fn dom_media_rejects_invalid_locked_parameters_and_observe_after_disconnect() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        let batch = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"invalidMedia","args":[]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        let result = &batch.messages[0].payload["result"][0];
        assert_eq!(result["disconnectReturnsVoid"], true);
        assert_eq!(result["rejected"], json!(vec!["ERR_INVALID_REQUEST"; 14]));
        fixture.poll();
        assert!(fixture.trace().is_empty());
    }
}

#[test]
fn dom_media_uses_private_owner_identity_and_cannot_revive_an_unloaded_page() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        assert_eq!(fixture.call("privateMediaOwner", json!([])), json!(true));
        fixture.poll();
        assert_media(&fixture.trace(), &[("private-owner", true)]);
        let forged = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"forgedMediaOwner","args":[]}),
        );
        assert_eq!(forged.messages[0].payload["ok"], true, "{forged:?}");
        assert_eq!(
            forged.messages[0].payload["result"][0],
            "ERR_INVALID_REQUEST"
        );
        fixture.call("holdMediaOwner", json!([]));
        fixture.ok(op::PAGE_REPLACE, json!({"path":OTHER}));
        let batch = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"retiredMediaOwner","args":[]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert_eq!(
            batch.messages[0].payload["result"][0],
            "ERR_INVALID_REQUEST"
        );
        fixture.clear();
        fixture.resize(200, 100);
        assert!(fixture.trace().is_empty());
    }
}

#[test]
fn dom_media_projects_locked_descriptor_fields_without_raw_object_fallback() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        let batch = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"descriptorBoundary","args":[]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert_eq!(
            batch.messages[0].payload["result"][0],
            json!({"serialized":0,"getterError":"ERR_INVALID_REQUEST","cancellation":"ERR_INVALID_REQUEST"})
        );
        assert!(fixture.trace().is_empty());
        fixture.poll();
        assert_media(
            &fixture.trace(),
            &[
                ("projection-0", true),
                ("projection-1", true),
                ("projection-2", true),
            ],
        );
        fixture.clear();
        fixture.resize(200, 100);
        assert_media(
            &fixture.trace(),
            &[
                ("projection-0", false),
                ("projection-1", false),
                ("projection-2", false),
            ],
        );
        fixture.call("disconnect", json!(["boundary"]));
        fixture.clear();
        fixture.resize(100, 200);
        fixture.poll();
        assert!(fixture.trace().is_empty());
    }
}

#[test]
fn dom_media_transport_ignores_public_registry_queue_and_notifier_mutation() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("privateMediaTransport", json!([]));
        fixture.poll();
        fixture.resize(200, 100);
        assert_media(
            &fixture.trace(),
            &[("private-transport", true), ("private-transport", false)],
        );
        fixture.call("disconnect", json!(["privateTransport"]));
        fixture.resize(100, 200);
        assert_media(
            &fixture.trace(),
            &[("private-transport", true), ("private-transport", false)],
        );
        fixture.call("restoreMediaTransport", json!([]));
    }
}

#[test]
fn dom_media_serialization_failure_preserves_original_descriptor_until_next_poll() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        let batch = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"serializationMedia","args":[]}),
        );
        assert!(
            batch.messages.iter().any(|message| message.op == op::ERROR),
            "{engine:?}: {batch:?}"
        );
        let repaired = fixture.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"repairMediaSerialization","args":[]}),
        );
        assert_eq!(repaired.messages[0].payload["ok"], true, "{repaired:?}");
        // Repair lets the exact pending public batch drain. Its original
        // serialization exception remains a queued diagnostic for this turn.
        let errors: Vec<_> = repaired
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .collect();
        assert_eq!(errors.len(), 1, "{repaired:?}");
        assert_eq!(errors[0].payload["errors"].as_array().unwrap().len(), 1);
        assert_eq!(
            errors[0].payload["errors"][0]["message"],
            "media public effect serialization"
        );
        assert!(fixture.trace().is_empty());
        fixture.poll();
        assert_media(&fixture.trace(), &[("serialized-owner", true)]);
        fixture.resize(200, 100);
        assert_media(
            &fixture.trace(),
            &[("serialized-owner", true), ("serialized-owner", false)],
        );
    }
}

#[test]
fn dom_media_callback_error_is_reported_and_disconnection_fences_queued_sibling() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("callbackMedia", json!([]));
        let batch = fixture.session.poll_timers(0);
        assert!(
            batch.messages.iter().any(|message| message.op == op::ERROR),
            "{engine:?}: {batch:?}"
        );
        assert_media(&fixture.trace(), &[("first", true), ("other", true)]);
        fixture.poll();
        assert_media(&fixture.trace(), &[("first", true), ("other", true)]);
    }
}

#[test]
fn dom_media_terminal_app_unload_retires_pending_subscription() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine, 100, 200, false);
        fixture.call("terminalMedia", json!([]));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        fixture.poll();
        assert!(fixture.trace().is_empty(), "{engine:?}");
    }
}
