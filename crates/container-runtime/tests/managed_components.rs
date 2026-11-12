//! Exercise the managed component graph through public bridge operations.
//! These fixtures use ordinary App/Page/Component definitions; they do not
//! call engine bootstrap helpers or manufacture component instance records.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, AppInfo, CapabilitySupport, CompilerInfo, Component,
    ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope,
    Template,
};
use container_render_skia::{RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const APP_MODULE: &str = "module:app.js";
const PAGE_TEMPLATE: &str = "template:pages/index/index.wxml";
const COMPONENT_MODULE: &str = "module:components/card/index.js";

const APP_JS: &str = r#"
App({
  log: [], saved: [], serial: 0, pageSerial: 0,
  onLaunch: function() { this.log.push({kind: 'app.launch'}); }
});
Page({
  data: {
    visible: true, pageLabel: 'parent', secret: 'parent-only',
    pageHits: 0, slotHits: 0, wrongPageTap: 0,
    rows: [
      {id: 'a', label: 'Alpha', values: [1, {nested: true}], flag: 'false', numeric: '123'},
      {id: 'b', label: 'Beta', values: [2, {nested: false}], flag: 'true', numeric: '0042'}
    ]
  },
  onLoad: function() {
    this.fixturePageId = ++getApp().pageSerial;
    getApp().log.push({kind: 'page.load', page: this.fixturePageId});
  },
  onReady: function() { getApp().log.push({kind: 'page.ready', page: this.fixturePageId}); },
  onUnload: function() { getApp().log.push({kind: 'page.unload', page: this.fixturePageId}); },
  onPage: function() { this.setData({pageHits: this.data.pageHits + 1}); },
  onSlot: function() { this.setData({slotHits: this.data.slotHits + 1}); },
  tap: function() { this.setData({wrongPageTap: this.data.wrongPageTap + 1}); }
});
function currentPage() {
  const pages = getCurrentPages();
  return pages[pages.length - 1];
}
exports.inspect = function() {
  return {
    trace: getApp().log,
    saved: getApp().saved.map(function(component) {
      return {
        id: component.fixtureId, active: component.fixtureActive === true,
        row: component.properties.row, values: component.properties.values,
        flag: component.properties.flag, numeric: component.properties.numeric,
        count: component.data.count, wrongSlot: component.data.wrongSlot
      };
    })
  };
};
exports.replaceRows = function(rows) { currentPage().setData({rows: rows}); };
exports.setVisible = function(visible) { currentPage().setData({visible: visible}); };
exports.patchSaved = function(ids, count) {
  ids.forEach(function(id) {
    const component = getApp().saved.find(function(candidate) { return candidate.fixtureId === id; });
    if (component) component.setData({count: count});
  });
};
"#;

const COMPONENT_JS: &str = r#"
Component({
  options: {multipleSlots: true},
  properties: {
    row: {type: Object, value: {}},
    values: {type: Array, value: []},
    flag: {type: String, value: ''},
    numeric: {type: String, value: ''}
  },
  data: {count: 0, wrongSlot: 0},
  lifetimes: {
    created: function() {
      this.fixtureId = ++getApp().serial;
      getApp().saved.push(this);
      getApp().log.push({kind: 'component.created', id: this.fixtureId});
    },
    attached: function() {
      this.fixtureActive = true;
      getApp().log.push({kind: 'component.attached', id: this.fixtureId});
    },
    ready: function() { getApp().log.push({kind: 'component.ready', id: this.fixtureId}); },
    detached: function() {
      this.fixtureActive = false;
      getApp().log.push({kind: 'component.detached', id: this.fixtureId});
    }
  },
  methods: {
    tap: function(event) {
      this.setData({count: this.data.count + 1});
      getApp().log.push({kind: 'component.tap', id: this.fixtureId,
        target: event.target.id, currentTarget: event.currentTarget.id});
    },
    onSlot: function() { this.setData({wrongSlot: this.data.wrongSlot + 1}); }
  }
});
"#;

const PAGE_WXML: &str = r#"<view id="page-root"><block wx:if="{{visible}}"><card wx:for="{{rows}}" wx:key="id" row="{{item}}" values="{{item.values}}" flag="{{item.flag}}" numeric="{{item.numeric}}"><text slot="content" class="slot-content" bindtap="onSlot">{{pageLabel}}:{{item.label}}</text></card></block><view id="page-button" bindtap="onPage">Page</view></view>"#;
const COMPONENT_WXML: &str = r#"<view class="card-body"><text class="label">{{row.label}}</text><text class="count">{{count}}</text><text class="private-value">{{secret}}</text><view id="shared-tap" class="component-tap" bindtap="tap"/><slot name="content"><text class="fallback">Fallback</text></slot></view>"#;

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
        Self::start_with(engine, |_, _, _| {})
    }

    fn start_with(
        engine: EngineKind,
        configure: impl FnOnce(
            &mut ContainerManifestV1,
            &mut BTreeMap<String, Vec<u8>>,
            &mut Vec<Value>,
        ),
    ) -> Self {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "managed-components-fixture".into(),
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
        manifest
            .capabilities
            .insert("wx.createSelectorQuery".into(), CapabilitySupport::Partial);
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: Some("pages/index/index.json".into()),
            entry_module: APP_MODULE.into(),
        });
        for (id, source, scope) in [
            (APP_MODULE, APP_JS, ModuleScope::App),
            (COMPONENT_MODULE, COMPONENT_JS, ModuleScope::Component),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
        }
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            (PAGE_TEMPLATE, PAGE_WXML),
            ("template:components/card/index.wxml", COMPONENT_WXML),
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
        let style = parse_wxss(".component-tap { width:120px; height:24px; }")
            .unwrap()
            .canonical_json()
            .unwrap();
        let style_pointer = format!("sha256:{}", hex_digest(&style));
        blobs.insert(style_pointer.clone(), style);
        manifest.styles.push(Style {
            id: "style:components/card/index.wxss".into(),
            wxss_ir: style_pointer,
            scope: StyleScope::Component,
        });
        manifest.components.extend([
            Component {
                id: "components:pages/index/index.json".into(),
                owner: "pages/index/index.json".into(),
                using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
                multiple_slots: None,
            },
            Component {
                id: "components:components/card/index.json".into(),
                owner: "components/card/index.json".into(),
                using_components: BTreeMap::new(),
                multiple_slots: Some(true),
            },
        ]);
        let mut modules = vec![
            json!({"id":APP_MODULE,"bytes":APP_JS.as_bytes()}),
            json!({"id":COMPONENT_MODULE,"bytes":COMPONENT_JS.as_bytes()}),
        ];
        configure(&mut manifest, &mut blobs, &mut modules);
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
            json!({
                "modules":modules,
                "blobs":fixture.blobs,
            }),
        );
        fixture.dispatch(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.push();
        fixture
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("managed-{}", self.sequence),
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

    fn inspect(&mut self) -> Value {
        self.call("inspect", json!([]))
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
            json!({
                "templateId":PAGE_TEMPLATE,
                "viewport":{"width":375,"height":667},
                "data":data,
                "blobs":self.blobs,
            }),
        );
    }

    fn tap(&mut self, target: &str) {
        self.dispatch(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","target":target}]}),
        );
    }

    fn cards(&self) -> Vec<Card> {
        self.session
            .renderer()
            .last_frame()
            .unwrap()
            .query("card", true)
            .unwrap()
            .into_iter()
            .map(|node| {
                let tap = find_class(node, "component-tap").expect("component listener");
                let slot = find_class(node, "slot-content").expect("projected parent slot");
                Card {
                    key: node.key.clone().expect("keyed custom component host"),
                    scope: node
                        .component_scope_id
                        .clone()
                        .expect("managed component scope"),
                    tap: tap.event_identity.as_ref().unwrap_or(&tap.id).clone(),
                    tap_owner: tap.event_owner_scope_id.clone(),
                    slot: slot.id.clone(),
                    slot_owner: slot.event_owner_scope_id.clone(),
                    label: text(find_class(node, "label").unwrap()),
                    count: text(find_class(node, "count").unwrap()),
                    slot_text: text(slot),
                    private_value: text(find_class(node, "private-value").unwrap()),
                }
            })
            .collect()
    }
}

