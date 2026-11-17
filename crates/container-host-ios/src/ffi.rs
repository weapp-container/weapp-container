//! Stable C ABI used by the Swift/Objective-C sample host.
//!
//! Swift calls these symbols through a tiny C header or
//! `@_silgen_name` declarations.  A call exchanges one complete JSON batch so
//! page trees and data patches are not sent node-by-node across the bridge.

#![allow(clippy::missing_safety_doc)]

use crate::IosHost;
use container_bridge::BridgeBatch;
use container_host_common::{
    ffi_buffer_free, ffi_input, ffi_write, ffi_write_error, FfiBuffer, FFI_ERR,
    FFI_INVALID_ARGUMENT, FFI_OK,
};
use container_runtime::{SessionConfig, SessionError};
#[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
use std::ffi::c_void;

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
pub extern "C" fn weapp_container_ios_host_new() -> *mut IosHost {
    Box::into_raw(Box::new(IosHost::new()))
}

#[no_mangle]
pub unsafe extern "C" fn weapp_container_ios_host_acknowledge_presentation(
    host: *mut IosHost,
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
pub unsafe extern "C" fn weapp_container_ios_host_free(host: *mut IosHost) {
    if !host.is_null() {
        // SAFETY: ownership was transferred by `weapp_container_ios_host_new`.
        drop(unsafe { Box::from_raw(host) });
    }
}

#[no_mangle]
/// Release the loaded runtime while retaining the reusable host handle.
/// Repeated unloads are successful. Dispatch `app.lifecycle` with `unload`
/// before calling this function when user lifecycle hooks must run.
///
/// # Safety
///
/// `host` must be a live handle owned exclusively by the calling thread.
pub unsafe extern "C" fn weapp_container_ios_host_unload(host: *mut IosHost) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked and the caller keeps the host alive.
    unsafe { &mut *host }.unload();
    FFI_OK
}

#[no_mangle]
/// # Safety
///
/// The caller must pass valid pointers and lengths for the duration of
/// the call, keep the opaque host handle alive, and free returned
/// buffers with the matching `*_buffer_free` function.
pub unsafe extern "C" fn weapp_container_ios_buffer_free(buffer: *mut FfiBuffer) {
    // SAFETY: callers pass buffers returned by this host's ABI.
    unsafe { ffi_buffer_free(buffer) };
}

