use container_ir::ContainerManifestV1;
use container_runtime::{
    HostDeviceOrientation, HostDisplayMetrics, HostMetadata, HostSafeArea, HostWindowMetrics,
    Session, SessionConfig, SessionError,
};
use serde_json::json;

fn metrics() -> HostWindowMetrics {
    HostWindowMetrics {
        window_width: 360,
        window_height: 640,
        display: HostDisplayMetrics {
            pixel_ratio: 2.75,
            screen_width: 393,
            screen_height: 852,
            status_bar_height: 24.5,
            screen_top: 32.5,
            safe_area: Some(HostSafeArea {
                left: 1.5,
                right: 391.5,
                top: 24.5,
                bottom: 818.0,
                width: 390.0,
                height: 793.5,
            }),
            host_layout: None,
            device_orientation: HostDeviceOrientation::Portrait,
        },
    }
}

#[test]
fn flat_snapshot_and_optional_display_have_one_viewport_authority() {
    let snapshot = metrics();
    let value = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(value["windowWidth"], 360);
    assert_eq!(value["pixelRatio"], 2.75);
    assert!(value.get("display").is_none());
    assert!(value.get("windowTop").is_none());
    assert_eq!(
        serde_json::from_value::<HostWindowMetrics>(value.clone()).unwrap(),
        snapshot
    );
    let mut without_safe_area = value.clone();
    without_safe_area
        .as_object_mut()
        .unwrap()
        .remove("safeArea");
    assert!(
        serde_json::from_value::<HostWindowMetrics>(without_safe_area)
            .unwrap()
            .display
            .safe_area
            .is_none()
    );
    let mut invalid = value.clone();
    invalid["windowTop"] = json!(0);
    assert!(serde_json::from_value::<HostWindowMetrics>(invalid).is_err());
    let mut invalid = value;
    invalid["deviceOrientation"] = json!("diagonal");
    assert!(serde_json::from_value::<HostWindowMetrics>(invalid).is_err());
    let mut display = serde_json::to_value(snapshot.display).unwrap();
    display["windowWidth"] = json!(999);
    assert!(serde_json::from_value::<HostDisplayMetrics>(display).is_err());
    assert!(serde_json::to_value(HostMetadata::default())
        .unwrap()
        .get("displayMetrics")
        .is_none());
}

#[test]
fn portrait_safe_area_preserves_fractional_edges_and_screen_rounding_contract() {
    let mut snapshot = metrics();
    // Absolute coordinates are observations, not evidence of a zero origin.
    // Translating both edges must preserve the rectangle without rebasing it.
    let safe = snapshot.display.safe_area.as_mut().unwrap();
    safe.left -= 500.0;
    safe.right -= 500.0;
    safe.top -= 900.0;
    safe.bottom -= 900.0;
    snapshot.validate().unwrap();
    let value = serde_json::to_value(&snapshot).unwrap();
    let restored: HostWindowMetrics = serde_json::from_value(value).unwrap();
    assert_eq!(restored, snapshot);
    assert_eq!(restored.display.safe_area.as_ref().unwrap().left, -498.5);
    assert_eq!(restored.display.safe_area.as_ref().unwrap().top, -875.5);
    snapshot.display.screen_width = 852;
    snapshot.display.screen_height = 393;
    snapshot.display.device_orientation = HostDeviceOrientation::Landscape;
    snapshot.display.screen_top = -12.5;
    snapshot.validate().unwrap();
    let safe = snapshot.display.safe_area.as_mut().unwrap();
    safe.right = safe.left + 852.49;
    safe.width = safe.right - safe.left;
    snapshot.validate().unwrap();
    let safe = snapshot.display.safe_area.as_mut().unwrap();
    safe.right = safe.left + 852.51;
    safe.width = safe.right - safe.left;
    assert!(
        snapshot.validate().is_err(),
        "fractional edges may exceed a rounded screen by at most half a logical pixel"
    );
}

