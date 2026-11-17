//! Logical developer resize: irreversible application work, then C2 picture
//! preparation, then an infallible joint-publication handoff. No callback is
//! invoked by acceptance or abort.
use super::*;
use container_render_skia::PreparedPageFrame;
use host_environment::{LogicalGeometryAbort, LogicalGeometryUndo, OwnedWindowGeometry};
use render_backend::{AcceptedSkiaPageRetirement, PreparedSkiaPage, PreparedSkiaSettings};

/// Effects already consumed by the runtime survive every later preparation,
/// engine-turn completion or publication failure. No candidate was accepted.
#[derive(Debug)]
pub struct DevLogicalResizeFailure {
    pub error: BridgeError,
    pub effects: BridgeBatch,
}

impl fmt::Display for DevLogicalResizeFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.error)
    }
}

impl std::error::Error for DevLogicalResizeFailure {}

struct LogicalResizeSource {
    session_id: String,
    page_id: PageId,
    route: String,
    profile: container_ir::RendererProfile,
    manifest_root: String,
    resources: RenderResources,
    lifecycle_sequence: u64,
}

/// Captured inside metrics installation, before contact/resize/component work.
/// In particular this is the lifetime *after* the intentional owner retirement.
pub(super) struct LogicalResizeFence {
    source: LogicalResizeSource,
    input_lifetime: u64,
    geometry_epoch: u64,
}

impl LogicalResizeSource {
    fn capture(session: &mut Session) -> Result<Self, BridgeError> {
        session.ensure_initialized()?;
        session.ensure_engine_execution_healthy()?;
        if session.app_service.lifecycle().state() != container_core::LifecycleState::Active {
            return Err(cancelled("logical resize requires an active application"));
        }
        let page = session
            .app_service
            .pages()
            .current()
            .ok_or_else(|| cancelled("logical resize requires a current page"))?;
        let profile = session.renderer_profile_for_route(&page.path);
        if profile.layout_authority() != container_ir::LayoutAuthority::Rust {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "logical Skia resize cannot prepare a WebView page",
            ));
        }
        Ok(Self {
            session_id: session.config.session_id.clone(),
            page_id: page.id,
            route: page.path.clone(),
            profile,
            manifest_root: session.manifest.integrity.root.clone(),
            resources: Arc::clone(&session.render_blobs),
            lifecycle_sequence: session.app_service.lifecycle().sequence(),
        })
    }

    fn validate(&self, session: &mut Session) -> Result<(), BridgeError> {
        session.ensure_engine_execution_healthy()?;
        if session.config.session_id != self.session_id
            || session.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || session.app_service.lifecycle().sequence() != self.lifecycle_sequence
            || session.manifest.integrity.root != self.manifest_root
            || !Arc::ptr_eq(&session.render_blobs, &self.resources)
            || !session.render_resources_verified
            || !session.app_service.pages().current().is_some_and(|page| {
                page.id == self.page_id
                    && page.path == self.route
                    && session.renderer_profile_for_route(&page.path) == self.profile
            })
        {
            return Err(cancelled(
                "logical resize source was retired during application work",
            ));
        }
        Ok(())
    }
}

impl LogicalResizeFence {
    fn capture(session: &mut Session, source: LogicalResizeSource) -> Result<Self, BridgeError> {
        source.validate(session)?;
        Ok(Self {
            source,
            input_lifetime: session
                .input_lifetime_revision
                .ok_or_else(|| cancelled("logical resize input lifetime is exhausted"))?,
            geometry_epoch: session.logical_geometry_epoch(),
        })
    }

    pub(super) fn validate(&self, session: &mut Session) -> Result<(), BridgeError> {
        self.source.validate(session)?;
        if session.input_lifetime_revision != Some(self.input_lifetime)
            || session.logical_geometry_epoch() != self.geometry_epoch
        {
            return Err(cancelled(
                "logical resize authority changed during application work",
            ));
        }
        Ok(())
    }
}

fn cancelled(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

struct LogicalResizeWork {
    // None is chosen from the initial scene state, before any hooks. It must
    // remain settings-only even if application work dirties/changes the page.
    page: Option<(PreparedSkiaFrame, scrolling::ScrollRegistry)>,
    fence: LogicalResizeFence,
}

// One exclusive, transient candidate per resize, never a collection per node.
// Keep the alternatives inline so final publication only moves prepared fields.
#[expect(
    clippy::large_enum_variant,
    reason = "single exclusive resize transaction avoids heap allocation/deallocation during final joint publication"
)]
enum PreparedLogicalPage<'a> {
    Picture {
        page: PreparedSkiaPage<'a>,
        scrolling: scrolling::ScrollRegistry,
    },
    Settings(PreparedSkiaSettings<'a>),
}

struct PublicationSlots<'a> {
    owned_canvases: &'a mut owned_canvas::OwnedCanvasState,
    input: &'a mut Option<frame_input::CommittedFrameInput>,
    authority: &'a mut Option<SkiaFrameAuthority>,
    scrolling: &'a mut scrolling::ScrollRegistry,
    document: &'a mut Option<container_ir::ViewDocument>,
    scene: &'a mut bool,
    resources: &'a mut RenderResources,
    resources_verified: &'a mut bool,
    last_frame_id: &'a mut Option<u64>,
    observer_page: &'a mut Option<PageId>,
    observer_valid: &'a mut bool,
    presented: &'a mut Option<u64>,
    pending: &'a mut Option<(Option<PageId>, u64, bool)>,
    observation_pending: &'a mut bool,
    raster: &'a mut dev_raster_presentation::DevRasterPresentationState,
    native_animations: &'a mut Option<(u64, PreparedAnimations)>,
    animation_scene: &'a mut Option<render_backend::RetainedAnimationScene>,
    animation_sample: &'a mut Option<(u64, animation_protocol::ConsumedSample)>,
    animation_attempt: &'a mut Option<(u64, u64)>,
}

/// Holds the runtime owner until accepted or dropped. A present C2 picture
/// already contains Raster pixels or the exact External/NativeGpu export. A
/// missing current scene yields settings only; its first View stays with the
/// ordinary owner pump.
#[must_use = "drop aborts owned geometry without accepting the picture"]
pub struct PreparedDevLogicalResize<'a> {
    page: PreparedLogicalPage<'a>,
    prepared_authority: Option<SkiaFrameAuthority>,
    canvas_bindings: Option<owned_canvas::PreparedCanvasBindings>,
    geometry: LogicalGeometryAbort<'a>,
    slots: PublicationSlots<'a>,
    page_id: PageId,
    consumed: Option<BrowserPageInput>,
    effects: BridgeBatch,
    publication_context: Option<dev_raster_presentation::DevRasterPublicationContext>,
    presentation: Option<dev_raster_presentation::PreparedRasterLease>,
}

