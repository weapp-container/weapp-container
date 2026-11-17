//! Session-owned subscriptions. A registration acknowledges ownership; only
//! accepted render or host viewport observations produce measurements.
use super::*;
use container_render_skia::RenderNodeGeometry;
use std::collections::HashMap;

type SubscriptionKey = (String, String);
type GeometryIndex = HashMap<*const RenderNode, usize>;

#[derive(Default)]
pub(super) struct ObserverRegistry {
    subscriptions: BTreeMap<SubscriptionKey, Subscription>,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    media_revision: Option<u64>,
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    intersection_revision: Option<u64>,
    #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
    media_test_failure: Option<MediaTestBoundary>,
    #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
    intersection_test_reject_failure: bool,
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaTestBoundary {
    Capture,
    Dispatch,
}

struct Subscription {
    api: String,
    page: Option<PageId>,
    scope: Option<String>,
    kind: Observation,
    media_identity: Option<(String, String)>,
    intersection_identity: Option<(String, String, Option<String>)>,
    state: ObservationState,
}

enum Observation {
    Intersection(Intersection),
    Media(MediaQuery),
}

#[derive(Default)]
struct ObservationState {
    ratios: BTreeMap<String, f64>,
    matches: Option<bool>,
}

#[derive(PartialEq)]
struct Intersection {
    selector: String,
    roots: Vec<RelativeRoot>,
    thresholds: Vec<f64>,
    initial_ratio: f64,
    all: bool,
    native: bool,
}

#[derive(PartialEq)]
struct RelativeRoot {
    selector: Option<String>,
    margins: [f64; 4], // top, right, bottom, left
}

struct ResolvedRoots {
    relative: Geometry,
    native_root: Option<usize>,
    available: bool,
}

#[derive(PartialEq)]
struct MediaQuery {
    dimensions: [Option<f64>; 6],
    landscape: Option<bool>,
}

struct Measurements {
    notifications: Vec<Value>,
    states: Vec<(SubscriptionKey, ObservationState)>,
    media_notifications: Vec<Value>,
    media_states: Vec<(SubscriptionKey, ObservationState)>,
    intersection_notifications: Vec<Value>,
    intersection_states: Vec<(SubscriptionKey, ObservationState)>,
    errors: Vec<BridgeError>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaDesiredState {
    revision: String,
    #[serde(default)]
    unchanged: bool,
    subscriptions: Option<Vec<MediaDesiredSubscription>>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaDesiredSubscription {
    observer_id: String,
    subscription_id: String,
    page_id: String,
    scope_id: Option<String>,
    owner_token: String,
    page_token: String,
    descriptor: Map<String, Value>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntersectionDesiredState {
    revision: String,
    #[serde(default)]
    unchanged: bool,
    subscriptions: Option<Vec<IntersectionDesiredSubscription>>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntersectionDesiredSubscription {
    observer_id: String,
    subscription_id: String,
    page_id: String,
    scope_id: Option<String>,
    owner_scope_id: Option<String>,
    owner_token: String,
    page_token: String,
    selector: String,
    options: Map<String, Value>,
}

#[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
fn media_sequence(value: &str, zero: bool) -> Result<u64, BridgeError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|parsed| (zero || *parsed > 0) && parsed.to_string() == value)
        .ok_or_else(|| BridgeError::invalid("invalid native media sequence"))
}

impl ObserverRegistry {
    pub(super) fn release_page(&mut self, page: PageId) {
        self.subscriptions
            .retain(|_, subscription| subscription.page != Some(page));
    }

    pub(super) fn release_scopes(&mut self, scopes: &[String]) {
        self.subscriptions.retain(|_, subscription| {
            !subscription
                .scope
                .as_ref()
                .is_some_and(|scope| scopes.contains(scope))
                && !subscription
                    .intersection_identity
                    .as_ref()
                    .and_then(|(_, _, scope)| scope.as_ref())
                    .is_some_and(|scope| scopes.contains(scope))
        });
    }

    fn measure(
        &self,
        frame: Option<&RenderFrame>,
        page: Option<PageId>,
        viewport: (f64, f64),
        now_ns: u64,
    ) -> Measurements {
        let geometries = frame.map(RenderFrame::node_geometries).unwrap_or_default();
        // Pointer identity only indexes this borrowed frame. Build it once,
        // rather than scanning every node for each observeAll target/root.
        let indexes: GeometryIndex = geometries
            .iter()
            .enumerate()
            .map(|(index, geometry)| (geometry.node as *const RenderNode, index))
            .collect();
        let mut result = Measurements {
            notifications: Vec::new(),
            states: Vec::new(),
            media_notifications: Vec::new(),
            media_states: Vec::new(),
            intersection_notifications: Vec::new(),
            intersection_states: Vec::new(),
            errors: Vec::new(),
        };
        for (key, subscription) in &self.subscriptions {
            let mut next = ObservationState::default();
            match &subscription.kind {
                Observation::Media(query) => {
                    let matches = query.matches(viewport);
                    if subscription.state.matches != Some(matches) {
                        let mut value = notification(key, json!({"matches":matches}));
                        if let Some((owner, page)) = &subscription.media_identity {
                            value["ownerToken"] = json!(owner);
                            value["pageToken"] = json!(page);
                            result.media_notifications.push(value);
                        } else {
                            result.notifications.push(value);
                        }
                    }
                    next.matches = Some(matches);
                }
                Observation::Intersection(options) => {
                    let Some(frame) =
                        frame.filter(|_| subscription.page.is_none() || subscription.page == page)
                    else {
                        continue;
                    };
                    let targets = match frame.query_scoped(
                        &options.selector,
                        options.all,
                        subscription.scope.as_deref(),
                    ) {
                        Ok(targets) => targets,
                        Err(error) => {
                            result.errors.push(BridgeError::invalid(error.to_string()));
                            continue;
                        }
                    };
                    // Relative selectors have one meaning for the entire
                    // subscription and frame; resolving them for each target
                    // makes observeAll quadratic even with one simple root.
                    let roots = match options.resolve_roots(
                        frame,
                        &geometries,
                        &indexes,
                        subscription.scope.as_deref(),
                    ) {
                        Ok(roots) => roots,
                        Err(error) => {
                            result.errors.push(error);
                            continue;
                        }
                    };
                    let mut failure = None;
                    for target in targets {
                        let index = *indexes
                            .get(&(target as *const RenderNode))
                            .expect("queried frame node has geometry");
                        match options.measure(&geometries, index, &roots, now_ns) {
                            Ok((ratio, value)) => {
                                // event_identity is the committed occurrence address;
                                // public ids can repeat within and between components.
                                let identity = target
                                    .event_identity
                                    .clone()
                                    .unwrap_or_else(|| format!("node:{index}:{}", target.id));
                                let previous = subscription
                                    .state
                                    .ratios
                                    .get(&identity)
                                    .copied()
                                    .unwrap_or(options.initial_ratio);
                                if options.crossed(previous, ratio) {
                                    let mut value = notification(key, value);
                                    if let Some((owner, page, _)) =
                                        &subscription.intersection_identity
                                    {
                                        value["ownerToken"] = json!(owner);
                                        value["pageToken"] = json!(page);
                                        result.intersection_notifications.push(value);
                                    } else {
                                        result.notifications.push(value);
                                    }
                                }
                                next.ratios.insert(identity, ratio);
                            }
                            Err(error) => {
                                failure = Some(error);
                                break;
                            }
                        }
                    }
                    if let Some(error) = failure {
                        // A rejected observation must not advance threshold state.
                        result.notifications.retain(|value| {
                            value["observerId"] != key.0 || value["subscriptionId"] != key.1
                        });
                        result.intersection_notifications.retain(|value| {
                            value["observerId"] != key.0 || value["subscriptionId"] != key.1
                        });
                        result.errors.push(error);
                        continue;
                    }
                }
            }
            if subscription.media_identity.is_some() {
                result.media_states.push((key.clone(), next));
            } else if subscription.intersection_identity.is_some() {
                result.intersection_states.push((key.clone(), next));
            } else {
                result.states.push((key.clone(), next));
            }
        }
        result
    }
}

fn notification(key: &SubscriptionKey, value: Value) -> Value {
    json!({"observerId":key.0,"subscriptionId":key.1,"value":value})
}

impl Session {
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn observer_effect_result(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
    ) -> Result<Value, BridgeError> {
        let deadline = payload
            .get("deadlineNs")
            .or_else(|| payload.get("deadline_ns"))
            .map(|value| {
                value.as_u64().ok_or_else(|| {
                    BridgeError::invalid("observer deadlineNs must be an unsigned integer")
                })
            })
            .transpose()?;
        let token = payload
            .get("cancelToken")
            .or_else(|| payload.get("cancel_token"))
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| BridgeError::invalid("observer cancelToken must be a string"))
            })
            .transpose()?;
        // Session media ownership is admitted only by the retained snapshot.
        // Writable diagnostic effects cannot register, revoke or replace it.
        if name == "wx.createMediaQueryObserver" || name == "wx.createIntersectionObserver" {
            return Err(BridgeError::invalid(
                "observer registration requires native owner state",
            ));
        }
        self.observer_api_result(name, payload, deadline, token)
    }

