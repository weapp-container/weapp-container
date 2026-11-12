//! Authored real-Session audio cleanup regressions. Native execution belongs to root.
#![cfg(any(feature = "quickjs-native", feature = "v8-native"))]
use container_bridge::{op, BridgeBatch, BridgeEnvelope};
use container_core::EngineKind;
use container_ir::{
    hex_digest, CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope,
};
use container_runtime::{
    validate_host_services_config, HostAccount, HostApiEvent, HostRequest, HostServicesConfig,
    ProviderError, Session, SessionConfig, TrustedApplication,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

const SESSION: &str = "inner-audio-notifications";
const MODULE: &str = "module:app.js";
const EVENTS: [&str; 10] = [
    "Canplay",
    "Ended",
    "Error",
    "Pause",
    "Play",
    "Seeked",
    "Seeking",
    "Stop",
    "TimeUpdate",
    "Waiting",
];
// Audio install shape supplied by this runtime policy fixture. Its validation
// must not depend on the source layout of an independently versioned host SDK.
const METHODS: [&str; 17] = [
    "wx.createInnerAudioContext",
    "object:InnerAudioContext.src",
    "object:InnerAudioContext.autoplay",
    "object:InnerAudioContext.loop",
    "object:InnerAudioContext.startTime",
    "object:InnerAudioContext.volume",
    "object:InnerAudioContext.playbackRate",
    "object:InnerAudioContext.paused",
    "object:InnerAudioContext.currentTime",
    "object:InnerAudioContext.duration",
    "object:InnerAudioContext.buffered",
    "object:InnerAudioContext.play",
    "object:InnerAudioContext.pause",
    "object:InnerAudioContext.stop",
    "object:InnerAudioContext.seek",
    "object:InnerAudioContext.destroy",
    "wx.getAccountInfoSync",
];
const SOURCE: &str = r#"
App({});
const objects={},callbacks={},trace=[];
let pendingFailures=0;
function callback(label){return callbacks[label]||(callbacks[label]=function(value){trace.push({label:label,value:value,root:this===globalThis})})}
exports.create=function(label){const value=wx.createInnerAudioContext();objects[label]={value:value,on:{},off:{}};for(const event of ['Canplay','Ended','Error','Pause','Play','Seeked','Seeking','Stop','TimeUpdate','Waiting']){objects[label].on[event]=value['on'+event];objects[label].off[event]=value['off'+event]}return {value:true}};
exports.listen=function(object,event,label){const on=objects[object].on[event],cb=callback(label);return {value:[on(cb)===undefined,on(cb)===undefined]}};
exports.remove=function(object,event,label){const off=objects[object].off[event];return {value:(label===null?off():off(callback(label)))===undefined}};
exports.borrow=function(object,event,label,other){return {value:objects[object].off[event].call(objects[other].value,callback(label))===undefined}};
exports.tryListen=function(object,event){try{objects[object].on[event](callback('denied'));return {value:'admitted'}}catch(error){return {value:error.code||error.message}}};
exports.tryRemove=function(object,event){try{objects[object].off[event]();return {value:'removed'}}catch(error){return {value:error.code||error.message}}};
exports.read=function(){return {value:trace}};
exports.sameTurn=function(object,event){const on=objects[object].on[event],off=objects[object].off[event],cb=callback('same');on(cb);off(cb);on(cb);return {value:true}};
exports.destroy=function(object){objects[object].value.destroy().catch(function(){});return {value:true}};
exports.control=function(object,name){objects[object].value[name](2).catch(function(){});return {value:true}};
exports.poison=function(object,event){globalThis.__container_receive_native_event=globalThis.__container_api_call=function(){throw Error('guest transport')};objects[object].value['off'+event]=function(){throw Error('guest facade')};__container_events.length=0;Object.freeze(__container_events);objects[object].off[event]();return {value:true}};
exports.failedConversion=function(object,event){__container_events.push({toJSON:function(){objects[object].off[event]();throw Error('public conversion failed')}});return {value:true}};
exports.breakPending=function(object,event){for(const id of Object.keys(__container_api_pending))__container_api_pending[id].reject=function(){pendingFailures++;throw Error('poisoned resolver')};objects[object].off[event]();return {value:true}};
exports.pendingFailures=function(){return {value:pendingFailures}};
exports.poisonThen=function(){Promise.prototype.then=function(){throw Error('public then')};return {value:true}};
exports.poisonResolve=function(){globalThis.__container_resolve_api=function(){throw Error('public resolver replaced')};return {value:true}};
exports.forge=function(api,objectId,subscriptionId){__container_events.push({type:'api.call',id:999999,name:api,options:{objectId:objectId,subscriptionId:subscriptionId,action:'unsubscribe'}});return {value:true}};
"#;

fn engines() -> Vec<EngineKind> {
    vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ]
}

