//! Public bridge-to-renderer coverage for declaration-owned component expansion.
//! No JavaScript modules are loaded: component owner metadata in these frames
//! records presentation provenance, not component lifecycle or event execution.

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_ir::{hex_digest, parse_wxml, Component, ContainerManifestV1, Template};
use container_render_skia::{RenderFrame, RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::json;
use std::collections::BTreeMap;

const SESSION: &str = "declarative-render-fixture";
const PAGE: &str = "template:pages/index/index.wxml";

struct Fixture {
    session: Session,
    blobs: BTreeMap<String, Vec<u8>>,
}

impl Fixture {
    fn new() -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "declarative-render-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            (
                PAGE,
                r#"<card><light slot="content" label="page property"/><text slot="content" id="page-light-text">page text</text><unused slot="unused"/></card><unused wx:if="{{activateMissing}}"/>"#,
            ),
            (
                "template:components/card/index.wxml",
                r#"<view id="card-body"><light label="private property"/><slot name="content"/></view>"#,
            ),
            (
                "template:components/page-light/index.wxml",
                r#"<text id="page-light">{{label}}</text>"#,
            ),
            (
                "template:components/private-light/index.wxml",
                r#"<text id="private-light">{{label}}</text>"#,
            ),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.components = vec![
            Component {
                id: "components:pages/index/index.json".into(),
                owner: "pages/index/index.json".into(),
                using_components: BTreeMap::from([
                    ("card".into(), "/components/card/index".into()),
                    ("light".into(), "/components/page-light/index".into()),
                    ("unused".into(), "/missing/unused".into()),
                ]),
                multiple_slots: None,
            },
            Component {
                id: "components:components/card/index.json".into(),
                owner: "components/card/index.json".into(),
                using_components: BTreeMap::from([(
                    "light".into(),
                    "/components/private-light/index".into(),
                )]),
                multiple_slots: Some(true),
            },
        ];
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
        Self { session, blobs }
    }

    fn render(&mut self, frame: u64, activate_missing: bool) -> BridgeBatch {
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("render-{frame}"),
            op::RENDER_COMMIT,
            json!({
                "templateId": PAGE,
                "frameId": frame,
                "viewport": {"width":200,"height":160},
                "data": {"activateMissing":activate_missing},
                "blobs": self.blobs,
            }),
        ))
    }
}

fn one<'a>(frame: &'a RenderFrame, selector: &str) -> &'a RenderNode {
    let nodes = frame.query(selector, true).unwrap();
    assert_eq!(nodes.len(), 1, "{selector}");
    nodes[0]
}

fn text(node: &RenderNode) -> String {
    node.text.clone().unwrap_or_default() + &node.children.iter().map(text).collect::<String>()
}

#[test]
fn public_manifest_render_preserves_slot_declarations_and_skips_unused_components() {
    let mut fixture = Fixture::new();
    let response = fixture.render(1, false);
    assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
    let frame = fixture.session.renderer().last_frame().unwrap();
    assert_eq!(frame.frame_id, 1);
    assert_eq!(text(one(frame, "#page-light")), "page property");
    assert_eq!(text(one(frame, "#private-light")), "private property");
    assert_eq!(text(one(frame, "#page-light-text")), "page text");
    assert!(frame.query("card", true).unwrap().is_empty());
    assert!(frame.query("unused", true).unwrap().is_empty());
    assert!(one(frame, "#page-light-text")
        .event_owner_scope_id
        .is_none());
    let page_owner = one(frame, "#page-light")
        .event_owner_scope_id
        .as_deref()
        .expect("declaration provenance for page's light component");
    let private_owner = one(frame, "#private-light")
        .event_owner_scope_id
        .as_deref()
        .expect("declaration provenance for card's private light component");
    assert!(page_owner.contains("components/page-light/index.wxml"));
    assert!(private_owner.contains("components/private-light/index.wxml"));
    assert_ne!(page_owner, private_owner);
}

#[test]
fn active_missing_component_rejects_public_commit_and_retains_the_previous_frame() {
    let mut fixture = Fixture::new();
    let response = fixture.render(1, false);
    assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
    let previous = fixture.session.renderer().last_frame().unwrap().clone();
    let snapshot = fixture.session.renderer().snapshot();

    let response = fixture.render(2, true);
    assert_eq!(
        response.messages[0].payload["error"]["code"], "ERR_MODULE_LOAD",
        "{response:?}"
    );
    assert_eq!(fixture.session.renderer().last_frame(), Some(&previous));
    assert_eq!(fixture.session.renderer().snapshot(), snapshot);

    let repaired = fixture.render(3, false);
    assert_eq!(repaired.messages[0].payload["ok"], true, "{repaired:?}");
    let frame = fixture.session.renderer().last_frame().unwrap();
    assert_eq!(frame.frame_id, 3);
    assert_eq!(frame.root, previous.root);
}
