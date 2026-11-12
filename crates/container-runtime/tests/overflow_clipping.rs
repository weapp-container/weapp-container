//! Real AppService/View WXML/WXSS-to-pixel and pointer contracts. These local
//! fixtures cover CPU/software rendering, not official DevTools or GPU parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{RenderFrame, RenderSnapshot, Renderer, SoftwareRenderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "overflow-clipping-contract";
const PAGE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const WHITE: [u8; 4] = [255, 255, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [17, 34, 51, 255];

const APP_JS: &str = r#"
App({taps:[]});
exports.taps=function(){return {taps:getApp().taps.slice()};};
exports.clear=function(){getApp().taps=[];};
"#;
const PAGE_JS: &str = r#"
Page({data:{},onTarget:function(event){getApp().taps.push(event.target.id);}});
"#;
const BOX_WXML: &str = r#"<view id="clip"><view id="target" bindtap="onTarget"/></view>"#;
const BASE_WXSS: &str = concat!(
    "page{background:#ffffff;}",
    "#clip{position:absolute;left:12px;top:12px;width:32px;height:32px;background:#112233;}",
    "#target{position:absolute;left:16px;top:16px;width:32px;height:32px;background:#ff0000;}"
);

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn engine_name(engine: EngineKind) -> &'static str {
    match engine {
        EngineKind::Quickjs => "quickjs",
        EngineKind::V8 => "v8",
    }
}

struct Fixture {
    session: Session,
    blobs: BTreeMap<String, Vec<u8>>,
    style_pointer: String,
    sequence: u64,
    engine: EngineKind,
}

#[derive(Clone, Copy)]
struct Sample {
    x: u32,
    y: u32,
    rgba: [u8; 4],
    selector: &'static str,
}

fn sample(x: u32, y: u32, rgba: [u8; 4], selector: &'static str) -> Sample {
    Sample {
        x,
        y,
        rgba,
        selector,
    }
}

impl Fixture {
    fn new(engine: EngineKind, wxml: &str, wxss: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "overflow-clipping-local-contract".into();
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
            id: PAGE.into(),
            wxml_ast: template_pointer.clone(),
            bindings: Vec::new(),
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(wxss).unwrap().canonical_json().unwrap();
        let style_pointer = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: style_pointer.clone(),
            scope: StyleScope::Page,
        });
        let blobs = BTreeMap::from([(template_pointer, ast), (style_pointer.clone(), style)]);
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
            style_pointer,
            sequence: 0,
            engine,
        };
        fixture.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        fixture.render();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("overflow-{}", self.sequence),
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

    fn render(&mut self) {
        self.ok(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"viewport":{"width":128,"height":128},"blobs":self.blobs}),
        );
    }

    fn call(&mut self, export: &str) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP,"export":export,"args":[]}),
        )["result"][0]
            .clone()
    }

    fn check(&mut self, case: &str, samples: &[Sample]) {
        self.call("clear");
        let frame = self.session.renderer().last_frame().unwrap().clone();
        let runtime = self.session.renderer().snapshot().unwrap();
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        let software = software.snapshot().unwrap();
        let mut expected_taps = Vec::<Value>::new();
        let mut exported = Vec::new();
        for sample in samples {
            for (backend, snapshot) in [
                (self.session.renderer().backend_name(), &runtime),
                ("independent-software", &software),
            ] {
                assert_eq!(
                    pixel(snapshot, sample.x, sample.y),
                    sample.rgba,
                    "{:?} {case} {backend} pixel({}, {})",
                    self.engine,
                    sample.x,
                    sample.y
                );
            }
            let target = if sample.selector == "page" {
                &frame.root
            } else {
                let selected = frame.query(sample.selector, true).unwrap();
                assert_eq!(selected.len(), 1, "{case} {}", sample.selector);
                selected[0]
            };
            // Pixel centers avoid testing a different point from the painter,
            // and every sample stays away from an antialiased curved edge.
            let x = sample.x as f32 + 0.5;
            let y = sample.y as f32 + 0.5;
            assert_eq!(
                frame.root.hit_test(x, y).map(|node| node.id.as_str()),
                Some(target.id.as_str()),
                "{:?} {case} pointer({x}, {y})",
                self.engine
            );
            let identity = target.event_identity.as_ref().unwrap_or(&target.id);
            let result = self.ok(
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":x,"y":y}]}),
            );
            let dispatches = result["dispatches"].as_array().unwrap();
            assert!(!dispatches.is_empty(), "{case} {result}");
            assert!(
                dispatches
                    .iter()
                    .all(|dispatch| dispatch["target"] == *identity),
                "{:?} {case} coordinate event resolved to another target: {result}",
                self.engine
            );
            if sample.selector == "#target" {
                expected_taps.push(json!("target"));
            }
            exported.push(json!({
                "x":sample.x,"y":sample.y,"rgba":sample.rgba,
                "selector":sample.selector,"pointerTarget":identity,
            }));
        }
        assert_eq!(self.call("taps")["taps"], json!(expected_taps), "{case}");
        export_evidence(self.engine, case, &frame, exported);
    }
}

fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let offset = y as usize * snapshot.stride as usize + x as usize * 4;
    snapshot.pixels[offset..offset + 4].try_into().unwrap()
}

fn export_evidence(engine: EngineKind, case: &str, frame: &RenderFrame, samples: Vec<Value>) {
    let Some(directory) = std::env::var_os("WEAPP_CONTAINER_OVERFLOW_EVIDENCE_DIR") else {
        return;
    };
    let directory = std::path::PathBuf::from(directory);
    std::fs::create_dir_all(&directory).expect("create overflow evidence directory");
    let report = json!({
        "schemaVersion":1,"engine":engine_name(engine),"case":case,
        "frame":frame,"samples":samples,
        "scope":"local WXML/WXSS, AppService/View, CPU/software pixels and pointer events",
        "officialDevtools":false,"gpuAcceptance":false,
    });
    std::fs::write(
        directory.join(format!("{}-{case}.json", engine_name(engine))),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .expect("write overflow evidence report");
}

#[test]
fn visible_overflow_keeps_child_pixels_and_native_pointer_handlers() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            BOX_WXML,
            &format!("{BASE_WXSS}#clip{{overflow:visible;}}"),
        );
        fixture.check(
            "visible",
            &[
                sample(32, 32, RED, "#target"),
                sample(52, 32, RED, "#target"),
                sample(32, 52, RED, "#target"),
                sample(52, 52, RED, "#target"),
                sample(16, 16, BLUE, "#clip"),
                sample(80, 80, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn hidden_overflow_clips_painted_descendants_and_coordinate_events() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            BOX_WXML,
            &format!("{BASE_WXSS}#clip{{overflow:hidden;}}"),
        );
        fixture.check(
            "hidden",
            &[
                sample(32, 32, RED, "#target"),
                sample(52, 32, WHITE, "page"),
                sample(32, 52, WHITE, "page"),
                sample(52, 52, WHITE, "page"),
                sample(16, 16, BLUE, "#clip"),
            ],
        );
    }
}

#[test]
fn axis_clips_and_visible_to_auto_conversion_match_pixels_and_input() {
    for engine in engines() {
        for (case, overflow, horizontal, vertical) in [
            ("axis-x-clip", "overflow:clip visible;", WHITE, RED),
            (
                "axis-y-clip",
                "overflow-x:visible;overflow-y:clip;",
                RED,
                WHITE,
            ),
            (
                "axis-visible-hidden",
                "overflow-x:visible;overflow-y:hidden;",
                WHITE,
                WHITE,
            ),
        ] {
            let mut fixture =
                Fixture::new(engine, BOX_WXML, &format!("{BASE_WXSS}#clip{{{overflow}}}"));
            fixture.check(
                case,
                &[
                    sample(32, 32, RED, "#target"),
                    sample(
                        52,
                        32,
                        horizontal,
                        if horizontal == RED { "#target" } else { "page" },
                    ),
                    sample(
                        32,
                        52,
                        vertical,
                        if vertical == RED { "#target" } else { "page" },
                    ),
                    sample(52, 52, WHITE, "page"),
                ],
            );
        }
    }
}

