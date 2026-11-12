//! Optional transport transitions on one existing Web runtime owner.
//! The contract does not construct or acknowledge a browser presenter.

use super::{WebHost, WebRendererMode, WebRendererPolicy};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_core::LifecycleState;
use container_host_common::HostSessionError;
use serde_json::{json, Value};

const CONTRACT: &str = r#"{"version":"1.0","runtimeOwner":"1.0","presenterBinding":"1.0","inputLifetime":"1.0","transitionFinal":"1.0"}"#;
const INPUT_LIMIT: usize = 16 * 1024;

fn protocol(message: &str) -> HostSessionError {
    BridgeError::protocol(message).into()
}

fn cancelled(message: &str) -> HostSessionError {
    BridgeError::new(BridgeErrorCode::Cancelled, message).into()
}

fn unsupported(message: &str) -> HostSessionError {
    BridgeError::new(BridgeErrorCode::UnsupportedCapability, message).into()
}

fn input(bytes: &[u8]) -> Result<Value, HostSessionError> {
    if bytes.len() > INPUT_LIMIT {
        return Err(protocol("renderer transition input exceeds 16 KiB"));
    }
    let value: Value = serde_json::from_slice(bytes)?;
    if !value.is_object() || value["version"] != "1.0" {
        return Err(protocol("renderer transition requires version 1.0"));
    }
    Ok(value)
}

fn decimal(value: &Value, positive: bool) -> bool {
    value.as_str().is_some_and(|text| {
        text.len() <= 20
            && text
                .parse::<u64>()
                .is_ok_and(|number| (!positive || number != 0) && number.to_string() == text)
    })
}

fn expected_is_valid(value: &Value) -> bool {
    let keys = [
        "sessionId",
        "pageId",
        "routePath",
        "rendererProfile",
        "inputLifetimeRevision",
        "presenterGeneration",
        "transportBackend",
    ];
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    }) && value["sessionId"]
        .as_str()
        .is_some_and(|text| !text.is_empty() && text.len() <= 256)
        && value["routePath"]
            .as_str()
            .is_some_and(|text| !text.is_empty() && text.len() <= 4096)
        && decimal(&value["pageId"], true)
        && decimal(&value["inputLifetimeRevision"], false)
        && decimal(&value["presenterGeneration"], true)
        && matches!(
            value["rendererProfile"].as_str(),
            Some("webview" | "skia" | "skyline-compat")
        )
        && matches!(
            value["transportBackend"].as_str(),
            Some("browser-view" | "external-frame")
        )
}

impl WebHost {
    /// A transport binding cannot adopt an older retained Skia tree. A normal
    /// generated render commit must establish this lifetime's input proof first.
    /// Legacy manual-frame/diagnostic callers keep their original contract.
    pub(super) fn require_transition_frame_input(
        &self,
        revision: u64,
    ) -> Result<(), HostSessionError> {
        if self.presenter_generation.is_some()
            && self
                .session
                .session()
                .ok_or(HostSessionError::NotLoaded)?
                .last_frame_input(revision)
                .is_none()
        {
            return Err(cancelled(
                "renderer binding has no generated frame from its current input lifetime",
            ));
        }
        Ok(())
    }

    /// Drain both input families while retaining the original business owner.
    pub fn retire_page_presenter(
        &mut self,
        reason: &str,
    ) -> Result<container_bridge::BridgeBatch, HostSessionError> {
        self.session.retire_page_presenter(reason)
    }

