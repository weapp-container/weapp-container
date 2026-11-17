//! Session-local render-resource reuse through the public bridge. These
//! native engine contracts are auxiliary evidence, not DevTools parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{PageRenderMode, PortableFontData, Rect, RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP_MODULE: &str = "module:app.js";
const APP: &str = r#"
App({created:0,attached:0});
function current() { const pages=getCurrentPages(); return pages[pages.length-1]; }
exports.patch=function(value) { current().setData(value); return current().data; };
exports.stats=function() { return {created:getApp().created,attached:getApp().attached}; };
exports.remember=function() { getApp().remembered=current(); };
exports.same=function() { return getApp().remembered===current(); };
exports.patchCard=function(value) { getApp().card.setData(value); return true; };
exports.poisonCardSnapshot=function() {
  Object.defineProperty(getApp().card.data,'trap',{enumerable:true,get:function(){getApp().trapReads=(getApp().trapReads||0)+1;return 1;}});
  getApp().card.setData({local:43});
};
exports.trapReads=function() { return getApp().trapReads||0; };
exports.installArrayJsonHook=function() {
  getApp().jsonHooks=0;
  Array.prototype.toJSON=function(){getApp().jsonHooks++;return this;};
};
exports.readArrayJsonHooks=function() { const result=getApp().jsonHooks;getApp().jsonHooks=0;return result; };
exports.removeArrayJsonHook=function() { delete Array.prototype.toJSON; };
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
}

impl Fixture {
    fn start(engine: EngineKind, id: &str, preload: bool) -> Self {
        Self::start_with_markup(
            engine,
            id,
            preload,
            r#"<view><text id="count">{{count}}</text><block wx:if="{{show}}"><card/></block></view>"#,
            "text {width:80px; height:20px; color:red;}",
        )
    }

    fn start_with_markup(
        engine: EngineKind,
        id: &str,
        preload: bool,
        wxml: &str,
        wxss: &str,
    ) -> Self {
        Self::start_with_markup_and_font(engine, id, preload, wxml, wxss, None)
    }

    fn start_with_markup_and_font(
        engine: EngineKind,
        id: &str,
        preload: bool,
        wxml: &str,
        wxss: &str,
        font: Option<PortableFontData>,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "session-render-resource-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        manifest.routes.push(Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: Some(format!("{ROUTE}.json")),
            entry_module: "module:pages/index/index.js".into(),
        });
        manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
            multiple_slots: None,
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP_MODULE, APP, ModuleScope::App),
            (
                "module:pages/index/index.js",
                "Page({data:{count:1,show:false}});",
                ModuleScope::Page,
            ),
            (
                "module:components/card/index.js",
                r#"Component({lifetimes:{
                created:function(){getApp().created++;getApp().card=this;},
                attached:function(){getApp().attached++;}
            }});"#,
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
            (TEMPLATE, wxml),
            (
                "template:components/card/index.wxml",
                "<view>card<text id=\"card-local\">{{local}}</text></view>",
            ),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: vec!["count".into(), "show".into()],
                wxs_modules: BTreeMap::new(),
            });
            blobs.insert(pointer, bytes);
        }
        let style = parse_wxss(wxss).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: pointer.clone(),
            scope: StyleScope::App,
        });
        blobs.insert(pointer, style);
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: id.into(),
                    require_integrity: true,
                    page_render_mode: if font.is_some() {
                        PageRenderMode::ExternalFrame
                    } else {
                        PageRenderMode::Raster
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
            blobs,
            sequence: 0,
        };
        if let Some(font) = font {
            fixture.session.install_portable_text_font(font).unwrap();
        }
        let mut init = json!({"modules":modules});
        if preload {
            init["blobs"] = json!(fixture.blobs);
        }
        let initialized = fixture.ok(op::APP_INIT, init);
        assert_eq!(initialized["engineProviderAvailable"], true);
        assert_eq!(initialized["loadedModules"], 3);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let request_id = format!("resources-{}", self.sequence);
        let batch = self.session.dispatch(BridgeEnvelope::request(
            self.session.config().session_id.clone(),
            &request_id,
            operation,
            payload,
        ));
        let response = batch.messages.first().expect("one correlated response");
        assert_eq!(response.op, operation, "{batch:?}");
        assert_eq!(response.request_id, request_id);
        assert_eq!(response.session_id, self.session.config().session_id);
        response.payload.clone()
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.dispatch(operation, payload);
        assert_eq!(response["ok"], true, "{operation}: {response}");
        response
    }

    fn call(&mut self, name: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":name,"args":args}),
        )["result"][0]
            .clone()
    }

    fn payload(frame_id: u64) -> Value {
        json!({"templateId":TEMPLATE,"frameId":frame_id,"viewport":{"width":120,"height":80}})
    }

    fn reuse(&mut self, frame_id: u64) -> Value {
        let mut payload = Self::payload(frame_id);
        payload["useSessionResources"] = json!(true);
        self.dispatch(op::RENDER_COMMIT, payload)
    }

    fn explicit(&mut self, frame_id: u64) -> Value {
        let mut payload = Self::payload(frame_id);
        payload["blobs"] = json!(self.blobs);
        self.dispatch(op::RENDER_COMMIT, payload)
    }

    fn retained(&self) -> Value {
        json!({
            "frame":self.session.renderer().last_frame(),
            "pixels":self.session.renderer().snapshot(),
            "view":self.session.view(),
            "pages":self.session.app_service().pages().iter().collect::<Vec<_>>(),
        })
    }

    fn count_text(&self) -> String {
        self.query_text("#count")
    }

    fn query_text(&self, selector: &str) -> String {
        fn text(node: &RenderNode, output: &mut String) {
            if let Some(value) = &node.text {
                output.push_str(value);
            }
            for child in &node.children {
                text(child, output);
            }
        }
        let frame = self.session.renderer().last_frame().unwrap();
        let nodes = frame.query(selector, false).unwrap();
        let mut result = String::new();
        text(nodes.first().unwrap(), &mut result);
        result
    }
}

