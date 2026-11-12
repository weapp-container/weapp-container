//! Native Session/AppService/View integration contracts. These local tests are
//! auxiliary evidence and do not establish official WeChat WXS parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template, ViewScriptModule,
};
use container_render_skia::{RenderNode, Renderer};
use container_runtime::{HostRequest, Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const PAGE: &str = "template:pages/index/index.wxml";
const VIEW: &str = "wxs:shared/counter.wxs";
const APP: &str = r#"
globalThis.appOnly='AppService';
App({trace:[],diagnosticCalls:0,onUnload:function(){
  this.trace.push('app:unload');wx.setStorageSync('unload-completed',true);
}});
function current() {const pages=getCurrentPages();return pages[pages.length-1];}
exports.patch=function(value) {current().setData(value);return {};};
exports.beginHost=function() {
  weappContainer.onMessage(function(){wx.setStorageSync('late-host-message',true);});
  weappContainer.invoke('retirement.pending',{}).catch(function(){
    wx.setStorageSync('host-cancelled',true);
  });
  return true;
};
exports.stats=function() {
  const app=getApp();app.diagnosticCalls++;
  return {viewGlobal:typeof globalThis.viewOnly,appGlobal:globalThis.appOnly,
    diagnosticCalls:app.diagnosticCalls,trace:app.trace.slice()};
};
"#;
const COUNTER: &str = r#"
var calls=0;
exports.next=function(label,fail,spin) {
  calls++;
  if (spin) while(true) {}
  if (fail) throw new Error('counter-call-'+calls);
  return calls+':'+label;
};
exports.environment=function() {
  globalThis.viewOnly='View';
  return [typeof wx,typeof App,typeof Page,typeof Component,typeof getApp,
    typeof globalThis.appOnly].join(',');
};
"#;
const SIMPLE: &str = r#"
<wxs module="tools" src="../../shared/counter.wxs"/>
<text id="counter">{{tools.next(label,fail,spin)}}</text>
<text id="environment">{{tools.environment()}}</text>
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
    blobs: BTreeMap<String, Vec<u8>>,
    sequence: u64,
}

impl Fixture {
    fn start(engine: EngineKind, components: bool) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "session-native-view-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        for capability in ["wx.getStorageSync", "wx.setStorageSync"] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Full);
        }
        manifest.routes.push(Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: Some(format!("{ROUTE}.json")),
            entry_module: format!("{ROUTE}.js"),
        });
        let mut modules = Vec::new();
        let mut sources = vec![
            ("app.js", APP, ModuleScope::App),
            (
                "pages/index/index.js",
                r#"Page({data:{label:'A',fail:false,spin:false,
                    rows:[{id:'a',label:'A'},{id:'b',label:'A'}]}});"#,
                ModuleScope::Page,
            ),
        ];
        if components {
            sources.push((
                "components/card/index.js",
                r#"Component({properties:{ident:String,label:String,spin:Boolean},lifetimes:{
                    attached:function(){getApp().trace.push('attached:'+this.properties.ident);},
                    detached:function(){getApp().trace.push('detached:'+this.properties.ident);
                        wx.setStorageSync('detached:'+this.properties.ident,true);}
                }});"#,
                ModuleScope::Component,
            ));
        }
        for (id, source, scope) in sources {
            let id = format!("module:{id}");
            manifest.modules.push(Module {
                id: id.clone(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let hash = hex_digest(COUNTER.as_bytes());
        manifest.view_scripts.push(ViewScriptModule {
            id: VIEW.into(),
            sha256: hash.clone(),
            dependencies: Vec::new(),
        });
        let mut blobs = BTreeMap::from([(format!("sha256:{hash}"), COUNTER.as_bytes().to_vec())]);
        let mut templates = vec![(
            PAGE,
            if components {
                r#"<view><card wx:for="{{rows}}" wx:key="id" id="{{item.id}}"
                    ident="{{item.id}}" label="{{item.label}}" spin="{{spin}}"/></view>"#
            } else {
                SIMPLE
            },
            !components,
        )];
        if components {
            templates.push((
                "template:components/card/index.wxml",
                r#"<wxs module="tools" src="../../shared/counter.wxs"/>
                <text class="counter" data-ident="{{ident}}">{{tools.next(label,false,spin)}}</text>"#,
                true,
            ));
            manifest.components.push(Component {
                id: "components:pages/index/index.json".into(),
                owner: "pages/index/index.json".into(),
                using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
                multiple_slots: None,
            });
        }
        for (id, source, has_wxs) in templates {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: if has_wxs {
                    BTreeMap::from([("tools".into(), VIEW.into())])
                } else {
                    BTreeMap::new()
                },
            });
            blobs.insert(pointer, bytes);
        }
        manifest.refresh_integrity().unwrap();
        let appservice_modules = manifest.modules.len();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            blobs,
            sequence: 0,
        };
        fixture
            .session
            .set_host_methods(vec!["retirement.pending".into()])
            .unwrap();
        let initialized = fixture.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        assert_eq!(initialized["loadedModules"], appservice_modules);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        fixture.render_ok();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        self.session
            .dispatch(BridgeEnvelope::request(
                "session-1",
                format!("view-{}", self.sequence),
                operation,
                payload,
            ))
            .messages[0]
            .payload
            .clone()
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let response = self.dispatch(operation, payload);
        assert_eq!(response["ok"], true, "{operation}: {response}");
        response
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn patch(&mut self, data: Value) {
        self.call("patch", json!([data]));
    }

    fn render(&mut self) -> Value {
        self.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE,"viewport":{"width":160,"height":120},"blobs":self.blobs}),
        )
    }

    fn render_ok(&mut self) {
        let response = self.render();
        assert_eq!(response["ok"], true, "{response}");
    }

    fn text(&self, selector: &str) -> String {
        let matches = self
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query(selector, true)
            .unwrap();
        assert_eq!(matches.len(), 1, "{selector}");
        text(matches[0])
    }

    fn cards(&self) -> BTreeMap<String, String> {
        let nodes = self
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query(".counter", true)
            .unwrap();
        let expected_count = nodes.len();
        let cards: BTreeMap<_, _> = nodes
            .into_iter()
            .map(|node| {
                (
                    node.dataset["ident"]
                        .as_str()
                        .expect("the component identity binding is a string")
                        .to_owned(),
                    text(node),
                )
            })
            .collect();
        assert_eq!(
            cards.len(),
            expected_count,
            "duplicate rendered component identities"
        );
        cards
    }
}

