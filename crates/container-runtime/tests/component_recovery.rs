//! Local failure contracts, exercised through real application modules and
//! both engine providers. These are not official DevTools parity evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::Renderer;
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const APP: &str = r#"
App({trace:[],badRows:false,cycleDetached:false,armed:'',faults:0,calls:0,ordinal:0});
function current() { const pages=getCurrentPages(); return pages[pages.length-1]; }
const reconcile=globalThis.__container_reconcile_components;
globalThis.__container_reconcile_components=function(batch) {
  getApp().calls++;
  const result=reconcile(batch);
  const armed=getApp().armed;
  if (armed==='receipt-'+batch.phase || armed==='snapshot-'+batch.phase
      || armed==='duplicate-'+batch.phase || armed==='ack-'+batch.phase
      || armed==='partial-'+batch.phase) {
    getApp().armed=''; getApp().faults++;
    if (armed==='receipt-'+batch.phase) return null;
    if (armed==='snapshot-'+batch.phase) delete result.instances[0].snapshot;
    if (armed==='duplicate-'+batch.phase) result.instances.push(result.instances[0]);
    if (armed==='partial-'+batch.phase) result.instances.pop();
    if (armed==='ack-'+batch.phase) delete result.acknowledgedScopeIds;
    return result;
  }
  if (getApp().armed===batch.phase
      || getApp().armed==='prepare-nested' && batch.phase==='prepare'
      && batch.instances.some(function(entry) {return entry.parentScopeId!==null;})) {
    getApp().armed=''; getApp().faults++;
    throw new Error('completed-'+batch.phase+'-then-failed');
  }
  return result;
};
const relations=globalThis.__container_commit_component_relations;
globalThis.__container_commit_component_relations=function(batch) {
  getApp().calls++;
  const result=relations(batch);
  if (getApp().armed==='receipt-relations') {
    getApp().armed=''; getApp().faults++; return {instances:[]};
  }
  if (getApp().armed==='relations' && batch.silent
      || getApp().armed==='commit-relations' && !batch.silent) {
    getApp().armed=''; getApp().faults++;
    throw new Error('completed-relations-then-failed');
  }
  return result;
};
exports.enableBad=function(phase) {
  getApp().badRows=true; getApp().armed=phase;
  current().setData({transient:true}); return {};
};
exports.removeWithCyclicDetached=function() {
  getApp().cycleDetached=true; current().setData({transient:false}); return {};
};
exports.arm=function(phase) { getApp().armed=phase; return {}; };
exports.show=function() {current().setData({transient:true}); return {};};
exports.localKeeper=function() {
  getApp().keeper.setData({show:true,caption:'local'}); return {};
};
exports.keeperState=function() {return getApp().keeper.data;};
exports.repair=function() {
  getApp().badRows=false; current().setData({transient:false}); return {};
};
exports.stats=function() {
  const app=getApp();
  return {trace:app.trace.slice(),faults:app.faults,calls:app.calls};
};
"#;
const KEEPER: &str = r#"
Component({lifetimes:{
  created:function() {getApp().trace.push('keeper:created');},
  detached:function() {getApp().trace.push('keeper:detached');}
}});
"#;
const CHILD: &str = r#"
Component({data:{rows:[]},lifetimes:{
  created:function() {
    getApp().trace.push('child:created');
    if (getApp().badRows) this.setData({rows:[{id:'same'},{id:'same'}]});
  },
  detached:function() {
    getApp().trace.push('child:detached');
    if (getApp().cycleDetached) this.data.self=this.data;
  }
}});
"#;
const ORDERED_KEEPER: &str = r#"
Component({properties:{show:Boolean,caption:{type:String,value:'default'}},lifetimes:{
  created:function() {getApp().keeper=this; getApp().trace.push('keeper:created');},
  detached:function() {getApp().trace.push('keeper:detached');}
}});
"#;
const ORDERED_CHILD: &str = r#"
Component({data:{rows:[]},lifetimes:{
  created:function() {
    this.ordinal=++getApp().ordinal;
    getApp().trace.push('child:'+this.ordinal+':created');
  },
  detached:function() {getApp().trace.push('child:'+this.ordinal+':detached');}
}});
"#;
const ORDERED_INNER: &str = r#"
Component({data:{rows:[]},lifetimes:{
  created:function() {
    this.ordinal=++getApp().ordinal;
    getApp().trace.push('child:'+this.ordinal+':created');
    if (getApp().badRows) this.setData({rows:[{id:'same'},{id:'same'}]});
  },
  detached:function() {getApp().trace.push('child:'+this.ordinal+':detached');}
}});
"#;
const INNER: &str = "components/inner-with-a-deliberately-long-module-name/index";

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
    fn start(engine: EngineKind, transient: bool) -> Self {
        Self::start_with_layout(engine, transient, false)
    }

    fn start_with_layout(engine: EngineKind, transient: bool, ordered: bool) -> Self {
        Self::start_with_profile(engine, transient, ordered, false)
    }

    fn start_with_profile(
        engine: EngineKind,
        transient: bool,
        ordered: bool,
        browser: bool,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "component-recovery-local-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        manifest.routes.push(Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: Some(format!("{ROUTE}.json")),
            entry_module: format!("{ROUTE}.js"),
        });
        let page = format!("Page({{data:{{transient:{transient}}}}});");
        let mut modules = Vec::new();
        let mut sources = vec![
            ("app.js", APP, ModuleScope::App),
            ("pages/index/index.js", page.as_str(), ModuleScope::Page),
            (
                "components/keeper/index.js",
                if ordered { ORDERED_KEEPER } else { KEEPER },
                ModuleScope::Component,
            ),
            (
                "components/child/index.js",
                if ordered { ORDERED_CHILD } else { CHILD },
                ModuleScope::Component,
            ),
        ];
        let inner_module = format!("{INNER}.js");
        if ordered {
            sources.push((&inner_module, ORDERED_INNER, ModuleScope::Component));
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
        let mut blobs = BTreeMap::new();
        let mut templates = vec![
            (
                TEMPLATE,
                if ordered {
                    "<view><keeper show=\"{{transient}}\"/><child wx:if=\"{{transient}}\"/></view>"
                } else {
                    "<view><keeper/><child wx:if=\"{{transient}}\"/></view>"
                },
            ),
            (
                "template:components/keeper/index.wxml",
                if ordered {
                    "<text>keeper</text><inner wx:if=\"{{show}}\"/>"
                } else {
                    "<text>keeper</text>"
                },
            ),
            (
                "template:components/child/index.wxml",
                "<view wx:for=\"{{rows}}\" wx:key=\"id\" bindtap=\"noop\"/>",
            ),
        ];
        let inner_template = format!("template:{INNER}.wxml");
        if ordered {
            templates.push((
                &inner_template,
                "<view wx:for=\"{{rows}}\" wx:key=\"id\" bindtap=\"noop\"/>",
            ));
        }
        for (id, source) in templates {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components: BTreeMap::from([
                ("keeper".into(), "components/keeper/index".into()),
                ("child".into(), "components/child/index".into()),
            ]),
            multiple_slots: None,
        });
        if ordered {
            manifest.components.push(Component {
                id: "components:components/keeper/index.json".into(),
                owner: "components/keeper/index.json".into(),
                using_components: BTreeMap::from([("inner".into(), INNER.into())]),
                multiple_slots: None,
            });
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    browser_view_enabled: browser,
                    renderer_override: browser.then_some(container_ir::RendererProfile::WebView),
                    ..Default::default()
                },
            )
            .unwrap(),
            blobs,
            sequence: 0,
        };
        fixture.ok(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        if !browser {
            let first = fixture.render();
            assert_eq!(first["ok"], true, "{engine:?}: {first}");
        }
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let result = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("recovery-{}", self.sequence),
            operation,
            payload,
        ));
        result.messages[0].payload.clone()
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let result = self.dispatch(operation, payload);
        assert_eq!(result["ok"], true, "{operation}: {result}");
        result
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn render(&mut self) -> Value {
        self.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"viewport":{"width":80,"height":48},"blobs":self.blobs}),
        )
    }
}

