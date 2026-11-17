//! Owner-local file descriptors. No OS descriptor or native path crosses into JS.
use super::*;
use std::collections::BTreeMap;

pub(super) const MEMBERS: &[&str] = &[
    "openSync",
    "closeSync",
    "readSync",
    "writeSync",
    "fstatSync",
    "ftruncateSync",
    "truncateSync",
];
const MAX_DESCRIPTORS: usize = 64;
static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);

struct Descriptor {
    file: File,
    readable: bool,
    writable: bool,
    append: bool,
}
pub(super) struct Descriptors {
    owner: u64,
    next: u64,
    files: BTreeMap<String, Descriptor>,
}
impl Descriptors {
    pub(super) fn new() -> Self {
        Self {
            owner: NEXT_OWNER.fetch_add(1, Ordering::Relaxed),
            next: 0,
            files: BTreeMap::new(),
        }
    }
    pub(super) fn clear(&mut self) {
        self.files.clear();
    }
}

fn integer(payload: &Value, key: &str, default: u64) -> Result<u64, String> {
    payload
        .get(key)
        .filter(|v| !v.is_null())
        .map(|v| {
            v.as_u64()
                .ok_or_else(|| format!("{key} must be a nonnegative integer"))
        })
        .unwrap_or(Ok(default))
}

impl ManagedSyncFileSystem {
    // Reserve live handle sizes as well as directory bytes. This deliberately
    // conservative bound also covers renamed/unlinked handles and concurrent
    // pathname replacement by the async adapter. Closing releases reservations.
    pub(super) fn descriptor_quota(
        &self,
        descriptors: &Descriptors,
        growth: u64,
    ) -> Result<(), String> {
        let mut reserved = self.disk_bytes()?;
        for descriptor in descriptors.files.values() {
            reserved = reserved
                .checked_add(descriptor.file.metadata().map_err(|e| e.to_string())?.len())
                .ok_or("managed descriptor byte reservation overflow")?;
        }
        if reserved
            .checked_add(growth.saturating_mul(2))
            .is_none_or(|v| v > QUOTA)
        {
            return Err("managed file and open descriptor quota exceeded".into());
        }
        Ok(())
    }

