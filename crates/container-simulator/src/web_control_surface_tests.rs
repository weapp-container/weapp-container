//! Real loopback TCP tests of the opt-in WebSurface owner seam. Ledger finals
//! and coordinator snapshots are real; no Worker, close receipt, presenter,
//! device or GPU is constructed or claimed by these tests.

use super::*;
use crate::browser_dev_control::{
    ControlError, ControlLedger, ControlLimits, ControlLookup, ControlOperation, ControlResult,
    FinalAckOutcome, FinalDraft, FinalOutcome, Lane, MAX_CONTROL_REQUEST_BYTES,
    MAX_CONTROL_RETIREMENT_BYTES,
};
use crate::browser_dev_coordinator::{
    BrowserDevCoordinator, RuntimePins, StartupIntentPin, WireU64,
};
use crate::web_control::{
    ControlAcknowledgementReply, ControlHttpAuth, ControlHttpError, WebControlRequest,
    WebControlResponse,
};
use std::net::Ipv4Addr;
use std::thread;

const RUN: &str = "run-test";
const CLIENT: &str = "client-test";
const SECRET: &str = "isolated-control-test-secret";
const INVOKE: &str = "/__weapp/control/invoke";
const REPLAY: &str = "/__weapp/control/replay";
const ACK: &str = "/__weapp/control/acknowledge";
const RETIRE: &str = "/__weapp/control/retire";
const OBSERVE: &str = "/__weapp/control/observe";

fn auth_for(address: SocketAddr, scheme: &str) -> ControlHttpAuth {
    ControlHttpAuth::new(
        RUN.into(),
        CLIENT.into(),
        SECRET.into(),
        address.to_string(),
        format!("{scheme}://{address}"),
    )
    .unwrap()
}

fn resource_surface() -> WebSurface {
    WebSurface::bind_resource_only(IpAddr::V4(Ipv4Addr::LOCALHOST), 0).unwrap()
}

fn surface() -> WebSurface {
    let mut surface = resource_surface();
    surface
        .enable_control(auth_for(surface.local_addr(), "http"))
        .unwrap();
    surface
}

fn wire(surface: &WebSurface, path: &str, body: &[u8]) -> Vec<u8> {
    let address = surface.local_addr();
    let mut bytes = format!(
        "POST {path} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nX-Weapp-Run-Id: {RUN}\r\nX-Weapp-Client-Id: {CLIENT}\r\nX-Weapp-Dev-Secret: {SECRET}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len()
    ).into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn original(serial: u64) -> Vec<u8> {
    format!(" \n{{\"payload\":{{}},\"requestId\":\"{CLIENT}:control-{serial}\",\"command\":\"snapshot\",\"version\":\"1.0\"}}\n").into_bytes()
}

fn client(surface: &WebSurface, request: &[u8]) -> TcpStream {
    let mut stream = TcpStream::connect(surface.local_addr()).unwrap();
    stream.set_nodelay(true).unwrap();
    stream.write_all(request).unwrap();
    stream.set_nonblocking(true).unwrap();
    stream
}

fn pump_until(surface: &mut WebSurface, ready: impl Fn(&WebSurface) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        surface.poll().unwrap();
        if ready(surface) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "surface did not reach expected state: {:?}",
            surface.drain_status()
        );
        thread::yield_now();
    }
}

fn queued(surface: &mut WebSurface, expected: usize) {
    pump_until(surface, |surface| {
        surface.pending_control_requests.len() == expected && surface.pending_requests.is_empty()
    });
}

fn receive(surface: &mut WebSurface, peer: &mut TcpStream) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    loop {
        surface.poll().unwrap();
        let mut chunk = [0_u8; 4096];
        match peer.read(&mut chunk) {
            Ok(0) => return bytes,
            Ok(length) => bytes.extend_from_slice(&chunk[..length]),
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) if is_client_disconnect(&error) && bytes.is_empty() => return bytes,
            Err(error) => panic!("control TCP response failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "control TCP response did not close"
        );
        thread::yield_now();
    }
}

fn assert_status(bytes: &[u8], expected: u16) {
    assert!(
        bytes.starts_with(format!("HTTP/1.1 {expected} ").as_bytes()),
        "unexpected response: {}",
        String::from_utf8_lossy(bytes)
    );
    let text = String::from_utf8_lossy(bytes);
    assert!(!text
        .to_ascii_lowercase()
        .contains("access-control-allow-origin"));
    assert!(!text.contains(SECRET));
}

fn response_json(bytes: &[u8]) -> Value {
    let start = find_bytes(bytes, b"\r\n\r\n").unwrap() + 4;
    serde_json::from_slice(&bytes[start..]).unwrap()
}

struct Owner {
    ledger: ControlLedger,
    coordinator: BrowserDevCoordinator,
    executed: usize,
    final_pointer: Option<(usize, usize)>,
    retirement_enabled: bool,
}

impl Owner {
    fn new() -> Self {
        Self {
            ledger: ControlLedger::new(RUN.into(), CLIENT.into(), ControlLimits::default())
                .unwrap(),
            // Shape-only fixture pins. No real bundle, stage or browser is minted.
            coordinator: BrowserDevCoordinator::new(
                RUN.into(),
                RuntimePins {
                    bundle_sha256: "a".repeat(64),
                    producer_report_sha256: "b".repeat(64),
                    source_commit: "c".repeat(40),
                    source_inventory_sha256: "d".repeat(64),
                },
                StartupIntentPin {
                    revision: WireU64::new(1),
                    sha256: "e".repeat(64),
                    metrics_revision: WireU64::new(0),
                },
            )
            .unwrap(),
            executed: 0,
            final_pointer: None,
            retirement_enabled: false,
        }
    }

    fn resolve(
        &mut self,
        auth: &ControlHttpAuth,
        request: &WebControlRequest,
    ) -> WebControlResponse {
        assert_eq!(auth.run_id(), RUN);
        assert_eq!(auth.client_id(), CLIENT);
        let bytes = match request {
            WebControlRequest::Observe => {
                return WebControlResponse::Observation(Box::new(self.coordinator.snapshot()));
            }
            WebControlRequest::Invoke(bytes) => {
                let admission = match self.ledger.admit(auth.run_id(), bytes.bytes()) {
                    Ok(admission) => admission,
                    Err(error) => return Self::refuse_ledger_error(error),
                };
                match admission {
                    ControlLookup::Queued(receipt) => {
                        let begun = self.ledger.begin(&receipt.identity).unwrap();
                        assert!(matches!(begun.operation, ControlOperation::Snapshot(_)));
                        self.executed += 1;
                        let snapshot = self.coordinator.snapshot();
                        self.ledger
                            .finish(
                                &begun.ticket,
                                FinalDraft {
                                    snapshot: snapshot.clone(),
                                    outcome: FinalOutcome::Ok(Box::new(ControlResult::Snapshot(
                                        Box::new(snapshot),
                                    ))),
                                },
                            )
                            .unwrap()
                    }
                    ControlLookup::Final(bytes) => bytes,
                    _ => panic!("unexpected invoke ledger state"),
                }
            }
            WebControlRequest::Replay(bytes) => {
                match self.ledger.lookup(auth.run_id(), bytes.bytes()) {
                    Ok(ControlLookup::Final(bytes)) => bytes,
                    Ok(_) => return WebControlResponse::Refused(ControlHttpError::Unavailable),
                    Err(error) => return Self::refuse_ledger_error(error),
                }
            }
            WebControlRequest::Acknowledge(ack) => {
                let outcome = self
                    .ledger
                    .acknowledge_final(
                        auth.run_id(),
                        ack.original_request_bytes(),
                        ack.final_sha256(),
                    )
                    .unwrap();
                let original: Value = serde_json::from_slice(ack.original_request_bytes()).unwrap();
                return WebControlResponse::Acknowledged(ControlAcknowledgementReply {
                    version: "1.0",
                    request_id: original["requestId"].as_str().unwrap().into(),
                    final_sha256: ack.final_sha256().into(),
                    outcome,
                });
            }
            WebControlRequest::Retire(retirement) => {
                if !self.retirement_enabled {
                    return WebControlResponse::Refused(ControlHttpError::Denied);
                }
                return match self.ledger.retire_prefix(auth.run_id(), retirement) {
                    Ok(reply) => WebControlResponse::Retired(reply),
                    Err(_) => WebControlResponse::Refused(ControlHttpError::InvalidRetirement),
                };
            }
        };
        let pointer = (
            Arc::as_ptr(&bytes) as usize,
            bytes.as_slice().as_ptr() as usize,
        );
        if let Some(original_pointer) = self.final_pointer {
            assert_eq!(pointer, original_pointer);
        }
        self.final_pointer = Some(pointer);
        WebControlResponse::Final(bytes)
    }