#[test]
fn browser_component_ready_failure_retains_committed_document_but_revokes_input() {
    use container_ir::{
        BrowserGeometryBatch, BrowserNodeGeometry, ViewNode, ViewPoint, ViewRect, ViewSize,
        VIEW_PRESENTATION_VERSION,
    };
    for engine in engines() {
        for phase in ["receipt-ready", "ready"] {
            let mut fixture = Fixture::start_with_profile(engine, false, false, true);
            let prepared = fixture.ok(op::VIEW_PREPARE, json!({"version":"1.0","surfaceGeneration":"1",
                "render":{"templateId":TEMPLATE,"viewport":{"width":80,"height":48},"useSessionResources":true}}));
            let submission: container_runtime::BrowserViewSubmission =
                serde_json::from_value(prepared["submission"].clone()).unwrap();
            let mut stack: Vec<_> = submission.document.nodes.iter().collect();
            let mut nodes = vec![];
            while let Some(node) = stack.pop() {
                nodes.push(BrowserNodeGeometry {
                    occurrence_id: node.occurrence_id().into(),
                    border_box: ViewRect {
                        x: 0.0,
                        y: 0.0,
                        width: 10.0,
                        height: 10.0,
                    },
                    scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
                    scroll_extent: ViewSize {
                        width: 10.0,
                        height: 10.0,
                    },
                    client_size: ViewSize {
                        width: 10.0,
                        height: 10.0,
                    },
                });
                if let ViewNode::Element { children, .. } = node {
                    stack.extend(children);
                }
            }
            let geometry = BrowserGeometryBatch {
                version: VIEW_PRESENTATION_VERSION.into(),
                key: submission.key.clone(),
                epoch: 0,
                viewport: submission.viewport,
                nodes,
            };
            let permit = fixture.ok(op::VIEW_PREPARE_COMMIT, json!(geometry))["permit"].clone();
            fixture.call("arm", json!([phase]));
            let batch = fixture.session.dispatch(BridgeEnvelope::request(
                "session-1",
                "browser-ack",
                op::VIEW_PRESENTED,
                permit.clone(),
            ));
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            assert_eq!(
                batch.messages[0].payload["inputEnabled"], false,
                "{batch:?}"
            );
            assert!(
                batch.messages.iter().any(|message| message.op == op::ERROR
                    && message.payload["phase"] == "ready"
                    && message.payload["committed"] == true
                    && message.payload["error"]["code"] == "ERR_ENGINE"),
                "{batch:?}"
            );
            assert_eq!(fixture.session.view_document(), Some(&submission.document));
            assert!(!fixture.session.is_browser_view_presented());
            assert!(fixture.session.renderer().last_frame().is_none());
            assert!(fixture.session.update_browser_geometry(geometry).is_err());
            assert!(fixture
                .session
                .dispatch_browser_events(
                    json!({"version":"1.0","key":submission.key,"epoch":"0","events":[]})
                )
                .is_err());
            assert_eq!(fixture.dispatch(op::VIEW_PRESENTED, permit)["ok"], false);
            assert_eq!(fixture.call("stats", json!([]))["faults"], 1);
        }
    }
}

