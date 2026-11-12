//! Optional macOS `winit` + CAMetalLayer presenter.
//!
//! This module is intentionally separate from the `softbuffer` presenter.
//! `MetalWindowPresenter` owns a real AppKit view, CAMetalLayer, MTLDevice and
//! MTLCommandQueue, then asks the shared `DesktopHost` session to render each
//! committed frame directly into the current drawable texture through the
//! `skia-gpu-metal` boundary. The host presents the drawable only after Skia
//! has flushed its Ganesh commands.

use crate::DesktopHost;
use container_host_common::{HostSession, HostSessionError};
use objc2::{rc::Retained, runtime::ProtocolObject, ClassType};
use objc2_app_kit::NSView;
use objc2_foundation::CGSize;
use objc2_metal::{
    MTLCommandBuffer, MTLCommandQueue, MTLCreateSystemDefaultDevice, MTLDevice, MTLDrawable,
};
use objc2_quartz_core::{CAMetalDrawable, CAMetalLayer};
use std::sync::Arc;
use thiserror::Error;
use winit::dpi::PhysicalSize;
use winit::error::OsError;
use winit::event_loop::EventLoop;
use winit::raw_window_handle::{HasWindowHandle, RawWindowHandle};
use winit::window::{Window, WindowId};

/// Errors returned while creating or presenting a Metal window.
#[derive(Debug, Error)]
pub enum MetalWindowPresenterError {
    #[error("desktop window creation failed: {0}")]
    Window(#[from] OsError),
    #[error("Metal is unavailable on this host")]
    DeviceUnavailable,
    #[error("Metal command queue creation failed")]
    QueueUnavailable,
    #[error("winit did not expose an AppKit window handle")]
    WindowHandleUnavailable,
    #[error("CAMetalLayer did not provide a drawable")]
    DrawableUnavailable,
    #[error("CAMetalLayer drawable size is invalid")]
    InvalidDrawableSize,
    #[error("runtime Metal attachment failed: {0}")]
    Runtime(#[from] HostSessionError),
}

/// Runtime GPU capabilities observed by this presenter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MetalWindowSurfaceCapabilities {
    pub native_surface: bool,
    pub renderer: &'static str,
    pub gpu_surface: bool,
}

/// A macOS window whose drawable is rendered by the shared Skia Ganesh Metal
/// context owned by the runtime session.
#[derive(Debug)]
pub struct MetalWindowPresenter {
    window: Arc<Window>,
    metal_layer: Retained<CAMetalLayer>,
    device: Retained<ProtocolObject<dyn MTLDevice>>,
    command_queue: Retained<ProtocolObject<dyn MTLCommandQueue>>,
    surface_size: PhysicalSize<u32>,
    gpu_surface_attached: bool,
}

impl MetalWindowPresenter {
    /// Create a visible AppKit window and attach a CAMetalLayer to its view.
    /// Runtime state remains owned by [`DesktopHost`]; this object owns only
    /// the window and the platform GPU presentation resources.
    #[allow(deprecated)]
    pub fn new(
        event_loop: &EventLoop<()>,
        title: impl Into<String>,
        width: u32,
        height: u32,
    ) -> Result<Self, MetalWindowPresenterError> {
        let size = PhysicalSize::new(width.max(1), height.max(1));
        let window = Arc::new(
            event_loop.create_window(
                Window::default_attributes()
                    .with_title(title.into())
                    .with_inner_size(size),
            )?,
        );
        let device = unsafe { Retained::from_raw(MTLCreateSystemDefaultDevice()) }
            .ok_or(MetalWindowPresenterError::DeviceUnavailable)?;
        let command_queue = device
            .newCommandQueue()
            .ok_or(MetalWindowPresenterError::QueueUnavailable)?;

        let metal_layer = unsafe { CAMetalLayer::new() };
        unsafe {
            metal_layer.setDevice(Some(&device));
            metal_layer.setPixelFormat(objc2_metal::MTLPixelFormat::BGRA8Unorm);
            metal_layer.setPresentsWithTransaction(false);
            // Skia's Ganesh backend needs to access drawable contents while
            // recording commands, so framebufferOnly must be disabled.
            metal_layer.setFramebufferOnly(false);
            metal_layer.setDrawableSize(CGSize::new(size.width as f64, size.height as f64));
        }
        let view = window
            .window_handle()
            .ok()
            .and_then(|handle| match handle.as_raw() {
                RawWindowHandle::AppKit(appkit) => {
                    // `ns_view` is a non-owning pointer held by winit. The
                    // window itself remains alive for this presenter.
                    unsafe { (appkit.ns_view.as_ptr() as *mut NSView).as_ref() }
                }
                _ => None,
            })
            .ok_or(MetalWindowPresenterError::WindowHandleUnavailable)?;
        unsafe {
            view.setWantsLayer(true);
            let layer = metal_layer.clone();
            view.setLayer(Some(layer.as_super()));
        }

        Ok(Self {
            window,
            metal_layer,
            device,
            command_queue,
            surface_size: size,
            gpu_surface_attached: false,
        })
    }

