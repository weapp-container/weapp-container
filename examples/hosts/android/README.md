# Android host sample

The sample `MainActivity` owns one JNI handle and sends complete JSON batches
to the Rust `container-host-android` cdylib. It also owns a `SurfaceView` with
an EGL/GLES window surface. When the current EGL context is available, the
surface attaches it to Skia Ganesh and asks the runtime to draw the committed
manifest frame directly into the window framebuffer. `WEAPP_CONTAINER_SURFACE_PROBE` reports
`containerSurfaceAttached=true`, `gpuSurface=true` and
`rendererBackend=skia-gpu-gles` only after that direct draw succeeds and the
same session's runtime capabilities acknowledge a GPU surface. If Skia
cannot attach, the sample keeps the previous one-shot RGBA texture upload and
reports `software-fallback` with an explicit evidence boundary.

The Activity loads `app/src/main/assets/portable-pack`, a checked-in portable
pack generated from `artifacts/reference`. It verifies the manifest integrity
root using unsigned UTF-8 key ordering and every original/executable
module/template/style/asset blob SHA-256 before changing the runtime.
`PortablePack.start` sends `app.init → app.lifecycle(launch) → page.push →
render.commit` to one native handle. `app.init` invokes `App.onLaunch`, and
the launch transition invokes the initial `App.onShow` before page hooks.
Rendering uses the route's manifest
template and live AppService data, including `onLoad/setData`; it does not
substitute a test rectangle. Refresh the checked-in fixture with:

```sh
node scripts/sync-android-portable-pack.mjs --source artifacts/reference
```

The pack is an input fixture for the host smoke. It does not turn an Android
software or EGL probe into GPU/device parity evidence.

The configured loader requires the requested native engine provider. A build
without that provider returns `ERR_ENGINE` before startup and never falls
back to another engine or an empty app. The older default-load C ABI remains
available to existing callers. `MainActivity` accepts intent string extras
`weappContainerEngine=quickjs|v8`, `weappContainerSessionId`, and
`weappContainerFixtureId`; omitted fixture ID is `portable-pack-reference-v1`
(the same fixture identity as iOS). Omitted engine
selects QuickJS, and omitted session ID creates a fresh UUID for the Activity.

After acknowledged startup, the sample atomically writes
`files/portable-pack-execution.json` in its own app data directory. It retains
the full correlated startup requests/responses, verified snapshot metadata,
manifest, engine, session and frame IDs. The first successfully swapped startup
frame freezes this file with its surface receipt; later interactive frames
never overwrite the startup identity. A new Activity clears the previous file first. This
avoids relying on truncated Logcat records. Binary build identity remains
`unknown` until an external build/installation harness proves it; the app
does not infer provenance from a source checkout.

Startup waits for the actual `SurfaceView` extent and root `WindowInsets`.
`Display.getRealSize` supplies a separate current-orientation screen extent;
`resources.displayMetrics.density` supplies the observed pixel ratio. Extents
are divided by that density and rounded to the nearest logical pixel, with
positive half ties upward; invalid/zero observations fail instead of using
a default ratio or clamping a logical extent. These values reach host
providers before any app modules run. Configuration supplies orientation;
it is not inferred from the viewport aspect ratio. `screenTop` uses the
decor window's observed upper edge, separately from the Surface input origin.
Status-bar insets use `getInsetsIgnoringVisibility` on API 30+, excluding IME;
API 26–29 use stable top with an explicit diagnostic limitation. These are
host mapping contracts, not established fixed-DevTools equivalence. Raw
insets remain diagnostic: the portrait-coordinate origin for public
`safeArea` is unproven, so this field is omitted rather than synthesized.
`PortablePackSession` then owns native input, lifecycle, timers and rerenders
on the Activity main thread. Each Android input batch crosses JNI once;
Rust performs hit testing, capture/target/bubble, datasets and component
handler dispatch against its committed frame. Surface-local touch coordinates
are scaled to that logical viewport. Single-pointer start/move/end/cancel and
tap are implemented; multi-touch cancels the active gesture. Longpress,
scroll recognition and native pointer target capture remain partial.

