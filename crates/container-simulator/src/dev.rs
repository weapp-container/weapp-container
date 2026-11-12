//! Development supervisor for the Weapp Container simulator.
//!
//! Only explicit successful-build receipts authorize packing an immutable
//! compiler snapshot. Packer processes are polled without blocking the shared
//! surface/runtime loop, and own their temporary files until publication.

use crate::{
    DevReloadKind, Simulator, SimulatorConfig, SimulatorError, SimulatorReport, TraceRetention,
};
use container_bridge::BridgeBatch;
use container_core::EngineKind;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub use crate::browser_dev_runtime_preparation::{
    BrowserRuntimePreparation, BrowserRuntimePrepared, BrowserRuntimeResource,
};
use crate::browser_dev_runtime_preparation::{BrowserRuntimePreparationOwner, PreparationUpdate};
use crate::owned_process::OwnedProcess;
#[path = "dev_managed_source.rs"]
mod managed_source;
use managed_source::ManagedSourceBuild;
#[path = "dev_browser_stage.rs"]
mod browser_stage;
pub use browser_stage::{
    BrowserStageId, BrowserStagePoll, BrowserStageResource, BrowserStageStart,
};

#[derive(Debug, thiserror::Error)]
pub enum DevError {
    #[error("project path is not a directory: {0}")]
    InvalidProject(PathBuf),
    #[error("I/O while starting development build: {0}")]
    Io(#[from] io::Error),
    #[error("development build exited unsuccessfully: {0}")]
    BuildExit(ExitStatus),
    #[error("simulator: {0}")]
    Simulator(#[from] SimulatorError),
    #[error("no workspace root contains tools/container-manifest/bin/container-pack.mjs")]
    PackerNotFound,
    #[error("development output directory must be separate from the watch output: {0}")]
    InvalidOutputDir(PathBuf),
    #[error("development supervisor has already shut down")]
    Shutdown,
    #[error(
        "ERR_ENGINE: the browser Worker pack consumer only accepts QuickJS; no watcher was started"
    )]
    BrowserEngineUnavailable,
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    BrowserRuntime(String),
}

/// Select the owner of application execution. The browser consumer performs
/// build/pack validation only; its eventual Worker owns the sole AppService.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum DevPackConsumer {
    #[default]
    LocalRuntime,
    BrowserWorker,
    /// Validated packs are consumed by native device sessions. The supervisor
    /// owns the single compiler pipeline, never an extra AppService.
    ExternalDevice,
}

impl DevPackConsumer {
    fn is_external(self) -> bool {
        self != Self::LocalRuntime
    }
}

#[derive(Clone, Debug)]
pub struct DevConfig {
    pub project: PathBuf,
    pub wv_bin: PathBuf,
    pub node_bin: PathBuf,
    /// Tool checkout containing the packer and pinned compiler. Relative
    /// overrides are resolved against the launch directory. When omitted,
    /// discovery checks the launch checkout, executable ancestry, then the
    /// application project's ancestry.
    pub workspace_root: Option<PathBuf>,
    /// Explicit compiler identity claim recorded in every portable manifest.
    /// When omitted or blank, each successful receipt supplies its effective
    /// compiler identity; legacy receipts remain explicitly `unknown`.
    pub compiler_commit: Option<String>,
    pub output_dir: PathBuf,
    pub engine: EngineKind,
    pub pack_consumer: DevPackConsumer,
    /// Opt-in static runtime preparation for BrowserWorker embedders. No HTTP,
    /// Worker execution or presentation is enabled by this setting.
    pub browser_runtime: Option<BrowserRuntimePreparation>,
    /// Explicit owned watch/pack pipeline for browser embedders. This still
    /// enables neither a browser site nor Worker execution. Requires the fixed
    /// vendor compiler, a prepared runtime and a raw-only project.
    pub managed_browser_sources: bool,
    /// Admit consuming stage jobs in the SAME artifact ledger. Requires the
    /// managed fixed compiler/source pipeline. This grants no HTTP URL,
    /// Worker startup, publication or presentation authority.
    pub managed_browser_stages: bool,
    pub simulator: SimulatorConfig,
    /// Development history budget. `Full` is available for an explicit
    /// evidence capture; the default is bounded for long-running sessions.
    pub trace_retention: TraceRetention,
    pub poll_interval: Duration,
    /// Absolute budget for one pack subprocess, independently of surface I/O.
    pub pack_timeout: Duration,
}

impl DevConfig {
    pub fn new(project: impl AsRef<Path>, simulator: SimulatorConfig) -> Self {
        let project = project.as_ref().to_path_buf();
        Self {
            output_dir: project.join(".weapp-container").join("dev"),
            project,
            wv_bin: PathBuf::from("wv"),
            node_bin: PathBuf::from("node"),
            workspace_root: None,
            compiler_commit: None,
            engine: simulator.engine,
            pack_consumer: DevPackConsumer::LocalRuntime,
            browser_runtime: None,
            managed_browser_sources: false,
            managed_browser_stages: false,
            simulator,
            trace_retention: TraceRetention::development(),
            poll_interval: Duration::from_millis(150),
            pack_timeout: Duration::from_secs(120),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct DevDiagnostic {
    pub schema_version: u32,
    pub revision: u64,
    pub phase: String,
    pub severity: String,
    pub code: String,
    pub file: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    #[serde(rename = "timestamp")]
    pub timestamp_ms: u128,
}

impl DevDiagnostic {
    fn new(revision: u64, phase: &str, code: &str, message: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            revision,
            phase: phase.to_owned(),
            severity: "error".to_owned(),
            code: code.to_owned(),
            file: None,
            message: message.into(),
            stack: None,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
        }
    }
}

/// A verified portable build, not a runtime-readiness or presentation receipt.
/// The path is immutable within this supervisor's uniquely owned run namespace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortablePackReport {
    pub schema_version: u32,
    pub revision: u64,
    pub pack_directory: PathBuf,
    pub manifest_sha256: String,
    pub integrity_root: String,
    pub compiler_commit: String,
    pub routes: Vec<String>,
    pub requested_route: Option<String>,
    pub selected_route: Option<String>,
    /// Authorization to publish a site built from this pack. Pack bytes may
    /// stay valid while a newer source observation invalidates this token.
    pub publication_token: PortablePublicationToken,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortablePublicationToken {
    pub source_revision: u64,
    pub compiler_receipt_sequence: u64,
}

/// Publication authority after an immediate source observation. Callers must
/// publish every returned diagnostic before considering a site replacement.
/// This is a point-in-time barrier, not a filesystem lock or runtime receipt.
#[derive(Debug)]
pub struct PortablePublicationCheck {
    pub authorized: bool,
    pub events: Vec<DevEvent>,
}

#[derive(Debug, Default)]
struct PortablePublicationFreshness {
    source_revision: u64,
    exhausted: bool,
}

impl PortablePublicationFreshness {
    fn invalidate(&mut self) {
        if let Some(next) = self.source_revision.checked_add(1) {
            self.source_revision = next;
        } else {
            // Never reuse an old token even at counter exhaustion.
            self.exhausted = true;
        }
    }

    fn token(&self, compiler_receipt_sequence: u64) -> PortablePublicationToken {
        PortablePublicationToken {
            source_revision: self.source_revision,
            compiler_receipt_sequence,
        }
    }
}

#[derive(Debug)]
pub enum DevEvent {
    BuildStarted,
    PackReady {
        revision: u64,
        reload: Option<DevReloadKind>,
        report: SimulatorReport,
    },
    /// Only validates a new pack. A browser build coordinator must separately
    /// stage assets, publish its generation, and observe real Worker startup.
    PortableReady {
        revision: u64,
        report: PortablePackReport,
    },
    /// An independently pinned static runtime has been retained. This is not
    /// a runtime-ready, staged application, or presented-frame notification.
    BrowserRuntimePrepared {
        report: BrowserRuntimePrepared,
    },
    RuntimeUpdated {
        revision: u64,
        batch: BridgeBatch,
        report: SimulatorReport,
    },
    Diagnostic(DevDiagnostic),
    Exited(ExitStatus),
}

// A supervisor can be embedded more than once in the same process (for
// example, a test runner may host a Web and a desktop surface side by side).
// Process id + revision alone is not unique in that case, so use a process
// local sequence when naming staging, run and input snapshot directories.
// Compiler/source preparation lives outside the watched project; atomic
// pack publication remains on the configured output filesystem.
static NEXT_SNAPSHOT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct BuildOutput {
    line: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildReceipt {
    protocol_version: String,
    session_id: String,
    sequence: u64,
    kind: ReceiptKind,
    snapshot: Option<String>,
    #[serde(default, deserialize_with = "deserialize_compiler_commit")]
    compiler_commit: Option<String>,
    message: Option<String>,
}

fn deserialize_compiler_commit<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let commit = String::deserialize(deserializer)?;
    if !matches!(commit.len(), 40 | 64)
        || !commit
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(serde::de::Error::custom(
            "receipt compilerCommit must be 40 or 64 lowercase hexadecimal characters",
        ));
    }
    Ok(Some(commit))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReceiptKind {
    Building,
    Success,
    Error,
}

#[derive(Clone, Debug)]
struct ReadySnapshot {
    sequence: u64,
    path: PathBuf,
    compiler_commit: String,
    ready_at: Instant,
    // The latest raw compiler generation also owns this directory. Modern
    // source-only changes may therefore repack it without asking wv to emit
    // another build or reading its mutable output tree.
    _owner: Arc<SnapshotOwner>,
}

#[derive(Debug)]
struct SnapshotOwner(PathBuf);

impl Drop for SnapshotOwner {
    fn drop(&mut self) {
        remove_owned_directory(&self.0);
    }
}

#[derive(Debug)]
struct PreparationOwner {
    path: PathBuf,
    active: bool,
    preserve_on_drop: bool,
}

impl PreparationOwner {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            active: true,
            preserve_on_drop: false,
        }
    }

    fn try_release(&mut self) -> io::Result<()> {
        if self.active {
            match fs::remove_dir_all(&self.path) {
                Ok(()) => self.active = false,
                Err(error) if error.kind() == io::ErrorKind::NotFound => self.active = false,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn release(&mut self) {
        if std::mem::replace(&mut self.active, false) {
            remove_owned_directory(&self.path);
        }
    }
}

impl Drop for PreparationOwner {
    fn drop(&mut self) {
        if self.active && self.preserve_on_drop {
            eprintln!(
                "weapp-simulator: managed watcher cleanup incomplete; retaining {}",
                self.path.display()
            );
        } else {
            self.release();
        }
    }
}

/// Owns preparation files on every early return, including spawn failures.
#[derive(Debug)]
struct PackFiles {
    snapshot: ReadySnapshot,
    staging: PathBuf,
    project_snapshot: Option<PathBuf>,
}

impl Drop for PackFiles {
    fn drop(&mut self) {
        remove_owned_directory(&self.staging);
        if let Some(project) = &self.project_snapshot {
            remove_owned_directory(project);
        }
    }
}

#[derive(Debug)]
struct PendingPack {
    child: OwnedProcess,
    files: PackFiles,
    generation: PathBuf,
    fingerprint: u64,
    revision: u64,
    deadline: Instant,
    obsolete: bool,
    modern_inputs: Option<u64>,
}

#[derive(Debug)]
struct AcceptedPackInputs {
    dependencies: BTreeSet<PathBuf>,
    modern_inputs: Option<u64>,
    build_identity: (u64, String),
    raw_source_inputs: Option<BTreeMap<PathBuf, u64>>,
}

#[derive(Debug)]
struct DeferredBrowserPack {
    generation: PathBuf,
    revision: u64,
    reload: Option<DevReloadKind>,
    previous_route: Option<String>,
    configured_route: Option<String>,
    inputs: AcceptedPackInputs,
}

fn portable_pack_report(
    staging: &Path,
    published: &Path,
    revision: u64,
    requested_route: Option<&str>,
    publication_token: PortablePublicationToken,
) -> Result<PortablePackReport, SimulatorError> {
    let validated = crate::read_validated_pack(staging)?;
    let selected_route = crate::route_for_manifest(requested_route, None, &validated.manifest);
    Ok(PortablePackReport {
        schema_version: 1,
        revision,
        pack_directory: published.to_owned(),
        manifest_sha256: container_ir::hex_digest(&validated.manifest_bytes),
        integrity_root: validated.manifest.integrity.root.clone(),
        compiler_commit: validated.manifest.compiler.commit.clone(),
        routes: validated
            .manifest
            .routes
            .iter()
            .map(|route| route.path.clone())
            .collect(),
        requested_route: requested_route.map(str::to_owned),
        selected_route,
        publication_token,
    })
}

fn portable_route_warning(report: &PortablePackReport) -> Option<DevDiagnostic> {
    let requested = report.requested_route.as_deref()?;
    let normalized = requested.trim().trim_start_matches('/');
    if report.routes.iter().any(|route| route == normalized) {
        return None;
    }
    let selected = report.selected_route.as_deref()?;
    let mut warning = DevDiagnostic::new(
        report.revision,
        "pack",
        "ROUTE_FALLBACK",
        format!(
            "configured route {requested:?} is unavailable; browser startup selects {selected:?}"
        ),
    );
    warning.severity = "warning".to_owned();
    Some(warning)
}

fn remove_owned_directory(path: &Path) {
    if let Err(error) = fs::remove_dir_all(path) {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!("weapp-simulator: cannot remove {}: {error}", path.display());
        }
    }
}

/// Owns the long-running `wv <project>` development process and the latest valid
/// portable pack.  Consumers call [`Self::poll`] from their event loop.
pub struct DevSupervisor {
    config: DevConfig,
    browser_runtime: Option<BrowserRuntimePreparationOwner>,
    child: Option<OwnedProcess>,
    managed_source: Option<ManagedSourceBuild>,
    build_output_rx: Receiver<BuildOutput>,
    output_readers: Vec<JoinHandle<()>>,
    output_drained: bool,
    watcher_exit_observed: bool,
    /// Compiler filesystem observations have their own cadence. The surface
    /// loop must remain free to service sockets, input, timers and deadlines.
    last_compiler_poll: Option<Instant>,
    simulator: Option<Simulator>,
    accepted_portable: Option<PortablePackReport>,
    portable_freshness: PortablePublicationFreshness,
    revision: u64,
    last_build_identity: Option<(u64, String)>,
    pending_snapshot: Option<ReadySnapshot>,
    latest_raw_snapshot: Option<ReadySnapshot>,
    raw_build_ready: bool,
    modern_inputs: Option<u64>,
    modern_input_error: Option<String>,
    modern_dependencies: BTreeSet<PathBuf>,
    modern_recovery_watch: bool,
    raw_source_inputs: Option<BTreeMap<PathBuf, u64>>,
    last_modern_poll: Instant,
    pending_pack: Option<PendingPack>,
    deferred_browser_pack: Option<DeferredBrowserPack>,
    workspace_root: PathBuf,
    // Atomically reserved for this supervisor and retained with its published
    // generations. Reusing --out-dir must never reuse an earlier run's paths.
    run_root: PathBuf,
    // Compiler artifacts contain complete app.json/WXML trees. They must
    // never become new inputs to the compiler's recursive source watchers,
    // including when --out-dir is inside the project (the default).
    preparation_root: PreparationOwner,
    build_output: PathBuf,
    compiler_commit: Option<String>,
    receipt_root: PathBuf,
    receipt_session: String,
    last_receipt_sequence: u64,
    receipt_required_reported: bool,
    diagnostic_active: bool,
    /// Fingerprint of the last malformed source app.json diagnostic. A watch
    /// compiler may keep the previous `dist/` tree when this file is invalid,
    /// so the output fingerprint alone cannot detect the failed rebuild.
    source_error_fingerprint: Option<u64>,
    /// A route can disappear while a watch build is otherwise valid. Keep the
    /// warning separate from fatal build diagnostics so the successful pack
    /// can be published first and the browser can show the fallback reason
    /// after its overlay is cleared by the reload event.
    route_warning: Option<DevDiagnostic>,
    stopped: bool,
}

impl std::fmt::Debug for DevSupervisor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DevSupervisor")
            .field("project", &self.config.project)
            .field("revision", &self.revision)
            .field("has_simulator", &self.simulator.is_some())
            .finish_non_exhaustive()
    }
}

