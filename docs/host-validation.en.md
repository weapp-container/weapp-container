<a id="主机验证边界"></a>
# Host validation boundary

[简体中文](host-validation.md) · **English**


Both GitHub Actions `container-ci` and `modern-view` workflows accept only manual runs;
pushes and pull requests will not automatically trigger. CI validation of selected builds, protocols, semantics, or browser scenarios;
Android, iOS, HarmonyOS, and real desktop GPU/window validation still require their respective official SDKs, emulators, or physical devices.
Unselected groups remain unexecuted and cannot be inferred as passed based on a single green part.

<a id="手动-ci"></a>
## Manual CI

In the repository's **Actions → container-ci → Run workflow**, select the branch and `scope`.
The default `quick` runs only existing evidence/near-parity audits and manifest checks; choose heavier groups as needed:

| `scope` | execution scope |
| --- | --- |
| `quick` | near-parity/evidence audit, manifest, and related Node contract verification |
| `rust` | Rust formatting, compilation, Clippy, testing, and host feature smoke |
| `engines` | QuickJS/V8 conformance, native V8 and engine feature forwarding |
| `upstream` | Fixed weapp-vite six-platform build, mpcore conformance |
| `native` | Native Skia and mobile toolchain/build boundary checks |
| `performance` | Protocol Baseline and Simulator Performance Matrix |
| `full` | All the above tasks, forcing a complete Rust and Skia OS matrix |

`engines` and `performance` will first run their dependent manifest checks.

`rust_os` optional `linux` (default), `macos`, `windows`, or `all`; `skia_os` optional
`linux` (default), `macos`, or `all`. Both only control the runner for the corresponding task, `full` will ignore platform selection and force full matrix. Linux compilation passing does not guarantee macOS/Windows or device runtime success.

GitHub CLI can perform the same operation; use the repository's default branch when omitting `--ref`, and explicitly specify another branch when needed:

```bash
gh workflow run ci.yml -f scope=quick
gh workflow run ci.yml -f scope=rust -f rust_os=macos
gh workflow run ci.yml -f scope=native -f skia_os=all
gh workflow run ci.yml -f scope=full
```