#[test]
fn invalid_host_snapshots_fail_before_session_creation() {
    for mutate in [
        |value: &mut HostWindowMetrics| value.window_width = 0,
        |value: &mut HostWindowMetrics| value.display.pixel_ratio = f64::NAN,
        |value: &mut HostWindowMetrics| value.display.pixel_ratio = 0.0,
        |value: &mut HostWindowMetrics| value.display.screen_height = 0,
        |value: &mut HostWindowMetrics| value.display.screen_top = f64::INFINITY,
        |value: &mut HostWindowMetrics| value.display.status_bar_height = -1.0,
        |value: &mut HostWindowMetrics| value.display.safe_area.as_mut().unwrap().width += 1.0,
        |value: &mut HostWindowMetrics| value.display.safe_area.as_mut().unwrap().top = -1.0,
        |value: &mut HostWindowMetrics| value.display.safe_area.as_mut().unwrap().bottom = f64::NAN,
    ] {
        let mut snapshot = metrics();
        mutate(&mut snapshot);
        assert!(snapshot.validate().is_err());
        let config = SessionConfig {
            host: HostMetadata {
                window_width: snapshot.window_width,
                window_height: snapshot.window_height,
                display_metrics: Some(snapshot.display),
                ..HostMetadata::default()
            },
            ..SessionConfig::default()
        };
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "host-window-metrics-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        assert!(matches!(
            Session::new(manifest, config),
            Err(SessionError::Config(_))
        ));
    }
}

