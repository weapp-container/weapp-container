use super::QuickJsEngine as Engine;
use container_core::{CallTarget, JsEngine};
use serde_json::{json, Value};

fn global(engine: &mut Engine, name: &str, args: Vec<Value>) -> Value {
    engine
        .call(CallTarget::Global { name: name.into() }, args)
        .unwrap()
        .remove(0)
}

#[test]
fn console_groups_cross_drain_boundaries_and_reset_when_disabled() {
    let mut engine = Engine::default();
    global(
        &mut engine,
        "__container_set_dev_console_enabled",
        vec![json!(true)],
    );
    let id=engine.load_module(br#"
      exports.first=function(){console.group('outer');console.info('first');console.group('inner');console.warn('second');};
      exports.second=function(){console.debug('third');console.groupEnd();console.error('fourth');console.groupEnd();console.groupEnd();console.log('outside');};
      exports.disabled=function(){console.group('discarded');console.log('discarded');};
    "#).unwrap();
    engine
        .call(
            CallTarget::Module {
                id,
                export: "first".into(),
            },
            vec![],
        )
        .unwrap();
    let batch = global(&mut engine, "__container_drain_events", vec![]);
    assert_eq!(
        batch["console"]["entries"],
        json!([
          {"level":"log","message":"outer","groupDepth":0},
          {"level":"info","message":"  first","groupDepth":1},
          {"level":"log","message":"  inner","groupDepth":1},
          {"level":"warn","message":"    second","groupDepth":2}
        ])
    );
    engine
        .call(
            CallTarget::Module {
                id,
                export: "second".into(),
            },
            vec![],
        )
        .unwrap();
    let batch = global(&mut engine, "__container_drain_events", vec![]);
    assert_eq!(
        batch["console"]["entries"],
        json!([
          {"level":"debug","message":"    third","groupDepth":2},
          {"level":"error","message":"  fourth","groupDepth":1},
          {"level":"log","message":"outside","groupDepth":0}
        ])
    );
    global(
        &mut engine,
        "__container_set_dev_console_enabled",
        vec![json!(false)],
    );
    engine
        .call(
            CallTarget::Module {
                id,
                export: "disabled".into(),
            },
            vec![],
        )
        .unwrap();
    assert_eq!(
        global(&mut engine, "__container_drain_events", vec![])["console"]["entries"],
        json!([])
    );
    global(
        &mut engine,
        "__container_set_dev_console_enabled",
        vec![json!(true)],
    );
    engine
        .call(
            CallTarget::Module {
                id,
                export: "second".into(),
            },
            vec![],
        )
        .unwrap();
    assert_eq!(
        global(&mut engine, "__container_drain_events", vec![])["console"]["entries"][0]
            ["groupDepth"],
        0
    );
}

#[test]
fn console_remains_bounded_and_never_evaluates_accessors() {
    let mut engine = Engine::default();
    global(
        &mut engine,
        "__container_set_dev_console_enabled",
        vec![json!(true)],
    );
    let id=engine.load_module(br#"
      exports.run=function(){
        let reads=0;
        const value={};Object.defineProperty(value,'sensitive',{enumerable:true,get:function(){reads++;throw new Error('must not read');}});
        console.log(value);
        for(let index=0;index<180;index++)console.group('bounded');
        return reads;
      };
    "#).unwrap();
    assert_eq!(
        engine
            .call(
                CallTarget::Module {
                    id,
                    export: "run".into()
                },
                vec![]
            )
            .unwrap(),
        vec![json!(0)]
    );
    let batch = global(&mut engine, "__container_drain_events", vec![]);
    let entries = batch["console"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 128);
    assert!(entries
        .iter()
        .all(|entry| entry["groupDepth"].as_u64().unwrap() <= 32));
    assert_eq!(entries[0]["message"], "{sensitive: [Accessor]}");
    assert!(batch["console"]["dropped"].as_u64().unwrap() > 0);
}
