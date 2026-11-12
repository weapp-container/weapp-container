use container_core::{CallTarget, JsEngine, ModuleId};
use serde_json::{json, Value};

fn fixture(source: &[u8]) -> (NativeEngine, ModuleId) {
    let mut engine = NativeEngine::default();
    let module = engine
        .load_module(source)
        .expect("real engine animation fixture");
    (engine, module)
}

fn call(engine: &mut NativeEngine, id: ModuleId, export: &str) -> Value {
    engine
        .call(
            CallTarget::Module {
                id,
                export: export.into(),
            },
            Vec::new(),
        )
        .expect("animation fixture call")
        .remove(0)
}

#[test]
fn animation_all_operations_export_serializable_arguments_and_chain() {
    let (mut engine, id) = fixture(br#"
      exports.run = function() {
        const a=wx.createAnimation({duration:80,timingFunction:'ease-in',transformOrigin:'20% 30% 0'});
        const chained=a.backgroundColor('#123456').bottom(4).height('auto').left('2em')
          .matrix().matrix(1,0,0,1,5,6).matrix3d()
          .matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,3,4,5,1)
          .opacity(0.5).right('1px').rotate(12).rotate3d(1,0,0,20)
          .rotateX(1).rotateY(2).rotateZ(3).scale(2).scale3d(1,2,3)
          .scaleX(4).scaleY(5).scaleZ(6).skew(7,8).skewX(9).skewY(10)
          .top(11).translate().translate(12).translate3d().translate3d(13,14)
          .translateX(15).translateY(16).translateZ(17).width('90%').step({delay:20});
        return {same:chained===a,value:a.export()};
      };
    "#);
    let result = call(&mut engine, id, "run");
    assert_eq!(result["same"], true);
    let operations = result["value"]["actions"][0]["animates"]
        .as_array()
        .unwrap();
    assert_eq!(operations.len(), 32);
    assert_eq!(operations[5], json!({"type":"matrix","args":[1,0,0,1,5,6]}));
    assert_eq!(operations[15], json!({"type":"scale","args":[2,2]}));
    assert_eq!(operations[24], json!({"type":"translate","args":[0,0]}));
    assert_eq!(operations[25], json!({"type":"translate","args":[12,0]}));
    assert_eq!(operations[26], json!({"type":"translate3d","args":[0,0,0]}));
    assert_eq!(
        operations[27],
        json!({"type":"translate3d","args":[13,14,0]})
    );
    assert_eq!(
        result["value"]["actions"][0]["option"],
        json!({
            "delay":20,"duration":80,"timingFunction":"ease-in","transformOrigin":"20% 30% 0"
        })
    );
}

#[test]
fn animation_step_reads_options_before_committing_and_rejects_reentrant_mutation() {
    let (mut engine, id) = fixture(
        br#"
      exports.run=function(){
        const a=wx.createAnimation(), errors=[];
        a.opacity(0.25);
        const broken={get duration(){throw new Error('option-read');}};
        try{a.step(broken);}catch(error){errors.push(error.message);}
        let reads=0;
        a.step({get duration(){
          reads++;
          for(const mutate of [()=>a.translateX(999),()=>a.step(),()=>a.export()]){
            try{mutate();}catch(error){errors.push(error.code);}
          }
          return 12;
        }});
        return {reads:reads,errors:errors,value:a.export()};
      };
    "#,
    );
    let result = call(&mut engine, id, "run");
    assert_eq!(result["reads"], 1);
    assert_eq!(
        result["errors"],
        json!([
            "option-read",
            "ERR_INVALID_REQUEST",
            "ERR_INVALID_REQUEST",
            "ERR_INVALID_REQUEST"
        ])
    );
    assert_eq!(
        result["value"]["actions"][0]["animates"],
        json!([{"type":"opacity","args":[0.25]}])
    );
    assert_eq!(result["value"]["actions"][0]["option"]["duration"], 12);
}

#[test]
fn animation_invalid_values_never_enter_the_queue_or_run_serializers() {
    let (mut engine, id) = fixture(
        br#"
      exports.run=function(){
        const a=wx.createAnimation(), errors=[];
        let serialized=0;
        const invalid={toJSON(){serialized++;return 1;}};
        invalid.self=invalid;
        for(const mutate of [()=>a.rotate(NaN),()=>a.scale(Infinity),()=>a.translate3d(1,null),
          ()=>a.matrix(1,2),()=>a.matrix3d(...Array(16).fill(Infinity)),
          ()=>a.opacity(-1),()=>a.width(invalid),()=>a.backgroundColor(invalid),
          ()=>a.step({duration:-1}),()=>a.step({delay:Infinity}),
          ()=>a.step({timingFunction:'cubic-bezier(0,0,1,1)'}),
          ()=>a.step({transformOrigin:invalid}),()=>wx.createAnimation({duration:NaN})]){
          try{mutate();}catch(error){errors.push(error.code);}
        }
        a.opacity(1).step();
        return {errors:errors,serialized:serialized,value:a.export()};
      };
    "#,
    );
    let result = call(&mut engine, id, "run");
    assert_eq!(result["errors"], json!(vec!["ERR_INVALID_REQUEST"; 13]));
    assert_eq!(result["serialized"], 0);
    assert_eq!(
        result["value"]["actions"][0]["animates"],
        json!([{"type":"opacity","args":[1]}])
    );
}

