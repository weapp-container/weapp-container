use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn fixture() -> (Engine, ModuleId) {
    let mut engine = Engine::default();
    let module = engine.load_module(br#"
      const context = wx.createCanvasContext('main');
      exports.strokeState = function() {
        const result=[];
        result.push([context.lineCap,context.lineJoin,context.miterLimit,context.lineDashOffset]);
        result.push(context.setLineCap('round')===undefined);
        context.lineJoin='bevel';context.miterLimit=2;context.setLineDash([3,2],4);
        context.save();context.lineCap='square';context.lineDashOffset=9;context.restore();
        result.push([context.lineCap,context.lineJoin,context.miterLimit,context.lineDashOffset]);
        context.draw(true);
        result.push([context.lineCap,context.lineJoin,context.miterLimit,context.lineDashOffset]);
        return {value:result};
      };
      exports.strokeRejected = function() {
        let code;try{context.lineCap='invalid'}catch(error){code=error.code}
        return {value:{code:code,cap:context.lineCap}};
      };
      let completions = 0;
      const settlements = [];
      exports.reserve = function() {
        context.fillRect(1,2,3,4); context.draw(true);
        context.fillRect(5,6,7,8); context.draw(true);
      };
      exports.enqueueFailure = function() {
        context.fillRect(9,10,11,12);
        const push = __container_events.push;
        let failed = false;
        try { __container_events.push = function(){throw new Error('unavailable queue');}; context.draw(); }
        catch (_) { failed = true; }
        finally { __container_events.push = push; }
        context.draw(); return failed;
      };
      exports.snapshot = function() {
        const pattern = [3,4]; context.setLineDash(pattern,1); pattern[0] = 99;
        context.draw();
      };
      exports.invalid = function() {
        const cyclic=[]; cyclic.push(cyclic);
        let code;
        try { context.setLineDash(cyclic); } catch (error) { code=error.code; }
        context.fillRect(1,2,3,4); context.draw(); return code || null;
      };
      exports.offscreen = function() {
        const canvas=wx.createOffscreenCanvas({type:'2d',width:4,height:5});
        const first=canvas.getContext('2d'), second=canvas.getContext('2d');
        first.fillRect(1,2,3,4); second.draw(); return first===second;
      };
      exports.callback = function() {
        context.fillRect(1,2,3,4);
        context.draw(false,function(){completions++;}).then(function(){settlements.push('resolved');},function(error){settlements.push(error.code);});
        return __container_api_id;
      };
      exports.callbackState = function() { return {completions:completions,settlements:settlements,pending:Object.keys(__container_api_pending).length}; };
      exports.reentrant = function() {
        context.fillRect(1,2,3,4);
        const push=__container_events.push;
        let entered=false, nestedFailure;
        __container_events.push=function(event){
          if(!entered){
            entered=true;context.fillRect(5,6,7,8);
            try{context.draw();}catch(error){nestedFailure=error.code;}
          }
          return push.call(this,event);
        };
        try{context.draw();}finally{__container_events.push=push;}
        context.draw();return nestedFailure;
      };
      exports.commandBudget = function() {
        for(let index=0;index<16384;index++)context.beginPath();
        let failure;
        try{context.beginPath();}catch(error){failure=error.code;}
        context.draw();context.fillRect(1,2,3,4);context.draw();return failure;
      };
      exports.snapshotReentrant = function() {
        for(let index=0;index<16383;index++)context.beginPath();
        const failures=[];
        for(const mutate of [()=>context.beginPath(),()=>context.draw()]){
          const proxy=new Proxy([1],{getOwnPropertyDescriptor(target,key){
            if(key==='0')mutate();
            return Reflect.getOwnPropertyDescriptor(target,key);
          }});
          try{context.setLineDash(proxy);}catch(error){failures.push(error.code);}
        }
        context.beginPath();
        try{context.beginPath();}catch(error){failures.push(error.code);}
        context.draw();context.fillRect(1,2,3,4);context.draw();return {failures:failures};
      };
      exports.byteBudget = function() {
        const text='x'.repeat(1048576);let failure;
        context.fillText(text,0,0);
        try{context.fillText(text,0,0);}catch(error){failure=error.code;}
        context.draw();context.fillText(text,0,0);context.draw();return failure;
      };
      exports.invalidProperty = function() {
        let failure;
        try{context.globalAlpha=NaN;}catch(error){failure=error.code;}
        return {failure:failure,alpha:context.globalAlpha};
      };
      exports.accessor = function() {
        const pattern=[];let reads=0, failure;
        Object.defineProperty(pattern,'0',{get(){reads++;return 1;},enumerable:true});
        try{context.setLineDash(pattern);}catch(error){failure=error.code;}
        context.fillRect(1,2,3,4);context.draw();return {failure:failure,reads:reads};
      };
      exports.queue = function() {context.fillRect(1,2,3,4);return null;};
      exports.flush = function() {context.draw();return null;};
      exports.separateOffscreen = function() {
        const first=wx.createOffscreenCanvas({width:4,height:5});
        const second=wx.createOffscreenCanvas({width:8,height:9});
        first.getContext('2d').fillRect(1,2,3,4);
        second.getContext('2d').draw();first.getContext('2d').draw();return null;
      };
    "#).unwrap();
    (engine, module)
}

fn call(engine: &mut Engine, id: ModuleId, export: &str) -> Value {
    engine
        .call(
            CallTarget::Module {
                id,
                export: export.into(),
            },
            vec![],
        )
        .unwrap()
        .remove(0)
}

fn calls(engine: &mut Engine) -> Vec<Value> {
    engine.drain_host_events().unwrap()[0]["events"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn canvas_reserve_submits_each_command_once() {
    let (mut engine, id) = fixture();
    call(&mut engine, id, "reserve");
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"fillRect","args":[5,6,7,8]}])
    );
}

