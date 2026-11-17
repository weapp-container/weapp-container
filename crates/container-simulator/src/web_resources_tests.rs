//! Resource transport/parser tests only. They do not fabricate an artifact
//! borrower or claim real compiler/stage/Worker/presenter evidence. The actual
//! typed-borrower TCP gate belongs with the existing live-stage fixture.
use super::*;
use crate::browser_dev_coordinator::WireU64;
use std::net::Shutdown;
use std::thread;

fn resource_surface() -> WebSurface {
    WebSurface::bind_resource_only(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0).unwrap()
}

fn site_path() -> &'static str {
    "/__weapp/site/run-1/1/site.json"
}

fn wire(path: &str, extra_headers: &str) -> Vec<u8> {
    format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n{extra_headers}\r\n").into_bytes()
}

fn parse(path: &str, extra_headers: &str) -> Result<WebResourceTarget, ResourceRequestError> {
    let request = wire(path, extra_headers);
    resources::parse_request(&request[..request.len() - 4], 0)
}

fn client(surface: &WebSurface, request: &[u8]) -> TcpStream {
    let mut client = TcpStream::connect(surface.local_addr()).unwrap();
    client.write_all(request).unwrap();
    client.set_nonblocking(true).unwrap();
    client
}

fn pump_owner_queue(surface: &mut WebSurface, expected: usize) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        surface.poll().unwrap();
        if surface.pending_resource_requests.len() == expected
            && surface.pending_requests.is_empty()
        {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owner queue did not reach {expected}; resources={}, partial={}",
            surface.pending_resource_requests.len(),
            surface.pending_requests.len(),
        );
        thread::yield_now();
    }
}

fn receive(surface: &mut WebSurface, client: &mut TcpStream) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    loop {
        surface.poll().unwrap();
        let mut chunk = [0_u8; 4096];
        match client.read(&mut chunk) {
            Ok(0) => return bytes,
            Ok(length) => bytes.extend_from_slice(&chunk[..length]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("resource response failed: {error}"),
        }
        assert!(Instant::now() < deadline, "resource response did not close");
        thread::yield_now();
    }
}

#[test]
fn canonical_resource_targets_preserve_wire_identity() {
    let bundle = "a".repeat(64);
    assert_eq!(
        parse(
            &format!("/__weapp/runtime/{bundle}/runtime/runtime.mjs"),
            ""
        )
        .unwrap(),
        WebResourceTarget::Runtime {
            bundle_sha256: bundle,
            path: "runtime/runtime.mjs".into(),
        }
    );
    assert_eq!(
        parse(
            site_path(),
            "Accept: application/json\r\nCache-Control: no-cache\r\n"
        )
        .unwrap(),
        WebResourceTarget::Site {
            run_id: "run-1".into(),
            site_id: WireU64::new(1),
        }
    );
    for path in [
        "pack-index.json".to_owned(),
        "worker-product-config.json".to_owned(),
        "portable-pack/manifest.json".to_owned(),
        format!("portable-pack/blobs/sha256/{}", "b".repeat(64)),
    ] {
        assert_eq!(
            parse(
                &format!("/__weapp/pack/run-1/18446744073709551615/{path}"),
                "Content-Length: 0\r\n"
            )
            .unwrap(),
            WebResourceTarget::Pack {
                run_id: "run-1".into(),
                site_id: WireU64::new(u64::MAX),
                path,
            }
        );
    }
}

