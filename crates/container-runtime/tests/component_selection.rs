//! Component selection exercised through ordinary Page/Component APIs and the
//! public Session bridge. No test supplies component graph records to an engine.
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
const APP_JS: &str = r#"
App({serial:0,pageSerial:0,pages:[],held:null,components:[],detached:[]});
function describe(component) {
  return component == null ? null : {
    serial:component.fixtureSerial, label:component.properties.label,
    count:component.data.count, active:component.fixtureActive
  };
}
function currentPage() { const pages=getCurrentPages(); return pages[pages.length-1]; }
function recordedPage(serial) { return getApp().pages.find(function(page) { return page.fixturePageSerial===serial; }); }
Page({
  data:{visible:true,broken:false,nativeFirst:false,maskInput:false,hideOnAttach:false,rows:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]},
  onLoad:function() { this.fixturePageSerial=++getApp().pageSerial; getApp().pages.push(this); },
  onReady:function() { this.fixtureReadySelection=this.selectComponent('#duplicate'); }
});
exports.pageSerial=function() { return currentPage().fixturePageSerial; };
exports.readySelection=function() { const page=currentPage(); return {first:describe(page.fixtureReadySelection),same:page.fixtureReadySelection===page.selectComponent('#duplicate')}; };
exports.select=function(selector) { return describe(currentPage().selectComponent(selector)); };
exports.selectAll=function(selector) { return currentPage().selectAllComponents(selector).map(describe); };
exports.selectOnPage=function(serial,selector) { return recordedPage(serial).selectAllComponents(selector).map(describe); };
exports.sameInstance=function(selector) { const page=currentPage(); return page.selectComponent(selector)===page.selectAllComponents(selector)[0]; };
exports.mutateFirst=function(selector,count) {
  const component=currentPage().selectComponent(selector); component.setData({count:count}); return describe(component);
};
exports.invokeAll=function(selector,amount) { return currentPage().selectAllComponents(selector).map(function(component) { return component.bump(amount); }); };
exports.panelSelection=function() { return currentPage().selectComponent('#panel').inspectSelection(); };
exports.panelFirst=function(selector) { return describe(currentPage().selectComponent('#panel').selectComponent(selector)); };
exports.panelAllSummary=function(selector) { return {matches:currentPage().selectComponent('#panel').selectAllComponents(selector).map(describe)}; };
exports.maskPanel=function(maskInput) { currentPage().setData({maskInput:maskInput}); };
exports.slotOwnership=function() {
  const page=currentPage(); const panel=page.selectComponent('#panel');
  const projected=page.selectComponent('#projected');
  return {projected:describe(projected),ownerIsPhysicalParent:projected.selectOwnerComponent()===panel,
    pageSeesPrivate:page.selectComponent('#inner')!==null,
    panelSeesProjected:panel.selectComponent('#projected')!==null};
};
exports.replaceRows=function(rows) { currentPage().setData({rows:rows}); };
exports.setVisible=function(visible) { currentPage().setData({visible:visible}); };
exports.setNativeFirst=function(nativeFirst) { currentPage().setData({nativeFirst:nativeFirst}); };
exports.rejectFrontier=function() { currentPage().setData({rows:[{id:'b',label:'Beta'}],broken:true}); };
exports.holdFirst=function() { getApp().held=currentPage().selectComponent('#duplicate'); return describe(getApp().held); };
exports.heldIsSelected=function() { return getApp().held===currentPage().selectComponent('#duplicate'); };
exports.mutateHeld=function(count) { getApp().held.setData({count:count}); return describe(getApp().held); };
// Read-only resource accounting. Public navigation/render operations remain
// responsible for creating and releasing every engine registry entry.
exports.selectionPageKeys=function() { return {keys:Object.keys(globalThis.__container_component_selection_pages)}; };
exports.transientChildren=function() {
  return {children:getApp().components.filter(function(component) { return component.properties.label==='Private'; })
    .map(function(component) { return {instance:describe(component),ownerPresent:component.selectOwnerComponent()!==null}; }),
    detached:getApp().detached};
};
"#;

