<a id="weapp-容器浏览器-worker-以及传统嵌入示例"></a>
# Weapp Container browser Worker and legacy embedding examples

[简体中文](README.md) · **English**


<a id="默认工作程序产品入口"></a>
## Default Worker product entry

`index.html` loads `worker-app.mjs`, which owns one asynchronous
`WorkerWebSession`. AppService/QuickJS lives in a Dedicated Worker. The page
owns either the DOM presenter (`webview`) or the pinned CanvasKit presenter
(`skia`/`skyline-compat`), selected from the verified manifest. Application glue
is not imported by the default Window graph. CanvasKit drawing WASM may run on
the Window; it is separate from AppService WASM.

Build with `--execution worker` (the new default). A pack containing any
external-frame route requires explicit `--renderer canvaskit`,
`--canvaskit-dir`, `--font-file` and `--font-license-file` inputs shown below.
A pure webview pack needs no CanvasKit assets; the legacy `software` default
is only an asset-packaging choice and never selects a Worker software renderer.
Missing assets fail explicitly, without an engine, HTTP or main-thread fallback.

The builder emits `worker-product-config.mjs` with the expected SHA-256 and size
of the exact retained `pack-index.json` bytes, including its trailing newline.
The owner and Worker independently verify that pin and the manifest. Route may
be selected with `?route=pages/home/index`; engine, renderer, execution and pin
query overrides are rejected. The config is a static deployment trust root,
not protection against replacement of the entire deployment.

The builder separately retains static sources, generated config/index and all
regular generated `pkg/` files including snippets. A planned Worker build
records `plannedAppServiceThread: "worker"`, `appServiceThread: "unknown"`,
`workerProductEnabled: false` and product execution `not-run`. Building and
interface checking do not prove product execution. Actual default-entry browser
evidence, accepted presentation/input, GPU and performance remain separate
gates; no new success is claimed by this wiring alone.

The page exposes the actual async owner as `window.weapp`, runtime load Promise
as `window.weappReady`, first accepted current input-enabled presentation as
`window.weappPresented`, bounded observations as `window.weappTrace` and the
entry's awaitable close barrier as `window.weappClose`. Runtime readiness alone
does not certify a visible frame. The owner already owns business timer polling,
visibility and pagehide. The bootstrap adds no second RAF or lifecycle owner.
Each bootstrap accepts one app; await close before creating a replacement.
Pass the host's complete `metrics` observation in `WorkerWebSession.load` when
guest module initialization needs window/system snapshots, including with
`hostServices`. The load transport installs its `pixelRatio`, screen extent,
orientation and optional safe area in the native Session before any guest
module runs. Window dimensions must match `viewport`. Sample or explicitly
provide these values for each new owner, including preflight and recovery;
render scale and the owner's layout defaults do not establish a display
observation. Without `metrics`, unavailable native snapshot fields stay
unavailable rather than inheriting an old owner's values.
`revokeHostIdentity()` permanently gates this owner's input, business calls,
late application results and host batch callbacks. Its queryable
`status.identityRevocation` records pending/revoked/failed control attempts;
normal retirement keeps `status.fault` clear and can close successfully. A
failed native revoke keeps the execution gate closed and permits an explicit
retry of the same control. Await `BrowserHostServices.close()` before the
session's `close()` so failed device/file releases retain their exact handles
for an explicit service close retry. Existing execution faults and real native
or cleanup failures still reject close; a new account needs a fresh owner.
Without an explicit renderer-transition opt-in, the owner remains fixed to its
initial family and reports cross-family navigation as requiring a new owner.
Static products can explicitly negotiate same-Worker DOM/Skia transactions with
[`rendererTransitions: {"version":"1.0"}`](../../../docs/worker-presenter-transactions.en.md).
This opt-in does not enable ordinary simulator browser-auto.

`node --test scripts/worker-product-entry.test.mjs` checks direct bootstrap and
wrong-realm contracts. These authored tests use owner doubles and do not stand
in for the actual retained default-entry browser gate. The prior standalone
Worker probe uses its own harness and does not establish product presentation.

<a id="默认入口合同和浏览器烟雾"></a>
## Default-entry contracts and browser smoke

`pnpm host:web-worker:test` includes the owner, admission, DOM/CanvasKit
adapters, revision fencing and entry contracts. `pnpm host:web-wasm:test`
includes generated package/parser closure and product browser-runner contracts.
Both commands are called by the existing manifest CI job; they do not launch
the actual product browser or claim GPU acceptance. `pnpm host:web-worker:smoke`
remains the earlier standalone Worker probe.

