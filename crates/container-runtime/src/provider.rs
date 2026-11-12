//! Host capability providers used by the AppService API registry.
//!
//! Providers are deliberately independent of any UI toolkit.  A host can
//! replace the deterministic sandbox with an implementation backed by its
//! network stack, filesystem, permission broker or native device APIs while
//! keeping the bridge envelope and error contract unchanged.

use crate::HostMetadata;
use container_ir::CapabilitySupport;
use md5::Md5;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorCode {
    InvalidRequest,
    PermissionDenied,
    Timeout,
    Cancelled,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    pub code: ProviderErrorCode,
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

impl ProviderError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: ProviderErrorCode::InvalidRequest,
            message: message.into(),
            retryable: false,
        }
    }

    pub fn permission(permission: impl Into<String>) -> Self {
        Self {
            code: ProviderErrorCode::PermissionDenied,
            message: format!("permission denied: {}", permission.into()),
            retryable: false,
        }
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self {
            code: ProviderErrorCode::Timeout,
            message: message.into(),
            retryable: true,
        }
    }

    pub fn cancelled(message: impl Into<String>) -> Self {
        Self {
            code: ProviderErrorCode::Cancelled,
            message: message.into(),
            retryable: false,
        }
    }
}

impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ProviderContext {
    pub session_id: String,
    pub host: HostMetadata,
    pub now_ns: u64,
    /// The bridge deadline is an absolute Unix timestamp in nanoseconds. A
    /// provider checks it again at its own boundary so native providers and
    /// the deterministic sandbox share the same timeout semantics.
    #[serde(default)]
    pub deadline_ns: Option<u64>,
    /// The cancellation token associated with this operation, when present.
    /// Providers may use it to cancel work that has already entered a host
    /// queue; the session also rejects cancelled requests before dispatch.
    #[serde(default)]
    pub cancel_token: Option<String>,
    /// Set by the session when a provider call is observed after cancellation.
    #[serde(default)]
    pub cancelled: bool,
}

/// An asynchronous provider either completes immediately or delegates to the host outbox.
/// Returning Pending never runs host work on the runtime thread.
#[derive(Clone, Debug, PartialEq)]
pub enum ProviderStart {
    Ready(Result<Value, ProviderError>),
    Pending,
}

/// Host API boundary.  Implementations must keep calls deterministic for a
/// given context and must return a structured error instead of an empty
/// success value.
pub trait HostApiProvider: Send {
    fn name(&self) -> &'static str;

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        BTreeMap::new()
    }

    /// Capabilities whose availability depends on observations already accepted
    /// by this host session. The default preserves existing provider behavior.
    fn capabilities_for_host(&self, _host: &HostMetadata) -> BTreeMap<String, CapabilitySupport> {
        self.capabilities()
    }

    /// Return a deterministic snapshot for synchronous filesystem calls made
    /// inside the JavaScript isolate.  Native providers can override this
    /// when they can expose a permission-scoped snapshot; the default keeps
    /// the boundary explicit and makes sync file APIs fail with the stable
    /// unavailable error instead of fabricating data.
    fn sync_file_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        BTreeMap::new()
    }

    /// Whether the provider can service synchronous file-manager methods.
    /// Providers that override [`Self::sync_file_snapshot`] must opt in here
    /// so `wx.canIUse` never advertises a facade backed by an empty fallback.
    fn supports_sync_filesystem(&self) -> bool {
        false
    }

    /// Mark a queued provider operation as cancelled. Synchronous providers
    /// may return `false`; asynchronous/native providers can override this to
    /// interrupt an in-flight request. The operation remains idempotent.
    fn cancel(&mut self, _token: &str) -> bool {
        false
    }

    /// Notify a provider that the host network changed. Native providers can
    /// override this hook to update their own network snapshot; the default is
    /// a no-op so a host may still deliver an explicit status event without
    /// requiring a mutable platform network service.
    fn update_network_type(&mut self, _network_type: NetworkType) -> Result<(), ProviderError> {
        Ok(())
    }

    /// Apply a page navigation-bar title through the host UI boundary.  The
    /// session owns the page instance and persists the title in its page
    /// stack; providers own native presentation and permission/deadline
    /// checks.  The default forwards to `call` so existing providers remain
    /// source-compatible while native providers can override the operation.
    fn set_navigation_bar_title(
        &mut self,
        title: &str,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        let mut payload = Map::new();
        payload.insert("title".into(), Value::String(title.to_owned()));
        self.call("wx.setNavigationBarTitle", &payload, context)
    }

    /// Start an asynchronous call. Existing synchronous providers remain source-compatible.
    /// A Pending call is correlated and emitted by Session after this method returns.
    fn start_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> ProviderStart {
        ProviderStart::Ready(self.call(name, payload, context))
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError>;
}

/// The network values exposed by `wx.getNetworkType` are a closed set in the
/// public runtime. Keeping the value typed inside the provider prevents a
/// host adapter from accidentally returning a browser-specific string (for
/// example `ethernet`) through the portable bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkType {
    Wifi,
    #[serde(rename = "5g")]
    FiveG,
    #[serde(rename = "4g")]
    FourG,
    #[serde(rename = "3g")]
    ThreeG,
    #[serde(rename = "2g")]
    TwoG,
    Unknown,
    None,
}

impl NetworkType {
    /// Return the stable public value used by `wx.getNetworkType` and
    /// `wx.onNetworkStatusChange`.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Wifi => "wifi",
            Self::FiveG => "5g",
            Self::FourG => "4g",
            Self::ThreeG => "3g",
            Self::TwoG => "2g",
            Self::Unknown => "unknown",
            Self::None => "none",
        }
    }
}

impl TryFrom<&str> for NetworkType {
    type Error = ProviderError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value.trim().to_ascii_lowercase().as_str() {
            "wifi" => Ok(Self::Wifi),
            "5g" => Ok(Self::FiveG),
            "4g" => Ok(Self::FourG),
            "3g" => Ok(Self::ThreeG),
            "2g" => Ok(Self::TwoG),
            "unknown" => Ok(Self::Unknown),
            "none" => Ok(Self::None),
            _ => Err(ProviderError::invalid(
                "wx.getNetworkType networkType must be wifi, 5g, 4g, 3g, 2g, unknown, or none"
                    .to_string(),
            )),
        }
    }
}

/// A recorded device side effect. Native hosts can consume this typed record
/// to invoke their vibration service while the sandbox keeps the effect
/// deterministic and inspectable in conformance tests.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct VibrationRecord {
    pub kind: String,
    pub duration_ms: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceState {
    pub network_type: NetworkType,
    pub keep_screen_on: bool,
    pub location_updates: bool,
    pub vibrations: Vec<VibrationRecord>,
}

/// Host supplied fields for `wx.getDeviceInfo`.
///
/// The API is synchronous and must not infer platform details from the
/// process that happens to host the container.  Native adapters therefore
/// inject a snapshot through [`SandboxProvider::with_device_info`], while the
/// deterministic sandbox keeps every value explicit and stable.  `platform`
/// and `system` remain tied to the request's [`HostMetadata`] because those
/// are host lifecycle values; the rest of the device identity is provider
/// owned and can be populated from the native device service.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeviceInfoSnapshot {
    pub brand: String,
    pub model: String,
    pub abi: String,
    #[serde(rename = "cpuType")]
    pub cpu_type: String,
    #[serde(rename = "memorySize")]
    pub memory_size: u32,
    #[serde(rename = "benchmarkLevel")]
    pub benchmark_level: i32,
}

impl DeviceInfoSnapshot {
    fn validate(&self) -> Result<(), ProviderError> {
        for (field, value) in [
            ("brand", self.brand.as_str()),
            ("model", self.model.as_str()),
            ("abi", self.abi.as_str()),
            ("cpuType", self.cpu_type.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProviderError::invalid(format!(
                    "wx.getDeviceInfo {field} must be a non-empty string"
                )));
            }
        }
        if self.benchmark_level < -1 {
            return Err(ProviderError::invalid(
                "wx.getDeviceInfo benchmarkLevel must be -1 or greater",
            ));
        }
        Ok(())
    }
}

impl Default for DeviceInfoSnapshot {
    fn default() -> Self {
        Self {
            brand: "Weapp Container Sandbox".to_owned(),
            model: "container-sandbox".to_owned(),
            abi: "unknown".to_owned(),
            cpu_type: "unknown".to_owned(),
            memory_size: 0,
            benchmark_level: -1,
        }
    }
}

/// Provider-owned fields for the `wx.getSystemInfo*` family.
///
/// Window geometry, platform and system version remain owned by
/// [`HostMetadata`], because those values can change when the same runtime is
/// presented on another surface. The rest of the public snapshot is typed
/// here so a native provider can inject the values it actually observed
/// instead of inheriting the deterministic sandbox constants. The sandbox
/// defaults are intentionally explicit and keep the API at `partial` support
/// until every host supplies its own conformance evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SystemInfoSnapshot {
    pub brand: String,
    pub model: String,
    #[serde(rename = "pixelRatio")]
    pub pixel_ratio: f64,
    pub language: String,
    #[serde(rename = "SDKVersion")]
    pub sdk_version: String,
    #[serde(rename = "statusBarHeight")]
    pub status_bar_height: u32,
    #[serde(rename = "deviceOrientation")]
    pub device_orientation: String,
    pub theme: String,
    #[serde(rename = "fontSizeSetting")]
    pub font_size_setting: f64,
}

impl SystemInfoSnapshot {
    fn validate(&self) -> Result<(), ProviderError> {
        for (field, value) in [
            ("brand", self.brand.as_str()),
            ("model", self.model.as_str()),
            ("language", self.language.as_str()),
            ("SDKVersion", self.sdk_version.as_str()),
            ("deviceOrientation", self.device_orientation.as_str()),
            ("theme", self.theme.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(ProviderError::invalid(format!(
                    "wx.getSystemInfo {field} must be a non-empty string"
                )));
            }
        }
        if !matches!(self.device_orientation.as_str(), "portrait" | "landscape") {
            return Err(ProviderError::invalid(
                "wx.getSystemInfo deviceOrientation must be portrait or landscape",
            ));
        }
        if !matches!(self.theme.as_str(), "light" | "dark") {
            return Err(ProviderError::invalid(
                "wx.getSystemInfo theme must be light or dark",
            ));
        }
        if !self.pixel_ratio.is_finite() || self.pixel_ratio <= 0.0 {
            return Err(ProviderError::invalid(
                "wx.getSystemInfo pixelRatio must be a finite number greater than 0",
            ));
        }
        if !self.font_size_setting.is_finite() || self.font_size_setting <= 0.0 {
            return Err(ProviderError::invalid(
                "wx.getSystemInfo fontSizeSetting must be a finite number greater than 0",
            ));
        }
        Ok(())
    }
}

impl Default for SystemInfoSnapshot {
    fn default() -> Self {
        Self {
            brand: "Weapp Container Sandbox".to_owned(),
            model: "container-sandbox".to_owned(),
            pixel_ratio: 1.0,
            language: "zh_CN".to_owned(),
            sdk_version: "3.17.3".to_owned(),
            status_bar_height: 0,
            device_orientation: "portrait".to_owned(),
            theme: "light".to_owned(),
            font_size_setting: 16.0,
        }
    }
}

/// Settings exposed by the synchronous `wx.getSystemSetting` API. Native
/// providers can replace this snapshot with their platform state while
/// keeping the portable result shape stable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemSettingSnapshot {
    #[serde(rename = "bluetoothEnabled")]
    pub bluetooth_enabled: bool,
    #[serde(rename = "locationEnabled")]
    pub location_enabled: bool,
    #[serde(rename = "wifiEnabled")]
    pub wifi_enabled: bool,
    #[serde(rename = "deviceOrientation")]
    pub device_orientation: String,
}

impl Default for SystemSettingSnapshot {
    fn default() -> Self {
        Self {
            bluetooth_enabled: false,
            location_enabled: false,
            wifi_enabled: true,
            device_orientation: "portrait".to_owned(),
        }
    }
}

/// Provider-owned subscription authorization state returned when callers pass
/// `withSubscriptions: true` to `wx.getSetting` or `wx.openSetting`.
///
/// The sandbox keeps this state deterministic and injectable; native hosts can
/// replace it with their platform subscription service without changing the
/// bridge result shape.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubscriptionSettingSnapshot {
    #[serde(rename = "mainSwitch")]
    pub main_switch: bool,
    #[serde(rename = "itemSettings")]
    pub item_settings: BTreeMap<String, String>,
}

impl SubscriptionSettingSnapshot {
    fn validate(&self) -> Result<(), ProviderError> {
        for (template_id, setting) in &self.item_settings {
            if template_id.trim().is_empty() {
                return Err(ProviderError::invalid(
                    "wx.getSetting subscriptions itemSettings keys must be non-empty",
                ));
            }
            if !matches!(setting.as_str(), "accept" | "reject" | "ban") {
                return Err(ProviderError::invalid(format!(
                    "wx.getSetting subscription {template_id} must be accept, reject, or ban"
                )));
            }
        }
        Ok(())
    }
}

/// Account metadata exposed by `wx.getAccountInfoSync`. Native providers can
/// replace these values with the package's real mini-program identity while
/// retaining the stable public result shape.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct MiniProgramAccountInfo {
    #[serde(rename = "appId")]
    pub app_id: String,
    #[serde(rename = "envVersion")]
    pub env_version: String,
    pub version: String,
}

/// Validated target metadata for the last `wx.redirectToMiniProgram` call.
///
/// The sandbox never opens another application. It records the accepted handoff
/// so development hosts and conformance fixtures can inspect exactly what a
/// native provider would receive, while keeping the public callback result
/// limited to WeChat's documented `{ errMsg }` envelope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MiniProgramRedirectRequest {
    #[serde(rename = "appId")]
    pub app_id: String,
    pub path: String,
    #[serde(rename = "extraData")]
    pub extra_data: Value,
    #[serde(rename = "envVersion")]
    pub env_version: String,
}

impl MiniProgramRedirectRequest {
    fn from_payload(payload: &Map<String, Value>) -> Result<Self, ProviderError> {
        let app_id = payload
            .get("appId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ProviderError::invalid("wx.redirectToMiniProgram requires a non-empty string appId")
            })?
            .to_owned();
        let path = match payload.get("path") {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.clone(),
            Some(_) => {
                return Err(ProviderError::invalid(
                    "wx.redirectToMiniProgram path must be a string",
                ))
            }
        };
        let extra_data = match payload.get("extraData") {
            None | Some(Value::Null) => json!({}),
            Some(Value::Object(value)) => Value::Object(value.clone()),
            Some(_) => {
                return Err(ProviderError::invalid(
                    "wx.redirectToMiniProgram extraData must be an object",
                ))
            }
        };
        let env_version = match payload.get("envVersion") {
            None | Some(Value::Null) => "release".to_owned(),
            Some(Value::String(value)) if matches!(value.as_str(), "develop" | "trial" | "release") => {
                value.clone()
            }
            Some(Value::String(value)) => {
                return Err(ProviderError::invalid(format!(
                    "wx.redirectToMiniProgram envVersion must be develop, trial, or release (got {value})"
                )))
            }
            Some(_) => {
                return Err(ProviderError::invalid(
                    "wx.redirectToMiniProgram envVersion must be a string",
                ))
            }
        };
        Ok(Self {
            app_id,
            path,
            extra_data,
            env_version,
        })
    }
}

impl MiniProgramAccountInfo {
    /// Validate the public enum carried by `envVersion` before exposing an
    /// account snapshot to JavaScript.  WeChat documents only these three
    /// release channels; returning an arbitrary host value would make
    /// `getAccountInfoSync` claim a successful result that cannot be compared
    /// with the DevTools contract.
    fn validate(&self) -> Result<(), ProviderError> {
        if matches!(self.env_version.as_str(), "develop" | "trial" | "release") {
            Ok(())
        } else {
            Err(ProviderError::invalid(format!(
                "getAccountInfoSync:fail envVersion must be develop, trial, or release (got {})",
                self.env_version
            )))
        }
    }
}

/// User profile returned by `wx.getUserProfile` in the deterministic
/// provider.  Native providers can replace this snapshot with an account
/// service response while keeping the public field names and types stable.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserProfileSnapshot {
    #[serde(rename = "nickName")]
    pub nick_name: String,
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
    pub gender: u8,
    pub country: String,
    pub province: String,
    pub city: String,
    pub language: String,
}

impl Default for UserProfileSnapshot {
    fn default() -> Self {
        Self {
            nick_name: "Weapp Container Sandbox".to_owned(),
            avatar_url: String::new(),
            gender: 0,
            country: "CN".to_owned(),
            province: String::new(),
            city: String::new(),
            language: "zh_CN".to_owned(),
        }
    }
}

impl Default for MiniProgramAccountInfo {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            env_version: "develop".to_owned(),
            version: String::new(),
        }
    }
}

/// Third-party platform extension data exposed by `wx.getExtConfig*`.
/// Native providers can replace the deterministic object with the package's
/// injected snapshot while preserving the public result envelope.
pub type ExtConfigSnapshot = Value;

/// Observable UI state owned by the host provider.
///
/// The sandbox does not open native dialogs or overlays. It still records the
/// latest values and returns the same result shapes as the public `wx` APIs so
/// a host can replace this state machine with its own UI implementation
/// without changing the bridge contract.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UiState {
    pub toast: Option<Value>,
    pub loading: Option<Value>,
    pub modal: Option<Value>,
    pub action_sheet: Option<Value>,
    pub page_scroll: Option<Value>,
    pub navigation_bar: Option<Value>,
    /// Last title sent to the native navigation-bar surface.  Page-specific
    /// persistence lives in `container-core::PageEntry`; this field is the
    /// host-visible presentation snapshot.
    pub navigation_bar_title: Option<String>,
}

/// A validated share request accepted by the deterministic provider.
///
/// The sandbox records this portable request for conformance and development
/// tooling, but never opens a native share sheet or claims that a user share
/// completed. Native providers can consume the same typed fields and replace
/// the result with their platform share lifecycle.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShareRequest {
    pub api: String,
    pub title: Option<String>,
    pub path: Option<String>,
    pub image_url: Option<String>,
    pub query: Option<String>,
    pub template_id: Option<String>,
    pub extra_data: Option<Value>,
    pub menus: Option<Vec<String>>,
}

/// A validated request passed to `wx.requestPayment`.
///
/// The sandbox records this typed request but never contacts a payment
/// service or claims that a user completed checkout. Native providers can
/// consume the same fields and replace the result with their platform payment
/// lifecycle while retaining the bridge contract.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PaymentRequest {
    pub time_stamp: String,
    pub nonce_str: String,
    pub package: String,
    pub sign_type: String,
    pub pay_sign: String,
}

impl Default for DeviceState {
    fn default() -> Self {
        Self {
            network_type: NetworkType::Wifi,
            keep_screen_on: false,
            location_updates: false,
            vibrations: Vec::new(),
        }
    }
}

