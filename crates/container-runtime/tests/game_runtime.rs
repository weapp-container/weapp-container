//! Portable schema-v4 mini-game startup, Canvas and touch bridge coverage.
//! This is headless/QuickJS evidence and does not certify WeChat DevTools or a device.
#![cfg(feature = "quickjs-native")]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, CompilerInfo, ContainerManifestV1, Module,
    ModuleFormat, ModuleScope,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const GAME_JSON: &str = r#"{"deviceOrientation":"portrait"}"#;
const GAME_JS: &str = r#"
GameGlobal.gameLoaded = true;
const canvas = wx.createCanvas();
const context = canvas.getContext('2d');
let touches = 0;
function paint(color) {
  context.fillStyle = color;
  context.fillRect(0, 0, 2, 2);
  context.draw();
}
paint('#ff0000');
wx.onTouchStart(function(event) {
  touches += event.touches.length;
  paint('#0000ff');
});
exports.state = function() { return {value: {loaded: GameGlobal.gameLoaded, touches}}; };
"#;

fn game_manifest() -> ContainerManifestV1 {
    let mut manifest = ContainerManifestV1 {
        schema_version: 4,
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "game-runtime-test".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "game.json".into(),
            entry_module: "game.js".into(),
        },
        modules: vec![
            Module {
                id: "module:game.json".into(),
                sha256: hex_digest(GAME_JSON.as_bytes()),
                format: ModuleFormat::Json,
                scope: ModuleScope::App,
                dependencies: vec![],
            },
            Module {
                id: "module:game.js".into(),
                sha256: hex_digest(GAME_JS.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            },
        ],
        ..Default::default()
    };
    for name in [
        "wx.createCanvas",
        "wx.createCanvasContext",
        "wx.canvas.draw",
        "wx.getWindowInfo",
        "wx.onTouchStart",
        "wx.offTouchStart",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    manifest
}

fn dispatch(
    session: &mut Session,
    sequence: &mut u64,
    operation: &str,
    payload: Value,
) -> container_bridge::BridgeBatch {
    *sequence += 1;
    session.dispatch(BridgeEnvelope::request(
        "session-1",
        format!("game-{sequence}"),
        operation,
        payload,
    ))
}

#[test]
fn schema_v4_game_starts_canvas_and_dispatches_touch() {
    let mut session = Session::new(
        game_manifest(),
        SessionConfig {
            engine: EngineKind::Quickjs,
            ..Default::default()
        },
    )
    .unwrap();
    let mut sequence = 0;
    let init = dispatch(
        &mut session,
        &mut sequence,
        op::APP_INIT,
        json!({
            "modules": [
                {"id":"module:game.json", "source": GAME_JSON},
                {"id":"module:game.js", "source": GAME_JS}
            ]
        }),
    );
    assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
    let initial = session
        .canvas_snapshot("game")
        .expect("game startup paints a frame");
    assert_eq!(&initial.pixels[..4], &[255, 0, 0, 255]);

    let state = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"state"}),
    );
    assert_eq!(
        state.messages[0].payload["result"][0]["value"],
        json!({"loaded":true,"touches":0})
    );

    let touch = dispatch(
        &mut session,
        &mut sequence,
        op::GAME_TOUCH,
        json!({
            "type":"touchstart",
            "touches":[{"identifier":1,"pageX":1,"pageY":1}],
            "changedTouches":[{"identifier":1,"pageX":1,"pageY":1}]
        }),
    );
    assert_eq!(touch.messages[0].payload["ok"], true, "{touch:?}");
    assert_eq!(touch.messages[0].payload["listeners"], 1);
    let blue = session.canvas_snapshot("game").unwrap();
    assert_eq!(&blue.pixels[..4], &[0, 0, 255, 255]);

    let state = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"state"}),
    );
    assert_eq!(
        state.messages[0].payload["result"][0]["value"]["touches"],
        1
    );

    let invalid = dispatch(
        &mut session,
        &mut sequence,
        op::GAME_TOUCH,
        json!({"type":"tap", "touches":[], "changedTouches":[]}),
    );
    assert_eq!(invalid.messages[0].payload["ok"], false);
    assert_eq!(
        invalid.messages[0].payload["error"]["code"],
        "ERR_INVALID_REQUEST"
    );
}
