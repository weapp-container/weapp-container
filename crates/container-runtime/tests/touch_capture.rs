//! Native App/Page/Component contracts for session-owned contact routing.
//! These fixtures do not establish UIKit/Android OS input or DevTools parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::Renderer;
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FIRST: &str = "pages/first/index";
const SECOND: &str = "pages/second/index";
const APP: &str = r#"
App({events:[], record:function(owner,event) {
  this.events.push({owner:owner,type:event.type,phase:event.phase,
    target:event.target.id,current:event.currentTarget.id,
    targetDataset:event.target.dataset,currentDataset:event.currentTarget.dataset,
    mark:event.mark,touches:event.touches,changedTouches:event.changedTouches,detail:event.detail});
}});
function current(){const pages=getCurrentPages();return pages[pages.length-1];}
exports.patch=function(data){current().setData(data);return {data:current().data};};
exports.inspect=function(){return {events:getApp().events};};
exports.clear=function(){getApp().events=[];return true;};
exports.armRetirementThrow=function(){current().a=function(e){
  getApp().record('a',e);this.setData({label:'retirement-kept'});throw new Error('retirement callback failed');
};return true;};
exports.armRetirementLoop=function(){current().a=function(e){getApp().record('a',e);while(true){}};return true;};
"#;
const FIRST_JS: &str = r#"
Page({data:{left:0,label:'before',visible:true,showCard:true,navigateOnStart:false,navigateOnCancel:false},
  start:function(e){getApp().record('a',e);if(this.data.navigateOnStart)wx.navigateTo({url:'/pages/second/index'});},
  a:function(e){getApp().record('a',e);
    if(e.type === 'touchcancel' && this.data.navigateOnCancel) {
      this.setData({navigateOnCancel:false});
      wx.navigateTo({url:'/pages/second/index',success:function(){wx.navigateBack({delta:1});}});
    }
  },
  b:function(e){getApp().record('b',e);},
  parent:function(e){getApp().record('parent',e);},
  capture:function(e){getApp().record('capture',e);},
  onHide:function(){getApp().events.push({type:'hide',owner:'first'});},
  onUnload:function(){getApp().events.push({type:'unload',owner:'first'});}
});
"#;
const SECOND_JS: &str = r#"
Page({data:{},record:function(e){getApp().record('second',e);},
  onUnload:function(){getApp().events.push({type:'unload',owner:'second'});}});
"#;
const CARD_JS: &str = r#"
Component({methods:{record:function(e){getApp().record('card',e);}},
  lifetimes:{detached:function(){getApp().events.push({type:'detached',owner:'card'});}}});
"#;
const FIRST_WXML: &str = r#"
<view id="parent" data-label="parent-{{label}}" mark:origin="{{label}}"
  style="position:relative;width:120px;height:100px"
  capture-bind:touchend="capture" capture-bind:touchcancel="capture"
  bindtouchstart="parent" bindtouchmove="parent" bindtouchend="parent" bindtouchcancel="parent" bindtap="parent">
  <view id="b" data-label="b" style="position:absolute;left:0px;top:0px;width:40px;height:40px"
    bindtouchstart="b" bindtouchmove="b" bindtouchend="b" bindtouchcancel="b" bindtap="b"/>
  <view wx:if="{{visible}}" id="a" data-label="{{label}}" style="position:absolute;left:{{left}}px;top:0px;width:40px;height:40px"
    bindtouchstart="start" bindtouchmove="a" bindtouchend="a" bindtouchcancel="a" bindtap="a"/>
  <card wx:if="{{showCard}}" style="position:absolute;left:0px;top:50px;width:40px;height:40px"/>
</view>
"#;
const SECOND_WXML: &str = r#"<view id="second" data-label="second" style="width:120px;height:100px"
  bindtouchstart="record" bindtouchend="record" bindtouchcancel="record" bindtap="record"/>"#;
