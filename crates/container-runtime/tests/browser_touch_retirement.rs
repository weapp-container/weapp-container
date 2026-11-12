//! Synthetic browser facts against both real JS engines; no browser/device
//! presentation or official gesture-parity evidence is claimed here.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_runtime::{BrowserViewSubmission, Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const APP: &str = r#"
App({events:[],cancels:0,throwCancel:false,navigateOnStart:false});
globalThis.recordTouch=function(e){
  const app=getApp();
  app.events.push({type:e.type,id:e.currentTarget.id,changed:e.changedTouches,touches:e.touches,reason:e.detail.reason||null});
  if(e.type==='touchstart') {this.setData({dragging:true}); if(app.navigateOnStart) wx.navigateTo({url:'/pages/second/index'});}
  if(e.type==='touchend'||e.type==='touchcancel') this.setData({dragging:false});
  if(e.type==='touchcancel') {app.cancels++;wx.setStorageSync('cancel-count',app.cancels);if(app.throwCancel)throw new Error('cancel-hook-failed');}
};
exports.inspect=()=>({events:getApp().events,cancels:getApp().cancels,data:getCurrentPages().map(p=>p.data)});
exports.arm=(name)=>{getApp()[name]=true;};
exports.remove=()=>getCurrentPages()[0].setData({show:false});
"#;
const PAGE: &str = "Page({data:{show:true,dragging:false},touch:globalThis.recordTouch,onHide(){getApp().events.push({type:'page.hide'})},onUnload(){getApp().events.push({type:'page.unload'})}});";
const COMPONENT: &str = "Component({data:{dragging:false},methods:{touch:globalThis.recordTouch},lifetimes:{detached(){getApp().events.push({type:'component.detached'})}}});";
const TOUCH: &str = r#"<view id="touch" bindtouchstart="touch" bindtouchmove="touch" bindtouchend="touch" bindtouchcancel="touch"/>"#;

