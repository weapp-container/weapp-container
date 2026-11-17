//! End-to-end Session contracts with real AppService engines and deterministic
//! private animation time. Browser peers here are protocol fixtures, not a DOM.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use super::*;
use container_ir::{
    parse_wxml, AppInfo, BrowserGeometryBatch, BrowserNodeGeometry, CompilerInfo, Module,
    ModuleScope, Route, RouteKind, Template, ViewPoint, ViewRect, ViewSize,
};
use std::time::Duration;

const TEMPLATE: &str = r#"<view wx:if="{{visible}}" id="panel" animation="{{animation}}" bindtap="onTap" style="width:20px;height:20px;background:red;opacity:1;transform:translateX(0px)"/>"#;
const MIXED_TEMPLATE: &str = r#"<view id="panel" animation="{{animation}}" style="width:20px;height:20px;background:red;opacity:1;transform:translateX(0px)"/><view id="second" animation="{{second}}" style="width:20px;height:20px;background:blue"/>"#;
const PAGE: &str = r#"
function build(){return wx.createAnimation({duration:100,timingFunction:'linear',transformOrigin:'0px 0px'}).opacity(0.2).translateX(40).step().export()}
Page({data:{animation:{actions:[]},second:{actions:[]},visible:true,other:0,taps:0},
 onLoad(){this.setData({animation:build(),second:build()})},
 onReady(){getApp().readies++;READY_WRITE},
 onTap(){this.setData({taps:this.data.taps+1})}
});
exports.inspect=()=>({readies:getApp().readies,data:getCurrentPages()[0].data});
exports.unrelated=()=>{const p=getCurrentPages()[0];p.setData({other:p.data.other+1})};
exports.replay=()=>{const p=getCurrentPages()[0];p.setData({animation:JSON.parse(JSON.stringify(p.data.animation))})};
exports.remove=()=>getCurrentPages()[0].setData({visible:false});
exports.malformed=()=>getCurrentPages()[0].setData({animation:build(),second:wx.createAnimation({duration:100}).width(90).step().export()});
"#;

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

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let response = session.dispatch(request(operation, payload));
    assert!(
        !response
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false),
        "{response:?}"
    );
    response.messages[0].payload.clone()
}

fn call(session: &mut Session, export: &str) -> Value {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({
            "moduleId":"module:pages/index/index.js", "export":export
        }),
    )["result"][0]
        .clone()
}

fn fixture(engine: EngineKind, browser: bool, mixed: bool, ready_write: bool) -> (Session, Value) {
    fixture_with_mode(engine, browser, mixed, ready_write, PageRenderMode::Raster)
}

fn fixture_with_mode(
    engine: EngineKind,
    browser: bool,
    mixed: bool,
    ready_write: bool,
    mode: PageRenderMode,
) -> (Session, Value) {
    let app = "App({readies:0});";
    let page = PAGE.replace(
        "READY_WRITE",
        if ready_write {
            "this.setData({other:this.data.other+1})"
        } else {
            ""
        },
    );
    let wxml = parse_wxml(if mixed { MIXED_TEMPLATE } else { TEMPLATE })
        .unwrap()
        .canonical_json()
        .unwrap();
    let pointer = format!("sha256:{}", container_ir::hex_digest(&wxml));
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "animation-session-fixture".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "module:app.js".into(),
        },
        routes: vec![Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "module:pages/index/index.js".into(),
        }],
        ..Default::default()
    };
    for (id, source, scope) in [
        ("module:app.js", app, ModuleScope::App),
        (
            "module:pages/index/index.js",
            page.as_str(),
            ModuleScope::Page,
        ),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: container_ir::hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    for capability in ["wx.createAnimation", "getCurrentPages"] {
        manifest
            .capabilities
            .insert(capability.into(), CapabilitySupport::Partial);
    }
    manifest.templates.push(Template {
        id: "template:pages/index/index.wxml".into(),
        wxml_ast: pointer.clone(),
        bindings: vec![],
        wxs_modules: Default::default(),
    });
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            page_render_mode: mode,
            renderer_override: browser.then_some(container_ir::RendererProfile::WebView),
            browser_view_enabled: browser,
            ..Default::default()
        },
    )
    .unwrap();
    session.animation_clock.advance_to(Duration::ZERO).unwrap();
    dispatch(
        &mut session,
        op::APP_INIT,
        json!({"modules":[
        {"id":"module:app.js","source":app},
        {"id":"module:pages/index/index.js","source":page}
    ],"blobs":{pointer:wxml}}),
    );
    dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    dispatch(
        &mut session,
        op::PAGE_PUSH,
        json!({"path":"pages/index/index"}),
    );
    (
        session,
        json!({"templateId":"template:pages/index/index.wxml","frameId":1,"useSessionResources":true,"viewport":{"width":100,"height":50}}),
    )
}