#[test]
fn provider_overrides_only_with_an_observed_host_display() {
    use container_runtime::{
        HostApiProvider, ProviderContext, SandboxProvider, SystemInfoSnapshot,
        SystemSettingSnapshot,
    };
    let provider = SandboxProvider::new()
        .with_system_info(SystemInfoSnapshot {
            pixel_ratio: 4.0,
            status_bar_height: 19,
            device_orientation: "landscape".into(),
            ..SystemInfoSnapshot::default()
        })
        .unwrap()
        .with_system_setting(SystemSettingSnapshot {
            device_orientation: "landscape".into(),
            ..SystemSettingSnapshot::default()
        });
    let mut context = ProviderContext {
        host: HostMetadata {
            window_width: 360,
            window_height: 640,
            ..HostMetadata::default()
        },
        ..ProviderContext::default()
    };
    let mut legacy = provider.clone();
    let value = legacy
        .call("wx.getWindowInfo", &Default::default(), &context)
        .unwrap();
    assert_eq!(value["pixelRatio"], 4);
    assert_eq!(value["screenHeight"], 640);
    assert_eq!(value["safeArea"]["height"], 640);
    assert_eq!(value["statusBarHeight"], 19);
    assert!(value.get("windowTop").is_none());
    context.host.display_metrics = Some(metrics().display);
    let mut observed = provider;
    for api in [
        "wx.getSystemInfoSync",
        "wx.getSystemInfo",
        "wx.getWindowInfo",
    ] {
        let value = observed.call(api, &Default::default(), &context).unwrap();
        assert_eq!(value["pixelRatio"], 2.75);
        assert_eq!(value["screenWidth"], 393);
        assert_eq!(value["screenHeight"], 852);
        assert_eq!(value["windowWidth"], 360);
        assert_eq!(value["statusBarHeight"], 24.5);
        if api == "wx.getWindowInfo" {
            assert_eq!(value["screenTop"], 32.5);
        } else {
            assert!(value.get("screenTop").is_none());
        }
        assert_eq!(value["safeArea"]["left"], 1.5);
        assert!(value.get("windowTop").is_none());
    }
    assert!(observed
        .call("wx.getDeviceInfo", &Default::default(), &context)
        .unwrap()
        .get("pixelRatio")
        .is_none());
    assert_eq!(
        observed
            .call("wx.getSystemSetting", &Default::default(), &context)
            .unwrap()["deviceOrientation"],
        "portrait"
    );
    context.host.display_metrics.as_mut().unwrap().safe_area = None;
    for api in [
        "wx.getSystemInfoSync",
        "wx.getSystemInfo",
        "wx.getWindowInfo",
    ] {
        assert!(observed
            .call(api, &Default::default(), &context)
            .unwrap()
            .get("safeArea")
            .is_none());
    }
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native {
    use super::*;
    use container_bridge::{op, BridgeEnvelope};
    use container_core::EngineKind;
    use container_ir::{
        AppInfo, CompilerInfo, Module, ModuleFormat, ModuleScope, Route, RouteKind,
    };
    use serde_json::Value;

    const SOURCE: &str = r#"
        function snapshot() { return {window:wx.getWindowInfo(),system:wx.getSystemInfoSync(),device:wx.getDeviceInfo(),setting:wx.getSystemSetting()}; }
        var initial = snapshot();
        App({onShow:function(){globalThis.shows=(globalThis.shows||0)+1;}});
        Page({data:{initial:initial,calls:0},onResize:function(event){this.setData({calls:this.data.calls+1,observed:snapshot(),resizeEvent:event});}});
        module.exports.read=function(){return {values:snapshot(),shows:globalThis.shows};};
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
        BridgeEnvelope::request("host-metrics", operation, operation, payload)
    }

    fn start(engine: EngineKind) -> Session {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "host-window-metrics-fixture".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            modules: vec![Module {
                id: "module:app.js".into(),
                sha256: container_ir::hex_digest(SOURCE.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            }],
            routes: vec![Route {
                id: "route:home".into(),
                path: "pages/home/index".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "app.js".into(),
            }],
            ..ContainerManifestV1::default()
        };
        for name in [
            "wx.getWindowInfo",
            "wx.getSystemInfoSync",
            "wx.getSystemInfo",
            "wx.getDeviceInfo",
            "wx.getSystemSetting",
        ] {
            manifest
                .capabilities
                .insert(name.into(), container_ir::CapabilitySupport::Partial);
        }
        manifest.refresh_integrity().unwrap();
        let snapshot = metrics();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: "host-metrics".into(),
                engine,
                host: HostMetadata {
                    window_width: snapshot.window_width,
                    window_height: snapshot.window_height,
                    display_metrics: Some(snapshot.display),
                    ..HostMetadata::default()
                },
                ..SessionConfig::default()
            },
        )
        .unwrap();
        for (operation, payload) in [
            (
                op::APP_INIT,
                json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
            ),
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/home/index"})),
        ] {
            let result = session.dispatch(request(operation, payload));
            assert_eq!(
                result.messages[0].payload["ok"], true,
                "{engine:?} {result:?}"
            );
        }
        session
    }

    fn read(session: &mut Session) -> Value {
        let result = session.dispatch(request(
            op::MODULE_CALL,
            json!({"moduleId":"module:app.js","export":"read","args":[]}),
        ));
        assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
        result.messages[0].payload["result"][0].clone()
    }

    #[test]
    fn both_engines_observe_initial_module_scope_and_display_only_updates() {
        for engine in engines() {
            let mut session = start(engine);
            let initial = session.app_service().pages().current().unwrap().data["initial"].clone();
            assert_eq!(initial["window"]["pixelRatio"], 2.75);
            assert_eq!(initial["window"]["screenHeight"], 852);
            assert_eq!(initial["window"]["windowHeight"], 640);
            assert_eq!(initial["window"]["safeArea"]["top"], 24.5);
            let mut updated = metrics();
            updated.display.pixel_ratio = 3.25;
            updated.display.screen_top = -10.5;
            updated.display.safe_area = None;
            updated.display.device_orientation = HostDeviceOrientation::Landscape;
            let batch = session.notify_window_metrics(updated.clone()).unwrap();
            assert_eq!(batch.messages[0].payload["type"], "host.windowMetrics");
            let observed = read(&mut session);
            for key in ["window", "system"] {
                assert_eq!(observed["values"][key]["pixelRatio"], 3.25);
            }
            assert!(observed["values"]["window"].get("safeArea").is_none());
            assert_eq!(observed["values"]["window"]["screenTop"], -10.5);
            assert_eq!(
                observed["values"]["setting"]["deviceOrientation"],
                "landscape"
            );
            assert_eq!(observed["shows"], 1);
            assert_eq!(
                session.app_service().pages().current().unwrap().data["calls"],
                0
            );
            assert!(session
                .notify_window_metrics(updated)
                .unwrap()
                .messages
                .is_empty());
        }
    }

    #[test]
    fn both_engines_refresh_complete_snapshot_before_resize_and_keep_legacy_density() {
        for engine in engines() {
            let mut session = start(engine);
            let mut updated = metrics();
            updated.window_width = 700;
            updated.window_height = 300;
            updated.display.pixel_ratio = 3.5;
            updated.display.screen_width = 852;
            updated.display.screen_height = 393;
            updated.display.screen_top = 10.25;
            updated.display.device_orientation = HostDeviceOrientation::Landscape;
            let batch = session.notify_window_metrics(updated.clone()).unwrap();
            assert!(
                !batch.messages.iter().any(|m| m.op == op::ERROR),
                "{engine:?} {batch:?}"
            );
            let data = &session.app_service().pages().current().unwrap().data;
            assert_eq!(data["calls"], 1);
            assert_eq!(data["observed"]["window"]["pixelRatio"], 3.5);
            assert_eq!(data["observed"]["window"]["windowWidth"], 700);
            assert_eq!(data["observed"]["window"]["screenHeight"], 393);
            assert_eq!(data["observed"]["window"]["screenTop"], 10.25);
            assert_eq!(
                data["observed"]["setting"]["deviceOrientation"],
                "landscape"
            );
            assert_eq!(
                data["resizeEvent"],
                json!({"size":{"windowWidth":700,"windowHeight":300},"deviceOrientation":"landscape"})
            );
            session.notify_viewport_resize(680, 290).unwrap();
            assert_eq!(
                session.config().host.display_metrics.as_ref().unwrap(),
                &updated.display
            );
            assert_eq!(read(&mut session)["values"]["window"]["pixelRatio"], 3.5);
            assert_eq!(
                session.app_service().pages().current().unwrap().data["calls"],
                2
            );
        }
    }

    #[test]
    fn both_engines_reject_invalid_update_without_state_or_lifecycle_mutation() {
        for engine in engines() {
            let mut session = start(engine);
            let previous_config = session.config().clone();
            let previous_data = session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data
                .clone();
            let previous_values = read(&mut session);
            let mut invalid = metrics();
            invalid.window_width = 500;
            invalid.display.safe_area.as_mut().unwrap().right = 9999.0;
            assert!(session.notify_window_metrics(invalid).is_err());
            assert_eq!(session.config(), &previous_config);
            assert_eq!(
                session.app_service().pages().current().unwrap().data,
                previous_data
            );
            assert_eq!(read(&mut session), previous_values);
            assert!(session
                .notify_window_metrics(metrics())
                .unwrap()
                .messages
                .is_empty());
        }
    }
}

