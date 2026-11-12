//! Real engines and evaluated WXML, with a fault-injectable browser protocol
//! peer. These tests are not evidence of an actual browser or native WebView.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_render_skia::Renderer;
use container_runtime::{BrowserLiveViewSubmission, BrowserViewSubmission, Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const FIXTURE_WXML: &str = r#"<view id="parent" capture-bind:tap="onTap"><view id="tap" bindtap="onTap" bindtouchstart="onTouch" bindtouchend="onTouch" bindtouchcancel="onTouch" data-flag="{{false}}"><text>{{count}}</text></view></view>"#;
const FIXTURE_WXSS: &str = "view { display:grid; grid-template-columns:1fr 2fr; }";

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
fn fixture(engine: EngineKind) -> (Session, Value) {
    fixture_with_route_profile(engine, false)
}
fn fixture_with_route_profile(engine: EngineKind, route_profile: bool) -> (Session, Value) {
    fixture_with_query_contract(engine, route_profile, false)
}
fn fixture_with_query_contract(
    engine: EngineKind,
    route_profile: bool,
    session_query: bool,
) -> (Session, Value) {
    let app = "App({readies:0, events:[], touchEvents:[], loadCapabilities:[]});";
    let page = r#"Page({data:{count:1},onReady(){getApp().readies++},
        onLoad(options){getApp().loadCapabilities.push(wx.canIUse('createSelectorQuery'));
          if(options.startupQuery==='yes'){
            wx.createSelectorQuery().select('#tap').boundingClientRect().exec().then(value=>{getApp().queryResult=value;getApp().querySuccesses=(getApp().querySuccesses||0)+1},error=>{getApp().queryError=error.code;getApp().queryErrors=(getApp().queryErrors||0)+1});
            setTimeout(()=>{getApp().startupTimerFired=true},0);
          }
        },
        onTap(e){getApp().events.push({id:e.currentTarget.id,value:e.target.dataset.flag});this.setData({count:this.data.count+1})},
        onTouch(e){getApp().touchEvents.push({type:e.type,timeStamp:e.timeStamp,touches:e.touches,changedTouches:e.changedTouches,detail:e.detail,target:e.target.id,current:e.currentTarget.id})},
        forbidden(){throw Error('untrusted handler executed')}});
        exports.inspect=()=>({readies:getApp().readies,events:getApp().events,touchEvents:getApp().touchEvents,loadCapabilities:getApp().loadCapabilities});
        exports.query=options=>{
          const query=wx.createSelectorQuery().in(getCurrentPages()[0]);
          const callbacks=[];
          const capture=value=>{callbacks.push(value)};
          for (const item of options.queries) {
            const node=item.target==='viewport'?query.selectViewport():item.all?query.selectAll(item.selector):query.select(item.selector);
            if(item.operation==='fields') node.fields(item.fields,capture);
            else if(item.operation==='node') node.node(capture);
            else if(item.operation==='scrollOffset') node.scrollOffset(capture);
            else node.boundingClientRect(capture);
          }
          query.exec(value=>{getApp().queryCallbacks=callbacks;getApp().queryExecResult=value}).then(value=>{getApp().queryResult=value;getApp().querySuccesses=(getApp().querySuccesses||0)+1},error=>{getApp().queryError=error.code;getApp().queryErrors=(getApp().queryErrors||0)+1});
          return 'scheduled';
        };
        exports.queryMany=count=>{for(let index=0;index<count;index++)exports.query({queries:[{selector:'#tap'}]});return count};
        exports.queryState=()=>({result:getApp().queryResult,callbacks:getApp().queryCallbacks,execResult:getApp().queryExecResult,error:getApp().queryError,successes:getApp().querySuccesses||0,errors:getApp().queryErrors||0,timerFired:getApp().startupTimerFired,capability:wx.canIUse('createSelectorQuery'),intersection:wx.canIUse('createIntersectionObserver')});"#;
    fixture_with_browser_sources(
        engine,
        route_profile,
        session_query,
        FIXTURE_WXML,
        app,
        page,
    )
}
fn fixture_with_browser_sources(
    engine: EngineKind,
    route_profile: bool,
    session_query: bool,
    wxml_source: &str,
    app: &str,
    page: &str,
) -> (Session, Value) {
    let wxml = parse_wxml(wxml_source).unwrap().canonical_json().unwrap();
    // This valid browser CSS must not be reduced by the Rust layout engine.
    let wxss = parse_wxss(FIXTURE_WXSS).unwrap().canonical_json().unwrap();
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "browser-protocol-fixture".into(),
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
        capabilities: BTreeMap::from([
            ("wx.createSelectorQuery".into(), CapabilitySupport::Full),
            (
                "wx.createIntersectionObserver".into(),
                CapabilitySupport::Full,
            ),
            ("wx.pageScrollTo".into(), CapabilitySupport::Full),
            ("wx.canvas.draw".into(), CapabilitySupport::Partial),
            ("getCurrentPages".into(), CapabilitySupport::Partial),
            ("setTimeout".into(), CapabilitySupport::Partial),
        ]),
        ..Default::default()
    };
    for (id, source, scope) in [
        ("module:app.js", app, ModuleScope::App),
        ("module:pages/index/index.js", page, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    let template_hash = format!("sha256:{}", hex_digest(&wxml));
    let style_hash = format!("sha256:{}", hex_digest(&wxss));
    manifest.templates.push(Template {
        id: "template:pages/index/index.wxml".into(),
        wxml_ast: template_hash.clone(),
        bindings: vec![],
        wxs_modules: Default::default(),
    });
    manifest.styles.push(Style {
        id: "style:app.wxss".into(),
        wxss_ir: style_hash.clone(),
        scope: StyleScope::App,
    });
    if route_profile {
        manifest.schema_version = RENDERING_MANIFEST_SCHEMA_VERSION;
        manifest.rendering = Some(RendererProfiles {
            default: RendererProfile::Skia,
            pages: BTreeMap::from([("pages/index/index".into(), RendererProfile::WebView)]),
            ..Default::default()
        });
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            renderer_override: (!route_profile).then_some(RendererProfile::WebView),
            browser_view_enabled: true,
            ..Default::default()
        },
    )
    .unwrap();
    if session_query {
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"session"}),
        );
    }
    dispatch(
        &mut session,
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":app},{"id":"module:pages/index/index.js","source":page}],"blobs":{template_hash:wxml,style_hash:wxss}}),
    );
    dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    dispatch(
        &mut session,
        op::PAGE_PUSH,
        json!({"path":"pages/index/index"}),
    );
    (
        session,
        json!({"templateId":"template:pages/index/index.wxml","useSessionResources":true,"viewport":{"width":375,"height":667}}),
    )
}
fn inspect(session: &mut Session) -> Value {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:pages/index/index.js","export":"inspect","args":[]}),
    )["result"][0]
        .clone()
}
fn geometry(submission: &BrowserViewSubmission) -> BrowserGeometryBatch {
    let mut nodes = vec![];
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 17.0,
                y: 24.0,
                width: 90.0,
                height: 32.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 90.0,
                height: 32.0,
            },
            client_size: ViewSize {
                width: 90.0,
                height: 32.0,
            },
        });
        if let ViewNode::Element { children, .. } = node {
            pending.extend(children);
        }
    }
    BrowserGeometryBatch {
        version: VIEW_PRESENTATION_VERSION.into(),
        key: submission.key.clone(),
        epoch: 0,
        viewport: submission.viewport,
        nodes,
    }
}
fn target(submission: &BrowserViewSubmission) -> String {
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        if let ViewNode::Element {
            attrs, children, ..
        } = node
        {
            if attrs.get("id").is_some_and(|id| id == "tap") {
                return node.occurrence_id().into();
            };
            pending.extend(children);
        }
    }
    panic!("missing target")
}
fn input(submission: &BrowserViewSubmission) -> Value {
    json!({"version":"1.0","key":submission.key,"epoch":"0","events":[{"type":"tap","targetOccurrenceId":target(submission),"detail":{}}]})
}

mod text_control_input {
    use super::*;