The builder requires the installed, lockfile-pinned Acorn 8.15.0 dependency from
`tools/container-manifest/node_modules/acorn`. Run `pnpm install --frozen-lockfile`
first. It verifies exact executable parser and license bytes, retains them under
`validation/generated-module-parser/`, and checks the entire generated JavaScript
package before evaluating its glue. npm integrity is provenance metadata;
the builder does not claim to authenticate a downloaded archive.

The actual default-entry gate needs two fresh, source-stable sites built from
the same clean commit: a `webview` pack and a separate `skia` pack. The dedicated
`fixtures/worker-product-browser` fixture supplies renderer config files. Pack
each with the current fixed compiler SHA and its matching config:

```sh
node tools/container-manifest/bin/container-pack.mjs fixtures/worker-product-browser --out DOM_PACK_DIR --compiler-commit FIXED_COMPILER_SHA --project fixtures/worker-product-browser --config dom.container.config.json
node tools/container-manifest/bin/container-pack.mjs fixtures/worker-product-browser --out CANVAS_PACK_DIR --compiler-commit FIXED_COMPILER_SHA --project fixtures/worker-product-browser --config canvaskit.container.config.json
```

Build DOM with `--execution worker --renderer software` and CanvasKit with
`--execution worker --renderer canvaskit` plus the explicit dependency inputs.
The DOM `software` packaging label does not select a CPU pixel presenter.
Independently retain each exact `pack-index.json` SHA-256, then run:

```sh
pnpm host:web-worker:product-smoke --dom-site-dir DOM_SITE_DIR --dom-index-sha256 DOM_EXACT_INDEX_SHA256 --canvas-site-dir CANVAS_SITE_DIR --canvas-index-sha256 CANVAS_EXACT_INDEX_SHA256 --out-dir NEW_PRODUCT_EVIDENCE_DIR
```

The runner visits the unchanged default entry with its real Worker and
presenters. It verifies actual input, accepted presentation, resize, 2x repaint,
visibility and owned cleanup; it keeps one headless browser/page across both
sites. No API server or off-origin network fallback is allowed. The installed
Playwright module comes from the fixed vendor dependency unless
`WEAPP_CONTAINER_PLAYWRIGHT_MODULE` names another explicit installed module.
Raw fixture packing does not establish weapp-vite watch execution. Driver
identity, physical GPU, timing, other hosts and official parity remain separate
acceptance gates. The old synchronous `web-wasm-browser-smoke.mjs` explicitly
rejects these Worker sites and is only for `--execution legacy` builds.

<a id="显式旧版导入和详细集成说明"></a>
## Explicit legacy import and detailed integration notes

Build with `--execution legacy`, then open the report's explicit `legacy.html`
entry. `app.mjs` keeps the synchronous `WeappWebSession` and `unixTimerNanos`
exports unchanged. Its AppService runs on the Window and remains `main / false`
in build metadata. The old synchronous browser smoke selects this explicit
entry and rejects Worker build plans. Historical builds without execution
metadata retain their old index entry. The following software/Canvas 2D and
synchronous-wrapper notes apply to this legacy lane.

This example loads a portable pack into the Rust `WebWasmHost` compiled as a
real browser WebAssembly module, with the QuickJS provider inside that module.
The default Canvas 2D presenter receives one typed RGBA frame per render.
The optional CanvasKit presenter receives one complete layout frame and draws
on WebGL2. Neither mode establishes full WeChat parity or Web V8 support.

Build a portable pack first, then build a new static output directory:

```sh
node scripts/build-web-wasm.mjs \
  --execution legacy \
  --pack /absolute/path/to/portable-pack \
  --out-dir /absolute/path/to/new-web-output \
  --llvm-bin /opt/homebrew/opt/llvm/bin \
  --wasm-bindgen /absolute/path/to/wasm-bindgen
```

The selected rustup toolchain must have `wasm32-unknown-unknown` installed.
LLVM must provide `clang` with the WASM backend and `llvm-ar`; the script probes
both with an actual WASM C object/archive before Cargo. `wasm-bindgen --version`
must exactly match the `wasm-bindgen` version in the retained `Cargo.lock`.
Paths can also be set with `WEAPP_CONTAINER_LLVM_BIN` and
`WEAPP_CONTAINER_WASM_BINDGEN`. The script never installs or changes tools.

To build the CanvasKit variant, add these explicit local inputs:

