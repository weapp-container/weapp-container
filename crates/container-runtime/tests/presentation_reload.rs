//! Retaining a Session is a central runtime boundary, even when the caller is
//! an embedder rather than the development simulator. These protocol fixtures
//! deliberately load no JavaScript modules and require no native JS engine.

use container_bridge::{op, BridgeEnvelope};
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, Asset, CapabilitySupport, Component, ContainerManifestV1,
    Module, ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::Renderer;
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "presentation-reload-fixture";
const ROUTE: &str = "pages/index/index";
const TEMPLATE: &str = "template:pages/index/index.wxml";

fn presentation(
    manifest: &mut ContainerManifestV1,
    label: &str,
    color: &str,
) -> BTreeMap<String, Vec<u8>> {
    let wxml = parse_wxml(&format!(
        "<view id=\"panel\" class=\"panel\"><text>{{{{count}}}}</text><text>{label}</text></view>"
    ))
    .unwrap()
    .canonical_json()
    .unwrap();
    let wxss = parse_wxss(&format!(
        ".panel {{ width: 64px; height: 40px; background-color: {color}; }}"
    ))
    .unwrap()
    .canonical_json()
    .unwrap();
    let wxml_pointer = format!("sha256:{}", hex_digest(&wxml));
    let wxss_pointer = format!("sha256:{}", hex_digest(&wxss));
    let asset = label.as_bytes().to_vec();
    let asset_hash = hex_digest(&asset);
    manifest.templates = vec![Template {
        id: TEMPLATE.into(),
        wxml_ast: wxml_pointer.clone(),
        bindings: vec!["count".into()],
        wxs_modules: Default::default(),
    }];
    manifest.styles = vec![Style {
        id: "style:pages/index/index.wxss".into(),
        wxss_ir: wxss_pointer.clone(),
        scope: StyleScope::Page,
    }];
    manifest.assets = vec![Asset {
        path: "assets/version.txt".into(),
        sha256: asset_hash.clone(),
        mime: "text/plain".into(),
        size: asset.len() as u64,
    }];
    manifest.refresh_integrity().unwrap();
    BTreeMap::from([
        (wxml_pointer, wxml),
        (wxss_pointer, wxss),
        (format!("sha256:{asset_hash}"), asset),
    ])
}

fn dispatch_ok(session: &mut Session, id: &str, operation: &str, payload: Value) {
    let batch = session.dispatch(BridgeEnvelope::request(SESSION, id, operation, payload));
    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
}

fn render(session: &mut Session, blobs: &BTreeMap<String, Vec<u8>>, frame: u64) {
    dispatch_ok(
        session,
        &format!("render-{frame}"),
        op::RENDER_COMMIT,
        json!({
            "templateId": TEMPLATE,
            "frameId": frame,
            "viewport": {"width":80,"height":48},
            "blobs": blobs,
        }),
    );
}

fn fixture() -> (Session, BTreeMap<String, Vec<u8>>) {
    fixture_with_engine(None)
}

fn fixture_with_engine(
    engine: Option<container_core::EngineKind>,
) -> (Session, BTreeMap<String, Vec<u8>>) {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "presentation-reload-baseline".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.modules = vec![
        Module {
            id: "module:app.js".into(),
            sha256: hex_digest(b"App({});"),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        },
        Module {
            id: "module:helper.js".into(),
            sha256: hex_digest(b"exports.value = 1;"),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        },
    ];
    manifest.routes.push(Route {
        id: "route:index".into(),
        path: ROUTE.into(),
        kind: RouteKind::Page,
        config: Some("pages/index/index.json".into()),
        entry_module: "module:app.js".into(),
    });
    manifest
        .capabilities
        .insert("wx.setStorageSync".into(), CapabilitySupport::Full);
    let mut blobs = presentation(&mut manifest, "baseline", "red");
    if engine.is_some() {
        compiled_presentation(&mut manifest, &mut blobs, &["count"]);
    }
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: SESSION.into(),
            engine: engine.unwrap_or(container_core::EngineKind::Quickjs),
            ..SessionConfig::default()
        },
    )
    .unwrap();
    dispatch_ok(&mut session, "init", op::APP_INIT, json!({"blobs":blobs}));
    dispatch_ok(
        &mut session,
        "launch",
        op::APP_LIFECYCLE,
        json!({"event":"launch"}),
    );
    for (id, count) in [("first-page", 1), ("second-page", 7)] {
        dispatch_ok(
            &mut session,
            id,
            op::PAGE_PUSH,
            json!({"path":ROUTE,"query":{"instance":id},"data":{"count":count}}),
        );
    }
    session
        .app_service_mut()
        .storage_mut()
        .set("persisted", json!({"value":42}))
        .unwrap();
    render(&mut session, &blobs, 1);
    (session, blobs)
}

