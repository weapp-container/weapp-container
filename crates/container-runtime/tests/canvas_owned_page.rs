//! Real AppService receiver -> Session -> immutable Canvas image -> page paint.
//! ExternalFrame snapshots are explicit software diagnostics. The separately
//! ignored macOS Metal case submits a NativeGpu Session to real offscreen
//! textures. Both native engine providers use the same fixture.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::{
    PageRenderMode, Rect, RenderFrame, RenderNode, RenderSnapshot, Renderer,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({callbacks:[],results:[],errors:[],savedPages:[],savedComponents:[],unloads:0,queueBeforeFirst:false});
globalThis.submitOwnedCanvas=function(ctx,reserve,label){
  try {
    ctx.draw(reserve,value=>getApp().callbacks.push({label:label,canvasId:value.canvasId}))
      .then(value=>getApp().results.push({label:label,width:value.width,height:value.height}),
            error=>getApp().errors.push({label:label,code:error.code}));
  } catch(error) { getApp().errors.push({label:label,code:error.code}); }
  return true;
};
globalThis.fillOwnedCanvas=function(ctx,color,x,width,reserve,label){
  ctx.setFillStyle(color);ctx.fillRect(x,0,width,2);
  return submitOwnedCanvas(ctx,reserve,label);
};
function page(){const pages=getCurrentPages();return pages[pages.length-1];}
exports.queueBeforeFirst=value=>{getApp().queueBeforeFirst=value;return true;};
exports.draw=(color,x,width,reserve,label)=>page().paint(color,x,width,reserve,label);
exports.invalid=()=>page().invalid();
exports.hideCanvas=()=>{page().setData({showCanvas:false});return true;};
exports.hideAndDraw=()=>{const current=page();current.setData({showCanvas:false});return current.paint('blue',0,3,true,'same-turn');};
exports.callbackHideAndDraw=()=>{const current=page(),ctx=current.ctx;
  ctx.setFillStyle('red');ctx.fillRect(0,0,1,2);
  ctx.draw(false,value=>{getApp().callbacks.push({label:'first-callback',canvasId:value.canvasId});current.setData({showCanvas:false});})
    .then(value=>getApp().results.push({label:'first-callback',width:value.width,height:value.height}),error=>getApp().errors.push({label:'first-callback',code:error.code}));
  fillOwnedCanvas(ctx,'blue',1,1,true,'after-callback');return true;
};
exports.showCanvas=()=>{page().setData({showCanvas:true});return true;};
exports.hideComponent=()=>{page().setData({showComponent:false});return true;};
exports.showComponent=()=>{page().setData({showComponent:true});return true;};
exports.recreate=()=>{page().createContext();return true;};
exports.savedPageDraw=(index,color,label)=>fillOwnedCanvas(getApp().savedPages[index],color,0,3,false,label);
exports.componentDraw=(color,label)=>page().selectComponent('#panel').paint(color,label);
exports.savedComponentDraw=(index,color,label)=>fillOwnedCanvas(getApp().savedComponents[index],color,0,3,false,label);
exports.noop=()=>true;
exports.startAggregateDraws=()=>{
  const app=getApp();app.aggregate={next:0,rejected:[],callbacks:[],settled:[],errors:[],retry:false};
  app.aggregateDash=Array(50000).fill(1);
  return exports.continueAggregateDraws();
};
exports.continueAggregateDraws=(limit=25)=>{
  const app=getApp(),state=app.aggregate,ctx=page().ctx;
  while(state.next<Math.min(limit,25)){
    const index=state.next;
    if(!state.retry){
      ctx.setLineDash(app.aggregateDash,0);
      ctx.setFillStyle(index===19?'blue':index===24?'green':'red');ctx.fillRect(0,0,3,2);
    }
    try {
      ctx.draw(false,()=>state.callbacks.push(index))
        .then(()=>state.settled.push(index),error=>state.errors.push({index,code:error.code}));
      state.next++;state.retry=false;
    } catch(error) {
      state.rejected.push({index,code:error.code,errMsg:error.errMsg});state.retry=true;break;
    }
  }
  return {next:state.next,rejections:state.rejected.length,retry:state.retry};
};
exports.inspectAggregateDraws=()=>getApp().aggregate;
exports.inspect=()=>({callbacks:getApp().callbacks,results:getApp().results,errors:getApp().errors,
  unloads:getApp().unloads,pageContexts:getApp().savedPages.length,componentContexts:getApp().savedComponents.length});
