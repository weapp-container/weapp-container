// These tests query generated WXML through the native renderer and require a
// genuine accepted presentation before exposing geometry or invoking callbacks.
const BASIC_SELECTOR_APP: &str = r#"
const capturedBeforePage=wx.createSelectorQuery();
exports.basicBeforePage=function(){
  capturedBeforePage.select('.noid').boundingClientRect(value=>getApp().trace.push(['unowned',value]));
  capturedBeforePage.exec().catch(error=>getApp().errors.push(error.code));
  return true;
};
globalThis.basicOnLoad=function(receiver){
  const q=wx.createSelectorQuery().in(receiver);
  q.select('.noid').boundingClientRect(value=>getApp().trace.push(['onLoad',value]));
  q.exec().catch(error=>getApp().errors.push(error.code));
};
exports.basicQueue=function(){
  const q=wx.createSelectorQuery(), retained=q.select('.noid');
  q.selectAll('#group > .item').boundingClientRect();
  retained.boundingClientRect();
  q.select('#group .a').boundingClientRect();
  q.selectAll('.a.b').boundingClientRect();
  q.select('#panel #target').boundingClientRect();
  q.selectAll('.a,.b').boundingClientRect();
  q.select('#missing').boundingClientRect();
  q.selectAll('#missing').boundingClientRect();
  q.selectViewport().boundingClientRect();
  q.select('#scroll').scrollOffset();
  q.selectViewport().scrollOffset();
  q.select('#scroll').fields({scrollOffset:true});
  const ref=q.exec(values=>getApp().basicValues=values);
  ref.catch(error=>getApp().errors.push(error.code));
  return {node:typeof ref.boundingClientRect==='function',scroll:typeof ref.scrollOffset==='function',then:typeof ref.then==='function',catch:typeof ref.catch==='function',finally:typeof ref.finally==='function',promise:ref instanceof Promise};
};
exports.basicUnsupportedDeep=function(){
  wx.createSelectorQuery().select('#panel >>> #target').boundingClientRect().exec()
    .catch(error=>getApp().errors.push(error.code));
  return true;
};
exports.basicPoison=function(){
  const receiver=getCurrentPages()[0],q=wx.createSelectorQuery().in(receiver);
  q.select('.noid').boundingClientRect(value=>getApp().privateValue=value);
  q.exec().catch(error=>getApp().errors.push(error.code));
  globalThis.__container_api_pending={};globalThis.__container_events.length=0;
  globalThis.__container_api_call=()=>{throw Error('public query');};
  globalThis.__container_resolve_api=()=>{throw Error('public resolver');};
  globalThis.__container_page_instances={};globalThis.__container_component_scopes={};
  globalThis.__container_capture_api_owner=()=>({});
  globalThis.__container_run_with_api_owner=()=>{throw Error('public owner');};
  return true;
};
exports.basicState=()=>({values:getApp().basicValues||null,privateValue:getApp().privateValue||null,trace:getApp().trace,errors:getApp().errors});
"#;

fn basic_fixture(engine: EngineKind, on_load: bool) -> Session {
    let app = format!("{APP}\n{BASIC_SELECTOR_APP}");
    let page = if on_load {
        "Page({data:{show:true,width:240,payload:{enabled:false,list:[1,null]}},onLoad(){basicOnLoad(this);}});"
    } else {
        "Page({data:{show:true,width:240,payload:{enabled:false,list:[1,null]}}});"
    };
    fixture_sources(
        engine,
        &app,
        page,
        r#"<view id="group"><view class="item a b noid" data-count="{{7}}" data-payload="{{payload}}" style="width:40px;height:12px;transform:translate(7px,11px)"/><view id="repeat" class="item b" data-flag="{{false}}" style="width:50px;height:13px"/><scroll-view id="scroll" scroll-y="{{true}}" data-count="{{7}}" style="width:80px;height:30px"><view style="width:160px;height:100px"/></scroll-view></view><panel wx:if="{{show}}" id="panel"/><view style="width:640px;height:900px"/>"#,
    )
}

