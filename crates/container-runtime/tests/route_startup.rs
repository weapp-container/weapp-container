//! Runnable target admission for startup and lazy subpackage navigation. These
//! two-engine contracts are local evidence, not an official DevTools receipt.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
    RouteKind,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

const ID: &str = "route-startup";
const APP: &str = r#"
App({trace:[]});
wx.onBeforeAppRoute(event=>getApp().trace.push('before:'+event.openType+':'+event.path));
wx.onAppRoute(event=>getApp().trace.push('after:'+event.openType+':'+event.path));
exports.trace=()=>({trace:getApp().trace});
exports.clear=()=>{getApp().trace=[];};
"#;
const HOME: &str = "Page({data:{owner:'home'},onLoad(){getApp().trace.push('home-load');},onUnload(){getApp().trace.push('home-unload');},onHide(){getApp().trace.push('home-hide');}});";
const LAZY: &str =
    "Page({data:{owner:'subpackage'},onLoad(){getApp().trace.push('subpackage-load');}});";

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(ID, "request", operation, payload));
    batch.messages[0].payload.clone()
}

fn call(session: &mut Session, export: &str) -> Value {
    let response = dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":export,"args":[]}),
    );
    assert_eq!(response["ok"], true, "{response}");
    let value = response["result"][0].clone();
    if export == "trace" {
        value["trace"].clone()
    } else {
        value
    }
}

fn fixture(engine: EngineKind, home_loaded: bool) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "route-startup-contract".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    for (path, source, scope) in [
        ("app.js", APP, ModuleScope::App),
        ("home.js", HOME, ModuleScope::Page),
        ("package/page.js", LAZY, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: format!("module:{path}"),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    for path in ["home", "package/page"] {
        manifest.routes.push(Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: format!("{path}.js"),
        });
    }
    for name in [
        "wx.navigateTo",
        "wx.redirectTo",
        "wx.reLaunch",
        "wx.onBeforeAppRoute",
        "wx.offBeforeAppRoute",
        "wx.onAppRoute",
        "wx.offAppRoute",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            engine,
            session_id: ID.into(),
            ..Default::default()
        },
    )
    .unwrap();
    let mut modules = vec![json!({"id":"module:app.js","source":APP})];
    if home_loaded {
        modules.push(json!({"id":"module:home.js","source":HOME}));
    }
    let response = dispatch(&mut session, op::APP_INIT, json!({"modules":modules}));
    assert_eq!(response["ok"], true, "{response}");
    session
}

#[test]
fn initial_route_does_not_publish_an_unregistered_page() {
    for engine in engines() {
        let mut session = fixture(engine, false);
        let response = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        assert_eq!(response["ok"], false, "{engine:?}: {response}");
        assert_eq!(response["error"]["code"], "ERR_MODULE_LOAD");
        assert!(session.app_service().pages().is_empty());
        assert_eq!(
            call(&mut session, "trace"),
            json!(["before:appLaunch:home"])
        );
        let loaded = dispatch(
            &mut session,
            op::MODULE_LOAD,
            json!({"modules":[{"id":"module:home.js","source":HOME}]}),
        );
        assert_eq!(loaded["ok"], true, "{loaded}");
        let response = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        assert_eq!(response["ok"], true, "{response}");
        assert_eq!(
            session.app_service().pages().current().unwrap().data["owner"],
            "home"
        );
        assert_eq!(
            call(&mut session, "trace"),
            json!([
                "before:appLaunch:home",
                "before:appLaunch:home",
                "home-load",
                "after:appLaunch:home"
            ])
        );
    }
}

#[test]
fn unloaded_subpackage_target_never_hides_unloads_or_replaces_the_live_page() {
    for engine in engines() {
        for name in ["wx.navigateTo", "wx.redirectTo", "wx.reLaunch"] {
            let mut session = fixture(engine, true);
            let pushed = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
            assert_eq!(pushed["ok"], true, "{pushed}");
            call(&mut session, "clear");
            let before = session.app_service().pages().current().unwrap().clone();
            let response = dispatch(
                &mut session,
                op::API_CALL,
                json!({"name":name,"url":"/package/page"}),
            );
            assert_eq!(response["ok"], false, "{engine:?}/{name}: {response}");
            assert_eq!(response["error"]["code"], "ERR_MODULE_LOAD");
            assert_eq!(session.app_service().pages().current(), Some(&before));
            assert_eq!(session.app_service().pages().len(), 1);
            assert_eq!(
                call(&mut session, "trace"),
                json!([format!(
                    "before:{}:package/page",
                    name.trim_start_matches("wx.")
                )])
            );
            let loaded = dispatch(
                &mut session,
                op::MODULE_LOAD,
                json!({"modules":[{"id":"module:package/page.js","source":LAZY}]}),
            );
            assert_eq!(loaded["ok"], true, "{loaded}");
            call(&mut session, "clear");
            let accepted = dispatch(
                &mut session,
                op::API_CALL,
                json!({"name":name,"url":"/package/page"}),
            );
            assert_eq!(accepted["ok"], true, "{accepted}");
            assert_eq!(
                session.app_service().pages().current().unwrap().data["owner"],
                "subpackage"
            );
            let trace = call(&mut session, "trace");
            let values = trace.as_array().unwrap();
            assert_eq!(
                values[1],
                if name == "wx.navigateTo" {
                    "home-hide"
                } else {
                    "home-unload"
                }
            );
            assert_eq!(values[2], "subpackage-load");
            assert_eq!(
                values[3],
                format!("after:{}:package/page", name.trim_start_matches("wx."))
            );
        }
    }
}