"#;
const PAGE: &str = r#"
Page({
  data:{showCanvas:true,showComponent:true},
  onLoad(){
    this.createContext();
    if(getApp().queueBeforeFirst)this.paint('red',0,3,false,'queued');
  },
  onUnload(){getApp().unloads++;},
  createContext(){this.ctx=wx.createCanvasContext('shared',this);getApp().savedPages.push(this.ctx);},
  paint(color,x,width,reserve,label){return fillOwnedCanvas(this.ctx,color,x,width,reserve,label);},
  invalid(){
    this.ctx.setFillStyle('blue');this.ctx.fillRect(1,0,1,2);
    // Both commands are finite JS/f32 inputs; their composed f32 CTM is not.
    // Renderer admission rejects the whole reserve batch before any pixels.
    this.ctx.scale(1e30,1e30);this.ctx.scale(1e30,1e30);
    return submitOwnedCanvas(this.ctx,true,'invalid');
  }
});
"#;
const COMPONENT: &str = r#"
Component({methods:{paint(color,label){
  if(!this.ctx){this.ctx=wx.createCanvasContext('shared',this);getApp().savedComponents.push(this.ctx);}
  return fillOwnedCanvas(this.ctx,color,0,3,false,label);
}}});
"#;
const PAGE_WXML: &str = r#"
<view style="position:relative;width:8px;height:4px;background-color:#ffffff">
  <canvas wx:if="{{showCanvas}}" id="page-canvas" canvas-id="shared" width="3" height="2"
    style="position:absolute;left:0px;top:0px;width:3px;height:2px"/>
  <panel wx:if="{{showComponent}}" id="panel"
    style="position:absolute;left:4px;top:0px;width:3px;height:2px"/>
</view>
"#;
const COMPONENT_WXML: &str = r#"
<canvas id="component-canvas" canvas-id="shared" width="3" height="2" style="width:3px;height:2px"/>
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
    session: Session,
    sequence: u64,
}

impl Fixture {
    fn new(engine: EngineKind, queue_before_first: bool) -> Self {
        Self::with_mode(engine, queue_before_first, PageRenderMode::ExternalFrame)
    }

    fn with_mode(
        engine: EngineKind,
        queue_before_first: bool,
        page_render_mode: PageRenderMode,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "owned-canvas-real-session-page-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "module:app.js".into();
        manifest.routes.push(Route {
            id: format!("route:{ROUTE}"),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{ROUTE}.js"),
        });
        manifest.components.push(Component {
            id: format!("components:{ROUTE}.json"),
            owner: format!("{ROUTE}.json"),
            using_components: BTreeMap::from([("panel".into(), "components/panel/index".into())]),
            multiple_slots: None,
        });
        let mut modules = Vec::new();
        for (id, source, scope) in [
            ("module:app.js", APP, ModuleScope::App),
            ("module:pages/index/index.js", PAGE, ModuleScope::Page),
            (
                "module:components/panel/index.js",
                COMPONENT,
                ModuleScope::Component,
            ),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
            modules.push(json!({"id":id,"source":source}));
        }
        let mut blobs = BTreeMap::new();
        for (id, source) in [
            ("template:pages/index/index.wxml", PAGE_WXML),
            ("template:components/panel/index.wxml", COMPONENT_WXML),
        ] {
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
            "wx.createCanvasContext",
            "wx.canvas.draw",
            "getCurrentPages",
            "Page.selectComponent",
            "wx.reLaunch",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let mut config = SessionConfig {
            engine,
            page_render_mode,
            ..Default::default()
        };
        config.host.window_width = 8;
        config.host.window_height = 4;
        let mut fixture = Self {
            session: Session::new(manifest, config).unwrap(),
            sequence: 0,
        };
        fixture.ok(op::APP_INIT, json!({"modules":modules,"blobs":blobs}));
        fixture.ok(op::APP_LIFECYCLE, json!({"event":"launch"}));
        fixture.call("queueBeforeFirst", json!([queue_before_first]));
        fixture.ok(op::PAGE_PUSH, json!({"path":ROUTE}));
        fixture
    }

    fn ready(engine: EngineKind) -> Self {
        let mut fixture = Self::new(engine, false);
        fixture.render();
        fixture
    }

    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("owned-page-{}", self.sequence),
            operation,
            payload,
        ))
    }

    fn ok(&mut self, operation: &str, payload: Value) -> Value {
        let batch = self.raw(operation, payload);
        assert!(
            batch
                .messages
                .iter()
                .all(|message| message.op != op::ERROR && message.payload["ok"] != false),
            "{operation}: {batch:?}"
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload.clone()
    }

    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )["result"][0]
            .clone()
    }

    fn commit_layout(&mut self) -> u64 {
        self.ok(
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml","useSessionResources":true,
                "viewport":{"width":8,"height":4}
            }),
        );
        self.session.render_revision()
    }

    fn render(&mut self) {
        // A first-frame queued draw may publish a newer image revision during
        // the commit's effect drain. Acknowledge the actual current revision.
        let revision = self.commit_layout();
        self.session.acknowledge_presentation(revision).unwrap();
        self.call("noop", json!([]));
    }

    fn inspect(&mut self) -> Value {
        self.call("noop", json!([]));
        self.call("inspect", json!([]))
    }

    fn accepted(&self) -> RenderFrame {
        self.session.renderer().last_frame().unwrap().clone()
    }

    fn snapshot(&self) -> RenderSnapshot {
        self.session.render_snapshot().unwrap()
    }

    fn draw(&mut self, color: &str, x: u32, width: u32, reserve: bool, label: &str) {
        assert_eq!(
            self.call("draw", json!([color, x, width, reserve, label])),
            true
        );
    }
}

