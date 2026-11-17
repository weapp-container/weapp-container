//! Observer subscriptions cross the real AppService/View boundary. Geometry
//! comes from accepted frames; these local contracts do not prove DevTools parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::{RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const HOME: &str = "pages/index/index";
const OTHER: &str = "pages/other/index";
const PAGE: &str = "template:pages/index/index.wxml";
const OTHER_PAGE: &str = "template:pages/other/index.wxml";
const APP_MODULE: &str = "module:app.js";

const APP_JS: &str = r#"
App({trace:[],observers:{},pages:[]});
function current() { const pages=getCurrentPages(); return pages[pages.length-1]; }
function record(label, result) { getApp().trace.push({label:label,result:result}); }
exports.intersection=function(label,options,selector,relative,margins,disconnect) {
  const observer=wx.createIntersectionObserver(current(),options || {});
  getApp().observers[label]=observer;
  if (relative) observer.relativeTo(relative,margins || {});
  else observer.relativeToViewport(margins || {});
  observer.observe(selector || '#target',function(result) { record(label,result); });
  if (disconnect) observer.disconnect();
};
exports.multipleRoots=function(label,options,roots) {
  const observer=wx.createIntersectionObserver(current(),options);
  getApp().observers[label]=observer;
  roots.forEach(function(root) {
    if (root.selector) observer.relativeTo(root.selector,root.margins || {});
    else observer.relativeToViewport(root.margins || {});
  });
  observer.observe('#target',function(result) { record(label,result); });
};
exports.media=function(label,descriptor,disconnect) {
  const observer=current().createMediaQueryObserver();
  getApp().observers[label]=observer;
  observer.observe(descriptor,function(result) { record(label,result); });
  if (disconnect) observer.disconnect();
};
exports.globalMedia=function(label,descriptor) {
  const observer=wx.createMediaQueryObserver();
  getApp().observers[label]=observer;
  observer.observe(descriptor,function(result) {
    'use strict';
    getApp().trace.push({label:label,result:result,unbound:this===undefined});
  });
};
exports.componentIntersection=function(panel,label,options) {
  current().selectComponent(panel).observeGeometry(label,options || {});
};
exports.componentMedia=function(panel,label,descriptor) {
  current().selectComponent(panel).observeMedia(label,descriptor);
};
exports.holdOwners=function() {
  getApp().heldPage=current();
  getApp().heldComponent=current().selectComponent('#left');
};
exports.lateIntersection=function(kind,label) {
  const owner=kind==='page' ? getApp().heldPage : getApp().heldComponent;
  const selector=kind==='page' ? '#target' : '#inside-one';
  try {
    const observer=wx.createIntersectionObserver(owner,{thresholds:[0.5]}).relativeToViewport();
    observer.observe(selector,function(result) { record(label,{unexpectedMeasurement:result}); });
    record(label,{unexpectedAcknowledgement:true});
  } catch (error) { record(label,{rejected:error}); }
};
exports.disconnect=function(label) { getApp().observers[label].disconnect(); };
exports.patch=function(data) { current().setData(data); };
exports.inspect=function() { return {trace:getApp().trace.slice()}; };
exports.clear=function() { getApp().trace=[]; };
"#;

const PAGE_JS: &str = r#"
Page({data:{offset:0,visible:true},onLoad:function() { getApp().pages.push(this); }});
"#;

const PANEL_JS: &str = r#"
Component({methods:{
  observeGeometry:function(label,options) {
    const observer=wx.createIntersectionObserver(this,options).relativeToViewport();
    getApp().observers[label]=observer;
    observer.observe('.scoped',function(result) { getApp().trace.push({label:label,result:result}); });
  },
  observeMedia:function(label,descriptor) {
    const observer=this.createMediaQueryObserver();
    getApp().observers[label]=observer;
    observer.observe(descriptor,function(result) { getApp().trace.push({label:label,result:result}); });
  }
}});
"#;

