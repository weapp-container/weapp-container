//! Actual page preparation followed by an allocation-free field handoff.
//! Canvas, fonts and native contexts remain with their one renderer owner.
use super::*;

/// Preserve ordinary commit's backend-specific target behavior, or explicitly
/// opt into the bounded developer target without staging renderer settings.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum PageFrameTargetPolicy {
    /// Commits use the configured density. The software 1× path retains its
    /// wider-than-4096 legacy support; scaled targets obey the pixel budget.
    Legacy,
    /// A real physical target with the developer side/byte/backend limits.
    Development { scale: f64 },
}

/// Configuration-only candidate pinned to the exact renderer/mode that
/// validated it. Acceptance changes only the density for a future page draw;
/// old accepted pixels, target, Canvas, fonts and GPU owners remain intact.
#[must_use = "drop preserves the previous future target configuration"]
pub struct PreparedRenderTarget<'a> {
    renderer: &'a mut SkiaRenderer,
    target: ValidatedPageRenderTarget,
}

impl PreparedRenderTarget<'_> {
    pub fn target(&self) -> RenderTargetSize {
        self.target.size()
    }

    pub fn accept(self) {
        self.renderer.render_scale = self.target.scale;
    }
}

pub(super) struct PreparedSoftwarePage {
    frame: RenderFrame,
    snapshot: Option<RenderSnapshot>,
    revision: u64,
}

pub(super) struct RetiredSoftwarePage {
    _frame: Option<RenderFrame>,
    _snapshot: Option<RenderSnapshot>,
}

impl PreparedSoftwarePage {
    pub(super) fn prepare(
        renderer: &SoftwareRenderer,
        frame: RenderFrame,
        capture_snapshot: bool,
    ) -> Result<Self, RenderError> {
        let surface = viewport_surface_layout(frame.viewport, u32::MAX)?;
        SoftwareRenderer::validate_node(&frame.root)?;
        images::validate(&frame)?;
        compositing::layer_depth(&frame.root, surface.bytes)?;
        let revision = renderer
            .snapshot_revision
            .checked_add(1)
            .ok_or(RenderError::Unsupported("page-render-revision-exhausted"))?;
        let snapshot = capture_snapshot
            .then(|| SoftwareRenderer::rasterize(&frame))
            .transpose()?;
        Ok(Self {
            frame,
            snapshot,
            revision,
        })
    }

    /// Transfer both old allocations out; the caller chooses their drop site.
    pub(super) fn accept(self, renderer: &mut SoftwareRenderer) -> RetiredSoftwarePage {
        let retired = RetiredSoftwarePage {
            _frame: renderer.last_frame.replace(self.frame),
            _snapshot: std::mem::replace(&mut renderer.last_snapshot, self.snapshot),
        };
        renderer.snapshot_revision = self.revision;
        retired
    }
}

struct PreparedPageData {
    software: PreparedSoftwarePage,
    component_frames: BTreeMap<String, Arc<ImageResource>>,
    canvas_bindings: Vec<CanvasOwnerKey>,
    canvas_update: Option<owned_canvas::PreparedOwnedCanvasUpdate>,
    target: RenderTargetSize,
    scale: f64,
}

/// An exclusive, paint-ready candidate for this exact renderer. Raster pixels
/// exist before this value is returned. Export/GPU candidates contain no page
/// CPU bitmap and grant no host presentation evidence. Drop discards only the
/// candidate; independent font lookup caches may have grown during preparation.
#[must_use = "drop discards the prepared page without accepting it"]
pub struct PreparedPageFrame<'a> {
    renderer: &'a mut SkiaRenderer,
    data: PreparedPageData,
    render_ms: f64,
    #[cfg(feature = "skia-backend")]
    images: BTreeMap<String, images::NativeImage>,
    #[cfg(feature = "skia-backend")]
    surface: Option<skia::Surface>,
    #[cfg(feature = "skia-backend")]
    snapshot: Option<RenderSnapshot>,
}

struct RetiredPageFrame {
    _software: RetiredSoftwarePage,
    _component_frames: BTreeMap<String, Arc<ImageResource>>,
    _canvas_bindings: Vec<CanvasOwnerKey>,
    _canvas_surfaces: Option<owned_canvas::OwnedCanvasSurfaces>,
    _canvas_update_owner: Option<CanvasOwnerKey>,
    #[cfg(feature = "skia-backend")]
    _images: BTreeMap<String, images::NativeImage>,
    #[cfg(feature = "skia-backend")]
    _surface: Option<skia::Surface>,
    #[cfg(feature = "skia-backend")]
    _snapshot: Option<RenderSnapshot>,
}

