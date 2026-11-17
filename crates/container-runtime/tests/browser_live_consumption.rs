//! Live 2.1 retention with real native AppService/View engines and a controlled
//! protocol peer. This is not actual browser, IME, GPU or release-gate evidence.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]

use container_bridge::{op, BridgeBatch, BridgeEnvelope, EnvelopeKind};
use container_core::EngineKind;
use container_ir::{
    hex_digest, parse_wxml, AppInfo, BrowserGeometryBatch, BrowserNodeGeometry, CapabilitySupport,
    CompilerInfo, ContainerManifestV1, Module, ModuleFormat, ModuleScope, RendererProfile, Route,
    RouteKind, Template, ViewNode, ViewPoint, ViewRect, ViewSize, VIEW_PRESENTATION_VERSION,
};
use container_runtime::{
    BrowserLiveViewSubmission, HostApiProvider, ProviderContext, ProviderError, SandboxProvider,
    Session, SessionConfig, ViewExecutionPolicy,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

const SESSION: &str = "live-consumption-fixture";
const PAGE_MODULE: &str = "module:pages/index/index.js";
const CONSUME: &str = "view.live.consume";

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn request(id: &str, operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request(SESSION, id, operation, payload)
}

fn correlated(batch: &BridgeBatch, wire: &BridgeEnvelope) -> Value {
    let finals: Vec<_> = batch
        .messages
        .iter()
        .filter(|message| {
            message.kind == EnvelopeKind::Response
                && message.session_id == wire.session_id
                && message.request_id == wire.request_id
                && message.op == wire.op
        })
        .collect();
    assert_eq!(
        finals.len(),
        1,
        "missing unique correlated final: {batch:?}"
    );
    finals[0].payload.clone()
}

fn success(session: &mut Session, wire: &BridgeEnvelope) -> (Value, BridgeBatch) {
    let batch = session.dispatch(wire.clone());
    let payload = correlated(&batch, wire);
    assert_eq!(payload["ok"], true, "{wire:?}: {batch:?}");
    (payload, batch)
}

fn failure(session: &mut Session, wire: &BridgeEnvelope) -> Value {
    let batch = session.dispatch(wire.clone());
    let payload = correlated(&batch, wire);
    assert_eq!(payload["ok"], false, "{wire:?}: {batch:?}");
    assert!(payload["error"]["code"].is_string(), "{batch:?}");
    payload
}

fn build(engine: EngineKind) -> (Session, Value) {
    let app = "App({readies:0});";
    let page = r#"
        Page({data:{calls:0,label:'same-session'},onReady(){getApp().readies++}});
        exports.inspect=()=>({readies:getApp().readies,
          calls:getCurrentPages()[0].data.calls,stored:wx.getStorageSync('host-write')});
        exports.mutate=()=>{const page=getCurrentPages()[0];
          page.setData({calls:page.data.calls+1});
          wx.setStorageSync('business-call',true);return true};
    "#;
    let wxml = parse_wxml("<view id=\"content\"><text>{{label}}</text></view>")
        .unwrap()
        .canonical_json()
        .unwrap();
    let template_hash = format!("sha256:{}", hex_digest(&wxml));
    let mut manifest = ContainerManifestV1 {
        compiler: CompilerInfo {
            name: "weapp-vite".into(),
            commit: "live-consumption-integration-fixture".into(),
            platform: "weapp".into(),
        },
        app: AppInfo {
            app_json: "app.json".into(),
            entry_module: "module:app.js".into(),
        },
        routes: vec![Route {
            id: "route:pages/index/index".into(),
            path: "pages/index/index".into(),
            kind: RouteKind::Page,
            config: None,
            entry_module: PAGE_MODULE.into(),
        }],
        capabilities: BTreeMap::from([
            ("getCurrentPages".into(), CapabilitySupport::Partial),
            ("wx.getStorageSync".into(), CapabilitySupport::Full),
            ("wx.setStorageSync".into(), CapabilitySupport::Full),
        ]),
        ..Default::default()
    };
    for (id, source, scope) in [
        ("module:app.js", app, ModuleScope::App),
        (PAGE_MODULE, page, ModuleScope::Page),
    ] {
        manifest.modules.push(Module {
            id: id.into(),
            sha256: hex_digest(source.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope,
            dependencies: vec![],
        });
    }
    manifest.templates.push(Template {
        id: "template:pages/index/index.wxml".into(),
        wxml_ast: template_hash.clone(),
        bindings: vec![],
        wxs_modules: Default::default(),
    });
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(
        manifest,
        SessionConfig {
            session_id: SESSION.into(),
            engine,
            renderer_override: Some(RendererProfile::WebView),
            browser_view_enabled: true,
            // This tests retention semantics, not a cold View performance gate.
            view_execution: ViewExecutionPolicy {
                batch_timeout_ms: 2_000,
            },
            ..Default::default()
        },
    )
    .unwrap();
    for wire in [
        request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app.js","source":app},
                {"id":PAGE_MODULE,"source":page}],"blobs":{template_hash:wxml}}),
        ),
        request("launch", op::APP_LIFECYCLE, json!({"event":"launch"})),
        request("push", op::PAGE_PUSH, json!({"path":"pages/index/index"})),
    ] {
        success(&mut session, &wire);
    }
    (
        session,
        json!({"templateId":"template:pages/index/index.wxml","useSessionResources":true,
            "viewport":{"width":375,"height":667}}),
    )
}