    pub(super) fn observer_api_result(
        &mut self,
        name: &str,
        payload: &Map<String, Value>,
        deadline_ns: Option<u64>,
        cancel_token: Option<&str>,
    ) -> Result<Value, BridgeError> {
        if self.effective_capability(name) == CapabilitySupport::Unsupported {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                format!("{name} is unsupported on this session"),
            ));
        }
        if deadline_ns.is_some_and(deadline_expired) {
            return Err(BridgeError::new(
                BridgeErrorCode::Timeout,
                "observer request deadline has expired",
            ));
        }
        if cancel_token.is_some_and(|token| self.is_cancelled(token)) {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "observer request was cancelled",
            ));
        }
        let id = required_string(payload, "observerId")?;
        if id.starts_with("media:") || id.starts_with("intersection:") {
            return Err(BridgeError::invalid("native observer identity is reserved"));
        }
        let action = required_string(payload, "action")?;
        if action == "disconnect" {
            self.observers
                .borrow_mut()
                .subscriptions
                .retain(|key, subscription| key.0 != id || subscription.api != name);
            return Ok(json!({"errMsg":format!("{name}.disconnect:ok"),"observerId":id}));
        }
        if action != "observe" {
            return Err(BridgeError::invalid(format!(
                "unsupported observer action {action}"
            )));
        }
        let subscription_id = required_string(payload, "subscriptionId")?;
        let page = if let Some(value) = payload.get("pageId") {
            let id = value
                .as_u64()
                .or_else(|| value.as_str().and_then(|value| value.parse::<u64>().ok()))
                .filter(|id| *id > 0)
                .map(PageId)
                .ok_or_else(|| BridgeError::invalid("observer pageId must identify a live page"))?;
            if self.app_service.pages().get(id).is_none()
                && !self.cached_tabs.values().any(|page| page.id == id)
            {
                return Err(BridgeError::invalid("observer page has been unloaded"));
            }
            Some(id)
        } else {
            self.app_service.pages().current().map(|page| page.id)
        };
        let options = payload
            .get("options")
            .map(object_payload)
            .transpose()?
            .cloned()
            .unwrap_or_default();
        let scope = payload
            .get("scopeId")
            .or_else(|| options.get("scopeId"))
            .map(|value| {
                value
                    .as_str()
                    .filter(|value| !value.trim().is_empty())
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        BridgeError::invalid("observer scopeId must be a non-empty string")
                    })
            })
            .transpose()?;
        if let Some(scope) = &scope {
            if !self.observer_scope_is_live(page, scope) {
                return Err(BridgeError::invalid(
                    "observer component scope has been detached",
                ));
            }
        }
        let kind = if name == "wx.createIntersectionObserver" {
            Observation::Intersection(Intersection::parse(payload, &options)?)
        } else {
            Observation::Media(MediaQuery::parse(object_payload(
                payload
                    .get("descriptor")
                    .ok_or_else(|| BridgeError::invalid("media observer requires descriptor"))?,
            )?)?)
        };
        let key = (id.to_owned(), subscription_id.to_owned());
        let mut registry = self.observers.borrow_mut();
        if registry.subscriptions.iter().any(|(key, subscription)| {
            key.0 == id
                && (subscription.api != name
                    || subscription.page != page
                    || subscription.scope != scope)
        }) {
            return Err(BridgeError::invalid(
                "observer identity cannot change API or owner",
            ));
        }
        if registry.subscriptions.contains_key(&key) {
            return Err(BridgeError::invalid("observer subscription already exists"));
        }
        registry.subscriptions.insert(
            key,
            Subscription {
                api: name.into(),
                page,
                scope,
                kind,
                media_identity: None,
                intersection_identity: None,
                state: ObservationState::default(),
            },
        );
        self.observer_observation_pending = true;
        Ok(
            json!({"errMsg":format!("{name}:ok"),"observerId":id,"subscriptionId":subscription_id,"registered":true}),
        )
    }

    fn observer_scope_is_live(&self, page: Option<PageId>, scope: &str) -> bool {
        // The component planner also calls this boundary during attached hooks,
        // before the next frame exists. Concrete occurrence ownership is the
        // source of truth; the last frame alone can contain detached nodes.
        page.and_then(|page| self.component_pages.get(&page))
            .is_some_and(|graph| graph.contains_observer_scope(scope))
    }

    /// Reconcile a complete private desired state. A failed public event JSON
    /// conversion cannot consume this snapshot; unchanged revisions are cheap.
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn reconcile_media_queries(&mut self) -> Result<(), BridgeError> {
        if !self.engine_provider_available() {
            return Ok(());
        }
        self.ensure_engine_execution_healthy()?;
        #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
        self.fail_media_test_boundary(MediaTestBoundary::Capture)?;
        let known = self.observers.borrow().media_revision;
        let state: Value = match self.config.engine {
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
                        .capture_media_query_state(known)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    return Ok(());
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .capture_media_query_state(known)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    return Ok(());
                }
            }
        };
        let state: MediaDesiredState = serde_json::from_value(state).map_err(|error| {
            BridgeError::invalid(format!("invalid native media state: {error}"))
        })?;
        let revision = media_sequence(&state.revision, true)?;
        if state.unchanged {
            if known != Some(revision) || state.subscriptions.is_some() {
                return Err(BridgeError::invalid("invalid unchanged native media state"));
            }
            return Ok(());
        }
        if known.is_some_and(|known| revision < known) {
            return Err(BridgeError::invalid(
                "native media revision moved backwards",
            ));
        }
        let subscriptions = state
            .subscriptions
            .ok_or_else(|| BridgeError::invalid("native media state requires subscriptions"))?;
        if subscriptions.len() > 4096 {
            return Err(BridgeError::invalid(
                "native media subscription budget exceeded",
            ));
        }
        if !subscriptions.is_empty()
            && self.effective_capability("wx.createMediaQueryObserver")
                == CapabilitySupport::Unsupported
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "wx.createMediaQueryObserver is unsupported on this session",
            ));
        }
        let mut desired = BTreeMap::new();
        let mut seen = BTreeSet::new();
        let mut owners = BTreeMap::new();
        let mut all_live = true;
        for entry in subscriptions {
            let observer_number = entry
                .observer_id
                .strip_prefix("media:")
                .ok_or_else(|| BridgeError::invalid("invalid native media observer identity"))?;
            media_sequence(observer_number, false)?;
            let subscription_number = entry
                .subscription_id
                .strip_prefix("media-subscription:")
                .ok_or_else(|| {
                    BridgeError::invalid("invalid native media subscription identity")
                })?;
            media_sequence(subscription_number, false)?;
            let page = PageId(media_sequence(&entry.page_id, false)?);
            media_sequence(&entry.owner_token, false)?;
            media_sequence(&entry.page_token, false)?;
            if entry
                .scope_id
                .as_ref()
                .is_some_and(|scope| scope.trim().is_empty())
                || (entry.scope_id.is_none() && entry.owner_token != entry.page_token)
                || entry.descriptor.keys().any(|key| {
                    ![
                        "width",
                        "minWidth",
                        "maxWidth",
                        "height",
                        "minHeight",
                        "maxHeight",
                        "orientation",
                    ]
                    .contains(&key.as_str())
                })
            {
                return Err(BridgeError::invalid(
                    "invalid native media owner or descriptor",
                ));
            }
            let identity = (entry.owner_token, entry.page_token);
            let owner = (page, entry.scope_id.clone(), identity.clone());
            if owners
                .get(&entry.observer_id)
                .is_some_and(|previous| previous != &owner)
            {
                return Err(BridgeError::invalid("native media observer owner changed"));
            }
            owners.insert(entry.observer_id.clone(), owner);
            if owners.len() > 1024 {
                return Err(BridgeError::invalid(
                    "native media observer budget exceeded",
                ));
            }
            let query = MediaQuery::parse(&entry.descriptor)?;
            let key = (entry.observer_id, entry.subscription_id);
            if !seen.insert(key.clone()) {
                return Err(BridgeError::invalid("duplicate native media subscription"));
            }
            // During a structural host commit a concrete JS occurrence can
            // precede publication of its host graph. Retry that same revision
            // on the next turn rather than losing a valid attached observer.
            let page_live = self.app_service.pages().get(page).is_some()
                || self
                    .cached_tabs
                    .values()
                    .any(|candidate| candidate.id == page);
            if !page_live
                || entry
                    .scope_id
                    .as_ref()
                    .is_some_and(|scope| !self.observer_scope_is_live(Some(page), scope))
            {
                all_live = false;
                continue;
            }
            desired.insert(
                key,
                Subscription {
                    api: "wx.createMediaQueryObserver".into(),
                    page: Some(page),
                    scope: entry.scope_id,
                    kind: Observation::Media(query),
                    media_identity: Some(identity),
                    intersection_identity: None,
                    state: ObservationState::default(),
                },
            );
        }
        let mut changed = false;
        let mut registry = self.observers.borrow_mut();
        for (key, candidate) in &mut desired {
            if let Some(previous) = registry.subscriptions.get_mut(key) {
                if previous.page == candidate.page
                    && previous.scope == candidate.scope
                    && previous.media_identity == candidate.media_identity
                    && matches!((&previous.kind, &candidate.kind),
                        (Observation::Media(left), Observation::Media(right)) if left == right)
                {
                    candidate.state = std::mem::take(&mut previous.state);
                } else {
                    changed = true;
                }
            } else {
                changed = true;
            }
        }
        registry.subscriptions.retain(|key, previous| {
            let keep = previous.media_identity.is_none();
            if !keep && !desired.contains_key(key) {
                changed = true;
            }
            keep
        });
        registry.subscriptions.extend(desired);
        registry.media_revision = all_live.then_some(revision);
        if changed {
            self.observer_observation_pending = true;
        }
        Ok(())
    }

    /// Capture private desired state without a guest checkpoint. Revocations
    /// are committed before admitting or validating any new geometry request.
    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    pub(super) fn reconcile_intersection_queries(&mut self) -> Result<(), BridgeError> {
        let supported = self.effective_capability("wx.createIntersectionObserver")
            != CapabilitySupport::Unsupported;
        if !supported {
            let mut registry = self.observers.borrow_mut();
            registry
                .subscriptions
                .retain(|_, entry| entry.intersection_identity.is_none());
            registry.intersection_revision = None;
        }
        if !self.engine_provider_available() {
            return Ok(());
        }
        self.ensure_engine_execution_healthy()?;
        let known = self.observers.borrow().intersection_revision;
        let state = match self.config.engine {
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
                        .capture_intersection_query_state(known)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "quickjs-native"))]
                {
                    return Ok(());
                }
            }
            EngineKind::V8 => {
                #[cfg(feature = "v8-native")]
                {
                    self.v8_engine
                        .as_mut()
                        .ok_or_else(|| {
                            BridgeError::new(BridgeErrorCode::Engine, "V8 provider unavailable")
                        })?
                        .capture_intersection_query_state(known)
                        .map_err(|error| {
                            engine_bridge_error(error.into_core_error(), BridgeErrorCode::Engine)
                        })?
                }
                #[cfg(not(feature = "v8-native"))]
                {
                    return Ok(());
                }
            }
        };
        let state: IntersectionDesiredState = serde_json::from_value(state).map_err(|error| {
            BridgeError::invalid(format!("invalid native intersection state: {error}"))
        })?;
        let revision = media_sequence(&state.revision, true)?;
        if state.unchanged {
            if known != Some(revision) || state.subscriptions.is_some() {
                return Err(BridgeError::invalid(
                    "invalid unchanged native intersection state",
                ));
            }
            return Ok(());
        }
        if known.is_some_and(|known| revision < known) {
            return Err(BridgeError::invalid(
                "native intersection revision moved backwards",
            ));
        }
        let entries = state.subscriptions.ok_or_else(|| {
            BridgeError::invalid("native intersection state requires subscriptions")
        })?;
        if entries.len() > 4096 {
            return Err(BridgeError::invalid(
                "native intersection subscription budget exceeded",
            ));
        }
        let mut present = BTreeSet::new();
        for entry in &entries {
            media_sequence(
                entry
                    .observer_id
                    .strip_prefix("intersection:")
                    .ok_or_else(|| {
                        BridgeError::invalid("invalid native intersection observer identity")
                    })?,
                false,
            )?;
            media_sequence(
                entry
                    .subscription_id
                    .strip_prefix("intersection-subscription:")
                    .ok_or_else(|| {
                        BridgeError::invalid("invalid native intersection subscription identity")
                    })?,
                false,
            )?;
            if !present.insert((entry.observer_id.clone(), entry.subscription_id.clone())) {
                return Err(BridgeError::invalid(
                    "duplicate native intersection subscription",
                ));
            }
        }
        // Only a successfully captured complete private snapshot can remove
        // these records. Public effects/tables never select cleanup targets.
        self.observers
            .borrow_mut()
            .subscriptions
            .retain(|key, entry| {
                entry.intersection_identity.is_none() || (supported && present.contains(key))
            });
        if !supported {
            return Ok(());
        }
        let mut desired = BTreeMap::new();
        let mut owners = BTreeMap::new();
        let mut receivers = BTreeMap::new();
        let mut all_live = true;
        for entry in entries {
            let page = PageId(media_sequence(&entry.page_id, false)?);
            media_sequence(&entry.owner_token, false)?;
            media_sequence(&entry.page_token, false)?;
            if entry
                .owner_scope_id
                .as_ref()
                .is_some_and(|scope| scope.trim().is_empty())
                || (entry.owner_scope_id.is_none() && entry.owner_token != entry.page_token)
                || (entry.scope_id.is_some() && entry.scope_id != entry.owner_scope_id)
                || entry.options.keys().any(|key| {
                    ![
                        "initialRatio",
                        "observeAll",
                        "nativeMode",
                        "thresholds",
                        "relativeRoots",
                    ]
                    .contains(&key.as_str())
                })
            {
                return Err(BridgeError::invalid(
                    "invalid native intersection owner or options",
                ));
            }
            let identity = (entry.owner_token, entry.page_token, entry.owner_scope_id);
            let owner = (page, entry.scope_id.clone(), identity.clone());
            if owners
                .get(&entry.observer_id)
                .is_some_and(|previous| previous != &owner)
            {
                return Err(BridgeError::invalid(
                    "native intersection observer owner changed",
                ));
            }
            owners.insert(entry.observer_id.clone(), owner);
            if owners.len() > 1024 {
                return Err(BridgeError::invalid(
                    "native intersection observer budget exceeded",
                ));
            }
            let page_live = self.app_service.pages().get(page).is_some()
                || self
                    .cached_tabs
                    .values()
                    .any(|candidate| candidate.id == page);
            if !page_live
                || identity
                    .2
                    .as_ref()
                    .is_some_and(|scope| !self.observer_scope_is_live(Some(page), scope))
            {
                all_live = false;
                continue;
            }
            let receiver_key = (page, identity.2.clone());
            if !receivers.contains_key(&receiver_key) {
                let scopes: Vec<String> = identity.2.iter().cloned().collect();
                let captured = self.selector_receiver_snapshot(
                    private_selector::FIRST_PRIVATE_ID,
                    page.0,
                    &scopes,
                )?;
                receivers.insert(receiver_key.clone(), captured);
            }
            let captured = &receivers[&receiver_key];
            if captured["pageToken"].as_str() != Some(identity.1.as_str())
                || identity.2.as_ref().is_some_and(|scope| {
                    captured["scopes"][scope].as_str() != Some(identity.0.as_str())
                })
            {
                all_live = false;
                continue;
            }
            let payload = Map::from_iter([("selector".into(), Value::String(entry.selector))]);
            let options = match Intersection::parse(&payload, &entry.options) {
                Ok(options) => options,
                Err(error) => {
                    // An invalid new selector/root is a terminal admission
                    // result, not perpetual capture debt. Only the retained
                    // transport may consume this exact private subscription.
                    // If rejection delivery fails, propagate that failure and
                    // retain retry debt rather than claiming settlement.
                    #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
                    if std::mem::take(
                        &mut self.observers.borrow_mut().intersection_test_reject_failure,
                    ) {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Engine,
                            "test intersection rejection transport failed once",
                        ));
                    }
                    if !self.dispatch_lifecycle_notification(
                        "intersectionReject",
                        &json!([{
                            "observerId": entry.observer_id,
                            "subscriptionId": entry.subscription_id,
                            "ownerToken": identity.0,
                            "pageToken": identity.1,
                        }]),
                    )? {
                        return Err(BridgeError::new(
                            BridgeErrorCode::Engine,
                            "native intersection rejection was not accepted",
                        ));
                    }
                    return Err(error);
                }
            };
            desired.insert(
                (entry.observer_id, entry.subscription_id),
                Subscription {
                    api: "wx.createIntersectionObserver".into(),
                    page: Some(page),
                    scope: entry.scope_id,
                    kind: Observation::Intersection(options),
                    media_identity: None,
                    intersection_identity: Some(identity),
                    state: ObservationState::default(),
                },
            );
        }
        let mut changed = false;
        let mut registry = self.observers.borrow_mut();
        for (key, candidate) in &mut desired {
            if let Some(previous) = registry.subscriptions.get_mut(key) {
                if previous.page == candidate.page
                    && previous.scope == candidate.scope
                    && previous.intersection_identity == candidate.intersection_identity
                    && matches!((&previous.kind, &candidate.kind), (Observation::Intersection(left), Observation::Intersection(right)) if left == right)
                {
                    candidate.state = std::mem::take(&mut previous.state);
                } else {
                    changed = true;
                }
            } else {
                changed = true;
            }
        }
        registry
            .subscriptions
            .retain(|_, previous| previous.intersection_identity.is_none());
        registry.subscriptions.extend(desired);
        registry.intersection_revision = all_live.then_some(revision);
        if changed {
            self.observer_observation_pending = true;
        }
        Ok(())
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    pub(super) fn reconcile_intersection_queries(&mut self) -> Result<(), BridgeError> {
        Ok(())
    }

    #[cfg(not(any(feature = "quickjs-native", feature = "v8-native")))]
    pub(super) fn reconcile_media_queries(&mut self) -> Result<(), BridgeError> {
        Ok(())
    }

    // One-shot faults are test-only and private to the runtime unit fixture;
    // no guest global or production fault-injection surface is installed.
    #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
    fn fail_media_test_boundary(&mut self, boundary: MediaTestBoundary) -> Result<(), BridgeError> {
        let mut registry = self.observers.borrow_mut();
        if registry.media_test_failure == Some(boundary) {
            registry.media_test_failure = None;
            return Err(BridgeError::new(
                BridgeErrorCode::Engine,
                "test media transport failed once",
            ));
        }
        Ok(())
    }

    /// Independent private owners must settle cleanup even when admission or
    /// capture for the other observer family fails on this same host boundary.
    pub(super) fn reconcile_observer_queries(&mut self) -> Result<(), BridgeError> {
        let intersection = self.reconcile_intersection_queries();
        let media = self.reconcile_media_queries();
        intersection?;
        media
    }

    pub(super) fn notify_observers(
        &mut self,
        messages: &mut Vec<BridgeEnvelope>,
    ) -> Result<(), BridgeError> {
        // A new viewport/frame can require observation even when the last
        // subscription revision was settled. Keep that debt across ordinary
        // capture/dispatch failures; only a completed observation clears it.
        self.observer_observation_pending = true;
        self.reconcile_observer_queries()?;
        let current = self.app_service.pages().current().map(|page| page.id);
        // DOM media subscriptions need no presentation, but must never borrow
        // a retained Skia frame for either viewport or intersection geometry.
        let frame = if !self.browser_route_active()
            && self.observer_frame_valid
            && self.observer_frame_page == current
            && self.is_current_frame_presented()
        {
            self.skia_backend.renderer.last_frame()
        } else {
            None
        };
        let viewport = if self.config.host.window_width > 0 && self.config.host.window_height > 0 {
            (
                f64::from(self.config.host.window_width),
                f64::from(self.config.host.window_height),
            )
        } else {
            frame
                .map(|frame| {
                    (
                        f64::from(frame.viewport.width),
                        f64::from(frame.viewport.height),
                    )
                })
                .unwrap_or_default()
        };
        if frame.is_none() && (viewport.0 == 0.0 || viewport.1 == 0.0) {
            return Ok(());
        }
        let measurements = self
            .observers
            .borrow()
            .measure(frame, current, viewport, unix_now_ns());
        if !measurements.media_notifications.is_empty() {
            #[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
            self.fail_media_test_boundary(MediaTestBoundary::Dispatch)?;
            self.dispatch_lifecycle_notification(
                "mediaQuery",
                &json!(measurements.media_notifications),
            )?;
        }
        // Commit each transport independently: an unrelated public
        // intersection dispatcher failure cannot replay delivered media.
        {
            let mut registry = self.observers.borrow_mut();
            for (key, state) in measurements.media_states {
                if let Some(subscription) = registry.subscriptions.get_mut(&key) {
                    subscription.state = state;
                }
            }
        }
        if !measurements.intersection_notifications.is_empty() {
            self.dispatch_lifecycle_notification(
                "intersectionQuery",
                &json!(measurements.intersection_notifications),
            )?;
        }
        // A later public diagnostic failure cannot replay private delivery.
        {
            let mut registry = self.observers.borrow_mut();
            for (key, state) in measurements.intersection_states {
                if let Some(subscription) = registry.subscriptions.get_mut(&key) {
                    subscription.state = state;
                }
            }
        }
        let mut diagnostic_notifications = measurements.media_notifications;
        diagnostic_notifications.extend(measurements.intersection_notifications);
        diagnostic_notifications.extend(measurements.notifications.iter().cloned());
        if !measurements.notifications.is_empty() && self.engine_provider_available() {
            self.call_engine(
                CallTarget::Global {
                    name: "__container_notify_observers".into(),
                },
                vec![json!(measurements.notifications)],
            )?;
        }
        if !diagnostic_notifications.is_empty() {
            messages.push(BridgeEnvelope::event(
                self.config.session_id.clone(),
                op::EVENT_BATCH,
                json!({"type":"observer.batch","observations":diagnostic_notifications}),
            ));
        }
        let mut registry = self.observers.borrow_mut();
        for (key, state) in measurements.states {
            if let Some(subscription) = registry.subscriptions.get_mut(&key) {
                subscription.state = state;
            }
        }
        drop(registry);
        // A failed engine dispatch has no complete delivery receipt. Preserve
        // pending work until notification and threshold state both commit.
        self.observer_observation_pending = false;
        for error in measurements.errors {
            messages.push(self.error_envelope(&error, String::new(), op::ERROR));
        }
        Ok(())
    }
}