#[derive(Debug)]
struct Card {
    key: String,
    scope: String,
    tap: String,
    tap_owner: Option<String>,
    slot: String,
    slot_owner: Option<String>,
    label: String,
    count: String,
    slot_text: String,
    private_value: String,
}

fn find_class<'a>(node: &'a RenderNode, class: &str) -> Option<&'a RenderNode> {
    if node.classes.iter().any(|name| name == class) {
        return Some(node);
    }
    node.children
        .iter()
        .find_map(|child| find_class(child, class))
}

fn text(node: &RenderNode) -> String {
    let mut value = node.text.clone().unwrap_or_default();
    for child in &node.children {
        value.push_str(&text(child));
    }
    value
}

fn event_count(state: &Value, kind: &str) -> usize {
    state["trace"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|event| event["kind"] == kind)
        .count()
}

fn saved_ids(state: &Value, active: bool) -> Vec<Value> {
    state["saved"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|component| component["active"] == active)
        .map(|component| component["id"].clone())
        .collect()
}

fn set_template(
    manifest: &mut ContainerManifestV1,
    blobs: &mut BTreeMap<String, Vec<u8>>,
    id: &str,
    source: &str,
) {
    let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
    let pointer = format!("sha256:{}", hex_digest(&bytes));
    blobs.insert(pointer.clone(), bytes);
    if let Some(template) = manifest
        .templates
        .iter_mut()
        .find(|template| template.id == id)
    {
        template.wxml_ast = pointer;
    } else {
        manifest.templates.push(Template {
            id: id.into(),
            wxml_ast: pointer,
            bindings: Vec::new(),
            wxs_modules: Default::default(),
        });
    }
}

fn add_component(
    manifest: &mut ContainerManifestV1,
    blobs: &mut BTreeMap<String, Vec<u8>>,
    modules: &mut Vec<Value>,
    path: &str,
    source: &str,
    wxml: &str,
) {
    let id = format!("module:{path}.js");
    manifest.modules.push(Module {
        id: id.clone(),
        sha256: hex_digest(source.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::Component,
        dependencies: Vec::new(),
    });
    modules.push(json!({"id":id,"bytes":source.as_bytes()}));
    set_template(manifest, blobs, &format!("template:{path}.wxml"), wxml);
    manifest.components.push(Component {
        id: format!("components:{path}.json"),
        owner: format!("{path}.json"),
        using_components: BTreeMap::new(),
        multiple_slots: None,
    });
}

#[test]
fn coordinate_tap_chooses_the_second_instance_even_when_public_element_ids_are_repeated() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let frame = fixture.session.renderer().last_frame().unwrap();
        let targets = frame.query("#shared-tap", true).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(
            targets[0].id, targets[1].id,
            "the public WXML id is intentionally repeated"
        );
        assert_ne!(targets[0].event_identity, targets[1].event_identity);
        let bounds = targets[1].bounds;
        assert!(bounds.width > 0.0 && bounds.height > 0.0);
        fixture.dispatch(
            op::EVENT_BATCH,
            json!({"events":[{
                "type":"tap", "x":bounds.x + bounds.width / 2.0,
                "y":bounds.y + bounds.height / 2.0
            }]}),
        );
        fixture.render();
        let cards = fixture.cards();
        assert_eq!(cards[0].count, "0");
        assert_eq!(cards[1].count, "1");
        let state = fixture.inspect();
        let event = state["trace"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|event| event["kind"] == "component.tap")
            .unwrap();
        assert_eq!(event["target"], "shared-tap");
        assert_eq!(event["currentTarget"], "shared-tap");
        assert_eq!(event["id"], state["saved"][1]["id"]);
    }
}

#[test]
fn hiding_a_preceding_sibling_retains_an_unkeyed_component_scope_and_state() {
    for engine in engines() {
        let mut fixture = Fixture::start_with(engine, |manifest, blobs, _| {
            set_template(
                manifest,
                blobs,
                PAGE_TEMPLATE,
                r#"<view wx:if="{{visible}}"/><card row="{{rows[0]}}" values="{{rows[0].values}}" flag="{{rows[0].flag}}" numeric="{{rows[0].numeric}}"><text slot="content" class="slot-content">Parent</text></card>"#,
            );
        });
        fixture.render();
        let frame = fixture.session.renderer().last_frame().unwrap();
        let host = frame.query("card", false).unwrap()[0];
        let scope = host.component_scope_id.clone().unwrap();
        let target = find_class(host, "component-tap")
            .unwrap()
            .event_identity
            .clone()
            .unwrap();
        fixture.tap(&target);
        fixture.render();
        fixture.call("setVisible", json!([false]));
        fixture.render();
        let host = fixture
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query("card", false)
            .unwrap()[0];
        assert_eq!(host.component_scope_id.as_deref(), Some(scope.as_str()));
        assert_eq!(text(find_class(host, "count").unwrap()), "1");
        let state = fixture.inspect();
        assert_eq!(event_count(&state, "component.created"), 1);
        assert_eq!(event_count(&state, "component.detached"), 0);
    }
}