/// Acceptance keeps the former page allocations alive. Joint publishers can
/// retain this receipt until their Web store is unlocked, then release it.
/// It contains no independent Canvas, font provider or GPU context owner.
#[must_use = "retain until outside the joint publication critical section"]
pub struct AcceptedPageFrame {
    revision: u64,
    _retired: RetiredPageFrame,
}

impl AcceptedPageFrame {
    pub fn render_revision(&self) -> u64 {
        self.revision
    }
}

impl PreparedPageFrame<'_> {
    pub fn frame(&self) -> &RenderFrame {
        &self.data.software.frame
    }

    pub fn target(&self) -> RenderTargetSize {
        self.data.target
    }

    pub fn render_revision(&self) -> u64 {
        self.data.software.revision
    }

    pub fn render_scale(&self) -> f64 {
        self.data.scale
    }

    pub fn render_ms(&self) -> f64 {
        self.render_ms
    }

    pub fn page_render_mode(&self) -> PageRenderMode {
        self.renderer.page_render_mode
    }

    /// Independent Canvas result staged by this combined draw/page transaction.
    pub fn owned_canvas_snapshot(&self) -> Option<&RenderSnapshot> {
        self.data
            .canvas_update
            .as_ref()
            .map(|update| update.snapshot())
    }

    pub fn snapshot(&self) -> Option<&RenderSnapshot> {
        #[cfg(feature = "skia-backend")]
        if let Some(snapshot) = &self.snapshot {
            return Some(snapshot);
        }
        self.data.software.snapshot.as_ref()
    }

    /// Consume once. All validation, revision checks, allocation, image work,
    /// paint and readback have finished. Only move prepared page fields and
    /// revoke old frame-specific attachment flags; do not release old pixels,
    /// scenes, surfaces or images in this critical section.
    pub fn accept(self) -> AcceptedPageFrame {
        let revision = self.data.software.revision;
        let renderer = self.renderer;
        #[cfg(feature = "skia-backend")]
        let published_canvas = self.data.canvas_update.is_some();
        let (canvas_surfaces, canvas_update_owner) = match self.data.canvas_update {
            Some(update) => (
                Some(std::mem::replace(
                    &mut renderer.canvas.owned,
                    update.surfaces,
                )),
                Some(update.owner),
            ),
            None => (None, None),
        };
        let retired = RetiredPageFrame {
            _component_frames: std::mem::replace(
                &mut renderer.component_frames,
                self.data.component_frames,
            ),
            _canvas_bindings: std::mem::replace(
                &mut renderer.canvas_bindings,
                self.data.canvas_bindings,
            ),
            _canvas_surfaces: canvas_surfaces,
            _canvas_update_owner: canvas_update_owner,
            _software: self.data.software.accept(&mut renderer.software_fallback),
            #[cfg(feature = "skia-backend")]
            _images: std::mem::replace(&mut renderer.native_images, self.images),
            #[cfg(feature = "skia-backend")]
            _surface: std::mem::replace(&mut renderer.native_surface, self.surface),
            #[cfg(feature = "skia-backend")]
            _snapshot: std::mem::replace(&mut renderer.native_snapshot, self.snapshot),
        };
        renderer.render_scale = self.data.scale;
        renderer.accepted_render_target = Some(self.data.target);
        renderer.accepted_render_scale = Some(self.data.scale);
        renderer.last_render_ms = self.render_ms;
        #[cfg(feature = "skia-backend")]
        {
            if published_canvas || renderer.page_render_mode != PageRenderMode::ExternalFrame {
                // This is only NativeFonts' scalar install-lifetime flag.
                // GPU preparation does not use fonts, so discarding its
                // candidate must not seal a still-installable provider.
                renderer.canvas.native_fonts.begin_render();
            }
            renderer.invalidate_gpu_presentation();
        }
        AcceptedPageFrame {
            revision,
            _retired: retired,
        }
    }
}