impl DevSupervisor {
    pub fn spawn(mut config: DevConfig) -> Result<(Self, DevEvent), DevError> {
        if config.pack_consumer == DevPackConsumer::BrowserWorker
            && config.engine != EngineKind::Quickjs
        {
            return Err(DevError::BrowserEngineUnavailable);
        }
        if let Some(input) = &config.browser_runtime {
            if config.pack_consumer != DevPackConsumer::BrowserWorker {
                return Err(DevError::BrowserRuntime(
                    "static browser runtime requires BrowserWorker consumer".into(),
                ));
            }
            input.validate().map_err(DevError::BrowserRuntime)?;
        }
        if config.managed_browser_sources
            && (config.pack_consumer != DevPackConsumer::BrowserWorker
                || config.browser_runtime.is_none()
                || config.wv_bin != Path::new("wv"))
        {
            return Err(DevError::BrowserRuntime("managed sources require BrowserWorker, independent runtime pins and the fixed vendor compiler".into()));
        }
        if config.managed_browser_stages && !config.managed_browser_sources {
            return Err(DevError::BrowserRuntime(
                "consuming browser stages require the actual managed source pipeline".into(),
            ));
        }
        // `DevConfig` exposes the selected engine for surface diagnostics,
        // while `SimulatorConfig` carries the runtime startup options. Keep
        // the two public configuration views consistent for embedders that
        // construct `DevConfig` directly instead of going through the CLI.
        config.simulator.engine = config.engine;
        // Command::current_dir changes how relative executable paths are
        // resolved. Normalize explicit tool paths against the caller's cwd
        // first, while retaining bare `wv`/`node` so PATH discovery keeps
        // working and the pinned vendor `wv` lookup remains available.
        let launch_dir = std::env::current_dir()?;
        if config.wv_bin != Path::new("wv") && !config.wv_bin.is_absolute() {
            config.wv_bin = launch_dir.join(&config.wv_bin);
        }
        if config.node_bin != Path::new("node") && !config.node_bin.is_absolute() {
            config.node_bin = launch_dir.join(&config.node_bin);
        }
        let project = fs::canonicalize(&config.project)
            .map_err(|_| DevError::InvalidProject(config.project.clone()))?;
        if !project.is_dir() {
            return Err(DevError::InvalidProject(project));
        }
        config.project = project.clone();
        let executable = std::env::current_exe().ok();
        let workspace_root = resolve_workspace_root(
            config.workspace_root.as_deref(),
            &launch_dir,
            executable.as_deref(),
            &project,
        )
        .ok_or(DevError::PackerNotFound)?;
        if config.managed_browser_sources {
            let pin = managed_source::fixed_compiler(&workspace_root)?;
            if config
                .compiler_commit
                .as_ref()
                .filter(|claim| !claim.trim().is_empty())
                .is_some_and(|claim| claim != &pin)
            {
                return Err(DevError::BrowserRuntime(
                    "managed compiler claim differs from fixed submodule".into(),
                ));
            }
            config.compiler_commit = Some(pin);
            if project.join("container.config.json").try_exists()? {
                return Err(DevError::BrowserRuntime(
                    "managed source profile does not yet admit modern View inputs".into(),
                ));
            }
        }
        let compiler_commit = config
            .compiler_commit
            .clone()
            .filter(|value| !value.trim().is_empty());
        let output_root = if config.output_dir.is_absolute() {
            config.output_dir.clone()
        } else {
            std::env::current_dir()?.join(&config.output_dir)
        };
        // The adapter uses the pinned compiler's public API and freezes each
        // successful END before publishing its receipt. Filesystem quietness
        // is never evidence that a mutable dist tree is a complete build.
        let project_output = resolve_watch_output(&project);
        if paths_overlap(&project_output, &output_root) {
            return Err(DevError::InvalidOutputDir(output_root));
        }
        if let Some(input) = &config.browser_runtime {
            input
                .validate_locations(&project, &lexical_normalize(&output_root))
                .map_err(DevError::BrowserRuntime)?;
        }
        fs::create_dir_all(&output_root)?;
        let (receipt_session, run_root) = allocate_run_namespace(&output_root)?;
        let mut preparation_root = PreparationOwner::new(allocate_preparation_namespace(&project)?);
        // The public compiler adapter receives its own mutable output tree.
        // Neither another supervisor's output nor the project's ordinary
        // DevTools dist directory is owned by this invocation.
        let build_output = preparation_root.path.join(".build-output");
        fs::create_dir(&build_output)?;
        // Runtime input and compiler receipts both need a new identity across
        // process restarts, even when the same project/out-dir is reused.
        config.simulator.session_id =
            format!("{}-dev-{receipt_session}", config.simulator.session_id);
        let receipt_root = preparation_root.path.join(".compiler");
        fs::create_dir_all(receipt_root.join("receipts"))?;
        fs::create_dir_all(receipt_root.join("snapshots"))?;
        // Tooling reads this ownership record instead of inferring that raw
        // compiler bytes share the publication directory. No input-tree
        // symlink or copy is created for disposable preparation artifacts.
        fs::write(
            run_root.join("dev-session.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "sessionId": receipt_session,
                "ownerPid": std::process::id(),
                "publicationRoot": fs::canonicalize(&run_root)?,
                "preparationRoot": preparation_root.path,
                "compilerOutput": fs::canonicalize(&build_output)?,
            }))
            .map_err(io::Error::other)?,
        )?;
        // Allocate the metadata-only owner before spawning the watcher. Its
        // first poll creates the input/tools/job namespace, so a later watcher
        // spawn failure cannot discard any live artifact recovery owner.
        let browser_runtime = config
            .browser_runtime
            .take()
            .map(|input| {
                let root = fs::canonicalize(&run_root)
                    .map_err(|e| e.to_string())?
                    .join("browser-artifacts");
                if config.managed_browser_stages {
                    BrowserRuntimePreparationOwner::new_with_stages(
                        input,
                        config.node_bin.clone(),
                        config.pack_timeout,
                        root,
                    )
                } else if config.managed_browser_sources {
                    BrowserRuntimePreparationOwner::new_with_sources(
                        input,
                        config.node_bin.clone(),
                        config.pack_timeout,
                        root,
                        true,
                    )
                } else {
                    BrowserRuntimePreparationOwner::new(
                        input,
                        config.node_bin.clone(),
                        config.pack_timeout,
                        root,
                    )
                }
            })
            .transpose()
            .map_err(DevError::BrowserRuntime)?;
        let mut child_command = watch_adapter_command(
            &config.node_bin,
            &config.wv_bin,
            &workspace_root,
            &project,
            &build_output,
        );
        child_command
            .current_dir(&project)
            // The simulator owns its Web listener and does not need the
            // compiler's separate MCP/DevTools listener. The env boundary is
            // also understood by pinned CLI builds whose default command
            // does not forward the --no-mcp option.
            .env("WEAPP_VITE_MCP", "0")
            .env("WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR", &receipt_root)
            .env("WEAPP_CONTAINER_SIMULATOR_SESSION_ID", &receipt_session)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The owner establishes Unix process-group or Windows suspended
        // Job Object ownership before a compiler wrapper can start workers.
        let (build_output_tx, build_output_rx) = mpsc::channel();
        let mut output_readers = Vec::new();
        let (child, managed_source) = if config.managed_browser_sources {
            // No watcher can run until the full supervisor owns all startup
            // recovery state. The actual bound owner starts on its first turn.
            (
                None,
                Some(ManagedSourceBuild::new(child_command, build_output_tx)),
            )
        } else {
            let mut child = OwnedProcess::spawn(&mut child_command).inspect_err(|_| {
                let _ = fs::remove_dir_all(&receipt_root);
                remove_owned_directory(&build_output);
            })?;
            if let Some(stdout) = child.take_stdout() {
                output_readers.push(spawn_output_reader(stdout, build_output_tx.clone()));
            }
            if let Some(stderr) = child.take_stderr() {
                output_readers.push(spawn_output_reader(stderr, build_output_tx.clone()));
            }
            (Some(child), None)
        };

        preparation_root.preserve_on_drop = config.managed_browser_sources;
        let supervisor = Self {
            config,
            browser_runtime,
            child,
            managed_source,
            build_output_rx,
            output_readers,
            output_drained: false,
            watcher_exit_observed: false,
            last_compiler_poll: None,
            simulator: None,
            accepted_portable: None,
            portable_freshness: PortablePublicationFreshness::default(),
            revision: 0,
            last_build_identity: None,
            pending_snapshot: None,
            latest_raw_snapshot: None,
            raw_build_ready: false,
            modern_inputs: None,
            modern_input_error: None,
            modern_dependencies: BTreeSet::new(),
            modern_recovery_watch: false,
            raw_source_inputs: None,
            last_modern_poll: Instant::now(),
            pending_pack: None,
            deferred_browser_pack: None,
            workspace_root,
            run_root,
            preparation_root,
            build_output,
            compiler_commit,
            receipt_root,
            receipt_session,
            last_receipt_sequence: 0,
            receipt_required_reported: false,
            diagnostic_active: false,
            source_error_fingerprint: None,
            route_warning: None,
            stopped: false,
        };
        Ok((supervisor, DevEvent::BuildStarted))
    }

    pub fn simulator(&self) -> Option<&Simulator> {
        self.simulator.as_ref()
    }

    pub fn simulator_mut(&mut self) -> Option<&mut Simulator> {
        self.simulator.as_mut()
    }

    /// Latest pack-only publication. Its existence says nothing about a
    /// browser Worker, accepted pixels, input readiness, or GPU availability.
    pub fn portable_pack(&self) -> Option<&PortablePackReport> {
        self.accepted_portable.as_ref()
    }

    /// Latest verified static runtime. Application source publication and
    /// browser execution must independently succeed before using it in a site.
    pub fn browser_runtime(&self) -> Option<&BrowserRuntimePrepared> {
        self.browser_runtime
            .as_ref()
            .and_then(|owner| owner.report())
    }

    /// Borrow original verified runtime bytes. A live borrower deliberately
    /// makes try_shutdown return false; release it and retry on this owner.
    pub fn browser_runtime_resource(
        &mut self,
        path: &str,
    ) -> Result<Option<BrowserRuntimeResource>, DevError> {
        match self.browser_runtime.as_mut() {
            Some(owner) => owner.resource(path).map_err(DevError::BrowserRuntime),
            None => Ok(None),
        }
    }

    /// Observe receipts, source configuration and modern View dependencies
    /// without the ordinary watch debounce before offering/activating a site.
    /// A last valid pack remains readable/runnable while publication authority
    /// expires. This never creates, pauses or retires an AppService. Diagnostic
    /// events belong to the caller's existing source overlay/history pipeline.
    pub fn check_portable_publication(
        &mut self,
        report: &PortablePackReport,
    ) -> PortablePublicationCheck {
        let mut events = Vec::new();
        if !self.stopped && self.config.pack_consumer.is_external() {
            if self.managed_source.is_some() {
                match self.poll_managed_source() {
                    Ok(Some(event)) => events.push(event),
                    Err(error) => {
                        self.portable_freshness.invalidate();
                        self.diagnostic_active = true;
                        events.push(DevEvent::Diagnostic(DevDiagnostic::new(
                            self.revision,
                            "build",
                            "ERR_BROWSER_DEV_ARTIFACT",
                            error.to_string(),
                        )));
                    }
                    _ => {}
                }
            } else {
                if let Some(event) = self.poll_compiler_inputs(true) {
                    events.push(event);
                }
                if let Some(event) = self.observe_modern_inputs() {
                    events.push(event);
                }
            }
            // The compiler's BUILDING receipt can lag behind a valid raw edit.
            // Check the accepted source identities as well. Pending modern work
            // discovers its full closure before classifying new helpers as raw;
            // it already prevents publication and must remain packable without
            // a new upstream receipt.
            if self.raw_build_ready
                && self.pending_snapshot.is_none()
                && self.pending_pack.is_none()
                && self.source_error_fingerprint.is_none()
                && self.modern_input_error.is_none()
            {
                match self
                    .modern_watch_paths()
                    .and_then(|paths| self.raw_inputs_unchanged(&paths))
                {
                    Ok(true) => {}
                    result => {
                        self.supersede_pending();
                        self.raw_build_ready = false;
                        if let Err(error) = result {
                            self.diagnostic_active = true;
                            events.push(DevEvent::Diagnostic(DevDiagnostic::new(
                                self.revision,
                                "build",
                                "BUILD_FAILED",
                                error.to_string(),
                            )));
                        }
                    }
                }
            }
        }
        PortablePublicationCheck {
            authorized: self.portable_publication_matches(report),
            events,
        }
    }

    fn portable_publication_matches(&self, report: &PortablePackReport) -> bool {
        self.config.pack_consumer.is_external()
            && !self.stopped
            && !self.portable_freshness.exhausted
            && self.accepted_portable.as_ref() == Some(report)
            && report.publication_token == self.portable_freshness.token(self.last_receipt_sequence)
            && !self.diagnostic_active
            && self.source_error_fingerprint.is_none()
            && self.modern_input_error.is_none()
            && self.raw_build_ready
            && self.pending_snapshot.is_none()
            && self.pending_pack.is_none()
            && self.managed_source.as_ref().map_or_else(
                || {
                    fs::read_dir(self.receipt_root.join("receipts")).is_ok_and(|mut entries| {
                        !entries.any(|entry| {
                            entry.map_or(true, |entry| {
                                entry
                                    .path()
                                    .extension()
                                    .is_some_and(|extension| extension == "json")
                            })
                        })
                    })
                },
                |source| source.publication_current(self),
            )
    }

    /// Advance timers and frame invalidation independently from the compiler
    /// watcher. A failed build must leave the last valid app interactive.
    pub fn pump_runtime(&mut self, now_ns: u64) -> Result<Option<DevEvent>, DevError> {
        self.pump_runtime_with_render(now_ns, true)
    }

    /// FPS throttles automatic redraw only; host timers still advance on every tick.
    pub fn pump_runtime_with_render(
        &mut self,
        now_ns: u64,
        allow_render: bool,
    ) -> Result<Option<DevEvent>, DevError> {
        if self.stopped {
            return Ok(None);
        }
        let Some(simulator) = self.simulator.as_mut() else {
            return Ok(None);
        };
        let previous_browser_request = simulator
            .browser_render_request()
            .map(|request| request.revision.clone());
        let batch = simulator.pump_with_render(now_ns, allow_render)?;
        // DOM preparation is deferred to the browser owner and deliberately
        // emits no render.commit response. Its queued request is nevertheless
        // a presentation update that the supervisor must publish to surfaces.
        let browser_request_changed = simulator
            .browser_render_request()
            .map(|request| request.revision.as_str())
            != previous_browser_request.as_deref();
        if batch.messages.is_empty() && !browser_request_changed {
            return self.reconcile_deferred_browser_pack();
        }
        Ok(Some(DevEvent::RuntimeUpdated {
            revision: self.revision,
            batch,
            report: simulator.report("ready"),
        }))
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub fn engine(&self) -> EngineKind {
        self.config.engine
    }

    /// Logical viewport requested for the development session.  Desktop
    /// surfaces use this for their initial window size; subsequent resizes are
    /// owned by the native window event loop and do not mutate the runtime
    /// viewport.
    pub fn viewport_size(&self) -> (u32, u32) {
        (
            self.config.simulator.viewport.width.max(1.0) as u32,
            self.config.simulator.viewport.height.max(1.0) as u32,
        )
    }

    pub fn project(&self) -> &Path {
        &self.config.project
    }

    /// Commit development presentation values for future full pack reloads.
    pub fn set_presentation_config(&mut self, viewport: container_render_skia::Rect, scale: f64) {
        self.config.simulator.viewport = viewport;
        self.config.simulator.render_scale = scale;
    }

    /// Consume the warning generated when a valid pack no longer contains the
    /// configured or currently visible route.  The warning is consumed by a
    /// surface after the corresponding `PackReady` event so it is emitted
    /// after the successful reload has cleared stale build overlays.
    pub fn take_route_warning(&mut self) -> Option<DevDiagnostic> {
        self.route_warning.take()
    }

    /// Poll receipts, subprocesses and output without waiting for a build.
    /// Only the compiler adapter's immutable success snapshots are packable.
    pub fn poll(&mut self) -> Result<Option<DevEvent>, DevError> {
        if self.stopped {
            return Ok(None);
        }
        if let Some(event) = self.reconcile_deferred_browser_pack()? {
            return Ok(Some(event));
        }
        // Give the finite artifact lane one bounded process step before any
        // source-event early return. It never borrows the local AppService.
        if let Some(cause) = self
            .browser_runtime
            .as_mut()
            .and_then(|owner| owner.advance_stages())
        {
            return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                self.revision,
                "browser-stage",
                "ERR_BROWSER_DEV_ARTIFACT",
                cause,
            ))));
        }
        if let Some(update) = self.browser_runtime.as_mut().and_then(|owner| owner.poll()) {
            return Ok(Some(match update {
                PreparationUpdate::Prepared(report) => DevEvent::BrowserRuntimePrepared { report },
                PreparationUpdate::Failed(cause) => DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "browser-runtime",
                    "ERR_BROWSER_DEV_ARTIFACT",
                    cause,
                )),
            }));
        }
        if self.managed_source.is_some() {
            return self.poll_managed_source();
        }
        let output_just_drained = self.poll_build_output();
        let status = self.child.as_mut().expect("legacy watcher").try_wait()?;
        let watcher_just_exited = status.is_some() && !self.watcher_exit_observed;
        self.watcher_exit_observed |= status.is_some();
        // Reader disconnection and process exit are separate boundaries: a
        // final receipt can arrive after observing exit but before EOF.
        if let Some(event) = self.poll_compiler_inputs(output_just_drained || watcher_just_exited) {
            return Ok(Some(event));
        }
        if let Some(event) = self.poll_modern_inputs() {
            return Ok(Some(event));
        }
        if let Some(event) = self.poll_pending_pack()? {
            return Ok(Some(event));
        }
        if self.source_error_fingerprint.is_none()
            && self.modern_input_error.is_none()
            && self.pending_pack.is_none()
        {
            if let Some(event) = self.start_pending_pack()? {
                return Ok(Some(event));
            }
        }
        if status.is_some() && self.last_receipt_sequence == 0 && !self.receipt_required_reported {
            self.receipt_required_reported = true;
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                self.revision,
                "build",
                "BUILD_RECEIPT_REQUIRED",
                "builder exited without a versioned build receipt",
            ))));
        }
        // Drain reader threads and final receipts before exposing watcher exit.
        // This also preserves the final success from a short-lived fake wv.
        if self.pending_pack.is_none()
            && self.deferred_browser_pack.is_none()
            && self.pending_snapshot.is_none()
            && self.output_drained
            && self
                .browser_runtime
                .as_ref()
                .is_none_or(|owner| owner.is_settled())
        {
            return Ok(status.map(DevEvent::Exited));
        }
        Ok(None)
    }

    fn poll_build_output(&mut self) -> bool {
        let was_drained = self.output_drained;
        // Bound terminal traffic per tick so a noisy compiler cannot starve
        // HTTP, input or the runtime pump. Logs carry no completion semantics.
        for _ in 0..256 {
            match self.build_output_rx.try_recv() {
                Ok(output) => {
                    if !output.line.trim().is_empty() {
                        eprintln!("wv: {}", output.line.trim());
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    self.output_drained = true;
                    break;
                }
            }
        }
        !was_drained && self.output_drained
    }

    fn poll_compiler_inputs(&mut self, force: bool) -> Option<DevEvent> {
        if !force
            && self
                .last_compiler_poll
                .is_some_and(|last| last.elapsed() < self.config.poll_interval)
        {
            return None;
        }
        self.last_compiler_poll = Some(Instant::now());
        let receipt_diagnostic = self.poll_receipts();
        if let Some((fingerprint, path, message)) = self.source_app_json_error() {
            self.supersede_pending();
            if self.source_error_fingerprint != Some(fingerprint) {
                self.source_error_fingerprint = Some(fingerprint);
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                let mut diagnostic =
                    DevDiagnostic::new(self.revision, "build", "BUILD_FAILED", message);
                diagnostic.file = Some(path.to_string_lossy().into_owned());
                return Some(DevEvent::Diagnostic(diagnostic));
            }
        } else {
            self.source_error_fingerprint = None;
        }
        if receipt_diagnostic.is_some() {
            return receipt_diagnostic;
        }
        // A custom builder must explicitly implement the receipt protocol.
        // A packable or quiet dist tree never substitutes for that handshake.
        // Inspecting legacy output belongs to the same compiler cadence.
        if self.last_receipt_sequence == 0
            && !self.receipt_required_reported
            && self.build_output.join("app.json").is_file()
        {
            self.receipt_required_reported = true;
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            return Some(DevEvent::Diagnostic(DevDiagnostic::new(
                self.revision,
                "build",
                "BUILD_RECEIPT_REQUIRED",
                "builder has no versioned success receipt; custom --wv-bin must implement WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR / WEAPP_CONTAINER_SIMULATOR_SESSION_ID protocol 1.0",
            )));
        }
        None
    }

    fn supersede_pending(&mut self) {
        // Source observations revoke permission to publish a newly completed
        // browser site, not the lifetime of the previously running instance.
        self.portable_freshness.invalidate();
        self.pending_snapshot = None;
        if let Some(pending) = self.pending_pack.as_mut() {
            if !pending.obsolete {
                pending.obsolete = true;
                signal_owned_process(&mut pending.child);
            }
        }
    }

    fn modern_project_identity(&self) -> io::Result<Option<u64>> {
        // Once a project has enabled modern View, removing its config is also
        // an input change and must produce a candidate rather than leaving a
        // stale modern generation running indefinitely.
        let config = self.config.project.join("container.config.json");
        if !config.try_exists()? && self.modern_inputs.is_none() {
            return Ok(None);
        }
        let tracked = tracked_input_fingerprint(&self.modern_watch_paths()?)?;
        if self.modern_recovery_watch {
            // Failed resolution can leave unknown transitive imports or
            // missing extension candidates. Temporarily observe local source
            // changes, then narrow back to the successful compiler closure.
            let all = project_input_fingerprint(
                &self.config.project,
                &[
                    resolve_watch_output(&self.config.project),
                    self.run_root.clone(),
                ],
            )?;
            Ok(Some(combined_build_fingerprint(all, Some(tracked))))
        } else {
            Ok(Some(tracked))
        }
    }

    fn modern_watch_paths(&self) -> io::Result<BTreeSet<PathBuf>> {
        let mut paths = self.modern_dependencies.clone();
        paths.extend(modern_config_inputs(&self.config.project)?);
        if let Some(compilation) = self
            .simulator
            .as_ref()
            .and_then(|simulator| simulator.manifest().modern_view.as_ref())
        {
            for source in compilation.units.iter().flat_map(|unit| &unit.sources) {
                if !source.path.starts_with("npm:") {
                    if let Some(path) = safe_project_child(&self.config.project, &source.path) {
                        paths.insert(path);
                    }
                }
            }
        }
        Ok(paths)
    }

    fn raw_inputs_unchanged(&self, modern_paths: &BTreeSet<PathBuf>) -> io::Result<bool> {
        let Some(previous) = self.raw_source_inputs.as_ref() else {
            return Ok(false);
        };
        let current = project_input_identities(
            &self.config.project,
            &[
                resolve_watch_output(&self.config.project),
                self.run_root.clone(),
            ],
        )?;
        let shared_inputs = [
            "package.json",
            "pnpm-lock.yaml",
            "package-lock.json",
            "yarn.lock",
            "bun.lock",
            "bun.lockb",
        ];
        let is_raw = |path: &&PathBuf| {
            shared_inputs
                .iter()
                .any(|shared| path.as_path() == Path::new(shared))
                || !modern_paths.contains(&self.config.project.join(path))
        };
        Ok(previous
            .iter()
            .filter(|(path, _)| is_raw(path))
            .eq(current.iter().filter(|(path, _)| is_raw(path))))
    }

    fn queue_latest_raw(&mut self) {
        if self.raw_build_ready {
            // Compile a candidate to discover newly imported helpers. Its
            // complete dependency receipt must still prove that every local
            // source change belongs to modern View before publication.
            self.pending_snapshot = self.latest_raw_snapshot.clone().map(|mut snapshot| {
                snapshot.ready_at = Instant::now();
                snapshot
            });
        }
    }

    fn poll_modern_inputs(&mut self) -> Option<DevEvent> {
        if self.last_modern_poll.elapsed() < self.config.poll_interval {
            return None;
        }
        self.observe_modern_inputs()
    }

    fn observe_modern_inputs(&mut self) -> Option<DevEvent> {
        self.last_modern_poll = Instant::now();
        match self.modern_project_identity() {
            Ok(identity) => {
                let recovered = self.modern_input_error.take().is_some();
                if identity != self.modern_inputs || recovered {
                    self.modern_inputs = identity;
                    self.supersede_pending();
                    self.queue_latest_raw();
                }
                None
            }
            Err(error) => {
                self.supersede_pending();
                let message = error.to_string();
                if self.modern_input_error.as_ref() == Some(&message) {
                    return None;
                }
                self.modern_input_error = Some(message.clone());
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "modern-view",
                    "BUILD_FAILED",
                    message,
                )))
            }
        }
    }

    fn poll_receipts(&mut self) -> Option<DevEvent> {
        let directory = self.receipt_root.join("receipts");
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "build",
                    "BUILD_RECEIPT_INVALID",
                    error.to_string(),
                )));
            }
        };
        let mut paths = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "json")
            })
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            path.file_stem()
                .and_then(|name| name.to_str())
                .and_then(|name| name.parse::<u64>().ok())
                .unwrap_or(0)
        });
        let mut diagnostic = None;
        for path in paths {
            let result = read_receipt(&path, &self.receipt_session);
            // Receipts are immutable, single-consumer messages. The compiler
            // owns a separate increasing counter and never rewrites them.
            let _ = fs::remove_file(&path);
            let receipt = match result {
                Ok(receipt) => receipt,
                Err(error) => {
                    self.supersede_pending();
                    self.raw_build_ready = false;
                    self.portable_freshness.invalidate();
                    self.diagnostic_active = true;
                    diagnostic = Some(DevEvent::Diagnostic(DevDiagnostic::new(
                        self.revision,
                        "build",
                        "BUILD_RECEIPT_INVALID",
                        error.to_string(),
                    )));
                    continue;
                }
            };
            if receipt.sequence <= self.last_receipt_sequence {
                continue;
            }
            self.last_receipt_sequence = receipt.sequence;
            self.supersede_pending();
            self.raw_build_ready = false;
            match receipt.kind {
                ReceiptKind::Building => {
                    self.raw_build_ready = false;
                }
                ReceiptKind::Error => {
                    self.raw_build_ready = false;
                    self.portable_freshness.invalidate();
                    self.diagnostic_active = true;
                    diagnostic = Some(DevEvent::Diagnostic(DevDiagnostic::new(
                        self.revision,
                        "build",
                        "BUILD_FAILED",
                        receipt
                            .message
                            .unwrap_or_else(|| "compiler build failed".to_owned()),
                    )));
                }
                ReceiptKind::Success => {
                    let snapshot = receipt
                        .snapshot
                        .as_deref()
                        .ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                "success receipt has no snapshot",
                            )
                        })
                        .and_then(|snapshot| receipt_snapshot_path(&self.receipt_root, snapshot));
                    match snapshot {
                        Ok(path) => {
                            let snapshot = ReadySnapshot {
                                sequence: receipt.sequence,
                                path: path.clone(),
                                compiler_commit: self
                                    .compiler_commit
                                    .clone()
                                    .or(receipt.compiler_commit)
                                    .unwrap_or_else(|| "unknown".to_owned()),
                                ready_at: Instant::now(),
                                _owner: Arc::new(SnapshotOwner(path)),
                            };
                            self.raw_build_ready = true;
                            self.raw_source_inputs = project_input_identities(
                                &self.config.project,
                                &[
                                    resolve_watch_output(&self.config.project),
                                    self.run_root.clone(),
                                ],
                            )
                            .ok();
                            self.latest_raw_snapshot = Some(snapshot.clone());
                            self.pending_snapshot = Some(snapshot);
                        }
                        Err(error) => {
                            self.portable_freshness.invalidate();
                            self.diagnostic_active = true;
                            diagnostic = Some(DevEvent::Diagnostic(DevDiagnostic::new(
                                self.revision,
                                "build",
                                "BUILD_RECEIPT_INVALID",
                                error.to_string(),
                            )));
                        }
                    }
                }
            }
        }
        diagnostic
    }

    fn start_pending_pack(&mut self) -> Result<Option<DevEvent>, DevError> {
        if self.deferred_browser_pack.is_some() {
            return Ok(None);
        }
        if self
            .pending_snapshot
            .as_ref()
            .is_none_or(|snapshot| snapshot.ready_at.elapsed() < self.config.poll_interval)
        {
            return Ok(None);
        }
        // A cached observation cannot authorize a build. Refresh at the
        // handoff boundary, then recheck because a newer receipt can replace
        // or invalidate the debounced snapshot.
        if let Some(event) = self.poll_compiler_inputs(true) {
            return Ok(Some(event));
        }
        if self.source_error_fingerprint.is_some()
            || self
                .pending_snapshot
                .as_ref()
                .is_none_or(|snapshot| snapshot.ready_at.elapsed() < self.config.poll_interval)
        {
            return Ok(None);
        }
        let snapshot = self.pending_snapshot.take().expect("pending snapshot");
        let raw_fingerprint = match tree_fingerprint(&snapshot.path) {
            Ok(value) if value != 0 => value,
            result => {
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "build",
                    "BUILD_RECEIPT_INVALID",
                    result.err().map_or_else(
                        || "empty compiler snapshot".to_owned(),
                        |error| error.to_string(),
                    ),
                ))));
            }
        };
        let modern_inputs = match self.modern_project_identity() {
            Ok(identity) => identity,
            Err(error) => {
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                self.modern_input_error = Some(error.to_string());
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "modern-view",
                    "BUILD_FAILED",
                    error.to_string(),
                ))));
            }
        };
        self.modern_inputs = modern_inputs;
        let fingerprint = combined_build_fingerprint(raw_fingerprint, modern_inputs);
        if self
            .last_build_identity
            .as_ref()
            .is_some_and(|(previous, compiler)| {
                *previous == fingerprint && compiler == &snapshot.compiler_commit
            })
        {
            let recovered = self.diagnostic_active;
            self.diagnostic_active = false;
            // The pack's bytes/generation remain valid, but every newly
            // accepted source success owns a fresh site-publication token.
            // A site built for the old error/pending observation stays stale.
            if self.config.pack_consumer.is_external() {
                if let Some(report) = self.accepted_portable.as_mut() {
                    report.publication_token =
                        self.portable_freshness.token(self.last_receipt_sequence);
                    return Ok(Some(DevEvent::PortableReady {
                        revision: report.revision,
                        report: report.clone(),
                    }));
                }
            } else if recovered {
                if let Some(simulator) = self.simulator.as_ref() {
                    return Ok(Some(DevEvent::PackReady {
                        revision: self.revision,
                        reload: None,
                        report: simulator.report("ready"),
                    }));
                }
            }
            return Ok(None);
        }
        self.portable_freshness.invalidate();
        self.revision = self.revision.saturating_add(1);
        let generation = self.run_root.join(format!("generation-{}", self.revision));
        let staging = self.run_root.join(format!(
            ".staging-{}-{}-{}",
            self.revision,
            std::process::id(),
            snapshot.sequence,
        ));
        let mut files = PackFiles {
            snapshot,
            staging,
            project_snapshot: None,
        };
        let _ = fs::remove_dir_all(&files.staging);
        if let Err(error) = fs::create_dir_all(&files.staging) {
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                self.revision,
                "pack",
                "STAGING_CREATE_FAILED",
                error.to_string(),
            ))));
        }
        if modern_inputs.is_some() {
            let source_snapshot = self.preparation_root.path.join(format!(
                ".source-{}-{}",
                self.revision,
                NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed)
            ));
            files.project_snapshot = Some(source_snapshot.clone());
            let ignored = [
                resolve_watch_output(&self.config.project),
                self.run_root.clone(),
            ];
            let frozen =
                project_input_fingerprint(&self.config.project, &ignored).and_then(|expected| {
                    copy_project_inputs(&self.config.project, &source_snapshot, &ignored)?;
                    Ok((expected, project_input_fingerprint(&source_snapshot, &[])?))
                });
            match frozen {
                Ok((expected, fingerprint)) if fingerprint == expected => {}
                Ok(_) => {
                    // An edit raced the source copy. Never compile a mixture
                    // of two source revisions; retry after the debounce.
                    self.queue_latest_raw();
                    return Ok(None);
                }
                Err(error) => {
                    self.modern_recovery_watch = true;
                    self.modern_inputs = self.modern_project_identity().ok().flatten();
                    self.portable_freshness.invalidate();
                    self.diagnostic_active = true;
                    return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                        self.revision,
                        "modern-view",
                        "BUILD_FAILED",
                        error.to_string(),
                    ))));
                }
            }
        }
        let child = match spawn_pack_output(
            &self.config.node_bin,
            &self.workspace_root,
            &files.snapshot.path,
            &files.staging,
            &files.snapshot.compiler_commit,
            files.project_snapshot.as_deref(),
            &self.config.project,
        ) {
            Ok(child) => child,
            Err(error) => {
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    self.revision,
                    "pack",
                    "BUILD_FAILED",
                    error.to_string(),
                ))));
            }
        };
        self.pending_pack = Some(PendingPack {
            child,
            files,
            generation,
            fingerprint,
            revision: self.revision,
            deadline: Instant::now() + self.config.pack_timeout,
            obsolete: false,
            modern_inputs,
        });
        Ok(None)
    }

    fn poll_pending_pack(&mut self) -> Result<Option<DevEvent>, DevError> {
        let Some(pending) = self.pending_pack.as_mut() else {
            return Ok(None);
        };
        if !pending.obsolete && Instant::now() >= pending.deadline {
            pending.obsolete = true;
            signal_owned_process(&mut pending.child);
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                pending.revision,
                "pack",
                "ERR_TIMEOUT",
                "portable pack exceeded its absolute deadline",
            ))));
        }
        let status = match pending.child.try_wait() {
            Ok(Some(status)) => status,
            Ok(None) => return Ok(None),
            Err(error) => {
                pending.obsolete = true;
                signal_owned_process(&mut pending.child);
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    pending.revision,
                    "pack",
                    "BUILD_FAILED",
                    error.to_string(),
                ))));
            }
        };
        // A wrapper may have exited while leaving worker descendants behind.
        signal_owned_process(&mut pending.child);
        // Job termination is asynchronous. Retain staging/snapshot ownership
        // while workers exit instead of blocking the shared surface loop or
        // removing files that a descendant can still access.
        #[cfg(windows)]
        if !pending.child.poll_stopped()? {
            return Ok(None);
        }
        // Publication is an independent observation boundary. A new build
        // receipt or malformed source must supersede this completed child
        // even when the periodic compiler poll is not due yet.
        if !pending.obsolete {
            if let Some(event) = self.poll_compiler_inputs(true) {
                return Ok(Some(event));
            }
        }
        let pending = self.pending_pack.take().expect("pending pack");
        if pending.obsolete {
            return Ok(None);
        }
        if !status.success() {
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            let mut diagnostic = DevDiagnostic::new(
                pending.revision,
                "pack",
                "BUILD_FAILED",
                format!("portable pack exited with {status}"),
            );
            enrich_pack_diagnostic(&mut diagnostic, &pending.files, &self.config.project);
            self.modern_recovery_watch = pending.modern_inputs.is_some();
            if let Some(file) = diagnostic.file.as_ref() {
                // A new imported helper can fail before a successful closure
                // receipt exists. Its source must still trigger recovery.
                self.modern_dependencies.insert(PathBuf::from(file));
            }
            self.modern_inputs = self.modern_project_identity().ok().flatten();
            return Ok(Some(DevEvent::Diagnostic(diagnostic)));
        }
        // Recheck source identity at the publication barrier, even if the
        // regular poll debounce has not elapsed yet. A completed old child
        // must not overwrite a newer source edit.
        match self.modern_project_identity() {
            Ok(identity) if identity == pending.modern_inputs => {}
            Ok(identity) => {
                self.modern_inputs = identity;
                self.queue_latest_raw();
                return Ok(None);
            }
            Err(error) => {
                self.modern_input_error = Some(error.to_string());
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    pending.revision,
                    "modern-view",
                    "BUILD_FAILED",
                    error.to_string(),
                ))));
            }
        }
        let mut discovered = BTreeSet::new();
        let mut accepted_sources = BTreeMap::new();
        let dependencies = match read_modern_dependencies(
            &pending.files,
            &self.config.project,
            &mut discovered,
            &mut accepted_sources,
        ) {
            Ok(dependencies) => dependencies,
            Err(error) => {
                self.modern_dependencies.extend(discovered);
                self.modern_recovery_watch = pending.modern_inputs.is_some();
                self.portable_freshness.invalidate();
                self.diagnostic_active = true;
                return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                    pending.revision,
                    "modern-view",
                    "BUILD_FAILED",
                    error.to_string(),
                ))));
            }
        };
        if pending.modern_inputs.is_some() {
            let mut modern_paths = self.modern_watch_paths()?;
            modern_paths.extend(dependencies.iter().cloned());
            if !self.raw_inputs_unchanged(&modern_paths)? {
                // A successful modern candidate cannot authorize changes to
                // raw compiler-owned sources. Wait for that build's receipt.
                self.raw_build_ready = false;
                return Ok(None);
            }
        }
        let accepted_modern_inputs =
            if let Some(snapshot) = pending.files.project_snapshot.as_deref() {
                let snapshot = fs::canonicalize(snapshot)?;
                for path in modern_config_inputs(&snapshot)? {
                    let original = self
                        .config
                        .project
                        .join(path.strip_prefix(&snapshot).expect("frozen project input"));
                    accepted_sources
                        .entry(original)
                        .or_insert(input_content_identity(
                            read_tracked_input(&path)?.as_deref(),
                        ));
                }
                Some(input_identities_fingerprint(&accepted_sources))
            } else {
                None
            };
        // Browser publication validates the same immutable bytes as a local
        // runtime, but must never construct a native HostSession or execute JS.
        let portable_candidate = if self.config.pack_consumer.is_external() {
            match portable_pack_report(
                &pending.files.staging,
                &pending.generation,
                pending.revision,
                self.config.simulator.route.as_deref(),
                self.portable_freshness.token(self.last_receipt_sequence),
            ) {
                Ok(report) => Some(report),
                Err(error) => {
                    self.portable_freshness.invalidate();
                    self.diagnostic_active = true;
                    return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                        pending.revision,
                        "pack",
                        "ERR_INVALID_MANIFEST",
                        error.to_string(),
                    ))));
                }
            }
        } else {
            None
        };
        if let Err(error) = fs::rename(&pending.files.staging, &pending.generation) {
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                pending.revision,
                "pack",
                "GENERATION_PUBLISH_FAILED",
                error.to_string(),
            ))));
        }
        let mut staged_browser = None;
        let publication = if let Some(report) = portable_candidate {
            self.route_warning = portable_route_warning(&report);
            self.accepted_portable = Some(report.clone());
            DevEvent::PortableReady {
                revision: pending.revision,
                report,
            }
        } else {
            // Capture the route before applying the candidate.  A route removal
            // must be visible to the developer even though we safely fall back to
            // the configured route or the first route in the new manifest.
            let previous_route = self
                .simulator
                .as_ref()
                .and_then(|simulator| simulator.report("ready").route);
            let configured_route = self.config.simulator.route.clone();
            let mut reload = None;
            let report = if let Some(simulator) = self.simulator.as_mut() {
                match simulator.apply_dev_pack(&pending.generation) {
                    Ok((kind, report)) => {
                        reload = Some(kind);
                        report
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(&pending.generation);
                        self.portable_freshness.invalidate();
                        self.diagnostic_active = true;
                        return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                            self.revision,
                            "reload",
                            "RELOAD_FAILED",
                            error.to_string(),
                        ))));
                    }
                }
            } else {
                let result =
                    Simulator::from_pack_dir(&pending.generation, self.config.simulator.clone())
                        .and_then(|mut simulator| {
                            simulator.set_trace_retention(self.config.trace_retention);
                            let report = simulator.run()?;
                            Ok((simulator, report))
                        });
                match result {
                    Ok((simulator, report)) => {
                        self.simulator = Some(simulator);
                        report
                    }
                    Err(error) => {
                        let _ = fs::remove_dir_all(&pending.generation);
                        self.portable_freshness.invalidate();
                        self.diagnostic_active = true;
                        return Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                            self.revision,
                            "reload",
                            "RELOAD_FAILED",
                            error.to_string(),
                        ))));
                    }
                }
            };
            if report.status == "staged"
                && self
                    .simulator
                    .as_ref()
                    .is_some_and(Simulator::browser_dev_pack_pending)
            {
                staged_browser = Some((reload, previous_route, configured_route));
                DevEvent::RuntimeUpdated {
                    revision: pending.revision,
                    batch: BridgeBatch::new(Vec::new()),
                    report,
                }
            } else {
                self.update_reload_route_warning(
                    previous_route,
                    configured_route,
                    report.route.clone(),
                );
                DevEvent::PackReady {
                    revision: pending.revision,
                    reload,
                    report,
                }
            }
        };
        let inputs = AcceptedPackInputs {
            dependencies,
            modern_inputs: accepted_modern_inputs,
            build_identity: (
                if pending.modern_inputs.is_some() {
                    combined_build_fingerprint(
                        tree_fingerprint(&pending.files.snapshot.path)?,
                        accepted_modern_inputs,
                    )
                } else {
                    pending.fingerprint
                },
                pending.files.snapshot.compiler_commit.clone(),
            ),
            raw_source_inputs: pending
                .files
                .project_snapshot
                .as_deref()
                .and_then(|snapshot| project_input_identities(snapshot, &[]).ok()),
        };
        if let Some((reload, previous_route, configured_route)) = staged_browser {
            self.deferred_browser_pack = Some(DeferredBrowserPack {
                generation: pending.generation.clone(),
                revision: pending.revision,
                reload,
                previous_route,
                configured_route,
                inputs,
            });
        } else {
            self.accept_pack_inputs(inputs);
        }
        Ok(Some(publication))
    }

    fn accept_pack_inputs(&mut self, inputs: AcceptedPackInputs) {
        self.modern_dependencies = inputs.dependencies;
        self.modern_recovery_watch = false;
        self.modern_inputs = inputs.modern_inputs;
        self.last_build_identity = Some(inputs.build_identity);
        if inputs.raw_source_inputs.is_some() {
            self.raw_source_inputs = inputs.raw_source_inputs;
        }
        // A browser ACK may follow a newer BUILDING/error receipt. Accept the
        // exact live bytes without clearing diagnostics for that newer source.
        self.diagnostic_active = !self.raw_build_ready
            || self.source_error_fingerprint.is_some()
            || self.modern_input_error.is_some();
    }

    fn update_reload_route_warning(
        &mut self,
        previous_route: Option<String>,
        configured_route: Option<String>,
        selected_route: Option<String>,
    ) {
        // Route availability belongs to the committed manifest. A staged
        // browser candidate cannot publish fallback state before its real ACK.
        let route_available = |candidate: &str| {
            let candidate = candidate.trim().trim_start_matches('/');
            self.simulator.as_ref().is_some_and(|simulator| {
                simulator
                    .manifest()
                    .routes
                    .iter()
                    .any(|route| route.path == candidate)
            })
        };
        let fallback_from = configured_route
            .as_deref()
            .filter(|route| !route_available(route))
            .map(str::to_owned)
            .or_else(|| {
                previous_route
                    .as_deref()
                    .filter(|route| !route_available(route))
                    .map(str::to_owned)
            });
        self.route_warning = if let (Some(from), Some(to)) = (fallback_from, selected_route) {
            let mut warning = DevDiagnostic::new(
                self.revision,
                "reload",
                "ROUTE_FALLBACK",
                format!("route {from:?} is unavailable after reload; using {to:?}"),
            );
            warning.severity = "warning".to_owned();
            Some(warning)
        } else {
            None
        };
    }

    fn reconcile_deferred_browser_pack(&mut self) -> Result<Option<DevEvent>, DevError> {
        if self.deferred_browser_pack.is_none()
            || self
                .simulator
                .as_ref()
                .is_some_and(Simulator::browser_dev_pack_pending)
        {
            return Ok(None);
        }
        let pending = self
            .deferred_browser_pack
            .take()
            .expect("deferred browser pack");
        let committed = self
            .simulator
            .as_ref()
            .is_some_and(|simulator| simulator.root() == pending.generation);
        if committed {
            let report = self
                .simulator
                .as_ref()
                .expect("committed simulator")
                .report("ready");
            self.update_reload_route_warning(
                pending.previous_route,
                pending.configured_route,
                report.route.clone(),
            );
            self.accept_pack_inputs(pending.inputs);
            Ok(Some(DevEvent::PackReady {
                revision: pending.revision,
                reload: pending.reload,
                report,
            }))
        } else {
            // No runtime candidate references these rejected immutable bytes.
            // Keep the previous accepted build identity and published route.
            remove_owned_directory(&pending.generation);
            self.modern_dependencies.extend(pending.inputs.dependencies);
            self.modern_recovery_watch = pending.inputs.modern_inputs.is_some();
            self.portable_freshness.invalidate();
            self.diagnostic_active = true;
            Ok(Some(DevEvent::Diagnostic(DevDiagnostic::new(
                pending.revision,
                "reload",
                "RELOAD_FAILED",
                "browser presentation rejected the staged generation; previous generation retained",
            ))))
        }
    }

    fn source_app_json_error(&self) -> Option<(u64, PathBuf, String)> {
        let path = resolve_source_app_json(&self.config.project);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) => {
                // A watch compiler can leave the previous generated tree in
                // place when the source entry is deleted (or becomes
                // temporarily unreadable).  Treat that as a source build
                // failure instead of silently reusing the stale output.  The
                // fingerprint is stable for the same filesystem error, so a
                // long lived watcher emits one diagnostic until the file is
                // restored or the error changes.
                let mut fingerprint_hasher = DefaultHasher::new();
                path.to_string_lossy().hash(&mut fingerprint_hasher);
                error.kind().hash(&mut fingerprint_hasher);
                let message = if error.kind() == io::ErrorKind::NotFound {
                    "source app.json is missing".to_owned()
                } else {
                    format!("cannot read source app.json: {error}")
                };
                return Some((fingerprint_hasher.finish(), path, message));
            }
        };
        let mut fingerprint_hasher = DefaultHasher::new();
        bytes.hash(&mut fingerprint_hasher);
        serde_json::from_slice::<serde_json::Value>(&bytes)
            .err()
            .map(|error| (fingerprint_hasher.finish(), path, error.to_string()))
    }

    /// Poll until `wv` exits.  The initial build and all subsequent rebuilds
    /// are surfaced through `on_event`; this is the CLI's blocking mode.
    pub fn run_until_exit<F>(&mut self, mut on_event: F) -> Result<ExitStatus, DevError>
    where
        F: FnMut(DevEvent),
    {
        if self.stopped {
            return Err(DevError::Shutdown);
        }
        loop {
            if let Some(event) = self.poll()? {
                if let DevEvent::Exited(status) = event {
                    on_event(DevEvent::Exited(status));
                    return Ok(status);
                }
                on_event(event);
            }
            std::thread::sleep(self.config.poll_interval);
        }
    }

    /// Stop and reap the owned watcher, output readers, and packer in that
    /// order, then release preparation files. This is an idempotent cleanup
    /// barrier for surface owners; a later Drop cannot signal an old process
    /// group again after its PID may have been reused. The last valid runtime
    /// remains available for final reporting, but poll/pump do no further work.
    pub fn shutdown(&mut self) {
        match self.try_shutdown() {
            Ok(true) => {},
            Ok(false) => eprintln!("weapp-simulator: browser runtime borrowers remain; drop them and retry try_shutdown"),
            Err(error) => eprintln!("weapp-simulator: browser runtime cleanup requires retry: {error}"),
        }
    }

    /// Stop compilation once, then explicitly drain the static artifact lane.
    /// False/error keeps its original owners for retry, even after stopped=true.
    /// The last valid local runtime still remains available for final reporting.
    pub fn try_shutdown(&mut self) -> Result<bool, DevError> {
        if self.managed_source.is_some() {
            self.stopped = true;
            if let Some(source) = self.managed_source.as_mut() {
                source.release_inputs();
            }
            if let Some(owner) = self.browser_runtime.as_mut() {
                if !owner
                    .stop_source_watcher()
                    .map_err(|e| DevError::BrowserRuntime(e.to_string()))?
                {
                    return Ok(false);
                }
            }
            // Actual tree barrier first, reader drain next, mutable compiler
            // output last. PreparationOwner cannot delete ahead of that barrier.
            let mut reader_panicked = false;
            for reader in self.output_readers.drain(..) {
                reader_panicked |= reader.join().is_err();
            }
            if reader_panicked {
                return Err(DevError::BrowserRuntime(
                    "compiler output reader panicked".into(),
                ));
            }
            self.preparation_root.try_release()?;
        } else {
            self.stop_compilation();
        }
        let Some(owner) = self.browser_runtime.as_mut() else {
            return Ok(true);
        };
        if !owner.try_shutdown().map_err(DevError::BrowserRuntime)? {
            return Ok(false);
        }
        self.browser_runtime = None;
        Ok(true)
    }

    fn stop_compilation(&mut self) {
        if std::mem::replace(&mut self.stopped, true) {
            return;
        }
        if let Some(child) = self.child.as_mut() {
            stop_owned_watch_process(child);
        }
        for reader in self.output_readers.drain(..) {
            if reader.join().is_err() {
                eprintln!("weapp-simulator: compiler output reader panicked during shutdown");
            }
        }
        if let Some(mut pending) = self.pending_pack.take() {
            stop_owned_watch_process(&mut pending.child);
        }
        self.pending_snapshot = None;
        self.latest_raw_snapshot = None;
        if let Err(error) = fs::remove_dir_all(&self.receipt_root) {
            if error.kind() != io::ErrorKind::NotFound {
                eprintln!("weapp-simulator: cannot remove compiler snapshots: {error}");
            }
        }
        remove_owned_directory(&self.build_output);
        self.preparation_root.release();
    }
}

