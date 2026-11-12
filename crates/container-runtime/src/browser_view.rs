//! Owner-thread DOM presentation transactions. No browser observation is a
//! replacement for the runtime's evaluated declarations or component owners.
use super::*;
use crate::view_topology::{ViewTopology, ViewTopologyNode};
use container_ir::{
    BrowserGeometryBatch, PresentationKey, RendererProfile, ViewDocument, ViewViewport,
    VIEW_PRESENTATION_VERSION,
};

#[path = "browser_live.rs"]
mod live;
pub use live::{BrowserDocumentPermit, BrowserLiveTransactionRetention, BrowserLiveViewSubmission};
use live::{LiveCandidate, LiveDocumentState};
#[path = "browser_animation.rs"]
mod animation;
#[path = "browser_dev_presentation.rs"]
mod development;
use development::{DevBrowserPresentation, DevBrowserRestoration};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserViewSubmission {
    pub version: String,
    pub key: PresentationKey,
    pub viewport: ViewViewport,
    pub document: ViewDocument,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation: Option<Value>,
}

/// Root page data actually consumed by one evaluated document, shared by
/// browser submissions and generated external frames. This local scheduling
/// snapshot is not a presentation permit or observation lease.
/// Explicit render data and detached development previews have no such proof.
#[derive(Clone, Debug, PartialEq)]
pub struct BrowserPageInput {
    pub page_id: PageId,
    pub route_path: String,
    pub template_revision: u64,
    pub viewport: Rect,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BrowserCommitPermit {
    pub version: String,
    pub key: PresentationKey,
    /// The browser geometry epoch is carried without a JavaScript Number cast.
    pub epoch: String,
    pub permit_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserEventBatch {
    version: String,
    key: PresentationKey,
    epoch: String,
    events: Vec<BrowserEvent>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserEvent {
    #[serde(rename = "type")]
    event_type: String,
    target_occurrence_id: String,
    #[serde(default)]
    detail: Value,
    #[serde(default)]
    time_stamp: Option<f64>,
    #[serde(default)]
    touches: Option<Vec<BrowserTouch>>,
    #[serde(default)]
    changed_touches: Option<Vec<BrowserTouch>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrowserTouch {
    identifier: i64,
    x: f64,
    y: f64,
    client_x: f64,
    client_y: f64,
    page_x: f64,
    page_y: f64,
}

impl BrowserEvent {
    fn validate_facts(&self) -> Result<(), BridgeError> {
        if self.time_stamp.is_some_and(|time| !time.is_finite()) {
            return Err(invalid("browser timeStamp must be finite"));
        }
        for touches in [&self.touches, &self.changed_touches].into_iter().flatten() {
            let mut identifiers = BTreeSet::new();
            if touches.len() > 1024
                || touches.iter().any(|touch| {
                    touch.identifier.unsigned_abs() > 9_007_199_254_740_991
                        || !identifiers.insert(touch.identifier)
                        || ![
                            touch.x,
                            touch.y,
                            touch.client_x,
                            touch.client_y,
                            touch.page_x,
                            touch.page_y,
                        ]
                        .iter()
                        .all(|number| number.is_finite())
                })
            {
                return Err(invalid("invalid browser touch facts"));
            }
        }
        Ok(())
    }

    /// Editing facts are host observations, never permission to bypass the
    /// evaluated native control state. Other element/event combinations retain
    /// their ordinary application detail contract.
    fn validate_text_control(&self, target: &ViewTopologyNode) -> Result<(), BridgeError> {
        if !matches!(target.tag.as_deref(), Some("input" | "textarea")) {
            return Ok(());
        }
        let disabled = match target.typed_attrs.get("disabled") {
            Some(Value::Null | Value::Bool(false)) => false,
            Some(Value::Bool(true)) => true,
            Some(Value::Number(value)) => value.as_f64() != Some(0.0),
            Some(Value::String(value)) => value != "false",
            Some(Value::Array(_) | Value::Object(_)) => {
                return Err(invalid("text control disabled attribute must be a scalar"));
            }
            None => target
                .attrs
                .get("disabled")
                .is_some_and(|value| value != "false"),
        };
        if disabled {
            return Err(invalid("disabled text control cannot emit browser events"));
        }
        if !matches!(
            self.event_type.as_str(),
            "input" | "focus" | "blur" | "confirm"
        ) {
            return Ok(());
        }
        let detail = self
            .detail
            .as_object()
            .ok_or_else(|| invalid("text control detail must be an object"))?;
        const FIELDS: &[&str] = &[
            "value",
            "cursor",
            "selectionStart",
            "selectionEnd",
            "x",
            "y",
            "pointerId",
            "scrollTop",
            "scrollLeft",
        ];
        if detail.keys().any(|field| !FIELDS.contains(&field.as_str())) {
            return Err(invalid("unknown text control detail field"));
        }
        let value = detail
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("text control value must be a string"))?;
        // A local transport budget, not a claim about the official maxlength
        // contract. It also bounds the UTF-16 position scan for every event.
        if value.len() > 64 * 1024 {
            return Err(invalid("text control value exceeds 64 KiB UTF-8 budget"));
        }
        let length = value.encode_utf16().count() as f64;
        for field in ["cursor", "selectionStart", "selectionEnd"] {
            if let Some(position) = detail.get(field) {
                let position = position.as_f64().ok_or_else(|| {
                    invalid(format!(
                        "text control {field} must be an integer UTF-16 offset"
                    ))
                })?;
                if !position.is_finite()
                    || position.fract() != 0.0
                    || position < 0.0
                    || position > length
                {
                    return Err(invalid(format!(
                        "text control {field} is outside the UTF-16 value"
                    )));
                }
            }
        }
        if let (Some(start), Some(end)) = (detail.get("selectionStart"), detail.get("selectionEnd"))
        {
            if start.as_f64() > end.as_f64() {
                return Err(invalid("text control selectionStart exceeds selectionEnd"));
            }
        }
        for field in ["x", "y", "scrollTop", "scrollLeft"] {
            if let Some(value) = detail.get(field) {
                if !value.as_f64().is_some_and(f64::is_finite) {
                    return Err(invalid(format!(
                        "legacy text control {field} must be finite"
                    )));
                }
            }
        }
        if let Some(pointer) = detail.get("pointerId").filter(|value| !value.is_null()) {
            if !pointer.as_f64().is_some_and(|value| {
                value.is_finite() && value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0
            }) {
                return Err(invalid(
                    "legacy text control pointerId must be a safe integer or null",
                ));
            }
        }
        Ok(())
    }
}

struct Candidate {
    submission: BrowserViewSubmission,
    page_input: Option<BrowserPageInput>,
    topology: ViewTopology,
    resources: RenderResources,
    geometry: Option<BrowserGeometryBatch>,
    permit: Option<BrowserCommitPermit>,
    live: Option<LiveCandidate>,
    animations: Option<PreparedAnimations>,
    animation_baseline: Option<Value>,
    development: Option<DevBrowserPresentation>,
}

struct Presented {
    submission: BrowserViewSubmission,
    page_input: Option<BrowserPageInput>,
    topology: ViewTopology,
    resources: RenderResources,
    geometry: BrowserGeometryBatch,
    permit: BrowserCommitPermit,
    // Native identities belong to the accepted document, never to a later
    // prepare or an application-writable scope table. V1 retains its existing
    // dispatch boundary; negotiated live documents always carry this proof.
    receiver_snapshot: Option<Arc<Value>>,
}

/// Captured only when a down event is consumed. Cancellation retains the
/// declaration snapshot rather than resolving a receiver against newer pixels.
#[derive(Clone)]
struct BrowserContact {
    key: PresentationKey,
    target: String,
    cancel_event: Value,
    scopes: BTreeSet<String>,
    latest: BrowserTouch,
    time_stamp: Option<f64>,
    receiver_snapshot: Option<Arc<Value>>,
}

struct ResolvedBrowserInput {
    event: Value,
    starts: Vec<BrowserContact>,
    updates: Vec<BrowserTouch>,
    ends: Vec<i64>,
    time_stamp: Option<f64>,
    ignored: bool,
}

#[derive(Default)]
pub(super) struct BrowserViewState {
    sequence: u64,
    generation: u64,
    pending: Option<Candidate>,
    presented: Option<Presented>,
    suspended: bool,
    retired_through: u64,
    contacts: BTreeMap<i64, BrowserContact>,
    retirement_messages: Vec<BridgeEnvelope>,
    live: LiveDocumentState,
    sample_pending: Option<animation::SampleCandidate>,
    sample_final: Option<animation::SampleFinal>,
    sample_aborted: Option<PresentationKey>,
    template_final: Option<BrowserCommitPermit>,
    template_aborted: Option<PresentationKey>,
    development: Option<DevBrowserPresentation>,
    development_abort: Option<DevBrowserRestoration>,
}

fn invalid(message: impl Into<String>) -> BridgeError {
    BridgeError::invalid(message)
}
fn stale(message: impl Into<String>) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

impl Session {
    pub(super) fn resolve_browser_host_component(
        &self,
        node_id: &str,
        event: &str,
    ) -> Result<host_services::NativeComponentTarget, BridgeError> {
        if !self.is_browser_view_presented() {
            return Err(stale("native component awaits browser presentation"));
        }
        let accepted = self
            .browser_view
            .presented
            .as_ref()
            .expect("presented browser component");
        let node = accepted
            .topology
            .node(node_id)
            .ok_or_else(|| invalid("unknown native component occurrence"))?;
        let tag = node
            .tag
            .clone()
            .ok_or_else(|| invalid("native component must be an element occurrence"))?;
        let mut attributes = node.attrs.clone();
        for name in node.typed_attrs.keys() {
            if let Some(value) = crate::view_topology::scalar_attribute(
                node_id,
                &node.attrs,
                &node.typed_attrs,
                name,
            )
            .map_err(|error| invalid(error.to_string()))?
            {
                attributes.insert(name.clone(), value);
            }
        }
        let input = BrowserEvent {
            event_type: event.into(),
            target_occurrence_id: node_id.into(),
            detail: Value::Null,
            time_stamp: None,
            touches: None,
            changed_touches: None,
        };
        let (event, _) =
            resolve_browser_event(&accepted.topology, &accepted.submission.key, &input)?;
        Ok(host_services::NativeComponentTarget {
            page_id: accepted.submission.key.page_id,
            node_id: node_id.into(),
            tag,
            attributes,
            route: host_services::NativeComponentRoute::Browser {
                key: accepted.submission.key.clone(),
                receiver: accepted
                    .receiver_snapshot
                    .as_ref()
                    .map(|value| value.as_ref().clone()),
                event,
            },
        })
    }

    pub(super) fn deliver_browser_host_component(
        &mut self,
        key: &PresentationKey,
        receiver: Option<&Value>,
        event: Value,
    ) -> Result<(), BridgeError> {
        if !self.is_browser_view_presented()
            || !self.browser_key_is_current(key)
            || self
                .browser_view
                .presented
                .as_ref()
                .is_none_or(|accepted| &accepted.submission.key != key)
        {
            return Ok(());
        }
        #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
        if self.engine_provider_available()
            && event["dispatches"]
                .as_array()
                .is_some_and(|dispatches| !dispatches.is_empty())
        {
            if let Some(receiver) = receiver {
                self.invoke_browser_receiver_event(
                    key.page_id,
                    receiver,
                    &event,
                    EventHandlerErrorPolicy::Report,
                )?;
            } else {
                self.invoke_page_event(self.event_page_registration_index(&event), event)?;
            }
        }
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = (receiver, event);
        self.view.record_event_batch(1);
        Ok(())
    }

    /// A listener task's microtasks can directly retire an instance as well.
    /// Verify with the private, checkpoint-free native capture before keeping
    /// the old document eligible for more input or a future editing grant.
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn verify_browser_event_receivers(
        &mut self,
        page_id: u64,
        expected: &Value,
    ) -> Result<(), BridgeError> {
        let scopes = expected
            .get("scopes")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("accepted native receiver snapshot omitted scopes"))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let verified = match self.live_receiver_snapshot(page_id, &scopes) {
            Ok(actual) if actual == *expected => Ok(()),
            Ok(_) => Err(stale("browser receiver changed during the event task")),
            Err(error) => Err(error),
        };
        if verified.is_err() {
            self.invalidate_browser_presentation();
        }
        verified
    }

    /// Retain the last image/resources for diagnostics, but revoke every
    /// outstanding authorization before changing page, manifest or layout.
    /// A cached page returning with the same PageId cannot revive an old key.
    pub(super) fn invalidate_browser_presentation(&mut self) {
        self.retire_browser_input_lifetime();
        self.invalidate_browser_candidate();
    }

    /// Retire the coordinate lifetime before a developer resize can run old
    /// contact cancellation. Keep those contacts/receiver until its normal
    /// settlement step; only the later candidate invalidation discards them.
    pub(super) fn retire_browser_input_lifetime(&mut self) {
        self.suspend_dev_raster_presentation();
        self.retire_browser_query_waiters("browser input lifetime was retired");
        self.input_lifetime_revision = self
            .input_lifetime_revision
            .and_then(|revision| revision.checked_add(1));
        if self.input_lifetime_revision.is_none() {
            if let Some((_, finals)) = self.browser_live_finals.as_mut() {
                finals.retire();
            }
        }
    }

    /// Revoke coordinate authority before installing a new host environment.
    /// Keep the old contact receiver until cancellation can observe the new
    /// snapshot, but make every previously issued permit unusable immediately.
    pub(super) fn suspend_browser_coordinate_authority(&mut self) {
        self.retire_browser_input_lifetime();
        self.browser_view.retired_through = self.browser_view.sequence;
        self.browser_view.suspended = true;
    }

    /// Pure preparation revokes old presentation authority without starting a
    /// new logical input lifetime. Advancing here would self-invalidate every
    /// ordinary DOM prepare and cause an endless scheduler rebuild loop.
    pub(super) fn invalidate_browser_candidate(&mut self) {
        self.browser_view.development = None;
        self.browser_view.development_abort = None;
        self.retire_browser_queries("browser presentation was retired");
        // These lifecycle/manifest/coordinate boundaries also retire retained
        // external-frame scheduling proof, without discarding diagnostic pixels.
        self.committed_frame_input = None;
        self.pending_native_animations = None;
        self.retained_animation_scene = None;
        self.committed_animation_sample = None;
        self.native_animation_attempt = None;
        // Emergency revocation must not retarget contacts after their graph
        // failed. Normal lifetime boundaries cancel before reaching here.
        if !self.browser_view.contacts.is_empty() {
            let ids = self
                .browser_view
                .contacts
                .keys()
                .copied()
                .collect::<Vec<_>>();
            self.browser_view.contacts.clear();
            let error =
                stale("browser contacts retired after their event receiver became unavailable");
            let diagnostic = self.error_envelope(&error, String::new(), op::ERROR);
            self.browser_view.retirement_messages.push(diagnostic);
            self.browser_view
                .retirement_messages
                .push(BridgeEnvelope::event(
                    self.config.session_id.clone(),
                    "view.contacts.retired",
                    json!({"identifiers":ids,"delivered":false}),
                ));
        }
        self.browser_view.retired_through = self.browser_view.sequence;
        if let Some(pending) = self.browser_view.pending.take() {
            self.browser_view.template_aborted = Some(pending.submission.key);
        }
        animation::retire_pending_sample(self);
        self.browser_view.suspended = true;
    }

    /// Pure hard lifetime token, including boundaries hidden inside one turn.
    /// A new Session starts at zero. Overflow never wraps or revives old keys.
    pub fn input_lifetime_revision(&self) -> Option<u64> {
        self.input_lifetime_revision
    }

    pub(super) fn invalidate_browser_page(&mut self, id: PageId) {
        let current = self
            .app_service
            .pages()
            .current()
            .is_some_and(|page| page.id == id);
        let owns_frame = self
            .committed_frame_input
            .as_ref()
            .is_some_and(|frame| frame.input.page_id == id);
        let owns_browser = self
            .browser_view
            .pending
            .as_ref()
            .is_some_and(|view| view.submission.key.page_id == id.0)
            || self
                .browser_view
                .presented
                .as_ref()
                .is_some_and(|view| view.submission.key.page_id == id.0);
        if current || owns_frame || owns_browser {
            self.invalidate_browser_presentation();
        }
    }
    /// APIs without a batch result retain diagnostics for the next owner
    /// bridge/timer/host observation, rather than silently discarding them.
    pub(super) fn append_browser_retirement_messages(
        &mut self,
        messages: &mut Vec<BridgeEnvelope>,
    ) {
        messages.append(&mut self.browser_view.retirement_messages);
    }

    pub(super) fn queue_browser_retirement_message(&mut self, message: BridgeEnvelope) {
        self.browser_view.retirement_messages.push(message);
    }

    pub(super) fn cancel_browser_contacts_for_page(
        &mut self,
        page: PageId,
        reason: &str,
    ) -> Result<(), BridgeError> {
        let ids = self
            .browser_view
            .contacts
            .iter()
            .filter_map(|(id, contact)| (contact.key.page_id == page.0).then_some(*id))
            .collect::<Vec<_>>();
        self.cancel_browser_contacts(&ids, reason)
    }

    pub(super) fn cancel_browser_contacts_for_scopes(
        &mut self,
        page: PageId,
        scopes: &BTreeSet<String>,
    ) -> Result<(), BridgeError> {
        let ids = self
            .browser_view
            .contacts
            .iter()
            .filter_map(|(id, contact)| {
                (contact.key.page_id == page.0 && !contact.scopes.is_disjoint(scopes))
                    .then_some(*id)
            })
            .collect::<Vec<_>>();
        self.cancel_browser_contacts(&ids, "component-disposed")
    }

    pub(super) fn cancel_all_browser_contacts(&mut self, reason: &str) -> Result<(), BridgeError> {
        self.cancel_all_browser_contacts_with_error_policy(reason, EventHandlerErrorPolicy::Report)
    }

    fn cancel_all_browser_contacts_with_error_policy(
        &mut self,
        reason: &str,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<(), BridgeError> {
        let ids = self
            .browser_view
            .contacts
            .keys()
            .copied()
            .collect::<Vec<_>>();
        self.cancel_browser_contacts_with_error_policy(&ids, reason, error_policy)
    }

    fn cancel_browser_contacts(&mut self, ids: &[i64], reason: &str) -> Result<(), BridgeError> {
        self.cancel_browser_contacts_with_error_policy(ids, reason, EventHandlerErrorPolicy::Report)
    }

    fn cancel_browser_contacts_with_error_policy(
        &mut self,
        ids: &[i64],
        reason: &str,
        error_policy: EventHandlerErrorPolicy,
    ) -> Result<(), BridgeError> {
        #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
        let _ = error_policy;
        // Consume every matching lease before arbitrary JS. Repeated hide,
        // queued navigation and late native terminal events cannot replay it.
        let contacts = ids
            .iter()
            .filter_map(|id| self.browser_view.contacts.remove(id))
            .collect::<Vec<_>>();
        let mut failure = None;
        for contact in contacts {
            let result = (|| {
                // A previous terminal handler can poison the realm. Leases
                // were consumed above; remaining contacts get diagnostics,
                // never another callback in the interrupted engine.
                self.ensure_engine_execution_healthy()?;
                // Native-held contacts may need their terminal cancellation
                // after coordinate permits are revoked. This does not grant
                // pointer input or permit ACKs: only the consumed private lease
                // and its still-current page/receiver can reach this path.
                if !self.browser_key_has_current_owner(&contact.key) {
                    return Err(stale(
                        "browser contact receiver was retired before cancellation",
                    ));
                }
                let mut event = contact.cancel_event;
                event["detail"] = json!({"reason":reason});
                for dispatch in event["dispatches"].as_array_mut().into_iter().flatten() {
                    dispatch["detail"] = json!({"reason":reason});
                }
                event["touches"] = json!(self
                    .browser_view
                    .contacts
                    .values()
                    .filter(|remaining| remaining.key == contact.key)
                    .map(|remaining| &remaining.latest)
                    .collect::<Vec<_>>());
                event["changedTouches"] = json!([contact.latest]);
                if let Some(time_stamp) = contact.time_stamp {
                    event["timeStamp"] = json!(time_stamp);
                }
                #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
                if self.engine_provider_available()
                    && event["dispatches"]
                        .as_array()
                        .is_some_and(|list| !list.is_empty())
                {
                    let page = self
                        .app_service
                        .pages()
                        .current()
                        .expect("validated browser contact page");
                    let index = self.page_registration_index_for_id(&page.path, page.id);
                    if let Some(expected) = &contact.receiver_snapshot {
                        self.invoke_browser_receiver_event(
                            contact.key.page_id,
                            expected,
                            &event,
                            error_policy,
                        )?;
                    } else {
                        self.invoke_page_event_with_error_policy(index, event, error_policy)?;
                    }
                }
                self.ensure_engine_execution_healthy()?;
                self.view.record_event_batch(1);
                Ok(())
            })();
            self.browser_view.retirement_messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(), "view.contacts.retired",
                json!({"key":contact.key,"identifiers":[contact.latest.identifier],"reason":reason,"delivered":result.is_ok()}),
            ));
            if let Err(error) = result {
                let diagnostic = self.error_envelope(&error, String::new(), op::ERROR);
                self.browser_view.retirement_messages.push(diagnostic);
                failure.get_or_insert(error);
            }
        }
        failure.map_or(Ok(()), Err)
    }

    /// Settle cancellation writes before lending mutable state or building a
    /// replacement. The consumed trace survives callback/continuation failure.
    pub(super) fn settle_browser_contact_retirement(
        &mut self,
        reason: &str,
    ) -> Result<(), BridgeError> {
        self.ensure_view_execution_healthy()?;
        self.ensure_engine_execution_healthy()?;
        if self.browser_view.contacts.is_empty() {
            return Ok(());
        }
        let cancelled = self.cancel_all_browser_contacts(reason);
        let mut messages = Vec::new();
        let effects = self
            .ensure_engine_execution_healthy()
            .and_then(|()| self.append_engine_effects(&mut messages));
        let stopped = messages.iter().any(effect_continuation_stopped);
        if let Err(error) = &effects {
            messages.push(self.error_envelope(error, String::new(), op::ERROR));
        }
        self.browser_view.retirement_messages.extend(messages);
        cancelled.and(effects)?;
        if stopped {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "browser contact retirement did not reach quiescence",
            ));
        }
        Ok(())
    }

    pub(super) fn retire_browser_contacts_before_host_mutation(&mut self, reason: &str) {
        // This API cannot return a callback error. Preserve it as a structured
        // owner diagnostic and settle writes before the host can replace state.
        if let Err(error) = self.settle_browser_contact_retirement(reason) {
            let diagnostic = self.error_envelope(&error, String::new(), op::ERROR);
            self.browser_view.retirement_messages.push(diagnostic);
        }
        self.invalidate_browser_presentation();
    }

    /// Retire a browser surface lease on the runtime owner thread. Contact
    /// cancellation can execute application code, so storage synchronization,
    /// effect draining and diagnostics belong to this boundary rather than an
    /// unrestricted mutable AppService borrow in a host adapter.
    pub fn retire_browser_preview(&mut self, reason: &str) -> Result<BridgeBatch, BridgeError> {
        // Revocation remains available after interruption, but synchronization
        // and terminal callbacks do not. Keep the trusted fault diagnostic.
        if let Err(error) = self
            .ensure_engine_execution_healthy()
            .and_then(|()| self.ensure_view_execution_healthy())
        {
            if self.view_execution_is_faulted() {
                self.retire_faulted_view_authority();
            } else {
                self.invalidate_browser_presentation();
            }
            let mut messages = vec![self.error_envelope(&error, String::new(), op::ERROR)];
            self.append_browser_retirement_messages(&mut messages);
            return Ok(BridgeBatch::new(messages));
        }
        self.with_engine_batch_turn(None, |session| {
            session.retire_browser_preview_within_turn(reason)
        })
    }

    /// Explicit developer owner-lane retirement across DOM and software/GPU
    /// input. The old browser-only API keeps its historical behavior. Pixels,
    /// page state, offsets and timers remain; no owner or new Session is made.
    /// A callback or outer completion failure is an Err, never a successful
    /// owner-retirement receipt. Already consumed effects stay in diagnostics.
    /// Legacy Raster keeps its historical automatic presentation policy;
    /// exact owner receipts require enable_dev_raster_presentation before init.
    pub fn retire_dev_preview(&mut self, reason: &str) -> Result<BridgeBatch, BridgeError> {
        self.retire_page_presenter(reason)
    }

    /// Retire one page presenter's DOM and Skia input on the runtime owner.
    /// The Session, page stack, storage and business timers remain alive.
    /// Contact cancellation may execute JS; callers must recheck the page and
    /// hard input lifetime after this complete turn before accepting a new
    /// presenter. Failure preserves committed effects in retirement diagnostics.
    /// This operation does not enable a development presentation policy.
    pub fn retire_page_presenter(&mut self, reason: &str) -> Result<BridgeBatch, BridgeError> {
        self.suspend_host_components();
        if self.view_execution_is_faulted() {
            self.retire_faulted_view_authority();
            let mut messages = Vec::new();
            self.append_browser_retirement_messages(&mut messages);
            return Ok(BridgeBatch::new(messages));
        }
        let retained_layout = self.current_skia_frame_authority().cloned();
        self.retire_browser_input_lifetime();
        // Retiring a presenter changes its input owner, not its coordinate
        // system. Carry only previously valid layout into the new lifetime;
        // presentation stays revoked until the next owner's exact ACK.
        self.carry_retained_skia_frame_authority(retained_layout);
        self.presented_revision = None;
        self.pending_presentation = None;
        self.observer_frame_valid = false;
        self.observer_observation_pending = false;
        let mut messages = Vec::new();
        let completion = self.with_engine_host_turn(None, |session| {
            if session.initialized && session.engine_provider_available() {
                session.sync_engine_storage()?;
            }
            // Consume every software contact and its scroll capture BEFORE
            // arbitrary JS can throw, navigate or schedule another turn.
            let ids = session.touch_contacts.keys().copied().collect::<Vec<_>>();
            let software = session.cancel_touch_ids_with_error_policy(
                &ids,
                reason,
                EventHandlerErrorPolicy::Propagate,
            );
            let browser = session.ensure_engine_execution_healthy().and_then(|()| {
                session.cancel_all_browser_contacts_with_error_policy(
                    reason,
                    EventHandlerErrorPolicy::Propagate,
                )
            });
            let effects = session
                .ensure_engine_execution_healthy()
                .and_then(|()| session.append_engine_effects(&mut messages));
            let stopped = messages.iter().any(effect_continuation_stopped);
            software.and(browser).and(effects)?;
            if stopped {
                return Err(BridgeError::new(
                    BridgeErrorCode::Timeout,
                    "developer preview retirement did not reach quiescence",
                ));
            }
            Ok(())
        });
        // Also run after a sticky engine fault/storage/outer-turn failure.
        // This pure cleanup cannot enter a faulted realm or retarget a contact.
        self.touch_contacts.clear();
        self.ended_touch_contacts.clear();
        self.scrolling.retire_touch_positions();
        self.invalidate_browser_candidate();
        // Hooks may have navigated/repainted. Revoke their obsolete owner proof
        // after effects settle as well; only a future accepted presentation can
        // restore authority for the next owner.
        self.suspend_dev_raster_presentation();
        self.committed_frame_input = None;
        self.presented_revision = None;
        self.pending_presentation = None;
        self.observer_frame_valid = false;
        self.observer_observation_pending = false;
        if let Err(error) = &completion {
            messages.push(self.error_envelope(error, String::new(), op::ERROR));
        }
        self.browser_view.retirement_messages.extend(messages);
        completion?;
        let mut messages = Vec::new();
        self.append_browser_retirement_messages(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    fn retire_browser_preview_within_turn(
        &mut self,
        reason: &str,
    ) -> Result<BridgeBatch, BridgeError> {
        let mut messages = Vec::new();
        if self.initialized && self.engine_provider_available() {
            if let Err(error) = self.sync_engine_storage() {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                self.invalidate_browser_presentation();
                self.append_browser_retirement_messages(&mut messages);
                return Ok(BridgeBatch::new(messages));
            }
        }
        self.retire_browser_contacts_before_host_mutation(reason);
        self.append_browser_retirement_messages(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    /// Stage an isolated presentation-only development pack without changing
    /// accepted metadata, component owners or browser input. The exact staged
    /// declaration/resource generation publishes only at its browser ACK.
    /// Host CSS, decoding and adapter failures can abort back to the accepted
    /// document when its owner, surface and input lifetime remain valid.
    pub fn replace_browser_dev_presentation(
        &mut self,
        candidate: &mut Session,
        payload: &Value,
    ) -> Result<BridgeBatch, BridgeError> {
        // Distribution admission precedes the engine turn and any candidate
        // graph refresh; rejection cannot consume live or candidate work.
        self.ensure_dev_presentation_allowed()?;
        let result = self.with_engine_batch_turn(None, |session| {
            session.replace_browser_dev_presentation_within_turn(candidate, payload)
        });
        self.retire_faulted_view_authority();
        result
    }

    fn replace_browser_dev_presentation_within_turn(
        &mut self,
        candidate: &mut Session,
        payload: &Value,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        if !self.config.browser_view_enabled || !self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "browser development replacement requires an active browser profile",
            ));
        }
        if !self
            .manifest
            .can_replace_presentation_with(&candidate.manifest)
            || self.config.engine != candidate.config.engine
            || self.config.renderer_override != candidate.config.renderer_override
        {
            return Err(invalid(
                "browser development replacement changes execution or configuration; restart the session",
            ));
        }
        // Pending completed component writes have immutable receipts. Refresh
        // only the candidate graph so rejected preflight cannot publish them.
        candidate.component_pages.clear();
        self.prepare_dev_component_snapshots(candidate)?;
        self.stage_dev_browser_presentation(candidate, payload)?;
        let mut messages = Vec::new();
        self.append_browser_retirement_messages(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    pub(super) fn browser_route_active(&self) -> bool {
        let profile = self
            .app_service
            .pages()
            .current()
            .map(|page| self.renderer_profile_for_route(&page.path))
            .or(self.config.renderer_override)
            .unwrap_or_else(|| {
                self.manifest
                    .rendering
                    .as_ref()
                    .map(|rendering| rendering.default)
                    .unwrap_or_default()
            });
        profile == RendererProfile::WebView
    }

    pub(super) fn browser_api_unavailable(&self, name: &str) -> bool {
        // Media queries use trusted host logical dimensions before any frame
        // exists. Geometry APIs still require browser query/observer/command
        // adapters; a previous Skia page cannot supply their DOM geometry.
        self.browser_route_active()
            && ((is_selector_query_api(name) && !self.browser_queries_enabled())
                || name == "wx.createIntersectionObserver"
                || name == "wx.pageScrollTo")
    }

    pub fn is_browser_view_presented(&self) -> bool {
        !self.engine_execution_is_faulted()
            && !self.view_execution_is_faulted()
            && !self.browser_view.suspended
            && self.browser_view.pending.is_none()
            && self.browser_view.sample_pending.is_none()
            && self
                .browser_view
                .presented
                .as_ref()
                .is_some_and(|accepted| self.browser_key_is_current(&accepted.submission.key))
    }

    pub(super) fn browser_query_snapshot(
        &self,
    ) -> Result<(&BrowserViewSubmission, &ViewTopology, &BrowserGeometryBatch), BridgeError> {
        if !self.is_browser_view_presented() {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "DOM query awaits a currently presented document",
            ));
        }
        let presented = self
            .browser_view
            .presented
            .as_ref()
            .expect("presented document checked");
        Ok((
            &presented.submission,
            &presented.topology,
            &presented.geometry,
        ))
    }

    /// Transport caches retain a prepared document until this owner retires
    /// or accepts it. A newer render request alone does not revoke a permit.
    pub fn is_browser_view_pending(&self, key: &PresentationKey) -> bool {
        self.browser_key_is_current(key)
            && self
                .browser_view
                .pending
                .as_ref()
                .is_some_and(|pending| &pending.submission.key == key)
    }

    /// Read input provenance for this exact live candidate/presentation.
    /// A newer data revision does not rewrite what an older document consumed.
    /// Callers must still use the normal permit/ACK path to authorize input;
    /// this snapshot alone does not prove a frame has been presented.
    pub fn browser_page_input(&self, key: &PresentationKey) -> Option<&BrowserPageInput> {
        if !self.browser_key_is_current(key) {
            return None;
        }
        if let Some(candidate) = self.browser_view.pending.as_ref() {
            return (&candidate.submission.key == key)
                .then_some(candidate.page_input.as_ref())
                .flatten();
        }
        if let Some(input) = animation::sample_page_input(self, key) {
            return Some(input);
        }
        self.browser_view
            .presented
            .as_ref()
            .filter(|presented| !self.browser_view.suspended && &presented.submission.key == key)
            .and_then(|presented| presented.page_input.as_ref())
    }

    fn browser_key_is_current(&self, key: &PresentationKey) -> bool {
        self.browser_key_has_current_owner(key)
            && key.presentation_revision > self.browser_view.retired_through
    }

    fn browser_key_has_current_owner(&self, key: &PresentationKey) -> bool {
        !self.engine_execution_is_faulted()
            && !self.view_execution_is_faulted()
            && !self.navigation_blocks_presentation()
            && self.config.browser_view_enabled
            && self.browser_route_active()
            && self.app_service.lifecycle().state() == container_core::LifecycleState::Active
            && key.session_id == self.config.session_id
            && key.profile == RendererProfile::WebView
            && key.surface_generation == self.browser_view.generation
            && self
                .app_service
                .pages()
                .current()
                .is_some_and(|page| page.id.0 == key.page_id)
    }

    /// Evaluate the actual AppService/View document without WXSS cascade,
    /// image decoding, Taffy, Skia page commit, rasterization or pixel readback.
    /// Component preparation may run hooks; a failed candidate therefore
    /// preserves an old *image*, never promises rollback of JavaScript state.
    pub fn prepare_browser_view(
        &mut self,
        payload: &Value,
        surface_generation: u64,
    ) -> Result<BrowserViewSubmission, BridgeError> {
        if self.browser_view.live.enabled {
            return Err(BridgeError::protocol(
                "live document session requires explicitly negotiated v2 operations",
            ));
        }
        let result = self.with_engine_host_turn(None, |session| {
            session.prepare_browser_view_within_turn(payload, surface_generation)
        });
        self.retire_faulted_view_authority();
        result
    }

    fn prepare_browser_view_within_turn(
        &mut self,
        payload: &Value,
        surface_generation: u64,
    ) -> Result<BrowserViewSubmission, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        self.ensure_initialized()?;
        if self.app_service.lifecycle().state() != container_core::LifecycleState::Active {
            return Err(stale("browser presentation requires an active application"));
        }
        if !self.config.browser_view_enabled || !self.browser_route_active() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "no browser presentation backend enabled for this page",
            ));
        }
        if surface_generation < self.browser_view.generation {
            return Err(stale("stale browser surface generation"));
        }
        if self.browser_view.development.is_some() {
            return self.prepare_staged_dev_browser_view(payload, surface_generation);
        }
        let input = self.load_manifest_view_input(object_payload(payload)?, None)?;
        let page = self
            .app_service
            .pages()
            .current()
            .ok_or_else(|| invalid("browser presentation requires an active page"))?;
        if page.path != input.render.route_path {
            return Err(stale("browser template does not belong to the active page"));
        }
        if page.id.0 > 9_007_199_254_740_991 || input.render.frame_id > 9_007_199_254_740_991 {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "ViewDocument v1 identity exceeds the browser exact integer range",
            ));
        }
        let previous_page = page.id;
        let input_lifetime = self.input_lifetime_revision;
        let had_contacts = !self.browser_view.contacts.is_empty();
        // Evaluation can dispose scopes before a candidate is committed. End
        // old gestures now; a failed candidate retains only the old picture.
        self.browser_view.suspended = true;
        let retirement = self.settle_browser_contact_retirement("view-rebuilt");
        self.invalidate_browser_candidate();
        retirement?;
        if self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || self.app_service.pages().current().map(|page| page.id) != Some(previous_page)
            || self.input_lifetime_revision != input_lifetime
        {
            return Err(stale("page changed during browser contact cancellation"));
        }
        let input = if had_contacts {
            self.load_manifest_view_input(object_payload(payload)?, None)?
        } else {
            input
        };
        let sequence = self
            .browser_view
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("presentation revision exhausted"))?;
        // From this point component preparation can invalidate an older event
        // graph even if it later fails. Suspend input before executing hooks.
        self.browser_view.suspended = true;
        self.browser_view.pending = None;
        let prepared = self.evaluate_manifest_view_input(input, None)?;
        self.ensure_engine_execution_healthy()?;
        if self.input_lifetime_revision != input_lifetime {
            return Err(stale(
                "logical input lifetime changed during View preparation",
            ));
        }
        let topology = ViewTopology::from_document(&prepared.document)
            .map_err(|error| invalid(error.to_string()))?;
        let key = PresentationKey {
            session_id: self.config.session_id.clone(),
            page_id: prepared.document.page_id,
            document_revision: prepared.document.revision,
            presentation_revision: sequence,
            surface_generation,
            profile: RendererProfile::WebView,
        };
        key.validate().map_err(|error| invalid(error.to_string()))?;
        let viewport = ViewViewport {
            width: f64::from(prepared.input.viewport.width),
            height: f64::from(prepared.input.viewport.height),
        };
        let animation_metadata = animation::submission_metadata(&prepared.animations, sequence)?;
        if self.browser_view.live.enabled && animation_metadata.is_some() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "numeric animation currently requires the v1 browser sample presentation lane",
            ));
        }
        let submission = BrowserViewSubmission {
            version: VIEW_PRESENTATION_VERSION.into(),
            key,
            viewport,
            document: prepared.document,
            animation: animation_metadata,
        };
        self.browser_view.sequence = sequence;
        self.browser_view.generation = surface_generation;
        self.browser_view.pending = Some(Candidate {
            submission: submission.clone(),
            page_input: prepared.input.page_input,
            topology,
            resources: prepared.input.resources,
            geometry: None,
            permit: None,
            live: None,
            animations: prepared.animations,
            animation_baseline: None,
            development: None,
        });
        Ok(submission)
    }

    /// The host sends geometry while its candidate is hidden. Acceptance of
    /// this batch grants a commit permit; it does not run ready or accept input.
    pub fn prepare_browser_commit(
        &mut self,
        geometry: BrowserGeometryBatch,
    ) -> Result<BrowserCommitPermit, BridgeError> {
        self.with_engine_host_turn(None, |session| {
            session.prepare_browser_commit_within_turn(geometry)
        })
    }

    fn prepare_browser_commit_within_turn(
        &mut self,
        geometry: BrowserGeometryBatch,
    ) -> Result<BrowserCommitPermit, BridgeError> {
        if self.browser_view.live.enabled {
            return Err(BridgeError::protocol(
                "v1 geometry permits cannot authorize a live document",
            ));
        }
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        geometry
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        if !self.browser_key_is_current(&geometry.key) {
            return Err(stale(
                "browser candidate belongs to a retired page or surface",
            ));
        }
        animation::validate_template_animations(self, &geometry)?;
        let prepared = self
            .browser_view
            .pending
            .as_ref()
            .ok_or_else(|| stale("no pending browser candidate"))?;
        validate_geometry(&prepared.submission, &prepared.topology, &geometry)?;
        self.prepare_dev_browser_permit()?;
        let pending = self
            .browser_view
            .pending
            .as_mut()
            .ok_or_else(|| stale("no pending browser candidate"))?;
        validate_geometry(&pending.submission, &pending.topology, &geometry)?;
        if let Some(old) = &pending.geometry {
            if old != &geometry {
                return Err(stale(
                    "prepared browser geometry cannot change under a commit permit",
                ));
            }
            return Ok(pending
                .permit
                .clone()
                .expect("prepared geometry has permit"));
        }
        let permit = BrowserCommitPermit {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: geometry.key.clone(),
            epoch: geometry.epoch.to_string(),
            permit_id: format!(
                "view:{}:{}",
                geometry.key.presentation_revision, geometry.key.surface_generation
            ),
        };
        pending.geometry = Some(geometry);
        pending.permit = Some(permit.clone());
        Ok(permit)
    }

    /// Called only after the browser has made the permitted candidate visible.
    /// The caller confirms the browser transaction after receiving this result.
    /// Repeated ACKs return the same accepted identity without repeating hooks.
    pub fn acknowledge_browser_presentation(
        &mut self,
        permit: &BrowserCommitPermit,
    ) -> Result<BridgeBatch, BridgeError> {
        if self.browser_view.live.enabled || permit.version != VIEW_PRESENTATION_VERSION {
            return Err(BridgeError::protocol(
                "v1 ACK cannot accept a live document permit",
            ));
        }
        self.with_engine_batch_turn(None, |session| {
            session.acknowledge_browser_presentation_within_turn(permit)
        })
    }

    fn acknowledge_browser_presentation_within_turn(
        &mut self,
        permit: &BrowserCommitPermit,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        if !self.browser_key_is_current(&permit.key) {
            return Err(stale(
                "browser presentation belongs to a retired page or surface",
            ));
        }
        if self.browser_view.pending.is_none()
            && !self.browser_view.suspended
            && self
                .browser_view
                .presented
                .as_ref()
                .is_some_and(|accepted| &accepted.permit == permit)
        {
            return Ok(BridgeBatch::new(vec![]));
        }
        let pending = self
            .browser_view
            .pending
            .as_ref()
            .ok_or_else(|| stale("no permitted browser presentation"))?;
        if pending.permit.as_ref() != Some(permit) {
            return Err(stale("browser presentation permit mismatch"));
        }
        if let Some(animations) = pending.animations.as_ref() {
            self.validate_prepared_animations(animations)?;
        }
        let component_indexes = self.prepare_dev_browser_publication()?;
        let pending = self
            .browser_view
            .pending
            .take()
            .expect("validated candidate");
        if let Some(development) = pending.development {
            self.publish_dev_browser_presentation(development);
        }
        if let Some(animations) = pending.animations {
            self.accept_prepared_animations(animations);
        } else if pending.page_input.is_none() {
            self.animation_bindings
                .retire_page_topology(permit.key.page_id);
            self.animation_playback
                .retire_page_topology(permit.key.page_id);
        }
        self.browser_view.template_final = Some(permit.clone());
        let frame_id = pending.submission.document.revision;
        self.accepted_view_document = Some(pending.submission.document.clone());
        self.render_blobs = Arc::clone(&pending.resources);
        self.render_resources_verified = true;
        self.view.last_frame_id = Some(frame_id);
        self.observer_frame_page = Some(PageId(permit.key.page_id));
        self.observer_frame_valid = false; // Browser geometry is a separate store.
        self.browser_view.presented = Some(Presented {
            submission: pending.submission,
            page_input: pending.page_input,
            topology: pending.topology,
            resources: pending.resources,
            geometry: pending.geometry.expect("permit owns geometry"),
            permit: permit.clone(),
            receiver_snapshot: pending.live.map(|live| Arc::new(live.receiver_snapshot)),
        });
        self.browser_view.suspended = false;
        // Publication is irreversible even if a ready hook throws or navigates.
        // The result contains committed diagnostics; never roll this key back.
        let request = BridgeEnvelope::event(
            self.config.session_id.clone(),
            "view.presented",
            json!({"key":permit.key}),
        );
        let mut messages = vec![];
        if let Err(error) = self.commit_dev_component_indexes(component_indexes) {
            messages.push(self.render_commit_diagnostic(
                &request,
                frame_id,
                "component metadata",
                &error,
            ));
        }
        if let Err(error) = self.ready_page_components() {
            messages.push(self.render_commit_diagnostic(&request, frame_id, "ready", &error));
        }
        let effects = self
            .ensure_engine_execution_healthy()
            .and_then(|()| self.append_engine_effects(&mut messages));
        if let Err(error) = effects {
            messages.push(self.render_commit_diagnostic(&request, frame_id, "effects", &error));
        }
        self.append_browser_retirement_messages(&mut messages);
        Ok(BridgeBatch::new(messages))
    }

    pub fn abort_browser_view(&mut self, key: &PresentationKey) -> Result<(), BridgeError> {
        if self.browser_view.live.enabled {
            return Err(BridgeError::protocol(
                "v1 abort cannot retire a live document transaction",
            ));
        }
        self.abort_browser_candidate(key)
    }

    fn abort_browser_candidate(&mut self, key: &PresentationKey) -> Result<(), BridgeError> {
        if self.browser_view.template_aborted.as_ref() == Some(key) {
            return Ok(());
        }
        if self
            .browser_view
            .pending
            .as_ref()
            .is_none_or(|pending| &pending.submission.key != key)
        {
            return Err(stale("browser abort does not own the pending candidate"));
        }
        let restore = self.dev_browser_abort_restoration();
        self.browser_view.template_aborted = Some(key.clone());
        self.browser_view.pending = None;
        self.browser_view.development = None;
        self.browser_view.suspended = restore.is_none();
        self.browser_view.development_abort = restore;
        Ok(())
    }

    fn settle_browser_view(&mut self, key: &PresentationKey) -> Result<Value, BridgeError> {
        if let Some(permit) = &self.browser_view.template_final {
            if &permit.key == key {
                return Ok(
                    json!({"ok":true,"version":VIEW_PRESENTATION_VERSION,"key":key,
                    "aborted":false,"presented":true,"permit":permit,"inputEnabled":false}),
                );
            }
        }
        self.abort_browser_view(key)?;
        let mut result =
            json!({"ok":true,"version":VIEW_PRESENTATION_VERSION,"key":key,"aborted":true});
        self.append_dev_browser_restoration(&mut result);
        Ok(result)
    }

    /// Native DOM scrolling/editing updates geometry without evaluating View
    /// functions, performing Rust layout or changing document identity.
    pub fn update_browser_geometry(
        &mut self,
        geometry: BrowserGeometryBatch,
    ) -> Result<(), BridgeError> {
        geometry
            .validate()
            .map_err(|error| invalid(error.to_string()))?;
        if !self.is_browser_view_presented() {
            return Err(stale("browser geometry awaits presentation"));
        }
        let accepted = self
            .browser_view
            .presented
            .as_mut()
            .expect("presented view");
        validate_geometry(&accepted.submission, &accepted.topology, &geometry)?;
        if geometry.epoch < accepted.geometry.epoch
            || (geometry.epoch == accepted.geometry.epoch && geometry != accepted.geometry)
        {
            return Err(stale("stale browser geometry epoch"));
        }
        accepted.geometry = geometry;
        Ok(())
    }

    pub fn browser_geometry(&self) -> Option<&BrowserGeometryBatch> {
        self.is_browser_view_presented().then(|| {
            &self
                .browser_view
                .presented
                .as_ref()
                .expect("presented view")
                .geometry
        })
    }

    /// Raw content-addressed application bytes, independently transferred and
    /// hash-verified by the host. Internal executable/style blobs are not made
    /// browser-fetchable merely because their hashes happen to be known.
    pub fn browser_view_resource(
        &self,
        key: &PresentationKey,
        sha256: &str,
    ) -> Result<&[u8], BridgeError> {
        if !self.browser_key_is_current(key) {
            return Err(stale(
                "resource request belongs to a retired browser surface",
            ));
        }
        let (submission, resources) = if let Some(pending) = self
            .browser_view
            .pending
            .as_ref()
            .filter(|p| &p.submission.key == key)
        {
            (&pending.submission, &pending.resources)
        } else if let Some(accepted) = self
            .browser_view
            .presented
            .as_ref()
            .filter(|p| &p.submission.key == key)
        {
            (&accepted.submission, &accepted.resources)
        } else {
            return Err(stale("resource request does not own a retained view"));
        };
        if !submission.document.resources.iter().any(|asset| {
            asset.sha256 == sha256
                && container_core::BufferUrlStore::resource_url(&asset.path).is_none()
        }) {
            return Err(invalid("resource is not declared by this View document"));
        }
        resources
            .get(&format!("sha256:{sha256}"))
            .map(Vec::as_slice)
            .ok_or_else(|| invalid("declared View resource bytes are missing"))
    }

    /// One batch of real DOM facts. Handler/path/owner/dataset fields are not
    /// accepted on the wire and cannot grant authority to invoke JavaScript.
    pub fn dispatch_browser_events(&mut self, payload: Value) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.dispatch_browser_events_within_turn(payload)
        })
    }

    fn dispatch_browser_events_within_turn(
        &mut self,
        payload: Value,
    ) -> Result<BridgeBatch, BridgeError> {
        self.ensure_engine_execution_healthy()?;
        let batch: BrowserEventBatch = serde_json::from_value(payload)
            .map_err(|error| invalid(format!("invalid browser input: {error}")))?;
        if batch.version != VIEW_PRESENTATION_VERSION || batch.events.len() > 256 {
            return Err(invalid("invalid browser input version or batch budget"));
        }
        if !self.is_browser_view_presented() {
            return Err(stale("browser input awaits presentation"));
        }
        let accepted = self
            .browser_view
            .presented
            .as_ref()
            .expect("presented view");
        if batch.key != accepted.submission.key
            || batch.epoch != accepted.geometry.epoch.to_string()
        {
            return Err(stale("browser input does not match accepted geometry"));
        }
        let receiver_snapshot = accepted.receiver_snapshot.clone();
        if self.browser_view.live.enabled && receiver_snapshot.is_none() {
            return Err(stale(
                "live browser input has no accepted receiver identity",
            ));
        }
        // Validate the entire contact sequence without consuming ownership.
        // A navigation caused by event one must not pre-register event two.
        let mut simulated = self
            .browser_view
            .contacts
            .iter()
            .map(|(id, contact)| (*id, contact.target.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut resolved = Vec::with_capacity(batch.events.len());
        for event in batch.events {
            event.validate_facts()?;
            let (value, scopes) = resolve_browser_event(&accepted.topology, &batch.key, &event)?;
            let target = value["target"]
                .as_str()
                .expect("resolved target")
                .to_owned();
            let mut input = ResolvedBrowserInput {
                event: value,
                starts: vec![],
                updates: vec![],
                ends: vec![],
                time_stamp: event.time_stamp,
                ignored: false,
            };
            if matches!(
                event.event_type.as_str(),
                "touchstart" | "touchmove" | "touchend" | "touchcancel"
            ) {
                let changed = event
                    .changed_touches
                    .as_ref()
                    .filter(|touches| !touches.is_empty())
                    .ok_or_else(|| {
                        invalid("browser touch events require nonempty changedTouches")
                    })?;
                let touches = event
                    .touches
                    .as_ref()
                    .ok_or_else(|| invalid("browser touch events require touches"))?;
                if event.event_type == "touchstart" {
                    let cancel = BrowserEvent {
                        event_type: "touchcancel".into(),
                        target_occurrence_id: target.clone(),
                        detail: Value::Null,
                        time_stamp: event.time_stamp,
                        touches: None,
                        changed_touches: None,
                    };
                    let (cancel_event, _) =
                        resolve_browser_event(&accepted.topology, &batch.key, &cancel)?;
                    for touch in changed {
                        if simulated.insert(touch.identifier, target.clone()).is_some() {
                            return Err(invalid("duplicate active browser contact"));
                        }
                        input.starts.push(BrowserContact {
                            key: batch.key.clone(),
                            target: target.clone(),
                            cancel_event: cancel_event.clone(),
                            scopes: scopes.clone(),
                            latest: touch.clone(),
                            time_stamp: event.time_stamp,
                            receiver_snapshot: receiver_snapshot.clone(),
                        });
                    }
                    if simulated.len() > 1024 {
                        return Err(invalid("active browser contact budget exceeded"));
                    }
                } else {
                    let known = changed
                        .iter()
                        .filter(|touch| simulated.contains_key(&touch.identifier))
                        .count();
                    if known == 0 {
                        input.ignored = true;
                    } else if known != changed.len() {
                        return Err(invalid("mixed known and retired browser contacts"));
                    } else {
                        for touch in changed {
                            if simulated.get(&touch.identifier) != Some(&target) {
                                return Err(invalid(
                                    "browser contact cannot change its captured target",
                                ));
                            }
                            if matches!(event.event_type.as_str(), "touchend" | "touchcancel") {
                                simulated.remove(&touch.identifier);
                                input.ends.push(touch.identifier);
                            }
                        }
                    }
                }
                if !input.ignored {
                    let observed = touches
                        .iter()
                        .map(|touch| touch.identifier)
                        .collect::<BTreeSet<_>>();
                    if observed != simulated.keys().copied().collect() {
                        return Err(invalid(
                            "browser touches do not match active contact ownership",
                        ));
                    }
                    input.updates.extend(touches.iter().cloned());
                    input.updates.extend(changed.iter().cloned());
                }
            }
            resolved.push(input);
        }
        if self.engine_provider_available() {
            self.sync_engine_storage()?;
        }
        let mut messages = Vec::new();
        let mut consumed = 0usize;
        for input in &resolved {
            if let Err(error) = self.ensure_engine_execution_healthy() {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                break;
            }
            if !self.browser_key_is_current(&batch.key) {
                messages.push(self.error_envelope(
                    &stale("browser event batch page changed during dispatch"),
                    String::new(),
                    op::ERROR,
                ));
                break;
            }
            if input.ignored {
                continue;
            }
            for contact in &input.starts {
                self.browser_view
                    .contacts
                    .insert(contact.latest.identifier, contact.clone());
            }
            for touch in &input.updates {
                if let Some(contact) = self.browser_view.contacts.get_mut(&touch.identifier) {
                    contact.latest = touch.clone();
                    contact.time_stamp = input.time_stamp;
                }
            }
            // Terminal callbacks may navigate, hide or rebuild. Remove their
            // leases first so those paths never synthesize a second terminal.
            for id in &input.ends {
                self.browser_view.contacts.remove(id);
            }
            let event = &input.event;
            let callback_result: Result<(), BridgeError> = {
                #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
                {
                    if event["dispatches"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty())
                        && self.engine_provider_available()
                    {
                        if let Some(expected) = &receiver_snapshot {
                            self.invoke_browser_receiver_event(
                                batch.key.page_id,
                                expected,
                                event,
                                EventHandlerErrorPolicy::Report,
                            )
                            .map(|_| ())
                        } else {
                            self.invoke_page_event(
                                self.event_page_registration_index(&Value::Null),
                                event.clone(),
                            )
                            .map(|_| ())
                        }
                    } else {
                        Ok(())
                    }
                }
                #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
                {
                    let _ = event;
                    Ok(())
                }
            };
            consumed += 1;
            let failed = callback_result.is_err();
            if let Err(error) = callback_result {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
            }
            if let Err(error) = self.ensure_engine_execution_healthy() {
                if !failed {
                    messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                }
                break;
            }
            // Navigation and mutations are queued JS effects. Apply them now,
            // before checking whether the next event still owns this page.
            // Writes before a thrown callback remain authoritative as well.
            if let Err(error) = self.append_engine_effects(&mut messages) {
                messages.push(self.error_envelope(&error, String::new(), op::ERROR));
                break;
            }
            if failed || messages.iter().any(effect_continuation_stopped) {
                break;
            }
        }
        self.append_browser_retirement_messages(&mut messages);
        self.view.record_event_batch(consumed);
        messages.insert(
            0,
            BridgeEnvelope::event(
                self.config.session_id.clone(),
                "view.events.consumed",
                json!({"key":batch.key,"events":consumed,"dropped":resolved.len()-consumed}),
            ),
        );
        Ok(BridgeBatch::new(messages))
    }

    /// All host transports use this through `dispatch_result`, which supplies
    /// protocol/session/deadline/cancellation validation, storage sync and the
    /// failure-path effect drain shared by the existing AppService bridge.
    pub(super) fn handle_browser_operation(
        &mut self,
        request: &BridgeEnvelope,
    ) -> Result<Vec<BridgeEnvelope>, BridgeError> {
        self.ensure_initialized()?;
        if live::is_live_operation(&request.op) {
            return self.handle_browser_live_operation(request);
        }
        if animation::is_animation_operation(&request.op) {
            return self.handle_browser_animation_operation(request);
        }
        let mut messages = vec![];
        let result = match request.op.as_str() {
            op::VIEW_PREPARE => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Prepare {
                    version: String,
                    surface_generation: String,
                    render: Value,
                }
                let payload: Prepare = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(error.to_string()))?;
                if payload.version != VIEW_PRESENTATION_VERSION {
                    return Err(BridgeError::protocol(
                        "unsupported browser presentation version",
                    ));
                }
                let generation: u64 = payload.surface_generation.parse().map_err(|_| {
                    invalid("surfaceGeneration must be a canonical u64 decimal string")
                })?;
                if generation.to_string() != payload.surface_generation {
                    return Err(invalid("surfaceGeneration must be canonical"));
                }
                let submission = self.prepare_browser_view(&payload.render, generation)?;
                // The candidate already owns the root-data clone-boundary
                // snapshot. Never replace it with state sampled after effects
                // or ACK; component hooks can have advanced template input.
                let consumed_input = self.browser_page_input(&submission.key).map(|input| {
                    json!({
                        "pageId": input.page_id.0.to_string(),
                        "routePath": input.route_path,
                        "templateRevision": input.template_revision.to_string(),
                        // Use the same f32-to-f64 boundary as submission's
                        // viewport, preserving exact fractional dimensions.
                        "viewport": {
                            "x": f64::from(input.viewport.x),
                            "y": f64::from(input.viewport.y),
                            "width": f64::from(input.viewport.width),
                            "height": f64::from(input.viewport.height),
                        },
                    })
                });
                let mut scheduling = json!({
                    "version": VIEW_PRESENTATION_VERSION,
                    "key": submission.key,
                    "consumedInput": consumed_input,
                });
                if let Some(consumed) = self
                    .browser_view
                    .pending
                    .as_ref()
                    .and_then(|pending| pending.animations.as_ref())
                    .and_then(|animations| animations.playback.consumed_sample)
                {
                    scheduling["consumedSample"] = json!(consumed);
                }
                let completion = self
                    .ensure_engine_execution_healthy()
                    .and_then(|()| self.append_engine_effects(&mut messages))
                    .and_then(|()| {
                        if messages.iter().any(effect_continuation_stopped) {
                            self.invalidate_browser_candidate();
                            return Err(BridgeError::new(
                                BridgeErrorCode::Timeout,
                                "View preparation effects did not reach quiescence",
                            ));
                        }
                        self.browser_key_is_current(&submission.key)
                            .then_some(())
                            .ok_or_else(|| stale("page changed during View preparation"))
                    });
                if let Err(error) = completion {
                    // Side effects already consumed by this turn must remain
                    // observable even when they retire its prepared document.
                    messages.insert(
                        0,
                        self.error_envelope(&error, request.request_id.clone(), &request.op),
                    );
                    return Ok(messages);
                }
                json!({"ok":true,"submission":submission,"scheduling":scheduling})
            }
            op::VIEW_PREPARE_COMMIT => {
                let geometry = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(format!("invalid browser geometry: {error}")))?;
                json!({"ok":true,"permit":self.prepare_browser_commit(geometry)?})
            }
            op::VIEW_PRESENTED => {
                let permit = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(format!("invalid browser permit: {error}")))?;
                messages.extend(self.acknowledge_browser_presentation(&permit)?.messages);
                let mut result = json!({"ok":true,"key":permit.key,"inputEnabled":self.is_browser_view_presented()});
                if let Some(lifetime) = self.input_lifetime_revision {
                    result["inputLifetimeRevision"] = json!(lifetime.to_string());
                }
                result
            }
            op::VIEW_ABORT => {
                let key = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(format!("invalid browser abort key: {error}")))?;
                self.settle_browser_view(&key)?
            }
            op::VIEW_GEOMETRY => {
                let geometry = serde_json::from_value(request.payload.clone())
                    .map_err(|error| invalid(format!("invalid browser geometry: {error}")))?;
                self.update_browser_geometry(geometry)?;
                json!({"ok":true})
            }
            op::VIEW_EVENTS => {
                messages.extend(
                    self.dispatch_browser_events(request.payload.clone())?
                        .messages,
                );
                json!({"ok":true})
            }
            _ => return Err(invalid("unknown browser presentation operation")),
        };
        messages.insert(0, self.response(request, result));
        Ok(messages)
    }
}

