//! Versioned C ABI. The public layout is exclusively defined in the C header.
//!
//! Session operations, including destruction, belong to their creating thread.
//! Frames and result buffers own allocations independent of the session and may
//! be consumed/released on other threads. C callers must supply valid pointers,
//! keep a live reference throughout a call, and never race access to an output
//! slot. No ABI can validate an arbitrary dangling foreign pointer.

use container_render_skia::RenderSnapshot;
use container_sdk::{ContainerConfig, ContainerSession, SdkError};
use serde_json::{json, Value};
use std::cell::{Cell, UnsafeCell};
use std::ffi::{c_char, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::Arc;
use std::thread::{self, ThreadId};

pub const ABI_VERSION: u32 = 1;
pub const OK: i32 = 0;
pub const ERROR: i32 = -1;
pub const INVALID_ARGUMENT: i32 = -2;

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SdkBuffer {
    pub data: *mut u8,
    pub len: usize,
}

impl Default for SdkBuffer {
    fn default() -> Self {
        Self {
            data: ptr::null_mut(),
            len: 0,
        }
    }
}

/// Opaque in C. Never access `state` before checking the immutable owner ID.
pub struct SdkSession {
    owner: ThreadId,
    busy: Cell<bool>,
    state: UnsafeCell<SessionState>,
}

struct CallGuard<'a>(&'a Cell<bool>);

impl Drop for CallGuard<'_> {
    fn drop(&mut self) {
        self.0.set(false);
    }
}

impl SdkSession {
    fn enter(&self) -> Result<CallGuard<'_>> {
        if self.busy.replace(true) {
            return Err(Failure::new(
                "ERR_REENTRANT",
                "session call cannot reenter the runtime",
            ));
        }
        Ok(CallGuard(&self.busy))
    }
}

struct SessionState {
    session: ContainerSession,
    poisoned: bool,
}

/// The Arc allocation never contains a runtime, renderer, or platform handle.
pub struct SdkFrame {
    revision: u64,
    snapshot: Arc<RenderSnapshot>,
}

#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct SdkFrameInfo {
    pub data: *const u8,
    pub len: usize,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub revision: u64,
}

#[derive(Debug)]
struct Failure {
    code: String,
    message: String,
}

