//! Relations exercised through ordinary application modules and the public
//! Session bridge/render path. The first test copies the saved 3.17.3 oracle
//! trace; the remaining tests define local contracts pending official evidence.
//! No test supplies synthetic component graph records to either engine.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, AppInfo, CapabilitySupport, CompilerInfo, Component,
    ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::{RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const APP_MODULE: &str = "module:app.js";
const PAGE_TEMPLATE: &str = "template:pages/index/index.wxml";
const PARENT_KEY: &str = "../child/index";
const CHILD_KEY: &str = "../parent/index";

const APP_JS: &str = r#"
App({
  trace:[], serial:0, pageSerial:0, held:[],
  keys:{parent:'%PARENT_KEY%',child:'%CHILD_KEY%'},
  record:function(role,event,nodes) {
    this.trace.push(role+':'+event+':'+(nodes.map(function(node) { return node.data.label; }).join(',')||'none'));
  }
});
function currentPage() { const pages=getCurrentPages(); return pages[pages.length-1]; }
function describe(component) {
  return component==null ? null : {serial:component.fixtureSerial,label:component.data.label,
    name:component.properties.name||component.data.label,count:component.data.count,
    active:component.fixtureActive===true};
}
function related(component,role) { return component.getRelationNodes(getApp().keys[role]); }
exports.trace=function() { return {trace:getApp().trace.slice()}; };
exports.graph=function() {
  const page=currentPage(); const parent=page.selectComponent('#relation-parent');
  const children=page.selectAllComponents('.relation-child');
  const targets=related(parent,'parent');
  return {page:page.fixturePageSerial,parent:describe(parent),targets:targets.map(describe),
    children:children.map(function(child) { return {instance:describe(child),parents:related(child,'child').map(describe),
      sameParent:related(child,'child')[0]===parent}; }),
    firstIsSelected:targets[0]===page.selectComponent('#relation-child')};
};
exports.setVisible=function(visible) { currentPage().setData({showChild:visible}); return {}; };
exports.invokeRelated=function(amount) {
  const page=currentPage(); const parent=page.selectComponent('#relation-parent');
  const child=related(parent,'parent')[0];
  return {value:child.bump(amount),same:child===page.selectComponent('#relation-child'),child:describe(child)};
};
exports.mutateReturnedArray=function() {
  const parent=currentPage().selectComponent('#relation-parent'); const targets=related(parent,'parent');
  const first=targets[0]; targets.length=0;
  return {count:related(parent,'parent').length,same:related(parent,'parent')[0]===first};
};
exports.holdCurrent=function() {
  const page=currentPage(); const parent=page.selectComponent('#relation-parent');
  const child=related(parent,'parent')[0];
  getApp().held.push({page:page.fixturePageSerial,parent:parent,child:child});
  return {index:getApp().held.length-1,page:page.fixturePageSerial,parent:describe(parent),child:describe(child)};
};
exports.held=function(index) {
  const held=getApp().held[index];
  return {page:held.page,parent:describe(held.parent),child:describe(held.child),
    parentTargets:related(held.parent,'parent').map(describe),childTargets:related(held.child,'child').map(describe),
    sameChild:related(held.parent,'parent')[0]===held.child,sameParent:related(held.child,'child')[0]===held.parent};
};
exports.behaviors=function() {
  const page=currentPage(); const child=page.selectComponent('#relation-child');
  const other=page.selectComponent('#other-child');
  const parent=page.selectComponent('#relation-parent');
  return {identifierType:typeof getApp().baseBehavior,
    direct:child.hasBehavior(getApp().nestedBehavior),transitive:child.hasBehavior(getApp().baseBehavior),
    different:child.hasBehavior(getApp().otherBehavior),otherOwn:other.hasBehavior(getApp().otherBehavior),
    otherBase:other.hasBehavior(getApp().baseBehavior),
    targets:related(parent,'parent').map(describe),same:related(parent,'parent')[0]===child};
};
"#;

const PAGE_JS: &str = r#"
Page({data:{showChild:true},onLoad:function() {
  this.fixturePageSerial=++getApp().pageSerial;
  getApp().trace.push('page:onLoad');
}});
"#;

const COMPONENT_JS: &str = r#"
Component({
  options:{multipleSlots:true},
  properties:{name:{type:String,value:'%ROLE%'}},
  data:{label:'%ROLE%',count:0},
  %BEHAVIORS%
  %RELATIONS%
  lifetimes:{
    created:function() { this.fixtureSerial=++getApp().serial; this.fixtureActive=false; },
    attached:function() { this.fixtureActive=true; getApp().record('%ROLE%','attached',this.getRelationNodes(getApp().keys['%ROLE%'])); },
    ready:function() { getApp().record('%ROLE%','ready',this.getRelationNodes(getApp().keys['%ROLE%'])); },
    detached:function() { this.fixtureActive=false; getApp().record('%ROLE%','detached',this.getRelationNodes(getApp().keys['%ROLE%'])); }
  },
  methods:{bump:function(amount) { this.setData({count:this.data.count+amount}); return this.data.count; }}
});
"#;

const PAGE_WXML: &str = r#"<view id="page-root"><relation-parent id="relation-parent"><view class="projected-wrapper"><relation-child wx:if="{{showChild}}" id="relation-child" class="relation-child"/></view></relation-parent></view>"#;
const PARENT_WXML: &str = r#"<view class="parent-native"><text class="parent-value">{{label}}:{{count}}</text><slot/></view>"#;
const CHILD_WXML: &str = r#"<view><text class="child-value">{{label}}:{{count}}</text></view>"#;
const NESTED_WXML: &str = r#"<view><relation-parent id="relation-parent"><view><relation-child id="relation-child" class="relation-child" name="direct"/><middle><view><relation-child id="nested-child" class="relation-child" name="nested"/></view></middle></view></relation-parent></view>"#;

const INITIAL_TRACE: &[&str] = &[
    "parent:attached:none",
    "child:attached:none",
    "parent:linked:child",
    "child:linked:parent",
    "page:onLoad",
    "parent:ready:child",
    "child:ready:parent",
];

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn component_source(
    role: &str,
    key: &str,
    relation_type: Option<&str>,
    behavior_target: Option<&str>,
    behaviors: Option<&str>,
) -> String {
    let relations = relation_type
        .map(|relation_type| {
            let target = behavior_target
                .map(|target| format!("target:{target},"))
                .unwrap_or_default();
            format!(
                "relations:{{'{key}':{{type:'{relation_type}',{target}\
                linked:function() {{ getApp().record('{role}','linked',this.getRelationNodes('{key}')); }},\
                unlinked:function() {{ getApp().record('{role}','unlinked',this.getRelationNodes('{key}')); }}\
                }}}},"
            )
        })
        .unwrap_or_default();
    COMPONENT_JS
        .replace("%ROLE%", role)
        .replace("%RELATIONS%", &relations)
        .replace(
            "%BEHAVIORS%",
            &behaviors
                .map(|behaviors| format!("behaviors:[{behaviors}],"))
                .unwrap_or_default(),
        )
}

struct Sources {
    app: String,
    parent: String,
    child: String,
    other: String,
    page_wxml: String,
    parent_wxml: String,
    disabled_capabilities: Vec<String>,
}

impl Sources {
    fn with_relations(parent_type: Option<&str>, child_type: Option<&str>) -> Self {
        Self {
            app: APP_JS
                .replace("%PARENT_KEY%", PARENT_KEY)
                .replace("%CHILD_KEY%", CHILD_KEY),
            parent: component_source("parent", PARENT_KEY, parent_type, None, None),
            child: component_source("child", CHILD_KEY, child_type, None, None),
            other: "Component({});".into(),
            page_wxml: PAGE_WXML.into(),
            parent_wxml: PARENT_WXML.into(),
            disabled_capabilities: Vec::new(),
        }
    }
}

struct Fixture {
    session: Session,
    blobs: BTreeMap<String, Vec<u8>>,
    sequence: u64,
    engine: EngineKind,
}

impl Fixture {
    fn start(engine: EngineKind, sources: Sources) -> Self {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "component-relations-fixture".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        for capability in [
            "Page.selectComponent",
            "Page.selectAllComponents",
            "Component.selectComponent",
            "Component.selectAllComponents",
            "Component.selectOwnerComponent",
            "Component.relations",
            "Component.getRelationNodes",
            "Component.hasBehavior",
        ] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Partial);
        }
        for capability in &sources.disabled_capabilities {
            manifest
                .capabilities
                .insert(capability.clone(), CapabilitySupport::Unsupported);
        }
        for route in ["index", "empty"] {
            manifest.routes.push(Route {
                id: format!("route:pages/{route}/index"),
                path: format!("pages/{route}/index"),
                kind: RouteKind::Page,
                config: Some(format!("pages/{route}/index.json")),
                entry_module: format!("pages/{route}/index.js"),
            });
        }
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP_MODULE, sources.app.as_str(), ModuleScope::App),
            ("module:pages/index/index.js", PAGE_JS, ModuleScope::Page),
            (
                "module:pages/empty/index.js",
                "Page({data:{}});",
                ModuleScope::Page,
            ),
            (
                "module:components/parent/index.js",
                sources.parent.as_str(),
                ModuleScope::Component,
            ),
            (
                "module:components/child/index.js",
                sources.child.as_str(),
                ModuleScope::Component,
            ),
            (
                "module:components/middle/index.js",
                "Component({options:{multipleSlots:true}});",
                ModuleScope::Component,
            ),
            (
                "module:components/other/index.js",
                sources.other.as_str(),
                ModuleScope::Component,
            ),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            (PAGE_TEMPLATE, sources.page_wxml.as_str()),
            ("template:pages/empty/index.wxml", "<view>empty</view>"),
            (
                "template:components/parent/index.wxml",
                sources.parent_wxml.as_str(),
            ),
            ("template:components/child/index.wxml", CHILD_WXML),
            (
                "template:components/middle/index.wxml",
                "<view><slot/></view>",
            ),
            ("template:components/other/index.wxml", CHILD_WXML),
        ] {
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
        let using_components = BTreeMap::from([
            ("relation-parent".into(), "components/parent/index".into()),
            ("relation-child".into(), "components/child/index".into()),
            ("middle".into(), "components/middle/index".into()),
            ("relation-other".into(), "components/other/index".into()),
        ]);
        manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components,
            multiple_slots: None,
        });
        for component in ["parent", "child", "middle", "other"] {
            manifest.components.push(Component {
                id: format!("components:components/{component}/index.json"),
                owner: format!("components/{component}/index.json"),
                using_components: if component == "parent" {
                    BTreeMap::from([("relation-child".into(), "components/child/index".into())])
                } else {
                    BTreeMap::new()
                },
                multiple_slots: Some(true),
            });
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..SessionConfig::default()
                },
            )
            .unwrap(),
            blobs,
            sequence: 0,
            engine,
        };
        fixture.dispatch(
            op::APP_INIT,
            json!({"modules":modules,"blobs":fixture.blobs}),
        );
        fixture.dispatch(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.dispatch(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        fixture.render();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("relations-{}", self.sequence),
            operation,
            payload,
        ));
        assert_eq!(
            batch.messages[0].payload["ok"], true,
            "{:?} {operation}: {:?}",
            self.engine, batch.messages,
        );
        batch.messages[0].payload.clone()
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn render(&mut self) {
        let page = self.session.app_service().pages().current().unwrap();
        let template = format!("template:{}.wxml", page.path);
        let data = page.data.clone();
        self.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":template,"viewport":{"width":375,"height":667},
                "data":data,"blobs":self.blobs}),
        );
    }

    fn trace(&mut self) -> Value {
        self.call("trace", json!([]))["trace"].clone()
    }

    fn render_error(&mut self) -> Value {
        let page = self.session.app_service().pages().current().unwrap();
        let template = format!("template:{}.wxml", page.path);
        let data = page.data.clone();
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("relations-{}", self.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":template,"viewport":{"width":375,"height":667},
                "data":data,"blobs":self.blobs}),
        ));
        assert_eq!(
            batch.messages[0].payload["ok"], false,
            "{:?}",
            batch.messages
        );
        batch.messages[0].payload["error"].clone()
    }

    fn rendered_children(&self) -> Vec<String> {
        self.rendered_texts(".child-value")
    }

    fn rendered_texts(&self, selector: &str) -> Vec<String> {
        self.session
            .renderer()
            .last_frame()
            .unwrap()
            .query(selector, true)
            .unwrap()
            .into_iter()
            .map(node_text)
            .collect()
    }
}

