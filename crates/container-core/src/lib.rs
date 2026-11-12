//! Host-independent mini-program runtime primitives.
//!
//! The core owns state and lifecycle semantics. Host adapters only translate
//! platform events and render commits; they do not maintain a second page
//! stack or apply patches one node at a time.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{collections::BTreeMap, fmt};

mod log_manager;
pub use log_manager::{LogManagerDrain, LogManagerJournal};

mod view;
#[doc(hidden)]
pub mod view_probe;
pub use view::*;
mod engine_terminal_resources;
#[doc(hidden)]
pub use engine_terminal_resources::EngineTerminalResources;
mod engine_execution;
pub use engine_execution::{EngineExecutionBudget, EngineTurnGuard};
mod buffer_urls;
#[cfg(feature = "conformance-observation")]
mod conformance_observation;
mod host_environment;
pub use buffer_urls::{BufferUrlStore, BUFFER_URL_MAX_BYTES};
#[cfg(feature = "conformance-observation")]
pub use conformance_observation::{
    ConformanceExceptionEvent, ConformanceExceptionObservation, ConformanceExceptionRequest,
    ConformanceGuestObservation, ConformanceGuestRequest, ConformanceGuestValue,
    ConformanceReceiverBinding, ConformanceThrownValue,
};

pub use host_environment::{app_service_environment_bootstrap, HostEnvironmentSnapshot};
mod route_transaction;
pub use route_transaction::{
    RouteRewriteError, RouteRewriteLease, RouteRewriteSlot, RouteRewriteValidator,
};
pub mod selector;
mod storage;
pub use storage::{
    MemoryStorage, PreparedStorageTransaction, StorageCommit, StorageEntryUsage, StorageError,
    StorageLimits, StorageMutation, StorageQuotaStatus, StorageReceipt, StorageRestorePolicy,
    StorageSnapshot, StorageStamp, StorageUsage, StorageValue, StorageValueRef,
};

mod performance_lifetime;
pub use performance_lifetime::PerformanceLifetime;

pub type ValueBatch = Vec<Value>;

/// Shared, host-independent CommonJS module cache used by both native engines.
pub const COMMONJS_MODULE_BOOTSTRAP: &str = include_str!("modules.js");

/// Shared asynchronous business messages and host-method facade for AppService.
pub const HOST_BRIDGE_BOOTSTRAP: &str = include_str!("host-bridge.js");

/// Shared component definitions, behavior identities and live relationship graph.
pub const COMPONENT_RELATION_BOOTSTRAP: &str = include_str!("component-relations.js");

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimerKind {
    Timeout,
    Interval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Ord, PartialOrd, Serialize, Deserialize)]
pub struct TimerId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimerEntry {
    pub id: TimerId,
    pub kind: TimerKind,
    /// Absolute Unix-epoch nanoseconds, supplied by the host clock.
    #[serde(rename = "dueNs")]
    pub due_ns: u64,
    /// The original delay. Interval timers use it for their next deadline.
    #[serde(rename = "delayMs")]
    pub delay_ms: u64,
    #[serde(
        rename = "callbackId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub callback_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimerFired {
    pub id: TimerId,
    pub kind: TimerKind,
    #[serde(rename = "firedNs")]
    pub fired_ns: u64,
    #[serde(
        rename = "callbackId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub callback_id: Option<String>,
}

/// Deterministic host-clock scheduler used by setTimeout/setInterval.
///
/// The scheduler never spawns a Rust thread. Hosts call [`TimerScheduler::poll`]
/// from their event loop and dispatch the returned batch to the selected JS
/// engine. This keeps timers cancellable and avoids one native thread per JS
/// callback across all six host families.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TimerScheduler {
    next_id: u64,
    entries: BTreeMap<TimerId, TimerEntry>,
}

impl TimerScheduler {
    pub fn pending(&self) -> usize {
        self.entries.len()
    }

    pub fn is_pending(&self, id: TimerId) -> bool {
        self.entries.contains_key(&id)
    }

    pub fn entries(&self) -> impl Iterator<Item = &TimerEntry> {
        self.entries.values()
    }

    pub fn schedule_timeout(
        &mut self,
        delay_ms: u64,
        now_ns: u64,
        callback_id: Option<String>,
    ) -> TimerId {
        self.schedule(TimerKind::Timeout, delay_ms, now_ns, callback_id)
    }

    pub fn schedule_interval(
        &mut self,
        delay_ms: u64,
        now_ns: u64,
        callback_id: Option<String>,
    ) -> TimerId {
        self.schedule(TimerKind::Interval, delay_ms, now_ns, callback_id)
    }

    pub fn schedule(
        &mut self,
        kind: TimerKind,
        delay_ms: u64,
        now_ns: u64,
        callback_id: Option<String>,
    ) -> TimerId {
        self.next_id = self.next_id.saturating_add(1).max(1);
        let id = TimerId(self.next_id);
        let due_ns = now_ns.saturating_add(delay_ms.saturating_mul(1_000_000));
        self.entries.insert(
            id,
            TimerEntry {
                id,
                kind,
                due_ns,
                delay_ms,
                callback_id,
            },
        );
        id
    }

    pub fn cancel(&mut self, id: TimerId) -> bool {
        self.entries.remove(&id).is_some()
    }

    pub fn clear(&mut self) -> usize {
        let count = self.entries.len();
        self.entries.clear();
        count
    }

