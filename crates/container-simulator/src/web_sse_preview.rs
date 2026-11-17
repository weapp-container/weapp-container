//! Opt-in socket facts and the existing preview owner's ordered control lane.
//! No runtime, renderer, owner map or token is created by HTTP request bodies.
use super::preview::{
    commit_preview_request_locked, decimal, identifier, transfer_required_locked,
    MAX_PREVIEW_REQUESTS,
};
use super::{PreviewRequest, Shared, WebSurface, WebSurfaceHandle};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Instant;

#[cfg(test)]
pub(super) struct EventDropProbe(pub(super) Box<dyn Fn() + Send + Sync>);
#[cfg(test)]
impl std::fmt::Debug for EventDropProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("EventDropProbe")
    }
}
#[cfg(test)]
impl Drop for EventDropProbe {
    fn drop(&mut self) {
        (self.0)();
    }
}

pub(super) struct BoundSseConnection {
    owner: Weak<Mutex<Shared>>,
    client_id: String,
    token: String,
    serial: u64,
    connected: AtomicBool,
    retirement_queued: AtomicBool,
}

impl std::fmt::Debug for BoundSseConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoundSseConnection")
            .field("client_id", &self.client_id)
            .field("serial", &self.serial)
            .field("connected", &self.is_live())
            .finish_non_exhaustive()
    }
}

impl BoundSseConnection {
    pub(super) fn is_live(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    pub(super) fn validate_owner(
        self: &Arc<Self>,
        owner: &Arc<Mutex<Shared>>,
        shared: &Shared,
        epoch: u64,
    ) -> Result<(), String> {
        if !Weak::ptr_eq(&self.owner, &Arc::downgrade(owner))
            || !self.is_live()
            || !is_current_connection(shared, self)
        {
            return Err("ERR_CANCELLED: bound preview connection was retired".into());
        }
        shared.preview.validate_owner(&self.client_id, epoch)
    }

    pub(super) fn init_wire(&self) -> Vec<u8> {
        let value = json!({"version":"1.0","clientId":self.client_id,
            "connectionToken":self.token,"committed":false});
        // Connection-private: no id field and never Shared::publish/replay.
        format!("event: preview-init\ndata: {value}\n\n").into_bytes()
    }

    /// The socket destructor owns exactly one pre-reserved retirement place.
    /// This only moves bounded metadata; no callback or runtime runs here.
    pub(super) fn retire(self: &Arc<Self>) {
        self.connected.store(false, Ordering::Release);
        if self.retirement_queued.swap(true, Ordering::AcqRel) {
            return;
        }
        let Some(owner) = self.owner.upgrade() else {
            return;
        };
        // Poison recovery is cleanup-only. Normal owner operations fail closed
        // on poison; do not lose an already-reserved socket retirement.
        let mut shared = owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        assert!(shared.preview.reserved_retirements > 0);
        assert!(shared.preview.requests.len() < MAX_PREVIEW_REQUESTS);
        shared.preview.reserved_retirements -= 1;
        shared
            .preview
            .requests
            .push_back(QueuedPreviewControl::Closed(Arc::clone(self)));
    }
}

#[derive(Clone, Debug)]
pub(super) enum QueuedPreviewControl {
    Legacy(PreviewRequest),
    Connected(Arc<BoundSseConnection>),
    Closed(Arc<BoundSseConnection>),
    Bound(PreviewRequest, Arc<BoundSseConnection>),
    Expired(PreviewRequest, Arc<BoundSseConnection>),
}

impl QueuedPreviewControl {
    fn same_control(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Connected(a), Self::Connected(b)) | (Self::Closed(a), Self::Closed(b)) => {
                Arc::ptr_eq(a, b)
            }
            (Self::Bound(a, x), Self::Bound(b, y)) => Arc::ptr_eq(x, y) && same_request(a, b),
            (Self::Expired(a, x), Self::Expired(b, y)) => Arc::ptr_eq(x, y) && same_request(a, b),
            _ => false,
        }
    }
}

