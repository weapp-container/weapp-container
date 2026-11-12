//! Shared primary-preview lease authority for the local Web transport.
//! Renderer policy and DOM request authority are separate from this one owner
//! ledger. A lease proof does not by itself authorize a renderer or a frame.
use super::sse_preview::{BoundSseConnection, QueuedPreviewControl, RetirementCheckpoint};
use super::{Shared, WebSurfaceHandle};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

pub(super) const MAX_PREVIEWS: usize = 16;
pub(super) const MAX_PREVIEW_REQUESTS: usize = 32;
pub(super) const PREVIEW_LEASE: Duration = Duration::from_secs(15);

pub(super) fn decimal(value: &str) -> Result<u64, String> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err("ERR_PROTOCOL_VERSION: expected canonical decimal u64".into());
    }
    value
        .parse()
        .map_err(|_| "ERR_PROTOCOL_VERSION: u64 overflow".into())
}

pub(super) fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:".contains(&byte))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewFence {
    pub client_id: String,
    pub epoch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_revision: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreviewRequest {
    pub version: String,
    pub request_id: String,
    pub client_id: String,
    pub op: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<String>,
}

impl PreviewRequest {
    pub(super) fn validate(&self, internal: bool) -> Result<(), String> {
        if self.version != "1.0"
            || !identifier(&self.request_id)
            || !identifier(&self.client_id)
            || !(matches!(
                self.op.as_str(),
                "connect" | "claim" | "heartbeat" | "release"
            ) || (internal && matches!(self.op.as_str(), "expire" | "disconnect")))
        {
            return Err("ERR_PROTOCOL_VERSION: invalid preview request".into());
        }
        if let Some(epoch) = &self.epoch {
            decimal(epoch)?;
        }
        if self.op != "connect" && self.epoch.is_none() {
            return Err("ERR_PROTOCOL_VERSION: preview operation requires epoch".into());
        }
        Ok(())
    }
}

/// The fence is captured at HTTP admission and checked again by the runtime
/// owner immediately before every envelope. It is never sent into AppService.
pub struct QueuedBridgeRequest {
    pub body: Vec<u8>,
    pub preview: Option<PreviewFence>,
}

impl std::fmt::Debug for QueuedBridgeRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("QueuedBridgeRequest")
            .field("body_bytes", &self.body.len())
            .field("preview", &self.preview)
            .finish()
    }
}

impl QueuedBridgeRequest {
    pub(super) fn parse(body: &[u8]) -> Result<Self, String> {
        let value: Value = serde_json::from_slice(body).map_err(|error| error.to_string())?;
        let preview = value
            .get("preview")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| format!("ERR_PROTOCOL_VERSION: {error}"))?;
        Ok(Self {
            body: body.to_vec(),
            preview,
        })
    }
}

#[derive(Debug)]
pub(super) struct PreviewClient {
    pub(super) last_seen: Instant,
    pub(super) connection: Option<Arc<BoundSseConnection>>,
}

/// The only preview owner ledger. DOM generations and requests deliberately
/// do not live here, so another presenter can validate the same lease without
/// inventing a DOM request or creating another epoch namespace.
#[derive(Debug)]
pub(super) struct PreviewState {
    pub(super) epoch: u64,
    pub(super) owner: Option<String>,
    pub(super) clients: BTreeMap<String, PreviewClient>,
    // Bounded terminal receipts make late release idempotent without removing
    // a newer connection with the same public client identifier.
    pub(super) retired_leases: VecDeque<(String, u64)>,
    pub(super) requests: VecDeque<QueuedPreviewControl>,
    pub(super) sse_binding_enabled: bool,
    pub(super) next_connection_serial: Option<u64>,
    pub(super) reserved_retirements: usize,
    pub(super) resolving: bool,
    pub(super) retirement: Option<RetirementCheckpoint>,
}

impl Default for PreviewState {
    fn default() -> Self {
        Self {
            epoch: 0,
            owner: None,
            clients: BTreeMap::new(),
            retired_leases: VecDeque::new(),
            requests: VecDeque::new(),
            sse_binding_enabled: false,
            next_connection_serial: Some(1),
            reserved_retirements: 0,
            resolving: false,
            retirement: None,
        }
    }
}

