//! Prepared real-Session coverage for socket callback authority. Not executed by its author.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    HostAccount, HostApiEvent, HostRequest, HostServicesConfig, ProviderError, Session,
    SessionConfig, TrustedApplication,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "object-notifications";
const MODULE: &str = "module:app.js";
const PAIRS: [(&str, &str); 9] = [
    ("TCPSocket", "BindWifi"),
    ("TCPSocket", "Close"),
    ("TCPSocket", "Connect"),
    ("TCPSocket", "Error"),
    ("TCPSocket", "Message"),
    ("UDPSocket", "Close"),
    ("UDPSocket", "Error"),
    ("UDPSocket", "Listening"),
    ("UDPSocket", "Message"),
];
const SOURCE: &str = r#"
App({});
const sockets={},callbacks={},trace=[];
let pendingFailures=0;
function callback(label){return callbacks[label]||(callbacks[label]=function(value){trace.push({label:label,value:value,root:this===globalThis})})}
exports.create=function(type,label){const value=wx['create'+type]();sockets[label]={value:value,on:{},off:{}};for(const event of ['BindWifi','Close','Connect','Error','Listening','Message']){if(value['on'+event])sockets[label].on[event]=value['on'+event];if(value['off'+event])sockets[label].off[event]=value['off'+event]}return {value:true}};
exports.listen=function(object,event,label){const on=sockets[object].on[event],cb=callback(label);return {value:[on(cb)===undefined,on(cb)===undefined]}};
exports.remove=function(object,event,label){const off=sockets[object].off[event];return {value:(label===null?off():off(callback(label)))===undefined}};
exports.borrow=function(object,event,label,other){return {value:sockets[object].off[event].call(sockets[other].value,callback(label))===undefined}};
exports.read=function(){return {value:trace}};
exports.tryListen=function(object,event){try{sockets[object].on[event](callback('denied'));return {value:'admitted'}}catch(error){return {value:error.code||error.message}}};
exports.tryRemove=function(object,event){try{sockets[object].off[event]();return {value:'removed'}}catch(error){return {value:error.code||error.message}}};
exports.sameTurn=function(object,event){const on=sockets[object].on[event],off=sockets[object].off[event],cb=callback('same');on(cb);off(cb);on(cb);return {value:true}};
exports.close=function(object){sockets[object].value.close().catch(function(){});return {value:true}};
exports.poison=function(object,event){
 globalThis.__container_receive_native_event=globalThis.__container_api_call=function(){throw Error('guest transport')};
 sockets[object].value['off'+event]=function(){throw Error('guest facade')};
 __container_events.length=0;Object.freeze(__container_events);sockets[object].off[event]();return {value:true};
};
exports.failedConversion=function(object,event){__container_events.push({toJSON:function(){sockets[object].off[event]();throw Error('public conversion failed')}});return {value:true}};
exports.breakPending=function(object,event){
 wx.setStorageSync('socket-cleanup-storage',{preserved:true});
 for(const id of Object.keys(__container_api_pending))__container_api_pending[id].reject=function(){pendingFailures++;throw Error('poisoned resolver')};
 sockets[object].off[event]();return {value:true};
};
exports.pendingFailures=function(){return {value:pendingFailures}};
exports.forge=function(api,objectId,subscriptionId){__container_events.push({type:'api.call',id:999999,name:api,options:{objectId:objectId,subscriptionId:subscriptionId,action:'subscribe'}});return {value:true}};
exports.poisonThen=function(){Promise.prototype.then=function(){throw Error('public then')};return {value:true}};
exports.poisonPending=function(){for(const id of Object.keys(__container_api_pending))__container_api_pending[id].reject=function(){pendingFailures++;throw Error('poisoned disposer resolver')};return {value:true}};
exports.poisonResolve=function(){globalThis.__container_resolve_api=function(){throw Error('public resolver replaced')};return {value:true}};
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
        Self::policy(
            engine,
            CapabilitySupport::Full,
            CapabilitySupport::Full,
            true,
        )
    }
    fn policy(
        engine: EngineKind,
        on: CapabilitySupport,
        off: CapabilitySupport,
        registered_on: bool,
    ) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "socket-notification-fixture".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.modules.push(Module {
            id: MODULE.into(),
            sha256: hex_digest(SOURCE.as_bytes()),
            format: ModuleFormat::Commonjs,
            scope: ModuleScope::App,
            dependencies: Vec::new(),
        });
        let mut host = BTreeMap::new();
        let mut apis: Vec<String> = vec![
            "wx.createTCPSocket".into(),
            "wx.createUDPSocket".into(),
            "object:TCPSocket.close".into(),
            "object:UDPSocket.close".into(),
        ];
        for name in &apis {
            manifest
                .capabilities
                .insert(name.clone(), CapabilitySupport::Full);
            host.insert(name.clone(), CapabilitySupport::Full);
        }
        for (ty, event) in PAIRS {
            let producer = format!("object:{ty}.on{event}");
            manifest.capabilities.insert(producer.clone(), on);
            host.insert(producer.clone(), on);
            manifest
                .capabilities
                .insert(format!("object:{ty}.off{event}"), off);
            if registered_on {
                apis.push(producer);
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
                capabilities: host,
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
                    app_id: "socket-app".into(),
                    environment: "develop".into(),
                    version: "1".into(),
                    pack_root: root,
                },
                account: HostAccount {
                    principal_id: None,
                    epoch: u64::MAX,
                },
                apis,
                sync_values: BTreeMap::new(),
            })
            .unwrap();
        let mut f = Self {
            session,
            sequence: 0,
        };
        let init = f.raw(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
        for (ty, event) in PAIRS {
            assert_eq!(
                init.messages[0].payload["capabilities"][format!("object:{ty}.off{event}")],
                serde_json::to_value(off).unwrap()
            );
            assert_eq!(
                init.messages[0].payload["capabilities"][format!("object:{ty}.on{event}")],
                serde_json::to_value(if registered_on {
                    on
                } else {
                    CapabilitySupport::Unsupported
                })
                .unwrap()
            );
        }
        let launch = f.raw(op::APP_LIFECYCLE, json!({"event":"launch"}));
        assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
        f
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("socket-{}", self.sequence),
            operation,
            payload,
        ))
    }
    fn call(&mut self, export: &str, args: Value) -> Value {
        let b = self.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":export,"args":args}),
        );
        assert_eq!(b.messages[0].payload["ok"], true, "{b:?}");
        b.messages[0].payload["result"][0]["value"].clone()
    }
    fn calls(&mut self) -> Vec<(String, String, Value)> {
        self.session
            .take_host_requests()
            .into_iter()
            .filter_map(|r| {
                if let HostRequest::Call {
                    call_id,
                    method,
                    payload,
                    ..
                } = r
                {
                    Some((call_id, method, payload))
                } else {
                    None
                }
            })
            .collect()
    }
    fn create(&mut self, ty: &str, label: &str) -> (String, String) {
        self.call("create", json!([ty, label]));
        let calls = self.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0].1, format!("wx.create{ty}"));
        let object = calls[0].2["objectId"].as_str().unwrap().to_owned();
        self.session
            .complete_host_api_call(&calls[0].0, Ok(json!({})))
            .unwrap();
        (calls[0].0.clone(), object)
    }
    fn event(
        &mut self,
        subscription: &str,
        object: &str,
        event: &str,
        sequence: u64,
        value: Value,
    ) -> BridgeBatch {
        self.session
            .dispatch_host_api_event(HostApiEvent {
                session_id: SESSION.into(),
                account_epoch: u64::MAX,
                subscription_id: subscription.into(),
                object_id: Some(object.into()),
                event: Some(event.into()),
                sequence,
                value,
            })
            .unwrap()
    }
}
fn cancellation_ids(requests: &[HostRequest]) -> Vec<&str> {
    requests
        .iter()
        .filter_map(|r| {
            if let HostRequest::Cancel { call_id } = r {
                Some(call_id.as_str())
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn all_nine_pairs_cancel_actual_subscription_creators_with_exact_callback_and_object_identity() {
    for engine in engines() {
        for (ty, event) in PAIRS {
            let mut f = Fixture::new(engine);
            let (factory_a, object_a) = f.create(ty, "a");
            let (factory_b, object_b) = f.create(ty, "b");
            assert_eq!(
                f.call("listen", json!(["a", event, "shared"])),
                json!([true, true])
            );
            f.call("listen", json!(["a", event, "second"]));
            f.call("listen", json!(["b", event, "shared"]));
            let calls = f.calls();
            assert_eq!(calls.len(), 3, "{calls:?}");
            for call in &calls {
                assert_eq!(call.1, format!("object:{ty}.on{event}"));
                f.session
                    .complete_host_api_call(&call.0, Ok(json!({})))
                    .unwrap();
            }
            let a = calls[0].2["subscriptionId"].as_str().unwrap();
            let second = calls[1].2["subscriptionId"].as_str().unwrap();
            let b = calls[2].2["subscriptionId"].as_str().unwrap();
            f.event(a, &object_a, event, 1, json!({"sample":1}));
            f.event(second, &object_a, event, 1, json!({"sample":2}));
            f.event(b, &object_b, event, 1, json!({"sample":3}));
            f.call("remove", json!(["a", event, "unknown"]));
            assert!(f.session.take_host_requests().is_empty());
            assert_eq!(f.call("borrow", json!(["a", event, "shared", "b"])), true);
            let cancelled = f.session.take_host_requests();
            assert_eq!(cancellation_ids(&cancelled), vec![calls[0].0.as_str()]);
            assert!(!cancellation_ids(&cancelled).contains(&factory_a.as_str()));
            assert!(!cancellation_ids(&cancelled).contains(&factory_b.as_str()));
            assert!(
                !cancelled
                    .iter()
                    .any(|r| matches!(r, HostRequest::Call { .. })),
                "off must not close or destroy sockets: {cancelled:?}"
            );
            assert!(f
                .event(a, &object_a, event, 2, json!({"stale":true}))
                .messages
                .is_empty());
            f.event(second, &object_a, event, 2, json!({"sample":4}));
            f.event(b, &object_b, event, 2, json!({"sample":5}));
            assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 5);
            assert_eq!(f.call("remove", json!(["a", event, null])), true);
            let all = f.session.take_host_requests();
            assert_eq!(cancellation_ids(&all), vec![calls[1].0.as_str()]);
            f.event(b, &object_b, event, 3, json!({"sample":6}));
            assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 6);
            assert!(f
                .session
                .complete_host_api_call(&calls[0].0, Ok(json!({})))
                .unwrap()
                .messages
                .is_empty());
        }
    }
}

#[test]
fn independently_granted_off_needs_no_registered_or_enabled_on_and_denied_off_does_not_remove() {
    for engine in engines() {
        let mut f = Fixture::policy(
            engine,
            CapabilitySupport::Unsupported,
            CapabilitySupport::Full,
            false,
        );
        f.create("TCPSocket", "a");
        assert_eq!(f.call("tryRemove", json!(["a", "Message"])), "removed");
        assert_eq!(
            f.call("tryListen", json!(["a", "Message"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert!(f.calls().is_empty());
        let mut f = Fixture::policy(
            engine,
            CapabilitySupport::Full,
            CapabilitySupport::Unsupported,
            true,
        );
        let (_, object) = f.create("UDPSocket", "a");
        f.call("listen", json!(["a", "Message", "one"]));
        let calls = f.calls();
        let id = calls[0].2["subscriptionId"].as_str().unwrap();
        assert_eq!(
            f.call("tryRemove", json!(["a", "Message"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert!(f.session.take_host_requests().is_empty());
        f.event(id, &object, "Message", 1, json!({"still":true}));
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 1);
    }
}

#[test]
fn receiver_event_session_epoch_and_sequence_fences_precede_private_ingress() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let (_, object) = f.create("TCPSocket", "a");
        f.call("listen", json!(["a", "Message", "one"]));
        let calls = f.calls();
        let valid = HostApiEvent {
            session_id: SESSION.into(),
            account_epoch: u64::MAX,
            subscription_id: calls[0].2["subscriptionId"].as_str().unwrap().into(),
            object_id: Some(object),
            event: Some("Message".into()),
            sequence: 9_007_199_254_740_993,
            value: json!({"remoteInfo":{"address":"127.0.0.1","family":"IPv4","port":9000},"localInfo":{"address":"127.0.0.1","family":"IPv4","port":8000}}),
        };
        for index in 0..5 {
            let mut bad = valid.clone();
            match index {
                0 => bad.session_id = "foreign".into(),
                1 => bad.account_epoch = 0,
                2 => bad.object_id = None,
                3 => bad.object_id = Some("native-object-999".into()),
                _ => bad.event = Some("Error".into()),
            };
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
fn queued_remove_readd_and_raw_public_subscription_requests_cannot_steal_callback_authority() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let (_, object) = f.create("TCPSocket", "a");
        f.call("sameTurn", json!(["a", "Message"]));
        let calls = f.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        let id = calls[0].2["subscriptionId"].as_str().unwrap();
        f.call("forge", json!(["object:TCPSocket.onError", object, id]));
        assert!(f.calls().is_empty());
        f.call("forge", json!(["object:UDPSocket.onMessage", object, id]));
        assert!(f.calls().is_empty());
        f.call(
            "forge",
            json!([
                "object:TCPSocket.onMessage",
                object,
                "finite-subscription-18446744073709551615"
            ]),
        );
        assert!(f.calls().is_empty());
        f.event(id, &object, "Message", 1, json!({"live":true}));
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 1);
    }
}

#[test]
fn poisoned_public_transport_and_failed_public_conversion_still_cancel_real_creators() {
    for engine in engines() {
        for export in ["poison", "failedConversion"] {
            let mut f = Fixture::new(engine);
            let (factory, object) = f.create("UDPSocket", "a");
            f.call("listen", json!(["a", "Error", "one"]));
            let calls = f.calls();
            f.session
                .complete_host_api_call(&calls[0].0, Ok(json!({})))
                .unwrap();
            let _ = f.raw(
                op::MODULE_CALL,
                json!({"moduleId":MODULE,"export":export,"args":["a","Error"]}),
            );
            let cancelled = f.session.take_host_requests();
            assert_eq!(cancellation_ids(&cancelled), vec![calls[0].0.as_str()]);
            assert!(!cancellation_ids(&cancelled).contains(&factory.as_str()));
            assert!(f
                .event(
                    calls[0].2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Error",
                    1,
                    json!({"stale":true})
                )
                .messages
                .is_empty());
        }
    }
}

#[test]
fn clear_all_cancels_every_subscription_before_ack_even_when_guest_reject_throws() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let (factory, object) = f.create("TCPSocket", "a");
        f.call("listen", json!(["a", "Message", "first"]));
        f.call("listen", json!(["a", "Message", "second"]));
        let calls = f.calls();
        assert_eq!(calls.len(), 2);
        let _ = f.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"breakPending","args":["a","Message"]}),
        );
        let cancelled = f.session.take_host_requests();
        for call in &calls {
            assert!(cancellation_ids(&cancelled).contains(&call.0.as_str()));
            assert!(f
                .event(
                    call.2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Message",
                    1,
                    json!({"stale":true})
                )
                .messages
                .is_empty());
        }
        assert!(!cancellation_ids(&cancelled).contains(&factory.as_str()));
        assert_eq!(f.call("pendingFailures", json!([])), 2);
        assert_eq!(
            f.session
                .app_service()
                .storage()
                .get("socket-cleanup-storage"),
            Some(&json!({"preserved":true}))
        );
    }
}

#[test]
fn factory_failure_retires_only_its_object_and_saved_off_remains_idempotent() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        f.call("create", json!(["TCPSocket", "a"]));
        let factory = f.calls();
        let object = factory[0].2["objectId"].as_str().unwrap().to_owned();
        let (_, other) = f.create("TCPSocket", "b");
        f.call("listen", json!(["a", "Error", "shared"]));
        f.call("listen", json!(["b", "Error", "shared"]));
        let calls = f.calls();
        f.session
            .complete_host_api_call(
                &factory[0].0,
                Err(ProviderError::cancelled("factory failed").into()),
            )
            .unwrap();
        let cancelled = f.session.take_host_requests();
        assert!(cancellation_ids(&cancelled).contains(&calls[0].0.as_str()));
        assert!(!cancellation_ids(&cancelled).contains(&calls[1].0.as_str()));
        assert!(f
            .event(
                calls[0].2["subscriptionId"].as_str().unwrap(),
                &object,
                "Error",
                1,
                json!({"stale":true})
            )
            .messages
            .is_empty());
        f.event(
            calls[1].2["subscriptionId"].as_str().unwrap(),
            &other,
            "Error",
            1,
            json!({"live":true}),
        );
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 1);
        assert_eq!(f.call("tryListen", json!(["a", "Error"])), "ERR_CANCELLED");
        assert_eq!(f.call("tryRemove", json!(["a", "Error"])), "removed");
    }
}

