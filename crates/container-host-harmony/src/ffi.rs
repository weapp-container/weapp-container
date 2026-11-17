//! Stable C ABI used by the HarmonyOS ArkTS/N-API sample host.
//!
//! N-API code owns the opaque host handle and exchanges UTF-8 JSON batches.
//! The ABI is intentionally independent of ArkUI so the same runtime can be
//! embedded in a surface component or a headless test harness.

#![allow(clippy::missing_safety_doc)]

use crate::HarmonyHost;
use container_bridge::BridgeBatch;
use container_host_common::{
    ffi_buffer_free, ffi_input, ffi_write, ffi_write_error, FfiBuffer, FFI_ERR,
    FFI_INVALID_ARGUMENT, FFI_OK,
};
use container_runtime::{SessionConfig, SessionError};

fn write_batch(output: *mut FfiBuffer, batch: BridgeBatch) -> i32 {
    match serde_json::to_vec(&batch) {
        Ok(bytes) => unsafe { ffi_write(output, bytes) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

fn write_load_error(output: *mut FfiBuffer, code: &str, error: impl std::fmt::Display) -> i32 {
    let payload =
        serde_json::json!({"ok": false, "error": {"code": code, "message": error.to_string()}});
    let status = unsafe {
        ffi_write(
            output,
            serde_json::to_vec(&payload).expect("load error JSON"),
        )
    };
    if status == FFI_OK {
        FFI_ERR
    } else {
        status
    }
}

/// Additive protocol extension. Existing C ABI structs and entrypoints retain
/// their layout; old native artifacts reject absence during N-API negotiation.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_harmony_host_services_json(
    host: *mut HarmonyHost,
    command: *const u8,
    command_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if host.is_null() || output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    let command = match unsafe { ffi_input(command, command_len) } {
        Ok(value) => value,
        Err(code) => return code,
    };
    if command.len() > 8 * 1024 * 1024 {
        return unsafe { ffi_write_error(output, "host services command exceeds byte budget") };
    }
    match unsafe { &mut *host }.host_services_json(command) {
        Ok(bytes) => unsafe { ffi_write(output, bytes) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
pub extern "C" fn weapp_container_harmony_host_new() -> *mut HarmonyHost {
    Box::into_raw(Box::new(HarmonyHost::new()))
}

#[no_mangle]
pub unsafe extern "C" fn weapp_container_harmony_host_acknowledge_presentation(
    host: *mut HarmonyHost,
    revision: u64,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    match unsafe { &mut *host }.acknowledge_presentation_json(revision) {
        Ok(bytes) => unsafe { ffi_write(output, bytes) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_host_free(host: *mut HarmonyHost) {
    if !host.is_null() {
        // SAFETY: ownership was transferred by `weapp_container_harmony_host_new`.
        drop(unsafe { Box::from_raw(host) });
    }
}

#[no_mangle]
/// Release the loaded runtime while retaining the reusable host handle.
/// Repeated unloads succeed. Dispatch lifecycle `unload` first when user hooks
/// must run; this entry point only releases the session and its resources.
///
/// # Safety
///
/// `host` must be a live handle owned exclusively by the calling thread.
pub unsafe extern "C" fn weapp_container_harmony_host_unload(host: *mut HarmonyHost) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and the caller keeps exclusive ownership.
    unsafe { &mut *host }.unload();
    FFI_OK
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_buffer_free(buffer: *mut FfiBuffer) {
    // SAFETY: callers pass buffers returned by this host's ABI.
    unsafe { ffi_buffer_free(buffer) };
}

#[no_mangle]
/// # Safety
///
/// `host` must be a handle returned by [`weapp_container_harmony_host_new`] and `output`
/// must point to an empty caller-owned buffer.  The returned JSON separates
/// ArkUI surface support from a real GPU attachment.
pub unsafe extern "C" fn weapp_container_harmony_host_capabilities(
    host: *const HarmonyHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: the caller keeps the immutable host handle alive for this
    // synchronous read and does not mutate it concurrently.
    let host = unsafe { &*host };
    match host.capabilities_json() {
        Ok(capabilities) => unsafe { ffi_write(output, capabilities) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_host_load_manifest(
    host: *mut HarmonyHost,
    manifest: *const u8,
    manifest_len: usize,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    let bytes = match unsafe { ffi_input(manifest, manifest_len) } {
        Ok(bytes) => bytes,
        Err(code) => return code,
    };
    // SAFETY: null was checked and the ArkTS owner keeps the host alive.
    let host = unsafe { &mut *host };
    match host.load_manifest_json(bytes, SessionConfig::default()) {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

#[no_mangle]
/// Load a manifest using typed engine/session/host configuration. There is no
/// engine fallback. All validation and engine construction complete before
/// the old session is replaced; failures return structured error JSON.
///
/// # Safety
///
/// Input slices must remain valid for this call. `host` must be a live,
/// exclusively owned handle and `output` an empty caller-owned buffer.
pub unsafe extern "C" fn weapp_container_harmony_host_load_manifest_with_config(
    host: *mut HarmonyHost,
    manifest: *const u8,
    manifest_len: usize,
    config: *const u8,
    config_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let manifest = match unsafe { ffi_input(manifest, manifest_len) } {
        Ok(bytes) => bytes,
        Err(code) => return code,
    };
    let config = match unsafe { ffi_input(config, config_len) } {
        Ok(bytes) => bytes,
        Err(code) => return code,
    };
    let config: SessionConfig = match serde_json::from_slice(config) {
        Ok(config) => config,
        Err(error) => return write_load_error(output, "ERR_ENGINE", error),
    };
    if !container_runtime::engine_provider_compiled(config.engine) {
        return write_load_error(
            output,
            "ERR_ENGINE",
            "requested native engine provider is not compiled",
        );
    }
    // SAFETY: the caller retains exclusive ownership for construction/swap.
    match unsafe { &mut *host }.load_manifest_json(manifest, config) {
        Ok(()) => FFI_OK,
        Err(error) => {
            let code = match &error {
                container_host_common::HostSessionError::Session(
                    SessionError::EngineUnavailable { .. } | SessionError::ViewProvider(_),
                ) => "ERR_ENGINE",
                container_host_common::HostSessionError::Session(SessionError::Protocol(_)) => {
                    "ERR_PROTOCOL_VERSION"
                }
                container_host_common::HostSessionError::Session(SessionError::Config(_)) => {
                    "ERR_INVALID_REQUEST"
                }
                container_host_common::HostSessionError::Render(_) => "ERR_RENDER",
                _ => "ERR_INVALID_MANIFEST",
            };
            write_load_error(output, code, error)
        }
    }
}

#[no_mangle]
/// Observe current page state in one read without entering the JS engine.
///
/// # Safety
///
/// `host` must remain live without concurrent mutation; `output` must point
/// to an empty caller-owned buffer released with the matching buffer free.
pub unsafe extern "C" fn weapp_container_harmony_host_inspect_state(
    host: *const HarmonyHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: the caller retains this immutable handle for the whole read.
    match unsafe { &*host }.inspect_state_json() {
        Ok(state) => unsafe { ffi_write(output, state) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// Update logical viewport geometry and return resize hooks as one batch.
/// The owner commits and presents a new frame after this call.
///
/// # Safety
///
/// `host` must be live and exclusively owned. `output` must point to an empty
/// caller-owned buffer released with the matching buffer free.
pub unsafe extern "C" fn weapp_container_harmony_host_resize_viewport(
    host: *mut HarmonyHost,
    width: u32,
    height: u32,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: the caller retains exclusive ownership for this update.
    match unsafe { &mut *host }.notify_viewport_resize_json(width, height) {
        Ok(batch) => unsafe { ffi_write(output, batch) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_host_dispatch_json(
    host: *mut HarmonyHost,
    envelope: *const u8,
    envelope_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let bytes = match unsafe { ffi_input(envelope, envelope_len) } {
        Ok(bytes) => bytes,
        Err(code) => {
            return unsafe { ffi_write_error(output, format!("invalid input ({code})")) };
        }
    };
    // SAFETY: null was checked above.
    let host = unsafe { &mut *host };
    match host.dispatch_json(bytes) {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// Same ownership rules as [`weapp_container_harmony_host_dispatch_json`], but the input
/// must be a canonical `{"messages":[...]}` batch. The host validates all
/// envelopes before dispatching the first one.
pub unsafe extern "C" fn weapp_container_harmony_host_dispatch_batch_json(
    host: *mut HarmonyHost,
    batch: *const u8,
    batch_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let bytes = match unsafe { ffi_input(batch, batch_len) } {
        Ok(bytes) => bytes,
        Err(code) => return unsafe { ffi_write_error(output, format!("invalid input ({code})")) },
    };
    // SAFETY: null was checked above; the ArkTS owner keeps the host alive for
    // the synchronous call.
    let host = unsafe { &mut *host };
    match host.dispatch_batch_json(bytes) {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass a live host handle and an empty output buffer owned by
/// the caller. The returned JSON contains one complete RGBA render snapshot;
/// release it with `weapp_container_harmony_buffer_free`.
pub unsafe extern "C" fn weapp_container_harmony_host_render_snapshot(
    host: *mut HarmonyHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: null was checked above and the caller keeps the host alive for
    // the duration of this synchronous diagnostic capture.
    let host = unsafe { &mut *host };
    match host.render_snapshot_json() {
        Ok(snapshot) => unsafe { ffi_write(output, snapshot) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

/// Attach the caller's current EGL/GLES context to the Rust Skia renderer.
/// The function remains part of the stable ABI when the GLES feature is not
/// compiled; in that build it returns a structured `ERR_RENDER` payload rather
/// than silently falling back to a software snapshot.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_harmony_host_attach_gles_context(
    host: *mut HarmonyHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    #[cfg(feature = "skia-gpu-gles")]
    {
        // SAFETY: null was checked above and the caller keeps the host alive.
        let host = unsafe { &mut *host };
        match host.attach_gles_context() {
            Ok(()) => unsafe {
                ffi_write(
                    output,
                    br#"{"ok":true,"renderer":"skia-gpu-gles"}"#.to_vec(),
                )
            },
            Err(error) => unsafe { ffi_write_error(output, error) },
        }
    }
    #[cfg(not(feature = "skia-gpu-gles"))]
    unsafe {
        ffi_write_error(output, "ERR_RENDER: skia-gpu-gles feature is not compiled")
    }
}

/// Submit one frame to a framebuffer owned by an ArkUI EGL window.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_harmony_host_render_gles_framebuffer(
    host: *mut HarmonyHost,
    framebuffer: u32,
    width: u32,
    height: u32,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    #[cfg(not(feature = "skia-gpu-gles"))]
    let _ = (framebuffer, width, height);
    #[cfg(feature = "skia-gpu-gles")]
    {
        // SAFETY: null was checked above and the caller keeps the host alive.
        let host = unsafe { &mut *host };
        match host.render_last_frame_to_gles_framebuffer(framebuffer, width, height) {
            Ok(()) => unsafe {
                ffi_write(
                    output,
                    br#"{"ok":true,"gpuSurface":true,"renderer":"skia-gpu-gles"}"#.to_vec(),
                )
            },
            Err(error) => unsafe { ffi_write_error(output, error) },
        }
    }
    #[cfg(not(feature = "skia-gpu-gles"))]
    unsafe {
        ffi_write_error(output, "ERR_RENDER: skia-gpu-gles feature is not compiled")
    }
}

/// Detach the GLES context before the ArkUI surface or EGL context is
/// destroyed. This prevents Skia from retaining stale driver handles.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_harmony_host_detach_gles_context(
    host: *mut HarmonyHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    #[cfg(feature = "skia-gpu-gles")]
    {
        // SAFETY: null was checked above and the caller keeps the host alive.
        let host = unsafe { &mut *host };
        match host.detach_gles_context() {
            Ok(()) => unsafe { ffi_write(output, br#"{"ok":true,"gpuSurface":false}"#.to_vec()) },
            Err(error) => unsafe { ffi_write_error(output, error) },
        }
    }
    #[cfg(not(feature = "skia-gpu-gles"))]
    unsafe {
        ffi_write_error(output, "ERR_RENDER: skia-gpu-gles feature is not compiled")
    }
}

#[no_mangle]
/// Forget an unusable GLES context without issuing GL calls. This entry point
/// is safe before loading a manifest and is idempotent in GLES-enabled builds.
/// Builds without GLES return `FFI_ERR`, never pretend to release GPU state.
///
/// # Safety
///
/// `host` must be a live handle exclusively accessed on its owner thread. The
/// owner must stop rendering with the abandoned context before this call.
pub unsafe extern "C" fn weapp_container_harmony_host_abandon_gles_context(
    host: *mut HarmonyHost,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    #[cfg(feature = "skia-gpu-gles")]
    {
        // SAFETY: null was checked; the owner serializes host access.
        match unsafe { &mut *host }.abandon_gles_context() {
            Ok(()) => FFI_OK,
            Err(_) => FFI_ERR,
        }
    }
    #[cfg(not(feature = "skia-gpu-gles"))]
    {
        FFI_ERR
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass a live host handle, a UTF-8 canvas id whose bytes stay
/// valid for the duration of this call, and an empty output buffer. The
/// returned JSON contains one complete RGBA snapshot for that canvas surface;
/// release it with `weapp_container_harmony_buffer_free`.
pub unsafe extern "C" fn weapp_container_harmony_host_canvas_snapshot(
    host: *mut HarmonyHost,
    canvas_id: *const u8,
    canvas_id_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let canvas_id = match unsafe { ffi_input(canvas_id, canvas_id_len) }
        .and_then(|bytes| std::str::from_utf8(bytes).map_err(|_| FFI_INVALID_ARGUMENT))
    {
        Ok(value) => value,
        Err(code) => {
            return unsafe { ffi_write_error(output, format!("invalid canvas id ({code})")) };
        }
    };
    // SAFETY: null was checked above and the ArkTS owner keeps the host alive
    // for this synchronous read.
    let host = unsafe { &*host };
    match host.canvas_snapshot_json(canvas_id) {
        Ok(snapshot) => unsafe { ffi_write(output, snapshot) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_host_start(
    host: *mut HarmonyHost,
    request_id: *const u8,
    request_id_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let request_id = match unsafe { ffi_input(request_id, request_id_len) }
        .and_then(|bytes| std::str::from_utf8(bytes).map_err(|_| FFI_INVALID_ARGUMENT))
    {
        Ok(value) => value,
        Err(code) => {
            return unsafe { ffi_write_error(output, format!("invalid request id ({code})")) };
        }
    };
    // SAFETY: null was checked above.
    let host = unsafe { &mut *host };
    match host.start_session(request_id) {
        Ok(batch) => write_batch(output, batch),
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_harmony_host_lifecycle(
    host: *mut HarmonyHost,
    request_id: *const u8,
    request_id_len: usize,
    event: *const u8,
    event_len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    let request_id = match unsafe { ffi_input(request_id, request_id_len) }
        .and_then(|bytes| std::str::from_utf8(bytes).map_err(|_| FFI_INVALID_ARGUMENT))
    {
        Ok(value) => value,
        Err(code) => {
            return unsafe { ffi_write_error(output, format!("invalid request id ({code})")) };
        }
    };
    let event = match unsafe { ffi_input(event, event_len) }
        .and_then(|bytes| std::str::from_utf8(bytes).map_err(|_| FFI_INVALID_ARGUMENT))
    {
        Ok(value) => value,
        Err(code) => {
            return unsafe { ffi_write_error(output, format!("invalid event ({code})")) };
        }
    };
    // SAFETY: null was checked above.
    let host = unsafe { &mut *host };
    match host.dispatch_lifecycle(request_id, event) {
        Ok(batch) => write_batch(output, batch),
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass a live host handle and an empty output buffer owned by
/// the caller. The now_ns argument is supplied by the host event loop and is
/// interpreted as Unix-epoch nanoseconds, not uptime or elapsed session time.
pub unsafe extern "C" fn weapp_container_harmony_host_poll_timers(
    host: *mut HarmonyHost,
    now_ns: u64,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: null was checked above and the caller keeps the host alive for
    // the duration of this synchronous call.
    let host = unsafe { &mut *host };
    match host.poll_timers(now_ns) {
        Ok(batch) => write_batch(output, batch),
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}
