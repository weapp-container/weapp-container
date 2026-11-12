use super::*;
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::PageRenderMode;
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({trace:[],errors:[],settlements:[]});
globalThis.measure=function(receiver,label,scoped){
  const q=wx.createSelectorQuery();
  if(scoped) q.in(receiver);
  q.select('#target').boundingClientRect(value=>getApp().trace.push({
    label:label,width:value.width,owner:__container_capture_api_owner()===receiver}));
  q.exec().catch(error=>getApp().errors.push({label:label,code:error.code}));
};
function page(){return getCurrentPages()[0];}
exports.page=()=>{page().measure();return true;};
exports.component=()=>{page().selectComponent('#panel').measure();return true;};
exports.timers=()=>{page().timers();return true;};
exports.inspect=()=>({trace:getApp().trace,errors:getApp().errors});
exports.startTicks=()=>{getApp().ticks=0;setInterval(()=>getApp().ticks++,1);return true;};
exports.inspectTicks=()=>getApp().ticks;
exports.dropComponent=()=>{page().setData({show:false});return true;};
exports.restoreComponent=()=>{page().setData({show:true});return true;};
function rawMeasure(label,query){
  __container_api_call('wx.createSelectorQuery', {queries:[query],cancelToken:'native-order-'+label})
    .then(values=>{getApp().settlements.push(label+'.ok');getApp().trace.push({label:label,width:values[0].width});},
          error=>{getApp().settlements.push(label+'.'+error.code);getApp().errors.push({label:label,code:error.code});});
}
function order(scopeKey){
  const scope=scopeKey ? page().selectComponent('#panel').__container_scope_id : null;
  ['A','B','C'].forEach(label=>{
    const query={selector:'#target',operation:'boundingClientRect'};
    if(label==='B' && scopeKey) query[scopeKey]=scope;
    rawMeasure(label,query);
  });
  return true;
}
exports.order=()=>order(null);
exports.later=()=>{rawMeasure('later',{selector:'#target'});return true;};
exports.inspectSettlements=()=>({values:getApp().settlements});
exports.orderScope=()=>order('scopeId');
exports.orderSnake=()=>order('scope_id');
exports.panelScope=()=>page().selectComponent('#panel').__container_scope_id;
exports.aliasPrecedence=()=>{
  const scope=page().selectComponent('#panel').__container_scope_id;
  rawMeasure('camel-null',{selector:'#target',scopeId:null,scope_id:scope});
  rawMeasure('camel-scope',{selector:'#target',scopeId:scope,scope_id:'missing-snake-scope'});
  rawMeasure('camel-invalid',{selector:'#target',scopeId:12,scope_id:scope});
  return true;
};
exports.changeWidth=()=>{page().setData({width:119});return true;};
exports.queryThenWrite=()=>{const receiver=page(); const q=wx.createSelectorQuery().in(receiver); q.select('#target').boundingClientRect(value=>{getApp().trace.push({label:'write-after-query',width:value.width}); receiver.setData({width:151});});q.exec().catch(error=>getApp().errors.push({label:'write-after-query',code:error.code}));return true;};
exports.cancelQuery=()=>{__container_api_call('wx.createSelectorQuery', {queries:[{selector:'#target',operation:'boundingClientRect'}],cancelToken:'native-cancel'}).then(()=>getApp().trace.push({label:'cancel'}),error=>getApp().errors.push({label:'cancel',code:error.code}));return true;};
"#;
const PAGE: &str = r#"
Page({data:{show:true,width:240},measure(){measure(this,'page',true);},timers(){
  setTimeout(()=>measure(this,'timer-page',true),0);
  setTimeout(()=>measure(this,'timer-unscoped',false),0);
}});
"#;
const COMPONENT: &str = r#"
Component({methods:{measure(){measure(this,'component',true);}}});
"#;

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

fn raw_call(session: &mut Session, export: &str) -> container_bridge::BridgeBatch {
    session.dispatch(BridgeEnvelope::request(
        "session-1",
        export,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    ))
}

