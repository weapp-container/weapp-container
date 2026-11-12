//! Local JSON event metadata contracts; not official DevTools equivalence evidence.
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

const ROUTE: &str = "pages/index/index";
const APP_JS: &str = r#"
App({events:[],queries:[],queryResults:[],failures:[],observations:[]});
function current(){const pages=getCurrentPages();return pages[pages.length-1];}
exports.patch=function(value){current().setData(value);return true;};
exports.inspect=function(){const a=getApp();return {events:a.events,queries:a.queries,
  queryResults:a.queryResults,failures:a.failures,observations:a.observations};};
exports.clear=function(){const a=getApp();a.events=[];a.queries=[];a.queryResults=[];a.failures=[];return true;};
exports.query=function(selector){
  const q=wx.createSelectorQuery();
  q.select(selector).fields({dataset:true,mark:true},function(v){getApp().queries.push(v);});
  q.exec().then(function(v){getApp().queryResults.push(v);},function(e){getApp().failures.push(e.code);});
  return true;
};
exports.emit=function(){current().selectComponent('#card').emit();return true;};
exports.observe=function(){
  getApp().observer=wx.createIntersectionObserver(current(),{thresholds:[0.5]}).relativeToViewport();
  getApp().observer.observe('#target',function(v){getApp().observations.push(v);});return true;
};
"#;

const PAGE_JS: &str = r#"
function record(owner,e){getApp().events.push({owner:owner,type:e.type,phase:e.phase,
  target:e.target.id,current:e.currentTarget.id,targetDataset:e.target.dataset,
  currentDataset:e.currentTarget.dataset,mark:e.mark,detail:e.detail});}
Page({data:{payload:{number:12.5,integer:12,negative:-7,zero:0,yes:true,no:false,nil:null,
  text:'文字 🌈',array:[1,false,null,{x:['two',3]}],object:{nested:{enabled:false},label:'first'},
  emptyArray:[],emptyObject:{}},offset:0},
  target:function(e){record('target',e);},capture:function(e){record('capture',e);},
  bubble:function(e){record('bubble',e);},custom:function(e){record('custom',e);}
});
"#;

const CARD_JS: &str = r#"
Component({properties:{payload:{type:Object,value:{}}},methods:{
  record:function(e){getApp().events.push({owner:'component-native',type:e.type,phase:e.phase,
    target:e.target.id,current:e.currentTarget.id,targetDataset:e.target.dataset,
    currentDataset:e.currentTarget.dataset,mark:e.mark,detail:e.detail});},
  emit:function(){this.triggerEvent('typed',{payload:this.properties.payload},
    {bubbles:true,composed:true,capturePhase:true});}
}});
"#;

// Both Page and Component templates use the same JSON projection contract.
// Literal spellings must stay strings; no JSON.parse heuristic is permitted.
const METADATA: &str = r#"
 data-number="{{payload.number}}" data-integer="{{payload.integer}}"
 data-negative="{{payload.negative}}" data-zero="{{payload.zero}}"
 data-yes="{{payload.yes}}" data-no="{{payload.no}}" data-nil="{{payload.nil}}"
 data-text="{{payload.text}}" data-array="{{payload.array}}" data-object="{{payload.object}}"
 data-empty-array="{{payload.emptyArray}}" data-empty-object="{{payload.emptyObject}}"
 data-literal-number="12.5" data-literal-bool="false" data-literal-null="null"
 data-literal-json='{"x":1}' data-mixed="n={{payload.number}}"
 mark:number="{{payload.number}}" mark:yes="{{payload.yes}}" mark:nil="{{payload.nil}}"
 mark:array="{{payload.array}}" mark:shared="{{payload.object}}" mark:text="{{payload.text}}"
 mark:empty-array="{{payload.emptyArray}}" mark:empty-object="{{payload.emptyObject}}"
 mark:literal-bool="false"
"#;