fn engines() -> Vec<EngineKind> {
    [EngineKind::Quickjs, EngineKind::V8]
        .into_iter()
        .filter(|engine| container_runtime::engine_provider_compiled(*engine))
        .collect()
}
fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request("session-1", operation, operation, payload)
}
struct Fixture {
    session: Session,
}
impl Fixture {
    fn new(engine: EngineKind, component: bool) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "browser-touch-retirement".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "module:app.js".into();
        manifest.capabilities = BTreeMap::from([
            ("getCurrentPages".into(), CapabilitySupport::Full),
            ("wx.setStorageSync".into(), CapabilitySupport::Full),
            ("wx.navigateTo".into(), CapabilitySupport::Full),
        ]);
        let mut modules = vec![];
        for (id, source, scope) in [
            ("app.js", APP, ModuleScope::App),
            ("pages/index/index.js", PAGE, ModuleScope::Page),
            ("pages/second/index.js", PAGE, ModuleScope::Page),
            (
                "components/touch/index.js",
                COMPONENT,
                ModuleScope::Component,
            ),
        ] {
            manifest.modules.push(Module {
                id: format!("module:{id}"),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
            modules.push(json!({"id":format!("module:{id}"),"source":source}));
        }
        for route in ["pages/index/index", "pages/second/index"] {
            manifest.routes.push(Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("module:{route}.js"),
            });
        }
        let mut blobs = BTreeMap::new();
        for (path, source) in [
            (
                "pages/index/index.wxml",
                if component {
                    r#"<touch-box wx:if="{{show}}"/>"#
                } else {
                    TOUCH
                },
            ),
            ("pages/second/index.wxml", TOUCH),
            ("components/touch/index.wxml", TOUCH),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let hash = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: format!("template:{path}"),
                wxml_ast: hash.clone(),
                bindings: vec![],
                wxs_modules: Default::default(),
            });
            blobs.insert(hash, bytes);
        }
        if component {
            manifest.components.push(Component {
                id: "components:pages/index/index.json".into(),
                owner: "pages/index/index.json".into(),
                using_components: BTreeMap::from([(
                    "touch-box".into(),
                    "components/touch/index".into(),
                )]),
                multiple_slots: None,
            });
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    browser_view_enabled: true,
                    renderer_override: Some(RendererProfile::WebView),
                    ..Default::default()
                },
            )
            .unwrap(),
        };
        fixture.call(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        fixture.call(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.call(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        fixture
    }
    fn call(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        let batch = self.session.dispatch(request(operation, payload));
        assert!(
            batch.messages[0].payload["ok"] != false,
            "engine={:?} operation={operation} view_metrics={:?} batch={batch:?}",
            self.session.config().engine,
            self.session.view_execution_metrics(),
        );
        batch
    }
    fn program(&mut self, name: &str, args: Value) -> Value {
        let batch = self.call(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":name,"args":args}),
        );
        batch.messages[0].payload["result"][0].clone()
    }
    fn state(&mut self) -> Value {
        self.program("inspect", json!([]))
    }
    fn prepare(&mut self) -> (BrowserViewSubmission, BridgeBatch) {
        let path = self
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .path
            .clone();
        let batch=self.call(op::VIEW_PREPARE,json!({"version":"1.0","surfaceGeneration":"1","render":{"templateId":format!("template:{path}.wxml"),"useSessionResources":true,"viewport":{"width":375,"height":667}}}));
        let submission =
            serde_json::from_value(batch.messages[0].payload["submission"].clone()).unwrap();
        (submission, batch)
    }
    fn present(&mut self) -> BrowserViewSubmission {
        let (submission, _) = self.prepare();
        let mut nodes = vec![];
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
        let permit = self
            .call(
                op::VIEW_PREPARE_COMMIT,
                serde_json::to_value(geometry).unwrap(),
            )
            .messages[0]
            .payload["permit"]
            .clone();
        self.call(op::VIEW_PRESENTED, permit);
        submission
    }
    fn inputs(&mut self, submission: &BrowserViewSubmission, events: Value) -> BridgeBatch {
        self.call(
            op::VIEW_EVENTS,
            json!({"version":"1.0","key":submission.key,"epoch":"0","events":events}),
        )
    }
}
fn target(submission: &BrowserViewSubmission) -> String {
    let mut nodes: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = nodes.pop() {
        if let ViewNode::Element {
            attrs, children, ..
        } = node
        {
            if attrs.get("id").is_some_and(|id| id == "touch") {
                return node.occurrence_id().into();
            }
            nodes.extend(children);
        }
    }
    panic!("no touch occurrence")
}
fn touch(id: i64, x: f64) -> Value {
    json!({"identifier":id,"x":x,"y":4,"clientX":x,"clientY":4,"pageX":x,"pageY":4})
}
fn event(submission: &BrowserViewSubmission, kind: &str, changed: Value, touches: Value) -> Value {
    json!({"type":kind,"targetOccurrenceId":target(submission),"detail":{},"timeStamp":25.5,"changedTouches":changed,"touches":touches})
}
fn down(fixture: &mut Fixture, submission: &BrowserViewSubmission) {
    fixture.inputs(
        submission,
        json!([event(
            submission,
            "touchstart",
            json!([touch(7, 2.0)]),
            json!([touch(7, 2.0)])
        )]),
    );
}
fn cancellations(state: &Value) -> Vec<&Value> {
    state["events"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["type"] == "touchcancel")
        .collect()
}
fn retired(batch: &BridgeBatch) -> usize {
    batch
        .messages
        .iter()
        .filter(|message| {
            message.op == "view.contacts.retired" && message.payload["delivered"] == true
        })
        .count()
}

fn assert_single_touch(value: &Value, identifier: i64, x: f64) {
    let touches = value.as_array().expect("touch list");
    assert_eq!(touches.len(), 1);
    let touch = touches[0].as_object().expect("touch facts");
    assert_eq!(touch.len(), 7);
    assert_eq!(touch["identifier"].as_i64(), Some(identifier));
    // JS has one Number type; either engine may serialize integral-valued
    // coordinates as JSON integers rather than Rust's original f64 spelling.
    for field in ["x", "clientX", "pageX"] {
        assert_eq!(touch[field].as_f64(), Some(x));
    }
    for field in ["y", "clientY", "pageY"] {
        assert_eq!(touch[field].as_f64(), Some(4.0));
    }
}

#[test]
fn rebuilding_cancels_latest_owned_contact_once_even_when_candidate_is_aborted() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let first = f.present();
        down(&mut f, &first);
        f.inputs(
            &first,
            json!([event(
                &first,
                "touchmove",
                json!([touch(7, 91.0)]),
                json!([touch(7, 91.0)])
            )]),
        );
        let failed=f.session.dispatch(request(op::VIEW_PREPARE,json!({"version":"1.0","surfaceGeneration":"1","render":{"templateId":"missing","useSessionResources":true,"viewport":{"width":375,"height":667}}})));
        assert_eq!(failed.messages[0].payload["ok"], false);
        assert_eq!(f.state()["cancels"], 0);
        let (candidate, batch) = f.prepare();
        assert_eq!(retired(&batch), 1);
        f.call(op::VIEW_ABORT, serde_json::to_value(candidate.key).unwrap());
        let state = f.state();
        assert_eq!(state["cancels"], 1);
        assert_eq!(state["data"][0]["dragging"], false);
        assert_single_touch(&cancellations(&state)[0]["changed"], 7, 91.0);
        assert_eq!(cancellations(&state)[0]["touches"], json!([]));
        assert_eq!(
            f.session.app_service().storage().get("cancel-count"),
            Some(&json!(1))
        );
        assert_eq!(
            f.session.view_document().unwrap().revision,
            first.document.revision
        );
        assert!(!f.session.is_browser_view_presented());
        let second = f.present();
        f.inputs(
            &second,
            json!([
                event(&second, "touchend", json!([touch(7, 93.0)]), json!([])),
                event(&second, "touchcancel", json!([touch(7, 93.0)]), json!([]))
            ]),
        );
        assert_eq!(f.state()["cancels"], 1);
    }
}

