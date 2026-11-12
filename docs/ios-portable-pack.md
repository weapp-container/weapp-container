# iOS portable-pack embedding

Both iOS examples use `examples/hosts/ios/Sources/WeappContainerHost`:

- `Bridge.swift` owns a thread-affine Rust session and imports the C header.
- `PortablePack.swift` reads a bundle/filesystem pack and verifies it before
  calling the host. It has no UIKit, Metal, Rust or simulator dependency.
- `ContainerSession.swift` owns live input, timer pumping, navigation-aware
  rendering, foreground transitions and final unload. Its runtime protocol
  extends the loader protocol and can be exercised without UIKit or Rust.
- `WeappContainerView.swift` embeds that session in a UIKit `UIView` backed by
  `CAMetalLayer`, using `MetalSnapshotPresenter` for direct Rust Skia output.
- `WeappContainerSmoke` bundles a checked-in reference pack through SwiftPM.
- `ios-app` compiles the same sources directly with the iOS SDK and copies a
  selected pack into its `.app/portable-pack` before signing.

```swift
let directory = Bundle.main.bundleURL.appendingPathComponent("portable-pack")
let pack = try WeappPortablePack(directory: directory)
let host = WeappContainerHost()
let started = try pack.start(on: host, width: 375, height: 667)
// Keep the host on this thread. Inspect started.diagnostics as well as frames.
```

For an interactive app, create `WeappContainerView` on the UIKit main thread
and keep it as the sole owner of its session:

```swift
let pack = try WeappPortablePack(directory: directory)
let miniProgram = try WeappContainerView(pack: pack, engine: "quickjs",
    width: 375, height: 667)
miniProgram.onError = { error in print("Weapp Container:", error) }
miniProgram.translatesAutoresizingMaskIntoConstraints = false
view.addSubview(miniProgram)
NSLayoutConstraint.activate([
    miniProgram.leadingAnchor.constraint(equalTo: view.leadingAnchor),
    miniProgram.trailingAnchor.constraint(equalTo: view.trailingAnchor),
    miniProgram.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
    miniProgram.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
])
// When the embedding feature finishes, on the main thread:
// try miniProgram.close()
```

Supply the intended logical startup size so `App`/`Page` initialization sees
that viewport. Subsequent layout uses rounded logical UIKit points for the
runtime and physical pixels for the Metal drawable. The view resizes and
renders the existing session rather than loading another app. It requires
the native Rust host and a Metal backend; unavailable native rendering is an
error. A temporarily unavailable drawable remains dirty and is retried.

Before the host first becomes foreground-active, an absent or inactive
window only pauses input and the display pump. Initial launch already called
`App.onShow`; initial window attachment and activation preserve that state
without a hide/show pair. After that first activation, window removal and
app/own-scene deactivation send the corresponding hide transition;
reattachment/activation resumes the same session. Successful command-buffer
completion triggers `onPresented`; a submitted frame alone is not a completed
presentation.
`close()` invalidates the display link, removes observers, cancels input,
drains/detaches Metal and unloads the native session. Cleanup continues if a
hook or an earlier cleanup step throws. Explicit close is idempotent;
deinitialization also releases owned resources on the main queue.

Applications with a custom surface can instead own
`WeappContainerSession(pack:runtime:engine:sessionID:route:width:height:)`.
Call `pointer`, `setForeground`, `resize` and `pollTimers` on its creating
thread, and drain/detach the custom surface before `session.close()`. A failed
runtime transaction records a diagnostic and stops subsequent input/timer
work. Lifecycle unload is attempted before native release, even after a
failed transaction. Do not mutate its native host through a second owner.
The session itself sends `touchcancel` before hiding, resizing or unloading;
custom surface owners do not need a second cancellation implementation.
`onOperation` and `onDiagnostic` observers run after the complete surrounding
transaction settles, including acknowledgement validation and publication.
An observer may close the session at that point without unloading beneath a
pending render. These observation callbacks report completed work, rather
than providing an input or lifecycle injection point.

The session's timer input is **Unix-epoch nanoseconds**, obtained with
`WeappContainerSession.clockNowNs()`. `CADisplayLink.timestamp`, device uptime
and time since session creation use a different epoch. Touch event
`timeStamp` intentionally uses UIKit's monotonic milliseconds instead.
Each tick reads lightweight native page/revision metadata. A changed route,
page identity or View revision renders using live page data, including JS
navigation, `setData` and deferred ready/observer effects. An empty timer
batch can still trigger that dirty render; an unchanged tick does not.
Subsequent manifest frames use `useSessionResources: true` to reuse the
session's verified resources without retransmitting their bytes. The
initial render supplies explicit blobs. Current-route rendering selects
app, page and recursively used component styles in manifest order.