#[test]
fn nested_components_and_light_slots_resolve_their_declaration_owner_and_selector_scope() {
    for engine in engines() {
        let mut fixture = Fixture::start_with(engine, |manifest, blobs, modules| {
            let page = PAGE_WXML.replace(
                r#"<text slot="content" class="slot-content" bindtap="onSlot">{{pageLabel}}:{{item.label}}</text>"#,
                r#"<badge slot="content" class="slot-content"/>"#,
            );
            let card = COMPONENT_WXML.replace(
                r#"<slot name="content">"#,
                r#"<badge class="own-child"/><slot name="content">"#,
            );
            set_template(manifest, blobs, PAGE_TEMPLATE, &page);
            set_template(
                manifest,
                blobs,
                "template:components/card/index.wxml",
                &card,
            );
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "pages/index/index.json")
                .unwrap()
                .using_components
                .insert("badge".into(), "components/parent-badge/index".into());
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "components/card/index.json")
                .unwrap()
                .using_components
                .insert("badge".into(), "components/child-badge/index".into());
            add_component(
                manifest,
                blobs,
                modules,
                "components/parent-badge/index",
                "Component({data:{label:'Parent declaration'}});",
                r#"<text class="parent-private">{{label}}</text>"#,
            );
            add_component(
                manifest,
                blobs,
                modules,
                "components/child-badge/index",
                "Component({data:{label:'Child declaration'}});",
                r#"<text class="child-private">{{label}}</text>"#,
            );
        });
        fixture.render();
        let frame = fixture.session.renderer().last_frame().unwrap();
        let hosts = frame.query("card", true).unwrap();
        assert_eq!(hosts.len(), 2);
        let mut scopes = Vec::new();
        for host in hosts {
            assert_eq!(
                text(find_class(host, "parent-private").unwrap()),
                "Parent declaration"
            );
            assert_eq!(
                text(find_class(host, "child-private").unwrap()),
                "Child declaration"
            );
            let own = find_class(host, "own-child").unwrap();
            let slot = find_class(host, "slot-content").unwrap();
            scopes.push((
                host.component_scope_id.clone().unwrap(),
                own.component_scope_id.clone().unwrap(),
                slot.component_scope_id.clone().unwrap(),
            ));
        }
        assert_ne!(
            scopes[0].1, scopes[1].1,
            "nested instance identity includes its parent"
        );
        for (card, child, parent) in scopes {
            for (scope, selector, expected) in [
                (&card, ".label", 1),
                (&card, ".child-private", 0),
                (&card, ".parent-private", 0),
                (&child, ".child-private", 1),
                (&parent, ".parent-private", 1),
            ] {
                let result = fixture.dispatch(
                    op::API_CALL,
                    json!({
                        "name":"wx.createSelectorQuery","scopeId":scope,
                        "selector":selector,"all":true
                    }),
                );
                assert_eq!(
                    result["result"].as_array().unwrap().len(),
                    expected,
                    "{engine:?} scope {scope}, selector {selector}"
                );
            }
        }
    }
}

#[test]
fn a_single_slot_projects_all_parent_light_children_including_named_assignments() {
    for engine in engines() {
        let mut fixture = Fixture::start_with(engine, |manifest, blobs, modules| {
            set_template(
                manifest,
                blobs,
                PAGE_TEMPLATE,
                r#"<card row="{{rows[0]}}"><text slot="header" class="first-light">First</text><text class="second-light">Second</text></card>"#,
            );
            set_template(
                manifest,
                blobs,
                "template:components/card/index.wxml",
                r#"<view><slot><text class="fallback">Fallback</text></slot></view>"#,
            );
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "components/card/index.json")
                .unwrap()
                .multiple_slots = Some(false);
            let source = COMPONENT_JS.replace("multipleSlots: true", "multipleSlots: false");
            manifest
                .modules
                .iter_mut()
                .find(|module| module.id == COMPONENT_MODULE)
                .unwrap()
                .sha256 = hex_digest(source.as_bytes());
            *modules
                .iter_mut()
                .find(|module| module["id"] == COMPONENT_MODULE)
                .unwrap() = json!({"id":COMPONENT_MODULE,"bytes":source.as_bytes()});
        });
        fixture.render();
        let frame = fixture.session.renderer().last_frame().unwrap();
        assert_eq!(frame.query(".first-light", true).unwrap().len(), 1);
        assert_eq!(frame.query(".second-light", true).unwrap().len(), 1);
        assert!(frame.query(".fallback", true).unwrap().is_empty());
        assert_eq!(text(frame.query("card", false).unwrap()[0]), "FirstSecond");
    }
}

#[test]
fn invalid_css_opacity_uses_the_default_without_disrupting_component_state_or_events() {
    for engine in engines() {
        let mut fixture = Fixture::start_with(engine, |manifest, blobs, _| {
            let bytes = parse_wxss(".component-tap { width:120px; height:24px; opacity:NaN; }")
                .unwrap()
                .canonical_json()
                .unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            blobs.insert(pointer.clone(), bytes);
            manifest.styles[0].wxss_ir = pointer;
        });
        fixture.render();
        let before = fixture.cards();
        let frame = fixture.session.renderer().last_frame().unwrap();
        let taps = frame.query(".component-tap", true).unwrap();
        assert_eq!(taps.len(), 2);
        assert!(taps.iter().all(|node| node.opacity == 1.0));

        fixture.tap(&before[0].tap);
        fixture.render();
        fixture.tap(&before[1].tap);
        fixture.render();
        let after = fixture.cards();
        assert_eq!(after[0].scope, before[0].scope);
        assert_eq!(after[1].scope, before[1].scope);
        assert_eq!(after[0].count, "1");
        assert_eq!(after[1].count, "1");
        let state = fixture.inspect();
        assert_eq!(event_count(&state, "component.created"), 2);
        assert_eq!(event_count(&state, "component.detached"), 0);
        assert_eq!(event_count(&state, "component.tap"), 2);
        assert_eq!(saved_ids(&state, true).len(), 2);
    }
}

#[test]
fn invalid_viewport_with_removal_data_preserves_the_live_component_graph() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let before = fixture.cards();
        fixture.tap(&before[0].tap);
        fixture.render();
        let frame_id = fixture.session.renderer().last_frame().unwrap().frame_id;
        let mut rejected_data = fixture
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone();
        rejected_data["visible"] = json!(false);
        for width in [-1.0, 1e10] {
            fixture.sequence += 1;
            let batch = fixture.session.dispatch(BridgeEnvelope::request(
                "session-1",
                format!("managed-{}", fixture.sequence),
                op::RENDER_COMMIT,
                json!({
                    "templateId":PAGE_TEMPLATE,"blobs":fixture.blobs,
                    "data":rejected_data,"viewport":{"width":width,"height":1}
                }),
            ));
            assert_eq!(batch.messages[0].payload["ok"], false);
            assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_RENDER");
            assert_eq!(
                fixture.session.renderer().last_frame().unwrap().frame_id,
                frame_id
            );
            assert_eq!(fixture.cards()[0].scope, before[0].scope);
            let state = fixture.inspect();
            assert_eq!(event_count(&state, "component.created"), 2);
            assert_eq!(event_count(&state, "component.detached"), 0);
            assert_eq!(saved_ids(&state, true).len(), 2);
        }
        fixture.tap(&before[0].tap);
        fixture.render();
        assert_eq!(fixture.cards()[0].count, "2");
        assert_eq!(fixture.cards()[1].count, "0");
    }
}

#[test]
fn invalid_blob_digest_preserves_the_committed_component_graph_and_its_live_events() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let before = fixture.cards();
        fixture.tap(&before[0].tap);
        fixture.render();
        let frame_id = fixture.session.renderer().last_frame().unwrap().frame_id;
        let mut blobs = fixture.blobs.clone();
        let pointer = fixture
            .session
            .manifest()
            .templates
            .iter()
            .find(|template| template.id == PAGE_TEMPLATE)
            .unwrap()
            .wxml_ast
            .clone();
        blobs.insert(pointer, b"corrupt bytes".to_vec());
        fixture.sequence += 1;
        let batch = fixture.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("managed-{}", fixture.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":PAGE_TEMPLATE,"blobs":blobs}),
        ));
        assert_eq!(batch.messages[0].payload["ok"], false);
        assert_eq!(batch.messages[0].payload["error"]["code"], "ERR_RENDER");
        assert_eq!(
            fixture.session.renderer().last_frame().unwrap().frame_id,
            frame_id
        );
        assert_eq!(fixture.cards()[0].scope, before[0].scope);
        fixture.tap(&before[0].tap);
        fixture.render();
        assert_eq!(fixture.cards()[0].count, "2");
        assert_eq!(fixture.cards()[1].count, "0");
        let state = fixture.inspect();
        assert_eq!(event_count(&state, "component.created"), 2);
        assert_eq!(event_count(&state, "component.detached"), 0);
    }
}

