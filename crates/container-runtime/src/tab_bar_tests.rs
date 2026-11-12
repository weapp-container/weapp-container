fn tab_bar_test_session(custom: bool) -> Session {
    let mut app = manifest();
    let config = serde_json::to_vec(&json!({"tabBar":{"custom":custom,"list":[
        {"pagePath":"home","text":"Home"},{"pagePath":"other","text":"Other"}]}}))
    .unwrap();
    let hash = container_ir::hex_digest(&config);
    app.modules.push(Module {
        id: "module:app.json".into(),
        sha256: hash.clone(),
        format: ModuleFormat::Json,
        scope: ModuleScope::App,
        dependencies: Vec::new(),
    });
    for path in ["home", "other", "detail"] {
        app.routes.push(container_ir::Route {
            id: format!("route:{path}"),
            path: path.into(),
            kind: if path == "detail" {
                container_ir::RouteKind::Page
            } else {
                container_ir::RouteKind::Tab
            },
            config: None,
            entry_module: "app.js".into(),
        });
    }
    for name in crate::tab_bar::APIS {
        app.capabilities
            .insert(name.into(), CapabilitySupport::Partial);
    }
    app.refresh_integrity().unwrap();
    let mut session = Session::new(
        app,
        SessionConfig {
            capabilities: crate::tab_bar::APIS
                .into_iter()
                .map(|name| (name.to_owned(), CapabilitySupport::Partial))
                .collect(),
            ..SessionConfig::default()
        },
    )
    .unwrap();
    session.render_blobs = Arc::new(BTreeMap::from([(hash, config)]));
    session.dispatch(request("init", op::APP_INIT, json!({})));
    session.dispatch(request("page", op::PAGE_PUSH, json!({"path":"home"})));
    session
}
fn tab_bar_call(session: &mut Session, name: &str, options: Value) -> BridgeBatch {
    let mut payload = options.as_object().unwrap().clone();
    payload.insert("name".into(), json!(name));
    session.dispatch(request("tab-api", op::API_CALL, Value::Object(payload)))
}
#[test]
fn tab_bar_transactions_project_real_session_state_without_invalidating_view() {
    let mut session = tab_bar_test_session(false);
    let revision = session.view.template_revision;
    let response = tab_bar_call(
        &mut session,
        "wx.setTabBarBadge",
        json!({"index":1,"text":"12345"}),
    );
    assert_eq!(
        response.messages[0].payload["result"]["errMsg"],
        "setTabBarBadge:ok"
    );
    let chrome = session.page_chrome().unwrap().unwrap();
    assert_eq!(chrome.tab_bar.list[1].badge_text.as_deref(), Some("..."));
    assert!(!chrome.tab_bar.list[1].red_dot);
    assert_eq!(session.view.template_revision, revision);
    tab_bar_call(&mut session, "wx.showTabBarRedDot", json!({"index":1}));
    let chrome = session.page_chrome().unwrap().unwrap();
    assert!(chrome.tab_bar.list[1].red_dot);
    assert_eq!(chrome.tab_bar.list[1].badge_text, None);
    tab_bar_call(&mut session, "wx.removeTabBarBadge", json!({"index":1}));
    assert!(session.page_chrome().unwrap().unwrap().tab_bar.list[1].red_dot);
    tab_bar_call(&mut session, "wx.hideTabBarRedDot", json!({"index":1}));
    assert!(!session.page_chrome().unwrap().unwrap().tab_bar.list[1].red_dot);
}
#[test]
fn tab_bar_validation_is_atomic_and_global_across_non_tab_routes() {
    let mut session = tab_bar_test_session(false);
    tab_bar_call(
        &mut session,
        "wx.setTabBarStyle",
        json!({"color":"#abc","borderStyle":"white"}),
    );
    let before = session.page_chrome().unwrap().unwrap();
    assert_eq!(before.tab_bar.color, "#aabbcc");
    let failed = tab_bar_call(
        &mut session,
        "wx.setTabBarStyle",
        json!({"color":"#123456","selectedColor":"red"}),
    );
    assert_eq!(
        failed.messages[0].payload["error"]["code"],
        "ERR_INVALID_REQUEST"
    );
    assert_eq!(before, session.page_chrome().unwrap().unwrap());
    for index in [json!(-1), json!(0.5), json!(2), json!("0"), Value::Null] {
        let failed = tab_bar_call(
            &mut session,
            "wx.setTabBarBadge",
            json!({"index":index,"text":"1"}),
        );
        assert_eq!(
            failed.messages[0].payload["error"]["code"],
            "ERR_INVALID_REQUEST"
        );
        assert_eq!(before, session.page_chrome().unwrap().unwrap());
    }
    session.dispatch(request("detail", op::PAGE_PUSH, json!({"path":"detail"})));
    tab_bar_call(
        &mut session,
        "wx.setTabBarBadge",
        json!({"index":0,"text":"你好"}),
    );
    let hidden = session.page_chrome().unwrap().unwrap();
    assert!(!hidden.tab_bar.visible);
    assert_eq!(hidden.tab_bar.list[0].badge_text.as_deref(), Some("你好"));
    tab_bar_call(&mut session, "wx.setTabBarStyle", json!({}));
    assert_eq!(hidden, session.page_chrome().unwrap().unwrap());
}
#[test]
fn tab_bar_custom_scope_and_lifetime_do_not_leak_state() {
    let mut custom = tab_bar_test_session(true);
    let response = tab_bar_call(&mut custom, "wx.showTabBarRedDot", json!({"index":0}));
    assert_eq!(
        response.messages[0].payload["error"]["code"],
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    let mut first = tab_bar_test_session(false);
    tab_bar_call(
        &mut first,
        "wx.setTabBarBadge",
        json!({"index":0,"text":"😀😀"}),
    );
    assert_eq!(
        first.page_chrome().unwrap().unwrap().tab_bar.list[0]
            .badge_text
            .as_deref(),
        Some("😀😀")
    );
    first.retire_lifecycle_notifications().unwrap();
    assert_eq!(
        first.page_chrome().unwrap().unwrap().tab_bar.list[0].badge_text,
        None
    );
    let next = tab_bar_test_session(false);
    assert_eq!(
        next.page_chrome().unwrap().unwrap().tab_bar.list[0].badge_text,
        None
    );
}

#[test]
fn tab_bar_admission_requires_a_presenter_and_rejected_requests_do_not_commit() {
    let mut session = tab_bar_test_session(false);
    session.config.capabilities.clear();
    assert_eq!(
        session.effective_capability("wx.setTabBarBadge"),
        CapabilitySupport::Unsupported
    );
    assert_eq!(
        session.effective_capabilities()["wx.setTabBarBadge"],
        CapabilitySupport::Unsupported
    );
    let result = tab_bar_call(
        &mut session,
        "wx.setTabBarBadge",
        json!({"index":0,"text":"1"}),
    );
    assert_eq!(
        result.messages[0].payload["error"]["code"],
        "ERR_UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        session.page_chrome().unwrap().unwrap().tab_bar.list[0].badge_text,
        None
    );
    session
        .config
        .capabilities
        .insert("wx.setTabBarBadge".into(), CapabilitySupport::Partial);
    let error = session
        .tab_bar_api_result(
            "wx.setTabBarBadge",
            json!({"index":0,"text":"1"}).as_object().unwrap(),
            Some(0),
            None,
        )
        .unwrap_err();
    assert_eq!(error.code, BridgeErrorCode::Timeout);
    session.cancel_request_token("tab-cancel").unwrap();
    let error = session
        .tab_bar_api_result(
            "wx.setTabBarBadge",
            json!({"index":0,"text":"1"}).as_object().unwrap(),
            None,
            Some("tab-cancel"),
        )
        .unwrap_err();
    assert_eq!(error.code, BridgeErrorCode::Cancelled);
    assert_eq!(
        session.page_chrome().unwrap().unwrap().tab_bar.list[0].badge_text,
        None
    );
    for name in ["wx.showTabBar", "wx.hideTabBar", "wx.setTabBarItem"] {
        session
            .manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
        session
            .config
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
        assert_eq!(
            session.effective_capability(name),
            CapabilitySupport::Unsupported
        );
    }
}

#[test]
fn tab_bar_manifest_cannot_inject_dynamic_indicators() {
    let item: crate::chrome::TabBarItem = serde_json::from_value(json!({
        "pagePath":"home", "text":"Home", "badgeText":"fake", "redDot":true
    }))
    .unwrap();
    assert_eq!(item.badge_text, None);
    assert!(!item.red_dot);
    assert_eq!(
        serde_json::to_value(item).unwrap(),
        json!({"pagePath":"home","text":"Home"})
    );
}

#[test]
fn tab_bar_direct_session_full_claims_cannot_exceed_candidate_contract() {
    let mut session = tab_bar_test_session(false);
    for name in crate::tab_bar::APIS {
        session
            .manifest
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
        session
            .config
            .capabilities
            .insert(name.into(), CapabilitySupport::Full);
        assert_eq!(
            session.effective_capability(name),
            CapabilitySupport::Partial
        );
        assert_eq!(
            session.effective_capabilities()[name],
            CapabilitySupport::Partial
        );
    }
}
