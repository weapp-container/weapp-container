//! Navigation completion must cross the actual Session/engine result boundary.
//! These local fixtures establish callback/Promise ownership, not DevTools parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, CompilerInfo, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind,
};
use container_runtime::{HostApiProvider, ProviderContext, ProviderError, Session, SessionConfig};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};

const HOME: &str = "pages/home/index";
const DETAIL: &str = "pages/detail/index";
const SECOND: &str = "pages/second/index";
const TAB: &str = "pages/tab/index";
const APP_MODULE: &str = "module:app.js";
const NAV_APIS: [&str; 7] = [
    "wx.navigateTo",
    "wx.redirectTo",
    "wx.navigateBack",
    "wx.reLaunch",
    "wx.switchTab",
    "wx.preloadPage",
    "wx.setNavigationBarTitle",
];

const APP_JS: &str = r#"
App({ trace: [] });
function record(phase, label, value, same) {
  getApp().trace.push({ phase, label, value, same,
    routes: getCurrentPages().map(function(page) { return page.route; }) });
}
function invoke(method, options, label, next) {
  let callbackValue;
  function advance(phase) {
    if (next && (next.when || 'success') === phase)
      invoke(next.method, next.options, next.label, next.next);
  }
  const request = Object.assign({}, options, {
    success(value) {
      callbackValue = value;
      const pages = getCurrentPages();
      if (pages.length) pages[pages.length - 1].setData({ completion: label });
      record('success', label, value);
      advance('success');
    },
    fail(value) { callbackValue = value; record('fail', label, value); },
    complete(value) { record('complete', label, value, value === callbackValue); }
  });
  const result = wx[method](request);
  record('returned', label, null);
  result.then(function(value) { record('resolved', label, value, value === callbackValue); advance('resolved'); },
    function(value) { record('rejected', label, value, value === callbackValue); });
}
exports.invoke = invoke;
exports.sameTurn = function(first, second) {
  invoke(first.method, first.options, first.label);
  invoke(second.method, second.options, second.label);
};
exports.abortSharedNavigation = function(url, cancelToken) {
  const task = wx.request({url:'https://navigation-fixture.invalid/', cancelToken:cancelToken});
  task.catch(function() {});
  invoke('navigateTo', {url:url, cancelToken:cancelToken}, 'shared-abort');
  task.abort();
};
exports.startBudget = function(total, route) {
  getApp().budget = { total:total, completed:0 };
  function step() {
    const ordinal = getApp().budget.completed + 1;
    return wx.redirectTo({url:route + '?step=' + ordinal}).then(function() {
      getApp().budget.completed++;
      if (getApp().budget.completed < total) return step();
    });
  }
  step().catch(function(error) { record('budget-failed', 'budget', error); });
};
exports.startChannel = function(tag, spoof) {
  const app=getApp();
  app.eventChannelMode=true;
  if(!app.channelTrace){app.channelTrace=[];app.channels=[];app.channelTargets=[];}
  if(spoof) globalThis.__container_bind_event_channel=function(){throw new Error('guest replaced binder');};
  let callbackChannel;
  wx.navigateTo({url:'/pages/detail/index?tag='+tag,
    events:{ready:function(value){app.channelTrace.push('ready:'+value);}},
    success:function(result){
      app.channelTrace.push('success:'+tag);callbackChannel=result.eventChannel;
      app.channels.push(callbackChannel);
      callbackChannel.on('early',function(value){app.channelTrace.push('early:'+value);});
      callbackChannel.on('closing',function(value){app.channelTrace.push('closing:'+value);});
      callbackChannel.emit('answer',tag);
    },
    fail:function(error){app.channelTrace.push('fail:'+error.code);},
    complete:function(){app.channelTrace.push('complete:'+tag);}
  }).then(function(result){app.channelTrace.push('promise:'+tag+':'+(result.eventChannel===callbackChannel));},function(){});
};
exports.inspectChannels = function(){
  const app=getApp();
  return {trace:app.channelTrace.slice(),states:app.channels.map(function(channel){
    try{channel.emit('probe');return 'live';}catch(error){return error.code;}
  }),same:app.channels.map(function(channel,index){return channel===app.channelTargets[index];})};
};
exports.clear = function() { getApp().trace = []; };
exports.inspect = function() { return { trace: getApp().trace,
  pages: getCurrentPages().map(function(page) { return { route: page.route, data: page.data }; }),
  canNavigate: wx.canIUse('navigateTo'), budget: getApp().budget || null }; };
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