fn advance(session: &mut Session, millis: u64) {
    session
        .animation_clock
        .advance_to(Duration::from_millis(millis))
        .unwrap();
    // Timer input intentionally stays zero: only the private clock can advance
    // animation progress, and its captured instant is shared by this host turn.
    let result = session.poll_timers(0);
    assert!(
        !result
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false),
        "{result:?}"
    );
}

fn assert_panel_geometry(session: &Session, translation: f32, opacity: f32) {
    let frame = session.renderer().last_frame().unwrap();
    let panel = frame.query("#panel", false).unwrap()[0];
    assert!((panel.opacity - opacity).abs() < 0.0001, "{panel:?}");
    let transform = panel
        .style
        .unwrap_or_default()
        .transform
        .unwrap_or_default();
    assert!((transform.e - translation).abs() < 0.0001, "{transform:?}");
    let point = translation + 5.0;
    assert!(frame
        .root
        .hit_test(point, 10.0)
        .is_some_and(|node| node.id == "panel"));
    if translation >= 20.0 {
        assert!(!frame
            .root
            .hit_test(5.0, 10.0)
            .is_some_and(|node| node.id == "panel"));
    }
}

fn assert_panel(session: &Session, translation: f32, opacity: f32) {
    assert_panel_geometry(session, translation, opacity);
    let point = translation + 5.0;
    let image = session.renderer().snapshot().unwrap();
    let index = (10 * 100 + point as usize) * 4;
    let alpha = (opacity * 255.0).round() as u8;
    assert_eq!(&image.pixels[index..index + 4], &[alpha, 0, 0, alpha]);
}

#[test]
fn real_producer_retained_pixels_hit_testing_cached_rerender_and_equal_write_replay() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, false, false, false);
        assert_eq!(session.animation_sample_demand_revision(), None);
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        assert_panel(&session, 0.0, 1.0);
        assert_eq!(call(&mut session, "inspect")["readies"], 1);
        assert_eq!(session.animation_sample_demand_revision(), Some(0));
        let original_input = session
            .last_frame_input(session.renderer().snapshot_revision())
            .unwrap()
            .clone();
        let view_revision = session.view.template_revision;
        advance(&mut session, 25);
        assert_panel(&session, 10.0, 0.8);
        assert_eq!(
            session.view.template_revision, view_revision,
            "retained samples never run View or setData"
        );
        assert_eq!(
            session.last_frame_input(session.renderer().snapshot_revision()),
            Some(&original_input)
        );
        call(&mut session, "unrelated");
        let dirty_revision = session.renderer().snapshot_revision();
        advance(&mut session, 40);
        assert_eq!(
            session.renderer().snapshot_revision(),
            dirty_revision,
            "dirty template takes precedence over retained sampling"
        );
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        assert_panel(&session, 16.0, 0.68);
        advance(&mut session, 60);
        assert_panel(&session, 24.0, 0.52);
        call(&mut session, "replay");
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        assert_panel(&session, 24.0, 0.52);
        advance(&mut session, 110);
        assert_panel(&session, 32.0, 0.36);
        advance(&mut session, 160);
        assert_panel(&session, 40.0, 0.2);
        let completed = session.renderer().snapshot_revision();
        advance(&mut session, 1000);
        assert_eq!(
            session.renderer().snapshot_revision(),
            completed,
            "final endpoint is sampled once"
        );
        dispatch(
            &mut session,
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":45.0,"y":10.0}]}),
        );
        assert_eq!(call(&mut session, "inspect")["data"]["taps"], 1);
        assert_eq!(call(&mut session, "inspect")["readies"], 1);
    }
}