struct Fixture {
    session: Session,
    render: Value,
    enable: BridgeEnvelope,
    contract: Value,
    lane: String,
    lifetime: String,
    next_sequence: u64,
}

impl Fixture {
    fn new(engine: EngineKind) -> Self {
        let (mut session, render) = build(engine);
        let enable = request("enable-2.1", op::VIEW_LIVE_ENABLE, json!({"version":"2.1"}));
        let (response, _) = success(&mut session, &enable);
        let contract = response["contract"].clone();
        assert_eq!(contract["version"], "2.1");
        assert_eq!(contract["requiresOwnerReplacementWhenFull"], false);
        assert_eq!(contract["nativeEditing"], false);
        assert_eq!(contract["transactionRetention"]["version"], "1.0");
        assert_eq!(contract["transactionRetention"]["firstSequence"], "1");
        assert_eq!(
            contract["transactionRetention"]["explicitConsumption"],
            true
        );
        let lane = contract["transactionRetention"]["laneId"]
            .as_str()
            .filter(|lane| !lane.is_empty())
            .expect("runtime-issued nonempty transaction lane")
            .to_owned();
        let lifetime = session.input_lifetime_revision().unwrap().to_string();
        assert_eq!(contract["inputLifetimeRevision"], lifetime);
        Self {
            session,
            render,
            enable,
            contract,
            lane,
            lifetime,
            next_sequence: 1,
        }
    }

    fn wire(&mut self, operation: &str, mut payload: Value) -> BridgeEnvelope {
        let sequence = self.next_sequence.to_string();
        self.next_sequence += 1;
        payload["version"] = json!("2.1");
        payload["inputLifetimeRevision"] = json!(self.lifetime);
        payload["transaction"] = json!({"laneId":self.lane,"sequence":sequence});
        request(
            &format!("live:{}:{sequence}", self.lane),
            operation,
            payload,
        )
    }

    fn prepare_wire(&mut self) -> BridgeEnvelope {
        self.wire(
            op::VIEW_LIVE_PREPARE,
            json!({"surfaceGeneration":"1","render":self.render}),
        )
    }

    fn prepare(&mut self) -> (BrowserLiveViewSubmission, BridgeEnvelope, Value) {
        let wire = self.prepare_wire();
        let (result, _) = success(&mut self.session, &wire);
        let submission = serde_json::from_value(result["submission"].clone()).unwrap();
        (submission, wire.clone(), receipt(&wire, &result))
    }

    fn abort_cycle(&mut self) -> (Vec<BridgeEnvelope>, Vec<Value>) {
        let (submission, prepare, first) = self.prepare();
        let abort = self.wire(
            op::VIEW_LIVE_ABORT,
            json!({"key":submission.key,"documentToken":submission.document_token}),
        );
        let (result, _) = success(&mut self.session, &abort);
        let second = receipt(&abort, &result);
        (vec![prepare, abort], vec![first, second])
    }