#[test]
fn udp_close_failure_preserves_owner_success_retires_after_final_close_and_tcp_close_stays_live() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let (udp_factory, udp) = f.create("UDPSocket", "udp");
        let (tcp_factory, tcp) = f.create("TCPSocket", "tcp");
        f.call("listen", json!(["udp", "Close", "closed"]));
        f.call("listen", json!(["udp", "Message", "message"]));
        f.call("listen", json!(["tcp", "Message", "tcp"]));
        let subscriptions = f.calls();
        f.call("close", json!(["udp"]));
        let failed = f.calls();
        f.session
            .complete_host_api_call(
                &failed[0].0,
                Err(ProviderError::cancelled("close failed").into()),
            )
            .unwrap();
        assert!(f.session.take_host_requests().is_empty());
        f.event(
            subscriptions[1].2["subscriptionId"].as_str().unwrap(),
            &udp,
            "Message",
            1,
            json!({"afterFailure":true}),
        );
        f.call("close", json!(["udp"]));
        f.call("close", json!(["tcp"]));
        let closes = f.calls();
        assert_eq!(closes.len(), 2);
        f.event(
            subscriptions[0].2["subscriptionId"].as_str().unwrap(),
            &udp,
            "Close",
            1,
            json!({}),
        );
        f.session
            .complete_host_api_call(&closes[0].0, Ok(json!({})))
            .unwrap();
        f.session
            .complete_host_api_call(&closes[1].0, Ok(json!({})))
            .unwrap();
        let cancelled = f.session.take_host_requests();
        for call in &subscriptions[..2] {
            assert!(
                cancellation_ids(&cancelled).contains(&call.0.as_str()),
                "{cancelled:?}"
            );
        }
        assert!(cancellation_ids(&cancelled).contains(&udp_factory.as_str()));
        assert!(!cancellation_ids(&cancelled).contains(&tcp_factory.as_str()));
        assert!(!cancellation_ids(&cancelled).contains(&subscriptions[2].0.as_str()));
        assert!(f
            .event(
                subscriptions[1].2["subscriptionId"].as_str().unwrap(),
                &udp,
                "Message",
                2,
                json!({"stale":true})
            )
            .messages
            .is_empty());
        f.event(
            subscriptions[2].2["subscriptionId"].as_str().unwrap(),
            &tcp,
            "Message",
            1,
            json!({"live":true}),
        );
        assert_eq!(f.call("read", json!([])).as_array().unwrap().len(), 3);
        assert_eq!(
            f.call("tryListen", json!(["udp", "Message"])),
            "ERR_CANCELLED"
        );
        assert_eq!(f.call("tryRemove", json!(["udp", "Message"])), "removed");
        assert_eq!(f.call("tryListen", json!(["tcp", "Message"])), "admitted");
    }
}

