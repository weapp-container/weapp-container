use super::*;
use crate::HostApiProvider;
use crate::{
    host_api_catalog, HostDeviceOrientation, HostDisplayMetrics, HostSafeArea, HostServicesConfig,
    MenuButtonRect, ProviderContext, ProviderErrorCode, ProviderStart, Session, SessionConfig,
    StrictHostProvider, TrustedApplication,
};
use container_ir::{CapabilitySupport, ContainerManifestV1};
use serde_json::Map;
use std::collections::BTreeMap;

fn metrics(width: u32, height: u32) -> HostWindowMetrics {
    HostWindowMetrics {
        window_width: width,
        window_height: height,
        display: HostDisplayMetrics {
            pixel_ratio: 2.75,
            screen_width: 1000,
            screen_height: 1400,
            status_bar_height: 27.5,
            screen_top: 70.25,
            safe_area: Some(HostSafeArea {
                left: 3.5,
                right: 996.5,
                top: 27.5,
                bottom: 1370.5,
                width: 993.0,
                height: 1343.0,
            }),
            host_layout: None,
            device_orientation: if width > height {
                HostDeviceOrientation::Landscape
            } else {
                HostDeviceOrientation::Portrait
            },
        },
    }
}

fn menu() -> MenuButtonRect {
    MenuButtonRect {
        left: 200.5,
        right: 280.5,
        top: 32.25,
        bottom: 64.25,
        width: 80.0,
        height: 32.0,
    }
}

fn host(metrics: HostWindowMetrics) -> HostMetadata {
    HostMetadata {
        window_width: metrics.window_width,
        window_height: metrics.window_height,
        display_metrics: Some(metrics.display),
        menu_button_rect: Some(menu()),
        ..Default::default()
    }
}

#[test]
fn production_geometry_requires_complete_observations_and_never_fabricates_device_fields() {
    let viewport_only = HostMetadata {
        window_width: 375,
        window_height: 667,
        ..Default::default()
    };
    for name in HOST_GEOMETRY_APIS {
        assert_eq!(project_host_geometry(name, &viewport_only).unwrap(), None);
    }
    let actual = host(metrics(375, 667));
    let window = project_host_geometry("wx.getWindowInfo", &actual)
        .unwrap()
        .unwrap();
    assert_eq!(window["pixelRatio"], 2.75);
    assert_eq!(window["screenTop"], 70.25);
    assert_eq!(window["safeArea"]["left"], 3.5);
    for name in [
        "brand",
        "model",
        "system",
        "version",
        "SDKVersion",
        "host",
        "deviceOrientation",
    ] {
        assert!(
            window.get(name).is_none(),
            "unobserved/window-inapplicable field {name}"
        );
    }
    let system = project_host_geometry("wx.getSystemInfoSync", &actual)
        .unwrap()
        .unwrap();
    assert_eq!(system["deviceOrientation"], "portrait");
    assert!(system.get("screenTop").is_none());
    for name in [
        "wx.getDeviceInfo",
        "wx.getAppBaseInfo",
        "wx.getAccountInfoSync",
        "wx.getBatteryInfoSync",
    ] {
        assert!(project_host_geometry(name, &actual).unwrap().is_none());
    }
}

#[test]
fn production_geometry_replaces_stale_fields_without_erasing_real_os_data() {
    let mut actual = host(metrics(375, 667));
    actual.display_metrics.as_mut().unwrap().safe_area = None;
    let stale = json!({"brand":"measured-brand", "system":"measured OS", "windowWidth":999,
        "pixelRatio":1, "safeArea":{"left":0,"right":999,"top":0,"bottom":999,"width":999,"height":999}});
    let value = merge_host_geometry("wx.getSystemInfoSync", Some(stale), &actual)
        .unwrap()
        .unwrap();
    assert_eq!(value["brand"], "measured-brand");
    assert_eq!(value["system"], "measured OS");
    assert_eq!(value["windowWidth"], 375);
    assert_eq!(value["pixelRatio"], 2.75);
    assert!(value.get("safeArea").is_none());
    actual.display_metrics.as_mut().unwrap().pixel_ratio = f64::NAN;
    assert!(merge_host_geometry(
        "wx.getSystemInfoSync",
        Some(json!({"windowWidth":999})),
        &actual
    )
    .is_err());
    actual.menu_button_rect.as_mut().unwrap().width = 0.0;
    assert!(project_host_geometry("wx.getMenuButtonBoundingClientRect", &actual).is_err());
}

