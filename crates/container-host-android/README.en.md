# container-host-android

[简体中文](README.md) · **English**


Android NDK/JNI host boundary. `load_manifest_json` and batch `dispatch_json` are
the shared runtime boundary for JNI callers. `android`, `gles` and `vulkan` are
explicit integration features; either `skia-backend` or the actual
`skia-gpu-gles` feature advertises the compiled Skia boundary. The default
metadata stub is suitable for protocol tests and does not claim emulator or
device conformance.

`build.nativeSurface`/`build.renderer` describe the compiled boundary. They may
report `skia-raster` before a frame is committed, while `runtime.gpuSurface`
stays `false` until a host-owned GLES context and framebuffer receive a frame.

`weapp_container_android_host_capabilities` returns a versioned JSON capability report.
`build` describes compiled features and providers, while `runtime` reports the
currently loaded session and committed raster surface. `gpuSurface` remains
false until an Android adapter attaches a real GLES/Vulkan context; a readable
Skia raster snapshot is not GPU evidence.

`start_session` and `dispatch_lifecycle` are available to JNI adapters so app
ordering remains identical to Web and desktop hosts.

The `quickjs-native` and `v8-native` features enable providers in the shared
runtime. Capability metadata reflects that runtime's compiled providers, including
features enabled by another workspace consumer. V8 requests fail with
`ERR_ENGINE` when the shared runtime has no V8 provider; they never select another
engine.

The `cdylib` exports `weapp_container_android_host_new/free`,
`weapp_container_android_host_capabilities`, `weapp_container_android_host_load_manifest`, `weapp_container_android_host_start`,
`weapp_container_android_host_dispatch_json`, `weapp_container_android_host_dispatch_batch_json`,
`weapp_container_android_host_render_snapshot`,
`weapp_container_android_host_canvas_snapshot`, `weapp_container_android_host_poll_timers` and
`weapp_container_android_buffer_free`; the matching
header and JNI owner live in `examples/hosts/android`.

`weapp_container_android_host_render_snapshot` returns one JSON `RenderSnapshot` after a
`render.commit`; its pixel payload is premultiplied RGBA8 for a single GLES or
Vulkan upload operation.

`weapp_container_android_host_canvas_snapshot` reads the independently committed
`wx.canvas.draw` surface by UTF-8 canvas id. It keeps page and Canvas 2D
surfaces separate while still transferring one complete RGBA snapshot across
JNI.