#[no_mangle]
/// # Safety
///
/// `host` must be a handle returned by [`weapp_container_ios_host_new`] and `output` must
/// point to an empty caller-owned buffer.  The returned JSON distinguishes a
/// CPU raster surface from an attached Metal/GPU context.
pub unsafe extern "C" fn weapp_container_ios_host_capabilities(
    host: *const IosHost,
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
/// Read versioned navigation/viewport metadata without tree or pixel data.
///
/// # Safety
///
/// `host` must remain alive without concurrent mutation. `output` must point
/// to an empty caller-owned buffer released with the matching buffer free.
pub unsafe extern "C" fn weapp_container_ios_host_session_state(
    host: *const IosHost,
    output: *mut FfiBuffer,
) -> i32 {
    if output.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    if host.is_null() {
        return unsafe { ffi_write_error(output, "host handle is null") };
    }
    // SAFETY: the caller keeps this immutable handle alive for the read.
    let host = unsafe { &*host };
    match host.session_state_json() {
        Ok(state) => unsafe { ffi_write(output, state) },
        Err(error) => unsafe { ffi_write_error(output, error) },
    }
}

#[no_mangle]
/// Observe current page data without entering JS or advancing the runtime.
///
/// # Safety
///
/// `host` must stay alive without concurrent mutation. `output` must point
/// to an empty caller-owned buffer released with the matching buffer free.
pub unsafe extern "C" fn weapp_container_ios_host_inspect_state(
    host: *const IosHost,
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
/// This does not render; the owner must commit and present the next frame.
///
/// # Safety
///
/// `host` must be live and exclusively owned by the caller. `output` must
/// point to an empty caller-owned buffer released with the matching free.
pub unsafe extern "C" fn weapp_container_ios_host_resize_viewport(
    host: *mut IosHost,
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
    // SAFETY: null was checked and the caller keeps exclusive ownership.
    let host = unsafe { &mut *host };
    match host.notify_viewport_resize_json(width, height) {
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
pub unsafe extern "C" fn weapp_container_ios_host_load_manifest(
    host: *mut IosHost,
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
    // SAFETY: null was checked and the Swift owner keeps the host alive.
    let host = unsafe { &mut *host };
    match host.load_manifest_json(bytes, SessionConfig::default()) {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Load a manifest with an explicit engine and session configuration. Unlike
/// the legacy default entry point, errors are returned as JSON for Swift to
/// distinguish unavailable engines from invalid manifests. No engine fallback
/// is performed by this boundary.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_ios_host_load_manifest_with_config(
    host: *mut IosHost,
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
pub unsafe extern "C" fn weapp_container_ios_host_dispatch_json(
    host: *mut IosHost,
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
/// Same ownership rules as [`weapp_container_ios_host_dispatch_json`], but the input must
/// be a canonical `{"messages":[...]}` batch. The host validates all
/// envelopes before dispatching the first one.
pub unsafe extern "C" fn weapp_container_ios_host_dispatch_batch_json(
    host: *mut IosHost,
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
    // SAFETY: null was checked above; the Swift owner keeps the host alive for
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
/// release it with `weapp_container_ios_buffer_free`.
pub unsafe extern "C" fn weapp_container_ios_host_render_snapshot(
    host: *mut IosHost,
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

/// Attach an app-owned Metal device and command queue to the Rust Skia
/// renderer. A successful call only creates the Ganesh context; the GPU
/// surface becomes true after `weapp_container_ios_host_render_metal_texture` succeeds.
///
/// # Safety
///
/// `device` and `queue` must be live Objective-C MTLDevice/MTLCommandQueue
/// objects from the same device and remain valid while the host uses them.
#[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
#[no_mangle]
pub unsafe extern "C" fn weapp_container_ios_host_attach_metal_context(
    host: *mut IosHost,
    device: *const c_void,
    queue: *const c_void,
) -> i32 {
    if host.is_null() || device.is_null() || queue.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked above; the Swift owner keeps all objects alive.
    let host = unsafe { &mut *host };
    match unsafe { host.attach_metal_context(device, queue) } {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Render the last committed runtime frame into a CAMetalLayer drawable's
/// texture. The caller remains responsible for presenting/committing it.
///
/// # Safety
///
/// `host` and `texture` must be valid for the duration of this call. The
/// texture must belong to the current drawable and remain alive until the
/// caller commits its Metal command buffer.
#[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
#[no_mangle]
pub unsafe extern "C" fn weapp_container_ios_host_render_metal_texture(
    host: *mut IosHost,
    texture: *const c_void,
    width: u32,
    height: u32,
) -> i32 {
    if host.is_null() || texture.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked above; the Swift owner keeps the host/texture alive.
    let host = unsafe { &mut *host };
    match unsafe { host.render_last_frame_to_metal_texture(texture, width, height) } {
        Ok(()) => FFI_OK,
        Err(_) => FFI_ERR,
    }
}

/// Detach the Rust Skia Metal context before the app destroys the Metal
/// device or command queue.
#[cfg(all(feature = "skia-gpu-metal", target_os = "ios"))]
#[no_mangle]
pub unsafe extern "C" fn weapp_container_ios_host_detach_metal_context(host: *mut IosHost) -> i32 {
    if host.is_null() {
        return FFI_INVALID_ARGUMENT;
    }
    // SAFETY: null was checked above; the Swift owner keeps the host alive.
    let host = unsafe { &mut *host };
    match host.detach_metal_context() {
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
/// release it with `weapp_container_ios_buffer_free`.
pub unsafe extern "C" fn weapp_container_ios_host_canvas_snapshot(
    host: *mut IosHost,
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
    // SAFETY: null was checked above and the Swift owner keeps the host alive
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
pub unsafe extern "C" fn weapp_container_ios_host_start(
    host: *mut IosHost,
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
pub unsafe extern "C" fn weapp_container_ios_host_lifecycle(
    host: *mut IosHost,
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
/// the caller. `now_ns` is Unix-epoch nanoseconds, matching runtime and JS
/// timer scheduling; display-link uptime and session elapsed time are invalid.
pub unsafe extern "C" fn weapp_container_ios_host_poll_timers(
    host: *mut IosHost,
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