    fn refuse_ledger_error(error: ControlError) -> WebControlResponse {
        WebControlResponse::Refused(if error == ControlError::WrongIdentity {
            ControlHttpError::Denied
        } else {
            ControlHttpError::Unavailable
        })
    }
}

#[test]
fn control_opt_in_is_once_on_the_exact_unoccupied_plain_http_resource_surface() {
    let mut legacy = WebSurface::localhost(0).unwrap();
    assert_eq!(
        legacy.enable_control(auth_for(legacy.local_addr(), "http")),
        Err(ControlHttpError::InvalidContext)
    );
    let mut target = resource_surface();
    let other_ip = SocketAddr::new(
        IpAddr::V4(Ipv4Addr::new(127, 0, 0, 2)),
        target.local_addr().port(),
    );
    assert_eq!(
        target.enable_control(auth_for(other_ip, "http")),
        Err(ControlHttpError::InvalidContext)
    );
    assert_eq!(
        target.enable_control(auth_for(target.local_addr(), "https")),
        Err(ControlHttpError::InvalidContext)
    );
    target
        .enable_control(auth_for(target.local_addr(), "http"))
        .unwrap();
    assert_eq!(
        target.enable_control(auth_for(target.local_addr(), "http")),
        Err(ControlHttpError::InvalidContext)
    );

    let mut occupied = resource_surface();
    let _peer = client(&occupied, b"GET /__weapp/site/");
    pump_until(&mut occupied, |surface| surface.pending_requests.len() == 1);
    assert_eq!(
        occupied.enable_control(auth_for(occupied.local_addr(), "http")),
        Err(ControlHttpError::InvalidContext)
    );
    let mut stopped = resource_surface();
    stopped.stop_admission();
    assert_eq!(
        stopped.enable_control(auth_for(stopped.local_addr(), "http")),
        Err(ControlHttpError::InvalidContext)
    );
}

#[test]
fn control_cannot_be_enabled_after_an_earlier_request_has_completely_drained() {
    let mut target = resource_surface();
    let mut peer = client(
        &target,
        b"GET /__weapp/site/run-test/1/site.json HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    pump_until(&mut target, |surface| {
        surface.pending_resource_requests.len() == 1
    });
    assert_eq!(
        target
            .resolve_resource_requests(|_| WebResourceResolution::NotFound)
            .unwrap(),
        1
    );
    assert_status(&receive(&mut target, &mut peer), 404);
    assert!(target.pending_requests.is_empty());
    assert!(target.pending_resource_requests.is_empty());
    assert!(target.pending_responses.is_empty());
    assert_eq!(
        target.enable_control(auth_for(target.local_addr(), "http")),
        Err(ControlHttpError::InvalidContext)
    );
}

#[test]
fn invoke_and_replay_borrow_the_exact_original_body_and_resolve_on_the_owner_thread() {
    let mut target = surface();
    let mut owner = Owner::new();
    let bytes = original(1);
    let owner_thread = thread::current().id();
    let mut first_response = None;
    for path in [INVOKE, REPLAY] {
        let mut peer = client(&target, &wire(&target, path, &bytes));
        queued(&mut target, 1);
        let pending = &target.pending_control_requests[0];
        let (WebControlRequest::Invoke(retained) | WebControlRequest::Replay(retained)) =
            &pending.request
        else {
            panic!("wrong endpoint");
        };
        let pointer = retained.bytes().as_ptr();
        let capacity = retained.retained_capacity();
        let accepted_at = pending.accepted_at;
        assert_eq!(target.resolve_control_requests(|auth, request| {
            assert_eq!(thread::current().id(), owner_thread);
            let (WebControlRequest::Invoke(retained) | WebControlRequest::Replay(retained)) = request else { panic!("wrong endpoint"); };
            assert_eq!(retained.bytes(), bytes);
            assert_eq!(retained.bytes().as_ptr(), pointer);
            assert_eq!(retained.retained_capacity(), capacity);
            owner.resolve(auth, request)
        }).unwrap(), 1);
        assert_eq!(target.pending_responses.len(), 1);
        assert_eq!(target.pending_responses[0].queued_at, accepted_at);
        let ResponseBody::Control(final_bytes) = &target.pending_responses[0].body else {
            panic!("not original control body");
        };
        assert_eq!(
            Some((
                Arc::as_ptr(final_bytes) as usize,
                final_bytes.as_slice().as_ptr() as usize
            )),
            owner.final_pointer
        );
        let response = receive(&mut target, &mut peer);
        assert_status(&response, 200);
        if let Some(first) = &first_response {
            assert_eq!(&response, first);
        } else {
            first_response = Some(response);
        }
    }
    assert_eq!(owner.executed, 1);
}

#[test]
fn retirement_is_refused_by_the_original_owner_until_its_explicit_opt_in() {
    let mut target = surface();
    let mut owner = Owner::new();
    let body = serde_json::to_vec(&json!({
        "version":"1.0", "lane":"normal", "previousThrough":"0", "throughSerial":"1",
        "prefixSha256":"a".repeat(64),
    }))
    .unwrap();
    let mut peer = client(&target, &wire(&target, RETIRE, &body));
    queued(&mut target, 1);
    assert!(matches!(
        target.pending_control_requests[0].request,
        WebControlRequest::Retire(_)
    ));
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    assert_status(&receive(&mut target, &mut peer), 403);
    assert_eq!(owner.executed, 0);
    assert_eq!(owner.ledger.usage(Lane::Normal).entries, 0);
    assert_eq!(owner.ledger.seen_through(Lane::Normal).get(), 0);
    assert_eq!(owner.ledger.retired_through(Lane::Normal).get(), 0);
}