#[test]
fn native_basic_selector_fixed_geometry_slots_datasets_and_promise_exec_extension() {
    for engine in engines() {
        let mut session = basic_fixture(engine, false);
        assert_eq!(
            call(&mut session, "basicQueue"),
            json!({"node":false,"scroll":false,"then":true,"catch":true,"finally":true,"promise":true})
        );
        session.poll_timers(unix_now_ns());
        let state = call(&mut session, "basicState");
        let values = state["values"]
            .as_array()
            .unwrap_or_else(|| panic!("native queries did not complete: {state:?}"));
        assert_eq!(values.len(), 12);
        assert_eq!(values[0].as_array().unwrap().len(), 2);
        assert_eq!(
            values[1]["id"],
            json!(""),
            "generated occurrence IDs are never public IDs"
        );
        assert_eq!(
            values[1]["dataset"],
            json!({"count":7,"payload":{"enabled":false,"list":[1,null]}})
        );
        assert_eq!(values[2]["dataset"], values[1]["dataset"]);
        assert_eq!(values[3].as_array().unwrap().len(), 1);
        assert_eq!(values[4]["id"], json!("target"));
        assert_eq!(
            values[5].as_array().unwrap().len(),
            2,
            "union preserves occurrences without duplicates"
        );
        assert!(values[6].is_null());
        assert_eq!(values[7], json!([]));
        assert_eq!(values[8]["id"], json!(""));
        assert_eq!(values[8]["dataset"], json!({}));
        assert_eq!(values[8]["width"].as_f64(), Some(320.0));
        assert_eq!(values[8]["height"].as_f64(), Some(480.0));
        assert_eq!(values[9]["id"], json!("scroll"));
        assert_eq!(values[9]["dataset"], json!({"count":7}));
        assert!(values[9]["scrollLeft"].is_number());
        assert!(values[9]["scrollTop"].is_number());
        assert_eq!(values[10]["id"], json!(""));
        assert_eq!(values[10]["dataset"], json!({}));
        assert_eq!(values[9]["scrollWidth"], json!(160));
        assert_eq!(values[9]["scrollHeight"], json!(100));
        assert!(values[10]["scrollWidth"].as_f64().unwrap() >= 640.0);
        assert!(values[10]["scrollHeight"].as_f64().unwrap() > 480.0);
        assert_eq!(values[11]["scrollWidth"], values[9]["scrollWidth"]);
        assert_eq!(values[11]["scrollHeight"], values[9]["scrollHeight"]);
        let rect = &values[1];
        assert!(
            (rect["right"].as_f64().unwrap()
                - rect["left"].as_f64().unwrap()
                - rect["width"].as_f64().unwrap())
            .abs()
                < 0.001
        );
        assert_eq!(state["errors"], json!([]));
        assert_eq!(call(&mut session, "basicUnsupportedDeep"), json!(true));
        session.poll_timers(unix_now_ns());
        assert_eq!(
            call(&mut session, "basicState")["errors"],
            json!(["ERR_INVALID_REQUEST"])
        );
    }
}

#[test]
fn native_basic_selector_public_alias_tampering_cannot_suppress_private_queries() {
    for engine in engines() {
        let mut session = basic_fixture(engine, false);
        call(&mut session, "basicPoison");
        session.poll_timers(unix_now_ns());
        let state = call(&mut session, "basicState");
        assert_eq!(state["privateValue"]["id"], json!(""));
        assert_eq!(state["privateValue"]["dataset"]["count"], json!(7));
        assert_eq!(state["errors"], json!([]));
    }
}

#[test]
fn native_basic_selector_onload_waits_for_first_genuine_presentation_once() {
    for engine in engines() {
        let mut session = basic_fixture(engine, true);
        session.poll_timers(unix_now_ns());
        let state = call(&mut session, "basicState");
        assert_eq!(state["trace"].as_array().unwrap().len(), 1);
        assert_eq!(state["trace"][0][0], json!("onLoad"));
        assert_eq!(state["trace"][0][1]["dataset"]["count"], json!(7));
        session.poll_timers(unix_now_ns());
        assert_eq!(call(&mut session, "basicState")["trace"], state["trace"]);
    }
}

#[test]
fn native_basic_selector_unowned_factory_cannot_acquire_a_later_page() {
    for engine in engines() {
        let mut session = basic_fixture(engine, false);
        call(&mut session, "basicBeforePage");
        session.poll_timers(unix_now_ns());
        let state = call(&mut session, "basicState");
        assert_eq!(state["trace"], json!([]));
        assert_eq!(state["errors"], json!(["ERR_CANCELLED"]));
    }
}
