//! Density-only page transaction. Application logic and page geometry do not
//! participate, so dropping preparation needs no compensating engine calls.
use super::*;
use container_render_skia::{AcceptedDensityRepaint, PreparedDensityRepaint, RenderError};

/// Borrows the Session until accepted or dropped. Carries the exact consumed
/// input and previously valid layout authority, without acknowledging a
/// browser presentation or certifying an unproven retained picture.
pub struct PreparedDevDensity<'a> {
    picture: PreparedDensityRepaint<'a>,
    input_slot: &'a mut Option<frame_input::CommittedFrameInput>,
    next_input: Option<frame_input::CommittedFrameInput>,
    authority_slot: &'a mut Option<SkiaFrameAuthority>,
    next_authority: Option<SkiaFrameAuthority>,
    presentation: &'a mut dev_raster_presentation::DevRasterPresentationState,
    publication_context: Option<dev_raster_presentation::DevRasterPublicationContext>,
    prepared_presentation: Option<dev_raster_presentation::PreparedRasterLease>,
}

/// Retains all replaced page/ticket/input allocations through external store
/// publication. Dropping this after Web unlock releases only former resources.
#[must_use = "retain until outside the joint publication critical section"]
pub struct AcceptedDevDensity {
    picture: AcceptedDensityRepaint,
    _input: Option<frame_input::CommittedFrameInput>,
    _authority: Option<SkiaFrameAuthority>,
    _presentation: Option<AcceptedDevRasterPresentation>,
    _context: Option<dev_raster_presentation::DevRasterPublicationContext>,
}

impl AcceptedDevDensity {
    pub fn render_revision(&self) -> u64 {
        self.picture.render_revision()
    }
}

impl PreparedDevDensity<'_> {
    pub fn picture(&self) -> &PreparedDensityRepaint<'_> {
        &self.picture
    }

    /// Validate and allocate the exact candidate's ticket before any accepted
    /// fields move. This never arms an unaccepted renderer candidate. The
    /// external owner must still bind config/preview generations to its lease.
    pub fn prepare_raster_presentation(
        &mut self,
        target: DevRasterPresentationTarget,
    ) -> Result<&DevRasterPresentationTicket, BridgeError> {
        if !self.presentation.is_explicit() {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "exact developer Raster presentation is not enabled",
            ));
        }
        let context = self.publication_context.as_ref().ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Cancelled,
                "prepared density has no current Raster publication authority",
            )
        })?;
        let prepared = context.prepare_density_ticket(self.presentation, &self.picture, target)?;
        self.prepared_presentation = Some(prepared);
        Ok(self.presentation_ticket().expect("prepared above"))
    }

    pub fn presentation_ticket(&self) -> Option<&DevRasterPresentationTicket> {
        self.prepared_presentation
            .as_ref()
            .map(|prepared| prepared.ticket())
    }

    /// Compatibility helper for callers without a joint external publication.
    /// It releases former resources immediately; joint publishers must use
    /// `accept_with_retirement` and retain its receipt until after unlocking.
    pub fn accept(self) -> u64 {
        let accepted = self.accept_with_retirement();
        let revision = accepted.render_revision();
        drop(accepted);
        revision
    }

    /// Infallible field moves only. No View, ready/resize hook, callback,
    /// allocation, renderer replacement, old-resource drop or engine access.
    pub fn accept_with_retirement(self) -> AcceptedDevDensity {
        let changed = self.picture.density_changed();
        let picture = self.picture.accept_with_retirement();
        let input = if changed {
            std::mem::replace(self.input_slot, self.next_input)
        } else {
            None
        };
        // The exclusive preparation already captured the exact valid owner.
        // A pure repaint may update its render revision but cannot mint a
        // missing authority, even when the numeric density did not change.
        let authority = std::mem::replace(self.authority_slot, self.next_authority);
        let presentation = if let Some(prepared) = self.prepared_presentation {
            Some(prepared.install(self.presentation))
        } else if changed {
            Some(self.presentation.suspend_with_retirement())
        } else {
            None
        };
        AcceptedDevDensity {
            picture,
            _input: input,
            _authority: authority,
            _presentation: presentation,
            _context: self.publication_context,
        }
    }
}