```sh
  --renderer canvaskit \
  --canvaskit-dir /absolute/path/to/canvaskit-wasm-0.42.0 \
  --font-file /absolute/path/to/NotoSansSC.ttf \
  --font-license-file /absolute/path/to/OFL.txt
```

The builder pins the full CanvasKit JavaScript/WASM, package metadata and BSD
license, and the original Noto Sans SC variable font and OFL license, by exact
SHA-256 and size. See `RENDERER_DEPENDENCY_PINS` in the build script for the
required bytes and public source URLs. It stages these dependencies plus
`runtime-config.json`; an invalid or missing input fails without renderer
fallback. Dependencies are supplied by the caller, rather than downloaded by
the builder. Extracted file verification is recorded separately from archive
verification.

The same pinned files can be prepared for the native development simulator:

```sh
node scripts/prepare-canvaskit-dev.mjs \
  --canvaskit-dir /absolute/path/to/canvaskit-wasm-0.42.0 \
  --font-file /absolute/path/to/NotoSansSC.ttf \
  --font-license-file /absolute/path/to/OFL.txt \
  --out-dir /absolute/path/to/new-renderer-assets
cargo run --release -p container-simulator -- dev \
  --project examples/apps/reference-app --surface web \
  --renderer-assets /absolute/path/to/new-renderer-assets
```

The preparer verifies the six shared hashes and sizes before publishing an
output directory. The simulator verifies them again and serves only that
allowlist. It does not fetch dependencies. This dev mode keeps one AppService
and one runtime in Rust; `remote-canvaskit.mjs` receives a complete render frame
and draws it in the browser. It does not start another WASM app session.
Development Web rendering requires these assets by default. Explicit
`--software` retains the CPU RGBA diagnostic mode; a CanvasKit failure never
silently selects that path.

`GET /api/render-frame` carries session, configuration generation and render
revision plus image descriptors. Image bytes use their decoded RGBA SHA-256,
with URLs authorized for the current session/generation/revision. The client
verifies hashes and keeps a bounded decoded-resource cache. The server revokes
old URLs while allowing already admitted immutable responses to finish.
`POST /api/render-presented` only queues a CanvasKit submission receipt. Input
resumes after the runtime owner confirms the same identity through a `presented`
event; stale or unconfirmed `event.batch` requests return `ERR_CANCELLED`.
This confirms matching runtime and browser state, not physical GPU completion.
Context loss pauses input, and recovery redraws before enabling input again.

Run the owned development browser gate with
`node scripts/simulator-canvaskit-browser-smoke.mjs --binary
/absolute/path/to/release/weapp-simulator --renderer-assets
/absolute/path/to/renderer-assets --out /absolute/path/to/new-evidence`.
It copies the reference project into its own temporary directory, starts an
ephemeral simulator and one headless browser page, then records ready/input/2×
density/stale-receipt checks and cleanup. Browser GPU receipts and explicit
readback evidence remain separate; SwiftShader is identified as a software
driver and physical hardware remains unknown. The script never touches the
user's existing simulator listener or browser tab.

The default profile is `release`. Pass `--profile dev` for development,
`--offline` to require cached Cargo dependencies, or `--target-dir` to reuse an
explicit Cargo cache. Cargo always builds the cdylib with
four jobs by default; `--jobs 1` through `--jobs 256` explicitly record a different
parallelism limit in the build plan. Use this option instead of exporting
`CARGO_BUILD_JOBS`: custom Cargo environment settings still retain their existing
provenance restrictions. The compiled configuration is
`--no-default-features --features wasm,quickjs-native --target
wasm32-unknown-unknown --locked`; `cargo check` and native host binaries cannot
satisfy this build. The copied WASM must export the actual `WebWasmHost` entry
points as functions, either unsuffixed or with wasm-bindgen's 16-hex suffix;
descriptor exports and similarly prefixed names cannot satisfy the interface.
An owned Node process imports the generated JavaScript and checks its default
initializer and `WebWasmHost` methods without initializing WASM or constructing
a host. Its reflected interface is retained in `build-report.json`.
`SDKROOT` and `SDKTARGETSYSROOT` are removed only from child build-tool
environments, preserving the caller's SDK settings.

The output directory must not exist. It retains verified `portable-pack/`,
`pack-index.json`, `pkg/container_host_web.js`,
`pkg/container_host_web_bg.wasm`, `index.html` and `app.mjs`. Serve this directory
with a static HTTP server; no native container server is involved:

