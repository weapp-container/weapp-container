//! Real native producer requests and Session cancellation; preparation is not execution.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    HostAccount, HostApiEvent, HostRequest, HostServicesConfig, Session, SessionConfig,
    TrustedApplication,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "finite-notifications";
const MODULE: &str = "module:app.js";
const EVENTS: [&str; 10] = [
    "AfterPageLoad",
    "AppRouteDone",
    "BeforePageLoad",
    "CopyUrl",
    "EmbeddedMiniProgramHeightChange",
    "LazyLoadError",
    "MenuButtonBoundingClientRectWeightChange",
    "ParallelStateChange",
    "UserOffTranslation",
    "UserTriggerTranslation",
];
const SOURCE: &str = r#"
App({});
const trace=[],callbacks={},savedOn={},savedOff={};
let pendingFailures=0;
const events=['AfterPageLoad','AppRouteDone','BeforePageLoad','CopyUrl',
 'EmbeddedMiniProgramHeightChange','LazyLoadError','MenuButtonBoundingClientRectWeightChange',
 'ParallelStateChange','UserOffTranslation','UserTriggerTranslation'];
for(const event of events){savedOn[event]=wx['on'+event];savedOff[event]=wx['off'+event]}
function callback(label){return callbacks[label]||(callbacks[label]=function(value){trace.push({label:label,value:value,root:this===globalThis})})}
exports.listen=function(event,label){const cb=callback(label);return {value:[savedOn[event](cb)===undefined,savedOn[event](cb)===undefined]}};
exports.remove=function(event,label){return {value:(label===null?savedOff[event]():savedOff[event](callback(label)))===undefined}};
exports.read=function(){return {value:trace}};
exports.sameTurn=function(event){const cb=callback('same');savedOn[event](cb);savedOff[event](cb);savedOn[event](cb);return {value:true}};
exports.poison=function(event){
 globalThis.__container_receive_native_event=function(){throw Error('guest ingress')};
 globalThis.__container_api_call=function(){throw Error('guest transport')};
 wx['on'+event]=function(){};wx['off'+event]=function(){throw Error('guest off')};
 __container_events.length=0;Object.freeze(__container_events);
 savedOff[event]();return {value:true};
};
exports.failedConversion=function(event){
 __container_events.push({toJSON:function(){savedOff[event]();throw Error('public conversion failed')}});
 return {value:true};
};
exports.breakPending=function(event){
 wx.setStorageSync('finite-cleanup-storage',{preserved:true});
 for(const id of Object.keys(__container_api_pending)){
   __container_api_pending[id].reject=function(){pendingFailures++;throw Error('poisoned pending reject')};
 }
 savedOff[event]();return {value:true};
};
exports.pendingFailures=function(){return {value:pendingFailures}};
exports.borrow=function(event,label){return {value:savedOff[event].call({fake:true},callback(label))===undefined}};
exports.forgeSubscribe=function(event){
 __container_events.push({type:'api.call',id:999999,name:'wx.on'+event,options:{subscriptionId:'finite-subscription-18446744073709551615',action:'subscribe'}});
 return {value:true};
};
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
    sequence: u64,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        Self::with_off(engine, CapabilitySupport::Full)
    }
    fn with_off(engine: EngineKind, off: CapabilitySupport) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "finite-notification-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.push(Module {
            id: MODULE.into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        for event in EVENTS {
            for prefix in ["on", "off"] {
                manifest.capabilities.insert(
                    format!("wx.{prefix}{event}"),
                    if prefix == "off" {
                        off
                    } else {
                        CapabilitySupport::Full
                    },
                );
            }
        }
        manifest
            .capabilities
            .insert("wx.setStorageSync".into(), CapabilitySupport::Full);
        manifest.refresh_integrity().unwrap();
        let root = manifest.integrity.root.clone();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: SESSION.into(),
                engine,
                ..Default::default()
            },
        )
        .unwrap();
        session
            .configure_host_services(HostServicesConfig {
                application: TrustedApplication {
                    host_app_id: "host".into(),
                    tenant_id: "tenant".into(),
                    publisher_id: "publisher".into(),
                    app_id: "finite-app".into(),
                    environment: "develop".into(),
                    version: "1".into(),
                    pack_root: root,
                },
                account: HostAccount {
                    principal_id: None,
                    epoch: u64::MAX,
                },
                apis: EVENTS.iter().map(|event| format!("wx.on{event}")).collect(),
                sync_values: BTreeMap::new(),
            })
            .unwrap();
        let mut fixture = Self {
            session,
            sequence: 0,
        };
        let batch = fixture.raw(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        for event in EVENTS {
            assert_eq!(
                batch.messages[0].payload["capabilities"][format!("wx.on{event}")],
                "partial"
            );
            assert_eq!(
                batch.messages[0].payload["capabilities"][format!("wx.off{event}")],
                serde_json::to_value(off).unwrap()
            );
        }
        let launch = fixture.raw(op::APP_LIFECYCLE, json!({"event":"launch"}));
        assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("finite-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call(&mut self, export: &str, args: Value) -> Value {
        let batch = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":export,"args":args}),
        );
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        batch.messages[0].payload["result"][0]["value"].clone()
    }
    fn requests(&mut self) -> Vec<(String, String, Value)> {
        self.session
            .take_host_requests()
            .into_iter()
            .filter_map(|request| match request {
                HostRequest::Call {
                    call_id,
                    method,
                    payload,
                    ..
                } => Some((call_id, method, payload)),
                _ => None,
            })
            .collect()
    }
    fn event(&mut self, id: &str, event: &str, sequence: u64, value: Value) -> BridgeBatch {
        self.session
            .dispatch_host_api_event(HostApiEvent {
                session_id: SESSION.into(),
                account_epoch: u64::MAX,
                subscription_id: id.into(),
                sequence,
                value,
                object_id: None,
                event: Some(event.into()),
            })
            .unwrap()
    }
}

