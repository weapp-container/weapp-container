//! Nonblocking host calls. This module owns correlation and terminal state; hosts own I/O.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

const MAX_PENDING: usize = 256;
const MAX_OUTBOX: usize = 1024;
const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_RESULT_BYTES: usize = 64 * 1024 * 1024;
const MAX_OUTBOX_BYTES: usize = 64 * 1024 * 1024;
/// Package API resources share a 16 MiB wire message with bounded metadata.
/// This ceiling belongs to packagedApiResources 1.0, not historical media APIs.
pub const HOST_API_RESOURCE_MAX_BYTES: usize = 16 * 1024 * 1024 - 64 * 1024;
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum HostRequest {
    Call {
        call_id: String,
        method: String,
        payload: Value,
        #[serde(default, with = "host_wire_u64::option")]
        deadline_ns: Option<u64>,
        cancel_token: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<Box<HostApiCallContext>>,
    },
    Message {
        payload: Value,
    },
    Cancel {
        call_id: String,
    },
}

#[derive(Debug)]
pub(super) enum CallTargetKind {
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    Engine {
        id: u64,
        name: String,
    },
    Bridge {
        request_id: String,
        name: String,
    },
    PhoneButton {
        target: host_services::NativeComponentTarget,
    },
}

#[derive(Debug)]
struct PendingCall {
    target: CallTargetKind,
    deadline_ns: Option<u64>,
    cancel_token: Option<String>,
    host_context: Option<HostApiCallContext>,
    resource_source: Option<String>,
}

#[derive(Debug)]
pub(super) struct HostCalls {
    generation: u64,
    sequence: u64,
    methods: BTreeSet<String>,
    pending: BTreeMap<String, PendingCall>,
    outbox: VecDeque<HostRequest>,
    completion_events: Vec<BridgeEnvelope>,
    outbox_bytes: usize,
    queued_call_bytes: BTreeMap<String, usize>,
    closed: bool,
}

impl Default for HostCalls {
    fn default() -> Self {
        Self {
            generation: NEXT_GENERATION.fetch_add(1, Ordering::Relaxed),
            sequence: 0,
            methods: BTreeSet::new(),
            pending: BTreeMap::new(),
            outbox: VecDeque::new(),
            completion_events: Vec::new(),
            outbox_bytes: 0,
            queued_call_bytes: BTreeMap::new(),
            closed: false,
        }
    }
}

impl HostCalls {
    pub(super) fn is_closed(&self) -> bool {
        self.closed
    }
}

fn validate_payload(value: &Value, limit: usize) -> Result<usize, BridgeError> {
    let bytes = serde_json::to_vec(value).map_err(|e| BridgeError::invalid(e.to_string()))?;
    if bytes.len() > limit {
        return Err(BridgeError::invalid("host payload exceeds byte limit"));
    }
    Ok(bytes.len())
}

pub(super) fn host_error_payload(name: &str, error: &BridgeError, raw: Option<&Value>) -> Value {
    let mut fields = raw.and_then(Value::as_object).cloned().unwrap_or_default();
    fields.insert("code".into(), json!(error.code));
    fields.insert("message".into(), json!(error.message));
    fields.insert("api".into(), json!(name));
    fields.insert("retryable".into(), json!(error.retryable));
    fields
        .entry("errMsg")
        .or_insert_with(|| json!(format!("{name}:fail {}", error.message)));
    Value::Object(fields)
}

impl Session {
    /// Register the exact business methods before executing any pack code.
    pub fn set_host_methods(&mut self, methods: Vec<String>) -> Result<(), BridgeError> {
        if self.initialized || self.host_calls.closed {
            return Err(BridgeError::invalid(
                "host methods must be registered before app.init",
            ));
        }
        if methods.len() > MAX_PENDING
            || methods
                .iter()
                .any(|name| name.trim().is_empty() || name.len() > 128 || name.starts_with("wx."))
        {
            return Err(BridgeError::invalid("invalid host method registry"));
        }
        self.host_calls.methods = methods.into_iter().collect();
        Ok(())
    }

