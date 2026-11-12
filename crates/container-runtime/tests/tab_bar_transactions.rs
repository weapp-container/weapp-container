//! Runtime-owned system tab chrome through real guest engines. These local
//! producer contracts do not establish native SDK pixels or WeChat parity.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat,
    ModuleScope, Route, RouteKind, Template,
};
use container_runtime::{Session, SessionConfig, SYSTEM_TAB_BAR_APIS};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const APP: &str = r#"
App({trace:[],hooks:0});
function record(kind,value) { getApp().trace.push([kind,value.code || value.errMsg]); }
function callbacks(options) {
  options.success=function(value) { record('success',value); };
  options.fail=function(value) { record('fail',value); };
  options.complete=function(value) { record('complete',value); };
  return options;
}
function invoke(method,options) {
  getApp().trace=[];
  wx[method](options).then(function(value) { record('resolved',value); },
                          function(error) { record('rejected',error); });
  return true;
}
function hook(value) {
  return {toJSON:function() {
    getApp().hooks++;
    wx.showTabBarRedDot({index:1}).catch(function(){});
    return value;
  }};
}
exports.call=function(method,options) { return invoke(method,callbacks(options || {})); };
exports.malformed=function(method,field,kind) {
  getApp().hooks=0;
  const options=callbacks(method==='setTabBarStyle' ? {} : {index:0,text:'1'});
  const primitive=field==='index' ? 0 : field==='borderStyle' ? 'white' : field==='text' ? '1' : '#123456';
  if(kind==='object') options[field]=hook(primitive);
  if(kind==='function') { options[field]=function(){}; options[field].toJSON=hook(primitive).toJSON; }
  if(kind==='null') options[field]=null;
  if(kind==='nan') options[field]=NaN;
  if(kind==='infinity') options[field]=Infinity;
  if(kind==='fraction') options[field]=0.5;
  if(kind==='negative') options[field]=-1;
  if(kind==='accessor') Object.defineProperty(options,field,{get:function(){getApp().hooks++;return primitive;}});
  return invoke(method,options);
};
exports.callbackSnapshot=function() {
  getApp().hooks=0;
  const options=callbacks({index:0,text:'1'});
  for(const key of ['success','fail','complete']) {
    Object.defineProperty(options[key],'toJSON',{get:function(){getApp().hooks++;return hook(null).toJSON;}});
  }
  invoke('setTabBarBadge',options);
  options.success=function(){getApp().trace.push(['wrong','changed callback']);};
  options.complete=options.success;
  return true;
};
// Auxiliary transport coverage for native deadlines/cancellation, not a claim
// that the public TabBar options accept these internal bridge extensions.
exports.transport=function(token,deadline) {
  getApp().trace=[];
  const options=callbacks({index:0,text:'late'});
  if(token) options.cancelToken=token;
  if(deadline) options.deadlineNs=deadline;
  __container_api_call('wx.setTabBarBadge',options).then(
    function(value){record('resolved',value);},function(error){record('rejected',error);});
  return true;
};
exports.inspect=function(){return {trace:getApp().trace,hooks:getApp().hooks};};
exports.canUse=function(name){return wx.canIUse(name);};
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request("session-1", operation, operation, payload)
}

fn ok(session: &mut Session, operation: &str, payload: Value) -> BridgeBatch {
    let batch = session.dispatch(request(operation, payload));
    assert!(
        batch
            .messages
            .iter()
            .all(|m| m.op != op::ERROR && m.payload["ok"] != false),
        "{batch:?}"
    );
    batch
}

fn call(session: &mut Session, export: &str, args: Value) -> Value {
    ok(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":args}),
    )
    .messages[0]
        .payload["result"][0]
        .clone()
}