/// A non-serializable lease proof captured from the actual Web surface. This
/// is only owner authority: callers still validate their session, frame and
/// renderer-specific generation before accepting an operation.
#[derive(Clone, Debug)]
pub struct PreviewOwnerFence {
    owner: Weak<Mutex<Shared>>,
    client_id: String,
    epoch: u64,
}

impl PreviewOwnerFence {
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// Revalidate from an already held publication guard; never acquire the
    /// Web mutex recursively or reconstruct the allocation proof from wire.
    pub(super) fn validate_locked(
        &self,
        owner: &Weak<Mutex<Shared>>,
        preview: &PreviewState,
    ) -> Result<(), String> {
        if !Weak::ptr_eq(&self.owner, owner) {
            return Err("ERR_CANCELLED: preview owner belongs to another Web surface".into());
        }
        preview.validate_owner(&self.client_id, self.epoch)
    }
}

impl PreviewState {
    pub(super) fn preview_value(&self) -> Value {
        json!({"version":"1.0","epoch":self.epoch.to_string(),
            "ownerClientId":self.owner,"leaseDurationMs":PREVIEW_LEASE.as_millis(),
            "expired":self.expired(Instant::now())})
    }
    pub(super) fn expired(&self, now: Instant) -> bool {
        self.owner.as_ref().is_some_and(|owner| {
            self.clients.get(owner).is_none_or(|client| {
                now.saturating_duration_since(client.last_seen) >= PREVIEW_LEASE
            })
        })
    }
    pub(super) fn validate_fence(&self, fence: Option<&PreviewFence>) -> Result<(), String> {
        let fence = fence.ok_or("ERR_PERMISSION_DENIED: primary preview fence required")?;
        if !identifier(&fence.client_id)
            || decimal(&fence.epoch)? != self.epoch
            || self.owner.as_ref() != Some(&fence.client_id)
            || self.expired(Instant::now())
            || !self.owner_connection_is_live(&fence.client_id)
        {
            return Err("ERR_CANCELLED: preview does not own the current lease".into());
        }
        Ok(())
    }