    pub fn storage_snapshot(&self) -> container_core::StorageSnapshot {
        self.app_service.storage().snapshot_state()
    }

    pub fn storage_revision(&self) -> u64 {
        self.app_service.storage().revision()
    }

    /// Instance identity changes on every committed mutation or restore,
    /// including replacement stores whose numeric revision happens to match.
    pub fn storage_stamp(&self) -> container_core::StorageStamp {
        self.app_service.storage().stamp()
    }

    pub fn restore_storage(
        &mut self,
        snapshot: container_core::StorageSnapshot,
    ) -> Result<(), BridgeError> {
        if self.initialized {
            return Err(BridgeError::invalid(
                "storage must be restored before app.init",
            ));
        }
        self.app_service
            .storage_mut()
            .restore_state(snapshot)
            .map_err(|e| BridgeError::invalid(e.to_string()))?;
        self.engine_storage_stamp = None;
        Ok(())
    }

    /// Drain only after a runtime turn returns. A candidate session's outbox must
    /// remain unpublished until the host commits that candidate.
    pub fn take_host_requests(&mut self) -> Vec<HostRequest> {
        self.host_calls.outbox_bytes = 0;
        self.host_calls.queued_call_bytes.clear();
        self.host_calls.outbox.drain(..).collect()
    }

    pub fn pending_host_call_count(&self) -> usize {
        self.host_calls.pending.len()
    }