#[test]
fn managed_components_mount_with_typed_properties_before_load_and_ready_after_render() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        let before = fixture.inspect();
        assert_eq!(
            event_count(&before, "component.created"),
            2,
            "{engine:?}: {before}"
        );
        assert_eq!(event_count(&before, "component.attached"), 2);
        assert_eq!(event_count(&before, "component.ready"), 0);
        assert_eq!(event_count(&before, "page.ready"), 0);
        let trace = before["trace"].as_array().unwrap();
        let load = trace
            .iter()
            .position(|event| event["kind"] == "page.load")
            .unwrap();
        assert!(trace
            .iter()
            .enumerate()
            .filter(|(_, event)| event["kind"] == "component.attached")
            .all(|(index, _)| index < load));
        let saved = before["saved"].as_array().unwrap();
        assert_eq!(
            saved[0]["row"],
            json!({"id":"a","label":"Alpha","values":[1,{"nested":true}],"flag":"false","numeric":"123"})
        );
        assert_eq!(saved[0]["values"], json!([1,{"nested":true}]));
        assert_eq!(saved[0]["flag"], "false");
        assert_eq!(saved[0]["numeric"], "123");
        assert_eq!(saved[1]["numeric"], "0042");
        fixture.render();
        let cards = fixture.cards();
        assert_eq!(cards.len(), 2, "custom component hosts remain in the View");
        assert_ne!(cards[0].scope, cards[1].scope);
        assert_ne!(cards[0].tap, cards[1].tap);
        assert_eq!(cards[0].label, "Alpha");
        assert_eq!(cards[1].label, "Beta");
        assert!(cards
            .iter()
            .all(|card| card.count == "0" && card.private_value.is_empty()));
        let after = fixture.inspect();
        assert_eq!(event_count(&after, "component.ready"), 2);
        assert_eq!(event_count(&after, "page.ready"), 1);
        let trace = after["trace"].as_array().unwrap();
        let page_ready = trace
            .iter()
            .position(|event| event["kind"] == "page.ready")
            .unwrap();
        assert!(trace
            .iter()
            .enumerate()
            .filter(|(_, event)| event["kind"] == "component.ready")
            .all(|(index, _)| index > load && index < page_ready));
        fixture.render();
        let repeated = fixture.inspect();
        assert_eq!(event_count(&repeated, "component.created"), 2);
        assert_eq!(event_count(&repeated, "component.ready"), 2);
        assert_eq!(event_count(&repeated, "page.ready"), 1);
    }
}

#[test]
fn managed_component_and_slot_events_keep_their_owner_during_reorder_and_property_updates() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let before = fixture.cards();
        let frame = fixture.session.renderer().last_frame().unwrap();
        let page_button = frame.query("#page-button", false).unwrap()[0];
        let page_button_id = page_button.id.clone();
        let page_owner = page_button.event_owner_scope_id.clone();
        for card in &before {
            assert_eq!(card.tap_owner.as_deref(), Some(card.scope.as_str()));
            assert_eq!(card.slot_owner, page_owner);
            assert_ne!(card.slot_owner, card.tap_owner);
        }
        fixture.tap(&before[0].tap);
        fixture.tap(&before[0].slot);
        fixture.tap(&page_button_id);
        fixture.render();
        let updated = fixture.cards();
        assert_eq!(updated[0].count, "1");
        assert_eq!(updated[1].count, "0", "instances own independent data");
        let page_data = &fixture
            .session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data;
        assert_eq!(page_data["slotHits"], 1);
        assert_eq!(page_data["pageHits"], 1);
        assert_eq!(page_data["wrongPageTap"], 0);
        assert!(fixture.inspect()["saved"]
            .as_array()
            .unwrap()
            .iter()
            .all(|saved| saved["wrongSlot"] == 0));

        fixture.call(
            "replaceRows",
            json!([[
                {"id":"b","label":"Beta updated","values":[20],"flag":"false","numeric":"42"},
                {"id":"a","label":"Alpha updated","values":[10],"flag":"true","numeric":"7"}
            ]]),
        );
        fixture.render();
        let reordered = fixture.cards();
        assert_eq!(
            reordered
                .iter()
                .map(|card| card.key.as_str())
                .collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(reordered[0].scope, before[1].scope);
        assert_eq!(reordered[1].scope, before[0].scope);
        assert_eq!(reordered[0].count, "0");
        assert_eq!(reordered[1].count, "1");
        assert_eq!(reordered[0].label, "Beta updated");
        assert_eq!(reordered[1].slot_text, "parent:Alpha updated");
        let state = fixture.inspect();
        assert_eq!(event_count(&state, "component.created"), 2);
        assert_eq!(event_count(&state, "component.detached"), 0);
        assert_eq!(state["saved"][0]["row"]["label"], "Alpha updated");
        assert_eq!(state["saved"][0]["values"], json!([10]));
    }
}

#[test]
fn conditional_component_removal_detaches_and_recreation_discards_stale_instance_patches() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let before = fixture.inspect();
        let old_ids = saved_ids(&before, true);
        fixture.call("setVisible", json!([false]));
        fixture.render();
        assert!(fixture
            .session
            .renderer()
            .last_frame()
            .unwrap()
            .query("card", true)
            .unwrap()
            .is_empty());
        let removed = fixture.inspect();
        assert_eq!(event_count(&removed, "component.detached"), 2);
        assert!(saved_ids(&removed, true).is_empty());
        fixture.call("setVisible", json!([true]));
        fixture.render();
        let recreated = fixture.inspect();
        assert_eq!(event_count(&recreated, "component.created"), 4);
        assert_eq!(saved_ids(&recreated, true).len(), 2);
        assert!(saved_ids(&recreated, true)
            .iter()
            .all(|id| !old_ids.contains(id)));
        fixture.call("patchSaved", json!([old_ids, 999]));
        fixture.render();
        assert!(fixture.cards().iter().all(|card| card.count == "0"));
        fixture.render();
        assert_eq!(
            event_count(&fixture.inspect(), "component.detached"),
            2,
            "detach is one-shot"
        );
    }
}