    pub(super) fn validate_owner(&self, client_id: &str, epoch: u64) -> Result<(), String> {
        if !identifier(client_id)
            || epoch != self.epoch
            || self.owner.as_deref() != Some(client_id)
            || self.expired(Instant::now())
            || !self.owner_connection_is_live(client_id)
        {
            return Err("ERR_CANCELLED: preview does not own the current lease".into());
        }
        Ok(())
    }
    fn owner_connection_is_live(&self, client_id: &str) -> bool {
        !self.sse_binding_enabled
            || (!self
                .retirement
                .is_some_and(|checkpoint| checkpoint.epoch == self.epoch)
                && self.clients.get(client_id).is_some_and(|client| {
                    client
                        .connection
                        .as_ref()
                        .is_some_and(|connection| connection.is_live())
                }))
    }
    pub(super) fn queue_preview(
        &mut self,
        request: PreviewRequest,
        enabled: bool,
        configured: bool,
    ) -> Result<(), String> {
        request.validate(false)?;
        if self.sse_binding_enabled {
            return Err("ERR_PERMISSION_DENIED: a bound preview connection is required".into());
        }
        if !enabled && !self.known_release(&request, configured) {
            return Err("ERR_UNSUPPORTED_CAPABILITY: DOM preview is not enabled".into());
        }
        if self.requests.len() + self.reserved_retirements >= MAX_PREVIEW_REQUESTS {
            return Err("ERR_RENDER: preview queue full".into());
        }
        self.requests
            .push_back(QueuedPreviewControl::Legacy(request));
        Ok(())
    }
    pub(super) fn retired_release(&self, request: &PreviewRequest) -> bool {
        request.op == "release"
            && request
                .epoch
                .as_deref()
                .and_then(|value| decimal(value).ok())
                .is_some_and(|epoch| {
                    self.retired_leases
                        .iter()
                        .any(|(client, retired)| client == &request.client_id && *retired == epoch)
                })
    }
    fn known_release(&self, request: &PreviewRequest, configured: bool) -> bool {
        configured
            && request.op == "release"
            && (self.retired_release(request)
                || (request
                    .epoch
                    .as_deref()
                    .and_then(|value| decimal(value).ok())
                    == Some(self.epoch)
                    && self.clients.contains_key(&request.client_id)))
    }
    pub(super) fn remember_retired_lease(&mut self, client_id: String, epoch: u64) {
        let entry = (client_id, epoch);
        if !self.retired_leases.contains(&entry) {
            self.retired_leases.push_back(entry);
        }
        while self.retired_leases.len() > MAX_PREVIEWS * 2 {
            self.retired_leases.pop_front();
        }
    }
    pub(super) fn next_owner(
        &self,
        request: &PreviewRequest,
        now: Instant,
        enabled: bool,
        configured: bool,
    ) -> Result<Option<String>, String> {
        request.validate(true)?;
        if self.retired_release(request) {
            return Ok(self.owner.clone());
        }
        if !enabled
            && !self.known_release(request, configured)
            && !(configured && request.op == "expire")
        {
            return Err("ERR_UNSUPPORTED_CAPABILITY: DOM preview is not enabled".into());
        }
        if request.op != "connect"
            && request.epoch.as_deref().map(decimal).transpose()? != Some(self.epoch)
        {
            return Err("ERR_CANCELLED: stale preview epoch".into());
        }
        if request.op == "expire" {
            if !self.expired(now) || self.owner.as_ref() != Some(&request.client_id) {
                return Err("ERR_CANCELLED: preview lease is no longer expired".into());
            }
            return Ok(None);
        }
        if request.op != "connect" && !self.clients.contains_key(&request.client_id) {
            return Err("ERR_PERMISSION_DENIED: preview must connect first".into());
        }
        if request.op == "connect"
            && !self.clients.contains_key(&request.client_id)
            && self.clients.len() >= MAX_PREVIEWS
        {
            return Err("ERR_RENDER: preview client budget exceeded".into());
        }
        if self.expired(now)
            && !matches!(
                request.op.as_str(),
                "connect" | "claim" | "release" | "disconnect"
            )
        {
            return Err("ERR_CANCELLED: preview lease expired".into());
        }
        Ok(match request.op.as_str() {
            "connect" if self.owner.is_none() || self.expired(now) => {
                Some(request.client_id.clone())
            }
            "claim" => Some(request.client_id.clone()),
            "release" | "disconnect" if self.owner.as_ref() == Some(&request.client_id) => None,
            _ => self.owner.clone(),
        })
    }

    fn transition_requires_retirement(
        &self,
        request: &PreviewRequest,
        next: &Option<String>,
        now: Instant,
    ) -> bool {
        let reclaim_retired_owner = request.op == "claim"
            && self.owner.as_ref() == Some(&request.client_id)
            && self
                .retirement
                .is_some_and(|checkpoint| checkpoint.epoch == self.epoch);
        !self.retired_release(request)
            && (next != &self.owner
                || (self.expired(now)
                    && !matches!(request.op.as_str(), "release" | "disconnect"))
                || (request.op == "connect"
                    && self.owner.as_ref() == Some(&request.client_id))
                // A callback may retire this epoch and then lose its proposed
                // successor. An authenticated explicit reclaim needs a NEW
                // epoch; reporting success at the frozen old epoch would not
                // grant usable authority. A completed checkpoint suppresses
                // repeated runtime cancellation in the owner consumer.
                || reclaim_retired_owner)
    }
}

impl Shared {
    pub(super) fn queue_preview(&mut self, request: PreviewRequest) -> Result<(), String> {
        // Preserve the current DOM-only admission policy. The shared owner
        // ledger is reusable; this extraction does not opt Raster into it.
        self.preview
            .queue_preview(request, self.dom.enabled, self.dom.configured)
    }
}

