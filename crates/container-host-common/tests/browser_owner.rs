//! Owner-thread protocol tests with reported browser geometry. These do not
//! claim execution in an actual browser, HTTP server or native WebView.
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_host_common::{HostSession, HostSessionError};
use container_ir::{
    hex_digest, parse_wxml, AppInfo, Asset, BrowserGeometryBatch, BrowserNodeGeometry,
    CapabilitySupport, CompilerInfo, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
    RendererProfile, RendererProfiles, Route, RouteKind, Template, ViewNode, ViewPoint, ViewRect,
    ViewSize, RENDERING_MANIFEST_SCHEMA_VERSION, VIEW_PRESENTATION_VERSION,
};
use container_runtime::{BrowserViewSubmission, SessionConfig, SessionError};
use serde_json::{json, Value};

const SESSION: &str = "browser-owner";
const ROUTE: &str = "pages/index/index";
const TEMPLATE: &str = "template:pages/index/index.wxml";

struct Fixture {
    manifest: ContainerManifestV1,
    init: Value,
    asset_hash: String,
    template_hash: String,
}

impl Fixture {
    fn new() -> Self {
        let wxml = parse_wxml(
            r#"<view id="root"><image src="assets/logo.svg"/><text>Owner thread</text></view>"#,
        )
        .unwrap()
        .canonical_json()
        .unwrap();
        let asset = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"1\" height=\"1\"/>";
        let template_hash = hex_digest(&wxml);
        let asset_hash = hex_digest(asset);
        let mut manifest = ContainerManifestV1 {
            schema_version: RENDERING_MANIFEST_SCHEMA_VERSION,
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "host-browser-owner-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "module:app.js".into(),
            },
            routes: vec![Route {
                id: format!("route:{ROUTE}"),
                path: ROUTE.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "module:pages/index/index.js".into(),
            }],
            templates: vec![Template {
                id: TEMPLATE.into(),
                wxml_ast: format!("sha256:{template_hash}"),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            assets: vec![Asset {
                path: "assets/logo.svg".into(),
                sha256: asset_hash.clone(),
                mime: "image/svg+xml".into(),
                size: asset.len() as u64,
            }],
            rendering: Some(RendererProfiles {
                default: RendererProfile::WebView,
                ..Default::default()
            }),
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        let init = json!({"blobs":{template_hash.clone():wxml,asset_hash.clone():asset.to_vec()}});
        Self {
            manifest,
            init,
            asset_hash,
            template_hash,
        }
    }

    fn add_storage_ready_program(&mut self) {
        let app = "App({});";
        let page = "let observed; Page({onReady(){observed=wx.getStorageSync('owner-value')}}); exports.inspect=()=>observed;";
        for (id, source, scope) in [
            ("module:app.js", app, ModuleScope::App),
            ("module:pages/index/index.js", page, ModuleScope::Page),
        ] {
            self.manifest.modules.push(Module {
                id: id.into(),
                sha256: hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: vec![],
            });
        }
        self.manifest
            .capabilities
            .insert("wx.getStorageSync".into(), CapabilitySupport::Full);
        self.manifest.refresh_integrity().unwrap();
        self.init["modules"] = json!([
            {"id":"module:app.js","source":app},
            {"id":"module:pages/index/index.js","source":page}
        ]);
    }

    fn load(&self, engine: EngineKind) -> HostSession {
        HostSession::from_manifest_json(
            serde_json::to_vec(&self.manifest).unwrap(),
            SessionConfig {
                session_id: SESSION.into(),
                engine,
                browser_view_enabled: true,
                ..Default::default()
            },
        )
        .unwrap()
    }

    fn boot(&self, engine: EngineKind) -> HostSession {
        let mut host = self.load(engine);
        dispatch(&mut host, op::APP_INIT, self.init.clone());
        dispatch(&mut host, op::APP_LIFECYCLE, json!({"event":"launch"}));
        dispatch(&mut host, op::PAGE_PUSH, json!({"path":ROUTE}));
        host
    }
}

fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request(SESSION, operation, operation, payload)
}

fn response(batch: BridgeBatch) -> Value {
    assert!(
        !batch
            .messages
            .iter()
            .any(|message| message.payload["ok"] == false),
        "{batch:?}"
    );
    batch.messages[0].payload.clone()
}

fn dispatch(host: &mut HostSession, operation: &str, payload: Value) -> Value {
    response(host.dispatch(request(operation, payload)).unwrap())
}

fn prepare_request() -> BridgeEnvelope {
    request(
        op::VIEW_PREPARE,
        json!({
            "version":VIEW_PRESENTATION_VERSION,"surfaceGeneration":"1",
            "render":{"templateId":TEMPLATE,"useSessionResources":true,
                "viewport":{"width":375,"height":667}}
        }),
    )
}

fn prepare(host: &mut HostSession) -> BrowserViewSubmission {
    let payload = response(host.dispatch(prepare_request()).unwrap());
    serde_json::from_value(payload["submission"].clone()).unwrap()
}

fn geometry(submission: &BrowserViewSubmission) -> BrowserGeometryBatch {
    let mut nodes = vec![];
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 0.0,
                y: 0.0,
                width: 20.0,
                height: 20.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 20.0,
                height: 20.0,
            },
            client_size: ViewSize {
                width: 20.0,
                height: 20.0,
            },
        });
        if let ViewNode::Element { children, .. } = node {
            pending.extend(children);
        }
    }
    BrowserGeometryBatch {
        version: VIEW_PRESENTATION_VERSION.into(),
        key: submission.key.clone(),
        epoch: 0,
        viewport: submission.viewport,
        nodes,
    }
}