#[test]
fn canvas_failed_admission_keeps_unsubmitted_commands() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "enqueueFailure"), true);
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([{"op":"fillRect","args":[9,10,11,12]}])
    );
}

#[test]
fn canvas_arguments_are_copied_before_caller_mutation() {
    let (mut engine, id) = fixture();
    call(&mut engine, id, "snapshot");
    assert_eq!(
        calls(&mut engine)[0]["options"]["commands"][0]["args"],
        json!([[3, 4], 1])
    );
}

#[test]
fn canvas_cyclic_arguments_fail_before_poisoning_the_queue() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "invalid"), "ERR_INVALID_REQUEST");
    let events = calls(&mut engine);
    assert_eq!(
        events[0]["options"]["commands"].as_array().unwrap().len(),
        1
    );
}

#[test]
fn canvas_offscreen_context_identity_shares_one_command_queue() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "offscreen"), true);
    assert_eq!(
        calls(&mut engine)[0]["options"]["commands"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn canvas_render_failure_does_not_invoke_success_callback() {
    let (mut engine, id) = fixture();
    let request = call(&mut engine, id, "callback");
    engine
        .call(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![
                request,
                json!(null),
                json!({"code":"ERR_UNSUPPORTED_CAPABILITY","errMsg":"canvas:fail"}),
            ],
        )
        .unwrap();
    engine.drain_microtasks().unwrap();
    assert_eq!(
        call(&mut engine, id, "callbackState"),
        json!({"completions":0,"settlements":["ERR_UNSUPPORTED_CAPABILITY"],"pending":0})
    );
}

#[test]
fn canvas_render_success_settles_and_invokes_callback_exactly_once() {
    let (mut engine, id) = fixture();
    let request = call(&mut engine, id, "callback");
    assert_eq!(
        call(&mut engine, id, "callbackState"),
        json!({"completions":0,"settlements":[],"pending":1})
    );
    engine
        .call(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![request.clone(), json!({"errMsg":"canvas:ok"}), Value::Null],
        )
        .unwrap();
    engine.drain_microtasks().unwrap();
    let repeated = engine
        .call(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![request, json!({"errMsg":"canvas:ok"}), Value::Null],
        )
        .unwrap();
    assert_eq!(repeated, vec![json!(false)]);
    engine.drain_microtasks().unwrap();
    assert_eq!(
        call(&mut engine, id, "callbackState"),
        json!({"completions":1,"settlements":["resolved"],"pending":0})
    );
}

#[test]
fn canvas_reentrant_commands_survive_admission_and_nested_draw_is_rejected() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "reentrant"), "ERR_INVALID_REQUEST");
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"fillRect","args":[5,6,7,8]}])
    );
}

