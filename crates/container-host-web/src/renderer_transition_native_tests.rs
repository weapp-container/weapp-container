//! Defense-in-depth tests for trusted native public API interleavings.
//! A native embedder attaches the target DOM before requesting its transport
//! binding. The current Worker product prevents that interleaving. Geometry is
//! a finite protocol peer, not a real browser, GPU or official parity oracle.
use super::*;
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_runtime::BrowserViewSubmission;
use std::collections::BTreeMap;

const DOM: &str = "pages/dom/index";
const SKIA: &str = "pages/skia/index";

fn send(host: &mut WebHost, operation: &str, payload: Value) -> BridgeBatch {
    host.dispatch(BridgeEnvelope::request(
        "session-1",
        operation,
        operation,
        payload,
    ))
    .unwrap()
}
fn success(host: &mut WebHost, operation: &str, payload: Value) -> Value {
    let batch = send(host, operation, payload);
    let response = batch
        .messages
        .iter()
        .find(|message| {
            message.op == operation && message.kind == container_bridge::EnvelopeKind::Response
        })
        .unwrap();
    assert_eq!(response.payload["ok"], true, "{batch:?}");
    response.payload.clone()
}
fn inspect(host: &mut WebHost) -> Value {
    success(
        host,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":"inspect","args":[]}),
    )["result"][0]
        .clone()
}
fn state(host: &WebHost) -> Value {
    serde_json::from_slice(&host.renderer_transition_state_json().unwrap()).unwrap()
}
fn expected(state: &Value) -> Vec<u8> {
    serde_json::to_vec(&json!({"version":"1.0","expected":{
        "sessionId":state["state"]["sessionId"],
        "pageId":state["state"]["currentPage"]["pageId"],
        "routePath":state["state"]["currentPage"]["path"],
        "rendererProfile":state["state"]["rendererProfile"],
        "inputLifetimeRevision":state["inputLifetimeRevision"],
        "presenterGeneration":state["presenterBinding"]["generation"],
        "transportBackend":state["presenterBinding"]["transportBackend"],
    }}))
    .unwrap()
}
fn fixture(action: &str) -> (WebHost, BrowserViewSubmission, Value) {
    let app = r#"
App({action:__ACTION__,starts:0,cancels:0,ticks:0,launches:0,onLaunch(){this.launches++;}});
exports.inspect=function(){return {starts:getApp().starts,cancels:getApp().cancels,ticks:getApp().ticks,launches:getApp().launches,pages:getCurrentPages().map(p=>({path:p.route,data:p.data}))};};
exports.scheduleTick=function(){setTimeout(function(){getApp().ticks++;wx.setStorageSync('tick-effects',getApp().ticks);},1);return true;};
"#.replace("__ACTION__", &serde_json::to_string(action).unwrap());
    let page = r#"
Page({data:{cancels:0},touch(e){
  const app=getApp();
  if(e.type==='touchstart'){app.starts++;return;}
  if(e.type!=='touchcancel')return;
  app.cancels++;this.setData({cancels:app.cancels});
  wx.setStorageSync('cancel-effects',{count:app.cancels,reason:e.detail.reason});
  if(app.action==='throw')throw new Error('transition-cancel-hook-failed');
  wx.navigateTo({url:'/pages/skia/index'});
  if(app.action==='away-back')wx.navigateBack({delta:1});
}});
"#;
    let mut manifest = ContainerManifestV1 {
        schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
        rendering: Some(RendererProfiles::default()),
        ..Default::default()
    };
    manifest.compiler.name = "weapp-vite".into();
    manifest.compiler.commit = "trusted-native-renderer-transition-interleaving".into();
    manifest.compiler.platform = "weapp".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "module:app.js".into();
    manifest.capabilities = BTreeMap::from([
        ("getCurrentPages".into(), CapabilitySupport::Full),
        ("wx.navigateTo".into(), CapabilitySupport::Full),
        ("wx.navigateBack".into(), CapabilitySupport::Full),
        ("wx.setStorageSync".into(), CapabilitySupport::Full),
    ]);
    for (path, profile) in [
        (DOM, RendererProfile::WebView),
        (SKIA, RendererProfile::Skia),
    ] {
        manifest.routes.push(Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{path}.js"),
        });
        manifest
            .rendering
            .as_mut()
            .unwrap()
            .pages
            .insert(path.into(), profile);
    }
    let mut modules = Vec::new();
    for (id, source, scope) in [
        ("module:app.js", app.as_str(), ModuleScope::App),
        ("module:pages/dom/index.js", page, ModuleScope::Page),
        (
            "module:pages/skia/index.js",
            "Page({data:{other:true}});",
            ModuleScope::Page,
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
    let ast = parse_wxml(
        r#"<view id="touch" bindtouchstart="touch" bindtouchcancel="touch">{{cancels}}</view>"#,
    )
    .unwrap()
    .canonical_json()
    .unwrap();
    let pointer = format!("sha256:{}", hex_digest(&ast));
    manifest.templates.push(Template {
        id: format!("template:{DOM}.wxml"),
        wxml_ast: pointer.clone(),
        bindings: vec![],
        wxs_modules: Default::default(),
    });
    manifest.refresh_integrity().unwrap();
    let mut host = WebHost::new();
    host.load_manifest_json_with_renderer_policy(
        serde_json::to_vec(&manifest).unwrap(),
        container_runtime::SessionConfig {
            engine: EngineKind::Quickjs,
            ..Default::default()
        },
        super::super::WebSessionOptions {
            renderer_mode: WebRendererMode::ExternalFrame,
        },
        WebRendererPolicy::Manifest,
    )
    .unwrap();
    host.enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
        .unwrap();
    let initialized = success(
        &mut host,
        op::APP_INIT,
        json!({"modules":modules,"blobs":{pointer:ast}}),
    );
    assert_eq!(initialized["engineProviderAvailable"], true);
    success(&mut host, op::APP_LIFECYCLE, json!({"event":"launch"}));
    success(&mut host, op::PAGE_PUSH, json!({"path":DOM}));
    success(
        &mut host,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":"scheduleTick","args":[]}),
    );
    // This is a trusted-native interleaving, not a Worker product authority:
    // its public View API attaches the real target-page DOM before rebinding.
    let prepared = success(
        &mut host,
        op::VIEW_PREPARE,
        json!({"version":"1.0","surfaceGeneration":"1",
        "render":{"templateId":format!("template:{DOM}.wxml"),"useSessionResources":true,"viewport":{"width":375,"height":667}}}),
    );
    let submission: BrowserViewSubmission =
        serde_json::from_value(prepared["submission"].clone()).unwrap();
    let mut nodes = Vec::new();
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 0.0,
                y: 0.0,
                width: 80.0,
                height: 30.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 80.0,
                height: 30.0,
            },
            client_size: ViewSize {
                width: 80.0,
                height: 30.0,
            },
        });
        if let ViewNode::Element { children, .. } = node {
            pending.extend(children);
        }
    }
    let geometry = BrowserGeometryBatch {
        version: "1.0".into(),
        key: submission.key.clone(),
        epoch: 0,
        viewport: submission.viewport,
        nodes,
    };
    let permit = success(
        &mut host,
        op::VIEW_PREPARE_COMMIT,
        serde_json::to_value(geometry).unwrap(),
    )["permit"]
        .clone();
    success(&mut host, op::VIEW_PRESENTED, permit.clone());
    let event = touch(&submission, "touchstart");
    success(
        &mut host,
        op::VIEW_EVENTS,
        json!({"version":"1.0","key":submission.key,"epoch":"0","events":[event]}),
    );
    assert_eq!(inspect(&mut host)["starts"], 1);
    (host, submission, permit)
}
fn touch(submission: &BrowserViewSubmission, kind: &str) -> Value {
    let mut nodes: Vec<_> = submission.document.nodes.iter().collect();
    let mut target = None;
    while let Some(node) = nodes.pop() {
        if let ViewNode::Element {
            attrs, children, ..
        } = node
        {
            if attrs.get("id").is_some_and(|value| value == "touch") {
                target = Some(node.occurrence_id().to_owned());
                break;
            }
            nodes.extend(children);
        }
    }
    let point = json!({"identifier":7,"x":2,"y":4,"clientX":2,"clientY":4,"pageX":2,"pageY":4});
    json!({"type":kind,"targetOccurrenceId":target.unwrap(),"detail":{},"timeStamp":25.5,
        "changedTouches":[point],"touches":if kind=="touchstart" {json!([point])} else {json!([])}})
}
fn assert_old_input_rejected(
    host: &mut WebHost,
    submission: &BrowserViewSubmission,
    permit: &Value,
) {
    for (operation, payload) in [
        (op::VIEW_PRESENTED, permit.clone()),
        (
            op::VIEW_EVENTS,
            json!({"version":"1.0","key":submission.key,"epoch":"0","events":[touch(submission,"touchcancel")]}),
        ),
    ] {
        let batch = send(host, operation, payload);
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.payload["ok"] == false),
            "{batch:?}"
        );
    }
    assert!(!host.session.session().unwrap().is_browser_view_presented());
}
fn tick(host: &mut WebHost) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    let batch = host.poll_timers(now.saturating_add(1_000_000_000)).unwrap();
    assert!(
        batch
            .messages
            .iter()
            .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
        "{batch:?}"
    );
    assert_eq!(inspect(host)["ticks"], 1);
    assert_eq!(
        host.session
            .session()
            .unwrap()
            .app_service()
            .storage()
            .get("tick-effects"),
        Some(&json!(1))
    );
}

