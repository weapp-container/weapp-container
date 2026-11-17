use container_core::{CallTarget, JsEngine};
use serde_json::json;

fn logger_engine() -> Engine {
    let mut engine = Engine::default();
    engine
        .set_capabilities(&std::collections::BTreeMap::from([
            ("wx.getLogManager".into(), "partial".into()),
            ("object:LogManager.log".into(), "partial".into()),
            ("object:LogManager.warn".into(), "partial".into()),
        ]))
        .unwrap();
    engine
}

#[test]
fn native_log_manager_preserves_near_100kib_and_exact_once_private_drain() {
    let mut engine = logger_engine();
    let module = engine.load_module(br#"
      const logger=wx.getLogManager({level:1});
      exports.run=function(){logger.log('x'.repeat(100000),...Array.from({length:32},function(_,i){return i}));return 17};
      exports.private=function(){return [typeof __container_host_log_manager_write,typeof __container_log_manager_instrument]};
    "#).unwrap();
    assert_eq!(
        engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "run".into()
                },
                vec![]
            )
            .unwrap(),
        vec![json!(17)]
    );
    let logs = engine.take_log_manager_records();
    assert_eq!(logs.records.len(), 1);
    let arguments = &logs.records[0]["arguments"];
    assert_eq!(arguments["roots"].as_array().unwrap().len(), 33);
    assert_eq!(
        arguments["nodes"][0]["value"].as_str().unwrap().len(),
        100000
    );
    assert!(engine.take_log_manager_records().records.is_empty());
    assert_eq!(
        engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "private".into()
                },
                vec![]
            )
            .unwrap(),
        vec![json!("undefined"), json!("undefined")]
    );
}

#[test]
fn native_log_manager_survives_failed_public_effect_json_and_keeps_utf16() {
    let mut engine = logger_engine();
    let module=engine.load_module(br#"
      const logger=wx.getLogManager({level:1});
      exports.run=function(){
        const cyclic={get bad(){throw Error('getter')},toJSON(){throw Error('toJSON')}};cyclic.self=cyclic;
        logger.warn('before',cyclic,12n,'\uD800');
        globalThis.ordinaryEffect=41;
        Object.prototype.toJSON=function(){throw Error('public JSON sabotaged')};return {};
      };
      exports.restore=function(){delete Object.prototype.toJSON;return globalThis.ordinaryEffect};
    "#).unwrap();
    assert!(engine
        .call(
            CallTarget::Module {
                id: module,
                export: "run".into()
            },
            vec![]
        )
        .is_err());
    let logs = engine.take_log_manager_records();
    assert_eq!(logs.records.len(), 1);
    let graph = &logs.records[0]["arguments"];
    assert_eq!(graph["nodes"][0]["value"], "before");
    let string_id = graph["roots"][3].as_u64().unwrap() as usize;
    assert_eq!(graph["nodes"][string_id]["value"]["utf16"], "d800");
    assert!(engine.take_log_manager_records().records.is_empty());
    assert_eq!(
        engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "restore".into()
                },
                vec![]
            )
            .unwrap(),
        vec![json!(41)]
    );
    JsEngine::interrupt(&mut engine);
    assert!(engine.take_log_manager_records().records.is_empty());
}

#[test]
fn native_log_manager_splits_wire_budget_and_keeps_unconsumed_tail() {
    let mut engine = logger_engine();
    let module=engine.load_module(br#"
      exports.run=function(){const logger=wx.getLogManager({level:1});for(let i=0;i<3;i++)logger.log('\\'.repeat(49000),i);};
    "#).unwrap();
    engine
        .call(
            CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            vec![],
        )
        .unwrap();
    for expected in 0..3 {
        let drain = engine.take_log_manager_records();
        assert_eq!(drain.records.len(), 1);
        let record = &drain.records[0];
        assert_eq!(record["arguments"]["nodes"][1]["value"], expected);
        let wire = json!({"effects":[{"console":{"entries":[{"level":"log","message":record.to_string()}]}}]});
        assert!(serde_json::to_vec(&wire).unwrap().len() < 512 * 1024);
    }
    assert!(engine.take_log_manager_records().records.is_empty());
}

#[test]
fn native_log_manager_liveness_query_is_separate_from_ingress_and_terminal_regrant() {
    let mut engine = logger_engine();
    let module=engine.load_module(br#"
      const logger=wx.getLogManager({level:1});
      exports.empty=function(){wx.getLogManager({level:1});return true};
      exports.queue=function(){logger.log('queued');return true};
      exports.late=function(){let borrowed='',factory='';try{logger.log('late')}catch(e){borrowed=e.code}try{wx.getLogManager()}catch(e){factory=e.code}return [borrowed,factory]};
    "#).unwrap();
    for _ in 0..3 {
        engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "empty".into(),
                },
                vec![],
            )
            .unwrap();
    }
    let empty = engine.take_log_manager_records();
    assert!(empty.records.is_empty());
    assert_eq!(empty.dropped, 0);
    engine
        .call(
            CallTarget::Module {
                id: module,
                export: "queue".into(),
            },
            vec![],
        )
        .unwrap();
    let journal = engine.log_manager_journal().unwrap();
    journal.retire();
    assert!(!journal.is_active());
    assert!(journal.take().records.is_empty());
    for _ in 0..2 {
        engine
            .set_capabilities(&std::collections::BTreeMap::from([
                ("wx.getLogManager".into(), "partial".into()),
                ("object:LogManager.log".into(), "partial".into()),
            ]))
            .unwrap();
        assert_eq!(
            engine
                .call(
                    CallTarget::Module {
                        id: module,
                        export: "late".into()
                    },
                    vec![]
                )
                .unwrap(),
            vec![
                json!("ERR_UNSUPPORTED_CAPABILITY"),
                json!("ERR_UNSUPPORTED_CAPABILITY")
            ]
        );
    }
    let late = journal.take();
    assert!(late.records.is_empty());
    assert_eq!(late.dropped, 0);
}

#[test]
fn native_log_manager_engine_drop_retires_the_retained_native_arc() {
    let mut engine = logger_engine();
    let journal = engine.log_manager_journal().unwrap();
    let module=engine.load_module(br#"exports.run=function(){wx.getLogManager({level:1}).log('queued before engine drop');return true};"#).unwrap();
    engine
        .call(
            CallTarget::Module {
                id: module,
                export: "run".into(),
            },
            vec![],
        )
        .unwrap();
    assert!(journal.is_active());
    drop(engine);
    assert!(!journal.is_active());
    let drained = journal.take();
    assert!(drained.records.is_empty());
    assert_eq!(drained.dropped, 0);
}

#[test]
fn native_log_manager_both_interrupt_traits_retire_the_retained_native_arc() {
    for adapter in [false, true] {
        let mut engine = logger_engine();
        let journal = engine.log_manager_journal().unwrap();
        let module=engine.load_module(br#"exports.run=function(){wx.getLogManager({level:1}).log('queued before interrupt');return true};"#).unwrap();
        engine
            .call(
                CallTarget::Module {
                    id: module,
                    export: "run".into(),
                },
                vec![],
            )
            .unwrap();
        if adapter {
            super::JsEngineAdapter::interrupt(&mut engine);
        } else {
            JsEngine::interrupt(&mut engine);
        }
        assert!(!journal.is_active());
        assert!(journal.take().records.is_empty());
    }
}
