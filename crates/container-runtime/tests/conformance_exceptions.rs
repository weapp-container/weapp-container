//! Actual native CPU Sessions; no window, renderer receipt, official fixture or pair.
#![cfg(all(
    feature = "conformance-observation",
    any(feature = "quickjs-native", feature = "v8-native")
))]
use container_bridge::{op, BridgeEnvelope};
use container_core::{ConformanceExceptionObservation as Observation, EngineKind, LifecycleState};
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
    RouteKind,
};
use container_runtime::{EngineExecutionPolicy, Session, SessionConfig};
use serde_json::{json, Value};
const ID: &str = "cpu-exception-session";
const APP: &str = r#"App({
 onUnhandledRejection(){wx.setStorageSync('public-rejection-delivered',true)},
 onUnload(){wx.setStorageSync('closed-app',true);
   if(globalThis.closeRejection){const p=Promise.reject(Error('actual unload rejection'));if(globalThis.closeRejection==='handled')Promise.resolve().then(()=>p.catch(()=>{}));}
   if(globalThis.appCloseFailure)throw Error('actual app close error');}
});"#;
const PAGE: &str = r#"
Page({data:{},onUnload(){wx.setStorageSync('closed-page',true);if(globalThis.pageCloseFailure)throw Error('actual page close error');}});
exports.tamper=()=>{__container_errors=[];Object.freeze(__container_errors);__container_report_error=()=>{};return null};
exports.fail=()=>{throw Error('actual session error')};
exports.configureClose=mode=>{globalThis.pageCloseFailure=mode==='page';globalThis.appCloseFailure=mode==='app';globalThis.closeRejection=mode==='unhandled'||mode==='handled'?mode:null;return null;};
exports.unhandled=handled=>{const p=Promise.reject(Error('actual session rejection'));if(handled)p.catch(()=>{});return null;};
exports.busy=()=>{const until=Date.now()+100;while(Date.now()<until){};return null;};
"#;
fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn dispatch(session: &mut Session, op: &str, payload: Value) -> container_bridge::BridgeBatch {
    session.dispatch(BridgeEnvelope::request(ID, "cpu-op", op, payload))
}
fn call(session: &mut Session, name: &str, args: Vec<Value>) -> container_bridge::BridgeBatch {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:page.js","export":name,"args":args}),
    )
}
fn try_fixture(
    engine: EngineKind,
    bounded: bool,
) -> Result<Session, container_runtime::SessionError> {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "local-cpu-exception-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    for (path, source, scope) in [
        ("app.js", APP, ModuleScope::App),
        ("page.js", PAGE, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: format!("module:{path}"),
            sha256: hex_digest(source.as_bytes()),
            scope,
            format: ModuleFormat::Commonjs,
            dependencies: vec![],
        });
    }
    manifest.routes.push(Route {
        id: "route:home".into(),
        path: "home".into(),
        kind: RouteKind::Page,
        config: None,
        entry_module: "page.js".into(),
    });
    manifest
        .capabilities
        .insert("wx.setStorageSync".into(), CapabilitySupport::Full);
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: ID.into(),
            engine,
            engine_execution: if bounded {
                EngineExecutionPolicy {
                    turn_timeout_ms: Some(20),
                    bootstrap_timeout_ms: Some(2000),
                }
            } else {
                Default::default()
            },
            ..Default::default()
        },
    )?;
    for (operation, payload) in [
        (
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":APP},{"id":"module:page.js","source":PAGE}]}),
        ),
        (op::APP_LIFECYCLE, json!({"event":"launch"})),
        (op::PAGE_PUSH, json!({"path":"home"})),
    ] {
        let batch = dispatch(&mut session, operation, payload);
        assert!(
            batch
                .messages
                .iter()
                .any(|m| m.op == operation && m.payload["ok"] == true),
            "{batch:?}"
        );
    }
    Ok(session)
}
fn fixture(engine: EngineKind, bounded: bool) -> Session {
    try_fixture(engine, bounded).unwrap()
}