const LEAF_JS: &str = r#"
Component({
  properties:{label:{type:String,value:''}},data:{count:0},
  lifetimes:{
    created:function() { this.fixtureSerial=++getApp().serial; this.fixtureActive=false; getApp().components.push(this); },
    attached:function() { this.fixtureActive=true; },
    detached:function() { this.fixtureActive=false; getApp().detached.push(this.fixtureSerial); }
  },
  methods:{bump:function(amount) { this.setData({count:this.data.count+amount}); return this.data.count; }}
});
"#;

const PANEL_JS: &str = r#"
Component({
  options:{multipleSlots:true},
  properties:{maskInput:{type:Boolean,value:false,observer:function(value) { this.setData({mask:value}); }},
    hideOnAttach:{type:Boolean,value:false}},
  data:{mask:false,showInner:true},
  lifetimes:{
    attached:function() { if (this.properties.hideOnAttach) this.setData({showInner:false}); },
    ready:function() { this.fixtureReadySelection=this.selectComponent('#inner'); }
  },
  methods:{
    inspectSelection:function() {
      const inner=this.selectComponent('#inner');
      const all=this.selectAllComponents('.inside');
      return {inner:{serial:inner.fixtureSerial,label:inner.properties.label,count:inner.data.count},
        count:all.length,sameInstance:inner===all[0],ownerIsPanel:inner.selectOwnerComponent()===this,
        sameAtReady:inner===this.fixtureReadySelection,
        absent:this.selectComponent('.absent'),absentAll:this.selectAllComponents('.absent'),
        privateDoesNotCross:inner.selectComponent('#inner')===null,
        countSelector:this.selectAllComponents('.inner-wrap > .inside').length};
    }
  }
});
"#;

const PAGE_WXML: &str = r#"<view id="page-root"><view class="list"><block id="duplicate" class="block-only direct item"><view wx:if="{{nativeFirst}}" id="duplicate" class="direct item"/><leaf wx:for="{{rows}}" wx:key="id" id="duplicate" class="direct item" label="{{item.label}}"/></block><view id="ordinary" class="direct item"/></view><panel wx:if="{{visible}}" id="panel" class="panel" mask-input="{{maskInput}}" hide-on-attach="{{hideOnAttach}}"><leaf id="projected" class="projected" slot="content" label="Projected"/></panel><broken wx:if="{{broken}}" id="broken"/></view>"#;
const PANEL_WXML: &str = r#"<view class="inner-wrap"><view id="{{mask ? 'inner' : 'native-other'}}" class="{{mask ? 'inside' : 'native-other'}}"/><leaf wx:if="{{showInner}}" id="inner" class="inside" label="Private"/></view><slot name="content"/>"#;
const LEAF_WXML: &str = r#"<text class="leaf-value">{{label}}:{{count}}</text>"#;

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
    engine: EngineKind,
}

impl Fixture {
    fn start(engine: EngineKind) -> Self {
        Self::start_with_source(engine, APP_JS)
    }