#[test]
fn navigation_preserves_hidden_component_instances_and_pop_releases_only_the_removed_page() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine);
        fixture.render();
        let first = fixture.cards();
        fixture.tap(&first[0].tap);
        fixture.render();
        let bottom_ids = saved_ids(&fixture.inspect(), true);
        fixture.push();
        fixture.render();
        let top = fixture.cards();
        assert_ne!(first[0].scope, top[0].scope);
        assert!(top.iter().all(|card| card.count == "0"));
        let state = fixture.inspect();
        assert_eq!(event_count(&state, "component.detached"), 0);
        let top_ids = saved_ids(&state, true)
            .into_iter()
            .filter(|id| !bottom_ids.contains(id))
            .collect::<Vec<_>>();
        assert_eq!(top_ids.len(), 2);
        fixture.dispatch(op::PAGE_POP, json!({}));
        fixture.render();
        let restored = fixture.cards();
        assert_eq!(restored[0].scope, first[0].scope);
        assert_eq!(restored[1].scope, first[1].scope);
        assert_eq!(restored[0].count, "1");
        assert_eq!(restored[1].count, "0");
        let popped = fixture.inspect();
        assert_eq!(event_count(&popped, "component.detached"), 2);
        assert_eq!(saved_ids(&popped, true), bottom_ids);
        fixture.call("patchSaved", json!([top_ids, 999]));
        fixture.render();
        let after_stale = fixture.cards();
        assert_eq!(after_stale[0].count, "1");
        assert_eq!(after_stale[1].count, "0");
        assert_eq!(fixture.session.app_service().pages().len(), 1);
    }
}

// Custom events traverse a batched, pre-render page graph. These integration
// tests use public Component/Page APIs and never manufacture engine metadata.
const EVENT_APP_JS: &str = r#"
App({log:[],detail:null,held:null,record:function(label,owner,event) {
  this.log.push({label:label,receiver:owner.id || 'page',phase:event.phase,
    target:event.target.id,current:event.currentTarget.id,
    dataset:event.currentTarget.dataset,sameDetail:event.detail===this.detail,
    value:event.detail && event.detail.value});
}});
function currentPage() { const pages=getCurrentPages(); return pages[pages.length-1]; }
Page({data:{visible:true,hits:0,handler:'receive'},
  receive:function(event) { getApp().record('receive',this,event); event.detail.touched=true; this.setData({hits:this.data.hits+1}); },
  other:function(event) { getApp().record('other',this,event); },
  colon:function(event) { getApp().record('colon',this,event); },
  capture:function(event) { getApp().record('capture',this,event); },
  bubble:function(event) { getApp().record('bubble',this,event); },
  caught:function(event) { getApp().record('caught',this,event); },
  reenter:function(event) { getApp().record('reenter',this,event); if (!event.detail.nested) getApp().held.triggerEvent('probe',{nested:true}); },
  throwing:function(event) { getApp().record('throwing',this,event); throw Error('custom-listener-failure'); }
});
exports.emit=function(selector,name,options) { return currentPage().selectComponent(selector).emit(name,options); };
exports.inspect=function() { return {log:getApp().log,hits:currentPage().data.hits}; };
exports.hold=function(selector) { getApp().held=currentPage().selectComponent(selector); };
exports.hide=function() { currentPage().setData({visible:false}); };
exports.show=function() { currentPage().setData({visible:true}); };
exports.clearLog=function() { getApp().log=[]; };
exports.sameHeld=function(selector) { return getApp().held===currentPage().selectComponent(selector); };
exports.changeHandler=function(handler) { currentPage().setData({handler:handler}); };
exports.tryEmit=function(selector,name,options) { try {currentPage().selectComponent(selector).triggerEvent(name,{},options); return {ok:true,capability:wx.canIUse('Component.triggerEvent')};} catch(error) {return {ok:false,code:error.code,capability:wx.canIUse('Component.triggerEvent')};} };
exports.emitHeld=function() { try {getApp().held.triggerEvent('probe',{}); return {ok:true};} catch(error) {return {ok:false,code:error.code};} };
// Read-only release diagnostics: never publish metadata or alter registries.
exports.routingState=function() {
  const pages=globalThis.__container_component_event_pages;
  const retiring=globalThis.__container_retiring_component_events;
  const pageHosts={},retiredScopes={};
  Object.keys(pages).forEach(function(page) {pageHosts[page]=Object.keys(pages[page].hosts).sort();});
  Object.keys(retiring).forEach(function(page) {retiredScopes[page]=Object.keys(retiring[page]).sort();});
  return {pageHosts:pageHosts,retiredScopes:retiredScopes,
    liveScopes:Object.keys(globalThis.__container_component_scopes).sort(),
    heldScope:getApp().held && getApp().held.__container_scope_id};
};
"#;

const EVENT_CARD_JS: &str = r#"
Component({methods:{emit:function(name,options) {
  const detail={value:7,callback:function(){return 9;}};
  detail.self=detail; getApp().detail=detail; getApp().log=[{label:'before'}];
  const returned=this.triggerEvent(name,detail,options);
  getApp().log.push({label:'after',touched:detail.touched===true,
    circular:detail.self===detail,callback:detail.callback(),returnedUndefined:returned===undefined});
  return {log:getApp().log,capability:wx.canIUse('Component.triggerEvent')};
}}});
"#;

fn event_fixture(engine: EngineKind, wxml: &str, panel: bool) -> Fixture {
    event_fixture_with_support(engine, wxml, panel, CapabilitySupport::Partial)
}

fn event_fixture_with_support(
    engine: EngineKind,
    wxml: &str,
    panel: bool,
    support: CapabilitySupport,
) -> Fixture {
    event_fixture_with_source(engine, wxml, panel, support, EVENT_CARD_JS)
}

fn event_fixture_with_source(
    engine: EngineKind,
    wxml: &str,
    panel: bool,
    support: CapabilitySupport,
    card_source: &str,
) -> Fixture {
    event_fixture_with_customization(engine, wxml, panel, support, card_source, |_, _, _| {})
}

fn event_fixture_with_customization(
    engine: EngineKind,
    wxml: &str,
    panel: bool,
    support: CapabilitySupport,
    card_source: &str,
    configure: impl FnOnce(&mut ContainerManifestV1, &mut BTreeMap<String, Vec<u8>>, &mut Vec<Value>),
) -> Fixture {
    Fixture::start_with(engine, |manifest, blobs, modules| {
        for capability in [
            "Page.selectComponent",
            "Component.selectComponent",
            "Component.triggerEvent",
        ] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Partial);
        }
        manifest
            .capabilities
            .insert("Component.triggerEvent".into(), support);
        for (id, source) in [(APP_MODULE, EVENT_APP_JS), (COMPONENT_MODULE, card_source)] {
            manifest
                .modules
                .iter_mut()
                .find(|entry| entry.id == id)
                .unwrap()
                .sha256 = hex_digest(source.as_bytes());
            *modules.iter_mut().find(|entry| entry["id"] == id).unwrap() =
                json!({"id":id,"bytes":source.as_bytes()});
        }
        set_template(manifest, blobs, PAGE_TEMPLATE, wxml);
        set_template(
            manifest,
            blobs,
            "template:components/card/index.wxml",
            "<text>Emitter</text>",
        );
        if panel {
            add_component(
                manifest,
                blobs,
                modules,
                "components/panel/index",
                r#"
Component({options:{multipleSlots:true},methods:{
  receive:function(event) {getApp().record('panel-direct',this,event);},
  bubble:function(event) {getApp().record('panel-bubble',this,event);},
  emitInner:function(options) {return this.selectComponent('#internal').emit('probe',options);}
}});"#,
                r#"<view id="panel-inner" bind:probe="bubble"><card id="internal" bind:probe="receive"/></view><slot name="content"/>"#,
            );
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "pages/index/index.json")
                .unwrap()
                .using_components
                .insert("panel".into(), "components/panel/index".into());
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "components/panel/index.json")
                .unwrap()
                .using_components
                .insert("card".into(), "components/card/index".into());
            manifest
                .components
                .iter_mut()
                .find(|entry| entry.owner == "components/panel/index.json")
                .unwrap()
                .multiple_slots = Some(true);
            modules[0] = json!({"id":APP_MODULE,"bytes":format!("{EVENT_APP_JS}\nexports.emitInner=function(options) {{ return currentPage().selectComponent('#panel').emitInner(options); }};").as_bytes()});
            manifest
                .modules
                .iter_mut()
                .find(|entry| entry.id == APP_MODULE)
                .unwrap()
                .sha256 = hex_digest(
                &serde_json::from_value::<Vec<u8>>(modules[0]["bytes"].clone()).unwrap(),
            );
        }
        configure(manifest, blobs, modules);
    })
}

