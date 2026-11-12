//! Owner-protocol tests with real engines and synthetic geometry. They do not
//! certify presentation in a real browser, native WebView or WeChat DevTools.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::*;
use container_render_skia::{Rect, Renderer};
use container_runtime::BrowserViewSubmission;
use container_simulator::{default_session_config, DevReloadKind, Simulator, SimulatorConfig};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, MutexGuard,
    },
};

const ROUTE: &str = "pages/index/index";
const SECOND: &str = "pages/second/index";
const PAGE: &str = "module:pages/index/index.js";
const DOCUMENT: &str = r#"<wxs module="tools" src="../../helpers/counter.wxs"/><view id="touch" bindtouchstart="touch" bindtouchcancel="cancel"><text>{{label}}/{{tools.next()}}</text></view>"#;
const PAGE_SOURCE: &str = r#"
Page({data:{label:'initial'},onReady(){getApp().readies++;this.setData({label:'ready'})},
  onResize(){getApp().resizes++},touch(){},
  cancel(){getApp().cancels++;this.setData({label:'cancelled'});wx.setStorageSync('cancels',getApp().cancels)}});
exports.inspect=()=>({data:getCurrentPages()[0].data,readies:getApp().readies,resizes:getApp().resizes,cancels:getApp().cancels,stored:wx.getStorageSync('cancels')});
exports.edit=(label)=>getCurrentPages()[0].setData({label});
"#;
static NEXT_PACK: AtomicU64 = AtomicU64::new(0);
// These are semantic assertions using real engine deadlines. Running all tests
// together creates up to eighteen native realms competing for the same budget;
// performance and concurrency acceptance have independent suites.
static ENGINE_TEST_LOCK: Mutex<()> = Mutex::new(());

fn engine_test_guard() -> MutexGuard<'static, ()> {
    ENGINE_TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn engines() -> Vec<EngineKind> {
    [EngineKind::Quickjs, EngineKind::V8]
        .into_iter()
        .filter(|engine| container_runtime::engine_provider_compiled(*engine))
        .collect()
}

struct Pack {
    root: PathBuf,
    manifest: ContainerManifestV1,
}