fn has_cancelled_diagnostic(batch: &container_bridge::BridgeBatch) -> bool {
    batch.messages.iter().any(|message| {
        message.op == op::ERROR
            && message.payload["errors"]
                .as_array()
                .is_some_and(|errors| errors.iter().any(|error| error["code"] == "ERR_CANCELLED"))
    })
}

fn call(session: &mut Session, export: &str) -> Value {
    success(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    )["result"][0]
        .clone()
}

fn fixture(engine: EngineKind) -> Session {
    fixture_sources(
        engine,
        APP,
        PAGE,
        r#"<view id="target" style="width:{{width}}px;height:30px"/><panel wx:if="{{show}}" id="panel"/>"#,
    )
}

fn fixture_sources(
    engine: EngineKind,
    app_source: &str,
    page_source: &str,
    page_wxml: &str,
) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "native-selector-live-owner-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "module:app.js".into();
    manifest.routes.push(Route {
        id: format!("route:{ROUTE}"),
        path: ROUTE.into(),
        kind: RouteKind::Page,
        config: None,
        entry_module: format!("module:{ROUTE}.js"),
    });
    manifest.components.push(Component {
        id: format!("components:{ROUTE}.json"),
        owner: format!("{ROUTE}.json"),
        using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
        multiple_slots: None,
    });
    let mut modules = Vec::new();
    for (id, source, scope) in [
        ("module:app.js", app_source, ModuleScope::App),
        (
            "module:pages/index/index.js",
            page_source,
            ModuleScope::Page,
        ),
        (
            "module:components/panel/index.js",
            COMPONENT,
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
    let mut blobs = BTreeMap::new();
    for (id, source) in [
        ("template:pages/index/index.wxml", page_wxml),
        (
            "template:components/panel/index.wxml",
            r#"<view id="target" style="width:87px;height:30px"/>"#,
        ),
    ] {
        let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        manifest.templates.push(Template {
            id: id.into(),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: BTreeMap::new(),
        });
        blobs.insert(pointer, bytes);
    }
    for name in [
        "wx.createSelectorQuery",
        "getCurrentPages",
        "Page.selectComponent",
        "setTimeout",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        page_render_mode: PageRenderMode::ExternalFrame,
        // Query ownership and cancellation are semantic contracts. The
        // default-policy and deadline tests cover the separate 50 ms limit.
        view_execution: ViewExecutionPolicy {
            batch_timeout_ms: 2_000,
        },
        ..Default::default()
    };
    config.host.window_width = 320;
    config.host.window_height = 480;
    let mut session = Session::new(manifest, config).unwrap();
    success(
        &mut session,
        op::APP_INIT,
        json!({"modules":modules,"blobs":blobs}),
    );
    success(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
    success(
        &mut session,
        op::RENDER_COMMIT,
        json!({
            "templateId":"template:pages/index/index.wxml","useSessionResources":true,
            "viewport":{"width":320,"height":480}
        }),
    );
    session
        .acknowledge_presentation(session.render_revision())
        .unwrap();
    assert!(session.is_current_frame_presented());
    session
}

fn render(session: &mut Session) {
    success(
        session,
        op::RENDER_COMMIT,
        json!({
            "templateId":"template:pages/index/index.wxml","useSessionResources":true,
            "viewport":{"width":320,"height":480}
        }),
    );
}

fn trace(session: &mut Session) -> Value {
    call(session, "inspect")
}

#[test]
fn native_query_waits_through_same_page_observations_and_completes_once_on_ack() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "page");
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
        assert_eq!(session.native_queries.waiting.len(), 1);
        let original_deadline = session.native_queries.waiting[0].limits.deadline_ns;
        // A duplicate/same-size native observation changes coordinate input
        // lifetime; it must not become page disposal for a waiting query.
        session
            .retire_page_presenter("native-layout-reobserved")
            .unwrap();
        assert_eq!(session.native_queries.waiting.len(), 1);
        assert_eq!(
            session.native_queries.waiting[0].limits.deadline_ns,
            original_deadline
        );
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
        // Retiring a native surface also retires consumed-frame provenance.
        // A retained old ACK alone cannot satisfy the waiting request.
        let _ = session.acknowledge_presentation(session.render_revision());
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"page","width":240,"owner":true}],"errors":[]
            })
        );
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 1);
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_waiting_query_does_not_stop_business_timers_or_invent_presentation() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "startTicks");
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "page");
        let batch = session.poll_timers(u64::MAX);
        assert!(
            batch.messages.iter().all(|m| m.op != op::ERROR),
            "{batch:?}"
        );
        assert_eq!(call(&mut session, "inspectTicks"), json!(1));
        assert!(!session.is_current_frame_presented());
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
    }
}

