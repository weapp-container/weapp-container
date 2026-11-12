//! The native owner supplies trusted, stable application/account storage leases.
//! Async ArkTS filesystem calls and true synchronous JS calls use the same disk
//! implementation and operation lock, so neither path can bypass quota or race an
//! append. Host credentials and physical directory paths never enter guest JS.
use container_core::SyncHostApi;
use container_runtime::{HostApiCallContext, HostServicesConfig, ManagedSyncFileSystem};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_FILE: AtomicU64 = AtomicU64::new(1);
#[derive(Debug)]
pub(crate) struct ManagedFiles {
    _principal: File,
    _scope: File,
    root: PathBuf,
    auxiliary: PathBuf,
    scope_id: String,
    config: HostServicesConfig,
}
impl ManagedFiles {
    pub fn open(base: &Path, config: &HostServicesConfig) -> Result<Self, String> {
        if !base.is_absolute() {
            return Err("managed files require a host-private absolute directory".into());
        }
        checked_dir(base)?;
        let base = base.canonicalize().map_err(err)?;
        let app = &config.application;
        let principal = container_ir::hex_digest(
            json!([app.host_app_id, app.tenant_id, config.account.principal_id])
                .to_string()
                .as_bytes(),
        );
        let scope_id = container_ir::hex_digest(
            json!([
                app.host_app_id,
                app.tenant_id,
                app.publisher_id,
                app.app_id,
                app.environment,
                config.account.principal_id,
                "managed-files-v1"
            ])
            .to_string()
            .as_bytes(),
        );
        let account = base.join(format!("account-{principal}"));
        checked_dir(&account)?;
        let principal_lock = shared_lock(&account.join(".account.lock"))?;
        let scope_lock = shared_lock(&account.join(format!("managed-{scope_id}.lock")))?;
        let directory = account.join(format!("managed-{scope_id}.files"));
        checked_dir(&directory)?;
        let root = directory.join("user");
        checked_dir(&root)?;
        let auxiliary = directory.join("native");
        checked_dir(&auxiliary)?;
        Ok(Self {
            _principal: principal_lock,
            _scope: scope_lock,
            root,
            auxiliary,
            scope_id,
            config: config.clone(),
        })
    }
    pub fn root(&self) -> &Path {
        &self.root
    }
    pub fn describe(&self) -> Value {
        json!({"root":self.root,"auxiliaryRoot":self.auxiliary,"scopeId":self.scope_id,"application":self.config.application,"account":self.config.account})
    }
    pub fn validate(&self, context: &HostApiCallContext, session: &str) -> Result<(), String> {
        if context.application != self.config.application
            || context.account != self.config.account
            || context.session_id != session
        {
            return Err("managed file operation belongs to a retired native owner".into());
        }
        Ok(())
    }
    fn path(&self, value: &str) -> Result<PathBuf, String> {
        let suffix = value
            .strip_prefix("wxfile://user/")
            .ok_or("file path must use wxfile://user/")?;
        if suffix.is_empty() || suffix.len() > 4096 || suffix.contains(['\\', '\0']) {
            return Err("invalid managed path".into());
        }
        let mut path = self.root.clone();
        let mut depth = 0;
        for part in suffix.split('/') {
            depth += 1;
            if part.is_empty()
                || part == "."
                || part == ".."
                || part.contains(':')
                || part.starts_with(".weapp-")
                || depth > 32
            {
                return Err("invalid managed path segment".into());
            }
            path.push(part);
            if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
                return Err("managed paths cannot traverse symbolic links".into());
            }
        }
        Ok(path)
    }
    pub fn perform(&self, method: &str, payload: &Value) -> Result<Value, String> {
        let leaf = method
            .strip_prefix("object:FileSystemManager.")
            .ok_or("not a managed file API")?;
        let mut result = json!({"errMsg":format!("{leaf}:ok")});
        if matches!(
            leaf,
            "access"
                | "readFile"
                | "writeFile"
                | "appendFile"
                | "copyFile"
                | "rename"
                | "mkdir"
                | "unlink"
                | "rmdir"
                | "readdir"
                | "stat"
        ) {
            let provider = ManagedSyncFileSystem::new(self.root.clone()).map_err(err)?;
            let value = provider
                .invoke(&format!("{method}Sync"), payload.clone())
                .map_err(|error| {
                    error
                        .get("errMsg")
                        .and_then(Value::as_str)
                        .unwrap_or("managed file operation failed")
                        .to_owned()
                })?;
            match leaf {
                "readFile" => result["data"] = value,
                "readdir" => result["files"] = value,
                "stat" => result["stats"] = value,
                _ => {}
            }
            return Ok(result);
        }
        // Saved-file metadata is private to this owner scope and persists across
        // legal package upgrades. The same OS lock also excludes synchronous JS.
        let lock_path = self.root.join(".weapp-operations.lock");
        if fs::symlink_metadata(&lock_path).is_ok_and(|v| v.file_type().is_symlink()) {
            return Err("operation lock cannot be a symlink".into());
        }
        let operation_lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(err)?;
        FileExt::lock_exclusive(&operation_lock).map_err(err)?;
        let mut saved = self.saved()?;
        match leaf {
            "getSavedFileList" => {
                let mut files = Vec::new();
                for entry in saved {
                    let Some(path) = entry.get("filePath").and_then(Value::as_str) else {
                        return Err("invalid saved-file registry".into());
                    };
                    let path = self.path(path)?;
                    if let Ok(metadata) = fs::metadata(&path) {
                        if metadata.is_file() {
                            let mut entry = entry;
                            entry["size"] = json!(metadata.len());
                            files.push(entry);
                        }
                    }
                }
                result["fileList"] = json!(files);
            }
            "saveFile" => {
                let source = self.path(
                    payload
                        .get("tempFilePath")
                        .and_then(Value::as_str)
                        .ok_or("tempFilePath required")?,
                )?;
                if !fs::metadata(&source).map_err(err)?.is_file() {
                    return Err("saveFile requires a managed regular file".into());
                }
                if saved.len() >= 4096 {
                    return Err("saved-file entry limit exceeded".into());
                }
                let virtual_path = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        format!(
                            "wxfile://user/saved-{}-{}-{}",
                            std::process::id(),
                            now_nanos(),
                            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
                        )
                    });
                let destination = self.path(&virtual_path)?;
                if destination.try_exists().map_err(err)? {
                    return Err("saved-file destination already exists".into());
                }
                let size = fs::metadata(&source).map_err(err)?.len();
                fs::rename(&source, &destination).map_err(err)?;
                sync_parents(&source, &destination)?;
                saved.push(json!({"filePath":virtual_path,"size":size,"createTime":now_nanos()/1_000_000_000}));
                if let Err(error) = self.write_saved(&saved) {
                    fs::rename(&destination, &source)
                        .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
                    sync_parents(&source, &destination)?;
                    return Err(error);
                }
                result["savedFilePath"] = json!(virtual_path);
            }
            "removeSavedFile" => {
                let virtual_path = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or("filePath required")?;
                let position = saved
                    .iter()
                    .position(|entry| {
                        entry.get("filePath").and_then(Value::as_str) == Some(virtual_path)
                    })
                    .ok_or("file was not saved by this application")?;
                let path = self.path(virtual_path)?;
                fs::remove_file(&path).map_err(err)?;
                sync_dir(path.parent().ok_or("file parent missing")?)?;
                saved.remove(position);
                self.write_saved(&saved)?;
            }
            _ => return Err("managed file operation is not installed".into()),
        }
        Ok(result)
    }
    fn saved(&self) -> Result<Vec<Value>, String> {
        let path = self.auxiliary.join("saved-files.json");
        if fs::symlink_metadata(&path).is_ok_and(|v| v.file_type().is_symlink()) {
            return Err("saved-file registry cannot be a symlink".into());
        }
        match fs::metadata(&path) {
            Ok(metadata) => {
                if metadata.len() > 1024 * 1024 {
                    return Err("saved-file registry size limit".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(err(e)),
        }
        let entries: Vec<Value> =
            serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
        if entries.len() > 4096 {
            return Err("saved-file registry entry limit".into());
        }
        Ok(entries)
    }
    fn write_saved(&self, entries: &[Value]) -> Result<(), String> {
        let bytes = serde_json::to_vec(entries).map_err(err)?;
        if bytes.len() > 1024 * 1024 {
            return Err("saved-file registry size limit".into());
        }
        let temporary = self.auxiliary.join(format!(
            ".weapp-saved-{}-{}-{}",
            std::process::id(),
            now_nanos(),
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ));
        let write = (|| {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary).map_err(err)?;
            file.write_all(&bytes).map_err(err)?;
            file.sync_all().map_err(err)?;
            fs::rename(&temporary, self.auxiliary.join("saved-files.json")).map_err(err)?;
            sync_dir(&self.auxiliary)
        })();
        if write.is_err() {
            let _ = fs::remove_file(temporary);
        }
        write
    }
}
fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_nanos())
        .unwrap_or(0)
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn checked_dir(path: &Path) -> Result<(), String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("managed scope cannot be a symbolic link".into());
    }
    fs::create_dir_all(path).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(err)?;
    }
    Ok(())
}
fn shared_lock(path: &Path) -> Result<File, String> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("managed scope lock cannot be a symbolic link".into());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(err)?;
    FileExt::try_lock_shared(&lock).map_err(err)?;
    Ok(lock)
}
fn sync_dir(path: &Path) -> Result<(), String> {
    File::open(path).and_then(|v| v.sync_all()).map_err(err)
}
fn sync_parents(source: &Path, destination: &Path) -> Result<(), String> {
    let source = source.parent().ok_or("source parent missing")?;
    let destination = destination.parent().ok_or("destination parent missing")?;
    sync_dir(source)?;
    if source != destination {
        sync_dir(destination)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let value = std::env::temp_dir().join(format!(
                "weapp-harmony-files-{}-{}-{}",
                std::process::id(),
                now_nanos(),
                NEXT_FILE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&value).unwrap();
            Self(value)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn config(user: &str) -> HostServicesConfig {
        serde_json::from_value(json!({"application":{"hostAppId":"host","tenantId":"tenant","publisherId":"publisher","appId":"app","environment":"release","version":"1","packRoot":"a".repeat(64)},"account":{"principalId":user,"epoch":"1"}})).unwrap()
    }
    fn call(files: &ManagedFiles, name: &str, payload: Value) -> Value {
        files
            .perform(&format!("object:FileSystemManager.{name}"), &payload)
            .unwrap()
    }
    #[test]
    fn scope_survives_upgrade_and_epoch_but_isolates_user_app_environment_and_publisher() {
        let directory = Directory::new();
        let alice = config("alice");
        let files = ManagedFiles::open(&directory.0, &alice).unwrap();
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/private","data":"alice"}),
        );
        let mut upgrade = alice.clone();
        upgrade.application.version = "2".into();
        upgrade.application.pack_root = "b".repeat(64);
        upgrade.account.epoch = 9;
        let upgraded = ManagedFiles::open(&directory.0, &upgrade).unwrap();
        assert_eq!(files.root(), upgraded.root());
        assert_eq!(
            call(
                &upgraded,
                "readFile",
                json!({"filePath":"wxfile://user/private","encoding":"utf8"})
            )["data"],
            json!({"__weappSyncText":{"type":"UTF16","units":[97,108,105,99,101]}})
        );
        let mut scopes = vec![config("bob")];
        for field in ["app", "environment", "publisher", "tenant", "host"] {
            let mut value = alice.clone();
            match field {
                "app" => value.application.app_id = "other".into(),
                "environment" => value.application.environment = "develop".into(),
                "publisher" => value.application.publisher_id = "other".into(),
                "tenant" => value.application.tenant_id = "other".into(),
                _ => value.application.host_app_id = "other".into(),
            };
            scopes.push(value);
        }
        for other in scopes {
            let other = ManagedFiles::open(&directory.0, &other).unwrap();
            assert_ne!(other.root(), files.root());
            assert!(other
                .perform(
                    "object:FileSystemManager.readFile",
                    &json!({"filePath":"wxfile://user/private"})
                )
                .is_err());
        }
        let context:HostApiCallContext=serde_json::from_value(json!({"application":alice.application,"account":alice.account,"sessionId":"old","callId":"call","api":"wx.request","deadlineNs":null,"cancelToken":null})).unwrap();
        assert!(files.validate(&context, "old").is_ok());
        assert!(files.validate(&context, "new").is_err());
        assert!(upgraded.validate(&context, "old").is_err());
    }
    #[cfg(unix)]
    #[test]
    fn delegated_async_stat_reads_actual_signed_pre_epoch_file_times() {
        use std::fs::FileTimes;
        use std::os::unix::fs::MetadataExt;
        use std::time::{Duration, UNIX_EPOCH};

        let directory = Directory::new();
        let files = ManagedFiles::open(&directory.0, &config("alice")).unwrap();
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/times","data":"timestamp"}),
        );
        let native = OpenOptions::new()
            .read(true)
            .write(true)
            .open(files.root().join("times"))
            .unwrap();
        native
            .set_times(
                FileTimes::new()
                    .set_accessed(UNIX_EPOCH - Duration::from_millis(1250))
                    .set_modified(UNIX_EPOCH - Duration::from_millis(250)),
            )
            .unwrap();
        let metadata = native.metadata().unwrap();
        for actual in [metadata.accessed().unwrap(), metadata.modified().unwrap()] {
            let distance = UNIX_EPOCH
                .duration_since(actual)
                .expect("Harmony stat fixture must have real pre-epoch metadata");
            assert_ne!(
                distance.subsec_nanos(),
                0,
                "filesystem quantized the fixture; delegated fractional stat is not proven"
            );
        }
        eprintln!(
            "Harmony delegated stat os={} atime=({},{}) mtime=({},{})",
            std::env::consts::OS,
            metadata.atime(),
            metadata.atime_nsec(),
            metadata.mtime(),
            metadata.mtime_nsec()
        );
        let delegated = call(&files, "stat", json!({"path":"wxfile://user/times"}));
        let sync = ManagedSyncFileSystem::new(files.root()).unwrap();
        let direct = sync
            .invoke(
                "object:FileSystemManager.statSync",
                json!({"path":"wxfile://user/times"}),
            )
            .unwrap();
        assert_eq!(delegated["stats"], direct);
        assert_eq!(
            delegated["stats"]["lastAccessedTime"].as_f64(),
            Some(metadata.atime() as f64)
        );
        assert_eq!(
            delegated["stats"]["lastModifiedTime"].as_f64(),
            Some(metadata.mtime() as f64)
        );
        assert_eq!(delegated["errMsg"], "stat:ok");
        assert!(
            files
                .perform(
                    "object:FileSystemManager.stat",
                    &json!({"path":"wxfile://user","recursive":true})
                )
                .is_err(),
            "timestamp work must not imply recursive-stat support"
        );
    }

    #[test]
    fn async_and_true_sync_share_data_binary_bounds_and_cross_owner_append_lock() {
        let directory = Directory::new();
        let config = config("alice");
        let files = Arc::new(ManagedFiles::open(&directory.0, &config).unwrap());
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/append","data":""}),
        );
        let sync = ManagedSyncFileSystem::new(files.root()).unwrap();
        let owner = files.clone();
        let asynchronous = std::thread::spawn(move || {
            for _ in 0..40 {
                call(
                    &owner,
                    "appendFile",
                    json!({"filePath":"wxfile://user/append","data":"a"}),
                );
            }
        });
        let synchronous = std::thread::spawn(move || {
            for _ in 0..40 {
                sync.invoke(
                    "object:FileSystemManager.appendFileSync",
                    json!({"filePath":"wxfile://user/append","data":"s"}),
                )
                .unwrap();
            }
        });
        asynchronous.join().unwrap();
        synchronous.join().unwrap();
        let value = call(
            &files,
            "readFile",
            json!({"filePath":"wxfile://user/append","encoding":"utf8"}),
        );
        let units = value["data"]["__weappSyncText"]["units"]
            .as_array()
            .expect("async native file text stays in the private UTF-16 wire form");
        assert_eq!(units.len(), 80);
        assert_eq!(
            units
                .iter()
                .filter(|unit| unit.as_u64() == Some(97))
                .count(),
            40
        );
        assert_eq!(
            units
                .iter()
                .filter(|unit| unit.as_u64() == Some(115))
                .count(),
            40
        );
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/binary","data":{"__weappBinary":{"type":"ArrayBuffer","bytes":[0,255,128]}}}),
        );
        assert_eq!(
            call(
                &files,
                "readFile",
                json!({"filePath":"wxfile://user/binary","position":1,"length":2})
            )["data"]["__weappBinary"]["bytes"],
            json!([255, 128])
        );
        assert!(files
            .perform(
                "object:FileSystemManager.writeFile",
                &json!({"filePath":"wxfile://user/large","data":"a".repeat(1024*1024+1)})
            )
            .is_err());
        assert_eq!(
            call(&files, "readdir", json!({"dirPath":"wxfile://user/"}))["files"],
            json!(["append", "binary"])
        );
    }
    #[test]
    fn saved_registry_is_persistent_scoped_and_excludes_unsaved_user_files() {
        let directory = Directory::new();
        let config = config("alice");
        let files = ManagedFiles::open(&directory.0, &config).unwrap();
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/unsaved","data":"private"}),
        );
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/temp","data":"saved"}),
        );
        let saved = call(
            &files,
            "saveFile",
            json!({"tempFilePath":"wxfile://user/temp"}),
        )["savedFilePath"]
            .as_str()
            .unwrap()
            .to_owned();
        drop(files);
        let files = ManagedFiles::open(&directory.0, &config).unwrap();
        let list = call(&files, "getSavedFileList", json!({}));
        let list = list["fileList"].as_array().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0]["filePath"], saved);
        assert_eq!(list[0]["size"], 5);
        assert!(list[0]["createTime"].as_u64().unwrap() > 0);
        assert!(files
            .perform(
                "object:FileSystemManager.removeSavedFile",
                &json!({"filePath":"wxfile://user/unsaved"})
            )
            .is_err());
        call(&files, "removeSavedFile", json!({"filePath":saved}));
        assert_eq!(
            call(&files, "getSavedFileList", json!({}))["fileList"],
            json!([])
        );
    }
    #[test]
    fn private_paths_reject_traversal_symlinks_and_scope_deletion_waits_for_lease() {
        let directory = Directory::new();
        let files = ManagedFiles::open(&directory.0, &config("alice")).unwrap();
        for path in [
            "/tmp/file",
            "wxfile://user/../outside",
            "wxfile://user/.weapp-operations.lock",
            "wxfile://user/a//b",
            "wxfile://user/a\\b",
        ] {
            assert!(
                files
                    .perform(
                        "object:FileSystemManager.writeFile",
                        &json!({"filePath":path,"data":"x"})
                    )
                    .is_err(),
                "{path}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&directory.0, files.root().join("escape")).unwrap();
            assert!(files
                .perform(
                    "object:FileSystemManager.writeFile",
                    &json!({"filePath":"wxfile://user/escape/outside","data":"x"})
                )
                .is_err());
        }
        let lock_path = files
            .root()
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(".account.lock");
        let account = OpenOptions::new()
            .read(true)
            .write(true)
            .open(lock_path)
            .unwrap();
        assert!(FileExt::try_lock_exclusive(&account).is_err());
        drop(files);
        assert!(FileExt::try_lock_exclusive(&account).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn delegated_async_stat_preserves_actual_size_mode_and_owned_snapshot() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let directory = Directory::new();
        let files = ManagedFiles::open(&directory.0, &config("alice")).unwrap();
        call(
            &files,
            "writeFile",
            json!({"filePath":"wxfile://user/fixture","data":"three"}),
        );
        let path = files.root().join("fixture");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let before = fs::metadata(&path).unwrap();
        assert_eq!(before.len(), 5);
        assert_eq!(before.mode() & 0o7777, 0o640);
        let first = call(&files, "stat", json!({"path":"wxfile://user/fixture"}));
        assert_eq!(first["stats"]["size"].as_u64(), Some(before.len()));
        assert_eq!(
            first["stats"]["mode"].as_u64(),
            Some(u64::from(before.mode()))
        );
        assert_eq!(first["stats"]["__weappFsStats"], true);
        assert_eq!(first["errMsg"], "stat:ok");
        let native = OpenOptions::new().write(true).open(&path).unwrap();
        native.set_len(4097).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o604)).unwrap();
        let changed = fs::metadata(&path).unwrap();
        let next = call(&files, "stat", json!({"path":"wxfile://user/fixture"}));
        let sync = ManagedSyncFileSystem::new(files.root()).unwrap();
        let direct = sync
            .invoke(
                "object:FileSystemManager.statSync",
                json!({"path":"wxfile://user/fixture"}),
            )
            .unwrap();
        assert_eq!(next["stats"], direct);
        assert_eq!(next["stats"]["size"].as_u64(), Some(changed.len()));
        assert_eq!(
            next["stats"]["mode"].as_u64(),
            Some(u64::from(changed.mode()))
        );
        assert_eq!(first["stats"]["size"].as_u64(), Some(before.len()));
        assert_eq!(
            first["stats"]["mode"].as_u64(),
            Some(u64::from(before.mode()))
        );
        assert!(files
            .perform(
                "object:FileSystemManager.stat",
                &json!({"path":"wxfile://user","recursive":true})
            )
            .is_err());
        drop(native);
    }
}
