//! A host-owned GL window for the existing Skia session on Windows and Linux.
//! No page state, CPU snapshot, or second renderer lives in this presenter.

use container_host_common::{HostSession, HostSessionError};
use glow::HasContext;
use glutin::{
    config::ConfigTemplateBuilder,
    context::{ContextApi, ContextAttributesBuilder, GlProfile, PossiblyCurrentContext, Version},
    display::{Display, DisplayApiPreference, GetGlDisplay},
    prelude::*,
    surface::{Surface, WindowSurface},
};
use glutin_winit::GlWindow;
use std::{ffi::CString, num::NonZeroU32};
use thiserror::Error;
use winit::{
    dpi::{LogicalSize, PhysicalSize},
    event_loop::EventLoop,
    raw_window_handle::{HasDisplayHandle, HasWindowHandle},
    window::{Window, WindowId},
};

#[derive(Debug, Error)]
pub enum GlWindowPresenterError {
    #[error("ERR_RENDER: desktop OpenGL initialization/presentation failed: {0}")]
    Platform(String),
    #[error("ERR_RENDER: a positive drawable size is required")]
    InvalidDrawableSize,
    #[error("ERR_RENDER: hardware OpenGL 3.3 is required; found {0}; select software explicitly")]
    SoftwareDriver(String),
    #[error(transparent)]
    Runtime(#[from] HostSessionError),
}

fn platform(error: impl std::fmt::Display) -> GlWindowPresenterError {
    GlWindowPresenterError::Platform(error.to_string())
}

fn is_software_driver(renderer: &str) -> bool {
    let renderer = renderer.trim().to_ascii_lowercase();
    renderer.is_empty()
        || [
            "llvmpipe",
            "softpipe",
            "swiftshader",
            "software",
            "gdi generic",
        ]
        .iter()
        .any(|name| renderer.contains(name))
}

/// The event-loop thread owns the GL context, drawable and window, in that
/// destruction order. Call `detach_session` before dropping a loaded session
/// or this owner. GL remains current between calls so runtime replacement can
/// also retire its old Skia objects safely on the same thread.
#[derive(Debug)]
pub struct GlWindowPresenter {
    context: PossiblyCurrentContext,
    surface: Surface<WindowSurface>,
    window: Window,
    gl: glow::Context,
    size: PhysicalSize<u32>,
    gpu_surface: bool,
}

impl GlWindowPresenter {
    pub fn new(
        event_loop: &EventLoop<()>,
        title: impl Into<String>,
        width: u32,
        height: u32,
    ) -> Result<Self, GlWindowPresenterError> {
        Self::create(event_loop, title.into(), width, height, true)
    }

