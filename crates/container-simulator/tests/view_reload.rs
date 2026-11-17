//! Stateful native View coverage through the public Simulator pack/reload API.
//! These fixtures verify development reload semantics, not official WXS parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, parse_wxss, wxml_bindings, AppInfo, CapabilitySupport, CompilerInfo,
    ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind, Style, StyleScope,
    Template, ViewScriptModule,
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
const WXS: &str = "wxs:helpers/counter.wxs";
const DOCUMENT: &str = r#"<wxs module="tools" src="../../helpers/counter.wxs"/><view><text id="value">{{label}}/{{edits}}/{{tools.next()}}</text></view>"#;
const APP_JS: &str = "App({launches:0,onLaunch(){this.launches++;}});";
const PAGE_JS: &str = r#"
Page({data:{label:'initial',edits:0},onLoad(){getApp().page=this;}});
exports.edit=function(){
    var page=getApp().page;
    page.setData({label:'edited',edits:page.data.edits+1});
    wx.setStorageSync('view-reload','persisted');
};
exports.inspect=function(){return {
    data:getApp().page.data,launches:getApp().launches,
    stored:wx.getStorageSync('view-reload')
};};
"#;
const WXS_JS: &str = "var calls=0;exports.next=function(){return ++calls};exports.fail=function(){throw new Error('candidate View failure')};";
static NEXT_PACK: AtomicU64 = AtomicU64::new(0);

struct Pack {
    root: PathBuf,
    manifest: ContainerManifestV1,
}

