#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::PageRenderMode;
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({trace:[],errors:[]});
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

fn call(session: &mut Session, export: &str) -> Value {
    success(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    )["result"][0]
        .clone()
}

fn fixture(engine: EngineKind) -> Session {
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
        ("module:app.js", APP, ModuleScope::App),
        ("module:pages/index/index.js", PAGE, ModuleScope::Page),
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
        (
            "template:pages/index/index.wxml",
            r#"<view id="target" style="width:{{width}}px;height:30px"/><panel wx:if="{{show}}" id="panel"/>"#,
        ),
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
        ..Default::default()
    };
    config.host.window_width = 320;
    config.host.window_height = 480;
    assert_eq!(config.view_execution.batch_timeout_ms, 50);
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
fn set_data_query_awaits_its_presented_frame_and_never_replays_callback() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "changeWidth");
        assert!(session.is_current_frame_presented());
        call(&mut session, "queryThenWrite");
        call(&mut session, "page");
        assert_eq!(
            trace(&mut session),
            json!({"trace":[],"errors":[]}),
            "a JS query must not return geometry from the old presented data"
        );
        render(&mut session);
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        assert_eq!(
            trace(&mut session),
            json!({
                "trace":[{"label":"write-after-query","width":119}],"errors":[]
            })
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
    }
}