fn resolve_browser_event(
    topology: &ViewTopology,
    key: &PresentationKey,
    event: &BrowserEvent,
) -> Result<(Value, BTreeSet<String>), BridgeError> {
    let route = topology
        .event_route(&event.target_occurrence_id, &event.event_type)
        .map_err(|error| invalid(error.to_string()))?;
    event.validate_text_control(route.target)?;
    let mut mark = BTreeMap::new();
    let mut scopes = BTreeSet::new();
    for node in &route.path {
        mark.extend(node.mark.clone());
        scopes.extend(
            [
                &node.ownership.event_owner,
                &node.ownership.component_scope,
                &node.ownership.slot_owner,
            ]
            .into_iter()
            .filter_map(|scope| scope.clone()),
        );
    }
    let dispatches: Vec<Value> = route.listeners.iter().map(|listener| json!({
        "type":event.event_type,"target":route.target.occurrence_id,"current_target":listener.node.occurrence_id,
        "phase":listener.phase,"dataset":listener.node.dataset,"mark":mark,"detail":event.detail,
        "publicCurrentTargetId":listener.node.public_id.as_deref().unwrap_or(""),
        "publicTargetId":route.target.public_id.as_deref().unwrap_or(""),
        "handler":listener.binding.handler,"catch":listener.binding.catch,
        "ownerScopeId":listener.node.ownership.event_owner,
    })).collect();
    let mut value = json!({"type":event.event_type,"target":route.target.occurrence_id,
        "dataset":route.target.dataset,"mark":mark,"detail":event.detail,"dispatches":dispatches,
        "pageId":key.page_id,"bubbles":true,"capture":true,"declaredCatch":route.propagation_stopped});
    if let Some(time_stamp) = event.time_stamp {
        value["timeStamp"] = json!(time_stamp);
    }
    if let Some(touches) = &event.touches {
        value["touches"] = json!(touches);
    }
    if let Some(touches) = &event.changed_touches {
        value["changedTouches"] = json!(touches);
    }
    Ok((value, scopes))
}

