//! Local native contracts only; no official case admission or host presentation.
#![cfg(all(
    feature = "conformance-observation",
    any(feature = "quickjs-native", feature = "v8-native")
))]
#[cfg(feature = "quickjs-native")]
use container_bridge::BridgeErrorCode;
use container_bridge::{op, BridgeEnvelope};
use container_core::{
    ConformanceGuestObservation as Observation, ConformanceGuestValue as GuestValue, EngineKind,
};
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
    RouteKind,
};
use container_runtime::{
    ConformanceInvocation, ConformancePageBinding, EngineExecutionPolicy, Session, SessionConfig,
};
use serde_json::{json, Value};

const ID: &str = "conformance-native-session";
const APP: &str = "App({});";
const HOME: &str = r#"
const states=new WeakMap();let calls=0,resolve;
Page({data:{value:0},onLoad(){states.set(this,{value:1});},onUnload(){states.delete(this);},
 increment(){calls++;const value=++states.get(this).value;this.setData({value});Promise.resolve().then(()=>wx.setStorageSync('guest-checkpoint',value));},
 snapshot(){return {value:states.get(this).value,nested:[false,0,'',null,[1,2]]};},
 array(){return [1,[2,3],{actual:4}];},
 pending(){calls++;return new Promise(done=>{resolve=done;}).then(value=>{wx.setStorageSync('late-guest-effect',value);return {actual:value};});},
 navigate(){calls++;wx.reLaunch({url:'/other'});return 'retired actual result';},
 busy(){calls++;const until=Date.now()+200;while(Date.now()<until){};return 'too late';}
});
exports.seedData=()=>{getCurrentPages()[0].data.value="actual private receiver";console.log("session-info");console.error("session-error");};
exports.resolve=value=>resolve(value);exports.calls=()=>calls;
"#;
const OTHER: &str = "Page({data:{other:true},onUnload(){console.error('other-close-error')}});";
fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        ID,
        "test-operation",
        operation,
        payload,
    ));
    let response = batch
        .messages
        .iter()
        .find(|message| {
            message.request_id == "test-operation"
                && message.op == operation
                && message.kind == container_bridge::EnvelopeKind::Response
        })
        .unwrap();
    assert_eq!(response.payload["ok"], true, "{batch:?}");
    response.payload.clone()
}
fn call(session: &mut Session, export: &str, args: Vec<Value>) -> Value {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:home.js","export":export,"args":args}),
    )["result"]
        .clone()
}
fn fixture(engine: EngineKind, bounded: bool) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "internal-method-result-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    for (path, source, scope) in [
        ("app.js", APP, ModuleScope::App),
        ("home.js", HOME, ModuleScope::Page),
        ("other.js", OTHER, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: format!("module:{path}"),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    for route in ["home", "other"] {
        manifest.routes.push(Route {
            id: format!("route:{route}"),
            path: route.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("{route}.js"),
        });
    }
    for api in ["wx.getStorageSync", "wx.setStorageSync", "getCurrentPages"] {
        manifest
            .capabilities
            .insert(api.into(), CapabilitySupport::Full);
    }
    for api in ["wx.reLaunch", "wx.navigateTo", "wx.navigateBack"] {
        manifest
            .capabilities
            .insert(api.into(), CapabilitySupport::Partial);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: ID.into(),
            engine,
            engine_execution: if bounded {
                EngineExecutionPolicy {
                    turn_timeout_ms: Some(50),
                    bootstrap_timeout_ms: Some(2000),
                }
            } else {
                Default::default()
            },
            ..Default::default()
        },
    )
    .unwrap();
    dispatch(
        &mut session,
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":APP},{"id":"module:home.js","source":HOME},{"id":"module:other.js","source":OTHER}]}),
    );
    dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
    session
}
fn acquire(session: &mut Session) -> ConformancePageBinding {
    session.acquire_conformance_page("home").result.unwrap()
}
fn begin(
    session: &mut Session,
    binding: &ConformancePageBinding,
    id: &str,
    method: &str,
) -> ConformanceInvocation {
    session
        .begin_conformance_guest(binding, id, method, vec![])
        .result
        .unwrap()
}
fn value(
    session: &mut Session,
    binding: &ConformancePageBinding,
    id: &str,
    method: &str,
) -> GuestValue {
    let invocation = begin(session, binding, id, method);
    match session.poll_conformance_guest(&invocation).result.unwrap() {
        Observation::Fulfilled { value, .. } => value,
        other => panic!("unexpected actual result {other:?}"),
    }
}