impl SkiaRenderer {
    /// Bind pure target validation to this unchanged renderer owner before a
    /// joint publisher acquires its external-store lock.
    pub fn prepare_render_target(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<PreparedRenderTarget<'_>, RenderError> {
        let target = ValidatedPageRenderTarget::new(self.page_render_mode, viewport, scale)?;
        Ok(PreparedRenderTarget {
            renderer: self,
            target,
        })
    }

    pub fn prepare_page_frame(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        // A decoded legacy frame is not an owned Canvas binding capability.
        self.prepare_page_frame_with_owned_update(frame, policy, Vec::new(), None)
    }

    pub fn prepare_page_frame_with_canvas_bindings(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        bindings: Vec<CanvasOwnerKey>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        self.prepare_page_frame_with_owned_update(frame, policy, bindings, None)
    }

    pub(super) fn prepare_page_frame_with_owned_update(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        bindings: Vec<CanvasOwnerKey>,
        update: Option<owned_canvas::PreparedOwnedCanvasUpdate>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        let components = self.component_frames.clone();
        self.prepare_page_frame_state(frame, policy, components, bindings, update)
    }

    pub(super) fn prepare_page_frame_with_components(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        components: BTreeMap<String, Arc<ImageResource>>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        let bindings = self.canvas_bindings.clone();
        self.prepare_page_frame_state(frame, policy, components, bindings, None)
    }

    fn prepare_page_frame_state(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        components: BTreeMap<String, Arc<ImageResource>>,
        bindings: Vec<CanvasOwnerKey>,
        update: Option<owned_canvas::PreparedOwnedCanvasUpdate>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        #[cfg(feature = "skia-backend")]
        {
            self.prepare_page_frame_state_readback(
                frame,
                policy,
                components,
                bindings,
                update,
                native_raster::readback_native,
            )
        }
        #[cfg(not(feature = "skia-backend"))]
        {
            let started = Instant::now();
            let mut data = self.prepare_page_data(frame, policy, components, bindings, update)?;
            if self.page_render_mode == PageRenderMode::Raster {
                data.software.snapshot = Some(SoftwareRenderer::rasterize_at_size(
                    &data.software.frame,
                    data.target.width,
                    data.target.height,
                )?);
            }
            Ok(PreparedPageFrame {
                renderer: self,
                data,
                render_ms: started.elapsed().as_secs_f64() * 1000.0,
            })
        }
    }

    fn prepare_page_data(
        &self,
        mut frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        mut component_frames: BTreeMap<String, Arc<ImageResource>>,
        canvas_bindings: Vec<CanvasOwnerKey>,
        canvas_update: Option<owned_canvas::PreparedOwnedCanvasUpdate>,
    ) -> Result<PreparedPageData, RenderError> {
        native_components::attach(&mut frame, &mut component_frames)?;
        let surfaces = canvas_update
            .as_ref()
            .map_or(&self.canvas.owned, |update| &update.surfaces);
        owned_canvas::attach(&mut frame, &canvas_bindings, surfaces)?;
        Self::validate_viewport(frame.viewport)?;
        // Keep ordinary SkiaRenderer commit's logical representation limit;
        // standalone SoftwareRenderer retains its own u32 viewport contract.
        let dimensions = viewport_surface_layout(frame.viewport, i32::MAX as u32)?;
        let software = PreparedSoftwarePage::prepare(&self.software_fallback, frame, false)?;
        let (target, scale) = match policy {
            PageFrameTargetPolicy::Legacy
                if self.page_render_mode == PageRenderMode::Raster
                    && !cfg!(feature = "skia-backend")
                    && self.render_scale == 1.0 =>
            {
                (
                    RenderTargetSize {
                        width: dimensions.width,
                        height: dimensions.height,
                    },
                    self.render_scale,
                )
            }
            PageFrameTargetPolicy::Legacy => (
                self.validate_render_target(software.frame.viewport, self.render_scale)?,
                self.render_scale,
            ),
            PageFrameTargetPolicy::Development { scale } => (
                ValidatedPageRenderTarget::new(
                    self.page_render_mode,
                    software.frame.viewport,
                    scale,
                )?
                .size(),
                scale,
            ),
        };
        let (_, physical_bytes) = rgba_buffer_layout(target.width, target.height)?;
        compositing::layer_depth(&software.frame.root, physical_bytes)?;
        Ok(PreparedPageData {
            software,
            component_frames,
            canvas_bindings,
            canvas_update,
            target,
            scale,
        })
    }

