//! Opt-in presentation ownership for developer Web raster surfaces.
//!
//! This is a runtime primitive, not an attached Web transport. The owner must
//! bind the target to its live preview lease and immutable binary publication,
//! send the returned ticket with that publication, and submit the exact ticket
//! only after the browser's RAF drawing step. Queue admission is never an ACK.
use super::*;

/// Headless and existing embedding callers retain synchronous Raster semantics.
/// Explicit developer ownership is a one-way, pre-initialization opt-in API;
/// it does not add a field to public SessionConfig struct literals.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RasterPresentationPolicy {
    #[default]
    Synchronous,
    ExplicitDev,
}

/// The exact binary publication and live preview selected by its owner.
/// `frame_id` is the Web transport sequence; `source_frame_id` belongs to the
/// accepted renderer. They are intentionally independent identities.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevRasterPresentationTarget {
    pub session_id: String,
    pub preview_id: String,
    #[serde(with = "decimal_u64")]
    pub preview_generation: u64,
    #[serde(with = "decimal_u64")]
    pub frame_id: u64,
    #[serde(with = "decimal_u64")]
    pub source_frame_id: u64,
    #[serde(with = "decimal_u64")]
    pub render_revision: u64,
    #[serde(with = "decimal_u64")]
    pub config_generation: u64,
    pub logical_width: u32,
    pub logical_height: u32,
    pub width: u32,
    pub height: u32,
}

/// Identities cross JavaScript as canonical decimal strings, never numbers.
mod decimal_u64 {
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&value.to_string())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        use serde::de::Error;

        let text = String::deserialize(deserializer)?;
        let value = text.parse::<u64>().map_err(D::Error::custom)?;
        if value.to_string() != text {
            return Err(D::Error::custom("expected canonical decimal u64 string"));
        }
        Ok(value)
    }
}

/// Issued by the runtime owner. The epoch is a decimal string so JavaScript
/// cannot round a large u64 into the identity of an earlier authorization.
/// It is returned unchanged by the browser; no fields are inferred from the
/// latest UI settings when acknowledging a frame.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevRasterPresentationTicket {
    pub version: String,
    pub presentation_epoch: String,
    pub target: DevRasterPresentationTarget,
}

struct Lease {
    ticket: DevRasterPresentationTicket,
    page: PageId,
    input_lifetime: u64,
    acknowledged: bool,
}

/// An exclusive, already validated ticket candidate. Header encoding and Web
/// reservation may fail while this is alive; dropping it preserves exact old
/// authority and does not consume an epoch.
#[must_use = "drop discards the ticket without installing authority"]
pub struct PreparedDevRasterPresentation<'a> {
    state: &'a mut DevRasterPresentationState,
    prepared: PreparedRasterLease,
    observation: AcceptedPageObservation<'a>,
}

impl PreparedDevRasterPresentation<'_> {
    pub fn ticket(&self) -> &DevRasterPresentationTicket {
        self.prepared.ticket()
    }

    /// Borrow the same accepted frame/target/pixels validated for this ticket.
    /// The exclusive Session preparation borrow pins this observation until
    /// accept/drop; no snapshot readback, pixel clone or View execution occurs.
    /// This passive view grants no browser presentation acknowledgment.
    pub fn accepted_page_observation(&self) -> AcceptedPageObservation<'_> {
        self.observation
    }

    /// No validation, allocation, engine entry or destructor runs here. Keep
    /// the receipt until the external publication store has been unlocked.
    pub fn accept(self) -> AcceptedDevRasterPresentation {
        self.prepared.install(self.state)
    }
}

/// Retains replaced authority and prepared ticket allocations after the
/// infallible install; it grants no browser presentation acknowledgment.
#[must_use = "retain until outside the joint publication critical section"]
pub struct AcceptedDevRasterPresentation {
    _retired: Option<Lease>,
    _prepared: Option<PreparedRasterLease>,
}

pub(super) struct PreparedRasterLease {
    ticket: DevRasterPresentationTicket,
    replacement: Option<Lease>,
    next_epoch: Option<u64>,
}

impl PreparedRasterLease {
    pub(super) fn ticket(&self) -> &DevRasterPresentationTicket {
        &self.ticket
    }

    pub(super) fn install(
        mut self,
        state: &mut DevRasterPresentationState,
    ) -> AcceptedDevRasterPresentation {
        let retired = if let Some(replacement) = self.replacement.take() {
            let retired = state.lease.replace(replacement);
            state.next_epoch = self.next_epoch;
            retired
        } else {
            None
        };
        AcceptedDevRasterPresentation {
            _retired: retired,
            _prepared: Some(self),
        }
    }
}

/// Private Session-derived authority, captured before borrowing a renderer
/// candidate. No caller can manufacture a picture proof from public geometry.
pub(super) struct DevRasterPublicationContext {
    session_id: String,
    page: PageId,
    input_lifetime: u64,
    logical_width: u32,
    logical_height: u32,
}

impl DevRasterPublicationContext {
    pub(super) fn prepare_page_ticket(
        &self,
        state: &DevRasterPresentationState,
        picture: &container_render_skia::PreparedPageFrame<'_>,
        target: DevRasterPresentationTarget,
    ) -> Result<PreparedRasterLease, BridgeError> {
        let frame = picture.frame();
        let size = picture.target();
        if !state.is_explicit()
            || picture.page_render_mode() != PageRenderMode::Raster
            || target.session_id != self.session_id
            || !valid_publication_identity(&target)
            || target.logical_width != self.logical_width
            || target.logical_height != self.logical_height
            || target.render_revision != picture.render_revision()
            || target.source_frame_id != frame.frame_id
            || frame.viewport.x != 0.0
            || frame.viewport.y != 0.0
            || frame.viewport.width != self.logical_width as f32
            || frame.viewport.height != self.logical_height as f32
            || target.width != size.width
            || target.height != size.height
            || !picture.snapshot().is_some_and(|snapshot| {
                snapshot.width == size.width && snapshot.height == size.height
            })
        {
            return Err(cancelled(
                "developer Raster target does not match the prepared logical picture",
            ));
        }
        state.prepare(target, self.page, self.input_lifetime)
    }

    pub(super) fn prepare_density_ticket(
        &self,
        state: &DevRasterPresentationState,
        picture: &container_render_skia::PreparedDensityRepaint<'_>,
        target: DevRasterPresentationTarget,
    ) -> Result<PreparedRasterLease, BridgeError> {
        let frame = picture.frame();
        let pixels = picture.snapshot();
        let size = picture.target();
        if picture.page_render_mode() != PageRenderMode::Raster
            || target.session_id != self.session_id
            || !valid_publication_identity(&target)
            || target.logical_width != self.logical_width
            || target.logical_height != self.logical_height
            || target.render_revision != picture.render_revision()
            || target.source_frame_id != frame.frame_id
            || frame.viewport.x != 0.0
            || frame.viewport.y != 0.0
            || frame.viewport.width != self.logical_width as f32
            || frame.viewport.height != self.logical_height as f32
            || target.width != size.width
            || target.height != size.height
            || !pixels.is_some_and(|snapshot| {
                snapshot.width == size.width && snapshot.height == size.height
            })
        {
            return Err(cancelled(
                "developer Raster target does not match the prepared density picture",
            ));
        }
        state.prepare(target, self.page, self.input_lifetime)
    }
}

pub(super) struct DevRasterPresentationState {
    policy: RasterPresentationPolicy,
    next_epoch: Option<u64>,
    lease: Option<Lease>,
}

impl Default for DevRasterPresentationState {
    fn default() -> Self {
        Self {
            policy: RasterPresentationPolicy::Synchronous,
            next_epoch: Some(1),
            lease: None,
        }
    }
}

impl DevRasterPresentationState {
    /// Pure bounded revocation. This never enters an engine, invokes resize,
    /// rewrites a renderer, or touches independent Canvas/context resources.
    pub(super) fn suspend(&mut self) {
        self.lease = None;
    }

    pub(super) fn suspend_with_retirement(&mut self) -> AcceptedDevRasterPresentation {
        AcceptedDevRasterPresentation {
            _retired: self.lease.take(),
            _prepared: None,
        }
    }