#[test]
fn native_query_original_deadline_is_not_extended_by_layout_wait_or_retry() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "page");
        let deadline = session.native_queries.waiting[0].limits.deadline_ns;
        session
            .retire_page_presenter("another-observation")
            .unwrap();
        assert_eq!(
            session.native_queries.waiting[0].limits.deadline_ns,
            deadline
        );
        session.drain_native_query_completions_at(deadline).unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[],"errors":[{"label":"page","code":"ERR_TIMEOUT"}]
            })
        );
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(trace(&mut session)["trace"], json!([]));
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_waiting_query_observes_original_cancel_and_background_fences() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "cancelQuery");
        success(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"native-cancel"}),
        );
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[],"errors":[{"label":"cancel","code":"ERR_CANCELLED"}]
            })
        );
        call(&mut session, "page");
        success(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_eq!(trace(&mut session)["errors"][1]["code"], "ERR_CANCELLED");
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_waiting_query_rejects_detached_component_incarnation_before_reuse() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "component");
        call(&mut session, "dropComponent");
        render(&mut session);
        let cancelled = raw_call(&mut session, "restoreComponent");
        assert!(has_cancelled_diagnostic(&cancelled), "{cancelled:?}");
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[],"errors":[{"label":"component","code":"ERR_CANCELLED"}]
            })
        );
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_waiting_query_profile_change_and_view_fault_are_terminal() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "page");
        session.config.renderer_override = Some(container_ir::RendererProfile::WebView);
        let cancelled = raw_call(&mut session, "inspect");
        assert!(has_cancelled_diagnostic(&cancelled), "{cancelled:?}");
        assert!(session.native_queries.waiting.is_empty());
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[],"errors":[{"label":"page","code":"ERR_CANCELLED"}]
            })
        );
        assert_eq!(session.native_queries.bytes, 0);

        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        call(&mut session, "page");
        session.view_execution.borrow_mut().inject_fault_for_test(
            container_core::ViewEngineError::new(
                container_core::ViewEngineErrorCode::Timeout,
                "injected View fault",
            ),
        );
        assert!(session.retire_faulted_view_authority());
        assert!(session.native_queries.waiting.is_empty());
        assert_eq!(session.native_queries.completions.len(), 1);
        session.drain_native_query_completions().unwrap();
        assert_eq!(trace(&mut session)["trace"], json!([]));
        assert_eq!(trace(&mut session)["errors"][0]["code"], "ERR_CANCELLED");
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_pending_queue_budgets_are_explicit_and_direct_bridge_stays_synchronous() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .retire_page_presenter("native-layout-observed")
            .unwrap();
        let query = json!({"queries":[{"selector":"#target","operation":"boundingClientRect"}]});
        let options = query.as_object().unwrap();
        for id in 1..=256 {
            session.enqueue_native_query(id, None, options).unwrap();
        }
        assert_eq!(
            session
                .enqueue_native_query(257, None, options)
                .unwrap_err()
                .code,
            BridgeErrorCode::Render
        );
        let oversized =
            json!({"queries":[{"selector":"#target"}],"padding":"x".repeat(MAX_REQUEST_BYTES)});
        assert_eq!(
            session
                .enqueue_native_query(258, None, oversized.as_object().unwrap())
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
        assert_eq!(session.native_queries.waiting.len(), 256);
        let batch = session.dispatch(BridgeEnvelope::request(
            "session-1",
            "direct",
            op::API_CALL,
            json!({"name":"wx.createSelectorQuery","selector":"#target"}),
        ));
        assert!(
            batch.messages.iter().any(|m| m.op == op::API_CALL
                && m.payload["ok"] == false
                && m.payload["error"]["code"] == "ERR_RENDER"),
            "{batch:?}"
        );
    }
}