    #[cfg(all(test, feature = "skia-backend"))]
    fn prepare_page_frame_with_readback(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        readback: impl FnOnce(&mut skia::Surface, u64, u32, u32) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        let components = self.component_frames.clone();
        self.prepare_page_frame_with_component_readback(frame, policy, components, readback)
    }

    #[cfg(all(test, feature = "skia-backend"))]
    fn prepare_page_frame_with_component_readback(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        components: BTreeMap<String, Arc<ImageResource>>,
        readback: impl FnOnce(&mut skia::Surface, u64, u32, u32) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        let bindings = self.canvas_bindings.clone();
        self.prepare_page_frame_state_readback(frame, policy, components, bindings, None, readback)
    }

    #[cfg(feature = "skia-backend")]
    fn prepare_page_frame_state_readback(
        &mut self,
        frame: RenderFrame,
        policy: PageFrameTargetPolicy,
        components: BTreeMap<String, Arc<ImageResource>>,
        bindings: Vec<CanvasOwnerKey>,
        update: Option<owned_canvas::PreparedOwnedCanvasUpdate>,
        readback: impl FnOnce(&mut skia::Surface, u64, u32, u32) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<PreparedPageFrame<'_>, RenderError> {
        let started = Instant::now();
        let data = self.prepare_page_data(frame, policy, components, bindings, update)?;
        let mut surface = None;
        let mut snapshot = None;
        let images = if self.page_render_mode == PageRenderMode::ExternalFrame {
            BTreeMap::new()
        } else {
            let images = images::prepare_native(&data.software.frame.images, &self.native_images)?;
            if self.page_render_mode == PageRenderMode::Raster {
                let mut raster = Self::render_native(
                    &data.software.frame,
                    &mut self.canvas.native_fonts,
                    &images,
                    data.target,
                )?;
                snapshot = Some(readback(
                    &mut raster,
                    data.software.frame.frame_id,
                    data.target.width,
                    data.target.height,
                )?);
                surface = Some(raster);
            }
            images
        };
        Ok(PreparedPageFrame {
            renderer: self,
            data,
            render_ms: started.elapsed().as_secs_f64() * 1000.0,
            images,
            surface,
            snapshot,
        })
    }