impl Pack {
    fn new(style: &str) -> Self {
        let root = loop {
            let id = NEXT_PACK.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir()
                .join(format!("container-browser-dev-{}-{id}", std::process::id()));
            match fs::create_dir(&root) {
                Ok(()) => break root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("reserve fixture: {error}"),
            }
        };
        fs::create_dir_all(root.join("blobs/sha256")).unwrap();
        let mut pack = Self {
            root,
            manifest: ContainerManifestV1 {
                schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
                compiler: CompilerInfo {
                    name: "weapp-vite".into(),
                    commit: "browser-dev-fixture".into(),
                    platform: "weapp".into(),
                },
                app: AppInfo {
                    app_json: "app.json".into(),
                    entry_module: "module:app.js".into(),
                },
                rendering: Some(RendererProfiles {
                    pages: BTreeMap::from([(ROUTE.into(), RendererProfile::WebView)]),
                    ..Default::default()
                }),
                capabilities: BTreeMap::from([
                    ("getCurrentPages".into(), CapabilitySupport::Full),
                    ("wx.getStorageSync".into(), CapabilitySupport::Full),
                    ("wx.setStorageSync".into(), CapabilitySupport::Full),
                ]),
                ..Default::default()
            },
        };
        for (id, source, scope) in [
            (
                "module:app.js",
                "App({readies:0,resizes:0,cancels:0});",
                ModuleScope::App,
            ),
            (PAGE, PAGE_SOURCE, ModuleScope::Page),
            (
                "module:pages/second/index.js",
                "Page({data:{label:'second'}});",
                ModuleScope::Page,
            ),
        ] {
            let sha256 = pack.blob(source.as_bytes());
            pack.manifest.modules.push(Module {
                id: id.into(),
                sha256,
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
        }
        for (route, source) in [
            (ROUTE, DOCUMENT),
            (SECOND, "<view><text>second</text></view>"),
        ] {
            pack.manifest.routes.push(Route {
                id: format!("route:{route}"),
                path: route.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("module:{route}.js"),
            });
            let ast = parse_wxml(source).unwrap();
            let hash = pack.blob(&ast.canonical_json().unwrap());
            pack.manifest.templates.push(Template {
                id: format!("template:{route}.wxml"),
                wxml_ast: format!("sha256:{hash}"),
                bindings: wxml_bindings(&ast),
                wxs_modules: if route == ROUTE {
                    BTreeMap::from([("tools".into(), "wxs:helpers/counter.wxs".into())])
                } else {
                    BTreeMap::new()
                },
            });
        }
        let sha256 = pack.blob(b"var calls=0;exports.next=function(){return ++calls};");
        pack.manifest.view_scripts.push(ViewScriptModule {
            id: "wxs:helpers/counter.wxs".into(),
            sha256,
            dependencies: vec![],
        });
        let hash = pack.blob(&parse_wxss(style).unwrap().canonical_json().unwrap());
        pack.manifest.styles.push(Style {
            id: format!("style:{ROUTE}.wxss"),
            wxss_ir: format!("sha256:{hash}"),
            scope: StyleScope::Page,
        });
        pack.save();
        pack
    }

    fn blob(&self, bytes: &[u8]) -> String {
        let hash = hex_digest(bytes);
        fs::write(self.root.join("blobs/sha256").join(&hash), bytes).unwrap();
        hash
    }

    fn save(&mut self) {
        self.manifest.refresh_integrity().unwrap();
        fs::write(
            self.root.join("manifest.json"),
            serde_json::to_vec(&self.manifest).unwrap(),
        )
        .unwrap();
    }

    fn page_source(&mut self, source: &str) {
        let hash = self.blob(source.as_bytes());
        self.manifest
            .modules
            .iter_mut()
            .find(|module| module.id == PAGE)
            .unwrap()
            .sha256 = hash;
        self.save();
    }

    fn start(&self, engine: EngineKind) -> Simulator {
        let config = SimulatorConfig {
            engine,
            browser_view_enabled: true,
            ..Default::default()
        };
        assert!(default_session_config(&config).browser_view_enabled);
        let mut simulator = Simulator::from_pack_dir(&self.root, config).unwrap();
        simulator.run().unwrap();
        simulator
    }
}

impl Drop for Pack {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn dispatch(simulator: &mut Simulator, operation: &str, payload: Value) -> BridgeBatch {
    let batch = simulator
        .dispatch(BridgeEnvelope::request(
            simulator.session_id(),
            operation,
            operation,
            payload,
        ))
        .unwrap();
    assert!(
        !batch
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false),
        "{batch:?}"
    );
    batch
}

fn inspect(simulator: &mut Simulator) -> Value {
    dispatch(
        simulator,
        op::MODULE_CALL,
        json!({"moduleId":PAGE,"export":"inspect","args":[]}),
    )
    .messages[0]
        .payload["result"][0]
        .clone()
}

fn prepare(simulator: &mut Simulator) -> BrowserViewSubmission {
    let request = simulator.browser_render_request().unwrap().clone();
    assert!(request.render.get("data").is_none());
    assert_eq!(request.render["useSessionResources"], true);
    let response = dispatch(
        simulator,
        op::VIEW_PREPARE,
        json!({"version":request.version,"surfaceGeneration":"1","render":request.render}),
    );
    serde_json::from_value(response.messages[0].payload["submission"].clone()).unwrap()
}

fn geometry(submission: &BrowserViewSubmission) -> BrowserGeometryBatch {
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    let mut nodes = vec![];
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
        version: "1.0".into(),
        key: submission.key.clone(),
        epoch: 0,
        viewport: submission.viewport,
        nodes,
    }
}

fn present(simulator: &mut Simulator, submission: &BrowserViewSubmission) {
    let geometry = geometry(submission);
    let permit = dispatch(
        simulator,
        op::VIEW_PREPARE_COMMIT,
        serde_json::to_value(geometry).unwrap(),
    )
    .messages[0]
        .payload["permit"]
        .clone();
    dispatch(simulator, op::VIEW_PRESENTED, permit);
}

fn text(document: &ViewDocument) -> String {
    fn append(nodes: &[ViewNode], result: &mut String) {
        for node in nodes {
            match node {
                ViewNode::Text { value, .. } => result.push_str(value),
                ViewNode::Element { children, .. } => append(children, result),
            }
        }
    }
    let mut result = String::new();
    append(&document.nodes, &mut result);
    result
}

fn settle(simulator: &mut Simulator) -> BrowserViewSubmission {
    let first = prepare(simulator);
    present(simulator, &first);
    simulator.pump(0).unwrap();
    let second = prepare(simulator);
    present(simulator, &second);
    simulator.pump(0).unwrap();
    second
}

fn start_contact(simulator: &mut Simulator, submission: &BrowserViewSubmission) {
    let target = submission.document.nodes.iter().find(|node| matches!(node, ViewNode::Element { attrs, .. } if attrs.get("id").is_some_and(|id| id == "touch"))).unwrap().occurrence_id();
    let touch = json!({"identifier":7,"x":2,"y":4,"clientX":2,"clientY":4,"pageX":2,"pageY":4});
    dispatch(
        simulator,
        op::VIEW_EVENTS,
        json!({"version":"1.0","key":submission.key,"epoch":"0","events":[{"type":"touchstart","targetOccurrenceId":target,"detail":{},"changedTouches":[touch],"touches":[touch]}]}),
    );
}

#[test]
fn browser_requests_wait_for_owner_and_ready_writes_queue_the_next_input() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid;grid-template-columns:1fr 2fr}");
        let mut simulator = pack.start(engine);
        assert_eq!(
            simulator.current_renderer_profile(),
            RendererProfile::WebView
        );
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_none());
        assert!(simulator.host().view_document().unwrap().is_none());
        assert!(simulator.report("queued").snapshot.is_none());
        assert_eq!(inspect(&mut simulator)["readies"], 0);
        let first_request = simulator.browser_render_request().unwrap().clone();
        assert_eq!(first_request.revision, "1");
        simulator.pump(0).unwrap();
        simulator.pump(0).unwrap();
        assert_eq!(simulator.browser_render_request().unwrap(), &first_request);
        let first = prepare(&mut simulator);
        assert_eq!(text(&first.document), "initial/1");
        assert_eq!(inspect(&mut simulator)["readies"], 0);
        present(&mut simulator, &first);
        assert_eq!(inspect(&mut simulator)["readies"], 1);
        simulator.pump(0).unwrap();
        assert_eq!(simulator.browser_render_request().unwrap().revision, "2");
        let second = prepare(&mut simulator);
        assert_eq!(text(&second.document), "ready/2");
        present(&mut simulator, &second);
        simulator.pump(0).unwrap();
        assert_eq!(simulator.browser_render_request().unwrap().revision, "2");
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_none());
    }
}

#[test]
fn density_preserves_document_and_logical_resize_queues_without_native_layout() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        let second = settle(&mut simulator);
        let request = simulator.browser_render_request().unwrap().clone();
        simulator
            .apply_presentation(simulator.viewport(), 2.0)
            .unwrap();
        simulator.pump(0).unwrap();
        assert_eq!(simulator.browser_render_request().unwrap(), &request);
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &second.document
        );
        assert_eq!(inspect(&mut simulator)["resizes"], 0);
        let viewport = Rect {
            width: 600.0,
            height: 400.0,
            ..simulator.viewport()
        };
        simulator.apply_presentation(viewport, 1.5).unwrap();
        assert_eq!(inspect(&mut simulator)["resizes"], 1);
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            request.revision
        );
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &second.document
        );
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        let resized = prepare(&mut simulator);
        assert_eq!(resized.viewport.width, 600.0);
        assert_eq!(
            text(&resized.document),
            "ready/2",
            "layout-only input reuses evaluated View work"
        );
    }
}

