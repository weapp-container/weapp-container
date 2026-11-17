//! Real-engine scheduling provenance, distinct from GPU/physical presentation.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope, BridgeErrorCode};
use container_core::EngineKind;
use container_ir::*;
use container_render_skia::{PageRenderMode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const TEMPLATE: &str = "template:pages/index/index.wxml";

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request("session-1", operation, operation, payload)
}

fn success(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(request(operation, payload));
    assert!(
        !batch
            .messages
            .iter()
            .any(|message| { message.op == op::ERROR || message.payload["ok"] == false }),
        "{batch:?}"
    );
    batch.messages[0].payload.clone()
}

fn fixture(engine: EngineKind) -> (Session, Value) {
    let app = "App({attached:0,ready:0});exports.inspect=()=>({attached:getApp().attached,ready:getApp().ready});";
    let page = "Page({data:{count:1},onReady(){getApp().ready++;this.setData({count:3})}});";
    let component = "Component({lifetimes:{attached(){getApp().attached++;getCurrentPages()[0].setData({count:2})}}});";
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "external-input-fixture".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "module:app.js".into(),
        },
        routes: vec![Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{ROUTE}.js"),
        }],
        components: vec![Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
            multiple_slots: None,
        }],
        capabilities: BTreeMap::from([
            ("wx.pageScrollTo".into(), CapabilitySupport::Full),
            ("getCurrentPages".into(), CapabilitySupport::Full),
            ("wx.createSelectorQuery".into(), CapabilitySupport::Full),
        ]),
        ..Default::default()
    };
    let mut modules = Vec::new();
    for (id, source, scope) in [
        ("module:app.js", app, ModuleScope::App),
        ("module:pages/index/index.js", page, ModuleScope::Page),
        (
            "module:components/panel/index.js",
            component,
            ModuleScope::Component,
        ),
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
    let mut blobs = serde_json::Map::new();
    for (id, source) in [
        (
            TEMPLATE,
            r#"<view id="root" data-count="{{count}}" style="height:1000px"><panel/></view>"#,
        ),
        (
            "template:components/panel/index.wxml",
            r#"<view style="height:10px"/>"#,
        ),
    ] {
        let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        manifest.templates.push(Template {
            id: id.into(),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: Default::default(),
        });
        blobs.insert(pointer, json!(bytes));
    }
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        page_render_mode: PageRenderMode::ExternalFrame,
        ..Default::default()
    };
    config.host.window_width = 100;
    config.host.window_height = 50;
    let mut session = Session::new(manifest, config).unwrap();
    // Supply verified View resources on the first render, so the component
    // attaches after that render's root clone rather than during page.push.
    success(&mut session, op::APP_INIT, json!({"modules":modules}));
    success(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
    (
        session,
        json!({"templateId":TEMPLATE,"viewport":{"x":12.5,"y":-7.25,"width":100,"height":50},"blobs":blobs}),
    )
}

fn render(session: &mut Session, payload: Value) -> u64 {
    success(session, op::RENDER_COMMIT, payload);
    session.renderer().snapshot_revision()
}

fn inspect(session: &mut Session) -> Value {
    success(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":"inspect"}),
    )["result"][0]
        .clone()
}

#[test]
fn generated_frame_keeps_clone_time_input_across_attached_and_ack_writes() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let before = session.view().template_revision;
        let page = session.app_service().pages().current().unwrap().id;
        let revision = render(&mut session, payload);
        let input = session.last_frame_input(revision).unwrap().clone();
        assert_eq!(input.page_id, page);
        assert_eq!(input.route_path, ROUTE);
        assert_eq!(input.template_revision, before);
        assert_eq!(input.viewport.x, 12.5);
        assert_eq!(input.viewport.y, -7.25);
        assert_eq!(input.viewport.width, 100.0);
        assert_eq!(input.viewport.height, 50.0);
        let frame = session.renderer().last_frame().unwrap();
        assert_eq!(
            frame.query("#root", false).unwrap()[0].attributes["data-count"],
            "1"
        );
        // ExternalFrame returns before draining component host events. A real
        // module turn makes attached's setData visible in Rust without rendering.
        assert_eq!(inspect(&mut session), json!({"attached":1,"ready":0}));
        assert!(
            session.view().template_revision > before,
            "attached must write after the root clone"
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            2
        );
        assert_eq!(session.last_frame_input(revision), Some(&input));
        session.acknowledge_presentation(revision).unwrap();
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            3
        );
        assert_eq!(inspect(&mut session), json!({"attached":1,"ready":1}));
        assert_eq!(session.last_frame_input(revision), Some(&input));
        assert!(session.last_frame_input(0).is_none());
        assert!(session.last_frame_input(revision + 1).is_none());
    }
}