impl Drop for DevSupervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Request immediate termination without waiting in the shared event loop.
/// `try_wait` reaps it on a later tick; Drop provides the final cleanup barrier.
fn signal_owned_process(child: &mut OwnedProcess) {
    child.terminate_now();
}

fn stop_owned_watch_process(child: &mut OwnedProcess) {
    child.stop();
}

fn spawn_pack_output(
    node_bin: &Path,
    workspace_root: &Path,
    input: &Path,
    output: &Path,
    compiler_commit: &str,
    project_snapshot: Option<&Path>,
    resolve_root: &Path,
) -> Result<OwnedProcess, DevError> {
    let packer = workspace_root.join("tools/container-manifest/bin/container-pack.mjs");
    if !packer.is_file() {
        return Err(DevError::PackerNotFound);
    }
    let mut command = Command::new(node_bin);
    command
        .arg(&packer)
        .arg(input)
        .arg("--out")
        .arg(output)
        .arg("--platform")
        .arg("weapp")
        .arg("--compiler-commit")
        .arg(compiler_commit)
        .arg("--diagnostic-json")
        .arg(output.join(".pack-error.json"))
        .current_dir(workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(project) = project_snapshot {
        command
            .arg("--project")
            .arg(project)
            .arg("--resolve-root")
            .arg(resolve_root)
            .arg("--watch-dependencies-json")
            .arg(output.join(".watch-dependencies.json"));
    }
    Ok(OwnedProcess::spawn(&mut command)?)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModernWatchDependencies {
    schema_version: u32,
    sources: Vec<ModernWatchSource>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ModernWatchSource {
    path: PathBuf,
    sha256: String,
}

fn read_modern_dependencies(
    files: &PackFiles,
    project: &Path,
    discovered: &mut BTreeSet<PathBuf>,
    accepted: &mut BTreeMap<PathBuf, u64>,
) -> io::Result<BTreeSet<PathBuf>> {
    let Some(snapshot) = files.project_snapshot.as_deref() else {
        return Ok(BTreeSet::new());
    };
    let snapshot = fs::canonicalize(snapshot)?;
    let path = files.staging.join(".watch-dependencies.json");
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid modern View watch dependency receipt",
        ));
    }
    let receipt: ModernWatchDependencies = serde_json::from_slice(&fs::read(&path)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    if receipt.schema_version != 1 || receipt.sources.len() > 65_536 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported modern View watch dependency receipt",
        ));
    }
    let mut dependencies = BTreeSet::new();
    for source in receipt.sources {
        if !source.path.is_absolute()
            || source.sha256.len() != 64
            || !source
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid modern View watch source identity",
            ));
        }
        let path = source
            .path
            .strip_prefix(&snapshot)
            .map_or_else(|_| source.path.clone(), |relative| project.join(relative));
        discovered.insert(path.clone());
        let bytes = read_tracked_input(&path)?.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "modern View source disappeared while packing: {}",
                    path.display()
                ),
            )
        })?;
        if format!("{:x}", Sha256::digest(&bytes)) != source.sha256 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "modern View source changed while packing: {}",
                    path.display()
                ),
            ));
        }
        accepted.insert(path.clone(), input_content_identity(Some(&bytes)));
        dependencies.insert(path);
    }
    fs::remove_file(files.staging.join(".watch-dependencies.json"))?;
    Ok(dependencies)
}

fn enrich_pack_diagnostic(diagnostic: &mut DevDiagnostic, files: &PackFiles, project: &Path) {
    let path = files.staging.join(".pack-error.json");
    let report = fs::symlink_metadata(&path)
        .ok()
        .filter(|metadata| metadata.is_file() && metadata.len() <= 1_048_576)
        .and_then(|_| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let Some(report) = report else { return };
    let issue = report
        .get("diagnostics")
        .and_then(serde_json::Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find(|entry| {
                    entry.get("severity").and_then(serde_json::Value::as_str) == Some("error")
                })
                .or_else(|| entries.first())
        })
        .unwrap_or(&report);
    let remap = |value: &str| {
        files.project_snapshot.as_ref().map_or_else(
            || value.to_owned(),
            |snapshot| {
                let value = value.replace(
                    snapshot.to_string_lossy().as_ref(),
                    project.to_string_lossy().as_ref(),
                );
                fs::canonicalize(snapshot).map_or(value.clone(), |canonical| {
                    value.replace(
                        canonical.to_string_lossy().as_ref(),
                        project.to_string_lossy().as_ref(),
                    )
                })
            },
        )
    };
    if let Some(message) = issue.get("message").and_then(serde_json::Value::as_str) {
        diagnostic.message = remap(message);
    }
    diagnostic.stack = report
        .get("stack")
        .and_then(serde_json::Value::as_str)
        .map(remap);
    diagnostic.file = issue
        .get("path")
        .or_else(|| issue.get("file"))
        .and_then(serde_json::Value::as_str)
        .map(|path| {
            let path = Path::new(path);
            if path.is_absolute() {
                remap(path.to_string_lossy().as_ref())
            } else {
                project.join(path).to_string_lossy().into_owned()
            }
        });
}