#[test]
fn empty_close_runs_actual_page_and_app_cleanup_before_complete_watermark() {
    for engine in engines() {
        let mut s = fixture(engine, false);
        let capture = s.begin_conformance_exceptions().result.unwrap();
        let turn = s.close_conformance_exceptions(&capture);
        assert!(
            matches!(turn.result.unwrap(),Observation::Ended{complete:true,overflow:false,start_cursor:0,end_cursor:0,ref events,..}if events.is_empty())
        );
        assert_eq!(
            s.app_service().lifecycle().state(),
            LifecycleState::Destroyed
        );
        assert_eq!(
            s.app_service().storage().get("closed-page"),
            Some(&json!(true))
        );
        assert_eq!(
            s.app_service().storage().get("closed-app"),
            Some(&json!(true))
        );
        assert!(s.close_conformance_exceptions(&capture).result.is_err());
        assert!(s.begin_conformance_exceptions().result.is_err());
    }
}
#[test]
fn same_text_session_id_does_not_authorize_another_actual_realm() {
    for engine in engines() {
        let mut first = fixture(engine, false);
        let capture = first.begin_conformance_exceptions().result.unwrap();
        let mut other = fixture(engine, false);
        assert!(other.close_conformance_exceptions(&capture).result.is_err());
        assert_eq!(
            other.app_service().lifecycle().state(),
            LifecycleState::Active
        );
        assert!(first.close_conformance_exceptions(&capture).result.is_ok());
    }
}
#[test]
fn actual_sync_error_survives_guest_diagnostic_sabotage() {
    for engine in engines() {
        let mut s = fixture(engine, false);
        let capture = s.begin_conformance_exceptions().result.unwrap();
        call(&mut s, "tamper", vec![]);
        call(&mut s, "fail", vec![]);
        match s.close_conformance_exceptions(&capture).result.unwrap() {
            Observation::Ended {
                complete: true,
                overflow: false,
                events,
                end_cursor: 1,
                ..
            } => assert_eq!(events[0].message, "actual session error"),
            other => panic!("{other:?}"),
        }
    }
}
#[test]
fn close_time_page_or_app_failure_cannot_prove_successful_empty_close() {
    for engine in engines() {
        for mode in ["page", "app"] {
            let mut s = fixture(engine, false);
            let capture = s.begin_conformance_exceptions().result.unwrap();
            call(&mut s, "configureClose", vec![json!(mode)]);
            match s.close_conformance_exceptions(&capture).result.unwrap() {
                Observation::Ended { events, .. } => assert!(events
                    .iter()
                    .any(|e| e.message == format!("actual {mode} close error"))),
                other => panic!("{other:?}"),
            };
            assert_eq!(
                s.app_service().lifecycle().state(),
                LifecycleState::Destroyed
            );
            assert_eq!(
                s.app_service().storage().get("closed-app"),
                Some(&json!(true))
            );
        }
    }
}
#[test]
fn actual_unhandled_job_is_observed_but_a_handled_job_is_absent() {
    for engine in engines() {
        for handled in [false, true] {
            let mut s = fixture(engine, false);
            let capture = s.begin_conformance_exceptions().result.unwrap();
            call(&mut s, "unhandled", vec![json!(handled)]);
            match s.close_conformance_exceptions(&capture).result.unwrap() {
                Observation::Ended {
                    complete: true,
                    overflow: false,
                    events,
                    ..
                } => {
                    assert_eq!(events.len(), if handled { 0 } else { 1 });
                    if !handled {
                        assert_eq!(events[0].message, "actual session rejection");
                    }
                }
                other => panic!("{other:?}"),
            }
        }
    }
}
#[test]
fn a_faulted_native_realm_cannot_be_reentered_to_fabricate_empty_close() {
    for engine in engines() {
        if engine == EngineKind::V8 {
            assert!(
                try_fixture(engine, true).is_err(),
                "V8 bounded AppService policy is currently explicitly unsupported"
            );
            continue;
        }
        let mut s = fixture(engine, true);
        let capture = s.begin_conformance_exceptions().result.unwrap();
        call(&mut s, "busy", vec![]);
        assert!(s.close_conformance_exceptions(&capture).result.is_err());
    }
}

#[test]
fn unload_rejection_runs_actual_checkpoint_and_respects_handled_cancellation() {
    for engine in engines() {
        for mode in ["unhandled", "handled"] {
            let mut s = fixture(engine, false);
            let capture = s.begin_conformance_exceptions().result.unwrap();
            call(&mut s, "configureClose", vec![json!(mode)]);
            match s.close_conformance_exceptions(&capture).result.unwrap() {
                Observation::Ended {
                    complete: true,
                    overflow: false,
                    events,
                    ..
                } => {
                    assert_eq!(events.len(), if mode == "handled" { 0 } else { 1 });
                    if mode == "unhandled" {
                        assert_eq!(events[0].message, "actual unload rejection");
                    }
                }
                other => panic!("{other:?}"),
            }
            // App.onUnload is a real engine turn, whose rejection checkpoint
            // precedes public-listener retirement. Preserve that existing order.
            assert_eq!(
                s.app_service().storage().get("public-rejection-delivered"),
                if mode == "unhandled" {
                    Some(&json!(true))
                } else {
                    None
                }
            );
        }
    }
}

#[test]
fn premature_external_unload_cannot_be_relabelled_as_our_successful_source_close() {
    for engine in engines() {
        let mut s = fixture(engine, false);
        let capture = s.begin_conformance_exceptions().result.unwrap();
        dispatch(&mut s, op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            s.app_service().lifecycle().state(),
            LifecycleState::Destroyed
        );
        assert!(s.close_conformance_exceptions(&capture).result.is_err());
    }
}