#[test]
fn actual_current_receiver_result_and_effect_checkpoint() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        assert!(session.acquire_conformance_page("other").result.is_err());
        let binding = acquire(&mut session);
        assert_eq!(binding.route(), "home");
        assert_eq!(
            binding.page_id(),
            session.app_service().pages().current().unwrap().id
        );
        let turn = session.begin_conformance_guest(&binding, "void-once", "increment", vec![]);
        assert!(turn.result.is_ok(), "{:?}", turn.result);
        assert!(
            !turn.effects.messages.is_empty(),
            "consumed data/storage effects were lost"
        );
        let invocation = turn.result.unwrap();
        assert!(session
            .begin_conformance_guest(&binding, "void-once", "increment", vec![])
            .result
            .is_err());
        assert!(matches!(
            session.poll_conformance_guest(&invocation).result.unwrap(),
            Observation::Fulfilled {
                value: GuestValue::Undefined,
                ..
            }
        ));
        assert!(session.poll_conformance_guest(&invocation).result.is_err());
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        assert_eq!(
            session.app_service().pages().current().unwrap().data["value"],
            2
        );
        assert_eq!(
            session.app_service().storage().get("guest-checkpoint"),
            Some(&json!(2))
        );
        assert_eq!(
            value(&mut session, &binding, "snapshot", "snapshot"),
            GuestValue::Json {
                value: json!({"value":2,"nested":[false,0,"",null,[1,2]]})
            }
        );
        assert_eq!(
            value(&mut session, &binding, "array", "array"),
            GuestValue::Json {
                value: json!([1,[2,3],{"actual":4}])
            }
        );
    }
}

#[test]
fn actual_pending_poll_and_observation_cancellation() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let invocation = begin(&mut session, &binding, "pending", "pending");
        for _ in 0..3 {
            assert!(matches!(
                session.poll_conformance_guest(&invocation).result.unwrap(),
                Observation::Pending { .. }
            ));
        }
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        call(&mut session, "resolve", vec![json!("real settlement")]);
        assert!(
            matches!(session.poll_conformance_guest(&invocation).result.unwrap(),Observation::Fulfilled{value:GuestValue::Json{value},..}if value==json!({"actual":"real settlement"}))
        );
        let cancelled = begin(&mut session, &binding, "cancelled", "pending");
        assert!(matches!(
            session.cancel_conformance_guest(&cancelled).result.unwrap(),
            Observation::Cancelled { .. }
        ));
        call(
            &mut session,
            "resolve",
            vec![json!("late irreversible effect")],
        );
        assert_eq!(
            session.app_service().storage().get("late-guest-effect"),
            Some(&json!("late irreversible effect"))
        );
        assert!(session.poll_conformance_guest(&cancelled).result.is_err());
        assert!(session
            .begin_conformance_guest(&binding, "cancelled", "increment", vec![])
            .result
            .is_err());
    }
}

#[test]
fn navigation_revokes_delivery_after_real_guest_effects() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let turn = session.begin_conformance_guest(&binding, "navigate-once", "navigate", vec![]);
        assert!(turn.result.is_err(), "retired actual result was delivered");
        assert!(!turn.effects.messages.is_empty());
        assert_eq!(
            session.app_service().pages().current().unwrap().path,
            "other"
        );
        assert!(session
            .begin_conformance_guest(&binding, "stale-page", "increment", vec![])
            .result
            .is_err());
        let fresh = session.acquire_conformance_page("other").result.unwrap();
        assert!(session
            .begin_conformance_guest(&fresh, "navigate-once", "increment", vec![])
            .result
            .is_err());
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn same_route_relaunch_never_revives_old_binding_or_pending_owner() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let old = acquire(&mut session);
        let pending = begin(&mut session, &old, "old-promise", "pending");
        dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":"/home"}),
        );
        let fresh = acquire(&mut session);
        assert_ne!(old.page_id(), fresh.page_id());
        assert_ne!(old.receiver_token(), fresh.receiver_token());
        assert!(session.poll_conformance_guest(&pending).result.is_err());
        assert!(session
            .begin_conformance_guest(&old, "old-binding", "increment", vec![])
            .result
            .is_err());
        assert_eq!(
            value(&mut session, &fresh, "fresh-snapshot", "snapshot"),
            GuestValue::Json {
                value: json!({"value":1,"nested":[false,0,"",null,[1,2]]})
            }
        );
        call(&mut session, "resolve", vec![json!("retired settlement")]);
        assert!(session.poll_conformance_guest(&pending).result.is_err());
    }
}

