//! Portable static-image contracts. Engine tests execute real registered Page
//! code; these are auxiliary runtime evidence, not official DevTools parity.

use container_bridge::{op, BridgeEnvelope};
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, Asset, Component, ContainerManifestV1, Style, StyleScope,
    Template,
};
use container_render_skia::{ImageMode, RenderFrame, RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use image::{ExtendedColorType, ImageEncoder};
use serde_json::{json, Value};
use std::{collections::BTreeMap, sync::Arc};

const PAGE: &str = "template:pages/index/index.wxml";

fn encoded(format: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    match format {
        "png" => image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(
                &[255, 0, 0, 128, 0, 0, 255, 255],
                2,
                1,
                ExtendedColorType::Rgba8,
            )
            .unwrap(),
        "jpeg" => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 100)
            .write_image(&[255, 0, 0, 255, 0, 0], 2, 1, ExtendedColorType::Rgb8)
            .unwrap(),
        "webp" => image::codecs::webp::WebPEncoder::new_lossless(&mut bytes)
            .write_image(
                &[255, 0, 0, 128, 0, 0, 255, 255],
                2,
                1,
                ExtendedColorType::Rgba8,
            )
            .unwrap(),
        _ => panic!("unknown codec"),
    }
    bytes
}

fn solid(color: [u8; 4]) -> Vec<u8> {
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(&color, 1, 1, ExtendedColorType::Rgba8)
        .unwrap();
    bytes
}

struct Fixture {
    session: Session,
    manifest: ContainerManifestV1,
    blobs: BTreeMap<String, Vec<u8>>,
    sequence: u64,
}

impl Fixture {
    fn new(markup: &str, styles: &str, assets: &[(&str, Vec<u8>)]) -> Self {
        Self::templates(&[(PAGE, markup)], styles, assets, Vec::new())
    }

    fn templates(
        templates: &[(&str, &str)],
        styles: &str,
        assets: &[(&str, Vec<u8>)],
        components: Vec<Component>,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "static-image-runtime-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.components = components;
        let mut blobs = BTreeMap::new();
        for (id, markup) in templates {
            let bytes = parse_wxml(markup).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: (*id).into(),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: BTreeMap::new(),
            });
            blobs.insert(pointer, bytes);
        }
        let bytes = parse_wxss(styles).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: pointer.clone(),
            scope: StyleScope::App,
        });
        blobs.insert(pointer, bytes);
        for (path, bytes) in assets {
            let hash = hex_digest(bytes);
            manifest.assets.push(Asset {
                path: (*path).into(),
                sha256: hash.clone(),
                mime: "application/octet-stream".into(),
                size: bytes.len() as u64,
            });
            blobs.insert(format!("sha256:{hash}"), bytes.clone());
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
        let response = session.dispatch(BridgeEnvelope::request(
            "session-1",
            "init",
            op::APP_INIT,
            json!({}),
        ));
        assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
        Self {
            session,
            manifest,
            blobs,
            sequence: 0,
        }
    }

    fn render(&mut self, data: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            self.session.config().session_id.clone(),
            format!("image-{}", self.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"blobs":self.blobs,"data":data,
                "viewport":{"width":400,"height":400},"frameId":self.sequence}),
        ));
        batch.messages[0].payload.clone()
    }

    fn frame(&self) -> &RenderFrame {
        self.session.renderer().last_frame().unwrap()
    }
}

fn node<'a>(frame: &'a RenderFrame, id: &str) -> &'a RenderNode {
    fn find<'a>(node: &'a RenderNode, id: &str) -> Option<&'a RenderNode> {
        if node.id == id {
            Some(node)
        } else {
            node.children.iter().find_map(|child| find(child, id))
        }
    }
    find(&frame.root, id).unwrap()
}

#[test]
fn codecs_are_magic_detected_and_keep_straight_alpha() {
    for codec in ["png", "jpeg", "webp"] {
        let bytes = encoded(codec);
        // Neither the extension nor MIME provides decoding authority.
        let mut fixture = Fixture::new(
            r#"<image id="photo" src="/assets/photo.bin"/>"#,
            "",
            &[("assets/photo.bin", bytes)],
        );
        assert_eq!(fixture.render(json!({}))["ok"], true, "{codec}");
        let image = fixture.frame().images.values().next().unwrap();
        assert_eq!((image.width, image.height), (2, 1));
        assert_eq!(image.pixels.len(), 8);
        if codec != "jpeg" {
            assert_eq!(image.pixels, [255, 0, 0, 128, 0, 0, 255, 255]);
        }
        let bounds = node(fixture.frame(), "photo").bounds;
        assert_eq!((bounds.width, bounds.height), (300.0, 225.0));
    }
}