#[test]
fn retained_scale_scroll_and_diagnostic_readback_carry_old_input_without_evaluation() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let first = render(&mut session, payload);
        session.acknowledge_presentation(first).unwrap();
        let input = session.last_frame_input(first).unwrap().clone();
        let page = input.page_id;
        success(
            &mut session,
            op::DATA_PATCH_BATCH,
            json!({"pageId":page.0,"patches":[{"path":"count","op":"set","value":99}]}),
        );
        assert!(session.view().template_revision > input.template_revision);
        session.set_render_scale(2.0).unwrap();
        let scaled = session.renderer().snapshot_revision();
        assert!(scaled > first);
        assert!(session.last_frame_input(first).is_none());
        assert_eq!(session.last_frame_input(scaled), Some(&input));
        session.set_render_scale(2.0).unwrap();
        assert_eq!(session.renderer().snapshot_revision(), scaled);
        assert!(session.set_render_scale(f64::NAN).is_err());
        assert_eq!(session.renderer().snapshot_revision(), scaled);
        assert_eq!(session.last_frame_input(scaled), Some(&input));
        assert!(session.capture_render_snapshot().unwrap().is_some());
        assert_eq!(session.last_frame_input(scaled), Some(&input));
        session.acknowledge_presentation(scaled).unwrap();
        success(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.pageScrollTo","scrollTop":120,"duration":0}),
        );
        let scrolled = session.renderer().snapshot_revision();
        assert!(scrolled > scaled);
        assert!(session.last_frame_input(scaled).is_none());
        assert_eq!(session.last_frame_input(scrolled), Some(&input));
        session.acknowledge_presentation(scrolled).unwrap();
        assert_eq!(inspect(&mut session), json!({"attached":1,"ready":1}));
        assert_eq!(
            session
                .renderer()
                .last_frame()
                .unwrap()
                .query("#root", false)
                .unwrap()[0]
                .attributes["data-count"],
            "1"
        );
    }
}

