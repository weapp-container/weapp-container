//! Skia page preparation and acceptance on the runtime owner thread.
//!
//! This backend does not evaluate View code, own page/presentation authority or
//! run ready/effects. A prepared frame owns all decoded-cache changes until the
//! existing renderer accepts that exact frame. Browser DOM transactions keep
//! their raw CSS/geometry path and never call this module's materializer.

use super::{
    apply_render_declarations, images, render_bridge_error, resolve_render_color_inheritance,
    style_compositing, style_flex, style_stacking, style_text, style_transforms, style_visibility,
    styles, BrowserPageInput, PreparedAnimations, PreparedViewDocument, RenderResources,
    SessionError, ViewRenderInputs,
};
use container_bridge::{BridgeError, BridgeErrorCode};
use container_ir::{
    resolve_wxss_style_for_node_with_inline, ContainerManifestV1, ViewDocument, WxssIr,
    WxssSelectorNode,
};
use container_render_skia::{
    AcceptedPageFrame, BoxSizing, CanvasFrame, CanvasOwnerKey, CanvasService,
    PageFrameTargetPolicy, PageRenderMode, PreparedPageFrame, PreparedRenderTarget, Rect,
    RenderError, RenderFrame, RenderNode, RenderSnapshot, RenderTargetSize, Renderer, SkiaRenderer,
    ValidatedPageRenderMode, ValidatedPageRenderTarget,
};
use std::cell::{Cell, OnceCell};
use std::sync::Arc;

mod animation;
mod document;

/// Canvas state exists independently until explicit page/legacy use moves it
/// into the renderer. Passive reads and Canvas draws never construct a page
/// object. Once present, the current renderer is the only authoritative owner.
pub(super) struct LazySkiaRenderer {
    mode: ValidatedPageRenderMode,
    pre_page_canvas: Cell<CanvasService>,
    pending_target: Cell<Option<ValidatedPageRenderTarget>>,
    renderer: OnceCell<SkiaRenderer>,
}

impl LazySkiaRenderer {
    fn new(mode: PageRenderMode) -> Result<Self, SessionError> {
        let mode = ValidatedPageRenderMode::new(mode)
            .map_err(|error| SessionError::UnsupportedCapability(error.to_string()))?;
        let canvas = CanvasService::default();
        #[cfg(all(
            feature = "restricted-showcase",
            feature = "skia-backend",
            not(target_arch = "wasm32")
        ))]
        let canvas = {
            let mut canvas = canvas;
            canvas
                .install_native_fonts_only(&[super::distribution::showcase_native_font()])
                .map_err(|error| SessionError::Config(error.to_string()))?;
            canvas
        };
        Ok(Self {
            mode,
            pre_page_canvas: Cell::new(canvas),
            pending_target: Cell::new(None),
            renderer: OnceCell::new(),
        })
    }

    pub(super) fn peek(&self) -> Option<&SkiaRenderer> {
        self.renderer.get()
    }

    pub(super) fn peek_mut(&mut self) -> Option<&mut SkiaRenderer> {
        self.renderer.get_mut()
    }

    /// Explicit legacy/drawing boundary. Passive callers have no automatic
    /// dereference path that could accidentally construct a page renderer.
    pub(super) fn ensure(&self) -> &SkiaRenderer {
        self.renderer.get_or_init(|| {
            // Nothing fallible or external may run after taking the unique
            // owner: the validated constructor only moves inert fields.
            match self.pending_target.get() {
                Some(target) => SkiaRenderer::new_with_validated_target_and_canvas(
                    target,
                    self.pre_page_canvas.take(),
                ),
                None => SkiaRenderer::new_with_validated_mode_and_canvas(
                    self.mode,
                    self.pre_page_canvas.take(),
                ),
            }
        })
    }

    pub(super) fn ensure_mut(&mut self) -> &mut SkiaRenderer {
        self.ensure();
        // ensure initialized this private cell; exclusive access and no
        // intervening callbacks/take keep it populated until get_mut.
        self.renderer
            .get_mut()
            .expect("Skia renderer initialized by ensure")
    }

    pub(super) fn page_render_mode(&self) -> PageRenderMode {
        self.peek()
            .map_or(self.mode.mode(), SkiaRenderer::page_render_mode)
    }

    pub(super) fn render_scale(&self) -> f64 {
        self.peek().map_or_else(
            || {
                self.pending_target
                    .get()
                    .map_or(1.0, ValidatedPageRenderTarget::scale)
            },
            SkiaRenderer::render_scale,
        )
    }

    pub(super) fn validate_render_target(
        &self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, RenderError> {
        ValidatedPageRenderTarget::new(self.page_render_mode(), viewport, scale)
            .map(ValidatedPageRenderTarget::size)
    }

    pub(super) fn stage_render_target(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, RenderError> {
        let target = ValidatedPageRenderTarget::new(self.page_render_mode(), viewport, scale)?;
        if let Some(renderer) = self.peek_mut() {
            // A legacy whole replacement owns its own mode and configuration;
            // never reapply the pre-page target to an initialized replacement.
            renderer.configure_render_target(viewport, scale)
        } else {
            self.pending_target.set(Some(target));
            Ok(target.size())
        }
    }

    pub(super) fn last_frame(&self) -> Option<&RenderFrame> {
        self.peek().and_then(Renderer::last_frame)
    }

    pub(super) fn snapshot_revision(&self) -> u64 {
        self.peek().map_or(0, SkiaRenderer::snapshot_revision)
    }

    #[cfg(test)]
    pub(super) fn snapshot_ref(&self) -> Option<&RenderSnapshot> {
        self.peek().and_then(SkiaRenderer::snapshot_ref)
    }

    pub(super) fn backend_name(&self) -> &'static str {
        self.peek().map_or_else(
            || SkiaRenderer::configured_backend_name(self.mode.mode()),
            Renderer::backend_name,
        )
    }

    pub(super) fn commit_canvas(
        &mut self,
        frame: CanvasFrame,
    ) -> Result<RenderSnapshot, RenderError> {
        match self.renderer.get_mut() {
            Some(renderer) => renderer.commit_canvas(frame),
            None => self.pre_page_canvas.get_mut().commit(frame),
        }
    }

    pub(super) fn install_portable_text_font(
        &mut self,
        font: container_render_skia::PortableFontData,
    ) -> Result<container_render_skia::PortableFontIdentity, RenderError> {
        match self.renderer.get_mut() {
            Some(renderer) => renderer.install_portable_text_font(font),
            None => self
                .pre_page_canvas
                .get_mut()
                .install_portable_text_font(font),
        }
    }

    pub(super) fn canvas_snapshot(&self, id: &str) -> Option<RenderSnapshot> {
        if let Some(renderer) = self.peek() {
            return renderer.canvas_snapshot(id);
        }
        // Only the established snapshot clone occurs during this short move;
        // there are no callbacks, fallible early returns or external code.
        let canvas = self.pre_page_canvas.take();
        let snapshot = canvas.snapshot(id);
        self.pre_page_canvas.set(canvas);
        snapshot
    }
}