    pub fn window_id(&self) -> WindowId {
        self.window.id()
    }

    pub fn window(&self) -> &Window {
        &self.window
    }

    pub const fn capabilities(&self) -> MetalWindowSurfaceCapabilities {
        MetalWindowSurfaceCapabilities {
            native_surface: true,
            renderer: if self.gpu_surface_attached {
                "skia-gpu-metal"
            } else {
                "skia-raster"
            },
            gpu_surface: self.gpu_surface_attached,
        }
    }

    pub const fn has_native_surface(&self) -> bool {
        true
    }

    pub const fn has_gpu_surface(&self) -> bool {
        self.gpu_surface_attached
    }

    pub fn surface_size(&self) -> PhysicalSize<u32> {
        self.surface_size
    }

    /// Attach this presenter's device and queue to the loaded runtime session.
    /// A context attachment alone does not set `gpu_surface`; that bit changes
    /// only after [`Self::present_runtime`] successfully wraps a drawable.
    pub fn attach_runtime(&self, host: &mut DesktopHost) -> Result<(), MetalWindowPresenterError> {
        self.attach_session(&mut host.session)
    }

    /// Attach an existing shared session without creating another app runtime.
    pub fn attach_session(&self, host: &mut HostSession) -> Result<(), MetalWindowPresenterError> {
        let device = Retained::as_ptr(&self.device) as *const std::ffi::c_void;
        let queue = Retained::as_ptr(&self.command_queue) as *const std::ffi::c_void;
        // SAFETY: the presenter owns both Objective-C objects for at least as
        // long as the runtime context and Skia retains them as well.
        unsafe { host.attach_metal_context(device, queue)? };
        Ok(())
    }

    /// Render the latest committed runtime frame directly into the current
    /// drawable and commit a present command buffer. This is the only method
    /// that turns the runtime's `gpu_surface` capability on.
    pub fn present_runtime(
        &mut self,
        host: &mut DesktopHost,
    ) -> Result<(), MetalWindowPresenterError> {
        self.present_session(&mut host.session)
    }

    /// Present a shared session's retained frame. This never captures CPU pixels.
    pub fn present_session(
        &mut self,
        host: &mut HostSession,
    ) -> Result<(), MetalWindowPresenterError> {
        // A capability bit describes the drawable submitted by the most
        // recent call. Clear it before acquiring a new drawable so a failed
        // frame (or a runtime frame that has not been committed yet) cannot
        // leave stale GPU evidence visible after the previous frame.
        self.gpu_surface_attached = false;
        let drawable = unsafe { self.metal_layer.nextDrawable() }
            .ok_or(MetalWindowPresenterError::DrawableUnavailable)?;
        let drawable_size = unsafe { self.metal_layer.drawableSize() };
        let width = drawable_size.width.round();
        let height = drawable_size.height.round();
        if !width.is_finite() || !height.is_finite() || width < 1.0 || height < 1.0 {
            return Err(MetalWindowPresenterError::InvalidDrawableSize);
        }
        let texture = unsafe { drawable.texture() };
        let texture_ptr = Retained::as_ptr(&texture) as *const std::ffi::c_void;
        // SAFETY: `drawable` and its texture stay alive until this method
        // commits the command buffer; the runtime only borrows the texture for
        // one synchronous Skia recording.
        unsafe {
            host.render_last_frame_to_metal_texture(texture_ptr, width as u32, height as u32)?;
        }
        let command_buffer = self
            .command_queue
            .commandBuffer()
            .ok_or(MetalWindowPresenterError::QueueUnavailable)?;
        let drawable_for_present: Retained<ProtocolObject<dyn MTLDrawable>> =
            ProtocolObject::from_retained(drawable);
        let drawable_ref: &ProtocolObject<dyn MTLDrawable> = &drawable_for_present;
        command_buffer.presentDrawable(drawable_ref);
        command_buffer.commit();
        self.gpu_surface_attached = true;
        Ok(())
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) {
        self.surface_size = size;
        // CAMetalLayer creates a new drawable after resize; the old drawable
        // no longer represents the current surface until present_runtime
        // succeeds again.
        self.gpu_surface_attached = false;
        unsafe {
            self.metal_layer.setDrawableSize(CGSize::new(
                size.width.max(1) as f64,
                size.height.max(1) as f64,
            ));
        }
    }

    pub fn request_redraw(&self) {
        self.window.request_redraw();
    }

    pub fn detach_runtime(
        &mut self,
        host: &mut DesktopHost,
    ) -> Result<(), MetalWindowPresenterError> {
        self.detach_session(&mut host.session)
    }

    pub fn detach_session(
        &mut self,
        host: &mut HostSession,
    ) -> Result<(), MetalWindowPresenterError> {
        host.detach_metal_context()?;
        self.gpu_surface_attached = false;
        Ok(())
    }
}
