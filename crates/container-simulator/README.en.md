# container-simulator

[简体中文](README.md) · **English**


The explicit [modern JS/TS View profile](../../docs/modern-view.en.md) supports
synchronous ES2022 in a separate realm. Run the example with
`dev --project examples/apps/modern-view-app --surface web`; modern-only edits
repack independently and executable changes restart the session. Legacy WXS
retains its own semantics and compatibility evidence.

`container-simulator` is the local, deterministic developer harness for a
packed `weapp-vite` application. It loads the same `manifest.json` and
content-addressed blobs used by the native/Web hosts, then drives one
`container-host-common::HostSession` through batched bridge messages.

Native QuickJS/V8 sessions evaluate declared WXS in a separate View realm,
with retained page/component state and whole-document render batches. Style
reloads reuse evaluated work; WXS document/program changes restart the session.
Legacy packs without View module metadata remain unsupported. See the
[isolated View contract](../../docs/isolated-view-engine.en.md) for execution and
dialect limits.

It is intended for fast development feedback and reproducible conformance
fixtures. A green simulator report is headless evidence; it does not certify
the official WeChat DevTools, a GPU surface, an emulator, or a physical
device.

`web::DevRasterWebSession` is a separate, explicit library entry for ticketed
software Raster HTTP/SSE/ACK/input on one original runtime. The experimental
`serve_dev_raster` example owns its own port and cleanup. It does not enable the
normal CLI, attach legacy HTML to binary frame v2, or provide browser/GPU
acceptance. See the [strict wire, limits and lifecycle](../../docs/dev-raster-http.en.md).

<a id="浏览器运行时嵌入准备"></a>
## Browser runtime preparation for embedding

`DevConfig.browser_runtime` explicitly opts a `BrowserWorker` supervisor into
static preparation of an independently pinned completed Worker producer. The
supervisor owns the bounded input copy, tools, finite task and original verified
resource bytes. `BrowserRuntimePrepared` reports static readiness only;
`runtimeReady` and `presentedReady` remain false. Release resource borrowers and
retry `try_shutdown()` until it confirms cleanup. The example
`cargo run -p container-simulator --example prepare_browser_runtime -- <project> <producer> <pins.json>`
drives this real supervisor path. See [input pins, limits and lifecycle](../../docs/dual-renderer/browser-dev-artifacts.en.md).
This does not enable the browser watch CLI or start a Worker/browser.

Set `DevConfig.managed_browser_sources = true` to use the explicit owned
compiler → raw input → portable input pipeline on the same artifact ledger.
The example accepts `--owned-sources` after the pins file and waits for a
verified `PortableReady`. This profile requires the frozen vendor compiler,
QuickJS, independent runtime pins and a project without `container.config.json`;
it explicitly rejects custom builders and modern View inputs. A previous valid
pack remains owned when a new build fails. Watcher/process barriers and actual
input borrowers must drain before parent cleanup; a failed cleanup is retryable.
The profile reserves logical capacity for root/input/tools, one runtime, two
raw inputs and two portable outputs, with one finite artifact job. It does not
admit a browser site or stage. See [owned source preparation](../../docs/dual-renderer/browser-source-preparation.en.md).

`DevConfig.managed_browser_stages = true` additionally admits actual
`stage-pack` jobs on that same ledger. `begin_browser_stage` borrows the current
owned portable generation after observing the source; `poll_browser_stage`
returns a verified static `StageArtifact`. `browser_stage_resource` borrows
the original captured bytes and charge. Two stage slots include retired sites
whose bodies remain borrowed; release bodies and retry retirement/shutdown.
The executable example is `prepare_browser_stage`. This does not enable HTTP,
the browser CLI, Worker execution or presentation. See [consuming stages](../../docs/dual-renderer/browser-consuming-stage.en.md).

## CLI

Build a pack first:

```sh
pnpm container:pack -- ./dist/weapp --out ./artifacts/reference
```

Run the standard startup path (app.init, launch, page.push and a
manifest-backed render.commit):

```sh
cargo run -p container-simulator -- \
  run --pack artifacts/reference \
  --data-json '{"message":"hello from simulator","count":0}' \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

Replay a JSONL bridge script. Each non-empty line is one `BridgeEnvelope` or a
`{"messages":[...]}` batch:

```sh
cargo run -p container-simulator -- \
  dispatch --pack artifacts/reference --script scripts/dev-script.jsonl
