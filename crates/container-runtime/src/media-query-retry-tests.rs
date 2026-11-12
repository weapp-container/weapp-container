use container_ir::{hex_digest, Module, ModuleFormat, ModuleScope, Route, RouteKind};

const APP_ID: &str = "module:media-retry-app.js";
const ROUTE: &str = "pages/media-retry/index";
const APP: &str = r#"
App({trace:[],intersections:[]});let observer,notifier;
exports.observe=function(){
  observer=getCurrentPages()[0].createMediaQueryObserver();
  observer.observe({minWidth:150},function(value){getApp().trace.push(value.matches);});
  return true;
};
exports.disconnect=function(){observer.disconnect();return true;};
exports.state=function(){return {trace:getApp().trace,intersections:getApp().intersections};};
exports.intersection=function(){
  // A fresh media subscription and intersection share this observation batch.
  getCurrentPages()[0].createMediaQueryObserver().observe({minWidth:50},function(value){getApp().trace.push(value.matches);});
  wx.createIntersectionObserver(getCurrentPages()[0],{thresholds:[0.5]})
    .relativeToViewport().observe('#target',function(value){getApp().intersections.push(value.intersectionRatio);});
  notifier=__container_notify_observers;
  globalThis.__container_notify_observers=function(){throw Error('later intersection transport failed');};
  return true;
};
exports.restore=function(){globalThis.__container_notify_observers=notifier;return true;};
exports.intersectionOnly=function(){
  getApp().intersectionObserver=wx.createIntersectionObserver(getCurrentPages()[0]);
  getApp().intersectionObserver.observe('#target',function(value){getApp().intersections.push(value.intersectionRatio);});
  return true;
};
exports.intersectionVoidCleanup=function(){
  const observer=getApp().intersectionObserver;
  return {first:observer.disconnect()===undefined,repeated:observer.disconnect()===undefined};
};
exports.intersectionInvalidAfterCleanup=function(){
  getApp().intersectionObserver.disconnect();
  wx.createIntersectionObserver().observe('#broken[',function(){});
  return true;
};
exports.intersectionRecovery=function(){
  wx.createIntersectionObserver().observe('#target',function(value){getApp().intersections.push(value.intersectionRatio);});
  wx.setStorageSync('intersection-admission-recovery',7);
  return true;
};
exports.intersectionProxyRoots=function(){
  let blocked=0;const observer=wx.createIntersectionObserver({nativeMode:true});
  const margins=new Proxy({top:1},{getOwnPropertyDescriptor:function(target,key){
    if(key==='top'){try{observer.relativeToViewport();}catch(error){blocked++;}}
    return Reflect.getOwnPropertyDescriptor(target,key);
  }});
  observer.relativeToViewport(margins).observe('#target',function(value){getApp().intersections.push(value.intersectionRatio);});
  return blocked;
};
exports.intersectionReentrant=function(){
  const observer=wx.createIntersectionObserver();
  observer.observe('#target',function(){'use strict';getApp().intersections.push({label:'first',unbound:this===undefined});observer.disconnect();});
  observer.observe('#target',function(){getApp().intersections.push('revoked');});
  wx.createIntersectionObserver().observe('#target',function(){getApp().intersections.push('other');});
  return true;
};
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

struct Fixture {
    session: Session,
    sequence: u64,
}

impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let page = "Page({});";
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "media-retry-unit".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = APP_ID.into();
        manifest.routes.push(Route {
            id: "route:media-retry".into(),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: Some(format!("{ROUTE}.json")),
            entry_module: "module:media-retry-page.js".into(),
        });
        for name in [
            "getCurrentPages",
            "wx.createMediaQueryObserver",
            "wx.createIntersectionObserver",
            "wx.setStorageSync",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        for (id, source, scope) in [
            (APP_ID, APP, ModuleScope::App),
            ("module:media-retry-page.js", page, ModuleScope::Page),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    host: HostMetadata {
                        window_width: 100,
                        window_height: 200,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        fixture.success(
            op::APP_INIT,
            json!({"modules":[
                {"id":APP_ID,"source":APP},{"id":"module:media-retry-page.js","source":page}
            ]}),
        );
        fixture.success(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.success(op::PAGE_PUSH, json!({"path":ROUTE}));
        fixture.success(
            op::MODULE_CALL,
            json!({"moduleId":APP_ID,"export":"observe","args":[]}),
        );
        let first = fixture.session.poll_timers(0);
        assert!(
            first.messages.iter().all(|message| message.op != op::ERROR),
            "{first:?}"
        );
        assert_eq!(fixture.state()["trace"], json!([false]));
        assert!(!fixture.session.observer_observation_pending);
        fixture
    }

    fn success(&mut self, operation: &str, payload: Value) {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("media-retry-{}", self.sequence),
            operation,
            payload,
        ));
        assert!(
            batch
                .messages
                .iter()
                .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
            "{batch:?}"
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
    }

    fn call(&mut self, export: &str) -> Value {
        let (_, id) = self.session.resolve_module_id(&json!(APP_ID)).unwrap();
        self.session
            .call_engine(
                CallTarget::Module {
                    id,
                    export: export.into(),
                },
                vec![],
            )
            .unwrap()
            .remove(0)
    }

    fn state(&mut self) -> Value {
        self.call("state")
    }

    fn changed_environment(&mut self) {
        self.session.mark_engine_host_environment_dirty().unwrap();
        self.session.config.host.window_width = 200;
        self.session.config.host.window_height = 100;
        self.session.ensure_engine_environment_current().unwrap();
    }

    fn fail_changed_observation(&mut self, boundary: MediaTestBoundary) {
        self.changed_environment();
        self.session.observers.borrow_mut().media_test_failure = Some(boundary);
        let error = self.session.notify_observers(&mut Vec::new()).unwrap_err();
        assert!(error.message.contains("failed once"));
        assert!(
            self.session.observer_observation_pending,
            "changed viewport debt was lost"
        );
        assert!(
            self.session.execution_fault().is_none(),
            "ordinary transport error poisoned the realm"
        );
        assert_eq!(self.state()["trace"], json!([false]));
        let registry = self.session.observers.borrow();
        assert!(registry
            .subscriptions
            .values()
            .all(|subscription| subscription.state.matches == Some(false)));
    }
}

#[test]
fn media_retry_after_one_time_capture_and_dispatch_failures_delivers_once() {
    for engine in engines() {
        for boundary in [MediaTestBoundary::Capture, MediaTestBoundary::Dispatch] {
            let mut fixture = Fixture::new(engine);
            fixture.fail_changed_observation(boundary);
            let retry = fixture.session.poll_timers(0);
            assert!(
                retry.messages.iter().all(|message| message.op != op::ERROR),
                "{retry:?}"
            );
            assert_eq!(fixture.state()["trace"], json!([false, true]));
            assert!(!fixture.session.observer_observation_pending);
            fixture.session.poll_timers(0);
            assert_eq!(
                fixture.state()["trace"],
                json!([false, true]),
                "successful notification replayed"
            );
        }
    }
}

#[test]
fn media_retry_does_not_revive_subscriptions_disconnected_after_failure() {
    for engine in engines() {
        for boundary in [MediaTestBoundary::Capture, MediaTestBoundary::Dispatch] {
            let mut fixture = Fixture::new(engine);
            fixture.fail_changed_observation(boundary);
            fixture.call("disconnect");
            fixture.session.poll_timers(0);
            assert_eq!(fixture.state()["trace"], json!([false]));
            assert!(fixture.session.observers.borrow().subscriptions.is_empty());
            assert!(!fixture.session.observer_observation_pending);
            fixture.session.notify_viewport_resize(100, 200).unwrap();
            fixture.session.notify_viewport_resize(200, 100).unwrap();
            fixture.session.poll_timers(0);
            assert_eq!(
                fixture.state()["trace"],
                json!([false]),
                "revoked subscription revived on retry"
            );
        }
    }
}

#[test]
fn private_media_and_intersection_commits_are_not_replayed_after_public_diagnostic_failure() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.success(op::RENDER_COMMIT,json!({
            "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},
            "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},"opacity":1.0,
                "children":[{"id":"target","attributes":{"id":"target"},
                    "bounds":{"x":0.0,"y":0.0,"width":50.0,"height":50.0},"opacity":1.0,"children":[]}]}
        }));
        assert!(fixture.session.is_current_frame_presented());
        fixture.success(
            op::MODULE_CALL,
            json!({"moduleId":APP_ID,"export":"intersection","args":[]}),
        );
        fixture
            .session
            .observer_api_result(
                "wx.createIntersectionObserver",
                &Map::from_iter([
                    ("observerId".into(), json!("legacy-diagnostic")),
                    ("subscriptionId".into(), json!("legacy-subscription")),
                    ("action".into(), json!("observe")),
                    ("selector".into(), json!("#target")),
                ]),
                None,
                None,
            )
            .unwrap();
        let error = fixture
            .session
            .notify_observers(&mut Vec::new())
            .unwrap_err();
        assert!(
            error
                .message
                .contains("later intersection transport failed"),
            "{error:?}"
        );
        assert_eq!(fixture.state()["trace"], json!([false, true]));
        assert!(fixture.session.observer_observation_pending);
        let delivered = fixture.state()["intersections"].clone();
        assert_eq!(delivered.as_array().unwrap().len(), 1);
        assert_eq!(delivered[0].as_f64(), Some(1.0));
        fixture.call("restore");
        fixture.session.poll_timers(0);
        let state = fixture.state();
        assert_eq!(
            state["trace"],
            json!([false, true]),
            "committed media match replayed while retrying intersection"
        );
        assert_eq!(state["intersections"].as_array().unwrap().len(), 1);
        assert_eq!(state["intersections"][0].as_f64(), Some(1.0));
        assert!(!fixture.session.observer_observation_pending);
        fixture.session.poll_timers(0);
        assert_eq!(fixture.state(), state);
    }
}