fn spawn_output_reader<R>(reader: R, sender: mpsc::Sender<BuildOutput>) -> JoinHandle<()>
where
    R: Read + Send + 'static,
{
    std::thread::spawn(move || {
        for line in BufReader::new(reader).lines() {
            let Ok(line) = line else { break };
            if sender.send(BuildOutput { line }).is_err() {
                break;
            }
        }
    })
}

fn resolve_wv_bin(wv_bin: &Path, workspace_root: &Path) -> PathBuf {
    // A checkout normally exposes `wv` through the vendor workspace rather
    // than the user's global PATH. Prefer that fixed toolchain when present;
    // an explicit `--wv-bin` path still bypasses this discovery.
    let vendor_bin = workspace_root
        .join("vendor/weapp-vite/node_modules/.bin")
        .join(if cfg!(windows) { "wv.cmd" } else { "wv" });
    if wv_bin == Path::new("wv") && vendor_bin.is_file() {
        return vendor_bin;
    }
    if wv_bin == Path::new("wv")
        && workspace_root
            .join("vendor/weapp-vite/packages/weapp-vite/bin/weapp-vite.js")
            .is_file()
    {
        workspace_root.join("vendor/weapp-vite/packages/weapp-vite/bin/weapp-vite.js")
    } else {
        wv_bin.to_path_buf()
    }
}

fn watch_adapter_command(
    node_bin: &Path,
    wv_bin: &Path,
    workspace_root: &Path,
    project: &Path,
    output: &Path,
) -> Command {
    let mut command = Command::new(node_bin);
    command
        .arg(workspace_root.join("scripts/simulator-watch.mjs"))
        .arg("--project")
        .arg(project)
        .arg("--wv-bin")
        .arg(resolve_wv_bin(wv_bin, workspace_root))
        .arg("--output-root")
        .arg(output);
    command
}

/// Reserve an independent publication namespace. The directory itself remains
/// after shutdown, so neither PID reuse nor restarting revision numbering can
/// overwrite a historical pack. Atomic create_dir also isolates concurrent
/// supervisors that share an output directory; no "current" alias is followed.
fn allocate_run_namespace(output_root: &Path) -> io::Result<(String, PathBuf)> {
    let runs = output_root.join("runs");
    fs::create_dir_all(&runs)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    loop {
        let sequence = NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed);
        let identity = format!("{}-{timestamp}-{sequence}", std::process::id());
        let root = runs.join(&identity);
        match fs::create_dir(&root) {
            Ok(()) => return Ok((identity, root)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// Reserve disposable compiler/source preparation outside the watched app.
/// The publication namespace remains on the user's output filesystem for
/// atomic generation renames; this directory is owned until shutdown/Drop.
fn allocate_preparation_namespace(project: &Path) -> io::Result<PathBuf> {
    let temporary_root = fs::canonicalize(std::env::temp_dir())?;
    if temporary_root.starts_with(project) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "development preparation directory must be outside the watched project",
        ));
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    loop {
        let sequence = NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed);
        let directory = temporary_root.join(format!(
            "weapp-simulator-preparation-{}-{timestamp}-{sequence}",
            std::process::id()
        ));
        match fs::create_dir(&directory) {
            Ok(()) => return Ok(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

fn read_receipt(path: &Path, session: &str) -> io::Result<BuildReceipt> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > 65_536 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "receipt must be a regular JSON file of at most 64 KiB",
        ));
    }
    let receipt: BuildReceipt = serde_json::from_slice(&fs::read(path)?)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let sequence = path
        .file_stem()
        .and_then(|name| name.to_str())
        .and_then(|name| name.parse::<u64>().ok());
    if receipt.protocol_version != "1.0"
        || receipt.session_id != session
        || receipt.sequence == 0
        || Some(receipt.sequence) != sequence
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "receipt protocol, session or sequence mismatch",
        ));
    }
    Ok(receipt)
}

fn receipt_snapshot_path(root: &Path, snapshot: &str) -> io::Result<PathBuf> {
    use std::path::Component;
    let components = Path::new(snapshot).components().collect::<Vec<_>>();
    if !matches!(components.as_slice(), [Component::Normal(parent), Component::Normal(_)] if *parent == "snapshots")
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "snapshot must be a relative snapshots/<unique> directory",
        ));
    }
    let path = root.join(snapshot);
    for candidate in [root.join("snapshots"), path.clone()] {
        if !fs::symlink_metadata(candidate)?.is_dir() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "snapshot must be an independent regular directory",
            ));
        }
    }
    Ok(path)
}

fn resolve_watch_output(project: &Path) -> PathBuf {
    let config = project.join("project.config.json");
    if let Ok(bytes) = fs::read(config) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            if let Some(root) = value
                .get("miniprogramRoot")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(candidate) = safe_project_child(project, root) {
                    return candidate;
                }
            }
        }
    }
    project.join("dist")
}

fn resolve_source_app_json(project: &Path) -> PathBuf {
    let config = project.join("project.config.json");
    if let Ok(bytes) = fs::read(config) {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            // `srcMiniprogramRoot` identifies the source tree while
            // `miniprogramRoot` identifies the generated tree consumed by
            // WeChat DevTools.  Prefer the source root here: when a watch
            // build keeps the previous dist/ tree after a malformed source
            // app.json, validating dist/app.json would incorrectly clear the
            // diagnostic and republish stale output.
            if let Some(root) = value
                .get("srcMiniprogramRoot")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(root) = safe_project_child(project, root) {
                    // An explicit source root is authoritative even while
                    // its app.json is missing. Falling back to the generated
                    // root here would validate stale dist/app.json and hide
                    // the source deletion from the development diagnostic.
                    return root.join("app.json");
                }
            }
            if let Some(root) = value
                .get("miniprogramRoot")
                .and_then(serde_json::Value::as_str)
            {
                if let Some(root) = safe_project_child(project, root) {
                    let candidate = root.join("app.json");
                    if candidate.is_file() {
                        return candidate;
                    }
                }
            }
        }
    }
    project.join("app.json")
}

/// Resolve a project-relative output path without allowing an absolute path or
/// parent traversal to escape the project.  `Path::join` alone is not enough:
/// it accepts both `/` and `../outside`, and the supervisor may remove the
/// resulting tree before starting the watcher.
fn safe_project_child(project: &Path, root: &str) -> Option<PathBuf> {
    let relative = Path::new(root);
    if relative.is_absolute() {
        return None;
    }
    if relative.components().any(|component| {
        matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(project.join(relative))
}

/// Return true when either path contains the other.  This keeps generated
/// generations out of the tree being fingerprinted and prevents a custom
/// `--out-dir` from being deleted when it is also the watch output.
fn paths_overlap(left: &Path, right: &Path) -> bool {
    let left = lexical_normalize(left);
    let right = lexical_normalize(right);
    left == right || left.starts_with(&right) || right.starts_with(&left)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                let _ = normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn combined_build_fingerprint(raw: u64, modern: Option<u64>) -> u64 {
    match modern {
        None => raw,
        Some(modern) => {
            let mut hash = DefaultHasher::new();
            raw.hash(&mut hash);
            modern.hash(&mut hash);
            hash.finish()
        }
    }
}

fn modern_config_inputs(project: &Path) -> io::Result<BTreeSet<PathBuf>> {
    let mut paths = [
        "container.config.json",
        "package.json",
        "pnpm-lock.yaml",
        "package-lock.json",
        "yarn.lock",
        "bun.lock",
        "bun.lockb",
    ]
    .into_iter()
    .map(|path| project.join(path))
    .collect::<BTreeSet<_>>();
    let Some(bytes) = read_tracked_input(&project.join("container.config.json"))? else {
        return Ok(paths);
    };
    // Malformed JSON is still an observed input. Let the packer report its
    // structured diagnostic rather than suppressing the next source change.
    if let Ok(config) = serde_json::from_slice::<serde_json::Value>(&bytes) {
        if let Some(documents) = config
            .pointer("/view/documents")
            .and_then(serde_json::Value::as_object)
        {
            for document in documents.values() {
                if let Some(modules) = document
                    .get("modules")
                    .and_then(serde_json::Value::as_object)
                {
                    for module in modules.values().filter_map(serde_json::Value::as_str) {
                        let path = safe_project_child(project, module).ok_or_else(|| {
                            io::Error::new(
                                io::ErrorKind::InvalidData,
                                format!("modern View entry must stay inside the project: {module}"),
                            )
                        })?;
                        paths.insert(lexical_normalize(&path));
                    }
                }
            }
        }
    }
    Ok(paths)
}

fn read_tracked_input(path: &Path) -> io::Result<Option<Vec<u8>>> {
    // Paths from compiler receipts are canonical, while config entries may
    // still contain symlinks. Reject links before reading outside the snapshot.
    let mut ancestor = PathBuf::new();
    for component in path.components() {
        ancestor.push(component.as_os_str());
        if !matches!(component, std::path::Component::Normal(_)) {
            continue;
        }
        match fs::symlink_metadata(&ancestor) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "modern View watch input cannot be a symlink: {}",
                        ancestor.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
    }
    if !fs::symlink_metadata(path)?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "modern View watch input must be a regular file: {}",
                path.display()
            ),
        ));
    }
    fs::read(path).map(Some)
}

fn tracked_input_fingerprint(paths: &BTreeSet<PathBuf>) -> io::Result<u64> {
    let mut inputs = BTreeMap::new();
    for path in paths {
        inputs.insert(
            path.clone(),
            input_content_identity(read_tracked_input(path)?.as_deref()),
        );
    }
    Ok(input_identities_fingerprint(&inputs))
}

fn input_content_identity(bytes: Option<&[u8]>) -> u64 {
    let mut hash = DefaultHasher::new();
    bytes.hash(&mut hash);
    hash.finish()
}

fn input_identities_fingerprint(inputs: &BTreeMap<PathBuf, u64>) -> u64 {
    let mut hash = DefaultHasher::new();
    inputs.hash(&mut hash);
    hash.finish()
}

/// Local modern modules can import ordinary .js/.ts/.json helpers, so watch
/// all source files rather than guessing the dependency graph from suffixes.
/// Compiler output and dependency installation trees are separate owners.
/// Lockfiles/package manifests remain inputs and trigger recompilation after
/// a dependency installation; the packer resolves bare packages from the
/// original project while freezing their actual compiled source hashes.
fn visit_project_inputs(
    root: &Path,
    directory: &Path,
    ignored: &[PathBuf],
    visit: &mut impl FnMut(&Path, &Path) -> io::Result<()>,
) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if ignored.iter().any(|ignored| path.starts_with(ignored))
            || [".git", ".weapp-container", ".weapp-vite", "node_modules"]
                .iter()
                .any(|ignored| name == *ignored)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.is_dir() {
            visit_project_inputs(root, &path, ignored, visit)?;
        } else if metadata.is_file() {
            visit(&path, path.strip_prefix(root).expect("project child"))?;
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "modern View source snapshot requires regular files: {}",
                    path.display()
                ),
            ));
        }
    }
    Ok(())
}

fn project_input_fingerprint(project: &Path, ignored: &[PathBuf]) -> io::Result<u64> {
    let mut hash = DefaultHasher::new();
    visit_project_inputs(project, project, ignored, &mut |path, relative| {
        relative.hash(&mut hash);
        fs::read(path)?.hash(&mut hash);
        Ok(())
    })?;
    Ok(hash.finish())
}

fn project_input_identities(
    project: &Path,
    ignored: &[PathBuf],
) -> io::Result<BTreeMap<PathBuf, u64>> {
    let mut inputs = BTreeMap::new();
    visit_project_inputs(project, project, ignored, &mut |path, relative| {
        let mut hash = DefaultHasher::new();
        fs::read(path)?.hash(&mut hash);
        inputs.insert(relative.to_owned(), hash.finish());
        Ok(())
    })?;
    Ok(inputs)
}

fn copy_project_inputs(project: &Path, destination: &Path, ignored: &[PathBuf]) -> io::Result<()> {
    fs::create_dir(destination)?;
    visit_project_inputs(project, project, ignored, &mut |path, relative| {
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        // On macOS std::fs::copy may clone the source's APFS extents and emit
        // source rename/change notifications even though its bytes/mtime did
        // not change. A compiler watching that source would rebuild forever.
        // Read through a fixed buffer without asking the OS to clone files.
        let mut source = fs::File::open(path)?;
        let mut target = fs::File::create_new(target)?;
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = source.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            target.write_all(&buffer[..read])?;
        }
        Ok(())
    })
}

#[cfg(all(test, unix))]
fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let child = entry.path();
        let name = child.file_name().unwrap_or_default();
        if name == ".weapp-container" || name == "node_modules" {
            continue;
        }
        // Never follow links from compiler output while taking the snapshot.
        // A symlink can point outside the project (or back into the output
        // tree), making the supposedly isolated staging copy race with an
        // unrelated file or recurse forever.  The pack format is regular-file
        // based, so fail the generation and keep the previous pack live.
        let metadata = fs::symlink_metadata(&child)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "watch output contains unsupported symlink: {}",
                    child.display()
                ),
            ));
        }
        let target = destination.join(name);
        if metadata.is_dir() {
            copy_tree(&child, &target)?;
        } else if metadata.is_file() {
            fs::copy(&child, target)?;
        }
    }
    Ok(())
}

fn find_workspace_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(path) = current {
        if path
            .join("tools/container-manifest/bin/container-pack.mjs")
            .is_file()
        {
            return Some(path.to_path_buf());
        }
        current = path.parent();
    }
    None
}

fn resolve_workspace_root(
    explicit: Option<&Path>,
    launch_dir: &Path,
    executable: Option<&Path>,
    project: &Path,
) -> Option<PathBuf> {
    // The application is input to the tool, not its installation directory.
    // A standalone project must use the same packer and pinned compiler as
    // the launched simulator. Keep project ancestry as a final compatibility
    // fallback for callers that invoke a relocated executable from elsewhere.
    explicit
        .map(|path| launch_dir.join(path))
        .or_else(|| find_workspace_root(launch_dir))
        .or_else(|| {
            executable
                .and_then(Path::parent)
                .and_then(find_workspace_root)
        })
        .or_else(|| find_workspace_root(project))
}

fn tree_fingerprint(root: &Path) -> io::Result<u64> {
    if !root.is_dir() {
        return Ok(0);
    }
    let mut entries = Vec::new();
    collect_files(root, root, &mut entries)?;
    entries.sort();
    let mut hasher = DefaultHasher::new();
    for (relative, size, content_hash) in entries {
        relative.hash(&mut hasher);
        size.hash(&mut hasher);
        content_hash.hash(&mut hasher);
    }
    Ok(hasher.finish())
}

