//! Session-owned provenance for an accepted Skia coordinate system.
//!
//! This is independent of template-input scheduling and presentation receipts:
//! explicit frames can own layout, and an accepted layout still needs an ACK.
use super::*;

#[derive(Clone)]
pub(super) struct SkiaFrameAuthority {
    pub(super) revision: u64,
    pub(super) page: Option<PageId>,
    pub(super) input_lifetime: u64,
    pub(super) host_width: u32,
    pub(super) host_height: u32,
    pub(super) viewport: Rect,
}

impl SkiaFrameAuthority {
    pub(super) fn from_accepted_frame(
        revision: u64,
        page: Option<PageId>,
        input_lifetime: Option<u64>,
        host_width: u32,
        host_height: u32,
        viewport: Rect,
    ) -> Option<Self> {
        let input_lifetime = input_lifetime?;
        if revision == 0
            || !viewport.x.is_finite()
            || !viewport.y.is_finite()
            || !viewport.width.is_finite()
            || !viewport.height.is_finite()
            || viewport.width <= 0.0
            || viewport.height <= 0.0
            // Zero dimensions are the legacy unmeasured host sentinel. Once
            // native geometry is known, an old-size fresh commit is still not
            // a layout for that host, even with a new renderer revision.
            || (host_width != 0 && viewport.width != host_width as f32)
            || (host_height != 0 && viewport.height != host_height as f32)
        {
            return None;
        }
        Some(Self {
            revision,
            page,
            input_lifetime,
            host_width,
            host_height,
            viewport,
        })
    }

    fn matches_layout(&self, session: &Session) -> bool {
        self.page == session.app_service.pages().current().map(|page| page.id)
            && self.host_width == session.config.host.window_width
            && self.host_height == session.config.host.window_height
            && session
                .skia_backend
                .renderer
                .last_frame()
                .is_some_and(|frame| frame.viewport == self.viewport)
    }
}

impl Session {
    pub(super) fn skia_frame_authority_required(&self) -> bool {
        self.app_service.pages().current().is_some()
            // The original no-chrome, headless Raster embedding permits
            // explicit routed events before any frame. Zero host dimensions
            // are its documented sentinel, not a measured native viewport.
            && !(self.skia_backend.renderer.page_render_mode() == PageRenderMode::Raster
                && self.config.host.window_width == 0
                && self.config.host.window_height == 0
                && self.skia_backend.renderer.last_frame().is_none()
                && !self.dev_raster_presentation_required())
    }

    pub(super) fn current_skia_frame_authority(&self) -> Option<&SkiaFrameAuthority> {
        let authority = self.skia_frame_authority.as_ref()?;
        (authority.revision == self.skia_backend.renderer.snapshot_revision()
            && self.input_lifetime_revision == Some(authority.input_lifetime)
            && !self.engine_execution_is_faulted()
            && !self.view_execution_is_faulted()
            && authority.matches_layout(self))
        .then_some(authority)
    }

    /// Called only after Session accepts a fresh, fully prepared frame.
    pub(super) fn install_skia_frame_authority(&mut self) {
        self.skia_frame_authority = self.skia_backend.renderer.last_frame().and_then(|frame| {
            SkiaFrameAuthority::from_accepted_frame(
                self.skia_backend.renderer.snapshot_revision(),
                self.app_service.pages().current().map(|page| page.id),
                self.input_lifetime_revision,
                self.config.host.window_width,
                self.config.host.window_height,
                frame.viewport,
            )
        });
    }

    /// Pure repaints may carry a previously validated layout, never create one
    /// from retained pixels. The caller captures it before touching renderer or
    /// lifetime; it must still match the exact page, host and retained viewport.
    pub(super) fn carry_retained_skia_frame_authority(
        &mut self,
        previous: Option<SkiaFrameAuthority>,
    ) {
        self.skia_frame_authority = previous
            .filter(|authority| authority.matches_layout(self))
            .and_then(|authority| {
                SkiaFrameAuthority::from_accepted_frame(
                    self.skia_backend.renderer.snapshot_revision(),
                    authority.page,
                    self.input_lifetime_revision,
                    authority.host_width,
                    authority.host_height,
                    authority.viewport,
                )
            });
    }

    /// Retire before host-environment preparation can run any application job.
    /// A failed installation or A→B→A geometry sequence cannot revive this cap.
    pub(super) fn retire_skia_frame_authority(&mut self) {
        self.skia_frame_authority = None;
        self.committed_frame_input = None;
        self.presented_revision = None;
        self.pending_presentation = None;
        self.observer_frame_page = None;
        self.observer_frame_valid = false;
    }
}
