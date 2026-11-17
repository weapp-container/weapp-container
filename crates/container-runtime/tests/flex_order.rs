//! Real App/Page execution against the shared layout, paint and input contract.
//! The fixture performs the host's revision-driven render refresh after Page
//! effects; it does not certify the simulator loop, DevTools or GPU rendering.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, CapabilitySupport, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{RenderFrame, RenderNode, RenderSnapshot, Renderer, SoftwareRenderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "flex-order-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const PAGE: &str = "module:pages/index/index.js";
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const APP_JS: &str = r#"App({taps:[]});
exports.state=function(){return {taps:getApp().taps.slice(),rects:globalThis.__orderRects};};"#;
const PAGE_JS: &str = r#"var page;
Page({
  data:{order:2},
  onLoad:function(){page=this;},
  onTap:function(event){
    getApp().taps.push(event.target.id);
    this.setData({order:this.data.order===2?-1:2});
  }
});
exports.setOrder=function(order){page.setData({order:order});};
exports.inspect=function(selector){
  var query=wx.createSelectorQuery();
  query.selectAll(selector).boundingClientRect();
  query.exec(function(values){globalThis.__orderRects=values[0];});
};"#;

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
    fn new(engine: EngineKind, markup: &str, styles: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-flex-order-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        manifest
            .capabilities
            .insert("wx.createSelectorQuery".into(), CapabilitySupport::Full);
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP, APP_JS, ModuleScope::App),
            (PAGE, PAGE_JS, ModuleScope::Page),
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
        let template = parse_wxml(markup).unwrap().canonical_json().unwrap();
        let template_pointer = format!("sha256:{}", hex_digest(&template));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: template_pointer.clone(),
            bindings: vec!["order".into()],
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(&format!("page{{background:white;}}{styles}"))
            .unwrap()
            .canonical_json()
            .unwrap();
        let style_pointer = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: style_pointer.clone(),
            scope: StyleScope::Page,
        });
        let blobs = BTreeMap::from([(template_pointer, template), (style_pointer, style)]);
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: SESSION.into(),
                    ..SessionConfig::default()
                },
            )
            .unwrap(),
            sequence: 0,
            engine,
        };
        let initialized = fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        assert_eq!(initialized["engineProviderAvailable"], true, "{engine:?}");
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        let rendered = fixture.refresh();
        fixture.assert_ok(op::RENDER_COMMIT, &rendered);
        fixture
    }

    fn request(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("order-{}", self.sequence),
            operation,
            payload,
        ));
        batch.messages[0].payload.clone()
    }

    fn assert_ok(&self, operation: &str, response: &Value) {
        assert_eq!(
            response["ok"], true,
            "{:?} {operation}: {response}",
            self.engine
        );
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.request(operation, payload);
        self.assert_ok(operation, &response);
        response
    }

    fn refresh(&mut self) -> Value {
        // Match the host refresh boundary: read live Page data and the
        // session's verified pack, never inject resolved geometry or data.
        let frame_id = self.sequence + 1;
        self.request(
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"frameId":frame_id,"useSessionResources":true,
                "viewport":{"width":160,"height":160}}),
        )
    }

    fn tap(&mut self, x: f32, y: f32) {
        let previous_revision = self.session.view().revision;
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y}]}),
        );
        assert!(self.session.view().revision > previous_revision);
        let rendered = self.refresh();
        self.assert_ok(op::RENDER_COMMIT, &rendered);
    }

    fn set_order(&mut self, value: Value) -> Value {
        let previous_revision = self.session.view().revision;
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"setOrder","args":[value]}),
        );
        assert!(self.session.view().revision > previous_revision);
        self.refresh()
    }

    fn state(&mut self) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"state","args":[]}),
        )["result"][0]
            .clone()
    }

    fn query(&mut self, selector: &str) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"inspect","args":[selector]}),
        );
        self.state()["rects"].clone()
    }

    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }

    fn node(&self, selector: &str) -> &RenderNode {
        let nodes = self.frame().query(selector, true).unwrap();
        assert_eq!(nodes.len(), 1, "{selector}");
        nodes[0]
    }

    fn sample(&self, x: u32, y: u32, color: [u8; 4], target: &str) {
        let snapshot = self.session.renderer().snapshot().unwrap();
        let mut mirror = SoftwareRenderer::new();
        mirror.commit(self.frame().clone()).unwrap();
        let mirror = mirror.snapshot().unwrap();
        for pixels in [&snapshot, &mirror] {
            assert_eq!(pixel(pixels, x, y), color, "{:?} ({x},{y})", self.engine);
        }
        assert_eq!(
            self.frame()
                .root
                .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                .map(|node| node.id.as_str()),
            Some(target),
            "{:?} input({x},{y})",
            self.engine
        );
    }
}

fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let offset = y as usize * snapshot.stride as usize + x as usize * 4;
    snapshot.pixels[offset..offset + 4].try_into().unwrap()
}

fn assert_query_rects(rects: &Value, ids: &[&str], positions: &[(f64, f64)]) {
    let rects = rects.as_array().unwrap();
    assert_eq!(rects.len(), ids.len());
    for ((rect, id), (left, top)) in rects.iter().zip(ids).zip(positions) {
        assert_eq!(rect["id"], *id);
        assert_eq!(rect["left"], *left, "{id}");
        assert_eq!(rect["top"], *top, "{id}");
    }
}

#[test]
fn page_tap_reorders_rows_and_columns_while_selector_results_keep_dom_order() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="row"><view id="row-a" class="row-item" bindtap="onTap" style="order:{{order}}"/><view id="row-b" class="row-item"/><view id="row-c" class="row-item"/></view><view id="column"><view id="column-a" class="column-item" style="order:{{order}}"/><view id="column-b" class="column-item"/><view id="column-c" class="column-item"/></view>"#,
            "#row{display:flex;width:60px;height:20px}#column{display:flex;flex-direction:column;position:absolute;left:80px;top:0;width:20px;height:60px}.row-item,.column-item{width:20px;height:20px;flex-shrink:0}");
        assert_query_rects(
            &f.query(".row-item"),
            &["row-a", "row-b", "row-c"],
            &[(40.0, 0.0), (0.0, 0.0), (20.0, 0.0)],
        );
        assert_query_rects(
            &f.query(".column-item"),
            &["column-a", "column-b", "column-c"],
            &[(80.0, 40.0), (80.0, 0.0), (80.0, 20.0)],
        );
        let old_frame = f.frame().frame_id;
        f.tap(45.0, 5.0);
        assert!(f.frame().frame_id > old_frame);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["order"],
            -1
        );
        assert_query_rects(
            &f.query(".row-item"),
            &["row-a", "row-b", "row-c"],
            &[(0.0, 0.0), (20.0, 0.0), (40.0, 0.0)],
        );
        assert_query_rects(
            &f.query(".column-item"),
            &["column-a", "column-b", "column-c"],
            &[(80.0, 0.0), (80.0, 20.0), (80.0, 40.0)],
        );
        assert_eq!(f.state()["taps"], json!(["row-a"]));
    }
}

#[test]
fn overlapping_items_publish_the_same_order_to_pixels_pointer_hits_and_page_events() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="stack"><view id="a" class="item" bindtap="onTap" style="order:{{order}}"/><view id="b" class="item" bindtap="onTap"/></view>"#,
            "#stack{display:flex;width:20px;height:20px}.item{width:20px;height:20px;flex-shrink:0;margin-right:-20px}#a{background:red}#b{background:blue}");
        f.sample(5, 5, RED, "a");
        f.tap(5.5, 5.5);
        f.sample(5, 5, BLUE, "b");
        assert_query_rects(&f.query(".item"), &["a", "b"], &[(0.0, 0.0), (0.0, 0.0)]);
        f.tap(5.5, 5.5);
        f.sample(5, 5, RED, "a");
        assert_eq!(f.state()["taps"], json!(["a", "b"]));
    }
}