/// Former page allocations stay alive through the Web publication critical
/// section. Take effects only after unlocking; this receipt runs no hooks.
#[must_use = "retain until outside the joint publication critical section"]
pub struct AcceptedDevLogicalResize {
    page: Option<AcceptedSkiaPageRetirement>,
    _canvas_bindings: Option<owned_canvas::RetiredCanvasBindings>,
    _input: Option<frame_input::CommittedFrameInput>,
    _authority: Option<SkiaFrameAuthority>,
    _scrolling: Option<scrolling::ScrollRegistry>,
    _document: Option<container_ir::ViewDocument>,
    _resources: Option<RenderResources>,
    _native_animations: Option<(u64, PreparedAnimations)>,
    _animation_scene: Option<render_backend::RetainedAnimationScene>,
    _geometry: Option<LogicalGeometryUndo>,
    _presentation: Option<AcceptedDevRasterPresentation>,
    _context: Option<dev_raster_presentation::DevRasterPublicationContext>,
    consumed: Option<BrowserPageInput>,
    effects: BridgeBatch,
    exact_raster_presentation: bool,
}

impl AcceptedDevLogicalResize {
    pub fn render_revision(&self) -> Option<u64> {
        self.page
            .as_ref()
            .map(|page| page.picture.render_revision())
    }

    pub fn requires_exact_raster_presentation(&self) -> bool {
        self.exact_raster_presentation
    }

    pub fn consumed_page_input(&self) -> Option<&BrowserPageInput> {
        self.consumed.as_ref()
    }

    pub fn take_effects(&mut self) -> BridgeBatch {
        std::mem::replace(&mut self.effects, BridgeBatch::new(Vec::new()))
    }
}

impl PreparedDevLogicalResize<'_> {
    /// None means only validated settings are staged, with no View evaluation
    /// or page renderer creation. Do not ACK or advance rendered-state then.
    pub fn picture(&self) -> Option<&PreparedPageFrame<'_>> {
        match &self.page {
            PreparedLogicalPage::Picture { page, .. } => Some(page.picture()),
            PreparedLogicalPage::Settings(_) => None,
        }
    }

    pub fn consumed_page_input(&self) -> Option<&BrowserPageInput> {
        self.consumed.as_ref()
    }

    pub fn requires_exact_raster_presentation(&self) -> bool {
        self.picture()
            .is_some_and(|picture| picture.page_render_mode() == PageRenderMode::Raster)
            && self.slots.raster.is_explicit()
    }

    pub fn effects(&self) -> &BridgeBatch {
        &self.effects
    }

    /// A rejected external reservation must still deliver effects consumed by
    /// resize/View work. Take them before dropping this candidate, after unlock.
    pub fn take_effects(&mut self) -> BridgeBatch {
        std::mem::replace(&mut self.effects, BridgeBatch::new(Vec::new()))
    }

    pub fn prepare_raster_presentation(
        &mut self,
        target: DevRasterPresentationTarget,
    ) -> Result<&DevRasterPresentationTicket, BridgeError> {
        let context = self.publication_context.as_ref().ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "exact developer Raster presentation is not enabled for this candidate",
            )
        })?;
        let page = match &self.page {
            PreparedLogicalPage::Picture { page, .. } => page,
            PreparedLogicalPage::Settings(_) => {
                return Err(cancelled(
                    "settings-only resize has no Raster picture to present",
                ));
            }
        };
        self.presentation =
            Some(context.prepare_page_ticket(self.slots.raster, page.picture(), target)?);
        Ok(self.presentation_ticket().expect("prepared above"))
    }

    pub fn presentation_ticket(&self) -> Option<&DevRasterPresentationTicket> {
        self.presentation.as_ref().map(|prepared| prepared.ticket())
    }

    /// All validation, JS, layout, allocation, image decode, paint and optional
    /// readback have finished. Only prepared field moves occur here. The owner
    /// must complete presentation/ready on its lane after the Web unlock.
    pub fn accept_with_retirement(self) -> AcceptedDevLogicalResize {
        let exact_raster_presentation = self.requires_exact_raster_presentation();
        let mut retired_canvas_bindings = None;
        // Keep prior animation allocations in the retirement receipt until
        // after the caller leaves its publication critical section.
        let retired_native_animations = self.slots.native_animations.take();
        let retired_animation_scene = self.slots.animation_scene.take();
        *self.slots.animation_sample = None;
        *self.slots.animation_attempt = None;
        let (page, input, authority, scrolling, document, resources, presentation) = match self.page
        {
            PreparedLogicalPage::Settings(settings) => {
                settings.accept();
                // Do not relabel an old-route scene, input proof, resources,
                // pending ready or render revision as belonging to this page.
                let authority = self.slots.authority.take();
                (None, None, authority, None, None, None, None)
            }
            PreparedLogicalPage::Picture { page, scrolling } => {
                let revision = page.picture().render_revision();
                let (frame_id, manifest, page) = page.accept();
                *self.slots.animation_sample = manifest
                    .animations
                    .as_ref()
                    .and_then(|animations| animations.playback.consumed_sample)
                    .map(|sample| (revision, sample));
                *self.slots.native_animations =
                    manifest.animations.map(|animations| (revision, animations));
                *self.slots.animation_scene = manifest.retained_animation_scene;
                if let Some(bindings) = self.canvas_bindings {
                    retired_canvas_bindings =
                        Some(self.slots.owned_canvases.accept_bindings(bindings));
                }
                let input = manifest
                    .page_input
                    .map(|input| frame_input::CommittedFrameInput { revision, input });
                let input = std::mem::replace(self.slots.input, input);
                // The new layout is authoritative only after its prepared
                // picture has actually been accepted. This move is infallible
                // and runs no Session callbacks inside joint publication.
                let authority = std::mem::replace(self.slots.authority, self.prepared_authority);
                let scrolling = std::mem::replace(self.slots.scrolling, scrolling);
                let document = self.slots.document.replace(manifest.document);
                let resources = std::mem::replace(self.slots.resources, manifest.resources);
                *self.slots.scene = true;
                *self.slots.resources_verified = true;
                *self.slots.last_frame_id = Some(frame_id);
                *self.slots.observer_page = Some(self.page_id);
                *self.slots.observer_valid = false;
                *self.slots.presented = None;
                *self.slots.pending = Some((Some(self.page_id), frame_id, true));
                *self.slots.observation_pending = false;
                let presentation = match self.presentation {
                    Some(prepared) => prepared.install(self.slots.raster),
                    None => self.slots.raster.suspend_with_retirement(),
                };
                (
                    Some(page),
                    input,
                    authority,
                    Some(scrolling),
                    document,
                    Some(resources),
                    Some(presentation),
                )
            }
        };
        AcceptedDevLogicalResize {
            _canvas_bindings: retired_canvas_bindings,
            page,
            _input: input,
            _authority: authority,
            _scrolling: scrolling,
            _document: document,
            _resources: resources,
            _native_animations: retired_native_animations,
            _animation_scene: retired_animation_scene,
            _geometry: self.geometry.accept(),
            _presentation: presentation,
            _context: self.publication_context,
            consumed: self.consumed,
            effects: self.effects,
            exact_raster_presentation,
        }
    }
}

