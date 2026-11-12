//! Source-defined library/TCP coverage. These are not browser, GPU or platform
//! acceptance. Every binding below originates in an actual owned SSE socket.
use super::*;

fn envelope(op: &str, request: &str, payload: Value) -> Value {
    serde_json::to_value(BridgeEnvelope::request(
        "strict-owner",
        request,
        op,
        payload,
    ))
    .unwrap()
}

fn fenced(mut message: Value, init: &Value, epoch: u64) -> Value {
    message["preview"] = json!({"clientId":init["clientId"],"epoch":epoch.to_string(),
        "connectionToken":init["connectionToken"]});
    message
}

fn parse_fixture() -> Value {
    fenced(
        envelope(ACK_OP, "ack", json!({})),
        &json!({"clientId":"owner","connectionToken":"bounded-token"}),
        1,
    )
}

#[test]
fn strict_ack_final_prioritizes_typed_fatal_errors_without_losing_diagnostics() {
    let mut request = BridgeEnvelope::request("strict-owner", "original-ack", ACK_OP, json!({}));
    request.trace_id = Some("original-trace".into());
    let raw = BridgeEnvelope::event(
        "strict-owner",
        op::ERROR,
        json!({"source":"quickjs","errors":[{"message":"raw JS error"}]}),
    );
    let typed = BridgeEnvelope::event(
        "strict-owner",
        op::ERROR,
        json!({"ok":false,"committed":true,"phase":"ready","frameId":9,
            "error":{"code":"ERR_ENGINE","message":"ready threw","request_id":"view-presented"}}),
    );
    let fatal = BridgeEnvelope::event(
        "strict-owner",
        op::ERROR,
        json!({"ok":false,"committed":true,"phase":"effects","frameId":9,"requiresRestart":true,
            "error":{"code":"ERR_TIMEOUT","message":"effects exhausted their deadline","request_id":"native-turn"}}),
    );
    let ticket = json!({"owner":"unchanged-exact-ticket"});
    let payload = json!({"ok":true,"inputEnabled":true,"presentationTicket":ticket});
    let batch = BridgeBatch::new(vec![raw.clone(), typed, fatal]);
    let original = serde_json::to_vec(&batch).unwrap();
    let final_response = committed_ack_response(&request, payload.clone(), &batch);
    assert_eq!(final_response.kind, EnvelopeKind::Response);
    assert_eq!(final_response.session_id, request.session_id);
    assert_eq!(final_response.request_id, request.request_id);
    assert_eq!(final_response.op, ACK_OP);
    assert_eq!(final_response.trace_id, request.trace_id);
    assert_eq!(final_response.payload["ok"], false);
    assert_eq!(final_response.payload["committed"], true);
    assert_eq!(final_response.payload["error"]["code"], "ERR_TIMEOUT");
    assert_eq!(
        final_response.payload["error"]["request_id"],
        "original-ack"
    );
    assert_eq!(final_response.payload["phase"], "effects");
    assert_eq!(final_response.payload["frameId"], 9);
    assert_eq!(final_response.payload["requiresRestart"], true);
    assert_eq!(final_response.payload["inputEnabled"], false);
    assert_eq!(final_response.payload["presentationTicket"], ticket);
    assert_eq!(serde_json::to_vec(&batch).unwrap(), original);

    let raw_only = BridgeBatch::new(vec![raw]);
    let fallback = committed_ack_response(&request, payload.clone(), &raw_only);
    assert_eq!(fallback.payload["ok"], false);
    assert_eq!(fallback.payload["committed"], true);
    assert_eq!(fallback.payload["error"]["code"], "ERR_ENGINE");
    assert_eq!(fallback.payload["inputEnabled"], true);
    assert_eq!(fallback.payload["presentationTicket"], ticket);
    let empty = BridgeBatch::new(Vec::new());
    assert_eq!(
        committed_ack_response(&request, payload.clone(), &empty).payload,
        payload
    );
}

#[test]
fn strict_wire_rejects_missing_fence_nested_override_and_unknown_envelope_fields() {
    let plain = envelope(ACK_OP, "plain", json!({}));
    assert!(parse(&serde_json::to_vec(&plain).unwrap()).is_err());
    let mut batch = json!({"preview":parse_fixture()["preview"],"messages":[plain]});
    batch["messages"][0]["preview"] = batch["preview"].clone();
    assert!(parse(&serde_json::to_vec(&batch).unwrap()).is_err());
    let mut extra = parse_fixture();
    extra["unversionedOverride"] = true.into();
    assert!(parse(&serde_json::to_vec(&extra).unwrap()).is_err());
}

#[test]
fn strict_wire_prevalidates_bounded_unique_correlation_before_owner_execution() {
    for field in ["sessionId", "requestId", "traceId", "cancelToken"] {
        let mut message = parse_fixture();
        message[field] = "x".repeat(257).into();
        assert!(
            parse(&serde_json::to_vec(&message).unwrap()).is_err(),
            "{field}"
        );
    }
    let message = envelope(ACK_OP, "duplicate", json!({}));
    let duplicate =
        json!({"preview":parse_fixture()["preview"],"messages":[message.clone(),message]});
    assert!(parse(&serde_json::to_vec(&duplicate).unwrap()).is_err());
    let full = json!({"preview":parse_fixture()["preview"],"messages":(0..MAX_MESSAGES).map(|index|
        envelope(ACK_OP,&format!("request-{index}"),json!({}))).collect::<Vec<_>>()});
    let parsed = parse(&serde_json::to_vec(&full).unwrap()).unwrap();
    let fallback = BridgeBatch::new(parsed.messages.iter().map(reply_budget_failure).collect());
    assert!(serde_json::to_vec(&fallback).unwrap().len() < MAX_FINAL_BYTES - 1024);
    let mut too_many = full;
    too_many["messages"]
        .as_array_mut()
        .unwrap()
        .push(envelope(ACK_OP, "overflow", json!({})));
    assert!(parse(&serde_json::to_vec(&too_many).unwrap()).is_err());
}

