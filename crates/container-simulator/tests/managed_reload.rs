//! Public pack/reload integration coverage for managed component heaps.
//! Every pack contains real JavaScript, parsed WXML and component relations.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, AppInfo, CompilerInfo, Component, ContainerManifestV1,
    Module, ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope, Template,
};
use container_render_skia::{RenderNode, Renderer};
use container_simulator::{classify_manifest_reload, DevReloadKind, Simulator, SimulatorConfig};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const APP: &str = "module:app.js";
const PAGE: &str = "module:pages/index/index.js";
const PAGE_WXML: &str =
    r#"<view><text class="page-count">{{pageCount}}</text><counter label="{{label}}"/></view>"#;
const COUNTER_WXML: &str = r#"<view id="counter-button" bindtap="tap"><text class="caption">Before {{label}}:{{count}}</text></view>"#;
const ATTACHED_FAILURE: &str = "managed reload attached failure";
static NEXT_PACK: AtomicU64 = AtomicU64::new(1);

const APP_JS: &str = "App({saved:[],next:0,events:[]});";
const PAGE_JS: &str = r#"
Page({data:{pageCount:0,label:'parent'},onLoad(){getApp().page=this;}});
exports.bump=function(){getApp().page.setData({pageCount:getApp().page.data.pageCount+1,label:'edited'});};
exports.inspect=function(){return {
  page:getApp().page.data,
  components:getApp().saved.map(function(component){return {id:component.fixtureId,count:component.data.count,label:component.properties.label};}),
  events:getApp().events
};};
"#;
const COUNTER_JS: &str = r#"
Component({
  properties:{label:{type:String,value:'default'}},data:{count:0},
  lifetimes:{
    created(){this.fixtureId=++getApp().next;getApp().saved.push(this);getApp().events.push({kind:'created',id:this.fixtureId});},
    attached(){getApp().events.push({kind:'attached',id:this.fixtureId});/*ATTACHED_BODY*/},
    ready(){getApp().events.push({kind:'ready',id:this.fixtureId});},
    detached(){getApp().events.push({kind:'detached',id:this.fixtureId});}
  },
  methods:{tap(){this.setData({count:this.data.count+1});}}
});
"#;
const RECURSIVE_JS: &str =
    "Component({data:{show:false},lifetimes:{attached(){this.setData({show:true});}}});";

struct Pack {
    root: PathBuf,
    manifest: ContainerManifestV1,
}