    fn start_with_source(engine: EngineKind, app_source: &str) -> Self {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "component-selection-fixture".into(),
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
        ] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Partial);
        }
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: Some("pages/index/index.json".into()),
            entry_module: APP_MODULE.into(),
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            (APP_MODULE, app_source, ModuleScope::App),
            (
                "module:components/leaf/index.js",
                LEAF_JS,
                ModuleScope::Component,
            ),
            (
                "module:components/panel/index.js",
                PANEL_JS,
                ModuleScope::Component,
            ),
            (
                "module:components/broken/index.js",
                "Component({});",
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
            (PAGE_TEMPLATE, PAGE_WXML),
            ("template:components/leaf/index.wxml", LEAF_WXML),
            ("template:components/panel/index.wxml", PANEL_WXML),
            ("template:components/broken/index.wxml", "<missing/>"),
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
        manifest.components.extend([
            Component {
                id: "components:pages/index/index.json".into(),
                owner: "pages/index/index.json".into(),
                using_components: BTreeMap::from([
                    ("leaf".into(), "components/leaf/index".into()),
                    ("panel".into(), "components/panel/index".into()),
                    ("broken".into(), "components/broken/index".into()),
                ]),
                multiple_slots: None,
            },
            Component {
                id: "components:components/panel/index.json".into(),
                owner: "components/panel/index.json".into(),
                using_components: BTreeMap::from([("leaf".into(), "components/leaf/index".into())]),
                multiple_slots: Some(true),
            },
            Component {
                id: "components:components/leaf/index.json".into(),
                owner: "components/leaf/index.json".into(),
                using_components: BTreeMap::new(),
                multiple_slots: None,
            },
            Component {
                id: "components:components/broken/index.json".into(),
                owner: "components/broken/index.json".into(),
                using_components: BTreeMap::from([(
                    "missing".into(),
                    "components/unavailable/index".into(),
                )]),
                multiple_slots: None,
            },
        ]);
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
        fixture.push();
        fixture.render();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("selection-{}", self.sequence),
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
        let result = self.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":export,"args":args}),
        )["result"]
            .clone();
        // JsEngine returns array exports directly as a ValueBatch, while a
        // scalar/object export occupies one result entry.
        match export {
            "selectAll" | "selectOnPage" | "invokeAll" => result,
            _ => result[0].clone(),
        }
    }

    fn push(&mut self) {
        self.dispatch(op::PAGE_PUSH, json!({"path":"pages/index/index"}));
    }

    fn render(&mut self) {
        let data = self
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        self.dispatch(
            op::RENDER_COMMIT,
            json!({"templateId":PAGE_TEMPLATE,"viewport":{"width":375,"height":667},
                "data":data,"blobs":self.blobs}),
        );
    }

    fn render_error(&mut self) -> Value {
        let data = self
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        self.sequence += 1;
        let rejected = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("selection-{}", self.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":PAGE_TEMPLATE,"viewport":{"width":375,"height":667},
                "data":data,"blobs":self.blobs}),
        ));
        assert_eq!(rejected.messages[0].payload["ok"], false);
        rejected.messages[0].payload["error"].clone()
    }

    fn values(&self) -> Vec<String> {
        self.session
            .renderer()
            .last_frame()
            .unwrap()
            .query(".leaf-value", true)
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

fn serials(value: &Value) -> Vec<Value> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["serial"].clone())
        .collect()
}

#[test]
fn page_selection_returns_live_components_and_filters_ordinary_elements() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let first = fixture.call("select", json!(["#duplicate"]));
        let all = fixture.call("selectAll", json!(["#duplicate"]));
        assert_eq!(all.as_array().unwrap().len(), 2, "{engine:?}");
        assert_eq!(first, all[0]);
        assert_eq!(first["label"], "Alpha");
        assert_eq!(all[1]["label"], "Beta");
        let ready = fixture.call("readySelection", json!([]));
        assert_eq!(ready["first"], first);
        assert_eq!(ready["same"], true);
        assert_eq!(fixture.call("sameInstance", json!(["#duplicate"])), true);
        assert_eq!(fixture.call("select", json!(["#ordinary"])), Value::Null);
        assert_eq!(fixture.call("selectAll", json!(["#ordinary"])), json!([]));
        assert_eq!(fixture.call("select", json!([".missing"])), Value::Null);
        assert_eq!(fixture.call("selectAll", json!([".missing"])), json!([]));

        fixture.call("mutateFirst", json!(["#duplicate", 7]));
        fixture.render();
        assert_eq!(
            fixture.values(),
            ["Alpha:7", "Beta:0", "Private:0", "Projected:0"]
        );
        assert_eq!(
            fixture.call("invokeAll", json!([".direct.item", 2])),
            json!([9, 2])
        );
        fixture.render();
        assert_eq!(
            fixture.values(),
            ["Alpha:9", "Beta:2", "Private:0", "Projected:0"]
        );
    }
}

#[test]
fn selection_uses_declaring_component_scope_and_real_nested_owner_instances() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let result = fixture.call("panelSelection", json!([]));
        assert_eq!(result["inner"]["label"], "Private", "{engine:?}");
        assert_eq!(result["count"], 1);
        assert_eq!(result["sameInstance"], true);
        assert_eq!(result["sameAtReady"], true);
        assert_eq!(result["ownerIsPanel"], true);
        assert_eq!(result["absent"], Value::Null);
        assert_eq!(result["absentAll"], json!([]));
        assert_eq!(result["privateDoesNotCross"], true);
        assert_eq!(result["countSelector"], 1);
        assert_eq!(fixture.call("select", json!(["#inner"])), Value::Null);
    }
}

