use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};
fn fixture() -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("getCurrentPages".into(), "full".into()),
            ("wx.nextTick".into(), "full".into()),
            ("Component.triggerEvent".into(), "partial".into()),
            ("wx.getSystemInfo".into(), "partial".into()),
        ]))
        .unwrap();
    let source=br#"
      let trace=[];Page({data:{number:0}});
      let page,child,parent;
      exports.setup=function(kind){
        page=getCurrentPages()[0];
        __container_registration_module_id='module:nexttick-owner-component.js';
        __container_managed_component_modules[__container_registration_module_id]=true;
        const definition=Component({methods:{}});__container_registration_module_id=null;
        child=__container_clone_component_instance(definition,{scopeId:'child',moduleId:'module:nexttick-owner-component.js',pageId:11,parentScopeId:null,ownerScopeId:null});
        parent=__container_clone_component_instance(definition,{scopeId:'parent',moduleId:'module:nexttick-owner-component.js',pageId:11,parentScopeId:null,ownerScopeId:null});
        if(kind==='api-success'||kind==='api-failure'||kind==='local-failure'){
          page.request=function(){
            const options={success:function(){trace.push('success');wx.nextTick(()=>trace.push('stale'))},fail:function(){trace.push('fail');wx.nextTick(()=>trace.push('stale'))},complete:function(){trace.push('complete');wx.nextTick(()=>trace.push('stale-complete'))}};
            (kind==='local-failure'?wx.getBatteryInfo(options):wx.getSystemInfo(options)).then(()=>trace.push('resolved'),()=>trace.push('rejected'));
          };
          __container_invoke_page_instance(11,0,'request',[]);return true;
        }
        if(kind==='documented'){
          child.methods.doSth=function(){this.setData({number:1});wx.nextTick(()=>{this.setData({number:3});trace.push('later')});this.setData({number:2});trace.push('sync-end')};
          __container_invoke_component(child.__container_component_index,'doSth',[]);return child.data.number;
        }
        if(kind==='page-event'||kind==='component-event'||kind==='poisoned-event'){
          const owner=kind==='component-event'?parent:page;
          owner.receive=function(){this.setData({number:1});wx.nextTick(()=>{this.setData({number:3});trace.push('parent')});this.setData({number:2});};
          child.tap=function(){this.triggerEvent('change',{});wx.nextTick(()=>trace.push('child'));__container_unmount_component(this.__container_component_index);trace.push('sync-end')};
          const scope=kind==='component-event'?'parent':null;
          const records=[{scopeId:'child',ownerScopeId:scope},{scopeId:'parent',ownerScopeId:null}];
          const batch={pageId:11,eventNodes:[{key:'child-host',parentKey:null,ownerScopeId:scope,componentScopeId:'child',attributes:{bindchange:'receive'},dataset:{},mark:{}},{key:'parent-host',parentKey:null,ownerScopeId:null,componentScopeId:'parent',attributes:{},dataset:{},mark:{}}]};
          __container_publish_component_event_batch(batch,__container_prepare_component_event_batch(batch,records));
          if(kind==='poisoned-event'){__container_run_with_api_owner=function(owner,fn){return fn()};__container_capture_api_owner=()=>null;}
        }else if(kind==='page-observer'){
          page.observers={number:function(){wx.nextTick(()=>trace.push('parent'))}};
          child.tap=function(){page.setData({number:1});__container_unmount_component(this.__container_component_index)};
        }else if(kind==='component-observer'){
          parent.observers={number:function(){wx.nextTick(()=>trace.push('parent'))}};
          child.tap=function(){parent.setData({number:1});__container_unmount_component(this.__container_component_index)};
        }else if(kind==='property-observer'){
          parent.__container_property_descriptors={number:{observer:function(){wx.nextTick(()=>trace.push('parent'))}}};
          child.tap=function(){__container_component_apply_patch(parent,{number:1},'property.update');__container_unmount_component(this.__container_component_index)};
        }else if(kind==='relation'){
          parent.__container_relation_definitions={edge:{linked:function(){wx.nextTick(()=>trace.push('parent'))}}};
          child.tap=function(){__container_publish_component_relation_tables(11,[{instance:parent,nodes:{edge:[child]}}],false);__container_unmount_component(this.__container_component_index)};
        }
        return true;
      };
      exports.deliver=function(failed){return __container_resolve_api(__container_api_id,failed?null:{errMsg:'getSystemInfo:ok'},failed?{errMsg:'getSystemInfo:fail test'}:null)};
      exports.unload=function(){__container_invoke_page_instance(11,0,'onUnload',[]);return true};
      exports.state=function(){return {trace,page:page.data.number,child:child.data.number,parent:parent.data.number}};
    "#;
    let module = JsEngine::load_module(&mut engine, source).unwrap();
    engine
        .prepare_page_mirror(
            "nexttick-owner",
            &json!([{"index":0,"instanceId":11,"route":"nexttick-owner"}]),
        )
        .unwrap();
    engine.commit_page_mirror("nexttick-owner").unwrap();
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
fn dispatch(engine: &mut NativeEngine) {
    let expected = engine
        .capture_receiver_incarnations(11, &["child".into(), "parent".into()])
        .unwrap();
    engine.invoke_receiver_event(11,&expected,&json!({"type":"tap","dispatches":[{"handler":"tap","ownerScopeId":"child","currentTarget":"child","phase":"target"}]}),false).unwrap();
    JsEngine::drain_microtasks(engine).unwrap();
}
#[test]
fn nexttick_owner_documented_component_example_observes_a_later_host_turn() {
    let (mut engine, module) = fixture();
    assert_eq!(
        call(&mut engine, module, "setup", vec![json!("documented")]),
        json!(2)
    );
    assert_eq!(
        call(&mut engine, module, "state", vec![])["trace"],
        json!(["sync-end"])
    );
    engine.poll_turn_scheduler(None).unwrap();
    let state = call(&mut engine, module, "state", vec![]);
    assert_eq!(state["child"], json!(3));
    assert_eq!(state["trace"], json!(["sync-end", "later"]));
}
#[test]
fn nexttick_owner_nested_page_handler_survives_source_child_retirement() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "setup", vec![json!("page-event")]);
    dispatch(&mut engine);
    assert_eq!(call(&mut engine, module, "state", vec![])["page"], json!(2));
    engine.poll_turn_scheduler(None).unwrap();
    let state = call(&mut engine, module, "state", vec![]);
    assert_eq!(state["page"], json!(3));
    assert_eq!(state["trace"], json!(["sync-end", "parent"]));
}
#[test]
fn nexttick_owner_nested_component_and_poisoned_aliases_restore_the_source_frame() {
    for kind in ["component-event", "poisoned-event"] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, "setup", vec![json!(kind)]);
        dispatch(&mut engine);
        engine.poll_turn_scheduler(None).unwrap();
        let state = call(&mut engine, module, "state", vec![]);
        assert_eq!(state["trace"], json!(["sync-end", "parent"]));
        assert_eq!(
            state[if kind == "component-event" {
                "parent"
            } else {
                "page"
            }],
            json!(3)
        );
    }
}
#[test]
fn nexttick_owner_sync_observers_and_relations_enter_the_actual_receiver() {
    for kind in [
        "page-observer",
        "component-observer",
        "property-observer",
        "relation",
    ] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, "setup", vec![json!(kind)]);
        dispatch(&mut engine);
        engine.poll_turn_scheduler(None).unwrap();
        assert_eq!(
            call(&mut engine, module, "state", vec![])["trace"],
            json!(["parent"]),
            "{kind}"
        );
    }
}