#[test]
fn logical_route_placeholders_remain_compatible_with_helpers_and_legacy_bundles() {
    for engine in engines() {
        for source in [
            "Page({data:{owner:'legacy-bundle'}});",
            "App({}); Page({data:{owner:'legacy-bundle'}});",
        ] {
            let mut manifest = ContainerManifestV1::default();
            manifest.compiler.commit = "route-startup-contract".into();
            manifest.app.app_json = "app.json".into();
            manifest.app.entry_module = "app.js".into();
            manifest.modules.push(Module {
                id: "module:app.js".into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            });
            manifest.modules.push(Module {
                id: "module:helper.js".into(),
                sha256: hex_digest(b"exports.value=42;"),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            });
            manifest.routes.push(Route {
                id: "route:home".into(),
                path: "home".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "home.js".into(),
            });
            manifest.refresh_integrity().unwrap();
            let mut session = Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: ID.into(),
                    ..Default::default()
                },
            )
            .unwrap();
            let init = dispatch(
                &mut session,
                op::APP_INIT,
                json!({"modules":[{"id":"module:helper.js","source":"exports.value=42;"},{"id":"module:app.js","source":source}]}),
            );
            assert_eq!(init["ok"], true, "{engine:?}: {init}");
            let pushed = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
            assert_eq!(pushed["ok"], true, "{engine:?}: {pushed}");
            assert_eq!(
                session.app_service().pages().current().unwrap().data["owner"],
                "legacy-bundle"
            );
        }
    }
}

#[test]
fn declared_page_root_requires_registration_even_before_any_module_is_loaded() {
    for engine in engines() {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "route-startup-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.push(Module {
            id: "module:home.js".into(),
            sha256: hex_digest(HOME.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::Page,
            dependencies: vec![],
        });
        manifest.routes.push(Route {
            id: "route:home".into(),
            path: "home".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "module:home.js".into(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                session_id: ID.into(),
                ..Default::default()
            },
        )
        .unwrap();
        let init = dispatch(&mut session, op::APP_INIT, json!({}));
        assert_eq!(init["ok"], true, "{init}");
        let pushed = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        assert_eq!(pushed["ok"], false, "{engine:?}: {pushed}");
        assert_eq!(pushed["error"]["code"], "ERR_MODULE_LOAD");
        assert!(session.app_service().pages().is_empty());
    }
}

#[test]
fn native_protocol_pages_may_share_an_uninstalled_app_entry() {
    for engine in engines() {
        for reference in ["app.js", "module:app.js"] {
            let mut manifest = ContainerManifestV1::default();
            manifest.compiler.commit = "route-startup-contract".into();
            manifest.app.app_json = "app.json".into();
            manifest.app.entry_module = "app.js".into();
            manifest.modules.push(Module {
                id: "module:app.js".into(),
                sha256: hex_digest(b"App({});"),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            });
            manifest.routes.push(Route {
                id: "route:home".into(),
                path: "home".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: reference.into(),
            });
            manifest.refresh_integrity().unwrap();
            let mut session = Session::new(
                manifest,
                SessionConfig {
                    engine,
                    session_id: ID.into(),
                    ..Default::default()
                },
            )
            .unwrap();
            let init = dispatch(&mut session, op::APP_INIT, json!({}));
            assert_eq!(init["ok"], true, "{engine:?}: {init}");
            let pushed = dispatch(
                &mut session,
                op::PAGE_PUSH,
                json!({"path":"home","data":{"owner":"native-protocol"}}),
            );
            assert_eq!(pushed["ok"], true, "{engine:?}/{reference}: {pushed}");
            assert_eq!(
                session.app_service().pages().current().unwrap().data["owner"],
                "native-protocol"
            );
        }
    }
}

#[test]
fn an_installed_runtime_requires_the_shared_app_entries_own_page_definition() {
    const SHARED: &str = "App({trace:[]}); Page({data:{owner:'shared-app-page'},onLoad(){getApp().trace.push('shared-load');}}); exports.trace=()=>({trace:getApp().trace});";
    const HELPER: &str = "exports.value=42;";
    for engine in engines() {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "route-startup-contract".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        for (path, source) in [("app.js", SHARED), ("helper.js", HELPER)] {
            manifest.modules.push(Module {
                id: format!("module:{path}"),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            });
        }
        manifest.routes.push(Route {
            id: "route:home".into(),
            path: "home".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: "module:app.js".into(),
        });
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                session_id: ID.into(),
                ..Default::default()
            },
        )
        .unwrap();
        let init = dispatch(
            &mut session,
            op::APP_INIT,
            json!({"modules":[{"id":"module:helper.js","source":HELPER}]}),
        );
        assert_eq!(init["ok"], true, "{engine:?}: {init}");
        let premature = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        assert_eq!(premature["ok"], false, "{engine:?}: {premature}");
        assert_eq!(premature["error"]["code"], "ERR_MODULE_LOAD");
        assert!(session.app_service().pages().is_empty());
        let loaded = dispatch(
            &mut session,
            op::MODULE_LOAD,
            json!({"modules":[{"id":"module:app.js","source":SHARED}]}),
        );
        assert_eq!(loaded["ok"], true, "{engine:?}: {loaded}");
        let pushed = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        assert_eq!(pushed["ok"], true, "{engine:?}: {pushed}");
        assert_eq!(
            session.app_service().pages().current().unwrap().data["owner"],
            "shared-app-page"
        );
        assert_eq!(call(&mut session, "trace"), json!(["shared-load"]));
    }
}
