use super::*;
use container_ir::{hex_digest, ContainerManifestV1};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::Path,
    time::{Duration, Instant},
};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/hosts/ios/Sources/WeappContainerSmoke/Resources/portable-pack")
}
fn copied_pack(script: &str) -> tempfile::TempDir {
    page_pack(&format!("Page({{data:{{count:0,message:'sdk',componentConfig:{{label:'test'}}}},onLoad(){{{script}}}}});"))
}
fn page_pack(source: &str) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("blobs/sha256")).unwrap();
    for file in fs::read_dir(fixture().join("blobs/sha256")).unwrap() {
        let file = file.unwrap();
        fs::copy(
            file.path(),
            directory.path().join("blobs/sha256").join(file.file_name()),
        )
        .unwrap();
    }
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(fixture().join("manifest.json")).unwrap()).unwrap();
    let digest = hex_digest(source.as_bytes());
    fs::write(directory.path().join("blobs/sha256").join(&digest), source).unwrap();
    manifest
        .modules
        .iter_mut()
        .find(|m| m.id == "module:pages/home/index.js")
        .unwrap()
        .sha256 = digest;
    manifest.refresh_integrity().unwrap();
    fs::write(
        directory.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    directory
}
fn load(session: &mut ContainerSession, path: &Path) {
    session
        .load(
            PackSource::Directory(path.to_path_buf()),
            LoadOptions::default(),
        )
        .unwrap();
}

fn trusted_services(path: &Path, domain: &str, app_id: &str) -> HostServicesConfig {
    let pack = pack::VerifiedPack::load(PackSource::Directory(path.into())).unwrap();
    HostServicesConfig {
        application: TrustedApplication {
            host_app_id: domain.into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: app_id.into(),
            environment: "develop".into(),
            version: "1".into(),
            pack_root: pack.manifest.integrity.root,
        },
        account: HostAccount {
            principal_id: Some("alice".into()),
            epoch: 1,
        },
        apis: vec!["wx.login".into()],
        sync_values: BTreeMap::new(),
    }
}

fn finish_account_switch(sdk: &mut ContainerSession) {
    let until = Instant::now() + Duration::from_secs(5);
    loop {
        sdk.pump(clock_now_ns()).unwrap();
        let state = sdk.state().unwrap();
        if state["accountSwitch"]["phase"] == "stoppingResources" {
            sdk.acknowledge_account_cleanup(
                state["accountSwitch"]["operationId"].as_str().unwrap(),
            )
            .unwrap();
            continue;
        }
        if state["status"] == "ready" || state["status"] == "empty" {
            return;
        }
        if state["accountSwitch"]["phase"] == "failed" {
            panic!("switch failed: {state}");
        }
        if sdk.active.is_some() && state["surface"].is_null() {
            sdk.attach_surface("account-test").unwrap();
            sdk.acknowledge_presented(sdk.generation, sdk.revision)
                .unwrap();
            sdk.detach_surface("account-test").unwrap();
        }
        assert!(Instant::now() < until, "account switch stuck: {state}");
        std::thread::yield_now();
    }
}

#[test]
fn account_switch_rebuilds_js_preserves_only_scoped_storage_and_rejects_late_login() {
    let pack = copied_pack("const n=(wx.getStorageSync('visits')||0)+1; wx.setStorageSync('visits',n); this.setData({count:n}); wx.login({success:r=>this.setData({message:r.code})});");
    let storage = tempfile::tempdir().unwrap();
    let config = ContainerConfig {
        storage_key: Some("installation".into()),
        storage_root: Some(storage.path().into()),
        host_services: Some(trusted_services(
            pack.path(),
            &storage.path().display().to_string(),
            "one",
        )),
        ..ContainerConfig::default()
    };
    let mut sdk = ContainerSession::new(config).unwrap();
    load(&mut sdk, pack.path());
    assert_eq!(data(&sdk)["count"], 1);
    let owner = sdk.sdk_owner_id;
    let old_session = sdk.state().unwrap()["sessionId"].clone();
    let call = sdk
        .take_events()
        .into_iter()
        .find(|e| e["type"] == "hostCall" && e["method"] == "wx.login")
        .expect("registered login delegates, never sandbox");
    assert_eq!(call["context"]["application"]["appId"], "one");
    assert_eq!(call["context"]["account"]["epoch"], "1");
    let manager = sdk.account_manager().unwrap();
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(
        sdk.input(Vec::new()).unwrap_err().code(),
        "ERR_IDENTITY_SWITCHING"
    );
    assert_eq!(
        sdk.complete_host_call(
            call["callId"].as_str().unwrap(),
            Ok(json!({"code":"late-alice"}))
        )
        .unwrap_err()
        .code(),
        "ERR_IDENTITY_SWITCHING"
    );
    assert!(
        sdk.state().unwrap()["page"].is_null(),
        "stale guest state cannot escape immediately after shared epoch change"
    );
    finish_account_switch(&mut sdk);
    assert_eq!(
        sdk.sdk_owner_id, owner,
        "public controller identity is stable"
    );
    assert_ne!(sdk.state().unwrap()["sessionId"], old_session);
    assert_eq!(
        data(&sdk)["count"],
        1,
        "Bob does not inherit Alice storage or JS"
    );
    assert_ne!(data(&sdk)["message"], "late-alice");
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("alice".into()),
                epoch: 3,
            },
            BTreeMap::new(),
        )
        .unwrap();
    finish_account_switch(&mut sdk);
    assert_eq!(
        data(&sdk)["count"],
        2,
        "same account retains persisted data across incarnation"
    );
    sdk.close().unwrap();
}

#[test]
fn account_cleanup_requires_exact_current_operation_and_detached_surface() {
    let pack=page_pack("Page({data:{count:1,message:'active',componentConfig:{label:'test'}},onUnload(){throw new Error('revoked guest must never run');}});");
    let domain = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &domain.path().display().to_string(),
            "one",
        )),
        ..Default::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    sdk.attach_surface("old-surface").unwrap();
    let old = sdk.state().unwrap()["sessionId"].clone();
    let first = sdk
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    for _ in 0..3 {
        sdk.pump(clock_now_ns()).unwrap();
    }
    assert_eq!(
        sdk.account_switch_status(None).unwrap().unwrap().phase,
        AccountSwitchPhase::StoppingResources
    );
    assert_eq!(
        sdk.active.as_ref().unwrap().session.config().session_id,
        old.as_str().unwrap()
    );
    assert_eq!(sdk.command("hostComponents", json!({})).unwrap(), json!([]));
    assert!(
        sdk.acknowledge_account_cleanup(&first.operation_id)
            .is_err(),
        "a live old GPU surface prevents cleanup acknowledgement"
    );
    sdk.detach_surface("old-surface").unwrap();
    let second = sdk
        .switch_account(
            HostAccount {
                principal_id: Some("carol".into()),
                epoch: 3,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert!(
        sdk.acknowledge_account_cleanup(&first.operation_id)
            .is_err(),
        "late cleanup cannot authorize a newer account"
    );
    assert_eq!(
        sdk.account_switch_status(None).unwrap().unwrap().phase,
        AccountSwitchPhase::StoppingResources
    );
    sdk.acknowledge_account_cleanup(&second.operation_id)
        .unwrap();
    finish_account_switch(&mut sdk);
    assert_ne!(sdk.state().unwrap()["sessionId"], old);
    assert_eq!(
        sdk.config
            .host_services
            .as_ref()
            .unwrap()
            .account
            .principal_id
            .as_deref(),
        Some("carol")
    );
    assert!(!sdk
        .take_events()
        .iter()
        .any(|event| event.to_string().contains("revoked guest must never run")));
    sdk.close().unwrap();
}

#[test]
fn closing_a_revoked_owner_never_enters_old_guest_lifecycle() {
    let pack=page_pack("Page({data:{count:1,message:'active',componentConfig:{label:'test'}},onUnload(){throw new Error('stale unload');}});");
    let domain = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &domain.path().display().to_string(),
            "one",
        )),
        ..Default::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    sdk.account_manager()
        .unwrap()
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    sdk.close().unwrap();
    assert!(!sdk
        .take_events()
        .iter()
        .any(|event| event.to_string().contains("stale unload")));
}

#[test]
fn shared_account_revokes_every_app_before_either_owner_pumps_and_latest_wins() {
    let pack = copied_pack("this.setData({message:'new-heap'});");
    let domain = tempfile::tempdir().unwrap();
    let mut one = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &domain.path().display().to_string(),
            "one",
        )),
        ..ContainerConfig::default()
    })
    .unwrap();
    let mut two = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &domain.path().display().to_string(),
            "two",
        )),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut one, pack.path());
    load(&mut two, pack.path());
    let manager = one.account_manager().unwrap();
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(
        two.send_message(json!({})).unwrap_err().code(),
        "ERR_IDENTITY_SWITCHING"
    );
    assert!(
        two.frame().is_err(),
        "old frame revoked without waiting for owner pump"
    );
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("carol".into()),
                epoch: 3,
            },
            BTreeMap::new(),
        )
        .unwrap();
    finish_account_switch(&mut one);
    finish_account_switch(&mut two);
    assert_eq!(
        one.config
            .host_services
            .as_ref()
            .unwrap()
            .account
            .principal_id
            .as_deref(),
        Some("carol")
    );
    assert_eq!(two.config.host_services.as_ref().unwrap().account.epoch, 3);
}

#[test]
fn failed_account_reload_never_revives_old_heap_or_page_and_can_retry() {
    let pack = page_pack("Page({data:{message:'clean',count:0,componentConfig:{label:'test'}},onLoad(query){if(query.failStartup)throw new Error('new account startup failed');}});");
    let domain = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &domain.path().display().to_string(),
            "one",
        )),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    let mut launches = BTreeMap::new();
    launches.insert(
        "one".into(),
        LoadOptions {
            options: serde_json::from_value(json!({"query":{"failStartup":true}})).unwrap(),
            ..LoadOptions::default()
        },
    );
    sdk.switch_account(
        HostAccount {
            principal_id: Some("bob".into()),
            epoch: 2,
        },
        launches,
    )
    .unwrap();
    let operation = sdk
        .account_switch_status(None)
        .unwrap()
        .unwrap()
        .operation_id;
    sdk.acknowledge_account_cleanup(&operation).unwrap();
    until(&mut sdk, |sdk| {
        sdk.account_switch
            .as_ref()
            .is_some_and(|pending| pending.receipt.phase == AccountSwitchPhase::Failed)
    });
    assert!(sdk.active.is_none());
    assert_eq!(sdk.state().unwrap()["accountSwitch"]["phase"], "failed");
    assert_eq!(
        sdk.navigate("pages/home/index", json!({}), false)
            .unwrap_err()
            .code(),
        "ERR_IDENTITY_SWITCHING"
    );
    sdk.retry_account_switch(LoadOptions::default()).unwrap();
    finish_account_switch(&mut sdk);
    assert_eq!(sdk.config.host_services.as_ref().unwrap().account.epoch, 2);
    assert_eq!(data(&sdk)["message"], "clean");
}

#[test]
fn managed_file_leases_share_application_scope_and_block_deletion_until_all_resources_stop() {
    let pack = copied_pack("");
    let directory = tempfile::tempdir().unwrap();
    let make = || {
        ContainerSession::new(ContainerConfig {
            host_services: Some(trusted_services(
                pack.path(),
                &directory.path().display().to_string(),
                "one",
            )),
            managed_files_root: Some(directory.path().into()),
            ..Default::default()
        })
        .unwrap()
    };
    let mut one = make();
    let mut two = make();
    let first = one.command("managedFileScope", json!({})).unwrap();
    let sibling = two.command("managedFileScope", json!({})).unwrap();
    assert_eq!(
        first["root"], sibling["root"],
        "controllers for the same application/user share files"
    );
    let files = PathBuf::from(first["root"].as_str().unwrap());
    let auxiliary = PathBuf::from(first["auxiliaryRoot"].as_str().unwrap());
    fs::write(files.join("private-photo.jpg"), b"alice-private-photo").unwrap();
    fs::write(auxiliary.join("consent.json"), b"alice-consent").unwrap();
    let manager = one.account_manager().unwrap();
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(
        manager.delete_principal_data("alice").unwrap_err().code(),
        "ERR_STORAGE_LOCKED"
    );
    finish_account_switch(&mut one);
    assert_eq!(
        manager.delete_principal_data("alice").unwrap_err().code(),
        "ERR_STORAGE_LOCKED",
        "a second revoked native owner still holds its file lease"
    );
    finish_account_switch(&mut two);
    assert_eq!(manager.delete_principal_data("alice").unwrap(), 1);
    assert!(!files.exists());
    assert!(!auxiliary.exists());
    let bob = one.command("managedFileScope", json!({})).unwrap();
    assert_ne!(bob["root"], first["root"]);
    one.close().unwrap();
    two.close().unwrap();
}

#[test]
fn native_sync_files_use_the_same_scoped_lease_and_rebuild_before_new_account_startup() {
    let pack=copied_pack("const files=wx.getFileSystemManager(); let previous='';try{previous=files.readFileSync(wx.env.USER_DATA_PATH+'/identity.txt','utf8')}catch(_){} files.writeFileSync(wx.env.USER_DATA_PATH+'/identity.txt','written','utf8');this.setData({previous,file:files.readFileSync(wx.env.USER_DATA_PATH+'/identity.txt','utf8')});");
    let directory = tempfile::tempdir().unwrap();
    let mut services = trusted_services(
        pack.path(),
        &directory.path().display().to_string(),
        "sync-files",
    );
    services.apis = vec!["wx.getFileSystemManager".into()];
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(services),
        managed_files_root: Some(directory.path().into()),
        ..Default::default()
    })
    .unwrap();
    let alice = sdk.command("managedFileScope", json!({})).unwrap();
    load(&mut sdk, pack.path());
    assert_eq!(data(&sdk)["file"], "written");
    assert_eq!(data(&sdk)["previous"], "");
    assert_eq!(
        fs::read(PathBuf::from(alice["root"].as_str().unwrap()).join("identity.txt")).unwrap(),
        b"written"
    );
    assert!(
        sdk.capabilities().unwrap()["hostServices"]["registeredApis"]
            .as_array()
            .unwrap()
            .iter()
            .any(|api| api == "object:FileSystemManager.readFileSync")
    );
    for event in sdk
        .take_events()
        .into_iter()
        .filter(|event| event["type"] == "hostCall" && event["method"] == "wx.getFileSystemManager")
    {
        sdk.complete_host_call(
            event["callId"].as_str().unwrap(),
            Ok(json!({"objectId":event["payload"]["objectId"]})),
        )
        .unwrap();
    }
    sdk.switch_account(
        HostAccount {
            principal_id: Some("bob".into()),
            epoch: 2,
        },
        BTreeMap::new(),
    )
    .unwrap();
    finish_account_switch(&mut sdk);
    assert_eq!(
        data(&sdk)["previous"],
        "",
        "a fresh user's startup must not see old files"
    );
    let bob = sdk.command("managedFileScope", json!({})).unwrap();
    assert_ne!(alice["root"], bob["root"]);
    assert_eq!(
        fs::read(PathBuf::from(bob["root"].as_str().unwrap()).join("identity.txt")).unwrap(),
        b"written"
    );
    for event in sdk
        .take_events()
        .into_iter()
        .filter(|event| event["type"] == "hostCall" && event["method"] == "wx.getFileSystemManager")
    {
        sdk.complete_host_call(
            event["callId"].as_str().unwrap(),
            Ok(json!({"objectId":event["payload"]["objectId"]})),
        )
        .unwrap();
    }
    sdk.close().unwrap();
}