fn required_string<'a>(object: &'a Map<String, Value>, key: &str) -> Result<&'a str, BridgeError> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| BridgeError::invalid(format!("observer {key} must be a non-empty string")))
}

fn boolean(object: &Map<String, Value>, key: &str) -> Result<bool, BridgeError> {
    object
        .get(key)
        .map(|value| {
            value
                .as_bool()
                .ok_or_else(|| BridgeError::invalid(format!("observer {key} must be a boolean")))
        })
        .transpose()
        .map(|value| value.unwrap_or(false))
}

fn number(value: &Value, field: &str) -> Result<f64, BridgeError> {
    value
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| BridgeError::invalid(format!("observer {field} must be a finite number")))
}

fn ratio(value: &Value, field: &str) -> Result<f64, BridgeError> {
    let value = number(value, field)?;
    if !(0.0..=1.0).contains(&value) {
        return Err(BridgeError::invalid(format!(
            "observer {field} must be between 0 and 1"
        )));
    }
    Ok(value)
}

fn validate_selector(selector: &str) -> Result<(), BridgeError> {
    container_core::selector::CompiledSelectorList::parse(selector)
        .map(|_| ())
        .map_err(|error| BridgeError::invalid(error.to_string()))
}

impl RelativeRoot {
    fn parse(kind: &str, object: &Map<String, Value>) -> Result<Self, BridgeError> {
        let selector = match kind {
            "viewport" => None,
            "node" => {
                let selector = required_string(object, "selector")?;
                validate_selector(selector)?;
                Some(selector.to_owned())
            }
            _ => {
                return Err(BridgeError::invalid(
                    "observer root kind must be node or viewport",
                ))
            }
        };
        let mut margins = [0.0; 4];
        if let Some(value) = object.get("margins") {
            let object = object_payload(value)?;
            for (index, key) in ["top", "right", "bottom", "left"].iter().enumerate() {
                if let Some(value) = object.get(*key) {
                    margins[index] = number(value, key)?;
                }
            }
        }
        Ok(Self { selector, margins })
    }
}

