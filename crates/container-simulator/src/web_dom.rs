//! Owner-thread DOM publication; preview lease authority lives in web_preview.
use super::{
    preview::{decimal, PreviewState},
    PreviewFence, QueuedBridgeRequest, WebSurfaceHandle, MAX_FRAME_BYTES, MAX_REQUEST_BYTES,
};
use container_ir::{PresentationKey, RendererProfile, ViewDocument};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

const MAX_DOM_RESOURCES: usize = 1024;

/// Browser JSON serialization spells integral coordinates without `.0`.
/// Treat only viewport numbers by their exact finite numeric value; retain
/// strict template, stylesheet, resource and key-set identity everywhere else.
fn same_render_request(actual: &Value, expected: &Value) -> bool {
    let (Some(actual), Some(expected)) = (actual.as_object(), expected.as_object()) else {
        return false;
    };
    actual.len() == expected.len()
        && expected.iter().all(|(key, expected)| {
            let Some(actual) = actual.get(key) else {
                return false;
            };
            if key != "viewport" {
                return actual == expected;
            }
            let (Some(actual), Some(expected)) = (actual.as_object(), expected.as_object()) else {
                return false;
            };
            actual.len() == 4
                && expected.len() == 4
                && ["x", "y", "width", "height"].into_iter().all(|coordinate| {
                    match (
                        actual.get(coordinate).and_then(Value::as_f64),
                        expected.get(coordinate).and_then(Value::as_f64),
                    ) {
                        (Some(actual), Some(expected)) => {
                            actual.is_finite() && expected.is_finite() && actual == expected
                        }
                        _ => false,
                    }
                })
        })
}

#[derive(Debug)]
struct EncodedAsset {
    #[cfg(test)]
    _drop_probe: Option<DomDropProbe>,
    mime: String,
    bytes: Arc<Vec<u8>>,
}

#[cfg(test)]
struct DomDropProbe(Option<Box<dyn FnOnce() + Send>>);

#[cfg(test)]
impl std::fmt::Debug for DomDropProbe {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("DomDropProbe")
            .field(&self.0.is_some())
            .finish()
    }
}

#[cfg(test)]
impl Drop for DomDropProbe {
    fn drop(&mut self) {
        if let Some(probe) = self.0.take() {
            probe();
        }
    }
}

#[derive(Debug)]
struct CachedView {
    // A production-consumer test observes the real owner's destruction
    // before its payload and resource fields are released.
    #[cfg(test)]
    _drop_probe: Option<DomDropProbe>,
    key: PresentationKey,
    submission: Value,
    resources: BTreeMap<String, EncodedAsset>,
}

/// Old DOM owners are moved here while Shared is locked, then released only
/// after the guard. Resource Arcs remain in the existing Weak capacity ledger
/// for the entire lifetime of this receipt, including unlocked destruction.
#[must_use = "keep DOM owners alive until the Shared guard has been released"]
#[derive(Default)]
pub(super) struct DomRetirement {
    #[cfg(test)]
    _request_drop_probe: Option<DomDropProbe>,
    _pending: Option<CachedView>,
    _accepted: Option<CachedView>,
    _request: Option<Value>,
}