fn compiled_presentation(
    manifest: &mut ContainerManifestV1,
    blobs: &mut BTreeMap<String, Vec<u8>>,
    sources: &[&str],
) {
    let expressions = sources
        .iter()
        .map(|source| {
            // Snapshot from compileWxmlExpression("count.constructor") in
            // compiler 1.0.0. Its result differs from native ECMAScript and
            // therefore detects accidental execution of the original source.
            let code = if *source == "count.constructor" {
                "((__wcWxs0.read((count),\"constructor\"))\n)"
            } else {
                source
            };
            let hash = hex_digest(code.as_bytes());
            blobs.insert(format!("sha256:{hash}"), code.as_bytes().to_vec());
            json!({"source":source,"shorthand":false,"helper":"__wcWxs0","executableSha256":hash})
        })
        .collect::<Vec<_>>();
    // Arithmetic uses identity execution bytes; the constructor expression
    // exercises the compiler ABI without spawning Node from a Rust test.
    manifest.view_compilation = Some(
        serde_json::from_value(json!({
            "compiler":"weapp-container-wxs","version":"1.0.0","abi":"1.0",
            "modules":[],"documents":[{"documentId":"pages/index/index.wxml",
                "wxmlAst":manifest.templates[0].wxml_ast,"expressions":expressions}]
        }))
        .unwrap(),
    );
    manifest.refresh_integrity().unwrap();
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn compiled_presentation_reload_replaces_expressions_and_retains_live_state() {
    for engine in [
        #[cfg(feature = "quickjs-native")]
        container_core::EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        container_core::EngineKind::V8,
    ] {
        let (mut session, _) = fixture_with_engine(Some(engine));
        let before = retained_state(&session);
        let mut candidate = session.manifest().clone();
        let mut blobs = presentation(
            &mut candidate,
            "{{count + 10}}/{{count.constructor}}",
            "blue",
        );
        compiled_presentation(
            &mut candidate,
            &mut blobs,
            &["count", "count + 10", "count.constructor"],
        );
        let mut preview = Session::new(candidate.clone(), session.config().clone()).unwrap();
        preview
            .preview_dev_render(
                &session,
                &json!({
                    "templateId":TEMPLATE,"blobs":blobs,"viewport":{"width":80,"height":48}
                }),
            )
            .unwrap();
        assert_eq!(retained_state(&session), before);
        session.replace_manifest(candidate).unwrap();
        render(&mut session, &blobs, 2);
        let texts = session
            .renderer()
            .last_frame()
            .unwrap()
            .query("text", true)
            .unwrap();
        assert_eq!(texts[0].children[0].text.as_deref(), Some("7"));
        assert_eq!(texts[1].children[0].text.as_deref(), Some("17/Number"));
        let after = retained_state(&session);
        for field in ["sessionId", "protocol", "lifecycle", "pages", "storage"] {
            assert_eq!(before[field], after[field], "{engine:?}/{field}");
        }
    }
}

fn retained_state(session: &Session) -> Value {
    json!({
        "sessionId": session.config().session_id,
        "protocol": session.protocol().to_string(),
        "lifecycle": format!("{:?}", session.app_service().lifecycle().state()),
        "pages": session.app_service().pages().iter().collect::<Vec<_>>(),
        "storage": session.app_service().storage().snapshot_state(),
        "view": session.view(),
        "frame": session.renderer().last_frame(),
        "snapshot": session.renderer().snapshot(),
    })
}

#[test]
fn execution_changes_are_rejected_without_mutating_a_live_session() {
    type ManifestMutation = (&'static str, fn(&mut ContainerManifestV1));

    let (mut session, blobs) = fixture();
    let baseline = session.manifest().clone();
    let state = retained_state(&session);
    let mutations: &[ManifestMutation] = &[
        ("module bytes", |manifest| {
            manifest.modules[0].sha256 = hex_digest(b"changed")
        }),
        ("module graph", |manifest| {
            manifest.modules[0].dependencies = vec!["module:helper.js".into()]
        }),
        ("module format", |manifest| {
            manifest.modules[0].format = ModuleFormat::Esm
        }),
        ("application configuration", |manifest| {
            manifest.app.app_json = "app-next.json".into()
        }),
        ("routes", |manifest| {
            manifest.routes[0].config = Some("pages/index/next.json".into())
        }),
        ("component declarations", |manifest| {
            manifest.components.push(Component {
                id: "components:app".into(),
                owner: "app.json".into(),
                using_components: BTreeMap::new(),
                multiple_slots: Some(true),
            })
        }),
        ("capabilities", |manifest| {
            manifest
                .capabilities
                .insert("wx.setStorageSync".into(), CapabilitySupport::Partial);
        }),
        ("protocol", |manifest| {
            manifest.protocol_version = "1.1".into()
        }),
    ];
    for (name, mutate) in mutations {
        let mut candidate = baseline.clone();
        mutate(&mut candidate);
        candidate.refresh_integrity().unwrap();
        candidate.validate().unwrap();
        assert!(
            session.replace_manifest(candidate).is_err(),
            "accepted {name}"
        );
        assert_eq!(
            session.manifest(),
            &baseline,
            "manifest changed after {name}"
        );
        assert_eq!(
            retained_state(&session),
            state,
            "state changed after {name}"
        );
    }
    // Rejection also leaves the current program usable by subsequent work.
    render(&mut session, &blobs, 2);
    assert_eq!(session.renderer().last_frame().unwrap().frame_id, 2);
}

#[test]
fn presentation_replacement_keeps_instances_and_storage_and_renders_new_resources() {
    let (mut session, _) = fixture();
    let before = retained_state(&session);
    let old_pixels = session.renderer().snapshot().unwrap().pixels;
    let mut candidate = session.manifest().clone();
    candidate.compiler.commit = "presentation-reload-next-build".into();
    let blobs = presentation(&mut candidate, "updated", "blue");
    // A directly embedded preview may omit data just like render.commit. Its
    // default is the live page, even though the candidate has never started.
    let mut preview = Session::new(candidate.clone(), session.config().clone()).unwrap();
    preview
        .preview_dev_render(
            &session,
            &json!({"templateId":TEMPLATE,"blobs":blobs,"viewport":{"width":80,"height":48}}),
        )
        .unwrap();
    let texts = preview
        .renderer()
        .last_frame()
        .unwrap()
        .query("text", true)
        .unwrap();
    assert_eq!(texts[0].children[0].text.as_deref(), Some("7"));
    assert_eq!(retained_state(&session), before);
    session.replace_manifest(candidate.clone()).unwrap();
    assert_eq!(session.manifest(), &candidate);
    assert_eq!(retained_state(&session), before);
    render(&mut session, &blobs, 2);
    assert_ne!(session.renderer().snapshot().unwrap().pixels, old_pixels);
    assert_eq!(session.app_service().pages().len(), 2);
    assert_eq!(
        session.app_service().pages().current().unwrap().data["count"],
        7
    );
    assert_eq!(
        session.app_service().storage().get("persisted"),
        Some(&json!({"value":42}))
    );
    assert_eq!(session.config().session_id, SESSION);
}