fn rejected(response: &Value, code: &str) {
    assert_eq!(response["ok"], false, "{response}");
    assert_eq!(response["committed"], false, "{response}");
    assert_eq!(response["error"]["code"], code, "{response}");
}

fn style_candidate(fixture: &Fixture, source: &str) -> (Session, Value) {
    let mut manifest = fixture.session.manifest().clone();
    let mut blobs = fixture.blobs.clone();
    let bytes = parse_wxss(source).unwrap().canonical_json().unwrap();
    let pointer = format!("sha256:{}", hex_digest(&bytes));
    manifest.styles[0].wxss_ir = pointer.clone();
    blobs.insert(pointer, bytes);
    manifest.refresh_integrity().unwrap();
    let candidate = Session::new(manifest, fixture.session.config().clone()).unwrap();
    let mut payload = Fixture::payload(2);
    payload["blobs"] = json!(blobs);
    (candidate, payload)
}

// A deterministic metrics-only SFNT for the external painter contract. Its
// three glyphs are .notdef, space and W; W advances exactly 900/1000 em.
fn portable_font_fixture() -> PortableFontData {
    let mut head = vec![0; 54];
    head[18..20].copy_from_slice(&1000_u16.to_be_bytes());
    let mut hhea = vec![0; 36];
    hhea[4..6].copy_from_slice(&800_i16.to_be_bytes());
    hhea[6..8].copy_from_slice(&(-200_i16).to_be_bytes());
    hhea[34..36].copy_from_slice(&3_u16.to_be_bytes());
    let mut maxp = vec![0, 0, 0x50, 0];
    maxp.extend_from_slice(&3_u16.to_be_bytes());
    let mut hmtx = Vec::new();
    for advance in [500_u16, 300, 900] {
        hmtx.extend_from_slice(&advance.to_be_bytes());
        hmtx.extend_from_slice(&0_i16.to_be_bytes());
    }
    let mut cmap = vec![0, 0, 0, 1, 0, 3, 0, 10, 0, 0, 0, 12];
    cmap.extend_from_slice(&12_u16.to_be_bytes());
    cmap.extend_from_slice(&0_u16.to_be_bytes());
    cmap.extend_from_slice(&40_u32.to_be_bytes());
    cmap.extend_from_slice(&0_u32.to_be_bytes());
    cmap.extend_from_slice(&2_u32.to_be_bytes());
    for (character, glyph) in [(32_u32, 1_u32), (87, 2)] {
        cmap.extend_from_slice(&character.to_be_bytes());
        cmap.extend_from_slice(&character.to_be_bytes());
        cmap.extend_from_slice(&glyph.to_be_bytes());
    }
    let tables = [
        (*b"cmap", cmap),
        (*b"head", head),
        (*b"hhea", hhea),
        (*b"hmtx", hmtx),
        (*b"maxp", maxp),
    ];
    let mut bytes = vec![0; 12 + tables.len() * 16];
    bytes[..4].copy_from_slice(&0x0001_0000_u32.to_be_bytes());
    bytes[4..6].copy_from_slice(&(tables.len() as u16).to_be_bytes());
    for (index, (tag, table)) in tables.into_iter().enumerate() {
        let record = 12 + index * 16;
        bytes[record..record + 4].copy_from_slice(&tag);
        let offset = bytes.len() as u32;
        bytes[record + 8..record + 12].copy_from_slice(&offset.to_be_bytes());
        bytes[record + 12..record + 16].copy_from_slice(&(table.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&table);
        while !bytes.len().is_multiple_of(4) {
            bytes.push(0);
        }
    }
    let digest = hex_digest(&bytes);
    PortableFontData::new(bytes.into(), &digest).unwrap()
}

#[test]
fn atomic_style_candidate_uses_live_font_metrics_and_density_without_replacing_the_owner() {
    fn text_layout(node: &RenderNode) -> Option<&container_render_skia::TextLayout> {
        node.text_layout
            .as_ref()
            .or_else(|| node.children.iter().find_map(text_layout))
    }
    for engine in engines() {
        let font = portable_font_fixture();
        let font_identity = font.identity();
        let mut fixture = Fixture::start_with_markup_and_font(
            engine,
            "atomic-style-host-font",
            true,
            r#"<text id="count">WWW</text>"#,
            "text {font-size:20px;color:red;}",
            Some(font),
        );
        fixture
            .session
            .stage_skia_render_target(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 120.0,
                    height: 80.0,
                },
                2.0,
            )
            .unwrap();
        assert_eq!(fixture.reuse(1)["committed"], true);
        let initial = text_layout(&fixture.session.renderer().last_frame().unwrap().root)
            .unwrap()
            .clone();
        assert_eq!(
            initial.measurement,
            container_render_skia::TextMeasurement::Font(font_identity)
        );
        assert!((initial.metrics.width - 54.0).abs() < 0.001);
        let renderer = std::ptr::from_ref(fixture.session.renderer());
        let (mut candidate, payload) =
            style_candidate(&fixture, "text {font-size:20px;color:blue;}");
        fixture
            .session
            .replace_dev_presentation(&mut candidate, &payload)
            .unwrap();
        assert_eq!(std::ptr::from_ref(fixture.session.renderer()), renderer);
        assert_eq!(
            text_layout(&fixture.session.renderer().last_frame().unwrap().root),
            Some(&initial)
        );
        assert_eq!(fixture.session.renderer().render_scale(), 2.0);
        assert_eq!(
            fixture.session.renderer().accepted_render_scale(),
            Some(2.0)
        );
        let target = fixture.session.renderer().accepted_render_target().unwrap();
        assert_eq!((target.width, target.height), (240, 160));

        let before = fixture.retained();
        let manifest = fixture.session.manifest().clone();
        let lifetime = fixture.session.input_lifetime_revision();
        let (candidate, mut payload) =
            style_candidate(&fixture, "text {font-size:20px;color:green;}");
        let mut invalid_manifest = candidate.manifest().clone();
        let bytes = parse_wxml(r#"<text id="count">WWZ</text>"#)
            .unwrap()
            .canonical_json()
            .unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        invalid_manifest.templates[0].wxml_ast = pointer.clone();
        invalid_manifest.refresh_integrity().unwrap();
        payload["blobs"][pointer] = json!(bytes);
        let mut rejected =
            Session::new(invalid_manifest, fixture.session.config().clone()).unwrap();
        let error = fixture
            .session
            .replace_dev_presentation(&mut rejected, &payload)
            .unwrap_err();
        assert!(error.message.contains("does not cover U+005A"), "{error}");
        assert_eq!(fixture.retained(), before);
        assert_eq!(fixture.session.manifest(), &manifest);
        assert_eq!(fixture.session.input_lifetime_revision(), lifetime);
        assert_eq!(fixture.session.renderer().render_scale(), 2.0);
        assert_eq!(
            fixture.session.renderer().accepted_render_target(),
            Some(target)
        );
    }
}

#[test]
fn atomic_style_replacement_retains_js_component_storage_and_exact_input() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "atomic-style", true);
        fixture.call("patch", json!([{"count":42,"show":true}]));
        fixture.call("remember", json!([]));
        fixture
            .session
            .app_service_mut()
            .storage_mut()
            .set("persisted", json!({"value":7}))
            .unwrap();
        assert_eq!(fixture.reuse(1)["committed"], true);
        let page = fixture
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .clone();
        let old_pixels = fixture.session.renderer().snapshot().unwrap().pixels;
        let (mut candidate, payload) = style_candidate(
            &fixture,
            "text {width:80px; height:20px; color:blue; background-color:blue;}",
        );
        let batch = fixture
            .session
            .replace_dev_presentation(&mut candidate, &payload)
            .unwrap();
        assert!(batch
            .messages
            .iter()
            .any(|message| { message.payload["data"]["generation"] == 1 }));
        assert_eq!(fixture.count_text(), "42");
        assert!(fixture.session.renderer().snapshot().unwrap().pixels != old_pixels);
        assert_eq!(fixture.session.app_service().pages().current(), Some(&page));
        assert_eq!(fixture.call("same", json!([])), true);
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
        assert_eq!(
            fixture.session.app_service().storage().get("persisted"),
            Some(&json!({"value":7}))
        );
        let input: Value = serde_json::from_slice(
            &fixture
                .session
                .last_frame_input_json(fixture.session.render_revision())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(input["consumedInput"]["pageId"], page.id.0.to_string());
        assert!(fixture.session.can_reuse_render_resources());
        fixture.call("patch", json!([{"count":43}]));
        assert_eq!(fixture.reuse(3)["committed"], true);
        assert_eq!(fixture.count_text(), "43");
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
    }
}