fn same_request(a: &PreviewRequest, b: &PreviewRequest) -> bool {
    a.version == b.version
        && a.request_id == b.request_id
        && a.client_id == b.client_id
        && a.op == b.op
        && a.epoch == b.epoch
}

/// Borrowed only during a trusted owner callback. No constructor or wire input
/// can create this request. It never contains the private connection token.
#[derive(Debug)]
pub struct PreviewRetirement {
    owner_client: Option<String>,
    epoch: u64,
    reason: &'static str,
}

impl PreviewRetirement {
    pub fn owner_client_id(&self) -> Option<&str> {
        self.owner_client.as_deref()
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn reason(&self) -> &str {
        self.reason
    }
}

/// Facts from completed owner-lane processing, never presentation permission.
/// Not Clone/serde/constructible by an HTTP caller.
#[derive(Debug)]
pub struct PreviewControlReceipt {
    client_id: String,
    epoch: u64,
    applied: bool,
    runtime_retired: bool,
}

impl PreviewControlReceipt {
    pub fn client_id(&self) -> &str {
        &self.client_id
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn applied(&self) -> bool {
        self.applied
    }
    pub fn runtime_retired(&self) -> bool {
        self.runtime_retired
    }
}

/// One bounded checkpoint in the SAME owner ledger. A completed retirement
/// remains remembered if a callback closes its proposed successor; retry must
/// neither deliver cancellation twice nor revive the retired old authority.
#[derive(Clone, Copy, Debug)]
pub(super) struct RetirementCheckpoint {
    pub(super) epoch: u64,
    pub(super) completed: bool,
}

struct ResolvingPreview<'a>(&'a WebSurfaceHandle);
impl Drop for ResolvingPreview<'_> {
    fn drop(&mut self) {
        let mut shared = self
            .0
            .shared
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        shared.preview.resolving = false;
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BoundPreviewWire {
    version: String,
    request_id: String,
    client_id: String,
    op: String,
    epoch: String,
    connection_token: String,
}

impl Shared {
    pub(super) fn capture_bound_owner(
        &self,
        owner: &Arc<Mutex<Shared>>,
        client_id: &str,
        epoch: u64,
        token: &str,
    ) -> Result<Arc<BoundSseConnection>, String> {
        if token.len() > 85 {
            return Err("ERR_CANCELLED: invalid connection token".into());
        }
        let connection = self
            .preview
            .clients
            .get(client_id)
            .and_then(|client| client.connection.as_ref())
            .filter(|connection| connection.token == token)
            .ok_or("ERR_CANCELLED: connection is not the committed preview binding")?;
        connection.validate_owner(owner, self, epoch)?;
        Ok(Arc::clone(connection))
    }
    pub(super) fn queue_bound_preview(&mut self, body: &[u8]) -> Result<Value, String> {
        // Parsing is bounded too: an oversized JSON token/body must not create
        // a multi-MiB temporary whose destructor runs under the Web mutex.
        if body.len() > 1024 {
            return Err(
                "ERR_PROTOCOL_VERSION: bound preview request exceeds its byte budget".into(),
            );
        }
        let wire: BoundPreviewWire = serde_json::from_slice(body)
            .map_err(|_| "ERR_PROTOCOL_VERSION: invalid bound preview request")?;
        let request = PreviewRequest {
            version: wire.version,
            request_id: wire.request_id,
            client_id: wire.client_id,
            op: wire.op,
            epoch: Some(wire.epoch),
        };
        request.validate(false)?;
        if request.op == "connect" || !self.preview.sse_binding_enabled {
            return Err("ERR_PERMISSION_DENIED: connect requires an actual SSE socket".into());
        }
        if wire.connection_token.len() > 85 {
            return Err("ERR_PERMISSION_DENIED: invalid preview connection".into());
        }
        let connection = self
            .preview
            .clients
            .get(&request.client_id)
            .and_then(|client| client.connection.as_ref())
            .filter(|connection| connection.is_live() && connection.token == wire.connection_token)
            .cloned()
            .ok_or("ERR_CANCELLED: preview connection is not current")?;
        if request.epoch.as_deref().map(decimal).transpose()? != Some(self.preview.epoch) {
            return Err("ERR_CANCELLED: stale preview epoch".into());
        }
        if self.preview.requests.len() + self.preview.reserved_retirements >= MAX_PREVIEW_REQUESTS {
            return Err("ERR_RENDER: preview queue full".into());
        }
        let receipt = json!({"queued":true,"requestId":request.request_id});
        self.preview
            .requests
            .push_back(QueuedPreviewControl::Bound(request, connection));
        Ok(receipt)
    }
}

impl WebSurface {
    /// Explicit library-only opt-in on a pristine normal surface. Default DOM,
    /// resource/control transports and CLI keep their previous protocol.
    pub fn enable_sse_preview_binding(&mut self) -> Result<(), String> {
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if self.resource_only
            || !self.accepting
            || self.has_accepted
            || shared.preview.sse_binding_enabled
            || shared.preview.epoch != 0
            || !shared.preview.clients.is_empty()
            || !shared.preview.requests.is_empty()
            || !self.clients.is_empty()
        {
            return Err(
                "ERR_PERMISSION_DENIED: SSE binding requires a pristine normal surface".into(),
            );
        }
        shared
            .preview
            .requests
            .try_reserve_exact(MAX_PREVIEW_REQUESTS)
            .map_err(|_| "ERR_RENDER: preview control allocation failed")?;
        shared.preview.sse_binding_enabled = true;
        Ok(())
    }

    /// Close only this surface's event streams. The original owner must drain
    /// resolve_preview_controls before destroying its runtime. Drop also queues
    /// the work, but cannot manufacture an owner turn for a discarded runtime.
    pub fn close_event_streams(&mut self) {
        self.clients.clear();
    }

    pub(super) fn reserve_sse_connection(
        &self,
        client_id: &str,
    ) -> Result<Arc<BoundSseConnection>, String> {
        if !identifier(client_id) {
            return Err("ERR_PROTOCOL_VERSION: invalid SSE client identifier".into());
        }
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random).map_err(|_| "ERR_ENGINE: connection entropy unavailable")?;
        let mut token = String::with_capacity(85);
        use std::fmt::Write;
        for byte in random {
            write!(&mut token, "{byte:02x}").expect("writing to String");
        }
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if shared.strict_raster && !super::strict_raster::valid_client_id(client_id) {
            return Err("ERR_PROTOCOL_VERSION: strict Raster SSE clientId requires 1..128 ASCII alphanumeric, hyphen or underscore bytes".into());
        }
        if !shared.preview.sse_binding_enabled {
            return Err("ERR_UNSUPPORTED_CAPABILITY: SSE connection binding is not enabled".into());
        }
        if shared.preview.requests.len() + shared.preview.reserved_retirements + 2
            > MAX_PREVIEW_REQUESTS
        {
            return Err("ERR_RENDER: preview cleanup reservation budget exceeded".into());
        }
        let serial = shared
            .preview
            .next_connection_serial
            .ok_or("ERR_RENDER: SSE connection identity exhausted")?;
        let next = serial.checked_add(1);
        write!(&mut token, "-{serial}").expect("writing to String");
        let connection = Arc::new(BoundSseConnection {
            owner: Arc::downgrade(&self.shared),
            client_id: client_id.into(),
            token,
            serial,
            connected: AtomicBool::new(true),
            retirement_queued: AtomicBool::new(false),
        });
        shared
            .preview
            .requests
            .push_back(QueuedPreviewControl::Connected(Arc::clone(&connection)));
        shared.preview.reserved_retirements += 1;
        shared.preview.next_connection_serial = next;
        Ok(connection)
    }
}

impl Drop for WebSurface {
    fn drop(&mut self) {
        // Run actual client destructors before the surface's Shared field can
        // drop. An external owner handle retains the bounded retirement work.
        self.close_event_streams();
    }
}

struct Transition {
    request: PreviewRequest,
    connection: Option<Arc<BoundSseConnection>>,
    transfer: bool,
    reason: &'static str,
}

fn is_current_connection(shared: &Shared, connection: &Arc<BoundSseConnection>) -> bool {
    shared
        .preview
        .clients
        .get(&connection.client_id)
        .and_then(|client| client.connection.as_ref())
        .is_some_and(|current| Arc::ptr_eq(current, connection))
}

fn transition(
    shared: &Shared,
    control: &QueuedPreviewControl,
) -> Result<Option<Transition>, String> {
    let epoch = shared.preview.epoch.to_string();
    let (request, connection, reason) = match control {
        QueuedPreviewControl::Connected(connection) if connection.is_live() => (
            PreviewRequest {
                version: "1.0".into(),
                request_id: format!("sse-connect-{}", connection.serial),
                client_id: connection.client_id.clone(),
                op: "connect".into(),
                epoch: None,
            },
            Some(Arc::clone(connection)),
            "preview-connection-changed",
        ),
        QueuedPreviewControl::Closed(connection) if is_current_connection(shared, connection) => (
            PreviewRequest {
                version: "1.0".into(),
                request_id: format!("sse-close-{}", connection.serial),
                client_id: connection.client_id.clone(),
                op: "disconnect".into(),
                epoch: Some(epoch),
            },
            None,
            "preview-connection-closed",
        ),
        QueuedPreviewControl::Bound(request, connection)
            if connection.is_live() && is_current_connection(shared, connection) =>
        {
            let mut request = request.clone();
            // The typed current binding supersedes old public-client/epoch
            // terminal receipts, including mirror reconnect at the same epoch.
            if request.op == "release" {
                request.op = "disconnect".into();
            }
            (
                request,
                Some(Arc::clone(connection)),
                "preview-owner-changed",
            )
        }
        QueuedPreviewControl::Expired(request, connection)
            if is_current_connection(shared, connection)
                && shared
                    .preview
                    .clients
                    .get(&request.client_id)
                    .is_some_and(|client| {
                        Instant::now().saturating_duration_since(client.last_seen)
                            >= super::preview::PREVIEW_LEASE
                    }) =>
        {
            (request.clone(), None, "preview-owner-expired")
        }
        QueuedPreviewControl::Legacy(_) => {
            return Err("ERR_PERMISSION_DENIED: unbound control in the bound owner lane".into())
        }
        _ => return Ok(None),
    };
    let transfer = transfer_required_locked(shared, &request)?;
    Ok(Some(Transition {
        request,
        connection,
        transfer,
        reason,
    }))
}

fn control_client(control: &QueuedPreviewControl) -> &str {
    match control {
        QueuedPreviewControl::Legacy(request)
        | QueuedPreviewControl::Bound(request, _)
        | QueuedPreviewControl::Expired(request, _) => &request.client_id,
        QueuedPreviewControl::Connected(connection) | QueuedPreviewControl::Closed(connection) => {
            &connection.client_id
        }
    }
}

impl WebSurfaceHandle {
    /// Resolve the single original bounded FIFO on the runtime owner's lane.
    /// Successful retirement is remembered before post-callback revalidation;
    /// losing a proposed connection cannot replay callbacks or revive old input.
    pub fn resolve_preview_controls(
        &self,
        mut retire: impl FnMut(&PreviewRetirement) -> Result<(), String>,
    ) -> Result<Vec<PreviewControlReceipt>, String> {
        {
            let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
            if !shared.preview.sse_binding_enabled {
                return Err(
                    "ERR_UNSUPPORTED_CAPABILITY: bound preview owner lane is not enabled".into(),
                );
            }
            if shared.preview.resolving {
                return Err("ERR_CANCELLED: preview owner lane is already resolving".into());
            }
            shared.preview.resolving = true;
        }
        let _resolving = ResolvingPreview(self);
        let mut receipts = Vec::with_capacity(MAX_PREVIEW_REQUESTS);
        for _ in 0..MAX_PREVIEW_REQUESTS {
            let (control, planned, epoch, retirement) = {
                let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
                if shared.preview.requests.is_empty() {
                    let now = Instant::now();
                    let expired: Vec<_> = shared
                        .preview
                        .clients
                        .iter()
                        .filter(|(_, client)| {
                            now.saturating_duration_since(client.last_seen)
                                >= super::preview::PREVIEW_LEASE
                        })
                        .filter_map(|(id, client)| {
                            client
                                .connection
                                .as_ref()
                                .map(|connection| (id.clone(), Arc::clone(connection)))
                        })
                        .collect();
                    for (client_id, connection) in expired {
                        if shared.preview.requests.len() + shared.preview.reserved_retirements
                            >= MAX_PREVIEW_REQUESTS
                        {
                            break;
                        }
                        let operation = if shared.preview.owner.as_ref() == Some(&client_id) {
                            "expire"
                        } else {
                            "disconnect"
                        };
                        let request = PreviewRequest {
                            version: "1.0".into(),
                            request_id: format!(
                                "expire-{}-{}",
                                shared.preview.epoch, connection.serial
                            ),
                            client_id,
                            op: operation.into(),
                            epoch: Some(shared.preview.epoch.to_string()),
                        };
                        shared
                            .preview
                            .requests
                            .push_back(QueuedPreviewControl::Expired(request, connection));
                    }
                }
                let Some(control) = shared.preview.requests.front().cloned() else {
                    break;
                };
                let planned = transition(&shared, &control);
                let epoch = shared.preview.epoch;
                let retirement = match &planned {
                    Ok(Some(plan))
                        if plan.transfer
                            && !shared.preview.retirement.is_some_and(|checkpoint| {
                                checkpoint.epoch == epoch && checkpoint.completed
                            }) =>
                    {
                        shared.preview.retirement = Some(RetirementCheckpoint {
                            epoch,
                            completed: false,
                        });
                        Some(PreviewRetirement {
                            owner_client: shared.preview.owner.clone(),
                            epoch,
                            reason: plan.reason,
                        })
                    }
                    _ => None,
                };
                (control, planned, epoch, retirement)
            };
            if let Some(retirement) = &retirement {
                retire(retirement)?;
                let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
                if shared.preview.epoch != epoch
                    || !shared
                        .preview
                        .requests
                        .front()
                        .is_some_and(|front| front.same_control(&control))
                {
                    return Err("ERR_CANCELLED: preview control changed during retirement".into());
                }
                shared.preview.retirement = Some(RetirementCheckpoint {
                    epoch,
                    completed: true,
                });
            }
            let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
            if shared.preview.epoch != epoch
                || !shared
                    .preview
                    .requests
                    .front()
                    .is_some_and(|front| front.same_control(&control))
            {
                return Err("ERR_CANCELLED: preview control was superseded".into());
            }
            // This second transition read rejects an EOF or a successor change
            // that happened while the callback held no Web mutex.
            let current = transition(&shared, &control);
            let runtime_retired = shared
                .preview
                .retirement
                .is_some_and(|checkpoint| checkpoint.epoch == epoch && checkpoint.completed);
            let mut retired_events = Vec::with_capacity(super::MAX_EVENTS);
            let result = match (planned, current) {
                (Ok(Some(_)), Ok(Some(current))) if !current.transfer || runtime_retired => {
                    commit_preview_request_locked(
                        &mut shared,
                        &current.request,
                        current.transfer,
                        current.connection,
                        Some(&mut retired_events),
                    )
                    .map(|(_, retired)| (true, retired))
                }
                (Ok(None), _) | (_, Ok(None)) => Ok((false, super::dom::DomRetirement::default())),
                (Err(_), _) | (_, Err(_)) => Ok((false, super::dom::DomRetirement::default())),
                _ => {
                    return Err(
                        "ERR_CANCELLED: preview retirement is required before commit".into(),
                    )
                }
            };
            let (applied, retired) = result?;
            let removed = shared.preview.requests.pop_front();
            let receipt = PreviewControlReceipt {
                client_id: control_client(&control).into(),
                epoch: shared.preview.epoch,
                applied,
                runtime_retired,
            };
            drop(shared);
            drop(retired);
            drop(retired_events);
            drop(removed);
            receipts.push(receipt);
        }
        Ok(receipts)
    }
}