/// A deterministic provider for conformance and development.  It does not
/// touch the host filesystem or network.  Tests can seed responses and grant
/// named permissions, while native hosts can replace it through
/// [`crate::Session::set_provider`].
#[derive(Clone, Debug)]
pub struct SandboxProvider {
    files: BTreeMap<String, Vec<u8>>,
    /// Metadata is tracked separately from the byte store because only files
    /// created through saveFile are visible to getSavedFile* APIs.  This also
    /// keeps package/temp files seeded by a host out of the saved-file list.
    saved_files: BTreeMap<String, SavedFileMetadata>,
    responses: BTreeMap<String, Value>,
    permissions: BTreeMap<String, bool>,
    cancelled_tokens: BTreeMap<String, bool>,
    clipboard: String,
    device: DeviceState,
    device_info: DeviceInfoSnapshot,
    system_info: SystemInfoSnapshot,
    battery_level: u8,
    battery_charging: bool,
    /// Deterministic display brightness in the public 0..=1 range used by
    /// `wx.getScreenBrightness` and `wx.setScreenBrightness`. Native hosts
    /// can replace this field with their platform display service while
    /// preserving the typed provider contract.
    screen_brightness: f64,
    system_setting: SystemSettingSnapshot,
    subscription_setting: SubscriptionSettingSnapshot,
    account_info: MiniProgramAccountInfo,
    /// Last validated cross-mini-program handoff. The native provider may
    /// consume the same request to invoke platform navigation.
    last_mini_program_redirect: Option<MiniProgramRedirectRequest>,
    /// Last validated share request. The sandbox records the request but
    /// never opens a native share sheet or fabricates a user action.
    last_share: Option<ShareRequest>,
    /// Last validated payment request. The sandbox records typed payment
    /// fields without contacting a payment service or claiming user success.
    last_payment: Option<PaymentRequest>,
    /// Deterministic profile snapshot returned after the host grants the
    /// profile permission.  This remains separate from account metadata:
    /// `wx.getUserProfile` is consent-gated and may be backed by a distinct
    /// provider on native hosts.
    user_profile: UserProfileSnapshot,
    /// Deterministic account-session state used by `wx.login` and
    /// `wx.checkSession`.  A sandbox starts without a valid session, matching
    /// the public contract where `checkSession` must not succeed before a
    /// login or an injected host session has been established.
    login_code: String,
    account_session_valid: bool,
    ext_config: ExtConfigSnapshot,
    ui: UiState,
    /// Deterministic state for `wx.createInnerAudioContext` instances. A
    /// native provider can replace the state transitions with a real decoder
    /// and audio output while retaining the same command/result contract.
    audio_contexts: BTreeMap<String, InnerAudioState>,
    destroyed_audio_contexts: BTreeMap<String, bool>,
    /// Deterministic state for `wx.createVideoContext` instances. The
    /// provider models transport, seeking and fullscreen/status-bar state;
    /// native providers own decoder, surfaces and platform resources.
    video_contexts: BTreeMap<String, VideoContextState>,
    destroyed_video_contexts: BTreeMap<String, bool>,
    /// Deterministic state for `wx.createCameraContext` instances. The
    /// sandbox keeps context lifetime and option validation observable, but
    /// never fabricates image/video paths or camera frames. Native providers
    /// replace the resource operations while preserving this command shape.
    camera_contexts: BTreeMap<String, CameraContextState>,
    destroyed_camera_contexts: BTreeMap<String, bool>,
    /// Deterministic WebSocket state.  The sandbox models connection,
    /// outbound messages and close transitions without opening a host socket;
    /// native providers can replace transport while preserving this command
    /// and result contract.
    sockets: BTreeMap<String, SocketState>,
    next_socket_id: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct SavedFileMetadata {
    create_time_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InnerAudioState {
    pub context_id: String,
    pub src: String,
    pub start_time: f64,
    pub autoplay: bool,
    pub looped: bool,
    pub volume: f64,
    pub playback_rate: f64,
    pub obey_mute_switch: bool,
    pub current_time: f64,
    pub duration: f64,
    pub paused: bool,
    pub buffered: f64,
    pub destroyed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VideoContextState {
    pub context_id: String,
    pub video_id: String,
    pub position: f64,
    pub duration: f64,
    pub playback_rate: f64,
    pub playing: bool,
    pub fullscreen: bool,
    pub status_bar_visible: bool,
    pub danmu: Vec<Value>,
    pub destroyed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CameraContextState {
    pub context_id: String,
    pub recording: bool,
    pub frame_streaming: bool,
    pub last_quality: String,
    pub record_timeout: u64,
    pub destroyed: bool,
}

impl CameraContextState {
    fn new(context_id: String) -> Self {
        Self {
            context_id,
            recording: false,
            frame_streaming: false,
            last_quality: "high".to_owned(),
            record_timeout: 30,
            destroyed: false,
        }
    }

    fn snapshot(&self, event: Option<&str>) -> Value {
        let mut value = json!({
            "contextId": self.context_id,
            "recording": self.recording,
            "frameStreaming": self.frame_streaming,
            "quality": self.last_quality,
            "timeout": self.record_timeout,
            "destroyed": self.destroyed,
            "errMsg": "cameraContext:ok",
        });
        if let Some(event) = event {
            value["event"] = Value::String(event.to_owned());
        }
        value
    }
}

impl VideoContextState {
    fn new(context_id: String, video_id: String) -> Self {
        Self {
            context_id,
            video_id,
            position: 0.0,
            duration: 0.0,
            playback_rate: 1.0,
            playing: false,
            fullscreen: false,
            status_bar_visible: true,
            danmu: Vec::new(),
            destroyed: false,
        }
    }

    fn snapshot(&self, event: Option<&str>) -> Value {
        let mut value = json!({
            "contextId": self.context_id,
            "videoId": self.video_id,
            "position": self.position,
            "duration": self.duration,
            "playbackRate": self.playback_rate,
            "playing": self.playing,
            "fullscreen": self.fullscreen,
            "statusBarVisible": self.status_bar_visible,
            "danmuCount": self.danmu.len(),
            "destroyed": self.destroyed,
            "errMsg": "createVideoContext:ok",
        });
        if let Some(event) = event {
            value["event"] = Value::String(event.to_owned());
        }
        value
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SocketState {
    pub socket_id: String,
    pub url: String,
    pub protocols: Vec<String>,
    pub ready_state: String,
    pub sent: Vec<Value>,
    pub close_code: Option<u16>,
    pub close_reason: String,
}

impl SocketState {
    fn new(socket_id: String, url: String, protocols: Vec<String>) -> Self {
        Self {
            socket_id,
            url,
            protocols,
            ready_state: "OPEN".to_owned(),
            sent: Vec::new(),
            close_code: None,
            close_reason: String::new(),
        }
    }
}

impl InnerAudioState {
    fn new(context_id: String) -> Self {
        Self {
            context_id,
            src: String::new(),
            start_time: 0.0,
            autoplay: false,
            looped: false,
            volume: 1.0,
            playback_rate: 1.0,
            obey_mute_switch: true,
            current_time: 0.0,
            duration: 0.0,
            paused: true,
            buffered: 0.0,
            destroyed: false,
        }
    }

    fn snapshot(&self, event: Option<&str>) -> Value {
        let mut value = json!({
            "contextId": self.context_id,
            "src": self.src,
            "startTime": self.start_time,
            "autoplay": self.autoplay,
            "loop": self.looped,
            "volume": self.volume,
            "playbackRate": self.playback_rate,
            "obeyMuteSwitch": self.obey_mute_switch,
            "currentTime": self.current_time,
            "duration": self.duration,
            "paused": self.paused,
            "buffered": self.buffered,
            "destroyed": self.destroyed,
            "errMsg": "innerAudioContext:ok",
        });
        if let Some(event) = event {
            value["event"] = Value::String(event.to_owned());
        }
        value
    }
}

impl Default for SandboxProvider {
    fn default() -> Self {
        Self {
            files: BTreeMap::new(),
            saved_files: BTreeMap::new(),
            responses: BTreeMap::new(),
            permissions: BTreeMap::new(),
            cancelled_tokens: BTreeMap::new(),
            clipboard: String::new(),
            device: DeviceState::default(),
            device_info: DeviceInfoSnapshot::default(),
            system_info: SystemInfoSnapshot::default(),
            battery_level: 100,
            battery_charging: false,
            screen_brightness: 1.0,
            system_setting: SystemSettingSnapshot::default(),
            subscription_setting: SubscriptionSettingSnapshot::default(),
            account_info: MiniProgramAccountInfo::default(),
            last_mini_program_redirect: None,
            last_share: None,
            last_payment: None,
            user_profile: UserProfileSnapshot::default(),
            login_code: "weapp-sandbox-login-code".to_owned(),
            account_session_valid: false,
            ext_config: json!({}),
            ui: UiState::default(),
            audio_contexts: BTreeMap::new(),
            destroyed_audio_contexts: BTreeMap::new(),
            video_contexts: BTreeMap::new(),
            destroyed_video_contexts: BTreeMap::new(),
            camera_contexts: BTreeMap::new(),
            destroyed_camera_contexts: BTreeMap::new(),
            sockets: BTreeMap::new(),
            next_socket_id: 0,
        }
    }
}

impl SandboxProvider {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_response(mut self, url: impl Into<String>, value: Value) -> Self {
        self.responses.insert(url.into(), value);
        self
    }

    pub fn grant(mut self, permission: impl Into<String>) -> Self {
        self.permissions.insert(permission.into(), true);
        self
    }

    /// Explicitly deny a capability in the deterministic sandbox. Network is
    /// allowed by default for backwards-compatible fixtures, while hosts can
    /// opt into deny-by-default by calling `deny("network")`.
    pub fn deny(mut self, permission: impl Into<String>) -> Self {
        self.permissions.insert(permission.into(), false);
        self
    }

    pub fn seed_file(mut self, path: impl Into<String>, bytes: impl Into<Vec<u8>>) -> Self {
        self.files
            .insert(normalize_path(&path.into()), bytes.into());
        self
    }

    pub fn clipboard(&self) -> &str {
        &self.clipboard
    }

    /// Configure the deterministic network snapshot used by
    /// `wx.getNetworkType`. The same closed set is accepted by native host
    /// adapters, so fixtures cannot accidentally depend on a browser-only
    /// network label.
    pub fn network_type(mut self, value: &str) -> Result<Self, ProviderError> {
        self.device.network_type = NetworkType::try_from(value)?;
        Ok(self)
    }

    /// Seed the keep-screen-on state without requiring a bridge call. This is
    /// useful when a host restores state after background/foreground changes.
    pub fn keep_screen_on(mut self, value: bool) -> Self {
        self.device.keep_screen_on = value;
        self
    }

    pub fn device_state(&self) -> &DeviceState {
        &self.device
    }

    /// Return the last validated cross-mini-program handoff accepted by the
    /// deterministic provider. Native hosts can use this request as the
    /// portable input to their own navigation surface.
    pub fn last_mini_program_redirect(&self) -> Option<&MiniProgramRedirectRequest> {
        self.last_mini_program_redirect.as_ref()
    }

    /// Return the last validated share request accepted by the deterministic
    /// provider. Native providers can use the same typed request to invoke
    /// their platform share surface and report its eventual lifecycle.
    pub fn last_share(&self) -> Option<&ShareRequest> {
        self.last_share.as_ref()
    }

    /// Return the last validated payment request accepted by the
    /// deterministic provider. Native providers can use the same request as
    /// the portable input to their payment boundary.
    pub fn last_payment(&self) -> Option<&PaymentRequest> {
        self.last_payment.as_ref()
    }

    /// Configure the deterministic snapshot returned by `wx.getDeviceInfo`.
    /// Native providers can populate the same fields from their platform
    /// device service without changing the synchronous bridge contract.
    pub fn with_device_info(mut self, snapshot: DeviceInfoSnapshot) -> Self {
        self.device_info = snapshot;
        self
    }

    /// Fallible variant for hosts that want to reject invalid device metadata
    /// while constructing their provider. Runtime calls validate the snapshot
    /// again so the compatibility builder cannot silently produce a success.
    pub fn try_with_device_info(self, snapshot: DeviceInfoSnapshot) -> Result<Self, ProviderError> {
        snapshot.validate()?;
        Ok(self.with_device_info(snapshot))
    }

    pub fn device_info_snapshot(&self) -> &DeviceInfoSnapshot {
        &self.device_info
    }

    /// Configure the provider-owned part of the `wx.getSystemInfo*` snapshot.
    /// Host geometry and platform values continue to come from
    /// [`ProviderContext::host`].
    pub fn with_system_info(mut self, snapshot: SystemInfoSnapshot) -> Result<Self, ProviderError> {
        snapshot.validate()?;
        self.system_info = snapshot;
        Ok(self)
    }

    pub fn system_info_snapshot(&self) -> &SystemInfoSnapshot {
        &self.system_info
    }

    /// Return the latest deterministic UI state for host adapters and tests.
    pub fn ui_state(&self) -> &UiState {
        &self.ui
    }

    /// Configure the deterministic battery snapshot returned by
    /// `wx.getBatteryInfo`. Native providers can source the same shape from
    /// the host battery service instead.
    pub fn battery(mut self, level: u8, is_charging: bool) -> Self {
        self.battery_level = level.min(100);
        self.battery_charging = is_charging;
        self
    }

    /// Configure the deterministic screen brightness snapshot. Values are
    /// normalized to the API's inclusive 0..=1 range; invalid values are
    /// rejected so fixtures cannot accidentally claim a valid host result.
    pub fn screen_brightness(mut self, value: f64) -> Result<Self, ProviderError> {
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err(ProviderError::invalid(
                "wx.setScreenBrightness value must be a finite number between 0 and 1",
            ));
        }
        self.screen_brightness = value;
        Ok(self)
    }

    pub fn screen_brightness_value(&self) -> f64 {
        self.screen_brightness
    }

    /// Configure the deterministic synchronous system-setting snapshot.
    /// Native providers can source the same fields from Bluetooth, location,
    /// Wi-Fi and device-orientation services.
    pub fn with_system_setting(mut self, snapshot: SystemSettingSnapshot) -> Self {
        self.system_setting = snapshot;
        self
    }

    pub fn system_setting_snapshot(&self) -> &SystemSettingSnapshot {
        &self.system_setting
    }

    /// Configure the deterministic subscription authorization snapshot used
    /// when `withSubscriptions` is requested by `wx.getSetting` or
    /// `wx.openSetting`.
    pub fn with_subscription_setting(
        mut self,
        snapshot: SubscriptionSettingSnapshot,
    ) -> Result<Self, ProviderError> {
        snapshot.validate()?;
        self.subscription_setting = snapshot;
        Ok(self)
    }

    pub fn subscription_setting_snapshot(&self) -> &SubscriptionSettingSnapshot {
        &self.subscription_setting
    }

    /// Configure the deterministic mini-program account snapshot returned by
    /// `wx.getAccountInfoSync`.
    pub fn with_account_info(
        mut self,
        app_id: impl Into<String>,
        env_version: impl Into<String>,
        version: impl Into<String>,
    ) -> Self {
        self.account_info = MiniProgramAccountInfo {
            app_id: app_id.into(),
            env_version: env_version.into(),
            version: version.into(),
        };
        self
    }

    pub fn account_info_snapshot(&self) -> &MiniProgramAccountInfo {
        &self.account_info
    }

    /// Configure the deterministic `wx.getUserProfile` result used by
    /// conformance fixtures.  The profile is returned only when the host has
    /// explicitly granted the `profile` permission.
    pub fn with_user_profile(mut self, profile: UserProfileSnapshot) -> Self {
        self.user_profile = profile;
        self
    }

    pub fn user_profile_snapshot(&self) -> &UserProfileSnapshot {
        &self.user_profile
    }

    /// Configure the deterministic code returned by `wx.login`.
    ///
    /// Native providers can replace this with a platform-issued code while
    /// preserving the same provider and bridge result shape. Empty values
    /// are ignored so the sandbox never returns a malformed successful code.
    pub fn with_login_code(mut self, code: impl Into<String>) -> Self {
        let code = code.into();
        if !code.trim().is_empty() {
            self.login_code = code;
        }
        self
    }

    /// Seed whether the sandbox account session is currently valid. This is
    /// useful when a host restores a persisted login before app startup.
    pub fn with_account_session(mut self, valid: bool) -> Self {
        self.account_session_valid = valid;
        self
    }

    /// Return the current deterministic account-session state for host
    /// adapters and conformance assertions.
    pub fn account_session_valid(&self) -> bool {
        self.account_session_valid
    }

    /// Configure the deterministic extension configuration returned by
    /// `wx.getExtConfigSync` and `wx.getExtConfig`.
    pub fn with_ext_config(mut self, value: Value) -> Self {
        self.ext_config = value;
        self
    }

    pub fn ext_config_snapshot(&self) -> &ExtConfigSnapshot {
        &self.ext_config
    }

    /// Return a deterministic audio-context snapshot for conformance tests.
    /// The method intentionally exposes state only; audio output remains a
    /// host concern and is never fabricated by the sandbox.
    pub fn inner_audio_state(&self, context_id: &str) -> Option<&InnerAudioState> {
        self.audio_contexts.get(context_id)
    }

    /// Return the latest deterministic video-context state for conformance
    /// tests and host adapters. The actual decoder/surface remains host-owned.
    pub fn video_state(&self, context_id: &str) -> Option<&VideoContextState> {
        self.video_contexts.get(context_id)
    }

    /// Return the latest deterministic camera-context state for conformance
    /// tests and host adapters. Camera acquisition remains host-owned.
    pub fn camera_state(&self, context_id: &str) -> Option<&CameraContextState> {
        self.camera_contexts.get(context_id)
    }

    /// Return a deterministic socket snapshot for conformance tests and host
    /// adapters.  Socket transport itself remains provider-owned.
    pub fn socket_state(&self, socket_id: &str) -> Option<&SocketState> {
        self.sockets.get(socket_id)
    }

    fn permitted(&self, permission: &str) -> bool {
        self.permissions.get(permission).copied().unwrap_or(false)
    }

    fn scope_permission(scope: &str) -> Option<&'static str> {
        match scope {
            "scope.userLocation" | "scope.userLocationBackground" => Some("location"),
            "scope.camera" | "scope.record" | "scope.writePhotosAlbum" => Some("photos/camera"),
            "scope.userInfo" => Some("profile"),
            _ => None,
        }
    }

    fn scope_permitted(&self, scope: &str) -> bool {
        self.permitted(scope)
            || Self::scope_permission(scope).is_some_and(|permission| self.permitted(permission))
    }

    fn permission_settings(&self) -> Map<String, Value> {
        [
            "scope.userLocation",
            "scope.userLocationBackground",
            "scope.camera",
            "scope.record",
            "scope.writePhotosAlbum",
            "scope.userInfo",
        ]
        .into_iter()
        .map(|scope| (scope.to_owned(), Value::Bool(self.scope_permitted(scope))))
        .collect()
    }

    fn subscription_settings(&self) -> Result<Value, ProviderError> {
        self.subscription_setting.validate()?;
        serde_json::to_value(&self.subscription_setting).map_err(|error| {
            ProviderError::invalid(format!(
                "wx.getSetting subscription snapshot serialization failed: {error}"
            ))
        })
    }

    fn app_authorize_status(&self, permission: &str) -> Value {
        match self.permissions.get(permission).copied() {
            Some(true) => Value::String("authorized".into()),
            Some(false) => Value::String("denied".into()),
            None => Value::String("not determined".into()),
        }
    }

    fn app_authorize_settings(&self) -> Value {
        json!({
            "cameraAuthorized": self.app_authorize_status("photos/camera"),
            "locationAuthorized": self.app_authorize_status("location"),
            "microphoneAuthorized": self.app_authorize_status("microphone"),
            "notificationAuthorized": self.app_authorize_status("notification"),
            "notificationAlertAuthorized": self.app_authorize_status("notification"),
            "notificationBadgeAuthorized": self.app_authorize_status("notification"),
            "notificationSoundAuthorized": self.app_authorize_status("notification"),
            "albumAuthorized": self.app_authorize_status("photos/camera"),
        })
    }

    fn network_permitted(&self) -> bool {
        self.permissions.get("network").copied().unwrap_or(true)
    }

    fn check_network_context(
        &self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<(), ProviderError> {
        self.check_operation_context(name, payload, context)?;
        if !self.network_permitted() {
            return Err(ProviderError::permission("network"));
        }
        Ok(())
    }

    /// Check cancellation and deadline state at the provider boundary.  This
    /// is shared by operations that do not use the network (for example
    /// location), so a host cannot accidentally turn a cancelled/deadline
    /// expired request into a successful sandbox value.
    fn check_operation_context(
        &self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<(), ProviderError> {
        if context.cancelled
            || context
                .cancel_token
                .as_deref()
                .is_some_and(|token| self.cancelled_tokens.get(token).copied().unwrap_or(false))
        {
            return Err(ProviderError::cancelled(format!(
                "{name}:fail request cancelled"
            )));
        }
        if context
            .deadline_ns
            .is_some_and(|deadline| deadline <= context.now_ns)
        {
            return Err(ProviderError::timeout(format!(
                "{name}:fail deadline exceeded"
            )));
        }
        if payload
            .get("cancelToken")
            .or_else(|| payload.get("cancel_token"))
            .and_then(Value::as_str)
            .is_some_and(|token| self.cancelled_tokens.get(token).copied().unwrap_or(false))
        {
            return Err(ProviderError::cancelled(format!(
                "{name}:fail request cancelled"
            )));
        }
        Ok(())
    }

    fn location_call(
        &self,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context("wx.getLocation", payload, context)?;

        let _location_type = match payload.get("type") {
            None => "wgs84",
            Some(Value::String(value)) if matches!(value.as_str(), "wgs84" | "gcj02") => value,
            Some(Value::String(value)) => {
                return Err(ProviderError::invalid(format!(
                    "wx.getLocation type must be wgs84 or gcj02, got {value}"
                )))
            }
            Some(_) => {
                return Err(ProviderError::invalid(
                    "wx.getLocation type must be a string",
                ))
            }
        };
        let _altitude = match payload.get("altitude") {
            None => false,
            Some(Value::Bool(value)) => *value,
            Some(_) => {
                return Err(ProviderError::invalid(
                    "wx.getLocation altitude must be a boolean",
                ))
            }
        };

        if !self.permitted("location") {
            return Err(ProviderError::permission("location"));
        }

        // The sandbox intentionally returns a zero coordinate.  It still
        // emits the documented result shape so callers can exercise the same
        // parsing and permission/error paths as a native provider without
        // exposing a fabricated host position.
        Ok(json!({
            "latitude": 0.0,
            "longitude": 0.0,
            "speed": 0.0,
            "accuracy": 0.0,
            "verticalAccuracy": 0.0,
            "horizontalAccuracy": 0.0,
            "altitude": 0.0,
            "errMsg": "getLocation:ok",
        }))
    }

    fn location_updates_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context(name, payload, context)?;
        if !self.permitted("location") {
            return Err(ProviderError::permission("location"));
        }
        if name == "wx.startLocationUpdate" {
            if let Some(value) = payload.get("type") {
                let value = value.as_str().ok_or_else(|| {
                    ProviderError::invalid("wx.startLocationUpdate type must be a string")
                })?;
                if !matches!(value, "wgs84" | "gcj02") {
                    return Err(ProviderError::invalid(
                        "wx.startLocationUpdate type must be wgs84 or gcj02",
                    ));
                }
            }
            self.device.location_updates = true;
            return Ok(json!({"errMsg": "startLocationUpdate:ok"}));
        }
        self.device.location_updates = false;
        Ok(json!({"errMsg": "stopLocationUpdate:ok"}))
    }

    fn scan_code_call(
        &self,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context("wx.scanCode", payload, context)?;
        if !self.permitted("photos/camera") {
            return Err(ProviderError::permission("photos/camera"));
        }
        if let Some(value) = payload.get("onlyFromCamera") {
            if !value.is_boolean() {
                return Err(ProviderError::invalid(
                    "wx.scanCode onlyFromCamera must be a boolean",
                ));
            }
        }
        if let Some(value) = payload.get("scanType") {
            let values = value
                .as_array()
                .ok_or_else(|| ProviderError::invalid("wx.scanCode scanType must be an array"))?;
            const ALLOWED: &[&str] = &["barCode", "qrCode", "datamatrix", "pdf417"];
            if values.is_empty()
                || values
                    .iter()
                    .any(|item| item.as_str().is_none_or(|item| !ALLOWED.contains(&item)))
            {
                return Err(ProviderError::invalid(
                    "wx.scanCode scanType contains an unsupported value",
                ));
            }
        }
        // The sandbox has no camera or decoder. Return the complete public
        // result shape with an empty payload so hosts can replace only the
        // resource acquisition and preserve the bridge/error contract.
        Ok(json!({
            "result": "",
            "scanType": "QR_CODE",
            "charSet": "utf-8",
            "path": "",
            "rawData": "",
            "errMsg": "scanCode:ok",
        }))
    }

    /// Validate media-picker options at the provider boundary and return the
    /// complete documented result shape.  The sandbox intentionally has no
    /// host camera or photo library, so a granted request yields an empty
    /// selection.  Keeping option validation here means native providers can
    /// reuse the same error contract while replacing only the resource
    /// selection and file lifetime implementation.
    fn media_picker_call(
        &self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context(name, payload, context)?;
        if !self.permitted("photos/camera") {
            return Err(ProviderError::permission("photos/camera"));
        }

        let _count = match payload.get("count") {
            // Both picker APIs default to the maximum selection count in the
            // WeChat runtime when the option is omitted.
            None => 9_u64,
            Some(Value::Number(value)) => value
                .as_u64()
                .filter(|value| (1..=9).contains(value))
                .ok_or_else(|| {
                    ProviderError::invalid(format!(
                        "{name} count must be an integer between 1 and 9"
                    ))
                })?,
            Some(_) => {
                return Err(ProviderError::invalid(format!(
                    "{name} count must be an integer between 1 and 9"
                )))
            }
        };

        fn string_options(
            payload: &Map<String, Value>,
            key: &str,
            allowed: &[&str],
            name: &str,
        ) -> Result<(), ProviderError> {
            let Some(value) = payload.get(key) else {
                return Ok(());
            };
            let values = value
                .as_array()
                .ok_or_else(|| ProviderError::invalid(format!("{name} {key} must be an array")))?;
            if values.is_empty()
                || values
                    .iter()
                    .any(|item| item.as_str().is_none_or(|item| !allowed.contains(&item)))
            {
                return Err(ProviderError::invalid(format!(
                    "{name} {key} contains an unsupported value"
                )));
            }
            Ok(())
        }

        if name == "wx.chooseMedia" {
            string_options(payload, "mediaType", &["image", "video", "mix"], name)?;
            string_options(payload, "sourceType", &["album", "camera"], name)?;
            if let Some(camera) = payload.get("camera") {
                let camera = camera.as_str().ok_or_else(|| {
                    ProviderError::invalid("wx.chooseMedia camera must be front or back")
                })?;
                if !matches!(camera, "front" | "back") {
                    return Err(ProviderError::invalid(
                        "wx.chooseMedia camera must be front or back",
                    ));
                }
            }
        } else {
            string_options(payload, "sizeType", &["original", "compressed"], name)?;
            string_options(payload, "sourceType", &["album", "camera"], name)?;
        }

        Ok(json!({
            "tempFiles": [],
            "tempFilePaths": [],
            "errMsg": format!("{name}:ok"),
        }))
    }

    /// Execute one command for a `wx.createInnerAudioContext` instance.
    ///
    /// The sandbox models the observable state machine (source, transport,
    /// seeking and playback properties) but never claims to decode or output
    /// audio. A native provider can consume the same command payload and
    /// return real duration/buffer progress without changing the JS facade.
    fn inner_audio_call(
        &mut self,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context("wx.innerAudioContext", payload, context)?;
        let context_id = payload
            .get("contextId")
            .or_else(|| payload.get("context_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ProviderError::invalid("wx.innerAudioContext contextId is required"))?
            .to_owned();
        let command = payload
            .get("command")
            .or_else(|| payload.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("snapshot");

        if command == "create" {
            if self
                .destroyed_audio_contexts
                .get(&context_id)
                .copied()
                .unwrap_or(false)
            {
                return Err(ProviderError::invalid(
                    "wx.innerAudioContext context has been destroyed",
                ));
            }
            let state = self
                .audio_contexts
                .entry(context_id.clone())
                .or_insert_with(|| InnerAudioState::new(context_id.clone()));
            return Ok(state.snapshot(None));
        }

        if command == "destroy" {
            let mut state = self
                .audio_contexts
                .remove(&context_id)
                .unwrap_or_else(|| InnerAudioState::new(context_id.clone()));
            state.destroyed = true;
            self.destroyed_audio_contexts.insert(context_id, true);
            return Ok(state.snapshot(Some("destroy")));
        }

        if self
            .destroyed_audio_contexts
            .get(&context_id)
            .copied()
            .unwrap_or(false)
        {
            return Err(ProviderError::invalid(
                "wx.innerAudioContext context has been destroyed",
            ));
        }

        let state = self
            .audio_contexts
            .entry(context_id.clone())
            .or_insert_with(|| InnerAudioState::new(context_id));
        if state.destroyed {
            return Err(ProviderError::invalid(
                "wx.innerAudioContext context has been destroyed",
            ));
        }

        if command == "set" {
            if let Some(value) = payload.get("src") {
                state.src = value
                    .as_str()
                    .ok_or_else(|| {
                        ProviderError::invalid("innerAudioContext src must be a string")
                    })?
                    .to_owned();
            }
            if let Some(value) = payload.get("startTime") {
                state.start_time = nonnegative_number(value, "innerAudioContext startTime")?;
            }
            if let Some(value) = payload.get("autoplay") {
                state.autoplay = value.as_bool().ok_or_else(|| {
                    ProviderError::invalid("innerAudioContext autoplay must be a boolean")
                })?;
            }
            if let Some(value) = payload.get("loop") {
                state.looped = value.as_bool().ok_or_else(|| {
                    ProviderError::invalid("innerAudioContext loop must be a boolean")
                })?;
            }
            if let Some(value) = payload.get("volume") {
                let volume = nonnegative_number(value, "innerAudioContext volume")?;
                if volume > 1.0 {
                    return Err(ProviderError::invalid(
                        "innerAudioContext volume must be between 0 and 1",
                    ));
                }
                state.volume = volume;
            }
            if let Some(value) = payload.get("playbackRate") {
                let rate = nonnegative_number(value, "innerAudioContext playbackRate")?;
                if !(0.5..=2.0).contains(&rate) {
                    return Err(ProviderError::invalid(
                        "innerAudioContext playbackRate must be between 0.5 and 2",
                    ));
                }
                state.playback_rate = rate;
            }
            if let Some(value) = payload.get("obeyMuteSwitch") {
                state.obey_mute_switch = value.as_bool().ok_or_else(|| {
                    ProviderError::invalid("innerAudioContext obeyMuteSwitch must be a boolean")
                })?;
            }
            return Ok(state.snapshot(Some("set")));
        }

        let event = match command {
            "play" => {
                if state.src.trim().is_empty() {
                    return Err(ProviderError::invalid(
                        "innerAudioContext play requires src",
                    ));
                }
                state.paused = false;
                state.current_time = state.start_time;
                "play"
            }
            "pause" => {
                state.paused = true;
                "pause"
            }
            "stop" => {
                state.paused = true;
                state.current_time = 0.0;
                "stop"
            }
            "seek" => {
                let position = payload.get("position").ok_or_else(|| {
                    ProviderError::invalid("innerAudioContext seek requires position")
                })?;
                state.current_time = nonnegative_number(position, "innerAudioContext position")?;
                "seeked"
            }
            "snapshot" => return Ok(state.snapshot(None)),
            _ => {
                return Err(ProviderError::invalid(format!(
                    "innerAudioContext command {command} is unsupported"
                )))
            }
        };
        Ok(state.snapshot(Some(event)))
    }

    /// Execute one command for a `wx.createCameraContext` instance.
    ///
    /// Context creation and state transitions are deterministic and observable
    /// in the sandbox. Camera acquisition is deliberately host-owned: after
    /// permission and option validation, takePhoto/startRecord/stopRecord and
    /// frame streaming return a structured unsupported error instead of
    /// claiming a fabricated path or image buffer.
    fn camera_context_call(
        &mut self,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context("wx.cameraContext", payload, context)?;
        let context_id = payload
            .get("contextId")
            .or_else(|| payload.get("context_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ProviderError::invalid("wx.createCameraContext contextId is required"))?
            .to_owned();
        let command = payload
            .get("command")
            .or_else(|| payload.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("snapshot");

        if command == "create" {
            if self
                .destroyed_camera_contexts
                .get(&context_id)
                .copied()
                .unwrap_or(false)
            {
                return Err(ProviderError::invalid(
                    "wx.createCameraContext context has been destroyed",
                ));
            }
            let state = self
                .camera_contexts
                .entry(context_id.clone())
                .or_insert_with(|| CameraContextState::new(context_id.clone()));
            return Ok(state.snapshot(None));
        }

        if command == "destroy" {
            let mut state = self.camera_contexts.remove(&context_id).ok_or_else(|| {
                ProviderError::invalid("wx.createCameraContext context not found")
            })?;
            state.destroyed = true;
            self.destroyed_camera_contexts.insert(context_id, true);
            return Ok(state.snapshot(Some("destroy")));
        }

        if self
            .destroyed_camera_contexts
            .get(&context_id)
            .copied()
            .unwrap_or(false)
        {
            return Err(ProviderError::invalid(
                "wx.createCameraContext context has been destroyed",
            ));
        }
        let camera_permitted = self.permitted("photos/camera");
        let state = self.camera_contexts.get_mut(&context_id).ok_or_else(|| {
            ProviderError::invalid("wx.createCameraContext context is not created")
        })?;
        if state.destroyed {
            return Err(ProviderError::invalid(
                "wx.createCameraContext context has been destroyed",
            ));
        }

        match command {
            "snapshot" => Ok(state.snapshot(None)),
            "takePhoto" => {
                if !camera_permitted {
                    return Err(ProviderError::permission("photos/camera"));
                }
                let quality = payload
                    .get("quality")
                    .map(|value| {
                        value.as_str().ok_or_else(|| {
                            ProviderError::invalid(
                                "wx.createCameraContext takePhoto quality must be high, normal, or low",
                            )
                        })
                    })
                    .transpose()?
                    .unwrap_or("high");
                if !matches!(quality, "high" | "normal" | "low") {
                    return Err(ProviderError::invalid(
                        "wx.createCameraContext takePhoto quality must be high, normal, or low",
                    ));
                }
                state.last_quality = quality.to_owned();
                Err(ProviderError {
                    code: ProviderErrorCode::Unsupported,
                    message: "wx.createCameraContext takePhoto requires a host camera provider"
                        .to_owned(),
                    retryable: false,
                })
            }
            "startRecord" => {
                if !camera_permitted {
                    return Err(ProviderError::permission("photos/camera"));
                }
                let timeout = payload
                    .get("timeout")
                    .map(|value| {
                        value.as_u64().filter(|value| (1..=60).contains(value)).ok_or_else(|| {
                            ProviderError::invalid(
                                "wx.createCameraContext startRecord timeout must be an integer between 1 and 60",
                            )
                        })
                    })
                    .transpose()?
                    .unwrap_or(30);
                state.record_timeout = timeout;
                Err(ProviderError {
                    code: ProviderErrorCode::Unsupported,
                    message: "wx.createCameraContext startRecord requires a host camera provider"
                        .to_owned(),
                    retryable: false,
                })
            }
            "stopRecord" => {
                if !camera_permitted {
                    return Err(ProviderError::permission("photos/camera"));
                }
                Err(ProviderError {
                    code: ProviderErrorCode::Unsupported,
                    message: "wx.createCameraContext stopRecord requires a host camera provider"
                        .to_owned(),
                    retryable: false,
                })
            }
            "frameStart" | "frameStop" => {
                if !camera_permitted {
                    return Err(ProviderError::permission("photos/camera"));
                }
                Err(ProviderError {
                    code: ProviderErrorCode::Unsupported,
                    message: "wx.createCameraContext onCameraFrame requires a host camera provider"
                        .to_owned(),
                    retryable: false,
                })
            }
            _ => Err(ProviderError::invalid(format!(
                "wx.createCameraContext command {command} is unsupported"
            ))),
        }
    }

    /// Execute one command for a `wx.createVideoContext` instance. The
    /// sandbox keeps transport and UI state deterministic while native hosts
    /// provide decoder, surface, fullscreen and orientation integration.
    fn video_context_call(
        &mut self,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context("wx.videoContext", payload, context)?;
        let context_id = payload
            .get("contextId")
            .or_else(|| payload.get("context_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ProviderError::invalid("wx.createVideoContext contextId is required"))?
            .to_owned();
        let command = payload
            .get("command")
            .or_else(|| payload.get("action"))
            .and_then(Value::as_str)
            .unwrap_or("snapshot");
        if command == "create" {
            if self
                .destroyed_video_contexts
                .get(&context_id)
                .copied()
                .unwrap_or(false)
            {
                return Err(ProviderError::invalid(
                    "wx.createVideoContext context has been destroyed",
                ));
            }
            let video_id = payload
                .get("videoId")
                .or_else(|| payload.get("video_id"))
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| ProviderError::invalid("wx.createVideoContext videoId is required"))?
                .to_owned();
            let state = self
                .video_contexts
                .entry(context_id.clone())
                .or_insert_with(|| VideoContextState::new(context_id.clone(), video_id));
            return Ok(state.snapshot(None));
        }
        if command == "destroy" {
            let mut state = self
                .video_contexts
                .remove(&context_id)
                .ok_or_else(|| ProviderError::invalid("wx.createVideoContext context not found"))?;
            state.destroyed = true;
            self.destroyed_video_contexts.insert(context_id, true);
            return Ok(state.snapshot(Some("destroy")));
        }
        if self
            .destroyed_video_contexts
            .get(&context_id)
            .copied()
            .unwrap_or(false)
        {
            return Err(ProviderError::invalid(
                "wx.createVideoContext context has been destroyed",
            ));
        }
        let state = self.video_contexts.get_mut(&context_id).ok_or_else(|| {
            ProviderError::invalid("wx.createVideoContext context is not created")
        })?;
        let event = match command {
            "play" => {
                state.playing = true;
                "play"
            }
            "pause" => {
                state.playing = false;
                "pause"
            }
            "stop" => {
                state.playing = false;
                state.position = 0.0;
                "stop"
            }
            "seek" => {
                let position = payload.get("position").ok_or_else(|| {
                    ProviderError::invalid("wx.createVideoContext seek requires position")
                })?;
                state.position = nonnegative_number(position, "video position")?;
                "seeked"
            }
            "playbackRate" => {
                let rate = payload.get("rate").ok_or_else(|| {
                    ProviderError::invalid("wx.createVideoContext playbackRate requires rate")
                })?;
                let rate = nonnegative_number(rate, "video playbackRate")?;
                if !(0.5..=2.0).contains(&rate) {
                    return Err(ProviderError::invalid(
                        "wx.createVideoContext playbackRate must be between 0.5 and 2",
                    ));
                }
                state.playback_rate = rate;
                "playbackRate"
            }
            "sendDanmu" => {
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.createVideoContext sendDanmu requires text")
                    })?;
                let mut item = json!({"text": text});
                if let Some(color) = payload.get("color") {
                    let color = color.as_str().ok_or_else(|| {
                        ProviderError::invalid("wx.createVideoContext danmu color must be a string")
                    })?;
                    item["color"] = Value::String(color.to_owned());
                }
                state.danmu.push(item);
                "sendDanmu"
            }
            "requestFullScreen" => {
                if let Some(direction) = payload.get("direction") {
                    let direction = direction.as_str().ok_or_else(|| {
                        ProviderError::invalid(
                            "wx.createVideoContext direction must be horizontal or vertical",
                        )
                    })?;
                    if !matches!(direction, "horizontal" | "vertical") {
                        return Err(ProviderError::invalid(
                            "wx.createVideoContext direction must be horizontal or vertical",
                        ));
                    }
                }
                state.fullscreen = true;
                "fullscreenchange"
            }
            "exitFullScreen" => {
                state.fullscreen = false;
                "fullscreenchange"
            }
            "showStatusBar" => {
                state.status_bar_visible = true;
                "showStatusBar"
            }
            "hideStatusBar" => {
                state.status_bar_visible = false;
                "hideStatusBar"
            }
            "snapshot" => return Ok(state.snapshot(None)),
            _ => {
                return Err(ProviderError::invalid(format!(
                    "wx.createVideoContext command {command} is unsupported"
                )))
            }
        };
        Ok(state.snapshot(Some(event)))
    }

    fn ui_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context(name, payload, context)?;
        match name {
            "wx.showToast" => {
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| ProviderError::invalid("wx.showToast requires title"))?;
                let icon = payload
                    .get("icon")
                    .and_then(Value::as_str)
                    .unwrap_or("success");
                if !matches!(icon, "success" | "error" | "loading" | "none") {
                    return Err(ProviderError::invalid(
                        "wx.showToast icon must be success, error, loading, or none",
                    ));
                }
                let duration = payload
                    .get("duration")
                    .and_then(Value::as_u64)
                    .unwrap_or(1500)
                    .min(10_000);
                self.ui.toast = Some(json!({
                    "title": title,
                    "icon": icon,
                    "duration": duration,
                    "mask": payload.get("mask").and_then(Value::as_bool).unwrap_or(false),
                }));
                Ok(json!({"errMsg": "showToast:ok"}))
            }
            "wx.hideToast" => {
                self.ui.toast = None;
                Ok(json!({"errMsg": "hideToast:ok"}))
            }
            "wx.showLoading" => {
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| ProviderError::invalid("wx.showLoading requires title"))?;
                self.ui.loading = Some(json!({
                    "title": title,
                    "mask": payload.get("mask").and_then(Value::as_bool).unwrap_or(false),
                }));
                Ok(json!({"errMsg": "showLoading:ok"}))
            }
            "wx.hideLoading" => {
                self.ui.loading = None;
                Ok(json!({"errMsg": "hideLoading:ok"}))
            }
            "wx.showModal" => {
                let content = payload
                    .get("content")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::invalid("wx.showModal requires content"))?;
                let title = payload.get("title").and_then(Value::as_str).unwrap_or("");
                let show_cancel = payload
                    .get("showCancel")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let result =
                    json!({"confirm": true, "cancel": !show_cancel, "errMsg": "showModal:ok"});
                self.ui.modal = Some(json!({
                    "title": title,
                    "content": content,
                    "showCancel": show_cancel,
                    "result": result,
                }));
                Ok(result)
            }
            "wx.showActionSheet" => {
                let items = payload
                    .get("itemList")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.showActionSheet requires itemList")
                    })?;
                if items.is_empty() || items.iter().any(|item| item.as_str().is_none()) {
                    return Err(ProviderError::invalid(
                        "wx.showActionSheet itemList must contain at least one string",
                    ));
                }
                let result = json!({"tapIndex": 0, "errMsg": "showActionSheet:ok"});
                self.ui.action_sheet = Some(json!({"itemList": items, "result": result}));
                Ok(result)
            }
            // Scrolling is a Session/View mutation. A provider cannot claim
            // success by recording an intention without publishing pixels.
            "wx.pageScrollTo" => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: "wx.pageScrollTo requires the session scrolling dispatcher".into(),
                retryable: false,
            }),
            "wx.setNavigationBarColor" => {
                let front = payload
                    .get("frontColor")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.setNavigationBarColor requires frontColor")
                    })?;
                let background = payload
                    .get("backgroundColor")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.setNavigationBarColor requires backgroundColor")
                    })?;
                if !is_hex_color(front) || !is_hex_color(background) {
                    return Err(ProviderError::invalid(
                        "wx.setNavigationBarColor colors must be #RRGGBB",
                    ));
                }
                self.ui.navigation_bar = Some(json!({
                    "frontColor": front,
                    "backgroundColor": background,
                    "animation": payload.get("animation").cloned().unwrap_or(Value::Null),
                }));
                Ok(json!({"errMsg": "setNavigationBarColor:ok"}))
            }
            "wx.setNavigationBarTitle" => {
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.setNavigationBarTitle requires title")
                    })?;
                self.ui.navigation_bar_title = Some(title.to_owned());
                Ok(json!({"errMsg": "setNavigationBarTitle:ok"}))
            }
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("provider {name} is not implemented"),
                retryable: false,
            }),
        }
    }

    fn network_response(&self, name: &str, url: &str, method: &str) -> Value {
        let seeded = self.responses.get(url);
        // A seeded object with response metadata is treated as a complete
        // deterministic response. A plain value remains the response body,
        // preserving the original `with_response(url, value)` contract.
        let metadata = seeded.and_then(Value::as_object).filter(|object| {
            object.contains_key("statusCode")
                || object.contains_key("status_code")
                || object.contains_key("header")
                || object.contains_key("cookies")
                || object.contains_key("data")
                || object.contains_key("errMsg")
        });
        let status_code = metadata
            .and_then(|object| {
                object
                    .get("statusCode")
                    .or_else(|| object.get("status_code"))
            })
            .and_then(Value::as_u64)
            .unwrap_or(200);
        let header = metadata
            .and_then(|object| object.get("header"))
            .cloned()
            .unwrap_or_else(|| json!({}));
        let cookies = metadata
            .and_then(|object| object.get("cookies"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        let data = metadata
            .and_then(|object| object.get("data"))
            .cloned()
            .or_else(|| seeded.cloned())
            .unwrap_or_else(|| {
                json!({
                    "url": url,
                    "method": method,
                })
            });
        let public_name = name.strip_prefix("wx.").unwrap_or(name);
        let err_msg = metadata
            .and_then(|object| object.get("errMsg"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{public_name}:ok"));
        json!({
            "statusCode": status_code,
            "header": header,
            "cookies": cookies,
            "data": data,
            "errMsg": err_msg,
        })
    }

    /// Match the simulator's request method normalization.  The public
    /// runtime treats an omitted or empty method as GET and compares methods
    /// case-insensitively after trimming surrounding whitespace.  Keeping the
    /// normalized value in the deterministic response also gives fixtures a
    /// stable way to observe the same request semantics across engines.
    fn request_method(payload: &Map<String, Value>) -> Result<String, ProviderError> {
        let Some(value) = payload.get("method") else {
            return Ok("GET".to_owned());
        };
        let Some(value) = value.as_str() else {
            return Err(ProviderError::invalid("wx.request method must be a string"));
        };
        let method = value.trim();
        if method.is_empty() {
            return Ok("GET".to_owned());
        }
        Ok(method.to_ascii_uppercase())
    }

    fn upload_data_string(value: Option<&Value>) -> String {
        match value {
            None | Some(Value::Null) => String::new(),
            Some(Value::String(value)) => value.clone(),
            Some(Value::Bool(value)) => value.to_string(),
            Some(Value::Number(value)) => value.to_string(),
            // The simulator uses JavaScript String(value): arrays join with
            // commas and plain objects become "[object Object]".
            Some(Value::Array(values)) => values
                .iter()
                .map(|value| Self::upload_data_string(Some(value)))
                .collect::<Vec<_>>()
                .join(","),
            Some(Value::Object(_)) => "[object Object]".to_owned(),
        }
    }

    fn upload_response(&self, url: &str) -> Value {
        let response = self.network_response("wx.uploadFile", url, "POST");
        let object = response.as_object();
        json!({
            "data": Self::upload_data_string(object.and_then(|value| value.get("data"))),
            "errMsg": object
                .and_then(|value| value.get("errMsg"))
                .and_then(Value::as_str)
                .unwrap_or("uploadFile:ok"),
            "statusCode": object
                .and_then(|value| value.get("statusCode"))
                .and_then(Value::as_u64)
                .unwrap_or(200),
        })
    }

    fn download_response(response: &Value, temp_file_path: String) -> Value {
        let object = response.as_object();
        json!({
            "errMsg": object
                .and_then(|value| value.get("errMsg"))
                .and_then(Value::as_str)
                .unwrap_or("downloadFile:ok"),
            "statusCode": object
                .and_then(|value| value.get("statusCode"))
                .and_then(Value::as_u64)
                .unwrap_or(200),
            "tempFilePath": temp_file_path,
        })
    }

    fn network_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_network_context(name, payload, context)?;
        let url = payload
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| ProviderError::invalid(format!("{name} requires url")))?;
        if url.starts_with("timeout:") {
            return Err(ProviderError::timeout(format!("{name}:fail timeout")));
        }
        if url.starts_with("deny:") {
            return Err(ProviderError::permission("network"));
        }
        let method = Self::request_method(payload)?;
        match name {
            "wx.request" => Ok(self.network_response(name, url, &method)),
            "wx.uploadFile" => {
                let file_path = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                    .map(normalize_path)
                    .ok_or_else(|| ProviderError::invalid("wx.uploadFile requires filePath"))?;
                let field_name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty())
                    .ok_or_else(|| ProviderError::invalid("wx.uploadFile requires name"))?;
                let bytes = self.files.get(&file_path).ok_or_else(|| {
                    ProviderError::invalid(format!("wx.uploadFile file not found: {file_path}"))
                })?;
                // Keep the local variables above as validation inputs only;
                // wx.uploadFile's success result intentionally exposes no
                // request metadata such as the form name, path, or byte
                // count.  Those fields belong in host diagnostics, not the
                // public callback result.
                let _ = (field_name, bytes);
                Ok(self.upload_response(url))
            }
            "wx.downloadFile" => {
                let response = self.network_response(name, url, &method);
                let bytes = response_body_bytes(response.get("data"));
                let temp_file_path = if let Some(file_path) = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                {
                    normalize_path(file_path)
                } else {
                    format!("temp/{}", container_ir::hex_digest(&bytes))
                };
                self.files.insert(temp_file_path.clone(), bytes);
                Ok(Self::download_response(&response, temp_file_path))
            }
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("provider {name} is not implemented"),
                retryable: false,
            }),
        }
    }

    /// Execute one WebSocket task operation.  The deterministic provider
    /// opens a virtual socket immediately and records outbound payloads; no
    /// network is contacted.  This gives both engines stable connection,
    /// send and close semantics while native hosts can replace only transport
    /// and inbound message delivery.
    fn socket_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context(name, payload, context)?;
        if !self.network_permitted() {
            return Err(ProviderError::permission("network"));
        }
        if name == "wx.connectSocket" {
            let url = payload
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| ProviderError::invalid("wx.connectSocket requires url"))?;
            if !(url.starts_with("ws://") || url.starts_with("wss://")) {
                return Err(ProviderError::invalid(
                    "wx.connectSocket url must use ws:// or wss://",
                ));
            }
            let protocols = match payload.get("protocols") {
                None | Some(Value::Null) => Vec::new(),
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value.as_str().map(str::to_owned).ok_or_else(|| {
                            ProviderError::invalid(
                                "wx.connectSocket protocols must contain strings",
                            )
                        })
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => {
                    return Err(ProviderError::invalid(
                        "wx.connectSocket protocols must be an array",
                    ))
                }
            };
            self.next_socket_id = self.next_socket_id.saturating_add(1);
            let socket_id = format!("socket-{}", self.next_socket_id);
            self.sockets.insert(
                socket_id.clone(),
                SocketState::new(socket_id.clone(), url.to_owned(), protocols),
            );
            return Ok(json!({
                "socketId": socket_id,
                "readyState": "OPEN",
                "errMsg": "connectSocket:ok",
            }));
        }

        let socket_id = payload
            .get("socketId")
            .or_else(|| payload.get("socket_id"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| ProviderError::invalid(format!("{name} requires socketId")))?;
        let state = self.sockets.get_mut(socket_id).ok_or_else(|| {
            ProviderError::invalid(format!("{name}: socket {socket_id} does not exist"))
        })?;
        if state.ready_state != "OPEN" {
            return Err(ProviderError::invalid(format!(
                "{name}: socket {socket_id} is not open"
            )));
        }
        match name {
            "wx.socketTask.send" => {
                let data = payload
                    .get("data")
                    .cloned()
                    .ok_or_else(|| ProviderError::invalid("wx.socketTask.send requires data"))?;
                if data.is_null() {
                    return Err(ProviderError::invalid(
                        "wx.socketTask.send data cannot be null",
                    ));
                }
                state.sent.push(data);
                Ok(json!({
                    "socketId": socket_id,
                    "errMsg": "sendSocketMessage:ok",
                }))
            }
            "wx.socketTask.close" => {
                let code = payload.get("code").and_then(Value::as_u64).unwrap_or(1000);
                if !(1000..=4999).contains(&code) {
                    return Err(ProviderError::invalid(
                        "wx.socketTask.close code must be between 1000 and 4999",
                    ));
                }
                let reason = payload.get("reason").and_then(Value::as_str).unwrap_or("");
                state.ready_state = "CLOSED".to_owned();
                state.close_code = Some(code as u16);
                state.close_reason = reason.to_owned();
                Ok(json!({
                    "socketId": socket_id,
                    "code": code,
                    "reason": reason,
                    "readyState": "CLOSED",
                    "errMsg": "closeSocket:ok",
                }))
            }
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("provider {name} is not implemented"),
                retryable: false,
            }),
        }
    }

    fn system_info(&self, context: &ProviderContext) -> Value {
        let window_width = context.host.window_width;
        let window_height = context.host.window_height;
        let mut result = serde_json::to_value(&self.system_info)
            .expect("SystemInfoSnapshot is always serializable");
        let object = result
            .as_object_mut()
            .expect("SystemInfoSnapshot serializes as an object");
        // Preserve the historical integer JSON representation for the default
        // ratio while allowing native providers to report fractional device
        // pixel ratios.
        let pixel_ratio = if self.system_info.pixel_ratio.fract() == 0.0 {
            json!(self.system_info.pixel_ratio as u64)
        } else {
            json!(self.system_info.pixel_ratio)
        };
        object.insert("pixelRatio".into(), pixel_ratio);
        object.insert("platform".into(), json!(context.host.platform));
        object.insert("system".into(), json!(context.host.version));
        object.insert("version".into(), json!(context.host.version));
        object.insert("host".into(), json!(context.host.kind));
        object.insert("userAgent".into(), json!(context.host.user_agent));
        object.insert("screenWidth".into(), json!(window_width));
        object.insert("screenHeight".into(), json!(window_height));
        object.insert("windowWidth".into(), json!(window_width));
        object.insert("windowHeight".into(), json!(window_height));
        object.insert(
            "safeArea".into(),
            json!({"left": 0, "right": window_width, "top": 0, "bottom": window_height, "width": window_width, "height": window_height}),
        );
        if let Some(display) = &context.host.display_metrics {
            // A complete host observation takes precedence over sandbox
            // defaults and custom provider display fields as one snapshot.
            object.insert("pixelRatio".into(), json!(display.pixel_ratio));
            object.insert("screenWidth".into(), json!(display.screen_width));
            object.insert("screenHeight".into(), json!(display.screen_height));
            object.insert("statusBarHeight".into(), json!(display.status_bar_height));
            if let Some(safe_area) = &display.safe_area {
                object.insert("safeArea".into(), json!(safe_area));
            } else {
                // A host without a verified coordinate mapping must not
                // accidentally publish the sandbox's fabricated rectangle.
                object.remove("safeArea");
            }
            object.insert(
                "deviceOrientation".into(),
                json!(display.device_orientation),
            );
        }
        result
    }

    fn app_base_info(&self, context: &ProviderContext) -> Value {
        let system = self.system_info(context);
        let font_size_setting = system
            .get("fontSizeSetting")
            .and_then(Value::as_f64)
            .unwrap_or(16.0);
        json!({
            "SDKVersion": system["SDKVersion"],
            "enableDebug": false,
            "host": system["host"],
            "language": system["language"],
            "version": system["version"],
            "theme": system["theme"],
            "fontSizeScaleFactor": font_size_setting / 16.0,
        })
    }

    fn device_info(&self, context: &ProviderContext) -> Result<Value, ProviderError> {
        self.device_info.validate()?;
        let system = self.system_info(context);
        let mut result = serde_json::to_value(&self.device_info)
            .expect("DeviceInfoSnapshot is always serializable");
        let object = result
            .as_object_mut()
            .expect("DeviceInfoSnapshot serializes as an object");
        // Host metadata owns values that can change with the active runtime
        // surface.  DeviceInfoSnapshot owns the physical identity and
        // resource hints, which lets native providers inject real values
        // without deriving them from a desktop/browser process.
        object.insert("system".into(), system["system"].clone());
        object.insert("platform".into(), system["platform"].clone());
        Ok(result)
    }

    fn system_setting(&self, context: &ProviderContext) -> Value {
        let mut result = serde_json::to_value(&self.system_setting)
            .expect("SystemSettingSnapshot is always serializable");
        if let Some(display) = &context.host.display_metrics {
            result["deviceOrientation"] = json!(display.device_orientation);
        }
        result
    }

    fn window_info(&self, context: &ProviderContext) -> Value {
        let system = self.system_info(context);
        let mut result = json!({
            "pixelRatio": system["pixelRatio"],
            "screenWidth": system["screenWidth"],
            "screenHeight": system["screenHeight"],
            "windowWidth": system["windowWidth"],
            "windowHeight": system["windowHeight"],
            "statusBarHeight": system["statusBarHeight"],
            "screenTop": context.host.display_metrics.as_ref().map(|display| json!(display.screen_top)).unwrap_or(json!(0)),
        });
        if let Some(safe_area) = system.get("safeArea") {
            result["safeArea"] = safe_area.clone();
        }
        if let Some(layout) = context
            .host
            .display_metrics
            .as_ref()
            .and_then(|display| display.host_layout.as_ref())
        {
            result["hostLayout"] = json!(layout);
        }
        result
    }

    fn menu_button_rect(&self, context: &ProviderContext) -> Value {
        let rect = context.host.menu_button_rect.clone().unwrap_or_default();
        json!({
            "left": rect.left,
            "right": rect.right,
            "top": rect.top,
            "bottom": rect.bottom,
            "width": rect.width,
            "height": rect.height,
        })
    }

    fn account_info(&self) -> Result<Value, ProviderError> {
        self.account_info.validate()?;
        Ok(json!({
            "miniProgram": {
                "appId": self.account_info.app_id,
                "envVersion": self.account_info.env_version,
                "version": self.account_info.version,
            },
            // The public result always carries the plugin slot.  The
            // deterministic provider is running in a mini-program context,
            // so there is no plugin identity to inject; keep the documented
            // empty object instead of omitting the field.
            "plugin": {},
        }))
    }

    fn ext_config(&self, asynchronous: bool) -> Value {
        let mut result = json!({"extConfig": self.ext_config.clone()});
        if asynchronous {
            result["errMsg"] = Value::String("getExtConfig:ok".into());
        }
        result
    }

    fn file_call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        self.check_operation_context(name, payload, context)?;
        if name == "wx.saveFile" {
            let temp_file_path = payload
                .get("tempFilePath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .map(normalize_path)
                .ok_or_else(|| ProviderError::invalid("wx.saveFile requires tempFilePath"))?;
            let bytes = self.files.get(&temp_file_path).cloned().ok_or_else(|| {
                ProviderError::invalid(format!(
                    "wx.saveFile tempFilePath not found: {temp_file_path}"
                ))
            })?;
            // A caller-provided destination is preserved after path
            // normalization. Without one, the sandbox uses the SHA-256
            // content address, which is deterministic across engines and
            // providers while remaining inside the saved-file namespace.
            let saved_file_path = match payload.get("filePath") {
                Some(Value::String(path)) if !path.trim().is_empty() => normalize_path(path),
                // The official and headless runtimes treat an omitted or
                // empty destination as an allocator request. Keep the
                // allocator deterministic by using the content address.
                None | Some(Value::Null) | Some(Value::String(_)) => {
                    format!("saved/{}", container_ir::hex_digest(&bytes))
                }
                Some(_) => {
                    return Err(ProviderError::invalid(
                        "wx.saveFile filePath must be a string",
                    ))
                }
            };
            self.files.insert(saved_file_path.clone(), bytes);
            let create_time_ms = self
                .saved_files
                .get(&saved_file_path)
                .map(|metadata| metadata.create_time_ms)
                .unwrap_or(context.now_ns / 1_000_000);
            self.saved_files.insert(
                saved_file_path.clone(),
                SavedFileMetadata { create_time_ms },
            );
            return Ok(json!({
                "errMsg": "saveFile:ok",
                "savedFilePath": saved_file_path,
            }));
        }

        if name == "wx.getSavedFileList" {
            let file_list = self
                .saved_files
                .iter()
                .filter_map(|(file_path, metadata)| {
                    self.files.get(file_path).map(|bytes| {
                        json!({
                            "createTime": metadata.create_time_ms,
                            "filePath": file_path,
                            "size": bytes.len(),
                        })
                    })
                })
                .collect::<Vec<_>>();
            return Ok(json!({"errMsg": "getSavedFileList:ok", "fileList": file_list}));
        }

        let path = payload
            .get("filePath")
            .or_else(|| payload.get("path"))
            .or_else(|| payload.get("dirPath"))
            .and_then(Value::as_str)
            .map(normalize_path)
            .ok_or_else(|| {
                if matches!(name, "wx.fs.readdir" | "wx.fs.readdirSync") {
                    ProviderError::invalid(format!("{name} requires dirPath"))
                } else {
                    ProviderError::invalid(format!("{name} requires filePath"))
                }
            })?;
        match name {
            "wx.fs.readdir" | "wx.fs.readdirSync" => {
                let prefix = if path.is_empty() {
                    String::new()
                } else {
                    format!("{path}/")
                };
                let mut entries = BTreeSet::new();
                for file_path in self.files.keys() {
                    let Some(relative) = file_path.strip_prefix(&prefix) else {
                        continue;
                    };
                    if relative.is_empty() {
                        continue;
                    }
                    let entry = relative.split('/').next().unwrap_or(relative);
                    entries.insert(entry.to_owned());
                }
                Ok(json!({
                    "files": entries.into_iter().collect::<Vec<_>>(),
                    "errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name)),
                }))
            }
            "wx.fs.writeFile" | "wx.fs.writeFileSync" => {
                let data = payload.get("data").and_then(Value::as_str).ok_or_else(|| {
                    ProviderError::invalid(format!("{name} requires string data"))
                })?;
                let bytes = if payload
                    .get("encoding")
                    .and_then(Value::as_str)
                    .is_some_and(|encoding| encoding.eq_ignore_ascii_case("base64"))
                {
                    base64_decode(data).ok_or_else(|| {
                        ProviderError::invalid(format!("{name} data is not valid base64"))
                    })?
                } else {
                    data.as_bytes().to_vec()
                };
                self.files.insert(path.clone(), bytes);
                // A write to an existing saved path preserves its creation
                // time while getSavedFileList/getSavedFileInfo observe the
                // updated byte size through the current file store.
                Ok(json!({"errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name))}))
            }
            "wx.fs.readFile" | "wx.fs.readFileSync" => {
                let bytes = self
                    .files
                    .get(&path)
                    .ok_or_else(|| ProviderError::invalid(format!("file not found: {path}")))?;
                let encoding = payload.get("encoding").and_then(Value::as_str);
                if encoding == Some("base64") {
                    Ok(
                        json!({"data": base64_encode(bytes), "errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name))}),
                    )
                } else {
                    let data = String::from_utf8(bytes.clone())
                        .map_err(|_| ProviderError::invalid("file is not valid UTF-8"))?;
                    Ok(
                        json!({"data": data, "errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name))}),
                    )
                }
            }
            "wx.fs.access" | "wx.fs.accessSync" => {
                // `access` is an existence check in the WeChat filesystem
                // manager. Returning a fabricated success hides missing
                // temp/package files and diverges from the public runtime's
                // `access:fail no such file or directory, access` contract.
                // The sandbox has no host directories, so the in-memory byte
                // store is the authoritative file namespace.
                if !self.files.contains_key(&path) {
                    return Err(ProviderError::invalid(format!(
                        "access:fail no such file or directory, access '{path}'"
                    )));
                }
                Ok(json!({"errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name))}))
            }
            "wx.fs.removeSavedFile" | "wx.removeSavedFile" => {
                if !self.saved_files.contains_key(&path) {
                    return Err(ProviderError::invalid(format!(
                        "{name}:fail no such file or directory, unlink '{path}'"
                    )));
                }
                self.files.remove(&path);
                self.saved_files.remove(&path);
                Ok(json!({"errMsg": format!("{name}:ok")}))
            }
            "wx.fs.unlink" | "wx.fs.unlinkSync" => {
                let existed = self.files.remove(&path).is_some();
                self.saved_files.remove(&path);
                Ok(
                    json!({"removed": existed, "errMsg": format!("{}:ok", name.strip_prefix("wx.fs.").unwrap_or(name))}),
                )
            }
            "wx.getFileInfo" => {
                let file_path = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .ok_or_else(|| ProviderError::invalid("wx.getFileInfo requires filePath"))?;
                let bytes = self.files.get(&file_path).ok_or_else(|| {
                    ProviderError::invalid(format!(
                        "getFileInfo:fail no such file or directory, stat '{file_path}'"
                    ))
                })?;
                // mpcore follows the public runtime's default: md5 unless the
                // caller explicitly selects sha1.  Unknown values therefore
                // retain the md5 path for compatibility with the simulator.
                let digest_algorithm = payload
                    .get("digestAlgorithm")
                    .and_then(Value::as_str)
                    .unwrap_or("md5");
                let digest = if digest_algorithm == "sha1" {
                    hex_digest_sha1(bytes)
                } else {
                    hex_digest_md5(bytes)
                };
                Ok(json!({
                    "digest": digest,
                    "errMsg": "getFileInfo:ok",
                    "size": bytes.len(),
                }))
            }
            "wx.getSavedFileInfo" => {
                let file_path = payload
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(normalize_path)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.getSavedFileInfo requires filePath")
                    })?;
                let metadata = self.saved_files.get(&file_path).ok_or_else(|| {
                    ProviderError::invalid(format!(
                        "getSavedFileInfo:fail no such file or directory, stat '{file_path}'"
                    ))
                })?;
                let size = self.files.get(&file_path).map_or(0, Vec::len);
                Ok(json!({
                    "createTime": metadata.create_time_ms,
                    "errMsg": "getSavedFileInfo:ok",
                    "size": size,
                }))
            }
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("unsupported filesystem provider operation {name}"),
                retryable: false,
            }),
        }
    }
}

impl HostApiProvider for SandboxProvider {
    fn name(&self) -> &'static str {
        "sandbox"
    }

    fn capabilities(&self) -> BTreeMap<String, CapabilitySupport> {
        let mut capabilities: BTreeMap<String, CapabilitySupport> = [
            "wx.getSystemInfoSync",
            "wx.getSystemInfo",
            "wx.getSystemInfoAsync",
            "wx.getAppBaseInfo",
            "wx.getDeviceInfo",
            "wx.getWindowInfo",
            "wx.getSystemSetting",
            "wx.getMenuButtonBoundingClientRect",
            "wx.getAccountInfoSync",
            "wx.getPerformance",
            "wx.getExtConfigSync",
            "wx.getExtConfig",
            "wx.getAppAuthorizeSetting",
            "wx.getLaunchOptionsSync",
            "wx.getEnterOptionsSync",
            "wx.getBatteryInfo",
            "wx.getBatteryInfoSync",
            "wx.getScreenBrightness",
            "wx.setScreenBrightness",
            "wx.authorize",
            "wx.openSetting",
            "wx.getSetting",
            "wx.request",
            "wx.uploadFile",
            "wx.downloadFile",
            "wx.connectSocket",
            "wx.socketTask.send",
            "wx.socketTask.close",
            "wx.getFileSystemManager",
            "wx.saveFile",
            "wx.fs.readFile",
            "wx.fs.writeFile",
            "wx.fs.access",
            "wx.fs.unlink",
            "wx.fs.readdir",
            "wx.fs.readFileSync",
            "wx.fs.writeFileSync",
            "wx.fs.accessSync",
            "wx.fs.unlinkSync",
            "wx.fs.readdirSync",
            "wx.removeSavedFile",
            "wx.getFileInfo",
            "wx.getSavedFileInfo",
            "wx.getSavedFileList",
            "wx.canvas.draw",
            "wx.createOffscreenCanvas",
            "wx.setClipboardData",
            "wx.getClipboardData",
            "wx.setKeepScreenOn",
            "wx.getNetworkType",
            "wx.onNetworkStatusChange",
            "wx.vibrateShort",
            "wx.vibrateLong",
            "wx.login",
            "wx.checkSession",
            "wx.getUserProfile",
            "wx.requestPayment",
            "wx.shareAppMessage",
            "wx.shareTimeline",
            "wx.chooseMedia",
            "wx.chooseImage",
            "wx.createInnerAudioContext",
            "wx.createAudioContext",
            "wx.audioContext",
            "wx.innerAudioContext",
            "wx.createVideoContext",
            "wx.videoContext",
            "wx.createCameraContext",
            "wx.cameraContext",
            "wx.getLocation",
            "wx.startLocationUpdate",
            "wx.stopLocationUpdate",
            "wx.scanCode",
            "wx.showToast",
            "wx.hideToast",
            "wx.showLoading",
            "wx.hideLoading",
            "wx.showModal",
            "wx.showActionSheet",
            "wx.pageScrollTo",
            "wx.setNavigationBarColor",
            "wx.setNavigationBarTitle",
            "wx.redirectToMiniProgram",
        ]
        .into_iter()
        .map(|name| (name.into(), CapabilitySupport::Partial))
        .collect();
        // Account metadata is a pure, synchronous provider snapshot.  The
        // sandbox validates the complete public shape before returning it and
        // both JS engines clone the value on every call, so it is a full
        // portable capability even though native host identity injection is
        // still reported separately by the host matrix.
        capabilities.insert("wx.getAccountInfoSync".into(), CapabilitySupport::Full);
        capabilities
    }

    fn sync_file_snapshot(&self) -> BTreeMap<String, Vec<u8>> {
        self.files.clone()
    }

    fn supports_sync_filesystem(&self) -> bool {
        true
    }

    fn cancel(&mut self, token: &str) -> bool {
        if token.trim().is_empty() {
            return false;
        }
        let known = self.cancelled_tokens.contains_key(token);
        self.cancelled_tokens.insert(token.to_owned(), true);
        known
    }

    fn update_network_type(&mut self, network_type: NetworkType) -> Result<(), ProviderError> {
        self.device.network_type = network_type;
        Ok(())
    }

    fn call(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        context: &ProviderContext,
    ) -> Result<Value, ProviderError> {
        // Every provider operation crosses the same cancellation/deadline
        // boundary before dispatch.  Individual operations keep their
        // specialised checks (network permission, payload validation, and
        // so on), but must not be able to return a successful value after a
        // bridge request has expired or been cancelled.  This also covers
        // otherwise synchronous-looking APIs such as system info,
        // clipboard, observers, and auth calls.
        self.check_operation_context(name, payload, context)?;
        match name {
            "wx.getSystemInfoSync" => Ok(self.system_info(context)),
            "wx.getSystemInfo" | "wx.getSystemInfoAsync" => {
                let mut result = self.system_info(context);
                if let Some(object) = result.as_object_mut() {
                    object.insert(
                        "errMsg".into(),
                        json!(format!("{}:ok", name.trim_start_matches("wx."))),
                    );
                }
                Ok(result)
            }
            "wx.getAppBaseInfo" => Ok(self.app_base_info(context)),
            "wx.getDeviceInfo" => self.device_info(context),
            "wx.getWindowInfo" => Ok(self.window_info(context)),
            "wx.getSystemSetting" => Ok(self.system_setting(context)),
            "wx.getMenuButtonBoundingClientRect" => Ok(self.menu_button_rect(context)),
            "wx.getAccountInfoSync" => self.account_info(),
            "wx.getExtConfigSync" => Ok(self.ext_config(false)),
            "wx.getExtConfig" => Ok(self.ext_config(true)),
            "wx.getLaunchOptionsSync" => Ok(json!({"path": "", "query": {}, "scene": 1001})),
            "wx.getEnterOptionsSync" => Ok(json!({"path": "", "query": {}, "scene": 1001})),
            "wx.getBatteryInfo" | "wx.getBatteryInfoSync" => Ok(json!({
                "level": self.battery_level,
                "isCharging": self.battery_charging,
                "errMsg": if name.ends_with("Sync") {
                    "getBatteryInfoSync:ok"
                } else {
                    "getBatteryInfo:ok"
                },
            })),
            "wx.getScreenBrightness" => Ok(json!({
                "value": self.screen_brightness,
                "errMsg": "getScreenBrightness:ok",
            })),
            "wx.setScreenBrightness" => {
                if !self.permissions.get("device").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("device"));
                }
                let value = payload
                    .get("value")
                    .and_then(Value::as_f64)
                    .ok_or_else(|| {
                        ProviderError::invalid(
                            "wx.setScreenBrightness requires numeric value between 0 and 1",
                        )
                    })?;
                if !value.is_finite() || !(0.0..=1.0).contains(&value) {
                    return Err(ProviderError::invalid(
                        "wx.setScreenBrightness value must be a finite number between 0 and 1",
                    ));
                }
                self.screen_brightness = value;
                Ok(json!({"errMsg": "setScreenBrightness:ok"}))
            }
            "wx.authorize" => {
                let scope = payload
                    .get("scope")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|scope| !scope.is_empty())
                    .ok_or_else(|| ProviderError::invalid("wx.authorize requires scope"))?;
                if Self::scope_permission(scope).is_none() {
                    return Err(ProviderError::invalid(format!(
                        "wx.authorize unsupported scope {scope}"
                    )));
                }
                if !self.scope_permitted(scope) {
                    return Err(ProviderError::permission(scope));
                }
                Ok(json!({"errMsg": "authorize:ok", "scope": scope}))
            }
            "wx.openSetting" | "wx.getSetting" => {
                let with_subscriptions = match payload.get("withSubscriptions") {
                    None => false,
                    Some(Value::Bool(value)) => *value,
                    Some(_) => {
                        return Err(ProviderError::invalid(format!(
                            "{name} withSubscriptions must be a boolean"
                        )))
                    }
                };
                let public_name = name.strip_prefix("wx.").unwrap_or(name);
                let mut result = json!({
                    "authSetting": self.permission_settings(),
                    "errMsg": format!("{public_name}:ok"),
                });
                if with_subscriptions {
                    result["subscriptionsSetting"] = self.subscription_settings()?;
                }
                Ok(result)
            }
            "wx.getAppAuthorizeSetting" => Ok(self.app_authorize_settings()),
            "wx.request" | "wx.uploadFile" | "wx.downloadFile" => {
                self.network_call(name, payload, context)
            }
            "wx.connectSocket" | "wx.socketTask.send" | "wx.socketTask.close" => {
                self.socket_call(name, payload, context)
            }
            "wx.getFileSystemManager" => Ok(
                json!({"provider": self.name(), "operations": ["readFile", "writeFile", "access", "unlink", "removeSavedFile", "saveFile"]}),
            ),
            "wx.saveFile" => self.file_call(name, payload, context),
            "wx.getFileInfo" | "wx.getSavedFileInfo" | "wx.getSavedFileList" => {
                self.file_call(name, payload, context)
            }
            name if name.starts_with("wx.fs.") || name == "wx.removeSavedFile" => {
                self.file_call(name, payload, context)
            }
            "wx.canvas.draw" => {
                let canvas_id = payload
                    .get("canvasId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| ProviderError::invalid("wx.canvas.draw requires canvasId"))?;
                let commands = payload
                    .get("commands")
                    .and_then(Value::as_array)
                    .ok_or_else(|| ProviderError::invalid("wx.canvas.draw requires commands"))?;
                for command in commands {
                    let object = command.as_object().ok_or_else(|| {
                        ProviderError::invalid("canvas command must be an object")
                    })?;
                    let op = object
                        .get("op")
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| ProviderError::invalid("canvas command requires op"))?;
                    if !matches!(
                        op,
                        "setFillStyle"
                            | "setStrokeStyle"
                            | "setLineWidth"
                            | "setGlobalAlpha"
                            | "setFontSize"
                            | "setLineDash"
                            | "setLineCap"
                            | "setLineJoin"
                            | "setMiterLimit"
                            | "setShadow"
                            | "setTextAlign"
                            | "setTextBaseline"
                            | "fillRect"
                            | "strokeRect"
                            | "clearRect"
                            | "beginPath"
                            | "closePath"
                            | "moveTo"
                            | "lineTo"
                            | "arc"
                            | "rect"
                            | "fill"
                            | "stroke"
                            | "fillText"
                            | "strokeText"
                            | "drawImage"
                            | "save"
                            | "restore"
                            | "translate"
                            | "rotate"
                            | "scale"
                            | "quadraticCurveTo"
                            | "bezierCurveTo"
                    ) {
                        return Err(ProviderError::invalid(format!(
                            "unsupported canvas command {op}"
                        )));
                    }
                    if !object.get("args").is_some_and(Value::is_array) {
                        return Err(ProviderError::invalid("canvas command requires args"));
                    }
                    if op == "setLineDash" {
                        let args = object
                            .get("args")
                            .and_then(Value::as_array)
                            .expect("setLineDash args were validated as an array");
                        let pattern = args.first().and_then(Value::as_array).ok_or_else(|| {
                            ProviderError::invalid("setLineDash requires a numeric pattern array")
                        })?;
                        for value in pattern {
                            let number = value.as_f64().ok_or_else(|| {
                                ProviderError::invalid(
                                    "setLineDash pattern values must be finite non-negative numbers",
                                )
                            })?;
                            if !number.is_finite() || number < 0.0 {
                                return Err(ProviderError::invalid(
                                    "setLineDash pattern values must be finite non-negative numbers",
                                ));
                            }
                        }
                        if let Some(offset) = args.get(1) {
                            let number = offset.as_f64().ok_or_else(|| {
                                ProviderError::invalid("setLineDash offset must be a finite number")
                            })?;
                            if !number.is_finite() {
                                return Err(ProviderError::invalid(
                                    "setLineDash offset must be a finite number",
                                ));
                            }
                        }
                    }
                }
                Ok(json!({
                    "errMsg": "draw:ok",
                    "canvasId": canvas_id,
                    "commands": commands.len(),
                    "reserve": payload.get("reserve").and_then(Value::as_bool).unwrap_or(false),
                }))
            }
            "wx.createIntersectionObserver" | "wx.createMediaQueryObserver" => {
                // The Session owns subscriptions, committed render geometry,
                // window transitions and page/component disposal. A standalone
                // provider cannot service this persistent view contract and
                // must not acknowledge a measurement with fabricated values.
                Err(ProviderError {
                    code: ProviderErrorCode::Unsupported,
                    message: format!(
                        "{name} requires Session-managed observation of a committed view"
                    ),
                    retryable: false,
                })
            }
            name @ ("wx.showToast"
            | "wx.hideToast"
            | "wx.showLoading"
            | "wx.hideLoading"
            | "wx.showModal"
            | "wx.showActionSheet"
            | "wx.pageScrollTo"
            | "wx.setNavigationBarColor"
            | "wx.setNavigationBarTitle") => self.ui_call(name, payload, context),
            "wx.setClipboardData" => {
                if !self.permissions.get("clipboard").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("clipboard"));
                }
                self.clipboard = payload
                    .get("data")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ProviderError::invalid("wx.setClipboardData requires data"))?
                    .to_string();
                Ok(json!({"errMsg": "setClipboardData:ok"}))
            }
            "wx.getClipboardData" => {
                if !self.permissions.get("clipboard").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("clipboard"));
                }
                Ok(json!({"data": self.clipboard, "errMsg": "getClipboardData:ok"}))
            }
            "wx.setKeepScreenOn" => {
                if !self.permissions.get("device").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("device"));
                }
                let keep_screen_on = payload
                    .get("keepScreenOn")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        ProviderError::invalid("wx.setKeepScreenOn requires boolean keepScreenOn")
                    })?;
                self.device.keep_screen_on = keep_screen_on;
                Ok(json!({"errMsg": "setKeepScreenOn:ok"}))
            }
            "wx.vibrateShort" | "wx.vibrateLong" => {
                if !self.permissions.get("device").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("device"));
                }
                let (kind, duration_ms) = if name == "wx.vibrateShort" {
                    let kind = payload
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("medium");
                    let duration_ms = match kind {
                        "heavy" => 30,
                        "medium" => 20,
                        "light" => 15,
                        _ => {
                            return Err(ProviderError::invalid(
                                "wx.vibrateShort type must be heavy, medium, or light",
                            ))
                        }
                    };
                    (kind.to_owned(), duration_ms)
                } else {
                    if let Some(kind) = payload.get("type") {
                        if kind.as_str().is_none_or(|value| value != "long") {
                            return Err(ProviderError::invalid(
                                "wx.vibrateLong type must be long when provided",
                            ));
                        }
                    }
                    ("long".to_owned(), 400)
                };
                self.device
                    .vibrations
                    .push(VibrationRecord { kind, duration_ms });
                Ok(json!({"errMsg": format!("{name}:ok")}))
            }
            "wx.getNetworkType" => {
                let network_type = self.device.network_type.as_str();
                Ok(json!({
                    "networkType": network_type,
                    "isConnected": network_type != "none",
                    "errMsg": "getNetworkType:ok"
                }))
            }
            "wx.login" => {
                if !self.permitted("account") {
                    return Err(ProviderError::permission("account"));
                }
                // A successful login establishes the account session used by
                // `wx.checkSession`. The code is deterministic in the
                // sandbox and can be replaced by a host-issued code through
                // `with_login_code` without changing the bridge contract.
                self.account_session_valid = true;
                Ok(json!({"code": self.login_code, "errMsg": "login:ok"}))
            }
            "wx.checkSession" => {
                if !self.permitted("account") {
                    return Err(ProviderError::permission("account"));
                }
                if !self.account_session_valid {
                    return Err(ProviderError::invalid("checkSession:fail session expired"));
                }
                Ok(json!({"errMsg": "checkSession:ok"}))
            }
            "wx.getUserProfile" => {
                if !self.permitted("profile") {
                    return Err(ProviderError::permission("profile"));
                }
                let _desc = payload
                    .get("desc")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|desc| !desc.is_empty())
                    .ok_or_else(|| {
                        ProviderError::invalid("getUserProfile requires a non-empty desc")
                    })?;
                let raw_data = serde_json::to_string(&self.user_profile).map_err(|error| {
                    ProviderError::invalid(format!(
                        "getUserProfile profile serialization failed: {error}"
                    ))
                })?;
                Ok(json!({
                    "userInfo": self.user_profile.clone(),
                    "errMsg": "getUserProfile:ok",
                    "rawData": raw_data,
                    "signature": format!("weapp-sandbox-signature-{}", raw_data.len()),
                    "encryptedData": "",
                    "iv": "",
                }))
            }
            "wx.requestPayment" => payment_call(self, payload, context),
            "wx.redirectToMiniProgram" => {
                // Hosts may deny cross-mini-program navigation explicitly;
                // the deterministic sandbox accepts it by default so
                // development fixtures can observe the complete validation
                // and callback contract without opening another app.
                if !self.permissions.get("miniProgram").copied().unwrap_or(true) {
                    return Err(ProviderError::permission("miniProgram"));
                }
                let request = MiniProgramRedirectRequest::from_payload(payload)?;
                self.last_mini_program_redirect = Some(request);
                Ok(json!({"errMsg": "redirectToMiniProgram:ok"}))
            }
            "wx.shareAppMessage" | "wx.shareTimeline" => share_call(self, name, payload, context),
            "wx.chooseMedia" | "wx.chooseImage" => self.media_picker_call(name, payload, context),
            "wx.innerAudioContext" | "wx.audioContext" => self.inner_audio_call(payload, context),
            "wx.createCameraContext" | "wx.cameraContext" => {
                self.camera_context_call(payload, context)
            }
            "wx.videoContext" => self.video_context_call(payload, context),
            "wx.getLocation" => self.location_call(payload, context),
            "wx.startLocationUpdate" | "wx.stopLocationUpdate" => {
                self.location_updates_call(name, payload, context)
            }
            "wx.scanCode" => self.scan_code_call(payload, context),
            _ => Err(ProviderError {
                code: ProviderErrorCode::Unsupported,
                message: format!("provider {name} is not implemented"),
                retryable: false,
            }),
        }
    }
}

