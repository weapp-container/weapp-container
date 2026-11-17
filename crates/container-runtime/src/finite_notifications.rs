//! Private callback authority and native producer resources have one lifetime.
use super::*;

pub(super) const OFF_APIS: [&str; 49] = [
    "wx.offAfterPageLoad",
    "wx.offAppRouteDone",
    "wx.offBeforePageLoad",
    "wx.offCopyUrl",
    "wx.offEmbeddedMiniProgramHeightChange",
    "wx.offLazyLoadError",
    "wx.offMenuButtonBoundingClientRectWeightChange",
    "wx.offParallelStateChange",
    "wx.offUserOffTranslation",
    "wx.offUserTriggerTranslation",
    "wx.offApiCategoryChange",
    "wx.offAudioInterruptionBegin",
    "wx.offAudioInterruptionEnd",
    "wx.offKeyboardHeightChange",
    "wx.offLocalServiceDiscoveryStop",
    "wx.offLocalServiceFound",
    "wx.offLocalServiceLost",
    "wx.offLocalServiceResolveFail",
    "wx.offMemoryWarning",
    "wx.offScreenRecordingStateChanged",
    "wx.offThemeChange",
    "wx.offVoIPChatInterrupted",
    "wx.offVoIPChatMembersChanged",
    "wx.offVoIPChatSpeakersChanged",
    "wx.offVoIPChatStateChanged",
    "wx.offVoIPVideoMembersChanged",
    "wx.offBatteryInfoChange",
    "wx.offBLEPeripheralConnectionStateChanged",
    "wx.offDeviceMotionChange",
    "wx.offNetworkWeakChange",
    "object:TCPSocket.offBindWifi",
    "object:TCPSocket.offClose",
    "object:TCPSocket.offConnect",
    "object:TCPSocket.offError",
    "object:TCPSocket.offMessage",
    "object:UDPSocket.offClose",
    "object:UDPSocket.offError",
    "object:UDPSocket.offListening",
    "object:UDPSocket.offMessage",
    "object:InnerAudioContext.offCanplay",
    "object:InnerAudioContext.offEnded",
    "object:InnerAudioContext.offError",
    "object:InnerAudioContext.offPause",
    "object:InnerAudioContext.offPlay",
    "object:InnerAudioContext.offSeeked",
    "object:InnerAudioContext.offSeeking",
    "object:InnerAudioContext.offStop",
    "object:InnerAudioContext.offTimeUpdate",
    "object:InnerAudioContext.offWaiting",
];

// Existing native SDKs declare these historical off handlers beside the real
// audio producers. Accept their names as negotiation-only compatibility input;
// they must never become registered native dispatch or snapshot authority.
pub(super) const LEGACY_INNER_AUDIO_OFF_APIS: [&str; 10] = [
    "object:InnerAudioContext.offCanplay",
    "object:InnerAudioContext.offEnded",
    "object:InnerAudioContext.offError",
    "object:InnerAudioContext.offPause",
    "object:InnerAudioContext.offPlay",
    "object:InnerAudioContext.offSeeked",
    "object:InnerAudioContext.offSeeking",
    "object:InnerAudioContext.offStop",
    "object:InnerAudioContext.offTimeUpdate",
    "object:InnerAudioContext.offWaiting",
];

pub(super) fn owns_object_receiver(receiver: &str) -> bool {
    matches!(receiver, "TCPSocket" | "UDPSocket" | "InnerAudioContext")
}

pub(super) fn object_producer_receiver(name: &str) -> Option<&'static str> {
    match name {
        "object:TCPSocket.onBindWifi"
        | "object:TCPSocket.onClose"
        | "object:TCPSocket.onConnect"
        | "object:TCPSocket.onError"
        | "object:TCPSocket.onMessage" => Some("TCPSocket"),
        "object:UDPSocket.onClose"
        | "object:UDPSocket.onError"
        | "object:UDPSocket.onListening"
        | "object:UDPSocket.onMessage" => Some("UDPSocket"),
        "object:InnerAudioContext.onCanplay"
        | "object:InnerAudioContext.onEnded"
        | "object:InnerAudioContext.onError"
        | "object:InnerAudioContext.onPause"
        | "object:InnerAudioContext.onPlay"
        | "object:InnerAudioContext.onSeeked"
        | "object:InnerAudioContext.onSeeking"
        | "object:InnerAudioContext.onStop"
        | "object:InnerAudioContext.onTimeUpdate"
        | "object:InnerAudioContext.onWaiting" => Some("InnerAudioContext"),
        _ => None,
    }
}