#[test]
fn current_scene_density_repaint_preserves_exact_input_and_rejects_old_page_or_replacement() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        assert_eq!(session.repaint_current_skia_page(2.0).unwrap(), None);
        assert!(session.renderer_if_initialized().is_none());
        let first = render(&mut session, payload.clone());
        session.acknowledge_presentation(first).unwrap();
        assert!(session.has_current_skia_scene());
        let input = session.last_frame_input(first).unwrap().clone();
        success(
            &mut session,
            op::DATA_PATCH_BATCH,
            json!({"pageId":input.page_id.0,"patches":[{"path":"count","op":"set","value":99}]}),
        );
        let viewport = session.accepted_page_observation().unwrap().frame.viewport;
        let old_target = session.accepted_page_observation().unwrap().target;
        let staged_target = session.stage_skia_render_target(viewport, 2.0).unwrap();
        assert_ne!(old_target, staged_target);
        assert_eq!(session.render_revision(), first);
        let scaled = session.repaint_current_skia_page(2.0).unwrap().unwrap();
        assert!(scaled > first);
        assert_eq!(
            session.accepted_page_observation().unwrap().target,
            staged_target
        );
        assert_eq!(session.last_frame_input(scaled), Some(&input));
        assert_eq!(
            session.repaint_current_skia_page(2.0).unwrap(),
            Some(scaled)
        );
        assert!(session.repaint_current_skia_page(f64::NAN).is_err());
        assert_eq!(session.render_revision(), scaled);
        assert_eq!(session.last_frame_input(scaled), Some(&input));
        session.acknowledge_presentation(scaled).unwrap();
        assert_eq!(inspect(&mut session), json!({"attached":1,"ready":1}));

        // A same-id/frame replacement keeps its own accepted picture, but a
        // stale evaluated document must not authorize a current-page repaint.
        let frame = session.accepted_page_observation().unwrap().frame.clone();
        let mut replacement = container_render_skia::SkiaRenderer::new_frame_export_only();
        container_render_skia::Renderer::commit(&mut replacement, frame).unwrap();
        let target = replacement.accepted_render_target();
        *session.renderer_mut() = replacement;
        let replaced_revision = session.render_revision();
        assert_eq!(
            session.accepted_page_observation().map(|o| o.target),
            target
        );
        assert!(!session.has_current_skia_scene());
        assert_eq!(session.repaint_current_skia_page(3.0).unwrap(), None);
        assert_eq!(session.render_revision(), replaced_revision);
        render(&mut session, payload);
        assert!(session.has_current_skia_scene());

        let old_revision = session.render_revision();
        success(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":input.route_path}),
        );
        assert!(!session.has_current_skia_scene());
        assert_eq!(session.repaint_current_skia_page(2.0).unwrap(), None);
        assert_eq!(session.render_revision(), old_revision);
    }
}

#[test]
fn rejected_frames_keep_only_the_previous_proof_and_manual_or_explicit_data_cannot_claim_it() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let old = render(&mut session, payload.clone());
        let input = session.last_frame_input(old).unwrap().clone();
        let mut invalid = payload.clone();
        invalid["viewport"]["width"] = json!(-1);
        let failed = session.dispatch(request(op::RENDER_COMMIT, invalid));
        assert!(failed
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false));
        assert_eq!(session.renderer().snapshot_revision(), old);
        assert_eq!(session.last_frame_input(old), Some(&input));
        let mut explicit = payload.clone();
        explicit["data"] = session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        let explicit_revision = render(&mut session, explicit);
        assert!(session.last_frame_input(old).is_none());
        assert!(session.last_frame_input(explicit_revision).is_none());
        let implicit_revision = render(&mut session, payload);
        assert!(session.last_frame_input(implicit_revision).is_some());
        let manual = serde_json::to_value(session.renderer().last_frame().unwrap()).unwrap();
        let manual_revision = render(&mut session, json!({"frame":manual}));
        assert!(manual_revision > implicit_revision);
        assert!(session.last_frame_input(manual_revision).is_none());
        assert!(session.last_frame_input(implicit_revision).is_none());
    }
}

#[test]
fn detached_preview_and_retired_lifetimes_never_relabel_old_pixels_as_current_input() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let revision = render(&mut session, payload.clone());
        let (mut candidate, _) = fixture(engine);
        candidate.preview_dev_render(&session, &payload).unwrap();
        assert!(candidate.renderer().last_frame().is_some());
        assert!(candidate
            .last_frame_input(candidate.renderer().snapshot_revision())
            .is_none());
        assert_eq!(inspect(&mut candidate), json!({"attached":0,"ready":0}));
        success(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        success(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_eq!(session.renderer().snapshot_revision(), revision);
        assert!(
            session.last_frame_input(revision).is_none(),
            "show cannot revive retired input"
        );
        let revision = render(&mut session, payload.clone());
        success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
        success(&mut session, op::PAGE_POP, json!({}));
        assert!(
            session.last_frame_input(revision).is_none(),
            "returning to the same PageId cannot revive proof"
        );
        let revision = render(&mut session, payload.clone());
        session.notify_viewport_resize(120, 60).unwrap();
        assert!(session.last_frame_input(revision).is_none());
        let revision = render(&mut session, payload.clone());
        let mut manifest = session.manifest().clone();
        manifest.templates[0].bindings.push("unused".into());
        manifest.refresh_integrity().unwrap();
        session.replace_manifest(manifest).unwrap();
        assert!(session.last_frame_input(revision).is_none());
        let revision = render(&mut session, payload.clone());
        let _ = session.renderer_mut();
        assert!(
            session.last_frame_input(revision).is_none(),
            "an unrestricted renderer borrow retires proof"
        );
        let revision = render(&mut session, payload);
        let _ = session.app_service_mut();
        assert!(
            session.last_frame_input(revision).is_none(),
            "an unrestricted host-state borrow retires proof"
        );
    }
}

