// Included by host_services_tests.rs inside the existing native engine harness.
#[cfg(any(unix, windows))]
fn native_stats_size_is_actual_and_writable(engine: EngineKind) {
    use std::fs::{self, OpenOptions};
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let directory = Directory(std::env::temp_dir().join(format!(
        "weapp-js-stats-portable-size-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    fs::create_dir(&directory.0).unwrap();
    let native = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(directory.0.join("fixture.bin"))
        .unwrap();
    fs::create_dir(directory.0.join("directory")).unwrap();
    let provider = Arc::new(ManagedSyncFileSystem::new(directory.0.clone()).unwrap());
    let source = r#"
const fs=wx.getFileSystemManager();let fd,retained;
function shape(stats){const d=Object.getOwnPropertyDescriptor(stats,'size');return {
  size:stats.size,type:typeof stats.size,finite:Number.isFinite(stats.size),
  ownData:!!d&&Object.prototype.hasOwnProperty.call(d,'value')&&d.writable&&d.enumerable&&d.configurable};}
exports.open=()=>{fd=fs.openSync({filePath:'wxfile://user/fixture.bin',flag:'r'});return true;};
exports.capture=()=>{retained=fs.statSync('wxfile://user/fixture.bin');return shape(retained);};
exports.current=()=>[shape(fs.statSync('wxfile://user/fixture.bin')),shape(fs.fstatSync({fd})),
  shape(fs.statSync('wxfile://user/directory'))];
exports.retained=()=>shape(retained);
exports.mutate=()=>{retained.size=-17;return retained.size;};
exports.close=()=>{fs.closeSync({fd});return true;};
"#;
    let mut session = make_bound_mode(
        engine,
        source,
        &["wx.getFileSystemManager"],
        &[],
        container_render_skia::PageRenderMode::Raster,
        Some(provider.clone()),
    );
    let factory = calls(&mut session);
    assert_eq!(factory.len(), 1);
    session
        .complete_host_api_call(
            &factory[0].0,
            Ok(json!({"objectId":factory[0].2["objectId"]})),
        )
        .unwrap();
    assert_eq!(call(&mut session, "open"), true);
    let shape = |size: i64| json!({"size":size,"type":"number","finite":true,"ownData":true});
    assert_eq!(call(&mut session, "capture"), shape(0));
    for size in [0_u64, 1, 4097] {
        native.set_len(size).unwrap();
        assert_eq!(native.metadata().unwrap().len(), size);
        let directory_size = fs::metadata(directory.0.join("directory")).unwrap().len();
        let size = i64::try_from(size).unwrap();
        let directory_size = i64::try_from(directory_size).unwrap();
        assert_eq!(
            call(&mut session, "current"),
            json!([shape(size), shape(size), shape(directory_size)])
        );
        assert_eq!(call(&mut session, "retained"), shape(0));
    }
    assert_eq!(call(&mut session, "mutate"), -17);
    assert_eq!(native.metadata().unwrap().len(), 4097);
    assert_eq!(call(&mut session, "retained"), shape(-17_i64));
    assert_eq!(call(&mut session, "close"), true);
    session.revoke_host_services();
    assert_eq!(call(&mut session, "retained"), shape(-17_i64));
    assert!(session.take_host_requests().is_empty());
    drop(session);
    drop(provider);
    drop(native);
}

#[cfg(unix)]
fn native_stats_size_mode_are_actual_owned_writable_snapshots(engine: EngineKind) {
    use std::fs::{self, OpenOptions};
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let directory = Directory(std::env::temp_dir().join(format!(
        "weapp-js-stats-size-mode-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    fs::create_dir(&directory.0).unwrap();
    let path = directory.0.join("fixture.bin");
    let child = directory.0.join("directory");
    fs::write(&path, [0, 128, 255]).unwrap();
    fs::create_dir(&child).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
    fs::set_permissions(&child, fs::Permissions::from_mode(0o751)).unwrap();
    let native = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let first = native.metadata().unwrap();
    let first_directory = fs::metadata(&child).unwrap();
    assert_eq!(first.len(), 3);
    assert_eq!(first.mode() & 0o7777, 0o640);
    assert_eq!(first_directory.mode() & 0o7777, 0o751);
    let provider = Arc::new(ManagedSyncFileSystem::new(directory.0.clone()).unwrap());
    let source = r#"
const fs=wx.getFileSystemManager();let fd,pathStats,descriptorStats,directoryStats;
function property(stats,key){const d=Object.getOwnPropertyDescriptor(stats,key);
  return !!d&&Object.prototype.hasOwnProperty.call(d,'value')&&d.writable&&d.enumerable&&d.configurable;}
function shape(stats){return {size:stats.size,mode:stats.mode,sizeType:typeof stats.size,modeType:typeof stats.mode,
  sizeFinite:Number.isFinite(stats.size),modeFinite:Number.isFinite(stats.mode),
  sizeData:property(stats,'size'),modeData:property(stats,'mode'),
  file:stats.isFile(),directory:stats.isDirectory(),marker:Object.prototype.hasOwnProperty.call(stats,'__weappFsStats')};}
exports.open=()=>{fd=fs.openSync({filePath:'wxfile://user/fixture.bin',flag:'r'});return true;};
exports.capture=()=>{pathStats=fs.statSync('wxfile://user/fixture.bin');descriptorStats=fs.fstatSync({fd});
  directoryStats=fs.statSync('wxfile://user/directory');
  return {path:shape(pathStats),descriptor:shape(descriptorStats),directory:shape(directoryStats)};};
exports.current=()=>({path:shape(fs.statSync('wxfile://user/fixture.bin')),descriptor:shape(fs.fstatSync({fd})),
  directory:shape(fs.statSync('wxfile://user/directory'))});
exports.retained=()=>({path:shape(pathStats),descriptor:shape(descriptorStats),directory:shape(directoryStats)});
exports.mutate=()=>{pathStats.size=-9;pathStats.mode=0;descriptorStats.size=123;descriptorStats.mode=7;
  directoryStats.size=456;directoryStats.mode=8;return [pathStats.size,pathStats.mode,descriptorStats.size,
  descriptorStats.mode,directoryStats.size,directoryStats.mode];};
exports.values=()=>[pathStats.size,pathStats.mode,descriptorStats.size,descriptorStats.mode,directoryStats.size,directoryStats.mode];
exports.close=()=>{fs.closeSync({fd});return true;};
exports.closed=()=>{try{fs.fstatSync({fd});return false;}catch(error){return error.code;}};
exports.revoked=()=>{try{fs.statSync('wxfile://user/fixture.bin');return false;}catch(error){return error.code;}};
"#;
    let mut session = make_bound_mode(
        engine,
        source,
        &["wx.getFileSystemManager"],
        &[],
        container_render_skia::PageRenderMode::Raster,
        Some(provider.clone()),
    );
    let factory = calls(&mut session);
    assert_eq!(factory.len(), 1);
    assert_eq!(factory[0].1, "wx.getFileSystemManager");
    session
        .complete_host_api_call(
            &factory[0].0,
            Ok(json!({"objectId":factory[0].2["objectId"]})),
        )
        .unwrap();
    assert_eq!(call(&mut session, "open"), true);
    let shape = |metadata: &fs::Metadata| {
        json!({"size":metadata.len(),"mode":metadata.mode(),"sizeType":"number","modeType":"number",
            "sizeFinite":true,"modeFinite":true,"sizeData":true,"modeData":true,
            "file":metadata.is_file(),"directory":metadata.is_dir(),"marker":false})
    };
    let captured = json!({"path":shape(&first),"descriptor":shape(&first),"directory":shape(&first_directory)});
    assert_eq!(call(&mut session, "capture"), captured);

    // Real changes outside guest JS must affect future reads, while each already
    // returned object keeps the one original Metadata snapshot.
    native.set_len(4097).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o604)).unwrap();
    fs::set_permissions(&child, fs::Permissions::from_mode(0o700)).unwrap();
    let changed = native.metadata().unwrap();
    let changed_directory = fs::metadata(&child).unwrap();
    assert_eq!(changed.len(), 4097);
    assert_eq!(changed.mode() & 0o7777, 0o604);
    let current = json!({"path":shape(&changed),"descriptor":shape(&changed),"directory":shape(&changed_directory)});
    assert_eq!(call(&mut session, "current"), current);
    assert_eq!(call(&mut session, "retained"), captured);

    // Writable number fields are ordinary guest data. Assigning them cannot
    // mutate a file, create a host outbox request, or update another snapshot.
    let assigned = json!([-9, 0, 123, 7, 456, 8]);
    assert_eq!(call(&mut session, "mutate"), assigned);
    assert_eq!(call(&mut session, "current"), current);
    assert_eq!(native.metadata().unwrap().len(), 4097);
    assert_eq!(native.metadata().unwrap().mode(), changed.mode());
    assert_eq!(
        fs::metadata(&child).unwrap().mode(),
        changed_directory.mode()
    );
    assert!(session.take_host_requests().is_empty());

    // An open descriptor owns its original inode. Reusing the path must not
    // retarget fstatSync, and close/owner retirement must not revoke local data.
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"replacement bytes").unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
    let replacement = fs::metadata(&path).unwrap();
    assert_eq!(
        call(&mut session, "current"),
        json!({"path":shape(&replacement),"descriptor":shape(&changed),"directory":shape(&changed_directory)})
    );
    assert_eq!(call(&mut session, "values"), assigned);
    assert_eq!(call(&mut session, "close"), true);
    assert_eq!(call(&mut session, "closed"), "ERR_INVALID_REQUEST");
    session.revoke_host_services();
    assert_eq!(call(&mut session, "values"), assigned);
    assert_eq!(call(&mut session, "revoked"), "ERR_CANCELLED");
    assert!(session.take_host_requests().is_empty());
    eprintln!(
        "Stats actual size/mode engine={engine:?} os={} first=({}, {:o}) changed=({}, {:o}) directory=({}, {:o})",
        std::env::consts::OS,
        first.len(), first.mode(), changed.len(), changed.mode(), first_directory.len(), first_directory.mode()
    );
    drop(session);
    drop(provider);
    drop(native);
}

// This is an explicitly ignored real-filesystem proof, not a synthetic
// substitute. Execute only when the assigned isolated filesystem supports
// a sparse file above 2^53 bytes; any set_len failure must be preserved.
#[cfg(unix)]
fn native_stats_real_sparse_size_above_safe_integer(engine: EngineKind) {
    use std::fs::{self, OpenOptions};
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let directory = Directory(std::env::temp_dir().join(format!(
        "weapp-js-stats-real-sparse-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    fs::create_dir(&directory.0).unwrap();
    let native = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(directory.0.join("huge.bin"))
        .unwrap();
    let actual_size = 9_007_199_254_740_993_u64;
    native.set_len(actual_size).unwrap_or_else(|error| {
        panic!("real sparse >2^53 fixture unsupported; this is not a passing large-file proof: {error}")
    });
    assert_eq!(native.metadata().unwrap().len(), actual_size);
    let provider = Arc::new(ManagedSyncFileSystem::new(directory.0.clone()).unwrap());
    let wire = container_core::SyncHostApi::invoke(
        provider.as_ref(),
        "object:FileSystemManager.statSync",
        json!({"path":"wxfile://user/huge.bin"}),
    )
    .unwrap();
    assert_eq!(wire["size"].as_u64(), Some(actual_size));
    let source = r#"
const fs=wx.getFileSystemManager();exports.size=()=>{const s=fs.statSync('wxfile://user/huge.bin');
  return {size:s.size,type:typeof s.size,finite:Number.isFinite(s.size),safe:Number.isSafeInteger(s.size)};};
"#;
    let mut session = make_bound_mode(
        engine,
        source,
        &["wx.getFileSystemManager"],
        &[],
        container_render_skia::PageRenderMode::Raster,
        Some(provider.clone()),
    );
    let factory = calls(&mut session);
    assert_eq!(factory.len(), 1);
    session
        .complete_host_api_call(
            &factory[0].0,
            Ok(json!({"objectId":factory[0].2["objectId"]})),
        )
        .unwrap();
    let result = call(&mut session, "size");
    assert_eq!(result["size"].as_f64(), Some(actual_size as f64));
    assert_eq!(result["type"], "number");
    assert_eq!(result["finite"], true);
    assert_eq!(result["safe"], false);
    assert!(session.take_host_requests().is_empty());
    eprintln!(
        "Stats real sparse engine={engine:?} os={} raw={actual_size} js={}",
        std::env::consts::OS,
        result["size"]
    );
    drop(session);
    drop(provider);
    drop(native);
}