fn trusted_config(pack_root: String, apis: Vec<String>) -> HostServicesConfig {
    HostServicesConfig {
        application: TrustedApplication {
            host_app_id: "host".into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: "audio-app".into(),
            environment: "develop".into(),
            version: "1".into(),
            pack_root,
        },
        account: HostAccount {
            principal_id: None,
            epoch: u64::MAX,
        },
        apis,
        sync_values: BTreeMap::new(),
    }
}

fn audio_apis(producers: bool, legacy_off: bool) -> Vec<String> {
    // getAccountInfoSync is installed by runtime, not declared by the provider.
    let mut apis: Vec<String> = METHODS[..METHODS.len() - 1]
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    for event in EVENTS {
        if producers {
            apis.push(format!("object:InnerAudioContext.on{event}"));
        }
        if legacy_off {
            apis.push(format!("object:InnerAudioContext.off{event}"));
        }
    }
    apis
}

#[derive(Clone)]
struct Policy {
    on_manifest: Option<CapabilitySupport>,
    on_host: Option<CapabilitySupport>,
    off_manifest: Option<CapabilitySupport>,
    off_host: Option<CapabilitySupport>,
    producers: bool,
    legacy_off: bool,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            on_manifest: Some(CapabilitySupport::Full),
            on_host: Some(CapabilitySupport::Full),
            off_manifest: Some(CapabilitySupport::Full),
            off_host: Some(CapabilitySupport::Full),
            producers: true,
            legacy_off: true,
        }
    }
}

