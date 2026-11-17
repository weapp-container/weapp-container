//! Density-only native/Web joint acceptance. Logical resize and its callback /
//! engine compensation are intentionally handled by the existing resize path.
use super::*;
use container_render_skia::PageRenderMode;
use presentation::PresentationSettings;
use web::WebSurfaceHandle;

impl Simulator {
    /// Prepare the retained picture and every Web response before accepting
    /// either owner. This concrete owner operation exposes no arbitrary commit
    /// callback and never runs View, resize/ready hooks or JS compensation.
    pub fn apply_web_density(
        &mut self,
        handle: &WebSurfaceHandle,
        candidate: &PresentationSettings,
        frame_changed: bool,
    ) -> Result<BridgeBatch, String> {
        candidate.validate()?;
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: candidate.logical_width as f32,
            height: candidate.logical_height as f32,
        };
        if viewport != self.config.viewport
            || self.current_renderer_profile() == RendererProfile::WebView
        {
            return Err("ERR_PRESENTATION_CONFIG: retained density requires unchanged Skia logical geometry".into());
        }
        self.host
            .validate_skia_render_target(viewport, candidate.effective_scale)
            .map_err(|error| error.to_string())?;
        // Complete serialization before any accepted target is changed.
        let settings = serde_json::to_value(candidate).map_err(|error| error.to_string())?;
        if !self
            .host
            .session()
            .is_some_and(|session| session.has_current_skia_scene())
        {
            // An old-route picture supplies no new publication authority. Only
            // stage the next first-render target for the ordinary owner pump.
            // Lock/prepare the settings store before staging even a lazy
            // target. Poisoned/unavailable Web state must leave that pending
            // target and Simulator configuration untouched as well.
            let transport = handle.prepare_presentation(settings)?;
            self.host
                .stage_skia_render_target(viewport, candidate.effective_scale)
                .map_err(|error| error.to_string())?;
            transport.install();
            self.config.render_scale = candidate.effective_scale;
            return Ok(BridgeBatch::new(Vec::new()));
        }
        // A caller cannot suppress a changed density's transport publication
        // by passing a stale scheduling hint.
        let frame_changed = frame_changed || candidate.effective_scale != self.config.render_scale;
        let session_id = self.session_id().to_owned();
        let previous_revision = self.host.render_revision();
        let picture = self
            .host
            .prepare_dev_density(candidate.effective_scale)
            .map_err(|error| error.to_string())?
            .expect("the current scene was checked without intervening runtime work");
        // Staged config may already name this scale while the accepted page
        // still has an older target. The actual candidate revision, not a
        // scheduling hint or config equality, decides whether pixels changed.
        let frame_changed =
            frame_changed || picture.picture().render_revision() != previous_revision;
        let transport = if !frame_changed {
            handle.prepare_presentation(settings)?
        } else if picture.picture().page_render_mode() == PageRenderMode::Raster {
            let target = picture.picture().target();
            let snapshot = picture
                .picture()
                .snapshot()
                .ok_or("ERR_RENDER: prepared raster density has no real snapshot")?;
            handle
                .reserve_frame(
                    &session_id,
                    candidate.generation,
                    viewport.width,
                    viewport.height,
                    target.width,
                    target.height,
                )?
                .prepare(
                    snapshot,
                    picture.picture().render_revision(),
                    picture.picture().render_ms(),
                )?
                .with_presentation(settings)
        } else {
            handle
                .prepare_render_frame_at_scale(
                    &session_id,
                    candidate.generation,
                    picture.picture().frame(),
                    picture.picture().render_revision(),
                    picture.picture().render_ms(),
                    candidate.effective_scale,
                )?
                .with_presentation(settings)
        };
        // Both guards are exclusive and fully prepared. No new lock, fallible
        // work, callback, allocation or await may be inserted between these
        // moves. Published generations never have a rollback entry point.
        let retired = picture.accept_with_retirement();
        transport.install();
        // The runtime receipt also owns old pixels and input/ticket data.
        // Keep those owners alive until the Web store has released its lock.
        drop(retired);
        self.config.render_scale = candidate.effective_scale;
        Ok(BridgeBatch::new(Vec::new()))
    }
}