impl DomRetirement {
    fn replace_request(&mut self, dom: &mut DomState, request: Option<Value>) {
        // Each consumer replaces the desired request at most once. Moving it
        // never drops the old Value inside the publication critical section.
        self._request = std::mem::replace(&mut dom.request, request);
        #[cfg(test)]
        {
            self._request_drop_probe = dom.request_drop_probe.take();
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct DomState {
    pub(super) configured: bool,
    pub enabled: bool,
    pub(super) profile: Option<RendererProfile>,
    session_id: String,
    generation: u64,
    request: Option<Value>,
    #[cfg(test)]
    request_drop_probe: Option<DomDropProbe>,
    #[cfg(test)]
    resource_drop_probe: Option<DomDropProbe>,
    pending: Option<CachedView>,
    accepted: Option<CachedView>,
    input_enabled: bool,
    authority_preview_epoch: u64,
}

impl DomState {
    pub(super) fn validate_presentation_control(
        &self,
        preview: &PreviewState,
        fence: &super::PresentationControlFence,
    ) -> Result<(), String> {
        if self.session_id != fence.preview_session
            || self.generation != fence.preview_generation
            || self.authority_preview_epoch != fence.preview_authority_epoch
            || self.request != fence.preview_request
        {
            return Err("ERR_CANCELLED: presentation preview authority was superseded".into());
        }
        self.validate_fence(preview, fence.preview.as_ref())
    }

    pub(super) fn validate_envelope_value(
        &self,
        preview: &PreviewState,
        fence: Option<&PreviewFence>,
        value: &Value,
    ) -> Result<(), String> {
        if let Some(messages) = value.get("messages").and_then(Value::as_array) {
            for message in messages {
                self.validate_envelope_value(preview, fence, message)?;
            }
            return Ok(());
        }
        let operation = value["op"].as_str().unwrap_or_default();
        if !operation.starts_with("view.") {
            return Ok(());
        }
        if !self.enabled {
            return Err("ERR_UNSUPPORTED_CAPABILITY: DOM preview is not enabled".into());
        }
        self.validate_fence(preview, fence)?;
        if value["sessionId"].as_str() != Some(self.session_id.as_str()) {
            return Err("ERR_CANCELLED: DOM request belongs to another session".into());
        }
        if operation == "view.prepare" {
            let payload = &value["payload"];
            let request = self
                .request
                .as_ref()
                .ok_or("ERR_CANCELLED: DOM request unavailable")?;
            if fence.and_then(|fence| fence.request_revision.as_deref())
                != request["revision"].as_str()
                || payload["surfaceGeneration"].as_str()
                    != Some(self.generation.to_string().as_str())
                || !same_render_request(&payload["render"], &request["render"])
            {
                return Err("ERR_CANCELLED: stale DOM prepare request".into());
            }
        }
        Ok(())
    }
    pub(super) fn extend_state(&self, value: &mut Value, preview: &PreviewState) {
        let Some(object) = value.as_object_mut() else {
            return;
        };
        if let Some(profile) = self.profile {
            object.insert("rendererProfile".into(), json!(profile));
        }
        if !self.enabled {
            return;
        }
        object.insert("webRenderer".into(), json!("webview"));
        object.insert("rendererProfile".into(), json!("webview"));
        object.insert("preview".into(), preview.preview_value());
        if let Some(request) = &self.request {
            object.insert(
                "viewAuthority".into(),
                json!({"sessionId":self.session_id,
                "revision":request["revision"],"surfaceGeneration":self.generation.to_string(),
                "previewEpoch":self.authority_preview_epoch.to_string()}),
            );
            object.insert("viewRequest".into(), request.clone());
        }
        if let Some(accepted) = &self.accepted {
            object.insert("viewPresented".into(), accepted.submission.clone());
            object.insert("viewInputEnabled".into(), json!(self.input_enabled));
        }
    }
    pub(super) fn clear(&mut self) -> Result<DomRetirement, String> {
        let generation = self
            .generation
            .checked_add(1)
            .ok_or("ERR_RENDER: DOM generation exhausted")?;
        let retired = DomRetirement {
            _pending: self.pending.take(),
            _accepted: self.accepted.take(),
            ..DomRetirement::default()
        };
        self.input_enabled = false;
        self.generation = generation;
        Ok(retired)
    }
    fn validate_fence(
        &self,
        preview: &PreviewState,
        fence: Option<&PreviewFence>,
    ) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        preview.validate_fence(fence)?;
        if self.request.is_none() || self.authority_preview_epoch != preview.epoch {
            return Err("ERR_CANCELLED: preview does not own the current lease".into());
        }
        Ok(())
    }
    pub(super) fn resource(
        &self,
        key: &PresentationKey,
        hash: &str,
    ) -> Option<(String, Arc<Vec<u8>>)> {
        if !self.enabled
            || key.session_id != self.session_id
            || key.surface_generation != self.generation
        {
            return None;
        }
        [self.pending.as_ref(), self.accepted.as_ref()]
            .into_iter()
            .flatten()
            .find(|entry| &entry.key == key)
            .and_then(|entry| entry.resources.get(hash))
            .map(|resource| (resource.mime.clone(), Arc::clone(&resource.bytes)))
    }
}

impl WebSurfaceHandle {
    pub fn configure_browser_view(&self) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.dom.configured = true;
        }
    }
    pub fn set_renderer_profile(&self, profile: RendererProfile) -> Result<(), String> {
        let mut retired = DomRetirement::default();
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        let enabled = profile == RendererProfile::WebView;
        if enabled && !shared.dom.configured {
            return Err(
                "ERR_UNSUPPORTED_CAPABILITY: browser presentation is not configured".into(),
            );
        }
        let profile_changed = shared.dom.profile != Some(profile);
        let enabled_changed = shared.dom.enabled != enabled;
        if enabled_changed {
            retired = shared.dom.clear()?;
            retired.replace_request(&mut shared.dom, None);
            if enabled {
                shared.retire_raster_publication();
            } else {
                shared.advance_publication_epoch();
            }
            shared.dom.enabled = enabled;
        }
        if profile_changed && !enabled_changed {
            shared.advance_publication_epoch();
        }
        shared.dom.profile = Some(profile);
        drop(shared);
        drop(retired);
        Ok(())
    }
    pub fn set_browser_view_request(
        &self,
        session_id: &str,
        request: &crate::BrowserRenderRequest,
    ) -> Result<(), String> {
        if session_id.is_empty() || session_id.len() > 256 || request.version != "1.0" {
            return Err("ERR_PROTOCOL_VERSION: invalid DOM authority".into());
        }
        let revision = decimal(&request.revision)?;
        let incoming =
            json!({"version":request.version,"revision":request.revision,"render":request.render});
        // Keep candidate/retired allocations older than the guard so errors
        // and unwinding also release the mutex before their destruction.
        let mut retired = DomRetirement::default();
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if !shared.dom.enabled {
            shared.retire_raster_publication();
        }
        shared.dom.enabled = true;
        shared.dom.configured = true;
        shared.dom.profile = Some(RendererProfile::WebView);
        let session_changed = shared.dom.session_id != session_id;
        if session_changed {
            retired = shared.dom.clear()?;
            shared.dom.session_id = session_id.into();
        }
        if !session_changed
            && shared.dom.request.as_ref().is_some_and(|previous| {
                previous["revision"]
                    .as_str()
                    .and_then(|v| decimal(v).ok())
                    .is_some_and(|old| old > revision)
            })
        {
            return Err("ERR_CANCELLED: DOM request revision regressed".into());
        }
        if !session_changed
            && shared.dom.request.as_ref().is_some_and(|previous| {
                previous["revision"] == request.revision
                    && !same_render_request(&previous["render"], &request.render)
            })
        {
            return Err("ERR_CANCELLED: DOM request revision is immutable".into());
        }
        // A new desired input does not revoke an already issued runtime
        // permit. Keep its bytes until the owner accepts, aborts or supersedes
        // that candidate; otherwise a late valid ACK fails after onReady ran.
        retired.replace_request(&mut shared.dom, Some(incoming));
        shared.dom.authority_preview_epoch = shared.preview.epoch;
        drop(shared);
        drop(retired);
        Ok(())
    }
    pub fn clear_browser_view(&self) -> Result<(), String> {
        let mut retired;
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        retired = shared.dom.clear()?;
        retired.replace_request(&mut shared.dom, None);
        drop(shared);
        drop(retired);
        Ok(())
    }
    pub fn take_fenced_bridge_requests(&self) -> Vec<QueuedBridgeRequest> {
        self.shared
            .lock()
            .map(|mut shared| {
                if shared.strict_raster {
                    Vec::new()
                } else {
                    shared
                        .bridge_requests
                        .drain(..)
                        .map(|entry| entry.request)
                        .collect()
                }
            })
            .unwrap_or_default()
    }
    pub fn validate_preview_request(&self, request: &QueuedBridgeRequest) -> Result<(), String> {
        let value = serde_json::from_slice(&request.body).map_err(|error| error.to_string())?;
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        shared
            .dom
            .validate_envelope_value(&shared.preview, request.preview.as_ref(), &value)
    }
    pub fn validate_presentation_owner(&self, value: &Value) -> Result<(), String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if !shared.dom.enabled {
            return Ok(());
        }
        let fence: Option<PreviewFence> = value
            .get("preview")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| format!("ERR_PROTOCOL_VERSION: {error}"))?;
        shared.dom.validate_fence(&shared.preview, fence.as_ref())
    }
    /// Capture the original preview fence before presentation decoding removes
    /// its transport-only fields. The final store guard revalidates this exact
    /// admission together with settings and publication identity.
    pub fn capture_presentation_control(
        &self,
        value: &Value,
    ) -> Result<super::PresentationControlFence, String> {
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        let preview: Option<PreviewFence> = value
            .get("preview")
            .map(|value| serde_json::from_value(value.clone()))
            .transpose()
            .map_err(|error| format!("ERR_PROTOCOL_VERSION: {error}"))?;
        shared
            .dom
            .validate_fence(&shared.preview, preview.as_ref())?;
        Ok(super::PresentationControlFence {
            owner: Arc::downgrade(&self.shared),
            publication_epoch: shared.publication_epoch,
            transport_session: shared.transport_session.clone(),
            next_transport_frame: shared.next_transport_frame,
            presentation: shared.presentation.clone(),
            renderer_profile: shared.dom.profile,
            preview_enabled: shared.dom.enabled,
            preview_session: shared.dom.session_id.clone(),
            preview_generation: shared.dom.generation,
            preview_authority_epoch: shared.dom.authority_preview_epoch,
            preview_request: shared.dom.request.clone(),
            preview,
        })
    }
    pub fn validate_preview_envelope(
        &self,
        request: &QueuedBridgeRequest,
        envelope: &container_bridge::BridgeEnvelope,
    ) -> Result<(), String> {
        let value = serde_json::to_value(envelope).map_err(|error| error.to_string())?;
        let shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        shared
            .dom
            .validate_envelope_value(&shared.preview, request.preview.as_ref(), &value)
    }
    pub fn publish_view_submission<'a>(
        &self,
        submission: Value,
        mut resource: impl FnMut(&str) -> Result<&'a [u8], String>,
    ) -> Result<(), String> {
        if submission["version"] != "1.0" {
            return Err("ERR_PROTOCOL_VERSION: invalid browser submission".into());
        }
        let key: PresentationKey =
            serde_json::from_value(submission["key"].clone()).map_err(|error| error.to_string())?;
        let document: ViewDocument = serde_json::from_value(submission["document"].clone())
            .map_err(|error| error.to_string())?;
        document.validate().map_err(|error| error.to_string())?;
        if key.profile != RendererProfile::WebView
            || key.session_id != document.session_id
            || key.page_id != document.page_id
            || key.document_revision != document.revision
        {
            return Err("ERR_RENDER: submission document identity mismatch".into());
        }
        if serde_json::to_vec(&submission)
            .map_err(|error| error.to_string())?
            .len()
            > MAX_REQUEST_BYTES
            || document.resources.len() > MAX_DOM_RESOURCES
        {
            return Err("ERR_RENDER: DOM document budget exceeded".into());
        }
        let mut retired = DomRetirement::default();
        let mut resources: BTreeMap<String, EncodedAsset> = BTreeMap::new();
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if !shared.dom.enabled
            || key.session_id != shared.dom.session_id
            || key.surface_generation != shared.dom.generation
        {
            return Err("ERR_CANCELLED: submission belongs to a retired DOM surface".into());
        }
        for asset in &document.resources {
            if asset.size > MAX_FRAME_BYTES as u64 || asset.mime.contains(['\r', '\n']) {
                return Err("ERR_RENDER: invalid or oversized DOM resource".into());
            }
            let bytes = resource(&asset.sha256)?;
            if bytes.len() as u64 != asset.size || container_ir::hex_digest(bytes) != asset.sha256 {
                return Err("ERR_INVALID_MANIFEST: DOM resource digest/size mismatch".into());
            }
            if let Some(existing) = resources.get(&asset.sha256) {
                if existing.mime != asset.mime {
                    return Err(
                        "ERR_INVALID_MANIFEST: one DOM resource digest has conflicting MIME types"
                            .into(),
                    );
                }
                continue;
            }
            let existing = [shared.dom.pending.as_ref(), shared.dom.accepted.as_ref()]
                .into_iter()
                .flatten()
                .find_map(|view| view.resources.get(&asset.sha256))
                .map(|entry| Arc::clone(&entry.bytes));
            let bytes = if let Some(existing) = existing {
                existing
            } else {
                // Previous candidate entries are already charged by the same
                // Weak ledger as published entries. Admit only this allocation.
                shared.ensure_frame_capacity(bytes.len(), 0, 0)?;
                let mut owned = Vec::new();
                owned
                    .try_reserve_exact(bytes.len())
                    .map_err(|_| "ERR_RENDER: DOM resource allocation failed")?;
                owned.extend_from_slice(bytes);
                Arc::new(owned)
            };
            // Register actual capacity as soon as this Arc exists. A later
            // resolver/validation error releases the partial candidate map
            // after unlocking; it must stay charged through that destruction.
            shared.track_response(&bytes);
            resources.insert(
                asset.sha256.clone(),
                EncodedAsset {
                    #[cfg(test)]
                    _drop_probe: shared.dom.resource_drop_probe.take(),
                    mime: asset.mime.clone(),
                    bytes,
                },
            );
            // Allocators may reserve more than the requested byte length.
            // Keep that actual owner in the outside-guard map on rejection.
            shared.ensure_frame_capacity(0, 0, 0)?;
        }
        retired._pending = shared.dom.pending.replace(CachedView {
            #[cfg(test)]
            _drop_probe: None,
            key,
            submission,
            resources,
        });
        drop(shared);
        drop(retired);
        Ok(())
    }
    pub fn confirm_view_presented(
        &self,
        key: &PresentationKey,
        input_enabled: bool,
    ) -> Result<(), String> {
        let mut retired = DomRetirement::default();
        let mut shared = self.shared.lock().map_err(|_| "Web surface unavailable")?;
        if shared
            .dom
            .pending
            .as_ref()
            .is_some_and(|pending| &pending.key == key)
        {
            let next = shared.dom.pending.take();
            retired._accepted = std::mem::replace(&mut shared.dom.accepted, next);
        } else if !shared
            .dom
            .accepted
            .as_ref()
            .is_some_and(|accepted| &accepted.key == key)
        {
            return Err("ERR_CANCELLED: no cached runtime submission for ACK".into());
        }
        shared.dom.input_enabled = input_enabled;
        let notification = json!({"key":key,"inputEnabled":input_enabled});
        shared.publish("view-presented".into(), notification);
        drop(shared);
        drop(retired);
        Ok(())
    }
    pub fn abort_view_submission(&self, key: &PresentationKey) {
        let mut retired = DomRetirement::default();
        if let Ok(mut shared) = self.shared.lock() {
            if shared
                .dom
                .pending
                .as_ref()
                .is_some_and(|pending| &pending.key == key)
            {
                retired._pending = shared.dom.pending.take();
            }
        }
        drop(retired);
    }
    /// Reconcile only against runtime-owned candidate identity. This is called
    /// after dispatch and before state publication, including failure paths.
    pub fn retain_browser_pending(&self, is_pending: impl FnOnce(&PresentationKey) -> bool) {
        let mut retired = DomRetirement::default();
        if let Ok(mut shared) = self.shared.lock() {
            if shared
                .dom
                .pending
                .as_ref()
                .is_some_and(|pending| !is_pending(&pending.key))
            {
                retired._pending = shared.dom.pending.take();
            }
        }
        drop(retired);
    }
    pub fn set_browser_input_enabled(&self, enabled: bool) {
        if let Ok(mut shared) = self.shared.lock() {
            shared.dom.input_enabled = enabled && shared.dom.accepted.is_some();
        }
    }
}

