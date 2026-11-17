//! Real App/Page → WXSS → accepted frame, pixels, geometry and input.
//! These local native-engine and CPU/software contracts do not certify the
//! simulator refresh loop, official DevTools, GPU surfaces or physical devices.
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

const SESSION: &str = "group-opacity-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = "module:app.js";
const PAGE: &str = "module:pages/index/index.js";
const WHITE: [u8; 4] = [255, 255, 255, 255];
const RED: [u8; 4] = [255, 0, 0, 255];
const BLUE: [u8; 4] = [0, 0, 255, 255];
const HALF_RED: [u8; 4] = [255, 127, 127, 255];
const HALF_BLUE: [u8; 4] = [127, 127, 255, 255];
const QUARTER_BLUE: [u8; 4] = [191, 191, 255, 255];
const APP_JS: &str = r#"App({events:[]});
exports.state=function(){return {events:getApp().events.slice(),rects:globalThis.__opacityRects};};"#;
const PAGE_JS: &str = r#"var page;
Page({
  data:{opacity:1,tapCount:0},
  onLoad:function(){page=this;},
  onTap:function(event){
    getApp().events.push({type:event.type,target:event.target.id});
    this.setData({tapCount:this.data.tapCount+1});
  },
  onTouch:function(event){getApp().events.push({type:event.type,target:event.target.id});}
});
exports.patch=function(data){page.setData(data);};
exports.inspect=function(selector){
  var query=wx.createSelectorQuery();
  query.selectAll(selector).boundingClientRect();
  query.exec(function(values){globalThis.__opacityRects=values[0];});
};"#;
const OVERLAP_WXML: &str = r#"<view id="group" style="opacity:{{opacity}}">
  <view id="red" class="item" bindtap="onTap"/>
  <view id="blue" class="item" bindtap="onTap" bindtouchstart="onTouch"
    bindtouchend="onTouch" bindtouchcancel="onTouch"/>
