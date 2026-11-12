//! Real native-engine App/Page -> cascade -> accepted frame/pixels/input.
//! Local software/raster contracts only; no official slot or UI evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, CapabilitySupport, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{RenderFrame, RenderNode, RenderSnapshot, Renderer, Visibility};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;
const SESSION: &str = "visibility-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const PAGE: &str = "module:pages/index/index.js";
const APP_JS: &str = r#"App({events:[]});exports.state=function(){return {events:getApp().events.slice(),values:globalThis.__visibilityValues};};"#;
const PAGE_JS: &str = r#"var page;Page({data:{visibility:'visible'},onLoad:function(){page=this},tap:function(e){getApp().events.push('target:'+e.target.id)},bubble:function(e){getApp().events.push('bubble:'+e.target.id)}});exports.patch=function(data){page.setData(data)};exports.inspect=function(selector){var query=wx.createSelectorQuery();query.select(selector).fields({computedStyle:['visibility'],size:true});query.exec(function(values){globalThis.__visibilityValues=values[0]})};"#;
const MARKUP: &str = r#"<view id="parent" bindtap="bubble" style="visibility:{{visibility}}"><view id="normal" bindtap="tap"/><view id="override" bindtap="tap"/></view>"#;
const STYLES:&str="page{background:white}#parent{position:absolute;left:10px;top:10px;width:50px;height:50px;background:red;opacity:.5}#normal{position:absolute;left:0;top:0;width:20px;height:20px;background:green;visibility:inherit}#override{position:absolute;left:20px;top:20px;width:20px;height:20px;background:blue;visibility:visible}";
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
    fn new(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-visibility-contract".into();
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
        let template = parse_wxml(MARKUP).unwrap().canonical_json().unwrap();
        let template_pointer = format!("sha256:{}", hex_digest(&template));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: template_pointer.clone(),
            bindings: vec!["visibility".into()],
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(STYLES).unwrap().canonical_json().unwrap();
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
        assert_eq!(
            fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}))
                ["engineProviderAvailable"],
            true
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        let rendered = fixture.refresh();
        fixture.assert_ok(op::RENDER_COMMIT, &rendered);
        fixture
    }
    fn request(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        self.session
            .dispatch(BridgeEnvelope::request(
                SESSION,
                format!("visibility-{}", self.sequence),
                operation,
                payload,
            ))
            .messages[0]
            .payload
            .clone()
    }
    fn assert_ok(&self, operation: &str, value: &Value) {
        assert_eq!(value["ok"], true, "{:?}: {operation}: {value}", self.engine)
    }
    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let value = self.request(operation, payload);
        self.assert_ok(operation, &value);
        value
    }
    fn refresh(&mut self) -> Value {
        let id = self.sequence + 1;
        self.request(op::RENDER_COMMIT,json!({"templateId":TEMPLATE,"frameId":id,"useSessionResources":true,"viewport":{"width":100,"height":100}}))
    }
    fn patch(&mut self, value: &str) -> Value {
        let before = self.session.view().revision;
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"patch","args":[{"visibility":value}]}),
        );
        assert!(self.session.view().revision > before);
        self.refresh()
    }
    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }
    fn node(&self, selector: &str) -> &RenderNode {
        let found = self.frame().query(selector, true).unwrap();
        assert_eq!(found.len(), 1);
        found[0]
    }
    fn snapshot(&self) -> RenderSnapshot {
        self.session.renderer().snapshot().unwrap()
    }
    fn state(&mut self) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"state","args":[]}),
        )["result"][0]
            .clone()
    }
    fn inspect(&mut self, selector: &str) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"inspect","args":[selector]}),
        );
        self.state()["values"].clone()
    }
    fn tap(&mut self, x: f32, y: f32) {
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y}]}),
        );
    }
}
fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let at = (y * snapshot.stride + x * 4) as usize;
    snapshot.pixels[at..at + 4].try_into().unwrap()
}
fn near(actual: [u8; 4], expected: [u8; 4]) {
    for (a, b) in actual.into_iter().zip(expected) {
        assert!(a.abs_diff(b) <= 1, "{actual:?} != {expected:?}")
    }
}

#[test]
fn visibility_live_page_inheritance_keeps_geometry_pixels_selector_values_and_target_bubble_semantics(
) {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let bounds = f.node("#normal").bounds;
        assert_eq!(f.node("#normal").visibility, Visibility::Visible);
        let result = f.patch("hidden");
        f.assert_ok(op::RENDER_COMMIT, &result);
        assert_eq!(f.node("#parent").visibility, Visibility::Hidden);
        assert_eq!(f.node("#normal").visibility, Visibility::Hidden);
        assert_eq!(f.node("#override").visibility, Visibility::Visible);
        assert_eq!(f.node("#normal").bounds, bounds);
        assert_eq!(
            f.frame()
                .node_geometries()
                .iter()
                .find(|g| g.node.id == "normal")
                .unwrap()
                .bounds,
            bounds
        );
        near(pixel(&f.snapshot(), 15, 15), [255, 255, 255, 255]);
        near(pixel(&f.snapshot(), 35, 35), [127, 127, 255, 255]);
        assert_eq!(
            f.frame().root.hit_test(15.5, 15.5).unwrap().tag.as_deref(),
            Some("page")
        );
        assert_eq!(f.frame().root.hit_test(35.5, 35.5).unwrap().id, "override");
        let values = f.inspect("#normal");
        assert_eq!(values["visibility"], "hidden");
        assert_eq!(values["width"], 20);
        assert_eq!(values["height"], 20);
        f.tap(15.5, 15.5);
        assert_eq!(f.state()["events"], json!([]));
        f.tap(35.5, 35.5);
        assert_eq!(
            f.state()["events"],
            json!(["target:override", "bubble:override"])
        );
        let result = f.patch("visible");
        f.assert_ok(op::RENDER_COMMIT, &result);
        assert_eq!(f.node("#normal").visibility, Visibility::Visible);
        assert_eq!(f.node("#normal").bounds, bounds);
        assert_eq!(f.inspect("#normal")["visibility"], "visible");
        near(pixel(&f.snapshot(), 15, 15), [127, 191, 127, 255]);
    }
}
#[test]
fn visibility_unsupported_winners_reject_before_replacing_the_actual_accepted_frame() {
    for engine in engines() {
        for unsupported in ["collapse", "var(--empty) visible"] {
            let mut f = Fixture::new(engine);
            let before = f.frame().clone();
            let pixels = f.snapshot().pixels;
            let accepted_revision = f
                .session
                .accepted_page_observation()
                .unwrap()
                .render_revision;
            let result = f.patch(unsupported);
            assert_eq!(result["ok"], false, "{engine:?}: {result}");
            assert_eq!(result["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY");
            assert_eq!(f.frame(), &before);
            assert_eq!(f.snapshot().pixels, pixels);
            assert_eq!(
                f.session
                    .accepted_page_observation()
                    .unwrap()
                    .render_revision,
                accepted_revision
            );
        }
    }
}