    fn consume_wire(&self, through: &str, receipts: Vec<Value>) -> BridgeEnvelope {
        request(
            &format!("consume:{}:{through}", self.lane),
            CONSUME,
            json!({"version":"2.1","inputLifetimeRevision":self.lifetime,
                "laneId":self.lane,"through":through,"receipts":receipts}),
        )
    }

    fn consume(&mut self, receipts: Vec<Value>) -> BridgeEnvelope {
        let through = receipts.last().unwrap()["sequence"].as_str().unwrap();
        let wire = self.consume_wire(through, receipts.clone());
        let (payload, batch) = success(&mut self.session, &wire);
        assert_eq!(payload, json!({"ok":true,"consumedThrough":through}));
        assert_eq!(batch.messages.len(), 1, "consume must not drain JS effects");
        wire
    }
}

fn receipt(wire: &BridgeEnvelope, payload: &Value) -> Value {
    let token = payload["consumptionReceipt"]
        .as_str()
        .filter(|token| !token.is_empty())
        .expect("complete final has a nonempty consumption receipt");
    json!({"sequence":wire.payload["transaction"]["sequence"],"token":token})
}

fn inspect(session: &mut Session) -> Value {
    let (payload, _) = success(
        session,
        &request(
            "inspect",
            op::MODULE_CALL,
            json!({"moduleId":PAGE_MODULE,"export":"inspect","args":[]}),
        ),
    );
    payload["result"][0].clone()
}

fn geometry(submission: &BrowserLiveViewSubmission) -> BrowserGeometryBatch {
    let mut nodes = vec![];
    let mut pending: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = pending.pop() {
        nodes.push(BrowserNodeGeometry {
            occurrence_id: node.occurrence_id().into(),
            border_box: ViewRect {
                x: 0.0,
                y: 0.0,
                width: 90.0,
                height: 32.0,
            },
            scroll_offset: ViewPoint { x: 0.0, y: 0.0 },
            scroll_extent: ViewSize {
                width: 90.0,
                height: 32.0,
            },
            client_size: ViewSize {
                width: 90.0,
                height: 32.0,
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

#[test]
fn consumption_negotiation_replays_same_lane_and_forbids_profile_renegotiation() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        for _ in 0..3 {
            let (replayed, _) = success(&mut fixture.session, &fixture.enable);
            assert_eq!(replayed["contract"], fixture.contract, "{engine:?}");
        }
        failure(
            &mut fixture.session,
            &request("downgrade", op::VIEW_LIVE_ENABLE, json!({"version":"2.0"})),
        );
        let (_, proofs) = fixture.abort_cycle();
        fixture.consume(proofs);
        let (replayed, _) = success(&mut fixture.session, &fixture.enable);
        assert_eq!(replayed["contract"], fixture.contract, "{engine:?}");

        let (mut legacy, _) = build(engine);
        success(
            &mut legacy,
            &request(
                "legacy-enable",
                op::VIEW_LIVE_ENABLE,
                json!({"version":"2.0"}),
            ),
        );
        failure(
            &mut legacy,
            &request("upgrade", op::VIEW_LIVE_ENABLE, json!({"version":"2.1"})),
        );
    }
}

#[test]
fn consumption_keeps_128_same_session_cycles_running_and_never_revives_old_ids() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let page = fixture.session.app_service().pages().current().unwrap().id;
        let mut oldest = None;
        for cycle in 0..128 {
            let (wires, proofs) = fixture.abort_cycle();
            oldest.get_or_insert_with(|| wires[0].clone());
            fixture.consume(proofs);
            // An incorrectly forgotten request would create a new pending
            // candidate and break the next legitimate same-session cycle.
            failure(&mut fixture.session, &wires[0]);
            let mut altered = wires[0].clone();
            altered.payload["render"]["viewport"]["width"] = json!(414);
            failure(&mut fixture.session, &altered);
            assert_eq!(
                fixture.session.app_service().pages().current().unwrap().id,
                page,
                "{engine:?}, cycle {cycle} must retain its actual page instance"
            );
        }
        failure(&mut fixture.session, &oldest.unwrap());
        let (_, proofs) = fixture.abort_cycle();
        fixture.consume(proofs);
        assert_eq!(inspect(&mut fixture.session)["calls"], 0, "{engine:?}");
    }
}

#[test]
fn consumption_preserves_complete_presented_final_and_ready_exact_replay() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (submission, _, first) = fixture.prepare();
        let permit_wire = fixture.wire(
            op::VIEW_LIVE_PERMIT,
            json!({"key":submission.key,"baseKey":submission.base_key,
                "documentToken":submission.document_token}),
        );
        let (permitted, _) = success(&mut fixture.session, &permit_wire);
        let second = receipt(&permit_wire, &permitted);
        let presented_wire = fixture.wire(
            op::VIEW_LIVE_PRESENTED,
            json!({"permit":permitted["permit"],"geometry":geometry(&submission)}),
        );
        let (presented, original) = success(&mut fixture.session, &presented_wire);
        assert_eq!(presented["committed"], true, "{engine:?}: {original:?}");
        assert_eq!(presented["key"], json!(submission.key));
        let third = receipt(&presented_wire, &presented);
        for _ in 0..3 {
            assert_eq!(fixture.session.dispatch(presented_wire.clone()), original);
        }
        assert_eq!(inspect(&mut fixture.session)["readies"], 1, "{engine:?}");
        fixture.consume(vec![first, second, third]);
        failure(&mut fixture.session, &presented_wire);
        assert_eq!(inspect(&mut fixture.session)["readies"], 1, "{engine:?}");
        assert!(fixture.session.is_browser_view_presented(), "{engine:?}");
    }
}