const CARD_WXML: &str = r#"<view id="inner" data-label="inner" style="width:40px;height:40px"
  bindtouchstart="record" bindtouchmove="record" bindtouchend="record" bindtouchcancel="record" bindtap="record"/>"#;

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
}

impl Fixture {
    fn start(engine: EngineKind, session_id: &str) -> Self {
        Self::start_with_policy(engine, session_id, Default::default())
    }

    fn start_with_policy(
        engine: EngineKind,
        session_id: &str,
        policy: container_runtime::EngineExecutionPolicy,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "native-touch-capture-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        manifest
            .capabilities
            .insert("wx.navigateBack".into(), CapabilitySupport::Partial);
        for route in [FIRST, SECOND] {
            manifest.routes.push(Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: Some(format!("{route}.json")),
                entry_module: format!("module:{route}.js"),
            });
        }
        manifest.components.push(Component {
            id: "components:pages/first/index.json".into(),
            owner: "pages/first/index.json".into(),
            using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
            multiple_slots: None,
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            ("module:app.js", APP, ModuleScope::App),
            ("module:pages/first/index.js", FIRST_JS, ModuleScope::Page),
            ("module:pages/second/index.js", SECOND_JS, ModuleScope::Page),
            (
                "module:components/card/index.js",
                CARD_JS,
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
            ("template:pages/first/index.wxml", FIRST_WXML),
            ("template:pages/second/index.wxml", SECOND_WXML),
            ("template:components/card/index.wxml", CARD_WXML),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: vec![
                    "left".into(),
                    "label".into(),
                    "visible".into(),
                    "showCard".into(),
                ],
                wxs_modules: BTreeMap::new(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: session_id.into(),
                    require_integrity: true,
                    engine_execution: policy,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        let init = fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        assert_eq!(init["engineProviderAvailable"], true);
        assert_eq!(init["loadedModules"], 4);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":FIRST}));
        fixture.render();
        fixture.clear();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let id = format!("gesture-{}", self.sequence);
        let batch = self.session.dispatch(BridgeEnvelope::request(
            self.session.config().session_id.clone(),
            &id,
            operation,
            payload,
        ));
        let response = batch.messages.first().expect("correlated reply");
        for message in batch.messages.iter().skip(1) {
            assert_ne!(message.op, op::ERROR, "{batch:?}");
        }
        assert_eq!(response.request_id, id, "{batch:?}");
        assert_eq!(response.op, operation, "{batch:?}");
        assert_eq!(response.session_id, self.session.config().session_id);
        response.payload.clone()
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.dispatch(operation, payload);
        assert_eq!(response["ok"], true, "{operation}: {response}");
        response
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn patch(&mut self, value: Value) {
        self.call("patch", json!([value]));
    }
    fn clear(&mut self) {
        self.call("clear", json!([]));
    }
    fn events(&mut self) -> Vec<Value> {
        self.call("inspect", json!([]))["events"]
            .as_array()
            .unwrap()
            .clone()
    }

    fn render(&mut self) {
        let route = self
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .path
            .clone();
        // The initial headless fixture has no native window observation. Once
        // resize supplies one, render that actual viewport rather than replay
        // the previous 120x100 coordinate system under a fresh frame number.
        let width = match self.session.config().host.window_width {
            0 => 120,
            width => width,
        };
        let height = match self.session.config().host.window_height {
            0 => 100,
            height => height,
        };
        let response = self.ok(op::RENDER_COMMIT,json!({"templateId":format!("template:{route}.wxml"),"useSessionResources":true,"viewport":{"width":width,"height":height}}));
        assert_eq!(response["committed"], true);
    }

    fn center(&self, selector: &str) -> (f64, f64) {
        let frame = self.session.renderer().last_frame().unwrap();
        let nodes = frame.query(selector, false).unwrap();
        assert_eq!(nodes.len(), 1, "{selector}");
        let bounds = nodes[0].bounds;
        assert!(
            bounds.width > 0. && bounds.height > 0.,
            "{selector}: {bounds:?}"
        );
        (
            (bounds.x + bounds.width / 2.) as f64,
            (bounds.y + bounds.height / 2.) as f64,
        )
    }

    fn touch(kind: &str, id: i64, x: f64, y: f64) -> Value {
        let touch = json!({"identifier":id,"clientX":x,"clientY":y,"pageX":x,"pageY":y});
        let active = matches!(kind, "touchstart" | "touchmove");
        json!({"type":kind,"x":x,"y":y,"timeStamp":100,"touches":if active {json!([touch])} else {json!([])},"changedTouches":[touch],"detail":{"x":x,"y":y}})
    }

    fn input(&mut self, events: Vec<Value>) -> Value {
        self.ok(op::EVENT_BATCH, json!({"events":events}))
    }
}

fn for_owner(events: &[Value], owner: &str) -> Vec<Value> {
    events
        .iter()
        .filter(|event| event["owner"] == owner)
        .cloned()
        .collect()
}

#[test]
fn logical_resize_touchcancel_navigation_round_trip_rejects_retired_candidate() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "resize-cancel-navigation");
        f.patch(json!({"navigateOnCancel":true}));
        f.render();
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 73, x, y)]);
        f.clear();
        let page = f.session.app_service().pages().current().unwrap().id;
        let revision = f.session.render_revision();
        let before_frame = f.session.renderer().last_frame().unwrap().clone();
        let before_host = f.session.config().host.clone();
        let failure = match f.session.prepare_dev_logical_resize(
            container_render_skia::Rect {
                x: 0.0,
                y: 0.0,
                width: 200.0,
                height: 160.0,
            },
            1.0,
        ) {
            Ok(_) => panic!("touchcancel navigation revived the original source"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.error.code,
            container_bridge::BridgeErrorCode::Cancelled
        );
        assert_eq!(f.session.app_service().pages().len(), 1);
        assert_eq!(f.session.app_service().pages().current().unwrap().id, page);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["navigateOnCancel"],
            false
        );
        assert_eq!(f.session.render_revision(), revision);
        assert_eq!(f.session.renderer().last_frame(), Some(&before_frame));
        assert_eq!(
            f.session.config().host.window_width,
            before_host.window_width
        );
        assert_eq!(
            f.session.config().host.window_height,
            before_host.window_height
        );
        let cancelled = for_owner(&f.events(), "a")
            .into_iter()
            .filter(|event| event["type"] == "touchcancel")
            .count();
        assert_eq!(cancelled, 1, "{engine:?}");
        f.render(); // Truly dirty callback input; not another resize/cancel.
        assert_eq!(
            f.input(vec![Fixture::touch("touchend", 73, x, y)])["events"],
            0
        );
        assert_eq!(
            for_owner(&f.events(), "a")
                .into_iter()
                .filter(|event| event["type"] == "touchcancel")
                .count(),
            1
        );
    }
}