#[test]
fn session_and_realm_owners_are_unforgeable_even_with_identical_public_ids() {
    for engine in engines() {
        let mut first = fixture(engine, false);
        let mut second = fixture(engine, false);
        let binding = acquire(&mut first);
        let invocation = begin(&mut first, &binding, "foreign-owner", "pending");
        assert!(second
            .begin_conformance_guest(&binding, "same-visible-id", "increment", vec![])
            .result
            .is_err());
        assert!(second.poll_conformance_guest(&invocation).result.is_err());
        assert_eq!(call(&mut second, "calls", vec![]), json!([0]));
    }
}

#[cfg(feature = "quickjs-native")]
#[test]
fn interrupted_begin_keeps_native_owner_tombstone_and_requires_new_realm() {
    let mut session = fixture(EngineKind::Quickjs, true);
    let binding = acquire(&mut session);
    let failed = session.begin_conformance_guest(&binding, "timeout-once", "busy", vec![]);
    assert!(failed.result.is_err());
    assert!(session.execution_fault().is_some());
    let retry = session
        .begin_conformance_guest(&binding, "timeout-once", "increment", vec![])
        .result
        .unwrap_err();
    assert_eq!(retry.code, BridgeErrorCode::InvalidRequest);
    assert!(retry.message.contains("owner reused"));
}

#[test]
fn background_foreground_cycle_cannot_revive_previous_activation() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let old = acquire(&mut session);
        let pending = begin(&mut session, &old, "background-promise", "pending");
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(session.acquire_conformance_page("home").result.is_err());
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        let fresh = acquire(&mut session);
        assert_eq!(old.page_id(), fresh.page_id());
        assert_eq!(old.receiver_token(), fresh.receiver_token());
        assert!(session.poll_conformance_guest(&pending).result.is_err());
        assert!(session
            .begin_conformance_guest(&old, "old-visible-binding", "increment", vec![])
            .result
            .is_err());
        assert_eq!(
            value(&mut session, &fresh, "foreground-snapshot", "snapshot"),
            GuestValue::Json {
                value: json!({"value":1,"nested":[false,0,"",null,[1,2]]})
            }
        );
    }
}

#[test]
fn failed_native_owners_remain_bounded_tombstones_before_any_guest_lookup() {
    for engine in engines() {
        let mut source = fixture(engine, false);
        let foreign = acquire(&mut source);
        let mut session = fixture(engine, false);
        for index in 0..1024 {
            assert!(session
                .begin_conformance_guest(
                    &foreign,
                    &format!("failed-owner-{index}"),
                    "increment",
                    vec![]
                )
                .result
                .is_err());
        }
        let actual = acquire(&mut session);
        let error = session
            .begin_conformance_guest(&actual, "overflow-native-owner", "increment", vec![])
            .result
            .unwrap_err();
        assert!(error.message.contains("ledger exhausted"));
        assert_eq!(call(&mut session, "calls", vec![]), json!([0]));
    }
}

#[path = "../../../examples/hosts/conformance-desktop/src/method_delivery.rs"]
mod method_delivery;
use method_delivery::{
    DeliveryBarrier, DeliveryLedger, DeliveryPermit, Phase, PollStatus, PresentationWitness,
    RequestId,
};

fn absolute_deadline_after_ms(ms: u64) -> u64 {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    u64::try_from(
        (SystemTime::now() + Duration::from_millis(ms))
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    )
    .unwrap()
}

fn delivery_permit(
    ledger: &mut DeliveryLedger,
    binding: &ConformancePageBinding,
    id: &str,
    deadline: u64,
) -> DeliveryPermit {
    ledger
        .reserve(
            RequestId::Text(id.into()),
            id,
            binding,
            deadline,
            DeliveryBarrier {
                action_sequence: 1,
                required_pump_sequence: 2,
            },
        )
        .unwrap()
}