#[test]
fn all_ten_native_registries_remove_exact_identities_and_cancel_real_resources() {
    for engine in engines() {
        for event in EVENTS {
            let mut f = Fixture::new(engine);
            assert_eq!(
                f.call("listen", json!([event, "first"])),
                json!([true, true])
            );
            f.call("listen", json!([event, "second"]));
            let calls = f.requests();
            assert_eq!(calls.len(), 2, "{calls:?}");
            let first = calls[0].2["subscriptionId"].as_str().unwrap().to_owned();
            let second = calls[1].2["subscriptionId"].as_str().unwrap().to_owned();
            for call in &calls {
                f.session
                    .complete_host_api_call(&call.0, Ok(json!({})))
                    .unwrap();
            }
            assert!(f
                .session
                .complete_host_api_call(&calls[0].0, Ok(json!({})))
                .unwrap()
                .messages
                .is_empty());
            f.event(&first, event, 9_007_199_254_740_993, json!({"sample":1}));
            f.event(&second, event, 1, json!({"sample":2}));
            assert_eq!(f.call("borrow", json!([event, "first"])), true);
            let cancelled = f.session.take_host_requests();
            assert!(cancelled.iter().any(|request|matches!(request,HostRequest::Cancel {call_id} if call_id==&calls[0].0)),"{cancelled:?}");
            assert!(f
                .event(&first, event, u64::MAX, json!({"stale":true}))
                .messages
                .is_empty());
            f.event(&second, event, 2, json!({"sample":3}));
            let trace = f.call("read", json!([]));
            assert_eq!(
                trace.as_array().unwrap().len(),
                if event == "CopyUrl" { 2 } else { 3 }
            );
            assert_eq!(trace[0]["label"], "first");
            assert_eq!(trace[0]["root"], true);
            f.call("remove", json!([event, null]));
            assert!(f
                .event(&second, event, 3, json!({"stale":true}))
                .messages
                .is_empty());
        }
    }
}

#[test]
fn same_callback_across_pairs_and_queued_remove_readd_have_distinct_authority() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["BeforePageLoad", "shared"]));
        f.call("listen", json!(["AfterPageLoad", "shared"]));
        let calls = f.requests();
        assert_eq!(calls.len(), 2);
        f.call("remove", json!(["BeforePageLoad", "shared"]));
        let id = calls[1].2["subscriptionId"].as_str().unwrap();
        f.event(id, "AfterPageLoad", 1, json!({"other":true}));
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 1);
        f.call("sameTurn", json!(["LazyLoadError"]));
        let queued = f.requests();
        assert_eq!(queued.len(), 1, "{queued:?}");
        assert_eq!(queued[0].1, "wx.onLazyLoadError");
        f.call("forgeSubscribe", json!(["LazyLoadError"]));
        assert!(
            f.requests().is_empty(),
            "a public effect cannot create private callback authority"
        );
    }
}