/// Page layout, retained repaint and host GPU contexts retain the concrete
/// renderer. Independent Canvas operations do not initialize that page object.
pub(super) struct SkiaPageBackend {
    pub(super) renderer: LazySkiaRenderer,
    image_cache: images::ImageCache,
}

/// Native style validation completed before the session enters View/hooks.
/// Keep the exact immutable resource/target identity so an unrelated evaluated
/// document cannot accidentally consume another preflight's resolved styles.
pub(super) struct SkiaStylePreflight {
    styles: WxssIr,
    frame_id: u64,
    template_id: String,
    viewport: Rect,
    resources: RenderResources,
}

/// Original declaration-derived scene before inheritance, layout, transforms or
/// sampled overlays. Retained samples rerun the same resolver from these inputs.
#[derive(Clone, Debug)]
pub(super) struct RetainedAnimationScene {
    root: RenderNode,
    viewport: Rect,
    frame_id: u64,
    page_input: Option<BrowserPageInput>,
    resources: RenderResources,
    document: ViewDocument,
    buffer_urls: Arc<container_core::BufferUrlStore>,
}

struct PreparedManifestFrame {
    page_input: Option<BrowserPageInput>,
    resources: RenderResources,
    image_cache: images::ImageCache,
    document: ViewDocument,
    animations: Option<PreparedAnimations>,
    retained_animation_scene: Option<RetainedAnimationScene>,
}

/// Layout/resource candidate only. It grants no ready/input/geometry authority.
pub(super) struct PreparedSkiaFrame {
    frame: RenderFrame,
    manifest: Option<PreparedManifestFrame>,
}

impl PreparedSkiaFrame {
    pub(super) fn explicit(frame: RenderFrame) -> Self {
        Self {
            frame,
            manifest: None,
        }
    }

    pub(super) fn page_input(&self) -> Option<&BrowserPageInput> {
        self.manifest
            .as_ref()
            .and_then(|manifest| manifest.page_input.as_ref())
    }

    pub(super) fn set_page_input(&mut self, input: Option<BrowserPageInput>) {
        if let Some(manifest) = &mut self.manifest {
            manifest.page_input = input;
        }
    }

    pub(super) fn animations(&self) -> Option<&PreparedAnimations> {
        self.manifest
            .as_ref()
            .and_then(|manifest| manifest.animations.as_ref())
    }

    pub(super) fn frame(&self) -> &RenderFrame {
        &self.frame
    }

    /// The session's scroll coordinator may reconcile a candidate before
    /// acceptance; this never exposes a mutable accepted renderer frame.
    pub(super) fn frame_mut(&mut self) -> &mut RenderFrame {
        &mut self.frame
    }
}

pub(super) struct AcceptedManifestFrame {
    pub(super) page_input: Option<BrowserPageInput>,
    pub(super) resources: RenderResources,
    pub(super) document: ViewDocument,
    pub(super) animations: Option<PreparedAnimations>,
    pub(super) retained_animation_scene: Option<RetainedAnimationScene>,
}

/// The renderer accepted the exact prepared frame and its decoded cache.
/// This is not a presentation receipt; the session still owns proof publication
/// and the separate raster/external/native presentation/ready policy.
pub(super) struct AcceptedSkiaFrame {
    pub(super) frame_id: u64,
    pub(super) manifest: Option<AcceptedManifestFrame>,
    pub(super) retired_page: AcceptedPageFrame,
}

/// Settings-only branch for a page whose first ordinary scene is still
/// pending. Neither variant creates a page renderer or accepts an old scene.
pub(super) enum PreparedSkiaSettings<'a> {
    Initialized(PreparedRenderTarget<'a>),
    Lazy {
        slot: &'a mut Option<ValidatedPageRenderTarget>,
        target: ValidatedPageRenderTarget,
    },
}

impl PreparedSkiaSettings<'_> {
    pub(super) fn accept(self) {
        match self {
            Self::Initialized(target) => target.accept(),
            Self::Lazy { slot, target } => *slot = Some(target),
        }
    }
}

/// A genuine C2 page candidate with a disjoint decoded-cache install slot.
/// Its renderer mode determines whether pixels exist; export/GPU never force
/// a diagnostic CPU readback at this boundary.
pub(super) struct PreparedSkiaPage<'a> {
    picture: PreparedPageFrame<'a>,
    image_cache: &'a mut images::ImageCache,
    manifest: PreparedManifestFrame,
}

pub(super) struct AcceptedSkiaPageRetirement {
    pub(super) picture: AcceptedPageFrame,
    _image_cache: Option<images::ImageCache>,
}

impl PreparedSkiaPage<'_> {
    pub(super) fn picture(&self) -> &PreparedPageFrame<'_> {
        &self.picture
    }

    pub(super) fn accept(self) -> (u64, AcceptedManifestFrame, AcceptedSkiaPageRetirement) {
        let frame_id = self.picture.frame().frame_id;
        let picture = self.picture.accept();
        let candidate = self.manifest;
        let old_cache = std::mem::replace(self.image_cache, candidate.image_cache);
        let manifest = AcceptedManifestFrame {
            page_input: candidate.page_input,
            resources: candidate.resources,
            document: candidate.document,
            animations: candidate.animations,
            retained_animation_scene: candidate.retained_animation_scene,
        };
        (
            frame_id,
            manifest,
            AcceptedSkiaPageRetirement {
                picture,
                _image_cache: Some(old_cache),
            },
        )
    }
}

impl SkiaPageBackend {
    pub(super) fn prepare_dev_settings(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<PreparedSkiaSettings<'_>, BridgeError> {
        let mode = self.renderer.page_render_mode();
        if let Some(renderer) = self.renderer.renderer.get_mut() {
            renderer
                .prepare_render_target(viewport, scale)
                .map(PreparedSkiaSettings::Initialized)
                .map_err(render_bridge_error)
        } else {
            let target = ValidatedPageRenderTarget::new(mode, viewport, scale)
                .map_err(render_bridge_error)?;
            Ok(PreparedSkiaSettings::Lazy {
                slot: self.renderer.pending_target.get_mut(),
                target,
            })
        }
    }