fn intersection_count(fixture: &Fixture) -> usize {
    fixture
        .session
        .observers
        .borrow()
        .subscriptions
        .values()
        .filter(|entry| entry.intersection_identity.is_some())
        .count()
}

fn intersection_snapshot(fixture: &mut Fixture) -> Value {
    match fixture.session.config.engine {
        EngineKind::Quickjs => {
            #[cfg(feature = "quickjs-native")]
            {
                fixture
                    .session
                    .quickjs_engine
                    .as_mut()
                    .unwrap()
                    .capture_intersection_query_state(None)
                    .unwrap()
            }
            #[cfg(not(feature = "quickjs-native"))]
            {
                unreachable!()
            }
        }
        EngineKind::V8 => {
            #[cfg(feature = "v8-native")]
            {
                fixture
                    .session
                    .v8_engine
                    .as_mut()
                    .unwrap()
                    .capture_intersection_query_state(None)
                    .unwrap()
            }
            #[cfg(not(feature = "v8-native"))]
            {
                unreachable!()
            }
        }
    }
}

#[test]
fn intersection_disconnect_is_void_and_native_cleanup_survives_capability_revocation() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        assert_eq!(intersection_count(&fixture), 1);
        fixture.session.config.capabilities.insert(
            "wx.createIntersectionObserver".into(),
            CapabilitySupport::Unsupported,
        );
        fixture
            .session
            .mark_engine_host_environment_dirty()
            .unwrap();
        fixture.session.ensure_engine_environment_current().unwrap();
        assert_eq!(
            fixture.call("intersectionVoidCleanup"),
            json!({"first":true,"repeated":true})
        );
        fixture.session.reconcile_intersection_queries().unwrap();
        assert_eq!(intersection_count(&fixture), 0);
        assert_eq!(
            fixture.session.observers.borrow().subscriptions.len(),
            1,
            "media ownership was disturbed"
        );
        fixture
            .session
            .config
            .capabilities
            .remove("wx.createIntersectionObserver");
        fixture
            .session
            .mark_engine_host_environment_dirty()
            .unwrap();
        fixture.session.ensure_engine_environment_current().unwrap();
        fixture.session.reconcile_intersection_queries().unwrap();
        assert_eq!(
            intersection_count(&fixture),
            0,
            "disconnected observer revived"
        );
    }
}

#[test]
fn intersection_invalid_admission_is_consumed_once_and_unrelated_host_effects_recover() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        assert_eq!(intersection_count(&fixture), 1);
        fixture.call("intersectionInvalidAfterCleanup");
        assert!(fixture.session.reconcile_intersection_queries().is_err());
        assert_eq!(
            intersection_count(&fixture),
            0,
            "unrelated invalid selector blocked cleanup"
        );
        let snapshot = intersection_snapshot(&mut fixture);
        assert!(
            snapshot["subscriptions"].as_array().unwrap().is_empty(),
            "rejected bad subscription remains private desired state: {snapshot}"
        );
        fixture.call("intersectionRecovery");
        let mut messages = Vec::new();
        fixture
            .session
            .append_engine_effects(&mut messages)
            .unwrap();
        assert!(
            messages
                .iter()
                .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
            "recovery effects failed: {messages:?}"
        );
        assert_eq!(
            fixture
                .session
                .app_service()
                .storage()
                .get("intersection-admission-recovery"),
            Some(&json!(7)),
            "unrelated storage effect remained blocked"
        );
        assert_eq!(intersection_count(&fixture), 1);
        let snapshot = intersection_snapshot(&mut fixture);
        assert_eq!(snapshot["subscriptions"].as_array().unwrap().len(), 1);
        assert_eq!(snapshot["subscriptions"][0]["selector"], "#target");
        fixture.session.reconcile_intersection_queries().unwrap();
        fixture
            .session
            .append_engine_effects(&mut Vec::new())
            .unwrap();
        fixture.success(op::RENDER_COMMIT,json!({
            "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},
            "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},"opacity":1.0,
                "children":[{"id":"target","attributes":{"id":"target"},
                    "bounds":{"x":0.0,"y":0.0,"width":50.0,"height":50.0},"opacity":1.0,"children":[]}]}
        }));
        fixture.session.notify_observers(&mut Vec::new()).unwrap();
        assert_eq!(
            fixture.state()["intersections"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::as_f64)
                .collect::<Vec<_>>(),
            vec![Some(1.0)],
            "valid observer did not recover after bad admission"
        );
        fixture.session.notify_observers(&mut Vec::new()).unwrap();
        assert_eq!(
            fixture.state()["intersections"]
                .as_array()
                .unwrap()
                .iter()
                .map(Value::as_f64)
                .collect::<Vec<_>>(),
            vec![Some(1.0)],
            "recovery delivery replayed"
        );
    }
}

