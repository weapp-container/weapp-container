//! One window presenter for the simulator's existing HostSession.
//! Native presentation never goes through an RGBA snapshot.

use container_host_common::{HostSession, HostSessionError};
use container_host_desktop::{DesktopWindowPresenter, WindowPresenterError};
use container_render_skia::PageRenderMode;
use thiserror::Error;
use winit::dpi::PhysicalSize;
use winit::event_loop::EventLoop;
use winit::window::WindowId;

#[cfg(target_os = "macos")]
use container_host_desktop::{MetalWindowPresenter, MetalWindowPresenterError};

#[cfg(any(target_os = "windows", target_os = "linux"))]
use container_host_desktop::{GlWindowPresenter, GlWindowPresenterError};

#[derive(Debug, Error)]
pub enum DesktopPresenterError {
    #[error("ERR_UNSUPPORTED_CAPABILITY: native desktop GPU presentation is unavailable on this platform; select software explicitly")]
    UnsupportedGpu,
    #[error("ERR_RENDER: a frame has not been presented at the current window size")]
    NotPresented,
    #[error("ERR_RENDER: invalid presentation geometry")]
    InvalidGeometry,
    #[error(transparent)]
    Host(#[from] HostSessionError),
    #[error(transparent)]
    Software(#[from] WindowPresenterError),
    #[error("ERR_RENDER: invalid presentation acknowledgement: {0}")]
    Acknowledgement(#[from] serde_json::Error),
    #[error("presentation callback failed after the frame was submitted: {0}")]
    PresentationEffect(serde_json::Value),
    #[cfg(target_os = "macos")]
    #[error(transparent)]
    Metal(#[from] MetalWindowPresenterError),
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    #[error(transparent)]
    Gl(#[from] GlWindowPresenterError),
}

/// Scale of the content actually submitted to the window compositor.
/// Software pixels are copied 1:1; Metal draws into the entire drawable.
#[derive(Debug, Clone, Copy)]
pub struct PresentationGeometry {
    scale_x: f64,
    scale_y: f64,
}

impl PresentationGeometry {
    fn new(
        logical_width: f64,
        logical_height: f64,
        pixel_width: u32,
        pixel_height: u32,
    ) -> Result<Self, DesktopPresenterError> {
        if !logical_width.is_finite()
            || !logical_height.is_finite()
            || logical_width <= 0.0
            || logical_height <= 0.0
            || pixel_width == 0
            || pixel_height == 0
        {
            return Err(DesktopPresenterError::InvalidGeometry);
        }
        Ok(Self {
            scale_x: f64::from(pixel_width) / logical_width,
            scale_y: f64::from(pixel_height) / logical_height,
        })
    }

    fn input_scale(self) -> (f64, f64) {
        (self.scale_x, self.scale_y)
    }
}

#[derive(Debug)]
pub enum DesktopPresenter {
    Software {
        presenter: Box<DesktopWindowPresenter>,
        geometry: Option<PresentationGeometry>,
    },
    #[cfg(target_os = "macos")]
    Metal {
        presenter: Box<MetalWindowPresenter>,
        geometry: Option<PresentationGeometry>,
    },
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    Gl {
        presenter: Box<GlWindowPresenter>,
        geometry: Option<PresentationGeometry>,
    },
}

impl DesktopPresenter {
    /// May be called before starting a watcher or constructing an event loop.
    pub fn ensure_supported(software: bool) -> Result<(), DesktopPresenterError> {
        if software
            || cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))
        {
            Ok(())
        } else {
            Err(DesktopPresenterError::UnsupportedGpu)
        }
    }

    pub fn new(
        event_loop: &EventLoop<()>,
        title: impl Into<String>,
        width: u32,
        height: u32,
        software: bool,
    ) -> Result<Self, DesktopPresenterError> {
        Self::ensure_supported(software)?;
        if software {
            // The explicit legacy presenter retains its 1:1 physical-pixel
            // copy/clip semantics. It must not masquerade as GPU scaling.
            return Ok(Self::Software {
                presenter: Box::new(DesktopWindowPresenter::new(
                    event_loop, title, width, height,
                )?),
                geometry: None,
            });
        }
        #[cfg(target_os = "macos")]
        {
            let mut presenter = MetalWindowPresenter::new(event_loop, title, width, height)?;
            // Simulator viewport dimensions are logical points. Let winit
            // resolve the active screen density instead of multiplying by a
            // guessed DPR; later Resized events remain authoritative.
            if let Some(size) = presenter
                .window()
                .request_inner_size(winit::dpi::LogicalSize::new(width, height))
            {
                presenter.resize(size);
            }
            Ok(Self::Metal {
                presenter: Box::new(presenter),
                geometry: None,
            })
        }
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            Ok(Self::Gl {
                presenter: Box::new(GlWindowPresenter::new(event_loop, title, width, height)?),
                geometry: None,
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        Err(DesktopPresenterError::UnsupportedGpu)
    }

    pub const fn mode(&self) -> PageRenderMode {
        match self {
            Self::Software { .. } => PageRenderMode::Raster,
            #[cfg(target_os = "macos")]
            Self::Metal { .. } => PageRenderMode::NativeGpu,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { .. } => PageRenderMode::NativeGpu,
        }
    }

    pub fn window_id(&self) -> WindowId {
        match self {
            Self::Software { presenter, .. } => presenter.window_id(),
            #[cfg(target_os = "macos")]
            Self::Metal { presenter, .. } => presenter.window_id(),
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { presenter, .. } => presenter.window_id(),
        }
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), DesktopPresenterError> {
        match self {
            Self::Software {
                presenter,
                geometry,
            } => {
                *geometry = None;
                presenter.resize(size)?;
            }
            #[cfg(target_os = "macos")]
            Self::Metal {
                presenter,
                geometry,
            } => {
                *geometry = None;
                presenter.resize(size);
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl {
                presenter,
                geometry,
            } => {
                *geometry = None;
                presenter.resize(size)?;
            }
        }
        Ok(())
    }

    pub fn request_redraw(&self) {
        match self {
            Self::Software { presenter, .. } => presenter.request_redraw(),
            #[cfg(target_os = "macos")]
            Self::Metal { presenter, .. } => presenter.request_redraw(),
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { presenter, .. } => presenter.request_redraw(),
        }
    }

    pub fn set_title(&self, title: impl AsRef<str>) {
        match self {
            Self::Software { presenter, .. } => presenter.set_title(title),
            #[cfg(target_os = "macos")]
            Self::Metal { presenter, .. } => presenter.window().set_title(title.as_ref()),
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { presenter, .. } => presenter.window().set_title(title.as_ref()),
        }
    }

    /// Input uses successful presentation geometry, never a requested DPR.
    /// Resize clears it until a matching new frame has been presented.
    pub fn input_scale(&self) -> Result<(f64, f64), DesktopPresenterError> {
        let geometry = match self {
            Self::Software { geometry, .. } => geometry,
            #[cfg(target_os = "macos")]
            Self::Metal { geometry, .. } => geometry,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { geometry, .. } => geometry,
        };
        geometry
            .map(PresentationGeometry::input_scale)
            .ok_or(DesktopPresenterError::NotPresented)
    }

    pub fn present(&mut self, host: &mut HostSession) -> Result<(), DesktopPresenterError> {
        match self {
            Self::Software { geometry, .. } => *geometry = None,
            #[cfg(target_os = "macos")]
            Self::Metal { geometry, .. } => *geometry = None,
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { geometry, .. } => *geometry = None,
        }
        let revision = host.render_revision();
        let viewport = host
            .accepted_page_observation()?
            .ok_or(DesktopPresenterError::NotPresented)?
            .frame
            .viewport;
        let next = match self {
            Self::Software { presenter, .. } => {
                let size = presenter.surface_size();
                if size.width == 0 || size.height == 0 {
                    return Err(DesktopPresenterError::NotPresented);
                }
                let snapshot = host.capture_render_snapshot()?;
                let next = PresentationGeometry::new(
                    f64::from(viewport.width),
                    f64::from(viewport.height),
                    snapshot.width,
                    snapshot.height,
                )?;
                presenter.present(&snapshot)?;
                next
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { presenter, .. } => {
                let size = presenter.surface_size();
                let next = PresentationGeometry::new(
                    f64::from(viewport.width),
                    f64::from(viewport.height),
                    size.width,
                    size.height,
                )?;
                presenter.present_session(host)?;
                next
            }
            #[cfg(target_os = "macos")]
            Self::Metal { presenter, .. } => {
                let size = presenter.surface_size();
                let next = PresentationGeometry::new(
                    f64::from(viewport.width),
                    f64::from(viewport.height),
                    size.width,
                    size.height,
                )?;
                // Hot reload replaces the renderer as well as the JS session.
                // Inspect the actual new renderer instead of caching session IDs.
                if !host.has_metal_context()? {
                    presenter.attach_session(host)?;
                }
                presenter.present_session(host)?;
                next
            }
        };
        if self.mode() == PageRenderMode::NativeGpu {
            let batch: container_bridge::BridgeBatch =
                serde_json::from_slice(&host.acknowledge_presentation_json(revision)?)?;
            if let Some(failure) = batch.messages.iter().find(|message| {
                message.op == container_bridge::op::ERROR
                    || message
                        .payload
                        .get("error")
                        .is_some_and(|error| !error.is_null())
                    || message.payload.get("ok") == Some(&serde_json::Value::Bool(false))
            }) {
                return Err(DesktopPresenterError::PresentationEffect(
                    failure.payload.clone(),
                ));
            }
        }
        // All native backends publish input geometry only after the runtime
        // accepts the submitted revision. A failed ACK must revoke old input.
        match self {
            Self::Software { geometry, .. } => *geometry = Some(next),
            #[cfg(target_os = "macos")]
            Self::Metal { geometry, .. } => *geometry = Some(next),
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl { geometry, .. } => *geometry = Some(next),
        }
        Ok(())
    }

    /// Release the context before the window/device owner is dropped.
    pub fn detach(&mut self, host: &mut HostSession) -> Result<(), DesktopPresenterError> {
        match self {
            Self::Software { geometry, .. } => *geometry = None,
            #[cfg(target_os = "macos")]
            Self::Metal {
                presenter,
                geometry,
            } => {
                *geometry = None;
                if host.has_session() {
                    presenter.detach_session(host)?;
                }
            }
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            Self::Gl {
                presenter,
                geometry,
            } => {
                *geometry = None;
                presenter.detach_session(host)?;
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        let _ = host;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_scale_follows_actual_drawable_not_screen_dpr() {
        let metal = PresentationGeometry::new(375.0, 667.0, 900, 1200).unwrap();
        assert_eq!(metal.input_scale(), (2.4, 1200.0 / 667.0));
        let software = PresentationGeometry::new(375.0, 667.0, 750, 1334).unwrap();
        assert_eq!(software.input_scale(), (2.0, 2.0));
    }

    #[test]
    fn zero_or_nonfinite_geometry_never_produces_input_coordinates() {
        for (width, height, pixels_x, pixels_y) in [
            (0.0, 667.0, 750, 1334),
            (375.0, f64::NAN, 750, 1334),
            (375.0, 667.0, 0, 1334),
            (375.0, 667.0, 750, 0),
        ] {
            assert!(PresentationGeometry::new(width, height, pixels_x, pixels_y).is_err());
        }
    }

    #[test]
    fn unsupported_gpu_does_not_select_software() {
        assert!(DesktopPresenter::ensure_supported(true).is_ok());
        assert_eq!(
            DesktopPresenter::ensure_supported(false).is_ok(),
            cfg!(any(
                target_os = "macos",
                target_os = "windows",
                target_os = "linux"
            ))
        );
    }
}