#[test]
fn native_query_waits_for_new_data_frame_and_callback_writes_do_not_repeat_it() {
    for engine in engines() {
        let mut session = fixture(engine);
        let initial_revision = session.render_revision();
        call(&mut session, "changeWidth");
        assert!(session.is_current_frame_presented());
        call(&mut session, "queryThenWrite");
        call(&mut session, "page");
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
        assert_eq!(session.native_queries.waiting.len(), 2);
        render(&mut session);
        assert!(session.render_revision() > initial_revision);
        assert_eq!(trace(&mut session)["trace"], json!([]));
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"write-after-query","width":119}],"errors":[]
            })
        );
        assert_eq!(
            session.native_queries.waiting.len(),
            1,
            "callback setData must fence the next query until its own frame"
        );
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"write-after-query","width":119},
                         {"label":"page","width":151,"owner":true}],"errors":[]
            })
        );
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 2);
        assert!(session.native_queries.waiting.is_empty());
    }
}

fn assert_ac_fifo_once(session: &mut Session) {
    render(session);
    session
        .acknowledge_presentation(session.render_revision())
        .unwrap();
    assert_eq!(
        trace(session)["trace"],
        json!([
            {"label":"A","width":240},{"label":"C","width":240}
        ]),
        "retiring a middle waiter must not rotate surviving callbacks"
    );
    session
        .acknowledge_presentation(session.render_revision())
        .unwrap();
    assert_eq!(trace(session)["trace"].as_array().unwrap().len(), 2);
    assert!(session.native_queries.waiting.is_empty());
}

#[test]
fn native_middle_cancel_keeps_surviving_callback_fifo() {
    for engine in engines() {
        let mut session = fixture(engine);
        session.retire_page_presenter("order-pending").unwrap();
        call(&mut session, "order");
        assert_eq!(session.native_queries.waiting.len(), 3);
        session.cancel_request_token("native-order-B").unwrap();
        assert!(session.drain_native_query_completions().unwrap());
        assert_eq!(
            trace(&mut session)["errors"],
            json!([{"label":"B","code":"ERR_CANCELLED"}])
        );
        assert_ac_fifo_once(&mut session);
    }
}

#[test]
fn native_middle_expiry_keeps_surviving_callback_fifo() {
    for engine in engines() {
        let mut session = fixture(engine);
        session.retire_page_presenter("order-pending").unwrap();
        call(&mut session, "order");
        let expired = unix_now_ns();
        session.native_queries.waiting[1].limits.deadline_ns = expired;
        assert!(session.drain_native_query_completions_at(expired).unwrap());
        assert_eq!(
            trace(&mut session)["errors"],
            json!([{"label":"B","code":"ERR_TIMEOUT"}])
        );
        assert_ac_fifo_once(&mut session);
    }
}

#[test]
fn native_middle_scope_retirement_keeps_surviving_callback_fifo() {
    for engine in engines() {
        let mut session = fixture(engine);
        session.retire_page_presenter("order-pending").unwrap();
        call(&mut session, "orderScope");
        call(&mut session, "dropComponent");
        render(&mut session);
        assert!(session.drain_native_query_completions().unwrap());
        assert_eq!(
            trace(&mut session)["errors"],
            json!([{"label":"B","code":"ERR_CANCELLED"}])
        );
        assert_ac_fifo_once(&mut session);
    }
}

