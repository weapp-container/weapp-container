//! Consumed component mutation receipts are local scheduling evidence only.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, Component, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_render_skia::PageRenderMode;
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;
const ROUTE: &str = "pages/index/index";
const APP: &str = r#"
App({values:[],failures:[],mode:'none',readyWrite:false});
function page(){return getCurrentPages()[0];}
function panel(){return page().selectComponent('#panel');}
exports.patch=function(value){page().setData({value:value});return true;};
exports.write=function(value){panel().setData({value:value});return true;};
exports.mode=function(value){getApp().mode=value;return true;};
exports.armReady=function(){getApp().readyWrite=true;return true;};
exports.query=function(){wx.createSelectorQuery().select('#target').boundingClientRect(v=>getApp().values.push(v.width)).exec().catch(e=>getApp().failures.push(e.code));return true;};
exports.inspect=function(){return {values:getApp().values,failures:getApp().failures};};
exports.armLate=function(){
  const commit=globalThis.__container_commit_component_relations;
  let once=true;
  globalThis.__container_commit_component_relations=function(batch){
    const receipt=commit(batch);
    if(once && batch.scopeIds.length){once=false;Promise.resolve().then(()=>panel().setData({value:177}));}
    return receipt;
  };
  return true;
};
exports.spoofMutableVersion=function(){panel().__container_input_revision='0';panel().__container_instance_token='0';panel().setData({value:199});return true;};
exports.unknownPatch=function(){__container_events.push({type:'component.property.patch',scopeId:panel().__container_scope_id,pageId:page().__container_instance_id,inputIdentity:{instanceToken:'0001',mutationRevision:'0'}});return true;};

let oldToJson;
exports.hostileJsonWrite=function(){
  const accepted=__container_component_snapshot_value(panel()).inputIdentity;
  oldToJson=Object.getOwnPropertyDescriptor(Object.prototype,'toJSON');
  Object.defineProperty(Object.prototype,'toJSON',{configurable:true,value:function(){
    if(this.type==='component.property.patch'){
      const value=Object.assign(Object.create(null),this);value.inputIdentity=accepted;return value;
    }
    return this;
  }});
  panel().setData({value:199});return true;
};
exports.restoreJson=function(){if(oldToJson)Object.defineProperty(Object.prototype,'toJSON',oldToJson);else delete Object.prototype.toJSON;return true;};
exports.currentValue=function(){return panel().data.value;};
exports.interceptPatchWrite=function(){
  const accepted=__container_component_snapshot_value(panel()).inputIdentity;
  const push=__container_events.push;
  __container_events.push=function(event){
    if(event.type==='component.property.patch')event.inputIdentity.mutationRevision=accepted.mutationRevision;
    return push.call(this,event);
  };
  try{panel().setData({value:199});}finally{__container_events.push=push;}
  return true;
};