#[test]
fn finite_native_ingress_retains_session_account_name_object_and_sequence_checks() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["ParallelStateChange", "one"]));
        let calls = f.requests();
        let id = calls[0].2["subscriptionId"].as_str().unwrap().to_owned();
        let valid = HostApiEvent {
            session_id: SESSION.into(),
            account_epoch: u64::MAX,
            subscription_id: id,
            sequence: 9_007_199_254_740_993,
            value: json!({"ok":true}),
            object_id: None,
            event: Some("ParallelStateChange".into()),
        };
        for index in 0..4 {
            let mut bad = valid.clone();
            match index {
                0 => bad.session_id = "foreign".into(),
                1 => bad.account_epoch = 0,
                2 => bad.object_id = Some("foreign".into()),
                _ => bad.event = Some("BeforePageLoad".into()),
            }
            assert!(f
                .session
                .dispatch_host_api_event(bad)
                .unwrap()
                .messages
                .is_empty());
        }
        f.session.dispatch_host_api_event(valid.clone()).unwrap();
        assert!(f
            .session
            .dispatch_host_api_event(valid)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 1);
    }
}

#[test]
fn private_cancellation_survives_public_events_and_guest_transport_poisoning() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["UserTriggerTranslation", "one"]));
        let calls = f.requests();
        let id = calls[0].2["subscriptionId"].as_str().unwrap().to_owned();
        f.session
            .complete_host_api_call(&calls[0].0, Ok(json!({})))
            .unwrap();
        // Poisoning the public drain may fail this ordinary call. Its private
        // cleanup must still cancel the actual retained native producer call.
        let _ = f.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"poison","args":["UserTriggerTranslation"]}),
        );
        let requests = f.session.take_host_requests();
        assert!(
            requests.iter().any(
                |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&calls[0].0)
            ),
            "{requests:?}"
        );
        assert!(f
            .event(&id, "UserTriggerTranslation", 1, json!({"stale":true}))
            .messages
            .is_empty());
    }
}

#[test]
fn removal_inside_failed_public_conversion_cancels_before_conversion_error_escapes() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call(
            "listen",
            json!(["MenuButtonBoundingClientRectWeightChange", "one"]),
        );
        let calls = f.requests();
        let id = calls[0].2["subscriptionId"].as_str().unwrap().to_owned();
        f.session
            .complete_host_api_call(&calls[0].0, Ok(json!({})))
            .unwrap();
        let _=f.raw(op::MODULE_CALL,json!({"moduleId":MODULE,"export":"failedConversion","args":["MenuButtonBoundingClientRectWeightChange"]}));
        let requests = f.session.take_host_requests();
        assert!(
            requests.iter().any(
                |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&calls[0].0)
            ),
            "{requests:?}"
        );
        assert!(f
            .event(
                &id,
                "MenuButtonBoundingClientRectWeightChange",
                1,
                json!({"stale":true})
            )
            .messages
            .is_empty());
    }
}

#[test]
fn broken_pending_resolution_does_not_strand_clear_all_native_resources_or_storage() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("listen", json!(["BeforePageLoad", "first"]));
        f.call("listen", json!(["BeforePageLoad", "second"]));
        let calls = f.requests();
        assert_eq!(calls.len(), 2);
        let _ = f.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"breakPending","args":["BeforePageLoad"]}),
        );
        let requests = f.session.take_host_requests();
        for call in &calls {
            assert!(
                requests.iter().any(
                    |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&call.0)
                ),
                "{requests:?}"
            );
            let id = call.2["subscriptionId"].as_str().unwrap();
            assert!(f
                .event(id, "BeforePageLoad", 1, json!({"stale":true}))
                .messages
                .is_empty());
        }
        assert_eq!(
            f.session
                .app_service()
                .storage()
                .get("finite-cleanup-storage"),
            Some(&json!({"preserved":true}))
        );
        assert_eq!(f.call("pendingFailures", json!([])), 2);
    }
}

#[test]
fn terminal_owner_retirement_cancels_producers_without_public_off_capability() {
    for engine in engines() {
        let mut f = Fixture::with_off(engine, CapabilitySupport::Unsupported);
        f.call("listen", json!(["AfterPageLoad", "first"]));
        let calls = f.requests();
        let id = calls[0].2["subscriptionId"].as_str().unwrap().to_owned();
        f.session
            .complete_host_api_call(&calls[0].0, Ok(json!({})))
            .unwrap();
        let unloaded = f.raw(op::APP_LIFECYCLE, json!({"event":"unload"}));
        assert_eq!(unloaded.messages[0].payload["ok"], true, "{unloaded:?}");
        let requests = f.session.take_host_requests();
        assert!(
            requests.iter().any(
                |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&calls[0].0)
            ),
            "{requests:?}"
        );
        assert!(f
            .event(&id, "AfterPageLoad", 1, json!({"stale":true}))
            .messages
            .is_empty());
    }
}