#[test]
fn completed_final_ack_and_retirement_reclaim_the_original_ledger_without_reexecution() {
    let mut target = surface();
    let mut owner = Owner::new();
    owner.retirement_enabled = true;
    let original = original(1);

    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    let weak = {
        let ResponseBody::Control(bytes) = &target.pending_responses[0].body else {
            panic!("final did not borrow the original ledger allocation");
        };
        assert_eq!(Arc::strong_count(bytes), 2);
        Arc::downgrade(bytes)
    };
    let response = receive(&mut target, &mut peer);
    assert_status(&response, 200);
    let body_start = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
    let final_sha256 = container_ir::hex_digest(&response[body_start..]);
    assert_eq!(weak.strong_count(), 1);
    assert!(target.pending_responses.is_empty());
    assert_eq!(owner.executed, 1);

    let acknowledgement = serde_json::to_vec(&json!({
        "version":"1.0", "originalRequest":std::str::from_utf8(&original).unwrap(),
        "finalSha256":final_sha256,
    }))
    .unwrap();
    let mut peer = client(&target, &wire(&target, ACK, &acknowledgement));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    let response = receive(&mut target, &mut peer);
    assert_status(&response, 200);
    assert_eq!(response_json(&response)["outcome"], "compacted");
    assert_eq!(weak.strong_count(), 0);
    let compacted_usage = owner.ledger.usage(Lane::Normal);
    assert_eq!(compacted_usage.entries, 1);
    assert!(compacted_usage.bytes > 0);

    // Hash the final actually received over TCP, not a synthetic replacement.
    let transcript = format!(
        "weapp-control-retirement-v1\n{RUN}\n{CLIENT}\nnormal\n0\n1\n{CLIENT}:control-1:{final_sha256}\n"
    );
    let prefix_sha256 = container_ir::hex_digest(transcript.as_bytes());
    let retirement = json!({
        "version":"1.0", "lane":"normal", "previousThrough":"0", "throughSerial":"1",
        "prefixSha256":prefix_sha256,
    });
    let mut invalid = retirement.clone();
    invalid["prefixSha256"] = json!("0".repeat(64));
    let mut peer = client(
        &target,
        &wire(&target, RETIRE, &serde_json::to_vec(&invalid).unwrap()),
    );
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    assert_status(&receive(&mut target, &mut peer), 400);
    assert_eq!(owner.ledger.usage(Lane::Normal), compacted_usage);
    assert_eq!(owner.ledger.retired_through(Lane::Normal).get(), 0);

    let body = serde_json::to_vec(&retirement).unwrap();
    let mut first_receipt: Option<Vec<u8>> = None;
    for _ in 0..2 {
        let mut peer = client(&target, &wire(&target, RETIRE, &body));
        queued(&mut target, 1);
        let accepted_at = target.pending_control_requests[0].accepted_at;
        target
            .resolve_control_requests(|auth, request| owner.resolve(auth, request))
            .unwrap();
        assert_eq!(target.pending_responses.len(), 1);
        assert_eq!(target.pending_responses[0].queued_at, accepted_at);
        let response = receive(&mut target, &mut peer);
        assert_status(&response, 200);
        let body_start = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
        let receipt = &response[body_start..];
        assert!(receipt.len() <= MAX_CONTROL_RETIREMENT_BYTES);
        assert_eq!(
            response_json(&response),
            json!({"version":"1.0", "runId":RUN, "clientId":CLIENT, "lane":"normal",
                "previousThrough":"0", "throughSerial":"1", "prefixSha256":prefix_sha256,
                "retiredCount":1, "outcome":"retired"})
        );
        if let Some(first) = &first_receipt {
            assert_eq!(
                receipt,
                first.as_slice(),
                "retry must return the exact original receipt"
            );
        } else {
            first_receipt = Some(receipt.to_vec());
        }
        assert_eq!(owner.ledger.usage(Lane::Normal).entries, 0);
        assert_eq!(owner.ledger.usage(Lane::Normal).bytes, 0);
        assert_eq!(owner.ledger.retired_through(Lane::Normal).get(), 1);
        assert_eq!(owner.ledger.seen_through(Lane::Normal).get(), 1);
        assert_eq!(owner.ledger.seen_through(Lane::Cleanup).get(), 0);
        assert_eq!(owner.executed, 1);
    }

    // Neither replay nor invoke can turn a deleted identity into new work.
    for path in [REPLAY, INVOKE] {
        let mut peer = client(&target, &wire(&target, path, &original));
        queued(&mut target, 1);
        target
            .resolve_control_requests(|auth, request| owner.resolve(auth, request))
            .unwrap();
        assert_status(&receive(&mut target, &mut peer), 503);
        assert_eq!(owner.ledger.usage(Lane::Normal).entries, 0);
        assert_eq!(owner.ledger.seen_through(Lane::Normal).get(), 1);
        assert_eq!(owner.executed, 1);
    }
}