impl Intersection {
    fn parse(
        payload: &Map<String, Value>,
        options: &Map<String, Value>,
    ) -> Result<Self, BridgeError> {
        let selector = required_string(payload, "selector")?.to_owned();
        validate_selector(&selector)?;
        let thresholds = if let Some(value) = options.get("thresholds") {
            value
                .as_array()
                .ok_or_else(|| BridgeError::invalid("observer thresholds must be an array"))?
                .iter()
                .map(|value| ratio(value, "threshold"))
                .collect::<Result<Vec<_>, _>>()?
        } else {
            vec![0.0]
        };
        let mut thresholds = thresholds;
        if thresholds.is_empty() {
            thresholds.push(0.0);
        }
        thresholds.sort_by(f64::total_cmp);
        thresholds.dedup();
        let initial_ratio = options
            .get("initialRatio")
            .map(|value| ratio(value, "initialRatio"))
            .transpose()?
            .unwrap_or(0.0);
        let native = boolean(options, "nativeMode")?;
        let all = boolean(options, "observeAll")?;
        let mut roots = Vec::new();
        if let Some(value) = options.get("relativeRoots") {
            for root in value
                .as_array()
                .ok_or_else(|| BridgeError::invalid("observer relativeRoots must be an array"))?
            {
                let object = object_payload(root)?;
                roots.push(RelativeRoot::parse(
                    required_string(object, "kind")?,
                    object,
                )?);
            }
        } else {
            if let Some(value) = options.get("relativeTo") {
                roots.push(RelativeRoot::parse("node", object_payload(value)?)?);
            }
            if let Some(value) = options.get("relativeToViewport") {
                roots.push(RelativeRoot::parse(
                    "viewport",
                    &Map::from_iter([("margins".into(), value.clone())]),
                )?);
            }
        }
        if native && roots.len() > 1 {
            return Err(BridgeError::invalid(
                "native observer permits only one relative root",
            ));
        }
        if roots.is_empty() {
            roots.push(RelativeRoot {
                selector: None,
                margins: [0.0; 4],
            });
        }
        Ok(Self {
            selector,
            roots,
            thresholds,
            initial_ratio,
            all,
            native,
        })
    }