fn text(node: &RenderNode) -> String {
    node.text.clone().unwrap_or_default() + &node.children.iter().map(text).collect::<String>()
}

#[test]
fn declared_view_modules_execute_in_an_isolated_realm_for_the_selected_engine() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        assert_eq!(fixture.text("#counter"), "1:A", "{engine:?}");
        assert_eq!(
            fixture.text("#environment"),
            "undefined,undefined,undefined,undefined,undefined,undefined",
            "{engine:?}"
        );
        let app = fixture.call("stats", json!([]));
        assert_eq!(app["appGlobal"], "AppService");
        assert_eq!(app["viewGlobal"], "undefined");
    }
}

#[test]
fn unchanged_inputs_do_not_replay_wxs_and_a_b_a_is_three_distinct_updates() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        for _ in 0..3 {
            fixture.render_ok();
            assert_eq!(fixture.text("#counter"), "1:A", "{engine:?}");
        }
        fixture.patch(json!({"label":"A"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "1:A", "{engine:?}");
        fixture.patch(json!({"label":"B"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "2:B", "{engine:?}");
        fixture.patch(json!({"label":"A"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "3:A", "{engine:?}");
    }
}

#[test]
fn failed_input_is_not_replayed_and_repair_continues_the_same_view_heap() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let previous = fixture.session.renderer().last_frame().unwrap().clone();
        fixture.patch(json!({"fail":true}));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_RENDER",
            "{engine:?}: {rejected}"
        );
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("counter-call-2"));
        for _ in 0..2 {
            let retry = fixture.render();
            assert_eq!(
                retry["error"]["code"], rejected["error"]["code"],
                "{engine:?}: {retry}"
            );
            assert_eq!(
                retry["error"]["message"], rejected["error"]["message"],
                "{engine:?}: {retry}"
            );
            assert_eq!(fixture.session.renderer().last_frame(), Some(&previous));
        }
        fixture.patch(json!({"fail":false,"label":"repaired"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "3:repaired", "{engine:?}");
    }
}

#[test]
fn keyed_components_keep_independent_view_state_and_detach_releases_their_heap() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        let expected = BTreeMap::from([("a".into(), "1:A".into()), ("b".into(), "1:A".into())]);
        assert_eq!(fixture.cards(), expected, "{engine:?}");
        fixture.patch(json!({"rows":[{"id":"b","label":"A"},{"id":"a","label":"A"}]}));
        fixture.render_ok();
        assert_eq!(fixture.cards(), expected, "{engine:?}");
        fixture.patch(json!({"rows":[{"id":"b","label":"B"},{"id":"a","label":"A"}]}));
        fixture.render_ok();
        assert_eq!(
            fixture.cards(),
            BTreeMap::from([("a".into(), "1:A".into()), ("b".into(), "2:B".into())]),
            "{engine:?}"
        );
        fixture.patch(json!({"rows":[{"id":"b","label":"B"}]}));
        fixture.render_ok();
        assert_eq!(
            fixture.cards(),
            BTreeMap::from([("b".into(), "2:B".into())]),
            "{engine:?}"
        );
        fixture.patch(json!({"rows":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}));
        fixture.render_ok();
        assert_eq!(
            fixture.cards(),
            BTreeMap::from([("a".into(), "1:A".into()), ("b".into(), "2:B".into())]),
            "{engine:?}"
        );
        let trace = fixture.call("stats", json!([]))["trace"].clone();
        let trace = trace.as_array().unwrap();
        assert_eq!(
            trace
                .iter()
                .filter(|entry| entry.as_str() == Some("attached:a"))
                .count(),
            2,
            "{engine:?}: {trace:?}"
        );
        assert_eq!(
            trace
                .iter()
                .filter(|entry| entry.as_str() == Some("attached:b"))
                .count(),
            1,
            "{engine:?}: {trace:?}"
        );
        assert_eq!(
            trace
                .iter()
                .filter(|entry| entry.as_str() == Some("detached:a"))
                .count(),
            1,
            "{engine:?}: {trace:?}"
        );
    }
}

