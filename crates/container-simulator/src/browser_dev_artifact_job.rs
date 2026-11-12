//! One owned, finite Node artifact job. This layer never starts an AppService,
//! browser, server or Cargo, and successful exit grants no publication authority.
//!
//! The caller supplies an immutable trusted tool snapshot, reserves aggregate
//! disk/memory capacity before spawn, and validates the returned static receipt
//! against the coordinator ticket before its immediate source barrier.

use crate::browser_dev_read::read_exact_snapshot;
use crate::owned_process::OwnedProcess;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const MAX_REQUEST_BYTES: usize = 2 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENTRY_BYTES: u64 = 1024 * 1024;

// Complete static Node import closure of the finite entry. Runtime/app inputs
// are separately byte-verified by these tools and never imported as Node code.
// Embed the trusted tool bytes in the simulator build, rather than executing a
// changing workspace script after its initial hash check.
const EMBEDDED_TOOL_FILES: &[(&str, &[u8])] = &[
    (
        "scripts/browser-dev-artifacts-cli.mjs",
        include_bytes!("../../../scripts/browser-dev-artifacts-cli.mjs"),
    ),
    (
        "scripts/browser-dev-artifacts.mjs",
        include_bytes!("../../../scripts/browser-dev-artifacts.mjs"),
    ),
    (
        "scripts/build-web-wasm.mjs",
        include_bytes!("../../../scripts/build-web-wasm.mjs"),
    ),
    (
        "scripts/generated-package-closure.mjs",
        include_bytes!("../../../scripts/generated-package-closure.mjs"),
    ),
    (
        "scripts/lib/showcase-policy.mjs",
        include_bytes!("../../../scripts/lib/showcase-policy.mjs"),
    ),
    (
        "examples/hosts/web-wasm/renderer-dependency-pins.json",
        include_bytes!("../../../examples/hosts/web-wasm/renderer-dependency-pins.json"),
    ),
];

