//! Real AppService -> Session -> CanvasService independent surface tests.
//! This does not claim a page canvas paint consumer or SDK presentation.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const SOURCE: &str = r#"
App({});
const ctx=wx.createCanvasContext('stroke-state');let done=0;
exports.first=function(){
  ctx.setFillStyle('red');ctx.fillRect(10,10,4,4);
  ctx.lineCap='round';ctx.lineJoin='bevel';ctx.miterLimit=2;ctx.lineWidth=6;ctx.strokeStyle='red';
  ctx.beginPath();ctx.moveTo(8,30);ctx.lineTo(20,30);ctx.stroke();
  ctx.draw(false,()=>done++);
  return {value:{cap:ctx.lineCap,join:ctx.lineJoin,miter:ctx.miterLimit,offset:ctx.lineDashOffset}};
};
exports.second=function(){ctx.fillRect(20,10,4,4);ctx.draw(true,()=>done++);return {value:true};};
exports.invalid=function(){let code;try{ctx.lineJoin='not-a-join'}catch(error){code=error.code}
  return {value:{code:code,join:ctx.lineJoin}};};
exports.inspect=function(){return {value:done};};
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
    fn new(engine: EngineKind) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "canvas-stroke-real-session-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "module:app.js".into();
        manifest.modules.push(Module {
            id: "module:app.js".into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: vec![],
        });
        for name in ["wx.createCanvasContext", "wx.canvas.draw"] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let mut result = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..Default::default()
                },
            )
            .unwrap(),
            sequence: 0,
        };
        let batch = result.raw(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        result
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("canvas-state-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call(&mut self, name: &str) -> Value {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":name}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload["result"][0]["value"].clone()
    }
}
fn pixel(snapshot: &container_render_skia::RenderSnapshot, x: usize, y: usize) -> [u8; 4] {
    let index = y * snapshot.stride as usize + x * 4;
    snapshot.pixels[index..index + 4].try_into().unwrap()
}

#[test]
fn real_session_stroke_state_reaches_pixels_and_reserve_resets_batch_style() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        assert_eq!(
            f.call("first"),
            json!({"cap":"butt","join":"miter","miter":10,"offset":0})
        );
        let first = f.session.canvas_snapshot("stroke-state").unwrap();
        assert_eq!(pixel(&first, 11, 11), [255, 0, 0, 255]);
        assert_eq!(
            pixel(&first, 6, 30),
            [255, 0, 0, 255],
            "round cap reaches beyond the true endpoint"
        );
        assert_eq!(pixel(&first, 4, 30), [0, 0, 0, 0]);
        assert_eq!(f.call("inspect"), 1);
        assert_eq!(f.call("second"), true);
        let second = f.session.canvas_snapshot("stroke-state").unwrap();
        assert_eq!(
            pixel(&second, 11, 11),
            [255, 0, 0, 255],
            "reserve keeps previous pixels"
        );
        assert_eq!(
            pixel(&second, 21, 11),
            [0, 0, 0, 255],
            "fixed 5.2.3 next batch resets red fill to black"
        );
        assert_eq!(f.call("inspect"), 2);
        assert!(f.session.execution_fault().is_none());
    }
}

#[test]
fn js_rejection_and_native_batch_rejection_preserve_the_last_published_surface() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("first");
        let accepted = f.session.canvas_snapshot("stroke-state").unwrap();
        assert_eq!(
            f.call("invalid"),
            json!({"code":"ERR_INVALID_REQUEST","join":"miter"})
        );
        assert_eq!(
            f.session.canvas_snapshot("stroke-state"),
            Some(accepted.clone())
        );
        let rejected=f.raw(op::API_CALL,json!({"name":"wx.canvas.draw","canvasId":"stroke-state","reserve":true,
            "commands":[{"op":"fillRect","args":[0,0,100,100]},{"op":"setLineJoin","args":["invalid"]}]}));
        assert_eq!(rejected.messages[0].payload["ok"], false, "{rejected:?}");
        assert_eq!(f.session.canvas_snapshot("stroke-state"), Some(accepted));
    }
}