#[test]
fn committed_resize_retains_hook_diagnostics_without_replaying_application_hooks() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let mut pack = Pack::new("view {display:grid}");
        pack.page_source(&PAGE_SOURCE.replace(
            "getApp().resizes++",
            "getApp().resizes++;throw new Error('resize-hook-failed')",
        ));
        let mut simulator = pack.start(engine);
        let original = settle(&mut simulator);
        let old_request = simulator.browser_render_request().unwrap().revision.clone();
        let old_viewport = simulator.viewport();
        let resized = Rect {
            width: 600.0,
            height: 400.0,
            ..old_viewport
        };
        let batch = simulator.apply_presentation(resized, 2.0).unwrap();
        assert!(
            batch.messages.iter().any(|message| message.kind
                == container_bridge::EnvelopeKind::Response
                && message.op == op::ERROR
                && message.payload["ok"] == false
                && message.payload["error"]["code"] == "ERR_ENGINE"),
            "the resize boundary retains the generic engine failure: {batch:?}"
        );
        assert!(
            batch.messages.iter().any(|message| {
                message.kind == container_bridge::EnvelopeKind::Event
                    && message.op == op::ERROR
                    && message.payload["errors"].as_array().is_some_and(|errors| {
                        errors.iter().any(|error| {
                            error["message"]
                                .as_str()
                                .is_some_and(|message| message.contains("resize-hook-failed"))
                        })
                    })
            }),
            "the original JavaScript exception is retained in the effect error event: {batch:?}"
        );
        assert_eq!(simulator.viewport(), resized);
        let host = &simulator.host().session().unwrap().config().host;
        assert_eq!(host.window_width, resized.width as u32);
        assert_eq!(host.window_height, resized.height as u32);
        assert_eq!(
            inspect(&mut simulator)["resizes"],
            1,
            "a committed hook failure must not replay resize hooks"
        );
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            old_request
        );
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &original.document
        );
        let recovered = prepare(&mut simulator);
        assert_eq!(recovered.viewport.width, f64::from(resized.width));
        present(&mut simulator, &recovered);
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(inspect(&mut simulator)["resizes"], 1);
    }
}

#[test]
fn committed_resize_retains_cancel_effect_errors_and_runs_each_callback_once() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let mut pack = Pack::new("view {display:grid}");
        pack.page_source(&PAGE_SOURCE.replace(
            "wx.setStorageSync('cancels',getApp().cancels)",
            "wx.setStorageSync('cancels',getApp().cancels);throw new Error('cancel-resize-failed')",
        ));
        let mut simulator = pack.start(engine);
        let original = settle(&mut simulator);
        start_contact(&mut simulator, &original);
        let old_request = simulator.browser_render_request().unwrap().revision.clone();
        let old_viewport = simulator.viewport();
        let resized = Rect {
            width: 600.0,
            height: 400.0,
            ..old_viewport
        };
        let batch = simulator.apply_presentation(resized, 2.0).unwrap();
        let retired = batch
            .messages
            .iter()
            .filter(|message| message.op == "view.contacts.retired")
            .collect::<Vec<_>>();
        assert_eq!(retired.len(), 1, "{batch:?}");
        assert_eq!(
            retired[0].payload["key"],
            serde_json::to_value(&original.key).unwrap()
        );
        assert_eq!(retired[0].payload["identifiers"], json!([7]));
        assert_eq!(retired[0].payload["reason"], "host-geometry-changed");
        assert_eq!(retired[0].payload["delivered"],true,"delivery records the consumed callback even when its JavaScript effects report an exception");
        assert!(
            batch.messages.iter().any(|message| {
                message.kind == container_bridge::EnvelopeKind::Event
                    && message.op == op::ERROR
                    && message.payload["errors"].as_array().is_some_and(|errors| {
                        errors.iter().any(|error| {
                            error["message"]
                                .as_str()
                                .is_some_and(|message| message.contains("cancel-resize-failed"))
                        })
                    })
            }),
            "{batch:?}"
        );
        assert_eq!(simulator.viewport(), resized);
        let host = &simulator.host().session().unwrap().config().host;
        assert_eq!(host.window_width, resized.width as u32);
        assert_eq!(host.window_height, resized.height as u32);
        let state = inspect(&mut simulator);
        assert_eq!(state["resizes"], 1);
        assert_eq!(state["cancels"], 1);
        assert_eq!(state["stored"], 1);
        assert_eq!(state["data"]["label"], "cancelled");
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            old_request
        );
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &original.document
        );
        let recovered = prepare(&mut simulator);
        assert_eq!(recovered.viewport.width, f64::from(resized.width));
        assert_eq!(text(&recovered.document), "cancelled/3");
        present(&mut simulator, &recovered);
        assert!(simulator.host().is_browser_view_presented().unwrap());
        let state = inspect(&mut simulator);
        assert_eq!(state["resizes"], 1);
        assert_eq!(state["cancels"], 1);
        assert_eq!(state["stored"], 1);
    }
}

#[test]
fn canonical_route_selects_browser_profile_before_initial_startup() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = Simulator::from_pack_dir(
            &pack.root,
            SimulatorConfig {
                engine,
                browser_view_enabled: true,
                route: Some(format!("/{ROUTE}")),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            simulator.current_renderer_profile(),
            RendererProfile::WebView
        );
        simulator
            .apply_presentation(simulator.viewport(), 2.0)
            .unwrap();
        assert_eq!(simulator.render_scale(), 2.0);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .render_scale(),
            1.0,
            "a pre-start browser density change must not mutate the native target"
        );
        simulator.run().unwrap();
        assert_eq!(
            simulator.current_renderer_profile(),
            RendererProfile::WebView
        );
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_none());
        assert_eq!(simulator.browser_render_request().unwrap().revision, "1");
    }
}

#[test]
fn reload_preflight_retains_invalid_pack_and_publishes_verified_dom_resources() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        let original = settle(&mut simulator);
        let request = simulator.browser_render_request().unwrap().clone();
        let mut invalid = Pack::new("view {display:grid}");
        let hash = invalid.blob(b"not WXSS IR");
        invalid.manifest.styles[0].wxss_ir = format!("sha256:{hash}");
        invalid.save();
        assert!(simulator.apply_dev_pack(&invalid.root).is_err());
        assert_eq!(simulator.root(), pack.root);
        assert_eq!(simulator.manifest(), &pack.manifest);
        assert_eq!(simulator.browser_render_request().unwrap(), &request);
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &original.document
        );
        let valid = Pack::new("view {display:grid;grid-template-columns:2fr 1fr;opacity:0.8}");
        assert_eq!(
            simulator.apply_dev_pack(&valid.root).unwrap().0,
            DevReloadKind::InPlace
        );
        assert_eq!(simulator.session_id(), "simulator-1");
        assert!(simulator.browser_dev_pack_pending());
        assert_eq!(simulator.root(), pack.root);
        assert_eq!(simulator.manifest(), &pack.manifest);
        assert_eq!(
            simulator.host().session().unwrap().manifest(),
            &pack.manifest
        );
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &original.document
        );
        let updated = prepare(&mut simulator);
        assert_eq!(text(&updated.document), "ready/2");
        assert_ne!(updated.document.styles, original.document.styles);
        assert_eq!(simulator.manifest(), &pack.manifest);
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        present(&mut simulator, &updated);
        assert!(!simulator.browser_dev_pack_pending());
        assert_eq!(simulator.root(), valid.root);
        assert_eq!(simulator.manifest(), &valid.manifest);
        assert_eq!(
            simulator.host().session().unwrap().manifest(),
            &valid.manifest
        );
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_none());
    }
}

