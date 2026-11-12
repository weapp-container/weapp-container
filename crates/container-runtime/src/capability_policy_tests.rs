//! Publication and admission share policy without expanding capability grants.
use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

struct PolicyProvider {
    inventory: BTreeMap<String, CapabilitySupport>,
    reads: Arc<AtomicUsize>,
    sync_files: bool,
}
impl HostApiProvider for PolicyProvider {
    fn name(&self) -> &'static str {
        "capability-policy-test"
    }
    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inventory.clone()
    }
    fn supports_sync_filesystem(&self) -> bool {
        self.sync_files
    }
    fn call(
        &mut self,
        _: &str,
        _: &Map<String, Value>,
        _: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        Err(ProviderError::invalid(
            "policy-only fixture does not execute host APIs",
        ))
    }
}

fn fixture() -> (Session, Arc<AtomicUsize>) {
    let mut manifest = ContainerManifestV1::default();
    manifest.compiler.commit = "combined-policy-native-fixture".into();
    manifest.app.app_json = "app.json".into();
    manifest.app.entry_module = "app.js".into();
    for name in [
        "wx.getRandomValues",
        "wx.onError",
        "wx.offError",
        "wx.onBeforeAppRoute",
        "wx.offBeforeAppRoute",
        "wx.onAppRoute",
        "wx.offAppRoute",
        "wx.rewriteRoute",
        "wx.getStorageSync",
        "wx.setStorage",
        "wx.timer",
        "setTimeout",
        "wx.createSelectorQuery",
        "SelectorQuery",
        "wx.getFileSystemManager",
        "wx.fs.readFileSync",
        "wx.audioContext",
        "wx.createAudioContext",
        "wx.videoContext",
        "wx.createVideoContext",
        "wx.socketTask.send",
        "wx.connectSocket",
        "wx.setTabBarStyle",
    ] {
        manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
    }
    manifest.refresh_integrity().unwrap();
    let mut session = Session::new(manifest, SessionConfig::default()).unwrap();
    session.config.capabilities.insert(
        "wx.offBeforeAppRoute".into(),
        CapabilitySupport::Unsupported,
    );
    session
        .config
        .capabilities
        .insert("wx.setStorage".into(), CapabilitySupport::Partial);
    session
        .config
        .capabilities
        .insert("host.configOnly".into(), CapabilitySupport::Full);
    let mut inventory = BTreeMap::new();
    for name in session.manifest.capabilities.keys() {
        inventory.insert(name.clone(), CapabilitySupport::Full);
    }
    inventory.insert("wx.getRandomValues".into(), CapabilitySupport::Unsupported);
    inventory.insert("wx.getStorageSync".into(), CapabilitySupport::Partial);
    inventory.insert("wx.timer".into(), CapabilitySupport::Partial);
    inventory.insert("wx.createAudioContext".into(), CapabilitySupport::Partial);
    inventory.insert("wx.createVideoContext".into(), CapabilitySupport::Partial);
    inventory.insert("wx.connectSocket".into(), CapabilitySupport::Partial);
    // Exercise fallback to public aliases, without a more specific provider key.
    for name in ["wx.audioContext", "wx.videoContext", "wx.socketTask.send"] {
        inventory.remove(name);
    }
    inventory.insert("host.providerOnly".into(), CapabilitySupport::Full);
    let reads = Arc::new(AtomicUsize::new(0));
    session.set_provider(Box::new(PolicyProvider {
        inventory,
        reads: reads.clone(),
        sync_files: false,
    }));
    (session, reads)
}

fn published(session: &Session, reads: &AtomicUsize) -> BTreeMap<String, CapabilitySupport> {
    reads.store(0, Ordering::SeqCst);
    let result = session.effective_capabilities();
    // Inventory is queried once. supports_sync_filesystem is a separate probe.
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    for (name, support) in &result {
        assert_eq!(*support, session.effective_capability(name), "{name}");
    }
    result
}

