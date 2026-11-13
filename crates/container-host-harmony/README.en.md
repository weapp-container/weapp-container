# container-host-harmony

[简体中文](README.md) · **English**


HarmonyOS ArkTS/N-API/FFI host boundary. ArkTS callers use the shared
`load_manifest_json`/`dispatch_json`/`dispatch_batch_json` batch boundary.
`harmony` and `arkui` are explicit integration features; `skia-backend` must
also be enabled before a Skia raster surface is advertised. The optional
`skia-gpu-gles` feature attaches the current EGL/GLES context supplied by an
ArkUI XComponent and renders the committed frame into its window framebuffer.
The default build is a metadata stub and does not claim DevEco, emulator or
device validation.

`weapp_container_harmony_host_capabilities` returns a versioned JSON report separating
compiled ArkUI/renderer/provider features from the current session. It keeps
`runtime.gpuSurface` false until an ArkTS adapter attaches a real GPU-backed
surface; a portable Skia raster snapshot is not device evidence.

`start_session` and `dispatch_lifecycle` are the ArkTS-facing lifecycle
helpers. The sample's native adapter owns the XComponent surface lifecycle;
the Rust ABI exposes `weapp_container_harmony_host_attach_gles_context`,
`weapp_container_harmony_host_render_gles_framebuffer` and
`weapp_container_harmony_host_detach_gles_context` for that boundary.

The `quickjs-native` and `v8-native` features enable providers in the shared
runtime. Capability metadata reflects that runtime's compiled providers, including
features enabled by another workspace consumer. V8 requests fail with
`ERR_ENGINE` when the shared runtime has no V8 provider; they never select another
engine. For the `aarch64-unknown-linux-ohos` target, use
`quickjs-native-harmony`; it enables rquickjs bindgen and prevents a missing
target binding from being mistaken for a host build.

The `cdylib` exports `weapp_container_harmony_host_new/free`,
`weapp_container_harmony_host_load_manifest`, `weapp_container_harmony_host_start`,
`weapp_container_harmony_host_dispatch_json`, `weapp_container_harmony_host_dispatch_batch_json`,
`weapp_container_harmony_host_capabilities`, `weapp_container_harmony_host_render_snapshot`,
`weapp_container_harmony_host_canvas_snapshot`, `weapp_container_harmony_host_poll_timers` and
`weapp_container_harmony_buffer_free`; the ArkTS/N-API
sample and CMake link boundary live in `examples/hosts/harmony`.

`weapp_container_harmony_host_render_snapshot` returns one JSON `RenderSnapshot` after a
`render.commit`; ArkUI can upload its premultiplied RGBA8 pixels in one batch.

`weapp_container_harmony_host_canvas_snapshot` reads the independently committed
`wx.canvas.draw` surface by UTF-8 canvas id so ArkUI can present page and Canvas
2D layers without per-command FFI calls.

For a fixed demonstration, build with
`node scripts/build-native-hosts.mjs --build --platform harmony --profile release --distribution-profile restricted-showcase --showcase-policy /absolute/policy.json --out /private/build.json`.
This forwards the runtime's compiled pack/API policy, records its identity in
capabilities and verifies it in the actual Rust library. The private report
also hashes both N-API integration libraries. Release debug information is
stripped and build paths are remapped. Restricted state observation exposes
only session/page identity and view/render revisions required by the native
presentation owner; page data, development details and diagnostic page/Canvas
snapshots are unavailable. The full distribution retains its existing APIs.
