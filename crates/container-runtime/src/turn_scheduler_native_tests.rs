//! Real Session owner/turn integration. Native execution is run by the parent.
use super::*;
use container_ir::{hex_digest, AppInfo, Module, ModuleScope};
use std::time::Duration;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn request(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "scheduler-test",
        operation,
        payload,
    ));
    let response = batch
        .messages
        .iter()
        .find(|m| m.kind == EnvelopeKind::Response)
        .expect("response");
    assert_eq!(response.payload["ok"], true, "{batch:?}");
    response.payload.clone()
}
fn fixture(engine: EngineKind) -> Session {
    let source="App({});let trace=[];exports.queue=function(){wx.nextTick(function(){trace.push('tick')});wx.requestIdleCallback(function(){trace.push('idle')});return true};exports.timeout=function(){wx.requestIdleCallback(function(){trace.push('timeout')},{timeout:0});return true};exports.state=function(){return [trace]};";
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "scheduler-native-session".into();
    manifest.app = AppInfo {
        app_json: "app.json".into(),
        entry_module: "app.js".into(),
    };
    manifest.modules.push(Module {
        id: "module:app.js".into(),
        sha256: hex_digest(source.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: vec![],
    });
    for name in [
        "wx.nextTick",
        "wx.requestIdleCallback",
        "wx.cancelIdleCallback",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            ..Default::default()
        },
    )
    .unwrap();
    request(
        &mut session,
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":source}]}),
    );
    session
}
fn call(session: &mut Session, export: &str) -> Value {
    request(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    )["result"][0]
        .clone()
}
fn assert_ok(batch: BridgeBatch) {
    assert!(
        !batch
            .messages
            .iter()
            .any(|m| m.op == op::ERROR || m.payload["ok"] == false),
        "{batch:?}"
    );
}

#[test]
fn scheduler_session_timer_poll_is_a_next_turn_boundary_not_idle() {
    for engine in engines() {
        let mut s = fixture(engine);
        call(&mut s, "queue");
        assert_eq!(call(&mut s, "state"), json!([]));
        assert_ok(s.poll_timers(0));
        assert_eq!(call(&mut s, "state"), json!(["tick"]));
        assert_ok(s.poll_idle(HostIdleOpportunity::until(
            Instant::now() + Duration::from_millis(50),
        )));
        assert_eq!(call(&mut s, "state"), json!(["tick", "idle"]));
    }
}
#[test]
fn scheduler_session_expired_window_and_timeout_fallback_are_distinct() {
    for engine in engines() {
        let mut s = fixture(engine);
        call(&mut s, "queue");
        assert_ok(s.poll_idle(HostIdleOpportunity::until(
            Instant::now() - Duration::from_millis(1),
        )));
        assert_eq!(call(&mut s, "state"), json!(["tick"]));
        call(&mut s, "timeout");
        assert_ok(s.poll_timers(0));
        assert_eq!(call(&mut s, "state"), json!(["tick", "timeout"]));
    }
}
#[test]
fn scheduler_session_producers_keep_partial_ceiling_while_cancel_keeps_own_grade() {
    for engine in engines() {
        let mut s = fixture(engine);
        for name in [
            "wx.nextTick",
            "wx.requestIdleCallback",
            "wx.cancelIdleCallback",
        ] {
            let expected = if name == "wx.cancelIdleCallback" {
                CapabilitySupport::Full
            } else {
                CapabilitySupport::Partial
            };
            assert_eq!(s.effective_capability(name), expected);
            assert_eq!(s.effective_capabilities()[name], expected);
        }
        s.config
            .capabilities
            .insert("wx.nextTick".into(), CapabilitySupport::Unsupported);
        assert_eq!(
            s.effective_capability("wx.nextTick"),
            CapabilitySupport::Unsupported
        );
    }
}
#[test]
fn scheduler_session_uninitialized_poll_has_no_guest_execution() {
    for engine in engines() {
        let mut s = fixture(engine);
        s.initialized = false;
        assert_ok(s.poll_idle(HostIdleOpportunity::until(
            Instant::now() + Duration::from_millis(50),
        )));
    }
}

#[test]
fn scheduler_session_hide_show_uses_committed_visibility() {
    for engine in engines() {
        let mut s = fixture(engine);
        call(&mut s, "queue");
        request(&mut s, op::APP_LIFECYCLE, json!({"event":"launch"}));
        request(&mut s, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_ok(s.poll_idle(HostIdleOpportunity::until(
            Instant::now() + Duration::from_millis(50),
        )));
        assert_eq!(call(&mut s, "state"), json!([]));
        request(&mut s, op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_ok(s.poll_timers(0));
        assert_eq!(call(&mut s, "state"), json!(["tick"]));
    }
}
#[test]
fn scheduler_session_terminal_unload_drops_pending_work() {
    for engine in engines() {
        let mut s = fixture(engine);
        call(&mut s, "queue");
        request(&mut s, op::APP_LIFECYCLE, json!({"event":"launch"}));
        request(&mut s, op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_ok(s.poll_idle(HostIdleOpportunity::until(
            Instant::now() + Duration::from_millis(50),
        )));
        assert_ok(s.poll_timers(0));
        let id = s.loaded_modules["module:app.js"].module_id;
        assert_eq!(
            s.call_engine(
                CallTarget::Module {
                    id,
                    export: "state".into()
                },
                vec![]
            )
            .unwrap(),
            vec![json!([])]
        );
    }
}
