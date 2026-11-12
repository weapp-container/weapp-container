//! Public manifest-to-pixels coverage for the implicit WXSS `page` element.
//! These are portable cascade/render contracts, not official DevTools parity.

use container_bridge::{op, BridgeEnvelope};
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, ContainerManifestV1, Style, StyleScope, Template,
};
use container_render_skia::{Color, RenderFrame, RenderSnapshot, Renderer, SoftwareRenderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "page-viewport-contract";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP_STYLE: &str = "style:app.wxss";
const PAGE_STYLE: &str = "style:pages/index/index.wxss";

struct Fixture {
    session: Session,
    blobs: BTreeMap<String, Vec<u8>>,
    revision: u64,
}

impl Fixture {
    fn new(wxml: &str, app_wxss: &str, page_wxss: &str) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "page-viewport-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        let mut blobs = BTreeMap::new();
        let ast = parse_wxml(wxml).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&ast));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: pointer.clone(),
            bindings: Vec::new(),
            wxs_modules: Default::default(),
        });
        blobs.insert(pointer, ast);
        for (id, scope, source) in [
            (APP_STYLE, StyleScope::App, app_wxss),
            (PAGE_STYLE, StyleScope::Page, page_wxss),
        ] {
            let ir = parse_wxss(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&ir));
            manifest.styles.push(Style {
                id: id.into(),
                scope,
                wxss_ir: pointer.clone(),
            });
            blobs.insert(pointer, ir);
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: SESSION.into(),
                ..SessionConfig::default()
            },
        )
        .unwrap();
        let initialized = session.dispatch(BridgeEnvelope::request(
            SESSION,
            "init",
            op::APP_INIT,
            json!({}),
        ));
        assert_eq!(initialized.messages[0].payload["ok"], true);
        Self {
            session,
            blobs,
            revision: 0,
        }
    }

    fn render(&mut self, width: u32, height: u32, styles: Option<Value>) -> RenderFrame {
        self.revision += 1;
        let mut payload = json!({
            "templateId": TEMPLATE,
            "frameId": self.revision,
            "viewport": {"width":width,"height":height},
            "blobs": self.blobs,
        });
        if let Some(styles) = styles {
            payload["styleIds"] = styles;
        }
        let response = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("render-{}", self.revision),
            op::RENDER_COMMIT,
            payload,
        ));
        assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
        self.session.renderer().last_frame().unwrap().clone()
    }

    // The same public runtime test runs with either software or native Skia
    // enabled. Independently render its frame through the software backend,
    // so native CI checks the shared tree rather than a host backdrop.
    fn assert_pixels(&self, frame: &RenderFrame, samples: &[(u32, u32, [u8; 4])]) {
        let mut software = SoftwareRenderer::new();
        software.commit(frame.clone()).unwrap();
        for snapshot in [
            self.session.renderer().snapshot().unwrap(),
            software.snapshot().unwrap(),
        ] {
            for &(x, y, expected) in samples {
                assert_eq!(
                    pixel(&snapshot, x, y),
                    expected,
                    "({}, {}) in {}",
                    x,
                    y,
                    self.session.renderer().backend_name()
                );
            }
        }
    }
}

fn pixel(snapshot: &RenderSnapshot, x: u32, y: u32) -> [u8; 4] {
    let offset = y as usize * snapshot.stride as usize + x as usize * 4;
    snapshot.pixels[offset..offset + 4].try_into().unwrap()
}

#[test]
fn app_page_background_covers_viewport_for_empty_short_and_overflowing_content() {
    for content in [
        "",
        "<view style=\"width: 8px; height: 4px; background: white\"/>",
        "<view style=\"width: 8px; height: 400px; background: white\"/>",
    ] {
        let mut fixture = Fixture::new(content, "page { background: #f3f4f6; }", "");
        for (width, height) in [(32, 48), (48, 64)] {
            let frame = fixture.render(width, height, None);
            assert_eq!(frame.root.tag.as_deref(), Some("page"));
            assert_eq!(frame.root.bounds, frame.viewport);
            assert_eq!(
                frame.root.computed_style.get("background-color"),
                Some(&"#f3f4f6".into())
            );
            fixture.assert_pixels(
                &frame,
                &[
                    (width - 1, 0, [243, 244, 246, 255]),
                    (width - 1, height - 1, [243, 244, 246, 255]),
                ],
            );
        }
    }
}

