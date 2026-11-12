//! Serving/auth/framing contracts only. No browser, Worker or ready receipt.
use super::*;
use crate::browser_dev_coordinator::WireU64;
use std::thread;

const SECRET: &str = "dev-ui-only-secret";

fn preview() -> PreviewLease {
    PreviewLease {
        version: "1.0".into(),
        run_id: "run-a".into(),
        preview_id: "preview-a".into(),
        lease_revision: WireU64::new(1),
    }
}

fn resource_surface() -> WebSurface {
    WebSurface::bind_resource_only(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 0).unwrap()
}

fn authenticate(surface: &mut WebSurface, secret: &str) {
    let auth = ControlHttpAuth::new(
        "run-a".into(),
        "client-a".into(),
        secret.into(),
        surface.local_addr().to_string(),
        surface.url().trim_end_matches('/').into(),
    )
    .unwrap();
    surface.enable_control(auth).unwrap();
}

fn enabled(secret: &str) -> WebSurface {
    let mut surface = resource_surface();
    authenticate(&mut surface, secret);
    surface.enable_browser_dev_app(&preview()).unwrap();
    surface
}

fn enable_ui(
    surface: &mut WebSurface,
    lease: &PreviewLease,
    retirement: bool,
) -> Result<(), ControlHttpError> {
    if retirement {
        surface.enable_browser_dev_app_with_retirement(lease)
    } else {
        surface.enable_browser_dev_app(lease)
    }
}

fn wire(method: &str, target: &str, host: &str, headers: &str) -> Vec<u8> {
    format!("{method} {target} HTTP/1.1\r\nHost: {host}\r\n{headers}\r\n").into_bytes()
}