// Deliberately synthetic: these fixtures have no native renderer, Metal
// surface, owner pump, IPC stream, or real presentation ACK. Tests prove
// witness-gating logic and actual Session invalidation, not actual emit safety.
fn synthetic_witness(session: &Session, binding: &ConformancePageBinding) -> PresentationWitness {
    PresentationWitness {
        page_id: binding.page_id().0,
        route: binding.route().into(),
        template_revision: session.view().template_revision,
        consumed_template_revision: session.view().template_revision,
        frame_id: 31,
        render_revision: 32,
        acknowledged_revision: 32,
        action_sequence: 1,
        owner_pump_sequence: 2,
        required_pump_sequence: 2,
        presented: true,
    }
}

fn stage_increment(ledger: &mut DeliveryLedger, permit: &DeliveryPermit, session: &mut Session) {
    let turn = ledger.begin(permit, session, "increment", vec![]);
    assert!(turn.result.is_ok(), "{:?}", turn.result);
    // Effects have already reached the actual Session. A future desktop caller
    // must journal these on success and failure without redispatching them.
    assert!(!turn.effects.messages.is_empty());
    assert_eq!(
        ledger.poll(permit, session).result.unwrap(),
        PollStatus::Terminal
    );
    assert_eq!(ledger.phase(permit).unwrap(), Phase::Ready);
}

#[test]
fn async_delivery_distinguishes_consumed_in_flight_and_full_written_without_reentry() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "async-full",
            absolute_deadline_after_ms(5000),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        let witness = synthetic_witness(&session, &binding);
        assert_eq!(
            ledger
                .enqueue_if_current(&permit, &mut session, &witness, |actual| {
                    assert!(matches!(
                        actual,
                        Observation::Fulfilled {
                            value: GuestValue::Undefined,
                            ..
                        }
                    ));
                    Ok(73)
                })
                .unwrap(),
            73
        );
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::InFlight);
        assert!(ledger.abandon(&permit).is_err());
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert!(ledger
            .enqueue_if_current(&permit, &mut session, &witness, |_| panic!("permit reused"))
            .is_err());
        // Completion is only a writer receipt; it does not touch the runtime
        // after a receiver is invalidated, invoke it again, or revive it.
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        let view = session.view().clone();
        let render = session.render_revision();
        assert_eq!(
            ledger.complete_output(73, true).unwrap(),
            Some("async-full".into())
        );
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Delivered);
        assert!(ledger.complete_output(73, true).is_err());
        assert_eq!(ledger.complete_output(999, true).unwrap(), None);
        assert_eq!(session.view(), &view);
        assert_eq!(session.render_revision(), render);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        assert!(ledger
            .reserve(
                RequestId::Text("new-ipc".into()),
                "async-full",
                &binding,
                absolute_deadline_after_ms(5000),
                DeliveryBarrier {
                    action_sequence: 1,
                    required_pump_sequence: 2
                }
            )
            .is_err());
    }
}

#[test]
fn async_failed_write_permanently_retires_actual_consumed_terminal() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "async-partial",
            absolute_deadline_after_ms(5000),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        let witness = synthetic_witness(&session, &binding);
        ledger
            .enqueue_if_current(&permit, &mut session, &witness, |_| Ok(91))
            .unwrap();
        assert_eq!(
            ledger.complete_output(91, false).unwrap(),
            Some("async-partial".into())
        );
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        assert!(ledger.complete_output(91, true).is_err());
        assert!(ledger
            .enqueue_if_current(&permit, &mut session, &witness, |_| panic!(
                "partial retried"
            ))
            .is_err());
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn async_enqueue_revalidates_actual_receiver_and_retires_queue_rejection() {
    for engine in engines() {
        for revoke in [false, true] {
            let mut session = fixture(engine, false);
            let binding = acquire(&mut session);
            let mut ledger = DeliveryLedger::default();
            let permit = delivery_permit(
                &mut ledger,
                &binding,
                "async-rejected",
                absolute_deadline_after_ms(5000),
            );
            stage_increment(&mut ledger, &permit, &mut session);
            if revoke {
                dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
                dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
            }
            let witness = synthetic_witness(&session, &binding);
            let mut attempts = 0;
            assert!(ledger
                .enqueue_if_current(&permit, &mut session, &witness, |_| {
                    attempts += 1;
                    Err("bounded queue rejected before bytes".into())
                })
                .is_err());
            assert_eq!(attempts, if revoke { 0 } else { 1 });
            assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
            assert!(ledger
                .enqueue_if_current(&permit, &mut session, &witness, |_| panic!(
                    "rejected retried"
                ))
                .is_err());
            assert!(ledger
                .begin(&permit, &mut session, "increment", vec![])
                .result
                .is_err());
            assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        }
    }
}

