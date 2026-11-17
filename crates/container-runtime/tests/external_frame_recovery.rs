//! Local real-engine recovery contracts, separate from browser/GPU evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_render_skia::{PageRenderMode, Rect, Renderer};
use container_runtime::{ExternalFrameRecoveryExpected, Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const HOME: &str = "pages/home/index";
const SECOND: &str = "pages/second/index";
const TEMPLATE: &str = "template:pages/home/index.wxml";
const WXS: &str = "wxs:shared/counter.wxs";

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn success(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        operation,
        operation,
        payload,
    ));
    assert!(
        batch
            .messages
            .iter()
            .all(|message| { message.op != op::ERROR && message.payload["ok"] != false }),
        "{batch:?}"
    );
    batch.messages[0].payload.clone()
}

fn fixture(engine: EngineKind) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "external-recovery-stateful-view-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "module:app.js".into();
    manifest.capabilities = BTreeMap::from([
        ("wx.setStorageSync".into(), CapabilitySupport::Full),
        ("wx.timer".into(), CapabilitySupport::Full),
    ]);
    manifest.routes = [HOME, SECOND]
        .into_iter()
        .map(|path| Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{path}.js"),
        })
        .collect();
    let mut modules = Vec::new();
    for (id, source, scope) in [
        (
            "module:app.js",
            "App({ready:0,timerCalls:0});exports.inspect=function(){return {ready:getApp().ready,timerCalls:getApp().timerCalls};};exports.arm=function(){wx.setStorageSync('recovery-keep',9);return setTimeout(function(){getApp().timerCalls++;},60000);};",
            ModuleScope::App,
        ),
        (
            "module:pages/home/index.js",
            "Page({data:{count:1},onReady:function(){getApp().ready++;}});",
            ModuleScope::Page,
        ),
        ("module:pages/second/index.js", "Page({});", ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
        modules.push(json!({"id":id,"source":source}));
    }
    let wxs = b"var calls=0;exports.next=function(){calls++;return calls;};";
    let wxs_hash = hex_digest(wxs);
    manifest.view_scripts.push(ViewScriptModule {
        id: WXS.into(),
        sha256: wxs_hash.clone(),
        dependencies: vec![],
    });
    let markup = r#"<wxs module="counter" src="../../shared/counter.wxs"/><view id="root" data-call="{{counter.next()}}" data-count="{{count}}"/>"#;
    let ast = parse_wxml(markup).unwrap().canonical_json().unwrap();
    let ast_hash = hex_digest(&ast);
    manifest.templates.push(Template {
        id: TEMPLATE.into(),
        wxml_ast: format!("sha256:{ast_hash}"),
        bindings: vec![],
        wxs_modules: BTreeMap::from([("counter".into(), WXS.into())]),
    });
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        page_render_mode: PageRenderMode::ExternalFrame,
        ..Default::default()
    };
    config.host.window_width = 100;
    config.host.window_height = 50;
    let mut session = Session::new(manifest, config).unwrap();
    let blobs = BTreeMap::from([
        (format!("sha256:{wxs_hash}"), wxs.to_vec()),
        (format!("sha256:{ast_hash}"), ast),
    ]);
    success(
        &mut session,
        op::APP_INIT,
        json!({"modules":modules,"blobs":blobs}),
    );
    success(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    success(&mut session, op::PAGE_PUSH, json!({"path":HOME}));
    session
}

fn inspect(session: &mut Session) -> Value {
    success(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":"inspect"}),
    )["result"][0]
        .clone()
}

fn expected(session: &Session) -> ExternalFrameRecoveryExpected {
    let page = session.app_service().pages().current().unwrap();
    ExternalFrameRecoveryExpected {
        session_id: session.config().session_id.clone(),
        page_id: page.id.0.to_string(),
        route_path: page.path.clone(),
        viewport: Rect {
            x: 0.0,
            y: 0.0,
            width: session.config().host.window_width as f32,
            height: session.config().host.window_height as f32,
        },
        renderer_profile: RendererProfile::Skia,
        template_revision: session.view().template_revision.to_string(),
        render_revision: session.renderer().snapshot_revision().to_string(),
        input_lifetime_revision: session.input_lifetime_revision().unwrap().to_string(),
    }
}

fn recover(session: &mut Session) -> Value {
    let identity = expected(session);
    serde_json::to_value(session.recover_external_frame(&identity).unwrap()).unwrap()
}

fn render(session: &mut Session) -> u64 {
    let viewport = expected(session).viewport;
    success(
        session,
        op::RENDER_COMMIT,
        json!({"templateId":TEMPLATE,"useSessionResources":true,"viewport":viewport}),
    );
    session.renderer().snapshot_revision()
}

fn attribute(session: &Session, name: &str) -> String {
    session
        .renderer()
        .last_frame()
        .unwrap()
        .query("#root", false)
        .unwrap()[0]
        .attributes[name]
        .clone()
}

fn ack(session: &mut Session, revision: u64) {
    let batch = session.acknowledge_presentation(revision).unwrap();
    assert!(
        batch
            .messages
            .iter()
            .all(|message| { message.op != op::ERROR && message.payload["ok"] != false }),
        "{batch:?}"
    );
    assert!(session.is_current_frame_presented());
}

