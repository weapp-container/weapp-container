//! Explicit native API delegation. Configuration is supplied by the embedding
//! host before any application code executes; guest payloads never supply trust.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

/// JSON numbers cannot carry every u64 across JavaScript SDKs. Canonical output
/// uses decimal strings; legacy inputs are accepted only while exactly safe.
pub mod host_wire_u64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        parse(value).map_err(serde::de::Error::custom)
    }
    fn parse(value: serde_json::Value) -> Result<u64, &'static str> {
        match value {
            serde_json::Value::String(value)
                if !value.is_empty()
                    && (value == "0" || !value.starts_with('0'))
                    && value.bytes().all(|byte| byte.is_ascii_digit()) =>
            {
                value
                    .parse()
                    .map_err(|_| "u64 decimal string is out of range")
            }
            serde_json::Value::Number(value) => value
                .as_u64()
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or("legacy u64 number must be an exactly safe nonnegative integer"),
            _ => Err("u64 must be a canonical decimal string or safe integer"),
        }
    }
    pub mod option {
        use super::*;
        pub fn serialize<S: Serializer>(
            value: &Option<u64>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            match value {
                Some(value) => serializer.serialize_some(&value.to_string()),
                None => serializer.serialize_none(),
            }
        }
        pub fn deserialize<'de, D: Deserializer<'de>>(
            deserializer: D,
        ) -> Result<Option<u64>, D::Error> {
            Option::<serde_json::Value>::deserialize(deserializer)?
                .map(super::parse)
                .transpose()
                .map_err(serde::de::Error::custom)
        }
    }
}

/// Decode bounded binary bytes or chunk indices from native numeric transports.
/// Exact JSON `1.0` is an integer value; strings, fractions and unsafe ranges
/// remain invalid. Do not use this for identity/epoch/sequence wire fields,
/// which must keep their existing canonical-string parsing.
pub fn host_wire_bounded_integer(value: &Value, maximum: usize) -> Option<usize> {
    if maximum as u128 > 9_007_199_254_740_991_u128 {
        return None;
    }
    value
        .as_f64()
        .filter(|number| {
            number.is_finite()
                && number.fract() == 0.0
                && *number >= 0.0
                && *number <= maximum as f64
        })
        .map(|number| number as usize)
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrustedApplication {
    pub host_app_id: String,
    pub tenant_id: String,
    pub publisher_id: String,
    pub app_id: String,
    pub environment: String,
    pub version: String,
    pub pack_root: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostAccount {
    pub principal_id: Option<String>,
    #[serde(with = "host_wire_u64")]
    pub epoch: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostServicesConfig {
    pub application: TrustedApplication,
    pub account: HostAccount,
    #[serde(default)]
    pub apis: Vec<String>,
    #[serde(default)]
    pub sync_values: BTreeMap<String, Value>,
}

/// This context is minted from host configuration and the actual pending call.
/// It is never deserialized from application options.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostApiCallContext {
    pub application: TrustedApplication,
    pub account: HostAccount,
    pub session_id: String,
    pub call_id: String,
    pub api: String,
    #[serde(default, with = "host_wire_u64::option")]
    pub deadline_ns: Option<u64>,
    pub cancel_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub component_target: Option<HostApiComponentTarget>,
}

/// Resolved by the runtime from the accepted component ownership graph.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostApiComponentTarget {
    #[serde(with = "host_wire_u64")]
    pub page_id: u64,
    pub node_id: String,
    pub owner_scope_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostApiFailure {
    pub code: ProviderErrorCode,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
    /// Original API fields, including numeric errCode and exact errMsg.
    #[serde(default)]
    pub details: BTreeMap<String, Value>,
}

impl From<ProviderError> for HostApiFailure {
    fn from(error: ProviderError) -> Self {
        Self {
            code: error.code,
            message: error.message,
            retryable: error.retryable,
            details: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApiDescriptor {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub owner: String,
    #[serde(default)]
    pub permission: Option<String>,
    #[serde(default)]
    pub factory: Option<String>,
    #[serde(default)]
    pub object_type: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub counterpart: Option<String>,
    #[serde(flatten)]
    pub metadata: BTreeMap<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    apis: Vec<HostApiDescriptor>,
}

pub fn host_api_catalog() -> &'static [HostApiDescriptor] {
    static CATALOG: OnceLock<Vec<HostApiDescriptor>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        let catalog: Catalog = serde_json::from_str(include_str!("host-api-catalog.json"))
            .expect("checked-in host API catalog must be valid");
        assert_eq!(catalog.schema_version, 1, "unsupported host API catalog");
        catalog.apis
    })
}

pub fn host_api_descriptor(name: &str) -> Option<&'static HostApiDescriptor> {
    host_api_catalog()
        .iter()
        .find(|descriptor| descriptor.name == name)
}

pub(super) fn runtime_owned(name: &str) -> bool {
    finite_notifications::OFF_APIS.contains(&name)
        || route_transaction::APIS.contains(&name)
        || is_storage_api(name)
        || is_timer_api(name)
        || is_navigation_api(name)
        || is_selector_query_api(name)
        || is_observer_api(name)
        || matches!(
            name,
            "wx.nextTick"
                | "wx.requestIdleCallback"
                | "wx.cancelIdleCallback"
                | "wx.onError"
                | "wx.offError"
                | "wx.onPageNotFound"
                | "wx.offPageNotFound"
                | "wx.onUnhandledRejection"
                | "wx.offUnhandledRejection"
                | "wx.getLogManager"
                | "wx.onWindowResize"
                | "wx.offWindowResize"
                | "wx.onHostLayoutChange"
                | "wx.offHostLayoutChange"
                | "wx.onAppShow"
                | "wx.offAppShow"
                | "wx.onAppHide"
                | "wx.offAppHide"
                | "wx.onBeforePageUnload"
                | "wx.offBeforePageUnload"
                | "wx.onAfterPageUnload"
                | "wx.offAfterPageUnload"
                | "wx.canIUse"
                | "wx.getRandomValues"
                | "wx.createBufferURL"
                | "wx.revokeBufferURL"
                | "wx.canvas.draw"
                | "getCurrentPages"
                | "wx.getLaunchOptionsSync"
                | "wx.getEnterOptionsSync"
        )
}

#[derive(Default)]
pub(super) struct HostServices {
    pub(super) config: Option<HostServicesConfig>,
    sync_binding: Option<Arc<sync_files::SyncBinding>>,
    pub(super) registered: BTreeSet<String>,
    // Negotiation-only old SDK cleanup declarations. Never native handlers.
    pub(super) compatibility_cleanup_apis: BTreeSet<String>,
    subscriptions: BTreeMap<String, NativeSubscription>,
    pub(super) finite_notification_registrations:
        BTreeMap<String, finite_notifications::Registration>,
    pub(super) finite_notification_object_retirements: BTreeSet<String>,
    objects: BTreeMap<String, NativeObject>,
    component_calls: BTreeMap<String, HostApiComponentTarget>,
    operations: BTreeMap<String, NativeOperation>,
    retained_calls: BTreeSet<String>,
    snapshots: Arc<Mutex<BTreeMap<String, Value>>>,
    binaries: BTreeMap<String, HostBinary>,
    binary_bytes: usize,
    component_sequences: BTreeMap<(u64, String, String), u64>,
    phone_buttons: BTreeSet<(u64, String)>,
    component_presentation: RefCell<Vec<HostComponentSnapshot>>,
    component_frame_sequences: BTreeMap<(u64, String), u64>,
    component_repaint_revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostComponentEvent {
    pub session_id: String,
    #[serde(with = "host_wire_u64")]
    pub account_epoch: u64,
    pub node_id: String,
    pub event: String,
    #[serde(with = "host_wire_u64")]
    pub sequence: u64,
    pub value: Value,
}

/// Bounded straight, tightly packed RGBA8 pixels for a trusted media slot.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostComponentFrame {
    pub session_id: String,
    #[serde(with = "host_wire_u64")]
    pub account_epoch: u64,
    #[serde(with = "host_wire_u64")]
    pub page_id: u64,
    pub node_id: String,
    #[serde(with = "host_wire_u64")]
    pub sequence: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub pixels: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostComponentSnapshot {
    pub session_id: String,
    #[serde(with = "host_wire_u64")]
    pub account_epoch: u64,
    #[serde(with = "host_wire_u64")]
    pub page_id: u64,
    #[serde(with = "host_wire_u64")]
    pub revision: u64,
    pub node_id: String,
    pub tag: String,
    pub attributes: BTreeMap<String, String>,
    pub owner_scope_id: Option<String>,
    pub local_bounds: Rect,
    pub bounds: Rect,
    pub transform: Transform2D,
    pub clips: Vec<container_render_skia::NativeComponentClip>,
    pub paint_order: usize,
    pub z_index: i32,
    pub opacity: f32,
    pub visible: bool,
}

#[derive(Debug)]
pub(super) struct NativeComponentTarget {
    pub(super) page_id: u64,
    pub(super) node_id: String,
    pub(super) tag: String,
    pub(super) attributes: BTreeMap<String, String>,
    pub(super) route: NativeComponentRoute,
}

#[derive(Debug)]
pub(super) enum NativeComponentRoute {
    Raster {
        route: TouchRoute,
    },
    Browser {
        key: container_ir::PresentationKey,
        receiver: Option<Value>,
        event: Value,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostBinaryHandle {
    pub id: String,
    pub byte_length: usize,
    pub session_id: String,
    #[serde(with = "host_wire_u64")]
    pub account_epoch: u64,
}

struct HostBinary {
    bytes: Vec<u8>,
    references: u16,
}
static NEXT_BINARY_ID: AtomicU64 = AtomicU64::new(1);

struct NativeSubscription {
    api: String,
    object_id: Option<String>,
    sequence: u64,
    call_id: Option<String>,
}

struct NativeObject {
    object_type: String,
    parent_id: Option<String>,
    call_id: String,
    component_target: Option<HostApiComponentTarget>,
}

enum NativeOperation {
    Create {
        object_id: String,
        terminal_task: bool,
    },
    Subscribe {
        subscription_id: String,
    },
    Unsubscribe {
        creator_call_id: String,
    },
    Destroy {
        object_id: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostApiEvent {
    pub session_id: String,
    #[serde(with = "host_wire_u64")]
    pub account_epoch: u64,
    pub subscription_id: String,
    #[serde(with = "host_wire_u64")]
    pub sequence: u64,
    pub value: Value,
    #[serde(default)]
    pub object_id: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
}

struct DelegatingProvider {
    fallback: Box<dyn HostApiProvider>,
    registered: BTreeSet<String>,
    sync_values: Arc<Mutex<BTreeMap<String, Value>>>,
    host_app_id: String,
}

pub(super) fn observed_host_result(
    name: &str,
    value: Value,
    host: &HostMetadata,
    host_app_id: Option<&str>,
) -> Result<Value, ProviderError> {
    let mut result =
        merge_host_geometry(name, Some(value), host)?.ok_or_else(|| ProviderError {
            code: ProviderErrorCode::Unsupported,
            message: format!("accepted host snapshot is unavailable: {name}"),
            retryable: false,
        })?;
    if let Some(host_app_id) = host_app_id.filter(|_| {
        matches!(
            name,
            "wx.getAppBaseInfo"
                | "wx.getSystemInfo"
                | "wx.getSystemInfoAsync"
                | "wx.getSystemInfoSync"
        )
    }) {
        let object = result
            .as_object_mut()
            .ok_or_else(|| ProviderError::invalid("host system snapshot must be an object"))?;
        object.insert("host".into(), json!({"appId":host_app_id}));
    }
    Ok(result)
}

impl DelegatingProvider {
    fn overlay_capabilities(
        &self,
        mut result: BTreeMap<String, CapabilitySupport>,
    ) -> BTreeMap<String, CapabilitySupport> {
        let snapshots = self.sync_values.lock().expect("host snapshot lock");
        // A missing native implementation is unavailable, even when a pack's
        // broad compiler inventory describes that API as partially supported.
        for descriptor in host_api_catalog() {
            if descriptor.owner == "runtime" || runtime_owned(&descriptor.name) {
                continue;
            }
            let support = if snapshots.contains_key(&descriptor.name) {
                CapabilitySupport::Full
            } else if self.registered.contains(&descriptor.name)
                && descriptor.kind != "syncSnapshot"
            {
                CapabilitySupport::Partial
            } else {
                if self.fallback.name() == "sandbox" {
                    CapabilitySupport::Unsupported
                } else {
                    result
                        .get(&descriptor.name)
                        .copied()
                        .unwrap_or(CapabilitySupport::Unsupported)
                }
            };
            result.insert(descriptor.name.clone(), support);
        }
        for name in snapshots.keys() {
            result.insert(name.clone(), CapabilitySupport::Full);
        }
        for name in ["wx.getSystemInfo", "wx.getSystemInfoAsync"] {
            if snapshots.contains_key("wx.getSystemInfoSync") && !self.registered.contains(name) {
                result.insert(name.into(), CapabilitySupport::Partial);
            }
        }
        result
    }

    fn snapshot(&self, name: &str) -> Option<Value> {
        let snapshots = self.sync_values.lock().expect("host snapshot lock");
        snapshots
            .get(name)
            .or_else(|| {
                (matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync")
                    && !self.registered.contains(name))
                .then(|| snapshots.get("wx.getSystemInfoSync"))
                .flatten()
            })
            .cloned()
    }

    fn observed_result(
        &self,
        name: &str,
        value: Value,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        observed_host_result(name, value, &context.host, Some(&self.host_app_id))
    }
}

impl HostApiProvider for DelegatingProvider {
    fn name(&self) -> &'static str {
        "registered-host-services"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        self.overlay_capabilities(self.fallback.capabilities())
    }

    fn capabilities_for_host(&self, host: &HostMetadata) -> BTreeMap<String, CapabilitySupport> {
        let fallback = self.fallback.capabilities_for_host(host);
        let mut result = self.overlay_capabilities(fallback.clone());
        for name in crate::HOST_GEOMETRY_APIS {
            if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync")
                && self.registered.contains(name)
            {
                // A real asynchronous handler can obtain OS fields even while
                // the first complete window observation is still pending.
                continue;
            }
            let snapshot = self.snapshot(name);
            let supplied = snapshot.is_some();
            let support = match merge_host_geometry(name, snapshot, host) {
                Ok(Some(_)) => CapabilitySupport::Partial,
                Ok(None) if !supplied && self.fallback.name() != "sandbox" => fallback
                    .get(name)
                    .copied()
                    .unwrap_or(CapabilitySupport::Unsupported),
                _ => CapabilitySupport::Unsupported,
            };
            result.insert(name.into(), support);
        }
        result
    }

    fn sync_file_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.fallback.sync_file_snapshot()
    }
    fn supports_sync_filesystem(&self) -> bool {
        self.fallback.supports_sync_filesystem()
    }
    fn cancel(&mut self, token: &str) -> bool {
        self.fallback.cancel(token)
    }
    fn update_network_type(&mut self, value: NetworkType) -> Result<(), ProviderError> {
        self.fallback.update_network_type(value)
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        if let Some(value) = self.snapshot(name) {
            return self.observed_result(name, value, context);
        }
        if self.registered.contains(name) {
            return Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("{name} requires asynchronous native completion"),
                retryable: false,
            });
        }
        if host_api_descriptor(name).is_some_and(|descriptor| descriptor.owner == "host")
            && (self.fallback.name() == "sandbox"
                || self
                    .fallback
                    .capabilities_for_host(&context.host)
                    .get(name)
                    .copied()
                    .unwrap_or(CapabilitySupport::Unsupported)
                    == CapabilitySupport::Unsupported)
        {
            // Accepted core geometry is a host implementation in its own right.
            // Do not enter the sandbox to obtain invented device/system fields.
            if let Some(value) = project_host_geometry(name, &context.host)? {
                return self.observed_result(name, value, context);
            }
            return Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("{name} has no registered native implementation"),
                retryable: false,
            });
        }
        let value = self.fallback.call(name, payload, context)?;
        self.observed_result(name, value, context)
    }

    fn start_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> ProviderStart {
        let snapshot = self.snapshot(name).is_some();
        if self.registered.contains(name) && !snapshot {
            return ProviderStart::Pending;
        }
        if snapshot {
            return ProviderStart::Ready(self.call(name, payload, context));
        }
        if host_api_descriptor(name).is_some_and(|descriptor| descriptor.owner == "host")
            && (self.fallback.name() == "sandbox"
                || self
                    .fallback
                    .capabilities_for_host(&context.host)
                    .get(name)
                    .copied()
                    .unwrap_or(CapabilitySupport::Unsupported)
                    == CapabilitySupport::Unsupported)
        {
            return ProviderStart::Ready(self.call(name, payload, context));
        }
        match self.fallback.start_call(name, payload, context) {
            ProviderStart::Ready(Ok(value)) => {
                ProviderStart::Ready(self.observed_result(name, value, context))
            }
            other => other,
        }
    }
}