fn account_snapshots_contract(engine: EngineKind) {
    let pack = copied_pack("this.setData({identity:weappContainer.identity.getState()});");
    let domain = tempfile::tempdir().unwrap();
    let mut services = trusted_services(pack.path(), &domain.path().display().to_string(), "one");
    services
        .apis
        .push("weappContainer.identity.getState".into());
    services.sync_values.insert(
        "weappContainer.identity.getState".into(),
        json!({"hostLoggedIn":true,"appLoggedIn":true,"userInfo":{"nickName":"Alice"}}),
    );
    let mut sdk = ContainerSession::new(ContainerConfig {
        engine,
        host_services: Some(services),
        ..Default::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    let original_session = sdk.state().unwrap()["sessionId"].clone();
    assert_eq!(data(&sdk)["identity"]["userInfo"]["nickName"], "Alice");
    let receipt = sdk
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(
        sdk.config.host_services.as_ref().unwrap().sync_values["weappContainer.identity.getState"]
            ["appLoggedIn"],
        false
    );
    assert!(sdk
        .command(
            "prepareAccountHostServiceSnapshots",
            json!({"operationId":"stale","values":{}})
        )
        .is_err());
    sdk.command("prepareAccountHostServiceSnapshots",json!({"operationId":receipt.operation_id,"values":{"weappContainer.identity.getState":{"hostLoggedIn":true,"appLoggedIn":true,"userInfo":{"nickName":"Bob"}}}})).unwrap();
    finish_account_switch(&mut sdk);
    assert_ne!(sdk.state().unwrap()["sessionId"], original_session);
    assert_eq!(data(&sdk)["identity"]["userInfo"]["nickName"], "Bob");
    assert!(sdk
        .command(
            "prepareAccountHostServiceSnapshots",
            json!({"operationId":receipt.operation_id,"values":{}})
        )
        .is_err());
    sdk.close().unwrap();
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_account_snapshots_are_sanitized_before_new_owner_and_refresh_requires_current_cleanup() {
    account_snapshots_contract(EngineKind::Quickjs);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_account_snapshots_are_sanitized_before_new_owner_and_refresh_requires_current_cleanup() {
    account_snapshots_contract(EngineKind::V8);
}

fn native_snapshot_context(sdk: &ContainerSession) -> Value {
    let state = sdk.state().unwrap();
    let mut context = state["hostServicesState"].clone();
    context["sessionId"] = state["sessionId"].clone();
    context
}

fn native_snapshot_refresh_contract(engine: EngineKind) {
    let pack = page_pack("Page({data:{count:0,message:'snapshot',componentConfig:{label:'test'}},onLoad(){this.readIdentity()},onShow(){this.readIdentity()},readIdentity(){this.setData({identity:weappContainer.identity.getState()})}});");
    let domain = tempfile::tempdir().unwrap();
    let mut services =
        trusted_services(pack.path(), &domain.path().display().to_string(), "refresh");
    services.apis = vec!["weappContainer.identity.getState".into()];
    let identity =
        |name| json!({"hostLoggedIn":true,"appLoggedIn":true,"userInfo":{"nickName":name}});
    services
        .sync_values
        .insert("weappContainer.identity.getState".into(), identity("Alice"));
    let mut sdk = ContainerSession::new(ContainerConfig {
        engine,
        host_services: Some(services),
        ..Default::default()
    })
    .unwrap();
    assert_eq!(
        sdk.capabilities().unwrap()["hostServices"]["snapshotOwnerContext"],
        "1.0"
    );
    load(&mut sdk, pack.path());
    // This owner context belongs to a native refresh, with no pending API call.
    let alice = native_snapshot_context(&sdk);
    let update = |context: Value, name| json!({"context":context,"values":{"weappContainer.identity.getState":identity(name)}});
    sdk.command(
        "updateHostServiceSnapshots",
        update(alice.clone(), "Alice refreshed"),
    )
    .unwrap();
    sdk.switch_account(
        HostAccount {
            principal_id: Some("bob".into()),
            epoch: 2,
        },
        BTreeMap::new(),
    )
    .unwrap();
    assert_eq!(
        sdk.command(
            "updateHostServiceSnapshots",
            update(alice.clone(), "Late Alice")
        )
        .unwrap_err()
        .code(),
        "ERR_IDENTITY_SWITCHING"
    );
    let until = Instant::now() + Duration::from_secs(5);
    let mut cleanup_acknowledged = false;
    loop {
        sdk.pump(clock_now_ns()).unwrap();
        let state = sdk.state().unwrap();
        if !cleanup_acknowledged && state["accountSwitch"]["phase"] == "stoppingResources" {
            sdk.acknowledge_account_cleanup(
                state["accountSwitch"]["operationId"].as_str().unwrap(),
            )
            .unwrap();
            // ACK this cleanup once. If native retirement is still draining,
            // another ACK can poll through startup and complete an already
            // presented Raster frame before this test observes the checkpoint.
            cleanup_acknowledged = true;
        }
        if sdk.state().unwrap()["accountSwitch"]["phase"] == "awaitingPresentation" {
            break;
        }
        assert!(
            Instant::now() < until,
            "replacement did not reach presentation: {state}"
        );
        std::thread::yield_now();
    }
    let bob = native_snapshot_context(&sdk);
    // Native device snapshots may refresh after the new owner starts, before
    // the account replacement presentation checkpoint. Raster has rendered;
    // native GPU mode still awaits the host's exact presentation receipt.
    // The snapshot context must name that exact new owner in either mode.
    sdk.command("updateHostServiceSnapshots", update(bob.clone(), "Bob"))
        .unwrap();
    finish_account_switch(&mut sdk);
    assert_eq!(
        sdk.command("updateHostServiceSnapshots", update(alice, "Late Alice"))
            .unwrap_err()
            .code(),
        "ERR_CANCELLED",
        "an old native HTTP completion must not contaminate the new owner"
    );
    for field in [
        "hostAppId",
        "tenantId",
        "publisherId",
        "appId",
        "environment",
        "version",
        "packRoot",
    ] {
        let mut wrong = bob.clone();
        wrong["application"][field] = json!("wrong");
        assert_eq!(
            sdk.command(
                "updateHostServiceSnapshots",
                update(wrong, "Wrong application")
            )
            .unwrap_err()
            .code(),
            "ERR_CANCELLED",
            "wrong {field} must not update the accepted pack"
        );
    }
    for (field, value) in [("principalId", json!("alice")), ("epoch", json!("1"))] {
        let mut wrong = bob.clone();
        wrong["account"][field] = value;
        assert_eq!(
            sdk.command("updateHostServiceSnapshots", update(wrong, "Wrong account"))
                .unwrap_err()
                .code(),
            "ERR_CANCELLED"
        );
    }
    let mut wrong = bob.clone();
    wrong["sessionId"] = json!("another-native-owner");
    assert_eq!(
        sdk.command("updateHostServiceSnapshots", update(wrong, "Wrong session"))
            .unwrap_err()
            .code(),
        "ERR_CANCELLED"
    );
    for malformed in [
        Value::Null,
        json!({"application":bob["application"],"account":bob["account"]}),
    ] {
        assert_eq!(
            sdk.command("updateHostServiceSnapshots", update(malformed, "Malformed"))
                .unwrap_err()
                .code(),
            "ERR_INVALID_REQUEST"
        );
    }
    sdk.set_foreground(false).unwrap();
    sdk.set_foreground(true).unwrap();
    assert_eq!(
        data(&sdk)["identity"]["userInfo"]["nickName"],
        "Bob",
        "rejected refreshes must leave the real JS snapshot unchanged"
    );
    // A reload of the same application/account also replaces the incarnation.
    load(&mut sdk, pack.path());
    assert_ne!(native_snapshot_context(&sdk)["sessionId"], bob["sessionId"]);
    assert_eq!(
        sdk.command(
            "updateHostServiceSnapshots",
            update(bob, "Late pre-reload Bob")
        )
        .unwrap_err()
        .code(),
        "ERR_CANCELLED"
    );
    let mut current = native_snapshot_context(&sdk);
    current["callId"] = json!("native-refresh-without-pending-api");
    current["api"] = json!("weappContainer.identity.getState");
    sdk.command("updateHostServiceSnapshots", update(current, "Current Bob"))
        .unwrap();
    sdk.set_foreground(false).unwrap();
    sdk.set_foreground(true).unwrap();
    assert_eq!(
        data(&sdk)["identity"]["userInfo"]["nickName"],
        "Current Bob"
    );
    // Synchronous owner-thread embedders keep the existing context-free path.
    sdk.command(
        "updateHostServiceSnapshots",
        json!({"values":{"weappContainer.identity.getState":identity("Synchronous Bob")}}),
    )
    .unwrap();
    sdk.set_foreground(false).unwrap();
    sdk.set_foreground(true).unwrap();
    assert_eq!(
        data(&sdk)["identity"]["userInfo"]["nickName"],
        "Synchronous Bob"
    );
    sdk.account_manager()
        .unwrap()
        .switch_account(
            HostAccount {
                principal_id: Some("carol".into()),
                epoch: 3,
            },
            BTreeMap::new(),
        )
        .unwrap();
    assert_eq!(
        sdk.command(
            "updateHostServiceSnapshots",
            update(native_snapshot_context(&sdk), "Revoked Bob")
        )
        .unwrap_err()
        .code(),
        "ERR_IDENTITY_SWITCHING"
    );
    assert_eq!(sdk.command("updateHostServiceSnapshots",json!({"values":{"weappContainer.identity.getState":identity("Revoked synchronous Bob")}})).unwrap_err().code(),"ERR_IDENTITY_SWITCHING");
    sdk.close().unwrap();
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_native_snapshot_refresh_rejects_stale_account_pack_and_session() {
    native_snapshot_refresh_contract(EngineKind::Quickjs);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_native_snapshot_refresh_rejects_stale_account_pack_and_session() {
    native_snapshot_refresh_contract(EngineKind::V8);
}

#[test]
fn trusted_installation_must_match_verified_pack_and_legacy_storage_is_not_imported() {
    let pack = copied_pack("this.setData({count:wx.getStorageSync('visits')||0});");
    let storage = tempfile::tempdir().unwrap();
    let legacy = storage::PersistentStorage::open(storage.path(), "install").unwrap();
    legacy.close().unwrap();
    let mut config = ContainerConfig {
        storage_key: Some("install".into()),
        storage_root: Some(storage.path().into()),
        host_services: Some(trusted_services(
            pack.path(),
            &storage.path().display().to_string(),
            "one",
        )),
        ..ContainerConfig::default()
    };
    config.host_services.as_mut().unwrap().application.pack_root = "0".repeat(64);
    let mut sdk = ContainerSession::new(config).unwrap();
    assert_eq!(
        sdk.load(
            PackSource::Directory(pack.path().into()),
            LoadOptions::default()
        )
        .unwrap_err()
        .code(),
        "ERR_UNTRUSTED_APPLICATION"
    );
    assert!(sdk.active.is_none());
}

#[test]
fn guest_logout_revokes_only_that_application_across_its_controllers() {
    let pack=page_pack("Page({data:{count:0,message:'fresh',componentConfig:{label:'test'}},onLoad(query){if(query.logout)weappContainer.identity.logout({});}});");
    let domain = tempfile::tempdir().unwrap();
    let make = |app: &str, publisher: &str, environment: &str| {
        let mut services = trusted_services(pack.path(), &domain.path().display().to_string(), app);
        services.application.publisher_id = publisher.into();
        services.application.environment = environment.into();
        services.apis.push("weappContainer.identity.logout".into());
        ContainerSession::new(ContainerConfig {
            host_services: Some(services),
            ..ContainerConfig::default()
        })
        .unwrap()
    };
    let mut one = make("one", "publisher", "develop");
    let mut sibling = make("one", "publisher", "develop");
    let mut other = make("two", "publisher", "develop");
    let mut another_publisher = make("one", "another", "develop");
    let mut another_environment = make("one", "publisher", "release");
    one.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            options: serde_json::from_value(json!({"query":{"logout":true}})).unwrap(),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    load(&mut sibling, pack.path());
    load(&mut other, pack.path());
    load(&mut another_publisher, pack.path());
    load(&mut another_environment, pack.path());
    let publisher_session = another_publisher.state().unwrap()["sessionId"].clone();
    let environment_session = another_environment.state().unwrap()["sessionId"].clone();
    let other_session = other.state().unwrap()["sessionId"].clone();
    let old_sibling = sibling.state().unwrap()["sessionId"].clone();
    let call = one
        .take_events()
        .into_iter()
        .find(|e| e["method"] == "weappContainer.identity.logout")
        .unwrap();
    one.complete_host_api_call(
        call["callId"].as_str().unwrap(),
        Ok(json!({"errMsg":"logout:ok"})),
    )
    .unwrap();
    assert!(sibling.identity_blocked());
    assert!(!other.identity_blocked());
    assert!(!another_publisher.identity_blocked());
    assert!(!another_environment.identity_blocked());
    finish_account_switch(&mut one);
    finish_account_switch(&mut sibling);
    assert_ne!(sibling.state().unwrap()["sessionId"], old_sibling);
    assert_eq!(other.state().unwrap()["sessionId"], other_session);
    assert_eq!(
        another_publisher.state().unwrap()["sessionId"],
        publisher_session
    );
    assert_eq!(
        another_environment.state().unwrap()["sessionId"],
        environment_session
    );
    assert_eq!(
        one.account_manager()
            .unwrap()
            .account()
            .unwrap()
            .principal_id
            .as_deref(),
        Some("alice")
    );
    assert_eq!(one.account_manager().unwrap().account().unwrap().epoch, 1);
}

#[test]
fn application_revocation_scope_survives_upgrades_and_host_wide_revocation_remains_explicit() {
    let services = trusted_services(&fixture(), "scope-revocation", "one");
    let manager = HostAccountManager::new(services.account).unwrap();
    let application = services.application;
    let mut upgrade = application.clone();
    upgrade.version = "next".into();
    upgrade.pack_root = "a".repeat(64);
    let mut environment = application.clone();
    environment.environment = "release".into();
    let mut publisher = application.clone();
    publisher.publisher_id = "another".into();
    let initial = manager.snapshot().unwrap();
    let operation = manager.revoke_application_scope(&application).unwrap();
    let exact = manager.snapshot().unwrap();
    assert_ne!(
        initial.application_revision(&application),
        exact.application_revision(&application)
    );
    assert_eq!(
        exact.application_revision(&application),
        exact.application_revision(&upgrade)
    );
    assert_eq!(
        initial.application_revision(&environment),
        exact.application_revision(&environment)
    );
    assert_eq!(
        initial.application_revision(&publisher),
        exact.application_revision(&publisher)
    );
    assert_ne!(manager.revoke_application("one").unwrap(), operation);
    let broad = manager.snapshot().unwrap();
    assert_ne!(
        broad.application_revision(&environment),
        exact.application_revision(&environment)
    );
    assert_ne!(
        broad.application_revision(&publisher),
        exact.application_revision(&publisher)
    );
}

#[test]
fn application_switch_receipts_keep_their_operation_when_another_app_is_revoked() {
    let pack = copied_pack("");
    let domain = tempfile::tempdir().unwrap();
    let make = |app| {
        ContainerSession::new(ContainerConfig {
            host_services: Some(trusted_services(
                pack.path(),
                &domain.path().display().to_string(),
                app,
            )),
            ..ContainerConfig::default()
        })
        .unwrap()
    };
    let mut one = make("one");
    let mut two = make("two");
    load(&mut one, pack.path());
    load(&mut two, pack.path());
    let manager = one.account_manager().unwrap();
    let first = manager
        .revoke_application_scope(&one.config.host_services.as_ref().unwrap().application)
        .unwrap();
    let second = manager.revoke_application("two").unwrap();
    // Neither controller has observed its revocation yet. One application's
    // later operation must not overwrite the other's queryable receipt.
    one.poll_account_switch().unwrap();
    two.poll_account_switch().unwrap();
    assert_eq!(
        one.account_switch_status(Some(&first))
            .unwrap()
            .unwrap()
            .operation_id,
        first
    );
    assert_eq!(
        two.account_switch_status(Some(&second))
            .unwrap()
            .unwrap()
            .operation_id,
        second
    );
    assert!(one.account_switch_status(Some(&second)).unwrap().is_none());
    assert!(two.account_switch_status(Some(&first)).unwrap().is_none());
    finish_account_switch(&mut one);
    finish_account_switch(&mut two);
    assert_eq!(
        one.account_switch_status(Some(&first))
            .unwrap()
            .unwrap()
            .phase,
        AccountSwitchPhase::Complete
    );
    assert_eq!(
        two.account_switch_status(Some(&second))
            .unwrap()
            .unwrap()
            .phase,
        AccountSwitchPhase::Complete
    );
    // Credential refresh refers to the host-account operation, not a sibling
    // application's authorization operation.
    assert_eq!(
        manager
            .switch_account(manager.account().unwrap(), BTreeMap::new())
            .unwrap(),
        "initial"
    );
}

#[test]
fn account_cleanup_incarnations_change_when_application_revocation_changes_the_pending_target() {
    for observe_account_first in [false, true] {
        let pack = copied_pack("this.setData({identity:weappContainer.identity.getState()});");
        let domain = tempfile::tempdir().unwrap();
        let mut services =
            trusted_services(pack.path(), &domain.path().display().to_string(), "one");
        services
            .apis
            .push("weappContainer.identity.getState".into());
        services.sync_values.insert(
            "weappContainer.identity.getState".into(),
            json!({"hostLoggedIn":true,"appLoggedIn":true}),
        );
        let application = services.application.clone();
        let mut sdk = ContainerSession::new(ContainerConfig {
            host_services: Some(services),
            ..Default::default()
        })
        .unwrap();
        load(&mut sdk, pack.path());
        let manager = sdk.account_manager().unwrap();
        let account_operation = manager
            .switch_account(
                HostAccount {
                    principal_id: Some("bob".into()),
                    epoch: 2,
                },
                BTreeMap::new(),
            )
            .unwrap();
        if observe_account_first {
            sdk.poll_account_switch().unwrap();
            assert_eq!(
                sdk.state().unwrap()["accountSwitch"]["operationId"],
                account_operation
            );
        }
        let mut previous_operation = account_operation.clone();
        for revocation in 0..2 {
            manager.revoke_application_scope(&application).unwrap();
            if revocation == 0 {
                assert_eq!(sdk.command("prepareAccountHostServiceSnapshots", json!({
                    "operationId":previous_operation,
                    "values":{"weappContainer.identity.getState":{"hostLoggedIn":true,"appLoggedIn":true}}
                })).unwrap_err().code(), "ERR_CANCELLED",
                    "snapshot preparation must consult the latest manager target without a preceding pump");
            }
            assert_eq!(
                sdk.acknowledge_account_cleanup(&previous_operation)
                    .unwrap_err()
                    .code(),
                "ERR_CANCELLED",
                "a late ACK must consult the latest manager target without a preceding pump"
            );
            let current = sdk.account_switch_status(None).unwrap().unwrap();
            assert_ne!(
                current.operation_id, previous_operation,
                "a changed application revision must retire every older cleanup incarnation"
            );
            assert_ne!(current.operation_id, account_operation);
            assert_eq!(
                sdk.state().unwrap()["accountSwitch"]["operationId"],
                current.operation_id
            );
            assert_eq!(
                sdk.account_switch_status(Some(&previous_operation))
                    .unwrap()
                    .unwrap()
                    .phase,
                AccountSwitchPhase::Superseded
            );
            assert_eq!(sdk.command("prepareAccountHostServiceSnapshots", json!({
                "operationId":previous_operation,
                "values":{"weappContainer.identity.getState":{"hostLoggedIn":true,"appLoggedIn":true}}
            })).unwrap_err().code(), "ERR_CANCELLED");
            assert_eq!(
                sdk.acknowledge_account_cleanup(&previous_operation)
                    .unwrap_err()
                    .code(),
                "ERR_CANCELLED"
            );
            assert_eq!(
                sdk.config.host_services.as_ref().unwrap().sync_values
                    ["weappContainer.identity.getState"]["appLoggedIn"],
                false
            );
            sdk.command("prepareAccountHostServiceSnapshots", json!({
                "operationId":current.operation_id,
                "values":{"weappContainer.identity.getState":{"hostLoggedIn":true,"appLoggedIn":false}}
            })).unwrap();
            previous_operation = current.operation_id;
        }
        finish_account_switch(&mut sdk);
        assert_eq!(data(&sdk)["identity"]["appLoggedIn"], false);
        assert_eq!(
            sdk.account_switch_status(Some(&account_operation))
                .unwrap()
                .unwrap()
                .phase,
            AccountSwitchPhase::Superseded
        );
        assert_eq!(
            sdk.account_switch_status(Some(&previous_operation))
                .unwrap()
                .unwrap()
                .phase,
            AccountSwitchPhase::Complete
        );
        assert_eq!(
            sdk.config
                .host_services
                .as_ref()
                .unwrap()
                .account
                .principal_id
                .as_deref(),
            Some("bob")
        );
        sdk.close().unwrap();
    }
}

#[test]
fn late_logout_success_times_out_without_revoking_the_application() {
    let pack = copied_pack("weappContainer.identity.logout({timeout:200,success:()=>this.setData({message:'unexpected'}),fail:error=>this.setData({message:error.code})});");
    let domain = tempfile::tempdir().unwrap();
    let mut services = trusted_services(pack.path(), &domain.path().display().to_string(), "one");
    services.apis.push("weappContainer.identity.logout".into());
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(services),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    let initial_session = sdk.state().unwrap()["sessionId"].clone();
    let call = sdk
        .take_events()
        .into_iter()
        .find(|event| event["method"] == "weappContainer.identity.logout")
        .unwrap();
    let deadline = call["deadlineNs"].as_str().unwrap().parse::<u64>().unwrap();
    let remaining = deadline.saturating_sub(clock_now_ns());
    std::thread::sleep(Duration::from_nanos(remaining).saturating_add(Duration::from_millis(2)));
    // Do not pump first: the SDK must reject a late success even before it has
    // drained the runtime's timeout/cancel notification.
    sdk.complete_host_api_call(
        call["callId"].as_str().unwrap(),
        Ok(json!({"errMsg":"logout:ok"})),
    )
    .unwrap();
    assert!(!sdk.identity_blocked());
    assert_eq!(sdk.state().unwrap()["sessionId"], initial_session);
    assert_eq!(data(&sdk)["message"], "ERR_TIMEOUT");
    assert_eq!(
        sdk.account_manager()
            .unwrap()
            .account()
            .unwrap()
            .principal_id
            .as_deref(),
        Some("alice")
    );
}

#[test]
fn native_api_resource_chunks_require_the_exact_live_source_call() {
    let pack = copied_pack(
        "const audio=wx.createInnerAudioContext();audio.src='assets/private-audio.bin';",
    );
    let resource = (0..1048593).map(|n| (n % 251) as u8).collect::<Vec<_>>();
    let digest = hex_digest(&resource);
    fs::write(pack.path().join("blobs/sha256").join(&digest), &resource).unwrap();
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    manifest.assets.push(container_ir::Asset {
        path: "assets/private-audio.bin".into(),
        sha256: digest,
        mime: "application/octet-stream".into(),
        size: resource.len() as u64,
    });
    manifest.refresh_integrity().unwrap();
    fs::write(
        pack.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let domain = tempfile::tempdir().unwrap();
    let mut services = trusted_services(pack.path(), &domain.path().display().to_string(), "one");
    services.apis.extend([
        "wx.createInnerAudioContext".into(),
        "object:InnerAudioContext.src".into(),
    ]);
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(services),
        ..ContainerConfig::default()
    })
    .unwrap();
    assert_eq!(
        sdk.capabilities().unwrap()["hostServices"]["apiResourceChunks"],
        "1.0"
    );
    load(&mut sdk, pack.path());
    let call = sdk
        .take_events()
        .into_iter()
        .find(|event| event["method"] == "object:InnerAudioContext.src")
        .unwrap();
    let context = call["context"].clone();
    let first = sdk
        .command(
            "hostApiResource",
            json!({"context":context,"length":1048576}),
        )
        .unwrap();
    let last = sdk
        .command(
            "hostApiResource",
            json!({"context":context,"offset":1048576,"length":1048576}),
        )
        .unwrap();
    assert_eq!(first["totalBytes"], resource.len());
    let mut actual: Vec<u8> = serde_json::from_value(first["bytes"].clone()).unwrap();
    actual.extend(serde_json::from_value::<Vec<u8>>(last["bytes"].clone()).unwrap());
    assert_eq!(actual, resource);
    // Desktop's numeric JSON transport represents exact integers as floats.
    assert_eq!(
        sdk.command(
            "hostApiResource",
            json!({
                "context":context,"offset":0.0,"length":1048576.0
            })
        )
        .unwrap(),
        first
    );
    assert_eq!(
        sdk.command(
            "hostApiResource",
            json!({
                "context":context,"offset":1048576.0,"length":1.0
            })
        )
        .unwrap()["bytes"],
        json!([resource[1048576]])
    );
    for request in [
        json!({"context":context,"length":1048577}),
        json!({"context":context,"length":0}),
        json!({"context":context,"length":1,"offset":resource.len()+1}),
        json!({"context":context,"length":1,"path":"assets/another.bin"}),
        json!({"context":context,"length":1.5}),
        json!({"context":context,"offset":0.5,"length":1}),
        json!({"context":context,"length":-1}),
        json!({"context":context,"offset":-1,"length":1}),
        json!({"context":context,"length":null}),
        json!({"context":context,"offset":null,"length":1}),
        json!({"context":context,"length":"1"}),
        json!({"context":context,"offset":"0","length":1}),
    ] {
        assert!(sdk.command("hostApiResource", request).is_err());
    }
    for non_json_number in ["NaN", "Infinity", "-Infinity"] {
        assert!(serde_json::from_str::<Value>(&format!(
            "{{\"context\":{context},\"length\":{non_json_number}}}"
        ))
        .is_err());
    }
    for field in ["callId", "sessionId", "api"] {
        let mut forged = context.clone();
        forged[field] = json!("untrusted");
        assert!(sdk
            .command("hostApiResource", json!({"context":forged,"length":1}))
            .is_err());
    }
    sdk.complete_host_api_call(call["callId"].as_str().unwrap(), Ok(json!({})))
        .unwrap();
    assert!(sdk
        .command("hostApiResource", json!({"context":context,"length":1}))
        .is_err());
}

#[test]
fn native_binary_commands_preserve_float_integer_bytes_ranges_and_js_transfer() {
    let pack = copied_pack("wx.request({url:'https://host.invalid/binary',responseType:'arraybuffer',success:r=>this.setData({message:(r.data instanceof ArrayBuffer)+':'+Array.from(new Uint8Array(r.data)).join(',')})});");
    let domain = tempfile::tempdir().unwrap();
    let mut services =
        trusted_services(pack.path(), &domain.path().display().to_string(), "binary");
    services.apis.push("wx.request".into());
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(services),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    let call = sdk
        .take_events()
        .into_iter()
        .find(|event| event["method"] == "wx.request")
        .unwrap();
    let handle = sdk
        .command("createHostBinary", json!({"bytes":[0.0,128.0,255.0]}))
        .unwrap();
    let id = handle["id"].as_str().unwrap();
    assert!(handle["accountEpoch"].is_string());
    assert_eq!(
        sdk.command("readHostBinary", json!({"id":id,"offset":1.0,"length":2.0}))
            .unwrap(),
        json!([128, 255])
    );
    assert_eq!(
        sdk.command("readHostBinary", json!({"id":id,"length":1.0}))
            .unwrap(),
        json!([0])
    );
    assert_eq!(
        sdk.command("readHostBinary", json!({"id":id,"offset":3.0,"length":0.0}))
            .unwrap(),
        json!([])
    );
    for value in [
        json!(-1),
        json!(-1.0),
        json!(0.5),
        json!(true),
        json!(null),
        json!("1"),
        json!(9007199254740992_u64),
    ] {
        assert!(
            sdk.command("readHostBinary", json!({"id":id,"offset":value,"length":1}))
                .is_err(),
            "invalid offset was silently treated as zero: {value}"
        );
        assert!(
            sdk.command("readHostBinary", json!({"id":id,"length":value}))
                .is_err(),
            "invalid length accepted: {value}"
        );
    }
    assert!(sdk
        .command("readHostBinary", json!({"id":id,"length":1048577.0}))
        .is_err());
    assert!(sdk
        .command(
            "readHostBinary",
            json!({"id":id,"offset":33554433.0,"length":0.0})
        )
        .is_err());
    for value in [
        json!(-1.0),
        json!(0.5),
        json!(256.0),
        json!(true),
        json!(null),
        json!("1"),
        json!([]),
    ] {
        assert!(
            sdk.command("createHostBinary", json!({"bytes":[value]}))
                .is_err(),
            "invalid byte accepted: {value}"
        );
    }
    assert!(sdk
        .command("createHostBinary", json!({"bytes":null}))
        .is_err());
    assert!(sdk
        .command("createHostBinary", json!({"bytes":vec![0.0;1048577]}))
        .is_err());
    sdk.command("retainHostBinary", json!({"id":id})).unwrap();
    sdk.command("releaseHostBinary", json!({"id":id})).unwrap();
    sdk.command("completeHostCall", json!({"callId":call["callId"],"result":{"statusCode":200,"data":{"__weappBinary":{"handle":id}}}})).unwrap();
    assert_eq!(data(&sdk)["message"], "true:0,128,255");
    assert!(sdk
        .command("readHostBinary", json!({"id":id,"length":1.0}))
        .is_err());
    let empty = sdk
        .command("createHostBinary", json!({"bytes":[]}))
        .unwrap();
    sdk.command("releaseHostBinary", json!({"id":empty["id"]}))
        .unwrap();
    // Numeric compatibility is deliberately limited to bytes/chunk indices.
    // Epoch/context identity fields keep their canonical string contract.
    assert!(
        serde_json::from_value::<HostAccount>(json!({"principalId":"alice","epoch":1.0})).is_err()
    );
    let account: HostAccount =
        serde_json::from_value(json!({"principalId":"alice","epoch":"9007199254740993"})).unwrap();
    assert_eq!(account.epoch, 9_007_199_254_740_993);
}

#[test]
fn legacy_import_is_explicit_and_deleted_accounts_release_all_scopes() {
    let pack = copied_pack("this.setData({count:wx.getStorageSync('visits')||0});");
    let directory = tempfile::tempdir().unwrap();
    let legacy = storage::PersistentStorage::open(directory.path(), "legacy").unwrap();
    legacy
        .queue(container_core::StorageSnapshot {
            values: BTreeMap::from([("visits".into(), json!(42))]),
            ..Default::default()
        })
        .unwrap();
    legacy.close().unwrap();
    let make = |app: &str| ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &directory.path().display().to_string(),
            app,
        )),
        storage_key: Some(app.into()),
        storage_root: Some(directory.path().into()),
        ..Default::default()
    };
    let mut one = ContainerSession::new(make("one")).unwrap();
    let mut two = ContainerSession::new(make("two")).unwrap();
    one.migrate_legacy_storage("legacy").unwrap();
    assert_eq!(
        one.migrate_legacy_storage("legacy").unwrap_err().code(),
        "ERR_STORAGE_CONFLICT"
    );
    load(&mut one, pack.path());
    load(&mut two, pack.path());
    assert_eq!(data(&one)["count"], 42);
    assert_eq!(data(&two)["count"], 0, "no automatic import in other app");
    let manager = one.account_manager().unwrap();
    assert_eq!(
        manager.delete_principal_data("alice").unwrap_err().code(),
        "ERR_ACCOUNT_ACTIVE"
    );
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    finish_account_switch(&mut one);
    finish_account_switch(&mut two);
    assert_eq!(manager.delete_principal_data("alice").unwrap(), 2);
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("alice".into()),
                epoch: 3,
            },
            BTreeMap::new(),
        )
        .unwrap();
    finish_account_switch(&mut one);
    finish_account_switch(&mut two);
    assert_eq!(
        data(&one)["count"],
        0,
        "deleted account cannot resurrect local data"
    );
    let legacy = storage::PersistentStorage::open(directory.path(), "legacy").unwrap();
    assert_eq!(
        legacy.initial.values["visits"], 42,
        "migration never deletes an unpartitioned source by inference"
    );
    legacy.close().unwrap();
}