fn event_labels(value: &Value) -> Vec<&str> {
    value["log"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["label"].as_str().unwrap())
        .collect()
}

#[test]
fn custom_events_are_synchronous_and_preserve_detail_identity_before_first_frame() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<card id="emit" data-count="{{7}}" data-flag="{{false}}" bind:probe="receive"/>"#,
            false,
        );
        assert!(fixture.session.renderer().last_frame().is_none());
        let result = fixture.call("emit", json!(["#emit", "probe", {}]));
        assert_eq!(
            event_labels(&result),
            ["before", "receive", "after"],
            "{engine:?}: {result}"
        );
        assert_eq!(result["capability"], true);
        assert_eq!(result["log"][1]["sameDetail"], true);
        assert_eq!(result["log"][1]["target"], "emit");
        assert_eq!(result["log"][1]["dataset"], json!({"count":7,"flag":false}));
        assert_eq!(
            result["log"][2],
            json!({"label":"after","touched":true,"circular":true,"callback":9,"returnedUndefined":true})
        );
        assert_eq!(
            fixture
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["hits"],
            1
        );
    }
}

#[test]
fn custom_event_aliases_match_fixed_sdk_oracle() {
    let wxml = r#"<view>
<card id="bare" bindprobe="receive"/>
<card id="colon" bind:probe="colon"/>
<card id="both" bind:probe="colon" bindprobe="receive"/>
<card id="reverse" bindprobe="receive" bind:probe="colon"/>
<card id="hyphen-bare" bindprobe-hyphen="receive"/>
<card id="hyphen-colon" bind:probe-hyphen="colon"/>
<card id="hyphen-both" bindprobe-hyphen="receive" bind:probe-hyphen="colon"/>
<card id="under-both" bind:probe_under="colon" bindprobe_under="receive"/>
</view>"#;
    for engine in engines() {
        let mut fixture = event_fixture(engine, wxml, false);
        for (id, event, expected) in [
            ("bare", "probe", Some("receive")),
            ("colon", "probe", Some("colon")),
            ("both", "probe", Some("receive")),
            ("reverse", "probe", Some("receive")),
            ("hyphen-bare", "probe-hyphen", None),
            ("hyphen-colon", "probe-hyphen", Some("colon")),
            ("hyphen-both", "probe-hyphen", Some("colon")),
            ("under-both", "probe_under", Some("receive")),
        ] {
            let result = fixture.call("emit", json!([format!("#{id}"), event, {}]));
            let mut expected_labels = vec!["before"];
            expected_labels.extend(expected);
            expected_labels.push("after");
            assert_eq!(
                event_labels(&result),
                expected_labels,
                "{engine:?} {id}: {result}"
            );
        }
    }
}

#[test]
fn custom_event_capture_bubble_and_catch_use_one_synchronous_route() {
    let wxml = r#"<view id="root" capture-bind:probe="capture" bind:probe="bubble"><view id="middle" capture-bind:probe="capture" bind:probe="bubble"><card id="emit" bind:probe="receive"/></view></view>"#;
    for engine in engines() {
        let mut fixture = event_fixture(engine, wxml, false);
        for (options, labels) in [
            (json!({}), vec!["before", "receive", "after"]),
            (
                json!({"capturePhase":true}),
                vec!["before", "capture", "capture", "receive", "after"],
            ),
            (
                json!({"bubbles":true}),
                vec!["before", "receive", "bubble", "bubble", "after"],
            ),
            (
                json!({"capturePhase":true,"bubbles":true}),
                vec![
                    "before", "capture", "capture", "receive", "bubble", "bubble", "after",
                ],
            ),
        ] {
            let result = fixture.call("emit", json!(["#emit", "probe", options]));
            assert_eq!(event_labels(&result), labels, "{engine:?}: {result}");
        }
        let mut caught = event_fixture(
            engine,
            r#"<view id="root" capture-bind:probe="capture" bind:probe="bubble"><card id="emit" catch:probe="caught"/></view>"#,
            false,
        );
        let result = caught.call(
            "emit",
            json!(["#emit","probe",{"capturePhase":true,"bubbles":true}]),
        );
        assert_eq!(
            event_labels(&result),
            ["before", "capture", "caught", "after"]
        );
        let mut capture_caught = event_fixture(
            engine,
            r#"<view id="root" capture-bind:probe="capture"><view id="middle" capture-catch:probe="caught"><card id="emit" bind:probe="receive"/></view></view>"#,
            false,
        );
        let result = capture_caught.call(
            "emit",
            json!(["#emit","probe",{"capturePhase":true,"bubbles":true}]),
        );
        assert_eq!(
            event_labels(&result),
            ["before", "capture", "caught", "after"]
        );
    }
}

#[test]
fn custom_events_stop_at_component_boundary_and_composed_events_retarget() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<view id="root" bind:probe="bubble"><panel id="panel" bind:probe="receive"/></view>"#,
            true,
        );
        let local = fixture.call("emitInner", json!([{"bubbles":true}]));
        assert_eq!(
            event_labels(&local),
            ["before", "panel-direct", "panel-bubble", "after"],
            "{engine:?}: {local}"
        );
        let composed = fixture.call("emitInner", json!([{"bubbles":true,"composed":true}]));
        assert_eq!(
            event_labels(&composed),
            [
                "before",
                "panel-direct",
                "panel-bubble",
                "receive",
                "bubble",
                "after"
            ],
            "{engine:?}: {composed}"
        );
        assert_eq!(composed["log"][1]["target"], "internal");
        assert_eq!(composed["log"][3]["target"], "panel");
        assert_eq!(composed["log"][1]["receiver"], "panel");
        assert_eq!(composed["log"][3]["receiver"], "page");
    }
}

#[test]
fn custom_events_in_slots_use_declaration_owner_and_detached_sources_fail() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<panel id="panel"><card wx:if="{{visible}}" id="emit" slot="content" bind:probe="receive"/></panel>"#,
            true,
        );
        let result = fixture.call("emit", json!(["#emit", "probe", {}]));
        assert_eq!(event_labels(&result), ["before", "receive", "after"]);
        assert_eq!(result["log"][1]["receiver"], "page");
        fixture.call("hold", json!(["#emit"]));
        fixture.call("hide", json!([]));
        fixture.render();
        let rejected = fixture.call("emitHeld", json!([]));
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert!(
            rejected["code"].as_str().is_some(),
            "structured stale-source error"
        );
    }
}