#[test]
fn noncanonical_targets_and_namespace_aliases_are_rejected() {
    let hash = "a".repeat(64);
    let invalid = [
        site_path().to_owned() + "?x=1",
        site_path().to_owned() + "#fragment",
        "/__weapp/site/run-1/1/%73ite.json".into(),
        "/__weapp/site/run-1/1/site%2ejson".into(),
        "/__weapp/site/run-1/1/../site.json".into(),
        "/__weapp/site/run-1/1/./site.json".into(),
        "/__weapp/site/run-1//1/site.json".into(),
        "/__weapp/site/run-1/1\\site.json".into(),
        "/__weapp/site/_run/1/site.json".into(),
        "/__weapp/site/run-1/0/site.json".into(),
        "/__weapp/site/run-1/01/site.json".into(),
        "/__weapp/site/run-1/+1/site.json".into(),
        "/__weapp/site/run-1/18446744073709551616/site.json".into(),
        "/__weapp/site/run-1/1/pack-index.json".into(),
        "/__weapp/pack/run-1/1/site.json".into(),
        "/__weapp/pack/run-1/1/worker-product-config.mjs".into(),
        "/__weapp/pack/run-1/1/source/app.js".into(),
        "/__weapp/pack/run-1/1/build-report.json".into(),
        "/__weapp/pack/run-1/1/runtime-bundle.json".into(),
        format!(
            "/__weapp/pack/run-1/1/portable-pack/blobs/sha256/{}",
            "A".repeat(64)
        ),
        format!("/__weapp/runtime/{}/runtime.mjs", "A".repeat(64)),
        format!("/__weapp/runtime/{hash}/../../source.mjs"),
        format!("/__weapp/runtime/{hash}/{}", "a".repeat(2049)),
        "http://localhost/__weapp/site/run-1/1/site.json".into(),
        "//localhost/__weapp/site/run-1/1/site.json".into(),
        "/__weapp/site/run-1/1/中文.json".into(),
        "/__weapp/site/run-1/1/site\t.json".into(),
    ];
    for path in invalid {
        assert!(
            parse(&path, "").is_err(),
            "accepted noncanonical target: {path:?}"
        );
    }
}

#[test]
fn strict_get_framing_rejects_ambiguous_lengths_and_transfer_encoding() {
    for headers in [
        "Content-Length: 1\r\n",
        "Content-Length: -1\r\n",
        "Content-Length: +0\r\n",
        "Content-Length: 00\r\n",
        "Content-Length: 0,0\r\n",
        "Content-Length: invalid\r\n",
        "Content-Length: 18446744073709551616\r\n",
        "Content-Length: 0\r\nContent-Length: 0\r\n",
        "Content-Length: 0\r\ncOnTeNt-LeNgTh: 0\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Transfer-Encoding:\r\n",
        "Content-Length: 0\r\nTransfer-Encoding: identity\r\n",
        "Expect: 100-continue\r\n",
        "Upgrade: websocket\r\n",
        "Host: second.example\r\n",
        " Content-Length: 0\r\n",
        "Bad Name: value\r\n",
        "No-Colon\r\n",
        "X-Test: bad\nvalue\r\n",
    ] {
        assert!(
            parse(site_path(), headers).is_err(),
            "accepted framing: {headers:?}"
        );
    }
    let valid = wire(site_path(), "Content-Length: 0\r\n");
    for length in [1, 16, valid.len()] {
        assert!(resources::parse_request(&valid[..valid.len() - 4], length).is_err());
    }
    for first in [
        format!("POST {} HTTP/1.1", site_path()),
        format!("OPTIONS {} HTTP/1.1", site_path()),
        format!("HEAD {} HTTP/1.1", site_path()),
        format!("GET {} HTTP/1.0", site_path()),
        format!("GET {} HTTP/1.1 ignored", site_path()),
        format!("GET  {} HTTP/1.1", site_path()),
    ] {
        let header = format!("{first}\r\nHost: localhost");
        assert!(resources::parse_request(header.as_bytes(), 0).is_err());
    }
    let missing_host = format!("GET {} HTTP/1.1", site_path());
    assert!(resources::parse_request(missing_host.as_bytes(), 0).is_err());
}

#[test]
fn resource_requests_wait_for_same_lane_owner_resolution() {
    let mut surface = resource_surface();
    let mut peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    assert!(surface.pending_requests.is_empty());
    assert_eq!(surface.pending_resource_requests.len(), 1);
    assert!(surface.pending_responses.is_empty());
    let accepted = surface.pending_resource_requests[0].accepted_at;
    let mut calls = 0;
    assert_eq!(
        surface
            .resolve_resource_requests(|target| {
                calls += 1;
                assert_eq!(
                    target,
                    &WebResourceTarget::Site {
                        run_id: "run-1".into(),
                        site_id: WireU64::new(1),
                    }
                );
                WebResourceResolution::NotFound
            })
            .unwrap(),
        1
    );
    assert_eq!(calls, 1);
    assert!(surface.pending_resource_requests.is_empty());
    assert_eq!(surface.pending_responses.len(), 1);
    assert_eq!(surface.pending_responses[0].queued_at, accepted);
    let bytes = receive(&mut surface, &mut peer);
    assert!(bytes.starts_with(b"HTTP/1.1 404 Not Found\r\n"));
    assert!(!String::from_utf8_lossy(&bytes).contains("Access-Control-Allow-Origin"));
    assert!(surface.pending_responses.is_empty());
}

