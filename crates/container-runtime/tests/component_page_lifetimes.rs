//! Component page visibility through real Session lifecycle/navigation paths.
//! The saved 3.17.3 lifecycle oracle observes show/hide after a tab roundtrip;
//! these deterministic tests cover our wiring, not an unrecorded cross-hook order.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::{EngineKind, LifecycleState};
use container_ir::{
    hex_digest, parse_wxml, AppInfo, CapabilitySupport, CompilerInfo, Component,
    ContainerManifestV1, Module, ModuleFormat, ModuleScope, Route, RouteKind, Template,
};
use container_runtime::{Session, SessionConfig};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const APP_MODULE: &str = "module:app.js";
const COMPONENT_MODULE: &str = "module:components/card/index.js";
const FIRST: &str = "pages/first/index";
const SECOND: &str = "pages/second/index";

const APP_JS: &str = r#"
App({
  log: [], saved: [], serial: 0, navigateOnResize: false, throwing: '', failingLifecycle: '',
  onLaunch(options) { this.log.push({kind:'app.launch', options, pages:getCurrentPages().length}); },
  onShow(options) {
    this.log.push({kind: 'app.show', options, pages:getCurrentPages().length});
    if (this.failingLifecycle === 'app.show') throw new Error('fixture app.show failure');
  },
  onHide() {
    this.log.push({kind: 'app.hide'});
    if (this.failingLifecycle === 'app.hide') throw new Error('fixture app.hide failure');
  }
});
function definition(label) {
  return {
    data: {extra: false},
    onLoad() { getApp().log.push({kind: 'page.load', label}); },
    onShow() {
      getApp().log.push({kind: 'page.show', label});
      if (getApp().failingLifecycle === 'page.show:' + label) throw new Error('fixture page.show failure');
    },
    onHide() { getApp().log.push({kind: 'page.hide', label}); },
    onUnload() { getApp().log.push({kind: 'page.unload', label}); }
  };
}
Page(definition('first'));
Page(definition('second'));
exports.inspect = function() { return {log: getApp().log, saved: getApp().saved.map(function(c) {
  return {id: c.fixtureId, label: c.properties.label, active: c.active, shows: c.shows || 0, hides: c.hides || 0};
})}; };
exports.extra = function(value) { const pages = getCurrentPages(); pages[pages.length - 1].setData({extra: value}); };
exports.throwing = function(value) { getApp().throwing = value; };
exports.failLifecycle = function(value) { getApp().failingLifecycle = value; };
exports.navigate = function(url) { wx.navigateTo({url}); };
exports.relaunch = function(url) { wx.reLaunch({url}); };
exports.armResizeNavigation = function() { getApp().navigateOnResize = true; getApp().log = []; };
"#;

const COMPONENT_JS: &str = r#"
Component({
  properties: {label: {type: String, value: ''}},
  lifetimes: {
    created() { this.fixtureId = ++getApp().serial; getApp().saved.push(this); },
    attached() { this.active = true; getApp().log.push({kind: 'component.attached', id: this.fixtureId}); },
    detached() { this.active = false; getApp().log.push({kind: 'component.detached', id: this.fixtureId}); }
  },
  pageLifetimes: {
    show() {
      this.shows = (this.shows || 0) + 1;
      getApp().log.push({kind: 'component.show', id: this.fixtureId, label: this.properties.label, args: arguments.length});
      if (getApp().throwing === 'show') throw new Error('fixture show failure');
    },
    hide() {
      this.hides = (this.hides || 0) + 1;
      getApp().log.push({kind: 'component.hide', id: this.fixtureId, label: this.properties.label, args: arguments.length});
      if (getApp().throwing === 'hide') throw new Error('fixture hide failure');
    },
    resize() {
      getApp().log.push({kind: 'component.resize', id: this.fixtureId});
      if (getApp().navigateOnResize) {
        getApp().navigateOnResize = false;
        wx.navigateTo({url:'/pages/second/index', success:function() { wx.navigateBack({delta:1}); }});
      }
    }
  },
  methods: {
    show() { throw new Error('ordinary show method must not override pageLifetimes'); },
    hide() { throw new Error('ordinary hide method must not override pageLifetimes'); }
  }
});
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

