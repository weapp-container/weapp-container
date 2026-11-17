//! Private raw/portable owners sharing the aggregate store's original Ledger.
//! No HTTP, current-site, activation, Worker, renderer or GPU authority here.

use super::{AdmissionError, Capacity, Ledger, NamespaceId, Reservation};
use crate::dev::{PortablePackReport, PortablePublicationToken};
use crate::owned_process::OwnedProcess;
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Command, ExitStatus};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[path = "source_watcher.rs"]
mod source_watcher;
use source_watcher::BoundSourceWatcher;

#[cfg(test)]
#[path = "source_credit_tests.rs"]
mod tests;

const MIB: u64 = 1024 * 1024;
const CONTROL_BYTES: usize = 16 * 1024;
const SOURCE_SLOTS: usize = 8;
const MAX_SOURCE_BORROWERS: usize = 32;
const VERSION: &str = "2.0";
const RAW_PAYLOAD_BYTES: u64 = 256 * MIB;
const PACK_PAYLOAD_BYTES: u64 = 512 * MIB;
const SOURCE_CONTROL_DISK_BYTES: u64 = 64 * 1024;
const RAW_CHARGE: Capacity = Capacity {
    memory_bytes: 32 * MIB,
    disk_bytes: RAW_PAYLOAD_BYTES + SOURCE_CONTROL_DISK_BYTES,
    files: 8196,
    directories: 1028,
    namespaces: 1,
    finite_jobs: 0,
};
const PACK_CHARGE: Capacity = Capacity {
    memory_bytes: 256 * MIB,
    disk_bytes: PACK_PAYLOAD_BYTES + SOURCE_CONTROL_DISK_BYTES,
    files: 16_392,
    directories: 2050,
    namespaces: 1,
    finite_jobs: 1,
};

impl Ledger {
    // This is the SAME ledger and selected per-instance limit as runtime jobs.
    // Source admission cannot silently enlarge that limit to bypass pressure.
    pub(super) fn reserve_source(
        &mut self,
        amount: Capacity,
    ) -> Result<Reservation, AdmissionError> {
        let used = self
            .used
            .checked_add(amount)
            .ok_or(AdmissionError::Capacity)?;
        if !used.within(self.limit) {
            return Err(AdmissionError::Capacity);
        }
        let serial = self
            .next_serial
            .checked_add(1)
            .ok_or(AdmissionError::IdentityExhausted)?;
        self.next_serial = serial;
        self.used = used;
        Ok(Reservation {
            id: NamespaceId {
                store: self.store,
                serial,
            },
            remaining: amount,
            active: true,
        })
    }

    fn source_process_retired(&mut self, token: &mut Reservation) -> io::Result<()> {
        if !token.active || token.id.store != self.store || token.remaining.finite_jobs != 1 {
            return Err(io::Error::other(
                "source finite slot identity/state mismatch",
            ));
        }
        let remaining = self
            .used
            .finite_jobs
            .checked_sub(1)
            .ok_or_else(|| io::Error::other("source finite slot underflow"))?;
        self.used.finite_jobs = remaining;
        token.remaining.finite_jobs = 0;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Raw,
    Portable,
}

#[derive(Debug)]
struct ActualSourceFiles {
    root: PathBuf,
    created: bool,
    retired: bool,
}
impl ActualSourceFiles {
    fn create(&mut self) -> io::Result<()> {
        fs::create_dir(&self.root)?; // NEVER remove an existing namespace.
        self.created = true;
        Ok(())
    }
    fn cleanup(&mut self) -> io::Result<()> {
        if self.created && !self.retired {
            // Only this object's successful exclusive create confers deletion.
            match fs::remove_dir_all(&self.root) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        self.retired = true;
        Ok(())
    }
}

#[derive(Debug)]
enum Binding {
    Raw { compiler: String, sequence: u64 },
    Portable(PortablePackReport), // token is metadata, never input authority
}

#[derive(Debug)]
struct SourceOwner {
    files: ActualSourceFiles,
    token: Option<Reservation>,
    binding: Option<Binding>,
}

/// A real borrower. No Clone, Deserialize, from_path, token lookup constructor,
/// mutable files, raw Arc or reservation accessor is provided.
pub(crate) struct SourceInputLease {
    owner: Arc<SourceOwner>,
}
impl std::fmt::Debug for SourceInputLease {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourceInputLease")
            .field("namespace", &self.namespace())
            .finish()
    }
}
impl SourceInputLease {
    pub(crate) fn namespace(&self) -> NamespaceId {
        self.owner
            .token
            .as_ref()
            .expect("borrowable owner is charged")
            .id
    }
    pub(crate) fn directory(&self) -> PathBuf {
        self.owner.files.root.join("pack")
    }
    pub(crate) fn compiler(&self) -> &str {
        match self
            .owner
            .binding
            .as_ref()
            .expect("borrowable owner is frozen")
        {
            Binding::Raw { compiler, .. } => compiler,
            Binding::Portable(report) => &report.compiler_commit,
        }
    }
    pub(crate) fn raw_sequence(&self) -> Option<u64> {
        match self.owner.binding.as_ref() {
            Some(Binding::Raw { sequence, .. }) => Some(*sequence),
            _ => None,
        }
    }
    #[cfg(test)]
    pub(crate) fn portable(&self) -> Option<&PortablePackReport> {
        match self.owner.binding.as_ref() {
            Some(Binding::Portable(report)) => Some(report),
            _ => None,
        }
    }
}

/// A portable-only input from this registry's actual completed pack. Keeping
/// this value keeps the original SourceOwner and its reservation alive. There
/// is no path/report constructor or detached Arc that could outlive the charge.
#[derive(Debug)]
pub(crate) struct PortableInputLease {
    source: SourceInputLease,
}

impl PortableInputLease {
    pub(crate) fn namespace(&self) -> NamespaceId {
        self.source.namespace()
    }