#[test]
fn cleanup_and_restore_failures_preserve_the_primary_error_and_stop_replay() {
    for engine in engines() {
        for (phase, diagnostic) in [
            ("dispose", "dispose rejected frontier failed"),
            ("publish", "restore accepted selection failed"),
            ("relations", "restore component relations failed"),
        ] {
            let mut fixture = Fixture::start(engine, false);
            let frame = fixture.session.renderer().last_frame().unwrap().frame_id;
            fixture.call("enableBad", json!([phase]));
            let rejected = fixture.render();
            assert_eq!(
                rejected["error"]["code"], "ERR_RENDER",
                "{engine:?}: {rejected}"
            );
            let message = rejected["error"]["message"].as_str().unwrap();
            assert!(
                message.contains("duplicate keyed event identity"),
                "{message}"
            );
            assert!(message.contains(diagnostic), "{message}");
            assert!(message.contains("session restart required"), "{message}");
            let after = fixture.call("stats", json!([]));
            assert_eq!(after["faults"], 1, "{engine:?}: {after}");
            assert_eq!(
                after["trace"],
                json!(["keeper:created", "child:created", "child:detached"])
            );
            for _ in 0..2 {
                let retried = fixture.render();
                assert_eq!(retried["error"]["code"], rejected["error"]["code"]);
                assert_eq!(
                    retried["error"]["message"], rejected["error"]["message"],
                    "{engine:?}: {retried}"
                );
                assert_eq!(fixture.call("stats", json!([])), after);
                assert_eq!(
                    fixture.session.renderer().last_frame().unwrap().frame_id,
                    frame
                );
            }
            fixture.call("repair", json!([]));
            assert!(fixture.render()["error"]["message"]
                .as_str()
                .unwrap()
                .contains("session restart required"));
            assert_eq!(fixture.call("stats", json!([])), after);
        }
    }
}