#[test]
fn hidden_pages_retain_their_view_cache_while_new_pages_start_at_one() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.patch(json!({"label":"bottom"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "2:bottom", "{engine:?}");
        fixture.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "1:A", "{engine:?}");
        fixture.patch(json!({"label":"top"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "2:top", "{engine:?}");
        fixture.ok(op::PAGE_POP, json!({}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "2:bottom", "{engine:?}");
        fixture.patch(json!({"label":"bottom-again"}));
        fixture.render_ok();
        assert_eq!(fixture.text("#counter"), "3:bottom-again", "{engine:?}");
    }
}

#[test]
fn view_timeout_keeps_the_committed_frame_and_does_not_kill_appservice() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let previous = fixture.session.renderer().last_frame().unwrap().clone();
        fixture.patch(json!({"spin":true}));
        let timed_out = fixture.render();
        assert_eq!(
            timed_out["error"]["code"], "ERR_TIMEOUT",
            "{engine:?}: {timed_out}"
        );
        assert_eq!(fixture.session.renderer().last_frame(), Some(&previous));
        let diagnostic = fixture.call("stats", json!([]));
        assert_eq!(diagnostic["appGlobal"], "AppService", "{engine:?}");
        fixture.patch(json!({"spin":false,"label":"new-input"}));
        let refused = fixture.render();
        assert_eq!(
            refused["error"]["code"], "ERR_ENGINE",
            "{engine:?}: {refused}"
        );
        assert!(refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("ERR_VIEW_REQUIRES_RESET"));
        assert_eq!(fixture.session.renderer().last_frame(), Some(&previous));
    }
}

#[test]
fn poisoned_view_final_unload_preserves_appservice_hooks_storage_and_host_cleanup() {
    for engine in engines() {
        for components in [false, true] {
            let mut fixture = Fixture::start(engine, components);
            fixture.call("beginHost", json!([]));
            assert_eq!(fixture.session.pending_host_call_count(), 1);
            let dispatched = fixture.session.take_host_requests();
            let call_id = match &dispatched[..] {
                [HostRequest::Call {
                    call_id, method, ..
                }] => {
                    assert_eq!(method, "retirement.pending");
                    call_id.clone()
                }
                _ => panic!("expected one owned pending call: {dispatched:?}"),
            };
            fixture.patch(json!({"spin":true}));
            let rejected = fixture.render();
            assert_eq!(
                rejected["error"]["code"], "ERR_TIMEOUT",
                "{engine:?}: {rejected}"
            );
            let fault = fixture.session.execution_health().view_fault.unwrap();
            assert!(
                fault.details.is_some(),
                "retain the original first-fault witness"
            );
            assert!(fixture
                .session
                .execution_health()
                .app_service_fault
                .is_none());

            let unloaded = fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
            assert_eq!(unloaded["state"], "Destroyed");
            let stats = fixture.call("stats", json!([]));
            let trace = stats["trace"].as_array().unwrap();
            assert_eq!(trace.last(), Some(&json!("app:unload")));
            for ident in ["a", "b"] {
                let detached = json!(format!("detached:{ident}"));
                assert_eq!(
                    trace.iter().filter(|entry| *entry == &detached).count(),
                    usize::from(components)
                );
                if components {
                    assert_eq!(
                        fixture
                            .session
                            .app_service()
                            .storage()
                            .get(&format!("detached:{ident}")),
                        Some(&json!(true))
                    );
                }
            }
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .storage()
                    .get("unload-completed"),
                Some(&json!(true))
            );
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .storage()
                    .get("host-cancelled"),
                Some(&json!(true))
            );
            assert_eq!(fixture.session.pending_host_call_count(), 0);
            assert!(matches!(&fixture.session.take_host_requests()[..],
                [HostRequest::Cancel {call_id: cancelled}] if cancelled == &call_id));
            assert!(fixture
                .session
                .send_host_message(json!({"late":true}))
                .is_err());
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .storage()
                    .get("late-host-message"),
                None
            );
            let after = fixture.session.execution_health();
            assert!(after.requires_restart);
            assert!(after.app_service_fault.is_none());
            assert_eq!(after.view_fault, Some(fault));
            assert!(!fixture.session.is_current_frame_presented());
            assert!(fixture.session.acknowledge_presentation(1).is_err());
        }
    }
}