Input currently supports one pointer, `touchstart`/`touchmove`/`touchend`/
`touchcancel`, and an end-plus-tap batch for an unmoved contact lasting at
most 500 ms. A second contact cancels the gesture. Coordinates and tap slop
use logical points; the runtime derives targets, datasets and propagation
from the committed tree. An identified contact keeps its down-time node,
listener, dataset and component route across moves. Page transitions, target
removal and viewport changes cancel that contact; a delayed end or tap cannot
select a replacement target. The runtime and both native engines test this
as a local contract; fixed-baseline WeChat equivalence is still unverified.
Multi-touch, long-press, native scrolling, keyboard/text-input composition
and a UIKit accessibility tree are not implemented by this view. Full iOS
display/safe-area/orientation observations are also not supplied by its
viewport-only resize boundary. These remain separate implementation and
conformance work.

`scripts/ios-app-smoke` also supports `WEAPP_CONTAINER_IOS_BUILD_ONLY=1`.
It creates a signed app and a versioned `build-product.json` receipt before
any simulator command. This lets the official XCUITest runner own subsequent
installation, OS input, launch and cleanup. The verification-only
`WEAPP_CONTAINER_IOS_UI_OBSERVATION=1` build exposes one accessibility anchor
with bounded read-only session/page metadata. Normal embedding builds do not
expose page data. The observation uses `weapp_container_ios_host_inspect_state`
as one immutable batch, without entering JS, polling timers or traversing
nodes through FFI. The lightweight production `session_state` pump remains
separate and does not serialize application data.

The loader checks UTF-8/schema v1, SHA-256 integrity root, protocol major,
all module/View script/template/style/asset references and asset sizes.
Missing/corrupt blobs and symlinks escaping the pack fail before the loaded
session is touched. The Rust runtime additionally validates its complete
schema, dependencies, capabilities, WXML/WXSS and supported View semantics.
The Swift canonicalizer supports the current v1 metadata numeric domain:
non-negative integers up to `Number.MAX_SAFE_INTEGER` (schema version and
resource byte sizes). Floating, negative or larger numeric metadata is
explicitly rejected; this is not a general RFC 8785/ECMAScript numeric
canonicalizer. WXML/WXSS expression data stays in hashed blobs and is not
subject to that manifest-metadata restriction.

The checked-in fixture was rebuilt from the renamed reference app using an
available compiler archive without Git provenance. Its `compiler.commit` is
honestly `unknown`; it does not prove a pinned upstream compiler build.
Rebuild it with the repository's verified submodule before a reproducibility
or release gate.

Declared WXS and compiled expression blobs use the runtime's isolated View
engine. Byte transport alone does not prove WXS semantics or official parity.

Startup sends complete JSON batches in this order:

1. Load manifest through the C ABI.
2. `app.init` with all modules, verified blobs and launch options.
3. `app.lifecycle` with `launch`.
4. `page.push` for the selected route.
5. `render.commit` with that route's template, styles, blobs and viewport.

The render request omits `data`, preserving the current page state produced
by JS registration, `onLoad` and `setData`. A supplied route must exist and
have a matching template; the loader does not substitute a synthetic frame.
Each response must be correlated by session/operation/request ID, have response kind
and acknowledge success. `app.init` must report a real engine provider;
`render.commit` must explicitly acknowledge publication. Structured runtime
errors retain their `ERR_*` code. Errors after an accepted frame are returned
in startup diagnostics; the example apps record them as a startup failure.

The original C ABI defaults to QuickJS. The additive
`weapp_container_ios_host_load_manifest_with_config` accepts a JSON
`SessionConfig`. In Swift, use `pack.start(on: host, engine: "v8", sessionID:
"my-session")` with a staticlib built using `v8-native`. Missing providers fail
with `ERR_ENGINE`; no fallback occurs. Custom legacy runtime implementations
may keep their existing loader, but must implement the configured overload to
support non-default engine/session settings. Selection alone does not establish
V8/iOS execution coverage.

The native Swift host receives the logical viewport before `app.init`, so
window-information APIs and media queries used during `onLoad` see the same
dimensions as rendering. Its geometry-aware overload is additive; existing
custom runtime implementations retain their configured loader.

The additive native session boundary provides:

- `weapp_container_ios_host_resize_viewport`: logical width/height and one
  resize-effect bridge batch; frame publication remains a separate commit.
- `weapp_container_ios_host_poll_timers`: one complete batch for an absolute
  Unix-epoch nanosecond observation.