pub(super) fn validate_geometry(
    submission: &BrowserViewSubmission,
    topology: &ViewTopology,
    geometry: &BrowserGeometryBatch,
) -> Result<(), BridgeError> {
    if geometry.key != submission.key || geometry.viewport != submission.viewport {
        return Err(stale("browser geometry identity or viewport mismatch"));
    }
    let mut expected = BTreeSet::new();
    let mut nodes: Vec<_> = submission.document.nodes.iter().collect();
    while let Some(node) = nodes.pop() {
        expected.insert(node.occurrence_id());
        if let container_ir::ViewNode::Element { children, .. } = node {
            nodes.extend(children);
        }
    }
    if geometry.nodes.len() != expected.len()
        || geometry.nodes.iter().any(|node| {
            !expected.contains(node.occurrence_id.as_str())
                || topology.node(&node.occurrence_id).is_none()
        })
    {
        return Err(invalid(
            "browser geometry must cover exactly the authoritative View occurrences",
        ));
    }
    Ok(())
}

impl Session {
    /// A digest identifies bytes; this exact descriptor path also identifies
    /// the live Session lease. Every request rechecks revocation/retirement.
    pub fn browser_view_resource_at_path(
        &self,
        key: &container_ir::PresentationKey,
        sha256: &str,
        path: &str,
    ) -> Result<Vec<u8>, BridgeError> {
        let Some(url) = container_core::BufferUrlStore::resource_url(path) else {
            return self.browser_view_resource(key, sha256).map(<[u8]>::to_vec);
        };
        if !self.browser_key_is_current(key) {
            return Err(invalid(
                "BufferURL resource belongs to a retired browser surface",
            ));
        }
        let document = self
            .browser_view
            .pending
            .as_ref()
            .filter(|value| &value.submission.key == key)
            .map(|value| &value.submission.document)
            .or_else(|| {
                self.browser_view
                    .presented
                    .as_ref()
                    .filter(|value| &value.submission.key == key)
                    .map(|value| &value.submission.document)
            })
            .ok_or_else(|| invalid("BufferURL request has no retained View owner"))?;
        let asset = document
            .resources
            .iter()
            .find(|asset| asset.path == path && asset.sha256 == sha256)
            .ok_or_else(|| invalid("BufferURL descriptor is not declared by the retained View"))?;
        let bytes = self.buffer_urls.resolve(&url).map_err(invalid)?;
        if bytes.len() as u64 != asset.size || container_ir::hex_digest(&bytes) != asset.sha256 {
            return Err(invalid("BufferURL descriptor size or hash mismatch"));
        }
        Ok(bytes.to_vec())
    }
}