    // A software GL driver is permitted only by the in-module integration
    // test. The public constructor always rejects it; no environment flag
    // silently changes a GPU request into a CPU path.
    fn create(
        event_loop: &EventLoop<()>,
        title: String,
        width: u32,
        height: u32,
        require_hardware: bool,
    ) -> Result<Self, GlWindowPresenterError> {
        let attributes = Window::default_attributes()
            .with_title(title)
            .with_inner_size(LogicalSize::new(width.max(1), height.max(1)));
        let template = ConfigTemplateBuilder::new()
            .with_alpha_size(8)
            .with_stencil_size(8);
        // WGL needs a real window before choosing its pixel format; X11
        // needs the chosen visual before creating the window. Keep both
        // sequences explicit and return an error if no config is available.
        #[cfg(target_os = "windows")]
        #[allow(deprecated)]
        let window = event_loop.create_window(attributes).map_err(platform)?;
        #[cfg(target_os = "windows")]
        let preference =
            DisplayApiPreference::Wgl(Some(window.window_handle().map_err(platform)?.as_raw()));
        let raw_display = event_loop.display_handle().map_err(platform)?.as_raw();
        #[cfg(target_os = "linux")]
        let preference = match raw_display {
            winit::raw_window_handle::RawDisplayHandle::Wayland(_) => DisplayApiPreference::Egl,
            _ => DisplayApiPreference::GlxThenEgl(Box::new(
                winit::platform::x11::register_xlib_error_hook,
            )),
        };
        let display = unsafe { Display::new(raw_display, preference) }.map_err(platform)?;
        #[cfg(target_os = "windows")]
        let template = template
            .compatible_with_native_window(window.window_handle().map_err(platform)?.as_raw());
        let config = unsafe { display.find_configs(template.build()) }
            .map_err(platform)?
            .find(|config| config.num_samples() == 0)
            .ok_or_else(|| platform("no RGBA8 window framebuffer configuration"))?;
        #[cfg(target_os = "linux")]
        let window =
            glutin_winit::finalize_window(event_loop, attributes, &config).map_err(platform)?;
        let handle = window.window_handle().map_err(platform)?.as_raw();
        let attributes = ContextAttributesBuilder::new()
            .with_profile(GlProfile::Core)
            .with_context_api(ContextApi::OpenGl(Some(Version::new(3, 3))))
            .build(Some(handle));
        // SAFETY: config and handle belong to this live display/window, which
        // outlive the context and surface below.
        let context = unsafe { display.create_context(&config, &attributes) }.map_err(platform)?;
        let attributes = window
            .build_surface_attributes(Default::default())
            .map_err(platform)?;
        let surface =
            unsafe { display.create_window_surface(&config, &attributes) }.map_err(platform)?;
        let context = context.make_current(&surface).map_err(platform)?;
        // WGL symbol lookup requires the new context to be current first.
        let gl = unsafe {
            glow::Context::from_loader_function(|name| {
                let name = CString::new(name).expect("GL symbol names contain no NUL");
                display.get_proc_address(&name)
            })
        };
        let renderer = unsafe { gl.get_parameter_string(glow::RENDERER) };
        if require_hardware && is_software_driver(&renderer) {
            context.make_not_current_in_place().map_err(platform)?;
            return Err(GlWindowPresenterError::SoftwareDriver(renderer));
        }
        let size = window.inner_size();
        Ok(Self {
            context,
            surface,
            window,
            gl,
            size,
            gpu_surface: false,
        })
    }

    pub fn window_id(&self) -> WindowId {
        self.window.id()
    }

    pub fn window(&self) -> &Window {
        &self.window
    }

    pub fn surface_size(&self) -> PhysicalSize<u32> {
        self.size
    }

    /// This is evidence of a submitted GL frame, not physical GPU completion.
    pub fn has_gpu_surface(&self) -> bool {
        self.gpu_surface
    }

    pub fn resize(&mut self, size: PhysicalSize<u32>) -> Result<(), GlWindowPresenterError> {
        self.gpu_surface = false;
        self.size = size;
        // Minimized windows can have no drawable. Do not replace their size
        // with 1x1 and accidentally grant input/presentation authority.
        if let (Some(width), Some(height)) =
            (NonZeroU32::new(size.width), NonZeroU32::new(size.height))
        {
            self.context.make_current(&self.surface).map_err(platform)?;
            self.surface.resize(&self.context, width, height);
        }
        Ok(())
    }

    pub fn request_redraw(&self) {
        self.window.request_redraw();
    }

    /// Reattach after hot reload by inspecting the actual session renderer.
    /// A cached session id cannot establish that a GL attachment still exists.
    pub fn present_session(
        &mut self,
        host: &mut HostSession,
    ) -> Result<(), GlWindowPresenterError> {
        self.draw_session(host)?;
        self.window.pre_present_notify();
        self.surface.swap_buffers(&self.context).map_err(platform)?;
        self.gpu_surface = true;
        Ok(())
    }

