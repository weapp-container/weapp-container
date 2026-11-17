//! Native engine module semantics. These are source/runtime conformance tests,
//! not an official DevTools or device acceptance claim.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn fixture(
    engine: EngineKind,
    sources: &[(&str, ModuleFormat, &str, &[&str])],
) -> (Session, Value) {
    fixture_with_routes(engine, sources, &[])
}

fn fixture_with_routes(
    engine: EngineKind,
    sources: &[(&str, ModuleFormat, &str, &[&str])],
    routes: &[&str],
) -> (Session, Value) {
    fixture_with_route_capabilities(engine, sources, routes, &[])
}

fn fixture_with_route_capabilities(
    engine: EngineKind,
    sources: &[(&str, ModuleFormat, &str, &[&str])],
    routes: &[&str],
    capabilities: &[&str],
) -> (Session, Value) {
    let mut manifest = ContainerManifestV1::default();
    for name in capabilities {
        manifest
            .capabilities
            .insert((*name).into(), container_ir::CapabilitySupport::Partial);
    }
    manifest.compiler.commit = "module-loading-fixture".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.routes = routes
        .iter()
        .map(|path| Route {
            id: format!("route:{path}"),
            path: (*path).into(),
            kind: RouteKind::Page,
            entry_module: format!("{path}.js"),
            config: None,
        })
        .collect();
    manifest.modules = sources
        .iter()
        .map(|(path, format, source, deps)| Module {
            id: format!("module:{path}"),
            sha256: hex_digest(source.as_bytes()),
            format: *format,
            scope: ModuleScope::App,
            dependencies: deps.iter().map(|path| format!("module:{path}")).collect(),
        })
        .collect();
    manifest.refresh_integrity().unwrap();
    let session = Session::new(
        manifest,
        SessionConfig {
            engine,
            session_id: "module-loading".into(),
            ..SessionConfig::default()
        },
    )
    .unwrap();
    let modules = sources
        .iter()
        .map(|(path, _, source, _)| json!({"id": format!("module:{path}"), "source": source}))
        .collect::<Vec<_>>();
    (session, json!({"modules": modules}))
}

fn dispatch(session: &mut Session, operation: &str, payload: Value) -> Value {
    let request = BridgeEnvelope::request("module-loading", "request", operation, payload);
    session
        .dispatch(request)
        .messages
        .into_iter()
        .find(|message| message.kind == container_bridge::EnvelopeKind::Response)
        .expect("response envelope")
        .payload
}

fn call(session: &mut Session, path: &str, export: &str) -> Value {
    let response = dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId": format!("module:{path}"), "export": export, "args": []}),
    );
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

#[test]
fn route_entry_component_registers_a_page_with_fresh_page_data_and_methods() {
    for engine in engines() {
        let (mut session, input) = fixture_with_route_capabilities(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
              App({});
              exports.inspect=()=>({
                definitions:__container_pages.length,children:__container_components.length,
                route:__container_current_page_instances[0].route,data:__container_current_page_instances[0].data,
                instance:__container_current_page_instances[0].__container_instance_id
              });
            "#,
                    &[],
                ),
                (
                    "pages/start/index.js",
                    ModuleFormat::Commonjs,
                    r#"
              Component({data:{count:41},methods:{onLoad(){this.setData({count:this.data.count+1});}}});
            "#,
                    &[],
                ),
            ],
            &["pages/start/index"],
            &["wx.reLaunch"],
        );
        assert_eq!(
            dispatch(&mut session, op::APP_INIT, input)["ok"],
            true,
            "{engine:?}"
        );
        let first = dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"pages/start/index"}),
        );
        assert_eq!(first["ok"], true, "{engine:?}: {first}");
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"count":42})
        );
        let observed = call(&mut session, "app.js", "inspect");
        assert_eq!(observed[0]["definitions"], 1);
        assert_eq!(observed[0]["children"], 0);
        assert_eq!(observed[0]["route"], "pages/start/index");
        let first_id = observed[0]["instance"].clone();
        let again = dispatch(
            &mut session,
            op::API_CALL,
            json!({"name":"wx.reLaunch","url":"/pages/start/index"}),
        );
        assert_eq!(again["ok"], true, "{engine:?}: {again}");
        let observed = call(&mut session, "app.js", "inspect");
        assert_ne!(observed[0]["instance"], first_id);
        assert_eq!(observed[0]["data"], json!({"count":42}));
    }
}

