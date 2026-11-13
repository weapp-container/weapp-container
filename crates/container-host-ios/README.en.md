# container-host-ios

[简体中文](README.md) · **English**


iOS static-library and Swift/Objective-C bridge boundary. The shared runtime is
loaded through `load_manifest_json` and exchanged in complete batches through
`dispatch_json`. `ios` and `metal` are explicit integration features; either
`skia-backend` or the actual `skia-gpu-metal` feature advertises the compiled
Skia boundary. Default tests only check metadata and protocol behavior; they do
not claim simulator or device validation.

`build.nativeSurface`/`build.renderer` describe the compiled boundary. They may
report `skia-raster` before a drawable is rendered, while `runtime.gpuSurface`
stays `false` until Rust Skia renders into a host-owned Metal drawable.

`weapp_container_ios_host_capabilities` returns a versioned JSON report separating
compiled renderer/provider features from the current session. `runtime.gpuSurface`
stays false until the Swift/Objective-C adapter attaches a real Metal context;
CPU raster readback is reported separately and cannot satisfy the GPU gate.

`start_session` and `dispatch_lifecycle` keep lifecycle ordering in the shared
Rust runtime before Swift/Objective-C surface callbacks are attached.

`notify_viewport_resize_json(width, height)` updates logical viewport metrics
and invokes resize hooks without replacing the session or committing a frame.
`session_state_json()` returns only the versioned session ID, logical viewport,
current page `{id, route}` (or null), View revision, and last committed `frameId` (or null).
This lightweight read never serializes the render tree or pixels. A resize
does not invent a new frame ID; the surface owner must render and present.

`poll_timers`/`poll_timers_json` take **Unix-epoch nanoseconds**, matching
native timer scheduling and JavaScript `Date.now()`. Hosts must not pass
display-link timestamps, uptime or session-relative elapsed time. Each poll
returns one complete bridge batch, possibly with no messages. The host owns
the event loop and must inspect error envelopes as well as the FFI status.

The `quickjs-native` and `v8-native` features enable providers in the shared
runtime. Capability metadata reflects that runtime's compiled providers, including
features enabled by another workspace consumer. V8 requests fail with
`ERR_ENGINE` when the shared runtime has no V8 provider; they never select another
engine.

The `staticlib` exports `weapp_container_ios_host_new/free`, `weapp_container_ios_host_load_manifest`,
`weapp_container_ios_host_start`, `weapp_container_ios_host_dispatch_json`,
`weapp_container_ios_host_dispatch_batch_json`,
`weapp_container_ios_host_capabilities`, `weapp_container_ios_host_render_snapshot`,
`weapp_container_ios_host_canvas_snapshot`,
`weapp_container_ios_host_poll_timers`,
`weapp_container_ios_host_resize_viewport`,
`weapp_container_ios_host_session_state`,
`weapp_container_ios_host_unload` and
`weapp_container_ios_buffer_free`; `examples/hosts/ios` contains the Swift Package and C
header used by an Xcode app.

Native unload is idempotent and drops timers, providers and engine state while
retaining the reusable host handle. It does not invoke application hooks:
dispatch `app.lifecycle` with `unload` first when those hooks must run. A
throwing hook must not prevent native release. State/resize/timer/dispatch
calls fail after release until a new manifest is loaded. Every returned FFI
buffer remains caller-owned and must be freed with the matching buffer free.

The Swift adapter conforms to `WeappContainerSessionRuntime`.
`WeappContainerSession` provides whole-session input, timer, foreground and
navigation-aware render ownership. UIKit applications use
`WeappContainerView`, which keeps these operations on the main thread and
draws directly into its `CAMetalLayer`. The view owns session teardown,
including display-link/observer cleanup and Metal drain/detach before unload.
It supports one pointer/tap; touch target capture, multi-touch/long-press,
native scrolling, text-input composition, accessibility and complete iOS
window/display observation remain outside this implementation. See
[`docs/ios-portable-pack.md`](../../docs/ios-portable-pack.en.md) for embedding
and validation contracts.

`weapp_container_ios_host_render_snapshot` returns one JSON `RenderSnapshot` after a
`render.commit`; Swift can upload its premultiplied RGBA8 pixels to a Metal
surface without per-node bridge calls. This is the software fallback path and
must remain reported as `containerSurfaceAttached: false`.

For a direct GPU path, build with `ios,metal,quickjs-native-ios`. The Swift
`MetalSnapshotPresenter.attach(runtime:)` method attaches the app-owned
`MTLDevice`/`MTLCommandQueue` to Rust Skia Ganesh; `present(runtime:)` wraps
the `CAMetalLayer` drawable texture and renders the last committed frame
directly into it. Only after that call succeeds does the probe report
`source: "ios-skia-metal-layer"`, `rendererBackend: "skia-gpu-metal"` and
`containerSurfaceAttached: true`. A headless simulator layer may have no
drawable; that result is `blocked` and is not a software or GPU pass.

`weapp_container_ios_host_canvas_snapshot` reads a committed `wx.canvas.draw` surface by
UTF-8 canvas id. The returned batch is independent from the page snapshot and
can be uploaded to a Metal layer in one operation.
