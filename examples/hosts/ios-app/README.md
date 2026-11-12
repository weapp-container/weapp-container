# iOS embedding and Metal surface examples

This target is the app-backed counterpart to `examples/hosts/ios`. The Swift
Package remains the reusable library/ABI check; this target owns a visible
`UIWindow` and a `CAMetalLayer`, so CoreAnimation can vend a real drawable to
Rust Skia Ganesh.

From the repository root:

```sh
scripts/ios-app-smoke
scripts/ios-embedding-smoke
```

The script builds `container-host-ios` for `aarch64-apple-ios-sim`, compiles
the UIKit app with `xcrun swiftc`, creates a signed simulator `.app`, installs
it on the sole booted simulator (or `WEAPP_CONTAINER_IOS_SIMULATOR_UDID`), launches it with `simctl launch`, and
requires a direct `WEAPP_CONTAINER_SURFACE_PROBE` with
`containerSurfaceAttached=true`, `gpuSurface=true` and
`rendererBackend=skia-gpu-metal`.

The app compiles the shared `WeappContainerHost/Bridge.swift` and
`PortablePack.swift`; there is one Swift loader and one C-header ABI in both
iOS examples. The script validates the checked-in Swift-package portable pack and copies
it into the signed `.app`. Override the source with
`WEAPP_CONTAINER_IOS_PACK=/absolute/path/to/pack scripts/ios-app-smoke`.

The loader verifies the integrity root and all blob SHA-256 values before
loading the manifest. It executes real module bytes via `app.init`, sends
`app.lifecycle` launch and `page.push`, then commits the route's WXML/WXSS
with live JavaScript page data. Startup errors are written to
`Library/Caches/weapp-ios-evidence.json` and displayed in the app. Surface
evidence includes correlated startup requests/responses, engine, session,
snapshot/frame ID, route and manifest integrity root, and requires the
Metal command buffer to complete successfully. Runtime handle calls and
Metal detach remain on the main thread.

The latest runtime frame is rendered directly into the view-backed drawable.
No RGBA snapshot upload is used as GPU evidence. The default remains a one-frame
smoke app. Its transparent premultiplied Metal layer is composited over a white
UIKit host view. The runtime and raw `frame.png` retain their alpha channel.
The app stays alive after rendering until the smoke supervisor captures
`app-screen.png` through the simulator and cleans up its owned bundle.
`screen-capture.json` records the live app PID and OS screenshot hash. A live
PID alone does not establish foreground ownership or visual correctness;
inspect the OS screenshot separately from the drawable readback.
`WEAPP_CONTAINER_IOS_ENGINE=quickjs|v8` selects the build feature and
runtime configuration together; unavailable V8 target builds fail explicitly.
The default remains QuickJS. Continuous OS input/timer acceptance and device validation remain separate work. Build or
source checks alone do not establish simulator, device or GPU conformance.

`ios-embedding-smoke` sets `WeappContainerAppMode=embedding` and runs
`WeappContainerEmbeddingViewController`, which embeds the shared
`WeappContainerView`. It owns one live Rust session, a display-link timer
pump, whole-batch touch events, logical resize, foreground transitions and
Metal drain/detach/unload. Its first-frame receipt uses the distinct
`ios-skia-metal-embedding` source and records a still-open session; it cannot
substitute for the default smoke's completed detach. Later operations enter
the bounded `embedding-trace.json`, copied out before app cleanup. These
scripts uninstall their task app after capture. To embed a persistent feature
in an application, reuse the controller/view and call `close()` when finished.
See [the embedding contract](../../../docs/ios-portable-pack.md) for startup
geometry, current-route style selection, resource reuse and input limitations.

Swift's referenced C ABI functions are the roots of ordinary static archive
linking, with `-dead_strip` for unused transitive code. The app does not force-load
the complete Rust archive. The pinned rusty_v8 iOS archive disables Wasm but
contains unused Wasm compilation wrappers with unavailable C++ definitions;
retaining every archive symbol would make those wrappers a link requirement.
This link policy does not add Wasm support or change the selected JS engine.

Each run saves `source-before.json`, `build.json` and `execution-evidence.json`.
The supervisor captures `app-stdout.log` and `app-stderr.log` and saves
`startup-wait.json`. It polls the exact launched PID and matching session/engine
evidence. A native engine abort fails startup immediately and retains the last
raw `evidence.json`; it cannot become a screenshot failure or a GPU pass.
Build provenance hashes the actual signed executable and checks Rust/Swift/build
inputs before and after compilation. Source changes during compilation fail;
uncommitted builds stay `unknown`. `CARGO_TARGET_DIR` selects the Cargo output
directory (relative paths are resolved from this repository). The supervisor
passes that directory explicitly to Cargo, selects the host staticlib from
`cargo-build.jsonl`, and copies it to the run's independent
`native-input/libcontainer_host_ios.a`. Swift links that exact file, without
searching a default target directory. `native-archive.json` records the selected
artifact, engine/features and SHA-256; the copied archive is checked again
after linking/signing. A later build cannot replace this run's linker input.
`WEAPP_CONTAINER_IOS_FIXTURE_ID` names the
shared conformance fixture; the same manifest must be used on other hosts and
engines. A single simulator receipt does not satisfy the complete host matrix.

The smoke uses a unique bundle identifier and run directory by default. An
explicit bundle identifier must be absent on the selected booted simulator;
existing apps are preserved. `resources.json` records installation/launch
ownership and PID. Cleanup queries that exact bundle/PID, distinguishes a
natural exit from a live owned process, uninstalls its bundle and writes
`cleanup.json`. Identity changes and cleanup failures are reported and fail
the command; the borrowed simulator and unrelated apps stay running. An install
attempt without a successful acknowledgement, including interruption before
that acknowledgement is recorded, does not grant cleanup ownership. That case
preserves the ambiguous bundle, writes `blocked-unowned` to `cleanup.json`, and
fails the command. An interrupted launch with no recorded PID also preserves
any live process until its ownership can be established.