#[test]
fn component_page_lifecycles_follow_the_observed_official_order_and_receiver_identity() {
    // Official diagnostic, rather than a new acceptance case:
    // artifacts/conformance-probes/component-page-v2/report.json
    // sha256 7b8f6400dcd63248a5223e0352b31ffb5cb3c70054ade3e9be4ac7cddcab67a9.
    for engine in engines() {
        let (mut session, input) = fixture_with_route_capabilities(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"App({});globalThis.events=[];globalThis.receivers=[];
                      globalThis.record=function(name,receiver,args){
                        let id=receivers.indexOf(receiver);if(id<0){id=receivers.length;receivers.push(receiver);}
                        events.push({event:name,id:id+1,route:receiver.route||null,is:receiver.is||null,count:receiver.data.count,args:Array.from(args||[])});
                      };
                      exports.inspect=()=>({events:events});
                      exports.increment=()=>receivers[0].increment();"#,
                    &[],
                ),
                (
                    "pages/component.js",
                    ModuleFormat::Commonjs,
                    r#"Component({data:{count:0},
                        created(){record('top.created',this,arguments);},
                        attached(){record('top.attached',this,arguments);},
                        ready(){record('top.ready',this,arguments);},
                        detached(){record('top.detached',this,arguments);},
                        onLoad(){record('top.onLoad',this,arguments);},
                        lifetimes:{
                          created(){record('lifetimes.created',this,arguments);},
                          attached(){record('lifetimes.attached',this,arguments);},
                          ready(){record('lifetimes.ready',this,arguments);},
                          detached(){record('lifetimes.detached',this,arguments);}
                        },pageLifetimes:{
                          show(){record('pageLifetimes.show',this,arguments);},
                          hide(){record('pageLifetimes.hide',this,arguments);}
                        },methods:{
                          onLoad(){record('methods.onLoad',this,arguments);},
                          onShow(){record('methods.onShow',this,arguments);},
                          onHide(){record('methods.onHide',this,arguments);},
                          onReady(){record('methods.onReady',this,arguments);},
                          onUnload(){record('methods.onUnload',this,arguments);},
                          increment(){this.setData({count:this.data.count+1});return this.data.count;}
                        }});"#,
                    &[],
                ),
                (
                    "pages/plain.js",
                    ModuleFormat::Commonjs,
                    r#"Page({data:{count:0},
                      onLoad(){record('Page.onLoad',this,arguments);},
                      onShow(){record('Page.onShow',this,arguments);},
                      onReady(){record('Page.onReady',this,arguments);},
                      onUnload(){record('Page.onUnload',this,arguments);}});"#,
                    &[],
                ),
            ],
            &["pages/component", "pages/plain"],
            &["wx.reLaunch"],
        );
        assert_eq!(dispatch(&mut session, op::APP_INIT, input)["ok"], true);
        assert_eq!(
            dispatch(
                &mut session,
                op::PAGE_PUSH,
                json!({"path":"pages/component"})
            )["ok"],
            true
        );
        assert_eq!(call(&mut session, "app.js", "increment"), json!([1]));
        assert_eq!(
            dispatch(
                &mut session,
                op::PAGE_PUSH,
                json!({"path":"pages/plain","query":{"from":"component"}})
            )["ok"],
            true
        );
        assert_eq!(dispatch(&mut session, op::PAGE_POP, json!({}))["ok"], true);
        assert_eq!(
            dispatch(
                &mut session,
                op::API_CALL,
                json!({"name":"wx.reLaunch","url":"/pages/component?fresh=second"})
            )["ok"],
            true
        );
        assert_eq!(
            dispatch(
                &mut session,
                op::API_CALL,
                json!({"name":"wx.reLaunch","url":"/pages/plain?final=1"})
            )["ok"],
            true
        );
        let observed = call(&mut session, "app.js", "inspect");
        let events = observed[0]["events"].as_array().unwrap();
        let expected = [
            ("lifetimes.created", 1, 0),
            ("lifetimes.attached", 1, 0),
            ("methods.onLoad", 1, 0),
            ("pageLifetimes.show", 1, 0),
            ("methods.onShow", 1, 0),
            ("lifetimes.ready", 1, 0),
            ("methods.onReady", 1, 0),
            ("pageLifetimes.hide", 1, 1),
            ("methods.onHide", 1, 1),
            ("Page.onLoad", 2, 0),
            ("Page.onShow", 2, 0),
            ("Page.onReady", 2, 0),
            ("Page.onUnload", 2, 0),
            ("pageLifetimes.show", 1, 1),
            ("methods.onShow", 1, 1),
            ("methods.onUnload", 1, 1),
            ("lifetimes.detached", 1, 1),
            ("lifetimes.created", 3, 0),
            ("lifetimes.attached", 3, 0),
            ("methods.onLoad", 3, 0),
            ("pageLifetimes.show", 3, 0),
            ("methods.onShow", 3, 0),
            ("lifetimes.ready", 3, 0),
            ("methods.onReady", 3, 0),
            ("methods.onUnload", 3, 0),
            ("lifetimes.detached", 3, 0),
            ("Page.onLoad", 4, 0),
            ("Page.onShow", 4, 0),
            ("Page.onReady", 4, 0),
        ];
        assert_eq!(events.len(), expected.len(), "{engine:?}: {events:?}");
        for (index, (event, id, count)) in expected.into_iter().enumerate() {
            assert_eq!(events[index]["event"], event, "{engine:?}: event {index}");
            assert_eq!(events[index]["id"], id, "{engine:?}: event {index}");
            assert_eq!(events[index]["count"], count, "{engine:?}: event {index}");
            if event.starts_with("Page.") {
                continue;
            }
            assert_eq!(
                events[index]["is"], "pages/component",
                "{engine:?}: event {index}"
            );
            assert_eq!(
                events[index]["route"],
                if event == "lifetimes.created" {
                    Value::Null
                } else {
                    json!("pages/component")
                }
            );
        }
        assert_eq!(events[2]["args"], json!([{}]));
        assert_eq!(events[19]["args"], json!([{"fresh":"second"}]));
    }
}

#[test]
fn component_page_async_set_data_keeps_each_concrete_page_receiver() {
    for engine in engines() {
        let (mut session, input) = fixture_with_routes(
            engine,
            &[
                ("app.js", ModuleFormat::Commonjs, "App({});globalThis.receivers=[];exports.inspect=()=>({receivers:receivers.map(page=>({id:page.__container_instance_id,data:page.data}))});", &[]),
                ("pages/start.js", ModuleFormat::Commonjs,
                 r#"Component({data:{count:0},methods:{onLoad(){
                    receivers.push(this);const owner=this;
                    this.setData({count:receivers.length},()=>owner.setData({callback:owner.data.count}));
                    Promise.resolve().then(()=>owner.setData({promise:owner.data.count}));
                 }}});"#, &[]),
            ],
            &["pages/start"],
        );
        assert_eq!(dispatch(&mut session, op::APP_INIT, input)["ok"], true);
        for _ in 0..2 {
            let result = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/start"}));
            assert_eq!(result["ok"], true, "{engine:?}: {result}");
        }
        let observed = call(&mut session, "app.js", "inspect");
        let receivers = &observed[0]["receivers"];
        assert_ne!(receivers[0]["id"], receivers[1]["id"]);
        for index in 0..2 {
            let expected = json!({"count":index+1,"callback":index+1,"promise":index+1});
            assert_eq!(receivers[index]["data"], expected, "{engine:?}");
            let actual = session.app_service().pages().iter().nth(index).unwrap();
            assert_eq!(actual.data, expected, "{engine:?}: page {index}");
        }
    }
}

