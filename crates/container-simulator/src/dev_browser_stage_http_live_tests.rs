//! Actual fixed compiler -> verified stage -> localhost TCP.
//! Include as a child of dev_browser_stage_live_tests.rs to reuse its original
//! wait_portable/current_ticket/capture_stage helpers. No Worker/browser or
//! presenter is constructed, and static HTTP is not a publication approval.
#![cfg(unix)]

use super::*;
use crate::web::{WebResourceBody, WebResourceResolution, WebResourceTarget, WebSurface};
use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::os::fd::AsRawFd;

// A real module, not an arbitrary body supplied to the HTTP server. The fixed
// compiler must retain this opaque Page data literal in its emitted JS blob.
const SLOW_MODULE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CLIENT_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const RESOURCE_HTTP_DEADLINE: Duration = Duration::from_secs(5);

struct HttpFixture {
    supervisor: DevSupervisor,
    root: PathBuf,
    artifact_root: PathBuf,
    preparation_root: PathBuf,
    producer: PathBuf,
    original_producer: Vec<u8>,
}

impl HttpFixture {
    fn spawn() -> Result<Self, String> {
        // Same independent inputs as the original managed stage gate. Never
        // derive expected pins from the child result or the served response.
        let required = |name| {
            std::env::var(format!("WEAPP_CONTAINER_RETAINED_RUNTIME_{name}"))
                .map_err(|_| format!("missing independent input {name}"))
        };
        if required("PIN_AUTHORITY")?.is_empty() {
            return Err("independent pin authority required".into());
        }
        let node_bin = PathBuf::from(required("NODE_BIN")?);
        let producer = fs::canonicalize(required("BUILD_SITE")?).map_err(|e| e.to_string())?;
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
        let original_producer =
            fs::read(producer.join("build-report.json")).map_err(|e| e.to_string())?;
        if container_ir::hex_digest(&original_producer) != expected.report_sha256 {
            return Err("independent producer report pin mismatch".into());
        }
        let root = fs::canonicalize(std::env::temp_dir())
            .map_err(|e| e.to_string())?
            .join(format!(
                "weapp-managed-stage-http-live-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos()
            ));
        fs::create_dir(&root).map_err(|e| e.to_string())?;
        let project = root.join("project");
        fs::create_dir_all(project.join("pages/home")).map_err(|e| e.to_string())?;
        for (path, contents) in [
            (
                "project.config.json",
                r#"{"compileType":"miniprogram","miniprogramRoot":"dist/","srcMiniprogramRoot":".","appid":"touristappid"}"#,
            ),
            (
                "app.json",
                r#"{"pages":["pages/home/index"],"renderer":"webview"}"#,
            ),
            ("app.js", "App({});"),
            ("app.wxss", "page { background: #f5f5f5; }"),
            ("pages/home/index.json", "{}"),
            ("pages/home/index.wxml", "<view>{{title}}</view>"),
            ("pages/home/index.wxss", "view { color: #000; }"),
        ] {
            fs::write(project.join(path), contents).map_err(|e| e.to_string())?;
        }
        let mut module =
            fs::File::create(project.join("pages/home/index.js")).map_err(|e| e.to_string())?;
        module
            .write_all(b"Page({data:{title:'actual HTTP fixture',payload:'")
            .map_err(|e| e.to_string())?;
        let chunk = [b'x'; 64 * 1024];
        for _ in 0..SLOW_MODULE_BYTES / chunk.len() {
            module.write_all(&chunk).map_err(|e| e.to_string())?;
        }
        module.write_all(b"'}});\n").map_err(|e| e.to_string())?;
        drop(module);
        let mut config = DevConfig::new(&project, SimulatorConfig::default());
        config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
        config.output_dir = root.join("output");
        config.node_bin = node_bin;
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.managed_browser_sources = true;
        config.managed_browser_stages = true;
        config.browser_runtime = Some(BrowserRuntimePreparation {
            producer_directory: producer.clone(),
            expected,
        });
        let (supervisor, _) = DevSupervisor::spawn(config)
            .map_err(|e| format!("spawn failed; retained {}: {e}", root.display()))?;
        let artifact_root = supervisor.run_root.join("browser-artifacts");
        let preparation_root = supervisor.preparation_root.path.clone();
        Ok(Self {
            supervisor,
            root,
            artifact_root,
            preparation_root,
            producer,
            original_producer,
        })
    }