    fn crossed(&self, previous: f64, next: f64) -> bool {
        if previous == next {
            return false;
        }
        let band = |value| {
            self.thresholds
                .partition_point(|threshold| *threshold <= value)
        };
        band(previous) != band(next)
            || (self.thresholds.contains(&0.0) && (previous > 0.0) != (next > 0.0))
    }

    fn resolve_roots(
        &self,
        frame: &RenderFrame,
        geometries: &[RenderNodeGeometry<'_>],
        indexes: &GeometryIndex,
        scope: Option<&str>,
    ) -> Result<ResolvedRoots, BridgeError> {
        let mut relative = None;
        let mut native_root = None;
        let mut available = true;
        for root in &self.roots {
            let base = if let Some(selector) = &root.selector {
                let Some(node) = frame
                    .query_scoped(selector, false, scope)
                    .map_err(|error| BridgeError::invalid(error.to_string()))?
                    .first()
                    .copied()
                else {
                    // An absent reference has no layout region. Do not let
                    // positive margins manufacture a region at the origin.
                    available = false;
                    continue;
                };
                let index = *indexes
                    .get(&(node as *const RenderNode))
                    .expect("relative node geometry exists");
                if self.native {
                    native_root = Some(index);
                }
                if !geometries[index].displayed {
                    available = false;
                    continue;
                }
                if self.native {
                    native_clip_geometry(&geometries[index])?
                } else {
                    Geometry::from(geometries[index].bounds)
                }
            } else {
                Geometry::from(frame.viewport)
            };
            let expanded = base.expand(root.margins);
            relative = Some(relative.map_or(expanded, |rect: Geometry| rect.intersect(expanded)));
        }
        Ok(ResolvedRoots {
            relative: if available {
                relative.unwrap_or_default()
            } else {
                Geometry::default()
            },
            native_root,
            available,
        })
    }

    fn measure(
        &self,
        geometries: &[RenderNodeGeometry<'_>],
        target: usize,
        roots: &ResolvedRoots,
        now_ns: u64,
    ) -> Result<(f64, Value), BridgeError> {
        let geometry = &geometries[target];
        let bounding = Geometry::from(geometry.bounds);
        if self.native {
            if let Some(root) = roots.native_root {
                let mut cursor = geometry.parent;
                while cursor.is_some() && cursor != Some(root) {
                    cursor = cursor.and_then(|index| geometries[index].parent);
                }
                if cursor.is_none() {
                    return Err(BridgeError::invalid(
                        "native observer relative node must be a target ancestor",
                    ));
                }
            }
        }
        let mut intersection = bounding.intersect(roots.relative);
        if self.native {
            let mut cursor = geometry.parent;
            while let Some(index) = cursor {
                if Some(index) == roots.native_root {
                    break;
                }
                // The scrolling viewport clips at its fixed padding edge;
                // its offset has moved descendants, never this rectangle.
                if index != 0 || geometries[index].node.scroll_container {
                    intersection =
                        intersection.intersect(native_clip_geometry(&geometries[index])?);
                }
                cursor = geometries[index].parent;
            }
        }
        if !geometry.displayed || !roots.available {
            intersection = Geometry::default();
        }
        let area = bounding.width * bounding.height;
        let ratio = if area > 0.0 {
            (intersection.width * intersection.height / area).clamp(0.0, 1.0)
        } else {
            0.0
        };
        Ok((
            ratio,
            self.value(
                geometry,
                bounding,
                roots.relative,
                intersection,
                ratio,
                now_ns,
            ),
        ))
    }

    fn value(
        &self,
        geometry: &RenderNodeGeometry<'_>,
        bounding: Geometry,
        relative: Geometry,
        intersection: Geometry,
        ratio: f64,
        now_ns: u64,
    ) -> Value {
        json!({"id":geometry.node.attributes.get("id").cloned().unwrap_or_default(),"dataset":geometry.node.dataset,"intersectionRatio":ratio,"boundingClientRect":bounding.json(),"relativeRect":relative.json(),"intersectionRect":intersection.json(),"time":now_ns/1_000_000})
    }
}

/// Rectangular intersection geometry, not a rounded pixel-mask area. Only
/// axis-aligned transforms preserve the scrolling viewport as a rectangle.
fn native_clip_geometry(geometry: &RenderNodeGeometry<'_>) -> Result<Geometry, BridgeError> {
    if !geometry.node.scroll_container {
        return Ok(Geometry::from(geometry.bounds));
    }
    let transform = geometry.world_transform;
    if transform.b != 0.0 || transform.c != 0.0 {
        return Err(BridgeError::new(
            BridgeErrorCode::UnsupportedCapability,
            "native intersection observer with a rotated or sheared scroll viewport is not implemented",
        ));
    }
    let bounds = geometry.node.scroll_viewport();
    let corners = [
        (bounds.x, bounds.y),
        (bounds.x + bounds.width, bounds.y),
        (bounds.x, bounds.y + bounds.height),
        (bounds.x + bounds.width, bounds.y + bounds.height),
    ]
    .map(|point| transform.apply(point));
    if corners
        .iter()
        .any(|(x, y)| !x.is_finite() || !y.is_finite())
    {
        return Err(BridgeError::new(
            BridgeErrorCode::Render,
            "scroll observer geometry exceeds finite coordinates",
        ));
    }
    let left = corners
        .iter()
        .map(|point| f64::from(point.0))
        .fold(f64::INFINITY, f64::min);
    let right = corners
        .iter()
        .map(|point| f64::from(point.0))
        .fold(f64::NEG_INFINITY, f64::max);
    let top = corners
        .iter()
        .map(|point| f64::from(point.1))
        .fold(f64::INFINITY, f64::min);
    let bottom = corners
        .iter()
        .map(|point| f64::from(point.1))
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(Geometry {
        left,
        top,
        width: right - left,
        height: bottom - top,
    })
}

#[derive(Clone, Copy, Default)]
struct Geometry {
    left: f64,
    top: f64,
    width: f64,
    height: f64,
}
impl From<Rect> for Geometry {
    fn from(rect: Rect) -> Self {
        Self {
            left: rect.x.into(),
            top: rect.y.into(),
            width: rect.width.into(),
            height: rect.height.into(),
        }
    }
}
impl Geometry {
    fn expand(self, margins: [f64; 4]) -> Self {
        Self {
            left: self.left - margins[3],
            top: self.top - margins[0],
            width: (self.width + margins[1] + margins[3]).max(0.0),
            height: (self.height + margins[0] + margins[2]).max(0.0),
        }
    }
    fn intersect(self, other: Self) -> Self {
        let left = self.left.max(other.left);
        let top = self.top.max(other.top);
        Self {
            left,
            top,
            width: ((self.left + self.width).min(other.left + other.width) - left).max(0.0),
            height: ((self.top + self.height).min(other.top + other.height) - top).max(0.0),
        }
    }
    fn json(self) -> Value {
        json!({"left":self.left,"top":self.top,"right":self.left+self.width,"bottom":self.top+self.height,"width":self.width,"height":self.height})
    }
}

impl MediaQuery {
    fn parse(object: &Map<String, Value>) -> Result<Self, BridgeError> {
        let mut dimensions = [None; 6];
        for (index, key) in [
            "width",
            "minWidth",
            "maxWidth",
            "height",
            "minHeight",
            "maxHeight",
        ]
        .iter()
        .enumerate()
        {
            if let Some(value) = object.get(*key) {
                let value = number(value, key)?;
                if value < 0.0 {
                    return Err(BridgeError::invalid(format!(
                        "media observer {key} must be non-negative"
                    )));
                }
                dimensions[index] = Some(value);
            }
        }
        let landscape = object
            .get("orientation")
            .map(|value| match value.as_str() {
                Some("landscape") => Ok(true),
                Some("portrait") => Ok(false),
                _ => Err(BridgeError::invalid(
                    "media observer orientation must be portrait or landscape",
                )),
            })
            .transpose()?;
        Ok(Self {
            dimensions,
            landscape,
        })
    }
    fn matches(&self, viewport: (f64, f64)) -> bool {
        let (width, height) = viewport;
        let [exact_width, min_width, max_width, exact_height, min_height, max_height] =
            self.dimensions;
        exact_width.is_none_or(|value| width == value)
            && min_width.is_none_or(|value| width >= value)
            && max_width.is_none_or(|value| width <= value)
            && exact_height.is_none_or(|value| height == value)
            && min_height.is_none_or(|value| height >= value)
            && max_height.is_none_or(|value| height <= value)
            && self.landscape.is_none_or(|value| value == (width > height))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, width: f32, height: f32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn node(id: &str, bounds: Rect) -> RenderNode {
        let mut node = RenderNode::new(id, bounds);
        node.attributes.insert("id".into(), id.into());
        node
    }

    fn options(roots: Vec<RelativeRoot>, native: bool) -> Intersection {
        Intersection {
            selector: "#target".into(),
            roots,
            thresholds: vec![0.0],
            initial_ratio: 0.0,
            all: false,
            native,
        }
    }

    fn root(selector: Option<&str>, margins: [f64; 4]) -> RelativeRoot {
        RelativeRoot {
            selector: selector.map(str::to_owned),
            margins,
        }
    }

    fn measurement(
        frame: &RenderFrame,
        options: &Intersection,
    ) -> Result<(f64, Value), BridgeError> {
        let geometries = frame.node_geometries();
        let indexes: GeometryIndex = geometries
            .iter()
            .enumerate()
            .map(|(index, geometry)| (geometry.node as *const RenderNode, index))
            .collect();
        let roots = options.resolve_roots(frame, &geometries, &indexes, None)?;
        let target = frame.query("#target", false).unwrap()[0];
        options.measure(
            &geometries,
            indexes[&(target as *const RenderNode)],
            &roots,
            1_000_000,
        )
    }

    #[test]
    fn observer_geometry_hidden_relative_root_is_not_recreated_by_positive_margins() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut hidden = node("reference", rect(50.0, 50.0, 20.0, 20.0));
        hidden.style = Some(container_render_skia::LayoutStyle {
            display: container_render_skia::DisplayMode::None,
            ..Default::default()
        });
        let mut page = node("page", viewport);
        page.children = vec![hidden, node("target", rect(0.0, 0.0, 20.0, 20.0))];
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: page,
        };
        let options = options(vec![root(Some("#reference"), [100.0; 4])], false);
        let (ratio, value) = measurement(&frame, &options).unwrap();
        assert_eq!(ratio, 0.0);
        assert_eq!(value["relativeRect"]["width"], 0.0);
        assert_eq!(value["intersectionRect"]["height"], 0.0);
    }

    #[test]
    fn observer_geometry_viewport_reference_uses_the_committed_origin() {
        let viewport = rect(10.0, 20.0, 100.0, 100.0);
        let mut page = node("page", viewport);
        page.children = vec![node("target", rect(100.0, 100.0, 20.0, 20.0))];
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: page,
        };
        let (ratio, value) =
            measurement(&frame, &options(vec![root(None, [0.0; 4])], false)).unwrap();
        assert_eq!(ratio, 0.5);
        assert_eq!(value["relativeRect"]["left"], 10.0);
        assert_eq!(value["relativeRect"]["top"], 20.0);
        assert_eq!(value["intersectionRect"]["width"], 10.0);
        assert_eq!(value["intersectionRect"]["height"], 20.0);
    }