fn pixel(snapshot: &RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
    let index = y * snapshot.stride as usize + x * 4;
    snapshot.pixels[index..index + 4].try_into().unwrap()
}

fn canvas(node: &RenderNode, scoped: bool) -> Option<&RenderNode> {
    if node.tag.as_deref() == Some("canvas") && node.event_owner_scope_id.is_some() == scoped {
        return Some(node);
    }
    node.children.iter().find_map(|child| canvas(child, scoped))
}

fn geometry(frame: &RenderFrame) -> Vec<(Option<String>, Rect)> {
    fn visit(node: &RenderNode, output: &mut Vec<(Option<String>, Rect)>) {
        output.push((node.event_identity.clone(), node.bounds));
        for child in &node.children {
            visit(child, output);
        }
    }
    let mut output = Vec::new();
    visit(&frame.root, &mut output);
    output
}

fn labels(state: &Value, field: &str) -> Vec<String> {
    state[field]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["label"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn real_page_draw_publishes_pixels_without_relayout_or_page_frame_id_change() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        let before = f.accepted();
        let revision = f.session.render_revision();
        let input = f.session.last_frame_input(revision).cloned();
        let target = f.session.accepted_page_observation().unwrap().target;
        assert_eq!(
            canvas(&before.root, false).unwrap().bounds,
            Rect {
                x: 0.,
                y: 0.,
                width: 3.,
                height: 2.
            }
        );
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        f.draw("red", 0, 3, false, "first");
        let after = f.accepted();
        assert!(f.session.render_revision() > revision, "{engine:?}");
        assert_eq!(after.frame_id, before.frame_id);
        assert_eq!(f.snapshot().frame_id, before.frame_id);
        assert_eq!(geometry(&after), geometry(&before));
        assert_eq!(
            f.session.last_frame_input(f.session.render_revision()),
            input.as_ref()
        );
        assert_eq!(
            f.session.accepted_page_observation().unwrap().target,
            target
        );
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 2, 1), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 3, 0), [255, 255, 255, 255]);
        assert!(canvas(&after.root, false).unwrap().image.is_some());
        let state = f.inspect();
        assert_eq!(labels(&state, "callbacks"), ["first"]);
        assert_eq!(
            state["results"],
            json!([{"label":"first","width":3,"height":2}])
        );
        assert_eq!(state["errors"], json!([]));
        assert!(
            f.session.canvas_snapshot("shared").is_none(),
            "owned surfaces do not share the legacy canvasId map"
        );
        assert!(f.session.execution_fault().is_none());
    }
}

#[test]
fn public_api_canvas_id_and_owner_fields_cannot_repaint_the_page_canvas() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "owned");
        let accepted = f.accepted();
        let pixels = f.snapshot();
        let revision = f.session.render_revision();
        f.ok(op::API_CALL, json!({
            "name":"wx.canvas.draw","canvasId":"shared","width":3,"height":2,"reserve":false,
            "owner":{"pageId":"1","scopeId":null},"context":"1","nodeGeneration":1,
            "commands":[{"op":"setFillStyle","args":["blue"]},{"op":"fillRect","args":[0,0,3,2]}]
        }));
        assert_eq!(f.session.render_revision(), revision, "{engine:?}");
        assert_eq!(f.accepted(), accepted);
        assert_eq!(f.snapshot(), pixels);
        assert_eq!(
            pixel(&f.session.canvas_snapshot("shared").unwrap(), 0, 0),
            [0, 0, 255, 255]
        );
    }
}