    fn cleanup(&mut self) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            match self.supervisor.try_shutdown() {
                Ok(true) => break,
                state if Instant::now() >= deadline => {
                    return Err(format!(
                        "HTTP fixture cleanup failed; retaining {}: {state:?}",
                        self.root.display()
                    ))
                }
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        if self.artifact_root.exists() || self.preparation_root.exists() {
            return Err("actual stage/source/runtime parent survived successful shutdown".into());
        }
        if fs::read(self.producer.join("build-report.json")).map_err(|e| e.to_string())?
            != self.original_producer
        {
            return Err("independently pinned producer changed".into());
        }
        fs::remove_dir_all(&self.root).map_err(|e| e.to_string())
    }
}

struct HttpBindings {
    run_id: String,
    bundle_sha256: String,
    sites: Vec<(WireU64, BrowserStageId)>,
}

#[derive(Debug, PartialEq, Eq)]
struct OriginalBody {
    pointer: usize,
    length: usize,
    sha256: String,
}

fn original_body(bytes: &[u8]) -> OriginalBody {
    OriginalBody {
        pointer: bytes.as_ptr() as usize,
        length: bytes.len(),
        sha256: container_ir::hex_digest(bytes),
    }
}

#[derive(Default)]
struct HttpAudit {
    owner_lookups: usize,
    // Only metadata. No copied payload, lease, Arc, token or file owner escapes.
    borrows: Vec<(WebResourceTarget, OriginalBody)>,
}

fn resolve_http(
    surface: &mut WebSurface,
    supervisor: &mut DevSupervisor,
    bindings: &HttpBindings,
    audit: &mut HttpAudit,
) -> Result<usize, String> {
    surface
        .resolve_resource_requests(|target| {
            audit.owner_lookups += 1;
            match target {
                WebResourceTarget::Runtime {
                    bundle_sha256,
                    path,
                } if bundle_sha256 == &bindings.bundle_sha256 => {
                    match supervisor.browser_runtime_resource(path) {
                        Ok(Some(body)) => {
                            audit
                                .borrows
                                .push((target.clone(), original_body(body.bytes())));
                            WebResourceResolution::Found(WebResourceBody::Runtime(body))
                        }
                        Ok(None) => WebResourceResolution::NotFound,
                        Err(error) => {
                            eprintln!("actual static HTTP runtime lookup: {error}");
                            WebResourceResolution::Unavailable
                        }
                    }
                }
                WebResourceTarget::Pack {
                    run_id,
                    site_id,
                    path,
                } if run_id == &bindings.run_id => {
                    resolve_http_stage(supervisor, bindings, audit, target, *site_id, path)
                }
                WebResourceTarget::Site { run_id, site_id } if run_id == &bindings.run_id => {
                    resolve_http_stage(supervisor, bindings, audit, target, *site_id, "site.json")
                }
                _ => WebResourceResolution::NotFound,
            }
        })
        .map_err(|e| e.to_string())
}

fn resolve_http_stage(
    supervisor: &mut DevSupervisor,
    bindings: &HttpBindings,
    audit: &mut HttpAudit,
    target: &WebResourceTarget,
    site: WireU64,
    path: &str,
) -> WebResourceResolution {
    let Some((_, id)) = bindings.sites.iter().find(|(site_id, _)| *site_id == site) else {
        return WebResourceResolution::NotFound;
    };
    match supervisor.browser_stage_resource(*id, path) {
        Ok(Some(body)) => {
            audit
                .borrows
                .push((target.clone(), original_body(body.bytes())));
            WebResourceResolution::Found(WebResourceBody::Stage(body))
        }
        Ok(None) => WebResourceResolution::NotFound,
        Err(error) => {
            eprintln!("actual static HTTP stage lookup: {error}");
            WebResourceResolution::Unavailable
        }
    }
}