#[test]
fn local_host_layout_is_versioned_bounded_and_independent_from_fixed_safe_area() {
    let mut value = serde_json::to_value(metrics()).unwrap();
    value["hostLayout"] = json!({"version":1,"safeInsets":{"top":0,"right":84,"bottom":34,"left":0},
        "verticalBarEdge":"right","reservedRegions":[{"id":"camera","kind":"occlusion","x":276,"y":0,"width":84,"height":56}]});
    let snapshot: HostWindowMetrics = serde_json::from_value(value.clone()).unwrap();
    snapshot.validate().unwrap();
    assert_eq!(
        serde_json::to_value(&snapshot).unwrap()["safeArea"],
        value["safeArea"]
    );
    for mutate in [
        |v: &mut serde_json::Value| v["version"] = json!(2),
        |v: &mut serde_json::Value| v["safeInsets"]["left"] = json!(-1),
        |v: &mut serde_json::Value| v["safeInsets"]["right"] = json!(361),
        |v: &mut serde_json::Value| v["reservedRegions"][0]["width"] = json!(85),
        |v: &mut serde_json::Value| v["reservedRegions"][0]["id"] = json!(""),
        |v: &mut serde_json::Value| {
            let region = v["reservedRegions"][0].clone();
            v["reservedRegions"].as_array_mut().unwrap().push(region);
        },
    ] {
        let mut invalid = value.clone();
        mutate(&mut invalid["hostLayout"]);
        let candidate: HostWindowMetrics = serde_json::from_value(invalid).unwrap();
        assert!(candidate.validate().is_err());
    }
    for (key, data) in [
        ("verticalBarEdge", json!("trailing")),
        ("extra", json!(true)),
    ] {
        let mut invalid = value.clone();
        invalid["hostLayout"][key] = data;
        assert!(serde_json::from_value::<HostWindowMetrics>(invalid).is_err());
    }
    let mut invalid = value.clone();
    invalid["hostLayout"]["reservedRegions"][0]["margins"] = json!({});
    assert!(serde_json::from_value::<HostWindowMetrics>(invalid).is_err());
    value.as_object_mut().unwrap().remove("hostLayout");
    assert!(serde_json::from_value::<HostWindowMetrics>(value)
        .unwrap()
        .display
        .host_layout
        .is_none());
}
