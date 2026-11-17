//! Real JS engines and evaluated WXML with a protocol-only browser peer. These
//! contracts exercise event/effect ownership; they are not browser evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_render_skia::Renderer;
use container_runtime::{BrowserViewSubmission, Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FIRST: &str = "pages/first/index";
const SECOND: &str = "pages/second/index";
const APP: &str = r#"
App({trace:[]});
exports.inspect = function() { return {trace:getApp().trace}; };
"#;
const FIRST_JS: &str = r#"
Page({
  data:{count:0},
  navigate:function() {
    getApp().trace.push('navigate');
    wx.navigateTo({url:'/pages/second/index'});
  },
  stale:function() {
    getApp().trace.push('stale-listener');
    wx.setStorageSync('stale-listener', true);
    this.setData({count:999});
  },
  throws:function() {
    getApp().trace.push('throw');
    this.setData({count:42});
    wx.setStorageSync('before-throw', {committed:true, values:[7,false]});
    throw new Error('browser-handler-failure');
  }
});
"#;
const SECOND_JS: &str = r#"
Page({data:{}, onLoad:function() { getApp().trace.push('second:load'); }});
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let result = session.dispatch(BridgeEnvelope::request(
        "session-1",
        operation,
        operation,
        payload,
    ));
    assert!(
        !result
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false),
        "{result:?}"
    );
    result.messages[0].payload.clone()
}

fn fixture(engine: EngineKind) -> (Session, BrowserViewSubmission) {
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "browser-navigation-contract".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "module:app.js".into(),
        },
        capabilities: BTreeMap::from([
            ("wx.navigateTo".into(), CapabilitySupport::Full),
            ("wx.setStorageSync".into(), CapabilitySupport::Full),
        ]),
        ..Default::default()
    };
    for route in [FIRST, SECOND] {
        manifest.routes.push(Route {
            id: format!("route:{route}"),
            path: route.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{route}.js"),
        });
    }
    let mut modules = Vec::new();
    for (id, source, scope) in [
        ("module:app.js", APP, ModuleScope::App),
        ("module:pages/first/index.js", FIRST_JS, ModuleScope::Page),
        ("module:pages/second/index.js", SECOND_JS, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: Vec::new(),
        });
        modules.push(json!({"id":id,"source":source}));
    }
    let mut blobs = BTreeMap::new();
    for (route, wxml) in [
        (
            FIRST,
            r#"<view><view id="navigate" bindtap="navigate"/><view id="stale" bindtap="stale"/><view id="throws" bindtap="throws">{{count}}</view></view>"#,
        ),
        (SECOND, "<view>next page</view>"),
    ] {
        let bytes = parse_wxml(wxml).unwrap().canonical_json().unwrap();
        let hash = format!("sha256:{}", hex_digest(&bytes));
        manifest.templates.push(Template {
            id: format!("template:{route}.wxml"),
            wxml_ast: hash.clone(),
            bindings: Vec::new(),
            wxs_modules: Default::default(),
        });
        blobs.insert(hash, bytes);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            renderer_override: Some(RendererProfile::WebView),
            browser_view_enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    dispatch(
        &mut session,
        op::APP_INIT,
        json!({"modules":modules,"blobs":blobs}),
    );
    dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    dispatch(&mut session, op::PAGE_PUSH, json!({"path":FIRST}));
    let submission = session
        .prepare_browser_view(
            &json!({
                "templateId":format!("template:{FIRST}.wxml"), "useSessionResources":true,
                "viewport":{"width":375,"height":667}
            }),
            1,
        )
        .unwrap();
    let mut nodes = Vec::new();
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 0.0,
                y: 0.0,
                width: 100.0,
                height: 30.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 100.0,
                height: 30.0,
            },
            client_size: ViewSize {
                width: 100.0,
                height: 30.0,
            },
        });
        if let ViewNode::Element { children, .. } = node {
            pending.extend(children);
        }
    }
    let permit = session
        .prepare_browser_commit(BrowserGeometryBatch {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: submission.key.clone(),
            epoch: 0,
            viewport: submission.viewport,
            nodes,
        })
        .unwrap();
    session.acknowledge_browser_presentation(&permit).unwrap();
    assert!(session.is_browser_view_presented());
    assert!(session.renderer().last_frame().is_none());
    (session, submission)
}