#[test]
fn native_snake_scope_cannot_cross_same_id_component_recreation() {
    for engine in engines() {
        let mut session = fixture(engine);
        let original_scope = call(&mut session, "panelScope");
        session.retire_page_presenter("scope-pending").unwrap();
        call(&mut session, "orderSnake");
        call(&mut session, "dropComponent");
        render(&mut session);
        session.drain_native_query_completions().unwrap();
        call(&mut session, "restoreComponent");
        render(&mut session);
        assert_eq!(
            call(&mut session, "panelScope"),
            original_scope,
            "the public scope ID is reused; only the sealed incarnation changes"
        );
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"A","width":240},{"label":"C","width":240}],
                "errors":[{"label":"B","code":"ERR_CANCELLED"}]
            })
        );
    }
}

#[test]
fn native_scope_alias_precedence_matches_direct_selector_projection() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "aliasPrecedence");
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"camel-null","width":240},{"label":"camel-scope","width":87}],
                "errors":[{"label":"camel-invalid","code":"ERR_INVALID_REQUEST"}]
            })
        );
        let original_scope = call(&mut session, "panelScope");
        let scope = original_scope.as_str().unwrap();
        for (camel, snake, expected) in [
            (Value::Null, json!(scope), 240),
            (json!(scope), json!("missing-snake-scope"), 87),
        ] {
            let (_, _, _, value) = session
                .selector_query_result(
                    json!({
                        "selector":"#target","scopeId":camel,"scope_id":snake
                    })
                    .as_object()
                    .unwrap(),
                )
                .unwrap();
            assert_eq!(value["width"].as_f64(), Some(f64::from(expected)));
        }
        assert_eq!(
            session
                .selector_query_result(
                    json!({
                        "selector":"#target","scopeId":12,"scope_id":scope
                    })
                    .as_object()
                    .unwrap()
                )
                .unwrap_err()
                .code,
            BridgeErrorCode::InvalidRequest
        );
    }
}

#[test]
fn native_retired_completions_precede_new_ready_waiters() {
    for engine in engines() {
        let mut session = fixture(engine);
        // Split the ordinary effect turn at its public host-effect boundary,
        // allowing pure retirement before any query completion enters JS.
        let module = session.loaded_modules["module:app.js"].module_id;
        session
            .call_engine(
                CallTarget::Module {
                    id: module,
                    export: "order".into(),
                },
                vec![],
            )
            .unwrap();
        let effects = match engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => session
                .quickjs_engine
                .as_mut()
                .unwrap()
                .drain_host_events()
                .unwrap(),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => session
                .v8_engine
                .as_mut()
                .unwrap()
                .drain_host_events()
                .unwrap(),
            #[allow(unreachable_patterns)]
            _ => unreachable!(),
        };
        session.apply_engine_effects(&effects).unwrap();
        assert_eq!(session.native_queries.waiting.len(), 3);
        session.retire_native_queries(None, "original queries retired");
        assert_eq!(session.native_queries.completions.len(), 3);
        call(&mut session, "later");
        assert_eq!(
            call(&mut session, "inspectSettlements")["values"],
            json!([
                "A.ERR_CANCELLED",
                "B.ERR_CANCELLED",
                "C.ERR_CANCELLED",
                "later.ok"
            ])
        );
        assert!(session.native_queries.waiting.is_empty());
        assert!(session.native_queries.completions.is_empty());
        assert_eq!(session.native_queries.bytes, 0);
    }
}