#[derive(Clone, Default)]
struct TitleProvider {
    calls: Arc<Mutex<Vec<Value>>>,
    cancelled_tokens: Arc<Mutex<Vec<String>>>,
}

impl HostApiProvider for TitleProvider {
    fn name(&self) -> &'static str {
        "navigation-completion-fixture"
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if name == "wx.request" {
            let token = context
                .cancel_token
                .as_ref()
                .expect("request cancellation token");
            assert!(self.cancelled_tokens.lock().unwrap().contains(token));
            return Err(ProviderError::cancelled("network fixture request aborted"));
        }
        assert_eq!(name, "wx.setNavigationBarTitle");
        self.calls.lock().unwrap().push(json!({
            "title": payload["title"],
            "deadlineNs": context.deadline_ns,
            "cancelToken": context.cancel_token,
            "cancelled": context.cancelled,
        }));
        if payload["title"] == "denied" {
            return Err(ProviderError::permission("navigation-title"));
        }
        Ok(json!({"errMsg":"setNavigationBarTitle:ok"}))
    }

    fn cancel(&mut self, token: &str) -> bool {
        self.cancelled_tokens.lock().unwrap().push(token.to_owned());
        true
    }
}

struct Fixture {
    session: Session,
    provider: TitleProvider,
    sequence: u64,
}

impl Fixture {
    fn start(engine: EngineKind, disabled: Option<&str>) -> Self {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "navigation-completion-fixture".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        for name in NAV_APIS
            .into_iter()
            .chain(["getCurrentPages", "wx.request"])
        {
            manifest.capabilities.insert(
                name.into(),
                if Some(name) == disabled {
                    CapabilitySupport::Unsupported
                } else {
                    CapabilitySupport::Partial
                },
            );
        }
        let mut modules = vec![(APP_MODULE.to_owned(), APP_JS.to_owned(), ModuleScope::App)];
        for (path, kind) in [
            (HOME, RouteKind::Page),
            (DETAIL, RouteKind::Page),
            (SECOND, RouteKind::Page),
            (TAB, RouteKind::Tab),
        ] {
            let file = format!("{path}.js");
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind,
                config: None,
                entry_module: file.clone(),
            });
            let label = serde_json::to_string(path).unwrap();
            let source = format!(
                r#"Page({{
                    data: {{ completion: '' }},
                    onLoad(query) {{
                      const app=getApp();app.trace.push({{phase:'load',label:{label},query}});
                      if(app.eventChannelMode){{
                        const channel=this.getOpenerEventChannel();
                        if(typeof channel.emit==='function'){{
                          app.channelTargets.push(channel);app.channelTrace.push('load:'+query.tag);
                          channel.emit('ready',query.tag);channel.emit('early',query.tag);
                          channel.on('answer',function(value){{app.channelTrace.push('answer:'+value);}});
                        }}else app.channelTrace.push('empty-load:'+(query.tag||'root'));
                      }}
                    }},
                    onShow() {{ getApp().trace.push({{phase:'show',label:{label}}}); }},
                    onHide() {{ getApp().trace.push({{phase:'hide',label:{label}}}); }},
                    onUnload() {{
                      const app=getApp();app.trace.push({{phase:'unload',label:{label}}});
                      if(app.eventChannelMode){{const channel=this.getOpenerEventChannel();if(typeof channel.emit==='function')channel.emit('closing',this.options.tag);}}
                    }}
                }});"#
            );
            modules.push((format!("module:{file}"), source, ModuleScope::Page));
        }
        for (id, source, scope) in &modules {
            manifest.modules.push(Module {
                id: id.clone(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: *scope,
                dependencies: Vec::new(),
            });
        }
        manifest.refresh_integrity().unwrap();
        let provider = TitleProvider::default();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..SessionConfig::default()
            },
        )
        .unwrap();
        session.set_provider(Box::new(provider.clone()));
        let mut fixture = Self {
            session,
            provider,
            sequence: 0,
        };
        fixture.dispatch(
            op::APP_INIT,
            json!({"modules":modules.iter().map(|(id,source,_)| json!({"id":id,"source":source})).collect::<Vec<_>>()}),
        );
        fixture.dispatch(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.dispatch(op::PAGE_PUSH, json!({"path":HOME}));
        fixture.call("clear", json!([]));
        fixture
    }

    fn dispatch_raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("navigation-completion-{}", self.sequence),
            operation,
            payload,
        ))
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        let batch = self.dispatch_raw(operation, payload);
        assert_eq!(
            batch.messages[0].payload["ok"], true,
            "{operation}: {:?}",
            batch.messages
        );
        assert!(
            !batch.messages.iter().any(|message| message.op == op::ERROR),
            "API failures must settle their JS operation, not escape the enclosing bridge batch: {:?}",
            batch.messages
        );
        batch
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":export,"args":args}),
        )
        .messages[0]
            .payload["result"][0]
            .clone()
    }

    fn invoke(&mut self, method: &str, options: Value, label: &str) {
        self.call("invoke", json!([method, options, label]));
    }

    fn inspect(&mut self) -> Value {
        self.call("inspect", json!([]))
    }

    fn routes(&self) -> Vec<String> {
        self.session
            .app_service()
            .pages()
            .iter()
            .map(|page| page.path.clone())
            .collect()
    }
}

