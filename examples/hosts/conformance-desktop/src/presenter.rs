//! Linux software window owner, using the runtime's existing exact Raster policy.
use crate::pack::Result;
use crate::profile::require_exact_surface;
use crate::session::ensure_success;
use crate::software_owner::{
    submit_raster_publication, SoftwarePublicationOwner, SoftwareSubmission,
};
use container_bridge::BridgeBatch;
use container_host_common::HostSession;
use container_host_desktop::DesktopWindowPresenter;
use container_render_skia::PageRenderMode;
use container_runtime::RasterPresentationPolicy;
use winit::{
    dpi::PhysicalSize,
    event_loop::EventLoop,
    window::{Window, WindowId},
};
pub struct SoftwareWindowPresenter {
    inner: DesktopWindowPresenter,
    owner: SoftwarePublicationOwner,
}
impl SoftwareWindowPresenter {
    pub fn new(
        event_loop: &EventLoop<()>,
        title: impl Into<String>,
        width: u32,
        height: u32,
    ) -> Result<Self> {
        let inner = DesktopWindowPresenter::new(event_loop, title, width, height)?;
        let identity = container_ir::hex_digest(
            format!("{}:{:?}", std::process::id(), inner.window_id()).as_bytes(),
        );
        Ok(Self {
            inner,
            owner: SoftwarePublicationOwner::new(format!("linux_window_{identity}")),
        })
    }
    pub fn window(&self) -> &Window {
        self.inner.window()
    }
    pub fn window_id(&self) -> WindowId {
        self.inner.window_id()
    }
    pub fn has_native_surface(&self) -> bool {
        self.inner.has_native_surface()
    }
    pub fn has_gpu_surface(&self) -> bool {
        self.inner.has_gpu_surface()
    }
    pub fn resize(&mut self, size: PhysicalSize<u32>, host: &mut HostSession) -> Result<()> {
        self.owner.invalidate()?;
        host.session_mut()
            .ok_or("software host is unloaded")?
            .suspend_dev_raster_presentation();
        self.inner.resize(size)?;
        Ok(())
    }
    pub fn attach_session(&mut self, host: &mut HostSession) -> Result<()> {
        let session = host.session().ok_or("software host is unloaded")?;
        if session.page_render_mode() != PageRenderMode::Raster
            || session.raster_presentation_policy() != RasterPresentationPolicy::ExplicitDev
            || host.has_gpu_surface()?
            || host.renderer_backend()? != "software-fallback"
        {
            return Err("explicit Linux software profile requires exact Raster ownership and software renderer".into());
        }
        Ok(())
    }
    pub fn present_session(&mut self, host: &mut HostSession) -> Result<SoftwareSubmission> {
        self.attach_session(host)?;
        let snapshot = host.render_snapshot()?;
        let size = self.inner.surface_size();
        require_exact_surface((size.width, size.height), (snapshot.width, snapshot.height))?;
        let session = host.session_mut().ok_or("software host is unloaded")?;
        let config = session.config();
        let target = self.owner.prepare(
            config.session_id.clone(),
            snapshot.frame_id,
            session.render_revision(),
            (config.host.window_width, config.host.window_height),
            (snapshot.width, snapshot.height),
        )?;
        let inner = &mut self.inner;
        submit_raster_publication(&mut self.owner, session, target, || {
            inner.present(&snapshot)?;
            if inner.last_frame_id() != Some(snapshot.frame_id) {
                return Err("software surface did not submit the current complete frame".into());
            }
            Ok(())
        })
    }

    pub fn acknowledge_submission(
        &mut self,
        host: &mut HostSession,
        submission: SoftwareSubmission,
    ) -> Result<(u64, BridgeBatch)> {
        let ticket = self.owner.consume(submission)?;
        let size = self.inner.surface_size();
        require_exact_surface(
            (size.width, size.height),
            (ticket.target.width, ticket.target.height),
        )?;
        if self.inner.last_frame_id() != Some(ticket.target.source_frame_id) {
            return Err(
                "software submission no longer belongs to the current surface frame".into(),
            );
        }
        let batch = host
            .session_mut()
            .ok_or("software host is unloaded")?
            .acknowledge_dev_raster_presentation(&ticket)?;
        Ok((ticket.target.render_revision, batch))
    }
    pub fn detach_session(&mut self, host: &mut HostSession) -> Result<()> {
        self.owner.invalidate()?;
        host.session_mut()
            .ok_or("software host is unloaded")?
            .suspend_dev_raster_presentation();
        ensure_success(&host.retire_page_presenter("linux-software-presenter-detached")?)
    }
}
