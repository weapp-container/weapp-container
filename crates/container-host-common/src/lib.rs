//! Shared host-side session boundary.
//!
//! Native and browser hosts receive bridge messages through different FFI
//! mechanisms, but they must all enforce the same manifest validation,
//! protocol negotiation and batch semantics.  This crate keeps that policy in
//! one place.  The JSON methods are deliberately batch oriented so JNI,
//! Swift/Objective-C, ArkTS and WASM bindings can exchange one serialized
//! envelope without crossing the FFI boundary once per node or event.

use container_bridge::{op, BridgeBatch, BridgeEnvelope, BridgeError};
use container_core::LifecycleState;
use container_ir::{BrowserGeometryBatch, PresentationKey, ViewDocument};
#[cfg(test)]
use container_render_skia::Renderer;
use container_render_skia::{Rect, RenderError, RenderSnapshot, RenderTargetSize, SkiaRenderer};
use container_runtime::{
    AcceptedPageObservation, HostWindowMetrics, NetworkType, PageRenderStatus, Session,
    SessionConfig, SessionError,
};
use serde_json::json;
#[cfg(all(
    feature = "skia-gpu-metal",
    any(target_os = "macos", target_os = "ios")
))]
use std::ffi::c_void;
use std::marker::PhantomData;
use thiserror::Error;

/// A byte buffer returned across one of the native host FFI boundaries.
///
/// The allocation is owned by the caller after a successful operation and
/// must be released with the matching host's `*_buffer_free` function.  A
/// pointer/length pair keeps the C ABI stable for JNI, Swift/Objective-C and
/// ArkTS/N-API without exposing Rust's `Vec` layout.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct FfiBuffer {
    pub data: *mut u8,
    pub len: usize,
}

impl FfiBuffer {
    pub const fn empty() -> Self {
        Self {
            data: std::ptr::null_mut(),
            len: 0,
        }
    }
}

/// Native bindings use negative values for transport/argument failures and
/// zero for a successfully completed operation.  Runtime details are carried
/// in the returned JSON batch where the operation has an output buffer.
pub const FFI_OK: i32 = 0;
pub const FFI_ERR: i32 = -1;
pub const FFI_INVALID_ARGUMENT: i32 = -2;

/// Borrow a byte slice supplied by a C-family caller.
///
/// A null pointer is accepted only for an empty slice.  This is deliberately
/// kept in the common crate so every platform applies the same pointer rules.
///
/// # Safety
///
/// For a non-empty slice, `data` must point to `len` readable bytes that stay
/// valid for the returned borrow's lifetime.
pub unsafe fn ffi_input<'a>(data: *const u8, len: usize) -> Result<&'a [u8], i32> {
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() {
        return Err(FFI_INVALID_ARGUMENT);
    }
    // SAFETY: the caller promises that `data` points to `len` readable bytes;
    // null and zero-length inputs are checked above.
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

/// Move an owned byte vector into an FFI buffer using a boxed slice.
///
/// # Safety
///
/// `output` must be a valid, writable pointer to an [`FfiBuffer`] owned by the
/// caller for the duration of this call.
pub unsafe fn ffi_write(output: *mut FfiBuffer, bytes: Vec<u8>) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // Refuse to overwrite a live allocation.  Native callers must release a
    // previous result before reusing the output slot; silently replacing it
    // would leak across JNI/Swift/N-API boundaries and could corrupt the
    // allocator when the stale pointer is eventually released.
    if unsafe { !(*output).data.is_null() || (*output).len != 0 } {
        return FFI_INVALID_ARGUMENT;
    }
    let boxed = bytes.into_boxed_slice();
    // SAFETY: `output` was checked for null and is exclusively owned by the
    // caller for the duration of this operation.
    unsafe {
        if boxed.is_empty() {
            (*output).data = std::ptr::null_mut();
            (*output).len = 0;
        } else {
            (*output).len = boxed.len();
            (*output).data = Box::into_raw(boxed) as *mut u8;
        }
    }
    FFI_OK
}

/// Write a small, structured error payload while returning `FFI_ERR`.
///
/// # Safety
///
/// `output` follows the same requirements as [`ffi_write`].
pub unsafe fn ffi_write_error(output: *mut FfiBuffer, error: impl std::fmt::Display) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if unsafe { !(*output).data.is_null() || (*output).len != 0 } {
        return FFI_INVALID_ARGUMENT;
    }
    let payload = serde_json::json!({
        "ok": false,
        "error": error.to_string(),
    });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{\"ok\":false}".to_vec());
    let _ = unsafe { ffi_write(output, bytes) };
    FFI_ERR
}

/// Free a buffer previously returned by [`ffi_write`].
///
/// # Safety
///
/// `buffer` must be null or point to a buffer previously initialized by
/// [`ffi_write`] and not already released.
pub unsafe fn ffi_buffer_free(buffer: *mut FfiBuffer) {
    if buffer.is_null() {
        return;
    }
    // SAFETY: the pointer and length were produced by `ffi_write`; converting
    // the allocation back into a boxed slice runs its allocator exactly once.
    unsafe {
        let data = (*buffer).data;
        let len = (*buffer).len;
        if !data.is_null() {
            let slice = std::ptr::slice_from_raw_parts_mut(data, len);
            drop(Box::from_raw(slice));
        }
        (*buffer) = FfiBuffer::empty();
    }
}