Modern View construction, browser, and relative performance tasks are handled by **Actions → modern-view → Run workflow**
Select individually `suite=browser|performance|full`, defaulting to `browser`; `performance` runs only specific performance tests, `full` runs both suites concurrently. It replaces the old boolean `performance` input; see
[Modern View CI](modern-view.en.md#ci-专项验证). The `container-ci` `full` does not implicitly trigger another workflow; when two complete checks are needed, run `scope=full` and `suite=full` separately.

Normal runs deduplicate based on workflow, ref, group, and platform; new runs of the same type cancel old runs; runs from different groups or platforms do not cancel each other. `full` and `performance` runs do not cancel ongoing runs of the same type; GitHub's concurrency queue may still replace pending runs that have not yet started. Regular artifacts are retained for 7 days, performance artifacts for 30 days; reports requiring long-term review should be downloaded before expiration and archived according to the existing evidence process.

Caching is used only for dependency downloads and does not save Cargo `target`, generated pack, or acceptance reports; a cache hit does not imply revalidation.
Manual group selection, build success, headless testing, and toolchain detection do not grant new official DevTools, GPU,
simulator, physical device, or near-parity pass status; existing evidence and the freeze gate boundary remain unchanged.

<a id="本地检查"></a>
## Local checks

```bash
node scripts/check-toolchain.mjs --json
cargo fmt --all -- --check
cargo test --workspace
bash scripts/host-feature-smoke.sh
node scripts/perf-baseline.mjs --out artifacts/perf-baseline.json
```

`check-toolchain.mjs --json` will simultaneously record environment variables, default installation locations, tool versions, and whether required directories are present, and whether Rust's Apple/Android/OpenHarmony targets are installed. On macOS, it will probe `~/Library/Android/sdk`, Xcode's `xcodebuild`/iPhoneSimulator SDK, and DevEco Studio's OpenHarmony native toolchain; "detected" only indicates the presence of tools and does not substitute evidence of platform compilation or simulator/physical device runtime. `--strict` requires all optional SDKs to have their required directories present.

The `container-render-skia` feature's `skia-backend` is fixed to `skia-safe 0.153.3` and enables `ganesh + metal + pdf`, aligning with the content-addressable binary bundle of rust-skia. This ensures that on supported targets, precompiled Skia will be directly downloaded and verified; if the bundle is not present, the build will explicitly proceed to the source path, at which point Python, Clang, and Ninja must be provided, and silent fallback to software renderer is not allowed. Review the native compilation boundaries:

```bash
cargo check -p container-render-skia --features skia-backend
```

The `window`/`android`/`ios`/`harmony` feature for desktop and mobile host only enables platform boundaries;
`HostInfo` reports a Skia raster surface only when explicitly attached with `skia-backend`; this is not a GPU context. GPU qualification must be achieved when the host attaches a real platform surface and reports `skia-gpu-*`, to prevent feature metadata from incorrectly reporting software rendering as GPU rendering. For example, desktop native checks use `cargo check -p container-host-desktop --features window,skia-backend`.

This command only proves that the Skia native library can be linked and executes CPU raster readback, and does not represent window, GPU surface, or device conformance.
The native renderer benchmark will actually submit 1000 nodes `RenderFrame` and generate a complete performance report:

```bash
pnpm perf:native -- --iterations 60 --out artifacts/native-performance-report.json
pnpm perf:check artifacts/native-performance-report.json --require-complete
```

The renderer's first frame, scroll drop frame rate, and process RSS in the report come from Rust/Skia probe; they are evidence from the host of the current build machine and cannot replace measurements from Android, iOS, HarmonyOS simulators, or real devices.

The desktop host also provides a reproducible native surface smoke. It submits a real frame tree via
`DesktopHost::dispatch(render.commit)`, followed by
`render_snapshot_json` performing a single `read_pixels` on the Skia raster surface, and asserting
the returned RGBA8 bytes, frame id, and `has_native_surface()` state:

```bash
cargo test -p container-host-desktop --features window,skia-backend
```

This smoke has covered the Skia raster surface and the host's batch submission/read-back loop; it still does not
replace platform-specific winit windows, GPU context, compositors, or true device acceptance.

On macOS, Windows, or Linux hosts with a graphical session, a real
`winit + softbuffer` window smoke can be run:

```bash
pnpm host:desktop:surface -- --out artifacts/desktop/native-window-surface.json
```

This command creates a platform window, attaches a `softbuffer::Surface`, and submits a fixed 2×2 RGBA frame, then saves `nativeSurface: true`, `presentedFrame: true`, pixel SHA-256, and `surfaceBackend: "softbuffer-raster"`. This demonstrates the window/presentation boundary more clearly than offscreen readback, but softbuffer remains a CPU path, and the reported `gpuSurface` must remain `false`—it cannot be considered evidence of Skia GPU, Metal, Vulkan, official DevTools, or on-device testing. When no graphics session is available, the command outputs `status: "blocked"`; in environments without windows such as CI, the `--allow-blocked` flag can be used to retain the blocked report and return a successful exit code.

macOS also provides an explicit Skia Ganesh Metal surface smoke. It uses the `metal-window` feature to create AppKit windows and `CAMetalLayer`, attaching the `MTLDevice`/`MTLCommandQueue` to the same `HostSession`, and then directly wrapping each `CAMetalDrawable`'s texture into a Skia Metal render target. Only after the runtime completes `render.commit` and flush on the drawable, and the presenter calls `presentDrawable`/`commit`, will the report be written with `rendererBackend: "skia-gpu-metal"`, `containerSurfaceAttached: true`, and `gpuSurface: true`:

```bash
cargo run --manifest-path examples/hosts/desktop-metal/Cargo.toml --release
```

The report can be saved to `artifacts/desktop/metal-window-surface.json`; this file records macOS, GPU, Rust/Skia build information, and one-time frame/surface evidence. The status remains `status: "blocked"` when window creation fails, the drawable is unavailable, or no graphics session exists, and software raster surface upgrades to GPU path are not performed. A single macOS smoke test only covers surface ownership for this platform and cannot substitute for Windows/Linux GPU, DevTools, full API conformance, performance, or actual device gatekeeping.

Current host crate provides the same set of `load_manifest_json`, `dispatch_json`, and `unload`
boundaries. They pass batch bridge envelopes to a single `container-runtime::Session`,
so the host does not maintain a second page stack; JSON boundaries are suitable for WASM, JNI, Swift/Objective-C, and ArkTS/N-API bindings. The boundary test proves manifest validation, batch response from app.init, and retention of running session on failed reload, but does not guarantee native window, GPU, emulator, or real device conformance.

`dispatch_json` accepts both a compatible single `BridgeEnvelope` and the standardized `{"messages":[...]}` `BridgeBatch`. Cross-platform bindings can also invoke explicit `dispatch_batch_json`/`weapp_container_*_host_dispatch_batch_json` entry points; the host will validate session, protocol, request ID, deadline, and cancellation-related fields before the first message enters the runtime, preventing partial initialization of page stacks due to session/protocol mismatches across messages; individual operation payloads are still returned in structured error form by the runtime in order. Expiry and cancellation of deadlines within a batch will respectively return `ERR_TIMEOUT` and `ERR_CANCELLED`; the C ABI output buffer must be freed via the corresponding `weapp_container_*_buffer_free`, and after freeing, both pointer and length will be zeroed.

Re-run shared host bridge smoke and save JSON report:

```bash
pnpm host:bridge:smoke -- --out artifacts/host-bridge-smoke.json
```

The `bridge` gatekeeper in this report covers batch, deadline/cancel, and buffer ownership tests for Web, desktop, Android, iOS, and HarmonyOS host crates; `nativeGpu` explicitly remains `blocked`, as this smoke test does not attach to a platform GPU surface and does not elevate software fallback or performance results into device evidence.

The report includes both `engines.quickjs` and `engines.v8` feature matrices. They are compiled separately with
`--no-default-features --features quickjs-native|v8-native` for five platform adapters, and assert that host capability metadata is consistent with the provider state of `container-runtime`. This matrix demonstrates feature forwarding and explicit capability negotiation; the module execution semantics remain covered by `engine:conformance`, and the `blocked` state of `nativeGpu` does not change in the absence of a real GPU, simulator, or device.

After `render.commit` succeeds, the host can call `render_snapshot_json` to obtain the `RenderSnapshot` (frame id, width and height, stride, and premultiplied RGBA8 pixels) in one go. This establishes an auditable bulk handoff point from the unified Skia renderer to CanvasKit, desktop window, GLES/Vulkan, Metal, and ArkUI surface; it still does not equate to GPU or physical device acceptance.

Android, iOS and HarmonyOS's C ABI also provides `weapp_container_*_host_canvas_snapshot`: the caller passes in a UTF-8 `canvasId`, enabling it to read the `RenderSnapshot` of the corresponding `wx.canvas.draw` surface in one go. Page snapshot and Canvas 2D snapshot have independent lifecycles; this interface avoids transferring Canvas commands or pixels node-by-node or call-by-call across JNI, Swift, or N-API boundaries. It only proves that the Rust renderer has submitted the surface, and still cannot elevate software/raster reads into GPU evidence.

Three mobile C ABI interfaces also provide read-only `weapp_container_*_host_capabilities`. It returns a
`schemaVersion: 1` JSON, separately listing `build` (the compiled renderer/provider) and
`runtime` (whether the current session is loaded, whether a native raster surface is generated, whether a GPU surface is attached). The caller must re-read this report after creating a native window, `CAMetalLayer`, GLES/Vulkan, or ArkUI surface; `runtime.gpuSurface: false` must remain false until the platform adapter actually takes over the GPU context. This query is merely a capability negotiation boundary and does not convert `skia-raster` or `software-fallback` into evidence of mobile GPU usage.

<a id="原生应用集成骨架"></a>
## Native app integration skeletons

`examples/hosts/android`、`examples/hosts/ios` and `examples/hosts/harmony`
provide the minimal entry points for JNI/CMake, Swift Package/C header, and ArkTS/N-API/CMake respectively.
Three Rust host crates now export both `rlib` and platform FFI libraries, and provide the same set of
`new`, `load_manifest`, `start`, `dispatch_json`, and `buffer_free` functions. All cross-language calls transmit a complete JSON batch; each platform's ABI header records ownership rules for pointers and lengths.

First run structure and target checks:

```sh
pnpm native:check -- --out artifacts/native-hosts.json
```

A native Rust artifact can be built when an SDK is available:

```sh
pnpm native:build -- --platform android
cargo build -p container-host-ios --features ios,metal,quickjs-native-ios --target aarch64-apple-ios-sim
cargo build -p container-host-harmony --features harmony --target aarch64-unknown-linux-ohos
swift build --package-path examples/hosts/ios
```

The Android sample can assemble its JNI shared library with the generated
Rust artifact when an Android Gradle Plugin/Gradle installation is available:

```sh
# Run from the repository root; supply your installed Gradle executable.
pnpm native:build -- --platform android
gradle --project-dir examples/hosts/android :app:assembleDebug \
  -PweappContainerAndroidRustLib="$PWD/target/aarch64-linux-android/debug/libcontainer_host_android.so"
```

The iOS package check builds the `WeappContainerHost` library product. The
optional simulator smoke executable links the matching staticlib explicitly:

```sh
# Run from the repository root.
WEAPP_CONTAINER_IOS_RUST_LIB="$PWD/target/aarch64-apple-ios-sim/debug/libcontainer_host_ios.a" \
swift build --package-path examples/hosts/ios \
  --triple arm64-apple-ios-simulator --product WeappContainerSmoke
```

Android Gradle, Xcode projects, and DevEco engineering projects must explicitly link the Rust `cdylib`/`staticlib` output, and the respective SDKs are responsible for signing and installation. Passing of `native:check` only proves that the project files, FFI symbols, and Rust cross-target can be compiled; `native:build` only proves native artifact generation; when the Android NDK is present, it also links JNI/CMake samples, and when Xcode SwiftPM is present, it checks the Swift bridge. Neither can replace evidence of running in Android/iOS/Harmony simulators or on actual devices.
The default workspace build does not download V8, so host metadata will still mark `v8` as unavailable to avoid silent fallback. `container-engine-v8` provides an explicit `v8-native` build path; it links a pinned `rusty_v8` provider and performs isolated CommonJS/batch call conformance. Only after the host compiles the provider into the target artifact and passes its own runtime tests can the V8 capability for that host be marked as available.

Currently, the five host crates cover seven published surfaces: Web, desktop (macOS/Windows/Linux), Android, iOS, and HarmonyOS. All five crates provide `quickjs-native` and `v8-native` forwarding features, and `HostInfo.capabilities` reports availability only when the corresponding provider is compiled; the three desktop targets share the event and window boundaries from `container-host-desktop`, and thus a single desktop check cannot be extended to three GPU or device instances based on evidence. `Session::new` will reinitialize and verify the provider; when V8 is missing, it returns a stable `ERR_ENGINE` and does not fall back to another engine.

```bash
cargo test -p container-engine-v8 --no-default-features --features v8-native
```

When the current environment is available, a read-only device surface probe can be run:

```bash
pnpm host:device:smoke -- --out artifacts/host-device-smoke.json
# Treat all three emulator surfaces as a hard gate when the host matrix is required.
pnpm host:device:smoke -- --require-all --out artifacts/host-device-smoke-required.json
```

This report only proves that the Android/iOS/Harmony emulator shell is reachable, and does not prove container runtime, rendering, API, or performance passes. The default mode is used to collect diagnosable availability reports, and reports are returned even if a platform has not started; `--require-all` exits with a non-zero code if any platform status is not `passed`, suitable for CI or device access control.

Need to verify that the container actually starts and executes bridge smoke in the simulator, use
`native:runtime:smoke`. This entry installs and launches the Android APK, parses the four output items: `app.init`, `render.commit`, RGBA snapshot, and `api.call` from `WEAPP_CONTAINER_SMOKE`; for iOS, it installs the `.app` and saves the same set of outputs from `simctl launch --console`. HarmonyOS requires first generating the HAP via DevEco, and then providing the package name and Ability via environment variables:

```sh
pnpm native:runtime:smoke -- --out artifacts/mobile-runtime-smoke.json

WEAPP_CONTAINER_HARMONY_HAP=entry/build/default/outputs/default/entry-default-signed.hap \
WEAPP_CONTAINER_HARMONY_BUNDLE=com.sonofmagic.weapp.container \
WEAPP_CONTAINER_HARMONY_ABILITY=EntryAbility \
pnpm native:runtime:smoke -- --require-all \
  --out artifacts/mobile-runtime-smoke-required.json
```

The Harmony runtime branch will clear the target device's `hilog` buffer, terminate the old process, and then start the specified Ability after installation. A successful return from the start command is not sufficient: the script will poll
`hdc shell hilog -x -e WEAPP_CONTAINER_SMOKE`, requiring four parsable batch evidence outputs within the same run:
`app.init`, `render.commit`, `render.snapshot`, and `api.call`. Each item will validate a successful payload, frame number/backend, or RGBA8 read-back data; missing items will be recorded in `missingOperations`, and failed items in `failedChecks`. After data collection, the script will stop the bundle to prevent the Ability started by this task from remaining in the foreground of the shared emulator. The wait window can be adjusted using `WEAPP_CONTAINER_HARMONY_WAIT_MS` (default 5 seconds) and `WEAPP_CONTAINER_HARMONY_POLL_MS` (default 250 ms).

The `passed` in the report only indicates that the selected app successfully ran through the smoke test on the selected emulator/device and returned a native
Skia surface backend; it does not represent production signing, full API conformance, or performance thresholds. If the bridge and
RGBA snapshot have been executed, but the renderer remains `software-fallback`, the report will retain
`runtimeStatus: "passed"` as diagnostic evidence, while normalizing the gate `status` to `blocked`, and
recording `reason`, `nativeSurface: false`, and the target environment. Reports will also be marked as `blocked` in the absence of APK, iOS app bundle, DevEco HAP, online device, or emulator, and will not be silently elevated to "passed" by shell reachability probes.
The old generic Android/iOS smoke harness may still use a software fallback renderer, with RGBA snapshot serving as 2×2 readback evidence; in such cases, the gate remains `blocked`, and no claim of GLES/Vulkan or Metal surface acceptance can be made. The current Android direct GLES harness and app-backed iOS Metal harness have separate gate controls, and only when all three conditions—`containerSurfaceAttached=true`, `gpuSurface=true`, and `rendererBackend=skia-gpu-*`—are met will the corresponding native surface be promoted. For Harmony, if the Ability can start but an ArkTS/N-API exception occurs or there is no `WEAPP_CONTAINER_SMOKE` record, the report status is `failed`, and container pass cannot be inferred from installation and launch probes.

Move smoke will also preserve a standalone `gpuProbe`. The Android example creates a short-lived EGL pbuffer, the iOS example calls `MTLCreateSystemDefaultDevice()`; these records only prove that the selected simulator/device can create a platform graphics context and retain vendor/renderer/version and `hardwareAccelerated`. They explicitly write `containerSurfaceAttached: false`, and thus cannot elevate device contexts, system compositors, or software SwiftShader to evidence GPU capability for the Weapp Container renderer. If the HarmonyOS example lacks an ArkUI surface probe, the record will have `status: "unavailable"` with a reason. `check-near-parity-gates.mjs` will keep reports missing context, software context, or attempting to overclaim `containerSurfaceAttached` as incomplete; only a platform adapter that submits its own `skia-gpu-*` backend and provides real surface lifecycle evidence can pass the GPU gate.

Android sample will also create an actual `SurfaceView` EGL window surface and swap a complete `render.snapshot` as a GLES texture uploaded to the window. The report's `surfaceProbe` will record `hostSurfaceAttached: true`, `backend: "gles-window-blit"`, and `evidenceBoundary: "runtime-snapshot-upload"`, proving that the host window owns the presentation surface; meanwhile it continues to retain `containerSurfaceAttached: false`, `gpuSurface: false`, and `rendererBackend: "software-fallback"`. This evidence improves surface ownership coverage, but still cannot replace the Rust renderer's direct GPU access to Skia GLES/Vulkan context.

Current Android direct GLES path can also pass the window framebuffer to a Rust Skia renderer,
recording `backend: "skia-gpu-gles"` and `evidenceBoundary: "runtime-skia-gles-framebuffer"`.
[Window metrics regression record](archived-evidence.en.md) preserves precise submissions of
QuickJS App startup, page/component/slot clicks, size/density changes, and background resume validation, and retains the previous failed startup.
Window API calls and callbacks are matched against actual `wm size/density`; session and data persistence, test resource cleanup passes.
The shrunken window screenshots in this history exhibit positional offset and bottom cropping issues. Subsequently,
[EGL drawable regression record](archived-evidence.en.md) confirms via actual testing:
Surface is shrunk, but EGL retains the old size during rendering until swap occurs. Fix involves rebuilding mismatched EGLSurface prior to rendering, preserving EGLContext and JS session; 11-stage background geometry of the local reference app and actual click after scaling pass. One candidate duplicate in a resume screenshot was rejected; the original and subsequent passed candidates are retained.
Official visual state remains `unknown`; these two Android official emulator records do not constitute WeChat pixel equivalence, physical device, Android V8, or performance acceptance.

iOS standalone `MetalSnapshotPresenter` receives app-owned `CAMetalLayer`, uploads the same complete `render.snapshot` as an `MTLTexture` and submits a Metal drawable; it still uses software fallback, therefore evidence of surface ownership with `source: "ios-metal-layer"` will not be upgraded to Skia Metal GPU passage. Run when surface ownership is verified by the container itself:

```bash
scripts/ios-app-smoke
```

The app-backed harness creates a real `UIWindow`/view-backed `CAMetalLayer`, passing the drawable texture directly to Rust Skia Ganesh and requiring `source: "ios-skia-metal-app"`, `containerSurfaceAttached=true`, `gpuSurface=true`, `rendererBackend="skia-gpu-metal"`.
It only verifies the QuickJS surface on a selected iOS Simulator; it does not replace V8, physical devices, full API conformance, or performance gates. No standalone smoke test with UIView/window if `nextDrawable()` is unavailable, will retain `surfaceProbe.status: "blocked"`, requiring the app to be embedded and pass a view-backed layer.

<a id="后续设备验收所需证据"></a>
## Evidence required for a future device gate

Run pre-release aggregation gatekeeping checks. It only accepts complete DevTools case index, six-platform build matrix,
mobile runtime/GPU evidence from real devices, seven host × dual-engine performance reports, and a structurally complete evidence ledger;
software fallback, shell probe, headless results, and missing artifacts will remain `incomplete` and the command will exit with a non-zero status:

```bash
pnpm near-parity:gates -- \
  --matrix artifacts/weapp-vite-matrix-final.json \
  --mobile artifacts/mobile-runtime-smoke-required.json \
  --performance artifacts/performance-report.json \
  --performance artifacts/native-performance-report.json \
  --out artifacts/near-parity-gates.json
```

The `releaseReady: true` in the inspection result applies only to fixed versions and the listed evidence files, and will not promote unobserved
WeChat private behaviors to pass.

Each host must save host version, engine, manifest commit, cold/warm start, first frame, bridge p50/p95/p99, memory and frame rate, and distinguish between emulator and physical device. The capability may only be updated from `partial` to `full` when official tools have completed the task and the product logs are verifiable.

The software probe for `web-host-perf` will reconstruct the session according to `--iterations` and record complete pack validation, engine creation, lifecycle, and first-frame timing; `startupSampleCount` displays the actual number of samples. Then, it submits 10,000 distinct data patch values via the real WebSurface HTTP bridge and checks the runtime's `changed=10000`. `setDataSampleCount` and `setDataEntries` retain the sample range; latency includes HTTP, JSON parsing, and Rust data updates, but excludes subsequent layout/draw. The consolidated performance report re-evaluates the setData and bridge thresholds using these host-measured values, and will exit with failure if thresholds are exceeded. This probe remains a software surface diagnostic and does not measure browser frame clocks, long list drop frames, hot-start, or packet body; the reference pack must also be separately verified to include the specified 1000-node scenario.
