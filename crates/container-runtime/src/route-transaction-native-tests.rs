//! Trusted test-only failure injection into the real Session transaction action.
//! The native callback and receiver/pending cleanup are production implementations.
use super::*;
use container_ir::{hex_digest, AppInfo, Module, ModuleScope, Route, RouteKind};

const APP: &str = r#"
App({trace:[]});
wx.onBeforePageUnload(function(e){getApp().trace.push({phase:'before',id:e.routeEventId})});
wx.onAfterPageUnload(function(e){getApp().trace.push({phase:'after',id:e.routeEventId})});
exports.inspect=function(){return {value:getApp().trace}};
"#;
const PAGE: &str = "Page({});";

fn ok(session: &mut Session, operation: &str, payload: Value) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "trusted-route-test",
        operation,
        payload,
    ));
    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
    batch.messages[0].payload.clone()
}

#[test]
fn failed_action_cancels_live_unload_record_before_a_fresh_native_retry() {
    let engines = vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ];
    for engine in engines {
        let mut manifest = ContainerManifestV1 {
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.compiler.commit = "trusted-route-action-failure".into();
        let mut modules = Vec::new();
        for (name, source, scope) in [
            ("app", APP, ModuleScope::App),
            ("home", PAGE, ModuleScope::Page),
            ("detail", PAGE, ModuleScope::Page),
        ] {
            let id = format!("module:{name}.js");
            manifest.modules.push(Module {
                id: id.clone(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
            modules.push(json!({"id":id,"source":source}));
        }
        for name in ["home", "detail"] {
            manifest.routes.push(Route {
                id: format!("route:{name}"),
                path: name.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("{name}.js"),
            });
        }
        for name in [
            "getCurrentPages",
            "wx.onBeforePageUnload",
            "wx.onAfterPageUnload",
            "wx.rewriteRoute",
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
                ..Default::default()
            },
        )
        .unwrap();
        ok(&mut session, op::APP_INIT, json!({"modules":modules}));
        ok(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
        ok(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
        let source_id = session.app_service.pages().current().unwrap().id;
        let payload = json!({"path":"detail"}).as_object().unwrap().clone();
        let prepared = session
            .prepare_route_transaction("wx.redirectTo", &payload, RouteOrigin::NativeReplace)
            .unwrap();
        let failed_id = prepared.id.clone();
        let error = session
            .finish_route_transaction::<()>(prepared, |session, _| {
                // Inject only after the real native before transport registered a
                // live incarnation, before structural mutation or receiver retire.
                assert!(session.before_page_unload(source_id)?.is_some());
                Err(BridgeError::invalid(
                    "trusted fixture rejects the structural commit",
                ))
            })
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::InvalidRequest);
        assert_eq!(session.app_service.pages().current().unwrap().id, source_id);
        ok(&mut session, op::PAGE_REPLACE, json!({"path":"detail"}));
        let result = ok(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"inspect","args":[]}),
        );
        let trace = result["result"][0]["value"].as_array().unwrap();
        assert_eq!(trace.len(), 3, "{trace:?}");
        assert_eq!(trace[0], json!({"phase":"before","id":failed_id}));
        assert_eq!(trace[1]["phase"], "before");
        assert_ne!(trace[0]["id"], trace[1]["id"]);
        assert_eq!(trace[2], json!({"phase":"after","id":trace[1]["id"]}));
        assert_eq!(
            session.app_service.pages().current().unwrap().path,
            "detail"
        );
    }
}

#[test]
fn route_effective_support_separates_cleanup_grade_from_listener_pair_admission() {
    for engine in [EngineKind::Quickjs, EngineKind::V8] {
        if (engine == EngineKind::Quickjs && !cfg!(feature = "quickjs-native"))
            || (engine == EngineKind::V8 && !cfg!(feature = "v8-native"))
        {
            continue;
        }
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "route-capability-test".into();
        manifest.app = AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        };
        for name in APIS {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..Default::default()
            },
        )
        .unwrap();
        for name in APIS {
            let expected = if matches!(name, "wx.offBeforeAppRoute" | "wx.offAppRoute") {
                CapabilitySupport::Full
            } else {
                CapabilitySupport::Partial
            };
            assert_eq!(session.effective_capability(name), expected);
            assert_eq!(session.effective_capabilities()[name], expected);
        }
        session
            .config
            .capabilities
            .insert("wx.offAppRoute".into(), CapabilitySupport::Unsupported);
        for name in ["wx.onAppRoute", "wx.offAppRoute"] {
            assert_eq!(
                session.effective_capability(name),
                CapabilitySupport::Unsupported
            );
            assert_eq!(
                session.effective_capabilities()[name],
                CapabilitySupport::Unsupported
            );
        }
        assert!(!session
            .dispatch_route_notification("after", &json!({}), None)
            .unwrap());
        session
            .config
            .capabilities
            .insert("wx.onBeforeAppRoute".into(), CapabilitySupport::Unsupported);
        assert!(!session
            .dispatch_route_notification("before", &json!({}), None)
            .unwrap());
    }
}