    /// Pure capability handshake, callable before a manifest or app.init.
    pub const fn renderer_transition_contract_json(&self) -> &'static str {
        CONTRACT
    }

    /// Explicit pre-app.init opt-in. Ordinary fixed-family callers retain their
    /// existing behavior; enabling never initializes JS or creates a presenter.
    pub fn enable_renderer_transitions_json(
        &mut self,
        bytes: &[u8],
    ) -> Result<Vec<u8>, HostSessionError> {
        let value = input(bytes)?;
        if value.as_object().is_none_or(|object| object.len() != 1) {
            return Err(protocol("renderer transition enable accepts only version"));
        }
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        if self.session.initialized()
            || session.app_service().lifecycle().state() != LifecycleState::Created
        {
            return Err(unsupported(
                "renderer transitions must be enabled before app.init",
            ));
        }
        if self.renderer_policy != Some(WebRendererPolicy::Manifest)
            || self.renderer_mode == WebRendererMode::Software
            || !session.config().browser_view_enabled
        {
            return Err(unsupported("renderer transitions require explicit manifest policy and a document/frame transport"));
        }
        self.presenter_generation.get_or_insert(1);
        self.renderer_transition_state_json()
    }

    fn presenter_binding(&self) -> Result<Value, HostSessionError> {
        let generation = self
            .presenter_generation
            .ok_or_else(|| unsupported("renderer transitions were not explicitly enabled"))?;
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        Ok(json!({
            "version": "1.0",
            "sessionId": session.config().session_id,
            "generation": generation.to_string(),
            "transportBackend": self.renderer_mode.as_str(),
        }))
    }

    /// Passive state: runtime identity stays stable while the binding changes.
    /// No sequence, hard input lifetime or presentation permission is minted.
    pub fn renderer_transition_state_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let binding = self.presenter_binding()?;
        let session = self.session.session().ok_or(HostSessionError::NotLoaded)?;
        let state: Value = serde_json::from_slice(&self.runtime_state_json()?)?;
        Ok(serde_json::to_vec(&json!({
            "version": "1.0",
            "presenterBinding": binding,
            "inputLifetimeRevision": session.input_lifetime_revision().map(|value| value.to_string()),
            "state": state,
        }))?)
    }

    /// Change transport on this same owner after retiring all old input.
    /// A final is a transport receipt only, never a new presented-frame ACK.
    /// Preflight failures execute no JS. Cancellation callbacks are irreversible
    /// and may navigate; that race returns its real batch with ok:false while
    /// leaving the old transport binding in place and input revoked.
    pub fn transition_renderer_json(&mut self, bytes: &[u8]) -> Result<Vec<u8>, HostSessionError> {
        let value = input(bytes)?;
        if value.as_object().is_none_or(|object| object.len() != 2)
            || !expected_is_valid(&value["expected"])
        {
            return Err(protocol(
                "renderer transition requires exact expected input",
            ));
        }
        let expected = &value["expected"];
        let before: Value = serde_json::from_slice(&self.renderer_transition_state_json()?)?;
        let state = &before["state"];
        let binding = &before["presenterBinding"];
        if state["lifecycle"] != "Active"
            || state["requiresRestart"] != false
            || expected["sessionId"] != state["sessionId"]
            || expected["pageId"] != state["currentPage"]["pageId"]
            || expected["routePath"] != state["currentPage"]["path"]
            || expected["rendererProfile"] != state["rendererProfile"]
            || expected["inputLifetimeRevision"] != before["inputLifetimeRevision"]
            || expected["presenterGeneration"] != binding["generation"]
            || expected["transportBackend"] != binding["transportBackend"]
        {
            return Err(cancelled(
                "renderer transition expected input is no longer current",
            ));
        }
        let next_mode = if state["rendererProfile"] == "webview" {
            WebRendererMode::BrowserView
        } else {
            WebRendererMode::ExternalFrame
        };
        if next_mode == self.renderer_mode {
            return Err(unsupported(
                "current route already uses this presenter family",
            ));
        }
        let next_generation = self
            .presenter_generation
            .and_then(|value| value.checked_add(1))
            .ok_or_else(|| protocol("presenter generation exhausted"))?;
        let old_input = before["inputLifetimeRevision"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| protocol("runtime hard input lifetime is unavailable"))?;
        let next_input = old_input
            .checked_add(1)
            .ok_or_else(|| protocol("runtime hard input lifetime exhausted"))?;
        let next_input_text = next_input.to_string();

        let batch = self
            .session
            .retire_page_presenter("renderer-family-changed")?;
        let after: Value = serde_json::from_slice(&self.renderer_transition_state_json()?)?;
        let observed = &after["state"];
        let still_current = observed["lifecycle"] == "Active"
            && observed["requiresRestart"] == false
            && observed["currentPage"] == state["currentPage"]
            && observed["rendererProfile"] == state["rendererProfile"]
            && after["inputLifetimeRevision"].as_str() == Some(next_input_text.as_str());
        if !still_current {
            return Ok(serde_json::to_vec(&json!({
                "version": "1.0", "ok": false,
                "previousPresenterBinding": binding,
                "presenterBinding": after["presenterBinding"],
                "inputLifetimeRevision": after["inputLifetimeRevision"],
                "batch": batch, "observedState": observed,
                "error": {"code":"ERR_CANCELLED", "message":"page or input lifetime changed during presenter retirement"},
            }))?);
        }
        self.renderer_mode = next_mode;
        self.presenter_generation = Some(next_generation);
        self.external_ack_blocked = None;
        let final_state: Value = serde_json::from_slice(&self.runtime_state_json()?)?;
        Ok(serde_json::to_vec(&json!({
            "version": "1.0", "ok": true,
            "previousPresenterBinding": binding,
            "presenterBinding": self.presenter_binding()?,
            "inputLifetimeRevision": next_input_text,
            "batch": batch, "observedState": final_state,
        }))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_bridge::BridgeEnvelope;
    use container_ir::{ContainerManifestV1, RendererProfile, RendererProfiles, Route, RouteKind};
    use container_runtime::SessionConfig;

    fn loaded(mode: WebRendererMode) -> WebHost {
        let mut manifest = ContainerManifestV1 {
            schema_version: container_ir::RENDERING_MANIFEST_SCHEMA_VERSION,
            rendering: Some(RendererProfiles::default()),
            ..Default::default()
        };
        manifest.compiler.name = "weapp-vite".into();
        manifest.compiler.commit = "renderer-transition-contract".into();
        manifest.compiler.platform = "weapp".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        for (path, profile) in [
            ("pages/skia/index", RendererProfile::Skia),
            ("pages/dom/index", RendererProfile::WebView),
        ] {
            manifest.routes.push(Route {
                id: format!("route:{path}"),
                path: path.into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: format!("{path}.js"),
            });
            manifest
                .rendering
                .as_mut()
                .unwrap()
                .pages
                .insert(path.into(), profile);
        }
        let mut host = WebHost::new();
        host.load_manifest_json_with_renderer_policy(
            serde_json::to_vec(&manifest).unwrap(),
            SessionConfig::default(),
            super::super::WebSessionOptions {
                renderer_mode: mode,
            },
            WebRendererPolicy::Manifest,
        )
        .unwrap();
        host
    }

    fn dispatch(host: &mut WebHost, op: &str, payload: Value) {
        let batch = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "transition-test",
                op,
                payload,
            ))
            .unwrap();
        assert!(
            batch.messages.iter().any(|message| message.kind
                == container_bridge::EnvelopeKind::Response
                && message.payload["ok"] == true),
            "{batch:?}"
        );
    }

    fn start(host: &mut WebHost, route: &str) {
        host.start_session("transition-init").unwrap();
        dispatch(host, "app.lifecycle", json!({"event":"launch"}));
        dispatch(host, "page.push", json!({"path":route}));
    }

    fn snapshot(host: &WebHost) -> Value {
        serde_json::from_slice(&host.renderer_transition_state_json().unwrap()).unwrap()
    }

    fn request(state: &Value) -> Value {
        json!({"version":"1.0", "expected":{
            "sessionId":state["state"]["sessionId"],
            "pageId":state["state"]["currentPage"]["pageId"],
            "routePath":state["state"]["currentPage"]["path"],
            "rendererProfile":state["state"]["rendererProfile"],
            "inputLifetimeRevision":state["inputLifetimeRevision"],
            "presenterGeneration":state["presenterBinding"]["generation"],
            "transportBackend":state["presenterBinding"]["transportBackend"],
        }})
    }

    #[test]
    fn transition_contract_is_pure_and_requires_explicit_pre_init_manifest_negotiation() {
        let mut empty = WebHost::new();
        assert_eq!(
            serde_json::from_str::<Value>(empty.renderer_transition_contract_json()).unwrap()
                ["version"],
            "1.0"
        );
        assert!(!empty.has_session());
        assert!(empty
            .enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .is_err());
        let mut host = loaded(WebRendererMode::ExternalFrame);
        assert!(host.renderer_transition_state_json().is_err());
        assert!(host
            .enable_renderer_transitions_json(br#"{"version":"2.0"}"#)
            .is_err());
        let first = host
            .enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .unwrap();
        assert_eq!(
            host.enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
                .unwrap(),
            first
        );
        start(&mut host, "pages/skia/index");
        assert!(host
            .enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .is_err());
        assert_eq!(snapshot(&host)["presenterBinding"]["generation"], "1");
    }

    #[test]
    fn renderer_transitions_reuse_runtime_storage_timers_pages_and_lifecycle() {
        let mut host = loaded(WebRendererMode::ExternalFrame);
        host.enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .unwrap();
        start(&mut host, "pages/skia/index");
        let pointer = host.session.session().unwrap() as *const _;
        let session = host.session.session_mut().unwrap();
        session
            .app_service_mut()
            .set_storage("keep", json!({"value":42}))
            .unwrap();
        let timer = session
            .app_service_mut()
            .timers_mut()
            .schedule_timeout(500, 1000, None);
        let lifecycle = host.lifecycle_sequence().unwrap();
        dispatch(&mut host, "page.push", json!({"path":"pages/dom/index"}));
        let before = snapshot(&host);
        let body = request(&before);
        let final_value: Value = serde_json::from_slice(
            &host
                .transition_renderer_json(&serde_json::to_vec(&body).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(final_value["ok"], true);
        assert_eq!(final_value["presenterBinding"]["generation"], "2");
        assert_eq!(
            final_value["presenterBinding"]["transportBackend"],
            "browser-view"
        );
        assert_eq!(host.session.session().unwrap() as *const _, pointer);
        assert_eq!(host.lifecycle_sequence().unwrap(), lifecycle);
        let session = host.session.session().unwrap();
        assert_eq!(session.app_service().pages().len(), 2);
        assert_eq!(
            session.app_service().storage().get("keep"),
            Some(&json!({"value":42}))
        );
        assert!(session.app_service().timers().is_pending(timer));
        assert!(!session.is_browser_view_presented());
        assert!(host
            .transition_renderer_json(&serde_json::to_vec(&body).unwrap())
            .is_err());
        dispatch(&mut host, "page.pop", json!({}));
        let body = request(&snapshot(&host));
        let result: Value = serde_json::from_slice(
            &host
                .transition_renderer_json(&serde_json::to_vec(&body).unwrap())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(result["presenterBinding"]["generation"], "3");
        assert_eq!(host.session.session().unwrap() as *const _, pointer);
        assert!(host
            .session
            .session()
            .unwrap()
            .app_service()
            .timers()
            .is_pending(timer));
    }

    #[test]
    fn stale_input_wrong_binding_and_overflow_fail_before_retirement() {
        let mut host = loaded(WebRendererMode::ExternalFrame);
        host.enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .unwrap();
        start(&mut host, "pages/dom/index");
        let before = snapshot(&host);
        for key in ["inputLifetimeRevision", "presenterGeneration", "pageId"] {
            let mut body = request(&before);
            body["expected"][key] = json!("999");
            assert!(host
                .transition_renderer_json(&serde_json::to_vec(&body).unwrap())
                .is_err());
            assert_eq!(snapshot(&host), before);
        }
        host.presenter_generation = Some(u64::MAX);
        let before = snapshot(&host);
        assert!(host
            .transition_renderer_json(&serde_json::to_vec(&request(&before)).unwrap())
            .is_err());
        assert_eq!(snapshot(&host), before);
    }

    #[test]
    fn unnegotiated_and_unloaded_hosts_never_implicitly_enable_transitions() {
        let mut host = loaded(WebRendererMode::ExternalFrame);
        start(&mut host, "pages/dom/index");
        assert!(host
            .transition_renderer_json(br#"{"version":"1.0","expected":{}}"#)
            .is_err());
        assert_eq!(host.renderer_mode, WebRendererMode::ExternalFrame);
        host.unload();
        assert!(host.renderer_transition_state_json().is_err());
        assert_eq!(host.presenter_generation, None);
    }

    #[test]
    fn negotiated_bindings_never_adopt_an_unproven_retained_manual_frame() {
        let mut host = loaded(WebRendererMode::ExternalFrame);
        host.enable_renderer_transitions_json(br#"{"version":"1.0"}"#)
            .unwrap();
        start(&mut host, "pages/skia/index");
        dispatch(
            &mut host,
            "render.commit",
            json!({"frame":{
                "frameId":1,"viewport":{"x":0,"y":0,"width":10,"height":10},
                "root":{"id":"page","bounds":{"x":0,"y":0,"width":10,"height":10},
                    "opacity":1,"children":[]}
            }}),
        );
        let revision = host.render_revision().unwrap();
        let before = snapshot(&host);
        assert!(host.render_frame_json().is_err());
        assert!(host
            .acknowledge_presentation_outcome_json(revision)
            .is_err());
        assert!(host.set_render_scale(2.0).is_err());
        assert_eq!(snapshot(&host), before);
        dispatch(&mut host, "page.push", json!({"path":"pages/dom/index"}));
        let body = request(&snapshot(&host));
        host.transition_renderer_json(&serde_json::to_vec(&body).unwrap())
            .unwrap();
        dispatch(&mut host, "page.pop", json!({}));
        let body = request(&snapshot(&host));
        host.transition_renderer_json(&serde_json::to_vec(&body).unwrap())
            .unwrap();
        assert!(host.render_frame_json().is_err());
        assert!(host
            .acknowledge_presentation_outcome_json(revision)
            .is_err());
        assert!(host.set_render_scale(2.0).is_err());
    }
}

#[cfg(all(test, feature = "quickjs-native"))]
#[path = "renderer_transition_native_tests.rs"]
mod native_public_interleaving;