struct Fixture {
    session: Session,
    sequence: u64,
    initial_capabilities: Value,
}
impl Fixture {
    fn new(engine: EngineKind) -> Self {
        Self::policy(engine, Policy::default())
    }
    fn policy(engine: EngineKind, policy: Policy) -> Self {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.commit = "inner-audio-cleanup-fixture".into();
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
        for name in METHODS {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
            host.insert(name.into(), CapabilitySupport::Full);
        }
        for event in EVENTS {
            for (name, manifest_policy, host_policy) in [
                (
                    format!("object:InnerAudioContext.on{event}"),
                    policy.on_manifest,
                    policy.on_host,
                ),
                (
                    format!("object:InnerAudioContext.off{event}"),
                    policy.off_manifest,
                    policy.off_host,
                ),
            ] {
                if let Some(support) = manifest_policy {
                    manifest.capabilities.insert(name.clone(), support);
                }
                if let Some(support) = host_policy {
                    host.insert(name, support);
                }
            }
        }
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
            .configure_host_services(trusted_config(
                root,
                audio_apis(policy.producers, policy.legacy_off),
            ))
            .unwrap();
        let mut fixture = Self {
            session,
            sequence: 0,
            initial_capabilities: Value::Null,
        };
        let init = fixture.raw(
            op::APP_INIT,
            json!({"modules":[{"id":MODULE,"source":SOURCE}]}),
        );
        assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
        fixture.initial_capabilities = init.messages[0].payload["capabilities"].clone();
        let launch = fixture.raw(op::APP_LIFECYCLE, json!({"event":"launch"}));
        assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
        fixture
    }
    fn raw(&mut self, operation: &str, payload: Value) -> BridgeBatch {
        self.sequence += 1;
        self.session.dispatch(BridgeEnvelope::request(
            SESSION,
            format!("audio-{}", self.sequence),
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
    fn calls(&mut self) -> Vec<(String, String, Value)> {
        call_requests(&self.session.take_host_requests())
    }
    fn create(&mut self, label: &str) -> (String, String) {
        self.call("create", json!([label]));
        let calls = self.calls();
        assert_eq!(calls.len(), 1, "{calls:?}");
        assert_eq!(calls[0].1, "wx.createInnerAudioContext");
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
    ) -> BridgeBatch {
        self.session
            .dispatch_host_api_event(HostApiEvent {
                session_id: SESSION.into(),
                account_epoch: u64::MAX,
                subscription_id: subscription.into(),
                object_id: Some(object.into()),
                event: Some(event.into()),
                sequence,
                value: json!({"actual":true}),
            })
            .unwrap()
    }
}

fn call_requests(requests: &[HostRequest]) -> Vec<(String, String, Value)> {
    requests
        .iter()
        .filter_map(|request| {
            if let HostRequest::Call {
                call_id,
                method,
                payload,
                ..
            } = request
            {
                Some((call_id.clone(), method.clone(), payload.clone()))
            } else {
                None
            }
        })
        .collect()
}
fn cancellation_ids(requests: &[HostRequest]) -> Vec<&str> {
    requests
        .iter()
        .filter_map(|request| {
            if let HostRequest::Cancel { call_id } = request {
                Some(call_id.as_str())
            } else {
                None
            }
        })
        .collect()
}

#[test]
fn legacy_audio_provider_policy_accepts_install_but_rejects_other_runtime_names_duplicates_and_snapshots(
) {
    let config = trusted_config(String::new(), audio_apis(true, true));
    validate_host_services_config(&config).unwrap();
    for name in [
        "wx.nextTick",
        "wx.setStorageSync",
        "object:TCPSocket.offMessage",
        "object:InnerAudioContext.offUnknown",
    ] {
        let mut invalid = config.clone();
        invalid.apis.push(name.into());
        assert!(validate_host_services_config(&invalid).is_err(), "{name}");
    }
    let mut duplicate = config.clone();
    duplicate
        .apis
        .push("object:InnerAudioContext.offPlay".into());
    assert!(validate_host_services_config(&duplicate).is_err());
    let mut snapshot = config;
    snapshot
        .sync_values
        .insert("object:InnerAudioContext.offPlay".into(), json!({}));
    assert!(validate_host_services_config(&snapshot).is_err());
}

#[test]
fn ten_pairs_remove_exact_real_subscription_creators_without_off_provider_calls_or_factory_cancel()
{
    for engine in engines() {
        for event in EVENTS {
            let mut fixture = Fixture::new(engine);
            let (factory_a, object_a) = fixture.create("a");
            let (factory_b, object_b) = fixture.create("b");
            assert_eq!(
                fixture.call("listen", json!(["a", event, "shared"])),
                json!([true, true])
            );
            fixture.call("listen", json!(["a", event, "second"]));
            fixture.call("listen", json!(["b", event, "shared"]));
            let calls = fixture.calls();
            assert_eq!(calls.len(), 3, "{calls:?}");
            for call in &calls {
                assert_eq!(call.1, format!("object:InnerAudioContext.on{event}"));
                fixture
                    .session
                    .complete_host_api_call(&call.0, Ok(json!({})))
                    .unwrap();
            }
            let own = calls[0].2["subscriptionId"].as_str().unwrap();
            let second = calls[1].2["subscriptionId"].as_str().unwrap();
            let other = calls[2].2["subscriptionId"].as_str().unwrap();
            fixture.event(own, &object_a, event, 1);
            fixture.event(second, &object_a, event, 1);
            fixture.event(other, &object_b, event, 1);
            assert_eq!(
                fixture.call("borrow", json!(["a", event, "shared", "b"])),
                true
            );
            let requests = fixture.session.take_host_requests();
            assert_eq!(cancellation_ids(&requests), vec![calls[0].0.as_str()]);
            assert!(call_requests(&requests).is_empty(), "{requests:?}");
            assert!(!cancellation_ids(&requests).contains(&factory_a.as_str()));
            assert!(!cancellation_ids(&requests).contains(&factory_b.as_str()));
            assert!(fixture.event(own, &object_a, event, 2).messages.is_empty());
            fixture.event(second, &object_a, event, 2);
            fixture.event(other, &object_b, event, 2);
            assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 5);
            assert_eq!(fixture.call("remove", json!(["a", event, null])), true);
            let requests = fixture.session.take_host_requests();
            assert_eq!(cancellation_ids(&requests), vec![calls[1].0.as_str()]);
            assert!(call_requests(&requests).is_empty());
            fixture.event(other, &object_b, event, 3);
            assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 6);
        }
    }
}

#[test]
fn compatibility_preserves_omitted_registered_defaults_and_explicit_manifest_or_host_denial() {
    for engine in engines() {
        let mut legacy = Fixture::policy(
            engine,
            Policy {
                on_manifest: None,
                on_host: None,
                off_manifest: None,
                off_host: None,
                ..Policy::default()
            },
        );
        for event in EVENTS {
            for prefix in ["on", "off"] {
                assert_eq!(
                    legacy.initial_capabilities
                        [format!("object:InnerAudioContext.{prefix}{event}")],
                    serde_json::to_value(CapabilitySupport::Partial).unwrap()
                );
            }
        }
        legacy.create("a");
        assert_eq!(legacy.call("tryListen", json!(["a", "Play"])), "admitted");
        let subscriptions = legacy.calls();
        assert_eq!(legacy.call("tryRemove", json!(["a", "Play"])), "removed");
        assert_eq!(
            cancellation_ids(&legacy.session.take_host_requests()),
            vec![subscriptions[0].0.as_str()]
        );
        for (policy_index, policy) in [
            Policy {
                off_manifest: Some(CapabilitySupport::Unsupported),
                ..Policy::default()
            },
            Policy {
                off_host: Some(CapabilitySupport::Unsupported),
                ..Policy::default()
            },
            Policy {
                off_manifest: None,
                off_host: None,
                legacy_off: false,
                ..Policy::default()
            },
        ]
        .into_iter()
        .enumerate()
        {
            let mut denied = Fixture::policy(engine, policy);
            for event in EVENTS {
                assert_eq!(
                    denied.initial_capabilities[format!("object:InnerAudioContext.off{event}")],
                    serde_json::to_value(CapabilitySupport::Unsupported).unwrap(),
                    "policy={policy_index} event={event} caps={:?}",
                    denied.initial_capabilities
                );
            }
            let (_, object) = denied.create("a");
            denied.call("listen", json!(["a", "Play", "live"]));
            let subscriptions = denied.calls();
            assert_eq!(
                denied.call("tryRemove", json!(["a", "Play"])),
                "ERR_UNSUPPORTED_CAPABILITY"
            );
            assert!(denied.session.take_host_requests().is_empty());
            denied.event(
                subscriptions[0].2["subscriptionId"].as_str().unwrap(),
                &object,
                "Play",
                1,
            );
            assert_eq!(denied.call("read", json!([])).as_array().unwrap().len(), 1);
        }
        let mut off_only = Fixture::policy(
            engine,
            Policy {
                producers: false,
                legacy_off: false,
                on_manifest: Some(CapabilitySupport::Unsupported),
                ..Policy::default()
            },
        );
        off_only.create("a");
        assert_eq!(off_only.call("tryRemove", json!(["a", "Error"])), "removed");
        assert_eq!(
            off_only.call("tryListen", json!(["a", "Error"])),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert!(off_only.session.take_host_requests().is_empty());
    }
}

#[test]
fn forged_public_off_requests_cannot_dispatch_compatibility_handler_or_cancel_another_owner() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (_, object) = fixture.create("a");
        fixture.call("listen", json!(["a", "Error", "one"]));
        let calls = fixture.calls();
        let id = calls[0].2["subscriptionId"].as_str().unwrap();
        fixture.call(
            "forge",
            json!(["object:InnerAudioContext.offError", object, id]),
        );
        assert!(fixture.session.take_host_requests().is_empty());
        fixture.event(id, &object, "Error", 1);
        assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 1);
        fixture.call("remove", json!(["a", "Error", null]));
        assert_eq!(
            cancellation_ids(&fixture.session.take_host_requests()),
            vec![calls[0].0.as_str()]
        );
    }
}