#[test]
fn completed_disposal_with_unserializable_result_invalidates_instead_of_resurrecting() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        fixture.call("removeWithCyclicDetached", json!([]));
        let rejected = fixture.render();
        let message = rejected["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("dispose removed scopes returned no mutation acknowledgement"),
            "{engine:?}: {rejected}"
        );
        assert!(message.contains("session restart required"), "{message}");
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:created", "child:detached"])
        );
        assert_eq!(
            after["faults"], 0,
            "this path uses actual result serialization, without injected failure"
        );
        for _ in 0..2 {
            let retried = fixture.render();
            assert_eq!(retried["error"]["code"], rejected["error"]["code"]);
            assert_eq!(retried["error"]["message"], rejected["error"]["message"]);
            assert_eq!(fixture.call("stats", json!([])), after);
        }
    }
}

#[test]
fn an_acknowledged_cleanup_keeps_the_survivor_live_and_allows_data_repair() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("enableBad", json!([""]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_RENDER",
            "{engine:?}: {rejected}"
        );
        assert!(!rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("invalidated"));
        fixture.call("repair", json!([]));
        assert_eq!(fixture.render()["ok"], true);
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:created", "child:detached"])
        );
        assert_eq!(fixture.render()["ok"], true);
        assert_eq!(fixture.call("stats", json!([]))["trace"], after["trace"]);
    }
}

#[test]
fn unacknowledged_prepare_retains_new_scope_ownership_for_eventual_teardown() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("enableBad", json!(["prepare"]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_ENGINE",
            "{engine:?}: {rejected}"
        );
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("prepare frontier returned no mutation acknowledgement"));
        let after = fixture.call("stats", json!([]));
        assert_eq!(after["trace"], json!(["keeper:created", "child:created"]));
        fixture.render();
        assert_eq!(fixture.call("stats", json!([])), after);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:created",
                "child:detached",
                "keeper:detached"
            ])
        );
    }
}

#[test]
fn page_disposal_without_acknowledgement_never_reports_lifecycle_success() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        fixture.call("arm", json!(["dispose"]));
        let before = fixture.session.app_service().lifecycle().state();
        let rejected = fixture.dispatch(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert_eq!(rejected["error"]["code"], "ERR_ENGINE");
        assert_eq!(fixture.session.app_service().lifecycle().state(), before);
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session restart required"));
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!([
                "keeper:created",
                "child:created",
                "child:detached",
                "keeper:detached"
            ])
        );
        let render = fixture.render();
        assert_eq!(render["ok"], false);
        assert!(render["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session restart required"));
        assert_eq!(fixture.call("stats", json!([])), after);
        // A teardown retry can finish releasing retained ownership, without
        // recreating scopes or invoking their detached effects again.
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(fixture.call("stats", json!([]))["trace"], after["trace"]);
    }
}

#[test]
fn acknowledged_detach_is_not_restored_after_relation_commit_loses_its_receipt() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        fixture.call("arm", json!(["commit-relations"]));
        fixture.call("repair", json!([]));
        let rejected = fixture.render();
        let message = rejected["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("commit component relations returned no mutation acknowledgement"),
            "{engine:?}: {rejected}"
        );
        assert!(
            !message.contains("scope is unavailable"),
            "the old detached scope must never be restored: {message}"
        );
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:created", "child:detached"])
        );
        fixture.render();
        assert_eq!(fixture.call("stats", json!([])), after);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:created",
                "child:detached",
                "keeper:detached"
            ])
        );
    }
}