#[test]
fn package_component_include_and_projected_slot_sources_use_lexical_documents() {
    let page = solid([255, 0, 0, 255]);
    let root = solid([0, 255, 0, 255]);
    let included = solid([0, 0, 255, 255]);
    let component = solid([255, 255, 0, 255]);
    let components = vec![Component {
        id: "components:pages/index/index.json".into(),
        owner: "pages/index/index.json".into(),
        using_components: BTreeMap::from([("card".into(), "/components/card/index".into())]),
        multiple_slots: None,
    }];
    let mut fixture = Fixture::templates(
        &[
            (
                PAGE,
                r#"<image id="page" src="./local.png"/><image id="root" src="/assets/root.png?cache=1#pixel"/><include src="../../fragments/part.wxml"/><card><image id="slot" src="local.png"/></card>"#,
            ),
            (
                "template:fragments/part.wxml",
                r#"<image id="included" src="./fragment.png"/>"#,
            ),
            (
                "template:components/card/index.wxml",
                r#"<view><image id="component" src="./local.png"/><slot/></view>"#,
            ),
        ],
        "image{width:10px;height:10px}",
        &[
            ("pages/index/local.png", page.clone()),
            ("assets/root.png", root.clone()),
            ("fragments/fragment.png", included.clone()),
            ("components/card/local.png", component.clone()),
        ],
        components,
    );
    assert_eq!(fixture.render(json!({}))["ok"], true);
    assert_eq!(
        fixture.frame().images.len(),
        4,
        "lexical documents resolve distinct bytes"
    );
    for (id, bytes) in [
        ("page", &page),
        ("root", &root),
        ("included", &included),
        ("component", &component),
        ("slot", &page),
    ] {
        let actual = node(fixture.frame(), id).image.as_ref().unwrap();
        assert_eq!(
            actual.resource,
            format!("sha256:{}", hex_digest(bytes)),
            "{id}"
        );
    }
}

#[test]
fn generated_frames_share_cache_arcs_and_clear_dynamic_sources() {
    let bytes = encoded("png");
    let mut fixture = Fixture::new(
        r#"<image id="one" src="{{src}}"/><image id="two" src="{{src}}"/>"#,
        "",
        &[("assets/p.png", bytes)],
    );
    assert_eq!(fixture.render(json!({"src":"/assets/p.png"}))["ok"], true);
    let first = Arc::clone(fixture.frame().images.values().next().unwrap());
    assert_eq!(fixture.frame().images.len(), 1);
    assert_eq!(fixture.render(json!({"src":"/assets/p.png"}))["ok"], true);
    assert!(
        Arc::ptr_eq(&first, fixture.frame().images.values().next().unwrap()),
        "typed generated frame must preserve decoded cache Arc"
    );
    assert_eq!(fixture.render(json!({"src":""}))["ok"], true);
    assert!(fixture.frame().images.is_empty());
    assert!(node(fixture.frame(), "one").image.is_none());
    assert_eq!(node(fixture.frame(), "one").bounds.height, 225.0);
}

#[test]
fn intrinsic_axes_are_solved_after_containing_block_percentages() {
    let mut fixture = Fixture::new(
        r#"<view style="width:200px;height:200px"><image id="width" src="/p" mode="widthFix" style="width:50%;height:177px"/><image id="height" src="/p" mode="heightFix" style="height:25%;width:177px"/></view>"#,
        "",
        &[("p", encoded("png"))],
    );
    assert_eq!(fixture.render(json!({}))["ok"], true);
    let width = node(fixture.frame(), "width").bounds;
    assert_eq!((width.width, width.height), (100.0, 50.0));
    let height = node(fixture.frame(), "height").bounds;
    assert_eq!((height.width, height.height), (100.0, 50.0));
}