impl Session {
    /// Prepare a logical-size generation without changing accepted pixels.
    /// Failed preparation retains irreversible hooks/effects, restores only
    /// still-owned geometry, and leaves old coordinate-system input retired.
    pub fn prepare_dev_logical_resize(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<PreparedDevLogicalResize<'_>, DevLogicalResizeFailure> {
        let mut effects = BridgeBatch::new(Vec::new());
        let preflight = (|| {
            self.validate_skia_render_target(viewport, scale)
                .map_err(render_bridge_error)?;
            if viewport.x != 0.0
                || viewport.y != 0.0
                || viewport.width <= 0.0
                || viewport.height <= 0.0
                || viewport.width.fract() != 0.0
                || viewport.height.fract() != 0.0
            {
                return Err(BridgeError::new(
                    BridgeErrorCode::Render,
                    "developer logical viewport must have a zero origin and positive integral dimensions",
                ));
            }
            let source = LogicalResizeSource::capture(self)?;
            source.validate(self)?;
            let materialize = self.has_current_skia_scene();
            let frame_id = if materialize {
                self.render_revision()
                    .checked_add(1)
                    .ok_or_else(|| cancelled("logical resize render revision is exhausted"))?;
                self.view
                    .last_frame_id
                    .unwrap_or(0)
                    .checked_add(1)
                    .ok_or_else(|| cancelled("logical resize frame identity is exhausted"))?
            } else {
                0
            };
            let changed = self.config.host.window_width != viewport.width as u32
                || self.config.host.window_height != viewport.height as u32;
            if changed
                && self
                    .input_lifetime_revision
                    .and_then(|value| value.checked_add(1))
                    .is_none()
            {
                return Err(cancelled("logical resize input lifetime is exhausted"));
            }
            let template_id = if materialize {
                self.manifest
                    .templates
                    .iter()
                    .find(|template| {
                        template
                            .id
                            .strip_prefix("template:")
                            .unwrap_or(&template.id)
                            .strip_suffix(".wxml")
                            .unwrap_or(&template.id)
                            == source.route
                    })
                    .map(|template| template.id.clone())
                    .ok_or_else(|| {
                        BridgeError::new(
                            BridgeErrorCode::Render,
                            "current page has no manifest template",
                        )
                    })?
            } else {
                String::new()
            };
            Ok((source, frame_id, changed, template_id, materialize))
        })();
        let (source, frame_id, changed, template_id, materialize) =
            preflight.map_err(|error| DevLogicalResizeFailure {
                error,
                effects: BridgeBatch::new(Vec::new()),
            })?;
        let mut undo = None;
        let mut output = None;
        let completion = self.with_engine_host_turn(None, |session| {
            output = Some((|| {
                source.validate(session)?;
                if changed {
                    let previous = OwnedWindowGeometry::capture(&session.config.host);
                    session.mark_engine_host_environment_dirty()?;
                    session.config.host.window_width = viewport.width as u32;
                    session.config.host.window_height = viewport.height as u32;
                    undo = Some(session.capture_logical_geometry_undo(previous));
                    // This is a pure owner retirement; no contact callback or
                    // pending application job may precede the fence below.
                    session.retire_browser_input_lifetime();
                    session.observer_frame_valid = false;
                    session.presented_revision = None;
                    session.pending_presentation = None;
                    session.observer_observation_pending = false;
                }
                let fence = LogicalResizeFence::capture(session, source)?;
                if changed {
                    session.prepare_engine_environment()?;
                    let contacts = session.settle_browser_contact_retirement("viewport-resized");
                    session.invalidate_browser_candidate();
                    contacts?;
                    fence.validate(session)?;
                    if session.engine_provider_available() {
                        session.sync_engine_capabilities()?;
                    }
                    session.deliver_window_resize_hooks_with_fence(
                        viewport.width as u32,
                        viewport.height as u32,
                        Some(&fence),
                        &mut effects.messages,
                    )?;
                    fence.validate(session)?;
                }
                if !materialize {
                    // The ordinary owner pump owns the first View/render of
                    // this PageId. Settings must not evaluate the previous
                    // scene or allocate a lazy renderer to manufacture one.
                    fence.validate(session)?;
                    return Ok(LogicalResizeWork { page: None, fence });
                }
                let payload = json!({
                    "templateId": template_id,
                    "frameId": frame_id,
                    "viewport": viewport,
                    "useSessionResources": true,
                });
                let mut frame = session.build_manifest_frame_with_preview(
                    payload.as_object().expect("object literal"),
                    None,
                )?;
                // Component hooks may have produced effects after the root
                // data clone. Retain them without refreshing its input proof.
                session.append_engine_effects(&mut effects.messages)?;
                fence.validate(session)?;
                let mut scrolling = session.scrolling.clone();
                scrolling.reconcile(Some(fence.source.page_id), frame.frame_mut(), true)?;
                Ok(LogicalResizeWork {
                    page: Some((frame, scrolling)),
                    fence,
                })
            })());
            Ok(())
        });
        let work = match (completion, output) {
            (Err(error), _) => return Err(self.fail_dev_logical_resize(error, effects, undo)),
            (Ok(()), Some(Err(error))) => {
                return Err(self.fail_dev_logical_resize(error, effects, undo))
            }
            (Ok(()), Some(Ok(work))) => work,
            (Ok(()), None) => unreachable!("host turn did not invoke resize work"),
        };
        if let Err(error) = work.fence.validate(self) {
            return Err(self.fail_dev_logical_resize(error, effects, undo));
        }
        self.append_browser_retirement_messages(&mut effects.messages);
        let consumed = work
            .page
            .as_ref()
            .and_then(|(frame, _)| frame.page_input())
            .cloned();
        let page_id = work.fence.source.page_id;
        let publication_context = work
            .page
            .as_ref()
            .and_then(|_| self.dev_raster_logical_publication_context());
        let input_lifetime = Some(work.fence.input_lifetime);
        let host_width = self.config.host.window_width;
        let host_height = self.config.host.window_height;
        let canvas_bindings = match work.page.as_ref() {
            Some((frame, _)) => match self.prepare_owned_canvas_bindings(frame.frame(), true) {
                Ok(bindings) => Some(bindings),
                Err(error) => return Err(self.fail_dev_logical_resize(error, effects, undo)),
            },
            None => None,
        };
        let canvas_keys = canvas_bindings
            .as_ref()
            .map(|bindings| bindings.keys.clone())
            .unwrap_or_default();
        if let Some(animations) = work.page.as_ref().and_then(|(frame, _)| frame.animations()) {
            if let Err(error) = self.validate_prepared_animations(animations) {
                return Err(self.fail_dev_logical_resize(error, effects, undo));
            }
        }
        // Construct the pure abort guard before C2, so all raster/readback
        // failures take the same owned-geometry abort path via normal Drop.
        let geometry = LogicalGeometryAbort::new(
            &mut self.config.host,
            &mut self.engine_host_environment,
            undo,
        );
        let prepared_page = match work.page {
            Some((frame, scrolling)) => self
                .skia_backend
                .prepare_dev_page(frame, scale, canvas_keys)
                .map(|page| PreparedLogicalPage::Picture { page, scrolling }),
            None => self
                .skia_backend
                .prepare_dev_settings(viewport, scale)
                .map(PreparedLogicalPage::Settings),
        };
        let page = match prepared_page {
            Ok(page) => page,
            Err(error) => return Err(DevLogicalResizeFailure { error, effects }),
        };
        // Prepare the scalar authority candidate outside joint publication.
        // Settings alone never certify retained pixels as a newly laid out
        // page, even when an old renderer still has a scene to inspect.
        let prepared_authority = match &page {
            PreparedLogicalPage::Picture { page, .. } => SkiaFrameAuthority::from_accepted_frame(
                page.picture().render_revision(),
                Some(page_id),
                input_lifetime,
                host_width,
                host_height,
                page.picture().frame().viewport,
            ),
            PreparedLogicalPage::Settings(_) => None,
        };
        Ok(PreparedDevLogicalResize {
            page,
            prepared_authority,
            canvas_bindings,
            geometry,
            slots: PublicationSlots {
                owned_canvases: &mut self.owned_canvases,
                input: &mut self.committed_frame_input,
                authority: &mut self.skia_frame_authority,
                scrolling: &mut self.scrolling,
                document: &mut self.accepted_view_document,
                scene: &mut self.accepted_skia_scene,
                resources: &mut self.render_blobs,
                resources_verified: &mut self.render_resources_verified,
                last_frame_id: &mut self.view.last_frame_id,
                observer_page: &mut self.observer_frame_page,
                observer_valid: &mut self.observer_frame_valid,
                presented: &mut self.presented_revision,
                pending: &mut self.pending_presentation,
                observation_pending: &mut self.observer_observation_pending,
                raster: &mut self.dev_raster_presentation,
                native_animations: &mut self.pending_native_animations,
                animation_scene: &mut self.retained_animation_scene,
                animation_sample: &mut self.committed_animation_sample,
                animation_attempt: &mut self.native_animation_attempt,
            },
            page_id,
            consumed,
            effects,
            publication_context,
            presentation: None,
        })
    }