#[test]
fn native_visibility_pauses_elapsed_time_and_removal_and_unload_retire_the_run() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, false, false, false);
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        advance(&mut session, 25);
        assert_panel(&session, 10.0, 0.8);
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        let hidden_revision = session.renderer().snapshot_revision();
        advance(&mut session, 500);
        assert_eq!(session.renderer().snapshot_revision(), hidden_revision);
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        assert_panel(&session, 10.0, 0.8);
        advance(&mut session, 525);
        assert_panel(&session, 20.0, 0.6);
        call(&mut session, "remove");
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        assert!(session
            .renderer()
            .last_frame()
            .unwrap()
            .query("#panel", false)
            .unwrap()
            .is_empty());
        let removed_revision = session.renderer().snapshot_revision();
        advance(&mut session, 700);
        assert_eq!(session.renderer().snapshot_revision(), removed_revision);
        dispatch(&mut session, op::PAGE_POP, json!({}));
        advance(&mut session, 800);
        dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        );
        dispatch(&mut session, op::RENDER_COMMIT, payload);
        assert_panel(&session, 0.0, 1.0);
    }
}

#[test]
fn malformed_mixed_animation_render_preserves_all_accepted_native_owners_and_pixels() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, false, true, false);
        dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
        advance(&mut session, 25);
        let revision = session.renderer().snapshot_revision();
        let pixels = session.renderer().snapshot().unwrap().pixels.clone();
        let document = session.accepted_view_document.clone();
        let authority = session.current_skia_frame_authority().map(|owner| {
            (
                owner.revision,
                owner.page,
                owner.input_lifetime,
                owner.host_width,
                owner.host_height,
                owner.viewport,
            )
        });
        let bindings = format!("{:?}", session.animation_bindings);
        let playback = format!("{:?}", session.animation_playback);
        call(&mut session, "malformed");
        let rejected = session.dispatch(request(op::RENDER_COMMIT, payload));
        assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
        assert_eq!(session.renderer().snapshot_revision(), revision);
        assert_eq!(session.renderer().snapshot().unwrap().pixels, pixels);
        assert_eq!(session.accepted_view_document, document);
        assert_eq!(
            session.current_skia_frame_authority().map(|owner| (
                owner.revision,
                owner.page,
                owner.input_lifetime,
                owner.host_width,
                owner.host_height,
                owner.viewport
            )),
            authority
        );
        assert_eq!(format!("{:?}", session.animation_bindings), bindings);
        assert_eq!(format!("{:?}", session.animation_playback), playback);
    }
}

fn geometry(submission: &BrowserViewSubmission, epoch: u64) -> BrowserGeometryBatch {
    let mut nodes = Vec::new();
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 20.0,
                height: 20.0,
            },
            client_size: ViewSize {
                width: 20.0,
                height: 20.0,
            },
        });
        if let container_ir::ViewNode::Element { children, .. } = node {
            pending.extend(children);
        }
    }
    BrowserGeometryBatch {
        version: container_ir::VIEW_PRESENTATION_VERSION.into(),
        key: submission.key.clone(),
        epoch,
        viewport: submission.viewport,
        nodes,
    }
}

fn baseline(session: &mut Session, submission: &BrowserViewSubmission) -> Value {
    let animation = submission
        .animation
        .as_ref()
        .expect("animation baseline metadata");
    let values = animation["baselines"].as_array().unwrap().iter().map(|request| json!({
        "occurrenceId":request["occurrenceId"],
        "opacity":if request["opacity"] == true {json!(1.0)} else {Value::Null},
        "transform":if request["transform"] == true {json!({"a":1.0,"b":0.0,"c":0.0,"d":1.0,"tx":0.0,"ty":0.0})} else {Value::Null},
        "fontSize":16.0,
        "origin":if request["transform"] == true {json!({"x":0.0,"y":0.0})} else {Value::Null}
    })).collect::<Vec<_>>();
    dispatch(
        session,
        op::VIEW_ANIMATION_BASELINE,
        json!({
            "version":"1.0","requestId":animation["requestId"],"key":submission.key,"epoch":"1","values":values
        }),
    )
}

fn sample(session: &mut Session, base: &BrowserViewSubmission, epoch: u64) -> Value {
    dispatch(
        session,
        op::VIEW_SAMPLE_PREPARE,
        json!({
            "version":"1.0","baseKey":base.key,"baseGeometryEpoch":epoch.to_string(),
            "sampleDemandRevision":session.animation_sample_demand_revision().unwrap().to_string()
        }),
    )
}