#[test]
fn published_keys_share_scalar_policy_and_one_inventory_snapshot() {
    let (mut session, reads) = fixture();
    let caps = published(&session, &reads);
    for (name, expected) in [
        ("wx.getRandomValues", CapabilitySupport::Full),
        ("wx.onError", CapabilitySupport::Partial),
        ("wx.offError", CapabilitySupport::Full),
        ("wx.onBeforeAppRoute", CapabilitySupport::Unsupported),
        ("wx.offBeforeAppRoute", CapabilitySupport::Unsupported),
        ("wx.onAppRoute", CapabilitySupport::Partial),
        ("wx.offAppRoute", CapabilitySupport::Full),
        ("wx.getStorageSync", CapabilitySupport::Partial),
        ("wx.setStorage", CapabilitySupport::Partial),
        ("setTimeout", CapabilitySupport::Partial),
        ("wx.fs.readFileSync", CapabilitySupport::Unsupported),
        ("wx.audioContext", CapabilitySupport::Partial),
        ("wx.videoContext", CapabilitySupport::Partial),
        ("wx.socketTask.send", CapabilitySupport::Partial),
        ("wx.setTabBarStyle", CapabilitySupport::Unsupported),
    ] {
        assert_eq!(caps[name], expected, "{name}");
    }
    assert!(!caps.contains_key("host.configOnly"));
    assert!(!caps.contains_key("host.providerOnly"));
    session
        .config
        .capabilities
        .insert("wx.getRandomValues".into(), CapabilitySupport::Unsupported);
    session
        .config
        .capabilities
        .insert("wx.offError".into(), CapabilitySupport::Unsupported);
    let caps = published(&session, &reads);
    assert_eq!(caps["wx.getRandomValues"], CapabilitySupport::Unsupported);
    assert_eq!(caps["wx.onError"], CapabilitySupport::Partial);
    assert_eq!(caps["wx.offError"], CapabilitySupport::Unsupported);
}

#[test]
fn runtime_cleanup_keys_publish_denial_and_preserve_each_policy_minimum() {
    let (mut session, reads) = fixture();
    let mut inventory: BTreeMap<_, _> = finite_notifications::OFF_APIS
        .into_iter()
        .map(|name| (name.to_owned(), CapabilitySupport::Full))
        .collect();
    inventory.insert(
        "object:InnerAudioContext.offPause".into(),
        CapabilitySupport::Unsupported,
    );
    session.set_provider(Box::new(PolicyProvider {
        inventory,
        reads: reads.clone(),
        sync_files: false,
    }));
    session.config.capabilities.insert(
        "object:InnerAudioContext.offCanplay".into(),
        CapabilitySupport::Full,
    );
    // Runtime ownership publishes a denied key even when only a provider or
    // host names it. Neither source can replace the missing pack declaration.
    let caps = published(&session, &reads);
    for name in finite_notifications::OFF_APIS {
        assert_eq!(caps[name], CapabilitySupport::Unsupported, "{name}");
    }

    for (name, manifest, host, expected) in [
        (
            "object:InnerAudioContext.offCanplay",
            CapabilitySupport::Full,
            CapabilitySupport::Full,
            CapabilitySupport::Full,
        ),
        (
            "object:InnerAudioContext.offPlay",
            CapabilitySupport::Full,
            CapabilitySupport::Partial,
            CapabilitySupport::Partial,
        ),
        (
            "object:InnerAudioContext.offEnded",
            CapabilitySupport::Unsupported,
            CapabilitySupport::Full,
            CapabilitySupport::Unsupported,
        ),
        (
            "object:InnerAudioContext.offError",
            CapabilitySupport::Full,
            CapabilitySupport::Unsupported,
            CapabilitySupport::Unsupported,
        ),
        (
            "object:InnerAudioContext.offPause",
            CapabilitySupport::Full,
            CapabilitySupport::Full,
            CapabilitySupport::Unsupported,
        ),
    ] {
        session.manifest.capabilities.insert(name.into(), manifest);
        session.config.capabilities.insert(name.into(), host);
        assert_eq!(published(&session, &reads)[name], expected, "{name}");
    }
}