impl Pack {
    fn new(page: &str, counter: &str, throwing: bool) -> Self {
        let root = loop {
            let nonce = NEXT_PACK.fetch_add(1, Ordering::Relaxed);
            let candidate = std::env::temp_dir().join(format!(
                "weapp-managed-reload-{}-{nonce}",
                std::process::id()
            ));
            match fs::create_dir(&candidate) {
                Ok(()) => break candidate,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve managed reload pack: {error}"),
            }
        };
        let mut pack = Self {
            root,
            manifest: ContainerManifestV1::default(),
        };
        fs::create_dir(pack.root.join("blobs")).unwrap();
        fs::create_dir(pack.root.join("blobs/sha256")).unwrap();
        pack.manifest.compiler = CompilerInfo {
            name: "weapp-vite".into(),
            commit: "managed-reload-fixture".into(),
            platform: "weapp".into(),
        };
        pack.manifest.app = AppInfo {
            app_json: "app.json".into(),
            entry_module: APP.into(),
        };
        pack.manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: Some("pages/index/index.json".into()),
            entry_module: PAGE.into(),
        });
        let counter_js = COUNTER_JS.replace(
            "/*ATTACHED_BODY*/",
            if throwing {
                "throw new Error('managed reload attached failure');"
            } else {
                ""
            },
        );
        for (id, source, scope) in [
            (APP, APP_JS, ModuleScope::App),
            (PAGE, PAGE_JS, ModuleScope::Page),
            (
                "module:components/counter/index.js",
                counter_js.as_str(),
                ModuleScope::Component,
            ),
            (
                "module:components/recursive/index.js",
                RECURSIVE_JS,
                ModuleScope::Component,
            ),
        ] {
            let hash = pack.blob(source.as_bytes());
            pack.manifest.modules.push(Module {
                id: id.into(),
                sha256: hash,
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
        }
        for (id, source) in [
            ("template:pages/index/index.wxml", page),
            ("template:components/counter/index.wxml", counter),
            (
                "template:components/recursive/index.wxml",
                r#"<view><recursive wx:if="{{show}}"/></view>"#,
            ),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let hash = pack.blob(&bytes);
            pack.manifest.templates.push(Template {
                id: id.into(),
                wxml_ast: format!("sha256:{hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            });
        }
        let styles = parse_wxss(
            "view { width:200px; min-height:24px; } text { font-size:16px; line-height:20px; }",
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let hash = pack.blob(&styles);
        pack.manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{hash}"),
            scope: StyleScope::App,
        });
        for (owner, tags) in [
            (
                "pages/index/index.json",
                vec![
                    ("counter", "components/counter/index"),
                    ("recursive", "components/recursive/index"),
                ],
            ),
            ("components/counter/index.json", vec![]),
            (
                "components/recursive/index.json",
                vec![("recursive", "components/recursive/index")],
            ),
        ] {
            pack.manifest.components.push(Component {
                id: format!("components:{owner}"),
                owner: owner.into(),
                using_components: tags
                    .into_iter()
                    .map(|(tag, path)| (tag.into(), path.into()))
                    .collect::<BTreeMap<_, _>>(),
                multiple_slots: None,
            });
        }
        pack.manifest.refresh_integrity().unwrap();
        fs::write(
            pack.root.join("manifest.json"),
            serde_json::to_vec(&pack.manifest).unwrap(),
        )
        .unwrap();
        pack
    }

    fn blob(&self, bytes: &[u8]) -> String {
        let hash = hex_digest(bytes);
        fs::write(self.root.join("blobs/sha256").join(&hash), bytes).unwrap();
        hash
    }

    fn change_style(&mut self, source: &str) {
        let bytes = parse_wxss(source).unwrap().canonical_json().unwrap();
        let hash = self.blob(&bytes);
        self.manifest.styles[0].wxss_ir = format!("sha256:{hash}");
        self.manifest.refresh_integrity().unwrap();
        fs::write(
            self.root.join("manifest.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
    }

    fn start(&self, engine: EngineKind) -> Simulator {
        let mut simulator = Simulator::from_pack_dir(
            &self.root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().expect("managed fixture starts");
        assert_no_failed_responses(&simulator.trace());
        simulator
    }
}

impl Drop for Pack {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            if std::thread::panicking() {
                eprintln!(
                    "failed to clean managed pack {}: {error}",
                    self.root.display()
                );
            } else {
                panic!(
                    "failed to clean managed pack {}: {error}",
                    self.root.display()
                );
            }
        }
    }
}

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn dispatch(simulator: &mut Simulator, operation: &str, payload: Value) -> Value {
    let request = format!(
        "managed-reload-test-{}",
        simulator.trace_summary().total_records + 1
    );
    let session = simulator.session_id().to_owned();
    let batch = simulator
        .dispatch(BridgeEnvelope::request(
            session, request, operation, payload,
        ))
        .unwrap();
    assert_eq!(
        batch.messages[0].payload["ok"], true,
        "{operation}: {:?}",
        batch.messages
    );
    batch.messages[0].payload.clone()
}

fn inspect(simulator: &mut Simulator) -> Value {
    dispatch(
        simulator,
        op::MODULE_CALL,
        json!({"moduleId":PAGE,"export":"inspect"}),
    )["result"][0]
        .clone()
}

fn edit_state(simulator: &mut Simulator) {
    dispatch(
        simulator,
        op::MODULE_CALL,
        json!({"moduleId":PAGE,"export":"bump"}),
    );
    let target = {
        let frame = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap();
        let button = frame.query("#counter-button", false).unwrap()[0];
        button.event_identity.as_ref().unwrap_or(&button.id).clone()
    };
    dispatch(
        simulator,
        op::EVENT_BATCH,
        json!({"events":[{"type":"tap","target":target}]}),
    );
    simulator.pump(1).unwrap();
}

fn text(node: &RenderNode) -> String {
    let mut result = node.text.clone().unwrap_or_default();
    for child in &node.children {
        result.push_str(&text(child));
    }
    result
}

fn caption(simulator: &Simulator) -> String {
    let frame = simulator
        .host()
        .session()
        .unwrap()
        .renderer()
        .last_frame()
        .unwrap();
    text(frame.query(".caption", false).unwrap()[0])
}

fn scope(simulator: &Simulator) -> String {
    simulator
        .host()
        .session()
        .unwrap()
        .renderer()
        .last_frame()
        .unwrap()
        .query("counter", false)
        .unwrap()[0]
        .component_scope_id
        .clone()
        .expect("managed counter scope")
}

fn assert_no_failed_responses(trace: &[Value]) {
    for record in trace {
        for message in record["response"]["messages"].as_array().unwrap() {
            assert_ne!(
                message["payload"]["ok"], false,
                "unexpected failed response: {message}"
            );
        }
    }
}

fn diagnostic_count(simulator: &Simulator, needle: &str) -> usize {
    simulator
        .trace()
        .iter()
        .flat_map(|record| {
            record["response"]["messages"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter(|message| message["op"] == op::ERROR)
        .flat_map(|message| {
            message["payload"]["errors"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .filter(|error| {
            error["message"]
                .as_str()
                .is_some_and(|message| message.contains(needle))
        })
        .count()
}

#[test]
fn component_default_data_and_property_mutations_invalidate_without_page_set_data() {
    for engine in engines() {
        let pack = Pack::new("<view><counter/></view>", COUNTER_WXML, false);
        let mut simulator = pack.start(engine);
        assert_eq!(caption(&simulator), "Before default:0");
        let initial = inspect(&mut simulator);
        let inputs = simulator.host().session().unwrap().view().template_revision;
        let target = {
            let frame = simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap();
            let node = frame.query("#counter-button", false).unwrap()[0];
            node.event_identity.as_ref().unwrap_or(&node.id).clone()
        };
        dispatch(
            &mut simulator,
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","target":target}]}),
        );
        assert!(simulator.host().session().unwrap().view().template_revision > inputs);
        let updated = inspect(&mut simulator);
        assert_eq!(
            updated["page"], initial["page"],
            "component mutation does not patch its page"
        );
        assert_eq!(updated["components"][0]["count"], 1);
        let render = simulator.pump(1).unwrap();
        assert!(render
            .messages
            .iter()
            .any(|message| message.op == op::RENDER_COMMIT));
        assert_eq!(caption(&simulator), "Before default:1");
        let revision = simulator.host().render_revision();
        assert!(simulator.pump(1).unwrap().messages.is_empty());
        assert_eq!(simulator.host().render_revision(), revision);
    }
}

#[test]
fn component_text_reload_keeps_live_session_page_data_and_component_instances() {
    for engine in engines() {
        let old = Pack::new(PAGE_WXML, COUNTER_WXML, false);
        let next = Pack::new(PAGE_WXML, &COUNTER_WXML.replace("Before ", "After "), false);
        let mut simulator = old.start(engine);
        edit_state(&mut simulator);
        let before = inspect(&mut simulator);
        let session = simulator.session_id().to_owned();
        let component_scope = scope(&simulator);
        assert_eq!(before["page"]["pageCount"], 1);
        assert_eq!(before["components"][0]["count"], 1);
        let (kind, _) = simulator
            .apply_dev_pack(&next.root)
            .expect("presentation-only component reload succeeds");
        assert_eq!(kind, DevReloadKind::InPlace, "{engine:?}");
        assert_eq!(simulator.session_id(), session);
        assert_eq!(scope(&simulator), component_scope);
        assert_eq!(caption(&simulator), "After edited:1");
        assert_eq!(
            inspect(&mut simulator),
            before,
            "presentation reload must not rerun component lifecycles"
        );
        assert_no_failed_responses(&simulator.trace());
    }
}

#[test]
fn presentation_reload_updates_component_selection_and_custom_event_metadata() {
    const MARKUP: &str = r#"<view id="old-shell" class="old-shell" data-version="old" mark:version="old" bind:probe="onProbe"><counter class="counter"/></view>"#;
    let script = format!(
        r#"{PAGE_JS}
exports.probe=function(){{
  const page=getApp().page;
  const events=[];
  page.onProbe=function(event){{events.push({{id:event.currentTarget.id,dataset:event.currentTarget.dataset,mark:event.mark}});}};
  const oldSelection=!!page.selectComponent('#old-shell > .counter');
  const newSelection=!!page.selectComponent('#new-shell > .counter');
  getApp().saved[0].triggerEvent('probe',{{}},{{bubbles:true,composed:true}});
  return {{oldSelection,newSelection,events}};
}};
exports.installHooks=function(){{getApp().jsonHooks=0;Array.prototype.toJSON=function(){{getApp().jsonHooks++;return this;}};}};
exports.readHooks=function(){{const value=getApp().jsonHooks;getApp().jsonHooks=0;return value;}};
exports.removeHooks=function(){{delete Array.prototype.toJSON;}};
exports.freezeIndexes=function(){{Object.freeze(__container_component_selection_pages);}};
"#
    );
    for engine in engines() {
        for external in [false, true] {
            let mut old = Pack::new(MARKUP, COUNTER_WXML, false);
            let mut next = Pack::new(&MARKUP.replace("old", "new"), COUNTER_WXML, false);
            for pack in [&mut old, &mut next] {
                for api in ["Page.selectComponent", "Component.triggerEvent"] {
                    pack.manifest
                        .capabilities
                        .insert(api.into(), container_ir::CapabilitySupport::Partial);
                }
                let hash = pack.blob(script.as_bytes());
                pack.manifest
                    .modules
                    .iter_mut()
                    .find(|module| module.id == PAGE)
                    .unwrap()
                    .sha256 = hash;
                pack.manifest.refresh_integrity().unwrap();
                fs::write(
                    pack.root.join("manifest.json"),
                    serde_json::to_vec(&pack.manifest).unwrap(),
                )
                .unwrap();
            }
            let mut simulator = if external {
                let mut simulator = Simulator::from_pack_dir(
                    &old.root,
                    SimulatorConfig {
                        engine,
                        page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
                        ..SimulatorConfig::default()
                    },
                )
                .unwrap();
                simulator.run().unwrap();
                simulator
            } else {
                old.start(engine)
            };
            let probe = |simulator: &mut Simulator| {
                dispatch(
                    simulator,
                    op::MODULE_CALL,
                    json!({"moduleId":PAGE,"export":"probe"}),
                )["result"][0]
                    .clone()
            };
            assert_eq!(
                probe(&mut simulator),
                json!({"oldSelection":true,"newSelection":false,"events":[{"id":"old-shell","dataset":{"version":"old"},"mark":{"version":"old"}}]})
            );
            let guest_call = |simulator: &mut Simulator, name: &str| {
                dispatch(
                    simulator,
                    op::MODULE_CALL,
                    json!({"moduleId":PAGE,"export":name}),
                )["result"][0]
                    .clone()
            };
            let ordinary_hooks = if external {
                guest_call(&mut simulator, "installHooks");
                guest_call(&mut simulator, "readHooks");
                Some(guest_call(&mut simulator, "readHooks"))
            } else {
                None
            };
            assert_eq!(
                simulator.apply_dev_pack(&next.root).unwrap().0,
                DevReloadKind::InPlace
            );
            if let Some(ordinary_hooks) = ordinary_hooks {
                assert_eq!(guest_call(&mut simulator,"readHooks"),ordinary_hooks,"native index stage/commit must not invoke inherited toJSON before presentation");
                guest_call(&mut simulator, "removeHooks");
            }
            assert_eq!(
                probe(&mut simulator),
                json!({"oldSelection":false,"newSelection":true,"events":[{"id":"new-shell","dataset":{"version":"new"},"mark":{"version":"new"}}]}),
                "{engine:?}: component JS indexes must follow the accepted presentation"
            );
            guest_call(&mut simulator, "freezeIndexes");
            let accepted = simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap()
                .clone();
            let trace = simulator.trace();
            let accepted_root = simulator.root().to_path_buf();
            assert!(simulator.apply_dev_pack(&old.root).is_err());
            assert_eq!(
                simulator.host().session().unwrap().renderer().last_frame(),
                Some(&accepted)
            );
            assert_eq!(simulator.trace(), trace);
            assert_eq!(simulator.root(), accepted_root);
            assert_eq!(probe(&mut simulator)["newSelection"], true);
        }
    }
}

#[test]
fn component_template_selection_uses_live_data_during_presentation_reload() {
    let source = format!(
        r#"<template name="row">{COUNTER_WXML}</template><template is="{{{{count !== undefined ? 'row' : 'missing'}}}}"/>"#
    );
    for engine in engines() {
        let old = Pack::new(PAGE_WXML, &source, false);
        let next = Pack::new(PAGE_WXML, &source.replace("Before ", "After "), false);
        let mut styled = Pack::new(PAGE_WXML, &source.replace("Before ", "After "), false);
        styled.change_style("view { width:220px; min-height:24px; } text { color:#123456; font-size:16px; line-height:20px; }");
        let mut simulator = old.start(engine);
        edit_state(&mut simulator);
        let before = inspect(&mut simulator);
        let session = simulator.session_id().to_owned();
        let component_scope = scope(&simulator);
        let (kind, _) = simulator
            .apply_dev_pack(&next.root)
            .expect("component template selection retains its live data during preview");
        assert_eq!(kind, DevReloadKind::InPlace, "{engine:?}");
        assert_eq!(simulator.session_id(), session);
        assert_eq!(scope(&simulator), component_scope);
        assert_eq!(caption(&simulator), "After edited:1");
        assert_eq!(inspect(&mut simulator), before);
        let (kind, _) = simulator
            .apply_dev_pack(&styled.root)
            .expect("style reload uses the same live component template context");
        assert_eq!(kind, DevReloadKind::InPlace);
        assert_eq!(simulator.session_id(), session);
        assert_eq!(scope(&simulator), component_scope);
        assert_eq!(caption(&simulator), "After edited:1");
        assert_eq!(inspect(&mut simulator), before);

        let invalid = Pack::new(
            PAGE_WXML,
            &source.replace("Before {{label}}:{{count}}", "Broken {{count + }}"),
            false,
        );
        let trace = simulator.trace();
        let snapshot = simulator.host().render_snapshot().unwrap();
        assert!(simulator.apply_dev_pack(&invalid.root).is_err());
        assert_eq!(
            simulator.trace(),
            trace,
            "preview must not dispatch to the live session"
        );
        assert_eq!(simulator.host().render_snapshot().unwrap(), snapshot);
        assert_eq!(simulator.session_id(), session);
        assert_eq!(scope(&simulator), component_scope);
        assert_eq!(inspect(&mut simulator), before);
        assert_no_failed_responses(&simulator.trace());
    }
}

#[test]
fn component_input_reload_restarts_in_an_isolated_session() {
    for engine in engines() {
        let old = Pack::new(PAGE_WXML, COUNTER_WXML, false);
        let next = Pack::new(
            &PAGE_WXML.replace(r#"label="{{label}}""#, r#"label="changed-input""#),
            COUNTER_WXML,
            false,
        );
        assert_eq!(
            classify_manifest_reload(&old.manifest, &next.manifest),
            DevReloadKind::InPlace,
            "manifest-only classification cannot see changed component inputs"
        );
        let mut simulator = old.start(engine);
        edit_state(&mut simulator);
        let previous = simulator.session_id().to_owned();
        let (kind, _) = simulator
            .apply_dev_pack(&next.root)
            .expect("changed component input starts a valid replacement");
        assert_eq!(kind, DevReloadKind::Restart);
        assert_ne!(simulator.session_id(), previous);
        let state = inspect(&mut simulator);
        assert_eq!(state["page"]["pageCount"], 0);
        assert_eq!(state["components"][0]["count"], 0);
        assert_eq!(state["components"][0]["label"], "changed-input");
        assert_no_failed_responses(&simulator.trace());
    }
}

#[test]
fn rejected_dynamic_recursive_component_reload_leaves_every_live_boundary_unchanged() {
    for engine in engines() {
        let old = Pack::new(PAGE_WXML, COUNTER_WXML, false);
        let candidate = Pack::new(
            &PAGE_WXML.replace("<counter ", "<recursive/><counter "),
            COUNTER_WXML,
            false,
        );
        assert_eq!(
            classify_manifest_reload(&old.manifest, &candidate.manifest),
            DevReloadKind::InPlace,
            "only WXML changed; decoded managed topology must trigger isolation"
        );
        let mut simulator = old.start(engine);
        edit_state(&mut simulator);
        let state = inspect(&mut simulator);
        let manifest = serde_json::to_value(simulator.manifest()).unwrap();
        let session = simulator.session_id().to_owned();
        let snapshot = simulator.host().render_snapshot().unwrap();
        let trace = simulator.trace();
        let summary = serde_json::to_value(simulator.trace_summary()).unwrap();
        let root = simulator.root().to_path_buf();
        let component_scope = scope(&simulator);
        let error = simulator
            .apply_dev_pack(&candidate.root)
            .expect_err("attached-driven recursion must reject the isolated candidate");
        let message = error.to_string();
        assert!(
            message.contains("depth") || message.contains("converge"),
            "unexpected candidate failure: {message}"
        );
        assert_eq!(simulator.root(), Path::new(&root));
        assert_eq!(simulator.session_id(), session);
        assert_eq!(
            serde_json::to_value(simulator.manifest()).unwrap(),
            manifest
        );
        assert_eq!(simulator.host().render_snapshot().unwrap(), snapshot);
        assert_eq!(
            simulator.trace(),
            trace,
            "candidate diagnostics must not mutate live trace"
        );
        assert_eq!(
            serde_json::to_value(simulator.trace_summary()).unwrap(),
            summary
        );
        assert_eq!(scope(&simulator), component_scope);
        assert_eq!(
            inspect(&mut simulator),
            state,
            "the rejected candidate must not mutate the live JavaScript heap"
        );
        edit_state(&mut simulator);
        let continued = inspect(&mut simulator);
        assert_eq!(continued["page"]["pageCount"], 2);
        assert_eq!(
            continued["components"][0]["count"], 2,
            "old component remains interactive after rejection"
        );
        assert_no_failed_responses(&simulator.trace());
    }
}

#[test]
fn caught_attached_error_is_reported_once_without_component_graph_convergence_failure() {
    for engine in engines() {
        let pack = Pack::new(PAGE_WXML, COUNTER_WXML, true);
        let mut simulator = pack.start(engine);
        assert_eq!(diagnostic_count(&simulator, ATTACHED_FAILURE), 1);
        for _ in 0..3 {
            simulator.pump(1).unwrap();
        }
        edit_state(&mut simulator);
        let state = inspect(&mut simulator);
        assert_eq!(state["components"][0]["count"], 1);
        assert_eq!(
            state["events"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|event| event["kind"] == "attached")
                .count(),
            1
        );
        assert_eq!(
            diagnostic_count(&simulator, ATTACHED_FAILURE),
            1,
            "caught hook must not retry during graph reconciliation"
        );
        assert_no_failed_responses(&simulator.trace());
    }
}
