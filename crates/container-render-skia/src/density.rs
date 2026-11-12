//! Density-only retained-picture preparation. This never evaluates View or
//! replaces independent Canvas/font/context ownership.
use super::*;

/// An exclusive candidate for the exact currently accepted renderer picture.
/// Dropping it discards only candidate resources. Acceptance is infallible and
/// cannot target a different renderer or restore an earlier publication.
pub struct PreparedDensityRepaint<'a> {
    renderer: &'a mut SkiaRenderer,
    scale: f64,
    target: RenderTargetSize,
    revision: u64,
    changed: bool,
    #[cfg(feature = "skia-backend")]
    target_changed: bool,
    render_ms: f64,
    #[cfg(feature = "skia-backend")]
    native: Option<(skia::Surface, RenderSnapshot)>,
    #[cfg(not(feature = "skia-backend"))]
    software_snapshot: Option<RenderSnapshot>,
}

/// Former page pixels remain owned until the joint publisher releases its
/// external store lock. Independent Canvas, fonts and GPU contexts stay put.
#[must_use = "retain until outside the joint publication critical section"]
pub struct AcceptedDensityRepaint {
    revision: u64,
    #[cfg(not(feature = "skia-backend"))]
    _software_snapshot: Option<RenderSnapshot>,
    #[cfg(feature = "skia-backend")]
    _surface: Option<skia::Surface>,
    #[cfg(feature = "skia-backend")]
    _snapshot: Option<RenderSnapshot>,
}

impl AcceptedDensityRepaint {
    pub fn render_revision(&self) -> u64 {
        self.revision
    }
}

impl PreparedDensityRepaint<'_> {
    pub fn frame(&self) -> &RenderFrame {
        self.renderer
            .software_fallback
            .last_frame
            .as_ref()
            .expect("density preparation requires an accepted frame")
    }

    pub fn target(&self) -> RenderTargetSize {
        self.target
    }
    pub fn render_revision(&self) -> u64 {
        self.revision
    }
    pub fn render_scale(&self) -> f64 {
        self.scale
    }
    pub fn density_changed(&self) -> bool {
        self.changed
    }
    pub fn render_ms(&self) -> f64 {
        self.render_ms
    }
    pub fn page_render_mode(&self) -> PageRenderMode {
        self.renderer.page_render_mode
    }

    /// Pixels are exposed only after real raster preparation/readback. GPU and
    /// external-frame modes never manufacture a software diagnostic here.
    pub fn snapshot(&self) -> Option<&RenderSnapshot> {
        if self.renderer.page_render_mode != PageRenderMode::Raster {
            return None;
        }
        #[cfg(feature = "skia-backend")]
        if let Some((_, snapshot)) = &self.native {
            return Some(snapshot);
        }
        #[cfg(not(feature = "skia-backend"))]
        if let Some(snapshot) = &self.software_snapshot {
            return Some(snapshot);
        }
        self.renderer.snapshot_ref()
    }

    /// Move prepared page fields only. No validation, allocation, painting,
    /// callbacks, engine access or fallible publication occurs in this step.
    pub fn accept(self) -> u64 {
        let accepted = self.accept_with_retirement();
        let revision = accepted.render_revision();
        drop(accepted);
        revision
    }

    /// Only field moves and scalar invalidation occur here. The returned
    /// receipt owns replaced pixels/surfaces until the caller can release them.
    pub fn accept_with_retirement(self) -> AcceptedDensityRepaint {
        let renderer = self.renderer;
        #[cfg(not(feature = "skia-backend"))]
        let mut retired_software_snapshot = None;
        #[cfg(feature = "skia-backend")]
        let mut retired_surface = None;
        #[cfg(feature = "skia-backend")]
        let mut retired_snapshot = None;
        renderer.render_scale = self.scale;
        renderer.accepted_render_scale = Some(self.scale);
        if self.changed {
            #[cfg(not(feature = "skia-backend"))]
            if self.software_snapshot.is_some() {
                retired_software_snapshot = std::mem::replace(
                    &mut renderer.software_fallback.last_snapshot,
                    self.software_snapshot,
                );
            }
            #[cfg(feature = "skia-backend")]
            {
                if self.target_changed {
                    if let Some((surface, snapshot)) = self.native {
                        retired_surface = renderer.native_surface.replace(surface);
                        retired_snapshot = renderer.native_snapshot.replace(snapshot);
                    } else {
                        // A diagnostic readback belongs to its previous target.
                        retired_snapshot = renderer.native_snapshot.take();
                    }
                }
                renderer.invalidate_gpu_presentation();
            }
            renderer.accepted_render_target = Some(self.target);
            renderer.software_fallback.snapshot_revision = self.revision;
            renderer.last_render_ms = self.render_ms;
        }
        AcceptedDensityRepaint {
            revision: self.revision,
            #[cfg(not(feature = "skia-backend"))]
            _software_snapshot: retired_software_snapshot,
            #[cfg(feature = "skia-backend")]
            _surface: retired_surface,
            #[cfg(feature = "skia-backend")]
            _snapshot: retired_snapshot,
        }
    }
}