#[test]
fn nexttick_owner_api_success_failure_and_local_fail_keep_the_calling_page_identity() {
    for kind in ["api-success", "api-failure", "local-failure"] {
        let (mut engine, module) = fixture();
        call(&mut engine, module, "setup", vec![json!(kind)]);
        if kind != "local-failure" {
            call(
                &mut engine,
                module,
                "deliver",
                vec![json!(kind == "api-failure")],
            );
        }
        let failed = kind != "api-success";
        let expected = json!([
            if failed { "fail" } else { "success" },
            "complete",
            if failed { "rejected" } else { "resolved" }
        ]);
        assert_eq!(
            call(&mut engine, module, "state", vec![])["trace"],
            expected
        );
        call(&mut engine, module, "unload", vec![]);
        engine.poll_turn_scheduler(None).unwrap();
        assert_eq!(
            call(&mut engine, module, "state", vec![])["trace"],
            expected
        );
    }
}
#[test]
fn nexttick_owner_legacy_completion_still_delivers_after_page_retirement() {
    let (mut engine, module) = fixture();
    call(&mut engine, module, "setup", vec![json!("api-success")]);
    call(&mut engine, module, "unload", vec![]);
    call(&mut engine, module, "deliver", vec![json!(false)]);
    engine.poll_turn_scheduler(None).unwrap();
    assert_eq!(
        call(&mut engine, module, "state", vec![])["trace"],
        json!(["success", "complete", "resolved"])
    );
}