#[test]
fn browser_baseline_and_sample_ack_delays_freeze_styles_and_rejected_geometry_is_atomic() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, true, false, false);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let cloned_input = session.browser_page_input(&submission.key).unwrap().clone();
        advance(&mut session, 100);
        let bound = baseline(&mut session, &submission);
        assert_eq!(bound["styles"][0]["opacity"], 1.0);
        assert_eq!(bound["styles"][0]["transform"]["tx"], 0.0);
        assert_eq!(session.animation_sample_demand_revision(), None);
        advance(&mut session, 200);
        let permit = session
            .prepare_browser_commit(geometry(&submission, 2))
            .unwrap();
        advance(&mut session, 300);
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(
            session.browser_page_input(&submission.key),
            Some(&cloned_input)
        );
        assert_eq!(call(&mut session, "inspect")["readies"], 1);
        advance(&mut session, 350);
        let prepared = sample(&mut session, &submission, 2);
        assert!(
            (prepared["submission"]["styles"][0]["opacity"]
                .as_f64()
                .unwrap()
                - 0.6)
                .abs()
                < 0.0001
        );
        assert_eq!(prepared["submission"]["styles"][0]["transform"]["tx"], 20.0);
        assert_eq!(sample(&mut session, &submission, 2), prepared);
        let immutable = prepared["submission"].clone();
        advance(&mut session, 425);
        let exact_replay = dispatch(
            &mut session,
            op::VIEW_SAMPLE_PREPARE,
            json!({
                "version":"1.0", "baseKey":submission.key, "baseGeometryEpoch":"2",
                "sampleDemandRevision":prepared["submission"]["consumedSample"]["demandRevision"]
            }),
        );
        assert_eq!(
            exact_replay, prepared,
            "coalesced newer demand must not change an already prepared exact retry"
        );
        let mut sample_geometry = geometry(&submission, 3);
        sample_geometry.key =
            serde_json::from_value(prepared["submission"]["key"].clone()).unwrap();
        let mut partial = sample_geometry.clone();
        partial.nodes.clear();
        let rejected = session.dispatch(request(
            op::VIEW_SAMPLE_PRESENTED,
            json!({
                "version":"1.0","permit":prepared["permit"],"geometry":partial
            }),
        ));
        assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
        assert!(session.browser_page_input(&submission.key).is_some());
        assert!(!session.is_browser_view_presented());
        advance(&mut session, 450);
        let accepted = dispatch(
            &mut session,
            op::VIEW_SAMPLE_PRESENTED,
            json!({
                "version":"1.0","permit":prepared["permit"],"geometry":sample_geometry
            }),
        );
        assert_eq!(accepted["consumedSample"], immutable["consumedSample"]);
        let settled = dispatch(
            &mut session,
            op::VIEW_SAMPLE_ABORT,
            json!({"version":"1.0","key":accepted["key"]}),
        );
        assert_eq!(settled["presented"], true);
        assert_eq!(settled["aborted"], false);
        assert_eq!(settled["inputEnabled"], false);
        assert_eq!(settled["consumedSample"], accepted["consumedSample"]);
        assert_eq!(
            prepared["submission"], immutable,
            "ACK must not resample an older capture"
        );
        assert_eq!(call(&mut session, "inspect")["readies"], 1);
        let mut next_base = submission.clone();
        next_base.key = serde_json::from_value(accepted["key"].clone()).unwrap();
        let next = sample(&mut session, &next_base, 3);
        assert!(
            (next["submission"]["styles"][0]["opacity"].as_f64().unwrap() - 0.2).abs() < 0.0001
        );
        assert_eq!(next["submission"]["styles"][0]["transform"]["tx"], 40.0);
        let aborted = dispatch(
            &mut session,
            op::VIEW_SAMPLE_ABORT,
            json!({"version":"1.0","key":next["submission"]["key"]}),
        );
        assert_eq!(aborted["aborted"], true);
        let mut late_geometry = geometry(&next_base, 4);
        late_geometry.key = serde_json::from_value(next["submission"]["key"].clone()).unwrap();
        let rejected = session.dispatch(request(
            op::VIEW_SAMPLE_PRESENTED,
            json!({"version":"1.0","permit":next["permit"],"geometry":late_geometry}),
        ));
        assert_eq!(rejected.messages[0].payload["ok"], false);
        assert_eq!(
            dispatch(
                &mut session,
                op::VIEW_SAMPLE_ABORT,
                json!({"version":"1.0","key":next["submission"]["key"]}),
            ),
            aborted
        );
        assert!(session.is_browser_view_presented());
        assert_eq!(
            session.browser_page_input(&next_base.key),
            Some(&cloned_input)
        );
    }
}

