//! Independent synchronous disk ownership. This provider never borrows Session
//! or an asynchronous host dispatcher while a JavaScript engine is executing.
use container_core::SyncHostApi;
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[path = "sync_file_codecs.rs"]
mod codecs;
#[path = "sync_file_descriptors.rs"]
mod descriptors;
#[path = "sync_file_stats.rs"]
mod stats;

const CHUNK: usize = 1024 * 1024;
const QUOTA: u64 = 32 * 1024 * 1024;
const MEMBERS: &[&str] = &[
    "accessSync",
    "appendFileSync",
    "copyFileSync",
    "mkdirSync",
    "readFileSync",
    "readdirSync",
    "renameSync",
    "rmdirSync",
    "statSync",
    "unlinkSync",
    "writeFileSync",
    "openSync",
    "closeSync",
    "readSync",
    "writeSync",
    "fstatSync",
    "ftruncateSync",
    "truncateSync",
];
static NEXT_WRITE: AtomicU64 = AtomicU64::new(1);

pub(super) fn is_sync_filesystem(name: &str) -> bool {
    name.strip_prefix("object:FileSystemManager.")
        .is_some_and(|member| MEMBERS.contains(&member))
}

pub(super) struct SyncBinding {
    provider: Arc<dyn SyncHostApi>,
    allowed: Mutex<BTreeSet<String>>,
    call_gate: Mutex<()>,
    revoked: AtomicBool,
    retirement: Mutex<Option<Result<(), String>>>,
}
impl SyncBinding {
    pub(super) fn new(provider: Arc<dyn SyncHostApi>) -> Self {
        Self {
            provider,
            allowed: Mutex::new(BTreeSet::new()),
            call_gate: Mutex::new(()),
            revoked: AtomicBool::new(false),
            retirement: Mutex::new(None),
        }
    }
    pub(super) fn allow(&self, allowed: BTreeSet<String>) {
        *self.allowed.lock().expect("sync API lock") = allowed;
    }
    pub(super) fn revoke(&self) -> Result<(), String> {
        self.revoked.store(true, Ordering::Release);
        let _calls = self
            .call_gate
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.allowed
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
        let mut retirement = self
            .retirement
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(result) = &*retirement {
            return result.clone();
        }
        let result =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.provider.retire()))
                .map_err(|_| "synchronous provider panicked during owner retirement".to_owned());
        *retirement = Some(result.clone());
        result
    }
}
impl Drop for SyncBinding {
    fn drop(&mut self) {
        // Destructors cannot report a failure to their caller; an explicit
        // revoke retains and exposes the same failure, and never reopens input.
        let _ = self.revoke();
    }
}
impl SyncHostApi for SyncBinding {
    fn supported_apis(&self) -> Vec<String> {
        self.provider.supported_apis()
    }
    fn invoke(&self, name: &str, payload: Value) -> Result<Value, Value> {
        let _call = self.call_gate.lock().map_err(|_| {
            json!({"code":"ERR_CANCELLED","api":name,"errMsg":format!("{name}:fail synchronous owner faulted")})
        })?;
        if self.revoked.load(Ordering::Acquire) {
            return Err(
                json!({"code":"ERR_CANCELLED","api":name,"errMsg":format!("{name}:fail synchronous owner retired")}),
            );
        }
        if !self.allowed.lock().expect("sync API lock").contains(name) {
            return Err(
                json!({"code":"ERR_UNSUPPORTED_CAPABILITY","api":name,"errMsg":format!("{name}:fail synchronous operation is not registered")}),
            );
        }
        self.provider.invoke(name, payload)
    }
}

