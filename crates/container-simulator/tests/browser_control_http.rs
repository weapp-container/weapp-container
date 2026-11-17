//! Opt-in REAL TCP + Node transport + original Rust ControlLedger test.
//! This private listener is an isolated test harness, not WebSurface or a new
//! production route/authentication owner. Coordinator snapshot/stop are actual;
//! no Worker, success close stub, browser, presenter, GPU or stage is constructed.
//! All I/O runs on this test thread. The only child is the explicitly selected
//! Node executable; its exact handle is reaped on every exit path.

use container_simulator::browser_dev_control::{
    ControlError, ControlLedger, ControlLimits, ControlLookup, ControlOperation, ControlResult,
    ErrorFact, FinalAckOutcome, FinalDraft, FinalOutcome, Lane,
};
use container_simulator::browser_dev_coordinator::{
    BrowserDevCoordinator, RuntimePins, StartupIntentPin, WireU64,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Output, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const RUN: &str = "run-test";
const CLIENT: &str = "client-test";
const WIRE_LIMIT: usize = 160 * 1024;
const CONNECTION_LIMIT: usize = 16;
const SOCKET_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Default, Debug)]
struct Audit {
    denied: usize,
    executed: usize,
    dropped_final: usize,
    dropped_ack: usize,
    same_pointer_replays: usize,
    borrower_blocked: usize,
    hash_mismatch: usize,
    compacted: usize,
    already_compacted: usize,
    held_released: usize,
    tombstone_replay: usize,
    // Metadata only: no additional Arc, copied payload or body cache.
    finals: BTreeMap<String, (usize, usize, String)>,
}