#[test]
fn terminal_retirement_and_identity_revocation_cancel_real_resources_without_off_grants() {
    for engine in engines() {
        for revoked in [false, true] {
            let mut f = Fixture::policy(
                engine,
                CapabilitySupport::Full,
                CapabilitySupport::Unsupported,
                true,
            );
            let (factory, object) = f.create("TCPSocket", "a");
            f.call("listen", json!(["a", "Message", "one"]));
            let calls = f.calls();
            let cancelled = if revoked {
                f.session.revoke_host_services()
            } else {
                let unloaded = f.raw(op::APP_LIFECYCLE, json!({"event":"unload"}));
                assert_eq!(unloaded.messages[0].payload["ok"], true, "{unloaded:?}");
                f.session.take_host_requests()
            };
            assert!(cancellation_ids(&cancelled).contains(&calls[0].0.as_str()));
            assert!(cancellation_ids(&cancelled).contains(&factory.as_str()));
            assert!(f
                .event(
                    calls[0].2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Message",
                    1,
                    json!({"stale":true})
                )
                .messages
                .is_empty());
        }
    }
}

#[test]
fn udp_disposal_cancels_all_creators_and_settles_its_private_hook_after_old_resolvers_throw() {
    for engine in engines() {
        let mut f = Fixture::new(engine);
        let (factory, object) = f.create("UDPSocket", "a");
        f.call("listen", json!(["a", "Message", "first"]));
        f.call("listen", json!(["a", "Message", "second"]));
        let calls = f.calls();
        f.call("poisonPending", json!([]));
        f.call("close", json!(["a"]));
        let close = f.calls();
        assert_eq!(close.len(), 1);
        let _ = f.session.complete_host_api_call(&close[0].0, Ok(json!({})));
        let cancelled = f.session.take_host_requests();
        assert!(cancellation_ids(&cancelled).contains(&factory.as_str()));
        for call in &calls {
            assert!(
                cancellation_ids(&cancelled).contains(&call.0.as_str()),
                "{cancelled:?}"
            );
            assert!(f
                .event(
                    call.2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Message",
                    1,
                    json!({"stale":true})
                )
                .messages
                .is_empty());
        }
        assert_eq!(f.call("pendingFailures", json!([])), 2);
        assert_eq!(
            f.call("tryListen", json!(["a", "Message"])),
            "ERR_CANCELLED"
        );
        assert_eq!(f.call("tryRemove", json!(["a", "Message"])), "removed");
    }
}