#[test]
fn rejected_owned_reserve_batch_preserves_pixels_and_the_next_reserve_base() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 1, false, "first");
        let pixels = f.snapshot();
        let frame = f.accepted();
        let revision = f.session.render_revision();
        assert_eq!(f.call("invalid", json!([])), true);
        assert_eq!(f.session.render_revision(), revision, "{engine:?}");
        assert_eq!(f.snapshot(), pixels);
        assert_eq!(f.accepted(), frame);
        let state = f.inspect();
        assert_eq!(labels(&state, "callbacks"), ["first"]);
        assert_eq!(labels(&state, "errors"), ["invalid"]);
        f.draw("green", 2, 1, true, "reserve");
        let next = f.snapshot();
        assert_eq!(pixel(&next, 0, 0), [255, 0, 0, 255]);
        assert_eq!(
            pixel(&next, 1, 0),
            [255, 255, 255, 255],
            "failed blue pixels and commands must not enter replay"
        );
        assert_eq!(pixel(&next, 2, 0), [0, 128, 0, 255]);
        assert_eq!(next.frame_id, frame.frame_id);
        assert_eq!(labels(&f.inspect(), "callbacks"), ["first", "reserve"]);
        assert!(f.session.execution_fault().is_none());
    }
}

#[test]
fn onload_draw_waits_for_the_first_accepted_canvas_declaration() {
    for engine in engines() {
        let mut f = Fixture::new(engine, true);
        assert!(f.session.render_snapshot().is_none());
        let waiting = f.inspect();
        assert_eq!(waiting["pageContexts"], 1);
        assert_eq!(waiting["callbacks"], json!([]));
        assert_eq!(waiting["results"], json!([]));
        assert_eq!(waiting["errors"], json!([]));
        f.render();
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255], "{engine:?}");
        let state = f.inspect();
        assert_eq!(labels(&state, "callbacks"), ["queued"]);
        assert_eq!(labels(&state, "results"), ["queued"]);
        assert_eq!(state["errors"], json!([]));
        f.call("noop", json!([]));
        assert_eq!(
            labels(&f.inspect(), "callbacks"),
            ["queued"],
            "first-frame completion is delivered once"
        );
    }
}

#[test]
fn removed_and_recreated_canvas_never_rebinds_the_old_context() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "first");
        f.call("hideCanvas", json!([]));
        f.render();
        assert!(canvas(&f.accepted().root, false).is_none());
        f.call("showCanvas", json!([]));
        f.render();
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        let revision = f.session.render_revision();
        f.draw("blue", 0, 3, true, "stale");
        assert_eq!(f.session.render_revision(), revision, "{engine:?}");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        let state = f.inspect();
        assert_eq!(labels(&state, "callbacks"), ["first"]);
        assert_eq!(
            state["errors"],
            json!([{"label":"stale","code":"ERR_CANCELLED"}])
        );
        f.call("recreate", json!([]));
        f.draw("green", 0, 3, true, "fresh");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [0, 128, 0, 255]);
        assert_eq!(labels(&f.inspect(), "callbacks"), ["first", "fresh"]);
    }
}

#[test]
fn component_same_canvas_id_is_isolated_and_detached_receiver_cannot_repaint() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "page");
        f.call("componentDraw", json!(["blue", "component"]));
        let frame = f.accepted();
        let component = canvas(&frame.root, true).unwrap();
        assert_eq!((component.bounds.width, component.bounds.height), (3., 2.));
        let x = component.bounds.x as usize;
        let y = component.bounds.y as usize;
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), x, y), [0, 0, 255, 255], "{engine:?}");
        f.call("hideComponent", json!([]));
        f.render();
        assert!(canvas(&f.accepted().root, true).is_none());
        f.call("showComponent", json!([]));
        f.render();
        let revision = f.session.render_revision();
        f.call("savedComponentDraw", json!([0, "green", "detached"]));
        assert_eq!(f.session.render_revision(), revision);
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), x, y), [255, 255, 255, 255]);
        let state = f.inspect();
        assert_eq!(
            state["errors"],
            json!([{"label":"detached","code":"ERR_CANCELLED"}])
        );
        f.call("componentDraw", json!(["green", "replacement"]));
        assert_eq!(pixel(&f.snapshot(), x, y), [0, 128, 0, 255]);
        assert_eq!(
            labels(&f.inspect(), "callbacks"),
            ["page", "component", "replacement"]
        );
    }
}

#[test]
fn relaunch_unloads_the_old_page_and_rejects_its_saved_context() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "old-page");
        let old_page = f.session.app_service().pages().current().unwrap().id;
        f.ok(
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":format!("/{ROUTE}")}),
        );
        f.render();
        assert_ne!(
            f.session.app_service().pages().current().unwrap().id,
            old_page
        );
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        let revision = f.session.render_revision();
        f.call("savedPageDraw", json!([0, "blue", "unloaded"]));
        assert_eq!(f.session.render_revision(), revision, "{engine:?}");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        let state = f.inspect();
        assert_eq!(state["unloads"], 1);
        assert_eq!(state["pageContexts"], 2);
        assert_eq!(
            state["errors"],
            json!([{"label":"unloaded","code":"ERR_CANCELLED"}])
        );
        f.draw("green", 0, 3, false, "new-page");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [0, 128, 0, 255]);
        assert_eq!(labels(&f.inspect(), "callbacks"), ["old-page", "new-page"]);
    }
}