fn page_wxml() -> String {
    format!(
        r#"<view id="parent" data-owner="{{{{payload.object}}}}" mark:ancestor="{{{{payload.array}}}}"
          mark:shared="{{{{payload.array}}}}" style="position:relative;width:200px;height:200px"
          capture-bind:tap="capture" capture-bind:touchend="capture" bindtap="bubble" bindtouchend="bubble">
          <view id="target" {METADATA} style="position:absolute;left:0px;top:{{{{offset}}}}px;width:80px;height:80px"
            bindtap="target" bindtouchstart="target" bindtouchend="target"/>
          <card id="card" payload="{{{{payload}}}}" data-payload="{{{{payload}}}}" mark:component="{{{{payload.object}}}}"
            style="position:absolute;left:0px;top:100px;width:80px;height:80px" bind:typed="custom"/>
        </view>"#
    )
}

fn card_wxml() -> String {
    format!(r#"<view id="card-inner" {METADATA} style="width:80px;height:80px" bindtap="record"/>"#)
}

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn initial_payload() -> Value {
    json!({"number":12.5,"integer":12,"negative":-7,"zero":0,"yes":true,"no":false,"nil":null,
      "text":"文字 🌈","array":[1,false,null,{"x":["two",3]}],
      "object":{"nested":{"enabled":false},"label":"first"},"emptyArray":[],"emptyObject":{}})
}

fn dataset(payload: &Value) -> Value {
    let mut value = payload.as_object().unwrap().clone();
    value.insert("literalNumber".into(), json!("12.5"));
    value.insert("literalBool".into(), json!("false"));
    value.insert("literalNull".into(), json!("null"));
    value.insert("literalJson".into(), json!(r#"{"x":1}"#));
    value.insert("mixed".into(), json!(format!("n={}", payload["number"])));
    Value::Object(value)
}

fn local_mark(payload: &Value) -> Value {
    json!({"number":payload["number"],"yes":payload["yes"],"nil":payload["nil"],
      "array":payload["array"],"shared":payload["object"],"text":payload["text"],
      "emptyArray":payload["emptyArray"],"emptyObject":payload["emptyObject"],"literalBool":"false"})
}

fn inherited_mark(payload: &Value) -> Value {
    let mut value = local_mark(payload).as_object().unwrap().clone();
    value.insert("ancestor".into(), payload["array"].clone());
    Value::Object(value)
}

// Fixtures deliberately stay within the exactly representable f64 integer
// range. WXML evaluation may serialize 12.0 where a JS roundtrip emits 12;
// both remain JSON numbers. Every other JSON kind and all object keys remain
// strict, so this cannot make the old stringification behavior pass.
fn assert_json(actual: &Value, expected: &Value) {
    match (actual, expected) {
        (Value::Number(left), Value::Number(right)) => {
            assert_eq!(left.as_f64(), right.as_f64());
        }
        (Value::Array(left), Value::Array(right)) => {
            assert_eq!(left.len(), right.len(), "{actual} != {expected}");
            for (left, right) in left.iter().zip(right) {
                assert_json(left, right);
            }
        }
        (Value::Object(left), Value::Object(right)) => {
            assert_eq!(left.len(), right.len(), "{actual} != {expected}");
            for (key, right) in right {
                assert_json(left.get(key).expect("expected JSON key present"), right);
            }
        }
        _ => assert_eq!(actual, expected),
    }
}

struct Fixture {
    session: Session,
    sequence: u64,
}

impl Fixture {
    fn start(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "typed-metadata-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        for name in [
            "getCurrentPages",
            "Page.selectComponent",
            "Component.triggerEvent",
            "wx.createSelectorQuery",
            "wx.createIntersectionObserver",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        manifest.routes.push(Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: Some(format!("{ROUTE}.json")),
            entry_module: format!("module:{ROUTE}.js"),
        });
        manifest.components.push(Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
            multiple_slots: None,
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            ("module:app.js", APP_JS, ModuleScope::App),
            ("module:pages/index/index.js", PAGE_JS, ModuleScope::Page),
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
            ("template:pages/index/index.wxml", page_wxml()),
            ("template:components/card/index.wxml", card_wxml()),
        ] {
            let bytes = parse_wxml(&source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: vec!["payload".into(), "offset".into()],
                wxs_modules: BTreeMap::new(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.refresh_integrity().unwrap();
        let mut f = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: "typed-metadata".into(),
                    require_integrity: true,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        let initialized = f.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        assert_eq!(initialized["engineProviderAvailable"], true);
        assert_eq!(initialized["loadedModules"], 3);
        f.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        f.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        f.render();
        f
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let id = format!("metadata-{}", self.sequence);
        let batch = self.session.dispatch(BridgeEnvelope::request(
            self.session.config().session_id.clone(),
            &id,
            operation,
            payload,
        ));
        let response = batch.messages.first().expect("correlated reply");
        assert_eq!(response.request_id, id, "{batch:?}");
        assert_eq!(response.op, operation, "{batch:?}");
        for message in batch.messages.iter().skip(1) {
            assert_ne!(message.op, op::ERROR, "{batch:?}");
        }
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

    fn render(&mut self) {
        self.ok(
            op::RENDER_COMMIT,
            json!({"templateId":format!("template:{ROUTE}.wxml"),
            "useSessionResources":true,"viewport":{"width":200,"height":200}}),
        );
    }

    fn patch(&mut self, value: Value) {
        self.call("patch", json!([value]));
        self.render();
    }

    fn projection(&mut self, selector: &str) -> Value {
        self.ok(
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":selector,
            "operation":"fields","fields":{"dataset":true,"mark":true}}),
        )["result"]
            .clone()
    }

    fn js_projection(&mut self, selector: &str) -> Value {
        self.call("clear", json!([]));
        self.call("query", json!([selector]));
        let state = self.call("inspect", json!([]));
        assert_eq!(state["failures"], json!([]));
        assert_eq!(state["queries"].as_array().unwrap().len(), 1);
        assert_json(&state["queryResults"][0][0], &state["queries"][0]);
        state["queries"][0].clone()
    }

    fn node_metadata(&self, selector: &str) -> Value {
        let nodes = self
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query(selector, false)
            .unwrap();
        assert_eq!(nodes.len(), 1);
        json!({"dataset":nodes[0].dataset,"mark":nodes[0].mark})
    }

    fn center(&self, selector: &str) -> (f64, f64) {
        let frame = self.session.renderer().last_frame().unwrap();
        let nodes = frame.query(selector, false).unwrap();
        assert_eq!(nodes.len(), 1);
        let geometry = frame
            .node_geometries()
            .into_iter()
            .find(|geometry| std::ptr::eq(geometry.node, nodes[0]))
            .expect("selected node has committed viewport geometry");
        assert!(geometry.displayed);
        let bounds = geometry.bounds;
        assert!(bounds.width > 0. && bounds.height > 0.);
        let x = bounds.x + bounds.width / 2.;
        let y = bounds.y + bounds.height / 2.;
        let path = frame.root.hit_test_path(x, y);
        assert!(
            path.last().is_some_and(|hit| std::ptr::eq(*hit, nodes[0])),
            "fixture center must hit {selector} as the deepest recipient"
        );
        (f64::from(x), f64::from(y))
    }

    fn tap(&mut self, x: f64, y: f64) {
        // A standalone coordinate tap has no contact identifier. Supplying
        // changedTouches without an earlier touchstart opts into capture and
        // correctly causes an unknown contact to be ignored by the runtime.
        let result = self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y,"timeStamp":100,
                "detail":{"x":x,"y":y}}]}),
        );
        assert_eq!(result["events"], 1);
    }

    fn input(&mut self, kind: &str, id: i64, x: f64, y: f64) {
        assert!(matches!(
            kind,
            "touchstart" | "touchmove" | "touchend" | "touchcancel"
        ));
        let touch = json!({"identifier":id,"clientX":x,"clientY":y,"pageX":x,"pageY":y});
        let active = matches!(kind, "touchstart" | "touchmove");
        let result = self.ok(op::EVENT_BATCH,json!({"events":[{"type":kind,"x":x,"y":y,"timeStamp":100,
            "touches":if active {json!([touch])} else {json!([])},"changedTouches":[touch],"detail":{"x":x,"y":y}}]}));
        assert_eq!(result["events"], 1);
    }

    fn events(&mut self) -> Vec<Value> {
        self.call("inspect", json!([]))["events"]
            .as_array()
            .unwrap()
            .clone()
    }
}

