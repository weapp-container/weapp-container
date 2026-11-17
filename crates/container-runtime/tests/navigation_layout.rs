//! Local two-engine layout transaction contracts; not official WeChat evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, AppInfo, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    Route, RouteKind,
};
use container_runtime::{
    HostDeviceOrientation, HostDisplayMetrics, HostWindowMetrics, MenuButtonRect, Session,
    SessionConfig,
};
use serde_json::{json, Value};
const SOURCE: &str = r#"
App({trace:[]});
globalThis.record=function(phase) {getApp().trace.push({phase:phase,window:wx.getWindowInfo(),menu:wx.getMenuButtonBoundingClientRect(),pages:getCurrentPages().map(p=>p.route)});}


exports.inspect=()=>({trace:getApp().trace});
exports.navigate=()=>{const result=wx.navigateTo({url:'/detail',success(){record('success');},complete(){record('complete');}});record('returned');result.then(()=>record('resolved'));};
exports.back=()=>wx.navigateBack({});
exports.startClock=()=>{getApp().ticks=0;getApp().preserve=true;setTimeout(()=>{getApp().ticks++;wx.setStorageSync('pending','timer');},0);};
exports.live=()=>({ticks:getApp().ticks,pending:wx.getStorageSync('pending'),departure:wx.getStorageSync('departure')});
exports.startChannel=()=>{
  const app=getApp();app.channelMode=true;app.channelTrace=[];
  globalThis.__container_bind_event_channel=()=>{throw Error('guest fake channel binder');};
  let callbackChannel;
  wx.navigateTo({url:'/detail',events:{ready(value){app.channelTrace.push('ready:'+value);}},
    success(result){callbackChannel=result.eventChannel;app.channel=callbackChannel;app.channelTrace.push('success');callbackChannel.on('early',value=>app.channelTrace.push('early:'+value));callbackChannel.emit('answer',5);},
    complete(){app.channelTrace.push('complete');}
  }).then(result=>app.channelTrace.push('promise:'+(result.eventChannel===callbackChannel)),error=>app.channelTrace.push('error:'+error.code));
  app.channelTrace.push('returned');
};
exports.inspectChannel=()=>({trace:getApp().channelTrace,same:getApp().channel===getApp().targetChannel});
exports.clear=()=>{getApp().trace=[];};
exports.invoke=(method,options)=>{wx[method](options).catch(()=>{});};
exports.failDeparture=()=>{getApp().failDeparture=true;};
exports.failDestination=()=>{getApp().failDestination=true;};
exports.breakMirror=()=>{globalThis.__container_set_current_pages=()=>{throw Error('public setter must not run');};Object.create=()=>{throw Error('replaced intrinsic');};};
"#;
const HOME:&str="Page({data:{count:7},onLoad(){record('home-load');},onHide(){record('home-hide');if(getApp().preserve) wx.setStorageSync('departure','hook');if(getApp().failDeparture) throw Error('departure-fault');},onShow(){record('home-show');},onResize(){record('resize');}});";
const DETAIL:&str="Page({data:{count:9},onLoad(){record('detail-load');if(getApp().channelMode){const app=getApp(),channel=this.getOpenerEventChannel();app.targetChannel=channel;app.channelTrace.push('load');channel.emit('ready',3);channel.emit('early',4);channel.on('answer',value=>app.channelTrace.push('answer:'+value));}if(getApp().failDestination) throw Error('destination-fault');},onUnload(){record('detail-unload');},onShow(){record('detail-show');}});";
fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}
fn dispatch(session: &mut Session, operation: &str, payload: Value) {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "test",
        operation,
        payload,
    ));
    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
    assert!(
        !batch.messages.iter().any(|message| message.op == op::ERROR),
        "{batch:?}"
    );
}
fn call(session: &mut Session, name: &str) -> Value {
    let batch = session.dispatch(BridgeEnvelope::request(
        "session-1",
        "call",
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":name,"args":[]}),
    ));
    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
    assert!(
        !batch.messages.iter().any(|message| message.op == op::ERROR),
        "{batch:?}"
    );
    {
        let result = batch.messages[0].payload["result"][0].clone();
        if name == "inspect" {
            result["trace"].clone()
        } else {
            result
        }
    }
}
fn fixture(engine: EngineKind) -> Session {
    let mut manifest = ContainerManifestV1 {
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "app.js".into(),
        },
        ..Default::default()
    };
    for path in ["home", "detail", "tab"] {
        manifest.routes.push(Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: if path == "tab" {
                RouteKind::Tab
            } else {
                RouteKind::Page
            },
            config: None,
            entry_module: format!("{path}.js"),
        });
    }
    manifest.modules.push(Module {
        id: "module:app.js".into(),
        sha256: hex_digest(SOURCE.as_bytes()),
        format: ModuleFormat::Commonjs,
        scope: ModuleScope::App,
        dependencies: vec![],
    });
    for (name, source) in [
        ("home", HOME),
        ("detail", DETAIL),
        (
            "tab",
            "Page({data:{cached:1},onLoad(){record('tab-load');},onShow(){record('tab-show');}});",
        ),
    ] {
        manifest.modules.push(Module {
            id: format!("module:{name}.js"),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::Page,
            dependencies: vec![],
        });
    }
    for name in [
        "wx.getWindowInfo",
        "wx.getMenuButtonBoundingClientRect",
        "getCurrentPages",
        "wx.navigateTo",
        "wx.navigateBack",
        "wx.redirectTo",
        "wx.reLaunch",
        "wx.switchTab",
        "wx.setStorageSync",
        "wx.getStorageSync",
        "setTimeout",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    manifest.compiler.commit = "navigation-layout-contract".into();
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: "session-1".into(),
            engine,
            ..Default::default()
        },
    )
    .unwrap();
    dispatch(
        &mut session,
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":SOURCE},{"id":"module:home.js","source":HOME},{"id":"module:detail.js","source":DETAIL},{"id":"module:tab.js","source":"Page({data:{cached:1},onLoad(){record('tab-load');},onShow(){record('tab-show');}});"}]}),
    );
    dispatch(&mut session, op::APP_LIFECYCLE, json!({"event":"launch"}));
    dispatch(&mut session, op::PAGE_PUSH, json!({"path":"home"}));
    session
        .notify_host_layout(metrics(375, 600), menu(275.))
        .unwrap();
    session.set_deferred_navigation_enabled(true).unwrap();
    call(&mut session, "clear");
    session
}
fn metrics(width: u32, height: u32) -> HostWindowMetrics {
    HostWindowMetrics {
        window_width: width,
        window_height: height,
        display: HostDisplayMetrics {
            pixel_ratio: 2.75,
            screen_width: width,
            screen_height: height + 60,
            status_bar_height: 24.,
            screen_top: 0.,
            safe_area: None,
            host_layout: None,
            device_orientation: if width > height {
                HostDeviceOrientation::Landscape
            } else {
                HostDeviceOrientation::Portrait
            },
        },
    }
}
fn menu(left: f64) -> MenuButtonRect {
    MenuButtonRect {
        left,
        right: left + 80.,
        top: 28.,
        bottom: 60.,
        width: 80.,
        height: 32.,
    }
}
#[test]
fn resize_callback_observes_complete_window_and_capsule_and_menu_only_does_not_resize() {
    for engine in engines() {
        let mut session = fixture(engine);
        session
            .notify_host_layout(metrics(700, 350), menu(600.))
            .unwrap();
        let trace = call(&mut session, "inspect");
        let resize = trace
            .as_array()
            .unwrap()
            .iter()
            .filter(|item| item["phase"] == "resize")
            .collect::<Vec<_>>();
        assert_eq!(resize.len(), 1);
        assert_eq!(resize[0]["window"]["windowWidth"], 700);
        assert_eq!(resize[0]["menu"]["left"], 600.);
        session
            .notify_host_layout(metrics(700, 350), menu(590.))
            .unwrap();
        let trace = call(&mut session, "inspect");
        assert_eq!(
            trace
                .as_array()
                .unwrap()
                .iter()
                .filter(|item| item["phase"] == "resize")
                .count(),
            1
        );
    }
}
#[test]
fn destination_lifecycle_waits_for_measurement_then_reads_new_complete_geometry() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "navigate");
        let trace = call(&mut session, "inspect");
        assert_eq!(trace.as_array().unwrap().len(), 1);
        assert_eq!(trace[0]["phase"], "returned");
        assert_eq!(session.app_service().pages().len(), 1);
        assert!(!session.is_current_frame_presented());
        let request = session.pending_navigation().unwrap();
        let batch = session
            .complete_navigation_layout(&request.ticket, metrics(700, 350), menu(600.))
            .unwrap();
        assert!(
            !batch.messages.iter().any(|item| item.op == op::ERROR),
            "{batch:?}"
        );
        let trace = call(&mut session, "inspect");
        let load = trace
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["phase"] == "detail-load")
            .unwrap();
        assert_eq!(load["window"]["windowWidth"], 700);
        assert_eq!(load["menu"]["left"], 600.);
        assert_eq!(load["pages"], json!(["home", "detail"]));
        let hide = trace
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["phase"] == "home-hide")
            .unwrap();
        assert_eq!(hide["window"]["windowWidth"], 375);
        assert_eq!(hide["menu"]["left"], 275.);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["count"],
            9
        );
        assert_eq!(
            session.last_navigation_outcome().unwrap()["layoutCommitted"],
            true
        );
    }
}
#[test]
fn public_mirror_replacement_cannot_run_during_commit() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "navigate");
        call(&mut session, "breakMirror");
        let request = session.pending_navigation().unwrap();
        session
            .complete_navigation_layout(&request.ticket, metrics(700, 350), menu(600.))
            .unwrap();
        assert!(
            !session.navigation_requires_restart(),
            "{:?}",
            session.navigation_fault()
        );
        let trace = call(&mut session, "inspect");
        assert!(trace
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["phase"] == "detail-load"));
    }
}
#[test]
fn timeout_cannot_run_departure_or_destination_hooks_and_old_ticket_is_rejected() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "navigate");
        let request = session.pending_navigation().unwrap();
        session
            .poll_navigation_timeouts(request.deadline_ns + 1)
            .unwrap();
        assert!(session.pending_navigation().is_none());
        assert_eq!(session.app_service().pages().len(), 1);
        let trace = call(&mut session, "inspect");
        assert!(!trace
            .as_array()
            .unwrap()
            .iter()
            .any(|item| matches!(item["phase"].as_str(), Some("home-hide" | "detail-load"))));
        assert!(session
            .complete_navigation_layout(&request.ticket, metrics(700, 350), menu(600.))
            .is_err());
        assert!(!session.navigation_requires_restart());
    }
}