    #[test]
    fn observer_geometry_multiple_roots_intersect_after_individual_margins() {
        let viewport = rect(10.0, 20.0, 100.0, 100.0);
        let mut page = node("page", viewport);
        page.children = vec![
            node("reference", rect(30.0, 30.0, 50.0, 50.0)),
            node("target", rect(0.0, 0.0, 80.0, 80.0)),
        ];
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: page,
        };
        let options = options(
            vec![
                root(None, [0.0; 4]),
                root(Some("#reference"), [0.0, 0.0, 0.0, 10.0]),
            ],
            false,
        );
        let (ratio, value) = measurement(&frame, &options).unwrap();
        assert_eq!(ratio, 0.46875);
        assert_eq!(
            value["relativeRect"],
            json!({"left":20.0,"top":30.0,"right":80.0,"bottom":80.0,"width":60.0,"height":50.0})
        );
        assert_eq!(value["intersectionRect"], value["relativeRect"]);
    }

    #[test]
    fn observer_geometry_native_mode_clips_ancestors_and_rejects_a_sibling_reference() {
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut ancestor = node("ancestor", rect(0.0, 0.0, 30.0, 30.0));
        ancestor.children = vec![node("target", rect(20.0, 20.0, 40.0, 40.0))];
        let mut page = node("page", viewport);
        page.children = vec![ancestor, node("sibling", viewport)];
        let frame = RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: page,
        };
        assert_eq!(
            measurement(&frame, &options(vec![root(None, [0.0; 4])], false))
                .unwrap()
                .0,
            1.0
        );
        let (ratio, value) =
            measurement(&frame, &options(vec![root(None, [0.0; 4])], true)).unwrap();
        assert_eq!(ratio, 0.0625);
        assert_eq!(value["intersectionRect"]["width"], 10.0);
        let error = measurement(
            &frame,
            &options(vec![root(Some("#sibling"), [0.0; 4])], true),
        )
        .unwrap_err();
        assert_eq!(error.code, BridgeErrorCode::InvalidRequest);
        assert!(error.message.contains("target ancestor"));
    }

    fn scroll_frame() -> RenderFrame {
        use container_render_skia::{BorderSide, BorderStyle, Color, LayoutStyle, ScrollOffset};
        let viewport = rect(0.0, 0.0, 100.0, 100.0);
        let mut scroll = node("scroll", rect(10.0, 10.0, 40.0, 40.0));
        scroll.scroll_container = true;
        scroll.scroll_offset = Some(ScrollOffset {
            scroll_left: 0.0,
            scroll_top: 20.0,
        });
        scroll.style = Some(LayoutStyle {
            border: [BorderSide {
                width: 4.0,
                color: Color::BLACK,
                style: BorderStyle::Solid,
            }; 4],
            ..LayoutStyle::default()
        });
        scroll
            .children
            .push(node("target", rect(12.0, 32.0, 20.0, 20.0)));
        let mut page = node("page", viewport);
        page.children.push(scroll);
        RenderFrame {
            images: std::collections::BTreeMap::new(),
            frame_id: 1,
            viewport,
            root: page,
        }
    }

    #[test]
    fn native_scroll_observer_uses_painted_offset_and_fixed_padding_clip_for_ancestor_and_root() {
        let frame = scroll_frame();
        let (ratio, value) =
            measurement(&frame, &options(vec![root(None, [0.0; 4])], true)).unwrap();
        assert!((ratio - 0.81).abs() < 1e-9);
        assert_eq!(
            value["boundingClientRect"],
            json!({"left":12.0,"top":12.0,"right":32.0,"bottom":32.0,"width":20.0,"height":20.0})
        );
        assert_eq!(
            value["intersectionRect"],
            json!({"left":14.0,"top":14.0,"right":32.0,"bottom":32.0,"width":18.0,"height":18.0})
        );
        let (ratio, explicit) = measurement(
            &frame,
            &options(vec![root(Some("#scroll"), [0.0; 4])], true),
        )
        .unwrap();
        assert!((ratio - 0.81).abs() < 1e-9);
        assert_eq!(
            explicit["relativeRect"],
            json!({"left":14.0,"top":14.0,"right":46.0,"bottom":46.0,"width":32.0,"height":32.0})
        );
        assert_eq!(
            measurement(&frame, &options(vec![root(None, [0.0; 4])], false))
                .unwrap()
                .0,
            1.0,
            "non-native observer retains its viewport-rectangle semantics"
        );
    }

    #[test]
    fn native_scroll_observer_maps_padding_clip_through_scale_and_reflection() {
        use container_render_skia::{
            Transform2D, TransformOrigin, TransformOriginUnit, TransformOriginValue,
        };
        let mut frame = scroll_frame();
        frame.root.children[0].style.as_mut().unwrap().transform = Some(Transform2D {
            a: 2.0,
            d: 2.0,
            ..Transform2D::IDENTITY
        });
        frame.root.children[0]
            .style
            .as_mut()
            .unwrap()
            .transform_origin = Some(TransformOrigin {
            x: TransformOriginValue {
                value: 0.0,
                unit: TransformOriginUnit::Px,
            },
            y: TransformOriginValue {
                value: 0.0,
                unit: TransformOriginUnit::Px,
            },
        });
        let (ratio, value) = measurement(
            &frame,
            &options(vec![root(Some("#scroll"), [0.0; 4])], true),
        )
        .unwrap();
        assert!((ratio - 0.81).abs() < 1e-9);
        assert_eq!(value["relativeRect"]["left"], 18.0);
        assert_eq!(value["relativeRect"]["width"], 64.0);
        let style = frame.root.children[0].style.as_mut().unwrap();
        style.transform = Some(Transform2D {
            a: -1.0,
            ..Transform2D::IDENTITY
        });
        style.transform_origin = None;
        let (ratio, value) = measurement(
            &frame,
            &options(vec![root(Some("#scroll"), [0.0; 4])], true),
        )
        .unwrap();
        assert!((ratio - 0.81).abs() < 1e-9);
        assert_eq!(value["relativeRect"]["left"], 14.0);
        assert_eq!(value["intersectionRect"]["left"], 28.0);
    }

    #[test]
    fn native_scroll_observer_rejects_rotated_or_sheared_clip_instead_of_fabricating_aabb_visibility(
    ) {
        use container_render_skia::Transform2D;
        let mut frame = scroll_frame();
        frame.root.children[0].style.as_mut().unwrap().transform = Some(Transform2D {
            c: 0.5,
            ..Transform2D::IDENTITY
        });
        for reference in [None, Some("#scroll")] {
            let error =
                measurement(&frame, &options(vec![root(reference, [0.0; 4])], true)).unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::UnsupportedCapability);
            assert!(error.message.contains("rotated or sheared"));
        }
    }
}

#[cfg(all(test, any(feature = "quickjs-native", feature = "v8-native")))]
mod media_retry_tests {
    use super::*;
    include!("media-query-retry-tests.rs");
}
