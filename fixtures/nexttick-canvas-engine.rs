use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn fixture() -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("wx.nextTick".into(), "partial".into()),
            ("wx.createCanvasContext".into(), "full".into()),
            ("wx.canvas.draw".into(), "full".into()),
            ("wx.getSystemInfo".into(), "partial".into()),
            ("wx.onError".into(), "partial".into()),
        ]))
        .unwrap();
    engine
        .dispatch_lifecycle_notification("session", &json!({}))
        .unwrap();
    let module = JsEngine::load_module(&mut engine, br#"
      let trace=[];Page({data:{number:0}});let page,component,ctx;
      exports.setup=function(kind){
        page=getCurrentPages()[0];
        __container_registration_module_id='module:canvas-owner.js';__container_managed_component_modules[__container_registration_module_id]=true;
        const definition=Component({methods:{}});__container_registration_module_id=null;
        component=__container_clone_component_instance(definition,{scopeId:'panel',moduleId:'module:canvas-owner.js',pageId:11,parentScopeId:null,ownerScopeId:null});
        ctx=wx.createCanvasContext('shared',component);ctx.fillRect(0,0,1,1);
        const pending=ctx.draw(false,function(value){'use strict';
          trace.push(['complete',this===undefined,__container_capture_api_owner()===component]);
          component.setData({number:2});
          if(kind==='api')wx.getSystemInfo({success:function(){trace.push('api');wx.nextTick(()=>trace.push('stale-api'))}});
          else wx.nextTick(()=>{component.setData({number:3});trace.push('later')});
          if(kind==='throw')throw Error('canvas callback');
        });
        pending.then(()=>trace.push('resolved'),()=>trace.push('rejected'));
        if(kind==='throw')wx.onError(value=>trace.push('error:'+value));
        return true;
      };
      exports.deliverApi=function(){return __container_resolve_api(__container_api_id,{errMsg:'getSystemInfo:ok'},null)};
      exports.retire=function(){__container_unmount_component(component.__container_component_index);return true};
      exports.state=function(){return {trace,number:component.data.number}};
    "#).unwrap();
    engine
        .prepare_page_mirror(
            "canvas-owner",
            &json!([{"index":0,"instanceId":11,"route":"canvas-owner"}]),
        )
        .unwrap();
    engine.commit_page_mirror("canvas-owner").unwrap();
    (engine, module)
}
fn call(engine: &mut NativeEngine, module: ModuleId, export: &str, args: Vec<Value>) -> Value {
    let mut result = JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: export.into(),
        },
        args,
    )
    .unwrap();
    JsEngine::drain_microtasks(engine).unwrap();
    result.remove(0)
}
fn deliver(engine: &mut NativeEngine) {
    let requests = engine.capture_owned_canvas_requests(0).unwrap();
    let ticket = requests["requests"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["kind"] == "draw")
        .unwrap()["ticket"]
        .clone();
    let payload =
        json!({"ticket":ticket,"result":{"canvasId":"shared","width":3,"height":2},"error":null});
    assert!(engine
        .dispatch_lifecycle_notification("ownedCanvas", &payload)
        .unwrap());
    assert!(engine
        .dispatch_lifecycle_notification("ownedCanvas", &payload)
        .unwrap());
    JsEngine::drain_microtasks(engine).unwrap();
}
#[test]
fn nexttick_canvas_completion_runs_once_unbound_and_defers_actual_component_data() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "setup", vec![json!("live")]);
    deliver(&mut engine);
    assert_eq!(
        call(&mut engine, module, "state", vec![]),
        json!({"trace":[["complete",true,true],"resolved"],"number":2})
    );
    engine.poll_turn_scheduler(None).unwrap();
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state", vec![]),
        json!({"trace":[["complete",true,true],"resolved","later"],"number":3})
    );
}
#[test]
fn nexttick_canvas_completion_and_thrown_callback_keep_private_retirement_identity() {
    for kind in ["live", "throw"] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, "setup", vec![json!(kind)]);
        deliver(&mut engine);
        call(&mut engine, module, "retire", vec![]);
        engine.poll_turn_scheduler(None).unwrap();
        let expected = if kind == "throw" {
            json!([
                ["complete", true, true],
                "error:canvas callback",
                "resolved"
            ])
        } else {
            json!([["complete", true, true], "resolved"])
        };
        assert_eq!(
            call(&mut engine, module, "state", vec![])["trace"],
            expected
        );
    }
}
#[test]
fn nexttick_canvas_completion_to_api_callback_retains_the_component_incarnation() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "setup", vec![json!("api")]);
    deliver(&mut engine);
    call(&mut engine, module, "deliverApi", vec![]);
    call(&mut engine, module, "retire", vec![]);
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state", vec![])["trace"],
        json!([["complete", true, true], "resolved", "api"])
    );
}