#[test]
fn repeated_observations_use_http_budget_without_ledger_admission_or_revision_changes() {
    let mut target = surface();
    let mut owner = Owner::new();
    let before = serde_json::to_value(owner.coordinator.snapshot()).unwrap();
    let normal = owner.ledger.usage(Lane::Normal);
    let cleanup = owner.ledger.usage(Lane::Cleanup);
    for _ in 0..80 {
        let mut peer = client(&target, &wire(&target, OBSERVE, br#"{"version":"1.0"}"#));
        queued(&mut target, 1);
        assert!(matches!(
            target.pending_control_requests[0].request,
            WebControlRequest::Observe
        ));
        let accepted_at = target.pending_control_requests[0].accepted_at;
        target
            .resolve_control_requests(|auth, request| owner.resolve(auth, request))
            .unwrap();
        assert_eq!(target.pending_responses.len(), 1);
        assert_eq!(target.pending_responses[0].queued_at, accepted_at);
        let ResponseBody::Shared(bytes) = &target.pending_responses[0].body else {
            panic!("observation payload bypassed HTTP memory budget");
        };
        assert!(target
            .shared
            .lock()
            .unwrap()
            .retained_response_bytes
            .iter()
            .any(|entry| {
                entry.bytes.ptr_eq(&Arc::downgrade(bytes)) && entry.length == bytes.len()
            }));
        let response = receive(&mut target, &mut peer);
        assert_status(&response, 200);
        assert_eq!(response_json(&response), before);
    }
    assert_eq!(owner.executed, 0);
    assert_eq!(owner.ledger.usage(Lane::Normal), normal);
    assert_eq!(owner.ledger.usage(Lane::Cleanup), cleanup);
    assert_eq!(owner.ledger.seen_through(Lane::Normal), WireU64::new(0));
    assert_eq!(owner.ledger.seen_through(Lane::Cleanup), WireU64::new(0));
    assert_eq!(
        serde_json::to_value(owner.coordinator.snapshot()).unwrap(),
        before
    );
}

#[test]
fn observation_encoding_rejects_oversized_owner_projection_without_echo_or_ledger_charge() {
    let mut target = surface();
    let mut owner = Owner::new();
    let mut peer = client(&target, &wire(&target, OBSERVE, br#"{"version":"1.0"}"#));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|_, request| {
            assert!(matches!(request, WebControlRequest::Observe));
            let mut snapshot = owner.coordinator.snapshot();
            // An invalid adapter cannot force unbounded JSON encoding or expose
            // a partial projection. The typed response writer has a hard bound.
            snapshot.run_id = "oversized-observation".repeat(
                crate::browser_dev_control::MAX_CONTROL_FINAL_BYTES / "oversized-observation".len()
                    + 1,
            );
            WebControlResponse::Observation(Box::new(snapshot))
        })
        .unwrap();
    let response = receive(&mut target, &mut peer);
    assert_status(&response, 503);
    assert!(!String::from_utf8_lossy(&response).contains("oversized-observation"));
    assert_eq!(owner.executed, 0);
    assert_eq!(owner.ledger.usage(Lane::Normal).entries, 0);
    // A later valid observation still uses the same original owner.
    let mut peer = client(&target, &wire(&target, OBSERVE, br#"{"version":"1.0"}"#));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    assert_status(&receive(&mut target, &mut peer), 200);
}

#[test]
fn fragmented_control_headers_and_body_keep_the_original_allocation_and_acceptance_time() {
    let mut target = surface();
    let body = original(1);
    let full = wire(&target, INVOKE, &body);
    let body_start = find_bytes(&full, b"\r\n\r\n").unwrap() + 4;
    let mut peer = client(&target, &full[..20]);
    pump_until(&mut target, |surface| {
        surface.pending_requests.len() == 1 && surface.pending_requests[0].buffer.len() == 20
    });
    let accepted_at = target.pending_requests[0].accepted_at;
    peer.write_all(&full[20..body_start + 3]).unwrap();
    pump_until(&mut target, |surface| {
        surface.pending_requests.len() == 1
            && surface.pending_requests[0].buffer.len() == body_start + 3
    });
    assert!(target.pending_control_requests.is_empty());
    let body_pointer = target.pending_requests[0]
        .buffer
        .as_ptr()
        .wrapping_add(body_start);
    peer.write_all(&full[body_start + 3..]).unwrap();
    queued(&mut target, 1);
    assert_eq!(target.pending_control_requests[0].accepted_at, accepted_at);
    target
        .resolve_control_requests(|_, request| {
            let WebControlRequest::Invoke(retained) = request else {
                panic!("wrong endpoint");
            };
            assert_eq!(retained.bytes(), body);
            assert_eq!(retained.bytes().as_ptr(), body_pointer);
            WebControlResponse::Refused(ControlHttpError::Unavailable)
        })
        .unwrap();
    assert_eq!(target.pending_responses[0].queued_at, accepted_at);
    assert_status(&receive(&mut target, &mut peer), 503);
}

#[test]
fn malformed_or_unauthenticated_control_is_rejected_before_waiting_for_a_body() {
    let mut target = surface();
    let source = String::from_utf8(wire(&target, INVOKE, b"{}")).unwrap();
    let header_only = source[..source.len() - 2].to_owned();
    let cases = [
        (
            header_only
                .replace(SECRET, "wrong-secret")
                .replace("Content-Length: 2", "Content-Length: 9000"),
            403,
        ),
        (
            header_only.replace(
                "Content-Length: 2",
                &format!("Content-Length: {}", MAX_CONTROL_REQUEST_BYTES + 1),
            ),
            413,
        ),
        (
            header_only.replace("Content-Length: 2", "Content-Length: +2"),
            400,
        ),
        (
            header_only.replace(
                "Content-Length: 2",
                "Content-Length: 2\r\ncontent-length: 2",
            ),
            400,
        ),
        (
            header_only.replace(
                "Content-Length: 2",
                "Content-Length: 2\r\nHost: other.invalid",
            ),
            400,
        ),
        (
            header_only.replace(
                "Content-Length: 2",
                "Content-Length: 2\r\nTransfer-Encoding: chunked",
            ),
            400,
        ),
        (
            header_only.replace(
                "Content-Length: 2",
                "Content-Length: 2\r\nExpect: 100-continue",
            ),
            400,
        ),
        (header_only.replacen("POST ", "OPTIONS ", 1), 405),
        (
            header_only.replace(INVOKE, "/__weapp/control/invoke?x=1"),
            400,
        ),
        (
            header_only.replace(INVOKE, "/__weapp/%63ontrol/invoke"),
            400,
        ),
        (header_only.replace(INVOKE, "/__weapp/control/unknown"), 404),
        (source.clone() + "x", 400),
    ];
    for (request, status) in cases {
        let mut peer = client(&target, request.as_bytes());
        assert_status(&receive(&mut target, &mut peer), status);
        assert!(target.pending_control_requests.is_empty());
        assert!(target.pending_resource_requests.is_empty());
        assert_eq!(
            target
                .resolve_control_requests(|_, _| panic!("rejected request reached owner"))
                .unwrap(),
            0
        );
    }
}

#[test]
fn reserved_control_namespace_never_acquires_legacy_options_or_wildcard_cors() {
    for resource_only in [false, true] {
        let mut target = if resource_only {
            resource_surface()
        } else {
            WebSurface::localhost(0).unwrap()
        };
        for line in [
            "OPTIONS /__weapp/control/invoke HTTP/1.1",
            "OPTIONS /__weapp/%63ontrol/invoke HTTP/1.1",
            "OPTIONS /__weapp/unknown HTTP/1.1",
            "OPTIONS http://127.0.0.1/__weapp/control/invoke HTTP/1.1",
            "OPTIONS /__weapp/control/invoke HTTP/1.1 ignored",
            "OPTIONS  /__weapp/control/invoke HTTP/1.1",
        ] {
            let mut peer = client(
                &target,
                format!("{line}\r\nHost: ignored\r\n\r\n").as_bytes(),
            );
            assert_status(&receive(&mut target, &mut peer), 403);
            assert!(target.pending_control_requests.is_empty());
            assert!(target.pending_resource_requests.is_empty());
            assert!(target.clients.is_empty());
        }
    }
}

#[test]
fn fragmented_resource_namespaces_still_enter_the_existing_get_owner_lane() {
    for enabled in [false, true] {
        for (namespace, path) in [
            (
                "/__weapp/runtime/",
                format!("/__weapp/runtime/{}/runtime/runtime.mjs", "a".repeat(64)),
            ),
            (
                "/__weapp/pack/",
                "/__weapp/pack/run-test/1/portable-pack/manifest.json".into(),
            ),
            (
                "/__weapp/site/",
                "/__weapp/site/run-test/1/site.json".into(),
            ),
        ] {
            let full = format!("GET {path} HTTP/1.1\r\nHost: localhost\r\n\r\n").into_bytes();
            for split in 1..=format!("GET {namespace}").len() {
                let mut target = if enabled {
                    surface()
                } else {
                    resource_surface()
                };
                let mut peer = client(&target, &full[..split]);
                pump_until(&mut target, |surface| {
                    surface.pending_requests.len() == 1
                        && surface.pending_requests[0].buffer.len() == split
                });
                assert!(
                    target.pending_responses.is_empty(),
                    "premature classification enabled={enabled} path={path} split={split}"
                );
                peer.write_all(&full[split..]).unwrap();
                pump_until(&mut target, |surface| {
                    surface.pending_resource_requests.len() == 1
                });
                assert!(target.pending_control_requests.is_empty());
                assert_eq!(
                    target
                        .resolve_resource_requests(|_| WebResourceResolution::NotFound)
                        .unwrap(),
                    1
                );
                assert_status(&receive(&mut target, &mut peer), 404);
            }
        }
    }
}

#[test]
fn owner_control_and_resource_work_make_wait_return_without_network_sleep() {
    let mut target = surface();
    let _control_peer = client(&target, &wire(&target, INVOKE, &original(1)));
    queued(&mut target, 1);
    let start = Instant::now();
    target.wait(Duration::from_millis(500)).unwrap();
    assert!(start.elapsed() < Duration::from_millis(100));
    let _resource_peer = client(
        &target,
        b"GET /__weapp/site/run-test/1/site.json HTTP/1.1\r\nHost: localhost\r\n\r\n",
    );
    pump_until(&mut target, |surface| {
        surface.pending_resource_requests.len() == 1
    });
    target
        .resolve_control_requests(|_, _| WebControlResponse::Refused(ControlHttpError::Unavailable))
        .unwrap();
    let start = Instant::now();
    target.wait(Duration::from_millis(500)).unwrap();
    assert!(start.elapsed() < Duration::from_millis(100));
}

// Obtain a real accepted socket without advancing any WebSurface phase.
// The test can then exercise the exact production decision with stable queue
// ownership, regardless of elapsed business deadlines or writable responses.
fn accepted_client(surface: &WebSurface, serial: u64, phase: &str) -> (TcpStream, TcpStream) {
    let peer = client(surface, &wire(surface, INVOKE, &original(serial)));
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match surface.listener.accept() {
            Ok((stream, _)) => return (peer, stream),
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
            Err(error) => panic!("{phase}: loopback accept failed: {error}"),
        }
        assert!(
            Instant::now() < deadline,
            "{phase}: listener did not accept peer {:?}; state={:?}",
            peer.local_addr(),
            surface.drain_status()
        );
        thread::yield_now();
    }
}

fn connection_count(surface: &WebSurface) -> usize {
    let status = surface.drain_status();
    status.reading
        + status.owner_resources
        + status.owner_controls
        + status.writing
        + status.event_streams
}

fn assert_direct_admission(
    surface: &mut WebSurface,
    stream: TcpStream,
    expected: bool,
    phase: &str,
) {
    let before = surface.drain_status();
    let occupied = connection_count(surface);
    let admitted = surface.admit_http_stream(stream).unwrap();
    assert_eq!(
        admitted,
        expected,
        "{phase}: occupied={occupied}, before={before:?}, after={:?}",
        surface.drain_status()
    );
    assert_eq!(
        connection_count(surface),
        occupied + usize::from(admitted),
        "{phase}: decision changed an unrelated queue; before={before:?}, after={:?}",
        surface.drain_status()
    );
    assert!(
        connection_count(surface) <= MAX_HTTP_CONNECTIONS,
        "{phase}: admission exceeded cap; state={:?}",
        surface.drain_status()
    );
}

fn queue_admitted_control(surface: &mut WebSurface, expected: usize, phase: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    // Only parse the admitted stream. Full poll would also expire unrelated
    // owners or flush writers, invalidating the capacity arranged by the test.
    while let Some(pending) = surface.pending_requests.pop() {
        if let Some(pending) = surface.process_control_request(pending).unwrap() {
            surface.pending_requests.push(pending);
            assert!(
                Instant::now() < deadline,
                "{phase}: admitted control did not parse; state={:?}",
                surface.drain_status()
            );
            thread::yield_now();
        }
    }
    assert_eq!(
        surface.pending_control_requests.len(),
        expected,
        "{phase}: state={:?}",
        surface.drain_status()
    );
}

fn assert_rejected_peer_closed(surface: &WebSurface, peer: &mut TcpStream, phase: &str) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        // No poll here: the rejected stream was dropped by the actual admit
        // decision; unrelated accepted occupants remain owned throughout.
        match peer.read(&mut [0_u8; 1]) {
            Ok(0) => return,
            Err(error) if is_client_disconnect(&error) => return,
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            outcome => panic!(
                "{phase}: rejected peer unexpectedly returned {outcome:?}; peer={:?}, state={:?}",
                peer.local_addr(),
                surface.drain_status()
            ),
        }
        assert!(
            Instant::now() < deadline,
            "{phase}: rejected peer did not close; peer={:?}, state={:?}",
            peer.local_addr(),
            surface.drain_status()
        );
        thread::yield_now();
    }
}

#[test]
fn owner_controls_and_pending_writes_count_toward_the_original_64_connection_cap() {
    let mut target = surface();
    let mut peers = Vec::new();
    for index in 0..MAX_HTTP_CONNECTIONS {
        let (peer, stream) = accepted_client(&target, index as u64 + 1, "fill-owner");
        assert_direct_admission(&mut target, stream, true, "fill-owner");
        queue_admitted_control(&mut target, index + 1, "fill-owner");
        peers.push(peer);
    }
    let status = target.drain_status();
    assert_eq!(status.owner_controls, MAX_HTTP_CONNECTIONS);
    assert_eq!(status.reading, 0);
    assert_eq!(
        status.control_request_reserved_bytes,
        MAX_HTTP_CONNECTIONS * 4 * control::MAX_CONTROL_WIRE_BYTES
    );
    let (mut excess, stream) = accepted_client(&target, 100, "owner-cap");
    assert_direct_admission(&mut target, stream, false, "owner-cap");
    assert_rejected_peer_closed(&target, &mut excess, "owner-cap");
    assert_eq!(target.drain_status().owner_controls, MAX_HTTP_CONNECTIONS);

    // Release one actual owner socket, then prove that exact slot is reusable.
    drop(target.pending_control_requests.pop_front().unwrap());
    let (peer, stream) = accepted_client(&target, 101, "owner-reuse");
    assert_direct_admission(&mut target, stream, true, "owner-reuse");
    queue_admitted_control(&mut target, MAX_HTTP_CONNECTIONS, "owner-reuse");
    peers.push(peer);

    // Move the same real sockets into the shared response queue used by owner
    // control replies, retaining original acceptance times. No resolver,
    // expiration or flush runs: deadlines have their own tests below.
    while let Some(pending) = target.pending_control_requests.pop_front() {
        let bytes = Arc::new(encode_response_header(503, "application/json", 0));
        target
            .queue_shared_response_bytes_at(&pending.stream, bytes, pending.accepted_at)
            .unwrap();
    }
    assert_eq!(target.drain_status().writing, MAX_HTTP_CONNECTIONS);
    assert_eq!(target.drain_status().control_request_reserved_bytes, 0);
    let (mut excess_write, stream) = accepted_client(&target, 102, "writing-cap");
    assert_direct_admission(&mut target, stream, false, "writing-cap");
    assert_rejected_peer_closed(&target, &mut excess_write, "writing-cap");
    assert!(target.pending_control_requests.is_empty());

    drop(target.pending_responses.remove(0));
    let (peer, stream) = accepted_client(&target, 103, "writing-reuse");
    assert_direct_admission(&mut target, stream, true, "writing-reuse");
    queue_admitted_control(&mut target, 1, "writing-reuse");
    peers.push(peer);
    assert_eq!(target.drain_status().writing, MAX_HTTP_CONNECTIONS - 1);
    assert_eq!(connection_count(&target), MAX_HTTP_CONNECTIONS);
    drop(target);
    drop(peers);
}

#[test]
fn full_poll_admits_resolves_and_reclaims_actual_control_sockets() {
    let mut target = surface();
    let mut peers = (1..=3)
        .map(|serial| client(&target, &wire(&target, INVOKE, &original(serial))))
        .collect::<Vec<_>>();
    let mut responses = vec![Vec::new(); peers.len()];
    let mut closed = vec![false; peers.len()];
    let mut admitted = 0;
    let mut resolved = 0;
    let deadline = Instant::now() + Duration::from_secs(2);
    while closed.iter().any(|closed| !closed) {
        // The complete public pump may retire old work before accepting new
        // sockets. Resolve every actual admission instead of assuming a peer
        // was rejected from a status snapshot made before that pump.
        admitted += target.poll().unwrap();
        assert!(connection_count(&target) <= MAX_HTTP_CONNECTIONS, "full-poll before resolve: admitted={admitted}, resolved={resolved}, closed={closed:?}, state={:?}", target.drain_status());
        resolved += target
            .resolve_control_requests(|_, _| {
                WebControlResponse::Refused(ControlHttpError::Unavailable)
            })
            .unwrap();
        assert!(connection_count(&target) <= MAX_HTTP_CONNECTIONS, "full-poll after resolve: admitted={admitted}, resolved={resolved}, closed={closed:?}, state={:?}", target.drain_status());
        for (index, peer) in peers.iter_mut().enumerate() {
            if closed[index] {
                continue;
            }
            let mut chunk = [0_u8; 4096];
            match peer.read(&mut chunk) {
                Ok(0) => closed[index] = true,
                Ok(length) => responses[index].extend_from_slice(&chunk[..length]),
                Err(error) if error.kind() == ErrorKind::WouldBlock => {}
                Err(error) => panic!("full-poll peer {index}: read failed {error}; admitted={admitted}, resolved={resolved}, state={:?}", target.drain_status()),
            }
        }
        if closed.iter().any(|closed| !closed) {
            assert!(Instant::now() < deadline, "full-poll: response did not close; admitted={admitted}, resolved={resolved}, closed={closed:?}, responseBytes={:?}, state={:?}", responses.iter().map(Vec::len).collect::<Vec<_>>(), target.drain_status());
            thread::yield_now();
        }
    }
    assert_eq!(admitted, peers.len());
    assert_eq!(resolved, admitted);
    for response in responses {
        assert_status(&response, 503);
    }
    assert_eq!(connection_count(&target), 0);
    drop(target);
    drop(peers);
}

#[test]
fn original_acceptance_deadlines_expire_partial_and_owner_pending_work_without_resolution() {
    let mut target = surface();
    let full = wire(&target, INVOKE, &original(1));
    let mut partial = client(&target, &full[..25]);
    pump_until(&mut target, |surface| surface.pending_requests.len() == 1);
    target.pending_requests[0].accepted_at = Instant::now() - HTTP_DEADLINE;
    target.poll().unwrap();
    assert!(target.pending_requests.is_empty());
    assert!(receive(&mut target, &mut partial).is_empty());

    let mut complete = client(&target, &full);
    queued(&mut target, 1);
    target.pending_control_requests[0].accepted_at = Instant::now() - HTTP_DEADLINE;
    assert_eq!(
        target
            .resolve_control_requests(|_, _| panic!("expired owner request executed"))
            .unwrap(),
        0
    );
    assert!(target.pending_responses.is_empty());
    assert!(receive(&mut target, &mut complete).is_empty());
}

#[test]
fn real_ledger_final_is_one_original_pending_borrow_and_expiry_releases_ack_barrier() {
    let mut target = surface();
    let mut owner = Owner::new();
    let original = original(1);
    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);
    let accepted_at = target.pending_control_requests[0].accepted_at;
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    assert_eq!(owner.executed, 1);
    assert_eq!(target.pending_responses[0].queued_at, accepted_at);
    let (weak, digest) = {
        let ResponseBody::Control(bytes) = &target.pending_responses[0].body else {
            panic!("final copied or reencoded");
        };
        assert_eq!(
            Some((
                Arc::as_ptr(bytes) as usize,
                bytes.as_slice().as_ptr() as usize
            )),
            owner.final_pointer
        );
        assert_eq!(
            Arc::strong_count(bytes),
            2,
            "only original ledger and this response borrow"
        );
        let weak = Arc::downgrade(bytes);
        assert!(
            !target
                .shared
                .lock()
                .unwrap()
                .retained_response_bytes
                .iter()
                .any(|entry| entry.bytes.ptr_eq(&weak)),
            "final must not gain a second transport byte charge"
        );
        (weak, format!("{:x}", Sha256::digest(bytes.as_slice())))
    };
    let usage = owner.ledger.usage(Lane::Normal);
    assert_eq!(
        owner.ledger.acknowledge_final(RUN, &original, &digest),
        Err(ControlError::Capacity)
    );
    assert_eq!(owner.ledger.usage(Lane::Normal), usage);
    target.pending_responses[0].queued_at = Instant::now() - HTTP_DEADLINE;
    target.flush_responses();
    assert!(target.pending_responses.is_empty());
    assert_eq!(weak.strong_count(), 1);
    assert!(receive(&mut target, &mut peer).is_empty());

    for expected in ["compacted", "already-compacted"] {
        let body = serde_json::to_vec(&json!({"version":"1.0", "originalRequest":std::str::from_utf8(&original).unwrap(), "finalSha256":digest})).unwrap();
        let mut ack_peer = client(&target, &wire(&target, ACK, &body));
        queued(&mut target, 1);
        target
            .resolve_control_requests(|auth, request| owner.resolve(auth, request))
            .unwrap();
        let response = receive(&mut target, &mut ack_peer);
        assert_status(&response, 200);
        assert_eq!(response_json(&response)["outcome"], expected);
    }
    assert_eq!(weak.strong_count(), 0);
    assert_eq!(owner.executed, 1);
}