#[test]
fn production_window_layout_comes_only_from_current_accepted_observation() {
    let mut actual = host(metrics(375, 667));
    let layout = json!({"version":1,"safeInsets":{"top":0,"right":84,"bottom":34,"left":0},
        "verticalBarEdge":"right","reservedRegions":[
            {"id":"camera","kind":"occlusion","x":335,"y":0,"width":40,"height":30}]});
    actual.display_metrics.as_mut().unwrap().host_layout =
        Some(serde_json::from_value(layout.clone()).unwrap());
    let layout = json!(actual.display_metrics.as_ref().unwrap().host_layout);
    let cached = json!({"brand":"observed OS","hostLayout":{"stale":true}});
    let projected = merge_host_geometry("wx.getWindowInfo", Some(cached.clone()), &actual)
        .unwrap()
        .unwrap();
    assert_eq!(projected["hostLayout"], layout);
    assert_eq!(projected["brand"], "observed OS");
    let system = merge_host_geometry("wx.getSystemInfoSync", Some(cached.clone()), &actual)
        .unwrap()
        .unwrap();
    assert!(system.get("hostLayout").is_none());

    actual.display_metrics.as_mut().unwrap().host_layout = None;
    let cleared = merge_host_geometry("wx.getWindowInfo", Some(cached.clone()), &actual)
        .unwrap()
        .unwrap();
    assert!(cleared.get("hostLayout").is_none());
    let unobserved = merge_host_geometry(
        "wx.getSystemInfoSync",
        Some(cached),
        &HostMetadata::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(unobserved, json!({"brand":"observed OS"}));
}

#[test]
fn unobserved_geometry_cannot_be_restored_from_registered_snapshots() {
    let unobserved = HostMetadata::default();
    let value = merge_host_geometry(
        "wx.getSystemInfoSync",
        Some(json!({"brand":"real-brand","windowWidth":999,"screenWidth":999,"pixelRatio":1,"deviceOrientation":"landscape"})),
        &unobserved,
    ).unwrap().unwrap();
    assert_eq!(value, json!({"brand":"real-brand"}));
    for name in ["wx.getWindowInfo", "wx.getMenuButtonBoundingClientRect"] {
        assert_eq!(
            merge_host_geometry(name, Some(json!({"windowWidth":999})), &unobserved).unwrap(),
            None
        );
    }
    let provider = StrictHostProvider::from_snapshots(BTreeMap::from([
        ("wx.getWindowInfo".into(), json!({"windowWidth":999})),
        ("wx.getSystemInfoSync".into(), json!({"pixelRatio":1})),
    ]))
    .unwrap();
    assert_eq!(
        provider.capabilities_for_host(&unobserved)["wx.getWindowInfo"],
        CapabilitySupport::Unsupported
    );
    assert_eq!(
        provider.capabilities_for_host(&unobserved)["wx.getSystemInfoSync"],
        CapabilitySupport::Unsupported
    );
}

#[test]
fn strict_geometry_negotiation_depends_on_current_observation_not_manifest_or_sandbox() {
    let mut provider = StrictHostProvider::default();
    assert_eq!(
        provider.capabilities_for_host(&HostMetadata::default())["wx.getWindowInfo"],
        CapabilitySupport::Unsupported
    );
    let actual = host(metrics(375, 667));
    let capabilities = provider.capabilities_for_host(&actual);
    assert_eq!(capabilities["wx.getWindowInfo"], CapabilitySupport::Partial);
    for descriptor in host_api_catalog().iter().filter(|api| {
        api.kind == "syncSnapshot"
            && api.owner == "host"
            && !HOST_GEOMETRY_APIS.contains(&api.name.as_str())
    }) {
        assert_eq!(
            capabilities[&descriptor.name],
            CapabilitySupport::Unsupported
        );
    }
    let context = ProviderContext {
        host: actual,
        ..Default::default()
    };
    let value = provider
        .call("wx.getSystemInfoSync", &Map::new(), &context)
        .unwrap();
    assert_eq!(value["windowHeight"], 667);
    assert!(value.get("model").is_none());
    assert!(provider
        .call("wx.getDeviceInfo", &Map::new(), &context)
        .is_err());
}

fn delegated_session(fallback: Option<Box<dyn HostApiProvider>>, apis: &[&str]) -> Session {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "delegating-observed-geometry".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    manifest.refresh_integrity().unwrap();
    let pack_root = manifest.integrity.root.clone();
    let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
    if let Some(fallback) = fallback {
        session.set_provider(fallback);
    }
    session
        .configure_host_services(HostServicesConfig {
            application: TrustedApplication {
                host_app_id: "observed-host".into(),
                tenant_id: "tenant".into(),
                publisher_id: "publisher".into(),
                app_id: "mini".into(),
                environment: "release".into(),
                version: "1".into(),
                pack_root,
            },
            apis: apis.iter().map(|name| (*name).into()).collect(),
            sync_values: BTreeMap::new(),
            ..Default::default()
        })
        .unwrap();
    session
}

#[test]
fn delegated_geometry_calls_match_negotiation_without_registered_snapshots() {
    // Keep the default Sandbox fallback and configure no native APIs/snapshots.
    let mut session = delegated_session(None, &[]);
    let context = ProviderContext {
        host: host(metrics(375, 667)),
        ..Default::default()
    };
    let capabilities = session.provider.capabilities_for_host(&context.host);
    for name in HOST_GEOMETRY_APIS {
        assert_eq!(capabilities[name], CapabilitySupport::Partial, "{name}");
        let value = session.provider.call(name, &Map::new(), &context).unwrap();
        match name {
            "wx.getMenuButtonBoundingClientRect" => assert_eq!(value, json!(menu())),
            "wx.getSystemSetting" => {
                assert_eq!(value, json!({"deviceOrientation":"portrait"}));
            }
            _ => {
                assert_eq!(value["windowWidth"], 375, "{name}");
                assert_eq!(value["windowHeight"], 667, "{name}");
                assert_eq!(value["screenWidth"], 1000, "{name}");
                assert_eq!(value["pixelRatio"], 2.75, "{name}");
                assert_eq!(value["safeArea"]["left"], 3.5, "{name}");
                if name == "wx.getWindowInfo" {
                    assert_eq!(value["screenTop"], 70.25);
                    assert!(value.get("host").is_none());
                    assert!(value.get("deviceOrientation").is_none());
                } else {
                    assert_eq!(value["host"], json!({"appId":"observed-host"}));
                    assert_eq!(value["deviceOrientation"], "portrait");
                }
            }
        }
        for field in [
            "brand",
            "model",
            "system",
            "platform",
            "version",
            "SDKVersion",
        ] {
            assert!(value.get(field).is_none(), "unobserved {name}.{field}");
        }
        if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync") {
            assert_eq!(value["errMsg"], format!("{}:ok", &name[3..]));
        }
        assert_eq!(
            session.provider.start_call(name, &Map::new(), &context),
            ProviderStart::Ready(Ok(value)),
            "{name}"
        );
    }
    for name in [
        "wx.getDeviceInfo",
        "wx.getAppBaseInfo",
        "wx.getBatteryInfoSync",
    ] {
        assert_eq!(capabilities[name], CapabilitySupport::Unsupported, "{name}");
        assert_eq!(
            session
                .provider
                .call(name, &Map::new(), &context)
                .unwrap_err()
                .code,
            ProviderErrorCode::Unsupported,
            "{name}"
        );
        assert!(matches!(
            session.provider.start_call(name, &Map::new(), &context),
            ProviderStart::Ready(Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                ..
            }))
        ));
    }
}