    fn text_fixture(engine: EngineKind, wxml: &str) -> (Session, BrowserViewSubmission) {
        let (mut session, payload) = fixture_with_browser_sources(
            engine,
            false,
            false,
            wxml,
            "App({edits:[]});",
            r#"Page({data:{disabled:true,enabled:false,zero:0,nullFlag:null},
                onEdit(e){getApp().edits.push({id:e.target.id,type:e.type,detail:e.detail})}});
                exports.inspect=()=>({edits:getApp().edits});"#,
        );
        let submission = present_for_query(&mut session, &payload);
        (session, submission)
    }

    fn occurrence(submission: &BrowserViewSubmission, id: &str) -> String {
        let mut pending: Vec<_> = submission.document.nodes.iter().collect();
        while let Some(node) = pending.pop() {
            if let ViewNode::Element {
                attrs, children, ..
            } = node
            {
                if attrs.get("id").is_some_and(|value| value == id) {
                    return node.occurrence_id().into();
                }
                pending.extend(children);
            }
        }
        panic!("missing text fixture target {id}")
    }

    fn edit(submission: &BrowserViewSubmission, id: &str, kind: &str, detail: Value) -> Value {
        json!({"type":kind,"targetOccurrenceId":occurrence(submission,id),"detail":detail})
    }

    fn batch(submission: &BrowserViewSubmission, events: Vec<Value>) -> Value {
        json!({"version":"1.0","key":submission.key,"epoch":"0","events":events})
    }

    #[test]
    fn browser_text_control_details_reach_real_engines_with_utf16_positions() {
        const WXML: &str = r#"<view><input id="single" bindinput="onEdit" bindfocus="onEdit" bindblur="onEdit" bindconfirm="onEdit"/><textarea id="multi" bindinput="onEdit" bindfocus="onEdit" bindblur="onEdit" bindconfirm="onEdit"/></view>"#;
        for engine in engines() {
            let (mut session, submission) = text_fixture(engine, WXML);
            let mut events = vec![];
            let mut expected = vec![];
            for id in ["single", "multi"] {
                for kind in ["focus", "input", "confirm", "blur"] {
                    // Four UTF-16 code units, three Unicode scalar values.
                    let detail =
                        json!({"value":"中😀a","cursor":3,"selectionStart":1,"selectionEnd":3});
                    events.push(edit(&submission, id, kind, detail.clone()));
                    expected.push(json!({"id":id,"type":kind,"detail":detail}));
                }
            }
            let result = session
                .dispatch_browser_events(batch(&submission, events))
                .unwrap();
            assert_eq!(result.messages[0].payload["events"], 8, "{engine:?}");
            assert_eq!(
                inspect(&mut session)["edits"],
                json!(expected),
                "{engine:?}"
            );

            let legacy =
                json!({"value":"legacy","x":0,"y":0,"pointerId":null,"scrollTop":0,"scrollLeft":0});
            session
                .dispatch_browser_events(batch(
                    &submission,
                    vec![edit(&submission, "single", "input", legacy.clone())],
                ))
                .unwrap();
            assert_eq!(
                inspect(&mut session)["edits"][8]["detail"],
                legacy,
                "{engine:?}"
            );
        }
    }

    #[test]
    fn browser_disabled_text_control_rejects_whole_batch_before_callbacks() {
        const WXML: &str = r#"<view><input id="enabled" disabled="{{enabled}}" bindinput="onEdit"/><input id="blocked-single" disabled="{{disabled}}" bindinput="onEdit" bindfocus="onEdit" bindblur="onEdit" bindconfirm="onEdit"/><textarea id="blocked-multi" disabled="{{disabled}}" bindinput="onEdit" bindfocus="onEdit" bindblur="onEdit" bindconfirm="onEdit"/><input id="bare" disabled="" bindinput="onEdit"/><input id="literal-false" disabled="false" bindinput="onEdit"/><textarea id="zero" disabled="{{zero}}" bindinput="onEdit"/><input id="null" disabled="{{nullFlag}}" bindinput="onEdit"/></view>"#;
        for engine in engines() {
            let (mut session, submission) = text_fixture(engine, WXML);
            for id in ["blocked-single", "blocked-multi", "bare"] {
                for kind in ["input", "focus", "blur", "confirm"] {
                    let events = vec![
                        edit(&submission, "enabled", "input", json!({"value":"first"})),
                        edit(&submission, id, kind, json!({"value":"forged"})),
                    ];
                    let error = session
                        .dispatch_browser_events(batch(&submission, events))
                        .unwrap_err();
                    assert_eq!(
                        error.code,
                        container_bridge::BridgeErrorCode::InvalidRequest,
                        "{engine:?} {id} {kind}"
                    );
                    assert!(error.message.contains("disabled text control"), "{error:?}");
                    assert_eq!(inspect(&mut session)["edits"], json!([]));
                }
            }
            let events = ["enabled", "literal-false", "zero", "null"]
                .into_iter()
                .map(|id| edit(&submission, id, "input", json!({"value":"allowed"})))
                .collect();
            session
                .dispatch_browser_events(batch(&submission, events))
                .unwrap();
            assert_eq!(
                inspect(&mut session)["edits"].as_array().unwrap().len(),
                4,
                "{engine:?}"
            );
        }
    }

    #[test]
    fn browser_disabled_text_control_rejects_forged_tap_and_complete_touch_before_callbacks() {
        const WXML: &str = r#"<view bindtap="onEdit" bindtouchstart="onEdit"><input id="enabled" bindtap="onEdit"/><input id="blocked-single" disabled="{{disabled}}" bindtap="onEdit" bindtouchstart="onEdit"/><textarea id="blocked-multi" disabled="{{disabled}}" bindtap="onEdit" bindtouchstart="onEdit"/></view>"#;
        for engine in engines() {
            let (mut session, submission) = text_fixture(engine, WXML);
            for id in ["blocked-single", "blocked-multi"] {
                for kind in ["tap", "touchstart"] {
                    let mut event = edit(&submission, id, kind, json!({"application":"detail"}));
                    if kind == "touchstart" {
                        let touch = json!({"identifier":7,"x":1,"y":2,"clientX":1,"clientY":2,"pageX":1,"pageY":2});
                        event["touches"] = json!([touch.clone()]);
                        event["changedTouches"] = json!([touch]);
                        event["timeStamp"] = json!(123.5);
                    }
                    let events = vec![
                        edit(
                            &submission,
                            "enabled",
                            "tap",
                            json!({"application":"first"}),
                        ),
                        event,
                    ];
                    let error = session
                        .dispatch_browser_events(batch(&submission, events))
                        .unwrap_err();
                    assert_eq!(
                        error.code,
                        container_bridge::BridgeErrorCode::InvalidRequest,
                        "{engine:?} {id} {kind}"
                    );
                    assert!(error.message.contains("disabled text control"), "{error:?}");
                    assert_eq!(
                        inspect(&mut session)["edits"],
                        json!([]),
                        "neither target nor ancestor callbacks may run: {engine:?} {id} {kind}"
                    );
                }
            }
        }
    }

    #[test]
    fn browser_text_control_malformed_facts_are_atomic_and_bounded() {
        const WXML: &str =
            r#"<input id="single" bindinput="onEdit"/><textarea id="multi" bindinput="onEdit"/>"#;
        let invalid_details = vec![
            Value::Null,
            json!([]),
            json!({}),
            json!({"value":null}),
            json!({"value":7}),
            json!({"value":"ok","cursor":-1}),
            json!({"value":"ok","cursor":1.5}),
            json!({"value":"😀","cursor":3}),
            json!({"value":"ok","selectionStart":2,"selectionEnd":1}),
            json!({"value":"ok","selectionEnd":null}),
            json!({"value":"ok","handler":"forbidden"}),
            json!({"value":"ok","isComposing":true}),
            json!({"value":"ok","x":"0"}),
            json!({"value":"ok","pointerId":9_007_199_254_740_992u64}),
            json!({"value":"x".repeat(64*1024+1)}),
            json!({"value":"中".repeat(22*1024)}),
        ];
        for engine in engines() {
            let (mut session, submission) = text_fixture(engine, WXML);
            for id in ["single", "multi"] {
                for detail in &invalid_details {
                    let events = vec![
                        edit(&submission, "single", "input", json!({"value":"first"})),
                        edit(&submission, id, "input", detail.clone()),
                    ];
                    let error = session
                        .dispatch_browser_events(batch(&submission, events))
                        .unwrap_err();
                    assert_eq!(
                        error.code,
                        container_bridge::BridgeErrorCode::InvalidRequest,
                        "{engine:?} {id}: {error:?}"
                    );
                    assert_eq!(inspect(&mut session)["edits"], json!([]));
                }
            }
            // The bound is inclusive and counts UTF-8 bytes, not characters.
            let value = "x".repeat(64 * 1024);
            session
                .dispatch_browser_events(batch(
                    &submission,
                    vec![edit(
                        &submission,
                        "single",
                        "input",
                        json!({"value":value,"cursor":64*1024}),
                    )],
                ))
                .unwrap();
            assert_eq!(
                inspect(&mut session)["edits"][0]["detail"]["value"]
                    .as_str()
                    .unwrap()
                    .len(),
                64 * 1024
            );
        }
    }

    #[test]
    fn browser_non_control_detail_remains_application_data() {
        const WXML: &str =
            r#"<view id="custom" bindinput="onEdit"/><input id="single" bindtap="onEdit"/>"#;
        for engine in engines() {
            let (mut session, submission) = text_fixture(engine, WXML);
            let detail = json!({"value":{"custom":"data"},"cursor":"application cursor","unknown":[true,null]});
            session
                .dispatch_browser_events(batch(
                    &submission,
                    vec![
                        edit(&submission, "custom", "input", detail.clone()),
                        edit(&submission, "single", "tap", detail.clone()),
                    ],
                ))
                .unwrap();
            let observed = inspect(&mut session);
            assert_eq!(observed["edits"][0]["detail"], detail, "{engine:?}");
            assert_eq!(observed["edits"][1]["detail"], detail, "{engine:?}");
        }
    }
}

fn query_state(session: &mut Session) -> Value {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:pages/index/index.js","export":"queryState","args":[]}),
    )["result"][0]
        .clone()
}
fn present_for_query(session: &mut Session, payload: &Value) -> BrowserViewSubmission {
    let submission = session.prepare_browser_view(payload, 1).unwrap();
    let permit = session
        .prepare_browser_commit(geometry(&submission))
        .unwrap();
    session.acknowledge_browser_presentation(&permit).unwrap();
    submission
}
fn schedule_query(session: &mut Session, queries: Value) -> container_bridge::BridgeBatch {
    session.dispatch(query_envelope(queries))
}
fn query_envelope(queries: Value) -> BridgeEnvelope {
    request(
        op::MODULE_CALL,
        json!({"moduleId":"module:pages/index/index.js","export":"query","args":[{"queries":queries}]}),
    )
}
fn query_request(batch: &container_bridge::BridgeBatch) -> Value {
    let requests: Vec<_> = batch
        .messages
        .iter()
        .filter(|message| message.op == op::VIEW_QUERY_REQUEST)
        .collect();
    assert_eq!(requests.len(), 1, "{batch:?}");
    requests[0].payload.clone()
}
fn fresh_query_result(request: &Value, submission: &BrowserViewSubmission) -> Value {
    let epoch = request["afterEpoch"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap()
        + 1;
    query_result_at_epoch(request, submission, epoch)
}
fn query_result_at_epoch(request: &Value, submission: &BrowserViewSubmission, epoch: u64) -> Value {
    let mut measured = geometry(submission);
    measured.epoch = epoch;
    for node in &mut measured.nodes {
        node.border_box.x = 41.0;
        node.scroll_offset = ViewPoint { x: 3.0, y: 5.0 };
    }
    json!({"version":"1.0","requestId":request["requestId"],"key":request["key"],"geometry":measured,"viewportScroll":{"x":7,"y":11},"viewportExtent":{"width":900,"height":1200}})
}

#[test]
fn dom_selector_requires_explicit_recipient_and_does_not_enable_intersection() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = present_for_query(&mut session, &payload);
        assert_eq!(query_state(&mut session)["capability"], false);
        let enable = dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"presentation","key":submission.key}),
        );
        assert_eq!(enable["enabled"], true);
        let state = query_state(&mut session);
        assert_eq!(state["capability"], true);
        assert_eq!(state["intersection"], false);
        let direct = session.dispatch(request(
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"#tap"}),
        ));
        assert_eq!(
            direct.messages[0].payload["error"]["code"],
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"disabled"}),
        );
        assert_eq!(query_state(&mut session)["capability"], false);
    }
}