Surface resize updates the same Rust session's `HostMetadata`, synchronous
`wx.getWindowInfo`/system-info providers, `Page.onResize` and live component
`pageLifetimes.resize`, then rebuilds the manifest frame without loading a new
isolate. Activity configuration changes retain that owner.
One complete JSON observation crosses JNI atomically, including when only
density, screen size or insets changed. Display-only updates refresh provider
values without replaying `onResize`; duplicate observations do nothing. The
older size-only C ABI remains available and preserves existing display data.
Resume/pause send deduplicated show/hide transitions through App, the current Page and its live
components. Insets are captured from incoming Decor dispatch before the default Decor policy;
the listener calls that policy and returns its result unchanged. A consuming
content parent cannot block this window-level observation. Surface geometry is
joined only at preDraw after layout, with actual holder frame, Surface callback
extents and View layout agreeing. Decor reattachment requires a new Insets
epoch; a Surface-only recreation can retain the current Window epoch.
`WEAPP_CONTAINER_WINDOW_OBSERVATION` logs versioned pending/ready diagnostics
and dispatch/layout provenance without treating cached Insets as fresh.
Resume first forces one complete valid window observation, even
when unchanged, and refreshes native provider values before dispatching show;
an invalid observation never resumes user hooks. This order is an implementation regression contract; joint
App/Page background callback ordering has not been established by the fixed
DevTools oracle. Choreographer polls timers only while
foreground. Its uptime timestamp schedules callbacks only: every actual poll
samples `System.currentTimeMillis()` and converts Unix epoch milliseconds to
nanoseconds, matching Rust `SystemTime` and AppService `Date.now()` deadlines.
Surface submission or presentation-ACK failure sets `presentationSuspended`:
input and automatic redraw stop while business timers and foreground lifecycle
continue. The embedding owner may call `MainActivity.retryPresentation()` to
restore its EGL context and explicitly submit current state; input resumes only
after a matching successful presentation ACK. Fatal runtime/protocol errors
remain separate and stop the timer pump.
The conversion rejects negative or signed-JNI overflow values before native
dispatch, rather than clamping or wrapping into a different date. Destruction
unloads once before releasing EGL and the JNI
handle. Continuous media-query observer notifications remain partial.

Debuggable APKs additionally publish `files/portable-pack-interaction.json`:
the session/integrity, logical viewport, actual host dimensions, page data,
full committed `RenderFrame` (`frame_id`), bounded operation/lifecycle/error
history and a pixel-free snapshot digest. Surface geometry records physical
extent, density and screen origin. Top-level `windowObservation` records raw Display/Surface extents, density,
rotation/configuration, distinct window/surface origins and stable insets,
with the Android API sources named. Top-level `displayMetrics` comes from
the Rust inspection, separately from those raw observations. Both the frozen
startup receipt and dynamic interaction receipt include this distinction.
`surface.presentedFrameId` advances only
after `eglSwapBuffers` succeeds and stays distinct from the committed frame;
surface loss clears that identity and backend until a new successful swap.
A same-size replacement Surface re-presents the last committed frame after a
valid join and successful native synchronization, without reloading the session
or manufacturing a new frame.
Before drawing, the presenter queries the current EGL drawable allocation.
SurfaceView geometry alone does not establish its backing size: the tested
emulator can keep the previous allocation until a swap. A mismatch retires and
recreates only the EGLSurface, preserves the context and live JS session, and
rechecks the acquired size before calling the renderer. Persistent mismatch
reports `ERR_RENDER`; it cannot receive a successful presentation receipt.
`surface.drawableObservation` v2 retains target epoch, allocation and GL state
before the transition, before/after drawing and after swap. The credited frame
must retain the accepted physical extent and current EGL target throughout.
EGL handle identities use unsigned hexadecimal strings so JSON consumers
retain every pointer bit. They identify only this live process, not a portable
resource or a stable identity across launches.
Zero means no frame is currently presented. Background and failed sessions report
`suspended` with separate `foreground`, `runtimeFailed`, `presentationSuspended`
and diagnostics fields. Empty timer
polls do not write receipts. Page/layout inspection is development-only and
is not persisted by release builds. GPU rerenders pass committed frame metadata
without RGBA readback; the startup screenshot remains an explicit diagnostic.
Input/frame latency has not passed a performance gate.

Build a clean, source-bound APK and retain its build receipt outside the
checkout. The default `dev` profile produces a debuggable APK:

```sh
node scripts/build-android-apk.mjs \
  --out-dir /absolute/path/to/android-build \
  --engine quickjs
```

Use the release profile to compile the optimized native library and Android
release variant. The sample project leaves signing to the embedding application,
so this output is explicitly unsigned and must be signed before distribution:

```sh
node scripts/build-android-apk.mjs \
  --out-dir /absolute/path/to/android-release \
  --engine quickjs \
  --profile release
```

