//! Public Session contracts for the explicit modern profile. Auxiliary native
//! evidence, independent of the official WXS/DevTools oracle.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1,
    ModernViewCompilation, ModernViewDocument, ModernViewSource, ModernViewUnit, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template, ViewScriptModule,
};
use container_render_skia::{RenderNode, Renderer};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const PAGE: &str = "pages/index/index.wxml";
const CHILD: &str = "components/card/index.wxml";
const MODERN: &str = r#"
let count=0;
class Box { #value; constructor(value){this.#value=value;} read(){return this.#value;} }
module.exports={"pages/index/index.wxml":{tools:{
  mutate(value){value.n++;count++;return new Box(value.n).read()+':'+count;},
  fail(value){if(value)throw new Error('modern-render-failure');return 'ok';}
}}};
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
    manifest: ContainerManifestV1,
    blobs: BTreeMap<String, Vec<u8>>,
    modules: Vec<Value>,
}

impl Fixture {
    fn new(markup: &str) -> Self {
        let mut fixture = Self {
            manifest: ContainerManifestV1::default(),
            blobs: BTreeMap::new(),
            modules: Vec::new(),
        };
        let mut manifest = ContainerManifestV1 {
            schema_version: 2,
            ..Default::default()
        };
        manifest.compiler.commit = "modern-session-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest
            .capabilities
            .insert("getCurrentPages".into(), CapabilitySupport::Full);
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: Some("pages/index/index.json".into()),
            entry_module: "module:pages/index/index.js".into(),
        });
        manifest.components.push(Component {
            id: "components:pages/index/index.json".into(),
            owner: "pages/index/index.json".into(),
            using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
            multiple_slots: None,
        });
        for (file, source, scope) in [
            ("app.js", "App({});exports.read=function(){return getCurrentPages()[0].data;};exports.patch=function(data){getCurrentPages()[0].setData(data);return true;};", ModuleScope::App),
            ("pages/index/index.js", "Page({data:{obj:{n:1},fail:false,show:true}});", ModuleScope::Page),
            ("components/card/index.js", "Component({properties:{obj:Object}});", ModuleScope::Component),
        ] {
            let id = format!("module:{file}");
            manifest.modules.push(Module { id:id.clone(),sha256:hex_digest(source.as_bytes()),format:ModuleFormat::Commonjs,scope,dependencies:vec![] });
            fixture.modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let legacy = b"var count=0;exports.read=function(value){value.n++;count++;return value.n+':'+count;};";
        let hash = fixture.blob(legacy);
        manifest.view_scripts.push(ViewScriptModule {
            id: "wxs:shared/child.wxs".into(),
            sha256: hash,
            dependencies: vec![],
        });
        for (file, source, bindings) in [
            (PAGE, markup, BTreeMap::new()),
            (
                CHILD,
                r#"<wxs module="legacy" src="../../shared/child.wxs"/><text id="legacy">{{legacy.read(obj)}}/{{obj.n}}</text><slot/>"#,
                BTreeMap::from([("legacy".into(), "wxs:shared/child.wxs".into())]),
            ),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let hash = fixture.blob(&bytes);
            manifest.templates.push(Template {
                id: format!("template:{file}"),
                wxml_ast: format!("sha256:{hash}"),
                bindings: vec![],
                wxs_modules: bindings,
            });
        }
        let executable = fixture.blob(MODERN.as_bytes());
        let map = fixture
            .blob(br#"{"version":3,"sources":["view/main.view.ts"],"names":[],"mappings":"AAAA"}"#);
        let source = fixture.blob(b"// source fixture");
        manifest.modern_view = Some(ModernViewCompilation {
            compiler: "weapp-container-modern-view".into(),
            version: "1.0.0".into(),
            abi: "1.0".into(),
            target: "es2022".into(),
            units: vec![ModernViewUnit {
                id: format!("modern:{}", hex_digest(b"session-unit")),
                executable_sha256: executable,
                source_map_sha256: map,
                sources: vec![ModernViewSource {
                    path: "view/main.view.ts".into(),
                    sha256: source,
                }],
                documents: vec![ModernViewDocument {
                    document_id: PAGE.into(),
                    aliases: vec!["tools".into()],
                }],
            }],
        });
        manifest.refresh_integrity().unwrap();
        fixture.manifest = manifest;
        fixture
    }

    fn blob(&mut self, bytes: &[u8]) -> String {
        let hash = hex_digest(bytes);
        self.blobs.insert(format!("sha256:{hash}"), bytes.to_vec());
        hash
    }

    fn session(&self, engine: EngineKind) -> Session {
        Session::new(
            self.manifest.clone(),
            SessionConfig {
                engine,
                session_id: "modern-contract".into(),
                require_integrity: true,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn initialize(&self, session: &mut Session) -> Value {
        dispatch(
            session,
            op::APP_INIT,
            json!({"modules":self.modules,"blobs":self.blobs}),
        )
    }

    fn start(&self, engine: EngineKind) -> Session {
        let mut session = self.session(engine);
        assert_eq!(self.initialize(&mut session)["ok"], true);
        assert_eq!(
            dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}))["ok"],
            true
        );
        let response = dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"pages/index/index"}),
        );
        assert_eq!(response["ok"], true, "{response}");
        session
    }
}

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "modern-contract",
        "request",
        operation,
        payload,
    ));
    batch.messages[0].payload.clone()
}