</view>"#;
const OVERLAP_WXSS: &str = "#group{position:absolute;left:10px;top:10px;width:40px;height:40px}.item{position:absolute;width:30px;height:30px}#red{left:0;top:0;background:red}#blue{left:10px;top:10px;background:blue}";

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
        manifest.compiler.commit = "local-group-opacity-contract".into();
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
            bindings: vec!["opacity".into(), "tapCount".into()],
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
            format!("opacity-{}", self.sequence),
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
        // Exercise the host publication boundary using live Page data and
        // verified session blobs, without injecting resolved node properties.
        let frame_id = self.sequence + 1;
        self.request(
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"frameId":frame_id,"useSessionResources":true,
                "viewport":{"width":160,"height":160}}),
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

    fn set_opacity(&mut self, opacity: Value) {
        let rendered = self.patch(json!({"opacity":opacity}));
        self.assert_ok(op::RENDER_COMMIT, &rendered);
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

    fn touch(&mut self, kind: &str) {
        let touch = json!({"identifier":7,"clientX":25.5,"clientY":25.5,"pageX":25.5,"pageY":25.5});
        let touches = if kind == "touchstart" {
            json!([touch])
        } else {
            json!([])
        };
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":kind,"x":25.5,"y":25.5,"timeStamp":100,
                "touches":touches,"changedTouches":[touch]}]}),
        );
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

    fn check(&self, case: &str, samples: &[(u32, u32, [u8; 4], &str)]) {
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
                let actual = pixel(pixels, x, y);
                for (actual_channel, expected_channel) in actual.into_iter().zip(expected) {
                    assert!(
                        actual_channel.abs_diff(expected_channel) <= 1,
                        "{:?} {case} {backend} ({x},{y}): {:?} != {:?}",
                        self.engine,
                        pixel(pixels, x, y),
                        expected
                    );
                }
            }
            assert_eq!(
                frame
                    .root
                    .hit_test(x as f32 + 0.5, y as f32 + 0.5)
                    .map(|node| node.id.as_str()),
                Some(target),
                "{:?} {case} input({x},{y})",
                self.engine
            );
        }
        if let Some(directory) = std::env::var_os("WEAPP_CONTAINER_OPACITY_EVIDENCE_DIR") {
            let directory = std::path::PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            let engine = match self.engine {
                EngineKind::Quickjs => "quickjs",
                EngineKind::V8 => "v8",
            };
            let stem = format!("{engine}-{case}");
            let samples: Vec<_> = samples
                .iter()
                .map(|(x, y, rgba, target)| json!({"x":x,"y":y,"rgba":rgba,"target":target}))
                .collect();
            let value = json!({"schemaVersion":1,"case":case,"engine":engine,"frame":frame,
                "samples":samples,"sampleTolerance":1,
                "snapshot":{"width":snapshot.width,"height":snapshot.height,"stride":snapshot.stride,
                    "format":snapshot.format,"runtimeBackend":self.session.renderer().backend_name(),
                    "runtimeSha256":hex_digest(&snapshot.pixels),
                    "softwareSha256":hex_digest(&software.pixels)},
                "scope":"local AppService/View, WXSS, CPU/software pixels, geometry and input",
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
fn page_set_data_recomposites_overlapping_descendants_once_per_group() {
    for engine in engines() {
        let mut f = Fixture::new(engine, OVERLAP_WXML, OVERLAP_WXSS);
        f.check("opaque", &[(15, 15, RED, "red"), (25, 25, BLUE, "blue")]);
        let initial_frame = f.frame().frame_id;
        f.set_opacity(json!(0.5));
        assert!(f.frame().frame_id > initial_frame);
        assert_eq!(f.node("#group").opacity, 0.5);
        assert_eq!(f.node("#red").opacity, 1.0);
        assert_eq!(f.node("#blue").opacity, 1.0);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["opacity"],
            0.5
        );
        // At the overlap, opaque blue covers red before the whole subtree
        // receives alpha 128. Primitive-by-primitive attenuation leaves red.
        f.check(
            "half",
            &[(15, 15, HALF_RED, "red"), (25, 25, HALF_BLUE, "blue")],
        );
        f.set_opacity(json!(0.25));
        f.check("quarter", &[(25, 25, QUARTER_BLUE, "blue")]);
        f.set_opacity(json!(1));
        f.check("restored", &[(15, 15, RED, "red"), (25, 25, BLUE, "blue")]);
    }
}

#[test]
fn zero_opacity_retains_coordinate_events_selector_geometry_and_page_state() {
    for engine in engines() {
        let mut f = Fixture::new(engine, OVERLAP_WXML, OVERLAP_WXSS);
        let item_rects = f.query(".item");
        let group_rects = f.query("#group");
        assert_eq!(item_rects.as_array().unwrap().len(), 2);
        assert_eq!(item_rects[1]["left"], 20.0);
        assert_eq!(item_rects[1]["top"], 20.0);
        assert_eq!(item_rects[1]["width"], 30.0);
        assert_eq!(item_rects[1]["height"], 30.0);
        f.set_opacity(json!(0));
        f.check("zero", &[(15, 15, WHITE, "red"), (25, 25, WHITE, "blue")]);
        assert_eq!(f.query(".item"), item_rects);
        assert_eq!(f.query("#group"), group_rects);
        f.tap(25.5, 25.5);
        assert_eq!(f.state()["events"], json!([{"type":"tap","target":"blue"}]));
        let page = f.session.app_service().pages().current().unwrap();
        assert_eq!(page.data["tapCount"], 1);
        assert_eq!(page.data["opacity"], 0);
        f.check("zero-after-tap", &[(25, 25, WHITE, "blue")]);
        assert_eq!(f.query(".item"), item_rects);
    }
}

#[test]
fn making_a_captured_target_transparent_keeps_its_touch_route() {
    for engine in engines() {
        let mut f = Fixture::new(engine, OVERLAP_WXML, OVERLAP_WXSS);
        f.touch("touchstart");
        f.set_opacity(json!(0));
        f.touch("touchend");
        assert_eq!(
            f.state()["events"],
            json!([{"type":"touchstart","target":"blue"},{"type":"touchend","target":"blue"}]),
            "{engine:?}: opacity alone must not cancel a captured contact"
        );
        f.check("zero-after-touch", &[(25, 25, WHITE, "blue")]);
    }
}

#[test]
fn nested_groups_attenuate_already_composited_descendants() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="group" style="opacity:{{opacity}}"><view id="inner"><view id="red"/><view id="blue"/></view></view>"#,
            "#group{position:absolute;left:10px;top:10px;width:40px;height:40px;background:red}#inner{position:absolute;left:0;top:0;width:40px;height:40px;opacity:.5}#red,#blue{position:absolute;width:30px;height:30px}#red{left:0;top:0;background:red}#blue{left:10px;top:10px;background:blue}");
        f.check(
            "nested-outer-opaque",
            &[(25, 25, [127, 0, 128, 255], "blue")],
        );
        f.set_opacity(json!(0.5));
        assert_eq!(f.node("#group").opacity, 0.5);
        assert_eq!(f.node("#inner").opacity, 0.5);
        assert_eq!(f.node("#blue").opacity, 1.0);
        f.check(
            "nested-half",
            &[
                (15, 15, HALF_RED, "red"),
                (25, 25, [191, 127, 191, 255], "blue"),
                (15, 45, HALF_RED, "inner"),
            ],
        );
    }
}