struct Fixture {
    session: Session,
    blobs: BTreeMap<String, Vec<u8>>,
    sequence: u64,
    error_envelopes: Vec<BridgeEnvelope>,
}

impl Fixture {
    fn start(engine: EngineKind, tabs: bool) -> Self {
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "component-page-lifetimes-fixture".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        for name in [
            "getCurrentPages",
            "wx.switchTab",
            "wx.navigateTo",
            "wx.navigateBack",
            "wx.reLaunch",
        ] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        for path in [FIRST, SECOND] {
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: if tabs {
                    RouteKind::Tab
                } else {
                    RouteKind::Page
                },
                config: None,
                entry_module: APP_MODULE.into(),
            });
            manifest.components.push(Component {
                id: format!("components:{path}.json"),
                owner: format!("{path}.json"),
                using_components: BTreeMap::from([("card".into(), "components/card/index".into())]),
                multiple_slots: None,
            });
        }
        for (id, source, scope) in [
            (APP_MODULE, APP_JS, ModuleScope::App),
            (COMPONENT_MODULE, COMPONENT_JS, ModuleScope::Component),
        ] {
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
        }
        let mut blobs = BTreeMap::new();
        for (path, source) in [
            ("pages/first/index.wxml", "<view><card label=\"first-a\"/><card label=\"first-b\"/><card wx:if=\"{{extra}}\" label=\"late\"/></view>"),
            ("pages/second/index.wxml", "<view><card label=\"second\"/></view>"),
            ("components/card/index.wxml", "<view>{{label}}</view>"),
        ] {
            let bytes = parse_wxml(source).unwrap().canonical_json().unwrap();
            let pointer = format!("sha256:{}", hex_digest(&bytes));
            manifest.templates.push(Template {
                id: format!("template:{path}"),
                wxml_ast: pointer.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            });
            blobs.insert(pointer, bytes);
        }
        manifest.refresh_integrity().unwrap();
        let mut fixture = Self {
            session: Session::new(
                manifest,
                SessionConfig {
                    engine,
                    ..SessionConfig::default()
                },
            )
            .unwrap(),
            blobs,
            sequence: 0,
            error_envelopes: Vec::new(),
        };
        fixture.dispatch(
            op::APP_INIT,
            json!({"modules":[
            {"id":APP_MODULE,"source":APP_JS},
            {"id":COMPONENT_MODULE,"source":COMPONENT_JS},
        ], "blobs":fixture.blobs}),
        );
        fixture.lifecycle("launch");
        fixture.push(FIRST);
        fixture
    }

    fn dispatch_raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        let batch = self.session.dispatch(BridgeEnvelope::request(
            "session-1",
            format!("page-lifetimes-{}", self.sequence),
            operation,
            payload,
        ));
        self.error_envelopes.extend(
            batch
                .messages
                .iter()
                .filter(|message| message.op == op::ERROR)
                .cloned(),
        );
        batch
    }

    fn dispatch(&mut self, operation: &str, payload: Value) -> Value {
        let batch = self.dispatch_raw(operation, payload);
        assert_eq!(
            batch.messages[0].payload["ok"], true,
            "{operation}: {:?}",
            batch.messages
        );
        batch.messages[0].payload.clone()
    }

    fn error_messages(&self) -> Vec<&str> {
        self.error_envelopes
            .iter()
            .flat_map(|envelope| envelope.payload["errors"].as_array().unwrap())
            .map(|error| {
                assert_eq!(error["name"], "Error");
                error["message"].as_str().unwrap()
            })
            .collect()
    }

    fn call(&mut self, name: &str, args: Value) -> Value {
        self.dispatch(
            op::MODULE_CALL,
            json!({"moduleId":APP_MODULE,"export":name,"args":args}),
        )["result"][0]
            .clone()
    }

    fn inspect(&mut self) -> Value {
        self.call("inspect", json!([]))
    }
    fn lifecycle(&mut self, event: &str) {
        self.dispatch(op::APP_LIFECYCLE, json!({"event":event}));
    }
    fn push(&mut self, path: &str) {
        self.dispatch(op::PAGE_PUSH, json!({"path":path}));
    }
    fn tab(&mut self, path: &str) {
        self.dispatch(op::API_CALL, json!({"name":"wx.switchTab","url":path}));
    }

    fn render(&mut self, width: u32) {
        let page = self.session.app_service().pages().current().unwrap();
        let template = format!("template:{}.wxml", page.path);
        let data = page.data.clone();
        self.dispatch(op::RENDER_COMMIT, json!({"templateId":template,"viewport":{"width":width,"height":667},"data":data,"blobs":self.blobs}));
    }
}