enum Body {
    Small(Vec<u8>),
    OriginalFinal(Arc<Vec<u8>>),
}
impl Body {
    fn bytes(&self) -> &[u8] {
        match self {
            Self::Small(bytes) => bytes,
            Self::OriginalFinal(bytes) => bytes.as_slice(),
        }
    }
}
struct Incoming {
    stream: TcpStream,
    bytes: Vec<u8>,
    accepted: Instant,
}
struct Outgoing {
    stream: TcpStream,
    header: Vec<u8>,
    header_offset: usize,
    body: Body,
    offset: usize,
    held: bool,
    accepted: Instant,
}
struct Request {
    path: String,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Acknowledgement {
    version: String,
    original_request: String,
    final_sha256: String,
}
struct Harness {
    listener: TcpListener,
    address: SocketAddr,
    secret: String,
    incoming: Vec<Incoming>,
    outgoing: Vec<Outgoing>,
    ledger: ControlLedger,
    coordinator: BrowserDevCoordinator,
    audit: Audit,
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn request(bytes: &[u8]) -> Result<Option<Request>, String> {
    let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") else {
        return if bytes.len() > 16 * 1024 {
            Err("header limit".into())
        } else {
            Ok(None)
        };
    };
    if end > 16 * 1024 {
        return Err("header limit".into());
    }
    let header = std::str::from_utf8(&bytes[..end]).map_err(text)?;
    let mut lines = header.split("\r\n");
    let first: Vec<_> = lines.next().unwrap_or_default().split(' ').collect();
    if first.len() != 3 || first[0] != "POST" || first[2] != "HTTP/1.1" {
        return Err("test endpoint requires exact POST/HTTP1.1".into());
    }
    let mut headers = BTreeMap::new();
    for line in lines {
        let (name, value) = line.split_once(':').ok_or("invalid header")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || headers
                .insert(name.to_ascii_lowercase(), value.trim().to_owned())
                .is_some()
        {
            return Err("invalid or duplicate header".into());
        }
    }
    if headers.contains_key("transfer-encoding") {
        return Err("transfer encoding refused".into());
    }
    let length = headers
        .get("content-length")
        .ok_or("content length required")?;
    let size: usize = length.parse().map_err(text)?;
    if size.to_string() != *length || size > 132 * 1024 {
        return Err("bounded canonical content length required".into());
    }
    let total = end + 4 + size;
    if bytes.len() < total {
        return Ok(None);
    }
    if bytes.len() != total {
        return Err("trailing request bytes refused".into());
    }
    Ok(Some(Request {
        path: first[1].to_owned(),
        headers,
        body: bytes[end + 4..].to_vec(),
    }))
}

impl Harness {
    fn new() -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(text)?;
        listener.set_nonblocking(true).map_err(text)?;
        let address = listener.local_addr().map_err(text)?;
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(text)?
            .as_nanos();
        // Explicit isolated test context, NOT a production credential source.
        let secret = format!("isolated-{}-{nonce}", std::process::id());
        let coordinator = BrowserDevCoordinator::new(
            RUN.into(),
            // Shape-only fixture pins: no claim that these name real artifacts.
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
        .map_err(text)?;
        Ok(Self {
            listener,
            address,
            secret,
            incoming: Vec::new(),
            outgoing: Vec::new(),
            ledger: ControlLedger::new(RUN.into(), CLIENT.into(), ControlLimits::default())
                .map_err(text)?,
            coordinator,
            audit: Audit::default(),
        })
    }
    fn reply(
        &mut self,
        request: Incoming,
        status: u16,
        body: Body,
        held: bool,
        hash: Option<&str>,
    ) {
        let extra = hash.map_or_else(String::new, |hash| {
            format!("X-Weapp-Test-Final-Sha256: {hash}\r\n")
        });
        let header = format!("HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n{extra}\r\n", body.bytes().len()).into_bytes();
        self.outgoing.push(Outgoing {
            stream: request.stream,
            header,
            header_offset: 0,
            body,
            offset: 0,
            held,
            accepted: request.accepted,
        });
    }
    fn small(&mut self, request: Incoming, status: u16, value: Value) -> Result<(), String> {
        self.reply(
            request,
            status,
            Body::Small(serde_json::to_vec(&value).map_err(text)?),
            false,
            None,
        );
        Ok(())
    }
    fn route(&mut self, socket: Incoming, request: Request) -> Result<(), String> {
        let header = |name: &str| request.headers.get(name).map(String::as_str);
        let origin = format!("http://{}", self.address);
        let host = self.address.to_string();
        if header("host") != Some(host.as_str())
            || header("origin") != Some(origin.as_str())
            || header("content-type") != Some("application/json")
            || header("x-weapp-run-id") != Some(RUN)
            || header("x-weapp-client-id") != Some(CLIENT)
            || header("x-weapp-dev-secret") != Some(self.secret.as_str())
        {
            self.audit.denied += 1;
            return self.small(socket, 403, json!({"reason":"wrong-isolated-auth"}));
        }
        if request.path == "/__test/release-held" {
            let before = self.outgoing.len();
            self.outgoing.retain(|response| !response.held);
            let released = before - self.outgoing.len();
            self.audit.held_released += released;
            return self.small(socket, 200, json!({"released":released}));
        }
        if request.path == "/__weapp/control/acknowledge" {
            let ack: Acknowledgement = serde_json::from_slice(&request.body).map_err(text)?;
            if ack.version != "1.0" {
                return self.small(socket, 400, json!({"reason":"version"}));
            }
            // Deliberately NO lookup first: that would add a Final Arc borrower.
            let outcome = self.ledger.acknowledge_final(
                RUN,
                ack.original_request.as_bytes(),
                &ack.final_sha256,
            );
            return match outcome {
                Ok(outcome) => {
                    match outcome {
                        FinalAckOutcome::Compacted => self.audit.compacted += 1,
                        FinalAckOutcome::AlreadyCompacted => self.audit.already_compacted += 1,
                    }
                    if header("x-weapp-test-drop-ack") == Some("1") {
                        self.audit.dropped_ack += 1;
                        return Ok(()); // Actual socket closes AFTER compaction.
                    }
                    let original: Value =
                        serde_json::from_str(&ack.original_request).map_err(text)?;
                    self.small(
                        socket,
                        200,
                        json!({"version":"1.0","requestId":original["requestId"],
                        "finalSha256":ack.final_sha256,"outcome":outcome}),
                    )
                }
                Err(ControlError::Capacity) => {
                    self.audit.borrower_blocked += 1;
                    self.small(socket, 409, json!({"reason":"original-body-borrowed"}))
                }
                Err(ControlError::AckMismatch) => {
                    self.audit.hash_mismatch += 1;
                    self.small(socket, 409, json!({"reason":"ack-mismatch"}))
                }
                Err(error) => Err(format!("unexpected actual ACK error: {error}")),
            };
        }
        let mut lookup = match request.path.as_str() {
            "/__weapp/control/invoke" => self.ledger.admit(RUN, &request.body),
            "/__weapp/control/replay" => self.ledger.lookup(RUN, &request.body),
            _ => return self.small(socket, 404, json!({"reason":"test-route-not-found"})),
        }
        .map_err(text)?;
        if let ControlLookup::Queued(queued) = lookup {
            // A replay must never decode or execute even if a queued state exists.
            if request.path.ends_with("/replay") {
                return Err("replay tried to execute a queued operation".into());
            }
            let begun = self.ledger.begin(&queued.identity).map_err(text)?;
            self.audit.executed += 1;
            let result = match begun.operation {
                ControlOperation::Snapshot(_) => FinalOutcome::Ok(Box::new(
                    ControlResult::Snapshot(Box::new(self.coordinator.snapshot())),
                )),
                ControlOperation::Stop(_) => FinalOutcome::Ok(Box::new(ControlResult::Stop(
                    self.coordinator.stop().map_err(text)?,
                ))),
                _ => FinalOutcome::Error(
                    ErrorFact::new(
                        "ERR_UNSUPPORTED_CAPABILITY",
                        "isolated harness executes snapshot/stop only",
                    )
                    .map_err(text)?,
                ),
            };
            lookup = ControlLookup::Final(
                self.ledger
                    .finish(
                        &begun.ticket,
                        FinalDraft {
                            snapshot: self.coordinator.snapshot(),
                            outcome: result,
                        },
                    )
                    .map_err(text)?,
            );
        }
        match lookup {
            ControlLookup::Final(bytes) => {
                let identity: Value = serde_json::from_slice(&request.body).map_err(text)?;
                let id = identity["requestId"]
                    .as_str()
                    .ok_or("request identity")?
                    .to_owned();
                let hash = container_ir::hex_digest(bytes.as_slice());
                let metadata = (bytes.as_ptr() as usize, bytes.len(), hash.clone());
                if let Some(original) = self.audit.finals.get(&id) {
                    if original != &metadata {
                        return Err("final replay was copied or changed raw bytes".into());
                    }
                    self.audit.same_pointer_replays += 1;
                } else {
                    self.audit.finals.insert(id, metadata);
                }
                if Arc::strong_count(&bytes) != 2 {
                    return Err("unexpected final borrower before actual socket ownership".into());
                }
                if header("x-weapp-test-drop-final") == Some("1") {
                    self.audit.dropped_final += 1;
                    return Ok(()); // Ledger retains its ORIGINAL final.
                }
                // Move, never clone/reencode the ledger's actual final body.
                self.reply(
                    socket,
                    200,
                    Body::OriginalFinal(bytes),
                    header("x-weapp-test-hold-body") == Some("1"),
                    Some(&hash),
                );
                Ok(())
            }
            ControlLookup::Tombstone(_) => {
                self.audit.tombstone_replay += 1;
                self.small(socket, 410, json!({"reason":"retained-final-compacted"}))
            }
            _ => Err("isolated synchronous lane did not produce a final".into()),
        }
    }
    fn poll(&mut self) -> Result<(), String> {
        loop {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if self.incoming.len() + self.outgoing.len() >= CONNECTION_LIMIT {
                        drop(stream);
                        continue;
                    }
                    stream.set_nonblocking(true).map_err(text)?;
                    stream.set_nodelay(true).map_err(text)?;
                    self.incoming.push(Incoming {
                        stream,
                        bytes: Vec::new(),
                        accepted: Instant::now(),
                    });
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) => return Err(text(error)),
            }
        }
        for mut socket in std::mem::take(&mut self.incoming) {
            if socket.accepted.elapsed() >= SOCKET_DEADLINE {
                continue;
            }
            let mut disconnected = false;
            loop {
                let mut chunk = [0; 8192];
                match socket.stream.read(&mut chunk) {
                    Ok(0) => {
                        disconnected = true;
                        break;
                    }
                    Ok(size) => {
                        socket.bytes.extend_from_slice(&chunk[..size]);
                        if socket.bytes.len() > WIRE_LIMIT {
                            return Err("isolated wire limit".into());
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => {
                        disconnected = true;
                        break;
                    }
                }
            }
            match request(&socket.bytes)? {
                Some(request) => self.route(socket, request)?,
                None if !disconnected => self.incoming.push(socket),
                None => {}
            }
        }
        for mut response in std::mem::take(&mut self.outgoing) {
            if response.accepted.elapsed() >= SOCKET_DEADLINE {
                continue;
            }
            let mut connected = true;
            for _ in 0..4 {
                let header = response.header_offset < response.header.len();
                let (bytes, offset) = if header {
                    (response.header.as_slice(), response.header_offset)
                } else {
                    (response.body.bytes(), response.offset)
                };
                let end = if !header && response.held {
                    bytes.len().min(1)
                } else {
                    bytes.len()
                };
                if offset >= end {
                    break;
                }
                match response.stream.write(&bytes[offset..end]) {
                    Ok(0) => {
                        connected = false;
                        break;
                    }
                    Ok(size) => {
                        if header {
                            response.header_offset += size;
                        } else {
                            response.offset += size;
                        }
                    }
                    Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                    Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => {
                        connected = false;
                        break;
                    }
                }
            }
            if connected
                && (response.header_offset < response.header.len()
                    || response.offset < response.body.bytes().len())
            {
                self.outgoing.push(response);
            }
        }
        Ok(())
    }
    fn assert_audit(&self) -> Result<(), String> {
        let a = &self.audit;
        if a.denied != 3
            || a.executed != 2
            || a.dropped_final != 1
            || a.dropped_ack != 1
            || a.same_pointer_replays != 2
            || a.borrower_blocked != 1
            || a.hash_mismatch != 1
            || a.compacted != 2
            || a.already_compacted != 2
            || a.held_released != 1
            || a.tombstone_replay != 1
        {
            return Err(format!("unexpected actual Rust audit: {a:?}"));
        }
        let snapshot = self.coordinator.snapshot();
        if !snapshot.stopped
            || snapshot.owner_key.is_some()
            || snapshot.runtime_ready.is_some()
            || snapshot.presented_ready.is_some()
            || self.ledger.usage(Lane::Normal).entries != 1
            || self.ledger.usage(Lane::Cleanup).entries != 1
            || !self.incoming.is_empty()
            || !self.outgoing.is_empty()
        {
            return Err(
                "actual coordinator/ledger/socket ownership did not reach expected final state"
                    .into(),
            );
        }
        Ok(())
    }
}

struct OwnedNode(Option<Child>);
impl OwnedNode {
    fn output(&mut self) -> Result<Output, String> {
        self.0
            .take()
            .ok_or("Node handle was already reaped")?
            .wait_with_output()
            .map_err(text)
    }
    fn terminate(&mut self) -> Result<(), String> {
        let Some(child) = self.0.as_mut() else {
            return Ok(());
        };
        if child.try_wait().map_err(text)?.is_none() {
            child.kill().map_err(text)?;
        }
        child.wait().map_err(text)?;
        self.0 = None;
        Ok(())
    }
}
impl Drop for OwnedNode {
    fn drop(&mut self) {
        if let Err(error) = self.terminate() {
            eprintln!("isolated Node exact-handle cleanup failed: {error}");
        }
    }
}

fn run() -> Result<(), String> {
    let node = std::env::var_os("NODE_BIN").ok_or("opt-in test requires explicit NODE_BIN")?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut harness = Harness::new()?;
    let child = Command::new(node)
        .arg(root.join("scripts/browser-control-http-ledger-client.mjs"))
        .current_dir(&root)
        .env(
            "WEAPP_TEST_CONTROL_URL",
            format!("http://{}/", harness.address),
        )
        .env("WEAPP_TEST_CONTROL_RUN", RUN)
        .env("WEAPP_TEST_CONTROL_CLIENT", CLIENT)
        .env("WEAPP_TEST_CONTROL_SECRET", &harness.secret)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(text)?;
    let mut child = OwnedNode(Some(child));
    let deadline = Instant::now() + Duration::from_secs(30);
    let actual = (|| {
        loop {
            harness.poll()?;
            if child
                .0
                .as_mut()
                .ok_or("missing exact Node child")?
                .try_wait()
                .map_err(text)?
                .is_some()
            {
                break;
            }
            if Instant::now() >= deadline {
                return Err("real HTTP/Node integration deadline".into());
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let output = child.output()?;
        if !output.status.success() {
            return Err(format!(
                "isolated Node client failed: {}",
                String::from_utf8_lossy(&output.stderr)
            ));
        }
        let report: Value = serde_json::from_slice(&output.stdout).map_err(text)?;
        if report["passed"] != true
            || report["realTcp"] != true
            || report["worker"] != false
            || report["browser"] != false
            || report["productionAuthentication"] != false
        {
            return Err("isolated Node client evidence boundary changed".into());
        }
        harness.poll()?;
        harness.assert_audit()
    })();
    // Explicit cleanup also on error; dropping this exact harness closes only
    // its own listener/sockets and releases original Arc response borrowers.
    let cleanup = child.terminate();
    drop(harness);
    match (actual, cleanup) {
        (Ok(()), Ok(())) => Ok(()),
        (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; exact child cleanup: {cleanup}")),
    }
}

#[test]
#[ignore = "opt-in real TCP/Node transport test; requires explicit NODE_BIN"]
fn real_tcp_transport_uses_original_control_ledger_and_arc_body_barrier() {
    if let Err(error) = run() {
        panic!("{error}");
    }
}
