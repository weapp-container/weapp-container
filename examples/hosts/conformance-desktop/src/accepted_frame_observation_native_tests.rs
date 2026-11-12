//! Actual native engines and accepted CPU raster, with local owner facts only.
//! No native window or presentation ACK is created by these tests.
use super::*;
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
const PAGE_JS:&str="var page;Page({data:{direction:'row-reverse',wrap:'wrap-reverse'},onLoad:function(){page=this}});exports.patch=function(value){page.setData({direction:value,wrap:value==='column'?'wrap':'wrap-reverse'})};";
const MARKUP: &str = r#"
<view id="flex" style="flex-direction:{{direction}};flex-wrap:{{wrap}}"><view id="inherited"/><view id="override"/></view>
<view id="block"/>
<view id="block-explicit" style="flex-direction:{{direction}};flex-wrap:{{wrap}}">
  <view id="block-inherit"/><view id="flex-inherit"/><view id="block-initial"/>
</view>
<view id="none"><view id="none-inherit"/></view>
<view id="duplicate" class="first"/><view id="duplicate" class="second"/>
"#;
const STYLE:&str="page{background:white}#flex{position:absolute;left:10.25px;top:20.5px;width:60.75px;height:40.125px;display:flex;opacity:.5;visibility:hidden;transform:translate(2.5px,3.25px) scale(1.2)}#inherited{width:10px;height:15px}#override{width:20px;height:25px;opacity:.75;visibility:visible}#block,#block-explicit{width:10px;height:12px}#block-inherit,#flex-inherit,#none-inherit{flex-direction:inherit;flex-wrap:inherit;width:2px;height:3px}#flex-inherit{display:flex}#block-initial{flex-direction:initial;flex-wrap:unset;width:2px;height:3px}#none{display:none;flex-direction:column-reverse;flex-wrap:wrap}#duplicate{width:5px;height:6px}";
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
        manifest.compiler.commit = "local-accepted-frame-observer-v1".into();
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
            bindings: vec!["direction".into(), "wrap".into()],
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
    fn observe(&self, o: &Observer, target: Value, fields: &[&str]) -> Result<Value> {
        let a = self.session.accepted_page_observation().unwrap();
        o.observe(
            a.frame,
            self.session.config().engine,
            self.facts(),
            &request(target, fields),
        )
    }
}
#[test]
fn actual_engines_project_accepted_values_handles_and_geometry_without_vm_render_or_pixel_changes()
{
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let o = Observer::new().unwrap();
        let before_frame =
            serde_json::to_vec(f.session.accepted_page_observation().unwrap().frame).unwrap();
        let before_pixels = f.snapshot().pixels;
        let before_view = f.session.view().revision;
        let before_facts = f.facts();
        let r = f
            .observe(&o, json!({"query":{"selector":"#flex"}}), &FIELDS)
            .unwrap();
        let v = &r["nodes"][0]["values"];
        assert_eq!(r["owner"]["engine"], json!(engine));
        assert_eq!(v[FIELDS[0]], "flex");
        assert_eq!(v[FIELDS[1]], "row-reverse");
        assert_eq!(v[FIELDS[2]], "wrap-reverse");
        assert_eq!(v[FIELDS[3]], 0.5);
        assert_eq!(v[FIELDS[4]], "hidden");
        let a = f.session.accepted_page_observation().unwrap();
        let g = a
            .frame
            .node_geometries()
            .into_iter()
            .find(|g| g.node.id == "flex")
            .unwrap();
        assert_eq!(v[FIELDS[6]]["left"], json!(g.bounds.x));
        assert_eq!(v[FIELDS[6]]["width"], json!(g.bounds.width));
        assert_ne!(g.bounds, g.node.bounds);
        let children = f
            .observe(
                &o,
                json!({"parent":r["nodes"][0]["handle"],"selector":"view"}),
                &[FIELDS[3], FIELDS[4]],
            )
            .unwrap();
        assert_eq!(children["count"], 2);
        assert_eq!(children["nodes"][0]["values"][FIELDS[4]], "hidden");
        assert_eq!(children["nodes"][1]["values"][FIELDS[4]], "visible");
        assert_eq!(children["nodes"][1]["values"][FIELDS[3]], 0.75);
        assert_eq!(children["nodes"][1]["parent"], r["nodes"][0]["handle"]);
        let duplicates = f
            .observe(
                &o,
                json!({"query":{"selector":"#duplicate"}}),
                &[FIELDS[0], FIELDS[4]],
            )
            .unwrap();
        assert_eq!(duplicates["count"], 2);
        assert_ne!(
            duplicates["nodes"][0]["handle"],
            duplicates["nodes"][1]["handle"]
        );
        assert_eq!(f.session.view().revision, before_view);
        assert_eq!(f.facts(), before_facts);
        assert_eq!(
            serde_json::to_vec(f.session.accepted_page_observation().unwrap().frame).unwrap(),
            before_frame
        );
        assert_eq!(f.snapshot().pixels, before_pixels);
        // A real guest mutation + actual render invalidates the old frame handle.
        f.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"patch","args":["column"]}),
        );
        f.render();
        assert_ne!(f.facts()["renderRevision"], before_facts["renderRevision"]);
        assert!(f
            .observe(&o, json!({"node":r["nodes"][0]["handle"]}), &[FIELDS[0]])
            .is_err());
        let fresh = f
            .observe(&o, json!({"query":{"selector":"#flex"}}), &[FIELDS[1]])
            .unwrap();
        assert_eq!(fresh["nodes"][0]["values"][FIELDS[1]], "column");
    }
}
#[test]
fn actual_nonflex_used_column_preserves_computed_row_and_missing_visibility_never_defaults() {
    for engine in engines() {
        let f = Fixture::new(engine);
        let o = Observer::new().unwrap();
        let block = f
            .observe(
                &o,
                json!({"query":{"selector":"#block"}}),
                &[FIELDS[0], FIELDS[1], FIELDS[2], FIELDS[4]],
            )
            .unwrap();
        assert_eq!(block["nodes"][0]["values"][FIELDS[0]], "block");
        assert_eq!(block["nodes"][0]["values"][FIELDS[1]], "row");
        assert_eq!(block["nodes"][0]["values"][FIELDS[2]], "nowrap");
        assert_eq!(block["nodes"][0]["values"][FIELDS[4]], "visible");
        let a = f.session.accepted_page_observation().unwrap();
        // Mutated copies are negative fixtures, never claimed as runtime output.
        let mut copied = a.frame.clone();
        fn remove(n: &mut RenderNode) {
            n.computed_style.remove("visibility");
            for c in &mut n.children {
                remove(c)
            }
        }
        remove(&mut copied.root);
        assert!(o
            .observe(
                &copied,
                engine,
                f.facts(),
                &request(json!({"query":{"selector":"#block"}}), &[FIELDS[4]])
            )
            .is_err());
    }
}