    pub(crate) fn report(&self) -> &PortablePackReport {
        match self.source.owner.binding.as_ref() {
            Some(Binding::Portable(report)) => report,
            _ => unreachable!("portable lease is minted only for a frozen pack"),
        }
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.report().pack_directory
    }
}

#[derive(Debug)]
pub(crate) struct PackSourceInput {
    pub(crate) raw: SourceInputLease,
}

#[derive(Debug)]
pub(crate) struct PackStart {
    pub(crate) node_bin: PathBuf,
    pub(crate) packer: PathBuf,
    pub(crate) revision: u64,
    pub(crate) route: Option<String>,
    pub(crate) publication_token: PortablePublicationToken,
    pub(crate) pack_timeout: Duration,
    // This first slice does not freeze the modern project/dependency closure.
    // Reject it explicitly; never silently compile it as a raw-only app.
    pub(crate) modern_project_requested: bool,
}

#[derive(Debug)]
pub(crate) struct SourceStartRejection {
    pub(crate) cause: AdmissionError,
    pub(crate) inputs: Option<PackSourceInput>,
}

#[derive(Debug)]
struct PackWriter {
    actual: Option<Box<OwnedProcess>>,
    barrier: bool, // private; set only by real finite barrier/no-child recovery
    intent: PackStart,
    started_at: Instant,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SourceStep {
    Issued,
    Writing,
    Ready,
    Failed,
    CleanupPending,
    Released,
}

#[derive(Debug)]
struct SourceEntry {
    id: NamespaceId,
    kind: Kind,
    owner: Arc<SourceOwner>,
    // A raw grant can be cleaned only after atomic revoke or validated done ack.
    raw_writer_authority: bool,
    writer: Option<PackWriter>,
    inputs: Option<PackSourceInput>,
    step: SourceStep,
    retired: bool,
    diagnostic: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyLimits {
    bytes: String,
    files: u32,
    directories: u32,
    depth: u32,
    path_bytes: u32,
    file_bytes: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreditGrant<'a> {
    protocol_version: &'static str,
    run_id: &'a str,
    credit_id: &'a str,
    limits: CopyLimits,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Inventory {
    bytes: String,
    files: u32,
    directories: u32,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawResult {
    protocol_version: String,
    run_id: String,
    credit_id: String,
    sequence: String,
    kind: String,
    writer_done: bool,
    compiler_commit: Option<String>,
    inventory: Option<Inventory>,
    message: Option<String>,
}
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreditStatus {
    pub(crate) protocol_version: String,
    pub(crate) run_id: String,
    pub(crate) sequence: String,
    pub(crate) kind: String,
    pub(crate) credit_id: Option<String>,
    pub(crate) compiler_commit: Option<String>,
    pub(crate) message: Option<String>,
}

fn decimal(value: &str) -> io::Result<u64> {
    if value.is_empty()
        || value.len() > 20
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(io::Error::other("invalid exact source sequence/size"));
    }
    value.parse().map_err(io::Error::other)
}
fn bounded_message(message: impl std::fmt::Display) -> String {
    let mut text = message.to_string();
    if text.len() > 4096 {
        let mut boundary = 4096;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    text
}
fn bytes_at(path: &Path) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > CONTROL_BYTES as u64
    {
        return Err(io::Error::other(
            "source control is not a bounded regular file",
        ));
    }
    let mut reader = File::open(path)?;
    let actual = reader.metadata()?;
    if actual.len() != metadata.len()
        || !actual.is_file()
        || actual.modified()? != metadata.modified()?
    {
        return Err(io::Error::other("source control changed while opening"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if actual.dev() != metadata.dev() || actual.ino() != metadata.ino() {
            return Err(io::Error::other("source control handle identity changed"));
        }
    }
    let length = usize::try_from(actual.len()).map_err(io::Error::other)?;
    let bytes = crate::browser_dev_read::read_exact_snapshot(&mut reader, length)?;
    let after = reader.metadata()?;
    if after.len() != actual.len() || after.modified()? != actual.modified()? {
        return Err(io::Error::other("source control changed while reading"));
    }
    Ok(bytes)
}
fn write_grant(path: &Path, value: &CreditGrant<'_>) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > CONTROL_BYTES {
        return Err(io::Error::other("source grant exceeds allowance"));
    }
    let temporary = path.join(".grant.json.next");
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?
        .write_all(&bytes)?;
    fs::rename(temporary, path.join("grant.json"))
}

// Streaming tree shape/size admission checks. Content correctness of portable
// data remains read_validated_pack's existing validator, not child self-report.
fn inspect_tree(root: &Path, kind: Kind) -> io::Result<(u64, u32, u32)> {
    fn visit(
        path: &Path,
        relative: usize,
        depth: u32,
        kind: Kind,
        total: &mut (u64, u32, u32),
    ) -> io::Result<()> {
        if relative > 2048 || depth > 32 {
            return Err(io::Error::other("source tree path/depth limit"));
        }
        let metadata = fs::symlink_metadata(path)?;
        if metadata.file_type().is_symlink() {
            return Err(io::Error::other("source tree symlink"));
        }
        let (maximum_bytes, maximum_files, maximum_dirs) = if kind == Kind::Raw {
            (RAW_PAYLOAD_BYTES, 8192, 1024)
        } else {
            (PACK_PAYLOAD_BYTES, 16_384, 2048)
        };
        if metadata.is_dir() {
            total.2 = total
                .2
                .checked_add(1)
                .ok_or_else(|| io::Error::other("directory overflow"))?;
            if total.2 > maximum_dirs {
                return Err(io::Error::other("source directory limit"));
            }
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let name = entry.file_name();
                let bytes = name
                    .to_str()
                    .ok_or_else(|| io::Error::other("source path is not UTF-8"))?
                    .len();
                visit(
                    &entry.path(),
                    relative + bytes + usize::from(relative != 0),
                    depth + 1,
                    kind,
                    total,
                )?;
            }
        } else if metadata.is_file() {
            total.0 = total
                .0
                .checked_add(metadata.len())
                .ok_or_else(|| io::Error::other("byte overflow"))?;
            total.1 = total
                .1
                .checked_add(1)
                .ok_or_else(|| io::Error::other("file overflow"))?;
            if metadata.len() > 64 * MIB || total.0 > maximum_bytes || total.1 > maximum_files {
                return Err(io::Error::other("source file/byte limit"));
            }
        } else {
            return Err(io::Error::other("source tree special file"));
        }
        Ok(())
    }
    let mut total = (0, 0, 0);
    visit(root, 0, 0, kind, &mut total)?;
    Ok(total)
}

/// Bounded source registry owned beside runtime entries, sharing their ledger.
/// Its dedicated control root is parent-owned and must outlive this registry.
#[must_use = "retire and drain actual source owners before deleting their parent"]
pub(super) struct SourceCredits {
    root: PathBuf,
    run_id: String,
    compiler_commit: String,
    entries: [Option<SourceEntry>; SOURCE_SLOTS],
    watcher: BoundSourceWatcher,
    stopping: bool,
}
impl SourceCredits {
    pub(super) fn new(root: PathBuf, run_id: String, compiler_commit: String) -> io::Result<Self> {
        if run_id.is_empty()
            || run_id.len() > 128
            || !run_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
            || !matches!(compiler_commit.len(), 40 | 64)
            || !compiler_commit
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(io::Error::other("exact source run/compiler pin required"));
        }
        let metadata = fs::symlink_metadata(&root)?;
        if !root.is_absolute()
            || root.to_str().is_none_or(|value| value.len() > 4096)
            || !metadata.is_dir()
            || metadata.file_type().is_symlink()
        {
            return Err(io::Error::other(
                "source control root must be an existing private directory",
            ));
        }
        if fs::read_dir(&root)?.next().transpose()?.is_some() {
            return Err(io::Error::other(
                "source credit run root must start empty; old runs are never adopted",
            ));
        }
        if fs::canonicalize(&root)? != root {
            return Err(io::Error::other("source control root must be canonical"));
        }
        let watcher = BoundSourceWatcher::new(root.clone(), run_id.clone());
        Ok(Self {
            root,
            run_id,
            compiler_commit,
            entries: std::array::from_fn(|_| None),
            watcher,
            stopping: false,
        })
    }

    pub(super) fn spawn_watcher(&mut self, command: &mut Command) -> io::Result<()> {
        if self.stopping {
            return Err(io::Error::other("source run is shutting down"));
        }
        self.watcher.spawn(command)
    }

    pub(super) fn take_watcher_stdout(&mut self) -> Option<ChildStdout> {
        self.watcher.take_stdout()
    }

    pub(super) fn take_watcher_stderr(&mut self) -> Option<ChildStderr> {
        self.watcher.take_stderr()
    }

    fn revoke_claims_after_actual_barrier(&mut self) {
        if self.watcher.has_actual_barrier() {
            for entry in self.entries.iter_mut().flatten() {
                if entry.kind == Kind::Raw {
                    entry.raw_writer_authority = false;
                }
            }
        }
    }

    pub(super) fn poll_watcher(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.watcher.poll()?;
        self.revoke_claims_after_actual_barrier();
        Ok(status)
    }

    pub(super) fn try_stop_watcher(&mut self) -> io::Result<bool> {
        self.stopping = true;
        let stopped = self.watcher.try_shutdown()?;
        self.revoke_claims_after_actual_barrier();
        Ok(stopped)
    }

    pub(super) fn ids(&self) -> Vec<NamespaceId> {
        self.entries
            .iter()
            .flatten()
            .map(|entry| entry.id)
            .collect()
    }

    #[cfg(test)]
    pub(super) fn active_raw_count(&self) -> usize {
        self.entries
            .iter()
            .flatten()
            .filter(|entry| entry.kind == Kind::Raw)
            .count()
    }

    fn index(&self, id: NamespaceId) -> io::Result<usize> {
        self.entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|entry| entry.id == id))
            .ok_or_else(|| io::Error::other("source namespace is not owned here"))
    }