#[test]
fn native_retirement_revokes_callback_authority_even_if_the_public_resolver_is_replaced() {
    for engine in engines() {
        for poison in ["poisonResolve", "poisonThen"] {
            for failed_factory in [false, true] {
                let mut f = Fixture::new(engine);
                let (completion, object) = if failed_factory {
                    f.call("create", json!(["UDPSocket", "a"]));
                    let calls = f.calls();
                    (
                        calls[0].0.clone(),
                        calls[0].2["objectId"].as_str().unwrap().to_owned(),
                    )
                } else {
                    let (_, object) = f.create("UDPSocket", "a");
                    f.call("close", json!(["a"]));
                    let calls = f.calls();
                    (calls[0].0.clone(), object)
                };
                f.call("listen", json!(["a", "Message", "one"]));
                let subscriptions = f.calls();
                f.call(poison, json!([]));
                let result = if failed_factory {
                    Err(ProviderError::cancelled("factory failed").into())
                } else {
                    Ok(json!({}))
                };
                let _ = f.session.complete_host_api_call(&completion, result);
                let cancelled = f.session.take_host_requests();
                assert!(
                    cancellation_ids(&cancelled).contains(&subscriptions[0].0.as_str()),
                    "{cancelled:?}"
                );
                assert!(f
                    .event(
                        subscriptions[0].2["subscriptionId"].as_str().unwrap(),
                        &object,
                        "Message",
                        1,
                        json!({"stale":true})
                    )
                    .messages
                    .is_empty());
                assert_eq!(
                    f.call("tryListen", json!(["a", "Message"])),
                    "ERR_CANCELLED"
                );
                assert_eq!(f.call("tryRemove", json!(["a", "Message"])), "removed");
            }
        }
    }
}