- `weapp_container_ios_host_session_state`: only
  `{schemaVersion:1, sessionId, viewport:{width,height}, page:{id,route}|null,
  frameId:number|null, viewRevision:number}`. It contains no view tree or pixel data, and reports
  the last accepted frame even if the viewport has since changed.
- `weapp_container_ios_host_unload`: idempotent native release, preserving the
  reusable host handle. Send `app.lifecycle(unload)` first to invoke hooks.

Swift `WeappContainerHost` exposes these as `resize`, `pollTimers`,
`sessionState` and `unload` and conforms to `WeappContainerSessionRuntime`.
All returned FFI buffers are copied and freed within each Swift call.
Unloaded sessions reject state, resize, timer and dispatch operations;
capability discovery and a subsequent manifest load remain available.

From the repository root:

```sh
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack --check
node --test scripts/sync-ios-portable-pack.test.mjs scripts/validate-ios-app-evidence.test.mjs
scripts/test-ios-portable-pack
scripts/test-ios-container-session
swift build --package-path examples/hosts/ios --target WeappContainerHost
```

The sync script uses the packer's canonical JSON implementation, validates
all sources before writing, publishes a staged directory with recovery of
the previous destination on publication failure, and supports exact-byte
`--check`. `--destination` is available for app build output directories.
The Swift tests run against actual packed reference bytes and a recording
runtime, covering startup order, data preservation, integrity failures,
engine errors, correlation, publication acknowledgement and diagnostics.
Session tests use a recording runtime to cover input batches, resize,
current-route rendering, lifecycle, timers, error suspension and unload.
These Swift tests do not execute the native JS engine or establish
device/GPU evidence. Rust host tests cover the native metadata/resize/unload
boundary; a macOS library build checks imports and conditional compilation,
while UIKit and real presentation require the iOS SDK and runtime gate.

The bundled fixture was rebuilt from `examples/apps/reference-app` after the
Weapp Container rename. Its route is `pages/home/index` and its integrity root is
`6da28a3a2e7194893d61209ba4b5f83afc5d72d429ba3fc9f6140106fcc9d8a1`.
That local build used an available non-Git compiler archive, so the manifest
records `compiler.commit: "unknown"`. The pack is a loader/development fixture;
it does not satisfy the pinned-upstream reproducible-build gate. Refresh it
with a verified fixed-commit compiler before using it as release evidence.

When intentionally running an official simulator smoke:

```sh
WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-app-smoke
WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-embedding-smoke
```

That script builds Rust and UIKit, installs only its task bundle on an
already booted simulator, and reads its app-owned evidence file. A passing
surface probe requires an accepted pack-backed frame, a direct Rust Skia
Metal render and successful command-buffer completion. It does not imply
hardware acceleration on a simulator, performance acceptance, real-device
coverage or semantic equality with WeChat DevTools.

`ios-embedding-smoke` selects the interactive `WeappContainerView` example
instead of the original one-frame smoke. Its first completed frame records
`source: "ios-skia-metal-embedding"` and `sessionOpen: true`; it does not
claim an already detached surface. Later batches enter a bounded
`embedding-trace.json` copied before the task app is removed. A first-frame
pass does not prove continuous OS touch input or scheduled timer behavior.
The original smoke continues to require successful Metal detach. Both
scripts clean up their own app; the embedding controller can be reused in
an application's own persistent UIKit lifecycle.

`WEAPP_CONTAINER_IOS_ENGINE=quickjs|v8` selects matching Cargo and runtime
configuration. `WEAPP_CONTAINER_IOS_SIMULATOR_UDID` selects a booted simulator;
the script refuses ambiguous automatic selection. Build receipts bind source
before/after compilation to the actual signed executable SHA-256. Uncommitted
sources remain `unknown`, and source changes during compilation fail. The
resulting `execution-evidence.json` binds the target, engine, session, manifest,
requests/responses, snapshot and Metal frame for the shared conformance matrix.

The local build may warn if cached QuickJS C objects were compiled with an iOS
SDK deployment target newer than the Swift app's declared minimum. A successful
link alone does not prove that declared minimum OS is supported; deployment-target
alignment and execution on that OS remain a separate gate.

The smoke uses a unique bundle identifier and run directory by default. An
explicit bundle identifier must be absent on the selected booted simulator;
existing apps are preserved. `resources.json` records installation/launch
ownership and PID. Cleanup queries that exact bundle/PID, distinguishes a
natural exit from a live owned process, uninstalls its bundle and writes
`cleanup.json`. Identity changes and cleanup failures are reported and fail
the command; the borrowed simulator and unrelated apps stay running.
