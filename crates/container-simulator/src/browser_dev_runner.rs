//! Shared managed Browser development loop for the CLI and embedding example.
//!
//! One original supervisor/owner retains its process, artifact, HTTP and browser
//! close barriers. A listening callback cannot grant execution or presentation
//! readiness, and a lost browser never permits implicit owner takeover.
use crate::browser_dev_control::ControlLimits;
use crate::browser_dev_coordinator::CoordinatorError;
use crate::browser_dev_owner::{BrowserDevOwner, OwnerError, OwnerObservation};
use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
use crate::dev::{
    BrowserRuntimePreparation, DevConfig, DevEvent, DevPackConsumer, DevSupervisor,
    PortablePackReport,
};
use crate::web::{WebSurface, WebSurfaceDrainStatus};
use crate::SimulatorConfig;
use container_ir::RendererProfile;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
const CLIENT: &str = "browser-dev";
const PREVIEW: &str = "browser-dev-primary";
const HTTP_QUIET: Duration = Duration::from_millis(250);
const ROUTE_FACT_BYTES: usize = 1024;

/// The example preserves its fresh-output evidence contract. The ordinary CLI
/// keeps each report in the supervisor's atomically allocated run namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserDevReportLocation {
    FreshOutput,
    RunDirectory,
}

/// Explicit, independently pinned inputs for the Browser QuickJS/DOM loop.
/// This runner does not load saved presentation preferences or native engines.
pub struct BrowserDevRunConfig {
    pub project: PathBuf,
    pub producer_directory: PathBuf,
    pub pins_file: PathBuf,
    pub node_bin: PathBuf,
    pub output_dir: PathBuf,
    pub host: IpAddr,
    pub port: u16,
    pub startup_intent: Vec<u8>,
    pub duration: Option<Duration>,
    pub report_location: BrowserDevReportLocation,
}

fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.len() > limit as u64 {
        return Err(format!("input must be a regular file: {}", path.display()).into());
    }
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A file replaced with a FIFO cannot block preparation in open().
        options.custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != before.len() {
        return Err(format!("input changed before open: {}", path.display()).into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != metadata.dev() || before.ino() != metadata.ino() {
            return Err(format!("input changed before open: {}", path.display()).into());
        }
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(format!("input exceeds {limit} bytes: {}", path.display()).into());
    }
    Ok(bytes)
}

