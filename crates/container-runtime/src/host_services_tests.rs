mod host_services_contract {
    use super::*;

    fn config(manifest: &ContainerManifestV1, apis: &[&str]) -> HostServicesConfig {
        HostServicesConfig {
            application: TrustedApplication {
                host_app_id: "host".into(),
                tenant_id: "tenant".into(),
                publisher_id: "publisher".into(),
                app_id: "wx-installed-app".into(),
                environment: "trial".into(),
                version: "2.3.4".into(),
                pack_root: manifest.integrity.root.clone(),
            },
            account: HostAccount {
                principal_id: Some("private-principal".into()),
                epoch: u64::MAX,
            },
            apis: apis.iter().map(|name| (*name).into()).collect(),
            sync_values: BTreeMap::new(),
        }
    }

    #[test]
    fn registration_and_wire_values_enforce_the_trust_boundary() {
        let manifest = manifest();
        for name in [
            "wx.inventedApi",
            "wx.setStorageSync",
            "wx.getAccountInfoSync",
        ] {
            assert!(
                validate_host_services_config(&config(&manifest, &[name])).is_err(),
                "{name}"
            );
        }
        let mut unbound = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
        assert!(unbound
            .configure_host_services(config(
                &manifest,
                &["object:FileSystemManager.readFileSync"]
            ))
            .is_err());
        let mut invalid = config(&manifest, &["wx.login", "wx.login"]);
        assert!(validate_host_services_config(&invalid).is_err());
        invalid = config(&manifest, &["wx.getDeviceInfo"]);
        assert!(
            validate_host_services_config(&invalid).is_err(),
            "snapshot cannot silently become a Promise"
        );
        invalid
            .sync_values
            .insert("wx.getDeviceInfo".into(), json!({"model":"native"}));
        validate_host_services_config(&invalid).unwrap();
        if let Some(newer) = host_api_catalog().iter().find(|api| {
            api.metadata.get("baseline").and_then(Value::as_str) == Some("newer-than-baseline")
        }) {
            assert!(validate_host_services_config(&config(&manifest, &[&newer.name])).is_err());
        }
        let account = HostAccount {
            principal_id: None,
            epoch: u64::MAX,
        };
        assert_eq!(
            serde_json::to_value(&account).unwrap()["epoch"],
            u64::MAX.to_string()
        );
        for value in [
            json!("01"),
            json!("+1"),
            json!("18446744073709551616"),
            json!(9_007_199_254_740_992_u64),
            json!(-1),
            json!(1.5),
        ] {
            assert!(serde_json::from_value::<HostAccount>(
                json!({"principalId":null,"epoch":value})
            )
            .is_err());
        }
        assert_eq!(
            serde_json::from_value::<HostAccount>(json!({"principalId":null,"epoch":42}))
                .unwrap()
                .epoch,
            42
        );
    }

    #[test]
    fn payment_extension_requires_a_backend_order_reference() {
        let manifest = manifest();
        let mut session = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
        session
            .configure_host_services(config(&manifest, &["weappContainer.payment.request"]))
            .unwrap();
        let api = "weappContainer.payment.request";
        for payload in [
            json!({}),
            json!({"orderId":""}),
            json!({"orderId":"contains/slash"}),
            json!({"orderId":"order-1","paySign":"guest-signature"}),
        ] {
            assert!(
                session
                    .validate_host_service_call(api, payload.as_object().unwrap())
                    .is_err(),
                "unsafe payment payload was accepted: {payload}"
            );
        }
        session
            .validate_host_service_call(api, json!({"orderId":"order-1"}).as_object().unwrap())
            .unwrap();
    }

    #[test]
    fn host_request_context_preserves_the_public_wire_contract() {
        let wire = json!({
            "kind": "call",
            "callId": "session:1:2",
            "method": "wx.createVideoContext",
            "payload": {"id": "player"},
            "deadlineNs": "18446744073709551615",
            "cancelToken": "cancel:2",
            "context": {
                "application": {
                    "hostAppId": "host", "tenantId": "tenant", "publisherId": "publisher",
                    "appId": "wx-installed-app", "environment": "trial", "version": "2.3.4",
                    "packRoot": "accepted-pack-root"
                },
                "account": {"principalId": "private-principal", "epoch": "18446744073709551615"},
                "sessionId": "session", "callId": "session:1:2", "api": "wx.createVideoContext",
                "deadlineNs": "18446744073709551615", "cancelToken": "cancel:2",
                "componentTarget": {"pageId": "18446744073709551615", "nodeId": "video-node", "ownerScopeId": "component"}
            }
        });
        let request: HostRequest = serde_json::from_value(wire.clone()).unwrap();
        let HostRequest::Call { context, .. } = &request else {
            panic!("expected host call");
        };
        let context = context.as_deref().unwrap();
        assert_eq!(context.account.epoch, u64::MAX);
        assert_eq!(context.deadline_ns, Some(u64::MAX));
        assert_eq!(context.component_target.as_ref().unwrap().page_id, u64::MAX);
        assert_eq!(serde_json::to_value(&request).unwrap(), wire);

        let mut business_wire = wire;
        business_wire.as_object_mut().unwrap().remove("context");
        let business_request: HostRequest = serde_json::from_value(business_wire.clone()).unwrap();
        assert!(matches!(
            business_request,
            HostRequest::Call { context: None, .. }
        ));
        assert_eq!(
            serde_json::to_value(&business_request).unwrap(),
            business_wire
        );
    }

    #[test]
    fn binary_handles_are_scoped_bounded_and_transactional() {
        let manifest = manifest();
        let mut session = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
        session
            .configure_host_services(config(&manifest, &[]))
            .unwrap();
        let handle = session.register_host_binary(vec![0, 128, 255]).unwrap();
        assert_eq!(handle.account_epoch, u64::MAX);
        assert_eq!(
            session.read_host_binary(&handle.id, 1, 2).unwrap(),
            [128, 255]
        );
        assert!(session.read_host_binary(&handle.id, usize::MAX, 1).is_err());
        assert!(session
            .read_host_binary(&handle.id, 0, 1024 * 1024 + 1)
            .is_err());
        session.retain_host_binary(&handle.id).unwrap();
        let mut invalid = json!({"first":{"__weappBinary":{"handle":handle.id}},"second":{"__weappBinary":{"handle":"unknown"}}});
        assert!(session.materialize_host_binaries(&mut invalid).is_err());
        assert_eq!(
            session.read_host_binary(&handle.id, 0, 3).unwrap(),
            [0, 128, 255]
        );
        let mut value = json!({"data":{"__weappBinary":{"handle":handle.id}}});
        session.materialize_host_binaries(&mut value).unwrap();
        assert_eq!(
            value["data"]["__weappBinary"]["bytes"],
            json!([0, 128, 255])
        );
        session.release_host_binary(&handle.id).unwrap();
        assert!(session.read_host_binary(&handle.id, 0, 1).is_err());
        let large = session
            .register_host_binary(vec![0; 32 * 1024 * 1024])
            .unwrap();
        assert!(session.register_host_binary(vec![1]).is_err());
        session.release_host_binary(&large.id).unwrap();
        for _ in 0..256 {
            session.register_host_binary(vec![]).unwrap();
        }
        assert!(session.register_host_binary(vec![]).is_err());
        session.revoke_host_services();
        assert!(session.register_host_binary(vec![]).is_err());
        assert!(session.retain_host_binary(&large.id).is_err());
    }

    #[test]
    fn native_binary_float_bytes_normalize_without_relaxing_bounds_or_ownership() {
        let manifest = manifest();
        let mut session = Session::new(manifest.clone(), SessionConfig::default()).unwrap();
        session
            .configure_host_services(config(&manifest, &[]))
            .unwrap();
        let mut inline =
            json!({"data":{"__weappBinary":{"type":"ArrayBuffer","bytes":[0.0,128.0,255.0]}}});
        session.materialize_host_binaries(&mut inline).unwrap();
        assert_eq!(
            inline["data"]["__weappBinary"]["bytes"],
            json!([0, 128, 255])
        );
        assert!(inline["data"]["__weappBinary"]["bytes"][0]
            .as_u64()
            .is_some());
        let handle = session.register_host_binary(vec![7]).unwrap();
        for invalid in [
            json!(-1.0),
            json!(0.5),
            json!(256.0),
            json!(true),
            json!(null),
            json!("1"),
        ] {
            let mut payload = json!({"a":{"__weappBinary":{"handle":handle.id}},"b":{"__weappBinary":{"type":"ArrayBuffer","bytes":[invalid]}}});
            let original = payload.clone();
            assert!(session.materialize_host_binaries(&mut payload).is_err());
            assert_eq!(payload, original);
            assert_eq!(session.read_host_binary(&handle.id, 0, 1).unwrap(), vec![7]);
        }
        assert_eq!(host_wire_bounded_integer(&json!(1.0), 255), Some(1));
        assert_eq!(
            host_wire_bounded_integer(&json!(9007199254740992_u64), 255),
            None
        );
        assert_eq!(host_wire_bounded_integer(&json!("1"), 255), None);
        session.release_host_binary(&handle.id).unwrap();
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    mod engines {
        use super::*;

        fn make(engine: EngineKind, source: &str, apis: &[&str], unsupported: &[&str]) -> Session {
            make_mode(
                engine,
                source,
                apis,
                unsupported,
                container_render_skia::PageRenderMode::Raster,
            )
        }
        fn make_mode(
            engine: EngineKind,
            source: &str,
            apis: &[&str],
            unsupported: &[&str],
            page_render_mode: container_render_skia::PageRenderMode,
        ) -> Session {
            make_bound_mode(engine, source, apis, unsupported, page_render_mode, None)
        }
        fn make_bound_mode(
            engine: EngineKind,
            source: &str,
            apis: &[&str],
            unsupported: &[&str],
            page_render_mode: container_render_skia::PageRenderMode,
            provider: Option<Arc<dyn container_core::SyncHostApi>>,
        ) -> Session {
            let source = format!("{source}\nObject.keys(exports).forEach(function(key){{const original=exports[key];if(typeof original==='function')exports[key]=function(){{return {{value:original.apply(this,arguments)}};}};}});");
            let mut manifest = module_manifest(source.as_bytes(), ModuleFormat::Commonjs);
            for api in unsupported {
                manifest
                    .capabilities
                    .insert((*api).into(), CapabilitySupport::Unsupported);
            }
            manifest.refresh_integrity().unwrap();
            let mut services = config(&manifest, apis);
            if apis.contains(&"weappContainer.identity.getState") {
                services.sync_values.insert(
                    "weappContainer.identity.getState".into(),
                    json!({"authenticated":true,"displayName":"native"}),
                );
            }
            let mut session = Session::new(
                manifest,
                SessionConfig {
                    engine,
                    page_render_mode,
                    ..Default::default()
                },
            )
            .unwrap();
            if let Some(provider) = provider {
                services.apis.extend(provider.supported_apis());
                session.bind_sync_host_api(provider).unwrap();
            }
            session.configure_host_services(services).unwrap();
            let batch = session.dispatch(request(
                "init",
                op::APP_INIT,
                json!({"modules":[{"id":"module:app","source":source}]}),
            ));
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            session
        }

        fn call(session: &mut Session, export: &str) -> Value {
            let batch = session.dispatch(request(
                export,
                op::MODULE_CALL,
                json!({"moduleId":"module:app","export":export,"args":[]}),
            ));
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            batch.messages[0].payload["result"][0]["value"].clone()
        }

        fn calls(session: &mut Session) -> Vec<(String, String, Value, HostApiCallContext)> {
            session
                .take_host_requests()
                .into_iter()
                .filter_map(|request| match request {
                    HostRequest::Call {
                        call_id,
                        method,
                        payload,
                        context,
                        ..
                    } => Some((
                        call_id,
                        method,
                        payload,
                        *context.expect("trusted native context"),
                    )),
                    _ => None,
                })
                .collect()
        }

        fn snapshots_context_and_errors(engine: EngineKind) {
            let source = r#"
              const log=[];
              const initial=wx.getAccountInfoSync(); initial.miniProgram.appId='guest-forged';
              const state=weappContainer.identity.getState(); state.displayName='guest-forged';
              exports.snapshot=()=>({info:wx.getAccountInfoSync(),state:weappContainer.identity.getState(),login:wx.canIUse('login'),unregistered:wx.canIUse('getUserInfo')});
              exports.start=()=>{
                wx.login({context:{account:{principalId:'forged',epoch:'0'}},success:r=>log.push(['login',r.code]),complete:()=>log.push('complete')}).then(r=>log.push(['promise',r.code]));
                wx.getUserProfile({desc:'Display profile',fail:e=>log.push([e.errCode,e.errMsg,e.extra,e.code]),complete:()=>log.push('profile-complete')}).catch(e=>log.push(['rejected',e.errCode]));
                return 'returned';
              };
              exports.read=()=>log;
            "#;
            let mut session = make(
                engine,
                source,
                &[
                    "wx.login",
                    "wx.getUserProfile",
                    "weappContainer.identity.getState",
                ],
                &[],
            );
            let snapshot = call(&mut session, "snapshot");
            assert_eq!(
                snapshot["info"]["miniProgram"],
                json!({"appId":"wx-installed-app","envVersion":"trial","version":"2.3.4"})
            );
            assert_eq!(snapshot["state"]["displayName"], "native");
            assert_eq!(snapshot["login"], true);
            assert_eq!(snapshot["unregistered"], false);
            session
                .update_host_service_snapshots(BTreeMap::from([(
                    "weappContainer.identity.getState".into(),
                    json!({"authenticated":true,"displayName":"refreshed"}),
                )]))
                .unwrap();
            assert_eq!(
                call(&mut session, "snapshot")["state"]["displayName"],
                "refreshed"
            );
            assert!(session
                .update_host_service_snapshots(BTreeMap::from([(
                    "wx.getAccountInfoSync".into(),
                    json!({})
                )]))
                .is_err());
            assert_eq!(call(&mut session, "start"), "returned");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 2);
            assert_eq!(
                requests[0].3.account.principal_id.as_deref(),
                Some("private-principal")
            );
            assert_eq!(requests[0].3.application.app_id, "wx-installed-app");
            assert_eq!(requests[0].3.call_id, requests[0].0);
            assert_eq!(
                serde_json::to_value(&requests[0].3).unwrap()["account"]["epoch"],
                u64::MAX.to_string()
            );
            session
                .complete_host_api_call(&requests[0].0, Ok(json!({"code":"one-time-code"})))
                .unwrap();
            session
                .complete_host_api_call(
                    &requests[1].0,
                    Err(HostApiFailure {
                        code: ProviderErrorCode::PermissionDenied,
                        message: "denied".into(),
                        retryable: false,
                        details: BTreeMap::from([
                            ("errCode".into(), json!(10004)),
                            ("errMsg".into(), json!("getUserProfile:fail user deny")),
                            ("extra".into(), json!("preserved")),
                        ]),
                    }),
                )
                .unwrap();
            assert_eq!(
                call(&mut session, "read"),
                json!([
                    ["login", "one-time-code"],
                    "complete",
                    ["promise", "one-time-code"],
                    [
                        10004,
                        "getUserProfile:fail user deny",
                        "preserved",
                        "ERR_PERMISSION_DENIED"
                    ],
                    "profile-complete",
                    ["rejected", 10004]
                ])
            );
            assert!(session
                .complete_host_api_call(&requests[0].0, Ok(json!({"code":"duplicate"})))
                .unwrap()
                .messages
                .is_empty());
            let mut upgraded = session
                .host_services
                .config
                .as_ref()
                .unwrap()
                .application
                .clone();
            upgraded.version = "2.3.5".into();
            session
                .update_trusted_application(upgraded.clone())
                .unwrap();
            assert_eq!(
                call(&mut session, "snapshot")["info"]["miniProgram"]["version"],
                "2.3.5"
            );
            upgraded.app_id = "different-app".into();
            assert!(session.update_trusted_application(upgraded).is_err());
        }

        fn unsupported_and_validation(engine: EngineKind) {
            let source = r#"const log=[]; exports.start=()=>{ wx.login({}).catch(e=>log.push(e.code)); wx.getUserProfile({desc:''}).catch(e=>log.push(e.code)); return [wx.canIUse('login'),wx.canIUse('getUserInfo')]; }; exports.read=()=>log;"#;
            let mut session = make(
                engine,
                source,
                &["wx.login", "wx.getUserProfile"],
                &["wx.login"],
            );
            assert_eq!(call(&mut session, "start"), json!([false, false]));
            assert!(calls(&mut session).is_empty());
            assert_eq!(
                call(&mut session, "read"),
                json!(["ERR_UNSUPPORTED_CAPABILITY", "ERR_INVALID_REQUEST"])
            );
            let late = config(&session.manifest, &["wx.login"]);
            assert!(session.configure_host_services(late).is_err());
        }

        fn object_events_and_binary(engine: EngineKind) {
            let source = r#"
              const log=[]; let audio; const listener=v=>log.push([v.currentTime,v.data instanceof ArrayBuffer,v.data ? Array.from(new Uint8Array(v.data)):null]);
              exports.start=()=>{audio=wx.createInnerAudioContext({useWebAudioImplement:true});audio.onPlay(listener);audio.src='wxfile://user/test.mp3';audio.play().then(()=>log.push('played'));return [typeof audio.play,typeof audio.onPlay,typeof audio.seek];};
              exports.off=()=>{audio.offPlay(listener);return true;};
              exports.destroy=()=>{audio.destroy().then(()=>log.push('destroyed'));return true;};
              exports.property=()=>audio.src;
              exports.capability=()=>[wx.canIUse('InnerAudioContext.play'),wx.canIUse('InnerAudioContext.seek')];
              exports.read=()=>log;
            "#;
            let apis = [
                "wx.createInnerAudioContext",
                "object:InnerAudioContext.onPlay",
                "object:InnerAudioContext.offPlay",
                "object:InnerAudioContext.src",
                "object:InnerAudioContext.play",
                "object:InnerAudioContext.destroy",
            ];
            let mut session = make(engine, source, &apis, &[]);
            assert_eq!(
                call(&mut session, "start"),
                json!(["function", "function", "function"])
            );
            assert_eq!(call(&mut session, "capability"), json!([true, false]));
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 4, "{requests:?}");
            let object_id = requests[0].2["objectId"].as_str().unwrap().to_owned();
            let subscription = requests[1].2["subscriptionId"].as_str().unwrap().to_owned();
            assert!(requests
                .iter()
                .all(|request| request.2["objectId"] == object_id));
            for request in &requests {
                session
                    .complete_host_api_call(
                        &request.0,
                        Ok(if request.1 == "wx.createInnerAudioContext" {
                            json!({"objectId":object_id,"properties":{"src":"","currentTime":0}})
                        } else {
                            json!({})
                        }),
                    )
                    .unwrap();
            }
            assert_eq!(call(&mut session, "property"), "wxfile://user/test.mp3");
            let handle = session.register_host_binary(vec![0, 128, 255]).unwrap();
            let event = HostApiEvent {
                session_id: session.config.session_id.clone(),
                account_epoch: u64::MAX,
                subscription_id: subscription.clone(),
                sequence: 9_007_199_254_740_993,
                value: json!({"currentTime":1.25,"data":{"__weappBinary":{"handle":handle.id}}}),
                object_id: Some(object_id.clone()),
                event: Some("Play".into()),
            };
            let mut stale = event.clone();
            stale.account_epoch = 0;
            assert!(session
                .dispatch_host_api_event(stale)
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(
                session.read_host_binary(&handle.id, 0, 3).unwrap(),
                [0, 128, 255]
            );
            session.dispatch_host_api_event(event.clone()).unwrap();
            assert!(session.read_host_binary(&handle.id, 0, 3).is_err());
            assert!(session
                .dispatch_host_api_event(event.clone())
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(
                call(&mut session, "read"),
                json!(["played", [1.25, true, [0, 128, 255]]])
            );
            let forged = session.dispatch(request(
                "forged",
                op::API_CALL,
                json!({"name":"object:InnerAudioContext.play","objectId":"unknown"}),
            ));
            assert_eq!(forged.messages[0].payload["error"]["code"], "ERR_CANCELLED");
            call(&mut session, "off");
            let off = session.take_host_requests();
            assert_eq!(off.len(), 1);
            // Removal revokes the exact subscription creator. Historical SDK
            // off names are negotiation input, never a second provider call.
            assert!(
                matches!(&off[0], HostRequest::Cancel { call_id } if call_id == &requests[1].0)
            );
            let mut after_off = event;
            after_off.sequence += 1;
            after_off.value = json!({"currentTime":2});
            assert!(session
                .dispatch_host_api_event(after_off)
                .unwrap()
                .messages
                .is_empty());
            call(&mut session, "destroy");
            let destroy = calls(&mut session);
            assert_eq!(destroy.len(), 1);
            session
                .complete_host_api_call(&destroy[0].0, Ok(json!({})))
                .unwrap();
            assert!(session.take_host_requests().iter().any(
                |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&requests[0].0)
            ));
        }

        fn inner_audio_defaults_are_synchronous_mutable_and_negotiated(engine: EngineKind) {
            let source = r#"
              let first,second; const events=[];
              const keys=['src','startTime','autoplay','loop','volume','playbackRate','obeyMuteSwitch','paused','currentTime','duration','buffered','referrerPolicy'];
              const state=audio=>Object.fromEntries(keys.map(key=>[key,audio[key]===undefined?'unavailable':audio[key]]));
              exports.start=()=>{first=wx.createInnerAudioContext();second=wx.createInnerAudioContext();if(wx.canIUse('InnerAudioContext.onTimeUpdate'))first.onTimeUpdate(()=>events.push([first.volume,first.currentTime,second.volume]));return {first:state(first),second:state(second)}};
              exports.write=()=>{first.volume=0.25;return first.volume};
              exports.read=()=>({first:state(first),second:state(second)});
              exports.fresh=()=>state(wx.createInnerAudioContext());
              exports.events=()=>events;
              exports.off=()=>{first.offTimeUpdate();return true};
              exports.unsupported=()=>{first.loop=true;return {loop:typeof first.loop,capability:wx.canIUse('InnerAudioContext.loop')}};
            "#;
            let defaults = json!({"src":"","startTime":0,"autoplay":false,"loop":false,"volume":1,"playbackRate":1,"obeyMuteSwitch":true,"paused":true,"currentTime":0,"duration":0,"buffered":0,"referrerPolicy":"origin"});
            let apis = [
                "wx.createInnerAudioContext",
                "object:InnerAudioContext.src",
                "object:InnerAudioContext.startTime",
                "object:InnerAudioContext.autoplay",
                "object:InnerAudioContext.loop",
                "object:InnerAudioContext.volume",
                "object:InnerAudioContext.playbackRate",
                "object:InnerAudioContext.obeyMuteSwitch",
                "object:InnerAudioContext.paused",
                "object:InnerAudioContext.currentTime",
                "object:InnerAudioContext.duration",
                "object:InnerAudioContext.buffered",
                "object:InnerAudioContext.referrerPolicy",
                "object:InnerAudioContext.onTimeUpdate",
                "object:InnerAudioContext.offTimeUpdate",
            ];
            let mut session = make(engine, source, &apis, &[]);
            assert_eq!(
                call(&mut session, "start"),
                json!({"first":defaults,"second":defaults}),
                "defaults must exist before either asynchronous factory reply"
            );
            assert_eq!(call(&mut session, "write"), 0.25);
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 4);
            let object_id = requests[0].2["objectId"].as_str().unwrap().to_owned();
            let second_id = requests[1].2["objectId"].as_str().unwrap().to_owned();
            session.complete_host_api_call(&requests[0].0, Ok(json!({
                "objectId":object_id,"properties":{"volume":0.7,"paused":false,"currentTime":2,"duration":60,"buffered":10}
            }))).unwrap();
            session
                .complete_host_api_call(
                    &requests[1].0,
                    Ok(json!({
                        "objectId":second_id,"properties":{"volume":0.9,"paused":false}
                    })),
                )
                .unwrap();
            session
                .complete_host_api_call(&requests[2].0, Ok(json!({})))
                .unwrap();
            let after_factory = call(&mut session, "read");
            assert_eq!(
                after_factory["first"]["volume"], 0.25,
                "an older factory snapshot must not overwrite a pending guest setter"
            );
            assert_eq!(after_factory["first"]["paused"], false);
            assert_eq!(after_factory["first"]["currentTime"], 2);
            assert_eq!(after_factory["second"]["volume"], 0.9);
            session
                .complete_host_api_call(
                    &requests[3].0,
                    Err(HostApiFailure {
                        code: ProviderErrorCode::InvalidRequest,
                        message: "volume rejected".into(),
                        retryable: false,
                        details: BTreeMap::new(),
                    }),
                )
                .unwrap();
            assert_eq!(call(&mut session, "read")["first"]["volume"], 0.7,
                "failed setters restore the newest confirmed host value, not the constructor default");
            let event = HostApiEvent {
                session_id: session.config.session_id.clone(),
                account_epoch: u64::MAX,
                subscription_id: requests[2].2["subscriptionId"].as_str().unwrap().into(),
                sequence: 1,
                object_id: Some(object_id),
                event: Some("TimeUpdate".into()),
                value: json!({"properties":{"volume":0.55,"paused":true,"currentTime":4,"buffered":12}}),
            };
            session.dispatch_host_api_event(event.clone()).unwrap();
            let after_event = call(&mut session, "read");
            assert_eq!(after_event["first"]["volume"], 0.55);
            assert_eq!(after_event["first"]["paused"], true);
            assert_eq!(after_event["first"]["currentTime"], 4);
            assert_eq!(after_event["second"]["volume"], 0.9);
            assert_eq!(
                call(&mut session, "events"),
                json!([[0.55, 4, 0.9]]),
                "callbacks observe the accepted object's properties before guest delivery"
            );
            let mut replay = event.clone();
            replay.value = json!({"properties":{"volume":0.1,"currentTime":99}});
            assert!(session
                .dispatch_host_api_event(replay.clone())
                .unwrap()
                .messages
                .is_empty());
            replay.sequence += 1;
            replay.object_id = Some(second_id);
            assert!(session
                .dispatch_host_api_event(replay)
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(
                call(&mut session, "read"),
                after_event,
                "duplicate and foreign-object events cannot mutate either property cache"
            );
            call(&mut session, "off");
            let removed = session.take_host_requests();
            assert_eq!(removed.len(), 1);
            assert!(
                matches!(&removed[0], HostRequest::Cancel {call_id} if call_id == &requests[2].0)
            );
            let mut retired = event;
            retired.sequence += 1;
            retired.value = json!({"properties":{"volume":0.2,"currentTime":100}});
            assert!(session
                .dispatch_host_api_event(retired)
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(
                call(&mut session, "read"),
                after_event,
                "removed listeners cannot update their former object's property cache"
            );
            assert_eq!(call(&mut session, "events"), json!([[0.55, 4, 0.9]]));
            assert_eq!(
                call(&mut session, "fresh"),
                defaults,
                "host changes to one object cannot mutate the defaults of another"
            );

            let mut subset = make(
                engine,
                source,
                &[
                    "wx.createInnerAudioContext",
                    "object:InnerAudioContext.volume",
                ],
                &[],
            );
            let initial = call(&mut subset, "start");
            assert_eq!(initial["first"]["volume"], 1);
            assert_eq!(initial["first"]["paused"], "unavailable");
            let factory_calls = calls(&mut subset);
            assert_eq!(factory_calls.len(), 2);
            subset.complete_host_api_call(&factory_calls[0].0, Ok(json!({
                "objectId":factory_calls[0].2["objectId"],
                "properties":{"volume":0.4,"paused":false,"loop":true,"referrerPolicy":"no-referrer"}
            }))).unwrap();
            let current = call(&mut subset, "read");
            assert_eq!(current["first"]["volume"], 0.4);
            assert_eq!(
                current["first"]["paused"], "unavailable",
                "native snapshots cannot install unregistered properties"
            );
            assert_eq!(current["first"]["referrerPolicy"], "unavailable");
            assert_eq!(
                call(&mut subset, "unsupported"),
                json!({"loop":"undefined","capability":false})
            );
            assert!(
                calls(&mut subset).is_empty(),
                "an unsupported setter must not publish native work"
            );
        }

        fn nfc_technology_enum_is_synchronous_and_negotiated(engine: EngineKind) {
            let source = r#"
              let first,second;
              exports.start=()=>{first=wx.getNFCAdapter();second=wx.getNFCAdapter();const initial=JSON.parse(JSON.stringify(first.tech));first.tech.ndef='guest-local';return {initial,other:second.tech,isoDep:wx.canIUse('NFCAdapter.getIsoDep'),nfcA:wx.canIUse('NFCAdapter.getNfcA')};};
              exports.read=()=>({first:first.tech,second:second.tech});
              exports.child=()=>{second.getNdef();return true;};
            "#;
            let mut session = make(
                engine,
                source,
                &[
                    "wx.getNFCAdapter",
                    "object:NFCAdapter.tech",
                    "object:NFCAdapter.getNdef",
                    "object:NFCAdapter.getIsoDep",
                    "object:NFCAdapter.getNfcA",
                ],
                &["object:NFCAdapter.getNfcA"],
            );
            let expected = json!({"isoDep":"ISO_DEP","ndef":"NDEF"});
            assert_eq!(
                call(&mut session, "start"),
                json!({"initial":expected,"other":expected,"isoDep":true,"nfcA":false}),
                "enum is available before any asynchronous native factory completion"
            );
            let factories = calls(&mut session);
            assert_eq!(factories.len(), 2);
            assert!(factories
                .iter()
                .all(|request| request.1 == "wx.getNFCAdapter"));
            for request in &factories {
                session
                    .complete_host_api_call(
                        &request.0,
                        Ok(json!({"properties":{"tech":{"nfcA":"NFC_A","nfcB":"NFC_B"}}})),
                    )
                    .unwrap();
            }
            assert_eq!(
                call(&mut session, "read"),
                json!({"first":{"isoDep":"ISO_DEP","ndef":"guest-local"},"second":expected}),
                "objects own independent enum copies; late native data cannot expand the registry"
            );
            call(&mut session, "child");
            let child = calls(&mut session);
            assert_eq!(child.len(), 1);
            assert_eq!(child[0].1, "object:NFCAdapter.getNdef");
            assert_eq!(child[0].2["receiverId"], factories[1].2["objectId"]);
        }

        fn native_inline_binary_float_bytes_reach_javascript(engine: EngineKind) {
            let mut session = make(
                engine,
                r#"
                const log=[];
                exports.start=()=>{wx.request({url:'https://test.invalid',responseType:'arraybuffer',success:r=>log.push(['success',r.data instanceof ArrayBuffer,Array.from(new Uint8Array(r.data))]),complete:()=>log.push('complete')}).then(()=>log.push('resolved'));return true;};
                exports.read=()=>log;
            "#,
                &["wx.request"],
                &[],
            );
            assert_eq!(call(&mut session, "start"), true);
            let pending = calls(&mut session);
            assert_eq!(pending.len(), 1);
            session.complete_host_api_call(&pending[0].0, Ok(json!({"statusCode":200,"data":{"__weappBinary":{"type":"ArrayBuffer","bytes":[0.0,128.0,255.0]}}}))).unwrap();
            assert_eq!(
                call(&mut session, "read"),
                json!([["success", true, [0, 128, 255]], "complete", "resolved"])
            );
        }

        fn native_tasks_cancel_and_transfer_binary(engine: EngineKind) {
            let source = r#"
              const log=[];let task;
              exports.start=()=>{task=wx.request({url:'https://test.invalid',data:new Uint8Array([1,2,255]).buffer,success:r=>log.push(['success',r.data instanceof ArrayBuffer,Array.from(new Uint8Array(r.data))]),complete:()=>log.push('complete')});task.onHeadersReceived(r=>log.push(['header',r.header.x]));task.then(()=>log.push('resolved'),e=>log.push(e.code));return typeof task.abort;};
              exports.abort=()=>{task.abort();task.abort();return true;}; exports.read=()=>log;
            "#;
            let apis = [
                "wx.request",
                "object:RequestTask.abort",
                "object:RequestTask.onHeadersReceived",
                "object:RequestTask.offHeadersReceived",
            ];
            let mut session = make(engine, source, &apis, &[]);
            assert_eq!(call(&mut session, "start"), "function");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 2);
            assert_eq!(
                requests[0].2["data"]["__weappBinary"]["bytes"],
                json!([1, 2, 255])
            );
            session
                .complete_host_api_call(&requests[1].0, Ok(json!({})))
                .unwrap();
            session
                .dispatch_host_api_event(HostApiEvent {
                    session_id: session.config.session_id.clone(),
                    account_epoch: u64::MAX,
                    subscription_id: requests[1].2["subscriptionId"].as_str().unwrap().into(),
                    sequence: 1,
                    value: json!({"header":{"x":"native"}}),
                    object_id: Some(requests[0].2["objectId"].as_str().unwrap().into()),
                    event: Some("HeadersReceived".into()),
                })
                .unwrap();
            let binary = session.register_host_binary(vec![0, 127, 255]).unwrap();
            session
                .complete_host_api_call(
                    &requests[0].0,
                    Ok(json!({"statusCode":200,"data":{"__weappBinary":{"handle":binary.id}}})),
                )
                .unwrap();
            assert_eq!(
                call(&mut session, "read"),
                json!([
                    ["header", "native"],
                    ["success", true, [0, 127, 255]],
                    "complete",
                    "resolved"
                ])
            );
            session.take_host_requests();
            call(&mut session, "abort");
            assert!(session.take_host_requests().is_empty());
            call(&mut session, "start");
            let second = calls(&mut session);
            call(&mut session, "abort");
            assert_eq!(
                session.pending_host_call_count(),
                0,
                "task retirement also cancels subscription acknowledgement"
            );
            assert!(session.take_host_requests().iter().any(
                |request| matches!(request,HostRequest::Cancel {call_id} if call_id==&second[0].0)
            ));
            assert_eq!(
                call(&mut session, "read")
                    .as_array()
                    .unwrap()
                    .last()
                    .unwrap(),
                "ERR_CANCELLED"
            );
            session.take_host_requests();
            call(&mut session, "start");
            call(&mut session, "abort");
            assert!(
                session.take_host_requests().is_empty(),
                "same-turn abort must not start a factory or its subscription"
            );
        }

        fn revocation_never_enters_guest(engine: EngineKind) {
            let source = r#"let count=0;exports.start=()=>{wx.login({fail:()=>count++,complete:()=>count++}).catch(()=>count++);weappContainer.identity.onChange(()=>count++);return true;};exports.read=()=>count;"#;
            let mut session = make(
                engine,
                source,
                &[
                    "wx.login",
                    "weappContainer.identity.onChange",
                    "weappContainer.identity.offChange",
                ],
                &[],
            );
            call(&mut session, "start");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 2);
            session
                .complete_host_api_call(&requests[1].0, Ok(json!({})))
                .unwrap();
            let binary = session.register_host_binary(vec![1]).unwrap();
            let cancelled = session.revoke_host_services();
            assert_eq!(cancelled.len(), 2);
            assert_eq!(session.pending_host_call_count(), 0);
            assert!(session.read_host_binary(&binary.id, 0, 1).is_err());
            assert!(session
                .complete_host_api_call(&requests[0].0, Ok(json!({"code":"late"})))
                .unwrap()
                .messages
                .is_empty());
            assert!(session
                .dispatch_host_api_event(HostApiEvent {
                    session_id: session.config.session_id.clone(),
                    account_epoch: u64::MAX,
                    subscription_id: requests[1].2["subscriptionId"].as_str().unwrap().into(),
                    sequence: 1,
                    value: json!({}),
                    object_id: None,
                    event: Some("Change".into())
                })
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(call(&mut session, "read"), 0);
        }

        fn phone_button_and_native_components(engine: EngineKind) {
            let source = r#"
              const log=[];Page({onPhone(e){log.push(['phone',e.detail.code,e.detail.errMsg,e.currentTarget.dataset.action]);},onCamera(e){log.push(['camera',e.detail.width]);}});
              exports.read=()=>log;exports.publicApi=()=>[typeof wx.getPhoneNumber,wx.canIUse('button.open-type.getPhoneNumber')];
            "#;
            let apis = [
                "weappContainer.identity.authorizePhone",
                "component:button.open-type.getPhoneNumber",
                "component:button.bindgetphonenumber",
                "component:camera",
            ];
            let mut session = make(engine, source, &apis, &[]);
            let pushed = session.dispatch(request(
                "page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ));
            assert_eq!(pushed.messages[0].payload["ok"], true, "{pushed:?}");
            let frame=session.dispatch(request("frame",op::RENDER_COMMIT,json!({"frameId":1,"viewport":{"x":0,"y":0,"width":100,"height":100},
                "root":{"id":"root","bounds":{"x":0,"y":0,"width":100,"height":100},"opacity":1,"children":[
                    {"id":"phone","tag":"button","attributes":{"open-type":"getPhoneNumber","bindgetphonenumber":"onPhone"},"dataset":{"action":"authorize"},"bounds":{"x":0,"y":0,"width":50,"height":30},"opacity":1,"children":[{"id":"phone-label","tag":"text","bounds":{"x":0,"y":0,"width":50,"height":30},"opacity":1,"children":[]}]},
                    {"id":"camera","tag":"camera","attributes":{"bindinitdone":"onCamera"},"bounds":{"x":0,"y":40,"width":50,"height":30},"opacity":1,"children":[]}]}})));
            assert_eq!(frame.messages[0].payload["ok"], true, "{frame:?}");
            let components = session.host_component_snapshots();
            assert_eq!(components.len(), 2);
            let camera = components.iter().find(|node| node.tag == "camera").unwrap();
            assert_eq!(
                camera.bounds,
                Rect {
                    x: 0.0,
                    y: 40.0,
                    width: 50.0,
                    height: 30.0
                }
            );
            assert_eq!(camera.clips.len(), 1);
            assert_eq!(camera.account_epoch, u64::MAX);
            assert!(camera.visible);
            assert_eq!(call(&mut session, "publicApi"), json!(["undefined", true]));
            assert!(session.authorize_phone_button("camera").is_err());
            let tap = session.dispatch(request(
                "tap",
                op::EVENT_BATCH,
                json!({"events":[{"type":"tap","x":10,"y":10}]}),
            ));
            assert_eq!(tap.messages[0].payload["ok"], true, "{tap:?}");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].1, "weappContainer.identity.authorizePhone");
            assert_eq!(requests[0].2["componentId"], "phone");
            assert!(
                session.authorize_phone_button("phone").is_err(),
                "deduplicate native consent UI"
            );
            session
                .complete_host_api_call(&requests[0].0, Ok(json!({"code":"one-time-phone-code"})))
                .unwrap();
            assert_eq!(
                call(&mut session, "read"),
                json!([[
                    "phone",
                    "one-time-phone-code",
                    "getPhoneNumber:ok",
                    "authorize"
                ]])
            );
            let event = HostComponentEvent {
                session_id: session.config.session_id.clone(),
                account_epoch: u64::MAX,
                node_id: "camera".into(),
                event: "initdone".into(),
                sequence: 1,
                value: json!({"width":640}),
            };
            session
                .dispatch_host_component_event(event.clone())
                .unwrap();
            session.dispatch_host_component_event(event).unwrap();
            assert_eq!(
                call(&mut session, "read"),
                json!([
                    [
                        "phone",
                        "one-time-phone-code",
                        "getPhoneNumber:ok",
                        "authorize"
                    ],
                    ["camera", 640]
                ])
            );
            assert!(session
                .dispatch_host_component_event(HostComponentEvent {
                    session_id: session.config.session_id.clone(),
                    account_epoch: u64::MAX,
                    node_id: "phone".into(),
                    event: "getphonenumber".into(),
                    sequence: 1,
                    value: json!({"code":"forged"})
                })
                .is_err());
            session.authorize_phone_button("phone").unwrap();
            let pending = calls(&mut session);
            assert_eq!(pending.len(), 1);
            session.dispatch(request("pop", op::PAGE_POP, json!({})));
            assert!(session.host_component_snapshots().is_empty());
            session
                .complete_host_api_call(&pending[0].0, Ok(json!({"code":"late-after-page-unload"})))
                .unwrap();
            assert_eq!(
                call(&mut session, "read").as_array().unwrap().len(),
                2,
                "unloaded page never receives authorization"
            );
        }

        fn durable_synchronous_files(engine: EngineKind) {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let root = std::env::temp_dir().join(format!(
                "weapp-sync-contract-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let provider = Arc::new(ManagedSyncFileSystem::new(root.clone()).unwrap());
            let source = r#"const fs=wx.getFileSystemManager();try{wx.env.USER_DATA_PATH='/private';wx.env={USER_DATA_PATH:'/forged'};}catch(_){}fs.writeFileSync(wx.env.USER_DATA_PATH+'/module.bin',new Uint8Array([0,128,255]).buffer);exports.read=()=>Array.from(new Uint8Array(fs.readFileSync('wxfile://user/module.bin')));exports.mutate=()=>{fs.appendFileSync('wxfile://user/module.bin',new Uint8Array([42]).buffer);fs.mkdirSync('wxfile://user/dir');fs.copyFileSync('wxfile://user/module.bin','wxfile://user/dir/copy.bin');const stat=fs.statSync('wxfile://user/dir/copy.bin');return [stat.size,stat.isFile(),stat.isDirectory(),fs.readdirSync('wxfile://user/dir'),Array.from(new Uint8Array(fs.readFileSync('wxfile://user/module.bin',undefined,1,2)))];};exports.escape=()=>{try{fs.writeFileSync('wxfile://user/../escape','forged');return false;}catch(error){return error.code;}};exports.revoked=()=>{try{fs.readFileSync('wxfile://user/module.bin');return false;}catch(error){return error.code;}};"#;
            let descriptor_source = r#"
exports.descriptors=()=>{
  const fd=fs.openSync({filePath:'wxfile://user/module.bin',flag:'r+'});
  const buffer=new Uint8Array([9,9,9,9,9]).buffer;
  const first=fs.readSync({fd,arrayBuffer:buffer,offset:1,length:2,position:1});
  const zero=fs.readSync({fd,arrayBuffer:new ArrayBuffer(1)});
  const sequential=new ArrayBuffer(1);
  fs.readSync({fd,arrayBuffer:sequential,length:1});
  const written=fs.writeSync({fd,data:new Uint8Array([4,5,6]).buffer,offset:1,length:2,position:1});
  const current=new ArrayBuffer(2);fs.readSync({fd,arrayBuffer:current,length:2});
  const stat=fs.fstatSync({fd});fs.ftruncateSync({fd,length:6});fs.closeSync({fd});
  let closed;try{fs.fstatSync({fd});}catch(error){closed=error.code;}
  const expanded=Array.from(new Uint8Array(fs.readFileSync('wxfile://user/module.bin')));
  fs.truncateSync({filePath:'wxfile://user/module.bin',length:3});
  return [first.arrayBuffer===buffer,first.bytesRead,Array.from(new Uint8Array(buffer)),zero.bytesRead,Array.from(new Uint8Array(sequential)),written.bytesWritten,Array.from(new Uint8Array(current)),stat.size,stat.isFile(),closed,expanded];
};
exports.descriptorChunk=()=>{
  const fd=fs.openSync({filePath:'wxfile://user/module.bin'});
  const buffer=new ArrayBuffer(600000);const bytes=new Uint8Array(buffer);bytes[599999]=42;
  const result=fs.readSync({fd,arrayBuffer:buffer,length:1});fs.closeSync({fd});
  return [result.arrayBuffer===buffer,result.bytesRead,bytes[0],bytes[599999]];
};"#;
            let source = format!("{source}\n{descriptor_source}");
            let mut session = make_bound_mode(
                engine,
                &source,
                &["wx.getFileSystemManager"],
                &[],
                container_render_skia::PageRenderMode::Raster,
                Some(provider),
            );
            assert_eq!(
                std::fs::read(root.join("module.bin")).unwrap(),
                vec![0, 128, 255],
                "module evaluation completed actual disk write synchronously"
            );
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0].1, "wx.getFileSystemManager");
            session
                .complete_host_api_call(
                    &requests[0].0,
                    Ok(json!({"objectId":requests[0].2["objectId"]})),
                )
                .unwrap();
            assert_eq!(call(&mut session, "read"), json!([0, 128, 255]));
            assert_eq!(
                call(&mut session, "mutate"),
                json!([4, true, false, ["copy.bin"], [128, 255]])
            );
            assert_eq!(
                std::fs::read(root.join("dir/copy.bin")).unwrap(),
                vec![0, 128, 255, 42]
            );
            assert!(
                session.take_host_requests().is_empty(),
                "synchronous file work never defers durable writes to the host outbox"
            );
            assert_eq!(
                call(&mut session, "descriptors"),
                json!([
                    true,
                    2,
                    [9, 128, 255, 9, 9],
                    0,
                    [0],
                    2,
                    [5, 6],
                    4,
                    true,
                    "ERR_INVALID_REQUEST",
                    [0, 5, 6, 42, 0, 0]
                ])
            );
            assert_eq!(std::fs::read(root.join("module.bin")).unwrap(), [0, 5, 6]);
            assert_eq!(
                call(&mut session, "descriptorChunk"),
                json!([true, 1, 0, 42])
            );
            assert_eq!(call(&mut session, "escape"), "ERR_INVALID_REQUEST");
            session.revoke_host_services();
            assert_eq!(call(&mut session, "revoked"), "ERR_CANCELLED");
            drop(session);
            std::fs::remove_dir_all(root).unwrap();
        }

        fn native_file_codecs_preserve_utf16_and_actual_disk_bytes(engine: EngineKind) {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let root = std::env::temp_dir().join(format!(
                "weapp-file-codecs-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            let provider = Arc::new(ManagedSyncFileSystem::new(root.clone()).unwrap());
            let source = r#"
        const fs=wx.getFileSystemManager();
        const units=text=>{const result=[];for(let i=0;i<text.length;i++)result.push(text.charCodeAt(i));return result;};
        exports.run=()=>{
          const result=[];
          const aliases=['ascii','base64','binary','hex','ucs2','ucs-2','utf16le','utf-16le','utf-8','utf8','latin1'];
          for(let i=0;i<aliases.length;i++){
            const alias=aliases[i],path='wxfile://user/codec-'+i;
            const text=alias==='hex'?'0041ffzz':alias==='base64'?'A P8q':alias==='ascii'||alias==='binary'||alias==='latin1'?'\u00e9\u0100\ud800':'\ud800A\udc00😀';
            fs.writeFileSync(path,text,alias);
            result.push(units(fs.readFileSync(path,alias)));
          }
          fs.writeFileSync('wxfile://user/mixed','\ud800','ucs2');
          fs.appendFileSync('wxfile://user/mixed','\udc00','utf16le');
          const fd=fs.openSync({filePath:'wxfile://user/mixed',flag:'r+'});
          const write=fs.writeSync({fd,data:'0041ff',encoding:'hex',offset:99,length:0,position:1});
          fs.closeSync({fd});
          result.push(write.bytesWritten);
          result.push(Array.from(new Uint8Array(fs.readFileSync('wxfile://user/mixed'))));
          return result;
        };
        exports.revoked=()=>{try{fs.readFileSync('wxfile://user/mixed','ucs2');return false;}catch(error){return error.code;}};
        "#;
            let mut session = make_bound_mode(
                engine,
                source,
                &["wx.getFileSystemManager"],
                &[],
                container_render_skia::PageRenderMode::Raster,
                Some(provider),
            );
            let result = call(&mut session, "run");
            assert_eq!(
                result,
                json!([
                    [105, 0, 0],
                    [65, 80, 56, 113],
                    [233, 0, 0],
                    [48, 48, 52, 49, 102, 102],
                    [55296, 65, 56320, 55357, 56832],
                    [55296, 65, 56320, 55357, 56832],
                    [55296, 65, 56320, 55357, 56832],
                    [55296, 65, 56320, 55357, 56832],
                    [65533, 65, 65533, 55357, 56832],
                    [65533, 65, 65533, 55357, 56832],
                    [233, 0, 0],
                    3,
                    [0, 0, 65, 255]
                ])
            );
            for index in [4, 5, 6, 7] {
                assert_eq!(
                    std::fs::read(root.join(format!("codec-{index}"))).unwrap(),
                    [0, 216, 65, 0, 0, 220, 61, 216, 0, 222]
                );
            }
            for index in [8, 9] {
                assert_eq!(
                    std::fs::read(root.join(format!("codec-{index}"))).unwrap(),
                    [239, 191, 189, 65, 239, 191, 189, 240, 159, 152, 128]
                );
            }
            assert_eq!(std::fs::read(root.join("codec-1")).unwrap(), [0, 255, 42]);
            assert_eq!(std::fs::read(root.join("codec-3")).unwrap(), [0, 65, 255]);
            assert_eq!(std::fs::read(root.join("mixed")).unwrap(), [0, 0, 65, 255]);
            session.revoke_host_services();
            assert_eq!(call(&mut session, "revoked"), "ERR_CANCELLED");
            drop(session);
            std::fs::remove_dir_all(root).unwrap();
        }

        fn native_stats_share_materialization_across_all_locked_producer_shapes(
            engine: EngineKind,
        ) {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let root = std::env::temp_dir().join(format!(
                "weapp-stats-contract-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            std::fs::create_dir(&root).unwrap();
            std::fs::write(root.join("fixture.bin"), [0, 128, 255]).unwrap();
            std::fs::create_dir(root.join("directory")).unwrap();
            let directory_size = std::fs::metadata(root.join("directory")).unwrap().len();

            struct RecursiveFixture(Arc<ManagedSyncFileSystem>);
            impl container_core::SyncHostApi for RecursiveFixture {
                fn supported_apis(&self) -> Vec<String> {
                    container_core::SyncHostApi::supported_apis(self.0.as_ref())
                }
                fn retire(&self) {
                    container_core::SyncHostApi::retire(self.0.as_ref());
                }
                fn invoke(&self, name: &str, payload: Value) -> Result<Value, Value> {
                    if name == "object:FileSystemManager.statSync"
                        && payload.get("recursive").and_then(Value::as_bool) == Some(true)
                    {
                        // Exercise the locked recursive wire shape with actual
                        // disk metadata. Built-in recursive stat remains partial.
                        let mut entries = Vec::new();
                        for path in ["fixture.bin", "directory"] {
                            let stats = container_core::SyncHostApi::invoke(
                                self.0.as_ref(),
                                name,
                                json!({"path":format!("wxfile://user/{path}")}),
                            )?;
                            entries.push(json!({"path":path,"stats":stats}));
                        }
                        return Ok(json!(entries));
                    }
                    container_core::SyncHostApi::invoke(self.0.as_ref(), name, payload)
                }
            }
            let provider = Arc::new(RecursiveFixture(Arc::new(
                ManagedSyncFileSystem::new(root.clone()).unwrap(),
            )));
            let source = r#"
const fs=wx.getFileSystemManager(),seen=[];
const file=fs.statSync('wxfile://user/fixture.bin');
const directory=fs.statSync('wxfile://user/directory');
const fd=fs.openSync({filePath:'wxfile://user/fixture.bin',flag:'r'});
const descriptor=fs.fstatSync({fd});
const tree=fs.statSync('wxfile://user',true);
function shape(stats){
  const fileType=typeof stats.isFile,directoryType=typeof stats.isDirectory;
  return [fileType,directoryType,fileType==='function'?stats.isFile():null,
    directoryType==='function'?stats.isDirectory():null,stats.size,
    Object.prototype.hasOwnProperty.call(stats,'__weappFsStats')];
}
function treeShape(entries){return entries.map(entry=>[entry.path,shape(entry.stats)]);}
let singleReply,treeReply,descriptorReply,retained;
exports.sync=()=>[shape(file),shape(directory),shape(descriptor),treeShape(tree)];
exports.start=()=>{
  fs.stat({path:'wxfile://user/fixture.bin',success:result=>{
    singleReply=result.stats;seen.push(['stat-callback',shape(result.stats),typeof result.extra.isFile]);
  }}).then(result=>seen.push(['stat-promise',result.stats===singleReply,shape(result.stats)]));
  fs.stat({path:'wxfile://user',recursive:true,success:result=>{
    treeReply=result.stats;seen.push(['tree-callback',treeShape(result.stats),typeof result.stats[0].extra.isFile]);
  }}).then(result=>seen.push(['tree-promise',result.stats===treeReply,treeShape(result.stats)]));
  fs.fstat({fd,success:result=>{
    descriptorReply=result.stats;seen.push(['fstat-callback',shape(result.stats)]);
  }}).then(result=>seen.push(['fstat-promise',result.stats===descriptorReply,shape(result.stats)]));
  return 'started';
};
exports.read=()=>seen;
exports.capture=()=>{
  retained=[file.isFile,file.isDirectory,descriptor.isFile,descriptor.isDirectory];
  file.isFile=false;file.isDirectory=true;descriptor.isFile=false;descriptor.isDirectory=true;
  fs.closeSync({fd});return true;
};
exports.retained=()=>[retained.map(method=>method.call({isFile:false,isDirectory:true})),file.size,descriptor.size];
exports.current=()=>shape(fs.statSync('wxfile://user/fixture.bin'));
exports.revoked=()=>{try{fs.statSync('wxfile://user/directory');return false;}catch(error){return error.code;}};
"#;
            let mut session = make_bound_mode(
                engine,
                source,
                &[
                    "wx.getFileSystemManager",
                    "object:FileSystemManager.stat",
                    "object:FileSystemManager.fstat",
                ],
                &[],
                container_render_skia::PageRenderMode::Raster,
                Some(provider.clone()),
            );
            let factory = calls(&mut session);
            assert_eq!(factory.len(), 1);
            assert_eq!(factory[0].1, "wx.getFileSystemManager");
            session
                .complete_host_api_call(
                    &factory[0].0,
                    Ok(json!({"objectId":factory[0].2["objectId"]})),
                )
                .unwrap();
            let file_shape = json!(["function", "function", true, false, 3, false]);
            let directory_shape =
                json!(["function", "function", false, true, directory_size, false]);
            let tree_shape = json!([["fixture.bin", file_shape], ["directory", directory_shape]]);
            assert_eq!(
                call(&mut session, "sync"),
                json!([file_shape, directory_shape, file_shape, tree_shape])
            );
            assert!(session.take_host_requests().is_empty());
            assert_eq!(call(&mut session, "start"), "started");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 3);
            for (id, method, payload, _) in requests {
                let synchronous = match method.as_str() {
                    "object:FileSystemManager.stat" => "object:FileSystemManager.statSync",
                    "object:FileSystemManager.fstat" => "object:FileSystemManager.fstatSync",
                    _ => panic!("unexpected Stats request: {method}"),
                };
                let mut stats =
                    container_core::SyncHostApi::invoke(provider.as_ref(), synchronous, payload)
                        .unwrap();
                let ordinary_marker =
                    json!({"__weappFsStats":true,"isFile":true,"isDirectory":false});
                if let Some(entries) = stats.as_array_mut() {
                    entries[0]["extra"] = ordinary_marker.clone();
                }
                session
                    .complete_host_api_call(&id, Ok(json!({"stats":stats,"extra":ordinary_marker})))
                    .unwrap();
                call(&mut session, "read");
            }
            assert_eq!(
                call(&mut session, "read"),
                json!([
                    ["stat-callback", file_shape, "boolean"],
                    ["stat-promise", true, file_shape],
                    ["tree-callback", tree_shape, "boolean"],
                    ["tree-promise", true, tree_shape],
                    ["fstat-callback", file_shape],
                    ["fstat-promise", true, file_shape]
                ])
            );
            assert!(
                session.take_host_requests().is_empty(),
                "Stats functions never create a native outbox request"
            );
            assert_eq!(call(&mut session, "capture"), true);
            std::fs::remove_file(root.join("fixture.bin")).unwrap();
            std::fs::create_dir(root.join("fixture.bin")).unwrap();
            let replaced_size = std::fs::metadata(root.join("fixture.bin")).unwrap().len();
            assert_eq!(
                call(&mut session, "current"),
                json!(["function", "function", false, true, replaced_size, false])
            );
            assert_eq!(
                call(&mut session, "retained"),
                json!([[true, false, true, false], 3, 3])
            );
            session.revoke_host_services();
            assert_eq!(
                call(&mut session, "retained"),
                json!([[true, false, true, false], 3, 3]),
                "already-returned metadata is a local snapshot after owner retirement"
            );
            assert_eq!(call(&mut session, "revoked"), "ERR_CANCELLED");
            assert!(session.take_host_requests().is_empty());
            drop(session);
            std::fs::remove_dir_all(root).unwrap();
        }

        include!("stats-timestamp-engine-tests.rs");
        include!("stats-size-mode-engine-tests.rs");

        fn native_stats_decoding_rejects_invalid_flags_and_preserves_unrelated_json(
            engine: EngineKind,
        ) {
            let source = r#"
const fs=wx.getFileSystemManager(),seen=[];let inheritedReads=0;
function invalid(path,label){
  fs.stat({path,success:()=>seen.push('invalid-success'),fail:error=>seen.push([label+'-fail',error.code])})
    .catch(error=>seen.push([label+'-rejected',error.code]));
}
exports.start=()=>{
  for(const name of ['isFile','isDirectory'])Object.defineProperty(Object.prototype,name,{
    configurable:true,get(){inheritedReads++;throw new Error('Stats decoder read inherited flag');}
  });
  invalid('wxfile://user/missing-flag','missing');
  invalid('wxfile://user/nonboolean-flag','nonboolean');
  fs.stat({path:'wxfile://user/valid-flags',success:result=>seen.push([
    'valid',typeof result.stats.isFile,typeof result.stats.isDirectory,result.stats.isFile(),result.stats.isDirectory()
  ])});
  wx.request({url:'https://test.invalid/stats-marker',success:result=>seen.push([
    'ordinary',result.data.__weappFsStats,typeof result.data.isFile,typeof result.data.isDirectory
  ])});
  return true;
};
exports.read=()=>[seen,inheritedReads];
"#;
            let mut session = make(
                engine,
                source,
                &[
                    "wx.getFileSystemManager",
                    "object:FileSystemManager.stat",
                    "wx.request",
                ],
                &[],
            );
            let factory = calls(&mut session);
            assert_eq!(factory.len(), 1);
            session
                .complete_host_api_call(
                    &factory[0].0,
                    Ok(json!({"objectId":factory[0].2["objectId"]})),
                )
                .unwrap();
            assert_eq!(call(&mut session, "start"), true);
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 4);
            let request_cleanup = requests
                .iter()
                .find(|(_, method, _, _)| method == "wx.request")
                .expect("ordinary response marker test issued wx.request")
                .0
                .clone();
            for (id, method, payload, _) in requests {
                let value = match method.as_str() {
                    "object:FileSystemManager.stat" => match payload["path"].as_str().unwrap() {
                        "wxfile://user/missing-flag" => {
                            json!({"stats":{"__weappFsStats":true,"isDirectory":false}})
                        }
                        "wxfile://user/nonboolean-flag" => {
                            json!({"stats":{"__weappFsStats":true,"isFile":"true","isDirectory":false}})
                        }
                        "wxfile://user/valid-flags" => {
                            json!({"stats":{"__weappFsStats":true,"isFile":true,"isDirectory":false}})
                        }
                        path => panic!("unexpected Stats path: {path}"),
                    },
                    "wx.request" => {
                        json!({"statusCode":200,"data":{"__weappFsStats":true,"isFile":true,"isDirectory":false}})
                    }
                    _ => panic!("unexpected fixture request: {method}"),
                };
                session.complete_host_api_call(&id, Ok(value)).unwrap();
                call(&mut session, "read");
            }
            assert_eq!(
                call(&mut session, "read"),
                json!([
                    [
                        ["missing-fail", "ERR_INVALID_RESPONSE"],
                        ["missing-rejected", "ERR_INVALID_RESPONSE"],
                        ["nonboolean-fail", "ERR_INVALID_RESPONSE"],
                        ["nonboolean-rejected", "ERR_INVALID_RESPONSE"],
                        ["valid", "function", "function", true, false],
                        ["ordinary", true, "boolean", "boolean"]
                    ],
                    0
                ])
            );
            let remaining = session.take_host_requests();
            assert_eq!(
                remaining.len(),
                1,
                "remaining Stats fixture host requests: {remaining:?}"
            );
            assert!(matches!(&remaining[0], HostRequest::Cancel { call_id } if call_id == &request_cleanup),
                "only the completed wx.request task may release its retained native object: {remaining:?}");
        }

        fn native_contexts_are_resolved_in_the_selected_owner_scope(engine: EngineKind) {
            let source = r#"Page({});let video,completed=0;exports.make=()=>{video=wx.createVideoContext('player');return true;};exports.play=()=>{video.play({success(){completed++;},fail(){completed++;}}).catch(()=>completed++);return true;};exports.read=()=>completed;exports.closed=()=>{try{video.play();return false;}catch(error){return error.code;}};exports.fake=()=>{try{wx.createVideoContext('player',{__container_scope_id:'nested'});return false;}catch(error){return error.code;}};"#;
            let mut session = make(
                engine,
                source,
                &[
                    "component:video",
                    "wx.createVideoContext",
                    "object:VideoContext.play",
                ],
                &[],
            );
            session.dispatch(request(
                "page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ));
            session.dispatch(request("frame",op::RENDER_COMMIT,json!({"frameId":1,"viewport":{"x":0,"y":0,"width":100,"height":100},"root":{"id":"root","bounds":{"x":0,"y":0,"width":100,"height":100},"opacity":1,"children":[{"id":"page-video","tag":"video","attributes":{"id":"player"},"bounds":{"x":0,"y":0,"width":50,"height":50},"opacity":1,"children":[]},{"id":"nested-video","event_owner_scope_id":"nested","tag":"video","attributes":{"id":"player"},"bounds":{"x":50,"y":0,"width":50,"height":50},"opacity":1,"children":[]}]}})));
            call(&mut session, "make");
            let requests = session.take_host_requests();
            let (factory, object, context) = requests
                .into_iter()
                .find_map(|request| match request {
                    HostRequest::Call {
                        call_id,
                        method,
                        payload,
                        context: Some(context),
                        ..
                    } if method == "wx.createVideoContext" => {
                        Some((call_id, payload["objectId"].clone(), context))
                    }
                    _ => None,
                })
                .unwrap();
            let target = context.component_target.unwrap();
            assert_eq!(target.node_id, "page-video");
            assert_eq!(target.owner_scope_id, None);
            assert_eq!(call(&mut session, "fake"), "ERR_INVALID_REQUEST");
            assert!(session.take_host_requests().is_empty());
            session
                .complete_host_api_call(&factory, Ok(json!({"objectId":object})))
                .unwrap();
            call(&mut session, "play");
            let pending = calls(&mut session);
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].1, "object:VideoContext.play");
            session.dispatch(request("pop", op::PAGE_POP, json!({})));
            let retired = session.take_host_requests();
            assert!(retired.contains(&HostRequest::Cancel { call_id: factory }));
            assert!(retired.contains(&HostRequest::Cancel {
                call_id: pending[0].0.clone()
            }));
            assert!(session
                .complete_host_api_call(&pending[0].0, Ok(json!({})))
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(
                call(&mut session, "read"),
                0,
                "unloaded native context receives no stale continuation"
            );
        }

        fn native_component_pixels(engine: EngineKind) {
            let mut session = make_mode(
                engine,
                "Page({});",
                &["component:camera"],
                &[],
                container_render_skia::PageRenderMode::ExternalFrame,
            );
            session.dispatch(request(
                "launch",
                op::APP_LIFECYCLE,
                json!({"event":"launch"}),
            ));
            session.dispatch(request(
                "page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ));
            let geometry = |id: u64, x: f32| json!({"frameId":id,"viewport":{"x":0,"y":0,"width":4,"height":2},"root":{"id":"root","bounds":{"x":0,"y":0,"width":4,"height":2},"opacity":1,"children":[{"id":"camera","tag":"camera","bounds":{"x":x,"y":0,"width":2,"height":2},"opacity":1,"children":[]}]}});
            session.dispatch(request("frame", op::RENDER_COMMIT, geometry(1, 0.)));
            assert!(session.host_component_snapshots().is_empty());
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            let presented = session.host_component_snapshots();
            assert_eq!(presented.len(), 1);
            let sample = HostComponentFrame {
                session_id: session.config.session_id.clone(),
                account_epoch: u64::MAX,
                page_id: presented[0].page_id,
                node_id: "camera".into(),
                sequence: 1,
                width: 1,
                height: 1,
                format: "rgba8".into(),
                pixels: vec![255, 0, 0, 255],
            };
            assert!(session.submit_host_component_frame(sample.clone()).unwrap());
            assert!(!session.is_current_frame_presented());
            assert_eq!(
                session.host_component_snapshots(),
                presented,
                "pending pixel repaint preserves existing presented mounts"
            );
            let mut next = sample.clone();
            next.sequence = 2;
            next.pixels = vec![0, 0, 255, 255];
            assert!(
                session.submit_host_component_frame(next.clone()).unwrap(),
                "consecutive media frames coalesce before presentation"
            );
            assert!(!session.submit_host_component_frame(sample.clone()).unwrap());
            next.sequence = 3;
            next.session_id = "stale-session".into();
            assert!(!session.submit_host_component_frame(next.clone()).unwrap());
            next.session_id = sample.session_id.clone();
            next.width = 2;
            assert!(session.submit_host_component_frame(next).is_err());
            assert_eq!(
                session
                    .renderer()
                    .last_frame()
                    .unwrap()
                    .images
                    .values()
                    .next()
                    .unwrap()
                    .pixels,
                vec![0, 0, 255, 255]
            );
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            assert_eq!(
                session.host_component_snapshots()[0].revision,
                session.render_revision()
            );
            let old = session.host_component_snapshots();
            session.dispatch(request("frame2", op::RENDER_COMMIT, geometry(2, 2.)));
            assert_eq!(
                session.host_component_snapshots(),
                old,
                "unpresented geometry keeps previous mounts"
            );
            let mut next = sample.clone();
            next.sequence = 3;
            assert!(
                !session.submit_host_component_frame(next.clone()).unwrap(),
                "producer cannot bypass geometry presentation"
            );
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            assert!(session.submit_host_component_frame(next).unwrap());
            let mut invisible = geometry(3, 2.);
            invisible["root"]["children"][0]["opacity"] = json!(0);
            session.dispatch(request("invisible", op::RENDER_COMMIT, invisible));
            session
                .acknowledge_presentation(session.render_revision())
                .unwrap();
            let mut hidden = sample.clone();
            hidden.sequence = 4;
            assert!(
                !session.submit_host_component_frame(hidden).unwrap(),
                "hidden component rejects late frames"
            );
            session.dispatch(request("hide", op::APP_LIFECYCLE, json!({"event":"hide"})));
            assert!(
                session.host_component_snapshots().is_empty(),
                "background components release native devices"
            );
            assert!(
                session.renderer().last_frame().unwrap().images.is_empty(),
                "background releases cached media bytes"
            );
            let mut hidden = sample.clone();
            hidden.sequence = 4;
            assert!(
                !session.submit_host_component_frame(hidden).unwrap(),
                "late camera pixels cannot repaint a hidden app"
            );
            session.revoke_host_services();
            assert!(!session.submit_host_component_frame(sample).unwrap());
            assert!(session.renderer().last_frame().unwrap().images.is_empty());
        }

        fn packaged_media_is_bound_to_accepted_lexical_source(engine: EngineKind) {
            let mut session = make(engine, "Page({});", &["component:video"], &[]);
            session.dispatch(request(
                "launch",
                op::APP_LIFECYCLE,
                json!({"event":"launch"}),
            ));
            session.dispatch(request(
                "page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index"}),
            ));
            let frame=session.dispatch(request("frame",op::RENDER_COMMIT,json!({"frameId":1,"viewport":{"x":0,"y":0,"width":100,"height":100},"root":{"id":"video","event_identity":"video-occurrence","event_owner_scope_id":"scope","tag":"video","attributes":{"src":"./clip.mp4"},"bounds":{"x":0,"y":0,"width":100,"height":100},"opacity":1,"children":[]}})));
            assert_eq!(frame.messages[0].payload["ok"], true, "{frame:?}");
            let page = session.app_service.pages().current().unwrap().id.0;
            let bytes = b"verified packaged video".to_vec();
            let digest = container_ir::hex_digest(&bytes);
            session.manifest.assets.push(container_ir::Asset {
                path: "components/player/clip.mp4".into(),
                sha256: digest.clone(),
                size: bytes.len() as u64,
                mime: "video/mp4".into(),
            });
            session.render_blobs = Arc::new(BTreeMap::from([(
                format!("sha256:{digest}"),
                bytes.clone(),
            )]));
            session.accepted_view_document = Some(container_ir::ViewDocument {
                version: container_ir::VIEW_DOCUMENT_VERSION.into(),
                session_id: session.config.session_id.clone(),
                page_id: page,
                revision: session.render_revision(),
                route_path: "pages/index/index".into(),
                profile: container_ir::RendererProfile::Skia,
                nodes: vec![container_ir::ViewNode::Element {
                    occurrence_id: "video-occurrence".into(),
                    tag: "video".into(),
                    attrs: BTreeMap::from([("src".into(), "./clip.mp4".into())]),
                    typed_attrs: BTreeMap::new(),
                    key: None,
                    ownership: container_ir::ViewOwnership {
                        event_owner: Some("scope".into()),
                        document_id: "components/player/player.wxml".into(),
                        ..Default::default()
                    },
                    events: vec![],
                    children: vec![],
                }],
                style_roots: vec![],
                styles: vec![],
                resources: vec![],
            });
            let read = |session: &Session, epoch, page, node: &str| {
                session
                    .host_component_resource(&session.config.session_id, epoch, page, node)
                    .map(Vec::from)
            };
            assert_eq!(
                read(&session, u64::MAX, page, "video-occurrence").unwrap(),
                bytes,
                "relative source resolves against component, not page route"
            );
            assert!(read(&session, u64::MAX - 1, page, "video-occurrence").is_err());
            assert!(read(&session, u64::MAX, page + 1, "video-occurrence").is_err());
            assert!(
                read(&session, u64::MAX, page, "video").is_err(),
                "public/render id is not occurrence authority"
            );
            if let container_ir::ViewNode::Element { attrs, .. } =
                &mut session.accepted_view_document.as_mut().unwrap().nodes[0]
            {
                attrs.insert("src".into(), "other.mp4".into());
            }
            assert!(
                read(&session, u64::MAX, page, "video-occurrence").is_err(),
                "changed source cannot reuse old presentation"
            );
            if let container_ir::ViewNode::Element { attrs, .. } =
                &mut session.accepted_view_document.as_mut().unwrap().nodes[0]
            {
                attrs.insert("src".into(), "./clip.mp4".into());
            }
            session.render_blobs = Arc::new(BTreeMap::from([(
                format!("sha256:{digest}"),
                vec![0; bytes.len()],
            )]));
            assert!(
                read(&session, u64::MAX, page, "video-occurrence").is_err(),
                "cached bytes are reverified"
            );
            session.render_blobs = Arc::new(BTreeMap::from([(format!("sha256:{digest}"), bytes)]));
            session.dispatch(request("hide", op::APP_LIFECYCLE, json!({"event":"hide"})));
            assert!(read(&session, u64::MAX, page, "video-occurrence").is_err());
        }

        fn packaged_api_bytes_require_exact_pending_call(engine: EngineKind) {
            let source = r#"let audio;
                exports.create=()=>{audio=wx.createInnerAudioContext();return true};
                exports.source=()=>{audio.src='/assets/tone.wav';return true};
                exports.escape=()=>{audio.src='../assets/tone.wav';return true};
                exports.login=()=>{wx.login({});return true};"#;
            let mut session = make(
                engine,
                source,
                &[
                    "wx.createInnerAudioContext",
                    "object:InnerAudioContext.src",
                    "wx.login",
                ],
                &[],
            );
            let bytes = b"verified packaged audio".to_vec();
            let digest = container_ir::hex_digest(&bytes);
            session.manifest.assets.push(container_ir::Asset {
                path: "assets/tone.wav".into(),
                sha256: digest.clone(),
                size: bytes.len() as u64,
                mime: "audio/wav".into(),
            });
            session.render_blobs = Arc::new(BTreeMap::from([(
                format!("sha256:{digest}"),
                bytes.clone(),
            )]));
            call(&mut session, "create");
            let factory = calls(&mut session).remove(0);
            session
                .complete_host_api_call(&factory.0, Ok(json!({"objectId":factory.2["objectId"]})))
                .unwrap();
            assert!(session.host_api_resource(&factory.3).is_err());
            call(&mut session, "source");
            let setter = calls(&mut session).remove(0);
            assert_eq!(session.host_api_resource(&setter.3).unwrap(), bytes);
            for field in [
                "account",
                "application",
                "api",
                "session",
                "call",
                "deadline",
            ] {
                let mut wrong = setter.3.clone();
                match field {
                    "account" => wrong.account.principal_id = Some("other".into()),
                    "application" => wrong.application.pack_root = "0".repeat(64),
                    "api" => wrong.api = "wx.login".into(),
                    "session" => wrong.session_id.push('x'),
                    "call" => wrong.call_id.push('x'),
                    _ => wrong.deadline_ns = None,
                }
                assert!(session.host_api_resource(&wrong).is_err(), "{field}");
            }
            session.render_blobs = Arc::new(BTreeMap::from([(
                format!("sha256:{digest}"),
                vec![0; bytes.len()],
            )]));
            assert!(
                session.host_api_resource(&setter.3).is_err(),
                "reverify bytes on every read"
            );
            session.render_blobs = Arc::new(BTreeMap::from([(format!("sha256:{digest}"), bytes)]));
            session
                .complete_host_api_call(&setter.0, Ok(json!({})))
                .unwrap();
            assert!(
                session.host_api_resource(&setter.3).is_err(),
                "settled context cannot read bytes"
            );
            call(&mut session, "escape");
            let escape = calls(&mut session).remove(0);
            assert!(
                session.host_api_resource(&escape.3).is_err(),
                "root-relative API paths cannot escape pack"
            );
            call(&mut session, "login");
            let login = calls(&mut session).remove(0);
            assert!(
                session.host_api_resource(&login.3).is_err(),
                "unrelated pending call has no media authority"
            );
            call(&mut session, "source");
            let cancelled = calls(&mut session).remove(0);
            session.cancel_host_calls().unwrap();
            assert!(
                session.host_api_resource(&cancelled.3).is_err(),
                "revoked owner cannot read package bytes"
            );
        }

        fn packaged_api_resource_reserves_wire_metadata(engine: EngineKind) {
            let source = r#"let audio;
                exports.create=()=>{audio=wx.createInnerAudioContext();return true};
                exports.source=()=>{audio.src='/assets/boundary.wav';return true};"#;
            let mut session = make(
                engine,
                source,
                &["wx.createInnerAudioContext", "object:InnerAudioContext.src"],
                &[],
            );
            call(&mut session, "create");
            let factory = calls(&mut session).remove(0);
            session
                .complete_host_api_call(&factory.0, Ok(json!({"objectId":factory.2["objectId"]})))
                .unwrap();
            for size in [HOST_API_RESOURCE_MAX_BYTES, HOST_API_RESOURCE_MAX_BYTES + 1] {
                let bytes = vec![42; size];
                let digest = container_ir::hex_digest(&bytes);
                session
                    .manifest
                    .assets
                    .retain(|asset| asset.path != "assets/boundary.wav");
                session.manifest.assets.push(container_ir::Asset {
                    path: "assets/boundary.wav".into(),
                    sha256: digest.clone(),
                    size: size as u64,
                    mime: "audio/wav".into(),
                });
                session.render_blobs =
                    Arc::new(BTreeMap::from([(format!("sha256:{digest}"), bytes)]));
                call(&mut session, "source");
                let setter = calls(&mut session).remove(0);
                if size == HOST_API_RESOURCE_MAX_BYTES {
                    assert_eq!(session.host_api_resource(&setter.3).unwrap().len(), size);
                } else {
                    assert!(session
                        .host_api_resource(&setter.3)
                        .unwrap_err()
                        .message
                        .contains("wire budget"));
                }
                session
                    .complete_host_api_call(&setter.0, Ok(json!({})))
                    .unwrap();
            }
        }

        fn local_unsubscribe_without_native_counterpart(engine: EngineKind) {
            let source = r#"let count=0;const listener=()=>count++;exports.start=()=>{wx.onNetworkStatusChange(listener);return true;};exports.off=()=>{wx.offNetworkStatusChange(listener);return true;};exports.read=()=>count;"#;
            let mut session = make(engine, source, &["wx.onNetworkStatusChange"], &[]);
            call(&mut session, "start");
            let requests = calls(&mut session);
            assert_eq!(requests.len(), 1);
            session
                .complete_host_api_call(&requests[0].0, Ok(json!({})))
                .unwrap();
            call(&mut session, "off");
            assert_eq!(
                session.take_host_requests(),
                vec![HostRequest::Cancel {
                    call_id: requests[0].0.clone()
                }]
            );
            session
                .dispatch_host_api_event(HostApiEvent {
                    session_id: session.config.session_id.clone(),
                    account_epoch: u64::MAX,
                    subscription_id: requests[0].2["subscriptionId"].as_str().unwrap().into(),
                    sequence: 1,
                    value: json!({"isConnected":true}),
                    object_id: None,
                    event: Some("NetworkStatusChange".into()),
                })
                .unwrap();
            assert_eq!(call(&mut session, "read"), 0);
        }

        macro_rules! cases {
            ($module:ident,$engine:expr) => {
                mod $module {
                    use super::*;
                    #[test]
                    fn native_snapshots_context_and_errors() {
                        snapshots_context_and_errors($engine);
                    }
                    #[test]
                    fn explicit_unsupported_and_api_validation() {
                        unsupported_and_validation($engine);
                    }
                    #[test]
                    fn objects_events_and_binary_are_owned() {
                        object_events_and_binary($engine);
                    }
                    #[test]
                    fn inner_audio_properties_are_ready_before_factory_reply_and_follow_host_updates() {
                        inner_audio_defaults_are_synchronous_mutable_and_negotiated($engine);
                    }
                    #[test]
                    fn nfc_technology_names_are_ready_in_the_factory_turn() {
                        nfc_technology_enum_is_synchronous_and_negotiated($engine);
                    }
                    #[test]
                    fn native_tasks_preserve_callbacks_abort_and_binary() {
                        native_tasks_cancel_and_transfer_binary($engine);
                    }
                    #[test]
                    fn native_inline_float_binary_preserves_js_callback_and_promise_order() {
                        native_inline_binary_float_bytes_reach_javascript($engine);
                    }
                    #[test]
                    fn identity_revocation_does_not_enter_guest() {
                        revocation_never_enters_guest($engine);
                    }
                    #[test]
                    fn phone_authorization_uses_real_component_event_route() {
                        phone_button_and_native_components($engine);
                    }
                    #[test]
                    fn synchronous_files_are_durable_binary_safe_and_revocable() {
                        durable_synchronous_files($engine);
                    }
                    #[test]
                    fn synchronous_file_codecs_preserve_utf16_and_actual_disk_bytes() {
                        native_file_codecs_preserve_utf16_and_actual_disk_bytes($engine);
                    }
                    #[test]
                    fn stats_share_materialization_across_all_locked_producer_shapes() {
                        native_stats_share_materialization_across_all_locked_producer_shapes($engine);
                    }
                    #[cfg(unix)]
                    #[test]
                    fn stats_timestamps_are_actual_numbers_and_retained_snapshots() {
                        native_stats_timestamps_are_actual_numbers_and_retained_snapshots($engine);
                    }
                    #[cfg(any(unix, windows))]
                    #[test]
                    fn stats_size_is_actual_and_writable() {
                        native_stats_size_is_actual_and_writable($engine);
                    }
                    #[cfg(unix)]
                    #[test]
                    fn stats_size_mode_are_actual_owned_writable_snapshots() {
                        native_stats_size_mode_are_actual_owned_writable_snapshots($engine);
                    }
                    #[cfg(unix)]
                    #[test]
                    #[ignore = "requires real filesystem support for sparse files above 2^53 bytes"]
                    fn stats_real_sparse_size_above_safe_integer() {
                        native_stats_real_sparse_size_above_safe_integer($engine);
                    }
                    #[test]
                    fn stats_decoding_rejects_invalid_flags_and_preserves_unrelated_json() {
                        native_stats_decoding_rejects_invalid_flags_and_preserves_unrelated_json($engine);
                    }
                    #[test]
                    fn native_context_target_is_minted_from_accepted_scope() {
                        native_contexts_are_resolved_in_the_selected_owner_scope($engine);
                    }
                    #[test]
                    fn native_media_frames_preserve_paint_and_presentation_ownership() {
                        native_component_pixels($engine);
                    }
                    #[test]
                    fn native_media_resources_require_the_accepted_declaration() {
                        packaged_media_is_bound_to_accepted_lexical_source($engine);
                    }
                    #[test]
                    fn native_api_resources_require_the_exact_pending_call() {
                        packaged_api_bytes_require_exact_pending_call($engine);
                    }
                    #[test]
                    fn native_api_resource_ceiling_reserves_wire_metadata() {
                        packaged_api_resource_reserves_wire_metadata($engine);
                    }
                    #[test]
                    fn off_without_native_counterpart_still_releases_subscription() {
                        local_unsubscribe_without_native_counterpart($engine);
                    }
                }
            };
        }
        #[cfg(feature = "quickjs-native")]
        cases!(quickjs, EngineKind::Quickjs);
        #[cfg(feature = "v8-native")]
        cases!(v8, EngineKind::V8);
    }
}