#[test]
fn rejected_style_candidate_keeps_the_complete_accepted_generation_usable() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "atomic-style-reject", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        for source in [
            "@import './missing.wxss';",
            "text {font-size:calc(10px + 1px);}",
        ] {
            let (mut candidate, payload) = style_candidate(&fixture, source);
            let before = fixture.retained();
            let manifest = fixture.session.manifest().clone();
            let document = fixture.session.view_document().cloned();
            let revision = fixture.session.render_revision();
            let input = fixture.session.last_frame_input_json(revision).unwrap();
            let lifetime = fixture.session.input_lifetime_revision();
            assert!(fixture
                .session
                .replace_dev_presentation(&mut candidate, &payload)
                .is_err());
            assert_eq!(fixture.retained(), before, "{engine:?}: {source}");
            assert_eq!(fixture.session.manifest(), &manifest);
            assert_eq!(fixture.session.view_document(), document.as_ref());
            assert_eq!(fixture.session.render_revision(), revision);
            assert_eq!(
                fixture.session.last_frame_input_json(revision).unwrap(),
                input
            );
            assert_eq!(fixture.session.input_lifetime_revision(), lifetime);
            assert!(fixture.session.can_reuse_render_resources());
        }
        assert_eq!(fixture.reuse(3)["committed"], true);
        assert_eq!(fixture.count_text(), "1");
    }
}