impl Session {
    /// `None` leaves a missing/stale page renderer entirely uninitialized.
    /// The ordinary owner pump must produce that page's first accepted scene.
    pub fn prepare_dev_density(
        &mut self,
        scale: f64,
    ) -> Result<Option<PreparedDevDensity<'_>>, RenderError> {
        if !self.has_current_skia_scene() {
            return Ok(None);
        }
        let publication_context = self.dev_raster_publication_context();
        let authority = self.current_skia_frame_authority().cloned();
        let input = self
            .last_frame_input(self.skia_backend.renderer.snapshot_revision())
            .cloned();
        let picture = self
            .skia_backend
            .renderer
            .ensure_mut()
            .prepare_density_repaint(scale)?;
        let next_input = if picture.density_changed() {
            input.map(|input| frame_input::CommittedFrameInput {
                revision: picture.render_revision(),
                input,
            })
        } else {
            None
        };
        let next_authority = authority.map(|mut authority| {
            authority.revision = picture.render_revision();
            authority
        });
        Ok(Some(PreparedDevDensity {
            picture,
            input_slot: &mut self.committed_frame_input,
            next_input,
            authority_slot: &mut self.skia_frame_authority,
            next_authority,
            presentation: &mut self.dev_raster_presentation,
            publication_context,
            prepared_presentation: None,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retained() -> Session {
        let mut manifest = ContainerManifestV1 {
            compiler: container_ir::CompilerInfo {
                name: "weapp-vite".into(),
                commit: "density".into(),
                platform: "weapp".into(),
            },
            app: container_ir::AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            ..Default::default()
        };
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
                host: HostMetadata {
                    window_width: 2,
                    window_height: 1,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Launch)
            .unwrap();
        let page = session.app_service.push_page("pages/home/index").unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: session.config.host.window_width as f32,
            height: session.config.host.window_height as f32,
        };
        session
            .skia_backend
            .renderer
            .ensure_mut()
            .commit(RenderFrame {
                frame_id: 7,
                viewport,
                root: RenderNode::new("root", viewport),
                images: Default::default(),
            })
            .unwrap();
        session.accepted_skia_scene = true;
        session.accepted_view_document = Some(container_ir::ViewDocument {
            version: container_ir::VIEW_DOCUMENT_VERSION.into(),
            session_id: session.config.session_id.clone(),
            page_id: page.0,
            revision: 1,
            route_path: "pages/home/index".into(),
            profile: container_ir::RendererProfile::Skia,
            nodes: vec![],
            styles: vec![],
            style_roots: vec![],
            resources: vec![],
        });
        session.record_last_frame_input(Some(BrowserPageInput {
            page_id: page,
            route_path: "pages/home/index".into(),
            template_revision: session.view.template_revision,
            viewport,
        }));
        session.install_skia_frame_authority();
        session
    }

    #[test]
    fn dropped_density_keeps_exact_input_and_accepted_revision() {
        let mut session = retained();
        let revision = session.skia_backend.renderer.snapshot_revision();
        let input = session.last_frame_input(revision).unwrap().clone();
        let view = session.view.revision;
        let authority = session.current_skia_frame_authority().unwrap().clone();
        drop(session.prepare_dev_density(2.0).unwrap().unwrap());
        assert_eq!(session.skia_backend.renderer.snapshot_revision(), revision);
        assert_eq!(
            session
                .skia_backend
                .renderer
                .peek()
                .expect("the retained fixture has an accepted renderer")
                .render_scale(),
            1.0
        );
        assert_eq!(session.last_frame_input(revision), Some(&input));
        assert_eq!(session.view.revision, view);
        let retained_authority = session.current_skia_frame_authority().unwrap();
        assert_eq!(retained_authority.revision, authority.revision);
        assert_eq!(retained_authority.input_lifetime, authority.input_lifetime);
        assert_eq!(retained_authority.viewport, authority.viewport);
    }

    #[test]
    fn accept_carries_exact_consumed_input_without_entering_view_or_ready() {
        let mut session = retained();
        let previous = session.skia_backend.renderer.snapshot_revision();
        let input = session.last_frame_input(previous).unwrap().clone();
        let view = session.view.revision;
        let lifetime = session.input_lifetime_revision;
        assert_eq!(
            session.accepted_page_observation().unwrap().target,
            RenderTargetSize {
                width: 2,
                height: 1
            }
        );
        let revision = session.prepare_dev_density(2.0).unwrap().unwrap().accept();
        assert_eq!(revision, previous + 1);
        assert_eq!(
            session.accepted_page_observation().unwrap().target,
            RenderTargetSize {
                width: 4,
                height: 2
            }
        );
        assert!(session.last_frame_input(previous).is_none());
        assert_eq!(session.last_frame_input(revision), Some(&input));
        assert_eq!(session.view.revision, view);
        assert_eq!(session.input_lifetime_revision, lifetime);
        let authority = session.current_skia_frame_authority().unwrap();
        assert_eq!(authority.revision, revision);
        assert_eq!(authority.input_lifetime, lifetime.unwrap());
        assert_eq!(authority.viewport, input.viewport);
        assert_eq!(authority.page, Some(input.page_id));
        assert!(session.skia_backend.renderer.snapshot_ref().is_none());
    }

    #[test]
    fn missing_current_scene_is_not_initialized_or_replayed() {
        let mut session = retained();
        session.accepted_skia_scene = false;
        let revision = session.skia_backend.renderer.snapshot_revision();
        assert!(session.prepare_dev_density(2.0).unwrap().is_none());
        assert_eq!(session.skia_backend.renderer.snapshot_revision(), revision);
        assert_eq!(
            session
                .skia_backend
                .renderer
                .peek()
                .expect("the stale scene keeps its existing renderer")
                .render_scale(),
            1.0
        );
    }

    #[test]
    fn acceptance_receipt_retains_the_replaced_exact_consumed_input() {
        let mut session = retained();
        let revision = session.render_revision();
        let input = session.last_frame_input(revision).unwrap().clone();
        let receipt = session
            .prepare_dev_density(2.0)
            .unwrap()
            .unwrap()
            .accept_with_retirement();
        assert_eq!(receipt._input.as_ref().unwrap().revision, revision);
        assert_eq!(receipt._input.as_ref().unwrap().input, input);
        assert_eq!(receipt._authority.as_ref().unwrap().revision, revision);
        assert_eq!(
            session.current_skia_frame_authority().unwrap().revision,
            receipt.render_revision()
        );
        assert_eq!(
            session.last_frame_input(receipt.render_revision()),
            Some(&input)
        );
        drop(receipt);
    }

    #[test]
    fn no_op_density_keeps_the_existing_input_allocation_in_place() {
        let mut session = retained();
        let input = session
            .committed_frame_input
            .as_ref()
            .unwrap()
            .input
            .route_path
            .as_ptr();
        let receipt = session
            .prepare_dev_density(1.0)
            .unwrap()
            .unwrap()
            .accept_with_retirement();
        assert!(receipt._input.is_none());
        assert!(receipt._presentation.is_none());
        assert_eq!(
            session
                .committed_frame_input
                .as_ref()
                .unwrap()
                .input
                .route_path
                .as_ptr(),
            input
        );
        drop(receipt);
    }

    #[test]
    fn density_acceptance_clears_retired_authority_including_a_numeric_no_op() {
        for scale in [1.0, 2.0] {
            let mut session = retained();
            let previous = session.skia_frame_authority.as_ref().unwrap().clone();
            session.input_lifetime_revision = Some(previous.input_lifetime + 1);
            assert!(session.current_skia_frame_authority().is_none());
            let receipt = session
                .prepare_dev_density(scale)
                .unwrap()
                .unwrap()
                .accept_with_retirement();
            assert_eq!(
                receipt._authority.as_ref().unwrap().revision,
                previous.revision
            );
            assert!(session.skia_frame_authority.is_none());
            assert!(session.current_skia_frame_authority().is_none());
            drop(receipt);
        }
    }

    #[test]
    fn rejected_density_keeps_the_original_valid_layout_authority() {
        let mut session = retained();
        let revision = session.current_skia_frame_authority().unwrap().revision;
        assert!(session.prepare_dev_density(f64::NAN).is_err());
        assert_eq!(
            session.current_skia_frame_authority().unwrap().revision,
            revision
        );
        assert_eq!(session.render_revision(), revision);
    }
}