/// Validate and record a share request without pretending that a native
/// share sheet was shown or that the user completed a share.  The
/// deterministic provider is intentionally side-effect free beyond this
/// typed snapshot; native providers may consume the same request and
/// report a platform-specific lifecycle through the bridge.
fn share_call(
    provider: &mut SandboxProvider,
    name: &str,
    payload: &Map<String, Value>,
    context: &ProviderContext,
) -> Result<Value, ProviderError> {
    provider.check_operation_context(name, payload, context)?;
    if !provider.permissions.get("share").copied().unwrap_or(true) {
        return Err(ProviderError::permission("share"));
    }

    let optional_string = |key: &str| -> Result<Option<String>, ProviderError> {
        match payload.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(value)) => Ok(Some(value.clone())),
            Some(_) => Err(ProviderError::invalid(format!(
                "{name} {key} must be a string when provided"
            ))),
        }
    };
    let title = optional_string("title")?;
    let path = optional_string("path")?;
    if path.as_deref().is_some_and(|value| value.trim().is_empty()) {
        return Err(ProviderError::invalid(format!(
            "{name} path must be non-empty when provided"
        )));
    }
    let image_url = optional_string("imageUrl")?;
    let query = optional_string("query")?;
    let template_id = optional_string("templateId")?;
    if template_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(ProviderError::invalid(format!(
            "{name} templateId must be non-empty when provided"
        )));
    }
    let extra_data = match payload.get("extraData") {
        None | Some(Value::Null) => None,
        Some(Value::Object(value)) => Some(Value::Object(value.clone())),
        Some(_) => {
            return Err(ProviderError::invalid(format!(
                "{name} extraData must be an object when provided"
            )))
        }
    };
    let menus = match payload.get("menus") {
        None | Some(Value::Null) => None,
        Some(Value::Array(values)) => {
            let mut result = Vec::with_capacity(values.len());
            for value in values {
                let Some(value) = value.as_str() else {
                    return Err(ProviderError::invalid(format!(
                        "{name} menus must contain strings"
                    )));
                };
                if value.trim().is_empty() {
                    return Err(ProviderError::invalid(format!(
                        "{name} menus must contain non-empty strings"
                    )));
                }
                result.push(value.to_owned());
            }
            Some(result)
        }
        Some(_) => {
            return Err(ProviderError::invalid(format!(
                "{name} menus must be an array when provided"
            )))
        }
    };
    let request = ShareRequest {
        api: name.to_owned(),
        title,
        path,
        image_url,
        query,
        template_id,
        extra_data,
        menus,
    };
    provider.last_share = Some(request);
    Ok(json!({"errMsg": format!("{name}:ok")}))
}