fn counts(value: &Value) -> Vec<(u64, u64, bool)> {
    value["saved"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["shows"].as_u64().unwrap(),
                entry["hides"].as_u64().unwrap(),
                entry["active"].as_bool().unwrap(),
            )
        })
        .collect()
}

#[test]
fn initial_visibility_uses_page_lifetimes_and_repeated_render_is_idle() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        assert_eq!(counts(&fixture.inspect()), vec![(1, 0, true), (1, 0, true)]);
        fixture.render(375);
        fixture.render(375);
        let state = fixture.inspect();
        assert_eq!(counts(&state), vec![(1, 0, true), (1, 0, true)]);
        for event in state["log"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["kind"] == "component.show")
        {
            assert_eq!(
                event["args"], 0,
                "page show does not inherit App launch options"
            );
        }
        assert!(fixture.error_envelopes.is_empty());
    }
}

#[test]
fn initial_app_show_precedes_page_hooks_and_duplicate_host_show_is_idle() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let state = fixture.inspect();
        let log = state["log"].as_array().unwrap();
        assert_eq!(log[0]["kind"], "app.launch");
        assert_eq!(log[1]["kind"], "app.show");
        assert_eq!(log[0]["pages"], 0);
        assert_eq!(log[1]["pages"], 0);
        assert_eq!(log[1]["options"], log[0]["options"]);
        assert_eq!(
            log.iter()
                .filter(|entry| entry["kind"] == "page.show")
                .count(),
            1
        );
        let before = log.len();
        fixture.lifecycle("show");
        assert_eq!(fixture.inspect()["log"].as_array().unwrap().len(), before);
    }
}

#[test]
fn host_visibility_runs_app_then_current_page_then_components_once() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let before = fixture.inspect()["log"].as_array().unwrap().len();
        fixture.lifecycle("hide");
        fixture.lifecycle("hide");
        fixture.lifecycle("show");
        fixture.lifecycle("show");
        let state = fixture.inspect();
        let kinds = state["log"].as_array().unwrap()[before..]
            .iter()
            .map(|entry| entry["kind"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            vec![
                "app.hide",
                "page.hide",
                "component.hide",
                "component.hide",
                "app.show",
                "page.show",
                "component.show",
                "component.show"
            ]
        );
    }
}

#[test]
fn host_viewport_resize_notifies_live_component_instances_once() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let resized = fixture.session.notify_viewport_resize(800, 400).unwrap();
        assert!(!resized
            .messages
            .iter()
            .any(|message| message.op == op::ERROR));
        let state = fixture.inspect();
        assert_eq!(
            state["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "component.resize")
                .count(),
            2
        );
        assert!(fixture
            .session
            .notify_viewport_resize(800, 400)
            .unwrap()
            .messages
            .is_empty());
        let state = fixture.inspect();
        assert_eq!(
            state["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "component.resize")
                .count(),
            2
        );
        assert_eq!(counts(&state), vec![(1, 0, true), (1, 0, true)]);
    }
}