#[derive(Debug, thiserror::Error)]
pub enum ArtifactJobError {
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Invalid(&'static str),
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Io(#[from] io::Error),
    #[error("ERR_BROWSER_DEV_ARTIFACT: {0}")]
    Json(#[from] serde_json::Error),
}

type Result<T> = std::result::Result<T, ArtifactJobError>;
type ConstructionResult<T> = std::result::Result<T, ArtifactConstructionError>;

/// Construction failed without relinquishing its actual cleanup owner.
/// Store this value with the caller's existing capacity reservation; only
/// retry_cleanup() == Ok(true) permits releasing that reservation. Formatting
/// the error or dropping it is not a successful cleanup receipt.
#[must_use = "retain this error and its reservation until retry_cleanup returns true"]
#[derive(Debug, thiserror::Error)]
#[error("{cause}")]
pub struct ArtifactConstructionError {
    #[source]
    cause: ArtifactJobError,
    recovery: ArtifactConstructionRecovery,
}

#[derive(Debug)]
enum ArtifactConstructionRecovery {
    None,
    // Configuration rejection must retain the tool lease it consumed.
    Config(Box<ArtifactJobConfig>),
    Files {
        files: Arc<ArtifactFiles>,
        tools: Option<ArtifactToolSnapshot>,
    },
    // Never replace this actual owner with a PID or recovery pathname.
    Job(Box<ArtifactJob>),
}

impl From<ArtifactJobError> for ArtifactConstructionError {
    fn from(cause: ArtifactJobError) -> Self {
        Self {
            cause,
            recovery: ArtifactConstructionRecovery::None,
        }
    }
}

impl ArtifactConstructionError {
    fn config(cause: ArtifactJobError, config: ArtifactJobConfig) -> Self {
        let recovery = if config.tool_snapshot.is_some() {
            ArtifactConstructionRecovery::Config(Box::new(config))
        } else {
            ArtifactConstructionRecovery::None
        };
        Self { cause, recovery }
    }

    fn files(
        cause: ArtifactJobError,
        files: Arc<ArtifactFiles>,
        tools: Option<ArtifactToolSnapshot>,
    ) -> Self {
        Self {
            cause,
            recovery: ArtifactConstructionRecovery::Files { files, tools },
        }
    }

    fn job(cause: ArtifactJobError, job: ArtifactJob) -> Self {
        Self {
            cause,
            recovery: ArtifactConstructionRecovery::Job(Box::new(job)),
        }
    }

    pub fn cause(&self) -> &ArtifactJobError {
        &self.cause
    }
    pub fn requires_cleanup(&self) -> bool {
        !matches!(&self.recovery, ArtifactConstructionRecovery::None)
    }
    pub fn retained_root(&self) -> Option<&Path> {
        match &self.recovery {
            ArtifactConstructionRecovery::None => None,
            ArtifactConstructionRecovery::Config(config) => config
                .tool_snapshot
                .as_ref()
                .map(ArtifactToolSnapshot::root),
            ArtifactConstructionRecovery::Files { files, .. } => Some(files.root()),
            ArtifactConstructionRecovery::Job(job) => Some(job.files.root()),
        }
    }
    pub fn retained_process_id(&self) -> Option<u32> {
        match &self.recovery {
            ArtifactConstructionRecovery::Job(job) => Some(job.process_id()),
            _ => None,
        }
    }
    pub fn retained_tool_root(&self) -> Option<&Path> {
        let tools = match &self.recovery {
            ArtifactConstructionRecovery::None => return None,
            ArtifactConstructionRecovery::Config(config) => &config.tool_snapshot,
            ArtifactConstructionRecovery::Files { tools, .. } => tools,
            ArtifactConstructionRecovery::Job(job) => &job._tool_snapshot,
        };
        tools.as_ref().map(ArtifactToolSnapshot::root)
    }

    /// Run outside an HTTP/socket turn: shutdown and directory removal can
    /// block. False/error retains recovery ownership and any cleanup progress.
    /// True proves this construction's private namespace is removed and its
    /// borrowed tools released. A shared tool directory may remain in use by
    /// another independent owner; this never claims its deletion.
    pub fn retry_cleanup(&mut self) -> Result<bool> {
        self.retry_cleanup_with(ArtifactFiles::cleanup, ArtifactJob::shutdown)
    }

    // Local dependency injection only: no process-global failure flags and no
    // configurable production I/O hooks. Tests may fail these real boundaries.
    fn retry_cleanup_with<C, S>(&mut self, mut cleanup: C, mut shutdown: S) -> Result<bool>
    where
        C: FnMut(&mut ArtifactFiles) -> io::Result<()>,
        S: FnMut(&mut ArtifactJob) -> Result<bool>,
    {
        let cleaned = match &mut self.recovery {
            ArtifactConstructionRecovery::None => true,
            ArtifactConstructionRecovery::Config(config) => {
                release_borrowed_tools(&mut config.tool_snapshot, &mut cleanup)?
            }
            ArtifactConstructionRecovery::Files { files, tools } => {
                if !cleanup_exclusive_files(files, &mut cleanup)? {
                    false
                } else {
                    release_borrowed_tools(tools, &mut cleanup)?
                }
            }
            ArtifactConstructionRecovery::Job(job) => {
                if !shutdown(job.as_mut())?
                    || !cleanup_exclusive_files(&mut job.files, &mut cleanup)?
                {
                    false
                } else {
                    release_borrowed_tools(&mut job._tool_snapshot, &mut cleanup)?
                }
            }
        };
        if cleaned {
            self.recovery = ArtifactConstructionRecovery::None;
        }
        Ok(cleaned)
    }
}

fn cleanup_exclusive_files<C>(files: &mut Arc<ArtifactFiles>, cleanup: &mut C) -> Result<bool>
where
    C: FnMut(&mut ArtifactFiles) -> io::Result<()>,
{
    let Some(owner) = Arc::get_mut(files) else {
        return Ok(false);
    };
    cleanup(owner)?;
    if owner.active {
        return Err(ArtifactJobError::Invalid(
            "cleanup returned without retiring its file owner",
        ));
    }
    Ok(true)
}

// The runtime owner serializes all lease mutation. Multiple failed jobs may
// borrow one tool snapshot: releasing a borrowed clone must not wait forever
// for every other failure to obtain exclusive access to the same Arc.
fn release_borrowed_tools<C>(
    tools: &mut Option<ArtifactToolSnapshot>,
    cleanup: &mut C,
) -> Result<bool>
where
    C: FnMut(&mut ArtifactFiles) -> io::Result<()>,
{
    let Some(snapshot) = tools.take() else {
        return Ok(true);
    };
    match Arc::try_unwrap(snapshot.files) {
        Err(shared) => {
            // Another serialized owner still holds the directory and its
            // independent shared-tool capacity charge. Release this borrow.
            drop(shared);
            Ok(true)
        }
        Ok(mut owner) => {
            let result = cleanup(&mut owner).map_err(ArtifactJobError::from).and({
                if owner.active {
                    Err(ArtifactJobError::Invalid(
                        "cleanup returned without retiring its tool owner",
                    ))
                } else {
                    Ok(())
                }
            });
            match result {
                Ok(()) => Ok(true),
                Err(error) => {
                    *tools = Some(ArtifactToolSnapshot {
                        files: Arc::new(owner),
                    });
                    Err(error)
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
pub struct ArtifactJobConfig {
    node_bin: PathBuf,
    entrypoint: PathBuf,
    entrypoint_sha256: String,
    tool_snapshot: Option<ArtifactToolSnapshot>,
    /// Canonical private run directory, outside all producer/pack inputs.
    parent: PathBuf,
    /// Fresh exclusive directory component. Existing directories are rejected.
    job_name: String,
    timeout: Duration,
}
impl ArtifactJobConfig {
    pub fn new(
        node_bin: PathBuf,
        tools: ArtifactToolSnapshot,
        parent: PathBuf,
        job_name: String,
        timeout: Duration,
    ) -> Self {
        Self {
            node_bin,
            entrypoint: tools.files.root.join(EMBEDDED_TOOL_FILES[0].0),
            entrypoint_sha256: format!("{:x}", Sha256::digest(EMBEDDED_TOOL_FILES[0].1)),
            tool_snapshot: Some(tools),
            parent,
            job_name,
            timeout,
        }
    }

    /// Borrow actual constructor facts for bounded managed-request admission.
    /// This does not expose a configurable entrypoint or transfer tool ownership.
    pub(crate) fn namespace_request_parts(&self) -> (&Path, &str) {
        (&self.parent, &self.job_name)
    }
}

/// One exclusive copy of the exact tool closure compiled into this binary.
/// Clones hold the same private directory through every dependent child's
/// verified cleanup barrier. No application/source directory is served here.
#[derive(Clone, Debug)]
pub struct ArtifactToolSnapshot {
    files: Arc<ArtifactFiles>,
}
impl ArtifactToolSnapshot {
    pub fn stage(parent: &Path, name: &str) -> ConstructionResult<Self> {
        Self::stage_with(parent, name, Self::write_embedded)
    }
    fn stage_with(
        parent: &Path,
        name: &str,
        fill: impl FnOnce(&Arc<ArtifactFiles>) -> Result<()>,
    ) -> ConstructionResult<Self> {
        canonical_directory(parent)?;
        if !identifier(name) {
            return Err(ArtifactJobError::Invalid("invalid tool snapshot name").into());
        }
        let files = reserve_files(parent.join(name)).map_err(ArtifactJobError::from)?;
        match fill(&files) {
            Ok(()) => Ok(Self { files }),
            Err(cause) => Err(ArtifactConstructionError::files(cause, files, None)),
        }
    }
    fn write_embedded(files: &Arc<ArtifactFiles>) -> Result<()> {
        let mut inventory = Vec::new();
        for (path, bytes) in EMBEDDED_TOOL_FILES {
            let output = files.root.join(path);
            fs::create_dir_all(output.parent().expect("fixed tool parent"))?;
            private_file(&output)?.write_all(bytes)?;
            inventory.push(serde_json::json!({"path":path,"size":bytes.len(),"sha256":format!("{:x}", Sha256::digest(bytes))}));
        }
        let descriptor = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,
            "scope":"embedded-finite-artifact-tools","files":inventory}))?;
        private_file(&files.root.join("tool-snapshot.json"))?.write_all(&descriptor)?;
        Ok(())
    }
    pub fn root(&self) -> &Path {
        self.files.root()
    }
    pub(crate) fn try_cleanup(&mut self) -> io::Result<bool> {
        let Some(files) = Arc::get_mut(&mut self.files) else {
            return Ok(false);
        };
        files.cleanup()?;
        Ok(files.is_retired())
    }
    fn verify(&self) -> Result<()> {
        canonical_directory(&self.files.root)?;
        for (path, expected) in EMBEDDED_TOOL_FILES {
            let bytes =
                bounded_regular_file(&self.files.root.join(path), MAX_ENTRY_BYTES as usize)?;
            if bytes != *expected {
                return Err(ArtifactJobError::Invalid("embedded tool closure changed"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactJobStop {
    Cancelled,
    Superseded,
    TimedOut,
}

/// Keeps the entire private job namespace alive while a candidate is inspected
/// or served through a separate resource lease. Do not retain a bare path after
/// dropping this handle. The owner must explicitly call cleanup for a fallible
/// cleanup barrier; Drop reports any remaining cleanup failure to the terminal.
#[derive(Debug)]
pub struct ArtifactFiles {
    root: PathBuf,
    active: bool,
    preserve_after_cleanup_failure: AtomicBool,
}

impl ArtifactFiles {
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn output(&self) -> PathBuf {
        self.root.join("output")
    }
    /// Read the actual cleanup owner's state, not pathname existence.
    pub(crate) fn is_retired(&self) -> bool {
        !self.active
    }

    pub fn cleanup(&mut self) -> io::Result<()> {
        if !self.active {
            return Ok(());
        }
        if self.preserve_after_cleanup_failure.load(Ordering::Acquire) {
            return Err(io::Error::other(
                "artifact process cleanup is unresolved; preserve its files",
            ));
        }
        match fs::remove_dir_all(&self.root) {
            Ok(()) => {
                self.active = false;
                Ok(())
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.active = false;
                Ok(())
            }
            Err(error) => Err(error),
        }
    }
}

impl Drop for ArtifactFiles {
    fn drop(&mut self) {
        if self.preserve_after_cleanup_failure.load(Ordering::Acquire) {
            return;
        }
        if let Err(error) = self.cleanup() {
            eprintln!(
                "weapp-simulator: cannot remove owned artifact directory {}: {error}",
                self.root.display()
            );
        }
    }
}

/// A transport result only. The actual static receipt still needs byte/pin,
/// site/ticket and source-freshness validation before coordinator publication.
#[derive(Debug)]
pub struct ArtifactJobCompletion {
    pub files: Arc<ArtifactFiles>,
    pub request_id: String,
    pub operation: String,
    pub request_sha256: String,
    pub exit_status: ExitStatus,
    pub stopped: Option<ArtifactJobStop>,
    /// A failed/aborted child may leave no result, malformed JSON, or a complete
    /// late result. Retain that observation; never treat it as ready after stop.
    pub result: Result<Arc<Vec<u8>>>,
}

impl ArtifactJobCompletion {
    pub fn static_result(&self) -> Result<Value> {
        if self.stopped.is_some() {
            return Err(ArtifactJobError::Invalid("job was stopped"));
        }
        if !self.exit_status.success() {
            return Err(ArtifactJobError::Invalid("child exit was unsuccessful"));
        }
        let bytes = self
            .result
            .as_ref()
            .map_err(|_| ArtifactJobError::Invalid("child result is unavailable"))?;
        let value: Value = serde_json::from_slice(bytes)?;
        if value.get("schemaVersion").and_then(Value::as_u64) != Some(1)
            || value.get("requestId").and_then(Value::as_str) != Some(self.request_id.as_str())
            || value.get("op").and_then(Value::as_str) != Some(self.operation.as_str())
            || value.get("status").and_then(Value::as_str) != Some("staged-static")
            || value.get("runtimeReady").and_then(Value::as_bool) != Some(false)
            || value.get("presentedReady").and_then(Value::as_bool) != Some(false)
        {
            return Err(ArtifactJobError::Invalid(
                "child static receipt does not match the job",
            ));
        }
        Ok(value)
    }
}

#[derive(Debug)]
pub struct ArtifactJob {
    // Declaration order is intentional: process ownership drops before files.
    child: OwnedProcess,
    files: Arc<ArtifactFiles>,
    _tool_snapshot: Option<ArtifactToolSnapshot>,
    request_id: String,
    operation: String,
    request_sha256: String,
    deadline: Instant,
    stopped: Option<ArtifactJobStop>,
    finished: bool,
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
fn canonical_directory(path: &Path) -> Result<()> {
    if !path.is_absolute()
        || fs::canonicalize(path)? != path
        || !fs::symlink_metadata(path)?.is_dir()
    {
        return Err(ArtifactJobError::Invalid(
            "job parent must be a canonical directory",
        ));
    }
    Ok(())
}
fn private_file(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}
fn reserve_files(root: PathBuf) -> io::Result<Arc<ArtifactFiles>> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new().mode(0o700).create(&root)?;
    }
    #[cfg(not(unix))]
    fs::create_dir(&root)?;
    Ok(Arc::new(ArtifactFiles {
        root,
        active: true,
        preserve_after_cleanup_failure: AtomicBool::new(false),
    }))
}
pub(crate) fn bounded_regular_file(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    if !before.is_file() || before.len() > maximum as u64 || fs::canonicalize(path)? != path {
        return Err(ArtifactJobError::Invalid(
            "artifact file is not regular or exceeds its byte budget",
        ));
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() != before.len() {
        return Err(ArtifactJobError::Invalid(
            "artifact file changed before open",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.dev() != metadata.dev() || before.ino() != metadata.ino() {
            return Err(ArtifactJobError::Invalid("artifact file identity changed"));
        }
    }
    let bytes = read_exact_snapshot(&mut file, metadata.len() as usize)?;
    let after = file.metadata()?;
    if bytes.len() > maximum
        || bytes.len() as u64 != metadata.len()
        || after.len() != metadata.len()
        || after.modified()? != metadata.modified()?
    {
        return Err(ArtifactJobError::Invalid(
            "artifact file changed while reading",
        ));
    }
    Ok(bytes)
}

struct PreparedArtifactRequest {
    root: PathBuf,
    bytes: Vec<u8>,
    request_id: String,
    operation: String,
    deadline: Instant,
}

// This phase creates no new namespace or child. Its caller retains the whole
// configuration on error, including the borrowed immutable tool input lease.
fn prepare_artifact_request(
    config: &ArtifactJobConfig,
    request: &mut Value,
) -> Result<PreparedArtifactRequest> {
    if !identifier(&config.job_name)
        || config.timeout.is_zero()
        || config.timeout > Duration::from_secs(1200)
    {
        return Err(ArtifactJobError::Invalid(
            "invalid finite job identity or deadline",
        ));
    }
    canonical_directory(&config.parent)?;
    if let Some(tools) = &config.tool_snapshot {
        tools.verify()?;
    }
    let entry = bounded_regular_file(&config.entrypoint, MAX_ENTRY_BYTES as usize)?;
    if format!("{:x}", Sha256::digest(&entry)) != config.entrypoint_sha256 {
        return Err(ArtifactJobError::Invalid("tool entrypoint pin mismatch"));
    }
    let request_id = request
        .get("requestId")
        .and_then(Value::as_str)
        .filter(|value| identifier(value))
        .ok_or(ArtifactJobError::Invalid("invalid request identity"))?
        .to_owned();
    let operation = request
        .get("op")
        .and_then(Value::as_str)
        .ok_or(ArtifactJobError::Invalid("missing artifact operation"))?
        .to_owned();
    let destination_field = match operation.as_str() {
        "retain-runtime" => "runtime",
        "stage-pack" => "stage",
        _ => return Err(ArtifactJobError::Invalid("unknown artifact operation")),
    };
    if request.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(ArtifactJobError::Invalid(
            "invalid artifact request version",
        ));
    }
    let destination = request
        .get_mut(destination_field)
        .and_then(Value::as_object_mut)
        .ok_or(ArtifactJobError::Invalid(
            "missing artifact operation parameters",
        ))?;
    let root = config.parent.join(&config.job_name);
    let output = root.join("output");
    destination.insert(
        "destination".to_owned(),
        Value::String(
            output
                .to_str()
                .ok_or(ArtifactJobError::Invalid("job directory must be UTF-8"))?
                .to_owned(),
        ),
    );
    let bytes = serde_json::to_vec(request)?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(ArtifactJobError::Invalid("request exceeds its byte budget"));
    }
    let deadline = Instant::now()
        .checked_add(config.timeout)
        .ok_or(ArtifactJobError::Invalid("job deadline overflow"))?;
    Ok(PreparedArtifactRequest {
        root,
        bytes,
        request_id,
        operation,
        deadline,
    })
}

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    private_file(path)?.write_all(bytes)?;
    Ok(())
}

impl ArtifactJob {
    /// The request is private owner input, never an unvalidated HTTP command.
    /// This function owns and overrides its output destination so cancellation
    /// cannot clean or publish a caller-selected directory. Every error after
    /// reservation returns the actual cleanup owner, never just its pathname.
    pub fn spawn(config: ArtifactJobConfig, request: Value) -> ConstructionResult<Self> {
        Self::spawn_with_writers(config, request, write_private_bytes, write_private_bytes)
    }

    fn spawn_with_writers(
        config: ArtifactJobConfig,
        mut request: Value,
        write_request: impl FnOnce(&Path, &[u8]) -> Result<()>,
        write_owner: impl FnOnce(&Path, &[u8]) -> Result<()>,
    ) -> ConstructionResult<Self> {
        let prepared = match prepare_artifact_request(&config, &mut request) {
            Ok(prepared) => prepared,
            Err(cause) => return Err(ArtifactConstructionError::config(cause, config)),
        };
        let PreparedArtifactRequest {
            root,
            bytes,
            request_id,
            operation,
            deadline,
        } = prepared;
        // create_dir, rather than create_dir_all, is an exclusive reservation.
        // No preexisting directory becomes this job's cleanup responsibility.
        let files = match reserve_files(root) {
            Ok(files) => files,
            Err(error) => return Err(ArtifactConstructionError::config(error.into(), config)),
        };
        let input = files.root.join("request.json");
        if let Err(cause) = write_request(&input, &bytes) {
            return Err(ArtifactConstructionError::files(
                cause,
                files,
                config.tool_snapshot,
            ));
        }
        let result = files.root.join("result.json");
        let mut command = Command::new(&config.node_bin);
        command
            .arg(&config.entrypoint)
            .arg("--request")
            .arg(&input)
            .arg("--result")
            .arg(result)
            .current_dir(&config.parent)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let request_sha256 = format!("{:x}", Sha256::digest(&bytes));
        let child = match OwnedProcess::spawn_finite(&mut command) {
            Ok(child) => child,
            Err(failure) => {
                let (source, owner) = failure.into_parts();
                if let Some(child) = owner {
                    let job = Self::from_owned_process(
                        *child,
                        files,
                        config.tool_snapshot,
                        request_id,
                        operation,
                        request_sha256,
                        deadline,
                    );
                    return Err(ArtifactConstructionError::job(source.into(), job));
                }
                return Err(ArtifactConstructionError::files(
                    source.into(),
                    files,
                    config.tool_snapshot,
                ));
            }
        };
        let job = Self::from_owned_process(
            child,
            files,
            config.tool_snapshot,
            request_id,
            operation,
            request_sha256,
            deadline,
        );
        // Construct the complete guard before the first fallible post-spawn
        // write, so a marker failure still uses the verified cleanup path.
        let owner = serde_json::to_vec(&serde_json::json!({"schemaVersion":1,
            "requestId":job.request_id,"requestSha256":job.request_sha256,
            "processId":job.process_id(),"entrypointSha256":config.entrypoint_sha256,
            "authority":"static-artifact-only","runtimeReady":false,"presentedReady":false}));
        let owner = match owner {
            Ok(owner) => owner,
            Err(error) => return Err(ArtifactConstructionError::job(error.into(), job)),
        };
        if let Err(cause) = write_owner(&job.files.root.join("owner.json"), &owner) {
            return Err(ArtifactConstructionError::job(cause, job));
        }
        Ok(job)
    }

    // Nonfallible assembly is shared by successful spawn and an initializer
    // failure that already owns a real child. Both retain the same bindings,
    // exact tool input lease, private files and finite cleanup implementation.
    fn from_owned_process(
        child: OwnedProcess,
        files: Arc<ArtifactFiles>,
        tools: Option<ArtifactToolSnapshot>,
        request_id: String,
        operation: String,
        request_sha256: String,
        deadline: Instant,
    ) -> Self {
        Self {
            child,
            files,
            _tool_snapshot: tools,
            request_id,
            operation,
            request_sha256,
            deadline,
            stopped: None,
            finished: false,
        }
    }

    pub fn process_id(&self) -> u32 {
        self.child.id()
    }
    pub fn files(&self) -> &Arc<ArtifactFiles> {
        &self.files
    }
    /// Original bytes' constructor binding; no JSON re-encoding or reread.
    /// Order is request identity, operation, original request SHA-256.
    pub(crate) fn request_binding(&self) -> (&str, &str, &str) {
        (&self.request_id, &self.operation, &self.request_sha256)
    }

    pub fn cancel(&mut self, reason: ArtifactJobStop) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        self.stopped.get_or_insert(reason);
        self.child.terminate_finite()?;
        Ok(())
    }
    /// Nonblocking on process shutdown. Files remain charged/owned until the
    /// owned Unix group / Windows job is empty, including after its root exits.
    pub fn poll(&mut self) -> Result<Option<ArtifactJobCompletion>> {
        if self.finished {
            return Ok(None);
        }
        if Instant::now() >= self.deadline {
            self.cancel(ArtifactJobStop::TimedOut)?;
        }
        let Some(exit_status) = self.child.poll_finite_exit()? else {
            return Ok(None);
        };
        self.finished = true;
        let result = bounded_regular_file(&self.files.root.join("result.json"), MAX_RESULT_BYTES)
            .map(Arc::new);
        Ok(Some(ArtifactJobCompletion {
            files: self.files.clone(),
            request_id: self.request_id.clone(),
            operation: self.operation.clone(),
            request_sha256: self.request_sha256.clone(),
            exit_status,
            stopped: self.stopped,
            result,
        }))
    }
    /// Final shutdown barrier. Call outside the socket/event-loop turn.
    /// If false or error, keep this owner and its file reservation and retry.
    pub fn shutdown(&mut self) -> Result<bool> {
        if self.finished {
            return Ok(true);
        }
        self.cancel(ArtifactJobStop::Cancelled)?;
        Ok(self.child.stop_finite(Duration::from_millis(500))?)
    }
}

impl Drop for ArtifactJob {
    fn drop(&mut self) {
        if !matches!(self.shutdown(), Ok(true)) {
            // Never remove an unresolved child's working files. This is an
            // exceptional abandonment, not a cleanup receipt or released disk
            // reservation; the explicit owner loop must retain/retry instead.
            self.files
                .preserve_after_cleanup_failure
                .store(true, Ordering::Release);
            if let Some(tools) = &self._tool_snapshot {
                tools
                    .files
                    .preserve_after_cleanup_failure
                    .store(true, Ordering::Release);
            }
            eprintln!(
                "weapp-simulator: unresolved artifact cleanup; retained {} for recovery",
                self.files.root.display()
            );
        }
    }
}

// Test-only construction must stay below this private-field boundary. The
// sibling runtime-receipt tests can request one fixed transport child, never
// choose a production entrypoint, command, request or tool_snapshot override.
#[cfg(all(test, unix))]
pub(crate) mod runtime_receipt_test_support {
    use super::*;

    pub(crate) const REQUEST_ID: &str = "synthetic-runtime-1";
    pub(crate) const JOB_NAME: &str = "receipt-owned-job";
    const SCRIPT: &[u8] = b"exec /bin/cat \"$0.result\" > \"$4\"\n";

    /// The caller owns a fresh fixture parent and its helper inputs. Spawn
    /// returns the actual ArtifactJob (or its actual construction recovery),
    /// so binding and polling exercise the production ownership path.
    pub(crate) fn spawn(
        parent: &Path,
        original_result: &[u8],
    ) -> std::result::Result<ArtifactJob, ArtifactConstructionError> {
        canonical_directory(parent)?;
        if original_result.len() > MAX_RESULT_BYTES {
            return Err(ArtifactJobError::Invalid("fixture result byte budget exceeded").into());
        }
        let entrypoint = parent.join("runtime-receipt-result-writer.sh");
        let payload = parent.join("runtime-receipt-result-writer.sh.result");
        // create_new + 0600; never overwrite inputs of another fixture/job.
        write_private_bytes(&payload, original_result)?;
        write_private_bytes(&entrypoint, SCRIPT)?;
        ArtifactJob::spawn(
            ArtifactJobConfig {
                node_bin: PathBuf::from("/bin/sh"),
                entrypoint,
                entrypoint_sha256: format!("{:x}", Sha256::digest(SCRIPT)),
                tool_snapshot: None,
                parent: parent.to_path_buf(),
                job_name: JOB_NAME.into(),
                timeout: Duration::from_secs(5),
            },
            serde_json::json!({"schemaVersion":1,"requestId":REQUEST_ID,
                "op":"retain-runtime","runtime":{}}),
        )
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    // These are transport/process tests using an explicitly fake shell child.
    // They do not execute the Node artifact assembler or a Worker runtime.
    struct Fixture {
        root: PathBuf,
        entry: PathBuf,
    }
    impl Fixture {
        fn new(script: &str) -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::temp_dir().join(format!(
                "browser-artifact-job-{}-{nonce}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            let root = fs::canonicalize(root).unwrap();
            let entry = root.join("fake-child.sh");
            fs::write(&entry, script).unwrap();
            Self { root, entry }
        }
        fn config(&self) -> ArtifactJobConfig {
            ArtifactJobConfig {
                node_bin: PathBuf::from("/bin/sh"),
                entrypoint: self.entry.clone(),
                entrypoint_sha256: format!("{:x}", Sha256::digest(fs::read(&self.entry).unwrap())),
                tool_snapshot: None,
                parent: self.root.clone(),
                job_name: "one-job".into(),
                timeout: Duration::from_secs(5),
            }
        }
        fn request(&self) -> Value {
            json!({"schemaVersion":1,"requestId":"job-1","op":"stage-pack","runtime":{},
                "stage":{"destination":"/must-never-be-owned"}})
        }
        fn spawn(&self) -> ArtifactJob {
            ArtifactJob::spawn(self.config(), self.request()).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
    fn completed(job: &mut ArtifactJob) -> ArtifactJobCompletion {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if let Some(result) = job.poll().unwrap() {
                return result;
            }
            assert!(Instant::now() < deadline, "owned job did not terminate");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    const STATIC: &str = "printf '%s' '{\"schemaVersion\":1,\"requestId\":\"job-1\",\"op\":\"stage-pack\",\"status\":\"staged-static\",\"runtimeReady\":false,\"presentedReady\":false}' > \"$4\"\n";

    #[test]
    fn success_is_static_only_and_files_follow_completion_lease() {
        let fixture = Fixture::new(STATIC);
        let mut job = fixture.spawn();
        let root = job.files().root().to_owned();
        let request: Value =
            serde_json::from_slice(&fs::read(root.join("request.json")).unwrap()).unwrap();
        assert_eq!(
            request["stage"]["destination"],
            root.join("output").to_str().unwrap()
        );
        let completion = completed(&mut job);
        assert_eq!(completion.static_result().unwrap()["runtimeReady"], false);
        assert!(job.poll().unwrap().is_none());
        drop(job);
        assert!(
            root.is_dir(),
            "completion must retain its files after the job is dropped"
        );
        drop(completion);
        assert!(!root.exists());
    }

    #[test]
    fn exact_request_and_operation_bind_the_result() {
        for changed in [
            STATIC.replace("job-1", "wrong-job"),
            STATIC.replace("stage-pack", "retain-runtime"),
            STATIC.replace("runtimeReady\":false", "runtimeReady\":true"),
        ] {
            let fixture = Fixture::new(&changed);
            let mut job = fixture.spawn();
            let completion = completed(&mut job);
            assert!(completion.static_result().is_err());
        }
    }

    #[test]
    fn failed_exit_and_malformed_or_oversize_results_never_become_candidates() {
        for script in [
            format!("{STATIC}exit 1\n"),
            "printf broken > \"$4\"\n".into(),
            "dd if=/dev/zero of=\"$4\" bs=1048576 count=17 2>/dev/null\n".into(),
            "exit 0\n".into(),
        ] {
            let fixture = Fixture::new(&script);
            let mut job = fixture.spawn();
            assert!(completed(&mut job).static_result().is_err());
        }
    }

    #[test]
    fn exclusive_job_reservation_never_deletes_preexisting_files() {
        let fixture = Fixture::new(STATIC);
        let existing = fixture.root.join("one-job");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("sentinel"), b"unrelated").unwrap();
        assert!(ArtifactJob::spawn(fixture.config(), fixture.request()).is_err());
        assert_eq!(fs::read(existing.join("sentinel")).unwrap(), b"unrelated");
    }

    #[test]
    fn invalid_request_and_entry_pin_fail_before_reserving_files() {
        let fixture = Fixture::new(STATIC);
        let mut config = fixture.config();
        config.entrypoint_sha256 = "0".repeat(64);
        assert!(ArtifactJob::spawn(config, fixture.request()).is_err());
        for request in [
            json!({"schemaVersion":1,"requestId":"job-1","op":"start-runtime","stage":{}}),
            json!({"schemaVersion":1,"requestId":"../wrong","op":"stage-pack","stage":{}}),
            json!({"schemaVersion":1,"requestId":"job-1","op":"stage-pack","stage":{"large":"x".repeat(MAX_REQUEST_BYTES)}}),
        ] {
            assert!(ArtifactJob::spawn(fixture.config(), request).is_err());
        }
        assert!(!fixture.root.join("one-job").exists());
    }

    #[test]
    fn cancellation_supersession_and_deadline_keep_files_until_reaped() {
        for reason in [
            ArtifactJobStop::Cancelled,
            ArtifactJobStop::Superseded,
            ArtifactJobStop::TimedOut,
        ] {
            let fixture = Fixture::new("sleep 30 &\nwait\n");
            let mut config = fixture.config();
            if reason == ArtifactJobStop::TimedOut {
                config.timeout = Duration::from_millis(1);
            }
            let mut job = ArtifactJob::spawn(config, fixture.request()).unwrap();
            let root = job.files().root().to_owned();
            if reason != ArtifactJobStop::TimedOut {
                job.cancel(reason).unwrap();
            }
            assert!(root.is_dir());
            let completion = completed(&mut job);
            assert_eq!(completion.stopped, Some(reason));
            assert!(completion.static_result().is_err());
            drop(job);
            assert!(root.is_dir());
            drop(completion);
            assert!(!root.exists());
        }
    }

    #[test]
    fn late_complete_result_after_explicit_cancellation_cannot_authorize() {
        // Gate this child's leader after publishing the result. This case
        // tests cancellation authority; natural-exit/group-retirement races
        // have separate process-ownership coverage. No writer releases the
        // FIFO, so only the owned cancellation can finish this child.
        let fixture = Fixture::new(&format!(
            "{STATIC}mkfifo \"$4.gate\" && printf ready > \"$4.ready\" && read -r release < \"$4.gate\"\n"
        ));
        let mut job = fixture.spawn();
        // A cancellation remains authoritative even if the child has already
        // written a full result before the next owner-loop poll.
        let expected_result = br#"{"schemaVersion":1,"requestId":"job-1","op":"stage-pack","status":"staged-static","runtimeReady":false,"presentedReady":false}"#;
        let deadline = Instant::now() + Duration::from_secs(5);
        while fs::read(job.files().root().join("result.json"))
            .ok()
            .as_deref()
            != Some(expected_result.as_slice())
            || fs::read(job.files().root().join("result.json.ready"))
                .ok()
                .as_deref()
                != Some(b"ready".as_slice())
        {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        job.cancel(ArtifactJobStop::Superseded).unwrap();
        let completion = completed(&mut job);
        assert_eq!(completion.stopped, Some(ArtifactJobStop::Superseded));
        assert_eq!(
            completion.result.as_ref().unwrap().as_slice(),
            expected_result
        );
        assert!(completion.static_result().is_err());
    }

    #[test]
    fn successful_root_immediately_retires_its_group_and_preserves_another_job() {
        let sentinel_fixture = Fixture::new("sleep 30 &\nwait\n");
        let mut sentinel = sentinel_fixture.spawn();
        let fixture = Fixture::new(&format!("{STATIC}sleep 30 &\nexit 0\n"));
        let mut job = fixture.spawn();
        let started = Instant::now();
        let completion = completed(&mut job);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "successful root must not leave its group until the five-second deadline"
        );
        assert_eq!(completion.stopped, None);
        assert!(completion.static_result().is_ok());
        assert!(
            sentinel.poll().unwrap().is_none(),
            "cleanup must remain inside its exact group"
        );
        sentinel.cancel(ArtifactJobStop::Cancelled).unwrap();
        assert_eq!(
            completed(&mut sentinel).stopped,
            Some(ArtifactJobStop::Cancelled)
        );
    }

    #[test]
    fn source_symlinks_and_result_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;
        let fixture = Fixture::new(STATIC);
        let linked = fixture.root.join("linked.sh");
        symlink(&fixture.entry, &linked).unwrap();
        let mut config = fixture.config();
        config.entrypoint = linked;
        assert!(ArtifactJob::spawn(config, fixture.request()).is_err());
        let fixture = Fixture::new("ln -s \"$2\" \"$4\"\n");
        assert!(completed(&mut fixture.spawn()).result.is_err());
    }

    #[test]
    fn embedded_tools_have_an_exclusive_complete_static_closure() {
        let fixture = Fixture::new(STATIC);
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "tools").unwrap();
        assert_eq!(
            EMBEDDED_TOOL_FILES
                .iter()
                .map(|(path, _)| *path)
                .collect::<Vec<_>>(),
            vec![
                "scripts/browser-dev-artifacts-cli.mjs",
                "scripts/browser-dev-artifacts.mjs",
                "scripts/build-web-wasm.mjs",
                "scripts/generated-package-closure.mjs",
                "scripts/lib/showcase-policy.mjs",
                "examples/hosts/web-wasm/renderer-dependency-pins.json",
            ]
        );
        for (path, expected) in EMBEDDED_TOOL_FILES {
            assert_eq!(fs::read(tools.root().join(path)).unwrap(), *expected);
        }
        tools.verify().unwrap();
        assert!(ArtifactToolSnapshot::stage(&fixture.root, "tools").is_err());
        tools.verify().unwrap();
        let marker = tools.root().join("tool-snapshot.json");
        let manifest: Value = serde_json::from_slice(&fs::read(marker).unwrap()).unwrap();
        assert_eq!(
            manifest["files"].as_array().unwrap().len(),
            EMBEDDED_TOOL_FILES.len()
        );
        let root = tools.root().to_owned();
        let config = ArtifactJobConfig::new(
            "node".into(),
            tools.clone(),
            fixture.root.clone(),
            "job".into(),
            Duration::from_secs(5),
        );
        drop(tools);
        assert!(
            root.is_dir(),
            "configuration retains its exact tool namespace"
        );
        drop(config);
        assert!(!root.exists());
    }

    #[test]
    fn changed_embedded_dependency_fails_before_any_child_or_job_namespace() {
        let fixture = Fixture::new(STATIC);
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "tools").unwrap();
        fs::write(
            tools.root().join("scripts/browser-dev-artifacts.mjs"),
            "export {}\n",
        )
        .unwrap();
        let config = ArtifactJobConfig::new(
            "node".into(),
            tools,
            fixture.root.clone(),
            "job".into(),
            Duration::from_secs(5),
        );
        assert!(ArtifactJob::spawn(config, fixture.request()).is_err());
        assert!(!fixture.root.join("job").exists());
    }

    fn injected_failure(message: &'static str) -> ArtifactJobError {
        io::Error::new(io::ErrorKind::PermissionDenied, message).into()
    }

    fn partial_tool_failure(fixture: &Fixture, name: &str) -> ArtifactConstructionError {
        ArtifactToolSnapshot::stage_with(&fixture.root, name, |files| {
            write_private_bytes(&files.root.join("partial-member"), b"owned partial bytes")?;
            Err(injected_failure("injected tool member write failure"))
        })
        .unwrap_err()
    }

    fn clean_failure(failure: &mut ArtifactConstructionError) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if failure.retry_cleanup().unwrap() {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "construction recovery did not retire its actual owner"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn partial_tool_fill_and_cleanup_failure_return_the_retry_owner() {
        let fixture = Fixture::new(STATIC);
        let mut failure = partial_tool_failure(&fixture, "partial-tools");
        let root = failure.retained_root().unwrap().to_owned();
        let original_cause = failure.cause().to_string();
        assert!(failure.requires_cleanup());
        assert_eq!(
            fs::read(root.join("partial-member")).unwrap(),
            b"owned partial bytes"
        );
        let cleanup = failure.retry_cleanup_with(
            |_| {
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "injected remove failure",
                ))
            },
            |_| panic!("no process exists during a tool fill failure"),
        );
        assert!(cleanup.is_err());
        assert!(failure.requires_cleanup());
        assert_eq!(failure.retained_root(), Some(root.as_path()));
        assert_eq!(failure.cause().to_string(), original_cause);
        assert!(root.exists());
        clean_failure(&mut failure);
        assert!(!root.exists());
        assert!(!failure.requires_cleanup());
        assert!(
            failure.retry_cleanup().unwrap(),
            "confirmed cleanup is idempotent"
        );
    }

    #[test]
    fn an_unretired_file_owner_cannot_be_accepted_as_a_cleanup_receipt() {
        let fixture = Fixture::new(STATIC);
        let mut failure = partial_tool_failure(&fixture, "false-cleanup-receipt");
        let root = failure.retained_root().unwrap().to_owned();
        assert!(failure
            .retry_cleanup_with(|_| Ok(()), |_| unreachable!())
            .is_err());
        assert!(failure.requires_cleanup());
        assert!(root.exists());
        clean_failure(&mut failure);
    }

    #[test]
    fn exclusive_construction_files_wait_for_an_actual_borrower_to_release() {
        let fixture = Fixture::new(STATIC);
        let mut failure = partial_tool_failure(&fixture, "borrowed-partial-files");
        let root = failure.retained_root().unwrap().to_owned();
        let borrowed = match &failure.recovery {
            ArtifactConstructionRecovery::Files { files, .. } => files.clone(),
            other => panic!("unexpected recovery: {other:?}"),
        };
        assert!(!failure.retry_cleanup().unwrap());
        assert!(root.exists());
        drop(borrowed);
        clean_failure(&mut failure);
        assert!(!root.exists());
    }

    #[test]
    fn preflight_rejection_returns_last_tool_lease_and_failed_cleanup_can_retry() {
        let fixture = Fixture::new(STATIC);
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "preflight-tools").unwrap();
        let tool_root = tools.root().to_owned();
        let config = ArtifactJobConfig::new(
            "must-not-run".into(),
            tools,
            fixture.root.clone(),
            "../rejected".into(),
            Duration::from_secs(5),
        );
        let mut failure = ArtifactJob::spawn(config, fixture.request()).unwrap_err();
        assert!(matches!(
            &failure.recovery,
            ArtifactConstructionRecovery::Config(_)
        ));
        assert_eq!(failure.retained_root(), Some(tool_root.as_path()));
        assert!(failure.retained_process_id().is_none());
        assert!(failure
            .retry_cleanup_with(
                |_| Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "last tool cleanup denied"
                )),
                |_| unreachable!(),
            )
            .is_err());
        assert_eq!(failure.retained_root(), Some(tool_root.as_path()));
        assert!(tool_root.exists());
        clean_failure(&mut failure);
        assert!(!tool_root.exists());
    }

    #[test]
    fn two_failed_configs_release_shared_tools_without_waiting_on_each_other() {
        let fixture = Fixture::new(STATIC);
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "shared-tools").unwrap();
        let tool_root = tools.root().to_owned();
        let first = ArtifactJobConfig::new(
            "must-not-run".into(),
            tools.clone(),
            fixture.root.clone(),
            "../first".into(),
            Duration::from_secs(5),
        );
        let second = ArtifactJobConfig::new(
            "must-not-run".into(),
            tools,
            fixture.root.clone(),
            "../second".into(),
            Duration::from_secs(5),
        );
        let mut first_error = ArtifactJob::spawn(first, fixture.request()).unwrap_err();
        let mut second_error = ArtifactJob::spawn(second, fixture.request()).unwrap_err();
        assert!(first_error
            .retry_cleanup_with(
                |_| panic!("a borrowed shared tool namespace must not be removed"),
                |_| unreachable!(),
            )
            .unwrap());
        assert!(!first_error.requires_cleanup());
        assert!(
            tool_root.exists(),
            "first receipt releases a borrow, not the shared directory"
        );
        assert!(second_error
            .retry_cleanup_with(
                |_| Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "last shared tool cleanup denied"
                )),
                |_| unreachable!(),
            )
            .is_err());
        assert!(second_error.requires_cleanup());
        assert!(tool_root.exists());
        clean_failure(&mut second_error);
        assert!(!tool_root.exists());
    }

    #[test]
    fn request_write_failure_returns_private_files_without_spawning() {
        let fixture = Fixture::new(STATIC);
        let mut failure = ArtifactJob::spawn_with_writers(
            fixture.config(),
            fixture.request(),
            |path, _| {
                write_private_bytes(path, b"partial request")?;
                Err(injected_failure("injected request write failure"))
            },
            |_, _| panic!("owner writer must not run after request failure"),
        )
        .unwrap_err();
        let root = failure.retained_root().unwrap().to_owned();
        assert!(failure.retained_process_id().is_none());
        assert_eq!(
            fs::read(root.join("request.json")).unwrap(),
            b"partial request"
        );
        assert!(failure.requires_cleanup());
        clean_failure(&mut failure);
        assert!(!root.exists());
    }

    #[test]
    fn reservation_collision_returns_tools_and_never_adopts_existing_namespace() {
        let fixture = Fixture::new(STATIC);
        let existing = fixture.root.join("reserved-job");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("sentinel"), b"unrelated existing files").unwrap();
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "collision-tools").unwrap();
        let tool_root = tools.root().to_owned();
        let config = ArtifactJobConfig::new(
            "must-not-run".into(),
            tools,
            fixture.root.clone(),
            "reserved-job".into(),
            Duration::from_secs(5),
        );
        let mut failure = ArtifactJob::spawn(config, fixture.request()).unwrap_err();
        assert!(matches!(
            &failure.recovery,
            ArtifactConstructionRecovery::Config(_)
        ));
        assert_eq!(failure.retained_tool_root(), Some(tool_root.as_path()));
        assert!(failure.retained_process_id().is_none());
        clean_failure(&mut failure);
        assert!(!tool_root.exists());
        assert_eq!(
            fs::read(existing.join("sentinel")).unwrap(),
            b"unrelated existing files"
        );
    }

    #[test]
    fn missing_executable_preserves_its_reserved_files_until_explicit_cleanup() {
        let fixture = Fixture::new(STATIC);
        let mut config = fixture.config();
        config.node_bin = fixture.root.join("no-such-executable");
        let mut failure = ArtifactJob::spawn(config, fixture.request()).unwrap_err();
        let root = failure.retained_root().unwrap().to_owned();
        assert!(failure.retained_process_id().is_none());
        assert!(root.join("request.json").is_file());
        clean_failure(&mut failure);
        assert!(!root.exists());
    }

    #[test]
    fn owner_write_failure_returns_the_actual_child_and_both_namespace_leases() {
        use std::cell::Cell;
        let fixture = Fixture::new("sleep 30 &\nwait\n");
        let tools = ArtifactToolSnapshot::stage(&fixture.root, "live-child-tools").unwrap();
        let tool_root = tools.root().to_owned();
        // The fake shell transport remains cfg(test)-only. Its config still
        // owns a real embedded tool lease so both resource lifetimes are tested.
        let mut config = fixture.config();
        config.tool_snapshot = Some(tools);
        let observed_pid = Cell::new(0_u32);
        let mut failure = ArtifactJob::spawn_with_writers(
            config,
            fixture.request(),
            write_private_bytes,
            |path, bytes| {
                let marker: Value = serde_json::from_slice(bytes)?;
                observed_pid.set(u32::try_from(marker["processId"].as_u64().unwrap()).unwrap());
                write_private_bytes(path, b"partial owner")?;
                Err(injected_failure("injected post-spawn owner write failure"))
            },
        )
        .unwrap_err();
        let root = failure.retained_root().unwrap().to_owned();
        assert!(observed_pid.get() > 0);
        assert_eq!(failure.retained_process_id(), Some(observed_pid.get()));
        assert!(failure
            .retry_cleanup_with(
                |_| panic!("pending shutdown must not remove either namespace"),
                |_| Ok(false),
            )
            .is_ok_and(|complete| !complete));
        assert!(failure
            .retry_cleanup_with(
                |_| panic!("failed shutdown must not remove either namespace"),
                |_| Err(injected_failure("injected shutdown observation failure")),
            )
            .is_err());
        assert_eq!(failure.retained_process_id(), Some(observed_pid.get()));
        assert!(root.exists());
        assert!(tool_root.exists());
        clean_failure(&mut failure);
        assert!(!root.exists());
        assert!(!tool_root.exists());
    }

    #[test]
    fn construction_error_keeps_a_small_nonrecursive_source_chain() {
        assert!(
            std::mem::size_of::<ArtifactConstructionError>() <= 128,
            "large process/config owners belong behind Box"
        );
        let failure = ArtifactConstructionError::from(injected_failure("initial cause"));
        let source = std::error::Error::source(&failure).unwrap();
        assert!(source.downcast_ref::<ArtifactJobError>().is_some());
        assert!(source
            .source()
            .unwrap()
            .downcast_ref::<io::Error>()
            .is_some());
        assert!(!failure.requires_cleanup());
        assert!(failure.retained_root().is_none());
    }
}