#[test]
fn component_page_context_does_not_promote_dependency_components_or_accept_duplicate_definitions() {
    for engine in engines() {
        let (mut session, input) = fixture_with_routes(
            engine,
            &[
                ("app.js", ModuleFormat::Commonjs, "App({});", &[]),
                (
                    "pages/start/index.js",
                    ModuleFormat::Commonjs,
                    "require('../../child');Component({data:{page:true}});",
                    &["child.js"],
                ),
                (
                    "child.js",
                    ModuleFormat::Commonjs,
                    "Component({__wevu_isPage:true,data:{child:true}});",
                    &[],
                ),
            ],
            &["pages/start/index"],
        );
        assert_eq!(
            dispatch(&mut session, op::APP_INIT, input)["ok"],
            true,
            "{engine:?}"
        );
        assert_eq!(
            dispatch(
                &mut session,
                op::PAGE_PUSH,
                json!({"path":"pages/start/index"})
            )["ok"],
            true
        );
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"page":true})
        );
        let (mut invalid, input) = fixture_with_routes(
            engine,
            &[
                ("app.js", ModuleFormat::Commonjs, "App({});", &[]),
                (
                    "pages/start/index.js",
                    ModuleFormat::Commonjs,
                    "Component({});Component({});",
                    &[],
                ),
            ],
            &["pages/start/index"],
        );
        let response = dispatch(&mut invalid, op::APP_INIT, input);
        assert_eq!(response["ok"], false, "{engine:?}: {response}");
        assert_eq!(response["error"]["code"], "ERR_MODULE_LOAD");
    }
}

#[test]
fn invalid_page_registration_rolls_back_before_empty_or_identical_init_retries() {
    for engine in engines() {
        for source in [
            "Component({});Component({});",
            "Page({});Component({});",
            "Component({});Page({});",
            "Page({});Page({});",
            "exports.noPage=true;",
        ] {
            let (mut session, input) = fixture_with_routes(
                engine,
                &[
                    ("app.js", ModuleFormat::Commonjs, "App({});", &[]),
                    ("pages/invalid.js", ModuleFormat::Commonjs, source, &[]),
                ],
                &["pages/invalid"],
            );
            for retry in [input.clone(), json!({}), input] {
                let rejected = dispatch(&mut session, op::APP_INIT, retry);
                assert_eq!(rejected["ok"], false, "{engine:?}: {source}: {rejected}");
                assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
                let page = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/invalid"}));
                assert_eq!(page["ok"], false, "{engine:?}: {source}: {page}");
                assert!(session.app_service().pages().is_empty());
            }
        }
    }
}

#[test]
fn component_pages_cannot_use_historical_bundled_page_registration_counts() {
    for engine in engines() {
        let (session, input) = fixture_with_routes(
            engine,
            &[(
                "app.js",
                ModuleFormat::Commonjs,
                "App({});Component({});Component({});",
                &[],
            )],
            &["pages/first", "pages/second"],
        );
        let mut manifest = session.manifest().clone();
        for route in &mut manifest.routes {
            route.entry_module = "app.js".into();
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, session.config().clone()).unwrap();
        for retry in [input.clone(), json!({}), input] {
            let rejected = dispatch(&mut session, op::APP_INIT, retry);
            assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
            assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
        }
    }
}

#[test]
fn failed_component_page_retries_preserve_dependency_cache_and_restore_registration_context() {
    for engine in engines() {
        let (mut session, input) = fixture_with_routes(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"App({});exports.inspect=()=>({
                        attempts:globalThis.attempts,runs:globalThis.childRuns,
                        pages:__container_page_module_definitions['module:pages/start.js'].length,
                        children:__container_components.filter(Boolean).length
                    });exports.registerOutside=()=>{Component({});return __container_pages.filter(Boolean).length;};"#,
                    &[],
                ),
                (
                    "pages/start.js",
                    ModuleFormat::Commonjs,
                    r#"globalThis.attempts=(globalThis.attempts||0)+1;
                        Component({data:{page:true},methods:{onLoad(){this.setData({loaded:true});}}});
                        require('../child');
                        if(globalThis.attempts===1)throw new Error('first page failure');"#,
                    &["child.js"],
                ),
                (
                    "child.js",
                    ModuleFormat::Commonjs,
                    "globalThis.childRuns=(globalThis.childRuns||0)+1;Component({data:{child:true}});",
                    &[],
                ),
            ],
            &["pages/start"],
        );
        let rejected = dispatch(&mut session, op::APP_INIT, input.clone());
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        let omitted = dispatch(&mut session, op::APP_INIT, json!({}));
        assert_eq!(omitted["ok"], false, "{engine:?}: {omitted}");
        let accepted = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(accepted["ok"], true, "{engine:?}: {accepted}");
        let page = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/start"}));
        assert_eq!(page["ok"], true, "{engine:?}: {page}");
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"page":true,"loaded":true})
        );
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"attempts":2,"runs":1,"pages":1,"children":1}])
        );
        assert_eq!(call(&mut session, "app.js", "registerOutside"), json!([1]));
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"attempts":2,"runs":1,"pages":1,"children":2}])
        );
    }
}