fn selector(session: &mut Session) -> container_bridge::BridgeBatch {
    session.dispatch(request(
        op::API_CALL,
        json!({"name":"wx.createSelectorQuery","selector":"#root"}),
    ))
}

#[test]
fn legacy_same_revision_replacement_retires_presented_input_and_selector_authority() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let revision = render(&mut session, payload.clone());
        session.acknowledge_presentation(revision).unwrap();
        assert!(session.is_current_frame_presented());
        assert_eq!(selector(&mut session).messages[0].payload["ok"], true);
        let frame = session.renderer().last_frame().unwrap().clone();
        let mut replacement = container_render_skia::SkiaRenderer::new_frame_export_only();
        replacement.commit(frame.clone()).unwrap();
        assert_eq!(replacement.snapshot_revision(), revision);
        *session.renderer_mut() = replacement;

        assert_eq!(session.render_revision(), revision);
        assert_eq!(
            session.accepted_page_observation().unwrap().frame.frame_id,
            frame.frame_id
        );
        assert!(session.last_frame_input(revision).is_none());
        assert!(!session.has_current_skia_scene());
        assert!(!session.is_current_frame_presented());
        assert_eq!(
            session.acknowledge_presentation(revision).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(
            selector(&mut session).messages[0].payload["error"]["code"],
            "ERR_RENDER"
        );
        assert!(!session.is_current_frame_presented());

        // A real new commit and host ACK reestablish ownership. A raw renderer
        // replacement must neither carry that approval nor permanently block it.
        let next = render(&mut session, payload);
        assert!(next > revision);
        assert_eq!(
            selector(&mut session).messages[0].payload["error"]["code"],
            "ERR_RENDER"
        );
        session.acknowledge_presentation(next).unwrap();
        assert!(session.is_current_frame_presented());
        assert_eq!(selector(&mut session).messages[0].payload["ok"], true);
        assert_eq!(inspect(&mut session)["ready"], 1);
    }
}

#[test]
fn legacy_replacement_retires_pending_generated_ack_before_manual_commit() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let revision = render(&mut session, payload.clone());
        assert_eq!(inspect(&mut session)["ready"], 0);
        let frame = session.renderer().last_frame().unwrap().clone();
        let mut replacement = container_render_skia::SkiaRenderer::new_frame_export_only();
        replacement.commit(frame.clone()).unwrap();
        assert_eq!(replacement.snapshot_revision(), revision);
        *session.renderer_mut() = replacement;
        assert_eq!(
            session.acknowledge_presentation(revision).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        assert!(!session.is_current_frame_presented());
        assert_eq!(inspect(&mut session)["ready"], 0);

        // Explicit bridge frames still own their normal permit-free ACK path;
        // they must not inherit the retired generated frame's ready flag/proof.
        let manual = render(&mut session, json!({"frame":frame}));
        assert!(manual > revision);
        assert!(session.last_frame_input(manual).is_none());
        assert_eq!(
            selector(&mut session).messages[0].payload["error"]["code"],
            "ERR_RENDER"
        );
        session.acknowledge_presentation(manual).unwrap();
        assert!(session.is_current_frame_presented());
        assert_eq!(inspect(&mut session)["ready"], 0);
        assert_eq!(selector(&mut session).messages[0].payload["ok"], true);

        let next = render(&mut session, payload);
        session.acknowledge_presentation(next).unwrap();
        assert_eq!(inspect(&mut session)["ready"], 1);
    }
}