```sh
python3 -m http.server 5181 --bind 127.0.0.1 --directory /absolute/path/to/new-web-output
```

Open `http://127.0.0.1:5181/legacy.html` in a browser. The app checks manifest/blob hashes
from `pack-index.json`, starts one runtime session, and presents its frame.
`WeappWebSession` in `app.mjs` is the embedding wrapper. The example exposes
`window.weappReady`, `window.weapp`, and bounded `window.weappTrace` for smoke
verification. The dispose button unloads the session and frees its WASM owner.
Timer polling, input and page visibility use batched bridge calls.
Timer polls pass Unix epoch nanoseconds, matching Rust `SystemTime` and
AppService `Date.now()` deadlines. RAF's relative timestamp only schedules
the pump. Each poll samples `Date.now()`, validates integer milliseconds and
converts to `BigInt` before multiplying by `1_000_000n`, rejecting values
outside unsigned 64-bit nanoseconds instead of wrapping or losing precision.
Each wrapper accepts one load; concurrent or repeated loads fail immediately.
Closing during loading aborts app resources and cancels that caller's wait for
CanvasKit. A verified CanvasKit module is cached for the page lifetime; closing
one app releases its own surface/context/font, rather than the shared module.
If presentation fails after Rust commits a new hit tree, input and automatic
presentation pause until an explicit render succeeds, preventing input against
invisible nodes. Business timer polling continues independently of presentation.
Diagnostics retain the structured error code.

`source/` is a byte-verified snapshot of the scoped Rust/workspace/build/sample
inputs. Cargo compiles this snapshot, so edits to the original checkout cannot
silently change an in-progress build. `source-snapshot.json` binds commit,
individual SHA-256 values, scope and dirty state. `raw/` retains Cargo's linked
WASM; `build-report.json` records exact raw/bindgen WASM hashes, tool versions,
commands and limitations. Complete command output is saved under `commands/`.
Cancellation or timeout terminates only that command's owned process group.

The builder freezes source before validating or copying the portable pack. It
imports the validator only from that snapshot: `portable-pack.mjs`, its modern
View resource helper and the Node-only `json-integrity.mjs` helper. This closure
needs no npm compiler dependencies and never executes the original checkout's
validator helpers. `build-report.json.packValidator` records its entry point,
individual file hashes and combined source hash. The builder checks these bytes
before import and rechecks the complete snapshot before reporting ready.

`WEB_SAMPLE_FILES` is the single browser source/staging inventory. The output
also contains the complete Worker foundation (`runtime-worker.mjs`, its owner
and RPC client), Worker bridge adapter and DOM presenter/session-client closure.
`browser-assets.json` lists each copied file's frozen source path, SHA-256 and
size; `build-report.json.browserAssets` binds that inventory's exact bytes and
records the final retained-file verification. Missing or changed closure files
fail the build before it can report ready.

These files are packaged for both explicit entry graphs. The
`legacy.html` loads `app.mjs`, which imports and constructs WASM on the
page's main thread. Legacy inventory and report explicitly record
`appServiceThread: "main"` and `workerProductEnabled: false`. Default Worker
entry and build-plan metadata are described above; packaging alone establishes
neither actual product execution nor performance.
Generated `pkg/` glue/WASM and pinned renderer/font resources retain their own
existing hash and interface gates.

A stable dirty snapshot or inherited custom compiler flags can yield a usable
artifact, but its report is `partial` and the command exits nonzero. Failed or
cancelled outputs retain diagnostics and never report ready. A clean `passed`
build establishes compilation and pack integrity only; browser execution,
input, CanvasKit/GPU, device and performance acceptance require separate tests.

<a id="canvaskit-帧呈现器"></a>
## CanvasKit frame presenter

`canvaskit-presenter.mjs` accepts one complete Rust `RenderFrame` at a time:

```js
const presenter = await CanvasKitFramePresenter.create(CanvasKit, canvas, fontArrayBuffer, {
  typography: 'native-v1',
})
const receipt = presenter.submit(JSON.parse(host.render_frame_json()))
// After input/setData: dispatch and commit in Rust, then submit the new frame.
const readback = presenter.snapshotEvidence() // explicit GPU readback, not the hot path
presenter.dispose() // before disposing/replacing the canvas or its dimensions
```