#[test]
fn layout_motion_and_dataset_changes_preserve_the_original_touch_route() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "moving-target");
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 7, x, y)]);
        f.patch(json!({"left":60,"label":"after"}));
        f.render();
        assert_ne!(f.center("#a"), (x, y));
        f.clear();
        f.input(vec![
            Fixture::touch("touchend", 7, x, y),
            Fixture::touch("tap", 7, x, y),
        ]);
        let events = f.events();
        let target = for_owner(&events, "a");
        assert_eq!(
            target
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["touchend", "tap"],
            "{engine:?}: {events:?}"
        );
        assert!(for_owner(&events, "b").is_empty());
        assert_eq!(events[0]["owner"], "capture");
        assert_eq!(events[0]["currentDataset"]["label"], "parent-before");
        for event in events {
            assert_eq!(event["target"], "a");
            assert_eq!(event["targetDataset"]["label"], "before");
            assert_eq!(event["mark"]["origin"], "before");
        }
    }
}

#[test]
fn outside_viewport_release_and_explicit_cancel_finish_the_original_recipient() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "outside-release");
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 8, x, y)]);
        f.clear();
        f.input(vec![Fixture::touch("touchmove", 8, 150., -20.)]);
        let end = f.input(vec![
            Fixture::touch("touchend", 8, 150., -20.),
            Fixture::touch("tap", 8, 150., -20.),
        ]);
        assert_eq!(end["events"], 1);
        let target = for_owner(&f.events(), "a");
        assert_eq!(
            target
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["touchmove", "touchend"]
        );
        assert_eq!(target[1]["touches"], json!([]));
        assert_eq!(target[1]["changedTouches"][0]["clientX"], 150.);
        f.input(vec![Fixture::touch("touchstart", 8, x, y)]);
        f.clear();
        f.input(vec![Fixture::touch("touchcancel", 8, -10., -10.)]);
        f.input(vec![
            Fixture::touch("touchend", 8, x, y),
            Fixture::touch("tap", 8, x, y),
        ]);
        let target = for_owner(&f.events(), "a");
        assert_eq!(target.len(), 1);
        assert_eq!(target[0]["type"], "touchcancel");
    }
}

