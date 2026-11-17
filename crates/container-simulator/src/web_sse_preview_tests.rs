//! Real localhost socket consumers. These definitions are not browser/GPU
//! acceptance and do not publish fake SSE events to manufacture connections.
use super::sse_preview::EventDropProbe;
use super::*;
use std::net::Shutdown;
use std::sync::atomic::{AtomicUsize, Ordering};

pub(in crate::web) fn setup() -> (WebSurface, WebSurfaceHandle) {
    let mut surface = WebSurface::localhost(0).unwrap();
    surface.enable_sse_preview_binding().unwrap();
    let handle = surface.handle();
    (surface, handle)
}

fn pump_until(surface: &mut WebSurface, mut condition: impl FnMut(&WebSurface) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !condition(surface) {
        surface.poll().unwrap();
        assert!(
            Instant::now() < deadline,
            "owned socket did not reach expected state"
        );
        std::thread::yield_now();
    }
}

pub(in crate::web) fn read_until(
    surface: &mut WebSurface,
    peer: &mut TcpStream,
    expected: &str,
) -> String {
    peer.set_nonblocking(true).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut wire = Vec::new();
    loop {
        surface.poll().unwrap();
        let mut bytes = [0_u8; 8192];
        match peer.read(&mut bytes) {
            Ok(0) => return String::from_utf8(wire).unwrap(),
            Ok(count) => wire.extend_from_slice(&bytes[..count]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => panic!("read owned TCP consumer: {error}"),
        }
        let text = String::from_utf8_lossy(&wire);
        let complete = if expected == "\"committed\":false" {
            text.find("event: preview-init\n")
                .is_some_and(|start| text[start..].contains("\n\n"))
        } else {
            text.contains(expected)
        };
        if complete {
            return String::from_utf8(wire).unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "missing {expected}: {}",
            String::from_utf8_lossy(&wire)
        );
        std::thread::yield_now();
    }
}

pub(in crate::web) fn open(surface: &mut WebSurface, client: &str) -> (TcpStream, Value) {
    let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
    write!(
        peer,
        "GET /api/events?clientId={client}&since=0 HTTP/1.1\r\nHost: localhost\r\n\r\n"
    )
    .unwrap();
    let wire = read_until(surface, &mut peer, "\"committed\":false");
    assert!(wire.starts_with("HTTP/1.1 200"), "{wire}");
    let mut lines = wire.lines();
    assert!(lines.any(|line| line == "event: preview-init"));
    let init: Value =
        serde_json::from_str(lines.next().unwrap().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(init["clientId"], client);
    (peer, init)
}

fn exchange(surface: &mut WebSurface, target: &str, value: &Value) -> String {
    let mut peer = TcpStream::connect(surface.local_addr()).unwrap();
    let body = serde_json::to_vec(value).unwrap();
    write!(
        peer,
        "POST {target} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    peer.write_all(&body).unwrap();
    read_until(surface, &mut peer, "\r\n\r\n")
}

fn bound(init: &Value, epoch: u64, operation: &str, request: &str) -> Value {
    json!({"version":"1.0","requestId":request,"clientId":init["clientId"],
        "op":operation,"epoch":epoch.to_string(),"connectionToken":init["connectionToken"]})
}

fn epoch(handle: &WebSurfaceHandle) -> u64 {
    handle.shared.lock().unwrap().preview.epoch
}

fn drain(handle: &WebSurfaceHandle) -> Vec<PreviewControlReceipt> {
    handle.resolve_preview_controls(|_| Ok(())).unwrap()
}

#[test]
fn actual_sse_init_is_connection_private_and_never_global_or_replayed() {
    let (mut surface, handle) = setup();
    let (mut first, first_init) = open(&mut surface, "one");
    assert_eq!(epoch(&handle), 0, "TCP receipt is not an owner commit");
    drain(&handle);
    let (mut second, second_init) = open(&mut surface, "two");
    drain(&handle);
    let first_token = first_init["connectionToken"].as_str().unwrap();
    let second_token = second_init["connectionToken"].as_str().unwrap();
    assert_ne!(first_token, second_token);
    let notice = handle.publish("marker", json!({"end":true}));
    let one = read_until(&mut surface, &mut first, &format!("id: {notice}\n"));
    let two = read_until(&mut surface, &mut second, &format!("id: {notice}\n"));
    assert!(!one.contains(second_token));
    assert!(!two.contains(first_token));
    let (mut replay, replay_init) = open(&mut surface, "three");
    let latest = handle.publish("tail", json!({"end":true}));
    let replayed = read_until(&mut surface, &mut replay, &format!("id: {latest}\n"));
    for token in [
        first_token,
        second_token,
        replay_init["connectionToken"].as_str().unwrap(),
    ] {
        assert!(!replayed.contains(token));
        assert!(!handle.state().to_string().contains(token));
        let shared = handle.shared.lock().unwrap();
        assert!(!shared
            .events
            .iter()
            .any(|event| String::from_utf8_lossy(&event.wire).contains(token)));
        assert!(!format!("{:?}", shared.preview).contains(token));
    }
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn actual_sse_reconnect_new_token_survives_late_old_eof_before_or_after_commit() {
    for close_before_commit in [true, false] {
        let (mut surface, handle) = setup();
        let (old, old_init) = open(&mut surface, "owner");
        drain(&handle);
        let previous = epoch(&handle);
        let (new, new_init) = open(&mut surface, "owner");
        assert_ne!(old_init["connectionToken"], new_init["connectionToken"]);
        if close_before_commit {
            old.shutdown(Shutdown::Both).unwrap();
            pump_until(&mut surface, |surface| surface.clients.len() == 1);
        }
        let mut retired = 0;
        handle
            .resolve_preview_controls(|_| {
                retired += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(retired, 1);
        assert_eq!(epoch(&handle), previous + 1);
        if !close_before_commit {
            old.shutdown(Shutdown::Both).unwrap();
            pump_until(&mut surface, |surface| surface.clients.len() == 1);
        }
        handle
            .resolve_preview_controls(|_| panic!("old EOF must not retire the new binding"))
            .unwrap();
        assert_eq!(epoch(&handle), previous + 1);
        let request = bound(&new_init, epoch(&handle), "heartbeat", "new-heartbeat");
        assert!(exchange(&mut surface, "/api/preview", &request).starts_with("HTTP/1.1 202"));
        drain(&handle);
        let old_request = bound(&old_init, epoch(&handle), "release", "old-release");
        assert!(exchange(&mut surface, "/api/preview", &old_request).starts_with("HTTP/1.1 409"));
        assert_eq!(
            handle.shared.lock().unwrap().preview.owner.as_deref(),
            Some("owner")
        );
        drop(new);
        surface.close_event_streams();
        drain(&handle);
    }
}

#[test]
fn actual_eof_freezes_current_owner_before_runtime_then_commits_retirement() {
    let (mut surface, handle) = setup();
    let (peer, _) = open(&mut surface, "owner");
    drain(&handle);
    let current = epoch(&handle);
    let proof = handle
        .capture_preview_owner(&PreviewFence {
            client_id: "owner".into(),
            epoch: current.to_string(),
            request_revision: None,
        })
        .unwrap();
    peer.shutdown(Shutdown::Both).unwrap();
    pump_until(&mut surface, |surface| surface.clients.is_empty());
    assert!(handle.validate_preview_owner(&proof).is_err());
    assert_eq!(epoch(&handle), current);
    assert_eq!(
        handle.shared.lock().unwrap().preview.owner.as_deref(),
        Some("owner")
    );
    let mut calls = 0;
    let receipts = handle
        .resolve_preview_controls(|retirement| {
            assert_eq!(retirement.owner_client_id(), Some("owner"));
            assert_eq!(retirement.epoch(), current);
            assert_eq!(epoch(&handle), current);
            assert!(handle.shared.try_lock().is_ok());
            calls += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(receipts.len(), 1);
    assert!(receipts[0].applied());
    assert!(receipts[0].runtime_retired());
    assert_eq!(epoch(&handle), current + 1);
    assert!(handle.shared.lock().unwrap().preview.owner.is_none());
}

#[test]
fn actual_socket_closed_before_connect_never_temporarily_acquires_a_lease() {
    let (mut surface, handle) = setup();
    let (peer, _) = open(&mut surface, "gone");
    peer.shutdown(Shutdown::Both).unwrap();
    pump_until(&mut surface, |surface| surface.clients.is_empty());
    let receipts = handle
        .resolve_preview_controls(|_| panic!("dead uncommitted socket has no runtime owner"))
        .unwrap();
    assert_eq!(receipts.len(), 2);
    assert!(receipts.iter().all(|receipt| !receipt.applied()));
    let shared = handle.shared.lock().unwrap();
    assert_eq!(shared.preview.epoch, 0);
    assert!(shared.preview.owner.is_none());
    assert!(shared.preview.clients.is_empty());
    assert_eq!(shared.preview.reserved_retirements, 0);
}

#[test]
fn owner_callback_reentry_close_cannot_replay_retirement_or_revive_old_proof() {
    let (mut surface, handle) = setup();
    let (_old, _) = open(&mut surface, "owner");
    drain(&handle);
    let old_epoch = epoch(&handle);
    let proof = handle
        .capture_preview_owner(&PreviewFence {
            client_id: "owner".into(),
            epoch: old_epoch.to_string(),
            request_revision: None,
        })
        .unwrap();
    let (_proposed, _) = open(&mut surface, "owner");
    let mut calls = 0;
    let receipts = handle
        .resolve_preview_controls(|_| {
            calls += 1;
            assert!(handle.shared.try_lock().is_ok());
            assert!(handle
                .resolve_preview_controls(|_| Ok(()))
                .unwrap_err()
                .contains("already resolving"));
            drop(surface.clients.remove(1));
            Ok(())
        })
        .unwrap();
    assert_eq!(calls, 1);
    assert!(receipts.iter().all(|receipt| !receipt.applied()));
    assert_eq!(epoch(&handle), old_epoch);
    assert!(handle.validate_preview_owner(&proof).is_err());
    let (_successor, _) = open(&mut surface, "owner");
    handle
        .resolve_preview_controls(|_| panic!("old epoch was already retired"))
        .unwrap();
    assert_eq!(epoch(&handle), old_epoch + 1);
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn failed_or_panicked_callback_keeps_fifo_head_and_unfreezes_only_after_retry_commit() {
    for panic_callback in [false, true] {
        let (mut surface, handle) = setup();
        let (_first, _) = open(&mut surface, "owner");
        drain(&handle);
        let (_next, _) = open(&mut surface, "owner");
        let before = epoch(&handle);
        let queued = handle.shared.lock().unwrap().preview.requests.len();
        if panic_callback {
            assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let _ = handle
                    .resolve_preview_controls(|_| panic!("test callback unwind outside Shared"));
            }))
            .is_err());
        } else {
            assert!(handle
                .resolve_preview_controls(|_| Err("test retirement failed".into()))
                .is_err());
        }
        {
            let shared = handle.shared.lock().unwrap();
            assert!(!shared.preview.resolving);
            assert_eq!(shared.preview.requests.len(), queued);
            assert_eq!(shared.preview.epoch, before);
        }
        assert!(handle
            .capture_preview_owner(&PreviewFence {
                client_id: "owner".into(),
                epoch: before.to_string(),
                request_revision: None
            })
            .is_err());
        let mut retries = 0;
        handle
            .resolve_preview_controls(|_| {
                retries += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(retries, 1);
        assert_eq!(epoch(&handle), before + 1);
        surface.close_event_streams();
        drain(&handle);
    }
}

#[test]
fn live_owner_claim_after_lost_successor_advances_epoch_without_replaying_completed_retirement() {
    for completed in [false, true] {
        let (mut surface, handle) = setup();
        let (_owner, owner_init) = open(&mut surface, "owner");
        drain(&handle);
        let previous = epoch(&handle);
        let old_proof = handle
            .capture_preview_owner(&PreviewFence {
                client_id: "owner".into(),
                epoch: previous.to_string(),
                request_revision: None,
            })
            .unwrap();
        let (_successor, _) = open(&mut surface, "owner");
        let result = handle.resolve_preview_controls(|_| {
            drop(surface.clients.remove(1));
            if completed {
                Ok(())
            } else {
                Err("retirement attempt failed".into())
            }
        });
        assert_eq!(result.is_ok(), completed);
        // If retirement failed, the dead proposal still occupies its FIFO
        // head. Consuming stale metadata cannot invoke a runtime callback.
        handle
            .resolve_preview_controls(|_| panic!("dead successor cannot retire runtime"))
            .unwrap();
        assert_eq!(epoch(&handle), previous);
        assert_eq!(surface.clients.len(), 1);
        {
            let shared = handle.shared.lock().unwrap();
            assert!(
                shared.preview.requests.is_empty(),
                "dead successor controls must be consumed in FIFO order"
            );
            assert_eq!(
                shared.preview.reserved_retirements, 1,
                "only the live original socket retains a cleanup obligation"
            );
        }
        assert!(handle.validate_preview_owner(&old_proof).is_err());
        assert!(exchange(
            &mut surface,
            "/api/preview",
            &bound(&owner_init, previous, "claim", "live-reclaim")
        )
        .starts_with("HTTP/1.1 202"));
        let mut retries = 0;
        let receipts = handle
            .resolve_preview_controls(|_| {
                retries += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            retries,
            usize::from(!completed),
            "completed retirement cannot be replayed"
        );
        assert_eq!(receipts.len(), 1);
        assert!(receipts[0].applied());
        assert!(receipts[0].runtime_retired());
        assert_eq!(epoch(&handle), previous + 1);
        let proof = handle
            .capture_preview_owner(&PreviewFence {
                client_id: "owner".into(),
                epoch: epoch(&handle).to_string(),
                request_revision: None,
            })
            .unwrap();
        handle.validate_preview_owner(&proof).unwrap();
        assert!(
            handle.validate_preview_owner(&old_proof).is_err(),
            "reclaim cannot revive prior proof"
        );
        assert!(exchange(
            &mut surface,
            "/api/preview",
            &bound(&owner_init, previous, "heartbeat", "stale-heartbeat")
        )
        .starts_with("HTTP/1.1 409"));
        assert!(exchange(
            &mut surface,
            "/api/preview",
            &bound(&owner_init, epoch(&handle), "heartbeat", "live-heartbeat")
        )
        .starts_with("HTTP/1.1 202"));
        handle
            .resolve_preview_controls(|_| panic!("live heartbeat cannot repeat retirement"))
            .unwrap();
        assert_eq!(epoch(&handle), previous + 1);
        surface.close_event_streams();
        drain(&handle);
        let shared = handle.shared.lock().unwrap();
        assert!(shared.preview.requests.is_empty());
        assert_eq!(shared.preview.reserved_retirements, 0);
        assert!(shared.preview.clients.is_empty());
    }
}

#[test]
fn actual_socket_retirements_keep_capacity_reserved_until_owner_consumption() {
    let (mut surface, handle) = setup();
    let mut peers = Vec::new();
    let mut inits = Vec::new();
    for index in 0..MAX_SSE_CLIENTS {
        let (peer, init) = open(&mut surface, &format!("c{index}"));
        peers.push(peer);
        inits.push(init);
    }
    {
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.preview.requests.len(), 16);
        assert_eq!(shared.preview.reserved_retirements, 16);
    }
    drain(&handle);
    for (index, init) in inits.iter().enumerate() {
        let request = bound(init, epoch(&handle), "heartbeat", &format!("hb{index}"));
        assert!(exchange(&mut surface, "/api/preview", &request).starts_with("HTTP/1.1 202"));
    }
    let extra = bound(&inits[0], epoch(&handle), "heartbeat", "extra");
    assert!(exchange(&mut surface, "/api/preview", &extra).starts_with("HTTP/1.1 409"));
    surface.close_event_streams();
    {
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.preview.reserved_retirements, 0);
        assert_eq!(
            shared.preview.requests.len(),
            32,
            "closing converts obligations, never frees the lane early"
        );
    }
    let mut rejected = TcpStream::connect(surface.local_addr()).unwrap();
    rejected
        .write_all(b"GET /api/events?clientId=new HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    assert!(read_until(&mut surface, &mut rejected, "\r\n\r\n").starts_with("HTTP/1.1 503"));
    let mut retired = 0;
    let receipts = handle
        .resolve_preview_controls(|_| {
            retired += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(receipts.len(), 32);
    assert_eq!(retired, 1);
    assert!(handle.shared.lock().unwrap().preview.requests.is_empty());
    let (_fresh, _) = open(&mut surface, "new");
    drain(&handle);
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn actual_bound_wire_fifo_and_mirror_same_epoch_reconnect_keep_exact_connection_identity() {
    let (mut surface, handle) = setup();
    let (_owner, _) = open(&mut surface, "owner");
    drain(&handle);
    let (old_mirror, mirror_init) = open(&mut surface, "mirror");
    drain(&handle);
    let original = epoch(&handle);
    let release = bound(&mirror_init, original, "release", "mirror-release");
    assert!(exchange(&mut surface, "/api/preview", &release).starts_with("HTTP/1.1 202"));
    drain(&handle);
    assert_eq!(epoch(&handle), original);
    let (_new_mirror, new_init) = open(&mut surface, "mirror");
    drain(&handle);
    old_mirror.shutdown(Shutdown::Both).unwrap();
    pump_until(&mut surface, |surface| surface.clients.len() == 2);
    handle
        .resolve_preview_controls(|_| panic!("mirror EOF cannot retire owner"))
        .unwrap();
    let claim = bound(&new_init, original, "claim", "mirror-claim");
    assert!(exchange(&mut surface, "/api/preview", &claim).starts_with("HTTP/1.1 202"));
    let stale_heartbeat = bound(&new_init, original, "heartbeat", "queued-old-heartbeat");
    assert!(exchange(&mut surface, "/api/preview", &stale_heartbeat).starts_with("HTTP/1.1 202"));
    let receipts = drain(&handle);
    assert_eq!(receipts.len(), 2);
    assert!(receipts[0].applied());
    assert!(
        !receipts[1].applied(),
        "FIFO claim advances epoch before heartbeat"
    );
    assert_eq!(
        handle.shared.lock().unwrap().preview.owner.as_deref(),
        Some("mirror")
    );
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn actual_socket_drop_and_write_error_queue_once_even_when_store_is_poisoned() {
    for poison in [false, true] {
        let (mut surface, handle) = setup();
        let (_peer, _) = open(&mut surface, "owner");
        drain(&handle);
        if poison {
            let shared = Arc::clone(&handle.shared);
            assert!(std::panic::catch_unwind(|| {
                let _guard = shared.lock().unwrap();
                panic!("poison test");
            })
            .is_err());
            surface.flush_events();
        } else {
            surface.clients[0].stream.shutdown(Shutdown::Write).unwrap();
            handle.publish("write-failure", json!({"test":true}));
            // The real socket write fails after its pending batch is queued.
            surface.flush_events();
            surface.flush_events();
        }
        assert!(surface.clients.is_empty());
        let shared = handle
            .shared
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        assert_eq!(shared.preview.reserved_retirements, 0);
        assert_eq!(shared.preview.requests.len(), 1);
    }
    let (mut surface, handle) = setup();
    let (_peer, _) = open(&mut surface, "owner");
    drain(&handle);
    drop(surface);
    let mut retired = 0;
    handle
        .resolve_preview_controls(|_| {
            retired += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(
        retired, 1,
        "surface Drop queues while Shared can still be upgraded"
    );
}

#[test]
fn owner_commit_drops_evicted_actual_replay_owner_only_after_web_unlock() {
    let (mut surface, handle) = setup();
    let (_peer, _) = open(&mut surface, "owner");
    let count = Arc::new(AtomicUsize::new(0));
    let dropped = Arc::clone(&count);
    let weak_shared = Arc::downgrade(&handle.shared);
    {
        let mut shared = handle.shared.lock().unwrap();
        for _ in 0..MAX_EVENTS {
            shared.publish("retained".into(), json!({"value":1}));
        }
        shared.events.front_mut().unwrap()._drop_probe =
            Some(Arc::new(EventDropProbe(Box::new(move || {
                let shared = weak_shared.upgrade().unwrap();
                assert!(
                    shared.try_lock().is_ok(),
                    "actual replay owner destructor held Web mutex"
                );
                dropped.fetch_add(1, Ordering::SeqCst);
            }))));
    }
    assert_eq!(count.load(Ordering::SeqCst), 0);
    drain(&handle);
    assert_eq!(count.load(Ordering::SeqCst), 1);
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn bound_owner_work_wakes_wait_without_network_sleep_and_legacy_entry_cannot_bypass_it() {
    let (mut surface, handle) = setup();
    let (_peer, _) = open(&mut surface, "owner");
    let start = Instant::now();
    surface.wait(Duration::from_secs(1)).unwrap();
    assert!(start.elapsed() < Duration::from_millis(250));
    assert!(handle.take_preview_requests().is_empty());
    let forged = PreviewRequest {
        version: "1.0".into(),
        request_id: "forged".into(),
        client_id: "owner".into(),
        op: "connect".into(),
        epoch: None,
    };
    assert!(handle.commit_preview_request(&forged, true).is_err());
    assert!(handle.preview_transfer_required(&forged).is_err());
    let (_next, _) = open(&mut surface, "mirror");
    for operation in ["connect", "expire", "disconnect"] {
        let bad = json!({"version":"1.0","requestId":"bad","clientId":"owner","op":operation,
            "epoch":"0","connectionToken":"guessed"});
        assert!(exchange(&mut surface, "/api/preview", &bad).starts_with("HTTP/1.1 409"));
    }
    assert_eq!(epoch(&handle), 0);
    drain(&handle);
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn opt_in_is_pristine_only_and_default_actual_sse_preserves_legacy_protocol() {
    let mut legacy = WebSurface::localhost(0).unwrap();
    let mut peer = TcpStream::connect(legacy.local_addr()).unwrap();
    peer.write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let response = read_until(&mut legacy, &mut peer, "\r\n\r\n");
    assert!(response.starts_with("HTTP/1.1 200"));
    assert!(!response.contains("preview-init"));
    assert!(legacy.enable_sse_preview_binding().is_err());
    assert!(!legacy.shared.lock().unwrap().preview.sse_binding_enabled);
    let mut resource = WebSurface::bind_resource_only("127.0.0.1".parse().unwrap(), 0).unwrap();
    assert!(resource.enable_sse_preview_binding().is_err());
    legacy.close_event_streams();
}

#[test]
fn actual_connection_serial_exhaustion_never_reuses_a_token_or_spends_an_extra_obligation() {
    let (mut surface, handle) = setup();
    handle.shared.lock().unwrap().preview.next_connection_serial = Some(u64::MAX);
    let (_last, init) = open(&mut surface, "last");
    assert!(init["connectionToken"]
        .as_str()
        .unwrap()
        .ends_with("-18446744073709551615"));
    let before = {
        let shared = handle.shared.lock().unwrap();
        (
            shared.preview.requests.len(),
            shared.preview.reserved_retirements,
        )
    };
    let mut rejected = TcpStream::connect(surface.local_addr()).unwrap();
    rejected
        .write_all(b"GET /api/events?clientId=last HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    assert!(read_until(&mut surface, &mut rejected, "\r\n\r\n").starts_with("HTTP/1.1 503"));
    let after = {
        let shared = handle.shared.lock().unwrap();
        (
            shared.preview.requests.len(),
            shared.preview.reserved_retirements,
        )
    };
    assert_eq!(before, after);
    surface.close_event_streams();
    drain(&handle);
}

#[test]
fn actual_socket_expiry_requires_owner_retirement_and_unknown_binding_requests_are_rejected() {
    let (mut surface, handle) = setup();
    let (_peer, _) = open(&mut surface, "owner");
    drain(&handle);
    let before = epoch(&handle);
    handle
        .shared
        .lock()
        .unwrap()
        .preview
        .clients
        .get_mut("owner")
        .unwrap()
        .last_seen = Instant::now() - preview::PREVIEW_LEASE - Duration::from_millis(1);
    assert!(handle
        .capture_preview_owner(&PreviewFence {
            client_id: "owner".into(),
            epoch: before.to_string(),
            request_revision: None
        })
        .is_err());
    assert_eq!(epoch(&handle), before);
    let mut calls = 0;
    handle
        .resolve_preview_controls(|retirement| {
            assert_eq!(retirement.reason(), "preview-owner-expired");
            assert_eq!(epoch(&handle), before);
            calls += 1;
            Ok(())
        })
        .unwrap();
    assert_eq!(calls, 1);
    assert!(handle.shared.lock().unwrap().preview.owner.is_none());
    let mut missing = TcpStream::connect(surface.local_addr()).unwrap();
    missing
        .write_all(b"GET /api/events HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .unwrap();
    assert!(read_until(&mut surface, &mut missing, "\r\n\r\n").starts_with("HTTP/1.1 400"));
    surface.close_event_streams();
    drain(&handle);
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[test]
fn actual_sse_owner_lane_retires_the_same_native_runtime_exact_raster_lease() {
    use crate::{Simulator, SimulatorConfig};
    use container_runtime::DevRasterPresentationTarget;
    let pack = super::density_tests::fixture::new();
    for engine in enabled_native_test_engines() {
        let mut simulator = Simulator::from_pack_dir(
            &pack.0,
            SimulatorConfig {
                engine,
                page_render_mode: container_render_skia::PageRenderMode::Raster,
                viewport: container_render_skia::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 2.0,
                    height: 1.0,
                },
                ..Default::default()
            },
        )
        .unwrap();
        simulator
            .host_mut()
            .session_mut()
            .unwrap()
            .enable_dev_raster_presentation()
            .unwrap();
        simulator.run().unwrap();
        let (mut surface, handle) = setup();
        let (peer, _) = open(&mut surface, "owner");
        handle
            .resolve_preview_controls(|retirement| {
                simulator
                    .retire_dev_preview(retirement.reason())
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        let proof = handle
            .capture_preview_owner(&PreviewFence {
                client_id: "owner".into(),
                epoch: epoch(&handle).to_string(),
                request_revision: None,
            })
            .unwrap();
        let session_id = simulator.session_id().to_owned();
        let session = simulator.host_mut().session_mut().unwrap();
        let (source_frame, revision, logical_width, logical_height, width, height) = {
            let observed = session.accepted_page_observation().unwrap();
            (
                observed.frame.frame_id,
                observed.render_revision,
                observed.frame.viewport.width,
                observed.frame.viewport.height,
                observed.target.width,
                observed.target.height,
            )
        };
        let reservation = handle
            .reserve_frame(&session_id, 1, logical_width, logical_height, width, height)
            .unwrap();
        let identity = reservation.identity();
        let target = DevRasterPresentationTarget {
            session_id: session_id.clone(),
            preview_id: proof.client_id().into(),
            preview_generation: proof.epoch(),
            frame_id: identity.frame_id(),
            source_frame_id: source_frame,
            render_revision: revision,
            config_generation: identity.config_generation(),
            logical_width: logical_width as u32,
            logical_height: logical_height as u32,
            width,
            height,
        };
        let prepared = session.prepare_dev_raster_presentation(target).unwrap();
        let ticket = prepared.ticket().clone();
        let observed = prepared.accepted_page_observation();
        let transport = reservation
            .prepare(observed.snapshot.unwrap(), observed.render_revision, 0.0)
            .unwrap();
        let retired = prepared.accept();
        transport.install();
        drop(retired);
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(
            session.is_current_frame_presented(),
            "typed library ACK is distinct from a browser receipt"
        );
        peer.shutdown(Shutdown::Both).unwrap();
        pump_until(&mut surface, |surface| surface.clients.is_empty());
        handle
            .resolve_preview_controls(|retirement| {
                assert!(handle.shared.try_lock().is_ok());
                simulator
                    .retire_dev_preview(retirement.reason())
                    .map(|_| ())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
        assert!(!simulator
            .host()
            .session()
            .unwrap()
            .is_current_frame_presented());
        assert!(handle.validate_preview_owner(&proof).is_err());
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
    }
}