fn render(session: &mut Session, id: u64) -> Value {
    dispatch(
        session,
        op::RENDER_COMMIT,
        json!({"templateId":format!("template:{PAGE}"),"frameId":id,"useSessionResources":true}),
    )
}

fn text(session: &Session, selector: &str) -> String {
    fn collect(node: &RenderNode, text: &mut String) {
        if let Some(value) = &node.text {
            text.push_str(value);
        }
        for child in &node.children {
            collect(child, text);
        }
    }
    let frame = session.renderer().last_frame().unwrap();
    let mut result = String::new();
    for node in frame.query(selector, false).unwrap() {
        collect(node, &mut result);
    }
    result
}

#[test]
fn modern_snapshot_mutation_and_legacy_component_membrane_remain_distinct() {
    for engine in engines() {
        let fixture = Fixture::new(
            r#"<view><text id="modern">{{tools.mutate(obj)}}/{{obj.n}}</text><card wx:if="{{show}}" obj="{{obj}}"><text id="projected">{{obj.n}}</text></card><text>{{tools.fail(fail)}}</text></view>"#,
        );
        let mut session = fixture.start(engine);
        let result = render(&mut session, 1);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(text(&session, "#modern"), "2:1/2");
        assert_eq!(text(&session, "#legacy"), "3:1/2");
        assert_eq!(text(&session, "#projected"), "2");
        let data = dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"read","args":[]}),
        );
        assert_eq!(
            data["result"][0]["obj"]["n"], 1,
            "View must not mutate AppService data: {data}"
        );
        assert_eq!(render(&mut session, 2)["ok"], true);
        assert_eq!(
            text(&session, "#modern"),
            "2:1/2",
            "same accepted input reuses document work"
        );
        dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"patch","args":[{"obj":{"n":4}}]}),
        );
        let result = render(&mut session, 3);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(text(&session, "#modern"), "5:2/5");
        assert_eq!(text(&session, "#legacy"), "6:2/5");
        let before = serde_json::to_value(session.renderer().last_frame()).unwrap();
        dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"patch","args":[{"fail":true}]}),
        );
        let result = render(&mut session, 4);
        assert_eq!(result["ok"], false, "{result}");
        assert!(result["error"]["message"]
            .as_str()
            .unwrap()
            .contains("modern-render-failure"));
        assert_eq!(
            serde_json::to_value(session.renderer().last_frame()).unwrap(),
            before
        );
        assert_eq!(
            render(&mut session, 5)["ok"],
            false,
            "rejected work must not replay stateful module calls"
        );
    }
}

#[test]
fn every_modern_blob_is_verified_before_appservice_startup() {
    for engine in engines() {
        for kind in 0..3 {
            let mut fixture = Fixture::new("<text>{{tools.mutate(obj)}}</text>");
            let unit = &fixture.manifest.modern_view.as_ref().unwrap().units[0];
            let hash = match kind {
                0 => unit.executable_sha256.clone(),
                1 => unit.source_map_sha256.clone(),
                _ => unit.sources[0].sha256.clone(),
            };
            fixture
                .blobs
                .insert(format!("sha256:{hash}"), b"tampered".to_vec());
            let mut session = fixture.session(engine);
            let result = fixture.initialize(&mut session);
            assert_eq!(result["ok"], false, "{kind}: {result}");
            assert!(session.app_service().pages().is_empty());
        }
    }
}

#[test]
fn cross_profile_template_edges_are_rejected_without_committing_a_frame() {
    for engine in engines() {
        let fixture = Fixture::new(r#"<include src="../../components/card/index.wxml"/>"#);
        let mut session = fixture.session(engine);
        let initialized = fixture.initialize(&mut session);
        // Registry validation may reject during app.init, before page rendering.
        if initialized["ok"] == true {
            dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
            dispatch(
                &mut session,
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            );
            let result = render(&mut session, 1);
            assert_eq!(result["ok"], false, "{result}");
        }
        assert!(session.renderer().last_frame().is_none());
    }
}