fn connect_request(address: SocketAddr, path: &str, slow: bool) -> Result<TcpStream, String> {
    let mut peer =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    if slow {
        let capacity: nix::libc::c_int = 4096;
        // Only the test's own receiving socket is adjusted. This is a real
        // kernel backpressure gate, not a fabricated store borrower or clock.
        let result = unsafe {
            nix::libc::setsockopt(
                peer.as_raw_fd(),
                nix::libc::SOL_SOCKET,
                nix::libc::SO_RCVBUF,
                (&capacity as *const nix::libc::c_int).cast(),
                std::mem::size_of_val(&capacity) as nix::libc::socklen_t,
            )
        };
        if result != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    peer.set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    peer.write_all(
        format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    peer.set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(peer)
}

struct TcpResponse {
    status: u16,
    header: String,
    body: Vec<u8>,
}

fn exchange(
    surface: &mut WebSurface,
    supervisor: &mut DevSupervisor,
    bindings: &HttpBindings,
    audit: &mut HttpAudit,
    path: &str,
) -> Result<TcpResponse, String> {
    let mut peer = connect_request(surface.local_addr(), path, false)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut bytes = Vec::new();
    'response: loop {
        surface.poll().map_err(|e| e.to_string())?;
        resolve_http(surface, supervisor, bindings, audit)?;
        surface.poll().map_err(|e| e.to_string())?;
        let mut chunk = [0_u8; 64 * 1024];
        loop {
            match peer.read(&mut chunk) {
                Ok(0) => break 'response,
                Ok(length) => {
                    if bytes.len().saturating_add(length) > MAX_CLIENT_RESPONSE_BYTES {
                        return Err("actual TCP response exceeds the test client's bound".into());
                    }
                    bytes.extend_from_slice(&chunk[..length]);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(format!("actual TCP read failed: {error}")),
            }
        }
        if Instant::now() >= deadline {
            return Err("actual TCP response did not close".into());
        }
        surface
            .wait(Duration::from_millis(1))
            .map_err(|e| e.to_string())?;
    }
    let header_end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or("actual response has no complete HTTP header")?
        + 4;
    let body = bytes.split_off(header_end);
    let header = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    let status = header
        .lines()
        .next()
        .and_then(|line| line.split(' ').nth(1))
        .ok_or("missing actual HTTP status")?
        .parse::<u16>()
        .map_err(|e| e.to_string())?;
    let declared = header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .ok_or("missing actual content length")?
        .parse::<usize>()
        .map_err(|e| e.to_string())?;
    if declared != body.len() {
        return Err("actual HTTP body is truncated or exceeds its header".into());
    }
    if !header.contains("Connection: close\r\n")
        || !header.contains("X-Content-Type-Options: nosniff\r\n")
        || !header.contains("Cross-Origin-Resource-Policy: same-origin\r\n")
        || header
            .to_ascii_lowercase()
            .contains("access-control-allow-origin")
    {
        return Err("actual resource response omitted its strict same-origin headers".into());
    }
    Ok(TcpResponse {
        status,
        header,
        body,
    })
}

fn verify_exchange(
    surface: &mut WebSurface,
    supervisor: &mut DevSupervisor,
    bindings: &HttpBindings,
    audit: &mut HttpAudit,
    path: &str,
    expected: &OriginalBody,
    expected_mime: &str,
) -> Result<(), String> {
    let before = audit.borrows.len();
    let response = exchange(surface, supervisor, bindings, audit, path)?;
    if response.status != 200
        || response.body.len() != expected.length
        || container_ir::hex_digest(&response.body) != expected.sha256
        || !response
            .header
            .contains(&format!("Content-Type: {expected_mime}\r\n"))
    {
        return Err(format!("actual resource bytes/headers differ for {path}"));
    }
    if audit.borrows.len() != before + 1 {
        return Err(
            "actual successful HTTP request did not borrow exactly one original body".into(),
        );
    }
    let original = &audit.borrows[before].1;
    if original != expected {
        return Err("HTTP owner resolver substituted the captured original body".into());
    }
    Ok(())
}

fn stage_body(
    supervisor: &mut DevSupervisor,
    id: BrowserStageId,
    path: &str,
) -> Result<OriginalBody, String> {
    let body = supervisor
        .browser_stage_resource(id, path)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("actual captured stage omitted {path}"))?;
    Ok(original_body(body.bytes()))
}

fn large_module_blob(
    supervisor: &mut DevSupervisor,
    id: BrowserStageId,
) -> Result<(String, OriginalBody), String> {
    let body = supervisor
        .browser_stage_resource(id, "portable-pack/manifest.json")
        .map_err(|e| e.to_string())?
        .ok_or("actual portable manifest missing")?;
    let manifest: serde_json::Value =
        serde_json::from_slice(body.bytes()).map_err(|e| e.to_string())?;
    drop(body);
    for module in manifest["modules"]
        .as_array()
        .ok_or("actual manifest omitted modules")?
    {
        let hash = module["sha256"]
            .as_str()
            .ok_or("actual module omitted content hash")?;
        if !container_ir::is_sha256(hash) {
            return Err("actual module hash is invalid".into());
        }
        let path = format!("portable-pack/blobs/sha256/{hash}");
        let original = stage_body(supervisor, id, &path)?;
        if original.length >= SLOW_MODULE_BYTES {
            if original.sha256 != hash {
                return Err("actual large module blob differs from manifest pin".into());
            }
            return Ok((path, original));
        }
    }
    Err("actual fixed compiler did not retain the required large module; slow-client gate cannot run".into())
}

fn reset_own_peer(peer: TcpStream) -> Result<(), String> {
    let linger = nix::libc::linger {
        l_onoff: 1,
        l_linger: 0,
    };
    // Produce an unambiguous actual disconnect on exactly this test socket.
    let status = unsafe {
        nix::libc::setsockopt(
            peer.as_raw_fd(),
            nix::libc::SOL_SOCKET,
            nix::libc::SO_LINGER,
            (&linger as *const nix::libc::linger).cast(),
            std::mem::size_of_val(&linger) as nix::libc::socklen_t,
        )
    };
    if status != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    drop(peer);
    Ok(())
}

#[test]
#[ignore = "requires independently pinned completed producer, Node and fixed compiler dependencies; actual static localhost TCP only"]
fn managed_stage_http_serves_original_bytes_and_retires_slow_borrowers() -> Result<(), String> {
    let mut fixture = HttpFixture::spawn()?;
    let mut surface: Option<WebSurface> = None;
    // Every early operational error drops this closure's own peers, then the
    // original HTTP surface before retrying the SAME supervisor's cleanup.
    let outcome = (|| -> Result<serde_json::Value, String> {
        let supervisor = &mut fixture.supervisor;
        let report = wait_portable(supervisor)?;
        let runtime = supervisor
            .browser_runtime()
            .ok_or("actual runtime was not prepared")?;
        if supervisor.simulator().is_some() || runtime.runtime_ready || runtime.presented_ready {
            return Err(
                "static HTTP preparation constructed or claimed an application runtime".into(),
            );
        }
        let bundle_sha256 = runtime.pins.bundle_sha256.clone();
        let run_id = supervisor
            .browser_stage_run_id()
            .ok_or("missing actual run identity")?
            .to_owned();
        let intent = br#"{"schemaVersion":1,"execution":"worker","engine":"quickjs","viewport":{"width":375,"height":667},"rendererPolicy":{"mode":"force","profile":"webview"}}"#;
        let mut coordinator = BrowserDevCoordinator::new(
            run_id.clone(),
            runtime.pins.clone(),
            StartupIntentPin {
                revision: WireU64::new(1),
                sha256: container_ir::hex_digest(intent),
                metrics_revision: WireU64::new(0),
            },
        )
        .map_err(|e| e.to_string())?;
        let (first, first_artifact) = capture_stage(supervisor, &mut coordinator, &report, intent)?;
        let (second, second_artifact) =
            capture_stage(supervisor, &mut coordinator, &report, intent)?;
        let bindings = HttpBindings {
            run_id: run_id.clone(),
            bundle_sha256: bundle_sha256.clone(),
            sites: vec![
                (first_artifact.site_id, first),
                (second_artifact.site_id, second),
            ],
        };
        let site = first_artifact.site_id.get();
        let pack_prefix = format!("/__weapp/pack/{run_id}/{site}");
        let site_path = format!("/__weapp/site/{run_id}/{site}/site.json");
        let runtime_path = format!("/__weapp/runtime/{bundle_sha256}/runtime-worker.mjs");
        let runtime_body = supervisor
            .browser_runtime_resource("runtime-worker.mjs")
            .map_err(|e| e.to_string())?
            .ok_or("actual runtime worker body missing")?;
        let runtime_expected = original_body(runtime_body.bytes());
        drop(runtime_body);
        let site_expected = stage_body(supervisor, first, "site.json")?;
        let index_expected = stage_body(supervisor, first, "pack-index.json")?;
        let manifest_expected = stage_body(supervisor, first, "portable-pack/manifest.json")?;
        let startup_expected = stage_body(supervisor, first, "worker-product-config.json")?;
        let (blob_path, first_blob) = large_module_blob(supervisor, first)?;
        let second_blob = stage_body(supervisor, second, &blob_path)?;
        if site_expected.sha256 != first_artifact.descriptor_sha256
            || index_expected.sha256 != first_artifact.index.sha256
            || index_expected.length as u64 != first_artifact.index.size.get()
            || manifest_expected.sha256 != report.manifest_sha256
            || startup_expected.sha256 != first_artifact.startup_sha256
            || first_blob.sha256 != second_blob.sha256
        {
            return Err(
                "actual captured resource bytes differ from verified independent bindings".into(),
            );
        }
        surface = Some(
            WebSurface::bind_resource_only(IpAddr::V4(Ipv4Addr::LOCALHOST), 0)
                .map_err(|e| e.to_string())?,
        );
        let http = surface.as_mut().ok_or("actual HTTP surface missing")?;
        let address = http.local_addr();
        let mut audit = HttpAudit::default();
        for (path, expected, mime) in [
            (
                runtime_path.clone(),
                &runtime_expected,
                "text/javascript; charset=utf-8",
            ),
            (site_path.clone(), &site_expected, "application/json"),
            (
                format!("{pack_prefix}/pack-index.json"),
                &index_expected,
                "application/json",
            ),
            (
                format!("{pack_prefix}/portable-pack/manifest.json"),
                &manifest_expected,
                "application/json",
            ),
            (
                format!("{pack_prefix}/worker-product-config.json"),
                &startup_expected,
                "application/json",
            ),
            (
                format!("{pack_prefix}/{blob_path}"),
                &first_blob,
                "application/octet-stream",
            ),
        ] {
            verify_exchange(
                http, supervisor, &bindings, &mut audit, &path, expected, mime,
            )?;
        }
        let mut denied = Vec::new();
        for (path, status, expected_lookups) in [
            (
                format!("/__weapp/runtime/{}/runtime-worker.mjs", "0".repeat(64)),
                404,
                1,
            ),
            (format!("/__weapp/site/other-run/{site}/site.json"), 404, 1),
            (
                format!("/__weapp/site/{run_id}/18446744073709551615/site.json"),
                404,
                1,
            ),
            (format!("{pack_prefix}/worker-product-config.mjs"), 404, 0),
            (format!("{pack_prefix}/source/app.js"), 404, 0),
            (format!("{pack_prefix}/build-report.json"), 404, 0),
            (format!("{pack_prefix}/../site.json"), 400, 0),
            (format!("{pack_prefix}/%2e%2e/site.json"), 400, 0),
            (format!("{site_path}?alias=1"), 400, 0),
            (format!("{pack_prefix}//pack-index.json"), 400, 0),
            ("/api/state".to_owned(), 404, 0),
            ("/api/events".to_owned(), 404, 0),
        ] {
            let before = audit.owner_lookups;
            let borrowed = audit.borrows.len();
            let response = exchange(http, supervisor, &bindings, &mut audit, &path)?;
            if response.status != status
                || audit.owner_lookups - before != expected_lookups
                || audit.borrows.len() != borrowed
            {
                return Err(format!(
                    "actual HTTP refusal or owner frontier differs for {path}"
                ));
            }
            if String::from_utf8_lossy(&response.body)
                .contains(fixture.root.to_string_lossy().as_ref())
            {
                return Err("actual HTTP rejection leaked the fixture's native path".into());
            }
            denied.push(
                serde_json::json!({"path":path,"status":status,"ownerLookups":expected_lookups}),
            );
        }
        // Keep two different real stage outputs pending. No local lease is
        // retained: only the HTTP responses can block these independent slots.
        let first_slow_path = format!("{pack_prefix}/{blob_path}");
        let second_slow_path = format!(
            "/__weapp/pack/{run_id}/{}/{blob_path}",
            second_artifact.site_id.get()
        );
        let first_peer = connect_request(address, &first_slow_path, true)?;
        let deadline_started = Instant::now();
        let second_peer = connect_request(address, &second_slow_path, true)?;
        let before = audit.borrows.len();
        let queue_deadline = Instant::now() + Duration::from_secs(1);
        while audit.borrows.len() < before + 2 {
            http.poll().map_err(|e| e.to_string())?;
            resolve_http(http, supervisor, &bindings, &mut audit)?;
            if Instant::now() >= queue_deadline {
                return Err("actual slow HTTP requests did not reach their original stores".into());
            }
            std::thread::yield_now();
        }
        // TCP accept order is not an identity. Match each original body to
        // its complete retained target, including the stage's own site ID.
        for (target, expected) in [
            (
                WebResourceTarget::Pack {
                    run_id: run_id.clone(),
                    site_id: first_artifact.site_id,
                    path: blob_path.clone(),
                },
                &first_blob,
            ),
            (
                WebResourceTarget::Pack {
                    run_id: run_id.clone(),
                    site_id: second_artifact.site_id,
                    path: blob_path.clone(),
                },
                &second_blob,
            ),
        ] {
            let mut matching = audit.borrows[before..]
                .iter()
                .filter(|(observed, _)| observed == &target);
            if !matches!(matching.next(), Some((_, actual)) if actual == expected)
                || matching.next().is_some()
            {
                return Err(
                    "slow HTTP responses did not borrow their own original stage bodies".into(),
                );
            }
        }
        if supervisor
            .retire_browser_stage(first)
            .map_err(|e| e.to_string())?
            || supervisor
                .retire_browser_stage(second)
                .map_err(|e| e.to_string())?
        {
            return Err("stage cleanup ignored an actual pending HTTP body".into());
        }
        if supervisor
            .browser_stage_resource(first, "site.json")
            .is_ok()
            || supervisor
                .browser_stage_resource(second, "site.json")
                .is_ok()
        {
            return Err("HTTP-retained retired stage still admitted a new borrower".into());
        }
        if supervisor.try_shutdown().map_err(|e| e.to_string())? || !fixture.artifact_root.exists()
        {
            return Err(
                "same supervisor removed a parent while original HTTP bodies remained".into(),
            );
        }
        reset_own_peer(first_peer)?;
        let disconnect_deadline = Instant::now() + Duration::from_secs(2);
        loop {
            http.poll().map_err(|e| e.to_string())?;
            if supervisor
                .retire_browser_stage(first)
                .map_err(|e| e.to_string())?
            {
                break;
            }
            if Instant::now() >= disconnect_deadline {
                return Err(
                    "actual disconnected HTTP body did not release its original stage".into(),
                );
            }
            http.wait(Duration::from_millis(5))
                .map_err(|e| e.to_string())?;
        }
        if supervisor
            .retire_browser_stage(second)
            .map_err(|e| e.to_string())?
            || supervisor.try_shutdown().map_err(|e| e.to_string())?
            || !fixture.artifact_root.exists()
        {
            return Err("unread second HTTP body failed to retain its own stage and parent".into());
        }
        // Real elapsed deadline, no private queue mutation or synthetic clock.
        // The second peer remains OPEN and UNREAD through parent retirement.
        let finish_deadline = deadline_started + RESOURCE_HTTP_DEADLINE + Duration::from_secs(3);
        loop {
            http.poll().map_err(|e| e.to_string())?;
            // Observe THIS stage's original borrower directly. Overall watcher
            // or parent shutdown may take longer and cannot prove its lifetime.
            if supervisor
                .retire_browser_stage(second)
                .map_err(|e| e.to_string())?
            {
                break;
            }
            if Instant::now() >= finish_deadline {
                return Err(
                    "actual HTTP deadline did not release its original second stage".into(),
                );
            }
            http.wait(Duration::from_millis(10))
                .map_err(|e| e.to_string())?;
        }
        let retained_ms = deadline_started.elapsed().as_millis();
        if deadline_started.elapsed() < RESOURCE_HTTP_DEADLINE {
            return Err("unread HTTP body released before its real request deadline".into());
        }
        // Only AFTER the directly observed second stage retirement may parent
        // cleanup finish; its elapsed time is not attributed to the HTTP body.
        while !supervisor.try_shutdown().map_err(|e| e.to_string())? {
            if Instant::now() >= finish_deadline {
                return Err(
                    "same supervisor parents did not finish after HTTP body release".into(),
                );
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        if fixture.artifact_root.exists() || fixture.preparation_root.exists() {
            return Err(
                "same supervisor reported shutdown before its actual parents disappeared".into(),
            );
        }
        drop(second_peer);
        Ok(serde_json::json!({
            "schemaVersion":1,"scope":"actual-fixed-compiler-stage-original-borrower-static-http",
            "address":address.to_string(),"runtimeSha256":runtime_expected.sha256,
            "siteSha256":site_expected.sha256,"indexSha256":index_expected.sha256,
            "manifestSha256":manifest_expected.sha256,"startupSha256":startup_expected.sha256,
            "largeBlobSha256":first_blob.sha256,"largeBlobBytes":first_blob.length,
            "refusals":denied,"originalBodyIdentityCheckedAtResolver":true,
            "separateStageReleasedAfterActualDisconnect":true,"unreadPeerSecondStageRetiredAfterMs":retained_ms,
            "httpBorrowerBlockedStageAndSameSupervisorParentCleanup":true,
            "newBorrowRevokedAtRetirement":true,"cleanupComplete":true,
            "workerExecuted":false,"browserExecuted":false,"presenterExecuted":false,
            "sourcePublicationFreshness":"not-tested","runtimeReady":false,"presentedReady":false,"gpu":"unknown"
        }))
    })();
    // Includes controlled failure: close only this test's surface/peers. The
    // public handle cannot retain a response, so dropping the surface releases
    // every original body before this SAME owner is asked to drain again.
    drop(surface.take());
    let cleanup = fixture.cleanup();
    if let Err(error) = cleanup {
        return Err(format!("{error}; outcome={outcome:?}"));
    }
    let evidence = outcome?;
    eprintln!("{evidence}");
    Ok(())
}