    fn draw_session(&mut self, host: &mut HostSession) -> Result<(), GlWindowPresenterError> {
        self.gpu_surface = false;
        if self.size.width == 0 || self.size.height == 0 {
            return Err(GlWindowPresenterError::InvalidDrawableSize);
        }
        self.context.make_current(&self.surface).map_err(platform)?;
        if !host.has_gles_context()? {
            let display = self.context.display();
            host.attach_gl_context_with(|name| {
                let Ok(name) = CString::new(name) else {
                    return std::ptr::null();
                };
                display.get_proc_address(&name)
            })?;
        }
        // Skia owns the draw commands; this owner supplies only its window's
        // default framebuffer and swap. No render_snapshot/readback is used.
        unsafe { self.gl.bind_framebuffer(glow::FRAMEBUFFER, None) };
        host.render_last_frame_to_gles_framebuffer(0, self.size.width, self.size.height)?;
        Ok(())
    }

    /// Drain submitted work while the context is still valid. If it was lost,
    /// abandon Skia handles without making GL calls, and report the failure.
    pub fn detach_session(&mut self, host: &mut HostSession) -> Result<(), GlWindowPresenterError> {
        self.gpu_surface = false;
        if let Err(error) = self.context.make_current(&self.surface) {
            host.abandon_gles_context()?;
            return Err(platform(error));
        }
        if host.has_session() {
            unsafe { self.gl.finish() };
            host.detach_gles_context()?;
        }
        Ok(())
    }
}

impl Drop for GlWindowPresenter {
    fn drop(&mut self) {
        // detach_session has already retired Skia. Unbind before destroying
        // the native context so GLX/WGL cannot defer its deletion indefinitely.
        let _ = self.context.make_not_current_in_place();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gpu_requests_reject_known_cpu_gl_drivers() {
        for name in [
            "",
            " llvmpipe (LLVM 18)",
            "softpipe",
            "SwiftShader",
            "Software Rasterizer",
            "GDI Generic",
        ] {
            assert!(is_software_driver(name), "{name}");
        }
        for name in [
            "AMD Radeon RX 6600",
            "Mesa Intel(R) UHD Graphics 620",
            "NVIDIA GeForce RTX 3060",
        ] {
            assert!(!is_software_driver(name), "{name}");
        }
    }

    /// Run under Xvfb/Mesa with `--ignored --test-threads=1`. A real GL
    /// drawable is exercised, but this deliberately grants no hardware claim.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an X11 display and an OpenGL 3.3 driver"]
    #[allow(deprecated)]
    fn x11_gl_drawable_renders_resizes_reloads_and_detaches() {
        use container_bridge::{op, BridgeEnvelope};
        use container_ir::{AppInfo, CompilerInfo, ContainerManifestV1, Integrity};
        use container_render_skia::PageRenderMode;
        use container_runtime::SessionConfig;
        use serde_json::json;
        use std::time::{Duration, Instant};
        use winit::platform::{pump_events::EventLoopExtPumpEvents, x11::EventLoopBuilderExtX11};

        let mut event_loop = EventLoop::builder()
            .with_x11()
            .with_any_thread(true)
            .build()
            .unwrap();
        let mut presenter = GlWindowPresenter::create(
            &event_loop,
            "Weapp Container GL integration test".into(),
            8,
            4,
            false,
        )
        .unwrap();
        assert!(!presenter.has_gpu_surface());
        let renderer = unsafe { presenter.gl.get_parameter_string(glow::RENDERER) };
        eprintln!("GL integration driver: {renderer} (hardware acceptance: not evaluated)");
        if is_software_driver(&renderer) {
            assert!(matches!(
                GlWindowPresenter::new(&event_loop, "GPU policy test", 8, 4),
                Err(GlWindowPresenterError::SoftwareDriver(_))
            ));
        }
        event_loop.pump_events(Some(Duration::from_millis(50)), |_, _| {});

        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "gl-window-test".into(),
                platform: "weapp".into(),
            },
            app: AppInfo {
                app_json: "app.json".into(),
                entry_module: "app.js".into(),
            },
            integrity: Integrity {
                algorithm: "sha256".into(),
                root: String::new(),
            },
            ..Default::default()
        };
        let manifest = serde_json::to_vec(&manifest).unwrap();
        let mut host = HostSession::empty();
        let load = |host: &mut HostSession, id: &str, red: u8| {
            host.load_manifest_json(
                &manifest,
                SessionConfig {
                    session_id: id.into(),
                    page_render_mode: PageRenderMode::NativeGpu,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(!host.has_gles_context().unwrap());
            // Passive attachment queries must preserve lazy renderer creation.
            assert!(!host.page_render_status().unwrap().page_object_initialized);
            host.start("init").unwrap();
            let batch = host.dispatch(BridgeEnvelope::request(id, "frame", op::RENDER_COMMIT,
                json!({"frame": {
                    "frameId": 1,
                    "viewport": {"x": 0.0, "y": 0.0, "width": 8.0, "height": 4.0},
                    "root": {
                        "id": "root", "bounds": {"x": 0.0, "y": 0.0, "width": 8.0, "height": 4.0},
                        "background": {"red": red, "green": 19, "blue": 29, "alpha": 255},
                        "opacity": 1.0, "children": []
                    }
                }}))).unwrap();
            assert!(
                !batch.messages.iter().any(|message| message.op == op::ERROR),
                "{batch:?}"
            );
        };
        let drawn_pixel = |presenter: &mut GlWindowPresenter, host: &mut HostSession| {
            presenter.draw_session(host).unwrap();
            let mut pixel = [0_u8; 4];
            unsafe {
                // Verify the actual window framebuffer before swap. Front
                // buffer readback after swap is not portable across GLX
                // compositors/drivers and does not establish screen scanout.
                presenter.gl.read_buffer(glow::BACK);
                presenter.gl.read_pixels(
                    0,
                    0,
                    1,
                    1,
                    glow::RGBA,
                    glow::UNSIGNED_BYTE,
                    glow::PixelPackData::Slice(Some(&mut pixel)),
                );
                assert_eq!(presenter.gl.get_error(), glow::NO_ERROR);
            }
            pixel
        };
        load(&mut host, "first", 9);
        assert_eq!(drawn_pixel(&mut presenter, &mut host), [9, 19, 29, 255]);
        assert!(!presenter.has_gpu_surface());
        presenter.present_session(&mut host).unwrap();
        assert!(host.has_gles_context().unwrap());
        assert!(host.has_gpu_surface().unwrap());
        assert!(presenter.has_gpu_surface());

        presenter.resize(PhysicalSize::new(0, 0)).unwrap();
        assert!(!presenter.has_gpu_surface());
        assert!(matches!(
            presenter.present_session(&mut host),
            Err(GlWindowPresenterError::InvalidDrawableSize)
        ));
        let size = PhysicalSize::new(12, 6);
        let _ = presenter.window().request_inner_size(size);
        let deadline = Instant::now() + Duration::from_secs(3);
        while presenter.window().inner_size() != size && Instant::now() < deadline {
            event_loop.pump_events(Some(Duration::from_millis(10)), |_, _| {});
        }
        assert_eq!(presenter.window().inner_size(), size);
        presenter.resize(size).unwrap();
        assert_eq!(drawn_pixel(&mut presenter, &mut host), [9, 19, 29, 255]);
        presenter.present_session(&mut host).unwrap();

        // Replacing a runtime drops its Skia context while the window's GL
        // context remains current. The new renderer must attach independently.
        load(&mut host, "replacement", 47);
        assert_eq!(drawn_pixel(&mut presenter, &mut host), [47, 19, 29, 255]);
        presenter.present_session(&mut host).unwrap();
        presenter.detach_session(&mut host).unwrap();
        assert!(!host.has_gles_context().unwrap());
        assert!(!presenter.has_gpu_surface());
        presenter.detach_session(&mut host).unwrap();
        drop(host);
        drop(presenter);
        event_loop.pump_events(Some(Duration::ZERO), |_, _| {});
    }
}
