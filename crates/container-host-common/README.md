# container-host-common

Shared host-side boundary for the Web, desktop, Android, iOS and Harmony
adapters. `HostSession` validates and owns one `container-runtime::Session`,
then exposes `start`, `lifecycle`, `dispatch`, `dispatch_batch`, `dispatch_json`
and `dispatch_batch_json` operations.

Host crates forward the `quickjs-native` and `v8-native` provider features to
the shared runtime. A V8 session on a build without `v8-native` fails with
`ERR_ENGINE` instead of silently falling back; the default QuickJS path remains
a protocol-only headless boundary until `quickjs-native` is enabled.

`lifecycle_state()` and `lifecycle_sequence()` expose the core state machine to
host event loops. A loaded manifest starts in `Created`; only an accepted
`launch` transition moves it to `Active`, while `hide`/`show` report
`Background`/`Active` without requiring a second page stack in the host.

`dispatch_json` accepts either one envelope or the canonical
`{"messages":[...]}` payload; `dispatch_batch_json` requires the latter. Both
paths validate session/protocol and envelope invariants before the first
message enters the runtime, then serialize one complete response batch so
WASM, JNI, Swift/Objective-C and ArkTS/N-API adapters do not perform per-node
FFI calls. The wrapper is thread-affine; hosts that need cross-thread access
must provide an explicit proxy and keep the runtime on its owning thread.

`poll_timers(now_ns)` consumes **Unix epoch nanoseconds**. Rust-owned deadlines
use `SystemTime` and the QuickJS/V8 timer JavaScript schedules against
`Date.now()`; the runtime converts this same poll value to epoch milliseconds
for JS callbacks. RAF/Choreographer/display-link timestamps, uptime and
time-since-session-start are different clock domains and must only schedule
the host pump. Sample the current wall clock when polling, including after a
pause, rather than maintaining a stale startup offset. JavaScript callers
must convert integer milliseconds to `BigInt` before multiplying to
nanoseconds and check the `u64` limit; signed JNI callers additionally reject
negative values and multiplication outside `Long` range. Hosts own suspension
and callback cadence; this clock contract does not itself establish timer
throttling or background semantics equivalent to WeChat.

For an accepted raster frame, `render_snapshot_json` returns one
`RenderSnapshot` containing `frame_id`, dimensions, stride and tightly packed
premultiplied `rgba8` pixels. Snapshot access reports `NoRenderFrame` when the
requested snapshot is unavailable. Explicit external-frame snapshot requests
can generate software diagnostic pixels; borrowed observations cannot. Passive
reads do not initialize a page renderer. This is the raster and diagnostic
interface. External-frame and native-GPU presentation consume
accepted scene/frame data through their own presenter contracts without a
normal full-page CPU raster/readback/upload. `capture_render_snapshot` is an
explicit CPU diagnostic request and does not prove host GPU presentation.

`render_revision` identifies the accepted Skia revision, independently from
application frame IDs and the browser document presentation namespace. Backend
names and native/GPU surface flags are observations; presentation authority
still requires the matching runtime-owned acknowledgement.

Canvas 2D surfaces have independent lifetimes. After a successful
`wx.canvas.draw`, `canvas_snapshot_json(canvas_id)` returns the corresponding
RGBA8 buffer; it never replaces the page snapshot. `reserve:false` starts a
new command history and `reserve:true` replays on the existing surface. A
renderer command that has no deterministic implementation returns a structured
render error before the provider response is reported as success.

Native callers must initialize each output slot to `{ data: NULL, len: 0 }` and
release it before reuse. The Rust boundary rejects a non-empty slot instead of
overwriting it, preventing a leaked allocation when a JNI, Swift or ArkTS
caller accidentally reuses a live result.

For passive page inspection, `accepted_page_observation()` borrows the accepted
frame, render revision, pinned submission target and cached snapshot without
initializing Skia or copying frame/pixel data. `page_render_status()` exposes
allocation/backend/surface facts, and Metal builds provide the passive
`has_metal_context()` query. Unloaded hosts retain `NotLoaded`; snapshot APIs
retain `NoRenderFrame` when their requested snapshot is unavailable.
`render_target_for_revision()` rejects zero or stale Skia render revisions and
returns the target pinned by that successful page commit, even if another
density has since been staged. These observations do not establish current-page,
input, ready or browser presentation authority, and the submission target is
not a measured framebuffer or GPU/device result. Explicit snapshot requests
can clone or generate diagnostic pixels; borrowed observations never do.