fn assert_completion(state: &Value, label: &str, api: &str, routes: &[&str], error: Option<&str>) {
    let records = state["trace"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|entry| entry["label"] == label)
        .collect::<Vec<_>>();
    let phases = records
        .iter()
        .map(|entry| entry["phase"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        phases,
        if error.is_some() {
            vec!["returned", "fail", "complete", "rejected"]
        } else {
            vec!["returned", "success", "complete", "resolved"]
        },
        "{label}: {state}"
    );
    for record in &records[1..] {
        assert_eq!(record["routes"], json!(routes), "{label}: {record}");
        if let Some(code) = error {
            assert_eq!(record["value"]["code"], code, "{label}: {record}");
            assert_eq!(record["value"]["api"], format!("wx.{api}"));
            assert!(record["value"]["errMsg"]
                .as_str()
                .unwrap()
                .starts_with(&format!("{api}:fail ")));
        } else {
            let expected = if api == "navigateTo" {
                json!({"errMsg":format!("{api}:ok"),"eventChannel":{}})
            } else {
                json!({"errMsg":format!("{api}:ok")})
            };
            assert_eq!(record["value"], expected);
        }
    }
    assert_eq!(records[2]["same"], true);
    assert_eq!(records[3]["same"], true);
}

fn assert_no_lifecycle(state: &Value) {
    assert!(state["trace"].as_array().unwrap().iter().all(|entry| {
        !matches!(
            entry["phase"].as_str(),
            Some("load" | "show" | "hide" | "unload")
        )
    }));
}

#[test]
fn navigation_callbacks_and_promises_observe_the_committed_stack() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        for (method, options, label, expected) in [
            (
                "navigateTo",
                json!({"url":DETAIL}),
                "push",
                vec![HOME, DETAIL],
            ),
            (
                "redirectTo",
                json!({"url":SECOND}),
                "replace",
                vec![HOME, SECOND],
            ),
            ("navigateBack", json!({"delta":1}), "back", vec![HOME]),
            ("switchTab", json!({"url":TAB}), "tab", vec![TAB]),
            ("reLaunch", json!({"url":HOME}), "relaunch", vec![HOME]),
            ("preloadPage", json!({"url":DETAIL}), "preload", vec![HOME]),
        ] {
            fixture.call("clear", json!([]));
            fixture.invoke(method, options, label);
            assert_eq!(fixture.routes(), expected);
            assert_completion(&fixture.inspect(), label, method, &expected, None);
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["completion"],
                label,
                "success setData must address the newly current page"
            );
        }
    }
}

