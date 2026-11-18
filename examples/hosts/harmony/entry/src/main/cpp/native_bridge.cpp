#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdint>
#include <new>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include "napi/native_api.h"
#include "native_window/external_window.h"
#include "bridge_numbers.h"
#include "weapp_container_harmony_ffi.h"

namespace {
// N-API may load this module in more than one VM environment (for example a
// UI Ability and a worker). A process-global host would make those sessions
// share a thread-affine Rust handle and let one environment destroy another's
// runtime. Legacy exports keep one owner per napi_env; createOwner binds a
// separate state to each new object's retained native callbacks.
struct HostState {
    void* host = nullptr;
    bool ownerScoped = false;
    bool closed = false;
    // EGL and Skia handles are thread-affine. Keep them beside the host
    // handle and touch them only from the XComponent callback thread.
    OHNativeWindow* nativeWindow = nullptr;
    EGLDisplay display = EGL_NO_DISPLAY;
    EGLSurface surface = EGL_NO_SURFACE;
    EGLContext context = EGL_NO_CONTEXT;
    EGLConfig config = nullptr;
    bool rustContextAttached = false;
    uint32_t surfaceWidth = 0;
    uint32_t surfaceHeight = 0;
};

constexpr char kDefaultManifest[] =
    R"({"schemaVersion":1,"protocolVersion":"1.0","compiler":{"name":"weapp-vite","commit":"harmony-sample","platform":"weapp"},"app":{"appJson":"app.json","entryModule":"app.js"},"capabilities":{"wx.getStorage":"full"},"integrity":{"algorithm":"sha256","root":""}})";

bool ReadString(napi_env env, napi_value value, std::string* out) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
        return false;
    }
    size_t length = 0;
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) {
        return false;
    }
    std::string valueBuffer(length + 1, '\0');
    size_t written = 0;
    if (napi_get_value_string_utf8(env, value, valueBuffer.data(), length + 1, &written) != napi_ok) {
        return false;
    }
    valueBuffer.resize(written);
    *out = std::move(valueBuffer);
    return true;
}

napi_value MakeString(napi_env env, const char* data, size_t length) {
    napi_value result;
    if (napi_create_string_utf8(env, data, length, &result) != napi_ok) {
        return nullptr;
    }
    return result;
}

napi_value MakeStatus(napi_env env, const char* status) {
    return MakeString(env, status, std::strlen(status));
}

std::string EglError(const char* operation, EGLint error = eglGetError()) {
    return std::string("{\"ok\":false,\"error\":\"ERR_RENDER\",\"operation\":\"") +
           operation + "\",\"eglError\":" +
           std::to_string(static_cast<unsigned int>(error)) + "}";
}

bool ReadUint32(napi_env env, napi_value value, uint32_t* out) {
    double number = 0;
    if (out == nullptr || napi_get_value_double(env, value, &number) != napi_ok ||
        !std::isfinite(number) || number < 0 || number > UINT32_MAX || std::floor(number) != number) {
        return false;
    }
    *out = static_cast<uint32_t>(number);
    return true;
}