let originalDrain;
exports.armForgedDrain=function(){
  const receiver=panel();
  const accepted=__container_component_snapshot_value(receiver).inputIdentity;
  originalDrain=globalThis.__container_drain_events;
  receiver.setData({value:199});
  let emitted=false;
  globalThis.__container_drain_events=function(){if(emitted)return {events:[],errors:[]};emitted=true;return [null,{
    __componentMutations:{'0':{pageId:String(page().__container_instance_id),scopeId:receiver.__container_scope_id,instanceToken:accepted.instanceToken,mutationRevision:accepted.mutationRevision}},
    events:[{type:'component.property.patch',scopeId:receiver.__container_scope_id,pageId:page().__container_instance_id}]
  }];};
  return true;
};
exports.restoreDrain=function(){globalThis.__container_drain_events=originalDrain;return true;};
"#;
const PAGE: &str = r#"Page({data:{value:80}});"#;
const PANEL: &str = r#"
Component({properties:{value:{type:Number,value:20,observer(value){
  if(getApp().mode==='root' && value===120)getCurrentPages()[0].setData({value:160});
}}},lifetimes:{ready(){if(getApp().readyWrite)this.setData({value:190});}}});
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
    fn start(engine: EngineKind) -> Self {
        let mut m = ContainerManifestV1::default();
        m.compiler.commit = "consumed-component-input-regressions".into();
        m.app.app_json = "app.json".into();
        m.app.entry_module = "module:app.js".into();
        m.routes.push(Route {
            id: "route:index".into(),
            path: ROUTE.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("module:{ROUTE}.js"),
        });
        m.components.push(Component {
            id: "components:index".into(),
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
                PANEL,
                ModuleScope::Component,
            ),
        ] {
            m.modules.push(Module {
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
            (
                "template:pages/index/index.wxml",
                r#"<panel id="panel" value="{{value}}"/>"#,
            ),
            (
                "template:components/panel/index.wxml",
                r#"<view id="target" style="width:{{value}}px;height:20px"/>"#,
            ),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let ptr = format!("sha256:{}", hex_digest(&bytes));
            m.templates.push(Template {
                id: id.into(),
                wxml_ast: ptr.clone(),
                bindings: vec![],
                wxs_modules: BTreeMap::new(),
            });
            blobs.insert(ptr, bytes);
        }
        for name in [
            "wx.createSelectorQuery",
            "getCurrentPages",
            "Page.selectComponent",
        ] {
            m.capabilities.insert(name.into(), CapabilitySupport::Full);
        }
        m.refresh_integrity().unwrap();
        let mut f = Self {
            session: Session::new(
                m,
                SessionConfig {
                    engine,
                    page_render_mode: PageRenderMode::ExternalFrame,
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
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            self.sequence.to_string(),
            operation,
            payload,
        ));
        assert!(
            batch
                .messages
                .iter()
                .all(|m| m.op != op::ERROR && m.payload["ok"] != false),
            "{batch:?}"
        );
        batch.messages[0].payload.clone()
    }
    fn call(&mut self, export: &str, args: Value) -> Value {
        self.ok(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":export,"args":args}),
        )["result"][0]
            .clone()
    }
    fn render(&mut self) {
        self.ok(op::RENDER_COMMIT,json!({"templateId":"template:pages/index/index.wxml","useSessionResources":true,"viewport":{"width":320,"height":480}}));
    }
    fn ack(&mut self) {
        self.session
            .acknowledge_presentation(self.session.render_revision())
            .unwrap();
    }
    fn state(&mut self) -> Value {
        self.call("inspect", json!([]))
    }
}
#[test]
fn parent_property_prefix_consumed_by_accepted_frame_does_not_dirty_it_again() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("patch", json!([120]));
        f.render();
        f.ack();
        f.call("query", json!([]));
        assert_eq!(f.state(), json!({"values":[120],"failures":[]}));
    }
}
#[test]
fn component_set_data_after_accepted_snapshot_waits_for_its_own_frame() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("write", json!([130]));
        f.call("query", json!([]));
        assert_eq!(f.state(), json!({"values":[],"failures":[]}));
        f.ack();
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[130],"failures":[]}));
    }
}
#[test]
fn ready_component_write_does_not_get_recaptured_as_consumed_input() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.call("armReady", json!([]));
        f.ack();
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[190],"failures":[]}));
    }
}
#[test]
fn component_observer_root_write_cannot_refresh_the_root_clone_revision() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("mode", json!(["root"]));
        f.call("patch", json!([120]));
        f.render();
        f.ack();
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[160],"failures":[]}));
    }
}
#[test]
fn microtask_after_final_snapshot_cannot_be_marked_consumed_by_acceptance() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("armLate", json!([]));
        f.call("patch", json!([120]));
        f.render();
        f.ack();
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[177],"failures":[]}));
    }
}
#[test]
fn mutable_instance_fields_and_unknown_event_identity_cannot_bypass_dirty_fence() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("spoofMutableVersion", json!([]));
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state()["values"], json!([199]));
        f.call("unknownPatch", json!([]));
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([199]));
        f.render();
        f.ack();
        assert_eq!(f.state()["values"], json!([199, 199]));
    }
}

#[test]
fn to_json_cannot_rewrite_a_real_late_mutation_into_an_accepted_old_prefix() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("hostileJsonWrite", json!([]));
        assert_eq!(f.call("currentValue", json!([])), json!(199));
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.call("restoreJson", json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[199],"failures":[]}));
    }
}
#[test]
fn forged_later_drain_envelope_cannot_supply_consumed_authority() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("armForgedDrain", json!([]));
        assert_eq!(f.call("currentValue", json!([])), json!(199));
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.call("restoreDrain", json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[199],"failures":[]}));
    }
}

#[test]
fn synchronous_event_interception_cannot_rewrite_the_private_mutation_prefix() {
    for engine in engines() {
        let mut f = Fixture::start(engine);
        f.ack();
        f.call("interceptPatchWrite", json!([]));
        assert_eq!(f.call("currentValue", json!([])), json!(199));
        f.call("query", json!([]));
        assert_eq!(f.state()["values"], json!([]));
        f.render();
        f.ack();
        assert_eq!(f.state(), json!({"values":[199],"failures":[]}));
    }
}
