# Native desktop conformance host

This independent example owns a real winit window and one `HostSession`.
macOS owns an AppKit window and CAMetalLayer; Linux owns a native software
window and its softbuffer presenter. It does not use the headless simulator or the C++ desktop SDK.
macOS uses the Metal profile. Linux uses an explicitly selected softbuffer
software window, with runtime-owned raster receipts and exact frame tickets.
Windows/mobile pairs require their own actual target drivers.

The main thread loads a verified portable pack, explicitly selects QuickJS or
V8, performs `app.init`/launch/`page.push`, commits manifest-backed frames and
presents them through the selected native owner. macOS renders directly into
the Metal drawable; Linux submits raster pixels into its software window. Each successful submission is
acknowledged at the same runtime revision. Queries and input require the
current page's accepted, presented frame; retained old-route frames grant no
authority. The startup snapshot is an explicitly captured CPU diagnostic,
separate from the native presentation completion. Linux software evidence is
non-GPU and cannot satisfy the independent GPU surface gate.

The JSONL input operations are `reLaunch`, `checkpoint`, `tap`, `inspect` and
`close`, each with an `id`. A checkpoint supplies an ID and ordered selectors;
its returned text/counts come from `RenderFrame.query`. `tap` resolves exactly
one displayed node, checks that its accepted geometry can be hit, and submits
coordinates through `event.batch`. This is the native host's coordinate input
adapter, not an OS automation claim. It never calls a guest handler directly.

The issue1058 Node driver repeats the upstream's two reLaunch operations, five
checkpoints and three successful taps. Expected text is confined to assertions;
the shared passive collector normalizes the actual returned observations. Its
raw IPC and complete native bridge transcript are retained.

Build both engines separately, using one serialized Cargo lane. The example's
lockfile fixes the dependencies; the binary selected from Cargo's JSON output
is copied to an independent file and hashed. The producer checks its complete
Rust/native example source scope before and after compilation. Dirty builds
are explicitly `diagnostic`; the formal `run` export rejects them. Local Skia
source/cache prerequisites must be supplied explicitly when the upstream
fixed-version Metal archive is unavailable; a fallback is never labeled GPU.

The default remains native aarch64 macOS/Metal.

```sh
rtk proxy mkdir -p artifacts/conformance-desktop
rtk proxy node examples/hosts/conformance-desktop/build.mjs \
  --engine quickjs --out artifacts/conformance-desktop/quickjs-build --diagnostic
rtk proxy node examples/hosts/conformance-desktop/build.mjs \
  --engine v8 --out artifacts/conformance-desktop/v8-build --diagnostic
```

On a real Linux GNU host (x64 or arm64), both construction and diagnosis must
explicitly select `--host linux --presenter software`. Build each engine with
its own output directory; the locked build adds `conformance-observation` and
validates the native ELF architecture. These commands must run on that Linux
host and produce fresh source-bound binaries; an old ELF cannot certify later
source changes.

```sh
rtk proxy node examples/hosts/conformance-desktop/build.mjs \
  --host linux --presenter software --engine quickjs \
  --out artifacts/conformance-desktop/linux-quickjs-build --diagnostic
rtk proxy node examples/hosts/conformance-desktop/build.mjs \
  --host linux --presenter software --engine v8 \
  --out artifacts/conformance-desktop/linux-v8-build --diagnostic
```

The following commands **create and close a native window**. Run them only in
the task's assigned native UI lane, after source authoring has finished:

```sh
rtk proxy node examples/hosts/conformance-desktop/diagnose.mjs \
  --engine quickjs --build artifacts/conformance-desktop/quickjs-build/build.json \
  --out artifacts/conformance-desktop/quickjs-observation
rtk proxy node examples/hosts/conformance-desktop/diagnose.mjs \
  --engine v8 --build artifacts/conformance-desktop/v8-build/build.json \
  --out artifacts/conformance-desktop/v8-observation
```

Linux observations use the same replay and passive collectors:

```sh
rtk proxy node examples/hosts/conformance-desktop/diagnose.mjs \
  --host linux --presenter software --engine quickjs \
  --build artifacts/conformance-desktop/linux-quickjs-build/build.json \
  --out artifacts/conformance-desktop/linux-quickjs-observation
rtk proxy node examples/hosts/conformance-desktop/diagnose.mjs \
  --host linux --presenter software --engine v8 \
  --build artifacts/conformance-desktop/linux-v8-build/build.json \
  --out artifacts/conformance-desktop/linux-v8-observation
```

For direct binary invocation, Linux also requires `--presenter software` with
`--pack`, `--engine` and `--session`. It reports `software-fallback`,
`softbuffer-raster`, `gpuSurface=false`, `containerSurfaceAttached=false` and
`presentationCompletion=buffer-submitted`. Successful teardown must report
`softwarePresenterRetired`, session unload and native window owner drop. It
does not report Metal detach or GPU completion.

Diagnostic output has `diagnosticOnly=true`, `formalMatrixAdmitted=false` and
an execution status of `unknown`. It cannot promote the official index or pass
the matrix gate. A formal clean build supplies its `build.json` through
`WEAPP_CONFORMANCE_MACOS_QUICKJS_BUILD` or `WEAPP_CONFORMANCE_MACOS_V8_BUILD`.
Linux formal builds use `WEAPP_CONFORMANCE_LINUX_QUICKJS_BUILD` or
`WEAPP_CONFORMANCE_LINUX_V8_BUILD`. Generate exact complete driver closures
with `driver-registry.mjs`; the default registry is macOS-only and explicit
`--host` flags select unique requested hosts:

```sh
rtk proxy node examples/hosts/conformance-desktop/driver-registry.mjs \
  --host macos --host linux --out artifacts/conformance-desktop/drivers.json
```

The macOS module is `driver.mjs`; Linux uses `linux-driver.mjs`, which binds
the common implementation to software. Shared replay/collector semantics and
normalized observations are unchanged.
The existing matrix runner still requires an admitted official oracle and
clean source validation before invoking either pair.

Normal `close`, EOF, host signal, timeout and controlled event-loop errors
cross the detach/unload/window-drop barrier. A terminal cleanup record is
emitted after the event loop returns and the window owner is dropped. The Node
adapter only signals its own detached child process group and requires the
native cleanup record; it never uses global process/window shutdown.

Pure source checks and unit tests do not create windows:

```sh
rtk proxy node --test examples/hosts/conformance-desktop/build.test.mjs examples/hosts/conformance-desktop/driver.test.mjs examples/hosts/conformance-desktop/host-profile.test.mjs
rtk cargo test --manifest-path examples/hosts/conformance-desktop/Cargo.toml \
  --features quickjs-native --locked --target-dir target
rtk cargo check --manifest-path examples/hosts/conformance-desktop/Cargo.toml \
  --no-default-features --features v8-native --locked --target-dir target
```