fn unload_error_pack() -> tempfile::TempDir {
    let pack = copied_pack("this.setData({count:7});");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    let source = "App({onUnload(){throw new Error('old instance unload failed');}});";
    let digest = hex_digest(source.as_bytes());
    fs::write(pack.path().join("blobs/sha256").join(&digest), source).unwrap();
    manifest
        .modules
        .iter_mut()
        .find(|module| module.id == "module:app.js")
        .unwrap()
        .sha256 = digest;
    manifest.refresh_integrity().unwrap();
    fs::write(
        pack.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    pack
}

#[test]
fn replacement_freezes_unload_error_ownership_before_new_acceptance() {
    let pack = unload_error_pack();
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    let old = sdk.accepted_pack_identity().unwrap().unwrap();
    sdk.take_events();

    // A same-pack recovery still creates a distinct owner; root comparison
    // alone is insufficient to distinguish its delayed cleanup diagnostics.
    load(&mut sdk, pack.path());
    let current = sdk.accepted_pack_identity().unwrap().unwrap();
    assert_eq!(current.root, old.root);
    assert_ne!(current.session_id, old.session_id);
    assert_eq!(old.accepted_pack_revision, "1");
    assert_eq!(current.accepted_pack_revision, "2");
    let events = sdk.take_events();
    let errors = events
        .iter()
        .filter(|event| event["type"] == "error")
        .collect::<Vec<_>>();
    assert_eq!(errors.len(), 1, "{events:?}");
    assert_eq!(errors[0]["error"]["code"], "ERR_ENGINE");
    assert!(errors[0]["error"]["message"]
        .as_str()
        .unwrap()
        .contains("old instance unload failed"));
    assert_eq!(
        errors[0]["origin"],
        json!({"schemaVersion":1,"phase":"retirement","operation":"unload","sessionId":old.session_id,"acceptedPackIdentity":old})
    );
    let ready = events
        .iter()
        .find(|event| event["type"] == "ready")
        .unwrap();
    assert_eq!(ready["state"]["acceptedPackIdentity"], json!(current));
    sdk.pump(clock_now_ns()).unwrap();
    assert_eq!(data(&sdk)["count"], 7);
    assert!(!sdk.state().unwrap()["executionHealth"]["requiresRestart"]
        .as_bool()
        .unwrap());
    assert!(sdk
        .take_events()
        .iter()
        .all(|event| event["type"] != "error"));
}

#[test]
fn explicit_close_reports_unload_failure_with_the_closing_identity() {
    let pack = unload_error_pack();
    for asynchronous in [false, true] {
        let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
        load(&mut sdk, pack.path());
        let identity = sdk.accepted_pack_identity().unwrap().unwrap();
        sdk.take_events();
        if asynchronous {
            sdk.begin_close().unwrap();
            until(&mut sdk, |sdk| sdk.closed);
        } else {
            assert_eq!(sdk.close().unwrap_err().code(), "ERR_ENGINE");
        }
        let events = sdk.take_events();
        let errors = events
            .iter()
            .filter(|event| event["type"] == "error")
            .collect::<Vec<_>>();
        assert_eq!(errors.len(), 1, "{events:?}");
        assert_eq!(errors[0]["origin"]["acceptedPackIdentity"], json!(identity));
        assert_eq!(errors[0]["origin"]["operation"], "unload");
        assert!(events.iter().any(|event| event["type"] == "closed"));
        assert_eq!(sdk.accepted_pack_identity().unwrap(), None);
    }
}

#[test]
fn retirement_batches_keep_all_failures_and_foreign_errors_fail_safe() {
    use retirement::RetirementOperation;
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, &fixture());
    let identity = sdk.accepted_pack_identity().unwrap().unwrap();
    sdk.take_events();
    let error = |owner: &str, code: &str| {
        BridgeEnvelope::event(owner, op::ERROR, json!({"code":code,"message":"cleanup"}))
    };
    let mut response = error(&identity.session_id, "unused");
    response.kind = EnvelopeKind::Response;
    response.op = op::APP_LIFECYCLE.into();
    response.payload =
        json!({"ok":false,"error":{"code":"ERR_RENDER","message":"cleanup render failure"}});
    sdk.observe_retirement_result(
        Ok(BridgeBatch::new(vec![
            error(&identity.session_id, "ERR_ENGINE"),
            error("foreign-session", "ERR_ENGINE"),
            error("", "ERR_CANCELLED"),
            response,
        ])),
        Some(&identity),
        RetirementOperation::CancelHostCalls,
    );
    sdk.observe_retirement_result(
        Err(SdkError::new(
            "ERR_CANCELLED",
            "navigation retirement failed",
        )),
        Some(&identity),
        RetirementOperation::CancelNavigation,
    );
    sdk.push_retirement_error(
        SdkError::new("ERR_ENGINE", "unknown cleanup origin"),
        None,
        RetirementOperation::Unload,
    );
    let events = sdk.take_events();
    assert_eq!(events.len(), 6, "all cleanup failures remain observable");
    for index in [0, 3, 4] {
        assert_eq!(events[index]["type"], "error");
        assert_eq!(
            events[index]["origin"]["acceptedPackIdentity"],
            json!(identity)
        );
    }
    for index in [1, 2, 5] {
        assert_eq!(events[index]["type"], "error");
        assert!(events[index].get("origin").is_none());
    }
    assert_eq!(events[0]["origin"]["operation"], "cancelHostCalls");
    assert_eq!(events[3]["error"]["code"], "ERR_RENDER");
    assert_eq!(events[4]["origin"]["operation"], "cancelNavigation");
}

#[test]
fn current_runtime_errors_never_inherit_a_retirement_origin() {
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, &fixture());
    let session_id = sdk.state().unwrap()["sessionId"]
        .as_str()
        .unwrap()
        .to_owned();
    sdk.take_events();
    let batch = BridgeBatch::new(vec![BridgeEnvelope::event(
        session_id,
        op::ERROR,
        json!({"code":"ERR_ENGINE","message":"current execution failed"}),
    )]);
    assert_eq!(sdk.observe_batch(&batch).unwrap_err().code(), "ERR_ENGINE");
    let events = sdk.take_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["type"], "error");
    assert_eq!(events[0]["error"]["code"], "ERR_ENGINE");
    assert!(events[0].get("origin").is_none());
    assert_eq!(
        sdk.capabilities().unwrap()["diagnostics"]["retirementErrorOrigin"]["schemaVersion"],
        1
    );
}

