# HarmonyOS host sample

This DevEco Studio/ArkUI example embeds a stable account controller with an
independent native owner for each execution incarnation. `Index.ets` owns its
ArkUI surface and forwards window, pointer and foreground events to the current
`session/LiveSession.ts`; `session/PortablePack.ts` loads the bundled
portable pack. `native_bridge.cpp` exposes the Rust host through one N-API
module. All native handle operations remain on the ArkUI executor thread,
matching the Rust runtime's thread affinity.

Startup validates the complete pack before replacing a native session, selects
the requested route (or the first declared route), and sends
`app.init → app.lifecycle(launch) → page.push → render.commit`. The render
request contains the verified resource batch and viewport, without a fabricated
page-data object. AppService supplies the current page state; `inspectState()`
is the authority for the receipt's route, data and committed frame. Native
acknowledgements must match the session, request, operation and protocol. An
unavailable engine or rejected transaction suspends the owner with a diagnostic
instead of publishing a successful frame.

The first installed run exposed missing Skia glyphs and no observed page-state
change after an OS tap. Its
[original failed evidence](../../../docs/archived-evidence.md)
is preserved. The host now installs public platform font bytes before publishing
a session, and uses a transparent ArkUI input plane with exactly the native
surface's geometry. A `ready` receipt alone still does not certify visual
correctness or user interaction.
The subsequent QuickJS reference run passed actual OS input, timers and
same-session background/resume with readable Latin text; the original failures,
screenshots and source-bound limits are in the
[font and interaction evidence](../../../docs/archived-evidence.md).

The renderer owns decoded faces and bounded positive/negative glyph caches for
the session lifetime, shared by page, Canvas and native GPU drawing. Harmony
reads `/system/fonts/HarmonyOS_Sans.ttf` and
`/system/fonts/HarmonyOS_Sans_SC.ttf` once per host, with bounded regular-file
validation. Missing or undecodable fonts reject the replacement session with
`ERR_RENDER`; the prior session remains intact. Font files are installed system
resources, not repository, mini-program or HAP assets. The inspected
`nativeFonts` field describes decoded faces without claiming untested glyphs.

The example chooses QuickJS explicitly. A host can choose V8 in the session
options only when its Rust library was built with the corresponding engine;
there is no silent fallback. The compatibility `loadManifest`, `start`,
`dispatch`, `snapshot` and `canvasSnapshot` entry points remain available, but
the live owner uses `loadManifestWithConfig` and owns startup and teardown.

The sample's `entry/src/main/resources/rawfile` contains a small checked-in
portable pack generated from the canonical `artifacts/reference` pack. At startup the
pack loader reads `manifest.json` and every declared module, template, style,
asset, WXS source and executable View resource through
`resourceManager.getRawFileContentSync`. It checks each blob's SHA-256 before
opening a native session; Rust remains the manifest schema, integrity root and
runtime validation authority. Bridge operations send whole batches across
N-API, with no per-node calls. Refresh the resource bundle after producing a new
pack with:

```sh
node scripts/sync-harmony-pack.mjs --pack artifacts/reference
node scripts/sync-harmony-pack.mjs --pack artifacts/reference --check
```

Each manifest `render.commit` carries that pack's verified resource closure,
including after pointer input, timers, foreground changes and resize. A
host-only resource-reuse flag cannot substitute for the runtime's actual
manifest render contract. The host omits page data so AppService remains its
owner across these refreshes.

The pack sync command validates the manifest schema, integrity root and every
module/template/style/asset reference before copying. It changes only the
generated `rawfile/manifest.json` and `rawfile/blobs/sha256` files; other
Harmony resources stay untouched. The copied pack is an input fixture for the
host smoke and does not turn a software snapshot or ArkUI device-context probe
into GPU/device parity evidence.

The sample imports the N-API surface with `import * as native from 'libentry.so'`.
The ArkTS compiler currently emits an informational unverified-module warning;
the namespace import compiles and runs against the packaged N-API module.

The native library is supplied explicitly to CMake. The repository build
entry discovers DevEco, the rustup target toolchain and OpenHarmony clang:

```sh
node scripts/build-native-hosts.mjs --build --platform harmony \
  --out artifacts/native-host-build-harmony.json
```

That integration command enables `quickjs-native-harmony` (rquickjs bindgen)
alongside the GLES renderer. It records a passed target build only when the
OHOS compiler, sysroot and host-tool overrides all produce a valid artifact;
the result still does not certify emulator or device behavior.
It forces the Cargo.lock-pinned Skia source build with bundled FreeType and the
custom empty font manager, using the upstream `SKIA_GN_ARGS` hook after platform
defaults. External Skia source/library overrides and documentation-only fake
bindings are rejected. No installed Cargo registry source is patched. Keep
`CARGO_TARGET_DIR` unset for this entry: artifact discovery currently uses the
repository's default `target` directory.