struct NormalizedHostServices {
    config: HostServicesConfig,
    registered: BTreeSet<String>,
    compatibility_cleanup_apis: BTreeSet<String>,
}

pub fn validate_host_services_config(config: &HostServicesConfig) -> Result<(), BridgeError> {
    normalize_host_services_config(config.clone()).map(|_| ())
}

fn normalize_host_services_config(
    mut config: HostServicesConfig,
) -> Result<NormalizedHostServices, BridgeError> {
    for value in [
        &config.application.host_app_id,
        &config.application.tenant_id,
        &config.application.publisher_id,
        &config.application.app_id,
    ] {
        if value.trim().is_empty() || value.len() > 512 {
            return Err(BridgeError::invalid(
                "trusted application identity must be nonempty and bounded",
            ));
        }
    }
    if !matches!(
        config.application.environment.as_str(),
        "develop" | "trial" | "release"
    ) || (!config.application.pack_root.is_empty()
        && (config.application.pack_root.len() != 64
            || !config
                .application
                .pack_root
                .bytes()
                .all(|c| c.is_ascii_hexdigit())))
        || config.application.version.len() > 512
        || config
            .account
            .principal_id
            .as_ref()
            .is_some_and(|id| id.trim().is_empty() || id.len() > 512)
    {
        return Err(BridgeError::invalid(
            "invalid trusted application or account identity",
        ));
    }
    if config.apis.len() > 16384 || config.sync_values.len() > 4096 {
        return Err(BridgeError::invalid("native API registry exceeds limits"));
    }
    let mut registered = BTreeSet::new();
    let mut compatibility_cleanup_apis = BTreeSet::new();
    for name in &config.apis {
        let descriptor = host_api_descriptor(name)
            .ok_or_else(|| BridgeError::invalid(format!("unknown native API {name}")))?;
        if descriptor.metadata.get("baseline").and_then(Value::as_str)
            == Some("newer-than-baseline")
        {
            return Err(BridgeError::invalid(format!(
                "{name} is newer than the pinned compatibility baseline"
            )));
        }
        if finite_notifications::LEGACY_INNER_AUDIO_OFF_APIS.contains(&name.as_str()) {
            if !compatibility_cleanup_apis.insert(name.clone()) {
                return Err(BridgeError::invalid(format!("duplicate native API {name}")));
            }
            continue;
        }
        if descriptor.owner == "runtime"
            && descriptor.metadata.get("component") != Some(&Value::Bool(true))
            || runtime_owned(name)
            || (descriptor.kind == "syncLocal"
                && descriptor.metadata.get("property") != Some(&Value::Bool(true))
                && !sync_files::is_sync_filesystem(name))
        {
            return Err(BridgeError::invalid(format!(
                "{name} is owned by the runtime"
            )));
        }
        if !registered.insert(name.clone()) {
            return Err(BridgeError::invalid(format!("duplicate native API {name}")));
        }
    }
    // Package identity comes from the trusted installation, never pack JS.
    let account_api = "wx.getAccountInfoSync".to_owned();
    if host_api_descriptor(&account_api).is_some() {
        registered.insert(account_api.clone());
        config.sync_values.insert(
            account_api,
            json!({"miniProgram": {
            "appId": config.application.app_id, "envVersion": config.application.environment,
            "version": config.application.version }, "plugin": {}}),
        );
    }
    for (name, value) in &config.sync_values {
        let descriptor = host_api_descriptor(name)
            .ok_or_else(|| BridgeError::invalid(format!("unknown snapshot API {name}")))?;
        if (descriptor.kind != "syncSnapshot" && name != "wx.getAccountInfoSync")
            || runtime_owned(name)
            || descriptor.metadata.get("baseline").and_then(Value::as_str)
                == Some("newer-than-baseline")
        {
            return Err(BridgeError::invalid(format!(
                "{name} is not a registered synchronous snapshot"
            )));
        }
        registered.insert(name.clone());
        if serde_json::to_vec(value)
            .map_err(|e| BridgeError::invalid(e.to_string()))?
            .len()
            > 1024 * 1024
        {
            return Err(BridgeError::invalid("native snapshot exceeds byte budget"));
        }
    }
    for name in &registered {
        if host_api_descriptor(name).is_some_and(|descriptor| descriptor.kind == "syncSnapshot")
            && !config.sync_values.contains_key(name)
        {
            return Err(BridgeError::invalid(format!(
                "{name} requires an installed synchronous snapshot"
            )));
        }
    }
    config.apis = registered.iter().cloned().collect();
    Ok(NormalizedHostServices {
        config,
        registered,
        compatibility_cleanup_apis,
    })
}

