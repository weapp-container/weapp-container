use crate::{
    account::{storage_directory, storage_namespace},
    ContainerConfig, SdkError,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    path::PathBuf,
};

/// Native resources share a lease, while account deletion needs exclusive
/// ownership. Keep lock inodes after deletion so processes agree on ownership.
pub(crate) struct ManagedFileScope {
    _principal_lock: File,
    _scope_lock: File,
    root: PathBuf,
    scope_id: String,
}
impl ManagedFileScope {
    pub fn open(config: &ContainerConfig) -> Result<Self, SdkError> {
        let services = config.host_services.as_ref().ok_or_else(|| {
            SdkError::invalid("trusted host services are required for managed files")
        })?;
        let base = config.managed_files_root.as_ref().ok_or_else(|| {
            SdkError::invalid("configure managedFilesRoot before installing native files")
        })?;
        fs::create_dir_all(base).map_err(SdkError::storage)?;
        let base = base.canonicalize().map_err(SdkError::storage)?;
        let directory = storage_directory(&base, &services.application, &services.account)?;
        fs::create_dir_all(&directory).map_err(SdkError::storage)?;
        let principal = shared_lock(directory.join(".account.lock"))?;
        let scope_id = container_ir::hex_digest(
            storage_namespace(&services.application, &services.account, "managed-files-v1")?
                .as_bytes(),
        );
        let scope = shared_lock(directory.join(format!("managed-{scope_id}.lock")))?;
        let root = directory.join(format!("managed-{scope_id}.files"));
        if root
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(SdkError::storage("managed file root cannot be a symlink"));
        }
        for child in [root.join("user"), root.join("native")] {
            if child
                .symlink_metadata()
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err(SdkError::storage(
                    "managed file directories cannot be symbolic links",
                ));
            }
            fs::create_dir_all(child).map_err(SdkError::storage)?;
        }
        Ok(Self {
            _principal_lock: principal,
            _scope_lock: scope,
            root: root.canonicalize().map_err(SdkError::storage)?,
            scope_id,
        })
    }
    pub fn user_root(&self) -> PathBuf {
        self.root.join("user")
    }
    pub fn describe(&self, config: &ContainerConfig) -> Value {
        let services = config
            .host_services
            .as_ref()
            .expect("managed scope requires host services");
        json!({"root":self.root.join("user"),"auxiliaryRoot":self.root.join("native"),"scopeId":self.scope_id,"application":services.application,"account":services.account})
    }
}
fn shared_lock(path: PathBuf) -> Result<File, SdkError> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(SdkError::storage)?;
    FileExt::try_lock_shared(&lock)
        .map_err(|_| SdkError::new("ERR_STORAGE_LOCKED", "account data is being deleted"))?;
    Ok(lock)
}