#[test]
fn rejected_navigation_settles_failures_without_hiding_or_unloading_pages() {
    for engine in engines() {
        for (method, options) in [
            ("navigateTo", json!({"url":"pages/missing/index"})),
            ("navigateTo", json!({"url":TAB})),
            ("redirectTo", json!({"url":TAB})),
            ("switchTab", json!({"url":DETAIL})),
            ("preloadPage", json!({"url":"pages/missing/index"})),
            ("navigateTo", json!({})),
            ("redirectTo", json!({"url":""})),
            ("reLaunch", json!({"url":""})),
        ] {
            let mut fixture = Fixture::start(engine, None);
            let original_id = fixture.session.app_service().pages().current().unwrap().id;
            fixture.invoke(method, options, "invalid");
            let state = fixture.inspect();
            assert_completion(
                &state,
                "invalid",
                method,
                &[HOME],
                Some("ERR_INVALID_REQUEST"),
            );
            assert_no_lifecycle(&state);
            assert_eq!(fixture.routes(), [HOME]);
            assert_eq!(
                fixture.session.app_service().pages().current().unwrap().id,
                original_id
            );
        }
    }
}

#[test]
fn disabled_navigation_matches_can_i_use_and_never_mutates_the_stack() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, Some("wx.navigateTo"));
        fixture.invoke("navigateTo", json!({"url":DETAIL}), "disabled");
        let state = fixture.inspect();
        assert_eq!(state["canNavigate"], false);
        assert_completion(
            &state,
            "disabled",
            "navigateTo",
            &[HOME],
            Some("ERR_UNSUPPORTED_CAPABILITY"),
        );
        assert_no_lifecycle(&state);
        assert_eq!(fixture.routes(), [HOME]);
    }
}

#[test]
fn expired_and_cancelled_navigation_never_emits_page_lifecycle() {
    for engine in engines() {
        for (method, mut options) in [
            ("navigateTo", json!({"url":DETAIL})),
            ("redirectTo", json!({"url":DETAIL})),
            ("reLaunch", json!({"url":DETAIL})),
            ("switchTab", json!({"url":TAB})),
            ("navigateBack", json!({"delta":1})),
            ("preloadPage", json!({"url":DETAIL})),
        ] {
            let mut fixture = Fixture::start(engine, None);
            let original_id = fixture.session.app_service().pages().current().unwrap().id;
            options["deadlineNs"] = json!(1);
            fixture.invoke(method, options.clone(), "expired");
            let state = fixture.inspect();
            assert_completion(&state, "expired", method, &[HOME], Some("ERR_TIMEOUT"));
            assert_no_lifecycle(&state);

            fixture.call("clear", json!([]));
            fixture.dispatch(op::CANCEL, json!({"cancelToken":"navigation-cancelled"}));
            options.as_object_mut().unwrap().remove("deadlineNs");
            options["cancelToken"] = json!("navigation-cancelled");
            fixture.invoke(method, options, "cancelled");
            let state = fixture.inspect();
            assert_completion(&state, "cancelled", method, &[HOME], Some("ERR_CANCELLED"));
            assert_no_lifecycle(&state);
            assert_eq!(fixture.routes(), [HOME]);
            assert_eq!(
                fixture.session.app_service().pages().current().unwrap().id,
                original_id
            );
        }
    }
}

#[test]
fn a_failed_request_does_not_discard_a_later_navigation_in_the_same_engine_turn() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        fixture.call(
            "sameTurn",
            json!([
                {"method":"navigateTo","options":{"url":"pages/missing/index"},"label":"bad"},
                {"method":"navigateTo","options":{"url":DETAIL},"label":"good"}
            ]),
        );
        let state = fixture.inspect();
        assert_completion(
            &state,
            "bad",
            "navigateTo",
            &[HOME],
            Some("ERR_INVALID_REQUEST"),
        );
        assert_completion(&state, "good", "navigateTo", &[HOME, DETAIL], None);
        assert_eq!(fixture.routes(), [HOME, DETAIL]);
        let hidden = state["trace"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["phase"] == "hide")
            .count();
        assert_eq!(hidden, 1, "only the valid navigation may hide HOME");
    }
}

#[test]
fn navigation_enqueued_inside_success_runs_through_the_same_completion_boundary() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        fixture.call(
            "invoke",
            json!(["navigateTo",{"url":DETAIL},"outer",
            {"method":"redirectTo","options":{"url":SECOND},"label":"inner"}]),
        );
        let state = fixture.inspect();
        assert_completion(&state, "outer", "navigateTo", &[HOME, DETAIL], None);
        assert_completion(&state, "inner", "redirectTo", &[HOME, SECOND], None);
        assert_eq!(fixture.routes(), [HOME, SECOND]);
    }
}