#[test]
fn canvas_command_budget_releases_after_submission() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "commandBudget"), "ERR_RESOURCE_LIMIT");
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["options"]["commands"].as_array().unwrap().len(),
        16384
    );
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
}

#[test]
fn canvas_snapshot_proxy_reentry_cannot_bypass_budget_and_failure_releases_recording_guard() {
    let (mut engine, id) = fixture();
    assert_eq!(
        call(&mut engine, id, "snapshotReentrant"),
        json!({"failures":["ERR_INVALID_REQUEST","ERR_INVALID_REQUEST","ERR_RESOURCE_LIMIT"]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["options"]["commands"].as_array().unwrap().len(),
        16384
    );
    assert!(events[0]["options"]["commands"]
        .as_array()
        .unwrap()
        .iter()
        .all(|command| command["op"] == "beginPath"));
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
}

#[test]
fn canvas_pending_byte_budget_rejects_without_poisoning_and_releases_on_draw() {
    let (mut engine, id) = fixture();
    assert_eq!(call(&mut engine, id, "byteBudget"), "ERR_RESOURCE_LIMIT");
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    for event in &events {
        assert_eq!(event["options"]["commands"].as_array().unwrap().len(), 1);
        assert_eq!(
            event["options"]["commands"][0]["args"][0]
                .as_str()
                .unwrap()
                .len(),
            1048576
        );
    }
}

#[test]
fn canvas_failed_property_assignment_preserves_previous_state() {
    let (mut engine, id) = fixture();
    assert_eq!(
        call(&mut engine, id, "invalidProperty"),
        json!({"failure":"ERR_INVALID_REQUEST","alpha":1})
    );
    assert!(calls(&mut engine).is_empty());
}

#[test]
fn canvas_argument_accessors_fail_without_invoking_application_getters() {
    let (mut engine, id) = fixture();
    assert_eq!(
        call(&mut engine, id, "accessor"),
        json!({"failure":"ERR_INVALID_REQUEST","reads":0})
    );
    assert_eq!(
        calls(&mut engine)[0]["options"]["commands"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn canvas_appservice_instances_keep_command_queues_isolated() {
    let (mut first, first_id) = fixture();
    let (mut second, second_id) = fixture();
    call(&mut first, first_id, "queue");
    call(&mut second, second_id, "flush");
    assert_eq!(calls(&mut second)[0]["options"]["commands"], json!([]));
    assert!(calls(&mut first).is_empty());
    call(&mut first, first_id, "flush");
    assert_eq!(
        calls(&mut first)[0]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
}

#[test]
fn canvas_offscreen_instances_keep_surfaces_and_queues_isolated() {
    let (mut engine, id) = fixture();
    call(&mut engine, id, "separateOffscreen");
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_ne!(
        events[0]["options"]["canvasId"],
        events[1]["options"]["canvasId"]
    );
    assert_eq!(events[0]["options"]["commands"], json!([]));
    assert_eq!(events[0]["options"]["width"], 8);
    assert_eq!(events[0]["options"]["height"], 9);
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"fillRect","args":[1,2,3,4]}])
    );
    assert_eq!(events[1]["options"]["width"], 4);
    assert_eq!(events[1]["options"]["height"], 5);
}

#[test]
fn canvas_stroke_methods_properties_and_legacy_draw_reset_share_state() {
    let (mut engine, id) = fixture();
    assert_eq!(
        call(&mut engine, id, "strokeState"),
        json!({"value":[
            ["butt","miter",10,0],true,["round","bevel",2,4],["butt","miter",10,0]
        ]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["options"]["reserve"], true);
    assert_eq!(
        events[0]["options"]["commands"][0],
        json!({"op":"setLineCap","args":["round"]})
    );
    assert_eq!(
        events[0]["options"]["commands"][7],
        json!({"op":"restore","args":[]})
    );
}

#[test]
fn canvas_invalid_stroke_property_preserves_state_and_does_not_enqueue() {
    let (mut engine, id) = fixture();
    assert_eq!(
        call(&mut engine, id, "strokeRejected"),
        json!({"value":{"code":"ERR_INVALID_REQUEST","cap":"butt"}})
    );
    assert!(calls(&mut engine).is_empty());
}

// Included by both feature-enabled native providers. These assertions exercise
// their compiled production bootstrap and trusted capture transport; pixel
// semantics remain the renderer and Session integration suites' responsibility.
fn affine_fixture() -> (Engine, ModuleId) {
    let mut engine = Engine::default();
    let module = engine.load_module(br#"
      const ctx=wx.createCanvasContext('affine');Page({});
      exports.record=()=>{
        const voids=[ctx.setTransform(2,1,-.5,3,7,-9)===undefined];
        ctx.save();ctx.beginPath();ctx.rect(0,0,10,8);
        voids.push(ctx.transform(1,-2,3,4,-5,6)===undefined,ctx.clip()===undefined);
        ctx.restore();ctx.fill();ctx.draw(true);ctx.draw();return {voids:voids};
      };
      exports.offscreen=()=>{
        const canvas=wx.createOffscreenCanvas({type:'2d',width:4,height:5});
        const first=canvas.getContext('2d'),second=canvas.getContext('2d');
        const voids=[first.setTransform(1,0,0,1,2,3)===undefined,
          second.transform(2,0,0,3,0,0)===undefined,first.clip()===undefined];
        second.draw();return {same:first===second,voids:voids};
      };
      exports.invalid=()=>{
        ctx.beginPath();let hooks=0;const errors=[];
        const object={toJSON(){hooks++;return 1},valueOf(){hooks++;return 1}};
        const matrices=[[1,0,0,1,0],[1,0,0,1,0,undefined],
          [object,0,0,1,0,0],[[1],0,0,1,0,0],[new Number(1),0,0,1,0,0],
          ['1',0,0,1,0,0],[true,0,0,1,0,0],[null,0,0,1,0,0],
          [NaN,0,0,1,0,0],[Infinity,0,0,1,0,0],[1e100,0,0,1,0,0]];
        for(const method of ['setTransform','transform'])for(const values of matrices){
          try{ctx[method](...values)}catch(error){errors.push(error.code)}
        }
        ctx.clip();ctx.transform(1,0,0,1,2,3);ctx.draw();return {errors:errors,hooks:hooks};
      };
      exports.copyReentry=()=>{
        ctx.beginPath();const errors=[];
        const nested=new Proxy([1],{getOwnPropertyDescriptor(target,key){
          for(const action of [()=>ctx.clip(),()=>ctx.transform(1,0,0,1,0,0),()=>ctx.draw()]){
            try{action()}catch(error){errors.push(error.code)}
          }
          return Object.getOwnPropertyDescriptor(target,key);
        }});
        try{ctx.setTransform(nested,0,0,1,0,0)}catch(error){errors.push(error.code)}
        ctx.setTransform(1,0,0,1,4,5);ctx.clip();ctx.draw();return {errors:errors};
      };
      exports.budget=()=>{
        for(let index=0;index<16384;index++)ctx.beginPath();
        const errors=[];
        for(const action of [()=>ctx.setTransform(1,0,0,1,0,0),
          ()=>ctx.transform(1,0,0,1,0,0),()=>ctx.clip()]){
          try{action()}catch(error){errors.push(error.code)}
        }
        ctx.draw();ctx.setTransform(1,0,0,1,0,0);
        ctx.transform(2,0,0,2,0,0);ctx.clip();ctx.draw();return {errors:errors};
      };
      exports.admission=()=>{
        ctx.setTransform(1,0,0,1,4,5);ctx.clip();
        const push=__container_events.push;let failure,nested,once=false;
        try{__container_events.push=()=>{throw Error('unavailable')};ctx.draw(true)}
        catch(error){failure=error.message}finally{__container_events.push=push}
        __container_events.push=function(event){
          if(!once){once=true;ctx.transform(2,0,0,2,0,0);ctx.clip();
            try{ctx.draw()}catch(error){nested=error.code}}
          return push.call(this,event);
        };
        try{ctx.draw(true)}finally{__container_events.push=push}
        ctx.draw();ctx.draw();return {failure:failure,nested:nested};
      };
      let component,owned;
      exports.owned=()=>{
        __container_registration_module_id='module:affine.js';
        __container_managed_component_modules[__container_registration_module_id]=true;
        const definition=Component({methods:{}});__container_registration_module_id=null;
        component=__container_clone_component_instance(definition,
          {scopeId:'affine',moduleId:'module:affine.js',pageId:11,parentScopeId:null,ownerScopeId:null});
        owned=wx.createCanvasContext('owned-affine',component);
        const voids=[owned.setTransform(2,1,-.5,3,7,-9)===undefined,
          owned.transform(1,-2,3,4,-5,6)===undefined];
        owned.beginPath();owned.rect(0,0,8,8);voids.push(owned.clip()===undefined);
        owned.draw(true);return {voids:voids};
      };
      exports.retire=()=>{
        __container_unmount_component(component.__container_component_index);
        owned.setTransform(1,0,0,1,6,7);owned.transform(2,0,0,2,0,0);owned.clip();
        let code;try{owned.draw()}catch(error){code=error.code}return {code:code};
      };
      exports.independent=()=>{ctx.clip();ctx.draw();return true;};
    "#).unwrap();
    (engine, module)
}

#[test]
fn canvas_affine_methods_preserve_scalar_order_void_returns_and_draw_boundaries() {
    let (mut engine, id) = affine_fixture();
    assert_eq!(
        call(&mut engine, id, "record"),
        json!({"voids":[true,true,true]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["options"]["reserve"], true);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[2,1,-0.5,3,7,-9]},
            {"op":"save","args":[]},{"op":"beginPath","args":[]},
            {"op":"rect","args":[0,0,10,8]},
            {"op":"transform","args":[1,-2,3,4,-5,6]},
            {"op":"clip","args":[]},{"op":"restore","args":[]},{"op":"fill","args":[]}
        ])
    );
    assert_eq!(events[1]["options"]["reserve"], false);
    assert_eq!(events[1]["options"]["commands"], json!([]));
}

#[test]
fn canvas_affine_offscreen_identity_shares_commands_and_void_method_contract() {
    let (mut engine, id) = affine_fixture();
    assert_eq!(
        call(&mut engine, id, "offscreen"),
        json!({"same":true,"voids":[true,true,true]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["options"]["width"], 4);
    assert_eq!(events[0]["options"]["height"], 5);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[1,0,0,1,2,3]},
            {"op":"transform","args":[2,0,0,3,0,0]},{"op":"clip","args":[]}
        ])
    );
}

#[test]
fn canvas_affine_invalid_scalars_reject_before_enqueue_without_conversion_hooks() {
    let (mut engine, id) = affine_fixture();
    let result = call(&mut engine, id, "invalid");
    assert_eq!(result["hooks"], 0);
    assert_eq!(result["errors"], json!(vec!["ERR_INVALID_REQUEST"; 22]));
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"beginPath","args":[]},{"op":"clip","args":[]},
            {"op":"transform","args":[1,0,0,1,2,3]}
        ])
    );
}

