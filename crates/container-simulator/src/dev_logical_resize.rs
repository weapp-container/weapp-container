//! Irreversible application execution followed by prepared visual publication.
//! All Skia modes share the runtime transaction; only the transport differs.
use super::*;
use container_render_skia::PageRenderMode;
use presentation::PresentationSettings;
use web::{PresentationControlFence, WebFrameReservation, WebSurfaceHandle};

fn retain_effects(
    trace: &mut TraceHistory,
    dev_errors: &mut Vec<BridgeEnvelope>,
    next_request: &mut u64,
    session_id: &str,
    viewport: Rect,
    batch: &BridgeBatch,
) {
    let request = BridgeEnvelope::request(
        session_id,
        format!("sim-resize-{}", *next_request),
        op::EVENT_BATCH,
        json!({"source":"host", "type":"host.resize", "viewport":viewport}),
    );
    *next_request = next_request.saturating_add(1);
    trace.push(&request, batch);
    dev_errors.extend(
        batch
            .messages
            .iter()
            .filter(|message| message.op == op::ERROR)
            .cloned(),
    );
}

impl Simulator {
    /// No transport, callback or allocation may be inserted between runtime
    /// acceptance and Web installation. A failed preparation retains effects
    /// and old diagnostic pixels, without reverse resize or old-frame commit.
    pub fn apply_web_logical_resize<'a>(
        &mut self,
        handle: &'a WebSurfaceHandle,
        candidate: &PresentationSettings,
        control: &PresentationControlFence,
        reservation: Option<WebFrameReservation<'a>>,
    ) -> Result<BridgeBatch, String> {
        handle.validate_logical_resize_owner(control, reservation.as_ref())?;
        candidate.validate()?;
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: candidate.logical_width as f32,
            height: candidate.logical_height as f32,
        };
        if self.current_renderer_profile() == RendererProfile::WebView
            || viewport == self.config.viewport
        {
            return Err(
                "ERR_PRESENTATION_CONFIG: logical resize requires changed Skia geometry".into(),
            );
        }
        let target = self
            .host
            .validate_skia_render_target(viewport, candidate.effective_scale)
            .map_err(|error| error.to_string())?;
        let settings = serde_json::to_value(candidate).map_err(|error| error.to_string())?;
        let session_id = self.session_id().to_owned();
        let mode = self
            .host
            .session()
            .ok_or("ERR_ENGINE: session is not loaded")?
            .page_render_mode();
        let had_current_scene = self.has_current_skia_scene();
        // Retain the injected reservation only as an initial preflight edge.
        // Export/GPU modes never reserve a page-sized CPU pixel response.
        let reservation = if mode == PageRenderMode::Raster && had_current_scene {
            Some(match reservation {
                Some(reservation) => reservation,
                None => handle.reserve_frame(
                    &session_id,
                    candidate.generation,
                    viewport.width,
                    viewport.height,
                    target.width,
                    target.height,
                )?,
            })
        } else {
            drop(reservation);
            None
        };
        let mut prepared = match self
            .host
            .session_mut()
            .ok_or("ERR_ENGINE: session is not loaded")?
            .prepare_dev_logical_resize(viewport, candidate.effective_scale)
        {
            Ok(prepared) => prepared,
            Err(failure) => {
                retain_effects(
                    &mut self.trace,
                    &mut self.dev_errors,
                    &mut self.next_request,
                    &session_id,
                    viewport,
                    &failure.effects,
                );
                return Err(failure.error.to_string());
            }
        };
        let transport = (|| {
            if let Some(picture) = prepared.picture() {
                let transport = if mode == PageRenderMode::Raster {
                    let snapshot = picture
                        .snapshot()
                        .ok_or("ERR_RENDER: prepared Raster page has no real snapshot")?;
                    reservation
                        .expect("Raster reservation prepared before hooks")
                        .prepare(snapshot, picture.render_revision(), picture.render_ms())?
                } else {
                    handle.prepare_render_frame_at_scale(
                        &session_id,
                        candidate.generation,
                        picture.frame(),
                        picture.render_revision(),
                        picture.render_ms(),
                        candidate.effective_scale,
                    )?
                };
                transport
                    .with_presentation(settings)
                    .validate_control(control)
            } else {
                // A route announced before its first ordinary pump has no
                // picture authority. Publish only the validated preferences.
                handle
                    .prepare_presentation(settings)?
                    .validate_control(control)
            }
        })();
        let transport = match transport {
            Ok(transport) => transport,
            Err(error) => {
                // The failed Web guard has already unlocked before candidate
                // disposal restores Rust geometry and invalidates the mirror.
                let effects = prepared.take_effects();
                drop(prepared);
                retain_effects(
                    &mut self.trace,
                    &mut self.dev_errors,
                    &mut self.next_request,
                    &session_id,
                    viewport,
                    &effects,
                );
                return Err(error);
            }
        };
        let mut retired = prepared.accept_with_retirement();
        transport.install();
        self.config.viewport = viewport;
        self.config.render_scale = candidate.effective_scale;
        let revision = retired.render_revision();
        let exact_raster = retired.requires_exact_raster_presentation();
        let consumed = retired.consumed_page_input().map(|input| {
            (
                input.page_id.0,
                input.route_path.clone(),
                input.template_revision,
            )
        });
        let mut effects = retired.take_effects();
        drop(retired); // old runtime owners are released after Web unlock
        if revision.is_some() {
            self.rendered_state = consumed.clone();
            self.last_render_attempt = consumed;
        }
        retain_effects(
            &mut self.trace,
            &mut self.dev_errors,
            &mut self.next_request,
            &session_id,
            viewport,
            &effects,
        );
        // Only the existing non-strict Raster policy acknowledges here. The
        // export/GPU owner must still supply its asynchronous presentation ACK.
        if let Some(revision) = revision.filter(|_| mode == PageRenderMode::Raster && !exact_raster)
        {
            match self.acknowledge_presentation(revision) {
                Ok(batch) => effects.messages.extend(batch.messages),
                Err(error) => effects.messages.push(BridgeEnvelope::event(
                    &session_id,
                    op::ERROR,
                    json!({"code":"ERR_ENGINE", "message":error.to_string(),
                        "committed":true, "phase":"presentation"}),
                )),
            }
        }
        Ok(effects)
    }

    /// Standalone/desktop callers share the same prepared runtime transaction.
    /// Application effects are retained when any later preparation fails.
    pub(super) fn apply_skia_logical_resize(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<BridgeBatch, SimulatorError> {
        let session_id = self.session_id().to_owned();
        let mode = self
            .host
            .session()
            .ok_or(HostSessionError::NotLoaded)?
            .page_render_mode();
        let prepared = match self
            .host
            .session_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .prepare_dev_logical_resize(viewport, scale)
        {
            Ok(prepared) => prepared,
            Err(failure) => {
                retain_effects(
                    &mut self.trace,
                    &mut self.dev_errors,
                    &mut self.next_request,
                    &session_id,
                    viewport,
                    &failure.effects,
                );
                return Err(SimulatorError::Config(failure.error.to_string()));
            }
        };
        let mut retired = prepared.accept_with_retirement();
        self.config.viewport = viewport;
        self.config.render_scale = scale;
        let revision = retired.render_revision();
        let exact_raster = retired.requires_exact_raster_presentation();
        let consumed = retired.consumed_page_input().map(|input| {
            (
                input.page_id.0,
                input.route_path.clone(),
                input.template_revision,
            )
        });
        let mut effects = retired.take_effects();
        drop(retired);
        if revision.is_some() {
            self.rendered_state = consumed.clone();
            self.last_render_attempt = consumed;
        }
        retain_effects(
            &mut self.trace,
            &mut self.dev_errors,
            &mut self.next_request,
            &session_id,
            viewport,
            &effects,
        );
        if let Some(revision) = revision.filter(|_| mode == PageRenderMode::Raster && !exact_raster)
        {
            // Ready/observer failures are committed diagnostics; never return
            // to a geometry rollback branch after the prepared fields moved.
            match self.acknowledge_presentation(revision) {
                Ok(batch) => effects.messages.extend(batch.messages),
                Err(error) => effects.messages.push(BridgeEnvelope::event(
                    &session_id,
                    op::ERROR,
                    json!({"code":"ERR_ENGINE", "message":error.to_string(),
                        "committed":true, "phase":"presentation"}),
                )),
            }
        }
        Ok(effects)
    }
}