fn present(host: &mut HostSession, geometry: &BrowserGeometryBatch) {
    let permit = dispatch(
        host,
        op::VIEW_PREPARE_COMMIT,
        serde_json::to_value(geometry).unwrap(),
    )["permit"]
        .clone();
    // Exercise the native JSON facade too; it must use the same owner turn.
    let encoded = host
        .dispatch_json(serde_json::to_vec(&request(op::VIEW_PRESENTED, permit)).unwrap())
        .unwrap();
    let result = response(serde_json::from_slice(&encoded).unwrap());
    assert_eq!(result["inputEnabled"], true);
}

#[test]
fn webview_requires_explicit_host_support_and_never_uses_legacy_render() {
    let mut fixture = Fixture::new();
    let error = HostSession::from_manifest_json(
        serde_json::to_vec(&fixture.manifest).unwrap(),
        SessionConfig::default(),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        HostSessionError::Session(SessionError::UnsupportedCapability(_))
    ));
    fixture.manifest.rendering = Some(RendererProfiles::default());
    fixture.manifest.refresh_integrity().unwrap();
    let error = HostSession::from_manifest_json(
        serde_json::to_vec(&fixture.manifest).unwrap(),
        SessionConfig {
            renderer_override: Some(RendererProfile::WebView),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(matches!(
        error,
        HostSessionError::Session(SessionError::UnsupportedCapability(_))
    ));

    let fixture = Fixture::new();
    let mut host = fixture.boot(EngineKind::Quickjs);
    let prepared = prepare(&mut host);
    assert_eq!(prepared.document.profile, RendererProfile::WebView);
    let legacy = host
        .dispatch(request(op::RENDER_COMMIT, json!({})))
        .unwrap();
    assert_eq!(
        legacy.messages[0].payload["error"]["code"],
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert!(matches!(
        host.render_snapshot(),
        Err(HostSessionError::NoRenderFrame)
    ));
}

#[test]
fn direct_owner_dispatch_publishes_geometry_and_authorizes_only_document_assets() {
    let fixture = Fixture::new();
    let mut host = fixture.boot(EngineKind::Quickjs);
    let submission = prepare(&mut host);
    assert!(!host.is_browser_view_presented().unwrap());
    assert!(host.view_document().unwrap().is_none());
    assert!(host.browser_geometry().unwrap().is_none());
    let asset = host
        .browser_view_resource(&submission.key, &fixture.asset_hash)
        .unwrap();
    assert_eq!(hex_digest(asset), fixture.asset_hash);
    assert!(host
        .browser_view_resource(&submission.key, &fixture.template_hash)
        .is_err());
    let mut wrong_key = submission.key.clone();
    wrong_key.surface_generation += 1;
    assert!(host
        .browser_view_resource(&wrong_key, &fixture.asset_hash)
        .is_err());

    let mut geometry = geometry(&submission);
    present(&mut host, &geometry);
    assert!(host.is_browser_view_presented().unwrap());
    assert_eq!(host.view_document().unwrap(), Some(&submission.document));
    assert_eq!(host.browser_geometry().unwrap(), Some(&geometry));
    assert!(matches!(
        host.render_snapshot(),
        Err(HostSessionError::NoRenderFrame)
    ));
    geometry.epoch = 1;
    geometry.nodes[0].scroll_offset.y = 8.0;
    dispatch(
        &mut host,
        op::VIEW_GEOMETRY,
        serde_json::to_value(&geometry).unwrap(),
    );
    assert_eq!(host.browser_geometry().unwrap(), Some(&geometry));

    dispatch(&mut host, op::APP_LIFECYCLE, json!({"event":"hide"}));
    assert!(!host.is_browser_view_presented().unwrap());
    assert!(host.browser_geometry().unwrap().is_none());
    assert_eq!(host.view_document().unwrap(), Some(&submission.document));
    assert!(host
        .browser_view_resource(&submission.key, &fixture.asset_hash)
        .is_err());
}

#[test]
fn browser_mutations_share_session_protocol_deadline_and_cancellation_guards() {
    let fixture = Fixture::new();
    let mut host = fixture.boot(EngineKind::Quickjs);
    let mut wrong_session = prepare_request();
    wrong_session.session_id = "another-owner".into();
    let mut wrong_protocol = prepare_request();
    wrong_protocol.protocol_version = "99.0".into();
    let mut expired = prepare_request();
    expired.deadline_ns = Some(1);
    dispatch(&mut host, op::CANCEL, json!({"cancelToken":"cancel-view"}));
    let mut cancelled = prepare_request();
    cancelled.cancel_token = Some("cancel-view".into());
    for (request, expected) in [
        (wrong_session, "ERR_INVALID_REQUEST"),
        (wrong_protocol, "ERR_PROTOCOL_VERSION"),
        (expired, "ERR_TIMEOUT"),
        (cancelled, "ERR_CANCELLED"),
    ] {
        let result = host.dispatch(request).unwrap();
        assert_eq!(result.messages[0].payload["error"]["code"], expected);
        assert!(host.view_document().unwrap().is_none());
        assert!(!host.is_browser_view_presented().unwrap());
    }
    assert_eq!(prepare(&mut host).key.presentation_revision, 1);
}

#[test]
fn closed_host_rejects_all_browser_reads_and_mutation_paths() {
    let fixture = Fixture::new();
    let mut host = fixture.boot(EngineKind::Quickjs);
    let submission = prepare(&mut host);
    host.unload();
    assert!(matches!(
        host.view_document(),
        Err(HostSessionError::NotLoaded)
    ));
    assert!(matches!(
        host.browser_geometry(),
        Err(HostSessionError::NotLoaded)
    ));
    assert!(matches!(
        host.is_browser_view_presented(),
        Err(HostSessionError::NotLoaded)
    ));
    assert!(matches!(
        host.browser_view_resource(&submission.key, &fixture.asset_hash),
        Err(HostSessionError::NotLoaded)
    ));
    for operation in [
        op::VIEW_PREPARE,
        op::VIEW_PREPARE_COMMIT,
        op::VIEW_PRESENTED,
        op::VIEW_ABORT,
        op::VIEW_GEOMETRY,
        op::VIEW_EVENTS,
    ] {
        assert!(matches!(
            host.dispatch(request(operation, json!({}))),
            Err(HostSessionError::NotLoaded)
        ));
    }
    assert!(matches!(
        host.dispatch_json(serde_json::to_vec(&prepare_request()).unwrap()),
        Err(HostSessionError::NotLoaded)
    ));
}

#[test]
fn browser_ready_imports_host_storage_through_the_shared_dispatch_boundary() {
    for engine in [EngineKind::Quickjs, EngineKind::V8] {
        if !container_runtime::engine_provider_compiled(engine) {
            continue;
        }
        let mut fixture = Fixture::new();
        fixture.add_storage_ready_program();
        let mut host = fixture.boot(engine);
        let submission = prepare(&mut host);
        let geometry = geometry(&submission);
        host.session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("owner-value", json!({"from":"host-owner"}))
            .unwrap();
        // Host mutation also revokes the earlier candidate. A fresh owner
        // turn must both import storage and obtain a new presentation key.
        let submission = prepare(&mut host);
        assert!(submission.key.presentation_revision > geometry.key.presentation_revision);
        present(&mut host, &self::geometry(&submission));
        let observed = dispatch(
            &mut host,
            op::MODULE_CALL,
            json!({"moduleId":"module:pages/index/index.js","export":"inspect","args":[]}),
        );
        assert_eq!(observed["result"][0], json!({"from":"host-owner"}));
    }
}