#[test]
fn incomplete_inactive_presentation_closure_is_rejected_before_publication() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "atomic-style-closure", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        let (candidate, payload) = style_candidate(&fixture, "text {color:blue;}");
        let mut manifest = candidate.manifest().clone();
        manifest.assets.push(container_ir::Asset {
            path: "assets/inactive.txt".into(),
            sha256: hex_digest(b"inactive asset"),
            mime: "text/plain".into(),
            size: 14,
        });
        manifest.refresh_integrity().unwrap();
        let mut candidate = Session::new(manifest, fixture.session.config().clone()).unwrap();
        let before = fixture.retained();
        let error = fixture
            .session
            .replace_dev_presentation(&mut candidate, &payload)
            .unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Render);
        assert_eq!(fixture.retained(), before);
        assert!(fixture.session.can_reuse_render_resources());
        assert_eq!(fixture.reuse(3)["committed"], true);
    }
}

#[test]
fn pending_component_mutation_is_captured_without_publishing_a_rejected_candidate() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "atomic-style-pending-component", true);
        fixture.call("patch", json!([{"show":true}]));
        assert_eq!(fixture.reuse(1)["committed"], true);
        assert_eq!(fixture.call("patchCard", json!([{"local":42}])), true);
        fixture.call("installArrayJsonHook", json!([]));
        fixture.call("readArrayJsonHooks", json!([]));
        let ordinary_hooks = fixture.call("readArrayJsonHooks", json!([]));
        let before = fixture.retained();
        let revision = fixture.session.render_revision();
        let input = fixture.session.last_frame_input_json(revision).unwrap();
        let lifetime = fixture.session.input_lifetime_revision();
        let manifest = fixture.session.manifest().clone();
        let (rejected, mut payload) = style_candidate(&fixture, "text {color:blue;}");
        let mut invalid_manifest = rejected.manifest().clone();
        let bytes = parse_wxml(
            r#"<view><text id="count">{{count + }}</text><block wx:if="{{show}}"><card/></block></view>"#,
        ).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        invalid_manifest.templates[0].wxml_ast = pointer.clone();
        invalid_manifest.refresh_integrity().unwrap();
        payload["blobs"][pointer] = json!(bytes);
        let mut rejected =
            Session::new(invalid_manifest, fixture.session.config().clone()).unwrap();
        assert!(fixture
            .session
            .replace_dev_presentation(&mut rejected, &payload)
            .is_err());
        assert_eq!(
            fixture.call("readArrayJsonHooks", json!([])),
            ordinary_hooks,
            "rejected candidate must not execute inherited toJSON in the live realm"
        );
        fixture.call("removeArrayJsonHook", json!([]));
        assert_eq!(fixture.retained(), before);
        assert_eq!(fixture.session.manifest(), &manifest);
        assert_eq!(
            fixture.session.last_frame_input_json(revision).unwrap(),
            input
        );
        assert_eq!(fixture.session.input_lifetime_revision(), lifetime);
        assert_eq!(fixture.query_text("#card-local"), "");
        let (mut candidate, payload) = style_candidate(&fixture, "text {color:blue;}");
        fixture
            .session
            .replace_dev_presentation(&mut candidate, &payload)
            .unwrap();
        assert_eq!(fixture.query_text("#card-local"), "42");
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
    }
}

