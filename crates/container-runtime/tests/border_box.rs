//! AppService/View → WXSS cascade → layout/pixels/input on both real engines.
//! Local CPU/software contracts; saved DevTools values are a limited oracle,
//! not evidence of an official visual comparison or physical GPU acceptance.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{Rect, RenderFrame, RenderSnapshot, Renderer, SoftwareRenderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "border-box-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const WHITE: [u8; 4] = [255, 255, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const GREEN: [u8; 4] = [0, 128, 0, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];
const YELLOW: [u8; 4] = [255, 255, 0, 255];
const APP_JS: &str =
    "App({taps:[]});exports.state=function(){return {taps:getApp().taps.slice()};};";
const PAGE_JS: &str = r#"Page({
    data:{border:'2px solid red'},
    onTap:function(event){getApp().taps.push(event.target.id);this.setData({border:'4px solid blue'});}
});"#;

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
    sequence: usize,
    engine: EngineKind,
}

impl Fixture {
    fn new(engine: EngineKind, wxml: &str, wxss: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-border-box-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP, APP_JS, ModuleScope::App),
            ("module:pages/index/index.js", PAGE_JS, ModuleScope::Page),
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
        let ast = parse_wxml(wxml).unwrap().canonical_json().unwrap();
        let template_pointer = format!("sha256:{}", hex_digest(&ast));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: template_pointer.clone(),
            bindings: vec!["border".into()],
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(&format!("page{{background:white;}}{wxss}"))
            .unwrap()
            .canonical_json()
            .unwrap();
        let style_pointer = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: style_pointer.clone(),
            scope: StyleScope::Page,
        });
        let blobs = BTreeMap::from([(template_pointer, ast), (style_pointer, style)]);
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
            blobs,
            sequence: 0,
            engine,
        };
        fixture.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        fixture.render(None);
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("border-{}", self.sequence),
            operation,
            payload,
        ));
        batch.messages[0].payload.clone()
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.dispatch(operation, payload);
        assert_eq!(
            response["ok"], true,
            "{:?} {operation}: {response}",
            self.engine
        );
        response
    }

    fn render_payload(&self, data: Option<Value>) -> Value {
        let mut payload =
            json!({"templateId":TEMPLATE,"viewport":{"width":128,"height":128},"blobs":self.blobs});
        if let Some(data) = data {
            payload["data"] = data;
        }
        payload
    }

    fn render(&mut self, data: Option<Value>) {
        self.ok(op::RENDER_COMMIT, self.render_payload(data));
    }

    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }

    fn bounds(&self, selector: &str, expected: [f32; 4]) {
        let selected = self.frame().query(selector, true).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(
            selected[0].bounds,
            Rect {
                x: expected[0],
                y: expected[1],
                width: expected[2],
                height: expected[3]
            },
            "{:?} {selector}",
            self.engine
        );
    }

    fn check(&self, case: &str, samples: &[(u32, u32, [u8; 4], &str)]) {
        let frame = self.frame();
        let snapshot = self.session.renderer().snapshot().unwrap();
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let software = software.snapshot().unwrap();
        for &(x, y, rgba, selector) in samples {
            for (backend, pixels) in [
                (self.session.renderer().backend_name(), &snapshot),
                ("independent-software", &software),
            ] {
                assert_eq!(
                    pixel(pixels, x, y),
                    rgba,
                    "{:?} {case} {backend} ({x},{y})",
                    self.engine
                );
            }
            let expected = if selector == "page" {
                &frame.root
            } else {
                frame.query(selector, true).unwrap()[0]
            };
            assert_eq!(
                frame
                    .root
                    .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                    .map(|n| n.id.as_str()),
                Some(expected.id.as_str()),
                "{:?} {case} input({x},{y})",
                self.engine
            );
        }
        if let Some(directory) = std::env::var_os("WEAPP_CONTAINER_BORDER_EVIDENCE_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let engine = match self.engine {
                EngineKind::Quickjs => "quickjs",
                EngineKind::V8 => "v8",
            };
            let samples: Vec<_> = samples
                .iter()
                .map(|(x, y, rgba, selector)| json!({"x":x,"y":y,"rgba":rgba,"selector":selector}))
                .collect();
            let value = json!({"schemaVersion":1,"case":case,"engine":engine,"frame":frame,"samples":samples,
                "scope":"local AppService/View, WXSS, CPU/software pixels and hit-testing", "officialDevtools":false,"gpuAcceptance":false});
            std::fs::write(
                directory.join(format!("{engine}-{case}.json")),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
    }
}

fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let offset = y as usize * snapshot.stride as usize + x as usize * 4;
    snapshot.pixels[offset..offset + 4].try_into().unwrap()
}