fn until(session: &mut ContainerSession, check: impl Fn(&ContainerSession) -> bool) {
    let start = Instant::now();
    while !check(session) {
        session.pump(clock_now_ns()).unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "SDK operation timed out: {:?}",
            session.state()
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn data(session: &ContainerSession) -> Value {
    session
        .active
        .as_ref()
        .unwrap()
        .session
        .app_service()
        .pages()
        .current()
        .unwrap()
        .data
        .clone()
}

fn atomic_sdk() -> ContainerSession {
    ContainerSession::new(ContainerConfig {
        host_layout: Some(HostLayoutConfig {
            protocol_version: "1.0".into(),
            atomic: true,
        }),
        ..ContainerConfig::default()
    })
    .unwrap()
}

// Explicit trusted-host observation for API/lifecycle tests. These values are
// test inputs, never physical display or SDK installation acceptance evidence.
fn observed_test_host(width: u32, height: u32) -> HostMetadata {
    let metrics: HostWindowMetrics = serde_json::from_value(json!({
        "windowWidth":width,"windowHeight":height,"pixelRatio":1,
        "screenWidth":width,"screenHeight":height+80,"statusBarHeight":24,
        "screenTop":0,"deviceOrientation":"portrait"
    }))
    .unwrap();
    HostMetadata {
        window_width: width,
        window_height: height,
        display_metrics: Some(metrics.display),
        ..Default::default()
    }
}

fn measured_layout(
    sdk: &mut ContainerSession,
    surface: &HostSurfaceIdentity,
    width: u32,
    height: u32,
    revision: u64,
) -> HostLayout {
    let metrics: HostWindowMetrics = serde_json::from_value(json!({"windowWidth":width,"windowHeight":height,"pixelRatio":2.75,"screenWidth":width,"screenHeight":height+80,"statusBarHeight":24.0,"screenTop":44.0,"deviceOrientation":if width>height{"landscape"}else{"portrait"}})).unwrap();
    let observation = sdk
        .observe_host_layout(surface.clone(), metrics.clone())
        .unwrap();
    HostLayout {
        schema_version: 1,
        owner_id: observation.owner_id,
        surface_generation: observation.surface_generation,
        observation_id: observation.observation_id,
        layout_revision: revision.to_string(),
        window_metrics: metrics,
        chrome: HostChromeGeometry {
            schema_version: 1,
            revision,
            content_rect: ContentRect {
                left: 0.0,
                top: 44.0,
                width: f64::from(width),
                height: f64::from(height),
            },
            menu_button_rect: container_runtime::MenuButtonRect {
                left: f64::from(width) - 96.0,
                top: 27.0,
                right: f64::from(width) - 8.0,
                bottom: 59.0,
                width: 88.0,
                height: 32.0,
            },
            session_id: observation.session_id,
            page_id: observation.page_id,
        },
    }
}

#[test]
fn native_provider_geometry_rejects_unobserved_displays_and_omits_unknown_identity() {
    let mut provider = NativeProvider;
    let host = HostMetadata {
        platform: String::new(),
        version: String::new(),
        window_width: 375,
        window_height: 667,
        ..Default::default()
    };
    let context = ProviderContext {
        host,
        ..Default::default()
    };
    assert_eq!(
        provider.capabilities_for_host(&context.host)["wx.getWindowInfo"],
        CapabilitySupport::Unsupported
    );
    assert_eq!(
        provider.capabilities_for_host(&context.host)["wx.getDeviceInfo"],
        CapabilitySupport::Unsupported
    );
    assert!(provider
        .call("wx.getWindowInfo", &Map::new(), &context)
        .is_err());
    assert!(provider
        .call("wx.getDeviceInfo", &Map::new(), &context)
        .is_err());
    let base = provider
        .call("wx.getAppBaseInfo", &Map::new(), &context)
        .unwrap();
    assert_eq!(base["SDKVersion"], env!("CARGO_PKG_VERSION"));
    assert!(base.get("host").is_none());
    assert!(base.get("version").is_none());
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_native_provider_projects_host_layout_at_startup_and_same_size_updates() {
    // ContainerSession installs the production NativeProvider. Do not replace
    // it with SandboxProvider or host-services snapshots: this is the path used
    // by the shipped iOS/Flutter/native hosts before any page hook executes.
    let pack = page_pack(
        "Page({data:{count:0,message:'sdk',componentConfig:{label:'test'},layoutEvents:[],resizes:0},onLoad(){this.setData({initialWindow:wx.getWindowInfo()});wx.onHostLayoutChange(event=>this.setData({layoutEvents:this.data.layoutEvents.concat([{event,window:wx.getWindowInfo()}])}));},onResize(){this.setData({resizes:this.data.resizes+1});}});",
    );
    let manifest_path = pack.path().join("manifest.json");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    for api in ["wx.onHostLayoutChange", "wx.offHostLayoutChange"] {
        manifest
            .capabilities
            .insert(api.into(), CapabilitySupport::Partial);
    }
    manifest.refresh_integrity().unwrap();
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut metrics: HostWindowMetrics = serde_json::from_value(json!({
        "windowWidth":780,"windowHeight":1080,"pixelRatio":2,
        "screenWidth":780,"screenHeight":1080,"statusBarHeight":0,
        "screenTop":0,"deviceOrientation":"portrait",
        "hostLayout":{"version":1,"safeInsets":{"top":0,"right":84,"bottom":34,"left":0},
            "verticalBarEdge":"right","reservedRegions":[
                {"id":"camera","kind":"occlusion","x":740,"y":0,"width":40,"height":30}]}
    }))
    .unwrap();
    let first_layout = json!(metrics.display.host_layout);
    let mut sdk = ContainerSession::new(ContainerConfig {
        engine: EngineKind::Quickjs,
        host: HostMetadata {
            window_width: metrics.window_width,
            window_height: metrics.window_height,
            display_metrics: Some(metrics.display.clone()),
            ..Default::default()
        },
        ..Default::default()
    })
    .unwrap();
    assert!(sdk.config.host_services.is_none());
    load(&mut sdk, pack.path());
    let assert_layout = |actual: &Value, expected: &Value| {
        assert_eq!(
            serde_json::from_value::<container_runtime::HostLayout>(actual.clone()).unwrap(),
            serde_json::from_value::<container_runtime::HostLayout>(expected.clone()).unwrap()
        );
    };
    assert_layout(&data(&sdk)["initialWindow"]["hostLayout"], &first_layout);
    assert_eq!(data(&sdk)["resizes"], 0);

    let mut next_layout = first_layout.clone();
    next_layout["verticalBarEdge"] = json!("left");
    next_layout["safeInsets"] = json!({"top":0,"right":0,"bottom":34,"left":84});
    next_layout["reservedRegions"] = json!([
        {"id":"fold","kind":"division","x":388,"y":0,"width":4,"height":1080}
    ]);
    metrics.display.host_layout = Some(serde_json::from_value(next_layout.clone()).unwrap());
    sdk.update_window_metrics(metrics.clone()).unwrap();
    let changed = data(&sdk);
    assert_eq!(changed["layoutEvents"].as_array().unwrap().len(), 1);
    assert_layout(
        &changed["layoutEvents"][0]["event"]["hostLayout"],
        &next_layout,
    );
    assert_layout(
        &changed["layoutEvents"][0]["window"]["hostLayout"],
        &next_layout,
    );
    assert_eq!(changed["layoutEvents"][0]["window"]["windowWidth"], 780);
    assert_eq!(changed["resizes"], 0);

    // Omitting the optional extension must clear the accepted projection,
    // rather than retaining either the startup or the previous layout.
    metrics.display.host_layout = None;
    sdk.update_window_metrics(metrics).unwrap();
    let cleared = data(&sdk);
    assert_eq!(cleared["layoutEvents"].as_array().unwrap().len(), 2);
    assert_eq!(
        cleared["layoutEvents"][1]["event"]["hostLayout"],
        Value::Null
    );
    assert!(cleared["layoutEvents"][1]["window"]
        .get("hostLayout")
        .is_none());
    assert_eq!(cleared["resizes"], 0);
    sdk.close().unwrap();
}

fn production_geometry_public_sdk_chain(engine: EngineKind) {
    let pack = page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'}},capture(){this.setData({window:wx.getWindowInfo(),system:wx.getSystemInfoSync(),base:wx.getAppBaseInfo(),account:wx.getAccountInfoSync()});wx.getSystemInfoAsync().then(value=>this.setData({asyncSystem:value}));},onLoad(){this.capture();weappContainer.onMessage(()=>this.capture());},onResize(){this.capture();}});");
    let manifest_path = pack.path().join("manifest.json");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest
        .capabilities
        .insert("wx.getSystemInfoAsync".into(), CapabilitySupport::Partial);
    manifest.refresh_integrity().unwrap();
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let mut services = trusted_services(pack.path(), "observed-host-app", "mini-app");
    services.apis.clear();
    services.sync_values.insert(
        "wx.getSystemInfoSync".into(),
        json!({"brand":"OS-observed-brand","windowWidth":999,"pixelRatio":1}),
    );
    let mut sdk = ContainerSession::new(ContainerConfig {
        engine,
        host_services: Some(services),
        host_layout: Some(HostLayoutConfig {
            protocol_version: "1.0".into(),
            atomic: true,
        }),
        ..Default::default()
    })
    .unwrap();
    let surface = sdk.begin_host_surface().unwrap();
    let initial = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(initial),
            ..Default::default()
        },
    )
    .unwrap();
    let first = data(&sdk);
    assert_eq!(first["window"]["windowWidth"], 375);
    assert_eq!(first["system"]["windowWidth"], 375);
    assert_eq!(first["system"]["brand"], "OS-observed-brand");
    assert_eq!(first["asyncSystem"]["brand"], "OS-observed-brand");
    assert_eq!(first["asyncSystem"]["windowWidth"], 375);
    assert_eq!(first["asyncSystem"]["errMsg"], "getSystemInfoAsync:ok");
    assert_eq!(
        first["system"]["host"],
        json!({"appId":"observed-host-app"})
    );
    assert_eq!(first["base"]["host"], json!({"appId":"observed-host-app"}));
    assert!(first["base"].get("version").is_none());
    assert!(first["system"].get("model").is_none());
    assert_eq!(first["account"]["miniProgram"]["appId"], "mini-app");
    assert!(first["account"].get("principalId").is_none());
    let next = measured_layout(&mut sdk, &surface, 667, 375, 2);
    sdk.update_host_layout(next).unwrap();
    assert_eq!(data(&sdk)["window"]["windowWidth"], 667);
    assert_eq!(data(&sdk)["system"]["windowWidth"], 667);
    assert_eq!(data(&sdk)["system"]["pixelRatio"], 2.75);
    assert_eq!(data(&sdk)["system"]["brand"], "OS-observed-brand");
    assert_eq!(data(&sdk)["asyncSystem"]["windowWidth"], 667);
    let edited = presentation_edit(pack.path());
    let mut application = sdk
        .config
        .host_services
        .as_ref()
        .unwrap()
        .application
        .clone();
    application.pack_root = pack::VerifiedPack::load(PackSource::Directory(edited.path().into()))
        .unwrap()
        .manifest
        .integrity
        .root;
    application.version = "2".into();
    sdk.authorize_installed_pack(application).unwrap();
    let owner = sdk.state().unwrap()["sessionId"].clone();
    let reload = sdk
        .apply_dev_pack(
            PackSource::Directory(edited.path().into()),
            LoadOptions::default(),
        )
        .unwrap();
    assert_eq!(reload.reload_kind, DevReloadKind::InPlace);
    assert_eq!(sdk.state().unwrap()["sessionId"], owner);
    sdk.send_message(json!("read-after-trusted-upgrade"))
        .unwrap();
    assert_eq!(data(&sdk)["account"]["miniProgram"]["version"], "2");
    assert_eq!(data(&sdk)["system"]["windowWidth"], 667);
    assert_eq!(data(&sdk)["system"]["pixelRatio"], 2.75);
    assert_eq!(data(&sdk)["system"]["brand"], "OS-observed-brand");
    assert_eq!(data(&sdk)["asyncSystem"]["windowWidth"], 667);
    sdk.close().unwrap();
}

#[cfg(feature = "quickjs-native")]
#[test]
fn quickjs_production_geometry_public_sdk_chain() {
    production_geometry_public_sdk_chain(EngineKind::Quickjs);
}

#[cfg(feature = "v8-native")]
#[test]
fn v8_production_geometry_public_sdk_chain() {
    production_geometry_public_sdk_chain(EngineKind::V8);
}

#[test]
fn atomic_initial_layout_supplies_full_display_before_first_guest_hook() {
    let pack = copied_pack(
        "this.setData({window:wx.getWindowInfo(),menu:wx.getMenuButtonBoundingClientRect()});",
    );
    let mut sdk = atomic_sdk();
    assert!(sdk
        .load(
            PackSource::Directory(pack.path().into()),
            LoadOptions::default()
        )
        .is_err());
    let surface = sdk.begin_host_surface().unwrap();
    let layout = measured_layout(&mut sdk, &surface, 421, 701, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(layout),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(data(&sdk)["window"]["windowWidth"], 421);
    assert_eq!(data(&sdk)["window"]["pixelRatio"], 2.75);
    assert_eq!(data(&sdk)["window"]["screenHeight"], 781);
    assert_eq!(data(&sdk)["menu"]["left"], 325.0);
    assert!(sdk.state().unwrap()["chromeGeometryReady"]
        .as_bool()
        .unwrap());
    let identity = sdk.state().unwrap()["acceptedPackIdentity"].clone();
    assert_eq!(identity["acceptedPackRevision"], "1");
    assert_eq!(identity["sessionId"], sdk.state().unwrap()["sessionId"]);
    assert_eq!(
        sdk.command("windowMetrics", json!({})).unwrap_err().code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        sdk.resize(421, 701).unwrap_err().code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    let chrome = sdk.host_chrome.clone().unwrap();
    assert_eq!(
        sdk.update_host_chrome(chrome).unwrap_err().code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
}

#[test]
fn atomic_restart_requires_fresh_complete_measurement_before_guest_startup() {
    let pack = copied_pack("wx.setStorageSync('loads',(wx.getStorageSync('loads')||0)+1);this.setData({count:wx.getStorageSync('loads')});");
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let first = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(first),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    let identity = sdk.accepted_pack_identity().unwrap();
    let accepted = sdk.host_layout_state.accepted.clone().unwrap();
    assert!(sdk
        .load(
            PackSource::Directory(pack.path().into()),
            LoadOptions::default()
        )
        .is_err());
    assert_eq!(
        sdk.load(
            PackSource::Directory(pack.path().into()),
            LoadOptions {
                initial_host_layout: Some(accepted),
                ..LoadOptions::default()
            },
        )
        .unwrap_err()
        .code(),
        "ERR_CANCELLED"
    );
    assert_eq!(sdk.accepted_pack_identity().unwrap(), identity);
    assert_eq!(data(&sdk)["count"], 1);
    assert!(sdk.state().unwrap()["presentationEnabled"]
        .as_bool()
        .unwrap());

    let next = measured_layout(&mut sdk, &surface, 421, 701, 2);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(next),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(data(&sdk)["count"], 2);
    assert_eq!(sdk.state().unwrap()["viewport"]["width"], 421);
    assert_eq!(
        sdk.state().unwrap()["acceptedPackIdentity"]["acceptedPackRevision"],
        "2"
    );
}

#[test]
fn view_timeout_stops_render_retries_but_keeps_appservice_timers_and_restart_journal() {
    let pack = page_pack("Page({data:{spin:false,ticks:0,hides:0},onLoad(){setInterval(()=>{this.setData({ticks:this.data.ticks+1,spin:true});},10)},onHide(){this.setData({hides:this.data.hides+1});}});");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    let source = "exports.run=function(spin){if(spin)while(true){}return 'ready';};";
    let hash = hex_digest(source.as_bytes());
    fs::write(pack.path().join("blobs/sha256").join(&hash), source).unwrap();
    manifest.view_scripts.push(container_ir::ViewScriptModule {
        id: "wxs:shared/spin.wxs".into(),
        sha256: hash,
        dependencies: Vec::new(),
    });
    let ast = container_ir::parse_wxml(
        "<wxs module=\"tools\" src=\"../../shared/spin.wxs\"/><text>{{tools.run(spin)}}</text>",
    )
    .unwrap()
    .canonical_json()
    .unwrap();
    let hash = hex_digest(&ast);
    fs::write(pack.path().join("blobs/sha256").join(&hash), ast).unwrap();
    let template = manifest
        .templates
        .iter_mut()
        .find(|entry| entry.id == "template:pages/home/index.wxml")
        .unwrap();
    template.wxml_ast = format!("sha256:{hash}");
    template.wxs_modules =
        std::collections::BTreeMap::from([("tools".into(), "wxs:shared/spin.wxs".into())]);
    manifest.refresh_integrity().unwrap();
    fs::write(
        pack.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    let frame = sdk.frame().unwrap().unwrap().clone();
    let identity = sdk.accepted_pack_identity().unwrap().unwrap();
    let error = sdk
        .pump(clock_now_ns().saturating_add(20_000_000))
        .unwrap_err();
    assert_eq!(error.code(), "ERR_TIMEOUT");
    let state = sdk.state().unwrap();
    assert_eq!(state["executionHealth"]["viewFault"]["code"], "ERR_TIMEOUT");
    assert!(state["executionHealth"]["requiresRestart"]
        .as_bool()
        .unwrap());
    assert_eq!(state["foreground"], true);
    assert_eq!(state["inputEnabled"], false);
    assert_eq!(state["presentationEnabled"], false);
    assert_eq!(sdk.input(vec![]).unwrap_err().code(), "ERR_CANCELLED");
    let ticks = data(&sdk)["ticks"].as_u64().unwrap();
    let metrics = state["viewExecutionMetrics"].clone();
    assert_eq!(metrics["frontier"]["providerStages"]["batches"], 1);
    assert_eq!(
        metrics["frontier"]["providerStages"]["compileNs"],
        Value::Null
    );
    assert!(
        metrics["frontier"]["providerStages"]["executeIncludingLazyCompileNs"]
            .as_u64()
            .unwrap()
            > 0
    );
    for step in 1..=3 {
        sdk.pump(clock_now_ns().saturating_add(20_000_000 * (step + 1)))
            .unwrap();
    }
    assert!(data(&sdk)["ticks"].as_u64().unwrap() > ticks);
    assert_eq!(data(&sdk)["hides"], 0);
    assert_eq!(sdk.state().unwrap()["viewExecutionMetrics"], metrics);
    assert_eq!(sdk.frame().unwrap(), Some(&frame));
    assert_eq!(
        sdk.accepted_pack_identity().unwrap(),
        Some(identity.clone())
    );
    assert_eq!(
        sdk.classify_dev_pack(PackSource::Directory(pack.path().into()))
            .unwrap(),
        DevReloadKind::Restart
    );

    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"applyDevPack","packPath":pack.path(),"expectedAccepted":identity}),
        )
        .unwrap();
    let submission = json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":identity});
    let receipt = sdk
        .command("applyDevPackAttempt", submission.clone())
        .unwrap();
    assert_eq!(receipt["status"], "accepted");
    assert_eq!(receipt["reloadKind"], "restart");
    assert_eq!(receipt["acceptedPackIdentity"]["acceptedPackRevision"], "2");
    assert!(!sdk.state().unwrap()["executionHealth"]["requiresRestart"]
        .as_bool()
        .unwrap());
    assert_eq!(
        sdk.command("applyDevPackAttempt", submission).unwrap(),
        receipt
    );
}

#[test]
fn atomic_observations_do_not_publish_half_layout_and_reject_same_size_old_ids() {
    let pack = page_pack("Page({data:{samples:[],ticks:0,count:0,message:'sdk',componentConfig:{label:'test'}},onLoad(){setInterval(()=>{this.setData({ticks:this.data.ticks+1,window:wx.getWindowInfo(),menu:wx.getMenuButtonBoundingClientRect()});},1)},onResize(){this.setData({samples:this.data.samples.concat([{window:wx.getWindowInfo(),menu:wx.getMenuButtonBoundingClientRect()}])});}});");
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let initial = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(initial),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    let stale = measured_layout(&mut sdk, &surface, 667, 375, 2);
    let fresh = measured_layout(&mut sdk, &surface, 375, 667, 3);
    sdk.pump(clock_now_ns().saturating_add(10_000_000)).unwrap();
    assert_eq!(data(&sdk)["window"]["windowWidth"], 375);
    assert_eq!(data(&sdk)["menu"]["left"], 279.0);
    assert!(data(&sdk)["ticks"].as_u64().unwrap() > 0);
    assert_eq!(
        sdk.update_host_layout(stale).unwrap_err().code(),
        "ERR_CANCELLED"
    );
    sdk.update_host_layout(fresh.clone()).unwrap();
    assert_eq!(data(&sdk)["samples"], json!([]));
    sdk.update_host_layout(fresh).unwrap();
    let changed = measured_layout(&mut sdk, &surface, 667, 375, 4);
    sdk.update_host_layout(changed).unwrap();
    assert_eq!(data(&sdk)["samples"].as_array().unwrap().len(), 1);
    assert_eq!(data(&sdk)["samples"][0]["window"]["windowWidth"], 667);
    assert_eq!(data(&sdk)["samples"][0]["menu"]["left"], 571.0);
}

#[test]
fn atomic_surface_replacement_timeout_and_owner_are_explicit() {
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let old = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.poll_host_layout_timeout(u64::MAX);
    assert_eq!(
        sdk.update_host_layout(old.clone()).unwrap_err().code(),
        "ERR_TIMEOUT"
    );
    sdk.end_host_surface(&surface).unwrap();
    let new_surface = sdk.begin_host_surface().unwrap();
    assert_ne!(surface, new_surface);
    assert_eq!(
        sdk.update_host_layout(old).unwrap_err().code(),
        "ERR_CANCELLED"
    );
    let mut wrong = new_surface.clone();
    wrong.owner_id = "999999".into();
    assert!(sdk.observe_host_layout(wrong,serde_json::from_value(json!({"windowWidth":375,"windowHeight":667,"pixelRatio":1,"screenWidth":375,"screenHeight":750,"statusBarHeight":20,"screenTop":44,"deviceOrientation":"portrait"})).unwrap()).is_err());
    let fresh = measured_layout(&mut sdk, &new_surface, 375, 667, 2);
    sdk.update_host_layout(fresh).unwrap();
    assert!(sdk
        .take_events()
        .iter()
        .any(|event| event["type"] == "hostLayoutError"));
}

#[test]
fn atomic_layout_keeps_committed_geometry_after_resize_hook_error_without_replay() {
    let pack=page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'}},onResize(){this.setData({count:this.data.count+1});throw new Error('resize hook failed after commit');}});");
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let initial = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(initial),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    let changed = measured_layout(&mut sdk, &surface, 667, 375, 2);
    assert!(sdk.update_host_layout(changed.clone()).is_err());
    assert_eq!(sdk.state().unwrap()["viewport"]["width"], 667);
    assert_eq!(
        sdk.state().unwrap()["acceptedLayout"]["layoutRevision"],
        "2"
    );
    assert_eq!(data(&sdk)["count"], 1);
    sdk.update_host_layout(changed).unwrap();
    assert_eq!(data(&sdk)["count"], 1);
}

#[test]
fn sdk_attempt_receipt_is_identical_on_apply_query_event_and_does_not_reexecute() {
    let pack = copied_pack("wx.setStorageSync('start',(wx.getStorageSync('start')||0)+1);this.setData({count:wx.getStorageSync('start')});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null}),
        )
        .unwrap();
    let apply =
        json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":null});
    let result = sdk.command("applyDevPackAttempt", apply.clone()).unwrap();
    assert_eq!(result["status"], "accepted");
    assert_eq!(data(&sdk)["count"], 1);
    assert_eq!(sdk.command("applyDevPackAttempt", apply).unwrap(), result);
    assert_eq!(
        sdk.command(
            "queryDevPackAttempt",
            json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"]})
        )
        .unwrap(),
        result
    );
    let event = sdk
        .take_events()
        .into_iter()
        .rev()
        .find(|event| event["type"] == "devPackAttempt")
        .unwrap();
    assert_eq!(event["receipt"], result);
    assert_eq!(data(&sdk)["count"], 1);
    assert_eq!(
        sdk.state().unwrap()["acceptedPackIdentity"]["acceptedPackRevision"],
        "1"
    );
    assert_eq!(sdk.command("applyDevPackAttempt",json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":result["acceptedPackIdentity"]})).unwrap_err().code(),"ERR_INVALID_REQUEST");
}

#[test]
fn sdk_attempt_state_observation_failure_cannot_lose_an_accepted_terminal_receipt() {
    let pack = copied_pack("wx.setStorageSync('loads',(wx.getStorageSync('loads')||0)+1);this.setData({count:wx.getStorageSync('loads')});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null}),
        )
        .unwrap();
    let submission =
        json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":null});
    let receipt = sdk
        .apply_dev_pack_attempt_observing(submission.clone(), |_| {
            Err(SdkError::new(
                "ERR_INVALID_MANIFEST",
                "fixture state observation failed after publication",
            ))
        })
        .unwrap();
    assert_eq!(receipt.status, "accepted");
    assert_eq!(
        receipt.accepted_pack_identity,
        sdk.accepted_pack_identity().unwrap()
    );
    assert!(receipt.state.is_none());
    assert!(receipt.error.is_none());
    assert_eq!(receipt.observation_errors,json!([{"phase":"state","error":{"code":"ERR_INVALID_MANIFEST","message":"fixture state observation failed after publication"}}]).as_array().unwrap().clone());
    let encoded = serde_json::to_value(receipt).unwrap();
    assert_eq!(
        sdk.command(
            "queryDevPackAttempt",
            json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"]})
        )
        .unwrap(),
        encoded
    );
    assert_eq!(
        sdk.command("applyDevPackAttempt", submission.clone())
            .unwrap(),
        encoded
    );
    assert_eq!(data(&sdk)["count"], 1);
    assert_eq!(
        sdk.take_events()
            .into_iter()
            .rev()
            .find(|event| event["type"] == "devPackAttempt")
            .unwrap()["receipt"],
        encoded
    );
    sdk.close().unwrap();
    assert_eq!(
        sdk.command("acceptedPackIdentity", json!({})).unwrap(),
        Value::Null
    );
    assert_eq!(
        sdk.command(
            "queryDevPackAttempt",
            json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"]})
        )
        .unwrap(),
        encoded
    );
    assert_eq!(
        sdk.command("applyDevPackAttempt", submission).unwrap(),
        encoded
    );
}

#[test]
fn sdk_attempt_rejection_keeps_execution_error_separate_from_state_observation_error() {
    let pack = copied_pack("throw new Error('candidate startup failed');");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null}),
        )
        .unwrap();
    let submission =
        json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":null});
    let receipt = sdk
        .apply_dev_pack_attempt_observing(submission.clone(), |_| {
            Err(SdkError::new(
                "ERR_INVALID_MANIFEST",
                "fixture state observation failed",
            ))
        })
        .unwrap();
    assert_eq!(receipt.status, "rejected");
    assert!(receipt.accepted_pack_identity.is_none());
    assert!(
        receipt.error.as_ref().unwrap()["message"]
            .as_str()
            .unwrap()
            .contains("candidate startup failed"),
        "unexpected attempt rejection: {receipt:?}"
    );
    assert_eq!(receipt.observation_errors[0]["phase"], "state");
    assert_eq!(
        receipt.observation_errors[0]["error"]["code"],
        "ERR_INVALID_MANIFEST"
    );
    assert_eq!(
        sdk.command("applyDevPackAttempt", submission).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    assert!(sdk.active.is_none());
}

#[test]
fn sdk_attempt_journal_rejects_stale_identity_and_never_reexecutes_evicted_id() {
    let pack = copied_pack("this.setData({count:7});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let mut first = Value::Null;
    for index in 0..65 {
        let begin = sdk
            .command(
                "beginDevPackAttempt",
                json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null}),
            )
            .unwrap();
        if index == 0 {
            first = begin.clone();
        }
        let receipt = sdk
            .command(
                "cancelDevPackAttempt",
                json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"]}),
            )
            .unwrap();
        assert_eq!(receipt["status"], "cancelled");
    }
    assert_eq!(sdk.command("applyDevPackAttempt",json!({"ownerId":first["ownerId"],"attemptId":first["attemptId"],"expectedAccepted":null})).unwrap_err().code(),"ERR_CANCELLED");
    let missing = sdk
        .command(
            "queryDevPackAttempt",
            json!({"ownerId":first["ownerId"],"attemptId":first["attemptId"]}),
        )
        .unwrap();
    assert_eq!(missing["status"], "notRetained");
    assert_eq!(missing["acceptedPackIdentity"], Value::Null);
    assert_eq!(missing["attemptId"], first["attemptId"]);
    let unseen = sdk
        .command(
            "queryDevPackAttempt",
            json!({"ownerId":first["ownerId"],"attemptId":"66"}),
        )
        .unwrap();
    assert_eq!(unseen["status"], "notSeen");
    assert_eq!(
        sdk.command(
            "queryDevPackAttempt",
            json!({"ownerId":"999999","attemptId":"66"})
        )
        .unwrap_err()
        .code(),
        "ERR_CANCELLED"
    );
    assert!(sdk.active.is_none());
    load(&mut sdk, pack.path());
    let observed = sdk
        .command(
            "queryDevPackAttempt",
            json!({"ownerId":first["ownerId"],"attemptId":first["attemptId"]}),
        )
        .unwrap();
    assert_eq!(observed["status"], "notRetained");
    assert_eq!(
        observed["acceptedPackIdentity"],
        sdk.command("acceptedPackIdentity", json!({})).unwrap()
    );
    assert_eq!(data(&sdk)["count"], 7);
    assert_eq!(
        sdk.command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null})
        )
        .unwrap_err()
        .code(),
        "ERR_CANCELLED"
    );
}

#[test]
fn sdk_attempt_pins_verified_root_and_preserves_healthy_accepted_on_failure() {
    let good = copied_pack("this.setData({count:7});");
    let bad = copied_pack("throw new Error('candidate failure');");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, good.path());
    let expected = sdk.state().unwrap()["acceptedPackIdentity"].clone();
    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"applyDevPack","packPath":bad.path(),"expectedAccepted":expected}),
        )
        .unwrap();
    let apply = json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":expected});
    let result = sdk.command("applyDevPackAttempt", apply.clone()).unwrap();
    assert_eq!(result["status"], "rejected");
    assert_eq!(sdk.state().unwrap()["acceptedPackIdentity"], expected);
    assert_eq!(data(&sdk)["count"], 7);
    assert_eq!(sdk.command("applyDevPackAttempt", apply).unwrap(), result);
    assert!(!sdk.state().unwrap()["executionHealth"]["requiresRestart"]
        .as_bool()
        .unwrap());
}

#[test]
fn sdk_attempt_cancellation_records_the_actual_new_accepted_identity() {
    let pack = copied_pack("wx.setStorageSync('loads',(wx.getStorageSync('loads')||0)+1);this.setData({count:wx.getStorageSync('loads')});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    let expected = sdk.accepted_pack_identity().unwrap();
    let prepared = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":expected}),
        )
        .unwrap();
    load(&mut sdk, pack.path());
    let identity = sdk.accepted_pack_identity().unwrap();
    assert_ne!(expected, identity);
    let receipt = sdk
        .command(
            "queryDevPackAttempt",
            json!({"ownerId":prepared["ownerId"],"attemptId":prepared["attemptId"]}),
        )
        .unwrap();
    assert_eq!(receipt["status"], "cancelled");
    assert_eq!(
        receipt["acceptedPackIdentity"],
        serde_json::to_value(identity).unwrap()
    );
    let submission = json!({"ownerId":prepared["ownerId"],"attemptId":prepared["attemptId"],"expectedAccepted":expected});
    assert_eq!(
        sdk.command("applyDevPackAttempt", submission).unwrap(),
        receipt
    );
    assert_eq!(data(&sdk)["count"], 2);
}