#[test]
fn dropping_the_exact_surface_releases_its_original_ledger_body_borrow() {
    let mut target = surface();
    let handle = target.handle();
    let mut owner = Owner::new();
    let original = original(1);
    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    let (weak, digest) = {
        let ResponseBody::Control(bytes) = &target.pending_responses[0].body else {
            panic!("not the original control final");
        };
        assert_eq!(Arc::strong_count(bytes), 2);
        (
            Arc::downgrade(bytes),
            format!("{:x}", Sha256::digest(bytes.as_slice())),
        )
    };
    assert_eq!(
        owner.ledger.acknowledge_final(RUN, &original, &digest),
        Err(ControlError::Capacity)
    );

    drop(target);
    // Keep Shared alive and usable throughout both the socket and ledger
    // assertions. No pending socket/body is allowed to hide in this handle.
    handle.set_state_json(json!({"status":"surface-dropped"}));
    assert_eq!(handle.state()["status"], "surface-dropped");
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(1))).unwrap();
    assert_eq!(peer.read(&mut [0_u8; 1]).unwrap(), 0);
    assert_eq!(weak.strong_count(), 1);
    assert_eq!(
        owner
            .ledger
            .acknowledge_final(RUN, &original, &digest)
            .unwrap(),
        FinalAckOutcome::Compacted
    );
    assert_eq!(weak.strong_count(), 0);
    handle.set_state_json(json!({"status":"compacted-with-handle-alive"}));
    assert_eq!(handle.state()["status"], "compacted-with-handle-alive");
}