#[test]
fn nested_teardown_uses_physical_preorder_instead_of_scope_string_lengths() {
    for engine in engines() {
        for whole_page in [false, true] {
            let mut fixture = Fixture::start_with_layout(engine, true, true);
            assert_eq!(
                fixture.call("stats", json!([]))["trace"],
                json!(["keeper:created", "child:1:created", "child:2:created"])
            );
            if whole_page {
                fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
            } else {
                fixture.call("repair", json!([]));
                assert_eq!(fixture.render()["ok"], true);
            }
            let mut expected = vec![
                "keeper:created",
                "child:1:created",
                "child:2:created",
                // The root sibling was constructed first. Its physical
                // position is after the keeper's later-discovered child.
                "child:1:detached",
                "child:2:detached",
            ];
            if whole_page {
                expected.push("keeper:detached");
            }
            assert_eq!(
                fixture.call("stats", json!([]))["trace"],
                json!(expected),
                "{engine:?}, whole_page={whole_page}"
            );
        }
    }
}

#[test]
fn rejected_new_nested_scopes_are_disposed_in_frontier_preorder() {
    for engine in engines() {
        let mut fixture = Fixture::start_with_layout(engine, false, true);
        fixture.call("enableBad", json!([""]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_RENDER",
            "{engine:?}: {rejected}"
        );
        assert!(!rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("session restart required"));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:1:created",
                "child:2:created",
                "child:1:detached",
                "child:2:detached"
            ]),
            "{engine:?}"
        );
        fixture.call("repair", json!([]));
        assert_eq!(fixture.render()["ok"], true);
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:1:created",
                "child:2:created",
                "child:1:detached",
                "child:2:detached"
            ]),
            "repair render must update the surviving keeper before discovering descendants: {engine:?}"
        );
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:1:created",
                "child:2:created",
                "child:1:detached",
                "child:2:detached",
                "keeper:detached"
            ])
        );
    }
}

#[test]
fn unacknowledged_nested_prepare_keeps_typed_teardown_ownership() {
    for engine in engines() {
        let mut fixture = Fixture::start_with_layout(engine, false, true);
        fixture.call("arm", json!(["prepare-nested"]));
        fixture.call("show", json!([]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_ENGINE",
            "{engine:?}: {rejected}"
        );
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("prepare frontier returned no mutation acknowledgement"));
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:1:created", "child:2:created"])
        );
        assert_eq!(after["faults"], 1);
        fixture.render();
        assert_eq!(fixture.call("stats", json!([])), after);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:1:created",
                "child:2:created",
                "child:1:detached",
                "child:2:detached",
                "keeper:detached"
            ]),
            "{engine:?}"
        );
    }
}

#[test]
fn malformed_prepare_receipts_cannot_publish_data_or_release_new_scope_ownership() {
    for engine in engines() {
        for phase in [
            "receipt-prepare",
            "snapshot-prepare",
            "duplicate-prepare",
            "partial-prepare",
        ] {
            let mut fixture = Fixture::start(engine, false);
            let frame = fixture.session.renderer().last_frame().unwrap().frame_id;
            fixture.call("enableBad", json!([phase]));
            let rejected = fixture.render();
            assert_eq!(
                rejected["error"]["code"], "ERR_ENGINE",
                "{engine:?}: {rejected}"
            );
            let message = rejected["error"]["message"].as_str().unwrap();
            assert!(message.contains("invalid acknowledgement"), "{message}");
            assert!(
                message.contains("prepare frontier returned no mutation acknowledgement"),
                "{message}"
            );
            let after = fixture.call("stats", json!([]));
            assert_eq!(after["trace"], json!(["keeper:created", "child:created"]));
            fixture.render();
            assert_eq!(fixture.call("stats", json!([])), after);
            assert_eq!(
                fixture.session.renderer().last_frame().unwrap().frame_id,
                frame
            );
            fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
            assert_eq!(
                fixture.call("stats", json!([]))["trace"],
                json!([
                    "keeper:created",
                    "child:created",
                    "child:detached",
                    "keeper:detached"
                ])
            );
        }
    }
}