#[test]
fn consumption_invalid_receipts_reject_the_whole_prefix_without_losing_originals() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (wires, proofs) = fixture.abort_cycle();
        let originals: Vec<_> = wires
            .iter()
            .map(|wire| fixture.session.dispatch(wire.clone()))
            .collect();
        for variant in 0..4 {
            let mut invalid = fixture.consume_wire("2", proofs.clone());
            invalid.request_id = format!("bad-consume-{variant}");
            match variant {
                0 => invalid.payload["receipts"][1]["token"] = json!("wrong-final"),
                1 => invalid.payload["receipts"] = json!([proofs[1]]),
                2 => invalid.payload["receipts"] = json!([proofs[0], proofs[0]]),
                3 => invalid.payload["through"] = json!("3"),
                _ => unreachable!(),
            }
            failure(&mut fixture.session, &invalid);
            for (wire, original) in wires.iter().zip(&originals) {
                assert_eq!(fixture.session.dispatch(wire.clone()), *original);
            }
        }
        fixture.consume(proofs);
        for wire in &wires {
            failure(&mut fixture.session, wire);
        }
        let (_, next) = fixture.abort_cycle();
        fixture.consume(next);
    }
}

#[test]
fn consumption_lost_reply_retries_exact_metadata_without_caching_another_turn() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (_, proofs) = fixture.abort_cycle();
        let wire = fixture.consume_wire("2", proofs);
        // The peer discards the first reply; the runtime has already consumed.
        let original = fixture.session.dispatch(wire.clone());
        assert_eq!(
            correlated(&original, &wire),
            json!({"ok":true,"consumedThrough":"2"})
        );
        assert_eq!(original.messages.len(), 1);
        for _ in 0..100 {
            assert_eq!(fixture.session.dispatch(wire.clone()), original);
        }
        let (_, proofs) = fixture.abort_cycle();
        fixture.consume(proofs);
        // A delayed old consume remains the same success and cannot move the
        // retirement watermark backwards or reclaim a later live operation.
        assert_eq!(fixture.session.dispatch(wire), original);
        let (_, proofs) = fixture.abort_cycle();
        fixture.consume(proofs);
    }
}

