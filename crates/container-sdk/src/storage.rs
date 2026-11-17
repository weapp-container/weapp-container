use crate::SdkError;
use container_core::StorageSnapshot;
use container_ir::hex_digest;
use fs2::FileExt;
#[cfg(unix)]
use std::fs::File;
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::{Arc, Condvar, Mutex},
    thread,
};

const MAX_BARRIERS: usize = 64;

/// Lock every scope before deleting any bytes. Stable lock inodes are retained
/// so another process can never race onto a replacement lock for the same key.
pub(crate) fn delete_account_directories(
    directories: &[std::path::PathBuf],
) -> Result<usize, SdkError> {
    let mut locks = Vec::new();
    let mut files = Vec::new();
    let mut trees = Vec::new();
    for directory in directories {
        if !directory.exists() {
            continue;
        }
        if directory
            .symlink_metadata()
            .map_err(SdkError::storage)?
            .file_type()
            .is_symlink()
        {
            return Err(SdkError::storage("account directory cannot be a symlink"));
        }
        // First exclude new scopes and writers, then enumerate stable entries.
        let principal = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(".account.lock"))
            .map_err(SdkError::storage)?;
        principal.try_lock_exclusive().map_err(|_| {
            SdkError::new(
                "ERR_STORAGE_LOCKED",
                "wait for all revoked account resources before deletion",
            )
        })?;
        locks.push(principal);
        for entry in fs::read_dir(directory).map_err(SdkError::storage)? {
            let entry = entry.map_err(SdkError::storage)?;
            let metadata = entry.file_type().map_err(SdkError::storage)?;
            let path = entry.path();
            if entry.file_name() == ".account.lock" {
                continue;
            }
            if metadata.is_file() {
                if path.extension().and_then(|e| e.to_str()) == Some("lock") {
                    let lock = OpenOptions::new()
                        .read(true)
                        .write(true)
                        .open(&path)
                        .map_err(SdkError::storage)?;
                    lock.try_lock_exclusive().map_err(|_|SdkError::new("ERR_STORAGE_LOCKED","wait for all revoked account owners to release storage before deletion"))?;
                    locks.push(lock);
                } else {
                    files.push(path);
                }
            } else if metadata.is_dir()
                && path.extension().and_then(|e| e.to_str()) == Some("files")
            {
                let name = path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                let digest = name.strip_prefix("managed-").unwrap_or("");
                if digest.len() != 64
                    || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
                    || !path.with_extension("lock").is_file()
                {
                    return Err(SdkError::storage("unrecognized managed account directory"));
                }
                validate_managed_tree(&path, &mut 0)?;
                trees.push(path);
            } else {
                return Err(SdkError::storage("unexpected account storage entry"));
            }
        }
    }
    // No data has changed until every principal/scope lock and tree validates.
    for path in &files {
        fs::remove_file(path).map_err(SdkError::storage)?;
    }
    for path in &trees {
        fs::remove_dir_all(path).map_err(SdkError::storage)?;
    }
    #[cfg(unix)]
    for directory in directories.iter().filter(|d| d.exists()) {
        File::open(directory)
            .and_then(|f| f.sync_all())
            .map_err(SdkError::storage)?;
    }
    Ok(files.len() + trees.len())
}
fn validate_managed_tree(path: &Path, entries: &mut usize) -> Result<(), SdkError> {
    for entry in fs::read_dir(path).map_err(SdkError::storage)? {
        let entry = entry.map_err(SdkError::storage)?;
        *entries += 1;
        if *entries > 65536 {
            return Err(SdkError::storage(
                "managed account directory exceeds entry limit",
            ));
        }
        let kind = entry.file_type().map_err(SdkError::storage)?;
        if kind.is_dir() {
            validate_managed_tree(&entry.path(), entries)?;
        } else if !kind.is_file() {
            return Err(SdkError::storage(
                "managed account data cannot contain symlinks or special files",
            ));
        }
    }
    Ok(())
}
pub(crate) struct StorageEvent {
    pub ticket: Option<u64>,
    pub result: Result<(), String>,
}
#[derive(Default)]
struct Work {
    next_sequence: u64,
    completed_sequence: u64,
    next_ticket: u64,
    pending: Option<(u64, StorageSnapshot)>,
    barriers: BTreeMap<u64, u64>,
    completed: BTreeMap<u64, Result<(), String>>,
    last_error: Option<String>,
    error_event: Option<String>,
    stopping: bool,
    released: bool,
}
struct Shared {
    work: Mutex<Work>,
    changed: Condvar,
}

/// Bounded, coalescing persistence queue. The worker owns the OS file lock,
/// including after UI teardown until the final accepted snapshot is durable.
pub(crate) struct PersistentStorage {
    shared: Arc<Shared>,
    pub initial: StorageSnapshot,
}