#[test]
fn opt_in_mode_exposes_no_legacy_ui_bridge_or_sse() {
    for path in [
        "/",
        "/api/state",
        "/api/bridge",
        "/api/events",
        "/api/frame",
        "/api/snapshot",
    ] {
        let mut surface = resource_surface();
        let mut peer = client(&surface, &wire(path, ""));
        let bytes = receive(&mut surface, &mut peer);
        assert!(!bytes.starts_with(b"HTTP/1.1 200"));
        assert!(surface.pending_resource_requests.is_empty());
        assert!(surface.clients.is_empty());
        let mut calls = 0;
        surface
            .resolve_resource_requests(|_| {
                calls += 1;
                WebResourceResolution::NotFound
            })
            .unwrap();
        assert_eq!(calls, 0);
        assert!(!String::from_utf8_lossy(&bytes).contains("Access-Control-Allow-Origin"));
    }
    let mut legacy = WebSurface::localhost(0).unwrap();
    let mut peer = client(&legacy, &wire(site_path(), ""));
    let bytes = receive(&mut legacy, &mut peer);
    assert!(bytes.starts_with(b"HTTP/1.1 404 Not Found"));
    assert!(legacy.pending_resource_requests.is_empty());
}

#[test]
fn invalid_received_framing_never_reaches_owner_lookup() {
    let requests = [
        wire(site_path(), "Content-Length: invalid\r\n"),
        wire(site_path(), "Content-Length: 0\r\nContent-Length: 0\r\n"),
        wire(site_path(), "Transfer-Encoding: chunked\r\n"),
        wire(&(site_path().to_owned() + "?cache=1"), ""),
    ];
    for request in requests {
        let mut surface = resource_surface();
        let mut peer = client(&surface, &request);
        let response = receive(&mut surface, &mut peer);
        assert!(response.starts_with(b"HTTP/1.1 400 Bad Request"));
        assert!(surface.pending_resource_requests.is_empty());
        let mut calls = 0;
        surface
            .resolve_resource_requests(|_| {
                calls += 1;
                WebResourceResolution::NotFound
            })
            .unwrap();
        assert_eq!(calls, 0);
    }
}

#[test]
fn owner_queue_counts_toward_original_connection_capacity() {
    let mut surface = resource_surface();
    let mut peers = Vec::new();
    for _ in 0..MAX_HTTP_CONNECTIONS {
        peers.push(client(&surface, &wire(site_path(), "")));
    }
    pump_owner_queue(&mut surface, MAX_HTTP_CONNECTIONS);
    assert_eq!(
        surface.pending_resource_requests.len(),
        MAX_HTTP_CONNECTIONS
    );
    assert!(surface.pending_requests.is_empty());
    assert!(surface.pending_responses.is_empty());
    let mut excess = client(&surface, &wire(site_path(), ""));
    surface.poll().unwrap();
    // A closed unread request may surface as EOF or reset, depending on OS.
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        match excess.read(&mut [0_u8; 1]) {
            Ok(0) => break,
            Err(error) if is_client_disconnect(&error) => break,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            result => panic!("unexpected excess connection result: {result:?}"),
        }
        assert!(
            Instant::now() < deadline,
            "excess resource connection remained open"
        );
        surface.poll().unwrap();
        thread::yield_now();
    }
    assert_eq!(
        surface.pending_resource_requests.len(),
        MAX_HTTP_CONNECTIONS
    );
    surface.pending_resource_requests[0].accepted_at = Instant::now() - HTTP_DEADLINE;
    surface.poll().unwrap();
    assert_eq!(
        surface.pending_resource_requests.len(),
        MAX_HTTP_CONNECTIONS - 1
    );
    let _replacement = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, MAX_HTTP_CONNECTIONS);
    assert_eq!(
        surface.pending_resource_requests.len(),
        MAX_HTTP_CONNECTIONS
    );
    drop(peers);
}