#[test]
fn destroy_request_cancels_every_creator_immediately_and_failure_does_not_reopen_receiver() {
    for engine in engines() {
        for succeeded in [false, true] {
            let mut fixture = Fixture::new(engine);
            let (factory, object) = fixture.create("a");
            let (_, other) = fixture.create("b");
            fixture.call("listen", json!(["a", "Play", "first"]));
            fixture.call("listen", json!(["a", "Error", "second"]));
            fixture.call("listen", json!(["b", "Play", "other"]));
            let subscriptions = fixture.calls();
            fixture.call("destroy", json!(["a"]));
            let requests = fixture.session.take_host_requests();
            let destroy = call_requests(&requests);
            assert_eq!(destroy.len(), 1, "{requests:?}");
            assert_eq!(destroy[0].1, "object:InnerAudioContext.destroy");
            for call in &subscriptions[..2] {
                assert!(cancellation_ids(&requests).contains(&call.0.as_str()));
                assert!(fixture
                    .event(
                        call.2["subscriptionId"].as_str().unwrap(),
                        &object,
                        call.1.strip_prefix("object:InnerAudioContext.on").unwrap(),
                        1,
                    )
                    .messages
                    .is_empty());
            }
            assert!(!cancellation_ids(&requests).contains(&factory.as_str()));
            assert!(!cancellation_ids(&requests).contains(&subscriptions[2].0.as_str()));
            assert_eq!(
                fixture.call("tryListen", json!(["a", "Play"])),
                "ERR_CANCELLED"
            );
            let result = if succeeded {
                Ok(json!({}))
            } else {
                Err(ProviderError::cancelled("destroy failed").into())
            };
            fixture
                .session
                .complete_host_api_call(&destroy[0].0, result)
                .unwrap();
            let completion = fixture.session.take_host_requests();
            assert_eq!(
                cancellation_ids(&completion).contains(&factory.as_str()),
                succeeded
            );
            assert_eq!(
                fixture.call("tryListen", json!(["a", "Play"])),
                "ERR_CANCELLED"
            );
            assert_eq!(fixture.call("tryRemove", json!(["a", "Play"])), "removed");
            fixture.event(
                subscriptions[2].2["subscriptionId"].as_str().unwrap(),
                &other,
                "Play",
                1,
            );
            assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 1);
        }
    }
}