impl Failure {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl From<SdkError> for Failure {
    fn from(error: SdkError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

type Result<T> = std::result::Result<T, Failure>;

unsafe fn input<'a>(data: *const u8, len: usize) -> Result<&'a [u8]> {
    if len == 0 {
        return Ok(&[]);
    }
    if data.is_null() || len > isize::MAX as usize {
        return Err(Failure::new(
            "ERR_INVALID_ARGUMENT",
            "invalid input pointer or length",
        ));
    }
    Ok(unsafe { std::slice::from_raw_parts(data, len) })
}

unsafe fn empty_output(output: *mut SdkBuffer) -> bool {
    !output.is_null() && unsafe { (*output).data.is_null() && (*output).len == 0 }
}

unsafe fn write(output: *mut SdkBuffer, value: Value) {
    let bytes = serde_json::to_vec(&value)
        .expect("JSON values are serializable")
        .into_boxed_slice();
    unsafe {
        (*output).len = bytes.len();
        (*output).data = Box::into_raw(bytes) as *mut u8;
    }
}

// Validate output before invoking the closure: refusing an occupied output
// must not accidentally execute a command or allocate a second live handle.
unsafe fn operation(output: *mut SdkBuffer, f: impl FnOnce() -> Result<Value>) -> i32 {
    if !unsafe { empty_output(output) } {
        return INVALID_ARGUMENT;
    }
    let outcome = catch_unwind(AssertUnwindSafe(f));
    match outcome {
        Ok(Ok(value)) => {
            unsafe { write(output, json!({"ok": true, "value": value})) };
            OK
        }
        Ok(Err(error)) => {
            unsafe {
                write(
                    output,
                    json!({"ok": false, "error": {"code": error.code, "message": error.message}}),
                )
            };
            ERROR
        }
        Err(_) => {
            unsafe {
                write(
                    output,
                    json!({"ok": false, "error": {"code": "ERR_PANIC", "message": "native SDK operation panicked"}}),
                )
            };
            ERROR
        }
    }
}

unsafe fn handle<'a>(session: *mut SdkSession) -> Result<&'a SdkSession> {
    let handle = unsafe { session.as_ref() }
        .ok_or_else(|| Failure::new("ERR_INVALID_ARGUMENT", "session is null"))?;
    if handle.owner != thread::current().id() {
        return Err(Failure::new(
            "ERR_WRONG_THREAD",
            "session must be used and destroyed on its creating thread",
        ));
    }
    Ok(handle)
}

unsafe fn session_operation(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
    allow_poisoned: bool,
    f: impl FnOnce(&mut ContainerSession) -> Result<Value>,
) -> i32 {
    unsafe {
        operation(output, || {
            let handle = handle(session)?;
            let _guard = handle.enter()?;
            let state = &mut *handle.state.get();
            if state.poisoned && !allow_poisoned {
                return Err(Failure::new(
                    "ERR_POISONED",
                    "session panicked; close and destroy it",
                ));
            }
            match catch_unwind(AssertUnwindSafe(|| f(&mut state.session))) {
                Ok(result) => result,
                Err(_) => {
                    state.poisoned = true;
                    Err(Failure::new(
                        "ERR_PANIC",
                        "session operation panicked; session is poisoned",
                    ))
                }
            }
        })
    }
}

#[no_mangle]
pub extern "C" fn weapp_container_sdk_abi_version() -> u32 {
    ABI_VERSION
}

#[no_mangle]
pub extern "C" fn weapp_container_sdk_version() -> *const c_char {
    concat!(env!("CARGO_PKG_VERSION"), "\0").as_ptr().cast()
}

/// # Safety
/// Input and output pointers must satisfy the public header's ownership rules.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_session_new(
    config: *const u8,
    config_len: usize,
    session_out: *mut *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        operation(output, || {
            if session_out.is_null() || !(*session_out).is_null() {
                return Err(Failure::new(
                    "ERR_INVALID_ARGUMENT",
                    "session output must be a null slot",
                ));
            }
            let bytes = input(config, config_len)?;
            let config: ContainerConfig = serde_json::from_slice(bytes)
                .map_err(|error| Failure::new("ERR_CONFIG", error.to_string()))?;
            let session = ContainerSession::new(config)?;
            *session_out = Box::into_raw(Box::new(SdkSession {
                owner: thread::current().id(),
                busy: Cell::new(false),
                state: UnsafeCell::new(SessionState {
                    session,
                    poisoned: false,
                }),
            }));
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// The session must be live; byte arrays and the empty output must be valid.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_session_command(
    session: *mut SdkSession,
    op: *const u8,
    op_len: usize,
    payload: *const u8,
    payload_len: usize,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        // These two passive SDK metadata reads never enter either JS realm or
        // run provider/render code. They remain usable to reconcile a lost
        // apply response after a native panic; no mutating command is revived.
        let passive = input(op, op_len)
            .is_ok_and(|bytes| bytes == b"acceptedPackIdentity" || bytes == b"queryDevPackAttempt");
        session_operation(session, output, passive, |session| {
            let op = std::str::from_utf8(input(op, op_len)?)
                .map_err(|error| Failure::new("ERR_INVALID_ARGUMENT", error.to_string()))?;
            let payload = serde_json::from_slice(input(payload, payload_len)?)
                .map_err(|error| Failure::new("ERR_JSON", error.to_string()))?;
            Ok(session.command(op, payload)?)
        })
    }
}

/// # Safety
/// Called on the owner thread after detaching/abandoning any GPU surface.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_session_close(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, true, |session| {
            session.close()?;
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// Slot must exclusively own its handle. Success clears the slot. A failure
/// to close (for example an attached GPU surface) retains it for recovery.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_session_destroy(
    slot: *mut *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        operation(output, || {
            if slot.is_null() {
                return Err(Failure::new("ERR_INVALID_ARGUMENT", "session slot is null"));
            }
            if (*slot).is_null() {
                return Ok(Value::Null);
            }
            let owner = handle(*slot)?;
            {
                let _guard = owner.enter()?;
                let state = &mut *owner.state.get();
                match catch_unwind(AssertUnwindSafe(|| state.session.close())) {
                    Ok(result) => result?,
                    Err(_) => {
                        state.poisoned = true;
                        return Err(Failure::new(
                            "ERR_PANIC",
                            "session close panicked; handle retained",
                        ));
                    }
                }
            }
            let owned = *slot;
            *slot = ptr::null_mut();
            drop(Box::from_raw(owned));
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// Buffer must be empty or the unmodified result of this library. The same
/// slot cannot be freed concurrently. The slot is cleared before deallocation.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_buffer_free(buffer: *mut SdkBuffer) {
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        if buffer.is_null() {
            return;
        }
        let owned = *buffer;
        *buffer = SdkBuffer::default();
        if !owned.data.is_null() {
            drop(Box::from_raw(ptr::slice_from_raw_parts_mut(
                owned.data, owned.len,
            )));
        }
    }));
}

/// # Safety
/// Called on the session owner thread with a null frame output slot.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_frame_acquire(
    session: *mut SdkSession,
    frame_out: *mut *const SdkFrame,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            if frame_out.is_null() || !(*frame_out).is_null() {
                return Err(Failure::new(
                    "ERR_INVALID_ARGUMENT",
                    "frame output must be a null slot",
                ));
            }
            let (revision, snapshot) = session
                .frame_snapshot_shared()?
                .ok_or_else(|| Failure::new("ERR_NO_FRAME", "session has no completed frame"))?;
            *frame_out = Arc::into_raw(Arc::new(SdkFrame { revision, snapshot }));
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// `frame` must own a live reference for this entire call. May run on any thread.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_frame_retain(
    frame: *const SdkFrame,
    frame_out: *mut *const SdkFrame,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        operation(output, || {
            if frame.is_null() || frame_out.is_null() || !(*frame_out).is_null() {
                return Err(Failure::new(
                    "ERR_INVALID_ARGUMENT",
                    "retain requires a live frame and null output slot",
                ));
            }
            Arc::increment_strong_count(frame);
            *frame_out = frame;
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// Slot owns one reference. May run on any thread; success clears the slot.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_frame_release(
    slot: *mut *const SdkFrame,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        operation(output, || {
            if slot.is_null() {
                return Err(Failure::new("ERR_INVALID_ARGUMENT", "frame slot is null"));
            }
            let frame = *slot;
            *slot = ptr::null();
            if !frame.is_null() {
                drop(Arc::from_raw(frame));
            }
            Ok(Value::Null)
        })
    }
}

/// # Safety
/// Frame remains retained while reading `info.data`. May run on any thread.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_frame_info(
    frame: *const SdkFrame,
    info: *mut SdkFrameInfo,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        operation(output, || {
            let frame = frame
                .as_ref()
                .ok_or_else(|| Failure::new("ERR_INVALID_ARGUMENT", "frame is null"))?;
            if info.is_null() {
                return Err(Failure::new("ERR_INVALID_ARGUMENT", "frame info is null"));
            }
            *info = SdkFrameInfo {
                data: frame.snapshot.pixels.as_ptr(),
                len: frame.snapshot.pixels.len(),
                width: frame.snapshot.width,
                height: frame.snapshot.height,
                stride: frame.snapshot.stride,
                revision: frame.revision,
            };
            Ok(Value::Null)
        })
    }
}