    pub(super) fn prepare_dev_page(
        &mut self,
        prepared: PreparedSkiaFrame,
        scale: f64,
        canvas_bindings: Vec<CanvasOwnerKey>,
    ) -> Result<PreparedSkiaPage<'_>, BridgeError> {
        let PreparedSkiaFrame { frame, manifest } = prepared;
        let manifest = manifest.ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "developer logical resize requires a manifest scene",
            )
        })?;
        let picture = self
            .renderer
            .ensure_mut()
            .prepare_page_frame_with_canvas_bindings(
                frame,
                PageFrameTargetPolicy::Development { scale },
                canvas_bindings,
            )
            .map_err(render_bridge_error)?;
        Ok(PreparedSkiaPage {
            picture,
            image_cache: &mut self.image_cache,
            manifest,
        })
    }

    pub(super) fn new(mode: PageRenderMode) -> Result<Self, SessionError> {
        Ok(Self {
            renderer: LazySkiaRenderer::new(mode)?,
            image_cache: images::ImageCache::default(),
        })
    }

    pub(super) fn reset_manifest_resources(&mut self) {
        // Accepted frames retain their own Arcs; this only retires reusable
        // decodes for a manifest whose authorization has just been replaced.
        self.image_cache = images::ImageCache::default();
    }

    pub(super) fn preflight(
        manifest: &ContainerManifestV1,
        input: &ViewRenderInputs,
    ) -> Result<SkiaStylePreflight, BridgeError> {
        Ok(SkiaStylePreflight {
            styles: styles::resolve_render_styles(
                manifest,
                &input.style_roots,
                &input.resources,
                input.viewport,
            )?,
            frame_id: input.frame_id,
            template_id: input.template_id.clone(),
            viewport: input.viewport,
            resources: Arc::clone(&input.resources),
        })
    }

    pub(super) fn materialize(
        &mut self,
        manifest: &ContainerManifestV1,
        prepared: PreparedViewDocument,
        preflight: SkiaStylePreflight,
        scroll_enabled: bool,
    ) -> Result<PreparedSkiaFrame, BridgeError> {
        if prepared.input.frame_id != preflight.frame_id
            || prepared.input.template_id != preflight.template_id
            || prepared.input.viewport != preflight.viewport
            || !Arc::ptr_eq(&prepared.input.resources, &preflight.resources)
        {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "Skia document does not match its style/resource preflight",
            ));
        }
        let styles = &preflight.styles;
        let PreparedViewDocument {
            input,
            document,
            buffer_urls,
            mut animations,
        } = prepared;
        let page_input = input.page_input;
        let viewport = input.viewport;
        let frame_id = input.frame_id;
        let blobs = input.resources;
        let template_id = input.template_id.as_str();
        // `page` is a real WXSS target even though it has no WXML source
        // element. Resolve it through the same cascade and paint boundary as
        // descendants, then supply the host viewport as its default extent.
        // Keeping the page out of WXML paths preserves event/key identities.
        let page_selector = WxssSelectorNode {
            tag: Some("page".into()),
            ..WxssSelectorNode::default()
        };
        let page_declarations =
            resolve_wxss_style_for_node_with_inline(styles, &page_selector, &[], &[]);
        let mut root = RenderNode::new(format!("page:{template_id}"), viewport);
        root.tag = Some("page".into());
        root.scroll_container = scroll_enabled;
        apply_render_declarations(&mut root, &page_declarations, viewport);
        let root_style = root.style.as_mut().expect("resolved page layout");
        // The host supplies the default page border box. CSS content-box
        // dimensions must exclude its padding/borders; explicit page sizes
        // still follow the same box model as every other styled node.
        let default_content = root_style.content_box(viewport);
        let (default_width, default_height) = match root_style.box_sizing {
            BoxSizing::ContentBox => (default_content.width, default_content.height),
            BoxSizing::BorderBox => (viewport.width, viewport.height),
        };
        root_style.width.get_or_insert(default_width);
        root_style.height.get_or_insert(default_height);
        root.children =
            document::materialize_nodes(&document.nodes, styles, viewport, &[page_selector])?;
        let raw_root = animations.as_ref().map(|_| root.clone());
        if let Some(animations) = &animations {
            // Retained sampled parent properties are the inheritance context
            // for newly requested child baselines. Keep the declaration scene
            // above pristine so later samples resolve that inheritance again.
            animation::overlay(&mut root, &animations.playback.styles)?;
        }
        let mut image_cache = self.image_cache.clone();
        let mut frame = self.resolve_scene(
            manifest,
            root,
            viewport,
            frame_id,
            &blobs,
            &document,
            &buffer_urls,
            &mut image_cache,
        )?;
        if let Some(animations) = &mut animations {
            let observations =
                animation::baselines(&frame.root, &animations.playback.baseline_requests)?;
            animations.playback.bind_baselines(&observations)?;
            let mut sampled_root = raw_root.as_ref().expect("animation raw scene").clone();
            animation::overlay(&mut sampled_root, &animations.playback.styles)?;
            frame = self.resolve_scene(
                manifest,
                sampled_root,
                viewport,
                frame_id,
                &blobs,
                &document,
                &buffer_urls,
                &mut image_cache,
            )?;
        }
        let retained_animation_scene = animations
            .as_ref()
            .filter(|animations| !animations.playback.styles.is_empty())
            .map(|_| RetainedAnimationScene {
                root: raw_root.expect("animation raw scene"),
                viewport,
                frame_id,
                page_input: page_input.clone(),
                resources: Arc::clone(&blobs),
                document: document.clone(),
                buffer_urls,
            });
        Ok(PreparedSkiaFrame {
            frame,
            manifest: Some(PreparedManifestFrame {
                page_input,
                resources: blobs,
                image_cache,
                document,
                animations,
                retained_animation_scene,
            }),
        })
    }

    /// Prepare a numeric overlay against the exact retained declaration scene.
    /// No View inputs, expressions, component hooks or public styles are rebuilt.
    pub(super) fn prepare_animation_sample(
        &mut self,
        manifest: &ContainerManifestV1,
        retained: &RetainedAnimationScene,
        playback: crate::animation_playback::PreparedPlayback,
    ) -> Result<PreparedSkiaFrame, BridgeError> {
        if !playback.baseline_requests.is_empty() {
            return Err(BridgeError::new(
                BridgeErrorCode::Render,
                "retained animation samples cannot request new CSS baselines",
            ));
        }
        let mut root = retained.root.clone();
        animation::overlay(&mut root, &playback.styles)?;
        let mut image_cache = self.image_cache.clone();
        let frame = self.resolve_scene(
            manifest,
            root,
            retained.viewport,
            retained.frame_id,
            &retained.resources,
            &retained.document,
            &retained.buffer_urls,
            &mut image_cache,
        )?;
        Ok(PreparedSkiaFrame {
            frame,
            manifest: Some(PreparedManifestFrame {
                page_input: retained.page_input.clone(),
                resources: Arc::clone(&retained.resources),
                image_cache,
                document: retained.document.clone(),
                retained_animation_scene: Some(retained.clone()),
                animations: Some(PreparedAnimations {
                    bindings: None,
                    playback,
                }),
            }),
        })
    }

    /// The single CSS/layout/image pipeline for initial and retained scenes.
    /// ImageCache::prepare rechecks every lease even on an already decoded hit.
    #[allow(clippy::too_many_arguments)]
    fn resolve_scene(
        &mut self,
        manifest: &ContainerManifestV1,
        mut root: RenderNode,
        viewport: Rect,
        frame_id: u64,
        blobs: &RenderResources,
        document: &ViewDocument,
        buffer_urls: &container_core::BufferUrlStore,
        image_cache: &mut images::ImageCache,
    ) -> Result<RenderFrame, BridgeError> {
        resolve_render_color_inheritance(&mut root, None);
        style_compositing::resolve_tree(&mut root)?;
        style_visibility::resolve_tree(&mut root)?;
        style_text::resolve_tree(&mut root, viewport)?;
        style_flex::resolve_tree(&mut root, viewport)?;
        style_stacking::apply_tree(&mut root)?;
        let images = image_cache.prepare(manifest, blobs, &mut root, document, buffer_urls)?;
        let transforms = style_transforms::prepare_tree(&mut root, viewport)?;
        self.renderer
            .ensure_mut()
            .layout_tree(&mut root, viewport)
            .map_err(render_bridge_error)?;
        style_transforms::finish_tree(&mut root, transforms)?;
        Ok(RenderFrame {
            frame_id,
            viewport,
            root,
            images,
        })
    }

    pub(super) fn accept(
        &mut self,
        prepared: PreparedSkiaFrame,
    ) -> Result<AcceptedSkiaFrame, BridgeError> {
        self.accept_with_canvas_bindings(prepared, Vec::new())
    }

    pub(super) fn accept_with_canvas_bindings(
        &mut self,
        prepared: PreparedSkiaFrame,
        bindings: Vec<CanvasOwnerKey>,
    ) -> Result<AcceptedSkiaFrame, BridgeError> {
        let PreparedSkiaFrame { frame, manifest } = prepared;
        let frame_id = frame.frame_id;
        let retired_page = self
            .renderer
            .ensure_mut()
            .prepare_page_frame_with_canvas_bindings(frame, PageFrameTargetPolicy::Legacy, bindings)
            .map_err(render_bridge_error)?
            .accept();
        // There is no fallible operation or user code between acceptance and
        // cache publication. Failed commit drops the entire cache candidate.
        let manifest = manifest.map(|candidate| {
            self.image_cache = candidate.image_cache;
            AcceptedManifestFrame {
                page_input: candidate.page_input,
                resources: candidate.resources,
                document: candidate.document,
                animations: candidate.animations,
                retained_animation_scene: candidate.retained_animation_scene,
            }
        });
        Ok(AcceptedSkiaFrame {
            frame_id,
            manifest,
            retired_page,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ManifestViewInput;
    use container_ir::{hex_digest, parse_wxml, Asset};
    use image::{ExtendedColorType, ImageEncoder};
    use serde_json::json;
    use std::collections::BTreeMap;

    #[cfg(all(
        feature = "restricted-showcase",
        feature = "skia-backend",
        not(target_arch = "wasm32")
    ))]
    #[test]
    fn restricted_native_font_renders_cjk_before_page_creation_and_moves_with_canvas() {
        let mut backend = SkiaPageBackend::new(PageRenderMode::Raster).unwrap();
        assert!(backend.renderer.peek().is_none());
        let info = backend
            .renderer
            .pre_page_canvas
            .get_mut()
            .native_font_info();
        assert_eq!(info.installed_faces, 1);
        assert!(info
            .families
            .iter()
            .any(|family| family.starts_with("Noto Sans SC")));
        let frame: CanvasFrame = serde_json::from_value(json!({
            "frame_id": 1, "canvas_id": "cjk", "width": 200, "height": 60,
            "reserve": false, "commands": [
                {"op":"setFillStyle","args":["#087951"]},
                {"op":"setFontSize","args":[24]},
                {"op":"fillText","args":["商城 点单 Web",4,36]}
            ]
        }))
        .unwrap();
        let before = backend.renderer.commit_canvas(frame.clone()).unwrap();
        assert!(
            before.pixels.chunks_exact(4).any(|pixel| pixel[3] != 0),
            "compiled CJK font produced no pixels"
        );
        assert!(
            backend.renderer.peek().is_none(),
            "Canvas must not allocate a page renderer"
        );
        let renderer = backend.renderer.ensure_mut();
        assert_eq!(renderer.native_font_info(), info);
        let after = renderer.commit_canvas(frame).unwrap();
        assert_eq!(
            before.pixels, after.pixels,
            "moving the Canvas owner changed the native font"
        );
        let mut second = SkiaPageBackend::new(PageRenderMode::Raster).unwrap();
        assert_eq!(
            second.renderer.pre_page_canvas.get_mut().native_font_info(),
            info
        );
    }

    #[test]
    fn passive_page_observations_and_resource_reset_do_not_construct_skia() {
        for mode in [PageRenderMode::Raster, PageRenderMode::ExternalFrame] {
            let mut backend = SkiaPageBackend::new(mode).unwrap();
            #[cfg(all(feature = "skia-backend", not(feature = "restricted-showcase")))]
            assert_eq!(
                backend
                    .renderer
                    .pre_page_canvas
                    .get_mut()
                    .native_font_info()
                    .installed_faces,
                0,
                "full runtimes must retain the host-owned font configuration"
            );
            assert!(backend.renderer.peek().is_none());
            assert_eq!(backend.renderer.page_render_mode(), mode);
            assert_eq!(backend.renderer.snapshot_revision(), 0);
            assert!(backend.renderer.last_frame().is_none());
            assert!(backend.renderer.snapshot_ref().is_none());
            assert!(backend.renderer.canvas_snapshot("missing").is_none());
            assert_eq!(
                backend.renderer.backend_name(),
                SkiaRenderer::configured_backend_name(mode)
            );
            backend.reset_manifest_resources();
            assert!(backend.renderer.peek_mut().is_none());
            assert!(backend.renderer.peek().is_none());

            let first = backend.renderer.ensure();
            let first = std::ptr::from_ref(first);
            assert!(backend.renderer.peek().is_some());
            assert_eq!(std::ptr::from_ref(backend.renderer.ensure()), first);
            let concrete = backend.renderer.ensure_mut();
            assert_eq!(concrete.page_render_mode(), mode);
            assert_eq!(std::ptr::from_ref(concrete), first);
            assert!(concrete.last_frame().is_none());
        }
    }

    fn canvas_frame(
        frame_id: u64,
        reserve: bool,
        commands: serde_json::Value,
    ) -> Result<CanvasFrame, serde_json::Error> {
        serde_json::from_value(json!({
            "frame_id": frame_id, "canvas_id": "main", "width": 2, "height": 1,
            "reserve": reserve, "commands": commands,
        }))
    }

    #[test]
    fn target_preflight_and_staging_keep_canvas_independent_until_the_first_page_draw(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame)?;
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        let canvas = backend.renderer.commit_canvas(canvas_frame(
            1,
            false,
            json!([{"op":"setFillStyle","args":["red"]},{"op":"fillRect","args":[0,0,1,1]}]),
        )?)?;
        let expected = RenderTargetSize {
            width: 4,
            height: 2,
        };
        assert_eq!(
            backend.renderer.validate_render_target(viewport, 2.0)?,
            expected
        );
        assert_eq!(
            backend.renderer.stage_render_target(viewport, 2.0)?,
            expected
        );
        assert!(backend
            .renderer
            .stage_render_target(viewport, f64::NAN)
            .is_err());
        assert!(backend
            .renderer
            .stage_render_target(viewport, 4096.0)
            .is_err());
        assert!(backend.renderer.peek().is_none());
        assert_eq!(backend.renderer.snapshot_revision(), 0);
        assert_eq!(
            backend.renderer.canvas_snapshot("main"),
            Some(canvas.clone())
        );

        let renderer = backend.renderer.ensure_mut();
        assert_eq!(renderer.render_scale(), 2.0);
        assert!(renderer.accepted_render_target().is_none());
        assert!(renderer.last_frame().is_none());
        assert_eq!(renderer.canvas_snapshot("main"), Some(canvas));
        renderer.commit(RenderFrame {
            frame_id: 1,
            viewport,
            root: RenderNode::new("page", viewport),
            images: BTreeMap::new(),
        })?;
        assert_eq!(renderer.accepted_render_target(), Some(expected));
        let revision = renderer.snapshot_revision();
        backend.renderer.stage_render_target(viewport, 3.0)?;
        assert_eq!(backend.renderer.snapshot_revision(), revision);
        assert_eq!(
            backend.renderer.peek().unwrap().accepted_render_target(),
            Some(expected)
        );
        Ok(())
    }

    #[test]
    fn staged_density_never_overrides_a_legacy_whole_renderer_replacement(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame)?;
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        backend.renderer.stage_render_target(viewport, 2.0)?;
        let mut replacement = SkiaRenderer::new_frame_export_only();
        replacement.configure_render_target(viewport, 3.0)?;
        replacement.commit(RenderFrame {
            frame_id: 99,
            viewport,
            root: RenderNode::new("replacement", viewport),
            images: BTreeMap::new(),
        })?;
        *backend.renderer.ensure_mut() = replacement;
        assert_eq!(backend.renderer.ensure().render_scale(), 3.0);
        assert_eq!(
            backend.renderer.ensure().accepted_render_target(),
            Some(RenderTargetSize {
                width: 6,
                height: 3
            })
        );
        backend.renderer.stage_render_target(viewport, 1.0)?;
        assert_eq!(backend.renderer.ensure().render_scale(), 1.0);
        assert_eq!(backend.renderer.ensure().last_frame().unwrap().frame_id, 99);
        assert_eq!(
            backend.renderer.ensure().accepted_render_target(),
            Some(RenderTargetSize {
                width: 6,
                height: 3
            })
        );
        let replacement = SkiaRenderer::new();
        let replacement_target = replacement.validate_render_target(viewport, 2.0);
        *backend.renderer.ensure_mut() = replacement;
        assert_eq!(backend.renderer.ensure().render_scale(), 1.0);
        assert!(backend.renderer.ensure().accepted_render_target().is_none());
        assert!(backend.renderer.ensure().last_frame().is_none());
        assert_eq!(
            backend.renderer.validate_render_target(viewport, 2.0),
            replacement_target
        );
        Ok(())
    }

    #[test]
    fn canvas_history_survives_explicit_page_initialization_without_a_page_commit(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame)?;
        let first = backend.renderer.commit_canvas(canvas_frame(
            1,
            false,
            json!([
                {"op":"setFillStyle","args":["red"]},
                {"op":"fillRect","args":[0,0,1,1]},
            ]),
        )?)?;
        assert_eq!(first.pixels, [255, 0, 0, 255, 0, 0, 0, 0]);
        assert_eq!(
            backend.renderer.canvas_snapshot("main"),
            Some(first.clone())
        );
        assert!(backend.renderer.canvas_snapshot("missing").is_none());
        assert!(backend.renderer.peek().is_none());
        assert_eq!(backend.renderer.snapshot_revision(), 0);
        assert!(backend.renderer.last_frame().is_none());

        let rejected = canvas_frame(
            2,
            true,
            json!([
                {"op":"setFillStyle","args":["blue"]},
                {"op":"lineTo","args":[1,"invalid"]},
            ]),
        )?;
        assert!(backend.renderer.commit_canvas(rejected).is_err());
        assert_eq!(
            backend.renderer.canvas_snapshot("main"),
            Some(first.clone())
        );
        assert!(backend.renderer.peek().is_none());

        let renderer = backend.renderer.ensure();
        assert_eq!(renderer.canvas_snapshot("main"), Some(first));
        assert_eq!(renderer.canvas_ids().collect::<Vec<_>>(), ["main"]);
        assert!(renderer.last_frame().is_none());
        let second = backend.renderer.commit_canvas(canvas_frame(
            2,
            true,
            json!([
                {"op":"fillRect","args":[1,0,1,1]},
            ]),
        )?)?;
        // Reserve keeps the accepted red pixel. Each admitted legacy draw
        // resets paint state, so the new rectangle uses the default black.
        assert_eq!(second.pixels, [255, 0, 0, 255, 0, 0, 0, 255]);
        assert_eq!(
            backend.renderer.ensure().canvas_snapshot("main"),
            Some(second)
        );

        // Legacy draws and typed reads continue to use that one service.
        let legacy = backend.renderer.ensure_mut().commit_canvas(canvas_frame(
            3,
            false,
            json!([
                {"op":"setFillStyle","args":["blue"]},
                {"op":"fillRect","args":[0,0,2,1]},
            ]),
        )?)?;
        assert_eq!(backend.renderer.canvas_snapshot("main"), Some(legacy));
        assert_eq!(backend.renderer.snapshot_revision(), 0);
        assert!(backend.renderer.last_frame().is_none());
        Ok(())
    }

    #[test]
    fn replacing_the_entire_renderer_cannot_resurrect_pre_page_canvas(
    ) -> Result<(), Box<dyn std::error::Error>> {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame)?;
        backend.renderer.commit_canvas(canvas_frame(
            1,
            false,
            json!([
                {"op":"setFillStyle","args":["red"]},
                {"op":"fillRect","args":[0,0,1,1]},
            ]),
        )?)?;
        assert!(backend.renderer.peek().is_none());
        *backend.renderer.ensure_mut() = SkiaRenderer::new();
        assert!(backend.renderer.canvas_snapshot("main").is_none());
        assert_eq!(backend.renderer.page_render_mode(), PageRenderMode::Raster);
        assert_eq!(backend.renderer.ensure().canvas_ids().count(), 0);
        let replacement = backend.renderer.commit_canvas(canvas_frame(
            2,
            true,
            json!([
                {"op":"fillRect","args":[1,0,1,1]},
            ]),
        )?)?;
        // The old red style/history must not return from the empty placeholder.
        assert_eq!(replacement.pixels, [0, 0, 0, 0, 0, 0, 0, 255]);
        assert_eq!(
            backend.renderer.ensure().canvas_snapshot("main"),
            Some(replacement)
        );
        assert_eq!(backend.renderer.snapshot_revision(), 0);
        Ok(())
    }

    #[test]
    fn unsupported_page_mode_fails_before_a_lazy_slot_can_be_created() {
        let supported = cfg!(any(
            feature = "skia-gpu-gles",
            all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            )
        ));
        match SkiaPageBackend::new(PageRenderMode::NativeGpu) {
            Ok(backend) => {
                assert!(supported);
                assert!(backend.renderer.peek().is_none());
            }
            Err(error) => {
                assert!(!supported);
                assert!(matches!(error, SessionError::UnsupportedCapability(_)));
                assert!(error
                    .to_string()
                    .contains("native-gpu-backend-not-compiled"));
            }
        }
    }

    fn input(color: [u8; 4], frame_id: u64) -> (ContainerManifestV1, ManifestViewInput) {
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&color, 1, 1, ExtendedColorType::Rgba8)
            .unwrap();
        let hash = hex_digest(&png);
        let mut manifest = ContainerManifestV1::default();
        manifest.assets.push(Asset {
            path: "photo.png".into(),
            sha256: hash.clone(),
            mime: "image/png".into(),
            size: png.len() as u64,
        });
        let input = ManifestViewInput {
            animation_snapshot: None,
            render: ViewRenderInputs {
                page_input: None,
                viewport: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 120.0,
                    height: 80.0,
                },
                frame_id,
                resources: Arc::new(BTreeMap::from([(format!("sha256:{hash}"), png)])),
                template_id: "template:pages/home/index.wxml".into(),
                route_path: "pages/home/index".into(),
                style_roots: Vec::new(),
            },
            ast: parse_wxml(r#"<image id="photo" src="/photo.png"/>"#).unwrap(),
            templates: BTreeMap::new(),
            data: json!({}),
        };
        (manifest, input)
    }

    fn evaluated(manifest: &ContainerManifestV1, input: ManifestViewInput) -> PreparedViewDocument {
        let ast = input.ast.clone();
        let ownership = BTreeMap::new();
        let document =
            crate::view_document::project_view_document(crate::view_document::ViewDocumentInput {
                ast: &ast,
                ownership: &ownership,
                manifest,
                blobs: &input.render.resources,
                style_roots: &input.render.style_roots,
                session_id: "backend-test",
                page_id: 0,
                revision: input.render.frame_id,
                route_path: &input.render.route_path,
            })
            .unwrap();
        PreparedViewDocument {
            buffer_urls: Arc::default(),
            input: input.render,
            document,
            animations: None,
        }
    }

    fn candidate(
        backend: &mut SkiaPageBackend,
        color: [u8; 4],
        frame_id: u64,
    ) -> PreparedSkiaFrame {
        let (manifest, input) = input(color, frame_id);
        let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
        backend
            .materialize(&manifest, evaluated(&manifest, input), preflight, true)
            .unwrap()
    }

    #[test]
    fn document_origins_authorize_relative_images_with_duplicate_public_ids() {
        let (mut manifest, mut input) = input([255, 0, 0, 255], 1);
        let mut expected = Vec::new();
        for (path, color) in [
            ("shared/photo.png", [0, 0, 255, 255]),
            ("pages/home/photo.png", [0, 255, 0, 255]),
        ] {
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(&color, 1, 1, ExtendedColorType::Rgba8)
                .unwrap();
            let hash = hex_digest(&png);
            Arc::make_mut(&mut input.render.resources)
                .insert(format!("sha256:{hash}"), png.clone());
            manifest.assets.push(Asset {
                path: path.into(),
                sha256: hash.clone(),
                mime: "image/png".into(),
                size: png.len() as u64,
            });
            expected.push((format!("sha256:{hash}"), color));
        }
        let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
        let mut prepared = evaluated(&manifest, input);
        let first = &mut prepared.document.nodes[0];
        let container_ir::ViewNode::Element {
            occurrence_id,
            attrs,
            ownership,
            ..
        } = first
        else {
            panic!("image document fixture");
        };
        *occurrence_id = "event:opaque.with:key".into();
        attrs.insert("src".into(), "photo.png?rev=1#preview".into());
        ownership.document_id = "shared/imported.wxml".into();
        ownership.event_owner = Some("declaring-component".into());
        ownership.component_scope = Some("hosted-component".into());
        let mut second = first.clone();
        let container_ir::ViewNode::Element {
            occurrence_id,
            ownership,
            ..
        } = &mut second
        else {
            unreachable!();
        };
        *occurrence_id = "event:another:opaque.key".into();
        ownership.document_id = "pages/home/index.wxml".into();
        prepared.document.nodes.push(second);
        prepared.document.validate().unwrap();
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let candidate = backend
            .materialize(&manifest, prepared, preflight, true)
            .unwrap();
        assert_eq!(
            candidate.frame.root.id,
            "page:template:pages/home/index.wxml"
        );
        assert_eq!(candidate.frame.images.len(), 2);
        for (node, (key, color)) in candidate.frame.root.children.iter().zip(expected) {
            // Neither duplicate public ids nor the page template can replace
            // declaration-local URL resolution from the evaluated document.
            assert_eq!(node.id, "photo");
            assert_eq!(node.image.as_ref().unwrap().resource, key);
            assert_eq!(&candidate.frame.images[&key].pixels[..4], &color);
            assert_eq!(
                node.event_owner_scope_id.as_deref(),
                Some("declaring-component")
            );
            assert_eq!(node.component_scope_id.as_deref(), Some("hosted-component"));
        }
        assert_eq!(
            candidate.frame.root.children[0].event_identity.as_deref(),
            Some("event:opaque.with:key")
        );
        assert_eq!(
            candidate.frame.root.children[1].event_identity.as_deref(),
            Some("event:another:opaque.key")
        );
        backend.accept(candidate).unwrap();
        assert!(backend.renderer.snapshot_ref().is_none());
    }

    #[test]
    fn materialization_and_rejected_commit_do_not_publish_candidate_decodes_or_frame() {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        assert!(backend.renderer.peek().is_none());
        let first = candidate(&mut backend, [255, 0, 0, 255], 1);
        assert!(
            backend.renderer.peek().is_some(),
            "Skia layout explicitly initializes its renderer"
        );
        let first_image = Arc::clone(first.frame.images.values().next().unwrap());
        assert!(
            backend.renderer.last_frame().is_none(),
            "materialization is not acceptance"
        );
        assert_eq!(backend.renderer.snapshot_revision(), 0);
        let accepted = backend.accept(first).unwrap();
        assert_eq!(accepted.frame_id, 1);
        assert!(accepted.manifest.is_some());
        let retained = backend.renderer.last_frame().unwrap().clone();
        let revision = backend.renderer.snapshot_revision();
        let mut rejected = candidate(&mut backend, [0, 255, 0, 255], 2);
        let rejected_image = Arc::clone(rejected.frame.images.values().next().unwrap());
        rejected.frame_mut().root.opacity = 2.0;
        assert!(backend.accept(rejected).is_err());
        assert_eq!(backend.renderer.last_frame(), Some(&retained));
        assert_eq!(backend.renderer.snapshot_revision(), revision);
        let repaired = candidate(&mut backend, [0, 255, 0, 255], 3);
        assert!(
            !Arc::ptr_eq(
                &rejected_image,
                repaired.frame.images.values().next().unwrap()
            ),
            "a failed commit cannot publish its decoded image into the accepted cache"
        );
        let original = candidate(&mut backend, [255, 0, 0, 255], 4);
        assert!(
            Arc::ptr_eq(&first_image, original.frame.images.values().next().unwrap()),
            "a rejected candidate retains the accepted cache lifetime"
        );
        assert!(
            backend.renderer.snapshot_ref().is_none(),
            "external prepare/accept never captures pixels"
        );
    }

    #[test]
    fn explicit_frames_do_not_replace_the_manifest_decode_cache_and_reset_keeps_frame_arcs() {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let prepared = candidate(&mut backend, [255, 0, 0, 255], 1);
        let decoded = Arc::clone(prepared.frame.images.values().next().unwrap());
        backend.accept(prepared).unwrap();
        let mut explicit = backend.renderer.last_frame().unwrap().clone();
        explicit.frame_id = 2;
        let accepted = backend
            .accept(PreparedSkiaFrame::explicit(explicit))
            .unwrap();
        assert!(
            accepted.manifest.is_none(),
            "raw frames cannot authorize a new manifest document/resources"
        );
        let reused = candidate(&mut backend, [255, 0, 0, 255], 3);
        assert!(Arc::ptr_eq(
            &decoded,
            reused.frame.images.values().next().unwrap()
        ));
        backend.reset_manifest_resources();
        assert!(
            Arc::ptr_eq(
                &decoded,
                backend
                    .renderer
                    .last_frame()
                    .unwrap()
                    .images
                    .values()
                    .next()
                    .unwrap()
            ),
            "manifest retirement cannot destroy an accepted frame's shared pixels"
        );
        let fresh = candidate(&mut backend, [255, 0, 0, 255], 4);
        assert!(
            !Arc::ptr_eq(&decoded, fresh.frame.images.values().next().unwrap()),
            "the replacement manifest starts an independently authorized decode lifetime"
        );
    }

    #[test]
    fn a_preflight_cannot_materialize_another_target_or_resource_lease() {
        for mismatch in ["frame", "template", "viewport", "resources"] {
            let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
            let (manifest, mut input) = input([255, 0, 0, 255], 1);
            let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
            match mismatch {
                "frame" => input.render.frame_id += 1,
                "template" => input.render.template_id = "template:other/index.wxml".into(),
                "viewport" => input.render.viewport.width += 1.0,
                "resources" => input.render.resources = Arc::new((*input.render.resources).clone()),
                _ => unreachable!(),
            }
            let error = backend
                .materialize(&manifest, evaluated(&manifest, input), preflight, true)
                .err()
                .unwrap();
            assert_eq!(error.code, BridgeErrorCode::Render, "{mismatch}");
            assert!(backend.renderer.last_frame().is_none());
            assert_eq!(backend.renderer.snapshot_revision(), 0);
        }
    }

    #[test]
    fn backend_acceptance_retains_former_page_images_until_the_session_releases_its_receipt() {
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let viewport = Rect {
            x: 0.,
            y: 0.,
            width: 1.,
            height: 1.,
        };
        let image = Arc::new(container_render_skia::ImageResource {
            width: 1,
            height: 1,
            pixels: vec![255, 0, 0, 255],
        });
        let former = Arc::downgrade(&image);
        let frame = RenderFrame {
            frame_id: 1,
            viewport,
            root: RenderNode::new("first", viewport),
            images: BTreeMap::from([("retained-page-resource".into(), image)]),
        };
        drop(backend.accept(PreparedSkiaFrame::explicit(frame)).unwrap());
        assert!(former.upgrade().is_some());
        let replacement = RenderFrame {
            frame_id: 2,
            viewport,
            root: RenderNode::new("second", viewport),
            images: BTreeMap::new(),
        };
        let receipt = backend
            .accept(PreparedSkiaFrame::explicit(replacement))
            .unwrap();
        assert_eq!(backend.renderer.last_frame().unwrap().frame_id, 2);
        assert!(
            former.upgrade().is_some(),
            "acceptance must carry former resources to Session publication"
        );
        drop(receipt);
        assert!(
            former.upgrade().is_none(),
            "the explicit release ends the old frame lifetime"
        );
    }

    fn animation_payload(kind: &str, target: f64, origin: &str) -> serde_json::Value {
        json!({"actions":[{"animates":[{"type":kind,"args":[target]}],"option":{
            "duration":100,"delay":0,"timingFunction":"linear","transformOrigin":origin
        }}]})
    }

    fn attach_animation(
        prepared: &mut PreparedViewDocument,
        payload: serde_json::Value,
    ) -> crate::animation_playback::PlaybackState {
        use crate::animation_bindings::{NodeKey, OwnerKey, PreparedDescriptor};
        let state = crate::animation_playback::PlaybackState::default();
        let descriptor = PreparedDescriptor {
            occurrence: prepared.document.nodes[0].occurrence_id().into(),
            key: NodeKey {
                owner: OwnerKey {
                    page_id: 1,
                    page_incarnation: 1,
                    scope_id: None,
                    scope_incarnation: None,
                },
                source_site: "test-root".into(),
                incarnation: 1,
            },
            resolved_paths: Vec::new(),
            payload,
            new_run: true,
        };
        let playback = state
            .prepare_bindings(
                1,
                &[descriptor],
                std::time::Duration::ZERO,
                prepared.input.viewport,
            )
            .unwrap();
        prepared.animations = Some(PreparedAnimations {
            bindings: None,
            playback,
        });
        state
    }

    #[test]
    fn new_child_baseline_observes_the_retained_sampled_parent_inheritance_context() {
        use crate::animation_bindings::{NodeKey, OwnerKey, PreparedDescriptor};
        use std::time::Duration;
        let source = r#"<view id="parent" style="opacity:.2"><view id="child" style="opacity:inherit"/></view>"#;
        let (manifest, mut first_input) = input([255, 0, 0, 255], 1);
        first_input.ast = parse_wxml(source).unwrap();
        let preflight = SkiaPageBackend::preflight(&manifest, &first_input.render).unwrap();
        let mut first = evaluated(&manifest, first_input);
        let mut state = attach_animation(&mut first, animation_payload("opacity", 1.0, "center"));
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let candidate = backend
            .materialize(&manifest, first, preflight, true)
            .unwrap();
        let accepted = backend.accept(candidate).unwrap().manifest.unwrap();
        state.accept(accepted.animations.unwrap().playback, Duration::ZERO);
        let (_, mut next_input) = input([255, 0, 0, 255], 2);
        next_input.ast = parse_wxml(source).unwrap();
        let preflight = SkiaPageBackend::preflight(&manifest, &next_input.render).unwrap();
        let mut next = evaluated(&manifest, next_input);
        let parent = next.document.nodes[0].occurrence_id().to_owned();
        let container_ir::ViewNode::Element { children, .. } = &next.document.nodes[0] else {
            panic!("parent element")
        };
        let child = children[0].occurrence_id().to_owned();
        let owner = OwnerKey {
            page_id: 1,
            page_incarnation: 1,
            scope_id: None,
            scope_incarnation: None,
        };
        let descriptors = [
            PreparedDescriptor {
                occurrence: parent,
                key: NodeKey {
                    owner: owner.clone(),
                    source_site: "test-root".into(),
                    incarnation: 1,
                },
                resolved_paths: vec![],
                payload: animation_payload("opacity", 1.0, "center"),
                new_run: false,
            },
            PreparedDescriptor {
                occurrence: child,
                key: NodeKey {
                    owner,
                    source_site: "test-child".into(),
                    incarnation: 2,
                },
                resolved_paths: vec![],
                payload: animation_payload("opacity", 0.0, "center"),
                new_run: true,
            },
        ];
        next.animations = Some(PreparedAnimations {
            bindings: None,
            playback: state
                .prepare_bindings(
                    1,
                    &descriptors,
                    Duration::from_millis(50),
                    next.input.viewport,
                )
                .unwrap(),
        });
        let candidate = backend
            .materialize(&manifest, next, preflight, true)
            .unwrap();
        let parent = &candidate.frame.root.children[0];
        assert!((parent.opacity - 0.6).abs() < 0.00001);
        assert!(
            (parent.children[0].opacity - 0.6).abs() < 0.00001,
            "new child baseline must see the captured parent sample, not its .2 declaration"
        );
        let raw = &candidate
            .manifest
            .as_ref()
            .unwrap()
            .retained_animation_scene
            .as_ref()
            .unwrap()
            .root;
        assert_eq!(raw.children[0].computed_style["opacity"], ".2");
        assert_eq!(
            raw.children[0].children[0].computed_style["opacity"],
            "inherit"
        );
    }

    #[test]
    fn retained_samples_recompute_explicit_inheritance_from_the_unresolved_base_scene() {
        let (manifest, mut input) = input([255, 0, 0, 255], 1);
        input.ast=parse_wxml(r#"<view id="parent" style="opacity:.2"><view id="child" style="opacity:inherit"/></view>"#).unwrap();
        let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
        let mut prepared = evaluated(&manifest, input);
        let resources = Arc::clone(&prepared.input.resources);
        let document = prepared.document.clone();
        let mut playback =
            attach_animation(&mut prepared, animation_payload("opacity", 1.0, "center"));
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let frame = backend
            .materialize(&manifest, prepared, preflight, true)
            .unwrap();
        assert_eq!(frame.frame.root.children[0].opacity, 0.2);
        assert_eq!(frame.frame.root.children[0].children[0].opacity, 0.2);
        let mut accepted = backend.accept(frame).unwrap().manifest.unwrap();
        playback.accept(
            accepted.animations.take().unwrap().playback,
            std::time::Duration::ZERO,
        );
        let retained = accepted.retained_animation_scene.unwrap();
        assert_eq!(retained.root.children[0].computed_style["opacity"], ".2");
        assert_eq!(
            retained.root.children[0].children[0].computed_style["opacity"],
            "inherit"
        );
        let old_frame = backend.renderer.last_frame().unwrap().clone();
        let old_revision = backend.renderer.snapshot_revision();
        let now = std::time::Duration::from_millis(50);
        playback.request_sample(1, now).unwrap();
        let sampled = playback.prepare_sample(1, now, retained.viewport).unwrap();
        let candidate = backend
            .prepare_animation_sample(&manifest, &retained, sampled)
            .unwrap();
        assert_eq!(candidate.frame.frame_id, 1);
        assert!(candidate.animations().unwrap().bindings.is_none());
        assert!((candidate.frame.root.children[0].opacity - 0.6).abs() < 0.00001);
        assert!((candidate.frame.root.children[0].children[0].opacity - 0.6).abs() < 0.00001);
        assert_eq!(backend.renderer.last_frame(), Some(&old_frame));
        assert_eq!(backend.renderer.snapshot_revision(), old_revision);
        let accepted = backend.accept(candidate).unwrap().manifest.unwrap();
        assert!(Arc::ptr_eq(&accepted.resources, &resources));
        assert_eq!(accepted.document, document);
        assert!(accepted.page_input.is_none());
        assert!(accepted.retained_animation_scene.is_some());
    }

    #[test]
    fn native_baselines_use_final_percent_geometry_and_samples_keep_normalized_origin_units() {
        let (manifest, mut input) = input([255, 0, 0, 255], 1);
        input.ast=parse_wxml(r#"<view id="parent" style="width:40px;height:40px;font-size:20px;transform:translateX(50%);transform-origin:25% 75%"><view style="position:absolute;left:5px;top:6px;width:2px;height:2px"/></view>"#).unwrap();
        let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
        let mut prepared = evaluated(&manifest, input);
        let mut playback = attach_animation(
            &mut prepared,
            animation_payload("translateX", 60.0, "1em 50%"),
        );
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let candidate = backend
            .materialize(&manifest, prepared, preflight, true)
            .unwrap();
        let first = &candidate.frame.root.children[0];
        assert_eq!(first.style.unwrap().transform.unwrap().e, 20.0);
        assert_eq!(first.computed_style["transform-origin"], "20px 20px");
        assert_eq!(first.children[0].bounds.x, first.bounds.x + 5.0);
        let mut accepted = backend.accept(candidate).unwrap().manifest.unwrap();
        playback.accept(
            accepted.animations.take().unwrap().playback,
            std::time::Duration::ZERO,
        );
        let retained = accepted.retained_animation_scene.unwrap();
        let now = std::time::Duration::from_millis(50);
        playback.request_sample(1, now).unwrap();
        let candidate = backend
            .prepare_animation_sample(
                &manifest,
                &retained,
                playback.prepare_sample(1, now, retained.viewport).unwrap(),
            )
            .unwrap();
        let sampled = &candidate.frame.root.children[0];
        assert_eq!(sampled.style.unwrap().transform.unwrap().e, 40.0);
        assert_eq!(sampled.computed_style["transform-origin"], "20px 20px");
        assert_eq!(sampled.children[0].bounds.x, sampled.bounds.x + 5.0);
    }

    #[test]
    fn retained_samples_reauthorize_buffer_urls_before_any_frame_or_cache_publication() {
        let (manifest, mut input) = input([255, 0, 0, 255], 1);
        let bytes = input.render.resources.values().next().unwrap();
        let buffer_urls = Arc::new(container_core::BufferUrlStore::default());
        let hex = bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let answer: serde_json::Value =
            serde_json::from_str(&buffer_urls.invoke_json("create", &hex)).unwrap();
        let url = answer["value"].as_str().unwrap();
        let path = container_core::BufferUrlStore::resource_path(url).unwrap();
        input.ast = parse_wxml(&format!(
            r#"<image id="photo" style="opacity:.2" src="/{path}"/>"#
        ))
        .unwrap();
        let preflight = SkiaPageBackend::preflight(&manifest, &input.render).unwrap();
        let mut prepared = evaluated(&manifest, input);
        prepared.buffer_urls = Arc::clone(&buffer_urls);
        let mut playback =
            attach_animation(&mut prepared, animation_payload("opacity", 1.0, "center"));
        let mut backend = SkiaPageBackend::new(PageRenderMode::ExternalFrame).unwrap();
        let candidate = backend
            .materialize(&manifest, prepared, preflight, true)
            .unwrap();
        let image = Arc::clone(candidate.frame.images.values().next().unwrap());
        let mut accepted = backend.accept(candidate).unwrap().manifest.unwrap();
        playback.accept(
            accepted.animations.take().unwrap().playback,
            std::time::Duration::ZERO,
        );
        let retained = accepted.retained_animation_scene.unwrap();
        let before = backend.renderer.last_frame().unwrap().clone();
        let revision = backend.renderer.snapshot_revision();
        buffer_urls.revoke(url).unwrap();
        let now = std::time::Duration::from_millis(50);
        playback.request_sample(1, now).unwrap();
        assert!(backend
            .prepare_animation_sample(
                &manifest,
                &retained,
                playback.prepare_sample(1, now, retained.viewport).unwrap()
            )
            .is_err());
        assert_eq!(backend.renderer.last_frame(), Some(&before));
        assert_eq!(backend.renderer.snapshot_revision(), revision);
        assert!(Arc::ptr_eq(
            &image,
            backend
                .renderer
                .last_frame()
                .unwrap()
                .images
                .values()
                .next()
                .unwrap()
        ));
    }
}