    pub(super) fn is_explicit(&self) -> bool {
        self.policy == RasterPresentationPolicy::ExplicitDev
    }

    fn prepare(
        &self,
        target: DevRasterPresentationTarget,
        page: PageId,
        input_lifetime: u64,
    ) -> Result<PreparedRasterLease, BridgeError> {
        if let Some(lease) = &self.lease {
            if lease.ticket.target == target
                && lease.page == page
                && lease.input_lifetime == input_lifetime
            {
                return Ok(PreparedRasterLease {
                    ticket: lease.ticket.clone(),
                    replacement: None,
                    next_epoch: self.next_epoch,
                });
            }
        }
        let epoch = self.next_epoch.ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "developer Raster presentation epoch exhausted",
            )
        })?;
        let next_epoch = epoch.checked_add(1);
        let ticket = DevRasterPresentationTicket {
            version: "1.0".into(),
            presentation_epoch: epoch.to_string(),
            target,
        };
        let returned = ticket.clone();
        Ok(PreparedRasterLease {
            ticket: returned,
            replacement: Some(Lease {
                ticket,
                page,
                input_lifetime,
                acknowledged: false,
            }),
            next_epoch,
        })
    }
}

fn valid_publication_identity(target: &DevRasterPresentationTarget) -> bool {
    !target.preview_id.is_empty()
        && target.preview_id.len() <= 128
        && target
            .preview_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        && target.preview_generation != 0
        && target.frame_id != 0
        && target.config_generation != 0
        && target.render_revision != 0
}