#[test]
fn standalone_native_route_policy_defaults_revocation_and_forgery_are_enforced() {
    macro_rules! check {
        ($engine:ty) => {{
            let mut engine=<$engine>::default();
            let module=container_core::JsEngine::load_module(&mut engine,br#"
              const names=['wx.onBeforeAppRoute','wx.offBeforeAppRoute','wx.onAppRoute','wx.offAppRoute','wx.rewriteRoute'];
              const trace=[];
              const oldOn=wx.onAppRoute,oldOff=wx.offAppRoute;
              exports.inspect=()=>({caps:names.map(n=>__container_capabilities[n]),use:names.map(n=>wx.canIUse(n)),trace:trace.slice()});
              exports.register=()=>{wx.onBeforeAppRoute(()=>trace.push('before'));wx.onAppRoute(()=>trace.push('after'));};
              exports.poison=()=>{names.forEach(n=>__container_capabilities[n]='full')};
              exports.denied=()=>{
                const errors=[];
                for(const name of names.slice(0,4)){try{wx[name.slice(3)](()=>{});errors.push('allowed')}catch(e){errors.push(e.code)}}
                for(const method of [oldOn,oldOff]){try{method(()=>{});errors.push('allowed')}catch(e){errors.push(e.code)}}
                wx.rewriteRoute({url:'/forged',fail:e=>errors.push(e.code)});return {errors:errors};
              };
            "#).unwrap();
            let call=|engine:&mut $engine,name:&str|container_core::JsEngine::call(engine,CallTarget::Module{id:module.clone(),export:name.into()},vec![]).unwrap();
            let initial=call(&mut engine,"inspect");
            assert_eq!(initial[0]["caps"],json!(["partial","partial","partial","partial","partial"]));
            assert_eq!(initial[0]["use"],json!([true,true,true,true,true]));
            call(&mut engine,"register");
            let denied=APIS.iter().map(|name|(name.to_string(),"unsupported".to_string())).collect();
            engine.set_capabilities(&denied).unwrap();call(&mut engine,"poison");
            let errors=call(&mut engine,"denied");assert_eq!(errors[0]["errors"],json!(vec!["ERR_UNSUPPORTED_CAPABILITY";7]));
            assert!(!engine.dispatch_route_notification("before",&json!({}),None).unwrap());
            assert!(!engine.dispatch_route_notification("after",&json!({}),None).unwrap());
            let full=APIS.iter().map(|name|(name.to_string(),"full".to_string())).collect();
            engine.set_capabilities(&full).unwrap();
            engine.dispatch_route_notification("after",&json!({}),None).unwrap();
            let restored=call(&mut engine,"inspect");assert_eq!(restored[0]["trace"],json!([]));
            assert_eq!(restored[0]["caps"],json!(["partial","full","partial","full","partial"]));
            call(&mut engine,"register");
            let mut off=full;off.insert("wx.offAppRoute".into(),"unsupported".into());engine.set_capabilities(&off).unwrap();
            assert!(!engine.dispatch_route_notification("after",&json!({}),None).unwrap());
            let paired=call(&mut engine,"inspect");assert_eq!(paired[0]["use"][2],false);assert_eq!(paired[0]["use"][3],false);
        }};
    }
    #[cfg(feature = "quickjs-native")]
    check!(container_engine_quickjs::QuickJsEngine);
    #[cfg(feature = "v8-native")]
    check!(container_engine_v8::V8Engine);
}