#[test]
fn hide_resize_navigation_manifest_and_unrestricted_mutation_retire_before_owner_changes() {
    for engine in engines() {
        for action in [
            "hide", "resize", "layout", "push", "unload", "manifest", "mutable",
        ] {
            let mut f = Fixture::new(engine, false);
            let view = f.present();
            down(&mut f, &view);
            let batch = match action {
                "hide" => f.call(op::APP_LIFECYCLE, json!({"event":"hide"})),
                "resize" => f.session.notify_viewport_resize(420, 740).unwrap(),
                "layout" => f.session.notify_window_metrics(serde_json::from_value(json!({
                    "windowWidth":375,"windowHeight":667,"pixelRatio":2,"screenWidth":375,"screenHeight":667,
                    "statusBarHeight":0,"screenTop":0,"deviceOrientation":"portrait",
                    "hostLayout":{"version":1,"safeInsets":{"top":0,"right":40,"bottom":20,"left":0},
                        "verticalBarEdge":"right","reservedRegions":[]}
                })).unwrap()).unwrap(),
                "push" => f.call(op::PAGE_PUSH, json!({"path":"pages/second/index"})),
                "unload" => f.call(op::APP_LIFECYCLE, json!({"event":"unload"})),
                "manifest" => {
                    let mut manifest = f.session.manifest().clone();
                    manifest.templates[0].bindings.push("changed".into());
                    manifest.refresh_integrity().unwrap();
                    f.session.replace_manifest(manifest).unwrap();
                    f.call(op::DIAGNOSTIC, json!({"message":"flush"}))
                }
                "mutable" => {
                    f.session
                        .app_service_mut()
                        .set_storage("host-value", json!(true))
                        .unwrap();
                    f.call(op::DIAGNOSTIC, json!({"message":"flush"}))
                }
                _ => unreachable!(),
            };
            assert_eq!(retired(&batch), 1, "{engine:?} {action}: {batch:?}");
            let state = f.state();
            assert_eq!(state["cancels"], 1, "{engine:?} {action}: {state}");
            assert_eq!(
                f.session.app_service().storage().get("cancel-count"),
                Some(&json!(1))
            );
            let types = state["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| event["type"].as_str().unwrap())
                .collect::<Vec<_>>();
            if let Some(hidden) = types.iter().position(|kind| *kind == "page.hide") {
                assert!(
                    types
                        .iter()
                        .position(|kind| *kind == "touchcancel")
                        .unwrap()
                        < hidden
                );
            }
        }
    }
}

#[test]
fn component_cancel_precedes_detached_and_callback_errors_do_not_skip_other_contacts() {
    for engine in engines() {
        let mut f = Fixture::new(engine, true);
        let view = f.present();
        f.program("arm", json!(["throwCancel"]));
        f.inputs(
            &view,
            json!([event(
                &view,
                "touchstart",
                json!([touch(7, 2.0), touch(9, 8.0)]),
                json!([touch(7, 2.0), touch(9, 8.0)])
            )]),
        );
        f.program("remove", json!([]));
        let (_, batch) = f.prepare();
        assert_eq!(retired(&batch), 2);
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.payload["errors"]
                    .as_array()
                    .is_some_and(|errors| errors
                        .iter()
                        .any(|error| error["message"] == "cancel-hook-failed"))),
            "{batch:?}"
        );
        let state = f.state();
        assert_eq!(state["cancels"], 2);
        let types = state["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>();
        let detached = types
            .iter()
            .position(|kind| *kind == "component.detached")
            .unwrap();
        assert_eq!(
            types[..detached]
                .iter()
                .filter(|kind| **kind == "touchcancel")
                .count(),
            2
        );
        assert_eq!(
            f.session.app_service().storage().get("cancel-count"),
            Some(&json!(2))
        );
    }
}