#[test]
fn consumption_lane_sequence_and_canonical_request_ids_fail_before_admission() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let original = fixture.prepare_wire();
        for variant in 0..5 {
            let mut invalid = original.clone();
            match variant {
                0 => invalid.request_id = "arbitrary-replacement-id".into(),
                1 => invalid.payload["transaction"]["laneId"] = json!("another-owner"),
                2 => {
                    invalid.payload["transaction"]["sequence"] = json!("2");
                    invalid.request_id = format!("live:{}:2", fixture.lane);
                }
                3 => invalid.payload["transaction"]["sequence"] = json!("01"),
                4 => invalid.payload["transaction"]["sequence"] = json!(1),
                _ => unreachable!(),
            }
            failure(&mut fixture.session, &invalid);
        }
        let (prepared, original_final) = success(&mut fixture.session, &original);
        let first = receipt(&original, &prepared);
        let mut changed = original.clone();
        changed.payload["render"]["viewport"]["width"] = json!(414);
        failure(&mut fixture.session, &changed);
        assert_eq!(fixture.session.dispatch(original.clone()), original_final);
        let submission: BrowserLiveViewSubmission =
            serde_json::from_value(prepared["submission"].clone()).unwrap();
        let abort = fixture.wire(
            op::VIEW_LIVE_ABORT,
            json!({"key":submission.key,"documentToken":submission.document_token}),
        );
        let (aborted, _) = success(&mut fixture.session, &abort);
        fixture.consume(vec![first, receipt(&abort, &aborted)]);
        let mut relabelled = original.clone();
        relabelled.payload["transaction"]["sequence"] = json!("3");
        failure(&mut fixture.session, &relabelled);
        let mut renamed = original;
        renamed.request_id = format!("live:{}:3", fixture.lane);
        failure(&mut fixture.session, &renamed);
        let (_, proofs) = fixture.abort_cycle();
        fixture.consume(proofs);
    }
}

#[test]
fn consumption_mixed_batches_reject_all_requests_before_business_javascript() {
    for engine in engines() {
        for consume_first in [false, true] {
            let mut fixture = Fixture::new(engine);
            let (_, proofs) = fixture.abort_cycle();
            let consume = fixture.consume_wire("2", proofs.clone());
            let mutate = request(
                "must-not-run",
                op::MODULE_CALL,
                json!({"moduleId":PAGE_MODULE,"export":"mutate","args":[]}),
            );
            let messages = if consume_first {
                vec![consume.clone(), mutate.clone()]
            } else {
                vec![mutate.clone(), consume.clone()]
            };
            let refused = fixture.session.dispatch_batch(BridgeBatch::new(messages));
            assert_eq!(refused.messages.len(), 2, "{engine:?}: {refused:?}");
            assert_eq!(correlated(&refused, &consume)["ok"], false);
            assert_eq!(correlated(&refused, &mutate)["ok"], false);
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["calls"],
                0
            );
            assert_eq!(
                fixture.session.app_service().storage().get("business-call"),
                None
            );
            fixture.consume(proofs);
            success(&mut fixture.session, &mutate);
            assert_eq!(
                fixture
                    .session
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["calls"],
                1
            );
            assert_eq!(
                fixture.session.app_service().storage().get("business-call"),
                Some(&json!(true))
            );
        }
    }
}

#[test]
fn consumption_rejects_future_and_actually_retired_native_epochs() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (wires, proofs) = fixture.abort_cycle();
        let consume = fixture.consume_wire("2", proofs);
        let epoch = fixture.session.input_lifetime_revision().unwrap();
        let mut future = consume.clone();
        future.payload["inputLifetimeRevision"] = json!((epoch + 1).to_string());
        assert_eq!(
            failure(&mut fixture.session, &future)["error"]["code"],
            "ERR_CANCELLED"
        );
        assert_eq!(fixture.session.input_lifetime_revision(), Some(epoch));
        let mut foreign = consume.clone();
        foreign.payload["laneId"] = json!("another-owner");
        failure(&mut fixture.session, &foreign);
        for event in ["hide", "show"] {
            success(
                &mut fixture.session,
                &request(event, op::APP_LIFECYCLE, json!({"event":event})),
            );
        }
        assert!(fixture.session.input_lifetime_revision().unwrap() > epoch);
        assert_eq!(
            failure(&mut fixture.session, &consume)["error"]["code"],
            "ERR_CANCELLED"
        );
        for wire in wires {
            assert_eq!(
                failure(&mut fixture.session, &wire)["error"]["code"],
                "ERR_CANCELLED"
            );
        }
    }
}