#[test]
fn trusted_native_public_view_cancel_navigation_races_do_not_commit_a_binding_or_revive_input() {
    for action in ["navigate", "away-back"] {
        let (mut host, submission, permit) = fixture(action);
        let owner = host.session.session().unwrap() as *const _;
        let before = state(&host);
        let final_value: Value =
            serde_json::from_slice(&host.transition_renderer_json(&expected(&before)).unwrap())
                .unwrap();
        assert_eq!(final_value["ok"], false);
        assert_eq!(final_value["error"]["code"], "ERR_CANCELLED");
        assert_eq!(final_value["presenterBinding"], before["presenterBinding"]);
        assert_eq!(host.session.session().unwrap() as *const _, owner);
        let retired: Vec<_> = final_value["batch"]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["op"] == "view.contacts.retired")
            .collect();
        assert_eq!(retired.len(), 1);
        assert_eq!(retired[0]["payload"]["delivered"], true);
        let after = state(&host);
        assert_eq!(after["presenterBinding"]["generation"], "1");
        assert!(
            after["inputLifetimeRevision"]
                .as_str()
                .unwrap()
                .parse::<u64>()
                .unwrap()
                > before["inputLifetimeRevision"]
                    .as_str()
                    .unwrap()
                    .parse::<u64>()
                    .unwrap()
                    + 1
        );
        if action == "away-back" {
            assert_eq!(
                after["state"]["currentPage"],
                before["state"]["currentPage"]
            );
        } else {
            assert_eq!(after["state"]["currentPage"]["path"], SKIA);
        }
        let current = inspect(&mut host);
        assert_eq!(current["cancels"], 1);
        assert_eq!(current["launches"], 1);
        assert_eq!(
            host.session
                .session()
                .unwrap()
                .app_service()
                .storage()
                .get("cancel-effects"),
            Some(&json!({"count":1,"reason":"renderer-family-changed"}))
        );
        assert_old_input_rejected(&mut host, &submission, &permit);
        tick(&mut host);
        host.retire_page_presenter("trusted-native-repeat").unwrap();
        assert_eq!(
            inspect(&mut host)["cancels"],
            1,
            "consumed contact cannot replay cancellation"
        );
        host.unload();
        host.unload();
        assert!(!host.has_session());
    }
}

