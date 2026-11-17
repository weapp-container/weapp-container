#![cfg(feature = "quickjs-native")]

use container_core::{CallTarget, JsEngine};
use container_engine_quickjs::QuickJsEngine;
use serde_json::json;

#[test]
fn account_info_sync_is_capability_gated_and_returns_a_fresh_snapshot() {
    let mut engine = QuickJsEngine::default();
    engine
        .set_capabilities(
            &[("wx.getAccountInfoSync".to_owned(), "full".to_owned())]
                .into_iter()
                .collect(),
        )
        .expect("account capability installs");
    JsEngine::call(
        &mut engine,
        CallTarget::Global {
            name: "__container_set_sync_api_values".into(),
        },
        vec![
            json!({
                "wx.getAccountInfoSync": {
                    "miniProgram": {
                        "appId": "wxa-account-fixture",
                        "envVersion": "trial",
                        "version": "1.2.3"
                    },
                    "plugin": {}
                }
            }),
            json!({}),
        ],
    )
    .expect("sync account snapshot installs");
    let module = JsEngine::load_module(
        &mut engine,
        br#"exports.run = function() {
          const first = wx.getAccountInfoSync();
          first.miniProgram.appId = 'mutated';
          const second = wx.getAccountInfoSync();
          return {
            canUse: wx.canIUse('getAccountInfoSync'),
            first: first.miniProgram,
            second: second.miniProgram,
            plugin: second.plugin
          };
        };"#,
    )
    .expect("account facade evaluates");
    let result = JsEngine::call(
        &mut engine,
        CallTarget::Module {
            id: module,
            export: "run".into(),
        },
        Vec::new(),
    )
    .expect("account facade calls");
    assert_eq!(result[0]["canUse"], true);
    assert_eq!(result[0]["first"]["appId"], "mutated");
    assert_eq!(result[0]["second"]["appId"], "wxa-account-fixture");
    assert_eq!(result[0]["second"]["envVersion"], "trial");
    assert_eq!(result[0]["plugin"], json!({}));
}