#[test]
fn projected_components_keep_their_declaration_scope_instead_of_the_physical_parent() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let result = fixture.call("slotOwnership", json!([]));
        assert_eq!(result["projected"]["label"], "Projected", "{engine:?}");
        assert_eq!(result["ownerIsPhysicalParent"], false);
        assert_eq!(result["pageSeesPrivate"], false);
        assert_eq!(result["panelSeesProjected"], false);
        fixture.call("mutateFirst", json!(["#projected", 4]));
        fixture.render();
        assert_eq!(
            fixture.values(),
            ["Alpha:0", "Beta:0", "Private:0", "Projected:4"]
        );
    }
}

#[test]
fn selector_ancestry_matches_views_in_the_same_scope_without_crossing_component_internals() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let expected = fixture.call("selectAll", json!(["#duplicate"]));
        for selector in [
            ".list .direct",
            ".list > .direct",
            "#page-root .list > .item",
        ] {
            assert_eq!(
                fixture.call("selectAll", json!([selector])),
                expected,
                "{engine:?} {selector}"
            );
        }
        assert_eq!(
            fixture.call("selectAll", json!(["#panel .inside"])),
            json!([])
        );
        assert_eq!(
            fixture.call("selectAll", json!([".list > .projected"])),
            json!([])
        );
    }
}

#[test]
fn repeated_ids_follow_current_tree_order_after_keyed_reorder_without_replacing_instances() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let initial = fixture.call("selectAll", json!(["#duplicate"]));
        fixture.call("mutateFirst", json!(["#duplicate", 6]));
        fixture.call(
            "replaceRows",
            json!([[{"id":"b","label":"Beta"},{"id":"a","label":"Alpha"}]]),
        );
        fixture.render();
        let reordered = fixture.call("selectAll", json!(["#duplicate"]));
        assert_eq!(
            serials(&reordered),
            [initial[1]["serial"].clone(), initial[0]["serial"].clone()],
            "{engine:?}"
        );
        assert_eq!(reordered[0]["count"], 0);
        assert_eq!(reordered[1]["count"], 6);
        assert_eq!(fixture.call("select", json!(["#duplicate"])), reordered[0]);
        assert_eq!(
            fixture.values(),
            ["Beta:0", "Alpha:6", "Private:0", "Projected:0"]
        );
    }
}

#[test]
fn selection_is_page_local_and_disposed_page_instances_stop_selecting_components() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let first_page = fixture.call("pageSerial", json!([]));
        fixture.call("mutateFirst", json!(["#duplicate", 5]));
        fixture.render();
        let first_components = fixture.call("selectAll", json!(["#duplicate"]));
        fixture.push();
        fixture.render();
        let second_page = fixture.call("pageSerial", json!([]));
        let second_components = fixture.call("selectAll", json!(["#duplicate"]));
        assert_ne!(first_page, second_page);
        assert!(serials(&first_components)
            .iter()
            .all(|serial| !serials(&second_components).contains(serial)));
        assert_eq!(
            fixture.call("selectOnPage", json!([first_page, "#duplicate"])),
            first_components,
            "{engine:?}"
        );
        assert_eq!(second_components[0]["count"], 0);
        fixture.dispatch(op::PAGE_POP, json!({"delta":1}));
        fixture.render();
        assert_eq!(fixture.call("pageSerial", json!([])), first_page);
        assert_eq!(
            fixture.call("selectAll", json!(["#duplicate"])),
            first_components
        );
        assert_eq!(
            fixture.call("selectOnPage", json!([second_page, "#duplicate"])),
            json!([])
        );
        assert_eq!(
            fixture.values(),
            ["Alpha:5", "Beta:0", "Private:0", "Projected:0"]
        );
    }
}

