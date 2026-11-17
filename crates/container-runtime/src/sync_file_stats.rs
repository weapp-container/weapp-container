//! One owned Stats snapshot for both path and open-file metadata producers.
use serde_json::{json, Number, Value};
use std::fs;
use std::io;
use std::time::{SystemTime, UNIX_EPOCH};

struct StatsTimes {
    accessed: i128,
    modified: i128,
}

impl StatsTimes {
    fn read(
        accessed: io::Result<SystemTime>,
        modified: io::Result<SystemTime>,
    ) -> Result<Self, String> {
        let accessed =
            accessed.map_err(|error| format!("cannot read Stats.lastAccessedTime: {error}"))?;
        let modified =
            modified.map_err(|error| format!("cannot read Stats.lastModifiedTime: {error}"))?;
        Ok(Self {
            accessed: posix_seconds(accessed),
            modified: posix_seconds(modified),
        })
    }
}

// The locked fields correspond to POSIX st_atime/st_mtime: signed whole
// seconds, with a fractional pre-epoch instant belonging to the preceding
// second. Keep the arithmetic integral until the JavaScript number boundary.
fn posix_seconds(time: SystemTime) -> i128 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i128::from(duration.as_secs()),
        Err(error) => {
            let distance = error.duration();
            -i128::from(distance.as_secs()) - i128::from(distance.subsec_nanos() != 0)
        }
    }
}

// Preserve the existing JSON integer wire representation where serde_json
// supports it. JavaScript still receives ordinary Numbers for every branch.
fn timestamp_number(seconds: i128) -> Number {
    if let Ok(value) = i64::try_from(seconds) {
        Number::from(value)
    } else if let Ok(value) = u64::try_from(seconds) {
        Number::from(value)
    } else {
        // A SystemTime distance is bounded by Duration's u64 seconds plus
        // one floor-adjustment second, far below the finite f64 limit.
        Number::from_f64(seconds as f64).expect("SystemTime epoch seconds are finite")
    }
}

struct StatsSnapshot {
    size: u64,
    mode: u32,
    times: StatsTimes,
    directory: bool,
    file: bool,
}

impl StatsSnapshot {
    fn read(metadata: fs::Metadata) -> Result<Self, String> {
        let times = StatsTimes::read(metadata.accessed(), metadata.modified())?;
        #[cfg(unix)]
        let mode = {
            use std::os::unix::fs::MetadataExt;
            metadata.mode()
        };
        #[cfg(not(unix))]
        let mode = if metadata.is_dir() {
            0o040700
        } else {
            0o100600
        };
        Ok(Self {
            size: metadata.len(),
            mode,
            times,
            directory: metadata.is_dir(),
            file: metadata.is_file(),
        })
    }

    fn into_value(self) -> Value {
        // Keep ordinary timestamps as JSON integers. Values outside JSON's
        // i64/u64 representation use finite floating JSON numbers; no additional
        // safe-integer rejection is imposed on the locked JavaScript number.
        // JS applies normal Number precision after either representation.
        json!({
            "__weappFsStats": true,
            "size": self.size,
            "mode": self.mode,
            "lastAccessedTime": timestamp_number(self.times.accessed),
            "lastModifiedTime": timestamp_number(self.times.modified),
            "isDirectory": self.directory,
            "isFile": self.file,
        })
    }
}