#[test]
fn six_nested_callback_and_promise_navigations_finish_in_one_outer_host_call() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        let mut next = Value::Null;
        for index in (1..6).rev() {
            next = json!({
                "method": if index % 2 == 1 { "navigateBack" } else { "navigateTo" },
                "options": if index % 2 == 1 { json!({"delta":1}) } else { json!({"url":DETAIL}) },
                "label": format!("chain-{index}"),
                "when": if index % 2 == 1 { "success" } else { "resolved" },
                "next": next,
            });
        }
        fixture.call(
            "invoke",
            json!(["navigateTo", {"url":DETAIL}, "chain-0", next]),
        );
        // Inspect Rust state before another host call could drain a stranded JS request.
        assert_eq!(fixture.routes(), [HOME]);
        assert_eq!(
            fixture
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["completion"],
            "chain-5"
        );
        let state = fixture.inspect();
        for index in 0..6 {
            assert_completion(
                &state,
                &format!("chain-{index}"),
                if index % 2 == 1 {
                    "navigateBack"
                } else {
                    "navigateTo"
                },
                if index % 2 == 1 {
                    &[HOME]
                } else {
                    &[HOME, DETAIL]
                },
                None,
            );
        }
    }
}

#[test]
fn title_provider_errors_deadlines_and_cancellation_reject_without_changing_page_state() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        fixture.invoke("setNavigationBarTitle", json!({"title":"accepted","deadlineNs":9_000_000_000_000_000_000_u64,"cancelToken":"live"}), "title-ok");
        assert_completion(
            &fixture.inspect(),
            "title-ok",
            "setNavigationBarTitle",
            &[HOME],
            None,
        );
        let first = fixture.provider.calls.lock().unwrap()[0].clone();
        assert_eq!(first["deadlineNs"], 9_000_000_000_000_000_000_u64);
        assert_eq!(first["cancelToken"], "live");
        fixture.dispatch(op::CANCEL, json!({"cancelToken":"cancelled-title"}));
        for (options, code) in [
            (json!({"title":"denied"}), "ERR_PERMISSION_DENIED"),
            (json!({"title":"expired","deadlineNs":1}), "ERR_TIMEOUT"),
            (
                json!({"title":"cancelled","cancelToken":"cancelled-title"}),
                "ERR_CANCELLED",
            ),
        ] {
            fixture.call("clear", json!([]));
            fixture.invoke("setNavigationBarTitle", options, "title-failed");
            let state = fixture.inspect();
            assert_completion(
                &state,
                "title-failed",
                "setNavigationBarTitle",
                &[HOME],
                Some(code),
            );
            assert_no_lifecycle(&state);
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .navigation_bar_title,
                "accepted"
            );
        }
        assert_eq!(
            fixture.provider.calls.lock().unwrap().len(),
            2,
            "expired/cancelled requests must stop before the provider"
        );
    }
}

#[test]
fn request_task_abort_cancels_navigation_sharing_its_token_in_the_same_turn() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        let original_id = fixture.session.app_service().pages().current().unwrap().id;
        let batch = fixture.dispatch_raw(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":"abortSharedNavigation","args":[DETAIL,"shared-request-navigation"]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true);
        // RequestTask.abort has its own diagnostic; the navigation still must
        // settle through its fail/complete/Promise boundary, without commits.
        assert!(fixture.session.is_cancelled("shared-request-navigation"));
        assert_eq!(fixture.routes(), [HOME]);
        assert_eq!(
            fixture.session.app_service().pages().current().unwrap().id,
            original_id
        );
        let state = fixture.inspect();
        assert_completion(
            &state,
            "shared-abort",
            "navigateTo",
            &[HOME],
            Some("ERR_CANCELLED"),
        );
        assert_no_lifecycle(&state);
    }
}

