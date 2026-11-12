//! Real-engine owner-thread contracts, not native GPU or device evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope, BridgeErrorCode};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat,
    ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::{PageRenderMode, Rect, Renderer};
use container_runtime::{
    ExternalFrameRecoveryExpected, HostDeviceOrientation, HostDisplayMetrics, HostLayout,
    HostReservedRegion, HostReservedRegionKind, HostSafeInsets, HostVerticalBarEdge,
    HostWindowMetrics, MenuButtonRect, Session, SessionConfig,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({trace:[],taps:0});
exports.inspect=()=>({trace:getApp().trace,taps:getApp().taps});
exports.arm=()=>{setTimeout(()=>getApp().trace.push({phase:'timer',width:wx.getWindowInfo().windowWidth}),0);};
"#;
const PAGE: &str = r#"
Page({data:{},onLoad(){wx.onHostLayoutChange(event=>getApp().trace.push({phase:'layout',event,observed:wx.getWindowInfo()}));},onResize(){getApp().trace.push({phase:'resize',width:wx.getWindowInfo().windowWidth});},
  tap(){getApp().taps++;}});
"#;

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> BridgeBatch {
    session.dispatch(BridgeEnvelope::request(
        "session-1",
        operation,
        operation,
        payload,
    ))
}

fn success(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = dispatch(session, operation, payload);
    assert!(
        batch
            .messages
            .iter()
            .all(|message| { message.op != op::ERROR && message.payload["ok"] != false }),
        "{batch:?}"
    );
    batch.messages[0].payload.clone()
}

fn call(session: &mut Session, export: &str) -> Value {
    success(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    )["result"][0]
        .clone()
}

fn metrics(width: u32) -> HostWindowMetrics {
    HostWindowMetrics {
        window_width: width,
        window_height: 480,
        display: HostDisplayMetrics {
            pixel_ratio: 2.0,
            screen_width: width,
            screen_height: 540,
            status_bar_height: 20.0,
            screen_top: 0.0,
            safe_area: None,
            host_layout: None,
            device_orientation: if width > 480 {
                HostDeviceOrientation::Landscape
            } else {
                HostDeviceOrientation::Portrait
            },
        },
    }
}

fn menu(width: u32) -> MenuButtonRect {
    MenuButtonRect {
        left: f64::from(width) - 90.0,
        right: f64::from(width) - 10.0,
        top: 24.0,
        bottom: 56.0,
        width: 80.0,
        height: 32.0,
    }
}

fn render(session: &mut Session, width: u32) -> u64 {
    success(
        session,
        op::RENDER_COMMIT,
        json!({"templateId":format!("template:{ROUTE}.wxml"),"useSessionResources":true,
            "viewport":{"width":width,"height":480}}),
    );
    session.render_revision()
}

fn fixture(engine: EngineKind) -> (Session, u64) {
    let source = r#"<view id="root" style="width:100%;height:1440px" bindtap="tap"/>"#;
    let ast = parse_wxml(source).unwrap().canonical_json().unwrap();
    let pointer = format!("sha256:{}", hex_digest(&ast));
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "host-layout-authority-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "module:app.js".into();
    manifest.routes.push(Route {
        id: format!("route:{ROUTE}"),
        path: ROUTE.into(),
        kind: RouteKind::Page,
        config: None,
        entry_module: format!("module:{ROUTE}.js"),
    });
    manifest.templates.push(Template {
        id: format!("template:{ROUTE}.wxml"),
        wxml_ast: pointer.clone(),
        bindings: vec![],
        wxs_modules: BTreeMap::new(),
    });
    for (id, source, scope) in [
        ("module:app.js", APP, ModuleScope::App),
        ("module:pages/index/index.js", PAGE, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    for name in [
        "wx.createSelectorQuery",
        "wx.getWindowInfo",
        "wx.onHostLayoutChange",
        "wx.offHostLayoutChange",
        "wx.pageScrollTo",
        "setTimeout",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        page_render_mode: PageRenderMode::ExternalFrame,
        ..Default::default()
    };
    // Do not relax the production View deadline to make the fixture pass.
    assert_eq!(config.view_execution.batch_timeout_ms, 50);
    config.host.window_width = 320;
    config.host.window_height = 480;
    config.host.display_metrics = Some(metrics(320).display);
    config.host.menu_button_rect = Some(menu(320));
    let mut session = Session::new(manifest, config).unwrap();
    success(
        &mut session,
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":APP},
            {"id":"module:pages/index/index.js","source":PAGE}],
            "blobs":{pointer:ast}}),
    );
    success(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
    let revision = render(&mut session, 320);
    session.acknowledge_presentation(revision).unwrap();
    assert!(session.is_current_frame_presented());
    assert_eq!(selector(&mut session).messages[0].payload["ok"], true);
    (session, revision)
}

fn layout_metrics(edge: HostVerticalBarEdge) -> HostWindowMetrics {
    let mut value = metrics(320);
    value.display.host_layout = Some(HostLayout {
        version: 1,
        safe_insets: HostSafeInsets {
            top: 0.0,
            right: 40.0,
            bottom: 20.0,
            left: 0.0,
        },
        vertical_bar_edge: edge,
        reserved_regions: vec![HostReservedRegion {
            id: "camera".into(),
            kind: HostReservedRegionKind::Occlusion,
            x: 280.0,
            y: 0.0,
            width: 40.0,
            height: 40.0,
        }],
    });
    value
}

fn resize(session: &mut Session) {
    let batch = session.notify_host_layout(metrics(533), menu(533)).unwrap();
    assert!(
        batch.messages.iter().all(|message| message.op != op::ERROR),
        "{batch:?}"
    );
    assert_eq!(session.config().host.window_width, 533);
}

fn selector(session: &mut Session) -> BridgeBatch {
    dispatch(
        session,
        op::API_CALL,
        json!({"name":"wx.createSelectorQuery","selector":"#root"}),
    )
}

fn input(session: &mut Session) -> BridgeBatch {
    dispatch(
        session,
        op::EVENT_BATCH,
        json!({"events":[{"type":"tap","x":10,"y":10,"detail":{"x":10,"y":10}}]}),
    )
}

fn recovery_expected(session: &Session) -> ExternalFrameRecoveryExpected {
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
        renderer_profile: container_ir::RendererProfile::Skia,
        template_revision: session.view().template_revision.to_string(),
        render_revision: session.render_revision().to_string(),
        input_lifetime_revision: session.input_lifetime_revision().unwrap().to_string(),
    }
}