napi_value BufferResult(napi_env env, int32_t status, WeappContainerFfiBuffer* output) {
    napi_value result = nullptr;
    if (output != nullptr && output->data != nullptr) {
        result = MakeString(env, reinterpret_cast<const char*>(output->data), output->len);
    } else if (status == WEAPP_CONTAINER_FFI_OK) {
        result = MakeStatus(env, "{\"ok\":true}");
    } else {
        result = MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    if (output != nullptr) {
        weapp_container_harmony_buffer_free(output);
    }
    return result;
}

// Empty means every owned handle was retired. On failure, each successfully
// released handle is cleared immediately; a later explicit retry never
// destroys it twice and cannot replace a still-owned context/window.
std::string DetachSurface(HostState* state) {
    if (state == nullptr) return {};
    if (state->rustContextAttached) {
        if (state->host == nullptr) {
            return "{\"ok\":false,\"error\":\"ERR_ENGINE\",\"operation\":\"rust-context-owner-missing\"}";
        }
        WeappContainerFfiBuffer output{nullptr, 0};
        const bool current = state->display != EGL_NO_DISPLAY && state->context != EGL_NO_CONTEXT &&
            eglMakeCurrent(state->display, state->surface, state->surface, state->context) == EGL_TRUE;
        const int32_t detached = current
            ? weapp_container_harmony_host_detach_gles_context(state->host, &output)
            : WEAPP_CONTAINER_FFI_ERR;
        weapp_container_harmony_buffer_free(&output);
        if (!current || detached != WEAPP_CONTAINER_FFI_OK) {
            // Lost contexts cannot safely delete driver resources. Abandon
            // Rust's handles before destroying the platform context/window.
            const int32_t abandoned = weapp_container_harmony_host_abandon_gles_context(state->host);
            if (abandoned != WEAPP_CONTAINER_FFI_OK) {
                // Rust still owns driver handles: preserve EGL until it can
                // detach or abandon, rather than destroying underneath Skia.
                return std::string("{\"ok\":false,\"error\":\"ERR_ENGINE\",\"operation\":\"rust-context-abandon\",\"status\":") +
                    std::to_string(abandoned) + "}";
            }
        }
        state->rustContextAttached = false;
    }
    std::string failure;
    auto remember = [&failure](const char* operation, EGLint code) {
        if (failure.empty()) failure = EglError(operation, code);
    };
    if (state->display != EGL_NO_DISPLAY) {
        if (eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT) != EGL_TRUE) {
            const EGLint error = eglGetError();
            // A lost context has already been abandoned above. Unbinding an
            // identity the driver invalidated cannot leave live Skia handles.
            if (error != EGL_CONTEXT_LOST && error != EGL_BAD_CONTEXT && error != EGL_BAD_SURFACE &&
                error != EGL_BAD_DISPLAY && error != EGL_NOT_INITIALIZED) {
                // Unknown failure can leave a live context current. Preserve
                // EGL ownership until a later explicit attempt can unbind it.
                return EglError("eglMakeCurrent-detach", error);
            }
        }
        if (state->surface != EGL_NO_SURFACE) {
            if (eglDestroySurface(state->display, state->surface) == EGL_TRUE) state->surface = EGL_NO_SURFACE;
            else {
                const EGLint error = eglGetError();
                // BAD_SURFACE proves there is no longer an owned EGLSurface.
                if (error == EGL_BAD_SURFACE) state->surface = EGL_NO_SURFACE;
                else remember("eglDestroySurface", error);
            }
        }
        if (state->context != EGL_NO_CONTEXT) {
            if (eglDestroyContext(state->display, state->context) == EGL_TRUE) state->context = EGL_NO_CONTEXT;
            else {
                const EGLint error = eglGetError();
                if (error == EGL_BAD_CONTEXT) state->context = EGL_NO_CONTEXT;
                else remember("eglDestroyContext", error);
            }
        }
        if (state->surface == EGL_NO_SURFACE && state->context == EGL_NO_CONTEXT) {
            // EGL_DEFAULT_DISPLAY is a process-wide connection also used by
            // sibling owners and potentially ArkUI/the embedding host. This
            // owner borrows it; eglInitialize is idempotent, not reference
            // counted. eglTerminate here would invalidate unrelated owners.
            // All owned contexts/surfaces are gone; leave display termination
            // to the process/host and release only this owner's reference.
            state->display = EGL_NO_DISPLAY;
            state->config = nullptr;
        }
    }
    if (state->display == EGL_NO_DISPLAY && state->surface == EGL_NO_SURFACE && state->context == EGL_NO_CONTEXT) {
        if (state->nativeWindow != nullptr) OH_NativeWindow_DestroyNativeWindow(state->nativeWindow);
        state->nativeWindow = nullptr;
        state->surfaceWidth = 0;
        state->surfaceHeight = 0;
    }
    return failure;
}

void FinalizeHostState(napi_env, void* data, void*) {
    auto* state = static_cast<HostState*>(data);
    if (state == nullptr) return;
    // Ensure Skia releases all GL handles before the EGL context/window dies.
    const std::string retired = DetachSurface(state);
    if (!retired.empty()) {
        std::fprintf(stderr, "[weapp-container] Harmony finalizer cleanup failed: %s\n", retired.c_str());
        if (state->rustContextAttached || state->display != EGL_NO_DISPLAY ||
            state->surface != EGL_NO_SURFACE || state->context != EGL_NO_CONTEXT || state->nativeWindow != nullptr) {
            // No JavaScript retry remains during finalization. Preserve an
            // unsafe-to-release owner instead of freeing beneath live handles.
            std::fprintf(stderr, "[weapp-container] Harmony native owner retained after failed finalization\n");
            return;
        }
    }
    if (state->host != nullptr) {
        weapp_container_harmony_host_free(state->host);
        state->host = nullptr;
    }
    delete state;
}