/// Bind only to the `root` returned by the SDK's managedFileScope lease. A new
/// account gets a new instance before its modules evaluate; SDK owns the lease.
pub struct ManagedSyncFileSystem {
    root: PathBuf,
    serial: Mutex<()>,
    descriptors: Mutex<descriptors::Descriptors>,
    retired: AtomicBool,
}
impl ManagedSyncFileSystem {
    pub fn new(root: impl Into<PathBuf>) -> std::io::Result<Self> {
        let root = root.into();
        if !root.is_absolute()
            || fs::symlink_metadata(&root)?.file_type().is_symlink()
            || !root.is_dir()
        {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "managed synchronous root must be an existing absolute directory",
            ));
        }
        Ok(Self {
            root: root.canonicalize()?,
            serial: Mutex::new(()),
            descriptors: Mutex::new(descriptors::Descriptors::new()),
            retired: AtomicBool::new(false),
        })
    }
    fn path(&self, text: &str, root_allowed: bool) -> Result<PathBuf, String> {
        if root_allowed && matches!(text, "wxfile://user" | "wxfile://user/") {
            return Ok(self.root.clone());
        }
        let suffix = text
            .strip_prefix("wxfile://user/")
            .ok_or("path must use wxfile://user/")?;
        if suffix.is_empty() || suffix.len() > 4096 || suffix.contains(['\\', '\0']) {
            return Err("invalid managed file path".into());
        }
        let mut path = self.root.clone();
        let mut depth = 0;
        for part in suffix.split('/') {
            depth += 1;
            if part.is_empty()
                || matches!(part, "." | "..")
                || part.contains(':')
                || part.starts_with(".weapp-")
                || depth > 32
            {
                return Err("invalid managed file path segment".into());
            }
            path.push(part);
            if fs::symlink_metadata(&path).is_ok_and(|entry| entry.file_type().is_symlink()) {
                return Err("managed files cannot traverse symbolic links".into());
            }
        }
        Ok(path)
    }
    fn disk_bytes(&self) -> Result<u64, String> {
        let mut pending = vec![(self.root.clone(), 0)];
        let (mut total, mut entries) = (0u64, 0usize);
        while let Some((path, depth)) = pending.pop() {
            if depth > 32 {
                return Err("managed directory nesting limit exceeded".into());
            }
            for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                entries += 1;
                if entries > 4096 {
                    return Err("managed directory entry budget exceeded".into());
                }
                if entry.file_name().to_string_lossy().starts_with(".weapp-") {
                    continue;
                }
                let kind = entry.file_type().map_err(|e| e.to_string())?;
                if kind.is_symlink() {
                    continue;
                }
                if kind.is_dir() {
                    pending.push((entry.path(), depth + 1));
                } else if kind.is_file() {
                    total = total
                        .checked_add(entry.metadata().map_err(|e| e.to_string())?.len())
                        .ok_or("managed file quota exceeded")?;
                }
            }
        }
        Ok(total)
    }
    fn durable_write(&self, path: &Path, bytes: &[u8]) -> Result<(), String> {
        let previous = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        {
            let descriptors = self
                .descriptors
                .lock()
                .map_err(|_| "file descriptor owner poisoned")?;
            self.descriptor_quota(&descriptors, (bytes.len() as u64).saturating_sub(previous))?;
        }
        if self
            .disk_bytes()?
            .saturating_sub(previous)
            .checked_add(bytes.len() as u64)
            .is_none_or(|total| total > QUOTA)
        {
            return Err("managed file quota exceeded".into());
        }
        let parent = path.parent().ok_or("managed file parent missing")?;
        let temporary = parent.join(format!(
            ".weapp-sync-{}-{}",
            std::process::id(),
            NEXT_WRITE.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut output = options.open(&temporary).map_err(|e| e.to_string())?;
            output.write_all(bytes).map_err(|e| e.to_string())?;
            output.sync_all().map_err(|e| e.to_string())?;
            drop(output);
            #[cfg(not(windows))]
            fs::rename(&temporary, path).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            {
                use std::os::windows::ffi::OsStrExt;
                #[link(name = "kernel32")]
                extern "system" {
                    fn MoveFileExW(source: *const u16, destination: *const u16, flags: u32) -> i32;
                }
                let source = temporary
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                let destination = path
                    .as_os_str()
                    .encode_wide()
                    .chain(Some(0))
                    .collect::<Vec<_>>();
                if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0x1 | 0x8) } == 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
            }
            #[cfg(unix)]
            File::open(parent)
                .and_then(|file| file.sync_all())
                .map_err(|e| e.to_string())?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    fn sync_directory(path: &Path) -> Result<(), String> {
        #[cfg(unix)]
        {
            File::open(path)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
        }
        #[cfg(not(unix))]
        let _ = path;
        Ok(())
    }
    fn bytes(payload: &Value) -> Result<Vec<u8>, String> {
        let data = payload.get("data").ok_or("file data missing")?;
        if let Some(bytes) = codecs::encode(payload)? {
            return Ok(bytes);
        }
        let marker = data
            .get("__weappBinary")
            .ok_or("file data must be UTF-8 text or ArrayBuffer")?;
        let bytes = marker
            .get("bytes")
            .and_then(Value::as_array)
            .filter(|bytes| bytes.len() <= CHUNK)
            .ok_or("invalid ArrayBuffer byte budget")?;
        if data.as_object().is_none_or(|data| data.len() != 1)
            || marker.get("type").and_then(Value::as_str) != Some("ArrayBuffer")
        {
            return Err("invalid file ArrayBuffer".into());
        }
        bytes
            .iter()
            .map(|byte| {
                byte.as_u64()
                    .filter(|byte| *byte <= 255)
                    .map(|byte| byte as u8)
                    .ok_or_else(|| "invalid file byte".into())
            })
            .collect()
    }
    fn call(&self, name: &str, payload: Value) -> Result<Value, String> {
        if !is_sync_filesystem(name) {
            return Err("synchronous file method is unavailable".into());
        }
        let _serial = self
            .serial
            .lock()
            .map_err(|_| "synchronous file owner lock poisoned")?;
        if self.retired.load(Ordering::Acquire) {
            return Err("synchronous file owner retired".into());
        }
        // Native asynchronous drivers use this same OS lock. Read-modify-write
        // append and quota checks therefore share one scope-wide transaction.
        let lock_path = self.root.join(".weapp-operations.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("managed operation lock cannot be a symbolic link".into());
        }
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        lock.lock().map_err(|error| error.to_string())?;
        let member = name.rsplit('.').next().unwrap_or("");
        if descriptors::MEMBERS.contains(&member) {
            return self.descriptor_call(member, &payload);
        }
        let text = |key: &str| {
            payload
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{key} must be a managed file path"))
        };
        let path = |key: &str, root: bool| self.path(text(key)?, root);
        match member {
            "readFileSync" => {
                let path = path("filePath", false)?;
                let mut file = File::open(path).map_err(|e| e.to_string())?;
                let size = file.metadata().map_err(|e| e.to_string())?.len();
                let position = payload
                    .get("position")
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_u64().ok_or("invalid read position"))
                    .transpose()?
                    .unwrap_or(0);
                if position > size {
                    return Err("read position exceeds file size".into());
                }
                let remaining = size - position;
                let length = payload
                    .get("length")
                    .filter(|v| !v.is_null())
                    .map(|v| v.as_u64().ok_or("invalid read length"))
                    .transpose()?
                    .unwrap_or(remaining);
                if length > CHUNK as u64 || length > remaining {
                    return Err("read must remain within one MiB and the file bounds".into());
                }
                file.seek(SeekFrom::Start(position))
                    .map_err(|e| e.to_string())?;
                let mut bytes = vec![0; length as usize];
                file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
                Ok(codecs::decode(&payload, &bytes)?.unwrap_or_else(
                    || json!({"__weappBinary":{"type":"ArrayBuffer","bytes":bytes}}),
                ))
            }
            "writeFileSync" | "appendFileSync" => {
                let path = path("filePath", false)?;
                let bytes = Self::bytes(&payload)?;
                if member == "appendFileSync" && path.exists() {
                    if fs::metadata(&path).map_err(|e| e.to_string())?.len()
                        > QUOTA.saturating_sub(bytes.len() as u64)
                    {
                        return Err("managed file quota exceeded".into());
                    }
                    let mut existing = fs::read(&path).map_err(|e| e.to_string())?;
                    if existing.len() > QUOTA as usize - bytes.len() {
                        return Err("managed file quota exceeded".into());
                    }
                    existing.extend(bytes);
                    self.durable_write(&path, &existing)?;
                } else {
                    self.durable_write(&path, &bytes)?;
                }
                Ok(Value::Null)
            }
            "accessSync" => {
                fs::metadata(path("path", true)?).map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "copyFileSync" => {
                let source = path("srcPath", false)?;
                let destination = path("destPath", false)?;
                if fs::metadata(&source).map_err(|e| e.to_string())?.len() > QUOTA {
                    return Err("source exceeds managed file quota".into());
                }
                let bytes = fs::read(source).map_err(|e| e.to_string())?;
                self.durable_write(&destination, &bytes)?;
                Ok(Value::Null)
            }
            "renameSync" => {
                let source = path("oldPath", false)?;
                let destination = path("newPath", false)?;
                fs::rename(&source, &destination).map_err(|e| e.to_string())?;
                Self::sync_directory(source.parent().ok_or("source parent missing")?)?;
                if source.parent() != destination.parent() {
                    Self::sync_directory(
                        destination.parent().ok_or("destination parent missing")?,
                    )?;
                }
                Ok(Value::Null)
            }
            "mkdirSync" => {
                let target = path("dirPath", false)?;
                if payload
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    fs::create_dir_all(&target)
                } else {
                    fs::create_dir(&target)
                }
                .map_err(|e| e.to_string())?;
                let mut directory = Some(target.as_path());
                while let Some(value) = directory {
                    Self::sync_directory(value)?;
                    if value == self.root {
                        break;
                    }
                    directory = value.parent();
                }
                Ok(Value::Null)
            }
            "rmdirSync" => {
                let target = path("dirPath", false)?;
                if payload
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    fs::remove_dir_all(&target)
                } else {
                    fs::remove_dir(&target)
                }
                .map_err(|e| e.to_string())?;
                Self::sync_directory(target.parent().ok_or("directory parent missing")?)?;
                Ok(Value::Null)
            }
            "unlinkSync" => {
                let target = path("filePath", false)?;
                fs::remove_file(&target).map_err(|e| e.to_string())?;
                Self::sync_directory(target.parent().ok_or("file parent missing")?)?;
                Ok(Value::Null)
            }
            "readdirSync" => {
                let mut names = Vec::new();
                for entry in fs::read_dir(path("dirPath", true)?).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if !entry.file_type().map_err(|e| e.to_string())?.is_symlink()
                        && !entry.file_name().to_string_lossy().starts_with(".weapp-")
                    {
                        names.push(
                            entry
                                .file_name()
                                .to_str()
                                .ok_or("managed filename is not UTF-8")?
                                .to_owned(),
                        );
                    }
                    if names.len() > 4096 {
                        return Err("directory entry budget exceeded".into());
                    }
                }
                names.sort();
                Ok(json!(names))
            }
            "statSync" => {
                if payload
                    .get("recursive")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                {
                    return Err("recursive synchronous stat is unavailable".into());
                }
                let metadata = fs::metadata(path("path", true)?).map_err(|e| e.to_string())?;
                stats::from_metadata(metadata)
            }
            _ => Err("synchronous file method is unavailable".into()),
        }
    }
}
impl SyncHostApi for ManagedSyncFileSystem {
    fn retire(&self) {
        self.retired.store(true, Ordering::Release);
        // Calls already executing hold serial. Drain them before releasing the
        // handles, then reject every later operation, including direct callers.
        let _serial = self
            .serial
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        self.descriptors
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
    fn supported_apis(&self) -> Vec<String> {
        MEMBERS
            .iter()
            .map(|name| format!("object:FileSystemManager.{name}"))
            .collect()
    }
    fn invoke(&self, name: &str, payload: Value) -> Result<Value, Value> {
        self.call(name, payload).map_err(|message| {
            let code = if self.retired.load(Ordering::Acquire) {
                "ERR_CANCELLED"
            } else {
                "ERR_INVALID_REQUEST"
            };
            json!({"code":code,"api":name,"errMsg":format!("{name}:fail {message}")})
        })
    }
}