struct CountingProvider {
    inner: SandboxProvider,
    hooks: Arc<AtomicUsize>,
}

impl HostApiProvider for CountingProvider {
    fn name(&self) -> &'static str {
        "consumption-host-repair-sentinel"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        self.hooks.fetch_add(1, Ordering::SeqCst);
        self.inner.capabilities()
    }

    fn sync_file_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.hooks.fetch_add(1, Ordering::SeqCst);
        self.inner.sync_file_snapshot()
    }

    fn supports_sync_filesystem(&self) -> bool {
        self.hooks.fetch_add(1, Ordering::SeqCst);
        self.inner.supports_sync_filesystem()
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.hooks.fetch_add(1, Ordering::SeqCst);
        self.inner.call(name, payload, context)
    }
}

#[test]
fn consumption_does_not_enter_normal_engine_or_provider_repair() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (_, proofs) = fixture.abort_cycle();
        let hooks = Arc::new(AtomicUsize::new(0));
        // Replacing the provider deliberately dirties the actual trusted host
        // mirror. A normal raw engine entry must repair it and call this peer.
        fixture.session.set_provider(Box::new(CountingProvider {
            inner: SandboxProvider::new(),
            hooks: hooks.clone(),
        }));
        // Do not use app_service_mut() here: that API deliberately enters the
        // engine and retires native input before granting a mutable host borrow.
        // set_provider alone leaves a live same-epoch dirty mirror sentinel.
        assert_eq!(hooks.load(Ordering::SeqCst), 0);
        let wire = fixture.consume(proofs);
        for _ in 0..3 {
            let (payload, batch) = success(&mut fixture.session, &wire);
            assert_eq!(payload, json!({"ok":true,"consumedThrough":"2"}));
            assert_eq!(batch.messages.len(), 1);
            assert_eq!(hooks.load(Ordering::SeqCst), 0, "{engine:?}");
        }
        assert_eq!(
            fixture
                .session
                .app_service()
                .pages()
                .current()
                .unwrap()
                .data["calls"],
            0
        );
        let observed = inspect(&mut fixture.session);
        assert!(
            hooks.load(Ordering::SeqCst) > 0,
            "repair sentinel must be live"
        );
        assert_eq!(observed["stored"], "");
        assert_eq!(observed["calls"], 0);
        assert_eq!(observed["readies"], 0);
    }
}

#[test]
fn consumption_metadata_is_bounded_before_decode_and_lost_ack_survives_expiry() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (originals, proofs) = fixture.abort_cycle();
        let mut oversized = fixture.consume_wire("2", proofs.clone());
        oversized.trace_id = Some("x".repeat(9 * 1024));
        failure(&mut fixture.session, &oversized);
        let mut payload_overflow = fixture.consume_wire("2", proofs.clone());
        payload_overflow.payload["receipts"][0]["token"] = json!("x".repeat(32 * 1024));
        failure(&mut fixture.session, &payload_overflow);
        for wire in &originals {
            assert!(success(&mut fixture.session, wire).0["consumptionReceipt"].is_string());
        }
        let mut expired = fixture.consume_wire("2", proofs.clone());
        expired.deadline_ns = Some(1);
        assert_eq!(
            failure(&mut fixture.session, &expired)["error"]["code"],
            "ERR_TIMEOUT"
        );
        let good = fixture.consume_wire("2", proofs);
        let (first, _) = success(&mut fixture.session, &good);
        // Once metadata has taken effect, the identical response shape is
        // recoverable even after a deadline expires. It never re-enters JS.
        assert_eq!(success(&mut fixture.session, &expired).0, first);
        assert_eq!(
            fixture
                .session
                .browser_live_transaction_retention()
                .unwrap()
                .retained_requests,
            0
        );
    }
}
