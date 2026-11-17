// Both adapters run this contract inside their native JavaScript engine.
use container_core::{CallTarget, JsEngine, ModuleId, ValueBatch};
use serde_json::{json, Value};

fn timer_fixture(engine: &mut impl JsEngine, source: &str) -> ModuleId {
    engine
        .load_module(
            format!(
                "globalThis.__timer_clock = 1000; Date.now = () => __timer_clock; \
         globalThis.__timer_trace = []; \
         exports.trace = () => __timer_trace; {source}"
            )
            .as_bytes(),
        )
        .unwrap()
}

fn timer_trace(engine: &mut impl JsEngine, module: ModuleId) -> ValueBatch {
    engine
        .call(
            CallTarget::Module {
                id: module,
                export: "trace".into(),
            },
            vec![],
        )
        .unwrap()
}

fn poll_timers(
    engine: &mut impl JsEngine,
    now: Value,
    budget: Option<Value>,
) -> Result<ValueBatch, container_core::EngineError> {
    let mut args = vec![now];
    if let Some(budget) = budget {
        args.push(budget);
    }
    engine.call(
        CallTarget::Global {
            name: "__container_drain_timers".into(),
        },
        args,
    )
}

fn timer_events(engine: &mut impl JsEngine) -> Value {
    engine
        .call(
            CallTarget::Global {
                name: "__container_drain_events".into(),
            },
            vec![],
        )
        .unwrap()
        .remove(0)
}

fn timer_self_cancel_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        const id = setInterval(() => { __timer_trace.push("interval"); clearInterval(id); }, 0);
        setTimeout(() => __timer_trace.push("neighbor"), 0);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1), json!(2)]
    );
    assert!(poll_timers(engine, json!(1000), None).unwrap().is_empty());
    assert_eq!(
        timer_trace(engine, module),
        vec![json!("interval"), json!("neighbor")]
    );
}

fn timer_deadline_order_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        setTimeout(() => __timer_trace.push("late"), 30);
        setTimeout(() => __timer_trace.push("first-tie"), 10);
        setTimeout(() => __timer_trace.push("second-tie"), 10);
        setTimeout(() => __timer_trace.push("middle"), 20);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1100), None).unwrap(),
        vec![json!(2), json!(3), json!(4), json!(1)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![
            json!("first-tie"),
            json!("second-tie"),
            json!("middle"),
            json!("late")
        ]
    );
}

fn timer_microtask_checkpoint_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        Promise.resolve().then(() => __timer_trace.push("previous-task"));
        setTimeout(() => {
            __timer_trace.push("a");
            Promise.resolve().then(() => { __timer_trace.push("promise"); clearTimeout(b); });
            queueMicrotask(() => __timer_trace.push("microtask"));
        }, 0);
        const b = setTimeout(() => __timer_trace.push("cancelled"), 0);
        setTimeout(() => __timer_trace.push("c"), 0);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1), json!(3)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![
            json!("previous-task"),
            json!("a"),
            json!("promise"),
            json!("microtask"),
            json!("c")
        ]
    );
}

fn timer_nested_deferred_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        setTimeout(() => {
            __timer_trace.push("a");
            setTimeout(() => __timer_trace.push("nested"), 0);
            Promise.resolve().then(() => {
                __timer_trace.push("promise");
                setTimeout(() => __timer_trace.push("promise-nested"), 0);
            });
        }, 0);
        setTimeout(() => __timer_trace.push("b"), 0);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1), json!(2)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![json!("a"), json!("promise"), json!("b")]
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(3), json!(4)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![
            json!("a"),
            json!("promise"),
            json!("b"),
            json!("nested"),
            json!("promise-nested")
        ]
    );
}

fn timer_recursive_deferred_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        let count = 0;
        function again() { __timer_trace.push(++count); if (count < 12) setTimeout(again, 0); }
        setTimeout(again, 0);
    "#,
    );
    for id in 1..=12 {
        assert_eq!(
            poll_timers(engine, json!(1000), None).unwrap(),
            vec![json!(id)]
        );
        assert_eq!(timer_trace(engine, module).len(), id as usize);
    }
    assert!(poll_timers(engine, json!(1000), None).unwrap().is_empty());
}