#[test]
fn dom_selector_batches_declarations_and_waits_for_fresh_measurement() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        assert_eq!(inspect(&mut session)["loadCapabilities"], json!([true]));
        let submission = present_for_query(&mut session, &payload);
        let batch = schedule_query(
            &mut session,
            json!([
                {"selector":"#tap","operation":"fields","fields":{"id":true,"dataset":true,"rect":true,"scrollOffset":true}},
                {"selector":"#missing"},
                {"selector":"#missing","all":true},
                {"target":"viewport","operation":"scrollOffset"}
            ]),
        );
        let pending = query_request(&batch);
        assert_eq!(pending["occurrenceIds"], json!([target(&submission)]));
        assert_eq!(pending["afterEpoch"], "0");
        let state = query_state(&mut session);
        for field in ["result", "callbacks", "execResult"] {
            assert!(state.get(field).is_none(), "{field}: {state}");
        }
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        );
        let state = query_state(&mut session);
        let result = &state["result"];
        assert_eq!(result[0]["left"], 41.0);
        assert_eq!(result[0]["id"], "tap");
        assert_eq!(result[0]["dataset"]["flag"], false);
        assert_eq!(result[0]["scrollTop"], 5.0);
        assert_eq!(result[1], Value::Null);
        assert_eq!(result[2], json!([]));
        // Both engines return through JS JSON.stringify: integral Number
        // values become JSON integers, regardless of Rust's f64 projection.
        assert_eq!(
            result[3],
            json!({"id":"","dataset":{},"scrollLeft":7,"scrollTop":11,"scrollWidth":900,"scrollHeight":1200})
        );
        assert_eq!(&state["callbacks"], result);
        assert_eq!(&state["execResult"], result);
        // Query snapshots do not advance the admitted input geometry channel.
        assert_eq!(session.browser_geometry().unwrap().epoch, 0);
        let duplicate = session.dispatch(request(
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        ));
        assert_eq!(
            duplicate.messages[0].payload["error"]["code"],
            "ERR_CANCELLED"
        );
        let fractional = schedule_query(
            &mut session,
            json!([{"target":"viewport","operation":"scrollOffset"}]),
        );
        let fractional_request = query_request(&fractional);
        let mut measurement = fresh_query_result(&fractional_request, &submission);
        measurement["viewportScroll"] = json!({"x":7.25,"y":-11.5});
        dispatch(&mut session, op::VIEW_QUERY_RESULT, measurement);
        let state = query_state(&mut session);
        let expected = json!([{"id":"","dataset":{},"scrollLeft":7.25,"scrollTop":-11.5,"scrollWidth":900,"scrollHeight":1200}]);
        for field in ["result", "callbacks", "execResult"] {
            assert_eq!(state[field], expected, "{field}: {engine:?}");
        }
    }
}

#[test]
fn dom_viewport_scroll_requires_measured_extent_and_older_bounding_results_remain_valid() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let pending = query_request(&schedule_query(
            &mut session,
            json!([{"target":"viewport","operation":"scrollOffset"}]),
        ));
        assert_eq!(pending["includeViewportExtent"], json!(true));
        let valid = fresh_query_result(&pending, &submission);
        let mut missing = valid.clone();
        missing.as_object_mut().unwrap().remove("viewportExtent");
        let rejected = session.dispatch(request(op::VIEW_QUERY_RESULT, missing));
        assert_eq!(
            rejected.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert!(query_state(&mut session).get("result").is_none());
        dispatch(&mut session, op::VIEW_QUERY_RESULT, valid);
        assert_eq!(
            query_state(&mut session)["result"][0]["scrollHeight"],
            json!(1200)
        );
        let pending = query_request(&schedule_query(
            &mut session,
            json!([{"target":"viewport"}]),
        ));
        assert!(pending.get("includeViewportExtent").is_none());
        let mut bounds = fresh_query_result(&pending, &submission);
        bounds.as_object_mut().unwrap().remove("viewportExtent");
        dispatch(&mut session, op::VIEW_QUERY_RESULT, bounds);
        assert_eq!(
            query_state(&mut session)["result"][0]["width"].as_f64(),
            Some(submission.viewport.width),
            "legacy bounding results retain the measured viewport without an extent field"
        );
    }
}

#[test]
fn dom_selector_rejects_partial_stale_or_wrong_key_without_consuming_request() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let pending = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        let valid = fresh_query_result(&pending, &submission);
        for malformed in [
            {
                let mut value = valid.clone();
                value["geometry"]["epoch"] = json!("0");
                value
            },
            {
                let mut value = valid.clone();
                value["geometry"]["nodes"].as_array_mut().unwrap().pop();
                value
            },
            {
                let mut value = valid.clone();
                value["key"]["surfaceGeneration"] = json!("2");
                value
            },
            {
                let mut value = valid.clone();
                value["viewportScroll"] = json!({"x":"NaN","y":0});
                value
            },
        ] {
            let rejected = session.dispatch(request(op::VIEW_QUERY_RESULT, malformed));
            assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
            assert!(query_state(&mut session).get("result").is_none());
        }
        dispatch(&mut session, op::VIEW_QUERY_RESULT, valid);
        assert_eq!(query_state(&mut session)["result"][0]["left"], 41.0);
    }
}

#[test]
fn dom_selector_measurement_epoch_prevents_cross_request_and_same_key_lease_replay() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let first = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&first, &submission, 10),
        );
        assert_eq!(query_state(&mut session)["successes"], 1);
        // Changing only the negotiated recipient must not reset the accepted
        // observation epoch for this exact still-presented document.
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"disabled"}),
        );
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"presentation","key":submission.key}),
        );
        let second = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        assert_eq!(second["afterEpoch"], "10");
        let stale = session.dispatch(request(
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&second, &submission, 10),
        ));
        assert_eq!(stale.messages[0].payload["error"]["code"], "ERR_CANCELLED");
        assert_eq!(query_state(&mut session)["successes"], 1);
        let mut incomplete = query_result_at_epoch(&second, &submission, 90);
        incomplete["geometry"]["nodes"]
            .as_array_mut()
            .unwrap()
            .pop();
        let rejected = session.dispatch(request(op::VIEW_QUERY_RESULT, incomplete));
        assert_eq!(rejected.messages[0].payload["ok"], false);
        // Invalid observations neither consume the request nor advance the
        // high-water mark. The next valid epoch is still admissible.
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&second, &submission, 11),
        );
        assert_eq!(query_state(&mut session)["successes"], 2);
        assert_eq!(session.browser_geometry().unwrap().epoch, 0);
        let third = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        assert_eq!(third["afterEpoch"], "11");
    }
}

#[test]
fn dom_selector_out_of_order_measurement_retries_without_consuming_pending() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let first = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        let second = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        assert_eq!(first["afterEpoch"], "0");
        assert_eq!(second["afterEpoch"], "0");
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&second, &submission, 2),
        );
        let older = session.dispatch(request(
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&first, &submission, 1),
        ));
        assert_eq!(older.messages[0].payload["error"]["code"], "ERR_CANCELLED");
        assert_eq!(query_state(&mut session)["successes"], 1);
        assert_eq!(query_state(&mut session)["errors"], 0);
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            query_result_at_epoch(&first, &submission, 3),
        );
        assert_eq!(query_state(&mut session)["successes"], 2);
        assert_eq!(session.browser_geometry().unwrap().epoch, 0);
    }
}

#[test]
fn dom_selector_retirement_cancels_pending_and_new_presentation_needs_new_lease() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = present_for_query(&mut session, &payload);
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"presentation","key":submission.key}),
        );
        let pending = query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])));
        let next = present_for_query(&mut session, &payload);
        assert_ne!(submission.key, next.key);
        assert_eq!(query_state(&mut session)["capability"], false);
        assert_eq!(query_state(&mut session)["error"], "ERR_CANCELLED");
        let late = session.dispatch(request(
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        ));
        assert_eq!(late.messages[0].payload["ok"], false);
        let old_enable = session.dispatch(request(
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"presentation","key":submission.key}),
        ));
        assert_eq!(old_enable.messages[0].payload["ok"], false);
        dispatch(
            &mut session,
            op::VIEW_QUERY_ENABLE,
            json!({"version":"1.0","scope":"presentation","key":next.key}),
        );
        assert_eq!(query_state(&mut session)["capability"], true);
    }
}

#[test]
fn dom_selector_rejects_handles_computed_style_and_live_dom_properties() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        present_for_query(&mut session, &payload);
        for query in [
            json!({"selector":"#tap","operation":"node"}),
            json!({"selector":"#tap","operation":"fields","fields":{"context":true}}),
            json!({"selector":"#tap","operation":"fields","fields":{"computedStyle":["width"]}}),
            json!({"selector":"#tap","operation":"fields","fields":{"properties":["value"]}}),
        ] {
            let batch = schedule_query(&mut session, json!([query]));
            assert!(!batch
                .messages
                .iter()
                .any(|message| message.op == op::VIEW_QUERY_REQUEST));
            assert_eq!(
                query_state(&mut session)["error"],
                "ERR_UNSUPPORTED_CAPABILITY"
            );
        }
    }
}