#[test]
fn unrestricted_renderer_borrow_retires_owned_context_even_after_new_manifest_frame() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "before-borrow");
        let old_pixels = f.snapshot();
        let revision = f.session.render_revision();
        let _ = f.session.renderer_mut();
        assert!(!f.session.has_current_skia_scene());
        f.draw("blue", 0, 3, true, "after-borrow");
        assert_eq!(f.session.render_revision(), revision, "{engine:?}");
        assert_eq!(f.snapshot(), old_pixels);
        f.render();
        assert!(f.session.has_current_skia_scene());
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        let restored_revision = f.session.render_revision();
        f.draw("blue", 0, 3, true, "after-frame");
        assert_eq!(f.session.render_revision(), restored_revision);
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        assert_eq!(
            f.inspect()["errors"],
            json!([
                {"label":"after-borrow","code":"ERR_CANCELLED"},
                {"label":"after-frame","code":"ERR_CANCELLED"}
            ])
        );
        f.call("recreate", json!([]));
        f.draw("green", 0, 3, false, "fresh");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [0, 128, 0, 255]);
        assert!(f.session.execution_fault().is_none());
    }
}

#[test]
fn draw_queued_behind_declaration_removal_never_paints_the_retired_occurrence() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "first");
        let old_frame = f.accepted();
        let old_revision = f.session.render_revision();
        f.call("hideCanvas", json!([]));
        f.draw("blue", 0, 3, true, "queued-stale");
        assert_eq!(f.session.render_revision(), old_revision, "{engine:?}");
        assert_eq!(f.accepted(), old_frame);
        let pending = f.inspect();
        assert_eq!(labels(&pending, "callbacks"), ["first"]);
        assert_eq!(pending["errors"], json!([]));
        f.render();
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        assert_eq!(
            f.inspect()["errors"],
            json!([{"label":"queued-stale","code":"ERR_CANCELLED"}])
        );
        f.call("showCanvas", json!([]));
        f.render();
        f.draw("blue", 0, 3, true, "still-stale");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        assert_eq!(labels(&f.inspect(), "callbacks"), ["first"]);
    }
}

#[test]
fn logical_resize_candidate_keeps_canvas_history_transactional_and_rebinds_the_same_occurrence() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 1, false, "first");
        let old_frame = f.accepted();
        let old_pixels = f.snapshot();
        let old_revision = f.session.render_revision();
        let viewport = Rect {
            x: 0.,
            y: 0.,
            width: 10.,
            height: 4.,
        };
        let candidate = f.session.prepare_dev_logical_resize(viewport, 1.).unwrap();
        assert!(candidate.picture().is_some());
        drop(candidate);
        assert_eq!(f.session.render_revision(), old_revision, "{engine:?}");
        assert_eq!(f.accepted(), old_frame);
        assert_eq!(f.snapshot(), old_pixels);
        // Geometry abort retires input authority, so a normal current-size
        // manifest frame is required before any further owned publication.
        f.render();
        f.draw("green", 2, 1, true, "after-abort");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 2, 0), [0, 128, 0, 255]);
        let candidate = f.session.prepare_dev_logical_resize(viewport, 1.).unwrap();
        let mut accepted = candidate.accept_with_retirement();
        assert!(accepted
            .take_effects()
            .messages
            .iter()
            .all(|message| message.op != op::ERROR));
        drop(accepted);
        f.session
            .acknowledge_presentation(f.session.render_revision())
            .unwrap();
        assert_eq!(f.snapshot().width, 10);
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 2, 0), [0, 128, 0, 255]);
        f.draw("blue", 1, 1, true, "after-resize");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 1, 0), [0, 0, 255, 255]);
        assert_eq!(pixel(&f.snapshot(), 2, 0), [0, 128, 0, 255]);
        assert_eq!(f.inspect()["errors"], json!([]));
    }
}