const PAGE_WXML: &str = r#"
<view id="relative" style="width:80px;height:100px">
  <view id="spacer" style="height:{{offset}}px"/>
  <view id="target" class="scoped" data-label="page-target" style="width:40px;height:40px"/>
</view>
<panel wx:if="{{visible}}" id="left"/>
<panel id="right"/>
"#;

const PANEL_WXML: &str = r#"
<view id="inside-one" class="scoped" data-label="one" style="width:20px;height:10px"/>
<view id="inside-two" class="scoped" data-label="two" style="width:20px;height:10px"/>
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
    blobs: BTreeMap<String, Vec<u8>>,
    sequence: u64,
    engine: EngineKind,
}

impl Fixture {
    fn new(engine: EngineKind) -> Self {
        Self::with_sources(engine, PAGE_WXML, PAGE_JS)
    }

    fn with_sources(engine: EngineKind, page_wxml: &str, page_js: &str) -> Self {
        Self::with_panel_sources(engine, page_wxml, page_js, PANEL_WXML, PANEL_JS)
    }

    fn with_panel_sources(
        engine: EngineKind,
        page_wxml: &str,
        page_js: &str,
        panel_wxml: &str,
        panel_js: &str,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "observer-geometry-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        for name in [
            "getCurrentPages",
            "wx.createIntersectionObserver",
            "wx.createMediaQueryObserver",
            "Page.selectComponent",
            "Component.triggerEvent",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        for route in [HOME, OTHER] {
            manifest.routes.push(Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: Some(format!("{route}.json")),
                entry_module: format!("{route}.js"),
            });
        }
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP_MODULE, APP_JS, ModuleScope::App),
            ("module:pages/index/index.js", page_js, ModuleScope::Page),
            ("module:pages/other/index.js", page_js, ModuleScope::Page),
            (
                "module:components/panel/index.js",
                panel_js,
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
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            (PAGE, page_wxml),
            (OTHER_PAGE, page_wxml),
            ("template:components/panel/index.wxml", panel_wxml),
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
        for route in [HOME, OTHER] {
            manifest.components.push(Component {
                id: format!("components:{route}.json"),
                owner: format!("{route}.json"),
                using_components: BTreeMap::from([(
                    "panel".into(),
                    "components/panel/index".into(),
                )]),
                multiple_slots: None,
            });
        }
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
            blobs,
            sequence: 0,
            engine,
        };
        fixture.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":HOME}));
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("observer-{}", self.sequence),
            operation,
            payload,
        ))
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let batch = self.dispatch(operation, payload);
        assert_eq!(
            batch.messages[0].payload["ok"], true,
            "{:?} {operation}: {batch:?}",
            self.engine
        );
        assert!(
            batch.messages.iter().all(|message| message.op != op::ERROR),
            "{:?} {operation}: {batch:?}",
            self.engine
        );
        batch.messages[0].payload.clone()
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn patch(&mut self, offset: f64) {
        self.call("patch", json!([{"offset":offset}]));
    }

    fn render(&mut self, width: u32, height: u32) {
        let template = if self.session.app_service().pages().current().unwrap().path == HOME {
            PAGE
        } else {
            OTHER_PAGE
        };
        self.ok(
            op::RENDER_COMMIT,
            json!({"templateId":template,"viewport":{"width":width,"height":height},"blobs":self.blobs}),
        );
    }

    fn trace(&mut self) -> Vec<Value> {
        self.call("inspect", json!([]))["trace"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn clear(&mut self) {
        self.call("clear", json!([]));
    }

    fn intersection(&mut self, label: &str, options: Value) {
        self.call("intersection", json!([label, options, "#target"]));
    }

    fn media(&mut self, label: &str, descriptor: Value) {
        self.call("media", json!([label, descriptor]));
    }

    fn tap(&mut self, class: &str) -> BridgeBatch {
        fn find<'a>(node: &'a RenderNode, class: &str) -> Option<&'a RenderNode> {
            if node.classes.iter().any(|value| value == class) {
                return Some(node);
            }
            node.children.iter().find_map(|child| find(child, class))
        }
        let frame = self.session.renderer().last_frame().unwrap();
        let node = find(&frame.root, class).expect("accepted component event target");
        let target = node.event_identity.as_ref().unwrap_or(&node.id).clone();
        let batch = self.dispatch(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","target":target}]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch
    }
}

