//! Clone-boundary scheduling facts for retained external frames.
//! These facts carry no presentation acknowledgement or input authority.
use super::*;

pub(super) struct CommittedFrameInput {
    pub(super) revision: u64,
    pub(super) input: BrowserPageInput,
}

/// Exact native half of a negotiated external-surface recovery request.
/// Worker surface generations are checked by the Worker owner, not invented
/// or interpreted by this lower-level runtime.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalFrameRecoveryExpected {
    pub session_id: String,
    pub page_id: String,
    pub route_path: String,
    pub viewport: Rect,
    pub renderer_profile: container_ir::RendererProfile,
    pub template_revision: String,
    pub render_revision: String,
    pub input_lifetime_revision: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFrameRecovery {
    version: &'static str,
    kind: &'static str,
    session_id: String,
    previous_render_revision: String,
    render_revision: String,
    previous_input_lifetime_revision: String,
    input_lifetime_revision: String,
}

fn recovery_revision(value: &str) -> Result<u64, BridgeError> {
    value
        .parse::<u64>()
        .ok()
        .filter(|parsed| parsed.to_string() == value)
        .ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::ProtocolVersion,
                "surface recovery requires canonical u64 revision strings",
            )
        })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameInputMetadata<'a> {
    version: &'static str,
    session_id: &'a str,
    render_revision: String,
    consumed_input: Option<ConsumedInput<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    consumed_sample: Option<animation_protocol::ConsumedSample>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsumedInput<'a> {
    page_id: String,
    route_path: &'a str,
    template_revision: String,
    // Match RenderFrame's direct f32 serialization. DOM's ViewViewport uses
    // f64 instead; blindly reusing that wire conversion changes dimensions.
    viewport: Rect,
}