#[test]
fn intersection_public_effects_and_reserved_ids_have_no_private_registry_authority() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        let observer = fixture
            .session
            .observers
            .borrow()
            .subscriptions
            .keys()
            .find(|key| key.0.starts_with("intersection:"))
            .unwrap()
            .0
            .clone();
        let payload = Map::from_iter([
            ("observerId".into(), json!(observer)),
            ("action".into(), json!("disconnect")),
        ]);
        assert!(fixture
            .session
            .observer_effect_result("wx.createIntersectionObserver", &payload)
            .is_err());
        assert!(fixture
            .session
            .observer_api_result("wx.createIntersectionObserver", &payload, None, None)
            .is_err());
        assert_eq!(intersection_count(&fixture), 1);
    }
}

#[test]
fn intersection_disconnect_during_native_batch_suppresses_later_same_observer_delivery() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.success(op::RENDER_COMMIT,json!({
            "frameId":1,"viewport":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},
            "root":{"id":"root","bounds":{"x":0.0,"y":0.0,"width":100.0,"height":200.0},"opacity":1.0,
                "children":[{"id":"target","attributes":{"id":"target"},
                    "bounds":{"x":0.0,"y":0.0,"width":50.0,"height":50.0},"opacity":1.0,"children":[]}]}
        }));
        fixture.call("intersectionReentrant");
        fixture.session.notify_observers(&mut Vec::new()).unwrap();
        assert_eq!(
            fixture.state()["intersections"],
            json!([{"label":"first","unbound":true},"other"])
        );
        fixture.session.reconcile_intersection_queries().unwrap();
        assert_eq!(intersection_count(&fixture), 1);
        fixture.session.notify_observers(&mut Vec::new()).unwrap();
        assert_eq!(
            fixture.state()["intersections"].as_array().unwrap().len(),
            2,
            "threshold state replayed"
        );
    }
}

#[test]
fn intersection_proxy_root_projection_preserves_native_single_root_admission() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        assert_eq!(fixture.call("intersectionProxyRoots"), json!(1));
        fixture.session.reconcile_intersection_queries().unwrap();
        let snapshot = intersection_snapshot(&mut fixture);
        assert_eq!(
            snapshot["subscriptions"][0]["options"]["relativeRoots"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(intersection_count(&fixture), 1);
    }
}

#[test]
fn intersection_and_media_cleanup_each_run_despite_other_family_admission_failure() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        fixture.call("intersectionVoidCleanup");
        fixture.session.observers.borrow_mut().media_test_failure =
            Some(MediaTestBoundary::Capture);
        assert!(fixture.session.reconcile_observer_queries().is_err());
        assert_eq!(
            intersection_count(&fixture),
            0,
            "media capture failure blocked disconnected intersection cleanup"
        );

        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        fixture.call("disconnect");
        fixture.call("intersectionInvalidAfterCleanup");
        assert!(fixture.session.reconcile_observer_queries().is_err());
        assert!(
            fixture.session.observers.borrow().subscriptions.is_empty(),
            "intersection admission failure blocked disconnected media cleanup"
        );
        fixture.session.reconcile_observer_queries().unwrap();
    }
}

#[test]
fn intersection_rejection_transport_failure_preserves_retry_debt_until_ack() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        fixture.call("intersectionOnly");
        fixture.session.reconcile_intersection_queries().unwrap();
        fixture.call("intersectionInvalidAfterCleanup");
        fixture
            .session
            .observers
            .borrow_mut()
            .intersection_test_reject_failure = true;
        let failed = fixture
            .session
            .reconcile_intersection_queries()
            .unwrap_err();
        assert_eq!(failed.code, BridgeErrorCode::Engine);
        assert_eq!(
            intersection_count(&fixture),
            0,
            "failed reject transport blocked prior cleanup"
        );
        let snapshot = intersection_snapshot(&mut fixture);
        assert_eq!(
            snapshot["subscriptions"].as_array().unwrap().len(),
            1,
            "failed reject was falsely acknowledged"
        );
        assert_eq!(snapshot["subscriptions"][0]["selector"], "#broken[");
        let rejected = fixture
            .session
            .reconcile_intersection_queries()
            .unwrap_err();
        assert_eq!(rejected.code, BridgeErrorCode::InvalidRequest);
        assert!(intersection_snapshot(&mut fixture)["subscriptions"]
            .as_array()
            .unwrap()
            .is_empty());
        fixture.session.reconcile_intersection_queries().unwrap();
    }
}