#[test]
fn canvas_affine_argument_copy_reentry_preserves_prefix_and_releases_guard() {
    let (mut engine, id) = affine_fixture();
    assert_eq!(
        call(&mut engine, id, "copyReentry"),
        json!({"errors":vec!["ERR_INVALID_REQUEST";4]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"beginPath","args":[]},{"op":"setTransform","args":[1,0,0,1,4,5]},
            {"op":"clip","args":[]}
        ])
    );
}

#[test]
fn canvas_affine_command_budget_rejects_all_members_and_releases_after_draw() {
    let (mut engine, id) = affine_fixture();
    assert_eq!(
        call(&mut engine, id, "budget"),
        json!({"errors":vec!["ERR_RESOURCE_LIMIT";3]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    let commands = events[0]["options"]["commands"].as_array().unwrap();
    assert_eq!(commands.len(), 16384);
    assert!(commands
        .iter()
        .all(|command| command == &json!({"op":"beginPath","args":[]})));
    assert_eq!(
        events[1]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[1,0,0,1,0,0]},
            {"op":"transform","args":[2,0,0,2,0,0]},{"op":"clip","args":[]}
        ])
    );
}

#[test]
fn canvas_affine_failed_draw_retries_once_and_reentrant_work_waits_for_next_draw() {
    let (mut engine, id) = affine_fixture();
    assert_eq!(
        call(&mut engine, id, "admission"),
        json!({"failure":"unavailable","nested":"ERR_INVALID_REQUEST"})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 3);
    assert_eq!(events[0]["options"]["reserve"], true);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[1,0,0,1,4,5]},{"op":"clip","args":[]}
        ])
    );
    assert_eq!(
        events[1]["options"]["commands"],
        json!([
            {"op":"transform","args":[2,0,0,2,0,0]},{"op":"clip","args":[]}
        ])
    );
    assert_eq!(events[2]["options"]["commands"], json!([]));
}