#[test]
fn continuation_budget_preserves_consumed_trace_and_defers_pending_navigation_to_next_turn() {
    const TOTAL: u64 = 1536;
    const BUDGET: u64 = 1024;
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        let batch = fixture.dispatch_raw(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":"startBudget","args":[TOTAL,DETAIL]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true);
        let errors = batch
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .collect::<Vec<_>>();
        assert_eq!(
            errors.len(),
            1,
            "budget exhaustion must report once: {errors:?}"
        );
        assert_eq!(errors[0].payload["error"]["code"], "ERR_TIMEOUT");
        let consumed_calls = batch
            .messages
            .iter()
            .filter(|message| message.op == op::EVENT_BATCH)
            .filter_map(|message| message.payload["effects"].as_array())
            .flatten()
            .filter_map(|effect| effect["events"].as_array())
            .flatten()
            .filter(|event| event["type"] == "api.call" && event["name"] == "wx.redirectTo")
            .count();
        assert_eq!(
            consumed_calls as u64, BUDGET,
            "already committed effects must remain observable"
        );
        // No inspection host call may mask a second cleanup drain here.
        assert_eq!(
            fixture
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .query["step"],
            BUDGET.to_string()
        );
        assert_eq!(fixture.routes(), [DETAIL]);

        // The JS read runs before this host turn drains the retained effects.
        let boundary = fixture.inspect();
        assert_eq!(boundary["budget"]["completed"], BUDGET);
        assert_eq!(
            fixture
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .query["step"],
            TOTAL.to_string()
        );
        let finished = fixture.inspect();
        assert_eq!(finished["budget"]["completed"], TOTAL);
        assert_eq!(finished["budget"]["total"], TOTAL);
        assert!(finished["trace"]
            .as_array()
            .unwrap()
            .iter()
            .all(|entry| entry["phase"] != "budget-failed"));
    }
}

#[test]
fn event_channels_public_session_supports_duplicate_routes_and_retirement() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        fixture.call("startChannel", json!(["A", false]));
        let state = fixture.call("inspectChannels", json!([]));
        assert_eq!(
            state["trace"],
            json!([
                "load:A",
                "ready:A",
                "success:A",
                "early:A",
                "answer:A",
                "complete:A",
                "promise:A:true"
            ]),
            "{engine:?}: {state}"
        );
        assert_eq!(state["states"], json!(["live"]));
        assert_eq!(state["same"], json!([true]));
        fixture.call("startChannel", json!(["B", false]));
        assert_eq!(fixture.routes(), vec![HOME, DETAIL, DETAIL]);
        let state = fixture.call("inspectChannels", json!([]));
        assert_eq!(state["same"], json!([true, true]));
        fixture.invoke("navigateBack", json!({"delta":1}), "back-B");
        let state = fixture.call("inspectChannels", json!([]));
        assert_eq!(state["states"], json!(["live", "ERR_PAGE_UNLOADED"]));
        assert!(state["trace"]
            .as_array()
            .unwrap()
            .contains(&json!("closing:B")));
        fixture.invoke("navigateBack", json!({"delta":1}), "back-A");
        assert_eq!(
            fixture.call("inspectChannels", json!([]))["states"],
            json!(["ERR_PAGE_UNLOADED", "ERR_PAGE_UNLOADED"])
        );
        fixture.call("startChannel", json!(["C", false]));
        fixture.invoke(
            "redirectTo",
            json!({"url":format!("/{SECOND}?tag=R")}),
            "redirect-C",
        );
        assert_eq!(
            fixture.call("inspectChannels", json!([]))["states"],
            json!([
                "ERR_PAGE_UNLOADED",
                "ERR_PAGE_UNLOADED",
                "ERR_PAGE_UNLOADED"
            ])
        );
        fixture.invoke("reLaunch", json!({"url":format!("/{HOME}")}), "relaunch");
        assert_eq!(fixture.routes(), vec![HOME]);
    }
}

#[test]
fn event_channels_native_binding_survives_guest_compatibility_replacement() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, None);
        fixture.call("startChannel", json!(["private", true]));
        let state = fixture.call("inspectChannels", json!([]));
        assert_eq!(
            state["trace"],
            json!([
                "load:private",
                "ready:private",
                "success:private",
                "early:private",
                "answer:private",
                "complete:private",
                "promise:private:true"
            ]),
            "{engine:?}: {state}"
        );
        assert_eq!(state["same"], json!([true]));
    }
}