    #[cfg(all(test, feature = "skia-backend"))]
    pub(super) fn commit_native_frame(
        &mut self,
        frame: RenderFrame,
        readback: impl FnOnce(&mut skia::Surface, u64, u32, u32) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<(), RenderError> {
        let accepted = self
            .prepare_page_frame_with_readback(frame, PageFrameTargetPolicy::Legacy, readback)?
            .accept();
        drop(accepted);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "skia-backend")]
    #[test]
    fn owned_canvas_page_readback_failure_keeps_old_canvas_and_next_reserve_base() {
        let owner = CanvasOwnerKey {
            page_id: 1,
            page_incarnation: 1,
            scope_id: None,
            scope_incarnation: None,
            node_identity: "canvas-occurrence".into(),
            node_generation: 1,
        };
        let mut frame = page(1, 0);
        frame.viewport.width = 3.;
        frame.root.bounds = frame.viewport;
        frame.root.tag = Some("canvas".into());
        frame.root.event_identity = Some(owner.node_identity.clone());
        let draw = |color: &str, x: u32, reserve: bool| CanvasFrame {
            frame_id: 2,
            canvas_id: "shared".into(),
            width: 3,
            height: 1,
            reserve,
            commands: vec![
                CanvasCommand {
                    op: "setFillStyle".into(),
                    args: vec![serde_json::json!(color)],
                },
                CanvasCommand {
                    op: "fillRect".into(),
                    args: vec![
                        serde_json::json!(x),
                        serde_json::json!(0),
                        serde_json::json!(1),
                        serde_json::json!(1),
                    ],
                },
            ],
        };
        let mut renderer = SkiaRenderer::new();
        drop(
            renderer
                .prepare_page_frame_with_canvas_bindings(
                    frame,
                    PageFrameTargetPolicy::Legacy,
                    vec![owner.clone()],
                )
                .unwrap()
                .accept(),
        );
        drop(
            renderer
                .prepare_owned_canvas_draw(&owner, draw("red", 0, false))
                .unwrap()
                .accept(),
        );
        let old_canvas = renderer.owned_canvas_snapshot(&owner).unwrap();
        let old_frame = renderer.last_frame().unwrap().clone();
        let old_pixels = renderer.snapshot_ref().unwrap().clone();
        let old_revision = renderer.snapshot_revision();
        let old_surface = renderer.canvas.owned[&owner].clone();
        let components = renderer.component_frames.clone();
        let bindings = renderer.canvas_bindings.clone();
        let update = renderer
            .canvas
            .prepare_owned_update(&owner, draw("blue", 1, true))
            .unwrap();
        assert!(matches!(
            renderer.prepare_page_frame_state_readback(
                old_frame.clone(),
                PageFrameTargetPolicy::Legacy,
                components,
                bindings,
                Some(update),
                |_, _, _, _| Err(RenderError::Unsupported("owned-page-readback")),
            ),
            Err(RenderError::Unsupported("owned-page-readback"))
        ));
        assert_eq!(renderer.owned_canvas_snapshot(&owner), Some(old_canvas));
        assert_eq!(renderer.last_frame(), Some(&old_frame));
        assert_eq!(renderer.snapshot_ref(), Some(&old_pixels));
        assert_eq!(renderer.snapshot_revision(), old_revision);
        assert!(Arc::ptr_eq(&old_surface, &renderer.canvas.owned[&owner]));
        drop(
            renderer
                .prepare_owned_canvas_draw(&owner, draw("green", 2, true))
                .unwrap()
                .accept(),
        );
        assert_eq!(
            renderer.owned_canvas_snapshot(&owner).unwrap().pixels,
            [255, 0, 0, 255, 0, 0, 0, 0, 0, 128, 0, 255]
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn rejected_native_page_readback_keeps_font_installation_open() {
        let mut renderer = SkiaRenderer::new();
        assert!(renderer
            .prepare_page_frame_with_readback(
                page(1, 30),
                PageFrameTargetPolicy::Legacy,
                |_, _, _, _| Err(RenderError::Unsupported("first-page-readback")),
            )
            .is_err());
        // Invalid bytes reach face validation while installation is open;
        // a frozen provider would reject earlier with its lifetime error.
        let invalid = NativeFontData::new(Arc::from([]), 0);
        assert!(
            matches!(renderer.canvas.install_native_fonts(&[invalid]), Err(RenderError::InvalidFont(message)) if message.contains("empty bytes or an invalid collection index"))
        );
    }

    fn page(id: u64, red: u8) -> RenderFrame {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 1.0,
        };
        let mut root = RenderNode::new(format!("page-{id}"), viewport);
        root.background = Some(Color {
            red,
            green: 20,
            blue: 30,
            alpha: 255,
        });
        RenderFrame {
            frame_id: id,
            viewport,
            root,
            images: BTreeMap::new(),
        }
    }

    fn resource_page(id: u64, resource: &Arc<ImageResource>) -> RenderFrame {
        let mut frame = page(id, 0);
        frame.images.insert("image".into(), resource.clone());
        frame.root.image = Some(RenderImage {
            resource: "image".into(),
            mode: ImageMode::ScaleToFill,
        });
        frame
    }

    fn resource(red: u8) -> Arc<ImageResource> {
        Arc::new(ImageResource {
            width: 1,
            height: 1,
            pixels: vec![red, 0, 0, 255],
        })
    }

    #[test]
    fn future_target_candidate_changes_only_configuration_when_accepted() {
        let mut renderer = SkiaRenderer::new_with_validated_page_render_mode(
            ValidatedPageRenderMode::new(PageRenderMode::ExternalFrame).unwrap(),
        );
        let frame = page(1, 40);
        renderer.commit(frame.clone()).unwrap();
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        let scale = renderer.accepted_render_scale();
        let canvas = std::ptr::from_ref(&renderer.canvas);
        let pending = renderer.prepare_render_target(frame.viewport, 2.0).unwrap();
        assert_eq!(
            pending.target(),
            RenderTargetSize {
                width: 4,
                height: 2
            }
        );
        drop(pending);
        assert_eq!(renderer.render_scale(), 1.0);
        renderer
            .prepare_render_target(frame.viewport, 2.0)
            .unwrap()
            .accept();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.accepted_render_target(), target);
        assert_eq!(renderer.accepted_render_scale(), scale);
        assert_eq!(renderer.last_frame(), Some(&frame));
        assert!(renderer.snapshot_ref().is_none());
        assert_eq!(std::ptr::from_ref(&renderer.canvas), canvas);
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn software_future_target_accepts_physical_density_without_mutating_state() {
        let mut renderer = SkiaRenderer::new();
        let target = renderer
            .prepare_render_target(page(1, 0).viewport, 2.0)
            .unwrap();
        assert_eq!(
            target.target(),
            RenderTargetSize {
                width: 4,
                height: 2
            }
        );
        drop(target);
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.snapshot_revision(), 0);
        assert!(renderer.last_frame().is_none());
    }