// Ownership admission and native ingress include all private registries. The
// original ten's Partial policy is intentionally a separate predicate below.
pub(super) fn is_producer(name: &str) -> bool {
    has_partial_producer_ceiling(name)
        || object_producer_receiver(name).is_some()
        || matches!(
            name,
            "wx.onApiCategoryChange"
                | "wx.onAudioInterruptionBegin"
                | "wx.onAudioInterruptionEnd"
                | "wx.onKeyboardHeightChange"
                | "wx.onLocalServiceDiscoveryStop"
                | "wx.onLocalServiceFound"
                | "wx.onLocalServiceLost"
                | "wx.onLocalServiceResolveFail"
                | "wx.onMemoryWarning"
                | "wx.onScreenRecordingStateChanged"
                | "wx.onThemeChange"
                | "wx.onVoIPChatInterrupted"
                | "wx.onVoIPChatMembersChanged"
                | "wx.onVoIPChatSpeakersChanged"
                | "wx.onVoIPChatStateChanged"
                | "wx.onVoIPVideoMembersChanged"
                | "wx.onBatteryInfoChange"
                | "wx.onBLEPeripheralConnectionStateChanged"
                | "wx.onDeviceMotionChange"
                | "wx.onNetworkWeakChange"
        )
}

fn has_partial_producer_ceiling(name: &str) -> bool {
    matches!(
        name,
        "wx.onAfterPageLoad"
            | "wx.onAppRouteDone"
            | "wx.onBeforePageLoad"
            | "wx.onCopyUrl"
            | "wx.onEmbeddedMiniProgramHeightChange"
            | "wx.onLazyLoadError"
            | "wx.onMenuButtonBoundingClientRectWeightChange"
            | "wx.onParallelStateChange"
            | "wx.onUserOffTranslation"
            | "wx.onUserTriggerTranslation"
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Registration {
    id: String,
    pub(super) api: String,
    pub(super) object_id: Option<String>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    active: Vec<Registration>,
    cancellations: Vec<String>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn valid_prefixed_id(id: &str, prefix: &str) -> bool {
    id.strip_prefix(prefix)
        .filter(|suffix| {
            !suffix.starts_with('0') && suffix.bytes().all(|byte| byte.is_ascii_digit())
        })
        .and_then(|suffix| suffix.parse::<u64>().ok())
        .is_some_and(|id| id != 0)
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn valid_id(id: &str) -> bool {
    valid_prefixed_id(id, "finite-subscription-")
}

impl Session {
    pub(super) fn reconcile_finite_notification_object_retirements(
        &mut self,
    ) -> Result<(), BridgeError> {
        while let Some(id) = self
            .host_services
            .finite_notification_object_retirements
            .first()
            .cloned()
        {
            match self.config.engine {
                EngineKind::Quickjs => {
                    #[cfg(feature = "quickjs-native")]
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS provider unavailable",
                            )
                        })?
                        .retire_finite_notification_object(&id)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?;
                }
                EngineKind::V8 => {
                    #[cfg(feature = "v8-native")]
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .retire_finite_notification_object(&id)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?;
                }
            }
            self.host_services
                .finite_notification_object_retirements
                .remove(&id);
        }
        Ok(())
    }

    pub(super) fn finite_notification_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if self.host_services.compatibility_cleanup_apis.contains(name) {
            // Preserve the historical registered producer's exact defaults
            // and explicit denials. This set is trusted configuration only;
            // a runtime-owned off without that old declaration gains nothing.
            return self.registered_host_capability(name, provider);
        }
        // Ordinary producer authorization keeps the existing registered-host
        // resolver, including Full support and its manifest/host defaults.
        if !has_partial_producer_ceiling(name) && !OFF_APIS.contains(&name) {
            return None;
        }
        if has_partial_producer_ceiling(name) && !self.host_service_registered(name) {
            return Some(CapabilitySupport::Unsupported);
        }
        let manifest = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Unsupported);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .map_or(manifest, |host| min_support(manifest, host));
        let support = provider
            .get(name)
            .copied()
            .map_or(host, |provider| min_support(host, provider));
        Some(if has_partial_producer_ceiling(name) {
            // Native producer availability/payload/timing/plugin parity is
            // separate from complete local listener removal.
            min_support(support, CapabilitySupport::Partial)
        } else {
            support
        })
    }

    pub(super) fn dispatch_finite_notification(
        &mut self,
        api: &str,
        event: &Value,
    ) -> Result<(), BridgeError> {
        match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                self.quickjs_engine
                    .as_mut()
                    .ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "QuickJS provider unavailable")
                    })?
                    .dispatch_finite_notification(api, event)
                    .map_err(|error| {
                        engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                    })?;
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                self.v8_engine
                    .as_mut()
                    .ok_or_else(|| {
                        BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                    })?
                    .dispatch_finite_notification(api, event)
                    .map_err(|error| {
                        engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                    })?;
            }
        }
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (api, event);
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn reconcile_finite_notification_cancellations(
        &mut self,
    ) -> Result<(), BridgeError> {
        self.ensure_engine_execution_healthy()?;
        if !self.engine_provider_available() {
            return Ok(());
        }
        self.reconcile_finite_notification_object_retirements()?;
        let value = match self.config.engine {
            EngineKind::Quickjs => {
                #[cfg(feature = "quickjs-native")]
                {
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS provider unavailable",
                            )
                        })?
                        .finite_notification_snapshot()
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                json!({"active":[],"cancellations":[]})
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .finite_notification_snapshot()
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                json!({"active":[],"cancellations":[]})
            }
        };
        let snapshot: Snapshot = serde_json::from_value(value).map_err(|error| {
            BridgeError::invalid(format!("invalid finite notification snapshot: {error}"))
        })?;
        if snapshot.active.len() + snapshot.cancellations.len() > 4096 {
            return Err(BridgeError::invalid(
                "finite notification snapshot exceeds budget",
            ));
        }
        // Validate the entire replacement before changing Session authority or
        // consuming any cancellation. A failed capture retains the old owner.
        let mut active = BTreeMap::new();
        for registration in snapshot.active {
            let valid_receiver = match object_producer_receiver(&registration.api) {
                Some(_) => registration
                    .object_id
                    .as_deref()
                    .is_some_and(|id| valid_prefixed_id(id, "native-object-")),
                None => registration.object_id.is_none(),
            };
            if !valid_id(&registration.id) || !is_producer(&registration.api) || !valid_receiver {
                return Err(BridgeError::invalid(
                    "invalid finite notification registration",
                ));
            }
            let id = registration.id.clone();
            if active.insert(id, registration).is_some() {
                return Err(BridgeError::invalid(
                    "duplicate finite notification registration",
                ));
            }
        }
        let mut cancelled = BTreeSet::new();
        for id in &snapshot.cancellations {
            if !valid_id(id) || active.contains_key(id) || !cancelled.insert(id) {
                return Err(BridgeError::invalid(
                    "invalid finite notification cancellation",
                ));
            }
        }
        self.host_services.finite_notification_registrations = active;
        let mut cleanup_error = None;
        for id in &snapshot.cancellations {
            // Native resource retirement precedes guest Promise settlement.
            // A poisoned resolver must not strand the rest of a clear-all.
            if let Err(error) = self.cancel_native_subscription(id) {
                cleanup_error.get_or_insert(error);
            }
        }
        if let Some(error) = cleanup_error {
            // Do not ACK a failed sweep. Repeating native cancellation is
            // harmless; a healthy later turn can acknowledge the same prefix.
            return Err(error);
        }
        if let Some(last) = snapshot.cancellations.last() {
            match self.config.engine {
                EngineKind::Quickjs => {
                    #[cfg(feature = "quickjs-native")]
                    self.quickjs_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(
                                BridgeErrorCode::Engine,
                                "QuickJS provider unavailable",
                            )
                        })?
                        .acknowledge_finite_notification_cancellations(last)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?;
                }
                EngineKind::V8 => {
                    #[cfg(feature = "v8-native")]
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .acknowledge_finite_notification_cancellations(last)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?;
                }
            }
        }
        Ok(())
    }
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
mod tests {
    use super::valid_id;

    #[test]
    fn registration_ids_require_canonical_nonzero_ascii_u64() {
        for suffix in ["1", "9007199254740993", "18446744073709551615"] {
            assert!(valid_id(&format!("finite-subscription-{suffix}")));
        }
        for suffix in [
            "",
            "0",
            "01",
            "+1",
            "-1",
            "１",
            "1 ",
            "18446744073709551616",
        ] {
            assert!(!valid_id(&format!("finite-subscription-{suffix}")));
        }
        assert!(!valid_id("native-subscription-1"));
    }
}