#[test]
fn retained_recovery_preserves_stateful_wxs_heap_ready_storage_and_real_timer() {
    for engine in engines() {
        let mut session = fixture(engine);
        let js_timer = success(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"arm"}),
        )["result"][0]
            .as_u64()
            .unwrap();
        assert!(js_timer > 0);
        // JavaScript timers live in the engine heap. Register a separate host
        // timer through its public bridge API to check both ownership domains.
        let host_timer = success(
            &mut session,
            op::API_CALL,
            json!({"name":"setTimeout","delayMs":60000,"callbackId":"recovery-host-timer"}),
        )["timerId"]
            .as_u64()
            .unwrap();
        let timers = session
            .app_service()
            .timers()
            .entries()
            .cloned()
            .collect::<Vec<_>>();
        assert_eq!(timers.len(), 1);
        assert_eq!(timers[0].id.0, host_timer);
        let first = render(&mut session);
        assert_eq!(attribute(&session, "data-call"), "1");
        assert_eq!(inspect(&mut session), json!({"ready":0,"timerCalls":0}));
        assert_eq!(recover(&mut session)["kind"], "retained");
        assert_eq!(attribute(&session, "data-call"), "1");
        assert!(!session.is_current_frame_presented());
        assert!(session.acknowledge_presentation(first).is_err());
        let revision = session.renderer().snapshot_revision();
        ack(&mut session, revision);
        assert_eq!(inspect(&mut session), json!({"ready":1,"timerCalls":0}));
        assert_eq!(recover(&mut session)["kind"], "retained");
        let retained_revision = session.renderer().snapshot_revision();
        ack(&mut session, retained_revision);
        assert_eq!(attribute(&session, "data-call"), "1");
        assert_eq!(inspect(&mut session), json!({"ready":1,"timerCalls":0}));
        let page = session.app_service().pages().current().unwrap().id;
        success(
            &mut session,
            op::DATA_PATCH_BATCH,
            json!({"pageId":page.0,"patches":[{"path":"count","op":"set","value":2}]}),
        );
        assert_eq!(recover(&mut session)["kind"], "render-required");
        assert_eq!(attribute(&session, "data-call"), "1");
        assert!(session.acknowledge_presentation(retained_revision).is_err());
        let dirty_revision = render(&mut session);
        assert_eq!(
            attribute(&session, "data-call"),
            "2",
            "the first dirty render also detects hidden evaluations during retained recovery"
        );
        assert_eq!(attribute(&session, "data-count"), "2");
        ack(&mut session, dirty_revision);
        assert_eq!(inspect(&mut session), json!({"ready":1,"timerCalls":0}));
        assert_eq!(
            session.app_service().storage().get("recovery-keep"),
            Some(&json!(9))
        );
        assert_eq!(
            session
                .app_service()
                .timers()
                .entries()
                .cloned()
                .collect::<Vec<_>>(),
            timers
        );
        let fired = session.poll_timers(u64::MAX);
        assert!(
            fired.messages.iter().all(|message| message.op != op::ERROR),
            "{fired:?}"
        );
        let engine_event = match engine {
            EngineKind::Quickjs => "quickjs.timer",
            EngineKind::V8 => "v8.timer",
        };
        assert!(fired.messages.iter().any(|message| {
            message.payload["type"] == engine_event
                && message.payload["timers"] == json!([js_timer])
        }));
        assert!(fired.messages.iter().any(|message| {
            message.payload["type"] == "timer" && message.payload["timers"][0]["id"] == host_timer
        }));
        assert_eq!(inspect(&mut session), json!({"ready":1,"timerCalls":1}));
        assert!(session.poll_timers(u64::MAX).messages.is_empty());
        assert_eq!(inspect(&mut session), json!({"ready":1,"timerCalls":1}));
        assert_eq!(attribute(&session, "data-call"), "2");
    }
}

#[test]
fn recovery_after_same_page_return_or_resize_requires_fresh_input_proof() {
    for engine in engines() {
        let mut session = fixture(engine);
        let first = render(&mut session);
        ack(&mut session, first);
        let original_page = session.app_service().pages().current().unwrap().id;
        success(&mut session, op::PAGE_PUSH, json!({"path":SECOND}));
        success(&mut session, op::PAGE_POP, json!({}));
        assert_eq!(
            session.app_service().pages().current().unwrap().id,
            original_page
        );
        assert_eq!(recover(&mut session)["kind"], "render-required");
        assert!(session.acknowledge_presentation(first).is_err());
        assert_eq!(attribute(&session, "data-call"), "1");
        let returned = render(&mut session);
        ack(&mut session, returned);
        let resize = session.notify_viewport_resize(120, 60).unwrap();
        assert!(
            resize
                .messages
                .iter()
                .all(|message| message.op != op::ERROR),
            "{resize:?}"
        );
        assert_eq!(recover(&mut session)["kind"], "render-required");
        assert!(session.acknowledge_presentation(returned).is_err());
        let resized = render(&mut session);
        assert!(resized > returned);
        ack(&mut session, resized);
        assert_eq!(
            session.renderer().last_frame().unwrap().viewport,
            expected(&session).viewport
        );
        assert_eq!(inspect(&mut session)["ready"], 1);
    }
}