impl Session {
    fn host_components_in_background(&self) -> bool {
        matches!(
            self.app_service.lifecycle().state(),
            container_core::LifecycleState::Background | container_core::LifecycleState::Destroyed
        )
    }

    pub(super) fn suspend_host_components(&mut self) {
        self.host_services
            .component_presentation
            .borrow_mut()
            .clear();
        self.host_services.component_repaint_revision = None;
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.clear_component_frames();
        }
    }

    /// One read-only native-layer batch for the accepted, presented frame.
    /// A pending frame retains the last presented mounts. Clip masks and paint
    /// order come from the renderer's actual paint plan; unload/revoke clears.
    pub fn host_component_snapshots(&self) -> Vec<HostComponentSnapshot> {
        if self.host_calls.is_closed()
            || self.browser_route_active()
            || self.host_components_in_background()
        {
            self.host_services
                .component_presentation
                .borrow_mut()
                .clear();
            return Vec::new();
        }
        let Some(config) = self.host_services.config.as_ref() else {
            return Vec::new();
        };
        let Some(page) = self.app_service.pages().current() else {
            self.host_services
                .component_presentation
                .borrow_mut()
                .clear();
            return Vec::new();
        };
        if !self.is_current_frame_presented() {
            let mut presented = self.host_services.component_presentation.borrow_mut();
            presented.retain(|node| {
                node.page_id == page.id.0 && node.account_epoch == config.account.epoch
            });
            return presented.clone();
        }
        let Some(frame) = self.skia_backend.renderer.last_frame() else {
            return Vec::new();
        };
        let snapshots = frame
            .native_component_presentations()
            .into_iter()
            .filter_map(|entry| {
                let tag = entry.node.tag.as_deref()?;
                let capability = if tag == "button" {
                    "component:button.open-type.getPhoneNumber".to_owned()
                } else {
                    format!("component:{tag}")
                };
                if !self.host_services.registered.contains(&capability)
                    || self.effective_capability(&capability) == CapabilitySupport::Unsupported
                {
                    return None;
                }
                Some(HostComponentSnapshot {
                    session_id: self.config.session_id.clone(),
                    account_epoch: config.account.epoch,
                    page_id: page.id.0,
                    revision: self.render_revision(),
                    node_id: entry
                        .node
                        .event_identity
                        .as_ref()
                        .unwrap_or(&entry.node.id)
                        .clone(),
                    tag: tag.into(),
                    attributes: entry.node.attributes.clone(),
                    owner_scope_id: entry.node.event_owner_scope_id.clone(),
                    local_bounds: entry.node.bounds,
                    bounds: entry.world_bounds,
                    transform: entry.transform,
                    clips: entry.clips,
                    paint_order: entry.paint_order,
                    z_index: entry
                        .node
                        .style
                        .and_then(|style| style.z_index)
                        .unwrap_or(entry.node.z_index),
                    opacity: entry.opacity,
                    visible: entry.visible,
                })
            })
            .collect::<Vec<_>>();
        *self.host_services.component_presentation.borrow_mut() = snapshots.clone();
        snapshots
    }

    /// The exact packaged source of a currently accepted native component.
    /// A component cannot fetch arbitrary package blobs by knowing their hash.
    /// Relative sources retain their declaration origin, including slot content.
    pub fn host_component_resource(
        &self,
        session_id: &str,
        account_epoch: u64,
        page_id: u64,
        node_id: &str,
    ) -> Result<&[u8], BridgeError> {
        let stale = || {
            BridgeError::new(
                BridgeErrorCode::Cancelled,
                "native component resource has no accepted presentation",
            )
        };
        if self.host_calls.is_closed()
            || self.browser_route_active()
            || self.host_components_in_background()
            || session_id != self.config.session_id
            || !self
                .host_services
                .config
                .as_ref()
                .is_some_and(|config| config.account.epoch == account_epoch)
            || (!self.is_current_frame_presented()
                && self.host_services.component_repaint_revision != Some(self.render_revision()))
        {
            return Err(stale());
        }
        let snapshot = self
            .host_component_snapshots()
            .into_iter()
            .find(|node| node.page_id == page_id && node.node_id == node_id && node.visible)
            .ok_or_else(stale)?;
        if !matches!(
            snapshot.tag.as_str(),
            "video" | "audio" | "live-player" | "live-pusher"
        ) {
            return Err(BridgeError::invalid(
                "component has no packaged media source",
            ));
        }
        let document = self
            .accepted_view_document
            .as_ref()
            .filter(|document| document.session_id == session_id && document.page_id == page_id)
            .ok_or_else(stale)?;
        let mut pending: Vec<_> = document.nodes.iter().collect();
        let mut declaration = None;
        while let Some(node) = pending.pop() {
            if let container_ir::ViewNode::Element {
                tag,
                attrs,
                ownership,
                children,
                ..
            } = node
            {
                if node.occurrence_id() == node_id
                    && tag == &snapshot.tag
                    && attrs.get("src") == snapshot.attributes.get("src")
                    && ownership.event_owner == snapshot.owner_scope_id
                {
                    declaration = Some((ownership.document_id.as_str(), attrs.get("src")));
                    break;
                }
                pending.extend(children);
            }
        }
        let (origin, Some(source)) = declaration.ok_or_else(stale)? else {
            return Err(BridgeError::invalid(
                "component has no packaged media source",
            ));
        };
        let path = super::images::resolve_path(origin, source)?;
        let asset = self
            .manifest
            .assets
            .iter()
            .find(|asset| asset.path == path)
            .ok_or_else(|| {
                BridgeError::invalid("component source is not a declared package asset")
            })?;
        let bytes = lookup_render_blob(&self.render_blobs, &format!("sha256:{}", asset.sha256))?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(BridgeError::invalid(
                "packaged component media exceeds the 16 MiB decoder budget",
            ));
        }
        if u64::try_from(bytes.len()).ok() != Some(asset.size)
            || container_ir::hex_digest(bytes) != asset.sha256
        {
            return Err(BridgeError::invalid(
                "component source size or SHA-256 mismatch",
            ));
        }
        Ok(bytes)
    }

    /// Pure pixel repaint: carries accepted layout/input provenance to a new
    /// paint revision. GPU hosts still owe an actual presentation receipt.
    pub fn submit_host_component_frame(
        &mut self,
        input: HostComponentFrame,
    ) -> Result<bool, BridgeError> {
        if self.host_calls.is_closed()
            || self.browser_route_active()
            || self.host_components_in_background()
        {
            return Ok(false);
        }
        let Some(config) = self.host_services.config.as_ref() else {
            return Ok(false);
        };
        let Some(page) = self.app_service.pages().current() else {
            return Ok(false);
        };
        if input.session_id != self.config.session_id
            || input.account_epoch != config.account.epoch
            || input.page_id != page.id.0
        {
            return Ok(false);
        }
        if input.format != "rgba8"
            || input.width == 0
            || input.height == 0
            || input.width > 1024
            || input.height > 1024
            || input.pixels.len() > 1024 * 1024
            || (input.width as usize)
                .checked_mul(input.height as usize)
                .and_then(|size| size.checked_mul(4))
                != Some(input.pixels.len())
        {
            return Err(BridgeError::invalid("native component frame must be tightly packed RGBA8 within one MiB and 1024 dimensions"));
        }
        let key = (input.page_id, input.node_id.clone());
        if input.sequence == 0
            || self
                .host_services
                .component_frame_sequences
                .get(&key)
                .is_some_and(|sequence| input.sequence <= *sequence)
        {
            return Ok(false);
        }
        if !self.is_current_frame_presented()
            && self.host_services.component_repaint_revision != Some(self.render_revision())
        {
            return Ok(false);
        }
        let Some(frame) = self.skia_backend.renderer.last_frame() else {
            return Ok(false);
        };
        let Some(target) = frame
            .native_component_presentations()
            .into_iter()
            .find(|entry| {
                entry
                    .node
                    .event_identity
                    .as_deref()
                    .unwrap_or(&entry.node.id)
                    == input.node_id
            })
        else {
            return Ok(false);
        };
        if !target.visible {
            return Ok(false);
        }
        let Some(tag) = target
            .node
            .tag
            .as_deref()
            .filter(|tag| matches!(*tag, "camera" | "video" | "live-player" | "live-pusher"))
        else {
            return Ok(false);
        };
        let capability = format!("component:{tag}");
        if !self.host_services.registered.contains(&capability)
            || self.effective_capability(&capability) == CapabilitySupport::Unsupported
        {
            return Ok(false);
        }
        let authority = self.current_skia_frame_authority().cloned();
        if self.skia_frame_authority_required() && authority.is_none() {
            return Ok(false);
        }
        let provenance = self.last_frame_input(self.render_revision()).cloned();
        let frame_id = frame.frame_id;
        let page_id = page.id;
        let image = container_render_skia::ImageResource {
            width: input.width,
            height: input.height,
            pixels: input.pixels,
        };
        self.skia_backend
            .renderer
            .ensure_mut()
            .update_component_frame(&input.node_id, image)
            .map_err(render_bridge_error)?;
        self.record_last_frame_input(provenance);
        self.carry_retained_skia_frame_authority(authority);
        self.host_services
            .component_frame_sequences
            .insert(key, input.sequence);
        self.host_services.component_repaint_revision = Some(self.render_revision());
        self.observer_frame_page = Some(page_id);
        self.suspend_dev_raster_presentation();
        if self.skia_backend.renderer.page_render_mode()
            != container_render_skia::PageRenderMode::Raster
            || self.dev_raster_presentation_required()
        {
            self.observer_frame_valid = false;
            self.pending_presentation = Some((Some(page_id), frame_id, false));
        } else {
            self.presented_revision = Some(self.render_revision());
        }
        Ok(true)
    }

    pub(super) fn release_component_frames(&mut self) {
        self.host_services.component_frame_sequences.clear();
        self.host_services.component_repaint_revision = None;
        if let Some(renderer) = self.skia_backend.renderer.peek_mut() {
            renderer.clear_component_frames();
        }
    }

    fn resolve_host_component_target(
        &self,
        node_id: &str,
        event: &str,
    ) -> Result<NativeComponentTarget, BridgeError> {
        if self.browser_route_active() {
            return self.resolve_browser_host_component(node_id, event);
        }
        if !self.is_current_frame_presented() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "native component has no current presentation",
            ));
        }
        let frame =
            self.skia_backend.renderer.last_frame().ok_or_else(|| {
                BridgeError::invalid("native component requires a committed frame")
            })?;
        let path = find_render_path(&frame.root, node_id)
            .ok_or_else(|| BridgeError::invalid("unknown native component identity"))?;
        let node = path.last().expect("component path target");
        Ok(NativeComponentTarget {
            page_id: self
                .app_service
                .pages()
                .current()
                .ok_or_else(|| BridgeError::invalid("native component requires an active page"))?
                .id
                .0,
            node_id: node_id.to_owned(),
            tag: node.tag.clone().unwrap_or_default(),
            attributes: node.attributes.clone(),
            route: NativeComponentRoute::Raster {
                route: TouchRoute {
                    page: self.app_service.pages().current().map(|page| page.id),
                    nodes: path.into_iter().map(TouchRouteNode::from_render).collect(),
                },
            },
        })
    }

    fn deliver_host_component_target(
        &mut self,
        target: NativeComponentTarget,
        event: &str,
        detail: Value,
    ) -> Result<(), BridgeError> {
        match target.route {
            NativeComponentRoute::Raster { route } => {
                if !self.is_current_frame_presented() || !self.touch_route_valid(&route) {
                    return Ok(());
                }
                if self.wxml_event_binding(Some(&route), &target.node_id, event, false)
                    != self.wxml_event_binding(None, &target.node_id, event, false)
                {
                    return Ok(());
                }
                let value = json!({"type":event,"target":target.node_id,"path":route.nodes.iter().map(|node|&node.identity).collect::<Vec<_>>(),
                    "pageId":target.page_id,"detail":detail,"bubbles":false,"capture":false});
                self.dispatch_view_event(value, Some(&route))?;
                self.view.record_event_batch(1);
            }
            NativeComponentRoute::Browser {
                key,
                receiver,
                event: mut value,
            } => {
                value["detail"] = detail.clone();
                if let Some(dispatches) = value["dispatches"].as_array_mut() {
                    for dispatch in dispatches {
                        dispatch["detail"] = detail.clone();
                    }
                }
                self.deliver_browser_host_component(&key, receiver.as_ref(), value)?;
            }
        }
        Ok(())
    }

    /// The embedding UI calls this from a real button gesture. The runtime
    /// resolves the current declaration; guest-supplied handlers cannot route
    /// phone authorization or provide the trusted application/account context.
    pub fn authorize_phone_button(&mut self, node_id: &str) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.ensure_initialized()?;
            let target = session.resolve_host_component_target(node_id, "getphonenumber")?;
            if target.tag != "button" || target.attributes.get("open-type").map(String::as_str) != Some("getPhoneNumber")
                || native_boolean_attribute(&target.attributes, "disabled") {
                return Err(BridgeError::invalid("phone authorization requires an enabled getPhoneNumber button"));
            }
            if !session.host_services.registered.contains("component:button.open-type.getPhoneNumber")
                || session.effective_capability("component:button.open-type.getPhoneNumber") == CapabilitySupport::Unsupported {
                return Err(BridgeError::new(BridgeErrorCode::UnsupportedCapability, "native phone button is unavailable"));
            }
            let api = "weappContainer.identity.authorizePhone";
            if !session.host_service_registered(api) || session.effective_capability(api) == CapabilitySupport::Unsupported {
                return Err(BridgeError::new(BridgeErrorCode::UnsupportedCapability, "native phone authorization is unavailable"));
            }
            let identity = (target.page_id, target.node_id.clone());
            if session.host_services.phone_buttons.contains(&identity) { return Err(BridgeError::invalid("phone authorization is already pending for this button")); }
            let payload = json!({"componentId":target.node_id,"pageId":target.page_id,"openType":"getPhoneNumber"});
            let context = session.provider_context(payload.as_object().expect("component payload"), 60_000)?;
            session.queue_host_call(api, payload, context, async_host::CallTargetKind::PhoneButton { target })?;
            session.host_services.phone_buttons.insert(identity);
            Ok(BridgeBatch::new(vec![]))
        })
    }

    pub(super) fn maybe_authorize_phone_tap(&mut self, node_id: &str) -> Result<(), BridgeError> {
        if !self.host_service_registered("weappContainer.identity.authorizePhone") {
            return Ok(());
        }
        let mut target = match self.resolve_host_component_target(node_id, "getphonenumber") {
            Ok(target) => target,
            Err(_) => return Ok(()),
        };
        if let NativeComponentRoute::Raster { route } = &target.route {
            if let Some(button) = route.nodes.iter().rev().find(|node| {
                node.tag.as_deref() == Some("button")
                    && node.attributes.get("open-type").map(String::as_str)
                        == Some("getPhoneNumber")
            }) {
                target = self.resolve_host_component_target(&button.identity, "getphonenumber")?;
            }
        }
        if target.tag != "button"
            || target.attributes.get("open-type").map(String::as_str) != Some("getPhoneNumber")
            || native_boolean_attribute(&target.attributes, "disabled")
            || self
                .host_services
                .phone_buttons
                .contains(&(target.page_id, target.node_id.clone()))
        {
            return Ok(());
        }
        self.authorize_phone_button(&target.node_id).map(|_| ())
    }

    pub(super) fn host_services_forget_phone_button(&mut self, page_id: u64, node_id: &str) {
        self.host_services
            .phone_buttons
            .remove(&(page_id, node_id.to_owned()));
    }

    pub(super) fn finish_phone_button(
        &mut self,
        target: NativeComponentTarget,
        result: Result<Value, BridgeError>,
        raw_error: Option<Value>,
    ) -> Result<(), BridgeError> {
        self.host_services
            .phone_buttons
            .remove(&(target.page_id, target.node_id.clone()));
        if self.host_calls.is_closed() {
            return Ok(());
        }
        let mut detail = match result {
            Ok(value) => value,
            Err(error) => {
                async_host::host_error_payload("getPhoneNumber", &error, raw_error.as_ref())
            }
        };
        if let Some(object) = detail.as_object_mut() {
            object
                .entry("errMsg")
                .or_insert_with(|| json!("getPhoneNumber:ok"));
        } else {
            return Err(BridgeError::invalid(
                "phone authorization result must be an object",
            ));
        }
        self.deliver_host_component_target(target, "getphonenumber", detail)
    }

    pub fn dispatch_host_component_event(
        &mut self,
        mut event: HostComponentEvent,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_initialized()?;
        let Some(config) = &self.host_services.config else {
            return Ok(BridgeBatch::new(vec![]));
        };
        if self.host_calls.is_closed()
            || self.host_components_in_background()
            || event.session_id != self.config.session_id
            || event.account_epoch != config.account.epoch
        {
            return Ok(BridgeBatch::new(vec![]));
        }
        let target = self.resolve_host_component_target(&event.node_id, &event.event)?;
        if !native_component_event_allowed(&target.tag, &event.event) {
            return Err(BridgeError::invalid(
                "event is not a native event for this component",
            ));
        }
        let capability = format!("component:{}", target.tag);
        if !self.host_services.registered.contains(&capability)
            || self.effective_capability(&capability) == CapabilitySupport::Unsupported
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "native component is unavailable",
            ));
        }
        let key = (target.page_id, event.node_id.clone(), event.event.clone());
        if event.sequence
            <= self
                .host_services
                .component_sequences
                .get(&key)
                .copied()
                .unwrap_or(0)
        {
            return Ok(BridgeBatch::new(vec![]));
        }
        if !self.host_services.component_sequences.contains_key(&key)
            && self.host_services.component_sequences.len() >= 1024
        {
            return Err(BridgeError::invalid(
                "native component event source limit exceeded",
            ));
        }
        if serde_json::to_vec(&event.value)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len()
            > 1024 * 1024
        {
            return Err(BridgeError::invalid(
                "native component event exceeds byte budget",
            ));
        }
        self.materialize_host_binaries(&mut event.value)?;
        self.host_services
            .component_sequences
            .insert(key, event.sequence);
        self.with_engine_batch_turn(None, |session| {
            session.deliver_host_component_target(target, &event.event, event.value)?;
            let mut messages = Vec::new();
            session.append_engine_effects(&mut messages)?;
            session.append_host_completions(&mut messages);
            Ok(BridgeBatch::new(messages))
        })
    }

    pub fn register_host_binary(
        &mut self,
        bytes: Vec<u8>,
    ) -> Result<HostBinaryHandle, BridgeError> {
        if self.host_calls.is_closed() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "binary owner is retired",
            ));
        }
        let config = self.host_services.config.as_ref().ok_or_else(|| {
            BridgeError::invalid("binary buffers require configured host services")
        })?;
        if self.host_services.binaries.len() >= 256
            || bytes.len() > 32 * 1024 * 1024 - self.host_services.binary_bytes
        {
            return Err(BridgeError::invalid("native binary budget exceeded"));
        }
        let id = format!("binary-{}", NEXT_BINARY_ID.fetch_add(1, Ordering::Relaxed));
        let handle = HostBinaryHandle {
            id: id.clone(),
            byte_length: bytes.len(),
            session_id: self.config.session_id.clone(),
            account_epoch: config.account.epoch,
        };
        self.host_services.binary_bytes += bytes.len();
        self.host_services.binaries.insert(
            id,
            HostBinary {
                bytes,
                references: 1,
            },
        );
        Ok(handle)
    }

    pub fn retain_host_binary(&mut self, id: &str) -> Result<(), BridgeError> {
        let binary = self
            .host_services
            .binaries
            .get_mut(id)
            .ok_or_else(binary_unavailable)?;
        if binary.references >= 1024 {
            return Err(BridgeError::invalid("native binary retain limit exceeded"));
        }
        binary.references += 1;
        Ok(())
    }

    pub fn read_host_binary(
        &self,
        id: &str,
        offset: usize,
        length: usize,
    ) -> Result<Vec<u8>, BridgeError> {
        let binary = self
            .host_services
            .binaries
            .get(id)
            .ok_or_else(binary_unavailable)?;
        if length > 1024 * 1024
            || offset > binary.bytes.len()
            || length > binary.bytes.len() - offset
        {
            return Err(BridgeError::invalid(
                "native binary read is out of range or exceeds chunk budget",
            ));
        }
        Ok(binary.bytes[offset..offset + length].to_vec())
    }

    pub fn release_host_binary(&mut self, id: &str) -> Result<(), BridgeError> {
        let binary = self
            .host_services
            .binaries
            .get_mut(id)
            .ok_or_else(binary_unavailable)?;
        binary.references -= 1;
        if binary.references == 0 {
            let binary = self
                .host_services
                .binaries
                .remove(id)
                .expect("owned binary");
            self.host_services.binary_bytes -= binary.bytes.len();
        }
        Ok(())
    }

    pub(super) fn clear_host_binaries(&mut self) {
        self.host_services.binaries.clear();
        self.host_services.binary_bytes = 0;
    }

    /// A marker transfers one retained reference per distinct handle in this
    /// payload. Validate the complete tree before consuming any references.
    /// Streaming producers send bounded chunks instead of one giant JSON array.
    pub(super) fn materialize_host_binaries(
        &mut self,
        value: &mut Value,
    ) -> Result<(), BridgeError> {
        fn materialize(
            value: &mut Value,
            binaries: &BTreeMap<String, HostBinary>,
            consumed: &mut BTreeSet<String>,
            depth: usize,
            bytes: &mut usize,
        ) -> Result<(), BridgeError> {
            if depth > 64 {
                return Err(BridgeError::invalid(
                    "native binary value exceeds nesting limit",
                ));
            }
            match value {
                Value::Object(object) => {
                    if let Some(marker) = object.get("__weappBinary") {
                        let marker = marker
                            .as_object()
                            .ok_or_else(|| BridgeError::invalid("invalid native binary marker"))?;
                        if let Some(id) = marker.get("handle") {
                            if object.len() != 1 || marker.len() != 1 {
                                return Err(BridgeError::invalid(
                                    "invalid native binary handle marker",
                                ));
                            }
                            let id = id.as_str().ok_or_else(|| {
                                BridgeError::invalid("native binary handle must be a string")
                            })?;
                            let binary = binaries.get(id).ok_or_else(binary_unavailable)?;
                            if binary.bytes.len() > 1024 * 1024
                                || binary.bytes.len() > 1024 * 1024 - *bytes
                            {
                                return Err(BridgeError::invalid(
                                    "native binary payload exceeds one MiB chunk budget",
                                ));
                            }
                            *bytes += binary.bytes.len();
                            consumed.insert(id.to_owned());
                            *value = json!({"__weappBinary":{"bytes":binary.bytes,"type":"ArrayBuffer"}});
                            return Ok(());
                        }
                        if object.len() != 1
                            || marker.get("type").and_then(Value::as_str) != Some("ArrayBuffer")
                            || marker.len() != 2
                        {
                            return Err(BridgeError::invalid(
                                "invalid inline native binary marker",
                            ));
                        }
                        let data =
                            marker
                                .get("bytes")
                                .and_then(Value::as_array)
                                .ok_or_else(|| {
                                    BridgeError::invalid("native binary bytes must be an array")
                                })?;
                        if data.len() > 1024 * 1024 - *bytes {
                            return Err(BridgeError::invalid(
                                "invalid or oversized native binary bytes",
                            ));
                        }
                        let normalized = data
                            .iter()
                            .map(|byte| host_wire_bounded_integer(byte, 255).map(|byte| byte as u8))
                            .collect::<Option<Vec<_>>>()
                            .ok_or_else(|| BridgeError::invalid("invalid native binary byte"))?;
                        *bytes += normalized.len();
                        *value = json!({"__weappBinary":{"bytes":normalized,"type":"ArrayBuffer"}});
                        return Ok(());
                    }
                    for value in object.values_mut() {
                        materialize(value, binaries, consumed, depth + 1, bytes)?;
                    }
                }
                Value::Array(array) => {
                    for value in array {
                        materialize(value, binaries, consumed, depth + 1, bytes)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }
        let mut candidate = value.clone();
        let mut consumed = BTreeSet::new();
        materialize(
            &mut candidate,
            &self.host_services.binaries,
            &mut consumed,
            0,
            &mut 0,
        )?;
        if serde_json::to_vec(&candidate)
            .map_err(|error| BridgeError::invalid(error.to_string()))?
            .len()
            > 64 * 1024 * 1024
        {
            return Err(BridgeError::invalid(
                "materialized native payload exceeds byte budget",
            ));
        }
        for id in consumed {
            self.release_host_binary(&id)?;
        }
        *value = candidate;
        Ok(())
    }

    /// Install a separate synchronous owner before configuration/module
    /// evaluation. The callback never captures or reborrows this Session.
    pub fn bind_sync_host_api(
        &mut self,
        provider: Arc<dyn container_core::SyncHostApi>,
    ) -> Result<(), BridgeError> {
        if self.initialized
            || self.host_services.config.is_some()
            || self.host_services.sync_binding.is_some()
        {
            return Err(BridgeError::invalid(
                "bind synchronous native services once before host configuration and app.init",
            ));
        }
        let supported = provider.supported_apis();
        if supported.is_empty()
            || supported.len() > 128
            || supported
                .iter()
                .any(|name| !sync_files::is_sync_filesystem(name))
        {
            return Err(BridgeError::invalid(
                "synchronous provider must declare supported managed filesystem methods",
            ));
        }
        let binding = Arc::new(sync_files::SyncBinding::new(provider));
        match self.config.engine {
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs => container_core::JsEngine::install_sync_host_api(
                self.quickjs_engine
                    .as_mut()
                    .ok_or_else(|| BridgeError::invalid("QuickJS provider unavailable"))?,
                binding.clone(),
            )
            .map_err(|error| BridgeError::invalid(error.to_string()))?,
            #[cfg(feature = "v8-native")]
            EngineKind::V8 => container_core::JsEngine::install_sync_host_api(
                self.v8_engine
                    .as_mut()
                    .ok_or_else(|| BridgeError::invalid("V8 provider unavailable"))?,
                binding.clone(),
            )
            .map_err(|error| BridgeError::invalid(error.to_string()))?,
            #[cfg(not(all(feature = "quickjs-native", feature = "v8-native")))]
            _ => {
                return Err(BridgeError::invalid(
                    "engine does not implement native synchronous services",
                ))
            }
        }
        self.host_services.sync_binding = Some(binding);
        Ok(())
    }

    pub(super) fn revoke_sync_host_api(&self) -> Result<(), BridgeError> {
        if let Some(binding) = &self.host_services.sync_binding {
            binding.revoke().map_err(BridgeError::invalid)?;
        }
        Ok(())
    }

    pub fn configure_host_services(
        &mut self,
        config: HostServicesConfig,
    ) -> Result<(), BridgeError> {
        if self.initialized || self.host_services.config.is_some() {
            return Err(BridgeError::invalid(
                "host services must be configured once before app.init",
            ));
        }
        if config.application.pack_root != self.manifest.integrity.root {
            return Err(BridgeError::invalid(
                "trusted application packRoot does not match loaded manifest",
            ));
        }
        let NormalizedHostServices {
            config,
            registered,
            compatibility_cleanup_apis,
        } = normalize_host_services_config(config)?;
        let synchronous = registered
            .iter()
            .filter(|name| sync_files::is_sync_filesystem(name))
            .cloned()
            .collect::<BTreeSet<_>>();
        if !synchronous.is_empty() {
            let binding = self.host_services.sync_binding.as_ref().ok_or_else(|| {
                BridgeError::invalid(
                    "synchronous filesystem registration requires a bound native provider",
                )
            })?;
            let supported = container_core::SyncHostApi::supported_apis(binding.as_ref())
                .into_iter()
                .collect::<BTreeSet<_>>();
            if synchronous.iter().any(|name| !supported.contains(name)) {
                return Err(BridgeError::invalid(
                    "synchronous filesystem method is not supported by the bound provider",
                ));
            }
            binding.allow(synchronous);
        }
        let fallback = std::mem::replace(&mut self.provider, Box::new(SandboxProvider::new()));
        *self
            .host_services
            .snapshots
            .lock()
            .expect("host snapshot lock") = config.sync_values.clone();
        self.provider = Box::new(DelegatingProvider {
            fallback,
            registered: registered.clone(),
            sync_values: self.host_services.snapshots.clone(),
            host_app_id: config.application.host_app_id.clone(),
        });
        self.host_services.registered = registered;
        self.host_services.compatibility_cleanup_apis = compatibility_cleanup_apis;
        self.host_services.config = Some(config);
        self.invalidate_engine_host_environment();
        Ok(())
    }

    /// Refresh host-observed values on the owner thread without executing any
    /// application listener. Identity changes still require session revocation.
    pub fn update_host_service_snapshots(
        &mut self,
        values: BTreeMap<String, Value>,
    ) -> Result<(), BridgeError> {
        let config = self
            .host_services
            .config
            .as_ref()
            .ok_or_else(|| BridgeError::invalid("host services are not configured"))?;
        if self.host_calls.is_closed() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "host session closed",
            ));
        }
        for (name, value) in &values {
            if name == "wx.getAccountInfoSync"
                || !config.apis.contains(name)
                || !host_api_descriptor(name).is_some_and(|api| api.kind == "syncSnapshot")
            {
                return Err(BridgeError::invalid(format!(
                    "{name} is not a mutable registered snapshot"
                )));
            }
            if serde_json::to_vec(value)
                .map_err(|error| BridgeError::invalid(error.to_string()))?
                .len()
                > 1024 * 1024
            {
                return Err(BridgeError::invalid("native snapshot exceeds byte budget"));
            }
        }
        self.ensure_engine_execution_healthy()?;
        self.host_services
            .snapshots
            .lock()
            .expect("host snapshot lock")
            .extend(values.clone());
        self.host_services
            .config
            .as_mut()
            .expect("configured host services")
            .sync_values
            .extend(values);
        self.invalidate_engine_host_environment();
        Ok(())
    }

    /// Called only after the host has authorized the new pack and its first
    /// frame has been accepted. A presentation upgrade cannot change identity.
    pub fn update_trusted_application(
        &mut self,
        application: TrustedApplication,
    ) -> Result<(), BridgeError> {
        if self.host_calls.is_closed() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "host session closed",
            ));
        }
        let config = self
            .host_services
            .config
            .as_ref()
            .ok_or_else(|| BridgeError::invalid("host services are not configured"))?;
        let previous = &config.application;
        if application.host_app_id != previous.host_app_id
            || application.tenant_id != previous.tenant_id
            || application.publisher_id != previous.publisher_id
            || application.app_id != previous.app_id
            || application.environment != previous.environment
            || application.pack_root != self.manifest.integrity.root
            || application.version.len() > 512
        {
            return Err(BridgeError::invalid(
                "trusted pack upgrade must match the installed namespace and current manifest",
            ));
        }
        let account = json!({"miniProgram":{"appId":application.app_id,"envVersion":application.environment,"version":application.version},"plugin":{}});
        self.ensure_engine_execution_healthy()?;
        self.host_services
            .snapshots
            .lock()
            .expect("host snapshot lock")
            .insert("wx.getAccountInfoSync".into(), account.clone());
        let config = self
            .host_services
            .config
            .as_mut()
            .expect("configured host services");
        config
            .sync_values
            .insert("wx.getAccountInfoSync".into(), account);
        config.application = application;
        self.invalidate_engine_host_environment();
        Ok(())
    }

    pub(super) fn host_service_registered(&self, name: &str) -> bool {
        self.host_services.registered.contains(name) && !name.starts_with("component:")
    }

    pub(super) fn registered_host_capability(
        &self,
        name: &str,
        provider: &BTreeMap<String, CapabilitySupport>,
    ) -> Option<CapabilitySupport> {
        if !self.host_services.registered.contains(name)
            && !self.host_services.compatibility_cleanup_apis.contains(name)
        {
            return None;
        }
        let manifest = self
            .manifest
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Partial);
        let host = self
            .config
            .capabilities
            .get(name)
            .copied()
            .unwrap_or(CapabilitySupport::Partial);
        let support = min_support(manifest, host);
        Some(
            if host_api_descriptor(name).is_some_and(|api| api.kind == "syncSnapshot") {
                min_support(
                    support,
                    provider
                        .get(name)
                        .copied()
                        .unwrap_or(CapabilitySupport::Unsupported),
                )
            } else {
                support
            },
        )
    }

    pub(super) fn host_api_context(
        &self,
        call_id: &str,
        api: &str,
        context: &ProviderContext,
        payload: &Value,
    ) -> Result<Option<HostApiCallContext>, BridgeError> {
        let Some(config) = self.host_services.config.as_ref() else {
            return Ok(None);
        };
        if !self.host_service_registered(api) {
            return Ok(None);
        }
        let component_target = if matches!(
            api,
            "wx.createCameraContext"
                | "wx.createVideoContext"
                | "wx.createLivePlayerContext"
                | "wx.createLivePusherContext"
                | "wx.createMapContext"
        ) {
            let tag = match api {
                "wx.createCameraContext" => "camera",
                "wx.createVideoContext" => "video",
                "wx.createLivePlayerContext" => "live-player",
                "wx.createLivePusherContext" => "live-pusher",
                _ => "map",
            };
            let scope = payload
                .get("componentScopeId")
                .filter(|value| !value.is_null())
                .map(|value| {
                    value
                        .as_str()
                        .ok_or_else(|| BridgeError::invalid("component scope must be a string"))
                })
                .transpose()?;
            let public_id = payload
                .get("id")
                .or_else(|| payload.get("videoId"))
                .or_else(|| payload.get("mapId"))
                .and_then(Value::as_str);
            if tag != "camera" && public_id.is_none_or(str::is_empty) {
                return Err(BridgeError::invalid(
                    "native context requires a component id",
                ));
            }
            let mut matches = self.host_component_snapshots().into_iter().filter(|node| {
                node.tag == tag
                    && node.owner_scope_id.as_deref() == scope
                    && public_id
                        .is_none_or(|id| node.attributes.get("id").map(String::as_str) == Some(id))
            });
            let target = matches.next().ok_or_else(|| {
                BridgeError::invalid(
                    "native context target does not exist in the selected component scope",
                )
            })?;
            if matches.next().is_some() {
                return Err(BridgeError::invalid(
                    "native context component id is ambiguous",
                ));
            }
            Some(HostApiComponentTarget {
                page_id: target.page_id,
                node_id: target.node_id,
                owner_scope_id: target.owner_scope_id,
            })
        } else {
            payload
                .get("objectId")
                .and_then(Value::as_str)
                .and_then(|id| self.host_services.objects.get(id))
                .or_else(|| {
                    payload
                        .get("receiverId")
                        .and_then(Value::as_str)
                        .and_then(|id| self.host_services.objects.get(id))
                })
                .and_then(|object| object.component_target.clone())
        };
        if let Some(target) = &component_target {
            if !self.host_component_snapshots().iter().any(|node| {
                node.page_id == target.page_id
                    && node.node_id == target.node_id
                    && node.owner_scope_id == target.owner_scope_id
            }) {
                return Err(BridgeError::invalid(
                    "native component owner is no longer presented",
                ));
            }
        }
        Ok(Some(HostApiCallContext {
            application: config.application.clone(),
            account: config.account.clone(),
            session_id: self.config.session_id.clone(),
            call_id: call_id.to_owned(),
            api: api.to_owned(),
            deadline_ns: context.deadline_ns,
            cancel_token: context.cancel_token.clone(),
            component_target,
        }))
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn install_host_services_bridge(&mut self) -> Result<(), BridgeError> {
        let Some(config) = &self.host_services.config else {
            return Ok(());
        };
        let descriptor = |api: &HostApiDescriptor| {
            json!({"name":api.name,"kind":api.kind,"owner":api.owner,
            "objectType":api.object_type,"receiver":api.metadata.get("receiver"),"event":api.event,"counterpart":api.counterpart,
            "property":api.metadata.get("property"),"writable":api.metadata.get("writable"),
            "parameters":api.metadata.get("signatures").and_then(Value::as_array).and_then(|signatures|signatures.first())
                .and_then(|signature|signature.get("parameters")).and_then(Value::as_array)
                .map(|parameters|parameters.iter().filter_map(|parameter|parameter.get("name")).cloned().collect::<Vec<_>>()) })
        };
        let descriptors = config
            .apis
            .iter()
            .filter_map(|name| host_api_descriptor(name))
            .map(descriptor)
            .collect::<Vec<_>>();
        let object_descriptors = host_api_catalog()
            .iter()
            .filter(|api| {
                api.name.starts_with("object:")
                    && api.metadata.get("baseline").and_then(Value::as_str)
                        != Some("newer-than-baseline")
            })
            .map(descriptor)
            .collect::<Vec<_>>();
        let payload = json!({"apis":descriptors,"objectApis":object_descriptors});
        self.call_engine(
            CallTarget::Global {
                name: "__container_install_host_services".into(),
            },
            vec![payload],
        )?;
        Ok(())
    }

    pub(super) fn validate_host_service_call(
        &self,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<(), BridgeError> {
        if !self.host_service_registered(name) {
            return Ok(());
        }
        validate_native_api_payload(name, payload).map_err(provider_bridge_error)?;
        let descriptor = host_api_descriptor(name).expect("registered catalog API");
        if let Some(receiver) = descriptor.metadata.get("receiver").and_then(Value::as_str) {
            let key = if matches!(descriptor.kind.as_str(), "object" | "task") {
                "receiverId"
            } else {
                "objectId"
            };
            let id = native_id(payload, key)?;
            if !self
                .host_services
                .objects
                .get(id)
                .is_some_and(|object| object.object_type == receiver)
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    "native object is unknown, retired, or has a different receiver type",
                ));
            }
        }
        if matches!(descriptor.kind.as_str(), "object" | "task") {
            let id = native_id(payload, "objectId")?;
            if descriptor.object_type.is_none() || self.host_services.objects.contains_key(id) {
                return Err(BridgeError::invalid(
                    "native factory requires a fresh typed object identity",
                ));
            }
            if self.host_services.objects.len() >= 256 {
                return Err(BridgeError::invalid("native object limit exceeded"));
            }
        }
        if matches!(descriptor.kind.as_str(), "object" | "task" | "subscription")
            && self.host_services.retained_calls.len() >= 1024
        {
            return Err(BridgeError::invalid(
                "native retained resource limit exceeded",
            ));
        }
        if descriptor.kind == "subscription" {
            let id = native_id(payload, "subscriptionId")?;
            let object_id = payload
                .get("objectId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let unsubscribe = payload.get("action").and_then(Value::as_str) == Some("unsubscribe")
                || name
                    .rsplit('.')
                    .next()
                    .is_some_and(|leaf| leaf.starts_with("off"));
            if unsubscribe {
                if !self
                    .host_services
                    .subscriptions
                    .get(id)
                    .is_some_and(|subscription| {
                        subscription.object_id == object_id
                            && descriptor.counterpart.as_deref() == Some(subscription.api.as_str())
                    })
                {
                    return Err(BridgeError::invalid(
                        "native unsubscribe does not match an owned subscription",
                    ));
                }
            } else {
                if finite_notifications::is_producer(name)
                    && !self
                        .host_services
                        .finite_notification_registrations
                        .get(id)
                        .is_some_and(|registration| {
                            registration.api == name && registration.object_id == object_id
                        })
                {
                    return Err(BridgeError::new(
                        BridgeErrorCode::Cancelled,
                        "finite notification registration is not owned by a live callback",
                    ));
                }
                if self.host_services.subscriptions.len() >= 256 {
                    return Err(BridgeError::invalid("native subscription limit exceeded"));
                }
                if self.host_services.subscriptions.contains_key(id) {
                    return Err(BridgeError::invalid(
                        "native subscription identity is already active",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn record_native_resource_call(
        &mut self,
        name: &str,
        payload: &Value,
        call_id: &str,
        context: Option<&HostApiCallContext>,
    ) {
        if !self.host_service_registered(name) {
            return;
        }
        let descriptor = host_api_descriptor(name).expect("registered catalog API");
        let component_target = context.and_then(|context| context.component_target.clone());
        if let Some(target) = &component_target {
            self.host_services
                .component_calls
                .insert(call_id.to_owned(), target.clone());
        }
        let operation = if matches!(descriptor.kind.as_str(), "object" | "task") {
            let id = payload["objectId"]
                .as_str()
                .expect("validated object ID")
                .to_owned();
            self.host_services.objects.insert(
                id.clone(),
                NativeObject {
                    object_type: descriptor.object_type.clone().expect("factory type"),
                    parent_id: payload
                        .get("receiverId")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    call_id: call_id.to_owned(),
                    component_target,
                },
            );
            self.host_services.retained_calls.insert(call_id.to_owned());
            Some(NativeOperation::Create {
                object_id: id,
                terminal_task: matches!(
                    descriptor.object_type.as_deref(),
                    Some("RequestTask" | "DownloadTask" | "UploadTask")
                ),
            })
        } else if descriptor.kind == "subscription" {
            let id = payload["subscriptionId"]
                .as_str()
                .expect("validated subscription ID")
                .to_owned();
            if payload["action"] == "unsubscribe"
                || name
                    .rsplit('.')
                    .next()
                    .is_some_and(|leaf| leaf.starts_with("off"))
            {
                self.host_services
                    .subscriptions
                    .remove(&id)
                    .and_then(|subscription| subscription.call_id)
                    .map(|creator_call_id| NativeOperation::Unsubscribe { creator_call_id })
            } else {
                self.host_services.subscriptions.insert(
                    id.clone(),
                    NativeSubscription {
                        api: name.to_owned(),
                        object_id: payload
                            .get("objectId")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        sequence: 0,
                        call_id: Some(call_id.to_owned()),
                    },
                );
                self.host_services.retained_calls.insert(call_id.to_owned());
                Some(NativeOperation::Subscribe {
                    subscription_id: id,
                })
            }
        } else if name == "object:UDPSocket.close"
            || name.starts_with("object:")
                && name
                    .rsplit('.')
                    .next()
                    .is_some_and(|leaf| matches!(leaf, "destroy" | "terminate"))
        {
            payload
                .get("objectId")
                .and_then(Value::as_str)
                .map(|id| NativeOperation::Destroy {
                    object_id: id.to_owned(),
                })
        } else {
            None
        };
        if let Some(operation) = operation {
            self.host_services
                .operations
                .insert(call_id.to_owned(), operation);
        }
    }

    fn retire_native_object(&mut self, id: &str) -> Vec<String> {
        let mut ids = vec![id.to_owned()];
        let mut calls = Vec::new();
        while let Some(id) = ids.pop() {
            ids.extend(
                self.host_services
                    .objects
                    .iter()
                    .filter(|(_, object)| object.parent_id.as_deref() == Some(&id))
                    .map(|(id, _)| id.clone()),
            );
            if let Some(object) = self.host_services.objects.remove(&id) {
                if finite_notifications::owns_object_receiver(&object.object_type) {
                    self.host_services
                        .finite_notification_object_retirements
                        .insert(id.clone());
                }
                calls.push(object.call_id);
            }
            let subscriptions = self
                .host_services
                .subscriptions
                .iter()
                .filter(|(_, subscription)| subscription.object_id.as_deref() == Some(&id))
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            for id in subscriptions {
                if let Some(call_id) = self
                    .host_services
                    .subscriptions
                    .remove(&id)
                    .and_then(|subscription| subscription.call_id)
                {
                    calls.push(call_id);
                }
            }
        }
        for call_id in &calls {
            self.host_services.retained_calls.remove(call_id);
        }
        calls
    }

    /// Retire page/component authority without resolving old guest promises.
    /// The native cancellation is still delivered for work already dispatched.
    pub(super) fn retire_native_component_owners(
        &mut self,
        page: PageId,
        scopes: Option<&BTreeSet<String>>,
    ) {
        let owns = |target: &HostApiComponentTarget| {
            target.page_id == page.0
                && scopes.is_none_or(|scopes| {
                    target
                        .owner_scope_id
                        .as_ref()
                        .is_some_and(|scope| scopes.contains(scope))
                })
        };
        let objects = self
            .host_services
            .objects
            .iter()
            .filter(|(_, object)| object.component_target.as_ref().is_some_and(owns))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut calls = self
            .host_services
            .component_calls
            .iter()
            .filter(|(_, target)| owns(target))
            .map(|(id, _)| id.clone())
            .collect::<BTreeSet<_>>();
        for object in objects {
            calls.extend(self.retire_native_object(&object));
        }
        for call in &calls {
            self.host_services.component_calls.remove(call);
            self.host_services.operations.remove(call);
        }
        self.abandon_native_resource_calls(calls);
    }

    pub(super) fn finish_native_resource_call(
        &mut self,
        call_id: &str,
        succeeded: bool,
    ) -> Vec<String> {
        self.host_services.component_calls.remove(call_id);
        match self.host_services.operations.remove(call_id) {
            Some(NativeOperation::Create {
                object_id,
                terminal_task,
            }) if !succeeded || terminal_task => self.retire_native_object(&object_id),
            Some(NativeOperation::Destroy { object_id }) if succeeded => {
                self.retire_native_object(&object_id)
            }
            Some(NativeOperation::Subscribe { subscription_id }) if !succeeded => {
                if self
                    .host_services
                    .subscriptions
                    .get(&subscription_id)
                    .and_then(|subscription| subscription.call_id.as_deref())
                    == Some(call_id)
                {
                    self.host_services.subscriptions.remove(&subscription_id);
                }
                self.host_services.retained_calls.remove(call_id);
                vec![call_id.to_owned()]
            }
            Some(NativeOperation::Unsubscribe { creator_call_id }) if succeeded => {
                self.host_services.retained_calls.remove(&creator_call_id);
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    pub(super) fn validate_native_resource_result(
        &self,
        call_id: &str,
        result: &Value,
    ) -> Result<(), ProviderError> {
        if let Some(NativeOperation::Create { object_id, .. }) =
            self.host_services.operations.get(call_id)
        {
            if result
                .get("objectId")
                .is_some_and(|id| id.as_str() != Some(object_id))
            {
                return Err(ProviderError::invalid(
                    "native factory returned a different object identity",
                ));
            }
        }
        Ok(())
    }

    pub(super) fn release_native_resource_calls(&mut self) -> Vec<String> {
        let retired_objects = self
            .host_services
            .objects
            .iter()
            .filter(|(_, object)| finite_notifications::owns_object_receiver(&object.object_type))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        self.host_services
            .finite_notification_object_retirements
            .extend(retired_objects);
        self.host_services.subscriptions.clear();
        self.host_services.objects.clear();
        self.host_services.component_calls.clear();
        self.host_services.operations.clear();
        self.host_services.finite_notification_registrations.clear();
        self.host_services.phone_buttons.clear();
        self.host_services.component_sequences.clear();
        self.host_services
            .component_presentation
            .borrow_mut()
            .clear();
        std::mem::take(&mut self.host_services.retained_calls)
            .into_iter()
            .collect()
    }

    pub(super) fn cancel_native_subscription(&mut self, id: &str) -> Result<(), BridgeError> {
        if let Some(call_id) = self
            .host_services
            .subscriptions
            .remove(id)
            .and_then(|subscription| subscription.call_id)
        {
            self.host_services.retained_calls.remove(&call_id);
            self.cancel_native_resource_call(&call_id)?;
        }
        Ok(())
    }

    pub fn dispatch_host_api_event(
        &mut self,
        mut event: HostApiEvent,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_initialized()?;
        let Some(config) = &self.host_services.config else {
            return Ok(BridgeBatch::new(vec![]));
        };
        if event.session_id != self.config.session_id
            || event.account_epoch != config.account.epoch
            || self.host_calls.is_closed()
        {
            return Ok(BridgeBatch::new(vec![]));
        }
        let Some(subscription) = self
            .host_services
            .subscriptions
            .get_mut(&event.subscription_id)
        else {
            return Ok(BridgeBatch::new(vec![]));
        };
        if event.sequence <= subscription.sequence || event.object_id != subscription.object_id {
            return Ok(BridgeBatch::new(vec![]));
        }
        if event.event.as_deref().is_some_and(|event| {
            host_api_descriptor(&subscription.api).and_then(|api| api.event.as_deref())
                != Some(event)
        }) {
            return Ok(BridgeBatch::new(vec![]));
        }
        if serde_json::to_vec(&event.value)
            .map_err(|e| BridgeError::invalid(e.to_string()))?
            .len()
            > 1024 * 1024
        {
            return Err(BridgeError::invalid("native event exceeds byte budget"));
        }
        let finite_api =
            finite_notifications::is_producer(&subscription.api).then(|| subscription.api.clone());
        self.materialize_host_binaries(&mut event.value)?;
        self.host_services
            .subscriptions
            .get_mut(&event.subscription_id)
            .expect("validated subscription")
            .sequence = event.sequence;
        let mut payload = serde_json::to_value(&event).expect("native event JSON");
        payload["sequence"] = Value::String(event.sequence.to_string());
        self.with_engine_batch_turn(None, |session| {
            if let Some(api) = finite_api {
                session.dispatch_finite_notification(&api, &payload)?;
            } else {
                session.call_engine(
                    CallTarget::Global {
                        name: "__container_receive_native_event".into(),
                    },
                    vec![payload],
                )?;
            }
            let mut messages = Vec::new();
            session.append_engine_effects(&mut messages)?;
            session.append_host_completions(&mut messages);
            Ok(BridgeBatch::new(messages))
        })
    }
}

fn binary_unavailable() -> BridgeError {
    BridgeError::new(
        BridgeErrorCode::Cancelled,
        "native binary handle is unknown, released, or belongs to a retired owner",
    )
}

fn native_boolean_attribute(attributes: &BTreeMap<String, String>, name: &str) -> bool {
    attributes
        .get(name)
        .is_some_and(|value| !matches!(value.as_str(), "false" | "0"))
}

fn native_component_event_allowed(tag: &str, event: &str) -> bool {
    match tag {
        "camera" => matches!(event, "initdone" | "stop" | "error" | "scancode"),
        "video" => matches!(
            event,
            "play"
                | "pause"
                | "ended"
                | "timeupdate"
                | "fullscreenchange"
                | "waiting"
                | "error"
                | "loadedmetadata"
                | "progress"
                | "controlstoggle"
                | "enterpictureinpicture"
                | "leavepictureinpicture"
                | "seekcomplete"
        ),
        "audio" => matches!(event, "error" | "play" | "pause" | "ended" | "timeupdate"),
        "map" => matches!(
            event,
            "markertap"
                | "labeltap"
                | "callouttap"
                | "controltap"
                | "regionchange"
                | "poitap"
                | "updated"
                | "anchorpointtap"
        ),
        "live-player" | "live-pusher" => matches!(
            event,
            "statechange" | "netstatus" | "error" | "fullscreenchange" | "audiovolumenotify"
        ),
        _ => false,
    }
}

fn native_id<'a>(payload: &'a Map<String, Value>, key: &str) -> Result<&'a str, BridgeError> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 256
                && id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.')
                })
        })
        .ok_or_else(|| BridgeError::invalid(format!("native operation requires bounded {key}")))
}

fn validate_native_api_payload(
    name: &str,
    payload: &Map<String, Value>,
) -> Result<(), ProviderError> {
    if host_api_descriptor(name)
        .is_some_and(|api| api.metadata.get("property") == Some(&Value::Bool(true)))
        && (payload.get("action").and_then(Value::as_str) != Some("set")
            || !host_api_descriptor(name)
                .is_some_and(|api| api.metadata.get("writable") == Some(&Value::Bool(true))))
    {
        return Err(ProviderError::invalid(
            "native property is read-only or requires a set command",
        ));
    }
    fn validate_binary(
        value: &Value,
        depth: usize,
        bytes: &mut usize,
    ) -> Result<(), ProviderError> {
        if depth > 64 {
            return Err(ProviderError::invalid(
                "native payload nesting limit exceeded",
            ));
        }
        match value {
            Value::Object(object) => {
                if let Some(marker) = object.get("__weappBinary") {
                    let marker = marker
                        .as_object()
                        .ok_or_else(|| ProviderError::invalid("invalid native binary marker"))?;
                    let data = marker
                        .get("bytes")
                        .and_then(Value::as_array)
                        .ok_or_else(|| {
                            ProviderError::invalid("guest binary data must use inline bytes")
                        })?;
                    if object.len() != 1
                        || marker.len() != 2
                        || marker.get("type").and_then(Value::as_str) != Some("ArrayBuffer")
                        || data.len() > 1024 * 1024 - *bytes
                        || data
                            .iter()
                            .any(|byte| byte.as_u64().is_none_or(|byte| byte > 255))
                    {
                        return Err(ProviderError::invalid(
                            "invalid or oversized guest binary data",
                        ));
                    }
                    *bytes += data.len();
                } else {
                    for value in object.values() {
                        validate_binary(value, depth + 1, bytes)?;
                    }
                }
            }
            Value::Array(array) => {
                for value in array {
                    validate_binary(value, depth + 1, bytes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    validate_binary(&Value::Object(payload.clone()), 0, &mut 0)?;
    match name {
        "weappContainer.payment.request" => {
            let order_id = payload
                .get("orderId")
                .and_then(Value::as_str)
                .filter(|value| {
                    !value.is_empty()
                        && value.len() <= 128
                        && value
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
                .ok_or_else(|| {
                    ProviderError::invalid(
                        "weappContainer.payment.request requires a bounded backend orderId",
                    )
                })?;
            let _ = order_id;
            for field in [
                "appId",
                "prepayId",
                "paySign",
                "package",
                "orderString",
                "signType",
            ] {
                if payload.contains_key(field) {
                    return Err(ProviderError::invalid(
                        "weappContainer.payment.request accepts a backend orderId only",
                    ));
                }
            }
        }
        "wx.requestPayment" => {
            PaymentRequest::from_payload(payload)?;
        }
        "wx.getUserProfile" => {
            if payload
                .get("desc")
                .and_then(Value::as_str)
                .is_none_or(|desc| desc.trim().is_empty())
            {
                return Err(ProviderError::invalid(
                    "getUserProfile requires a non-empty desc",
                ));
            }
        }
        "wx.authorize" => {
            if payload
                .get("scope")
                .and_then(Value::as_str)
                .is_none_or(|scope| scope.trim().is_empty())
            {
                return Err(ProviderError::invalid(
                    "authorize requires a non-empty scope",
                ));
            }
        }
        "wx.getSetting" | "wx.openSetting"
            if payload
                .get("withSubscriptions")
                .is_some_and(|v| !v.is_boolean()) =>
        {
            return Err(ProviderError::invalid(
                "withSubscriptions must be a boolean",
            ));
        }
        _ => {}
    }
    Ok(())
}