// Deliberately use the global wx API. Explicit this.create... calls already
// identify their owner and would hide a missing event execution context.
const EVENT_OBSERVER_HELPER: &str = r#"
function observeOwner(label) {
  const observer=wx.createMediaQueryObserver();
  getApp().observers[label]=observer;
  observer.observe({minWidth:150},function(result) {
    'use strict';
    getApp().trace.push({label:label,result:result,unbound:this===undefined});
  });
}
"#;

fn assert_owner_notifications(trace: &[Value], expected: &[&str], matches: bool) {
    let mut labels: Vec<_> = trace
        .iter()
        .map(|entry| entry["label"].as_str().unwrap())
        .collect();
    labels.sort_unstable();
    let mut expected = expected.to_vec();
    expected.sort_unstable();
    assert_eq!(labels, expected, "{trace:?}");
    for entry in trace {
        assert_eq!(entry["result"]["matches"], matches, "{entry:?}");
        assert_eq!(
            entry["unbound"], true,
            "callback receiver changed: {entry:?}"
        );
    }
}

#[test]
fn native_component_event_observers_detach_with_the_receiver_without_rebinding_callbacks() {
    const WXML: &str = r#"
      <view class="page-tap" bindtap="start" style="height:20px"/>
      <panel wx:if="{{visible}}" id="left" label="left"/>
      <panel id="right" label="right"/>
    "#;
    let page = format!(
        "{EVENT_OBSERVER_HELPER}\nPage({{data:{{visible:true}},start:function() {{observeOwner('page');}}}});"
    );
    let panel = format!(
        "{EVENT_OBSERVER_HELPER}\nComponent({{properties:{{label:{{type:String,value:''}}}},methods:{{start:function() {{observeOwner(this.properties.label);}}}}}});"
    );
    for engine in engines() {
        let mut fixture = Fixture::with_panel_sources(
            engine,
            WXML,
            &page,
            r#"<view class="{{label}}-tap" bindtap="start" style="height:20px"/>"#,
            &panel,
        );
        fixture.render(100, 200);
        for target in ["left-tap", "right-tap", "page-tap"] {
            let batch = fixture.tap(target);
            assert!(
                batch.messages.iter().all(|message| message.op != op::ERROR),
                "{engine:?}: {batch:?}"
            );
        }
        fixture.render(100, 200);
        assert_owner_notifications(&fixture.trace(), &["left", "right", "page"], false);

        fixture.call("patch", json!([{"visible":false}]));
        fixture.render(100, 200);
        fixture.clear();
        fixture.session.notify_viewport_resize(200, 200).unwrap();
        assert_owner_notifications(&fixture.trace(), &["right", "page"], true);

        fixture.ok(op::PAGE_REPLACE, json!({"path":OTHER}));
        fixture.clear();
        fixture.session.notify_viewport_resize(100, 200).unwrap();
        assert!(
            fixture.trace().is_empty(),
            "unloaded observers survived: {engine:?}"
        );
    }
}

