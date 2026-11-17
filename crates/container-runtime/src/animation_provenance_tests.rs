//! Real Session/AppService/View regressions for animation dependency ownership.
//! The external-frame ACK is simulated; these tests do not claim browser evidence.
use super::*;
use crate::animation_bindings::PreparedDescriptor;
use container_ir::{
    hex_digest, parse_wxml, BindingDataPath, BindingPathSegment, CapabilitySupport, Component,
    Module, ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::PageRenderMode;

const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({observed:0,component:null});
globalThis.makeAnimation=function(value){return wx.createAnimation({duration:1000,timingFunction:'linear'}).opacity(value).step().export();};
function page(){return getCurrentPages()[0];}
exports.first=()=>{page().setData({'items[0].animation':page().data.items[0].animation});return true;};
exports.label=()=>{page().setData({'items[0].label':'changed'});return true;};
exports.selectFirst=()=>{page().setData({selected:0});return true;};
exports.parent=()=>{page().setData({animation:page().data.animation});return true;};
exports.replaceParent=()=>{page().setData({animation:makeAnimation(.6)});return true;};
exports.hide=()=>{page().setData({show:false});return true;};
exports.show=()=>{page().setData({show:true});return true;};
exports.equalComponent=()=>{getApp().component.equalAnimation();return true;};
exports.overrideComponent=()=>{getApp().component.overrideAnimation();return true;};
exports.inspect=()=>({observed:getApp().observed});
"#;
const PAGE: &str = r#"
Page({data:{show:true,selected:1,enabled:true,items:[],animation:null,globalAnimation:null,alternative:null},onLoad(){
 const animation=makeAnimation(.9);
 this.setData({animation,globalAnimation:makeAnimation(.8),alternative:makeAnimation(.3),items:[{id:'a',label:'first',animation},{id:'b',label:'second',animation:makeAnimation(.7)}]});
}});
"#;
const PANEL: &str = r#"
Component({properties:{animation:{type:Object,value:null}},
 observers:{animation(){getApp().observed++;}},
 lifetimes:{attached(){getApp().component=this;}},
 methods:{equalAnimation(){this.setData({animation:this.data.animation});},overrideAnimation(){this.setData({animation:makeAnimation(.4)});}}});
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn ok(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        operation,
        operation,
        payload,
    ));
    assert!(
        batch
            .messages
            .iter()
            .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
        "{batch:?}"
    );
    batch.messages[0].payload.clone()
}
fn call(session: &mut Session, export: &str) -> Value {
    ok(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    )["result"][0]
        .clone()
}
fn fixture(engine: EngineKind, page: &str, extra: &[(&str, &str)], component: bool) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "animation-provenance-session-regression".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "module:app.js".into();
    manifest.routes.push(Route {
        id: format!("route:{ROUTE}"),
        path: ROUTE.into(),
        kind: RouteKind::Page,
        config: None,
        entry_module: format!("module:{ROUTE}.js"),
    });
    if component {
        manifest.components.push(Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
            multiple_slots: None,
        });
    }
    let mut modules = Vec::new();
    let mut sources = vec![
        ("module:app.js", APP, ModuleScope::App),
        ("module:pages/index/index.js", PAGE, ModuleScope::Page),
    ];
    if component {
        sources.push((
            "module:components/panel/index.js",
            PANEL,
            ModuleScope::Component,
        ));
    }
    for (id, source, scope) in sources {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
        modules.push(json!({"id":id,"source":source}));
    }
    let mut templates = vec![("template:pages/index/index.wxml", page)];
    templates.extend_from_slice(extra);
    if component {
        templates.push((
            "template:components/panel/index.wxml",
            r#"<view id="inside" animation="{{animation}}"/>"#,
        ));
    }
    let mut blobs = BTreeMap::new();
    for (id, source) in templates {
        let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        manifest.templates.push(Template {
            id: id.into(),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: BTreeMap::new(),
        });
        blobs.insert(pointer, bytes);
    }
    for name in [
        "wx.createAnimation",
        "getCurrentPages",
        "Page.selectComponent",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut config = SessionConfig {
        engine,
        page_render_mode: PageRenderMode::ExternalFrame,
        ..Default::default()
    };
    config.host.window_width = 320;
    config.host.window_height = 480;
    let mut session = Session::new(manifest, config).unwrap();
    session
        .animation_clock
        .advance_to(std::time::Duration::ZERO)
        .unwrap();
    ok(
        &mut session,
        op::APP_INIT,
        json!({"modules":modules,"blobs":blobs}),
    );
    ok(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    ok(&mut session, op::PAGE_PUSH, json!({"path":ROUTE}));
    session
}
fn render(session: &mut Session) -> Vec<PreparedDescriptor> {
    ok(
        session,
        op::RENDER_COMMIT,
        json!({"templateId":"template:pages/index/index.wxml","useSessionResources":true,"viewport":{"width":320,"height":480}}),
    );
    let descriptors = session
        .pending_native_animations
        .as_ref()
        .expect("native animation candidate")
        .1
        .bindings
        .as_ref()
        .expect("template binding candidate")
        .descriptors
        .clone();
    session
        .acknowledge_presentation(session.render_revision())
        .unwrap();
    assert!(session.is_current_frame_presented());
    descriptors
}
fn child(descriptors: Vec<PreparedDescriptor>) -> PreparedDescriptor {
    assert!(
        descriptors
            .iter()
            .any(|descriptor| descriptor.key.owner.scope_id.is_none()),
        "custom component host retains its own animation projection"
    );
    let mut children = descriptors
        .into_iter()
        .filter(|descriptor| descriptor.key.owner.scope_id.is_some());
    let child = children.next().expect("managed child animation");
    assert!(
        children.next().is_none(),
        "fixture has one managed child animation"
    );
    child
}
fn path(parts: &[&str]) -> BindingDataPath {
    parts
        .iter()
        .map(|part| {
            part.parse::<usize>()
                .map(BindingPathSegment::Index)
                .unwrap_or_else(|_| BindingPathSegment::Key((*part).into()))
        })
        .collect()
}
fn depends(descriptor: &PreparedDescriptor, expected: &BindingDataPath) -> bool {
    descriptor
        .resolved_paths
        .iter()
        .any(|dependency| &dependency.path == expected)
}

#[test]
fn real_session_loop_template_include_and_dynamic_reads_replay_only_matching_writes() {
    for engine in engines() {
        let mut session = fixture(
            engine,
            r#"<view wx:for="{{items}}" wx:key="id" animation="{{item.animation}}"/><template name="row"><view animation="{{value}}"/></template><template is="row" data="{{value:items[1].animation}}"/><include src="./nested.wxml"/><view animation="{{enabled ? items[selected].animation : alternative}}"/>"#,
            &[(
                "template:pages/index/nested.wxml",
                r#"<view animation="{{globalAnimation}}"/>"#,
            )],
            false,
        );
        let first = render(&mut session);
        assert_eq!(first.len(), 5, "{engine:?}");
        assert!(first.iter().all(|descriptor| descriptor.new_run));
        assert_eq!(
            first
                .iter()
                .filter(|descriptor| depends(descriptor, &path(&["items", "0", "animation"])))
                .count(),
            1
        );
        assert_eq!(
            first
                .iter()
                .filter(|descriptor| depends(descriptor, &path(&["items", "1", "animation"])))
                .count(),
            3
        );
        assert_eq!(
            first
                .iter()
                .filter(|descriptor| depends(descriptor, &path(&["globalAnimation"])))
                .count(),
            1
        );
        let dynamic = first
            .iter()
            .find(|descriptor| depends(descriptor, &path(&["selected"])))
            .unwrap();
        assert!(depends(dynamic, &path(&["enabled"])));
        call(&mut session, "label");
        assert!(render(&mut session)
            .iter()
            .all(|descriptor| !descriptor.new_run));
        call(&mut session, "first");
        let replay = render(&mut session);
        assert_eq!(
            replay
                .iter()
                .filter(|descriptor| descriptor.new_run)
                .count(),
            1
        );
        assert!(depends(
            replay.iter().find(|descriptor| descriptor.new_run).unwrap(),
            &path(&["items", "0", "animation"])
        ));
        call(&mut session, "selectFirst");
        let selected = render(&mut session);
        assert_eq!(
            selected
                .iter()
                .filter(|descriptor| descriptor.new_run)
                .count(),
            1
        );
        let selected = selected
            .iter()
            .find(|descriptor| descriptor.new_run)
            .unwrap();
        assert!(depends(selected, &path(&["selected"])));
        assert!(depends(selected, &path(&["items", "0", "animation"])));
        assert_eq!(selected.key, dynamic.key);
    }
}

#[test]
fn real_session_forwarding_local_override_and_equal_component_write_keep_private_owners() {
    for engine in engines() {
        let mut session = fixture(
            engine,
            r#"<panel id="panel" animation="{{animation}}"/>"#,
            &[],
            true,
        );
        let initial = child(render(&mut session));
        assert!(initial.key.owner.scope_id.is_some());
        assert_eq!(initial.resolved_paths.len(), 1);
        assert!(initial.resolved_paths[0].owner.scope_id.is_none());
        call(&mut session, "parent");
        let forwarded = child(render(&mut session));
        assert!(
            forwarded.new_run,
            "equal parent write must traverse the property source snapshot: {engine:?}"
        );
        assert_eq!(forwarded.key, initial.key);
        call(&mut session, "overrideComponent");
        let local = child(render(&mut session));
        assert!(local.new_run);
        assert_eq!(local.resolved_paths[0].owner, local.key.owner);
        call(&mut session, "parent");
        let ignored = child(render(&mut session));
        assert!(
            !ignored.new_run,
            "parent write cannot override a local property write: {engine:?}"
        );
        let observed = call(&mut session, "inspect")["observed"].clone();
        call(&mut session, "equalComponent");
        assert_eq!(
            call(&mut session, "inspect")["observed"],
            observed,
            "equal animation write must not invoke ordinary observers: {engine:?}"
        );
        let equal = child(render(&mut session));
        assert!(
            equal.new_run,
            "equal successful component write still replays: {engine:?}"
        );
        assert_eq!(equal.resolved_paths[0].owner, equal.key.owner);
        call(&mut session, "replaceParent");
        let external = child(render(&mut session));
        assert!(external.new_run);
        assert!(
            external.resolved_paths[0].owner.scope_id.is_none(),
            "changed external property restores parent provenance: {engine:?}"
        );
    }
}

#[test]
fn real_session_accepted_removal_recreates_node_and_component_incarnations() {
    for engine in engines() {
        for component in [false, true] {
            let source = if component {
                r#"<panel wx:if="{{show}}" id="panel" animation="{{animation}}"/>"#
            } else {
                r#"<view wx:if="{{show}}" animation="{{animation}}"/>"#
            };
            let mut session = fixture(engine, source, &[], component);
            let descriptors = render(&mut session);
            let first = if component {
                child(descriptors)
            } else {
                descriptors.into_iter().next().unwrap()
            };
            call(&mut session, "hide");
            assert!(render(&mut session).is_empty());
            call(&mut session, "show");
            let descriptors = render(&mut session);
            let recreated = if component {
                child(descriptors)
            } else {
                descriptors.into_iter().next().unwrap()
            };
            assert!(recreated.new_run);
            assert_eq!(first.key.source_site, recreated.key.source_site);
            assert_ne!(first.key,recreated.key,"accepted removal must retire reused source identity: {engine:?}, component={component}");
            if component {
                assert_ne!(
                    first.key.owner.scope_incarnation,
                    recreated.key.owner.scope_incarnation
                );
            } else {
                assert_eq!(first.key.owner, recreated.key.owner);
                assert_ne!(first.key.incarnation, recreated.key.incarnation);
            }
        }
    }
}