#[test]
fn factory_failure_typed_retirement_survives_poisoned_public_resolver_or_promise_then() {
    for engine in engines() {
        for poison in ["poisonResolve", "poisonThen"] {
            let mut fixture = Fixture::new(engine);
            fixture.call("create", json!(["a"]));
            let factory = fixture.calls();
            let object = factory[0].2["objectId"].as_str().unwrap().to_owned();
            let (_, other) = fixture.create("b");
            fixture.call("listen", json!(["a", "Error", "a"]));
            fixture.call("listen", json!(["b", "Error", "b"]));
            let subscriptions = fixture.calls();
            fixture.call(poison, json!([]));
            let _ = fixture.session.complete_host_api_call(
                &factory[0].0,
                Err(ProviderError::cancelled("factory failed").into()),
            );
            let requests = fixture.session.take_host_requests();
            assert!(cancellation_ids(&requests).contains(&subscriptions[0].0.as_str()));
            assert!(!cancellation_ids(&requests).contains(&subscriptions[1].0.as_str()));
            assert!(fixture
                .event(
                    subscriptions[0].2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Error",
                    1,
                )
                .messages
                .is_empty());
            fixture.event(
                subscriptions[1].2["subscriptionId"].as_str().unwrap(),
                &other,
                "Error",
                1,
            );
            assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 1);
            assert_eq!(
                fixture.call("tryListen", json!(["a", "Error"])),
                "ERR_CANCELLED"
            );
            assert_eq!(fixture.call("tryRemove", json!(["a", "Error"])), "removed");
        }
    }
}

#[test]
fn clear_all_cancels_all_creators_even_if_a_guest_pending_rejector_throws() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (factory, object) = fixture.create("a");
        fixture.call("listen", json!(["a", "TimeUpdate", "first"]));
        fixture.call("listen", json!(["a", "TimeUpdate", "second"]));
        let subscriptions = fixture.calls();
        let _ = fixture.raw(
            op::MODULE_CALL,
            json!({"moduleId":MODULE,"export":"breakPending","args":["a","TimeUpdate"]}),
        );
        let requests = fixture.session.take_host_requests();
        assert!(!cancellation_ids(&requests).contains(&factory.as_str()));
        for call in &subscriptions {
            assert!(cancellation_ids(&requests).contains(&call.0.as_str()));
            assert!(fixture
                .event(
                    call.2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "TimeUpdate",
                    1,
                )
                .messages
                .is_empty());
        }
        assert_eq!(fixture.call("pendingFailures", json!([])), 2);
    }
}