fn invoke(session: &mut Session, method: &str, options: Value) {
    dispatch(
        session,
        op::MODULE_CALL,
        json!({"moduleId":"module:app.js","export":"invoke","args":[method,options]}),
    );
}
fn complete(session: &mut Session, width: u32) {
    let ticket = session.pending_navigation().unwrap().ticket;
    session
        .complete_navigation_layout(&ticket, metrics(width, 350), menu(f64::from(width) - 100.))
        .unwrap();
}
#[test]
fn fifo_navigation_and_cached_tab_identity_cross_multiple_owner_turns() {
    for engine in engines() {
        let mut session = fixture(engine);
        invoke(&mut session, "navigateTo", json!({"url":"/detail"}));
        let first = session.pending_navigation().unwrap().ticket;
        invoke(&mut session, "redirectTo", json!({"url":"/home"}));
        assert_eq!(session.pending_navigation().unwrap().ticket, first);
        complete(&mut session, 700);
        let second = session.pending_navigation().unwrap();
        assert_ne!(first, second.ticket);
        assert_eq!(second.target_route, "home");
        complete(&mut session, 600);
        assert_eq!(session.app_service().pages().len(), 2);
        invoke(&mut session, "navigateBack", json!({"delta":1}));
        complete(&mut session, 375);
        assert_eq!(session.app_service().pages().len(), 1);
        invoke(&mut session, "switchTab", json!({"url":"/tab"}));
        complete(&mut session, 500);
        let tab_id = session.app_service().pages().current().unwrap().id;
        invoke(&mut session, "navigateTo", json!({"url":"/detail"}));
        complete(&mut session, 700);
        invoke(&mut session, "switchTab", json!({"url":"/tab"}));
        complete(&mut session, 500);
        assert_eq!(session.app_service().pages().current().unwrap().id, tab_id);
        let trace = call(&mut session, "inspect");
        assert_eq!(
            trace
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["phase"] == "tab-load")
                .count(),
            1
        );
        invoke(&mut session, "reLaunch", json!({"url":"/home"}));
        complete(&mut session, 375);
        assert_eq!(session.app_service().pages().len(), 1);
        assert_eq!(
            session.app_service().pages().current().unwrap().path,
            "home"
        );
    }
}
#[test]
fn lifecycle_fault_is_not_rolled_back_or_replayed_and_requires_explicit_restart() {
    for engine in engines() {
        for destination in [false, true] {
            let mut session = fixture(engine);
            call(
                &mut session,
                if destination {
                    "failDestination"
                } else {
                    "failDeparture"
                },
            );
            call(&mut session, "navigate");
            let ticket = session.pending_navigation().unwrap().ticket;
            session
                .complete_navigation_layout(&ticket, metrics(700, 350), menu(600.))
                .unwrap();
            assert!(session.navigation_requires_restart());
            assert!(session.execution_health().requires_restart);
            assert!(!session.is_current_frame_presented());
            assert!(session
                .complete_navigation_layout(&ticket, metrics(700, 350), menu(600.))
                .is_err());
            assert_eq!(
                session.app_service().pages().len(),
                if destination { 2 } else { 1 }
            );
            assert_eq!(
                session.config().host.window_width,
                if destination { 700 } else { 375 }
            );
            let trace = call(&mut session, "inspect");
            assert_eq!(
                trace
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|entry| entry["phase"] == "home-hide")
                    .count(),
                1
            );
        }
    }
}
#[test]
fn close_cancels_active_and_queued_navigation_without_late_commit() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "navigate");
        let ticket = session.pending_navigation().unwrap().ticket;
        invoke(&mut session, "redirectTo", json!({"url":"/home"}));
        session.cancel_all_navigation("test close").unwrap();
        assert!(session.pending_navigation().is_none());
        assert_eq!(session.app_service().pages().len(), 1);
        assert!(session
            .complete_navigation_layout(&ticket, metrics(700, 350), menu(600.))
            .is_err());
    }
}