#[test]
fn worker_dom_selector_onload_waits_without_blocking_timers_then_uses_first_ack() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let loading = session.dispatch(request(
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","query":{"startupQuery":"yes"}}),
        ));
        assert!(!loading
            .messages
            .iter()
            .any(|message| message.op == op::VIEW_QUERY_REQUEST));
        assert!(query_state(&mut session)["result"].is_null());
        assert!(query_state(&mut session)["error"].is_null());
        // The wait queue does not enter JS or block the owner timer turn.
        session.poll_timers(now_ns());
        assert_eq!(query_state(&mut session)["timerFired"], true);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        let acknowledgement = session.acknowledge_browser_presentation(&permit).unwrap();
        let pending = query_request(&acknowledgement);
        assert_eq!(pending["key"], json!(submission.key));
        assert_eq!(pending["key"]["pageId"], "2");
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        );
        assert_eq!(query_state(&mut session)["result"][0]["left"], 41.0);
    }
}

#[test]
fn waiting_worker_dom_selector_cannot_cross_hide_or_unload_before_first_ack() {
    for engine in engines() {
        let (mut session, _) = fixture_with_query_contract(engine, false, true);
        dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","query":{"startupQuery":"yes"}}),
        );
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_eq!(query_state(&mut session)["error"], "ERR_CANCELLED");
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        let batch = session.dispatch(request(op::PAGE_POP, json!({"delta":1})));
        assert!(!batch
            .messages
            .iter()
            .any(|message| message.op == op::VIEW_QUERY_REQUEST));
    }
}

#[test]
fn dom_selector_captures_origin_cancel_and_restores_the_next_bridge_scope() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let mut origin = query_envelope(json!([{"selector":"#tap"}]));
        origin.cancel_token = Some("query-origin".into());
        let pending = query_request(&session.dispatch(origin));
        dispatch(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"query-origin"}),
        );
        // CANCEL is pure control; completion runs in the next normal owner
        // turn, before we inspect its asynchronously updated application data.
        session.poll_timers(now_ns());
        let state = query_state(&mut session);
        assert_eq!(state["error"], "ERR_CANCELLED");
        assert_eq!(state["errors"], 1);
        assert_eq!(state["successes"], 0);
        let late = session.dispatch(request(
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        ));
        assert_eq!(late.messages[0].payload["error"]["code"], "ERR_CANCELLED");
        assert_eq!(query_state(&mut session)["errors"], 1);

        // A finished turn's token cannot contaminate a new query, including
        // the storage-import / microtask boundary at the next turn's start.
        let mut next = query_envelope(json!([{"selector":"#tap"}]));
        next.cancel_token = Some("query-next".into());
        let pending = query_request(&session.dispatch(next));
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        );
        let state = query_state(&mut session);
        assert_eq!(state["successes"], 1);
        assert_eq!(state["errors"], 1);
    }
}

#[test]
fn waiting_worker_dom_selector_keeps_origin_cancel_before_first_ack() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let mut origin = request(
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","query":{"startupQuery":"yes"}}),
        );
        origin.cancel_token = Some("startup-query".into());
        let loading = session.dispatch(origin);
        assert!(!loading
            .messages
            .iter()
            .any(|message| message.op == op::VIEW_QUERY_REQUEST));
        dispatch(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"startup-query"}),
        );
        session.poll_timers(now_ns());
        assert_eq!(query_state(&mut session)["error"], "ERR_CANCELLED");
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        let acknowledgement = session.acknowledge_browser_presentation(&permit).unwrap();
        assert!(!acknowledgement
            .messages
            .iter()
            .any(|message| message.op == op::VIEW_QUERY_REQUEST));
        assert_eq!(query_state(&mut session)["errors"], 1);
        assert_eq!(query_state(&mut session)["successes"], 0);
    }
}

fn now_ns() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
}

#[test]
fn waiting_worker_dom_selector_does_not_inherit_the_ack_transport_limits() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let mut origin = request(
            op::PAGE_PUSH,
            json!({"path":"pages/index/index","query":{"startupQuery":"yes"}}),
        );
        let original_deadline = now_ns() + 4_000_000_000;
        origin.deadline_ns = Some(original_deadline);
        origin.cancel_token = Some("startup-query".into());
        session.dispatch(origin);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        let mut acknowledgement =
            request(op::VIEW_PRESENTED, serde_json::to_value(&permit).unwrap());
        acknowledgement.deadline_ns = Some(now_ns() + 1_000_000_000);
        acknowledgement.cancel_token = Some("ack-transport".into());
        let pending = query_request(&session.dispatch(acknowledgement));
        assert_eq!(pending["deadlineNs"], original_deadline.to_string());
        dispatch(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"ack-transport"}),
        );
        dispatch(
            &mut session,
            op::VIEW_QUERY_RESULT,
            fresh_query_result(&pending, &submission),
        );
        let state = query_state(&mut session);
        assert_eq!(state["successes"], 1);
        assert_eq!(state["errors"], 0);
    }
}

#[test]
fn dom_selector_origin_deadline_expires_once_while_waiting_or_pending() {
    for engine in engines() {
        for waiting in [false, true] {
            let (mut session, payload) = fixture_with_query_contract(engine, false, true);
            let submission = (!waiting).then(|| present_for_query(&mut session, &payload));
            let mut origin = if waiting {
                request(
                    op::PAGE_PUSH,
                    json!({"path":"pages/index/index","query":{"startupQuery":"yes"}}),
                )
            } else {
                query_envelope(json!([{"selector":"#tap"}]))
            };
            let deadline = now_ns() + 500_000_000;
            origin.deadline_ns = Some(deadline);
            let scheduled = session.dispatch(origin);
            let pending = (!waiting).then(|| query_request(&scheduled));
            std::thread::sleep(std::time::Duration::from_nanos(
                deadline.saturating_sub(now_ns()) + 1_000_000,
            ));
            session.poll_timers(now_ns());
            let state = query_state(&mut session);
            assert_eq!(
                state["error"], "ERR_TIMEOUT",
                "{engine:?}, waiting={waiting}"
            );
            assert_eq!(state["errors"], 1);
            assert_eq!(state["successes"], 0);
            if let (Some(pending), Some(submission)) = (pending, submission) {
                let late = session.dispatch(request(
                    op::VIEW_QUERY_RESULT,
                    fresh_query_result(&pending, &submission),
                ));
                assert_eq!(late.messages[0].payload["error"]["code"], "ERR_CANCELLED");
            } else {
                let submission = session.prepare_browser_view(&payload, 1).unwrap();
                let permit = session
                    .prepare_browser_commit(geometry(&submission))
                    .unwrap();
                let ack = session.acknowledge_browser_presentation(&permit).unwrap();
                assert!(!ack
                    .messages
                    .iter()
                    .any(|message| message.op == op::VIEW_QUERY_REQUEST));
            }
            assert_eq!(query_state(&mut session)["errors"], 1);
        }
    }
}

#[test]
fn dom_selector_pending_count_is_bounded_without_losing_accepted_requests() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_query_contract(engine, false, true);
        let submission = present_for_query(&mut session, &payload);
        let scheduled = session.dispatch(request(
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"queryMany","args":[33]}),
        ));
        let requests = scheduled
            .messages
            .iter()
            .filter(|message| message.op == op::VIEW_QUERY_REQUEST)
            .map(|message| message.payload.clone())
            .collect::<Vec<_>>();
        assert_eq!(requests.len(), 32);
        assert_eq!(query_state(&mut session)["error"], "ERR_RENDER");
        for (index, pending) in requests.into_iter().enumerate() {
            dispatch(
                &mut session,
                op::VIEW_QUERY_RESULT,
                query_result_at_epoch(&pending, &submission, index as u64 + 1),
            );
        }
        assert_eq!(query_state(&mut session)["result"][0]["left"], 41.0);
        assert_eq!(
            query_request(&schedule_query(&mut session, json!([{"selector":"#tap"}])))["requestId"],
            "dom-query:33"
        );
    }
}

#[test]
fn browser_document_is_evaluated_without_skia_and_ready_waits_for_final_ack() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        assert_eq!(inspect(&mut session)["readies"], 0);
        let document = session.prepare_browser_view(&payload, 1).unwrap();
        assert!(session.renderer().last_frame().is_none());
        assert_eq!(session.renderer().snapshot_revision(), 0);
        assert_eq!(document.document.profile, RendererProfile::WebView);
        assert!(!session.is_current_frame_presented());
        assert!(session.dispatch_browser_events(input(&document)).is_err());
        let permit = session.prepare_browser_commit(geometry(&document)).unwrap();
        assert_eq!(
            session.prepare_browser_commit(geometry(&document)).unwrap(),
            permit
        );
        assert_eq!(inspect(&mut session)["readies"], 0);
        assert!(session.acknowledge_presentation(1).is_err());
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(inspect(&mut session)["readies"], 1);
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(inspect(&mut session)["readies"], 1);
        assert!(session.is_current_frame_presented());
        assert!(session.renderer().last_frame().is_none());
        session.dispatch_browser_events(input(&document)).unwrap();
        let observed = inspect(&mut session);
        assert_eq!(
            observed["events"],
            json!([{"id":"parent","value":false},{"id":"tap","value":false}])
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            3
        );
        let unavailable = dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.canIUse","capability":"createSelectorQuery"}),
        );
        assert_eq!(unavailable["result"], false);
    }
}

#[test]
fn canvas_draws_preserve_browser_permits_geometry_and_ready_without_a_page_renderer(
) -> Result<(), Box<dyn std::error::Error>> {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        assert!(session.renderer_if_initialized().is_none());
        let document = session.prepare_browser_view(&payload, 1)?;
        let permit = session.prepare_browser_commit(geometry(&document))?;
        for presented in [false, true] {
            dispatch(
                &mut session,
                op::API_CALL,
                json!({
                    "name":"wx.canvas.draw", "canvasId":"independent", "width":1, "height":1,
                    "commands":[{"op":"setFillStyle","args":["red"]},{"op":"fillRect","args":[0,0,1,1]}],
                }),
            );
            let snapshot = session.canvas_snapshot("independent");
            assert_eq!(
                snapshot.as_ref().map(|frame| frame.pixels.as_slice()),
                Some([255, 0, 0, 255].as_slice())
            );
            assert!(session.renderer_if_initialized().is_none());
            assert_eq!(session.render_revision(), 0);
            assert_eq!(session.is_browser_view_presented(), presented);
            assert_eq!(
                inspect(&mut session)["readies"],
                if presented { 1 } else { 0 }
            );
            if !presented {
                assert!(session.is_browser_view_pending(&document.key));
                assert_eq!(session.prepare_browser_commit(geometry(&document))?, permit);
            } else {
                assert_eq!(session.browser_geometry(), Some(&geometry(&document)));
            }
            session.acknowledge_browser_presentation(&permit)?;
        }
        assert_eq!(inspect(&mut session)["readies"], 1);
        assert!(session.renderer_if_initialized().is_none());
    }
    Ok(())
}