impl WebSurfaceHandle {
    /// Capture only current lease authority, independently of DOM requests.
    /// The proof is bound to this Shared allocation and cannot be transplanted
    /// to a same-valued surface. It is never sent into AppService.
    pub fn capture_preview_owner(&self, fence: &PreviewFence) -> Result<PreviewOwnerFence, String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        shared.preview.validate_fence(Some(fence))?;
        Ok(PreviewOwnerFence {
            owner: Arc::downgrade(&self.shared),
            client_id: fence.client_id.clone(),
            epoch: decimal(&fence.epoch)?,
        })
    }

    /// Revalidate after queueing or runtime work, without borrowing a DOM
    /// request. Live expiry and a primary reconnect both retire old proofs.
    pub fn validate_preview_owner(&self, fence: &PreviewOwnerFence) -> Result<(), String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        fence.validate_locked(&Arc::downgrade(&self.shared), &shared.preview)
    }

    pub fn take_preview_requests(&self) -> Vec<PreviewRequest> {
        let Ok(mut shared) = self.shared.lock() else {
            return vec![];
        };
        if shared.preview.sse_binding_enabled {
            return vec![];
        }
        let now = Instant::now();
        let owner = shared.preview.owner.clone();
        let stale: Vec<_> = shared
            .preview
            .clients
            .iter()
            .filter(|(id, client)| {
                Some(*id) != owner.as_ref()
                    && now.saturating_duration_since(client.last_seen) >= PREVIEW_LEASE
            })
            .map(|(id, _)| id.clone())
            .collect();
        shared.preview.clients.retain(|id, client| {
            Some(id) == owner.as_ref()
                || now.saturating_duration_since(client.last_seen) < PREVIEW_LEASE
        });
        let epoch = shared.preview.epoch;
        for client in stale {
            shared.preview.remember_retired_lease(client, epoch);
        }
        let mut requests = Vec::new();
        if shared.dom.configured && shared.preview.expired(Instant::now()) {
            requests.push(PreviewRequest {
                version: "1.0".into(),
                request_id: format!("expire-{}", shared.preview.epoch),
                client_id: shared.preview.owner.clone().expect("expired owner"),
                op: "expire".into(),
                epoch: Some(shared.preview.epoch.to_string()),
            });
        }
        requests.extend(
            shared
                .preview
                .requests
                .drain(..)
                .map(|control| match control {
                    QueuedPreviewControl::Legacy(request) => request,
                    _ => unreachable!("bound controls are never admitted in legacy mode"),
                }),
        );
        requests
    }
    pub fn preview_transfer_required(&self, request: &PreviewRequest) -> Result<bool, String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if shared.preview.sse_binding_enabled {
            return Err("ERR_PERMISSION_DENIED: use the bound preview owner lane".into());
        }
        transfer_required_locked(&shared, request)
    }
    /// `runtime_retired` confirms the owner retired the old runtime topology
    /// before transferring the lease. A wall-clock expiry between planning and
    /// commit fails closed rather than changing authority without retirement.
    pub fn commit_preview_request(
        &self,
        request: &PreviewRequest,
        runtime_retired: bool,
    ) -> Result<Value, String> {
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if shared.preview.sse_binding_enabled {
            return Err("ERR_PERMISSION_DENIED: use the bound preview owner lane".into());
        }
        let (response, retired) =
            commit_preview_request_locked(&mut shared, request, runtime_retired, None, None)?;
        drop(shared);
        drop(retired);
        Ok(response)
    }
    pub fn reject_preview_request(&self, request: &PreviewRequest, message: &str) {
        if let Ok(mut shared) = self.shared.lock() {
            let response = json!({"ok":false,"requestId":request.request_id,"clientId":request.client_id,
                "preview":shared.preview.preview_value(),"error":{"code":"ERR_CANCELLED","message":message}});
            shared.publish("preview".into(), response);
        }
    }
}

pub(super) fn transfer_required_locked(
    shared: &Shared,
    request: &PreviewRequest,
) -> Result<bool, String> {
    let now = Instant::now();
    let next = shared.preview.next_owner(
        request,
        now,
        shared.dom.enabled || shared.preview.sse_binding_enabled,
        shared.dom.configured || shared.preview.sse_binding_enabled,
    )?;
    Ok(shared
        .preview
        .transition_requires_retirement(request, &next, now))
}