#[test]
fn sdk_attempt_rejects_changed_pack_bytes_before_any_guest_execution() {
    let pack = copied_pack("this.setData({count:7});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let begin = sdk
        .command(
            "beginDevPackAttempt",
            json!({"operation":"load","packPath":pack.path(),"expectedAccepted":null}),
        )
        .unwrap();
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    manifest.compiler.commit = "changed-after-begin".into();
    manifest.refresh_integrity().unwrap();
    fs::write(
        pack.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let apply =
        json!({"ownerId":begin["ownerId"],"attemptId":begin["attemptId"],"expectedAccepted":null});
    let receipt = sdk.command("applyDevPackAttempt", apply.clone()).unwrap();
    assert_eq!(receipt["status"], "rejected");
    assert_eq!(receipt["error"]["code"], "ERR_INVALID_MANIFEST");
    assert!(sdk.active.is_none());
    assert_eq!(sdk.command("applyDevPackAttempt", apply).unwrap(), receipt);
}

#[test]
fn atomic_sdk_native_navigation_waits_for_exact_layout_and_rebinds_target_owner() {
    let pack = copied_pack("this.setData({width:wx.getWindowInfo().windowWidth,menu:wx.getMenuButtonBoundingClientRect()});");
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let initial = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(initial),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    let original = sdk.state().unwrap()["page"]["id"].clone();
    sdk.navigate("pages/home/index", json!({"id":2}), false)
        .unwrap();
    let pending = sdk.state().unwrap()["pendingNavigation"].clone();
    assert!(pending["ticket"].is_string());
    assert_eq!(sdk.state().unwrap()["page"]["id"], original);
    assert_eq!(data(&sdk)["width"], 375);
    assert!(!sdk.state().unwrap()["chromeGeometryReady"]
        .as_bool()
        .unwrap());
    let target = measured_layout(&mut sdk, &surface, 667, 375, 2);
    assert_eq!(
        sdk.update_host_layout(target.clone()).unwrap_err().code(),
        "ERR_INVALID_REQUEST"
    );
    sdk.complete_navigation_host_layout(pending["ticket"].as_str().unwrap(), target)
        .unwrap();
    let after = sdk.state().unwrap();
    assert_ne!(after["page"]["id"], original);
    assert_eq!(data(&sdk)["width"], 667);
    assert_eq!(data(&sdk)["menu"]["left"], 571.0);
    assert_eq!(
        after["acceptedLayout"]["chrome"]["pageId"],
        after["page"]["id"]
    );
    assert!(after["pendingNavigation"].is_null());
    sdk.back().unwrap();
    let pending = sdk.state().unwrap()["pendingNavigation"].clone();
    let target = measured_layout(&mut sdk, &surface, 375, 667, 3);
    sdk.complete_navigation_host_layout(pending["ticket"].as_str().unwrap(), target)
        .unwrap();
    assert_eq!(sdk.state().unwrap()["page"]["id"], original);
}

#[test]
fn atomic_navigation_uses_private_page_receivers_when_public_tables_are_frozen_or_replaced() {
    let engines = vec![
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ];
    for engine in engines {
        for sabotage in [
            "Object.freeze(globalThis.__container_page_instances);",
            "Object.defineProperty(globalThis,'__container_page_instances',{value:Object.freeze(Object.create(null)),writable:false,configurable:false});",
        ] {
            let pack = page_pack(&format!("Page({{data:{{count:0,message:'sdk',componentConfig:{{label:'test'}}}},onHide(){{{sabotage}}},onLoad(){{this.setData({{width:wx.getWindowInfo().windowWidth}})}}}});"));
            let mut sdk = ContainerSession::new(ContainerConfig {
                engine,
                host_layout: Some(HostLayoutConfig { protocol_version: "1.0".into(), atomic: true }),
                ..ContainerConfig::default()
            }).unwrap();
            let surface = sdk.begin_host_surface().unwrap();
            let first = measured_layout(&mut sdk, &surface, 375, 667, 1);
            sdk.load(PackSource::Directory(pack.path().into()), LoadOptions { initial_host_layout: Some(first), ..LoadOptions::default() }).unwrap();
            sdk.navigate("pages/home/index", json!({"private":"yes"}), false).unwrap();
            let ticket = sdk.state().unwrap()["pendingNavigation"]["ticket"].as_str().unwrap().to_owned();
            let target = measured_layout(&mut sdk, &surface, 421, 701, 2);
            sdk.complete_navigation_host_layout(&ticket, target).unwrap();
            assert_eq!(data(&sdk)["width"], 421, "{engine:?}: {sabotage}");
            assert!(!sdk.state().unwrap()["executionHealth"]["requiresRestart"].as_bool().unwrap(), "{engine:?}: {sabotage}");
            let page_id = sdk.state().unwrap()["page"]["id"].as_u64().unwrap();
            let active = sdk.active.as_mut().unwrap();
            active.dispatch(op::DATA_PATCH_BATCH, json!({"pageId":page_id,"patches":[{"op":"set","path":"count","value":29}]})).unwrap();
            assert_eq!(active.session.app_service().pages().current().unwrap().data["count"], 29);
            sdk.back().unwrap();
            let ticket = sdk.state().unwrap()["pendingNavigation"]["ticket"].as_str().unwrap().to_owned();
            let target = measured_layout(&mut sdk, &surface, 375, 667, 3);
            sdk.complete_navigation_host_layout(&ticket, target).unwrap();
            assert_eq!(data(&sdk)["width"], 375, "{engine:?}: {sabotage}");
        }
    }
}

#[test]
fn atomic_navigation_from_app_launch_never_runs_target_hooks_before_measurement() {
    let pack=copied_pack("wx.setStorageSync('loads',(wx.getStorageSync('loads')||0)+1);this.setData({count:wx.getStorageSync('loads'),width:wx.getWindowInfo().windowWidth});");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    let source = "App({onLaunch(){wx.navigateTo({url:'pages/home/index'}).catch(function(){});}});";
    let digest = hex_digest(source.as_bytes());
    fs::write(pack.path().join("blobs/sha256").join(&digest), source).unwrap();
    manifest
        .modules
        .iter_mut()
        .find(|module| module.id == "module:app.js")
        .unwrap()
        .sha256 = digest;
    manifest.refresh_integrity().unwrap();
    fs::write(
        pack.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let mut sdk = atomic_sdk();
    let surface = sdk.begin_host_surface().unwrap();
    let initial = measured_layout(&mut sdk, &surface, 375, 667, 1);
    sdk.load(
        PackSource::Directory(pack.path().into()),
        LoadOptions {
            initial_host_layout: Some(initial),
            ..LoadOptions::default()
        },
    )
    .unwrap();
    assert_eq!(data(&sdk)["count"], 1);
    assert_eq!(
        sdk.active
            .as_ref()
            .unwrap()
            .session
            .app_service()
            .pages()
            .len(),
        1
    );
    let pending = sdk.state().unwrap()["pendingNavigation"].clone();
    assert!(pending["ticket"].is_string());
    let target = measured_layout(&mut sdk, &surface, 667, 375, 2);
    sdk.complete_navigation_host_layout(pending["ticket"].as_str().unwrap(), target)
        .unwrap();
    assert_eq!(data(&sdk)["count"], 2);
    assert_eq!(data(&sdk)["width"], 667);
}

#[test]
fn cpu_frame_acquisitions_share_pixels_and_retained_frames_survive_resize_and_close() {
    let pack = copied_pack("");
    let mut session = ContainerSession::new(ContainerConfig {
        host: observed_test_host(64, 48),
        ..Default::default()
    })
    .unwrap();
    load(&mut session, pack.path());
    let (revision, first) = session.frame_snapshot_shared().unwrap().unwrap();
    let (_, repeated) = session.frame_snapshot_shared().unwrap().unwrap();
    assert!(Arc::ptr_eq(&first, &repeated));
    let diagnostics = session.command("renderDiagnostics", json!({})).unwrap();
    assert_eq!(diagnostics["snapshotCaptures"], 1);
    assert_eq!(diagnostics["snapshotCacheHits"], 1);
    let original_pixels = first.pixels.clone();
    session.resize(80, 60).unwrap();
    let (next_revision, next) = session.frame_snapshot_shared().unwrap().unwrap();
    assert!(next_revision > revision);
    assert!(!Arc::ptr_eq(&first, &next));
    assert_eq!((next.width, next.height), (80, 60));
    session.close().unwrap();
    assert_eq!((first.width, first.height), (64, 48));
    assert_eq!(first.pixels, original_pixels);
}

#[test]
fn real_quickjs_pack_startup_and_independent_instances() {
    let pack = copied_pack("this.setData({count:3, width:wx.getWindowInfo().windowWidth});");
    let mut first = ContainerSession::new(ContainerConfig {
        host: observed_test_host(375, 667),
        ..Default::default()
    })
    .unwrap();
    let mut second = ContainerSession::new(ContainerConfig {
        host: observed_test_host(280, 400),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut first, pack.path());
    load(&mut second, pack.path());
    assert_eq!(data(&first)["count"], 3);
    assert_eq!(data(&first)["width"], 375);
    assert_eq!(data(&second)["width"], 280);
    assert_ne!(
        first.state().unwrap()["sessionId"],
        second.state().unwrap()["sessionId"]
    );
    let (revision, snapshot) = first.frame_snapshot().unwrap().unwrap();
    assert!(revision > 0);
    assert_eq!((snapshot.width, snapshot.height), (375, 667));
    first.attach_surface("one").unwrap();
    assert_eq!(
        first.attach_surface("two").unwrap_err().code(),
        "ERR_SURFACE_ATTACHED"
    );
    assert_eq!(first.close().unwrap_err().code(), "ERR_SURFACE_ATTACHED");
    first.detach_surface("one").unwrap();
    first.close().unwrap();
    assert!(second.frame().unwrap().is_some());
}

#[test]
fn android_reference_pack_uses_host_observations() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/hosts/android/app/src/main/assets/portable-pack");
    let mut session = ContainerSession::new(ContainerConfig {
        host: observed_test_host(375, 667),
        ..Default::default()
    })
    .unwrap();
    load(&mut session, &path);
    assert!(session.frame().unwrap().is_some());
    session.close().unwrap();
}

#[test]
fn failed_candidate_retains_old_session_and_does_not_publish_effects() {
    let good = copied_pack("wx.setStorageSync('value','original');this.setData({count:7});");
    let bad=copied_pack("wx.setStorageSync('value','bad');weappContainer.postMessage('must-not-escape');weappContainer.invoke('echo',{});throw new Error('candidate fails');");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    session.register_host_method("echo").unwrap();
    load(&mut session, good.path());
    let before = session.state().unwrap();
    session.take_events();
    assert!(session
        .load(
            PackSource::Directory(bad.path().into()),
            LoadOptions::default()
        )
        .is_err());
    assert_eq!(session.state().unwrap()["sessionId"], before["sessionId"]);
    assert_eq!(data(&session)["count"], 7);
    assert_eq!(
        session
            .active
            .as_ref()
            .unwrap()
            .session
            .storage_snapshot()
            .values["value"],
        "original"
    );
    assert!(session.take_events().is_empty());
    assert_eq!(
        session
            .active
            .as_ref()
            .unwrap()
            .session
            .pending_host_call_count(),
        0
    );
}

#[test]
fn business_calls_messages_and_stale_completion() {
    let pack=copied_pack("weappContainer.onMessage(m=>{this.setData({message:m.text});});weappContainer.invoke('echo',{n:5}).then(v=>{this.setData({count:v.n});weappContainer.postMessage({done:v.n});});");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    session.register_host_method("echo").unwrap();
    load(&mut session, pack.path());
    let events = session.take_events();
    let call = events.iter().find(|e| e["type"] == "hostCall").unwrap();
    let id = call["callId"].as_str().unwrap();
    session.complete_host_call(id, Ok(json!({"n":19}))).unwrap();
    assert_eq!(data(&session)["count"], 19);
    assert!(session
        .take_events()
        .iter()
        .any(|e| e["type"] == "message" && e["message"]["done"] == 19));
    session.send_message(json!({"text":"native"})).unwrap();
    assert_eq!(data(&session)["message"], "native");
    session
        .complete_host_call(id, Ok(json!({"n":999})))
        .unwrap();
    assert_eq!(data(&session)["count"], 19);
    load(&mut session, pack.path());
    session
        .complete_host_call(id, Ok(json!({"n":999})))
        .unwrap();
    assert_eq!(data(&session)["count"], 0);
}

#[test]
fn failed_http_continuations_do_not_discard_drained_host_effects() {
    let pack = copied_pack(
        r#"
        weappContainer.invoke('echo', {hold:true}, {cancelToken:'hold'}).catch(()=>{});
        weappContainer.onMessage(message=>{
            if(message!=='arm') return;
            wx.request({url:'https://never-started.invalid/first',fail:()=>{
                wx.setStorageSync('firstRejected',true);
                throw new Error('first rejection callback failed');
            }}).catch(()=>{});
            wx.request({url:'https://never-started.invalid/second',fail:()=>{
                wx.setStorageSync('secondRejected',true);
                throw new Error('second rejection callback failed');
            }}).catch(()=>{});
            weappContainer.postMessage({tail:true});
            weappContainer.invoke('echo', {tail:true});
        });
        "#,
    );
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    session.register_host_method("echo").unwrap();
    load(&mut session, pack.path());
    let events = session.take_events();
    let held_call = events
        .iter()
        .find(|event| event["type"] == "hostCall" && event["payload"]["hold"] == true)
        .unwrap()["callId"]
        .as_str()
        .unwrap()
        .to_owned();
    // Exercise the real HTTP rejection path without creating network work.
    session.http_calls = (0..MAX_HTTP_REQUESTS)
        .map(|index| format!("occupied-{index}"))
        .collect();
    let runtime = &mut session.active_mut().unwrap().session;
    runtime.send_host_message(json!("arm")).unwrap();
    let cancellation = runtime.dispatch(BridgeEnvelope::request(
        runtime.config().session_id.clone(),
        "cancel-held-call",
        op::CANCEL,
        json!({"cancelToken":"hold"}),
    ));
    validate_batch(&cancellation).unwrap();
    assert_eq!(runtime.pending_host_call_count(), 3);

    assert_eq!(session.dispatch_effects().unwrap_err().code(), "ERR_ENGINE");

    let runtime = &session.active.as_ref().unwrap().session;
    let storage = runtime.storage_snapshot();
    assert_eq!(storage.values["firstRejected"], true);
    assert_eq!(storage.values["secondRejected"], true);
    assert_eq!(runtime.pending_host_call_count(), 1);
    let events = session.take_events();
    assert_eq!(
        events
            .iter()
            .filter(|event| event["type"] == "error")
            .count(),
        2
    );
    assert!(events
        .iter()
        .any(|event| event["type"] == "message" && event["message"]["tail"] == true));
    assert!(events.iter().any(|event| event["type"] == "hostCall"
        && event["method"] == "echo"
        && event["payload"]["tail"] == true));
    assert!(events
        .iter()
        .any(|event| event["type"] == "hostCallCancelled" && event["callId"] == held_call));
    session.http_calls.clear();
}

#[test]
fn persistent_storage_is_lossless_exclusive_and_async_close_releases_lock() {
    let directory = tempfile::tempdir().unwrap();
    let config = ContainerConfig {
        storage_root: Some(directory.path().into()),
        storage_key: Some("app.example/account-A".into()),
        ..ContainerConfig::default()
    };
    let pack=copied_pack("wx.setStorageSync('undefined',undefined);wx.setStorageSync('null',null);weappContainer.onMessage(m=>wx.setStorageSync('sequence',m));");
    let mut session = ContainerSession::new(config.clone()).unwrap();
    load(&mut session, pack.path());
    assert_eq!(
        ContainerSession::new(config.clone()).err().unwrap().code(),
        "ERR_STORAGE_LOCKED"
    );
    for i in 0..30 {
        session.send_message(json!(i)).unwrap();
    }
    let flushed = session.command("flushStorage", json!({})).unwrap();
    assert_eq!(flushed["pending"], true);
    let result = session.command("close", json!({})).unwrap();
    assert_eq!(result["pending"], true);
    assert_eq!(session.state().unwrap()["status"], "closing");
    until(&mut session, |s| s.closed);
    let events = session.take_events();
    assert!(events
        .iter()
        .any(|e| e["type"] == "closed" && e["ok"] == true));
    let mut restored = ContainerSession::new(config).unwrap();
    let read = copied_pack("this.setData({count:wx.getStorageSync('sequence')});");
    load(&mut restored, read.path());
    assert_eq!(data(&restored)["count"], 29);
    let state = restored.active.as_ref().unwrap().session.storage_snapshot();
    assert!(state.undefined_keys.contains("undefined"));
    assert!(!state.undefined_keys.contains("null"));
    assert_eq!(state.values["null"], Value::Null);
    restored.close().unwrap();
}

#[test]
fn corrupt_pack_and_escaping_blob_are_rejected_before_execution() {
    let pack = copied_pack("");
    let manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    let module = &manifest.modules[0];
    fs::write(
        pack.path().join("blobs/sha256").join(&module.sha256),
        b"tampered",
    )
    .unwrap();
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    assert_eq!(
        session
            .load(
                PackSource::Directory(pack.path().into()),
                LoadOptions::default()
            )
            .unwrap_err()
            .code(),
        "ERR_INVALID_MANIFEST"
    );
    assert_eq!(session.state().unwrap()["status"], "empty");
    #[cfg(unix)]
    {
        let pack = copied_pack("");
        let manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
        let module = &manifest.modules[0];
        let path = pack.path().join("blobs/sha256").join(&module.sha256);
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), fs::read(&path).unwrap()).unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(outside.path(), path).unwrap();
        assert!(session
            .load(
                PackSource::Directory(pack.path().into()),
                LoadOptions::default()
            )
            .is_err());
    }
}

fn http_server(response: &'static [u8], delay: Duration) -> (String, thread::JoinHandle<String>) {
    http_server_with_gate(response, delay, None)
}
fn http_server_with_gate(
    response: &'static [u8],
    delay: Duration,
    gate: Option<std::sync::mpsc::Receiver<()>>,
) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let task = thread::spawn(move || {
        let started = Instant::now();
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if started.elapsed() > Duration::from_secs(3) {
                        return String::new();
                    }
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("test listener: {e}"),
            }
        };
        // Accepted sockets inherit O_NONBLOCK on macOS. The accept loop is
        // nonblocking only to bound shutdown; request reads must wait for data.
        // A read timeout does not change the socket's blocking mode.
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut chunk = [0; 1024];
        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let size = match stream.read(&mut chunk) {
                Ok(0) => panic!("test client closed before completing HTTP request headers"),
                Ok(size) => size,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) => panic!("test request headers: {error}"),
            };
            request.extend_from_slice(&chunk[..size]);
            assert!(request.len() <= 8192, "test request headers exceed 8 KiB");
        }
        if let Some(gate) = gate {
            gate.recv_timeout(Duration::from_secs(3))
                .expect("SDK load blocked awaiting the response it must schedule asynchronously");
        }
        thread::sleep(delay);
        let _ = stream.write_all(response);
        String::from_utf8_lossy(&request).into_owned()
    });
    (format!("http://{address}/test"), task)
}

#[test]
fn http_test_server_waits_for_delayed_and_fragmented_headers() {
    const RESPONSE: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    let (url, server) = http_server(RESPONSE, Duration::ZERO);
    let url = reqwest::Url::parse(&url).unwrap();
    let mut client = TcpStream::connect((url.host_str().unwrap(), url.port().unwrap())).unwrap();
    client
        .set_read_timeout(Some(Duration::from_millis(100)))
        .unwrap();
    let expect_waiting_for_headers = |client: &mut TcpStream| {
        let mut byte = [0];
        match client.read(&mut byte) {
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            result => {
                panic!("test server responded or disconnected before complete headers: {result:?}")
            }
        }
    };
    // Delaying the first byte exposes inherited nonblocking accepted sockets.
    expect_waiting_for_headers(&mut client);
    let first = b"GET /test?q=hello+world HTTP/1.1\r\n";
    client.write_all(first).unwrap();
    expect_waiting_for_headers(&mut client);
    let second = b"Host: localhost\r\n";
    client.write_all(second).unwrap();
    expect_waiting_for_headers(&mut client);
    client.write_all(b"\r\n").unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert_eq!(response, RESPONSE);
    assert_eq!(
        server.join().unwrap().as_bytes(),
        [first.as_slice(), second.as_slice(), b"\r\n"].concat()
    );
}

#[test]
fn http_json_completes_while_hidden_without_blocking_runtime() {
    let (release, gate) = std::sync::mpsc::channel();
    let(url,server)=http_server_with_gate(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"value\":42}",Duration::ZERO,Some(gate));
    let pack=copied_pack(&format!("wx.request({{url:{},data:{{q:'hello world'}},success:r=>this.setData({{count:r.data.value}})}});setTimeout(()=>this.setData({{message:'timer'}}),5);",json!(url)));
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, pack.path());
    assert_eq!(data(&session)["count"], 0);
    session.set_foreground(false).unwrap();
    release.send(()).unwrap();
    until(&mut session, |s| data(s)["count"] == 42);
    assert_eq!(data(&session)["message"], "sdk");
    session.set_foreground(true).unwrap();
    until(&mut session, |s| data(s)["message"] == "timer");
    assert!(server.join().unwrap().contains("q=hello+world"));
}