#[test]
fn removed_node_cancels_once_and_does_not_redirect_its_end_or_tap() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "removed-target");
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 9, x, y)]);
        f.clear();
        f.patch(json!({"visible":false}));
        f.render();
        let events = f.events();
        let target = for_owner(&events, "a");
        assert_eq!(target.len(), 1, "{events:?}");
        assert_eq!(target[0]["type"], "touchcancel");
        assert_eq!(target[0]["target"], "a");
        assert_eq!(target[0]["detail"]["reason"], "route-invalidated");
        f.clear();
        assert_eq!(
            f.input(vec![
                Fixture::touch("touchend", 9, x, y),
                Fixture::touch("tap", 9, x, y)
            ])["events"],
            0
        );
        assert!(f.events().is_empty());
        // Current Web/desktop adapters send standalone, unqualified taps.
        f.input(vec![json!({"type":"tap","x":x,"y":y,"detail":{}})]);
        assert_eq!(for_owner(&f.events(), "b")[0]["type"], "tap");
    }
}

#[test]
fn component_removal_delivers_cancel_before_detached_without_scope_reentry() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "removed-component");
        let (x, y) = f.center("#inner");
        f.input(vec![Fixture::touch("touchstart", 10, x, y)]);
        assert_eq!(for_owner(&f.events(), "card")[0]["type"], "touchstart");
        f.clear();
        f.patch(json!({"showCard":false}));
        f.render();
        let card = for_owner(&f.events(), "card");
        assert_eq!(
            card.iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["touchcancel", "detached"],
            "{engine:?}: {card:?}"
        );
        assert_eq!(card[0]["target"], "inner");
        assert_eq!(card[0]["targetDataset"]["label"], "inner");
        f.clear();
        f.input(vec![
            Fixture::touch("touchend", 10, x, y),
            Fixture::touch("tap", 10, x, y),
        ]);
        assert!(f.events().is_empty());
    }
}

#[test]
fn navigation_from_touchstart_cancels_before_hide_and_never_taps_the_new_page() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "navigate-on-down");
        f.patch(json!({"navigateOnStart":true}));
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 11, x, y)]);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            SECOND
        );
        let events = f.events();
        let cancel = events
            .iter()
            .position(|e| e["type"] == "touchcancel" && e["owner"] == "a")
            .unwrap();
        let hide = events.iter().position(|e| e["type"] == "hide").unwrap();
        assert!(cancel < hide, "{events:?}");
        f.render();
        f.clear();
        assert_eq!(
            f.input(vec![
                Fixture::touch("touchend", 11, x, y),
                Fixture::touch("tap", 11, x, y)
            ])["events"],
            0
        );
        assert!(f.events().is_empty());
        f.input(vec![json!({"type":"tap","x":x,"y":y})]);
        assert_eq!(for_owner(&f.events(), "second")[0]["type"], "tap");
    }
}