fn timer_budget_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        for (let index = 1; index <= 7; index++) setTimeout(() => __timer_trace.push(index), 0);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), Some(json!(2))).unwrap(),
        vec![json!(1), json!(2)]
    );
    assert_eq!(
        timer_events(engine)["events"],
        json!([{"type":"timer.yield","reason":"task-budget","limit":2,"pending":5}])
    );
    assert_eq!(
        poll_timers(engine, json!(1000), Some(json!(3))).unwrap(),
        vec![json!(3), json!(4), json!(5)]
    );
    assert_eq!(timer_events(engine)["events"][0]["pending"], json!(2));
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(6), json!(7)]
    );
    assert_eq!(timer_events(engine)["events"], json!([]));
    assert_eq!(
        timer_trace(engine, module),
        (1..=7).map(|id| json!(id)).collect::<Vec<_>>()
    );
}

fn timer_default_budget_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        for (let index = 1; index <= 1002; index++) setTimeout(() => __timer_trace.push(index), 0);
    "#,
    );
    let first = poll_timers(engine, json!(1000), None).unwrap();
    assert_eq!(first.len(), 1000);
    assert_eq!(first[0], json!(1));
    assert_eq!(first[999], json!(1000));
    assert_eq!(
        timer_events(engine)["events"],
        json!([{"type":"timer.yield","reason":"task-budget","limit":1000,"pending":2}])
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1001), json!(1002)]
    );
    assert_eq!(timer_trace(engine, module).len(), 1002);
}

fn timer_exception_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        setTimeout(() => { __timer_trace.push("throwing"); throw new Error("timer failure"); }, 0);
        setTimeout(() => {
            queueMicrotask(() => { throw new Error("microtask failure"); });
            __timer_trace.push("b");
        }, 0);
        setTimeout(() => __timer_trace.push("c"), 0);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1), json!(2), json!(3)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![json!("throwing"), json!("b"), json!("c")]
    );
    let events = timer_events(engine);
    let messages: Vec<_> = events["errors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|error| error["message"].clone())
        .collect();
    assert_eq!(
        messages,
        vec![json!("timer failure"), json!("microtask failure")]
    );
}

fn timer_interval_clock_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        let ticks = 0;
        const interval = setInterval(() => {
            __timer_trace.push("tick");
            if (++ticks === 1) setTimeout(() => __timer_trace.push("nested"), 5);
            else Promise.resolve().then(() => clearInterval(interval));
        }, 10);
        setTimeout(() => __timer_trace.push("late"), 25);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(10000), None).unwrap(),
        vec![json!(1), json!(2)]
    );
    for now in [10000, 9990, 10004] {
        assert!(poll_timers(engine, json!(now), None).unwrap().is_empty());
    }
    assert_eq!(
        poll_timers(engine, json!(10005), None).unwrap(),
        vec![json!(3)]
    );
    assert!(poll_timers(engine, json!(10009), None).unwrap().is_empty());
    assert_eq!(
        poll_timers(engine, json!(10010), None).unwrap(),
        vec![json!(1)]
    );
    assert!(poll_timers(engine, json!(10020), None).unwrap().is_empty());
    assert_eq!(
        timer_trace(engine, module),
        vec![json!("tick"), json!("late"), json!("nested"), json!("tick")]
    );
}

fn timer_explicit_zero_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(engine, "setTimeout(() => __timer_trace.push('fired'), 0);");
    assert!(poll_timers(engine, json!(0), None).unwrap().is_empty());
    assert!(poll_timers(engine, json!(999), None).unwrap().is_empty());
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1)]
    );
    assert_eq!(timer_trace(engine, module), vec![json!("fired")]);
}

fn timer_large_clock_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        __timer_clock = Number.MAX_SAFE_INTEGER - 5;
        setTimeout(() => __timer_trace.push("zero"), 0);
        setTimeout(() => __timer_trace.push("saturated"), Infinity);
        setTimeout(() => __timer_trace.push("negative"), -3);
    "#,
    );
    assert!(poll_timers(engine, json!(9_007_199_254_740_985u64), None)
        .unwrap()
        .is_empty());
    assert_eq!(
        poll_timers(engine, json!(9_007_199_254_740_986u64), None).unwrap(),
        vec![json!(1), json!(3)]
    );
    assert!(poll_timers(engine, json!(0), None).unwrap().is_empty());
    assert_eq!(
        poll_timers(engine, json!(9_007_199_254_740_991u64), None).unwrap(),
        vec![json!(2)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![json!("zero"), json!("negative"), json!("saturated")]
    );
}