#[test]
fn registered_extensions_snapshots_and_mandatory_account_keep_their_keys() {
    let (mut session, reads) = fixture();
    let config = HostServicesConfig {
        application: TrustedApplication {
            host_app_id: "host".into(),
            tenant_id: "tenant".into(),
            publisher_id: "publisher".into(),
            app_id: "installed-app".into(),
            environment: "develop".into(),
            version: "1".into(),
            pack_root: session.manifest.integrity.root.clone(),
        },
        apis: vec![
            "wx.getBatteryInfo".into(),
            "weappContainer.identity.getState".into(),
        ],
        sync_values: BTreeMap::from([(
            "weappContainer.identity.getState".into(),
            json!({"hostLoggedIn":false,"appLoggedIn":false,"profileAuthorized":false,"phoneAuthorized":false}),
        )]),
        ..Default::default()
    };
    session.configure_host_services(config).unwrap();
    let caps = published(&session, &reads);
    assert_eq!(caps["wx.getBatteryInfo"], CapabilitySupport::Partial);
    assert_eq!(
        caps["weappContainer.identity.getState"],
        CapabilitySupport::Partial
    );
    assert_eq!(caps["wx.getAccountInfoSync"], CapabilitySupport::Partial);
    assert_eq!(caps["wx.getRandomValues"], CapabilitySupport::Full);
    // Registered async extensions retain their defaults; a registered snapshot
    // still requires provider evidence and cannot inherit an absent value.
    let absent = BTreeMap::new();
    assert_eq!(
        session.effective_capability_with_provider("wx.getBatteryInfo", &absent),
        CapabilitySupport::Partial
    );
    assert_eq!(
        session.effective_capability_with_provider("weappContainer.identity.getState", &absent),
        CapabilitySupport::Unsupported
    );
}

#[test]
fn browser_selector_and_sync_filesystem_gates_survive_shared_policy() {
    let (mut session, reads) = fixture();
    session.config.renderer_override = Some(container_ir::RendererProfile::WebView);
    session.config.browser_view_enabled = true;
    let caps = published(&session, &reads);
    assert_eq!(
        caps["wx.createSelectorQuery"],
        CapabilitySupport::Unsupported
    );
    let request = BridgeEnvelope::request(
        "session-1",
        "enable-policy-query",
        op::VIEW_QUERY_ENABLE,
        json!({"version":"1.0","scope":"session"}),
    );
    session.handle_browser_query_operation(&request).unwrap();
    let caps = published(&session, &reads);
    assert_eq!(caps["wx.createSelectorQuery"], CapabilitySupport::Partial);
    assert_eq!(caps["SelectorQuery"], CapabilitySupport::Partial);
    assert_eq!(caps["wx.fs.readFileSync"], CapabilitySupport::Unsupported);
}

#[test]
fn cleanup_grade_keeps_own_minima_and_peer_admission() {
    let (mut session, reads) = fixture();
    // A Partial producer still admits the full removal contract.
    session
        .config
        .capabilities
        .insert("wx.onAppRoute".into(), CapabilitySupport::Partial);
    assert_eq!(
        published(&session, &reads)["wx.offAppRoute"],
        CapabilitySupport::Full
    );
    session
        .manifest
        .capabilities
        .insert("wx.offAppRoute".into(), CapabilitySupport::Partial);
    assert_eq!(
        published(&session, &reads)["wx.offAppRoute"],
        CapabilitySupport::Partial
    );
    session
        .manifest
        .capabilities
        .insert("wx.offAppRoute".into(), CapabilitySupport::Full);
    session
        .config
        .capabilities
        .insert("wx.offAppRoute".into(), CapabilitySupport::Partial);
    assert_eq!(
        published(&session, &reads)["wx.offAppRoute"],
        CapabilitySupport::Partial
    );
    session
        .config
        .capabilities
        .insert("wx.offAppRoute".into(), CapabilitySupport::Full);
    let mut inventory = BTreeMap::new();
    inventory.insert("wx.onAppRoute".into(), CapabilitySupport::Partial);
    inventory.insert("wx.offAppRoute".into(), CapabilitySupport::Partial);
    session.set_provider(Box::new(PolicyProvider {
        inventory,
        reads: reads.clone(),
        sync_files: false,
    }));
    assert_eq!(
        published(&session, &reads)["wx.offAppRoute"],
        CapabilitySupport::Partial
    );
    let mut inventory = BTreeMap::new();
    inventory.insert("wx.onAppRoute".into(), CapabilitySupport::Unsupported);
    inventory.insert("wx.offAppRoute".into(), CapabilitySupport::Full);
    session.set_provider(Box::new(PolicyProvider {
        inventory,
        reads: reads.clone(),
        sync_files: false,
    }));
    let caps = published(&session, &reads);
    assert_eq!(caps["wx.onAppRoute"], CapabilitySupport::Unsupported);
    assert_eq!(caps["wx.offAppRoute"], CapabilitySupport::Unsupported);
}
