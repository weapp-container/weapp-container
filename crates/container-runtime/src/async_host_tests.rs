#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod host_async_contract {
    use super::*;

    struct DeferredProvider(SandboxProvider);
    impl HostApiProvider for DeferredProvider {
        fn name(&self) -> &'static str {
            "deferred-test"
        }
        fn call(
            &mut self,
            name: &str,
            payload: &Map<String, Value>,
            context: &ProviderContext,
        ) -> Result<Value, ProviderError> {
            self.0.call(name, payload, context)
        }
        fn start_call(
            &mut self,
            name: &str,
            payload: &Map<String, Value>,
            context: &ProviderContext,
        ) -> ProviderStart {
            if name == "wx.request" {
                ProviderStart::Pending
            } else {
                ProviderStart::Ready(self.call(name, payload, context))
            }
        }
    }

    fn make(engine: EngineKind, source: &str) -> Session {
        let mut manifest = module_manifest(source.as_bytes(), ModuleFormat::Commonjs);
        manifest
            .capabilities
            .insert("wx.request".into(), CapabilitySupport::Partial);
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                engine,
                ..Default::default()
            },
        )
        .unwrap();
        session.set_host_methods(vec!["echo".into()]).unwrap();
        session.set_provider(Box::new(DeferredProvider(SandboxProvider::new())));
        let result = session.dispatch(request(
            "init",
            op::APP_INIT,
            json!({"modules":[{"id":"module:app","source":source}]}),
        ));
        assert_eq!(result.messages[0].payload["ok"], true, "{result:?}");
        session
    }

    fn call(session: &mut Session, export: &str) -> Value {
        let batch = session.dispatch(request(
            export,
            op::MODULE_CALL,
            json!({"moduleId":"module:app","export":export,"args":[]}),
        ));
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        let value = batch.messages[0].payload["result"][0].clone();
        if export == "read" {
            value["log"].clone()
        } else {
            value
        }
    }

    fn calls(session: &mut Session) -> Vec<(String, String, Value)> {
        session
            .take_host_requests()
            .into_iter()
            .filter_map(|r| match r {
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

    fn independent_calls(engine: EngineKind) {
        let source = r#"
          const log = [];
          exports.start = function() {
            weappContainer.invoke('echo', {n:1}).then(value => { log.push(value); wx.setStorageSync('done',value); weappContainer.postMessage({done:value}); });
            weappContainer.invoke('echo', {n:2}).then(value => log.push(value));
            setTimeout(() => log.push('timer'), 1);
            return 'returned';
          };
          exports.read = () => ({log});
        "#;
        let mut session = make(engine, source);
        assert_eq!(call(&mut session, "start"), "returned");
        let requests = calls(&mut session);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].1, "echo");
        assert_eq!(requests[0].2, json!({"n":1}));
        assert_ne!(requests[0].0, requests[1].0);
        session.poll_timers(u64::MAX);
        assert_eq!(call(&mut session, "read"), json!(["timer"]));
        session
            .complete_host_call(&requests[1].0, Ok(json!(2)))
            .unwrap();
        session
            .complete_host_call(&requests[0].0, Ok(json!(1)))
            .unwrap();
        assert_eq!(call(&mut session, "read"), json!(["timer", 2, 1]));
        assert_eq!(session.storage_snapshot().values["done"], json!(1));
        assert_eq!(
            session.take_host_requests(),
            vec![HostRequest::Message {
                payload: json!({"done":1})
            }]
        );
        assert!(session
            .complete_host_call(&requests[0].0, Ok(json!(99)))
            .unwrap()
            .messages
            .is_empty());
        let mut newer = make(engine, source);
        call(&mut newer, "start");
        assert!(newer
            .complete_host_call(&requests[0].0, Ok(json!(99)))
            .unwrap()
            .messages
            .is_empty());
        assert_eq!(newer.pending_host_call_count(), 2);
        assert_eq!(session.pending_host_call_count(), 0);
    }

    fn result_bridge_and_messages(engine: EngineKind) {
        let source = r#"
          const log = [];
          const first = data => { log.push(data); data.changed = true; throw new Error('listener throw'); };
          const second = data => { log.push(data.changed === undefined); weappContainer.invoke('echo', data).then(v => log.push(v)); };
          weappContainer.onMessage(first); weappContainer.onMessage(first); weappContainer.onMessage(second);
          exports.off = () => { weappContainer.offMessage(first); weappContainer.offMessage(second); return true; };
          exports.read = () => ({log});
        "#;
        let mut session = make(engine, source);
        let messages = session.send_host_message(json!({"hello":1})).unwrap();
        assert!(messages.messages.iter().any(|m| m.op == op::ERROR));
        let requests = calls(&mut session);
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].2, json!({"hello":1}));
        let result = session.dispatch(request(
            "result",
            op::API_RESULT,
            json!({"callId":requests[0].0,"result":"completed"}),
        ));
        assert_eq!(result.messages[0].payload["accepted"], true);
        let duplicate = session.dispatch(request(
            "duplicate",
            op::API_RESULT,
            json!({"callId":requests[0].0,"result":"again"}),
        ));
        assert_eq!(duplicate.messages[0].payload["accepted"], false);
        assert_eq!(
            call(&mut session, "read"),
            json!([{"hello":1,"changed":true},true,"completed"])
        );
        call(&mut session, "off");
        session.send_host_message(json!({"hello":2})).unwrap();
        assert!(calls(&mut session).is_empty());
    }

    fn cancellation_timeout_and_close(engine: EngineKind) {
        let source = r#"
          const log = [];
          let task;
          exports.start = () => {
            task = wx.request({url:'https://test.invalid', cancelToken:'network',
              fail:e=>{log.push('fail:'+e.code);throw new Error('callback throw');}, complete:()=>log.push('complete')});
            task.catch(e=>log.push('reject:'+e.code)); return true;
          };
          exports.abort = () => { task.abort(); task.abort(); return true; };
          exports.invoke = () => { weappContainer.invoke('echo', null).catch(e=>log.push(e.code)); return true; };
          exports.read = () => ({log});
        "#;
        let mut session = make(engine, source);
        call(&mut session, "start");
        let id = calls(&mut session).remove(0).0;
        call(&mut session, "abort");
        assert_eq!(session.pending_host_call_count(), 0);
        assert_eq!(
            session.take_host_requests(),
            vec![HostRequest::Cancel {
                call_id: id.clone()
            }]
        );
        assert_eq!(
            call(&mut session, "read"),
            json!(["fail:ERR_CANCELLED", "complete", "reject:ERR_CANCELLED"])
        );
        assert!(session
            .complete_host_call(&id, Ok(json!({})))
            .unwrap()
            .messages
            .is_empty());
        call(&mut session, "invoke");
        let timed = calls(&mut session).remove(0).0;
        let deadline = session.next_host_deadline_ns().unwrap();
        session.poll_host_timeouts(deadline).unwrap();
        assert_eq!(
            session.take_host_requests(),
            vec![HostRequest::Cancel { call_id: timed }]
        );
        assert_eq!(call(&mut session, "read")[3], "ERR_TIMEOUT");
        call(&mut session, "invoke");
        let closed = calls(&mut session).remove(0).0;
        session.cancel_host_calls().unwrap();
        assert_eq!(
            session.take_host_requests(),
            vec![HostRequest::Cancel {
                call_id: closed.clone()
            }]
        );
        assert_eq!(call(&mut session, "read")[4], "ERR_CANCELLED");
        assert!(session
            .complete_host_call(&closed, Ok(json!(1)))
            .unwrap()
            .messages
            .is_empty());
        call(&mut session, "invoke");
        assert!(calls(&mut session).is_empty());
        assert_eq!(session.pending_host_call_count(), 0);
    }

    fn network_binary_and_same_turn_abort(engine: EngineKind) {
        let source = r#"
          const log = [];
          exports.start = () => {
            wx.request({url:'https://test.invalid',data:new Uint8Array([0,128,255]),responseType:'arraybuffer',
              success:r=>{log.push(r.data instanceof ArrayBuffer);log.push(Array.from(new Uint8Array(r.data)));},
              complete:()=>log.push('complete')}).then(()=>log.push('resolved'));
            return true;
          };
          exports.abortNow = () => { const task=wx.request({url:'https://test.invalid'}); task.catch(e=>log.push(e.code)); task.abort(); return true; };
          exports.read = () => ({log});
        "#;
        let mut session = make(engine, source);
        call(&mut session, "start");
        let request = calls(&mut session).remove(0);
        assert_eq!(request.1, "wx.request");
        assert_eq!(request.2["dataEncoding"], "bytes");
        assert_eq!(request.2["data"], json!([0, 128, 255]));
        session
            .complete_host_call(
                &request.0,
                Ok(json!({"data":[0,128,255],"dataEncoding":"bytes","statusCode":200,"header":{}})),
            )
            .unwrap();
        assert_eq!(
            call(&mut session, "read"),
            json!([true, [0, 128, 255], "complete", "resolved"])
        );
        call(&mut session, "abortNow");
        assert!(calls(&mut session).is_empty());
        assert_eq!(call(&mut session, "read")[4], "ERR_CANCELLED");
    }

    fn queue_and_registration(engine: EngineKind) {
        let source = r#"
          const failures=[];
          exports.start = () => {
            weappContainer.invoke('missing',null).catch(e=>failures.push(e.code));
            for(let i=0;i<260;i++) weappContainer.invoke('echo',i).catch(e=>failures.push(e.code));
            return true;
          };
          exports.read = () => ({log:failures});
        "#;
        let mut session = make(engine, source);
        assert!(session.set_host_methods(vec!["late".into()]).is_err());
        call(&mut session, "start");
        assert_eq!(session.pending_host_call_count(), 256);
        assert_eq!(calls(&mut session).len(), 256);
        let failures = call(&mut session, "read");
        assert_eq!(failures.as_array().unwrap().len(), 5);
        assert_eq!(failures[0], "ERR_UNSUPPORTED_CAPABILITY");
        session.cancel_host_calls().unwrap();
        assert_eq!(session.pending_host_call_count(), 0);
    }

    fn direct_bridge_pending(engine: EngineKind) {
        let mut session = make(engine, "exports.ping=()=>true;");
        let pending = session.dispatch(request(
            "http-1",
            op::API_CALL,
            json!({"name":"wx.request","url":"https://test.invalid"}),
        ));
        assert_eq!(pending.messages[0].payload["pending"], true);
        let id = calls(&mut session).remove(0).0;
        assert_eq!(pending.messages[0].payload["callId"], id);
        let completed = session.dispatch(request("http-result", op::API_RESULT, json!({"callId":id,"error":{"code":"timeout","message":"transport timed out","retryable":true}})));
        assert_eq!(completed.messages[0].payload["accepted"], true);
        let event = completed
            .messages
            .iter()
            .find(|event| event.kind == EnvelopeKind::Event && event.op == op::API_RESULT)
            .unwrap();
        assert_eq!(event.payload["requestId"], "http-1");
        assert_eq!(event.payload["error"]["code"], "ERR_TIMEOUT");
        assert_eq!(session.pending_host_call_count(), 0);
        let duplicate = session.dispatch(request(
            "duplicate",
            op::API_RESULT,
            json!({"callId":id,"result":null}),
        ));
        assert_eq!(duplicate.messages[0].payload["accepted"], false);
    }

    macro_rules! engine_cases {
        ($module:ident, $engine:expr) => {
            mod $module {
                use super::*;
                #[test]
                fn bridge_pending_completion_preserves_request_correlation() {
                    direct_bridge_pending($engine);
                }
                #[test]
                fn pending_does_not_block_and_results_are_correlated() {
                    independent_calls($engine);
                }
                #[test]
                fn api_result_and_business_messages_execute_real_callbacks() {
                    result_bridge_and_messages($engine);
                }
                #[test]
                fn cancel_timeout_and_close_settle_once() {
                    cancellation_timeout_and_close($engine);
                }
                #[test]
                fn binary_http_and_immediate_abort_preserve_task_contract() {
                    network_binary_and_same_turn_abort($engine);
                }
                #[test]
                fn registration_and_pending_budget_are_enforced() {
                    queue_and_registration($engine);
                }
            }
        };
    }
    #[cfg(feature = "quickjs-native")]
    engine_cases!(quickjs, EngineKind::Quickjs);
    #[cfg(feature = "v8-native")]
    engine_cases!(v8, EngineKind::V8);
}