#[test]
fn development_snapshot_rejection_never_reads_a_live_component_accessor() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "atomic-style-component-accessor", true);
        fixture.call("patch", json!([{"show":true}]));
        assert_eq!(fixture.reuse(1)["committed"], true);
        fixture.call("poisonCardSnapshot", json!([]));
        let before = fixture.retained();
        let reads = fixture.call("trapReads", json!([]));
        assert_eq!(reads, 0);
        let (mut candidate, payload) = style_candidate(&fixture, "text {color:blue;}");
        let error = fixture
            .session
            .replace_dev_presentation(&mut candidate, &payload)
            .unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Cancelled);
        assert_eq!(fixture.retained(), before);
        assert_eq!(fixture.call("trapReads", json!([])), reads);
    }
}

#[test]
fn js_typography_updates_share_geometry_and_retain_the_accepted_frame_on_rejection() {
    for engine in engines() {
        let mut fixture = Fixture::start_with_markup(
            engine,
            "text-state",
            true,
            r#"<text id="count" style="font-size:{{font}}">{{count}}</text>"#,
            "text {font-size:12px;line-height:1.5;width:80px;color:red;}",
        );
        fixture.ok(
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"frameId":1,"useSessionResources":true}),
        );
        let inspect = |fixture: &Fixture, expected_size: f32, expected_height: f32| {
            let frame = fixture.session.renderer().last_frame().unwrap();
            let nodes = frame.query("#count", false).unwrap();
            let node = nodes[0];
            assert_eq!(node.text_style.unwrap().font_size, expected_size);
            assert_eq!(
                node.computed_style["font-size"],
                format!("{expected_size}px")
            );
            assert_eq!(node.bounds.height, expected_height);
            assert_eq!(node.children[0].text_style, node.text_style);
            assert_eq!(
                node.children[0]
                    .text_layout
                    .as_ref()
                    .unwrap()
                    .metrics
                    .height,
                expected_height
            );
        };
        inspect(&fixture, 12.0, 18.0);
        fixture.call("patch", json!([{"count":2,"font":"20px"}]));
        assert_eq!(fixture.reuse(2)["ok"], true);
        inspect(&fixture, 20.0, 30.0);
        fixture.call("patch", json!([{"font":"calc(10px + 1px)"}]));
        let before = fixture.retained();
        rejected(&fixture.reuse(3), "ERR_UNSUPPORTED_CAPABILITY");
        assert_eq!(
            fixture.retained(),
            before,
            "unimplemented typography must not replace accepted pixels, geometry or metadata"
        );
        fixture.call("patch", json!([{"font":"calc(red)"}]));
        assert_eq!(fixture.reuse(4)["ok"], true);
        inspect(&fixture, 12.0, 18.0);
    }
}

