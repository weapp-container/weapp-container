//! AppService host-turn execution boundaries, using actual native QuickJS.
//! Adversarial JavaScript only runs in an owned child with an outer watchdog:
//! a broken interrupt boundary must fail this test, never hang the test runner.
//! This is native runtime evidence, not browser Worker or device acceptance.

use container_bridge::BridgeErrorCode;
use container_core::EngineKind;
use container_ir::ContainerManifestV1;
use container_runtime::{EngineExecutionPolicy, Session, SessionConfig, SessionError};
use serde_json::json;

fn minimal_manifest() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "appservice-turn-budget-fixture".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.refresh_integrity().unwrap();
    manifest
}

#[test]
fn omitted_execution_policy_preserves_the_unbounded_legacy_default() {
    let parsed: SessionConfig = serde_json::from_value(json!({})).unwrap();
    assert_eq!(parsed.engine_execution.turn_timeout_ms, None);
    assert_eq!(parsed.engine_execution.bootstrap_timeout_ms, None);
    assert_eq!(
        SessionConfig::default().engine_execution,
        parsed.engine_execution
    );
}

#[test]
fn zero_and_excessive_execution_limits_are_configuration_errors() {
    for value in [0, 86_400_001] {
        for policy in [
            EngineExecutionPolicy {
                turn_timeout_ms: Some(value),
                bootstrap_timeout_ms: None,
            },
            EngineExecutionPolicy {
                turn_timeout_ms: None,
                bootstrap_timeout_ms: Some(value),
            },
        ] {
            let result = Session::new(
                minimal_manifest(),
                SessionConfig {
                    engine: EngineKind::Quickjs,
                    engine_execution: policy,
                    ..SessionConfig::default()
                },
            );
            assert!(matches!(result, Err(SessionError::Config(_))));
        }
    }
}

fn assert_bounded_engine_rejected(engine: EngineKind) {
    for policy in [
        EngineExecutionPolicy {
            turn_timeout_ms: Some(250),
            bootstrap_timeout_ms: None,
        },
        EngineExecutionPolicy {
            turn_timeout_ms: None,
            bootstrap_timeout_ms: Some(5_000),
        },
    ] {
        let result = Session::new(
            minimal_manifest(),
            SessionConfig {
                engine,
                engine_execution: policy,
                ..SessionConfig::default()
            },
        );
        match result {
            Err(SessionError::EngineExecution(error)) => {
                assert_eq!(error.code, BridgeErrorCode::Engine);
            }
            Err(error) => panic!("bounded {engine:?} lost its execution-policy error: {error}"),
            Ok(_) => panic!("bounded {engine:?} silently accepted an unsupported budget"),
        }
    }
}

#[test]
fn v8_does_not_silently_accept_quickjs_execution_budgets() {
    assert_bounded_engine_rejected(EngineKind::V8);
}

#[cfg(not(feature = "quickjs-native"))]
#[test]
fn headless_quickjs_does_not_silently_accept_execution_budgets() {
    assert_bounded_engine_rejected(EngineKind::Quickjs);
}

#[cfg(all(feature = "quickjs-native", not(target_arch = "wasm32")))]
mod native {
    use super::*;
    use container_bridge::{op, BridgeBatch, BridgeEnvelope, BridgeError, EnvelopeKind};
    use container_ir::{
        hex_digest, parse_wxml, BrowserGeometryBatch, BrowserNodeGeometry, CapabilitySupport,
        Component, Module, ModuleFormat, ModuleScope, RendererProfile, Route, RouteKind, Template,
        ViewNode, ViewPoint, ViewRect, ViewSize, VIEW_PRESENTATION_VERSION,
    };
    use container_render_skia::{PageRenderMode, Rect, Renderer};
    use container_runtime::{
        BrowserLiveViewSubmission, BrowserViewSubmission, HostMetadata, NetworkType,
    };
    use serde_json::Value;
    use std::collections::BTreeMap;
    use std::process::{Child, Command, Output, Stdio};
    use std::sync::Mutex;
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    const SESSION_ID: &str = "appservice-turn-budget";
    const APP: &str = "module:app.js";
    const PAGE: &str = "module:pages/home/index.js";
    const ROUTE: &str = "pages/home/index";
    const CHILD_CASE: &str = "WEAPP_CONTAINER_RUNTIME_BUDGET_CASE";
    const TURN_MS: u64 = 250;
    const WATCHDOG: Duration = Duration::from_secs(20);
    const SAFE_APP: &str = "App({}); exports.finite = function() { return 42; };";
    const SAFE_PAGE: &str = "Page({data:{show:false},tap(){},touch(){},cancel(){}});";
    const WXML: &str = r#"<view id="target" bindtap="tap" bindtouchstart="touch" bindtouchcancel="cancel">hello</view>"#;

    // These are semantic deadline tests. Serial children avoid making their
    // short policy compete with many other copies of this same test binary.
    static CHILD_LOCK: Mutex<()> = Mutex::new(());

    struct OwnedChild(Option<Child>);

    impl OwnedChild {
        fn finish(mut self) -> Output {
            self.0
                .take()
                .expect("owned test child")
                .wait_with_output()
                .expect("reap owned test child")
        }

        fn terminate(mut self) -> Output {
            let child = self.0.as_mut().expect("owned test child");
            // Only the child created by this test is ever terminated. If it
            // exited between polling and kill, wait still reaps that child.
            if let Err(error) = child.kill() {
                assert!(
                    child
                        .try_wait()
                        .expect("inspect owned test child")
                        .is_some(),
                    "cannot terminate owned test child: {error}"
                );
            }
            self.finish()
        }
    }

    impl Drop for OwnedChild {
        fn drop(&mut self) {
            if let Some(mut child) = self.0.take() {
                if let Err(error) = child.kill() {
                    eprintln!("test-child cleanup kill reported: {error}");
                }
                if let Err(error) = child.wait() {
                    eprintln!("test-child cleanup wait failed: {error}");
                }
            }
        }
    }