impl PersistentStorage {
    pub fn open(root: &Path, key: &str) -> Result<Self, SdkError> {
        if key.trim().is_empty() {
            return Err(SdkError::invalid("storageKey cannot be empty"));
        }
        fs::create_dir_all(root).map_err(SdkError::storage)?;
        let root = root.canonicalize().map_err(SdkError::storage)?;
        let principal_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(".account.lock"))
            .map_err(SdkError::storage)?;
        FileExt::try_lock_shared(&principal_lock)
            .map_err(|_| SdkError::new("ERR_STORAGE_LOCKED", "account data is being deleted"))?;
        let name = hex_digest(key.as_bytes());
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join(format!("{name}.lock")))
            .map_err(SdkError::storage)?;
        lock.try_lock_exclusive().map_err(|error| {
            SdkError::new(
                "ERR_STORAGE_LOCKED",
                format!("storageKey already in use or lock unavailable: {error}"),
            )
        })?;
        let path = root.join(format!("{name}.json"));
        let initial = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(SdkError::storage)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                StorageSnapshot::default()
            }
            Err(error) => return Err(SdkError::storage(error)),
        };
        let shared = Arc::new(Shared {
            work: Mutex::new(Work::default()),
            changed: Condvar::new(),
        });
        let owner = shared.clone();
        thread::Builder::new()
            .name("weapp-storage".into())
            .spawn(move || {
                loop {
                    let mut work = owner.work.lock().unwrap_or_else(|p| p.into_inner());
                    // A newer full snapshot subsumes earlier writes. Barriers may
                    // be satisfied by a completed sequence at/after their target.
                    let ready: Vec<_> = work
                        .barriers
                        .iter()
                        .filter(|(_, target)| **target <= work.completed_sequence)
                        .map(|(ticket, _)| *ticket)
                        .collect();
                    for ticket in ready {
                        work.barriers.remove(&ticket);
                        let result = work.last_error.clone().map_or(Ok(()), Err);
                        work.completed.insert(ticket, result);
                    }
                    owner.changed.notify_all();
                    if let Some((sequence, snapshot)) = work.pending.take() {
                        drop(work);
                        let error = atomic_write(&path, &snapshot).err().map(|e| e.to_string());
                        let mut work = owner.work.lock().unwrap_or_else(|p| p.into_inner());
                        work.completed_sequence = sequence;
                        work.last_error = error.clone();
                        if let Some(error) = error {
                            work.error_event = Some(error);
                        }
                        drop(work);
                        continue;
                    }
                    if work.stopping {
                        drop(work);
                        drop(lock);
                        drop(principal_lock);
                        let mut work = owner.work.lock().unwrap_or_else(|p| p.into_inner());
                        work.released = true;
                        owner.changed.notify_all();
                        return;
                    }
                    drop(owner.changed.wait(work).unwrap_or_else(|p| p.into_inner()));
                }
                // The lock inode remains stable; unlinking allows a different lock
                // file for the same key while another process still owns this one.
            })
            .map_err(SdkError::storage)?;
        Ok(Self { shared, initial })
    }
    pub fn queue(&self, state: StorageSnapshot) -> Result<(), SdkError> {
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        if work.stopping {
            return Err(SdkError::storage("storage writer is closing"));
        }
        work.next_sequence = work
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| SdkError::storage("storage sequence exhausted"))?;
        work.pending = Some((work.next_sequence, state));
        self.shared.changed.notify_one();
        Ok(())
    }
    pub fn begin_flush(&self) -> Result<u64, SdkError> {
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        if work.barriers.len() + work.completed.len() >= MAX_BARRIERS {
            return Err(SdkError::storage("too many outstanding storage barriers"));
        }
        work.next_ticket = work
            .next_ticket
            .checked_add(1)
            .ok_or_else(|| SdkError::storage("storage ticket exhausted"))?;
        let ticket = work.next_ticket;
        let sequence = work.next_sequence;
        work.barriers.insert(ticket, sequence);
        self.shared.changed.notify_one();
        Ok(ticket)
    }
    /// Explicit blocking API for command-line/native final cleanup only.
    pub fn flush(&self) -> Result<(), SdkError> {
        let ticket = self.begin_flush()?;
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        loop {
            if let Some(result) = work.completed.remove(&ticket) {
                return result.map_err(SdkError::storage);
            }
            work = self.shared.changed.wait(work).map_err(SdkError::storage)?;
        }
    }
    pub fn begin_close(&self) -> Result<u64, SdkError> {
        let ticket = self.begin_flush()?;
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        work.stopping = true;
        self.shared.changed.notify_one();
        Ok(ticket)
    }
    pub fn close(&self) -> Result<(), SdkError> {
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        if work.stopping {
            while !work.released {
                work = self.shared.changed.wait(work).map_err(SdkError::storage)?;
            }
            return work
                .last_error
                .clone()
                .map_or(Ok(()), Err)
                .map_err(SdkError::storage);
        }
        drop(work);
        let ticket = self.begin_close()?;
        let mut work = self.shared.work.lock().map_err(SdkError::storage)?;
        while !work.released {
            work = self.shared.changed.wait(work).map_err(SdkError::storage)?;
        }
        work.completed
            .remove(&ticket)
            .unwrap_or_else(|| work.last_error.clone().map_or(Ok(()), Err))
            .map_err(SdkError::storage)
    }
    pub fn is_released(&self) -> bool {
        self.shared
            .work
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .released
    }
    pub fn is_closing(&self) -> bool {
        self.shared
            .work
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .stopping
    }
    pub fn last_error(&self) -> Option<String> {
        self.shared
            .work
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .last_error
            .clone()
    }
    pub fn take_events(&self) -> Vec<StorageEvent> {
        let mut work = self.shared.work.lock().unwrap_or_else(|p| p.into_inner());
        let mut events: Vec<_> = std::mem::take(&mut work.completed)
            .into_iter()
            .map(|(ticket, result)| StorageEvent {
                ticket: Some(ticket),
                result,
            })
            .collect();
        if let Some(error) = work.error_event.take() {
            events.push(StorageEvent {
                ticket: None,
                result: Err(error),
            });
        }
        events
    }
}
impl Drop for PersistentStorage {
    fn drop(&mut self) {
        let mut work = self.shared.work.lock().unwrap_or_else(|p| p.into_inner());
        work.stopping = true;
        self.shared.changed.notify_one();
        // No join on a UI thread. The worker retains the lock until the final
        // pending snapshot has been written.
    }
}
fn atomic_write(path: &Path, snapshot: &StorageSnapshot) -> Result<(), Box<dyn std::error::Error>> {
    let parent = path.parent().ok_or("storage has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec(snapshot)?)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}