#[test]
fn strict_wire_requires_canonical_epoch_and_allowlisted_versioned_requests() {
    for epoch in ["01", "+1", "1.0", "18446744073709551616"] {
        let mut value = parse_fixture();
        value["preview"]["epoch"] = epoch.into();
        assert!(parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
    for (field, value) in [
        ("kind", "event"),
        ("protocolVersion", "2.0"),
        ("op", "api.call"),
    ] {
        let mut message = parse_fixture();
        message[field] = value.into();
        assert!(parse(&serde_json::to_vec(&message).unwrap()).is_err());
    }
}

#[test]
fn strict_factory_reserves_restart_identity_space_before_opening_pack_or_engine() {
    let config = SimulatorConfig {
        session_id: "s".repeat(MAX_BASE_SESSION_BYTES + 1),
        ..Default::default()
    };
    let result = DevRasterWebSession::bind_from_pack_dir(
        "does-not-exist",
        config,
        "127.0.0.1".parse().unwrap(),
        0,
    );
    assert!(
        matches!(result,Err(SimulatorError::Config(message)) if message.contains("restart identity budget"))
    );
}

fn exchange(surface: &mut WebSurface, method: &str, target: &str, body: &[u8]) -> Vec<u8> {
    let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
    write!(
        peer,
        "{method} {target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    peer.write_all(body).unwrap();
    peer.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut wire = Vec::new();
    loop {
        surface.poll().unwrap();
        let mut bytes = [0; 8192];
        match peer.read(&mut bytes) {
            Ok(0) => return wire,
            Ok(count) => wire.extend_from_slice(&bytes[..count]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("owned strict HTTP read failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "owned strict HTTP request did not finish"
        );
        std::thread::yield_now();
    }
}

fn post(surface: &mut WebSurface, target: &str, value: &Value) -> Vec<u8> {
    exchange(surface, "POST", target, &serde_json::to_vec(value).unwrap())
}

fn status(wire: &[u8], expected: u16) {
    assert!(
        wire.starts_with(format!("HTTP/1.1 {expected}").as_bytes()),
        "{}",
        String::from_utf8_lossy(wire)
    );
}

fn body(wire: &[u8]) -> &[u8] {
    let split = wire
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .unwrap();
    &wire[split + 4..]
}

#[test]
fn strict_surface_blocks_legacy_callbacks_raw_drains_and_old_ack_settings_routes() {
    let mut surface = WebSurface::localhost(0).unwrap();
    surface.set_bridge_handler(Box::new(|_| {
        panic!("legacy handler cannot enable strict transport")
    }));
    assert!(surface.enable_strict_raster().is_err());
    let mut surface = WebSurface::localhost(0).unwrap();
    surface.enable_strict_raster().unwrap();
    let handle = surface.handle();
    // Queue inspection cannot bypass the strict owner even for malformed raw
    // state accidentally installed by a library caller.
    handle
        .shared
        .lock()
        .unwrap()
        .bridge_requests
        .push_back(QueuedWebBridgeRequest {
            request: QueuedBridgeRequest::parse(br#"{}"#).unwrap(),
            strict: None,
        });
    assert!(handle.take_bridge_requests().is_empty());
    assert!(handle.take_fenced_bridge_requests().is_empty());
    assert_eq!(handle.shared.lock().unwrap().bridge_requests.len(), 1);
    for (method, target) in [
        ("POST", "/api/render-presented"),
        ("POST", "/api/presentation"),
        ("GET", "/api/render-frame"),
    ] {
        status(&exchange(&mut surface, method, target, b"{}"), 409);
    }
    surface.set_local_bridge_handler(Box::new(|_| {
        panic!("later handler cannot consume strict requests")
    }));
    status(&post(&mut surface, "/api/bridge", &parse_fixture()), 409);
    assert_eq!(handle.shared.lock().unwrap().bridge_requests.len(), 1);
}

#[test]
fn legacy_transport_keeps_callback_and_json_queue_behavior_without_opt_in() {
    let mut surface = WebSurface::localhost(0).unwrap();
    surface.set_local_bridge_handler(Box::new(|_| Ok(br#"{"legacy":true}"#.to_vec())));
    let wire = post(&mut surface, "/api/bridge", &json!({"legacy":"body"}));
    status(&wire, 200);
    assert_eq!(
        serde_json::from_slice::<Value>(body(&wire)).unwrap()["legacy"],
        true
    );
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
mod native {
    use super::*;
    use crate::web::{density_tests::fixture, sse_preview_tests};
    use container_core::EngineKind;
    use container_ir::{CapabilitySupport, ContainerManifestV1, Module, ModuleFormat, ModuleScope};
    use container_render_skia::{PageRenderMode, Rect};
    use std::net::{Ipv4Addr, Shutdown};

    fn engines() -> Vec<EngineKind> {
        vec![
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ]
    }

    fn fixture_pack(ready: &str, cancel: &str) -> fixture::Pack {
        let pack = fixture::new();
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&std::fs::read(pack.0.join("manifest.json")).unwrap()).unwrap();
        let ast=container_ir::parse_wxml(r#"<view id="target" bindtap="onTap" bindtouchstart="onStart" bindtouchcancel="onCancel" style="width:20px;height:10px">count{{count}}</view>"#).unwrap().canonical_json().unwrap();
        let hash = container_ir::hex_digest(&ast);
        std::fs::write(pack.0.join("blobs/sha256").join(&hash), ast).unwrap();
        manifest.templates[0].wxml_ast = format!("sha256:{hash}");
        // Manifest entry points are emitted paths; only Module.id carries the
        // module: prefix. The loader uses these paths to bind each real Page.
        manifest.app.entry_module = "app.js".into();
        manifest.routes[0].entry_module = "page.js".into();
        for name in ["wx.getStorageSync", "wx.setStorageSync"] {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Full);
        }
        manifest
            .capabilities
            .insert("wx.navigateTo".into(), CapabilitySupport::Partial);
        let source=format!("Page({{data:{{count:0}},onReady:function(){{wx.setStorageSync('ready',(wx.getStorageSync('ready')||0)+1);{ready}}},onTap:function(){{this.setData({{count:this.data.count+1}});}},onStart:function(){{wx.setStorageSync('start',true);}},onCancel:function(){{wx.setStorageSync('cancel',(wx.getStorageSync('cancel')||0)+1);{cancel}}}}});");
        for (id, scope, source) in [
            ("module:app.js", ModuleScope::App, "App({});"),
            ("module:page.js", ModuleScope::Page, source.as_str()),
        ] {
            let hash = container_ir::hex_digest(source.as_bytes());
            std::fs::write(pack.0.join("blobs/sha256").join(&hash), source).unwrap();
            manifest.modules.push(Module {
                id: id.into(),
                sha256: hash,
                format: ModuleFormat::Commonjs,
                scope,
                dependencies: Vec::new(),
            });
        }
        // A real second route lets onReady navigation invalidate a ticket in
        // the same owner turn, before a later envelope in the admitted body.
        let mut second = manifest.routes[0].clone();
        second.id = "route:pages/second/index".into();
        second.path = "pages/second/index".into();
        manifest.routes.push(second);
        let mut second_template = manifest.templates[0].clone();
        second_template.id = "template:pages/second/index.wxml".into();
        manifest.templates.push(second_template);
        manifest.refresh_integrity().unwrap();
        manifest.validate().unwrap();
        std::fs::write(
            pack.0.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        pack
    }

    fn start(path: &Path, engine: EngineKind) -> DevRasterWebSession {
        let owner = DevRasterWebSession::bind_from_pack_dir(
            path,
            SimulatorConfig {
                session_id: "strict-owner".into(),
                engine,
                page_render_mode: PageRenderMode::Raster,
                viewport: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 24.0,
                    height: 12.0,
                },
                ..Default::default()
            },
            IpAddr::V4(Ipv4Addr::LOCALHOST),
            0,
        )
        .unwrap();
        // Fail at startup if the fixture stopped executing real App/Page
        // modules; transport-only success must never mask missing hooks.
        let trace = owner.trace();
        let initialized = trace
            .iter()
            .filter(|entry| entry["request"]["op"] == op::APP_INIT)
            .flat_map(|entry| entry["response"]["messages"].as_array().unwrap())
            .find(|message| message["kind"] == "response" && message["op"] == op::APP_INIT)
            .expect("real fixture app.init response");
        assert_eq!(initialized["payload"]["ok"], true, "{initialized}");
        assert_eq!(initialized["payload"]["loadedModules"], 2);
        assert_eq!(initialized["payload"]["registration"]["app"], true);
        assert_eq!(initialized["payload"]["registration"]["pages"], 1);
        owner
    }

    struct Peer {
        socket: TcpStream,
        init: Value,
        epoch: u64,
        wire: String,
        events: Vec<(String, Value)>,
    }

    fn open(owner: &mut DevRasterWebSession, client: &str) -> Peer {
        let (socket, init) = sse_preview_tests::open(owner.surface.as_mut().unwrap(), client);
        Peer {
            socket,
            init,
            epoch: 0,
            wire: String::new(),
            events: Vec::new(),
        }
    }

    fn wait_event(
        owner: &mut DevRasterWebSession,
        peer: &mut Peer,
        kind: &str,
        mut matches: impl FnMut(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(index) = peer
                .events
                .iter()
                .position(|(event, value)| event == kind && matches(value))
            {
                return peer.events.remove(index).1;
            }
            owner.surface.as_mut().unwrap().poll().unwrap();
            let mut bytes = [0; 8192];
            match peer.socket.read(&mut bytes) {
                Ok(0) => panic!("owned SSE socket closed before final {kind}"),
                Ok(count) => peer
                    .wire
                    .push_str(std::str::from_utf8(&bytes[..count]).unwrap()),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("owned strict SSE read failed: {error}"),
            }
            while let Some(end) = peer.wire.find("\n\n") {
                let block: String = peer.wire.drain(..end + 2).collect();
                let event = block.lines().find_map(|line| line.strip_prefix("event: "));
                let data = block.lines().find_map(|line| line.strip_prefix("data: "));
                if let (Some(event), Some(data)) = (event, data) {
                    peer.events
                        .push((event.into(), serde_json::from_str(data).unwrap()));
                }
            }
            assert!(Instant::now() < deadline, "missing correlated final {kind}");
            std::thread::yield_now();
        }
    }

    fn heartbeat(peer: &Peer, request: &str) -> Value {
        json!({"version":"1.0","requestId":request,"clientId":peer.init["clientId"],
            "op":"heartbeat","epoch":peer.epoch.to_string(),"connectionToken":peer.init["connectionToken"]})
    }

    fn connect(owner: &mut DevRasterWebSession, client: &str) -> Peer {
        let mut peer = open(owner, client);
        owner.poll(0, false).unwrap();
        peer.epoch = owner.state()["preview"]["epoch"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap();
        let request = heartbeat(&peer, "bound-confirmation");
        status(
            &post(owner.surface.as_mut().unwrap(), "/api/preview", &request),
            202,
        );
        owner.poll(0, false).unwrap();
        let final_value = wait_event(owner, &mut peer, "preview", |value| {
            value["requestId"] == "bound-confirmation"
        });
        assert_eq!(final_value["ok"], true);
        peer
    }

    fn current_ticket(owner: &DevRasterWebSession) -> Value {
        serde_json::to_value(
            owner
                .simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .unwrap(),
        )
        .unwrap()
    }

    fn ack(ticket: &Value, request: &str) -> Value {
        envelope(
            ACK_OP,
            request,
            json!({"presentationTicket":ticket,"draw":{"endpoint":"canvas2d-raf-draw-return"}}),
        )
    }

    fn input(ticket: &Value, request: &str, event: &str) -> Value {
        let mut contact = json!({"type":event,"x":1,"y":1,"bubbles":true,"pointerId":7});
        if matches!(
            event,
            "touchstart" | "touchmove" | "touchend" | "touchcancel"
        ) {
            // Native capture is keyed by the normalized changed touch, not a
            // browser pointerId. A standalone tap keeps its legacy hit path.
            let touch = json!({"identifier":7,"clientX":1,"clientY":1,"pageX":1,"pageY":1});
            contact["touches"] = if matches!(event, "touchstart" | "touchmove") {
                json!([touch])
            } else {
                json!([])
            };
            contact["changedTouches"] = json!([touch]);
        }
        envelope(
            op::EVENT_BATCH,
            request,
            json!({"presentationTicket":ticket,"logicalViewport":{"width":24,"height":12},
            "events":[contact]}),
        )
    }

    fn submit(owner: &mut DevRasterWebSession, peer: &Peer, message: Value) {
        status(
            &post(
                owner.surface.as_mut().unwrap(),
                "/api/bridge",
                &fenced(message, &peer.init, peer.epoch),
            ),
            202,
        );
    }

    fn final_response(owner: &mut DevRasterWebSession, peer: &mut Peer, request: &str) -> Value {
        let batch = wait_event(owner, peer, "bridge", |value| {
            value["messages"].as_array().is_some_and(|messages| {
                messages
                    .iter()
                    .any(|message| message["requestId"] == request && message["kind"] == "response")
            })
        });
        batch["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["requestId"] == request && message["kind"] == "response")
            .unwrap()
            .clone()
    }

    fn storage(owner: &DevRasterWebSession, key: &str) -> Option<Value> {
        owner
            .simulator
            .host()
            .session()
            .unwrap()
            .app_service()
            .storage()
            .get(key)
            .cloned()
    }

    #[test]
    fn actual_sse_heartbeat_proves_commit_and_mirrors_never_acquire_input_implicitly() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut first = open(&mut owner, "owner");
            assert!(first.init.get("epoch").is_none());
            assert_eq!(first.init["committed"], false);
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/preview",
                    &heartbeat(&first, "too-early"),
                ),
                409,
            );
            owner.poll(0, false).unwrap();
            first.epoch = owner.state()["preview"]["epoch"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/preview",
                    &heartbeat(&first, "confirmed"),
                ),
                202,
            );
            owner.poll(0, false).unwrap();
            assert_eq!(
                wait_event(&mut owner, &mut first, "preview", |value| value
                    ["requestId"]
                    == "confirmed")["ok"],
                true
            );
            let mirror = connect(&mut owner, "mirror");
            let ticket = current_ticket(&owner);
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/bridge",
                    &fenced(ack(&ticket, "mirror-ack"), &mirror.init, mirror.epoch),
                ),
                409,
            );
            assert_eq!(owner.state()["preview"]["ownerClientId"], "owner");
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn actual_frame_v2_http_and_queued_ack_do_not_release_ready_until_final_runtime_turn() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let wire = exchange(owner.surface.as_mut().unwrap(), "GET", "/api/frame", &[]);
            status(&wire, 200);
            assert!(
                String::from_utf8_lossy(&wire[..wire.len() - body(&wire).len()])
                    .contains("application/vnd.weapp.frame.v2")
            );
            let bytes = body(&wire);
            let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
            let metadata: Value = serde_json::from_slice(&bytes[4..4 + length]).unwrap();
            let ticket = current_ticket(&owner);
            assert_eq!(metadata["presentationTicket"], ticket);
            assert_eq!(metadata["schemaVersion"], 2);
            assert_eq!(metadata["width"], 24);
            assert_eq!(bytes.len() - 4 - length, 24 * 12 * 4);
            assert_eq!(storage(&owner, "ready"), None);
            submit(&mut owner, &peer, ack(&ticket, "first-ack"));
            assert_eq!(storage(&owner, "ready"), None, "HTTP202 is only admission");
            assert!(!owner
                .simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            owner.poll(0, false).unwrap();
            let reply = final_response(&mut owner, &mut peer, "first-ack");
            assert_eq!(reply["sessionId"], "strict-owner");
            assert_eq!(reply["op"], ACK_OP);
            assert_eq!(reply["payload"]["ok"], true);
            assert_eq!(reply["payload"]["presentationTicket"], ticket);
            assert_eq!(reply["payload"]["inputEnabled"], true);
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            submit(&mut owner, &peer, ack(&ticket, "duplicate-ack"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "duplicate-ack")["payload"]["ok"],
                true
            );
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn exact_ack_then_coordinate_input_invokes_real_wxml_handler_and_publishes_new_ticket() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, input(&ticket, "before-ack", "tap"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "before-ack")["payload"]["error"]["code"],
                "ERR_CANCELLED"
            );
            submit(&mut owner, &peer, ack(&ticket, "ack"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "ack")["payload"]["inputEnabled"],
                true
            );
            submit(&mut owner, &peer, input(&ticket, "tap", "tap"));
            owner.poll(0, true).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "tap")["payload"]["ok"],
                true
            );
            assert_eq!(
                owner
                    .simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .data["count"],
                1
            );
            assert_ne!(current_ticket(&owner), ticket);
            assert!(!owner
                .simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn changed_viewport_stale_ticket_session_and_generation_fail_correlated_closed() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "ack"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "ack");
            let mut wrong_view = input(&ticket, "viewport", "tap");
            wrong_view["payload"]["logicalViewport"]["width"] = 25.into();
            submit(&mut owner, &peer, wrong_view);
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "viewport")["payload"]["error"]["code"],
                "ERR_CANCELLED"
            );
            for (index, field) in ["frameId", "configGeneration"].iter().enumerate() {
                let mut stale = ticket.clone();
                stale["target"][*field] = "999".into();
                let request = format!("stale-{index}");
                submit(&mut owner, &peer, ack(&stale, &request));
                owner.poll(0, false).unwrap();
                assert_eq!(
                    final_response(&mut owner, &mut peer, &request)["payload"]["ok"],
                    false
                );
            }
            let mut other_session = ack(&ticket, "other-session");
            other_session["sessionId"] = "other-session".into();
            submit(&mut owner, &peer, other_session);
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "other-session")["payload"]["error"]["code"],
                "ERR_CANCELLED"
            );
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn actual_eof_after_admission_revokes_request_before_original_owner_executes_it() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "closed-after-queued"));
            peer.socket.shutdown(Shutdown::Both).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !owner.surface.as_ref().unwrap().clients.is_empty() {
                owner.surface.as_mut().unwrap().poll().unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            owner.poll(0, false).unwrap();
            assert_eq!(storage(&owner, "ready"), None);
            assert!(owner
                .simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .is_none());
            let shared = owner.handle.shared.lock().unwrap();
            assert!(shared.events.iter().any(|event| event.kind == "bridge"
                && String::from_utf8_lossy(&event.wire).contains("closed-after-queued")));
            drop(shared);
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn reconnect_retires_admitted_old_binding_and_old_eof_cannot_revoke_new_exact_ack() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let old = connect(&mut owner, "owner");
            let old_ticket = current_ticket(&owner);
            submit(&mut owner, &old, ack(&old_ticket, "old-pending"));
            let mut successor = connect(&mut owner, "owner");
            assert_ne!(
                old.init["connectionToken"],
                successor.init["connectionToken"]
            );
            assert!(successor.epoch > old.epoch);
            assert_eq!(storage(&owner, "ready"), None);
            let new_ticket = current_ticket(&owner);
            submit(&mut owner, &successor, ack(&new_ticket, "new-ack"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut successor, "new-ack")["payload"]["inputEnabled"],
                true
            );
            old.socket.shutdown(Shutdown::Both).unwrap();
            owner.poll(0, false).unwrap();
            assert!(owner
                .simulator
                .host()
                .session()
                .unwrap()
                .is_current_frame_presented());
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/bridge",
                    &fenced(ack(&new_ticket, "old-token"), &old.init, successor.epoch),
                ),
                409,
            );
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn same_body_ack_navigation_revalidates_each_later_input_and_reports_disabled_basis() {
        let pack=fixture_pack("if(!this.data.moved){this.data.moved=true;wx.navigateTo({url:'/pages/second/index'});}","");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            let body =
                json!({"messages":[ack(&ticket,"nav-ack"),input(&ticket,"after-nav","tap")]});
            submit(&mut owner, &peer, body);
            owner.poll(0, false).unwrap();
            let batch = wait_event(&mut owner, &mut peer, "bridge", |value| {
                value["messages"].as_array().is_some_and(|messages| {
                    messages
                        .iter()
                        .any(|message| message["requestId"] == "nav-ack")
                })
            });
            let messages = batch["messages"].as_array().unwrap();
            let ack = messages
                .iter()
                .find(|message| message["requestId"] == "nav-ack")
                .unwrap();
            assert_eq!(ack["payload"]["ok"], true);
            assert_eq!(ack["payload"]["presentationTicket"], ticket);
            assert_eq!(ack["payload"]["inputEnabled"], false);
            let input = messages
                .iter()
                .find(|message| message["requestId"] == "after-nav")
                .unwrap();
            assert_eq!(input["payload"]["error"]["code"], "ERR_CANCELLED");
            assert_eq!(
                owner
                    .simulator
                    .host()
                    .session()
                    .unwrap()
                    .app_service()
                    .pages()
                    .current()
                    .unwrap()
                    .path,
                "pages/second/index"
            );
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn typed_ack_failure_produces_correlated_final_error_instead_of_timeout() {
        let pack = fixture_pack("throw new Error('ready-failed');", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "throwing-ready"));
            let _pump = owner.poll(0, false);
            let response = final_response(&mut owner, &mut peer, "throwing-ready");
            assert_eq!(response["sessionId"], "strict-owner");
            assert_eq!(response["op"], ACK_OP);
            assert_eq!(response["payload"]["ok"], false);
            assert_eq!(response["payload"]["committed"], true);
            assert_eq!(response["payload"]["presentationTicket"], ticket);
            assert_eq!(response["payload"]["error"]["request_id"], "throwing-ready");
            assert!(response["payload"]["error"]["code"]
                .as_str()
                .unwrap()
                .starts_with("ERR_"));
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            submit(
                &mut owner,
                &peer,
                ack(&ticket, "duplicate-after-ready-error"),
            );
            owner.poll(0, false).unwrap();
            let duplicate = final_response(&mut owner, &mut peer, "duplicate-after-ready-error");
            assert_eq!(duplicate["payload"]["ok"], true);
            assert_eq!(duplicate["payload"]["presentationTicket"], ticket);
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            assert!(owner
                .trace()
                .iter()
                .any(|entry| entry.to_string().contains("throwing-ready")));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn strict_queue_uses_original_capacity_and_bounded_turn_without_raw_drain_escape() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            for index in 0..MAX_BRIDGE_REQUESTS {
                submit(&mut owner, &peer, ack(&ticket, &format!("queued-{index}")));
            }
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/bridge",
                    &fenced(ack(&ticket, "overflow"), &peer.init, peer.epoch),
                ),
                503,
            );
            assert!(owner.handle.take_bridge_requests().is_empty());
            assert!(owner.handle.take_fenced_bridge_requests().is_empty());
            assert_eq!(owner.poll(0, false).unwrap(), REQUESTS_PER_TURN);
            assert_eq!(
                owner.handle.shared.lock().unwrap().bridge_requests.len(),
                MAX_BRIDGE_REQUESTS - REQUESTS_PER_TURN
            );
            owner.shutdown().unwrap();
            assert!(owner
                .handle
                .shared
                .lock()
                .unwrap()
                .bridge_requests
                .is_empty());
        }
    }

    #[test]
    fn oversized_final_keeps_request_correlation_and_original_runtime_effect_trace() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let request = BridgeEnvelope::request("strict-owner", "large-final", ACK_OP, json!({}));
            let batch = BridgeBatch::new(vec![response(
                &request,
                json!({"ok":true,"large":"x".repeat(MAX_FINAL_BYTES)}),
            )]);
            owner.simulator.trace.push(&request, &batch);
            owner
                .publish_final(batch, std::slice::from_ref(&request))
                .unwrap();
            let reply = final_response(&mut owner, &mut peer, "large-final");
            assert_eq!(reply["payload"]["error"]["code"], "ERR_RENDER");
            assert_eq!(reply["payload"]["operationMayHaveCommitted"], true);
            assert!(owner
                .trace()
                .iter()
                .any(|entry| entry.to_string().contains("large-final")));
            assert!(!owner
                .handle
                .shared
                .lock()
                .unwrap()
                .events
                .iter()
                .any(|event| String::from_utf8_lossy(&event.wire)
                    .contains("ERR_DEV_EVENT_TOO_LARGE")));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn shutdown_closes_real_listener_retires_contact_and_returns_cancellation_effects() {
        let pack = fixture_pack("", "this.setData({count:99});");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "ack"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "ack");
            submit(&mut owner, &peer, input(&ticket, "touch", "touchstart"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "touch");
            assert_eq!(storage(&owner, "start"), Some(json!(true)));
            let address = owner.surface.as_ref().unwrap().local_addr();
            let effects = owner.shutdown().unwrap();
            assert_eq!(storage(&owner, "cancel"), Some(json!(1)));
            assert!(!effects.messages.is_empty());
            assert!(TcpStream::connect(address).is_err());
            assert!(owner
                .simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .is_none());
            assert!(owner.shutdown().unwrap().messages.is_empty());
        }
    }

    #[test]
    fn failed_shutdown_releases_port_preserves_original_diagnostics_and_can_retry() {
        let pack = fixture_pack("", "throw new Error('cancel-failed');");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "ack"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "ack");
            submit(&mut owner, &peer, input(&ticket, "touch", "touchstart"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "touch");
            let address = owner.surface.as_ref().unwrap().local_addr();
            let result = owner.shutdown();
            assert!(
                result.is_err(),
                "a throwing original cancellation must not be reported as a successful retirement"
            );
            assert!(TcpStream::connect(address).is_err());
            assert_eq!(owner.state()["status"], "error");
            assert!(owner
                .drain_diagnostics()
                .unwrap()
                .messages
                .iter()
                .any(|message| serde_json::to_string(message)
                    .unwrap()
                    .contains("cancel-failed")));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn constructor_error_after_binding_releases_only_its_owned_port() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let address = listener.local_addr().unwrap();
            drop(listener);
            // The explicit constructor binds before run(), then rejects the
            // invalid launch shape. No server thread can outlive the error.
            let config = SimulatorConfig {
                session_id: "strict-owner".into(),
                engine,
                page_render_mode: PageRenderMode::Raster,
                launch_options: Value::Null,
                ..Default::default()
            };
            assert!(DevRasterWebSession::bind_from_pack_dir(
                &pack.0,
                config,
                IpAddr::V4(Ipv4Addr::LOCALHOST),
                address.port()
            )
            .is_err());
            let recovered = TcpListener::bind(address).unwrap();
            drop(recovered);
        }
    }

    #[test]
    fn actual_http_missing_guessed_and_stale_fences_never_reach_original_runtime() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/bridge",
                    &ack(&ticket, "missing"),
                ),
                409,
            );
            let mut guessed = fenced(ack(&ticket, "guessed"), &peer.init, peer.epoch);
            guessed["preview"]["connectionToken"] = "guessed-token".into();
            status(
                &post(owner.surface.as_mut().unwrap(), "/api/bridge", &guessed),
                409,
            );
            status(
                &post(
                    owner.surface.as_mut().unwrap(),
                    "/api/bridge",
                    &fenced(ack(&ticket, "old-epoch"), &peer.init, peer.epoch - 1),
                ),
                409,
            );
            assert!(owner
                .handle
                .shared
                .lock()
                .unwrap()
                .bridge_requests
                .is_empty());
            assert_eq!(storage(&owner, "ready"), None);
            owner.shutdown().unwrap();
        }
    }

    fn write_manifest(pack: &fixture::Pack, manifest: &mut ContainerManifestV1) {
        manifest.refresh_integrity().unwrap();
        std::fs::write(
            pack.0.join("manifest.json"),
            serde_json::to_vec(manifest).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn in_place_reload_retains_original_state_and_publishes_reload_effects_without_replaying_ready()
    {
        let pack = fixture_pack("", "");
        let updated = fixture_pack("", "");
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&std::fs::read(updated.0.join("manifest.json")).unwrap())
                .unwrap();
        let ast=container_ir::parse_wxml(r#"<view id="target" bindtap="onTap" style="width:20px;height:10px">updated{{count}}</view>"#).unwrap().canonical_json().unwrap();
        let hash = container_ir::hex_digest(&ast);
        std::fs::write(updated.0.join("blobs/sha256").join(&hash), ast).unwrap();
        manifest.templates[0].wxml_ast = format!("sha256:{hash}");
        write_manifest(&updated, &mut manifest);
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "ack"));
            owner.poll(0, false).unwrap();
            final_response(&mut owner, &mut peer, "ack");
            let sid = owner.simulator.session_id().to_owned();
            assert_eq!(
                owner.apply_dev_pack(&updated.0).unwrap(),
                crate::DevReloadKind::InPlace
            );
            assert_eq!(owner.simulator.session_id(), sid);
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            assert_ne!(current_ticket(&owner), ticket);
            let reload = wait_event(&mut owner, &mut peer, "reload", |value| {
                value["kind"] == "inPlace"
            });
            assert_eq!(reload["report"]["sessionId"], sid);
            let next = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&next, "reloaded-ack"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "reloaded-ack")["payload"]["ok"],
                true
            );
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn restart_reload_changes_session_preserves_strict_policy_and_rejects_queued_old_ticket() {
        let pack = fixture_pack("", "");
        let updated = fixture_pack("", "");
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&std::fs::read(updated.0.join("manifest.json")).unwrap())
                .unwrap();
        let module = manifest
            .modules
            .iter_mut()
            .find(|module| module.id == "module:app.js")
            .unwrap();
        let source = "App({changed:true});";
        module.sha256 = container_ir::hex_digest(source.as_bytes());
        std::fs::write(updated.0.join("blobs/sha256").join(&module.sha256), source).unwrap();
        write_manifest(&updated, &mut manifest);
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            submit(&mut owner, &peer, ack(&ticket, "old-queued"));
            assert_eq!(
                owner.apply_dev_pack(&updated.0).unwrap(),
                crate::DevReloadKind::Restart
            );
            assert_ne!(owner.simulator.session_id(), "strict-owner");
            assert_eq!(
                owner
                    .simulator
                    .host()
                    .session()
                    .unwrap()
                    .raster_presentation_policy(),
                container_runtime::RasterPresentationPolicy::ExplicitDev
            );
            assert_eq!(storage(&owner, "ready"), None);
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "old-queued")["payload"]["error"]["code"],
                "ERR_CANCELLED"
            );
            let next = current_ticket(&owner);
            let mut next_ack = ack(&next, "new-session-ack");
            next_ack["sessionId"] = owner.simulator.session_id().into();
            submit(&mut owner, &peer, next_ack);
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "new-session-ack")["payload"]["inputEnabled"],
                true
            );
            assert_eq!(storage(&owner, "ready"), Some(json!(1)));
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn invalid_reload_keeps_original_ticket_pack_and_http_bridge_usable() {
        let pack = fixture_pack("", "");
        let invalid = fixture_pack("", "");
        let manifest: ContainerManifestV1 =
            serde_json::from_slice(&std::fs::read(invalid.0.join("manifest.json")).unwrap())
                .unwrap();
        let hash = manifest.templates[0]
            .wxml_ast
            .strip_prefix("sha256:")
            .unwrap();
        std::fs::remove_file(invalid.0.join("blobs/sha256").join(hash)).unwrap();
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let mut peer = connect(&mut owner, "owner");
            let ticket = current_ticket(&owner);
            assert!(owner.apply_dev_pack(&invalid.0).is_err());
            assert_eq!(current_ticket(&owner), ticket);
            submit(&mut owner, &peer, ack(&ticket, "surviving-ack"));
            owner.poll(0, false).unwrap();
            assert_eq!(
                final_response(&mut owner, &mut peer, "surviving-ack")["payload"]["inputEnabled"],
                true
            );
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn expired_actual_owner_between_control_turn_and_publication_is_pending_not_service_failure() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let _peer = connect(&mut owner, "owner");
            {
                let mut shared = owner.handle.shared.lock().unwrap();
                shared.preview.clients.get_mut("owner").unwrap().last_seen =
                    Instant::now() - crate::web::preview::PREVIEW_LEASE - Duration::from_millis(1);
            }
            assert!(
                !owner.publish_frame().unwrap(),
                "expiry at publication is normal missing owner work"
            );
            assert!(owner.surface.is_some());
            owner.poll(0, false).unwrap();
            assert!(owner.state()["preview"]["ownerClientId"].is_null());
            assert!(owner
                .simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .is_none());
            status(
                &exchange(owner.surface.as_mut().unwrap(), "GET", "/api/state", &[]),
                200,
            );
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn actual_eof_before_publication_does_not_exit_owner_and_next_poll_retires_original_lease() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let peer = connect(&mut owner, "owner");
            peer.socket.shutdown(Shutdown::Both).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while !owner.surface.as_ref().unwrap().clients.is_empty() {
                owner.surface.as_mut().unwrap().poll().unwrap();
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            assert!(
                !owner.publish_frame().unwrap(),
                "actual EOF at publication is normal pending retirement"
            );
            assert!(owner.surface.is_some());
            owner.poll(0, false).unwrap();
            assert!(owner.state()["preview"]["ownerClientId"].is_null());
            assert!(owner
                .simulator
                .host()
                .session()
                .unwrap()
                .current_dev_raster_presentation_ticket()
                .is_none());
            status(
                &exchange(owner.surface.as_mut().unwrap(), "GET", "/api/state", &[]),
                200,
            );
            owner.shutdown().unwrap();
        }
    }

    #[test]
    fn genuine_publication_budget_failure_remains_an_error_with_a_live_exact_owner() {
        let pack = fixture_pack("", "");
        for engine in engines() {
            let mut owner = start(&pack.0, engine);
            let _peer = connect(&mut owner, "owner");
            let mut presentation = owner.handle.presentation();
            presentation["generation"] = 2.into();
            owner.handle.set_presentation(presentation);
            owner.handle.shared.lock().unwrap().publication_epoch = None;
            let error = owner.publish_frame().unwrap_err();
            assert!(error.starts_with("ERR_RENDER:"), "{error}");
            assert!(error.contains("exhaust"), "{error}");
            owner.shutdown().unwrap();
        }
    }
}

