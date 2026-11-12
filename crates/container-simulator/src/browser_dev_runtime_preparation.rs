//! The supervisor's static browser-runtime lane. This never starts a Worker.
//!
//! A single input/tools reservation is held before creating any files, alongside
//! the runtime store's separate reservations. These are conservative logical
//! policy charges, not allocator/RSS or filesystem quotas. All mutation belongs
//! to the supervisor owner thread, outside a socket or runtime mutex.

use crate::browser_dev_aggregate_store::{
    BodyLease, CreditStatus, NamespaceId, PackSourceInput, PackStart, PortableInputLease,
    RetainRuntimeInput, SourceInputLease, SourceStartRejection, SourceStep, StageBodyLease,
    StageStartInput, StaticRuntimeStore, Step,
};
use crate::browser_dev_artifact_job::{
    bounded_regular_file, ArtifactConstructionError, ArtifactJobConfig, ArtifactToolSnapshot,
};
use crate::browser_dev_coordinator::RuntimePins;
use crate::browser_dev_runtime_receipt::ProducerExpected;
use serde::Serialize;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const MIB: u64 = 1024 * 1024;
const MAX_FILE: usize = 64 * 1024 * 1024;
const MAX_INPUT_BYTES: u64 = 256 * MIB;
const MAX_FILES: usize = 16_384;
const MAX_DIRECTORIES: usize = 2048;
const MAX_DEPTH: usize = 64;
const MAX_PATH: usize = 4096;

/// Explicit embedding opt-in. Pins must be selected independently of the
/// consumer, from a completed release Worker producer. The original directory
/// is only read; the supervisor copies bounded regular files into its own root.
#[derive(Clone, Debug)]
pub struct BrowserRuntimePreparation {
    pub producer_directory: PathBuf,
    pub expected: ProducerExpected,
}

impl BrowserRuntimePreparation {
    pub(crate) fn validate(&self) -> Result<(), String> {
        let hex = |value: &str, length| {
            value.len() == length
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        };
        if !self.producer_directory.is_absolute()
            || self
                .producer_directory
                .to_str()
                .is_none_or(|v| v.len() > MAX_PATH)
            || !hex(&self.expected.report_sha256, 64)
            || !hex(&self.expected.source_commit, 40)
            || !hex(&self.expected.source_sha256, 64)
        {
            return Err("invalid independent browser runtime input or pins".into());
        }
        Ok(())
    }

    pub(crate) fn validate_locations(&self, project: &Path, output: &Path) -> Result<(), String> {
        normal_root(&self.producer_directory).map_err(|e| e.to_string())?;
        // Resolve the existing ancestor without creating the destination. This
        // detects symlink aliases before any run/output directory is written.
        let mut ancestor = output;
        let mut suffix = Vec::new();
        while !ancestor.try_exists().map_err(|e| e.to_string())? {
            suffix.push(ancestor.file_name().ok_or("invalid output ancestor")?);
            ancestor = ancestor.parent().ok_or("missing output ancestor")?;
        }
        let mut resolved_output = fs::canonicalize(ancestor).map_err(|e| e.to_string())?;
        for component in suffix.into_iter().rev() {
            resolved_output.push(component);
        }
        let temporary = fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
        let source = &self.producer_directory;
        let overlaps = |path: &Path| source.starts_with(path) || path.starts_with(source);
        if overlaps(project) || overlaps(&resolved_output) || temporary.starts_with(source) {
            return Err(
                "producer must be separate from project, output and preparation roots".into(),
            );
        }
        Ok(())
    }
}

/// Verified static bytes only. Neither flag can become true in this lane.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRuntimePrepared {
    pub schema_version: u32,
    pub pins: RuntimePins,
    pub producer_bytes: u64,
    pub producer_files: usize,
    pub runtime_memory_policy_bytes: u64,
    pub runtime_disk_policy_bytes: u64,
    pub input_tools_memory_policy_bytes: u64,
    pub input_tools_disk_policy_bytes: u64,
    pub runtime_ready: bool,
    pub presented_ready: bool,
}