#[test]
fn readonly_validation_preserves_state_and_does_not_consume_other_results() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let immediate = begin(&mut session, &binding, "readonly-value", "increment");
        let pending = begin(&mut session, &binding, "readonly-promise", "pending");
        let view = session.view().clone();
        let render = session.render_revision();
        let stored = session
            .app_service()
            .storage()
            .get("guest-checkpoint")
            .cloned();
        for _ in 0..3 {
            session
                .validate_conformance_binding(&binding, absolute_deadline_after_ms(5000))
                .unwrap();
        }
        assert_eq!(session.view(), &view);
        assert_eq!(session.render_revision(), render);
        assert_eq!(
            session
                .app_service()
                .storage()
                .get("guest-checkpoint")
                .cloned(),
            stored
        );
        assert_eq!(call(&mut session, "calls", vec![]), json!([2]));
        assert!(matches!(
            session.poll_conformance_guest(&immediate).result.unwrap(),
            Observation::Fulfilled {
                value: GuestValue::Undefined,
                ..
            }
        ));
        session
            .validate_conformance_binding(&binding, absolute_deadline_after_ms(5000))
            .unwrap();
        assert!(session.poll_conformance_guest(&immediate).result.is_err());
        assert!(matches!(
            session.poll_conformance_guest(&pending).result.unwrap(),
            Observation::Pending { .. }
        ));
        call(&mut session, "resolve", vec![json!("after readonly")]);
        assert!(
            matches!(session.poll_conformance_guest(&pending).result.unwrap(),
            Observation::Fulfilled { value:GuestValue::Json { value }, .. }
                if value == json!({"actual":"after readonly"}))
        );
        assert_eq!(call(&mut session, "calls", vec![]), json!([2]));
    }
}

