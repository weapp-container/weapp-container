//! Explicit real managed compiler/runtime/stage + production owner + loopback
//! HTTP probe. No Worker, browser, presenter, successful close or GPU is used.

use super::*;
use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use crate::dev::{BrowserRuntimePreparation, DevConfig, DevPackConsumer};
use crate::web::{WebResourceBody, WebResourceResolution, WebResourceTarget};
use crate::SimulatorConfig;
use serde_json::{json, Value};
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, TcpStream};
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const CLIENT: &str = "actual-owner-control-test";
const SECRET: &str = "actual-owner-owned-loopback-test-secret";

fn observed(event: OwnerObservation) {
    // Keep original failures visible. A source diagnostic is not silently
    // changed to a passing runtime/presentation result.
    match event {
        OwnerObservation::Source(event) => {
            if let DevEvent::Diagnostic(d) = *event {
                eprintln!("{}: {}", d.code, d.message);
            }
        }
        OwnerObservation::Coordination(error) => eprintln!("coordinator: {error}"),
    }
}

struct PrepareFailure {
    supervisor: Option<DevSupervisor>,
    error: String,
}

fn prepare(config: DevConfig) -> Result<DevSupervisor, Box<PrepareFailure>> {
    let (mut supervisor, _) = DevSupervisor::spawn(config).map_err(|error| {
        Box::new(PrepareFailure {
            supervisor: None,
            error: error.to_string(),
        })
    })?;
    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        match supervisor.poll() {
            Ok(Some(DevEvent::Diagnostic(d))) => {
                return Err(Box::new(PrepareFailure {
                    supervisor: Some(supervisor),
                    error: d.message,
                }))
            }
            Ok(Some(DevEvent::Exited(status))) => {
                return Err(Box::new(PrepareFailure {
                    supervisor: Some(supervisor),
                    error: format!("fixture watcher exited: {status}"),
                }));
            }
            Err(error) => {
                return Err(Box::new(PrepareFailure {
                    supervisor: Some(supervisor),
                    error: error.to_string(),
                }))
            }
            _ => {}
        }
        if supervisor.browser_runtime().is_some() && supervisor.portable_pack().is_some() {
            return Ok(supervisor);
        }
        if Instant::now() >= deadline {
            return Err(Box::new(PrepareFailure {
                supervisor: Some(supervisor),
                error: "real owner runtime/source preparation timed out".into(),
            }));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn drain_supervisor(supervisor: &mut DevSupervisor) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let reason = match supervisor.try_shutdown() {
            Ok(true) => return Ok(()),
            Ok(false) => "original supervisor still owns a process or resource".into(),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "original supervisor cleanup did not finish: {reason}"
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn exchange(
    owner: &mut BrowserDevOwner,
    surface: &mut WebSurface,
    endpoint: &str,
    body: &[u8],
) -> Result<Vec<u8>, String> {
    let address = surface.local_addr();
    let run = owner.snapshot().run_id;
    let mut peer = TcpStream::connect(address).map_err(|error| error.to_string())?;
    peer.set_nodelay(true).map_err(|error| error.to_string())?;
    let header = format!(
        "POST /__weapp/control/{endpoint} HTTP/1.1\r\nHost: {address}\r\nOrigin: http://{address}\r\nX-Weapp-Run-Id: {run}\r\nX-Weapp-Client-Id: {CLIENT}\r\nX-Weapp-Dev-Secret: {SECRET}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n",
        body.len()
    );
    peer.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|error| error.to_string())?;
    peer.write_all(header.as_bytes())
        .map_err(|error| error.to_string())?;
    peer.write_all(body).map_err(|error| error.to_string())?;
    peer.set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut response = Vec::new();
    loop {
        surface.poll().map_err(|error| error.to_string())?;
        owner
            .resolve_controls(surface, &mut observed)
            .map_err(|error| error.to_string())?;
        surface.poll().map_err(|error| error.to_string())?;
        let mut chunk = [0_u8; 4096];
        match peer.read(&mut chunk) {
            Ok(0) => return Ok(response),
            Ok(count) => {
                if response.len() + count > 512 * 1024 {
                    return Err(
                        "live owner HTTP response exceeded bounded fixture allowance".into(),
                    );
                }
                response.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) => return Err(format!("owned loopback response failed: {error}")),
        }
        if Instant::now() >= deadline {
            return Err("owned loopback response timed out".into());
        }
        std::thread::sleep(Duration::from_millis(1));
    }
}

fn ok_body(response: &[u8]) -> Result<&[u8], String> {
    if !response.starts_with(b"HTTP/1.1 200 ") {
        return Err(format!(
            "control HTTP was not 200: {}",
            String::from_utf8_lossy(response)
        ));
    }
    let offset = response
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or("control response had no complete header")?
        + 4;
    Ok(&response[offset..])
}

fn prove_replay_does_not_recover_other_final(
    owner: &mut BrowserDevOwner,
    surface: &mut WebSurface,
    original_request: &[u8],
    original_final: &[u8],
) -> Result<(), String> {
    use crate::browser_dev_control::{
        ControlError, ControlLookup, ControlOperation, ControlResult, FinalDraft, FinalOutcome,
        TombstoneKind,
    };

    if owner.unresolved_final.is_some() {
        return Err("fixture started with another unresolved execution ticket".into());
    }
    let second_request = format!(
        " \n{{\"payload\":{{}},\"requestId\":\"{CLIENT}:control-2\",\"command\":\"snapshot\",\"version\":\"1.0\"}}\n"
    ).into_bytes();
    let queued = match owner
        .ledger
        .admit(&owner.run_id, &second_request)
        .map_err(|error| error.to_string())?
    {
        ControlLookup::Queued(queued) => queued,
        state => return Err(format!("second snapshot was not newly queued: {state:?}")),
    };
    let begun = owner
        .ledger
        .begin(&queued.identity)
        .map_err(|error| error.to_string())?;
    if !matches!(begun.operation, ControlOperation::Snapshot(_)) {
        return Err("fixture admitted a different second operation".into());
    }
    let identity = begun.ticket.identity().clone();
    let snapshot = owner.snapshot();
    let expected_snapshot = serde_json::to_value(&snapshot).map_err(|error| error.to_string())?;
    let prepared = owner
        .ledger
        .prepare_final(
            &begun.ticket,
            FinalDraft {
                snapshot: snapshot.clone(),
                outcome: FinalOutcome::Ok(Box::new(ControlResult::Snapshot(Box::new(snapshot)))),
            },
        )
        .map_err(|error| error.to_string())?;
    // Simulate loss of the PreparedFinal wrapper. The original ledger retains
    // its exact serialized bytes; the owner retains its exact ExecutionTicket.
    // Recovery must never decode/execute this operation again.
    drop(prepared);
    owner.unresolved_final = Some(begun.ticket);
    if !matches!(
        owner
            .ledger
            .lookup(&owner.run_id, &second_request)
            .map_err(|error| error.to_string())?,
        ControlLookup::Executing(_)
    ) {
        return Err("Prepared second final was incorrectly exposed as committed".into());
    }

    // exchange() calls only surface.poll + owner.resolve_controls. In
    // particular it does NOT call owner.poll or recover_final itself.
    let replayed = exchange(owner, surface, "replay", original_request)?;
    if ok_body(&replayed)? != original_final {
        return Err("read-only replay changed the first exact retained final".into());
    }
    if owner
        .unresolved_final
        .as_ref()
        .map(|ticket| ticket.identity())
        != Some(&identity)
    {
        return Err("HTTP replay recovered or replaced an unrelated exact ticket".into());
    }
    if !matches!(
        owner
            .ledger
            .lookup(&owner.run_id, &second_request)
            .map_err(|error| error.to_string())?,
        ControlLookup::Executing(_)
    ) {
        return Err("HTTP replay committed an unrelated Prepared final".into());
    }

    // Recovery is now requested explicitly on the original serial owner loop.
    // It commits the original Prepared bytes without repeating the snapshot
    // operation or advancing coordinator authority.
    owner
        .poll(&mut observed)
        .map_err(|error| error.to_string())?;
    if owner.unresolved_final.is_some() {
        return Err("explicit original owner poll did not recover Prepared final".into());
    }
    if serde_json::to_value(owner.snapshot()).map_err(|error| error.to_string())?
        != expected_snapshot
    {
        return Err("Prepared recovery changed coordinator state or authority".into());
    }
    let recovered = match owner
        .ledger
        .lookup(&owner.run_id, &second_request)
        .map_err(|error| error.to_string())?
    {
        ControlLookup::Final(bytes) => bytes,
        state => {
            return Err(format!(
                "explicit poll did not commit Prepared final: {state:?}"
            ))
        }
    };
    if std::sync::Arc::strong_count(&recovered) != 2 {
        return Err("Prepared recovery retained an unexpected extra final borrower".into());
    }
    let value: Value = serde_json::from_slice(&recovered).map_err(|error| error.to_string())?;
    if value["requestId"] != format!("{CLIENT}:control-2")
        || value["status"] != "ok"
        || value["snapshot"] != expected_snapshot
        || value["result"] != expected_snapshot
    {
        return Err("Prepared recovery changed the second serialized outcome".into());
    }
    if !matches!(owner.ledger.begin(&identity), Err(ControlError::NotQueued)) {
        return Err("recovered second operation became executable again".into());
    }

    let final_sha256 = container_ir::hex_digest(&recovered);
    // Release this exact local borrower before asking the original HTTP owner
    // to compact. This ACK must not be blocked by a hidden recovery Arc.
    drop(recovered);
    let acknowledgement = serde_json::to_vec(&json!({
        "version":"1.0",
        "originalRequest":String::from_utf8(second_request.clone()).map_err(|error| error.to_string())?,
        "finalSha256":final_sha256,
    })).map_err(|error| error.to_string())?;
    let acknowledged = exchange(owner, surface, "acknowledge", &acknowledgement)?;
    let value: Value =
        serde_json::from_slice(ok_body(&acknowledged)?).map_err(|error| error.to_string())?;
    if value["outcome"] != "compacted" {
        return Err(format!(
            "recovered final borrower did not release before ACK: {value}"
        ));
    }
    if !matches!(owner.ledger.lookup(&owner.run_id, &second_request)
        .map_err(|error| error.to_string())?,
        ControlLookup::Tombstone(value) if value.kind == TombstoneKind::FinalCompacted)
    {
        return Err("recovered final did not remain an exact compacted tombstone".into());
    }
    Ok(())
}

#[test]
#[cfg(unix)]
#[ignore = "requires independently pinned completed runtime, Node and fixed compiler dependencies; actual owner/static TCP only"]
fn managed_owner_real_stage_tcp_replay_ack_and_borrowed_shutdown() -> Result<(), String> {
    let required = |name| {
        std::env::var(format!("WEAPP_CONTAINER_RETAINED_RUNTIME_{name}"))
            .map_err(|_| format!("missing independent input {name}"))
    };
    if required("PIN_AUTHORITY")?.is_empty() {
        return Err("independent pin authority required".into());
    }
    let node = PathBuf::from(required("NODE_BIN")?);
    let producer = fs::canonicalize(required("BUILD_SITE")?).map_err(|error| error.to_string())?;
    let renderer = match required("RENDERER")?.as_str() {
        "software" => RuntimeBundleRenderer::Software,
        "canvaskit" => RuntimeBundleRenderer::Canvaskit,
        _ => return Err("unknown independently pinned renderer".into()),
    };
    let expected = ProducerExpected {
        report_sha256: required("REPORT_SHA256")?,
        source_commit: required("SOURCE_COMMIT")?,
        source_sha256: required("SOURCE_SHA256")?,
        renderer,
    };
    let producer_report =
        fs::read(producer.join("build-report.json")).map_err(|error| error.to_string())?;
    if container_ir::hex_digest(&producer_report) != expected.report_sha256 {
        return Err("independent runtime producer report pin mismatch".into());
    }
    let root = fs::canonicalize(std::env::temp_dir())
        .map_err(|error| error.to_string())?
        .join(format!(
            "weapp-managed-owner-live-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_nanos()
        ));
    fs::create_dir(&root).map_err(|error| error.to_string())?;
    let project = root.join("project");
    fs::create_dir_all(project.join("pages/home")).map_err(|error| error.to_string())?;
    for (path, text) in [
        (
            "project.config.json",
            r#"{"compileType":"miniprogram","miniprogramRoot":"dist/","srcMiniprogramRoot":".","appid":"touristappid"}"#,
        ),
        (
            "app.json",
            r#"{"pages":["pages/home/index"],"renderer":"webview"}"#,
        ),
        ("app.js", "App({});"),
        ("app.wxss", "page { background:#f5f5f5; }"),
        ("pages/home/index.json", "{}"),
        (
            "pages/home/index.js",
            "Page({data:{title:'actual serial owner fixture'}});",
        ),
        ("pages/home/index.wxml", "<view>{{title}}</view>"),
        ("pages/home/index.wxss", "view { color:#000; }"),
    ] {
        fs::write(project.join(path), text).map_err(|error| error.to_string())?;
    }
    let mut config = DevConfig::new(&project, SimulatorConfig::default());
    config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    config.output_dir = root.join("output");
    config.node_bin = node;
    config.pack_consumer = DevPackConsumer::BrowserWorker;
    config.managed_browser_sources = true;
    config.managed_browser_stages = true;
    config.browser_runtime = Some(BrowserRuntimePreparation {
        producer_directory: producer.clone(),
        expected,
    });
    let supervisor = match prepare(config) {
        Ok(supervisor) => supervisor,
        Err(failure) => {
            let PrepareFailure {
                mut supervisor,
                error,
            } = *failure;
            if let Some(supervisor) = supervisor.as_mut() {
                drain_supervisor(supervisor)?;
            }
            fs::remove_dir_all(&root).map_err(|cleanup| cleanup.to_string())?;
            return Err(error);
        }
    };
    let intent = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"webview"}}"#.to_vec();
    let mut owner = match BrowserDevOwner::new(
        supervisor,
        intent,
        CLIENT.into(),
        "actual-owned-preview".into(),
        ControlLimits::default(),
    ) {
        Ok(owner) => owner,
        Err(failure) => {
            let mut failure = *failure;
            drain_supervisor(&mut failure.supervisor)?;
            fs::remove_dir_all(&root).map_err(|cleanup| cleanup.to_string())?;
            return Err(failure.error.to_string());
        }
    };
    // Every subsequent error unwinds the exact surface/peer/body borrowers before
    // cleanup retries on this same owner. Never allocate a replacement owner.
    let outcome = (|| -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(180);
        let site = loop {
            owner
                .poll(&mut observed)
                .map_err(|error| error.to_string())?;
            owner
                .stage_latest(&mut observed)
                .map_err(|error| error.to_string())?;
            if let Some(site) = owner
                .poll_stages(&mut observed)
                .map_err(|error| error.to_string())?
                .into_iter()
                .next()
            {
                break site;
            }
            if Instant::now() >= deadline {
                return Err("original owner did not publish a real static stage".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        let state = owner.snapshot();
        if state.runtime_ready.is_some()
            || state.presented_ready.is_some()
            || state.owner_key.is_some()
        {
            return Err("static owner incorrectly claimed actual Worker/presentation".into());
        }
        let target = WebResourceTarget::Site {
            run_id: state.run_id.clone(),
            site_id: site.site_id,
        };
        let held = match owner.resolve_resource(&target) {
            WebResourceResolution::Found(WebResourceBody::Stage(body)) => body,
            result => return Err(format!("real owner site borrower unavailable: {result:?}")),
        };
        if held.bytes().is_empty() {
            return Err("real site descriptor was empty".into());
        }
        let mut surface = WebSurface::bind_resource_only(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
            .map_err(|error| error.to_string())?;
        let origin = format!("http://{}", surface.local_addr());
        owner
            .enable_control(&mut surface, origin, SECRET.into())
            .map_err(|error| format!("owner HTTP enable failed: {error:?}"))?;
        let request = format!(" \n{{\"payload\":{{}},\"requestId\":\"{CLIENT}:control-1\",\"command\":\"snapshot\",\"version\":\"1.0\"}}\n").into_bytes();
        let invoked = exchange(&mut owner, &mut surface, "invoke", &request)?;
        let original_final = ok_body(&invoked)?.to_vec();
        let parsed: Value =
            serde_json::from_slice(&original_final).map_err(|error| error.to_string())?;
        if parsed["requestId"] != format!("{CLIENT}:control-1") {
            return Err("actual owner returned a final for a different request".into());
        }
        prove_replay_does_not_recover_other_final(
            &mut owner,
            &mut surface,
            &request,
            &original_final,
        )?;
        let acknowledgement = serde_json::to_vec(&json!({
            "version":"1.0", "originalRequest":String::from_utf8(request).map_err(|error| error.to_string())?,
            "finalSha256":container_ir::hex_digest(&original_final),
        })).map_err(|error| error.to_string())?;
        for expected in ["compacted", "already-compacted"] {
            let acknowledged = exchange(&mut owner, &mut surface, "acknowledge", &acknowledgement)?;
            let value: Value = serde_json::from_slice(ok_body(&acknowledged)?)
                .map_err(|error| error.to_string())?;
            if value["outcome"] != expected {
                return Err(format!("actual owner ACK was not {expected}: {value}"));
            }
        }
        surface.stop_admission();
        if !surface.drain_status().is_drained() {
            return Err("owned loopback sockets remained after exact response completion".into());
        }
        drop(surface);
        if owner
            .try_shutdown(&mut observed)
            .map_err(|error| error.to_string())?
        {
            return Err("original owner removed a stage while its real body was borrowed".into());
        }
        if !matches!(
            owner.resolve_resource(&target),
            WebResourceResolution::NotFound | WebResourceResolution::Denied
        ) {
            return Err("stopped owner admitted a new stage resource borrower".into());
        }
        drop(held);
        Ok(())
    })();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let reason = match owner.try_shutdown(&mut observed) {
            Ok(true) => break,
            Ok(false) => "same owner still owns a process or original borrower".into(),
            Err(error) => error.to_string(),
        };
        if Instant::now() >= deadline {
            return Err(format!(
                "same owner cleanup failed after retries: {reason}; original outcome={outcome:?}"
            ));
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if fs::read(producer.join("build-report.json")).map_err(|error| error.to_string())?
        != producer_report
    {
        return Err("original independent runtime producer report was changed".into());
    }
    fs::remove_dir_all(&root).map_err(|error| error.to_string())?;
    outcome
}