#[test]
fn init_preload_renders_first_and_updated_js_page_without_resending_blobs() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "preloaded", true);
        let page = fixture.session.app_service().pages().current().unwrap().id;
        let first = fixture.reuse(1);
        assert_eq!(first["committed"], true, "{engine:?}: {first}");
        assert_eq!(first["source"], "manifest");
        assert_eq!(fixture.count_text(), "1");
        let updated = fixture.call("patch", json!([{"count":42}]));
        assert_eq!(updated["count"], 42);
        let second = fixture.reuse(2);
        assert_eq!(second["committed"], true, "{engine:?}: {second}");
        assert_eq!(fixture.count_text(), "42");
        assert_eq!(
            fixture.session.app_service().pages().current().unwrap().id,
            page
        );
        assert_eq!(fixture.session.renderer().last_frame().unwrap().frame_id, 2);
    }
}

#[test]
fn an_accepted_explicit_commit_populates_the_session_store() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "commit-seeded", false);
        rejected(&fixture.reuse(1), "ERR_RENDER");
        assert_eq!(fixture.explicit(1)["committed"], true);
        fixture.call("patch", json!([{"count":7}]));
        assert_eq!(fixture.reuse(2)["committed"], true);
        assert_eq!(fixture.count_text(), "7");
    }
}

#[test]
fn absent_false_and_invalid_selection_never_fall_back_or_run_component_hooks() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "selection", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        fixture.call("patch", json!([{"show":true}]));
        let before = fixture.retained();
        let hooks = fixture.call("stats", json!([]));
        assert_eq!(hooks, json!({"created":0,"attached":0}));

        for flag in [None, Some(json!(false))] {
            let mut payload = Fixture::payload(2);
            if let Some(flag) = flag {
                payload["useSessionResources"] = flag;
            }
            rejected(&fixture.dispatch(op::RENDER_COMMIT, payload), "ERR_RENDER");
            assert_eq!(fixture.retained(), before);
            assert_eq!(fixture.call("stats", json!([])), hooks);
        }
        for invalid in [Value::Null, json!("true"), json!(1), json!({}), json!([])] {
            let mut payload = Fixture::payload(2);
            payload["useSessionResources"] = invalid;
            payload["blobs"] = json!(fixture.blobs);
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, payload.clone()),
                "ERR_INVALID_REQUEST",
            );
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, json!({"frame":payload})),
                "ERR_INVALID_REQUEST",
            );
            assert_eq!(fixture.retained(), before);
            assert_eq!(fixture.call("stats", json!([])), hooks);
        }
        for explicit in [json!(fixture.blobs), Value::Null, json!({})] {
            let mut payload = Fixture::payload(2);
            payload["useSessionResources"] = json!(true);
            payload["blobs"] = explicit;
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, payload.clone()),
                "ERR_INVALID_REQUEST",
            );
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, json!({"frame":payload})),
                "ERR_INVALID_REQUEST",
            );
            assert_eq!(fixture.retained(), before);
            assert_eq!(fixture.call("stats", json!([])), hooks);
        }
        // A malformed flag cannot hide in either explicit raw-frame form.
        let frame = serde_json::to_value(fixture.session.renderer().last_frame().unwrap()).unwrap();
        for flag in [json!(true), json!("true"), Value::Null] {
            let mut frame = frame.clone();
            frame["useSessionResources"] = flag;
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, frame.clone()),
                "ERR_INVALID_REQUEST",
            );
            rejected(
                &fixture.dispatch(op::RENDER_COMMIT, json!({"frame":frame})),
                "ERR_INVALID_REQUEST",
            );
            assert_eq!(fixture.retained(), before);
            assert_eq!(fixture.call("stats", json!([])), hooks);
        }
        // Existing non-object raw frames retain their original render error.
        rejected(
            &fixture.dispatch(op::RENDER_COMMIT, Value::Null),
            "ERR_RENDER",
        );
        // False selects the original explicit mode; it does not ban blobs.
        let mut payload = Fixture::payload(2);
        payload["useSessionResources"] = json!(false);
        payload["blobs"] = json!(fixture.blobs);
        assert_eq!(fixture.ok(op::RENDER_COMMIT, payload)["committed"], true);
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
    }
}