struct BoundHostCallback { std::shared_ptr<HostState> state; };

void FinalizeBoundCallback(napi_env, void* data, void*) {
    delete static_cast<BoundHostCallback*>(data);
}

HostState* GetHostState(napi_env env, napi_callback_info info = nullptr) {
    // Scoped methods carry their own retained state. Retaining an extracted
    // function also retains its owner, so GC of the object cannot free a live
    // callback's Rust/EGL state. Legacy exports continue to use env state.
    if (info != nullptr) {
        void* binding = nullptr;
        size_t argc = 0;
        if (napi_get_cb_info(env, info, &argc, nullptr, nullptr, &binding) != napi_ok) return nullptr;
        if (binding != nullptr) {
            auto* state = static_cast<BoundHostCallback*>(binding)->state.get();
            return state->closed ? nullptr : state;
        }
    }
    void* data = nullptr;
    if (napi_get_instance_data(env, &data) != napi_ok) return nullptr;
    if (data != nullptr) return static_cast<HostState*>(data);
    auto* state = new (std::nothrow) HostState();
    if (state == nullptr) return nullptr;
    if (napi_set_instance_data(env, state, FinalizeHostState, nullptr) != napi_ok) {
        delete state;
        return nullptr;
    }
    return state;
}

napi_value Start(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }

    std::string manifest(kDefaultManifest);
    std::string requestId("harmony-init");
    std::string first;
    // `start(requestId)` remains accepted for the original sample API.  A
    // JSON-looking first argument is treated as the portable manifest;
    // callers may pass `start(manifestJson, requestId)` for production use.
    if (argc > 0 && !ReadString(env, argv[0], &first)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    if (!first.empty() && first.front() == '{') {
        manifest = first;
        if (argc > 1 && !ReadString(env, argv[1], &requestId)) {
            return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
        }
    } else if (!first.empty()) {
        requestId = first;
    }

    auto* state = GetHostState(env, info);
    if (state == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    if (state->host == nullptr) {
        state->host = weapp_container_harmony_host_new();
    }
    if (state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    if (state->rustContextAttached) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_REQUEST\",\"operation\":\"detach-before-load\"}");
    }
    if (weapp_container_harmony_host_load_manifest(state->host, reinterpret_cast<const uint8_t*>(manifest.data()),
                                       manifest.size()) != WEAPP_CONTAINER_FFI_OK) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_MANIFEST\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_start(
        state->host, reinterpret_cast<const uint8_t*>(requestId.data()), requestId.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value LoadManifest(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    std::string manifest;
    if (!ReadString(env, argv[0], &manifest) || manifest.empty()) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    if (state->host == nullptr) {
        state->host = weapp_container_harmony_host_new();
    }
    if (state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    // Replacing a session also replaces its renderer. The surface owner must
    // detach first so a new renderer cannot inherit a stale attachment flag.
    if (state->rustContextAttached) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_REQUEST\",\"operation\":\"detach-before-load\"}");
    }
    const int32_t status = weapp_container_harmony_host_load_manifest(
        state->host, reinterpret_cast<const uint8_t*>(manifest.data()), manifest.size());
    return status == WEAPP_CONTAINER_FFI_OK
        ? MakeStatus(env, "{\"ok\":true}")
        : MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_MANIFEST\"}");
}