// Successor coverage for the documented no-chrome manual embedding sentinel.
// Every pre-existing regression and v2 test above remains byte-identical.
const V3_EXTRA: &str = r#"
exports.nestedImmediate=()=>{
  const receiver=page(), trace=[];
  function query(label){
    const builder=wx.createSelectorQuery().in(receiver);
    builder.select('#target').boundingClientRect(value=>trace.push([label,'callback',value.width]));
    return builder.exec().then(values=>{trace.push([label,'promise',values[0].width]);});
  }
  query('first').then(()=>query('second')).then(()=>query('third')).then(()=>{
    receiver.setData({nestedTrace:trace});
  }).catch(error=>{receiver.setData({nestedFailure:error.code});});
  return 'scheduled';
};
exports.expired=()=>{
  __container_api_call('wx.createSelectorQuery', {queries:[{selector:'#target'}],deadlineNs:'1'})
    .then(()=>getApp().trace.push({label:'expired'}),error=>getApp().errors.push({label:'expired',code:error.code}));
  return true;
};
"#;

fn native_v3_fixture(
    engine: EngineKind,
    mut config: SessionConfig,
    launch: bool,
    page: bool,
    explicit_dev: bool,
    deferred: bool,
) -> Session {
    // Borrow only immutable fixture resources; the reference Session has no
    // effect on the fresh Session's lifecycle, host or presentation policy.
    let reference = fixture(engine);
    let app = format!("{APP}{V3_EXTRA}");
    let mut manifest = reference.manifest.clone();
    manifest
        .modules
        .iter_mut()
        .find(|m| m.id == "module:app.js")
        .unwrap()
        .sha256 = hex_digest(app.as_bytes());
    manifest.refresh_integrity().unwrap();
    config.engine = engine;
    let mut session = Session::new(manifest, config).unwrap();
    if explicit_dev {
        session.enable_dev_raster_presentation().unwrap();
    }
    session.set_deferred_navigation_enabled(deferred).unwrap();
    success(
        &mut session,
        op::APP_INIT,
        json!({
            "modules":[
                {"id":"module:app.js","source":app},
                {"id":"module:pages/index/index.js","source":PAGE},
                {"id":"module:components/panel/index.js","source":COMPONENT}
            ],
            "blobs":reference.render_blobs.as_ref()
        }),
    );
    if launch {
        success(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    }
    if page {
        // Deferred navigation deliberately does not use a page: the old
        // manual embedding fallback must not bypass its opt-in even then.
        success(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
    }
    session
}

fn native_v3_manual_frame(session: &mut Session, width: u32, height: u32) {
    success(
        session,
        op::RENDER_COMMIT,
        json!({
            "frameId":1,"viewport":{"x":0,"y":0,"width":width,"height":height},
            "root":{"id":"root","bounds":{"x":0,"y":0,"width":width,"height":height},
                "opacity":1,"children":[
                    {"id":"target","bounds":{"x":1,"y":2,"width":240,"height":30},
                        "opacity":1,"children":[]}
                ]}
        }),
    );
}

#[test]
fn native_v3_created_zero_host_manual_embedding_with_or_without_page_is_compatible() {
    for engine in engines() {
        for page in [false, true] {
            let mut session =
                native_v3_fixture(engine, SessionConfig::default(), false, page, false, false);
            assert_eq!(
                session.app_service.lifecycle().state(),
                container_core::LifecycleState::Created
            );
            native_v3_manual_frame(&mut session, 320, 480);
            call(&mut session, "order");
            assert_eq!(
                trace(&mut session),
                json!({"trace":[
                {"label":"A","width":240},{"label":"B","width":240},{"label":"C","width":240}
            ],"errors":[]}),
                "engine={engine:?}, page={page}"
            );
            assert!(session.native_queries.waiting.is_empty());
        }
    }
}

#[test]
fn native_private_nested_immediate_queries_publish_their_effects_in_the_original_turn() {
    for engine in engines() {
        let mut session =
            native_v3_fixture(engine, SessionConfig::default(), false, true, false, false);
        native_v3_manual_frame(&mut session, 320, 480);
        let completed = raw_call(&mut session, "nestedImmediate");
        assert!(
            completed
                .messages
                .iter()
                .all(|message| { message.op != op::ERROR && message.payload["ok"] != false }),
            "{engine:?}: {completed:?}"
        );
        assert_eq!(
            completed.messages[0].payload["result"],
            json!(["scheduled"])
        );
        // Read the already-applied Rust projection directly: another JS call or
        // timer poll here could hide a false quiescence at the private boundary.
        assert_eq!(
            session.view().pending_patches.len(),
            1,
            "{engine:?}: {completed:?}"
        );
        assert_eq!(session.view().pending_patches[0].path, "nestedTrace");
        assert_eq!(
            session.view().pending_patches[0].value,
            Some(json!([
                ["first", "callback", 240],
                ["first", "promise", 240],
                ["second", "callback", 240],
                ["second", "promise", 240],
                ["third", "callback", 240],
                ["third", "promise", 240]
            ])),
            "{engine:?}: {completed:?}"
        );
        assert!(session.native_queries.waiting.is_empty());
        assert!(session.native_queries.completions.is_empty());
        assert_eq!(session.native_queries.bytes, 0);
    }
}

#[test]
fn native_v3_created_zero_host_generated_embedding_keeps_explicit_manual_semantics() {
    for engine in engines() {
        let mut session =
            native_v3_fixture(engine, SessionConfig::default(), false, true, false, false);
        render(&mut session);
        assert!(session.accepted_skia_scene);
        call(&mut session, "page");
        assert_eq!(
            trace(&mut session),
            json!({"trace":[
            {"label":"page","width":240,"owner":true}
        ],"errors":[]})
        );
        assert!(session.native_queries.waiting.is_empty());
    }
}

#[test]
fn native_v3_created_embedding_compatibility_never_bypasses_host_or_policy_opt_in() {
    for engine in engines() {
        for policy in [
            "measured",
            "partial-measured",
            "external",
            "dev-raster",
            "deferred",
            "browser",
            "chrome",
        ] {
            let mut config = SessionConfig::default();
            match policy {
                "measured" => {
                    config.host.window_width = 320;
                    config.host.window_height = 480;
                }
                "partial-measured" => config.host.window_width = 320,
                "external" => config.page_render_mode = PageRenderMode::ExternalFrame,
                "browser" => config.browser_view_enabled = true,
                "chrome" => {
                    config.host.menu_button_rect = Some(MenuButtonRect {
                        left: 210.0,
                        right: 300.0,
                        top: 4.0,
                        bottom: 36.0,
                        width: 90.0,
                        height: 32.0,
                    })
                }
                _ => {}
            }
            let mut session = native_v3_fixture(
                engine,
                config,
                false,
                policy != "deferred",
                policy == "dev-raster",
                policy == "deferred",
            );
            native_v3_manual_frame(&mut session, 320, 480);
            call(&mut session, "order");
            let state = trace(&mut session);
            assert_eq!(
                state["trace"],
                json!([]),
                "engine={engine:?}, policy={policy}"
            );
            assert_eq!(
                state["errors"].as_array().unwrap().len(),
                3,
                "engine={engine:?}, policy={policy}, {state}"
            );
            assert!(session.native_queries.waiting.is_empty());
        }
    }
}

#[test]
fn native_v3_legacy_embedding_still_enforces_deadline_cancel_and_view_health() {
    for engine in engines() {
        let mut session =
            native_v3_fixture(engine, SessionConfig::default(), false, true, false, false);
        native_v3_manual_frame(&mut session, 320, 480);
        call(&mut session, "expired");
        success(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"native-cancel"}),
        );
        call(&mut session, "cancelQuery");
        assert_eq!(
            trace(&mut session),
            json!({"trace":[],"errors":[
                {"label":"expired","code":"ERR_TIMEOUT"},{"label":"cancel","code":"ERR_CANCELLED"}
            ]})
        );
        session.view_execution.borrow_mut().inject_fault_for_test(
            container_core::ViewEngineError::new(
                container_core::ViewEngineErrorCode::Timeout,
                "v3 injected fault",
            ),
        );
        assert!(session.retire_faulted_view_authority());
        call(&mut session, "order");
        let state = trace(&mut session);
        assert_eq!(state["trace"], json!([]));
        assert!(state["errors"].as_array().unwrap()[2..]
            .iter()
            .all(|e| e["code"] == "ERR_RENDER"));
    }
}