#[test]
fn nested_throwing_custom_event_restores_outer_and_unowned_observer_contexts() {
    const WXML: &str = r#"
      <panel wx:if="{{visible}}" id="left" bind:probe="probe"/>
    "#;
    let page = format!(
        "{EVENT_OBSERVER_HELPER}\nPage({{data:{{visible:true}},probe:function() {{observeOwner('nested-page');throw new Error('observer-owner-nested-listener');}}}});"
    );
    let panel = format!(
        "{EVENT_OBSERVER_HELPER}\nComponent({{methods:{{start:function() {{observeOwner('outer-before');this.triggerEvent('probe',{{}});observeOwner('outer-after');}}}}}});"
    );
    for engine in engines() {
        let mut fixture = Fixture::with_panel_sources(
            engine,
            WXML,
            &page,
            r#"<view class="nested-tap" bindtap="start" style="height:20px"/>"#,
            &panel,
        );
        fixture.render(100, 200);
        let batch = fixture.tap("nested-tap");
        assert!(
            batch.messages.iter().any(|message| {
                message.op == op::ERROR
                    && message
                        .payload
                        .to_string()
                        .contains("observer-owner-nested-listener")
            }),
            "expected nested handler diagnostic: {engine:?}: {batch:?}"
        );
        // This module call happens after the entire event turn, with no
        // explicit owner. A leaked outer context would tie it to the panel.
        fixture.call("globalMedia", json!(["outside-page",{"minWidth":150}]));
        fixture.render(100, 200);
        assert_owner_notifications(
            &fixture.trace(),
            &["outer-before", "nested-page", "outer-after", "outside-page"],
            false,
        );

        fixture.call("patch", json!([{"visible":false}]));
        fixture.render(100, 200);
        fixture.clear();
        fixture.session.notify_viewport_resize(200, 200).unwrap();
        assert_owner_notifications(&fixture.trace(), &["nested-page", "outside-page"], true);
    }
}

fn ratios(trace: &[Value]) -> Vec<f64> {
    trace
        .iter()
        .map(|entry| {
            entry["result"]["intersectionRatio"]
                .as_f64()
                .unwrap_or_else(|| panic!("expected an intersection measurement: {entry}"))
        })
        .collect()
}

fn assert_ratios(trace: &[Value], expected: &[f64]) {
    let actual = ratios(trace);
    assert_eq!(actual.len(), expected.len(), "{trace:?}");
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!(
            (actual - expected).abs() < 0.000001,
            "expected {expected}, got {actual}: {trace:?}"
        );
    }
}

fn matches(trace: &[Value]) -> Vec<bool> {
    trace
        .iter()
        .map(|entry| {
            entry["result"]["matches"]
                .as_bool()
                .unwrap_or_else(|| panic!("expected a media-query measurement: {entry}"))
        })
        .collect()
}

#[test]
fn intersection_uses_accepted_geometry_and_threshold_crossings() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.intersection("target", json!({"thresholds":[0.5]}));
        assert!(
            fixture.trace().is_empty(),
            "registration is not a measurement"
        );
        fixture.render(100, 100);
        let trace = fixture.trace();
        assert_ratios(&trace, &[1.0]);
        let result = &trace[0]["result"];
        assert_eq!(result["id"], "target");
        assert_eq!(result["dataset"]["label"], "page-target");
        assert_eq!(result["boundingClientRect"]["left"], 0.0);
        assert_eq!(result["boundingClientRect"]["top"], 0.0);
        assert_eq!(result["boundingClientRect"]["width"], 40.0);
        assert_eq!(result["boundingClientRect"]["height"], 40.0);
        assert_eq!(result["intersectionRect"]["width"], 40.0);
        assert_eq!(result["relativeRect"]["height"], 100.0);
        assert!(result["time"].as_f64().is_some());
        fixture.render(100, 100);
        fixture.patch(68.0); // 80% visible: remains above the 0.5 threshold.
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0]);
        fixture.patch(84.0); // 40% visible: crosses below the threshold.
        fixture.render(100, 100);
        fixture.patch(96.0); // 10% visible: no further crossing.
        fixture.render(100, 100);
        fixture.patch(76.0); // 60% visible: crosses above the threshold.
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0, 0.4, 0.6]);
    }
}