Select `renderer_mode: 'external-frame'` in
`WebWasmHost.load_manifest_json_with_config(...)` when using this presenter.
Rust then validates and retains each complete frame without also rasterizing a
software bitmap on every commit. Native embedding uses
`WebSessionOptions { renderer_mode: WebRendererMode::ExternalFrame }` with
`WebHost::load_manifest_json_with_options`. The default remains `software`;
invalid mode values fail with `ERR_RENDER`. Rust capability and commit receipts
report `external-frame-export` with no attached GPU. Explicit snapshot requests
in that mode are software diagnostics; CanvasKit's actual GPU receipt and
readback remain separate.

For an attached DOM presenter, the host API also accepts
`renderer_mode: 'browser-view'`. This explicit mode enables View transactions
and forces the WebView profile; it reports `browser-view-export`, without
claiming a live DOM surface or GPU. Use `view.prepare`, `view.prepare.commit`
and `view.presented` with their complete presentation keys. Skia frame,
software snapshot, density and renderer ACK APIs are rejected in this mode.
This host option alone does not add a DOM entry point to `app.mjs` or implement
page-by-page mixed rendering.

`runtime_state_json()` provides the authoritative current route/page, logical
viewport, effective profile, exact decimal-string view/render revisions,
lifecycle and execution fault. It does not expose page data or certify
presentation. Window observations,
authorized binary assets and preview retirement use
`notify_window_metrics_json`, `browser_view_resource` and
`retire_browser_preview`; resource reads require a complete authorized key.
Worker hosts must explicitly configure finite startup and turn limits as
described in [AppService execution](../../../docs/appservice-execution.en.md).
The explicit legacy example owns its WASM host on the main thread.
The Worker owner and transport are documented in
[Browser Worker transport](../../../docs/browser-worker-transport.en.md); run their
local contracts with `pnpm host:web-worker:test`. The default entry now uses
the asynchronous owner, while this legacy canvas example remains separate.
The Worker foundation separately bounds outstanding events, acknowledges their
client consumption through a control lane, and fails explicitly on event
backpressure. Event receipts do not authorize presentation. Its total startup
deadline uses a monotonic clock; timer polling continues to use Unix time.

The caller supplies verified CanvasKit `0.42.0` and a font with the needed glyph
coverage. The presenter has no downloader, package loader or runtime dependency
installer. It requires `GetWebGLContext → MakeWebGLContext → MakeOnScreenGLSurface`
and checks that the surface is GPU-backed. Unavailable WebGL, lost contexts and
unsupported frames throw structured `ERR_RENDER`/`ERR_UNSUPPORTED_CAPABILITY`
errors; it never selects a CPU surface. Driver strings remain separate from
physical hardware evidence. Resizing the canvas requires disposing and recreating
the presenter. Its cleanup releases fonts, pictures, surface and owned context.

The full frame is checked before picture recording; recording completes before
the visible surface changes. Invalid/unsupported frames retain the previous
frame. Driver failures during actual submission cannot promise rollback. The
receipt records one frame batch, zero per-node runtime calls and zero software
RGBA uploads. CanvasKit's own local draw bindings still run per draw command.

Normal submission flushes queued drawing without `gl.finish`; its receipt says
`gpuCompletion: 'not-waited'`, so a submitted frame does not claim GPU completion
or display presentation. `snapshotEvidence()` explicitly synchronizes and reads
back the surface, returning `gpuCompletion: 'gl.finish'`. Evidence readback is
separate from normal drawing and must not be called on every animation frame.

Decoded RGBA images are cached across accepted frames. A resource ID is only a
lookup key: reuse also requires equal dimensions and every RGBA byte to match an
independently owned copy. A changed resource, including caller mutation under an
unchanged hash-looking ID, creates a new image. Cache publication and LRU access
updates occur only after successful submission and temporary picture cleanup;
failed preparation or recording releases new images while preserving old entries.
The cache retains at most 1024 entries and defaults to a 64 MiB accounting budget
for the RGBA validation copies plus an equal-sized estimate for SkImage pixels.
Driver overhead and queued GPU work are not included in this estimate. Set
`imageCacheBytes` to a smaller integer, including zero, when creating the
presenter; values above 64 MiB fail. Oversized images can still draw as temporary
resources within the existing per-frame limits. Context loss and `dispose()`
release cached images before destroying the GPU context; cleanup failures remain
observable and disposal does not delete an owner twice.