impl Pack {
    fn new(document: &str, color: &str) -> Self {
        let root = loop {
            let nonce = NEXT_PACK.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("weapp-view-reload-{}-{nonce}", std::process::id()));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve View reload fixture: {error}"),
            }
        };
        fs::create_dir_all(root.join("blobs/sha256")).unwrap();
        let mut pack = Self {
            root,
            manifest: ContainerManifestV1 {
                compiler: CompilerInfo {
                    name: "weapp-vite".into(),
                    commit: "view-reload-fixture".into(),
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
                    ("wx.setStorageSync".into(), CapabilitySupport::Full),
                ]),
                ..Default::default()
            },
        };
        for (id, scope, source) in [
            ("module:app.js", ModuleScope::App, APP_JS),
            (PAGE, ModuleScope::Page, PAGE_JS),
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
        let ast = parse_wxml(document).unwrap();
        let hash = pack.blob(&ast.canonical_json().unwrap());
        pack.manifest.templates.push(Template {
            id: format!("template:{ROUTE}.wxml"),
            wxml_ast: format!("sha256:{hash}"),
            bindings: wxml_bindings(&ast),
            wxs_modules: BTreeMap::from([("tools".into(), WXS.into())]),
        });
        let hash = pack.blob(WXS_JS.as_bytes());
        pack.manifest.view_scripts.push(ViewScriptModule {
            id: WXS.into(),
            sha256: hash,
            dependencies: vec![],
        });
        let styles = parse_wxss(&format!(
            "view {{ width:240px; min-height:24px; background-color:{color}; }} text {{ color:#102030; font-size:16px; }}"
        ))
        .unwrap();
        let hash = pack.blob(&styles.canonical_json().unwrap());
        pack.manifest.styles.push(Style {
            id: "style:app.wxss".into(),
            wxss_ir: format!("sha256:{hash}"),
            scope: StyleScope::App,
        });
        pack.manifest.refresh_integrity().unwrap();
        fs::write(
            pack.root.join("manifest.json"),
            serde_json::to_vec(&pack.manifest).unwrap(),
        )
        .unwrap();
        pack
    }

    fn modern_counter() -> Self {
        let mut pack = Self::new(
            r#"<view><text id="value">{{label}}/{{edits}}/{{tools.next()}}</text></view>"#,
            "#ffffff",
        );
        pack.manifest.schema_version = 2;
        pack.manifest.view_scripts.clear();
        pack.manifest.templates[0].wxs_modules.clear();
        let executable = pack.blob(br#"let calls=0;module.exports={"pages/index/index.wxml":{tools:{next(){return ++calls}}}};"#);
        let source = pack.blob(b"export function next(): number { return ++calls; }");
        let source_map = pack
            .blob(br#"{"version":3,"sources":["view/counter.view.ts"],"names":[],"mappings":""}"#);
        pack.manifest.modern_view = Some(container_ir::ModernViewCompilation {
            compiler: "weapp-container-modern-view".into(),
            version: "1.0.0".into(),
            abi: "1.0".into(),
            target: "es2022".into(),
            units: vec![container_ir::ModernViewUnit {
                id: format!("modern:{executable}"),
                executable_sha256: executable,
                source_map_sha256: source_map,
                sources: vec![container_ir::ModernViewSource {
                    path: "view/counter.view.ts".into(),
                    sha256: source,
                }],
                documents: vec![container_ir::ModernViewDocument {
                    document_id: format!("{ROUTE}.wxml"),
                    aliases: vec!["tools".into()],
                }],
            }],
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

    fn set_page_source(&mut self, source: &str) {
        let hash = self.blob(source.as_bytes());
        self.manifest
            .modules
            .iter_mut()
            .find(|module| module.id == PAGE)
            .unwrap()
            .sha256 = hash;
        self.save();
    }

    fn make_scrollable(&mut self) {
        let ast = parse_wxml(
            r#"<view style="height:1800px"><text id="value">{{label}}/{{edits}}/{{tools.next()}}</text></view>"#,
        )
        .unwrap();
        let hash = self.blob(&ast.canonical_json().unwrap());
        self.manifest.templates[0].wxml_ast = format!("sha256:{hash}");
        self.manifest.templates[0].bindings = wxml_bindings(&ast);
        self.save();
    }

    fn save(&mut self) {
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
        simulator.run().expect("native View fixture starts");
        assert_eq!(frame_text(&simulator), "initial/0/1");
        simulator
    }
}

impl Drop for Pack {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.root) {
            if std::thread::panicking() {
                eprintln!("clean View reload fixture {}: {error}", self.root.display());
            } else {
                panic!("clean View reload fixture {}: {error}", self.root.display());
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

fn call(simulator: &mut Simulator, export: &str) -> Value {
    let request = format!(
        "view-reload-{}",
        simulator.trace_summary().total_records + 1
    );
    let result = simulator
        .dispatch(BridgeEnvelope::request(
            simulator.session_id().to_owned(),
            request,
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":export,"args":[]}),
        ))
        .unwrap();
    assert_eq!(
        result.messages[0].payload["ok"], true,
        "{export}: {:?}",
        result.messages
    );
    result.messages[0].payload["result"][0].clone()
}

fn edit(simulator: &mut Simulator) {
    call(simulator, "edit");
    let rendered = simulator.pump(1).unwrap();
    assert!(rendered
        .messages
        .iter()
        .any(|message| message.op == op::RENDER_COMMIT && message.payload["ok"] == true));
}

fn frame_text(simulator: &Simulator) -> String {
    fn text(node: &RenderNode) -> String {
        let mut output = node.text.clone().unwrap_or_default();
        for child in &node.children {
            output.push_str(&text(child));
        }
        output
    }
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

fn wheel(simulator: &mut Simulator) {
    let batch = simulator
        .dispatch(BridgeEnvelope::request(
            simulator.session_id().to_owned(),
            format!("wheel-{}", simulator.trace_summary().total_records),
            op::EVENT_BATCH,
            json!({"events":[{"type":"wheel","x":100,"y":100,"deltaX":0,"deltaY":24,"deltaMode":0}]}),
        ))
        .unwrap();
    for response in batch.messages {
        assert_ne!(response.payload["ok"], false, "{response:?}");
        assert_ne!(response.op, op::ERROR, "{response:?}");
    }
}

#[test]
fn scroll_pixels_and_event_activity_do_not_invalidate_wxs_or_modern_templates() {
    for engine in engines() {
        for modern in [false, true] {
            let mut pack = if modern {
                Pack::modern_counter()
            } else {
                Pack::new(DOCUMENT, "#ffffff")
            };
            pack.make_scrollable();
            let mut simulator = pack.start(engine);
            let view = simulator.host().session().unwrap().view().clone();
            let mut pixel_revision = simulator.host().render_revision();
            let initial_pixels = simulator
                .host()
                .render_snapshot_ref()
                .unwrap()
                .pixels
                .clone();
            for _ in 0..3 {
                wheel(&mut simulator);
                assert!(simulator.host().render_revision() > pixel_revision);
                pixel_revision = simulator.host().render_revision();
                let current = simulator.host().session().unwrap().view();
                assert!(
                    current.revision > view.revision,
                    "keep public event accounting"
                );
                assert_eq!(current.template_revision, view.template_revision);
                let batch = simulator.pump(1).unwrap();
                assert!(
                    !batch
                        .messages
                        .iter()
                        .any(|message| message.op == op::RENDER_COMMIT),
                    "scroll already committed its pixels: {engine:?}, modern={modern}"
                );
                assert_eq!(simulator.host().render_revision(), pixel_revision);
                assert_eq!(frame_text(&simulator), "initial/0/1");
            }
            assert_ne!(
                simulator.host().render_snapshot_ref().unwrap().pixels,
                initial_pixels
            );
            assert_eq!(
                simulator.host().session().unwrap().view().event_count,
                view.event_count + 3
            );
            // A later real mutation must still reach the surviving View heap,
            // exactly once, after native scroll-only presentations.
            edit(&mut simulator);
            assert_eq!(frame_text(&simulator), "edited/1/2");
        }
    }
}

#[test]
fn scroll_handler_set_data_still_invalidates_template_inputs() {
    for engine in engines() {
        let mut pack = Pack::new(DOCUMENT, "#ffffff");
        pack.make_scrollable();
        pack.set_page_source(&PAGE_JS.replace(
            "onLoad(){getApp().page=this;}",
            "onLoad(){getApp().page=this;},onPageScroll(){this.setData({label:'scrolled',edits:this.data.edits+1});}",
        ));
        let mut simulator = pack.start(engine);
        let before = simulator.host().session().unwrap().view().template_revision;
        wheel(&mut simulator);
        let scroll_revision = simulator.host().render_revision();
        assert!(simulator.host().session().unwrap().view().template_revision > before);
        assert!(simulator
            .pump(1)
            .unwrap()
            .messages
            .iter()
            .any(|message| { message.op == op::RENDER_COMMIT && message.payload["ok"] == true }));
        assert!(simulator.host().render_revision() > scroll_revision);
        assert_eq!(frame_text(&simulator), "scrolled/1/2");
        let settled = simulator.host().render_revision();
        assert!(simulator.pump(1).unwrap().messages.is_empty());
        assert_eq!(simulator.host().render_revision(), settled);
    }
}

#[test]
fn failed_automatic_render_waits_for_new_input_without_hiding_explicit_errors() {
    for engine in engines() {
        let mut pack = Pack::new(
            &DOCUMENT.replace("{{tools.next()}}", "{{bad ? tools.fail() : tools.next()}}"),
            "#ffffff",
        );
        pack.set_page_source(&format!(
            "{PAGE_JS}\nexports.breakView=function(){{getApp().page.setData({{bad:true}});}};\nexports.repairView=function(){{getApp().page.setData({{bad:false}});}};"
        ));
        let mut simulator = pack.start(engine);
        let accepted = simulator.host().render_snapshot().unwrap();
        call(&mut simulator, "breakView");
        let failed = simulator.pump(1).unwrap();
        assert!(failed
            .messages
            .iter()
            .any(|message| { message.op == op::RENDER_COMMIT && message.payload["ok"] == false }));
        assert_eq!(simulator.host().render_snapshot().unwrap(), accepted);
        let records = simulator.trace_summary().total_records;
        for now in 2..102 {
            assert!(simulator.pump(now).unwrap().messages.is_empty());
        }
        assert_eq!(simulator.trace_summary().total_records, records);

        // The automatic scheduling boundary cannot turn an explicit retry
        // into success or suppress its actual runtime error.
        let explicit = simulator
            .dispatch(BridgeEnvelope::request(
                simulator.session_id().to_owned(),
                "explicit-failed-render",
                op::RENDER_COMMIT,
                json!({
                    "templateId":format!("template:{ROUTE}.wxml"),
                    "useSessionResources":true,
                    "styleIds":pack.manifest.route_style_ids(ROUTE).unwrap(),
                    "data":{"label":"initial","edits":0,"bad":true},
                    "viewport":simulator.viewport(),
                }),
            ))
            .unwrap();
        assert!(explicit
            .messages
            .iter()
            .any(|message| { message.op == op::RENDER_COMMIT && message.payload["ok"] == false }));
        assert_eq!(simulator.host().render_snapshot().unwrap(), accepted);
        call(&mut simulator, "repairView");
        let repaired = simulator.pump(103).unwrap();
        assert!(repaired
            .messages
            .iter()
            .any(|message| { message.op == op::RENDER_COMMIT && message.payload["ok"] == true }));
        assert_eq!(frame_text(&simulator), "initial/0/2");
        assert!(simulator.pump(104).unwrap().messages.is_empty());
    }
}

#[test]
fn timed_out_view_does_not_spin_and_a_successful_pack_restart_recovers() {
    for engine in engines() {
        let mut pack = Pack::new(
            &DOCUMENT.replace("{{tools.next()}}", "{{bad ? tools.spin() : tools.next()}}"),
            "#ffffff",
        );
        let script = format!("{WXS_JS}\nexports.spin=function(){{while(true){{}}}};");
        let hash = pack.blob(script.as_bytes());
        pack.manifest.view_scripts[0].sha256 = hash;
        pack.set_page_source(&format!(
            "{PAGE_JS}\nexports.breakView=function(){{getApp().page.setData({{bad:true}});}};"
        ));
        let mut simulator = pack.start(engine);
        let session = simulator.session_id().to_owned();
        let accepted = simulator.host().render_snapshot().unwrap();
        call(&mut simulator, "breakView");
        let failed = simulator.pump(1).unwrap();
        assert!(
            failed
                .messages
                .iter()
                .any(|message| { message.payload["error"]["code"] == "ERR_TIMEOUT" }),
            "{engine:?}: {failed:?}"
        );
        let records = simulator.trace_summary().total_records;
        for now in 2..102 {
            assert!(simulator.pump(now).unwrap().messages.is_empty());
        }
        assert_eq!(simulator.trace_summary().total_records, records);
        assert_eq!(simulator.host().render_snapshot().unwrap(), accepted);

        let fixed = Pack::new(DOCUMENT, "#ffffff");
        let (kind, _) = simulator.apply_dev_pack(&fixed.root).unwrap();
        assert_eq!(kind, DevReloadKind::Restart);
        assert_ne!(simulator.session_id(), session);
        assert_eq!(frame_text(&simulator), "initial/0/1");
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2");
    }
}

#[test]
fn style_reload_keeps_view_heap_page_data_storage_and_session() {
    for engine in engines() {
        let old = Pack::new(DOCUMENT, "#123456");
        let styled = Pack::new(DOCUMENT, "#abcdef");
        let mut simulator = old.start(engine);
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2");
        let before = call(&mut simulator, "inspect");
        assert_eq!(before["stored"], "persisted");
        let session = simulator.session_id().to_owned();
        let page = simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .pages()
            .current()
            .unwrap()
            .id;
        let snapshot = simulator.host().render_snapshot().unwrap();
        let (kind, report) = simulator
            .apply_dev_pack(&styled.root)
            .expect("style-only reload succeeds");
        assert_eq!(kind, DevReloadKind::InPlace, "{engine:?}");
        assert_eq!(simulator.session_id(), session);
        assert_eq!(report.session_id, session);
        assert_eq!(simulator.root(), styled.root);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .app_service()
                .pages()
                .current()
                .unwrap()
                .id,
            page
        );
        assert_eq!(call(&mut simulator, "inspect"), before);
        assert_eq!(
            frame_text(&simulator),
            "edited/1/2",
            "style reload must not execute next()"
        );
        let changed = simulator.host().render_snapshot().unwrap();
        assert!(changed.frame_id > snapshot.frame_id);
        assert_ne!(
            changed.pixels, snapshot.pixels,
            "updated WXSS reaches the published pixels"
        );
        // A later data render proves style preview/publication did not secretly
        // advance an otherwise hidden WXS counter or reset its module cache.
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/2/3");
    }
}

#[test]
fn changed_wxml_restarts_even_with_identical_wxs_and_resets_the_counter() {
    for engine in engines() {
        let old = Pack::new(DOCUMENT, "#123456");
        let changed = Pack::new(
            &DOCUMENT.replace("{{label}}/", "changed {{label}}/"),
            "#123456",
        );
        assert_eq!(old.manifest.view_scripts, changed.manifest.view_scripts);
        assert_eq!(old.manifest.modules, changed.manifest.modules);
        let mut simulator = old.start(engine);
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2");
        let session = simulator.session_id().to_owned();
        let (kind, report) = simulator
            .apply_dev_pack(&changed.root)
            .expect("changed WXML starts a fresh native View");
        assert_eq!(kind, DevReloadKind::Restart, "{engine:?}");
        assert_ne!(simulator.session_id(), session);
        assert_eq!(report.session_id, simulator.session_id());
        assert_eq!(simulator.root(), changed.root);
        assert_eq!(frame_text(&simulator), "changed initial/0/1");
        let inspected = call(&mut simulator, "inspect");
        assert_eq!(inspected["data"], json!({"label":"initial","edits":0}));
        assert_eq!(inspected["launches"], 1);
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .storage()
            .get("view-reload")
            .is_none());
    }
}

#[test]
fn failed_candidate_keeps_previous_frame_and_stateful_view_heap() {
    for engine in engines() {
        let old = Pack::new(DOCUMENT, "#123456");
        let failing = Pack::new(
            &DOCUMENT.replace(
                "{{label}}/{{edits}}/{{tools.next()}}",
                "candidate/{{tools.next()}}/{{tools.fail()}}",
            ),
            "#abcdef",
        );
        assert_eq!(old.manifest.view_scripts, failing.manifest.view_scripts);
        let mut simulator = old.start(engine);
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2");
        let inspected = call(&mut simulator, "inspect");
        let session = simulator.session_id().to_owned();
        let snapshot = simulator.host().render_snapshot().unwrap();
        let trace = simulator.trace();
        let error = simulator
            .apply_dev_pack(&failing.root)
            .expect_err("candidate executes next then fails before publication");
        assert!(
            error.to_string().contains("candidate View failure"),
            "{engine:?}: {error}"
        );
        assert_eq!(simulator.root(), old.root);
        assert_eq!(simulator.manifest(), &old.manifest);
        assert_eq!(simulator.session_id(), session);
        assert_eq!(simulator.host().render_snapshot().unwrap(), snapshot);
        assert_eq!(
            simulator.trace(),
            trace,
            "rejected candidate cannot publish its trace"
        );
        assert_eq!(call(&mut simulator, "inspect"), inspected);
        // This renders against the surviving old heap, rather than merely
        // checking that an old screenshot remained cached after the failure.
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/2/3");
    }
}

#[cfg(feature = "skia-raster")]
#[test]
fn presentation_density_repaints_without_executing_stateful_view_or_changing_device() {
    for engine in engines() {
        let pack = Pack::new(DOCUMENT, "#ffffff");
        let mut simulator = pack.start(engine);
        let session_id = simulator.session_id().to_owned();
        let viewport = simulator.viewport();
        let initial_frame = simulator.host().render_snapshot_ref().unwrap().frame_id;
        let device = simulator.host().session().unwrap().config().host.clone();
        let initial_tree = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap()
            .clone();
        for scale in [1.5, 2.0, 3.0, 4.0, 1.0] {
            assert!(simulator
                .apply_presentation(viewport, scale)
                .unwrap()
                .messages
                .is_empty());
            let snapshot = simulator.host().render_snapshot_ref().unwrap();
            assert_eq!(
                (snapshot.width, snapshot.height),
                (
                    (f64::from(viewport.width) * scale).ceil() as u32,
                    (f64::from(viewport.height) * scale).ceil() as u32
                )
            );
            assert_eq!(snapshot.frame_id, initial_frame);
            assert_eq!(
                simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer()
                    .last_frame()
                    .unwrap(),
                &initial_tree
            );
            assert_eq!(frame_text(&simulator), "initial/0/1");
            assert_eq!(simulator.session_id(), session_id);
            assert_eq!(simulator.host().session().unwrap().config().host, device);
        }
        let inspect = call(&mut simulator, "inspect");
        assert_eq!(inspect["launches"], 1);
        let before = simulator.host().render_snapshot().unwrap();
        let mut oversized = viewport;
        oversized.width = 4097.0;
        assert!(simulator.apply_presentation(oversized, 1.0).is_err());
        assert_eq!(simulator.viewport(), viewport);
        assert_eq!(simulator.render_scale(), 1.0);
        assert_eq!(simulator.host().render_snapshot_ref().unwrap(), &before);
        // A real data render must see exactly one next() after all density changes.
        call(&mut simulator, "edit");
        simulator.pump(u64::MAX).unwrap();
        assert_eq!(frame_text(&simulator), "edited/1/2");
    }
}

#[test]
fn presentation_fps_gate_does_not_consume_pending_view_revision() {
    for engine in engines() {
        let pack = Pack::new(DOCUMENT, "#ffffff");
        let mut simulator = pack.start(engine);
        let frame_id = simulator.host().render_snapshot_ref().unwrap().frame_id;
        call(&mut simulator, "edit");
        simulator.pump_with_render(1, false).unwrap();
        assert_eq!(
            simulator.host().render_snapshot_ref().unwrap().frame_id,
            frame_id
        );
        assert_eq!(frame_text(&simulator), "initial/0/1");
        simulator.pump_with_render(1, true).unwrap();
        assert_eq!(frame_text(&simulator), "edited/1/2");
        let trace = simulator.trace();
        let render = trace
            .iter()
            .rev()
            .find(|record| record["request"]["op"] == op::RENDER_COMMIT)
            .unwrap();
        assert_eq!(render["request"]["payload"]["useSessionResources"], true);
        assert!(render["request"]["payload"].get("blobs").is_none());
    }
}

#[test]
fn presentation_fps_gate_keeps_timers_and_explicit_bridge_live() {
    for engine in engines() {
        let mut pack = Pack::new(DOCUMENT, "#ffffff");
        pack.set_page_source(
            &[
                PAGE_JS,
                r#"
exports.schedule=function(){
    var page=getApp().page;
    return setTimeout(function(){
        page.setData({label:'timer-fired',edits:page.data.edits+1});
        wx.setStorageSync('view-reload','timer-fired');
    },50);
};
"#,
            ]
            .concat(),
        );
        let mut simulator = pack.start(engine);
        let session_id = simulator.session_id().to_owned();
        let frame_id = simulator.host().render_snapshot_ref().unwrap().frame_id;
        let pixel_revision = simulator.host().render_revision();
        let initial_revision = simulator.host().session().unwrap().view().template_revision;
        assert!(call(&mut simulator, "schedule").as_u64().unwrap() > 0);

        // Advance the native timer clock without sleeping or permitting an
        // automatic repaint. Its callback must still reach JS and the host.
        let fired = simulator.pump_with_render(u64::MAX, false).unwrap();
        assert!(fired
            .messages
            .iter()
            .any(|message| message.op == op::EVENT_BATCH));
        assert!(!fired
            .messages
            .iter()
            .any(|message| message.op == op::RENDER_COMMIT));
        let observed = call(&mut simulator, "inspect");
        assert_eq!(observed["data"]["label"], "timer-fired", "{engine:?}");
        assert_eq!(observed["data"]["edits"], 1, "{engine:?}");
        assert_eq!(observed["stored"], "timer-fired", "{engine:?}");
        let timer_revision = simulator.host().session().unwrap().view().template_revision;
        assert!(timer_revision > initial_revision, "{engine:?}");
        assert_eq!(frame_text(&simulator), "initial/0/1", "{engine:?}");
        assert_eq!(simulator.host().render_revision(), pixel_revision);

        // Explicit bridge calls remain observable while presentation is
        // capped; their effects join the pending template revision.
        call(&mut simulator, "edit");
        let observed = call(&mut simulator, "inspect");
        assert_eq!(observed["data"]["label"], "edited", "{engine:?}");
        assert_eq!(observed["data"]["edits"], 2, "{engine:?}");
        assert_eq!(observed["stored"], "persisted", "{engine:?}");
        let pending_revision = simulator.host().session().unwrap().view().template_revision;
        assert!(pending_revision > timer_revision, "{engine:?}");
        assert!(simulator
            .pump_with_render(u64::MAX, false)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(
            simulator.host().session().unwrap().view().template_revision,
            pending_revision
        );
        assert_eq!(
            simulator.host().render_snapshot_ref().unwrap().frame_id,
            frame_id
        );
        assert_eq!(simulator.host().render_revision(), pixel_revision);
        assert_eq!(frame_text(&simulator), "initial/0/1", "{engine:?}");

        let resumed = simulator.pump_with_render(u64::MAX, true).unwrap();
        assert_eq!(
            resumed
                .messages
                .iter()
                .filter(|message| message.op == op::RENDER_COMMIT)
                .count(),
            1,
            "{engine:?}"
        );
        assert_eq!(frame_text(&simulator), "edited/2/2", "{engine:?}");
        assert_eq!(simulator.session_id(), session_id);
        let settled_revision = simulator.host().render_revision();
        assert!(settled_revision > pixel_revision);
        assert!(simulator
            .pump_with_render(u64::MAX, true)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(simulator.host().render_revision(), settled_revision);
        assert_eq!(frame_text(&simulator), "edited/2/2", "{engine:?}");
    }
}

#[test]
fn logical_presentation_resize_relayouts_in_same_session() {
    for engine in engines() {
        let mut pack = Pack::new(DOCUMENT, "#ffffff");
        let source = PAGE_JS.replace(
            "onLoad(){getApp().page=this;}",
            "onLoad(){getApp().page=this;},onResize(event){this.setData({label:'resized',resizeCalls:(this.data.resizeCalls||0)+1,resizeSize:event.size});}",
        );
        let hash = pack.blob(source.as_bytes());
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
        let mut simulator = pack.start(engine);
        let id = simulator.session_id().to_owned();
        let mut viewport = simulator.viewport();
        viewport.width = 667.0;
        viewport.height = 375.0;
        let batch = simulator.apply_presentation(viewport, 1.0).unwrap();
        assert!(batch.messages.iter().any(
            |message| message.op == op::EVENT_BATCH && message.payload["type"] == "host.resize"
        ));
        assert_eq!(simulator.session_id(), id);
        assert_eq!(simulator.viewport(), viewport);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap()
                .viewport,
            viewport
        );
        assert_eq!(frame_text(&simulator), "resized/0/2", "{engine:?}");
        let data = call(&mut simulator, "inspect")["data"].clone();
        assert_eq!(data["resizeCalls"], 1, "{engine:?}");
        assert_eq!(
            data["resizeSize"],
            json!({"windowWidth":667,"windowHeight":375}),
            "{engine:?}"
        );
        assert!(simulator
            .apply_presentation(viewport, 1.0)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(frame_text(&simulator), "resized/0/2", "{engine:?}");
        assert_eq!(
            call(&mut simulator, "inspect")["data"]["resizeCalls"],
            1,
            "{engine:?}"
        );
    }
}

#[cfg(feature = "skia-raster")]
#[test]
fn modern_view_density_changes_do_not_advance_stateful_expressions() {
    for engine in engines() {
        let pack = Pack::modern_counter();
        let mut simulator = pack.start(engine);
        let viewport = simulator.viewport();
        let frame = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap()
            .clone();
        let session = simulator.session_id().to_owned();
        for scale in [2.0, 3.0, 1.0] {
            simulator.apply_presentation(viewport, scale).unwrap();
            assert_eq!(frame_text(&simulator), "initial/0/1");
            assert_eq!(
                simulator.host().session().unwrap().renderer().last_frame(),
                Some(&frame)
            );
            assert_eq!(simulator.session_id(), session);
        }
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2");
    }
}

#[test]
fn logical_resize_reflows_rpx_without_replaying_unchanged_view_input() {
    for engine in engines() {
        let document = DOCUMENT.replace("<view>", r#"<view id="sized" style="width:100rpx">"#);
        let pack = Pack::new(&document, "#ffffff");
        let mut simulator = pack.start(engine);
        let node_width = |simulator: &Simulator| {
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .last_frame()
                .unwrap()
                .query("#sized", false)
                .unwrap()[0]
                .bounds
                .width
        };
        assert!((node_width(&simulator) - 50.0).abs() < 0.01, "{engine:?}");
        let revision = simulator.host().render_revision();
        let mut viewport = simulator.viewport();
        viewport.width = 667.0;
        viewport.height = 375.0;
        simulator.apply_presentation(viewport, 1.0).unwrap();
        assert!(simulator.host().render_revision() > revision, "{engine:?}");
        assert!(
            (node_width(&simulator) - 667.0 * 100.0 / 750.0).abs() < 0.01,
            "{engine:?}"
        );
        assert_eq!(
            frame_text(&simulator),
            "initial/0/1",
            "unchanged View data is reused: {engine:?}"
        );
        let snapshot = simulator.host().render_snapshot_ref().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (667, 375), "{engine:?}");
        // A subsequent data update still reaches the retained module instance.
        edit(&mut simulator);
        assert_eq!(frame_text(&simulator), "edited/1/2", "{engine:?}");
    }
}

#[test]
fn joint_web_density_does_not_execute_stateful_wxs_or_modern_view_again() {
    use container_render_skia::PageRenderMode;
    use container_simulator::presentation::{PresentationSettings, RenderScale};
    use container_simulator::web::WebSurface;
    for engine in engines() {
        for modern in [false, true] {
            let pack = if modern {
                Pack::modern_counter()
            } else {
                Pack::new(DOCUMENT, "#ffffff")
            };
            for mode in [
                PageRenderMode::ExternalFrame,
                #[cfg(feature = "skia-raster")]
                PageRenderMode::Raster,
            ] {
                let mut simulator = Simulator::from_pack_dir(
                    &pack.root,
                    SimulatorConfig {
                        engine,
                        page_render_mode: mode,
                        ..Default::default()
                    },
                )
                .unwrap();
                simulator.run().unwrap();
                assert_eq!(frame_text(&simulator), "initial/0/1");
                let surface = WebSurface::localhost(0).unwrap();
                let handle = surface.handle();
                let before_input = simulator
                    .host()
                    .session()
                    .unwrap()
                    .last_frame_input(simulator.host().render_revision())
                    .cloned();
                let before_trace = simulator.trace();
                let before_session = simulator.session_id().to_owned();
                let before_frame = simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer()
                    .last_frame()
                    .unwrap()
                    .clone();
                let candidate = PresentationSettings {
                    revision: 2,
                    generation: 2,
                    render_scale: RenderScale::Fixed(2.0),
                    effective_scale: 2.0,
                    ..Default::default()
                };
                let batch = simulator
                    .apply_web_density(&handle, &candidate, true)
                    .unwrap();
                assert!(batch.messages.is_empty());
                assert_eq!(simulator.trace(), before_trace);
                assert_eq!(simulator.session_id(), before_session);
                assert_eq!(
                    simulator.host().session().unwrap().renderer().last_frame(),
                    Some(&before_frame)
                );
                assert_eq!(
                    simulator
                        .host()
                        .session()
                        .unwrap()
                        .last_frame_input(simulator.host().render_revision()),
                    before_input.as_ref()
                );
                assert_eq!(
                    handle.presentation(),
                    serde_json::to_value(&candidate).unwrap()
                );
                assert_eq!(frame_text(&simulator), "initial/0/1");
                // A subsequent actual View invalidation observes exactly one
                // additional call; a hidden density evaluation would yield 3.
                call(&mut simulator, "edit");
                simulator.pump(0).unwrap();
                assert_eq!(frame_text(&simulator), "edited/1/2");
            }
        }
    }
}