    /// Only the exact in-flight src setter may read its declared package asset.
    /// Neither the host transport nor guest options can select a different path
    /// or use a content hash as authority. Local API paths start at pack root.
    pub fn host_api_resource(&self, context: &HostApiCallContext) -> Result<&[u8], BridgeError> {
        let stale = || {
            BridgeError::new(
                BridgeErrorCode::Cancelled,
                "package resource call is retired",
            )
        };
        let pending = self
            .host_calls
            .pending
            .get(&context.call_id)
            .ok_or_else(stale)?;
        let config = self.host_services.config.as_ref().ok_or_else(stale)?;
        if self.host_calls.closed
            || pending.host_context.as_ref() != Some(context)
            || context.session_id != self.config.session_id
            || context.application != config.application
            || context.account != config.account
        {
            return Err(stale());
        }
        if pending
            .deadline_ns
            .is_some_and(|deadline| deadline <= unix_now_ns())
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "package resource call expired",
            ));
        }
        let source = pending
            .resource_source
            .as_deref()
            .ok_or_else(|| BridgeError::invalid("call has no package resource source"))?;
        let path = super::images::resolve_path("app.js", source)?;
        let asset = self
            .manifest
            .assets
            .iter()
            .find(|asset| asset.path == path)
            .ok_or_else(|| BridgeError::invalid("API source is not a declared package asset"))?;
        let bytes = lookup_render_blob(&self.render_blobs, &format!("sha256:{}", asset.sha256))?;
        if bytes.len() > HOST_API_RESOURCE_MAX_BYTES {
            return Err(BridgeError::invalid(
                "packaged API resource exceeds the 16 MiB minus 64 KiB wire budget",
            ));
        }
        if u64::try_from(bytes.len()).ok() != Some(asset.size)
            || container_ir::hex_digest(bytes) != asset.sha256
        {
            return Err(BridgeError::invalid("API source size or SHA-256 mismatch"));
        }
        Ok(bytes)
    }

    pub fn next_host_deadline_ns(&self) -> Option<u64> {
        self.host_calls
            .pending
            .values()
            .filter_map(|call| call.deadline_ns)
            .min()
    }

    pub(super) fn provider_context(
        &self,
        options: &Map<String, Value>,
        default_timeout_ms: u64,
    ) -> Result<ProviderContext, BridgeError> {
        let now_ns = unix_now_ns();
        let timeout_ms = match options.get("timeout") {
            Some(value) => value.as_u64().filter(|n| *n > 0).ok_or_else(|| {
                BridgeError::invalid("timeout must be positive integer milliseconds")
            })?,
            None => default_timeout_ms,
        };
        let calculated = timeout_ms
            .checked_mul(1_000_000)
            .and_then(|n| now_ns.checked_add(n))
            .ok_or_else(|| BridgeError::invalid("timeout overflows timestamp"))?;
        let deadline_ns = match options
            .get("deadlineNs")
            .or_else(|| options.get("deadline_ns"))
        {
            Some(value) => Some(
                value
                    .as_u64()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| BridgeError::invalid("deadlineNs must be a positive timestamp"))?
                    .min(calculated),
            ),
            None => Some(calculated),
        };
        let cancel_token = match options
            .get("cancelToken")
            .or_else(|| options.get("cancel_token"))
        {
            Some(value) => Some(
                value
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| BridgeError::invalid("cancelToken must be a nonempty string"))?
                    .to_owned(),
            ),
            None => None,
        };
        Ok(ProviderContext {
            session_id: self.config.session_id.clone(),
            host: self.config.host.clone(),
            now_ns,
            deadline_ns,
            cancelled: cancel_token
                .as_deref()
                .is_some_and(|token| self.is_cancelled(token)),
            cancel_token,
        })
    }

    pub(super) fn queue_host_call(
        &mut self,
        method: &str,
        payload: Value,
        context: ProviderContext,
        target: CallTargetKind,
    ) -> Result<String, BridgeError> {
        if self.host_calls.closed {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "host session is closing",
            ));
        }
        if context.cancelled {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "host call cancelled",
            ));
        }
        if context
            .deadline_ns
            .is_some_and(|deadline| deadline <= context.now_ns)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "host call deadline exceeded",
            ));
        }
        let byte_count = validate_payload(
            &payload,
            if method == "wx.request" {
                MAX_RESULT_BYTES
            } else if self.host_service_registered(method) {
                8 * MAX_MESSAGE_BYTES
            } else {
                MAX_MESSAGE_BYTES
            },
        )?;
        if self.host_calls.outbox_bytes + byte_count > MAX_OUTBOX_BYTES {
            return Err(BridgeError::invalid("host outbox byte budget exceeded"));
        }
        if self.host_calls.pending.len() >= MAX_PENDING
            || self.host_calls.outbox.len() >= MAX_OUTBOX - MAX_PENDING
        {
            return Err(BridgeError::invalid("host request queue is full"));
        }
        self.host_calls.sequence += 1;
        let call_id = format!(
            "{}:{}:{}",
            self.config.session_id, self.host_calls.generation, self.host_calls.sequence
        );
        let host_context = self.host_api_context(&call_id, method, &context, &payload)?;
        let resource_source = (method == "object:InnerAudioContext.src"
            && payload.get("action").and_then(Value::as_str) == Some("set"))
        .then(|| payload.get("value").and_then(Value::as_str))
        .flatten()
        .filter(|source| !source.is_empty() && source.len() <= 4096)
        .map(str::to_owned);
        self.host_calls.pending.insert(
            call_id.clone(),
            PendingCall {
                target,
                deadline_ns: context.deadline_ns,
                cancel_token: context.cancel_token.clone(),
                host_context: host_context.clone(),
                resource_source,
            },
        );
        self.host_calls.outbox_bytes += byte_count;
        self.host_calls
            .queued_call_bytes
            .insert(call_id.clone(), byte_count);
        self.record_native_resource_call(method, &payload, &call_id, host_context.as_ref());
        self.host_calls.outbox.push_back(HostRequest::Call {
            call_id: call_id.clone(),
            method: method.to_owned(),
            payload,
            deadline_ns: context.deadline_ns,
            cancel_token: context.cancel_token.clone(),
            context: host_context.map(Box::new),
        });
        Ok(call_id)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn queue_host_message(&mut self, payload: Value) -> Result<(), BridgeError> {
        let byte_count = validate_payload(&payload, MAX_MESSAGE_BYTES)?;
        if self.host_calls.outbox_bytes + byte_count > MAX_OUTBOX_BYTES {
            return Err(BridgeError::invalid("host outbox byte budget exceeded"));
        }
        if self.host_calls.closed || self.host_calls.outbox.len() >= MAX_OUTBOX - MAX_PENDING {
            return Err(BridgeError::invalid("host message queue is closed or full"));
        }
        self.host_calls.outbox_bytes += byte_count;
        self.host_calls
            .outbox
            .push_back(HostRequest::Message { payload });
        Ok(())
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn has_host_method(&self, method: &str) -> bool {
        self.host_calls.methods.contains(method)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn resolve_engine_api(
        &mut self,
        id: u64,
        name: &str,
        result: Result<Value, BridgeError>,
    ) -> Result<(), BridgeError> {
        if name == "wx.createSelectorQuery" && id >= private_selector::FIRST_PRIVATE_ID {
            self.resolve_private_selector_query(id, &result)?;
            return Ok(());
        }
        self.resolve_engine_api_with_details(id, name, result, None)
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn resolve_engine_api_with_details(
        &mut self,
        id: u64,
        name: &str,
        result: Result<Value, BridgeError>,
        details: Option<Value>,
    ) -> Result<(), BridgeError> {
        let (value, error) = match result {
            Ok(value) => (value, Value::Null),
            Err(error) => (
                Value::Null,
                host_error_payload(name, &error, details.as_ref()),
            ),
        };
        self.call_engine(
            CallTarget::Global {
                name: "__container_resolve_api".into(),
            },
            vec![json!(id), value, error],
        )?;
        Ok(())
    }

    fn finish_host_call(
        &mut self,
        call_id: &str,
        result: Result<Value, BridgeError>,
        cancel_transport: bool,
        raw_error: Option<Value>,
    ) -> Result<bool, BridgeError> {
        let Some(call) = self.host_calls.pending.remove(call_id) else {
            return Ok(false);
        };
        let native_cleanup = self.finish_native_resource_call(call_id, result.is_ok());
        // Revoke callback authority through the retained engine transport before
        // any mutable guest resolver runs. A failed transport retains its work
        // for the next reconciliation; native resource cleanup still continues.
        let mut cleanup_error = self
            .reconcile_finite_notification_object_retirements()
            .err();
        // Remove undelivered work before publishing a cancellation. No host work
        // should start merely because abort preceded the first outbox drain.
        let queued = self.host_calls.outbox.iter().any(
            |request| matches!(request, HostRequest::Call { call_id: id, .. } if id == call_id),
        );
        self.host_calls.outbox.retain(
            |request| !matches!(request, HostRequest::Call { call_id: id, .. } if id == call_id),
        );
        if let Some(bytes) = self.host_calls.queued_call_bytes.remove(call_id) {
            self.host_calls.outbox_bytes -= bytes;
        }
        if cancel_transport && !queued {
            self.host_calls.outbox.push_back(HostRequest::Cancel {
                call_id: call_id.to_owned(),
            });
        }
        for resource_call_id in native_cleanup {
            if resource_call_id != call_id
                && self.host_calls.pending.contains_key(&resource_call_id)
            {
                if let Err(error) = self.finish_host_call(
                    &resource_call_id,
                    Err(BridgeError::new(
                        BridgeErrorCode::Cancelled,
                        "native resource retired",
                    )),
                    true,
                    None,
                ) {
                    // Resource authority is already retired. Continue native
                    // cancellation and settle the disposing call even if one
                    // old guest resolver throws; otherwise later creator calls
                    // and the private object's completion hook are stranded.
                    cleanup_error.get_or_insert(error);
                }
                continue;
            }
            if resource_call_id != call_id || !queued && !cancel_transport {
                self.host_calls.outbox.push_back(HostRequest::Cancel {
                    call_id: resource_call_id,
                });
            }
        }
        let (name, original_request) = match &call.target {
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            CallTargetKind::Engine { name, .. } => (name.as_str(), None),
            CallTargetKind::Bridge { request_id, name } => {
                (name.as_str(), Some(request_id.as_str()))
            }
            CallTargetKind::PhoneButton { .. } => ("weappContainer.identity.authorizePhone", None),
        };
        // A host handler may finish after resize. The accepted owner geometry
        // at completion remains authoritative for asynchronous system info,
        // exactly as for the synchronous mirror. Keep explicit sandbox behavior.
        let result = if matches!(name, "wx.getSystemInfo" | "wx.getSystemInfoAsync")
            && self.provider.name() != "sandbox"
        {
            result.and_then(|value| {
                host_services::observed_host_result(
                    name,
                    value,
                    &self.config.host,
                    self.host_services
                        .config
                        .as_ref()
                        .map(|config| config.application.host_app_id.as_str()),
                )
                .map_err(provider_bridge_error)
            })
        } else {
            result
        };
        let payload = match &result {
            Ok(value) => {
                json!({"callId":call_id,"requestId":original_request,"name":name,"ok":true,"result":value})
            }
            Err(error) => {
                json!({"callId":call_id,"requestId":original_request,"name":name,"ok":false,"error":host_error_payload(name,error,raw_error.as_ref())})
            }
        };
        self.host_calls
            .completion_events
            .push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::API_RESULT,
                payload,
            ));
        match call.target {
            #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
            CallTargetKind::Engine { id, name } => {
                if !self.engine_execution_is_faulted() {
                    if let Err(error) =
                        self.resolve_engine_api_with_details(id, &name, result, raw_error)
                    {
                        cleanup_error.get_or_insert(error);
                    }
                }
            }
            CallTargetKind::PhoneButton { target } => {
                if let Err(error) = self.finish_phone_button(target, result, raw_error) {
                    cleanup_error.get_or_insert(error);
                }
            }
            _ => {}
        }
        if let Some(error) = cleanup_error {
            return Err(error);
        }
        Ok(true)
    }

    pub(super) fn append_host_completions(&mut self, messages: &mut Vec<BridgeEnvelope>) {
        messages.append(&mut self.host_calls.completion_events);
    }

    /// Must execute on the runtime owner thread; callbacks from arbitrary host
    /// threads should enqueue this operation, never call back into an active turn.
    /// Duplicate, stale-generation and unknown IDs are harmless empty batches.
    pub fn complete_host_call(
        &mut self,
        call_id: &str,
        result: Result<Value, ProviderError>,
    ) -> Result<BridgeBatch, BridgeError> {
        if !self.host_calls.pending.contains_key(call_id) {
            return Ok(BridgeBatch::new(vec![]));
        }
        self.with_engine_batch_turn(None, |session| {
            session.complete_host_call_within_turn(call_id, result)
        })
    }

    /// Rich native errors retain provider errCode/errMsg and extension fields.
    /// Container cancellation/deadline failures still take precedence.
    pub fn complete_host_api_call(
        &mut self,
        call_id: &str,
        mut result: Result<Value, HostApiFailure>,
    ) -> Result<BridgeBatch, BridgeError> {
        if !self.host_calls.pending.contains_key(call_id) {
            return Ok(BridgeBatch::new(vec![]));
        }
        if let Ok(value) = &result {
            if let Err(error) = self.validate_native_resource_result(call_id, value) {
                result = Err(error.into());
            }
        }
        if let Ok(value) = &mut result {
            self.materialize_host_binaries(value)?;
        }
        if let Ok(value) = &result {
            validate_payload(value, MAX_RESULT_BYTES)?;
        }
        if let Err(error) = &result {
            validate_payload(&json!(error.details), MAX_MESSAGE_BYTES)?;
        }
        self.with_engine_batch_turn(None, |session| {
            session.sync_engine_storage_if_available()?;
            let expired = session
                .host_calls
                .pending
                .get(call_id)
                .and_then(|call| call.deadline_ns)
                .is_some_and(|deadline| deadline <= unix_now_ns());
            let (result, details) = if expired {
                (
                    Err(BridgeError::new(
                        BridgeErrorCode::Timeout,
                        "host call deadline exceeded",
                    )),
                    None,
                )
            } else {
                match result {
                    Ok(value) => (Ok(value), None),
                    Err(error) => {
                        let provider = ProviderError {
                            code: error.code,
                            message: error.message,
                            retryable: error.retryable,
                        };
                        (
                            Err(provider_bridge_error(provider)),
                            Some(json!(error.details)),
                        )
                    }
                }
            };
            session.finish_host_call(call_id, result, expired, details)?;
            session.host_completion_batch()
        })
    }

    /// Terminal host ownership is native and independent of guest callbacks or
    /// turn admission. Queued logs are discarded; retired owners cannot revive.
    fn retire_owned_foundations(&self) {
        self.buffer_urls.retire();
        self.log_manager.retire();
        self.performance_lifetime.retire();
    }

    /// Identity revocation must not run old guest callbacks or lifecycle hooks.
    /// Return only cancellation work already published to the native host.
    pub fn revoke_host_services(&mut self) -> Vec<HostRequest> {
        self.retire_owned_foundations();
        let sync_retirement = self.revoke_sync_host_api();
        self.release_component_frames();
        self.host_calls.closed = true;
        self.clear_host_binaries();
        let queued: BTreeSet<_> = self
            .host_calls
            .outbox
            .iter()
            .filter_map(|request| {
                if let HostRequest::Call { call_id, .. } = request {
                    Some(call_id.clone())
                } else {
                    None
                }
            })
            .collect();
        let mut cancel: BTreeSet<_> = self
            .host_calls
            .pending
            .keys()
            .filter(|id| !queued.contains(*id))
            .cloned()
            .collect();
        cancel.extend(
            self.release_native_resource_calls()
                .into_iter()
                .filter(|id| !queued.contains(id)),
        );
        self.host_calls.pending.clear();
        self.host_calls.outbox.clear();
        self.host_calls.completion_events.clear();
        self.host_calls.queued_call_bytes.clear();
        self.host_calls.outbox_bytes = 0;
        if let Err(error) = self.reconcile_finite_notification_object_retirements() {
            self.record_host_error(error);
        }
        if let Err(error) = sync_retirement {
            self.record_host_error(error);
        }
        cancel
            .into_iter()
            .map(|call_id| HostRequest::Cancel { call_id })
            .collect()
    }

    pub(super) fn abandon_phone_buttons_for_page(&mut self, page: PageId) {
        self.release_component_frames();
        let ids = self
            .host_calls
            .pending
            .iter()
            .filter_map(|(id, call)| match &call.target {
                CallTargetKind::PhoneButton { target } if target.page_id == page.0 => {
                    Some(id.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(PendingCall {
                target: CallTargetKind::PhoneButton { target },
                ..
            }) = self.host_calls.pending.remove(&id)
            {
                self.host_services_forget_phone_button(target.page_id, &target.node_id);
            }
            let queued =
                self.host_calls.outbox.iter().any(
                    |request| matches!(request,HostRequest::Call {call_id,..} if call_id==&id),
                );
            self.host_calls.outbox.retain(
                |request| !matches!(request,HostRequest::Call {call_id,..} if call_id==&id),
            );
            if let Some(bytes) = self.host_calls.queued_call_bytes.remove(&id) {
                self.host_calls.outbox_bytes -= bytes;
            }
            if !queued {
                self.host_calls
                    .outbox
                    .push_back(HostRequest::Cancel { call_id: id });
            }
        }
    }

    fn complete_host_call_within_turn(
        &mut self,
        call_id: &str,
        result: Result<Value, ProviderError>,
    ) -> Result<BridgeBatch, BridgeError> {
        if !self.host_calls.pending.contains_key(call_id) {
            return Ok(BridgeBatch::new(vec![]));
        }
        if let Ok(value) = &result {
            validate_payload(value, MAX_RESULT_BYTES)?;
        }
        self.sync_engine_storage_if_available()?;
        let expired = self
            .host_calls
            .pending
            .get(call_id)
            .and_then(|call| call.deadline_ns)
            .is_some_and(|deadline| deadline <= unix_now_ns());
        let result = if expired {
            Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "host call deadline exceeded",
            ))
        } else {
            result.map_err(provider_bridge_error)
        };
        self.finish_host_call(call_id, result, expired, None)?;
        self.host_completion_batch()
    }

    fn sync_engine_storage_if_available(&mut self) -> Result<(), BridgeError> {
        if self.engine_provider_available() && !self.engine_execution_is_faulted() {
            self.sync_engine_storage()?;
        }
        Ok(())
    }

    fn host_completion_batch(&mut self) -> Result<BridgeBatch, BridgeError> {
        let mut messages = Vec::new();
        self.append_host_completions(&mut messages);
        if self.engine_provider_available() && !self.engine_execution_is_faulted() {
            self.append_engine_effects(&mut messages)?;
        }
        self.append_host_completions(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    fn record_host_error(&mut self, error: BridgeError) {
        let event = self.error_envelope(&error, String::new(), op::ERROR);
        self.host_calls.completion_events.push(event);
    }

    fn terminate_host_calls(&mut self, ids: Vec<String>, code: BridgeErrorCode, message: &str) {
        for id in ids {
            if let Err(error) =
                self.finish_host_call(&id, Err(BridgeError::new(code, message)), true, None)
            {
                // A broken user continuation must not retain other native tasks.
                self.record_host_error(error);
            }
        }
    }

    pub fn poll_host_timeouts(&mut self, now_ns: u64) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.poll_host_timeouts_within_turn(now_ns)
        })
    }

    fn poll_host_timeouts_within_turn(&mut self, now_ns: u64) -> Result<BridgeBatch, BridgeError> {
        let ids: Vec<_> = self
            .host_calls
            .pending
            .iter()
            .filter(|(_, call)| call.deadline_ns.is_some_and(|deadline| deadline <= now_ns))
            .map(|(id, _)| id.clone())
            .collect();
        self.sync_engine_storage_if_available()?;
        self.terminate_host_calls(ids, BridgeErrorCode::Timeout, "host call deadline exceeded");
        self.host_completion_batch()
    }

    pub(super) fn cancel_host_token(&mut self, token: &str) -> Result<bool, BridgeError> {
        let ids: Vec<_> = self
            .host_calls
            .pending
            .iter()
            .filter(|(_, call)| call.cancel_token.as_deref() == Some(token))
            .map(|(id, _)| id.clone())
            .collect();
        let known = !ids.is_empty();
        self.terminate_host_calls(ids, BridgeErrorCode::Cancelled, "host call cancelled");
        Ok(known)
    }

    pub(super) fn cancel_native_resource_call(&mut self, call_id: &str) -> Result<(), BridgeError> {
        if self.host_calls.pending.contains_key(call_id) {
            self.finish_host_call(
                call_id,
                Err(BridgeError::new(
                    BridgeErrorCode::Cancelled,
                    "native subscription removed",
                )),
                true,
                None,
            )?;
        } else {
            self.host_calls.outbox.push_back(HostRequest::Cancel {
                call_id: call_id.to_owned(),
            });
        }
        Ok(())
    }

    pub(super) fn abandon_native_resource_calls(&mut self, ids: BTreeSet<String>) {
        for id in ids {
            self.host_calls.pending.remove(&id);
            let queued =
                self.host_calls.outbox.iter().any(
                    |request| matches!(request,HostRequest::Call {call_id,..} if call_id==&id),
                );
            self.host_calls.outbox.retain(
                |request| !matches!(request,HostRequest::Call {call_id,..} if call_id==&id),
            );
            if let Some(bytes) = self.host_calls.queued_call_bytes.remove(&id) {
                self.host_calls.outbox_bytes -= bytes;
            }
            if !queued
                && !self
                    .host_calls
                    .outbox
                    .iter()
                    .any(|request| matches!(request,HostRequest::Cancel {call_id} if call_id==&id))
            {
                self.host_calls
                    .outbox
                    .push_back(HostRequest::Cancel { call_id: id });
            }
        }
    }

    /// Terminal shutdown. It rejects outstanding promises once, closes business
    /// subscriptions, and emits cancellation only for already-dispatched work.
    pub fn cancel_host_calls(&mut self) -> Result<BridgeBatch, BridgeError> {
        self.retire_owned_foundations();
        if self.engine_execution_is_faulted() {
            return self.cancel_host_calls_within_turn();
        }
        self.with_engine_batch_turn(None, Self::cancel_host_calls_within_turn)
    }

    fn cancel_host_calls_within_turn(&mut self) -> Result<BridgeBatch, BridgeError> {
        self.retire_owned_foundations();
        if let Err(error) = self.revoke_sync_host_api() {
            self.record_host_error(error);
        }
        self.host_calls.closed = true;
        let ids: Vec<_> = self.host_calls.pending.keys().cloned().collect();
        if let Err(error) = self.sync_engine_storage_if_available() {
            self.record_host_error(error);
        }
        self.terminate_host_calls(ids, BridgeErrorCode::Cancelled, "host session closed");
        for call_id in self.release_native_resource_calls() {
            if !self.host_calls.outbox.iter().any(|request| matches!(request, HostRequest::Cancel { call_id: existing } if existing == &call_id)) {
                self.host_calls.outbox.push_back(HostRequest::Cancel { call_id });
            }
        }
        self.clear_host_binaries();
        self.host_calls
            .outbox
            .retain(|request| matches!(request, HostRequest::Cancel { .. }));
        self.host_calls.outbox_bytes = 0;
        self.host_calls.queued_call_bytes.clear();
        if self.engine_provider_available() && !self.engine_execution_is_faulted() {
            if let Err(error) = self.call_engine(
                CallTarget::Global {
                    name: "__container_clear_host_listeners".into(),
                },
                vec![],
            ) {
                self.record_host_error(error);
            }
        }
        let mut messages = Vec::new();
        self.append_host_completions(&mut messages);
        if self.engine_provider_available() && !self.engine_execution_is_faulted() {
            if let Err(error) = self.append_engine_effects(&mut messages) {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
        }
        self.append_host_completions(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    pub(super) fn close_host_calls_in_turn(&mut self) -> Result<(), BridgeError> {
        let batch = self.cancel_host_calls()?;
        self.host_calls.completion_events.extend(batch.messages);
        Ok(())
    }

    pub fn send_host_message(&mut self, payload: Value) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.send_host_message_within_turn(payload)
        })
    }

    fn send_host_message_within_turn(
        &mut self,
        payload: Value,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_initialized()?;
        if self.host_calls.closed {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "host session closed",
            ));
        }
        validate_payload(&payload, MAX_MESSAGE_BYTES)?;
        self.sync_engine_storage_if_available()?;
        self.call_engine(
            CallTarget::Global {
                name: "__container_receive_host_message".into(),
            },
            vec![payload],
        )?;
        self.host_completion_batch()
    }
}