#[test]
fn target_staging_preserves_browser_permits_and_geometry_without_a_page_renderer(
) -> Result<(), Box<dyn std::error::Error>> {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let document = session.prepare_browser_view(&payload, 1)?;
        let permit = session.prepare_browser_commit(geometry(&document))?;
        let viewport = container_render_skia::Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 667.0,
        };
        for presented in [false, true] {
            let target = session.validate_skia_render_target(viewport, 1.0)?;
            assert_eq!(target.width, 375);
            assert_eq!(session.stage_skia_render_target(viewport, 1.0)?, target);
            assert!(session
                .stage_skia_render_target(viewport, f64::NAN)
                .is_err());
            assert_eq!(session.repaint_current_skia_page(1.0)?, None);
            assert!(!session.has_current_skia_scene());
            assert!(session.renderer_if_initialized().is_none());
            assert_eq!(session.render_revision(), 0);
            assert_eq!(session.is_browser_view_presented(), presented);
            assert_eq!(
                inspect(&mut session)["readies"],
                if presented { 1 } else { 0 }
            );
            if presented {
                assert_eq!(session.browser_geometry(), Some(&geometry(&document)));
            } else {
                assert_eq!(session.prepare_browser_commit(geometry(&document))?, permit);
            }
            session.acknowledge_browser_presentation(&permit)?;
        }
        session.dispatch_browser_events(input(&document))?;
        assert_eq!(inspect(&mut session)["events"].as_array().unwrap().len(), 2);
        assert!(session.renderer_if_initialized().is_none());
    }
    Ok(())
}

#[test]
fn stale_forged_and_partial_browser_batches_cannot_publish_or_run_handlers() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let first = session.prepare_browser_view(&payload, 1).unwrap();
        let mut invalid = geometry(&first);
        invalid.nodes.pop();
        assert!(session.prepare_browser_commit(invalid).is_err());
        let old = session.prepare_browser_commit(geometry(&first)).unwrap();
        let second = session.prepare_browser_view(&payload, 2).unwrap();
        assert!(session.acknowledge_browser_presentation(&old).is_err());
        assert!(session.prepare_browser_view(&payload, 1).is_err());
        let current = session.prepare_browser_commit(geometry(&second)).unwrap();
        let mut forged = current.clone();
        forged.permit_id = "forged".into();
        assert!(session.acknowledge_browser_presentation(&forged).is_err());
        session.acknowledge_browser_presentation(&current).unwrap();
        let mut forged = input(&second);
        forged["events"][0]["handler"] = json!("forbidden");
        assert!(session.dispatch_browser_events(forged).is_err());
        let mut partial = input(&second);
        partial["events"]
            .as_array_mut()
            .unwrap()
            .push(json!({"type":"tap","targetOccurrenceId":"foreign","detail":{}}));
        assert!(session.dispatch_browser_events(partial).is_err());
        assert!(session.dispatch_browser_events(input(&first)).is_err());
        assert_eq!(inspect(&mut session)["events"], json!([]));
    }
}

#[test]
fn browser_geometry_updates_and_aborts_never_replay_ready_or_restore_mutable_state() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = session.prepare_browser_view(&payload, 0).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        let mut next = geometry(&submission);
        next.epoch = 1;
        next.nodes[0].border_box.y = -150.0;
        session.update_browser_geometry(next.clone()).unwrap();
        session.update_browser_geometry(next.clone()).unwrap();
        assert!(session
            .update_browser_geometry(geometry(&submission))
            .is_err());
        let mut bad = next.clone();
        bad.nodes[0].occurrence_id = "foreign".into();
        bad.epoch = 2;
        assert!(session.update_browser_geometry(bad).is_err());
        assert_eq!(session.browser_geometry(), Some(&next));
        assert!(session.dispatch_browser_events(input(&submission)).is_err());
        let pending = session.prepare_browser_view(&payload, 0).unwrap();
        session.abort_browser_view(&pending.key).unwrap();
        assert!(!session.is_current_frame_presented());
        assert_eq!(session.view_document(), Some(&submission.document));
        assert_eq!(inspect(&mut session)["readies"], 1);
        let retry = session.prepare_browser_view(&payload, 0).unwrap();
        let permit = session.prepare_browser_commit(geometry(&retry)).unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(inspect(&mut session)["readies"], 1);
        assert!(session.renderer().last_frame().is_none());
    }
}

#[test]
fn retired_browser_permits_cannot_revive_after_state_returns_to_same_page_and_size() {
    for engine in engines() {
        for acknowledged in [false, true] {
            for transition in ["resize", "layout", "manifest", "visibility", "navigation"] {
                let (mut session, mut payload) = fixture(engine);
                let old = session.prepare_browser_view(&payload, 1).unwrap();
                let permit = session.prepare_browser_commit(geometry(&old)).unwrap();
                if acknowledged {
                    session.acknowledge_browser_presentation(&permit).unwrap();
                }
                let readies = inspect(&mut session)["readies"].clone();
                match transition {
                    "resize" => {
                        session.notify_viewport_resize(480, 800).unwrap();
                        session.notify_viewport_resize(375, 667).unwrap();
                    }
                    "layout" => {
                        for edge in ["right", "left", "none"] {
                            session.notify_window_metrics(serde_json::from_value(json!({
                                "windowWidth":375,"windowHeight":667,"pixelRatio":2,"screenWidth":375,"screenHeight":667,
                                "statusBarHeight":0,"screenTop":0,"deviceOrientation":"portrait",
                                "hostLayout":{"version":1,"safeInsets":{"top":0,"right":40,"bottom":20,"left":0},
                                    "verticalBarEdge":edge,"reservedRegions":[]}
                            })).unwrap()).unwrap();
                        }
                    }
                    "manifest" => {
                        let original = session.manifest().clone();
                        let mut changed = original.clone();
                        let css = parse_wxss("view { color: red; }")
                            .unwrap()
                            .canonical_json()
                            .unwrap();
                        changed.styles[0].wxss_ir = format!("sha256:{}", hex_digest(&css));
                        changed.refresh_integrity().unwrap();
                        session.replace_manifest(changed).unwrap();
                        session.replace_manifest(original).unwrap();
                        // Manifest replacement also retires authorization of
                        // cached resource bytes. The fresh transaction must
                        // supply/reverify them even after restoring metadata.
                        let wxml = parse_wxml(FIXTURE_WXML).unwrap().canonical_json().unwrap();
                        let wxss = parse_wxss(FIXTURE_WXSS).unwrap().canonical_json().unwrap();
                        payload
                            .as_object_mut()
                            .unwrap()
                            .remove("useSessionResources");
                        payload["blobs"] = json!({
                            format!("sha256:{}", hex_digest(&wxml)):wxml,
                            format!("sha256:{}", hex_digest(&wxss)):wxss
                        });
                    }
                    "visibility" => {
                        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
                        assert!(session.prepare_browser_view(&payload, 2).is_err());
                        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
                    }
                    "navigation" => {
                        dispatch(
                            &mut session,
                            op::PAGE_PUSH,
                            json!({"path":"pages/index/index"}),
                        );
                        assert_ne!(
                            session.app_service().pages().current().unwrap().id.0,
                            old.key.page_id
                        );
                        dispatch(&mut session, op::PAGE_POP, json!({}));
                    }
                    _ => unreachable!(),
                }
                // A matching current PageId, viewport and manifest do not
                // resurrect an authorization retired during the intervening transition.
                assert_eq!(
                    session.app_service().pages().current().unwrap().id.0,
                    old.key.page_id
                );
                assert!(
                    !session.is_browser_view_presented(),
                    "{transition}, ACK={acknowledged}"
                );
                assert!(
                    session.acknowledge_browser_presentation(&permit).is_err(),
                    "{transition}, ACK={acknowledged}"
                );
                assert!(session.prepare_browser_commit(geometry(&old)).is_err());
                assert!(session.update_browser_geometry(geometry(&old)).is_err());
                assert!(session.dispatch_browser_events(input(&old)).is_err());
                assert_eq!(inspect(&mut session)["readies"], readies);
                assert_eq!(inspect(&mut session)["events"], json!([]));

                let fresh = session.prepare_browser_view(&payload, 1).unwrap();
                assert!(fresh.key.presentation_revision > old.key.presentation_revision);
                let permit = session.prepare_browser_commit(geometry(&fresh)).unwrap();
                session.acknowledge_browser_presentation(&permit).unwrap();
                assert!(session.is_browser_view_presented());
                assert_eq!(inspect(&mut session)["readies"], 1);
                assert!(session.renderer().last_frame().is_none());
            }
        }
    }
}

#[test]
fn explicit_legacy_render_frame_cannot_bypass_dom_presentation_or_ready() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        let frame = json!({
            "frameId":999,"viewport":{"x":0,"y":0,"width":375,"height":667},
            "root":{"id":"forged","bounds":{"x":0,"y":0,"width":375,"height":667},"opacity":1,"children":[]}
        });
        for explicit in [frame.clone(), json!({"frame":frame})] {
            let rejected = session.dispatch(request(op::RENDER_COMMIT, explicit));
            assert!(rejected.messages.iter().any(|message|
                message.payload["error"]["code"] == "ERR_UNSUPPORTED_CAPABILITY"
            ), "{rejected:?}");
            assert!(session.renderer().last_frame().is_none());
            assert_eq!(session.renderer().snapshot_revision(), 0);
            assert!(!session.is_browser_view_presented());
            assert!(session.acknowledge_presentation(999).is_err());
            assert_eq!(inspect(&mut session)["readies"], 0);
        }
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(inspect(&mut session)["readies"], 1);
        assert!(session.is_browser_view_presented());
    }
}