#[test]
fn initial_ratio_and_relative_margins_control_the_first_notification() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.intersection("unchanged", json!({"thresholds":[0.5],"initialRatio":1}));
        fixture.render(100, 100);
        assert!(fixture.trace().is_empty(), "{engine:?}");
        fixture.patch(100.0);
        fixture.call(
            "intersection",
            json!(["expanded",{"thresholds":[0.25]},"#target","#relative",{"bottom":20}]),
        );
        fixture.render(100, 100);
        let trace = fixture.trace();
        let expanded = trace
            .iter()
            .find(|entry| entry["label"] == "expanded")
            .unwrap();
        assert_eq!(expanded["result"]["intersectionRatio"], 0.5, "{engine:?}");
        assert_eq!(expanded["result"]["relativeRect"]["bottom"], 120.0);
        assert_eq!(expanded["result"]["boundingClientRect"]["top"], 100.0);
        assert_eq!(expanded["result"]["intersectionRect"]["height"], 20.0);
    }
}

#[test]
fn observe_all_is_component_local_and_component_detach_releases_subscriptions() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.render(200, 600);
        fixture.call(
            "componentIntersection",
            json!(["#left","left",{"observeAll":true,"thresholds":[0.5]}]),
        );
        fixture.call(
            "componentMedia",
            json!(["#left","left-media",{"minWidth":250}]),
        );
        assert!(fixture.trace().is_empty(), "{engine:?}");
        fixture.render(200, 600);
        let trace = fixture.trace();
        let intersections: Vec<_> = trace
            .iter()
            .filter(|entry| entry["label"] == "left")
            .collect();
        assert_eq!(intersections.len(), 2, "{engine:?}: {trace:?}");
        assert_eq!(intersections[0]["result"]["id"], "inside-one");
        assert_eq!(intersections[1]["result"]["id"], "inside-two");
        for entry in intersections {
            assert_eq!(entry["result"]["intersectionRatio"], 1.0);
        }
        let media = trace
            .iter()
            .find(|entry| entry["label"] == "left-media")
            .unwrap();
        assert_eq!(media["result"]["matches"], false);
        fixture.call("patch", json!([{"visible":false}]));
        fixture.render(200, 600);
        fixture.clear();
        fixture.session.notify_viewport_resize(300, 600).unwrap();
        fixture.render(300, 600);
        assert!(
            fixture.trace().is_empty(),
            "detached owner still notified: {engine:?}"
        );
    }
}

#[test]
fn disconnect_suppresses_queued_and_future_measurements_without_affecting_other_observers() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call(
            "intersection",
            json!(["cancelled", {}, "#target", null, {}, true]),
        );
        fixture.call("media", json!(["cancelled-media",{"minWidth":1},true]));
        fixture.intersection("live", json!({"thresholds":[0.5]}));
        fixture.render(100, 100);
        let trace = fixture.trace();
        assert_eq!(trace.len(), 1, "{engine:?}: {trace:?}");
        assert_eq!(trace[0]["label"], "live");
        fixture.call("disconnect", json!(["live"]));
        fixture.patch(90.0);
        fixture.render(100, 100);
        fixture.session.notify_viewport_resize(300, 200).unwrap();
        assert_eq!(fixture.trace().len(), 1, "{engine:?}");
    }
}

#[test]
fn failed_frame_cannot_advance_the_observed_ratio_or_replace_the_accepted_frame() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.intersection("target", json!({"thresholds":[0.5]}));
        fixture.render(100, 100);
        let accepted = fixture.session.renderer().last_frame().unwrap().clone();
        fixture.patch(90.0); // A 0.25 ratio would cross, but this frame is invalid.
        let rejected = fixture.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"viewport":{"width":-1,"height":100},"blobs":fixture.blobs}),
        );
        assert_eq!(rejected.messages[0].payload["ok"], false, "{engine:?}");
        assert_eq!(fixture.session.renderer().last_frame().unwrap(), &accepted);
        assert_ratios(&fixture.trace(), &[1.0]);
        fixture.patch(70.0); // 0.75 remains on the accepted frame's threshold side.
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0]);
        fixture.patch(90.0);
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0, 0.25]);
    }
}