#[test]
fn http_async_close_drains_queued_cancelled_requests_before_releasing_storage() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/must-not-send", listener.local_addr().unwrap());
    let pack = copied_pack(&format!("weappContainer.onMessage(()=>wx.request({{url:{},success:()=>this.setData({{count:99}})}}));", json!(url)));
    let directory = tempfile::tempdir().unwrap();
    let config = ContainerConfig {
        storage_root: Some(directory.path().into()),
        storage_key: Some("queued-network-owner".into()),
        ..Default::default()
    };
    let mut sdk = ContainerSession::new(config.clone()).unwrap();
    load(&mut sdk, pack.path());
    let (release, gate) = std::sync::mpsc::channel();
    sdk.http
        .as_ref()
        .unwrap()
        .hold_dispatch(gate)
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    sdk.send_message(json!("queue-request")).unwrap();
    assert_eq!(sdk.http_calls.len(), 1);
    assert_eq!(sdk.begin_close().unwrap()["pending"], true);
    sdk.pump(clock_now_ns()).unwrap();
    assert!(!sdk.closed);
    assert!(!sdk.storage.as_ref().unwrap().is_closing());
    assert_eq!(
        ContainerSession::new(config.clone()).err().unwrap().code(),
        "ERR_STORAGE_LOCKED"
    );
    release.send(()).unwrap();
    until(&mut sdk, |sdk| sdk.closed);
    assert!(
        matches!(listener.accept(), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock),
        "revoked queued request must never reach the TCP server"
    );
    let mut next = ContainerSession::new(config).unwrap();
    next.close().unwrap();
}

#[test]
fn http_account_cleanup_waits_for_executor_exit_and_discards_a_late_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/alice", listener.local_addr().unwrap());
    let (arrived, request_arrived) = std::sync::mpsc::channel();
    let (late, late_response) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut bytes = Vec::new();
        while !bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            let mut part = [0; 1024];
            let length = stream.read(&mut part).unwrap();
            assert_ne!(length, 0);
            bytes.extend_from_slice(&part[..length]);
        }
        arrived.send(()).unwrap();
        late_response.recv_timeout(Duration::from_secs(3)).unwrap();
        let _ = stream.write_all(
            b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{\"value\":99}",
        );
    });
    let pack = copied_pack(&format!(
        "wx.request({{url:{},success:r=>this.setData({{count:r.data.value}})}});",
        json!(url)
    ));
    let directory = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        storage_root: Some(directory.path().into()),
        storage_key: Some("network-account".into()),
        managed_files_root: Some(directory.path().into()),
        host_services: Some(trusted_services(
            pack.path(),
            &directory.path().display().to_string(),
            "network",
        )),
        ..Default::default()
    })
    .unwrap();
    sdk.command("managedFileScope", json!({})).unwrap();
    load(&mut sdk, pack.path());
    request_arrived
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let (release, gate) = std::sync::mpsc::channel();
    sdk.http
        .as_ref()
        .unwrap()
        .hold_worker(gate)
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let manager = sdk.account_manager().unwrap();
    let operation = manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    sdk.pump(clock_now_ns()).unwrap();
    sdk.acknowledge_account_cleanup(&operation).unwrap();
    assert_eq!(
        sdk.account_switch_status(None).unwrap().unwrap().phase,
        AccountSwitchPhase::StoppingResources
    );
    assert!(!sdk.storage.as_ref().unwrap().is_closing());
    assert!(sdk.managed_file_scope.is_some());
    assert_eq!(
        manager.delete_principal_data("alice").unwrap_err().code(),
        "ERR_STORAGE_LOCKED"
    );
    late.send(()).unwrap();
    server.join().unwrap();
    sdk.pump(clock_now_ns()).unwrap();
    assert_eq!(
        sdk.account_switch_status(None).unwrap().unwrap().phase,
        AccountSwitchPhase::StoppingResources
    );
    release.send(()).unwrap();
    finish_account_switch(&mut sdk);
    assert_eq!(
        data(&sdk)["count"],
        0,
        "late Alice response cannot mutate Bob's runtime"
    );
    manager.delete_principal_data("alice").unwrap();
    sdk.close().unwrap();
}

#[test]
fn http_owner_drop_retains_account_leases_until_the_worker_exits() {
    let pack = copied_pack("");
    let directory = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        managed_files_root: Some(directory.path().into()),
        host_services: Some(trusted_services(
            pack.path(),
            &directory.path().display().to_string(),
            "drop-network",
        )),
        ..Default::default()
    })
    .unwrap();
    sdk.command("managedFileScope", json!({})).unwrap();
    load(&mut sdk, pack.path());
    let (release, gate) = std::sync::mpsc::channel();
    sdk.http
        .as_ref()
        .unwrap()
        .hold_worker(gate)
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    let manager = sdk.account_manager().unwrap();
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    drop(sdk);
    assert_eq!(
        manager.delete_principal_data("alice").unwrap_err().code(),
        "ERR_STORAGE_LOCKED"
    );
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match manager.delete_principal_data("alice") {
            Ok(_) => break,
            Err(error) => {
                assert_eq!(error.code(), "ERR_STORAGE_LOCKED");
                assert!(Instant::now() < deadline);
                thread::yield_now();
            }
        }
    }
}

#[test]
fn http_connection_pool_is_reused_for_credential_refresh_and_isolated_across_accounts() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!("http://{}/owner", listener.local_addr().unwrap());
    let (observed, connections) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let completed = Arc::new(AtomicUsize::new(0));
        let mut workers = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut serial = 0;
        while completed.load(Ordering::SeqCst) < 5 {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    serial += 1;
                    let connection = serial;
                    let observed = observed.clone();
                    let completed = completed.clone();
                    workers.push(thread::spawn(move || {
                        stream.set_nonblocking(false).unwrap();
                        stream.set_read_timeout(Some(Duration::from_millis(50))).unwrap();
                        let mut bytes = Vec::new();
                        while completed.load(Ordering::SeqCst) < 5 && Instant::now() < deadline {
                            let mut part = [0; 1024];
                            match stream.read(&mut part) {
                                Ok(0) => break,
                                Ok(length) => bytes.extend_from_slice(&part[..length]),
                                Err(error) if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => continue,
                                Err(error) => panic!("HTTP keepalive read: {error}"),
                            }
                            if bytes.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                                stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\nConnection: keep-alive\r\n\r\n{\"value\":42}").unwrap();
                                observed.send(connection).unwrap();
                                completed.fetch_add(1, Ordering::SeqCst);
                                bytes.clear();
                            }
                        }
                    }));
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(error) => panic!("HTTP keepalive accept: {error}"),
            }
            assert!(
                Instant::now() < deadline,
                "expected five real HTTP requests"
            );
        }
        for worker in workers {
            worker.join().unwrap();
        }
    });
    let pack = page_pack(&format!(
        "Page({{data:{{count:0,message:'sdk',componentConfig:{{label:'test'}}}},onLoad(query){{if(query.failStartup)throw new Error('candidate startup rejected');wx.request({{url:{},success:r=>this.setData({{count:r.data.value}})}})}}}});",json!(url)
    ));
    let directory = tempfile::tempdir().unwrap();
    let mut sdk = ContainerSession::new(ContainerConfig {
        host_services: Some(trusted_services(
            pack.path(),
            &directory.path().display().to_string(),
            "pool",
        )),
        ..Default::default()
    })
    .unwrap();
    load(&mut sdk, pack.path());
    until(&mut sdk, |sdk| data(sdk)["count"] == 42);
    let alice = connections.recv_timeout(Duration::from_secs(2)).unwrap();
    let manager = sdk.account_manager().unwrap();
    let generation = sdk.generation;
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("alice".into()),
                epoch: 1,
            },
            BTreeMap::new(),
        )
        .unwrap();
    sdk.pump(clock_now_ns()).unwrap();
    assert_eq!(
        sdk.generation, generation,
        "same-user credential refresh preserves runtime"
    );
    sdk.http
        .as_ref()
        .unwrap()
        .start("credential-refresh-probe".into(), json!({"url":url}), None)
        .unwrap();
    let refreshed = connections.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_eq!(alice, refreshed, "same owner retains its connection pool");
    assert!(sdk
        .load(
            PackSource::Directory(pack.path().into()),
            LoadOptions {
                options: serde_json::from_value(json!({"query":{"failStartup":true}})).unwrap(),
                ..Default::default()
            }
        )
        .is_err());
    assert_eq!(
        sdk.generation, generation,
        "failed candidate preserves accepted owner"
    );
    sdk.http
        .as_ref()
        .unwrap()
        .start("rollback-probe".into(), json!({"url":url}), None)
        .unwrap();
    assert_eq!(
        alice,
        connections.recv_timeout(Duration::from_secs(2)).unwrap(),
        "failed startup preserves old pool"
    );
    load(&mut sdk, pack.path());
    until(&mut sdk, |sdk| data(sdk)["count"] == 42);
    let replacement = connections.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_ne!(
        alice, replacement,
        "accepted runtime replacement receives a new pool even within one account"
    );
    manager
        .switch_account(
            HostAccount {
                principal_id: Some("bob".into()),
                epoch: 2,
            },
            BTreeMap::new(),
        )
        .unwrap();
    finish_account_switch(&mut sdk);
    until(&mut sdk, |sdk| data(sdk)["count"] == 42);
    let bob = connections.recv_timeout(Duration::from_secs(2)).unwrap();
    assert_ne!(alice, bob, "new account must use a new TCP connection");
    assert_ne!(
        replacement, bob,
        "new account cannot reuse the preceding runtime's pool"
    );
    sdk.close().unwrap();
    server.join().unwrap();
}

#[test]
fn foreground_resume_rebuilds_retired_layout_without_guest_data_changes() {
    let pack = copied_pack("");
    let mut session = ContainerSession::new(ContainerConfig {
        host: observed_test_host(382, 578),
        ..Default::default()
    })
    .unwrap();
    load(&mut session, pack.path());
    session
        .attach_surface("lifecycle-contract-surface")
        .unwrap();
    let acknowledge = |session: &mut ContainerSession, stamp: &Value| {
        session.command(
            "presented",
            json!({"generation":stamp["generation"],"revision":stamp["frameRevision"]}),
        )
    };
    let mut previous = session.state().unwrap();
    acknowledge(&mut session, &previous).unwrap();
    let template_revision = session.active.as_ref().unwrap().session.view().revision;
    let page = previous["page"].clone();
    for _ in 0..2 {
        session.set_foreground(false).unwrap();
        assert_eq!(session.state().unwrap()["inputEnabled"], false);
        assert_eq!(
            acknowledge(&mut session, &previous).unwrap_err().code(),
            "ERR_CANCELLED"
        );
        session.set_foreground(true).unwrap();
        let resumed = session.state().unwrap();
        assert_eq!(resumed["page"], page);
        assert_eq!(
            session.active.as_ref().unwrap().session.view().revision,
            template_revision
        );
        assert!(
            resumed["frameRevision"].as_u64().unwrap()
                > previous["frameRevision"].as_u64().unwrap(),
            "an unchanged template still needs a frame for its new input lifetime"
        );
        assert_eq!(
            acknowledge(&mut session, &previous).unwrap_err().code(),
            "ERR_CANCELLED"
        );
        if resumed["presentationRequired"] == true {
            assert_eq!(resumed["inputEnabled"], false);
        }
        acknowledge(&mut session, &resumed).unwrap();
        assert_eq!(session.state().unwrap()["inputEnabled"], true);
        acknowledge(&mut session, &resumed).unwrap();
        previous = resumed;
    }
    session.resize(466, 644).unwrap();
    let intermediate = session.state().unwrap();
    session.resize(382, 578).unwrap();
    let returned = session.state().unwrap();
    assert_eq!(returned["viewport"], previous["viewport"]);
    assert!(
        returned["frameRevision"].as_u64().unwrap()
            > intermediate["frameRevision"].as_u64().unwrap()
    );
    for obsolete in [&previous, &intermediate] {
        assert_eq!(
            acknowledge(&mut session, obsolete).unwrap_err().code(),
            "ERR_CANCELLED"
        );
    }
    acknowledge(&mut session, &returned).unwrap();
    assert_eq!(session.state().unwrap()["inputEnabled"], true);
    session
        .detach_surface("lifecycle-contract-surface")
        .unwrap();
    session.close().unwrap();
    // Trusted-host receipt semantics only; real Metal completion is verified
    // by the independent UIKit consumer on a simulator or device.
}

#[cfg(any(
    feature = "skia-gpu-gles",
    all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    )
))]
#[test]
fn gpu_presenter_receipts_do_not_acknowledge_ready_mutations_or_recreated_surfaces() {
    let pack = page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'}},onReady(){this.setData({count:1});}});");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, pack.path());
    assert_eq!(data(&session)["count"], 0);
    assert_eq!(session.state().unwrap()["inputEnabled"], false);
    session.attach_surface("first").unwrap();
    let first = session.state().unwrap();
    let acknowledge = |session: &mut ContainerSession, stamp: &Value| {
        session.command(
            "presented",
            json!({"generation":stamp["generation"],"revision":stamp["frameRevision"]}),
        )
    };
    acknowledge(&mut session, &first).unwrap();
    assert_eq!(data(&session)["count"], 1);
    let ready = session.state().unwrap();
    assert!(ready["frameRevision"].as_u64().unwrap() > first["frameRevision"].as_u64().unwrap());
    assert_eq!(ready["inputEnabled"], false);
    assert_eq!(
        acknowledge(&mut session, &first).unwrap_err().code(),
        "ERR_CANCELLED"
    );
    acknowledge(&mut session, &ready).unwrap();
    assert_eq!(session.state().unwrap()["inputEnabled"], true);
    let accepted = session.active.as_ref().unwrap().session.render_revision();
    let (_, snapshot) = session.frame_snapshot().unwrap().unwrap();
    assert!(snapshot.width > 0 && snapshot.height > 0);
    assert_eq!(
        session.active.as_ref().unwrap().session.render_revision(),
        accepted
    );
    assert_eq!(session.state().unwrap()["inputEnabled"], true);
    // A diagnostic screenshot must not retire the scene, its geometry or ACK.
    assert!(session
        .active
        .as_ref()
        .unwrap()
        .session
        .has_current_skia_scene());
    session.detach_surface("first").unwrap();
    assert_eq!(session.state().unwrap()["inputEnabled"], false);
    session.attach_surface("second").unwrap();
    let second = session.state().unwrap();
    assert!(second["frameRevision"].as_u64().unwrap() > ready["frameRevision"].as_u64().unwrap());
    assert_eq!(
        acknowledge(&mut session, &ready).unwrap_err().code(),
        "ERR_CANCELLED"
    );
    assert_eq!(session.state().unwrap()["inputEnabled"], false);
    acknowledge(&mut session, &second).unwrap();
    assert_eq!(session.state().unwrap()["inputEnabled"], true);
    session.detach_surface("second").unwrap();
    session.close().unwrap();
    // This tests trusted receipt semantics; it is not real GPU/device evidence.
}

#[test]
fn keyboard_uses_accepted_root_and_resize_hook_error_keeps_committed_metrics() {
    let pack=page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'}},onResize(){this.setData({count:wx.getWindowInfo().windowWidth});throw new Error('resize hook');}});");
    let mut session = ContainerSession::new(ContainerConfig {
        host: observed_test_host(375, 667),
        ..Default::default()
    })
    .unwrap();
    load(&mut session, pack.path());
    if session.state().unwrap()["presentationRequired"] == true {
        assert_eq!(
            session
                .input(vec![json!({"type":"keydown","key":"a"})])
                .unwrap_err()
                .code(),
            "ERR_CANCELLED"
        );
        session.attach_surface("headless-contract-surface").unwrap();
        let stamp = session.state().unwrap();
        assert_eq!(
            session
                .acknowledge_presented(
                    stamp["generation"].as_u64().unwrap() + 1,
                    stamp["frameRevision"].as_u64().unwrap()
                )
                .unwrap_err()
                .code(),
            "ERR_CANCELLED"
        );
        session
            .acknowledge_presented(
                stamp["generation"].as_u64().unwrap(),
                stamp["frameRevision"].as_u64().unwrap(),
            )
            .unwrap();
        assert_eq!(session.state().unwrap()["inputEnabled"], true);
        // This is an API/ownership contract assertion with a trusted test host,
        // not a claim that a real GPU or window presented this fixture.
    }
    let before = session.active.as_ref().unwrap().session.view().event_count;
    session
        .input(vec![
            json!({"type":"keydown","key":"a","code":"KeyA"}),
            json!({"type":"keyup","key":"a","code":"KeyA"}),
        ])
        .unwrap();
    assert_eq!(
        session.active.as_ref().unwrap().session.view().event_count,
        before + 2
    );
    assert!(session.resize(240, 320).is_err());
    assert_eq!(
        session.state().unwrap()["viewport"],
        json!({"width":240,"height":320})
    );
    assert_eq!(data(&session)["count"], 240);
    assert_eq!(session.frame().unwrap().unwrap().viewport.width, 240.0);
    let metrics:HostWindowMetrics=serde_json::from_value(json!({"windowWidth":260,"windowHeight":340,"pixelRatio":2,"screenWidth":390,"screenHeight":844,"statusBarHeight":24,"screenTop":0,"deviceOrientation":"portrait"})).unwrap();
    assert!(session.update_window_metrics(metrics).is_err());
    assert_eq!(session.state().unwrap()["viewport"]["width"], 260);
    assert_eq!(data(&session)["count"], 260);
    {
        let (_, snapshot) = session.frame_snapshot().unwrap().unwrap();
        assert_eq!((snapshot.width, snapshot.height), (520, 680));
    }
    if session.surface.is_some() {
        session.detach_surface("headless-contract-surface").unwrap();
        assert_eq!(session.state().unwrap()["inputEnabled"], false);
    }
}

#[test]
fn http_binary_and_timeout_settle_once() {
    let (url, server) = http_server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\n\x00\x7f\xff",
        Duration::ZERO,
    );
    let pack=copied_pack(&format!("wx.request({{url:{},responseType:'arraybuffer',success:r=>this.setData({{count:new Uint8Array(r.data)[2]}})}});",json!(url)));
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, pack.path());
    until(&mut session, |s| data(s)["count"] == 255);
    server.join().unwrap();
    let (url, server) = http_server(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
        Duration::from_millis(750),
    );
    let pack=copied_pack(&format!("wx.request({{url:{},timeout:500,fail:e=>this.setData({{count:this.data.count+1,message:e.code}})}});",json!(url)));
    load(&mut session, pack.path());
    until(&mut session, |s| data(s)["count"] == 1);
    assert_eq!(data(&session)["message"], "ERR_TIMEOUT");
    server.join().unwrap();
    session.pump(clock_now_ns()).unwrap();
    assert_eq!(data(&session)["count"], 1);
}

#[test]
fn native_and_javascript_navigation_emit_committed_stack_events() {
    let pack=copied_pack("weappContainer.onMessage(m=>{if(m==='next')wx.navigateTo({url:'/pages/home/index?source=js'});});");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, pack.path());
    session.take_events();
    session.send_message(json!("next")).unwrap();
    let events = session.take_events();
    let event = events.iter().find(|e| e["type"] == "navigation").unwrap();
    assert_eq!(event["stack"].as_array().unwrap().len(), 2);
    session.back().unwrap();
    let events = session.take_events();
    assert!(events
        .iter()
        .any(|e| e["type"] == "navigation" && e["stack"].as_array().unwrap().len() == 1));
    let capabilities = session.command("capabilities", json!({})).unwrap();
    assert_eq!(capabilities["build"]["quickjs"], true);
    assert_eq!(capabilities["http"]["uploadFile"], false);
}

#[test]
fn close_cancels_delivered_business_calls_and_rejects_late_messages() {
    let pack = copied_pack(
        "weappContainer.invoke('echo',{}).catch(()=>wx.setStorageSync('cancelled',true));",
    );
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    session.register_host_method("echo").unwrap();
    load(&mut session, pack.path());
    let events = session.take_events();
    let call = events.iter().find(|e| e["type"] == "hostCall").unwrap()["callId"]
        .as_str()
        .unwrap()
        .to_owned();
    session.command("close", json!({})).unwrap();
    until(&mut session, |session| session.closed);
    assert!(session
        .take_events()
        .iter()
        .any(|e| e["type"] == "hostCallCancelled" && e["callId"] == call));
    assert_eq!(
        session.send_message(json!({})).unwrap_err().code(),
        "ERR_CLOSED"
    );
    assert_eq!(
        session
            .complete_host_call(&call, Ok(Value::Null))
            .unwrap_err()
            .code(),
        "ERR_CLOSED"
    );
}