#[test]
fn native_v3_active_zero_host_queries_wait_for_fresh_template_without_callback_replay() {
    for engine in engines() {
        let mut session =
            native_v3_fixture(engine, SessionConfig::default(), true, true, false, false);
        render(&mut session);
        call(&mut session, "page");
        assert_eq!(
            trace(&mut session)["trace"],
            json!([{"label":"page","width":240,"owner":true}])
        );
        call(&mut session, "changeWidth");
        call(&mut session, "queryThenWrite");
        call(&mut session, "page");
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 1);
        assert_eq!(session.native_queries.waiting.len(), 2);
        render(&mut session);
        assert_eq!(
            trace(&mut session)["trace"],
            json!([
                {"label":"page","width":240,"owner":true},{"label":"write-after-query","width":119}
            ])
        );
        assert_eq!(
            session.native_queries.waiting.len(),
            1,
            "callback setData must invalidate the previous template"
        );
        render(&mut session);
        assert_eq!(
            trace(&mut session),
            json!({"trace":[
            {"label":"page","width":240,"owner":true},
            {"label":"write-after-query","width":119},{"label":"page","width":151,"owner":true}
        ],"errors":[]})
        );
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 3);
        assert!(session.native_queries.waiting.is_empty());
    }
}

#[test]
fn native_v3_active_measured_host_rejects_mismatched_and_resize_stale_frames() {
    for engine in engines() {
        let mut session = fixture(engine);
        success(
            &mut session,
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml","useSessionResources":true,
                "viewport":{"width":200,"height":100}
            }),
        );
        let _ = session.acknowledge_presentation(session.render_revision());
        assert!(!session.is_current_frame_presented());
        assert!(session.current_skia_frame_authority().is_none());
        call(&mut session, "page");
        assert_eq!(trace(&mut session), json!({"trace":[],"errors":[]}));
        assert_eq!(session.native_queries.waiting.len(), 1);
        render(&mut session);
        let former_revision = session.render_revision();
        session.acknowledge_presentation(former_revision).unwrap();
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 1);
        session.notify_viewport_resize(480, 320).unwrap();
        assert!(!session.is_current_frame_presented());
        call(&mut session, "page");
        let _ = session.acknowledge_presentation(former_revision);
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 1);
        render(&mut session); // a fresh revision still has the old viewport
        let _ = session.acknowledge_presentation(session.render_revision());
        assert!(!session.is_current_frame_presented());
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 1);
        assert_eq!(session.native_queries.waiting.len(), 1);
        success(
            &mut session,
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml","useSessionResources":true,
                "viewport":{"width":480,"height":320}
            }),
        );
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(trace(&mut session)["trace"].as_array().unwrap().len(), 2);
        assert!(session.native_queries.waiting.is_empty());
        assert!(session.current_skia_frame_authority().is_some());
    }
}

#[test]
fn native_v3_background_and_destroyed_zero_host_never_use_created_compatibility() {
    for engine in engines() {
        for event in ["hide", "unload"] {
            let mut session =
                native_v3_fixture(engine, SessionConfig::default(), true, true, false, false);
            native_v3_manual_frame(&mut session, 320, 480);
            success(&mut session, op::APP_LIFECYCLE, json!({"event":event}));
            // The JS receiver is deliberately still available in the realm;
            // geometry must not be read merely because pixels are retained.
            call(&mut session, "order");
            let state = trace(&mut session);
            assert_eq!(state["trace"], json!([]), "event={event}");
            assert_eq!(
                state["errors"].as_array().unwrap().len(),
                3,
                "event={event}"
            );
            assert!(session.native_queries.waiting.is_empty());
        }
    }
}

include!("selector_basic_tests.rs");