#[test]
fn page_and_component_events_survive_safe_reload_and_rejected_pack() {
    let _engine_guard = engine_test_guard();
    fn interactive_pack(style: &str, label: &str) -> Pack {
        let mut pack = Pack::new(style);
        pack.manifest.view_scripts.clear();
        pack.page_source(
            r#"Page({data:{count:0},onReady(){getApp().readies++},tap(){this.setData({count:this.data.count+1})}});
exports.inspect=()=>({data:getCurrentPages()[0].data,readies:getApp().readies,attached:getApp().attached||0,detached:getApp().detached||0});"#,
        );
        let component_source = r#"Component({data:{count:0},lifetimes:{attached(){getApp().attached=(getApp().attached||0)+1},detached(){getApp().detached=(getApp().detached||0)+1}},methods:{increment(){this.setData({count:this.data.count+1})}}});"#;
        let sha256 = pack.blob(component_source.as_bytes());
        pack.manifest.modules.push(Module {
            id: "module:components/counter/index.js".into(),
            sha256,
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::Component,
            dependencies: vec![],
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
        let source = format!(
            r#"<view id="page" bindtap="tap"><text>page:{{{{count}}}}</text></view><counter/><text id="hot">{label}</text>"#
        );
        for (id, source) in [
            (format!("template:{ROUTE}.wxml"), source.as_str()),
            (
                "template:components/counter/index.wxml".into(),
                r#"<view id="child" bindtap="increment"><text>child:{{count}}</text></view>"#,
            ),
        ] {
            let ast = parse_wxml(source).unwrap();
            let hash = pack.blob(&ast.canonical_json().unwrap());
            pack.manifest.templates.retain(|template| template.id != id);
            pack.manifest.templates.push(Template {
                id,
                wxml_ast: format!("sha256:{hash}"),
                bindings: wxml_bindings(&ast),
                wxs_modules: BTreeMap::new(),
            });
        }
        pack.save();
        pack
    }
    fn element<'a>(submission: &'a BrowserViewSubmission, id: &str) -> &'a ViewNode {
        let mut pending: Vec<_> = submission.document.nodes.iter().collect();
        while let Some(node) = pending.pop() {
            if let ViewNode::Element {
                attrs, children, ..
            } = node
            {
                if attrs.get("id").is_some_and(|value| value == id) {
                    return node;
                }
                pending.extend(children);
            }
        }
        panic!("missing element {id}");
    }
    fn tap(
        simulator: &mut Simulator,
        submission: &BrowserViewSubmission,
        id: &str,
    ) -> BrowserViewSubmission {
        let target = element(submission, id).occurrence_id();
        dispatch(
            simulator,
            op::VIEW_EVENTS,
            json!({"version":"1.0","key":submission.key,"epoch":"0","events":[{"type":"tap","targetOccurrenceId":target,"detail":{}}]}),
        );
        simulator.pump(0).unwrap();
        let updated = prepare(simulator);
        present(simulator, &updated);
        updated
    }
    for engine in engines() {
        let original = interactive_pack("view {display:grid}", "old");
        let styled = interactive_pack("view {display:grid;opacity:0.8}", "old");
        // Same node structure and component inputs: text changes are safe.
        let edited = interactive_pack("view {display:grid;opacity:0.8}", "new");
        let mut invalid = interactive_pack("view {display:grid}", "rejected");
        let hash = invalid.blob(b"invalid WXSS IR");
        invalid.manifest.styles[0].wxss_ir = format!("sha256:{hash}");
        invalid.save();
        let mut simulator = original.start(engine);
        let session_id = simulator.session_id().to_owned();
        let mut current = settle(&mut simulator);
        let component_owner = element(&current, "child").ownership().event_owner.clone();
        assert!(component_owner.is_some());
        for (pack, label, count) in [
            (None, "old", 1),
            (Some(&styled), "old", 2),
            (Some(&edited), "new", 3),
            (None, "new", 4),
        ] {
            if let Some(pack) = pack {
                assert_eq!(
                    simulator.apply_dev_pack(&pack.root).unwrap().0,
                    DevReloadKind::InPlace
                );
                current = prepare(&mut simulator);
                present(&mut simulator, &current);
                assert_eq!(
                    text(&current.document),
                    format!("page:{}child:{}{label}", count - 1, count - 1)
                );
            } else if count == 4 {
                assert!(simulator.apply_dev_pack(&invalid.root).is_err());
                assert!(simulator.host().is_browser_view_presented().unwrap());
                assert_eq!(
                    simulator.host().view_document().unwrap().unwrap(),
                    &current.document
                );
            }
            assert_eq!(simulator.session_id(), session_id);
            current = tap(&mut simulator, &current, "page");
            current = tap(&mut simulator, &current, "child");
            assert_eq!(
                text(&current.document),
                format!("page:{count}child:{count}{label}")
            );
            assert_eq!(
                element(&current, "child").ownership().event_owner,
                component_owner
            );
            let state = inspect(&mut simulator);
            assert_eq!(state["data"]["count"], count);
            assert_eq!(state["readies"], 1);
            assert_eq!(state["attached"], 1);
            assert_eq!(state["detached"], 0);
        }

        // Do not pump this component mutation before hot reload. Candidate
        // validation must consume the completed write's immutable receipt,
        // while a rejected candidate must leave the accepted DOM owner intact.
        let target = element(&current, "child").occurrence_id();
        dispatch(
            &mut simulator,
            op::VIEW_EVENTS,
            json!({"version":"1.0","key":current.key,"epoch":"0","events":[{"type":"tap","targetOccurrenceId":target,"detail":{}}]}),
        );
        let accepted_manifest = simulator.manifest().clone();
        let accepted_root = simulator.root().to_owned();
        let accepted_trace = simulator.trace();
        let rejected = interactive_pack("view {display:grid}", "{{count + }}");
        assert!(simulator.apply_dev_pack(&rejected.root).is_err());
        assert_eq!(simulator.manifest(), &accepted_manifest);
        assert_eq!(simulator.root(), accepted_root);
        assert_eq!(simulator.trace(), accepted_trace);
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &current.document
        );
        assert_eq!(
            simulator.apply_dev_pack(&styled.root).unwrap().0,
            DevReloadKind::InPlace
        );
        current = prepare(&mut simulator);
        assert_eq!(text(&current.document), "page:4child:5old");
        present(&mut simulator, &current);
        assert_eq!(simulator.session_id(), session_id);
        assert_eq!(
            element(&current, "child").ownership().event_owner,
            component_owner
        );
        let state = inspect(&mut simulator);
        assert_eq!(state["data"]["count"], 4);
        assert_eq!(state["readies"], 1);
        assert_eq!(state["attached"], 1);
        assert_eq!(state["detached"], 0);
    }
}

