use container_bridge::{op, BridgeEnvelope};
use container_ir::{CapabilitySupport, ContainerManifestV1};
use container_runtime::{Session, SessionConfig};
use serde_json::json;

#[test]
fn session_dispatches_redirect_to_mini_program_through_provider() {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "redirect-test".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.capabilities.insert(
        "wx.redirectToMiniProgram".into(),
        CapabilitySupport::Partial,
    );
    let mut session = Session::new(manifest, SessionConfig::default()).expect("session creates");
    let init = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "init",
        op::APP_INIT,
        json!({}),
    ));
    assert_eq!(init.messages[0].payload["ok"], true);

    let response = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "redirect",
        op::API_CALL,
        json!({
            "name": "wx.redirectToMiniProgram",
            "appId": "wx-target",
            "path": "pages/home/index",
            "extraData": {"from": "runtime-test"},
            "envVersion": "develop"
        }),
    ));
    let result = response
        .messages
        .iter()
        .find(|message| message.op == op::API_CALL)
        .expect("provider response present");
    assert_eq!(result.payload["ok"], true);
    assert_eq!(
        result.payload["result"],
        json!({"errMsg": "redirectToMiniProgram:ok"})
    );
}