#[test]
fn expired_owner_requests_do_not_lookup_or_refresh_their_deadline() {
    let mut surface = resource_surface();
    let _peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    surface.pending_resource_requests[0].accepted_at = Instant::now() - HTTP_DEADLINE;
    let mut calls = 0;
    assert_eq!(
        surface
            .resolve_resource_requests(|_| {
                calls += 1;
                WebResourceResolution::NotFound
            })
            .unwrap(),
        0
    );
    assert_eq!(calls, 0);
    assert!(surface.pending_resource_requests.is_empty());
    assert!(surface.pending_responses.is_empty());
    let _peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    let accepted = surface.pending_resource_requests[0].accepted_at;
    surface
        .resolve_resource_requests(|_| WebResourceResolution::Denied)
        .unwrap();
    assert_eq!(surface.pending_responses[0].queued_at, accepted);
    surface.pending_responses[0].queued_at = Instant::now() - HTTP_DEADLINE;
    surface.flush_responses();
    assert!(surface.pending_responses.is_empty());
}

#[test]
fn pending_owner_work_returns_before_network_wait() {
    let mut surface = resource_surface();
    let _peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    let start = Instant::now();
    surface.wait(Duration::from_secs(5)).unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    assert_eq!(surface.pending_resource_requests.len(), 1);
}

#[test]
fn resource_queue_sockets_are_released_with_surface_despite_live_handle() {
    let mut surface = resource_surface();
    let mut peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    let handle = surface.handle();
    assert_eq!(surface.pending_resource_requests.len(), 1);
    drop(surface);
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_eq!(peer.read(&mut [0_u8; 1]).unwrap(), 0);
    // The surviving handle owns no socket queue and cannot revive it.
    handle.set_state_json(json!({"status":"closed"}));
    let _ = peer.shutdown(Shutdown::Both);
}

#[test]
fn resource_rejections_use_original_small_response_budget() {
    let mut surface = resource_surface();
    let _peer = client(&surface, &wire(site_path(), ""));
    pump_owner_queue(&mut surface, 1);
    // Occupy the existing HTTP-byte accounting with an actual shared buffer.
    // No new artifact accounting or synthetic borrower constructor is used.
    let retained = Arc::new(vec![0_u8; MAX_RESPONSE_BYTES]);
    surface.shared.lock().unwrap().track_response(&retained);
    surface
        .resolve_resource_requests(|_| WebResourceResolution::Unavailable)
        .unwrap();
    assert!(surface.pending_resource_requests.is_empty());
    assert!(surface.pending_responses.is_empty());
    drop(retained);
}

#[test]
fn resource_headers_are_bounded_same_origin_and_length_exact() {
    for error in [
        ResourceRequestError::BadRequest,
        ResourceRequestError::MethodNotAllowed,
        ResourceRequestError::NotFound,
        ResourceRequestError::Denied,
        ResourceRequestError::TooLarge,
        ResourceRequestError::Unavailable,
    ] {
        let header =
            resources::response_header(error.status(), "application/json", error.body().len());
        assert!(header.len() < MAX_FRAME_HTTP_HEADER_BYTES);
        assert!(header.ends_with(b"\r\n\r\n"));
        let header = String::from_utf8(header).unwrap();
        assert!(!header.contains("Access-Control-Allow"));
        assert!(header.contains("Cross-Origin-Resource-Policy: same-origin\r\n"));
        assert!(header.contains("X-Content-Type-Options: nosniff\r\n"));
        assert!(header.contains(&format!("Content-Length: {}\r\n", error.body().len())));
    }
    assert!(
        resources::response_header(200, "application/octet-stream", usize::MAX).len()
            < MAX_FRAME_HTTP_HEADER_BYTES
    );
}

#[test]
fn valid_get_can_half_close_its_write_side_while_waiting_for_owner() {
    let mut surface = resource_surface();
    let mut peer = client(&surface, &wire(site_path(), ""));
    peer.shutdown(Shutdown::Write).unwrap();
    pump_owner_queue(&mut surface, 1);
    assert_eq!(surface.pending_resource_requests.len(), 1);
    assert_eq!(
        surface
            .resolve_resource_requests(|_| WebResourceResolution::NotFound)
            .unwrap(),
        1
    );
    let response = receive(&mut surface, &mut peer);
    assert!(response.starts_with(b"HTTP/1.1 404 Not Found"));
    let header_end = find_bytes(&response, b"\r\n\r\n").expect("complete resource HTTP header");
    let body = &response[header_end + 4..];
    assert_eq!(parse_content_length(&response[..header_end]), body.len());
    assert_eq!(body, ResourceRequestError::NotFound.body());
    assert!(surface.pending_resource_requests.is_empty());
    assert!(surface.pending_responses.is_empty());
    surface.wait(Duration::ZERO).unwrap();
}