#[test]
fn media_queries_follow_host_resize_once_per_match_transition() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.media("media", json!({"minWidth":150,"orientation":"landscape"}));
        assert!(fixture.trace().is_empty(), "{engine:?}");
        fixture.render(100, 200);
        assert_eq!(matches(&fixture.trace()), [false]);
        fixture.session.notify_viewport_resize(200, 100).unwrap();
        assert_eq!(matches(&fixture.trace()), [false, true], "{engine:?}");
        fixture.session.notify_viewport_resize(200, 100).unwrap();
        fixture.session.notify_viewport_resize(180, 100).unwrap();
        assert_eq!(matches(&fixture.trace()), [false, true]);
        fixture.session.notify_viewport_resize(100, 200).unwrap();
        fixture.session.notify_viewport_resize(220, 100).unwrap();
        assert_eq!(
            matches(&fixture.trace()),
            [false, true, false, true],
            "{engine:?}"
        );
        fixture.call("disconnect", json!(["media"]));
        fixture.session.notify_viewport_resize(100, 200).unwrap();
        assert_eq!(matches(&fixture.trace()), [false, true, false, true]);
    }
}

#[test]
fn replacing_a_page_does_not_deliver_old_observers_to_the_new_page_frame() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.intersection("old-intersection", json!({"thresholds":[0.5]}));
        fixture.media("old-media", json!({"minWidth":150}));
        fixture.render(100, 100);
        let initial = fixture.trace();
        assert_eq!(initial.len(), 2, "{engine:?}");
        let intersection = initial
            .iter()
            .find(|entry| entry["label"] == "old-intersection")
            .unwrap();
        assert_eq!(intersection["result"]["intersectionRatio"], 1.0);
        let media = initial
            .iter()
            .find(|entry| entry["label"] == "old-media")
            .unwrap();
        assert_eq!(media["result"]["matches"], false);
        fixture.ok(op::PAGE_REPLACE, json!({"path":OTHER}));
        fixture.clear();
        fixture.session.notify_viewport_resize(200, 100).unwrap();
        fixture.patch(90.0);
        fixture.render(200, 100);
        assert!(
            fixture.trace().is_empty(),
            "unloaded page observer survived: {engine:?}"
        );
        fixture.intersection("new-intersection", json!({"thresholds":[0.5]}));
        fixture.media("new-media", json!({"minWidth":150}));
        fixture.patch(0.0);
        fixture.render(200, 100);
        let trace = fixture.trace();
        assert_eq!(trace.len(), 2, "{engine:?}: {trace:?}");
        assert!(trace
            .iter()
            .all(|entry| entry["label"].as_str().unwrap().starts_with("new-")));
        let intersection = trace
            .iter()
            .find(|entry| entry["label"] == "new-intersection")
            .unwrap();
        assert_eq!(intersection["result"]["intersectionRatio"], 1.0);
        let media = trace
            .iter()
            .find(|entry| entry["label"] == "new-media")
            .unwrap();
        assert_eq!(media["result"]["matches"], true);
    }
}

#[test]
fn multiple_relative_roots_use_their_geometric_intersection() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.patch(80.0);
        fixture.call(
            "multipleRoots",
            json!(["roots",{"thresholds":[0.25]},[
                {"selector":"#relative"},
                {"margins":{"top":-80,"bottom":20}}
            ]]),
        );
        assert!(fixture.trace().is_empty(), "{engine:?}");
        fixture.render(100, 100);
        let trace = fixture.trace();
        assert_ratios(&trace, &[0.5]);
        let relative = &trace[0]["result"]["relativeRect"];
        assert_eq!(relative["top"], 80.0);
        assert_eq!(relative["bottom"], 100.0);
        assert_eq!(relative["height"], 20.0);
        assert_eq!(relative["width"], 80.0);
    }
}