#[test]
fn preview_retirement_drains_cancel_writes_and_queues_fresh_authority() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        let old = settle(&mut simulator);
        start_contact(&mut simulator, &old);
        let old_request = simulator.browser_render_request().unwrap().revision.clone();
        let retired = simulator
            .retire_browser_preview("primary-preview-disconnected")
            .unwrap();
        assert!(retired
            .messages
            .iter()
            .any(|message| message.op == "view.contacts.retired"));
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        let state = inspect(&mut simulator);
        assert_eq!(state["cancels"], 1);
        assert_eq!(state["stored"], 1);
        assert_eq!(state["data"]["label"], "cancelled");
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            old_request
        );
        let fresh = prepare(&mut simulator);
        assert_eq!(text(&fresh.document), "cancelled/3");
        assert_ne!(fresh.key, old.key);
        simulator.retire_browser_preview("already-retired").unwrap();
        assert_eq!(inspect(&mut simulator)["cancels"], 1);
    }
}

#[test]
fn module_restart_prepares_a_new_session_without_claiming_dom_presentation() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        settle(&mut simulator);
        let mut invalid = Pack::new("view {display:grid}");
        invalid.page_source("Page({ broken syntax");
        assert!(simulator.apply_dev_pack(&invalid.root).is_err());
        assert_eq!(simulator.session_id(), "simulator-1");
        assert!(simulator.host().is_browser_view_presented().unwrap());
        let mut valid = Pack::new("view {display:grid}");
        valid.page_source(&format!("{PAGE_SOURCE}\nexports.newVersion=true;"));
        let (kind, report) = simulator.apply_dev_pack(&valid.root).unwrap();
        assert_eq!(kind, DevReloadKind::Restart);
        assert_eq!(simulator.session_id(), "simulator-1-reload-1");
        assert!(report.snapshot.is_none());
        assert!(simulator.host().view_document().unwrap().is_none());
        assert_eq!(simulator.browser_render_request().unwrap().revision, "1");
        assert_eq!(inspect(&mut simulator)["readies"], 0);
        assert_eq!(text(&prepare(&mut simulator).document), "initial/1");
    }
}

#[test]
fn skia_density_before_first_scene_stages_target_without_replaying_view_or_old_page() {
    let _engine_guard = engine_test_guard();
    for (engine, profile) in engines().into_iter().flat_map(|engine| {
        [RendererProfile::Skia, RendererProfile::SkylineCompat]
            .into_iter()
            .map(move |profile| (engine, profile))
    }) {
        let mut pack = Pack::new("view {display:grid}");
        pack.manifest
            .rendering
            .as_mut()
            .unwrap()
            .pages
            .insert(SECOND.into(), profile);
        let ast = parse_wxml(DOCUMENT).unwrap();
        let hash = pack.blob(&ast.canonical_json().unwrap());
        let second = pack
            .manifest
            .templates
            .iter_mut()
            .find(|template| template.id == format!("template:{SECOND}.wxml"))
            .unwrap();
        second.wxml_ast = format!("sha256:{hash}");
        second.bindings = wxml_bindings(&ast);
        second.wxs_modules = BTreeMap::from([("tools".into(), "wxs:helpers/counter.wxs".into())]);
        pack.save();
        let mut simulator = Simulator::from_pack_dir(
            &pack.root,
            SimulatorConfig {
                engine,
                browser_view_enabled: true,
                page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
                ..Default::default()
            },
        )
        .unwrap();
        simulator.run().unwrap();
        settle(&mut simulator);
        assert!(!simulator.has_current_skia_scene());
        dispatch(&mut simulator, op::PAGE_PUSH, json!({"path":SECOND}));
        assert_eq!(simulator.current_renderer_profile(), profile);
        assert!(!simulator.has_current_skia_scene());
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_none());

        let before = simulator.trace_summary().total_records;
        let batch = simulator
            .apply_presentation(simulator.viewport(), 2.0)
            .unwrap();
        assert!(batch.messages.is_empty());
        assert_eq!(simulator.trace_summary().total_records, before);
        assert_eq!(simulator.render_scale(), 2.0);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .renderer()
                .render_scale(),
            2.0
        );
        assert!(!simulator.has_current_skia_scene());
        assert!(simulator
            .apply_presentation(simulator.viewport(), 10.0)
            .is_err());
        assert_eq!(simulator.render_scale(), 2.0);
        assert_eq!(simulator.trace_summary().total_records, before);
        simulator.pump(0).unwrap();
        assert!(simulator.has_current_skia_scene());
        assert_eq!(
            text(simulator.host().view_document().unwrap().unwrap()),
            "second/1",
            "staging target density must not evaluate the first View early"
        );
        let accepted = simulator.host().view_document().unwrap().unwrap().clone();
        simulator
            .apply_presentation(simulator.viewport(), 1.5)
            .unwrap();
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &accepted,
            "density repaint reuses the current accepted View"
        );

        // A previous Skia page remains retained while DOM is visible. A new
        // page instance at the same route must not inherit that scene merely
        // because native pixels exist and the route string matches.
        dispatch(&mut simulator, op::PAGE_POP, json!({"delta":1}));
        simulator.pump(0).unwrap();
        let returned = prepare(&mut simulator);
        present(&mut simulator, &returned);
        assert!(!simulator.has_current_skia_scene());
        let old_frame = simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .unwrap()
            .clone();
        dispatch(&mut simulator, op::PAGE_PUSH, json!({"path":SECOND}));
        assert!(!simulator.has_current_skia_scene());
        let before = simulator.trace_summary().total_records;
        simulator
            .apply_presentation(simulator.viewport(), 2.0)
            .unwrap();
        assert_eq!(simulator.trace_summary().total_records, before);
        assert_eq!(
            simulator.host().session().unwrap().renderer().last_frame(),
            Some(&old_frame),
            "pending density must not commit the previous page's scene"
        );
        assert!(!simulator.has_current_skia_scene());
        simulator.pump(0).unwrap();
        assert!(simulator.has_current_skia_scene());
        let current = simulator.host().view_document().unwrap().unwrap();
        assert_ne!(current.page_id, accepted.page_id);
        assert_eq!(text(current), "second/1");
    }
}