#[test]
fn same_call_setdata_removal_is_applied_before_the_owned_draw_can_publish() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        f.draw("red", 0, 3, false, "first");
        let frame = f.accepted();
        let pixels = f.snapshot();
        let revision = f.session.render_revision();
        assert_eq!(f.call("hideAndDraw", json!([])), true);
        assert_eq!(
            f.session.render_revision(),
            revision,
            "same-call write must precede private draw: {engine:?}"
        );
        assert_eq!(f.accepted(), frame);
        assert_eq!(f.snapshot(), pixels);
        let waiting = f.inspect();
        assert_eq!(labels(&waiting, "callbacks"), ["first"]);
        assert_eq!(waiting["errors"], json!([]));
        f.render();
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        assert_eq!(
            f.inspect()["errors"],
            json!([{"label":"same-turn","code":"ERR_CANCELLED"}])
        );
    }
}

#[test]
fn draw_callback_setdata_is_applied_before_the_next_already_queued_draw() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        let revision = f.session.render_revision();
        assert_eq!(f.call("callbackHideAndDraw", json!([])), true);
        assert_eq!(
            f.session.render_revision(),
            revision + 1,
            "only the first candidate may publish before its callback: {engine:?}"
        );
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(pixel(&f.snapshot(), 1, 0), [255, 255, 255, 255]);
        let waiting = f.inspect();
        assert_eq!(labels(&waiting, "callbacks"), ["first-callback"]);
        assert_eq!(waiting["errors"], json!([]));
        f.render();
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 255, 255, 255]);
        assert_eq!(
            f.inspect()["errors"],
            json!([{"label":"after-callback","code":"ERR_CANCELLED"}])
        );
    }
}

#[test]
fn aggregate_capture_admission_rejects_synchronously_and_all_twenty_five_native_draws_settle() {
    for engine in engines() {
        let mut f = Fixture::ready(engine);
        let first = f.call("startAggregateDraws", json!([]));
        assert_eq!(
            first,
            json!({"next":19,"rejections":1,"retry":true}),
            "{engine:?}"
        );
        f.call("noop", json!([]));
        let initial = f.call("inspectAggregateDraws", json!([]));
        assert_eq!(pixel(&f.snapshot(), 0, 0), [255, 0, 0, 255]);
        assert_eq!(
            initial["callbacks"],
            json!((0..19).collect::<Vec<_>>()),
            "{engine:?}"
        );
        assert_eq!(
            initial["settled"],
            json!((0..19).collect::<Vec<_>>()),
            "{engine:?}"
        );
        assert_eq!(initial["errors"], json!([]));
        assert_eq!(initial["rejected"][0]["index"], 19);
        assert_eq!(initial["rejected"][0]["code"], "ERR_RESOURCE_LIMIT");
        assert!(initial["rejected"][0]["errMsg"]
            .as_str()
            .unwrap()
            .contains("item budget"));
        // Retry draw itself before adding another command: synchronous rejection
        // must leave that exact 50,000-scalar batch available to the next turn.
        let retry = f.call("continueAggregateDraws", json!([20]));
        assert_eq!(
            retry,
            json!({"next":20,"rejections":1,"retry":false}),
            "{engine:?}"
        );
        assert_eq!(
            pixel(&f.snapshot(), 0, 0),
            [0, 0, 255, 255],
            "the rejected original commands must publish blue on retry"
        );
        let retry = f.call("continueAggregateDraws", json!([]));
        assert_eq!(
            retry,
            json!({"next":25,"rejections":1,"retry":false}),
            "{engine:?}"
        );
        f.call("noop", json!([]));
        let state = f.call("inspectAggregateDraws", json!([]));
        assert_eq!(
            state["callbacks"],
            json!((0..25).collect::<Vec<_>>()),
            "{engine:?}"
        );
        assert_eq!(
            state["settled"],
            json!((0..25).collect::<Vec<_>>()),
            "{engine:?}"
        );
        assert_eq!(state["errors"], json!([]));
        f.call("noop", json!([]));
        assert_eq!(
            f.call("inspectAggregateDraws", json!([])),
            state,
            "no duplicate completion after ACK"
        );
        assert!(f.session.execution_fault().is_none(), "{engine:?}");
        assert_eq!(pixel(&f.snapshot(), 0, 0), [0, 128, 0, 255]);
    }
}

#[cfg(all(target_os = "macos", feature = "skia-gpu-metal"))]
mod metal_session {
    use super::*;
    use container_bridge::BridgeErrorCode;
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_metal::{
        MTLBlitCommandEncoder, MTLCommandBuffer, MTLCommandBufferStatus, MTLCommandEncoder,
        MTLCommandQueue, MTLCreateSystemDefaultDevice, MTLDevice, MTLOrigin, MTLPixelFormat,
        MTLRegion, MTLResource, MTLSize, MTLStorageMode, MTLTexture, MTLTextureDescriptor,
        MTLTextureUsage,
    };
    use std::{ptr::NonNull, sync::Arc};

    const WIDTH: u32 = 8;
    const HEIGHT: u32 = 4;