#[test]
fn removed_components_disappear_from_selection_and_reinserted_keys_get_new_instances() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let held = fixture.call("holdFirst", json!([]));
        fixture.call("replaceRows", json!([[{"id":"b","label":"Beta"}]]));
        fixture.render();
        let remaining = fixture.call("selectAll", json!(["#duplicate"]));
        assert_eq!(remaining.as_array().unwrap().len(), 1);
        assert_eq!(remaining[0]["label"], "Beta");
        assert_eq!(fixture.call("heldIsSelected", json!([])), false);
        let stale = fixture.call("mutateHeld", json!([99]));
        assert_eq!(stale["active"], false);
        fixture.render();
        assert_eq!(fixture.values(), ["Beta:0", "Private:0", "Projected:0"]);
        fixture.call(
            "replaceRows",
            json!([[{"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}]]),
        );
        fixture.render();
        let reinserted = fixture.call("selectAll", json!(["#duplicate"]));
        assert_ne!(reinserted[0]["serial"], held["serial"], "{engine:?}");
        assert_eq!(reinserted[0]["count"], 0);
        assert_eq!(reinserted[1]["serial"], remaining[0]["serial"]);
        fixture.call("setVisible", json!([false]));
        fixture.render();
        assert_eq!(fixture.call("select", json!(["#panel"])), Value::Null);
        assert_eq!(fixture.call("select", json!(["#projected"])), Value::Null);
    }
}

#[test]
fn rejected_new_frontier_keeps_the_committed_component_selection_index() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let initial = fixture.call("selectAll", json!(["#duplicate"]));
        let rendered = fixture.values();
        fixture.call("rejectFrontier", json!([]));
        let data = fixture
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        fixture.sequence += 1;
        let rejected = fixture.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("selection-{}", fixture.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":PAGE_TEMPLATE,"viewport":{"width":375,"height":667},
                "data":data,"blobs":fixture.blobs}),
        ));
        assert_eq!(rejected.messages[0].payload["ok"], false);
        assert_eq!(
            rejected.messages[0].payload["error"]["code"],
            "ERR_MODULE_LOAD"
        );
        assert_eq!(fixture.values(), rendered, "{engine:?}");
        assert_eq!(
            fixture.call("selectAll", json!(["#duplicate"])),
            initial,
            "{engine:?}: rejected rendering must not hide still-live committed instances"
        );
    }
}

#[test]
fn a_native_first_match_is_not_skipped_by_select_component_but_all_filters_native_nodes() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let initial = fixture.call("selectAll", json!(["#duplicate"]));
        fixture.call("setNativeFirst", json!([true]));
        fixture.render();
        for selector in ["#duplicate", ".direct.item", ".list > #duplicate"] {
            assert_eq!(
                fixture.call("select", json!([selector])),
                Value::Null,
                "{engine:?} {selector}: query the first node before filtering native elements"
            );
            assert_eq!(
                fixture.call("selectAll", json!([selector])),
                initial,
                "{engine:?} {selector}"
            );
        }
        fixture.call("setNativeFirst", json!([false]));
        fixture.render();
        assert_eq!(fixture.call("select", json!(["#duplicate"])), initial[0]);
    }
}

#[test]
fn structural_blocks_are_neither_selection_targets_nor_direct_child_ancestors() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let components = fixture.call("selectAll", json!(["#duplicate"]));
        assert_eq!(components.as_array().unwrap().len(), 2);
        assert_eq!(
            fixture.call("select", json!(["#duplicate"])),
            components[0],
            "{engine:?}: a matching structural block must not mask the first component"
        );
        assert_eq!(fixture.call("select", json!([".block-only"])), Value::Null);
        assert_eq!(
            fixture.call("selectAll", json!([".block-only > #duplicate"])),
            json!([])
        );
        assert_eq!(
            fixture.call("selectAll", json!([".list > #duplicate"])),
            components,
            "{engine:?}: structural block ancestors must not obstruct a direct-child selector"
        );
    }
}

#[test]
fn native_selector_changes_from_a_property_observer_publish_after_the_frontier_converges() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let initial = fixture.call("panelFirst", json!(["#inner"]));
        assert_eq!(initial["label"], "Private");
        fixture.call("maskPanel", json!([true]));
        fixture.render();
        let rendered = fixture
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query("#inner", true)
            .unwrap();
        assert_eq!(rendered.len(), 2, "{engine:?}");
        assert_eq!(rendered[0].tag.as_deref(), Some("view"));
        assert_eq!(rendered[1].tag.as_deref(), Some("leaf"));
        for selector in ["#inner", ".inside"] {
            assert_eq!(
                fixture.call("panelFirst", json!([selector])),
                Value::Null,
                "{engine:?} {selector}: the accepted native node must mask a later custom match"
            );
            assert_eq!(
                fixture.call("panelAllSummary", json!([selector]))["matches"],
                json!([initial]),
                "{engine:?} {selector}: the custom occurrence must remain live"
            );
        }
        fixture.call("maskPanel", json!([false]));
        fixture.render();
        assert_eq!(fixture.call("panelFirst", json!(["#inner"])), initial);
    }
}