#[test]
fn rounded_background_only_clips_children_when_overflow_requires_it() {
    for engine in engines() {
        for (case, overflow, corner, outside) in [
            ("rounded-hidden", "hidden", WHITE, WHITE),
            ("rounded-visible", "visible", RED, RED),
        ] {
            let mut fixture = Fixture::new(
                engine,
                BOX_WXML,
                &format!(
                    "{BASE_WXSS}#clip{{overflow:{overflow};border-radius:16px;}}#target{{left:-8px;top:-8px;width:48px;height:48px;}}"
                ),
            );
            fixture.check(
                case,
                &[
                    sample(28, 28, RED, "#target"),
                    sample(20, 20, RED, "#target"),
                    sample(
                        13,
                        13,
                        corner,
                        if corner == RED { "#target" } else { "page" },
                    ),
                    sample(
                        8,
                        28,
                        outside,
                        if outside == RED { "#target" } else { "page" },
                    ),
                ],
            );
        }
    }
}

#[test]
fn nested_clips_intersect_without_leaking_into_siblings_or_the_next_frame() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            r#"<view id="outer"><view id="inner"><view id="target" bindtap="onTarget"/></view></view><view id="sibling"/>"#,
            concat!(
                "page{background:#ffffff;}",
                "#outer{position:absolute;left:12px;top:12px;width:48px;height:48px;overflow:hidden;background:#112233;}",
                "#inner{position:absolute;left:32px;top:16px;width:32px;height:40px;overflow:hidden;}",
                "#target{position:absolute;left:-8px;top:-8px;width:48px;height:48px;background:#ff0000;}",
                "#sibling{position:absolute;left:80px;top:20px;width:16px;height:16px;background:#ff0000;}"
            ),
        );
        let samples = [
            sample(48, 36, RED, "#target"),
            sample(64, 36, WHITE, "page"),
            sample(40, 36, BLUE, "#outer"),
            sample(48, 64, WHITE, "page"),
            sample(84, 24, RED, "#sibling"),
        ];
        fixture.check("nested", &samples);
        fixture.render();
        fixture.check("nested-next-frame", &samples);
    }
}

#[test]
fn transformed_clip_uses_local_shape_rather_than_its_world_bounding_box() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            BOX_WXML,
            &format!(
                "{BASE_WXSS}#clip{{overflow:hidden;transform-origin:0 0;transform:translate(40px,8px) rotate(45deg);}}"
            ),
        );
        fixture.check(
            "transformed",
            &[
                sample(52, 54, RED, "#target"),
                // Inside the parent's world AABB and the child's diamond,
                // outside the actual rotated ancestor clip.
                sample(64, 60, WHITE, "page"),
                sample(40, 60, WHITE, "page"),
                sample(52, 78, WHITE, "page"),
            ],
        );
    }
}

#[test]
fn invalid_render_retains_the_accepted_clipped_pixels_and_input_tree() {
    for engine in engines() {
        let mut fixture = Fixture::new(
            engine,
            BOX_WXML,
            &format!("{BASE_WXSS}#clip{{overflow:hidden;}}"),
        );
        let previous = fixture.session.renderer().last_frame().unwrap().clone();
        let snapshot = fixture.session.renderer().snapshot();
        let mut missing_style = fixture.blobs.clone();
        missing_style.remove(&fixture.style_pointer).unwrap();
        let response = fixture.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"viewport":{"width":128,"height":128},"blobs":missing_style}),
        );
        assert_eq!(
            response.messages[0].payload["error"]["code"], "ERR_RENDER",
            "{response:?}"
        );
        assert_eq!(fixture.session.renderer().last_frame(), Some(&previous));
        assert_eq!(fixture.session.renderer().snapshot(), snapshot);
        fixture.check(
            "retained-after-error",
            &[
                sample(32, 32, RED, "#target"),
                sample(52, 32, WHITE, "page"),
                sample(32, 52, WHITE, "page"),
            ],
        );
        fixture.render();
        fixture.check(
            "recovered-after-error",
            &[
                sample(32, 32, RED, "#target"),
                sample(52, 32, WHITE, "page"),
            ],
        );
    }
}