#[test]
fn display_only_observations_do_not_replay_component_resize_or_visibility() {
    use container_runtime::{HostDeviceOrientation, HostDisplayMetrics, HostWindowMetrics};
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        let mut metrics = HostWindowMetrics {
            window_width: 375,
            window_height: 667,
            display: HostDisplayMetrics {
                pixel_ratio: 2.75,
                screen_width: 393,
                screen_height: 852,
                status_bar_height: 24.0,
                screen_top: 24.0,
                safe_area: None,
                host_layout: None,
                device_orientation: HostDeviceOrientation::Portrait,
            },
        };
        fixture
            .session
            .notify_window_metrics(metrics.clone())
            .unwrap();
        let before = fixture.inspect();
        metrics.display.pixel_ratio = 3.25;
        metrics.display.status_bar_height = 28.5;
        metrics.display.screen_top = 28.5;
        fixture
            .session
            .notify_window_metrics(metrics.clone())
            .unwrap();
        assert_eq!(fixture.inspect(), before);
        assert!(fixture
            .session
            .notify_window_metrics(metrics.clone())
            .unwrap()
            .messages
            .is_empty());
        metrics.window_width = 360;
        fixture.session.notify_window_metrics(metrics).unwrap();
        let after = fixture.inspect();
        assert_eq!(counts(&after), counts(&before));
        let resize_count = |state: &Value| {
            state["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "component.resize")
                .count()
        };
        assert_eq!(resize_count(&after), resize_count(&before) + 2);
    }
}

#[test]
fn navigation_hides_and_restores_only_the_corresponding_live_page() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("navigate", json!([SECOND]));
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (1, 0, true)]
        );
        fixture.dispatch(op::PAGE_POP, json!({}));
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(2, 1, true), (2, 1, true), (1, 0, false)]
        );
        fixture.lifecycle("hide");
        fixture.lifecycle("show");
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(3, 2, true), (3, 2, true), (1, 0, false)]
        );
    }
}

#[test]
fn navigation_while_backgrounded_defers_new_page_components_until_foreground() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.lifecycle("hide");
        fixture.call("navigate", json!([SECOND]));
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (0, 0, true)]
        );
        fixture.lifecycle("show");
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (1, 0, true)]
        );
    }
}

#[test]
fn tab_cache_and_app_visibility_share_one_deduplicated_boundary() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, true);
        fixture.tab(SECOND);
        fixture.lifecycle("hide");
        fixture.lifecycle("hide");
        fixture.lifecycle("show");
        fixture.lifecycle("show");
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (2, 1, true)]
        );
        fixture.tab(FIRST);
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(2, 1, true), (2, 1, true), (2, 2, true)]
        );
        fixture.lifecycle("unload");
        assert!(counts(&fixture.inspect()).iter().all(|entry| !entry.2));
    }
}

#[test]
fn relaunch_disposes_active_and_cached_tab_components_before_replacement() {
    for engine in engines() {
        for native_navigation in [false, true] {
            let mut fixture = Fixture::start(engine, true);
            fixture.tab(SECOND);
            if native_navigation {
                fixture.call("relaunch", json!([FIRST]));
            } else {
                fixture.dispatch(op::API_CALL, json!({"name":"wx.reLaunch","url":FIRST}));
            }
            let state = fixture.inspect();
            assert_eq!(
                counts(&state),
                vec![
                    (1, 1, false),
                    (1, 1, false),
                    (1, 0, false),
                    (1, 0, true),
                    (1, 0, true)
                ]
            );
            let unloads = state["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "page.unload")
                .map(|entry| entry["label"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(
                unloads,
                vec!["second", "first"],
                "active stack order is retained before cached tabs"
            );
            let detached = state["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "component.detached")
                .map(|entry| entry["id"].as_u64().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(detached, vec![3, 2, 1], "each old graph disposes once");
            fixture.lifecycle("hide");
            fixture.lifecycle("show");
            assert_eq!(
                counts(&fixture.inspect()),
                vec![
                    (1, 1, false),
                    (1, 1, false),
                    (1, 0, false),
                    (2, 1, true),
                    (2, 1, true)
                ]
            );
        }
    }
}

#[test]
fn new_visible_occurrences_are_shown_once_and_background_attachments_wait() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("extra", json!([true]));
        fixture.render(375);
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 0, true), (1, 0, true), (1, 0, true)]
        );
        fixture.call("extra", json!([false]));
        fixture.render(375);
        fixture.lifecycle("hide");
        fixture.call("extra", json!([true]));
        fixture.render(375);
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (1, 0, false), (0, 0, true)]
        );
        fixture.lifecycle("show");
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(2, 1, true), (2, 1, true), (1, 0, false), (1, 0, true)]
        );
    }
}