    /// Poll due timers in deadline/id order. One interval firing is produced
    /// per poll; the next interval deadline is based on the observed clock so
    /// a stalled host cannot enqueue an unbounded catch-up burst.
    pub fn poll(&mut self, now_ns: u64) -> Vec<TimerFired> {
        let mut due: Vec<TimerEntry> = self
            .entries
            .values()
            .filter(|entry| entry.due_ns <= now_ns)
            .cloned()
            .collect();
        due.sort_by_key(|entry| (entry.due_ns, entry.id));
        let mut fired = Vec::with_capacity(due.len());
        for entry in due {
            match entry.kind {
                TimerKind::Timeout => {
                    self.entries.remove(&entry.id);
                }
                TimerKind::Interval => {
                    if let Some(current) = self.entries.get_mut(&entry.id) {
                        let interval_ns = entry.delay_ms.saturating_mul(1_000_000);
                        // A zero-delay interval must still make progress when
                        // a host polls repeatedly at the same timestamp.
                        let interval_ns = interval_ns.max(1);
                        current.due_ns = now_ns.saturating_add(interval_ns);
                    }
                }
            }
            fired.push(TimerFired {
                id: entry.id,
                kind: entry.kind,
                fired_ns: now_ns,
                callback_id: entry.callback_id,
            });
        }
        fired
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EngineKind {
    Quickjs,
    V8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ModuleId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CallTarget {
    Module { id: ModuleId, export: String },
    Global { name: String },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    pub bytes: Vec<u8>,
    pub engine: Option<EngineKind>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineErrorCode {
    ModuleLoad,
    Call,
    Microtasks,
    Snapshot,
    Interrupted,
    Timeout,
    Cancelled,
    RequiresRestart,
    UnsupportedExecutionBudget,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineError {
    pub code: EngineErrorCode,
    pub message: String,
}

impl EngineError {
    pub fn new(code: EngineErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for EngineError {}

/// Engine boundary used by both QuickJS and V8 adapters.
///
/// Calls receive and return batches so a renderer or host does not incur one
/// FFI round-trip per WXML node or property.
/// JavaScript engines are thread-affine by default. Hosts that need to move a
/// session between threads must provide an explicit proxy instead of moving
/// the engine object across an FFI boundary.
/// An independent, bounded synchronous host service. Implementations must not
/// reenter Session, execute guest JavaScript, or wait for an async host command.
pub trait SyncHostApi: Send + Sync {
    fn supported_apis(&self) -> Vec<String>;
    /// Permanently retire this execution owner's services and drain resources.
    /// Implementations without owned resources retain the default behavior.
    fn retire(&self) {}
    fn invoke(
        &self,
        name: &str,
        payload: serde_json::Value,
    ) -> Result<serde_json::Value, serde_json::Value>;
}

/// Shared wire boundary for native callbacks in both engines. A faulty host
/// implementation cannot unwind through the JavaScript VM's native ABI.
pub fn invoke_sync_host_api(provider: &dyn SyncHostApi, name: &str, payload: &str) -> String {
    let failed = |message: &str| {
        serde_json::json!({"ok":false,"error":{"code":"ERR_INVALID_REQUEST","errMsg":format!("{name}:fail {message}"),"api":name}}).to_string()
    };
    if name.len() > 256 || payload.len() > 8 * 1024 * 1024 {
        return failed("synchronous request byte budget exceeded");
    }
    let Ok(payload) = serde_json::from_str(payload) else {
        return failed("invalid synchronous request JSON");
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        provider.invoke(name, payload)
    }));
    let response = match result {
        Ok(Ok(value)) => serde_json::json!({"ok":true,"value":value}),
        Ok(Err(error)) => serde_json::json!({"ok":false,"error":error}),
        Err(_) => return failed("synchronous host callback failed"),
    };
    match serde_json::to_string(&response) {
        Ok(text) if text.len() <= 8 * 1024 * 1024 => text,
        _ => failed("synchronous result byte budget exceeded"),
    }
}

/// A native-owned result claimed immediately before its guest continuation.
/// `Retired` deliberately runs no callbacks in an execution owner that ended.
#[derive(Clone, Debug, PartialEq)]
pub enum ApiDeliveryOutcome {
    Success(Value),
    Failure(Value),
    Retired,
}

/// Independent of Session and the VM. Implementations must release their
/// synchronization before returning and must not reenter JS or await work.
/// The provider, rather than the ticket JSON, decides ownership and authority.
pub trait ApiDeliveryProvider: Send + Sync {
    fn claim(&self, request_id: u64, ticket: &str) -> ApiDeliveryOutcome;
}

// The payload budget matches Session's accepted native results. Envelope
// syntax has a separate fixed allowance, rather than reducing that payload.
const MAX_API_DELIVERY_BYTES: usize = 64 * 1024 * 1024;
const API_DELIVERY_ENVELOPE_BYTES: usize = 64;
const MAX_API_DELIVERY_TICKET_BYTES: usize = 512;
const MAX_JS_REQUEST_ID: u64 = (1 << 53) - 1;

fn api_delivery_failure(message: &str) -> String {
    serde_json::json!({"status":"failure","error":{
        "code":"ERR_API_DELIVERY","errMsg":format!("native API delivery failed: {message}")
    }})
    .to_string()
}

/// Bounded, panic-isolated wire boundary shared by the two native engines.
pub fn invoke_api_delivery_provider(
    provider: &dyn ApiDeliveryProvider,
    request_id: u64,
    ticket: &str,
) -> String {
    if request_id == 0 || request_id > MAX_JS_REQUEST_ID {
        return api_delivery_failure("invalid request ID");
    }
    if ticket.is_empty() || ticket.len() > MAX_API_DELIVERY_TICKET_BYTES {
        return api_delivery_failure("invalid ticket");
    }
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        provider.claim(request_id, ticket)
    }));
    let (prefix, payload) = match outcome {
        Ok(ApiDeliveryOutcome::Success(result)) => ("{\"status\":\"success\",\"result\":", result),
        Ok(ApiDeliveryOutcome::Failure(error)) => ("{\"status\":\"failure\",\"error\":", error),
        Ok(ApiDeliveryOutcome::Retired) => return "{\"status\":\"retired\"}".into(),
        Err(_) => return api_delivery_failure("provider panicked"),
    };
    debug_assert!(prefix.len() < API_DELIVERY_ENVELOPE_BYTES);
    // Write directly into the envelope, counting only the payload against the
    // accepted result limit. This needs no second large encoded allocation.
    struct BoundedWriter {
        bytes: Vec<u8>,
        payload_start: usize,
    }
    impl std::io::Write for BoundedWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let payload_bytes = self.bytes.len() - self.payload_start;
            if bytes.len() > MAX_API_DELIVERY_BYTES.saturating_sub(payload_bytes) {
                return Err(std::io::Error::other("API delivery byte limit exceeded"));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = BoundedWriter {
        bytes: prefix.as_bytes().to_vec(),
        payload_start: prefix.len(),
    };
    if serde_json::to_writer(&mut writer, &payload).is_err() {
        return api_delivery_failure("result byte limit exceeded");
    }
    writer.bytes.push(b'}');
    String::from_utf8(writer.bytes).expect("serde_json emits UTF-8")
}

/// The callback exists before bootstrap, while its native provider is installed
/// once later. Guest code can neither replace the callback nor fill this slot.
#[doc(hidden)]
#[derive(Default)]
pub struct ApiDeliveryProviderSlot(
    std::sync::Mutex<Option<std::sync::Arc<dyn ApiDeliveryProvider>>>,
);

impl ApiDeliveryProviderSlot {
    pub fn install(
        &self,
        provider: std::sync::Arc<dyn ApiDeliveryProvider>,
    ) -> Result<(), EngineError> {
        let mut slot = self.0.lock().map_err(|_| {
            EngineError::new(EngineErrorCode::Call, "API delivery provider lock poisoned")
        })?;
        if slot.is_some() {
            return Err(EngineError::new(
                EngineErrorCode::Call,
                "API delivery provider already installed",
            ));
        }
        *slot = Some(provider);
        Ok(())
    }

    pub fn claim_json(&self, request_id: u64, ticket: &str) -> String {
        let provider = match self.0.lock() {
            Ok(slot) => slot.clone(),
            Err(_) => return api_delivery_failure("provider lock poisoned"),
        };
        match provider {
            Some(provider) => invoke_api_delivery_provider(provider.as_ref(), request_id, ticket),
            None => api_delivery_failure("provider unavailable"),
        }
    }
}

#[cfg(test)]
mod api_delivery_tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Weak,
    };

    struct CountClaims(AtomicUsize);
    impl ApiDeliveryProvider for CountClaims {
        fn claim(&self, _: u64, _: &str) -> ApiDeliveryOutcome {
            self.0.fetch_add(1, Ordering::SeqCst);
            ApiDeliveryOutcome::Success(Value::Null)
        }
    }

    fn response(text: String) -> Value {
        serde_json::from_str(&text).unwrap()
    }

    #[test]
    fn api_delivery_invalid_ids_and_ticket_bytes_never_reach_authority() {
        let provider = CountClaims(AtomicUsize::new(0));
        for (id, ticket) in [
            (0, "ticket".to_owned()),
            (MAX_JS_REQUEST_ID + 1, "ticket".to_owned()),
            (1, String::new()),
            (1, "é".repeat(257)),
        ] {
            let result = response(invoke_api_delivery_provider(&provider, id, &ticket));
            assert_eq!(result["status"], "failure");
            assert_eq!(result["error"]["code"], "ERR_API_DELIVERY");
        }
        assert_eq!(provider.0.load(Ordering::SeqCst), 0);
        assert_eq!(
            response(invoke_api_delivery_provider(
                &provider,
                MAX_JS_REQUEST_ID,
                &"é".repeat(256)
            )),
            serde_json::json!({"status":"success","result":null})
        );
        assert_eq!(provider.0.load(Ordering::SeqCst), 1);
    }

    struct BrokenProvider(bool);
    impl ApiDeliveryProvider for BrokenProvider {
        fn claim(&self, _: u64, _: &str) -> ApiDeliveryOutcome {
            if self.0 {
                panic!("provider test panic");
            }
            ApiDeliveryOutcome::Success(Value::String("x".repeat(MAX_API_DELIVERY_BYTES)))
        }
    }

    #[test]
    fn api_delivery_provider_panic_and_output_limit_fail_closed() {
        for provider in [BrokenProvider(true), BrokenProvider(false)] {
            let result = response(invoke_api_delivery_provider(&provider, 1, "ticket"));
            assert_eq!(result["status"], "failure");
            assert_eq!(result["error"]["code"], "ERR_API_DELIVERY");
            assert!(result["error"]["errMsg"].as_str().unwrap().len() < 256);
        }
    }

    struct MaximumPayload(bool);
    impl ApiDeliveryProvider for MaximumPayload {
        fn claim(&self, _: u64, _: &str) -> ApiDeliveryOutcome {
            // The two JSON quotes make this exactly the accepted payload cap.
            let payload = Value::String("x".repeat(MAX_API_DELIVERY_BYTES - 2));
            if self.0 {
                ApiDeliveryOutcome::Success(payload)
            } else {
                ApiDeliveryOutcome::Failure(payload)
            }
        }
    }

    #[test]
    fn api_delivery_payload_boundary_leaves_fixed_envelope_capacity() {
        for (success, prefix) in [
            (true, "{\"status\":\"success\",\"result\":"),
            (false, "{\"status\":\"failure\",\"error\":"),
        ] {
            let encoded = invoke_api_delivery_provider(&MaximumPayload(success), 1, "ticket");
            assert!(encoded.starts_with(prefix));
            assert_eq!(encoded.len(), MAX_API_DELIVERY_BYTES + prefix.len() + 1);
            assert!(encoded.ends_with("\"}"));
        }
    }

    struct ProbeSlot(Weak<ApiDeliveryProviderSlot>);
    impl ApiDeliveryProvider for ProbeSlot {
        fn claim(&self, _: u64, _: &str) -> ApiDeliveryOutcome {
            let slot = self.0.upgrade().unwrap();
            let unlocked = slot.0.try_lock().is_ok();
            ApiDeliveryOutcome::Success(Value::Bool(unlocked))
        }
    }

    #[test]
    fn api_delivery_slot_installs_once_and_releases_lock_before_provider() {
        let slot = Arc::new(ApiDeliveryProviderSlot::default());
        assert_eq!(response(slot.claim_json(1, "ticket"))["status"], "failure");
        slot.install(Arc::new(ProbeSlot(Arc::downgrade(&slot))))
            .unwrap();
        assert!(slot
            .install(Arc::new(CountClaims(AtomicUsize::new(0))))
            .is_err());
        assert_eq!(
            response(slot.claim_json(1, "ticket")),
            serde_json::json!({"status":"success","result":true})
        );
    }
}

pub trait JsEngine {
    fn install_api_delivery_provider(
        &mut self,
        _provider: std::sync::Arc<dyn ApiDeliveryProvider>,
    ) -> Result<(), EngineError> {
        Err(EngineError::new(
            EngineErrorCode::Call,
            "this engine does not support native API delivery claims",
        ))
    }