    #[test]
    fn raster_pixels_are_ready_before_accept_and_drop_preserves_accepted_page() {
        let mut renderer = SkiaRenderer::new();
        let old = page(1, 40);
        renderer.commit(old.clone()).unwrap();
        let pixels = renderer.snapshot_ref().unwrap().clone();
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        let render_ms = renderer.last_render_ms();
        {
            let candidate = renderer
                .prepare_page_frame(page(2, 90), PageFrameTargetPolicy::Legacy)
                .unwrap();
            assert_eq!(candidate.frame().frame_id, 2);
            assert_eq!(candidate.render_revision(), revision + 1);
            assert_eq!(
                candidate.snapshot().unwrap().pixels,
                [90, 20, 30, 255, 90, 20, 30, 255]
            );
            // Preparation owns a new page; the renderer still identifies and
            // exposes only its old accepted page until the move boundary.
            assert_eq!(candidate.renderer.last_frame(), Some(&old));
            assert_eq!(candidate.renderer.snapshot_revision(), revision);
            assert_eq!(candidate.renderer.snapshot_ref(), Some(&pixels));
            assert_eq!(candidate.renderer.accepted_render_target(), target);
        }
        assert_eq!(renderer.last_frame(), Some(&old));
        assert_eq!(renderer.snapshot_ref(), Some(&pixels));
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.accepted_render_target(), target);
        assert_eq!(renderer.last_render_ms(), render_ms);
    }

    #[test]
    fn acceptance_moves_once_and_defers_old_page_resource_release() {
        let mut renderer = SkiaRenderer::new();
        let old_resource = resource(30);
        renderer.commit(resource_page(1, &old_resource)).unwrap();
        let old_count = Arc::strong_count(&old_resource);
        let canvas_owner = &renderer.canvas as *const CanvasService;
        let next_resource = resource(90);
        let candidate = renderer
            .prepare_page_frame(
                resource_page(2, &next_resource),
                PageFrameTargetPolicy::Legacy,
            )
            .unwrap();
        let expected_pixels = candidate.snapshot().unwrap().clone();
        let next_revision = candidate.render_revision();
        let accepted = candidate.accept();
        assert_eq!(accepted.render_revision(), next_revision);
        assert_eq!(renderer.snapshot_revision(), next_revision);
        assert_eq!(renderer.last_frame().unwrap().frame_id, 2);
        assert_eq!(renderer.snapshot_ref(), Some(&expected_pixels));
        assert_eq!(&renderer.canvas as *const CanvasService, canvas_owner);
        assert_eq!(Arc::strong_count(&old_resource), old_count);
        assert_eq!(
            accepted
                ._retired
                ._software
                ._frame
                .as_ref()
                .unwrap()
                .frame_id,
            1
        );
        drop(accepted);
        assert_eq!(Arc::strong_count(&old_resource), 1);
        drop(
            renderer
                .prepare_page_frame(page(3, 100), PageFrameTargetPolicy::Legacy)
                .unwrap(),
        );
        assert_eq!(renderer.snapshot_revision(), next_revision);
    }

    #[test]
    fn malformed_frame_or_image_keeps_old_scene_pixels_and_revision() {
        let mut renderer = SkiaRenderer::new();
        let image = resource(50);
        renderer.commit(resource_page(1, &image)).unwrap();
        let old = renderer.last_frame().unwrap().clone();
        let pixels = renderer.snapshot_ref().unwrap().clone();
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        let mut invalid_node = page(2, 90);
        invalid_node.root.opacity = f32::NAN;
        let mut invalid_image = page(3, 100);
        invalid_image.images.insert(
            "bad".into(),
            Arc::new(ImageResource {
                width: 1,
                height: 1,
                pixels: vec![1],
            }),
        );
        for invalid in [invalid_node, invalid_image] {
            assert!(renderer
                .prepare_page_frame(invalid, PageFrameTargetPolicy::Legacy)
                .is_err());
            assert_eq!(renderer.last_frame(), Some(&old));
            assert_eq!(renderer.snapshot_ref(), Some(&pixels));
            assert_eq!(renderer.snapshot_revision(), revision);
            assert_eq!(renderer.accepted_render_target(), target);
            assert!(Arc::ptr_eq(
                &renderer.last_frame().unwrap().images["image"],
                &image
            ));
        }
    }

    #[test]
    fn page_revision_exhaustion_is_checked_before_any_acceptance() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        renderer.commit(page(1, 20)).unwrap();
        renderer.software_fallback.snapshot_revision = u64::MAX;
        assert!(matches!(
            renderer.prepare_page_frame(page(2, 30), PageFrameTargetPolicy::Legacy),
            Err(RenderError::Unsupported("page-render-revision-exhausted"))
        ));
        assert_eq!(renderer.last_frame().unwrap().frame_id, 1);
        assert_eq!(renderer.snapshot_revision(), u64::MAX);

        let mut software = SoftwareRenderer::new();
        software.commit(page(1, 20)).unwrap();
        software.snapshot_revision = u64::MAX;
        let old = software.snapshot().unwrap();
        assert!(software.commit(page(2, 30)).is_err());
        assert_eq!(software.snapshot(), Some(old));
        assert_eq!(software.last_frame().unwrap().frame_id, 1);
    }

    #[test]
    fn export_preparation_has_no_page_pixels_or_presentation_evidence() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let candidate = renderer
            .prepare_page_frame(
                page(1, 20),
                PageFrameTargetPolicy::Development { scale: 2.0 },
            )
            .unwrap();
        assert!(candidate.snapshot().is_none());
        assert_eq!(
            candidate.target(),
            RenderTargetSize {
                width: 4,
                height: 2
            }
        );
        assert!(candidate.renderer.last_frame().is_none());
        assert!(!candidate.renderer.has_gpu_surface());
        let accepted = candidate.accept();
        assert_eq!(accepted.render_revision(), 1);
        assert!(renderer.snapshot_ref().is_none());
        assert!(!renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        drop(accepted);
    }

    #[test]
    fn accepted_density_is_pinned_only_by_successful_page_acceptance() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        assert_eq!(renderer.accepted_render_scale(), None);
        let frame = page(1, 20);
        renderer
            .configure_render_target(frame.viewport, 2.0)
            .unwrap();
        drop(
            renderer
                .prepare_page_frame(
                    frame.clone(),
                    PageFrameTargetPolicy::Development { scale: 3.0 },
                )
                .unwrap(),
        );
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.accepted_render_scale(), None);
        let accepted = renderer
            .prepare_page_frame(frame, PageFrameTargetPolicy::Development { scale: 3.0 })
            .unwrap()
            .accept();
        assert_eq!(renderer.accepted_render_scale(), Some(3.0));
        renderer
            .configure_render_target(page(2, 30).viewport, 4.0)
            .unwrap();
        assert_eq!(renderer.render_scale(), 4.0);
        assert_eq!(renderer.accepted_render_scale(), Some(3.0));
        let mut invalid = page(2, 30);
        invalid.root.opacity = f32::NAN;
        assert!(renderer
            .prepare_page_frame(invalid, PageFrameTargetPolicy::Development { scale: 2.0 })
            .is_err());
        assert_eq!(renderer.accepted_render_scale(), Some(3.0));
        assert_eq!(renderer.snapshot_revision(), accepted.render_revision());
        drop(accepted);
    }

    #[cfg(not(feature = "skia-backend"))]
    #[test]
    fn legacy_wide_software_page_and_explicit_developer_budget_stay_distinct() {
        let mut renderer = SkiaRenderer::new();
        let mut wide = page(1, 20);
        wide.viewport.width = 4097.0;
        wide.root.bounds = wide.viewport;
        let candidate = renderer
            .prepare_page_frame(wide.clone(), PageFrameTargetPolicy::Legacy)
            .unwrap();
        assert_eq!(candidate.snapshot().unwrap().width, 4097);
        drop(candidate.accept());
        let revision = renderer.snapshot_revision();
        assert!(matches!(
            renderer.prepare_page_frame(wide, PageFrameTargetPolicy::Development { scale: 1.0 }),
            Err(RenderError::RenderTargetBudgetExceeded)
        ));
        assert_eq!(renderer.snapshot_ref().unwrap().width, 4097);
        assert_eq!(renderer.snapshot_revision(), revision);
        let high_density = renderer
            .prepare_page_frame(
                page(2, 40),
                PageFrameTargetPolicy::Development { scale: 2.0 },
            )
            .unwrap();
        assert_eq!(
            high_density.target(),
            RenderTargetSize {
                width: 4,
                height: 2
            }
        );
        assert_eq!(
            (
                high_density.snapshot().unwrap().width,
                high_density.snapshot().unwrap().height
            ),
            (4, 2)
        );
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_readback_failure_and_drop_keep_image_font_canvas_and_pixel_owners() {
        let mut renderer = SkiaRenderer::new();
        let image = resource(30);
        renderer.commit(resource_page(1, &image)).unwrap();
        let _ = renderer.canvas.native_fonts.for_character('Z', 16.0);
        let font_owner = &renderer.canvas.native_fonts as *const NativeFonts;
        let cached_font = renderer.canvas.native_fonts.fallback.get(&'Z').unwrap() as *const _;
        let font_id = renderer.canvas.native_fonts.fallback[&'Z']
            .as_ref()
            .map(|font| font.typeface().unique_id());
        let native_image = &renderer.native_images["image"] as *const images::NativeImage;
        let canvas_owner = &renderer.canvas as *const CanvasService;
        let old = renderer.snapshot_ref().unwrap().clone();
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        let result = renderer.prepare_page_frame_with_readback(
            resource_page(2, &resource(90)),
            PageFrameTargetPolicy::Development { scale: 2.0 },
            |surface, id, width, height| {
                native_raster::readback_native_with_allocator(surface, id, width, height, |_| {
                    Err(RenderError::PixelBufferAllocationFailed)
                })
            },
        );
        assert!(matches!(
            &result,
            Err(RenderError::PixelBufferAllocationFailed)
        ));
        drop(result);
        drop(
            renderer
                .prepare_page_frame(
                    resource_page(3, &resource(100)),
                    PageFrameTargetPolicy::Legacy,
                )
                .unwrap(),
        );
        assert_eq!(renderer.snapshot_ref(), Some(&old));
        assert_eq!(renderer.last_frame().unwrap().frame_id, 1);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.accepted_render_target(), target);
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(&renderer.native_images["image"] as *const _, native_image);
        assert_eq!(&renderer.canvas as *const _, canvas_owner);
        assert_eq!(&renderer.canvas.native_fonts as *const _, font_owner);
        assert_eq!(
            renderer.canvas.native_fonts.fallback.get(&'Z').unwrap() as *const _,
            cached_font
        );
        assert_eq!(
            renderer.canvas.native_fonts.fallback[&'Z']
                .as_ref()
                .map(|font| font.typeface().unique_id()),
            font_id
        );
    }

    #[cfg(feature = "skia-backend")]
    fn assert_gpu_or_export_prepares_without_raster(mode: PageRenderMode) {
        let mut renderer = SkiaRenderer::new_with_validated_page_render_mode(
            ValidatedPageRenderMode::new(mode).unwrap(),
        );
        let candidate = renderer
            .prepare_page_frame_with_readback(
                resource_page(1, &resource(20)),
                PageFrameTargetPolicy::Development { scale: 2.0 },
                |_, _, _, _| panic!("GPU/export preparation must not read back CPU page pixels"),
            )
            .unwrap();
        assert!(candidate.surface.is_none());
        assert!(candidate.snapshot().is_none());
        assert!(candidate.renderer.canvas.native_fonts.fallback.is_empty());
        assert!(!candidate.renderer.has_gpu_surface());
        let accepted = candidate.accept();
        assert!(renderer.snapshot_ref().is_none());
        assert!(!renderer.has_native_surface());
        assert!(!renderer.has_gpu_surface());
        drop(accepted);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_export_prepare_never_enters_page_raster_readback() {
        assert_gpu_or_export_prepares_without_raster(PageRenderMode::ExternalFrame);
    }

    #[cfg(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    ))]
    #[test]
    fn native_gpu_prepare_never_enters_page_raster_readback() {
        assert_gpu_or_export_prepares_without_raster(PageRenderMode::NativeGpu);
    }
}