#[test]
fn browser_exact_template_and_sample_settlements_survive_replacement_and_retirement() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, true, false, false);
        let initial = session.prepare_browser_view(&payload, 1).unwrap();
        baseline(&mut session, &initial);
        let initial_permit = session
            .prepare_browser_commit(geometry(&initial, 2))
            .unwrap();
        session
            .acknowledge_browser_presentation(&initial_permit)
            .unwrap();
        advance(&mut session, 50);
        let sampled = sample(&mut session, &initial, 2);
        let mut sampled_geometry = geometry(&initial, 3);
        sampled_geometry.key =
            serde_json::from_value(sampled["submission"]["key"].clone()).unwrap();

        // A new template retires the pending sample before accepting anything.
        // Its exact tombstone settles the old client without touching the new
        // candidate or permitting a delayed presented request to resurrect it.
        let replacement = session.prepare_browser_view(&payload, 1).unwrap();
        let aborted_sample = dispatch(
            &mut session,
            op::VIEW_SAMPLE_ABORT,
            json!({"version":"1.0","key":sampled["submission"]["key"]}),
        );
        assert_eq!(aborted_sample["aborted"], true);
        let rejected = session.dispatch(request(
            op::VIEW_SAMPLE_PRESENTED,
            json!({"version":"1.0","permit":sampled["permit"],"geometry":sampled_geometry}),
        ));
        assert_eq!(rejected.messages[0].payload["ok"], false);
        assert!(session.is_browser_view_pending(&replacement.key));

        let old_final = dispatch(&mut session, op::VIEW_ABORT, json!(initial.key));
        assert_eq!(old_final["presented"], true);
        assert_eq!(old_final["aborted"], false);
        assert_eq!(old_final["inputEnabled"], false);
        assert_eq!(old_final["permit"], json!(initial_permit));
        assert!(session.is_browser_view_pending(&replacement.key));

        baseline(&mut session, &replacement);
        let replacement_permit = session
            .prepare_browser_commit(geometry(&replacement, 4))
            .unwrap();
        session.invalidate_browser_candidate();
        let aborted_template = dispatch(&mut session, op::VIEW_ABORT, json!(replacement.key));
        assert_eq!(aborted_template["aborted"], true);
        assert!(session
            .acknowledge_browser_presentation(&replacement_permit)
            .is_err());
        assert_eq!(
            dispatch(&mut session, op::VIEW_ABORT, json!(replacement.key)),
            aborted_template
        );
        assert_eq!(
            dispatch(&mut session, op::VIEW_ABORT, json!(initial.key)),
            old_final,
            "a retired historical final proves acceptance without reviving input"
        );
    }
}

#[test]
fn browser_explicit_data_replacement_retires_the_prior_topology_on_exact_ack() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, true, false, false);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        baseline(&mut session, &submission);
        let initial_permit = session
            .prepare_browser_commit(geometry(&submission, 2))
            .unwrap();
        session
            .acknowledge_browser_presentation(&initial_permit)
            .unwrap();
        advance(&mut session, 25);
        let sampled = sample(&mut session, &submission, 2);
        let mut sample_geometry = geometry(&submission, 3);
        sample_geometry.key = serde_json::from_value(sampled["submission"]["key"].clone()).unwrap();
        dispatch(
            &mut session,
            op::VIEW_SAMPLE_PRESENTED,
            json!({"version":"1.0","permit":sampled["permit"],"geometry":sample_geometry}),
        );
        let bindings = format!("{:?}", session.animation_bindings);
        let playback = format!("{:?}", session.animation_playback);
        let writes = format!("{:?}", session.animation_writes);

        let mut explicit = payload.clone();
        explicit["data"] = json!({"visible": false});
        let replacement = session.prepare_browser_view(&explicit, 1).unwrap();
        assert!(replacement.animation.is_none());
        assert!(session.browser_page_input(&replacement.key).is_none());
        let mut invalid = geometry(&replacement, 2);
        invalid.nodes = geometry(&submission, 2).nodes;
        assert!(session.prepare_browser_commit(invalid).is_err());
        assert_eq!(format!("{:?}", session.animation_bindings), bindings);
        assert_eq!(format!("{:?}", session.animation_playback), playback);
        let permit = session
            .prepare_browser_commit(geometry(&replacement, 2))
            .unwrap();
        assert!(session
            .acknowledge_browser_presentation(&initial_permit)
            .is_err());
        assert_eq!(format!("{:?}", session.animation_bindings), bindings);
        assert_eq!(format!("{:?}", session.animation_playback), playback);
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(format!("{:?}", session.animation_writes), writes);

        let recreated = session.prepare_browser_view(&payload, 1).unwrap();
        let bound = baseline(&mut session, &recreated);
        assert_eq!(bound["styles"][0]["opacity"], 1.0);
        assert_eq!(bound["styles"][0]["transform"]["tx"], 0.0);
        let permit = session
            .prepare_browser_commit(geometry(&recreated, 2))
            .unwrap();
        advance(&mut session, 100);
        session.acknowledge_browser_presentation(&permit).unwrap();
        advance(&mut session, 125);
        let sampled = sample(&mut session, &recreated, 2);
        assert!(
            (sampled["submission"]["styles"][0]["opacity"]
                .as_f64()
                .unwrap()
                - 0.8)
                .abs()
                < 0.0001
        );
        assert_eq!(sampled["submission"]["styles"][0]["transform"]["tx"], 10.0);
    }
}