#[test]
fn failed_storage_write_is_observable_before_close() {
    let directory = tempfile::tempdir().unwrap();
    let config = ContainerConfig {
        storage_root: Some(directory.path().into()),
        storage_key: Some("broken".into()),
        ..ContainerConfig::default()
    };
    let mut session = ContainerSession::new(config).unwrap();
    let pack = copied_pack("wx.setStorageSync('x',1);");
    // A directory at the atomic destination prevents replacement on all OSes.
    fs::create_dir(
        directory
            .path()
            .join(format!("{}.json", hex_digest(b"broken"))),
    )
    .unwrap();
    load(&mut session, pack.path());
    let start = Instant::now();
    loop {
        session.pump(clock_now_ns()).unwrap();
        if session
            .take_events()
            .iter()
            .any(|e| e["type"] == "error" && e["error"]["code"] == "ERR_STORAGE")
        {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(3));
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(session.close().unwrap_err().code(), "ERR_STORAGE");
    assert!(session.closed);
}

/// Author a real new content-addressed WXML blob while keeping its component
/// topology and execution inputs unchanged.
fn presentation_edit(source: &Path) -> tempfile::TempDir {
    fn edit(nodes: &mut [Value]) -> bool {
        for node in nodes {
            if node["kind"] == "text" {
                let previous = node["value"].as_str().unwrap_or("");
                node["value"] = json!(format!("Updated {previous}"));
                return true;
            }
            if let Some(children) = node.get_mut("children").and_then(Value::as_array_mut) {
                if edit(children) {
                    return true;
                }
            }
        }
        false
    }
    let directory = tempfile::tempdir().unwrap();
    fs::create_dir_all(directory.path().join("blobs/sha256")).unwrap();
    for file in fs::read_dir(source.join("blobs/sha256")).unwrap() {
        let file = file.unwrap();
        fs::copy(
            file.path(),
            directory.path().join("blobs/sha256").join(file.file_name()),
        )
        .unwrap();
    }
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(source.join("manifest.json")).unwrap()).unwrap();
    let template = manifest
        .templates
        .iter_mut()
        .find(|t| t.id == "template:pages/home/index.wxml")
        .unwrap();
    let hash = template.wxml_ast.strip_prefix("sha256:").unwrap();
    let mut ast: Value =
        serde_json::from_slice(&fs::read(source.join("blobs/sha256").join(hash)).unwrap()).unwrap();
    assert!(edit(ast["nodes"].as_array_mut().unwrap()));
    let bytes = serde_json::to_vec(&ast).unwrap();
    let hash = hex_digest(&bytes);
    fs::write(directory.path().join("blobs/sha256").join(&hash), bytes).unwrap();
    template.wxml_ast = format!("sha256:{hash}");
    manifest.refresh_integrity().unwrap();
    fs::write(
        directory.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    directory
}

#[test]
fn dev_presentation_reload_preserves_heap_pages_timers_storage_and_surface() {
    let original = copied_pack("wx.setStorageSync('launches',(wx.getStorageSync('launches')||0)+1);weappContainer.onMessage(()=>this.setData({count:9}));setTimeout(()=>this.setData({message:'timer-fired'}),100);");
    let edited = presentation_edit(original.path());
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, original.path());
    session.send_message(json!("change")).unwrap();
    session.attach_surface("preview").unwrap();
    let before = session.state().unwrap();
    session.take_events();
    let result = session
        .apply_dev_pack(
            PackSource::Directory(edited.path().into()),
            LoadOptions::default(),
        )
        .unwrap();
    assert_eq!(result.reload_kind, DevReloadKind::InPlace);
    assert_eq!(result.state["sessionId"], before["sessionId"]);
    assert_eq!(result.state["generation"], before["generation"]);
    assert_eq!(result.state["page"], before["page"]);
    assert_eq!(result.state["surface"], "preview");
    assert_eq!(data(&session)["count"], 9);
    assert_eq!(
        session
            .active
            .as_ref()
            .unwrap()
            .session
            .storage_snapshot()
            .values["launches"],
        1
    );
    assert!(session
        .take_events()
        .iter()
        .any(|event| event["type"] == "devReload" && event["reloadKind"] == "inPlace"));
    until(&mut session, |s| data(s)["message"] == "timer-fired");
    session.detach_surface("preview").unwrap();
    session.close().unwrap();
}

fn stateful_view_pack() -> tempfile::TempDir {
    stateful_view_pack_with_page("Page({data:{ticks:0},onLoad(){setInterval(()=>this.setData({ticks:this.data.ticks+1}),10)}});")
}

fn stateful_view_pack_with_page(source: &str) -> tempfile::TempDir {
    let directory = page_pack(source);
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(directory.path().join("manifest.json")).unwrap()).unwrap();
    let source =
        "var count=0;exports.next=function(ticks){count+=1;return 'run:'+count+':tick:'+ticks;};";
    let hash = hex_digest(source.as_bytes());
    fs::write(directory.path().join("blobs/sha256").join(&hash), source).unwrap();
    manifest.view_scripts.push(container_ir::ViewScriptModule {
        id: "wxs:shared/counter.wxs".into(),
        sha256: hash,
        dependencies: Vec::new(),
    });
    let bytes = container_ir::parse_wxml(
        "<wxs module=\"counter\" src=\"../../shared/counter.wxs\"/><text>{{counter.next(ticks)}}</text>",
    )
    .unwrap()
    .canonical_json()
    .unwrap();
    let hash = hex_digest(&bytes);
    fs::write(directory.path().join("blobs/sha256").join(&hash), bytes).unwrap();
    let template = manifest
        .templates
        .iter_mut()
        .find(|template| template.id == "template:pages/home/index.wxml")
        .unwrap();
    template.wxml_ast = format!("sha256:{hash}");
    template.wxs_modules = BTreeMap::from([("counter".into(), "wxs:shared/counter.wxs".into())]);
    manifest.refresh_integrity().unwrap();
    fs::write(
        directory.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    directory
}

fn evaluated_text(session: &ContainerSession) -> String {
    fn collect(nodes: &[container_ir::ViewNode], text: &mut String) {
        for node in nodes {
            match node {
                container_ir::ViewNode::Text { value, .. } => text.push_str(value),
                container_ir::ViewNode::Element { children, .. } => collect(children, text),
            }
        }
    }
    let mut text = String::new();
    collect(
        &session
            .active
            .as_ref()
            .unwrap()
            .session
            .view_document()
            .unwrap()
            .nodes,
        &mut text,
    );
    text
}

#[test]
fn dev_replacement_preserves_stateful_view_and_frame_ack_across_idle_pumps() {
    let original = stateful_view_pack_with_page("Page({data:{ticks:0},onLoad(){weappContainer.onMessage(()=>this.setData({ticks:this.data.ticks+1}))}});");
    let edited = tempfile::tempdir().unwrap();
    fs::create_dir_all(edited.path().join("blobs/sha256")).unwrap();
    for file in fs::read_dir(original.path().join("blobs/sha256")).unwrap() {
        let file = file.unwrap();
        fs::copy(
            file.path(),
            edited.path().join("blobs/sha256").join(file.file_name()),
        )
        .unwrap();
    }
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(original.path().join("manifest.json")).unwrap()).unwrap();
    // Keep executable View inputs exact while publishing a real new style.
    let styles = container_ir::parse_wxss("text { color: #123456; }")
        .unwrap()
        .canonical_json()
        .unwrap();
    let hash = hex_digest(&styles);
    fs::write(edited.path().join("blobs/sha256").join(&hash), styles).unwrap();
    manifest.styles[0].wxss_ir = format!("sha256:{hash}");
    manifest.refresh_integrity().unwrap();
    fs::write(
        edited.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();

    // Exercise both bookkeeping entry points as the first operation following
    // replacement. The fixture has no timer or other source of data changes.
    for acknowledge_first in [false, true] {
        let mut sdk = ContainerSession::new(ContainerConfig {
            gpu_required: Some(false),
            ..ContainerConfig::default()
        })
        .unwrap();
        load(&mut sdk, original.path());
        sdk.attach_surface("dev-replacement-contract").unwrap();
        let before = sdk.state().unwrap();
        let input_lifetime = sdk
            .active
            .as_ref()
            .unwrap()
            .session
            .input_lifetime_revision();
        let result = sdk
            .apply_dev_pack(
                PackSource::Directory(edited.path().into()),
                LoadOptions::default(),
            )
            .unwrap();
        assert_eq!(result.reload_kind, DevReloadKind::InPlace);
        assert_eq!(result.state["sessionId"], before["sessionId"]);
        assert_eq!(result.state["generation"], before["generation"]);
        assert_eq!(result.state["page"], before["page"]);
        assert_ne!(
            sdk.active
                .as_ref()
                .unwrap()
                .session
                .input_lifetime_revision(),
            input_lifetime
        );
        assert!(
            result.state["frameRevision"].as_u64().unwrap()
                > before["frameRevision"].as_u64().unwrap()
        );
        assert_eq!(evaluated_text(&sdk), "run:1:tick:0");
        let revision = result.state["frameRevision"].as_u64().unwrap();
        let generation = result.state["generation"].as_u64().unwrap();
        sdk.take_events();
        if acknowledge_first {
            sdk.acknowledge_presented(generation, revision).unwrap();
        }
        for _ in 0..3 {
            sdk.pump(clock_now_ns()).unwrap();
            sdk.acknowledge_presented(generation, revision).unwrap();
            assert_eq!(sdk.state().unwrap()["frameRevision"], revision);
            assert_eq!(evaluated_text(&sdk), "run:1:tick:0");
        }
        assert!(!sdk
            .take_events()
            .iter()
            .any(|event| event["type"] == "frame"));

        sdk.send_message(json!("update")).unwrap();
        assert_eq!(data(&sdk)["ticks"], 1);
        assert_eq!(evaluated_text(&sdk), "run:2:tick:1");
        let changed = sdk.state().unwrap();
        assert!(changed["frameRevision"].as_u64().unwrap() > revision);
        assert_eq!(
            sdk.acknowledge_presented(generation, revision)
                .unwrap_err()
                .code(),
            "ERR_CANCELLED"
        );
        sdk.acknowledge_presented(generation, changed["frameRevision"].as_u64().unwrap())
            .unwrap();
        sdk.pump(clock_now_ns()).unwrap();
        assert_eq!(
            sdk.state().unwrap()["frameRevision"],
            changed["frameRevision"]
        );
        assert_eq!(evaluated_text(&sdk), "run:2:tick:1");
        sdk.detach_surface("dev-replacement-contract").unwrap();
        sdk.close().unwrap();
    }
}

#[test]
fn timer_render_reuses_verified_documents_without_caching_stateful_wxs_results() {
    let pack = stateful_view_pack();
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    let identity = sdk.accepted_pack_identity().unwrap();
    let mut previous_run = 0;
    for _ in 0..8 {
        let ticks = data(&sdk)["ticks"].as_u64().unwrap();
        until(&mut sdk, |session| {
            data(session)["ticks"].as_u64().unwrap() > ticks
        });
        let text = evaluated_text(&sdk);
        let parts = text.split(':').collect::<Vec<_>>();
        assert_eq!(parts[0], "run");
        let current_run = parts[1].parse::<u64>().unwrap();
        assert!(
            current_run > previous_run,
            "the stateful WXS call must run for new page data"
        );
        previous_run = current_run;
        assert_eq!(parts[2], "tick");
        assert_eq!(parts[3].parse::<u64>().unwrap(), data(&sdk)["ticks"]);
        let metrics = sdk.state().unwrap()["viewExecutionMetrics"].clone();
        assert_eq!(metrics["preparation"]["cacheHit"], true);
        assert_eq!(metrics["frontier"]["documentCacheHit"], true);
        assert_eq!(metrics["frontier"]["succeeded"], true);
        assert_eq!(sdk.accepted_pack_identity().unwrap(), identity);
    }
    sdk.close().unwrap();
}

#[test]
fn in_place_resources_are_reauthorized_then_reused_by_later_timer_renders() {
    let original = copied_pack(
        "this.setData({ticks:0});setInterval(()=>this.setData({ticks:this.data.ticks+1}),10);",
    );
    let edited = presentation_edit(original.path());
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, original.path());
    let before = sdk.accepted_pack_identity().unwrap().unwrap();
    assert!(sdk
        .active
        .as_ref()
        .unwrap()
        .session
        .can_reuse_render_resources());
    let result = sdk
        .apply_dev_pack(
            PackSource::Directory(edited.path().into()),
            LoadOptions::default(),
        )
        .unwrap();
    assert_eq!(result.reload_kind, DevReloadKind::InPlace);
    let after = sdk.accepted_pack_identity().unwrap().unwrap();
    assert_eq!(before.session_id, after.session_id);
    assert_ne!(before.root, after.root);
    assert!(evaluated_text(&sdk).contains("Updated "));
    for _ in 0..3 {
        let ticks = data(&sdk)["ticks"].as_u64().unwrap();
        until(&mut sdk, |session| {
            data(session)["ticks"].as_u64().unwrap() > ticks
        });
    }
    let metrics = sdk.state().unwrap()["viewExecutionMetrics"].clone();
    assert_eq!(metrics["preparation"]["cacheHit"], true);
    assert_eq!(metrics["frontier"]["documentCacheHit"], true);
    assert!(sdk
        .active
        .as_ref()
        .unwrap()
        .session
        .can_reuse_render_resources());
    sdk.close().unwrap();
}

#[test]
fn failed_replacement_cannot_borrow_retained_resources_and_rollback_revalidates_old_pack() {
    let original = copied_pack("this.setData({count:7});");
    let edited = presentation_edit(original.path());
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, original.path());
    let accepted_frame = sdk.frame().unwrap().unwrap().clone();
    let active = sdk.active.as_mut().unwrap();
    let old_manifest = active.pack.manifest.clone();
    // Exercise the actual post-replacement failure/rollback boundary, after
    // a candidate pack was read but before its frame can be accepted.
    let mut replacement =
        pack::VerifiedPack::load(PackSource::Directory(edited.path().into())).unwrap();
    let pointer = replacement.manifest.templates[0].wxml_ast.clone();
    replacement
        .blobs
        .insert(pointer, b"damaged-after-read".to_vec());
    active
        .session
        .replace_manifest(replacement.manifest.clone())
        .unwrap();
    assert!(!active.session.can_reuse_render_resources());
    let old_pack = std::mem::replace(&mut active.pack, replacement);
    assert!(
        active.render(true).is_err(),
        "new manifest must verify new blobs instead of using the retained old frame lease"
    );
    assert!(!active.session.can_reuse_render_resources());
    active.pack = old_pack;
    active.session.replace_manifest(old_manifest).unwrap();
    assert!(
        !active.session.can_reuse_render_resources(),
        "returning to an old manifest cannot reactivate a retained lease"
    );
    assert_eq!(
        active.session.renderer().last_frame(),
        Some(&accepted_frame)
    );
    active.render(true).unwrap();
    assert!(active.session.can_reuse_render_resources());
    assert!(!evaluated_text(&sdk).contains("Updated "));
    assert_eq!(data(&sdk)["count"], 7);
    sdk.close().unwrap();
}

#[test]
fn dev_script_restart_retires_old_session_and_requires_surface_detachment() {
    let original = copied_pack("wx.setStorageSync('persist','old');");
    let next = copied_pack("this.setData({count:42,message:wx.getStorageSync('persist')});");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, original.path());
    let before = session.state().unwrap();
    let payload = json!({"packPath":next.path()});
    assert_eq!(
        session.command("classifyDevPack", payload.clone()).unwrap()["reloadKind"],
        "restart"
    );
    assert_eq!(
        session.state().unwrap()["sessionId"],
        before["sessionId"],
        "classification is read-only"
    );
    session.attach_surface("preview").unwrap();
    assert_eq!(
        session
            .command("applyDevPack", payload.clone())
            .unwrap_err()
            .code(),
        "ERR_SURFACE_ATTACHED"
    );
    assert_eq!(session.state().unwrap()["sessionId"], before["sessionId"]);
    session.detach_surface("preview").unwrap();
    let result = session.command("applyDevPack", payload).unwrap();
    assert_eq!(result["reloadKind"], "restart");
    assert_ne!(result["state"]["sessionId"], before["sessionId"]);
    assert_eq!(data(&session)["count"], 42);
    assert_eq!(data(&session)["message"], "old");
    session.close().unwrap();
}

#[test]
fn dev_corrupt_candidate_does_not_change_session_data_or_frame() {
    let original = copied_pack("this.setData({count:7});");
    let edited = presentation_edit(original.path());
    let manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(edited.path().join("manifest.json")).unwrap()).unwrap();
    let hash = manifest
        .templates
        .iter()
        .find(|t| t.id == "template:pages/home/index.wxml")
        .unwrap()
        .wxml_ast
        .strip_prefix("sha256:")
        .unwrap();
    fs::write(edited.path().join("blobs/sha256").join(hash), b"corrupt").unwrap();
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, original.path());
    let before = session.state().unwrap();
    assert!(session
        .apply_dev_pack(
            PackSource::Directory(edited.path().into()),
            LoadOptions::default()
        )
        .is_err());
    assert_eq!(session.state().unwrap(), before);
    assert_eq!(data(&session)["count"], 7);
    session.close().unwrap();
}

#[test]
fn explicit_gpu_requirement_rejects_missing_provider_and_false_keeps_raster() {
    let compiled = cfg!(feature = "skia-gpu-gles")
        || cfg!(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ));
    let mut required = ContainerSession::new(ContainerConfig {
        gpu_required: Some(true),
        ..ContainerConfig::default()
    })
    .unwrap();
    if !compiled {
        assert_eq!(
            required
                .load(PackSource::Directory(fixture()), LoadOptions::default())
                .unwrap_err()
                .code(),
            "ERR_UNSUPPORTED_CAPABILITY"
        );
        assert_eq!(required.state().unwrap()["status"], "empty");
    }
    required.close().unwrap();
    let mut raster = ContainerSession::new(ContainerConfig {
        gpu_required: Some(false),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut raster, &fixture());
    assert!(!raster.state().unwrap()["presentationRequired"]
        .as_bool()
        .unwrap());
    assert_eq!(
        raster.capabilities().unwrap()["pack"]["devReload"]["protocolVersion"],
        "1.0"
    );
    raster.close().unwrap();
}

#[test]
fn dev_invalid_style_preflight_retains_accepted_pack_without_live_mutation() {
    let original = copied_pack("this.setData({count:11});weappContainer.onMessage(()=>this.setData({count:this.data.count+1}));");
    let invalid = presentation_edit(original.path());
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(invalid.path().join("manifest.json")).unwrap()).unwrap();
    let bytes = b"not WXSS IR";
    let hash = hex_digest(bytes);
    fs::write(invalid.path().join("blobs/sha256").join(&hash), bytes).unwrap();
    manifest.styles[0].wxss_ir = format!("sha256:{hash}");
    manifest.refresh_integrity().unwrap();
    fs::write(
        invalid.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, original.path());
    let before = session.state().unwrap();
    let frame = session.frame().unwrap().unwrap().clone();
    let active = session.active.as_ref().unwrap();
    let input_lifetime = active.session.input_lifetime_revision();
    let consumed_input = active
        .session
        .last_frame_input_json(active.session.render_revision())
        .unwrap();
    let identity = session.accepted_pack_identity().unwrap();
    let root = session
        .active
        .as_ref()
        .unwrap()
        .pack
        .manifest
        .integrity
        .root
        .clone();
    assert_eq!(
        session
            .classify_dev_pack(PackSource::Directory(invalid.path().into()))
            .unwrap(),
        DevReloadKind::InPlace
    );
    assert!(session
        .apply_dev_pack(
            PackSource::Directory(invalid.path().into()),
            LoadOptions::default()
        )
        .is_err());
    assert_eq!(session.state().unwrap(), before);
    assert_eq!(
        session
            .active
            .as_ref()
            .unwrap()
            .pack
            .manifest
            .integrity
            .root,
        root
    );
    assert_eq!(data(&session)["count"], 11);
    let active = session.active.as_ref().unwrap();
    assert_eq!(active.session.input_lifetime_revision(), input_lifetime);
    assert_eq!(
        active
            .session
            .last_frame_input_json(active.session.render_revision())
            .unwrap(),
        consumed_input
    );
    assert!(active.session.can_reuse_render_resources());
    assert_eq!(session.frame().unwrap().unwrap(), &frame);
    assert_eq!(session.accepted_pack_identity().unwrap(), identity);
    session.send_message(json!("after-rejection")).unwrap();
    assert_eq!(data(&session)["count"], 12);
    session.close().unwrap();
}

#[test]
fn clear_development_storage_updates_the_next_real_engine_turn() {
    let pack = copied_pack("wx.setStorageSync('persist','before');weappContainer.onMessage(()=>this.setData({count:wx.getStorageInfoSync().keys.length}));");
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut session, pack.path());
    let before = session.state().unwrap()["sessionId"].clone();
    session.command("clearDevStorage", json!({})).unwrap();
    assert!(session
        .active
        .as_ref()
        .unwrap()
        .session
        .storage_snapshot()
        .values
        .is_empty());
    session.send_message(json!("read")).unwrap();
    assert_eq!(data(&session)["count"], 0);
    assert_eq!(session.state().unwrap()["sessionId"], before);
    session.close().unwrap();
}

#[test]
fn development_console_is_opt_in_bounded_and_includes_startup_without_getters() {
    let pack = copied_pack(
        r#"
        let reads = 0;
        const object = { value: 42, get secret() { reads++; throw Error('getter called'); } };
        console.log('launch-log', object);
        for (let i = 0; i < 200; i++) console.warn('line', i);
        this.setData({ count: reads });
    "#,
    );
    let mut normal = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut normal, pack.path());
    assert!(!normal.events.iter().any(|event| event["type"] == "console"));
    let mut dev = ContainerSession::new(ContainerConfig {
        dev_diagnostics: true,
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut dev, pack.path());
    assert_eq!(data(&dev)["count"], 0);
    let logs: Vec<_> = dev
        .events
        .iter()
        .filter(|event| event["type"] == "console")
        .collect();
    let startup: Vec<_> = logs
        .iter()
        .filter(|event| event["message"].as_str().unwrap().starts_with("launch-log"))
        .collect();
    assert_eq!(startup.len(), 1);
    assert!(startup[0]["message"]
        .as_str()
        .unwrap()
        .contains("[Accessor]"));
    assert_eq!(
        logs.iter()
            .filter(|event| event["message"].as_str().unwrap().starts_with("line "))
            .count(),
        127
    );
    assert!(logs
        .iter()
        .any(|event| event["message"].as_str().unwrap().contains("dropped")));
    assert!(logs
        .iter()
        .all(|event| event["message"].as_str().unwrap().len() <= 8192));
    let count = logs.len();
    dev.pump(clock_now_ns()).unwrap();
    assert_eq!(
        dev.events
            .iter()
            .filter(|event| event["type"] == "console")
            .count(),
        count
    );
}