#[test]
fn four_edges_and_content_box_affect_geometry_pixels_and_event_targets() {
    for engine in engines() {
        let mut f = Fixture::new(engine, r#"<view id="box" bindtap="onTap"><view id="child"/></view>"#,
            "#box{position:absolute;left:8px;top:8px;width:32px;height:24px;padding:2px 3px 4px 5px;border-width:2px 4px 6px 8px;border-style:solid;border-color:red green blue black;}#child{width:8px;height:8px;background:yellow;}");
        f.bounds("#box", [8.0, 8.0, 52.0, 38.0]);
        f.bounds("#child", [21.0, 12.0, 8.0, 8.0]);
        f.check(
            "asymmetric-content-box",
            &[
                (30, 8, RED, "#box"),
                (58, 24, GREEN, "#box"),
                (30, 44, BLUE, "#box"),
                (10, 25, BLACK, "#box"),
                (42, 20, WHITE, "#box"),
                (22, 14, YELLOW, "#child"),
            ],
        );
        f.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":10.5,"y":25.5}]}),
        );
        let state = f.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":"state","args":[]}),
        );
        assert_eq!(state["result"][0]["taps"], json!(["box"]));
    }
}

#[test]
fn border_box_and_auto_flow_account_for_insets_once() {
    for engine in engines() {
        let f = Fixture::new(engine, r#"<view id="box"><view id="child"/></view><view id="after"/>"#,
            "#box{width:40px;box-sizing:border-box;padding:3px;border:4px solid red;}#child{height:10px;background:blue;}#after{width:10px;height:10px;background:green;}");
        f.bounds("#box", [0.0, 0.0, 40.0, 24.0]);
        f.bounds("#child", [7.0, 7.0, 26.0, 10.0]);
        f.bounds("#after", [0.0, 24.0, 10.0, 10.0]);
        f.check(
            "border-box-auto-height",
            &[
                (1, 10, RED, "#box"),
                (8, 8, BLUE, "#child"),
                (5, 5, WHITE, "#box"),
                (2, 25, GREEN, "#after"),
            ],
        );
    }
}

#[test]
fn default_page_border_box_remains_the_host_viewport() {
    for engine in engines() {
        let f = Fixture::new(
            engine,
            r#"<view id="child"/>"#,
            "page{padding:5px;border:3px solid green;}#child{height:10px;background:blue;}",
        );
        assert_eq!(
            f.frame().root.bounds,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 128.0,
                height: 128.0
            }
        );
        f.bounds("#child", [8.0, 8.0, 112.0, 10.0]);
        f.check(
            "page-default-viewport",
            &[
                (1, 10, GREEN, "page"),
                (7, 7, WHITE, "page"),
                (9, 9, BLUE, "#child"),
                (127, 60, GREEN, "page"),
            ],
        );
    }
}

