//! Portable schema-v4 mini-game events, lifecycle, Canvas and frame coverage.
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
let ended = 0;
let cancelled = 0;
let shown = 0;
let keys = [];
let keyUps = [];
let moved = 0;
let scene = 0;
let hidden = 0;
let motion = [];
let acceleration = [];
let keyboardHeight = -1;
let audioInterruptions = 0;
let memoryLevel = '';
let resize = [];
let frames = [];
let cancelledFrames = 0;
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
wx.onTouchMove(function(event) { moved = event.changedTouches[0].x; });
wx.onTouchEnd(function() { ended += 1; });
wx.onTouchCancel(function() { cancelled += 1; });
wx.onShow(function(options) { shown += 1; scene = options.scene || 0; });
wx.onHide(function() { hidden += 1; });
wx.onKeyDown(function(event) { keys.push(event.key); });
wx.onKeyUp(function(event) { keyUps.push(event.key); });
wx.onDeviceMotionChange(function(event) { motion.push([event.alpha, event.beta, event.gamma]); });
wx.onAccelerometerChange(function(event) { acceleration.push([event.x, event.y, event.z]); });
wx.onKeyboardHeightChange(function(event) { keyboardHeight = event.height; });
wx.onAudioInterruptionBegin(function() { audioInterruptions += 1; });
wx.onAudioInterruptionEnd(function() { audioInterruptions += 1; });
wx.onMemoryWarning(function(event) { memoryLevel = event.level; });
wx.onWindowResize(function(event) {
  resize.push([event.size.windowWidth, event.size.windowHeight]);
  paint('#00ff00');
});
exports.scheduleFrames = function() {
  requestAnimationFrame(function(timestamp) { frames.push(timestamp); });
  requestAnimationFrame(function(timestamp) { frames.push(timestamp); });
};
exports.scheduleCancelledFrame = function() {
  var id = requestAnimationFrame(function() { cancelledFrames += 1; });
  cancelAnimationFrame(id);
};
exports.state = function() {
  return {value: {
    loaded: GameGlobal.gameLoaded, touches, ended, cancelled, moved, shown, scene, hidden, keys, keyUps,
    motion, acceleration, keyboardHeight, audioInterruptions, memoryLevel, resize,
    frames, cancelledFrames
  }};
};
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
        "wx.onTouchMove",
        "wx.offTouchMove",
        "wx.onTouchEnd",
        "wx.offTouchEnd",
        "wx.onTouchCancel",
        "wx.offTouchCancel",
        "wx.onShow",
        "wx.offShow",
        "wx.onHide",
        "wx.offHide",
        "wx.onKeyDown",
        "wx.offKeyDown",
        "wx.onKeyUp",
        "wx.offKeyUp",
        "wx.onDeviceMotionChange",
        "wx.offDeviceMotionChange",
        "wx.onAccelerometerChange",
        "wx.offAccelerometerChange",
        "wx.onKeyboardHeightChange",
        "wx.offKeyboardHeightChange",
        "wx.onAudioInterruptionBegin",
        "wx.offAudioInterruptionBegin",
        "wx.onAudioInterruptionEnd",
        "wx.offAudioInterruptionEnd",
        "wx.onMemoryWarning",
        "wx.offMemoryWarning",
        "wx.onWindowResize",
        "wx.offWindowResize",
        "requestAnimationFrame",
        "cancelAnimationFrame",
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
        state.messages[0].payload["result"][0]["value"]["loaded"],
        true
    );
    assert_eq!(state.messages[0].payload["result"][0]["value"]["touches"], 0);

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

    let launch = dispatch(
        &mut session,
        &mut sequence,
        op::APP_LIFECYCLE,
        json!({"event":"launch", "launchOptions":{"scene":42}}),
    );
    assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
    let cancelled_frame = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"scheduleCancelledFrame"}),
    );
    assert_eq!(cancelled_frame.messages[0].payload["ok"], true);
    session.poll_timers(u64::MAX);

    let invalid_legacy_event = dispatch(
        &mut session,
        &mut sequence,
        op::GAME_TOUCH,
        json!({"type":"keydown", "key":"ArrowLeft"}),
    );
    assert_eq!(invalid_legacy_event.messages[0].payload["ok"], false);

    let key = dispatch(
        &mut session,
        &mut sequence,
        op::GAME_EVENT,
        json!({"type":"keydown","key":"ArrowLeft","code":"ArrowLeft","repeat":false}),
    );
    assert_eq!(key.messages[0].payload["ok"], true, "{key:?}");
    assert_eq!(key.messages[0].payload["listeners"], 1);
    for payload in [
        json!({"type":"keyup", "key":"ArrowLeft", "code":"ArrowLeft"}),
        json!({"type":"devicemotionchange", "alpha":1.0, "beta":2.0, "gamma":3.0, "interval":16.0}),
        json!({"type":"accelerometerchange", "x":0.1, "y":0.2, "z":0.3}),
        json!({"type":"keyboardheightchange", "height":120.0, "duration":200.0}),
        json!({"type":"audiointerruptionbegin"}),
        json!({"type":"audiointerruptionend"}),
        json!({"type":"memorywarning", "level":"critical", "usedBytes":1024}),
    ] {
        let result = dispatch(&mut session, &mut sequence, op::GAME_EVENT, payload);
        assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
    }
    let state = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"state"}),
    );
    let value = &state.messages[0].payload["result"][0]["value"];
    assert_eq!(value["shown"], 1);
    assert_eq!(value["scene"], 42);
    assert_eq!(value["keys"], json!(["ArrowLeft"]));
    assert_eq!(value["keyUps"], json!(["ArrowLeft"]));
    assert_eq!(value["motion"], json!([[1, 2, 3]]));
    assert_eq!(value["acceleration"], json!([[0.1, 0.2, 0.3]]));
    assert_eq!(value["keyboardHeight"], 120);
    assert_eq!(value["audioInterruptions"], 2);
    assert_eq!(value["memoryLevel"], "critical");

    let moved = dispatch(
        &mut session,
        &mut sequence,
        op::GAME_EVENT,
        json!({
            "type":"touchmove",
            "touches":[{"identifier":1,"x":4,"y":3,"pageX":14,"pageY":13}],
            "changedTouches":[{"identifier":1,"x":4,"y":3,"pageX":14,"pageY":13}],
            "timestampMs":16.5
        }),
    );
    assert_eq!(moved.messages[0].payload["ok"], true, "{moved:?}");
    for event_type in ["touchend", "touchcancel"] {
        let result = dispatch(
            &mut session,
            &mut sequence,
            op::GAME_EVENT,
            json!({
                "type": event_type,
                "touches": [],
                "changedTouches": [{"identifier":1,"x":4,"y":3,"pageX":14,"pageY":13}]
            }),
        );
        assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
        assert_eq!(result.messages[0].payload["listeners"], 1, "{result:?}");
    }

    let resize = session.notify_viewport_resize(8, 6).unwrap();
    assert!(!resize
        .messages
        .iter()
        .any(|message| message.payload["ok"] == false));
    let state = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"state"}),
    );
    assert_eq!(
        state.messages[0].payload["result"][0]["value"]["resize"],
        json!([[8, 6]])
    );
    let resized_canvas = session.canvas_snapshot("game").unwrap();
    assert_eq!((resized_canvas.width, resized_canvas.height), (8, 6));
    assert_eq!(&resized_canvas.pixels[..4], &[0, 255, 0, 255]);

    let hidden = dispatch(
        &mut session,
        &mut sequence,
        op::APP_LIFECYCLE,
        json!({"event":"hide"}),
    );
    assert_eq!(hidden.messages[0].payload["ok"], true, "{hidden:?}");
    let schedule = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"scheduleFrames"}),
    );
    assert_eq!(schedule.messages[0].payload["ok"], true, "{schedule:?}");
    assert!(session.poll_timers(u64::MAX).messages.is_empty());
    let shown = dispatch(
        &mut session,
        &mut sequence,
        op::APP_LIFECYCLE,
        json!({"event":"show", "options":{"scene":43}}),
    );
    assert_eq!(shown.messages[0].payload["ok"], true, "{shown:?}");
    session.poll_timers(u64::MAX);
    let state = dispatch(
        &mut session,
        &mut sequence,
        op::MODULE_CALL,
        json!({"moduleId":"module:game.js", "export":"state"}),
    );
    let value = &state.messages[0].payload["result"][0]["value"];
    assert_eq!(value["hidden"], 1);
    assert_eq!(value["shown"], 2);
    assert_eq!(value["scene"], 43);
    assert_eq!(value["frames"].as_array().unwrap().len(), 2);
    assert_eq!(value["cancelledFrames"], 0);
    assert_eq!(value["ended"], 1);
    assert_eq!(value["cancelled"], 1);
}