#[test]
fn commonjs_and_json_dependencies_share_exports_identity_and_run_once() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
                const first = require('./utils');
                const again = require('./utils/index.js');
                const config = require('./config.json');
                exports.inspect = () => ({answer:first.add(config.value), same:first === again,
                    runs:globalThis.moduleRuns, receiver:first.receiver});
            "#,
                    &["utils/index.js", "config.json"],
                ),
                (
                    "utils/index.js",
                    ModuleFormat::Commonjs,
                    r#"
                globalThis.moduleRuns = (globalThis.moduleRuns || 0) + 1;
                exports.receiver = this === exports;
                exports.add = value => value + 1;
            "#,
                    &[],
                ),
                ("config.json", ModuleFormat::Json, "{\"value\":41}", &[]),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"answer":42,"same":true,"runs":1,"receiver":true}])
        );
    }
}

#[test]
fn commonjs_cycles_expose_partial_exports_and_cache_reassigned_exports() {
    for engine in engines() {
        let (mut session, input) = fixture(engine, &[
            ("app.js", ModuleFormat::Commonjs, "const a=require('./a'); exports.inspect=()=>a;", &["a.js"]),
            ("a.js", ModuleFormat::Commonjs, "exports.started=true; const b=require('./b'); module.exports={seen:b.seen,finished:true};", &["b.js"]),
            ("b.js", ModuleFormat::Commonjs, "const a=require('./a'); exports.seen={started:a.started,finished:a.finished===undefined};", &["a.js"]),
        ]);
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"seen":{"started":true,"finished":true},"finished":true}])
        );
    }
}

#[test]
fn conditional_require_is_lazy_and_failed_factory_is_retryable() {
    for engine in engines() {
        let (mut session, input) = fixture(engine, &[
            ("app.js", ModuleFormat::Commonjs, r#"
                if (false) require('./failing');
                exports.before=()=>globalThis.attempts || 0;
                exports.retry=()=>{ try { require('./failing'); } catch(error) { return globalThis.attempts; } };
            "#, &["failing.js"]),
            ("failing.js", ModuleFormat::Commonjs, "globalThis.attempts=(globalThis.attempts||0)+1; throw new Error('fixture failure');", &[]),
        ]);
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(call(&mut session, "app.js", "before"), json!([0]));
        assert_eq!(call(&mut session, "app.js", "retry"), json!([1]));
        assert_eq!(call(&mut session, "app.js", "retry"), json!([2]));
    }
}

#[test]
fn json_uses_json_parse_instead_of_javascript_object_literal_semantics() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
                const data=require('./data.json');
                exports.inspect=()=>({own:Object.prototype.hasOwnProperty.call(data,'__proto__'),
                    inherited:data.injected===undefined, plain:Object.getPrototypeOf(data)===Object.prototype,
                    nested:data.__proto__.injected, negativeZero:Object.is(data.zero,-0), same:data===require('./data.json')});
            "#,
                    &["data.json"],
                ),
                (
                    "data.json",
                    ModuleFormat::Json,
                    r#"{"__proto__":{"injected":true},"zero":-0}"#,
                    &[],
                ),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"own":true,"inherited":true,"plain":true,"nested":true,"negativeZero":true,"same":true}])
        );
    }
}

#[test]
fn json_accepts_the_engine_number_and_utf16_domain_before_application_execution() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
                const data=require('./data.json');
                exports.inspect=()=>({finite:Number.isFinite(data.large),
                    surrogate:data.text.charCodeAt(0),length:data.text.length});
            "#,
                    &["data.json"],
                ),
                (
                    "data.json",
                    ModuleFormat::Json,
                    r#"{"large":1e400,"text":"\ud800"}"#,
                    &[],
                ),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"finite":false,"surrogate":55296,"length":1}])
        );
    }
}

#[test]
fn require_cannot_escape_or_use_undeclared_manifest_dependencies() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
                exports.inspect=()=>['./available','../available','missing'].map(path=>{
                    try { require(path); return 'unexpected'; } catch(error) { return error.code; }
                });
            "#,
                    &[],
                ),
                (
                    "available.js",
                    ModuleFormat::Commonjs,
                    "module.exports=42;",
                    &[],
                ),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!(["ERR_MODULE_LOAD", "ERR_MODULE_LOAD", "ERR_MODULE_LOAD"])
        );
    }
}

#[test]
fn manifest_dependency_and_digest_validation_precede_application_execution() {
    for engine in engines() {
        let (mut session, mut input) = fixture(
            engine,
            &[(
                "app.js",
                ModuleFormat::Commonjs,
                "globalThis.executed=true; exports.inspect=()=>globalThis.executed;",
                &[],
            )],
        );
        input["modules"][0]["source"] = json!("throw new Error('tampered bytes');");
        let rejected = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
    }
}

#[test]
fn static_esm_imports_evaluate_commonjs_and_json_factories_before_access() {
    for engine in engines() {
        let (mut session, input) = fixture(engine, &[
            ("app.js", ModuleFormat::Esm, "import add from './add.cjs'; import data from './data.json'; export const inspect=()=>add(data.answer);", &["add.cjs", "data.json"]),
            ("add.cjs", ModuleFormat::Commonjs, "module.exports=value=>value+1;", &[]),
            ("data.json", ModuleFormat::Json, "{\"answer\":41}", &[]),
        ]);
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!([42]));
    }
}

#[test]
fn cycles_containing_esm_are_explicitly_rejected() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    "require('./dep.mjs');",
                    &["dep.mjs"],
                ),
                (
                    "dep.mjs",
                    ModuleFormat::Esm,
                    "import app from './app.js'; export default app;",
                    &["app.js"],
                ),
            ],
        );
        let rejected = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
    }
}