#[test]
fn page_pop_hide_resize_and_reused_contact_ids_have_one_terminal_event() {
    for engine in engines() {
        for boundary in ["pop", "hide", "resize"] {
            let mut f = Fixture::start(engine, &format!("boundary-{boundary}"));
            if boundary == "pop" {
                f.ok(op::PAGE_PUSH, json!({"path":SECOND}));
                f.render();
            }
            let selector = if boundary == "pop" { "#second" } else { "#a" };
            let (x, y) = f.center(selector);
            f.input(vec![Fixture::touch("touchstart", 12, x, y)]);
            f.clear();
            match boundary {
                "pop" => {
                    f.ok(op::PAGE_POP, json!({}));
                }
                "hide" => {
                    f.ok(op::APP_LIFECYCLE, json!({"event":"hide"}));
                }
                "resize" => {
                    f.session.notify_viewport_resize(140, 110).unwrap();
                }
                _ => unreachable!(),
            }
            let events = f.events();
            let owner = if boundary == "pop" { "second" } else { "a" };
            assert_eq!(
                for_owner(&events, owner)
                    .iter()
                    .filter(|e| e["type"] == "touchcancel")
                    .count(),
                1,
                "{boundary}: {events:?}"
            );
            if boundary == "hide" {
                f.ok(op::APP_LIFECYCLE, json!({"event":"show"}));
            }
            f.render();
            f.clear();
            f.input(vec![
                Fixture::touch("touchend", 12, x, y),
                Fixture::touch("tap", 12, x, y),
            ]);
            assert!(f.events().is_empty(), "{boundary}");
            // A fresh down reuses the contact ID, with a new page/node lease.
            let (x, y) = f.center("#a");
            f.input(vec![Fixture::touch("touchstart", 12, x, y)]);
            f.clear();
            f.input(vec![Fixture::touch("touchend", 12, x, y)]);
            f.input(vec![Fixture::touch("tap", 12, x, y)]);
            assert_eq!(
                for_owner(&f.events(), "a")
                    .iter()
                    .map(|e| e["type"].as_str().unwrap())
                    .collect::<Vec<_>>(),
                vec!["touchend", "tap"]
            );
        }
    }
}

#[test]
fn unknown_identified_events_are_ignored_while_legacy_taps_remain_independent() {
    for engine in engines() {
        let mut first = Fixture::start(engine, "contact-owner");
        let mut second = Fixture::start(engine, "other-session");
        let (x, y) = first.center("#a");
        first.input(vec![Fixture::touch("touchstart", 13, x, y)]);
        assert_eq!(
            second.input(vec![
                Fixture::touch("touchmove", 13, x, y),
                Fixture::touch("touchend", 13, x, y),
                Fixture::touch("touchcancel", 13, x, y),
                Fixture::touch("tap", 13, x, y),
            ])["events"],
            0
        );
        assert!(second.events().is_empty());
        second.input(vec![json!({"type":"tap","x":x,"y":y})]);
        assert_eq!(for_owner(&second.events(), "a")[0]["type"], "tap");
        let frame = second.session.renderer().last_frame().unwrap();
        let identity = frame.query("#a", false).unwrap()[0]
            .event_identity
            .clone()
            .unwrap();
        second.input(vec![
            json!({"type":"tap","target":identity,"path":[identity]}),
        ]);
        assert_eq!(for_owner(&second.events(), "a").len(), 2);
        assert_eq!(for_owner(&first.events(), "a").len(), 1);
    }
}