#[test]
fn animation_export_retires_unstepped_operations_and_keeps_snapshots_independent() {
    let (mut engine, id) = fixture(
        br#"
      exports.run=function(){
        const defaults={duration:70}, a=wx.createAnimation(defaults), b=wx.createAnimation();
        defaults.duration=999;
        a.translateX(1).step();a.translateX(2);
        const first=a.export();
        first.actions[0].animates[0].args[0]=888;
        a.opacity(0.5).step();
        b.rotate(3).step();
        return {first:first,second:a.export(),empty:a.export(),other:b.export()};
      };
    "#,
    );
    let result = call(&mut engine, id, "run");
    assert_eq!(result["first"]["actions"][0]["option"]["duration"], 70);
    assert_eq!(
        result["second"]["actions"][0]["animates"],
        json!([{"type":"opacity","args":[0.5]}])
    );
    assert_eq!(result["empty"], json!({"actions":[]}));
    assert_eq!(
        result["other"]["actions"][0]["animates"],
        json!([{"type":"rotate","args":[3]}])
    );
}

#[test]
fn animation_queue_limits_release_on_export_and_leave_failed_step_recoverable() {
    let (mut engine, id) = fixture(
        br#"
      exports.run=function(){
        const a=wx.createAnimation(), errors=[];
        for(let i=0;i<16384;i++)a.translateX(i);
        try{a.translateX(16384);}catch(error){errors.push(error.code);}
        a.step();const operations=a.export().actions[0].animates.length;
        for(let i=0;i<4096;i++)a.step();
        a.opacity(0.5);
        try{a.step();}catch(error){errors.push(error.code);}
        const steps=a.export().actions.length;
        a.opacity(1).step();
        return {errors:errors,operations:operations,steps:steps,recovered:a.export()};
      };
    "#,
    );
    let result = call(&mut engine, id, "run");
    assert_eq!(
        result["errors"],
        json!(["ERR_RESOURCE_LIMIT", "ERR_RESOURCE_LIMIT"])
    );
    assert_eq!(result["operations"], 16384);
    assert_eq!(result["steps"], 4096);
    assert_eq!(
        result["recovered"]["actions"][0]["animates"],
        json!([{"type":"opacity","args":[1]}])
    );
}

#[test]
fn animation_private_queue_ignores_replaced_intrinsics_and_legacy_aliases() {
    let (mut engine, id) = fixture(br#"
      exports.run=function(){
        const a=wx.createAnimation();
        const define=Object.defineProperty, push=Array.prototype.push, finite=Number.isFinite;
        const legacy=__container_animation, clone=__container_clone;
        let value;
        try{
          Object.defineProperty=function(){throw new Error('replaced define');};
          Array.prototype.push=function(){throw new Error('replaced push');};
          Number.isFinite=function(){return false;};
          __container_animation=function(){throw new Error('replaced legacy');};
          __container_clone=function(){throw new Error('replaced clone');};
          define(Object.prototype,'0',{configurable:true,set(){throw new Error('inherited numeric setter');}});
          a.translate(1).step();value=a.export();
          wx.createAnimation().opacity(0.5).step().export();
        }finally{
          Object.defineProperty=define;Array.prototype.push=push;Number.isFinite=finite;
          __container_animation=legacy;__container_clone=clone;delete Object.prototype['0'];
        }
        return value;
      };
    "#);
    let result = call(&mut engine, id, "run");
    assert_eq!(
        result["actions"][0]["animates"],
        json!([{"type":"translate","args":[1,0]}])
    );
}

#[test]
fn animation_instances_have_no_shared_queue_or_host_resource() {
    let source = br#"
      const animation=wx.createAnimation();
      exports.write=function(){animation.translateX(4).step();return null;};
      exports.read=function(){return animation.export();};
      exports.aliases=function(){return {types:[typeof __container_animation_options,typeof __container_animation,typeof __container_create_animation]};};
    "#;
    let (mut first, first_id) = fixture(source);
    let (mut second, second_id) = fixture(source);
    call(&mut first, first_id, "write");
    assert_eq!(call(&mut second, second_id, "read"), json!({"actions":[]}));
    assert_eq!(
        call(&mut first, first_id, "read")["actions"][0]["animates"],
        json!([{"type":"translateX","args":[4]}])
    );
    assert_eq!(
        call(&mut second, second_id, "aliases")["types"],
        json!(["function", "function", "function"])
    );
    for engine in [&mut first, &mut second] {
        assert!(engine
            .drain_host_events()
            .unwrap()
            .iter()
            .all(|batch| batch["events"].as_array().is_none_or(Vec::is_empty)));
    }
}