#[test]
fn canvas_affine_owned_commands_use_trusted_receiver_and_retire_with_component() {
    let (mut engine, id) = affine_fixture();
    assert!(engine
        .dispatch_lifecycle_notification("session", &json!({}))
        .unwrap());
    engine
        .prepare_page_mirror(
            "affine-owner",
            &json!([
                {"index":0,"instanceId":11,"route":"pages/affine"}
            ]),
        )
        .unwrap();
    engine.commit_page_mirror("affine-owner").unwrap();
    assert_eq!(
        call(&mut engine, id, "owned"),
        json!({"voids":[true,true,true]})
    );
    assert!(calls(&mut engine).is_empty());
    let captured = engine.capture_owned_canvas_requests(0).unwrap();
    let requests = captured["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["kind"], "context");
    assert_eq!(requests[1]["kind"], "draw");
    assert_eq!(requests[0]["context"], requests[1]["context"]);
    assert_eq!(
        requests[1]["owner"],
        json!({"pageId":"11","scopeId":"affine"})
    );
    let receivers = engine
        .capture_receiver_incarnations(11, &["affine".into()])
        .unwrap();
    assert_eq!(requests[0]["receivers"], receivers);
    assert_eq!(requests[1]["receivers"], receivers);
    assert_eq!(requests[1]["options"]["canvasId"], "owned-affine");
    assert_eq!(requests[1]["options"]["reserve"], true);
    assert_eq!(
        requests[1]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[2,1,-0.5,3,7,-9]},
            {"op":"transform","args":[1,-2,3,4,-5,6]},
            {"op":"beginPath","args":[]},{"op":"rect","args":[0,0,8,8]},
            {"op":"clip","args":[]}
        ])
    );
    let sequence = requests[1]["sequence"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        call(&mut engine, id, "retire"),
        json!({"code":"ERR_CANCELLED"})
    );
    assert_eq!(
        engine.capture_owned_canvas_requests(sequence).unwrap()["requests"],
        json!([])
    );
    assert!(calls(&mut engine).is_empty());
    assert_eq!(call(&mut engine, id, "independent"), true);
    assert_eq!(
        calls(&mut engine)[0]["options"]["commands"],
        json!([{"op":"clip","args":[]}])
    );
}

