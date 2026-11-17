// No EGL driver/window is opened. The included function is the unchanged
// production RenderSurface body; only its SDK/FFI dependencies are fakes.
#include <cassert>
#include <cstdint>
#include <set>
#include <string>

using EGLint = int;
using EGLNativeWindowType = uintptr_t;
using GLint = int;
using napi_env = void*;
using napi_callback_info = void*;
using napi_value = void*;
constexpr int EGL_NO_DISPLAY = 0, EGL_NO_SURFACE = 0, EGL_NO_CONTEXT = 0;
constexpr int EGL_TRUE = 1, EGL_WIDTH = 0x3057, EGL_HEIGHT = 0x3056;
constexpr int EGL_BAD_SURFACE = 0x300d, EGL_BAD_ALLOC = 0x3003;
constexpr int GL_FRAMEBUFFER_BINDING = 0x8ca6;
constexpr int WEAPP_CONTAINER_FFI_OK = 0, napi_ok = 0;
struct WeappContainerFfiBuffer { void* data; size_t len; };
struct HostState {
    void* host = reinterpret_cast<void*>(1);
    int display = 2, surface = 11, context = 3, config = 4;
    void* nativeWindow = reinterpret_cast<void*>(5);
    bool rustContextAttached = true;
    uint32_t surfaceWidth = 375, surfaceHeight = 667;
};
HostState owner;
int scenario = 0, creates = 0, destroys = 0, makeCurrents = 0, renders = 0, swaps = 0;
int errorCode = 0;
uint32_t width = 800, height = 600;
std::set<int> liveSurfaces{11};
std::string receipt;

int napi_get_cb_info(napi_env, napi_callback_info, size_t* argc, napi_value* argv, void*, void*) {
    *argc = 2; argv[0] = &width; argv[1] = &height; return napi_ok;
}
HostState* GetHostState(napi_env, napi_callback_info) { return &owner; }
bool ReadUint32(napi_env, napi_value value, uint32_t* out) {
    *out = *static_cast<uint32_t*>(value); return true;
}
napi_value MakeString(napi_env, const char* value, size_t size) {
    receipt.assign(value, size); return &receipt;
}
napi_value MakeStatus(napi_env env, const char* value) {
    return MakeString(env, value, std::string(value).size());
}
int eglGetError() { const int error = errorCode; errorCode = 0; return error; }
std::string EglError(const char* operation, EGLint code = eglGetError()) {
    return std::string("ERR_RENDER:") + operation + ":" + std::to_string(code);
}
int eglMakeCurrent(int display, int draw, int read, int context) {
    assert(display == 2 && context == 3 && draw == read);
    assert(draw == 0 || liveSurfaces.count(draw) == 1);
    ++makeCurrents;
    if ((scenario == 6 && makeCurrents == 2) || (scenario == 4 && draw == 12)) {
        errorCode = EGL_BAD_ALLOC; return 0;
    }
    return EGL_TRUE;
}
int eglQuerySurface(int display, int surface, int attribute, EGLint* value) {
    assert(display == 2 && liveSurfaces.count(surface) == 1);
    if (scenario == 5 && surface == 12) { errorCode = EGL_BAD_ALLOC; return 0; }
    assert(attribute == EGL_WIDTH || attribute == EGL_HEIGHT);
    *value = surface == 11 ? (attribute == EGL_WIDTH ? 375 : 667)
        : (attribute == EGL_WIDTH ? width : height);
    return EGL_TRUE;
}
int eglDestroySurface(int display, int surface) {
    assert(display == 2 && liveSurfaces.count(surface) == 1);
    ++destroys;
    if (scenario == 1) { errorCode = EGL_BAD_ALLOC; return 0; }
    liveSurfaces.erase(surface);
    if (scenario == 2) { errorCode = EGL_BAD_SURFACE; return 0; }
    return EGL_TRUE;
}
int eglCreateWindowSurface(int display, int config, EGLNativeWindowType window, void*) {
    assert(display == 2 && config == 4 && window == 5);
    assert(liveSurfaces.empty()); // Never allocate over an unretired identity.
    ++creates;
    if (scenario == 3) { errorCode = EGL_BAD_ALLOC; return EGL_NO_SURFACE; }
    liveSurfaces.insert(12); return 12;
}
void glGetIntegerv(int field, GLint* value) { assert(field == GL_FRAMEBUFFER_BINDING); *value = 0; }
int weapp_container_harmony_host_render_gles_framebuffer(void* host, uint32_t, uint32_t w,
    uint32_t h, WeappContainerFfiBuffer*) {
    assert(host == owner.host && w == width && h == height); ++renders; return WEAPP_CONTAINER_FFI_OK;
}
void weapp_container_harmony_buffer_free(WeappContainerFfiBuffer*) {}
napi_value BufferResult(napi_env env, int32_t, WeappContainerFfiBuffer*) {
    return MakeStatus(env, "unexpected-ffi-error");
}
int eglSwapBuffers(int display, int surface) {
    assert(display == 2 && liveSurfaces.count(surface) == 1); ++swaps; return EGL_TRUE;
}

#include "render_surface.inc"

int main(int argc, char** argv) {
    assert(argc == 2); scenario = std::stoi(argv[1]);
    assert(RenderSurface(nullptr, nullptr) == &receipt);
    const bool successful = scenario == 0 || scenario == 2;
    if (successful) {
        assert(receipt.find("\"ok\":true") != std::string::npos);
        assert(owner.surface == 12 && creates == 1 && destroys == 1);
        assert(renders == 1 && swaps == 1 && owner.surfaceWidth == width && owner.surfaceHeight == height);
    } else {
        const char* operations[] = {"", "eglDestroySurface-resize", "", "eglCreateWindowSurface-resize",
            "eglMakeCurrent-resize-surface", "eglQuerySurface-resize", "eglMakeCurrent-resize"};
        assert(receipt.find(operations[scenario]) != std::string::npos);
        assert(renders == 0 && swaps == 0 && owner.surfaceWidth == 375 && owner.surfaceHeight == 667);
        if (scenario == 1 || scenario == 6) {
            assert(owner.surface == 11 && creates == 0 && destroys == (scenario == 1 ? 1 : 0));
        } else if (scenario == 3) {
            assert(owner.surface == EGL_NO_SURFACE && creates == 1 && destroys == 1);
        } else {
            assert(owner.surface == 12 && creates == 1 && destroys == 1);
        }
    }
    // Every remaining driver resource is still owned, including when makeCurrent
    // or query fails after allocation. Session/context/window ownership survives.
    assert(liveSurfaces == (owner.surface ? std::set<int>{owner.surface} : std::set<int>{}));
    assert(owner.display == 2 && owner.context == 3 && owner.config == 4 && owner.rustContextAttached);
    assert(owner.nativeWindow == reinterpret_cast<void*>(5) && owner.host == reinterpret_cast<void*>(1));
}