#[test]
fn terminal_events_consume_ownership_before_callbacks_and_late_cancel_is_ignored() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let view = f.present();
        down(&mut f, &view);
        f.inputs(
            &view,
            json!([
                event(&view, "touchend", json!([touch(7, 5.0)]), json!([])),
                event(&view, "touchcancel", json!([touch(7, 5.0)]), json!([]))
            ]),
        );
        let (_, batch) = f.prepare();
        assert_eq!(retired(&batch), 0);
        let state = f.state();
        assert_eq!(state["cancels"], 0);
        assert_eq!(state["data"][0]["dragging"], false);
        assert_eq!(
            state["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["type"] == "touchend")
                .count(),
            1
        );
    }
}

#[test]
fn navigation_from_down_cancels_consumed_contact_without_capturing_dropped_batch_events() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let view = f.present();
        f.program("arm", json!(["navigateOnStart"]));
        let batch = f.inputs(
            &view,
            json!([
                event(
                    &view,
                    "touchstart",
                    json!([touch(7, 2.0)]),
                    json!([touch(7, 2.0)])
                ),
                event(
                    &view,
                    "touchstart",
                    json!([touch(9, 8.0)]),
                    json!([touch(7, 2.0), touch(9, 8.0)])
                )
            ]),
        );
        assert_eq!(retired(&batch), 1);
        assert_eq!(
            f.session.app_service().pages().current().unwrap().path,
            "pages/second/index"
        );
        assert_eq!(f.state()["cancels"], 1);
        let (_, next) = f.prepare();
        assert_eq!(retired(&next), 0);
        assert_eq!(f.state()["cancels"], 1);
    }
}

#[test]
fn malformed_later_contact_is_rejected_before_any_earlier_event_mutates_ownership() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let view = f.present();
        down(&mut f, &view);
        let before = f.state();
        let events = json!([
            event(
                &view,
                "touchmove",
                json!([touch(7, 80.0)]),
                json!([touch(7, 80.0)])
            ),
            event(
                &view,
                "touchstart",
                json!([touch(7, 90.0)]),
                json!([touch(7, 90.0)])
            )
        ]);
        let rejected = f.session.dispatch(request(
            op::VIEW_EVENTS,
            json!({"version":"1.0","key":view.key,"epoch":"0","events":events}),
        ));
        assert_eq!(
            rejected.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert_eq!(f.state(), before);
        let (_, batch) = f.prepare();
        assert_eq!(retired(&batch), 1);
        let state = f.state();
        assert_single_touch(&cancellations(&state)[0]["changed"], 7, 2.0);
    }
}