#[test]
fn custom_event_listener_updates_without_replacing_component_instances() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<card id="emit" bind:probe="{{handler}}"/>"#,
            false,
        );
        assert_eq!(
            event_labels(&fixture.call("emit", json!(["#emit", "probe", {}]))),
            ["before", "receive", "after"]
        );
        fixture.call("hold", json!(["#emit"]));
        fixture.call("changeHandler", json!(["other"]));
        fixture.render();
        let result = fixture.call("emit", json!(["#emit", "probe", {}]));
        assert_eq!(event_labels(&result), ["before", "other", "after"]);
        assert_eq!(
            fixture.call("emitHeld", json!([]))["ok"],
            true,
            "existing occurrence remains live"
        );
    }
}

#[test]
fn pointer_event_aliases_follow_same_fixed_sdk_precedence() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<view id="tap" bind:tap="colon" bindtap="other"/>"#,
            false,
        );
        fixture.render();
        fixture.tap("tap");
        assert_eq!(event_labels(&fixture.call("inspect", json!([]))), ["other"]);
    }
}

#[test]
fn custom_event_denial_and_invalid_arguments_are_structured_and_have_no_handlers() {
    for engine in engines() {
        let wxml = r#"<card id="emit" bind:probe="receive"/>"#;
        let mut denied =
            event_fixture_with_support(engine, wxml, false, CapabilitySupport::Unsupported);
        assert_eq!(
            denied.call("tryEmit", json!(["#emit", "probe", {}])),
            json!({"ok":false,"code":"ERR_UNSUPPORTED_CAPABILITY","capability":false})
        );
        assert_eq!(denied.call("inspect", json!([]))["log"], json!([]));
        let mut fixture = event_fixture(engine, wxml, false);
        for args in [
            json!(["#emit", "", {}]),
            json!(["#emit", 7, {}]),
            json!(["#emit", "probe", null]),
            json!(["#emit","probe",{"bubbles":"true"}]),
        ] {
            let value = fixture.call("tryEmit", args);
            assert_eq!(value["code"], "ERR_INVALID_REQUEST", "{engine:?}: {value}");
        }
        assert_eq!(fixture.call("inspect", json!([]))["log"], json!([]));
    }
}

#[test]
fn custom_event_nested_dispatch_and_throwing_handlers_preserve_dispatch_order() {
    for engine in engines() {
        let mut fixture = event_fixture(engine, r#"<card id="emit" bind:probe="reenter"/>"#, false);
        fixture.call("hold", json!(["#emit"]));
        let value = fixture.call("emit", json!(["#emit", "probe", {}]));
        assert_eq!(
            event_labels(&value),
            ["before", "reenter", "reenter", "after"],
            "{engine:?}: {value}"
        );
        let mut throwing = event_fixture(
            engine,
            r#"<view bind:probe="bubble"><card id="emit" bind:probe="throwing"/></view>"#,
            false,
        );
        let value = throwing.call("emit", json!(["#emit","probe",{"bubbles":true}]));
        assert_eq!(
            event_labels(&value),
            ["before", "throwing", "bubble", "after"],
            "{engine:?}: {value}"
        );
    }
}

#[test]
fn custom_event_lifecycle_graph_is_available_before_create_until_detach_completes() {
    let source = r#"Component({lifetimes:{
      created:function(){this.triggerEvent('probe',{value:1});},
      attached:function(){this.triggerEvent('probe',{value:2});},
      ready:function(){this.triggerEvent('probe',{value:3});},
      detached:function(){this.triggerEvent('probe',{value:4});}
    }});"#;
    for engine in engines() {
        let mut fixture = event_fixture_with_source(
            engine,
            r#"<card wx:if="{{visible}}" id="emit" bind:probe="receive"/>"#,
            false,
            CapabilitySupport::Partial,
            source,
        );
        let before = fixture.call("inspect", json!([]));
        assert_eq!(
            before["log"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["value"].clone())
                .collect::<Vec<_>>(),
            vec![json!(1), json!(2)],
            "{engine:?}: {before}"
        );
        fixture.render();
        fixture.call("hold", json!(["#emit"]));
        fixture.call("hide", json!([]));
        fixture.render();
        let after = fixture.call("inspect", json!([]));
        assert_eq!(
            after["log"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["value"].clone())
                .collect::<Vec<_>>(),
            vec![json!(1), json!(2), json!(3), json!(4)],
            "{engine:?}: {after}"
        );
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], false);
    }
}

