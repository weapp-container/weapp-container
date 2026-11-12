//! Run only with the matching checked-in test policy and QuickJS provider.
use super::*;
const SOURCE: &str = include_str!("../tests/fixtures/showcase-app.js");

fn manifest() -> ContainerManifestV1 {
    serde_json::from_str(include_str!("../tests/fixtures/showcase-manifest.json")).unwrap()
}
fn request(operation: &str, payload: Value) -> BridgeEnvelope {
    BridgeEnvelope::request("showcase-test", operation, operation, payload)
}
fn initialized() -> Session {
    initialized_with_renderer(None)
}
fn initialized_with_renderer(renderer_override: Option<container_ir::RendererProfile>) -> Session {
    let mut config = SessionConfig {
        session_id: "showcase-test".into(),
        renderer_override,
        browser_view_enabled: renderer_override == Some(container_ir::RendererProfile::WebView),
        ..Default::default()
    };
    // Even a trusted host cannot lift the compiled ceiling.
    config
        .capabilities
        .insert("wx.request".into(), CapabilitySupport::Full);
    let mut session = Session::new(manifest(), config).unwrap();
    struct GrantingProvider;
    impl HostApiProvider for GrantingProvider {
        fn name(&self) -> &'static str {
            "attempted-provider-regrant"
        }
        fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
            manifest()
                .capabilities
                .into_iter()
                .map(|(name, _)| (name, CapabilitySupport::Full))
                .collect()
        }
        fn call(
            &mut self,
            name: &str,
            _: &Map<String, Value>,
            _: &ProviderContext,
        ) -> Result<Value, ProviderError> {
            panic!("denied provider call escaped the runtime policy: {name}")
        }
    }
    session.set_provider(Box::new(GrantingProvider));
    let batch = session.dispatch(request(
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":SOURCE}]}),
    ));
    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
    session
}

#[test]
fn restricted_showcase_rejects_other_roots_and_invalid_integrity_before_engine_creation() {
    let mut unknown = manifest();
    unknown.compiler.commit = "different-but-valid-pack".into();
    unknown.refresh_integrity().unwrap();
    assert!(matches!(
        Session::new(unknown, SessionConfig::default()),
        Err(SessionError::UntrustedApplication(_))
    ));
    let mut corrupt = manifest();
    corrupt.compiler.commit = "tampered".into();
    assert!(matches!(
        Session::new(corrupt, SessionConfig::default()),
        Err(SessionError::Manifest(_))
    ));
    let mut no_root = manifest();
    no_root.integrity.root.clear();
    assert!(Session::new(
        no_root,
        SessionConfig {
            require_integrity: false,
            ..Default::default()
        }
    )
    .is_err());
}

#[test]
fn restricted_showcase_capabilities_deny_regrant_aliases_callbacks_and_keep_local_flow() {
    let mut session = initialized();
    for api in [
        "wx.request",
        "wx.requestPayment",
        "wx.connectSocket",
        "wx.socketTask.send",
        "wx.getFileSystemManager",
        "wx.fs.readFileSync",
        "wx.createCanvasContext",
        "wx.canvas.draw",
    ] {
        assert_eq!(
            session.effective_capability(api),
            CapabilitySupport::Unsupported,
            "{api}"
        );
        let batch = session.dispatch(request(op::API_CALL, json!({"name":api})));
        assert_eq!(
            batch.messages[0].payload["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
            "{api}: {batch:?}"
        );
    }
    for spelling in [
        "request",
        "wx.request",
        "wx.socketTask.send",
        "wx.fs.readFileSync",
    ] {
        let batch = session.dispatch(request(
            op::API_CALL,
            json!({"name":"wx.canIUse", "capability":spelling}),
        ));
        assert_eq!(batch.messages[0].payload["result"], false, "{batch:?}");
    }
    let storage = session.app_service().storage();
    assert_eq!(storage.get("cart").unwrap()["total"], 36);
    assert_eq!(
        storage.get("deniedCallback"),
        Some(&json!("ERR_UNSUPPORTED_CAPABILITY"))
    );
    assert_eq!(
        storage.get("deniedPromise"),
        Some(&json!("ERR_UNSUPPORTED_CAPABILITY"))
    );
    assert!(session.take_host_requests().iter().any(|value| matches!(value, HostRequest::Message { payload, .. } if payload["kind"] == "showcase-ready")));
    for op in [op::MODULE_CALL, op::DIAGNOSTIC] {
        let batch = session.dispatch(request(
            op,
            json!({"moduleId":"module:app.js","export":"inspect"}),
        ));
        assert_eq!(
            batch.messages[0].payload["error"]["code"], "ERR_UNSUPPORTED_CAPABILITY",
            "{batch:?}"
        );
    }
    assert!(session.replace_manifest(manifest()).is_err());
    assert!(session.set_dev_console_enabled(true).is_err());
}

#[test]
fn restricted_showcase_rejects_tampered_module_bytes() {
    let mut session = Session::new(
        manifest(),
        SessionConfig {
            session_id: "showcase-test".into(),
            ..Default::default()
        },
    )
    .unwrap();
    let batch = session.dispatch(request(
        op::APP_INIT,
        json!({"modules":[{"id":"module:app.js","source":"App({});"}]}),
    ));
    assert_eq!(
        batch.messages[0].payload["error"]["code"],
        "ERR_MODULE_LOAD"
    );
    assert!(session.app_service().storage().get("cart").is_none());
}

#[test]
fn restricted_showcase_denies_shared_dev_presentation_admission_before_candidate_validation() {
    let session = initialized();
    // The same allowlisted pack is still forbidden as a development candidate.
    let mut candidate = Session::new(manifest(), session.config().clone()).unwrap();
    let expected = BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        "development manifest replacement is disabled in this distribution",
    );
    assert_eq!(
        session.validate_dev_presentation_manifest(&candidate),
        Err(expected.clone())
    );
    // Denial belongs to the distribution, before even inspecting untrusted
    // candidate metadata or negotiating a protocol for either renderer path.
    candidate.manifest.protocol_version = "invalid".into();
    candidate.manifest.integrity.root.clear();
    assert_eq!(
        session.validate_dev_presentation_manifest(&candidate),
        Err(expected)
    );
    assert!(!candidate.initialized);
    assert_eq!(candidate.view_execution_metrics(), Default::default());
}