#[test]
fn route_specific_webview_profile_refreshes_real_js_capabilities_before_onload() {
    for engine in engines() {
        let (mut session, payload) = fixture_with_route_profile(engine, true);
        assert_eq!(session.config().renderer_override, None);
        assert_eq!(
            session.manifest().rendering.as_ref().unwrap().default,
            RendererProfile::Skia
        );
        assert_eq!(
            session.renderer_profile_for_route("pages/index/index"),
            RendererProfile::WebView
        );
        // The engine was initialized while the manifest default was Skia.
        // This value was captured inside onLoad, before any browser submission.
        assert_eq!(inspect(&mut session)["loadCapabilities"], json!([false]));
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        assert_eq!(submission.document.profile, RendererProfile::WebView);
        assert!(session.renderer().last_frame().is_none());
    }
}

fn touch(identifier: i64) -> Value {
    json!({"identifier":identifier,"x":1.25,"y":2.5,"clientX":3.75,"clientY":4.5,"pageX":5.25,"pageY":6.5})
}

fn touch_event(submission: &BrowserViewSubmission, event_type: &str) -> Value {
    json!({"type":event_type,"targetOccurrenceId":target(submission),
        "detail":{"timeStamp":"nested detail remains data","touches":"independent"},
        "timeStamp":123.75,"touches":[touch(7)],"changedTouches":[touch(7)]})
}

#[test]
fn browser_touch_facts_reach_real_handlers_at_top_level_and_keep_empty_end_contacts() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        let start = touch_event(&submission, "touchstart");
        let mut end = touch_event(&submission, "touchend");
        end["timeStamp"] = json!(125.5);
        end["touches"] = json!([]);
        let mut cancelled = touch_event(&submission, "touchcancel");
        cancelled["timeStamp"] = json!(126.25);
        cancelled["touches"] = json!([]);
        let mut batch = input(&submission);
        // A late native cancel cannot terminate an already-ended contact a
        // second time. A new down with that identifier owns a new gesture.
        batch["events"] = json!([start, end, cancelled, start, cancelled]);
        let response = session.dispatch_browser_events(batch).unwrap();
        assert!(
            !response
                .messages
                .iter()
                .any(|message| message.op == op::ERROR),
            "{response:?}"
        );
        let observed = inspect(&mut session);
        assert_eq!(
            observed["touchEvents"],
            json!([
                {"type":"touchstart","timeStamp":123.75,"touches":[touch(7)],"changedTouches":[touch(7)],"detail":start["detail"],"target":"tap","current":"tap"},
                {"type":"touchend","timeStamp":125.5,"touches":[],"changedTouches":[touch(7)],"detail":end["detail"],"target":"tap","current":"tap"},
                {"type":"touchstart","timeStamp":123.75,"touches":[touch(7)],"changedTouches":[touch(7)],"detail":start["detail"],"target":"tap","current":"tap"},
                {"type":"touchcancel","timeStamp":126.25,"touches":[],"changedTouches":[touch(7)],"detail":cancelled["detail"],"target":"tap","current":"tap"}
            ])
        );
    }
}

#[test]
fn invalid_touch_facts_and_authority_fields_reject_entire_batch_before_any_callback() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        let base = touch_event(&submission, "touchstart");
        let mut invalid = Vec::new();
        for list in ["touches", "changedTouches"] {
            let mut repeated = base.clone();
            repeated[list] = json!([touch(7), touch(7)]);
            invalid.push(repeated);
            for identifier in [9_007_199_254_740_992, -9_007_199_254_740_992] {
                let mut unsafe_id = base.clone();
                unsafe_id[list] = json!([touch(identifier)]);
                invalid.push(unsafe_id);
            }
            let mut forged_touch = base.clone();
            forged_touch[list][0]["ownerScopeId"] = json!("forged");
            invalid.push(forged_touch);
        }
        for (key, value) in [
            ("handler", json!("forbidden")),
            ("handlers", json!({"tap":"forbidden"})),
            ("ownerScopeId", json!("forged")),
            ("pageId", json!(999)),
            ("dataset", json!({"flag":"forged"})),
            ("path", json!(["forged", target(&submission)])),
            ("currentTarget", json!("forged")),
            ("dispatches", json!([])),
        ] {
            let mut forged = base.clone();
            forged[key] = value;
            invalid.push(forged);
        }
        for malformed in invalid {
            let mut batch = input(&submission);
            batch["events"]
                .as_array_mut()
                .unwrap()
                .push(malformed.clone());
            assert!(
                session.dispatch_browser_events(batch).is_err(),
                "accepted invalid event {malformed}"
            );
            // The first tap in every batch is valid and would mutate data and
            // log two listeners if prevalidation happened only incrementally.
            assert_eq!(
                session.app_service().pages().current().unwrap().data["count"],
                1
            );
            let observed = inspect(&mut session);
            assert_eq!(observed["events"], json!([]));
            assert_eq!(observed["touchEvents"], json!([]));
        }
    }
}

#[test]
fn browser_input_snapshot_is_captured_before_ack_and_never_refreshed_by_geometry() {
    for engine in engines() {
        let (mut session, mut payload) = fixture(engine);
        let consumed = session.view().template_revision;
        payload["frameId"] = json!(901);
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        let snapshot = session.browser_page_input(&submission.key).unwrap().clone();
        assert_eq!(snapshot.template_revision, consumed);
        assert_ne!(snapshot.template_revision, submission.document.revision);
        assert_eq!(snapshot.page_id.0, submission.key.page_id);
        assert_eq!(snapshot.route_path, "pages/index/index");
        assert_eq!(
            (snapshot.viewport.width, snapshot.viewport.height),
            (375.0, 667.0)
        );
        let mut forged = submission.key.clone();
        forged.document_revision += 1;
        assert!(session.browser_page_input(&forged).is_none());
        dispatch(
            &mut session,
            op::DATA_PATCH_BATCH,
            json!({"pageId":submission.key.page_id,"patches":[{"path":"count","op":"set","value":44}]}),
        );
        assert!(session.view().template_revision > consumed);
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert_eq!(session.browser_page_input(&submission.key), Some(&snapshot));
        let mut changed = geometry(&submission);
        changed.epoch = 1;
        changed.nodes[0].border_box.x += 5.0;
        session.update_browser_geometry(changed).unwrap();
        assert_eq!(session.browser_page_input(&submission.key), Some(&snapshot));

        let current = session.view().template_revision;
        let next = session.prepare_browser_view(&payload, 1).unwrap();
        assert!(session.browser_page_input(&submission.key).is_none());
        assert_eq!(
            session
                .browser_page_input(&next.key)
                .unwrap()
                .template_revision,
            current
        );
        session.abort_browser_view(&next.key).unwrap();
        assert!(session.browser_page_input(&next.key).is_none());
        let final_view = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session
            .prepare_browser_commit(geometry(&final_view))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(session.browser_page_input(&final_view.key).is_none());
    }
}

#[test]
fn explicit_render_data_cannot_claim_current_page_input_even_when_values_match() {
    for engine in engines() {
        let (mut session, mut payload) = fixture(engine);
        // Equality with the current data is deliberately insufficient evidence:
        // this is still an explicit rendering override, not the page snapshot.
        payload["data"] = session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        let submission = session.prepare_browser_view(&payload, 1).unwrap();
        assert!(session.browser_page_input(&submission.key).is_none());
        let permit = session
            .prepare_browser_commit(geometry(&submission))
            .unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        assert!(session.browser_page_input(&submission.key).is_none());
        payload["data"] = Value::Null;
        // Null cannot enter the View batch at all; it must not restore the
        // prior presentation or produce authoritative page provenance.
        assert!(session.prepare_browser_view(&payload, 1).is_err());
        assert!(session.browser_page_input(&submission.key).is_none());
        assert!(!session.is_browser_view_presented());
    }
}

#[test]
fn bridge_prepare_reports_the_exact_consumed_input_before_final_ack() {
    for engine in engines() {
        let (mut session, mut payload) = fixture(engine);
        let consumed = session.view().template_revision;
        payload["frameId"] = json!(901);
        payload["viewport"] = json!({"x":12.5,"y":-7.25,"width":375.1,"height":667.2});
        let prepared = dispatch(
            &mut session,
            op::VIEW_PREPARE,
            json!({"version":"1.0","surfaceGeneration":"1","render":payload}),
        );
        let submission: BrowserViewSubmission =
            serde_json::from_value(prepared["submission"].clone()).unwrap();
        let scheduling = prepared["scheduling"].clone();
        assert_eq!(scheduling["version"], "1.0");
        assert_eq!(scheduling["key"], prepared["submission"]["key"]);
        let input = &scheduling["consumedInput"];
        assert_eq!(input["pageId"], submission.key.page_id.to_string());
        assert_eq!(input["routePath"], submission.document.route_path);
        assert_eq!(input["templateRevision"], consumed.to_string());
        assert_ne!(
            input["templateRevision"],
            submission.key.document_revision.to_string()
        );
        // Rect allows nonzero origin; preserve it, and serialize f32 dimensions
        // through f64 exactly as the actual submission viewport does.
        assert_eq!(input["viewport"]["x"], 12.5);
        assert_eq!(input["viewport"]["y"], -7.25);
        assert_eq!(
            input["viewport"]["width"],
            prepared["submission"]["viewport"]["width"]
        );
        assert_eq!(
            input["viewport"]["height"],
            prepared["submission"]["viewport"]["height"]
        );
        assert_eq!(input["viewport"]["width"], json!(f64::from(375.1_f32)));
        assert_eq!(inspect(&mut session)["readies"], 0);
        dispatch(
            &mut session,
            op::DATA_PATCH_BATCH,
            json!({"pageId":submission.key.page_id,"patches":[{"path":"count","op":"set","value":44}]}),
        );
        assert!(session.view().template_revision > consumed);
        let committed = dispatch(
            &mut session,
            op::VIEW_PREPARE_COMMIT,
            serde_json::to_value(geometry(&submission)).unwrap(),
        );
        assert!(committed.get("scheduling").is_none());
        let acknowledged = dispatch(
            &mut session,
            op::VIEW_PRESENTED,
            committed["permit"].clone(),
        );
        assert!(acknowledged.get("scheduling").is_none());
        assert_eq!(
            scheduling["consumedInput"]["templateRevision"],
            consumed.to_string()
        );
        assert_eq!(
            session
                .browser_page_input(&submission.key)
                .unwrap()
                .template_revision,
            consumed
        );
    }
}