napi_value LoadManifestWithConfig(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    std::string manifest;
    std::string config;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
        !ReadString(env, argv[0], &manifest) || manifest.empty() ||
        !ReadString(env, argv[1], &config) || config.empty()) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr) return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    if (state->rustContextAttached) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_REQUEST\",\"operation\":\"detach-before-load\"}");
    }
    if (state->host == nullptr) state->host = weapp_container_harmony_host_new();
    if (state->host == nullptr) return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_load_manifest_with_config(
        state->host, reinterpret_cast<const uint8_t*>(manifest.data()), manifest.size(),
        reinterpret_cast<const uint8_t*>(config.data()), config.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value Dispatch(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    std::string envelope;
    auto* state = GetHostState(env, info);
    if (!ReadString(env, argv[0], &envelope) || state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_dispatch_json(
        state->host, reinterpret_cast<const uint8_t*>(envelope.data()), envelope.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value DispatchBatch(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    std::string batch;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        !ReadString(env, argv[0], &batch)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_dispatch_batch_json(
        state->host, reinterpret_cast<const uint8_t*>(batch.data()), batch.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value HostServices(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    std::string command;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        !ReadString(env, argv[0], &command) || command.size() > 8 * 1024 * 1024) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr) return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    if (state->host == nullptr) state->host = weapp_container_harmony_host_new();
    if (state->host == nullptr) return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_services_json(state->host,
        reinterpret_cast<const uint8_t*>(command.data()), command.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value InspectState(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_inspect_state(state->host, &output);
    return BufferResult(env, status, &output);
}

napi_value ResizeViewport(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    uint32_t width = 0;
    uint32_t height = 0;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
        !ReadUint32(env, argv[0], &width) || !ReadUint32(env, argv[1], &height) || width == 0 || height == 0) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_resize_viewport(state->host, width, height, &output);
    return BufferResult(env, status, &output);
}

napi_value PollTimers(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    std::string clock;
    uint64_t nowNs = 0;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        !ReadString(env, argv[0], &clock) || !weapp_container::ParseUint64(clock, &nowNs)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"nowNs\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_poll_timers(state->host, nowNs, &output);
    return BufferResult(env, status, &output);
}

napi_value AcknowledgePresentation(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    std::string revisionText;
    uint64_t revision = 0;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1 ||
        !ReadString(env, argv[0], &revisionText) || !weapp_container::ParseUint64(revisionText, &revision) || revision == 0) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"renderRevision\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_acknowledge_presentation(state->host, revision, &output);
    return BufferResult(env, status, &output);
}

napi_value Lifecycle(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    std::string requestId;
    std::string event;
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 2 ||
        !ReadString(env, argv[0], &requestId) || !ReadString(env, argv[1], &event)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_lifecycle(
        state->host, reinterpret_cast<const uint8_t*>(requestId.data()), requestId.size(),
        reinterpret_cast<const uint8_t*>(event.data()), event.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value Capabilities(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    if (state == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    if (state->host == nullptr) {
        state->host = weapp_container_harmony_host_new();
    }
    if (state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_capabilities(state->host, &output);
    return BufferResult(env, status, &output);
}

napi_value Snapshot(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_render_snapshot(state->host, &output);
    return BufferResult(env, status, &output);
}

napi_value AttachSurface(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value argv[3] = {nullptr, nullptr, nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc < 1 || argc > 3) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    std::string surfaceIdText;
    uint64_t surfaceId = 0;
    if (!ReadString(env, argv[0], &surfaceIdText) || surfaceIdText.empty()) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    if (!weapp_container::ParseUint64(surfaceIdText, &surfaceId) || surfaceId == 0) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"surfaceId\"}");
    }
    uint32_t width = 0;
    uint32_t height = 0;
    if (argc >= 2 && !ReadUint32(env, argv[1], &width)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"width\"}");
    }
    if (argc >= 3 && !ReadUint32(env, argv[2], &height)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"height\"}");
    }
    if (width == 0) width = 1;
    if (height == 0) height = 1;
    if (width > INT32_MAX || height > INT32_MAX) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"viewport\"}");
    }

    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    }
    // Re-attaching is an explicit replacement operation. It is used for
    // rotation/resize and keeps the Rust session alive while the EGL window
    // is replaced.
    const std::string retired = DetachSurface(state);
    if (!retired.empty()) return MakeString(env, retired.data(), retired.size());
    if (OH_NativeWindow_CreateNativeWindowFromSurfaceId(surfaceId, &state->nativeWindow) != 0 ||
        state->nativeWindow == nullptr) {
        DetachSurface(state);
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_RENDER\",\"operation\":\"native-window\"}");
    }
    state->display = eglGetDisplay(EGL_DEFAULT_DISPLAY);
    if (state->display == EGL_NO_DISPLAY || eglInitialize(state->display, nullptr, nullptr) != EGL_TRUE) {
        const std::string error = EglError("eglInitialize");
        DetachSurface(state);
        return MakeString(env, error.data(), error.size());
    }
    const EGLint configAttributes[] = {
        EGL_RENDERABLE_TYPE,
        EGL_OPENGL_ES3_BIT,
        EGL_SURFACE_TYPE,
        EGL_WINDOW_BIT,
        EGL_RED_SIZE,
        8,
        EGL_GREEN_SIZE,
        8,
        EGL_BLUE_SIZE,
        8,
        EGL_ALPHA_SIZE,
        8,
        EGL_NONE,
    };
    EGLConfig config = nullptr;
    EGLint configCount = 0;
    if (eglChooseConfig(state->display, configAttributes, &config, 1, &configCount) != EGL_TRUE || configCount < 1) {
        const std::string error = EglError("eglChooseConfig");
        DetachSurface(state);
        return MakeString(env, error.data(), error.size());
    }
    state->config = config;
    if (eglBindAPI(EGL_OPENGL_ES_API) != EGL_TRUE) {
        const std::string error = EglError("eglBindAPI");
        DetachSurface(state);
        return MakeString(env, error.data(), error.size());
    }
    // OpenHarmony's EGLNativeWindowType is an integer handle while the
    // native-window NDK returns an opaque pointer. The platform EGL shim
    // consumes the pointer value as that handle.
    state->surface = eglCreateWindowSurface(
        state->display, config, reinterpret_cast<EGLNativeWindowType>(state->nativeWindow), nullptr);
    if (state->surface == EGL_NO_SURFACE) {
        const std::string error = EglError("eglCreateWindowSurface");
        DetachSurface(state);
        return MakeString(env, error.data(), error.size());
    }
    const EGLint contextAttributes[] = {EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE};
    state->context = eglCreateContext(state->display, config, EGL_NO_CONTEXT, contextAttributes);
    if (state->context == EGL_NO_CONTEXT ||
        eglMakeCurrent(state->display, state->surface, state->surface, state->context) != EGL_TRUE) {
        const std::string error = EglError("eglMakeCurrent");
        DetachSurface(state);
        return MakeString(env, error.data(), error.size());
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_attach_gles_context(state->host, &output);
    napi_value result = BufferResult(env, status, &output);
    if (status != WEAPP_CONTAINER_FFI_OK) {
        DetachSurface(state);
        return result;
    }
    state->rustContextAttached = true;
    state->surfaceWidth = width;
    state->surfaceHeight = height;
    return result;
}

napi_value RenderSurface(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value argv[2] = {nullptr, nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc > 2) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr || state->display == EGL_NO_DISPLAY ||
        state->surface == EGL_NO_SURFACE || state->context == EGL_NO_CONTEXT || !state->rustContextAttached) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_RENDER\",\"operation\":\"surface-not-attached\"}");
    }
    uint32_t width = state->surfaceWidth;
    uint32_t height = state->surfaceHeight;
    if (argc >= 1 && !ReadUint32(env, argv[0], &width)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"width\"}");
    }
    if (argc >= 2 && !ReadUint32(env, argv[1], &height)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"height\"}");
    }
    if (width == 0 || height == 0 || width > INT32_MAX || height > INT32_MAX) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\",\"field\":\"viewport\"}");
    }
    if (eglMakeCurrent(state->display, state->surface, state->surface, state->context) != EGL_TRUE) {
        const std::string error = EglError("eglMakeCurrent");
        return MakeString(env, error.data(), error.size());
    }
    // Window geometry can change while EGL still reports the old backbuffer
    // until the next swap. Recreate only the EGLSurface, preserving the Rust
    // session, EGLContext and Skia resources, before drawing a resized frame.
    EGLint actualWidth = 0;
    EGLint actualHeight = 0;
    if (eglQuerySurface(state->display, state->surface, EGL_WIDTH, &actualWidth) != EGL_TRUE ||
        eglQuerySurface(state->display, state->surface, EGL_HEIGHT, &actualHeight) != EGL_TRUE) {
        const std::string error = EglError("eglQuerySurface");
        return MakeString(env, error.data(), error.size());
    }
    if (actualWidth != static_cast<EGLint>(width) || actualHeight != static_cast<EGLint>(height)) {
        if (eglMakeCurrent(state->display, EGL_NO_SURFACE, EGL_NO_SURFACE, state->context) != EGL_TRUE) {
            const std::string error = EglError("eglMakeCurrent-resize");
            return MakeString(env, error.data(), error.size());
        }
        if (eglDestroySurface(state->display, state->surface) != EGL_TRUE) {
            const EGLint error = eglGetError();
            // A failed destroy still owns its surface unless EGL proves the
            // handle is already absent. Do not overwrite it with a new one.
            if (error != EGL_BAD_SURFACE) {
                const std::string failure = EglError("eglDestroySurface-resize", error);
                return MakeString(env, failure.data(), failure.size());
            }
        }
        state->surface = EGL_NO_SURFACE;
        state->surface = eglCreateWindowSurface(
            state->display, state->config, reinterpret_cast<EGLNativeWindowType>(state->nativeWindow), nullptr);
        if (state->surface == EGL_NO_SURFACE) {
            const std::string error = EglError("eglCreateWindowSurface-resize");
            return MakeString(env, error.data(), error.size());
        }
        // Retain a newly allocated surface on every later failure so explicit
        // detach/retry can retire it before creating another native identity.
        if (eglMakeCurrent(state->display, state->surface, state->surface, state->context) != EGL_TRUE) {
            const std::string error = EglError("eglMakeCurrent-resize-surface");
            return MakeString(env, error.data(), error.size());
        }
        if (eglQuerySurface(state->display, state->surface, EGL_WIDTH, &actualWidth) != EGL_TRUE ||
            eglQuerySurface(state->display, state->surface, EGL_HEIGHT, &actualHeight) != EGL_TRUE) {
            const std::string error = EglError("eglQuerySurface-resize");
            return MakeString(env, error.data(), error.size());
        }
    }
    if (actualWidth <= 0 || actualHeight <= 0 || actualWidth != static_cast<EGLint>(width) ||
        actualHeight != static_cast<EGLint>(height)) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_RENDER\",\"operation\":\"surface-size-not-ready\"}");
    }
    GLint framebuffer = 0;
    glGetIntegerv(GL_FRAMEBUFFER_BINDING, &framebuffer);
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_render_gles_framebuffer(
        state->host, static_cast<uint32_t>(framebuffer), width, height, &output);
    if (status != WEAPP_CONTAINER_FFI_OK) return BufferResult(env, status, &output);
    weapp_container_harmony_buffer_free(&output);
    if (eglSwapBuffers(state->display, state->surface) != EGL_TRUE) {
        const std::string error = EglError("eglSwapBuffers");
        return MakeString(env, error.data(), error.size());
    }
    state->surfaceWidth = width;
    state->surfaceHeight = height;
    return MakeStatus(env, "{\"ok\":true,\"gpuSurface\":true,\"renderer\":\"skia-gpu-gles\",\"gpuCompletion\":\"not-waited\"}");
}