fn arcto_fixture() -> (Engine, ModuleId) {
    let mut engine = Engine::default();
    let module = engine
        .load_module(
            br#"
      const ctx=wx.createCanvasContext('arcto');Page({});
      exports.record=()=>{
        const first=ctx.arcTo(2,-3,5,7,11)===undefined;ctx.draw(true);
        const canvas=wx.createOffscreenCanvas({type:'2d',width:8,height:8});
        const a=canvas.getContext('2d'),b=canvas.getContext('2d');
        const second=a.arcTo(1,2,3,4,0)===undefined;b.draw();
        return {first:first,second:second,same:a===b};
      };
      exports.invalid=()=>{
        ctx.beginPath();let hooks=0;const errors=[];
        const object={toJSON(){hooks++;return 1},valueOf(){hooks++;return 1}};
        const values=[[1,2,3,4],[1,2,3,4,undefined],[object,2,3,4,5],
          ['1',2,3,4,5],[true,2,3,4,5],[null,2,3,4,5],[[1],2,3,4,5],
          [NaN,2,3,4,5],[Infinity,2,3,4,5],[1e100,2,3,4,5],
          [1,2,3,4,-1],[1,2,3,4,-1e-100]];
        for(const args of values)try{ctx.arcTo(...args)}catch(e){errors.push(e.code)}
        const nested=new Proxy([1],{getOwnPropertyDescriptor(target,key){
          for(const action of [()=>ctx.arcTo(1,2,3,4,5),()=>ctx.draw()])
            try{action()}catch(e){errors.push(e.code)}
          return Object.getOwnPropertyDescriptor(target,key)}});
        try{ctx.arcTo(nested,2,3,4,5)}catch(e){errors.push(e.code)}
        ctx.arcTo(1,2,3,4,0);ctx.draw();return {hooks:hooks,errors:errors};
      };
      exports.admission=()=>{
        ctx.arcTo(1,2,3,4,5);const push=__container_events.push;let failure;
        try{__container_events.push=()=>{throw Error('arcto unavailable')};ctx.draw(true)}
        catch(e){failure=e.message}finally{__container_events.push=push}
        let entered=false,nested;
        __container_events.push=function(event){if(!entered){entered=true;ctx.arcTo(6,7,8,9,10);
          try{ctx.draw()}catch(e){nested=e.code}}return push.call(this,event)};
        try{ctx.draw(true)}finally{__container_events.push=push}
        ctx.draw();ctx.draw();return {failure:failure,nested:nested};
      };
      let component,owned;
      exports.owned=()=>{
        __container_registration_module_id='module:arcto.js';
        __container_managed_component_modules[__container_registration_module_id]=true;
        const definition=Component({methods:{}});__container_registration_module_id=null;
        component=__container_clone_component_instance(definition,
          {scopeId:'arcto',moduleId:'module:arcto.js',pageId:11,parentScopeId:null,ownerScopeId:null});
        owned=wx.createCanvasContext('owned-arcto',component);
        owned.setTransform(1,0,0,1,6,7);owned.beginPath();owned.moveTo(0,0);
        const voidResult=owned.arcTo(8,0,8,8,4)===undefined;
        owned.clip();owned.draw(true);return {voidResult:voidResult};
      };
      exports.retire=()=>{
        __container_unmount_component(component.__container_component_index);
        owned.arcTo(8,8,0,8,4);
        let code;try{owned.draw()}catch(error){code=error.code}return {code:code};
      };
      exports.independent=()=>{ctx.arcTo(1,2,3,4,5);ctx.draw();return true;};
    "#,
        )
        .unwrap();
    (engine, module)
}

