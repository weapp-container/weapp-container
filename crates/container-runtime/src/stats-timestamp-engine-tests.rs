#[cfg(unix)]
fn native_stats_timestamps_are_actual_numbers_and_retained_snapshots(engine: EngineKind) {
    use std::fs::{FileTimes, OpenOptions};
    use std::os::unix::fs::MetadataExt;
    use std::time::{Duration, UNIX_EPOCH};
    struct Directory(std::path::PathBuf);
    impl Drop for Directory {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let directory = Directory(std::env::temp_dir().join(format!(
        "weapp-js-stats-times-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    )));
    std::fs::create_dir(&directory.0).unwrap();
    let path = directory.0.join("fixture.bin");
    std::fs::write(&path, [0, 128, 255]).unwrap();
    let native = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    let provider = Arc::new(ManagedSyncFileSystem::new(directory.0.clone()).unwrap());
    let source = r#"
const fs=wx.getFileSystemManager();let fd,pathStats,descriptorStats;
function shape(stats){return {atime:stats.lastAccessedTime,mtime:stats.lastModifiedTime,
  accessedType:typeof stats.lastAccessedTime,modifiedType:typeof stats.lastModifiedTime,
  accessedFinite:Number.isFinite(stats.lastAccessedTime),modifiedFinite:Number.isFinite(stats.lastModifiedTime),
  size:stats.size,file:stats.isFile(),directory:stats.isDirectory(),marker:Object.prototype.hasOwnProperty.call(stats,'__weappFsStats')};}
exports.open=()=>{fd=fs.openSync({filePath:'wxfile://user/fixture.bin',flag:'r'});return true;};
exports.capture=()=>{pathStats=fs.statSync('wxfile://user/fixture.bin');descriptorStats=fs.fstatSync({fd});return {path:shape(pathStats),descriptor:shape(descriptorStats)};};
exports.current=()=>({path:shape(fs.statSync('wxfile://user/fixture.bin')),descriptor:shape(fs.fstatSync({fd}))});
exports.retained=()=>({path:shape(pathStats),descriptor:shape(descriptorStats)});
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
    native
        .set_times(
            FileTimes::new()
                .set_accessed(UNIX_EPOCH - Duration::from_millis(1250))
                .set_modified(UNIX_EPOCH - Duration::from_millis(250)),
        )
        .unwrap();
    let first = native.metadata().unwrap();
    for value in [first.accessed().unwrap(), first.modified().unwrap()] {
        let distance = UNIX_EPOCH
            .duration_since(value)
            .expect("actual native JS fixture is not pre-epoch");
        assert_ne!(
            distance.subsec_nanos(),
            0,
            "native JS fixture lost fractional timestamps"
        );
    }
    let shape = |metadata: &std::fs::Metadata| json!({"atime":metadata.atime(),"mtime":metadata.mtime(),"accessedType":"number","modifiedType":"number","accessedFinite":true,"modifiedFinite":true,"size":metadata.len(),"file":true,"directory":false,"marker":false});
    let captured = json!({"path":shape(&first),"descriptor":shape(&first)});
    eprintln!(
        "Stats production JS engine={engine:?} os={} first atime=({},{}) mtime=({},{})",
        std::env::consts::OS,
        first.atime(),
        first.atime_nsec(),
        first.mtime(),
        first.mtime_nsec()
    );
    assert_eq!(call(&mut session, "capture"), captured);
    native
        .set_times(
            FileTimes::new()
                .set_accessed(UNIX_EPOCH + Duration::from_millis(1250))
                .set_modified(UNIX_EPOCH + Duration::from_millis(2250)),
        )
        .unwrap();
    let changed = native.metadata().unwrap();
    assert_eq!(
        call(&mut session, "current"),
        json!({"path":shape(&changed),"descriptor":shape(&changed)})
    );
    assert_eq!(
        call(&mut session, "retained"),
        captured,
        "later file-time mutation rewrote already returned Stats"
    );
    std::fs::remove_file(&path).unwrap();
    std::fs::write(&path, b"replacement").unwrap();
    let replacement = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&path)
        .unwrap();
    replacement
        .set_times(
            FileTimes::new()
                .set_accessed(UNIX_EPOCH + Duration::from_millis(8250))
                .set_modified(UNIX_EPOCH + Duration::from_millis(9250)),
        )
        .unwrap();
    let replaced = replacement.metadata().unwrap();
    assert_eq!(
        call(&mut session, "current"),
        json!({"path":shape(&replaced),"descriptor":shape(&changed)}),
        "descriptor Stats retargeted to replacement path"
    );
    assert_eq!(call(&mut session, "retained"), captured);
    assert_eq!(call(&mut session, "close"), true);
    assert_eq!(call(&mut session, "closed"), "ERR_INVALID_REQUEST");
    assert_eq!(
        call(&mut session, "retained"),
        captured,
        "descriptor close invalidated a returned timestamp snapshot"
    );
    session.revoke_host_services();
    assert_eq!(
        call(&mut session, "retained"),
        captured,
        "owner retirement invalidated returned timestamp numbers"
    );
    assert_eq!(call(&mut session, "revoked"), "ERR_CANCELLED");
    assert!(
        session.take_host_requests().is_empty(),
        "sync timestamp snapshots created an asynchronous Stats request"
    );
    drop(session);
    drop(provider);
    drop(replacement);
    drop(native);
}