pub(super) fn from_metadata(metadata: fs::Metadata) -> Result<Value, String> {
    StatsSnapshot::read(metadata).map(StatsSnapshot::into_value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn signed_posix_seconds_floor_negative_fractional_instants() {
        let cases = [
            (UNIX_EPOCH - Duration::from_millis(1250), -2),
            (UNIX_EPOCH - Duration::from_secs(1), -1),
            (UNIX_EPOCH - Duration::from_millis(250), -1),
            (UNIX_EPOCH - Duration::from_nanos(100), -1),
            (UNIX_EPOCH, 0),
            (UNIX_EPOCH + Duration::from_nanos(100), 0),
            (UNIX_EPOCH + Duration::from_millis(250), 0),
            (UNIX_EPOCH + Duration::from_secs(1), 1),
            (UNIX_EPOCH + Duration::from_millis(1250), 1),
        ];
        for (time, expected) in cases {
            assert_eq!(posix_seconds(time), expected, "{time:?}");
        }
    }

    #[test]
    fn either_timestamp_accessor_failure_rejects_the_snapshot() {
        for (accessed, modified, field) in [
            (true, false, "lastAccessedTime"),
            (false, true, "lastModifiedTime"),
            (true, true, "lastAccessedTime"),
        ] {
            let read = |fail| {
                if fail {
                    Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "time unavailable",
                    ))
                } else {
                    Ok(UNIX_EPOCH)
                }
            };
            let error = match StatsTimes::read(read(accessed), read(modified)) {
                Err(error) => error,
                Ok(_) => panic!("an unavailable required timestamp became a successful snapshot"),
            };
            assert!(error.contains(field), "{error}");
            assert!(error.contains("time unavailable"), "{error}");
        }
    }

    #[test]
    fn timestamp_wire_values_use_number_precision_without_a_safe_integer_rejection() {
        assert_eq!(timestamp_number(0).as_u64(), Some(0));
        assert_eq!(timestamp_number(-1).as_i64(), Some(-1));
        assert_eq!(
            timestamp_number(i128::from(i64::MIN)).as_i64(),
            Some(i64::MIN)
        );
        assert_eq!(
            timestamp_number(i128::from(u64::MAX)).as_u64(),
            Some(u64::MAX)
        );
        let beyond_exact_integer = 9_007_199_254_740_993_i128;
        let snapshot = StatsSnapshot {
            size: 0,
            mode: 0o100600,
            times: StatsTimes {
                accessed: beyond_exact_integer,
                modified: -beyond_exact_integer,
            },
            directory: false,
            file: true,
        }
        .into_value();
        let round_trip: Value = serde_json::from_str(&snapshot.to_string()).unwrap();
        assert_eq!(
            round_trip["lastAccessedTime"].as_u64(),
            Some(9_007_199_254_740_993)
        );
        assert_eq!(
            round_trip["lastModifiedTime"].as_i64(),
            Some(-9_007_199_254_740_993)
        );
        let outside_signed_json = timestamp_number(-i128::from(u64::MAX) - 1);
        assert!(outside_signed_json.is_f64());
        assert!(outside_signed_json.as_f64().unwrap().is_finite());
        assert_eq!(
            round_trip["lastAccessedTime"].as_f64(),
            Some(9_007_199_254_740_992.0)
        );
        assert_eq!(
            round_trip["lastModifiedTime"].as_f64(),
            Some(-9_007_199_254_740_992.0)
        );
    }

    #[cfg(any(unix, windows))]
    mod actual_files {
        use super::*;
        use crate::ManagedSyncFileSystem;
        use container_core::SyncHostApi;
        use std::fs::{FileTimes, OpenOptions};
        use std::io::Write;
        use std::path::PathBuf;
        use std::sync::atomic::{AtomicU64, Ordering};

        struct Directory(PathBuf);
        impl Directory {
            fn new() -> Self {
                static NEXT: AtomicU64 = AtomicU64::new(1);
                let root = std::env::temp_dir().join(format!(
                    "weapp-stats-times-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                ));
                fs::create_dir(&root).unwrap();
                Self(root)
            }
        }
        impl Drop for Directory {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }

        // Read the native stat/FILETIME values independently of the production
        // SystemTime converter, including signed whole-second normalization.
        #[cfg(unix)]
        fn expected(metadata: &fs::Metadata) -> (f64, f64) {
            use std::os::unix::fs::MetadataExt;
            (metadata.atime() as f64, metadata.mtime() as f64)
        }
        #[cfg(windows)]
        fn expected(metadata: &fs::Metadata) -> (f64, f64) {
            use std::os::windows::fs::MetadataExt;
            let seconds = |ticks: u64| {
                (i128::from(ticks) - 116_444_736_000_000_000_i128).div_euclid(10_000_000) as f64
            };
            (
                seconds(metadata.last_access_time()),
                seconds(metadata.last_write_time()),
            )
        }

        #[test]
        fn path_and_descriptor_stats_read_actual_controlled_pre_epoch_file_times() {
            let directory = Directory::new();
            let native_path = directory.0.join("fixture.bin");
            let mut file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&native_path)
                .unwrap();
            file.write_all(&[0, 128, 255]).unwrap();
            let provider = ManagedSyncFileSystem::new(directory.0.clone()).unwrap();
            // Open before controlling atime; no test reads contents afterward.
            let fd = provider
                .invoke(
                    "object:FileSystemManager.openSync",
                    json!({"filePath":"wxfile://user/fixture.bin","flag":"r"}),
                )
                .unwrap();
            for (name, accessed, modified) in [
                (
                    "negative-fractional",
                    UNIX_EPOCH - Duration::from_millis(1250),
                    UNIX_EPOCH - Duration::from_millis(250),
                ),
                ("epoch", UNIX_EPOCH, UNIX_EPOCH),
                (
                    "positive-fractional",
                    UNIX_EPOCH + Duration::from_millis(1250),
                    UNIX_EPOCH + Duration::from_millis(2250),
                ),
            ] {
                file.set_times(
                    FileTimes::new()
                        .set_accessed(accessed)
                        .set_modified(modified),
                )
                .unwrap_or_else(|error| {
                    panic!(
                        "{} {name}: cannot establish real file times: {error}",
                        std::env::consts::OS
                    )
                });
                let before = file.metadata().unwrap();
                let actual_accessed = before.accessed().unwrap();
                let actual_modified = before.modified().unwrap();
                eprintln!(
                    "Stats FileTimes os={} fixture={name} requested=({accessed:?},{modified:?}) observed=({actual_accessed:?},{actual_modified:?})",
                    std::env::consts::OS
                );
                if name == "negative-fractional" {
                    for actual in [actual_accessed, actual_modified] {
                        let distance = UNIX_EPOCH
                            .duration_since(actual)
                            .expect("filesystem did not preserve a pre-epoch fixture");
                        assert_ne!(distance.subsec_nanos(), 0,
                            "filesystem quantized the fixture; negative fractional wiring is not proven");
                    }
                }
                let expected = expected(&before);
                let path = provider
                    .invoke(
                        "object:FileSystemManager.statSync",
                        json!({"path":"wxfile://user/fixture.bin"}),
                    )
                    .unwrap();
                let descriptor = provider
                    .invoke("object:FileSystemManager.fstatSync", json!({"fd":fd}))
                    .unwrap();
                assert_eq!(path["lastAccessedTime"].as_f64(), Some(expected.0));
                assert_eq!(path["lastModifiedTime"].as_f64(), Some(expected.1));
                assert_eq!(path["size"], 3);
                assert_eq!(path["isFile"], true);
                assert_eq!(path, descriptor, "path and descriptor converters diverged");
                assert_eq!(
                    expected,
                    self::expected(&file.metadata().unwrap()),
                    "metadata-only calls changed the controlled file times"
                );
            }
            provider
                .invoke("object:FileSystemManager.closeSync", json!({"fd":fd}))
                .unwrap();
        }
    }
}