#[test]
fn stop_admission_reports_only_accepted_socket_drain_and_drop_releases_the_listener() {
    let mut target = surface();
    let address = target.local_addr();
    assert!(!target.drain_status().is_drained());
    target.stop_admission();
    assert!(!target.drain_status().accepting);
    assert!(target.drain_status().is_drained());
    assert_eq!(
        TcpListener::bind(address).unwrap_err().kind(),
        ErrorKind::AddrInUse
    );
    // TCP may still connect into the bound OS listener backlog; it is not an
    // accepted/served socket and does not turn drain into a close receipt.
    let peer = TcpStream::connect(address).unwrap();
    assert_eq!(target.poll().unwrap(), 0);
    assert!(target.drain_status().is_drained());
    drop(peer);
    drop(target);
    let rebound = TcpListener::bind(address).unwrap();
    assert_eq!(rebound.local_addr().unwrap(), address);
}

#[test]
fn stop_admission_keeps_already_accepted_owner_work_and_its_original_deadline() {
    let mut target = surface();
    let mut peer = client(&target, &wire(&target, INVOKE, &original(1)));
    queued(&mut target, 1);
    let accepted_at = target.pending_control_requests[0].accepted_at;
    target.stop_admission();
    let status = target.drain_status();
    assert!(!status.accepting);
    assert_eq!(status.owner_controls, 1);
    assert!(!status.is_drained());
    assert_eq!(
        target
            .resolve_control_requests(|auth, _| {
                assert_eq!(auth.run_id(), RUN, "latched identity must survive stop");
                WebControlResponse::Refused(ControlHttpError::Unavailable)
            })
            .unwrap(),
        1
    );
    assert_eq!(target.drain_status().writing, 1);
    assert!(!target.drain_status().is_drained());
    assert_eq!(target.pending_responses[0].queued_at, accepted_at);
    assert_status(&receive(&mut target, &mut peer), 503);
    assert!(target.drain_status().is_drained());
}