macro_rules! engine_contracts {
    ($name:ident, $feature:literal, $engine:expr) => {
        #[cfg(feature = $feature)]
        mod $name {
            use super::*;

            #[test]
            fn same_size_layout_retires_old_authority_and_notifies_committed_snapshot_only() {
                let (mut session, revision) = fixture($engine);
                let before_lifetime = session.input_lifetime_revision();
                let expected = layout_metrics(HostVerticalBarEdge::Right);
                let batch = session.notify_window_metrics(expected.clone()).unwrap();
                assert!(batch.messages.iter().any(|message| message.payload["type"] == "host.layoutChanged"));
                assert!(!batch.messages.iter().any(|message| message.payload["type"] == "host.resize"));
                assert_ne!(session.input_lifetime_revision(), before_lifetime);
                assert!(!session.is_current_frame_presented());
                assert_eq!(session.acknowledge_presentation(revision).unwrap_err().code, BridgeErrorCode::Cancelled);
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                assert_eq!(input(&mut session).messages[0].payload["error"]["code"], "ERR_CANCELLED");
                let trace = call(&mut session, "inspect")["trace"].clone();
                assert_eq!(trace.as_array().unwrap().len(), 1);
                assert_eq!(trace[0]["phase"], "layout");
                assert_eq!(serde_json::from_value::<HostLayout>(trace[0]["event"]["hostLayout"].clone()).unwrap(), expected.display.host_layout.unwrap());
                assert_eq!(trace[0]["observed"]["hostLayout"], trace[0]["event"]["hostLayout"]);
                assert_eq!(trace[0]["observed"]["windowWidth"], 320);
                let fresh = render(&mut session, 320);
                session.acknowledge_presentation(fresh).unwrap();
                assert_eq!(input(&mut session).messages[0].payload["ok"], true);
                assert_eq!(call(&mut session, "inspect")["taps"], 1);
            }

            #[test]
            fn same_size_layout_a_b_a_and_omission_cannot_revive_retired_receipt() {
                let (mut session, revision) = fixture($engine);
                for edge in [HostVerticalBarEdge::Right, HostVerticalBarEdge::Left, HostVerticalBarEdge::Right] {
                    session.notify_window_metrics(layout_metrics(edge)).unwrap();
                    assert!(session.acknowledge_presentation(revision).is_err());
                }
                session.notify_window_metrics(metrics(320)).unwrap();
                assert!(session.acknowledge_presentation(revision).is_err());
                let trace = call(&mut session, "inspect")["trace"].clone();
                assert_eq!(trace.as_array().unwrap().len(), 4);
                assert_eq!(trace[3]["event"]["hostLayout"], Value::Null);
                assert!(trace[3]["observed"].get("hostLayout").is_none());
                let batch = session.notify_window_metrics(metrics(320)).unwrap();
                assert!(batch.messages.is_empty(), "identical snapshot replayed layout");
            }

            #[test]
            fn resize_retires_acknowledged_frame_before_new_render() {
                let (mut session, revision) = fixture($engine);
                resize(&mut session);
                assert_eq!(session.render_revision(), revision);
                assert!(!session.is_current_frame_presented(), "old-size native ACK remains authoritative");
            }

            #[test]
            fn old_ack_cannot_restore_resized_layout_authority() {
                let (mut session, revision) = fixture($engine);
                resize(&mut session);
                let ack = session.acknowledge_presentation(revision);
                assert!(ack.is_err(), "old-size ACK was accepted: {ack:?}");
                assert_eq!(ack.unwrap_err().code, BridgeErrorCode::Cancelled);
                assert!(!session.is_current_frame_presented());
            }

            #[test]
            fn selector_refuses_old_size_until_new_frame_is_acknowledged() {
                let (mut session, _) = fixture($engine);
                resize(&mut session);
                let batch = selector(&mut session);
                assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_RENDER", "{batch:?}");
                let revision = render(&mut session, 533);
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                session.acknowledge_presentation(revision).unwrap();
                assert!(session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["result"]["width"], 533.0);
            }

            #[test]
            fn input_refuses_old_size_until_new_frame_is_acknowledged() {
                let (mut session, _) = fixture($engine);
                resize(&mut session);
                let batch = input(&mut session);
                assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_CANCELLED", "{batch:?}");
                assert_eq!(call(&mut session, "inspect")["taps"], 0);
                let revision = render(&mut session, 533);
                session.acknowledge_presentation(revision).unwrap();
                assert_eq!(input(&mut session).messages[0].payload["ok"], true);
                assert_eq!(call(&mut session, "inspect")["taps"], 1);
            }

            #[test]
            fn resize_then_timer_then_query_cannot_revive_old_layout() {
                let (mut session, revision) = fixture($engine);
                call(&mut session, "arm");
                resize(&mut session);
                let batch = session.poll_timers(u64::MAX);
                assert!(batch.messages.iter().all(|message| message.op != op::ERROR), "{batch:?}");
                let trace = call(&mut session, "inspect")["trace"].clone();
                assert_eq!(trace, json!([{"phase":"resize","width":533},{"phase":"timer","width":533}]));
                assert_eq!(session.render_revision(), revision);
                let batch = selector(&mut session);
                assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_RENDER", "{batch:?}");
                assert!(!session.is_current_frame_presented());
            }

            #[test]
            fn returning_to_original_size_without_render_does_not_revive_old_ack() {
                let (mut session, revision) = fixture($engine);
                resize(&mut session);
                session.notify_host_layout(metrics(320), menu(320)).unwrap();
                assert_eq!(session.config().host.window_width, 320);
                assert_eq!(session.render_revision(), revision);
                let ack = session.acknowledge_presentation(revision);
                assert!(ack.is_err(), "A→B→A accepted retired A receipt: {ack:?}");
                assert_eq!(ack.unwrap_err().code, BridgeErrorCode::Cancelled);
                assert!(!session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                assert_eq!(input(&mut session).messages[0].payload["error"]["code"], "ERR_CANCELLED");
            }

            #[test]
            fn density_change_cannot_authorize_retained_old_size_layout() {
                let (mut session, revision) = fixture($engine);
                resize(&mut session);
                session.set_render_scale(2.0).unwrap();
                let repainted = session.render_revision();
                assert!(repainted > revision);
                assert_eq!(session.renderer().last_frame().unwrap().viewport.width, 320.0);
                let ack = session.acknowledge_presentation(repainted);
                assert!(ack.is_err(), "density-only old-size frame was authorized: {ack:?}");
                assert_eq!(ack.unwrap_err().code, BridgeErrorCode::Cancelled);
                assert!(!session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
            }

            #[test]
            fn retained_repaint_cannot_authorize_old_size_layout() {
                let (mut session, _) = fixture($engine);
                resize(&mut session);
                if let Some(revision) = session.repaint_current_skia_page(2.0).unwrap() {
                    assert_eq!(session.renderer().last_frame().unwrap().viewport.width, 320.0);
                    let ack = session.acknowledge_presentation(revision);
                    assert!(ack.is_err(), "retained old-size repaint was authorized: {ack:?}");
                    assert_eq!(ack.unwrap_err().code, BridgeErrorCode::Cancelled);
                }
                assert!(!session.is_current_frame_presented());
                assert_eq!(input(&mut session).messages[0].payload["error"]["code"], "ERR_CANCELLED");
            }

            #[test]
            fn surface_recovery_during_resize_requires_fresh_layout() {
                let (mut session, revision) = fixture($engine);
                resize(&mut session);
                let expected = recovery_expected(&session);
                let result = serde_json::to_value(session.recover_external_frame(&expected).unwrap()).unwrap();
                assert_eq!(result["kind"], "render-required");
                assert!(!session.is_current_frame_presented());
                assert_eq!(session.acknowledge_presentation(revision).unwrap_err().code, BridgeErrorCode::Cancelled);
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                let fresh = render(&mut session, 533);
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["result"]["width"], 533.0);
            }

            #[test]
            fn fresh_generated_layout_waits_for_new_ack_then_restores_interaction() {
                let (mut session, old) = fixture($engine);
                resize(&mut session);
                let fresh = render(&mut session, 533);
                assert!(fresh > old);
                assert!(!session.is_current_frame_presented());
                assert_eq!(session.acknowledge_presentation(old).unwrap_err().code, BridgeErrorCode::Cancelled);
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                assert_eq!(input(&mut session).messages[0].payload["error"]["code"], "ERR_CANCELLED");
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["result"]["width"], 533.0);
                assert_eq!(input(&mut session).messages[0].payload["ok"], true);
                assert_eq!(call(&mut session, "inspect")["taps"], 1);
            }

            #[test]
            fn fresh_revision_with_old_viewport_cannot_claim_new_host_layout() {
                let (mut session, _) = fixture($engine);
                resize(&mut session);
                let old_size_revision = render(&mut session, 320);
                assert_eq!(session.acknowledge_presentation(old_size_revision).unwrap_err().code, BridgeErrorCode::Cancelled);
                assert!(!session.is_current_frame_presented());
                let fresh = render(&mut session, 533);
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
            }

            #[test]
            fn scrolling_retains_valid_layout_but_waits_for_its_new_ack() {
                let (mut session, old) = fixture($engine);
                success(&mut session, op::API_CALL, json!({"name":"wx.pageScrollTo", "scrollTop":80,"duration":0}));
                let fresh = session.render_revision();
                assert!(fresh > old);
                assert!(!session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["result"]["width"], 320.0);
                assert_eq!(input(&mut session).messages[0].payload["ok"], true);
            }

            #[test]
            fn page_round_trip_cannot_reauthorize_the_old_frame() {
                let (mut session, old) = fixture($engine);
                success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
                assert_eq!(session.acknowledge_presentation(old).unwrap_err().code, BridgeErrorCode::Cancelled);
                success(&mut session, op::PAGE_POP, json!({}));
                assert_eq!(session.acknowledge_presentation(old).unwrap_err().code, BridgeErrorCode::Cancelled);
                assert_eq!(selector(&mut session).messages[0].payload["error"]["code"], "ERR_RENDER");
                let fresh = render(&mut session, 320);
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
            }

            #[test]
            fn fresh_explicit_frame_owns_ack_without_consumed_template_input() {
                let (mut session, old) = fixture($engine);
                let mut frame = session.renderer().last_frame().unwrap().clone();
                resize(&mut session);
                frame.viewport.width = 533.0;
                frame.root.bounds.width = 533.0;
                assert_eq!(frame.root.children.len(), 1);
                assert_eq!(frame.root.children[0].id, "root");
                frame.root.children[0].bounds.width = 533.0;
                success(&mut session, op::RENDER_COMMIT, json!({"frame":frame}));
                let fresh = session.render_revision();
                assert!(fresh > old);
                assert!(session.last_frame_input(fresh).is_none(), "manual frame must not forge template provenance");
                assert!(!session.is_current_frame_presented());
                assert_eq!(session.acknowledge_presentation(old).unwrap_err().code, BridgeErrorCode::Cancelled);
                session.acknowledge_presentation(fresh).unwrap();
                assert!(session.is_current_frame_presented());
                assert_eq!(selector(&mut session).messages[0].payload["result"]["width"], 533.0);
                assert_eq!(input(&mut session).messages[0].payload["ok"], true);
                assert_eq!(call(&mut session, "inspect")["taps"], 1);
            }
        }
    };
}

engine_contracts!(quickjs, "quickjs-native", EngineKind::Quickjs);
engine_contracts!(v8, "v8-native", EngineKind::V8);