#[test]
fn renderer_switch_and_hidden_app_resume_preserve_profile_ownership() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        settle(&mut simulator);
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        dispatch(&mut simulator, op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        dispatch(&mut simulator, op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
        let resumed = prepare(&mut simulator);
        present(&mut simulator, &resumed);
        dispatch(&mut simulator, op::PAGE_PUSH, json!({"path":SECOND}));
        simulator.pump(0).unwrap();
        assert_eq!(simulator.current_renderer_profile(), RendererProfile::Skia);
        assert!(simulator.browser_render_request().is_none());
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .renderer()
            .last_frame()
            .is_some());
        dispatch(&mut simulator, op::PAGE_POP, json!({"delta":1}));
        simulator.pump(0).unwrap();
        assert_eq!(
            simulator.current_renderer_profile(),
            RendererProfile::WebView
        );
        assert!(simulator.browser_render_request().is_some());
        let returned = prepare(&mut simulator);
        present(&mut simulator, &returned);
        assert!(simulator.host().is_browser_view_presented().unwrap());
    }
}

#[test]
fn cancellation_data_snapshot_satisfies_the_render_without_an_extra_request() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        let previous = settle(&mut simulator);
        start_contact(&mut simulator, &previous);
        dispatch(
            &mut simulator,
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"edit","args":["before-cancel"]}),
        );
        simulator.pump(0).unwrap();
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        let before = simulator.host().session().unwrap().view().template_revision;
        let updated = prepare(&mut simulator);
        assert!(text(&updated.document).starts_with("cancelled/"));
        let input = simulator
            .host()
            .session()
            .unwrap()
            .browser_page_input(&updated.key)
            .unwrap()
            .clone();
        assert!(input.template_revision > before);
        assert_eq!(
            input.template_revision,
            simulator.host().session().unwrap().view().template_revision
        );
        present(&mut simulator, &updated);
        simulator.pump(0).unwrap();
        assert_eq!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
        assert_eq!(inspect(&mut simulator)["cancels"], 1);
    }
}

#[test]
fn explicit_render_override_does_not_satisfy_the_automatic_page_render() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        settle(&mut simulator);
        let mut request = simulator.browser_render_request().unwrap().clone();
        let revision = request.revision.clone();
        request.render["data"] = json!({"label":"explicit"});
        let batch = dispatch(
            &mut simulator,
            op::VIEW_PREPARE,
            json!({"version":request.version,"surfaceGeneration":"1","render":request.render}),
        );
        let submission: BrowserViewSubmission =
            serde_json::from_value(batch.messages[0].payload["submission"].clone()).unwrap();
        assert!(text(&submission.document).starts_with("explicit/"));
        assert!(simulator
            .host()
            .session()
            .unwrap()
            .browser_page_input(&submission.key)
            .is_none());
        present(&mut simulator, &submission);
        simulator.pump(0).unwrap();
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
        let restored = prepare(&mut simulator);
        assert!(text(&restored.document).starts_with("ready/"));
        present(&mut simulator, &restored);
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        simulator.pump(0).unwrap();
        assert_eq!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
    }
}

#[test]
fn component_attached_writes_do_not_upgrade_the_already_consumed_root_snapshot() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let mut pack = Pack::new("view {display:grid}");
        pack.page_source(
            r#"Page({data:{label:'before',show:false}});
exports.reveal=()=>getCurrentPages()[0].setData({show:true});"#,
        );
        pack.manifest.view_scripts.clear();
        let component = r#"Component({lifetimes:{attached(){getCurrentPages()[0].setData({label:'after-attached'})}}});"#;
        let sha256 = pack.blob(component.as_bytes());
        pack.manifest.modules.push(Module {
            id: "module:components/panel/index.js".into(),
            sha256,
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::Component,
            dependencies: vec![],
        });
        pack.manifest.components.push(Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
            multiple_slots: None,
        });
        for (path, source) in [
            (ROUTE, "<text>{{label}}</text><panel wx:if=\"{{show}}\"/>"),
            ("components/panel/index", "<view/>"),
        ] {
            let id = format!("template:{path}.wxml");
            pack.manifest.templates.retain(|template| template.id != id);
            let ast = parse_wxml(source).unwrap();
            let hash = pack.blob(&ast.canonical_json().unwrap());
            pack.manifest.templates.push(Template {
                id,
                wxml_ast: format!("sha256:{hash}"),
                bindings: wxml_bindings(&ast),
                wxs_modules: Default::default(),
            });
        }
        pack.save();
        let mut simulator = pack.start(engine);
        let first = prepare(&mut simulator);
        assert_eq!(text(&first.document), "before");
        present(&mut simulator, &first);
        dispatch(
            &mut simulator,
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"reveal","args":[]}),
        );
        simulator.pump(0).unwrap();
        let before = simulator.host().session().unwrap().view().template_revision;
        let candidate = prepare(&mut simulator);
        assert_eq!(text(&candidate.document), "before");
        let input = simulator
            .host()
            .session()
            .unwrap()
            .browser_page_input(&candidate.key)
            .unwrap()
            .clone();
        assert_eq!(input.template_revision, before);
        assert!(simulator.host().session().unwrap().view().template_revision > before);
        present(&mut simulator, &candidate);
        assert_eq!(
            simulator
                .host()
                .session()
                .unwrap()
                .browser_page_input(&candidate.key),
            Some(&input)
        );
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        simulator.pump(0).unwrap();
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
        let next = prepare(&mut simulator);
        assert_eq!(text(&next.document), "after-attached");
        present(&mut simulator, &next);
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        simulator.pump(0).unwrap();
        assert_eq!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
    }
}