napi_value DetachSurfaceApi(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    if (state == nullptr) return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
    const std::string retired = DetachSurface(state);
    if (!retired.empty()) return MakeString(env, retired.data(), retired.size());
    return MakeStatus(env, "{\"ok\":true,\"gpuSurface\":false}");
}

napi_value CanvasSnapshot(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1] = {nullptr};
    if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    std::string canvasId;
    auto* state = GetHostState(env, info);
    if (!ReadString(env, argv[0], &canvasId) || state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    WeappContainerFfiBuffer output{nullptr, 0};
    const int32_t status = weapp_container_harmony_host_canvas_snapshot(
        state->host, reinterpret_cast<const uint8_t*>(canvasId.data()), canvasId.size(), &output);
    return BufferResult(env, status, &output);
}

napi_value Destroy(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    // The caller may be aborting after a render error. Cleanup is correct
    // even without a preceding ArkTS detach callback and is idempotent.
    const std::string retired = DetachSurface(state);
    if (!retired.empty()) {
        napi_throw_error(env, "ERR_RENDER", retired.c_str());
        return nullptr;
    }
    if (state != nullptr && state->host != nullptr) {
        weapp_container_harmony_host_free(state->host);
        state->host = nullptr;
    }
    if (state != nullptr && state->ownerScoped) state->closed = true;
    napi_value result;
    return napi_get_undefined(env, &result) == napi_ok ? result : nullptr;
}