#[test]
fn delegated_geometry_rejects_missing_and_malformed_observations() {
    let mut session = delegated_session(None, &[]);
    let mut malformed = host(metrics(375, 667));
    malformed.display_metrics.as_mut().unwrap().pixel_ratio = f64::NAN;
    malformed.menu_button_rect.as_mut().unwrap().width = 0.0;
    for (host, expected) in [
        (
            HostMetadata {
                window_width: 375,
                window_height: 667,
                ..Default::default()
            },
            ProviderErrorCode::Unsupported,
        ),
        (malformed, ProviderErrorCode::InvalidRequest),
    ] {
        let context = ProviderContext {
            host,
            ..Default::default()
        };
        let capabilities = session.provider.capabilities_for_host(&context.host);
        for name in HOST_GEOMETRY_APIS {
            assert_eq!(capabilities[name], CapabilitySupport::Unsupported, "{name}");
            assert_eq!(
                session
                    .provider
                    .call(name, &Map::new(), &context)
                    .unwrap_err()
                    .code,
                expected,
                "{name}"
            );
            match session.provider.start_call(name, &Map::new(), &context) {
                ProviderStart::Ready(Err(error)) => assert_eq!(error.code, expected, "{name}"),
                other => panic!("unobserved or malformed {name} was accepted: {other:?}"),
            }
        }
    }
}