#[derive(Debug, Error)]
pub enum HostSessionError {
    #[error("host session has no loaded manifest")]
    NotLoaded,
    #[error("host session has no committed render frame")]
    NoRenderFrame,
    #[error("session construction failed: {0}")]
    Session(#[from] SessionError),
    #[error("bridge envelope JSON is invalid: {0}")]
    EnvelopeJson(#[from] serde_json::Error),
    #[error("bridge batch is invalid: {0}")]
    BridgeBatch(#[from] BridgeError),
    #[error("host renderer initialization failed: {0}")]
    Render(#[from] RenderError),
}

/// A host-owned runtime handle.
///
/// `Session` remains the sole owner of AppService, View and Renderer state;
/// this wrapper only owns its lifecycle and translates the stable JSON bridge
/// representation used by platform bindings.  It is intentionally not
/// `Send`/`Sync` by adding a marker, because JavaScript engines and renderers
/// are thread-affine unless a host explicitly supplies a proxy.
#[derive(Debug, Default)]
pub struct HostSession {
    session: Option<Session>,
    _thread_affinity: PhantomData<*mut ()>,
}

impl HostSession {
    pub const fn empty() -> Self {
        Self {
            session: None,
            _thread_affinity: PhantomData,
        }
    }

    pub fn from_manifest_json(
        bytes: impl AsRef<[u8]>,
        config: SessionConfig,
    ) -> Result<Self, HostSessionError> {
        let session = Session::from_manifest_json(bytes, config)?;
        session.ensure_view_execution_supported()?;
        Ok(Self {
            session: Some(session),
            _thread_affinity: PhantomData,
        })
    }

    pub fn load_manifest_json(
        &mut self,
        bytes: impl AsRef<[u8]>,
        config: SessionConfig,
    ) -> Result<(), HostSessionError> {
        let next = Self::from_manifest_json(bytes, config)?;
        self.session = next.session;
        Ok(())
    }

    /// Prepare host rendering resources before publishing a replacement
    /// session. Font decoding or another renderer initialization failure must
    /// preserve the currently running app, just as manifest rejection does.
    /// The callback runs after manifest/engine validation and before app JS.
    pub fn load_manifest_json_with_renderer(
        &mut self,
        bytes: impl AsRef<[u8]>,
        config: SessionConfig,
        initialize_renderer: impl FnOnce(&mut SkiaRenderer) -> Result<(), RenderError>,
    ) -> Result<(), HostSessionError> {
        // Construct before replacing the current session.  A malformed reload
        // must not tear down a running app or leave the host half initialized.
        let mut next = Session::from_manifest_json(bytes, config)?;
        next.ensure_view_execution_supported()?;
        initialize_renderer(next.renderer_mut())?;
        self.session = Some(next);
        Ok(())
    }

    /// Replace only manifest metadata on a live session. Runtime state is
    /// retained, but presentation resources and the accepted frame are
    /// invalidated. Use `replace_dev_presentation` for atomic development
    /// updates, or construct a fresh session for module/configuration changes.
    pub fn replace_manifest_json(
        &mut self,
        bytes: impl AsRef<[u8]>,
    ) -> Result<(), HostSessionError> {
        let manifest: container_ir::ContainerManifestV1 = serde_json::from_slice(bytes.as_ref())?;
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .replace_manifest(manifest)?;
        Ok(())
    }

    /// Atomically accept an isolated Skia development candidate while keeping
    /// the live application and its JavaScript instances.
    pub fn replace_dev_presentation(
        &mut self,
        candidate: &mut HostSession,
        payload: &serde_json::Value,
    ) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .replace_dev_presentation(
                candidate
                    .session
                    .as_mut()
                    .ok_or(HostSessionError::NotLoaded)?,
                payload,
            )?)
    }

    pub fn replace_dev_presentation_request(
        &mut self,
        candidate: &mut HostSession,
        request: &BridgeEnvelope,
    ) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .replace_dev_presentation_request(
                candidate
                    .session
                    .as_mut()
                    .ok_or(HostSessionError::NotLoaded)?,
                request,
            )?)
    }