#[test]
fn trusted_native_public_view_cancel_throw_preserves_effects_original_owner_and_revoked_input() {
    let (mut host, submission, permit) = fixture("throw");
    let owner = host.session.session().unwrap() as *const _;
    let before = state(&host);
    let error = host
        .transition_renderer_json(&expected(&before))
        .unwrap_err();
    let HostSessionError::BridgeBatch(completion) = &error else {
        panic!("retirement must preserve its bridge completion error: {error}");
    };
    assert_eq!(completion.code, BridgeErrorCode::Engine);
    let after = state(&host);
    assert_eq!(after["presenterBinding"], before["presenterBinding"]);
    assert_eq!(
        after["inputLifetimeRevision"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap(),
        before["inputLifetimeRevision"]
            .as_str()
            .unwrap()
            .parse::<u64>()
            .unwrap()
            + 1
    );
    assert_eq!(host.session.session().unwrap() as *const _, owner);
    let diagnostics = send(
        &mut host,
        op::DIAGNOSTIC,
        json!({"message":"retirement-throw-evidence"}),
    );
    // Native exception conversion deliberately uses safe error text. The
    // original listener message is reported through the retained JS lane.
    assert!(
        diagnostics
            .messages
            .iter()
            .any(|message| message.op == op::ERROR
                && message.payload["error"]["code"] == "ERR_ENGINE"
                && message.payload["error"]["message"].as_str()
                    == Some(completion.message.as_str())),
        "the original native completion must survive: {completion:?}: {diagnostics:?}"
    );
    let reported = diagnostics
        .messages
        .iter()
        .filter(|message| message.op == op::ERROR)
        .filter_map(|message| message.payload["errors"].as_array())
        .flatten()
        .filter(|error| error["message"] == "transition-cancel-hook-failed")
        .count();
    assert_eq!(
        reported, 1,
        "the original listener error must report exactly once: {diagnostics:?}"
    );
    let retired: Vec<_> = diagnostics
        .messages
        .iter()
        .filter(|message| message.op == "view.contacts.retired")
        .collect();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0].payload["delivered"], false);
    let current = inspect(&mut host);
    assert_eq!(current["cancels"], 1);
    assert_eq!(current["pages"][0]["data"]["cancels"], 1);
    assert_eq!(
        host.session
            .session()
            .unwrap()
            .app_service()
            .storage()
            .get("cancel-effects"),
        Some(&json!({"count":1,"reason":"renderer-family-changed"}))
    );
    assert_old_input_rejected(&mut host, &submission, &permit);
    tick(&mut host);
    host.retire_page_presenter("trusted-native-repeat-after-throw")
        .unwrap();
    assert_eq!(inspect(&mut host)["cancels"], 1);
    assert_eq!(state(&host)["presenterBinding"]["generation"], "1");
    host.unload();
    host.unload();
    assert!(!host.has_session());
}