#[test]
fn bridge_explicit_data_has_no_authoritative_consumed_input() {
    for engine in engines() {
        let (mut session, mut payload) = fixture(engine);
        payload["data"] = session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        let prepared = dispatch(
            &mut session,
            op::VIEW_PREPARE,
            json!({"version":"1.0","surfaceGeneration":"1","render":payload}),
        );
        assert_eq!(prepared["scheduling"]["key"], prepared["submission"]["key"]);
        assert!(prepared["scheduling"]["consumedInput"].is_null());
        let submission: BrowserViewSubmission =
            serde_json::from_value(prepared["submission"].clone()).unwrap();
        assert!(session.browser_page_input(&submission.key).is_none());
    }
}

#[test]
fn a_failed_bridge_prepare_never_exposes_scheduling_success() {
    for engine in engines() {
        let (mut session, payload) = fixture(engine);
        let accepted = session.prepare_browser_view(&payload, 1).unwrap();
        let permit = session.prepare_browser_commit(geometry(&accepted)).unwrap();
        session.acknowledge_browser_presentation(&permit).unwrap();
        let input = session.browser_page_input(&accepted.key).unwrap().clone();
        for dimension in ["width", "height"] {
            let mut invalid = payload.clone();
            invalid["viewport"][dimension] = json!(0);
            let batch = session.dispatch(request(
                op::VIEW_PREPARE,
                json!({"version":"1.0","surfaceGeneration":"2","render":invalid}),
            ));
            assert!(batch
                .messages
                .iter()
                .any(|message| message.payload["ok"] == false));
            assert!(batch
                .messages
                .iter()
                .all(|message| message.payload.get("scheduling").is_none()));
            assert!(session.is_browser_view_presented());
            assert_eq!(session.browser_page_input(&accepted.key), Some(&input));
        }
        assert_eq!(inspect(&mut session)["readies"], 1);
    }
}

fn live_request(id: &str, operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request("session-1", id, operation, payload)
}
fn live_ok(session: &mut Session, id: &str, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(live_request(id, operation, payload));
    let response = batch
        .messages
        .iter()
        .find(|message| message.request_id == id && message.op == operation)
        .expect("correlated live final");
    assert_eq!(response.payload["ok"], true, "{batch:?}");
    response.payload.clone()
}
fn live_prepare(session: &mut Session, id: &str, render: Value) -> BrowserLiveViewSubmission {
    let lifetime = session.input_lifetime_revision().unwrap().to_string();
    let response = live_ok(
        session,
        id,
        op::VIEW_LIVE_PREPARE,
        json!({"version":"2.0","inputLifetimeRevision":lifetime,"surfaceGeneration":"1","render":render}),
    );
    serde_json::from_value(response["submission"].clone()).unwrap()
}
fn live_permit(session: &mut Session, id: &str, submission: &BrowserLiveViewSubmission) -> Value {
    live_ok(session,id,op::VIEW_LIVE_PERMIT,json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,"key":submission.key,"baseKey":submission.base_key,"documentToken":submission.document_token}))["permit"].clone()
}
fn live_geometry(submission: &BrowserLiveViewSubmission) -> BrowserGeometryBatch {
    geometry(&BrowserViewSubmission {
        version: "1.0".into(),
        key: submission.key.clone(),
        viewport: submission.viewport,
        document: submission.document.clone(),
        animation: None,
    })
}
fn enable_live(session: &mut Session) {
    let result = live_ok(
        session,
        "enable-v2",
        op::VIEW_LIVE_ENABLE,
        json!({"version":"2.0"}),
    );
    assert_eq!(result["contract"]["nativeEditing"], false);
    assert_eq!(result["contract"]["finalReplay"], true);
}

fn present_live_for_input(session: &mut Session, render: Value) -> BrowserViewSubmission {
    enable_live(session);
    let submission = live_prepare(session, "receiver-prepare", render);
    let permit = live_permit(session, "receiver-permit", &submission);
    live_ok(
        session,
        "receiver-presented",
        op::VIEW_LIVE_PRESENTED,
        json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,
            "permit":permit,"geometry":live_geometry(&submission)}),
    );
    BrowserViewSubmission {
        version: "1.0".into(),
        key: submission.key,
        viewport: submission.viewport,
        document: submission.document,
        animation: None,
    }
}

#[test]
fn live_input_uses_retained_dispatcher_and_preserves_normal_callback_updates() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            FIXTURE_WXML,
            "App({events:[],jobs:0,forbidden:0});",
            r#"Page({data:{count:0},onTap(e){
                getApp().events.push({id:e.currentTarget.id,jobs:getApp().jobs});
                this.setData({count:this.data.count+1});
                Promise.resolve().then(()=>{getApp().jobs++});
            }});
            exports.overwrite=()=>{globalThis.__container_invoke_page_event=()=>{getApp().forbidden++;return []};return true};
            exports.inspect=()=>({events:getApp().events,jobs:getApp().jobs,forbidden:getApp().forbidden,count:getCurrentPages()[0].data.count});"#,
        );
        let submission = present_live_for_input(&mut session, render);
        dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"overwrite","args":[]}),
        );
        let result = session.dispatch_browser_events(input(&submission)).unwrap();
        assert!(
            result
                .messages
                .iter()
                .all(|message| message.payload["ok"] != false),
            "{engine:?}: {result:?}"
        );
        assert_eq!(
            inspect(&mut session),
            json!({"events":[{"id":"parent","jobs":0},{"id":"tap","jobs":0}],"jobs":2,"forbidden":0,"count":2}),
            "{engine:?} callbacks share a task and normal setData keeps the receiver",
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            2
        );
    }
}

#[test]
fn live_input_stops_at_retired_receiver_and_keeps_prior_callback_effects() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            FIXTURE_WXML,
            "App({events:[]});",
            r#"Page({data:{count:0},onTap(e){
                getApp().events.push(e.currentTarget.id);
                this.setData({count:this.data.count+1});
                if(e.currentTarget.id==='parent') __container_invoke_page_instance(1,0,'onUnload',[]);
            }});
            exports.inspect=()=>({events:getApp().events});"#,
        );
        let submission = present_live_for_input(&mut session, render);
        let result = session.dispatch_browser_events(input(&submission)).unwrap();
        assert!(
            result
                .messages
                .iter()
                .any(|message| message.payload["error"]["code"] == "ERR_CANCELLED"),
            "{engine:?}: {result:?}"
        );
        assert_eq!(
            inspect(&mut session)["events"],
            json!(["parent"]),
            "{engine:?}"
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            1,
            "{engine:?} completed setData remains authoritative"
        );
        assert!(!session.is_browser_view_presented(), "{engine:?}");
    }
}

#[test]
fn live_input_rejects_an_old_page_incarnation_before_the_first_callback() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            FIXTURE_WXML,
            "App({events:[]});",
            r#"Page({data:{count:0},onTap(e){getApp().events.push(e.currentTarget.id)}});
            exports.recreate=()=>{
                __container_invoke_page_instance(1,0,'onUnload',[]);
                delete __container_page_instances['1'];
                __container_set_current_pages([0],[{index:0,instanceId:1}]);
                return true;
            };
            exports.inspect=()=>({events:getApp().events});"#,
        );
        let submission = present_live_for_input(&mut session, render);
        dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"recreate","args":[]}),
        );
        let result = session.dispatch_browser_events(input(&submission)).unwrap();
        assert!(
            result
                .messages
                .iter()
                .any(|message| message.payload["error"]["code"] == "ERR_CANCELLED"),
            "{engine:?}: {result:?}"
        );
        assert_eq!(inspect(&mut session)["events"], json!([]), "{engine:?}");
        assert!(!session.is_browser_view_presented(), "{engine:?}");
    }
}

#[test]
fn live_input_retires_authority_after_a_microtask_destroys_the_receiver() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            "<view id=\"tap\" bindtap=\"onTap\"/>",
            "App({events:[]});",
            r#"Page({data:{count:0},onTap(){
                getApp().events.push('callback');
                Promise.resolve().then(()=>{
                    getApp().events.push('job');
                    this.setData({count:1});
                    __container_invoke_page_instance(1,0,'onUnload',[]);
                });
            }});
            exports.inspect=()=>({events:getApp().events});"#,
        );
        let submission = present_live_for_input(&mut session, render);
        let result = session.dispatch_browser_events(input(&submission)).unwrap();
        assert!(
            result
                .messages
                .iter()
                .any(|message| message.payload["error"]["code"] == "ERR_CANCELLED"),
            "{engine:?}: {result:?}"
        );
        assert_eq!(
            inspect(&mut session)["events"],
            json!(["callback", "job"]),
            "{engine:?}"
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            1
        );
        assert!(!session.is_browser_view_presented(), "{engine:?}");
    }
}

