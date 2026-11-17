//! Session publication boundary for retained numeric animation samples.
//! Sampling reuses accepted input and its declaration scene. It never enters
//! View, WXS, component rendering or ready hooks, and cannot refresh provenance.

use super::*;
use animation_protocol::ConsumedSample;

fn stale(message: &str) -> BridgeError {
    BridgeError::new(BridgeErrorCode::Cancelled, message)
}

impl Session {
    pub(super) fn validate_prepared_animations(
        &self,
        prepared: &PreparedAnimations,
    ) -> Result<(), BridgeError> {
        self.animation_writes.ensure_valid()?;
        if let Some(bindings) = &prepared.bindings {
            self.animation_bindings.validate(bindings)?;
        }
        self.animation_playback.validate(&prepared.playback)
    }

    /// Call immediately after joint publication validation. No guest callback,
    /// allocation of a revision, or fallible work occurs between the two owners.
    pub(super) fn accept_prepared_animations(&mut self, prepared: PreparedAnimations) {
        debug_assert!(self.validate_prepared_animations(&prepared).is_ok());
        if let Some(bindings) = prepared.bindings {
            self.animation_bindings.accept(bindings);
        }
        self.animation_playback
            .accept(prepared.playback, self.animation_clock.now());
    }

    /// Absent until this Session has accepted its first discovered animation
    /// binding. Reading state never samples a run or borrows a browser clock.
    pub fn animation_sample_demand_revision(&self) -> Option<u64> {
        self.animation_playback.sample_demand_revision()
    }

    /// The backend has already accepted this exact renderer revision. Its
    /// sample proof is immutable scheduling evidence before presentation; the
    /// actual playback owner remains unchanged until the real surface ACK.
    pub(super) fn stage_native_animations(
        &mut self,
        revision: u64,
        prepared: Option<PreparedAnimations>,
    ) {
        debug_assert_eq!(revision, self.skia_backend.renderer.snapshot_revision());
        self.native_animation_attempt = None;
        self.committed_animation_sample = prepared
            .as_ref()
            .and_then(|prepared| prepared.playback.consumed_sample)
            .map(|sample| (revision, sample));
        self.pending_native_animations = prepared.map(|prepared| (revision, prepared));
    }

    /// Called before input/observer publication by the exact native ACK path.
    /// A route/lifecycle fence or an overwritten renderer candidate cannot
    /// acquire authority by presenting an older numeric picture later.
    pub(super) fn finish_native_animation_presentation(
        &mut self,
        revision: u64,
    ) -> Result<(), BridgeError> {
        if self.pending_native_animations.is_none() {
            // Manual frames and manifest renders with explicit data replace
            // the visible topology without a trusted page-input snapshot.
            // Retire the old nodes only when that exact replacement actually
            // presents; failed or superseded candidates keep the old runs.
            // Ordinary retained repaints carry their exact input proof and
            // therefore do not enter this retirement path.
            if revision == self.skia_backend.renderer.snapshot_revision()
                && self.current_skia_frame_authority().is_some()
                && self
                    .committed_frame_input
                    .as_ref()
                    .is_none_or(|input| input.revision != revision)
            {
                if let Some(page) = self.app_service.pages().current().map(|page| page.id) {
                    if self.observer_frame_page == Some(page) {
                        self.animation_bindings.retire_page_topology(page.0);
                        self.animation_playback.retire_page_topology(page.0);
                    }
                }
            }
            return Ok(());
        }
        self.ensure_engine_execution_healthy()?;
        self.ensure_view_execution_healthy()?;
        let (captured_revision, prepared) = self
            .pending_native_animations
            .as_ref()
            .expect("pending native candidate checked");
        if revision != *captured_revision
            || revision != self.skia_backend.renderer.snapshot_revision()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || self.browser_route_active()
            || self.navigation_blocks_presentation()
            || self.current_skia_frame_authority().is_none()
            || self.app_service.pages().current().map(|page| page.id)
                != Some(PageId(prepared.playback.page))
            || self.observer_frame_page != Some(PageId(prepared.playback.page))
        {
            return Err(stale(
                "animation presentation belongs to a retired native frame",
            ));
        }
        self.validate_prepared_animations(prepared)?;
        let (_, prepared) = self
            .pending_native_animations
            .take()
            .expect("validated native animation candidate");
        self.accept_prepared_animations(prepared);
        Ok(())
    }