To compile ArkTS and package an unsigned HAP with the official SDK, use a new
output directory for each run:

```sh
node scripts/build-harmony-hap.mjs \
  --out artifacts/harmony-hap-local \
  --pack artifacts/reference \
  --bundle com.sonofmagic.weappcontainer.local \
  --sdk /Applications/DevEco-Studio.app/Contents/sdk/default/openharmony \
  --rust-lib target/aarch64-unknown-linux-ohos/debug/libcontainer_host_harmony.so
```

The builder snapshots the project into the run directory, creates a private
versioned SDK layout pointing at the installed SDK, and invokes official Hvigor
with `--no-daemon`. It records command logs, source/Rust-library hashes and the
unsigned HAP hash in `build-report.json`. It preserves the source project and
does not install, sign or launch the HAP. `--pack`, `--bundle` and `--rust-lib`
select explicit inputs; packaging succeeds only after the official compiler
produces the expected HAP. SDK compilation proves the compile/package boundary;
runtime, OS interaction and GPU acceptance require their separate evidence.

For a distributable preview archive, build both layers with `--profile release`
from the same clean commit. The HAP producer additionally requires
`--native-receipt PATH` from `build-native-hosts.mjs`; debug libraries and old
receipts without source, profile and artifact hashes are rejected. Both tools
accept `--source-root PATH` to read a separate clean source checkout while
recording the archive/build tool identity independently. Keep the output
outside that checkout so generated reports do not dirty its source identity.
The independent HAP manifest, exact-byte installer and remaining device
acceptance boundary are documented in
[`docs/platform-runtime-artifacts.md`](../../../docs/platform-runtime-artifacts.md).

The builder sets the copied module's
`buildOption.externalNativeOptions.arguments` to the selected Rust library.
Hvigor's generic `-p nativeArgs` property does not forward that value to CMake;
an in-repository build can otherwise accidentally succeed using CMake's
repository-relative default. The isolated build has no such fallback.

The command is a reproducible integration entry, not a device claim. DevEco
must provide the OpenHarmony NDK and ArkUI/N-API libraries; CI uses the Rust
cross-target check and validates the project files when those SDKs are absent.

The live-session behavioral contracts run without a device:

```sh
node --test scripts/harmony-live-session.test.mjs scripts/sync-harmony-pack.test.mjs scripts/harmony-native-surface.test.mjs
```

These tests strip types from the production session/pack TypeScript and execute it
against an instrumented native boundary. They cover startup ordering, inspected
page state, batch pointer events, timer clocks, lifecycle, resize and failure
cleanup. They do not replace an official ArkTS/NDK build, an installed HAP run,
Skia GPU evidence or device interaction.
The native surface test compiles the unchanged production `RenderSurface`
function against an instrumented EGL boundary with a host C++ compiler. It
checks identity ownership after resize destruction, allocation, binding and
query failures; it opens no native window and is not driver execution evidence.
They use Node's native `stripTypeScriptTypes` API (Node 22.13+), with temporary
modules removed after execution; no upstream npm dependency installation is
needed. The manifest CI job runs `pnpm host:harmony:live:test`, which also
compiles and executes the native decimal-argument parser contracts with a host
C++ compiler.

For an installed App interaction smoke, build a dedicated HAP with a previously
absent bundle such as `com.sonofmagic.weapp.container.smoke1234abcd`, then run:

```sh
node scripts/harmony-app-smoke.mjs \
  --target 127.0.0.1:5557 \
  --hap /absolute/path/to/entry-default-unsigned.hap \
  --build-receipt /absolute/path/to/build-report.json \
  --bundle com.sonofmagic.weapp.container.smoke1234abcd \
  --out-dir artifacts/harmony-os-interaction \
  --tap-x 250 --tap-y 520 --engine quickjs
```

Use the reference interaction pack with `count`, `timerCount`, `microtaskCount`
and `lifecycleTrace`; the default checked-in pack is not that fixture. Choose
physical tap coordinates for the attached device. The harness checks the HAP
hash, SDK receipt, unique owned PID/start ticks, foreground layout and surface
bounds before actual OS input. It verifies input/timer state and hide/show in
the same session, and saves OS PNGs for independent visual review. Its `finally`
cleanup removes only the run's previously absent bundle and exact remote
capture paths, preserving the borrowed emulator, existing apps and global logs.
It never relabels a captured screenshot as visually passed. Mocked ownership,
failure, PNG-integrity and cleanup contracts run with
`pnpm host:harmony:app:test` and do not replace an installed run.

