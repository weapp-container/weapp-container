//! Stable C ABI used by the Android JNI/NDK sample host.
//!
//! The ABI deliberately exposes complete JSON batches.  JNI code should call
//! these functions from one thread-affine owner and must not cross the
//! boundary once per view node.

#![allow(clippy::missing_safety_doc)]

use crate::AndroidHost;
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

#[no_mangle]
pub extern "C" fn weapp_container_android_host_new() -> *mut AndroidHost {
    Box::into_raw(Box::new(AndroidHost::new()))
}

#[no_mangle]
pub unsafe extern "C" fn weapp_container_android_host_acknowledge_presentation(
    host: *mut AndroidHost,
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
pub unsafe extern "C" fn weapp_container_android_host_free(host: *mut AndroidHost) {
    if !host.is_null() {
        // SAFETY: ownership was transferred by `weapp_container_android_host_new` and is
        // consumed exactly once here.
        drop(unsafe { Box::from_raw(host) });
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_android_buffer_free(buffer: *mut FfiBuffer) {
    // SAFETY: callers pass buffers returned by this host's ABI.
    unsafe { ffi_buffer_free(buffer) };
}

#[no_mangle]
/// # Safety
///
/// `host` must be a handle returned by [`weapp_container_android_host_new`] and `output`
/// must point to an empty caller-owned buffer.  The returned JSON separates
/// compiled surface support from the currently attached runtime surface.
pub unsafe extern "C" fn weapp_container_android_host_capabilities(
    host: *const AndroidHost,
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
pub unsafe extern "C" fn weapp_container_android_host_load_manifest(
    host: *mut AndroidHost,
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
    // SAFETY: null was checked and the JNI owner keeps the host alive for the
    // duration of this call.
    let host = unsafe { &mut *host };
    match host.load_manifest_json(bytes, SessionConfig::default()) {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Load with an explicit engine/session configuration. An unavailable engine
/// produces a structured error and retains the previous session; this entry
/// point never falls back to another engine. The default loader remains ABI
/// compatible for existing callers.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_android_host_load_manifest_with_config(
    host: *mut AndroidHost,
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
            format!(
                "native {:?} provider is not compiled for this host",
                config.engine
            ),
        );
    }
    let host = unsafe { &mut *host };
    match host.load_manifest_json(manifest, config) {
        Ok(()) => FFI_OK,
        Err(error) => {
            let code = match &error {
                container_host_common::HostSessionError::Session(
                    SessionError::EngineUnavailable { .. } | SessionError::ViewProvider(_),
                ) => "ERR_ENGINE",
                container_host_common::HostSessionError::Session(SessionError::Protocol(_)) => {
                    "ERR_PROTOCOL_VERSION"
                }
                _ => "ERR_INVALID_MANIFEST",
            };
            write_load_error(output, code, error)
        }
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_android_host_dispatch_json(
    host: *mut AndroidHost,
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
        Err(code) => return unsafe { ffi_write_error(output, format!("invalid input ({code})")) },
    };
    // SAFETY: null was checked above; JSON is copied by the runtime before the
    // JNI caller may release its input buffer.
    let host = unsafe { &mut *host };
    match host.dispatch_json(bytes) {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
pub unsafe extern "C" fn weapp_container_android_host_inspect_state(
    host: *mut AndroidHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    match unsafe { &*host }.inspect_state_json() {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
pub unsafe extern "C" fn weapp_container_android_host_resize_viewport(
    host: *mut AndroidHost,
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
    match unsafe { &mut *host }.notify_viewport_resize_json(width, height) {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// Update one complete window/display observation without recreating the host.
///
/// # Safety
/// Same pointer and buffer ownership rules as
/// [`weapp_container_android_host_dispatch_json`]. Input is UTF-8 JSON.
pub unsafe extern "C" fn weapp_container_android_host_update_window_metrics_json(
    host: *mut AndroidHost,
    data: *const u8,
    len: usize,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return write_load_error(output, "ERR_ENGINE", "host handle is null");
    }
    let input = match unsafe { ffi_input(data, len) } {
        Ok(input) => input,
        Err(code) => {
            return write_load_error(output, "ERR_RENDER", format!("invalid input ({code})"))
        }
    };
    match unsafe { &mut *host }.notify_window_metrics_json(input) {
        Ok(response) => unsafe { ffi_write(output, response) },
        Err(error) => {
            let code = match &error {
                container_host_common::HostSessionError::BridgeBatch(error) => error.code.as_str(),
                container_host_common::HostSessionError::NotLoaded => "ERR_ENGINE",
                _ => "ERR_RENDER",
            };
            write_load_error(output, code, error)
        }
    }
}

#[no_mangle]
/// # Safety
///
/// Same ownership rules as [`weapp_container_android_host_dispatch_json`], but the input
/// must be a canonical `{"messages":[...]}` batch. The host validates all
/// envelopes before dispatching the first one.
pub unsafe extern "C" fn weapp_container_android_host_dispatch_batch_json(
    host: *mut AndroidHost,
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
    // SAFETY: null was checked above; JSON is copied by the runtime before
    // the JNI caller may release its input buffer.
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
/// release it with `weapp_container_android_buffer_free`.
pub unsafe extern "C" fn weapp_container_android_host_render_snapshot(
    host: *mut AndroidHost,
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

/// Read committed-frame metadata without rasterizing or serializing pixels.
///
/// # Safety
/// `host` must be live and exclusively owned for the call; `output` must be an
/// empty caller-owned buffer freed with the matching Android buffer function.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_android_host_presentation_state(
    host: *const AndroidHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: validated above; the host owner excludes concurrent mutation.
    match unsafe { &*host }.presentation_state_json() {
        Ok(state) => unsafe { ffi_write(output, state) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

/// Attach the current EGL/GLES context to the host runtime. The caller must
/// have made an EGL context current on this thread before invoking it.
#[cfg(feature = "skia-gpu-gles")]
#[no_mangle]
/// # Safety
///
/// `host` must be a live handle returned by [`weapp_container_android_host_new`]. The
/// current thread must own a valid current EGL context for the lifetime of
/// this synchronous call.
pub unsafe extern "C" fn weapp_container_android_host_attach_gles_context(
    host: *mut AndroidHost,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and the JNI owner keeps the host alive for the
    // duration of this thread-affine call.
    let host = unsafe { &mut *host };
    match host.attach_gles_context() {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Render the latest committed frame to the currently bound GLES window FBO.
/// The caller owns the EGL swap and must invoke it only while the same EGL
/// context used by `weapp_container_android_host_attach_gles_context` is current.
#[cfg(feature = "skia-gpu-gles")]
#[no_mangle]
/// # Safety
///
/// `host` must be a live handle and `framebuffer` must identify a framebuffer
/// belonging to the current EGL window surface.
pub unsafe extern "C" fn weapp_container_android_host_render_gles_framebuffer(
    host: *mut AndroidHost,
    framebuffer: u32,
    width: u32,
    height: u32,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and the caller serializes access to the host.
    let host = unsafe { &mut *host };
    match host.render_last_frame_to_gles_framebuffer(framebuffer, width, height) {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Detach the current GLES context before the EGL context is destroyed.
#[cfg(feature = "skia-gpu-gles")]
#[no_mangle]
/// # Safety
///
/// `host` must be a live handle returned by [`weapp_container_android_host_new`].
/// The originally attached EGL context must be current on this owner thread.
pub unsafe extern "C" fn weapp_container_android_host_detach_gles_context(
    host: *mut AndroidHost,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and access is serialized by the EGL owner.
    let host = unsafe { &mut *host };
    match host.detach_gles_context() {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Forget an unusable GLES context without calling GL. Unlike detach, this
/// function does not require any current EGL context or window surface.
#[cfg(feature = "skia-gpu-gles")]
#[no_mangle]
/// # Safety
///
/// `host` must be live and exclusively accessed on its owner thread. The host
/// must stop rendering with the abandoned context before invoking this call.
pub unsafe extern "C" fn weapp_container_android_host_abandon_gles_context(
    host: *mut AndroidHost,
) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and the owner serializes host access.
    let host = unsafe { &mut *host };
    match host.abandon_gles_context() {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

#[no_mangle]
/// # Safety
///
/// The caller must pass a live host handle, a UTF-8 canvas id whose bytes stay
/// valid for the duration of this call, and an empty output buffer. The
/// returned JSON contains one complete RGBA snapshot for that canvas surface;
/// release it with `weapp_container_android_buffer_free`.
pub unsafe extern "C" fn weapp_container_android_host_canvas_snapshot(
    host: *mut AndroidHost,
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
    // SAFETY: null was checked above and the JNI owner keeps the host alive
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
pub unsafe extern "C" fn weapp_container_android_host_start(
    host: *mut AndroidHost,
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
            return unsafe { ffi_write_error(output, format!("invalid request id ({code})")) }
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
pub unsafe extern "C" fn weapp_container_android_host_lifecycle(
    host: *mut AndroidHost,
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
            return unsafe { ffi_write_error(output, format!("invalid request id ({code})")) }
        }
    };
    let event = match unsafe { ffi_input(event, event_len) }
        .and_then(|bytes| std::str::from_utf8(bytes).map_err(|_| FFI_INVALID_ARGUMENT))
    {
        Ok(value) => value,
        Err(code) => return unsafe { ffi_write_error(output, format!("invalid event ({code})")) },
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
/// interpreted as the session clock in nanoseconds.
pub unsafe extern "C" fn weapp_container_android_host_poll_timers(
    host: *mut AndroidHost,
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
