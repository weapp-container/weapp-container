//! Real-engine coverage for the frame publication/diagnostic boundary.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, AppInfo, CapabilitySupport, CompilerInfo, Component,
    ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope,
    Template,
};
use container_render_skia::{RenderNode, Renderer};
use container_simulator::{DevReloadKind, Simulator, SimulatorConfig};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

const ROUTE: &str = "pages/index/index";
const PAGE: &str = "module:pages/index/index.js";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const WXML: &str = r#"<view><text id="value">{{value}}</text><counter/></view>"#;
static NEXT_PACK: AtomicU64 = AtomicU64::new(0);

struct Pack {
    root: PathBuf,
    manifest: ContainerManifestV1,
}

impl Pack {
    fn new(wxml: &str, color: &str, ready_body: &str) -> Self {
        let root = loop {
            let id = NEXT_PACK.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "weapp-render-publication-{}-{id}",
                std::process::id()
            ));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve publication fixture: {error}"),
            }
        };
        fs::create_dir_all(root.join("blobs/sha256")).unwrap();
        let mut pack = Self {
            root,
            manifest: ContainerManifestV1 {
                compiler: CompilerInfo {
                    name: "weapp-vite".into(),
                    commit: "publication-fixture".into(),
                    platform: "weapp".into(),
                },
                app: AppInfo {
                    app_json: "app.json".into(),
                    entry_module: "module:app.js".into(),
                },
                routes: vec![Route {
                    id: format!("route:{ROUTE}"),
                    path: ROUTE.into(),
                    kind: RouteKind::Page,
                    config: Some(format!("{ROUTE}.json")),
                    entry_module: PAGE.into(),
                }],
                capabilities: BTreeMap::from([
                    ("wx.getStorageSync".into(), CapabilitySupport::Full),
                    ("wx.createSelectorQuery".into(), CapabilitySupport::Full),
                    ("wx.setStorage".into(), CapabilitySupport::Full),
                ]),
                ..Default::default()
            },
        };
        let page = format!(
            r#"Page({{
                data:{{value:'before-ready',fail:false}},
                onLoad(query){{getApp().page=this;this.setData({{fail:query.fail==='yes'}});}},
                onReady(){{getApp().ready++;if(this.data.fail){{{ready_body}}}}}
            }});
            exports.inspect=function(){{return {{ready:getApp().ready,clicks:getApp().clicks,
                data:getApp().page.data,stored:wx.getStorageSync('publication')}};}};"#
        );
        for (id, scope, source) in [
            (
                "module:app.js",
                ModuleScope::App,
                "App({ready:0,clicks:0});",
            ),
            (PAGE, ModuleScope::Page, page.as_str()),
            (
                "module:components/counter/index.js",
                ModuleScope::Component,
                "Component({methods:{tap(){getApp().clicks++;}}});",
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
            (TEMPLATE, wxml),
            (
                "template:components/counter/index.wxml",
                r#"<view id="tap" bindtap="tap"><text>tap</text></view>"#,
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
        let bytes = parse_wxss(&format!(
            "view {{ width:200px; min-height:24px; }} text {{ color:{color}; font-size:16px; }}"
        ))
        .unwrap()
        .canonical_json()
        .unwrap();
        let hash = pack.blob(&bytes);
        pack.manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{hash}"),
            scope: StyleScope::App,
        });
        pack.manifest.components.push(Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([(
                "counter".into(),
                "components/counter/index".into(),
            )]),
            multiple_slots: None,
        });
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

    fn start(&self, engine: EngineKind) -> Simulator {
        let mut simulator = Simulator::from_pack_dir(
            &self.root,
            SimulatorConfig {
                engine,
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        simulator
    }
}

impl Drop for Pack {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            if std::thread::panicking() {
                eprintln!("clean publication fixture {}: {error}", self.root.display());
            } else {
                panic!("clean publication fixture {}: {error}", self.root.display());
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

fn dispatch(simulator: &mut Simulator, operation: &str, payload: Value) -> BridgeBatch {
    let request = format!(
        "publication-{}",
        simulator.trace_summary().total_records + 1
    );
    simulator
        .dispatch(BridgeEnvelope::request(
            simulator.session_id().to_owned(),
            request,
            operation,
            payload,
        ))
        .unwrap()
}

fn inspect(simulator: &mut Simulator) -> Value {
    let batch = dispatch(
        simulator,
        op::MODULE_CALL,
        json!({"moduleId":PAGE,"export":"inspect","args":[]}),
    );
    assert_eq!(
        batch.messages[0].payload["ok"],
        true,
        "fixture inspect failed: {}",
        serde_json::to_string_pretty(&batch).unwrap()
    );
    batch.messages[0].payload["result"][0].clone()
}

fn text(node: &RenderNode) -> String {
    let mut value = node.text.clone().unwrap_or_default();
    for child in &node.children {
        value.push_str(&text(child));
    }
    value
}

fn frame_text(simulator: &Simulator) -> String {
    text(
        &simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap()
            .root,
    )
}

fn assert_current_component_is_interactive(simulator: &mut Simulator) {
    let target = {
        let frame = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap();
        let node = frame.query("#tap", false).unwrap()[0];
        node.event_identity.as_ref().unwrap_or(&node.id).clone()
    };
    let clicks = inspect(simulator)["clicks"].as_u64().unwrap();
    let batch = dispatch(
        simulator,
        op::EVENT_BATCH,
        json!({"events":[{"type":"tap","target":target}]}),
    );
    assert_eq!(batch.messages[0].payload["ok"], true);
    assert_eq!(inspect(simulator)["clicks"], clicks + 1);
}

#[test]
fn startup_ready_failure_keeps_published_session_and_pumps_its_writes() {
    for engine in engines() {
        let pack = Pack::new(
            WXML,
            "#123456",
            "this.setData({value:'startup-ready-write'});throw new Error('startup ready publication failed');",
        );
        let mut simulator = Simulator::from_pack_dir(
            &pack.root,
            SimulatorConfig {
                engine,
                launch_options: json!({"query":{"fail":"yes"}}),
                ..SimulatorConfig::default()
            },
        )
        .unwrap();
        let report = simulator
            .run()
            .expect("ready diagnostics cannot unpublish startup");
        assert_eq!(report.session_id, simulator.session_id());
        assert_eq!(simulator.root(), pack.root);
        assert_eq!(simulator.manifest(), &pack.manifest);
        assert_eq!(
            simulator.host().session().unwrap().manifest(),
            &pack.manifest
        );
        let published = simulator.host().render_snapshot().unwrap().frame_id;
        let record = simulator.trace().last().unwrap().clone();
        assert_eq!(record["request"]["op"], op::RENDER_COMMIT);
        assert_eq!(
            record["response"]["messages"][0]["payload"]["committed"],
            true
        );
        let diagnostics = simulator.take_dev_errors();
        assert!(serde_json::to_string(&diagnostics)
            .unwrap()
            .contains("startup ready publication failed"));
        assert!(diagnostics.messages.iter().any(|message| {
            message.payload["committed"] == true && message.payload["frameId"] == published
        }));
        assert!(simulator.take_dev_errors().messages.is_empty());
        assert_eq!(
            inspect(&mut simulator)["data"]["value"],
            "startup-ready-write"
        );
        assert!(frame_text(&simulator).contains("before-ready"));
        assert!(!simulator.pump(1).unwrap().messages.is_empty());
        assert!(simulator.host().render_snapshot().unwrap().frame_id > published);
        assert!(frame_text(&simulator).contains("startup-ready-write"));
        assert!(simulator.pump(1).unwrap().messages.is_empty());
        assert_eq!(inspect(&mut simulator)["ready"], 1);
        assert_current_component_is_interactive(&mut simulator);
    }
}

#[test]
fn published_reload_keeps_generation_and_errors_when_ready_or_callback_throws() {
    let cases = [
        (
            "this.setData({value:'ready-write'});throw new Error('publication ready failed');",
            "ready-write",
            "publication ready failed",
        ),
        (
            "wx.setStorage({key:'publication',data:'stored',success:()=>{this.setData({value:'callback-write'});throw new Error('publication callback failed');}});",
            "callback-write",
            "publication callback failed",
        ),
    ];
    for engine in engines() {
        for (ready, updated, error) in cases {
            let old = Pack::new(WXML, "#123456", ready);
            let next = Pack::new(WXML, "#abcdef", ready);
            let mut simulator = old.start(engine);
            assert!(simulator.take_dev_errors().messages.is_empty());
            assert_eq!(inspect(&mut simulator)["ready"], 1);
            let pushed = dispatch(
                &mut simulator,
                op::PAGE_PUSH,
                json!({"path":ROUTE,"query":{"fail":"yes"}}),
            );
            assert_eq!(pushed.messages[0].payload["ok"], true);
            assert_eq!(
                inspect(&mut simulator)["ready"],
                1,
                "ready waits for pixels"
            );
            let session = simulator.session_id().to_owned();
            let before_frame = simulator.host().render_snapshot().unwrap().frame_id;
            let (kind, report) = simulator.apply_dev_pack(&next.root).unwrap();
            assert_eq!(kind, DevReloadKind::InPlace, "{engine:?}: {error}");
            assert_eq!(simulator.root(), next.root);
            assert_eq!(simulator.session_id(), session);
            assert_eq!(report.session_id, session);
            assert_eq!(simulator.manifest(), &next.manifest);
            assert_eq!(
                simulator.host().session().unwrap().manifest(),
                &next.manifest
            );
            let published = simulator.host().render_snapshot().unwrap().frame_id;
            assert!(published > before_frame);
            let record = simulator.trace().last().unwrap().clone();
            assert_eq!(record["request"]["op"], op::RENDER_COMMIT);
            let acknowledgement = &record["response"]["messages"][0]["payload"];
            assert_eq!(acknowledgement["ok"], true);
            assert_eq!(acknowledgement["committed"], true);
            assert_eq!(acknowledgement["frameId"], published);
            let diagnostics = simulator.take_dev_errors();
            assert!(!diagnostics.messages.is_empty());
            assert!(serde_json::to_string(&diagnostics).unwrap().contains(error));
            assert!(diagnostics
                .messages
                .iter()
                .all(|message| message.op == op::ERROR));
            assert!(simulator.take_dev_errors().messages.is_empty());
            let state = inspect(&mut simulator);
            assert_eq!(state["ready"], 2);
            assert_eq!(state["data"]["value"], updated);
            if updated == "callback-write" {
                assert_eq!(state["stored"], "stored");
            }
            assert!(frame_text(&simulator).contains("before-ready"));
            let pumped = simulator.pump(1).unwrap();
            assert!(pumped.messages.iter().any(|message| {
                message.op == op::RENDER_COMMIT && message.payload["committed"] == true
            }));
            assert!(frame_text(&simulator).contains(updated));
            assert!(simulator.pump(1).unwrap().messages.is_empty());
            assert_eq!(
                inspect(&mut simulator)["ready"],
                2,
                "failed ready is not replayed"
            );
            assert_current_component_is_interactive(&mut simulator);
        }
    }
}

#[test]
fn prepublication_errors_keep_manifest_frame_and_event_ownership() {
    for engine in engines() {
        let old = Pack::new(WXML, "#123456", "");
        let invalid = Pack::new(&WXML.replace("{{value}}", "{{value + }}"), "#abcdef", "");
        let mut simulator = old.start(engine);
        let session = simulator.session_id().to_owned();
        let snapshot = simulator.host().render_snapshot().unwrap();
        let trace = simulator.trace();
        assert!(simulator.apply_dev_pack(&invalid.root).is_err());
        assert_eq!(simulator.root(), old.root);
        assert_eq!(simulator.manifest(), &old.manifest);
        assert_eq!(
            simulator.host().session().unwrap().manifest(),
            &old.manifest
        );
        assert_eq!(simulator.session_id(), session);
        assert_eq!(simulator.host().render_snapshot().unwrap(), snapshot);
        assert_eq!(simulator.trace(), trace, "rejected preview cannot publish");

        let rejected = dispatch(
            &mut simulator,
            op::RENDER_COMMIT,
            json!({"templateId":TEMPLATE,"viewport":{"x":0,"y":0,"width":0,"height":100}}),
        );
        assert_eq!(rejected.messages[0].payload["ok"], false);
        assert_eq!(rejected.messages[0].payload["committed"], false);
        assert_eq!(simulator.host().render_snapshot().unwrap(), snapshot);
        assert_eq!(
            simulator.host().session().unwrap().manifest(),
            &old.manifest
        );
        assert_current_component_is_interactive(&mut simulator);
    }
}

#[test]
fn external_presenter_defers_ready_and_geometry_without_rasterizing() {
    for engine in engines() {
        for wxml in [WXML, r#"<view><text id="value">{{value}}</text></view>"#] {
            let pack = Pack::new(wxml, "red", "");
            let mut simulator = Simulator::from_pack_dir(
                &pack.root,
                SimulatorConfig {
                    engine,
                    page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
                    render_scale: 2.0,
                    ..SimulatorConfig::default()
                },
            )
            .unwrap();
            simulator.run().unwrap();
            assert_eq!(
                inspect(&mut simulator)["ready"],
                0,
                "CPU acceptance is not presentation"
            );
            assert!(simulator.host().render_snapshot_ref().is_err());
            let before_geometry = dispatch(
                &mut simulator,
                op::API_CALL,
                json!({"name":"wx.createSelectorQuery","selector":"#value"}),
            );
            assert_eq!(before_geometry.messages[0].payload["ok"], false);
            assert_eq!(
                before_geometry.messages[0].payload["error"]["code"],
                "ERR_RENDER"
            );
            let before_input = dispatch(
                &mut simulator,
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":1,"y":1}]}),
            );
            assert_eq!(
                before_input.messages[0].payload["error"]["code"],
                "ERR_CANCELLED"
            );
            assert!(simulator
                .host()
                .session()
                .unwrap()
                .view_document()
                .is_some());
            let revision = simulator.host().render_revision();
            assert!(simulator
                .host_mut()
                .acknowledge_presentation_json(revision + 1)
                .is_err());
            let first = simulator
                .host_mut()
                .acknowledge_presentation_json(revision)
                .unwrap();
            let first: BridgeBatch = serde_json::from_slice(&first).unwrap();
            assert!(!first.messages.iter().any(|message| message.op == op::ERROR));
            assert_eq!(inspect(&mut simulator)["ready"], 1);
            let after_geometry = dispatch(
                &mut simulator,
                op::API_CALL,
                json!({"name":"wx.createSelectorQuery","selector":"#value"}),
            );
            assert_eq!(after_geometry.messages[0].payload["ok"], true);
            simulator
                .host_mut()
                .acknowledge_presentation_json(revision)
                .unwrap();
            assert_eq!(
                inspect(&mut simulator)["ready"],
                1,
                "duplicate receipt must not repeat ready"
            );
            let viewport = simulator.viewport();
            simulator.apply_presentation(viewport, 1.5).unwrap();
            assert!(simulator.host().render_snapshot_ref().is_err());
            let next = simulator.host().render_revision();
            assert!(next > revision);
            assert!(simulator
                .host_mut()
                .acknowledge_presentation_json(revision)
                .is_err());
            simulator
                .host_mut()
                .acknowledge_presentation_json(next)
                .unwrap();
            assert_eq!(
                inspect(&mut simulator)["ready"],
                1,
                "DPR does not re-execute lifecycle"
            );
        }
    }
}
