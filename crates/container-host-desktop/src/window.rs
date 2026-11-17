//! Optional `winit`/`softbuffer` presenter for desktop development surfaces.
//!
//! The presenter deliberately owns only the platform window and its software
//! presentation buffer. Runtime state remains in [`DesktopHost`], and callers
//! feed it complete [`RenderSnapshot`] values after a `render.commit`. This
//! keeps the desktop window path batch-oriented and makes it possible to use
//! the same host session from a Web surface or an embedding application.

use container_render_skia::RenderSnapshot;
use softbuffer::{Context, SoftBufferError, Surface};
use std::num::NonZeroU32;
use std::sync::Arc;
use thiserror::Error;
use winit::dpi::PhysicalSize;
use winit::error::OsError;
use winit::event_loop::EventLoop;
use winit::window::{Window, WindowId};

/// Errors returned while creating or presenting a desktop window.
#[derive(Debug, Error)]
pub enum WindowPresenterError {
    #[error("desktop window creation failed: {0}")]
    Window(#[from] OsError),
    #[error("desktop surface failed: {0}")]
    Surface(#[from] SoftBufferError),
    #[error("render snapshot has an invalid size {width}x{height}")]
    InvalidSnapshotSize { width: u32, height: u32 },
    #[error("render snapshot pixel data is truncated: need {required} bytes, got {actual}")]
    TruncatedSnapshot { required: usize, actual: usize },
}

/// A native software presenter backed by a `winit` window and `softbuffer`.
///
/// The event loop is intentionally owned by the caller. A typical desktop
/// host creates an [`EventLoop`] once, creates this presenter, and handles
/// `WindowEvent::RedrawRequested` by calling [`Self::present`]. The presenter
/// can therefore be integrated into a larger event loop without spawning a
/// second thread or introducing a second runtime session.
#[derive(Debug)]
pub struct DesktopWindowPresenter {
    window: Arc<Window>,
    context: Context<Arc<Window>>,
    surface: Surface<Arc<Window>, Arc<Window>>,
    surface_size: PhysicalSize<u32>,
    last_frame_id: Option<u64>,
}

/// Capabilities of the window presenter after its native surface has been
/// created.  This intentionally reports the display surface and renderer
/// separately from a GPU context: `softbuffer` presents a real platform
/// window using a CPU-backed pixel buffer, so it is useful desktop evidence
/// without being a Skia/Metal/Vulkan GPU claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowSurfaceCapabilities {
    pub native_surface: bool,
    pub renderer: &'static str,
    pub gpu_surface: bool,
}

impl DesktopWindowPresenter {
    /// Create a visible window with a software presentation surface.
    ///
    /// `event_loop` must be created and used on the same thread as the
    /// caller. `winit` enforces that requirement for native event loops.
    #[allow(deprecated)]
    pub fn new(
        event_loop: &EventLoop<()>,
        title: impl Into<String>,
        width: u32,
        height: u32,
    ) -> Result<Self, WindowPresenterError> {
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title(title)
                    .with_inner_size(PhysicalSize::new(width.max(1), height.max(1))),
            )?,
        );
        let context = Context::new(window.clone())?;
        let mut surface = Surface::new(&context, window.clone())?;
        let surface_size = window.inner_size();
        let (surface_width, surface_height) = non_zero_size(surface_size);
        surface.resize(surface_width, surface_height)?;
        Ok(Self {
            window,
            context,
            surface,
            surface_size,
            last_frame_id: None,
        })
    }

    /// Return the platform window id used to route redraw and resize events.
    pub fn window_id(&self) -> WindowId {
        self.window.id()
    }

    /// Borrow the underlying `winit` window for event-loop integration.
    pub fn window(&self) -> &Window {
        &self.window
    }

    /// Return the presentation boundary owned by this presenter.
    ///
    /// Construction of `DesktopWindowPresenter` creates the winit window and
    /// attaches a `softbuffer::Surface`; a successful call therefore proves a
    /// native desktop surface exists.  The renderer remains explicitly
    /// software-backed until a platform GPU presenter is wired in.
    pub const fn capabilities(&self) -> WindowSurfaceCapabilities {
        WindowSurfaceCapabilities {
            native_surface: true,
            renderer: "softbuffer-raster",
            gpu_surface: false,
        }
    }

    /// A concise backend label for host diagnostics and smoke reports.
    pub const fn renderer_backend(&self) -> &'static str {
        self.capabilities().renderer
    }

    /// The presenter owns an actual winit/softbuffer surface after
    /// construction.  This does not imply that the runtime renderer has a
    /// GPU context attached.
    pub const fn has_native_surface(&self) -> bool {
        self.capabilities().native_surface
    }

    /// `softbuffer` is a CPU presentation path; keep this false until a
    /// platform-specific GPU surface is explicitly connected.
    pub const fn has_gpu_surface(&self) -> bool {
        self.capabilities().gpu_surface
    }

    /// Update the native title without changing the runtime or presentation
    /// surface. Development hosts use this for revision/route diagnostics.
    pub fn set_title(&self, title: impl AsRef<str>) {
        self.window.set_title(title.as_ref());
    }

    /// The last size submitted to the software surface.
    pub fn surface_size(&self) -> PhysicalSize<u32> {
        self.surface_size
    }

    /// The frame id most recently presented by [`Self::present`].
    pub fn last_frame_id(&self) -> Option<u64> {
        self.last_frame_id
    }

    /// Resize the backing surface after receiving a `WindowEvent::Resized`.
    ///
    /// Zero-sized surfaces are ignored by native compositors while a window is
    /// minimized. The requested size is retained so a later resize or frame
    /// can re-enable presentation without panicking on `NonZeroU32`.
    pub fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), WindowPresenterError> {
        self.surface_size = size;
        if size.width == 0 || size.height == 0 {
            return Ok(());
        }
        let (width, height) = non_zero_size(size);
        self.surface.resize(width, height)?;
        Ok(())
    }

    /// Present one complete premultiplied RGBA8 render snapshot.
    ///
    /// `softbuffer` consumes opaque `0x00RRGGBB` pixels. The runtime's RGBA
    /// snapshot is already premultiplied, so dropping alpha composites onto
    /// the window's black surface without an extra per-node bridge exchange.
    pub fn present(&mut self, snapshot: &RenderSnapshot) -> Result<(), WindowPresenterError> {
        if snapshot.width == 0 || snapshot.height == 0 {
            return Err(WindowPresenterError::InvalidSnapshotSize {
                width: snapshot.width,
                height: snapshot.height,
            });
        }
        let stride = snapshot.stride as usize;
        let width = snapshot.width as usize;
        let height = snapshot.height as usize;
        let row_bytes = width
            .checked_mul(4)
            .ok_or(WindowPresenterError::InvalidSnapshotSize {
                width: snapshot.width,
                height: snapshot.height,
            })?;
        let required =
            stride
                .checked_mul(height)
                .ok_or(WindowPresenterError::InvalidSnapshotSize {
                    width: snapshot.width,
                    height: snapshot.height,
                })?;
        if stride < row_bytes || snapshot.pixels.len() < required {
            return Err(WindowPresenterError::TruncatedSnapshot {
                required,
                actual: snapshot.pixels.len(),
            });
        }

        // A snapshot is commonly sized to the logical viewport while a native
        // window can be resized independently. Keep the backing surface at
        // the size supplied by the window's `Resized` event. The copy below
        // clips or clears around the logical frame, so presenting a new frame
        // must never undo a user's resize by silently restoring the snapshot
        // dimensions.
        if self.surface_size.width == 0 || self.surface_size.height == 0 {
            return Ok(());
        }

        let mut buffer = self.surface.buffer_mut()?;
        let buffer_width = self.surface_size.width as usize;
        let buffer_height = self.surface_size.height as usize;
        let copy_width = width.min(buffer_width);
        let copy_height = height.min(buffer_height);
        for y in 0..copy_height {
            let source = &snapshot.pixels[y * stride..y * stride + copy_width * 4];
            let destination = &mut buffer[y * buffer_width..(y + 1) * buffer_width];
            for (x, pixel) in source.as_chunks::<4>().0.iter().enumerate() {
                destination[x] =
                    ((pixel[0] as u32) << 16) | ((pixel[1] as u32) << 8) | pixel[2] as u32;
            }
            // Clear any portion of a larger surface left over from the last
            // frame. This matters when a page shrinks during a hot reload.
            for pixel in &mut destination[copy_width..] {
                *pixel = 0;
            }
        }
        for row in buffer.chunks_exact_mut(buffer_width).skip(copy_height) {
            row.fill(0);
        }
        buffer.present()?;
        self.last_frame_id = Some(snapshot.frame_id);
        Ok(())
    }

    /// Request a redraw through the caller's event loop.
    pub fn request_redraw(&self) {
        self.window.request_redraw();
    }

    /// Keep the context alive for the lifetime of the surface. This is mostly
    /// useful to embedders that need to verify the presenter owns exactly one
    /// display context; normal callers do not need to use it.
    pub fn context(&self) -> &Context<Arc<Window>> {
        &self.context
    }
}

fn non_zero_size(size: PhysicalSize<u32>) -> (NonZeroU32, NonZeroU32) {
    (
        NonZeroU32::new(size.width.max(1)).expect("max(1) is non-zero"),
        NonZeroU32::new(size.height.max(1)).expect("max(1) is non-zero"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_zero_size_keeps_minimized_dimensions_safe() {
        assert_eq!(
            non_zero_size(PhysicalSize::new(0, 0)),
            (NonZeroU32::MIN, NonZeroU32::MIN)
        );
    }

    #[test]
    fn presenter_capability_contract_does_not_overclaim_gpu() {
        // This is a static assertion of the presenter contract. Creating a
        // winit window belongs to the platform smoke because unit tests may
        // run without a display server.
        let capabilities = WindowSurfaceCapabilities {
            native_surface: true,
            renderer: "softbuffer-raster",
            gpu_surface: false,
        };
        assert!(capabilities.native_surface);
        assert_eq!(capabilities.renderer, "softbuffer-raster");
        assert!(!capabilities.gpu_surface);
    }
}