#[test]
fn developer_owner_browser_retirement_fails_after_consuming_contacts_and_settling_effects() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let view = f.present();
        f.program("arm", json!(["throwCancel"]));
        f.inputs(
            &view,
            json!([event(
                &view,
                "touchstart",
                json!([touch(7, 2.0), touch(9, 8.0)]),
                json!([touch(7, 2.0), touch(9, 8.0)])
            )]),
        );
        let error = f.session.retire_dev_preview("owner-error").unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Engine);
        assert!(
            f.session.execution_fault().is_none(),
            "ordinary throws do not poison the engine"
        );
        assert!(!f.session.is_browser_view_presented());
        assert_eq!(
            f.session.app_service().pages().current().unwrap().data["dragging"],
            false
        );
        assert_eq!(
            f.session.app_service().storage().get("cancel-count"),
            Some(&json!(2))
        );
        let retried = f.session.retire_dev_preview("retry-after-error").unwrap();
        let retired = retried
            .messages
            .iter()
            .filter(|message| message.op == "view.contacts.retired")
            .collect::<Vec<_>>();
        assert_eq!(
            retired.len(),
            2,
            "both leases were consumed before callbacks: {retried:?}"
        );
        assert!(retired
            .iter()
            .all(|message| message.payload["delivered"] == false));
        // Native exception conversion deliberately avoids reading arbitrary
        // thrown-object getters. Match its returned safe error at that boundary;
        // the original listener detail belongs to the already reported JS lane.
        assert!(
            retried
                .messages
                .iter()
                .any(|message| message.op == op::ERROR
                    && message.payload["error"]["code"] == "ERR_ENGINE"
                    && message.payload["error"]["message"].as_str()
                        == Some(error.message.as_str())),
            "the returned native completion error must remain intact: {error:?}: {retried:?}"
        );
        let reported = retried
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .filter_map(|message| message.payload["errors"].as_array())
            .flatten()
            .filter(|error| error["message"] == "cancel-hook-failed")
            .count();
        assert_eq!(reported, 2, "both original callback errors must survive exactly once in reported diagnostics: {retried:?}");
        let state = f.state();
        assert_eq!(state["cancels"], 2, "{engine:?}: {state}");
        let cancelled = cancellations(&state);
        assert_eq!(cancelled.len(), 2);
        assert!(cancelled
            .iter()
            .all(|event| event["reason"] == "owner-error"));
        for identifier in [7, 9] {
            assert_eq!(
                cancelled
                    .iter()
                    .filter(|event| event["changed"][0]["identifier"] == identifier)
                    .count(),
                1
            );
        }
        f.session.retire_dev_preview("repeat-after-error").unwrap();
        assert_eq!(
            f.state(),
            state,
            "failed completion cannot replay consumed browser contacts"
        );
    }
}

#[test]
fn historical_browser_preview_retirement_still_reports_user_errors_without_failing() {
    for engine in engines() {
        let mut f = Fixture::new(engine, false);
        let view = f.present();
        f.program("arm", json!(["throwCancel"]));
        down(&mut f, &view);
        let batch = f
            .session
            .retire_browser_preview("legacy-owner-exit")
            .unwrap();
        assert_eq!(
            retired(&batch),
            1,
            "historical delivery policy remains report-and-continue"
        );
        assert!(
            batch
                .messages
                .iter()
                .any(|message| message.payload["errors"]
                    .as_array()
                    .is_some_and(|errors| errors
                        .iter()
                        .any(|error| error["message"] == "cancel-hook-failed"))),
            "{batch:?}"
        );
        assert_eq!(f.state()["cancels"], 1);
        assert_eq!(
            f.session.app_service().storage().get("cancel-count"),
            Some(&json!(1))
        );
    }
}