#[test]
fn page_json_metadata_reaches_frame_bridge_and_actual_js_selector() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        let payload = initial_payload();
        let expected = json!({"dataset":dataset(&payload),"mark":local_mark(&payload)});
        assert_json(&f.node_metadata("#target"), &expected);
        assert_json(&f.projection("#target"), &expected);
        assert_json(&f.js_projection("#target"), &expected);
    }
}

#[test]
fn page_event_phases_have_typed_target_current_and_nearest_inherited_mark() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        let payload = initial_payload();
        let (x, y) = f.center("#target");
        f.tap(x, y);
        let events = f.events();
        assert_eq!(events.len(), 3, "{engine:?}: {events:?}");
        assert_eq!(events[0]["owner"], "capture");
        assert_eq!(events[1]["owner"], "target");
        assert_eq!(events[2]["owner"], "bubble");
        assert_eq!(events[0]["phase"], "capture");
        assert_eq!(events[1]["phase"], "target");
        assert_eq!(events[2]["phase"], "bubble");
        for event in &events {
            assert_eq!(event["target"], "target");
            assert_json(&event["targetDataset"], &dataset(&payload));
            assert_json(&event["mark"], &inherited_mark(&payload));
        }
        assert_json(&events[1]["currentDataset"], &dataset(&payload));
        for index in [0, 2] {
            assert_json(
                &events[index]["currentDataset"],
                &json!({"owner":payload["object"]}),
            );
        }
    }
}