    fn child_output(output: &Output) -> String {
        format!(
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    }

    fn isolated(case: &str) {
        let _serial = CHILD_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let process = Command::new(std::env::current_exe().expect("runtime test executable"))
            .args([
                "--exact",
                "native::budget_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_CASE, case)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn owned runtime-budget test child");
        let mut child = OwnedChild(Some(process));
        let started = Instant::now();
        loop {
            if child
                .0
                .as_mut()
                .unwrap()
                .try_wait()
                .expect("poll owned test child")
                .is_some()
            {
                let output = child.finish();
                assert!(output.status.success(), "{case}: {}", child_output(&output));
                return;
            }
            if started.elapsed() >= WATCHDOG {
                let output = child.terminate();
                panic!(
                    "{case}: runtime budget failed to return before the independent watchdog; {}",
                    child_output(&output)
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    macro_rules! isolated_case {
        ($name:ident, $case:literal) => {
            #[test]
            fn $name() {
                isolated($case);
            }
        };
    }

    isolated_case!(module_initialization_is_bounded, "module-init");
    isolated_case!(lazy_module_loading_is_bounded, "module-load");
    isolated_case!(module_calls_are_bounded_and_require_restart, "module-call");
    isolated_case!(result_to_json_stays_inside_the_turn, "result-to-json");
    isolated_case!(wx_error_handlers_stay_inside_the_turn, "wx-on-error");
    isolated_case!(
        thrown_value_descriptor_traps_stay_inside_the_turn,
        "error-descriptor"
    );
    isolated_case!(
        thrown_value_prototype_traps_stay_inside_the_turn,
        "error-prototype"
    );
    isolated_case!(
        api_callback_diagnostic_getters_stay_inside_the_turn,
        "api-callback-error-getter"
    );
    isolated_case!(short_infinite_promise_chain_is_bounded, "promise-chain");
    isolated_case!(
        exception_cleanup_effects_keep_the_same_budget,
        "failure-effects"
    );
    isolated_case!(
        consumed_storage_effects_survive_a_later_callback_timeout,
        "consumed-effects"
    );
    isolated_case!(multiple_envelopes_share_one_outer_budget, "dispatch-batch");
    isolated_case!(
        request_deadline_tightens_the_host_policy,
        "request-deadline"
    );
    isolated_case!(storage_sync_is_inside_the_host_turn, "storage-sync");
    isolated_case!(capability_sync_is_inside_the_host_turn, "capability-sync");
    isolated_case!(timers_are_bounded_without_a_bridge_dispatch, "timer");
    isolated_case!(sdk_host_completion_is_bounded, "sdk-complete");
    isolated_case!(sdk_host_timeout_is_bounded, "sdk-timeout");
    isolated_case!(sdk_host_cancellation_is_bounded, "sdk-cancel");
    isolated_case!(sdk_host_message_listener_is_bounded, "sdk-message");
    isolated_case!(sdk_bridge_cancellation_is_bounded, "sdk-bridge-cancel");
    isolated_case!(media_callbacks_are_bounded_without_a_frame, "media");
    isolated_case!(
        resize_callbacks_are_bounded_without_a_bridge_dispatch,
        "resize"
    );
    isolated_case!(
        window_resize_listener_timeout_stops_tail_promises_and_observers,
        "window-resize-listener"
    );
    isolated_case!(
        developer_logical_resize_timeout_preserves_consumed_effects_and_old_frame,
        "dev-logical-resize"
    );
    isolated_case!(
        network_callbacks_are_bounded_without_a_bridge_dispatch,
        "network"
    );
    isolated_case!(lifecycle_hooks_are_bounded, "lifecycle");
    isolated_case!(
        direct_browser_prepare_component_hooks_are_bounded,
        "dom-prepare"
    );
    isolated_case!(direct_browser_ack_ready_hooks_are_bounded, "dom-ack");
    isolated_case!(
        live_browser_ack_timeout_preserves_committed_identity_without_reexecution,
        "live-dom-ack"
    );
    isolated_case!(
        direct_browser_input_is_bounded_and_revokes_the_key,
        "dom-input"
    );
    isolated_case!(
        native_presentation_ack_ready_hooks_are_bounded,
        "native-ack"
    );
    isolated_case!(
        host_mutation_timeout_keeps_retirement_available_to_controls,
        "host-mutation"
    );
    isolated_case!(
        manifest_replacement_timeout_keeps_retirement_available_to_controls,
        "manifest-replacement"
    );
    isolated_case!(
        preview_retirement_timeout_emits_contact_retirement_once,
        "preview-retirement"
    );
    isolated_case!(
        ordinary_errors_and_admission_rejection_do_not_poison,
        "admission"
    );

    struct Pack {
        manifest: ContainerManifestV1,
        modules: Vec<Value>,
        blobs: BTreeMap<String, Vec<u8>>,
    }

    impl Pack {
        fn new(app: &str, page: &str) -> Self {
            let mut manifest = minimal_manifest();
            manifest.routes.push(Route {
                id: format!("route:{ROUTE}"),
                path: ROUTE.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "pages/home/index.js".into(),
            });
            for api in [
                "wx.timer",
                "wx.storage",
                "wx.setStorageSync",
                "wx.getStorageSync",
                "wx.onNetworkStatusChange",
                "wx.onError",
                "wx.offError",
                "wx.getNetworkType",
                "wx.createMediaQueryObserver",
                "getCurrentPages",
            ] {
                manifest
                    .capabilities
                    .insert(api.into(), CapabilitySupport::Partial);
            }
            let mut pack = Self {
                manifest,
                modules: Vec::new(),
                blobs: BTreeMap::new(),
            };
            pack.module(APP, app, ModuleScope::App);
            pack.module(PAGE, page, ModuleScope::Page);
            pack.template(ROUTE, WXML);
            pack
        }

        fn module(&mut self, id: &str, source: &str, scope: ModuleScope) {
            self.manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            self.modules.push(json!({"id":id,"source":source}));
        }

        fn template(&mut self, route: &str, source: &str) {
            let id = format!("template:{route}.wxml");
            self.manifest.templates.retain(|entry| entry.id != id);
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            self.manifest.templates.push(Template {
                id,
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            });
            self.blobs.insert(pointer, bytes);
        }

        fn build(mut self, turn_ms: Option<u64>, native_frame: bool) -> Fixture {
            self.manifest.refresh_integrity().unwrap();
            let session = Session::new(
                self.manifest,
                SessionConfig {
                    session_id: SESSION_ID.into(),
                    engine: EngineKind::Quickjs,
                    engine_execution: EngineExecutionPolicy {
                        turn_timeout_ms: turn_ms,
                        bootstrap_timeout_ms: Some(5_000),
                    },
                    renderer_override: Some(if native_frame {
                        RendererProfile::Skia
                    } else {
                        RendererProfile::WebView
                    }),
                    page_render_mode: if native_frame {
                        PageRenderMode::ExternalFrame
                    } else {
                        PageRenderMode::Raster
                    },
                    browser_view_enabled: true,
                    host: HostMetadata {
                        window_width: 375,
                        window_height: 667,
                        ..HostMetadata::default()
                    },
                    ..SessionConfig::default()
                },
            )
            .unwrap();
            Fixture {
                session,
                init: json!({"modules":self.modules,"blobs":self.blobs}),
                sequence: 0,
            }
        }
    }

    struct Fixture {
        session: Session,
        init: Value,
        sequence: u64,
    }

    impl Fixture {
        fn request(&mut self, operation: &str, payload: Value) -> BridgeEnvelope {
            self.sequence += 1;
            BridgeEnvelope::request(
                SESSION_ID,
                format!("budget-{}", self.sequence),
                operation,
                payload,
            )
        }

        fn success(&mut self, operation: &str, payload: Value) -> BridgeBatch {
            let request = self.request(operation, payload);
            let batch = self.session.dispatch(request.clone());
            let response = correlated(&batch, &request);
            assert_eq!(response.payload["ok"], true, "{batch:?}");
            assert!(
                batch
                    .messages
                    .iter()
                    .all(|message| message.payload["ok"] != false),
                "unexpected error in successful fixture setup: {batch:?}"
            );
            batch
        }

        fn initialize(&mut self) {
            self.success(op::APP_INIT, self.init.clone());
        }

        fn start(&mut self) {
            self.initialize();
            self.success(op::APP_LIFECYCLE, json!({"event":"launch"}));
            self.success(op::PAGE_PUSH, json!({"path":ROUTE}));
        }

        fn call_payload(export: &str) -> Value {
            json!({"moduleId":APP,"export":export,"args":[]})
        }

        fn arm(&mut self) {
            self.success(op::MODULE_CALL, Self::call_payload("arm"));
        }

        fn timeout(&mut self, request: BridgeEnvelope) {
            let batch = self.session.dispatch(request.clone());
            let response = correlated(&batch, &request);
            assert_eq!(response.payload["ok"], false, "{batch:?}");
            assert_eq!(
                response.payload["error"]["code"], "ERR_TIMEOUT",
                "{batch:?}"
            );
            assert_eq!(response.payload["requiresRestart"], true, "{batch:?}");
            assert_eq!(response.payload["error"]["request_id"], request.request_id);
            self.assert_fault_and_controls();
        }

        fn assert_fault_and_controls(&mut self) {
            assert_eq!(
                self.session.execution_fault().map(|error| error.code),
                Some(BridgeErrorCode::Timeout)
            );
            assert!(!self.session.is_current_frame_presented());
            assert!(!self.session.is_browser_view_presented());
            let request = self.request(op::MODULE_CALL, Self::call_payload("finite"));
            let batch = self.session.dispatch(request.clone());
            let response = correlated(&batch, &request);
            assert_eq!(response.payload["error"]["code"], "ERR_ENGINE", "{batch:?}");
            assert_eq!(response.payload["requiresRestart"], true, "{batch:?}");
            for (operation, payload) in [
                (op::CANCEL, json!({"cancelToken":"after-fault"})),
                (
                    op::DIAGNOSTIC,
                    json!({"message":"fault remains inspectable"}),
                ),
                (op::ERROR, json!({"message":"host cleanup"})),
            ] {
                self.success(operation, payload);
            }
            assert!(self.session.is_cancelled("after-fault"));
            assert!(self.session.execution_fault().is_some());
            fresh_session_recovers();
        }

        fn direct_timeout(&mut self, result: Result<BridgeBatch, BridgeError>) {
            match result {
                Err(error) => assert_eq!(error.code, BridgeErrorCode::Timeout, "{error:?}"),
                Ok(batch) => assert!(
                    batch
                        .messages
                        .iter()
                        .any(|message| message.payload["error"]["code"] == "ERR_TIMEOUT"),
                    "direct execution returned no timeout: {batch:?}"
                ),
            }
            self.assert_fault_and_controls();
        }

        fn render_payload() -> Value {
            json!({
                "templateId":format!("template:{ROUTE}.wxml"),
                "useSessionResources":true,
                "viewport":{"width":375,"height":667}
            })
        }

        fn present_dom(&mut self) -> BrowserViewSubmission {
            let submission = self
                .session
                .prepare_browser_view(&Self::render_payload(), 1)
                .unwrap();
            let permit = self
                .session
                .prepare_browser_commit(geometry(&submission))
                .unwrap();
            self.session
                .acknowledge_browser_presentation(&permit)
                .unwrap();
            assert!(self.session.is_browser_view_presented());
            submission
        }
    }

    fn correlated<'a>(batch: &'a BridgeBatch, request: &BridgeEnvelope) -> &'a BridgeEnvelope {
        let responses: Vec<_> = batch
            .messages
            .iter()
            .filter(|message| {
                message.kind == EnvelopeKind::Response
                    && message.request_id == request.request_id
                    && message.op == request.op
            })
            .collect();
        assert_eq!(
            responses.len(),
            1,
            "missing/duplicate correlated response: {batch:?}"
        );
        responses[0]
    }

    fn fresh_session_recovers() {
        let mut fresh = Pack::new(SAFE_APP, SAFE_PAGE).build(Some(TURN_MS), false);
        fresh.initialize();
        let batch = fresh.success(op::MODULE_CALL, Fixture::call_payload("finite"));
        assert_eq!(batch.messages[0].payload["result"], json!([42]));
        assert!(fresh.session.execution_fault().is_none());
    }

    fn future_ns(milliseconds: u64) -> u64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        u64::try_from(now + u128::from(milliseconds) * 1_000_000).unwrap()
    }

    fn geometry(submission: &BrowserViewSubmission) -> BrowserGeometryBatch {
        let mut nodes = Vec::new();
        let mut pending: Vec<_> = submission.document.nodes.iter().collect();
        while let Some(node) = pending.pop() {
            nodes.push(BrowserNodeGeometry {
                occurrence_id: node.occurrence_id().into(),
                border_box: ViewRect {
                    x: 0.0,
                    y: 0.0,
                    width: 100.0,
                    height: 30.0,
                },
                scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
                scroll_extent: ViewSize {
                    width: 100.0,
                    height: 30.0,
                },
                client_size: ViewSize {
                    width: 100.0,
                    height: 30.0,
                },
            });
            if let ViewNode::Element { children, .. } = node {
                pending.extend(children);
            }
        }
        BrowserGeometryBatch {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: submission.key.clone(),
            epoch: 0,
            viewport: submission.viewport,
            nodes,
        }
    }

    fn tap(submission: &BrowserViewSubmission) -> Value {
        let node = submission.document.nodes.iter().find(|node| {
            matches!(node, ViewNode::Element { attrs, .. } if attrs.get("id").is_some_and(|id| id == "target"))
        }).expect("fixture target");
        json!({
            "version":"1.0","key":submission.key,"epoch":"0",
            "events":[{"type":"tap","targetOccurrenceId":node.occurrence_id(),"detail":{}}]
        })
    }

    fn touch_start(submission: &BrowserViewSubmission) -> Value {
        let mut payload = tap(submission);
        let event = &mut payload["events"][0];
        let touches = json!([{
            "identifier":7,"x":2,"y":4,"clientX":2,"clientY":4,"pageX":2,"pageY":4
        }]);
        event["type"] = json!("touchstart");
        event["timeStamp"] = json!(25.5);
        event["changedTouches"] = touches.clone();
        event["touches"] = touches;
        payload
    }

    #[test]
    #[ignore = "invoked only by the owned subprocess watchdog"]
    fn budget_child() {
        let case = std::env::var(CHILD_CASE).expect("case set by parent watchdog");
        match case.as_str() {
            "dev-logical-resize" => {
                let source = r#"Page({data:{count:0},onResize(){
                    this.setData({count:this.data.count+1});
                    wx.setStorageSync('resize-once', this.data.count);
                    setTimeout(function(){wx.setStorageSync('after-fault', true)}, 1);
                    wx.getNetworkType({success(){for (;;) {}}});
                }});"#;
                let mut pack = Pack::new(SAFE_APP, source);
                // Exclude font discovery from the short callback deadline.
                pack.template(ROUTE, r#"<view style="width:20px;height:20px" />"#);
                let mut fixture = pack.build(Some(TURN_MS), true);
                fixture.start();
                fixture.success(op::RENDER_COMMIT, Fixture::render_payload());
                let revision = fixture.session.render_revision();
                let frame = fixture.session.renderer().last_frame().unwrap().frame_id;
                let viewport = Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 400.0,
                    height: 700.0,
                };
                let failure = match fixture.session.prepare_dev_logical_resize(viewport, 1.0) {
                    Ok(_) => panic!("unbounded resize callback accepted a candidate"),
                    Err(failure) => failure,
                };
                assert_eq!(failure.error.code, BridgeErrorCode::Timeout, "{failure:?}");
                assert_eq!(
                    failure
                        .effects
                        .messages
                        .iter()
                        .filter(|message| { message.payload["type"] == "host.resize" })
                        .count(),
                    1
                );
                assert!(
                    failure.effects.messages.iter().any(|message| {
                        message.payload["effects"]
                            .as_array()
                            .is_some_and(|batches| {
                                batches.iter().any(|batch| {
                                    batch["events"].as_array().is_some_and(|events| {
                                        events
                                            .iter()
                                            .any(|event| event["type"] == "storage.patch.batch")
                                    })
                                })
                            })
                    }),
                    "consumed storage trace lost after resize timeout: {:?}",
                    failure.effects
                );
                assert_eq!(
                    fixture.session.app_service().storage().get("resize-once"),
                    Some(&json!(1))
                );
                assert_eq!(
                    fixture
                        .session
                        .app_service()
                        .pages()
                        .current()
                        .unwrap()
                        .data["count"],
                    1
                );
                assert_eq!(fixture.session.render_revision(), revision);
                assert_eq!(
                    fixture.session.renderer().last_frame().unwrap().frame_id,
                    frame
                );
                assert_eq!(fixture.session.config().host.window_width, 375);
                assert_eq!(fixture.session.config().host.window_height, 667);
                assert!(fixture.session.execution_fault().is_some());
                let retry = match fixture.session.prepare_dev_logical_resize(viewport, 1.0) {
                    Ok(_) => panic!("faulted realm replayed resize work"),
                    Err(failure) => failure,
                };
                assert_eq!(retry.error.code, BridgeErrorCode::Engine);
                assert!(retry.effects.messages.is_empty());
                let _ = fixture.session.poll_timers(u64::MAX);
                assert_eq!(
                    fixture.session.app_service().storage().get("resize-once"),
                    Some(&json!(1))
                );
                assert!(fixture
                    .session
                    .app_service()
                    .storage()
                    .get("after-fault")
                    .is_none());
                fixture.assert_fault_and_controls();
            }
            "module-init" => {
                let mut fixture =
                    Pack::new("App({}); for (;;) {}", SAFE_PAGE).build(Some(TURN_MS), false);
                let request = fixture.request(op::APP_INIT, fixture.init.clone());
                fixture.timeout(request);
            }
            "module-load" => {
                let mut pack = Pack::new(SAFE_APP, SAFE_PAGE);
                pack.module("module:lazy.js", "for (;;) {}", ModuleScope::App);
                let mut fixture = pack.build(Some(TURN_MS), false);
                let lazy = fixture.init["modules"]
                    .as_array_mut()
                    .unwrap()
                    .pop()
                    .unwrap();
                fixture.initialize();
                let request = fixture.request(op::MODULE_LOAD, json!({"modules":[lazy]}));
                fixture.timeout(request);
            }
            "module-call" | "result-to-json" | "wx-on-error" | "error-descriptor"
            | "promise-chain" | "failure-effects" => {
                let source = match case.as_str() {
                    "module-call" => "App({}); exports.attack = function() { for (;;) {} };",
                    "result-to-json" => "App({}); exports.attack = function() { return {toJSON(){for (;;) {}}}; };",
                    "wx-on-error" => "App({}); wx.onError(function(){for (;;) {}}); exports.attack = function() { throw Error('fixture'); };",
                    // Plain accessors are deliberately not read by the error hub. A
                    // Proxy descriptor trap still executes inside the native budget.
                    "error-descriptor" => "App({}); exports.attack = function() { throw new Proxy({}, {getOwnPropertyDescriptor(){for (;;) {}}}); };",
                    "failure-effects" => "App({}); exports.attack = function() { Promise.resolve().then(function(){for (;;) {}}); throw Error('failure before pending cleanup'); };",
                    _ => "App({}); exports.attack = function() { function again(){Promise.resolve().then(again)} again(); return 'scheduled'; };",
                };
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                fixture.timeout(request);
            }
            "error-prototype" | "api-callback-error-getter" => {
                let source = match case.as_str() {
                    // Return no own fields so safe normalization reaches the
                    // new prototype lookup rather than a descriptor trap.
                    "error-prototype" => "App({}); exports.attack = function() { throw new Proxy({}, {getOwnPropertyDescriptor(){return undefined;},getPrototypeOf(){for (;;) {}}}); };",
                    // Ordinary report skips accessors; only the production API
                    // callback compatibility entry may read this getter.
                    _ => "App({}); exports.attack = function() { __container_invoke_api_callback({success:function(){throw {get message(){for (;;) {}}};}}, 'success', {}); };",
                };
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                fixture.timeout(request);
            }
            "dispatch-batch" => {
                let source = "App({}); exports.burn = function() { const until=Date.now()+100; while(Date.now()<until){}; return true; };";
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                let requests: Vec<_> = (0..4)
                    .map(|_| fixture.request(op::MODULE_CALL, Fixture::call_payload("burn")))
                    .collect();
                let batch = fixture
                    .session
                    .dispatch_batch(BridgeBatch::new(requests.clone()));
                assert_eq!(
                    correlated(&batch, &requests[0]).payload["ok"],
                    true,
                    "a later timeout discarded an already completed envelope: {batch:?}"
                );
                assert!(
                    requests.iter().any(|request| {
                        correlated(&batch, request).payload["error"]["code"] == "ERR_TIMEOUT"
                    }),
                    "a batch received a fresh budget for every envelope: {batch:?}"
                );
                fixture.assert_fault_and_controls();
            }
            "consumed-effects" => {
                let source = "App({}); exports.attack = function() { wx.setStorageSync('before-timeout',{committed:true}); wx.getNetworkType({success(){for (;;) {}}}); return true; };";
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                let batch = fixture.session.dispatch(request.clone());
                assert_eq!(
                    correlated(&batch, &request).payload["error"]["code"],
                    "ERR_TIMEOUT",
                    "{batch:?}"
                );
                assert_eq!(
                    fixture
                        .session
                        .app_service()
                        .storage()
                        .get("before-timeout"),
                    Some(&json!({"committed":true})),
                    "storage already consumed by Rust must remain committed"
                );
                assert!(
                    batch.messages.iter().any(|message| {
                        message.payload["effects"]
                            .as_array()
                            .is_some_and(|batches| {
                                batches.iter().any(|batch| {
                                    batch["events"].as_array().is_some_and(|events| {
                                        events
                                            .iter()
                                            .any(|event| event["type"] == "storage.patch.batch")
                                    })
                                })
                            })
                    }),
                    "a later API callback timeout discarded consumed effect evidence: {batch:?}"
                );
                fixture.assert_fault_and_controls();
            }
            "request-deadline" => {
                let mut fixture = Pack::new(
                    "App({}); exports.attack = function() { const until=Date.now()+1500; while(Date.now()<until){}; return true; };",
                    SAFE_PAGE,
                ).build(Some(3_000), false);
                fixture.initialize();
                let mut request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                request.deadline_ns = Some(future_ns(500));
                fixture.timeout(request);
            }
            "storage-sync" => {
                // Host repair no longer calls application-writable globals.
                // A poisoned legacy setter must not run, while application
                // execution after the trusted install keeps the same budget.
                let source = r#"
                    App({});
                    globalThis.syncPoisonCalls = 0;
                    exports.arm = function() {
                        globalThis.__container_set_storage_snapshot = function() {
                            syncPoisonCalls++;
                            for (;;) {}
                        };
                        return true;
                    };
                    exports.finite = function() {
                        return {stored: wx.getStorageSync('host-write'), poisonCalls: syncPoisonCalls};
                    };
                    exports.attack = function() { for (;;) {} };
                "#;
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                fixture.arm();
                fixture
                    .session
                    .app_service_mut()
                    .set_storage("host-write", json!(1))
                    .unwrap();
                let batch = fixture.success(op::MODULE_CALL, Fixture::call_payload("finite"));
                assert_eq!(
                    batch.messages[0].payload["result"],
                    json!([{
                        "stored": 1, "poisonCalls": 0,
                    }])
                );
                assert!(fixture.session.execution_fault().is_none());
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                fixture.timeout(request);
            }
            "capability-sync" => {
                // The trusted installer retains its own intrinsics instead
                // of invoking a replacement Object.assign during host sync.
                let source = r#"
                    App({});
                    globalThis.syncPoisonCalls = 0;
                    exports.arm = function() {
                        Object.assign = function() {
                            syncPoisonCalls++;
                            for (;;) {}
                        };
                        return true;
                    };
                    exports.finite = function() {
                        return {supported: wx.canIUse('setStorageSync'),
                            unsupported: wx.canIUse('notAnApi'), poisonCalls: syncPoisonCalls};
                    };
                    exports.attack = function() { for (;;) {} };
                "#;
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                fixture.arm();
                // Launch actually refreshes the capability mirror after the
                // intrinsic was poisoned; MODULE_CALL alone need not do so.
                fixture.success(op::APP_LIFECYCLE, json!({"event":"launch"}));
                let batch = fixture.success(op::MODULE_CALL, Fixture::call_payload("finite"));
                assert_eq!(
                    batch.messages[0].payload["result"],
                    json!([{
                        "supported": true, "unsupported": false, "poisonCalls": 0,
                    }])
                );
                assert!(fixture.session.execution_fault().is_none());
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                fixture.timeout(request);
            }
            "sdk-complete" | "sdk-timeout" | "sdk-cancel" | "sdk-message" | "sdk-bridge-cancel" => {
                let source = "App({}); exports.arm=function(){weappContainer.invoke('echo',{}, {timeout:1000,cancelToken:'sdk-owned'}).then(function(){for(;;){}},function(){for(;;){}}); return true;}; exports.listen=function(){weappContainer.onMessage(function(){for(;;){}});return true;};";
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture
                    .session
                    .set_host_methods(vec!["echo".into()])
                    .unwrap();
                fixture.start();
                let result = if case == "sdk-message" {
                    fixture.success(op::MODULE_CALL, Fixture::call_payload("listen"));
                    fixture
                        .session
                        .send_host_message(json!({"message":"bounded"}))
                } else {
                    fixture.arm();
                    let id = fixture
                        .session
                        .take_host_requests()
                        .into_iter()
                        .find_map(|request| match request {
                            container_runtime::HostRequest::Call { call_id, .. } => Some(call_id),
                            _ => None,
                        })
                        .expect("pending SDK call");
                    match case.as_str() {
                        "sdk-complete" => fixture.session.complete_host_call(&id, Ok(json!(42))),
                        "sdk-timeout" => fixture.session.poll_host_timeouts(u64::MAX),
                        "sdk-bridge-cancel" => {
                            let request =
                                fixture.request(op::CANCEL, json!({"cancelToken":"sdk-owned"}));
                            Ok(fixture.session.dispatch(request))
                        }
                        _ => fixture.session.cancel_host_calls(),
                    }
                };
                fixture.direct_timeout(result);
                // Cleanup after an interrupted listener must not re-enter JS.
                fixture.session.cancel_host_calls().unwrap();
                assert_eq!(fixture.session.pending_host_call_count(), 0);
            }
            "timer" | "media" => {
                let source = if case == "timer" {
                    "App({}); exports.arm = function() { setTimeout(function(){for (;;) {}},0); return true; };"
                } else {
                    "App({}); exports.arm = function() { wx.createMediaQueryObserver().observe({minWidth:1},function(){for (;;) {}}); return true; };"
                };
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.start();
                fixture.arm();
                assert!(fixture.session.view_document().is_none());
                if case == "timer" {
                    fixture.session.app_service_mut().schedule_timer(
                        container_core::TimerKind::Timeout,
                        0,
                        1,
                        Some("rust-consumed-timer".into()),
                    );
                }
                let batch = fixture.session.poll_timers(future_ns(1_000));
                if case == "timer" {
                    assert!(
                        batch.messages.iter().any(|message| message.payload["type"] == "timer"),
                        "Rust timer notifications were discarded by the JS callback timeout: {batch:?}"
                    );
                }
                fixture.direct_timeout(Ok(batch));
            }
            "resize" => {
                let mut fixture = Pack::new(SAFE_APP, "Page({onResize(){for (;;) {}}});")
                    .build(Some(TURN_MS), false);
                fixture.start();
                let batch = fixture
                    .session
                    .notify_viewport_resize(400, 700)
                    .expect("committed resize must retain its Rust event and timeout diagnostic");
                assert_eq!(fixture.session.config().host.window_width, 400);
                assert_eq!(fixture.session.config().host.window_height, 700);
                assert!(
                    batch
                        .messages
                        .iter()
                        .any(|message| message.payload["type"] == "host.resize"),
                    "committed host resize lost its event after onResize timed out: {batch:?}"
                );
                fixture.direct_timeout(Ok(batch));
            }
            "window-resize-listener" => {
                let source = r#"
                    App({});
                    exports.arm = function() {
                        wx.onWindowResize(function() {
                            Promise.resolve().then(function() { wx.setStorageSync('window-promise', true); });
                            for (;;) {}
                        });
                        wx.onWindowResize(function() { wx.setStorageSync('window-tail', true); });
                        wx.createMediaQueryObserver().observe({minWidth:400}, function(result) {
                            if (result.matches) wx.setStorageSync('window-observer', true);
                        });
                        return true;
                    };
                "#;
                let mut pack = Pack::new(source, SAFE_PAGE);
                pack.manifest
                    .capabilities
                    .insert("wx.onWindowResize".into(), CapabilitySupport::Partial);
                let mut fixture = pack.build(Some(TURN_MS), true);
                fixture.start();
                fixture.arm();
                let batch = fixture
                    .session
                    .notify_viewport_resize(400, 700)
                    .expect("committed resize retains its Rust event and timeout diagnostic");
                assert_eq!(fixture.session.config().host.window_width, 400);
                assert_eq!(fixture.session.config().host.window_height, 700);
                assert!(
                    batch
                        .messages
                        .iter()
                        .any(|message| message.payload["type"] == "host.resize"),
                    "committed window resize lost its event: {batch:?}"
                );
                fixture.direct_timeout(Ok(batch));
                let _ = fixture.session.poll_timers(u64::MAX);
                for key in ["window-tail", "window-promise", "window-observer"] {
                    assert!(
                        fixture.session.app_service().storage().get(key).is_none(),
                        "{key} continued after the window listener timeout"
                    );
                }
                assert!(fixture.session.execution_fault().is_some());
            }
            "network" => {
                let source = "App({}); exports.arm = function() { wx.onNetworkStatusChange(function(){for (;;) {}}); return true; };";
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.start();
                fixture.arm();
                let result = fixture
                    .session
                    .notify_network_status_change(NetworkType::FourG);
                fixture.direct_timeout(result);
            }
            "lifecycle" => {
                let mut fixture = Pack::new(SAFE_APP, "Page({onShow(){for (;;) {}}});")
                    .build(Some(TURN_MS), false);
                fixture.initialize();
                fixture.success(op::APP_LIFECYCLE, json!({"event":"launch"}));
                let request = fixture.request(op::PAGE_PUSH, json!({"path":ROUTE}));
                fixture.timeout(request);
            }
            "dom-prepare" => {
                let mut pack = Pack::new(
                    "App({}); exports.arm=function(){getCurrentPages()[0].setData({show:true}); return true;};",
                    SAFE_PAGE,
                );
                pack.template(ROUTE, "<panel wx:if=\"{{show}}\"/>");
                pack.template("components/panel/index", "<view/>");
                pack.module(
                    "module:components/panel/index.js",
                    "Component({lifetimes:{attached(){for (;;) {}}}});",
                    ModuleScope::Component,
                );
                pack.manifest.components.push(Component {
                    id: format!("components:{ROUTE}.json"),
                    owner: format!("{ROUTE}.json"),
                    using_components: BTreeMap::from([(
                        "panel".into(),
                        "components/panel/index".into(),
                    )]),
                    multiple_slots: None,
                });
                let mut fixture = pack.build(Some(TURN_MS), false);
                fixture.start();
                fixture.arm();
                let result = fixture
                    .session
                    .prepare_browser_view(&Fixture::render_payload(), 1);
                let error =
                    result.expect_err("component attached must time out during direct prepare");
                assert_eq!(error.code, BridgeErrorCode::Timeout, "{error:?}");
                fixture.assert_fault_and_controls();
            }
            "dom-ack" => {
                let mut fixture = Pack::new(SAFE_APP, "Page({onReady(){for (;;) {}}});")
                    .build(Some(TURN_MS), false);
                fixture.start();
                let submission = fixture
                    .session
                    .prepare_browser_view(&Fixture::render_payload(), 1)
                    .unwrap();
                let permit = fixture
                    .session
                    .prepare_browser_commit(geometry(&submission))
                    .unwrap();
                let batch = fixture
                    .session
                    .acknowledge_browser_presentation(&permit)
                    .expect("browser ACK must retain committed ready diagnostics");
                assert!(
                    batch.messages.iter().any(|message| {
                        message.payload["committed"] == true && message.payload["phase"] == "ready"
                    }),
                    "browser ACK lost its committed ready diagnostic: {batch:?}"
                );
                fixture.direct_timeout(Ok(batch));
                assert!(!fixture.session.is_browser_view_pending(&submission.key));
            }
            "live-dom-ack" => {
                let mut fixture = Pack::new(SAFE_APP, "Page({onReady(){for (;;) {}}});")
                    .build(Some(TURN_MS), false);
                fixture.start();
                fixture.success(op::VIEW_LIVE_ENABLE, json!({"version":"2.0"}));
                let lifetime = fixture
                    .session
                    .input_lifetime_revision()
                    .unwrap()
                    .to_string();
                let prepared = fixture.success(
                    op::VIEW_LIVE_PREPARE,
                    json!({
                        "version":"2.0",
                        "inputLifetimeRevision":lifetime,
                        "surfaceGeneration":"1",
                        "render":Fixture::render_payload()
                    }),
                );
                let submission: BrowserLiveViewSubmission =
                    serde_json::from_value(prepared.messages[0].payload["submission"].clone())
                        .unwrap();
                let permitted = fixture.success(
                    op::VIEW_LIVE_PERMIT,
                    json!({
                        "version":"2.0",
                        "inputLifetimeRevision":lifetime,
                        "key":submission.key,
                        "baseKey":submission.base_key,
                        "documentToken":submission.document_token
                    }),
                );
                let live_geometry = geometry(&BrowserViewSubmission {
                    version: VIEW_PRESENTATION_VERSION.into(),
                    key: submission.key.clone(),
                    viewport: submission.viewport,
                    document: submission.document.clone(),
                    animation: None,
                });
                let request = fixture.request(
                    op::VIEW_LIVE_PRESENTED,
                    json!({
                        "version":"2.0",
                        "inputLifetimeRevision":lifetime,
                        "permit":permitted.messages[0].payload["permit"],
                        "geometry":live_geometry
                    }),
                );
                let batch = fixture.session.dispatch(request.clone());
                let response = correlated(&batch, &request);
                assert_eq!(response.payload["ok"], false, "{batch:?}");
                assert_eq!(
                    response.payload["error"]["code"], "ERR_TIMEOUT",
                    "{batch:?}"
                );
                assert_eq!(response.payload["committed"], true, "{batch:?}");
                assert_eq!(response.payload["key"], json!(submission.key), "{batch:?}");
                assert_eq!(response.payload["inputEnabled"], false, "{batch:?}");
                assert_eq!(response.payload["requiresRestart"], true, "{batch:?}");
                assert_eq!(fixture.session.view_document(), Some(&submission.document));
                assert!(!fixture.session.is_browser_view_pending(&submission.key));
                assert!(!fixture.session.is_browser_view_presented());

                // Same-epoch exact replay uses the complete final cache. This
                // timeout instead retires the hard epoch, so the identical old
                // ACK must be rejected without entering ready again or restoring
                // input, even though its document was already published.
                let retired_lifetime = fixture.session.input_lifetime_revision();
                assert_ne!(retired_lifetime.map(|n| n.to_string()), Some(lifetime));
                let page = fixture.session.app_service().pages().current().cloned();
                let storage = fixture.session.app_service().storage().snapshot();
                let storage_revision = fixture.session.app_service().storage().revision();
                let retry = fixture.session.dispatch(request.clone());
                let rejected = correlated(&retry, &request);
                assert_eq!(
                    rejected.payload["error"]["code"], "ERR_CANCELLED",
                    "{retry:?}"
                );
                assert_eq!(rejected.payload["requiresRestart"], true, "{retry:?}");
                assert_eq!(
                    retry.messages.len(),
                    1,
                    "retired ACK reran effects: {retry:?}"
                );
                assert_eq!(fixture.session.input_lifetime_revision(), retired_lifetime);
                assert_eq!(
                    fixture.session.app_service().pages().current(),
                    page.as_ref()
                );
                assert_eq!(fixture.session.app_service().storage().snapshot(), storage);
                assert_eq!(
                    fixture.session.app_service().storage().revision(),
                    storage_revision
                );
                assert_eq!(fixture.session.view_document(), Some(&submission.document));
                assert!(!fixture.session.is_browser_view_pending(&submission.key));
                assert!(!fixture.session.is_browser_view_presented());
                fixture.assert_fault_and_controls();
            }
            "dom-input" => {
                let mut fixture =
                    Pack::new(SAFE_APP, "Page({tap(){for (;;) {}}});").build(Some(TURN_MS), false);
                fixture.start();
                let submission = fixture.present_dom();
                let result = fixture.session.dispatch_browser_events(tap(&submission));
                fixture.direct_timeout(result);
                assert!(fixture
                    .session
                    .browser_page_input(&submission.key)
                    .is_none());
                let error = fixture
                    .session
                    .dispatch_browser_events(tap(&submission))
                    .unwrap_err();
                assert_eq!(error.code, BridgeErrorCode::Engine, "{error:?}");
            }
            "native-ack" => {
                // This case measures the ready hook reached through a real
                // external-frame ACK. Native text layout can synchronously
                // discover system fonts before that boundary, so use a
                // rectangle without text to isolate the operation under test.
                let mut pack = Pack::new(SAFE_APP, "Page({onReady(){for (;;) {}}});");
                pack.template(
                    ROUTE,
                    r#"<view id="target" style="width:20px;height:20px" />"#,
                );
                eprintln!("native-ack: preparing rectangle-only external frame");
                let mut fixture = pack.build(Some(TURN_MS), true);
                fixture.start();
                fixture.success(op::RENDER_COMMIT, Fixture::render_payload());
                assert!(!fixture.session.is_current_frame_presented());
                let revision = fixture.session.renderer().snapshot_revision();
                eprintln!("native-ack: frame accepted, entering ready-hook ACK");
                let batch = fixture
                    .session
                    .acknowledge_presentation(revision)
                    .expect("native ACK must retain committed ready diagnostics");
                assert!(
                    batch.messages.iter().any(|message| {
                        message.payload["committed"] == true && message.payload["phase"] == "ready"
                    }),
                    "native ACK lost its committed ready diagnostic: {batch:?}"
                );
                fixture.direct_timeout(Ok(batch));
            }
            "host-mutation" | "manifest-replacement" | "preview-retirement" => {
                let mut fixture = Pack::new(SAFE_APP, "Page({touch(){},cancel(){for (;;) {}}});")
                    .build(Some(TURN_MS), false);
                fixture.start();
                let submission = fixture.present_dom();
                let down = fixture
                    .session
                    .dispatch_browser_events(touch_start(&submission))
                    .expect("safe touchstart must capture a contact before retirement");
                assert!(
                    down.messages.iter().any(|message| {
                        message.op == "view.events.consumed" && message.payload["events"] == 1
                    }),
                    "the fixture never consumed touchstart: {down:?}"
                );
                assert!(
                    down.messages
                        .iter()
                        .all(|message| message.payload["ok"] != false),
                    "{down:?}"
                );

                let mut retirement_messages = Vec::new();
                match case.as_str() {
                    "host-mutation" => {
                        // This legacy API cannot return a batch. Its contact
                        // cancellation still owns a bounded JS turn, and the
                        // consumed trace must be readable through controls.
                        let _ = fixture.session.app_service_mut();
                    }
                    "manifest-replacement" => {
                        let original = fixture.session.manifest().clone();
                        let mut replacement = original.clone();
                        let bytes = parse_wxml("<view>replacement</view>")
                            .unwrap()
                            .canonical_json()
                            .unwrap();
                        replacement.templates[0].wxml_ast =
                            format!("sha256:{}", hex_digest(&bytes));
                        replacement.refresh_integrity().unwrap();
                        assert!(original.can_replace_presentation_with(&replacement));
                        match fixture.session.replace_manifest(replacement) {
                            Err(SessionError::EngineExecution(error)) => {
                                assert_eq!(error.code, BridgeErrorCode::Timeout, "{error:?}");
                            }
                            result => panic!("contact cancellation did not interrupt manifest replacement: {result:?}"),
                        }
                        assert_eq!(
                            fixture.session.manifest(),
                            &original,
                            "failed contact retirement must not publish replacement metadata"
                        );
                    }
                    "preview-retirement" => {
                        let batch = fixture
                            .session
                            .retire_browser_preview("budget-fixture-retire")
                            .expect("preview retirement must preserve its consumed trace");
                        assert!(
                            batch.messages.iter().any(|message| {
                                message.payload["error"]["code"] == "ERR_TIMEOUT"
                            }),
                            "retirement did not reach the infinite touchcancel callback: {batch:?}"
                        );
                        retirement_messages.extend(batch.messages);
                    }
                    _ => unreachable!(),
                }
                assert_eq!(
                    fixture.session.execution_fault().map(|error| error.code),
                    Some(BridgeErrorCode::Timeout)
                );
                assert!(!fixture.session.is_browser_view_presented());
                assert!(fixture
                    .session
                    .browser_page_input(&submission.key)
                    .is_none());

                let request = fixture.request(
                    op::DIAGNOSTIC,
                    json!({"message":"inspect retired contacts"}),
                );
                let diagnostic = fixture.session.dispatch(request.clone());
                assert_eq!(
                    correlated(&diagnostic, &request).payload["ok"],
                    true,
                    "{diagnostic:?}"
                );
                retirement_messages.extend(diagnostic.messages);
                let retired: Vec<_> = retirement_messages
                    .iter()
                    .filter(|message| message.op == "view.contacts.retired")
                    .collect();
                assert_eq!(retired.len(), 1,
                    "consumed contact retirement must have exactly one delivery: {retirement_messages:?}");
                assert_eq!(retired[0].payload["identifiers"], json!([7]));
                assert_eq!(retired[0].payload["delivered"], false);
                assert!(
                    retirement_messages
                        .iter()
                        .any(|message| { message.payload["error"]["code"] == "ERR_TIMEOUT" }),
                    "contact cancellation timeout lost its diagnostic: {retirement_messages:?}"
                );

                let request = fixture.request(
                    op::DIAGNOSTIC,
                    json!({"message":"verify retirement drained"}),
                );
                let next = fixture.session.dispatch(request.clone());
                assert_eq!(correlated(&next, &request).payload["ok"], true, "{next:?}");
                assert!(
                    next.messages
                        .iter()
                        .all(|message| message.op != "view.contacts.retired"),
                    "control polling replayed a consumed contact retirement: {next:?}"
                );
                fixture.assert_fault_and_controls();
            }
            "admission" => {
                let source = "App({}); exports.finite=function(){return 42}; exports.fail=function(){throw Error('ordinary')}; exports.attack=function(){for (;;) {}};";
                let mut fixture = Pack::new(source, SAFE_PAGE).build(Some(TURN_MS), false);
                fixture.initialize();
                let request = fixture.request(op::MODULE_CALL, Fixture::call_payload("fail"));
                let batch = fixture.session.dispatch(request.clone());
                assert_eq!(correlated(&batch, &request).payload["ok"], false);
                assert!(fixture.session.execution_fault().is_none());
                fixture.success(op::MODULE_CALL, Fixture::call_payload("finite"));
                fixture.success(op::CANCEL, json!({"cancelToken":"before-turn"}));
                let mut cancelled =
                    fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                cancelled.cancel_token = Some("before-turn".into());
                let batch = fixture.session.dispatch(cancelled.clone());
                assert_eq!(
                    correlated(&batch, &cancelled).payload["error"]["code"],
                    "ERR_CANCELLED"
                );
                assert!(fixture.session.execution_fault().is_none());
                let mut expired = fixture.request(op::MODULE_CALL, Fixture::call_payload("attack"));
                expired.deadline_ns = Some(1);
                let batch = fixture.session.dispatch(expired.clone());
                assert_eq!(
                    correlated(&batch, &expired).payload["error"]["code"],
                    "ERR_TIMEOUT"
                );
                assert!(fixture.session.execution_fault().is_none());
                fixture.success(op::MODULE_CALL, Fixture::call_payload("finite"));
            }
            _ => panic!("unknown runtime budget child case: {case}"),
        }
    }
}