#[test]
fn ready_writes_do_not_refresh_the_animation_documents_cloned_input_proof() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine, true, false, true);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let captured = session.browser_page_input(&submission.key).unwrap().clone();
        baseline(&mut session, &submission);
        let permit = session
            .prepare_browser_commit(geometry(&submission, 2))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(call(&mut session, "inspect")["data"]["other"], 1);
        assert!(session.view.template_revision > captured.template_revision);
        assert_eq!(session.browser_page_input(&submission.key), Some(&captured));
        advance(&mut session, 50);
        let rejected = session.dispatch(request(op::VIEW_SAMPLE_PREPARE, json!({
            "version":"1.0","baseKey":submission.key,"baseGeometryEpoch":"2",
            "sampleDemandRevision":session.animation_sample_demand_revision().unwrap().to_string()
        })));
        assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
        assert_eq!(session.browser_page_input(&submission.key), Some(&captured));
        assert_eq!(session.renderer().snapshot_revision(), 0);
    }
}

#[test]
fn native_external_samples_wait_for_exact_ack_and_keep_the_prepared_capture() {
    for engine in engines() {
        let (mut session, payload) =
            fixture_with_mode(engine, false, false, false, PageRenderMode::ExternalFrame);
        dispatch(&mut session, op::RENDER_COMMIT, payload);
        let initial = session.renderer().snapshot_revision();
        assert_panel_geometry(&session, 0.0, 1.0);
        assert_eq!(session.animation_sample_demand_revision(), None);
        advance(&mut session, 100);
        assert_eq!(session.renderer().snapshot_revision(), initial);
        session.acknowledge_presentation(initial).unwrap();
        assert_eq!(session.animation_sample_demand_revision(), Some(0));
        let cloned_input = session.last_frame_input(initial).unwrap().clone();
        advance(&mut session, 150);
        let sampled = session.renderer().snapshot_revision();
        assert_eq!(sampled, initial + 1);
        assert_panel_geometry(&session, 20.0, 0.6);
        assert!(!session.is_current_frame_presented());
        let proof = session.committed_animation_sample(sampled).unwrap();
        let view_revision = session.view.template_revision;
        advance(&mut session, 225);
        assert_eq!(session.renderer().snapshot_revision(), sampled);
        assert_panel_geometry(&session, 20.0, 0.6);
        assert_eq!(session.committed_animation_sample(sampled), Some(proof));
        assert_eq!(session.last_frame_input(sampled), Some(&cloned_input));
        assert!(session.acknowledge_presentation(initial).is_err());
        session.acknowledge_presentation(sampled).unwrap();
        assert_eq!(session.committed_animation_sample(sampled), Some(proof));
        assert_panel_geometry(&session, 20.0, 0.6);
        advance(&mut session, 250);
        let terminal = session.renderer().snapshot_revision();
        assert_eq!(terminal, sampled + 1);
        assert_panel_geometry(&session, 40.0, 0.2);
        assert_eq!(session.view.template_revision, view_revision);
        session.acknowledge_presentation(terminal).unwrap();
        advance(&mut session, 500);
        assert_eq!(session.renderer().snapshot_revision(), terminal);
        assert_eq!(call(&mut session, "inspect")["readies"], 1);
    }
}