/// A bounded borrower of the actual immutable bytes and their original charge.
/// It grants no URL or execution authority. Drop it before retrying shutdown.
#[derive(Debug)]
pub struct BrowserRuntimeResource(BodyLease);
impl BrowserRuntimeResource {
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

pub(crate) enum PreparationUpdate {
    Prepared(BrowserRuntimePrepared),
    Failed(String),
}

#[derive(Debug, Default)]
struct InputInventory {
    files: BTreeSet<PathBuf>,
    directories: usize,
    bytes: u64,
}

fn normal_root(path: &Path) -> io::Result<()> {
    if !path.is_absolute()
        || fs::canonicalize(path)? != path
        || !fs::symlink_metadata(path)?.is_dir()
    {
        return Err(io::Error::other("input root must be a canonical directory"));
    }
    Ok(())
}

fn inventory(root: &Path) -> io::Result<InputInventory> {
    fn walk(root: &Path, path: &Path, depth: usize, out: &mut InputInventory) -> io::Result<()> {
        out.directories += 1;
        if out.directories > MAX_DIRECTORIES || depth > MAX_DEPTH {
            return Err(io::Error::other("producer directory budget exceeded"));
        }
        normal_root(path)?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let path = entry.path();
            let relative = path.strip_prefix(root).map_err(io::Error::other)?;
            if relative.to_str().is_none_or(|s| s.len() > MAX_PATH) {
                return Err(io::Error::other("producer path budget exceeded"));
            }
            let meta = fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                walk(root, &path, depth + 1, out)?;
            } else if meta.is_file() && !meta.file_type().is_symlink() {
                if out.files.len() >= MAX_FILES || meta.len() > MAX_FILE as u64 {
                    return Err(io::Error::other("producer file budget exceeded"));
                }
                out.bytes = out
                    .bytes
                    .checked_add(meta.len())
                    .filter(|bytes| *bytes <= MAX_INPUT_BYTES)
                    .ok_or_else(|| io::Error::other("producer byte budget exceeded"))?;
                out.files.insert(relative.to_owned());
            } else {
                return Err(io::Error::other("producer contains a nonregular file"));
            }
        }
        Ok(())
    }
    let mut out = InputInventory::default();
    walk(root, root, 0, &mut out)?;
    Ok(out)
}

fn private_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    fs::create_dir(path)
}