// Node is already required by the fixed compiler. Its OS-backed cryptographic
// generator avoids adding a predictable credential or platform-only fallback.
// The secret is never placed in argv, URLs, stdout, reports or diagnostics.
fn credential(node: &Path) -> Result<String> {
    let output = Command::new(node)
        .args([
            "-e",
            "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    if !output.status.success()
        || output.stdout.len() != 64
        || !output
            .stdout
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err("cryptographic control credential generation failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

#[derive(Default)]
struct Observed {
    portable: Option<PortablePackReport>,
    portable_directories: BTreeSet<PathBuf>,
    directory_inventory_truncated: bool,
    watcher_exit: Option<String>,
    runtime_receipt: Option<Value>,
    presentation_receipt: Option<Value>,
    route_fallback: Option<RouteFallback>,
    route_fallback_count: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RouteFallback {
    revision: u64,
    requested_route: String,
    selected_route: String,
    truncated: bool,
}

fn bounded_route_fact(route: &str) -> (String, bool) {
    let mut end = route.len().min(ROUTE_FACT_BYTES);
    while !route.is_char_boundary(end) {
        end -= 1;
    }
    (route[..end].to_owned(), end != route.len())
}

// PortableReady owns route selection. Startup bytes are not amended when the
// pack falls back, and a warning must never become a source-failure diagnostic.
fn route_fallback(report: &PortablePackReport) -> Option<RouteFallback> {
    let requested = report.requested_route.as_deref()?;
    let normalized = requested.trim().trim_start_matches('/');
    if report.routes.iter().any(|route| route == normalized) {
        return None;
    }
    let (requested_route, requested_truncated) = bounded_route_fact(requested);
    let (selected_route, selected_truncated) =
        bounded_route_fact(report.selected_route.as_deref()?);
    Some(RouteFallback {
        revision: report.revision,
        requested_route,
        selected_route,
        truncated: requested_truncated || selected_truncated,
    })
}

impl Observed {
    fn source(&mut self, event: DevEvent) {
        match event {
            DevEvent::PortableReady { report, .. } => {
                let fallback = route_fallback(&report);
                if fallback.is_some() && fallback != self.route_fallback {
                    self.route_fallback_count = self.route_fallback_count.saturating_add(1);
                }
                self.route_fallback = fallback;
                if self.portable_directories.len() < 256 {
                    self.portable_directories
                        .insert(report.pack_directory.clone());
                } else {
                    self.directory_inventory_truncated = true;
                }
                self.portable = Some(report);
            }
            DevEvent::Diagnostic(d) => eprintln!("{}: {}", d.code, d.message),
            DevEvent::Exited(status) => {
                let status = status.to_string();
                eprintln!("compiler watcher exited: {status}");
                self.watcher_exit = Some(status);
            }
            _ => {}
        }
    }

    fn owner(&mut self, event: OwnerObservation) {
        match event {
            OwnerObservation::Source(event) => {
                let count = self.route_fallback_count;
                self.source(*event);
                if self.route_fallback_count != count {
                    if let Some(fallback) = &self.route_fallback {
                        eprintln!(
                            "ROUTE_FALLBACK: configured route {:?} is unavailable; browser startup selects {:?}",
                            fallback.requested_route, fallback.selected_route
                        );
                    }
                }
            }
            OwnerObservation::Coordination(error) => eprintln!("coordinator: {error}"),
        }
    }

    fn compile_source(&self) -> Value {
        match &self.portable {
            Some(report) => json!({
                "compilerCommit": report.compiler_commit,
                "manifestSha256": report.manifest_sha256,
                "integrityRoot": report.integrity_root,
                "sourceRevision": report.publication_token.source_revision.to_string(),
                "compilerReceiptSequence": report.publication_token.compiler_receipt_sequence.to_string(),
                "routeFallback": self.route_fallback,
                "routeFallbackCount": self.route_fallback_count,
            }),
            None => Value::Null,
        }
    }
}

fn emit(event: &Value) -> Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, event)?;
    writeln!(stdout)?;
    stdout.flush()?;
    Ok(())
}

// No timeout may drop an unresolved original process/store owner. Preparation
// has no browser, so its exact supervisor can finish cleanup without HTTP.
fn finish_preparation(supervisor: &mut DevSupervisor) {
    let mut next_notice = Instant::now();
    loop {
        match supervisor.try_shutdown() {
            Ok(true) => return,
            result if Instant::now() >= next_notice => {
                eprintln!("retaining original preparation owner; cleanup pending: {result:?}");
                next_notice = Instant::now() + Duration::from_secs(5);
            }
            _ => {}
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn queues_empty(status: WebSurfaceDrainStatus) -> bool {
    status.reading == 0
        && status.owner_resources == 0
        && status.owner_controls == 0
        && status.writing == 0
        && status.event_streams == 0
}

fn publication<T>(
    result: std::result::Result<T, OwnerError>,
    next_notice: &mut Instant,
) -> Result<Option<T>> {
    match result {
        Ok(value) => Ok(Some(value)),
        // Source barriers revoke stale stage authority during a normal watch
        // update. Busy means the original owner transition must finish first.
        // These are retry states; other owner/control/store errors are fatal.
        Err(
            error @ OwnerError::Coordinator(
                CoordinatorError::Unauthorized
                | CoordinatorError::Stale(_)
                | CoordinatorError::Busy,
            ),
        ) => {
            if Instant::now() >= *next_notice {
                eprintln!("stage publication awaits current source/transition: {error}");
                *next_notice = Instant::now() + Duration::from_secs(5);
            }
            Ok(None)
        }
        Err(error) => Err(error.into()),
    }
}

fn existence(path: &Path) -> Value {
    match fs::symlink_metadata(path) {
        Ok(_) => json!({ "path": path, "exists": true }),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            json!({ "path": path, "exists": false })
        }
        Err(error) => json!({ "path": path, "exists": null, "error": error.to_string() }),
    }
}

fn summary_path(
    output: &Path,
    location: BrowserDevReportLocation,
    run_id: Option<&str>,
) -> Result<PathBuf> {
    match location {
        BrowserDevReportLocation::FreshOutput => Ok(output.join("serve-browser-dev-summary.json")),
        BrowserDevReportLocation::RunDirectory => {
            let run_id =
                run_id.ok_or("run-specific report requires the original supervisor run id")?;
            if run_id.is_empty()
                || run_id.len() > 256
                || !run_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            {
                return Err("invalid original supervisor run id".into());
            }
            Ok(output
                .join("runs")
                .join(run_id)
                .join("browser-dev-summary.json"))
        }
    }
}

fn preflight(mut options: BrowserDevRunConfig) -> Result<BrowserDevRunConfig> {
    let intent =
        crate::browser_dev_stage_receipt::startup_intent_projection(&options.startup_intent)?;
    startup_renderer_profile(&intent)?;
    if !matches!(options.host, IpAddr::V4(address) if address.is_loopback()) {
        return Err("Browser development control requires an IPv4 loopback listener".into());
    }
    if options
        .duration
        .is_some_and(|duration| duration.is_zero() || duration > Duration::from_secs(86_400))
    {
        return Err("duration must be 1..86400 seconds".into());
    }
    options.project = fs::canonicalize(&options.project)?;
    if !options.project.is_dir() {
        return Err("Browser development project must be a directory".into());
    }
    if options.project.join("container.config.json").try_exists()? {
        return Err("ERR_UNSUPPORTED_CAPABILITY: managed source profile does not yet admit modern View inputs".into());
    }
    options.producer_directory = fs::canonicalize(&options.producer_directory)?;
    if !options.producer_directory.is_dir() {
        return Err("Browser runtime producer must be a directory".into());
    }
    options.pins_file = fs::canonicalize(&options.pins_file)?;
    if !options.pins_file.is_file() {
        return Err("independent Browser runtime pins must be a regular file".into());
    }
    options.output_dir = std::env::current_dir()?.join(&options.output_dir);
    if options.report_location == BrowserDevReportLocation::FreshOutput
        && summary_path(&options.output_dir, options.report_location, None)?.try_exists()?
    {
        return Err("summary already exists; choose a fresh --out-dir to preserve evidence".into());
    }
    Ok(options)
}

fn startup_renderer_profile(intent: &Value) -> Result<RendererProfile> {
    match &intent["rendererPolicy"] {
        policy if *policy == json!({"mode": "force", "profile": "webview"}) => {
            Ok(RendererProfile::WebView)
        }
        policy if *policy == json!({"mode": "force", "profile": "skia"}) => {
            Ok(RendererProfile::Skia)
        }
        _ => Err("ERR_UNSUPPORTED_CAPABILITY: Browser development runner requires an explicit webview or skia renderer".into()),
    }
}

fn simulator_config_from_intent(bytes: &[u8]) -> Result<SimulatorConfig> {
    let intent = crate::browser_dev_stage_receipt::startup_intent_projection(bytes)?;
    let mut simulator = SimulatorConfig {
        renderer_override: Some(startup_renderer_profile(&intent)?),
        route: intent["route"].as_str().map(str::to_owned),
        initial_data: intent.get("data").cloned().unwrap_or_else(|| json!({})),
        launch_options: intent
            .get("launchOptions")
            .cloned()
            .unwrap_or_else(|| json!({})),
        ..SimulatorConfig::default()
    };
    // The receipt validator requires integer dimensions in 1..=4096, exactly
    // representable as f32. Preserve the original bytes separately as intent.
    simulator.viewport.width = intent["viewport"]["width"]
        .as_f64()
        .ok_or("invalid viewport width")? as f32;
    simulator.viewport.height = intent["viewport"]["height"]
        .as_f64()
        .ok_or("invalid viewport height")? as f32;
    Ok(simulator)
}

fn validate_producer_report(bytes: &[u8], expected: &ProducerExpected) -> Result<()> {
    if container_ir::hex_digest(bytes) != expected.report_sha256 {
        return Err("independent producer report SHA-256 mismatch".into());
    }
    let report: Value = serde_json::from_slice(bytes)?;
    let renderer = match expected.renderer {
        RuntimeBundleRenderer::Software => "software",
        RuntimeBundleRenderer::Canvaskit => "canvaskit",
    };
    if report["status"] != "passed"
        || report["buildStatus"] != "passed"
        || report["ready"] != true
        || report["plan"]["execution"] != "worker"
        || report["plan"]["renderer"] != renderer
        || report["source"]["status"] != "passed"
        || report["source"]["sourceStable"] != true
        || report["source"]["workingTreeDirty"] != false
        || report["source"]["sourceCommit"] != expected.source_commit
        || report["source"]["sourceSha256"] != expected.source_sha256
    {
        return Err(
            "independent runtime producer is not a completed, stable pinned Worker build".into(),
        );
    }
    Ok(())
}

fn validate_producer_for_profile(
    profile: RendererProfile,
    bytes: &[u8],
    expected: &ProducerExpected,
) -> Result<()> {
    validate_producer_report(bytes, expected)?;
    if profile == RendererProfile::Skia && expected.renderer != RuntimeBundleRenderer::Canvaskit {
        return Err("ERR_UNSUPPORTED_CAPABILITY: Browser Skia requires an independently pinned CanvasKit producer; no watcher was started".into());
    }
    Ok(())
}

/// Run the original managed Browser owner until its actual close barriers pass.
/// Install the process signal handler before calling this function. A callback
/// runs only after the authenticated UI and listener have been configured.
pub fn run_browser_dev(
    options: BrowserDevRunConfig,
    shutdown: Arc<AtomicBool>,
    mut on_listening: impl FnMut(&str),
) -> Result<()> {
    let options = preflight(options)?;
    let simulator = simulator_config_from_intent(&options.startup_intent)?;
    let profile = simulator
        .renderer_override
        .ok_or("Browser startup renderer projection is missing")?;
    let pin_bytes = bounded_read(&options.pins_file, 16 * 1024)?;
    let pins: Value = serde_json::from_slice(&pin_bytes)?;
    let field = |key| -> Result<String> {
        pins["expected"][key]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("missing independent expected pin {key}").into())
    };
    let renderer = match field("renderer")?.as_str() {
        "software" => RuntimeBundleRenderer::Software,
        "canvaskit" => RuntimeBundleRenderer::Canvaskit,
        _ => return Err("unknown independently pinned renderer".into()),
    };
    let expected = ProducerExpected {
        report_sha256: field("reportSha256")?,
        source_commit: field("sourceCommit")?,
        source_sha256: field("sourceSha256")?,
        renderer,
    };
    let runtime_input = BrowserRuntimePreparation {
        producer_directory: options.producer_directory.clone(),
        expected: expected.clone(),
    };
    runtime_input.validate()?;
    runtime_input.validate_locations(&options.project, &options.output_dir)?;
    let producer_report = options.producer_directory.join("build-report.json");
    validate_producer_for_profile(
        profile,
        &bounded_read(&producer_report, 16 * 1024 * 1024)?,
        &expected,
    )?;
    let producer = json!({
        "directory": options.producer_directory, "pinsSha256": container_ir::hex_digest(&pin_bytes),
        "reportSha256": expected.report_sha256, "sourceCommit": expected.source_commit,
        "sourceSha256": expected.source_sha256, "renderer": field("renderer")?,
    });
    if shutdown.load(Ordering::SeqCst) {
        return Err("browser development preparation interrupted".into());
    }
    let secret = credential(&options.node_bin)?;
    if shutdown.load(Ordering::SeqCst) {
        return Err("browser development preparation interrupted".into());
    }
    // Bind before creating owned compiler processes. No socket is accepted
    // until the owner, policy and exact bootstrap are all configured below.
    let mut surface = WebSurface::bind_resource_only(options.host, options.port)?;
    let mut config = DevConfig::new(&options.project, simulator);
    config.workspace_root = Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    config.node_bin = options.node_bin;
    config.output_dir = options.output_dir.clone();
    config.pack_consumer = DevPackConsumer::BrowserWorker;
    config.managed_browser_sources = true;
    config.managed_browser_stages = true;
    config.browser_runtime = Some(BrowserRuntimePreparation {
        producer_directory: options.producer_directory,
        expected: expected.clone(),
    });
    let (mut supervisor, _) = DevSupervisor::spawn(config)?;
    let mut observed = Observed::default();
    let preparation = (|| -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            if shutdown.load(Ordering::SeqCst) {
                return Err("browser development preparation interrupted".into());
            }
            if let Some(event) = supervisor.poll()? {
                let failed = matches!(event, DevEvent::Diagnostic(_) | DevEvent::Exited(_));
                observed.source(event);
                if let Some(warning) = supervisor.take_route_warning() {
                    eprintln!("{}: {}", warning.code, warning.message);
                }
                if failed {
                    return Err(
                        "browser development preparation failed; see original diagnostic".into(),
                    );
                }
            }
            if supervisor.browser_runtime().is_some() && supervisor.portable_pack().is_some() {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("runtime/source preparation timed out".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    })();
    if let Err(error) = preparation {
        drop(surface);
        finish_preparation(&mut supervisor);
        return Err(error);
    }
    let mut owner = match BrowserDevOwner::new(
        supervisor,
        options.startup_intent,
        CLIENT.into(),
        PREVIEW.into(),
        ControlLimits::default(),
    ) {
        Ok(owner) => owner,
        Err(failure) => {
            let mut failure = *failure;
            drop(surface);
            finish_preparation(&mut failure.supervisor);
            return Err(failure.error.into());
        }
    };
    let run_id = owner.snapshot().run_id;
    let publication_root = options.output_dir.join("runs").join(&run_id);
    // A malformed internal run id must enter the same owner cleanup loop,
    // rather than unwinding a live owner through a newly fallible report path.
    let summary_path = summary_path(&options.output_dir, options.report_location, Some(&run_id));
    let ownership = bounded_read(&publication_root.join("dev-session.json"), 16 * 1024)
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).map_err(Into::into));
    let setup = (|| -> Result<()> {
        let summary_path = summary_path
            .as_ref()
            .map_err(|error| io::Error::other(error.to_string()))?;
        let origin = format!("http://{}", surface.local_addr());
        owner
            .enable_browser_reported_control(&mut surface, origin, secret)
            .map_err(|error| io::Error::other(format!("control setup failed: {error:?}")))?;
        owner
            .enable_control_retirement()
            .map_err(|error| io::Error::other(format!("retirement setup failed: {error:?}")))?;
        surface
            .enable_browser_dev_app_with_retirement(&owner.preview())
            .map_err(|error| io::Error::other(format!("UI setup failed: {error:?}")))?;
        emit(&json!({
            "event": "listening", "url": surface.url(), "runId": run_id,
            "preview": owner.preview(), "producer": producer,
            "compileSource": observed.compile_source(), "summaryPath": summary_path,
            "runtimeLocation": "browser", "engine": "quickjs", "renderer": profile,
            "gpuClaimed": false,
        }))?;
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            on_listening(&surface.url())
        }))
        .map_err(|_| "browser listening callback panicked")?;
        Ok(())
    })();
    let mut failure = setup.err().map(|error| error.to_string());
    let mut stopping = failure.is_some();
    let deadline = options.duration.map(|duration| Instant::now() + duration);
    let mut owner_done = false;
    let mut admission_stopped = false;
    let mut quiet_since = None;
    let mut next_notice = Instant::now();
    let mut next_source_notice = Instant::now();
    let mut control_requests_resolved = 0_usize;
    loop {
        let progress = (|| -> Result<usize> {
            surface.poll()?;
            let controls =
                owner.resolve_controls(&mut surface, &mut |event| observed.owner(event))?;
            let resources =
                surface.resolve_resource_requests(|target| owner.resolve_resource(target))?;
            // Keep explicit retained-final recovery alive even after the
            // supervisor has passed its process/store shutdown barrier.
            owner.poll(&mut |event| observed.owner(event))?;
            let snapshot = owner.snapshot();
            if let Some(receipt) = &snapshot.runtime_ready {
                observed.runtime_receipt = Some(serde_json::to_value(receipt)?);
            }
            if let Some(receipt) = &snapshot.presented_ready {
                observed.presentation_receipt = Some(serde_json::to_value(receipt)?);
            }
            stopping |= shutdown.load(Ordering::SeqCst)
                || deadline.is_some_and(|limit| Instant::now() >= limit)
                || snapshot.stopped
                || observed.watcher_exit.is_some();
            if let Some(status) = &observed.watcher_exit {
                failure.get_or_insert_with(|| format!("compiler watcher exited: {status}"));
            }
            if !stopping {
                // A source update can revoke a captured stage between ticks.
                // The same owner records that failure and keeps the executing
                // instance; retry from its next admitted portable generation.
                let _ = publication(
                    owner.stage_latest(&mut |event| observed.owner(event)),
                    &mut next_source_notice,
                )?;
                let sites = publication(
                    owner.poll_stages(&mut |event| observed.owner(event)),
                    &mut next_source_notice,
                )?;
                for site in sites.into_iter().flatten() {
                    emit(&json!({ "event": "staged", "site": site }))?;
                }
            }
            surface.poll()?;
            control_requests_resolved += controls;
            Ok(controls + resources)
        })();
        let activity = match progress {
            Ok(activity) => activity,
            Err(error) => {
                stopping = true;
                failure.get_or_insert_with(|| error.to_string());
                if Instant::now() >= next_notice {
                    eprintln!("development loop failed; retaining original HTTP/owner for cleanup: {error}");
                    next_notice = Instant::now() + Duration::from_secs(5);
                }
                0
            }
        };
        if stopping && !owner_done {
            match owner.try_shutdown(&mut |event| observed.owner(event)) {
                Ok(done) => owner_done = done,
                Err(error) if Instant::now() >= next_notice => {
                    eprintln!("same owner cleanup requires retry: {error}");
                    next_notice = Instant::now() + Duration::from_secs(5);
                }
                Err(_) => {}
            }
        }
        // Exact browser close alone does not drain the control transport. Keep
        // its original authenticated listener alive for replay and final ACK.
        // No timeout, empty socket set or quiet grace substitutes for this
        // ledger gate. A lost browser therefore leaves the process retained.
        if owner_done && owner.control_cleanup_ready() && queues_empty(surface.drain_status()) {
            let quiet = quiet_since.get_or_insert_with(Instant::now);
            if activity == 0 && quiet.elapsed() >= HTTP_QUIET {
                surface.stop_admission();
                admission_stopped = true;
            }
        } else {
            quiet_since = None;
        }
        if activity != 0 {
            quiet_since = None;
        }
        if admission_stopped && surface.drain_status().is_drained() {
            break;
        }
        if stopping && Instant::now() >= next_notice {
            eprintln!("cleanup pending; keep the elected browser open, use Stop / retry cleanup; original owner and HTTP remain retained");
            next_notice = Instant::now() + Duration::from_secs(5);
        }
        // An I/O failure must not unwind and discard a possibly live owner.
        if let Err(error) = surface.wait(Duration::from_millis(10)) {
            failure.get_or_insert_with(|| error.to_string());
            stopping = true;
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let final_snapshot = owner.snapshot();
    let drain_status = surface.drain_status();
    drop(surface);
    let summary_path = summary_path?;
    let producer_unchanged = bounded_read(&producer_report, 16 * 1024 * 1024)
        .map(|bytes| container_ir::hex_digest(&bytes) == expected.report_sha256);
    let ownership_cleanup = match ownership {
        Ok(record)
            if record["sessionId"] == run_id
                && record["ownerPid"].as_u64() == Some(u64::from(std::process::id())) =>
        {
            json!({
                "publication": existence(&publication_root),
                "preparation": record["preparationRoot"].as_str().map(|path| existence(Path::new(path))),
                "compilerOutput": record["compilerOutput"].as_str().map(|path| existence(Path::new(path))),
                "artifacts": existence(&publication_root.join("browser-artifacts")),
                "publicationMetadataRetained": true,
            })
        }
        Ok(_) => json!({ "error": "ownership record differs from the original supervisor" }),
        Err(error) => json!({ "error": error.to_string() }),
    };
    let summary = json!({
        "schemaVersion": 1, "event": "shutdown", "runId": run_id,
        "ownerShutdown": owner_done, "sameOwnerTryShutdown": true,
        "controlCleanupReady": owner.control_cleanup_ready(),
        "controlRequestsResolved": control_requests_resolved,
        "httpDrained": drain_status.is_drained(), "httpQuietGraceMs": HTTP_QUIET.as_millis(),
        "browserTransportCloseIndependentlyObserved": false,
        "closeEvidence": "correlated elected browser report; independent Worker/transport evidence belongs to browser verification",
        "finalSnapshot": final_snapshot, "producer": producer,
        "producerReportUnchanged": producer_unchanged.as_ref().ok(),
        "producerRecheckError": producer_unchanged.as_ref().err().map(ToString::to_string),
        "compileSource": observed.compile_source(),
        "runtimeReadyReceiptObserved": observed.runtime_receipt,
        "presentedReceiptObserved": observed.presentation_receipt,
        "watcher": {"pid": null, "observedExitStatus": observed.watcher_exit,
            "sameOwnerShutdownBarrierPassed": owner_done,
            "limitation": "original owner API does not expose watcher PID or final process status"},
        "ownedRoots": ownership_cleanup,
        "observedPortableDirectories": observed.portable_directories.iter().map(|path| existence(path)).collect::<Vec<_>>(),
        "portableDirectoryInventoryTruncated": observed.directory_inventory_truncated,
        "failure": failure, "gpuClaimed": false,
    });
    // Never delete the requested output directory or overwrite earlier evidence.
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&summary_path)?;
    serde_json::to_writer_pretty(&mut file, &summary)?;
    writeln!(file)?;
    file.sync_all()?;
    emit(&summary)?;
    if let Some(error) = failure {
        return Err(error.into());
    }
    if !matches!(producer_unchanged, Ok(true)) {
        return Err("producer immutability recheck failed; see summary".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dev::PortablePublicationToken;
    use std::net::Ipv4Addr;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let root = fs::canonicalize(std::env::temp_dir())
                .unwrap()
                .join(format!(
                    "browser-dev-runner-{}-{}-{}",
                    std::process::id(),
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir(&root).unwrap();
            fs::create_dir(root.join("project")).unwrap();
            fs::create_dir(root.join("producer")).unwrap();
            fs::write(root.join("pins.json"), b"{}").unwrap();
            Self(root)
        }

        fn options(&self) -> BrowserDevRunConfig {
            BrowserDevRunConfig {
                project: self.0.join("project"),
                producer_directory: self.0.join("producer"),
                pins_file: self.0.join("pins.json"),
                node_bin: self.0.join("node-must-not-run"),
                output_dir: self.0.join("output"),
                host: IpAddr::V4(Ipv4Addr::LOCALHOST),
                port: 0,
                startup_intent: intent(),
                duration: None,
                report_location: BrowserDevReportLocation::RunDirectory,
            }
        }

        fn assert_no_output(&self) {
            assert!(!self.0.join("output").exists());
            assert_eq!(fs::read_dir(self.0.join("project")).unwrap().count(), 0);
        }

        fn pin_producer(&self, report: &Value, renderer: RuntimeBundleRenderer) {
            let bytes = serde_json::to_vec(report).unwrap();
            let expected = ProducerExpected {
                renderer,
                ..expected_for(&bytes)
            };
            fs::write(self.0.join("producer/build-report.json"), bytes).unwrap();
            fs::write(
                self.0.join("pins.json"),
                serde_json::to_vec(&json!({"expected": {
                    "reportSha256": expected.report_sha256,
                    "sourceCommit": expected.source_commit,
                    "sourceSha256": expected.source_sha256,
                    "renderer": match renderer {
                        RuntimeBundleRenderer::Software => "software",
                        RuntimeBundleRenderer::Canvaskit => "canvaskit",
                    },
                }}))
                .unwrap(),
            )
            .unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn intent() -> Vec<u8> {
        intent_for(RendererProfile::WebView)
    }

    fn intent_for(profile: RendererProfile) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "schemaVersion": 1, "execution": "worker", "engine": "quickjs",
            "viewport": {"width": 375, "height": 667},
            "rendererPolicy": {"mode": "force", "profile": profile},
        }))
        .unwrap()
    }

    fn producer_report() -> Value {
        json!({
            "status": "passed", "buildStatus": "passed", "ready": true,
            "plan": {"execution": "worker", "renderer": "software"},
            "source": {
                "status": "passed", "sourceStable": true, "workingTreeDirty": false,
                "sourceCommit": "b".repeat(40), "sourceSha256": "c".repeat(64),
            },
        })
    }

    fn expected_for(bytes: &[u8]) -> ProducerExpected {
        ProducerExpected {
            report_sha256: container_ir::hex_digest(bytes),
            source_commit: "b".repeat(40),
            source_sha256: "c".repeat(64),
            renderer: RuntimeBundleRenderer::Software,
        }
    }

    fn report() -> PortablePackReport {
        PortablePackReport {
            schema_version: 1,
            revision: 7,
            pack_directory: PathBuf::from("pack-7"),
            manifest_sha256: "a".repeat(64),
            integrity_root: "b".repeat(64),
            compiler_commit: "c".repeat(40),
            routes: vec!["pages/home/index".into(), "pages/second/index".into()],
            requested_route: Some("pages/missing/index".into()),
            selected_route: Some("pages/home/index".into()),
            publication_token: PortablePublicationToken {
                source_revision: 3,
                compiler_receipt_sequence: 4,
            },
        }
    }

    #[test]
    fn startup_projection_preserves_exact_intent_and_requested_second_route() {
        for profile in [RendererProfile::WebView, RendererProfile::Skia] {
            let mut value: Value = serde_json::from_slice(&intent_for(profile)).unwrap();
            value["route"] = json!("pages/second/index");
            value["viewport"] = json!({"width": 640.0, "height": 480});
            value["data"] = json!({"count": 9.0, "nested": {"label": "test"}});
            value["launchOptions"] = json!({"scene": 1001.0});
            let bytes = serde_json::to_vec(&value).unwrap();
            let original = bytes.clone();
            let simulator = simulator_config_from_intent(&bytes).unwrap();
            assert_eq!(simulator.renderer_override, Some(profile));
            assert_eq!(simulator.route.as_deref(), Some("pages/second/index"));
            assert_eq!(
                (simulator.viewport.width, simulator.viewport.height),
                (640.0, 480.0)
            );
            assert_eq!(simulator.initial_data, value["data"]);
            assert_eq!(simulator.launch_options, value["launchOptions"]);
            assert_eq!(bytes, original);
        }
    }

    #[test]
    fn skia_projection_uses_receipt_number_semantics_without_rewriting_intent() {
        let bytes = br#"{"schemaVersion":1.0,"execution":"worker","engine":"quickjs","viewport":{"width":3.75e2,"height":667.0},"rendererPolicy":{"mode":"force","profile":"skia"},"data":{"large":9007199254740993,"underflow":-1e-400}}"#;
        let original = bytes.to_vec();
        let simulator = simulator_config_from_intent(bytes).unwrap();
        assert_eq!(simulator.renderer_override, Some(RendererProfile::Skia));
        assert_eq!(simulator.viewport.width, 375.0);
        assert_eq!(
            simulator.initial_data["large"].as_f64(),
            Some(9_007_199_254_740_992.0)
        );
        assert_eq!(
            simulator.initial_data["underflow"]
                .as_f64()
                .unwrap()
                .to_bits(),
            0
        );
        assert_eq!(bytes.as_slice(), original);
    }

    #[test]
    fn startup_projection_reuses_exact_receipt_validation() {
        let mut value: Value = serde_json::from_slice(&intent()).unwrap();
        for key in ["unknownField", "route"] {
            value[key] = json!("/invalid");
            assert!(simulator_config_from_intent(&serde_json::to_vec(&value).unwrap()).is_err());
            value.as_object_mut().unwrap().remove(key);
        }
        value["viewport"]["width"] = json!(375.5);
        assert!(simulator_config_from_intent(&serde_json::to_vec(&value).unwrap()).is_err());
    }

    #[test]
    fn invalid_renderer_or_listener_is_rejected_before_paths_or_resources() {
        let fixture = Fixture::new();
        for invalid_host in [false, true] {
            let mut options = fixture.options();
            options.project = fixture.0.join("missing-project");
            if invalid_host {
                options.host = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
            } else {
                let mut value: Value = serde_json::from_slice(&options.startup_intent).unwrap();
                value["rendererPolicy"] = json!({"mode": "manifest"});
                options.startup_intent = serde_json::to_vec(&value).unwrap();
            }
            let error = run_browser_dev(options, Arc::new(AtomicBool::new(false)), |_| {
                panic!("invalid input cannot listen")
            })
            .unwrap_err()
            .to_string();
            assert!(
                error.contains(if invalid_host { "loopback" } else { "webview" }),
                "{error}"
            );
        }
        fixture.assert_no_output();
    }

    #[test]
    fn modern_project_is_rejected_before_pins_node_and_output() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("project/container.config.json"), b"{}").unwrap();
        let error = run_browser_dev(fixture.options(), Arc::new(AtomicBool::new(false)), |_| {
            panic!("modern source cannot listen")
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("modern View"), "{error}");
        assert!(!fixture.0.join("output").exists());
        assert_eq!(fs::read_dir(fixture.0.join("project")).unwrap().count(), 1);
    }

    #[test]
    fn report_locations_preserve_fresh_example_evidence_and_namespace_cli_runs() {
        let fixture = Fixture::new();
        let mut options = fixture.options();
        fs::create_dir(&options.output_dir).unwrap();
        let old = options.output_dir.join("serve-browser-dev-summary.json");
        fs::write(&old, b"old evidence").unwrap();
        options.report_location = BrowserDevReportLocation::FreshOutput;
        assert!(preflight(options).is_err());
        assert_eq!(fs::read(&old).unwrap(), b"old evidence");
        let options = preflight(fixture.options()).unwrap();
        let a = summary_path(&options.output_dir, options.report_location, Some("run-a")).unwrap();
        let b = summary_path(&options.output_dir, options.report_location, Some("run-b")).unwrap();
        assert_ne!(a, b);
        assert!(!a.exists() && !b.exists());
        for run in ["", ".", "..", "../run-a", "run/a", "run\\a"] {
            assert!(summary_path(&options.output_dir, options.report_location, Some(run)).is_err());
        }
    }

    #[test]
    fn producer_preflight_binds_hash_and_worker_identity_to_same_bytes() {
        let mut report = producer_report();
        let bytes = serde_json::to_vec(&report).unwrap();
        let expected = expected_for(&bytes);
        validate_producer_report(&bytes, &expected).unwrap();
        let mut tampered = bytes.clone();
        tampered.push(b' ');
        assert!(validate_producer_report(&tampered, &expected)
            .unwrap_err()
            .to_string()
            .contains("SHA-256"));
        for (key, value) in [
            ("sourceStable", json!(false)),
            ("workingTreeDirty", json!(true)),
            ("sourceCommit", json!("d".repeat(40))),
        ] {
            let original = report["source"][key].clone();
            report["source"][key] = value;
            let bytes = serde_json::to_vec(&report).unwrap();
            assert!(validate_producer_report(&bytes, &expected_for(&bytes)).is_err());
            report["source"][key] = original;
        }
        report["plan"]["execution"] = json!("main");
        let bytes = serde_json::to_vec(&report).unwrap();
        assert!(validate_producer_report(&bytes, &expected_for(&bytes)).is_err());
    }

    #[test]
    fn skia_requires_independent_canvaskit_pins_before_credentials_or_listener() {
        let fixture = Fixture::new();
        fixture.pin_producer(&producer_report(), RuntimeBundleRenderer::Software);
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut options = fixture.options();
        options.startup_intent = intent_for(RendererProfile::Skia);
        options.port = listener.local_addr().unwrap().port();
        let error = run_browser_dev(options, Arc::new(AtomicBool::new(false)), |_| {
            panic!("software pins cannot listen as Skia")
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("independently pinned CanvasKit"), "{error}");
        fixture.assert_no_output();
    }

    #[test]
    fn compatible_pinned_profiles_reach_interrupt_gate_before_resource_creation() {
        let fixture = Fixture::new();
        for (profile, renderer) in [
            (RendererProfile::WebView, RuntimeBundleRenderer::Software),
            (RendererProfile::WebView, RuntimeBundleRenderer::Canvaskit),
            (RendererProfile::Skia, RuntimeBundleRenderer::Canvaskit),
        ] {
            let mut report = producer_report();
            report["plan"]["renderer"] = json!(match renderer {
                RuntimeBundleRenderer::Software => "software",
                RuntimeBundleRenderer::Canvaskit => "canvaskit",
            });
            fixture.pin_producer(&report, renderer);
            let mut options = fixture.options();
            options.startup_intent = intent_for(profile);
            let error = run_browser_dev(options, Arc::new(AtomicBool::new(true)), |_| {
                panic!("interrupted preparation cannot listen")
            })
            .unwrap_err()
            .to_string();
            assert!(
                error.contains("preparation interrupted"),
                "{profile:?}: {error}"
            );
            fixture.assert_no_output();
        }
    }

    #[test]
    fn skia_rejects_mismatched_or_unstable_pinned_reports_before_resources() {
        let fixture = Fixture::new();
        let mut completed = producer_report();
        completed["plan"]["renderer"] = json!("canvaskit");
        let changes: [fn(&mut Value); 10] = [
            |report| report["status"] = json!("failed"),
            |report| report["buildStatus"] = json!("failed"),
            |report| report["ready"] = json!(false),
            |report| report["plan"]["execution"] = json!("main"),
            |report| report["plan"]["renderer"] = json!("software"),
            |report| report["source"]["status"] = json!("failed"),
            |report| report["source"]["sourceStable"] = json!(false),
            |report| report["source"]["workingTreeDirty"] = json!(true),
            |report| report["source"]["sourceCommit"] = json!("d".repeat(40)),
            |report| report["source"]["sourceSha256"] = json!("e".repeat(64)),
        ];
        for change in changes {
            let mut report = completed.clone();
            change(&mut report);
            fixture.pin_producer(&report, RuntimeBundleRenderer::Canvaskit);
            let mut options = fixture.options();
            options.startup_intent = intent_for(RendererProfile::Skia);
            let error = run_browser_dev(options, Arc::new(AtomicBool::new(false)), |_| {
                panic!("an invalid producer cannot listen")
            })
            .unwrap_err()
            .to_string();
            assert!(error.contains("completed, stable pinned Worker"), "{error}");
            fixture.assert_no_output();
        }
        fixture.pin_producer(&completed, RuntimeBundleRenderer::Canvaskit);
        fs::write(fixture.0.join("producer/build-report.json"), b"tampered").unwrap();
        let mut options = fixture.options();
        options.startup_intent = intent_for(RendererProfile::Skia);
        let error = run_browser_dev(options, Arc::new(AtomicBool::new(false)), |_| {
            panic!("a changed producer cannot listen")
        })
        .unwrap_err()
        .to_string();
        assert!(error.contains("SHA-256 mismatch"), "{error}");
        fixture.assert_no_output();
    }

    #[test]
    fn bounded_input_read_refuses_directories_and_oversize_bytes() {
        let fixture = Fixture::new();
        assert!(bounded_read(&fixture.0, 16).is_err());
        let file = fixture.0.join("input");
        fs::write(&file, b"12345").unwrap();
        assert_eq!(bounded_read(&file, 5).unwrap(), b"12345");
        assert!(bounded_read(&file, 4).is_err());
    }

    #[test]
    fn portable_fallback_facts_are_bounded_deduplicated_and_nonfatal() {
        let mut observed = Observed::default();
        let mut report = report();
        report.requested_route = Some("路".repeat(600));
        report.selected_route = Some("页".repeat(600));
        let publish = |report: PortablePackReport| {
            OwnerObservation::Source(Box::new(DevEvent::PortableReady {
                revision: report.revision,
                report,
            }))
        };
        observed.owner(publish(report.clone()));
        observed.owner(publish(report.clone()));
        assert_eq!(observed.route_fallback_count, 1);
        let fallback = observed.route_fallback.as_ref().unwrap();
        assert!(fallback.truncated);
        assert!(fallback.requested_route.len() <= ROUTE_FACT_BYTES);
        assert!(fallback.selected_route.len() <= ROUTE_FACT_BYTES);
        assert_eq!(observed.compile_source()["routeFallbackCount"], 1);
        assert!(observed.watcher_exit.is_none());
        report.revision += 1;
        report.requested_route = Some("pages/second/index".into());
        report.selected_route = report.requested_route.clone();
        observed.owner(publish(report));
        assert!(observed.route_fallback.is_none());
        assert_eq!(observed.route_fallback_count, 1);
        assert!(observed.portable.is_some());
    }

    #[test]
    #[cfg(unix)]
    fn occupied_port_fails_before_supervisor_watcher_or_output_creation() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let report = serde_json::to_vec(&producer_report()).unwrap();
        let expected = expected_for(&report);
        fs::write(fixture.0.join("producer/build-report.json"), report).unwrap();
        fs::write(
            fixture.0.join("pins.json"),
            serde_json::to_vec(&json!({
                "expected": {
                    "reportSha256": expected.report_sha256,
                    "sourceCommit": expected.source_commit,
                    "sourceSha256": expected.source_sha256,
                    "renderer": "software",
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let node = fixture.0.join("node-fixture");
        fs::write(&node, b"#!/bin/sh\nprintf '%064d' 0\n").unwrap();
        fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        let listener = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let mut options = fixture.options();
        options.node_bin = node;
        options.port = listener.local_addr().unwrap().port();
        let error = run_browser_dev(options, Arc::new(AtomicBool::new(false)), |_| {
            panic!("occupied port cannot listen")
        })
        .unwrap_err();
        assert!(
            error
                .to_string()
                .to_ascii_lowercase()
                .contains("address already in use"),
            "{error}"
        );
        fixture.assert_no_output();
    }
}