#[test]
fn strict_sse_rejects_non_raster_ids_before_owner_admission_and_preserves_legacy_grammar() {
    let mut surface = WebSurface::localhost(0).unwrap();
    surface.enable_strict_raster().unwrap();
    let handle = surface.handle();
    for client in ["with.dot", "with:colon", ""] {
        let wire = exchange(
            &mut surface,
            "GET",
            &format!("/api/events?clientId={client}&since=0"),
            &[],
        );
        status(&wire, 400);
        assert_eq!(
            serde_json::from_slice::<Value>(body(&wire)).unwrap()["error"]["code"],
            "ERR_PROTOCOL_VERSION"
        );
        let shared = handle.shared.lock().unwrap();
        assert!(shared.preview.owner.is_none());
        assert!(shared.preview.clients.is_empty());
        assert!(shared.preview.requests.is_empty());
        assert_eq!(shared.preview.reserved_retirements, 0);
    }
    assert!(surface.clients.is_empty());
    let (peer, _) = crate::web::sse_preview_tests::open(&mut surface, "raster-owner_1");
    handle.resolve_preview_controls(|_| Ok(())).unwrap();
    assert_eq!(handle.state()["preview"]["ownerClientId"], "raster-owner_1");
    drop(peer);
    surface.close_event_streams();
    handle.resolve_preview_controls(|_| Ok(())).unwrap();
    let (mut legacy, legacy_handle) = crate::web::sse_preview_tests::setup();
    let (legacy_peer, _) = crate::web::sse_preview_tests::open(&mut legacy, "legacy.name:1");
    legacy_handle.resolve_preview_controls(|_| Ok(())).unwrap();
    assert_eq!(
        legacy_handle
            .shared
            .lock()
            .unwrap()
            .preview
            .owner
            .as_deref(),
        Some("legacy.name:1")
    );
    drop(legacy_peer);
    legacy.close_event_streams();
    legacy_handle.resolve_preview_controls(|_| Ok(())).unwrap();
}

#[test]
fn strict_http_error_classifier_keeps_stable_err_codes_for_untyped_transport_failures() {
    assert_eq!(error_code("Web surface unavailable"), "ERR_ENGINE");
    assert_eq!(error_code(""), "ERR_ENGINE");
    assert_eq!(
        error_code("ERR_CANCELLED: actual owner retired"),
        "ERR_CANCELLED"
    );
    assert_eq!(
        error_code("ERR_PROTOCOL_VERSION: invalid clientId"),
        "ERR_PROTOCOL_VERSION"
    );
}