#[test]
fn play_pause_stop_and_seek_keep_the_live_receiver_and_its_listeners() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (factory, object) = fixture.create("a");
        fixture.call("listen", json!(["a", "Stop", "listener"]));
        let subscriptions = fixture.calls();
        for method in ["play", "pause", "stop", "seek"] {
            fixture.call("control", json!(["a", method]));
            let requests = fixture.session.take_host_requests();
            assert!(cancellation_ids(&requests).is_empty());
            let calls = call_requests(&requests);
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].1, format!("object:InnerAudioContext.{method}"));
            fixture
                .session
                .complete_host_api_call(&calls[0].0, Ok(json!({})))
                .unwrap();
        }
        fixture.event(
            subscriptions[0].2["subscriptionId"].as_str().unwrap(),
            &object,
            "Stop",
            1,
        );
        assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 1);
        let revoked = fixture.session.revoke_host_services();
        assert!(cancellation_ids(&revoked).contains(&factory.as_str()));
        assert!(cancellation_ids(&revoked).contains(&subscriptions[0].0.as_str()));
    }
}

#[test]
fn transport_poison_or_failed_public_conversion_cannot_prevent_real_creator_cancellation() {
    for engine in engines() {
        for export in ["poison", "failedConversion"] {
            let mut fixture = Fixture::new(engine);
            let (factory, object) = fixture.create("a");
            fixture.call("listen", json!(["a", "Waiting", "listener"]));
            let subscriptions = fixture.calls();
            fixture
                .session
                .complete_host_api_call(&subscriptions[0].0, Ok(json!({})))
                .unwrap();
            let _ = fixture.raw(
                op::MODULE_CALL,
                json!({"moduleId":MODULE,"export":export,"args":["a","Waiting"]}),
            );
            let requests = fixture.session.take_host_requests();
            assert_eq!(
                cancellation_ids(&requests),
                vec![subscriptions[0].0.as_str()]
            );
            assert!(!cancellation_ids(&requests).contains(&factory.as_str()));
            assert!(fixture
                .event(
                    subscriptions[0].2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Waiting",
                    1,
                )
                .messages
                .is_empty());
        }
    }
}

#[test]
fn session_epoch_object_event_and_sequence_are_fenced_before_payload_ingress() {
    for engine in engines() {
        let mut fixture = Fixture::new(engine);
        let (_, object) = fixture.create("a");
        fixture.call("listen", json!(["a", "Canplay", "listener"]));
        let subscriptions = fixture.calls();
        let event = HostApiEvent {
            session_id: SESSION.into(),
            account_epoch: u64::MAX,
            subscription_id: subscriptions[0].2["subscriptionId"]
                .as_str()
                .unwrap()
                .into(),
            object_id: Some(object),
            event: Some("Canplay".into()),
            sequence: 9_007_199_254_740_993,
            value: json!({"actual":true}),
        };
        for index in 0..5 {
            let mut invalid = event.clone();
            invalid.value = json!({"__weappBinary":{"bytes":"invalid"}});
            match index {
                0 => invalid.session_id = "foreign".into(),
                1 => invalid.account_epoch = 0,
                2 => invalid.object_id = None,
                3 => invalid.object_id = Some("native-object-999".into()),
                _ => invalid.event = Some("Error".into()),
            }
            assert!(fixture
                .session
                .dispatch_host_api_event(invalid)
                .unwrap()
                .messages
                .is_empty());
        }
        fixture
            .session
            .dispatch_host_api_event(event.clone())
            .unwrap();
        assert!(fixture
            .session
            .dispatch_host_api_event(event)
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(fixture.call("read", json!([])).as_array().unwrap().len(), 1);
    }
}

#[test]
fn terminal_or_account_retirement_cancels_audio_resources_without_off_grant() {
    for engine in engines() {
        for revoke in [false, true] {
            let mut fixture = Fixture::policy(
                engine,
                Policy {
                    off_manifest: Some(CapabilitySupport::Unsupported),
                    ..Policy::default()
                },
            );
            let (factory, object) = fixture.create("a");
            fixture.call("listen", json!(["a", "Ended", "listener"]));
            let subscriptions = fixture.calls();
            let requests = if revoke {
                fixture.session.revoke_host_services()
            } else {
                let batch = fixture.raw(op::APP_LIFECYCLE, json!({"event":"unload"}));
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                fixture.session.take_host_requests()
            };
            assert!(cancellation_ids(&requests).contains(&factory.as_str()));
            assert!(cancellation_ids(&requests).contains(&subscriptions[0].0.as_str()));
            assert!(fixture
                .event(
                    subscriptions[0].2["subscriptionId"].as_str().unwrap(),
                    &object,
                    "Ended",
                    1,
                )
                .messages
                .is_empty());
        }
    }
}