#[test]
fn a_failed_root_can_be_retried_with_the_same_verified_module_batch() {
    for engine in engines() {
        let (mut session, input) = fixture(engine, &[
            ("app.js", ModuleFormat::Commonjs, "globalThis.rootAttempts=(globalThis.rootAttempts||0)+1; if(globalThis.rootAttempts===1) throw new Error('first attempt'); exports.inspect=()=>globalThis.rootAttempts;", &[]),
        ]);
        let rejected = dispatch(&mut session, op::APP_INIT, input.clone());
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
        let retried = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(retried["ok"], true, "{engine:?}: {retried}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!([2]));
    }
}

#[test]
fn failed_entry_cannot_initialize_from_a_cached_route_or_leak_its_app_definition() {
    for engine in engines() {
        for has_route in [false, true] {
            let app = if has_route {
                r#"globalThis.appAttempts=(globalThis.appAttempts||0)+1;require('./pages/valid');
                if(appAttempts===1){App({onLaunch(){globalThis.leakedLaunch=true;}});throw new Error('entry failure');}
                exports.inspect=()=>({attempts:appAttempts,routeRuns:globalThis.routeRuns,leaked:globalThis.leakedLaunch===true});"#
            } else {
                r#"globalThis.appAttempts=(globalThis.appAttempts||0)+1;
                if(appAttempts===1){App({onLaunch(){globalThis.leakedLaunch=true;}});throw new Error('entry failure');}
                exports.inspect=()=>({attempts:appAttempts,routeRuns:0,leaked:globalThis.leakedLaunch===true});"#
            };
            let mut sources = vec![("app.js", ModuleFormat::Commonjs, app, &[][..])];
            if has_route {
                sources[0].3 = &["pages/valid.js"];
                sources.push((
                    "pages/valid.js",
                    ModuleFormat::Commonjs,
                    "globalThis.routeRuns=(globalThis.routeRuns||0)+1;Page({});",
                    &[],
                ));
            }
            let (mut session, input) = fixture_with_routes(
                engine,
                &sources,
                if has_route { &["pages/valid"] } else { &[] },
            );
            let rejected = dispatch(&mut session, op::APP_INIT, input.clone());
            assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
            let omitted = dispatch(&mut session, op::APP_INIT, json!({}));
            assert_eq!(omitted["ok"], false, "{engine:?}: {omitted}");
            assert_eq!(omitted["error"]["code"], "ERR_MODULE_LOAD");
            if has_route {
                let page = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/valid"}));
                assert_eq!(page["ok"], false, "{engine:?}: {page}");
            }
            let accepted = dispatch(&mut session, op::APP_INIT, input);
            assert_eq!(accepted["ok"], true, "{engine:?}: {accepted}");
            assert_eq!(
                call(&mut session, "app.js", "inspect"),
                json!([{"attempts":2,"routeRuns":if has_route {1}else{0},"leaked":false}])
            );
        }
    }
}

#[test]
fn incomplete_eager_roots_survive_empty_retry_and_unrelated_successful_subsets() {
    for engine in engines() {
        let (mut session, input) = fixture_with_routes(engine, &[
            ("app.js", ModuleFormat::Commonjs,
                r#"globalThis.appRuns=(globalThis.appRuns||0)+1;App({onLaunch(){globalThis.launches=(globalThis.launches||0)+1;}});
                exports.inspect=()=>({appRuns:appRuns,routeRuns:routeRuns,failedRuns:failedRuns,launches:launches});"#, &[]),
            ("pages/valid.js", ModuleFormat::Commonjs,
                "globalThis.routeRuns=(globalThis.routeRuns||0)+1;Page({});", &[]),
            ("z-fail.js", ModuleFormat::Commonjs,
                "globalThis.failedRuns=(globalThis.failedRuns||0)+1;if(failedRuns<3)throw new Error('retry root');", &[]),
        ], &["pages/valid"]);
        let first = dispatch(&mut session, op::APP_INIT, input.clone());
        assert_eq!(first["ok"], false, "{engine:?}: {first}");
        let omitted = dispatch(&mut session, op::APP_INIT, json!({}));
        assert_eq!(omitted["ok"], false, "{engine:?}: {omitted}");
        let call_before = dispatch(
            &mut session,
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"inspect","args":[]}),
        );
        assert_eq!(call_before["ok"], false, "{engine:?}: {call_before}");
        let load_before = dispatch(
            &mut session,
            op::MODULE_LOAD,
            json!({"modules":[input["modules"][0].clone()]}),
        );
        assert_eq!(load_before["ok"], false, "{engine:?}: {load_before}");
        // A verified successful app subset must still complete the pending
        // failed root. It cannot discard that root's startup obligation.
        let subset = dispatch(
            &mut session,
            op::APP_INIT,
            json!({"modules":[input["modules"][0].clone()]}),
        );
        assert_eq!(subset["ok"], false, "{engine:?}: {subset}");
        let omitted = dispatch(&mut session, op::APP_INIT, json!({}));
        assert_eq!(omitted["ok"], false, "{engine:?}: {omitted}");
        let accepted = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(accepted["ok"], true, "{engine:?}: {accepted}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"appRuns":1,"routeRuns":1,"failedRuns":3,"launches":1}])
        );
        assert_eq!(dispatch(&mut session, op::APP_INIT, json!({}))["ok"], true);
        assert_eq!(call(&mut session, "app.js", "inspect")[0]["launches"], 1);
        assert_eq!(
            dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/valid"}))["ok"],
            true
        );
    }
}