#[test]
fn delivery_writes_actual_typed_terminal_once_and_retains_both_owner_identities() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "delivered-once",
            absolute_deadline_after_ms(5000),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        let witness = synthetic_witness(&session, &binding);
        let view = session.view().clone();
        let render = session.render_revision();
        let mut writes = 0;
        ledger
            .emit_if_current(&permit, &mut session, &witness, |actual| {
                writes += 1;
                assert!(matches!(
                    actual,
                    Observation::Fulfilled {
                        value: GuestValue::Undefined,
                        ..
                    }
                ));
                Ok(())
            })
            .unwrap();
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Delivered);
        assert!(ledger
            .emit_if_current(&permit.clone(), &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert!(ledger.poll(&permit, &mut session).result.is_err());
        assert!(ledger
            .reserve(
                RequestId::Text("delivered-once".into()),
                "different-source",
                &binding,
                absolute_deadline_after_ms(5000),
                DeliveryBarrier {
                    action_sequence: 1,
                    required_pump_sequence: 2
                }
            )
            .is_err());
        assert!(ledger
            .reserve(
                RequestId::Text("fresh-ipc".into()),
                "delivered-once",
                &binding,
                absolute_deadline_after_ms(5000),
                DeliveryBarrier {
                    action_sequence: 1,
                    required_pump_sequence: 2
                }
            )
            .is_err());
        // The rejected fresh IPC alias is also a permanent bounded tombstone.
        assert!(ledger
            .reserve(
                RequestId::Text("fresh-ipc".into()),
                "fresh-source",
                &binding,
                absolute_deadline_after_ms(5000),
                DeliveryBarrier {
                    action_sequence: 1,
                    required_pump_sequence: 2
                }
            )
            .is_err());
        assert_eq!(writes, 1);
        assert_eq!(session.view(), &view);
        assert_eq!(session.render_revision(), render);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn delivery_pending_poll_reuses_one_actual_invocation_and_never_stages_null() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "pending-owner",
            absolute_deadline_after_ms(5000),
        );
        ledger
            .begin(&permit, &mut session, "pending", vec![])
            .result
            .unwrap();
        let witness = synthetic_witness(&session, &binding);
        let mut writes = 0;
        for _ in 0..3 {
            assert_eq!(
                ledger.poll(&permit, &mut session).result.unwrap(),
                PollStatus::Pending
            );
            assert!(ledger
                .emit_if_current(&permit, &mut session, &witness, |_| {
                    writes += 1;
                    Ok(())
                })
                .is_err());
            assert_eq!(ledger.phase(&permit).unwrap(), Phase::Pending);
        }
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        call(
            &mut session,
            "resolve",
            vec![json!([false, 0, "", null, [1, 2]])],
        );
        assert_eq!(
            ledger.poll(&permit, &mut session).result.unwrap(),
            PollStatus::Terminal
        );
        let witness = synthetic_witness(&session, &binding);
        ledger
            .emit_if_current(&permit, &mut session, &witness, |actual| {
                writes += 1;
                assert!(
                    matches!(actual, Observation::Fulfilled {value:GuestValue::Json{value},..}
                if value == &json!({"actual":[false,0,"",null,[1,2]]}))
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(writes, 1);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn consumed_terminal_is_revoked_by_same_receiver_hide_show_before_delivery() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let old = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &old,
            "background-delivery",
            absolute_deadline_after_ms(5000),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        let fresh = acquire(&mut session);
        assert_eq!(old.page_id(), fresh.page_id());
        assert_eq!(old.route(), fresh.route());
        assert_eq!(old.receiver_token(), fresh.receiver_token());
        let witness = synthetic_witness(&session, &fresh);
        let mut writes = 0;
        assert!(ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        session
            .validate_conformance_binding(&fresh, absolute_deadline_after_ms(5000))
            .unwrap();
        assert!(ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert_eq!(writes, 0);
        assert_eq!(
            session.app_service().storage().get("guest-checkpoint"),
            Some(&json!(2))
        );
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn consumed_terminal_is_revoked_when_route_returns_during_presentation_wait_model() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let old = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &old,
            "route-return-delivery",
            absolute_deadline_after_ms(5000),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.navigateTo","url":"/other"}),
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().path,
            "other"
        );
        dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.navigateBack","delta":1}),
        );
        let fresh = acquire(&mut session);
        assert_eq!(old.page_id(), fresh.page_id());
        assert_eq!(old.route(), fresh.route());
        assert_eq!(old.receiver_token(), fresh.receiver_token());
        let witness = synthetic_witness(&session, &fresh);
        let mut writes = 0;
        assert!(ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        assert_eq!(writes, 0);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn consumed_terminal_final_absolute_deadline_cannot_be_renewed() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "expired-delivery",
            absolute_deadline_after_ms(100),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        std::thread::sleep(std::time::Duration::from_millis(120));
        let witness = synthetic_witness(&session, &binding);
        let mut writes = 0;
        let error = ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Timeout);
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        assert!(ledger
            .reserve(
                RequestId::Text("renewed-ipc".into()),
                "expired-delivery",
                &binding,
                absolute_deadline_after_ms(5000),
                DeliveryBarrier {
                    action_sequence: 1,
                    required_pump_sequence: 2
                }
            )
            .is_err());
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert_eq!(writes, 0);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        assert_eq!(
            session.app_service().storage().get("guest-checkpoint"),
            Some(&json!(2))
        );
    }
}

#[cfg(feature = "quickjs-native")]
#[test]
fn consumed_terminal_cannot_write_after_actual_quickjs_realm_fault() {
    let mut session = fixture(EngineKind::Quickjs, true);
    let binding = acquire(&mut session);
    let mut ledger = DeliveryLedger::default();
    let permit = delivery_permit(
        &mut ledger,
        &binding,
        "faulted-delivery",
        absolute_deadline_after_ms(5000),
    );
    stage_increment(&mut ledger, &permit, &mut session);
    assert!(session
        .begin_conformance_guest(&binding, "actual-realm-fault", "busy", vec![])
        .result
        .is_err());
    assert!(session.execution_fault().is_some());
    let witness = synthetic_witness(&session, &binding);
    let mut writes = 0;
    let error = ledger
        .emit_if_current(&permit, &mut session, &witness, |_| {
            writes += 1;
            Ok(())
        })
        .unwrap_err();
    assert_eq!(error.code, BridgeErrorCode::Engine);
    assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
    assert_eq!(writes, 0);
    assert_eq!(
        session.app_service().storage().get("guest-checkpoint"),
        Some(&json!(2))
    );
}

#[test]
fn presentation_witness_mismatch_cannot_trigger_or_retry_a_write() {
    for engine in engines() {
        for mismatch in 0..10 {
            let mut session = fixture(engine, false);
            let binding = acquire(&mut session);
            let mut ledger = DeliveryLedger::default();
            let permit = delivery_permit(
                &mut ledger,
                &binding,
                "witness-mismatch",
                absolute_deadline_after_ms(5000),
            );
            stage_increment(&mut ledger, &permit, &mut session);
            let good = synthetic_witness(&session, &binding);
            let mut bad = good.clone();
            match mismatch {
                0 => bad.acknowledged_revision += 1,
                1 => bad.owner_pump_sequence -= 1,
                2 => bad.action_sequence += 1,
                3 => bad.required_pump_sequence += 1,
                4 => bad.consumed_template_revision += 1,
                5 => bad.frame_id = 0,
                6 => bad.render_revision = 0,
                7 => bad.presented = false,
                8 => bad.page_id += 1,
                _ => bad.route = "other".into(),
            }
            let mut writes = 0;
            assert!(ledger
                .emit_if_current(&permit, &mut session, &bad, |_| {
                    writes += 1;
                    Ok(())
                })
                .is_err());
            assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
            assert!(ledger
                .emit_if_current(&permit, &mut session, &good, |_| {
                    writes += 1;
                    Ok(())
                })
                .is_err());
            assert_eq!(writes, 0);
            assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        }
    }
}

#[test]
fn partial_write_failure_or_panic_permanently_consumes_delivery_attempt() {
    for engine in engines() {
        for panic_in_writer in [false, true] {
            let mut session = fixture(engine, false);
            let binding = acquire(&mut session);
            let mut ledger = DeliveryLedger::default();
            let permit = delivery_permit(
                &mut ledger,
                &binding,
                "writer-failure",
                absolute_deadline_after_ms(5000),
            );
            stage_increment(&mut ledger, &permit, &mut session);
            let witness = synthetic_witness(&session, &binding);
            let mut writes = 0;
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                ledger.emit_if_current(&permit, &mut session, &witness, |actual| {
                    writes += 1;
                    assert!(matches!(
                        actual,
                        Observation::Fulfilled {
                            value: GuestValue::Undefined,
                            ..
                        }
                    ));
                    if panic_in_writer {
                        panic!("simulated panic after a partial native write");
                    }
                    Err("simulated broken IPC pipe after partial bytes".into())
                })
            }));
            if panic_in_writer {
                assert!(attempt.is_err());
            } else {
                assert!(attempt.unwrap().is_err());
            }
            assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
            assert!(ledger
                .emit_if_current(&permit, &mut session, &witness, |_| {
                    writes += 1;
                    Ok(())
                })
                .is_err());
            assert!(ledger
                .begin(&permit, &mut session, "increment", vec![])
                .result
                .is_err());
            assert_eq!(writes, 1);
            assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
        }
    }
}