fn send_large_control_while_polling(target: &mut WebSurface, path: &str, body: &[u8]) -> TcpStream {
    let bytes = wire(target, path, body);
    let peer = TcpStream::connect(target.local_addr()).unwrap();
    peer.set_nodelay(true).unwrap();
    let mut writer = peer.try_clone().unwrap();
    thread::scope(|scope| {
        let job = scope.spawn(move || {
            writer
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            writer.write_all(&bytes)
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !job.is_finished() {
            target.poll().unwrap();
            assert!(Instant::now() < deadline, "large ACK writer did not finish");
            thread::yield_now();
        }
        job.join().unwrap().unwrap();
    });
    peer.set_nonblocking(true).unwrap();
    peer
}

#[test]
fn maximal_escaped_ack_reaches_owner_but_decoded_overlimit_ack_does_not() {
    let mut target = surface();
    let original = "\\".repeat(MAX_CONTROL_REQUEST_BYTES);
    let digest = "a".repeat(64);
    let body = serde_json::to_vec(&json!({
        "version":"1.0", "originalRequest":original, "finalSha256":digest,
    }))
    .unwrap();
    assert!(body.len() > MAX_CONTROL_REQUEST_BYTES);
    assert!(body.len() <= crate::web_control::MAX_CONTROL_ACK_BYTES);
    let mut peer = send_large_control_while_polling(&mut target, ACK, &body);
    queued(&mut target, 1);
    let mut calls = 0;
    assert_eq!(
        target
            .resolve_control_requests(|_, request| {
                calls += 1;
                let WebControlRequest::Acknowledge(ack) = request else {
                    panic!("not ACK");
                };
                assert_eq!(ack.original_request_bytes(), original.as_bytes());
                assert_eq!(ack.final_sha256(), digest);
                // This is only a framing/DTO-boundary proof. The string intentionally
                // is not a ledger command, and no ledger mutation is attempted.
                WebControlResponse::Refused(ControlHttpError::Unavailable)
            })
            .unwrap(),
        1
    );
    assert_eq!(calls, 1);
    assert_status(&receive(&mut target, &mut peer), 503);

    let oversized = "\\".repeat(MAX_CONTROL_REQUEST_BYTES + 1);
    let body = serde_json::to_vec(&json!({
        "version":"1.0", "originalRequest":oversized, "finalSha256":digest,
    }))
    .unwrap();
    // The outer wire still fits: rejection must come from the decoded bound,
    // not the independent ACK HTTP body ceiling.
    assert!(body.len() <= crate::web_control::MAX_CONTROL_ACK_BYTES);
    let mut peer = send_large_control_while_polling(&mut target, ACK, &body);
    assert_status(&receive(&mut target, &mut peer), 400);
    assert_eq!(
        target
            .resolve_control_requests(|_, _| panic!("decoded overlimit ACK reached owner"))
            .unwrap(),
        0
    );
}

#[test]
fn callback_crossing_the_original_deadline_drops_its_real_final_without_queueing() {
    let mut target = surface();
    let mut owner = Owner::new();
    let original = original(1);
    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);
    // Deliberate near-expiry injection avoids a five-second wall-clock sleep.
    // This does not fabricate a successful response or adjust the deadline
    // after callback work; production still tests the original accepted_at.
    let accepted_at = Instant::now() - (HTTP_DEADLINE - Duration::from_millis(200));
    target.pending_control_requests[0].accepted_at = accepted_at;
    let mut final_weak = None;
    let mut digest = None;
    let mut calls = 0;
    assert_eq!(
        target
            .resolve_control_requests(|auth, request| {
                calls += 1;
                assert!(
                    accepted_at.elapsed() < HTTP_DEADLINE,
                    "callback must start before expiry"
                );
                let response = owner.resolve(auth, request);
                let WebControlResponse::Final(bytes) = &response else {
                    panic!("not real final");
                };
                final_weak = Some(Arc::downgrade(bytes));
                digest = Some(format!("{:x}", Sha256::digest(bytes.as_slice())));
                assert_eq!(Arc::strong_count(bytes), 2);
                // Normally <=220ms, but always crosses this exact acceptance deadline.
                thread::sleep(
                    HTTP_DEADLINE.saturating_sub(accepted_at.elapsed()) + Duration::from_millis(20),
                );
                assert!(accepted_at.elapsed() >= HTTP_DEADLINE);
                response
            })
            .unwrap(),
        1
    );
    assert_eq!(calls, 1);
    assert_eq!(owner.executed, 1);
    assert!(
        target.pending_responses.is_empty(),
        "late final must never enter the writer queue"
    );
    let weak = final_weak.unwrap();
    assert_eq!(
        weak.strong_count(),
        1,
        "only original ledger retains the final"
    );
    assert!(receive(&mut target, &mut peer).is_empty());
    assert_eq!(
        owner
            .ledger
            .acknowledge_final(RUN, &original, digest.as_deref().unwrap())
            .unwrap(),
        FinalAckOutcome::Compacted
    );
    assert_eq!(weak.strong_count(), 0);
}

#[test]
fn actual_control_socket_disconnect_releases_final_borrow_and_isolates_the_next_client() {
    let mut target = surface();
    let handle = target.handle();
    handle.set_state_json(json!({"status":"kept-alive", "revision":7}));
    let mut owner = Owner::new();
    let original = original(1);
    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    let (weak, digest) = {
        let ResponseBody::Control(bytes) = &target.pending_responses[0].body else {
            panic!("not original final");
        };
        (
            Arc::downgrade(bytes),
            format!("{:x}", Sha256::digest(bytes.as_slice())),
        )
    };
    assert_eq!(
        owner.ledger.acknowledge_final(RUN, &original, &digest),
        Err(ControlError::Capacity)
    );

    // Send a genuine prefix from the pending production header, then abort
    // that exact client before the remaining header/body is written. This
    // creates deterministic partial delivery without depending on TCP buffer
    // size or fabricating the ledger's bounded final into a huge payload.
    let prefix_length = {
        let pending = &mut target.pending_responses[0];
        let header = pending.header.as_ref().unwrap();
        let written = pending.stream.write(&header[..16]).unwrap();
        assert!(written > 0);
        pending.header_offset = written;
        written
    };
    peer.set_nonblocking(false).unwrap();
    peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
    let mut prefix = vec![0_u8; prefix_length];
    peer.read_exact(&mut prefix).unwrap();
    assert!(b"HTTP/1.1 200 OK\r\n".starts_with(&prefix));
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let linger = nix::libc::linger {
            l_onoff: 1,
            l_linger: 0,
        };
        // The live owned fd and matching initialized linger value remain valid
        // for the duration of setsockopt. Drop sends a real TCP reset on Unix.
        let result = unsafe {
            nix::libc::setsockopt(
                peer.as_raw_fd(),
                nix::libc::SOL_SOCKET,
                nix::libc::SO_LINGER,
                (&linger as *const nix::libc::linger).cast(),
                std::mem::size_of_val(&linger) as nix::libc::socklen_t,
            )
        };
        assert_eq!(result, 0);
    }
    #[cfg(not(unix))]
    peer.shutdown(std::net::Shutdown::Both).unwrap();
    drop(peer);
    pump_until(&mut target, |surface| surface.pending_responses.is_empty());
    assert_eq!(weak.strong_count(), 1);
    assert_eq!(handle.state()["status"], "kept-alive");

    // The original owner, ledger, surface and publisher are all still alive.
    // A different real client can replay that exact original final; resetting
    // one connection must neither reexecute the command nor replace the owner.
    let mut next_peer = client(&target, &wire(&target, REPLAY, &original));
    queued(&mut target, 1);
    target
        .resolve_control_requests(|auth, request| owner.resolve(auth, request))
        .unwrap();
    let response = receive(&mut target, &mut next_peer);
    assert_status(&response, 200);
    let body_start = find_bytes(&response, b"\r\n\r\n").unwrap() + 4;
    assert_eq!(
        format!("{:x}", Sha256::digest(&response[body_start..])),
        digest
    );
    assert_eq!(owner.executed, 1);
    assert_eq!(weak.strong_count(), 1);
    assert_eq!(handle.state()["status"], "kept-alive");
    assert_eq!(
        owner
            .ledger
            .acknowledge_final(RUN, &original, &digest)
            .unwrap(),
        FinalAckOutcome::Compacted
    );
    assert_eq!(weak.strong_count(), 0);
}