fn exchange(surface: &mut WebSurface, request: &[u8]) -> Vec<u8> {
    let mut client = TcpStream::connect(surface.local_addr()).unwrap();
    client.write_all(request).unwrap();
    client.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut result = Vec::new();
    loop {
        surface.poll().unwrap();
        let mut chunk = [0_u8; 8192];
        match client.read(&mut chunk) {
            Ok(0) => return result,
            Ok(size) => result.extend_from_slice(&chunk[..size]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("development UI transport failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "development UI response timed out"
        );
        thread::yield_now();
    }
}

fn split_response(response: &[u8]) -> (&str, &[u8]) {
    let end = find_bytes(response, b"\r\n\r\n").unwrap();
    (
        std::str::from_utf8(&response[..end]).unwrap(),
        &response[end + 4..],
    )
}

// A successful client connect does not make the server's nonblocking accept
// immediately ready. Wait for the actual socket result, keeping a finite test
// deadline rather than relying on scheduling or making production I/O block.
fn await_socket_ready<T>(mut attempt: impl FnMut() -> io::Result<Option<T>>) -> T {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match attempt() {
            Ok(Some(value)) => return value,
            Ok(None) => {}
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
            Err(error) => panic!("development UI socket setup failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "development UI socket was not ready"
        );
        thread::yield_now();
    }
}

fn poll_until_accepted(surface: &mut WebSurface) {
    await_socket_ready(|| {
        surface.poll()?;
        Ok(surface.has_accepted.then_some(()))
    });
}

#[test]
fn dev_ui_is_once_only_loopback_resource_startup_with_original_auth() {
    let mut legacy = WebSurface::localhost(0).unwrap();
    assert_eq!(
        legacy.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    let mut missing = resource_surface();
    assert_eq!(
        missing.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    authenticate(&mut missing, SECRET);
    missing.enable_browser_dev_app(&preview()).unwrap();
    assert_eq!(
        missing.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    assert!(!format!("{missing:?}").contains(SECRET));

    let mut accepted = resource_surface();
    authenticate(&mut accepted, SECRET);
    let client = TcpStream::connect(accepted.local_addr()).unwrap();
    poll_until_accepted(&mut accepted);
    assert!(accepted.has_accepted);
    assert_eq!(
        accepted.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    drop(client);

    let mut stopped = resource_surface();
    authenticate(&mut stopped, SECRET);
    stopped.stop_admission();
    assert_eq!(
        stopped.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    let mut public =
        WebSurface::bind_resource_only(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), 0).unwrap();
    authenticate(&mut public, SECRET);
    assert_eq!(
        public.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
}

#[test]
fn trusted_preview_cannot_change_latched_run_or_accept_invalid_lease() {
    for retirement in [false, true] {
        let mut surface = resource_surface();
        authenticate(&mut surface, SECRET);
        for field in ["version", "run", "preview", "revision"] {
            let mut invalid = preview();
            match field {
                "version" => invalid.version = "2.0".into(),
                "run" => invalid.run_id = "another-run".into(),
                "preview" => invalid.preview_id = "../other".into(),
                "revision" => invalid.lease_revision = WireU64::new(0),
                _ => unreachable!(),
            }
            assert_eq!(
                enable_ui(&mut surface, &invalid, retirement),
                Err(ControlHttpError::InvalidContext)
            );
            assert!(surface.browser_dev_app.is_none());
        }
        enable_ui(&mut surface, &preview(), retirement).unwrap();
    }
}

#[test]
fn retirement_ui_opt_in_keeps_original_startup_constraints_and_cannot_upgrade_existing_ui() {
    let mut legacy = WebSurface::localhost(0).unwrap();
    assert_eq!(
        legacy.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    let mut missing = resource_surface();
    assert_eq!(
        missing.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    authenticate(&mut missing, SECRET);
    missing
        .enable_browser_dev_app_with_retirement(&preview())
        .unwrap();
    for retirement in [false, true] {
        assert_eq!(
            enable_ui(&mut missing, &preview(), retirement),
            Err(ControlHttpError::InvalidContext)
        );
    }
    assert!(!format!("{missing:?}").contains(SECRET));

    let mut ordinary = enabled(SECRET);
    assert_eq!(
        ordinary.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );

    let mut accepted = resource_surface();
    authenticate(&mut accepted, SECRET);
    let client = TcpStream::connect(accepted.local_addr()).unwrap();
    poll_until_accepted(&mut accepted);
    assert!(accepted.has_accepted);
    assert_eq!(
        accepted.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
    drop(client);

    let mut stopped = resource_surface();
    authenticate(&mut stopped, SECRET);
    stopped.stop_admission();
    assert_eq!(
        stopped.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );

    let mut public =
        WebSurface::bind_resource_only(IpAddr::V4(std::net::Ipv4Addr::UNSPECIFIED), 0).unwrap();
    authenticate(&mut public, SECRET);
    assert_eq!(
        public.enable_browser_dev_app_with_retirement(&preview()),
        Err(ControlHttpError::InvalidContext)
    );
}

#[test]
fn bootstrap_is_original_inert_escaped_json_with_no_wildcard_cors() {
    let secret = "</script><script>alert(1)</script>&";
    let mut surface = enabled(secret);
    let host = surface.local_addr().to_string();
    let response = exchange(&mut surface, &wire("GET", "/", &host, ""));
    let (headers, body) = split_response(&response);
    assert!(headers.starts_with("HTTP/1.1 200 "));
    for header in [
        "Content-Type: text/html; charset=utf-8",
        "Cache-Control: no-store",
        "X-Content-Type-Options: nosniff",
        "Cross-Origin-Resource-Policy: same-origin",
        "Content-Security-Policy: frame-ancestors 'none'",
        "Referrer-Policy: no-referrer",
    ] {
        assert!(headers.contains(header));
    }
    assert!(!headers.contains("Access-Control-Allow-Origin"));
    let html = std::str::from_utf8(body).unwrap();
    let config = html
        .strip_prefix(HTML_START)
        .unwrap()
        .strip_suffix(HTML_END)
        .unwrap();
    assert!(!config.contains(['<', '>', '&']));
    assert!(!html.contains(secret));
    let value: Value = serde_json::from_str(config).unwrap();
    assert!(value["bootstrap"].get("retirementVersion").is_none());
    assert_eq!(
        value,
        json!({"bootstrap": {"version":"1.0", "baseUrl":surface.url(),
        "runId":"run-a", "clientId":"client-a", "preview":preview()}, "secret":secret})
    );
    for id in [
        "dev-status",
        "dev-diagnostics",
        "dev-surface",
        "dev-phase",
        "dev-refresh",
        "dev-stop",
        "dev-retry-cleanup",
        "dev-cleanup",
    ] {
        assert!(html.contains(&format!("id=\"{id}\"")));
    }
    assert!(surface.pending_control_requests.is_empty());
    assert!(surface.pending_resource_requests.is_empty());
}

#[test]
fn retirement_bootstrap_is_explicit_inert_and_preserves_the_original_auth_and_preview() {
    let secret = "</script><script>alert(1)</script>&";
    let mut surface = resource_surface();
    authenticate(&mut surface, secret);
    surface
        .enable_browser_dev_app_with_retirement(&preview())
        .unwrap();
    let host = surface.local_addr().to_string();
    let response = exchange(&mut surface, &wire("GET", "/", &host, ""));
    let (headers, body) = split_response(&response);
    assert!(headers.starts_with("HTTP/1.1 200 "));
    assert!(headers.contains("Cache-Control: no-store"));
    assert!(headers.contains("Content-Security-Policy: frame-ancestors 'none'"));
    assert!(!headers.contains("Access-Control-Allow-Origin"));
    let html = std::str::from_utf8(body).unwrap();
    let config = html
        .strip_prefix(HTML_START)
        .unwrap()
        .strip_suffix(HTML_END)
        .unwrap();
    assert!(!config.contains(['<', '>', '&']));
    assert!(!html.contains(secret));
    let value: Value = serde_json::from_str(config).unwrap();
    assert_eq!(
        value,
        json!({"bootstrap": {"version":"1.0", "baseUrl":surface.url(),
            "runId":"run-a", "clientId":"client-a", "preview":preview(),
            "retirementVersion":"1.0"}, "secret":secret})
    );
    assert!(value.get("retirementVersion").is_none());
    assert!(surface.pending_control_requests.is_empty());
    assert!(surface.pending_resource_requests.is_empty());
}

#[test]
fn only_exact_compiled_assets_are_served_and_never_the_bootstrap_secret() {
    let mut surface = enabled(SECRET);
    let host = surface.local_addr().to_string();
    for &(path, mime, original) in ASSETS {
        let response = exchange(&mut surface, &wire("GET", path, &host, ""));
        let (headers, body) = split_response(&response);
        assert!(headers.starts_with("HTTP/1.1 200 "));
        assert!(headers.contains(&format!("Content-Type: {mime}")));
        assert_eq!(body, original);
        assert!(!String::from_utf8_lossy(body).contains(SECRET));
    }
    for path in [
        "/__weapp/dev/missing.mjs",
        "/Cargo.toml",
        "/api/state",
        "/__weapp/dev/browser-dev-app.mjs?x=1",
        "/__weapp/dev/../browser-dev-app.mjs",
        "/__weapp/dev/%62rowser-dev-app.mjs",
    ] {
        let response = exchange(&mut surface, &wire("GET", path, &host, ""));
        assert!(!response.starts_with(b"HTTP/1.1 200 "));
        assert!(!String::from_utf8_lossy(&response).contains(SECRET));
    }
}

#[test]
fn original_host_and_shared_strict_get_framing_guard_ui_and_resources() {
    let mut surface = enabled(SECRET);
    let host = surface.local_addr().to_string();
    for target in [
        "/",
        "/__weapp/dev/browser-dev-app.mjs",
        "/__weapp/site/run-a/1/site.json",
    ] {
        let response = exchange(&mut surface, &wire("GET", target, "rebinding.example", ""));
        assert!(response.starts_with(b"HTTP/1.1 403 "));
        assert!(!String::from_utf8_lossy(&response).contains(SECRET));
    }
    for (method, target, extra, status) in [
        ("POST", "/", "", 405),
        ("HEAD", "/__weapp/dev/dev.css", "", 405),
        ("GET", "/", "Host: duplicate.example\r\n", 400),
        ("GET", "/__weapp/dev/dev.css", "Content-Length: 1\r\n", 400),
        ("GET", "/", "Transfer-Encoding: chunked\r\n", 400),
    ] {
        let response = exchange(&mut surface, &wire(method, target, &host, extra));
        assert!(response.starts_with(format!("HTTP/1.1 {status} ").as_bytes()));
    }
    assert!(surface.pending_resource_requests.is_empty());
    assert!(surface.pending_control_requests.is_empty());
    let raw = wire("GET", "/", &host, "");
    assert!(resources::parse_get_request(&raw[..raw.len() - 4], 1).is_err());
}

#[test]
fn disabled_ui_does_not_reach_the_legacy_router_or_serve_script_bytes() {
    let mut surface = resource_surface();
    authenticate(&mut surface, SECRET);
    let host = surface.local_addr().to_string();
    for path in ["/", "/__weapp/dev/browser-dev-app.mjs"] {
        let response = exchange(&mut surface, &wire("GET", path, &host, ""));
        assert!(!response.starts_with(b"HTTP/1.1 200 "));
        assert!(!String::from_utf8_lossy(&response).contains(SECRET));
    }
}

#[test]
fn ordinary_resources_keep_the_original_typed_owner_queue_after_ui_opt_in() {
    let mut surface = enabled(SECRET);
    let host = surface.local_addr().to_string();
    let mut client = TcpStream::connect(surface.local_addr()).unwrap();
    client
        .write_all(&wire("GET", "/__weapp/site/run-a/1/site.json", &host, ""))
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while surface.pending_resource_requests.is_empty() {
        surface.poll().unwrap();
        assert!(
            Instant::now() < deadline,
            "original resource request was not queued"
        );
        thread::yield_now();
    }
    assert_eq!(surface.pending_resource_requests.len(), 1);
    assert_eq!(
        surface.pending_resource_requests[0].target,
        WebResourceTarget::Site {
            run_id: "run-a".into(),
            site_id: WireU64::new(1),
        }
    );
    assert!(surface.pending_control_requests.is_empty());
    drop(client);
}

#[test]
fn cached_ui_response_keeps_the_original_accept_deadline() {
    let mut surface = enabled(SECRET);
    let host = surface.local_addr().to_string();
    let mut client = TcpStream::connect(surface.local_addr()).unwrap();
    let (stream, _) = await_socket_ready(|| surface.listener.accept().map(Some));
    stream.set_nonblocking(true).unwrap();
    client.write_all(&wire("GET", "/", &host, "")).unwrap();
    let accepted_at = Instant::now() - Duration::from_secs(1);
    let mut pending = Some(PendingRequest {
        stream,
        buffer: Vec::new(),
        accepted_at,
    });
    let deadline = Instant::now() + Duration::from_secs(2);
    while let Some(request) = pending {
        pending = surface.process_request(request).unwrap();
        assert!(
            Instant::now() < deadline,
            "development UI request did not complete"
        );
        thread::yield_now();
    }
    assert_eq!(surface.pending_responses.len(), 1);
    assert_eq!(surface.pending_responses[0].queued_at, accepted_at);
    drop(client);
}

#[test]
fn ui_publication_is_atomic_and_charged_to_the_original_http_budget() {
    let mut surface = resource_surface();
    authenticate(&mut surface, SECRET);
    let blocker = Arc::new(vec![1]);
    surface
        .shared
        .lock()
        .unwrap()
        .retained_response_bytes
        .push(RetainedResponseBytes {
            bytes: Arc::downgrade(&blocker),
            length: MAX_FRAME_CACHE_BYTES,
        });
    assert_eq!(
        surface.enable_browser_dev_app(&preview()),
        Err(ControlHttpError::Unavailable)
    );
    assert!(surface.browser_dev_app.is_none());
    drop(blocker);
    surface.enable_browser_dev_app(&preview()).unwrap();
    let app = surface.browser_dev_app.as_ref().unwrap();
    let shared = surface.shared.lock().unwrap();
    assert_eq!(app.responses.len(), 7);
    assert_eq!(shared.retained_response_bytes.len(), 7);
    assert_eq!(
        shared
            .retained_response_bytes
            .iter()
            .map(|entry| entry.length)
            .sum::<usize>(),
        app.responses
            .values()
            .map(|bytes| bytes.len())
            .sum::<usize>()
    );
}