Web/WASM CanvasKit product owners now install the exact admitted font before
`app.init`. Rust reads its SFNT metrics for layout, wrapping, normal line height
and baseline; committed plans carry `{font:{sha256,face_index:0,
profile:"sfnt-unhinted-v1"}}`. The painter verifies the same bytes and uses
linear, unhinted metrics without reflow. The direct app and default
`WorkerWebSession` negotiate this automatically from the pinned renderer assets.
Low-level direct hosts call `configure_text_font(Uint8Array, sha256)` once before
load and pass the returned identity as presenter `fontIdentity`. Low-level
Worker loads supply `textFont:{version:"1.0",profile:"sfnt-unhinted-v1",url,
sha256,size}`; the Worker verifies and installs it before loading application JS.
Font ingress is bounded to 32 MiB. Missing glyphs, mismatched face/profile and
in-place font replacement fail; a fresh owner is required to select another font.

This profile uses face zero and default variation axes with scalar glyph
advances. Complex shaping, bidi, CSS font family/weight and the separate remote
native-preview font path remain pending. Unbound legacy frames retain their
existing metrics contract. Finite font-table/CanvasKit comparisons are separate
from installed-browser visual acceptance. Receipts remain `partial`.
`solid` borders use the typed four-side
`style.border` contract (top/right/bottom/left, each with width, RGBA color and
style); `none` and `hidden` have zero used width. Final `node.bounds` is the
border box, so `box_sizing` is not applied again by the presenter. The background
covers the outer rounded box; the border paints an outer-minus-inner ring,
partitioned by weighted edge distance so rounded inner corners remain filled
and transparent joins blend once. Text starts inside the used border and
padding. Descendant overflow clips use the padding edge and inner radii,
including independent axes and accumulated transforms. When Rust omits four
default typed sides, the complete computed width/style longhands determine
whether the border is inert; color longhands do not make a zero/none/hidden
border unsupported. Nonzero solid borders without the typed contract fail.

Explicit `scrollContainer: true` frames translate descendants by resolved
`scrollOffset` after a fixed padding-box clip, with background/border unchanged.
Nested transforms and clips use the same composition as Rust paint and hits;
raw offset metadata without the flag does not translate. Invalid offsets reject
before picture recording. Axis selection, bounds, gesture input and events stay
in the runtime; the presenter does not infer them from WXML attributes.

Typed image resources replay the runtime's decoded RGBA pixels, crop/fit geometry
and nearest sampling. Background images, non-solid border styles and shadow
painting remain unsupported. Native renderer and DevTools visual
agreement require independent conformance evidence.

Run the contract tests with `node --test scripts/canvaskit-presenter.test.mjs`.
The real CanvasKit CPU API preflight requires explicit
`WEAPP_CONTAINER_TEST_CANVASKIT_DIR` (the unpacked package directory) and
`WEAPP_CONTAINER_TEST_CANVASKIT_FONT` (the pinned Noto Sans SC file). It verifies
the actual dependency hashes and tests picture/glyph/border/rounded-clip readback;
missing paths produce a blocked skip. This CPU preflight and test-double
ownership tests do not establish browser, WebGL or GPU acceptance.

Run the actual static embedding smoke on a completed build with
`node scripts/web-wasm-browser-smoke.mjs --site-dir /absolute/path/to/new-web-output
--out-dir /absolute/path/to/new-smoke-output`. It uses one owned headless browser
and ephemeral localhost server, and saves screenshots, runtime traces, driver
receipts and cleanup results. A headless WebGL driver may use software; its
reported GPU surface does not establish physical hardware evidence.

`scripts/border-box-browser-smoke.mjs` replays the exact accepted Rust frame
exports from `container-runtime/tests/border_box.rs`; set
`WEAPP_CONTAINER_BORDER_EVIDENCE_DIR` while running that test with both real
engine features. The browser gate requires all 14 cases for both QuickJS and V8
(28 fixtures), including default-side serialization, dynamic updates, rejected-commit retention, padding
clips, transforms and the limited saved DevTools shared-style values:

```sh
node scripts/border-box-browser-smoke.mjs \
  --frames-dir /absolute/path/to/accepted-border-frames \
  --canvaskit-dir /absolute/path/to/canvaskit/bin/full \
  --font /absolute/path/to/NotoSansSC.ttf \
  --out-dir /absolute/path/to/new-border-browser-report
```

The runner imports without launching a browser. Explicit invocation owns one
headless browser and ephemeral loopback server, preserves input hashes and
receipts, handles cancellation, and closes its resources before reporting.
Missing, duplicated or unexpected cases fail before browser allocation; this
local WebGL evidence does not establish official visual or physical-device
parity.