#[test]
fn removing_the_last_custom_components_clears_selection_until_new_instances_are_added() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let initial = fixture.call("selectAll", json!(["#duplicate"]));
        fixture.call("replaceRows", json!([[]]));
        fixture.call("setVisible", json!([false]));
        fixture.render();
        assert_eq!(fixture.values(), Vec::<String>::new());
        for selector in ["#duplicate", "#panel", "#projected", ".direct"] {
            assert_eq!(fixture.call("select", json!([selector])), Value::Null);
            assert_eq!(fixture.call("selectAll", json!([selector])), json!([]));
        }
        fixture.call(
            "replaceRows",
            json!([[{"id":"a","label":"Alpha"},{"id":"b","label":"Beta"}]]),
        );
        fixture.call("setVisible", json!([true]));
        fixture.render();
        let restored = fixture.call("selectAll", json!(["#duplicate"]));
        assert_eq!(restored.as_array().unwrap().len(), 2);
        assert!(serials(&restored)
            .iter()
            .all(|serial| !serials(&initial).contains(serial)));
        assert_eq!(fixture.call("select", json!(["#duplicate"])), restored[0]);
        assert_eq!(
            fixture.values(),
            ["Alpha:0", "Beta:0", "Private:0", "Projected:0"],
            "{engine:?}"
        );
    }
}

#[test]
fn native_only_rollback_selection_indexes_are_released_when_the_page_is_replaced() {
    for engine in engines() {
        let source = APP_JS.replace("visible:true", "visible:false").replace(
            "rows:[{id:'a',label:'Alpha'},{id:'b',label:'Beta'}]",
            "rows:[]",
        );
        let mut fixture = Fixture::start_with_source(engine, &source);
        let page_id = fixture
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id
            .0
            .to_string();
        assert_eq!(
            fixture.call("selectionPageKeys", json!([]))["keys"],
            json!([])
        );
        fixture.call("rejectFrontier", json!([]));
        assert_eq!(fixture.render_error()["code"], "ERR_MODULE_LOAD");
        assert!(fixture.call("selectionPageKeys", json!([]))["keys"]
            .as_array()
            .unwrap()
            .contains(&json!(page_id)));
        fixture.dispatch(op::PAGE_REPLACE, json!({"path":"pages/index/index"}));
        fixture.render();
        let retained = fixture.call("selectionPageKeys", json!([]));
        assert!(
            !retained["keys"].as_array().unwrap().contains(&json!(page_id)),
            "{engine:?}: an unloaded page must release the native index created by rollback: {retained}"
        );
    }
}

#[test]
fn an_attached_hook_hiding_a_prepared_child_disposes_that_transient_occurrence() {
    for engine in engines() {
        let source = APP_JS.replace("hideOnAttach:false", "hideOnAttach:true");
        let mut fixture = Fixture::start_with_source(engine, &source);
        assert_eq!(fixture.values(), ["Alpha:0", "Beta:0", "Projected:0"]);
        let state = fixture.call("transientChildren", json!([]));
        let children = state["children"].as_array().unwrap();
        assert_eq!(children.len(), 1, "{engine:?}");
        let child = &children[0];
        assert_eq!(
            child["instance"]["active"], false,
            "{engine:?}: the transient child must receive detached before it is forgotten"
        );
        assert_eq!(child["ownerPresent"], false);
        assert_eq!(state["detached"], json!([child["instance"]["serial"]]));
        fixture.dispatch(op::PAGE_REPLACE, json!({"path":"pages/index/index"}));
        fixture.render();
        let detached = fixture.call("transientChildren", json!([]))["detached"].clone();
        assert_eq!(
            detached
                .as_array()
                .unwrap()
                .iter()
                .filter(|serial| **serial == child["instance"]["serial"])
                .count(),
            1,
            "{engine:?}: later navigation must not detach the transient child twice"
        );
    }
}