fn unproven_native_replacement(session: &Session, payload: &Value, explicit_data: bool) -> Value {
    if explicit_data {
        let mut replacement = payload.clone();
        replacement["data"] = json!({"visible": false});
        replacement
    } else {
        let mut frame = session.renderer().last_frame().unwrap().clone();
        frame.frame_id += 1;
        frame.root.id = "manual".into();
        frame.root.children.clear();
        json!({"frame": frame})
    }
}

#[test]
fn native_unproven_replacement_retires_node_identity_only_after_its_exact_ack() {
    for engine in engines() {
        for explicit_data in [false, true] {
            let (mut session, payload) =
                fixture_with_mode(engine, false, false, false, PageRenderMode::ExternalFrame);
            dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
            let first = session
                .pending_native_animations
                .as_ref()
                .unwrap()
                .1
                .bindings
                .as_ref()
                .unwrap()
                .descriptors[0]
                .clone();
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            advance(&mut session, 25);
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            assert_panel_geometry(&session, 10.0, 0.8);
            let old_revision = session.render_revision();
            let bindings = format!("{:?}", session.animation_bindings);
            let playback = format!("{:?}", session.animation_playback);
            let writes = format!("{:?}", session.animation_writes);
            let replacement = unproven_native_replacement(&session, &payload, explicit_data);
            let mut invalid = replacement.clone();
            if explicit_data {
                invalid["viewport"]["width"] = json!("invalid");
            } else {
                invalid["frame"]["viewport"]["width"] = json!("invalid");
            }
            let rejected = session.dispatch(request(op::RENDER_COMMIT, invalid));
            assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
            assert_eq!(session.render_revision(), old_revision);
            assert_eq!(format!("{:?}", session.animation_bindings), bindings);
            assert_eq!(format!("{:?}", session.animation_playback), playback);

            dispatch(&mut session, op::RENDER_COMMIT, replacement);
            let replacement_revision = session.render_revision();
            assert!(session.last_frame_input(replacement_revision).is_none());
            assert!(session.pending_native_animations.is_none());
            assert_eq!(format!("{:?}", session.animation_bindings), bindings);
            assert_eq!(format!("{:?}", session.animation_playback), playback);
            assert!(session.acknowledge_presentation(old_revision).is_err());
            assert_eq!(format!("{:?}", session.animation_bindings), bindings);
            advance(&mut session, 50);
            assert_eq!(session.render_revision(), replacement_revision);
            session
                .acknowledge_presentation(replacement_revision)
                .unwrap();
            assert_eq!(format!("{:?}", session.animation_writes), writes);

            dispatch(&mut session, op::RENDER_COMMIT, payload);
            let recreated = &session
                .pending_native_animations
                .as_ref()
                .unwrap()
                .1
                .bindings
                .as_ref()
                .unwrap()
                .descriptors[0];
            assert!(recreated.new_run);
            assert_eq!(recreated.key.owner, first.key.owner);
            assert_eq!(recreated.key.source_site, first.key.source_site);
            assert_ne!(recreated.key.incarnation, first.key.incarnation);
            assert_eq!(recreated.resolved_paths, first.resolved_paths);
            assert_panel_geometry(&session, 0.0, 1.0);
            let recreated_revision = session.render_revision();
            advance(&mut session, 100);
            assert_eq!(session.render_revision(), recreated_revision);
            session
                .acknowledge_presentation(recreated_revision)
                .unwrap();
            advance(&mut session, 125);
            assert_panel_geometry(&session, 10.0, 0.8);
        }
    }
}

#[test]
fn native_raster_unproven_replacements_start_new_runs_from_author_baselines() {
    for engine in engines() {
        for explicit_data in [false, true] {
            let (mut session, payload) = fixture(engine, false, false, false);
            dispatch(&mut session, op::RENDER_COMMIT, payload.clone());
            advance(&mut session, 25);
            assert_panel(&session, 10.0, 0.8);
            let replacement = unproven_native_replacement(&session, &payload, explicit_data);
            dispatch(&mut session, op::RENDER_COMMIT, replacement);
            dispatch(&mut session, op::RENDER_COMMIT, payload);
            assert_panel(&session, 0.0, 1.0);
            advance(&mut session, 50);
            assert_panel(&session, 10.0, 0.8);
        }
    }
}