#[test]
fn thrown_component_hooks_do_not_repeat_or_skip_siblings() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("throwing", json!(["hide"]));
        fixture.lifecycle("hide");
        assert_eq!(
            fixture.error_messages(),
            vec!["fixture hide failure", "fixture hide failure"]
        );
        fixture.lifecycle("hide");
        assert_eq!(counts(&fixture.inspect()), vec![(1, 1, true), (1, 1, true)]);
        assert_eq!(fixture.error_envelopes.len(), 1);
        fixture.call("throwing", json!(["show"]));
        fixture.lifecycle("show");
        let expected_errors = vec![
            "fixture hide failure",
            "fixture hide failure",
            "fixture show failure",
            "fixture show failure",
        ];
        assert_eq!(fixture.error_messages(), expected_errors);
        fixture.lifecycle("show");
        fixture.render(375);
        let state = fixture.inspect();
        assert_eq!(counts(&state), vec![(2, 1, true), (2, 1, true)]);
        assert_eq!(fixture.error_messages(), expected_errors);
        assert_eq!(fixture.error_envelopes.len(), 2);
    }
}

fn assert_lifecycle_error(batch: &BridgeBatch, expected: &str) {
    let payload = &batch.messages[0].payload;
    assert_eq!(payload["ok"], false, "{batch:?}");
    assert_eq!(payload["error"]["code"], "ERR_ENGINE", "{batch:?}");
    let errors = batch
        .messages
        .iter()
        .filter(|message| message.op == op::ERROR)
        .flat_map(|message| message.payload["errors"].as_array().unwrap())
        .map(|error| error["message"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(errors, vec![expected], "{batch:?}");
}

#[test]
fn committed_app_visibility_survives_a_throwing_app_hook() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.call("failLifecycle", json!(["app.hide"]));
        let hidden = fixture.dispatch_raw(op::APP_LIFECYCLE, json!({"event":"hide"}));
        assert_lifecycle_error(&hidden, "fixture app.hide failure");
        assert_eq!(
            fixture.session.app_service().lifecycle().state(),
            LifecycleState::Background
        );
        assert_eq!(counts(&fixture.inspect()), vec![(1, 1, true), (1, 1, true)]);
        fixture.call("extra", json!([true]));
        fixture.render(375);
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(1, 1, true), (1, 1, true), (0, 0, true)]
        );

        fixture.call("failLifecycle", json!(["app.show"]));
        let shown = fixture.dispatch_raw(op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_lifecycle_error(&shown, "fixture app.show failure");
        assert_eq!(
            fixture.session.app_service().lifecycle().state(),
            LifecycleState::Active
        );
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(2, 1, true), (2, 1, true), (1, 0, true)]
        );
        let repeated = fixture.dispatch_raw(op::APP_LIFECYCLE, json!({"event":"show"}));
        assert_eq!(repeated.messages[0].payload["ok"], true);
        assert_eq!(repeated.messages[0].payload["duplicateVisibility"], true);
        fixture.render(375);
        assert_eq!(
            counts(&fixture.inspect()),
            vec![(2, 1, true), (2, 1, true), (1, 0, true)]
        );
    }
}

