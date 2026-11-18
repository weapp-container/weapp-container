//! Actual native engines and accepted CPU raster, with local owner facts only.
//! No native window or presentation ACK is created by these tests.
use super::*;
use container_ir::hex_digest;
use std::collections::BTreeMap;
const ROUTE: &str = "pages/index/index";
use container_bridge::{op, BridgeEnvelope};
use container_ir::{
    parse_wxml, parse_wxss, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
    RouteKind, Style, StyleScope, Template,
};
use container_render_skia::RenderSnapshot;
use container_runtime::{Session, SessionConfig};
const SESSION: &str = "observer-local-test";
const TEMPLATE: &str = "template:pages/index/index.wxml";
const PAGE: &str = "module:pages/index/index.js";
const PAGE_JS: &str = "var page;Page({data:{first:0,second:0,covered:false},onLoad:function(){page=this},first:function(){this.setData({first:this.data.first+1})},second:function(){this.setData({second:this.data.second+1})}});exports.cover=function(){page.setData({covered:true})};";
const MARKUP: &str = r#"<button id="duplicate" class="candidate first" bindtap="first">First</button><button id="duplicate" class="candidate second" bindtap="second">Second</button><view wx:if="{{covered}}" id="cover"/>"#;
const STYLE: &str = "page{background:white}.candidate{position:absolute;top:10px;width:25px;height:25px}.first{left:10px}.second{left:60px}#cover{position:absolute;left:10px;top:10px;width:25px;height:25px;background:red}";
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
    sequence: u64,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "local-opaque-node-input-v1".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.routes.push(Route {
            id: "route:pages/index/index".into(),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "pages/index/index.js".into(),
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            ("module:app.js", "App({});", ModuleScope::App),
            (PAGE, PAGE_JS, ModuleScope::Page),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
            modules.push(json!({"id":id,"bytes":source.as_bytes()}));
        }
        let template = parse_wxml(MARKUP).unwrap().canonical_json().unwrap();
        let tp = format!("sha256:{}", hex_digest(&template));
        manifest.templates.push(Template {
            id: TEMPLATE.into(),
            wxml_ast: tp.clone(),
            bindings: vec!["covered".into()],
            wxs_modules: BTreeMap::new(),
        });
        let style = parse_wxss(STYLE).unwrap().canonical_json().unwrap();
        let sp = format!("sha256:{}", hex_digest(&style));
        manifest.styles.push(Style {
            id: "style:pages/index/index.wxss".into(),
            wxss_ir: sp.clone(),
            scope: StyleScope::Page,
        });
        let blobs = BTreeMap::from([(tp, template), (sp, style)]);
        manifest.refresh_integrity().unwrap();
        let mut f = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: SESSION.into(),
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        f.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        f.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        f.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        f.render();
        f
    }
    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        self.sequence += 1;
        let response = self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("observer-{}", self.sequence),
            operation,
            payload,
        ));
        let value = response
            .messages
            .iter()
            .find(|m| m.op == operation)
            .unwrap()
            .payload
            .clone();
        assert_eq!(value["ok"], true, "{operation}: {value}");
        value
    }
    fn render(&mut self) {
        self.ok(op::RENDER_COMMIT,json!({"templateId":TEMPLATE,"frameId":self.sequence+1,"useSessionResources":true,"viewport":{"width":100,"height":100}}));
    }
    fn snapshot(&self) -> RenderSnapshot {
        self.session.renderer().snapshot().unwrap()
    }
    fn facts(&self) -> Value {
        let a = self.session.accepted_page_observation().unwrap();
        let page = self.session.app_service().pages().current().unwrap();
        let input = self.session.last_frame_input(a.render_revision).unwrap();
        assert_eq!(input.page_id, page.id);
        assert_eq!(input.route_path, page.path);
        assert_eq!(
            input.template_revision,
            self.session.view().template_revision
        );
        json!({"kind":"local-raster-frame-facts-v1","sessionId":self.session.config().session_id,"route":page.path,
            "pageId":page.id.0.to_string(),"templateRevision":input.template_revision.to_string(),
            "frameId":a.frame.frame_id.to_string(),"renderRevision":a.render_revision.to_string()})
    }
    fn acquire(&self, observer: &Observer, selection: &str) -> Value {
        let a = self.session.accepted_page_observation().unwrap();
        let request = AcquireRequest::parse(&json!({"id":1,"op":ACQUIRE,"version":1,"route":ROUTE,
            "target":{"query":{"selector":".candidate"}},"selection":selection}))
        .unwrap();
        acquire(
            observer,
            a.frame,
            self.session.config().engine,
            self.facts(),
            &request,
        )
        .unwrap()
    }
    fn prepare(&self, observer: &Observer, node: Value) -> Result<PreparedTap> {
        let request =
            TapRequest::parse(&json!({"id":2,"op":TAP,"version":1,"route":ROUTE,"node":node}))
                .unwrap();
        let a = self.session.accepted_page_observation().unwrap();
        prepare_tap(
            observer,
            a.frame,
            self.session.config().engine,
            self.facts(),
            &request,
        )
    }
    fn input(&mut self, prepared: PreparedTap) -> Value {
        self.ok(
            op::EVENT_BATCH,
            json!({"events":[{"type":"tap","x":prepared.x,"y":prepared.y,
            "detail":{"x":prepared.x,"y":prepared.y},"button":0,"buttons":0,"bubbles":true}]}),
        )
    }
    fn data(&self) -> Value {
        self.session
            .app_service()
            .pages()
            .current()
            .unwrap()
            .data
            .clone()
    }
}