The producer builds the Rust host, runs the project's Gradle 8.13 wrapper from
an isolated Android project copy, verifies the exact native library embedded
in the APK, and records the source-file inventory and APK digest in
`android-apk-build.json`. The receipt records the selected profile and signing
boundary. It requires a clean Git worktree. The output directory
must be outside the repository.

Run the source-bound APK on an explicitly selected target:

```sh
node scripts/mobile-runtime-smoke.mjs --platform android \
  --android-apk /absolute/path/to/android-build/app-debug.apk \
  --build-receipt /absolute/path/to/android-build/android-apk-build.json \
  --expected-source-commit "$(git rev-parse HEAD)" \
  --engine quickjs --out /absolute/path/to/android-build/android-runtime-smoke.json
```

The source gate passes only when the receipt's clean source commit, source-file
inventory, Rust ABI, Gradle output and APK hash all match the executed APK.

For lower-level native boundary diagnostics, build the native artifact directly:

```sh
node scripts/build-native-hosts.mjs --build --platform android --engine quickjs \
  --out /absolute/path/to/android-native-build.json
```

The native builder selects `quickjs-native-android` by default. This feature
uses NDK/bindgen bindings for the actual Android ABI; plain desktop QuickJS
bindings are not reused. An explicit `--engine v8` requests V8 and must fail
when that target's native provider cannot build; it never substitutes QuickJS.

With Android Gradle Plugin, the NDK and an installed Gradle available,
assemble the APK by passing one Rust artifact per selected ABI. The sample
defaults to `arm64-v8a` when only the legacy property is supplied, and accepts
both 64-bit and 32-bit ARM libraries for a universal APK:

```sh
gradle :app:assembleDebug \
  -PweappContainerAndroidRustLibArm64="$PWD/../../../target/aarch64-linux-android/debug/libcontainer_host_android.so" \
  -PweappContainerAndroidRustLibArmv7="$PWD/../../../target/armv7-linux-androideabi/debug/libcontainer_host_android.so"
```

Build the 32-bit Rust host explicitly when it is needed outside the demo
packager:

```sh
node scripts/build-native-hosts.mjs --build --platform android \
  --android-abi armeabi-v7a --out artifacts/android-armv7.json
```

The native ABI target is `armv7-linux-androideabi`; its Android deployment
floor remains API 26 because the pinned Skia backend requires that floor.

The Gradle/CMake project is an integration skeleton. APK signing, installation
and emulator/device validation remain separate gates.

The smoke runner installs the APK on the first online adb target unless an
explicit `WEAPP_CONTAINER_ANDROID_SERIAL` is set. It uses a unique session,
polls the app's atomic receipt for the matching engine, fixture and attached
Skia GLES frame, then force-stops only this sample package. The report keeps
the APK digest, runtime receipt, renderer probes and command diagnostics.
The runner requires a debuggable APK because it reads the app-owned receipt
through `run-as`. It blocks before launching an already installed package when
installation fails or a release APK does not expose that receipt boundary.

For the bundled reference fixture, add the explicit interaction plan on a
selected official emulator and a debuggable APK:

```sh
node scripts/mobile-runtime-smoke.mjs --platform android \
  --android-apk /absolute/path/to/app-debug.apk \
  --engine quickjs --out /absolute/path/to/android-reference-smoke.json
```

This entry validates startup, rendering, canvas/API probes and the attached
GLES surface for the selected engine. It does not perform the interaction,
resize or screenshot plan described by older documentation.

Without `--build-receipt`, source provenance remains `unknown` and the report
cannot pass the source gate. A saved `apk-validation.json` may be supplied with
`--build-receipt`; its native-input and isolated Gradle receipt hash chain must
match the exact APK. `--expected-source-commit` selects an explicit immutable
baseline when testing an older artifact; the harness commit and binary source
commit remain separate. The default baseline is the current HEAD.

Screenshot capture requires separate visual review. An attached Skia surface
does not establish hardware acceleration, touch, resize, app lifecycle, real
device or near-parity conformance.

The checked-in Kotlin contract source is a standalone harness. The Android
Gradle build compiles it with the production sources, while the runtime smoke
above is the executable device check:

```sh
ANDROID_HOME=/absolute/path/to/Android/sdk \
  gradle :app:compileDebugUnitTestKotlin --no-daemon \
  -PweappContainerAndroidRustLibArm64=/absolute/path/to/libcontainer_host_android.so
```

The standalone source covers pack integrity, timer conversion, lifecycle
cleanup and JNI attachment ownership. It does not establish native JS,
Android process, EGL, GPU or device execution, which requires the smoke
command above.