/// Validate and record the public `wx.requestPayment` request shape. The
/// deterministic sandbox does not contact WeChat's payment service; recording
/// a typed request gives native hosts a stable handoff boundary while keeping
/// payment credentials out of the portable runtime's control flow.
fn payment_call(
    provider: &mut SandboxProvider,
    payload: &Map<String, Value>,
    context: &ProviderContext,
) -> Result<Value, ProviderError> {
    const NAME: &str = "wx.requestPayment";
    provider.check_operation_context(NAME, payload, context)?;
    if !provider.permitted("payments") {
        return Err(ProviderError::permission("payments"));
    }
    provider.last_payment = Some(PaymentRequest::from_payload(payload)?);
    Ok(json!({"errMsg": "requestPayment:ok", "sandbox": true}))
}

impl PaymentRequest {
    pub(crate) fn from_payload(payload: &Map<String, Value>) -> Result<Self, ProviderError> {
        const NAME: &str = "wx.requestPayment";

        fn required_string(
            payload: &Map<String, Value>,
            key: &str,
        ) -> Result<String, ProviderError> {
            let value = payload
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    ProviderError::invalid(format!("{NAME} requires non-empty {key}"))
                })?;
            Ok(value.to_owned())
        }

        let time_stamp = required_string(payload, "timeStamp")?;
        let nonce_str = required_string(payload, "nonceStr")?;
        let package = required_string(payload, "package")?;
        let sign_type = required_string(payload, "signType")?;
        if !matches!(sign_type.as_str(), "MD5" | "HMAC-SHA256" | "RSA") {
            return Err(ProviderError::invalid(
                "wx.requestPayment signType must be MD5, HMAC-SHA256, or RSA",
            ));
        }
        let pay_sign = required_string(payload, "paySign")?;

        Ok(Self {
            time_stamp,
            nonce_str,
            package,
            sign_type,
            pay_sign,
        })
    }
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("wxfile://")
        .trim_start_matches('/')
        .to_string()
}