#[test]
fn committed_page_visibility_survives_a_throwing_page_show_hook() {
    for engine in engines() {
        for background in [false, true] {
            let mut fixture = Fixture::start(engine, false);
            if background {
                fixture.lifecycle("hide");
            }
            fixture.call("failLifecycle", json!(["page.show:second"]));
            let pushed = fixture.dispatch_raw(op::PAGE_PUSH, json!({"path":SECOND}));
            assert_lifecycle_error(&pushed, "fixture page.show failure");
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .path,
                SECOND
            );
            let second_shows = u64::from(!background);
            assert_eq!(
                counts(&fixture.inspect()),
                vec![(1, 1, true), (1, 1, true), (second_shows, 0, true)]
            );
            fixture.render(375);
            assert_eq!(
                counts(&fixture.inspect()),
                vec![(1, 1, true), (1, 1, true), (second_shows, 0, true)]
            );
            if background {
                let resumed = fixture.dispatch_raw(op::APP_LIFECYCLE, json!({"event":"show"}));
                assert_lifecycle_error(&resumed, "fixture page.show failure");
                assert_eq!(
                    counts(&fixture.inspect()),
                    vec![(1, 1, true), (1, 1, true), (1, 0, true)]
                );
            }
            let repeated = fixture.dispatch_raw(op::APP_LIFECYCLE, json!({"event":"show"}));
            assert_eq!(repeated.messages[0].payload["ok"], true);
            assert_eq!(repeated.messages[0].payload["duplicateVisibility"], true);
            fixture.render(375);
            assert_eq!(
                counts(&fixture.inspect()),
                vec![(1, 1, true), (1, 1, true), (1, 0, true)]
            );
        }
    }
}

#[test]
fn render_viewport_changes_do_not_invent_a_component_resize_lifecycle() {
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.render(375);
        fixture.render(400);
        assert!(!fixture.inspect()["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "component.resize"));
    }
}

#[test]
fn logical_resize_component_callback_navigation_round_trip_retires_source() {
    use container_render_skia::Renderer;
    for engine in engines() {
        let mut fixture = Fixture::start(engine, false);
        fixture.render(375);
        fixture.call("armResizeNavigation", json!([]));
        let page = fixture.session.app_service().pages().current().unwrap().id;
        let revision = fixture.session.render_revision();
        let frame = fixture.session.renderer().last_frame().unwrap().clone();
        let host = fixture.session.config().host.clone();
        let failure = match fixture.session.prepare_dev_logical_resize(
            container_render_skia::Rect {
                x: 0.0,
                y: 0.0,
                width: 500.0,
                height: 667.0,
            },
            1.0,
        ) {
            Ok(_) => panic!("component resize navigation revived the original source"),
            Err(failure) => failure,
        };
        assert_eq!(
            failure.error.code,
            container_bridge::BridgeErrorCode::Cancelled
        );
        assert_eq!(fixture.session.app_service().pages().len(), 1);
        assert_eq!(
            fixture.session.app_service().pages().current().unwrap().id,
            page
        );
        assert_eq!(fixture.session.render_revision(), revision);
        assert_eq!(fixture.session.renderer().last_frame(), Some(&frame));
        assert_eq!(
            fixture.session.config().host.window_width,
            host.window_width
        );
        assert_eq!(
            fixture.session.config().host.window_height,
            host.window_height
        );
        let before = fixture.inspect();
        assert!(before["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "component.resize"));
        assert!(before["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| entry["kind"] == "page.load" && entry["label"] == "second"));
        let resize_count = before["log"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["kind"] == "component.resize")
            .count();
        fixture.render(375);
        let after = fixture.inspect();
        assert_eq!(
            after["log"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|entry| entry["kind"] == "component.resize")
                .count(),
            resize_count
        );
    }
}