#[test]
fn actual_component_properties_native_event_and_trigger_event_preserve_json() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        let payload = initial_payload();
        let expected = json!({"dataset":dataset(&payload),"mark":local_mark(&payload)});
        assert_json(&f.node_metadata("#card-inner"), &expected);
        let (x, y) = f.center("#card-inner");
        f.tap(x, y);
        let events = f.events();
        let native = events
            .iter()
            .find(|e| e["owner"] == "component-native")
            .unwrap();
        assert_json(&native["targetDataset"], &dataset(&payload));
        assert_json(&native["currentDataset"], &dataset(&payload));
        assert_json(&native["mark"]["shared"], &payload["object"]);
        assert_json(&native["mark"]["component"], &payload["object"]);
        assert_json(&native["mark"]["ancestor"], &payload["array"]);
        f.call("clear", json!([]));
        f.call("emit", json!([]));
        let custom = f.events();
        assert_eq!(custom.len(), 1, "{engine:?}: {custom:?}");
        assert_eq!(custom[0]["owner"], "custom");
        assert_json(&custom[0]["targetDataset"], &json!({"payload":payload}));
        assert_json(&custom[0]["currentDataset"], &json!({"payload":payload}));
        assert_json(&custom[0]["mark"]["component"], &payload["object"]);
        assert_json(&custom[0]["detail"]["payload"], &payload);
    }
}

