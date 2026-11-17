//! Real App/Page → typed WXSS transforms → final layout, pixels and input.
//! These contracts exercise both enabled native engines with the same source
//! pack. They do not certify DevTools, the simulator loop, GPU or real devices.
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

const SESSION: &str = "typed-transform-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const PAGE: &str = "module:pages/index/index.js";
const WHITE: [u8; 4] = [255, 255, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const GREEN: [u8; 4] = [0, 128, 0, 255];
const YELLOW: [u8; 4] = [255, 255, 0, 255];
const APP_JS: &str = r#"App({events:[]});
exports.state=function(){return {events:getApp().events.slice(),rects:globalThis.__transformRects};};"#;
const PAGE_JS: &str = r#"var page;
Page({
  data:{large:false,width:40,height:20,childWidth:12,childHeight:8,fontSize:10,
    transform:'translate(-50%, -50%)',origin:'0 0',tapCount:0},
  onLoad:function(){page=this;},
  onTap:function(event){
    getApp().events.push({type:event.type,target:event.target.id});
    var large=!this.data.large;
    this.setData({large:large,width:large?80:40,height:large?40:20,tapCount:this.data.tapCount+1});
  }
});
exports.patch=function(data){page.setData(data);};
exports.inspect=function(selector){
  var query=wx.createSelectorQuery();
  query.selectAll(selector).boundingClientRect();
  query.exec(function(values){globalThis.__transformRects=values[0];});
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
    markup: String,
    styles: String,
}

impl Fixture {
    fn new(engine: EngineKind, markup: &str, styles: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-typed-transform-contract".into();
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
            bindings: [
                "large",
                "width",
                "height",
                "childWidth",
                "childHeight",
                "fontSize",
                "transform",
                "origin",
                "tapCount",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            wxs_modules: BTreeMap::new(),
        });
        let styles = format!("page{{background:white;}}{styles}");
        let style = parse_wxss(&styles).unwrap().canonical_json().unwrap();
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
            markup: markup.into(),
            styles,
        };
        let initialized = fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        assert_eq!(initialized["engineProviderAvailable"], true, "{engine:?}");
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        let response = fixture.refresh();
        fixture.assert_ok(op::RENDER_COMMIT, &response);
        fixture
    }

    fn request(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("transform-{}", self.sequence),
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
        let frame_id = self.sequence + 1;
        self.request(
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"frameId":frame_id,"useSessionResources":true,
                "viewport":{"width":256,"height":256}}),
        )
    }

    fn patch(&mut self, data: Value) -> Value {
        let previous_revision = self.session.view().revision;
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"patch","args":[data]}),
        );
        assert!(self.session.view().revision > previous_revision);
        self.refresh()
    }

    fn patch_ok(&mut self, data: Value) {
        let response = self.patch(data);
        self.assert_ok(op::RENDER_COMMIT, &response);
    }

    fn tap(&mut self, x: f32, y: f32) {
        let previous_revision = self.session.view().revision;
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":x,"y":y}]}),
        );
        assert!(self.session.view().revision > previous_revision);
        // The host publishes live Page data. Do not manufacture a resolved
        // RenderFrame or inject a second data object after the Page handler.
        let response = self.refresh();
        self.assert_ok(op::RENDER_COMMIT, &response);
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

    fn rect(&mut self, selector: &str, expected: [f64; 4]) {
        let result = self.query(selector);
        let rects = result.as_array().unwrap();
        assert_eq!(rects.len(), 1, "{:?} {selector}: {result}", self.engine);
        for (field, expected) in ["left", "top", "width", "height"].into_iter().zip(expected) {
            let actual = rects[0][field].as_f64().unwrap();
            assert!(
                (actual - expected).abs() <= 0.001,
                "{:?} {selector} {field}: {actual} != {expected}",
                self.engine
            );
        }
    }

    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }

    fn node(&self, selector: &str) -> &RenderNode {
        let nodes = self.frame().query(selector, true).unwrap();
        assert_eq!(nodes.len(), 1, "{selector}");
        nodes[0]
    }

    fn check(&self, phase: &str, samples: &[(u32, u32, [u8; 4], &str)]) {
        let frame = self.frame();
        let snapshot = self.session.renderer().snapshot().unwrap();
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let software = software.snapshot().unwrap();
        for &(x, y, expected, target) in samples {
            for (backend, pixels) in [
                (self.session.renderer().backend_name(), &snapshot),
                ("independent-software", &software),
            ] {
                assert_eq!(
                    pixel(pixels, x, y),
                    expected,
                    "{:?} {phase} {backend} ({x},{y})",
                    self.engine
                );
            }
            let expected_id = if target == "page" {
                frame.root.id.as_str()
            } else {
                self.node(&format!("#{target}")).id.as_str()
            };
            assert_eq!(
                frame
                    .root
                    .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                    .map(|node| node.id.as_str()),
                Some(expected_id),
                "{:?} {phase} input({x},{y})",
                self.engine
            );
        }
        if let Some(directory) = std::env::var_os("WEAPP_CONTAINER_TRANSFORM_EVIDENCE_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let engine = match self.engine {
                EngineKind::Quickjs => "quickjs",
                EngineKind::V8 => "v8",
            };
            let stem = format!("{engine}-{phase}");
            let samples: Vec<_> = samples
                .iter()
                .map(|(x, y, rgba, target)| json!({"x":x,"y":y,"rgba":rgba,"target":target}))
                .collect();
            let value = json!({"schemaVersion":1,"case":phase,"phase":phase,"engine":engine,
                "frame":frame,"samples":samples,"sampleTolerance":0,
                "source":{"wxml":self.markup,"wxss":self.styles,
                    "pageData":self.session.app_service().pages().current().unwrap().data},
                "snapshot":{"width":snapshot.width,"height":snapshot.height,"stride":snapshot.stride,
                    "format":snapshot.format,"runtimeBackend":self.session.renderer().backend_name(),
                    "runtimeSha256":hex_digest(&snapshot.pixels),"softwareSha256":hex_digest(&software.pixels)},
                "scope":"local AppService/View, typed transforms, CPU/software pixels, selector geometry and input",
                "officialDevtools":false,"gpuAcceptance":false});
            std::fs::write(
                directory.join(format!("{stem}.json")),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
            std::fs::write(
                directory.join(format!("{stem}.runtime.rgba")),
                &snapshot.pixels,
            )
            .unwrap();
            std::fs::write(
                directory.join(format!("{stem}.software.rgba")),
                &software.pixels,
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
fn percentage_translation_uses_the_final_border_box_not_viewport_or_content() {
    for engine in engines() {
        for (phase, sizing, rect, samples) in [
            (
                "percentage-content-box",
                "content-box",
                [74.0, 84.0, 52.0, 32.0],
                vec![
                    (75, 95, RED, "box"),
                    (82, 95, BLUE, "box"),
                    (125, 100, RED, "box"),
                    (127, 95, WHITE, "page"),
                ],
            ),
            (
                "percentage-border-box",
                "border-box",
                [80.0, 90.0, 40.0, 20.0],
                vec![
                    (81, 95, RED, "box"),
                    (88, 97, BLUE, "box"),
                    (119, 100, RED, "box"),
                    (75, 95, WHITE, "page"),
                ],
            ),
        ] {
            let mut f = Fixture::new(engine, r#"<view id="box"/>"#,
                &format!("#box{{position:absolute;left:100px;top:100px;width:40px;height:20px;box-sizing:{sizing};padding:4px;border:2px solid red;background:blue;transform:translate(-50%,-50%);}}"));
            f.rect("#box", rect);
            f.check(phase, &samples);
        }
        let mut f = Fixture::new(engine, r#"<view id="box"><view id="measure"/></view>"#,
            "#box{position:absolute;left:100px;top:100px;width:40px;padding:4px;border:2px solid red;background:blue;transform:translate(-50%,-50%);}#measure{width:40px;height:20px;background:green;}");
        f.rect("#box", [74.0, 84.0, 52.0, 32.0]);
        f.rect("#measure", [80.0, 90.0, 40.0, 20.0]);
        f.check(
            "percentage-auto-height",
            &[
                (75, 95, RED, "box"),
                (78, 95, BLUE, "box"),
                (82, 95, GREEN, "measure"),
                (127, 95, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn flex_final_size_is_resolved_before_percentage_translation() {
    for engine in engines() {
        let mut f = Fixture::new(engine, r#"<view id="row"><view id="box"/><view id="sibling"/></view>"#,
            "#row{position:absolute;left:20px;top:20px;display:flex;align-items:flex-start;width:160px;height:40px;}#box{flex-grow:1;flex-shrink:1;flex-basis:0px;height:20px;padding:4px;border:2px solid red;background:blue;transform:translateX(50%);}#sibling{flex-shrink:0;width:40px;height:40px;background:green;}");
        f.rect("#box", [80.0, 20.0, 120.0, 32.0]);
        f.rect("#sibling", [140.0, 20.0, 40.0, 40.0]);
        f.check(
            "flex-final-border-box",
            &[
                (81, 30, RED, "box"),
                (90, 30, BLUE, "box"),
                // The transformed Flex item creates a zero-level context and
                // paints above its ordinary auto-z sibling (Chromium oracle).
                (145, 30, BLUE, "box"),
                (185, 30, BLUE, "box"),
                (75, 30, WHITE, "row"),
            ],
        );
    }
}

const DYNAMIC_MARKUP: &str = r#"<view id="box" class="{{large ? 'large' : 'small'}}" bindtap="onTap"
    style="width:{{width}}px;height:{{height}}px;transform:{{transform}};transform-origin:{{origin}};"/>"#;
const DYNAMIC_STYLES: &str = "#box{position:absolute;left:120px;top:120px;padding:4px;border:2px solid red;}.small{background:blue;}.large{background:green;}";

#[test]
fn page_handler_set_data_recomputes_percentages_and_publishes_one_shared_space() {
    for engine in engines() {
        let mut f = Fixture::new(engine, DYNAMIC_MARKUP, DYNAMIC_STYLES);
        f.rect("#box", [94.0, 104.0, 52.0, 32.0]);
        f.check(
            "dynamic-small",
            &[
                (95, 115, RED, "box"),
                (100, 110, BLUE, "box"),
                (80, 110, WHITE, "page"),
            ],
        );
        let initial_frame = f.frame().frame_id;
        f.tap(100.5, 110.5);
        assert!(f.frame().frame_id > initial_frame);
        f.rect("#box", [74.0, 94.0, 92.0, 52.0]);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["width"],
            80
        );
        assert_eq!(f.state()["events"], json!([{"type":"tap","target":"box"}]));
        f.check(
            "dynamic-large",
            &[
                (75, 110, RED, "box"),
                (80, 110, GREEN, "box"),
                (100, 110, GREEN, "box"),
                (167, 110, WHITE, "page"),
            ],
        );
        // This newly exposed point was outside the initial hit tree. It must
        // reach the same Page handler as the selector and the green pixels.
        f.tap(80.5, 110.5);
        f.rect("#box", [94.0, 104.0, 52.0, 32.0]);
        assert_eq!(f.state()["events"].as_array().unwrap().len(), 2);
        f.check(
            "dynamic-small-again",
            &[
                (95, 115, RED, "box"),
                (100, 110, BLUE, "box"),
                (80, 110, WHITE, "page"),
            ],
        );
        f.patch_ok(json!({"transform":"none"}));
        f.rect("#box", [120.0, 120.0, 52.0, 32.0]);
        f.check(
            "dynamic-none",
            &[
                (121, 130, RED, "box"),
                (130, 130, BLUE, "box"),
                (100, 110, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn swapped_origin_keywords_resolve_to_the_same_bottom_left_corner() {
    for engine in engines() {
        let mut f = Fixture::new(engine, r#"<view id="first"/><view id="second"/>"#,
            "#first,#second{position:absolute;top:20px;width:20px;height:10px;transform:rotate(90deg);}#first{left:20px;background:red;transform-origin:bottom left;}#second{left:70px;background:blue;transform-origin:left bottom;}");
        f.rect("#first", [20.0, 30.0, 10.0, 20.0]);
        f.rect("#second", [70.0, 30.0, 10.0, 20.0]);
        f.check(
            "origin-keyword-order",
            &[
                (25, 35, RED, "first"),
                (75, 35, BLUE, "second"),
                (25, 25, WHITE, "page"),
                (35, 35, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn ordered_functions_and_nested_transforms_share_geometry_paint_and_hit_testing() {
    for engine in engines() {
        let mut f = Fixture::new(engine, r#"<view id="first"/><view id="second"/><view id="parent"><view id="child"/></view>"#,
            "#first,#second{position:absolute;left:20px;width:20px;height:10px;transform-origin:0 0;}#first{top:20px;background:red;transform:translate(40px,10px) scale(2,1);}#second{top:70px;background:blue;transform:scale(2,1) translate(40px,10px);}#parent{position:absolute;left:20px;top:120px;width:60px;height:40px;background:green;transform-origin:0 0;transform:translate(30px,0) rotate(90deg);}#child{position:absolute;left:10px;top:5px;width:10px;height:5px;background:yellow;transform:translate(10px,0);}");
        f.rect("#first", [60.0, 30.0, 40.0, 10.0]);
        f.rect("#second", [100.0, 80.0, 40.0, 10.0]);
        f.rect("#parent", [10.0, 120.0, 40.0, 60.0]);
        f.rect("#child", [40.0, 140.0, 5.0, 10.0]);
        f.check(
            "function-order-and-nesting",
            &[
                (65, 35, RED, "first"),
                (105, 85, BLUE, "second"),
                (15, 125, GREEN, "parent"),
                (42, 145, YELLOW, "child"),
                (55, 145, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn inherited_em_is_computed_at_parent_while_percent_uses_each_final_box() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="parent" style="width:{{width}}px;height:{{height}}px;font-size:{{fontSize}}px;"><view id="child" style="width:{{childWidth}}px;height:{{childHeight}}px;"/></view>"#,
            "#parent{position:absolute;left:20px;top:20px;background:green;transform:translate(1em,50%);}#child{position:absolute;left:0;top:0;font-size:20px;background:blue;transform:inherit;}");
        f.rect("#parent", [30.0, 30.0, 40.0, 20.0]);
        f.rect("#child", [40.0, 34.0, 12.0, 8.0]);
        for selector in ["#parent", "#child"] {
            assert!(!f.node(selector).computed_style["transform"].contains("em"));
        }
        f.check(
            "inherit-before",
            &[
                (35, 35, GREEN, "parent"),
                (41, 35, BLUE, "child"),
                (24, 24, WHITE, "page"),
            ],
        );
        f.patch_ok(json!({"width":80,"height":40,"fontSize":12,"childWidth":20,"childHeight":10}));
        f.rect("#parent", [32.0, 40.0, 80.0, 40.0]);
        f.rect("#child", [44.0, 45.0, 20.0, 10.0]);
        f.check(
            "inherit-after",
            &[
                (34, 42, GREEN, "parent"),
                (46, 47, BLUE, "child"),
                (30, 35, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn invalid_declarations_are_discarded_before_stylesheet_and_inline_cascade() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="sheet"/><view id="inline" style="transform:translate(60px,0) rotate(90deg);transform:scale(2,bad);transform-origin:bottom left;transform-origin:bottom bottom;"/><view id="important"/>"#,
            "#sheet,#inline,#important{position:absolute;left:20px;width:20px;height:10px;}#sheet{top:20px;background:red;transform:translate(20px,0);transform:scale(2,bad);transform:translate(40px,nope);}#inline{top:70px;background:blue;transform:translate(20px,0);}#important{top:120px;background:green;transform:translate(10px,0)!important;transform:scale(2,bad)!important;}");
        f.rect("#sheet", [40.0, 20.0, 20.0, 10.0]);
        f.rect("#inline", [80.0, 80.0, 10.0, 20.0]);
        f.rect("#important", [30.0, 120.0, 20.0, 10.0]);
        f.check(
            "invalid-cascade",
            &[
                (45, 25, RED, "sheet"),
                (85, 85, BLUE, "inline"),
                (35, 125, GREEN, "important"),
                (25, 25, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn valid_unsupported_transform_values_keep_the_last_accepted_tree_and_recover() {
    for engine in engines() {
        let mut f = Fixture::new(engine, DYNAMIC_MARKUP, DYNAMIC_STYLES);
        for (index, patch) in [
            json!({"transform":"translate(calc(10px + 5%), 0)"}),
            json!({"transform":"var(--move)"}),
            json!({"transform":"translate3d(1px, 2px, 3px)"}),
            json!({"transform":"perspective(100px)"}),
            json!({"transform":"revert"}),
            json!({"origin":"left top 4px"}),
        ]
        .into_iter()
        .enumerate()
        {
            let accepted = f.frame().clone();
            let snapshot = f.session.renderer().snapshot();
            let rects = f.query("#box");
            let view_frame = f.session.view().last_frame_id;
            let rejected = f.patch(patch.clone());
            assert_eq!(
                rejected["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{engine:?} {patch}: {rejected}"
            );
            assert_eq!(f.frame(), &accepted);
            assert_eq!(f.session.renderer().snapshot(), snapshot);
            assert_eq!(f.session.view().last_frame_id, view_frame);
            assert_eq!(f.query("#box"), rects);
            f.check(
                &format!("retained-unsupported-{index}"),
                &[
                    (95, 115, RED, "box"),
                    (100, 110, BLUE, "box"),
                    (80, 110, WHITE, "page"),
                ],
            );
            // The live Page may contain an unsupported transform; its old
            // accepted input tree remains usable until a valid publication.
            f.ok(
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":100.5,"y":110.5}]}),
            );
            let state = f.state();
            assert_eq!(state["events"].as_array().unwrap().len(), index + 1);
            assert_eq!(state["events"][index], json!({"type":"tap","target":"box"}));
            assert_eq!(f.frame(), &accepted);
            assert_eq!(f.session.renderer().snapshot(), snapshot);
            f.patch_ok(json!({"large":false,"width":40,"height":20,
                "transform":"translate(-50%, -50%)","origin":"0 0"}));
            assert!(f.frame().frame_id > accepted.frame_id);
            assert_eq!(f.query("#box"), rects);
            f.check(
                &format!("recovered-unsupported-{index}"),
                &[
                    (95, 115, RED, "box"),
                    (100, 110, BLUE, "box"),
                    (80, 110, WHITE, "page"),
                ],
            );
        }
    }
}