    fn install_sync_host_api(
        &mut self,
        _provider: std::sync::Arc<dyn SyncHostApi>,
    ) -> Result<(), EngineError> {
        Err(EngineError::new(
            EngineErrorCode::Call,
            "this engine does not support native synchronous host callbacks",
        ))
    }
    /// Bound all execution performed during one host turn, including nested
    /// calls, result conversion and microtask checkpoints. Adapters must not
    /// silently accept a finite budget they cannot enforce.
    fn begin_host_turn(
        &mut self,
        budget: EngineExecutionBudget,
    ) -> Result<EngineTurnGuard, EngineError> {
        if budget.is_unbounded() {
            Ok(EngineTurnGuard::unbounded())
        } else {
            Err(EngineError::new(
                EngineErrorCode::UnsupportedExecutionBudget,
                "this engine does not support bounded host turns",
            ))
        }
    }

    fn load_module(&mut self, module: &[u8]) -> Result<ModuleId, EngineError>;
    fn call(&mut self, target: CallTarget, args: ValueBatch) -> Result<ValueBatch, EngineError>;
    fn drain_microtasks(&mut self) -> Result<(), EngineError>;
    fn snapshot(&mut self) -> Result<Option<Snapshot>, EngineError>;
    fn interrupt(&mut self);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum LifecycleState {
    Created,
    Active,
    Background,
    Destroyed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LifecycleEvent {
    Launch,
    Show,
    Hide,
    Unload,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LifecycleError {
    InvalidTransition {
        state: LifecycleState,
        event: LifecycleEvent,
    },
    AlreadyDestroyed,
}

impl fmt::Display for LifecycleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition { state, event } => {
                write!(f, "cannot apply {event:?} in {state:?}")
            }
            Self::AlreadyDestroyed => f.write_str("runtime is destroyed"),
        }
    }
}

impl std::error::Error for LifecycleError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LifecycleController {
    state: LifecycleState,
    sequence: u64,
}

impl Default for LifecycleController {
    fn default() -> Self {
        Self {
            state: LifecycleState::Created,
            sequence: 0,
        }
    }
}

impl LifecycleController {
    pub fn state(&self) -> LifecycleState {
        self.state
    }
    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn dispatch(&mut self, event: LifecycleEvent) -> Result<LifecycleState, LifecycleError> {
        if self.state == LifecycleState::Destroyed {
            return Err(LifecycleError::AlreadyDestroyed);
        }
        let next = match (self.state, event) {
            (LifecycleState::Created, LifecycleEvent::Launch) => LifecycleState::Active,
            (LifecycleState::Active, LifecycleEvent::Show) => LifecycleState::Active,
            (LifecycleState::Background, LifecycleEvent::Show) => LifecycleState::Active,
            (LifecycleState::Active, LifecycleEvent::Hide) => LifecycleState::Background,
            (LifecycleState::Background, LifecycleEvent::Hide) => LifecycleState::Background,
            (LifecycleState::Active | LifecycleState::Background, LifecycleEvent::Unload) => {
                LifecycleState::Destroyed
            }
            _ => {
                return Err(LifecycleError::InvalidTransition {
                    state: self.state,
                    event,
                })
            }
        };
        self.state = next;
        self.sequence += 1;
        Ok(next)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct PageId(pub u64);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageEntry {
    pub id: PageId,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    /// The title currently assigned through `wx.setNavigationBarTitle`.
    /// Keeping it on the page entry makes the value follow the page instance
    /// through `navigateBack`, `switchTab` cache restoration and all host
    /// serialization boundaries. `navigation_bar_title_set` distinguishes an
    /// explicit empty title from the route default.
    #[serde(
        rename = "navigationBarTitle",
        default,
        skip_serializing_if = "String::is_empty"
    )]
    pub navigation_bar_title: String,
    /// Distinguishes an explicit empty title from the route default.
    #[serde(
        rename = "navigationBarTitleSet",
        default,
        skip_serializing_if = "is_false"
    )]
    pub navigation_bar_title_set: bool,
    #[serde(
        rename = "navigationBarColor",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub navigation_bar_color: Option<NavigationBarColor>,
    #[serde(default = "default_object")]
    pub data: Value,
}