#[test]
fn a_rejected_explicit_candidate_does_not_replace_the_verified_store() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "rejected-candidate", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        let before = fixture.retained();
        // Every supplied hash is valid, but the declared page template is
        // missing. The candidate must not poison the accepted resource store.
        let mut incomplete = fixture.blobs.clone();
        incomplete.remove(&fixture.session.manifest().templates[0].wxml_ast);
        let mut payload = Fixture::payload(2);
        payload["blobs"] = json!(incomplete);
        rejected(&fixture.dispatch(op::RENDER_COMMIT, payload), "ERR_RENDER");
        assert_eq!(fixture.retained(), before);
        let mut payload = Fixture::payload(2);
        payload["useSessionResources"] = json!(true);
        assert_eq!(
            fixture.ok(op::RENDER_COMMIT, json!({"frame":payload}))["committed"],
            true
        );
        assert_eq!(fixture.count_text(), "1");
    }
}

#[test]
fn corrupted_explicit_bytes_reject_without_cache_fallback_or_frame_loss() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "corruption", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        fixture.call("patch", json!([{"show":true,"count":9}]));
        let before = fixture.retained();
        let hooks = fixture.call("stats", json!([]));
        let mut corrupt = fixture.blobs.clone();
        let pointer = fixture.session.manifest().templates[0].wxml_ast.clone();
        corrupt.insert(pointer, b"tampered".to_vec());
        let mut payload = Fixture::payload(2);
        payload["blobs"] = json!(corrupt);
        let response = fixture.dispatch(op::RENDER_COMMIT, payload);
        rejected(&response, "ERR_RENDER");
        assert!(response["error"]["message"]
            .as_str()
            .unwrap()
            .contains("SHA-256 mismatch"));
        assert_eq!(fixture.retained(), before);
        assert_eq!(fixture.call("stats", json!([])), hooks);
        assert_eq!(fixture.reuse(2)["committed"], true);
        assert_eq!(fixture.count_text(), "9");
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
    }
}

#[test]
fn stores_are_session_local_and_an_empty_preload_cannot_authorize_a_frame() {
    for engine in engines() {
        let mut first = Fixture::start(engine, "first-owner", true);
        assert_eq!(first.reuse(1)["committed"], true);
        let mut second = Fixture::start(engine, "second-owner", false);
        let before = second.retained();
        rejected(&second.reuse(1), "ERR_RENDER");
        assert_eq!(second.retained(), before);
        // Even an explicitly validated empty store is not a usable preload.
        second.ok(op::APP_INIT, json!({"blobs":{}}));
        rejected(&second.reuse(1), "ERR_RENDER");
        assert!(second.session.renderer().last_frame().is_none());
        assert_eq!(first.reuse(2)["committed"], true);
        assert_eq!(second.explicit(1)["committed"], true);
        assert_eq!(second.reuse(2)["committed"], true);
    }
}

#[test]
fn changed_manifest_requires_revalidated_resources_while_identical_replacement_is_safe() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, "replacement", true);
        assert_eq!(fixture.reuse(1)["committed"], true);
        fixture
            .session
            .replace_manifest(fixture.session.manifest().clone())
            .unwrap();
        assert_eq!(fixture.reuse(2)["committed"], true);
        let style = parse_wxss("text {width:80px; height:20px; color:blue;}")
            .unwrap()
            .canonical_json()
            .unwrap();
        let pointer = format!("sha256:{}", hex_digest(&style));
        let mut manifest = fixture.session.manifest().clone();
        manifest.styles[0].wxss_ir = pointer.clone();
        manifest.refresh_integrity().unwrap();
        fixture.session.replace_manifest(manifest).unwrap();
        let before = fixture.retained();
        rejected(&fixture.reuse(3), "ERR_RENDER");
        // Old valid bytes also cannot supply a changed manifest's new style.
        rejected(&fixture.explicit(3), "ERR_RENDER");
        assert_eq!(fixture.retained(), before);
        fixture.blobs.insert(pointer, style);
        assert_eq!(fixture.explicit(3)["committed"], true);
        assert_eq!(fixture.reuse(4)["committed"], true);
    }
}