#[test]
fn failed_app_registrations_preserve_the_successful_dependency_app_on_retry() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"globalThis.appAttempts=(globalThis.appAttempts||0)+1;
                if(appAttempts===1)App({globalData:{name:'failed-before'},onLaunch(){globalThis.leakedLaunch=true;}});
                require('./dependency');
                if(appAttempts===1){App({globalData:{name:'failed-after'},onLaunch(){globalThis.leakedLaunch=true;}});throw new Error('entry failure');}
                exports.inspect=()=>({name:getApp().globalData.name,attempts:appAttempts,runs:dependencyRuns,
                    launches:dependencyLaunches,leaked:globalThis.leakedLaunch===true});"#,
                    &["dependency.js"],
                ),
                (
                    "dependency.js",
                    ModuleFormat::Commonjs,
                    r#"globalThis.dependencyRuns=(globalThis.dependencyRuns||0)+1;
                App({globalData:{name:'successful-dependency'},onLaunch(){globalThis.dependencyLaunches=(globalThis.dependencyLaunches||0)+1;}});"#,
                    &[],
                ),
            ],
        );
        assert_eq!(
            dispatch(&mut session, op::APP_INIT, input.clone())["ok"],
            false
        );
        assert_eq!(dispatch(&mut session, op::APP_INIT, json!({}))["ok"], false);
        let accepted = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(accepted["ok"], true, "{engine:?}: {accepted}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{
                "name":"successful-dependency","attempts":2,"runs":1,"launches":1,"leaked":false
            }])
        );
    }
}

#[test]
fn nested_legacy_app_registration_helpers_share_their_atomic_rollback() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[(
                "app.js",
                ModuleFormat::Commonjs,
                r#"App({globalData:{name:'base'}});
            try{__container_evaluate_named_module('legacy',function(){
                App({globalData:{name:'failed-parent'}});
                __container_evaluate_named_module('nested',function(){App({globalData:{name:'failed-nested'}});});
                throw new Error('legacy failure');
            });}catch(error){}
            exports.inspect=()=>getApp().globalData.name;"#,
                &[],
            )],
        );
        let accepted = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(accepted["ok"], true, "{engine:?}: {accepted}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!(["base"]));
    }
}

#[test]
fn syntax_or_json_errors_in_later_modules_cannot_execute_earlier_roots() {
    for engine in engines() {
        for (format, invalid) in [
            (ModuleFormat::Commonjs, "const = ;"),
            (ModuleFormat::Json, "{invalid"),
        ] {
            let (mut session, input) = fixture(engine, &[
                ("app.js", ModuleFormat::Commonjs, "globalThis.rootRuns=(globalThis.rootRuns||0)+1; exports.inspect=()=>globalThis.rootRuns;", &[]),
                ("z-invalid.js", format, invalid, &[]),
            ]);
            let rejected = dispatch(&mut session, op::APP_INIT, input.clone());
            assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
            assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
            let retried = dispatch(
                &mut session,
                op::APP_INIT,
                json!({"modules":[input["modules"][0].clone()]}),
            );
            assert_eq!(retried["ok"], true, "{engine:?}: {retried}");
            assert_eq!(call(&mut session, "app.js", "inspect"), json!([1]));
        }
    }
}

#[test]
fn module_local_require_is_lexical_and_empty_commonjs_is_valid() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    r#"
                const empty=require('./empty');
                const text="require('./not-a-dependency')";
                function local(require) { return require('local'); }
                exports.inspect=()=>({empty:Object.keys(empty).length,text,shadow:local(value=>'shadow:'+value)});
            "#,
                    &["empty.js"],
                ),
                ("empty.js", ModuleFormat::Commonjs, "", &[]),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!([{"empty":0,"text":"require('./not-a-dependency')","shadow":"shadow:local"}])
        );
    }
}

#[test]
fn an_esm_importer_can_use_a_commonjs_only_cycle() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Esm,
                    "import a from './a.js'; export const inspect=()=>a.answer;",
                    &["a.js"],
                ),
                (
                    "a.js",
                    ModuleFormat::Commonjs,
                    "exports.answer=42; require('./b');",
                    &["b.js"],
                ),
                (
                    "b.js",
                    ModuleFormat::Commonjs,
                    "exports.a=require('./a');",
                    &["a.js"],
                ),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!([42]));
    }
}

#[test]
fn unsupported_unicode_esm_binding_returns_a_module_error_instead_of_panicking() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Esm,
                    "import 名称 from './dep.js'; export default 名称;",
                    &["dep.js"],
                ),
                ("dep.js", ModuleFormat::Esm, "export default 42;", &[]),
            ],
        );
        let rejected = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
        assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
    }
}

#[test]
fn eager_page_roots_follow_manifest_order_while_requires_keep_their_execution_order() {
    for engine in engines() {
        for early in [false, true] {
            let (app, dependencies): (&str, &[&str]) = if early {
                (
                    "globalThis.startup=['app']; require('./pages/a'); App({}); exports.inspect=()=>globalThis.startup;",
                    &["pages/a.js"],
                )
            } else {
                (
                    "globalThis.startup=['app']; App({}); exports.inspect=()=>globalThis.startup;",
                    &[],
                )
            };
            let (mut session, input) = fixture_with_routes(
                engine,
                &[
                    (
                        "z-legacy.js",
                        ModuleFormat::Commonjs,
                        "globalThis.startup.push('legacy');",
                        &[],
                    ),
                    (
                        "pages/a.js",
                        ModuleFormat::Commonjs,
                        "globalThis.startup.push('a'); Page({});",
                        &[],
                    ),
                    ("app.js", ModuleFormat::Commonjs, app, dependencies),
                    (
                        "package/first.js",
                        ModuleFormat::Commonjs,
                        "globalThis.startup.push('subpackage'); Page({});",
                        &[],
                    ),
                    (
                        "pages/z.js",
                        ModuleFormat::Commonjs,
                        "globalThis.startup.push('z'); Page({});",
                        &[],
                    ),
                ],
                &["pages/z", "pages/a", "package/first"],
            );
            let initialized = dispatch(&mut session, op::APP_INIT, input);
            assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
            let expected = if early {
                json!(["app", "a", "z", "subpackage", "legacy"])
            } else {
                json!(["app", "z", "a", "subpackage", "legacy"])
            };
            assert_eq!(
                call(&mut session, "app.js", "inspect"),
                expected,
                "{engine:?}, early={early}"
            );
        }
    }
}