fn is_false(value: &bool) -> bool {
    !value
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavigationBarColor {
    pub front_color: String,
    pub background_color: String,
}

fn default_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PageStackEvent {
    Pushed(PageId),
    Popped(PageId),
    Replaced { old: PageId, new: PageId },
    Cleared,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PageStackError {
    Empty,
    InvalidPath,
    UnknownPage(PageId),
}

impl fmt::Display for PageStackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("page stack is empty"),
            Self::InvalidPath => f.write_str("page path cannot be empty"),
            Self::UnknownPage(id) => write!(f, "unknown page {:?}", id),
        }
    }
}

impl std::error::Error for PageStackError {}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PageStack {
    pages: Vec<PageEntry>,
    next_id: u64,
}

impl PageStack {
    pub fn len(&self) -> usize {
        self.pages.len()
    }
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
    }
    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &PageEntry> {
        self.pages.iter()
    }
    pub fn current(&self) -> Option<&PageEntry> {
        self.pages.last()
    }
    pub fn current_mut(&mut self) -> Option<&mut PageEntry> {
        self.pages.last_mut()
    }
    pub fn get(&self, id: PageId) -> Option<&PageEntry> {
        self.pages.iter().find(|page| page.id == id)
    }
    pub fn get_mut(&mut self, id: PageId) -> Option<&mut PageEntry> {
        self.pages.iter_mut().find(|page| page.id == id)
    }

    pub fn push(
        &mut self,
        path: impl Into<String>,
    ) -> Result<(PageId, PageStackEvent), PageStackError> {
        let path = path.into();
        if path.trim().is_empty() {
            return Err(PageStackError::InvalidPath);
        }
        self.next_id += 1;
        let id = PageId(self.next_id);
        self.pages.push(PageEntry {
            id,
            path,
            query: BTreeMap::new(),
            navigation_bar_title: String::new(),
            navigation_bar_title_set: false,
            navigation_bar_color: None,
            data: default_object(),
        });
        Ok((id, PageStackEvent::Pushed(id)))
    }

    pub fn pop(&mut self) -> Result<(PageEntry, PageStackEvent), PageStackError> {
        let page = self.pages.pop().ok_or(PageStackError::Empty)?;
        Ok((page.clone(), PageStackEvent::Popped(page.id)))
    }

    pub fn replace(
        &mut self,
        path: impl Into<String>,
    ) -> Result<(PageId, PageStackEvent), PageStackError> {
        let path = path.into();
        if path.trim().is_empty() {
            return Err(PageStackError::InvalidPath);
        }
        let old = self.pages.pop().ok_or(PageStackError::Empty)?.id;
        self.next_id += 1;
        let id = PageId(self.next_id);
        self.pages.push(PageEntry {
            id,
            path,
            query: BTreeMap::new(),
            navigation_bar_title: String::new(),
            navigation_bar_title_set: false,
            navigation_bar_color: None,
            data: default_object(),
        });
        Ok((id, PageStackEvent::Replaced { old, new: id }))
    }

    pub fn clear(&mut self) -> Option<PageStackEvent> {
        if self.pages.is_empty() {
            None
        } else {
            self.pages.clear();
            Some(PageStackEvent::Cleared)
        }
    }

    /// Remove all currently visible pages and return their entries to the
    /// caller.  Hosts use this when changing tab roots so non-tab pages can
    /// be disposed while tab entries are retained in a runtime-owned cache.
    /// The page id sequence is deliberately left untouched; restoring a
    /// cached entry must never collide with a page created afterwards.
    pub fn take_all(&mut self) -> Vec<PageEntry> {
        std::mem::take(&mut self.pages)
    }

    /// Make one existing page entry the visible root while preserving its
    /// identity and data.  This is the page-stack primitive behind
    /// `wx.switchTab`: a cached tab is shown again without firing onLoad or
    /// allocating a new page id.
    pub fn activate_entry(&mut self, entry: PageEntry) {
        self.next_id = self.next_id.max(entry.id.0);
        self.pages.clear();
        self.pages.push(entry);
    }

    pub fn apply_data_batch(
        &mut self,
        page_id: PageId,
        batch: &DataPatchBatch,
    ) -> Result<usize, PageStackError> {
        let page = self
            .get_mut(page_id)
            .ok_or(PageStackError::UnknownPage(page_id))?;
        Ok(batch
            .patches
            .iter()
            .filter(|patch| apply_patch(&mut page.data, patch))
            .count())
    }

    /// Assign the per-instance navigation-bar title, including an explicit
    /// empty override of the route default.
    pub fn set_navigation_bar_title(
        &mut self,
        page_id: PageId,
        title: impl Into<String>,
    ) -> Result<(), PageStackError> {
        let page = self
            .get_mut(page_id)
            .ok_or(PageStackError::UnknownPage(page_id))?;
        page.navigation_bar_title = title.into();
        page.navigation_bar_title_set = true;
        Ok(())
    }

    pub fn set_navigation_bar_color(
        &mut self,
        page_id: PageId,
        color: NavigationBarColor,
    ) -> Result<(), PageStackError> {
        self.get_mut(page_id)
            .ok_or(PageStackError::UnknownPage(page_id))?
            .navigation_bar_color = Some(color);
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DataPatchOp {
    Set,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DataPatch {
    pub path: String,
    pub op: DataPatchOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
}

impl DataPatch {
    pub fn set(path: impl Into<String>, value: Value) -> Self {
        Self {
            path: path.into(),
            op: DataPatchOp::Set,
            value: Some(value),
        }
    }
    pub fn delete(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            op: DataPatchOp::Delete,
            value: None,
        }
    }

    /// The same typed path used by the Rust data store and by engine-side
    /// mirrors of host-originated patches. Strings are object keys and
    /// integers are array indices; a host never needs a per-node FFI call.
    pub fn path_tokens(&self) -> Option<Vec<DataPathToken>> {
        parse_path(&self.path)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DataPatchBatch {
    pub page_id: PageId,
    pub patches: Vec<DataPatch>,
}

fn default_event_bubbles() -> bool {
    true
}

/// A normalized event received from a host hit-test or native event source.
/// `path` is ordered from the rendered root to `target`; it is kept as a
/// batch-level value so capture and bubble dispatch never cross an FFI boundary
/// one node at a time.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EventInput {
    #[serde(rename = "type")]
    pub event_type: String,
    pub target: String,
    #[serde(default)]
    pub path: Vec<String>,
    #[serde(default)]
    pub dataset: Map<String, Value>,
    /// Event mark values inherited from rendered ancestors.  WXML `mark:*`
    /// attributes are merged from root to target; a nearer mark replaces a
    /// value with the same key.  Keeping the normalized object on the input
    /// lets native and JS hosts observe one stable event payload.
    #[serde(default)]
    pub mark: Map<String, Value>,
    #[serde(default)]
    pub detail: Value,
    #[serde(default)]
    pub capture: bool,
    #[serde(default = "default_event_bubbles")]
    pub bubbles: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventPhase {
    Capture,
    Target,
    Bubble,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EventDispatch {
    #[serde(rename = "type")]
    pub event_type: String,
    pub target: String,
    pub current_target: String,
    pub phase: EventPhase,
    #[serde(default)]
    pub dataset: Map<String, Value>,
    #[serde(default)]
    pub mark: Map<String, Value>,
    #[serde(default)]
    pub detail: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EventError {
    EmptyType,
    EmptyTarget,
    EmptyPath,
    PathTargetMismatch,
    DuplicatePathNode(String),
    EmptyPathNode,
}

impl fmt::Display for EventError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyType => f.write_str("event type cannot be empty"),
            Self::EmptyTarget => f.write_str("event target cannot be empty"),
            Self::EmptyPath => f.write_str("event path cannot be empty"),
            Self::PathTargetMismatch => f.write_str("event path must end at target"),
            Self::DuplicatePathNode(node) => write!(f, "event path contains duplicate node {node}"),
            Self::EmptyPathNode => f.write_str("event path contains an empty node"),
        }
    }
}

impl std::error::Error for EventError {}

/// Expand one normalized event into capture, target and bubble dispatches.
/// The returned vector is ordered exactly as handlers observe the event:
/// root-to-parent capture, target, then parent-to-root bubble.
pub fn dispatch_event(event: &EventInput) -> Result<Vec<EventDispatch>, EventError> {
    if event.event_type.trim().is_empty() {
        return Err(EventError::EmptyType);
    }
    if event.target.trim().is_empty() {
        return Err(EventError::EmptyTarget);
    }
    let mut path = event.path.clone();
    if path.is_empty() {
        path.push(event.target.clone());
    }
    if path.iter().any(|node| node.trim().is_empty()) {
        return Err(EventError::EmptyPathNode);
    }
    let mut seen = std::collections::HashSet::new();
    if path.iter().any(|node| !seen.insert(node)) {
        let duplicate = path
            .iter()
            .find(|node| path.iter().filter(|candidate| *candidate == *node).count() > 1)
            .cloned()
            .unwrap_or_default();
        return Err(EventError::DuplicatePathNode(duplicate));
    }
    if path.last().is_none_or(|node| node != &event.target) {
        return Err(EventError::PathTargetMismatch);
    }

    let make_dispatch = |current_target: &str, phase: EventPhase| EventDispatch {
        event_type: event.event_type.clone(),
        target: event.target.clone(),
        current_target: current_target.to_owned(),
        phase,
        dataset: event.dataset.clone(),
        mark: event.mark.clone(),
        detail: event.detail.clone(),
        id: event.id.clone(),
    };
    let mut dispatches = Vec::with_capacity(path.len() * 2 + 1);
    if event.capture {
        dispatches.extend(
            path.iter()
                .take(path.len().saturating_sub(1))
                .map(|node| make_dispatch(node, EventPhase::Capture)),
        );
    }
    dispatches.push(make_dispatch(&event.target, EventPhase::Target));
    if event.bubbles {
        dispatches.extend(
            path.iter()
                .rev()
                .skip(1)
                .map(|node| make_dispatch(node, EventPhase::Bubble)),
        );
    }
    Ok(dispatches)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DataPathToken {
    Key(String),
    Index(usize),
}

/// Portable sandbox resource bound, shared by Rust and both JS adapters.
/// This is a container limit, not a claim about official DevTools limits.
pub const MAX_DATA_ARRAY_LENGTH: usize = 1_048_576;

fn parse_path(path: &str) -> Option<Vec<DataPathToken>> {
    if path.is_empty() {
        return Some(vec![]);
    }
    let mut out = Vec::new();
    let mut rest = path;
    while !rest.is_empty() {
        if let Some(index_path) = rest.strip_prefix('[') {
            let end = index_path.find(']')?;
            let index = &index_path[..end];
            if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let index = index.parse().ok()?;
            if index >= MAX_DATA_ARRAY_LENGTH {
                return None;
            }
            out.push(DataPathToken::Index(index));
            rest = &index_path[end + 1..];
        } else {
            let end = rest.find(['.', '[', ']']).unwrap_or(rest.len());
            if end == 0 {
                return None;
            }
            out.push(DataPathToken::Key(rest[..end].to_owned()));
            rest = &rest[end..];
        }
        if let Some(after_dot) = rest.strip_prefix('.') {
            if after_dot.is_empty() || after_dot.starts_with(['.', '[', ']']) {
                return None;
            }
            rest = after_dot;
        } else if !rest.is_empty() && !rest.starts_with('[') {
            return None;
        }
    }
    Some(out)
}

fn apply_patch(root: &mut Value, patch: &DataPatch) -> bool {
    let Some(tokens) = parse_path(&patch.path) else {
        return false;
    };
    match patch.op {
        DataPatchOp::Set => set_value(root, &tokens, patch.value.clone().unwrap_or(Value::Null)),
        DataPatchOp::Delete => delete_value(root, &tokens),
    }
}

fn set_value(current: &mut Value, tokens: &[DataPathToken], value: Value) -> bool {
    if tokens.is_empty() {
        if *current == value {
            false
        } else {
            *current = value;
            true
        }
    } else {
        match &tokens[0] {
            DataPathToken::Key(key) => {
                if !current.is_object() {
                    *current = default_object();
                }
                let object = current.as_object_mut().expect("object set above");
                set_value(
                    object.entry(key.clone()).or_insert(Value::Null),
                    &tokens[1..],
                    value,
                )
            }
            DataPathToken::Index(index) => {
                if !current.is_array() {
                    *current = Value::Array(Vec::new());
                }
                let array = current.as_array_mut().expect("array set above");
                if array.len() <= *index {
                    array.resize(*index + 1, Value::Null);
                }
                set_value(&mut array[*index], &tokens[1..], value)
            }
        }
    }
}

fn delete_value(current: &mut Value, tokens: &[DataPathToken]) -> bool {
    if tokens.is_empty() {
        if current.is_null() {
            false
        } else {
            *current = Value::Null;
            true
        }
    } else {
        match (&tokens[0], current) {
            (DataPathToken::Key(key), Value::Object(object)) if tokens.len() == 1 => {
                object.remove(key).is_some()
            }
            (DataPathToken::Key(key), Value::Object(object)) => object
                .get_mut(key)
                .map(|v| delete_value(v, &tokens[1..]))
                .unwrap_or(false),
            (DataPathToken::Index(index), Value::Array(array)) if tokens.len() == 1 => {
                if let Some(value) = array.get_mut(*index) {
                    if !value.is_null() {
                        *value = Value::Null;
                        true
                    } else {
                        false
                    }
                } else {
                    false
                }
            }
            (DataPathToken::Index(index), Value::Array(array)) => array
                .get_mut(*index)
                .map(|v| delete_value(v, &tokens[1..]))
                .unwrap_or(false),
            _ => false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeEvent {
    Lifecycle {
        event: LifecycleEvent,
        state: LifecycleState,
        sequence: u64,
    },
    Page(PageStackEvent),
    DataPatched {
        page_id: PageId,
        changed: usize,
    },
    StorageChanged {
        operation: StorageOperation,
        key: Option<String>,
    },
    TimerScheduled {
        id: TimerId,
        kind: TimerKind,
        delay_ms: u64,
    },
    TimerCancelled {
        id: TimerId,
    },
    TimersFired {
        timers: Vec<TimerFired>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StorageOperation {
    Set,
    Remove,
    Clear,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeError {
    Lifecycle(LifecycleError),
    Page(PageStackError),
    NoCurrentPage,
    Storage(StorageError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Lifecycle(e) => e.fmt(f),
            Self::Page(e) => e.fmt(f),
            Self::NoCurrentPage => f.write_str("no current page"),
            Self::Storage(e) => e.fmt(f),
        }
    }
}
impl std::error::Error for RuntimeError {}
impl From<LifecycleError> for RuntimeError {
    fn from(value: LifecycleError) -> Self {
        Self::Lifecycle(value)
    }
}
impl From<PageStackError> for RuntimeError {
    fn from(value: PageStackError) -> Self {
        Self::Page(value)
    }
}
impl From<StorageError> for RuntimeError {
    fn from(value: StorageError) -> Self {
        Self::Storage(value)
    }
}

#[derive(Clone, Debug, Default)]
pub struct ContainerRuntime {
    lifecycle: LifecycleController,
    pages: PageStack,
    events: Vec<RuntimeEvent>,
    storage: MemoryStorage,
    timers: TimerScheduler,
}

impl ContainerRuntime {
    pub fn lifecycle(&self) -> &LifecycleController {
        &self.lifecycle
    }
    pub fn pages(&self) -> &PageStack {
        &self.pages
    }
    pub fn pages_mut(&mut self) -> &mut PageStack {
        &mut self.pages
    }
    pub fn drain_events(&mut self) -> Vec<RuntimeEvent> {
        std::mem::take(&mut self.events)
    }

    pub fn storage(&self) -> &MemoryStorage {
        &self.storage
    }

    pub fn storage_mut(&mut self) -> &mut MemoryStorage {
        &mut self.storage
    }

    /// Commit storage and publish its ordered events only after every
    /// operation passes validation. Legacy wrappers retain their event shapes.
    pub fn apply_storage_transaction(
        &mut self,
        operations: Vec<StorageMutation>,
    ) -> Result<StorageCommit, RuntimeError> {
        let commit = self.storage.apply_transaction(operations)?;
        self.events
            .extend(commit.receipts.iter().map(|receipt| match receipt {
                StorageReceipt::Set { key, .. } => RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Set,
                    key: Some(key.clone()),
                },
                StorageReceipt::Remove { key, .. } => RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Remove,
                    key: Some(key.clone()),
                },
                StorageReceipt::Clear { .. } => RuntimeEvent::StorageChanged {
                    operation: StorageOperation::Clear,
                    key: None,
                },
            }));
        Ok(commit)
    }

    pub fn timers(&self) -> &TimerScheduler {
        &self.timers
    }

    pub fn timers_mut(&mut self) -> &mut TimerScheduler {
        &mut self.timers
    }

    pub fn set_storage(
        &mut self,
        key: impl Into<String>,
        value: Value,
    ) -> Result<Option<Value>, RuntimeError> {
        let key = key.into();
        let previous = self.storage.set(key.clone(), value)?;
        self.events.push(RuntimeEvent::StorageChanged {
            operation: StorageOperation::Set,
            key: Some(key),
        });
        Ok(previous)
    }

    pub fn set_storage_undefined(&mut self, key: impl Into<String>) -> Result<(), RuntimeError> {
        let key = key.into();
        self.storage.set_undefined(key.clone())?;
        self.events.push(RuntimeEvent::StorageChanged {
            operation: StorageOperation::Set,
            key: Some(key),
        });
        Ok(())
    }

    pub fn remove_storage(&mut self, key: &str) -> Option<Value> {
        let value = self.storage.remove(key);
        self.events.push(RuntimeEvent::StorageChanged {
            operation: StorageOperation::Remove,
            key: Some(key.to_string()),
        });
        value
    }

    pub fn clear_storage(&mut self) -> usize {
        let count = self.storage.clear();
        self.events.push(RuntimeEvent::StorageChanged {
            operation: StorageOperation::Clear,
            key: None,
        });
        count
    }

    pub fn schedule_timer(
        &mut self,
        kind: TimerKind,
        delay_ms: u64,
        now_ns: u64,
        callback_id: Option<String>,
    ) -> TimerId {
        let id = self.timers.schedule(kind, delay_ms, now_ns, callback_id);
        self.events
            .push(RuntimeEvent::TimerScheduled { id, kind, delay_ms });
        id
    }

    pub fn cancel_timer(&mut self, id: TimerId) -> bool {
        let cancelled = self.timers.cancel(id);
        if cancelled {
            self.events.push(RuntimeEvent::TimerCancelled { id });
        }
        cancelled
    }

    pub fn poll_timers(&mut self, now_ns: u64) -> Vec<TimerFired> {
        let timers = self.timers.poll(now_ns);
        if !timers.is_empty() {
            self.events.push(RuntimeEvent::TimersFired {
                timers: timers.clone(),
            });
        }
        timers
    }

    pub fn dispatch_lifecycle(
        &mut self,
        event: LifecycleEvent,
    ) -> Result<LifecycleState, RuntimeError> {
        let state = self.lifecycle.dispatch(event)?;
        self.events.push(RuntimeEvent::Lifecycle {
            event,
            state,
            sequence: self.lifecycle.sequence(),
        });
        Ok(state)
    }

    pub fn push_page(&mut self, path: impl Into<String>) -> Result<PageId, RuntimeError> {
        let (id, event) = self.pages.push(path)?;
        self.events.push(RuntimeEvent::Page(event));
        Ok(id)
    }

    pub fn pop_page(&mut self) -> Result<PageEntry, RuntimeError> {
        let (page, event) = self.pages.pop()?;
        self.events.push(RuntimeEvent::Page(event));
        Ok(page)
    }

    pub fn replace_page(&mut self, path: impl Into<String>) -> Result<PageId, RuntimeError> {
        let (id, event) = self.pages.replace(path)?;
        self.events.push(RuntimeEvent::Page(event));
        Ok(id)
    }

    pub fn set_navigation_bar_title(
        &mut self,
        page_id: PageId,
        title: impl Into<String>,
    ) -> Result<(), RuntimeError> {
        self.pages.set_navigation_bar_title(page_id, title)?;
        Ok(())
    }

    pub fn apply_data_patch_batch(
        &mut self,
        batch: &DataPatchBatch,
    ) -> Result<usize, RuntimeError> {
        let changed = self.pages.apply_data_batch(batch.page_id, batch)?;
        self.events.push(RuntimeEvent::DataPatched {
            page_id: batch.page_id,
            changed,
        });
        Ok(changed)
    }

    pub fn set_data(&mut self, patches: Vec<DataPatch>) -> Result<usize, RuntimeError> {
        let page_id = self.pages.current().ok_or(RuntimeError::NoCurrentPage)?.id;
        self.apply_data_patch_batch(&DataPatchBatch { page_id, patches })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn lifecycle_is_ordered_and_destroy_is_terminal() {
        let mut lifecycle = LifecycleController::default();
        assert_eq!(
            lifecycle.dispatch(LifecycleEvent::Launch).unwrap(),
            LifecycleState::Active
        );
        assert_eq!(
            lifecycle.dispatch(LifecycleEvent::Hide).unwrap(),
            LifecycleState::Background
        );
        assert_eq!(
            lifecycle.dispatch(LifecycleEvent::Show).unwrap(),
            LifecycleState::Active
        );
        assert_eq!(
            lifecycle.dispatch(LifecycleEvent::Unload).unwrap(),
            LifecycleState::Destroyed
        );
        assert!(matches!(
            lifecycle.dispatch(LifecycleEvent::Show),
            Err(LifecycleError::AlreadyDestroyed)
        ));
    }

    #[test]
    fn page_stack_and_batch_set_data_are_atomic_per_patch() {
        let mut runtime = ContainerRuntime::default();
        let id = runtime.push_page("pages/index/index").unwrap();
        let changed = runtime
            .set_data(vec![
                DataPatch::set("user.name", json!("Ada")),
                DataPatch::set("items[0].title", json!("first")),
                DataPatch::set("items[1].title", json!("second")),
            ])
            .unwrap();
        assert_eq!(changed, 3);
        let page = runtime.pages().get(id).unwrap();
        assert_eq!(page.data["user"]["name"], "Ada");
        assert_eq!(page.data["items"][1]["title"], "second");
        assert_eq!(
            runtime
                .set_data(vec![DataPatch::delete("user.name")])
                .unwrap(),
            1
        );
        assert!(runtime.pages().get(id).unwrap().data["user"]
            .get("name")
            .is_none());
    }

    #[test]
    fn data_paths_preserve_array_tokens_and_reject_ambiguous_syntax() {
        assert_eq!(
            serde_json::to_value(
                DataPatch::set("items[1][2].title", json!(true))
                    .path_tokens()
                    .unwrap()
            )
            .unwrap(),
            json!(["items", 1, 2, "title"]),
        );
        assert_eq!(DataPatch::delete("").path_tokens(), Some(Vec::new()));
        assert!(
            DataPatch::set(format!("items[{}]", MAX_DATA_ARRAY_LENGTH - 1), json!(true))
                .path_tokens()
                .is_some()
        );
        assert!(
            DataPatch::set(format!("items[{MAX_DATA_ARRAY_LENGTH}]"), json!(true))
                .path_tokens()
                .is_none()
        );
        for path in [
            "items[1",
            "items[]",
            "items[-1]",
            "items[1]title",
            "items.[1]",
            "items..title",
            "items.",
            ".items",
            "items]title",
        ] {
            assert!(
                DataPatch::set(path, json!(true)).path_tokens().is_none(),
                "{path}"
            );
        }
    }

    #[test]
    fn navigation_bar_title_belongs_to_page_instance() {
        let mut runtime = ContainerRuntime::default();
        let first = runtime.push_page("pages/index/index").unwrap();
        runtime
            .pages_mut()
            .set_navigation_bar_title(first, "Home")
            .unwrap();
        let second = runtime.push_page("pages/detail/index").unwrap();
        runtime
            .pages_mut()
            .set_navigation_bar_title(second, "Detail")
            .unwrap();

        assert_eq!(
            runtime.pages().get(first).unwrap().navigation_bar_title,
            "Home"
        );
        assert_eq!(
            runtime.pages().current().unwrap().navigation_bar_title,
            "Detail"
        );

        let popped = runtime.pop_page().unwrap();
        assert_eq!(popped.navigation_bar_title, "Detail");
        assert_eq!(
            runtime.pages().current().unwrap().navigation_bar_title,
            "Home"
        );
    }

    #[test]
    fn navigation_emits_batch_friendly_events() {
        let mut runtime = ContainerRuntime::default();
        runtime.dispatch_lifecycle(LifecycleEvent::Launch).unwrap();
        runtime.push_page("index").unwrap();
        runtime
            .set_data(vec![DataPatch::set("ready", json!(true))])
            .unwrap();
        let events = runtime.drain_events();
        assert!(matches!(events[0], RuntimeEvent::Lifecycle { .. }));
        assert!(matches!(
            events[1],
            RuntimeEvent::Page(PageStackEvent::Pushed(_))
        ));
        assert!(matches!(
            events[2],
            RuntimeEvent::DataPatched { changed: 1, .. }
        ));
    }

    #[test]
    fn memory_storage_round_trips_values_and_rejects_empty_keys() {
        let mut storage = MemoryStorage::default();
        assert_eq!(storage.set("answer", json!(42)).unwrap(), None);
        assert_eq!(storage.get("answer"), Some(&json!(42)));
        assert_eq!(storage.set("answer", json!(43)).unwrap(), Some(json!(42)));
        assert_eq!(storage.remove("answer"), Some(json!(43)));
        assert!(!storage.contains_key("answer"));
        assert_eq!(storage.set(" ", json!(1)), Err(StorageError::EmptyKey));
    }

    #[test]
    fn undefined_storage_round_trips_losslessly_and_remains_distinct_from_null() {
        let mut storage = MemoryStorage::default();
        storage.set_undefined("undefined").unwrap();
        storage.set("null", Value::Null).unwrap();
        assert_eq!(storage.len(), 2);
        assert!(storage.contains_key("undefined"));
        assert!(storage.is_undefined("undefined"));
        assert!(!storage.is_undefined("null"));
        let snapshot = serde_json::to_vec(&storage.snapshot_state()).unwrap();
        let mut restored = MemoryStorage::default();
        restored
            .restore_state(serde_json::from_slice(&snapshot).unwrap())
            .unwrap();
        assert_eq!(restored, storage);
        restored.set("undefined", json!(7)).unwrap();
        assert!(!restored.is_undefined("undefined"));
        restored.set_undefined("undefined").unwrap();
        restored.remove("undefined");
        assert!(!restored.is_undefined("undefined"));
        restored.set_undefined("other").unwrap();
        restored.restore(storage.snapshot()).unwrap();
        assert!(!restored.is_undefined("other"));
        restored.set_undefined("other").unwrap();
        restored.clear();
        assert!(restored.snapshot_state().undefined_keys.is_empty());
    }

    #[test]
    fn timer_scheduler_preserves_cancellation_and_interval_progress() {
        let mut scheduler = TimerScheduler::default();
        let timeout = scheduler.schedule_timeout(10, 1_000_000_000, Some("timeout".into()));
        let interval = scheduler.schedule_interval(5, 1_000_000_000, Some("interval".into()));
        assert!(scheduler.cancel(timeout));
        assert!(!scheduler.is_pending(timeout));
        let fired = scheduler.poll(1_005_000_000);
        assert_eq!(fired.len(), 1);
        assert_eq!(fired[0].id, interval);
        assert!(scheduler.is_pending(interval));
        assert!(scheduler.poll(1_009_999_999).is_empty());
        assert_eq!(scheduler.poll(1_010_000_000)[0].id, interval);
    }

    #[test]
    fn event_dispatch_orders_capture_target_and_bubble_with_dataset() {
        let event = EventInput {
            event_type: "tap".into(),
            target: "button".into(),
            path: vec!["page".into(), "panel".into(), "button".into()],
            dataset: Map::from_iter([(String::from("id"), Value::from(7))]),
            mark: Map::from_iter([(String::from("source"), Value::from("fixture"))]),
            detail: serde_json::json!({"x": 12}),
            capture: true,
            bubbles: true,
            id: Some("event-1".into()),
        };
        let dispatches = dispatch_event(&event).unwrap();
        assert_eq!(
            dispatches
                .iter()
                .map(|dispatch| (dispatch.current_target.as_str(), dispatch.phase))
                .collect::<Vec<_>>(),
            vec![
                ("page", EventPhase::Capture),
                ("panel", EventPhase::Capture),
                ("button", EventPhase::Target),
                ("panel", EventPhase::Bubble),
                ("page", EventPhase::Bubble),
            ]
        );
        assert_eq!(dispatches[2].dataset["id"], 7);
        assert_eq!(dispatches[2].mark["source"], "fixture");
        assert_eq!(dispatches[2].detail["x"], 12);
    }

    #[test]
    fn event_dispatch_rejects_invalid_path_and_supports_target_only_events() {
        let mut event = EventInput {
            event_type: "tap".into(),
            target: "button".into(),
            path: vec!["page".into(), "other".into()],
            ..EventInput::default()
        };
        assert_eq!(dispatch_event(&event), Err(EventError::PathTargetMismatch));
        event.path.clear();
        event.capture = true;
        event.bubbles = false;
        let dispatches = dispatch_event(&event).unwrap();
        assert_eq!(dispatches.len(), 1);
        assert_eq!(dispatches[0].phase, EventPhase::Target);
    }
}
