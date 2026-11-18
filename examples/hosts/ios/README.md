# iOS host sample

The default native integration check builds the `WeappContainerHost` library so
it is runnable on any macOS CI runner. Build the simulator smoke executable
only when the Rust staticlib and an iOS simulator SDK are available:

```sh
WEAPP_CONTAINER_IOS_RUST_LIB="$PWD/../../../target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a" \
swift build --package-path . --triple arm64-apple-ios-simulator --product WeappContainerSmoke
```

The executable loads the checked-in `Resources/portable-pack`, copied from
`artifacts/reference-app/pack`. It verifies the manifest integrity root and every
referenced module, View script, WXML/WXSS and asset blob before loading the
Rust session. Startup is `app.init` (modules and blobs), `app.lifecycle`
(launch), `page.push`, and a template-backed `render.commit`; rendering reads
the live page data produced by JavaScript. It then exercises RGBA snapshot
readback and `wx.canIUse`. Installing it into a simulator is a separate app
bundle step.

Refresh or check that fixture from the repository root:

```sh
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack
node scripts/sync-ios-portable-pack.mjs --source artifacts/reference-app/pack --check
scripts/test-ios-portable-pack
scripts/test-ios-container-session
```

`WeappPortablePack(directory:)` is the reusable filesystem/bundle loader. Call
`try pack.start(on: host)` to run the checked startup sequence. Structured
bridge errors, unavailable JS engines, missing acknowledgements and rejected
frames throw `WeappPortablePackError`. Accepted frames retain later runtime
diagnostics in `WeappPortablePackStartup.diagnostics`. See
[`docs/ios-portable-pack.md`](../../../docs/ios-portable-pack.md) for integration
and validation boundaries.

For an interactive UIKit embedding, create `WeappContainerView(pack:engine:)`
on the main thread, add it to the view hierarchy and call `close()` when the
feature finishes. It owns a `WeappContainerSession` and direct Rust Skia
`CAMetalLayer` presentation. Layout updates use logical UIKit points for
runtime geometry and screen-scaled pixels for the drawable. Window removal
and app/own-scene deactivation suspend the same session; activation resumes
it without replaying startup. Display-link targets and lifecycle observers
are released during close. Missing native rendering is an error; a
temporarily missing drawable is retried without switching renderers.

Custom surface owners can use `WeappContainerSession` directly. Its runtime
protocol adds `resize`, `pollTimers`, `sessionState` and `unload` to the
existing pack protocol. Keep all calls on the session's creating thread.
Timer polls use `WeappContainerSession.clockNowNs()` (Unix-epoch nanoseconds),
not `CADisplayLink.timestamp` or uptime. Empty timer batches skip rendering;
callback effects and input render against the current native page route,
preserving live data. `sessionState` transfers only session ID, viewport,
current page and last frame ID, without a render tree or pixel buffer.

The initial input contract supports one contact and tap recognition. UIKit
events become a whole `event.batch`, and Rust performs committed-tree hit
testing and event propagation. Multiple contacts cancel the current gesture;
native target capture, multi-touch, long-press, native scroll gestures,
text-input composition, accessibility and complete display/safe-area metrics
remain incomplete. `onError` reports failures. A presentation or `ERR_RENDER`
failure suspends input and automatic redraw while foreground business timers
continue; it does not synthesize an app `hide`. Call `try containerView.render()`
to retry the latest live page. Input resumes after that frame's successful Metal
completion and acknowledgement. Fatal runtime/protocol errors stop scheduling
and require a new session. Custom surface owners use `suspendPresentation`,
`render`, `consumePresentationAcknowledgement` and `resumePresentation` for the
same boundary; ready/observer diagnostics remain in the session operation log.
`close()` drains/detaches Metal before lifecycle/native unload and continues
cleanup even if a hook throws. Do not share one session between surface owners.

`scripts/test-ios-container-session` uses a recording runtime to verify these
Foundation ownership contracts without a device. `swift build --target
WeappContainerHost` checks the macOS library/import surface; it excludes the
UIKit-only view. UIKit compilation and presentation need the iOS SDK and
simulator/device validation. None of these local contract checks alone proves
official DevTools parity or physical GPU/device acceptance.

This Swift Package is the smallest app integration point for the Rust iOS
host. `WeappContainerHost` owns one thread-affine `container-host-ios` handle and
exchanges complete UTF-8 JSON bridge batches. An Xcode app can add this package,
link the static library produced by Cargo, and call `loadManifest`, `start` and
`dispatch` from its `UIViewController`/Metal surface owner.

`MetalSnapshotPresenter` is the surface adapter for that owner. For the
production GPU path, pass it the `CAMetalLayer` from the view, call
`attach(runtime:)` once, and call `present(runtime:)` after each committed
frame. Rust Skia Ganesh then renders directly into the drawable texture and
the returned `MetalSurfaceProbe` records `containerSurfaceAttached: true`,
`gpuSurface: true` and `rendererBackend: "skia-gpu-metal"`. The standalone
smoke uses a layer without a UIView hierarchy and records a separate
`blocked` result if `nextDrawable()` is unavailable.

`present(snapshot:)` remains available for hosts that only have a complete
RGBA snapshot. It uploads one `MTLTexture` and is deliberately reported as
`rendererBackend: "software-fallback"` with `containerSurfaceAttached: false`;
it is not GPU conformance evidence.

Build the Rust side first from the repository root:

```sh
cargo build -p container-host-ios --features ios,metal,quickjs-native-ios --target aarch64-apple-ios-sim
swift build --package-path examples/hosts/ios --target WeappContainerHost
```

`swift build --target WeappContainerHost` checks the library and C header ABI
on macOS. Building the executable on macOS without a matching Rust staticlib
is expected to fail at link time; use the iOS simulator command above for
the executable. `Package.swift` links
Metal, QuartzCore, CoreText and libc++ for the Skia/QuickJS static library.
The default C ABI configuration uses QuickJS. `pack.start(on: host, engine: "v8",
sessionID: "my-ios-session")` uses the explicit configuration ABI; its matching
Rust staticlib must include `v8-native`. Missing providers fail without fallback.
Existing `pack.start(on: host)` and the original C ABI remain available.
An engine selector alone does not establish V8/iOS coverage. The package itself does not
claim simulator or device conformance; the final
Xcode link must add the matching `libcontainer_host_ios.a`,
`Security.framework`/other provider frameworks as needed, and a
Rust-compatible Objective-C runtime configuration.