#[test]
fn canvas_arcto_five_scalar_void_transport_reaches_legacy_and_offscreen_contexts() {
    let (mut engine, id) = arcto_fixture();
    assert_eq!(
        call(&mut engine, id, "record"),
        json!({"first":true,"second":true,"same":true})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([{"op":"arcTo","args":[2,-3,5,7,11]}])
    );
    assert_eq!(events[0]["options"]["reserve"], true);
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"arcTo","args":[1,2,3,4,0]}])
    );
    assert_eq!(events[1]["options"]["width"], 8);
    assert_eq!(events[1]["options"]["height"], 8);
}

#[test]
fn canvas_arcto_invalid_scalars_and_argument_copy_reentry_leave_no_partial_command() {
    let (mut engine, id) = arcto_fixture();
    assert_eq!(
        call(&mut engine, id, "invalid"),
        json!({"hooks":0,"errors":vec!["ERR_INVALID_REQUEST";15]})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 1);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([
            {"op":"beginPath","args":[]},{"op":"arcTo","args":[1,2,3,4,0]}
        ])
    );
}

#[test]
fn canvas_arcto_failed_admission_retries_once_and_defers_reentrant_commands() {
    let (mut engine, id) = arcto_fixture();
    assert_eq!(
        call(&mut engine, id, "admission"),
        json!({"failure":"arcto unavailable","nested":"ERR_INVALID_REQUEST"})
    );
    let events = calls(&mut engine);
    assert_eq!(events.len(), 3);
    assert_eq!(
        events[0]["options"]["commands"],
        json!([{"op":"arcTo","args":[1,2,3,4,5]}])
    );
    assert_eq!(
        events[1]["options"]["commands"],
        json!([{"op":"arcTo","args":[6,7,8,9,10]}])
    );
    assert_eq!(events[2]["options"]["commands"], json!([]));
}