pub(super) fn commit_preview_request_locked(
    shared: &mut Shared,
    request: &PreviewRequest,
    runtime_retired: bool,
    connection: Option<Arc<BoundSseConnection>>,
    retired_events: Option<&mut Vec<super::WebEvent>>,
) -> Result<(Value, super::dom::DomRetirement), String> {
    let mut retired = super::dom::DomRetirement::default();
    let now = Instant::now();
    let next = shared.preview.next_owner(
        request,
        now,
        shared.dom.enabled || shared.preview.sse_binding_enabled,
        shared.dom.configured || shared.preview.sse_binding_enabled,
    )?;
    let retired_release = shared.preview.retired_release(request);
    let previous_epoch = shared.preview.epoch;
    if shared
        .preview
        .transition_requires_retirement(request, &next, now)
    {
        if !runtime_retired {
            return Err("ERR_CANCELLED: preview transfer requires runtime retirement".into());
        }
        let epoch = shared
            .preview
            .epoch
            .checked_add(1)
            .ok_or("ERR_RENDER: preview epoch exhausted")?;
        retired = shared.dom.clear()?;
        for client in shared.preview.clients.keys().cloned().collect::<Vec<_>>() {
            shared
                .preview
                .remember_retired_lease(client, previous_epoch);
        }
        shared.preview.epoch = epoch;
        shared.preview.owner = next;
    }
    // An old cleanup message may arrive after a newer owner claimed or
    // the same client reconnected. Acknowledge it without mutation.
    if !retired_release {
        if matches!(request.op.as_str(), "release" | "expire" | "disconnect") {
            shared.preview.clients.remove(&request.client_id);
            shared
                .preview
                .remember_retired_lease(request.client_id.clone(), previous_epoch);
        } else {
            let connection = connection.or_else(|| {
                shared
                    .preview
                    .clients
                    .get(&request.client_id)
                    .and_then(|client| client.connection.clone())
            });
            shared.preview.clients.insert(
                request.client_id.clone(),
                PreviewClient {
                    last_seen: now,
                    connection,
                },
            );
        }
    }
    let response = json!({"ok":true,"requestId":request.request_id,"clientId":request.client_id,"preview":shared.preview.preview_value()});
    shared.publish_with_retirement("preview".into(), response.clone(), retired_events);
    Ok((response, retired))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::WebSurface;
    use container_ir::RendererProfile;

    fn request(client: &str, operation: &str, epoch: Option<&str>) -> PreviewRequest {
        PreviewRequest {
            version: "1.0".into(),
            request_id: format!("{client}-{operation}"),
            client_id: client.into(),
            op: operation.into(),
            epoch: epoch.map(str::to_owned),
        }
    }

    fn setup() -> (WebSurface, WebSurfaceHandle) {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.configure_browser_view();
        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        let connect = request("owner", "connect", None);
        assert!(handle.preview_transfer_required(&connect).unwrap());
        handle.commit_preview_request(&connect, true).unwrap();
        (surface, handle)
    }

    fn wire(handle: &WebSurfaceHandle, client: &str) -> PreviewFence {
        PreviewFence {
            client_id: client.into(),
            epoch: handle.shared.lock().unwrap().preview.epoch.to_string(),
            request_revision: None,
        }
    }

    fn render(revision: &str) -> crate::BrowserRenderRequest {
        crate::BrowserRenderRequest {
            version: "1.0".into(),
            revision: revision.into(),
            render: json!({"templateId":"template:pages/home/index.wxml",
                "useSessionResources":true,"styleIds":["style:app.wxss"],
                "viewport":{"x":0.0,"y":0.0,"width":375.0,"height":667.0}}),
        }
    }

    #[test]
    fn typed_owner_pin_rejects_equal_surface_values_and_accepts_handle_clones() {
        let (_a_surface, a) = setup();
        let (_b_surface, b) = setup();
        assert_eq!(
            a.shared.lock().unwrap().preview.preview_value(),
            b.shared.lock().unwrap().preview.preview_value()
        );
        let proof = a.capture_preview_owner(&wire(&a, "owner")).unwrap();
        a.validate_preview_owner(&proof).unwrap();
        a.clone().validate_preview_owner(&proof).unwrap();
        let error = b.validate_preview_owner(&proof).unwrap_err();
        assert!(error.contains("another Web surface"));
    }

    #[test]
    fn owner_proof_does_not_require_or_authorize_a_dom_request() {
        let (_surface, handle) = setup();
        let fence = wire(&handle, "owner");
        let proof = handle.capture_preview_owner(&fence).unwrap();
        // A connected owner exists before any desired DOM document is issued.
        // General lease proof must work, while DOM mutation remains fenced.
        handle.validate_preview_owner(&proof).unwrap();
        assert!(handle
            .capture_presentation_control(&json!({"preview":fence}))
            .is_err());
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        let control = handle
            .capture_presentation_control(&json!({"preview":fence}))
            .unwrap();
        handle
            .set_browser_view_request("session", &render("2"))
            .unwrap();
        handle.validate_preview_owner(&proof).unwrap();
        let prepared = handle.prepare_presentation(json!({"revision":2})).unwrap();
        assert!(prepared.validate_control(&control).is_err());
        handle.clear_browser_view().unwrap();
        handle.validate_preview_owner(&proof).unwrap();
        assert!(handle
            .validate_presentation_owner(&json!({"preview":fence}))
            .is_err());
        // Extracting lease authority does not enable a Raster owner policy.
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        handle.validate_preview_owner(&proof).unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .queue_preview(request("new", "connect", None))
            .is_err());
    }

    #[test]
    fn claim_reconnect_expiry_and_late_release_share_one_owner_epoch() {
        let (_surface, handle) = setup();
        let owner = handle
            .capture_preview_owner(&wire(&handle, "owner"))
            .unwrap();
        handle
            .commit_preview_request(&request("mirror", "connect", None), false)
            .unwrap();
        assert!(handle
            .capture_preview_owner(&wire(&handle, "mirror"))
            .is_err());
        let epoch = wire(&handle, "owner").epoch;
        let claim = request("mirror", "claim", Some(&epoch));
        assert!(handle.preview_transfer_required(&claim).unwrap());
        assert!(handle.commit_preview_request(&claim, false).is_err());
        handle.validate_preview_owner(&owner).unwrap();
        handle.commit_preview_request(&claim, true).unwrap();
        assert!(handle.validate_preview_owner(&owner).is_err());
        let before_reconnect = wire(&handle, "mirror");
        let mirror = handle.capture_preview_owner(&before_reconnect).unwrap();
        let reconnect = request("mirror", "connect", None);
        assert!(handle.preview_transfer_required(&reconnect).unwrap());
        handle.commit_preview_request(&reconnect, true).unwrap();
        assert!(handle.validate_preview_owner(&mirror).is_err());
        let current = handle
            .capture_preview_owner(&wire(&handle, "mirror"))
            .unwrap();
        let release = request("mirror", "release", Some(&before_reconnect.epoch));
        assert!(!handle.preview_transfer_required(&release).unwrap());
        handle.commit_preview_request(&release, false).unwrap();
        handle.validate_preview_owner(&current).unwrap();
        handle
            .shared
            .lock()
            .unwrap()
            .preview
            .clients
            .get_mut("mirror")
            .unwrap()
            .last_seen = Instant::now() - PREVIEW_LEASE - Duration::from_millis(1);
        assert!(handle.validate_preview_owner(&current).is_err());
        let expiry = handle.take_preview_requests();
        assert_eq!(expiry.len(), 1);
        assert_eq!(expiry[0].op, "expire");
        handle.commit_preview_request(&expiry[0], true).unwrap();
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
        assert!(handle.validate_preview_owner(&current).is_err());
    }

    #[test]
    fn exhausted_shared_owner_epoch_does_not_reconnect_or_retire_current_proof() {
        let (_surface, handle) = setup();
        handle.shared.lock().unwrap().preview.epoch = u64::MAX;
        let proof = handle
            .capture_preview_owner(&wire(&handle, "owner"))
            .unwrap();
        let error = handle
            .commit_preview_request(&request("owner", "connect", None), true)
            .unwrap_err();
        assert!(error.contains("preview epoch exhausted"));
        handle.validate_preview_owner(&proof).unwrap();
        assert_eq!(handle.shared.lock().unwrap().preview.epoch, u64::MAX);
    }
}