fn target(submission: &BrowserViewSubmission, public_id: &str) -> String {
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        if let ViewNode::Element {
            attrs, children, ..
        } = node
        {
            if attrs.get("id").is_some_and(|id| id == public_id) {
                return node.occurrence_id().into();
            }
            pending.extend(children);
        }
    }
    panic!("missing event target {public_id}");
}

fn input(submission: &BrowserViewSubmission, public_ids: &[&str]) -> Value {
    json!({"version":"1.0", "key":submission.key, "epoch":"0",
        "events":public_ids.iter().map(|id| json!({
            "type":"tap", "targetOccurrenceId":target(submission,id), "detail":{}
        })).collect::<Vec<_>>()})
}

fn consumed(batch: &BridgeBatch) -> &Value {
    let receipts: Vec<_> = batch
        .messages
        .iter()
        .filter(|message| message.op == "view.events.consumed")
        .collect();
    assert_eq!(receipts.len(), 1, "one consumption receipt: {batch:?}");
    &receipts[0].payload
}

fn trace(session: &mut Session) -> Value {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({
            "moduleId":"module:app.js", "export":"inspect", "args":[]
        }),
    )["result"][0]["trace"]
        .clone()
}

#[test]
fn navigation_consumes_first_browser_event_and_drops_remaining_old_page_input() {
    for engine in engines() {
        let (mut session, submission) = fixture(engine);
        let batch = session
            .dispatch_browser_events(input(&submission, &["navigate", "stale"]))
            .expect("committed navigation must retain a batch receipt");

        // Inspect Rust state before any subsequent engine call can accidentally
        // drain deferred effects and mask a missing event-loop checkpoint.
        let current = session.app_service().pages().current().unwrap();
        assert_eq!(current.path, SECOND);
        assert_ne!(current.id.0, submission.key.page_id);
        assert_eq!(session.app_service().storage().get("stale-listener"), None);
        assert!(!session.is_browser_view_presented());
        assert_eq!(consumed(&batch)["key"], json!(submission.key));
        assert_eq!(consumed(&batch)["events"], 1);
        assert_eq!(consumed(&batch)["dropped"], 1);
        assert!(
            batch.messages.iter().any(|message| message.op == op::ERROR
                && message.payload["error"]["code"] == "ERR_CANCELLED"),
            "retired input must carry a diagnostic: {batch:?}"
        );
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.op == op::EVENT_BATCH),
            "committed navigation effects remain in the response: {batch:?}"
        );
        assert!(session
            .dispatch_browser_events(input(&submission, &["stale"]))
            .is_err());
        assert_eq!(trace(&mut session), json!(["navigate", "second:load"]));
        assert!(session.renderer().last_frame().is_none());
    }
}

#[test]
fn browser_handler_throw_keeps_prior_data_and_storage_effects_and_diagnostics() {
    for engine in engines() {
        let (mut session, submission) = fixture(engine);
        let batch = session
            .dispatch_browser_events(input(&submission, &["throws"]))
            .expect("a reported user exception must not erase its committed effects");

        // Check before inspecting JavaScript so this call itself must have
        // applied both mutations despite the ordinary listener exception.
        let current = session.app_service().pages().current().unwrap();
        assert_eq!(current.id.0, submission.key.page_id);
        assert_eq!(current.data["count"], 42);
        assert_eq!(
            session.app_service().storage().get("before-throw"),
            Some(&json!({"committed":true,"values":[7,false]}))
        );
        assert_eq!(consumed(&batch)["events"], 1);
        assert_eq!(consumed(&batch)["dropped"], 0);
        assert!(
            batch
                .messages
                .iter()
                .filter(|message| message.op == op::ERROR)
                .filter_map(|message| message.payload["errors"].as_array())
                .flatten()
                .any(|error| error["message"] == "browser-handler-failure"),
            "the consumed response retains the user exception: {batch:?}"
        );
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.op == op::EVENT_BATCH),
            "committed data/storage effects remain observable: {batch:?}"
        );
        assert_eq!(trace(&mut session), json!(["throw"]));
        assert!(session.renderer().last_frame().is_none());
    }
}