#[cfg(not(all(
    feature = "skia-gpu-gles",
    feature = "skia-gpu-metal",
    any(target_os = "macos", target_os = "ios")
)))]
fn unsupported(backend: &str) -> Failure {
    Failure::new(
        "ERR_UNSUPPORTED",
        format!("{backend} is not compiled for this target"),
    )
}

/// # Safety
/// A valid GLES context must be current on the owner thread until detach.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_gles_attach(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            #[cfg(feature = "skia-gpu-gles")]
            {
                session.attach_surface("sdk-gles")?;
                let result = session.attach_gles_context();
                if let Err(error) = result {
                    let _ = session.detach_surface("sdk-gles");
                    return Err(error.into());
                }
                Ok(Value::Null)
            }
            #[cfg(not(feature = "skia-gpu-gles"))]
            {
                let _ = session;
                Err(unsupported("GLES"))
            }
        })
    }
}

/// Host resolver for desktop GL/GLES symbols. Names are NUL-terminated and
/// borrowed only during the call. The callback and user data are not retained.
pub type SdkGlProcResolver = unsafe extern "C" fn(
    user_data: *mut std::ffi::c_void,
    name: *const std::ffi::c_char,
) -> *const std::ffi::c_void;

/// # Safety
/// A compatible GL context must be current on the session owner thread.
/// `resolver` must return correct function pointers for that context. User data
/// must remain valid until this synchronous function returns. The context must
/// remain valid until gles_detach or be explicitly abandoned after context loss.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_gl_attach_with_resolver(
    session: *mut SdkSession,
    resolver: Option<SdkGlProcResolver>,
    user_data: *mut std::ffi::c_void,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            let resolver = resolver
                .ok_or_else(|| Failure::new("ERR_INVALID_ARGUMENT", "GL resolver is null"))?;
            #[cfg(feature = "skia-gpu-gles")]
            {
                session.attach_surface("sdk-gles")?;
                let result = session.attach_gl_context_with(|name| {
                    // Skia symbol names are static ASCII. Reject an invalid
                    // name instead of allowing a callback to read past it.
                    let Ok(name) = std::ffi::CString::new(name) else {
                        return std::ptr::null();
                    };
                    resolver(user_data, name.as_ptr())
                });
                if let Err(error) = result {
                    let _ = session.detach_surface("sdk-gles");
                    return Err(error.into());
                }
                Ok(Value::Null)
            }
            #[cfg(not(feature = "skia-gpu-gles"))]
            {
                let _ = (session, resolver, user_data);
                Err(unsupported("GL"))
            }
        })
    }
}