#[test]
fn completed_invoke_and_replay_release_original_final_before_direct_ack() {
    let mut target = surface();
    let mut owner = Owner::new();
    let original = original(1);
    let mut completed: Option<(Weak<Vec<u8>>, String)> = None;

    // Do not compact between the two complete HTTP transfers: replay must read
    // the same still-retained original ledger final, without executing again.
    for path in [INVOKE, REPLAY] {
        let mut peer = client(&target, &wire(&target, path, &original));
        queued(&mut target, 1);
        assert_eq!(
            target
                .resolve_control_requests(|auth, request| owner.resolve(auth, request))
                .unwrap(),
            1
        );
        let (weak, digest) = {
            let ResponseBody::Control(bytes) = &target.pending_responses[0].body else {
                panic!("not the original control final");
            };
            assert_eq!(Arc::strong_count(bytes), 2);
            (
                Arc::downgrade(bytes),
                format!("{:x}", Sha256::digest(bytes.as_slice())),
            )
        };
        if let Some((first, first_digest)) = &completed {
            assert!(
                weak.ptr_eq(first),
                "replay must borrow the original final Arc"
            );
            assert_eq!(&digest, first_digest);
        }
        assert_eq!(
            owner.ledger.acknowledge_final(RUN, &original, &digest),
            Err(ControlError::Capacity),
            "the actual queued HTTP response still owns its final borrower"
        );

        assert_status(&receive(&mut target, &mut peer), 200);
        assert!(target.pending_responses.is_empty());
        assert_eq!(
            weak.strong_count(),
            1,
            "a complete write must release the response, leaving only the ledger"
        );
        completed = Some((weak, digest));
    }

    assert_eq!(owner.executed, 1);
    let (weak, digest) = completed.expect("both transfers completed");
    assert_eq!(
        owner
            .ledger
            .acknowledge_final(RUN, &original, &digest)
            .unwrap(),
        FinalAckOutcome::Compacted
    );
    assert_eq!(weak.strong_count(), 0);
}

#[test]
fn exhausted_header_budget_releases_original_final_without_implicit_ack() {
    let mut target = surface();
    let mut owner = Owner::new();
    let original = original(1);
    let mut peer = client(&target, &wire(&target, INVOKE, &original));
    queued(&mut target, 1);

    // Fill the original shared HTTP/frame byte budget with a real allocation.
    // Neither the final header nor a bounded refusal can fit while it is held.
    let retained = Arc::new(vec![0_u8; MAX_FRAME_CACHE_BYTES]);
    target.shared.lock().unwrap().track_response(&retained);
    let mut returned_final = None;
    assert_eq!(
        target
            .resolve_control_requests(|auth, request| {
                let response = owner.resolve(auth, request);
                let WebControlResponse::Final(bytes) = &response else {
                    panic!("owner must return its original final");
                };
                assert_eq!(Arc::strong_count(bytes), 2);
                returned_final = Some((
                    Arc::downgrade(bytes),
                    format!("{:x}", Sha256::digest(bytes.as_slice())),
                ));
                response
            })
            .unwrap(),
        1
    );
    assert_eq!(owner.executed, 1);
    assert!(target.pending_control_requests.is_empty());
    assert!(target.pending_responses.is_empty());
    let (weak, digest) = returned_final.expect("original final returned by owner");
    assert_eq!(
        weak.strong_count(),
        1,
        "header-budget rejection must release the actual response borrower"
    );
    assert!(
        !target
            .shared
            .lock()
            .unwrap()
            .retained_response_bytes
            .iter()
            .any(|entry| entry.bytes.ptr_eq(&weak)),
        "the rejected final must not acquire another HTTP payload charge"
    );
    assert!(receive(&mut target, &mut peer).is_empty());
    assert_eq!(weak.strong_count(), 1, "the ledger still retains its final");
    assert_eq!(
        owner
            .ledger
            .acknowledge_final(RUN, &original, &digest)
            .unwrap(),
        FinalAckOutcome::Compacted,
        "budget refusal must not have acknowledged or compacted implicitly"
    );
    assert_eq!(weak.strong_count(), 0);
    drop(retained);
}