#[test]
fn global_order_values_nonflex_flow_and_positioned_effective_zero_share_one_contract() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="globals"><view id="inherited" class="global" style="order:inherit"/><view id="initial" class="global" style="order:initial"/><view id="unset" class="global" style="order:unset"/><view id="default" class="global"/></view><view id="block"><view id="block-a"/><view id="block-b"/></view><view id="absolute-stack"><view id="absolute-flow" bindtap="onTap"/><view id="absolute" bindtap="onTap"/></view><view id="fixed-stack"><view id="fixed-flow" bindtap="onTap"/><view id="fixed" bindtap="onTap"/></view>"#,
            "#globals{display:flex;order:7;width:40px;height:10px}.global{width:10px;height:10px}#block{position:absolute;left:0;top:30px;width:20px;height:20px}#block-a,#block-b{width:10px;height:10px}#block-a{order:99}#block-b{order:-99}#absolute-stack,#fixed-stack{position:absolute;display:flex;top:30px;width:20px;height:20px}#absolute-stack{left:40px}#fixed-stack{left:80px}#absolute-flow,#fixed-flow{width:20px;height:20px;background:red}#absolute-flow{order:-1}#fixed-flow{order:1}#absolute{position:absolute;left:0;top:0;width:20px;height:20px;order:-999;background:blue}#fixed{position:fixed;left:80px;top:30px;width:20px;height:20px;order:999;background:green}");
        for (id, expected) in [
            ("inherited", 7),
            ("initial", 0),
            ("unset", 0),
            ("default", 0),
        ] {
            assert_eq!(
                f.node(&format!("#{id}")).style.unwrap().flow.unwrap().order,
                expected,
                "{engine:?} {id}"
            );
        }
        assert_query_rects(
            &f.query(".global"),
            &["inherited", "initial", "unset", "default"],
            &[(30.0, 0.0), (0.0, 0.0), (10.0, 0.0), (20.0, 0.0)],
        );
        assert_eq!(f.node("#block-a").bounds.y, 30.0);
        assert_eq!(f.node("#block-b").bounds.y, 40.0);
        f.sample(45, 35, BLUE, "absolute");
        // The static item's positive order does not move it above the
        // positioned phase; fixed's authored order is immaterial here.
        f.sample(85, 35, [0, 128, 0, 255], "fixed");
        f.tap(45.5, 35.5);
        f.tap(85.5, 35.5);
        assert_eq!(f.state()["taps"], json!(["absolute", "fixed"]));
    }
}

#[test]
fn invalid_declarations_fall_back_but_deferred_order_rejects_without_publishing() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="row"><view id="target" style="order:{{order}}"/><view id="peer"/></view>"#,
            "#row{display:flex;width:40px;height:20px}#target,#peer{width:20px;height:20px}#target{order:1;background:red}#peer{background:blue}");
        for invalid in ["1.5", "banana"] {
            let rendered = f.set_order(json!(invalid));
            f.assert_ok(op::RENDER_COMMIT, &rendered);
            assert_eq!(f.node("#target").style.unwrap().flow.unwrap().order, 1);
            assert_eq!(f.node("#target").bounds.x, 20.0);
            f.sample(25, 5, RED, "target");
        }
        let accepted = f.frame().clone();
        let pixels = f.session.renderer().snapshot();
        for deferred in ["var(--rank)", "calc(1 + 1)"] {
            let rejected = f.set_order(json!(deferred));
            assert_eq!(
                rejected["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{engine:?} {deferred}: {rejected}"
            );
            assert_eq!(f.frame(), &accepted);
            assert_eq!(f.session.renderer().snapshot(), pixels);
        }
        let repaired = f.set_order(json!(-5));
        f.assert_ok(op::RENDER_COMMIT, &repaired);
        assert_eq!(f.node("#target").bounds.x, 0.0);
        f.sample(5, 5, RED, "target");
    }
}