#[cfg(test)]
mod size_mode_contract_tests {
    use super::*;

    #[test]
    fn full_u64_size_domain_preserves_integer_wire_before_the_js_number_boundary() {
        // This intentionally tests the converter/wire domain, not OS support
        // for files of each size. Real large-file coverage is separate/ignored.
        for size in [
            0,
            1,
            4_294_967_297,
            9_007_199_254_740_991,
            9_007_199_254_740_992,
            9_007_199_254_740_993,
            u64::MAX,
        ] {
            let stats = StatsSnapshot {
                size,
                mode: 0o100640,
                times: StatsTimes {
                    accessed: 0,
                    modified: 0,
                },
                directory: false,
                file: true,
            }
            .into_value();
            let raw = stats.to_string();
            let decoded: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(decoded["size"].as_u64(), Some(size));
            assert!(decoded["size"].as_f64().unwrap().is_finite());
            assert_eq!(decoded["size"].as_f64(), Some(size as f64));
        }
    }

    #[cfg(unix)]
    #[test]
    fn actual_directory_and_symlink_metadata_keep_native_size_and_mode() {
        use container_core::SyncHostApi;
        use std::os::unix::ffi::OsStrExt;
        use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
        struct Directory(std::path::PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                fs::remove_dir_all(&self.0).unwrap();
            }
        }
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let root = Directory(std::env::temp_dir().join(format!(
            "weapp-stats-native-shapes-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        )));
        fs::create_dir(&root.0).unwrap();
        let target = root.0.join("target.bin");
        fs::write(&target, b"actual target bytes").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o640)).unwrap();
        let child = root.0.join("directory");
        fs::create_dir(&child).unwrap();
        fs::set_permissions(&child, fs::Permissions::from_mode(0o751)).unwrap();
        let relative_target = std::path::Path::new("target.bin");
        let link = root.0.join("link");
        symlink(relative_target, &link).unwrap();

        for metadata in [
            fs::metadata(&target).unwrap(),
            fs::metadata(&child).unwrap(),
            fs::metadata(&link).unwrap(),
            fs::symlink_metadata(&link).unwrap(),
        ] {
            let size = metadata.len();
            let mode = metadata.mode();
            let is_file = metadata.is_file();
            let is_directory = metadata.is_dir();
            let stats = from_metadata(metadata).unwrap();
            assert_eq!(stats["size"].as_u64(), Some(size));
            assert_eq!(stats["mode"].as_u64(), Some(u64::from(mode)));
            assert_eq!(stats["isFile"], is_file);
            assert_eq!(stats["isDirectory"], is_directory);
        }
        let link_metadata = fs::symlink_metadata(&link).unwrap();
        assert_eq!(
            link_metadata.len(),
            relative_target.as_os_str().as_bytes().len() as u64
        );
        assert_eq!(link_metadata.mode() & 0o170000, 0o120000);
        let provider = crate::ManagedSyncFileSystem::new(root.0.clone()).unwrap();
        assert!(
            provider
                .invoke(
                    "object:FileSystemManager.statSync",
                    json!({"path":"wxfile://user/link"})
                )
                .is_err(),
            "managed producer symlink policy is separate from converter semantics"
        );
        let directory = provider
            .invoke(
                "object:FileSystemManager.statSync",
                json!({"path":"wxfile://user/directory"}),
            )
            .unwrap();
        assert_eq!(directory["mode"].as_u64().unwrap() & 0o7777, 0o751);
        assert_eq!(
            directory["size"].as_u64(),
            Some(fs::metadata(child).unwrap().len())
        );
    }
}