fn timer_validation_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        "setTimeout(() => __timer_trace.push('retained'), 0);",
    );
    for invalid in [
        json!(-1),
        json!(1.5),
        json!(9_007_199_254_740_992u64),
        json!("Infinity"),
    ] {
        assert!(poll_timers(engine, invalid, None).is_err());
    }
    for invalid in [json!(0), json!(1001), json!(1.5), json!("NaN")] {
        assert!(poll_timers(engine, json!(1000), Some(invalid)).is_err());
    }
    assert!(timer_trace(engine, module).is_empty());
    assert_eq!(
        poll_timers(engine, json!(1000), Some(json!(1))).unwrap(),
        vec![json!(1)]
    );
    assert_eq!(timer_trace(engine, module), vec![json!("retained")]);
}

fn timer_arguments_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        setTimeout(function(a, b) { __timer_trace.push([a, b, this === globalThis]); }, 0, "arg", {value:7});
        setTimeout(() => __timer_trace.push("fraction"), 0.9);
    "#,
    );
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1), json!(2)]
    );
    assert_eq!(
        timer_trace(engine, module),
        vec![json!(["arg", {"value":7}, true]), json!("fraction")]
    );
}

fn timer_driver_cleanup_contract(engine: &mut impl JsEngine) {
    let module = timer_fixture(
        engine,
        r#"
        setTimeout(() => __timer_trace.push("retained"), 0);
        const original = __container_timer_task;
        let attempts = 0;
        globalThis.__container_timer_task = function() {
            if (++attempts === 1) throw new Error("task driver exception");
            if (attempts === 2) return "invalid driver result";
            return original();
        };
    "#,
    );
    assert!(poll_timers(engine, json!(1000), None).is_err());
    assert!(poll_timers(engine, json!(1000), None).is_err());
    assert!(timer_trace(engine, module).is_empty());
    assert_eq!(
        poll_timers(engine, json!(1000), None).unwrap(),
        vec![json!(1)]
    );
    assert_eq!(timer_trace(engine, module), vec![json!("retained")]);
}

macro_rules! timer_engine_contract_tests {
    ($engine:expr) => {
        #[test]
        fn self_cancelling_interval_keeps_its_neighbor() {
            timer_self_cancel_contract(&mut $engine);
        }
        #[test]
        fn overdue_timers_follow_deadline_then_registration_order() {
            timer_deadline_order_contract(&mut $engine);
        }
        #[test]
        fn native_microtasks_can_cancel_the_next_timer() {
            timer_microtask_checkpoint_contract(&mut $engine);
        }
        #[test]
        fn timers_from_callbacks_and_promises_wait_for_next_poll() {
            timer_nested_deferred_contract(&mut $engine);
        }
        #[test]
        fn recursive_zero_timers_are_bounded_per_poll() {
            timer_recursive_deferred_contract(&mut $engine);
        }
        #[test]
        fn explicit_budget_yields_without_losing_pending_tasks() {
            timer_budget_contract(&mut $engine);
        }
        #[test]
        fn default_budget_is_bounded_for_large_backlogs() {
            timer_default_budget_contract(&mut $engine);
        }
        #[test]
        fn callback_and_microtask_errors_keep_following_work() {
            timer_exception_contract(&mut $engine);
        }
        #[test]
        fn late_intervals_coalesce_and_microtask_cancellation_wins() {
            timer_interval_clock_contract(&mut $engine);
        }
        #[test]
        fn explicit_zero_is_not_replaced_by_wall_clock() {
            timer_explicit_zero_contract(&mut $engine);
        }
        #[test]
        fn safe_integer_clocks_and_saturating_deadlines_are_supported() {
            timer_large_clock_contract(&mut $engine);
        }
        #[test]
        fn invalid_clock_and_budget_preserve_pending_timers() {
            timer_validation_contract(&mut $engine);
        }
        #[test]
        fn callback_arguments_and_delay_coercion_are_preserved() {
            timer_arguments_contract(&mut $engine);
        }
        #[test]
        fn failed_driver_calls_release_the_turn_for_retry() {
            timer_driver_cleanup_contract(&mut $engine);
        }
    };
}