fn collect_files(root: &Path, path: &Path, output: &mut Vec<(String, u64, u64)>) -> io::Result<()> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let child = entry.path();
        let name = child.file_name().unwrap_or_default();
        if name == ".weapp-container" || name == "node_modules" {
            continue;
        }
        // Match copy_tree's isolation rule.  Fingerprinting through a link
        // and then copying its target would let the stability check approve a
        // tree that the snapshot cannot safely reproduce.
        let metadata = fs::symlink_metadata(&child)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "watch output contains unsupported symlink: {}",
                    child.display()
                ),
            ));
        }
        if metadata.is_dir() {
            collect_files(root, &child, output)?;
        } else if metadata.is_file() {
            // Build tools commonly rewrite every output file on each watch
            // cycle, changing mtimes even when the bytes are identical. Use
            // content as the fingerprint so those cycles do not trigger
            // needless pack/reload generations or flood the SSE stream.
            let mut content_hasher = DefaultHasher::new();
            fs::read(&child)?.hash(&mut content_hasher);
            let relative = child
                .strip_prefix(root)
                .unwrap_or(&child)
                .to_string_lossy()
                .into_owned();
            output.push((relative, metadata.len(), content_hasher.finish()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct WorkspaceDiscoveryFixture {
        root: PathBuf,
    }

    impl WorkspaceDiscoveryFixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let root = loop {
                let id = NEXT.fetch_add(1, Ordering::Relaxed);
                let path = std::env::temp_dir().join(format!(
                    "weapp-dev-workspace-discovery-{}-{id}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => break path,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("reserve discovery fixture: {error}"),
                }
            };
            Self { root }
        }

        fn checkout(&self, name: &str) -> PathBuf {
            let root = self.root.join(name);
            let packer = root.join("tools/container-manifest/bin/container-pack.mjs");
            fs::create_dir_all(packer.parent().unwrap()).unwrap();
            fs::write(packer, "// discovery marker").unwrap();
            root
        }
    }

    impl Drop for WorkspaceDiscoveryFixture {
        fn drop(&mut self) {
            remove_owned_directory(&self.root);
        }
    }

    #[test]
    fn workspace_discovery_keeps_explicit_override_highest_priority() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let launch = fixture.checkout("launch");
        let project = fixture.checkout("project");
        let executable = fixture
            .checkout("executable")
            .join("target/debug/weapp-simulator");
        let explicit = fixture.root.join("explicit");
        // An explicit override must not silently fall back to another
        // checkout, even when that override has not been installed correctly.
        assert_eq!(
            resolve_workspace_root(Some(&explicit), &launch, Some(&executable), &project),
            Some(explicit)
        );
        assert_eq!(
            resolve_workspace_root(
                Some(Path::new("local-tools")),
                &launch,
                Some(&executable),
                &project,
            ),
            Some(launch.join("local-tools"))
        );
    }

    #[test]
    fn workspace_discovery_uses_launch_checkout_for_external_project() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let launch = fixture.checkout("tool-checkout");
        let executable = fixture
            .checkout("other-checkout")
            .join("target/debug/weapp-simulator");
        let project = fixture.root.join("standalone-app");
        assert!(find_workspace_root(&project).is_none());
        assert_eq!(
            resolve_workspace_root(None, &launch.join("examples"), Some(&executable), &project),
            Some(launch)
        );
    }

    #[test]
    fn workspace_discovery_uses_executable_before_project_compatibility_fallback() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let launch = fixture.root.join("unrelated-launch-dir");
        let tools = fixture.checkout("tool-checkout");
        let project = fixture.checkout("application-checkout");
        let executable = tools.join("target/debug/weapp-simulator");
        assert_eq!(
            resolve_workspace_root(None, &launch, Some(&executable), &project.join("app")),
            Some(tools)
        );
        assert_eq!(
            resolve_workspace_root(None, &launch, None, &project.join("app")),
            Some(project)
        );
        assert_eq!(
            resolve_workspace_root(None, &launch, None, &fixture.root.join("standalone-app")),
            None
        );
    }

    fn manifest() -> ContainerManifestV1 {
        ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "a".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            integrity: Integrity {
                algorithm: "sha256".into(),
                root: String::new(),
            },
            ..Default::default()
        }
    }

    #[test]
    fn output_fingerprint_changes_when_file_changes() {
        let root =
            std::env::temp_dir().join(format!("weapp-dev-fingerprint-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("app.json"), b"{}").unwrap();
        let first = tree_fingerprint(&root).unwrap();
        // Rewriting identical bytes must not be treated as a new generation;
        // watch builders are allowed to update mtimes on every cycle.
        fs::write(root.join("app.json"), b"{}").unwrap();
        let same = tree_fingerprint(&root).unwrap();
        assert_eq!(first, same);
        fs::write(root.join("app.json"), b"{\"x\":1}").unwrap();
        let second = tree_fingerprint(&root).unwrap();
        assert_ne!(first, second);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn modern_inputs_freeze_sources_and_ignore_compiler_output_and_caches() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let project = fixture.root.join("project");
        for directory in ["view", "dist", "node_modules", ".weapp-container/dev"] {
            fs::create_dir_all(project.join(directory)).unwrap();
        }
        fs::write(project.join("container.config.json"), "{}").unwrap();
        fs::write(
            project.join("view/format.view.ts"),
            "export const value = 1",
        )
        .unwrap();
        fs::write(project.join("view/shared.js"), "export const shared = 1").unwrap();
        fs::write(project.join("dist/app.js"), "mutable output").unwrap();
        fs::write(project.join("node_modules/package.json"), "mutable install").unwrap();
        fs::write(project.join(".weapp-container/dev/state"), "mutable cache").unwrap();
        let ignored = [project.join("dist")];
        let initial = project_input_fingerprint(&project, &ignored).unwrap();
        let frozen = fixture.root.join("frozen");
        copy_project_inputs(&project, &frozen, &ignored).unwrap();
        assert_eq!(project_input_fingerprint(&frozen, &[]).unwrap(), initial);
        assert!(!frozen.join("dist").exists());
        assert!(!frozen.join("node_modules").exists());
        assert!(!frozen.join(".weapp-container").exists());

        for path in [
            "dist/app.js",
            "node_modules/package.json",
            ".weapp-container/dev/state",
        ] {
            fs::write(project.join(path), "changed generated bytes").unwrap();
        }
        assert_eq!(
            project_input_fingerprint(&project, &ignored).unwrap(),
            initial
        );
        fs::write(project.join("view/shared.js"), "export const shared = 2").unwrap();
        assert_ne!(
            project_input_fingerprint(&project, &ignored).unwrap(),
            initial
        );
        assert_eq!(
            fs::read_to_string(frozen.join("view/shared.js")).unwrap(),
            "export const shared = 1"
        );
        assert_ne!(
            combined_build_fingerprint(17, Some(initial)),
            combined_build_fingerprint(
                17,
                Some(project_input_fingerprint(&project, &ignored).unwrap())
            )
        );
        assert_eq!(combined_build_fingerprint(17, None), 17);
    }

    #[test]
    fn modern_trigger_tracks_entries_helpers_and_lockfiles_without_appservice_edits() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let project = fixture.root.join("project");
        fs::create_dir_all(project.join("view")).unwrap();
        let project = fs::canonicalize(project).unwrap();
        fs::write(project.join("container.config.json"),
            r#"{"view":{"documents":{"pages/home/index.wxml":{"mode":"modern","modules":{"fmt":"./view/format.view.ts"}}}}}"#).unwrap();
        fs::write(project.join("view/format.view.ts"), "export const a = 1").unwrap();
        fs::write(project.join("view/helper.js"), "export const b = 1").unwrap();
        fs::write(project.join("app.js"), "App({})").unwrap();
        let mut paths = modern_config_inputs(&project).unwrap();
        paths.insert(project.join("view/helper.js"));
        let original = tracked_input_fingerprint(&paths).unwrap();
        fs::write(project.join("app.js"), "App({onLaunch(){}})").unwrap();
        assert_eq!(tracked_input_fingerprint(&paths).unwrap(), original);
        fs::write(project.join("view/helper.js"), "export const b = 2").unwrap();
        let helper = tracked_input_fingerprint(&paths).unwrap();
        assert_ne!(helper, original);
        fs::write(project.join("pnpm-lock.yaml"), "lockfileVersion: '9.0'").unwrap();
        assert_ne!(tracked_input_fingerprint(&paths).unwrap(), helper);
        assert!(paths.contains(&project.join("view/format.view.ts")));
    }

    #[test]
    fn modern_dependency_receipt_verifies_live_sources_and_maps_owned_snapshot_paths() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let project = fixture.root.join("project");
        let frozen = fixture.root.join("source");
        let staging = fixture.root.join("staging");
        let raw = fixture.root.join("raw");
        for path in [&project, &frozen, &staging, &raw] {
            fs::create_dir(path).unwrap();
        }
        let project = fs::canonicalize(project).unwrap();
        let frozen = fs::canonicalize(frozen).unwrap();
        let source = "export const count = 1";
        fs::write(project.join("format.view.ts"), source).unwrap();
        fs::write(frozen.join("format.view.ts"), source).unwrap();
        let files = PackFiles {
            snapshot: ReadySnapshot {
                sequence: 1,
                path: raw.clone(),
                compiler_commit: "unknown".into(),
                ready_at: Instant::now(),
                _owner: Arc::new(SnapshotOwner(raw)),
            },
            staging: staging.clone(),
            project_snapshot: Some(frozen.clone()),
        };
        let receipt = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1,
            "sources": [{ "path": frozen.join("format.view.ts"), "sha256": format!("{:x}", Sha256::digest(source.as_bytes())) }]
        })).unwrap();
        fs::write(staging.join(".watch-dependencies.json"), &receipt).unwrap();
        let mut accepted = BTreeMap::new();
        assert_eq!(
            read_modern_dependencies(&files, &project, &mut BTreeSet::new(), &mut accepted)
                .unwrap(),
            BTreeSet::from([project.join("format.view.ts")])
        );
        let paths = BTreeSet::from([project.join("format.view.ts")]);
        let accepted_identity = input_identities_fingerprint(&accepted);
        assert_eq!(
            tracked_input_fingerprint(&paths).unwrap(),
            accepted_identity
        );
        assert!(!staging.join(".watch-dependencies.json").exists());
        fs::write(staging.join(".watch-dependencies.json"), receipt).unwrap();
        fs::write(project.join("format.view.ts"), "export const count = 2").unwrap();
        assert_ne!(
            tracked_input_fingerprint(&paths).unwrap(),
            accepted_identity
        );
        let error =
            read_modern_dependencies(&files, &project, &mut BTreeSet::new(), &mut BTreeMap::new())
                .unwrap_err();
        assert!(error.to_string().contains("changed while packing"));
    }

    #[test]
    fn modern_raw_snapshot_lifetime_extends_until_last_owner_releases_it() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let path = fixture.root.join("raw");
        fs::create_dir(&path).unwrap();
        fs::write(path.join("app.json"), "{}").unwrap();
        let first = ReadySnapshot {
            sequence: 1,
            path: path.clone(),
            compiler_commit: "unknown".into(),
            ready_at: Instant::now(),
            _owner: Arc::new(SnapshotOwner(path.clone())),
        };
        let retained = first.clone();
        drop(first);
        assert!(path.join("app.json").is_file());
        drop(retained);
        assert!(!path.exists());
    }

    #[test]
    fn modern_pack_diagnostics_map_snapshot_files_to_original_project() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let raw = fixture.root.join("raw");
        let staging = fixture.root.join("pack");
        let source = fixture.root.join("source");
        let original = fixture.root.join("original-project");
        for path in [&raw, &staging, &source] {
            fs::create_dir(path).unwrap();
        }
        let snapshot = ReadySnapshot {
            sequence: 1,
            path: raw.clone(),
            compiler_commit: "unknown".into(),
            ready_at: Instant::now(),
            _owner: Arc::new(SnapshotOwner(raw)),
        };
        let files = PackFiles {
            snapshot,
            staging: staging.clone(),
            project_snapshot: Some(source.clone()),
        };
        let broken = source.join("view/broken.view.ts");
        fs::write(
            staging.join(".pack-error.json"),
            serde_json::to_vec(&serde_json::json!({
                "message": "pack failed",
                "stack": format!("Error in {}", broken.display()),
                "diagnostics": [{
                    "severity": "error", "code": "ERR_MODERN_VIEW_SYNTAX",
                    "message": "Unexpected token", "path": broken,
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let mut diagnostic = DevDiagnostic::new(7, "pack", "BUILD_FAILED", "child failed");
        enrich_pack_diagnostic(&mut diagnostic, &files, &original);
        assert_eq!(diagnostic.revision, 7);
        assert_eq!(diagnostic.message, "Unexpected token");
        assert_eq!(
            diagnostic.file,
            Some(
                original
                    .join("view/broken.view.ts")
                    .to_string_lossy()
                    .into_owned()
            )
        );
        assert!(diagnostic
            .stack
            .unwrap()
            .contains(original.to_string_lossy().as_ref()));
    }

    #[test]
    #[cfg(unix)]
    fn modern_inputs_reject_symlinks_without_reading_outside_project() {
        let fixture = WorkspaceDiscoveryFixture::new();
        let project = fixture.root.join("project");
        fs::create_dir(&project).unwrap();
        let outside = fixture.root.join("outside.js");
        fs::write(&outside, "private input").unwrap();
        std::os::unix::fs::symlink(&outside, project.join("linked.view.js")).unwrap();
        assert_eq!(
            project_input_fingerprint(&project, &[]).unwrap_err().kind(),
            io::ErrorKind::InvalidData
        );
        let frozen = fixture.root.join("frozen");
        assert_eq!(
            copy_project_inputs(&project, &frozen, &[])
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidData
        );
        assert!(!frozen.join("linked.view.js").exists());
        assert_eq!(fs::read_to_string(outside).unwrap(), "private input");
    }

    #[test]
    #[cfg(unix)]
    fn output_snapshot_rejects_symlink_without_following_it() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "weapp-dev-symlink-{}-{}",
            std::process::id(),
            NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        // Keep the destination outside the source tree, matching the
        // supervisor's paths_overlap guard.
        let destination = root.with_file_name(format!(
            "{}-snapshot",
            root.file_name().unwrap().to_string_lossy()
        ));
        let outside = root.join("outside.txt");
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, b"outside").unwrap();
        symlink(&outside, root.join("linked.txt")).unwrap();

        let fingerprint = tree_fingerprint(&root).expect_err("symlink must be rejected");
        assert_eq!(fingerprint.kind(), io::ErrorKind::InvalidData);
        let copy = copy_tree(&root, &destination).expect_err("symlink must not be copied");
        assert_eq!(copy.kind(), io::ErrorKind::InvalidData);
        assert!(!destination.join("linked.txt").exists());
        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(destination);
    }

    #[test]
    fn reload_diagnostics_are_versioned() {
        let diagnostic = DevDiagnostic::new(3, "pack", "BUILD_FAILED", "bad output");
        assert_eq!(diagnostic.schema_version, 1);
        assert_eq!(diagnostic.revision, 3);
    }

    #[test]
    fn receipt_compiler_identity_is_optional_but_validated_when_present() {
        let receipt = serde_json::json!({
            "protocolVersion": "1.0",
            "sessionId": "test",
            "sequence": 1,
            "kind": "success",
            "snapshot": "snapshot-1"
        });
        let legacy: BuildReceipt = serde_json::from_value(receipt.clone()).unwrap();
        assert!(legacy.compiler_commit.is_none());

        for commit in ["a".repeat(40), "b".repeat(64)] {
            let mut receipt = receipt.clone();
            receipt["compilerCommit"] = serde_json::json!(commit);
            let parsed: BuildReceipt = serde_json::from_value(receipt).unwrap();
            assert_eq!(parsed.compiler_commit.as_deref(), Some(commit.as_str()));
        }

        for invalid in [
            serde_json::Value::Null,
            serde_json::json!(42),
            serde_json::json!(""),
            serde_json::json!("a".repeat(39)),
            serde_json::json!("A".repeat(40)),
            serde_json::json!("g".repeat(40)),
        ] {
            let mut receipt = receipt.clone();
            receipt["compilerCommit"] = invalid.clone();
            assert!(
                serde_json::from_value::<BuildReceipt>(receipt).is_err(),
                "invalid compiler identity accepted: {invalid}"
            );
        }
    }

    #[test]
    fn modern_preparation_namespace_is_outside_project_and_has_independent_ownership() {
        let temporary_root = fs::canonicalize(std::env::temp_dir()).unwrap();
        let project = temporary_root.join(format!(
            "weapp-modern-preparation-project-{}-{}",
            std::process::id(),
            NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&project).unwrap();
        let first = PreparationOwner::new(allocate_preparation_namespace(&project).unwrap());
        let second = PreparationOwner::new(allocate_preparation_namespace(&project).unwrap());
        assert_ne!(first.path, second.path);
        assert!(!first.path.starts_with(&project));
        assert!(!second.path.starts_with(&project));
        let released = first.path.clone();
        drop(first);
        assert!(!released.exists());
        assert!(second.path.is_dir());
        assert!(allocate_preparation_namespace(&temporary_root).is_err());
        drop(second);
        fs::remove_dir(&project).unwrap();
    }

    #[test]
    fn concurrent_run_namespaces_publish_without_reusing_historical_paths() {
        let root = std::env::temp_dir().join(format!(
            "weapp-dev-run-allocation-{}-{}",
            std::process::id(),
            NEXT_SNAPSHOT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(root.join("generation-1")).unwrap();
        fs::write(root.join("generation-1/manifest.json"), b"historical").unwrap();
        fs::write(root.join("current"), b"generation-1").unwrap();
        let workers = (0..8)
            .map(|_| {
                let root = root.clone();
                std::thread::spawn(move || {
                    let (identity, run) = allocate_run_namespace(&root).unwrap();
                    fs::create_dir(run.join(".staging-1")).unwrap();
                    fs::write(run.join(".staging-1/manifest.json"), identity.as_bytes()).unwrap();
                    fs::rename(run.join(".staging-1"), run.join("generation-1")).unwrap();
                    (identity, run)
                })
            })
            .collect::<Vec<_>>();
        let runs = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect::<Vec<_>>();
        let identities = runs
            .iter()
            .map(|(identity, _)| identity)
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(identities.len(), runs.len());
        for (identity, run) in runs {
            assert_eq!(
                fs::read(run.join("generation-1/manifest.json")).unwrap(),
                identity.as_bytes()
            );
        }
        assert_eq!(
            fs::read(root.join("generation-1/manifest.json")).unwrap(),
            b"historical"
        );
        assert_eq!(fs::read(root.join("current")).unwrap(), b"generation-1");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn watch_command_uses_public_api_receipt_adapter() {
        let command = watch_adapter_command(
            Path::new("node"),
            Path::new("/tmp/custom-wv"),
            Path::new("/tmp/workspace"),
            Path::new("/tmp/reference-app"),
            Path::new("/tmp/reference-app/dist"),
        );
        let args = command
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            vec![
                "/tmp/workspace/scripts/simulator-watch.mjs",
                "--project",
                "/tmp/reference-app",
                "--wv-bin",
                "/tmp/custom-wv",
                "--output-root",
                "/tmp/reference-app/dist",
            ]
        );
    }

    #[test]
    fn project_output_resolution_rejects_absolute_and_parent_paths() {
        let project = Path::new("/tmp/weapp-project");
        assert_eq!(
            safe_project_child(project, "dist"),
            Some(project.join("dist"))
        );
        assert!(safe_project_child(project, "/tmp/outside").is_none());
        assert!(safe_project_child(project, "../outside").is_none());
        assert!(safe_project_child(project, "dist/../../outside").is_none());
    }

    #[test]
    fn source_app_json_resolution_prefers_source_root_over_generated_root() {
        let root =
            std::env::temp_dir().join(format!("weapp-source-app-root-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dist")).unwrap();
        fs::write(
            root.join("project.config.json"),
            br#"{"srcMiniprogramRoot":".","miniprogramRoot":"dist"}"#,
        )
        .unwrap();
        fs::write(root.join("app.json"), b"{}\n").unwrap();
        fs::write(root.join("dist/app.json"), b"{\"pages\":[]}").unwrap();
        assert_eq!(resolve_source_app_json(&root), root.join("app.json"));
        fs::remove_file(root.join("app.json")).unwrap();
        assert_eq!(resolve_source_app_json(&root), root.join("app.json"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn output_overlap_check_normalizes_parent_components() {
        let project = Path::new("/tmp/weapp-project");
        assert!(paths_overlap(
            &project.join("dist"),
            &project.join("tmp/../dist/generations")
        ));
        assert!(!paths_overlap(
            &project.join("dist"),
            &project.join(".weapp-container/dev")
        ));
    }

    #[allow(dead_code)]
    fn _manifest_is_used_to_keep_test_imports_stable() {
        let _ = manifest();
    }

    // The development supervisor owns a real child process and therefore
    // needs an integration-style fixture.  This tiny fake `wv` copies a
    // known-good weapp-vite output into `dist/` and then stays alive until the
    // supervisor drops it.  Tests mutate that output directly to model watch
    // rebuilds without depending on a globally installed compiler.
    #[cfg(unix)]
    struct FakeWvProject {
        root: PathBuf,
        project: PathBuf,
        dist: PathBuf,
        output: PathBuf,
        pid: PathBuf,
        next_sequence: std::cell::Cell<u64>,
        source_app_json: PathBuf,
    }

    #[cfg(unix)]
    impl FakeWvProject {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let id = NEXT.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "weapp-dev-supervisor-{}-{}",
                std::process::id(),
                id
            ));
            let project = root.join("project");
            let dist = project.join("dist");
            let output = root.join("generations");
            let pid = root.join("wv-pid");
            let stopped = root.join("wv-stopped");
            fs::create_dir_all(&project).expect("create fake project");

            // Every test owns its compiler input. Reading the reference
            // project's generated dist would require a prior build and race
            // with the real watch/browser smoke clearing that same tree.
            let fixture = root.join("compiler-output");
            fs::create_dir_all(fixture.join("pages/home")).unwrap();
            for (path, contents) in [
                ("app.json", r#"{"pages":["pages/home/index"]}"#),
                ("app.js", "App({});"),
                ("app.wxss", "page { background: #f5f5f5; }"),
                ("pages/home/index.json", "{}"),
                ("pages/home/index.js", "Page({data:{title:'fixture'}});"),
                (
                    "pages/home/index.wxml",
                    "<view class=\"screen\"><text>{{title}}</text></view>",
                ),
                ("pages/home/index.wxss", ".screen { padding: 10px; }"),
            ] {
                fs::write(fixture.join(path), contents).unwrap();
            }
            let source_app_json = project.join("app.json");
            fs::copy(fixture.join("app.json"), &source_app_json)
                .expect("copy fake source app.json");
            let script = root.join("fake-wv.sh");
            let fixture = shell_quote(&fixture);
            let pid_path = shell_quote(&pid);
            let stopped_path = shell_quote(&stopped);
            let script_source = format!(
                r#"#!/bin/sh
set -eu
printf '%s' "$$" > {pid}
seq=1
emit() {{
  name=$(printf '%020d' "$seq")
  printf '{{"protocolVersion":"1.0","sessionId":"%s","sequence":%s,"kind":"%s","snapshot":%s}}\n' "$WEAPP_CONTAINER_SIMULATOR_SESSION_ID" "$seq" "$1" "$2" > "$WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR/receipts/.$name.tmp"
  mv "$WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR/receipts/.$name.tmp" "$WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR/receipts/$name.json"
  seq=$((seq + 1))
}}
emit building null
mkdir -p "$PWD/dist"
cp -R {fixture}/. "$PWD/dist/"
mkdir -p "$WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR/snapshots/initial"
cp -R "$PWD/dist/." "$WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR/snapshots/initial/"
emit success '"snapshots/initial"'
trap 'printf stopped > {stopped}; exit 0' TERM INT EXIT
while :; do sleep 0.05; done
"#,
                fixture = fixture,
                pid = pid_path,
                stopped = stopped_path,
            );
            fs::write(&script, script_source).expect("write fake wv");
            let mut permissions = fs::metadata(&script)
                .expect("fake wv metadata")
                .permissions();
            use std::os::unix::fs::PermissionsExt;
            permissions.set_mode(0o755);
            fs::set_permissions(&script, permissions).expect("chmod fake wv");
            Self {
                root,
                project,
                dist,
                output,
                pid,
                next_sequence: std::cell::Cell::new(3),
                source_app_json,
            }
        }

        fn receipt(&self, supervisor: &DevSupervisor, kind: &str, message: Option<&str>) {
            self.receipt_with_compiler(supervisor, kind, message, None);
        }

        fn receipt_with_compiler(
            &self,
            supervisor: &DevSupervisor,
            kind: &str,
            message: Option<&str>,
            compiler_commit: Option<&str>,
        ) {
            let sequence = self.next_sequence.get();
            self.next_sequence.set(sequence + 1);
            let snapshot = if kind == "success" {
                let relative = format!("snapshots/test-{sequence}");
                copy_tree(&self.dist, &supervisor.receipt_root.join(&relative)).unwrap();
                Some(relative)
            } else {
                None
            };
            let mut receipt = serde_json::json!({
                "protocolVersion":"1.0", "sessionId":supervisor.receipt_session,
                "sequence":sequence, "kind":kind, "snapshot":snapshot, "message":message,
            });
            if let Some(compiler_commit) = compiler_commit {
                receipt["compilerCommit"] = serde_json::json!(compiler_commit);
            }
            let path = supervisor
                .receipt_root
                .join("receipts")
                .join(format!("{sequence:020}.json"));
            let temporary = path.with_extension("tmp");
            fs::write(&temporary, serde_json::to_vec(&receipt).unwrap()).unwrap();
            fs::rename(temporary, path).unwrap();
        }

        fn success(&self, supervisor: &DevSupervisor) {
            self.receipt(supervisor, "success", None);
        }

        fn config(&self) -> DevConfig {
            let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
            let mut config = DevConfig::new(
                &self.project,
                SimulatorConfig {
                    // These fixtures exercise compiler receipts, publication
                    // and reload semantics, not cold native View latency.
                    // Keep a finite budget under parallel test contention;
                    // production defaults and dedicated deadline gates stay unchanged.
                    semantic_view_execution: Some(container_runtime::ViewExecutionPolicy {
                        batch_timeout_ms: 2_000,
                    }),
                    ..Default::default()
                },
            );
            config.wv_bin = self.root.join("fake-wv.sh");
            config.node_bin = PathBuf::from("node");
            config.workspace_root = Some(workspace_root);
            config.output_dir = self.output.clone();
            // Keep integration tests quick while still exercising the
            // supervisor's debounce state machine.
            config.poll_interval = Duration::from_millis(20);
            config
        }
    }

    #[cfg(unix)]
    impl Drop for FakeWvProject {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[cfg(unix)]
    fn shell_quote(path: &Path) -> String {
        format!("'{}'", path.to_string_lossy().replace('\'', "'\\''"))
    }

    #[cfg(unix)]
    fn wait_for_portable(supervisor: &mut DevSupervisor) -> PortablePackReport {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for portable pack"
            );
            match supervisor.poll().expect("poll pack-only supervisor") {
                Some(DevEvent::PortableReady { revision, report }) => {
                    assert_eq!(revision, report.revision);
                    return report;
                }
                Some(DevEvent::PackReady { .. } | DevEvent::RuntimeUpdated { .. }) => {
                    panic!("pack-only consumer must not publish runtime events")
                }
                Some(DevEvent::Diagnostic(diagnostic)) => {
                    panic!("unexpected portable diagnostic: {diagnostic:?}")
                }
                Some(DevEvent::Exited(status)) => {
                    panic!("fake wv exited before portable pack: {status}")
                }
                Some(DevEvent::BuildStarted | DevEvent::BrowserRuntimePrepared { .. }) | None => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_pack(supervisor: &mut DevSupervisor) -> (u64, Option<DevReloadKind>) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for fake wv pack"
            );
            match supervisor.poll().expect("poll fake wv") {
                Some(DevEvent::PackReady {
                    revision, reload, ..
                }) => return (revision, reload),
                Some(DevEvent::PortableReady { .. }) => {
                    panic!("local-runtime test received a pack-only publication")
                }
                Some(DevEvent::Diagnostic(diagnostic)) => {
                    panic!("unexpected development diagnostic: {diagnostic:?}")
                }
                Some(DevEvent::Exited(status)) => {
                    panic!("fake wv exited before a pack was ready: {status}")
                }
                Some(
                    DevEvent::BuildStarted
                    | DevEvent::RuntimeUpdated { .. }
                    | DevEvent::BrowserRuntimePrepared { .. },
                )
                | None => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_diagnostic(supervisor: &mut DevSupervisor) -> DevDiagnostic {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            assert!(
                Instant::now() < deadline,
                "timed out waiting for fake wv diagnostic"
            );
            match supervisor.poll().expect("poll fake wv") {
                Some(DevEvent::Diagnostic(diagnostic)) => return diagnostic,
                Some(DevEvent::PackReady { .. } | DevEvent::PortableReady { .. }) => {
                    panic!("unexpected pack while waiting for diagnostic")
                }
                Some(DevEvent::Exited(status)) => {
                    panic!("fake wv exited before diagnostic: {status}")
                }
                Some(
                    DevEvent::BuildStarted
                    | DevEvent::RuntimeUpdated { .. }
                    | DevEvent::BrowserRuntimePrepared { .. },
                )
                | None => {
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
    }

    #[cfg(unix)]
    fn wait_for_fake_builder_handshake(supervisor: &mut DevSupervisor, pids: &[&Path]) {
        // This is process startup, not a View or pack execution deadline. Wait
        // for the existing atomic compiler receipt, which follows PID writes
        // and the complete fixture copy, without starting a pack/session.
        let deadline = Instant::now() + Duration::from_secs(15);
        let receipt_path = supervisor
            .receipt_root
            .join("receipts/00000000000000000002.json");
        loop {
            supervisor.poll_build_output();
            let status = supervisor
                .child
                .as_mut()
                .expect("owned fake builder")
                .try_wait()
                .expect("poll fake builder startup");
            if let Some(status) = status {
                // EOF can lag process exit. Keep a separate, bounded drain so
                // cargo retains child stderr when reporting the startup cause.
                let drain_deadline = Instant::now() + Duration::from_millis(100);
                while !supervisor.output_drained && Instant::now() < drain_deadline {
                    supervisor.poll_build_output();
                    std::thread::sleep(Duration::from_millis(1));
                }
                panic!(
                    "fake builder exited before handshake: {status}; output_drained={}; pid_markers={:?}",
                    supervisor.output_drained,
                    pids.iter().map(|path| path.is_file()).collect::<Vec<_>>()
                );
            }
            if receipt_path.is_file() {
                let receipt = read_receipt(&receipt_path, &supervisor.receipt_session)
                    .expect("validate fake builder startup receipt");
                assert!(matches!(receipt.kind, ReceiptKind::Success));
                let snapshot = receipt_snapshot_path(
                    &supervisor.receipt_root,
                    receipt.snapshot.as_deref().expect("startup snapshot"),
                )
                .unwrap();
                assert!(snapshot.join("app.json").is_file());
                for path in pids {
                    let pid = fs::read_to_string(path).expect("startup PID marker");
                    let pid = pid.trim().parse::<u32>().expect("numeric startup PID");
                    assert!(pid > 0);
                    assert!(Command::new("kill")
                        .args(["-0", &pid.to_string()])
                        .status()
                        .expect("check started process")
                        .success());
                }
                return;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for fake builder receipt/PID handshake; output_drained={}; pid_markers={:?}",
                supervisor.output_drained,
                pids.iter().map(|path| path.is_file()).collect::<Vec<_>>()
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    fn wait_for_process_exit(pid_path: &Path) {
        let pid = fs::read_to_string(pid_path)
            .expect("fake wv pid marker")
            .trim()
            .to_owned();
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let alive = Command::new("kill")
                .args(["-0", &pid])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);
            if !alive {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("fake wv process {pid} survived supervisor shutdown");
    }

    #[test]
    #[cfg(unix)]
    fn receipt_compiler_identity_overrides_vendor_and_repackages_identical_output() {
        let fixture = FakeWvProject::new();
        let config = fixture.config();
        let receipt_commit = "a".repeat(40);
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        wait_for_pack(&mut supervisor);
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            "unknown"
        );

        // Receipt metadata supplies the compiler identity independently of
        // the tool workspace's vendor; it does not certify clean bytes.
        // Identical output must still publish a corrected manifest identity.
        fixture.receipt_with_compiler(&supervisor, "success", None, Some(&receipt_commit));
        assert_eq!(
            wait_for_pack(&mut supervisor),
            (2, Some(DevReloadKind::InPlace))
        );
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            receipt_commit
        );
        assert_eq!(
            supervisor
                .simulator()
                .unwrap()
                .report("ready")
                .compiler
                .commit,
            receipt_commit
        );
        let sha256_commit = "b".repeat(64);
        fixture.receipt_with_compiler(&supervisor, "success", None, Some(&sha256_commit));
        assert_eq!(
            wait_for_pack(&mut supervisor),
            (3, Some(DevReloadKind::InPlace))
        );
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            sha256_commit
        );
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn explicit_compiler_claim_overrides_receipt_identity_and_controls_deduplication() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        let explicit_commit = "c".repeat(40);
        config.compiler_commit = Some(explicit_commit.clone());
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        wait_for_pack(&mut supervisor);
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            explicit_commit
        );
        fs::write(
            fixture.dist.join("app.wxss"),
            "page { background: #123456; }",
        )
        .unwrap();
        fixture.receipt_with_compiler(&supervisor, "success", None, Some(&"a".repeat(40)));
        assert_eq!(
            wait_for_pack(&mut supervisor),
            (2, Some(DevReloadKind::InPlace))
        );
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            explicit_commit
        );

        // An ignored receipt identity cannot invalidate the explicit claim
        // or force a duplicate pack when recovering the exact same bytes.
        fixture.receipt(&supervisor, "error", Some("temporary compiler failure"));
        assert_eq!(wait_for_diagnostic(&mut supervisor).code, "BUILD_FAILED");
        fixture.receipt_with_compiler(&supervisor, "success", None, Some(&"b".repeat(64)));
        assert_eq!(wait_for_pack(&mut supervisor), (2, None));
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            explicit_commit
        );
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn blank_compiler_claim_and_legacy_receipt_record_unknown() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.compiler_commit = Some(" \t ".to_owned());
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        wait_for_pack(&mut supervisor);
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            "unknown"
        );
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn invalid_compiler_receipt_preserves_previous_pack_and_runtime() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let simulator = supervisor.simulator().unwrap();
        let session = simulator.session_id().to_owned();
        let pack = simulator.root().to_path_buf();
        fixture.receipt_with_compiler(&supervisor, "success", None, Some("not-a-git-commit"));
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_RECEIPT_INVALID");
        assert!(diagnostic.message.contains("compilerCommit"));
        assert_eq!(supervisor.revision(), 1);
        assert_eq!(supervisor.simulator().unwrap().root(), pack);
        assert_eq!(
            supervisor.simulator().unwrap().manifest().compiler.commit,
            "unknown"
        );
        assert_old_runtime_responds(&mut supervisor, &session);
        assert!(supervisor.pending_pack.is_none());
        assert!(!supervisor.run_root.join("generation-2").exists());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn external_project_starts_without_workspace_override() {
        let fixture = FakeWvProject::new();
        assert!(find_workspace_root(&fixture.project).is_none());
        let mut config = fixture.config();
        config.workspace_root = None;
        let (mut supervisor, event) = DevSupervisor::spawn(config)
            .expect("an external app must discover the simulator's tool checkout");
        assert!(matches!(event, DevEvent::BuildStarted));
        assert_eq!(wait_for_pack(&mut supervisor), (1, None));
        let simulator = supervisor.simulator().unwrap();
        assert!(simulator.host().initialized());
        assert_eq!(
            simulator.report("ready").route.as_deref(),
            Some("pages/home/index")
        );
        assert_eq!(
            fs::canonicalize(&supervisor.workspace_root).unwrap(),
            fs::canonicalize(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")).unwrap()
        );
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_request_invalidation_emits_update_without_a_render_commit() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.simulator.browser_view_enabled = true;
        config.simulator.renderer_override = Some(container_ir::RendererProfile::WebView);
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        wait_for_pack(&mut supervisor);
        let original = supervisor
            .simulator()
            .unwrap()
            .browser_render_request()
            .unwrap()
            .revision
            .clone();
        assert!(supervisor.pump_runtime(0).unwrap().is_none());
        let batch = supervisor
            .simulator_mut()
            .unwrap()
            .dispatch_request(
                container_bridge::op::DATA_PATCH_BATCH,
                serde_json::json!({"pageId":1,"patches":[{"path":"title","op":"set","value":"changed"}]}),
            )
            .unwrap();
        assert_eq!(batch.messages[0].payload["ok"], true);
        assert!(supervisor
            .pump_runtime_with_render(0, false)
            .unwrap()
            .is_none());
        let DevEvent::RuntimeUpdated { batch, report, .. } = supervisor
            .pump_runtime_with_render(0, true)
            .unwrap()
            .expect("queued browser work is a runtime update")
        else {
            panic!("expected runtime update");
        };
        assert!(
            batch.messages.is_empty(),
            "DOM request scheduling has no render.commit response"
        );
        assert!(report.snapshot.is_none());
        assert_ne!(
            supervisor
                .simulator()
                .unwrap()
                .browser_render_request()
                .unwrap()
                .revision,
            original
        );
        assert!(supervisor.pump_runtime(0).unwrap().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_pack_ready_waits_for_exact_ack_and_rejection_keeps_accepted_inputs() {
        use container_bridge::op;
        use container_runtime::BrowserViewSubmission;

        fn prepare(simulator: &mut Simulator) -> BrowserViewSubmission {
            let request = simulator.browser_render_request().unwrap().clone();
            let result = simulator
                .dispatch_request(
                    op::VIEW_PREPARE,
                    serde_json::json!({
                        "version":"1.0", "surfaceGeneration":"1", "render":request.render,
                    }),
                )
                .unwrap();
            assert_eq!(result.messages[0].payload["ok"], true);
            serde_json::from_value(result.messages[0].payload["submission"].clone()).unwrap()
        }
        fn acknowledge(simulator: &mut Simulator, submission: BrowserViewSubmission) {
            let mut pending: Vec<_> = submission.document.nodes.iter().collect();
            let mut nodes = Vec::new();
            while let Some(node) = pending.pop() {
                nodes.push(serde_json::json!({"occurrenceId":node.occurrence_id(),
                    "borderBox":{"x":0,"y":0,"width":100,"height":30},
                    "scrollOffset":{"x":0,"y":0}, "scrollExtent":{"width":100,"height":30},
                    "clientSize":{"width":100,"height":30}}));
                if let container_ir::ViewNode::Element { children, .. } = node {
                    pending.extend(children);
                }
            }
            let result = simulator
                .dispatch_request(
                    op::VIEW_PREPARE_COMMIT,
                    serde_json::json!({
                        "version":"1.0", "key":submission.key, "epoch":"0",
                        "viewport":submission.viewport, "nodes":nodes,
                    }),
                )
                .unwrap();
            assert_eq!(result.messages[0].payload["ok"], true);
            let result = simulator
                .dispatch_request(
                    op::VIEW_PRESENTED,
                    result.messages[0].payload["permit"].clone(),
                )
                .unwrap();
            assert_eq!(result.messages[0].payload["ok"], true);
        }
        for commit in [false, true] {
            let fixture = FakeWvProject::new();
            let mut config = fixture.config();
            config.simulator.browser_view_enabled = true;
            config.simulator.renderer_override = Some(container_ir::RendererProfile::WebView);
            let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
            wait_for_pack(&mut supervisor);
            let initial = prepare(supervisor.simulator_mut().unwrap());
            acknowledge(supervisor.simulator_mut().unwrap(), initial);
            let accepted_root = supervisor.simulator().unwrap().root().to_owned();
            let accepted_identity = supervisor.last_build_identity.clone();
            let accepted_dependencies = supervisor.modern_dependencies.clone();
            let mut style = fs::read_to_string(fixture.dist.join("pages/home/index.wxss")).unwrap();
            style.push_str("\n.screen { opacity: 0.98; }\n");
            fs::write(fixture.dist.join("pages/home/index.wxss"), style).unwrap();
            fixture.success(&supervisor);
            let deadline = Instant::now() + Duration::from_secs(15);
            loop {
                assert!(Instant::now() < deadline, "staged browser update deadline");
                match supervisor.poll().unwrap() {
                    Some(DevEvent::RuntimeUpdated { report, .. }) if report.status == "staged" => {
                        break
                    }
                    Some(DevEvent::PackReady { .. }) => panic!("PackReady before browser ACK"),
                    Some(DevEvent::Diagnostic(diagnostic)) => {
                        panic!("stage failed: {diagnostic:?}")
                    }
                    _ => std::thread::sleep(Duration::from_millis(5)),
                }
            }
            let generation = supervisor
                .deferred_browser_pack
                .as_ref()
                .unwrap()
                .generation
                .clone();
            assert!(supervisor.simulator().unwrap().browser_dev_pack_pending());
            assert_eq!(supervisor.simulator().unwrap().root(), accepted_root);
            assert_eq!(supervisor.last_build_identity, accepted_identity);
            assert_eq!(supervisor.modern_dependencies, accepted_dependencies);
            assert!(supervisor.poll().unwrap().is_none());
            if commit {
                fixture.receipt(&supervisor, "error", Some("newer source build failed"));
                let diagnostic = wait_for_diagnostic(&mut supervisor);
                assert!(
                    diagnostic.message.contains("newer source build failed"),
                    "{diagnostic:?}"
                );
                assert!(supervisor.diagnostic_active);
                assert!(!supervisor.raw_build_ready);
            }
            let candidate = prepare(supervisor.simulator_mut().unwrap());
            if commit {
                acknowledge(supervisor.simulator_mut().unwrap(), candidate);
            } else {
                let result = supervisor
                    .simulator_mut()
                    .unwrap()
                    .dispatch_request(op::VIEW_ABORT, serde_json::to_value(candidate.key).unwrap())
                    .unwrap();
                assert_eq!(result.messages[0].payload["ok"], true);
                assert_eq!(result.messages[0].payload["inputEnabled"], true);
            }
            assert_eq!(
                supervisor.last_build_identity, accepted_identity,
                "ACK observation alone is not supervisor publication"
            );
            let event = supervisor.poll().unwrap().expect("exact final publication");
            if commit {
                assert!(matches!(event, DevEvent::PackReady { revision: 2, .. }));
                assert_eq!(supervisor.simulator().unwrap().root(), generation);
                assert_ne!(supervisor.last_build_identity, accepted_identity);
                assert!(generation.is_dir());
                assert!(
                    supervisor.diagnostic_active,
                    "old candidate ACK must preserve newer source failure"
                );
            } else {
                let DevEvent::Diagnostic(diagnostic) = event else {
                    panic!("abort must not publish PackReady")
                };
                assert_eq!(diagnostic.code, "RELOAD_FAILED");
                assert_eq!(supervisor.simulator().unwrap().root(), accepted_root);
                assert_eq!(supervisor.last_build_identity, accepted_identity);
                assert!(!generation.exists());
            }
            drop(supervisor);
            wait_for_process_exit(&fixture.pid);
        }
    }

    #[test]
    #[cfg(unix)]
    fn fake_wv_pack_switch_is_atomic_and_cleans_up_watcher() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, first_event) = DevSupervisor::spawn(fixture.config()).unwrap();
        assert!(matches!(first_event, DevEvent::BuildStarted));
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 1);
        assert_eq!(reload, None);
        assert_eq!(
            supervisor.simulator().unwrap().trace_summary().retention,
            TraceRetention::development()
        );
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert!(!fixture.output.join(".staging-1").exists());

        // A style-only write produces a complete second generation while the
        // first generation remains available for readers of the previous
        // snapshot.  The simulator classifies it as an in-place reload.
        let mut style = fs::read_to_string(fixture.dist.join("pages/home/index.wxss")).unwrap();
        style.push_str("\n.screen { opacity: 0.99; }\n");
        fs::write(fixture.dist.join("pages/home/index.wxss"), style).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::InPlace));
        assert_eq!(
            supervisor.simulator().unwrap().trace_summary().retention,
            TraceRetention::development()
        );
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert!(supervisor
            .run_root
            .join("generation-2/manifest.json")
            .is_file());
        assert!(!fixture.output.join(".staging-2").exists());

        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn restarting_same_output_preserves_packs_and_rotates_runtime_identity() {
        let fixture = FakeWvProject::new();
        // Reproduce the previous layout left by a completed dev invocation.
        fs::create_dir_all(fixture.output.join("generation-1")).unwrap();
        fs::write(fixture.output.join("generation-1/manifest.json"), b"legacy").unwrap();
        fs::write(fixture.output.join("current"), b"generation-1").unwrap();

        let (mut first, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        assert_eq!(wait_for_pack(&mut first), (1, None));
        let first_root = first.run_root.clone();
        let first_preparation = first.preparation_root.path.clone();
        let ownership: serde_json::Value =
            serde_json::from_slice(&fs::read(first_root.join("dev-session.json")).unwrap())
                .unwrap();
        assert_eq!(ownership["schemaVersion"], 1);
        assert_eq!(ownership["ownerPid"], std::process::id());
        assert_eq!(ownership["sessionId"], first.receipt_session);
        assert_eq!(
            ownership["compilerOutput"],
            serde_json::json!(fs::canonicalize(&first.build_output).unwrap())
        );
        let first_pack = fs::read(first_root.join("generation-1/manifest.json")).unwrap();
        let first_session = first.simulator().unwrap().session_id().to_owned();
        drop(first);
        wait_for_process_exit(&fixture.pid);
        assert!(!first_preparation.exists());

        let (mut second, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        assert_eq!(wait_for_pack(&mut second), (1, None));
        let second_root = second.run_root.clone();
        let second_preparation = second.preparation_root.path.clone();
        let second_session = second.simulator().unwrap().session_id().to_owned();
        assert_ne!(first_root, second_root);
        assert_ne!(first_session, second_session);
        assert!(second_session.ends_with(&format!("-dev-{}", second.receipt_session)));
        assert!(second_root.join("generation-1/manifest.json").is_file());
        let stale = second
            .simulator_mut()
            .unwrap()
            .dispatch(container_bridge::BridgeEnvelope::request(
                first_session,
                "previous-run-input",
                container_bridge::op::DIAGNOSTIC,
                serde_json::json!({}),
            ))
            .unwrap();
        assert_eq!(stale.messages[0].op, container_bridge::op::ERROR);
        assert_eq!(stale.messages[0].payload["ok"], false);

        fs::write(
            fixture.dist.join("pages/home/index.wxss"),
            ".screen { opacity: 0.9; }",
        )
        .unwrap();
        fixture.success(&second);
        assert_eq!(
            wait_for_pack(&mut second),
            (2, Some(DevReloadKind::InPlace))
        );
        assert_eq!(second.simulator().unwrap().session_id(), second_session);
        assert!(second_root.join("generation-2/manifest.json").is_file());
        drop(second);
        wait_for_process_exit(&fixture.pid);
        assert!(!second_preparation.exists());
        assert!(second_root.join("generation-2/manifest.json").is_file());
        assert_eq!(
            fs::read(first_root.join("generation-1/manifest.json")).unwrap(),
            first_pack
        );
        assert_eq!(
            fs::read(fixture.output.join("generation-1/manifest.json")).unwrap(),
            b"legacy"
        );
        assert_eq!(
            fs::read(fixture.output.join("current")).unwrap(),
            b"generation-1"
        );
    }

    #[test]
    #[cfg(unix)]
    fn default_vendor_wv_cleanup_stops_wrapper_and_descendant() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = FakeWvProject::new();
        let workspace = fixture.root.join("workspace");
        let vendor = workspace.join("vendor/weapp-vite");
        let bin = vendor.join("node_modules/.bin");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(workspace.join("scripts")).unwrap();
        for script in [
            "simulator-watch.mjs",
            "simulator-source-credit.mjs",
            "simulator-watch-diagnostics.mjs",
        ] {
            fs::copy(
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../scripts")
                    .join(script),
                workspace.join("scripts").join(script),
            )
            .unwrap();
        }
        fs::write(vendor.join("package.json"), "{}").unwrap();
        let wrapper_pid = fixture.root.join("wrapper-pid");
        let wrapper = bin.join("wv");
        fs::write(&wrapper, format!(
            "#!/bin/sh\nset -eu\nprintf '%s' \"$$\" > {}\n{} \"$@\" &\nwatch_pid=$!\ntrap 'wait \"$watch_pid\" || true; exit 0' TERM INT\nwait \"$watch_pid\"\n",
            shell_quote(&wrapper_pid), shell_quote(&fixture.root.join("fake-wv.sh")),
        )).unwrap();
        fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
        let mut config = fixture.config();
        // Exercise normal pinned-vendor discovery, with a shell wrapper and
        // a long-running descendant just like pnpm/Node compiler workers.
        config.wv_bin = PathBuf::from("wv");
        config.workspace_root = Some(workspace);
        config.compiler_commit = Some("test-pinned-commit".to_owned());
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        wait_for_fake_builder_handshake(&mut supervisor, &[&wrapper_pid, &fixture.pid]);
        assert_eq!(supervisor.revision(), 0);
        assert!(supervisor.simulator().is_none());
        drop(supervisor);
        wait_for_process_exit(&wrapper_pid);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn invalid_pack_preserves_previous_generation_and_runtime() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        let (revision, _) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 1);
        let session_id = supervisor
            .simulator()
            .expect("initial simulator")
            .session_id()
            .to_owned();
        let generation = supervisor.run_root.join("generation-1/manifest.json");
        assert!(generation.is_file());

        // Invalid JSON makes container-pack fail.  The active generation and
        // session must continue serving while the compiler error is exposed.
        let app_json = fixture.dist.join("app.json");
        let original = fs::read(&app_json).unwrap();
        fs::write(&app_json, b"{\n").unwrap();
        fixture.success(&supervisor);
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "pack");
        assert!(generation.is_file());
        assert_eq!(
            supervisor.simulator().unwrap().session_id(),
            session_id.as_str()
        );

        // Restoring the source creates a new fingerprint and allows the
        // supervisor to recover without losing the previous runtime state.
        fs::write(app_json, original).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, None);
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert!(!supervisor.run_root.join("generation-2").exists());
        assert_eq!(supervisor.simulator().unwrap().session_id(), session_id);
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn compiler_error_overlay_keeps_stale_output_until_new_generation() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session_id = supervisor.simulator().unwrap().session_id().to_owned();

        // The fake watcher reports a compiler error while leaving dist/ intact,
        // which is the failure mode of a real watcher after a malformed JSON
        // edit.  The previous generation must stay live and the error must not
        // be cleared by a stale success line.
        fixture.receipt(&supervisor, "error", Some("malformed app.json"));
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "build");
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert_eq!(supervisor.simulator().unwrap().session_id(), session_id);

        // Once a different, stable output tree appears, the gate opens and the
        // valid generation can replace the old one through an in-place reload.
        let path = fixture.dist.join("pages/home/index.wxss");
        let mut style = fs::read_to_string(&path).unwrap();
        style.push_str("\n.screen { opacity: 0.96; }\n");
        fs::write(path, style).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::InPlace));
        assert_eq!(supervisor.simulator().unwrap().session_id(), session_id);
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn idle_surface_ticks_reuse_compiler_observations_until_their_deadline() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        supervisor.config.poll_interval = Duration::from_secs(3600);
        let observed_at = Instant::now();
        supervisor.last_compiler_poll = Some(observed_at);
        supervisor.last_modern_poll = observed_at;
        let sequence = supervisor.last_receipt_sequence;

        // These observations belong to the compiler clock, not each socket,
        // input or timer tick. In particular a queued receipt is not consumed
        // by merely draining unrelated compiler logs.
        fs::write(&fixture.source_app_json, b"{\n").unwrap();
        fixture.receipt(&supervisor, "error", Some("new build failed"));
        for _ in 0..1_000 {
            assert!(supervisor.poll().unwrap().is_none());
        }
        assert_eq!(supervisor.last_compiler_poll, Some(observed_at));
        assert_eq!(supervisor.last_receipt_sequence, sequence);
        assert!(supervisor.source_error_fingerprint.is_none());
        assert_old_runtime_responds(&mut supervisor, &session);

        supervisor.last_compiler_poll = Some(observed_at - supervisor.config.poll_interval);
        let Some(DevEvent::Diagnostic(diagnostic)) = supervisor.poll().unwrap() else {
            panic!("due compiler observation missed malformed source");
        };
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert!(supervisor.last_receipt_sequence > sequence);
        assert!(supervisor.source_error_fingerprint.is_some());
        assert_eq!(supervisor.simulator().unwrap().session_id(), session);
    }

    #[test]
    #[cfg(unix)]
    fn watcher_exit_forces_a_final_compiler_observation_without_waiting_for_the_deadline() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let previous = supervisor.simulator().unwrap().root().to_path_buf();
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        let sequence = supervisor.last_receipt_sequence;
        fs::write(&fixture.source_app_json, b"{\n").unwrap();
        fixture.receipt(&supervisor, "building", None);
        signal_owned_process(supervisor.child.as_mut().unwrap());

        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert!(supervisor.watcher_exit_observed || supervisor.output_drained);
        assert!(supervisor.last_receipt_sequence > sequence);
        assert_eq!(supervisor.simulator().unwrap().root(), previous);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn pack_start_rechecks_source_before_the_periodic_observation_is_due() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let previous = supervisor.simulator().unwrap().root().to_path_buf();
        fs::write(
            fixture.dist.join("pages/home/index.wxss"),
            ".screen { opacity: 0.7; }",
        )
        .unwrap();
        fixture.success(&supervisor);
        assert!(supervisor.poll_compiler_inputs(true).is_none());
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.pending_snapshot.as_mut().unwrap().ready_at =
            Instant::now() - supervisor.config.poll_interval;
        fs::remove_file(&fixture.source_app_json).unwrap();

        let Some(DevEvent::Diagnostic(diagnostic)) = supervisor.start_pending_pack().unwrap()
        else {
            panic!("pack start accepted a stale source observation");
        };
        assert_eq!(diagnostic.message, "source app.json is missing");
        assert!(supervisor.pending_pack.is_none());
        assert!(supervisor.pending_snapshot.is_none());
        assert_eq!(supervisor.revision(), 1);
        assert_eq!(supervisor.simulator().unwrap().root(), previous);
    }

    #[test]
    #[cfg(unix)]
    fn malformed_source_app_json_reports_without_packing_stale_output() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);

        let original = fs::read(&fixture.source_app_json).unwrap();
        fs::write(&fixture.source_app_json, b"{\n").unwrap();
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "build");
        let source_path = fixture.source_app_json.to_string_lossy().into_owned();
        assert!(diagnostic
            .file
            .as_deref()
            .is_some_and(|path| path.ends_with("project/app.json")));
        assert!(source_path.ends_with("project/app.json"));
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert_eq!(supervisor.revision(), 1);

        // Restoring the config clears the source diagnostic while retaining
        // the previous generation.  The state-only event does not create a
        // second pack; a real successful watcher cycle changes the output tree
        // and is modelled explicitly below.
        fs::write(&fixture.source_app_json, original).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 1);
        assert_eq!(reload, None);
        let style = fixture.dist.join("pages/home/index.wxss");
        let mut contents = fs::read_to_string(&style).unwrap();
        contents.push_str("\n.screen { opacity: 0.95; }\n");
        fs::write(style, contents).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::InPlace));
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn missing_source_app_json_reports_without_packing_stale_output() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session_id = supervisor.simulator().unwrap().session_id().to_owned();
        let source = &fixture.source_app_json;
        let original = fs::read(source).unwrap();

        // The fake watcher intentionally leaves dist/ untouched.  Removing
        // the source entry must still surface a build diagnostic and keep the
        // previous generation/session live instead of treating stale output
        // as a successful rebuild.
        fs::remove_file(source).unwrap();
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "build");
        assert_eq!(diagnostic.message, "source app.json is missing");
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert_eq!(supervisor.revision(), 1);
        assert_eq!(supervisor.simulator().unwrap().session_id(), session_id);

        // Restoring the source clears the overlay without creating a duplicate
        // generation because the generated output has not changed.
        fs::write(source, original).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 1);
        assert_eq!(reload, None);
        assert!(!supervisor.run_root.join("generation-2").exists());

        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn recovered_source_clears_overlay_without_duplicate_generation() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);

        let source = &fixture.source_app_json;
        let original = fs::read(source).unwrap();
        fs::write(source, b"{\n").unwrap();
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(supervisor.revision(), 1);

        // The watcher keeps the previous dist tree when app.json is invalid.
        // Restoring the exact same source must clear the overlay without
        // creating a duplicate generation or resetting the running session.
        fs::write(source, original).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 1);
        assert_eq!(reload, None);
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert!(!supervisor.run_root.join("generation-2").exists());

        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn rapid_fake_wv_writes_are_debounced_into_one_generation() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let path = fixture.dist.join("pages/home/index.wxss");
        let original = fs::read_to_string(&path).unwrap();

        // The first poll records a pending fingerprint.  A second write before
        // the debounce interval replaces that pending value; only the final
        // tree may become a generation.
        fs::write(&path, format!("{original}\n.screen {{ opacity: 0.98; }}\n")).unwrap();
        fixture.success(&supervisor);
        assert!(supervisor.poll().unwrap().is_none());
        fs::write(&path, format!("{original}\n.screen {{ opacity: 0.97; }}\n")).unwrap();
        fixture.success(&supervisor);
        assert!(supervisor.poll().unwrap().is_none());
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::InPlace));
        assert!(!supervisor.run_root.join("generation-3").exists());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn paused_packable_mixed_output_never_publishes_without_success_receipt() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        fixture.receipt(&supervisor, "building", None);
        fs::write(
            fixture.dist.join("app.js"),
            "App({globalData:{partial:true}});",
        )
        .unwrap();
        // This is valid, packable output paused longer than the original
        // 150 ms heuristic. It has not completed the compiler generation.
        let deadline = Instant::now() + Duration::from_millis(220);
        while Instant::now() < deadline {
            assert!(supervisor.poll().unwrap().is_none());
            assert_eq!(supervisor.revision(), 1);
            std::thread::sleep(Duration::from_millis(5));
        }
        fs::write(
            fixture.dist.join("pages/home/index.wxss"),
            ".screen { opacity: 0.8; }",
        )
        .unwrap();
        fixture.receipt(&supervisor, "error", Some("late compiler failure"));
        assert_eq!(wait_for_diagnostic(&mut supervisor).code, "BUILD_FAILED");
        assert_eq!(supervisor.simulator().unwrap().session_id(), session);
        assert!(!supervisor.run_root.join("generation-2").exists());

        fixture.success(&supervisor);
        assert_eq!(wait_for_pack(&mut supervisor).0, 2);
        // A second explicit completion containing the same bytes is consumed
        // once without creating another generation or resetting the session.
        fixture.success(&supervisor);
        let deadline = Instant::now() + Duration::from_millis(80);
        while Instant::now() < deadline {
            assert!(supervisor.poll().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(supervisor.revision(), 2);
        assert!(!supervisor.run_root.join("generation-3").exists());
    }

    #[test]
    #[cfg(unix)]
    fn custom_builder_without_receipts_reports_contract_and_never_loads_output() {
        let fixture = FakeWvProject::new();
        // This test owns the untrusted output bytes. The custom child models
        // only a live builder that never speaks the receipt protocol; its
        // startup/copy latency is not part of the receipt acceptance contract.
        fs::write(
            fixture.root.join("fake-wv.sh"),
            format!(
                "#!/bin/sh\nset -eu\nprintf '%s' \"$$\" > {}\ntrap 'exit 0' TERM INT\nwhile :; do sleep 0.05; done\n",
                shell_quote(&fixture.pid),
            ),
        )
        .unwrap();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        let compiler_output = fixture.root.join("compiler-output");
        assert!(compiler_output.join("app.json").is_file());
        assert!(compiler_output.join("pages/home/index.wxml").is_file());
        copy_tree(&compiler_output, &supervisor.build_output).unwrap();
        assert_eq!(
            fs::read(supervisor.build_output.join("app.json")).unwrap(),
            fs::read(compiler_output.join("app.json")).unwrap(),
        );
        assert!(supervisor
            .build_output
            .join("pages/home/index.wxml")
            .is_file());
        assert_eq!(supervisor.last_receipt_sequence, 0);
        assert!(fs::read_dir(supervisor.receipt_root.join("receipts"))
            .unwrap()
            .next()
            .is_none());

        // A complete mutable output without a receipt remains untrusted.
        // Polling also drains child diagnostics and detects early process exit
        // rather than hiding either behind an unrelated file readiness loop.
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_RECEIPT_REQUIRED");
        assert_eq!(diagnostic.phase, "build");
        assert!(supervisor.build_output.join("app.json").is_file());
        assert_eq!(supervisor.revision(), 0);
        assert!(supervisor.simulator().is_none());
        let deadline = Instant::now() + Duration::from_millis(180);
        while Instant::now() < deadline {
            assert!(supervisor.poll().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(supervisor.revision(), 0);
        assert!(supervisor.simulator().is_none());
        assert!(!supervisor.run_root.join("generation-1").exists());
    }

    #[test]
    #[cfg(unix)]
    fn short_lived_builder_drains_final_receipt_before_watcher_exit() {
        let fixture = FakeWvProject::new();
        let script = fixture.root.join("fake-wv.sh");
        let source = fs::read_to_string(&script).unwrap().replace(
            "while :; do sleep 0.05; done",
            "printf 'final compiler output\\n'; exit 0",
        );
        fs::write(script, source).unwrap();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        assert_eq!(wait_for_pack(&mut supervisor).0, 1);
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            assert!(Instant::now() < deadline);
            if let Some(DevEvent::Exited(status)) = supervisor.poll().unwrap() {
                assert!(status.success());
                assert!(supervisor.output_drained);
                assert!(supervisor
                    .output_readers
                    .iter()
                    .all(JoinHandle::is_finished));
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
    }

    #[test]
    #[cfg(unix)]
    fn invalid_receipt_cannot_replace_a_running_pack() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        let receipt = serde_json::json!({
            "protocolVersion":"2.0", "sessionId":supervisor.receipt_session,
            "sequence":3, "kind":"success", "snapshot":"../outside",
        });
        fs::write(
            supervisor
                .receipt_root
                .join("receipts/00000000000000000003.json"),
            serde_json::to_vec(&receipt).unwrap(),
        )
        .unwrap();
        assert_eq!(
            wait_for_diagnostic(&mut supervisor).code,
            "BUILD_RECEIPT_INVALID"
        );
        assert_old_runtime_responds(&mut supervisor, &session);
        assert_eq!(supervisor.revision(), 1);
        assert!(!supervisor.run_root.join("generation-2").exists());
        assert!(receipt_snapshot_path(&supervisor.receipt_root, "../outside").is_err());
    }

    #[cfg(unix)]
    fn install_slow_packer(
        fixture: &FakeWvProject,
        supervisor: &mut DevSupervisor,
    ) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let script = fixture.root.join("slow-node.sh");
        let pid = fixture.root.join("pack-pid");
        let release = fixture.root.join("pack-release");
        let stop_order = fixture.root.join("pack-stop-order");
        fs::write(&script, format!(
            "#!/bin/sh\nset -eu\nstop_order={}\ntrap 'if kill -0 {} 2>/dev/null; then printf watcher-alive > \"$stop_order\"; else printf watcher-stopped > \"$stop_order\"; fi; exit 0' TERM\nprintf '%s' \"$$\" > {}\nwhile [ ! -f {} ]; do sleep 0.05; done\nexec node \"$@\"\n",
            shell_quote(&stop_order), supervisor.child.as_ref().unwrap().id(),
            shell_quote(&pid), shell_quote(&release),
        )).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        supervisor.config.node_bin = script;
        let style = fixture.dist.join("pages/home/index.wxss");
        fs::write(style, ".screen { opacity: 0.7; }").unwrap();
        fixture.success(supervisor);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !pid.is_file() {
            assert!(Instant::now() < deadline, "slow packer did not start");
            let started = Instant::now();
            assert!(supervisor.poll().unwrap().is_none());
            assert!(
                started.elapsed() < Duration::from_millis(200),
                "pack spawn blocked the shared loop"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        (pid, release)
    }

    #[cfg(unix)]
    fn assert_old_runtime_responds(supervisor: &mut DevSupervisor, session: &str) {
        let started = Instant::now();
        let batch = supervisor
            .simulator_mut()
            .unwrap()
            .dispatch_request(
                container_bridge::op::APP_LIFECYCLE,
                serde_json::json!({"event":"show"}),
            )
            .unwrap();
        assert_eq!(batch.messages[0].payload["ok"], true);
        supervisor.pump_runtime(1).unwrap();
        assert!(started.elapsed() < Duration::from_millis(200));
        assert_eq!(supervisor.simulator().unwrap().session_id(), session);
    }

    #[test]
    #[cfg(all(unix, feature = "quickjs-native"))]
    fn modern_view_only_edits_repack_frozen_raw_output_and_preserve_failed_generation() {
        use container_render_skia::Renderer;

        fn text(simulator: &Simulator) -> String {
            fn collect(node: &container_render_skia::RenderNode) -> String {
                let mut value = node.text.clone().unwrap_or_default();
                for child in &node.children {
                    value.push_str(&collect(child));
                }
                value
            }
            collect(
                &simulator
                    .host()
                    .session()
                    .unwrap()
                    .renderer()
                    .last_frame()
                    .unwrap()
                    .root,
            )
        }

        let fixture = FakeWvProject::new();
        fs::write(
            fixture.root.join("compiler-output/pages/home/index.wxml"),
            "<view><text>{{fmt.label(title)}}</text></view>",
        )
        .unwrap();
        fs::create_dir(fixture.project.join("view")).unwrap();
        let module = fixture.project.join("view/format.view.ts");
        let source = |version: &str| {
            format!("export function label(value: string): string {{return value + ' {version}';}}")
        };
        fs::write(&module, source("v1")).unwrap();
        fs::write(
            fixture.project.join("container.config.json"),
            r#"{"view":{"documents":{"pages/home/index.wxml":{"mode":"modern","modules":{"fmt":"./view/format.view.ts"}}}}}"#,
        )
        .unwrap();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        let preparation = supervisor.preparation_root.path.clone();
        assert!(!preparation.starts_with(&fixture.project));
        assert!(!preparation.starts_with(&supervisor.run_root));
        assert_eq!(wait_for_pack(&mut supervisor), (1, None));
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v1");
        let raw_sequence = supervisor.last_receipt_sequence;
        let first_session = supervisor.simulator().unwrap().session_id().to_owned();

        // No raw success receipt is issued: the coordinator reuses the last
        // compiler-owned immutable snapshot for the modern-only change.
        fs::write(&module, source("v2")).unwrap();
        assert_eq!(
            wait_for_pack(&mut supervisor),
            (2, Some(DevReloadKind::Restart))
        );
        assert_eq!(supervisor.last_receipt_sequence, raw_sequence);
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v2");
        assert_ne!(supervisor.simulator().unwrap().session_id(), first_session);
        let accepted_session = supervisor.simulator().unwrap().session_id().to_owned();
        let accepted_pack = supervisor.simulator().unwrap().root().to_path_buf();

        fs::write(&module, "export const broken = ;").unwrap();
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "pack");
        assert_eq!(supervisor.simulator().unwrap().root(), accepted_pack);
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v2");
        assert_old_runtime_responds(&mut supervisor, &accepted_session);

        fs::write(&module, source("v3")).unwrap();
        assert_eq!(
            wait_for_pack(&mut supervisor),
            (4, Some(DevReloadKind::Restart))
        );
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v3");
        assert_eq!(supervisor.last_receipt_sequence, raw_sequence);

        // Resolution failures have no successful closure receipt. Creating
        // the missing transitive module, then fixing only that module, must
        // both retry without changing the entry or receiving a raw build.
        fs::write(&module, "import { suffix } from './future'; export function label(value: string): string { return value + ' ' + suffix }").unwrap();
        assert_eq!(wait_for_diagnostic(&mut supervisor).code, "BUILD_FAILED");
        let helper = fixture.project.join("view/future.ts");
        fs::write(&helper, "export const suffix = ;").unwrap();
        assert_eq!(wait_for_diagnostic(&mut supervisor).code, "BUILD_FAILED");
        fs::write(&helper, "export const suffix: string = 'v4'").unwrap();
        assert_eq!(wait_for_pack(&mut supervisor).0, 7);
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v4");
        assert!(!supervisor.modern_recovery_watch);

        // A raw source edit can arrive before its compiler START receipt.
        // Even a simultaneous modern edit must wait for the raw generation.
        fs::write(fixture.project.join("app.js"), "App({onLaunch(){}})").unwrap();
        fs::write(&module, source("v5")).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.raw_build_ready {
            assert!(Instant::now() < deadline);
            assert!(supervisor.poll().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(supervisor.revision(), 8);
        assert!(supervisor.pending_pack.is_none());
        assert!(!supervisor.run_root.join("generation-8").exists());
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v4");
        fixture.success(&supervisor);
        assert_eq!(wait_for_pack(&mut supervisor).0, 9);
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v5");

        // Complete an older child before the periodic watcher has noticed
        // the edit. Publication itself must reject the outdated executable.
        let previous = supervisor.simulator().unwrap().root().to_path_buf();
        let (pid, release) = install_slow_packer(&fixture, &mut supervisor);
        supervisor.config.node_bin = PathBuf::from("node");
        supervisor.config.poll_interval = Duration::from_secs(30);
        supervisor.last_modern_poll = Instant::now();
        fs::write(&module, source("v6")).unwrap();
        fs::write(release, b"release").unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while supervisor.pending_pack.is_some() {
            assert!(Instant::now() < deadline, "older pack did not finish");
            assert!(supervisor.poll().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        wait_for_process_exit(&pid);
        assert_eq!(supervisor.simulator().unwrap().root(), previous);
        assert!(!supervisor.run_root.join("generation-10").exists());
        supervisor.config.poll_interval = fixture.config().poll_interval;
        assert_eq!(wait_for_pack(&mut supervisor).0, 11);
        assert_eq!(text(supervisor.simulator().unwrap()), "fixture v6");
        assert!(fs::read_dir(&preparation).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".source-")
        }));
        supervisor.shutdown();
        wait_for_process_exit(&fixture.pid);
        assert!(!supervisor.receipt_root.exists());
        assert!(!preparation.exists());
    }

    #[test]
    #[cfg(unix)]
    fn completed_pack_rechecks_source_before_the_periodic_observation_is_due() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let previous = supervisor.simulator().unwrap().root().to_path_buf();
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        let (pid, release) = install_slow_packer(&fixture, &mut supervisor);
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        fs::write(&fixture.source_app_json, b"{\n").unwrap();
        fs::write(release, b"release").unwrap();

        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(diagnostic.phase, "build");
        assert_eq!(supervisor.simulator().unwrap().root(), previous);
        assert!(!supervisor.run_root.join("generation-2").exists());
        assert_old_runtime_responds(&mut supervisor, &session);
        wait_for_process_exit(&pid);
    }

    #[test]
    #[cfg(unix)]
    fn completed_pack_drains_new_receipts_before_publication() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let previous = supervisor.simulator().unwrap().root().to_path_buf();
        let (pid, release) = install_slow_packer(&fixture, &mut supervisor);
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        let sequence = supervisor.last_receipt_sequence;
        fixture.receipt(&supervisor, "building", None);
        fs::write(release, b"release").unwrap();

        let deadline = Instant::now() + Duration::from_secs(15);
        while supervisor.pending_pack.is_some() {
            assert!(Instant::now() < deadline, "completed child was not reaped");
            assert!(supervisor.poll().unwrap().is_none());
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(supervisor.last_receipt_sequence > sequence);
        assert!(!supervisor.raw_build_ready);
        assert_eq!(supervisor.simulator().unwrap().root(), previous);
        assert!(!supervisor.run_root.join("generation-2").exists());
        wait_for_process_exit(&pid);
    }

    #[test]
    #[cfg(unix)]
    fn slow_pack_keeps_shared_loop_and_previous_runtime_responsive() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        let (pid, release) = install_slow_packer(&fixture, &mut supervisor);
        for _ in 0..4 {
            let started = Instant::now();
            assert!(supervisor.poll().unwrap().is_none());
            assert!(started.elapsed() < Duration::from_millis(200));
            assert_old_runtime_responds(&mut supervisor, &session);
        }
        assert!(supervisor
            .run_root
            .join("generation-1/manifest.json")
            .is_file());
        assert!(!supervisor.run_root.join("generation-2").exists());
        fs::write(release, b"release").unwrap();
        assert_eq!(wait_for_pack(&mut supervisor).0, 2);
        wait_for_process_exit(&pid);
        assert_eq!(supervisor.simulator().unwrap().session_id(), session);
    }

    #[test]
    #[cfg(unix)]
    fn hung_pack_drop_reaps_process_tree_and_removes_all_preparation_files() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let (pid, _) = install_slow_packer(&fixture, &mut supervisor);
        let pending = supervisor.pending_pack.as_ref().unwrap();
        let staging = pending.files.staging.clone();
        let snapshot = pending.files.snapshot.path.clone();
        let receipt_root = supervisor.receipt_root.clone();
        let generation = supervisor.run_root.join("generation-1/manifest.json");
        assert!(staging.is_dir() && snapshot.is_dir());
        drop(supervisor);
        wait_for_process_exit(&pid);
        wait_for_process_exit(&fixture.pid);
        assert!(!staging.exists() && !snapshot.exists() && !receipt_root.exists());
        assert!(generation.is_file());
    }

    #[test]
    #[cfg(unix)]
    fn explicit_shutdown_orders_process_cleanup_and_is_idempotent() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let (pack_pid, _) = install_slow_packer(&fixture, &mut supervisor);
        let receipt_root = supervisor.receipt_root.clone();
        let build_output = supervisor.build_output.clone();
        let preparation = supervisor.preparation_root.path.clone();
        let generation = supervisor.run_root.join("generation-1/manifest.json");

        supervisor.shutdown();
        wait_for_process_exit(&fixture.pid);
        wait_for_process_exit(&pack_pid);
        assert_eq!(
            fs::read_to_string(fixture.root.join("pack-stop-order")).unwrap(),
            "watcher-stopped",
            "the packer's TERM handler must observe an already-reaped watcher"
        );
        assert!(supervisor.stopped);
        assert!(supervisor.output_readers.is_empty());
        assert!(supervisor.pending_pack.is_none());
        assert!(supervisor.pending_snapshot.is_none());
        assert!(!receipt_root.exists() && !build_output.exists());
        assert!(generation.is_file());
        assert!(supervisor.poll().unwrap().is_none());
        assert!(supervisor.pump_runtime(u64::MAX).unwrap().is_none());
        assert!(matches!(
            supervisor.run_until_exit(|_| {}),
            Err(DevError::Shutdown)
        ));

        // Resources created at the same paths after the cleanup barrier no
        // longer belong to this supervisor. A repeated shutdown or Drop must
        // not signal its old process group or delete these replacements.
        fs::create_dir_all(&receipt_root).unwrap();
        fs::create_dir_all(&build_output).unwrap();
        fs::write(receipt_root.join("replacement"), b"retain").unwrap();
        fs::write(build_output.join("replacement"), b"retain").unwrap();
        supervisor.shutdown();
        drop(supervisor);
        assert!(receipt_root.join("replacement").is_file());
        assert!(build_output.join("replacement").is_file());
        // The replacement trees belong to this test after the cleanup
        // barrier; the released supervisor must never reclaim them.
        fs::remove_dir_all(preparation).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn newer_error_cancels_inflight_pack_and_cannot_be_cleared_by_its_result() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        let (pid, _) = install_slow_packer(&fixture, &mut supervisor);
        let staging = supervisor
            .pending_pack
            .as_ref()
            .unwrap()
            .files
            .staging
            .clone();
        fixture.receipt(&supervisor, "error", Some("newer rebuild failed"));
        assert_eq!(
            wait_for_diagnostic(&mut supervisor).message,
            "newer rebuild failed"
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.pending_pack.is_some() {
            assert!(Instant::now() < deadline);
            assert!(supervisor.poll().unwrap().is_none());
        }
        wait_for_process_exit(&pid);
        assert!(supervisor.diagnostic_active);
        assert!(!staging.exists() && !supervisor.run_root.join("generation-2").exists());
        assert_old_runtime_responds(&mut supervisor, &session);
        supervisor.config.node_bin = PathBuf::from("node");
        fixture.success(&supervisor);
        assert_eq!(wait_for_pack(&mut supervisor).0, 3);
    }

    #[test]
    #[cfg(unix)]
    fn pack_deadline_reports_timeout_and_keeps_previous_generation() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let session = supervisor.simulator().unwrap().session_id().to_owned();
        let (pid, _) = install_slow_packer(&fixture, &mut supervisor);
        // Start the deadline after the fixture's executable has entered its
        // wait loop, independently of process scheduling under parallel tests.
        supervisor.pending_pack.as_mut().unwrap().deadline =
            Instant::now() + Duration::from_millis(150);
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "ERR_TIMEOUT");
        assert_eq!(diagnostic.phase, "pack");
        let deadline = Instant::now() + Duration::from_secs(2);
        while supervisor.pending_pack.is_some() {
            assert!(Instant::now() < deadline);
            assert!(supervisor.poll().unwrap().is_none());
        }
        wait_for_process_exit(&pid);
        assert_old_runtime_responds(&mut supervisor, &session);
        assert!(!supervisor.run_root.join("generation-2").exists());
    }

    #[test]
    #[cfg(unix)]
    fn style_reload_after_navigation_does_not_warn_about_available_startup_route() {
        for configured_route in ["pages/home/index", "/pages/home/index"] {
            let fixture = FakeWvProject::new();
            let initial_output = fixture.root.join("compiler-output");
            fs::create_dir_all(initial_output.join("pages/other")).unwrap();
            for extension in ["js", "json", "wxml", "wxss"] {
                fs::copy(
                    initial_output.join(format!("pages/home/index.{extension}")),
                    initial_output.join(format!("pages/other/index.{extension}")),
                )
                .unwrap();
            }
            let app_json = r#"{"pages":["pages/home/index","pages/other/index"]}"#;
            fs::write(initial_output.join("app.json"), app_json).unwrap();
            fs::write(&fixture.source_app_json, app_json).unwrap();
            let mut config = fixture.config();
            config.simulator.route = Some(configured_route.to_owned());
            let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
            wait_for_pack(&mut supervisor);
            assert!(supervisor.take_route_warning().is_none());
            let simulator = supervisor.simulator_mut().unwrap();
            let session = simulator.session_id().to_owned();
            let response = simulator
                .dispatch_request(
                    container_bridge::op::PAGE_PUSH,
                    serde_json::json!({"path":"pages/other/index","data":{}}),
                )
                .unwrap();
            assert_eq!(response.messages[0].payload["ok"], true);
            assert_eq!(
                simulator.report("ready").route.as_deref(),
                Some("pages/other/index")
            );

            fs::write(
                fixture.dist.join("app.wxss"),
                "page { background: #123456; }",
            )
            .unwrap();
            fixture.success(&supervisor);
            assert_eq!(
                wait_for_pack(&mut supervisor),
                (2, Some(DevReloadKind::InPlace))
            );
            let simulator = supervisor.simulator().unwrap();
            assert_eq!(simulator.session_id(), session);
            assert_eq!(
                simulator.report("ready").route.as_deref(),
                Some("pages/other/index")
            );
            assert!(simulator
                .manifest()
                .routes
                .iter()
                .any(|route| route.path == "pages/home/index"));
            assert!(supervisor.take_route_warning().is_none());
            drop(supervisor);
            wait_for_process_exit(&fixture.pid);
        }
    }

    #[test]
    #[cfg(unix)]
    fn route_removal_keeps_pack_live_and_records_fallback_warning() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        assert_eq!(
            supervisor
                .simulator()
                .unwrap()
                .report("ready")
                .route
                .as_deref(),
            Some("pages/home/index")
        );

        // Keep the build valid while removing the currently visible route.
        // The manifest remains usable because the simulator falls back to the
        // first declared route, but the surface must expose why the route
        // changed so an HMR update cannot look like a silent navigation.
        let app_json = fixture.dist.join("app.json");
        let mut source = fs::read_to_string(&app_json).unwrap();
        source = source.replace("pages/home/index", "pages/other/index");
        fs::write(app_json, source).unwrap();
        fs::create_dir_all(fixture.dist.join("pages/other")).unwrap();
        for extension in ["js", "json", "wxml", "wxss"] {
            fs::copy(
                fixture.dist.join(format!("pages/home/index.{extension}")),
                fixture.dist.join(format!("pages/other/index.{extension}")),
            )
            .unwrap();
        }
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::Restart));
        assert_eq!(
            supervisor
                .simulator()
                .unwrap()
                .report("ready")
                .route
                .as_deref(),
            Some("pages/other/index")
        );

        let warning = supervisor
            .take_route_warning()
            .expect("route fallback warning");
        assert_eq!(warning.code, "ROUTE_FALLBACK");
        assert_eq!(warning.severity, "warning");
        assert!(warning.message.contains("pages/home/index"));
        assert!(warning.message.contains("pages/other/index"));
        assert!(supervisor.take_route_warning().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn javascript_change_restarts_supervisor_session() {
        let fixture = FakeWvProject::new();
        let (mut supervisor, _) = DevSupervisor::spawn(fixture.config()).unwrap();
        wait_for_pack(&mut supervisor);
        let initial_session = supervisor
            .simulator()
            .expect("initial simulator")
            .session_id()
            .to_owned();

        // A script edit changes a module digest. The supervisor must classify
        // that generation as a restart so AppService state cannot leak across
        // JavaScript evaluation boundaries.
        let app_js = fixture.dist.join("app.js");
        let mut source = fs::read_to_string(&app_js).unwrap();
        source.push_str("\n// simulator restart smoke\n");
        fs::write(app_js, source).unwrap();
        fixture.success(&supervisor);
        let (revision, reload) = wait_for_pack(&mut supervisor);
        assert_eq!(revision, 2);
        assert_eq!(reload, Some(DevReloadKind::Restart));
        let reloaded_session = supervisor
            .simulator()
            .expect("reloaded simulator")
            .session_id();
        assert_ne!(reloaded_session, initial_session);
        assert!(reloaded_session.ends_with("-reload-1"));
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn native_device_consumer_builds_without_executing_a_local_appservice() {
        let fixture = FakeWvProject::new();
        fs::write(fixture.root.join("compiler-output/app.js"),
            "App({onLaunch(){throw new Error('device code must not execute on the build computer')}});")
            .unwrap();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::ExternalDevice;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        assert_eq!(first.revision, 1);
        assert!(supervisor.simulator().is_none());
        assert!(supervisor.check_portable_publication(&first).authorized);
        assert!(supervisor.pump_runtime(1_000_000).unwrap().is_none());
        fixture.receipt(&supervisor, "error", Some("device build failure"));
        assert_eq!(wait_for_diagnostic(&mut supervisor).code, "BUILD_FAILED");
        assert_eq!(
            supervisor.portable_pack().unwrap().manifest_sha256,
            first.manifest_sha256
        );
        assert!(!supervisor.check_portable_publication(&first).authorized);
        assert!(first.pack_directory.join("manifest.json").is_file());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_pack_consumer_never_executes_appservice_and_keeps_failed_build_separate() {
        let fixture = FakeWvProject::new();
        fs::write(
            fixture.root.join("compiler-output/app.js"),
            "App({onLaunch(){throw new Error('native AppService must not run')}});",
        )
        .unwrap();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        assert_eq!(first.revision, 1);
        assert_eq!(first.selected_route.as_deref(), Some("pages/home/index"));
        assert_eq!(first.routes, vec!["pages/home/index".to_owned()]);
        assert!(supervisor.simulator().is_none());
        assert!(supervisor.pump_runtime(1_000_000).unwrap().is_none());
        let manifest_bytes = fs::read(first.pack_directory.join("manifest.json")).unwrap();
        assert_eq!(
            first.manifest_sha256,
            container_ir::hex_digest(&manifest_bytes)
        );
        let metadata = serde_json::to_value(&first).unwrap();
        for name in [
            "runtimeReady",
            "lifecycleState",
            "traceCount",
            "gpuStatus",
            "inputEnabled",
        ] {
            assert!(
                metadata.get(name).is_none(),
                "portable validation must not invent {name}"
            );
        }
        fixture.receipt(&supervisor, "error", Some("intentional compiler error"));
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert_eq!(
            supervisor.portable_pack().unwrap().manifest_sha256,
            first.manifest_sha256
        );
        assert!(first.pack_directory.join("manifest.json").is_file());
        assert!(supervisor.simulator().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_pack_consumer_rejects_v8_before_spawning_any_watcher() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.engine = EngineKind::V8;
        let error = DevSupervisor::spawn(config).unwrap_err();
        assert!(matches!(error, DevError::BrowserEngineUnavailable));
        assert!(error.to_string().starts_with("ERR_ENGINE:"));
        assert!(!fixture.pid.exists());
        assert!(!fixture.output.exists());
    }

    #[test]
    #[cfg(unix)]
    fn browser_pack_consumer_recovers_overlay_without_creating_another_generation() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        fixture.receipt(&supervisor, "error", Some("temporary watch error"));
        wait_for_diagnostic(&mut supervisor);
        fixture.success(&supervisor);
        let recovered = wait_for_portable(&mut supervisor);
        assert_eq!(recovered.revision, first.revision);
        assert_eq!(recovered.pack_directory, first.pack_directory);
        assert_eq!(recovered.manifest_sha256, first.manifest_sha256);
        assert_ne!(recovered.publication_token, first.publication_token);
        assert!(!supervisor.check_portable_publication(&first).authorized);
        assert!(supervisor.check_portable_publication(&recovered).authorized);
        assert!(!supervisor.run_root.join("generation-2").exists());
        assert!(supervisor.simulator().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_pack_validator_rejects_corrupt_blob_and_warns_about_requested_route() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.simulator.route = Some("/pages/missing/index".into());
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        let warning = supervisor
            .take_route_warning()
            .expect("missing route warning");
        assert_eq!(warning.code, "ROUTE_FALLBACK");
        assert_eq!(warning.severity, "warning");
        assert_eq!(first.selected_route.as_deref(), Some("pages/home/index"));
        let candidate = fixture.root.join("corrupt-portable-candidate");
        copy_tree(&first.pack_directory, &candidate).unwrap();
        let blob = fs::read_dir(candidate.join("blobs/sha256"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        fs::write(blob, b"corrupt content").unwrap();
        let error = portable_pack_report(
            &candidate,
            &fixture.root.join("unpublished"),
            2,
            None,
            first.publication_token.clone(),
        )
        .expect_err("corrupt blob cannot authorize a portable generation");
        assert!(matches!(error, SimulatorError::BlobDigest { .. }));
        assert_eq!(
            supervisor.portable_pack().unwrap().manifest_sha256,
            first.manifest_sha256
        );
        assert!(!fixture.root.join("unpublished").exists());
        assert!(supervisor.simulator().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_portable_publication_tokens_expire_after_new_pack_or_shutdown() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        assert!(supervisor.check_portable_publication(&first).authorized);
        fs::write(
            fixture.dist.join("app.wxss"),
            "page { background: #012345; }",
        )
        .unwrap();
        fixture.success(&supervisor);
        let second = wait_for_portable(&mut supervisor);
        assert_eq!(second.revision, 2);
        assert_ne!(first.manifest_sha256, second.manifest_sha256);
        assert!(!supervisor.check_portable_publication(&first).authorized);
        assert!(supervisor.check_portable_publication(&second).authorized);
        assert!(first.pack_directory.join("manifest.json").is_file());
        assert!(second.pack_directory.join("manifest.json").is_file());
        supervisor.shutdown();
        assert!(!supervisor.check_portable_publication(&second).authorized);
        assert!(second.pack_directory.join("manifest.json").is_file());
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn late_browser_site_cannot_overwrite_new_source_diagnostic_or_reuse_recovery_token() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        let late_site_completion = first.clone();
        assert!(
            supervisor
                .check_portable_publication(&late_site_completion)
                .authorized
        );

        // A receipt has arrived but the debounced supervisor poll has not run.
        // The completion guard must fail closed without consuming that receipt
        // or losing the last valid pack that an existing Worker may still run.
        fixture.receipt(&supervisor, "building", None);
        assert!(
            !supervisor
                .check_portable_publication(&late_site_completion)
                .authorized
        );
        assert_eq!(supervisor.portable_pack().unwrap(), &first);
        assert!(supervisor.poll_compiler_inputs(true).is_none());
        assert!(
            !supervisor
                .check_portable_publication(&late_site_completion)
                .authorized
        );
        assert_eq!(supervisor.portable_pack().unwrap(), &first);

        fixture.receipt(&supervisor, "error", Some("newer source failed"));
        let diagnostic = wait_for_diagnostic(&mut supervisor);
        assert_eq!(diagnostic.code, "BUILD_FAILED");
        assert!(supervisor.diagnostic_active);
        let diagnostic_observation = supervisor.portable_freshness.source_revision;
        assert!(
            !supervisor
                .check_portable_publication(&late_site_completion)
                .authorized
        );
        assert!(
            supervisor.diagnostic_active,
            "late site completion cannot clear the overlay"
        );
        assert_eq!(
            supervisor.portable_freshness.source_revision,
            diagnostic_observation
        );
        assert_eq!(
            supervisor.portable_pack().unwrap().pack_directory,
            first.pack_directory
        );
        assert_eq!(
            supervisor.portable_pack().unwrap().manifest_sha256,
            first.manifest_sha256
        );
        assert!(first.pack_directory.join("manifest.json").is_file());

        // Success for identical bytes renews authorization without a new pack
        // generation. Only this success clears the newer error; the original
        // asynchronous site completion remains permanently unauthorized.
        fixture.success(&supervisor);
        let recovered = wait_for_portable(&mut supervisor);
        assert_eq!(recovered.revision, first.revision);
        assert_eq!(recovered.pack_directory, first.pack_directory);
        assert_eq!(recovered.manifest_sha256, first.manifest_sha256);
        assert_ne!(recovered.publication_token, first.publication_token);
        assert!(
            recovered.publication_token.source_revision > first.publication_token.source_revision
        );
        assert!(
            recovered.publication_token.compiler_receipt_sequence
                > first.publication_token.compiler_receipt_sequence
        );
        assert!(!supervisor.diagnostic_active);
        assert!(
            !supervisor
                .check_portable_publication(&late_site_completion)
                .authorized
        );
        assert!(supervisor.check_portable_publication(&recovered).authorized);
        assert!(supervisor.simulator().is_none());
        assert!(!supervisor.run_root.join("generation-2").exists());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_publication_barrier_observes_modern_edits_inside_watch_debounce() {
        let fixture = FakeWvProject::new();
        fs::write(fixture.project.join("container.config.json"), "{}").unwrap();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        assert!(supervisor.check_portable_publication(&first).authorized);
        let receipt = supervisor.last_receipt_sequence;
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        fs::write(
            fixture.project.join("container.config.json"),
            r#"{"view":{}}"#,
        )
        .unwrap();
        assert!(supervisor.poll().unwrap().is_none());
        assert!(
            supervisor.portable_publication_matches(&first),
            "ordinary poll is debounced"
        );
        let check = supervisor.check_portable_publication(&first);
        assert!(!check.authorized);
        assert!(check.events.is_empty());
        assert_eq!(
            supervisor.last_receipt_sequence, receipt,
            "modern edits need no raw receipt"
        );
        assert!(supervisor.pending_snapshot.is_some());
        assert_eq!(supervisor.portable_pack(), Some(&first));
        assert!(supervisor.simulator().is_none());
        // Restoring bytes cannot restore the old publication observation.
        fs::write(fixture.project.join("container.config.json"), "{}").unwrap();
        assert!(!supervisor.check_portable_publication(&first).authorized);
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_publication_barrier_returns_new_source_errors_without_touching_last_pack() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        fs::write(
            resolve_source_app_json(&fixture.project),
            "invalid source app config",
        )
        .unwrap();
        let check = supervisor.check_portable_publication(&first);
        assert!(!check.authorized);
        assert!(
            matches!(&check.events[..], [DevEvent::Diagnostic(diagnostic)]
            if diagnostic.code == "BUILD_FAILED" && diagnostic.file.is_some())
        );
        assert!(supervisor.diagnostic_active);
        assert_eq!(supervisor.portable_pack(), Some(&first));
        assert!(first.pack_directory.join("manifest.json").is_file());
        assert!(supervisor.simulator().is_none());
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_publication_barrier_waits_for_receipt_after_valid_raw_source_edit() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let first = wait_for_portable(&mut supervisor);
        assert!(supervisor.check_portable_publication(&first).authorized);
        let path = resolve_source_app_json(&fixture.project);
        let original = fs::read(&path).unwrap();
        let mut changed: serde_json::Value = serde_json::from_slice(&original).unwrap();
        changed["debug"] = serde_json::json!(true);
        supervisor.config.poll_interval = Duration::from_secs(3600);
        supervisor.last_compiler_poll = Some(Instant::now());
        supervisor.last_modern_poll = Instant::now();
        fs::write(&path, serde_json::to_vec(&changed).unwrap()).unwrap();
        assert!(supervisor.poll().unwrap().is_none());
        let check = supervisor.check_portable_publication(&first);
        assert!(!check.authorized);
        assert!(
            check.events.is_empty(),
            "valid raw edits await the compiler, not a fabricated error"
        );
        assert!(!supervisor.raw_build_ready);
        assert!(
            supervisor.pending_snapshot.is_none(),
            "old raw output cannot repackage the source edit"
        );
        assert!(supervisor.pending_pack.is_none());
        assert_eq!(supervisor.portable_pack(), Some(&first));
        fs::write(path, original).unwrap();
        assert!(!supervisor.check_portable_publication(&first).authorized);
        supervisor.config.poll_interval = fixture.config().poll_interval;
        fixture.success(&supervisor);
        let recovered = wait_for_portable(&mut supervisor);
        assert_eq!(first.pack_directory, recovered.pack_directory);
        assert_ne!(first.publication_token, recovered.publication_token);
        assert!(supervisor.check_portable_publication(&recovered).authorized);
        assert!(!supervisor.check_portable_publication(&first).authorized);
        drop(supervisor);
        wait_for_process_exit(&fixture.pid);
    }
    fn browser_preparation_input(path: PathBuf) -> BrowserRuntimePreparation {
        use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
        BrowserRuntimePreparation {
            producer_directory: path,
            expected: ProducerExpected {
                report_sha256: "a".repeat(64),
                source_commit: "b".repeat(40),
                source_sha256: "c".repeat(64),
                renderer: RuntimeBundleRenderer::Software,
            },
        }
    }

    #[test]
    #[cfg(unix)]
    fn browser_runtime_preparation_rejects_wrong_consumer_before_watcher() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.browser_runtime = Some(browser_preparation_input(fixture.root.join("producer")));
        assert!(matches!(
            DevSupervisor::spawn(config),
            Err(DevError::BrowserRuntime(_))
        ));
        assert!(!fixture.pid.exists());
        assert!(!fixture.output.exists());
    }

    #[test]
    #[cfg(unix)]
    fn browser_runtime_preparation_failure_retains_owner_and_pack_consumer() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let producer = fixture.root.join("producer");
        fs::create_dir(&producer).unwrap();
        fs::write(producer.join("build-report.json"), b"{}").unwrap();
        config.browser_runtime = Some(browser_preparation_input(
            fs::canonicalize(&producer).unwrap(),
        ));
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let root = supervisor.run_root.join("browser-artifacts");
        assert!(!root.exists(), "spawn owns metadata; first poll owns files");
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            match supervisor.poll().unwrap() {
                Some(DevEvent::Diagnostic(d)) if d.phase == "browser-runtime" => {
                    assert_eq!(d.code, "ERR_BROWSER_DEV_ARTIFACT");
                    break;
                }
                Some(DevEvent::BrowserRuntimePrepared { .. }) => {
                    panic!("invalid producer accepted")
                }
                _ => {}
            }
            assert!(Instant::now() < deadline, "missing runtime failure");
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(root.join("producer/build-report.json").is_file());
        assert!(root.join("tools").is_dir());
        assert!(supervisor.simulator().is_none());
        assert!(supervisor.browser_runtime().is_none());
        // The independent app pack remains available even when runtime
        // preparation fails; a second poll of the failed lane is quiet.
        if supervisor.portable_pack().is_none() {
            wait_for_portable(&mut supervisor);
        }
        assert!(supervisor.portable_pack().is_some());
        assert!(supervisor.try_shutdown().unwrap());
        assert!(!root.exists());
        assert_eq!(fs::read(producer.join("build-report.json")).unwrap(), b"{}");
        assert!(supervisor.try_shutdown().unwrap());
        wait_for_process_exit(&fixture.pid);
    }

    #[test]
    #[cfg(unix)]
    fn browser_runtime_preparation_shutdown_before_first_poll_creates_no_files() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        let producer = fixture.root.join("producer");
        fs::create_dir(&producer).unwrap();
        config.browser_runtime = Some(browser_preparation_input(
            fs::canonicalize(producer).unwrap(),
        ));
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let root = supervisor.run_root.join("browser-artifacts");
        assert!(supervisor.try_shutdown().unwrap());
        assert!(!root.exists());
        assert!(supervisor.poll().unwrap().is_none());
        assert!(supervisor
            .browser_runtime_resource("runtime-config.json")
            .unwrap()
            .is_none());
    }

    #[test]
    #[cfg(unix)]
    #[ignore = "requires independently pinned real Worker producer and Node; static consumer only"]
    fn browser_runtime_preparation_real_producer_static_only() {
        use crate::browser_dev_runtime_receipt::{ProducerExpected, RuntimeBundleRenderer};
        let required = |name| {
            std::env::var(format!("WEAPP_CONTAINER_RETAINED_RUNTIME_{name}"))
                .unwrap_or_else(|_| panic!("required independent input {name}"))
        };
        let renderer = match required("RENDERER").as_str() {
            "software" => RuntimeBundleRenderer::Software,
            "canvaskit" => RuntimeBundleRenderer::Canvaskit,
            _ => panic!("invalid independent renderer"),
        };
        assert!(!required("PIN_AUTHORITY").is_empty());
        let producer = fs::canonicalize(required("BUILD_SITE")).unwrap();
        let expected = ProducerExpected {
            report_sha256: required("REPORT_SHA256"),
            source_commit: required("SOURCE_COMMIT"),
            source_sha256: required("SOURCE_SHA256"),
            renderer,
        };
        let original = fs::read(producer.join("build-report.json")).unwrap();
        assert_eq!(container_ir::hex_digest(&original), expected.report_sha256);
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.node_bin = PathBuf::from(required("NODE_BIN"));
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.browser_runtime = Some(BrowserRuntimePreparation {
            producer_directory: producer.clone(),
            expected: expected.clone(),
        });
        let (mut supervisor, _) = DevSupervisor::spawn(config).unwrap();
        let root = supervisor.run_root.join("browser-artifacts");
        let deadline = Instant::now() + Duration::from_secs(60);
        let report = loop {
            match supervisor.poll().unwrap() {
                Some(DevEvent::BrowserRuntimePrepared { report }) => break report,
                Some(DevEvent::Diagnostic(d)) if d.phase == "browser-runtime" => {
                    panic!("{}", d.message)
                }
                _ => {}
            }
            assert!(
                Instant::now() < deadline,
                "static runtime preparation timed out"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(report.pins.producer_report_sha256, expected.report_sha256);
        assert_eq!(report.pins.source_commit, expected.source_commit);
        assert_eq!(report.pins.source_inventory_sha256, expected.source_sha256);
        assert!(!report.runtime_ready && !report.presented_ready);
        assert!(supervisor.browser_runtime().is_some());
        assert!(supervisor.simulator().is_none());
        assert!(supervisor
            .browser_runtime_resource("source/Cargo.toml")
            .unwrap()
            .is_none());
        assert!(supervisor
            .browser_runtime_resource("build-report.json")
            .unwrap()
            .is_none());
        let mut bodies = Vec::new();
        for _ in 0..64 {
            bodies.push(
                supervisor
                    .browser_runtime_resource("runtime-config.json")
                    .unwrap()
                    .unwrap(),
            );
        }
        assert_eq!(bodies[0].bytes().as_ptr(), bodies[1].bytes().as_ptr());
        assert!(supervisor
            .browser_runtime_resource("runtime-config.json")
            .is_err());
        bodies.pop();
        bodies.push(
            supervisor
                .browser_runtime_resource("runtime-config.json")
                .unwrap()
                .unwrap(),
        );
        assert!(!supervisor.try_shutdown().unwrap());
        assert!(root.join("producer").is_dir());
        assert!(root.join("tools").is_dir());
        assert!(root.join("retain-runtime/output").is_dir());
        assert!(supervisor.browser_runtime().is_none());
        assert!(supervisor.poll().unwrap().is_none());
        let body_hash = container_ir::hex_digest(bodies[0].bytes());
        drop(bodies);
        assert!(supervisor.try_shutdown().unwrap());
        assert!(!root.exists());
        assert_eq!(
            fs::read(producer.join("build-report.json")).unwrap(),
            original
        );
        assert!(supervisor.try_shutdown().unwrap());
        eprintln!(
            "{}",
            serde_json::json!({"schemaVersion":1,"scope":"actual-dev-supervisor-static-runtime-preparation", "report":report,"bodySha256":body_hash,"borrowerCount":64,"sameOriginalBodyPointer":true,"cleanupBlockedBeforeBorrowersDropped":true,"ownedRootAbsentAfterRetry":!root.exists(),"producerUnchanged":true,"workerExecuted":false,"browserExecuted":false,"gpu":"unknown"})
        );
    }
    #[test]
    #[cfg(unix)]
    fn browser_runtime_preparation_rejects_overlapping_producer_before_watcher_or_output() {
        let fixture = FakeWvProject::new();
        let mut config = fixture.config();
        config.pack_consumer = DevPackConsumer::BrowserWorker;
        config.browser_runtime = Some(browser_preparation_input(
            fs::canonicalize(&fixture.project).unwrap(),
        ));
        let source = fs::read(&fixture.source_app_json).unwrap();
        assert!(matches!(
            DevSupervisor::spawn(config),
            Err(DevError::BrowserRuntime(_))
        ));
        assert!(!fixture.pid.exists());
        assert!(!fixture.output.exists());
        assert_eq!(fs::read(&fixture.source_app_json).unwrap(), source);
    }
}