#[test]
fn live_touch_cancellation_cannot_retarget_a_recreated_page_receiver() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            FIXTURE_WXML,
            "App({events:[]});",
            r#"Page({data:{count:0},onTouch(e){getApp().events.push(e.type)}});
            exports.recreate=()=>{
                __container_invoke_page_instance(1,0,'onUnload',[]);
                delete __container_page_instances['1'];
                __container_set_current_pages([0],[{index:0,instanceId:1}]);
                return true;
            };
            exports.inspect=()=>({events:getApp().events});"#,
        );
        let submission = present_live_for_input(&mut session, render);
        let touch = json!({"identifier":7,"x":1,"y":2,"clientX":1,"clientY":2,"pageX":1,"pageY":2});
        let events = json!({"version":"1.0","key":submission.key,"epoch":"0","events":[
            {"type":"touchstart","targetOccurrenceId":target(&submission),"detail":{},"touches":[touch.clone()],"changedTouches":[touch]}
        ]});
        session.dispatch_browser_events(events).unwrap();
        dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"recreate","args":[]}),
        );
        let retired = session.retire_browser_preview("test-retirement").unwrap();
        assert!(
            retired
                .messages
                .iter()
                .any(|message| message.op == "view.contacts.retired"
                    && message.payload["delivered"] == false),
            "{engine:?}: {retired:?}"
        );
        assert_eq!(
            inspect(&mut session)["events"],
            json!(["touchstart"]),
            "{engine:?}"
        );
        assert!(!session.is_browser_view_presented());
    }
}
#[test]
fn live_document_permits_without_geometry_and_accepts_complete_live_geometry_atomically() {
    for engine in engines() {
        let (mut session, render) = fixture(engine);
        enable_live(&mut session);
        assert!(
            session.prepare_browser_view(&render, 1).is_err(),
            "explicit v2 cannot silently downgrade"
        );
        let submission = live_prepare(&mut session, "live-first", render);
        assert!(!session.is_browser_view_presented());
        assert!(!submission.runtime_identities.is_empty());
        let legacy_abort = session.dispatch(live_request(
            "legacy-abort-cannot-cancel-live",
            op::VIEW_ABORT,
            json!(submission.key),
        ));
        assert_eq!(legacy_abort.messages[0].payload["ok"], false);
        let mut missing_base = json!(submission);
        missing_base.as_object_mut().unwrap().remove("baseKey");
        assert!(serde_json::from_value::<BrowserLiveViewSubmission>(missing_base).is_err());
        let invalid_permit = session.dispatch(live_request(
            "missing-base-permit",
            op::VIEW_LIVE_PERMIT,
            json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,"key":submission.key,"documentToken":submission.document_token}),
        ));
        assert_eq!(invalid_permit.messages[0].payload["ok"], false);
        let permit = live_permit(&mut session, "document-permit", &submission);
        assert_eq!(permit["version"], "2.0");
        assert!(permit.get("epoch").is_none());
        let mut missing_base = permit.clone();
        missing_base.as_object_mut().unwrap().remove("baseKey");
        assert!(
            serde_json::from_value::<container_runtime::BrowserDocumentPermit>(missing_base)
                .is_err()
        );
        let mut invalid = live_geometry(&submission);
        invalid.nodes.pop();
        let bad=session.dispatch(live_request("bad-live-geometry",op::VIEW_LIVE_PRESENTED,json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,"permit":permit,"geometry":invalid})));
        assert_eq!(bad.messages[0].payload["ok"], false);
        assert!(!session.is_browser_view_presented());
        assert_eq!(inspect(&mut session)["readies"], 0);
        let wire = live_request(
            "live-final",
            op::VIEW_LIVE_PRESENTED,
            json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,"permit":permit,"geometry":live_geometry(&submission)}),
        );
        let first = session.dispatch(wire.clone());
        assert_eq!(first.messages[0].payload["ok"], true);
        assert_eq!(first.messages[0].payload["committed"], true);
        assert!(session.is_browser_view_presented());
        assert_eq!(inspect(&mut session)["readies"], 1);
        let replay = session.dispatch(wire);
        assert_eq!(
            serde_json::to_value(&first).unwrap(),
            serde_json::to_value(&replay).unwrap(),
            "replay preserves the complete original outer final"
        );
        assert_eq!(inspect(&mut session)["readies"], 1);
        let wrong = session.dispatch(live_request(
            "v1-cannot-publish-v2",
            op::VIEW_PRESENTED,
            permit,
        ));
        assert_eq!(wrong.messages[0].payload["ok"], false);
        assert!(session.is_browser_view_presented());
    }
}

#[test]
fn live_oversized_final_reports_actual_result_and_retry_never_reexecutes() {
    for engine in engines() {
        let source = format!("<view><text>{}</text></view>", "x".repeat(600_000));
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            &source,
            "App({});",
            "Page({data:{}});",
        );
        enable_live(&mut session);
        let lifetime = session.input_lifetime_revision().unwrap().to_string();
        let wire = live_request(
            "oversized-prepare-final",
            op::VIEW_LIVE_PREPARE,
            json!({"version":"2.0","inputLifetimeRevision":lifetime,"surfaceGeneration":"1","render":render}),
        );
        let first = session.dispatch(wire.clone());
        let response = first
            .messages
            .iter()
            .find(|message| message.request_id == wire.request_id && message.op == wire.op)
            .unwrap();
        assert_eq!(response.payload["ok"], false, "{response:?}");
        assert_eq!(response.payload["error"]["code"], "ERR_RENDER");
        let original = &response.payload["originalResult"];
        assert_eq!(
            original["ok"], true,
            "the prepare actually executed before its final exceeded retention"
        );
        let submission: BrowserLiveViewSubmission =
            serde_json::from_value(original["submission"].clone()).unwrap();
        let replay = session.dispatch(wire);
        assert_eq!(replay.messages[0].payload["ok"], false);
        assert_eq!(replay.messages[0].payload["error"]["code"], "ERR_RENDER");
        assert!(
            replay.messages[0].payload.get("originalResult").is_none(),
            "indeterminate requests cannot execute or manufacture a replay"
        );
        // Retention failure is not a rollback: the original candidate still
        // exists and only its exact runtime-issued identity may retire it.
        live_ok(
            &mut session,
            "abort-oversized",
            op::VIEW_LIVE_ABORT,
            json!({"version":"2.0","inputLifetimeRevision":submission.input_lifetime_revision,"key":submission.key,"documentToken":submission.document_token}),
        );
        assert!(!session.is_browser_view_presented());
    }
}
#[test]
fn live_preparation_replay_cannot_repeat_evaluation_or_overwrite_a_pending_transaction() {
    for engine in engines() {
        let (mut session, render) = fixture(engine);
        enable_live(&mut session);
        let lifetime = session.input_lifetime_revision().unwrap().to_string();
        let wire = live_request(
            "prepare-once",
            op::VIEW_LIVE_PREPARE,
            json!({"version":"2.0","inputLifetimeRevision":lifetime,"surfaceGeneration":"1","render":render}),
        );
        let first = session.dispatch(wire.clone());
        assert_eq!(first.messages[0].payload["ok"], true);
        let replay = session.dispatch(wire.clone());
        assert_eq!(
            serde_json::to_value(first).unwrap(),
            serde_json::to_value(replay).unwrap()
        );
        let mut changed = wire.clone();
        changed.payload["render"]["viewport"]["width"] = json!(414);
        let conflict = session.dispatch(changed);
        assert_eq!(conflict.messages[0].payload["ok"], false);
        let mut successor = wire.clone();
        successor.request_id = "prepare-conflicting-successor".into();
        let conflict = session.dispatch(successor);
        assert_eq!(conflict.messages[0].payload["ok"], false);
        let mut batch = container_bridge::BridgeBatch::new(vec![wire]);
        batch.messages.push(request(
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"inspect","args":[]}),
        ));
        let refused = session.dispatch_batch(batch);
        assert_eq!(refused.messages.len(), 2);
        assert!(refused
            .messages
            .iter()
            .all(|message| message.payload["ok"] == false));
    }
}
#[test]
fn runtime_live_binding_identity_is_stable_for_data_and_never_revives_after_type_a_b_a() {
    for engine in engines() {
        let (mut session, render) = fixture_with_browser_sources(
            engine,
            false,
            false,
            "<view><input id=\"editor\" type=\"{{kind}}\"/><text>{{label}}</text></view>",
            "App({});",
            "Page({data:{kind:'text',label:'a'}});",
        );
        enable_live(&mut session);
        let first = live_prepare(&mut session, "binding-a", render.clone());
        let abort = |session: &mut Session, id: &str, s: &BrowserLiveViewSubmission| {
            live_ok(
                session,
                id,
                op::VIEW_LIVE_ABORT,
                json!({"version":"2.0","inputLifetimeRevision":s.input_lifetime_revision,"key":s.key,"documentToken":s.document_token}),
            );
        };
        abort(&mut session, "abort-a", &first);
        let patch = |session: &mut Session, path: &str, value: Value| {
            dispatch(
                session,
                op::DATA_PATCH_BATCH,
                json!({"pageId":1,"patches":[{"op":"set","path":path,"value":value}]}),
            );
        };
        patch(&mut session, "label", json!("b"));
        let same = live_prepare(&mut session, "binding-same", render.clone());
        assert_eq!(first.runtime_identities, same.runtime_identities);
        abort(&mut session, "abort-same", &same);
        patch(&mut session, "kind", json!("number"));
        let second = live_prepare(&mut session, "binding-b", render.clone());
        assert_ne!(first.runtime_identities, second.runtime_identities);
        abort(&mut session, "abort-b", &second);
        patch(&mut session, "kind", json!("text"));
        let again = live_prepare(&mut session, "binding-a-again", render);
        assert_ne!(
            first.runtime_identities, again.runtime_identities,
            "returning declaration is a new binding, even for the same native Page object"
        );
    }
}
#[test]
fn live_operations_require_negotiation_and_old_lifetime_requests_cannot_be_relabelled() {
    for engine in engines() {
        let (mut session, render) = fixture(engine);
        let invalid=session.dispatch(live_request("unnegotiated",op::VIEW_LIVE_PREPARE,json!({"version":"2.0","inputLifetimeRevision":"0","surfaceGeneration":"1","render":render})));
        assert_eq!(invalid.messages[0].payload["ok"], false);
        enable_live(&mut session);
        let s = live_prepare(&mut session, "before-hide", render);
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_ne!(
            session.input_lifetime_revision().unwrap().to_string(),
            s.input_lifetime_revision
        );
        let old=session.dispatch(live_request("old-permit",op::VIEW_LIVE_PERMIT,json!({"version":"2.0","inputLifetimeRevision":s.input_lifetime_revision,"key":s.key,"baseKey":s.base_key,"documentToken":s.document_token})));
        assert_eq!(old.messages[0].payload["error"]["code"], "ERR_CANCELLED");
        assert!(!session.is_browser_view_presented());
    }
}
