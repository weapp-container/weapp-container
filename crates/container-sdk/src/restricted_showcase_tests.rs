use super::*;

#[test]
fn restricted_showcase_sdk_refuses_development_and_authorization_through_both_interfaces() {
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    for operation in [
        "devState",
        "classifyDevPack",
        "applyDevPack",
        "inspectPackChrome",
        "authorizeInstalledPack",
        "beginDevPackAttempt",
        "queryDevPackAttempt",
        "applyDevPackAttempt",
        "cancelDevPackAttempt",
        "registerHostMethod",
        "clearDevStorage",
    ] {
        assert_eq!(
            session.command(operation, json!({})).unwrap_err().code(),
            "ERR_UNSUPPORTED_CAPABILITY",
            "{operation}"
        );
    }
    assert_eq!(
        session
            .classify_dev_pack(PackSource::Directory("/does-not-exist".into()))
            .unwrap_err()
            .code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session
            .apply_dev_pack(
                PackSource::Directory("/does-not-exist".into()),
                LoadOptions::default()
            )
            .unwrap_err()
            .code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session
            .authorize_installed_pack(TrustedApplication::default())
            .unwrap_err()
            .code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session.register_host_method("invoke").unwrap_err().code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session
            .begin_dev_pack_attempt(json!({}))
            .unwrap_err()
            .code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session.query_dev_pack_attempt("0", "0").unwrap_err().code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    let capabilities = session.capabilities().unwrap();
    assert_eq!(capabilities["distributionProfile"], "restricted-showcase");
    assert_eq!(capabilities["policySha256"].as_str().unwrap().len(), 64);
    assert_eq!(capabilities["pack"]["devReload"]["inPlace"], false);
    assert_eq!(capabilities["nativeApis"]["wx.request"], "unsupported");
    assert_eq!(
        ContainerSession::new(ContainerConfig {
            dev_diagnostics: true,
            ..Default::default()
        })
        .err()
        .unwrap()
        .code(),
        "ERR_UNSUPPORTED_CAPABILITY"
    );
}

#[test]
fn restricted_showcase_sdk_rejects_unknown_valid_pack_before_reading_blobs() {
    let mut manifest: container_ir::ContainerManifestV1 = serde_json::from_str(include_str!(
        "../../container-runtime/tests/fixtures/showcase-manifest.json"
    ))
    .unwrap();
    manifest.compiler.commit = "valid-unapproved-pack".into();
    manifest.refresh_integrity().unwrap();
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let mut session = ContainerSession::new(ContainerConfig::default()).unwrap();
    assert_eq!(
        session
            .load(
                PackSource::Directory(directory.path().into()),
                LoadOptions::default()
            )
            .unwrap_err()
            .code(),
        "ERR_UNTRUSTED_APPLICATION"
    );
}