impl Session {
    /// Start a new native input lifetime for an exact observed external frame.
    /// Republish matching retained input; dirty/unproven input requires a normal
    /// render. Neither branch enters JS, evaluates templates, lays out, paints,
    /// reads pixels, runs ready hooks or acknowledges presentation.
    pub fn recover_external_frame(
        &mut self,
        expected: &ExternalFrameRecoveryExpected,
    ) -> Result<ExternalFrameRecovery, BridgeError> {
        if self.skia_backend.renderer.page_render_mode()
            != container_render_skia::PageRenderMode::ExternalFrame
        {
            return Err(BridgeError::new(
                BridgeErrorCode::UnsupportedCapability,
                "surface recovery requires external-frame rendering",
            ));
        }
        let page_id = recovery_revision(&expected.page_id)?;
        let template_revision = recovery_revision(&expected.template_revision)?;
        let render_revision = recovery_revision(&expected.render_revision)?;
        let input_lifetime = recovery_revision(&expected.input_lifetime_revision)?;
        let stale = || {
            BridgeError::new(
                BridgeErrorCode::Cancelled,
                "surface recovery expected input no longer matches the retained current page",
            )
        };
        if expected.session_id != self.config.session_id
            || expected.route_path.len() > 4096
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.input_lifetime_revision != Some(input_lifetime)
            || self.skia_backend.renderer.snapshot_revision() != render_revision
            || self.view.template_revision != template_revision
            || expected.viewport
                != (Rect {
                    x: 0.0,
                    y: 0.0,
                    width: self.config.host.window_width as f32,
                    height: self.config.host.window_height as f32,
                })
            || self.renderer_profile_for_route(&expected.route_path) != expected.renderer_profile
            || expected.renderer_profile == container_ir::RendererProfile::WebView
            || !self
                .app_service
                .pages()
                .current()
                .is_some_and(|page| page.id.0 == page_id && page.path == expected.route_path)
        {
            return Err(stale());
        }
        // Consumed data describes template scheduling, not the accepted
        // coordinate system. Retained pixels can be republished only while
        // their independent layout authority is still current.
        let authority = self.current_skia_frame_authority().cloned();
        let retained = authority.as_ref().and_then(|_| {
            self.last_frame_input(render_revision)
                .cloned()
                .filter(|input| {
                    input.page_id.0 == page_id
                        && input.route_path == expected.route_path
                        && input.template_revision == template_revision
                        && input.viewport == expected.viewport
                })
                .zip(self.skia_backend.renderer.last_frame().cloned())
                .filter(|(_, frame)| frame.viewport == expected.viewport)
        });
        // Check both monotonic counters before any mutation: the renderer's
        // historical saturating counter must never turn recovery into a no-op.
        let next_lifetime = input_lifetime.checked_add(1).ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "surface recovery input lifetime exhausted",
            )
        })?;
        let next_publication = render_revision.checked_add(1).ok_or_else(|| {
            BridgeError::new(
                BridgeErrorCode::Render,
                "surface recovery render revision exhausted",
            )
        })?;
        let (kind, next_revision, retained_authority) = if let Some((input, frame)) = retained {
            self.skia_backend
                .renderer
                .ensure_mut()
                .commit(frame)
                .map_err(|error| BridgeError::new(BridgeErrorCode::Render, error.to_string()))?;
            debug_assert_eq!(
                self.skia_backend.renderer.snapshot_revision(),
                next_publication
            );
            self.record_last_frame_input(Some(input));
            ("retained", next_publication, authority)
        } else {
            // A dirty/unproven retained image may remain for diagnostics. It
            // supplies no input proof to the next normal template transaction.
            self.committed_frame_input = None;
            self.pending_presentation = None;
            self.observer_frame_page = None;
            ("render-required", render_revision, None)
        };
        self.input_lifetime_revision = Some(next_lifetime);
        // Recovery starts a new input lifetime. Only a valid accepted layout
        // captured before mutation may cross it; an unproven frame cannot
        // regain authority through a later presentation ACK.
        self.carry_retained_skia_frame_authority(retained_authority);
        self.presented_revision = None;
        self.observer_frame_valid = false;
        // Old contacts cannot capture new-surface input. This is pure resource
        // retirement; recovery never dispatches application callbacks.
        self.touch_contacts.clear();
        self.ended_touch_contacts.clear();
        self.scrolling.retire_touch_positions();
        Ok(ExternalFrameRecovery {
            version: "1.0",
            kind,
            session_id: self.config.session_id.clone(),
            previous_render_revision: render_revision.to_string(),
            render_revision: next_revision.to_string(),
            previous_input_lifetime_revision: input_lifetime.to_string(),
            input_lifetime_revision: next_lifetime.to_string(),
        })
    }

    /// The exact root page input consumed by a committed generated frame.
    /// Later data/ready effects never refresh this snapshot. A stale revision,
    /// retired lifetime, explicit frame/data or detached preview has no proof.
    pub fn last_frame_input(&self, revision: u64) -> Option<&BrowserPageInput> {
        if revision == 0
            || revision != self.skia_backend.renderer.snapshot_revision()
            || self.engine_execution_is_faulted()
            || self.view_execution_is_faulted()
            || self.app_service.lifecycle().state() != container_core::LifecycleState::Active
        {
            return None;
        }
        let frame = self.committed_frame_input.as_ref()?;
        (frame.revision == revision
            && self.app_service.pages().current().is_some_and(|page| {
                page.id == frame.input.page_id && page.path == frame.input.route_path
            }))
        .then_some(&frame.input)
    }

    /// Serialize scheduling facts for this exact runtime-owned render token.
    /// No subsequent state observation, ready hook or ACK can refresh proof.
    pub fn last_frame_input_json(&self, revision: u64) -> Result<Vec<u8>, BridgeError> {
        if revision == 0 || revision != self.skia_backend.renderer.snapshot_revision() {
            return Err(BridgeError::new(
                BridgeErrorCode::Cancelled,
                "consumed input requested for a stale render revision",
            ));
        }
        let metadata = FrameInputMetadata {
            version: container_ir::VIEW_PRESENTATION_VERSION,
            session_id: &self.config.session_id,
            render_revision: revision.to_string(),
            consumed_input: self.last_frame_input(revision).map(|input| ConsumedInput {
                page_id: input.page_id.0.to_string(),
                route_path: &input.route_path,
                template_revision: input.template_revision.to_string(),
                viewport: input.viewport,
            }),
            consumed_sample: self.committed_animation_sample(revision),
        };
        serde_json::to_vec(&metadata).map_err(|error| {
            BridgeError::new(
                BridgeErrorCode::Render,
                format!("frame input encoding failed: {error}"),
            )
        })
    }

    pub(super) fn record_last_frame_input(&mut self, input: Option<BrowserPageInput>) {
        // Hooks may have retired the source page while this frame was built.
        // Do not leave a hidden proof that could revive when that page returns.
        let input = input.filter(|input| {
            !self.engine_execution_is_faulted()
                && !self.view_execution_is_faulted()
                && self.app_service.lifecycle().state() == container_core::LifecycleState::Active
                && self
                    .app_service
                    .pages()
                    .current()
                    .is_some_and(|page| page.id == input.page_id && page.path == input.route_path)
        });
        let revision = self.skia_backend.renderer.snapshot_revision();
        if let Some((sample_revision, sample)) = self.committed_animation_sample {
            if sample_revision != revision {
                self.committed_animation_sample = self
                    .committed_frame_input
                    .as_ref()
                    .filter(|previous| {
                        previous.revision == sample_revision
                            && input.as_ref() == Some(&previous.input)
                    })
                    .map(|_| (revision, sample));
            }
        }
        if let Some((pending_revision, _)) = self.pending_native_animations.as_mut() {
            if *pending_revision != revision {
                if self.committed_frame_input.as_ref().is_some_and(|previous| {
                    previous.revision == *pending_revision
                        && input.as_ref() == Some(&previous.input)
                }) {
                    *pending_revision = revision;
                } else {
                    self.pending_native_animations = None;
                }
            }
        }
        self.committed_frame_input = input.map(|input| CommittedFrameInput { revision, input });
    }

    /// Repaint only accepted layout at a new physical density. Preserve the
    /// consumed snapshot under the newly committed revision; rejection leaves
    /// both its old revision and proof untouched. No View/ready hook runs here.
    pub fn set_render_scale(
        &mut self,
        scale: f64,
    ) -> Result<(), container_render_skia::RenderError> {
        let authority = self.current_skia_frame_authority().cloned();
        let input = self
            .last_frame_input(self.skia_backend.renderer.snapshot_revision())
            .cloned();
        self.skia_backend
            .renderer
            .ensure_mut()
            .set_render_scale(scale)?;
        self.record_last_frame_input(input);
        self.carry_retained_skia_frame_authority(authority);
        Ok(())
    }

    /// Repaint only a Session-owned scene of the visible Skia page. `None`
    /// means the owner must stage the target and wait for its ordinary render
    /// pump; an old-route or legacy-replaced picture is never replayed here.
    /// The density path carries exact consumed input without View/ready calls.
    pub fn repaint_current_skia_page(
        &mut self,
        scale: f64,
    ) -> Result<Option<u64>, container_render_skia::RenderError> {
        if !self.has_current_skia_scene() {
            return Ok(None);
        }
        let authority = self.current_skia_frame_authority().cloned();
        let input = self
            .last_frame_input(self.skia_backend.renderer.snapshot_revision())
            .cloned();
        self.skia_backend
            .renderer
            .ensure_mut()
            .repaint_accepted_layout(scale)?;
        self.record_last_frame_input(input);
        self.carry_retained_skia_frame_authority(authority);
        Ok(Some(self.skia_backend.renderer.snapshot_revision()))
    }

    /// A diagnostic readback does not replace the accepted layout or its input.
    pub fn capture_render_snapshot(
        &mut self,
    ) -> Result<Option<container_render_skia::RenderSnapshot>, container_render_skia::RenderError>
    {
        match self.skia_backend.renderer.peek_mut() {
            Some(renderer) => renderer.capture_snapshot(),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    fn prepared() -> (Session, ExternalFrameRecoveryExpected) {
        let mut manifest = ContainerManifestV1 {
            compiler: container_ir::CompilerInfo {
                name: "weapp-vite".into(),
                commit: "retained-recovery".into(),
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
                    window_width: 375,
                    window_height: 667,
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
        session.observer_frame_page = Some(page);
        session.observer_frame_valid = true;
        session.presented_revision = Some(session.skia_backend.renderer.snapshot_revision());
        session.record_last_frame_input(Some(BrowserPageInput {
            page_id: page,
            route_path: "pages/home/index".into(),
            template_revision: session.view.template_revision,
            viewport,
        }));
        session.install_skia_frame_authority();
        let expected = ExternalFrameRecoveryExpected {
            session_id: session.config.session_id.clone(),
            page_id: page.0.to_string(),
            route_path: "pages/home/index".into(),
            viewport,
            renderer_profile: container_ir::RendererProfile::Skia,
            template_revision: session.view.template_revision.to_string(),
            render_revision: session
                .skia_backend
                .renderer
                .snapshot_revision()
                .to_string(),
            input_lifetime_revision: session.input_lifetime_revision.unwrap().to_string(),
        };
        (session, expected)
    }

    #[test]
    fn retained_recovery_changes_only_publication_and_input_lifetime_without_pixels() {
        let (mut session, expected) = prepared();
        session
            .app_service
            .storage_mut()
            .set("keep", json!({"value":9}))
            .unwrap();
        let timer = session.app_service.schedule_timer(
            TimerKind::Timeout,
            100,
            0,
            Some("keep-callback".into()),
        );
        let frame = session.skia_backend.renderer.last_frame().unwrap().clone();
        let view = session.view.revision;
        let input = session.last_frame_input(1).unwrap().clone();
        let result = session.recover_external_frame(&expected).unwrap();
        assert_eq!(result.kind, "retained");
        assert_eq!(result.render_revision, "2");
        assert_eq!(session.skia_backend.renderer.last_frame(), Some(&frame));
        assert_eq!(session.last_frame_input(2), Some(&input));
        assert_eq!(session.input_lifetime_revision(), Some(1));
        assert!(!session.is_current_frame_presented());
        assert!(!session.observer_frame_valid);
        assert_eq!(session.view.revision, view);
        assert!(session.skia_backend.renderer.snapshot_ref().is_none());
        assert_eq!(
            session.app_service.storage().get("keep"),
            Some(&json!({"value":9}))
        );
        assert!(session.app_service.cancel_timer(timer));
        // Even an unchanged target scale is a genuine new publication.
        let mut next = expected.clone();
        next.render_revision = "2".into();
        next.input_lifetime_revision = "1".into();
        assert_eq!(
            session
                .recover_external_frame(&next)
                .unwrap()
                .render_revision,
            "3"
        );
    }

    #[test]
    fn dirty_recovery_requires_render_and_cannot_ack_the_old_frame() {
        let (mut session, mut expected) = prepared();
        session.view.template_revision += 1;
        expected.template_revision = session.view.template_revision.to_string();
        let result = session.recover_external_frame(&expected).unwrap();
        assert_eq!(result.kind, "render-required");
        assert_eq!(result.render_revision, "1");
        assert_eq!(session.input_lifetime_revision(), Some(1));
        assert!(session.last_frame_input(1).is_none());
        assert!(!session.observer_frame_valid);
        assert!(session.acknowledge_presentation_within_turn(1).is_err());
        assert!(!session.is_current_frame_presented());
    }

    #[test]
    fn consumed_input_without_layout_authority_cannot_recover_or_ack_retained_pixels() {
        let (mut session, expected) = prepared();
        assert!(session.last_frame_input(1).is_some());
        session.skia_frame_authority = None;
        let result = session.recover_external_frame(&expected).unwrap();
        assert_eq!(result.kind, "render-required");
        assert_eq!(result.render_revision, "1");
        assert!(session.last_frame_input(1).is_none());
        assert!(session.current_skia_frame_authority().is_none());
        assert!(session.acknowledge_presentation_within_turn(1).is_err());
        assert!(!session.is_current_frame_presented());
    }

    #[test]
    fn density_repaint_carries_only_previously_valid_layout_authority() {
        let (mut session, _) = prepared();
        let initial = session.current_skia_frame_authority().unwrap().clone();
        assert!(session.set_render_scale(f64::NAN).is_err());
        let unchanged = session.current_skia_frame_authority().unwrap();
        assert_eq!(unchanged.revision, initial.revision);
        assert_eq!(unchanged.input_lifetime, initial.input_lifetime);
        session.set_render_scale(2.0).unwrap();
        let carried = session.current_skia_frame_authority().unwrap();
        assert_eq!(carried.revision, 2);
        assert_eq!(carried.input_lifetime, initial.input_lifetime);
        assert_eq!(carried.viewport, initial.viewport);

        // A retired lifetime stays retired even if density preparation can
        // still repaint the retained renderer scene at the old dimensions.
        session.input_lifetime_revision = Some(initial.input_lifetime + 1);
        assert!(session.current_skia_frame_authority().is_none());
        session.set_render_scale(1.5).unwrap();
        assert!(session.current_skia_frame_authority().is_none());
        assert!(session.skia_frame_authority.is_none());
    }

    #[test]
    fn stale_or_exhausted_recovery_is_atomic_and_keeps_original_proof() {
        let (mut session, expected) = prepared();
        let proof = session.last_frame_input_json(1).unwrap();
        let mut stale = expected.clone();
        stale.template_revision = "99".into();
        assert_eq!(
            session.recover_external_frame(&stale).unwrap_err().code,
            BridgeErrorCode::Cancelled
        );
        let mut malformed = expected.clone();
        malformed.render_revision = "01".into();
        assert_eq!(
            session.recover_external_frame(&malformed).unwrap_err().code,
            BridgeErrorCode::ProtocolVersion
        );
        session.input_lifetime_revision = Some(u64::MAX);
        let mut exhausted = expected.clone();
        exhausted.input_lifetime_revision = u64::MAX.to_string();
        assert_eq!(
            session.recover_external_frame(&exhausted).unwrap_err().code,
            BridgeErrorCode::Render
        );
        assert_eq!(session.skia_backend.renderer.snapshot_revision(), 1);
        assert_eq!(session.last_frame_input_json(1).unwrap(), proof);
        assert!(session.observer_frame_valid);
        assert_eq!(session.presented_revision, Some(1));
    }
}