    fn fail_dev_logical_resize(
        &mut self,
        error: BridgeError,
        mut effects: BridgeBatch,
        undo: Option<LogicalGeometryUndo>,
    ) -> DevLogicalResizeFailure {
        if let Some(undo) = undo {
            undo.restore(&mut self.config.host, &mut self.engine_host_environment);
        }
        self.append_browser_retirement_messages(&mut effects.messages);
        DevLogicalResizeFailure { error, effects }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_ir::{
        AppInfo, CompilerInfo, Module, ModuleFormat, ModuleScope, Route, RouteKind, Template,
    };

    const ID: &str = "logical-resize";

    fn request(operation: &str, payload: Value) -> BridgeEnvelope {
        BridgeEnvelope::request(ID, format!("test-{operation}"), operation, payload)
    }

    fn fixture(engine: EngineKind, mode: PageRenderMode, source: Option<&str>) -> Session {
        fixture_with_render(engine, mode, source, true)
    }

    fn fixture_with_render(
        engine: EngineKind,
        mode: PageRenderMode,
        source: Option<&str>,
        render: bool,
    ) -> Session {
        fixture_with_template(
            engine,
            mode,
            source,
            render,
            "<view id=\"target\" style=\"width:2px;height:1px\">{{count}}</view>",
        )
    }

    fn fixture_with_template(
        engine: EngineKind,
        mode: PageRenderMode,
        source: Option<&str>,
        render: bool,
        template: &str,
    ) -> Session {
        fixture_with_template_capabilities(engine, mode, source, render, template, &[])
    }

    fn fixture_with_template_capabilities(
        engine: EngineKind,
        mode: PageRenderMode,
        source: Option<&str>,
        render: bool,
        template: &str,
        extra_capabilities: &[&str],
    ) -> Session {
        let native = engine_provider_compiled(engine);
        assert!(
            native || source.is_none(),
            "native source requires its real engine"
        );
        let source = native.then(|| source.unwrap_or("App({}); Page({});"));
        let ast = container_ir::parse_wxml(template)
            .unwrap()
            .canonical_json()
            .unwrap();
        let pointer = format!("sha256:{}", container_ir::hex_digest(&ast));
        let mut manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "logical-resize".into(),
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
                wxml_ast: pointer.clone(),
                bindings: vec![],
                wxs_modules: Default::default(),
            }],
            ..Default::default()
        };
        for name in [
            "wx.getWindowInfo",
            "wx.getSystemInfoSync",
            "wx.setStorageSync",
            "wx.getStorageSync",
            "wx.navigateTo",
            "wx.navigateBack",
            "getCurrentPages",
        ]
        .into_iter()
        .chain(extra_capabilities.iter().copied())
        {
            manifest
                .capabilities
                .insert(name.into(), CapabilitySupport::Partial);
        }
        if let Some(source) = source {
            manifest.modules.push(Module {
                id: "module:app.js".into(),
                sha256: container_ir::hex_digest(source.as_bytes()),
                format: ModuleFormat::Commonjs,
                scope: ModuleScope::App,
                dependencies: vec![],
            });
        }
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                session_id: ID.into(),
                engine,
                page_render_mode: mode,
                host: HostMetadata {
                    window_width: 2,
                    window_height: 1,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        let mut payload = json!({"blobs":{pointer:ast}});
        if let Some(source) = source {
            payload["modules"] = json!([{"id":"module:app.js","source":source}]);
        }
        for (operation, payload) in [
            (op::APP_INIT, payload),
            (op::APP_LIFECYCLE, json!({"event":"launch"})),
            (op::PAGE_PUSH, json!({"path":"pages/index/index"})),
            (
                op::RENDER_COMMIT,
                json!({
                    "templateId":"template:pages/index/index.wxml", "useSessionResources":true,
                    "viewport":{"x":0,"y":0,"width":2,"height":1},
                }),
            ),
        ] {
            if operation == op::RENDER_COMMIT && !render {
                continue;
            }
            let batch = session.dispatch(request(operation, payload));
            assert_eq!(
                batch.messages[0].payload["ok"], true,
                "{operation}: {batch:?}"
            );
        }
        session
    }

    fn viewport() -> Rect {
        Rect {
            x: 0.0,
            y: 0.0,
            width: 3.0,
            height: 2.0,
        }
    }

    fn resize_count(batch: &BridgeBatch) -> usize {
        batch
            .messages
            .iter()
            .filter(|message| message.payload["type"] == "host.resize")
            .count()
    }

    #[test]
    fn dropping_prepared_resize_keeps_old_picture_and_retires_old_input() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let revision = session.render_revision();
        let old_frame = std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap());
        let lifetime = session.input_lifetime_revision;
        let mut candidate = session.prepare_dev_logical_resize(viewport(), 2.0).unwrap();
        assert!(candidate.picture().unwrap().snapshot().is_none());
        assert_eq!(
            candidate.picture().unwrap().target(),
            RenderTargetSize {
                width: 6,
                height: 4
            }
        );
        assert_eq!(
            candidate.consumed_page_input().unwrap().viewport,
            viewport()
        );
        let effects = candidate.take_effects();
        assert_eq!(resize_count(&effects), 1);
        drop(candidate);
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.window_height, 1);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(
            std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap()),
            old_frame
        );
        assert_eq!(
            session.input_lifetime_revision,
            lifetime.map(|value| value + 1)
        );
        assert!(session.committed_frame_input.is_none());
        assert!(session.presented_revision.is_none());
        assert!(!session.observer_frame_valid);
    }

    #[test]
    fn acceptance_has_exact_consumed_input_and_defers_ready_until_owner_ack() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let previous = session.render_revision();
        let before = session.view.template_revision;
        let mut receipt = session
            .prepare_dev_logical_resize(viewport(), 2.0)
            .unwrap()
            .accept_with_retirement();
        assert_eq!(receipt.render_revision(), Some(previous + 1));
        assert_eq!(
            receipt.consumed_page_input().unwrap().template_revision,
            before
        );
        assert_eq!(
            receipt.consumed_page_input(),
            session.last_frame_input(previous + 1)
        );
        assert_eq!(session.config.host.window_width, 3);
        assert_eq!(session.config.host.window_height, 2);
        assert!(!session.observer_frame_valid);
        assert!(session.presented_revision.is_none());
        assert!(session.pending_presentation.is_some());
        assert_eq!(resize_count(&receipt.take_effects()), 1);
        assert!(receipt.take_effects().messages.is_empty());
        let revision = receipt.render_revision().unwrap();
        drop(receipt); // Represents external-store unlock before completion.
        session.acknowledge_presentation(revision).unwrap();
        assert!(session.observer_frame_valid);
        assert_eq!(session.presented_revision, Some(revision));
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn resize_retains_animation_capture_and_installs_the_resized_raw_scene(engine: EngineKind) {
        let mut session = fixture_with_template(
            engine, PageRenderMode::ExternalFrame,
            Some("App({});Page({data:{anim:{actions:[{animates:[{type:'opacity',args:[1]}],option:{duration:100,delay:0,timingFunction:'linear',transformOrigin:'center'}}]}}});"),
            true, "<view id=\"target\" style=\"width:2px;height:1px;opacity:0.2\" animation=\"{{anim}}\"/>",
        );
        let captured = session
            .pending_native_animations
            .as_ref()
            .unwrap()
            .1
            .playback
            .captured_at;
        session.animation_clock.advance_to(captured).unwrap();
        session
            .acknowledge_presentation(session.render_revision())
            .unwrap();
        session
            .animation_clock
            .advance_to(captured + std::time::Duration::from_millis(50))
            .unwrap();
        let previous = session.render_revision();
        let receipt = session
            .prepare_dev_logical_resize(viewport(), 1.0)
            .unwrap()
            .accept_with_retirement();
        let resized = receipt.render_revision().unwrap();
        assert_eq!(resized, previous + 1);
        drop(receipt);
        assert_eq!(
            session.pending_native_animations.as_ref().unwrap().0,
            resized
        );
        assert_eq!(session.committed_animation_sample.unwrap().0, resized);
        assert!(session.retained_animation_scene.is_some());
        let frame = session.skia_backend.renderer.last_frame().unwrap();
        assert_eq!(frame.viewport, viewport());
        assert!((frame.root.children[0].opacity - 0.6).abs() < 1.0e-5);
        session.acknowledge_presentation(resized).unwrap();
        assert!(session.pending_native_animations.is_none());
        let template = session.view.template_revision;
        session
            .animation_clock
            .advance_to(captured + std::time::Duration::from_millis(66))
            .unwrap();
        let batch = session.poll_timers(0);
        assert!(
            batch.messages.iter().all(|message| message.op != op::ERROR),
            "{batch:?}"
        );
        assert_eq!(session.view.template_revision, template);
        assert_eq!(session.render_revision(), resized + 1);
        let sample = session.skia_backend.renderer.last_frame().unwrap();
        assert_eq!(sample.viewport, viewport());
        assert!((sample.root.children[0].opacity - 0.728).abs() < 1.0e-5);
        assert_eq!(
            session
                .last_frame_input(session.render_revision())
                .unwrap()
                .viewport,
            viewport()
        );
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_logical_resize_preserves_animation_run_and_replaces_retained_scene() {
        resize_retains_animation_capture_and_installs_the_resized_raw_scene(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_logical_resize_preserves_animation_run_and_replaces_retained_scene() {
        resize_retains_animation_capture_and_installs_the_resized_raw_scene(EngineKind::V8);
    }

    #[test]
    fn post_hook_template_failure_retains_effect_batch_and_old_accepted_frame() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let revision = session.render_revision();
        let pointer = session.manifest.templates[0].wxml_ast.clone();
        let mut resources = (*session.render_blobs).clone();
        resources.insert(pointer, b"invalid AST fixture".to_vec());
        session.render_blobs = Arc::new(resources);
        let failure = match session.prepare_dev_logical_resize(viewport(), 1.0) {
            Ok(_) => panic!("invalid AST accepted"),
            Err(failure) => failure,
        };
        assert_eq!(failure.error.code, BridgeErrorCode::Render);
        assert_eq!(resize_count(&failure.effects), 1);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.window_height, 1);
    }

    #[test]
    fn settings_before_first_scene_keep_renderer_lazy_until_ordinary_pump() {
        let mut session = fixture_with_render(
            EngineKind::Quickjs,
            PageRenderMode::ExternalFrame,
            None,
            false,
        );
        assert!(session.skia_backend.renderer.peek().is_none());
        let mut candidate = session.prepare_dev_logical_resize(viewport(), 2.0).unwrap();
        assert!(candidate.picture().is_none());
        assert!(candidate.consumed_page_input().is_none());
        assert!(!candidate.requires_exact_raster_presentation());
        assert_eq!(resize_count(&candidate.take_effects()), 1);
        drop(candidate);
        assert!(session.skia_backend.renderer.peek().is_none());
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.render_revision(), 0);

        let mut receipt = session
            .prepare_dev_logical_resize(viewport(), 2.0)
            .unwrap()
            .accept_with_retirement();
        assert!(receipt.render_revision().is_none());
        assert!(receipt.consumed_page_input().is_none());
        assert_eq!(resize_count(&receipt.take_effects()), 1);
        assert!(session.skia_backend.renderer.peek().is_none());
        assert_eq!(session.config.host.window_width, 3);
        assert_eq!(session.render_revision(), 0);
        assert!(session.view.last_frame_id.is_none());
        assert!(session.accepted_view_document.is_none());
        assert!(session.pending_presentation.is_none());
        drop(receipt);
        let batch = session.dispatch(request(
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml", "useSessionResources":true,
                "viewport":viewport(),
            }),
        ));
        assert_eq!(batch.messages[0].payload["ok"], true, "{batch:?}");
        assert_eq!(session.render_revision(), 1);
        assert_eq!(
            session.skia_backend.renderer.peek().unwrap().render_scale(),
            2.0
        );
        assert_eq!(
            session.accepted_page_observation().unwrap().target,
            RenderTargetSize {
                width: 6,
                height: 4
            }
        );
    }

    #[test]
    fn settings_after_navigation_never_relabel_the_old_page_scene() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let old_revision = session.render_revision();
        let old_page = session.app_service.pages().current().unwrap().id;
        let old_frame = std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap());
        let old_document = session.accepted_view_document.as_ref().unwrap().page_id;
        let pushed = session.dispatch(request(op::PAGE_PUSH, json!({"path":"pages/index/index"})));
        assert_eq!(pushed.messages[0].payload["ok"], true, "{pushed:?}");
        let new_page = session.app_service.pages().current().unwrap().id;
        assert_ne!(new_page, old_page);
        assert!(!session.has_current_skia_scene());
        let candidate = session.prepare_dev_logical_resize(viewport(), 2.0).unwrap();
        assert!(candidate.picture().is_none());
        assert!(candidate.consumed_page_input().is_none());
        let receipt = candidate.accept_with_retirement();
        assert!(receipt.render_revision().is_none());
        assert_eq!(session.app_service.pages().current().unwrap().id, new_page);
        assert_eq!(session.render_revision(), old_revision);
        assert_eq!(
            std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap()),
            old_frame
        );
        assert_eq!(
            session.accepted_view_document.as_ref().unwrap().page_id,
            old_document
        );
        assert!(!session.has_current_skia_scene());
        assert!(session.last_frame_input(old_revision).is_none());
        assert!(session.pending_presentation.is_none());
        assert_eq!(
            session.skia_backend.renderer.peek().unwrap().render_scale(),
            2.0
        );
        drop(receipt);
    }

    #[test]
    fn invalid_target_fails_before_resize_or_lifetime_retirement() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let revision = session.render_revision();
        let lifetime = session.input_lifetime_revision;
        let failure = match session.prepare_dev_logical_resize(viewport(), 0.0) {
            Ok(_) => panic!("invalid density accepted"),
            Err(failure) => failure,
        };
        assert!(failure.effects.messages.is_empty());
        assert_eq!(session.render_revision(), revision);
        assert_eq!(session.input_lifetime_revision, lifetime);
        assert_eq!(session.config.host.window_width, 2);
    }

    #[test]
    fn geometry_abort_preserves_independent_metadata_and_newer_geometry() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let previous = OwnedWindowGeometry::capture(&session.config.host);
        session.mark_engine_host_environment_dirty().unwrap();
        session.config.host.window_width = 3;
        let undo = session.capture_logical_geometry_undo(previous);
        session.config.host.user_agent = "callback metadata".into();
        undo.restore(
            &mut session.config.host,
            &mut session.engine_host_environment,
        );
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.user_agent, "callback metadata");

        let previous = OwnedWindowGeometry::capture(&session.config.host);
        session.mark_engine_host_environment_dirty().unwrap();
        session.config.host.window_width = 3;
        let undo = session.capture_logical_geometry_undo(previous);
        session.mark_engine_host_environment_dirty().unwrap();
        session.config.host.window_width = 4;
        session.config.host.window_height = 5;
        undo.restore(
            &mut session.config.host,
            &mut session.engine_host_environment,
        );
        assert_eq!(session.config.host.window_width, 4);
        assert_eq!(session.config.host.window_height, 5);
        assert_eq!(session.config.host.user_agent, "callback metadata");
    }

    #[test]
    fn pre_hook_fence_rejects_away_and_back_and_lifecycle_round_trips() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::ExternalFrame, None);
        let source = LogicalResizeSource::capture(&mut session).unwrap();
        session.invalidate_browser_presentation();
        let fence = LogicalResizeFence::capture(&mut session, source).unwrap();
        fence.validate(&mut session).unwrap();
        session.invalidate_browser_presentation();
        session.invalidate_browser_presentation();
        assert_eq!(
            fence.validate(&mut session).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );

        let source = LogicalResizeSource::capture(&mut session).unwrap();
        let fence = LogicalResizeFence::capture(&mut session, source).unwrap();
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Hide)
            .unwrap();
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Show)
            .unwrap();
        assert_eq!(
            fence.validate(&mut session).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
    }

    #[test]
    fn raster_candidate_has_real_pixels_before_acceptance() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::Raster, None);
        let revision = session.render_revision();
        let candidate = session.prepare_dev_logical_resize(viewport(), 1.0).unwrap();
        let snapshot = candidate
            .picture()
            .unwrap()
            .snapshot()
            .expect("paint/readback completed");
        assert_eq!((snapshot.width, snapshot.height), (3, 2));
        assert_eq!(candidate.picture().unwrap().render_revision(), revision + 1);
        drop(candidate);
        assert_eq!(session.render_revision(), revision);
    }

    #[cfg(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    ))]
    #[test]
    fn native_gpu_logical_candidate_never_creates_cpu_snapshot() {
        let mut session = fixture(EngineKind::Quickjs, PageRenderMode::NativeGpu, None);
        let candidate = session.prepare_dev_logical_resize(viewport(), 2.0).unwrap();
        assert!(candidate.picture().unwrap().snapshot().is_none());
        assert_eq!(
            candidate.picture().unwrap().page_render_mode(),
            PageRenderMode::NativeGpu
        );
        let receipt = candidate.accept_with_retirement();
        assert!(session.skia_backend.renderer.snapshot_ref().is_none());
        assert!(session.pending_presentation.is_some());
        drop(receipt);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn native_abort_preserves_hooks_and_repairs_next_raw_entry(engine: EngineKind) {
        let source = r#"
            globalThis.resizeTrace = [];
            globalThis.readResize = function() {
                return { trace: resizeTrace.slice(), width: wx.getWindowInfo().windowWidth,
                    stored: wx.getStorageSync('resize-count') };
            };
            App({});
            Page({ data: {count: 0}, onResize: function() {
                this.setData({count: this.data.count + 1});
                resizeTrace.push(wx.getWindowInfo().windowWidth);
                wx.setStorageSync('resize-count', this.data.count);
                Promise.resolve().then(function() { resizeTrace.push('promise'); });
            }});
        "#;
        let mut session = fixture(engine, PageRenderMode::ExternalFrame, Some(source));
        let revision = session.render_revision();
        let mut candidate = session.prepare_dev_logical_resize(viewport(), 1.0).unwrap();
        let consumed = candidate.consumed_page_input().unwrap().clone();
        let effects = candidate.take_effects();
        assert_eq!(resize_count(&effects), 1);
        drop(candidate);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(
            session.app_service.pages().current().unwrap().data["count"],
            1
        );
        assert_eq!(consumed.template_revision, session.view.template_revision);
        let observed = session
            .call_engine(
                CallTarget::Global {
                    name: "readResize".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(observed[0]["width"], 2);
        assert_eq!(observed[0]["stored"], 1);
        assert_eq!(observed[0]["trace"], json!([3, "promise"]));
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn native_resize_navigation_away_and_back_rejects_old_candidate(engine: EngineKind) {
        let source = r#"
            globalThis.resizeNavigation = [];
            globalThis.resizeCalls = 0;
            globalThis.readNavigation = function() {
                return { trace: resizeNavigation.slice(), calls: resizeCalls,
                    width: wx.getWindowInfo().windowWidth,
                    stored: wx.getStorageSync('resize-once') };
            };
            App({});
            Page({ data: {count: 0}, onResize: function() {
                resizeCalls++;
                this.setData({count: resizeCalls});
                wx.setStorageSync('resize-once', resizeCalls);
                resizeNavigation.push('resize');
                wx.navigateTo({url:'/pages/index/index', success:function() {
                    resizeNavigation.push('away');
                    wx.navigateBack({delta:1, success:function() {
                        resizeNavigation.push('back');
                    }});
                }});
            }});
        "#;
        let mut session = fixture(engine, PageRenderMode::ExternalFrame, Some(source));
        let revision = session.render_revision();
        let frame = std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap());
        let page = session.app_service.pages().current().unwrap().id;
        let template_revision = session.view.template_revision;
        let lifetime = session.input_lifetime_revision.unwrap();
        let failure = match session.prepare_dev_logical_resize(viewport(), 1.0) {
            Ok(_) => panic!("navigation round-trip accepted the retired source candidate"),
            Err(failure) => failure,
        };
        assert_eq!(failure.error.code, BridgeErrorCode::Cancelled);
        assert_eq!(resize_count(&failure.effects), 1);
        assert_eq!(session.app_service.pages().len(), 1);
        assert_eq!(session.app_service.pages().current().unwrap().id, page);
        assert!(session.input_lifetime_revision.unwrap() >= lifetime + 3);
        assert_eq!(
            session.app_service.pages().current().unwrap().data["count"],
            1
        );
        assert!(session.view.template_revision > template_revision);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(
            std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap()),
            frame
        );
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.window_height, 1);
        assert!(session.execution_fault().is_none());
        let observed = session
            .call_engine(
                CallTarget::Global {
                    name: "readNavigation".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(
            observed[0],
            json!({
                "trace":["resize","away","back"], "calls":1, "width":2, "stored":1,
            })
        );
        // Data changed during the failed attempt, so this ordinary render is
        // genuinely dirty. It must not replay the resize hook or its effects.
        let rendered = session.dispatch(request(
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml", "useSessionResources":true,
                "viewport":{"x":0,"y":0,"width":2,"height":1},
            }),
        ));
        assert_eq!(rendered.messages[0].payload["ok"], true, "{rendered:?}");
        assert_eq!(session.render_revision(), revision + 1);
        let after = session
            .call_engine(
                CallTarget::Global {
                    name: "readNavigation".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(after, observed);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn native_window_listener_navigation_rejects_old_candidate(engine: EngineKind) {
        let source = r#"
            globalThis.resizeNavigation = [];
            globalThis.resizeCalls = 0;
            globalThis.eventWidth = null;
            globalThis.readNavigation = function() {
                return { trace: resizeNavigation.slice(), calls: resizeCalls, eventWidth: eventWidth,
                    width: wx.getWindowInfo().windowWidth,
                    stored: wx.getStorageSync('resize-once') };
            };
            App({});
            Page({ data: {count: 0} });
            wx.onWindowResize(function(event) {
                eventWidth = event.size.windowWidth;
                resizeCalls++;
                getCurrentPages()[0].setData({count: resizeCalls});
                wx.setStorageSync('resize-once', resizeCalls);
                resizeNavigation.push('resize');
                wx.navigateTo({url:'/pages/index/index', success:function() {
                    resizeNavigation.push('away');
                    wx.navigateBack({delta:1, success:function() {
                        resizeNavigation.push('back');
                    }});
                }});
            });
        "#;
        let mut session = fixture_with_template_capabilities(
            engine,
            PageRenderMode::ExternalFrame,
            Some(source),
            true,
            "<view id=\"target\" style=\"width:2px;height:1px\">{{count}}</view>",
            &["wx.onWindowResize", "wx.offWindowResize"],
        );
        let revision = session.render_revision();
        let frame = std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap());
        let page = session.app_service.pages().current().unwrap().id;
        let template_revision = session.view.template_revision;
        let lifetime = session.input_lifetime_revision.unwrap();
        let failure = match session.prepare_dev_logical_resize(viewport(), 1.0) {
            Ok(_) => panic!("navigation round-trip accepted the retired source candidate"),
            Err(failure) => failure,
        };
        assert_eq!(failure.error.code, BridgeErrorCode::Cancelled);
        assert_eq!(resize_count(&failure.effects), 1);
        assert_eq!(session.app_service.pages().len(), 1);
        assert_eq!(session.app_service.pages().current().unwrap().id, page);
        assert!(session.input_lifetime_revision.unwrap() >= lifetime + 3);
        assert_eq!(
            session.app_service.pages().current().unwrap().data["count"],
            1
        );
        assert!(session.view.template_revision > template_revision);
        assert_eq!(session.render_revision(), revision);
        assert_eq!(
            std::ptr::from_ref(session.skia_backend.renderer.last_frame().unwrap()),
            frame
        );
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.window_height, 1);
        assert!(session.execution_fault().is_none());
        let observed = session
            .call_engine(
                CallTarget::Global {
                    name: "readNavigation".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(
            observed[0],
            json!({
                "trace":["resize","away","back"], "calls":1, "eventWidth":3, "width":2, "stored":1,
            })
        );
        // Data changed during the failed attempt, so this ordinary render is
        // genuinely dirty. It must not replay the window listener or its effects.
        let rendered = session.dispatch(request(
            op::RENDER_COMMIT,
            json!({
                "templateId":"template:pages/index/index.wxml", "useSessionResources":true,
                "viewport":{"x":0,"y":0,"width":2,"height":1},
            }),
        ));
        assert_eq!(rendered.messages[0].payload["ok"], true, "{rendered:?}");
        assert_eq!(session.render_revision(), revision + 1);
        let after = session
            .call_engine(
                CallTarget::Global {
                    name: "readNavigation".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(after, observed);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_window_listener_navigation_round_trip_never_republishes_old_source() {
        native_window_listener_navigation_rejects_old_candidate(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_window_listener_navigation_round_trip_never_republishes_old_source() {
        native_window_listener_navigation_rejects_old_candidate(EngineKind::V8);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_resize_hook_navigation_round_trip_never_republishes_old_source() {
        native_resize_navigation_away_and_back_rejects_old_candidate(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_resize_hook_navigation_round_trip_never_republishes_old_source() {
        native_resize_navigation_away_and_back_rejects_old_candidate(EngineKind::V8);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_abort_keeps_one_resize_and_repairs_raw_mirror() {
        native_abort_preserves_hooks_and_repairs_next_raw_entry(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_abort_keeps_one_resize_and_repairs_raw_mirror() {
        native_abort_preserves_hooks_and_repairs_next_raw_entry(EngineKind::V8);
    }

    #[cfg(any(feature = "quickjs-native", feature = "v8-native"))]
    fn native_c2_budget_failure_keeps_hooks_pixels_and_recovery(engine: EngineKind) {
        let source = r#"
            globalThis.resizeTrace = [];
            globalThis.readResize = function() {
                return { trace: resizeTrace.slice(), width: wx.getWindowInfo().windowWidth,
                    stored: wx.getStorageSync('resize-count') };
            };
            App({});
            Page({ data: { count: 0, deep: false }, onResize: function() {
                var count = this.data.count + 1;
                this.setData({ count: count, deep: count === 1 });
                wx.setStorageSync('resize-count', count);
                resizeTrace.push(wx.getWindowInfo().windowWidth);
                Promise.resolve().then(function() { resizeTrace.push('promise'); });
            }});
        "#;
        // The initial accepted page omits the deep subtree. The real first
        // resize hook reveals 33 simultaneous opacity groups, exceeding the
        // renderer's 32-layer contract after View/layout and before acceptance.
        // This uses tiny real pixels and no fault-injection or allocator hook.
        let mut template = String::from(
            r#"<view id="target" style="width:2px;height:1px">{{count}}<view wx:if="{{deep}}">"#,
        );
        for _ in 0..33 {
            template.push_str(r#"<view style="opacity:0.5;width:1px;height:1px">"#);
        }
        template.push_str("<view />");
        for _ in 0..33 {
            template.push_str("</view>");
        }
        template.push_str("</view></view>");
        let mut session = fixture_with_template(
            engine,
            PageRenderMode::Raster,
            Some(source),
            true,
            &template,
        );
        let (revision, frame_id, frame_pointer, pixel_pointer, pixels) = {
            let observed = session.accepted_page_observation().unwrap();
            let snapshot = observed.snapshot.unwrap();
            (
                observed.render_revision,
                observed.frame.frame_id,
                std::ptr::from_ref(observed.frame),
                snapshot.pixels.as_ptr(),
                snapshot.pixels.clone(),
            )
        };
        let input_lifetime = session.input_lifetime_revision;
        let failure = match session.prepare_dev_logical_resize(viewport(), 1.0) {
            Ok(_) => panic!("33 opacity groups unexpectedly accepted a resize candidate"),
            Err(failure) => failure,
        };
        assert_eq!(failure.error.code, BridgeErrorCode::Render);
        assert!(
            failure.error.message.contains(
                &container_render_skia::RenderError::CompositingBudgetExceeded.to_string()
            ),
            "failure did not originate in the renderer's real layer budget: {failure:?}"
        );
        assert_eq!(resize_count(&failure.effects), 1);
        assert!(
            failure.effects.messages.iter().any(|message| {
                message.payload["effects"]
                    .as_array()
                    .is_some_and(|batches| {
                        batches.iter().any(|batch| {
                            batch["events"].as_array().is_some_and(|events| {
                                events
                                    .iter()
                                    .any(|event| event["type"] == "storage.patch.batch")
                            })
                        })
                    })
            }),
            "consumed storage effect was lost after C2 rejection: {:?}",
            failure.effects
        );
        assert_eq!(
            session.app_service.pages().current().unwrap().data["count"],
            1
        );
        assert_eq!(
            session.app_service.pages().current().unwrap().data["deep"],
            true
        );
        assert_eq!(
            session.app_service.storage().get("resize-count"),
            Some(&json!(1))
        );
        assert_eq!(session.render_revision(), revision);
        let observed = session.accepted_page_observation().unwrap();
        assert_eq!(observed.frame.frame_id, frame_id);
        assert_eq!(std::ptr::from_ref(observed.frame), frame_pointer);
        let snapshot = observed.snapshot.unwrap();
        assert_eq!(snapshot.pixels.as_ptr(), pixel_pointer);
        assert_eq!(snapshot.pixels, pixels);
        assert_eq!(session.config.host.window_width, 2);
        assert_eq!(session.config.host.window_height, 1);
        // Legacy Raster readiness is intentionally permissive; inspect the
        // actual retired input and observer authority instead of that policy.
        assert_ne!(session.input_lifetime_revision, input_lifetime);
        assert!(session.presented_revision.is_none());
        assert!(session.pending_presentation.is_none());
        assert!(!session.observer_frame_valid);
        assert!(session.execution_fault().is_none());
        let observed = session
            .call_engine(
                CallTarget::Global {
                    name: "readResize".into(),
                },
                vec![],
            )
            .unwrap();
        assert_eq!(observed[0]["width"], 2);
        assert_eq!(observed[0]["stored"], 1);
        assert_eq!(observed[0]["trace"], json!([3, "promise"]));

        // The second real hook sees the retained count and removes the deep
        // subtree. It runs once for this retry, not a compensating reverse hook.
        let mut receipt = session
            .prepare_dev_logical_resize(viewport(), 1.0)
            .unwrap()
            .accept_with_retirement();
        let next_revision = receipt.render_revision().unwrap();
        assert_eq!(next_revision, revision + 1);
        assert_eq!(resize_count(&receipt.take_effects()), 1);
        drop(receipt);
        assert_eq!(
            session.app_service.pages().current().unwrap().data["count"],
            2
        );
        assert_eq!(
            session.app_service.pages().current().unwrap().data["deep"],
            false
        );
        assert_eq!(
            session.app_service.storage().get("resize-count"),
            Some(&json!(2))
        );
        let observed = session.accepted_page_observation().unwrap();
        let snapshot = observed.snapshot.unwrap();
        assert_eq!((snapshot.width, snapshot.height), (3, 2));
        assert_eq!(session.config.host.window_width, 3);
        assert_eq!(session.config.host.window_height, 2);
        session.acknowledge_presentation(next_revision).unwrap();
        assert_eq!(session.presented_revision, Some(next_revision));
        assert!(session.pending_presentation.is_none());
        assert!(session.observer_frame_valid);
    }

    #[cfg(feature = "quickjs-native")]
    #[test]
    fn quickjs_c2_compositing_rejection_keeps_resize_effects_pixels_and_recovery() {
        native_c2_budget_failure_keeps_hooks_pixels_and_recovery(EngineKind::Quickjs);
    }

    #[cfg(feature = "v8-native")]
    #[test]
    fn v8_c2_compositing_rejection_keeps_resize_effects_pixels_and_recovery() {
        native_c2_budget_failure_keeps_hooks_pixels_and_recovery(EngineKind::V8);
    }
}