    /// Browser presentation reload with resource preflight and owner-thread
    /// contact retirement. Candidate evaluation performs no native layout.
    pub fn replace_browser_dev_presentation(
        &mut self,
        candidate: &mut HostSession,
        payload: &serde_json::Value,
    ) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .replace_browser_dev_presentation(
                candidate
                    .session
                    .as_mut()
                    .ok_or(HostSessionError::NotLoaded)?,
                payload,
            )?)
    }

    pub fn retire_browser_preview(
        &mut self,
        reason: &str,
    ) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .retire_browser_preview(reason)?)
    }

    /// Retire both native/software and browser preview input on the original
    /// runtime owner. This explicit API does not change the legacy browser API.
    pub fn retire_dev_preview(&mut self, reason: &str) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .retire_dev_preview(reason)?)
    }

    /// Retire presentation/input without replacing the original runtime owner.
    /// The returned batch includes actual contact-cancellation effects.
    pub fn retire_page_presenter(&mut self, reason: &str) -> Result<BridgeBatch, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .retire_page_presenter(reason)?)
    }

    pub fn unload(&mut self) {
        self.session = None;
    }

    pub fn has_session(&self) -> bool {
        self.session.is_some()
    }

    pub fn initialized(&self) -> bool {
        self.session.as_ref().is_some_and(Session::initialized)
    }

    /// Return the runtime lifecycle state observed by the host event loop.
    /// This is separate from [`Self::initialized`], which only means that a
    /// manifest and runtime have been loaded; a loaded session remains in
    /// `Created` until the host dispatches the launch transition.
    pub fn lifecycle_state(&self) -> Result<LifecycleState, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .app_service()
            .lifecycle()
            .state())
    }

    /// Monotonic lifecycle sequence useful for host diagnostics and parity
    /// traces. It increments only when the core accepts a transition.
    pub fn lifecycle_sequence(&self) -> Result<u64, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .app_service()
            .lifecycle()
            .sequence())
    }

    pub fn session(&self) -> Option<&Session> {
        self.session.as_ref()
    }

    pub fn session_mut(&mut self) -> Option<&mut Session> {
        self.session.as_mut()
    }

    /// Borrow the last accepted evaluated document on the runtime owner
    /// thread. A new browser candidate is returned by `view.prepare` through
    /// [`Self::dispatch`]; it is not accepted until `view.presented` succeeds.
    /// The previous document can remain available for diagnostics after its
    /// input authority is revoked; check [`Self::is_browser_view_presented`]
    /// before treating it as an active browser presentation.
    pub fn view_document(&self) -> Result<Option<&ViewDocument>, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .view_document())
    }

    /// Whether the current browser presentation owns input authority. This
    /// does not infer presentation from an older Skia frame or retained DOM
    /// document; pending, retired and suspended browser states return false.
    pub fn is_browser_view_presented(&self) -> Result<bool, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .is_browser_view_presented())
    }

    /// Whether a transport's prepared document still belongs to the runtime.
    /// Publishing a newer request is independent of accepting an issued permit.
    pub fn is_browser_view_pending(&self, key: &PresentationKey) -> Result<bool, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .is_browser_view_pending(key))
    }

    /// Borrow geometry reported by the active browser presentation. Geometry
    /// updates must enter through `view.geometry` in [`Self::dispatch`] so
    /// they share session, protocol, cancellation and deadline validation.
    pub fn browser_geometry(&self) -> Result<Option<&BrowserGeometryBatch>, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .browser_geometry())
    }

    /// Borrow a declared asset authorized by a current browser candidate or
    /// accepted presentation. The full presentation identity and content
    /// digest are checked by the sole runtime owner before exposing bytes.
    /// This accessor is independent of any HTTP server or browser transport.
    pub fn browser_view_resource(
        &self,
        key: &PresentationKey,
        sha256: &str,
    ) -> Result<&[u8], HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .browser_view_resource(key, sha256)?)
    }

    pub fn browser_view_resource_at_path(
        &self,
        key: &PresentationKey,
        sha256: &str,
        path: &str,
    ) -> Result<Vec<u8>, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .browser_view_resource_at_path(key, sha256, path)?)
    }

    /// Return the last committed frame as one portable RGBA snapshot.  The
    /// renderer remains owned by the session; this read-only view lets each
    /// host upload a complete frame to CanvasKit, a native window, or a mobile
    /// surface without introducing a per-node FFI call path.
    pub fn render_snapshot(&self) -> Result<RenderSnapshot, HostSessionError> {
        self.session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .render_snapshot()
            .ok_or(HostSessionError::NoRenderFrame)
    }

    /// Borrow accepted page facts without initializing a page renderer or
    /// deriving current-route, input or ready authority from a retained frame.
    pub fn accepted_page_observation(
        &self,
    ) -> Result<Option<AcceptedPageObservation<'_>>, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .accepted_page_observation())
    }

    /// Passive allocation/backend state, separate from presentation receipts.
    pub fn page_render_status(&self) -> Result<PageRenderStatus, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .page_render_status())
    }

    /// Target pinned to an exact accepted Skia revision, not staged density.
    pub fn render_target_for_revision(
        &self,
        revision: u64,
    ) -> Result<RenderTargetSize, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .render_target_for_revision(revision)?)
    }

    /// Capture CPU diagnostics explicitly when a GPU-only page owns no raster
    /// pixels. This does not read the host drawable or confirm GPU presentation.
    pub fn capture_render_snapshot(&mut self) -> Result<RenderSnapshot, HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .capture_render_snapshot()?
            .ok_or(HostSessionError::NoRenderFrame)
    }

    /// Borrow the immutable accepted frame on the runtime thread. A Web
    /// publisher can cache it once per frame instead of cloning on every poll.
    pub fn render_snapshot_ref(&self) -> Result<&RenderSnapshot, HostSessionError> {
        self.accepted_page_observation()?
            .and_then(|observation| observation.snapshot)
            .ok_or(HostSessionError::NoRenderFrame)
    }

    /// Monotonic accepted page presentation identity, separate from app
    /// frameId (which can be retained by scrolling and density repaint).
    /// An unloaded host has no accepted presentation and reports zero.
    pub fn render_revision(&self) -> u64 {
        self.session
            .as_ref()
            .map(Session::render_revision)
            .unwrap_or(0)
    }

    /// Forward the host presentation receipt to the owning runtime thread.
    /// Any effects from ready/observer callbacks are returned as one batch.
    pub fn acknowledge_presentation_json(
        &mut self,
        revision: u64,
    ) -> Result<Vec<u8>, HostSessionError> {
        let batch = self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .acknowledge_presentation(revision)?;
        Ok(serde_json::to_vec(&batch)?)
    }

    /// Raster preparation/draw/readback duration for the accepted frame.
    pub fn render_duration_ms(&self) -> Result<f64, HostSessionError> {
        Ok(self.page_render_status()?.last_render_ms)
    }

    /// Pure backend-aware validation; never constructs a page renderer.
    pub fn validate_skia_render_target(
        &self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .validate_skia_render_target(viewport, scale)?)
    }

    /// Stage the next explicit Skia target without accepting a frame or
    /// retiring browser presentation/input authority.
    pub fn stage_skia_render_target(
        &mut self,
        viewport: Rect,
        scale: f64,
    ) -> Result<RenderTargetSize, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .stage_skia_render_target(viewport, scale)?)
    }

    /// Repaint only the visible page's Session-owned Skia scene. No scene is
    /// initialized or republished when this returns `None`.
    pub fn repaint_current_skia_page(
        &mut self,
        scale: f64,
    ) -> Result<Option<u64>, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .repaint_current_skia_page(scale)?)
    }

    /// Prepare retained density pixels without accepting a new runtime frame.
    /// Keep this guard alive until all transport preparation succeeds.
    pub fn prepare_dev_density(
        &mut self,
        scale: f64,
    ) -> Result<Option<container_runtime::PreparedDevDensity<'_>>, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .prepare_dev_density(scale)?)
    }

    /// Change only physical page raster density; application/device geometry
    /// and the AppService/View state remain untouched.
    pub fn set_render_scale(&mut self, scale: f64) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .set_render_scale(scale)?;
        Ok(())
    }

    /// Republish retained external layout without entering a JS/View turn.
    /// Exact native identity and counter validation precede all mutation.
    pub fn recover_external_frame(
        &mut self,
        expected: &container_runtime::ExternalFrameRecoveryExpected,
    ) -> Result<container_runtime::ExternalFrameRecovery, HostSessionError> {
        Ok(self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .recover_external_frame(expected)?)
    }

    /// Return the id of the root node in the last committed frame. Native
    /// keyboard and accessibility events have no pointer coordinates to hit
    /// test, so host adapters can route them to this focused root in the same
    /// capture/target/bubble event contract as pointer input.
    pub fn render_root_id(&self) -> Result<String, HostSessionError> {
        self.accepted_page_observation()?
            .map(|observation| observation.frame.root.id.clone())
            .ok_or(HostSessionError::NoRenderFrame)
    }

    /// Name of the renderer selected by this build. Host diagnostics expose
    /// this beside the pixel snapshot so a CPU raster surface can never be
    /// mistaken for an attached GPU surface.
    pub fn renderer_backend(&self) -> Result<&'static str, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .renderer_backend())
    }

    /// Whether the session has committed a frame into a Skia raster surface.
    /// This is intentionally separate from [`Self::renderer_backend`], which
    /// reports the compiled backend even before the first frame is submitted.
    pub fn has_native_surface(&self) -> Result<bool, HostSessionError> {
        Ok(self.page_render_status()?.native_surface)
    }

    /// Whether the renderer has a host-owned GPU context attached for the
    /// latest frame.  A compiled Skia raster backend intentionally returns
    /// `false`; host/device gates must check this separately from the fact
    /// that a CPU raster surface produced readable pixels.
    pub fn has_gpu_surface(&self) -> Result<bool, HostSessionError> {
        Ok(self.page_render_status()?.gpu_surface)
    }

    /// Inspect context attachment without creating page or GPU resources.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn has_metal_context(&self) -> Result<bool, HostSessionError> {
        Ok(self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .has_metal_context())
    }

    /// Attach a host-owned Metal device and command queue to the runtime
    /// renderer. This API is compiled only for the explicit host Metal
    /// feature on macOS/iOS and never changes the default software/raster path.
    ///
    /// # Safety
    ///
    /// The handles must point to live retained MTLDevice and MTLCommandQueue
    /// objects from the same Metal device.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn attach_metal_context(
        &mut self,
        device: *const c_void,
        queue: *const c_void,
    ) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .attach_metal_context(device, queue)
            .map_err(HostSessionError::Session)
    }

    /// Render the latest committed frame to a host-owned Metal drawable
    /// texture. The host presents/commits that drawable after this call.
    ///
    /// # Safety
    ///
    /// `texture` must point to a live MTLTexture from the current drawable and
    /// remain alive until the host commits its command buffer.
    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub unsafe fn render_last_frame_to_metal_texture(
        &mut self,
        texture: *const c_void,
        width: u32,
        height: u32,
    ) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .render_last_frame_to_metal_texture(texture, width, height)
            .map_err(HostSessionError::Session)
    }

    /// Attach the current OpenGL ES context to the loaded runtime session.
    /// The caller owns the EGL context and must keep this host thread-affine.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn attach_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .attach_gles_context()
            .map_err(HostSessionError::Session)
    }

    /// Render the last committed frame to the currently bound GLES
    /// framebuffer. The caller remains responsible for `eglSwapBuffers`.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn render_last_frame_to_gles_framebuffer(
        &mut self,
        framebuffer: u32,
        width: u32,
        height: u32,
    ) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .render_last_frame_to_gles_framebuffer(framebuffer, width, height)
            .map_err(HostSessionError::Session)
    }

    #[cfg(feature = "skia-gpu-gles")]
    pub fn detach_gles_context(&mut self) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .detach_gles_context();
        Ok(())
    }

    /// Abandon GPU handles when the host cannot make its former GL context
    /// current. This is idempotent even before a manifest has loaded.
    #[cfg(feature = "skia-gpu-gles")]
    pub fn abandon_gles_context(&mut self) -> Result<(), HostSessionError> {
        if let Some(session) = self.session.as_mut() {
            session.abandon_gles_context();
        }
        Ok(())
    }

    #[cfg(all(
        feature = "skia-gpu-metal",
        any(target_os = "macos", target_os = "ios")
    ))]
    pub fn detach_metal_context(&mut self) -> Result<(), HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .detach_metal_context();
        Ok(())
    }

    /// Serialize one complete snapshot for C-family and WASM bindings.
    pub fn render_snapshot_json(&self) -> Result<Vec<u8>, HostSessionError> {
        let snapshot = self.render_snapshot()?;
        Ok(serde_json::to_vec(&snapshot).expect("RenderSnapshot is serializable"))
    }

    /// Return one independent Canvas 2D surface snapshot by id. Canvas draw
    /// batches do not replace the page `render_snapshot`; a host presents this
    /// buffer in the canvas layer associated with `canvas_id`.
    pub fn canvas_snapshot(&self, canvas_id: &str) -> Result<RenderSnapshot, HostSessionError> {
        self.session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .canvas_snapshot(canvas_id)
            .ok_or(HostSessionError::NoRenderFrame)
    }

    pub fn canvas_snapshot_json(&self, canvas_id: &str) -> Result<Vec<u8>, HostSessionError> {
        let snapshot = self.canvas_snapshot(canvas_id)?;
        Ok(serde_json::to_vec(&snapshot).expect("RenderSnapshot is serializable"))
    }

    /// Run one bridge operation on the session owner thread. Browser
    /// `view.*` mutations use this same path as AppService operations, so
    /// no transport can bypass session/deadline/cancellation checks, storage
    /// synchronization or failure-path effect draining.
    pub fn dispatch(&mut self, envelope: BridgeEnvelope) -> Result<BridgeBatch, HostSessionError> {
        let session = self.session.as_mut().ok_or(HostSessionError::NotLoaded)?;
        Ok(session.dispatch(envelope))
    }

    /// Dispatch a complete bridge batch after validating every envelope.
    ///
    /// Envelope validation happens before the first message enters the
    /// runtime. This matters for native callers: a cross-message violation
    /// (for example, a second session id) must not leave an app half-
    /// initialized after the first message has already mutated the page
    /// stack. Operation payload validation remains a runtime concern; the
    /// runtime still returns one response envelope per input envelope, while
    /// this host boundary owns the cross-message invariants.
    pub fn dispatch_batch(&mut self, batch: BridgeBatch) -> Result<BridgeBatch, HostSessionError> {
        batch.validate()?;
        let session = self.session.as_mut().ok_or(HostSessionError::NotLoaded)?;
        Ok(session.dispatch_batch(batch))
    }

    /// Poll all timers that are due at `now_ns` and return their bridge event
    /// batch.  Hosts own the clock and call this from their event loop; the
    /// runtime never starts a timer thread.  An unloaded host returns the same
    /// lifecycle error as [`Self::dispatch`].
    pub fn poll_timers(&mut self, now_ns: u64) -> Result<BridgeBatch, HostSessionError> {
        let session = self.session.as_mut().ok_or(HostSessionError::NotLoaded)?;
        Ok(session.poll_timers(now_ns))
    }

    /// Deliver one typed host network transition to the loaded runtime. The
    /// session updates its provider snapshot and invokes all registered
    /// `wx.onNetworkStatusChange` callbacks in one bridge batch.
    pub fn notify_network_status_change(
        &mut self,
        network_type: NetworkType,
    ) -> Result<BridgeBatch, HostSessionError> {
        self.session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .notify_network_status_change(network_type)
            .map_err(HostSessionError::BridgeBatch)
    }

    /// JSON counterpart for JNI, Swift/Objective-C, ArkTS and WASM hosts.
    pub fn notify_network_status_change_json(
        &mut self,
        network_type: NetworkType,
    ) -> Result<Vec<u8>, HostSessionError> {
        let batch = self.notify_network_status_change(network_type)?;
        Ok(serde_json::to_vec(&batch).expect("BridgeBatch is serializable"))
    }

    /// Update the live provider geometry and page/component resize callbacks
    /// in one host boundary crossing; presentation remains the host's job.
    pub fn notify_viewport_resize_json(
        &mut self,
        width: u32,
        height: u32,
    ) -> Result<Vec<u8>, HostSessionError> {
        let batch = self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .notify_viewport_resize(width, height)?;
        Ok(serde_json::to_vec(&batch).expect("BridgeBatch is serializable"))
    }

    /// One complete, validated host observation. Decode before borrowing the
    /// loaded session so malformed input cannot partially update its provider.
    pub fn notify_window_metrics_json(
        &mut self,
        input: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        let metrics: HostWindowMetrics = serde_json::from_slice(input.as_ref())?;
        metrics.validate()?;
        let batch = self
            .session
            .as_mut()
            .ok_or(HostSessionError::NotLoaded)?
            .notify_window_metrics(metrics)?;
        Ok(serde_json::to_vec(&batch).expect("BridgeBatch is serializable"))
    }

    /// Send the mandatory `app.init` handshake using the loaded session id.
    pub fn start(
        &mut self,
        request_id: impl Into<String>,
    ) -> Result<BridgeBatch, HostSessionError> {
        let session_id = self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .config()
            .session_id
            .clone();
        self.dispatch(BridgeEnvelope::request(
            session_id,
            request_id,
            op::APP_INIT,
            json!({}),
        ))
    }

    /// Dispatch one lifecycle transition without exposing session internals to
    /// a platform binding.  The core state machine still validates ordering.
    pub fn lifecycle(
        &mut self,
        request_id: impl Into<String>,
        event: impl Into<String>,
    ) -> Result<BridgeBatch, HostSessionError> {
        let session_id = self
            .session
            .as_ref()
            .ok_or(HostSessionError::NotLoaded)?
            .config()
            .session_id
            .clone();
        self.dispatch(BridgeEnvelope::request(
            session_id,
            request_id,
            op::APP_LIFECYCLE,
            json!({"event": event.into()}),
        ))
    }

    /// Decode one envelope and encode the complete response batch.
    pub fn dispatch_json(
        &mut self,
        envelope_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        // Keep the existing entry point source-compatible for hosts that send
        // one envelope, while accepting the canonical `{messages:[...]}` wire
        // shape as well. This lets JNI, Swift, ArkTS and WASM submit one
        // complete batch without a per-envelope FFI round trip.
        let value: serde_json::Value = serde_json::from_slice(envelope_json.as_ref())?;
        let batch = if value.get("messages").is_some() {
            let input: BridgeBatch = serde_json::from_value(value)?;
            self.dispatch_batch(input)?
        } else {
            let envelope: BridgeEnvelope = serde_json::from_value(value)?;
            self.dispatch(envelope)?
        };
        Ok(serde_json::to_vec(&batch).expect("BridgeBatch is serializable"))
    }

    /// Explicit JSON batch entry point for bindings that want to reject a
    /// single-envelope payload at their API boundary.
    pub fn dispatch_batch_json(
        &mut self,
        batch_json: impl AsRef<[u8]>,
    ) -> Result<Vec<u8>, HostSessionError> {
        let batch: BridgeBatch = serde_json::from_slice(batch_json.as_ref())?;
        let output = self.dispatch_batch(batch)?;
        Ok(serde_json::to_vec(&output).expect("BridgeBatch is serializable"))
    }

    /// JSON counterpart to [`Self::poll_timers`] for C and WASM bindings.
    /// One invocation always serializes one complete bridge batch, including
    /// an empty `messages` array when no timer is due.
    pub fn poll_timers_json(&mut self, now_ns: u64) -> Result<Vec<u8>, HostSessionError> {
        let batch = self.poll_timers(now_ns)?;
        Ok(serde_json::to_vec(&batch).expect("BridgeBatch is serializable"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use container_bridge::op;
    use container_ir::{AppInfo, CapabilitySupport, CompilerInfo, ContainerManifestV1, Integrity};
    use serde_json::json;

    fn manifest_json() -> Vec<u8> {
        let manifest = ContainerManifestV1 {
            compiler: CompilerInfo {
                name: "weapp-vite".into(),
                commit: "host-common-test".into(),
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
        let mut manifest = manifest;
        manifest
            .capabilities
            .insert("wx.timer".into(), CapabilitySupport::Full);
        manifest
            .capabilities
            .insert("wx.canvas.draw".into(), CapabilitySupport::Partial);
        serde_json::to_vec(&manifest).unwrap()
    }

    fn view_script_manifest_json() -> Vec<u8> {
        let mut manifest: ContainerManifestV1 = serde_json::from_slice(&manifest_json()).unwrap();
        manifest.view_scripts.push(container_ir::ViewScriptModule {
            id: "wxs:shared/format.wxs".into(),
            sha256: container_ir::hex_digest(b"module.exports = {};"),
            dependencies: Vec::new(),
        });
        manifest.refresh_integrity().unwrap();
        serde_json::to_vec(&manifest).unwrap()
    }

    fn legacy_view_script_manifest_json() -> Vec<u8> {
        let source = b"module.exports = {};";
        let mut manifest: ContainerManifestV1 = serde_json::from_slice(&manifest_json()).unwrap();
        manifest.assets.push(container_ir::Asset {
            path: "shared/legacy.wxs".into(),
            sha256: container_ir::hex_digest(source),
            mime: "application/javascript".into(),
            size: source.len() as u64,
        });
        manifest.refresh_integrity().unwrap();
        serde_json::to_vec(&manifest).unwrap()
    }

    #[test]
    fn declared_view_manifest_requires_the_selected_native_provider() {
        for engine in [
            container_core::EngineKind::Quickjs,
            container_core::EngineKind::V8,
        ] {
            // Query the shared runtime: workspace feature unification can
            // enable a provider through a different host dependency.
            let result = HostSession::from_manifest_json(
                view_script_manifest_json(),
                SessionConfig {
                    engine,
                    ..SessionConfig::default()
                },
            );
            if container_runtime::engine_provider_compiled(engine) {
                let host = result.unwrap();
                assert!(host.has_session());
                assert!(!host.initialized());
                assert_eq!(host.session().unwrap().config().engine, engine);
                // Loading the handle admits a declared View program. Its
                // source bytes and execution are verified during app.init.
                assert_eq!(host.session().unwrap().manifest().view_scripts.len(), 1);
            } else {
                let error = result.unwrap_err();
                assert!(matches!(
                    error,
                    HostSessionError::Session(SessionError::EngineUnavailable { engine: unavailable })
                        if unavailable == engine
                ));
                assert!(error.to_string().contains("ERR_ENGINE"));
            }
        }
    }

    #[test]
    fn legacy_view_manifest_is_rejected_before_creating_a_host_handle() {
        let error = HostSession::from_manifest_json(
            legacy_view_script_manifest_json(),
            SessionConfig::default(),
        )
        .unwrap_err();
        assert!(matches!(
            error,
            HostSessionError::Session(SessionError::UnsupportedCapability(_))
        ));
        assert!(error.to_string().contains("ERR_UNSUPPORTED_CAPABILITY"));
    }

    fn dom_config(id: &str) -> SessionConfig {
        SessionConfig {
            session_id: id.into(),
            browser_view_enabled: true,
            renderer_override: Some(container_ir::RendererProfile::WebView),
            page_render_mode: container_render_skia::PageRenderMode::ExternalFrame,
            ..SessionConfig::default()
        }
    }

    #[test]
    fn host_target_configuration_stays_lazy_and_rejects_unloaded_or_invalid_updates() {
        let viewport = Rect {
            x: 0.0,
            y: 0.0,
            width: 375.0,
            height: 667.0,
        };
        let mut host = HostSession::empty();
        assert!(matches!(
            host.stage_skia_render_target(viewport, 2.0),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.repaint_current_skia_page(2.0),
            Err(HostSessionError::NotLoaded)
        ));
        host.load_manifest_json(manifest_json(), dom_config("target-lazy"))
            .unwrap();
        host.start("target-start").unwrap();
        let target = host.validate_skia_render_target(viewport, 2.0).unwrap();
        assert_eq!(
            target,
            RenderTargetSize {
                width: 750,
                height: 1334
            }
        );
        assert_eq!(
            host.stage_skia_render_target(viewport, 2.0).unwrap(),
            target
        );
        assert!(host.stage_skia_render_target(viewport, f64::NAN).is_err());
        assert_eq!(host.repaint_current_skia_page(2.0).unwrap(), None);
        assert_eq!(host.render_revision(), 0);
        assert!(host.accepted_page_observation().unwrap().is_none());
        assert!(!host.page_render_status().unwrap().page_object_initialized);
    }

    #[test]
    fn ordinary_dom_load_and_passive_reads_never_initialize_skia() {
        let mut host = HostSession::empty();
        assert!(matches!(
            host.accepted_page_observation(),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.page_render_status(),
            Err(HostSessionError::NotLoaded)
        ));
        assert!(matches!(
            host.render_target_for_revision(0),
            Err(HostSessionError::NotLoaded)
        ));
        host.load_manifest_json(manifest_json(), dom_config("dom"))
            .unwrap();
        assert!(host.session().unwrap().renderer_if_initialized().is_none());
        host.start("dom-start").unwrap();
        assert_eq!(host.render_revision(), 0);
        assert_eq!(host.render_duration_ms().unwrap(), 0.0);
        assert_eq!(host.renderer_backend().unwrap(), "external-frame-export");
        assert!(!host.has_native_surface().unwrap());
        assert!(!host.has_gpu_surface().unwrap());
        assert!(host.accepted_page_observation().unwrap().is_none());
        assert!(!host.page_render_status().unwrap().page_object_initialized);
        assert!(matches!(host.render_target_for_revision(1),
            Err(HostSessionError::BridgeBatch(error)) if error.code == container_bridge::BridgeErrorCode::Cancelled));
        #[cfg(all(
            feature = "skia-gpu-metal",
            any(target_os = "macos", target_os = "ios")
        ))]
        assert!(!host.has_metal_context().unwrap());
        assert!(matches!(
            host.render_snapshot(),
            Err(HostSessionError::NoRenderFrame)
        ));
        assert!(matches!(
            host.render_snapshot_ref(),
            Err(HostSessionError::NoRenderFrame)
        ));
        assert!(matches!(
            host.capture_render_snapshot(),
            Err(HostSessionError::NoRenderFrame)
        ));
        assert!(matches!(
            host.render_root_id(),
            Err(HostSessionError::NoRenderFrame)
        ));
        assert!(matches!(
            host.canvas_snapshot("missing"),
            Err(HostSessionError::NoRenderFrame)
        ));
        let mut replacement: ContainerManifestV1 =
            serde_json::from_slice(&manifest_json()).unwrap();
        replacement.assets.push(container_ir::Asset {
            path: "development.txt".into(),
            sha256: container_ir::hex_digest(b""),
            mime: "text/plain".into(),
            size: 0,
        });
        replacement.refresh_integrity().unwrap();
        host.replace_manifest_json(serde_json::to_vec(&replacement).unwrap())
            .unwrap();
        assert!(host.session().unwrap().renderer_if_initialized().is_none());

        // The old getter deliberately opts in to concrete Skia ownership, but
        // does not present a DOM document or change its authority namespace.
        let session = host.session().unwrap();
        assert!(session.renderer().last_frame().is_none());
        assert!(session.renderer_if_initialized().is_some());
        assert!(!session.is_current_frame_presented());
    }

    #[test]
    fn host_page_observation_borrows_the_same_accepted_pixels_and_target() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let viewport = container_render_skia::Rect {
            x: 0.0,
            y: 0.0,
            width: 2.0,
            height: 3.0,
        };
        host.session_mut()
            .unwrap()
            .renderer_mut()
            .commit(container_render_skia::RenderFrame {
                images: Default::default(),
                frame_id: 8000,
                viewport,
                root: container_render_skia::RenderNode::new("host-observed", viewport),
            })
            .unwrap();
        let observed = host.accepted_page_observation().unwrap().unwrap();
        assert_eq!(observed.render_revision, host.render_revision());
        assert_eq!(
            observed.target,
            host.render_target_for_revision(observed.render_revision)
                .unwrap()
        );
        assert_eq!(
            observed.snapshot.unwrap().pixels.as_ptr(),
            host.render_snapshot_ref().unwrap().pixels.as_ptr()
        );
        assert_eq!(observed.snapshot.unwrap(), &host.render_snapshot().unwrap());
        assert_eq!(observed.frame.root.id, host.render_root_id().unwrap());
        assert_eq!(
            host.page_render_status().unwrap().last_render_ms,
            host.render_duration_ms().unwrap()
        );
        assert!(matches!(host.render_target_for_revision(8000),
            Err(HostSessionError::BridgeBatch(error)) if error.code == container_bridge::BridgeErrorCode::Cancelled));
        host.unload();
        assert!(matches!(
            host.accepted_page_observation(),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn ordinary_dom_reload_failure_keeps_the_unallocated_running_session() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), dom_config("running-dom")).unwrap();
        host.start("dom-start").unwrap();
        host.session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("running", json!(true))
            .unwrap();
        let valid_manifest = manifest_json();
        for bytes in [b"{}".as_slice(), valid_manifest.as_slice()] {
            let mut config = dom_config("replacement");
            if bytes != b"{}" {
                config.session_id = " ".into();
            }
            assert!(host.load_manifest_json(bytes, config).is_err());
            let retained = host.session().unwrap();
            assert_eq!(retained.config().session_id, "running-dom");
            assert!(retained.initialized());
            assert_eq!(
                retained.app_service().storage().get("running"),
                Some(&json!(true))
            );
            assert!(retained.renderer_if_initialized().is_none());
        }
        host.load_manifest_json(manifest_json(), dom_config("replacement"))
            .unwrap();
        let replacement = host.session().unwrap();
        assert_eq!(replacement.config().session_id, "replacement");
        assert!(!replacement.initialized());
        assert!(replacement.app_service().storage().is_empty());
        assert!(replacement.renderer_if_initialized().is_none());
    }

    #[test]
    fn renderer_preparation_failure_preserves_the_running_session() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        host.start("initial-start").unwrap();
        host.session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("running", json!(true))
            .unwrap();
        let prepared = std::cell::Cell::new(0);
        let config = SessionConfig {
            session_id: "replacement".into(),
            ..SessionConfig::default()
        };
        let error = host
            .load_manifest_json_with_renderer(manifest_json(), config.clone(), |_| {
                prepared.set(prepared.get() + 1);
                Err(RenderError::Unsupported("required-host-font-decoder"))
            })
            .unwrap_err();
        assert!(matches!(error, HostSessionError::Render(_)));
        assert_eq!(prepared.get(), 1);
        assert!(host.initialized());
        assert_eq!(host.session().unwrap().config().session_id, "session-1");
        assert_eq!(
            host.session()
                .unwrap()
                .app_service()
                .storage()
                .get("running"),
            Some(&json!(true))
        );
        assert!(host
            .load_manifest_json_with_renderer(b"{}", config.clone(), |_| {
                prepared.set(prepared.get() + 1);
                Ok(())
            })
            .is_err());
        assert_eq!(prepared.get(), 1, "invalid manifests never enter the host");
        host.load_manifest_json_with_renderer(manifest_json(), config, |_| {
            prepared.set(prepared.get() + 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(prepared.get(), 2);
        assert!(!host.initialized());
        assert_eq!(host.session().unwrap().config().session_id, "replacement");
        assert!(host.session().unwrap().app_service().storage().is_empty());
    }

    #[test]
    fn declared_view_full_reload_uses_a_fresh_session_when_the_provider_exists() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        host.start("initial-start").unwrap();
        host.session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("previous-session", json!(true))
            .unwrap();
        let result = host.load_manifest_json(
            view_script_manifest_json(),
            SessionConfig {
                session_id: "replacement-session".into(),
                ..SessionConfig::default()
            },
        );
        if container_runtime::engine_provider_compiled(container_core::EngineKind::Quickjs) {
            result.unwrap();
            assert!(!host.initialized());
            assert_eq!(
                host.session().unwrap().config().session_id,
                "replacement-session"
            );
            assert!(host.session().unwrap().app_service().storage().is_empty());
        } else {
            let error = result.unwrap_err();
            assert!(matches!(
                error,
                HostSessionError::Session(SessionError::EngineUnavailable {
                    engine: container_core::EngineKind::Quickjs
                })
            ));
            assert!(error.to_string().contains("ERR_ENGINE"));
            assert!(host.initialized());
            assert_eq!(host.session().unwrap().config().session_id, "session-1");
            assert_eq!(
                host.session()
                    .unwrap()
                    .app_service()
                    .storage()
                    .get("previous-session"),
                Some(&json!(true))
            );
        }
    }

    #[test]
    fn rejected_view_reloads_preserve_the_previous_live_host_session() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        host.start("initial-start").unwrap();
        let push = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "page",
                op::PAGE_PUSH,
                json!({"path":"pages/index/index", "data":{"retained":true}}),
            ))
            .unwrap();
        assert_eq!(push.messages[0].payload["ok"], true);
        host.session_mut()
            .unwrap()
            .app_service_mut()
            .set_storage("retained", json!(true))
            .unwrap();
        let old_manifest = host.session().unwrap().manifest().clone();
        let error = host
            .load_manifest_json(
                legacy_view_script_manifest_json(),
                SessionConfig {
                    session_id: "replacement-session".into(),
                    ..SessionConfig::default()
                },
            )
            .unwrap_err();
        assert!(matches!(
            error,
            HostSessionError::Session(SessionError::UnsupportedCapability(_))
        ));
        let error = host
            .replace_manifest_json(legacy_view_script_manifest_json())
            .unwrap_err();
        assert!(matches!(
            error,
            HostSessionError::Session(SessionError::UnsupportedCapability(_))
        ));
        let error = host
            .replace_manifest_json(view_script_manifest_json())
            .unwrap_err();
        if container_runtime::engine_provider_compiled(container_core::EngineKind::Quickjs) {
            // Declared View support does not permit changing executable
            // inputs behind a running session. This needs a full reload.
            assert!(matches!(
                error,
                HostSessionError::Session(SessionError::Config(_))
            ));
            assert!(error.to_string().contains("restart the session"));
        } else {
            // Metadata-only replacement enforces the same selected-provider
            // requirement as construction and full replacement.
            assert!(matches!(
                error,
                HostSessionError::Session(SessionError::EngineUnavailable {
                    engine: container_core::EngineKind::Quickjs
                })
            ));
            assert!(error.to_string().contains("ERR_ENGINE"));
        }
        let session = host.session().unwrap();
        assert_eq!(session.manifest(), &old_manifest);
        assert_eq!(session.config().session_id, "session-1");
        assert!(session.initialized());
        assert_eq!(session.app_service().pages().len(), 1);
        assert_eq!(
            session.app_service().pages().current().unwrap().data["retained"],
            true
        );
        assert_eq!(
            session.app_service().storage().get("retained"),
            Some(&json!(true))
        );
        let resumed = host.start("still-live").unwrap();
        assert_eq!(resumed.messages[0].payload["ok"], true);
    }

    #[test]
    fn rejects_dispatch_before_manifest_load() {
        let mut host = HostSession::empty();
        let envelope = BridgeEnvelope::request("session-1", "r1", op::APP_INIT, json!({}));
        assert!(matches!(
            host.dispatch(envelope),
            Err(HostSessionError::NotLoaded)
        ));
    }

    #[test]
    fn json_dispatch_returns_a_complete_batch() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let envelope = BridgeEnvelope::request("session-1", "r1", op::APP_INIT, json!({}));
        let response = host
            .dispatch_json(serde_json::to_vec(&envelope).unwrap())
            .unwrap();
        let batch: BridgeBatch = serde_json::from_slice(&response).unwrap();
        assert_eq!(batch.messages.len(), 2);
        assert!(host.initialized());
    }

    #[test]
    fn json_dispatch_accepts_one_validated_batch_and_applies_messages_in_order() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let input = BridgeBatch::new(vec![
            BridgeEnvelope::request("session-1", "init", op::APP_INIT, json!({})),
            BridgeEnvelope::request(
                "session-1",
                "push",
                op::PAGE_PUSH,
                json!({"path":"pages/home/index"}),
            ),
        ]);
        let output = host
            .dispatch_json(serde_json::to_vec(&input).unwrap())
            .unwrap();
        let batch: BridgeBatch = serde_json::from_slice(&output).unwrap();
        // app.init and page.push each emit a response and diagnostic. The
        // order is the order submitted by the host.
        assert_eq!(batch.messages.len(), 4);
        assert_eq!(batch.messages[0].request_id, "init");
        assert_eq!(batch.messages[0].op, op::APP_INIT);
        assert_eq!(batch.messages[2].request_id, "push");
        assert_eq!(batch.messages[2].payload["ok"], true);
        assert_eq!(host.session().unwrap().app_service().pages().len(), 1);
    }

    #[test]
    fn batch_validation_happens_before_any_runtime_mutation() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let input = BridgeBatch::new(vec![
            BridgeEnvelope::request("session-1", "init", op::APP_INIT, json!({})),
            // The second envelope is malformed for this batch because it
            // belongs to another session. The first message must not run.
            BridgeEnvelope::request("other-session", "push", op::PAGE_PUSH, json!({})),
        ]);
        let error = host
            .dispatch_batch(input)
            .expect_err("mixed-session batch must be rejected");
        assert!(matches!(error, HostSessionError::BridgeBatch(_)));
        assert!(!host.initialized());
        assert_eq!(
            host.session().unwrap().app_service().pages().len(),
            0,
            "rejected batch must not mutate the page stack"
        );
    }

    #[test]
    fn batch_cancel_and_deadline_are_observable_without_partial_mutation() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let mut expired = BridgeEnvelope::request(
            "session-1",
            "expired",
            op::PAGE_PUSH,
            json!({"path":"pages/expired/index"}),
        );
        expired.deadline_ns = Some(1);
        let cancelled = BridgeEnvelope::request(
            "session-1",
            "cancel",
            op::CANCEL,
            json!({"cancelToken":"batch-cancel"}),
        );
        let mut blocked = BridgeEnvelope::request(
            "session-1",
            "blocked",
            op::PAGE_PUSH,
            json!({"path":"pages/blocked/index"}),
        );
        blocked.cancel_token = Some("batch-cancel".into());
        let output = host
            .dispatch_batch(BridgeBatch::new(vec![
                BridgeEnvelope::request("session-1", "init", op::APP_INIT, json!({})),
                expired,
                cancelled,
                blocked,
            ]))
            .unwrap();
        assert_eq!(output.messages[2].payload["error"]["code"], "ERR_TIMEOUT");
        assert_eq!(output.messages[3].payload["cancelled"], true);
        assert_eq!(output.messages[4].payload["error"]["code"], "ERR_CANCELLED");
        assert_eq!(host.session().unwrap().app_service().pages().len(), 0);
    }

    #[test]
    fn start_and_lifecycle_helpers_preserve_core_ordering() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        assert_eq!(host.lifecycle_state().unwrap(), LifecycleState::Created);
        assert_eq!(host.lifecycle_sequence().unwrap(), 0);
        let init = host.start("init").unwrap();
        assert_eq!(init.messages[0].payload["ok"], true);
        let launch = host.lifecycle("launch", "launch").unwrap();
        assert_eq!(launch.messages[0].payload["state"], "Active");
        assert_eq!(host.lifecycle_state().unwrap(), LifecycleState::Active);
        assert_eq!(host.lifecycle_sequence().unwrap(), 1);
        host.lifecycle("hide", "hide").unwrap();
        assert_eq!(host.lifecycle_state().unwrap(), LifecycleState::Background);
        assert_eq!(host.lifecycle_sequence().unwrap(), 2);
    }

    #[test]
    fn complete_window_json_validates_before_mutation_and_preserves_display_on_legacy_resize() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        host.start("init").unwrap();
        let observation = json!({
            "windowWidth":393,"windowHeight":800,"pixelRatio":2.75,
            "screenWidth":393,"screenHeight":873,"statusBarHeight":24.0,
            "screenTop":0.0,"deviceOrientation":"portrait"
        });
        let bytes = serde_json::to_vec(&observation).unwrap();
        let batch: BridgeBatch =
            serde_json::from_slice(&host.notify_window_metrics_json(&bytes).unwrap()).unwrap();
        assert_eq!(batch.messages[0].payload["type"], "host.resize");
        let previous = host.session().unwrap().config().host.clone();
        for invalid in [
            b"{".as_slice().to_vec(),
            serde_json::to_vec(&json!({"windowWidth":1,"windowHeight":2})).unwrap(),
            serde_json::to_vec(&{
                let mut invalid = observation.clone();
                invalid["pixelRatio"] = json!(0);
                invalid
            })
            .unwrap(),
        ] {
            assert!(host.notify_window_metrics_json(invalid).is_err());
            let actual = &host.session().unwrap().config().host;
            assert_eq!(actual.window_width, previous.window_width);
            assert_eq!(actual.window_height, previous.window_height);
            assert_eq!(actual.display_metrics, previous.display_metrics);
        }
        let duplicate: BridgeBatch =
            serde_json::from_slice(&host.notify_window_metrics_json(bytes).unwrap()).unwrap();
        assert!(duplicate.messages.is_empty());
        host.notify_viewport_resize_json(500, 600).unwrap();
        let actual = &host.session().unwrap().config().host;
        assert_eq!((actual.window_width, actual.window_height), (500, 600));
        assert_eq!(actual.display_metrics, previous.display_metrics);
    }

    #[test]
    fn poll_timers_is_batch_oriented_and_requires_a_loaded_session() {
        let mut empty = HostSession::empty();
        assert!(matches!(
            empty.poll_timers(0),
            Err(HostSessionError::NotLoaded)
        ));

        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        // Timers are inert until the app.init handshake has completed.
        assert!(host.poll_timers(u64::MAX).unwrap().messages.is_empty());
        host.start("init").unwrap();
        let set = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "timer",
                op::API_CALL,
                json!({"name":"setTimeout", "delayMs":1, "callbackId":"host-cb"}),
            ))
            .unwrap();
        let timer_id = set.messages[0].payload["timerId"].as_u64().unwrap();
        let due_ns = host
            .session()
            .unwrap()
            .app_service()
            .timers()
            .entries()
            .find(|entry| entry.id.0 == timer_id)
            .unwrap()
            .due_ns;
        let fired = host.poll_timers(due_ns).unwrap();
        assert_eq!(fired.messages.len(), 1);
        assert_eq!(
            fired.messages[0].payload["timers"][0]["callbackId"],
            "host-cb"
        );

        let json = host.poll_timers_json(u64::MAX).unwrap();
        let batch: BridgeBatch = serde_json::from_slice(&json).unwrap();
        assert!(batch.messages.is_empty());
    }

    #[test]
    fn render_snapshot_is_one_host_consumable_batch() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        assert!(matches!(
            host.render_snapshot(),
            Err(HostSessionError::NoRenderFrame)
        ));
        assert!(matches!(
            host.render_root_id(),
            Err(HostSessionError::NoRenderFrame)
        ));
        host.start("init").unwrap();
        let response = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "render",
                op::RENDER_COMMIT,
                json!({
                    "frame": {
                        "frameId": 11,
                        "viewport": {"x": 0.0, "y": 0.0, "width": 2.0, "height": 1.0},
                        "root": {
                            "id": "root",
                            "bounds": {"x": 0.0, "y": 0.0, "width": 2.0, "height": 1.0},
                            "background": {"red": 1, "green": 2, "blue": 3, "alpha": 255},
                            "opacity": 1.0,
                            "children": []
                        }
                    }
                }),
            ))
            .unwrap();
        assert_eq!(response.messages[0].payload["frameId"], 11);
        assert_eq!(host.render_root_id().unwrap(), "root");
        let bytes = host.render_snapshot_json().unwrap();
        let snapshot: container_render_skia::RenderSnapshot =
            serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            (snapshot.frame_id, snapshot.width, snapshot.height),
            (11, 2, 1)
        );
        assert_eq!(snapshot.pixels, vec![1, 2, 3, 255, 1, 2, 3, 255]);
    }

    #[test]
    fn canvas_snapshot_is_independent_from_page_snapshot() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        host.start("init").unwrap();
        assert!(host.session().unwrap().renderer_if_initialized().is_none());
        let response = host
            .dispatch(BridgeEnvelope::request(
                "session-1",
                "canvas",
                op::API_CALL,
                json!({
                    "name": "wx.canvas.draw",
                    "canvasId": "main",
                    "width": 1,
                    "height": 1,
                    "commands": [
                        {"op": "setFillStyle", "args": ["#0a141e"]},
                        {"op": "fillRect", "args": [0, 0, 1, 1]}
                    ]
                }),
            ))
            .unwrap();
        assert_eq!(response.messages[0].payload["ok"], true);
        assert!(host.session().unwrap().renderer_if_initialized().is_none());
        assert_eq!(host.render_revision(), 0, "Canvas is not a page commit");
        let snapshot: RenderSnapshot =
            serde_json::from_slice(&host.canvas_snapshot_json("main").unwrap()).unwrap();
        assert_eq!((snapshot.width, snapshot.height), (1, 1));
        assert_eq!(snapshot.pixels, vec![10, 20, 30, 255]);
        assert!(matches!(
            host.render_snapshot(),
            Err(HostSessionError::NoRenderFrame)
        ));
    }

    #[test]
    fn failed_reload_preserves_the_running_session() {
        let mut host =
            HostSession::from_manifest_json(manifest_json(), SessionConfig::default()).unwrap();
        let init = BridgeEnvelope::request("session-1", "r1", op::APP_INIT, json!({}));
        host.dispatch(init).unwrap();
        assert!(host.initialized());
        let error = host.load_manifest_json(b"{}", SessionConfig::default());
        assert!(error.is_err());
        assert!(host.initialized());
    }

    #[test]
    fn ffi_write_refuses_to_overwrite_a_live_output() {
        let mut output = FfiBuffer {
            data: std::ptr::dangling_mut::<u8>(),
            len: 1,
        };
        assert_eq!(
            unsafe { ffi_write(&mut output, b"leak".to_vec()) },
            FFI_INVALID_ARGUMENT
        );
        assert_eq!(output.data, std::ptr::dangling_mut::<u8>());
        assert_eq!(output.len, 1);
    }

    #[test]
    fn ffi_buffer_release_is_idempotent_and_clears_ownership() {
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi_write(&mut output, b"bridge-result".to_vec()) },
            FFI_OK
        );
        assert!(!output.data.is_null());
        assert_eq!(output.len, 13);
        unsafe { ffi_buffer_free(&mut output) };
        assert!(output.data.is_null());
        assert_eq!(output.len, 0);
        // Native callers can safely run cleanup in both the success and
        // error paths; a second release does not touch an already-cleared
        // allocation.
        unsafe { ffi_buffer_free(&mut output) };
        assert!(output.data.is_null());
        assert_eq!(output.len, 0);
    }

    #[test]
    fn ffi_input_accepts_only_null_empty_and_valid_non_empty_buffers() {
        // A null pointer is a valid representation for an empty C string or
        // byte batch, but accepting it for a non-empty input would turn a
        // malformed JNI/Swift/ArkTS call into undefined behaviour.
        assert_eq!(
            unsafe { ffi_input(std::ptr::null(), 0) },
            Ok::<&[u8], i32>(&[])
        );
        assert_eq!(
            unsafe { ffi_input(std::ptr::null(), 1) },
            Err(FFI_INVALID_ARGUMENT)
        );

        let input = *b"container";
        assert_eq!(
            unsafe { ffi_input(input.as_ptr(), input.len()) },
            Ok(input.as_slice())
        );
    }

    #[test]
    fn ffi_write_error_is_structured_and_owns_a_releasable_buffer() {
        let mut output = FfiBuffer::empty();
        assert_eq!(
            unsafe { ffi_write_error(&mut output, "invalid manifest") },
            FFI_ERR
        );
        let payload: serde_json::Value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(output.data, output.len) })
                .expect("FFI error output is JSON");
        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"], "invalid manifest");
        unsafe { ffi_buffer_free(&mut output) };
        assert!(output.data.is_null());
        assert_eq!(output.len, 0);
    }
}