impl SkiaRenderer {
    /// Prepare the actual density picture while keeping accepted page state
    /// unchanged. Font lookup caches may grow; they are independent resources
    /// and are deliberately never rolled back when a candidate is dropped.
    pub fn prepare_density_repaint(
        &mut self,
        scale: f64,
    ) -> Result<PreparedDensityRepaint<'_>, RenderError> {
        #[cfg(feature = "skia-backend")]
        {
            self.prepare_density_repaint_with_readback(scale, native_raster::readback_native)
        }
        #[cfg(not(feature = "skia-backend"))]
        {
            self.prepare_density_repaint_impl(scale)
        }
    }

    #[cfg(not(feature = "skia-backend"))]
    fn prepare_density_repaint_impl(
        &mut self,
        scale: f64,
    ) -> Result<PreparedDensityRepaint<'_>, RenderError> {
        let started = Instant::now();
        let frame = self
            .software_fallback
            .last_frame
            .as_ref()
            .ok_or(RenderError::Unsupported("density-without-accepted-frame"))?;
        let target = self.validate_render_target(frame.viewport, scale)?;
        // The target can fit the single-frame budget while nested opacity
        // layers exceed their aggregate budget. Export/GPU preparation must
        // preserve the same physical-target validation as ordinary commit.
        let (_, bytes) = rgba_buffer_layout(target.width, target.height)?;
        compositing::layer_depth(&frame.root, bytes)?;
        let target_changed = self.accepted_render_target != Some(target);
        let changed = target_changed || self.accepted_render_scale != Some(scale);
        let revision = self.density_revision(changed)?;
        let software_snapshot = if target_changed && self.page_render_mode == PageRenderMode::Raster
        {
            Some(SoftwareRenderer::rasterize_at_size(
                frame,
                target.width,
                target.height,
            )?)
        } else {
            None
        };
        let render_ms = if target_changed {
            started.elapsed().as_secs_f64() * 1000.0
        } else {
            self.last_render_ms
        };
        Ok(PreparedDensityRepaint {
            renderer: self,
            scale,
            target,
            revision,
            changed,
            render_ms,
            software_snapshot,
        })
    }

    #[cfg(feature = "skia-backend")]
    fn prepare_density_repaint_with_readback(
        &mut self,
        scale: f64,
        readback: impl FnOnce(&mut skia::Surface, u64, u32, u32) -> Result<RenderSnapshot, RenderError>,
    ) -> Result<PreparedDensityRepaint<'_>, RenderError> {
        let frame = self
            .software_fallback
            .last_frame
            .as_ref()
            .ok_or(RenderError::Unsupported("density-without-accepted-frame"))?;
        let target = self.validate_render_target(frame.viewport, scale)?;
        // The target can fit the single-frame budget while nested opacity
        // layers exceed their aggregate budget. Export/GPU preparation must
        // preserve the same physical-target validation as ordinary commit.
        let (_, bytes) = rgba_buffer_layout(target.width, target.height)?;
        compositing::layer_depth(&frame.root, bytes)?;
        let target_changed = self.accepted_render_target != Some(target);
        let changed = target_changed || self.accepted_render_scale != Some(scale);
        let revision = self.density_revision(changed)?;
        let started = Instant::now();
        let native = if target_changed && self.page_render_mode == PageRenderMode::Raster {
            let mut surface = Self::render_native(
                frame,
                &mut self.canvas.native_fonts,
                &self.native_images,
                target,
            )?;
            let snapshot = readback(&mut surface, frame.frame_id, target.width, target.height)?;
            Some((surface, snapshot))
        } else {
            None
        };
        let render_ms = if target_changed {
            started.elapsed().as_secs_f64() * 1000.0
        } else {
            self.last_render_ms
        };
        Ok(PreparedDensityRepaint {
            renderer: self,
            scale,
            target,
            revision,
            changed,
            target_changed,
            render_ms,
            native,
        })
    }

    fn density_revision(&self, changed: bool) -> Result<u64, RenderError> {
        if changed {
            self.snapshot_revision()
                .checked_add(1)
                .ok_or(RenderError::Unsupported(
                    "density-render-revision-exhausted",
                ))
        } else {
            Ok(self.snapshot_revision())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted(external: bool) -> SkiaRenderer {
        let mut renderer = if external {
            SkiaRenderer::new_frame_export_only()
        } else {
            SkiaRenderer::new()
        };
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 2.0,
        };
        let mut root = RenderNode::new("retained", viewport);
        root.background = Some(Color {
            red: 170,
            green: 20,
            blue: 80,
            alpha: 128,
        });
        renderer
            .commit(RenderFrame {
                frame_id: 9,
                viewport,
                root,
                images: Default::default(),
            })
            .unwrap();
        renderer
    }

    #[test]
    fn dropping_external_candidate_preserves_picture_target_and_counter() {
        let mut renderer = accepted(true);
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        {
            let prepared = renderer.prepare_density_repaint(2.0).unwrap();
            assert_eq!(prepared.target().width, 4);
            assert_eq!(prepared.render_revision(), revision + 1);
            assert!(prepared.snapshot().is_none());
        }
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.accepted_render_target(), target);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.last_frame().unwrap().frame_id, 9);
        assert!(renderer.snapshot_ref().is_none());
    }

    #[test]
    fn accepting_external_density_retains_frame_without_cpu_pixels() {
        let mut renderer = accepted(true);
        let frame = renderer.last_frame().unwrap() as *const RenderFrame;
        let revision = renderer.snapshot_revision();
        assert_eq!(
            renderer.prepare_density_repaint(2.0).unwrap().accept(),
            revision + 1
        );
        assert_eq!(renderer.last_frame().unwrap() as *const RenderFrame, frame);
        assert_eq!(renderer.accepted_render_target().unwrap().width, 4);
        assert!(renderer.snapshot_ref().is_none());
    }

    fn rejects_physical_layer_budget(mode: PageRenderMode) {
        let mut renderer = SkiaRenderer::new_with_validated_page_render_mode(
            ValidatedPageRenderMode::new(mode).unwrap(),
        );
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 667.0,
        };
        let mut root = RenderNode::new("inner", viewport);
        root.opacity = 0.5;
        for index in 0..4 {
            let mut parent = RenderNode::new(format!("opacity-{index}"), viewport);
            parent.opacity = 0.5;
            parent.children.push(root);
            root = parent;
        }
        renderer
            .commit(RenderFrame {
                frame_id: 11,
                viewport,
                root,
                images: Default::default(),
            })
            .unwrap();
        let revision = renderer.snapshot_revision();
        let target = renderer.accepted_render_target();
        let frame = renderer.last_frame().unwrap() as *const RenderFrame;
        // 1500×2668 is below the single 16 MiB limit, but five nested
        // opacity layers exceed the separate 64 MiB compositing limit.
        assert!(RenderTargetSize::for_viewport(viewport, 4.0).is_ok());
        let candidate = renderer.prepare_density_repaint(4.0);
        assert!(matches!(
            &candidate,
            Err(RenderError::CompositingBudgetExceeded)
        ));
        drop(candidate);
        assert_eq!(renderer.accepted_render_target(), target);
        assert_eq!(renderer.snapshot_revision(), revision);
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.last_frame().unwrap() as *const RenderFrame, frame);
        assert!(renderer.snapshot_ref().is_none());
    }

    #[test]
    fn external_density_preserves_aggregate_layer_budget_validation() {
        rejects_physical_layer_budget(PageRenderMode::ExternalFrame);
    }

    #[cfg(any(
        feature = "skia-gpu-gles",
        all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        )
    ))]
    #[test]
    fn gpu_density_checks_aggregate_layers_without_attaching_a_gpu_surface() {
        rejects_physical_layer_budget(PageRenderMode::NativeGpu);
    }

    #[test]
    fn rounded_target_collision_accepts_a_new_numeric_density_revision() {
        let mut renderer = SkiaRenderer::new_frame_export_only();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        };
        renderer
            .commit(RenderFrame {
                frame_id: 1,
                viewport,
                root: RenderNode::new("root", viewport),
                images: Default::default(),
            })
            .unwrap();
        renderer.prepare_density_repaint(1.5).unwrap().accept();
        let revision = renderer.snapshot_revision();
        let candidate = renderer.prepare_density_repaint(2.0).unwrap();
        assert!(candidate.density_changed());
        assert_eq!(candidate.render_revision(), revision + 1);
        candidate.accept();
        assert_eq!(renderer.render_scale(), 2.0);
        assert_eq!(renderer.accepted_render_scale(), Some(2.0));
        assert_eq!(renderer.snapshot_revision(), revision + 1);
    }

    #[test]
    fn staged_density_cannot_impersonate_the_accepted_numeric_density() {
        let mut renderer = accepted(true);
        let viewport = renderer.last_frame().unwrap().viewport;
        let revision = renderer.snapshot_revision();
        renderer.configure_render_target(viewport, 0.9).unwrap();
        assert_eq!(renderer.render_scale(), 0.9);
        assert_eq!(renderer.accepted_render_scale(), Some(1.0));
        {
            let prepared = renderer.prepare_density_repaint(0.9).unwrap();
            assert!(prepared.density_changed());
            assert_eq!(
                prepared.target(),
                RenderTargetSize {
                    width: 2,
                    height: 2
                }
            );
            assert_eq!(prepared.render_revision(), revision + 1);
        }
        assert_eq!(renderer.accepted_render_scale(), Some(1.0));
        assert_eq!(renderer.snapshot_revision(), revision);
        let accepted = renderer
            .prepare_density_repaint(0.9)
            .unwrap()
            .accept_with_retirement();
        assert_eq!(accepted.render_revision(), revision + 1);
        assert_eq!(renderer.accepted_render_scale(), Some(0.9));
    }

    #[test]
    fn unchanged_accepted_density_survives_staging_and_exhausted_revision() {
        let mut renderer = accepted(true);
        let viewport = renderer.last_frame().unwrap().viewport;
        renderer.configure_render_target(viewport, 2.0).unwrap();
        renderer.software_fallback.snapshot_revision = u64::MAX;
        let prepared = renderer.prepare_density_repaint(1.0).unwrap();
        assert!(!prepared.density_changed());
        assert_eq!(prepared.render_revision(), u64::MAX);
        drop(prepared.accept_with_retirement());
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.accepted_render_scale(), Some(1.0));
        assert_eq!(renderer.snapshot_revision(), u64::MAX);
    }

    #[test]
    fn density_preparation_and_drop_keep_independent_canvas_drawing() {
        let mut renderer = accepted(true);
        renderer
            .canvas
            .commit(CanvasFrame {
                frame_id: 51,
                canvas_id: "independent".into(),
                width: 1,
                height: 1,
                reserve: false,
                commands: vec![
                    CanvasCommand {
                        op: "setFillStyle".into(),
                        args: vec![Value::String("#ff0000".into())],
                    },
                    CanvasCommand {
                        op: "fillRect".into(),
                        args: vec![0.into(), 0.into(), 1.into(), 1.into()],
                    },
                ],
            })
            .unwrap();
        let canvas = renderer.canvas.snapshot("independent").unwrap();
        {
            let _prepared = renderer.prepare_density_repaint(2.0).unwrap();
        }
        assert_eq!(
            renderer.canvas.snapshot("independent"),
            Some(canvas.clone())
        );
        renderer.prepare_density_repaint(2.0).unwrap().accept();
        assert_eq!(renderer.canvas.snapshot("independent"), Some(canvas));
    }

    #[test]
    fn exhausted_revision_rejects_before_target_or_configuration_mutation() {
        let mut renderer = accepted(true);
        renderer.software_fallback.snapshot_revision = u64::MAX;
        assert!(renderer.prepare_density_repaint(2.0).is_err());
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.accepted_render_target().unwrap().width, 2);
        assert_eq!(renderer.snapshot_revision(), u64::MAX);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_readback_allocation_failure_keeps_real_old_pixels() {
        let mut renderer = accepted(false);
        let old = renderer.snapshot_ref().unwrap().clone();
        let revision = renderer.snapshot_revision();
        let result =
            renderer.prepare_density_repaint_with_readback(2.0, |surface, id, width, height| {
                native_raster::readback_native_with_allocator(surface, id, width, height, |_| {
                    Err(RenderError::PixelBufferAllocationFailed)
                })
            });
        assert!(matches!(
            &result,
            Err(RenderError::PixelBufferAllocationFailed)
        ));
        drop(result);
        assert_eq!(renderer.snapshot_ref(), Some(&old));
        assert_eq!(renderer.render_scale(), 1.0);
        assert_eq!(renderer.accepted_render_target().unwrap().width, 2);
        assert_eq!(renderer.snapshot_revision(), revision);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn native_pixels_exist_before_accept_and_drop_retains_original_picture() {
        let mut renderer = accepted(false);
        let old = renderer.snapshot_ref().unwrap().clone();
        {
            let candidate = renderer.prepare_density_repaint(2.0).unwrap();
            let next = candidate.snapshot().unwrap();
            assert_eq!((next.width, next.height), (4, 4));
            assert_eq!(next.pixels.len(), 64);
            assert!(next
                .pixels
                .as_chunks::<4>()
                .0
                .iter()
                .any(|pixel| pixel[3] > 0));
        }
        assert_eq!(renderer.snapshot_ref(), Some(&old));
        let next = renderer.prepare_density_repaint(2.0).unwrap();
        let expected = next.snapshot().unwrap().clone();
        next.accept();
        assert_eq!(renderer.snapshot_ref(), Some(&expected));
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn density_receipt_retains_replaced_native_pixels_and_surface_until_release() {
        let mut renderer = accepted(false);
        let old_pixels = renderer.native_snapshot.as_ref().unwrap().pixels.as_ptr();
        let canvas = &renderer.canvas as *const CanvasService;
        let fonts = &renderer.canvas.native_fonts as *const NativeFonts;
        let images = &renderer.native_images as *const BTreeMap<String, images::NativeImage>;
        let candidate = renderer.prepare_density_repaint(2.0).unwrap();
        let next_pixels = candidate.snapshot().unwrap().pixels.as_ptr();
        let receipt = candidate.accept_with_retirement();
        assert!(receipt._surface.is_some());
        assert_eq!(
            receipt._snapshot.as_ref().unwrap().pixels.as_ptr(),
            old_pixels
        );
        assert_eq!(
            renderer.native_snapshot.as_ref().unwrap().pixels.as_ptr(),
            next_pixels
        );
        assert_eq!(&renderer.canvas as *const _, canvas);
        assert_eq!(&renderer.canvas.native_fonts as *const _, fonts);
        assert_eq!(&renderer.native_images as *const _, images);
        drop(receipt);
    }

    #[cfg(feature = "skia-backend")]
    #[test]
    fn same_target_numeric_density_reuses_real_pixels_but_advances_revision() {
        let mut renderer = accepted(false);
        let pixels = renderer.native_snapshot.as_ref().unwrap().pixels.as_ptr();
        let revision = renderer.snapshot_revision();
        let prepared = renderer
            .prepare_density_repaint_with_readback(0.9, |_, _, _, _| {
                panic!("same physical target must retain its real accepted pixels")
            })
            .unwrap();
        assert_eq!(prepared.snapshot().unwrap().pixels.as_ptr(), pixels);
        assert_eq!(prepared.render_revision(), revision + 1);
        let receipt = prepared.accept_with_retirement();
        assert!(receipt._surface.is_none());
        assert!(receipt._snapshot.is_none());
        assert_eq!(
            renderer.native_snapshot.as_ref().unwrap().pixels.as_ptr(),
            pixels
        );
        assert_eq!(renderer.accepted_render_scale(), Some(0.9));
        drop(receipt);
    }
}