#[test]
fn implicit_page_uses_stylesheet_cascade_and_does_not_invent_an_opaque_backdrop() {
    let mut fixture = Fixture::new(
        "",
        "page { background: #f3f4f6; }",
        "page { background-color: #123456; }",
    );
    let frame = fixture.render(24, 32, None);
    fixture.assert_pixels(
        &frame,
        &[(0, 0, [18, 52, 86, 255]), (23, 31, [18, 52, 86, 255])],
    );

    let frame = fixture.render(24, 32, Some(json!([APP_STYLE])));
    fixture.assert_pixels(&frame, &[(23, 31, [243, 244, 246, 255])]);

    let frame = fixture.render(24, 32, Some(json!([])));
    assert_eq!(frame.root.background, None);
    // Computed non-paint defaults are explicit even without declarations;
    // they must not introduce a background into the transparent page.
    assert_eq!(
        frame.root.computed_style,
        [
            ("flex-direction".into(), "row".into()),
            ("flex-wrap".into(), "nowrap".into()),
            ("font-size".into(), "16px".into()),
            ("line-height".into(), "normal".into()),
            ("order".into(), "0".into()),
            ("visibility".into(), "visible".into()),
            ("white-space".into(), "normal".into()),
            ("word-break".into(), "normal".into()),
            ("text-align".into(), "start".into()),
            ("transform".into(), "none".into()),
            ("transform-origin".into(), "12px 16px".into()),
        ]
        .into_iter()
        .collect()
    );
    fixture.assert_pixels(&frame, &[(0, 0, [0, 0, 0, 0]), (23, 31, [0, 0, 0, 0])]);
}

#[test]
fn page_is_the_selector_and_inheritance_parent_without_rewriting_wxml_paths() {
    let mut fixture = Fixture::new(
        "<block><view id=\"first\"><text id=\"label\">x</text></view></block><view id=\"second\"/>",
        concat!(
            "page { color: #102030; padding: 3px; background: #f3f4f6; } ",
            "page > view:first-child { background: #abcdef; height: 20px; } ",
            "page text { color: inherit; }"
        ),
        "",
    );
    let frame = fixture.render(40, 48, None);
    let first = frame.query("#first", false).unwrap()[0];
    assert_eq!(first.bounds.x, 3.0);
    assert_eq!(first.bounds.y, 3.0);
    assert_eq!(first.bounds.width, 34.0);
    assert_eq!(first.bounds.height, 20.0);
    assert_eq!(first.foreground, frame.root.foreground);
    assert_eq!(first.computed_style["color"], "#102030");
    assert!(!first.computed_style.contains_key("padding-left"));
    assert_eq!(first.computed_style["background-color"], "#abcdef");
    let label = frame.query("#label", false).unwrap()[0];
    assert_eq!(label.computed_style["color"], "#102030");
    assert_eq!(label.children[0].id, "text:0.0.0.0");
    assert!(label.background.is_none());
    assert!(frame.query("#second", false).unwrap()[0]
        .background
        .is_none());
    fixture.assert_pixels(
        &frame,
        &[(0, 0, [243, 244, 246, 255]), (36, 22, [171, 205, 239, 255])],
    );
}

#[test]
fn page_paint_properties_share_element_compositing_and_cascade_priority() {
    let mut fixture = Fixture::new(
        "",
        "page { background: #804020 !important; opacity: 0.5; }",
        "page { background: white; opacity: 1; }",
    );
    let frame = fixture.render(12, 18, None);
    assert_eq!(frame.root.opacity, 1.0);
    assert_eq!(
        frame.root.background,
        Some(Color {
            red: 128,
            green: 64,
            blue: 32,
            alpha: 255
        })
    );
    fixture.assert_pixels(&frame, &[(11, 17, [128, 64, 32, 255])]);

    let frame = fixture.render(12, 18, Some(json!([APP_STYLE])));
    assert_eq!(frame.root.opacity, 0.5);
    fixture.assert_pixels(&frame, &[(11, 17, [64, 32, 16, 128])]);
}