```

The same `--script` option can follow the canonical startup lifecycle in
`run`, which is useful for deterministic engine and host fixtures:

```sh
cargo run -p container-simulator --features quickjs-native -- \
  run --pack artifacts/reference \
  --script fixtures/engine-conformance.jsonl
```

<a id="开发模式"></a>
## Development mode

From the repository root, prepare the pinned compiler before the first run:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite run build:pkgs
pnpm submodule:verify
```

Use the Node and pnpm versions declared by `vendor/weapp-vite/package.json`.
Installing the root package alone does not build the vendor compiler. See
[the preparation notes](../../docs/simulator.en.md#开发态监督器).

`dev` starts the pinned weapp-vite watcher through a separate public-API adapter.
The adapter freezes the output during the build completion event and publishes
a versioned receipt. The supervisor packs only these immutable snapshots and
serves the latest verified generation through a local Web surface:

```sh
pnpm simulator:dev -- \
  --project examples/apps/reference-app \
  --surface web
```

`pnpm simulator:dev` uses a release build while application sources remain in
watch mode. Use `pnpm simulator:dev:debug` for Rust debugging. The equivalent
Cargo command is:

```sh
cargo run --release -p container-simulator -- \
  dev --project examples/apps/reference-app \
  --surface web --host 127.0.0.1 --port 5179
```

The default address is `127.0.0.1:5179`. Use `--host` and `--port` to change
the Web listener, `--out-dir` to choose the generation directory, and
`--wv-bin`/`--node-bin` when the tools are not on `PATH`. `--open` asks the
default browser to open the Web URL for `web` or `both`. Its launcher runs and
is reaped in the background; failures print the manual URL without blocking
the simulator. The page exposes `/api/state`, `/api/frame`, the compatibility
`/api/snapshot`, `GET/POST /api/presentation`, `POST /api/bridge`, and the SSE
stream `/api/events`.

<a id="本地-gpu-场景呈现"></a>
### Local GPU scene presentation

Development Web previews now default to browser-local CanvasKit/WebGL2. The
native QuickJS/V8 session exports one accepted scene batch plus separately
addressed image resources; it does not rasterize or transport a page-sized RGBA
image on this path. `--software` explicitly restores the legacy CPU preview.
`run` and `dispatch` keep their deterministic headless defaults.

With `--features desktop-window --surface desktop`, macOS uses the Metal
presenter and Windows/Linux use an OpenGL 3.3 core drawable via glutin. All
presenters borrow the same runtime session and preserve its presentation ACK
and input-coordinate boundary. GPU initialization failures do not select a CPU
path; `--software` explicitly selects winit/softbuffer. See the [desktop window
contract and display test](../container-host-desktop/README.en.md#native-gl-windows-on-windows-and-linux).

Prepare the pinned public renderer/font dependencies once, then pass the asset
bundle with `--renderer-assets` (or `WEAPP_CONTAINER_RENDERER_ASSETS`):

```sh
node scripts/prepare-canvaskit-dev.mjs \
  --canvaskit-dir <canvaskit-wasm-0.42.0> \
  --font-file <pinned-NotoSansSC.ttf> --font-license-file <OFL.txt> \
  --out-dir artifacts/dual-renderer-dev-assets
```

The dependency hashes are in
`examples/hosts/web-wasm/renderer-dependency-pins.json`. Missing/mismatched assets
fail before the watcher starts; no software fallback occurs. The default bundle
location is `artifacts/dual-renderer-dev-assets` relative to this repository.

`GET /api/render-frame` returns a versioned layout batch. Binary image URLs are
limited to the accepted session/generation/revision. `POST /api/render-presented`
queues a receipt; the runtime-thread `presented` SSE event confirms it. Input,
ready hooks and selector/observer geometry wait for matching presentation.
Ordinary CanvasKit submission does not call `gl.finish()`; diagnostic snapshots
may synchronize explicitly. Actual hardware acceleration still requires observed
GPU evidence, independently from a WebGL context's creation.

`--renderer auto|skia|webview` selects the default/per-page manifest profile or
an explicit override. The remote Web surface supports both CanvasKit and DOM:

```sh
pnpm simulator:dev -- --project examples/apps/reference-app \
  --surface web --renderer webview --web-runtime remote
```

Explicit `webview` needs no CanvasKit assets. `auto` still prepares CanvasKit
assets so routes can switch profiles. Browser layout runs in an isolated
iframe; AppService and View execution remain on the local QuickJS/V8 runtime
thread. The DOM path uses encoded content-addressed images, never page RGBA.
Only a runtime-confirmed presentation enables input and ready hooks.

One tab is the active preview. Other tabs display accepted documents without
runtime input or geometry authority. “Set as active preview” retires the old
lease and touches before a new presentation; reconnection also requires a
fresh transaction. `POST /api/preview` queues lease operations, with final
results on SSE. `/api/view-resources/<sha256>?key=...` authorizes encoded
resources against the complete pending/accepted presentation key. Stale leases
and stale preparation request revisions are rejected before runtime dispatch.

DOM uses the browser's native DPR. Its density selector is disabled; display
zoom, logical size and target update FPS remain available. Changing a saved
density preference does not reevaluate View functions or supersample DOM.
Logical resize invokes runtime hooks and waits for new browser geometry.

The ordinary CLI now shares the managed Browser development runner:

```sh
cargo run --release -p container-simulator -- \
  dev --project /absolute/raw-mini-program-project \
  --surface web --engine quickjs --renderer webview --web-runtime browser \
  --browser-runtime-dir /absolute/completed-worker-producer \
  --browser-runtime-pins /absolute/independent-pins.json \
  --node-bin /absolute/node --port 0 --open
```

Use the same CLI with `--renderer skia` to select Worker + CanvasKit/WebGL2.
Skia requires a completed Worker producer whose independent pins specify
`"renderer": "canvaskit"`; use its matching `--browser-runtime-dir` and
`--browser-runtime-pins` pair. WebView accepts either independently pinned
software or CanvasKit producers. The original `serve_browser_dev` example
keeps its WebView startup profile.

These explicit QuickJS Worker profiles support `--route`, object
`--data-json`, and integer `--viewport` up to 4096 per side (default 375×667).
They do not require the native QuickJS feature or read saved remote presentation
preferences. Skia accepts `--render-scale auto|1|1.5|2|3|4` (default auto,
resolved from the owning preview's display density and capped at 2). Its exact
physical frame target is independent of logical viewport and simulated
`pixelRatio`; rejected target budgets retain the accepted target. WebView
uses browser density and rejects explicit render scale. Browser Skia resolves
auto once at owner startup. A live settings panel, automatic density changes
after moving displays and target-FPS controls are not implemented for Browser
mode. Remote-mode controls below do not imply Browser support. Both reject renderer
`auto`, explicit `--fps`, renderer assets and their
environment override, custom `--wv-bin`, modern View config, V8, native surfaces
and software mode before starting the watcher. Default `auto + remote` behavior
is unchanged. Each original run keeps
its own `runs/<runId>/browser-dev-summary.json`, so sequential launches may reuse
the output root without overwriting evidence. Keep the original preview open
through Stop; refresh/crash takeover is not implemented. See [Browser development](../../docs/dual-renderer/browser-dev-loop.en.md).

The Browser panel reports Worker/runtime and renderer separately. A Skia
`submitted` receipt describes one bounded local WebGL2 picture submission;
`accepted` additionally matches the current scheduler proof, logical surface,
page and viewport. Diagnostics do not grant input authority. Hardware identity
remains `unknown` and GPU completion is `not-waited`: no ordinary submission
waits for physical GPU completion. Existing DOM development evidence does not
validate the new Skia CLI path; actual smoke, hardware and performance results
remain separate evidence gates.

Native WebView (`desktop|both`), and `webview` with `--software` still fail explicitly. DOM SelectorQuery has an explicitly negotiated partial implementation awaiting native/browser validation; Remote initial startup remains unsupported. DOM intersection/scroll command adapters and some CSS/components remain unsupported. See [query limits](../../docs/dual-renderer/browser-selector-queries.en.md). Reload preflight validates
IR and resources; a later browser-only preparation failure retains the previous
image with invalid input suspended. It does not roll back arbitrary JS effects
or promise a live-manifest rollback. See [the transaction boundary](../../docs/dual-renderer/browser-presentation.en.md)
and the frozen goal checklist in `docs/dual-renderer/`.

<a id="网页解析和呈现"></a>
### Web resolution and presentation

The settings panel separates logical viewport, actual pixel density, CSS zoom,
and target/actual FPS. Defaults are 375×667 logical pixels, automatic browser
DPR capped at 2×, 60 FPS, and fit-to-window. Choose density 1/1.5/2/3/4×,
15/30/60/120 FPS, logical width/height or orientation, and fit/25%–200% zoom.
`--viewport`, `--render-scale auto|1|1.5|2|3|4` and `--fps` override saved project
preferences in `.weapp-container/presentation.json`; absent values use defaults.
Only `dev` reads that ignored file. Browser zoom is stored locally in the
browser; deterministic `run`/`dispatch` inputs remain independent.

Density rerasterizes the committed tree without restarting JS or reevaluating
stateful WXS/modern View functions. Logical resize uses the runtime resize
boundary; hit testing, rpx and input thresholds remain logical. Density does
not rewrite the simulated device's `pixelRatio`. Targets use ceil(logical ×
scale), at most 4096 pixels per side and 16 MiB of RGBA. Unsupported backends,
invalid allocations and over-budget changes explicitly fail while retaining
the previous accepted settings/frame. The panel reports real frame size and
render/transfer/decode/presentation timing; target FPS is not an acceptance
claim or a reason to render an idle page repeatedly.

Pure scrolling reuses the evaluated tree. Event accounting keeps its public
`ViewState.revision`, while automatic template work uses `template_revision`
for page/component data, properties and navigation changes. A scroll handler's
`setData` still invalidates the template. The client coalesces frame notices
already satisfied by an in-flight response, and updates the metrics HUD at
250 ms intervals while retaining every frame's internal measurements.

`GET /api/frame` returns `application/vnd.weapp.frame.v1`: a little-endian u32
UTF-8 JSON metadata length, metadata, then tightly packed straight-alpha RGBA8.
Metadata includes `schemaVersion`, `sessionId`, `frameId`, `configGeneration`,
logical/physical dimensions, stride, byte length, and measured raster/readback
`renderMs`. `frameId` is a session transport sequence; `sourceFrameId` preserves
the native id and `renderRevision` advances for scroll/density rerasterization
without requiring a new source frame id. Source Skia premultiplied alpha is converted once; alpha-zero RGB
is cleared. Clients share immutable encoded buffers, while `/api/snapshot`
encodes original premultiplied JSON only on demand. SSE retains small frame
metadata only. Old client bodies plus source/presentation buffers share a
64 MiB cache budget, including transition capacity; slow clients cannot grow
memory indefinitely. Nonblocking socket readiness advances bounded writes
without a fixed 16 ms wait per 256 KiB.

`GET /api/presentation` returns v1 settings with `revision`, `generation`,
`logicalWidth`, `logicalHeight`, `renderScale`, `effectiveScale` and `fps`.
POST a patch with current `revision` and optional `requestId`/`devicePixelRatio`;
HTTP 202 is only a queue receipt. A later `presentation` SSE event carries
`{requestId,ok,presentation,error?}` after runtime-thread application. Stale
revisions return 409. A client keeps one in-flight frame and one latest RAF
candidate, rejects obsolete session/generation frames, and suspends old-image
input while logical geometry is changing. See the [full Web
protocol](../../docs/simulator.en.md#开发态监督器) for field and budget details.

Each start atomically reserves its own run namespace and session id. Reusing
an output directory preserves earlier generations; concurrent runs have
separate staging and publication paths. The default compiler writes to its
owned `.build-output`, preserving the project's ordinary `dist`. Revisions
increase within one run.

WXSS, static assets and safe WXML presentation edits use an in-place manifest
replacement that keeps page data, storage, timers, and the session id.
JavaScript, JSON, route, app configuration, component, or dependency changes
restart the session and rotate the session id so stale input is rejected.
WXS, source/graph changes and document-local alias changes are also restart
inputs, even without custom components. Legacy inline declarations and `.wxs`
assets are checked as executable inputs. The packer stores WXS in a separate
content-addressed `viewScripts` graph and template `wxsModules` bindings;
these never enter AppService's module loader. Source bytes and graph are
verified, and inline script bodies are preserved as raw text. An isolated
View realm evaluates declared WXS and WXML in whole-document batches on native
QuickJS/V8 builds. Legacy packs without a verified module graph fail with
`ERR_UNSUPPORTED_CAPABILITY`; a missing selected provider fails with `ERR_ENGINE`.
A failed candidate keeps the previous running pack. The grammar-aware static
graph pass distinguishes division, regex, comments and escaped identifiers;
the separate WXS dialect compiler rejects unsupported forms with
`ERR_UNSUPPORTED_WXS_SYNTAX`. WXML/WXS input must be valid UTF-8.

Independent native QuickJS/V8 `ViewEngine` adapters now provide batched
execution, scope/document module ownership and timeout/cancellation disposal.
The runtime connects them to WXML evaluation. See
[the execution contract](../../docs/isolated-view-engine.en.md) for the supported
subset, tests and remaining official behavior evidence; local native tests do
not establish full WXS, DevTools, GPU or device parity.

For packs with component-scoped script modules or `usingComponents` declarations,
decoded WXML edits also restart
when they change node shape, directives, structural templates/imports/includes
or custom component inputs. Only text values and builtin presentation
attributes (`style`, `class`, `id`, `hidden`, `data-*`, `mark-*`) are ignored by
this additional fingerprint. Custom components retain all input attributes,
even ones using presentation names. Missing, new or undecodable templates are
conservative restarts. The engines have no heap rollback, so these candidates
must complete startup in isolation before replacing the live component heap;
full restarts reset JavaScript/page state. A
failed build or invalid pack leaves the previous generation running and emits
a structured diagnostic to the UI.

Presentation previews use the live page data and last committed component
snapshots without executing JavaScript, microtasks, observers or lifecycle
hooks. Components that select named templates from their own data retain that
context during text/style updates. Changed component inputs or topology are
rejected before the live heap, frame or selector index is touched.

Once the renderer publishes a frame, `render.commit` acknowledges
`committed: true`. Ready-hook or callback failures follow as structured errors;
the new generation remains current and the UI displays its diagnostics. Only
prepublication rejection retains the old generation. A ready-hook `setData`
remains pending for the next pump. Direct embedders also receive a rejection
from `Session::replace_manifest` for executable/configuration changes.

Web and desktop advance the same host clock and render invalidation boundary.
Timers, page event handlers and bridge data patches therefore refresh the
current frame without rebuilding the pack. Idle ticks publish no new frame or
trace. Asynchronous JavaScript failures join the diagnostic/overlay stream.
The first frame uses the page state after JavaScript startup and `onLoad`.
Successful reload clears active overlay diagnostics while retaining a separate
versioned `diagnosticHistory` in `/api/state` and the browser log. History keeps
at most 256 records and 512 KiB of encoded diagnostics, with explicit total,
dropped and complete metadata. Startup callback errors and timer errors use
the same stream. Desktop error status persists until a successful recovery.

Custom component occurrences are owned by the runtime session. The simulator
includes verified `blobs` in `app.init`, allowing components to attach before
page `onLoad`; component ready follows the first render commit. Each instance
has independent data, properties and scope identity. Keyed reconciliation
retains surviving instances and disposes removed ones. Component `setData`
invalidates the frame, internal handlers run on their component instance, and
projected slot content keeps its declaration data, component lookup and event
owner. Component-scoped selectors keep equal node IDs in separate instances.
Pure mustache attributes retain JSON values in optional IR `boundValues`
alongside the existing string `attrs`.

Source-only newline indentation outside `<text>` is omitted during WXML
evaluation, after stable source identities are assigned. Raw IR remains
lossless; single-line spaces, `<text>` whitespace and binding-generated
newlines remain text. The renderer measures automatic content height from
the resolved content width, padding and in-flow child margins/gaps. Source
formatting therefore does not add empty layout rows or suppress slot fallback.

Hosts may also supply optional `app.init.blobs` directly. Supplying blobs only
in a later render commit preserves the older rendering path, but does not
establish attachment before `onLoad`. The observed ordering comes from the
DevTools `2.02.2608080` / base library `3.17.3` component-instance oracle in
`docs/devtools-evidence/2026-10-19-component-instance-apis-3173`; this automatic
subset has not passed that complete official case. Component
`pageLifetimes.show/hide` follow page navigation and App foreground/background
visibility through one session boundary. New occurrences on a visible page
receive show once; covered pages, cached tabs and disposed occurrences stay
hidden. A dedicated engine batch bypasses ordinary methods of the same name,
reports throwing hooks without skipping siblings, and consumes each visibility
attempt before user code. Both reLaunch paths release cached-tab components.
The saved `lifecycle-compare-3173` oracle observes tab roundtrip show/hide, but
does not establish every cross-hook ordering. There is no automatic component
resize without a formal runtime resize event. Page/Component `selectComponent`,
`selectAllComponents` and nested `selectOwnerComponent` use live declaration-tree
references, including native-first matching and slot declaration ownership.
ID/class, child, descendant and union selectors are partial; export, `>>>`, tag
and attribute patterns explicitly remain unsupported. Fixed-SDK direct-Page-child
owner behavior is unknown. See `docs/api-runtime-conformance.md` for evidence
limits. Managed `triggerEvent` is a partial capability: the session publishes
the event graph to QuickJS/V8 before lifecycle and input callbacks, and custom
listeners run in the same JavaScript turn with local detail identity. Capture,
bubbling and composition default off; component boundaries and catch listeners
bound propagation. The saved fixed-SDK oracle covers listener aliases and
hyphen/underscore names only. Option semantics, nested synchronous emissions
and lifecycle-time events need separate official differential evidence.
Managed component relations and Behavior identity are partial: reciprocal
parent/child and ancestor/descendant links expose live instances within the
JavaScript isolate. `linkChanged` explicitly returns
`ERR_UNSUPPORTED_CAPABILITY`; movement and broader official parity remain
unverified. Complete property type rules and full official WXS/component
parity remain unverified.

Visible overflow participates in hit testing, including absolute descendants
of zero-height wrappers. Explicit overflow clipping currently constrains input;
the software/Skia painters do not yet clip descendant pixels to that boundary.
This remains partial rendering support, not visual overflow conformance.

Development sessions retain at most 1,024 normalized trace records and 8 MiB
of encoded record payloads. This includes complete retained request/response
batches, but oversized records and older history are omitted with explicit
`traceSummary` counters, `complete: false`, and `TRACE_HISTORY_TRUNCATED` in
reports/exports. The browser marks truncated history beside the trace count.
Sequence and request IDs remain monotonic through evictions and restarts.
`run`, `dispatch`, and `Simulator::from_pack_dir` keep full evidence by default.
Embedders can call `set_trace_retention(TraceRetention::development())`; a
`DevConfig` can explicitly select `TraceRetention::Full` for evidence capture.
Full retention deliberately has no memory bound. These history limits do not
prove a whole-runtime RSS or performance target.

The default watcher uses the fixed vendor's public `createCompilerContext` API;
the adapter lives in this repository and does not modify vendor sources. A
custom `--wv-bin` must resolve a weapp-vite installation or publish the versioned
receipt protocol described in `docs/simulator.md`. A quiet output directory alone
is not considered a successful build. On exit the supervisor stops its owned
watch and pack process trees, including wrappers and compiler workers.
Windows assigns suspended children to a private Job Object before execution;
descendants remain owned after a wrapper exits. Pack cancellation polls tree
termination without blocking the surface loop before releasing staging files.
`DevSupervisor::shutdown()` is an explicit, idempotent cleanup barrier also
used by Drop. Controlled CLI exits reap the watcher/readers and packer before
closing the Web listener, then release the desktop window. The terminal SSE
flush is nonblocking and best effort. Embedders should call this barrier
before releasing their own surfaces; stopped supervisors no longer poll or
pump the runtime.

Run the headless browser smoke to verify canvas pixels, lifecycle/provider
state, pointer-driven `setData`, a structured runtime error overlay, recovery
after a WXSS reload, and the shared-session `/embed` client:

Before the first browser smoke, use the vendor's declared Node/pnpm versions
to install Chromium for its pinned Playwright dependency. Installing pnpm
dependencies alone does not prepare the browser executable:

```sh
pnpm --dir vendor/weapp-vite exec playwright install chromium
```

On Linux CI runners that also need browser system libraries, use
`pnpm --dir vendor/weapp-vite exec playwright install --with-deps chromium`.
The smoke runs headless against a software RGBA surface and remains development
simulator evidence.

```sh
pnpm simulator:dev:browser-smoke -- \
  --engine quickjs \
  --out artifacts/simulator/browser-smoke.json \
  --screenshot artifacts/simulator/browser-smoke.png
```

Both this browser smoke and `pnpm simulator:dev:smoke` default to `--port 0`,
letting the OS assign a free port. The developer CLI itself still defaults to
5179. Each smoke connects only to the URL announced by its own child process
and creates an independent `mkdtemp` staging directory at
`<OS temporary directory>/weapp-simulator-smokes/simulator-smoke-*`. It restores its source edit and closes only
its own browser, watcher and Web listener before exiting; an existing developer
service is preserved. `--keep` retains this run's directory for inspection.
Both scripts accept `--engine quickjs|v8` (default: QuickJS) and build/run the
selected provider. Use `--engine v8` to test V8 explicitly; build failures and
runtime `ERR_ENGINE` responses are failures rather than a silent fallback.

The headless default build includes QuickJS and Skia CPU raster. Development
desktop mode uses Metal on macOS and requires `desktop-window`. Other desktop
GPU adapters remain explicitly unavailable. Select `--software` for a
`winit + softbuffer` development surface; it is separate software evidence:

```sh
cargo run -p container-simulator \
  --features quickjs-native,desktop-window -- \
  dev --project examples/apps/reference-app --surface desktop
```

To share one supervisor and runtime session between Web and desktop:

```sh
cargo run -p container-simulator --features desktop-window -- \
  dev --project examples/apps/reference-app --surface both
```

Compiling a presenter does not constitute actual GPU, official DevTools,
emulator, or physical-device evidence. Each boundary has separate run gates.

The desktop event loop batches pointer move/down, wheel, and keydown/keyup
events into the same `event.batch` bridge used by Web. A left-button release
emits the mini-program-compatible `tap`; other buttons emit pointerup. Keyboard events carry the
physical code, logical key, repeat/text and modifier state, and target the root
of the last committed render frame because they have no pointer coordinates.
The logical viewport stays fixed: resizing clips or pads the physical buffer
at 1:1 pixels. Use `--viewport` to choose its initial size; resizing does not
change runtime layout or send a component resize lifecycle event.

Use `--engine v8` with a build that enables the optional `v8-native` feature.
If the requested native provider is not compiled, session construction fails
with the explicit `ERR_ENGINE` boundary; the simulator never silently falls
back to another engine.

<a id="嵌入-api"></a>
## Embedding API

An app host can use the stable Rust boundary directly:

```rust,no_run
use container_simulator::{Simulator, SimulatorConfig};

let mut simulator = Simulator::from_pack_dir("artifacts/reference", SimulatorConfig::default())?;
let report = simulator.run()?;
let response = simulator.dispatch_json(r#"{
  "protocolVersion":"1.0", "sessionId":"simulator-1",
  "requestId":"set-data", "kind":"request", "op":"data.patch.batch",
  "payload":{"patches":[]}
}"#)?;
# let _ = (report, response);
# Ok::<(), container_simulator::SimulatorError>(())
```

The `HostSession` remains the sole owner of runtime state. `Simulator` only
owns pack blobs, request sequencing and normalized traces, so Android, iOS,
Harmony, desktop and Web examples can use the same startup and dispatch
contract.

The [Rust app example](../../examples/apps/embed-runner/README.en.md) takes a pack
directory. The [Web example](../../examples/hosts/web/README.en.md) shares the
development supervisor's verified pack/session through `/embed`. Native examples
have separate asset entry points: Android loads `app/src/main/assets/portable-pack`,
and Harmony loads `entry/src/main/resources/rawfile`; their README files describe
the pack sync commands. The iOS Swift Package and UIKit `ios-app` smoke still use
inline fixtures, so a business app must supply bundle manifest/module/blob loading.
See [the host entry points](../../docs/simulator.en.md#app-植入边界) for the exact paths.

The default Android native build has no QuickJS provider. It validates the pack
and submits module bytes, then returns explicit `ERR_ENGINE` for execution.
Running a real mini-program there still requires an available Android engine
build and separate device validation; pack or surface smoke alone does not
establish that capability.

Long-running embedders call `Simulator::pump(now_ns)` from their event loop,
using Unix time in nanoseconds. It drains due timers and emits a render batch
when the visible page or its data revision changes; it returns an empty batch
when idle or after app unload. The dev surfaces already perform this pump.