#[test]
fn expired_reservation_never_enters_actual_guest_and_cannot_retry() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(&mut ledger, &binding, "expired-before-begin", 0);
        let turn = ledger.begin(&permit, &mut session, "increment", vec![]);
        assert_eq!(
            turn.result.unwrap_err().code,
            container_bridge::BridgeErrorCode::Timeout
        );
        assert!(turn.effects.messages.is_empty());
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        assert!(ledger
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert_eq!(call(&mut session, "calls", vec![]), json!([0]));
    }
}

#[test]
fn slow_writer_cannot_report_timely_delivery_or_retransmit_partial_bytes() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let permit = delivery_permit(
            &mut ledger,
            &binding,
            "slow-writer",
            absolute_deadline_after_ms(100),
        );
        stage_increment(&mut ledger, &permit, &mut session);
        let witness = synthetic_witness(&session, &binding);
        let mut writes = 0;
        let error = ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                std::thread::sleep(std::time::Duration::from_millis(120));
                Ok(())
            })
            .unwrap_err();
        assert_eq!(error.code, container_bridge::BridgeErrorCode::Timeout);
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Unknown);
        assert!(ledger
            .emit_if_current(&permit, &mut session, &witness, |_| {
                writes += 1;
                Ok(())
            })
            .is_err());
        assert_eq!(writes, 1);
        assert_eq!(call(&mut session, "calls", vec![]), json!([1]));
    }
}