    fn texture(device: &ProtocolObject<dyn MTLDevice>) -> Retained<ProtocolObject<dyn MTLTexture>> {
        let descriptor = unsafe {
            MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                MTLPixelFormat::BGRA8Unorm,
                WIDTH as usize,
                HEIGHT as usize,
                false,
            )
        };
        descriptor.setUsage(MTLTextureUsage::RenderTarget | MTLTextureUsage::ShaderRead);
        // Shared storage is CPU-coherent on unified-memory GPUs. Managed
        // storage needs the explicit GPU-to-CPU synchronization below.
        descriptor.setStorageMode(if device.hasUnifiedMemory() {
            MTLStorageMode::Shared
        } else {
            MTLStorageMode::Managed
        });
        device
            .newTextureWithDescriptor(&descriptor)
            .expect("Metal texture")
    }

    fn wait_and_read(
        queue: &ProtocolObject<dyn MTLCommandQueue>,
        texture: &ProtocolObject<dyn MTLTexture>,
    ) -> Vec<u8> {
        // This command buffer uses the exact queue attached to Session, so
        // completion follows Skia's flush-and-submit. Keep all handles alive.
        let barrier = queue.commandBuffer().expect("same-queue Metal barrier");
        if texture.storageMode() == MTLStorageMode::Managed {
            let blit = barrier.blitCommandEncoder().expect("Metal readback blit");
            unsafe { blit.synchronizeTexture_slice_level(texture, 0, 0) };
            blit.endEncoding();
        }
        barrier.commit();
        unsafe { barrier.waitUntilCompleted() };
        assert_eq!(barrier.status(), MTLCommandBufferStatus::Completed);
        assert!(unsafe { barrier.error() }.is_none(), "Metal barrier failed");
        let mut bytes = vec![0; (WIDTH * HEIGHT * 4) as usize];
        unsafe {
            texture.getBytes_bytesPerRow_fromRegion_mipmapLevel(
                NonNull::new(bytes.as_mut_ptr().cast()).unwrap(),
                (WIDTH * 4) as usize,
                MTLRegion {
                    origin: MTLOrigin { x: 0, y: 0, z: 0 },
                    size: MTLSize {
                        width: WIDTH as usize,
                        height: HEIGHT as usize,
                        depth: 1,
                    },
                },
                0,
            );
        }
        bytes
    }

    fn submit_and_read(
        session: &mut Session,
        queue: &ProtocolObject<dyn MTLCommandQueue>,
        texture: &Retained<ProtocolObject<dyn MTLTexture>>,
    ) -> Vec<u8> {
        let revision = session.render_revision();
        unsafe {
            session
                .render_last_frame_to_metal_texture(Retained::as_ptr(texture).cast(), WIDTH, HEIGHT)
                .unwrap();
        }
        let pixels = wait_and_read(queue, texture);
        assert_eq!(session.render_revision(), revision);
        pixels
    }

    fn bgra(bytes: &[u8], x: usize, y: usize) -> [u8; 4] {
        let index = (y * WIDTH as usize + x) * 4;
        bytes[index..index + 4].try_into().unwrap()
    }

    fn assert_page_pixels(bytes: &[u8], canvas_bgra: [u8; 4]) {
        assert_eq!(bytes.len(), (WIDTH * HEIGHT * 4) as usize);
        for y in 0..HEIGHT as usize {
            for x in 0..WIDTH as usize {
                let expected = if x < 3 && y < 2 {
                    canvas_bgra
                } else {
                    [255, 255, 255, 255]
                };
                assert_eq!(bgra(bytes, x, y), expected, "Metal page pixel ({x}, {y})");
            }
        }
    }

    #[test]
    #[ignore = "requires a real macOS Metal device; run explicitly for Session GPU validation"]
    fn real_page_canvas_repaint_submits_to_metal_and_acks_exact_revision() {
        let device = unsafe { Retained::from_raw(MTLCreateSystemDefaultDevice()) }
            .expect("real Metal device");
        let queue = device.newCommandQueue().expect("Metal queue");
        for engine in engines() {
            let mut f = Fixture::with_mode(engine, false, PageRenderMode::NativeGpu);
            assert_eq!(f.session.page_render_mode(), PageRenderMode::NativeGpu);
            unsafe {
                f.session
                    .attach_metal_context(
                        Retained::as_ptr(&device).cast(),
                        Retained::as_ptr(&queue).cast(),
                    )
                    .unwrap();
            }
            assert!(f.session.has_metal_context());
            let first_revision = f.commit_layout();
            let layout = f.accepted();
            let input = f.session.last_frame_input(first_revision).cloned();
            let target = f
                .session
                .render_target_for_revision(first_revision)
                .unwrap();
            assert_eq!((target.width, target.height), (WIDTH, HEIGHT));
            assert!(input.is_some(), "{engine:?}");
            assert!(f.session.render_snapshot().is_none());
            assert!(f
                .session
                .accepted_page_observation()
                .unwrap()
                .snapshot
                .is_none());

            let first_texture = texture(&device);
            let first_pixels = submit_and_read(&mut f.session, &queue, &first_texture);
            assert_page_pixels(&first_pixels, [255, 255, 255, 255]);
            assert!(f.session.page_render_status().gpu_surface);
            // ACK is a host sequencing contract, not a GPU completion token.
            // This test only sends it after the real queue has completed.
            f.session.acknowledge_presentation(first_revision).unwrap();
            f.call("noop", json!([]));

            f.draw("red", 0, 3, false, "metal-red");
            let red_revision = f.session.render_revision();
            let red_frame = f.accepted();
            assert!(red_revision > first_revision, "{engine:?}");
            assert_eq!(red_frame.frame_id, layout.frame_id);
            assert_eq!(geometry(&red_frame), geometry(&layout));
            assert_eq!(f.session.last_frame_input(red_revision), input.as_ref());
            assert_eq!(
                f.session.render_target_for_revision(red_revision).unwrap(),
                target
            );
            let red_image_id = &canvas(&red_frame.root, false)
                .unwrap()
                .image
                .as_ref()
                .unwrap()
                .resource;
            let red_image = red_frame.images[red_image_id].clone();
            let retained_red_pixels = red_image.pixels.clone();
            assert_eq!((red_image.width, red_image.height), (3, 2));
            assert_eq!(retained_red_pixels, [255, 0, 0, 255].repeat(6));
            let red_texture = texture(&device);
            let red_pixels = submit_and_read(&mut f.session, &queue, &red_texture);
            assert_page_pixels(&red_pixels, [0, 0, 255, 255]);
            f.session.acknowledge_presentation(red_revision).unwrap();

            f.draw("blue", 0, 3, false, "metal-blue");
            let blue_revision = f.session.render_revision();
            let blue_frame = f.accepted();
            assert!(blue_revision > red_revision, "{engine:?}");
            assert_eq!(blue_frame.frame_id, layout.frame_id);
            assert_eq!(geometry(&blue_frame), geometry(&layout));
            assert_eq!(f.session.last_frame_input(blue_revision), input.as_ref());
            assert_eq!(
                f.session.render_target_for_revision(blue_revision).unwrap(),
                target
            );
            let stale = f
                .session
                .acknowledge_presentation(red_revision)
                .unwrap_err();
            assert_eq!(stale.code, BridgeErrorCode::Cancelled);
            assert_eq!(stale.message, "stale presentation revision");
            let blue_image_id = &canvas(&blue_frame.root, false)
                .unwrap()
                .image
                .as_ref()
                .unwrap()
                .resource;
            let blue_image = &blue_frame.images[blue_image_id];
            assert!(!Arc::ptr_eq(&red_image, blue_image));
            assert_eq!(blue_image.pixels, [0, 0, 255, 255].repeat(6));
            assert!(Arc::ptr_eq(&red_frame.images[red_image_id], &red_image));
            assert_eq!(red_image.pixels, retained_red_pixels);
            let blue_texture = texture(&device);
            let blue_pixels = submit_and_read(&mut f.session, &queue, &blue_texture);
            assert_page_pixels(&blue_pixels, [255, 0, 0, 255]);
            assert_eq!(wait_and_read(&queue, &red_texture), red_pixels);
            assert_eq!(wait_and_read(&queue, &first_texture), first_pixels);
            assert_eq!(red_image.pixels, retained_red_pixels);
            assert!(f.session.render_snapshot().is_none());
            assert!(f
                .session
                .accepted_page_observation()
                .unwrap()
                .snapshot
                .is_none());
            assert_eq!(
                f.session.accepted_page_observation().unwrap().target,
                target
            );
            f.session.acknowledge_presentation(blue_revision).unwrap();
            assert!(f
                .session
                .acknowledge_presentation(blue_revision)
                .unwrap()
                .messages
                .is_empty());
            let state = f.inspect();
            assert_eq!(labels(&state, "callbacks"), ["metal-red", "metal-blue"]);
            assert_eq!(labels(&state, "results"), ["metal-red", "metal-blue"]);
            assert_eq!(state["errors"], json!([]));
            assert!(f.session.execution_fault().is_none());
            eprintln!("Metal Session Canvas passed engine={engine:?} revisions={first_revision},{red_revision},{blue_revision}");
        }
    }
}