fn node_text(node: &RenderNode) -> String {
    let mut result = node.text.clone().unwrap_or_default();
    for child in &node.children {
        result.push_str(&node_text(child));
    }
    result
}

fn target_names(graph: &Value) -> Vec<&str> {
    graph["targets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|target| target["name"].as_str().unwrap())
        .collect()
}

fn augment_relation_hook(source: &str, role: &str, event: &str, extra: &str) -> String {
    let key = if role == "parent" {
        PARENT_KEY
    } else {
        CHILD_KEY
    };
    let needle = format!("getApp().record('{role}','{event}',this.getRelationNodes('{key}'));");
    assert!(source.contains(&needle));
    source.replacen(&needle, &format!("{needle} {extra}"), 1)
}

#[test]
fn saved_3173_oracle_relation_trace_matches_initial_removal_and_restoration() {
    // Official evidence: docs/devtools-evidence/
    // 2026-10-19-component-instance-apis-3173. Only this lifecycle sequence
    // and projected ancestor/descendant scenario have a saved real oracle.
    for engine in engines() {
        let mut fixture = Fixture::start(
            engine,
            Sources::with_relations(Some("descendant"), Some("ancestor")),
        );
        assert_eq!(fixture.trace(), json!(INITIAL_TRACE), "{engine:?}");
        assert_eq!(fixture.rendered_children(), ["child:0"]);
        fixture.render();
        fixture.render();
        assert_eq!(fixture.trace(), json!(INITIAL_TRACE), "{engine:?}");

        fixture.call("setVisible", json!([false]));
        fixture.render();
        let mut expected = INITIAL_TRACE.to_vec();
        expected.extend([
            "child:detached:parent",
            "parent:unlinked:none",
            "child:unlinked:none",
        ]);
        assert_eq!(fixture.trace(), json!(expected), "{engine:?}");
        assert!(fixture.rendered_children().is_empty());
        assert_eq!(fixture.call("graph", json!([]))["targets"], json!([]));

        fixture.call("setVisible", json!([true]));
        fixture.render();
        expected.extend([
            "child:attached:none",
            "parent:linked:child",
            "child:linked:parent",
            "child:ready:parent",
        ]);
        assert_eq!(fixture.trace(), json!(expected), "{engine:?}");
        assert_eq!(fixture.rendered_children(), ["child:0"]);
        fixture.render();
        assert_eq!(fixture.trace(), json!(expected), "{engine:?}");
    }
}

#[test]
fn local_relation_nodes_are_live_instances_and_return_independent_arrays() {
    for engine in engines() {
        let mut fixture = Fixture::start(
            engine,
            Sources::with_relations(Some("descendant"), Some("ancestor")),
        );
        let initial = fixture.call("graph", json!([]));
        assert_eq!(initial["firstIsSelected"], true, "{engine:?}");
        assert_eq!(initial["children"][0]["sameParent"], true);
        assert_eq!(initial["children"][0]["parents"][0], initial["parent"]);
        assert_eq!(initial["targets"][0], initial["children"][0]["instance"]);
        assert_eq!(
            fixture.call("mutateReturnedArray", json!([])),
            json!({"count":1,"same":true})
        );
        let invoked = fixture.call("invokeRelated", json!([7]));
        assert_eq!(invoked["same"], true);
        assert_eq!(invoked["value"], 7);
        assert_eq!(invoked["child"]["serial"], initial["targets"][0]["serial"]);
        fixture.render();
        assert_eq!(fixture.rendered_children(), ["child:7"]);
        assert_eq!(fixture.trace(), json!(INITIAL_TRACE));
    }
}

#[test]
fn local_relations_are_isolated_per_page_and_disposal_clears_held_edges() {
    for engine in engines() {
        let mut fixture = Fixture::start(
            engine,
            Sources::with_relations(Some("descendant"), Some("ancestor")),
        );
        let first = fixture.call("holdCurrent", json!([]));
        fixture.dispatch(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
        fixture.render();
        let second = fixture.call("holdCurrent", json!([]));
        assert_ne!(first["page"], second["page"], "{engine:?}");
        assert_ne!(first["parent"]["serial"], second["parent"]["serial"]);
        assert_ne!(first["child"]["serial"], second["child"]["serial"]);
        for held in [&first, &second] {
            let state = fixture.call("held", json!([held["index"]]));
            assert_eq!(state["sameChild"], true, "{engine:?}");
            assert_eq!(state["sameParent"], true);
            assert_eq!(state["parentTargets"], json!([held["child"]]));
            assert_eq!(state["childTargets"], json!([held["parent"]]));
        }

        fixture.dispatch(op::PAGE_POP, json!({}));
        fixture.render();
        let disposed = fixture.call("held", json!([second["index"]]));
        assert_eq!(disposed["parentTargets"], json!([]), "{engine:?}");
        assert_eq!(disposed["childTargets"], json!([]));
        assert_eq!(disposed["parent"]["active"], false);
        assert_eq!(disposed["child"]["active"], false);
        let retained = fixture.call("held", json!([first["index"]]));
        assert_eq!(retained["sameChild"], true);
        assert_eq!(retained["sameParent"], true);

        fixture.dispatch(op::PAGE_REPLACE, json!({"path":"pages/empty/index"}));
        fixture.render();
        for held in [&first, &second] {
            let state = fixture.call("held", json!([held["index"]]));
            assert_eq!(state["parentTargets"], json!([]), "{engine:?}");
            assert_eq!(state["childTargets"], json!([]));
            assert_eq!(state["parent"]["active"], false);
            assert_eq!(state["child"]["active"], false);
        }
    }
}

#[test]
fn local_paths_resolve_reciprocally_and_direct_relations_stop_at_intervening_components() {
    for engine in engines() {
        for (parent_type, child_type, expected) in [
            ("child", "parent", vec!["direct"]),
            ("descendant", "ancestor", vec!["direct", "nested"]),
        ] {
            let parent_key = "../child/./index";
            let child_key = "/components/parent/index";
            let mut sources = Sources::with_relations(Some(parent_type), Some(child_type));
            sources.app = sources
                .app
                .replace(PARENT_KEY, parent_key)
                .replace(CHILD_KEY, child_key);
            sources.parent = component_source("parent", parent_key, Some(parent_type), None, None);
            sources.child = component_source("child", child_key, Some(child_type), None, None);
            sources.page_wxml = NESTED_WXML.into();
            let mut fixture = Fixture::start(engine, sources);
            let graph = fixture.call("graph", json!([]));
            assert_eq!(target_names(&graph), expected, "{engine:?} {parent_type}");
            assert_eq!(graph["children"][0]["sameParent"], true);
            assert_eq!(
                graph["children"][1]["sameParent"],
                child_type == "ancestor",
                "{engine:?} {child_type}"
            );
        }
    }
}

#[test]
fn local_one_sided_and_incompatible_relation_declarations_do_not_link() {
    for engine in engines() {
        for (parent_type, child_type) in [
            (Some("descendant"), None),
            (None, Some("ancestor")),
            (Some("child"), Some("ancestor")),
        ] {
            let mut fixture =
                Fixture::start(engine, Sources::with_relations(parent_type, child_type));
            let graph = fixture.call("graph", json!([]));
            assert_eq!(graph["targets"], json!([]), "{engine:?}");
            assert_eq!(graph["children"][0]["parents"], json!([]));
            assert!(fixture
                .trace()
                .as_array()
                .unwrap()
                .iter()
                .all(|event| !event.as_str().unwrap().contains(":linked:")));
        }
    }
}

#[test]
fn local_behavior_targets_and_has_behavior_use_transitive_identifier_identity() {
    for engine in engines() {
        let parent_key = "behavior-child";
        let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
        sources.app = sources.app.replace(PARENT_KEY, parent_key);
        sources.app.push_str(
            "\ngetApp().baseBehavior=Behavior({});\n\
             getApp().nestedBehavior=Behavior({behaviors:[getApp().baseBehavior]});\n\
             getApp().otherBehavior=Behavior({});\n",
        );
        sources.parent = component_source(
            "parent",
            parent_key,
            Some("descendant"),
            Some("getApp().baseBehavior"),
            None,
        );
        sources.child = component_source(
            "child",
            CHILD_KEY,
            Some("ancestor"),
            None,
            Some("getApp().nestedBehavior"),
        );
        sources.other = component_source(
            "child",
            CHILD_KEY,
            Some("ancestor"),
            None,
            Some("getApp().otherBehavior"),
        );
        sources.page_wxml = r#"<relation-parent id="relation-parent"><view><relation-child id="relation-child" class="relation-child" name="matched"/><relation-other id="other-child" name="unmatched"/></view></relation-parent>"#.into();
        let mut fixture = Fixture::start(engine, sources);
        let state = fixture.call("behaviors", json!([]));
        assert_eq!(state["identifierType"], "string", "{engine:?}");
        assert_eq!(state["direct"], true);
        assert_eq!(state["transitive"], true);
        assert_eq!(state["different"], false);
        assert_eq!(state["otherOwn"], true);
        assert_eq!(state["otherBase"], false);
        assert_eq!(state["same"], true);
        assert_eq!(target_names(&state), ["matched"]);
    }
}

#[test]
fn local_linked_set_data_can_create_or_remove_components_before_the_frame_commits() {
    for engine in engines() {
        for (initial_inside, next_inside, child_count) in [(false, true, 2), (true, false, 1)] {
            let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
            sources.parent = sources.parent.replace(
                "data:{label:'parent',count:0}",
                &format!("data:{{label:'parent',count:0,inside:{initial_inside}}}"),
            );
            sources.parent = augment_relation_hook(
                &sources.parent,
                "parent",
                "linked",
                &format!("this.setData({{inside:{next_inside},count:this.data.count+1}});"),
            );
            sources.parent_wxml = r#"<view><text class="parent-value">{{label}}:{{count}}</text><relation-child wx:if="{{inside}}" id="inside-child" name="inside"/><slot/></view>"#.into();
            let mut fixture = Fixture::start(engine, sources);
            let graph = fixture.call("graph", json!([]));
            assert_eq!(
                graph["targets"].as_array().unwrap().len(),
                child_count,
                "{engine:?}"
            );
            assert_eq!(fixture.rendered_children().len(), child_count);
            // Both the original and the hook-created/transient edge invoke
            // linked exactly once. Their setData effects belong to this frame.
            assert_eq!(fixture.rendered_texts(".parent-value"), ["parent:2"]);
            let trace = fixture.trace();
            if !next_inside {
                assert_eq!(
                    trace
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter(|event| **event == json!("child:detached:parent"))
                        .count(),
                    1,
                    "{engine:?}: the child removed by linked must be disposed once"
                );
                assert_eq!(target_names(&graph), ["child"]);
            }
            fixture.render();
            fixture.render();
            assert_eq!(fixture.trace(), trace, "{engine:?}");
            assert_eq!(fixture.rendered_texts(".parent-value"), ["parent:2"]);
        }
    }
}

#[test]
fn local_unlinked_set_data_on_a_surviving_parent_is_in_the_same_frame() {
    for engine in engines() {
        let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
        sources.parent = augment_relation_hook(
            &sources.parent,
            "parent",
            "unlinked",
            "this.setData({count:this.data.count+1});",
        );
        let mut fixture = Fixture::start(engine, sources);
        let held = fixture.call("holdCurrent", json!([]));
        fixture.call("setVisible", json!([false]));
        fixture.render();
        assert!(fixture.rendered_children().is_empty());
        assert_eq!(
            fixture.rendered_texts(".parent-value"),
            ["parent:1"],
            "{engine:?}"
        );
        let state = fixture.call("held", json!([held["index"]]));
        assert_eq!(state["parentTargets"], json!([]));
        assert_eq!(state["childTargets"], json!([]));
        assert_eq!(state["parent"]["active"], true);
        assert_eq!(state["child"]["active"], false);
        let trace = fixture.trace();
        fixture.render();
        assert_eq!(fixture.trace(), trace);
        assert_eq!(fixture.rendered_texts(".parent-value"), ["parent:1"]);
    }
}

#[test]
fn local_hook_driven_invalid_frontier_preserves_err_render_and_the_latest_live_topology() {
    for engine in engines() {
        let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
        sources.parent = sources.parent.replace(
            "data:{label:'parent',count:0}",
            "data:{label:'parent',count:0,badRows:[]}",
        );
        sources.parent = augment_relation_hook(
            &sources.parent,
            "parent",
            "unlinked",
            "this.setData({count:this.data.count+1,badRows:[{id:'same'},{id:'same'}]});",
        );
        sources.parent_wxml = r#"<view><text class="parent-value">{{label}}:{{count}}</text><view wx:for="{{badRows}}" wx:key="id" bindtap="bump"/><slot/></view>"#.into();
        sources.app.push_str(
            r#"
exports.repairParent=function() {
  currentPage().selectComponent('#relation-parent').setData({badRows:[]}); return {};
};
"#,
        );
        let mut fixture = Fixture::start(engine, sources);
        let held = fixture.call("holdCurrent", json!([]));
        let frame_id = fixture.session.renderer().last_frame().unwrap().frame_id;
        fixture.call("setVisible", json!([false]));
        for _ in 0..2 {
            let error = fixture.render_error();
            assert_eq!(error["code"], "ERR_RENDER", "{engine:?}: {error}");
            let message = error["message"].as_str().unwrap();
            assert!(
                message.contains("duplicate keyed event identity"),
                "{engine:?}: {error}"
            );
            assert!(!message.contains("unavailable"), "{engine:?}: {error}");
            assert_eq!(
                fixture.session.renderer().last_frame().unwrap().frame_id,
                frame_id
            );
            // detached/unlinked cannot be rolled back. Recovery must not
            // resurrect the old child or hide ERR_RENDER behind its dead scope.
            let state = fixture.call("held", json!([held["index"]]));
            assert_eq!(state["parentTargets"], json!([]));
            assert_eq!(state["childTargets"], json!([]));
            assert_eq!(state["parent"]["active"], true);
            assert_eq!(state["parent"]["count"], 1);
            assert_eq!(state["child"]["active"], false);
        }
        fixture.call("repairParent", json!([]));
        fixture.render();
        assert!(fixture.rendered_children().is_empty());
        assert_eq!(fixture.rendered_texts(".parent-value"), ["parent:1"]);
        assert_eq!(
            fixture
                .trace()
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| **event == json!("child:detached:parent"))
                .count(),
            1,
            "{engine:?}: repairing the frontier must not detach the old child twice"
        );
    }
}

#[test]
fn local_behavior_diamond_deduplicates_hooks_and_keeps_fresh_identifiers_distinct() {
    for engine in engines() {
        let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
        sources.app.push_str(
            r#"
getApp().behaviorTrace=[];
function behaviorOptions(name,behaviors) {
  return {behaviors:behaviors||[],lifetimes:{
    created:function() { getApp().behaviorTrace.push(name+':created'); },
    attached:function() { getApp().behaviorTrace.push(name+':attached'); },
    ready:function() { getApp().behaviorTrace.push(name+':ready'); },
    detached:function() { getApp().behaviorTrace.push(name+':detached'); }
  }};
}
const sharedOptions=behaviorOptions('base');
getApp().diamondBase=Behavior(sharedOptions);
getApp().freshSameShape=Behavior(sharedOptions);
getApp().diamondLeft=Behavior(behaviorOptions('left',[getApp().diamondBase]));
getApp().diamondRight=Behavior(behaviorOptions('right',[getApp().diamondBase]));
getApp().diamond=Behavior(behaviorOptions('diamond',[getApp().diamondLeft,getApp().diamondRight]));
exports.diamond=function() {
  const child=getApp().diamondChild;
  return {trace:getApp().behaviorTrace.slice(),base:child.hasBehavior(getApp().diamondBase),
    left:child.hasBehavior(getApp().diamondLeft),right:child.hasBehavior(getApp().diamondRight),
    own:child.hasBehavior(getApp().diamond),fresh:child.hasBehavior(getApp().freshSameShape),
    freshIdentifier:getApp().freshSameShape!==getApp().diamondBase};
};
"#,
        );
        sources.child = component_source(
            "child",
            CHILD_KEY,
            Some("ancestor"),
            None,
            Some("getApp().diamond"),
        )
        .replace(
            "this.fixtureSerial=++getApp().serial;",
            "this.fixtureSerial=++getApp().serial; getApp().behaviorTrace.push('component:created'); getApp().diamondChild=this;",
        )
        .replace(
            "this.fixtureActive=true;",
            "this.fixtureActive=true; getApp().behaviorTrace.push('component:attached');",
        )
        .replace(
            "ready:function() {",
            "ready:function() { getApp().behaviorTrace.push('component:ready');",
        )
        .replace(
            "detached:function() {",
            "detached:function() { getApp().behaviorTrace.push('component:detached');",
        );
        let mut fixture = Fixture::start(engine, sources);
        let mut expected = Vec::new();
        for phase in ["created", "attached", "ready"] {
            for role in ["base", "left", "right", "diamond", "component"] {
                expected.push(format!("{role}:{phase}"));
            }
        }
        let state = fixture.call("diamond", json!([]));
        assert_eq!(state["trace"], json!(expected), "{engine:?}");
        for field in ["base", "left", "right", "own", "freshIdentifier"] {
            assert_eq!(state[field], true, "{engine:?} {field}");
        }
        assert_eq!(state["fresh"], false);
        fixture.render();
        assert_eq!(fixture.call("diamond", json!([]))["trace"], json!(expected));
        fixture.call("setVisible", json!([false]));
        fixture.render();
        for role in ["base", "left", "right", "diamond", "component"] {
            expected.push(format!("{role}:detached"));
        }
        assert_eq!(
            fixture.call("diamond", json!([]))["trace"],
            json!(expected),
            "{engine:?}"
        );
        fixture.render();
        assert_eq!(fixture.call("diamond", json!([]))["trace"], json!(expected));
    }
}

#[test]
fn local_link_changed_declaration_fails_explicitly_without_move_metadata() {
    for engine in engines() {
        let mut sources = Sources::with_relations(Some("descendant"), Some("ancestor"));
        sources.app.push_str(
            r#"
exports.probeLinkChanged=function() {
  try {
    Component({relations:{'../child/index':{type:'descendant',linkChanged:function() {}}}});
    return {accepted:true};
  } catch(error) { return {accepted:false,code:error.code,message:error.message||error.errMsg}; }
};
"#,
        );
        let mut fixture = Fixture::start(engine, sources);
        let trace = fixture.trace();
        let result = fixture.call("probeLinkChanged", json!([]));
        assert_eq!(result["accepted"], false, "{engine:?}");
        assert_eq!(result["code"], "ERR_UNSUPPORTED_CAPABILITY");
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("move metadata"));
        fixture.render();
        assert_eq!(fixture.trace(), trace);
        assert_eq!(fixture.call("graph", json!([]))["firstIsSelected"], true);
    }
}

#[test]
fn local_explicitly_disabled_instance_capabilities_return_structured_errors() {
    for engine in engines() {
        for method in ["getRelationNodes", "hasBehavior"] {
            let mut sources = Sources::with_relations(None, None);
            // These ordinary definitions have no relation-reading hooks, so
            // the explicit capability boundary is probed on a live instance.
            sources.parent = "Component({});".into();
            sources.child = "Component({});".into();
            sources
                .disabled_capabilities
                .push(format!("Component.{method}"));
            sources.app.push_str(r#"
exports.probeCapability=function(method) {
  const instance=currentPage().selectComponent('#relation-parent');
  try { instance[method]('missing'); return {accepted:true}; }
  catch(error) { return {accepted:false,code:error.code,api:error.api,canUse:wx.canIUse('Component.'+method)}; }
};
"#);
            let mut fixture = Fixture::start(engine, sources);
            let result = fixture.call("probeCapability", json!([method]));
            assert_eq!(result["accepted"], false, "{engine:?} {method}");
            assert_eq!(result["code"], "ERR_UNSUPPORTED_CAPABILITY");
            assert_eq!(result["api"], format!("Component.{method}"));
            assert_eq!(result["canUse"], false);
        }
    }
}