    fn admit(
        &mut self,
        ledger: &mut Ledger,
        kind: Kind,
        inputs: Option<PackSourceInput>,
    ) -> Result<usize, Box<SourceStartRejection>> {
        if self.stopping {
            return Err(Box::new(SourceStartRejection {
                cause: AdmissionError::InvalidInput,
                inputs,
            }));
        }
        if self
            .entries
            .iter()
            .flatten()
            .filter(|entry| entry.kind == kind)
            .count()
            >= 2
        {
            return Err(Box::new(SourceStartRejection {
                cause: AdmissionError::Capacity,
                inputs,
            }));
        }
        let Some(index) = self.entries.iter().position(Option::is_none) else {
            return Err(Box::new(SourceStartRejection {
                cause: AdmissionError::Capacity,
                inputs,
            }));
        };
        let token = match ledger.reserve_source(if kind == Kind::Raw {
            RAW_CHARGE
        } else {
            PACK_CHARGE
        }) {
            Ok(token) => token,
            Err(cause) => return Err(Box::new(SourceStartRejection { cause, inputs })),
        };
        let id = token.id;
        // Admission and future cleanup slot exist BEFORE create/copy/spawn.
        let root = self.root.join(format!("source-{}-{}", id.store, id.serial));
        self.entries[index] = Some(SourceEntry {
            id,
            kind,
            owner: Arc::new(SourceOwner {
                files: ActualSourceFiles {
                    root,
                    created: false,
                    retired: false,
                },
                token: Some(token),
                binding: None,
            }),
            raw_writer_authority: false,
            writer: None,
            inputs,
            step: SourceStep::Failed,
            retired: false,
            diagnostic: None,
        });
        Ok(index)
    }