pub(super) fn decode_query(value: &str) -> Option<String> {
    if value.len() > 8192 {
        return None;
    }
    let mut result = Vec::new();
    let mut bytes = value.bytes();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let a = (bytes.next()? as char).to_digit(16)?;
            let b = (bytes.next()? as char).to_digit(16)?;
            result.push((a * 16 + b) as u8);
        } else if byte == b'+' {
            result.push(b' ');
        } else {
            result.push(byte);
        }
    }
    String::from_utf8(result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::{
        preview::{MAX_PREVIEWS, PREVIEW_LEASE},
        PreviewRequest, WebSurface, MAX_FRAME_CACHE_BYTES,
    };
    use std::time::{Duration, Instant};

    fn request(client: &str, op: &str, epoch: Option<&str>) -> PreviewRequest {
        PreviewRequest {
            version: "1.0".into(),
            request_id: format!("{client}-{op}"),
            client_id: client.into(),
            op: op.into(),
            epoch: epoch.map(str::to_owned),
        }
    }

    fn render(revision: &str) -> crate::BrowserRenderRequest {
        crate::BrowserRenderRequest {
            version: "1.0".into(),
            revision: revision.into(),
            render: json!({"templateId":"template:pages/home/index.wxml","useSessionResources":true,"styleIds":["style:app.wxss"],"viewport":{"x":0.0,"y":0.0,"width":375.0,"height":667.0}}),
        }
    }

    fn setup() -> (WebSurface, WebSurfaceHandle) {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.configure_browser_view();
        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        (surface, handle)
    }

    fn connected_streams(surface: &WebSurface) -> (std::net::TcpStream, std::net::TcpStream) {
        let client = std::net::TcpStream::connect(surface.local_addr()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match surface.listener.accept() {
                Ok((server, _)) => return (client, server),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(
                        Instant::now() < deadline,
                        "test connection was not accepted"
                    );
                    std::thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("test connection failed: {error}"),
            }
        }
    }

    fn connect(handle: &WebSurfaceHandle, client: &str) {
        let request = request(client, "connect", None);
        let retire = handle.preview_transfer_required(&request).unwrap();
        handle.commit_preview_request(&request, retire).unwrap();
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
    }

    #[test]
    fn final_presentation_control_checks_live_expiry_and_request_authority() {
        for expire in [false, true] {
            let (_surface, handle) = setup();
            connect(&handle, "owner");
            let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
            let control = handle
                .capture_presentation_control(&json!({
                    "preview":{"clientId":"owner","epoch":epoch,"requestRevision":"1"}
                }))
                .unwrap();
            if expire {
                handle
                    .shared
                    .lock()
                    .unwrap()
                    .preview
                    .clients
                    .get_mut("owner")
                    .unwrap()
                    .last_seen = Instant::now() - PREVIEW_LEASE - Duration::from_millis(1);
            } else {
                // Same preview epoch and no transport publication: a desired
                // DOM request alone still supersedes the captured authority.
                handle
                    .set_browser_view_request("session", &render("2"))
                    .unwrap();
            }
            let before = handle.presentation();
            let result = handle
                .prepare_presentation(json!({"revision":2}))
                .unwrap()
                .validate_control(&control);
            assert!(result.is_err());
            drop(result);
            assert_eq!(handle.presentation(), before);
        }
    }

    fn prepare(handle: &WebSurfaceHandle, client: &str) -> QueuedBridgeRequest {
        let shared = handle.shared.lock().unwrap();
        QueuedBridgeRequest::parse(&serde_json::to_vec(&json!({
            "sessionId":"session","op":"view.prepare",
            "preview":{"clientId":client,"epoch":shared.preview.epoch.to_string(),"requestRevision":shared.dom.request.as_ref().unwrap()["revision"]},
            "payload":{"surfaceGeneration":shared.dom.generation.to_string(),"render":shared.dom.request.as_ref().unwrap()["render"]}
        })).unwrap()).unwrap()
    }

    fn submission(
        handle: &WebSurfaceHandle,
        presentation: u64,
        bytes: &[u8],
    ) -> (PresentationKey, Value) {
        let shared = handle.shared.lock().unwrap();
        let key = PresentationKey {
            session_id: shared.dom.session_id.clone(),
            page_id: 1,
            document_revision: presentation,
            presentation_revision: presentation,
            surface_generation: shared.dom.generation,
            profile: RendererProfile::WebView,
        };
        let document = ViewDocument {
            version: "1.0".into(),
            session_id: key.session_id.clone(),
            page_id: 1,
            revision: presentation,
            route_path: "pages/home/index".into(),
            profile: RendererProfile::WebView,
            nodes: vec![],
            style_roots: vec![],
            styles: vec![],
            resources: vec![container_ir::Asset {
                path: "image.png".into(),
                sha256: container_ir::hex_digest(bytes),
                mime: "image/png".into(),
                size: bytes.len() as u64,
            }],
        };
        (
            key.clone(),
            json!({"version":"1.0","key":key,"viewport":{"width":375,"height":667},"document":document}),
        )
    }

    #[test]
    fn configured_capability_does_not_activate_unloaded_dom_mode() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.configure_browser_view();
        assert_eq!(
            handle.shared.lock().unwrap().state_value()["webRenderer"],
            "pending"
        );
        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        assert_eq!(
            handle.shared.lock().unwrap().state_value()["webRenderer"],
            "webview"
        );
    }

    #[test]
    fn primary_claim_reconnect_and_authority_publication_fence_queued_work() {
        let (_surface, handle) = setup();
        let first = request("first", "connect", None);
        assert!(handle.preview_transfer_required(&first).unwrap());
        assert!(handle.commit_preview_request(&first, false).is_err());
        handle.commit_preview_request(&first, true).unwrap();
        // Receipt precedes the owner-published request; old authority is inert.
        assert!(handle
            .validate_preview_request(&prepare(&handle, "first"))
            .is_err());
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        let queued = prepare(&handle, "first");
        handle.validate_preview_request(&queued).unwrap();
        connect(&handle, "mirror");
        assert!(handle
            .validate_preview_request(&prepare(&handle, "mirror"))
            .is_err());
        let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        let claim = request("mirror", "claim", Some(&epoch));
        assert!(handle.preview_transfer_required(&claim).unwrap());
        handle.commit_preview_request(&claim, true).unwrap();
        assert!(handle.validate_preview_request(&queued).is_err());
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        let reconnected = prepare(&handle, "mirror");
        let reconnect = request("mirror", "connect", None);
        assert!(handle.preview_transfer_required(&reconnect).unwrap());
        assert!(handle.commit_preview_request(&reconnect, false).is_err());
        handle.commit_preview_request(&reconnect, true).unwrap();
        assert!(handle.validate_preview_request(&reconnected).is_err());
        let inspector = QueuedBridgeRequest::parse(
            br#"{"op":"api.call","payload":{"name":"getSystemInfoSync"}}"#,
        )
        .unwrap();
        handle.validate_preview_request(&inspector).unwrap();
    }

    #[test]
    fn prepare_revision_is_immutable_and_distinguishes_identical_render_requests() {
        let (_surface, handle) = setup();
        connect(&handle, "first");
        let queued = prepare(&handle, "first");
        let mut mutated = render("1");
        mutated.render["viewport"]["width"] = 400.into();
        assert!(handle
            .set_browser_view_request("session", &mutated)
            .is_err());
        handle
            .set_browser_view_request("session", &render("2"))
            .unwrap();
        assert!(handle.validate_preview_request(&queued).is_err());
        handle
            .validate_preview_request(&prepare(&handle, "first"))
            .unwrap();
        assert!(handle
            .set_browser_view_request("session", &render("1"))
            .is_err());
    }

    #[test]
    fn browser_coordinate_roundtrip_preserves_render_authority_without_relaxing_other_fields() {
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        let original = prepare(&handle, "owner");
        let mut wire: Value = serde_json::from_slice(&original.body).unwrap();
        wire["payload"]["render"]["viewport"] = json!({"x":0,"y":0,"width":375,"height":667});
        assert_ne!(
            wire["payload"]["render"],
            render("1").render,
            "serde_json distinguishes float and integer storage"
        );
        let serialized = serde_json::to_vec(&wire).unwrap();
        handle
            .validate_preview_request(&QueuedBridgeRequest::parse(&serialized).unwrap())
            .unwrap();
        for (field, value) in [
            ("templateId", json!("template:other.wxml")),
            ("styleIds", json!([])),
            ("useSessionResources", json!(false)),
            ("extra", json!(true)),
        ] {
            let mut changed = wire.clone();
            changed["payload"]["render"][field] = value;
            assert!(
                handle
                    .validate_preview_request(
                        &QueuedBridgeRequest::parse(&serde_json::to_vec(&changed).unwrap())
                            .unwrap()
                    )
                    .is_err(),
                "{field} cannot change"
            );
        }
        for (field, value) in [
            ("x", json!(0.001)),
            ("width", json!(375.00000001)),
            ("height", json!("667")),
            ("extra", json!(0)),
        ] {
            let mut changed = wire.clone();
            changed["payload"]["render"]["viewport"][field] = value;
            assert!(
                handle
                    .validate_preview_request(
                        &QueuedBridgeRequest::parse(&serde_json::to_vec(&changed).unwrap())
                            .unwrap()
                    )
                    .is_err(),
                "viewport {field} cannot change"
            );
        }
        {
            let mut changed = wire.clone();
            changed["payload"]["surfaceGeneration"] = json!("999");
            assert!(handle
                .validate_preview_request(
                    &QueuedBridgeRequest::parse(&serde_json::to_vec(&changed).unwrap()).unwrap()
                )
                .is_err());
        }
        let mut changed = wire;
        changed["preview"]["requestRevision"] = json!("999");
        assert!(handle
            .validate_preview_request(
                &QueuedBridgeRequest::parse(&serde_json::to_vec(&changed).unwrap()).unwrap()
            )
            .is_err());
    }

    #[test]
    fn renderer_state_stays_pending_until_a_profile_or_actual_frame_exists() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.configure_browser_view();
        {
            let mut shared = handle.shared.lock().unwrap();
            shared
                .renderer_assets
                .insert("/renderer-assets/capability".into(), Arc::new(vec![1]));
            assert_eq!(
                shared.state_value()["webRenderer"],
                "pending",
                "installed CanvasKit capability cannot choose an auto route"
            );
        }
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        assert_eq!(handle.state()["webRenderer"], "canvaskit");
        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        assert_eq!(handle.state()["webRenderer"], "webview");
        let legacy = WebSurface::localhost(0).unwrap();
        assert_eq!(legacy.handle().state()["webRenderer"], "pending");
        legacy
            .handle()
            .set_snapshot(json!({"width":1,"height":1,"pixels":[0,0,0,255]}));
        assert_eq!(legacy.handle().state()["webRenderer"], "software");
    }

    #[test]
    fn owner_loop_expires_without_http_and_prunes_only_abandoned_mirrors() {
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        connect(&handle, "mirror");
        let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        {
            let mut shared = handle.shared.lock().unwrap();
            for client in shared.preview.clients.values_mut() {
                client.last_seen = Instant::now() - PREVIEW_LEASE - Duration::from_millis(1);
            }
        }
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].op, "expire");
        assert_eq!(
            handle.shared.lock().unwrap().preview.owner.as_deref(),
            Some("owner")
        );
        assert!(!handle
            .shared
            .lock()
            .unwrap()
            .preview
            .clients
            .contains_key("mirror"));
        assert!(handle
            .commit_preview_request(&request("owner", "heartbeat", Some(&epoch)), false)
            .is_err());
        assert!(handle.commit_preview_request(&requests[0], false).is_err());
        handle.commit_preview_request(&requests[0], true).unwrap();
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
        assert!(handle.take_preview_requests().is_empty());
    }

    #[test]
    fn presentation_mutation_requires_primary_and_revalidates_after_transfer() {
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        connect(&handle, "mirror");
        let owner = prepare(&handle, "owner").preview.unwrap();
        let mirror = prepare(&handle, "mirror").preview.unwrap();
        let value = json!({"revision":0,"preview":owner});
        handle.validate_presentation_owner(&value).unwrap();
        assert!(handle
            .validate_presentation_owner(&json!({"revision":0}))
            .is_err());
        assert!(handle
            .validate_presentation_owner(&json!({"preview":mirror}))
            .is_err());
        handle
            .commit_preview_request(&request("mirror", "claim", Some(&mirror.epoch)), true)
            .unwrap();
        assert!(handle.validate_presentation_owner(&value).is_err());
    }

    #[test]
    fn resources_require_exact_pending_or_accepted_key_and_verified_bytes() {
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        let bytes = b"original encoded png bytes";
        let hash = container_ir::hex_digest(bytes);
        let (first, document) = submission(&handle, 1, bytes);
        assert!(handle
            .publish_view_submission(document.clone(), |_| Ok(b"wrong"))
            .is_err());
        handle
            .publish_view_submission(document, |_| Ok(bytes))
            .unwrap();
        let (mime, retained) = handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&first, &hash)
            .unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(retained.as_slice(), bytes);
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&first, &"a".repeat(64))
            .is_none());
        let mut wrong = first.clone();
        wrong.presentation_revision += 1;
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&wrong, &hash)
            .is_none());
        handle.confirm_view_presented(&first, true).unwrap();
        let (second, document) = submission(&handle, 2, bytes);
        handle
            .publish_view_submission(document, |_| Ok(bytes))
            .unwrap();
        let second_bytes = handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&second, &hash)
            .unwrap()
            .1;
        assert!(Arc::ptr_eq(&retained, &second_bytes));
        handle.abort_view_submission(&second);
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&second, &hash)
            .is_none());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&first, &hash)
            .is_some());
        handle.clear_browser_view().unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&first, &hash)
            .is_none());
        assert_eq!(
            retained.as_slice(),
            bytes,
            "in-flight Arc survives cache retirement"
        );
    }

    #[test]
    fn revision_update_retains_runtime_candidate_and_session_change_retires_resources() {
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        let bytes = b"asset";
        let hash = container_ir::hex_digest(bytes);
        let (accepted, doc) = submission(&handle, 1, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        handle.confirm_view_presented(&accepted, true).unwrap();
        let (pending, doc) = submission(&handle, 2, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        handle
            .set_browser_view_request("session", &render("2"))
            .unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&accepted, &hash)
            .is_some());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&pending, &hash)
            .is_some());
        handle.retain_browser_pending(|key| key == &pending);
        handle.confirm_view_presented(&pending, true).unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&pending, &hash)
            .is_some());
        let (retired, doc) = submission(&handle, 3, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        handle.retain_browser_pending(|_| false);
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&retired, &hash)
            .is_none());
        assert!(
            handle
                .shared
                .lock()
                .unwrap()
                .dom
                .resource(&pending, &hash)
                .is_some(),
            "runtime revocation prunes pending only"
        );
        handle
            .set_browser_view_request("replacement", &render("1"))
            .unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&accepted, &hash)
            .is_none());
        assert!(handle.shared.lock().unwrap().dom.request.is_some());
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        assert!(handle.shared.lock().unwrap().dom.request.is_none());
    }

    #[test]
    fn retired_raw_bytes_remain_in_cache_budget_until_last_http_reference_drops() {
        let (_surface, handle) = setup();
        let bytes = b"in flight";
        let (key, doc) = submission(&handle, 1, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        let retained = handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&key, &container_ir::hex_digest(bytes))
            .unwrap()
            .1;
        handle.clear_browser_view().unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_err());
        drop(retained);
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_ok());
    }

    #[test]
    fn skia_to_dom_retires_large_cache_but_preserves_inflight_http_accounting() {
        use container_render_skia::{ImageResource, Rect, RenderFrame, RenderNode};

        for in_flight in [false, true] {
            let (mut surface, handle) = setup();
            handle.set_renderer_profile(RendererProfile::Skia).unwrap();
            let viewport = Rect {
                x: 0.0,
                y: 0.0,
                width: 375.0,
                height: 667.0,
            };
            handle
                .publish_render_frame(
                    "session",
                    1,
                    &RenderFrame {
                        frame_id: 7,
                        viewport,
                        root: RenderNode::new("page", viewport),
                        images: BTreeMap::from([(
                            "large-skia-image".into(),
                            Arc::new(ImageResource {
                                width: 4096,
                                height: 2560,
                                pixels: vec![127; 40 * 1024 * 1024],
                            }),
                        )]),
                    },
                    9,
                    0.0,
                )
                .unwrap();
            let receipt = json!({"sessionId":"session","renderRevision":9,
                "configGeneration":1,"backend":"canvaskit-webgl2","gpuSurface":true});
            handle.confirm_render_presented(&receipt).unwrap();
            let (old_resource, old_response, old_sequence) = {
                let mut shared = handle.shared.lock().unwrap();
                shared.render_presented.push_back(receipt.clone());
                let frame = shared.render_frame.as_ref().unwrap();
                (
                    Arc::downgrade(frame.resources.first_key_value().unwrap().1),
                    Arc::downgrade(&frame.response),
                    shared.next_transport_frame,
                )
            };
            let client = if in_flight {
                let (client, server) = connected_streams(&surface);
                surface
                    .queue_shared_response_bytes(&server, old_resource.upgrade().unwrap())
                    .unwrap();
                Some(client)
            } else {
                None
            };
            handle
                .set_renderer_profile(RendererProfile::WebView)
                .unwrap();
            handle
                .set_browser_view_request("session", &render("2"))
                .unwrap();
            assert!(old_response.upgrade().is_none());
            assert_eq!(old_resource.upgrade().is_some(), in_flight);
            assert!(handle.confirm_render_presented(&receipt).is_err());
            assert!(handle.take_render_presented().is_empty());
            {
                let shared = handle.shared.lock().unwrap();
                assert!(shared.render_frame.is_none());
                assert!(shared.confirmed_render_presented.is_none());
                assert!(shared.frame.is_none());
                assert!(shared.snapshot.is_none());
                assert_eq!(shared.next_transport_frame, old_sequence);
            }

            // Each encoded DOM resource stays below its 16 MiB bound. Their
            // combined 25 MiB exceeds 64 MiB only while the old 40 MiB HTTP
            // response still owns its bytes, never just because Skia was used.
            let first = vec![31; 13 * 1024 * 1024];
            let second = vec![47; 12 * 1024 * 1024];
            let (key, mut document) = submission(&handle, 2, &first);
            let first_hash = container_ir::hex_digest(&first);
            let second_hash = container_ir::hex_digest(&second);
            document["document"]["resources"]
                .as_array_mut()
                .unwrap()
                .push(json!({"path":"second.png","sha256":second_hash,
                    "mime":"image/png","size":second.len()}));
            let publish = || {
                handle.publish_view_submission(document.clone(), |hash| {
                    if hash == first_hash {
                        Ok(first.as_slice())
                    } else if hash == second_hash {
                        Ok(second.as_slice())
                    } else {
                        Err("unexpected resource".into())
                    }
                })
            };
            if in_flight {
                let error = publish().unwrap_err();
                assert!(error.contains("Web frame cache budget exceeded"));
                assert!(handle.shared.lock().unwrap().dom.pending.is_none());
                assert_eq!(surface.pending_responses.len(), 1);
                surface.pending_responses[0].queued_at =
                    Instant::now() - super::super::HTTP_DEADLINE - Duration::from_secs(1);
                surface.flush_responses();
                assert!(surface.pending_responses.is_empty());
                assert!(old_resource.upgrade().is_none());
            }
            publish().unwrap();
            handle.confirm_view_presented(&key, true).unwrap();
            assert!(handle.shared.lock().unwrap().dom.accepted.is_some());
            drop(client);
        }
    }

    #[test]
    fn direct_dom_request_retires_software_pixels() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        handle
            .publish_frame(
                "session",
                1,
                1.0,
                1.0,
                &container_render_skia::RenderSnapshot {
                    frame_id: 1,
                    width: 1,
                    height: 1,
                    stride: 4,
                    format: "rgba8".into(),
                    pixels: vec![10, 20, 30, 255],
                },
            )
            .unwrap();
        let old_frame = {
            let shared = handle.shared.lock().unwrap();
            assert!(shared.snapshot.is_none());
            Arc::downgrade(&shared.frame.as_ref().unwrap().response)
        };
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        assert!(old_frame.upgrade().is_none());
        let mut shared = handle.shared.lock().unwrap();
        assert!(shared.frame.is_none());
        assert!(shared.snapshot.is_none());
        shared
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .unwrap();
    }

    #[test]
    fn direct_dom_request_retires_legacy_snapshot() {
        let surface = WebSurface::localhost(0).unwrap();
        let handle = surface.handle();
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        handle.set_snapshot(json!({"width":1,"height":1,"pixels":[10,20,30,255]}));
        let old_snapshot = {
            let shared = handle.shared.lock().unwrap();
            assert!(shared.frame.is_none());
            Arc::downgrade(shared.snapshot.as_ref().unwrap())
        };
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        assert!(old_snapshot.upgrade().is_none());
        let mut shared = handle.shared.lock().unwrap();
        assert!(shared.snapshot.is_none());
        shared
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .unwrap();
    }

    #[test]
    fn query_decode_and_decimal_reject_ambiguous_wire_values() {
        assert_eq!(
            decode_query("%7B%22a%22%3A%221%22%7D").as_deref(),
            Some("{\"a\":\"1\"}")
        );
        for value in ["%", "%xz", "%ff"] {
            assert!(decode_query(value).is_none());
        }
        for value in ["", "01", "-1", "1.0", "18446744073709551616"] {
            assert!(decimal(value).is_err());
        }
        assert_eq!(decimal("18446744073709551615"), Ok(u64::MAX));
    }

    fn exchange(surface: &mut WebSurface, method: &str, path: &str, body: &[u8]) -> Vec<u8> {
        use std::io::{Read, Write};
        let address = surface.local_addr();
        let wire=[format!("{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",body.len()).as_bytes(),body].concat();
        let client = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(address).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream.write_all(&wire).unwrap();
            let mut response = Vec::new();
            stream.read_to_end(&mut response).unwrap();
            response
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while !client.is_finished() && Instant::now() < deadline {
            surface.poll().unwrap();
            std::thread::sleep(Duration::from_millis(1));
        }
        client.join().unwrap()
    }

    fn body(response: &[u8]) -> &[u8] {
        &response[super::super::find_bytes(response, b"\r\n\r\n").unwrap() + 4..]
    }

    fn resource_url(key: &PresentationKey, hash: &str) -> String {
        let encoded: String = serde_json::to_string(key)
            .unwrap()
            .bytes()
            .map(|byte| format!("%{byte:02X}"))
            .collect();
        format!("/api/view-resources/{hash}?key={encoded}")
    }

    #[test]
    fn preview_http_receipt_only_queues_and_bridge_http_checks_both_fences() {
        let (mut surface, handle) = setup();
        let connect_request = request("owner", "connect", None);
        let response = exchange(
            &mut surface,
            "POST",
            "/api/preview",
            &serde_json::to_vec(&connect_request).unwrap(),
        );
        assert!(response.starts_with(b"HTTP/1.1 202"));
        assert_eq!(
            serde_json::from_slice::<Value>(body(&response)).unwrap(),
            json!({"queued":true,"requestId":"owner-connect"})
        );
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        handle.commit_preview_request(&requests[0], true).unwrap();
        handle
            .set_browser_view_request("session", &render("1"))
            .unwrap();
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .events
            .iter()
            .any(|event| event.kind == "preview"));
        let queued = prepare(&handle, "owner");
        let accepted = exchange(&mut surface, "POST", "/api/bridge", &queued.body);
        assert!(accepted.starts_with(b"HTTP/1.1 200"));
        let work = handle.take_fenced_bridge_requests();
        assert_eq!(work.len(), 1);
        handle.validate_preview_request(&work[0]).unwrap();
        handle
            .set_browser_view_request("session", &render("2"))
            .unwrap();
        assert!(
            handle.validate_preview_request(&work[0]).is_err(),
            "owner rechecks work admitted before newer data"
        );
        let late = exchange(&mut surface, "POST", "/api/bridge", &queued.body);
        assert!(late.starts_with(b"HTTP/1.1 409"));
        handle
            .commit_preview_request(&request("mirror", "connect", None), false)
            .unwrap();
        let mirror = prepare(&handle, "mirror");
        assert!(exchange(&mut surface, "POST", "/api/bridge", &mirror.body)
            .starts_with(b"HTTP/1.1 409"));
        let presentation = json!({"revision":0,"preview":mirror.preview});
        assert!(exchange(
            &mut surface,
            "POST",
            "/api/presentation",
            &serde_json::to_vec(&presentation).unwrap()
        )
        .starts_with(b"HTTP/1.1 409"));
    }

    #[test]
    fn inactive_profile_releases_known_lease_only_on_owner_commit_and_returns_cleanly() {
        let (mut surface, handle) = setup();
        connect(&handle, "owner");
        let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        let release = request("owner", "release", Some(&epoch));
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        let response = exchange(
            &mut surface,
            "POST",
            "/api/preview",
            &serde_json::to_vec(&release).unwrap(),
        );
        assert!(response.starts_with(b"HTTP/1.1 202"));
        assert_eq!(
            handle.shared.lock().unwrap().preview.owner.as_deref(),
            Some("owner")
        );
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        assert!(handle.preview_transfer_required(&requests[0]).unwrap());
        assert!(handle.commit_preview_request(&requests[0], false).is_err());
        handle.commit_preview_request(&requests[0], true).unwrap();
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
        assert_eq!(handle.state()["webRenderer"], "software");
        assert!(!handle.preview_transfer_required(&release).unwrap());
        handle.commit_preview_request(&release, false).unwrap();

        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        connect(&handle, "next-owner");
        let new_epoch = handle.shared.lock().unwrap().preview.epoch;
        handle.commit_preview_request(&release, false).unwrap();
        let shared = handle.shared.lock().unwrap();
        assert_eq!(shared.preview.owner.as_deref(), Some("next-owner"));
        assert_eq!(shared.preview.epoch, new_epoch);
        assert!(shared.preview.clients.contains_key("next-owner"));
    }

    #[test]
    fn inactive_profile_expires_leases_and_old_release_cannot_revoke_reconnection() {
        let (mut surface, handle) = setup();
        connect(&handle, "owner");
        let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        let release = request("owner", "release", Some(&epoch));
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        handle
            .shared
            .lock()
            .unwrap()
            .preview
            .clients
            .get_mut("owner")
            .unwrap()
            .last_seen = Instant::now() - PREVIEW_LEASE - Duration::from_millis(1);
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].op, "expire");
        assert!(handle.preview_transfer_required(&requests[0]).unwrap());
        handle.commit_preview_request(&requests[0], true).unwrap();
        assert!(handle.shared.lock().unwrap().preview.owner.is_none());
        assert!(exchange(
            &mut surface,
            "POST",
            "/api/preview",
            &serde_json::to_vec(&release).unwrap()
        )
        .starts_with(b"HTTP/1.1 202"));
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        assert!(!handle.preview_transfer_required(&requests[0]).unwrap());
        handle.commit_preview_request(&requests[0], false).unwrap();

        handle
            .set_renderer_profile(RendererProfile::WebView)
            .unwrap();
        connect(&handle, "owner");
        let new_epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        assert_ne!(new_epoch, epoch);
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        handle.commit_preview_request(&release, false).unwrap();
        let mut shared = handle.shared.lock().unwrap();
        assert_eq!(shared.preview.owner.as_deref(), Some("owner"));
        assert_eq!(shared.preview.epoch.to_string(), new_epoch);
        assert!(shared.preview.clients.contains_key("owner"));
        for op in ["connect", "claim", "heartbeat"] {
            assert!(shared
                .queue_preview(request("owner", op, Some(&new_epoch)))
                .is_err());
        }
        assert!(shared
            .queue_preview(request("unknown", "release", Some(&new_epoch)))
            .is_err());
    }

    #[test]
    fn late_release_after_claim_is_noop_and_retired_history_is_bounded() {
        let (mut surface, handle) = setup();
        connect(&handle, "first");
        connect(&handle, "second");
        let old_epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
        handle
            .commit_preview_request(&request("second", "claim", Some(&old_epoch)), true)
            .unwrap();
        let new_epoch = handle.shared.lock().unwrap().preview.epoch;
        handle.set_renderer_profile(RendererProfile::Skia).unwrap();
        assert!(exchange(
            &mut surface,
            "POST",
            "/api/preview",
            &serde_json::to_vec(&request("first", "release", Some(&old_epoch))).unwrap()
        )
        .starts_with(b"HTTP/1.1 202"));
        let requests = handle.take_preview_requests();
        assert_eq!(requests.len(), 1);
        assert!(!handle.preview_transfer_required(&requests[0]).unwrap());
        handle.commit_preview_request(&requests[0], false).unwrap();
        let mut shared = handle.shared.lock().unwrap();
        assert_eq!(shared.preview.owner.as_deref(), Some("second"));
        assert_eq!(shared.preview.epoch, new_epoch);
        for index in 0..100 {
            shared
                .preview
                .remember_retired_lease(format!("retired-{index}"), index);
        }
        assert_eq!(shared.preview.retired_leases.len(), MAX_PREVIEWS * 2);
    }

    #[test]
    fn resource_http_returns_original_bytes_and_denies_retired_or_unknown_identity() {
        let (mut surface, handle) = setup();
        connect(&handle, "owner");
        let bytes = b"\x89PNG\r\n\x1a\n\0\xff\x80";
        let hash = container_ir::hex_digest(bytes);
        let (key, document) = submission(&handle, 1, bytes);
        handle
            .publish_view_submission(document, |_| Ok(bytes))
            .unwrap();
        let url = resource_url(&key, &hash);
        let response = exchange(&mut surface, "GET", &url, b"");
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert!(
            String::from_utf8_lossy(&response[..response.len() - bytes.len()])
                .contains("Content-Type: image/png\r\n")
        );
        assert_eq!(body(&response), bytes);
        let unknown = exchange(
            &mut surface,
            "GET",
            &resource_url(&key, &"b".repeat(64)),
            b"",
        );
        assert!(unknown.starts_with(b"HTTP/1.1 403"));
        handle.confirm_view_presented(&key, true).unwrap();
        assert!(exchange(&mut surface, "GET", &url, b"").starts_with(b"HTTP/1.1 200"));
        handle.clear_browser_view().unwrap();
        assert!(exchange(&mut surface, "GET", &url, b"").starts_with(b"HTTP/1.1 403"));
        assert!(exchange(&mut surface, "GET", "/api/snapshot", b"").starts_with(b"HTTP/1.1 409"));
        for path in ["/api/frame", "/api/render-frame"] {
            assert!(exchange(&mut surface, "GET", path, b"").starts_with(b"HTTP/1.1 404"));
        }
        for path in [
            "/dom-presenter.mjs",
            "/dom-session-client.mjs",
            "/remote-dom.mjs",
        ] {
            assert!(exchange(&mut surface, "GET", path, b"").starts_with(b"HTTP/1.1 200"));
        }
    }

    #[test]
    fn raw_http_response_shares_resource_and_deadline_releases_retired_bytes() {
        let (mut surface, handle) = setup();
        let bytes = b"encoded resource";
        let (key, doc) = submission(&handle, 1, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        let raw = handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&key, &container_ir::hex_digest(bytes))
            .unwrap()
            .1;
        let (_client, server) = connected_streams(&surface);
        surface
            .queue_shared_body(&server, 200, "image/png", Arc::clone(&raw))
            .unwrap();
        assert!(matches!(
            &surface.pending_responses[0].body,
            crate::web::ResponseBody::Shared(body) if Arc::ptr_eq(body, &raw)
        ));
        assert!(surface.pending_responses[0].header.is_some());
        handle.clear_browser_view().unwrap();
        drop(raw);
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_err());
        surface.pending_responses[0].queued_at =
            Instant::now() - super::super::HTTP_DEADLINE - Duration::from_secs(1);
        surface.flush_responses();
        assert!(surface.pending_responses.is_empty());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_ok());
    }

    #[test]
    fn conflicting_mime_metadata_fails_without_replacing_pending_resources() {
        let (_surface, handle) = setup();
        let bytes = b"image";
        let (first, doc) = submission(&handle, 1, bytes);
        handle.publish_view_submission(doc, |_| Ok(bytes)).unwrap();
        let (_, mut conflict) = submission(&handle, 2, bytes);
        let mut descriptor = conflict["document"]["resources"][0].clone();
        descriptor["path"] = json!("other.webp");
        descriptor["mime"] = json!("image/webp");
        conflict["document"]["resources"]
            .as_array_mut()
            .unwrap()
            .push(descriptor);
        assert!(handle
            .publish_view_submission(conflict, |_| Ok(bytes))
            .is_err());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .dom
            .resource(&first, &container_ir::hex_digest(bytes))
            .is_some());
    }

    fn install_drop_probes(
        handle: &WebSurfaceHandle,
        pending: bool,
        accepted: bool,
        request: bool,
        count: &Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::sync::atomic::Ordering;
        let mut shared = handle.shared.lock().unwrap();
        let dom = &mut shared.dom;
        for view in [
            pending.then_some(&mut dom.pending),
            accepted.then_some(&mut dom.accepted),
        ]
        .into_iter()
        .flatten()
        {
            let view = view.as_mut().expect("real published view");
            let resource = Arc::downgrade(&view.resources.first_key_value().unwrap().1.bytes);
            let owner = Arc::downgrade(&handle.shared);
            let count = Arc::clone(count);
            view._drop_probe = Some(DomDropProbe(Some(Box::new(move || {
                let owner = owner
                    .upgrade()
                    .expect("consumer still owns the Web surface");
                let mut shared = owner
                    .try_lock()
                    .expect("DOM payload destroyed under Shared lock");
                assert!(
                    resource.upgrade().is_some(),
                    "probe precedes actual resource release"
                );
                // The old DOM entry has moved out of Shared, but its actual
                // resource owner still lives and must remain in the old Weak
                // capacity ledger until this unlocked destruction finishes.
                assert!(shared
                    .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
                    .is_err());
                count.fetch_add(1, Ordering::SeqCst);
            }))));
        }
        if request {
            assert!(shared.dom.request.is_some());
            let owner = Arc::downgrade(&handle.shared);
            let count = Arc::clone(count);
            shared.dom.request_drop_probe = Some(DomDropProbe(Some(Box::new(move || {
                let owner = owner
                    .upgrade()
                    .expect("consumer still owns the Web surface");
                assert!(
                    owner.try_lock().is_ok(),
                    "DOM request destroyed under Shared lock"
                );
                count.fetch_add(1, Ordering::SeqCst);
            }))));
        }
    }

    fn populate_old_dom_owners(handle: &WebSurfaceHandle) -> (PresentationKey, PresentationKey) {
        let (first, document) = submission(handle, 1, b"old-accepted-resource");
        handle
            .publish_view_submission(document, |_| Ok(b"old-accepted-resource"))
            .unwrap();
        handle.confirm_view_presented(&first, true).unwrap();
        let (second, document) = submission(handle, 2, b"old-pending-resource");
        handle
            .publish_view_submission(document, |_| Ok(b"old-pending-resource"))
            .unwrap();
        (first, second)
    }

    #[test]
    fn actual_dom_consumers_release_replaced_payloads_and_requests_after_unlock() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for operation in [
            "clear", "profile", "session", "transfer", "request", "publish", "confirm", "abort",
            "retain",
        ] {
            let (_surface, handle) = setup();
            connect(&handle, "owner");
            let (_first, second) = populate_old_dom_owners(&handle);
            let count = Arc::new(AtomicUsize::new(0));
            let all = matches!(operation, "clear" | "profile" | "session");
            install_drop_probes(
                &handle,
                all || matches!(operation, "transfer" | "publish" | "abort" | "retain"),
                all || matches!(operation, "transfer" | "confirm"),
                all || operation == "request",
                &count,
            );
            match operation {
                "clear" => handle.clear_browser_view().unwrap(),
                "profile" => handle.set_renderer_profile(RendererProfile::Skia).unwrap(),
                "session" => handle
                    .set_browser_view_request("replacement", &render("1"))
                    .unwrap(),
                "transfer" => {
                    handle
                        .commit_preview_request(&request("mirror", "connect", None), false)
                        .unwrap();
                    let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
                    handle
                        .commit_preview_request(&request("mirror", "claim", Some(&epoch)), true)
                        .unwrap();
                    assert!(
                        handle.shared.lock().unwrap().dom.request.is_some(),
                        "lease transfer keeps the desired request but retires its authority"
                    );
                }
                "request" => handle
                    .set_browser_view_request("session", &render("2"))
                    .unwrap(),
                "publish" => {
                    let (_, document) = submission(&handle, 3, b"replacement-resource");
                    handle
                        .publish_view_submission(document, |_| Ok(b"replacement-resource"))
                        .unwrap();
                }
                "confirm" => handle.confirm_view_presented(&second, true).unwrap(),
                "abort" => handle.abort_view_submission(&second),
                "retain" => handle.retain_browser_pending(|_| false),
                _ => unreachable!(),
            }
            let expected = if all {
                3
            } else if operation == "transfer" {
                2
            } else {
                1
            };
            assert_eq!(count.load(Ordering::SeqCst), expected, "{operation}");
        }
    }

    #[test]
    fn actual_dom_clear_keeps_retired_bytes_charged_until_unlocked_resource_drop() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let (_surface, handle) = setup();
        connect(&handle, "owner");
        let bytes = b"last-charged-dom-resource";
        let (key, document) = submission(&handle, 1, bytes);
        handle
            .publish_view_submission(document, |_| Ok(bytes))
            .unwrap();
        handle.confirm_view_presented(&key, true).unwrap();
        let resource = {
            let shared = handle.shared.lock().unwrap();
            Arc::downgrade(
                &shared
                    .dom
                    .accepted
                    .as_ref()
                    .unwrap()
                    .resources
                    .first_key_value()
                    .unwrap()
                    .1
                    .bytes,
            )
        };
        let count = Arc::new(AtomicUsize::new(0));
        install_drop_probes(&handle, false, true, false, &count);
        handle.clear_browser_view().unwrap();
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(resource.upgrade().is_none());
        assert!(handle
            .shared
            .lock()
            .unwrap()
            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
            .is_ok());
    }

    #[test]
    fn rejected_dom_clear_and_replacement_preserve_actual_old_owners() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for operation in [
            "clear",
            "profile",
            "session",
            "transfer",
            "regression",
            "immutable",
            "invalid-resource",
        ] {
            let (_surface, handle) = setup();
            connect(&handle, "owner");
            let (_first, _second) = populate_old_dom_owners(&handle);
            if operation == "transfer" {
                handle
                    .commit_preview_request(&request("mirror", "connect", None), false)
                    .unwrap();
            }
            let (generation, previous_pending, previous_accepted, previous_request) = {
                let mut shared = handle.shared.lock().unwrap();
                let previous = (
                    shared.dom.generation,
                    shared.dom.pending.as_ref().unwrap().submission.clone(),
                    shared.dom.accepted.as_ref().unwrap().submission.clone(),
                    shared.dom.request.clone(),
                );
                if matches!(operation, "clear" | "profile" | "session" | "transfer") {
                    shared.dom.generation = u64::MAX;
                }
                previous
            };
            let count = Arc::new(AtomicUsize::new(0));
            install_drop_probes(&handle, true, true, true, &count);
            let result = match operation {
                "clear" => handle.clear_browser_view(),
                "profile" => handle.set_renderer_profile(RendererProfile::Skia),
                "session" => handle.set_browser_view_request("replacement", &render("1")),
                "transfer" => {
                    let epoch = handle.shared.lock().unwrap().preview.epoch.to_string();
                    handle
                        .commit_preview_request(&request("mirror", "claim", Some(&epoch)), true)
                        .map(|_| ())
                }
                "regression" => handle.set_browser_view_request("session", &render("0")),
                "immutable" => {
                    let mut changed = render("1");
                    changed.render["viewport"]["width"] = json!(400);
                    handle.set_browser_view_request("session", &changed)
                }
                "invalid-resource" => {
                    let (_, mut document) = submission(&handle, 3, b"valid-first-resource");
                    document["document"]["resources"].as_array_mut().unwrap().push(json!({
                        "path":"second.png", "sha256":container_ir::hex_digest(b"expected-second-resource"),
                        "mime":"image/png", "size":b"expected-second-resource".len(),
                    }));
                    let first = container_ir::hex_digest(b"valid-first-resource");
                    handle.publish_view_submission(document, |hash| {
                        if hash == first {
                            Ok(b"valid-first-resource".as_slice())
                        } else {
                            Ok(b"wrong-second-resource".as_slice())
                        }
                    })
                }
                _ => unreachable!(),
            };
            assert!(result.is_err(), "{operation}");
            assert_eq!(count.load(Ordering::SeqCst), 0, "{operation}");
            {
                let mut shared = handle.shared.lock().unwrap();
                assert_eq!(
                    shared.dom.pending.as_ref().unwrap().submission,
                    previous_pending
                );
                assert_eq!(
                    shared.dom.accepted.as_ref().unwrap().submission,
                    previous_accepted
                );
                assert_eq!(shared.dom.request, previous_request);
                assert!(shared.dom.input_enabled);
                assert_eq!(shared.dom.profile, Some(RendererProfile::WebView));
                shared.dom.generation = generation;
            }
            handle.clear_browser_view().unwrap();
            assert_eq!(count.load(Ordering::SeqCst), 3, "{operation} cleanup");
        }
    }

    #[test]
    fn failed_dom_candidate_stays_charged_until_actual_unlocked_destruction() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for failure in ["digest", "resolver"] {
            let (_surface, handle) = setup();
            connect(&handle, "owner");
            let first_bytes = b"failed-candidate-first-resource";
            let (_, mut document) = submission(&handle, 1, first_bytes);
            document["document"]["resources"].as_array_mut().unwrap().push(json!({
                "path":"second.png", "sha256":container_ir::hex_digest(b"expected-second-resource"),
                "mime":"image/png", "size":b"expected-second-resource".len(),
            }));
            let count = Arc::new(AtomicUsize::new(0));
            let observed = Arc::new(std::sync::Mutex::new(None));
            {
                let owner = Arc::downgrade(&handle.shared);
                let observed = Arc::clone(&observed);
                let count = Arc::clone(&count);
                handle.shared.lock().unwrap().dom.resource_drop_probe =
                    Some(DomDropProbe(Some(Box::new(move || {
                        let owner = owner.upgrade().expect("failed consumer still owns surface");
                        let mut shared = owner
                            .try_lock()
                            .expect("candidate destroyed under Shared lock");
                        assert!(shared.dom.pending.is_none());
                        assert!(shared.dom.accepted.is_none());
                        let entry = shared
                            .retained_response_bytes
                            .iter()
                            .find(|entry| entry.bytes.strong_count() > 0)
                            .expect("failed candidate remains charged in original Weak ledger");
                        assert_eq!(entry.bytes.upgrade().unwrap().as_slice(), first_bytes);
                        assert!(entry.length >= first_bytes.len());
                        *observed.lock().unwrap() = Some(entry.bytes.clone());
                        assert!(shared
                            .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
                            .is_err());
                        count.fetch_add(1, Ordering::SeqCst);
                    }))));
            }
            let first = container_ir::hex_digest(first_bytes);
            let result = handle.publish_view_submission(document, |hash| {
                if hash == first {
                    Ok(first_bytes.as_slice())
                } else if failure == "resolver" {
                    Err("ERR_INVALID_MANIFEST: fixture second resolver failure".into())
                } else {
                    Ok(b"wrong-second-resource".as_slice())
                }
            });
            assert!(result.is_err(), "{failure}");
            assert_eq!(count.load(Ordering::SeqCst), 1, "{failure}");
            assert!(observed
                .lock()
                .unwrap()
                .as_ref()
                .unwrap()
                .upgrade()
                .is_none());
            let mut shared = handle.shared.lock().unwrap();
            assert!(shared
                .ensure_frame_capacity(MAX_FRAME_CACHE_BYTES, 0, 0)
                .is_ok());
            assert!(shared.retained_response_bytes.is_empty());
        }
    }
}