/// # Safety
/// Framebuffer belongs to the current owner-thread GLES context. Host swaps it.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_gles_present(
    session: *mut SdkSession,
    framebuffer: u32,
    width: u32,
    height: u32,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            #[cfg(feature = "skia-gpu-gles")]
            {
                session.render_last_frame_to_gles_framebuffer(framebuffer, width, height)?;
                Ok(Value::Null)
            }
            #[cfg(not(feature = "skia-gpu-gles"))]
            {
                let _ = (session, framebuffer, width, height);
                Err(unsupported("GLES"))
            }
        })
    }
}

unsafe fn gles_detach(session: *mut SdkSession, abandon: bool, output: *mut SdkBuffer) -> i32 {
    unsafe {
        session_operation(session, output, true, |session| {
            #[cfg(feature = "skia-gpu-gles")]
            {
                session.detach_gles_context(abandon)?;
                session.detach_surface("sdk-gles")?;
                Ok(Value::Null)
            }
            #[cfg(not(feature = "skia-gpu-gles"))]
            {
                let _ = (session, abandon);
                Err(unsupported("GLES"))
            }
        })
    }
}

/// # Safety
/// Call on the owner thread while its GLES context is current.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_gles_detach(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe { gles_detach(session, false, output) }
}

/// # Safety
/// Owner-thread recovery after context loss; never issues commands to the lost context.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_gles_abandon(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe { gles_detach(session, true, output) }
}

/// # Safety
/// Device and queue are retained live Metal objects from the same device.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_metal_attach(
    session: *mut SdkSession,
    device: *const c_void,
    queue: *const c_void,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            {
                if device.is_null() || queue.is_null() {
                    return Err(Failure::new(
                        "ERR_INVALID_ARGUMENT",
                        "Metal device and queue must be non-null",
                    ));
                }
                session.attach_surface("sdk-metal")?;
                let result = session.attach_metal_context(device, queue);
                if let Err(error) = result {
                    let _ = session.detach_surface("sdk-metal");
                    return Err(error.into());
                }
                Ok(Value::Null)
            }
            #[cfg(not(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            )))]
            {
                let _ = (session, device, queue);
                Err(unsupported("Metal"))
            }
        })
    }
}

/// # Safety
/// Texture is a live same-device, non-framebuffer-only 2D BGRA8Unorm render
/// target with sample count one and matching dimensions. Drawable and offscreen
/// textures are supported; host retains them through GPU completion and owns
/// presentation/synchronization.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_metal_present(
    session: *mut SdkSession,
    texture: *const c_void,
    width: u32,
    height: u32,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, false, |session| {
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            {
                session.render_last_frame_to_metal_texture(texture, width, height)?;
                Ok(Value::Null)
            }
            #[cfg(not(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            )))]
            {
                let _ = (session, texture, width, height);
                Err(unsupported("Metal"))
            }
        })
    }
}