    pub(super) fn descriptor_call(&self, member: &str, payload: &Value) -> Result<Value, String> {
        let mut descriptors = self
            .descriptors
            .lock()
            .map_err(|_| "file descriptor owner poisoned")?;
        if member == "truncateSync" {
            let path = self.path(
                payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or("filePath is required")?,
                false,
            )?;
            let length = integer(payload, "length", 0)?;
            let file = OpenOptions::new()
                .write(true)
                .open(path)
                .map_err(|e| e.to_string())?;
            let previous = file.metadata().map_err(|e| e.to_string())?.len();
            self.descriptor_quota(&descriptors, length.saturating_sub(previous))?;
            file.set_len(length)
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        if member == "openSync" {
            if descriptors.files.len() >= MAX_DESCRIPTORS {
                return Err("open file descriptor budget exceeded".into());
            }
            let path = self.path(
                payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .ok_or("filePath is required")?,
                false,
            )?;
            let flag = payload
                .get("flag")
                .map(|v| v.as_str().ok_or("flag must be a string"))
                .transpose()?
                .unwrap_or("r");
            let (readable, writable, append, truncate, exclusive, create) = match flag {
                "r" => (true, false, false, false, false, false),
                "r+" => (true, true, false, false, false, false),
                "w" => (false, true, false, true, false, true),
                "w+" => (true, true, false, true, false, true),
                "wx" => (false, true, false, true, true, true),
                "wx+" => (true, true, false, true, true, true),
                "a" | "as" => (false, true, true, false, false, true),
                "a+" | "as+" => (true, true, true, false, false, true),
                "ax" => (false, true, true, false, true, true),
                "ax+" => (true, true, true, false, true, true),
                _ => return Err("unsupported file open flag".into()),
            };
            // Issue the opaque token before any destructive open; exhaustion
            // cannot truncate a file and then report failure.
            let next = descriptors
                .next
                .checked_add(1)
                .ok_or("file descriptor sequence exhausted")?;
            self.descriptor_quota(&descriptors, 0)?;
            let reserve = fs::metadata(&path).map(|v| v.len()).unwrap_or(0);
            if !truncate {
                self.descriptor_quota(&descriptors, reserve)?;
            }
            let mut options = OpenOptions::new();
            options
                .read(readable)
                .write(writable)
                .append(append)
                .create(create)
                .create_new(exclusive)
                .truncate(truncate);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options.open(&path).map_err(|e| e.to_string())?;
            if !file.metadata().map_err(|e| e.to_string())?.is_file() {
                return Err("descriptor must refer to a regular file".into());
            }
            if writable {
                file.sync_all().map_err(|e| e.to_string())?;
                Self::sync_directory(path.parent().ok_or("file parent missing")?)?;
            }
            let fd = format!("syncfd-{}-{next}", descriptors.owner);
            descriptors.next = next;
            descriptors.files.insert(
                fd.clone(),
                Descriptor {
                    file,
                    readable,
                    writable,
                    append,
                },
            );
            return Ok(Value::String(fd));
        }
        let fd = payload
            .get("fd")
            .and_then(Value::as_str)
            .ok_or("fd must be an owner-local string")?;
        if !descriptors.files.contains_key(fd) {
            return Err("invalid or closed file descriptor".into());
        }
        if member == "closeSync" {
            descriptors.files.remove(fd);
            return Ok(Value::Null);
        }
        if member == "fstatSync" {
            return descriptors.files[fd]
                .file
                .metadata()
                .map_err(|e| e.to_string())
                .and_then(stats::from_metadata);
        }
        if member == "ftruncateSync" {
            let descriptor = &descriptors.files[fd];
            if !descriptor.writable {
                return Err("file descriptor is not writable".into());
            }
            let length = integer(payload, "length", 0)?;
            let previous = descriptor.file.metadata().map_err(|e| e.to_string())?.len();
            self.descriptor_quota(&descriptors, length.saturating_sub(previous))?;
            descriptor
                .file
                .set_len(length)
                .and_then(|_| descriptor.file.sync_all())
                .map_err(|e| e.to_string())?;
            return Ok(Value::Null);
        }
        if member == "readSync" {
            let input = payload
                .get("arrayBuffer")
                .filter(|v| v.is_object())
                .ok_or("arrayBuffer is required")?;
            let mut buffer = Self::bytes(&json!({"data":input}))?;
            let offset = integer(payload, "offset", 0)?;
            let length = integer(payload, "length", 0)?;
            let end = offset
                .checked_add(length)
                .filter(|v| *v <= buffer.len() as u64)
                .ok_or("read exceeds ArrayBuffer bounds")?;
            let descriptor = descriptors
                .files
                .get_mut(fd)
                .expect("validated file descriptor");
            if !descriptor.readable {
                return Err("file descriptor is not readable".into());
            }
            let previous = descriptor
                .file
                .stream_position()
                .map_err(|e| e.to_string())?;
            let position = payload
                .get("position")
                .filter(|v| !v.is_null())
                .map(|v| v.as_u64().ok_or("position must be a nonnegative integer"))
                .transpose()?;
            if let Some(position) = position {
                descriptor
                    .file
                    .seek(SeekFrom::Start(position))
                    .map_err(|e| e.to_string())?;
            }
            let result = (|| {
                let mut read = 0;
                while read < length as usize {
                    let n = descriptor
                        .file
                        .read(&mut buffer[offset as usize + read..end as usize])
                        .map_err(|e| e.to_string())?;
                    if n == 0 {
                        break;
                    }
                    read += n;
                }
                Ok(
                    json!({"bytesRead":read,"arrayBuffer":{"__weappBinary":{"type":"ArrayBuffer","bytes":buffer}}}),
                )
            })();
            if position.is_some() {
                descriptor
                    .file
                    .seek(SeekFrom::Start(previous))
                    .map_err(|e| e.to_string())?;
            }
            return result;
        }
        if member == "writeSync" {
            let bytes = Self::bytes(payload)?;
            let binary = payload
                .get("data")
                .is_some_and(|data| data.get("__weappBinary").is_some());
            let offset = if binary {
                integer(payload, "offset", 0)?
            } else {
                0
            };
            let remaining = (bytes.len() as u64)
                .checked_sub(offset)
                .ok_or("write offset exceeds buffer")?;
            let length = if binary {
                integer(payload, "length", remaining)?
            } else {
                bytes.len() as u64
            };
            let end = offset
                .checked_add(length)
                .filter(|v| *v <= bytes.len() as u64)
                .ok_or("write exceeds ArrayBuffer bounds")?;
            let descriptor = descriptors
                .files
                .get_mut(fd)
                .expect("validated file descriptor");
            if !descriptor.writable {
                return Err("file descriptor is not writable".into());
            }
            let previous = descriptor
                .file
                .stream_position()
                .map_err(|e| e.to_string())?;
            // Per baseline, non-number positions mean the current pointer.
            let position = payload
                .get("position")
                .filter(|v| v.is_number())
                .map(|v| v.as_u64().ok_or("position must be a nonnegative integer"))
                .transpose()?;
            let size = descriptor.file.metadata().map_err(|e| e.to_string())?.len();
            let start = if descriptor.append {
                size
            } else {
                position.unwrap_or(previous)
            };
            let projected = start.checked_add(length).ok_or("write position overflow")?;
            self.descriptor_quota(&descriptors, projected.saturating_sub(size))?;
            let descriptor = descriptors
                .files
                .get_mut(fd)
                .expect("validated file descriptor");
            if let Some(position) = position {
                descriptor
                    .file
                    .seek(SeekFrom::Start(position))
                    .map_err(|e| e.to_string())?;
            }
            let result = descriptor
                .file
                .write_all(&bytes[offset as usize..end as usize])
                .and_then(|_| descriptor.file.sync_all())
                .map_err(|e| e.to_string());
            if position.is_some() {
                descriptor
                    .file
                    .seek(SeekFrom::Start(previous))
                    .map_err(|e| e.to_string())?;
            }
            result?;
            return Ok(json!({"bytesWritten":length}));
        }
        Err("unsupported descriptor operation".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Scope(PathBuf);
    impl Scope {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "weapp-fd-{}-{}",
                std::process::id(),
                NEXT_OWNER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn provider(&self) -> ManagedSyncFileSystem {
            ManagedSyncFileSystem::new(&self.0).unwrap()
        }
    }
    impl Drop for Scope {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn call(provider: &ManagedSyncFileSystem, member: &str, value: Value) -> Result<Value, Value> {
        provider.invoke(&format!("object:FileSystemManager.{member}"), value)
    }
    fn open(provider: &ManagedSyncFileSystem, name: &str, flag: &str) -> Value {
        call(
            provider,
            "openSync",
            json!({"filePath":format!("wxfile://user/{name}"),"flag":flag}),
        )
        .unwrap()
    }

    #[test]
    fn descriptors_are_owner_local_closed_tokens_never_recur_and_retirement_drains() {
        let scope = Scope::new();
        let owner = scope.provider();
        let other = scope.provider();
        let fd = open(&owner, "a", "w+");
        assert!(call(&other, "fstatSync", json!({"fd":fd})).is_err());
        call(&owner, "closeSync", json!({"fd":fd})).unwrap();
        assert!(call(&owner, "closeSync", json!({"fd":fd})).is_err());
        let next = open(&owner, "a", "r");
        assert_ne!(fd, next);
        owner.retire();
        assert!(owner.descriptors.lock().unwrap().files.is_empty());
        assert_eq!(
            call(&owner, "fstatSync", json!({"fd":next})).unwrap_err()["code"],
            "ERR_CANCELLED"
        );
        assert!(call(&other, "accessSync", json!({"path":"wxfile://user/a"})).is_ok());
    }

    #[test]
    fn flags_exclusivity_permissions_and_append_use_real_files() {
        let scope = Scope::new();
        let owner = scope.provider();
        assert!(call(
            &owner,
            "openSync",
            json!({"filePath":"wxfile://user/missing","flag":"r"})
        )
        .is_err());
        let fd = open(&owner, "a", "wx+");
        assert!(call(
            &owner,
            "openSync",
            json!({"filePath":"wxfile://user/a","flag":"wx+"})
        )
        .is_err());
        assert_eq!(
            call(&owner, "writeSync", json!({"fd":fd,"data":"你好"})).unwrap()["bytesWritten"],
            6
        );
        let read_only = open(&owner, "a", "r");
        assert!(call(&owner, "writeSync", json!({"fd":read_only,"data":"bad"})).is_err());
        assert!(call(&owner, "ftruncateSync", json!({"fd":read_only,"length":0})).is_err());
        let append = open(&owner, "a", "as+");
        call(
            &owner,
            "writeSync",
            json!({"fd":append,"data":"!","position":0}),
        )
        .unwrap();
        assert_eq!(fs::read(scope.0.join("a")).unwrap(), "你好!".as_bytes());
        assert!(call(
            &owner,
            "openSync",
            json!({"filePath":"wxfile://user/../escape","flag":"w"})
        )
        .is_err());
    }

    #[test]
    fn truncate_zero_fills_and_quotas_reject_before_mutation() {
        let scope = Scope::new();
        let owner = scope.provider();
        let fd = open(&owner, "a", "w+");
        call(&owner, "writeSync", json!({"fd":fd,"data":"abc"})).unwrap();
        call(&owner, "ftruncateSync", json!({"fd":fd,"length":5})).unwrap();
        assert_eq!(fs::read(scope.0.join("a")).unwrap(), b"abc\0\0");
        assert!(call(&owner, "ftruncateSync", json!({"fd":fd,"length":QUOTA+1})).is_err());
        assert_eq!(fs::metadata(scope.0.join("a")).unwrap().len(), 5);
        call(
            &owner,
            "truncateSync",
            json!({"filePath":"wxfile://user/a","length":1}),
        )
        .unwrap();
        assert_eq!(fs::read(scope.0.join("a")).unwrap(), b"a");
    }

    #[test]
    fn read_rejects_bad_bounds_and_preserves_pointer_for_explicit_positions() {
        let scope = Scope::new();
        let owner = scope.provider();
        let fd = open(&owner, "a", "w+");
        call(
            &owner,
            "writeSync",
            json!({"fd":fd,"data":"abc","position":0}),
        )
        .unwrap();
        let buffer = json!({"__weappBinary":{"type":"ArrayBuffer","bytes":[9,9,9,9]}});
        assert!(call(
            &owner,
            "readSync",
            json!({"fd":fd,"arrayBuffer":buffer,"offset":3,"length":2})
        )
        .is_err());
        assert!(call(&owner, "readSync", json!({"fd":fd,"arrayBuffer":"text"})).is_err());
        let explicit = call(
            &owner,
            "readSync",
            json!({"fd":fd,"arrayBuffer":buffer,"offset":1,"length":3,"position":1}),
        )
        .unwrap();
        assert_eq!(explicit["bytesRead"], 2);
        assert_eq!(
            explicit["arrayBuffer"]["__weappBinary"]["bytes"],
            json!([9, 98, 99, 9])
        );
        let current = call(
            &owner,
            "readSync",
            json!({"fd":fd,"arrayBuffer":buffer,"length":1}),
        )
        .unwrap();
        assert_eq!(
            current["arrayBuffer"]["__weappBinary"]["bytes"],
            json!([97, 9, 9, 9])
        );
        for number in [json!(-1), json!(1.5), json!("1")] {
            assert!(call(
                &owner,
                "readSync",
                json!({"fd":fd,"arrayBuffer":buffer,"length":number})
            )
            .is_err());
        }
    }

    #[test]
    fn descriptor_limit_is_bounded_and_close_releases_capacity() {
        let scope = Scope::new();
        let owner = scope.provider();
        let first = open(&owner, "a", "w+");
        for _ in 1..MAX_DESCRIPTORS {
            open(&owner, "a", "r");
        }
        assert!(call(&owner, "openSync", json!({"filePath":"wxfile://user/a"})).is_err());
        call(&owner, "closeSync", json!({"fd":first})).unwrap();
        open(&owner, "a", "r");
    }

    #[test]
    fn retirement_panics_are_contained_sticky_and_never_reopen_calls() {
        struct PanickingProvider(AtomicU64);
        impl SyncHostApi for PanickingProvider {
            fn supported_apis(&self) -> Vec<String> {
                vec!["object:FileSystemManager.openSync".into()]
            }
            fn invoke(&self, _: &str, _: Value) -> Result<Value, Value> {
                panic!("retired provider must not execute");
            }
            fn retire(&self) {
                self.0.fetch_add(1, Ordering::SeqCst);
                panic!("deliberate retirement failure");
            }
        }
        let provider = Arc::new(PanickingProvider(AtomicU64::new(0)));
        let binding = SyncBinding::new(provider.clone());
        let error = binding.revoke().unwrap_err();
        assert_eq!(binding.revoke().unwrap_err(), error);
        assert_eq!(provider.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            binding
                .invoke("object:FileSystemManager.openSync", json!({}))
                .unwrap_err()["code"],
            "ERR_CANCELLED"
        );
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| drop(binding))).is_ok());
        // A provider panic is caught even if Drop itself runs during a separate
        // application unwind; it cannot escape into the FFI or double-panic.
        assert!(std::panic::catch_unwind(|| {
            let _binding = SyncBinding::new(Arc::new(PanickingProvider(AtomicU64::new(0))));
            panic!("outer application failure");
        })
        .is_err());
    }

    #[test]
    fn binding_revocation_drains_an_already_admitted_external_provider() {
        struct WaitingProvider {
            entered: Arc<std::sync::Barrier>,
            release: Arc<std::sync::Barrier>,
        }
        impl SyncHostApi for WaitingProvider {
            fn supported_apis(&self) -> Vec<String> {
                vec!["object:FileSystemManager.accessSync".into()]
            }
            fn invoke(&self, _: &str, _: Value) -> Result<Value, Value> {
                self.entered.wait();
                self.release.wait();
                Ok(Value::Null)
            }
        }
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let binding = Arc::new(SyncBinding::new(Arc::new(WaitingProvider {
            entered: entered.clone(),
            release: release.clone(),
        })));
        binding.allow(BTreeSet::from([
            "object:FileSystemManager.accessSync".into()
        ]));
        let call_binding = binding.clone();
        let invocation = std::thread::spawn(move || {
            call_binding.invoke("object:FileSystemManager.accessSync", json!({}))
        });
        entered.wait();
        let revoking = binding.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let revoke = std::thread::spawn(move || {
            let result = revoking.revoke();
            done_tx.send(result).unwrap();
        });
        // A deadline only guards the negative assertion; barriers establish
        // actual admission and prevent scheduler timing from faking a drain.
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_millis(25))
            .is_err());
        release.wait();
        assert_eq!(invocation.join().unwrap().unwrap(), Value::Null);
        assert!(done_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap()
            .is_ok());
        revoke.join().unwrap();
        assert_eq!(
            binding
                .invoke("object:FileSystemManager.accessSync", json!({}))
                .unwrap_err()["code"],
            "ERR_CANCELLED"
        );
    }
}
