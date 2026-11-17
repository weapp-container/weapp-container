use super::*;
use container_ir::{AppInfo, CompilerInfo, Module, ModuleFormat, ModuleScope, Route, RouteKind};

const SESSION_ID: &str = "host-environment-gate";

fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request(SESSION_ID, format!("test-{operation}"), operation, payload)
}

fn manifest(source: &[u8]) -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "host-environment-gate".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        },
        routes: vec![Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "page.js".into(),
        }],
        modules: vec![Module {
            id: "module:app.js".into(),
            sha256: container_ir::hex_digest(source),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        }],
        ..Default::default()
    };
    for name in [
        "wx.getWindowInfo",
        "wx.getSystemInfoSync",
        "wx.getStorageSync",
        "wx.setStorageSync",
        "wx.removeStorageSync",
        "wx.getFileSystemManager",
        "wx.fs.readFileSync",
        "wx.fs.writeFileSync",
        "wx.onNetworkStatusChange",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    manifest.refresh_integrity().unwrap();
    manifest
}

fn assert_engine_failure(error: &BridgeError) {
    assert_eq!(error.code, BridgeErrorCode::Engine, "{error:?}");
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native {
    use super::*;

    // Keep one real AppService program for both engines. Raw calls below
    // deliberately leave jobs/effects pending; they are not runtime turns.
    const SOURCE: &[u8] = br#"
      (function() {
        const trace = [];
        function geometry() {
          const window = wx.getWindowInfo();
          const system = wx.getSystemInfoSync();
          return { windowWidth: window.windowWidth, windowHeight: window.windowHeight,
            systemWidth: system.windowWidth, systemHeight: system.windowHeight,
            safeWidth: window.safeArea.width, safeHeight: system.safeArea.height };
        }
        function record(kind) {
          const value = geometry();
          trace.push({kind: kind, geometry: value});
          return value;
        }
        globalThis.__mirror_read = function() {
          return {geometry: geometry(), trace: trace.slice(),
            first: wx.getStorageSync('pending-first'),
            last: wx.getStorageSync('pending-last'),
            host: wx.getStorageSync('host-owned'),
            removed: wx.getStorageSync('pending-remove'),
            undefinedValue: wx.getStorageSync('pending-undefined') === undefined,
            file: wx.getFileSystemManager().readFileSync('pending.txt', 'utf8'),
            registered: globalThis.__mirror_registered === true};
        };
        globalThis.__mirror_call = function() { return record('call'); };
        globalThis.__mirror_queue = function() {
          wx.setStorageSync('pending-first', 'first');
          wx.setStorageSync('pending-last', 'before');
          wx.setStorageSync('pending-remove', 'remove-me');
          wx.removeStorageSync('pending-remove');
          wx.setStorageSync('pending-undefined', undefined);
          wx.setStorageSync('pending-last', 'last');
          wx.getFileSystemManager().writeFileSync('pending.txt', 'kept', 'utf8');
          Promise.resolve().then(function() {
            wx.setStorageSync('promise-width', record('promise').windowWidth);
          }).then(function() {
            wx.setStorageSync('continuation-width', record('continuation').systemWidth);
          });
          return true;
        };
        globalThis.__mirror_schedule = function() {
          Promise.resolve().then(function() { record('pre-timer'); });
          [1, 2].forEach(function(index) {
            setTimeout(function() {
              wx.setStorageSync('timer-' + index, record('timer-' + index).windowWidth);
              Promise.resolve().then(function() {
                wx.setStorageSync('timer-micro-' + index,
                  record('timer-micro-' + index).systemWidth);
              });
            }, 1);
          });
          return true;
        };
        wx.onNetworkStatusChange(function() { record('network'); });
        App({});
        Page({onResize: function() { record('resize'); }});
      })();
    "#;

    fn fixture(engine: EngineKind) -> Session {
        let mut session = Session::new(
            manifest(SOURCE),
            SessionConfig {
                session_id: SESSION_ID.into(),
                engine,
                host: HostMetadata {
                    window_width: 375,
                    window_height: 667,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        session.set_provider(Box::new(
            SandboxProvider::new().seed_file("pending.txt", "seed"),
        ));
        let initialized = session.dispatch(request(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js", "source":String::from_utf8_lossy(SOURCE)}]}),
        ));
        assert_eq!(
            initialized.messages[0].payload["ok"], true,
            "{initialized:?}"
        );
        let launch = session.dispatch(request(op::APP_LIFECYCLE, json!({"event":"launch"})));
        assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
        let page = session.dispatch(request(op::PAGE_PUSH, json!({"path":"pages/index/index"})));
        assert_eq!(page.messages[0].payload["ok"], true, "{page:?}");
        session
    }

    fn target(name: &str) -> CallTarget {
        CallTarget::Global { name: name.into() }
    }

    fn raw_call(session: &mut Session, name: &str) -> ValueBatch {
        match session.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => container_core::JsEngine::call(
                session.quickjs_engine.as_mut().unwrap(),
                target(name),
                vec![],
            )
            .unwrap(),
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => container_core::JsEngine::call(
                session.v8_engine.as_mut().unwrap(),
                target(name),
                vec![],
            )
            .unwrap(),
            #[allow(unreachable_patterns)]
            _ => panic!("test selected an engine without a native provider"),
        }
    }

    fn new_geometry() -> Value {
        json!({"windowWidth":320, "windowHeight":640, "systemWidth":320,
            "systemHeight":640, "safeWidth":320, "safeHeight":640})
    }

    fn dirty_geometry(session: &mut Session) {
        session.mark_engine_host_environment_dirty().unwrap();
        session.config.host.window_width = 320;
        session.config.host.window_height = 640;
    }

    fn same_turn_repair_preserves_pending_business_state(engine: EngineKind) {
        let mut session = fixture(engine);
        session
            .with_engine_host_turn(None, |session| {
                raw_call(session, "__mirror_queue");
                let pending = raw_call(session, "__mirror_read");
                assert_eq!(pending[0]["trace"], json!([]));
                assert_eq!(pending[0]["file"], "kept");
                assert!(session.app_service().storage().is_empty());

                // A Rust-owned revision must be installed without discarding
                // queued JS patches, including remove/undefined/last-write.
                session
                    .app_service
                    .storage_mut()
                    .set("host-owned", json!("fresh"))
                    .unwrap();
                session
                    .app_service
                    .storage_mut()
                    .set("pending-first", json!("stale"))
                    .unwrap();
                dirty_geometry(session);
                let result = session.call_engine(target("__mirror_call"), vec![])?;
                assert_eq!(result, vec![new_geometry()]);
                let read = raw_call(session, "__mirror_read");
                assert_eq!(read[0]["geometry"], new_geometry());
                assert_eq!(read[0]["first"], "first");
                assert_eq!(read[0]["last"], "last");
                assert_eq!(read[0]["host"], "fresh");
                assert_eq!(read[0]["removed"], "");
                assert_eq!(read[0]["undefinedValue"], true);
                assert_eq!(read[0]["file"], "kept");
                assert_eq!(
                    read[0]["trace"],
                    json!([
                        {"kind":"call", "geometry":new_geometry()},
                        {"kind":"promise", "geometry":new_geometry()},
                        {"kind":"continuation", "geometry":new_geometry()}
                    ])
                );

                let mut messages = Vec::new();
                session.append_engine_effects(&mut messages)?;
                assert!(
                    !messages
                        .iter()
                        .any(|message| message.payload["ok"] == false),
                    "{messages:?}"
                );
                Ok(())
            })
            .unwrap();
        let storage = session.app_service().storage();
        assert_eq!(storage.get("pending-first"), Some(&json!("first")));
        assert_eq!(storage.get("pending-last"), Some(&json!("last")));
        assert_eq!(storage.get("host-owned"), Some(&json!("fresh")));
        assert!(!storage.contains_key("pending-remove"));
        assert!(storage.is_undefined("pending-undefined"));
        assert_eq!(storage.get("promise-width"), Some(&json!(320)));
        assert_eq!(storage.get("continuation-width"), Some(&json!(320)));
        assert_eq!(
            session.provider.sync_file_snapshot()["pending.txt"].as_slice(),
            b"kept"
        );
        assert!(session.execution_fault().is_none());
    }

    fn timer_checkpoints_observe_repaired_environment(engine: EngineKind) {
        let mut session = fixture(engine);
        raw_call(&mut session, "__mirror_schedule");
        assert_eq!(
            raw_call(&mut session, "__mirror_read")[0]["trace"],
            json!([])
        );
        dirty_geometry(&mut session);
        let polled = session.poll_timers(u64::MAX);
        assert!(
            !polled
                .messages
                .iter()
                .any(|message| message.payload["ok"] == false),
            "{polled:?}"
        );
        let expected = [
            "pre-timer",
            "timer-1",
            "timer-micro-1",
            "timer-2",
            "timer-micro-2",
        ]
        .into_iter()
        .map(|kind| json!({"kind":kind, "geometry":new_geometry()}))
        .collect::<Vec<_>>();
        assert_eq!(
            raw_call(&mut session, "__mirror_read")[0]["trace"],
            json!(expected)
        );
        for key in ["timer-1", "timer-2", "timer-micro-1", "timer-micro-2"] {
            assert_eq!(
                session.app_service().storage().get(key),
                Some(&json!(320)),
                "{key}"
            );
        }
        let timer_type = if engine == EngineKind::V8 {
            "v8.timer"
        } else {
            "quickjs.timer"
        };
        assert!(polled
            .messages
            .iter()
            .any(|message| message.payload["type"] == timer_type));
        assert!(session.poll_timers(u64::MAX).messages.is_empty());
    }

    fn failed_native_install_remains_sticky(
        engine: EngineKind,
        remove_install_restore: impl FnOnce(&mut Session) -> BridgeError,
    ) {
        let mut session = fixture(engine);
        raw_call(&mut session, "__mirror_queue");
        raw_call(&mut session, "__mirror_schedule");
        dirty_geometry(&mut session);
        let failure = remove_install_restore(&mut session);
        assert_engine_failure(&failure);
        assert!(
            failure.message.contains("native provider is unavailable"),
            "{failure:?}"
        );
        assert_eq!(session.execution_fault().unwrap().message, failure.message);

        assert_engine_failure(
            &session
                .call_engine(target("__mirror_call"), vec![])
                .unwrap_err(),
        );
        assert_engine_failure(
            &session
                .register_engine_module(
                    "never-installed.js",
                    b"globalThis.__mirror_registered = true;",
                    &[],
                    false,
                )
                .unwrap_err(),
        );
        let mut effects = Vec::new();
        if let Err(error) = session.append_engine_effects(&mut effects) {
            assert_engine_failure(&error);
        } else {
            assert!(
                effects
                    .iter()
                    .any(|message| message.payload["error"]["code"] == "ERR_ENGINE"),
                "{effects:?}"
            );
        }
        let mut owner_entered = false;
        let owner = session.with_engine_host_turn(None, |_| {
            owner_entered = true;
            Ok(())
        });
        assert_engine_failure(&owner.unwrap_err());
        assert!(!owner_entered);
        let timers = session.poll_timers(u64::MAX);
        assert!(
            timers
                .messages
                .iter()
                .any(|message| message.payload["error"]["code"] == "ERR_ENGINE"),
            "{timers:?}"
        );
        assert_engine_failure(&session.notify_viewport_resize(480, 800).unwrap_err());
        assert_engine_failure(
            &session
                .notify_network_status_change(NetworkType::FiveG)
                .unwrap_err(),
        );
        assert_eq!(session.config.host.window_width, 320);
        assert_eq!(session.config.host.window_height, 640);

        // Native inspection intentionally does not checkpoint. None of the
        // rejected calls may run a queued Promise, timer, resize or listener.
        let untouched = raw_call(&mut session, "__mirror_read");
        assert_eq!(untouched[0]["trace"], json!([]));
        assert_eq!(untouched[0]["registered"], false);
        assert_eq!(untouched[0]["geometry"]["windowWidth"], 375);
        assert_eq!(untouched[0]["file"], "kept");
        assert!(session.app_service().storage().is_empty());
        assert_eq!(
            session.provider.sync_file_snapshot()["pending.txt"].as_slice(),
            b"seed"
        );
    }

    #[test]
    fn native_stale_receiver_capture_remains_cancelled() {
        let check = |engine| {
            let mut session = fixture(engine);
            let page = session.app_service.pages().current().unwrap().id.0;
            session.live_receiver_snapshot(page, &[]).unwrap();
            let error = session.live_receiver_snapshot(u64::MAX, &[]).unwrap_err();
            assert_eq!(
                error.code,
                BridgeErrorCode::Cancelled,
                "{engine:?}: {error}"
            );
        };
        #[cfg(feature = "quickjs-native")]
        check(EngineKind::Quickjs);
        #[cfg(feature = "v8-native")]
        check(EngineKind::V8);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_same_turn_repair_keeps_pending_storage_files_and_jobs() {
        same_turn_repair_preserves_pending_business_state(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_same_turn_repair_keeps_pending_storage_files_and_jobs() {
        same_turn_repair_preserves_pending_business_state(EngineKind::V8);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_timer_checkpoints_repair_before_application_jobs() {
        timer_checkpoints_observe_repaired_environment(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_timer_checkpoints_repair_before_application_jobs() {
        timer_checkpoints_observe_repaired_environment(EngineKind::V8);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_failed_native_install_rejects_all_runtime_reentry() {
        failed_native_install_remains_sticky(EngineKind::Quickjs, |session| {
            let engine = session.quickjs_engine.take().unwrap();
            let failure = session.ensure_engine_environment_current().unwrap_err();
            session.quickjs_engine = Some(engine);
            failure
        });
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_failed_native_install_rejects_all_runtime_reentry() {
        failed_native_install_remains_sticky(EngineKind::V8, |session| {
            let engine = session.v8_engine.take().unwrap();
            let failure = session.ensure_engine_environment_current().unwrap_err();
            session.v8_engine = Some(engine);
            failure
        });
    }
}

#[cfg(not(feature = "quickjs-native"))]
#[test]
fn no_native_quickjs_keeps_headless_protocol_but_rejects_javascript() {
    let source = b"App({}); Page({});";
    let mut session = Session::new(
        manifest(source),
        SessionConfig {
            session_id: SESSION_ID.into(),
            ..Default::default()
        },
    )
    .unwrap();
    session.mark_engine_host_environment_dirty().unwrap();
    let init = session.dispatch(request(op::APP_INIT, json!({})));
    assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
    assert!(!session.engine_provider_available());
    let launch = session.dispatch(request(op::APP_LIFECYCLE, json!({"event":"launch"})));
    assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
    let page = session.dispatch(request(op::PAGE_PUSH, json!({"path":"pages/index/index"})));
    assert_eq!(page.messages[0].payload["ok"], true, "{page:?}");
    let stored = session.dispatch(request(
        op::API_CALL,
        json!({"name":"wx.setStorageSync", "key":"headless", "data":{"kept":true}}),
    ));
    assert_eq!(stored.messages[0].payload["ok"], true, "{stored:?}");
    assert_eq!(
        session.app_service().storage().get("headless"),
        Some(&json!({"kept":true}))
    );
    assert_engine_failure(
        &session
            .register_engine_module("app.js", source, &[], false)
            .unwrap_err(),
    );
    assert_engine_failure(
        &session
            .call_engine(
                CallTarget::Global {
                    name: "not-executed".into(),
                },
                vec![],
            )
            .unwrap_err(),
    );
    assert!(session.execution_fault().is_none());
}

#[cfg(not(feature = "v8-native"))]
#[test]
fn no_native_v8_is_explicitly_unavailable() {
    let result = Session::new(
        manifest(b"App({});"),
        SessionConfig {
            engine: EngineKind::V8,
            ..Default::default()
        },
    );
    assert!(matches!(
        result,
        Err(SessionError::EngineUnavailable {
            engine: EngineKind::V8
        })
    ));
}