#[test]
fn all_fourteen_wire_modes_reach_the_render_tree() {
    let modes = [
        "scaleToFill",
        "aspectFit",
        "aspectFill",
        "widthFix",
        "heightFix",
        "top",
        "bottom",
        "center",
        "left",
        "right",
        "top left",
        "top right",
        "bottom left",
        "bottom right",
    ];
    for mode in modes {
        let mut fixture = Fixture::new(
            &format!(r#"<image id="photo" src="/p" mode="{mode}"/>"#),
            "",
            &[("p", encoded("png"))],
        );
        assert_eq!(fixture.render(json!({}))["ok"], true, "{mode}");
        let image = node(fixture.frame(), "photo").image.as_ref().unwrap();
        assert_eq!(image.mode.as_str(), mode);
        assert_eq!(image.mode, mode.parse::<ImageMode>().unwrap());
    }
}

#[test]
fn unsupported_sources_attributes_listeners_and_missing_assets_preserve_the_frame() {
    let mut fixture = Fixture::new(
        r#"<image id="photo" src="{{src}}" mode="{{mode}}"/>"#,
        "",
        &[("p", encoded("png"))],
    );
    assert_eq!(
        fixture.render(json!({"src":"/p","mode":"aspectFit"}))["ok"],
        true
    );
    let accepted = fixture.frame().clone();
    let pixels = fixture.session.renderer().snapshot().unwrap();
    for (source, code) in [
        ("https://example.com/p.png", "ERR_UNSUPPORTED_CAPABILITY"),
        ("//example/p", "ERR_UNSUPPORTED_CAPABILITY"),
        ("data:image/png,a", "ERR_UNSUPPORTED_CAPABILITY"),
        ("wxfile://p", "ERR_UNSUPPORTED_CAPABILITY"),
        ("../../../p", "ERR_RENDER"),
        ("/%2e%2e/p", "ERR_RENDER"),
        ("/missing", "ERR_RENDER"),
    ] {
        let response = fixture.render(json!({"src":source,"mode":"aspectFit"}));
        assert_eq!(response["error"]["code"], code, "{source}: {response}");
        assert_eq!(fixture.frame(), &accepted);
    }
    assert_eq!(
        fixture.render(json!({"src":"/p","mode":"bogus"}))["error"]["code"],
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(fixture.session.renderer().snapshot().unwrap(), pixels);
    for attribute in [
        "bindload=\"loaded\"",
        "bind:error=\"error\"",
        "catchload=\"loaded\"",
        "capture-bind:load=\"loaded\"",
        "mut-binderror=\"error\"",
        "lazy-load",
        "show-menu-by-longpress=\"true\"",
        "show-menu",
        "fade-show=\"true\"",
    ] {
        let mut fixture = Fixture::new(
            &format!(r#"<image src="/p" {attribute}/>"#),
            "",
            &[("p", encoded("png"))],
        );
        let response = fixture.render(json!({}));
        assert_eq!(
            response["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
            "{attribute}: {response}"
        );
        assert!(fixture.session.renderer().last_frame().is_none());
    }
    let mut fixture = Fixture::new(
        r#"<image src="/p" lazy-load="{{false}}" show-menu-by-longpress="{{false}}" fade-show="{{false}}" bindtap="tap"/>"#,
        "",
        &[("p", encoded("png"))],
    );
    assert_eq!(fixture.render(json!({}))["ok"], true);
}

#[test]
fn invalid_bytes_missing_blobs_and_metadata_fail_without_reusing_stale_cache() {
    let mut fixture = Fixture::new(r#"<image src="/p"/>"#, "", &[("p", encoded("png"))]);
    assert_eq!(fixture.render(json!({}))["ok"], true);
    let accepted = fixture.frame().clone();
    let hash = fixture.manifest.assets[0].sha256.clone();
    let bytes = fixture.blobs.remove(&format!("sha256:{hash}")).unwrap();
    assert_eq!(fixture.render(json!({}))["error"]["code"], "ERR_RENDER");
    assert_eq!(fixture.frame(), &accepted);
    fixture.blobs.insert(format!("sha256:{hash}"), bytes);
    let mut manifest = fixture.manifest.clone();
    manifest.assets[0].size += 1;
    manifest.refresh_integrity().unwrap();
    fixture.session.replace_manifest(manifest).unwrap();
    assert_eq!(fixture.render(json!({}))["error"]["code"], "ERR_RENDER");
    assert_eq!(fixture.frame(), &accepted);
    for bytes in [
        b"broken".to_vec(),
        b"GIF89a\x01\0\x01\0".to_vec(),
        b"<svg xmlns='http://www.w3.org/2000/svg'/>".to_vec(),
    ] {
        let mut fixture = Fixture::new(r#"<image src="/p"/>"#, "", &[("p", bytes.clone())]);
        let response = fixture.render(json!({}));
        let code = if bytes == b"broken" {
            "ERR_RENDER"
        } else {
            "ERR_UNSUPPORTED_CAPABILITY"
        };
        assert_eq!(response["error"]["code"], code, "{response}");
    }
}

#[test]
fn explicit_json_frames_keep_camel_case_frame_id_compatibility() {
    let mut fixture = Fixture::new("<view/>", "", &[]);
    let response=fixture.session.dispatch(BridgeEnvelope::request("session-1","raw",op::RENDER_COMMIT,json!({"frame":{
        "frameId":91,"viewport":{"x":0,"y":0,"width":4,"height":4},
        "root":{"id":"root","bounds":{"x":0,"y":0,"width":4,"height":4},"opacity":1,"children":[]}
    }})));
    assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
    assert_eq!(fixture.frame().frame_id, 91);
}

#[test]
fn manifest_replacement_reauthorizes_bytes_and_releases_previous_decoded_generation() {
    let mut fixture = Fixture::new(
        r#"<image src="/p"/>"#,
        "",
        &[("p", solid([255, 0, 0, 255]))],
    );
    assert_eq!(fixture.render(json!({}))["ok"], true);
    let previous = Arc::downgrade(fixture.frame().images.values().next().unwrap());
    let bytes = solid([0, 0, 255, 255]);
    let hash = hex_digest(&bytes);
    let asset = &mut fixture.manifest.assets[0];
    asset.sha256 = hash.clone();
    asset.size = bytes.len() as u64;
    fixture.manifest.refresh_integrity().unwrap();
    fixture
        .session
        .replace_manifest(fixture.manifest.clone())
        .unwrap();
    fixture.blobs.insert(format!("sha256:{hash}"), bytes);
    assert!(
        previous.upgrade().is_some(),
        "accepted frame still owns old pixels before publication"
    );
    assert_eq!(fixture.render(json!({}))["ok"], true);
    assert!(
        previous.upgrade().is_none(),
        "old cache and accepted frame resources are released"
    );
    let current = Arc::downgrade(fixture.frame().images.values().next().unwrap());
    drop(fixture);
    assert!(
        current.upgrade().is_none(),
        "session teardown releases its frame and cache"
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn actual_page_tap_set_data_swaps_images_in_both_native_engines() {
    use container_core::EngineKind;
    use container_ir::{CapabilitySupport, Module, ModuleFormat, ModuleScope, Route, RouteKind};
    let engines = vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ];
    for engine in engines {
        let mut fixture = Fixture::new(
            r#"<image id="photo" src="{{src}}" bindtap="swap" style="width:40px;height:20px"/>"#,
            "",
            &[
                ("red", solid([255, 0, 0, 255])),
                ("blue", solid([0, 0, 255, 255])),
            ],
        );
        let sources = [
            ("module:app.js", "App({});", ModuleScope::App),
            (
                "module:pages/index/index.js",
                r#"Page({data:{src:'/red'},swap:function(){this.setData({src:this.data.src==='/red'?'/blue':'/red'});}});"#,
                ModuleScope::Page,
            ),
        ];
        let mut modules = Vec::new();
        for (id, source, scope) in sources {
            fixture.manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        fixture.manifest.app.entry_module = "module:app.js".into();
        fixture.manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "module:pages/index/index.js".into(),
        });
        fixture
            .manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        fixture.manifest.refresh_integrity().unwrap();
        fixture.session = Session::new(
            fixture.manifest.clone(),
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let initialized = fixture.session.dispatch(BridgeEnvelope::request(
            "session-1",
            "native-init",
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        ));
        assert_eq!(
            initialized.messages[0].payload["ok"], true,
            "{engine:?}: {initialized:?}"
        );
        assert_eq!(
            initialized.messages[0].payload["engineProviderAvailable"],
            true
        );
        for (operation, payload) in [
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/index/index"})),
        ] {
            let response = fixture.session.dispatch(BridgeEnvelope::request(
                "session-1",
                format!("native-{operation}"),
                operation,
                payload,
            ));
            assert_eq!(
                response.messages[0].payload["ok"], true,
                "{engine:?}: {response:?}"
            );
        }
        // Omit data: the runtime must consume the live Page registration.
        let render = |fixture: &mut Fixture| {
            fixture.sequence += 1;
            let response=fixture.session.dispatch(BridgeEnvelope::request("session-1",format!("native-render-{}",fixture.sequence),op::RENDER_COMMIT,
                json!({"templateId":PAGE,"useSessionResources":true,"viewport":{"width":80,"height":80}})));
            assert_eq!(
                response.messages[0].payload["ok"], true,
                "{engine:?}: {response:?}"
            );
        };
        render(&mut fixture);
        assert_eq!(
            fixture.frame().images.values().next().unwrap().pixels,
            [255, 0, 0, 255]
        );
        let red = Arc::clone(fixture.frame().images.values().next().unwrap());
        for (index, color) in [[0, 0, 255, 255], [255, 0, 0, 255]].iter().enumerate() {
            let event = fixture.session.dispatch(BridgeEnvelope::request(
                "session-1",
                format!("tap-{index}"),
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","target":"photo"}]}),
            ));
            assert_eq!(
                event.messages[0].payload["ok"], true,
                "{engine:?}: {event:?}"
            );
            render(&mut fixture);
            assert_eq!(
                fixture.frame().images.values().next().unwrap().pixels,
                *color,
                "{engine:?}"
            );
        }
        assert!(
            Arc::ptr_eq(&red, fixture.frame().images.values().next().unwrap()),
            "{engine:?}: cache survives Page data updates"
        );
    }
}