#[test]
fn malformed_disposal_receipt_retains_ownership_until_an_explicit_idempotent_ack() {
    for engine in engines() {
        for phase in ["receipt-dispose", "ack-dispose", "snapshot-dispose"] {
            let mut fixture = Fixture::start(engine, true);
            fixture.call("arm", json!([phase]));
            let before = fixture.session.app_service().lifecycle().state();
            let rejected = fixture.dispatch(op::APP_LIFECYCLE, json!({"event":"unload"}));
            assert_eq!(
                rejected["error"]["code"], "ERR_ENGINE",
                "{engine:?}: {rejected}"
            );
            assert!(rejected["error"]["message"]
                .as_str()
                .unwrap()
                .contains("invalid acknowledgement"));
            assert_eq!(fixture.session.app_service().lifecycle().state(), before);
            let after = fixture.call("stats", json!([]));
            assert_eq!(
                after["trace"],
                json!([
                    "keeper:created",
                    "child:created",
                    "child:detached",
                    "keeper:detached"
                ])
            );
            assert_eq!(fixture.render()["ok"], false);
            assert_eq!(fixture.call("stats", json!([])), after);
            // Nothing remains in the JS scope table, but its explicit receipt
            // acknowledges every leased ID without rerunning detached hooks.
            fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
            let released = fixture.call("stats", json!([]));
            assert_eq!(released["trace"], after["trace"]);
            assert_eq!(released["faults"], after["faults"]);
            // Retried disposal and empty index publication are real batch
            // acknowledgements, even though detached effects stay idempotent.
            assert_eq!(
                released["calls"].as_u64().unwrap(),
                after["calls"].as_u64().unwrap() + 2
            );
        }
    }
}

#[test]
fn a_partial_relation_receipt_cannot_resurrect_an_acknowledged_detach() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        fixture.call("arm", json!(["receipt-relations"]));
        fixture.call("repair", json!([]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_ENGINE",
            "{engine:?}: {rejected}"
        );
        assert!(rejected["error"]["message"]
            .as_str()
            .unwrap()
            .contains("instance scopes do not match the complete request"));
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:created", "child:detached"])
        );
        fixture.render();
        assert_eq!(fixture.call("stats", json!([])), after);
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:created",
                "child:detached",
                "keeper:detached"
            ])
        );
    }
}

#[test]
fn raw_binding_receipts_preserve_omitted_defaults_and_component_local_changes() {
    for engine in engines() {
        let mut fixture = Fixture::start_with_layout(engine, false, true);
        assert_eq!(fixture.call("keeperState", json!([]))["caption"], "default");
        fixture.call("localKeeper", json!([]));
        assert_eq!(fixture.render()["ok"], true);
        let trace = fixture.call("stats", json!([]))["trace"].clone();
        assert_eq!(trace, json!(["keeper:created", "child:1:created"]));
        for _ in 0..2 {
            assert_eq!(fixture.render()["ok"], true);
            let state = fixture.call("keeperState", json!([]));
            assert_eq!(state["show"], true);
            assert_eq!(state["caption"], "local");
            assert_eq!(fixture.call("stats", json!([]))["trace"], trace);
        }
    }
}

#[test]
fn rejected_frontier_does_not_reconstruct_scopes_until_parent_input_changes() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("enableBad", json!([""]));
        let rejected = fixture.render();
        assert_eq!(
            rejected["error"]["code"], "ERR_RENDER",
            "{engine:?}: {rejected}"
        );
        let after = fixture.call("stats", json!([]));
        assert_eq!(
            after["trace"],
            json!(["keeper:created", "child:created", "child:detached"])
        );
        for _ in 0..3 {
            let repeated = fixture.render();
            // The retained execution failure is stable, while each transport
            // response must carry the new request's correlation identifier.
            assert_ne!(
                repeated["error"]["request_id"],
                rejected["error"]["request_id"]
            );
            let mut actual = repeated["error"].as_object().unwrap().clone();
            let mut expected = rejected["error"].as_object().unwrap().clone();
            actual.remove("request_id");
            expected.remove("request_id");
            assert_eq!(actual, expected);
            assert_eq!(fixture.call("stats", json!([])), after);
        }
        // A real page input change invalidates the single rejected memo. The
        // next occurrence is fresh, rather than retaining a detached heap.
        fixture.call("repair", json!([]));
        assert_eq!(fixture.render()["ok"], true);
        fixture.call("enableBad", json!([""]));
        assert_eq!(fixture.render()["error"]["code"], "ERR_RENDER");
        assert_eq!(
            fixture.call("stats", json!([]))["trace"],
            json!([
                "keeper:created",
                "child:created",
                "child:detached",
                "child:created",
                "child:detached",
            ])
        );
    }
}
