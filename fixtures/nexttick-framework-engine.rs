// Source-only native gate. The packaging child does not compile or execute it.
use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};
fn fixture() -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("setData".into(), "partial".into()),
            ("wx.nextTick".into(), "partial".into()),
            ("wx.navigateTo".into(), "partial".into()),
            ("wx.onError".into(), "partial".into()),
            ("wx.onAppShow".into(), "partial".into()),
            ("wx.onAppRoute".into(), "partial".into()),
            ("wx.offAppRoute".into(), "partial".into()),
        ]))
        .unwrap();
    let module=JsEngine::load_module(&mut engine,br#"
      let trace=[],a,b,c,channel,requestId;Page({data:{value:0}});Page({data:{value:0}});
      exports.setup=function(kind){
        [a,b]=getCurrentPages();
        if(kind==='component'){
          __container_registration_module_id='module:framework-owner.js';__container_managed_component_modules[__container_registration_module_id]=true;
          const definition=Component({data:{value:0},methods:{}});__container_registration_module_id=null;
          c=__container_clone_component_instance(definition,{scopeId:'framework-c',moduleId:'module:framework-owner.js',pageId:12,parentScopeId:null,ownerScopeId:null});
        }
        if(kind==='setData'||kind==='component'||kind==='before-completion'){
          const receiver=kind==='component'?c:b;
          a.start=function(){receiver.setData({value:1},function(){'use strict';trace.push(['completion',this===undefined,arguments.length,__container_capture_api_owner()===receiver]);wx.nextTick(()=>trace.push('receiver-task'))});if(kind==='before-completion')__container_invoke_page_instance(12,1,'onUnload',[])};
        }else if(kind==='channel'){
          a.start=function(){wx.navigateTo({url:'pages/target',events:{ping:function(){trace.push(['listener',this===channel,__container_capture_api_owner()===a]);wx.nextTick(()=>trace.push('listener-task'))}},success:function(value){channel=value.eventChannel}});requestId=__container_api_id};
        }else if(kind==='error'){
          wx.onError(function(message){trace.push(['error',message,this===globalThis,__container_capture_api_owner()===null]);wx.nextTick(()=>trace.push('realm-task'))});
          a.start=function(){wx.nextTick(function(){throw Error('framework-page')})};
        }else{
          a.start=function(){const callback=function(){trace.push(['realm',this===globalThis,__container_capture_api_owner()===null]);wx.nextTick(()=>trace.push('realm-task'))};if(kind==='show')wx.onAppShow(callback);else wx.onAppRoute(callback)};
        }
        __container_invoke_page_instance(11,0,'start',[]);return requestId||true;
      };
      exports.deliver=function(){return __container_resolve_api(requestId,{errMsg:'navigateTo:ok'},null)};
      exports.emit=function(){b.start=function(){channel.emit('ping');trace.push(['emitter',__container_capture_api_owner()===b]);wx.nextTick(()=>trace.push('emitter-task'))};__container_invoke_page_instance(12,1,'start',[]);return true};
      exports.retire=function(who){if(who==='component')__container_unmount_component(c.__container_component_index);else __container_invoke_page_instance(who==='a'?11:12,who==='a'?0:1,'onUnload',[]);return true};
      exports.state=function(){return [trace]};
    "#).unwrap();
    engine.prepare_page_mirror("framework-owner",&json!([{"index":0,"instanceId":11,"route":"caller"},{"index":1,"instanceId":12,"route":"receiver"}])).unwrap();
    engine.commit_page_mirror("framework-owner").unwrap();
    (engine, module)
}
fn call(engine: &mut NativeEngine, module: ModuleId, export: &str, args: Vec<Value>) -> Value {
    let mut values = JsEngine::call(
        engine,
        CallTarget::Module {
            id: module,
            export: export.into(),
        },
        args,
    )
    .unwrap();
    JsEngine::drain_microtasks(engine).unwrap();
    values.remove(0)
}
#[test]
fn nexttick_framework_setdata_uses_actual_receiver_and_preserves_completion_admission() {
    for kind in ["caller", "receiver", "component", "before-completion"] {
        let (mut engine, module) = fixture();
        call(
            &mut engine,
            module,
            "setup",
            vec![json!(if kind == "caller" || kind == "receiver" {
                "setData"
            } else {
                kind
            })],
        );
        let completion = json!([["completion", true, 0, true]]);
        assert_eq!(
            call(&mut engine, module, "state", vec![]),
            completion,
            "{kind}"
        );
        if kind != "before-completion" {
            call(
                &mut engine,
                module,
                "retire",
                vec![json!(if kind == "caller" {
                    "a"
                } else if kind == "component" {
                    "component"
                } else {
                    "b"
                })],
            );
        }
        engine.poll_turn_scheduler(None).unwrap();
        let expected = if kind == "caller" {
            json!([["completion", true, 0, true], "receiver-task"])
        } else {
            completion
        };
        assert_eq!(
            call(&mut engine, module, "state", vec![]),
            expected,
            "{kind}"
        );
    }
}
#[test]
fn nexttick_framework_eventchannel_listener_owns_tasks_and_restores_the_emitter() {
    for retiring in ["a", "b"] {
        let (mut engine, module) = fixture();
        let request = call(&mut engine, module, "setup", vec![json!("channel")])
            .as_u64()
            .unwrap();
        assert!(engine.bind_event_channel(request, 12).unwrap());
        call(&mut engine, module, "deliver", vec![]);
        call(&mut engine, module, "emit", vec![]);
        call(&mut engine, module, "retire", vec![json!(retiring)]);
        engine.poll_turn_scheduler(None).unwrap();
        let expected = if retiring == "a" {
            json!([["listener", true, true], ["emitter", true], "emitter-task"])
        } else {
            json!([["listener", true, true], ["emitter", true], "listener-task"])
        };
        assert_eq!(call(&mut engine, module, "state", vec![]), expected);
    }
}
#[test]
fn nexttick_framework_error_listener_enters_realm_after_a_page_task_throws() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "setup", vec![json!("error")]);
    engine.poll_turn_scheduler(None).unwrap();
    call(&mut engine, module, "retire", vec![json!("a")]);
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state", vec![]),
        json!([["error", "framework-page", true, true], "realm-task"])
    );
}
#[test]
fn nexttick_framework_app_and_route_listener_controls_remain_realm_owned() {
    for kind in ["show", "route"] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, "setup", vec![json!(kind)]);
        if kind == "show" {
            assert!(engine
                .dispatch_lifecycle_notification("show", &json!({}))
                .unwrap());
        } else {
            assert!(engine
                .dispatch_route_notification("after", &json!({"path":"pages/target"}), None)
                .unwrap());
        }
        call(&mut engine, module, "retire", vec![json!("a")]);
        engine.poll_turn_scheduler(None).unwrap();
        assert_eq!(
            call(&mut engine, module, "state", vec![]),
            json!([["realm", true, true], "realm-task"])
        );
    }
}