#[test]
fn development_console_survives_navigation_and_foreground_batches_without_replay() {
    let pack = page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'}},onHide(){console.log('hide-log')},onShow(){console.log('show-log')}});");
    let mut session = ContainerSession::new(ContainerConfig {
        dev_diagnostics: true,
        gpu_required: Some(false),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut session, pack.path());
    session.take_events();
    session.set_foreground(false).unwrap();
    session.set_foreground(true).unwrap();
    let events = session.take_events();
    for text in ["hide-log", "show-log"] {
        assert_eq!(
            events
                .iter()
                .filter(|event| event["type"] == "console" && event["message"] == text)
                .count(),
            1
        );
    }
    session
        .navigate("pages/home/index", json!({}), false)
        .unwrap();
    let events = session.take_events();
    assert!(events
        .iter()
        .any(|event| event["type"] == "console" && event["message"] == "show-log"));
    session.pump(clock_now_ns()).unwrap();
    assert!(!session
        .take_events()
        .iter()
        .any(|event| event["type"] == "console"));
}

#[cfg(feature = "v8-native")]
#[test]
fn development_console_v8_uses_the_same_bounded_batch_contract() {
    let pack = copied_pack("console.log('v8-start',42);");
    let mut session = ContainerSession::new(ContainerConfig {
        engine: EngineKind::V8,
        dev_diagnostics: true,
        gpu_required: Some(false),
        ..ContainerConfig::default()
    })
    .unwrap();
    load(&mut session, pack.path());
    assert_eq!(
        session
            .take_events()
            .iter()
            .filter(|event| event["type"] == "console" && event["message"] == "v8-start 42")
            .count(),
        1
    );
    session.pump(clock_now_ns()).unwrap();
    assert!(!session
        .take_events()
        .iter()
        .any(|event| event["type"] == "console"));
}

fn rewrite_json_module(pack: &Path, path: &str, value: Value) {
    let manifest_path = pack.join("manifest.json");
    let mut manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    let bytes = serde_json::to_vec(&value).unwrap();
    let hash = hex_digest(&bytes);
    fs::write(pack.join("blobs/sha256").join(&hash), bytes).unwrap();
    manifest
        .modules
        .iter_mut()
        .find(|module| module.id == format!("module:{path}"))
        .unwrap()
        .sha256 = hash;
    manifest.refresh_integrity().unwrap();
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
}
fn geometry(revision: u64) -> Value {
    json!({"schemaVersion":1,"revision":revision,
        "contentRect":{"left":0.0,"top":76.0,"width":375.0,"height":667.0},
        "menuButtonRect":{"left":279.0,"right":367.0,"top":38.0,"bottom":70.0,"width":88.0,"height":32.0}})
}
#[test]
fn chrome_preflight_resolves_verified_module_configs_without_guest_execution() {
    let pack = copied_pack("throw new Error('preflight must not execute this');");
    rewrite_json_module(
        pack.path(),
        "app.json",
        json!({"pages":["pages/home/index"],"window":{"navigationBarTitleText":"Default","navigationBarTextStyle":"white","navigationBarBackgroundColor":"#123456"},"tabBar":{"color":"#222222","selectedColor":"#00ff00","list":[{"pagePath":"pages/home/index","text":"Home"}]}}),
    );
    rewrite_json_module(
        pack.path(),
        "pages/home/index.json",
        json!({"navigationStyle":"custom","navigationBarTitleText":"Page"}),
    );
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    let chrome = sdk
        .command("inspectPackChrome", json!({"packPath":pack.path()}))
        .unwrap();
    assert_eq!(chrome["title"], "Page");
    assert_eq!(chrome["frontColor"], "#ffffff");
    assert_eq!(chrome["backgroundColor"], "#123456");
    assert_eq!(chrome["navigationStyle"], "custom");
    assert_eq!(chrome["tabBar"]["visible"], true);
    assert_eq!(chrome["tabBar"]["selectedIndex"], 0);
    assert!(sdk.state().unwrap()["sessionId"].is_null());
    assert!(sdk.take_events().is_empty());
    let manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(pack.path().join("manifest.json")).unwrap()).unwrap();
    let hash = &manifest
        .modules
        .iter()
        .find(|module| module.id == "module:app.json")
        .unwrap()
        .sha256;
    fs::write(pack.path().join("blobs/sha256").join(hash), b"{}").unwrap();
    assert_eq!(
        sdk.command("inspectPackChrome", json!({"packPath":pack.path()}))
            .unwrap_err()
            .code(),
        "ERR_INVALID_MANIFEST"
    );
}
#[test]
fn native_chrome_observes_dynamic_title_color_and_page_instance_restore() {
    let pack = copied_pack("");
    rewrite_json_module(
        pack.path(),
        "app.json",
        json!({"pages":["pages/home/index"],"window":{"navigationBarTitleText":"Configured"}}),
    );
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    assert_eq!(sdk.state().unwrap()["chrome"]["title"], "Configured");
    let frame_before_chrome = sdk.state().unwrap()["frameRevision"].clone();
    sdk.active_mut()
        .unwrap()
        .dispatch(
            op::API_CALL,
            json!({"name":"wx.setNavigationBarTitle","title":""}),
        )
        .unwrap();
    sdk.active_mut().unwrap().dispatch(op::API_CALL, json!({"name":"wx.setNavigationBarColor","frontColor":"#ffffff","backgroundColor":"#123456"})).unwrap();
    sdk.finish_operation().unwrap();
    assert_eq!(sdk.state().unwrap()["chrome"]["title"], "");
    assert_eq!(sdk.state().unwrap()["frameRevision"], frame_before_chrome);
    assert_eq!(sdk.state().unwrap()["chrome"]["frontColor"], "#ffffff");
    sdk.navigate("pages/home/index", json!({}), false).unwrap();
    assert_eq!(sdk.state().unwrap()["chrome"]["title"], "Configured");
    assert_eq!(sdk.state().unwrap()["chrome"]["canGoBack"], true);
    sdk.back().unwrap();
    let state = sdk.state().unwrap();
    assert_eq!(state["chrome"]["title"], "");
    assert_eq!(state["chrome"]["backgroundColor"], "#123456");
    assert_eq!(state["chrome"]["canGoBack"], false);
    assert!(sdk
        .take_events()
        .iter()
        .any(|event| event["type"] == "chrome" && event["chrome"]["title"] == ""));
}
#[test]
fn host_chrome_is_available_in_onload_and_rejects_stale_or_invalid_observations() {
    let pack = copied_pack("this.setData({menu:wx.getMenuButtonBoundingClientRect()});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    sdk.command("hostChrome", geometry(1)).unwrap();
    load(&mut sdk, pack.path());
    assert_eq!(data(&sdk)["menu"]["top"], 38.0);
    let before = sdk.state().unwrap();
    sdk.command("hostChrome", geometry(1)).unwrap();
    let mut changed = geometry(1);
    changed["menuButtonRect"]["top"] = json!(39.0);
    assert!(sdk.command("hostChrome", changed).is_err());
    let mut wrong_session = geometry(2);
    wrong_session["sessionId"] = json!("retired-session");
    assert_eq!(
        sdk.command("hostChrome", wrong_session).unwrap_err().code(),
        "ERR_CANCELLED"
    );
    assert_eq!(sdk.state().unwrap()["hostChrome"], before["hostChrome"]);
    let mut latest = geometry(2);
    latest["menuButtonRect"]["left"] = json!(278.0);
    latest["menuButtonRect"]["right"] = json!(366.0);
    sdk.command("hostChrome", latest).unwrap();
    let response = sdk
        .active_mut()
        .unwrap()
        .dispatch(
            op::API_CALL,
            json!({"name":"wx.getMenuButtonBoundingClientRect"}),
        )
        .unwrap();
    assert_eq!(
        response
            .messages
            .iter()
            .find(|message| message.kind == EnvelopeKind::Response)
            .unwrap()
            .payload["result"]["left"],
        278.0
    );
}
#[test]
fn preview_occlusion_suspends_input_and_render_but_keeps_timers_and_lifecycle() {
    let pack = page_pack("Page({data:{count:0,message:'sdk',componentConfig:{label:'test'},hidden:false},onLoad(){setInterval(()=>this.setData({count:this.data.count+1}),1)},onHide(){this.setData({hidden:true})}});");
    let mut sdk = ContainerSession::new(ContainerConfig::default()).unwrap();
    load(&mut sdk, pack.path());
    let session_id = sdk.state().unwrap()["sessionId"].clone();
    let revision = sdk.state().unwrap()["frameRevision"].clone();
    sdk.command("setPreviewOccluded", json!({"occluded":true}))
        .unwrap();
    assert_eq!(sdk.input(vec![]).unwrap_err().code(), "ERR_CANCELLED");
    sdk.pump(clock_now_ns() + 10_000_000).unwrap();
    assert!(data(&sdk)["count"].as_u64().unwrap() > 0);
    assert_eq!(data(&sdk)["hidden"], false);
    assert_eq!(sdk.state().unwrap()["foreground"], true);
    assert_eq!(sdk.state().unwrap()["frameRevision"], revision);
    sdk.command("setPreviewOccluded", json!({"occluded":false}))
        .unwrap();
    assert_eq!(sdk.state().unwrap()["sessionId"], session_id);
    assert!(sdk.state().unwrap()["frameRevision"].as_u64().unwrap() > revision.as_u64().unwrap());
}

#[test]
fn restart_chrome_is_transactional_and_new_onload_precedes_native_resize() {
    let first = copied_pack("this.setData({count:7});");
    let bad = copied_pack("throw new Error('candidate startup fails');");
    let second = copied_pack("this.setData({height:wx.getWindowInfo().windowHeight,menu:wx.getMenuButtonBoundingClientRect()});");
    rewrite_json_module(
        second.path(),
        "pages/home/index.json",
        json!({"navigationStyle":"custom"}),
    );
    let mut sdk = ContainerSession::new(ContainerConfig {
        host: observed_test_host(375, 667),
        ..Default::default()
    })
    .unwrap();
    sdk.command("hostChrome", geometry(1)).unwrap();
    load(&mut sdk, first.path());
    let before = sdk.state().unwrap();
    let mut next = geometry(2);
    next["contentRect"]["top"] = json!(28.0);
    next["contentRect"]["height"] = json!(715.0);
    next["sessionId"] = before["sessionId"].clone();
    next["pageId"] = before["page"]["id"].clone();
    let options = |value: Value| LoadOptions {
        initial_host_chrome: Some(serde_json::from_value(value).unwrap()),
        ..LoadOptions::default()
    };
    assert!(sdk
        .apply_dev_pack(
            PackSource::Directory(bad.path().into()),
            options(next.clone())
        )
        .is_err());
    assert_eq!(sdk.state().unwrap()["sessionId"], before["sessionId"]);
    assert_eq!(sdk.state().unwrap()["hostChrome"], before["hostChrome"]);
    assert_eq!(sdk.state().unwrap()["viewport"], before["viewport"]);
    assert_eq!(data(&sdk)["count"], 7);
    sdk.apply_dev_pack(PackSource::Directory(second.path().into()), options(next))
        .unwrap();
    assert_eq!(data(&sdk)["height"], 715);
    assert_eq!(data(&sdk)["menu"]["top"], 38.0);
    let accepted = sdk.state().unwrap();
    assert_eq!(accepted["viewport"]["height"], 715);
    assert_eq!(accepted["chrome"]["navigationStyle"], "custom");
    assert_eq!(accepted["chromeGeometryReady"], false);
    assert_eq!(accepted["inputEnabled"], false);
    assert_eq!(accepted["hostChrome"]["sessionId"], accepted["sessionId"]);
    let metrics = |height| {
        serde_json::from_value::<HostWindowMetrics>(json!({"windowWidth":375,"windowHeight":height,"pixelRatio":2,"screenWidth":375,"screenHeight":812,"statusBarHeight":28,"screenTop":0,"deviceOrientation":"portrait"})).unwrap()
    };
    sdk.update_window_metrics(metrics(667)).unwrap();
    assert_eq!(
        sdk.state().unwrap()["viewport"]["height"],
        715,
        "old native metrics cannot resize the new candidate backward"
    );
    assert_eq!(sdk.state().unwrap()["chromeGeometryReady"], false);
    sdk.update_window_metrics(metrics(715)).unwrap();
    assert_eq!(sdk.state().unwrap()["chromeGeometryReady"], true);
    assert_eq!(sdk.state().unwrap()["viewport"]["height"], 715);
}

#[test]
fn dynamic_tab_bar_requires_explicit_presenter_configuration() {
    let default: ContainerConfig = serde_json::from_value(json!({})).unwrap();
    assert!(!default.system_tab_bar);
    assert!(serde_json::to_value(&default)
        .unwrap()
        .get("systemTabBar")
        .is_none());
    let attached: ContainerConfig = serde_json::from_value(json!({"systemTabBar":true})).unwrap();
    assert!(attached.system_tab_bar);
    assert_eq!(
        serde_json::to_value(&attached).unwrap()["systemTabBar"],
        true
    );
    assert!(serde_json::from_value::<ContainerConfig>(json!({"systemTabBar":"true"})).is_err());
}

#[test]
fn dynamic_tab_bar_sdk_admission_and_metadata_revisions_preserve_geometry() {
    let engines = [
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ];
    for engine in engines {
        let pack = copied_pack("");
        rewrite_json_module(
            pack.path(),
            "app.json",
            json!({
                "pages":["pages/home/index"],
                "tabBar":{"list":[{"pagePath":"pages/home/index","text":"Home"}]}
            }),
        );
        let manifest_path = pack.path().join("manifest.json");
        let mut manifest: ContainerManifestV1 =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        for name in container_runtime::SYSTEM_TAB_BAR_APIS.into_iter().chain([
            "wx.showTabBar",
            "wx.hideTabBar",
            "wx.setTabBarItem",
        ]) {
            manifest
                .capabilities
                .insert(name.into(), container_ir::CapabilitySupport::Full);
        }
        manifest.refresh_integrity().unwrap();
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        for presenter in [false, true] {
            let mut sdk = ContainerSession::new(ContainerConfig {
                engine,
                system_tab_bar: presenter,
                ..Default::default()
            })
            .unwrap();
            load(&mut sdk, pack.path());
            sdk.command("hostChrome", geometry(1)).unwrap();
            let before = sdk.state().unwrap();
            sdk.take_events();
            for name in container_runtime::SYSTEM_TAB_BAR_APIS {
                let response = sdk
                    .active_mut()
                    .unwrap()
                    .dispatch(op::API_CALL, json!({"name":"wx.canIUse","capability":name}))
                    .unwrap();
                assert_eq!(
                    response.messages[0].payload["support"],
                    if presenter { "partial" } else { "unsupported" }
                );
            }
            for name in ["wx.showTabBar", "wx.hideTabBar", "wx.setTabBarItem"] {
                let response = sdk
                    .active_mut()
                    .unwrap()
                    .dispatch(op::API_CALL, json!({"name":"wx.canIUse","capability":name}))
                    .unwrap();
                assert_eq!(response.messages[0].payload["support"], "unsupported");
            }
            let result = sdk.active_mut().unwrap().dispatch(
                op::API_CALL,
                json!({
                    "name":"wx.setTabBarBadge","index":0,"text":"1"
                }),
            );
            if !presenter {
                assert_eq!(result.unwrap_err().code(), "ERR_UNSUPPORTED_CAPABILITY");
                sdk.finish_operation().unwrap();
                assert_eq!(sdk.state().unwrap()["chrome"], before["chrome"]);
                continue;
            }
            result.unwrap();
            sdk.finish_operation().unwrap();
            let after = sdk.state().unwrap();
            assert_eq!(after["chrome"]["tabBar"]["list"][0]["badgeText"], "1");
            assert_eq!(
                after["chrome"]["chromeRevision"].as_u64().unwrap(),
                before["chrome"]["chromeRevision"].as_u64().unwrap() + 1
            );
            assert_eq!(after["frameRevision"], before["frameRevision"]);
            assert_eq!(after["hostChrome"], before["hostChrome"]);
            assert_eq!(after["generation"], before["generation"]);
            let events = sdk.take_events();
            let chrome: Vec<_> = events
                .iter()
                .filter(|event| event["type"] == "chrome")
                .collect();
            assert_eq!(chrome.len(), 1);
            assert_eq!(chrome[0]["chrome"], after["chrome"]);
            assert_eq!(chrome[0]["generation"], after["generation"]);
            // Same-value success and failed transactions must not fabricate a
            // metadata revision or require a new content layout/frame.
            sdk.active_mut()
                .unwrap()
                .dispatch(
                    op::API_CALL,
                    json!({"name":"wx.setTabBarBadge","index":0,"text":"1"}),
                )
                .unwrap();
            assert_eq!(
                sdk.active_mut()
                    .unwrap()
                    .dispatch(
                        op::API_CALL,
                        json!({"name":"wx.setTabBarStyle","color":"#112233","selectedColor":"red"})
                    )
                    .unwrap_err()
                    .code(),
                "ERR_INVALID_REQUEST"
            );
            sdk.finish_operation().unwrap();
            assert_eq!(sdk.state().unwrap()["chrome"], after["chrome"]);
            assert!(!sdk
                .take_events()
                .iter()
                .any(|event| event["type"] == "chrome"));
        }
    }
}

#[test]
fn dynamic_tab_bar_default_packer_admission_requires_a_presenter() {
    let input = tempfile::tempdir().unwrap();
    let output = tempfile::tempdir().unwrap();
    fs::create_dir_all(input.path().join("pages/home")).unwrap();
    fs::write(
        input.path().join("app.json"),
        r#"{"pages":["pages/home/index"],"tabBar":{"list":[{"pagePath":"pages/home/index","text":"Home"}]}}"#,
    )
    .unwrap();
    fs::write(input.path().join("app.js"), "App({});").unwrap();
    fs::write(input.path().join("pages/home/index.js"), "Page({});").unwrap();
    fs::write(input.path().join("pages/home/index.wxml"), "<view/>").unwrap();
    // Exercise the same default CLI used by managed source and dev packs;
    // injecting capabilities into a historical fixture would miss admission.
    let packer = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/container-manifest/bin/container-pack.mjs");
    let packed = std::process::Command::new("node")
        .arg(packer)
        .arg(input.path())
        .arg("--out")
        .arg(output.path())
        .output()
        .expect("the repository's default packer requires Node.js");
    assert!(
        packed.status.success(),
        "default pack failed: {}",
        String::from_utf8_lossy(&packed.stderr)
    );
    let manifest: ContainerManifestV1 =
        serde_json::from_slice(&fs::read(output.path().join("manifest.json")).unwrap()).unwrap();
    for name in container_runtime::SYSTEM_TAB_BAR_APIS {
        assert_eq!(
            manifest.capabilities.get(name),
            Some(&container_ir::CapabilitySupport::Partial),
            "default pack must admit {name} before the host can opt in"
        );
    }
    let engines = [
        #[cfg(feature = "quickjs-native")]
        EngineKind::Quickjs,
        #[cfg(feature = "v8-native")]
        EngineKind::V8,
    ];
    for engine in engines {
        for presenter in [false, true] {
            let mut sdk = ContainerSession::new(ContainerConfig {
                engine,
                system_tab_bar: presenter,
                ..Default::default()
            })
            .unwrap();
            load(&mut sdk, output.path());
            for name in container_runtime::SYSTEM_TAB_BAR_APIS {
                let response = sdk
                    .active_mut()
                    .unwrap()
                    .dispatch(op::API_CALL, json!({"name":"wx.canIUse","capability":name}))
                    .unwrap();
                assert_eq!(
                    response.messages[0].payload["support"],
                    if presenter { "partial" } else { "unsupported" }
                );
            }
            for payload in [
                json!({"name":"wx.setTabBarBadge","index":0,"text":"1"}),
                json!({"name":"wx.removeTabBarBadge","index":0}),
                json!({"name":"wx.showTabBarRedDot","index":0}),
                json!({"name":"wx.hideTabBarRedDot","index":0}),
                json!({"name":"wx.setTabBarStyle","color":"#112233"}),
            ] {
                let result = sdk.active_mut().unwrap().dispatch(op::API_CALL, payload);
                if presenter {
                    result.unwrap();
                } else {
                    assert_eq!(result.unwrap_err().code(), "ERR_UNSUPPORTED_CAPABILITY");
                }
                sdk.finish_operation().unwrap();
            }
            for name in ["wx.showTabBar", "wx.hideTabBar", "wx.setTabBarItem"] {
                let response = sdk
                    .active_mut()
                    .unwrap()
                    .dispatch(op::API_CALL, json!({"name":"wx.canIUse","capability":name}))
                    .unwrap();
                assert_eq!(response.messages[0].payload["support"], "unsupported");
            }
        }
    }
}