napi_value Unload(napi_env env, napi_callback_info info) {
    (void)info;
    auto* state = GetHostState(env, info);
    if (state == nullptr || state->host == nullptr) {
        return MakeStatus(env, "{\"ok\":false,\"error\":\"ERR_INVALID_ARGUMENT\"}");
    }
    const std::string retired = DetachSurface(state);
    if (!retired.empty()) return MakeString(env, retired.data(), retired.size());
    const int32_t status = weapp_container_harmony_host_unload(state->host);
    return MakeStatus(env, status == WEAPP_CONTAINER_FFI_OK ? "{\"ok\":true}" : "{\"ok\":false,\"error\":\"ERR_ENGINE\"}");
}
}  // namespace

const napi_property_descriptor kHostMethods[] = {
        {"start", nullptr, Start, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"loadManifest", nullptr, LoadManifest, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"loadManifestWithConfig", nullptr, LoadManifestWithConfig, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"capabilities", nullptr, Capabilities, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"dispatch", nullptr, Dispatch, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"dispatchBatch", nullptr, DispatchBatch, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"hostServices", nullptr, HostServices, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"inspectState", nullptr, InspectState, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"resizeViewport", nullptr, ResizeViewport, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"pollTimers", nullptr, PollTimers, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"acknowledgePresentation", nullptr, AcknowledgePresentation, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"lifecycle", nullptr, Lifecycle, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"snapshot", nullptr, Snapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"attachSurface", nullptr, AttachSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"renderSurface", nullptr, RenderSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"detachSurface", nullptr, DetachSurfaceApi, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"canvasSnapshot", nullptr, CanvasSnapshot, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"destroy", nullptr, Destroy, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"unload", nullptr, Unload, nullptr, nullptr, nullptr, napi_default, nullptr},
    };