#[test]
fn different_logical_viewport_does_not_satisfy_the_automatic_page_render() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let pack = Pack::new("view {display:grid}");
        let mut simulator = pack.start(engine);
        let current = settle(&mut simulator);
        let mut request = simulator.browser_render_request().unwrap().clone();
        let revision = request.revision.clone();
        assert!(request.render.get("data").is_none());
        request.render["viewport"] = json!({"width":320,"height":480});
        let batch = dispatch(
            &mut simulator,
            op::VIEW_PREPARE,
            json!({"version":request.version,"surfaceGeneration":"1","render":request.render}),
        );
        let different: BrowserViewSubmission =
            serde_json::from_value(batch.messages[0].payload["submission"].clone()).unwrap();
        let input = simulator
            .host()
            .session()
            .unwrap()
            .browser_page_input(&different.key)
            .unwrap();
        assert_eq!(
            (input.viewport.width, input.viewport.height),
            (320.0, 480.0)
        );
        present(&mut simulator, &different);
        simulator.pump(0).unwrap();
        assert_ne!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
        let restored = prepare(&mut simulator);
        assert_eq!(restored.viewport, current.viewport);
        present(&mut simulator, &restored);
        let revision = simulator.browser_render_request().unwrap().revision.clone();
        simulator.pump(0).unwrap();
        assert_eq!(
            simulator.browser_render_request().unwrap().revision,
            revision
        );
    }
}

// These receipts certify runtime transaction ownership using synthetic host
// geometry. Real CSS/image/adapter failure rollback is tested by the DOM client.
fn live_dispatch(simulator: &mut Simulator, operation: &str, payload: Value) -> BridgeBatch {
    let id = NEXT_PACK.fetch_add(1, Ordering::Relaxed);
    let response = simulator
        .dispatch(BridgeEnvelope::request(
            simulator.session_id(),
            format!("live-{id}"),
            operation,
            payload,
        ))
        .unwrap();
    assert_eq!(response.messages[0].payload["ok"], true, "{response:?}");
    response
}

fn live_prepare_dev(simulator: &mut Simulator) -> container_runtime::BrowserLiveViewSubmission {
    let render = simulator.browser_render_request().unwrap().render.clone();
    let epoch = simulator
        .host()
        .session()
        .unwrap()
        .input_lifetime_revision()
        .unwrap()
        .to_string();
    let response = live_dispatch(
        simulator,
        op::VIEW_LIVE_PREPARE,
        json!({"version":"2.0","inputLifetimeRevision":epoch,"surfaceGeneration":"1","render":render}),
    );
    serde_json::from_value(response.messages[0].payload["submission"].clone()).unwrap()
}

fn live_permit_dev(
    simulator: &mut Simulator,
    submission: &container_runtime::BrowserLiveViewSubmission,
) -> Value {
    live_dispatch(
        simulator,
        op::VIEW_LIVE_PERMIT,
        json!({"version":"2.0",
        "inputLifetimeRevision":submission.input_lifetime_revision,"key":submission.key,
        "baseKey":submission.base_key,"documentToken":submission.document_token}),
    )
    .messages[0]
        .payload["permit"]
        .clone()
}

fn live_present_dev(
    simulator: &mut Simulator,
    submission: &container_runtime::BrowserLiveViewSubmission,
) {
    let permit = live_permit_dev(simulator, submission);
    let view = BrowserViewSubmission {
        version: "1.0".into(),
        key: submission.key.clone(),
        viewport: submission.viewport,
        document: submission.document.clone(),
        animation: None,
    };
    live_dispatch(
        simulator,
        op::VIEW_LIVE_PRESENTED,
        json!({"version":"2.0",
        "inputLifetimeRevision":submission.input_lifetime_revision,"permit":permit,"geometry":geometry(&view)}),
    );
}