#[test]
fn active_contact_budget_is_released_and_ended_leases_expire_without_retargeting() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "bounded-contacts");
        let (x, y) = f.center("#a");
        f.input(
            (0..64)
                .map(|id| Fixture::touch("touchstart", id, x, y))
                .collect(),
        );
        let rejected = f.dispatch(
            op::EVENT_BATCH,
            json!({"events":[Fixture::touch("touchstart", 64, x, y)]}),
        );
        assert_eq!(rejected["error"]["code"], "ERR_INVALID_REQUEST");
        f.input(vec![Fixture::touch("touchcancel", 0, x, y)]);
        f.input(vec![Fixture::touch("touchstart", 64, x, y)]);
        f.input(
            (1..=64)
                .map(|id| Fixture::touch("touchend", id, x, y))
                .collect(),
        );
        // Completing another drag evicts ID 1's end-to-tap lease. Identified
        // delayed taps stay ignored; the newest lease survives across batches.
        f.input(vec![
            Fixture::touch("touchstart", 65, x, y),
            Fixture::touch("touchend", 65, x, y),
        ]);
        f.clear();
        assert_eq!(f.input(vec![Fixture::touch("tap", 1, x, y)])["events"], 0);
        f.input(vec![Fixture::touch("tap", 65, x, y)]);
        let events = for_owner(&f.events(), "a");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "tap");
        // No retained terminal lease consumes the active budget.
        f.input(
            (100..164)
                .map(|id| Fixture::touch("touchstart", id, x, y))
                .collect(),
        );
    }
}

#[test]
fn developer_owner_retirement_cancels_all_software_contacts_once_and_keeps_diagnostic_pixels() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "dev-owner-retirement");
        f.patch(json!({"left":60}));
        f.render();
        let a = f.center("#a");
        let b = f.center("#b");
        f.input(vec![
            Fixture::touch("touchstart", 1, a.0, a.1),
            Fixture::touch("touchstart", 2, b.0, b.1),
        ]);
        f.clear();
        let (frame, revision) = {
            let observed = f.session.accepted_page_observation().unwrap();
            (observed.frame as *const _, observed.render_revision)
        };
        f.session.retire_dev_preview("owner-disconnected").unwrap();
        let observed = f.session.accepted_page_observation().unwrap();
        assert_eq!(observed.frame as *const _, frame);
        assert_eq!(observed.render_revision, revision);
        let first = f.events();
        for owner in ["a", "b"] {
            let events = for_owner(&first, owner);
            assert_eq!(events.len(), 1, "{engine:?}: {first:?}");
            assert_eq!(events[0]["type"], "touchcancel");
            assert_eq!(events[0]["detail"]["reason"], "owner-disconnected");
        }
        f.session.retire_dev_preview("repeat-disconnect").unwrap();
        assert_eq!(
            f.events(),
            first,
            "retired software contacts cannot be canceled again"
        );
    }
}

#[test]
fn developer_owner_retirement_hook_navigation_cannot_replay_the_cancelled_contact() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "dev-owner-navigation");
        f.patch(json!({"navigateOnCancel":true}));
        f.render();
        let (x, y) = f.center("#a");
        f.input(vec![Fixture::touch("touchstart", 3, x, y)]);
        f.clear();
        f.session.retire_dev_preview("owner-changed").unwrap();
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            FIRST
        );
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["navigateOnCancel"],
            false
        );
        let first = f.events();
        assert_eq!(
            for_owner(&first, "a")
                .iter()
                .filter(|event| event["type"] == "touchcancel")
                .count(),
            1
        );
        f.session.retire_dev_preview("owner-changed-again").unwrap();
        assert_eq!(f.events(), first);
    }
}