napi_value CreateOwner(napi_env env, napi_callback_info) try {
    auto state = std::shared_ptr<HostState>(new (std::nothrow) HostState(),
        [](HostState* value) { FinalizeHostState(nullptr, value, nullptr); });
    if (!state) {
        napi_throw_error(env, "ERR_ENGINE", "Unable to allocate a native execution owner");
        return nullptr;
    }
    state->ownerScoped = true;
    napi_value object = nullptr;
    if (napi_create_object(env, &object) != napi_ok) {
        napi_throw_error(env, "ERR_ENGINE", "Unable to create a native execution owner");
        return nullptr;
    }
    for (const auto& method : kHostMethods) {
        auto* binding = new (std::nothrow) BoundHostCallback{state};
        if (binding == nullptr) {
            napi_throw_error(env, "ERR_ENGINE", "Unable to retain native execution owner");
            return nullptr;
        }
        napi_value function = nullptr;
        if (napi_create_function(env, method.utf8name, NAPI_AUTO_LENGTH, method.method,
                binding, &function) != napi_ok) {
            delete binding;
            napi_throw_error(env, "ERR_ENGINE", "Unable to create a native owner callback");
            return nullptr;
        }
        if (napi_add_finalizer(env, function, binding, FinalizeBoundCallback, nullptr, nullptr) != napi_ok) {
            delete binding;
            napi_throw_error(env, "ERR_ENGINE", "Unable to retain a native owner callback");
            return nullptr;
        }
        if (napi_set_named_property(env, object, method.utf8name, function) != napi_ok) {
            napi_throw_error(env, "ERR_ENGINE", "Unable to publish a native owner callback");
            return nullptr;
        }
    }
    return object;
} catch (const std::exception&) {
    napi_throw_error(env, "ERR_ENGINE", "Unable to allocate a native execution owner");
    return nullptr;
}

EXTERN_C_START
static napi_value Init(napi_env env, napi_value exports) {
    napi_define_properties(env, exports, sizeof(kHostMethods) / sizeof(kHostMethods[0]), kHostMethods);
    napi_property_descriptor factory = {"createOwner", nullptr, CreateOwner, nullptr, nullptr, nullptr, napi_default, nullptr};
    napi_define_properties(env, exports, 1, &factory);
    // Legacy exports retain their one-per-environment behavior. New SDKs use
    // createOwner() for isolated runtimes within the same ArkTS environment.
    (void)GetHostState(env);
    return exports;
}
EXTERN_C_END

static napi_module g_module = {
    .nm_version = 1,
    .nm_flags = 0,
    .nm_filename = nullptr,
    .nm_register_func = Init,
  // DevEco registers the native module under the HAP module name (`entry`)
  // for libentry.so.  Keeping this in sync avoids a loader warning while the
  // ArkTS namespace import still resolves the same N-API exports.
  .nm_modname = "entry",
    .nm_priv = nullptr,
    .reserved = {0},
};

extern "C" __attribute__((constructor)) void RegisterWeappContainerModule() {
    napi_module_register(&g_module);
}