#[test]
fn development_preview_never_borrows_the_live_sessions_resource_authorization() {
    for engine in engines() {
        let mut live = Fixture::start(engine, "preview-owner", true);
        assert_eq!(live.reuse(1)["committed"], true);
        let before = live.retained();
        let mut candidate = Session::new(
            live.session.manifest().clone(),
            live.session.config().clone(),
        )
        .unwrap();
        let mut payload = Fixture::payload(2);
        payload["useSessionResources"] = json!(true);
        let error = candidate
            .preview_dev_render(&live.session, &payload)
            .unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Render);
        assert!(candidate.renderer().last_frame().is_none());
        assert_eq!(live.retained(), before);
        payload
            .as_object_mut()
            .unwrap()
            .remove("useSessionResources");
        payload["blobs"] = json!(live.blobs);
        candidate
            .preview_dev_render(&live.session, &payload)
            .unwrap();
        assert_eq!(candidate.renderer().last_frame().unwrap().frame_id, 2);
        payload.as_object_mut().unwrap().remove("blobs");
        payload["useSessionResources"] = json!(true);
        payload["frameId"] = json!(3);
        candidate
            .preview_dev_render(&live.session, &payload)
            .unwrap();
        assert_eq!(candidate.renderer().last_frame().unwrap().frame_id, 3);
        assert_eq!(live.retained(), before);
    }
}

#[test]
fn skia_style_preflight_failure_never_enters_view_component_hooks() {
    const MARKUP: &str = r#"<block wx:if="{{show}}"><card/></block>"#;
    for engine in engines() {
        let mut fixture = Fixture::start_with_markup(
            engine,
            "style-preflight",
            true,
            MARKUP,
            "@import './missing.wxss';",
        );
        let before = fixture.retained();
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":0,"attached":0})
        );
        // Navigation sees show=false. Only this render's explicit snapshot
        // makes the component reachable, so the assertion tests preflight
        // ordering instead of component hooks already run by page.push.
        let mut payload = Fixture::payload(1);
        payload["useSessionResources"] = json!(true);
        payload["data"] = json!({"count":1,"show":true});
        let response = fixture.dispatch(op::RENDER_COMMIT, payload.clone());
        rejected(&response, "ERR_RENDER");
        assert_eq!(
            response["error"]["message"],
            "WXSS style:missing.wxss is not declared in the manifest"
        );
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":0,"attached":0})
        );
        assert_eq!(fixture.retained(), before);
        assert!(fixture.session.view_document().is_none());

        // A valid style with the same snapshot must actually enter the
        // component branch; otherwise the rejection check would be vacuous.
        let mut control = Fixture::start_with_markup(
            engine,
            "style-preflight-control",
            true,
            MARKUP,
            "view {height:20px;}",
        );
        assert_eq!(
            control.call("stats", json!([])),
            json!({"created":0,"attached":0})
        );
        assert_eq!(control.ok(op::RENDER_COMMIT, payload)["committed"], true);
        assert_eq!(
            control.call("stats", json!([])),
            json!({"created":1,"attached":1})
        );
        assert!(control.session.view_document().is_some());
        assert_eq!(
            control
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["show"],
            false,
            "the control must use explicit render data, not a prior setData"
        );
    }
}

#[test]
fn post_view_image_failure_retains_accepted_document_frame_and_cloned_input_without_rolling_back_hooks(
) {
    for engine in engines() {
        let mut fixture = Fixture::start_with_markup(
            engine,
            "image-candidate",
            true,
            r#"<view id="count">{{count}}</view><block wx:if="{{show}}"><card/><image src="https://example.test/image.png"/></block>"#,
            "text{width:80px;height:20px}",
        );
        assert_eq!(fixture.reuse(1)["committed"], true);
        let frame = fixture.session.renderer().last_frame().unwrap().clone();
        let document = fixture.session.view_document().cloned();
        let revision = fixture.session.renderer().snapshot_revision();
        let consumed = fixture.session.last_frame_input_json(revision).unwrap();
        fixture.call("patch", json!([{"show":true}]));
        rejected(&fixture.reuse(2), "ERR_UNSUPPORTED_CAPABILITY");
        assert_eq!(
            fixture.call("stats", json!([])),
            json!({"created":1,"attached":1}),
            "View hooks already executed: graphics rejection does not roll back JavaScript"
        );
        assert_eq!(fixture.session.renderer().last_frame(), Some(&frame));
        assert_eq!(fixture.session.renderer().snapshot_revision(), revision);
        assert_eq!(fixture.session.view_document(), document.as_ref());
        assert_eq!(
            fixture.session.last_frame_input_json(revision).unwrap(),
            consumed
        );
        assert_eq!(fixture.count_text(), "1");
    }
}