fn cancelled(message: &'static str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

impl Session {
    /// Enable exact developer Raster receipts before app.init, page creation
    /// or any page renderer initialization. A live/default session cannot be
    /// upgraded after its synchronous ready hooks have already run. Disabling
    /// this policy requires a new Session; there is no fallback to old ACKs.
    pub fn enable_dev_raster_presentation(&mut self) -> Result<(), BridgeError> {
        if self.dev_raster_presentation.policy == RasterPresentationPolicy::ExplicitDev {
            return Ok(());
        }
        if self.initialized
            || !self.app_service.pages().is_empty()
            || self.skia_backend.renderer.peek().is_some()
        {
            return Err(BridgeError::new(
                BridgeErrorCode::InvalidRequest,
                "developer Raster presentation must be enabled before initialization",
            ));
        }
        if self.config.page_render_mode != PageRenderMode::Raster {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "developer Raster receipts require Raster page rendering",
            ));
        }
        self.dev_raster_presentation.policy = RasterPresentationPolicy::ExplicitDev;
        Ok(())
    }

    pub fn raster_presentation_policy(&self) -> RasterPresentationPolicy {
        self.dev_raster_presentation.policy
    }

    pub(super) fn dev_raster_presentation_required(&self) -> bool {
        self.dev_raster_presentation.policy == RasterPresentationPolicy::ExplicitDev
    }

    /// Retire authority on owner disconnect, resize/reload abort or presenter
    /// loss, while retaining the accepted pixels for diagnostics. Timers are
    /// unaffected. Calling this in the legacy policy changes no public facts.
    pub fn suspend_dev_raster_presentation(&mut self) {
        self.dev_raster_presentation.suspend();
    }

    /// The logical candidate has its own source fence. It may be the first
    /// picture at this viewport, so an old accepted-scene proof is irrelevant.
    pub(super) fn dev_raster_logical_publication_context(
        &self,
    ) -> Option<DevRasterPublicationContext> {
        if !self.dev_raster_presentation_required()
            || self.skia_backend.renderer.page_render_mode() != PageRenderMode::Raster
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
        {
            return None;
        }
        Some(DevRasterPublicationContext {
            session_id: self.config.session_id.clone(),
            page: self.app_service.pages().current()?.id,
            input_lifetime: self.input_lifetime_revision?,
            logical_width: self.config.host.window_width,
            logical_height: self.config.host.window_height,
        })
    }

    pub(super) fn dev_raster_publication_context(&self) -> Option<DevRasterPublicationContext> {
        if !self.dev_raster_presentation_required()
            || self.skia_backend.renderer.page_render_mode() != PageRenderMode::Raster
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || !self.has_current_skia_scene()
            || self.current_skia_frame_authority().is_none()
        {
            return None;
        }
        let page = self.app_service.pages().current()?.id;
        if self.observer_frame_page != Some(page) {
            return None;
        }
        Some(DevRasterPublicationContext {
            session_id: self.config.session_id.clone(),
            page,
            input_lifetime: self.input_lifetime_revision?,
            logical_width: self.config.host.window_width,
            logical_height: self.config.host.window_height,
        })
    }

    fn dev_raster_target_is_current(&self, target: &DevRasterPresentationTarget) -> bool {
        if !self.dev_raster_presentation_required()
            || self.skia_backend.renderer.page_render_mode() != PageRenderMode::Raster
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || target.session_id != self.config.session_id
            || !valid_publication_identity(target)
            || target.render_revision != self.render_revision()
            || target.logical_width != self.config.host.window_width
            || target.logical_height != self.config.host.window_height
            || !self.has_current_skia_scene()
            || self.current_skia_frame_authority().is_none()
        {
            return false;
        }
        let Some(page) = self.app_service.pages().current() else {
            return false;
        };
        if self.observer_frame_page != Some(page.id) {
            return false;
        }
        self.accepted_page_observation().is_some_and(|observation| {
            observation.frame.frame_id == target.source_frame_id
                && observation.frame.viewport.x == 0.0
                && observation.frame.viewport.y == 0.0
                && observation.frame.viewport.width == target.logical_width as f32
                && observation.frame.viewport.height == target.logical_height as f32
                && observation.target.width == target.width
                && observation.target.height == target.height
                && observation.snapshot.is_some_and(|snapshot| {
                    snapshot.width == target.width && snapshot.height == target.height
                })
        })
    }

    fn dev_raster_lease_is_current(&self, lease: &Lease) -> bool {
        self.input_lifetime_revision == Some(lease.input_lifetime)
            && self.app_service.pages().current().map(|page| page.id) == Some(lease.page)
            && self.dev_raster_target_is_current(&lease.ticket.target)
    }

    /// Borrow the actual issued pending or acknowledged ticket while its page,
    /// input lifetime and accepted Raster picture are still current. This is a
    /// passive observation, not an input permit or presentation acknowledgment;
    /// a transport must independently recheck its live preview owner.
    pub fn current_dev_raster_presentation_ticket(&self) -> Option<&DevRasterPresentationTicket> {
        self.dev_raster_presentation
            .lease
            .as_ref()
            .filter(|lease| self.dev_raster_lease_is_current(lease))
            .map(|lease| &lease.ticket)
    }

    pub(super) fn dev_raster_is_currently_presented(&self) -> bool {
        self.dev_raster_presentation
            .lease
            .as_ref()
            .is_some_and(|lease| lease.acknowledged && self.dev_raster_lease_is_current(lease))
    }

    /// Arm an immutable publication only after the surface owner has bound its
    /// live preview lease. This is no-VM preparation and grants no ready, input,
    /// selector or observer authority. A duplicate live target is idempotent;
    /// a previously suspended target receives a fresh epoch on re-arming.
    pub fn arm_dev_raster_presentation(
        &mut self,
        target: DevRasterPresentationTarget,
    ) -> Result<DevRasterPresentationTicket, BridgeError> {
        let prepared = self.prepare_dev_raster_presentation(target)?;
        let ticket = prepared.ticket().clone();
        drop(prepared.accept());
        Ok(ticket)
    }

    /// Prepare authority for an already accepted exact picture without
    /// changing the live lease. This is suitable for fallible header work;
    /// use the candidate's `accept` only in the final no-fail publication step.
    pub fn prepare_dev_raster_presentation(
        &mut self,
        target: DevRasterPresentationTarget,
    ) -> Result<PreparedDevRasterPresentation<'_>, BridgeError> {
        if !self.dev_raster_presentation_required() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "exact developer Raster presentation is not enabled",
            ));
        }
        if !self.dev_raster_target_is_current(&target) {
            return Err(cancelled(
                "developer Raster target is not the current accepted page publication",
            ));
        }
        let input_lifetime = self
            .input_lifetime_revision
            .ok_or_else(|| cancelled("developer Raster input lifetime exhausted"))?;
        let page = self
            .app_service
            .pages()
            .current()
            .expect("current target checked")
            .id;
        // Split only the existing renderer and presentation-state borrows.
        // Calling the public Session observation method here would borrow all
        // of Session across the mutable lease-state borrow below.
        let observation = self
            .skia_backend
            .renderer
            .peek()
            .and_then(AcceptedPageObservation::from_renderer)
            .ok_or_else(|| cancelled("accepted Raster observation unavailable"))?;
        let prepared = self
            .dev_raster_presentation
            .prepare(target, page, input_lifetime)?;
        Ok(PreparedDevRasterPresentation {
            state: &mut self.dev_raster_presentation,
            prepared,
            observation,
        })
    }

    /// Consume the exact owner-issued ticket on the runtime lane after a
    /// browser RAF draw receipt. The transport must recheck its preview lease
    /// and generation before calling; an HTTP 202 does not call this method.
    pub fn acknowledge_dev_raster_presentation(
        &mut self,
        ticket: &DevRasterPresentationTicket,
    ) -> Result<BridgeBatch, BridgeError> {
        self.with_engine_batch_turn(None, |session| {
            session.ensure_view_execution_healthy()?;
            let lease = session
                .dev_raster_presentation
                .lease
                .as_ref()
                .ok_or_else(|| cancelled("developer Raster presentation is suspended"))?;
            if &lease.ticket != ticket || !session.dev_raster_lease_is_current(lease) {
                return Err(cancelled("stale developer Raster presentation ticket"));
            }
            session.validate_presentation_revision(ticket.target.render_revision)?;
            if lease.acknowledged {
                return Ok(BridgeBatch::new(Vec::new()));
            }
            let revision = ticket.target.render_revision;
            session
                .dev_raster_presentation
                .lease
                .as_mut()
                .expect("checked lease")
                .acknowledged = true;
            // Exact validation precedes publication effects. Ready may navigate,
            // throw or queue writes; those effects remain committed, and normal
            // invalidation can retire the just-accepted lease during the hook.
            // A newly accepted lease completes once even for a previously
            // presented renderer revision. Only this exact lease's duplicate
            // ACK is a no-op; the legacy revision dedupe is a different domain.
            session.complete_accepted_presentation_within_turn(revision)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{AppInfo, CompilerInfo, Route, RouteKind, Template};

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn enabled_native_engines() -> impl Iterator<Item = EngineKind> {
        [
            #[cfg(feature = "quickjs-native")]
            EngineKind::Quickjs,
            #[cfg(feature = "v8-native")]
            EngineKind::V8,
        ]
        .into_iter()
    }

    fn envelope(op: &str, payload: Value) -> BridgeEnvelope {
        BridgeEnvelope::request("raster-owner", format!("test-{op}"), op, payload)
    }

    fn init_fixture(explicit: bool) -> Session {
        // Exact-engine test builds exercise the selected provider; only a
        // build without native providers uses the existing headless boundary.
        let engine = if cfg!(feature = "quickjs-native") {
            EngineKind::Quickjs
        } else if cfg!(feature = "v8-native") {
            EngineKind::V8
        } else {
            EngineKind::Quickjs
        };
        init_fixture_for_engine(explicit, engine, None)
    }

    fn init_fixture_for_engine(
        explicit: bool,
        engine: EngineKind,
        source: Option<&[u8]>,
    ) -> Session {
        init_fixture_with_template(
            explicit,
            engine,
            source,
            "<view id=\"target\" style=\"width:2px;height:1px\">retained</view>",
        )
    }

    fn init_fixture_with_template(
        explicit: bool,
        engine: EngineKind,
        source: Option<&[u8]>,
        template: &str,
    ) -> Session {
        init_fixture_with_view_source(explicit, engine, source, template, None)
    }

    fn init_fixture_with_view_source(
        explicit: bool,
        engine: EngineKind,
        source: Option<&[u8]>,
        template: &str,
        wxs: Option<&[u8]>,
    ) -> Session {
        let native = engine_provider_compiled(engine);
        assert!(
            native || (source.is_none() && wxs.is_none()),
            "explicit source/WXS fixtures require the selected native engine provider"
        );
        // Authorization/geometry tests still use the complete bridge
        // handshake with the headless QuickJS boundary. They do not request
        // unsupported JavaScript execution. Native fixtures load real,
        // nonempty App/Page source instead of masquerading as headless ones.
        let executable_source = native.then(|| source.unwrap_or(b"App({}); Page({});"));
        let ast = container_ir::parse_wxml(template)
            .unwrap()
            .canonical_json()
            .unwrap();
        let ast_id = format!("sha256:{}", container_ir::hex_digest(&ast));
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "raster-owner".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            routes: vec![Route {
                id: "route:pages/index/index".into(),
                path: "pages/index/index".into(),
                kind: RouteKind::Page,
                config: None,
                entry_module: "page.js".into(),
            }],
            templates: vec![Template {
                id: "template:pages/index/index.wxml".into(),
                wxml_ast: ast_id.clone(),
                bindings: Vec::new(),
                wxs_modules: Default::default(),
            }],
            ..Default::default()
        };
        for capability in [
            "getCurrentPages",
            "wx.createIntersectionObserver",
            "wx.pageScrollTo",
        ] {
            manifest
                .capabilities
                .insert(capability.into(), CapabilitySupport::Partial);
        }
        if let Some(source) = executable_source {
            manifest.modules.push(container_ir::Module {
                id: "module:app.js".into(),
                sha256: container_ir::hex_digest(source),
                format: container_ir::ModuleFormat::Commonjs,
                scope: container_ir::ModuleScope::App,
                dependencies: Vec::new(),
            });
        }
        if let Some(source) = wxs {
            let id = "wxs:shared/counter.wxs";
            manifest.view_scripts.push(container_ir::ViewScriptModule {
                id: id.into(),
                sha256: container_ir::hex_digest(source),
                dependencies: Vec::new(),
            });
            manifest.templates[0]
                .wxs_modules
                .insert("counter".into(), id.into());
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: "raster-owner".into(),
                engine,
                // These assert presentation/lifecycle semantics, not latency.
                // Keep finite headroom for cold native realms under parallel
                // test contention; the production default remains 50 ms and
                // budget conformance keeps its own explicit limits.
                view_execution: ViewExecutionPolicy {
                    batch_timeout_ms: 2_000,
                },
                host: HostMetadata {
                    window_width: 2,
                    window_height: 1,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        if explicit {
            session.enable_dev_raster_presentation().unwrap();
            session.enable_dev_raster_presentation().unwrap();
        }
        let mut blobs = BTreeMap::new();
        blobs.insert(ast_id, ast);
        if let Some(source) = wxs {
            blobs.insert(
                format!("sha256:{}", container_ir::hex_digest(source)),
                source.to_vec(),
            );
        }
        let mut payload = json!({"blobs":blobs});
        if let Some(source) = executable_source {
            payload["modules"] =
                json!([{"id":"module:app.js", "source":String::from_utf8_lossy(source)}]);
        }
        let init = session.dispatch(envelope(op::APP_INIT, payload));
        assert_eq!(init.messages[0].payload["ok"], true, "{init:?}");
        let launch = session.dispatch(envelope(op::APP_LIFECYCLE, json!({"event":"launch"})));
        assert_eq!(launch.messages[0].payload["ok"], true, "{launch:?}");
        let push = session.dispatch(envelope(op::PAGE_PUSH, json!({"path":"pages/index/index"})));
        assert_eq!(push.messages[0].payload["ok"], true, "{push:?}");
        let render = session.dispatch(envelope(
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml",
                "useSessionResources":true,
                "viewport":{"x":0,"y":0,"width":2,"height":1}
            }),
        ));
        assert_eq!(render.messages[0].payload["ok"], true, "{render:?}");
        session
    }

    fn target(session: &Session) -> DevRasterPresentationTarget {
        let observation = session.accepted_page_observation().unwrap();
        DevRasterPresentationTarget {
            session_id: session.config.session_id.clone(),
            preview_id: "owned-preview".into(),
            preview_generation: 1,
            frame_id: 41,
            source_frame_id: observation.frame.frame_id,
            render_revision: observation.render_revision,
            config_generation: 1,
            logical_width: 2,
            logical_height: 1,
            width: observation.target.width,
            height: observation.target.height,
        }
    }

    fn query(session: &Session) -> Result<Value, BridgeError> {
        let payload = json!({"selector":"#target"});
        session
            .selector_query_single_result(payload.as_object().unwrap())
            .map(|(_, _, _, result)| result)
    }

    fn assert_input_waits(session: &mut Session) {
        assert!(!session.is_current_frame_presented());
        assert_eq!(query(session).unwrap_err().code, BridgeErrorCode::Render);
        let events = session.dispatch(envelope(op::EVENT_BATCH, json!({"events":[]})));
        assert_eq!(events.messages[0].payload["ok"], false);
        assert_eq!(events.messages[0].payload["error"]["code"], "ERR_CANCELLED");
    }

    #[test]
    fn rejected_layout_ack_never_marks_a_pending_ticket_successful() {
        let mut session = init_fixture(true);
        session.config.view_execution.batch_timeout_ms = 50;
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        // Fault injection: retain the old pixels and ticket while removing
        // their layout provenance, as a failed coordinate transition does.
        session.skia_frame_authority = None;
        for _ in 0..2 {
            assert_eq!(
                session
                    .acknowledge_dev_raster_presentation(&ticket)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
            assert!(
                !session
                    .dev_raster_presentation
                    .lease
                    .as_ref()
                    .unwrap()
                    .acknowledged
            );
        }
        assert!(session.dev_raster_publication_context().is_none());
        assert!(session
            .arm_dev_raster_presentation(target(&session))
            .is_err());
        assert_input_waits(&mut session);
    }

    #[test]
    fn size_round_trip_cannot_arm_a_new_ticket_for_old_pixels() {
        let mut session = init_fixture(true);
        session.config.view_execution.batch_timeout_ms = 50;
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        session.notify_viewport_resize(3, 1).unwrap();
        session.notify_viewport_resize(2, 1).unwrap();
        let mut replacement = target(&session);
        replacement.preview_generation += 1;
        assert!(session.arm_dev_raster_presentation(replacement).is_err());
        assert!(session
            .acknowledge_dev_raster_presentation(&ticket)
            .is_err());
        assert_input_waits(&mut session);
    }

    #[test]
    fn legacy_raster_keeps_synchronous_publication_and_revision_ack() {
        let mut session = init_fixture(false);
        assert_eq!(
            session.raster_presentation_policy(),
            RasterPresentationPolicy::Synchronous
        );
        assert!(session.is_current_frame_presented());
        assert!(session.observer_frame_valid);
        assert!(query(&session).unwrap().is_object());
        let revision = session.render_revision();
        assert!(session
            .acknowledge_presentation(revision)
            .unwrap()
            .messages
            .is_empty());
        session.suspend_dev_raster_presentation();
        assert!(session.is_current_frame_presented());
    }

    #[test]
    fn runtime_acceptance_and_ticket_arming_do_not_authorize_presentation() {
        let mut session = init_fixture(true);
        let revision = session.render_revision();
        assert!(!session.observer_frame_valid);
        assert!(session.pending_presentation.is_some());
        assert_input_waits(&mut session);
        assert_eq!(
            session.acknowledge_presentation(revision).unwrap_err().code,
            BridgeErrorCode::UnsupportedCapability
        );
        let expected = target(&session);
        let ticket = session
            .arm_dev_raster_presentation(expected.clone())
            .unwrap();
        assert_eq!(
            session.arm_dev_raster_presentation(expected).unwrap(),
            ticket
        );
        assert_input_waits(&mut session);
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(session.is_current_frame_presented());
        assert!(session.observer_frame_valid);
        assert!(query(&session).unwrap().is_object());
        assert!(session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap()
            .messages
            .is_empty());
    }

    #[test]
    fn view_timeout_revokes_both_pending_and_acknowledged_raster_tickets() {
        for acknowledge_before_fault in [false, true] {
            let mut session = init_fixture(true);
            let publication = target(&session);
            let ticket = session
                .arm_dev_raster_presentation(publication.clone())
                .unwrap();
            if acknowledge_before_fault {
                session
                    .acknowledge_dev_raster_presentation(&ticket)
                    .unwrap();
                assert!(session.is_current_frame_presented());
            }
            let page = session.app_service.pages().current().unwrap().clone();
            let lifecycle = session.app_service.lifecycle().state();
            session.view_execution.borrow_mut().inject_fault_for_test(
                container_core::ViewEngineError::new(
                    container_core::ViewEngineErrorCode::Timeout,
                    "typed test frontier timeout",
                ),
            );

            assert!(!session.is_current_frame_presented());
            assert!(session.arm_dev_raster_presentation(publication).is_err());
            let error = session
                .acknowledge_dev_raster_presentation(&ticket)
                .unwrap_err();
            assert_eq!(error.code, BridgeErrorCode::Engine);
            assert!(error.message.contains("ERR_VIEW_REQUIRES_RESET"));
            assert!(query(&session).is_err());
            assert!(session.retire_faulted_view_authority());
            assert!(session.dev_raster_presentation.lease.is_none());
            assert!(session.accepted_page_observation().is_some());
            assert!(session
                .acknowledge_dev_raster_presentation(&ticket)
                .is_err());
            assert_eq!(session.app_service.pages().current(), Some(&page));
            assert_eq!(session.app_service.lifecycle().state(), lifecycle);
            assert!(!session.engine_execution_is_faulted());
        }
    }

    #[test]
    fn exact_ticket_is_required_for_every_transport_preview_and_geometry_field() {
        let mut session = init_fixture(true);
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        let serialized = serde_json::to_value(&ticket).unwrap();
        for (field, replacement) in [
            ("sessionId", json!("retired-session")),
            ("previewId", json!("mirror-preview")),
            ("previewGeneration", json!("2")),
            ("frameId", json!("42")),
            ("sourceFrameId", json!("9001")),
            ("renderRevision", json!("9001")),
            ("configGeneration", json!("2")),
            ("logicalWidth", json!(3)),
            ("logicalHeight", json!(3)),
            ("width", json!(3)),
            ("height", json!(3)),
        ] {
            let mut wrong = serialized.clone();
            wrong["target"][field] = replacement;
            let wrong = serde_json::from_value(wrong).unwrap();
            assert_eq!(
                session
                    .acknowledge_dev_raster_presentation(&wrong)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled,
                "{field}"
            );
            assert_input_waits(&mut session);
        }
        for (field, replacement) in [
            ("version", json!("2.0")),
            ("presentationEpoch", json!("01")),
        ] {
            let mut wrong = serialized.clone();
            wrong[field] = replacement;
            let wrong = serde_json::from_value(wrong).unwrap();
            assert_eq!(
                session
                    .acknowledge_dev_raster_presentation(&wrong)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
        }
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(session.is_current_frame_presented());
    }

    #[test]
    fn target_identity_wire_preserves_full_u64_range_as_canonical_strings() {
        let session = init_fixture(true);
        for boundary in [9_007_199_254_740_993, u64::MAX] {
            let mut value = target(&session);
            value.preview_generation = boundary;
            value.frame_id = boundary;
            value.source_frame_id = boundary;
            value.render_revision = boundary;
            value.config_generation = boundary;
            let wire = serde_json::to_string(&value).unwrap();
            let encoded: Value = serde_json::from_str(&wire).unwrap();
            for field in [
                "previewGeneration",
                "frameId",
                "sourceFrameId",
                "renderRevision",
                "configGeneration",
            ] {
                assert_eq!(encoded[field], boundary.to_string());
            }
            let decoded: DevRasterPresentationTarget = serde_json::from_str(&wire).unwrap();
            assert_eq!(decoded, value);
        }
    }

    #[test]
    fn target_identity_wire_rejects_numbers_noncanonical_strings_overflow_and_unknown_fields() {
        let session = init_fixture(true);
        let baseline = serde_json::to_value(target(&session)).unwrap();
        for field in [
            "previewGeneration",
            "frameId",
            "sourceFrameId",
            "renderRevision",
            "configGeneration",
        ] {
            for invalid in [
                json!(1),
                json!(9_007_199_254_740_993_u64),
                json!(u64::MAX),
                json!(""),
                json!("01"),
                json!("+1"),
                json!("-1"),
                json!(" 1"),
                json!("1 "),
                json!("1e0"),
                json!("1.0"),
                json!("18446744073709551616"),
                Value::Null,
            ] {
                let mut wire = baseline.clone();
                wire[field] = invalid;
                assert!(
                    serde_json::from_value::<DevRasterPresentationTarget>(wire).is_err(),
                    "{field} must reject numeric or noncanonical identity"
                );
            }
        }
        let mut unknown = baseline;
        unknown["unknownIdentity"] = json!("1");
        assert!(serde_json::from_value::<DevRasterPresentationTarget>(unknown).is_err());
    }

    #[test]
    fn owner_disconnect_requires_a_new_epoch_even_for_identical_pixels() {
        let mut session = init_fixture(true);
        let target = target(&session);
        let first = session.arm_dev_raster_presentation(target.clone()).unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let pixels = session.render_snapshot().unwrap();
        let revision = session.render_revision();
        session.suspend_dev_raster_presentation();
        assert_input_waits(&mut session);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&first)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        let next = session.arm_dev_raster_presentation(target).unwrap();
        assert_ne!(first.presentation_epoch, next.presentation_epoch);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&first)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        session.acknowledge_dev_raster_presentation(&next).unwrap();
        assert!(session.is_current_frame_presented());
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.render_snapshot().unwrap(), pixels);
    }

    #[test]
    fn unchanged_density_keeps_exact_acknowledged_ticket_without_consuming_an_epoch() {
        let mut session = init_fixture(true);
        let target = target(&session);
        let first = session.arm_dev_raster_presentation(target.clone()).unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let revision = session.render_revision();
        let next_epoch = session.dev_raster_presentation.next_epoch;
        let input = session.last_frame_input(revision).cloned();
        // FPS-only owners can accept an unchanged density candidate without
        // invalidating the only immutable publication that remains on screen.
        let receipt = session
            .prepare_dev_density(1.0)
            .unwrap()
            .unwrap()
            .accept_with_retirement();
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.last_frame_input(revision), input.as_ref());
        assert_eq!(session.dev_raster_presentation.next_epoch, next_epoch);
        assert_eq!(session.arm_dev_raster_presentation(target).unwrap(), first);
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
        assert!(session.is_current_frame_presented());
        drop(receipt);
    }

    #[test]
    fn dropped_prepared_ticket_keeps_exact_live_authority_and_epoch() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let epoch = session.dev_raster_presentation.next_epoch;
        let mut next_target = target(&session);
        next_target.frame_id += 1;
        let prepared = session
            .prepare_dev_raster_presentation(next_target.clone())
            .unwrap();
        let unpublished = prepared.ticket().clone();
        drop(prepared);
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert!(session.is_current_frame_presented());
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&unpublished)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
        let prepared = session
            .prepare_dev_raster_presentation(next_target)
            .unwrap();
        assert_eq!(prepared.ticket(), &unpublished);
        let receipt = prepared.accept();
        assert_eq!(receipt._retired.as_ref().unwrap().ticket, first);
        assert!(receipt._retired.as_ref().unwrap().acknowledged);
        assert_input_waits(&mut session);
        session
            .acknowledge_dev_raster_presentation(&unpublished)
            .unwrap();
        assert!(session.is_current_frame_presented());
        drop(receipt);
    }

    #[test]
    fn duplicate_preparation_preserves_acknowledgment_even_after_epoch_exhaustion() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        session.dev_raster_presentation.next_epoch = None;
        let prepared = session
            .prepare_dev_raster_presentation(first.target.clone())
            .unwrap();
        assert_eq!(prepared.ticket(), &first);
        let receipt = prepared.accept();
        assert!(receipt._retired.is_none());
        assert!(session.is_current_frame_presented());
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
        let no_change = session.prepare_dev_density(1.0).unwrap().unwrap();
        assert!(!no_change.picture().density_changed());
        drop(no_change.accept_with_retirement());
        assert!(session.is_current_frame_presented());
        let mut replacement = first.target.clone();
        replacement.frame_id += 1;
        assert_eq!(
            session
                .prepare_dev_raster_presentation(replacement)
                .err()
                .unwrap()
                .code,
            BridgeErrorCode::Render
        );
        assert!(session.is_current_frame_presented());
        assert_eq!(session.dev_raster_presentation.next_epoch, None);
        drop(receipt);
    }

    #[test]
    fn dropping_the_last_prepared_epoch_does_not_consume_its_identity() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        session.dev_raster_presentation.next_epoch = Some(u64::MAX);
        let mut next_target = first.target.clone();
        next_target.frame_id += 1;
        let prepared = session
            .prepare_dev_raster_presentation(next_target.clone())
            .unwrap();
        assert_eq!(prepared.ticket().presentation_epoch, u64::MAX.to_string());
        drop(prepared);
        assert_eq!(session.dev_raster_presentation.next_epoch, Some(u64::MAX));
        assert!(session.is_current_frame_presented());
        let prepared = session
            .prepare_dev_raster_presentation(next_target)
            .unwrap();
        let ticket = prepared.ticket().clone();
        drop(prepared.accept());
        assert_eq!(session.dev_raster_presentation.next_epoch, None);
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(session.is_current_frame_presented());
    }

    fn density_target(
        mut target: DevRasterPresentationTarget,
        density: &crate::PreparedDevDensity<'_>,
    ) -> DevRasterPresentationTarget {
        target.frame_id += 1;
        target.config_generation += 1;
        target.source_frame_id = density.picture().frame().frame_id;
        target.render_revision = density.picture().render_revision();
        target.width = density.picture().target().width;
        target.height = density.picture().target().height;
        target
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn dropped_density_ticket_keeps_picture_input_ack_and_unpublished_epoch() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let revision = session.render_revision();
        let input = session.last_frame_input(revision).cloned();
        let epoch = session.dev_raster_presentation.next_epoch;
        let pixels = session.render_snapshot().unwrap();
        let mut prepared = session.prepare_dev_density(0.9).unwrap().unwrap();
        let target = density_target(first.target.clone(), &prepared);
        let unpublished = prepared
            .prepare_raster_presentation(target)
            .unwrap()
            .clone();
        assert_eq!(unpublished.target.render_revision, revision + 1);
        drop(prepared);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.render_snapshot().unwrap(), pixels);
        assert_eq!(session.last_frame_input(revision), input.as_ref());
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&unpublished)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
        assert!(session.is_current_frame_presented());
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn prepared_density_validates_candidate_metadata_before_replacing_old_authority() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let epoch = session.dev_raster_presentation.next_epoch;
        let mut density = session.prepare_dev_density(0.9).unwrap().unwrap();
        let exact = density_target(first.target.clone(), &density);
        for change in 0..12 {
            let mut invalid = exact.clone();
            match change {
                0 => invalid.session_id.push_str("-stale"),
                1 => invalid.preview_id = "unsafe.id".into(),
                2 => invalid.preview_generation = 0,
                3 => invalid.frame_id = 0,
                4 => invalid.config_generation = 0,
                5 => invalid.source_frame_id += 1,
                6 => invalid.render_revision = first.target.render_revision,
                7 => invalid.logical_width += 1,
                8 => invalid.logical_height += 1,
                9 => invalid.width += 1,
                10 => invalid.height += 1,
                _ => invalid.preview_id.clear(),
            }
            assert_eq!(
                density
                    .prepare_raster_presentation(invalid)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
            assert!(density.presentation_ticket().is_none());
        }
        drop(density);
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert_eq!(session.render_revision(), first.target.render_revision);
        assert!(session.is_current_frame_presented());
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn exhausted_density_ticket_is_rejected_before_any_picture_or_input_move() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let revision = session.render_revision();
        let input = session.last_frame_input(revision).cloned();
        session.dev_raster_presentation.next_epoch = None;
        let mut density = session.prepare_dev_density(0.9).unwrap().unwrap();
        let exact = density_target(first.target.clone(), &density);
        assert_eq!(
            density.prepare_raster_presentation(exact).unwrap_err().code,
            BridgeErrorCode::Render
        );
        drop(density);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.last_frame_input(revision), input.as_ref());
        assert!(session.is_current_frame_presented());
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn same_pixels_new_density_installs_only_its_exact_prepared_ticket() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let pixels = session.render_snapshot().unwrap();
        let revision = session.render_revision();
        let epoch = session.dev_raster_presentation.next_epoch;
        let viewport = session.accepted_page_observation().unwrap().frame.viewport;
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .configure_render_target(viewport, 0.9)
            .unwrap();
        assert_eq!(
            session
                .skia_backend
                .renderer
                .peek()
                .unwrap()
                .accepted_render_scale(),
            Some(1.0)
        );
        let mut density = session.prepare_dev_density(0.9).unwrap().unwrap();
        assert_eq!(
            density.picture().target(),
            RenderTargetSize {
                width: 2,
                height: 1
            }
        );
        assert!(density.picture().density_changed());
        let exact = density_target(first.target.clone(), &density);
        let ticket = density.prepare_raster_presentation(exact).unwrap().clone();
        let receipt = density.accept_with_retirement();
        assert_eq!(receipt.render_revision(), revision + 1);
        assert_eq!(session.render_snapshot().unwrap(), pixels);
        assert_eq!(
            session.dev_raster_presentation.next_epoch,
            epoch.and_then(|value| value.checked_add(1))
        );
        assert_input_waits(&mut session);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&first)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        assert!(session.is_current_frame_presented());
        assert!(session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap()
            .messages
            .is_empty());
        drop(receipt);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn changed_density_without_a_prepared_publication_retires_old_exact_authority() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let epoch = session.dev_raster_presentation.next_epoch;
        let receipt = session
            .prepare_dev_density(0.9)
            .unwrap()
            .unwrap()
            .accept_with_retirement();
        assert_input_waits(&mut session);
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&first)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        let mut publication = target(&session);
        publication.config_generation += 1;
        publication.frame_id += 1;
        let next = session.arm_dev_raster_presentation(publication).unwrap();
        assert_ne!(next.presentation_epoch, first.presentation_epoch);
        session.acknowledge_dev_raster_presentation(&next).unwrap();
        assert!(session.is_current_frame_presented());
        drop(receipt);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn prepared_density_publication_never_replays_stateful_view_or_ready_in_either_engine() {
        let source = br#"
            var ready = 0;
            App({});
            Page({data:{count:1},onReady:function(){ready++;}});
            exports.inspect = function(){return ready;};
        "#;
        for engine in enabled_native_engines() {
            let mut session = init_fixture_with_view_source(
                true,
                engine,
                Some(source),
                r#"<wxs module="counter" src="../../shared/counter.wxs"/><view id="target" data-call="{{counter.next()}}" data-count="{{count}}" style="width:2px;height:1px"/>"#,
                Some(b"var calls=0;exports.next=function(){calls++;return calls;};"),
            );
            let attribute = |session: &Session| {
                session
                    .skia_backend
                    .renderer
                    .last_frame()
                    .unwrap()
                    .query("#target", false)
                    .unwrap()[0]
                    .attributes["data-call"]
                    .clone()
            };
            let ready = |session: &mut Session| {
                let batch = session.dispatch(envelope(
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app.js","export":"inspect","args":[]}),
                ));
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                batch.messages[0].payload["result"][0].clone()
            };
            assert_eq!(attribute(&session), "1");
            assert_eq!(ready(&mut session), 0);
            let first = session
                .arm_dev_raster_presentation(target(&session))
                .unwrap();
            session.acknowledge_dev_raster_presentation(&first).unwrap();
            assert_eq!(ready(&mut session), 1);
            let view_revision = session.view.revision;
            let input_lifetime = session.input_lifetime_revision;
            let mut density = session.prepare_dev_density(0.9).unwrap().unwrap();
            let next_target = density_target(first.target.clone(), &density);
            let next = density
                .prepare_raster_presentation(next_target)
                .unwrap()
                .clone();
            let receipt = density.accept_with_retirement();
            assert_eq!(attribute(&session), "1");
            assert_eq!(ready(&mut session), 1);
            assert!(session.dev_raster_target_is_current(&next.target));
            session.acknowledge_dev_raster_presentation(&next).unwrap();
            assert_eq!(ready(&mut session), 1);
            assert_eq!(attribute(&session), "1");
            drop(receipt);
            drop(
                session
                    .prepare_dev_density(0.9)
                    .unwrap()
                    .unwrap()
                    .accept_with_retirement(),
            );
            let mut dropped = session.prepare_dev_density(0.8).unwrap().unwrap();
            let target = density_target(next.target.clone(), &dropped);
            dropped.prepare_raster_presentation(target).unwrap();
            drop(dropped);
            assert_eq!(session.view.revision, view_revision);
            assert_eq!(session.input_lifetime_revision, input_lifetime);
            assert_eq!(attribute(&session), "1");
            let page = session.app_service.pages().current().unwrap().id;
            let patch = session.dispatch(envelope(
                op::DATA_PATCH_BATCH,
                json!({
                    "pageId":page.0,"patches":[{"path":"count","op":"set","value":2}]
                }),
            ));
            assert_eq!(patch.messages[0].payload["ok"], true, "{patch:?}");
            let render = session.dispatch(envelope(
                op::RENDER_COMMIT,
                json!({
                    "templateId":"template:pages/index/index.wxml", "useSessionResources":true,
                    "viewport":{"x":0,"y":0,"width":2,"height":1}
                }),
            ));
            assert_eq!(render.messages[0].payload["ok"], true, "{render:?}");
            assert_eq!(
                attribute(&session),
                "2",
                "explicit render detects hidden stateful evaluations during density preparation"
            );
            assert_eq!(ready(&mut session), 1);
        }
    }

    #[test]
    fn effective_density_backend_preparation_preserves_exact_old_picture_input_and_authority() {
        let mut session = init_fixture(true);
        let first = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session.acknowledge_dev_raster_presentation(&first).unwrap();
        let revision = session.render_revision();
        let input = session.last_frame_input(revision).cloned();
        let pixels = session.render_snapshot().unwrap();
        let epoch = session.dev_raster_presentation.next_epoch;
        let mut prepared = session.prepare_dev_density(0.9).unwrap().unwrap();
        let exact = density_target(first.target.clone(), &prepared);
        prepared.prepare_raster_presentation(exact).unwrap();
        drop(prepared);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.last_frame_input(revision), input.as_ref());
        assert_eq!(session.render_snapshot().unwrap(), pixels);
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert!(session.is_current_frame_presented());
        assert!(session
            .acknowledge_dev_raster_presentation(&first)
            .unwrap()
            .messages
            .is_empty());
    }

    #[test]
    fn hide_show_cannot_revive_same_numeric_revision_authority() {
        let mut session = init_fixture(true);
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        for event in ["hide", "show"] {
            let batch = session.dispatch(envelope(op::APP_LIFECYCLE, json!({"event":event})));
            assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
            assert_input_waits(&mut session);
            assert_eq!(
                session
                    .acknowledge_dev_raster_presentation(&ticket)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
        }
    }

    #[test]
    fn unrestricted_renderer_borrow_retires_authority() {
        let mut session = init_fixture(true);
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        session
            .acknowledge_dev_raster_presentation(&ticket)
            .unwrap();
        let _ = session.renderer_mut();
        assert_input_waits(&mut session);
        assert_eq!(
            session
                .acknowledge_dev_raster_presentation(&ticket)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(
            session
                .acknowledge_presentation(ticket.target.render_revision)
                .unwrap_err()
                .code,
            BridgeErrorCode::UnsupportedCapability
        );
    }

    #[test]
    fn policy_opt_in_is_idempotent_before_init_and_cannot_upgrade_a_live_session() {
        let mut legacy = init_fixture(false);
        assert_eq!(
            legacy.enable_dev_raster_presentation().unwrap_err().code,
            BridgeErrorCode::InvalidRequest
        );
        let mut explicit = init_fixture(true);
        explicit.enable_dev_raster_presentation().unwrap();
        assert_input_waits(&mut explicit);
    }

    #[test]
    fn exhaustion_never_reuses_an_issued_epoch_or_reenables_revision_only_ack() {
        let mut session = init_fixture(true);
        session.dev_raster_presentation.next_epoch = Some(u64::MAX);
        let ticket = session
            .arm_dev_raster_presentation(target(&session))
            .unwrap();
        assert_eq!(ticket.presentation_epoch, u64::MAX.to_string());
        session.suspend_dev_raster_presentation();
        assert_eq!(
            session
                .arm_dev_raster_presentation(target(&session))
                .unwrap_err()
                .code,
            BridgeErrorCode::Render
        );
        assert_input_waits(&mut session);
        assert_eq!(
            session
                .acknowledge_presentation(ticket.target.render_revision)
                .unwrap_err()
                .code,
            BridgeErrorCode::UnsupportedCapability
        );
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn real_engine_page_ready_waits_for_receipt_and_runs_once() {
        let source = br#"
            var ready = 0;
            App({});
            Page({onReady:function(){ready += 1;}});
            exports.readyCount = function(){return ready;};
        "#;
        for engine in enabled_native_engines() {
            for explicit in [false, true] {
                let mut session = init_fixture_for_engine(explicit, engine, Some(source));
                let count = |session: &mut Session| {
                    let batch = session.dispatch(envelope(
                        op::MODULE_CALL,
                        json!({
                            "moduleId":"module:app.js", "export":"readyCount", "args":[]
                        }),
                    ));
                    assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                    batch.messages[0].payload["result"].clone()
                };
                assert_eq!(count(&mut session), json!([if explicit { 0 } else { 1 }]));
                if explicit {
                    assert_input_waits(&mut session);
                    let ticket = session
                        .arm_dev_raster_presentation(target(&session))
                        .unwrap();
                    assert_eq!(count(&mut session), json!([0]));
                    session
                        .acknowledge_dev_raster_presentation(&ticket)
                        .unwrap();
                    assert_eq!(count(&mut session), json!([1]));
                    session
                        .acknowledge_dev_raster_presentation(&ticket)
                        .unwrap();
                    assert_eq!(count(&mut session), json!([1]));
                    session.suspend_dev_raster_presentation();
                    let next = session
                        .arm_dev_raster_presentation(target(&session))
                        .unwrap();
                    session.acknowledge_dev_raster_presentation(&next).unwrap();
                    assert_eq!(count(&mut session), json!([1]));
                }
            }
        }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn native_retained_manifest_ready_survives_owner_retirement_once() {
        let source = br#"
            var ready = 0;
            App({});
            Page({onReady:function(){ready += 1;}});
            exports.readyCount = function(){return ready;};
        "#;
        for engine in enabled_native_engines() {
            let mut session = init_fixture_for_engine(true, engine, Some(source));
            let count = |session: &mut Session| {
                let batch = session.dispatch(envelope(
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app.js","export":"readyCount","args":[]}),
                ));
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                batch.messages[0].payload["result"].clone()
            };
            let revision = session.render_revision();
            let original = session
                .arm_dev_raster_presentation(target(&session))
                .unwrap();
            assert_eq!(count(&mut session), json!([0]));
            session.retire_dev_preview("first-preview-binding").unwrap();
            assert!(session.pending_presentation.is_none());
            assert!(session.has_current_skia_scene());
            assert_input_waits(&mut session);
            assert_eq!(
                session
                    .acknowledge_dev_raster_presentation(&original)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Cancelled
            );
            assert_eq!(count(&mut session), json!([0]));
            let mut next_target = target(&session);
            next_target.preview_generation = 2;
            let next = session.arm_dev_raster_presentation(next_target).unwrap();
            assert_ne!(next.presentation_epoch, original.presentation_epoch);
            assert_eq!(count(&mut session), json!([0]));
            session.acknowledge_dev_raster_presentation(&next).unwrap();
            assert_eq!(count(&mut session), json!([1]));
            session.acknowledge_dev_raster_presentation(&next).unwrap();
            assert_eq!(count(&mut session), json!([1]));
            session
                .retire_dev_preview("second-preview-binding")
                .unwrap();
            assert_input_waits(&mut session);
            let mut last_target = target(&session);
            last_target.preview_generation = 3;
            let last = session.arm_dev_raster_presentation(last_target).unwrap();
            session.acknowledge_dev_raster_presentation(&last).unwrap();
            assert_eq!(count(&mut session), json!([1]));
            assert_eq!(session.render_revision(), revision);
        }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn reconnected_lease_observes_suspended_registration_after_timer_consumes_pending_work() {
        let source = br#"
            var ready = 0, timers = 0, observed = [];
            App({});
            Page({onReady:function(){ready += 1;}});
            exports.observe = function() {
                var page = getCurrentPages()[0];
                var observer = wx.createIntersectionObserver(page, {thresholds:[0]});
                observer.relativeToViewport().observe('#target', function(value) {
                    observed.push(value.intersectionRatio);
                    page.setData({observerCount:observed.length});
                });
            };
            exports.scheduleTimer = function() {
                setTimeout(function(){timers += 1;}, 0);
            };
            exports.inspect = function() {
                return {ready:ready,timers:timers,observed:observed.slice()};
            };
        "#;
        for engine in enabled_native_engines() {
            let mut session = init_fixture_for_engine(true, engine, Some(source));
            let call = |session: &mut Session, name: &str| {
                let batch = session.dispatch(envelope(
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app.js","export":name,"args":[]}),
                ));
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                batch.messages[0].payload["result"][0].clone()
            };
            let first = session
                .arm_dev_raster_presentation(target(&session))
                .unwrap();
            session.acknowledge_dev_raster_presentation(&first).unwrap();
            let revision = session.render_revision();
            assert_eq!(
                call(&mut session, "inspect"),
                json!({
                    "ready":1,"timers":0,"observed":[]
                })
            );

            // Disconnect keeps pixels but withdraws geometry. Register the
            // real JS callback while suspended, then let a real timer turn
            // consume the pending observation marker without a usable frame.
            session.suspend_dev_raster_presentation();
            call(&mut session, "observe");
            assert!(session.observer_observation_pending);
            call(&mut session, "scheduleTimer");
            let suspended = session.poll_timers(unix_now_ns().saturating_add(1_000_000_000));
            assert!(!suspended
                .messages
                .iter()
                .any(|message| message.payload["type"] == "observer.batch"));
            assert!(!session.observer_observation_pending);
            assert_input_waits(&mut session);
            assert_eq!(
                call(&mut session, "inspect"),
                json!({
                    "ready":1,"timers":1,"observed":[]
                })
            );
            assert_eq!(session.render_revision(), revision);

            let mut reconnect_target = target(&session);
            reconnect_target.preview_generation += 1;
            let reconnect = session
                .arm_dev_raster_presentation(reconnect_target)
                .unwrap();
            assert_ne!(reconnect.presentation_epoch, first.presentation_epoch);
            assert_eq!(
                reconnect.target.render_revision,
                first.target.render_revision
            );
            assert_input_waits(&mut session);
            let accepted = session
                .acknowledge_dev_raster_presentation(&reconnect)
                .unwrap();
            let batches: Vec<_> = accepted
                .messages
                .iter()
                .filter(|message| message.payload["type"] == "observer.batch")
                .collect();
            assert_eq!(batches.len(), 1, "{accepted:?}");
            assert_eq!(
                batches[0].payload["observations"].as_array().unwrap().len(),
                1
            );
            let observed = call(&mut session, "inspect");
            assert_eq!(observed["ready"], 1);
            assert_eq!(observed["timers"], 1);
            assert_eq!(observed["observed"].as_array().unwrap().len(), 1);
            assert_eq!(observed["observed"][0].as_f64(), Some(1.0));
            assert_eq!(
                session.app_service.pages().current().unwrap().data["observerCount"],
                1
            );
            assert!(session.is_current_frame_presented());
            assert_eq!(session.render_revision(), revision);

            // The same accepted ticket is the dedupe key. It cannot replay
            // ready, observer callbacks or their setData effects.
            let template_revision = session.view.template_revision;
            assert!(session
                .acknowledge_dev_raster_presentation(&reconnect)
                .unwrap()
                .messages
                .is_empty());
            assert_eq!(call(&mut session, "inspect"), observed);
            assert_eq!(session.view.template_revision, template_revision);
        }
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    #[test]
    fn selector_scroll_timer_waits_for_reconnected_presentation_but_numeric_intent_does_not() {
        let source = br#"
            var ready = 0, timers = 0, scrolls = 0, successes = 0, completed = 0;
            var failures = [];
            App({});
            Page({
                onReady:function(){ready += 1;},
                onPageScroll:function(){scrolls += 1;}
            });
            function schedule(options) {
                setTimeout(function() {
                    timers += 1;
                    options.duration = 0;
                    options.success = function(){successes += 1;};
                    options.fail = function(error){failures.push(error.code);};
                    options.complete = function(){completed += 1;};
                    wx.pageScrollTo(options);
                }, 0);
            }
            exports.scheduleSelector = function(){schedule({selector:'#target'});};
            exports.scheduleNumeric = function(){schedule({scrollTop:0});};
            exports.inspect = function() {
                return {ready:ready,timers:timers,scrolls:scrolls,successes:successes,
                    completed:completed,failures:failures.slice()};
            };
        "#;
        for engine in enabled_native_engines() {
            let mut session = init_fixture_with_template(
                true,
                engine,
                Some(source),
                "<view style=\"height:40px\"><view id=\"target\" style=\"margin-top:20px;width:2px;height:1px\"/></view>",
            );
            let call = |session: &mut Session, name: &str| {
                let batch = session.dispatch(envelope(
                    op::MODULE_CALL,
                    json!({"moduleId":"module:app.js","export":name,"args":[]}),
                ));
                assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
                batch.messages[0].payload["result"][0].clone()
            };
            let first = session
                .arm_dev_raster_presentation(target(&session))
                .unwrap();
            session.acknowledge_dev_raster_presentation(&first).unwrap();
            let revision = session.render_revision();
            let frame = session.skia_backend.renderer.last_frame().unwrap().clone();
            let pixels = session.render_snapshot().unwrap();
            let scrolling = format!("{:?}", session.scrolling);

            session.suspend_dev_raster_presentation();
            call(&mut session, "scheduleSelector");
            let suspended = session.poll_timers(unix_now_ns().saturating_add(1_000_000_000));
            assert!(
                suspended
                    .messages
                    .iter()
                    .all(|message| message.op != op::ERROR),
                "API rejection must reach fail/complete callbacks: {suspended:?}"
            );
            assert_eq!(
                call(&mut session, "inspect"),
                json!({
                    "ready":1,"timers":1,"scrolls":0,"successes":0,
                    "completed":1,"failures":["ERR_RENDER"]
                })
            );
            assert_input_waits(&mut session);
            assert_eq!(session.render_revision(), revision);
            assert_eq!(session.skia_backend.renderer.last_frame(), Some(&frame));
            assert_eq!(session.render_snapshot().unwrap(), pixels);
            assert_eq!(format!("{:?}", session.scrolling), scrolling);
            // Even an invalid selector is refused before the retained tree's
            // selector parser or geometry can be consulted.
            let invalid_selector = json!({"selector":"[", "duration":0});
            assert_eq!(
                session
                    .page_scroll_to(invalid_selector.as_object().unwrap(), None, None)
                    .unwrap_err()
                    .code,
                BridgeErrorCode::Render
            );

            let mut reconnect_target = target(&session);
            reconnect_target.preview_generation += 1;
            let reconnect = session
                .arm_dev_raster_presentation(reconnect_target)
                .unwrap();
            assert_ne!(reconnect.presentation_epoch, first.presentation_epoch);
            session
                .acknowledge_dev_raster_presentation(&reconnect)
                .unwrap();
            call(&mut session, "scheduleSelector");
            session.poll_timers(unix_now_ns().saturating_add(1_000_000_000));
            assert_eq!(
                call(&mut session, "inspect"),
                json!({
                    "ready":1,"timers":2,"scrolls":1,"successes":1,
                    "completed":2,"failures":["ERR_RENDER"]
                })
            );
            assert!(session.render_revision() > revision);
            assert!(
                session
                    .skia_backend
                    .renderer
                    .last_frame()
                    .unwrap()
                    .root
                    .scroll_offset
                    .unwrap()
                    .scroll_top
                    > 0.0
            );

            // Business timers and explicit numeric scroll intent continue
            // while the newly scrolled pixels await their own presentation.
            session.suspend_dev_raster_presentation();
            call(&mut session, "scheduleNumeric");
            session.poll_timers(unix_now_ns().saturating_add(1_000_000_000));
            assert_eq!(
                call(&mut session, "inspect"),
                json!({
                    "ready":1,"timers":3,"scrolls":2,"successes":2,
                    "completed":3,"failures":["ERR_RENDER"]
                })
            );
            assert_eq!(
                session
                    .skia_backend
                    .renderer
                    .last_frame()
                    .unwrap()
                    .root
                    .scroll_offset
                    .unwrap()
                    .scroll_top,
                0.0
            );
        }
    }

    #[test]
    fn prepared_ticket_borrows_exact_accepted_pixels_without_readback_or_clone() {
        let mut session = init_fixture(true);
        let (frame_pointer, pixels_pointer, snapshot_pointer, revision, target_size) = {
            let observed = session.accepted_page_observation().unwrap();
            let snapshot = observed.snapshot.unwrap();
            (
                observed.frame as *const RenderFrame,
                snapshot.pixels.as_ptr(),
                snapshot as *const RenderSnapshot,
                observed.render_revision,
                observed.target,
            )
        };
        let target = target(&session);
        let epoch = session.dev_raster_presentation.next_epoch;
        let prepared = session
            .prepare_dev_raster_presentation(target.clone())
            .unwrap();
        let observed = prepared.accepted_page_observation();
        let snapshot = observed.snapshot.unwrap();
        assert_eq!(observed.frame as *const RenderFrame, frame_pointer);
        assert_eq!(snapshot as *const RenderSnapshot, snapshot_pointer);
        assert_eq!(snapshot.pixels.as_ptr(), pixels_pointer);
        assert_eq!(observed.render_revision, revision);
        assert_eq!(observed.target, target_size);
        assert_eq!(prepared.ticket().target, target);
        assert_eq!(snapshot.frame_id, prepared.ticket().target.source_frame_id);
        drop(prepared);
        assert_eq!(session.dev_raster_presentation.next_epoch, epoch);
        assert!(!session.is_current_frame_presented());
        assert_eq!(
            session
                .accepted_page_observation()
                .unwrap()
                .snapshot
                .unwrap()
                .pixels
                .as_ptr(),
            pixels_pointer
        );
    }

    #[test]
    fn current_ticket_observation_tracks_prepare_accept_ack_suspend_and_input_lifetime() {
        // The same full bridge handshake works with the headless boundary or
        // an actually compiled provider. This case proves authorization state;
        // it does not claim native JS execution when the provider is absent.
        let mut session = init_fixture(true);
        let exact = target(&session);
        assert!(session.current_dev_raster_presentation_ticket().is_none());
        let prepared = session
            .prepare_dev_raster_presentation(exact.clone())
            .unwrap();
        let proposed = prepared.ticket().clone();
        drop(prepared);
        assert!(session.current_dev_raster_presentation_ticket().is_none());
        let issued = session.arm_dev_raster_presentation(exact.clone()).unwrap();
        assert_eq!(issued, proposed, "discarding preparation spent an epoch");
        assert_eq!(
            session.current_dev_raster_presentation_ticket(),
            Some(&issued)
        );
        assert!(!session.is_current_frame_presented());
        session
            .acknowledge_dev_raster_presentation(&issued)
            .unwrap();
        assert_eq!(
            session.current_dev_raster_presentation_ticket(),
            Some(&issued)
        );
        session.suspend_dev_raster_presentation();
        assert!(session.current_dev_raster_presentation_ticket().is_none());
        let next = session.arm_dev_raster_presentation(exact).unwrap();
        assert_ne!(issued.presentation_epoch, next.presentation_epoch);
        assert_eq!(
            session.current_dev_raster_presentation_ticket(),
            Some(&next)
        );
        let previous = session.input_lifetime_revision;
        session.retire_browser_input_lifetime();
        assert_ne!(session.input_lifetime_revision, previous);
        assert!(session.current_dev_raster_presentation_ticket().is_none());
    }
}