#[test]
fn native_owner_aliases_are_bounded_thread_bound_and_preserve_number_string_ids() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        let mut ledger = DeliveryLedger::default();
        let barrier = DeliveryBarrier {
            action_sequence: 1,
            required_pump_sequence: 2,
        };
        let permit = ledger
            .reserve(
                RequestId::Number(1),
                "number-owner",
                &binding,
                absolute_deadline_after_ms(5000),
                barrier,
            )
            .unwrap();
        assert!(ledger
            .reserve(
                RequestId::Text("1".into()),
                "string-owner",
                &binding,
                absolute_deadline_after_ms(5000),
                barrier
            )
            .is_ok());
        let mut foreign = DeliveryLedger::default();
        assert!(foreign
            .begin(&permit, &mut session, "increment", vec![])
            .result
            .is_err());
        assert_eq!(call(&mut session, "calls", vec![]), json!([0]));
        for index in 2..1024 {
            assert!(ledger
                .reserve(
                    RequestId::Number(index),
                    "number-owner",
                    &binding,
                    absolute_deadline_after_ms(5000),
                    barrier
                )
                .is_err());
        }
        let error = ledger
            .reserve(
                RequestId::Text("overflow".into()),
                "overflow-source",
                &binding,
                absolute_deadline_after_ms(5000),
                barrier,
            )
            .unwrap_err();
        assert!(error.message.contains("ledger exhausted"));
        assert_eq!(ledger.phase(&permit).unwrap(), Phase::Reserved);
        std::thread::spawn(move || {
            assert!(ledger
                .phase(&permit)
                .unwrap_err()
                .message
                .contains("owner thread"));
        })
        .join()
        .unwrap();
    }
}

#[test]
fn actual_session_private_data_and_complete_runtime_journal_are_independent_of_view_state() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let binding = acquire(&mut session);
        call(&mut session, "seedData", vec![]);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["value"],
            json!(0)
        );
        match session
            .read_conformance_data(&binding, None, "value".into())
            .result
            .unwrap()
        {
            Observation::Data {
                value: GuestValue::Json { value },
                ..
            } => assert_eq!(value, json!("actual private receiver")),
            other => panic!("{other:?}"),
        }
        let mut other = fixture(engine, false);
        assert!(session
            .read_conformance_data(&acquire(&mut other), None, "value".into())
            .result
            .is_err());
        assert!(session
            .read_conformance_data(&binding, Some("foreign-component".into()), "value".into())
            .result
            .is_err());
        match session.read_conformance_runtime_logs(false).result.unwrap() {
            Observation::RuntimeLogs {
                entries,
                complete,
                overflow,
                ..
            } => {
                assert!(complete);
                assert!(!overflow);
                assert_eq!(
                    entries
                        .iter()
                        .map(|e| (&*e.level, &*e.text))
                        .collect::<Vec<_>>(),
                    vec![("log", "session-info"), ("error", "session-error")]
                );
            }
            other => panic!("{other:?}"),
        }
        dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":"/other"}),
        );
        assert!(session
            .read_conformance_data(&binding, None, "value".into())
            .result
            .is_err());
        match session.read_conformance_runtime_logs(false).result.unwrap() {
            Observation::RuntimeLogs {
                entries, complete, ..
            } => {
                assert!(complete);
                assert_eq!(entries.len(), 2)
            }
            other => panic!("{other:?}"),
        }
        match session.read_conformance_runtime_logs(true).result.unwrap() {
            Observation::RuntimeLogs {
                entries,
                generation,
                start_cursor,
                end_cursor,
                reset_cursor,
                complete,
                ..
            } => {
                assert!(complete);
                assert_eq!(entries.len(), 2);
                assert_eq!(generation, 1);
                assert_eq!(start_cursor, 0);
                assert_eq!(reset_cursor, end_cursor)
            }
            other => panic!("{other:?}"),
        }
        match session.close_conformance_runtime_logs().result.unwrap() {
            Observation::RuntimeLogs {
                entries, complete, ..
            } => {
                assert!(complete);
                assert_eq!(entries.len(), 3);
                assert_eq!(entries[2].text, "other-close-error")
            }
            other => panic!("{other:?}"),
        }
        assert!(session.close_conformance_runtime_logs().result.is_err());
    }
}