#[test]
fn percent_and_css_wide_values_resolve_before_group_composition() {
    for engine in engines() {
        let mut f = Fixture::new(engine,
            r#"<view id="group" style="opacity:{{opacity}}"><view id="inherited" class="item" style="opacity:inherit"/><view id="unset" class="item" style="opacity:unset"/><view id="initial" class="item" style="opacity:initial"/><view id="default" class="item"/></view>"#,
            "#group{position:absolute;left:10px;top:10px;width:80px;height:20px}.item{position:absolute;top:0;width:20px;height:20px;background:blue}#inherited{left:0}#unset{left:20px}#initial{left:40px}#default{left:60px}");
        f.set_opacity(json!("50%"));
        assert_eq!(f.node("#group").opacity, 0.5);
        for (id, expected) in [
            ("inherited", 0.5),
            ("unset", 1.0),
            ("initial", 1.0),
            ("default", 1.0),
        ] {
            assert_eq!(
                f.node(&format!("#{id}")).opacity,
                expected,
                "{engine:?} {id}"
            );
        }
        f.check(
            "percent-and-css-wide",
            &[
                (15, 15, QUARTER_BLUE, "inherited"),
                (35, 15, HALF_BLUE, "unset"),
                (55, 15, HALF_BLUE, "initial"),
                (75, 15, HALF_BLUE, "default"),
            ],
        );
        for (label, value, expected, pixel) in [
            ("overflow-clamps", "1e39", 1.0, [0, 0, 255, 255]),
            ("negative-overflow-clamps", "-1e39", 0.0, WHITE),
            ("underflow-clamps", "1e-46", 0.0, WHITE),
            ("double-overflow-clamps", "1e999", 1.0, [0, 0, 255, 255]),
            ("double-underflow-clamps", "1e-999", 0.0, WHITE),
        ] {
            f.set_opacity(json!(value));
            assert_eq!(f.node("#group").opacity, expected, "{engine:?}: {value}");
            f.check(label, &[(75, 15, pixel, "default")]);
        }
    }
}

#[test]
fn invalid_explicit_group_frame_preserves_accepted_pixels_input_and_geometry() {
    for engine in engines() {
        let mut f = Fixture::new(engine, OVERLAP_WXML, OVERLAP_WXSS);
        f.set_opacity(json!(0.5));
        let accepted = f.frame().clone();
        let snapshot = f.session.renderer().snapshot();
        let rects = f.query(".item");
        let view_frame = f.session.view().last_frame_id;
        let mut invalid = serde_json::to_value(&accepted).unwrap();
        invalid["frame_id"] = json!(f.sequence + 1);
        invalid["root"]["opacity"] = json!(2);
        let rejected = f.request(op::RENDER_COMMIT, json!({"frame":invalid}));
        assert_eq!(
            rejected["error"]["code"], "ERR_RENDER",
            "{engine:?}: {rejected}"
        );
        assert_eq!(f.frame(), &accepted);
        assert_eq!(f.session.renderer().snapshot(), snapshot);
        assert_eq!(f.session.view().last_frame_id, view_frame);
        assert_eq!(f.query(".item"), rects);
        f.check("rejected-explicit-frame", &[(25, 25, HALF_BLUE, "blue")]);
        f.tap(25.5, 25.5);
        assert_eq!(f.state()["events"], json!([{"type":"tap","target":"blue"}]));
        f.check("recovered-after-rejection", &[(25, 25, HALF_BLUE, "blue")]);
    }
}

#[test]
fn deferred_opacity_rejects_without_publishing_and_a_valid_page_patch_recovers() {
    for engine in engines() {
        let mut f = Fixture::new(engine, OVERLAP_WXML, OVERLAP_WXSS);
        f.set_opacity(json!(0.5));
        for (index, deferred) in [
            "calc(50% * 1)",
            "calc(50% / 2)",
            "calc(2 * 25%)",
            "var(--alpha)",
            "env(alpha, .5)",
            "revert",
            "revert-layer",
        ]
        .into_iter()
        .enumerate()
        {
            let accepted = f.frame().clone();
            let snapshot = f.session.renderer().snapshot();
            let rects = f.query(".item");
            let view_frame = f.session.view().last_frame_id;
            let rejected = f.patch(json!({"opacity":deferred}));
            assert_eq!(
                rejected["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
                "{engine:?} {deferred}: {rejected}"
            );
            assert_eq!(
                f.session.app_service().pages().current().unwrap().data["opacity"],
                deferred
            );
            assert_eq!(f.frame(), &accepted);
            assert_eq!(f.session.renderer().snapshot(), snapshot);
            assert_eq!(f.session.view().last_frame_id, view_frame);
            assert_eq!(f.query(".item"), rects);
            f.check(
                &format!("rejected-deferred-{index}"),
                &[(25, 25, HALF_BLUE, "blue")],
            );

            // Keep interacting with the last accepted input tree while the
            // current Page contains an unsupported style. The Session does
            // not implicitly replace that tree when the listener sets data.
            f.ok(
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":25.5,"y":25.5}]}),
            );
            let state = f.state();
            assert_eq!(state["events"].as_array().unwrap().len(), index + 1);
            assert_eq!(
                state["events"][index],
                json!({"type":"tap","target":"blue"})
            );
            assert_eq!(f.frame(), &accepted);
            assert_eq!(f.session.renderer().snapshot(), snapshot);

            f.set_opacity(json!(0.5));
            assert!(f.frame().frame_id > accepted.frame_id);
            assert_eq!(f.query(".item"), rects);
            f.check(
                &format!("recovered-deferred-{index}"),
                &[(25, 25, HALF_BLUE, "blue")],
            );
        }
    }
}