    pub(super) fn issue_raw(
        &mut self,
        ledger: &mut Ledger,
    ) -> Result<NamespaceId, Box<SourceStartRejection>> {
        let index = self.admit(ledger, Kind::Raw, None)?;
        let entry = self.entries[index].as_mut().expect("admitted entry");
        let owner = Arc::get_mut(&mut entry.owner).expect("new source is exclusive");
        let name = format!("source-{}-{}", entry.id.store, entry.id.serial);
        let result = owner.files.create().and_then(|()| {
            write_grant(
                &owner.files.root,
                &CreditGrant {
                    protocol_version: VERSION,
                    run_id: &self.run_id,
                    credit_id: &name,
                    limits: CopyLimits {
                        bytes: RAW_PAYLOAD_BYTES.to_string(),
                        files: 8192,
                        directories: 1024,
                        depth: 32,
                        path_bytes: 2048,
                        file_bytes: (64 * MIB).to_string(),
                    },
                },
            )
        });
        match result {
            Ok(()) => {
                entry.raw_writer_authority = true;
                entry.step = SourceStep::Issued;
            }
            Err(error) => entry.diagnostic = Some(bounded_message(error)),
        }
        Ok(entry.id) // Actual construction failure stays inside this slot.
    }

    pub(super) fn read_status(&self) -> io::Result<Option<CreditStatus>> {
        let bytes = match bytes_at(&self.root.join("status.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let status: CreditStatus = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        if status.protocol_version != VERSION
            || status.run_id != self.run_id
            || decimal(&status.sequence)? == 0
            || !matches!(
                status.kind.as_str(),
                "building" | "error" | "blocked" | "success"
            )
        {
            return Err(io::Error::other("invalid source status binding"));
        }
        let shape = match status.kind.as_str() {
            "building" => {
                status.credit_id.is_none()
                    && status.compiler_commit.is_none()
                    && status.message.is_none()
            }
            "success" => {
                status.credit_id.is_some()
                    && status.compiler_commit.is_some()
                    && status.message.is_none()
            }
            _ => {
                status.credit_id.is_none()
                    && status.compiler_commit.is_none()
                    && status.message.is_some()
            }
        };
        if !shape {
            return Err(io::Error::other(
                "source status has invalid fields for its kind",
            ));
        }
        Ok(Some(status))
    }

    fn result_for(entry: &SourceEntry, run: &str) -> io::Result<Option<RawResult>> {
        let bytes = match bytes_at(&entry.owner.files.root.join("result.json")) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        let result: RawResult = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        let name = format!("source-{}-{}", entry.id.store, entry.id.serial);
        if result.protocol_version != VERSION
            || result.run_id != run
            || result.credit_id != name
            || !result.writer_done
            || decimal(&result.sequence)? == 0
            || !matches!(result.kind.as_str(), "success" | "error")
        {
            return Err(io::Error::other(
                "raw completion does not match the issued actual owner",
            ));
        }
        let shape = if result.kind == "success" {
            result.compiler_commit.is_some()
                && result.inventory.is_some()
                && result.message.is_none()
        } else {
            result.compiler_commit.is_none()
                && result.inventory.is_none()
                && result.message.is_some()
        };
        if !shape {
            return Err(io::Error::other("invalid raw completion field shape"));
        }
        Ok(Some(result))
    }

    pub(super) fn accept_raw_status(&mut self, status: &CreditStatus) -> io::Result<NamespaceId> {
        if status.protocol_version != VERSION
            || status.run_id != self.run_id
            || status.kind != "success"
        {
            return Err(io::Error::other(
                "only this run's explicit END success may select raw input",
            ));
        }
        let name = status
            .credit_id
            .as_deref()
            .ok_or_else(|| io::Error::other("missing issued credit"))?;
        // Lookup existing ACTUAL owner only. Never construct one from this name.
        let index = self
            .entries
            .iter()
            .position(|entry| {
                entry.as_ref().is_some_and(|entry| {
                    entry.kind == Kind::Raw
                        && format!("source-{}-{}", entry.id.store, entry.id.serial) == name
                })
            })
            .ok_or_else(|| io::Error::other("success credit was not admitted here"))?;
        let entry = self.entries[index].as_mut().expect("existing owner");
        if entry.retired || entry.step != SourceStep::Issued {
            return Err(io::Error::other("credit already consumed/retired"));
        }
        let result = Self::result_for(entry, &self.run_id)?
            .ok_or_else(|| io::Error::other("missing raw writer completion"))?;
        // The exact matching done ack retires this single helper write grant.
        entry.raw_writer_authority = false;
        if result.kind != "success"
            || result.sequence != status.sequence
            || result.compiler_commit.as_deref() != Some(self.compiler_commit.as_str())
            || status.compiler_commit.as_deref() != Some(self.compiler_commit.as_str())
            || result.message.is_some()
        {
            entry.step = SourceStep::Failed;
            return Err(io::Error::other("raw completion/status/compiler differ"));
        }
        let verified = (|| {
            let inventory = result
                .inventory
                .ok_or_else(|| io::Error::other("missing raw inventory"))?;
            let actual = inspect_tree(&entry.owner.files.root.join("pack"), Kind::Raw)?;
            if actual
                != (
                    decimal(&inventory.bytes)?,
                    inventory.files,
                    inventory.directories,
                )
            {
                return Err(io::Error::other("raw actual tree differs from copy facts"));
            }
            Ok(())
        })();
        if let Err(error) = verified {
            entry.step = SourceStep::Failed;
            return Err(error);
        }
        let owner = Arc::get_mut(&mut entry.owner)
            .ok_or_else(|| io::Error::other("unfrozen raw owner borrowed"))?;
        owner.binding = Some(Binding::Raw {
            compiler: self.compiler_commit.clone(),
            sequence: decimal(&status.sequence)?,
        });
        entry.step = SourceStep::Ready;
        Ok(entry.id)
    }

    pub(super) fn borrow(&mut self, id: NamespaceId) -> io::Result<SourceInputLease> {
        let index = self.index(id)?;
        let entry = self.entries[index].as_ref().expect("owned entry");
        if entry.retired || entry.step != SourceStep::Ready || entry.owner.binding.is_none() {
            return Err(io::Error::other(
                "source is not a borrowable immutable input",
            ));
        }
        // &mut creator + non-Clone lease serializes creation; borrower drops can
        // only reduce the count. No Weak/raw Arc escape is available.
        if Arc::strong_count(&entry.owner) > MAX_SOURCE_BORROWERS {
            return Err(io::Error::other("source borrower capacity occupied"));
        }
        Ok(SourceInputLease {
            owner: entry.owner.clone(),
        })
    }

    pub(super) fn borrow_portable(&mut self, id: NamespaceId) -> io::Result<PortableInputLease> {
        let entry = self.entries[self.index(id)?].as_ref().expect("owned entry");
        if entry.kind != Kind::Portable
            || !matches!(&entry.owner.binding, Some(Binding::Portable(_)))
        {
            return Err(io::Error::other("source is not a verified portable input"));
        }
        // Reuse the same Ready/retirement check and shared borrower quota.
        Ok(PortableInputLease {
            source: self.borrow(id)?,
        })
    }

    pub(super) fn start_pack(
        &mut self,
        ledger: &mut Ledger,
        intent: PackStart,
        inputs: PackSourceInput,
    ) -> Result<NamespaceId, Box<SourceStartRejection>> {
        let valid = !intent.modern_project_requested
            && intent.revision != 0
            && !intent.pack_timeout.is_zero()
            && !intent.node_bin.as_os_str().is_empty()
            && intent.node_bin.as_os_str().len() <= 4096
            && intent.packer.is_absolute()
            && intent.packer.as_os_str().len() <= 4096
            && intent
                .route
                .as_ref()
                .is_none_or(|route| route.len() <= 2048)
            && inputs.raw.namespace().store == ledger.store
            && inputs.raw.raw_sequence().is_some();
        if !valid {
            return Err(Box::new(SourceStartRejection {
                cause: AdmissionError::InvalidInput,
                inputs: Some(inputs),
            }));
        }
        let index = self.admit(ledger, Kind::Portable, Some(inputs))?;
        let entry = self.entries[index].as_mut().expect("admitted output");
        entry.writer = Some(PackWriter {
            actual: None,
            barrier: true,
            intent,
            started_at: Instant::now(),
        });
        let owner = Arc::get_mut(&mut entry.owner).expect("new output is exclusive");
        let output = owner.files.root.join(".staging");
        let prepared = owner.files.create().and_then(|()| fs::create_dir(&output));
        if let Err(error) = prepared {
            entry.diagnostic = Some(bounded_message(error));
            return Ok(entry.id); // Same owner + source inputs retained.
        }
        let input = &entry.inputs.as_ref().expect("pack inputs retained").raw;
        let writer = entry.writer.as_mut().expect("intent retained");
        let mut command = Command::new(&writer.intent.node_bin);
        command
            .arg(&writer.intent.packer)
            .arg(input.directory())
            .arg("--out")
            .arg(output)
            .arg("--platform")
            .arg("weapp")
            .arg("--compiler-commit")
            .arg(input.compiler());
        match OwnedProcess::spawn_finite(&mut command) {
            Ok(actual) => {
                writer.actual = Some(Box::new(actual));
                writer.barrier = false;
                entry.step = SourceStep::Writing;
            }
            Err(failure) => {
                let (cause, actual) = failure.into_parts();
                writer.barrier = actual.is_none();
                writer.actual = actual;
                entry.diagnostic = Some(bounded_message(cause));
            }
        }
        Ok(entry.id)
    }

    pub(super) fn poll_pack(
        &mut self,
        ledger: &mut Ledger,
        id: NamespaceId,
    ) -> io::Result<SourceStep> {
        let index = self.index(id)?;
        let entry = self.entries[index].as_mut().expect("owned pack");
        if entry.kind != Kind::Portable || entry.step != SourceStep::Writing {
            return Ok(entry.step);
        }
        let writer = entry.writer.as_mut().expect("actual pack writer");
        let actual = writer.actual.as_mut().expect("running actual pack");
        if writer.started_at.elapsed() >= writer.intent.pack_timeout {
            let error = match actual.terminate_finite() {
                Ok(()) => {
                    io::Error::new(io::ErrorKind::TimedOut, "portable pack deadline exceeded")
                }
                Err(error) => error,
            };
            entry.step = SourceStep::Failed;
            entry.diagnostic = Some(bounded_message(&error));
            return Err(error); // Keep the original process, input and charge until cleanup.
        }
        let status = match actual.poll_finite_exit() {
            Ok(Some(status)) => status,
            Ok(None) => return Ok(SourceStep::Writing),
            Err(error) => {
                entry.step = SourceStep::Failed;
                entry.diagnostic = Some(bounded_message(&error));
                return Err(error); // Actual writer and input remain in entry.
            }
        };
        writer.barrier = true;
        writer.actual = None; // Real barrier precedes releasing this owner.
                              // Invariant/verification errors below cannot leave a Writing state
                              // that would expect the already retired process on the next poll.
        entry.step = SourceStep::Failed;
        let owner = Arc::get_mut(&mut entry.owner)
            .ok_or_else(|| io::Error::other("mutable output borrowed"))?;
        ledger.source_process_retired(owner.token.as_mut().expect("charged output"))?;
        if !status.success() {
            entry.step = SourceStep::Failed;
            entry.diagnostic = Some(bounded_message(status));
            return Ok(entry.step);
        }
        let staging = owner.files.root.join(".staging");
        let published = owner.files.root.join("pack");
        let expected_compiler = entry
            .inputs
            .as_ref()
            .expect("source held through verification")
            .raw
            .compiler();
        // Existing validation is bounded by a shape/size prescan, but its
        // derived serde/allocator peak remains a logical-budget limitation.
        let result = inspect_tree(&staging, Kind::Portable).and_then(|_| {
            let pack = crate::read_validated_pack(&staging).map_err(io::Error::other)?;
            if pack.manifest.compiler.commit != expected_compiler {
                return Err(io::Error::other(
                    "portable compiler pin differs from actual raw input lease",
                ));
            }
            let selected_route =
                crate::route_for_manifest(writer.intent.route.as_deref(), None, &pack.manifest);
            let report = PortablePackReport {
                schema_version: 1,
                revision: writer.intent.revision,
                pack_directory: published.clone(),
                manifest_sha256: container_ir::hex_digest(&pack.manifest_bytes),
                integrity_root: pack.manifest.integrity.root.clone(),
                compiler_commit: pack.manifest.compiler.commit.clone(),
                routes: pack
                    .manifest
                    .routes
                    .iter()
                    .map(|route| route.path.clone())
                    .collect(),
                requested_route: writer.intent.route.clone(),
                selected_route,
                publication_token: writer.intent.publication_token.clone(),
            };
            if fs::symlink_metadata(&published).is_ok() {
                return Err(io::Error::other("pack destination already exists"));
            }
            fs::rename(&staging, &published)?;
            // SAME SourceOwner Arc, reservation, NamespaceId and outer files.
            owner.binding = Some(Binding::Portable(report));
            Ok(())
        });
        match result {
            Ok(()) => {
                entry.inputs = None;
                entry.step = SourceStep::Ready;
            }
            Err(error) => {
                entry.step = SourceStep::Failed;
                entry.diagnostic = Some(bounded_message(&error));
                return Err(error);
            }
        }
        Ok(entry.step)
    }

    pub(super) fn portable_report(&self, id: NamespaceId) -> io::Result<&PortablePackReport> {
        let entry = self.entries[self.index(id)?].as_ref().expect("owned entry");
        match &entry.owner.binding {
            Some(Binding::Portable(report)) => Ok(report),
            _ => Err(io::Error::other("not a verified portable generation")),
        }
    }

    pub(super) fn step(&self, id: NamespaceId) -> io::Result<SourceStep> {
        Ok(self.entries[self.index(id)?]
            .as_ref()
            .expect("owned entry")
            .step)
    }

    pub(super) fn diagnostic(&self, id: NamespaceId) -> io::Result<Option<&str>> {
        Ok(self.entries[self.index(id)?]
            .as_ref()
            .expect("owned entry")
            .diagnostic
            .as_deref())
    }

    pub(super) fn retire(&mut self, id: NamespaceId) -> io::Result<()> {
        let index = self.index(id)?;
        self.entries[index].as_mut().expect("owned entry").retired = true;
        Ok(())
    }

    pub(super) fn cleanup(
        &mut self,
        ledger: &mut Ledger,
        id: NamespaceId,
    ) -> io::Result<SourceStep> {
        let index = self.index(id)?;
        // The bound actual watcher can settle missing/invalid ACKs. Do this
        // BEFORE result parsing so malformed JSON cannot block final cleanup.
        // An unrelated watcher error must not stall a portable job's cleanup.
        if self.entries[index]
            .as_ref()
            .is_some_and(|entry| entry.kind == Kind::Raw)
        {
            self.poll_watcher()?;
        }
        let entry = self.entries[index].as_mut().expect("owned entry");
        if !entry.retired {
            return Ok(entry.step);
        }
        // A valid per-credit done ack or atomic grant revoke is sufficient for
        // this synchronous trusted writer. A claimed, unacked/crashed watcher
        // is deliberately retained here: no caller-supplied 'stopped' bool.
        if entry.raw_writer_authority {
            if Self::result_for(entry, &self.run_id)?.is_some() {
                entry.raw_writer_authority = false;
            } else {
                match fs::rename(
                    entry.owner.files.root.join("grant.json"),
                    entry.owner.files.root.join("revoked.json"),
                ) {
                    Ok(()) => entry.raw_writer_authority = false,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        return Ok(SourceStep::CleanupPending)
                    }
                    Err(error) => return Err(error),
                }
            }
        }
        if let Some(writer) = &mut entry.writer {
            if !writer.barrier {
                let actual = writer
                    .actual
                    .as_mut()
                    .ok_or_else(|| io::Error::other("missing pack process owner"))?;
                actual.terminate_finite()?;
                if actual.poll_finite_exit()?.is_none() {
                    return Ok(SourceStep::CleanupPending);
                }
                writer.barrier = true;
                writer.actual = None;
            }
        }
        let Some(owner) = Arc::get_mut(&mut entry.owner) else {
            return Ok(SourceStep::CleanupPending);
        };
        if let Some(token) = &mut owner.token {
            if token.remaining.finite_jobs == 1 {
                ledger.source_process_retired(token)?;
            }
        }
        owner.files.cleanup()?;
        if !owner.files.retired {
            return Err(io::Error::other(
                "actual source cleanup did not retire files",
            ));
        }
        // Drop all retained memory/input borrowers BEFORE refunding its charge.
        entry.diagnostic = None;
        entry.inputs = None;
        entry.writer = None;
        owner.binding = None;
        owner.files.root = PathBuf::new(); // Release its retained native path allocation too.
        let Some(token) = owner.token.take() else {
            return Err(io::Error::other("source reservation already consumed"));
        };
        if let Err(token) = ledger.refund(token) {
            owner.token = Some(token);
            return Err(io::Error::other("source refund identity/state mismatch"));
        }
        self.entries[index] = None;
        Ok(SourceStep::Released)
    }

    pub(super) fn is_drained(&self) -> bool {
        self.watcher.has_actual_barrier() && self.entries.iter().all(Option::is_none)
    }

    #[cfg(test)]
    pub(super) fn control_root(&self) -> &Path {
        &self.root
    }
}