#[test]
fn actual_engines_retain_computed_flex_values_across_formatters_inheritance_and_guest_updates() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let o = Observer::new().unwrap();
        for (selector, display, direction, wrap, used) in [
            ("#block", "block", "row", "nowrap", FlexDirection::Column),
            (
                "#block-explicit",
                "block",
                "row-reverse",
                "wrap-reverse",
                FlexDirection::Column,
            ),
            (
                "#block-inherit",
                "block",
                "row-reverse",
                "wrap-reverse",
                FlexDirection::Column,
            ),
            (
                "#flex-inherit",
                "flex",
                "row-reverse",
                "wrap-reverse",
                FlexDirection::RowReverse,
            ),
            (
                "#block-initial",
                "block",
                "row",
                "nowrap",
                FlexDirection::Column,
            ),
            (
                "#none",
                "none",
                "column-reverse",
                "wrap",
                FlexDirection::Column,
            ),
            (
                "#none-inherit",
                "block",
                "column-reverse",
                "wrap",
                FlexDirection::Column,
            ),
        ] {
            let before =
                serde_json::to_vec(f.session.accepted_page_observation().unwrap().frame).unwrap();
            let pixels = f.snapshot().pixels;
            let result = f
                .observe(&o, json!({"query":{"selector":selector}}), &FIELDS[..3])
                .unwrap();
            let values = &result["nodes"][0]["values"];
            assert_eq!(result["count"], 1);
            assert_eq!(values[FIELDS[0]], display);
            assert_eq!(values[FIELDS[1]], direction);
            assert_eq!(values[FIELDS[2]], wrap);
            let accepted = f.session.accepted_page_observation().unwrap();
            let geometry = accepted
                .frame
                .node_geometries()
                .into_iter()
                .find(|g| g.node.attributes.get("id").map(String::as_str) == Some(&selector[1..]))
                .unwrap();
            assert_eq!(geometry.node.style.unwrap().direction, used);
            assert_eq!(serde_json::to_vec(accepted.frame).unwrap(), before);
            assert_eq!(f.snapshot().pixels, pixels);
            eprintln!(
                "computed-flex-local-raster {}",
                json!({"engine":engine,"selector":selector,"observation":result,"usedDirection":used,"nativeWindowAck":false})
            );
        }
        f.ok(
            op::MODULE_CALL,
            json!({"moduleId":PAGE,"export":"patch","args":["column"]}),
        );
        f.render();
        for selector in [
            "#flex",
            "#block-explicit",
            "#block-inherit",
            "#flex-inherit",
        ] {
            let result = f
                .observe(
                    &o,
                    json!({"query":{"selector":selector}}),
                    &[FIELDS[1], FIELDS[2]],
                )
                .unwrap();
            assert_eq!(result["nodes"][0]["values"][FIELDS[1]], "column");
            assert_eq!(result["nodes"][0]["values"][FIELDS[2]], "wrap");
            eprintln!(
                "computed-flex-local-raster-updated {}",
                json!({"engine":engine,"selector":selector,"observation":result,"nativeWindowAck":false})
            );
        }
        let original = f.session.accepted_page_observation().unwrap().frame;
        for property in ["flex-direction", "flex-wrap"] {
            let mut copied = original.clone();
            fn remove(node: &mut RenderNode, property: &str) {
                node.computed_style.remove(property);
                for child in &mut node.children {
                    remove(child, property);
                }
            }
            remove(&mut copied.root, property);
            assert!(o
                .observe(
                    &copied,
                    engine,
                    f.facts(),
                    &request(
                        json!({"query":{"selector":"#block"}}),
                        &[if property == "flex-direction" {
                            FIELDS[1]
                        } else {
                            FIELDS[2]
                        }]
                    )
                )
                .is_err());
        }
    }
}