/// # Safety
/// Owner-thread call after stopping presentation and completing pending GPU work.
#[no_mangle]
pub unsafe extern "C" fn weapp_container_sdk_metal_detach(
    session: *mut SdkSession,
    output: *mut SdkBuffer,
) -> i32 {
    unsafe {
        session_operation(session, output, true, |session| {
            #[cfg(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            ))]
            {
                session.detach_metal_context()?;
                session.detach_surface("sdk-metal")?;
                Ok(Value::Null)
            }
            #[cfg(not(all(
                feature = "skia-gpu-metal",
                any(target_os = "macos", target_os = "ios")
            )))]
            {
                let _ = session;
                Err(unsupported("Metal"))
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn consume(output: &mut SdkBuffer) -> Value {
        let value =
            serde_json::from_slice(unsafe { std::slice::from_raw_parts(output.data, output.len) })
                .unwrap();
        unsafe { weapp_container_sdk_buffer_free(output) };
        value
    }

    unsafe fn new_session() -> *mut SdkSession {
        let mut session = ptr::null_mut();
        let mut output = SdkBuffer::default();
        assert_eq!(
            unsafe {
                weapp_container_sdk_session_new(b"{}".as_ptr(), 2, &mut session, &mut output)
            },
            OK
        );
        assert_eq!(unsafe { consume(&mut output) }["ok"], true);
        assert!(!session.is_null());
        session
    }

    unsafe fn destroy(session: &mut *mut SdkSession) {
        let mut output = SdkBuffer::default();
        assert_eq!(
            unsafe { weapp_container_sdk_session_destroy(session, &mut output) },
            OK
        );
        unsafe { consume(&mut output) };
        assert!(session.is_null());
    }

    #[test]
    fn invalid_json_and_occupied_outputs_never_publish_or_overwrite_handles() {
        unsafe {
            let mut session = ptr::null_mut();
            let mut output = SdkBuffer::default();
            assert_eq!(
                weapp_container_sdk_session_new(b"{".as_ptr(), 1, &mut session, &mut output),
                ERROR
            );
            assert!(session.is_null());
            let original = output;
            assert_eq!(
                weapp_container_sdk_session_new(b"{}".as_ptr(), 2, &mut session, &mut output),
                INVALID_ARGUMENT
            );
            assert_eq!((output.data, output.len), (original.data, original.len));
            assert!(session.is_null());
            assert_eq!(consume(&mut output)["error"]["code"], "ERR_CONFIG");
            weapp_container_sdk_buffer_free(&mut output);
            assert!(output.data.is_null());
            assert_eq!(output.len, 0);
        }
    }

    #[test]
    fn wrong_thread_command_and_destroy_preserve_the_owner_handle() {
        unsafe {
            let mut session = new_session();
            let address = session as usize;
            thread::spawn(move || {
                let mut foreign = address as *mut SdkSession;
                let mut output = SdkBuffer::default();
                assert_eq!(
                    weapp_container_sdk_session_command(
                        foreign,
                        b"state".as_ptr(),
                        5,
                        b"{}".as_ptr(),
                        2,
                        &mut output
                    ),
                    ERROR
                );
                assert_eq!(consume(&mut output)["error"]["code"], "ERR_WRONG_THREAD");
                assert_eq!(
                    weapp_container_sdk_session_destroy(&mut foreign, &mut output),
                    ERROR
                );
                assert_eq!(consume(&mut output)["error"]["code"], "ERR_WRONG_THREAD");
                assert_eq!(foreign as usize, address);
            })
            .join()
            .unwrap();
            destroy(&mut session);
            destroy(&mut session);
        }
    }

    #[test]
    fn panic_poisoning_and_reentry_are_contained_before_another_runtime_borrow() {
        unsafe {
            let mut session = new_session();
            let mut output = SdkBuffer::default();
            assert_eq!(
                session_operation(session, &mut output, false, |_| {
                    let mut nested = SdkBuffer::default();
                    assert_eq!(
                        weapp_container_sdk_session_close(session, &mut nested),
                        ERROR
                    );
                    assert_eq!(consume(&mut nested)["error"]["code"], "ERR_REENTRANT");
                    Ok(Value::Null)
                }),
                OK
            );
            consume(&mut output);
            assert_eq!(
                session_operation(session, &mut output, false, |_| panic!("test panic")),
                ERROR
            );
            assert_eq!(consume(&mut output)["error"]["code"], "ERR_PANIC");
            assert_eq!(
                weapp_container_sdk_session_command(
                    session,
                    b"state".as_ptr(),
                    5,
                    b"{}".as_ptr(),
                    2,
                    &mut output
                ),
                ERROR
            );
            assert_eq!(consume(&mut output)["error"]["code"], "ERR_POISONED");
            let operation = b"acceptedPackIdentity";
            assert_eq!(
                weapp_container_sdk_session_command(
                    session,
                    operation.as_ptr(),
                    operation.len(),
                    b"{}".as_ptr(),
                    2,
                    &mut output
                ),
                OK
            );
            let passive = consume(&mut output);
            assert_eq!(passive["ok"], true);
            assert!(passive["value"].is_null());
            assert_eq!(weapp_container_sdk_session_close(session, &mut output), OK);
            consume(&mut output);
            destroy(&mut session);
        }
    }

    #[test]
    fn retained_frames_are_immutable_and_independent_of_the_releasing_thread() {
        unsafe {
            let mut original = Arc::into_raw(Arc::new(SdkFrame {
                revision: 37,
                snapshot: Arc::new(RenderSnapshot {
                    frame_id: 1,
                    width: 2,
                    height: 1,
                    stride: 8,
                    format: "rgba8-premultiplied".into(),
                    pixels: vec![10, 20, 30, 255, 4, 5, 6, 7],
                }),
            }));
            let mut retained = ptr::null();
            let mut output = SdkBuffer::default();
            assert_eq!(
                weapp_container_sdk_frame_retain(original, &mut retained, &mut output),
                OK
            );
            consume(&mut output);
            assert_eq!(
                weapp_container_sdk_frame_release(&mut original, &mut output),
                OK
            );
            consume(&mut output);
            assert!(original.is_null());
            let address = retained as usize;
            thread::spawn(move || {
                let mut retained = address as *const SdkFrame;
                let mut output = SdkBuffer::default();
                let mut info = std::mem::MaybeUninit::uninit();
                assert_eq!(
                    weapp_container_sdk_frame_info(retained, info.as_mut_ptr(), &mut output),
                    OK
                );
                consume(&mut output);
                let info = info.assume_init();
                assert_eq!(
                    (info.width, info.height, info.stride, info.revision),
                    (2, 1, 8, 37)
                );
                assert_eq!(
                    std::slice::from_raw_parts(info.data, info.len),
                    &[10, 20, 30, 255, 4, 5, 6, 7]
                );
                assert_eq!(
                    weapp_container_sdk_frame_release(&mut retained, &mut output),
                    OK
                );
                consume(&mut output);
                assert!(retained.is_null());
                assert_eq!(
                    weapp_container_sdk_frame_release(&mut retained, &mut output),
                    OK
                );
                consume(&mut output);
            })
            .join()
            .unwrap();
        }
    }

    #[test]
    fn explicit_gl_resolver_rejects_null_before_surface_attachment() {
        unsafe {
            let mut session = new_session();
            let mut output = SdkBuffer::default();
            assert_eq!(
                weapp_container_sdk_gl_attach_with_resolver(
                    session,
                    None,
                    ptr::null_mut(),
                    &mut output
                ),
                ERROR
            );
            assert_eq!(
                consume(&mut output)["error"]["code"],
                "ERR_INVALID_ARGUMENT"
            );
            // Rejection must not poison or attach a surface to the session.
            assert_eq!(
                weapp_container_sdk_session_command(
                    session,
                    b"state".as_ptr(),
                    5,
                    b"{}".as_ptr(),
                    2,
                    &mut output
                ),
                OK
            );
            assert_eq!(consume(&mut output)["value"]["status"], "empty");
            destroy(&mut session);
        }
    }

    #[test]
    fn no_frame_and_unsupported_backends_return_structured_errors() {
        unsafe {
            let mut session = new_session();
            let mut output = SdkBuffer::default();
            let mut frame = ptr::null();
            assert_eq!(
                weapp_container_sdk_frame_acquire(session, &mut frame, &mut output),
                ERROR
            );
            assert_eq!(consume(&mut output)["error"]["code"], "ERR_NO_FRAME");
            assert!(frame.is_null());
            #[cfg(not(feature = "skia-gpu-gles"))]
            {
                assert_eq!(weapp_container_sdk_gles_attach(session, &mut output), ERROR);
                assert_eq!(consume(&mut output)["error"]["code"], "ERR_UNSUPPORTED");
            }
            destroy(&mut session);
        }
    }
}