fn nonnegative_number(value: &Value, name: &str) -> Result<f64, ProviderError> {
    let number = value
        .as_f64()
        .ok_or_else(|| ProviderError::invalid(format!("{name} must be a number")))?;
    if !number.is_finite() || number < 0.0 {
        return Err(ProviderError::invalid(format!(
            "{name} must be a finite non-negative number"
        )));
    }
    Ok(number)
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn hex_digest_md5(bytes: &[u8]) -> String {
    let digest = Md5::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hex_digest_sha1(bytes: &[u8]) -> String {
    let digest = Sha1::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::new();
    for chunk in bytes.chunks(3) {
        let a = chunk[0] as u32;
        let b = chunk.get(1).copied().unwrap_or(0) as u32;
        let c = chunk.get(2).copied().unwrap_or(0) as u32;
        let value = (a << 16) | (b << 8) | c;
        output.push(TABLE[((value >> 18) & 63) as usize] as char);
        output.push(TABLE[((value >> 12) & 63) as usize] as char);
        output.push(if chunk.len() > 1 {
            TABLE[((value >> 6) & 63) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() > 2 {
            TABLE[(value & 63) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn base64_decode(value: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(value.len() * 3 / 4);
    let mut quartet = [0u8; 4];
    let mut count = 0;
    for byte in value.bytes().filter(|byte| !byte.is_ascii_whitespace()) {
        quartet[count] = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return None,
        };
        count += 1;
        if count == 4 {
            if quartet[0] == 64 || quartet[1] == 64 {
                return None;
            }
            output.push((quartet[0] << 2) | (quartet[1] >> 4));
            if quartet[2] != 64 {
                output.push((quartet[1] << 4) | (quartet[2] >> 2));
                if quartet[3] != 64 {
                    output.push((quartet[2] << 6) | quartet[3]);
                }
            } else if quartet[3] != 64 {
                return None;
            }
            count = 0;
        }
    }
    if count != 0 {
        return None;
    }
    Some(output)
}

fn response_body_bytes(value: Option<&Value>) -> Vec<u8> {
    match value {
        Some(Value::String(text)) => text.as_bytes().to_vec(),
        Some(value) => serde_json::to_vec(value).unwrap_or_default(),
        None => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::HostKind;

    #[test]
    fn sandbox_request_and_file_are_deterministic() {
        let mut provider = SandboxProvider::new()
            .with_response("https://example.test/data", json!({"ok": true}))
            .seed_file("/hello.txt", "hello");
        let context = ProviderContext {
            session_id: "test".into(),
            host: HostMetadata::default(),
            now_ns: 1,
            ..ProviderContext::default()
        };
        let request = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test/data"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(request["statusCode"], 200);
        let read = provider
            .call(
                "wx.fs.readFile",
                json!({"filePath": "/hello.txt"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(read["data"], "hello");
    }

    #[test]
    fn redirect_to_mini_program_validates_and_records_target() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let result = provider
            .call(
                "wx.redirectToMiniProgram",
                json!({
                    "appId": "wx-target",
                    "path": "pages/home/index?from=weapp-container",
                    "extraData": {"source": "fixture"},
                    "envVersion": "trial"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect("valid target is accepted");
        assert_eq!(result, json!({"errMsg": "redirectToMiniProgram:ok"}));
        assert_eq!(
            provider.last_mini_program_redirect(),
            Some(&MiniProgramRedirectRequest {
                app_id: "wx-target".into(),
                path: "pages/home/index?from=weapp-container".into(),
                extra_data: json!({"source": "fixture"}),
                env_version: "trial".into(),
            })
        );

        let invalid_env = provider
            .call(
                "wx.redirectToMiniProgram",
                json!({"appId": "wx-target", "envVersion": "preview"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .expect_err("unknown environment is rejected");
        assert_eq!(invalid_env.code, ProviderErrorCode::InvalidRequest);

        let denied = SandboxProvider::new().deny("miniProgram");
        let mut denied = denied;
        let error = denied
            .call(
                "wx.redirectToMiniProgram",
                json!({"appId": "wx-target"}).as_object().unwrap(),
                &context,
            )
            .expect_err("explicit navigation denial is preserved");
        assert_eq!(error.code, ProviderErrorCode::PermissionDenied);
    }

    #[test]
    fn canvas_provider_validates_line_dash_pattern_and_offset() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let accepted = provider
            .call(
                "wx.canvas.draw",
                json!({
                    "canvasId": "dash",
                    "commands": [{"op": "setLineDash", "args": [[2, 1, 3], -4]}]
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect("valid line dash command is accepted");
        assert_eq!(accepted["errMsg"], "draw:ok");

        let invalid_pattern = provider
            .call(
                "wx.canvas.draw",
                json!({
                    "canvasId": "dash",
                    "commands": [{"op": "setLineDash", "args": [[2, -1]]}]
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect_err("negative dash lengths are rejected");
        assert_eq!(invalid_pattern.code, ProviderErrorCode::InvalidRequest);

        let invalid_offset = provider
            .call(
                "wx.canvas.draw",
                json!({
                    "canvasId": "dash",
                    "commands": [{"op": "setLineDash", "args": [[2, 1], "offset"]}]
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect_err("non-numeric dash offsets are rejected");
        assert_eq!(invalid_offset.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn filesystem_access_checks_existing_normalized_paths() {
        let mut provider = SandboxProvider::new().seed_file("wxfile:///tmp/input.txt", "hello");
        let context = ProviderContext::default();

        let existing = provider
            .call(
                "wx.fs.access",
                json!({"path": "wxfile:///tmp/input.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(existing["errMsg"], "access:ok");

        let missing = provider
            .call(
                "wx.fs.access",
                json!({"path": "/tmp/missing.txt"}).as_object().unwrap(),
                &context,
            )
            .expect_err("access must fail for a path absent from the sandbox");
        assert_eq!(missing.code, ProviderErrorCode::InvalidRequest);
        assert_eq!(
            missing.message,
            "access:fail no such file or directory, access 'tmp/missing.txt'"
        );
    }

    #[test]
    fn synchronous_filesystem_operations_share_the_sandbox_namespace() {
        let mut provider = SandboxProvider::new().seed_file("/hello.txt", "hello");
        let context = ProviderContext::default();
        let read = provider
            .call(
                "wx.fs.readFileSync",
                json!({"filePath": "/hello.txt", "encoding": "utf8"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(read["data"], "hello");
        provider
            .call(
                "wx.fs.writeFileSync",
                json!({"filePath": "/written.txt", "data": "world"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        provider
            .call(
                "wx.fs.accessSync",
                json!({"filePath": "/written.txt"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        provider
            .call(
                "wx.fs.unlinkSync",
                json!({"filePath": "/written.txt"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert!(!provider.sync_file_snapshot().contains_key("written.txt"));
    }

    #[test]
    fn save_file_copies_temp_bytes_to_explicit_or_content_addressed_path() {
        let mut provider = SandboxProvider::new().seed_file("wxfile:///tmp/source.txt", "hello");
        let context = ProviderContext::default();

        let explicit = provider
            .call(
                "wx.saveFile",
                json!({
                    "tempFilePath": "wxfile:///tmp/source.txt",
                    "filePath": "wxfile:///saved/report.txt"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(explicit["errMsg"], "saveFile:ok");
        assert_eq!(explicit["savedFilePath"], "saved/report.txt");
        let explicit_read = provider
            .call(
                "wx.fs.readFile",
                json!({"filePath": "wxfile:///saved/report.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(explicit_read["data"], "hello");

        let generated = provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/tmp/source.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        let expected = format!("saved/{}", container_ir::hex_digest(b"hello"));
        assert_eq!(generated["savedFilePath"], expected);
        let generated_read = provider
            .call(
                "wx.fs.readFile",
                json!({"filePath": generated["savedFilePath"]})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(generated_read["data"], "hello");
    }

    #[test]
    fn save_file_reports_missing_source_and_honors_cancel_and_deadline() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let missing = provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/tmp/missing.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(missing.code, ProviderErrorCode::InvalidRequest);
        assert!(missing.message.contains("tempFilePath not found"));

        provider = provider.seed_file("/tmp/source.txt", "hello");
        provider.cancel("save-request");
        let cancelled = provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/tmp/source.txt", "cancelToken": "save-request"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(cancelled.code, ProviderErrorCode::Cancelled);

        let deadline = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        let timed_out = provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/tmp/source.txt"})
                    .as_object()
                    .unwrap(),
                &deadline,
            )
            .unwrap_err();
        assert_eq!(timed_out.code, ProviderErrorCode::Timeout);
    }

    #[test]
    fn file_info_and_saved_file_metadata_match_public_shapes() {
        let mut provider = SandboxProvider::new()
            .seed_file("/tmp/source.txt", "hello")
            .seed_file("/package.txt", "package");
        let context = ProviderContext {
            now_ns: 2_000_000,
            ..ProviderContext::default()
        };

        let md5 = provider
            .call(
                "wx.getFileInfo",
                json!({"filePath": "wxfile:///tmp/source.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(md5["digest"], "5d41402abc4b2a76b9719d911017c592");
        assert_eq!(md5["size"], 5);
        assert_eq!(md5["errMsg"], "getFileInfo:ok");

        let sha1 = provider
            .call(
                "wx.getFileInfo",
                json!({"filePath": "/tmp/source.txt", "digestAlgorithm": "sha1"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(sha1["digest"], "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");

        provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/tmp/source.txt", "filePath": "/saved/z.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        provider
            .call(
                "wx.saveFile",
                json!({"tempFilePath": "/package.txt", "filePath": "/saved/a.txt"})
                    .as_object()
                    .unwrap(),
                &ProviderContext {
                    now_ns: 3_000_000,
                    ..context.clone()
                },
            )
            .unwrap();

        let list = provider
            .call("wx.getSavedFileList", &Map::new(), &context)
            .unwrap();
        assert_eq!(list["errMsg"], "getSavedFileList:ok");
        let files = list["fileList"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["filePath"], "saved/a.txt");
        assert_eq!(files[0]["createTime"], 3);
        assert_eq!(files[0]["size"], 7);
        assert_eq!(files[1]["filePath"], "saved/z.txt");
        assert_eq!(files[1]["createTime"], 2);

        let info = provider
            .call(
                "wx.getSavedFileInfo",
                json!({"filePath": "wxfile:///saved/z.txt"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(info["createTime"], 2);
        assert_eq!(info["size"], 5);

        provider
            .call(
                "wx.removeSavedFile",
                json!({"filePath": "/saved/z.txt"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(
            provider
                .call("wx.getSavedFileList", &Map::new(), &context)
                .unwrap()["fileList"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let missing = provider
            .call(
                "wx.removeSavedFile",
                json!({"filePath": "/saved/z.txt"}).as_object().unwrap(),
                &context,
            )
            .expect_err("removing an unknown saved file must fail");
        assert_eq!(missing.code, ProviderErrorCode::InvalidRequest);
        assert!(missing.message.contains("removeSavedFile:fail"));
    }

    #[test]
    fn sensitive_apis_require_explicit_permission() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let error = provider
            .call("wx.getLocation", &Map::new(), &context)
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::PermissionDenied);
    }

    #[test]
    fn authorize_and_open_setting_share_scope_permission_state() {
        let mut denied = SandboxProvider::new();
        let context = ProviderContext::default();
        let error = denied
            .call(
                "wx.authorize",
                json!({"scope": "scope.userLocation"}).as_object().unwrap(),
                &context,
            )
            .expect_err("ungranted scopes must be denied");
        assert_eq!(error.code, ProviderErrorCode::PermissionDenied);

        let mut granted = SandboxProvider::new().grant("location");
        let result = granted
            .call(
                "wx.authorize",
                json!({"scope": "scope.userLocation"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(result["errMsg"], "authorize:ok");
        let settings = granted
            .call("wx.openSetting", &Map::new(), &context)
            .unwrap();
        assert_eq!(settings["authSetting"]["scope.userLocation"], true);
        assert_eq!(settings["authSetting"]["scope.camera"], false);
    }

    #[test]
    fn subscription_settings_are_returned_only_when_requested_and_validated() {
        let mut item_settings = BTreeMap::new();
        item_settings.insert("tmpl-accepted".to_owned(), "accept".to_owned());
        item_settings.insert("tmpl-rejected".to_owned(), "reject".to_owned());
        let mut provider = SandboxProvider::new()
            .with_subscription_setting(SubscriptionSettingSnapshot {
                main_switch: true,
                item_settings,
            })
            .expect("valid subscription snapshot");
        let context = ProviderContext::default();

        let without = provider
            .call("wx.getSetting", &Map::new(), &context)
            .expect("getSetting without subscriptions");
        assert!(without.get("subscriptionsSetting").is_none());

        let with = provider
            .call(
                "wx.getSetting",
                json!({"withSubscriptions": true}).as_object().unwrap(),
                &context,
            )
            .expect("getSetting with subscriptions");
        assert_eq!(with["subscriptionsSetting"]["mainSwitch"], true);
        assert_eq!(
            with["subscriptionsSetting"]["itemSettings"]["tmpl-accepted"],
            "accept"
        );

        let opened = provider
            .call(
                "wx.openSetting",
                json!({"withSubscriptions": true}).as_object().unwrap(),
                &context,
            )
            .expect("openSetting with subscriptions");
        assert_eq!(opened["subscriptionsSetting"]["mainSwitch"], true);

        for name in ["wx.getSetting", "wx.openSetting"] {
            let error = provider
                .call(
                    name,
                    json!({"withSubscriptions": "yes"}).as_object().unwrap(),
                    &context,
                )
                .expect_err("withSubscriptions must be boolean");
            assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
        }
        assert!(SandboxProvider::new()
            .with_subscription_setting(SubscriptionSettingSnapshot {
                main_switch: false,
                item_settings: BTreeMap::from([(String::new(), "accept".to_owned())]),
            })
            .is_err());
    }

    #[test]
    fn app_authorize_setting_reports_authorized_denied_and_undetermined_states() {
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new();
        let initial = provider
            .call("wx.getAppAuthorizeSetting", &Map::new(), &context)
            .unwrap();
        assert_eq!(initial["cameraAuthorized"], "not determined");
        assert_eq!(initial["locationAuthorized"], "not determined");
        assert_eq!(initial["notificationAuthorized"], "not determined");
        assert_eq!(initial["albumAuthorized"], "not determined");

        provider = provider
            .grant("photos/camera")
            .deny("location")
            .grant("microphone")
            .grant("notification");
        let state = provider
            .call("wx.getAppAuthorizeSetting", &Map::new(), &context)
            .unwrap();
        assert_eq!(state["cameraAuthorized"], "authorized");
        assert_eq!(state["albumAuthorized"], "authorized");
        assert_eq!(state["locationAuthorized"], "denied");
        assert_eq!(state["microphoneAuthorized"], "authorized");
        assert_eq!(state["notificationAuthorized"], "authorized");
        assert_eq!(state["notificationAlertAuthorized"], "authorized");
        assert_eq!(state["notificationBadgeAuthorized"], "authorized");
        assert_eq!(state["notificationSoundAuthorized"], "authorized");

        let expired = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getAppAuthorizeSetting", &Map::new(), &expired)
                .unwrap_err()
                .code,
            ProviderErrorCode::Timeout
        );
        let cancelled = ProviderContext {
            cancelled: true,
            cancel_token: Some("permission-state".into()),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getAppAuthorizeSetting", &Map::new(), &cancelled)
                .unwrap_err()
                .code,
            ProviderErrorCode::Cancelled
        );
    }

    #[test]
    fn share_requests_validate_and_record_without_claiming_user_completion() {
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new();
        let result = provider
            .call(
                "wx.shareAppMessage",
                json!({
                    "title": "Fixture",
                    "path": "/pages/home/index?from=share",
                    "imageUrl": "https://example.invalid/share.png",
                    "extraData": {"source": "test"}
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect("valid app-message share should be accepted by sandbox");
        assert_eq!(result["errMsg"], "wx.shareAppMessage:ok");
        assert_eq!(result.as_object().unwrap().len(), 1);
        let request = provider.last_share().expect("share request is recorded");
        assert_eq!(request.api, "wx.shareAppMessage");
        assert_eq!(
            request.path.as_deref(),
            Some("/pages/home/index?from=share")
        );
        assert_eq!(request.extra_data, Some(json!({"source": "test"})));

        let timeline = provider
            .call(
                "wx.shareTimeline",
                json!({
                    "title": "Timeline",
                    "query": "from=timeline",
                    "templateId": "tmpl-1",
                    "menus": ["shareAppMessage", "favorite"]
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .expect("valid timeline share should be accepted by sandbox");
        assert_eq!(timeline["errMsg"], "wx.shareTimeline:ok");
        let request = provider.last_share().expect("timeline request is recorded");
        assert_eq!(request.api, "wx.shareTimeline");
        assert_eq!(request.query.as_deref(), Some("from=timeline"));
        assert_eq!(
            request.menus,
            Some(vec!["shareAppMessage".into(), "favorite".into()])
        );
    }

    #[test]
    fn share_requests_reject_invalid_payload_permission_and_context() {
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new();
        for (name, payload, fragment) in [
            (
                "wx.shareAppMessage",
                json!({"path": ""}),
                "path must be non-empty",
            ),
            (
                "wx.shareAppMessage",
                json!({"extraData": "invalid"}),
                "extraData must be an object",
            ),
            (
                "wx.shareTimeline",
                json!({"menus": ["favorite", 1]}),
                "menus must contain strings",
            ),
        ] {
            let error = provider
                .call(name, payload.as_object().unwrap(), &context)
                .expect_err("invalid share payload must fail");
            assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
            assert!(error.message.contains(fragment), "{}", error.message);
        }
        let denied = SandboxProvider::new()
            .deny("share")
            .call("wx.shareTimeline", &Map::new(), &context)
            .expect_err("denied share must fail explicitly");
        assert_eq!(denied.code, ProviderErrorCode::PermissionDenied);

        let expired = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.shareAppMessage", &Map::new(), &expired)
                .expect_err("expired share must fail before recording")
                .code,
            ProviderErrorCode::Timeout
        );
    }

    #[test]
    fn location_validates_options_and_returns_documented_shape() {
        let mut provider = SandboxProvider::new().grant("location");
        let context = ProviderContext::default();
        let result = provider
            .call(
                "wx.getLocation",
                json!({"type": "gcj02", "altitude": true})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(result["errMsg"], "getLocation:ok");
        assert_eq!(result["latitude"], 0.0);
        assert_eq!(result["longitude"], 0.0);
        assert_eq!(result["speed"], 0.0);
        assert_eq!(result["accuracy"], 0.0);
        assert_eq!(result["altitude"], 0.0);
        assert_eq!(result["verticalAccuracy"], 0.0);
        assert_eq!(result["horizontalAccuracy"], 0.0);

        let invalid_type = provider
            .call(
                "wx.getLocation",
                json!({"type": "bd09"}).as_object().unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(invalid_type.code, ProviderErrorCode::InvalidRequest);

        let invalid_altitude = provider
            .call(
                "wx.getLocation",
                json!({"altitude": "true"}).as_object().unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(invalid_altitude.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn scan_and_location_updates_use_explicit_permissions_and_stable_results() {
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new()
            .grant("photos/camera")
            .grant("location");
        let scan = provider
            .call(
                "wx.scanCode",
                json!({"onlyFromCamera": true, "scanType": ["qrCode"]})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(scan["errMsg"], "scanCode:ok");
        assert_eq!(scan["scanType"], "QR_CODE");
        assert_eq!(scan["result"], "");
        assert_eq!(
            provider
                .call(
                    "wx.startLocationUpdate",
                    json!({"type": "gcj02"}).as_object().unwrap(),
                    &context,
                )
                .unwrap()["errMsg"],
            "startLocationUpdate:ok"
        );
        assert!(provider.device_state().location_updates);
        provider
            .call("wx.stopLocationUpdate", &Map::new(), &context)
            .unwrap();
        assert!(!provider.device_state().location_updates);

        let invalid = provider.call(
            "wx.scanCode",
            json!({"scanType": ["pdf"]}).as_object().unwrap(),
            &context,
        );
        assert_eq!(invalid.unwrap_err().code, ProviderErrorCode::InvalidRequest);
        let denied = SandboxProvider::new().call("wx.scanCode", &Map::new(), &context);
        assert_eq!(
            denied.unwrap_err().code,
            ProviderErrorCode::PermissionDenied
        );
    }

    #[test]
    fn location_honors_deadline_and_cancellation_before_permission() {
        let mut provider = SandboxProvider::new().grant("location");
        let deadline = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        let timed_out = provider
            .call("wx.getLocation", &Map::new(), &deadline)
            .unwrap_err();
        assert_eq!(timed_out.code, ProviderErrorCode::Timeout);

        provider.cancel("location-request");
        let cancelled = ProviderContext {
            cancel_token: Some("location-request".into()),
            ..ProviderContext::default()
        };
        let cancelled = provider
            .call("wx.getLocation", &Map::new(), &cancelled)
            .unwrap_err();
        assert_eq!(cancelled.code, ProviderErrorCode::Cancelled);
    }

    #[test]
    fn network_operations_validate_payload_and_use_content_addressed_files() {
        let mut provider = SandboxProvider::new()
            .with_response(
                "https://example.test/upload",
                json!({
                    "statusCode": 201,
                    "header": {"x-test": "ok"},
                    "data": "uploaded"
                }),
            )
            .with_response("https://example.test/download", json!("downloaded"))
            .seed_file("/tmp/input.txt", "payload");
        let context = ProviderContext::default();

        let upload = provider
            .call(
                "wx.uploadFile",
                json!({
                    "url": "https://example.test/upload",
                    "filePath": "wxfile:///tmp/input.txt",
                    "name": "file"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(
            upload,
            json!({
                "data": "uploaded",
                "errMsg": "uploadFile:ok",
                "statusCode": 201,
            })
        );

        let download = provider
            .call(
                "wx.downloadFile",
                json!({
                    "url": "https://example.test/download",
                    "filePath": "/tmp/output.txt"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(download["tempFilePath"], "tmp/output.txt");
        let read = provider
            .call(
                "wx.fs.readFile",
                json!({"filePath": "/tmp/output.txt"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(read["data"], "downloaded");
    }

    #[test]
    fn network_request_normalizes_method_and_transfer_results_match_public_shapes() {
        let mut provider = SandboxProvider::new()
            .with_response(
                "https://example.test/request",
                json!({"data": {"ok": true}}),
            )
            .with_response(
                "https://example.test/upload",
                json!({"data": 42, "statusCode": 201, "header": {"x-test": "ignored"}}),
            )
            .with_response("https://example.test/download", json!("downloaded"))
            .seed_file("/tmp/input.txt", "payload");
        let context = ProviderContext::default();

        let request = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test/request", "method": " post "})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(request["data"], json!({"ok": true}));
        assert_eq!(request["header"], json!({}));

        let upload = provider
            .call(
                "wx.uploadFile",
                json!({
                    "url": "https://example.test/upload",
                    "filePath": "/tmp/input.txt",
                    "name": "file"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(
            upload,
            json!({"data": "42", "errMsg": "uploadFile:ok", "statusCode": 201})
        );
        assert!(upload.get("header").is_none());
        assert!(upload.get("filePath").is_none());

        let download = provider
            .call(
                "wx.downloadFile",
                json!({"url": "https://example.test/download"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        let temp_file_path = download["tempFilePath"].as_str().unwrap();
        assert!(temp_file_path.starts_with("temp/"));
        assert_eq!(download["statusCode"], 200);
        assert_eq!(download["errMsg"], "downloadFile:ok");
        let read = provider
            .call(
                "wx.fs.readFile",
                json!({"filePath": temp_file_path}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(read["data"], "downloaded");

        let invalid_method = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test/request", "method": 3})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(invalid_method.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn network_operations_preserve_timeout_cancellation_and_permission_codes() {
        let mut provider = SandboxProvider::new().deny("network");
        let context = ProviderContext::default();
        let denied = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test"}).as_object().unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(denied.code, ProviderErrorCode::PermissionDenied);

        let mut provider = SandboxProvider::new();
        let timeout = provider
            .call(
                "wx.request",
                json!({"url": "timeout://example.test"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(timeout.code, ProviderErrorCode::Timeout);

        provider.cancel("request-1");
        let cancelled = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test", "cancelToken": "request-1"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(cancelled.code, ProviderErrorCode::Cancelled);

        let deadline = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        let expired = provider
            .call(
                "wx.request",
                json!({"url": "https://example.test"}).as_object().unwrap(),
                &deadline,
            )
            .unwrap_err();
        assert_eq!(expired.code, ProviderErrorCode::Timeout);
    }

    #[test]
    fn observer_provider_requires_session_owned_subscriptions_without_fake_measurements() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext {
            now_ns: 12_345_000,
            host: HostMetadata {
                window_width: 412,
                window_height: 915,
                ..HostMetadata::default()
            },
            ..ProviderContext::default()
        };
        for name in [
            "wx.createIntersectionObserver",
            "wx.createMediaQueryObserver",
        ] {
            assert!(
                !provider.capabilities().contains_key(name),
                "a standalone provider must not advertise Session-owned observation"
            );
            for options in [
                json!({"action":"observe", "selector":".hero", "descriptor":{"minWidth":400}}),
                json!({"action":"disconnect", "observerId":1}),
                json!({}),
            ] {
                let error = provider
                    .call(name, options.as_object().unwrap(), &context)
                    .expect_err(
                        "standalone provider cannot supply a view measurement or subscription",
                    );
                assert_eq!(error.code, ProviderErrorCode::Unsupported, "{name}");
                assert!(error.message.contains("Session-managed observation"));
                assert!(!error.retryable);
            }
        }
    }

    #[test]
    fn observer_provider_preserves_deadline_and_cancellation_boundary() {
        let mut provider = SandboxProvider::new();
        let expired = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        provider.cancel("observer-request");
        let cancelled = ProviderContext {
            cancel_token: Some("observer-request".into()),
            ..ProviderContext::default()
        };
        for name in [
            "wx.createIntersectionObserver",
            "wx.createMediaQueryObserver",
        ] {
            let error = provider
                .call(name, &Map::new(), &expired)
                .expect_err("expired operation fails before standalone capability dispatch");
            assert_eq!(error.code, ProviderErrorCode::Timeout, "{name}");
            let error = provider
                .call(name, &Map::new(), &cancelled)
                .expect_err("cancelled operation fails before standalone capability dispatch");
            assert_eq!(error.code, ProviderErrorCode::Cancelled, "{name}");
        }
    }

    #[test]
    fn media_picker_validates_options_and_returns_stable_empty_selection() {
        let mut provider = SandboxProvider::new().grant("photos/camera");
        let context = ProviderContext::default();
        let selected = provider
            .call(
                "wx.chooseMedia",
                json!({
                    "count": 2,
                    "mediaType": ["image"],
                    "sourceType": ["camera"],
                    "camera": "front"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(selected["tempFiles"], json!([]));
        assert_eq!(selected["tempFilePaths"], json!([]));
        assert_eq!(selected["errMsg"], "wx.chooseMedia:ok");

        let image = provider
            .call(
                "wx.chooseImage",
                json!({"count": 1, "sizeType": ["compressed"]})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(image["tempFilePaths"], json!([]));
        assert_eq!(image["errMsg"], "wx.chooseImage:ok");

        // The option is validated but is not echoed into the documented
        // success result; only the temp-file fields and errMsg cross the
        // provider boundary.
        provider
            .call("wx.chooseMedia", &Map::new(), &context)
            .unwrap();

        let invalid_count = provider.call(
            "wx.chooseMedia",
            json!({"count": 10}).as_object().unwrap(),
            &context,
        );
        assert_eq!(
            invalid_count.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
        let invalid_source = provider.call(
            "wx.chooseImage",
            json!({"sourceType": ["files"]}).as_object().unwrap(),
            &context,
        );
        assert_eq!(
            invalid_source.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
    }

    #[test]
    fn media_picker_checks_permission_deadline_and_cancellation() {
        let provider = SandboxProvider::new();
        let denied = provider
            .clone()
            .call("wx.chooseMedia", &Map::new(), &ProviderContext::default())
            .unwrap_err();
        assert_eq!(denied.code, ProviderErrorCode::PermissionDenied);

        let mut provider = provider.grant("photos/camera");
        let deadline = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        let timed_out = provider
            .call("wx.chooseImage", &Map::new(), &deadline)
            .unwrap_err();
        assert_eq!(timed_out.code, ProviderErrorCode::Timeout);

        provider.cancel("media-request");
        let cancelled = ProviderContext {
            cancel_token: Some("media-request".into()),
            ..ProviderContext::default()
        };
        let cancelled = provider
            .call("wx.chooseImage", &Map::new(), &cancelled)
            .unwrap_err();
        assert_eq!(cancelled.code, ProviderErrorCode::Cancelled);
    }

    #[test]
    fn every_provider_operation_honors_context_before_dispatch() {
        let mut provider = SandboxProvider::new().grant("account");
        let expired = ProviderContext {
            now_ns: 50,
            deadline_ns: Some(50),
            ..ProviderContext::default()
        };

        // These operations do not perform network, file, or location work,
        // so they previously bypassed the provider context guard entirely.
        // An expired bridge request must still fail before producing a
        // sandbox value or touching host state.
        for name in [
            "wx.getSystemInfo",
            "wx.getClipboardData",
            "wx.login",
            "wx.createMediaQueryObserver",
        ] {
            let error = provider
                .call(name, &Map::new(), &expired)
                .expect_err("expired provider call must fail");
            assert_eq!(error.code, ProviderErrorCode::Timeout, "{name}");
        }

        provider.cancel("device-request");
        let cancelled = ProviderContext {
            cancel_token: Some("device-request".into()),
            ..ProviderContext::default()
        };
        let error = provider
            .call("wx.getClipboardData", &Map::new(), &cancelled)
            .expect_err("cancelled provider call must fail");
        assert_eq!(error.code, ProviderErrorCode::Cancelled);
    }

    #[test]
    fn battery_info_returns_documented_shape_and_honors_context() {
        let mut provider = SandboxProvider::new().battery(37, true);
        let result = provider
            .call(
                "wx.getBatteryInfo",
                &Map::new(),
                &ProviderContext::default(),
            )
            .expect("battery snapshot should be deterministic");
        assert_eq!(result["level"], 37);
        assert_eq!(result["isCharging"], true);
        assert_eq!(result["errMsg"], "getBatteryInfo:ok");
        let sync_result = provider
            .call(
                "wx.getBatteryInfoSync",
                &Map::new(),
                &ProviderContext::default(),
            )
            .expect("synchronous battery snapshot should be deterministic");
        assert_eq!(sync_result["level"], 37);
        assert_eq!(sync_result["isCharging"], true);
        assert_eq!(sync_result["errMsg"], "getBatteryInfoSync:ok");

        let expired = ProviderContext {
            now_ns: 100,
            deadline_ns: Some(100),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getBatteryInfo", &Map::new(), &expired)
                .expect_err("expired battery call must fail")
                .code,
            ProviderErrorCode::Timeout
        );

        provider.cancel("battery-request");
        let cancelled = ProviderContext {
            cancel_token: Some("battery-request".into()),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getBatteryInfo", &Map::new(), &cancelled)
                .expect_err("cancelled battery call must fail")
                .code,
            ProviderErrorCode::Cancelled
        );
    }

    #[test]
    fn screen_brightness_provider_validates_range_permissions_and_context() {
        let mut provider = SandboxProvider::new()
            .screen_brightness(0.37)
            .expect("fixture brightness should be accepted");
        let context = ProviderContext::default();
        let initial = provider
            .call("wx.getScreenBrightness", &Map::new(), &context)
            .expect("brightness snapshot should be deterministic");
        assert_eq!(
            initial,
            json!({"value": 0.37, "errMsg": "getScreenBrightness:ok"})
        );
        let updated = provider
            .call(
                "wx.setScreenBrightness",
                json!({"value": 0.62}).as_object().unwrap(),
                &context,
            )
            .expect("brightness writes should be deterministic");
        assert_eq!(updated["errMsg"], "setScreenBrightness:ok");
        assert_eq!(provider.screen_brightness_value(), 0.62);

        for invalid in [-0.1, 1.1, f64::NAN, f64::INFINITY] {
            assert!(
                SandboxProvider::new().screen_brightness(invalid).is_err(),
                "invalid fixture brightness {invalid:?} must be rejected"
            );
        }
        for payload in [json!({}), json!({"value": -0.1}), json!({"value": 1.1})] {
            assert_eq!(
                provider
                    .call(
                        "wx.setScreenBrightness",
                        payload.as_object().unwrap(),
                        &context
                    )
                    .expect_err("invalid brightness request must fail")
                    .code,
                ProviderErrorCode::InvalidRequest
            );
        }

        let mut denied = SandboxProvider::new().deny("device");
        assert_eq!(
            denied
                .call(
                    "wx.setScreenBrightness",
                    json!({"value": 0.4}).as_object().unwrap(),
                    &context
                )
                .expect_err("device permission denial must be visible")
                .code,
            ProviderErrorCode::PermissionDenied
        );
        let expired = ProviderContext {
            now_ns: 5,
            deadline_ns: Some(5),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getScreenBrightness", &Map::new(), &expired)
                .expect_err("expired brightness call must fail")
                .code,
            ProviderErrorCode::Timeout
        );
    }

    #[test]
    fn account_info_sync_returns_configured_mini_program_snapshot() {
        let mut provider = SandboxProvider::new().with_account_info("wxa-test", "release", "1.2.3");
        assert_eq!(
            provider.capabilities().get("wx.getAccountInfoSync"),
            Some(&CapabilitySupport::Full)
        );
        let result = provider
            .call(
                "wx.getAccountInfoSync",
                &Map::new(),
                &ProviderContext::default(),
            )
            .expect("account info snapshot should be deterministic");
        assert_eq!(
            result,
            json!({
                "miniProgram": {
                    "appId": "wxa-test",
                    "envVersion": "release",
                    "version": "1.2.3",
                },
                "plugin": {},
            })
        );

        let expired = ProviderContext {
            now_ns: 100,
            deadline_ns: Some(100),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getAccountInfoSync", &Map::new(), &expired)
                .expect_err("expired account info call must fail")
                .code,
            ProviderErrorCode::Timeout
        );
    }

    #[test]
    fn account_info_sync_rejects_unknown_environment_versions() {
        let mut provider = SandboxProvider::new().with_account_info("wxa-test", "preview", "1.2.3");
        let error = provider
            .call(
                "wx.getAccountInfoSync",
                &Map::new(),
                &ProviderContext::default(),
            )
            .expect_err("unknown envVersion must not be exposed as success");
        assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
        assert_eq!(
            error.message,
            "getAccountInfoSync:fail envVersion must be develop, trial, or release (got preview)"
        );
    }

    #[test]
    fn login_establishes_account_session_and_check_session_reports_expiry() {
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new()
            .grant("account")
            .with_login_code("fixture-login-code");

        let before_login = provider
            .call("wx.checkSession", &Map::new(), &context)
            .expect_err("checkSession must fail before login");
        assert_eq!(before_login.code, ProviderErrorCode::InvalidRequest);
        assert_eq!(before_login.message, "checkSession:fail session expired");
        assert!(!provider.account_session_valid());

        let login = provider
            .call("wx.login", &Map::new(), &context)
            .expect("login should establish the sandbox session");
        assert_eq!(
            login,
            json!({
                "code": "fixture-login-code",
                "errMsg": "login:ok",
            })
        );
        assert!(provider.account_session_valid());

        let check = provider
            .call("wx.checkSession", &Map::new(), &context)
            .expect("checkSession should pass after login");
        assert_eq!(check["errMsg"], "checkSession:ok");

        let seeded = SandboxProvider::new()
            .grant("account")
            .with_account_session(true);
        assert_eq!(
            seeded
                .clone()
                .call("wx.checkSession", &Map::new(), &context)
                .expect("host-restored session should pass")["errMsg"],
            "checkSession:ok"
        );
    }

    #[test]
    fn login_and_check_session_keep_permission_timeout_and_cancel_errors() {
        let context = ProviderContext::default();
        let denied = SandboxProvider::new()
            .call("wx.login", &Map::new(), &context)
            .expect_err("login requires explicit account permission");
        assert_eq!(denied.code, ProviderErrorCode::PermissionDenied);

        let provider = SandboxProvider::new().grant("account");
        let expired = ProviderContext {
            now_ns: 100,
            deadline_ns: Some(100),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .clone()
                .call("wx.login", &Map::new(), &expired)
                .expect_err("expired login must fail before changing state")
                .code,
            ProviderErrorCode::Timeout
        );

        let mut cancelled_provider = provider;
        cancelled_provider.cancel("login-request");
        let cancelled = ProviderContext {
            cancel_token: Some("login-request".into()),
            ..ProviderContext::default()
        };
        assert_eq!(
            cancelled_provider
                .call("wx.login", &Map::new(), &cancelled)
                .expect_err("cancelled login must fail before changing state")
                .code,
            ProviderErrorCode::Cancelled
        );
    }

    #[test]
    fn ext_config_sync_and_async_return_the_same_snapshot() {
        let mut provider = SandboxProvider::new().with_ext_config(json!({
            "feature": "enabled",
            "nested": {"count": 2},
        }));
        let sync = provider
            .call(
                "wx.getExtConfigSync",
                &Map::new(),
                &ProviderContext::default(),
            )
            .expect("sync ext config should be deterministic");
        assert_eq!(
            sync,
            json!({
                "extConfig": {"feature": "enabled", "nested": {"count": 2}},
            })
        );
        let asynchronous = provider
            .call("wx.getExtConfig", &Map::new(), &ProviderContext::default())
            .expect("async ext config should be deterministic");
        assert_eq!(
            asynchronous,
            json!({
                "extConfig": {"feature": "enabled", "nested": {"count": 2}},
                "errMsg": "getExtConfig:ok",
            })
        );
    }

    #[test]
    fn system_info_async_result_has_success_envelope_without_polluting_sync_shape() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let synchronous = provider
            .call("wx.getSystemInfoSync", &Map::new(), &context)
            .expect("sync system info should be deterministic");
        assert!(synchronous.get("errMsg").is_none());

        let asynchronous = provider
            .call("wx.getSystemInfo", &Map::new(), &context)
            .expect("async system info should be deterministic");
        assert_eq!(asynchronous["errMsg"], "getSystemInfo:ok");
        assert_eq!(asynchronous["SDKVersion"], synchronous["SDKVersion"]);
    }

    #[test]
    fn system_info_snapshot_injects_typed_fields_and_keeps_host_geometry_dynamic() {
        let mut provider = SandboxProvider::new()
            .with_system_info(SystemInfoSnapshot {
                brand: "Apple".into(),
                model: "iPhone 15 Pro".into(),
                pixel_ratio: 3.0,
                language: "en_US".into(),
                sdk_version: "3.17.3".into(),
                status_bar_height: 59,
                device_orientation: "portrait".into(),
                theme: "dark".into(),
                font_size_setting: 18.0,
            })
            .expect("typed system info snapshot should validate");
        let context = ProviderContext {
            host: HostMetadata {
                kind: HostKind::Ios,
                platform: "ios".into(),
                version: "iOS 17.6".into(),
                user_agent: "weapp-ios-test".into(),
                window_width: 393,
                window_height: 852,
                ..HostMetadata::default()
            },
            ..ProviderContext::default()
        };
        let sync = provider
            .clone()
            .call("wx.getSystemInfoSync", &Map::new(), &context)
            .expect("sync system info should use typed snapshot");
        assert_eq!(sync["brand"], "Apple");
        assert_eq!(sync["model"], "iPhone 15 Pro");
        assert_eq!(sync["pixelRatio"], 3.0);
        assert_eq!(sync["statusBarHeight"], 59);
        assert_eq!(sync["language"], "en_US");
        assert_eq!(sync["theme"], "dark");
        assert_eq!(sync["fontSizeSetting"], 18.0);
        assert_eq!(sync["windowWidth"], 393);
        assert_eq!(sync["windowHeight"], 852);
        assert_eq!(sync["platform"], "ios");
        assert_eq!(sync["system"], "iOS 17.6");
        assert_eq!(sync["userAgent"], "weapp-ios-test");
        assert!(sync.get("errMsg").is_none());

        let asynchronous = provider
            .call("wx.getSystemInfo", &Map::new(), &context)
            .expect("async system info should share the typed snapshot");
        assert_eq!(asynchronous["errMsg"], "getSystemInfo:ok");
        assert_eq!(asynchronous["safeArea"]["width"], 393);
        assert_eq!(asynchronous["safeArea"]["height"], 852);

        let app_base = provider
            .call("wx.getAppBaseInfo", &Map::new(), &context)
            .expect("app base info should derive theme and scale");
        assert_eq!(app_base["theme"], "dark");
        assert_eq!(app_base["fontSizeScaleFactor"], 1.125);
    }

    #[test]
    fn system_info_snapshot_rejects_invalid_numeric_values() {
        let invalid_pixel = SandboxProvider::new().with_system_info(SystemInfoSnapshot {
            pixel_ratio: 0.0,
            ..SystemInfoSnapshot::default()
        });
        assert_eq!(
            invalid_pixel.expect_err("zero pixel ratio must fail").code,
            ProviderErrorCode::InvalidRequest
        );

        let invalid_font = SandboxProvider::new().with_system_info(SystemInfoSnapshot {
            font_size_setting: f64::NAN,
            ..SystemInfoSnapshot::default()
        });
        assert_eq!(
            invalid_font
                .expect_err("non-finite font size must fail")
                .code,
            ProviderErrorCode::InvalidRequest
        );

        for field in ["device_orientation", "theme"] {
            let invalid = if field == "device_orientation" {
                SystemInfoSnapshot {
                    device_orientation: "diagonal".into(),
                    ..SystemInfoSnapshot::default()
                }
            } else {
                SystemInfoSnapshot {
                    theme: "sepia".into(),
                    ..SystemInfoSnapshot::default()
                }
            };
            assert_eq!(
                SandboxProvider::new()
                    .with_system_info(invalid)
                    .expect_err("closed system info enum must fail")
                    .code,
                ProviderErrorCode::InvalidRequest,
                "invalid {field} should be rejected"
            );
        }
    }

    #[test]
    fn device_info_returns_host_fields_and_provider_snapshot() {
        let provider = SandboxProvider::new().with_device_info(DeviceInfoSnapshot {
            brand: "Apple".into(),
            model: "iPhone 15 Pro".into(),
            abi: "arm64-v8a".into(),
            cpu_type: "A17 Pro".into(),
            memory_size: 8192,
            benchmark_level: 42,
        });
        let value = provider
            .clone()
            .call(
                "wx.getDeviceInfo",
                &Map::new(),
                &ProviderContext {
                    host: HostMetadata {
                        platform: "ios".into(),
                        version: "iOS 17.6".into(),
                        window_width: 393,
                        window_height: 852,
                        ..HostMetadata::default()
                    },
                    ..ProviderContext::default()
                },
            )
            .expect("device info snapshot should be deterministic");
        assert_eq!(
            value,
            json!({
                "abi": "arm64-v8a",
                "benchmarkLevel": 42,
                "brand": "Apple",
                "cpuType": "A17 Pro",
                "memorySize": 8192,
                "model": "iPhone 15 Pro",
                "platform": "ios",
                "system": "iOS 17.6",
            })
        );
    }

    #[test]
    fn device_info_snapshot_rejects_missing_identity_and_invalid_benchmark() {
        let invalid_brand = SandboxProvider::new().try_with_device_info(DeviceInfoSnapshot {
            brand: " ".into(),
            ..DeviceInfoSnapshot::default()
        });
        assert_eq!(
            invalid_brand
                .expect_err("blank device brand must fail")
                .code,
            ProviderErrorCode::InvalidRequest
        );

        let invalid_benchmark = SandboxProvider::new().try_with_device_info(DeviceInfoSnapshot {
            benchmark_level: -2,
            ..DeviceInfoSnapshot::default()
        });
        assert_eq!(
            invalid_benchmark
                .expect_err("benchmark below -1 must fail")
                .code,
            ProviderErrorCode::InvalidRequest
        );
    }

    #[test]
    fn device_provider_keeps_typed_network_and_side_effect_state() {
        let mut provider = SandboxProvider::new()
            .network_type("4g")
            .expect("4g is a supported public network type")
            .keep_screen_on(false);
        let context = ProviderContext::default();

        let network = provider
            .call("wx.getNetworkType", &Map::new(), &context)
            .expect("network snapshot should be deterministic");
        assert_eq!(network["networkType"], "4g");
        assert_eq!(network["isConnected"], true);
        provider
            .update_network_type(NetworkType::None)
            .expect("sandbox network transition updates snapshot");
        let disconnected = provider
            .call("wx.getNetworkType", &Map::new(), &context)
            .expect("updated network snapshot should be deterministic");
        assert_eq!(
            disconnected,
            json!({
                "networkType": "none",
                "isConnected": false,
                "errMsg": "getNetworkType:ok",
            })
        );

        provider
            .call(
                "wx.setKeepScreenOn",
                json!({"keepScreenOn": true}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        provider
            .call(
                "wx.vibrateShort",
                json!({"type": "heavy"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        provider
            .call("wx.vibrateLong", &Map::new(), &context)
            .unwrap();

        assert!(provider.device_state().keep_screen_on);
        assert_eq!(
            provider.device_state().vibrations,
            vec![
                VibrationRecord {
                    kind: "heavy".into(),
                    duration_ms: 30,
                },
                VibrationRecord {
                    kind: "long".into(),
                    duration_ms: 400,
                },
            ]
        );
    }

    #[test]
    fn device_provider_rejects_invalid_options_and_explicit_denials() {
        assert!(SandboxProvider::new().network_type("ethernet").is_err());
        let context = ProviderContext::default();
        let mut provider = SandboxProvider::new().deny("device").deny("clipboard");

        for (name, payload) in [
            ("wx.setKeepScreenOn", json!({"keepScreenOn": true})),
            ("wx.vibrateShort", json!({"type": "heavy"})),
            ("wx.vibrateLong", json!({})),
        ] {
            assert_eq!(
                provider
                    .call(name, payload.as_object().unwrap(), &context)
                    .unwrap_err()
                    .code,
                ProviderErrorCode::PermissionDenied,
                "{name}"
            );
        }

        assert_eq!(
            provider
                .call(
                    "wx.setClipboardData",
                    json!({"data": "secret"}).as_object().unwrap(),
                    &context,
                )
                .unwrap_err()
                .code,
            ProviderErrorCode::PermissionDenied
        );

        let mut provider = SandboxProvider::new();
        assert_eq!(
            provider
                .call(
                    "wx.setKeepScreenOn",
                    json!({"keepScreenOn": "yes"}).as_object().unwrap(),
                    &context,
                )
                .unwrap_err()
                .code,
            ProviderErrorCode::InvalidRequest
        );
        assert_eq!(
            provider
                .call(
                    "wx.vibrateShort",
                    json!({"type": "none"}).as_object().unwrap(),
                    &context,
                )
                .unwrap_err()
                .code,
            ProviderErrorCode::InvalidRequest
        );
        assert_eq!(
            provider
                .call(
                    "wx.vibrateLong",
                    json!({"type": "short"}).as_object().unwrap(),
                    &context,
                )
                .unwrap_err()
                .code,
            ProviderErrorCode::InvalidRequest
        );
    }

    #[test]
    fn ui_provider_records_state_and_validates_public_shapes() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let toast = provider
            .call(
                "wx.showToast",
                json!({"title": "Saved", "icon": "success", "duration": 800})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(toast["errMsg"], "showToast:ok");
        assert_eq!(
            provider.ui_state().toast.as_ref().unwrap()["title"],
            "Saved"
        );
        provider
            .call("wx.hideToast", &Map::new(), &context)
            .unwrap();
        assert!(provider.ui_state().toast.is_none());

        let modal = provider
            .call(
                "wx.showModal",
                json!({"title": "Confirm", "content": "Continue?"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(modal["confirm"], true);
        assert_eq!(modal["cancel"], false);
        let action = provider
            .call(
                "wx.showActionSheet",
                json!({"itemList": ["One", "Two"]}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(action["tapIndex"], 0);
        let invalid = provider.call(
            "wx.setNavigationBarColor",
            json!({"frontColor": "white", "backgroundColor": "#ffffff"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(invalid.unwrap_err().code, ProviderErrorCode::InvalidRequest);
        provider
            .call(
                "wx.setNavigationBarColor",
                json!({"frontColor": "#ffffff", "backgroundColor": "#000000"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(
            provider.ui_state().navigation_bar.as_ref().unwrap()["frontColor"],
            "#ffffff"
        );

        let title = provider
            .call(
                "wx.setNavigationBarTitle",
                json!({"title": "Saved"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(title["errMsg"], "setNavigationBarTitle:ok");
        assert_eq!(
            provider.ui_state().navigation_bar_title.as_deref(),
            Some("Saved")
        );
    }

    #[test]
    fn inner_audio_provider_models_transport_state_and_rejects_invalid_commands() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let create = provider
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-1", "command": "create"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(create["paused"], true);
        assert_eq!(provider.inner_audio_state("audio-1").unwrap().src, "");

        let set = provider
            .call(
                "wx.innerAudioContext",
                json!({
                    "contextId": "audio-1", "command": "set",
                    "src": "https://example.test/song.mp3", "volume": 0.5,
                    "loop": true, "playbackRate": 1.25
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(set["src"], "https://example.test/song.mp3");
        assert_eq!(set["volume"], 0.5);
        assert_eq!(set["loop"], true);

        let playing = provider
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-1", "command": "play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(playing["paused"], false);
        assert_eq!(playing["event"], "play");
        let seeked = provider
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-1", "command": "seek", "position": 3.5})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(seeked["currentTime"], 3.5);
        assert_eq!(seeked["event"], "seeked");

        let mut missing = SandboxProvider::new();
        missing
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-2", "command": "create"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        let error = missing
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-2", "command": "play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::InvalidRequest);

        let destroyed = provider
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-1", "command": "destroy"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(destroyed["destroyed"], true);
        assert!(provider.inner_audio_state("audio-1").is_none());
        let after_destroy = provider
            .call(
                "wx.innerAudioContext",
                json!({"contextId": "audio-1", "command": "play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(after_destroy.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn audio_context_provider_reuses_component_scoped_inner_audio_state() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let created = provider
            .call(
                "wx.audioContext",
                json!({"contextId": "component-audio-intro", "command": "create"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(created["paused"], true);
        let set = provider
            .call(
                "wx.audioContext",
                json!({
                    "contextId": "component-audio-intro",
                    "command": "set",
                    "src": "https://example.test/intro.mp3"
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(set["src"], "https://example.test/intro.mp3");
        let playing = provider
            .call(
                "wx.audioContext",
                json!({"contextId": "component-audio-intro", "command": "play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(playing["paused"], false);
        let seeked = provider
            .call(
                "wx.audioContext",
                json!({
                    "contextId": "component-audio-intro",
                    "command": "seek",
                    "position": 2.5
                })
                .as_object()
                .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(seeked["currentTime"], 2.5);
        assert_eq!(
            provider
                .inner_audio_state("component-audio-intro")
                .unwrap()
                .src,
            "https://example.test/intro.mp3"
        );
        let invalid = provider.call(
            "wx.audioContext",
            json!({"contextId": "component-audio-intro", "command": "seek", "position": -1})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(invalid.unwrap_err().code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn video_context_provider_models_transport_ui_and_release() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let create = provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","videoId":"hero","command":"create"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(create["videoId"], "hero");
        let playing = provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(playing["playing"], true);
        let seeked = provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"seek","position":12.5})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(seeked["position"], 12.5);
        provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"sendDanmu","text":"hello","color":"#fff"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        let fullscreen = provider.call(
            "wx.videoContext",
            json!({"contextId":"video-1","command":"requestFullScreen","direction":"landscape"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            fullscreen.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
        provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"hideStatusBar"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert!(!provider.video_state("video-1").unwrap().status_bar_visible);
        let destroyed = provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"destroy"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(destroyed["destroyed"], true);
        assert!(provider.video_state("video-1").is_none());
        assert!(provider
            .call(
                "wx.videoContext",
                json!({"contextId":"video-1","command":"play"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .is_err());
    }

    #[test]
    fn camera_context_provider_validates_permission_options_and_no_device_fallback() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let created = provider
            .call(
                "wx.cameraContext",
                json!({"contextId":"camera-1","command":"create"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(created["contextId"], "camera-1");
        assert_eq!(created["recording"], false);

        let denied = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"takePhoto","quality":"high"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            denied.unwrap_err().code,
            ProviderErrorCode::PermissionDenied
        );

        provider = provider.grant("photos/camera");
        let invalid_quality = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"takePhoto","quality":"best"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            invalid_quality.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
        let invalid_timeout = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"startRecord","timeout":61})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            invalid_timeout.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
        let unsupported = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"takePhoto","quality":"low"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            unsupported.unwrap_err().code,
            ProviderErrorCode::Unsupported
        );
        assert_eq!(
            provider.camera_state("camera-1").unwrap().last_quality,
            "low"
        );

        let frame = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"frameStart"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(frame.unwrap_err().code, ProviderErrorCode::Unsupported);
        let destroyed = provider
            .call(
                "wx.cameraContext",
                json!({"contextId":"camera-1","command":"destroy"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(destroyed["destroyed"], true);
        assert!(provider.camera_state("camera-1").is_none());
        let after_destroy = provider.call(
            "wx.cameraContext",
            json!({"contextId":"camera-1","command":"takePhoto"})
                .as_object()
                .unwrap(),
            &context,
        );
        assert_eq!(
            after_destroy.unwrap_err().code,
            ProviderErrorCode::InvalidRequest
        );
    }

    #[test]
    fn menu_button_rect_uses_host_geometry_and_zero_fallback() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext::default();
        let zero = provider
            .call("wx.getMenuButtonBoundingClientRect", &Map::new(), &context)
            .unwrap();
        assert_eq!(
            zero,
            json!({"left": 0.0, "right": 0.0, "top": 0.0, "bottom": 0.0, "width": 0.0, "height": 0.0})
        );

        let host = HostMetadata {
            menu_button_rect: Some(crate::MenuButtonRect {
                left: 278.5,
                right: 365.25,
                top: 56.75,
                bottom: 88.5,
                width: 86.75,
                height: 31.75,
            }),
            ..HostMetadata::default()
        };
        let injected = provider
            .call(
                "wx.getMenuButtonBoundingClientRect",
                &Map::new(),
                &ProviderContext {
                    host,
                    ..ProviderContext::default()
                },
            )
            .unwrap();
        assert_eq!(injected["left"], 278.5);
        assert_eq!(injected["right"], 365.25);
        assert_eq!(injected["top"], 56.75);
        assert_eq!(injected["bottom"], 88.5);
        assert_eq!(injected["width"], 86.75);
        assert_eq!(injected["height"], 31.75);

        let expired = ProviderContext {
            now_ns: 10,
            deadline_ns: Some(10),
            ..ProviderContext::default()
        };
        assert_eq!(
            provider
                .call("wx.getMenuButtonBoundingClientRect", &Map::new(), &expired)
                .unwrap_err()
                .code,
            ProviderErrorCode::Timeout
        );
    }

    #[test]
    fn system_setting_returns_provider_snapshot_and_checks_deadline() {
        let provider = SandboxProvider::new().with_system_setting(SystemSettingSnapshot {
            bluetooth_enabled: true,
            location_enabled: true,
            wifi_enabled: false,
            device_orientation: "landscape".to_owned(),
        });
        let result = provider
            .clone()
            .call(
                "wx.getSystemSetting",
                &Map::new(),
                &ProviderContext::default(),
            )
            .unwrap();
        assert_eq!(
            result,
            json!({
                "bluetoothEnabled": true,
                "locationEnabled": true,
                "wifiEnabled": false,
                "deviceOrientation": "landscape"
            })
        );

        let expired = ProviderContext {
            now_ns: 42,
            deadline_ns: Some(42),
            ..ProviderContext::default()
        };
        let error = provider
            .clone()
            .call("wx.getSystemSetting", &Map::new(), &expired)
            .expect_err("expired sync calls must fail at provider boundary");
        assert_eq!(error.code, ProviderErrorCode::Timeout);
    }

    #[test]
    fn user_profile_requires_desc_and_returns_documented_snapshot() {
        let profile = UserProfileSnapshot {
            nick_name: "Ada".into(),
            avatar_url: "https://example.test/avatar.png".into(),
            gender: 1,
            country: "US".into(),
            province: "CA".into(),
            city: "San Francisco".into(),
            language: "en".into(),
        };
        let mut provider = SandboxProvider::new()
            .grant("profile")
            .with_user_profile(profile.clone());
        let context = ProviderContext::default();
        let missing_desc = provider
            .call("wx.getUserProfile", &Map::new(), &context)
            .expect_err("getUserProfile requires a consent description");
        assert_eq!(missing_desc.code, ProviderErrorCode::InvalidRequest);
        assert!(missing_desc.message.contains("desc"));

        let blank_desc = provider
            .call(
                "wx.getUserProfile",
                json!({"desc": "   "}).as_object().unwrap(),
                &context,
            )
            .expect_err("whitespace-only consent descriptions are invalid");
        assert_eq!(blank_desc.code, ProviderErrorCode::InvalidRequest);

        let result = provider
            .call(
                "wx.getUserProfile",
                json!({"desc": "Personalize your profile"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(result["errMsg"], "getUserProfile:ok");
        assert_eq!(result["userInfo"], serde_json::to_value(profile).unwrap());
        let raw_data = result["rawData"].as_str().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(raw_data).unwrap(),
            result["userInfo"]
        );
        assert_eq!(result["encryptedData"], "");
        assert_eq!(result["iv"], "");
        assert!(result["signature"]
            .as_str()
            .unwrap()
            .starts_with("weapp-sandbox-signature-"));
    }

    #[test]
    fn user_profile_permission_is_checked_before_consent_validation() {
        let mut provider = SandboxProvider::new();
        let error = provider
            .call(
                "wx.getUserProfile",
                json!({"desc": "Personalize your profile"})
                    .as_object()
                    .unwrap(),
                &ProviderContext::default(),
            )
            .expect_err("profile access without host permission must fail");
        assert_eq!(error.code, ProviderErrorCode::PermissionDenied);
    }

    #[test]
    fn filesystem_readdir_projects_immediate_children_and_sorts() {
        let mut provider = SandboxProvider::new()
            .seed_file("/docs/z.txt", "z")
            .seed_file("/docs/a.txt", "a")
            .seed_file("/docs/nested/value.json", "{}")
            .seed_file("/root.txt", "root");
        let context = ProviderContext::default();
        let docs = provider
            .call(
                "wx.fs.readdir",
                json!({"dirPath": "/docs"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(docs["errMsg"], "readdir:ok");
        assert_eq!(docs["files"], json!(["a.txt", "nested", "z.txt"]));
        let root = provider
            .call(
                "wx.fs.readdir",
                json!({"dirPath": "/"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(root["files"], json!(["docs", "root.txt"]));
        let empty = provider
            .call(
                "wx.fs.readdir",
                json!({"dirPath": "/missing"}).as_object().unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(empty["files"], json!([]));
        let invalid = provider
            .call("wx.fs.readdir", &Map::new(), &context)
            .expect_err("dirPath is required");
        assert_eq!(invalid.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn socket_provider_models_open_send_and_close_without_network() {
        let mut provider = SandboxProvider::new();
        let context = ProviderContext {
            session_id: "socket-test".into(),
            host: HostMetadata::default(),
            now_ns: 1,
            ..ProviderContext::default()
        };
        let opened = provider
            .call(
                "wx.connectSocket",
                json!({"url": "wss://example.test/socket", "protocols": ["json"]})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(opened["errMsg"], "connectSocket:ok");
        assert_eq!(opened["readyState"], "OPEN");
        let socket_id = opened["socketId"].as_str().unwrap().to_owned();
        let sent = provider
            .call(
                "wx.socketTask.send",
                json!({"socketId": socket_id, "data": "hello"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(sent["errMsg"], "sendSocketMessage:ok");
        assert_eq!(
            provider.socket_state(&socket_id).unwrap().sent,
            vec![json!("hello")]
        );
        let closed = provider
            .call(
                "wx.socketTask.close",
                json!({"socketId": socket_id, "code": 1001, "reason": "done"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap();
        assert_eq!(closed["errMsg"], "closeSocket:ok");
        assert_eq!(closed["readyState"], "CLOSED");
        assert_eq!(
            provider.socket_state(&socket_id).unwrap().close_code,
            Some(1001)
        );
        let error = provider
            .call(
                "wx.socketTask.send",
                json!({"socketId": socket_id, "data": "after-close"})
                    .as_object()
                    .unwrap(),
                &context,
            )
            .unwrap_err();
        assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
    }

    #[test]
    fn payment_provider_validates_and_records_typed_request() {
        let mut provider = SandboxProvider::new().grant("payments");
        let context = ProviderContext::default();
        let payload = json!({
            "timeStamp": "1710000000",
            "nonceStr": "nonce-123",
            "package": "prepay_id=wx123",
            "signType": "RSA",
            "paySign": "signed-value"
        });
        let result = provider
            .call("wx.requestPayment", payload.as_object().unwrap(), &context)
            .expect("valid payment request");
        assert_eq!(
            result,
            json!({"errMsg": "requestPayment:ok", "sandbox": true})
        );
        assert_eq!(
            provider.last_payment(),
            Some(&PaymentRequest {
                time_stamp: "1710000000".into(),
                nonce_str: "nonce-123".into(),
                package: "prepay_id=wx123".into(),
                sign_type: "RSA".into(),
                pay_sign: "signed-value".into(),
            })
        );
    }

    #[test]
    fn payment_provider_rejects_missing_and_invalid_fields_before_success() {
        let context = ProviderContext::default();
        for payload in [
            json!({}),
            json!({
                "timeStamp": "1710000000",
                "nonceStr": "nonce",
                "package": "prepay_id=wx123",
                "signType": "SHA1",
                "paySign": "signature"
            }),
            json!({
                "timeStamp": "1710000000",
                "nonceStr": "nonce",
                "package": "prepay_id=wx123",
                "signType": "MD5",
                "paySign": ""
            }),
        ] {
            let mut provider = SandboxProvider::new().grant("payments");
            let error = provider
                .call("wx.requestPayment", payload.as_object().unwrap(), &context)
                .expect_err("invalid payment request must fail");
            assert_eq!(error.code, ProviderErrorCode::InvalidRequest);
            assert!(provider.last_payment().is_none());
        }
    }

    #[test]
    fn payment_provider_checks_permission_before_recording_request() {
        let mut provider = SandboxProvider::new().deny("payments");
        let payload = json!({
            "timeStamp": "1710000000",
            "nonceStr": "nonce",
            "package": "prepay_id=wx123",
            "signType": "MD5",
            "paySign": "signature"
        });
        let error = provider
            .call(
                "wx.requestPayment",
                payload.as_object().unwrap(),
                &ProviderContext::default(),
            )
            .expect_err("denied payment must fail");
        assert_eq!(error.code, ProviderErrorCode::PermissionDenied);
        assert!(provider.last_payment().is_none());
    }
}