fn fixture(engine: EngineKind, presenter: bool, custom: bool) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "native-tab-bar-transaction-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    let mut modules = Vec::new();
    let mut blobs = BTreeMap::new();
    for (id, source, scope) in [
        ("module:app.js", APP, ModuleScope::App),
        ("module:home.js", "Page({data:{}});", ModuleScope::Page),
        ("module:other.js", "Page({data:{}});", ModuleScope::Page),
        ("module:detail.js", "Page({data:{}});", ModuleScope::Page),
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
    let config = serde_json::to_vec(&json!({"tabBar":{"custom":custom,"list":[
        {"pagePath":"home","text":"Home"},{"pagePath":"other","text":"Other"}]}}))
    .unwrap();
    let config_hash = hex_digest(&config);
    manifest.modules.push(Module {
        id: "module:app.json".into(),
        sha256: config_hash.clone(),
        format: ModuleFormat::Json,
        scope: ModuleScope::App,
        dependencies: vec![],
    });
    blobs.insert(format!("sha256:{config_hash}"), config);
    for path in ["home", "other", "detail"] {
        manifest.routes.push(Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: if path == "detail" {
                RouteKind::Page
            } else {
                RouteKind::Tab
            },
            config: None,
            entry_module: format!("{path}.js"),
        });
        let bytes = parse_wxml("<view/>").unwrap().canonical_json().unwrap();
        let pointer = format!("sha256:{}", hex_digest(&bytes));
        manifest.templates.push(Template {
            id: format!("template:{path}.wxml"),
            wxml_ast: pointer.clone(),
            bindings: vec![],
            wxs_modules: BTreeMap::new(),
        });
        blobs.insert(pointer, bytes);
    }
    for name in SYSTEM_TAB_BAR_APIS.into_iter().chain([
        "wx.showTabBar",
        "wx.hideTabBar",
        "wx.setTabBarItem",
    ]) {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            capabilities: if presenter {
                SYSTEM_TAB_BAR_APIS
                    .into_iter()
                    .map(|name| (name.into(), CapabilitySupport::Full))
                    .collect()
            } else {
                BTreeMap::new()
            },
            ..Default::default()
        },
    )
    .unwrap();
    ok(
        &mut session,
        op::APP_INIT,
        json!({"modules":modules,"blobs":blobs}),
    );
    ok(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    ok(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
    session
}

fn malformed_inputs(engine: EngineKind) {
    let mut session = fixture(engine, true, false);
    for (method, field) in [
        ("setTabBarBadge", "index"),
        ("setTabBarBadge", "text"),
        ("removeTabBarBadge", "index"),
        ("showTabBarRedDot", "index"),
        ("hideTabBarRedDot", "index"),
        ("setTabBarStyle", "color"),
        ("setTabBarStyle", "selectedColor"),
        ("setTabBarStyle", "backgroundColor"),
        ("setTabBarStyle", "borderStyle"),
    ] {
        for kind in ["object", "function", "null", "accessor"] {
            let before = session.page_chrome().unwrap();
            call(&mut session, "malformed", json!([method, field, kind]));
            assert_eq!(
                session.page_chrome().unwrap(),
                before,
                "{engine:?} {method}.{field} {kind}"
            );
            assert_eq!(
                call(&mut session, "inspect", json!([])),
                json!({
                    "trace":[["fail","ERR_INVALID_REQUEST"],["complete","ERR_INVALID_REQUEST"],["rejected","ERR_INVALID_REQUEST"]],"hooks":0
                }),
                "{engine:?} {method}.{field} {kind}"
            );
        }
    }
    for kind in ["nan", "infinity", "fraction", "negative"] {
        let before = session.page_chrome().unwrap();
        call(
            &mut session,
            "malformed",
            json!(["setTabBarBadge", "index", kind]),
        );
        assert_eq!(session.page_chrome().unwrap(), before, "{engine:?} {kind}");
        assert_eq!(
            call(&mut session, "inspect", json!([]))["trace"][2],
            json!(["rejected", "ERR_INVALID_REQUEST"])
        );
    }
}

#[cfg(feature = "quickjs-native")]
#[test]
fn native_tab_bar_rejects_malformed_quickjs() {
    malformed_inputs(EngineKind::Quickjs);
}

#[cfg(feature = "v8-native")]
#[test]
fn native_tab_bar_rejects_malformed_v8() {
    malformed_inputs(EngineKind::V8);
}

#[test]
fn native_tab_bar_callback_refs_never_enter_wire_serialization() {
    for engine in engines() {
        let mut session = fixture(engine, true, false);
        call(&mut session, "callbackSnapshot", json!([]));
        assert_eq!(
            call(&mut session, "inspect", json!([])),
            json!({
                "trace":[["success","setTabBarBadge:ok"],["complete","setTabBarBadge:ok"],["resolved","setTabBarBadge:ok"]],"hooks":0
            }),
            "{engine:?}"
        );
        let chrome = session.page_chrome().unwrap().unwrap();
        assert_eq!(chrome.tab_bar.list[0].badge_text.as_deref(), Some("1"));
        assert!(
            !chrome.tab_bar.list[1].red_dot,
            "callback toJSON must not enqueue reentrant mutation"
        );
    }
}

#[test]
fn native_tab_bar_public_success_and_atomic_validation_settle_callbacks_and_promises() {
    for engine in engines() {
        let mut session = fixture(engine, true, false);
        for (method, options) in [
            ("setTabBarBadge", json!({"index":0,"text":"😀😀"})),
            ("removeTabBarBadge", json!({"index":0})),
            ("showTabBarRedDot", json!({"index":1})),
            ("hideTabBarRedDot", json!({"index":1})),
            (
                "setTabBarStyle",
                json!({"color":"#abc","selectedColor":"#112233","backgroundColor":"#aabbcc","borderStyle":"white"}),
            ),
        ] {
            call(&mut session, "call", json!([method, options]));
            let message = format!("{method}:ok");
            assert_eq!(
                call(&mut session, "inspect", json!([]))["trace"],
                json!([
                    ["success", message],
                    ["complete", message],
                    ["resolved", message]
                ]),
                "{engine:?} {method}"
            );
            let chrome = session.page_chrome().unwrap().unwrap();
            match method {
                "setTabBarBadge" => {
                    assert_eq!(chrome.tab_bar.list[0].badge_text.as_deref(), Some("😀😀"))
                }
                "removeTabBarBadge" => assert_eq!(chrome.tab_bar.list[0].badge_text, None),
                "showTabBarRedDot" => assert!(chrome.tab_bar.list[1].red_dot),
                "hideTabBarRedDot" => assert!(!chrome.tab_bar.list[1].red_dot),
                _ => {
                    assert_eq!(chrome.tab_bar.color, "#aabbcc");
                    assert_eq!(chrome.tab_bar.selected_color, "#112233");
                    assert_eq!(chrome.tab_bar.background_color, "#aabbcc");
                    assert_eq!(chrome.tab_bar.border_style, "white");
                }
            }
        }
        let before = session.page_chrome().unwrap();
        call(
            &mut session,
            "call",
            json!(["setTabBarStyle",{"color":"#ffffff","selectedColor":"red"}]),
        );
        assert_eq!(
            session.page_chrome().unwrap(),
            before,
            "partial style must not commit on native rejection"
        );
        assert_eq!(
            call(&mut session, "inspect", json!([]))["trace"],
            json!([
                ["fail", "ERR_INVALID_REQUEST"],
                ["complete", "ERR_INVALID_REQUEST"],
                ["rejected", "ERR_INVALID_REQUEST"]
            ])
        );
    }
}

#[test]
fn native_tab_bar_admission_custom_scope_and_unfinished_contracts_fail_without_mutation() {
    for engine in engines() {
        for (presenter, custom) in [(false, false), (false, true), (true, true)] {
            let mut session = fixture(engine, presenter, custom);
            for name in SYSTEM_TAB_BAR_APIS {
                assert_eq!(call(&mut session, "canUse", json!([name])), false);
                assert_eq!(
                    ok(
                        &mut session,
                        op::API_CALL,
                        json!({"name":"wx.canIUse","capability":name})
                    )
                    .messages[0]
                        .payload["support"],
                    "unsupported",
                    "{engine:?} presenter={presenter} custom={custom} {name}"
                );
            }
            for method in [
                "setTabBarBadge",
                "removeTabBarBadge",
                "showTabBarRedDot",
                "hideTabBarRedDot",
                "setTabBarStyle",
                "showTabBar",
                "hideTabBar",
                "setTabBarItem",
            ] {
                let before = session.page_chrome().unwrap();
                call(&mut session, "call", json!([method,{"index":0,"text":"1"}]));
                assert_eq!(
                    session.page_chrome().unwrap(),
                    before,
                    "{engine:?} {method}"
                );
                assert_eq!(
                    call(&mut session, "inspect", json!([]))["trace"],
                    json!([
                        ["fail", "ERR_UNSUPPORTED_CAPABILITY"],
                        ["complete", "ERR_UNSUPPORTED_CAPABILITY"],
                        ["rejected", "ERR_UNSUPPORTED_CAPABILITY"]
                    ]),
                    "{engine:?} {method}"
                );
            }
        }
        let mut session = fixture(engine, true, false);
        for name in SYSTEM_TAB_BAR_APIS {
            assert_eq!(call(&mut session, "canUse", json!([name])), true);
            assert_eq!(
                ok(
                    &mut session,
                    op::API_CALL,
                    json!({"name":"wx.canIUse","capability":name})
                )
                .messages[0]
                    .payload["support"],
                "partial"
            );
        }
        for name in ["wx.showTabBar", "wx.hideTabBar", "wx.setTabBarItem"] {
            assert_eq!(
                ok(
                    &mut session,
                    op::API_CALL,
                    json!({"name":"wx.canIUse","capability":name})
                )
                .messages[0]
                    .payload["support"],
                "unsupported"
            );
        }
    }
}

#[test]
fn native_tab_bar_expired_and_cancelled_transport_cannot_commit_and_settle_once() {
    for engine in engines() {
        let mut session = fixture(engine, true, false);
        ok(
            &mut session,
            op::CANCEL,
            json!({"cancelToken":"tab-cancelled"}),
        );
        for (token, deadline, code) in [
            ("tab-cancelled", 0, "ERR_CANCELLED"),
            ("", 1, "ERR_TIMEOUT"),
        ] {
            let before = session.page_chrome().unwrap();
            call(&mut session, "transport", json!([token, deadline]));
            assert_eq!(session.page_chrome().unwrap(), before);
            assert_eq!(
                call(&mut session, "inspect", json!([]))["trace"],
                json!([["fail", code], ["complete", code], ["rejected", code]]),
                "{engine:?}"
            );
        }
        let before = session.page_chrome().unwrap();
        for cancelled in [true, false] {
            let mut envelope = request(
                op::API_CALL,
                json!({"name":"wx.setTabBarBadge","index":0,"text":"late"}),
            );
            if cancelled {
                envelope.cancel_token = Some("tab-cancelled".into());
            } else {
                envelope.deadline_ns = Some(1);
            }
            let batch = session.dispatch(envelope);
            assert_eq!(
                batch.messages[0].payload["error"]["code"],
                if cancelled {
                    "ERR_CANCELLED"
                } else {
                    "ERR_TIMEOUT"
                }
            );
            assert_eq!(session.page_chrome().unwrap(), before);
        }
    }
}

#[test]
fn native_tab_bar_is_app_scoped_across_pages_hide_show_and_destroyed_sessions() {
    for engine in engines() {
        let mut session = fixture(engine, true, false);
        call(
            &mut session,
            "call",
            json!(["setTabBarBadge",{"index":0,"text":"1"}]),
        );
        for path in ["detail", "other"] {
            ok(&mut session, op::PAGE_PUSH, json!({"path":path}));
            let chrome = session.page_chrome().unwrap().unwrap();
            assert_eq!(chrome.tab_bar.visible, path == "other");
            assert_eq!(chrome.tab_bar.list[0].badge_text.as_deref(), Some("1"));
            call(
                &mut session,
                "call",
                json!(["showTabBarRedDot",{"index":1}]),
            );
        }
        ok(&mut session, op::APP_LIFECYCLE, json!({"event":"hide"}));
        ok(&mut session, op::APP_LIFECYCLE, json!({"event":"show"}));
        assert!(session.page_chrome().unwrap().unwrap().tab_bar.list[1].red_dot);
        ok(&mut session, op::APP_LIFECYCLE, json!({"event":"unload"}));
        if let Some(chrome) = session.page_chrome().unwrap() {
            assert!(chrome
                .tab_bar
                .list
                .iter()
                .all(|item| item.badge_text.is_none() && !item.red_dot));
        }
        let rejected = session.dispatch(request(
            op::API_CALL,
            json!({"name":"wx.setTabBarBadge","index":0,"text":"late"}),
        ));
        assert_eq!(
            rejected.messages[0].payload["error"]["code"],
            "ERR_CANCELLED"
        );
        let next = fixture(engine, true, false);
        assert!(next
            .page_chrome()
            .unwrap()
            .unwrap()
            .tab_bar
            .list
            .iter()
            .all(|item| item.badge_text.is_none() && !item.red_dot));
    }
}