#[test]
fn invalid_viewport_preserves_custom_event_routes() {
    for engine in engines() {
        let mut fixture = event_fixture(engine, r#"<card id="emit" bind:probe="receive"/>"#, false);
        fixture.render();
        fixture.sequence += 1;
        let batch=fixture.session.dispatch(BridgeEnvelope::request("session-1",format!("invalid-custom-{}",fixture.sequence),op::RENDER_COMMIT,json!({"templateId":PAGE_TEMPLATE,"viewport":{"width":-1,"height":667},"blobs":fixture.blobs})));
        assert_eq!(batch.messages[0].payload["ok"], false);
        let value = fixture.call("emit", json!(["#emit", "probe", {}]));
        assert_eq!(
            event_labels(&value),
            ["before", "receive", "after"],
            "{engine:?}: {value}"
        );
    }
}

#[test]
fn rejected_published_frontier_restores_event_routes_and_releases_retired_graphs() {
    for engine in engines() {
        let mut fixture = event_fixture_with_customization(
            engine,
            r#"<card wx:if="{{visible}}" id="emit" bind:probe="receive"/><breaker wx:if="{{!visible}}" id="breaker"/>"#,
            false,
            CapabilitySupport::Partial,
            EVENT_CARD_JS,
            |manifest, blobs, modules| {
                add_component(
                    manifest,
                    blobs,
                    modules,
                    "components/breaker/index",
                    r#"Component({data:{rows:[]},lifetimes:{created:function() {
                      const held=getApp().held;
                      const page=String(this.__container_page_id);
                      const graph=globalThis.__container_component_event_pages[page];
                      const retiring=globalThis.__container_retiring_component_events[page];
                      getApp().frontierProof={scope:this.__container_scope_id,
                        oldHostPublished:!!graph.hosts[held.__container_scope_id],
                        newHostPublished:!!graph.hosts[this.__container_scope_id],
                        oldSourceRetired:!!retiring && retiring[held.__container_scope_id].instance===held,
                        oldSourceLive:globalThis.__container_component_scopes[held.__container_scope_id]===held};
                      this.setData({rows:[{id:'duplicate'},{id:'duplicate'}]});
                    }}});"#,
                    r#"<view wx:for="{{rows}}" wx:key="id"/>"#,
                );
                manifest
                    .components
                    .iter_mut()
                    .find(|entry| entry.owner == "pages/index/index.json")
                    .unwrap()
                    .using_components
                    .insert("breaker".into(), "components/breaker/index".into());
                let source = format!(
                    "{EVENT_APP_JS}\nexports.frontierProof=function() {{return getApp().frontierProof;}};"
                );
                manifest
                    .modules
                    .iter_mut()
                    .find(|entry| entry.id == APP_MODULE)
                    .unwrap()
                    .sha256 = hex_digest(source.as_bytes());
                modules[0] = json!({"id":APP_MODULE,"bytes":source.as_bytes()});
            },
        );
        fixture.render();
        fixture.call("hold", json!(["#emit"]));
        fixture.call("emit", json!(["#emit", "probe", {}]));
        let before = fixture.call("routingState", json!([]));
        let held_scope = before["heldScope"].as_str().unwrap().to_owned();
        let frame_id = fixture.session.renderer().last_frame().unwrap().frame_id;
        fixture.call("hide", json!([]));
        fixture.sequence += 1;
        let batch = fixture.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("published-frontier-{}", fixture.sequence),
            op::RENDER_COMMIT,
            json!({"templateId":PAGE_TEMPLATE,"viewport":{"width":375,"height":667},"blobs":fixture.blobs}),
        ));
        let payload = &batch.messages[0].payload;
        assert_eq!(payload["ok"], false, "{engine:?}: {payload}");
        assert_eq!(payload["error"]["code"], "ERR_RENDER");
        assert!(
            payload["error"]["message"]
                .as_str()
                .unwrap()
                .contains("duplicate"),
            "{engine:?}: {payload}"
        );
        let proof = fixture.call("frontierProof", json!([]));
        assert_eq!(proof["oldHostPublished"], false, "{engine:?}: {proof}");
        assert_eq!(proof["newHostPublished"], true, "{engine:?}: {proof}");
        assert_eq!(proof["oldSourceRetired"], true, "{engine:?}: {proof}");
        assert_eq!(proof["oldSourceLive"], true, "{engine:?}: {proof}");
        assert_eq!(
            fixture.session.renderer().last_frame().unwrap().frame_id,
            frame_id,
            "rejected frontier retains the accepted frame"
        );
        let restored = fixture.call("routingState", json!([]));
        assert_eq!(restored["pageHosts"], before["pageHosts"]);
        assert_eq!(restored["liveScopes"], json!([held_scope]));
        assert!(restored["retiredScopes"].as_object().unwrap().is_empty());
        assert!(!restored["liveScopes"]
            .as_array()
            .unwrap()
            .contains(&proof["scope"]));
        assert_eq!(fixture.call("sameHeld", json!(["#emit"])), true);
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], true);
        assert_eq!(fixture.call("inspect", json!([]))["hits"], 2);
        fixture.call("show", json!([]));
        fixture.render();
        assert_eq!(
            event_labels(&fixture.call("emit", json!(["#emit", "probe", {}]))),
            ["before", "receive", "after"]
        );
    }
}

#[test]
fn custom_event_disposal_releases_maps_and_scope_reuse_never_revives_old_sources() {
    for engine in engines() {
        let mut fixture = event_fixture(
            engine,
            r#"<card wx:if="{{visible}}" id="emit" bind:probe="receive"/>"#,
            false,
        );
        fixture.render();
        fixture.call("hold", json!(["#emit"]));
        let original = fixture.call("routingState", json!([]));
        let held_scope = original["heldScope"].clone();
        fixture.call("hide", json!([]));
        fixture.render();
        let removed = fixture.call("routingState", json!([]));
        for key in ["pageHosts", "retiredScopes"] {
            assert!(
                removed[key].as_object().unwrap().is_empty(),
                "{engine:?}: {removed}"
            );
        }
        assert_eq!(removed["liveScopes"], json!([]));
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], false);
        fixture.call("show", json!([]));
        fixture.render();
        let recreated = fixture.call("routingState", json!([]));
        assert_eq!(recreated["pageHosts"], original["pageHosts"]);
        assert_eq!(recreated["liveScopes"], json!([held_scope]));
        assert!(recreated["retiredScopes"].as_object().unwrap().is_empty());
        assert_eq!(fixture.call("sameHeld", json!(["#emit"])), false);
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], false);
        assert_eq!(
            event_labels(&fixture.call("emit", json!(["#emit", "probe", {}]))),
            ["before", "receive", "after"]
        );

        // Hidden pages retain their own graph; pop must release only the top
        // page's graph and all of its retiring references, even when held.
        fixture.push();
        fixture.render();
        fixture.call("hold", json!(["#emit"]));
        let pushed = fixture.call("routingState", json!([]));
        assert_eq!(pushed["pageHosts"].as_object().unwrap().len(), 2);
        assert_ne!(pushed["heldScope"], original["heldScope"]);
        fixture.dispatch(op::PAGE_POP, json!({}));
        let popped = fixture.call("routingState", json!([]));
        assert_eq!(popped["pageHosts"], original["pageHosts"]);
        assert_eq!(popped["liveScopes"], original["liveScopes"]);
        assert!(popped["retiredScopes"].as_object().unwrap().is_empty());
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], false);
        assert_eq!(
            event_labels(&fixture.call("emit", json!(["#emit", "probe", {}]))),
            ["before", "receive", "after"]
        );
    }
}

#[test]
fn detached_nested_and_projected_sources_use_their_last_physical_routes_and_declaration_owners() {
    let source = r#"Component({lifetimes:{detached:function() {
      this.triggerEvent('probe',{value:this.id},{bubbles:true,composed:true});
    }}});"#;
    for engine in engines() {
        let mut fixture = event_fixture_with_source(
            engine,
            r#"<view id="outer" bind:probe="bubble"><panel wx:if="{{visible}}" id="panel" bind:probe="receive"><card id="emit" slot="content" bind:probe="other"/></panel></view>"#,
            true,
            CapabilitySupport::Partial,
            source,
        );
        fixture.render();
        fixture.call("hold", json!(["#emit"]));
        fixture.call("clearLog", json!([]));
        fixture.call("hide", json!([]));
        fixture.render();
        let value = fixture.call("inspect", json!([]));
        let log = value["log"].as_array().unwrap();
        let internal = log
            .iter()
            .filter(|event| event["value"] == "internal")
            .collect::<Vec<_>>();
        assert_eq!(
            internal
                .iter()
                .map(|event| event["label"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["panel-direct", "panel-bubble", "receive", "bubble"],
            "{engine:?}: {value}"
        );
        assert_eq!(internal[0]["receiver"], "panel");
        assert_eq!(internal[0]["target"], "internal");
        assert_eq!(internal[2]["receiver"], "page");
        assert_eq!(internal[2]["target"], "panel");
        let projected = log
            .iter()
            .filter(|event| event["value"] == "emit")
            .collect::<Vec<_>>();
        assert_eq!(
            projected
                .iter()
                .map(|event| event["label"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["other", "receive", "bubble"],
            "{engine:?}: {value}"
        );
        assert!(projected
            .iter()
            .all(|event| event["receiver"] == "page" && event["target"] == "emit"));
        assert_eq!(fixture.call("emitHeld", json!([]))["ok"], false);
        let released = fixture.call("routingState", json!([]));
        assert!(released["pageHosts"].as_object().unwrap().is_empty());
        assert!(released["retiredScopes"].as_object().unwrap().is_empty());
        assert_eq!(released["liveScopes"], json!([]));
    }
}