#[test]
fn canvas_arcto_owned_commands_use_trusted_receiver_and_retire_with_component() {
    let (mut engine, id) = arcto_fixture();
    assert!(engine
        .dispatch_lifecycle_notification("session", &json!({}))
        .unwrap());
    engine
        .prepare_page_mirror(
            "arcto-owner",
            &json!([
                {"index":0,"instanceId":11,"route":"pages/arcto"}
            ]),
        )
        .unwrap();
    engine.commit_page_mirror("arcto-owner").unwrap();
    assert_eq!(call(&mut engine, id, "owned"), json!({"voidResult":true}));
    assert!(calls(&mut engine).is_empty());
    let captured = engine.capture_owned_canvas_requests(0).unwrap();
    let requests = captured["requests"].as_array().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["kind"], "context");
    assert_eq!(requests[1]["kind"], "draw");
    assert_eq!(requests[0]["context"], requests[1]["context"]);
    assert_eq!(
        requests[1]["owner"],
        json!({"pageId":"11","scopeId":"arcto"})
    );
    let receivers = engine
        .capture_receiver_incarnations(11, &["arcto".into()])
        .unwrap();
    assert_eq!(requests[0]["receivers"], receivers);
    assert_eq!(requests[1]["receivers"], receivers);
    assert_eq!(requests[1]["options"]["canvasId"], "owned-arcto");
    assert_eq!(requests[1]["options"]["reserve"], true);
    assert_eq!(
        requests[1]["options"]["commands"],
        json!([
            {"op":"setTransform","args":[1,0,0,1,6,7]},
            {"op":"beginPath","args":[]},{"op":"moveTo","args":[0,0]},
            {"op":"arcTo","args":[8,0,8,8,4]},{"op":"clip","args":[]}
        ])
    );
    let sequence = requests[1]["sequence"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        call(&mut engine, id, "retire"),
        json!({"code":"ERR_CANCELLED"})
    );
    assert_eq!(
        engine.capture_owned_canvas_requests(sequence).unwrap()["requests"],
        json!([])
    );
    assert!(calls(&mut engine).is_empty());
    assert_eq!(call(&mut engine, id, "independent"), true);
    assert_eq!(
        calls(&mut engine)[0]["options"]["commands"],
        json!([{"op":"arcTo","args":[1,2,3,4,5]}])
    );
}