#[test]
fn native_mode_clips_intermediate_ancestors_and_rejects_an_unrelated_root() {
    const WXML: &str = r#"
        <view id="relative" style="width:80px;height:100px">
          <view id="clip" style="width:80px;height:20px">
            <view id="target" style="width:40px;height:40px"/>
          </view>
        </view>
        <view id="sibling" style="width:80px;height:100px"/>
    "#;
    for engine in engines() {
        let mut fixture = Fixture::with_sources(engine, WXML, PAGE_JS);
        fixture.call(
            "intersection",
            json!(["standard",{"thresholds":[0.25]},"#target","#relative"]),
        );
        fixture.call(
            "intersection",
            json!(["native",{"nativeMode":true,"thresholds":[0.25]},"#target","#relative"]),
        );
        fixture.render(100, 200);
        let trace = fixture.trace();
        assert_eq!(trace.len(), 2, "{engine:?}: {trace:?}");
        let standard = trace
            .iter()
            .find(|entry| entry["label"] == "standard")
            .unwrap();
        let native = trace
            .iter()
            .find(|entry| entry["label"] == "native")
            .unwrap();
        assert_eq!(standard["result"]["intersectionRatio"], 1.0);
        assert_eq!(native["result"]["intersectionRatio"], 0.5);
        assert_eq!(native["result"]["boundingClientRect"]["height"], 40.0);
        assert_eq!(native["result"]["intersectionRect"]["height"], 20.0);
        fixture.clear();
        fixture.call(
            "intersection",
            json!(["unrelated",{"nativeMode":true,"thresholds":[0.25]},"#target","#sibling"]),
        );
        let rejected = fixture.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"viewport":{"width":100,"height":200},"blobs":fixture.blobs}),
        );
        assert_eq!(
            rejected.messages[0].payload["ok"], true,
            "{engine:?}: {rejected:?}"
        );
        let error = rejected
            .messages
            .iter()
            .find(|message| message.op == op::ERROR)
            .unwrap();
        assert_eq!(error.payload["error"]["code"], "ERR_INVALID_REQUEST");
        assert!(error.payload["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ancestor"));
        assert!(
            fixture.trace().is_empty(),
            "invalid observation delivered a result: {engine:?}"
        );
        fixture.call("disconnect", json!(["unrelated"]));
        fixture.render(100, 200);
    }
}

#[test]
fn page_ready_observe_without_set_data_is_measured_by_the_first_commit() {
    const READY_PAGE: &str = r#"
        Page({data:{offset:0,visible:true},onReady:function() {
          this.createIntersectionObserver({thresholds:[0.5]}).relativeToViewport()
            .observe('#target',function(result) { getApp().trace.push({label:'ready',result:result}); });
        }});
    "#;
    for engine in engines() {
        let mut fixture = Fixture::with_sources(engine, PAGE_WXML, READY_PAGE);
        assert!(fixture.trace().is_empty(), "{engine:?}");
        fixture.render(100, 100);
        let trace = fixture.trace();
        assert_ratios(&trace, &[1.0]);
        assert_eq!(trace[0]["label"], "ready");
        fixture.render(100, 100);
        assert_eq!(fixture.trace().len(), 1, "{engine:?}");
    }
}

#[test]
fn idle_host_poll_measures_a_new_subscription_without_synthesizing_another_frame() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.render(100, 100);
        let accepted = fixture.session.renderer().last_frame().unwrap().clone();
        fixture.intersection("idle", json!({"thresholds":[0.5]}));
        assert!(
            fixture.trace().is_empty(),
            "registration ACK was a measurement: {engine:?}"
        );
        let polled = fixture.session.poll_timers(0);
        assert!(
            polled
                .messages
                .iter()
                .all(|message| message.op != op::ERROR),
            "{engine:?}: {polled:?}"
        );
        assert_ratios(&fixture.trace(), &[1.0]);
        assert_eq!(fixture.session.renderer().last_frame().unwrap(), &accepted);
        fixture.session.poll_timers(0);
        assert_eq!(fixture.trace().len(), 1, "{engine:?}");
    }
}