#[test]
fn border_box_cannot_make_content_dimensions_negative() {
    for engine in engines() {
        let f = Fixture::new(
            engine,
            r#"<view id="box"/>"#,
            "#box{box-sizing:border-box;width:1px;height:2px;padding:3px;border:4px solid red;}",
        );
        f.bounds("#box", [0.0, 0.0, 14.0, 14.0]);
        f.check(
            "minimum-border-box",
            &[
                (1, 7, RED, "#box"),
                (7, 7, WHITE, "#box"),
                (15, 7, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn zero_border_serialization_remains_a_valid_presenter_frame() {
    for engine in engines() {
        let f = Fixture::new(
            engine,
            r#"<view id="box"/>"#,
            "#box{width:20px;height:10px;border:0 none black;}",
        );
        f.bounds("#box", [0.0, 0.0, 20.0, 10.0]);
        let node = f.frame().query("#box", true).unwrap()[0];
        assert_eq!(node.computed_style["border-top-color"], "rgb(0, 0, 0)");
        // The canonical frame omits an all-default typed border. A presenter
        // must recognize zero used longhands, rather than rejecting colours
        // which cannot produce painted border pixels.
        assert!(serde_json::to_value(node).unwrap()["style"]
            .get("border")
            .is_none());
        f.check(
            "zero-border",
            &[(0, 5, WHITE, "#box"), (21, 5, WHITE, "page")],
        );
    }
}

#[test]
fn absolute_children_use_padding_box_and_overflow_preserves_border_input() {
    for engine in engines() {
        let f = Fixture::new(engine, r#"<view id="box"><view id="child"/></view>"#,
            "#box{position:absolute;left:8px;top:8px;box-sizing:border-box;width:40px;height:40px;padding:4px;border:4px solid red;overflow:hidden;}#child{position:absolute;left:-4px;top:-4px;width:50px;height:50px;background:blue;}");
        f.bounds("#box", [8.0, 8.0, 40.0, 40.0]);
        f.bounds("#child", [8.0, 8.0, 50.0, 50.0]);
        f.check(
            "padding-box-overflow",
            &[
                (9, 25, RED, "#box"),
                (13, 25, BLUE, "#child"),
                (46, 25, RED, "#box"),
                (50, 25, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn rounded_translucent_border_preserves_underlying_pixels_in_its_hole() {
    for engine in engines() {
        let f = Fixture::new(engine, r#"<view id="under"/><view id="box"/>"#,
            "#under{position:absolute;width:80px;height:80px;background:blue;}#box{position:absolute;left:8px;top:8px;box-sizing:border-box;width:40px;height:40px;border-radius:20px;border:8px solid rgba(255,0,0,0.5);}");
        f.check(
            "rounded-alpha-ring",
            &[
                (28, 10, [128, 0, 127, 255], "#box"),
                (16, 16, [128, 0, 127, 255], "#box"),
                (28, 28, BLUE, "#box"),
                (8, 8, BLUE, "#under"),
                (28, 46, [128, 0, 127, 255], "#box"),
            ],
        );
    }
}

#[test]
fn transformed_border_and_padding_containing_block_share_the_input_space() {
    for engine in engines() {
        let f = Fixture::new(engine, r#"<view id="box"><view id="child"/></view>"#,
            "#box{position:absolute;left:8px;top:8px;width:32px;height:24px;border:4px solid red;transform-origin:0 0;transform:translate(56px,8px) rotate(90deg);}#child{position:absolute;left:0;top:0;width:8px;height:8px;background:blue;}");
        f.bounds("#box", [8.0, 8.0, 40.0, 32.0]);
        f.bounds("#child", [12.0, 12.0, 8.0, 8.0]);
        f.check(
            "transformed-border",
            &[
                (62, 30, RED, "#box"),
                (45, 54, RED, "#box"),
                (48, 30, WHITE, "#box"),
                (56, 24, BLUE, "#child"),
                (66, 24, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn currentcolor_inheritance_important_longhands_and_border_resets_reach_the_frame() {
    for engine in engines() {
        let f = Fixture::new(engine, r#"<view id="parent"><view id="box" style="border:2px solid;border-left:4px solid red;"/><view id="reset" style="border:5px solid blue;border:none;"/><view id="inherited" style="border:inherit;color:blue;"/></view>"#,
            "#parent{color:green;border:3px solid red;width:80px;}#box{width:24px;height:16px;border-left:3px solid blue!important;}#reset{height:8px;}#inherited{width:16px;height:8px;}");
        f.bounds("#box", [3.0, 3.0, 29.0, 20.0]);
        f.bounds("#reset", [3.0, 23.0, 80.0, 8.0]);
        f.bounds("#inherited", [3.0, 31.0, 22.0, 14.0]);
        let computed = &f.frame().query("#box", true).unwrap()[0].computed_style;
        assert_eq!(computed["border-top-color"], "rgb(0, 128, 0)");
        assert_eq!(computed["border-left-color"], "rgb(0, 0, 255)");
        assert_eq!(computed["border-left-width"], "3px");
        f.check(
            "cascade-currentcolor-reset",
            &[
                (10, 3, GREEN, "#box"),
                (4, 10, BLUE, "#box"),
                (10, 25, WHITE, "#reset"),
                (10, 32, RED, "#inherited"),
            ],
        );
    }
}

#[test]
fn setdata_rebuilds_border_geometry_and_invalid_style_retains_the_accepted_frame() {
    for engine in engines() {
        let mut f = Fixture::new(
            engine,
            r#"<view id="box" bindtap="onTap" style="width:24px;height:16px;border:{{border}};"/>"#,
            "",
        );
        f.bounds("#box", [0.0, 0.0, 28.0, 20.0]);
        f.check(
            "dynamic-before",
            &[
                (1, 8, RED, "#box"),
                (3, 8, WHITE, "#box"),
                (30, 8, WHITE, "page"),
            ],
        );
        f.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":1.5,"y":8.5}]}),
        );
        f.render(None);
        f.bounds("#box", [0.0, 0.0, 32.0, 24.0]);
        let samples = [
            (1, 8, BLUE, "#box"),
            (3, 8, BLUE, "#box"),
            (5, 8, WHITE, "#box"),
            (30, 8, BLUE, "#box"),
        ];
        f.check("dynamic-after", &samples);
        let accepted = f.frame().clone();
        let pixels = f.session.renderer().snapshot();
        let rejected = f.dispatch(
            op::RENDER_COMMIT,
            f.render_payload(Some(json!({"border":"4px dashed red"}))),
        );
        assert_eq!(rejected["ok"], false, "{rejected}");
        assert_eq!(
            rejected["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
            "{rejected}"
        );
        assert!(
            rejected["error"]["message"]
                .as_str()
                .unwrap()
                .contains("border-style:dashed"),
            "{rejected}"
        );
        assert_eq!(f.frame(), &accepted);
        assert_eq!(f.session.renderer().snapshot(), pixels);
        f.check("retained-after-unsupported", &samples);
        f.render(None);
        f.check("recovered", &samples);
    }
}

#[test]
fn saved_devtools_shared_style_values_are_actually_painted() {
    // Saved official shared-styles-3173 checkpoint: border-top-width 2px,
    // border-top-color rgb(15,118,110). This local fixture consumes those
    // observable values; it does not rerun the original official case.
    for engine in engines() {
        let f = Fixture::new(
            engine,
            r#"<view id="box"/>"#,
            "#box{width:32px;height:24px;border:2px solid rgb(15,118,110);}",
        );
        f.bounds("#box", [0.0, 0.0, 36.0, 28.0]);
        f.check(
            "saved-shared-style-values",
            &[
                (10, 0, [15, 118, 110, 255], "#box"),
                (0, 10, [15, 118, 110, 255], "#box"),
                (10, 10, WHITE, "#box"),
            ],
        );
    }
}