To produce runtime evidence, build and install the HAP from DevEco and capture
the session receipts while interacting with the sample on an emulator or
device. Check that startup, input, timers, hide/show and resize retain the same
session and that inspected page/frame revisions agree with the presented
frame. A receipt records observed native state and bounded operation history;
it does not certify that an OS event occurred. `hdc shell echo` only proves that
a target is reachable and is not native container evidence.

The sample's `XComponent({ type: 'surface', libraryname: 'entry' })` obtains a
surface id from `XComponentController`. `attachSurface` creates an
`OHNativeWindow`, EGL ES 3 context and window surface; `renderSurface` submits
the latest Rust Skia frame and calls `eglSwapBuffers`. Logical viewport changes
go through the native resize boundary before another manifest render. The
surface's physical pixel dimensions remain distinct from the logical viewport.
The host currently publishes the observed logical viewport, while system
information beyond width/height (including pixel ratio, screen dimensions,
status-bar height and safe area) remains partial and may use provider defaults.
Single-pointer down/move/up/cancel events cross the bridge as `event.batch`;
the owner recognizes a bounded tap. Multi-touch, scrolling and long-press
gesture recognition require further implementation and conformance evidence.

Foreground polling uses Unix epoch nanoseconds encoded as a decimal string,
derived from validated integer epoch milliseconds without losing precision in
a JavaScript number. Background sessions do not poll or accept pointer input;
resuming sends `show` and renders the same session. This is a foreground timer
policy, not certification of background scheduling. Closing stops input and
timer work, dispatches `unload` when possible, detaches the surface and destroys
the owned native handle. Cleanup remains necessary after a failed transaction.
Native retirement first detaches Skia with a current context or abandons its
handles after context loss. A rejected abandon prevents EGL destruction. Each owner borrows the process EGL display and releases only its own context
and surface; it never terminates a sibling container's or ArkUI's display. EGL
context/surface destruction errors remain failures; handles already released are
cleared individually, so another explicit retry cannot destroy them twice.
Resize replaces an EGL surface only after destruction succeeds or
`EGL_BAD_SURFACE` proves it is already absent. Other destroy errors preserve
the old identity; binding/query failures preserve any replacement for cleanup.
An unrecoverable finalizer failure is logged and retains the unsafe-to-release
owner rather than freeing beneath live handles. A closed ArkTS receipt alone
still does not prove every driver resource was released. Native failures are retained in diagnostic strings headed by
`ERR_ENGINE`, with the inner native error included; this does not establish
structured error-code parity.

If ArkUI has delivered a new size before EGL reports the matching drawable
size, the explicit native `surface-size-not-ready` status leaves the owner in
`waiting-surface`. Its foreground pump retries attachment/presentation; input
remains paused until the current committed frame is presented, while native
business timers continue even with no surface. Continuous timer updates cannot
starve attachment retry. A terminal surface or presentation-ACK failure sets
`presentationSuspended`, retaining diagnostics and suspending input/automatic
redraw while timers and lifecycle continue. The embedding owner calls
`HarmonyLiveSession.retryPresentation()` explicitly after resolving the fault;
it first retires an attached failed surface/context, preserves the XComponent
surface ID and geometry, and attaches a new native identity before rendering.
Retirement failure stops that retry while business timers continue. Only a
successful submission and ACK restore input. Fatal runtime/protocol
failures set `runtimeFailed` and stop the timer pump separately.

The current page emits compact `WEAPP_CONTAINER_LIVE_STATE` observations and
initial `WEAPP_CONTAINER_SMOKE` acknowledgements. These distinguish SDK build,
runtime state and native frame submission from OS screenshots and interaction
evidence. A successful attach or `ready` state on a software-rendered emulator
does not establish physical GPU acceptance or visual correctness.
Behavioral contracts, SDK compilation and software snapshots also do not prove
official WeChat DevTools parity, physical-device behavior, seven-host parity or
the performance acceptance gates.

Account replacement now goes through `session/HostAccountManager.ts`, which
keeps public controllers stable and retires old native/storage owners before
creating a fresh VM. See [ACCOUNTS.md](ACCOUNTS.md) for trusted identity, backend
injection, explicit cleanup retry, fresh launch data and acceptance boundaries.
The new multi-owner native and account artifacts have independent, source-bound
evidence; historical single-session device receipts do not certify them.