#[test]
fn restricted_showcase_denies_all_dev_presentation_paths_without_mutating_either_owner() {
    let mut session = initialized();
    let mut candidate = Session::new(manifest(), session.config().clone()).unwrap();
    let snapshot = |session: &Session| {
        json!({
            "manifest": session.manifest(),
            "generation": session.browser_dev_presentation_generation(),
            "browserPending": session.browser_dev_presentation_pending(),
            "renderBlobs": session.render_blobs,
            "resourcesVerified": session.render_resources_verified,
            "lastFrameId": session.view.last_frame_id,
            "viewRevision": session.view.revision,
            "viewMetrics": session.view_execution_metrics(),
            "executionHealth": session.execution_health(),
            "componentPages": session.component_pages.len(),
            "initialized": session.initialized,
            "cart": session.app_service().storage().get("cart"),
        })
    };
    let live_before = snapshot(&session);
    let candidate_before = snapshot(&candidate);
    let expected = BridgeError::new(
        BridgeErrorCode::UnsupportedCapability,
        "development manifest replacement is disabled in this distribution",
    );
    // Null is deliberately not a render payload: policy must reject before
    // resource parsing, View evaluation or creation of staged authority.
    let request = request(op::RENDER_COMMIT, Value::Null);
    assert_eq!(
        session
            .replace_dev_presentation(&mut candidate, &Value::Null)
            .unwrap_err(),
        expected
    );
    assert_eq!(snapshot(&session), live_before);
    assert_eq!(snapshot(&candidate), candidate_before);
    assert_eq!(
        session
            .replace_dev_presentation_request(&mut candidate, &request)
            .unwrap_err(),
        expected
    );
    assert_eq!(snapshot(&session), live_before);
    assert_eq!(snapshot(&candidate), candidate_before);

    // Enter through the public browser API with a real browser configuration,
    // so a missing presentation backend cannot masquerade as policy denial.
    let mut browser = initialized_with_renderer(Some(container_ir::RendererProfile::WebView));
    let mut browser_candidate = Session::new(manifest(), browser.config().clone()).unwrap();
    // A rejected public call must not clear a candidate's previously prepared
    // graph on its way to the shared manifest validator.
    browser_candidate
        .component_pages
        .insert(PageId(u64::MAX), Default::default());
    let browser_before = snapshot(&browser);
    let browser_candidate_before = snapshot(&browser_candidate);
    assert_eq!(
        browser
            .replace_browser_dev_presentation(&mut browser_candidate, &Value::Null)
            .unwrap_err(),
        expected
    );
    assert_eq!(snapshot(&browser), browser_before);
    assert_eq!(snapshot(&browser_candidate), browser_candidate_before);

    // The compiled policy is also checked before beginning an engine turn,
    // even when the live owner would otherwise reject execution first.
    browser.engine_execution_fault = Some(BridgeError::new(
        BridgeErrorCode::Engine,
        "already faulted before development replacement",
    ));
    let faulted_before = snapshot(&browser);
    assert_eq!(
        browser
            .replace_browser_dev_presentation(&mut browser_candidate, &Value::Null)
            .unwrap_err(),
        expected
    );
    assert_eq!(snapshot(&browser), faulted_before);
    assert_eq!(snapshot(&browser_candidate), browser_candidate_before);
}