#[test]
fn prefixed_entry_references_share_root_order_and_page_module_ownership() {
    for engine in engines() {
        let (session, input) = fixture_with_routes(
            engine,
            &[
                ("0-legacy.js", ModuleFormat::Commonjs, "globalThis.startup.push('legacy');", &[]),
                (
                    "app.js",
                    ModuleFormat::Commonjs,
                    "globalThis.startup=['app']; require('./pages/a'); App({}); exports.inspect=()=>globalThis.startup;",
                    &["pages/a.js"],
                ),
                ("pages/z.js", ModuleFormat::Commonjs, "globalThis.startup.push('z'); Page({onLoad(){return 'z-definition';}});", &[]),
                ("pages/a.js", ModuleFormat::Commonjs, "globalThis.startup.push('a'); Page({onLoad(){return 'a-definition';}});", &[]),
            ],
            &["pages/z", "pages/a"],
        );
        let mut manifest = session.manifest().clone();
        manifest.app.entry_module = "module:app.js".into();
        manifest.routes[0].entry_module = "module:pages/z.js".into();
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(manifest, session.config().clone()).unwrap();
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(
            call(&mut session, "app.js", "inspect"),
            json!(["app", "a", "z", "legacy"])
        );
        let z = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/z"}));
        assert_eq!(z["hooks"]["onLoad"], "z-definition", "{engine:?}: {z}");
        let a = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/a"}));
        assert_eq!(a["hooks"]["onLoad"], "a-definition", "{engine:?}: {a}");
    }
}

#[test]
fn route_definitions_follow_module_ownership_despite_order_or_early_require() {
    for engine in engines() {
        for early in [false, true] {
            let (app, deps): (&str, &[&str]) = if early {
                ("require('./pages/a'); App({});", &["pages/a.js"])
            } else {
                ("App({});", &[])
            };
            let (mut session, input) = fixture_with_routes(
                engine,
                &[
                    ("app.js", ModuleFormat::Commonjs, app, deps),
                    (
                        "pages/z.js",
                        ModuleFormat::Commonjs,
                        "Page({onLoad(){return 'z-definition';}});",
                        &[],
                    ),
                    (
                        "pages/a.js",
                        ModuleFormat::Commonjs,
                        "Page({onLoad(){return 'a-definition';}});",
                        &[],
                    ),
                ],
                &["pages/z", "pages/a"],
            );
            let initialized = dispatch(&mut session, op::APP_INIT, input);
            assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
            let z = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/z"}));
            assert_eq!(z["hooks"]["onLoad"], "z-definition", "{engine:?}: {z}");
            let a = dispatch(&mut session, op::PAGE_PUSH, json!({"path":"pages/a"}));
            assert_eq!(a["hooks"]["onLoad"], "a-definition", "{engine:?}: {a}");
        }
    }
}

#[test]
fn shared_entry_module_pairs_definitions_with_its_routes_or_reuses_one_definition() {
    for engine in engines() {
        for shared_definition in [false, true] {
            let source = if shared_definition {
                "App({}); Page({onLoad(){return 'shared-definition';}});"
            } else {
                "App({}); Page({onLoad(){return 'z-definition';}}); Page({onLoad(){return 'a-definition';}});"
            };
            let (session, input) = fixture_with_routes(
                engine,
                &[("app.js", ModuleFormat::Commonjs, source, &[])],
                &["pages/z", "pages/a"],
            );
            let mut manifest = session.manifest().clone();
            manifest.routes[0].entry_module = "module:app.js".into();
            manifest.routes[1].entry_module = "app.js".into();
            manifest.refresh_integrity().unwrap();
            let mut session = Session::new(manifest, session.config().clone()).unwrap();
            let initialized = dispatch(&mut session, op::APP_INIT, input);
            assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
            for (route, label) in [("pages/z", "z-definition"), ("pages/a", "a-definition")] {
                let page = dispatch(&mut session, op::PAGE_PUSH, json!({"path":route}));
                assert_eq!(
                    page["hooks"]["onLoad"],
                    if shared_definition {
                        "shared-definition"
                    } else {
                        label
                    },
                    "{engine:?}: {page}"
                );
            }
        }
    }
}

#[test]
fn a_declared_route_module_requires_exactly_one_page_definition() {
    for engine in engines() {
        for source in ["exports.noPage=true;", "Page({}); Page({});"] {
            let (mut session, input) = fixture_with_routes(
                engine,
                &[
                    ("app.js", ModuleFormat::Commonjs, "App({});", &[]),
                    ("pages/invalid.js", ModuleFormat::Commonjs, source, &[]),
                ],
                &["pages/invalid"],
            );
            let rejected = dispatch(&mut session, op::APP_INIT, input);
            assert_eq!(rejected["ok"], false, "{engine:?}: {rejected}");
            assert_eq!(rejected["error"]["code"], "ERR_MODULE_LOAD");
        }
    }
}