#[test]
fn developer_owner_retirement_error_consumes_every_lease_and_preserves_set_data_effects() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "dev-owner-error");
        f.patch(json!({"left":60}));
        f.render();
        let a = f.center("#a");
        let b = f.center("#b");
        f.input(vec![
            Fixture::touch("touchstart", 1, a.0, a.1),
            Fixture::touch("touchstart", 2, b.0, b.1),
        ]);
        f.call("armRetirementThrow", json!([]));
        f.clear();
        let retirement = f.session.retire_dev_preview("owner-error");
        assert!(retirement.is_err());
        let error = retirement.unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Engine);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["label"],
            "retirement-kept"
        );
        // Failed native completion retains diagnostics until the next public
        // turn. Drain them before the success-only module-call fixture helper.
        let diagnostics = f.session.retire_dev_preview("drain-owner-error").unwrap();
        assert!(
            diagnostics
                .messages
                .iter()
                .any(|message| message.op == op::ERROR
                    && message.payload["error"]["code"] == "ERR_ENGINE"
                    && message.payload["error"]["message"].as_str()
                        == Some(error.message.as_str())),
            "the native completion error remains intact: {error:?}: {diagnostics:?}"
        );
        let reported = diagnostics
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .filter_map(|message| message.payload["errors"].as_array())
            .flatten()
            .filter(|error| error["message"] == "retirement callback failed")
            .count();
        assert_eq!(
            reported, 1,
            "the original callback error reports exactly once: {diagnostics:?}"
        );
        let first = f.events();
        assert_eq!(for_owner(&first, "a").len(), 1);
        assert!(
            for_owner(&first, "b").is_empty(),
            "first throw stops later software callbacks after consuming all leases"
        );
        f.session.retire_dev_preview("retry-after-error").unwrap();
        assert_eq!(
            f.events(),
            first,
            "a failed callback cannot leave the second lease to fire on retry"
        );
    }
}

#[cfg(feature = "quickjs-native")]
#[test]
fn developer_owner_retirement_software_cancel_uses_original_trusted_turn_budget() {
    let mut f = Fixture::start_with_policy(
        EngineKind::Quickjs,
        "dev-owner-timeout",
        container_runtime::EngineExecutionPolicy {
            turn_timeout_ms: Some(100),
            bootstrap_timeout_ms: Some(1000),
        },
    );
    let (x, y) = f.center("#a");
    f.input(vec![Fixture::touch("touchstart", 1, x, y)]);
    f.call("armRetirementLoop", json!([]));
    assert!(f.session.retire_dev_preview("owner-timeout").is_err());
    assert!(f.session.execution_fault().is_some());
    assert!(!f.session.is_current_frame_presented());
    assert!(f.session.retire_dev_preview("retry-faulted-owner").is_err());
}

#[test]
fn natural_software_cancellation_keeps_reported_handler_errors_non_fatal() {
    for engine in engines() {
        let mut f = Fixture::start(engine, "natural-cancel-error");
        f.patch(json!({"left":60}));
        f.render();
        let a = f.center("#a");
        let b = f.center("#b");
        f.input(vec![
            Fixture::touch("touchstart", 1, a.0, a.1),
            Fixture::touch("touchstart", 2, b.0, b.1),
        ]);
        f.call("armRetirementThrow", json!([]));
        f.clear();
        let batch = f.session.dispatch(BridgeEnvelope::request(
            f.session.config().session_id.clone(),
            "natural-hide-error",
            op::APP_LIFECYCLE,
            json!({"event":"hide"}),
        ));
        assert_eq!(
            batch.messages[0].payload["ok"], true,
            "{engine:?}: {batch:?}"
        );
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.payload["errors"]
                    .as_array()
                    .is_some_and(|errors| errors
                        .iter()
                        .any(|error| error["message"] == "retirement callback failed"))),
            "{batch:?}"
        );
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["label"],
            "retirement-kept"
        );
        let events = f.events();
        for owner in ["a", "b"] {
            assert_eq!(
                for_owner(&events, owner)
                    .iter()
                    .filter(|event| event["type"] == "touchcancel")
                    .count(),
                1,
                "natural hide retains report-and-continue semantics: {engine:?}: {events:?}"
            );
        }
        f.session.retire_dev_preview("after-natural-hide").unwrap();
        assert_eq!(
            f.events(),
            events,
            "natural cancellation already consumed every contact"
        );
    }
}