#[test]
fn captured_contact_keeps_old_json_while_queries_and_new_contact_see_new_data() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        let before = initial_payload();
        let (x, y) = f.center("#target");
        f.input("touchstart", 7, x, y);
        let started = f.events();
        assert_eq!(started.len(), 1, "{engine:?}: {started:?}");
        assert_eq!(started[0]["owner"], "target");
        assert_eq!(started[0]["type"], "touchstart");
        assert_json(&started[0]["targetDataset"], &dataset(&before));
        assert_json(&started[0]["mark"], &inherited_mark(&before));
        let mut after = before.clone();
        after["object"] = json!({"nested":{"enabled":true},"label":"second"});
        after["array"] = json!([{"new":true},null,5]);
        after["yes"] = json!(false);
        f.patch(json!({"payload":after}));
        let projected = f.js_projection("#target");
        assert_json(&projected["dataset"], &dataset(&after));
        assert_json(&projected["mark"], &local_mark(&after));
        // js_projection cleared earlier touchstart records, not active contacts.
        f.input("touchend", 7, x, y);
        let events = f.events();
        assert_eq!(events.len(), 3, "{engine:?}: {events:?}");
        for event in &events {
            assert_json(&event["targetDataset"], &dataset(&before));
            assert_json(&event["mark"], &inherited_mark(&before));
        }
        assert_json(
            &events[0]["currentDataset"],
            &json!({"owner":before["object"]}),
        );
        assert_json(&events[1]["currentDataset"], &dataset(&before));
        f.call("clear", json!([]));
        f.input("touchstart", 8, x, y);
        let fresh = f.events();
        assert_eq!(fresh.len(), 1);
        assert_json(&fresh[0]["targetDataset"], &dataset(&after));
        assert_json(&fresh[0]["mark"], &inherited_mark(&after));
        f.input("touchend", 8, x, y);
    }
}

#[test]
fn intersection_measurement_uses_typed_dataset_from_an_accepted_frame() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.call("observe", json!([]));
        f.render();
        let state = f.call("inspect", json!([]));
        assert_eq!(state["observations"].as_array().unwrap().len(), 1);
        assert_json(
            &state["observations"][0]["dataset"],
            &dataset(&initial_payload()),
        );
        assert_eq!(state["observations"][0]["intersectionRatio"], 1.0);
    }
}

fn legacy_frame(frame_id: u64) -> Value {
    json!({"frameId":frame_id,"viewport":{"x":0.,"y":0.,"width":200.,"height":200.},
      "root":{"id":"legacy","attributes":{"id":"legacy"},
        "dataset":{"number":"12.5","bool":"false","nil":"null","json":"{\"x\":1}","empty":""},
        "mark":{"bool":"false","json":"[1,null]"},
        "bounds":{"x":0.,"y":0.,"width":80.,"height":80.},"opacity":1.,"children":[]}})
}

#[test]
fn legacy_string_frames_remain_strings_through_both_selector_boundaries() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        let old = legacy_frame(200);
        f.ok(op::RENDER_COMMIT, old.clone());
        let expected = json!({"dataset":old["root"]["dataset"],"mark":old["root"]["mark"]});
        assert_eq!(f.node_metadata("#legacy"), expected);
        assert_eq!(f.projection("#legacy"), expected);
        assert_eq!(f.js_projection("#legacy"), expected);
    }
}

#[test]
fn malformed_metadata_container_does_not_replace_the_last_accepted_frame() {
    for engine in engines() {
        for field in ["dataset", "mark"] {
            for malformed in [
                json!([]),
                json!("text"),
                json!(3),
                json!(false),
                Value::Null,
            ] {
                // A fresh session prevents unrelated pending effects or contacts
                // from obscuring explicit-frame publication atomicity.
                let mut f = Fixture::start(engine);
                let accepted = legacy_frame(300);
                f.ok(op::RENDER_COMMIT, accepted.clone());
                let before = f.projection("#legacy");
                let mut candidate = accepted;
                candidate["frameId"] = json!(301);
                candidate["root"][field] = malformed;
                let rejected = f.dispatch(op::RENDER_COMMIT, candidate);
                assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
                assert_eq!(rejected["error"]["code"], "ERR_RENDER");
                assert_eq!(f.session.renderer().last_frame().unwrap().frame_id, 300);
                assert_eq!(f.projection("#legacy"), before);
            }
        }
    }
}