#[test]
fn a_single_clock_expiration_settles_the_entire_waiting_fifo() {
    for engine in engines() {
        let mut session = fixture(engine);
        for _ in 0..8 {
            invoke(&mut session, "navigateTo", json!({"url":"/detail"}));
        }
        let ticket = session.pending_navigation().unwrap().ticket;
        session.poll_navigation_timeouts(u64::MAX).unwrap();
        assert!(session.pending_navigation().is_none());
        assert_eq!(session.app_service().pages().len(), 1);
        assert!(!session.navigation_requires_restart());
        assert!(session
            .complete_navigation_layout(&ticket, metrics(700, 350), menu(600.))
            .is_err());
        let trace = call(&mut session, "inspect");
        assert!(!trace
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["phase"] == "home-hide"));
    }
}
#[test]
fn waiting_for_native_measurement_preserves_live_timer_and_departure_storage_writes() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "startClock");
        call(&mut session, "navigate");
        assert!(session.pending_navigation().is_some());
        let timers = session.poll_timers(u64::MAX);
        assert!(
            !timers
                .messages
                .iter()
                .any(|message| message.op == op::ERROR),
            "{timers:?}"
        );
        let before = call(&mut session, "live");
        assert_eq!(before["ticks"], 1);
        assert_eq!(before["pending"], "timer");
        complete(&mut session, 700);
        let after = call(&mut session, "live");
        assert_eq!(after["ticks"], 1);
        assert_eq!(after["pending"], "timer");
        assert_eq!(after["departure"], "hook");
    }
}
#[test]
fn deferred_bridge_push_keeps_initial_data_and_rejects_invalid_data_before_hooks() {
    for engine in engines() {
        let mut session = fixture(engine);
        dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"detail","data":{"count":42,"bridge":true}}),
        );
        complete(&mut session, 700);
        assert_eq!(
            session.app_service().pages().current().unwrap().data,
            json!({"count":42,"bridge":true})
        );
        call(&mut session, "clear");
        dispatch(
            &mut session,
            op::PAGE_PUSH,
            json!({"path":"home","data":123}),
        );
        assert!(session.pending_navigation().is_none());
        assert!(call(&mut session, "inspect").as_array().unwrap().is_empty());
    }
}

#[test]
fn new_navigation_wire_keeps_epoch_nanoseconds_exact() {
    let mut session = fixture(engines()[0]);
    call(&mut session, "navigate");
    let request = session.pending_navigation().unwrap();
    let wire = serde_json::to_value(&request).unwrap();
    assert_eq!(wire["deadlineNs"], request.deadline_ns.to_string());
}

#[test]
fn event_channel_binds_private_trusted_target_after_layout_and_before_on_load() {
    for engine in engines() {
        let mut session = fixture(engine);
        call(&mut session, "startChannel");
        assert_eq!(
            call(&mut session, "inspectChannel")["trace"],
            json!(["returned"])
        );
        call(&mut session, "breakMirror");
        complete(&mut session, 700);
        let state = call(&mut session, "inspectChannel");
        assert_eq!(
            state["trace"],
            json!([
                "returned",
                "load",
                "ready:3",
                "success",
                "early:4",
                "answer:5",
                "complete",
                "promise:true"
            ]),
            "{engine:?}: {state}"
        );
        assert_eq!(state["same"], true);
        assert!(!session.navigation_requires_restart());
    }
}