#[test]
fn transformed_targets_report_distinct_geometry_and_display_none_crosses_to_zero() {
    const WXML: &str = r#"
      <view id="relative" style="width:100px;height:100px">
        <view id="target" class="scoped" style="width:20px;height:20px;transform:translate(10px,80px);display:{{hidden ? 'none' : 'block'}}"/>
        <view id="second" class="scoped" style="width:20px;height:20px;transform:translate(90px,0px);display:{{hidden ? 'none' : 'block'}}"/>
      </view>
    "#;
    for engine in engines() {
        let mut fixture = Fixture::with_sources(engine, WXML, PAGE_JS);
        fixture.call(
            "intersection",
            json!(["transforms",{"thresholds":[0.25],"observeAll":true},".scoped"]),
        );
        fixture.render(100, 100);
        let trace = fixture.trace();
        assert_ratios(&trace, &[1.0, 0.5]);
        assert_eq!(trace[0]["result"]["id"], "target");
        assert_eq!(trace[0]["result"]["boundingClientRect"]["left"], 10.0);
        assert_eq!(trace[0]["result"]["boundingClientRect"]["top"], 80.0);
        assert_eq!(trace[1]["result"]["id"], "second");
        assert_eq!(trace[1]["result"]["boundingClientRect"]["left"], 90.0);
        assert_eq!(trace[1]["result"]["boundingClientRect"]["top"], 20.0);
        assert_eq!(trace[1]["result"]["intersectionRect"]["width"], 10.0);
        fixture.call("patch", json!([{"hidden":true}]));
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0, 0.5, 0.0, 0.0]);
        fixture.render(100, 100);
        assert_eq!(fixture.trace().len(), 4, "{engine:?}");
        fixture.call("patch", json!([{"hidden":false}]));
        fixture.render(100, 100);
        assert_ratios(&fixture.trace(), &[1.0, 0.5, 0.0, 0.0, 1.0, 0.5]);
    }
}

#[test]
fn held_page_and_component_instances_cannot_register_after_their_owner_is_released() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.render(200, 600);
        fixture.call("holdOwners", json!([]));
        fixture.call("patch", json!([{"visible":false}]));
        fixture.render(200, 600);
        fixture.call("lateIntersection", json!(["component", "detached"]));
        let detached = fixture.trace();
        assert_eq!(detached.len(), 1, "{engine:?}: {detached:?}");
        let error = &detached[0]["result"]["rejected"];
        assert_eq!(error["code"], "ERR_INVALID_REQUEST");
        assert!(
            error["errMsg"].as_str().unwrap().contains("receiver")
                || error["errMsg"].as_str().unwrap().contains("disposed")
        );
        fixture.ok(op::PAGE_REPLACE, json!({"path":OTHER}));
        fixture.clear();
        fixture.call("lateIntersection", json!(["page", "unloaded"]));
        let unloaded = fixture.trace();
        assert_eq!(unloaded.len(), 1, "{engine:?}: {unloaded:?}");
        let error = &unloaded[0]["result"]["rejected"];
        assert_eq!(error["code"], "ERR_INVALID_REQUEST");
        assert!(
            error["errMsg"].as_str().unwrap().contains("receiver")
                || error["errMsg"].as_str().unwrap().contains("disposed")
        );
        fixture.render(200, 600);
        fixture.session.notify_viewport_resize(300, 600).unwrap();
        assert_eq!(
            fixture.trace(),
            unloaded,
            "late registration survived rejection: {engine:?}"
        );
    }
}