#[cfg(test)]
mod input_lifetime_tests {
    use super::*;

    fn fresh() -> Session {
        let mut manifest = container_ir::ContainerManifestV1 {
            compiler: container_ir::CompilerInfo {
                name: "weapp-vite".into(),
                commit: "input-lifetime-fixture".into(),
                platform: "weapp".into(),
            },
            app: container_ir::AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        Session::new(manifest, SessionConfig::default()).unwrap()
    }

    #[test]
    fn soft_candidate_invalidation_does_not_create_a_hard_scheduler_loop() {
        let mut session = fresh();
        assert_eq!(session.input_lifetime_revision(), Some(0));
        for _ in 0..8 {
            session.invalidate_browser_candidate();
        }
        assert_eq!(session.input_lifetime_revision(), Some(0));
        session.invalidate_browser_presentation();
        assert_eq!(session.input_lifetime_revision(), Some(1));
        for _ in 0..8 {
            session.invalidate_browser_candidate();
        }
        assert_eq!(session.input_lifetime_revision(), Some(1));
    }

    #[test]
    fn lifetime_overflow_is_terminal_and_only_a_new_session_resets_namespace() {
        let mut session = fresh();
        session.input_lifetime_revision = Some(u64::MAX);
        session.invalidate_browser_presentation();
        assert_eq!(session.input_lifetime_revision(), None);
        assert!(session.engine_execution_is_faulted());
        assert!(session.ensure_engine_execution_healthy().is_err());
        session.invalidate_browser_presentation();
        assert_eq!(session.input_lifetime_revision(), None);
        assert_eq!(fresh().input_lifetime_revision(), Some(0));
    }

    #[test]
    fn interrupted_view_rejects_dom_ack_and_retires_contacts_without_guest_cancellation() {
        let mut session = fresh();
        let key = PresentationKey {
            session_id: session.config.session_id.clone(),
            page_id: 1,
            document_revision: 1,
            presentation_revision: 1,
            surface_generation: 1,
            profile: RendererProfile::WebView,
        };
        let permit = BrowserCommitPermit {
            version: VIEW_PRESENTATION_VERSION.into(),
            key: key.clone(),
            epoch: "1".into(),
            permit_id: "retired-permit".into(),
        };
        session.browser_view.contacts.insert(
            7,
            BrowserContact {
                key: key.clone(),
                target: "retired-target".into(),
                cancel_event: json!({"type":"touchcancel","handler":"mustNotRun"}),
                scopes: BTreeSet::from(["retired-scope".into()]),
                latest: BrowserTouch {
                    identifier: 7,
                    x: 1.0,
                    y: 1.0,
                    client_x: 1.0,
                    client_y: 1.0,
                    page_x: 1.0,
                    page_y: 1.0,
                },
                time_stamp: Some(1.0),
                receiver_snapshot: None,
            },
        );
        let lifecycle = session.app_service.lifecycle().state();
        session.view_execution.borrow_mut().inject_fault_for_test(
            container_core::ViewEngineError::new(
                container_core::ViewEngineErrorCode::Timeout,
                "original DOM frontier interruption",
            ),
        );
        assert!(!session.browser_key_is_current(&key));
        assert!(!session.is_browser_view_presented());
        assert!(!session.is_browser_view_pending(&key));
        assert!(session.browser_page_input(&key).is_none());
        let error = session
            .acknowledge_browser_presentation(&permit)
            .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::Engine);
        assert!(error.message.contains("original DOM frontier interruption"));
        assert!(session
            .settle_browser_contact_retirement("after interrupted graph")
            .is_err());
        let retirement = session.retire_browser_preview("host stopped").unwrap();
        assert!(session.browser_view.contacts.is_empty());
        assert_eq!(session.view.event_count, 0);
        assert!(retirement
            .messages
            .iter()
            .any(|message| message.op == "view.contacts.retired"
                && message.payload["delivered"] == false));
        let lifetime = session.input_lifetime_revision();
        session.retire_browser_preview("duplicate cleanup").unwrap();
        assert_eq!(session.input_lifetime_revision(), lifetime);
        assert_eq!(session.app_service.lifecycle().state(), lifecycle);
        assert!(!session.engine_execution_is_faulted());
    }
}