#[test]
fn development_host_abort_restores_exact_accepted_input_and_keeps_metadata_for_v1_and_v2() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        for live in [false, true] {
            let original = Pack::new("view { display:grid }");
            let mut simulator = original.start(engine);
            let (accepted_key, accepted_document) = if live {
                live_dispatch(
                    &mut simulator,
                    op::VIEW_LIVE_ENABLE,
                    json!({"version":"2.0"}),
                );
                let first = live_prepare_dev(&mut simulator);
                live_present_dev(&mut simulator, &first);
                simulator.pump(0).unwrap();
                let second = live_prepare_dev(&mut simulator);
                live_present_dev(&mut simulator, &second);
                (second.key, second.document)
            } else {
                let accepted = settle(&mut simulator);
                (accepted.key, accepted.document)
            };
            let accepted_request = simulator.browser_render_request().unwrap().clone();
            // Also reject a byte-identical generation: matching manifest hashes
            // cannot substitute for an ACK when deciding simulator publication.
            for style in ["view { display:grid }", "view { display:grid;opacity:.5 }"] {
                let candidate = Pack::new(style);
                let (_, report) = simulator.apply_dev_pack(&candidate.root).unwrap();
                assert_eq!(report.status, "staged");
                assert!(simulator.browser_dev_pack_pending());
                assert!(simulator.host().is_browser_view_presented().unwrap());
                assert_eq!(simulator.root(), original.root);
                assert_eq!(simulator.manifest(), &original.manifest);
                let epoch = simulator
                    .host()
                    .session()
                    .unwrap()
                    .input_lifetime_revision()
                    .unwrap()
                    .to_string();
                let abort = if live {
                    let submission = live_prepare_dev(&mut simulator);
                    let _permit = live_permit_dev(&mut simulator, &submission);
                    assert_eq!(simulator.manifest(), &original.manifest);
                    live_dispatch(
                        &mut simulator,
                        op::VIEW_LIVE_ABORT,
                        json!({"version":"2.0",
                        "inputLifetimeRevision":epoch,"key":submission.key,"documentToken":submission.document_token}),
                    )
                } else {
                    let submission = prepare(&mut simulator);
                    dispatch(
                        &mut simulator,
                        op::VIEW_PREPARE_COMMIT,
                        serde_json::to_value(geometry(&submission)).unwrap(),
                    );
                    assert_eq!(simulator.manifest(), &original.manifest);
                    dispatch(&mut simulator, op::VIEW_ABORT, json!(submission.key))
                };
                assert_eq!(
                    abort.messages[0].payload["restoredKey"],
                    json!(accepted_key)
                );
                assert_eq!(abort.messages[0].payload["inputEnabled"], true);
                assert_eq!(abort.messages[0].payload["inputLifetimeRevision"], epoch);
                assert!(!simulator.browser_dev_pack_pending());
                assert_eq!(simulator.root(), original.root);
                assert_eq!(simulator.manifest(), &original.manifest);
                assert_eq!(
                    simulator.host().session().unwrap().manifest(),
                    &original.manifest
                );
                assert_eq!(simulator.browser_render_request(), Some(&accepted_request));
                assert_eq!(
                    simulator.host().view_document().unwrap().unwrap(),
                    &accepted_document
                );
                assert!(simulator.host().is_browser_view_presented().unwrap());
                simulator.pump(0).unwrap();
                assert_eq!(simulator.browser_render_request(), Some(&accepted_request));
            }
            let committed = Pack::new("view { display:grid;opacity:.75 }");
            simulator.apply_dev_pack(&committed.root).unwrap();
            if live {
                let submission = live_prepare_dev(&mut simulator);
                assert_eq!(text(&submission.document), "ready/2");
                live_present_dev(&mut simulator, &submission);
            } else {
                let submission = prepare(&mut simulator);
                assert_eq!(text(&submission.document), "ready/2");
                present(&mut simulator, &submission);
            }
            assert!(!simulator.browser_dev_pack_pending());
            assert_eq!(simulator.root(), committed.root);
            assert_eq!(simulator.manifest(), &committed.manifest);
            assert_eq!(inspect(&mut simulator)["readies"], 1);
        }
    }
}

#[test]
fn development_permit_cancellation_keeps_effects_but_rejects_the_stale_candidate() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let original = Pack::new("view { display:grid }");
        let mut simulator = original.start(engine);
        let accepted = settle(&mut simulator);
        start_contact(&mut simulator, &accepted);
        let candidate = Pack::new("view { display:grid;opacity:.5 }");
        simulator.apply_dev_pack(&candidate.root).unwrap();
        let submission = prepare(&mut simulator);
        assert_eq!(text(&submission.document), "ready/2");
        let response = simulator
            .dispatch(BridgeEnvelope::request(
                simulator.session_id(),
                "cancel-permit",
                op::VIEW_PREPARE_COMMIT,
                json!(geometry(&submission)),
            ))
            .unwrap();
        assert_eq!(response.messages[0].payload["ok"], false);
        assert_eq!(inspect(&mut simulator)["cancels"], 1);
        assert_eq!(simulator.manifest(), &original.manifest);
        let abort = dispatch(&mut simulator, op::VIEW_ABORT, json!(submission.key));
        assert_eq!(
            abort.messages[0].payload["restoredKey"],
            json!(accepted.key)
        );
        assert!(simulator.host().is_browser_view_presented().unwrap());
        assert_eq!(
            simulator.host().view_document().unwrap().unwrap(),
            &accepted.document
        );
        assert_eq!(inspect(&mut simulator)["data"]["label"], "cancelled");
    }
}

#[test]
fn development_abort_after_resize_never_revives_old_input_or_publishes_candidate() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        let original = Pack::new("view { display:grid }");
        let mut simulator = original.start(engine);
        let _accepted = settle(&mut simulator);
        let candidate = Pack::new("view { display:grid;opacity:.5 }");
        simulator.apply_dev_pack(&candidate.root).unwrap();
        let submission = prepare(&mut simulator);
        simulator
            .apply_presentation(
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 400.0,
                    height: 600.0,
                },
                1.0,
            )
            .unwrap();
        let response = dispatch(&mut simulator, op::VIEW_ABORT, json!(submission.key));
        assert!(response.messages[0].payload.get("restoredKey").is_none());
        assert_ne!(response.messages[0].payload["inputEnabled"], true);
        assert_eq!(simulator.root(), original.root);
        assert_eq!(simulator.manifest(), &original.manifest);
        assert!(!simulator.host().is_browser_view_presented().unwrap());
    }
}

#[test]
fn development_before_first_browser_prepare_binds_the_first_owner_surface() {
    let _engine_guard = engine_test_guard();
    for engine in engines() {
        // Uncached stateful WXS correctly requires restart; this initial
        // surface fixture exercises ordinary declarative bindings only.
        let mut original = Pack::new("view { display:grid }");
        let mut candidate = Pack::new("view { display:grid;opacity:.5 }");
        for pack in [&mut original, &mut candidate] {
            pack.manifest.view_scripts.clear();
            let ast = parse_wxml("<view><text>{{label}}</text></view>").unwrap();
            let hash = pack.blob(&ast.canonical_json().unwrap());
            let template = &mut pack.manifest.templates[0];
            template.wxml_ast = format!("sha256:{hash}");
            template.bindings = wxml_bindings(&ast);
            template.wxs_modules.clear();
            pack.save();
        }
        let mut simulator = original.start(engine);
        assert!(!simulator.host().is_browser_view_presented().unwrap());
        simulator.apply_dev_pack(&candidate.root).unwrap();
        let submission = prepare(&mut simulator);
        assert_eq!(submission.key.surface_generation, 1);
        assert_eq!(text(&submission.document), "initial");
        assert_eq!(simulator.root(), original.root);
        present(&mut simulator, &submission);
        assert_eq!(simulator.root(), candidate.root);
        assert_eq!(inspect(&mut simulator)["readies"], 1);
        assert!(!simulator.browser_dev_pack_pending());
    }
}