#[test]
fn delegated_geometry_preserves_real_fallback_fields_and_registered_async_precedence() {
    let fallback = StrictHostProvider::from_snapshots(BTreeMap::from([(
        "wx.getSystemInfoSync".into(),
        json!({"brand":"real-brand","system":"real-os","windowWidth":999}),
    )]))
    .unwrap();
    let mut session = delegated_session(Some(Box::new(fallback)), &[]);
    let context = ProviderContext {
        host: host(metrics(375, 667)),
        ..Default::default()
    };
    for name in [
        "wx.getSystemInfoSync",
        "wx.getSystemInfo",
        "wx.getSystemInfoAsync",
    ] {
        let value = session.provider.call(name, &Map::new(), &context).unwrap();
        assert_eq!(value["brand"], "real-brand");
        assert_eq!(value["system"], "real-os");
        assert_eq!(value["windowWidth"], 375);
        assert_eq!(value["host"], json!({"appId":"observed-host"}));
        assert_eq!(
            session.provider.start_call(name, &Map::new(), &context),
            ProviderStart::Ready(Ok(value))
        );
    }

    let mut registered = delegated_session(None, &["wx.getSystemInfo", "wx.getSystemInfoAsync"]);
    for name in ["wx.getSystemInfo", "wx.getSystemInfoAsync"] {
        assert_eq!(
            registered.provider.capabilities_for_host(&context.host)[name],
            CapabilitySupport::Partial
        );
        assert_eq!(
            registered.provider.start_call(name, &Map::new(), &context),
            ProviderStart::Pending
        );
        let error = registered
            .provider
            .call(name, &Map::new(), &context)
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::Unsupported);
        assert!(error
            .message
            .contains("requires asynchronous native completion"));
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native {
    use super::*;
    use crate::{HostAccount, HostServicesConfig, Session, SessionConfig, TrustedApplication};
    use container_bridge::{op, BridgeEnvelope};
    use container_core::{CallTarget, EngineKind};
    use container_ir::{
        AppInfo, CompilerInfo, ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route,
        RouteKind,
    };
    use container_render_skia::Rect;

    const ID: &str = "production-geometry";
    const SOURCE: &[u8] = br#"
      App({});
      const trace = [];
      function read() {
        return {window:wx.getWindowInfo(),system:wx.getSystemInfoSync(),setting:wx.getSystemSetting(),
          menu:wx.getMenuButtonBoundingClientRect(),deviceSupported:wx.canIUse('getDeviceInfo')};
      }
      globalThis.__production_geometry = read;
      globalThis.__production_identity = function(){return weappContainer.identity.getState();};
      globalThis.__production_before_layout = function() {
        function snapshot(name){try{return wx[name]();}catch(_){return null;}}
        return {windowSupported:wx.canIUse('getWindowInfo'),menuSupported:wx.canIUse('getMenuButtonBoundingClientRect'),
          window:snapshot('getWindowInfo'),system:snapshot('getSystemInfoSync'),setting:snapshot('getSystemSetting')};
      };
      globalThis.__production_trace = function() {return {events:trace.slice()};};
      globalThis.__production_async_value = null;
      globalThis.__production_read_async_value = function(){return globalThis.__production_async_value;};
      globalThis.__production_async = function(name) {
        wx[name || 'getSystemInfo']({success:function(value){globalThis.__production_async_value=value;trace.push(['success',value.windowWidth]);},
          complete:function(){trace.push(['complete']);}}).then(function(value){trace.push(['promise',value.windowWidth]);});
        trace.push(['sync']);
      };
      globalThis.__production_async_failure = function() {
        wx.getSystemInfoAsync({fail:function(error){trace.push(['fail',error.code]);},
          complete:function(){trace.push(['complete']);}}).catch(function(error){trace.push(['reject',error.code]);});
        trace.push(['sync']);
      };
      globalThis.__production_hook = null;
      Page({onResize:function(){globalThis.__production_hook=read();}});
      globalThis.__production_read_hook=function(){return globalThis.__production_hook;};
    "#;

    fn envelope(operation: &str, payload: Value) -> BridgeEnvelope {
        BridgeEnvelope::request(ID, format!("request-{operation}"), operation, payload)
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum GeometryProvider {
        Strict,
        SnapshotServices,
        ObservedServices,
    }

    fn fixture(engine: EngineKind, provider: GeometryProvider, observed: bool) -> Session {
        fixture_with_handler(engine, provider, observed, false)
    }

    fn fixture_with_handler(
        engine: EngineKind,
        provider: GeometryProvider,
        observed: bool,
        native_async: bool,
    ) -> Session {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "production-geometry".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: "route:pages/home/index".into(),
                path: "pages/home/index".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "app.js".into(),
            }],
            modules: vec![Module {
                id: "module:app.js".into(),
                sha256: container_ir::hex_digest(SOURCE),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            }],
            ..Default::default()
        };
        for name in HOST_GEOMETRY_APIS.into_iter().chain(["wx.getDeviceInfo"]) {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        manifest.refresh_integrity().unwrap();
        let pack_root = manifest.integrity.root.clone();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: ID.into(),
                engine,
                host: if observed {
                    host(metrics(375, 667))
                } else {
                    HostMetadata::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        if provider != GeometryProvider::ObservedServices {
            session.set_provider(Box::new(StrictHostProvider::default()));
        }
        if provider != GeometryProvider::Strict {
            let sync_values = if provider == GeometryProvider::SnapshotServices {
                BTreeMap::from([
                    (
                        "wx.getSystemInfoSync".into(),
                        json!({"brand":"measured-brand","windowWidth":999,"pixelRatio":1,"safeArea":{"left":0,"right":999,"top":0,"bottom":999,"width":999,"height":999}}),
                    ),
                    (
                        "wx.getWindowInfo".into(),
                        json!({"windowWidth":999,"pixelRatio":1}),
                    ),
                    (
                        "wx.getSystemSetting".into(),
                        json!({"bluetoothEnabled":false,"deviceOrientation":"landscape"}),
                    ),
                    (
                        "weappContainer.identity.getState".into(),
                        json!({"appLoggedIn":true,"userInfo":{"nickName":"Alice"}}),
                    ),
                ])
            } else {
                BTreeMap::new()
            };
            session
                .configure_host_services(HostServicesConfig {
                    application: TrustedApplication {
                        host_app_id: "host".into(),
                        tenant_id: "tenant".into(),
                        publisher_id: "publisher".into(),
                        app_id: "mini".into(),
                        environment: "release".into(),
                        version: "1".into(),
                        pack_root,
                    },
                    account: HostAccount {
                        principal_id: Some("user".into()),
                        epoch: 1,
                    },
                    apis: if native_async {
                        vec!["wx.getSystemInfo".into(), "wx.getSystemInfoAsync".into()]
                    } else {
                        vec![]
                    },
                    sync_values,
                })
                .unwrap();
        }
        let init = session.dispatch(envelope(
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":String::from_utf8_lossy(SOURCE)}]}),
        ));
        assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
        let pushed = session.dispatch(envelope(op::PAGE_PUSH, json!({"path":"pages/home/index"})));
        assert_eq!(pushed.messages[0].payload["ok"], true, "{pushed:?}");
        session
    }

    fn read(session: &mut Session, name: &str) -> Value {
        session
            .call_engine(CallTarget::Global { name: name.into() }, vec![])
            .unwrap()
            .remove(0)
    }

    fn real_geometry_contract(engine: EngineKind) {
        for provider in [
            GeometryProvider::Strict,
            GeometryProvider::SnapshotServices,
            GeometryProvider::ObservedServices,
        ] {
            let delegated = provider == GeometryProvider::SnapshotServices;
            let mut unobserved = fixture(engine, provider, false);
            let before = read(&mut unobserved, "__production_before_layout");
            assert_eq!(before["windowSupported"], false);
            assert_eq!(before["menuSupported"], false);
            assert_eq!(before["window"], Value::Null);
            if !delegated {
                read(&mut unobserved, "__production_async_failure");
                let mut effects = Vec::new();
                unobserved.append_engine_effects(&mut effects).unwrap();
                assert_eq!(
                    read(&mut unobserved, "__production_trace")["events"],
                    json!([
                        ["sync"],
                        ["fail", "ERR_UNSUPPORTED_CAPABILITY"],
                        ["complete"],
                        ["reject", "ERR_UNSUPPORTED_CAPABILITY"]
                    ])
                );
            }
            if delegated {
                assert_eq!(before["system"]["brand"], "measured-brand");
                assert!(before["system"].get("windowWidth").is_none());
                assert!(before["system"].get("pixelRatio").is_none());
                assert_eq!(before["setting"], json!({"bluetoothEnabled":false}));
            } else {
                assert_eq!(before["system"], Value::Null);
                assert_eq!(before["setting"], Value::Null);
            }
            unobserved
                .notify_host_layout(metrics(375, 667), menu())
                .unwrap();
            assert_eq!(
                read(&mut unobserved, "__production_geometry")["window"]["pixelRatio"],
                2.75
            );

            let mut session = fixture(engine, provider, true);
            assert_eq!(session.skia_backend.renderer.render_scale(), 2.75);
            let target = session
                .skia_backend
                .renderer
                .validate_render_target(
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        width: 375.0,
                        height: 667.0,
                    },
                    2.75,
                )
                .unwrap();
            assert_eq!((target.width, target.height), (1032, 1835));
            for (scale, expected) in [(1.0, (375, 667)), (2.0, (750, 1334)), (3.0, (1125, 2001))] {
                let target = session
                    .skia_backend
                    .renderer
                    .validate_render_target(
                        Rect {
                            x: 0.0,
                            y: 0.0,
                            width: 375.0,
                            height: 667.0,
                        },
                        scale,
                    )
                    .unwrap();
                assert_eq!((target.width, target.height), expected);
            }
            let first = read(&mut session, "__production_geometry");
            assert_eq!(first["window"]["windowWidth"], 375);
            assert_eq!(first["system"]["windowWidth"], 375);
            assert_eq!(first["system"]["pixelRatio"], 2.75);
            assert_eq!(first["deviceSupported"], false);
            assert!(first["system"].get("model").is_none());
            assert!(first["system"].get("version").is_none());
            if provider == GeometryProvider::ObservedServices {
                assert_eq!(first["system"]["host"], json!({"appId":"host"}));
            }
            if delegated {
                assert_eq!(first["system"]["brand"], "measured-brand");
                session
                    .update_host_service_snapshots(BTreeMap::from([
                        (
                            "wx.getSystemInfoSync".into(),
                            json!({"brand":"updated-brand","windowWidth":123,"pixelRatio":1}),
                        ),
                        (
                            "weappContainer.identity.getState".into(),
                            json!({"appLoggedIn":false}),
                        ),
                    ]))
                    .unwrap();
                let updated = read(&mut session, "__production_geometry");
                assert_eq!(updated["system"]["brand"], "updated-brand");
                assert_eq!(updated["system"]["windowWidth"], 375);
                assert_eq!(
                    read(&mut session, "__production_identity"),
                    json!({"appLoggedIn":false})
                );
            } else {
                assert!(first["system"].get("brand").is_none());
            }
            session
                .notify_host_layout(metrics(667, 375), menu())
                .unwrap();
            let current = read(&mut session, "__production_geometry");
            assert_eq!(current["window"]["windowWidth"], 667);
            assert_eq!(current["system"]["windowWidth"], 667);
            assert_eq!(current["setting"]["deviceOrientation"], "landscape");
            assert_eq!(read(&mut session, "__production_read_hook"), current);
            let mut invalid = metrics(123, 456);
            invalid.display.pixel_ratio = f64::NAN;
            assert!(session.notify_window_metrics(invalid).is_err());
            assert_eq!(read(&mut session, "__production_geometry"), current);
            let mut display_only = metrics(667, 375);
            display_only.display.pixel_ratio = 1.25;
            display_only.display.safe_area = None;
            let mut over_budget = display_only.clone();
            over_budget.display.pixel_ratio = 100.0;
            assert!(session.notify_window_metrics(over_budget).is_err());
            assert_eq!(session.skia_backend.renderer.render_scale(), 2.75);
            session.notify_window_metrics(display_only).unwrap();
            assert_eq!(session.skia_backend.renderer.render_scale(), 1.25);
            let changed = read(&mut session, "__production_geometry");
            assert_eq!(changed["window"]["pixelRatio"], 1.25);
            assert!(changed["window"].get("safeArea").is_none());
            assert!(changed["system"].get("safeArea").is_none());
            assert_eq!(read(&mut session, "__production_read_hook"), current);
            read(&mut session, "__production_async");
            let mut effects = Vec::new();
            session.append_engine_effects(&mut effects).unwrap();
            assert_eq!(
                read(&mut session, "__production_trace")["events"],
                json!([["sync"], ["success", 667], ["complete"], ["promise", 667]])
            );
            session
                .call_engine(
                    CallTarget::Global {
                        name: "__production_async".into(),
                    },
                    vec![json!("getSystemInfoAsync")],
                )
                .unwrap();
            session.append_engine_effects(&mut effects).unwrap();
            assert_eq!(
                read(&mut session, "__production_read_async_value")["errMsg"],
                "getSystemInfoAsync:ok"
            );
            assert_eq!(
                read(&mut session, "__production_trace")["events"],
                json!([
                    ["sync"],
                    ["success", 667],
                    ["complete"],
                    ["promise", 667],
                    ["sync"],
                    ["success", 667],
                    ["complete"],
                    ["promise", 667]
                ])
            );
            assert!(
                session.take_host_requests().is_empty(),
                "observed geometry must complete without scheduling native work"
            );
        }

        for provider in [
            GeometryProvider::SnapshotServices,
            GeometryProvider::ObservedServices,
        ] {
            for name in ["getSystemInfo", "getSystemInfoAsync"] {
                let mut session = fixture_with_handler(engine, provider, true, true);
                session
                    .call_engine(
                        CallTarget::Global {
                            name: "__production_async".into(),
                        },
                        vec![json!(name)],
                    )
                    .unwrap();
                let mut effects = Vec::new();
                session.append_engine_effects(&mut effects).unwrap();
                let requests = session.take_host_requests();
                let call_id = requests
                    .iter()
                    .find_map(|request| match request {
                        crate::HostRequest::Call {
                            call_id, method, ..
                        } if method == &format!("wx.{name}") => Some(call_id.clone()),
                        _ => None,
                    })
                    .expect("explicit asynchronous handler must traverse the native outbox");
                assert_eq!(
                    read(&mut session, "__production_trace")["events"],
                    json!([["sync"]]),
                    "accepted geometry must not bypass a registered asynchronous handler"
                );
                session
                    .notify_host_layout(metrics(667, 375), menu())
                    .unwrap();
                let completion = json!({
                    "brand":"native-result","windowWidth":999,"pixelRatio":1,"host":"malformed-kind"
                });
                session
                    .complete_host_api_call(&call_id, Ok(completion))
                    .unwrap();
                assert_eq!(
                    read(&mut session, "__production_trace")["events"],
                    json!([["sync"], ["success", 667], ["complete"], ["promise", 667]])
                );
                let result = read(&mut session, "__production_read_async_value");
                assert_eq!(result["windowWidth"], 667);
                assert_eq!(result["pixelRatio"], 2.75);
                assert_eq!(result["brand"], "native-result");
                assert_eq!(result["host"], json!({"appId":"host"}));
                assert_eq!(result["errMsg"], format!("{name}:ok"));
                assert!(session
                    .complete_host_api_call(&call_id, Ok(json!({"windowWidth":123})))
                    .unwrap()
                    .messages
                    .is_empty());
            }
        }
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_production_geometry_contract() {
        real_geometry_contract(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_production_geometry_contract() {
        real_geometry_contract(EngineKind::V8);
    }
}