fn freeze_producer(source: &Path, target: &Path) -> Result<InputInventory, String> {
    normal_root(source).map_err(|e| e.to_string())?;
    let before = inventory(source).map_err(|e| e.to_string())?;
    private_directory(target).map_err(|e| e.to_string())?;
    let mut copied = 0_u64;
    for relative in &before.files {
        let bytes =
            bounded_regular_file(&source.join(relative), MAX_FILE).map_err(|e| e.to_string())?;
        copied = copied
            .checked_add(bytes.len() as u64)
            .filter(|n| *n <= MAX_INPUT_BYTES)
            .ok_or("producer grew beyond its byte budget")?;
        let output = target.join(relative);
        fs::create_dir_all(output.parent().expect("file has parent")).map_err(|e| e.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options
            .open(&output)
            .and_then(|mut f| f.write_all(&bytes))
            .map_err(|e| e.to_string())?;
    }
    let after = inventory(source).map_err(|e| e.to_string())?;
    if before.files != after.files || before.bytes != after.bytes || copied != before.bytes {
        return Err("producer changed while copying".into());
    }
    // The completed producer's externally pinned report and every retained
    // hash are verified by the finite helper and Rust receipt, on this copy.
    Ok(before)
}

pub(crate) struct BrowserRuntimePreparationOwner {
    input: BrowserRuntimePreparation,
    node: PathBuf,
    timeout: Duration,
    root: PathBuf,
    root_owned: bool,
    started: bool,
    stopping: bool,
    settled: bool,
    cleanup_error: Option<String>,
    tools: Option<ArtifactToolSnapshot>,
    construction_failure: Option<ArtifactConstructionError>,
    store: StaticRuntimeStore,
    managed_sources: bool,
    managed_stages: bool,
    stage_last_error: Option<String>,
    runtime: Option<NamespaceId>,
    input_stats: Option<(u64, usize)>,
    report: Option<BrowserRuntimePrepared>,
}

impl BrowserRuntimePreparationOwner {
    /// Reserves one fixed input/tools slot before any filesystem operation.
    /// There is exactly one such owner per supervisor. It cannot be cloned.
    pub(crate) fn new(
        input: BrowserRuntimePreparation,
        node: PathBuf,
        timeout: Duration,
        root: PathBuf,
    ) -> Result<Self, String> {
        Self::new_with_sources(input, node, timeout, root, false)
    }

    pub(crate) fn new_with_sources(
        input: BrowserRuntimePreparation,
        node: PathBuf,
        timeout: Duration,
        root: PathBuf,
        managed_sources: bool,
    ) -> Result<Self, String> {
        Self::new_with_policy(input, node, timeout, root, managed_sources, false)
    }

    pub(crate) fn new_with_stages(
        input: BrowserRuntimePreparation,
        node: PathBuf,
        timeout: Duration,
        root: PathBuf,
    ) -> Result<Self, String> {
        Self::new_with_policy(input, node, timeout, root, true, true)
    }

    fn new_with_policy(
        input: BrowserRuntimePreparation,
        node: PathBuf,
        timeout: Duration,
        root: PathBuf,
        managed_sources: bool,
        managed_stages: bool,
    ) -> Result<Self, String> {
        input.validate()?;
        let store = (if managed_stages {
            StaticRuntimeStore::with_stages()
        } else if managed_sources {
            StaticRuntimeStore::with_sources()
        } else {
            StaticRuntimeStore::new()
        })
        .map_err(|e| e.to_string())?;
        Ok(Self {
            input,
            node,
            timeout,
            root,
            root_owned: false,
            started: false,
            stopping: false,
            settled: false,
            cleanup_error: None,
            tools: None,
            construction_failure: None,
            store,
            managed_sources,
            managed_stages,
            stage_last_error: None,
            runtime: None,
            input_stats: None,
            report: None,
        })
    }

    fn start(&mut self) -> Result<(), String> {
        let parent = self.root.parent().ok_or("missing owned root parent")?;
        normal_root(parent).map_err(|e| e.to_string())?;
        let producer =
            fs::canonicalize(&self.input.producer_directory).map_err(|e| e.to_string())?;
        if producer != self.input.producer_directory
            || producer.starts_with(&self.root)
            || self.root.starts_with(&producer)
        {
            return Err("producer and owned output must be separate canonical directories".into());
        }
        // Never claim or clean a pre-existing namespace.
        private_directory(&self.root).map_err(|e| e.to_string())?;
        self.root_owned = true;
        let frozen = self.root.join("producer");
        let inventory = freeze_producer(&producer, &frozen)?;
        let tools = match ArtifactToolSnapshot::stage(&self.root, "tools") {
            Ok(tools) => tools,
            Err(failure) => {
                let cause = failure.to_string();
                self.construction_failure = Some(failure);
                return Err(cause);
            }
        };
        self.tools = Some(tools.clone());
        let config = ArtifactJobConfig::new(
            self.node.clone(),
            tools,
            self.root.clone(),
            "retain-runtime".into(),
            self.timeout,
        );
        let input = RetainRuntimeInput {
            request_id: "supervisor-runtime".into(),
            built_site_directory: frozen,
            expected: self.input.expected.clone(),
        };
        let (id, _) = self
            .store
            .start_runtime(config, input)
            .map_err(|rejection| {
                let rejection = *rejection;
                let cause = rejection.cause.to_string();
                // No namespace was admitted. This owner still holds the
                // actual producer and original tools root; release only the
                // returned unused config/tool borrow and input metadata.
                drop(rejection.config);
                drop(rejection.input);
                cause
            })?;
        self.runtime = Some(id);
        self.input_stats = Some((inventory.bytes, inventory.files.len()));
        Ok(())
    }

    pub(crate) fn poll(&mut self) -> Option<PreparationUpdate> {
        if self.stopping {
            return None;
        }
        if self.settled {
            // A reported failure cannot strand a live constructor-recovery
            // child until the whole supervisor exits. Advance the original
            // charged cleanup lane on every owner turn; keep input/tools/root
            // ownership until explicit shutdown. Emit changed cleanup errors
            // once, rather than flooding the source event queue.
            if self.report.is_none() {
                if let Some(id) = self.runtime {
                    let step = self.store.retire(id).and_then(|()| self.store.cleanup(id));
                    match step {
                        Ok(Step::Released) => {
                            self.runtime = None;
                            self.cleanup_error = None;
                        }
                        Ok(_) => {
                            let error = self
                                .store
                                .diagnostic(id)
                                .ok()
                                .flatten()
                                .map(ToString::to_string);
                            if error != self.cleanup_error {
                                self.cleanup_error = error;
                                if let Some(error) = &self.cleanup_error {
                                    return Some(PreparationUpdate::Failed(error.clone()));
                                }
                            }
                        }
                        Err(error) => {
                            let error = error.to_string();
                            if self.cleanup_error.as_ref() != Some(&error) {
                                self.cleanup_error = Some(error.clone());
                                return Some(PreparationUpdate::Failed(error));
                            }
                        }
                    }
                }
            }
            return None;
        }
        if !self.started {
            self.started = true;
            if let Err(cause) = self.start() {
                self.settled = true;
                return Some(PreparationUpdate::Failed(cause));
            }
        }
        let id = self.runtime?;
        let step = match self.store.poll(id) {
            Ok(step) => step,
            Err(cause) => {
                self.settled = true;
                return Some(PreparationUpdate::Failed(cause.to_string()));
            }
        };
        match step {
            Step::Running => None,
            Step::CapturedStatic => {
                self.settled = true;
                let pins = match self.store.pins(id) {
                    Ok(pins) => pins.clone(),
                    Err(cause) => return Some(PreparationUpdate::Failed(cause.to_string())),
                };
                let (used, _) = self.store.capacity();
                let root_policy = self.store.source_root_policy();
                let root_memory = root_policy.map_or(0, |policy| policy.memory_bytes);
                let root_disk = root_policy.map_or(0, |policy| policy.disk_bytes);
                let (producer_bytes, producer_files) = self
                    .input_stats
                    .expect("started owner has input accounting");
                let report = BrowserRuntimePrepared {
                    schema_version: 1,
                    pins,
                    producer_bytes,
                    producer_files,
                    runtime_memory_policy_bytes: used.memory_bytes - root_memory,
                    runtime_disk_policy_bytes: used.disk_bytes - root_disk,
                    input_tools_memory_policy_bytes: root_policy
                        .map_or(512 * MIB, |policy| policy.memory_bytes),
                    input_tools_disk_policy_bytes: root_policy
                        .map_or(512 * MIB, |policy| policy.disk_bytes),
                    runtime_ready: false,
                    presented_ready: false,
                };
                self.report = Some(report.clone());
                Some(PreparationUpdate::Prepared(report))
            }
            _ => {
                self.settled = true;
                let cause = self
                    .store
                    .diagnostic(id)
                    .ok()
                    .flatten()
                    .map(ToString::to_string)
                    .or_else(|| {
                        self.store
                            .construction_failure(id)
                            .ok()
                            .flatten()
                            .map(ToString::to_string)
                    })
                    .unwrap_or_else(|| {
                        "browser runtime preparation retired without a receipt".into()
                    });
                Some(PreparationUpdate::Failed(cause))
            }
        }
    }

    pub(crate) fn is_settled(&self) -> bool {
        self.settled && (self.report.is_some() || self.runtime.is_none())
    }

    pub(crate) fn report(&self) -> Option<&BrowserRuntimePrepared> {
        if self.stopping {
            None
        } else {
            self.report.as_ref()
        }
    }

    pub(crate) fn resource(
        &mut self,
        path: &str,
    ) -> Result<Option<BrowserRuntimeResource>, String> {
        if self.stopping || !self.settled {
            return Ok(None);
        }
        let Some(id) = self.runtime else {
            return Ok(None);
        };
        self.store
            .resource(id, path)
            .map(|body| body.map(BrowserRuntimeResource))
            .map_err(|e| e.to_string())
    }

    pub(crate) fn prepare_sources(&mut self, run: String, compiler: String) -> io::Result<()> {
        if !self.managed_sources || self.report.is_none() || self.stopping {
            return Err(io::Error::other(
                "source preparation requires its admitted static runtime",
            ));
        }
        let root = self.root.join("source-control");
        private_directory(&root)?;
        self.store.install_sources(root, run, compiler)
    }
    pub(crate) fn issue_raw(&mut self) -> Result<NamespaceId, Box<SourceStartRejection>> {
        self.store.issue_raw()
    }
    pub(crate) fn source_status(&self) -> io::Result<Option<CreditStatus>> {
        self.store.source_status()
    }
    pub(crate) fn accept_raw(&mut self, status: &CreditStatus) -> io::Result<NamespaceId> {
        self.store.accept_raw(status)
    }
    pub(crate) fn source_borrow(&mut self, id: NamespaceId) -> io::Result<SourceInputLease> {
        self.store.source_borrow(id)
    }
    pub(crate) fn start_source_pack(
        &mut self,
        intent: PackStart,
        input: PackSourceInput,
    ) -> Result<NamespaceId, Box<SourceStartRejection>> {
        self.store.start_source_pack(intent, input)
    }
    pub(crate) fn poll_source_pack(&mut self, id: NamespaceId) -> io::Result<SourceStep> {
        self.store.poll_source_pack(id)
    }
    pub(crate) fn source_report(
        &self,
        id: NamespaceId,
    ) -> io::Result<&crate::dev::PortablePackReport> {
        self.store.source_report(id)
    }
    pub(crate) fn source_step(&self, id: NamespaceId) -> io::Result<SourceStep> {
        self.store.source_step(id)
    }

    pub(crate) fn portable_input(&mut self, id: NamespaceId) -> io::Result<PortableInputLease> {
        self.store.portable_input(id)
    }

    pub(crate) fn start_stage(
        &mut self,
        run_id: String,
        ticket: crate::browser_dev_coordinator::StageTicket,
        startup_intent: Vec<u8>,
        portable_input: PortableInputLease,
    ) -> Result<NamespaceId, String> {
        if self.stopping || !self.managed_stages {
            return Err("consuming stage policy is unavailable".into());
        }
        let runtime = self
            .store
            .runtime_input(self.runtime.ok_or("runtime is not prepared")?)
            .map_err(|e| e.to_string())?;
        let request_id = format!("stage-{}", ticket.site_id().get());
        let config = ArtifactJobConfig::new(
            self.node.clone(),
            self.tools
                .as_ref()
                .ok_or("original tool owner unavailable")?
                .clone(),
            self.root.clone(),
            request_id.clone(),
            self.timeout,
        );
        self.store
            .start_stage(
                config,
                StageStartInput {
                    run_id,
                    request_id,
                    ticket,
                    startup_intent,
                    runtime,
                    portable_input,
                },
            )
            .map(|(id, _)| id)
            .map_err(|rejection| {
                // No stage was admitted. The original runtime/portable owners and
                // tools stay in this parent; drop only the returned unused borrows.
                let crate::browser_dev_aggregate_store::StageStartRejection {
                    cause,
                    config,
                    input,
                } = *rejection;
                drop(input);
                drop(config);
                cause.to_string()
            })
    }

    pub(crate) fn poll_stage(&mut self, id: NamespaceId) -> Result<Step, String> {
        let step = self.store.poll_stage(id).map_err(|e| e.to_string())?;
        if matches!(step, Step::Retiring | Step::CleanupPending) {
            if let Some(cause) = self.store.stage_diagnostic(id).map_err(|e| e.to_string())? {
                return Err(cause.to_string());
            }
        }
        Ok(step)
    }

    pub(crate) fn stage_artifact(
        &self,
        id: NamespaceId,
    ) -> Result<&crate::browser_dev_coordinator::StageArtifact, String> {
        self.store.stage_artifact(id).map_err(|e| e.to_string())
    }

    pub(crate) fn stage_resource(
        &mut self,
        id: NamespaceId,
        path: &str,
    ) -> Result<Option<StageBodyLease>, String> {
        if self.stopping {
            return Err("artifact owner is stopping".into());
        }
        self.store
            .stage_resource(id, path)
            .map_err(|e| e.to_string())
    }

    pub(crate) fn retire_stage(&mut self, id: NamespaceId) -> Result<bool, String> {
        self.store.retire_stage(id).map_err(|e| e.to_string())?;
        let released = self.store.cleanup_stage(id).map_err(|e| e.to_string())? == Step::Released;
        if !released {
            if let Some(cause) = self.store.stage_diagnostic(id).map_err(|e| e.to_string())? {
                return Err(cause.to_string());
            }
        }
        Ok(released)
    }

    pub(crate) fn advance_stages(&mut self) -> Option<String> {
        if self.stopping {
            return None;
        }
        let mut first = None;
        for id in self.store.stage_ids() {
            let result = (|| -> Result<(), String> {
                let step = self.store.poll_stage(id).map_err(|e| e.to_string())?;
                // Keep diagnostic states owned until explicit retirement. A
                // caller can still inspect the failure; poll never drops a site.
                if matches!(step, Step::Retiring | Step::CleanupPending) {
                    if let Some(cause) =
                        self.store.stage_diagnostic(id).map_err(|e| e.to_string())?
                    {
                        return Err(cause.to_string());
                    }
                }
                Ok(())
            })();
            if first.is_none() {
                first = result.err();
            }
        }
        if first == self.stage_last_error {
            return None;
        }
        self.stage_last_error = first.clone();
        first
    }

    fn drain_stages(&mut self) -> Result<bool, String> {
        let mut drained = true;
        let mut error = None;
        for id in self.store.stage_ids() {
            match self.retire_stage(id) {
                Ok(true) => {}
                Ok(false) => drained = false,
                Err(cause) => {
                    drained = false;
                    if error.is_none() {
                        error = Some(cause);
                    }
                }
            }
        }
        if let Some(error) = error {
            return Err(error);
        }
        Ok(drained)
    }
    pub(crate) fn source_diagnostic(&self, id: NamespaceId) -> io::Result<Option<&str>> {
        self.store.source_diagnostic(id)
    }
    pub(crate) fn retire_source(&mut self, id: NamespaceId) -> io::Result<()> {
        self.store.retire_source(id)
    }
    pub(crate) fn cleanup_source(&mut self, id: NamespaceId) -> io::Result<SourceStep> {
        self.store.cleanup_source(id)
    }
    pub(crate) fn spawn_source_watcher(
        &mut self,
        command: &mut std::process::Command,
    ) -> io::Result<()> {
        self.store.spawn_source_watcher(command)
    }
    pub(crate) fn source_stdout(&mut self) -> Option<std::process::ChildStdout> {
        self.store.source_stdout()
    }
    pub(crate) fn source_stderr(&mut self) -> Option<std::process::ChildStderr> {
        self.store.source_stderr()
    }
    pub(crate) fn poll_source_watcher(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.store.poll_source_watcher()
    }
    pub(crate) fn stop_source_watcher(&mut self) -> io::Result<bool> {
        self.store.stop_source_watcher()
    }

    pub(crate) fn drain_sources(&mut self) -> io::Result<bool> {
        let ids = self.store.source_ids();
        for id in &ids {
            self.store.retire_source(*id)?;
        }
        let mut pending = false;
        let mut first_error = None;
        for id in ids {
            match self.store.cleanup_source(id) {
                Ok(SourceStep::Released) => {}
                Ok(_) => pending = true,
                Err(error) => {
                    if first_error.is_none() {
                        first_error = Some(error);
                    }
                }
            }
        }
        // Visit every dependent output even when an earlier raw entry is
        // borrowed by it. A pending raw must not prevent its pack from closing.
        if let Some(error) = first_error {
            return Err(error);
        }
        if pending {
            return Ok(false);
        }
        Ok(true)
    }

    /// No input/tools/root deletion until the real process and every original
    /// body borrower retire. False/errors preserve this exact owner for retry.
    pub(crate) fn try_shutdown(&mut self) -> Result<bool, String> {
        self.stopping = true;
        // Stages borrow portable/runtime inputs. Advance their actual process,
        // body and output barriers before waiting for those inputs to drain.
        if !self.drain_stages()? {
            return Ok(false);
        }
        if !self
            .store
            .stop_source_watcher()
            .map_err(|e| e.to_string())?
        {
            return Ok(false);
        }
        // Every registry-owned raw/portable namespace drains before producer,
        // tools or parent removal. Borrowers keep these exact entries charged.
        if !self.drain_sources().map_err(|e| e.to_string())? {
            return Ok(false);
        }
        if let Some(id) = self.runtime {
            self.store.retire(id).map_err(|e| e.to_string())?;
            if self.store.cleanup(id).map_err(|e| e.to_string())? != Step::Released {
                if let Some(cause) = self.store.diagnostic(id).map_err(|e| e.to_string())? {
                    return Err(cause.to_string());
                }
                return Ok(false);
            }
            self.runtime = None;
            self.report = None;
        }
        if !self.store.payloads_drained() {
            return Ok(false);
        }
        if let Some(failure) = self.construction_failure.as_mut() {
            if !failure.retry_cleanup().map_err(|e| e.to_string())? {
                return Ok(false);
            }
            self.construction_failure = None;
        }
        if let Some(tools) = self.tools.as_mut() {
            if !tools.try_cleanup().map_err(|e| e.to_string())? {
                return Ok(false);
            }
            self.tools = None;
        }
        if self.root_owned {
            match fs::remove_dir_all(&self.root) {
                Ok(()) => self.root_owned = false,
                Err(e) if e.kind() == io::ErrorKind::NotFound => self.root_owned = false,
                Err(e) => return Err(e.to_string()),
            }
        }
        self.store
            .release_source_root()
            .map_err(|e| e.to_string())?;
        Ok(true)
    }
}

impl Drop for BrowserRuntimePreparationOwner {
    fn drop(&mut self) {
        if self.root_owned {
            eprintln!(
                "weapp-simulator: explicit browser runtime cleanup is incomplete; retaining {}",
                self.root.display()
            );
        }
    }
}

#[cfg(test)]
#[path = "browser_dev_runtime_preparation_tests.rs"]
mod tests;