    /// Trusted poll entry. New demand may coalesce while an older sample waits
    /// for presentation; preparing another native frame waits for that exact
    /// ACK. Browser polling only requests demand and leaves publication to DOM.
    pub(super) fn poll_animation_samples(&mut self) -> Result<(), BridgeError> {
        if !self.initialized
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.navigation_blocks_presentation()
        {
            return Ok(());
        }
        self.animation_writes.ensure_valid()?;
        let Some(page) = self.app_service.pages().current().map(|page| page.id) else {
            return Ok(());
        };
        let now = self.animation_clock.now();
        if self.browser_route_active() {
            if self.animation_browser_sample_input_is_current() {
                self.animation_playback.request_sample(page.0, now)?;
            }
            return Ok(());
        }
        let previous_revision = self.skia_backend.renderer.snapshot_revision();
        let Some(input) = self
            .last_frame_input(previous_revision)
            .cloned()
            .filter(|input| {
                input.page_id == page && input.template_revision == self.view.template_revision
            })
        else {
            return Ok(());
        };
        let Some(authority) = self.current_skia_frame_authority().cloned() else {
            return Ok(());
        };
        if !self.accepted_skia_scene || self.retained_animation_scene.is_none() {
            return Ok(());
        }
        self.animation_playback.request_sample(page.0, now)?;
        // A newer template is always admitted by the ordinary render path,
        // which can replace pending sample work. This lane never blocks it.
        if self.pending_presentation.is_some()
            || self.pending_native_animations.is_some()
            || !self.observer_frame_valid
            || !self.is_current_frame_presented()
        {
            return Ok(());
        }
        let Some(demand) = self.animation_playback.sample_demand_revision() else {
            return Ok(());
        };
        if self
            .committed_animation_sample
            .is_some_and(|(revision, sample)| {
                revision == previous_revision && sample.demand_revision >= demand
            })
        {
            return Ok(());
        }
        if self.native_animation_attempt == Some((previous_revision, demand)) {
            return Ok(());
        }
        // Failed preparation consumes no playback or presentation authority,
        // but the same failed demand must not hot-loop on unrelated polls.
        self.native_animation_attempt = Some((previous_revision, demand));
        let next_revision = previous_revision.checked_add(1).ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "animation renderer revision exhausted",
            )
        })?;
        let playback = self
            .animation_playback
            .prepare_sample(page.0, now, input.viewport)?;
        let mut prepared = self.skia_backend.prepare_animation_sample(
            &self.manifest,
            self.retained_animation_scene
                .as_ref()
                .expect("retained animation scene checked"),
            playback,
        )?;
        let mut scrolling = self.scrolling.clone();
        scrolling.reconcile(Some(page), prepared.frame_mut(), true)?;
        // Retained WXML declarations keep their Canvas identities. This private
        // receiver snapshot does not evaluate View or refresh component proof.
        let canvas_bindings = self.prepare_owned_canvas_bindings(prepared.frame(), true)?;
        self.validate_prepared_animations(
            prepared
                .animations()
                .expect("sample backend supplies playback"),
        )?;
        // No fallible validation or application callback follows renderer
        // acceptance before all Session-owned provenance is published.
        let AcceptedSkiaFrame {
            frame_id,
            manifest,
            retired_page,
        } = self
            .skia_backend
            .accept_with_canvas_bindings(prepared, canvas_bindings.keys.clone())?;
        debug_assert_eq!(
            next_revision,
            self.skia_backend.renderer.snapshot_revision()
        );
        self.accept_owned_canvas_bindings(canvas_bindings);
        let AcceptedManifestFrame {
            document,
            resources,
            animations,
            retained_animation_scene,
            ..
        } = manifest.expect("sample backend supplies an accepted manifest");
        self.record_last_frame_input(Some(input));
        self.carry_consumed_component_inputs(previous_revision, next_revision);
        self.carry_retained_skia_frame_authority(Some(authority));
        self.scrolling = scrolling;
        self.accepted_view_document = Some(document);
        self.render_blobs = resources;
        self.render_resources_verified = true;
        self.retained_animation_scene = retained_animation_scene;
        self.stage_native_animations(next_revision, animations);
        self.view.last_frame_id = Some(frame_id);
        self.observer_frame_page = Some(page);
        self.suspend_dev_raster_presentation();
        if self.skia_backend.renderer.page_render_mode() != PageRenderMode::Raster
            || self.dev_raster_presentation_required()
        {
            self.observer_frame_valid = false;
            self.presented_revision = None;
            self.pending_presentation = Some((Some(page), frame_id, false));
        } else {
            // Raster publication is already visible. Its prepared owner was
            // validated above, so accepting here has no post-commit error path.
            let (_, animations) = self
                .pending_native_animations
                .take()
                .expect("staged sample playback");
            self.accept_prepared_animations(animations);
            self.observer_frame_valid = true;
            self.presented_revision = Some(next_revision);
            self.observer_observation_pending = true;
        }
        drop(retired_page);
        Ok(())
    }

    pub(super) fn committed_animation_sample(&self, revision: u64) -> Option<ConsumedSample> {
        self.committed_animation_sample
            .filter(|(captured, _)| *captured == revision)
            .map(|(_, sample)| sample)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::animation_bindings::{NodeKey, OwnerKey, PreparedDescriptor};
    use crate::animation_protocol::BaselineObservation;
    use std::time::Duration;

    fn fixture() -> Session {
        let mut manifest = ContainerManifestV1::default();
        manifest.compiler.name = "weapp-vite".into();
        manifest.compiler.commit = "native-animation-publication".into();
        manifest.compiler.platform = "weapp".into();
        manifest.app.app_json = "app.json".into();
        manifest.app.entry_module = "app.js".into();
        manifest.refresh_integrity().unwrap();
        let mut session = Session::new(
            manifest,
            SessionConfig {
                page_render_mode: PageRenderMode::ExternalFrame,
                host: HostMetadata {
                    window_width: 20,
                    window_height: 10,
                    ..Default::default()
                },
                ..Default::default()
            },
        )
        .unwrap();
        session.animation_clock.advance_to(Duration::ZERO).unwrap();
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Launch)
            .unwrap();
        let page = session.app_service.push_page("pages/home/index").unwrap();
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 20.0,
            height: 10.0,
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
        session.initialized = true;
        session.observer_frame_page = Some(page);
        session.record_last_frame_input(Some(BrowserPageInput {
            page_id: page,
            route_path: "pages/home/index".into(),
            template_revision: session.view.template_revision,
            viewport,
        }));
        session.install_skia_frame_authority();
        session
    }

    fn prepared(session: &Session) -> PreparedAnimations {
        let input = session.last_frame_input(1).unwrap();
        let descriptor = PreparedDescriptor {
            occurrence: "node".into(),
            key: NodeKey {
                owner: OwnerKey {
                    page_id: input.page_id.0,
                    page_incarnation: 1,
                    scope_id: None,
                    scope_incarnation: None,
                },
                source_site: "site".into(),
                incarnation: 1,
            },
            resolved_paths: Vec::new(),
            new_run: true,
            payload: json!({"actions":[{"animates":[{"type":"opacity","args":[1]}],"option":{
                "duration":100,"delay":0,"timingFunction":"linear","transformOrigin":"center"
            }}]}),
        };
        let mut playback = session
            .animation_playback
            .prepare_bindings(
                input.page_id.0,
                &[descriptor],
                Duration::ZERO,
                input.viewport,
            )
            .unwrap();
        playback
            .bind_baselines(&[BaselineObservation {
                occurrence_id: "node".into(),
                opacity: Some(0.2),
                transform: None,
                origin: None,
                font_size: 16.0,
            }])
            .unwrap();
        PreparedAnimations {
            bindings: None,
            playback,
        }
    }

    #[test]
    fn staging_exposes_exact_proof_but_only_the_real_ack_starts_playback() {
        let mut session = fixture();
        let candidate = prepared(&session);
        session.validate_prepared_animations(&candidate).unwrap();
        session.stage_native_animations(1, Some(candidate));
        assert_eq!(session.animation_sample_demand_revision(), None);
        assert_eq!(
            session.committed_animation_sample(1),
            Some(ConsumedSample {
                demand_revision: 0,
                sample_revision: 1
            })
        );
        assert_eq!(session.committed_animation_sample(2), None);
        session
            .animation_clock
            .advance_to(Duration::from_millis(100))
            .unwrap();
        session.finish_native_animation_presentation(1).unwrap();
        assert_eq!(session.animation_sample_demand_revision(), Some(0));
        let sample = session
            .animation_playback
            .prepare_sample(
                session.observer_frame_page.unwrap().0,
                Duration::from_millis(150),
                session.last_frame_input(1).unwrap().viewport,
            )
            .unwrap();
        assert!((sample.styles[0].opacity.unwrap() - 0.6).abs() < 1.0e-5);
        session.finish_native_animation_presentation(1).unwrap();
        assert!(session.pending_native_animations.is_none());
    }

    #[test]
    fn stale_revision_and_playback_lifetime_cannot_accept_a_staged_native_candidate() {
        let mut session = fixture();
        let candidate = prepared(&session);
        session.stage_native_animations(1, Some(candidate));
        assert_eq!(
            session
                .finish_native_animation_presentation(2)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(session.animation_sample_demand_revision(), None);
        let page = session.observer_frame_page.unwrap().0;
        session.animation_playback.retire_page(page);
        assert!(session.finish_native_animation_presentation(1).is_err());
        assert_eq!(session.animation_sample_demand_revision(), None);
    }

    #[test]
    fn inactive_page_cannot_start_playback_from_an_old_native_ack() {
        let mut session = fixture();
        let candidate = prepared(&session);
        session.stage_native_animations(1, Some(candidate));
        session
            .app_service
            .dispatch_lifecycle(LifecycleEvent::Hide)
            .unwrap();
        assert_eq!(
            session
                .finish_native_animation_presentation(1)
                .unwrap_err()
                .code,
            BridgeErrorCode::Cancelled
        );
        assert_eq!(session.animation_sample_demand_revision(), None);
    }

    #[test]
    fn poisoned_private_write_transport_blocks_validation_and_polling_before_any_publication() {
        let mut session = fixture();
        let candidate = prepared(&session);
        session.animation_writes.poison();
        assert!(session.validate_prepared_animations(&candidate).is_err());
        assert!(session.poll_animation_samples().is_err());
        assert_eq!(session.skia_backend.renderer.snapshot_revision(), 1);
        assert_eq!(session.animation_sample_demand_revision(), None);
    }

    #[test]
    fn density_repaint_carries_pending_publication_for_animation_and_legacy_candidates() {
        for animated in [true, false] {
            let mut session = fixture();
            let candidate = if animated {
                prepared(&session)
            } else {
                let input = session.last_frame_input(1).unwrap();
                PreparedAnimations {
                    bindings: None,
                    playback: session
                        .animation_playback
                        .prepare_bindings(input.page_id.0, &[], Duration::ZERO, input.viewport)
                        .unwrap(),
                }
            };
            session.stage_native_animations(1, Some(candidate));
            let proof = session.committed_animation_sample(1);
            session.set_render_scale(1.5).unwrap();
            let revision = session.render_revision();
            assert_eq!(revision, 2);
            assert_eq!(
                session.pending_native_animations.as_ref().unwrap().0,
                revision
            );
            assert_eq!(session.committed_animation_sample(revision), proof);
            session
                .finish_native_animation_presentation(revision)
                .unwrap();
            assert!(session.pending_native_animations.is_none());
            assert_eq!(
                session.animation_sample_demand_revision(),
                animated.then_some(0)
            );
        }
    }
}