#[test]
fn actual_engines_first_duplicate_public_id_dispatches_only_the_actual_first_node() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let observer = Observer::new().unwrap();
        assert!(f.session.is_current_frame_presented()); // Legacy local raster only; no NativeWindow ACK.
        let before_frame =
            serde_json::to_vec(f.session.accepted_page_observation().unwrap().frame).unwrap();
        let before_pixels = f.snapshot().pixels;
        let first = f.acquire(&observer, "first");
        let all = f.acquire(&observer, "all");
        assert_eq!(first["matchCount"], 2);
        assert_eq!(first["count"], 1);
        assert_eq!(first["nodes"][0], all["nodes"][0]);
        assert_eq!(
            all["nodes"][0]["metadata"]["publicId"],
            all["nodes"][1]["metadata"]["publicId"]
        );
        assert_ne!(all["nodes"][0]["handle"], all["nodes"][1]["handle"]);
        assert_ne!(
            all["nodes"][0]["metadata"]["eventIdentity"],
            all["nodes"][1]["metadata"]["eventIdentity"]
        );
        let handle = first["nodes"][0]["handle"].clone();
        let prepared = f.prepare(&observer, handle.clone()).unwrap();
        assert_eq!(
            serde_json::to_vec(f.session.accepted_page_observation().unwrap().frame).unwrap(),
            before_frame
        );
        assert_eq!(f.snapshot().pixels, before_pixels);
        assert_eq!(f.data()["first"], 0);
        let input = f.input(prepared);
        assert_eq!(input["events"], 1);
        assert_eq!(f.data()["first"], 1);
        assert_eq!(f.data()["second"], 0);
        f.render();
        assert!(f.prepare(&observer, handle).is_err());
        let fresh = f.acquire(&observer, "all");
        let prepared = f
            .prepare(&observer, fresh["nodes"][1]["handle"].clone())
            .unwrap();
        f.input(prepared);
        assert_eq!(f.data()["first"], 1);
        assert_eq!(f.data()["second"], 1);
        eprintln!(
            "opaque-node-local-raster {}",
            json!({"engine":engine,"firstAcquisition":first,
            "afterActualCoordinateEvents":f.data(),"nativeWindowAck":false})
        );
    }
}
#[test]
fn actual_engines_cover_and_foreign_session_tokens_fail_before_coordinate_dispatch() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let observer = Observer::new().unwrap();
        let first = f.acquire(&observer, "first");
        assert!(f
            .prepare(
                &Observer::new().unwrap(),
                first["nodes"][0]["handle"].clone()
            )
            .is_err());
        f.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"cover","args":[]}),
        );
        f.render();
        let selected = f.acquire(&observer, "first");
        let before = f.data();
        let pixels = f.snapshot().pixels;
        assert!(f
            .prepare(&observer, selected["nodes"][0]["handle"].clone())
            .is_err());
        assert_eq!(f.data(), before);
        assert_eq!(f.snapshot().pixels, pixels);
        assert_eq!(f.data()["first"], 0);
        assert_eq!(f.data()["second"], 0);
    }
}