#[test]
fn static_esm_dependencies_follow_source_order_including_re_exports() {
    for engine in engines() {
        let (mut session, input) = fixture(engine, &[
            ("app.js", ModuleFormat::Esm, "import './z.js'; export {a} from './a.js'; import './m.js'; export const inspect=()=>globalThis.importOrder.join(',');", &["a.js", "m.js", "z.js"]),
            ("a.js", ModuleFormat::Commonjs, "globalThis.importOrder.push('a'); exports.a=true;", &[]),
            ("m.js", ModuleFormat::Commonjs, "globalThis.importOrder.push('m');", &[]),
            ("z.js", ModuleFormat::Commonjs, "globalThis.importOrder=['z'];", &[]),
        ]);
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!(["z,a,m"]));
    }
}

#[test]
fn an_esm_default_import_can_receive_null_commonjs_exports() {
    for engine in engines() {
        let (mut session, input) = fixture(
            engine,
            &[
                (
                    "app.js",
                    ModuleFormat::Esm,
                    "import value from './null.cjs'; export const inspect=()=>value===null;",
                    &["null.cjs"],
                ),
                (
                    "null.cjs",
                    ModuleFormat::Commonjs,
                    "module.exports=null;",
                    &[],
                ),
            ],
        );
        let initialized = dispatch(&mut session, op::APP_INIT, input);
        assert_eq!(initialized["ok"], true, "{engine:?}: {initialized}");
        assert_eq!(call(&mut session, "app.js", "inspect"), json!([true]));
    }
}

macro_rules! managed_dependency_retry {
    ($engine:expr) => {{
        use container_core::{CallTarget, JsEngine};
        let mut engine = $engine;
        engine.call(CallTarget::Global {name:"__container_configure_component_modules".into()},
            vec![json!(["module:a.js","module:b.js"])]).unwrap();
        engine.register_module_with_id("module:a.js", br#"
            Component({data:{name:'a'}}); require('./b');
            globalThis.parentAttempts=(globalThis.parentAttempts||0)+1;
            if(globalThis.parentAttempts===1) throw new Error('parent failure');
        "#, &["module:b.js".into()], false).unwrap();
        engine.register_module_with_id("module:b.js", br#"
            globalThis.dependencyRuns=(globalThis.dependencyRuns||0)+1;
            Component({data:{name:'b'}});
        "#, &[], false).unwrap();
        assert!(engine.evaluate_module_with_id("module:a.js").is_err());
        engine.evaluate_module_with_id("module:a.js").unwrap();
        let control = engine.load_module(br#"exports.inspect=()=>({
            a:__container_component_module_definitions['module:a.js'].length,
            b:__container_component_module_definitions['module:b.js'].length,
            bName:__container_components[__container_component_module_definitions['module:b.js'][0]].data.name,
            runs:globalThis.dependencyRuns
        });"#).unwrap();
        assert_eq!(engine.call(CallTarget::Module {id:control,export:"inspect".into()},vec![]).unwrap(),
            vec![json!({"a":1,"b":1,"bName":"b","runs":1})]);
    }};
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_failed_managed_parent_preserves_successful_dependency_registration() {
    managed_dependency_retry!(container_engine_quickjs::QuickJsEngine::default());
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_failed_managed_parent_preserves_successful_dependency_registration() {
    managed_dependency_retry!(container_engine_v8::V8Engine::default());
}

macro_rules! legacy_registry_boundary {
    ($engine:expr) => {{
        use container_core::{CallTarget, JsEngine};
        let mut engine = $engine;
        engine.call(CallTarget::Global {name:"__container_configure_component_modules".into()},
            vec![json!(["module:cached.js","legacy"])]).unwrap();
        engine.register_module_with_id("module:cached.js", br#"
            globalThis.cachedRuns=(globalThis.cachedRuns||0)+1;
            exports.partial=true;
            __container_evaluate_named_module('manual', function() {
                if(require('./cached') !== exports) throw new Error('evaluating cache identity changed');
            });
            Component({data:{name:'cached'}});
        "#, &["module:cached.js".into()], false).unwrap();
        assert!(engine.load_module_with_id("legacy", br#"
            try { __container_evaluate_module('module:cached.js'); }
            catch(error) { globalThis.blockedCode=error.code; throw error; }
            Component({});
        "#).is_err());
        assert_eq!(engine.loaded_module_count(), 1, "failed legacy load cannot consume a provider ID");
        let registration = engine.call(CallTarget::Global {name:"__container_registration_snapshot".into()},vec![]).unwrap();
        assert_eq!(registration[0]["components"], 0, "blocked first evaluation cannot register definitions");
        engine.evaluate_module_with_id("module:cached.js").unwrap();
        let legacy = engine.load_module_with_id("legacy", br#"
            __container_evaluate_module('module:cached.js');
            Component({data:{name:'legacy'}});
            exports.inspect=()=>({code:globalThis.blockedCode,runs:globalThis.cachedRuns,
                cached:__container_component_module_definitions['module:cached.js'].length,
                legacy:__container_component_module_definitions.legacy.length,
                depth:globalThis.__container_legacy_registration_depth});
        "#).unwrap();
        assert_eq!(engine.call(CallTarget::Module {id:legacy,export:"inspect".into()},vec![]).unwrap(),
            vec![json!({"code":"ERR_MODULE_LOAD","runs":1,"cached":1,"legacy":1,"depth":0})]);
    }};
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_legacy_transaction_rejects_new_registry_factories_without_pollution() {
    legacy_registry_boundary!(container_engine_quickjs::QuickJsEngine::default());
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_legacy_transaction_rejects_new_registry_factories_without_pollution() {
    legacy_registry_boundary!(container_engine_v8::V8Engine::default());
}
