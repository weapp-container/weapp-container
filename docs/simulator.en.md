<a id="weapp-container-模拟器"></a>
<a id="开头的行会被忽略每行都会进入-normalized-tracetrace-同时记录输入"></a>
# Weapp Container Simulator

[简体中文](simulator.md) · **English**


The repository provides `container-simulator` as a development and validation tool, supporting Web, desktop window, and headless execution. It
consumes `manifest.json` and `blobs/sha256/<sha256>` from the `container-pack` directory, and interacts with the AppService, View, Renderer, and bridge via the same `HostSession` driver as the native host. The production runtime depends only on the declared build components, while the development and validation tools run independently.

<a id="快速运行"></a>
## Quick Start

Need a modern JS/TS view? See [Modern View](modern-view.en.md), run
`pnpm simulator:dev -- --project examples/apps/modern-view-app --surface web`.
It explicitly selects standard JS semantics, uses a separate realm, supports modern sources built independently and failure retention of old generation;
original WXS and official DevTools continue to use their own compatibility gates.

```sh
pnpm container:pack -- ./path/to/weapp-dist --out artifacts/reference
cargo run -p container-simulator -- run --pack artifacts/reference \
  --trace artifacts/simulator/trace.json \
  --snapshot artifacts/simulator/snapshot.json \
  --report artifacts/simulator/report.json
```

The fixed order for `run` is:

1. Validate manifest, integrity, and SHA-256 of all declared blob(s);
2. Load entry, dependency modules, and blob(s) for component pre-mounting via a batched `app.init`;
3. Send `app.lifecycle(launch)`;
4. Push the page specified in the configuration (default first route);
5. Send manifest-backed `render.commit`, evaluate WXML through the selected engine's independent View realm, parse WXSS, and generate an RGBA snapshot.

`--viewport WIDTHxHEIGHT` can change the logical viewport, defaulting to 375×667. `--route` can select
the initial page, `--data-json` can provide the first frame WXML data object. Rendering uses all manifest styles; page data can also be submitted by the host in subsequent
`data.patch.batch`. The output snapshot is JSON metadata and compact RGBA8 pixels,
suitable for golden comparison or upload to CanvasKit/native surface.

<a id="dom-文本编辑示例"></a>
## DOM Text Editing Example

[`text-controls-app`](../examples/apps/text-controls-app/README.en.md) Uses real input/textarea,
demonstrates editing, selection areas, focus/blur/confirm, disabled, password masking and AppService replacing value:

```sh
pnpm simulator:dev -- --project examples/apps/text-controls-app \
  --surface web --renderer webview --web-runtime remote
```

Control identity matching, focus restoration, and event budgeting are described in the [Text Control Contract](dual-renderer/dom-text-controls.en.md).
Regular updates will still reconstruct the iframe; native IME sessions across updates are not yet complete; do not consider snapshot restoration as evidence of this capability.

<a id="组件关系开发示例"></a>
## Component Relationship Development Example

Besides reference-app, an interactive fixture with custom component relationships can also be run:

```sh
cargo run -p container-simulator -- dev \
  --project conformance/fixtures/component-relations --surface web --port 0
```

Clicking the red sub-component will invoke a method on the live instance returned by `getRelationNodes` and turn it blue; Remove and Restore respectively remove and rebuild the sub-component. The parent component receives the sub-component via slot and native view. Relationships are published at both ends prior to linking, old relationships can be read during detached period, and relationships are cleared during unlinked period.
`Component.relations`, `getRelationNodes`, and `hasBehavior` are currently partial; `linkChanged` explicitly returns `ERR_UNSUPPORTED_CAPABILITY` due to lack of reliable move metadata.
This example can be used for development-time validation, without adding real DevTools, GPU, or device state.

<a id="开发态监督器"></a>
## Developer Mode Monitor

After the first clone, initialize the submodule and prepare its fixed-version builder dependencies:

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --dir vendor/weapp-vite install --frozen-lockfile
pnpm --dir vendor/weapp-vite run build:pkgs
pnpm submodule:verify
```

Node and pnpm versions follow the declarations in `vendor/weapp-vite/package.json`. Existing dependencies and build artifacts
can be directly used with the development commands below. The `--project` option can point to an independent mini-program project outside the repository; the tool repository
is located starting from the startup directory, then the ancestor of the executable file, and finally the project ancestor. When embedding a supervisor,
`DevConfig.workspace_root` can explicitly fix the tool repository, with relative paths taken from the startup directory.

When writing and viewing simultaneously, use the `dev` subcommand. The independent Node adapter layer uses the public `createCompilerContext` API of weapp-vite to start the watcher, synchronously freezes the output and atomically publishes a versioned receipt upon completion event. The supervisor only performs `container-pack` on these isolated snapshots, and atomically publishes the generation and switches to the same runtime session after validation; a 150ms debounce only merges successfully received receipts, and does not consider a quiet directory as proof that the current build is complete:

```sh
pnpm simulator:dev -- \
  --project examples/apps/reference-app \
  --surface web
```

Source code listening backend is selected by `WEAPP_CONTAINER_SIMULATOR_WATCH_BACKEND=auto|native|polling`,
default `auto`: macOS uses polling, all other systems use native file events. On macOS, the native FSEvents listening chain previously failed to detect changes within 120 seconds after atomic replacement; thus, macOS defaults to prioritizing timely detection of updates. Polling uses fixed 150 ms for text and 300 ms for binary intervals, increasing file check overhead. For large projects, explicitly select `native` and verify the save behavior of the underlying file system. On other systems, `polling` can also be explicitly selected for network drives or virtual file systems. Invalid values fail at builder startup and do not silently fall back to another backend.

This setting only configures the source watcher for existing public compiler contexts, without adding a second watcher, periodic rebuilds, or faking completion events. The adapter provides both `server.watch` and `build.watch.chokidar` configurations, and normalizes `CHOKIDAR_USEPOLLING`, `CHOKIDAR_INTERVAL`, and `CHOKIDAR_BINARY_INTERVAL` within its Node child process; container settings take precedence over inherited named Chokidar settings. This also overrides Vite's embedded Chokidar's priority handling of environment variables, as well as the classic host server's failure to retain certain inline watch fields. The environment of parent processes, other services, and custom builders remains unchanged. END, immutable snapshot, source credit, and artifact validation remain independent release conditions; polling events themselves do not grant release permissions.

Can independently run a real fixed compiler atomic save check without starting runtime or device:

```sh
node scripts/simulator-watch-backend-smoke.mjs \
  --out artifacts/watch-backend-smoke/local-01 --backend auto
```

This entry only creates a new directory for itself, performs ten consecutive atomic replacements of JS, WXML, and WXSS, verifies successful receipt, immutable old snapshot, and actual watcher options; if failure occurs, it stops immediately without retry. Logs and reports are retained in the specified directory, and compilers it owns are closed upon exit. This result only proves the build listening chain, and does not replace device hot updating, 50 ms View, GPU, or performance throttling.

The daily entry defaults to using the release build, while the application source code is still updated hot by watcher; use `pnpm simulator:dev:debug -- ...` when debugging Rust. The equivalent Cargo entry is:

```sh
cargo run --release -p container-simulator -- \
  dev --project examples/apps/reference-app \
  --surface web --host 127.0.0.1 --port 5179
```

When desktop and Web share the same session, upon enabling the desktop feature:

```sh
cargo run -p container-simulator --features desktop-window -- \
  dev --project examples/apps/reference-app --surface both
```

Changing `--surface both` to `--surface desktop` will open only the desktop window.

Available parameters are as follows:

- `--project <dir>`: `weapp-vite` project directory, required.
- `--surface web|desktop|both`: default `web`. `desktop` and `both` require `--features desktop-window` (can also use `pnpm simulator:dev:desktop`).
- `--engine quickjs|v8`: default QuickJS; V8 must be enabled at compile time with `v8-native` and will explicitly return `ERR_ENGINE` if unavailable.
- `--route <path>`, `--data-json <json>`, `--viewport <WxH>`: initial page options.
- `--render-scale auto|1|1.5|2|3|4`: independent physical rendering density; auto adapts to the DPR of active preview screens, up to 2×. It does not alter layout or simulate the device's `pixelRatio`.
- `--fps 15|30|60|120`: target frame rate for automatic rendering and browser presentation, default 60; actual FPS is still limited by browser refresh rate and real rendering overhead, and this does not affect JS timer or explicit bridge operation semantics.
- `--host <ip>`, `--port <u16>`: Web surface listening address and port, default `127.0.0.1:5179`. The monitor will not default expose to the local network.
- `--out-dir <dir>`: output directory for pack generation and release staging, default is `.weapp-container/dev` under the project.
- `--wv-bin <path>`, `--node-bin <path>`: override automatically discovered builder and Node executable files.
- `--open`: request the system default browser to open the URL after Web surface startup, only for `web` or `both`. The launcher is recycled in the background; failure retains a URL in the terminal for manual opening, without blocking simulator operation. This option does not affect headless or DevTools access.

Each startup atomically retains an independent run namespace within the output directory and generates an independent session ID.
Historical generations are not overwritten when reusing the same `--out-dir`; different instances do not share staging or pack publication paths. The compiler's `.build-output`, immutable raw snapshots, and modern source snapshots are placed in a project-external, round-specific OS temporary directory, preserving the project's original `dist`; source snapshots use read-only buffer copies to avoid macOS file cloning from triggering change events in the source directory. The `dev-session.json` file within the run records these directories and the PIDs that own them, enabling tools to locate the original artifacts. The revision increments within the current run and is reclaimed upon exit; temporary paths recorded in receipts become invalid, while previously published packs remain intact.

Web surface provides the following local interfaces:

| Address | Purpose |
| --- | --- |
| `GET /` | canvas, route, lifecycle, engine, trace and error overlay |
| `GET /api/state` | current revision, route, session and simulator report |
| `GET /api/frame` | Versioned binary RGBA frame, browser defaults to use |
| `GET /api/snapshot` | A raw premultiplied RGBA snapshot JSON, retained for compatibility |
| `GET /api/presentation` | Logical viewport, density, target FPS, revision and generation submitted |
| `POST /api/presentation` | Enqueue settings update, HTTP receipt and runtime final confirmation separated |
| `POST /api/bridge` | Submit an envelope or `{"messages": [...]}` batch |
| `GET /api/events` | SSE; pushes `state`, `ready`, `snapshot`, `reload`, `diagnostic`, `error`, `presentation`, and `shutdown` |

Page Settings Panel supports logical width and height, landscape and portrait switching, auto or fixed density, window adaptation or 25%–200% display scaling, and target FPS. The default logical viewport is 375×667; the default density is auto; the default display scaling is window adaptation.
Logical dimensions affect layout, rpx, and hit coordinates; density only triggers re-rasterization of submitted trees, without restarting session, executing stateful WXS/modern View expressions, or changing the simulated device's `pixelRatio`. Display scaling only affects browser CSS.
Logical dimensions update layout and lifecycle via existing runtime resize boundaries. During switching, input is paused for the old frame, and resumes after new session/config generation frames arrive. Input is always mapped to logical coordinates, and canvas backing pixels are not used as touch, scroll, or gesture threshold coordinates.

Committed development settings are saved in the project-ignored `.weapp-container/presentation.json`; display zoom is saved only in the current browser. Startup precedence is explicit CLI arguments, saved project values, then balanced defaults. Only `dev` reads project preferences; `run`, `dispatch`, and headless fixtures are unaffected. Per-frame physical size is `ceil(logical × scale)`, bounded to 4096 pixels per side and 16 MiB of tightly packed RGBA. Invalid targets, backends without density support, and allocation/cache budget failures are explicitly rejected while retaining the accepted configuration and frame. Web remote scale updates prepare the real frame and complete Web response before accepting the configuration together; failure does not rerun View or resize to restore old state. See [development scale transactions](dual-renderer/skia-backend-boundary.en.md#开发态倍率事务). Logical resize invokes application lifecycle callbacks. Its current failure path still attempts to restore host geometry and the old frame; candidate invalidation after callback navigation and Provider/engine environment compensation remain incomplete, and application JS side effects cannot be transactionally rolled back.

Native runtime directed by `9354c828`'s rate scaling transaction passes 3 runtime and 12 simulator mandatory test cases; existing watcher regression is separately mandatory, with full simulator library passing 486 cases and 5 ignored. Real remote CanvasKit use cases pass 6 UI groups, 202 queued and matched final SSE: rate scaling 2/1.5/1, FPS 120/30/60, modern View count remains 1; click count changes to 2, exceeds budget and discards old frame, still can click to 3, no full-page RGBA requests. Own pages, browser, SSE, simulator/listener/staging, and temporary projects are all cleaned. SwiftShader results do not replace WXS official semantics, logic resize, continuous scrolling, input p95, or hardware acceptance; see [this evidence](archived-evidence.en.md).

`GET /api/presentation` returns the following v1 model (counts are for illustration only):

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "generation": 2,
  "logicalWidth": 375,
  "logicalHeight": 667,
  "renderScale": "auto",
  "effectiveScale": 2,
  "fps": 60
}
```

`POST /api/presentation` must carry the current `revision`, other optional fields are `requestId`,
`logicalWidth`, `logicalHeight`, `renderScale`, `fps` and `devicePixelRatio`.
Expired revision returns HTTP 409; valid request returns HTTP 202 `{queued:true,requestId,revision}`,
indicating only queuing, not that runtime has been modified. The runtime thread validates and applies requests in order, then sends
`presentation` SSE `{requestId,ok,presentation,error?}`. Revision is incremented only upon successful modification;
physical or logical size changes only increment generation. HTTP 503 is returned for more than 16 pending setting requests.
Multiple previews share the submitted configuration; auto density is reported by active previews with DPR, defaulting to a maximum of 2×.

`GET /api/frame` Use `application/vnd.weapp.frame.v1`, body order as follows:

1. 4-byte little-endian `u32`, representing the UTF-8 JSON metadata byte count;
2. Metadata JSON: `schemaVersion:1`, `sessionId`, `frameId`, `configGeneration`, `sourceFrameId`, `renderRevision`, `logicalWidth`, `logicalHeight`, `width`, `height`, `stride`, `format:"rgba8"`, `byteLength`, `renderMs`, and `url:"/api/frame"`;
3. Compact, row-by-row straight-alpha RGBA8, `stride = width × 4`.

Original Skia pixels are still premultiplied RGBA; in binary releases, conversion occurs only once, RGB components are zeroed when transparent alpha = 0, other components are restored according to alpha, rounded, and saturated, and the browser can directly pass them to ImageData.
The old `/api/snapshot` retains the original premultiplied values and encodes them only upon request; the regular browser path no longer builds massive JSON arrays of numbers. An immutable response buffer is shared by the client, and identical session, renderer revision, and generation do not retransmit.
`frameId` is an incrementing transmission sequence number within a session, `sourceFrameId` preserves the original rendering frame number; scrolling and density redrawing, even if using original numbering, increments `renderRevision` and publishes a new transmission frame. Web full-frame caching and pending response sharing is capped at 64 MiB, including old frames held by slow clients and source/presenter pixels before and after switching; excess requests are rejected for new targets, without silently reducing density.

`snapshot` SSE only sends the aforementioned small metadata and URL, without preserving historical pixels. The client retains only one in-flight frame request and one pending latest frame to be presented; RAF presents frames at the target FPS; rejects late session or generation. Notifications are merged by session, generation, and frameId; if an in-flight response already includes a new frame requested by a notification, no further pixel retrieval is performed for the same frame. Explicit reconnection and old notifications without frame cursor can still refresh the current view.
The canvas is reused when dimensions remain unchanged, without resetting the backing size frame by frame. The panel separately displays logical size, real pixel count, current density, target and actual FPS, and reports raster/readback, transmission, decoding, and presentation times along with frame byte count. Actual FPS reflects the number of new frames actually received and presented; static pages do not repeatedly render to achieve the target FPS.
All internal per-frame metrics are fully preserved, and panel text updates every 250 ms; preview layout measurements are not repeated when geometry remains unchanged.

`ViewState.revision` continues to track events and state activity, while `template_revision` only tracks template input invalidation.
Auto-redraw is based on the latter: pure scrolling reuses previously evaluated trees, without re-executing WXS/modern View expressions;
page or component data, properties, and navigation changes still trigger template updates, including `setData` in scroll handling functions.

Actual Web performance regression can be run with `pnpm simulator:presentation:smoke -- --out artifacts/presentation/report.json`.
The script uses the release simulator, real Chromium input, and HTTP frame fetching, preserving environment, binary hashes,
50 samples from input to pixel presentation, and complete scroll input, presentation, and independent RAF records. Input is driven by
browser RAF-bound real CDP wheel events, converted to 3 CSS px per event based on actual DPR; no independent Node ticks or composited DOM events are used, no catch-up or retransmission is performed, up to four in-flight events are allowed, and real trusted events are gated separately.
Scroll fixation begins with 60 warm-up inputs, defining a measurement window from actual input index 60 to 240 (excluding endpoint); a total of 241 inputs are requested.
The independent RAF timestamp observed before the first input is fixed to a phase and displayed with 60 Hz numbering; presentation frames are bound to the same RAF timestamp opportunity, missing RAFs retain empty numbers. `measurementVersion: 2` only counts opportunities fully contained within the actual window: the start of the opportunity must not precede the start of the window, and the next deadline must not exceed the end of the window. Therefore, the start index is taken as `ceil((start - phase) / period)`, and the exclusive end index as `floor((end - phase) / period)`; floating-point rounding is only handled at integer boundaries, and phase alignment is not fitted to results.
Incomplete opportunities at the beginning or end are not counted in either numerator or denominator, regardless of completion speed, completion status, or failure. 180 is the number of input intervals; the number of complete display opportunities is determined by the actual window; the denominator is not reduced based on successful frames or observed RAF counts.
Completion time must still fall within the actual window and precede the original opportunity's deadline; frames outside the window cannot patch internal missing frames.
The first frame with no change and zero pixel revision is not counted as progress—actual pixel changes must be observed.
Clear failure occurs when no complete opportunity exists. Version 1 used `ceil` at the endpoint and truncated completion time, leaving residual incomplete opportunities with less than one cycle budget; the original report and failure conclusion are retained, and new version metrics must be run separately and reports saved.
Overall input and measurement window input frequencies are required to be 57–63 Hz, and display environment is independently verified; slow warm-up and subsequent catch-up do not cancel each other.
Frame injection outside the window, duplicate frames, duplicate opportunities, or fixed pixel bars with no change are not valid for compensating missing frames.
Pixel checks compare only a single fixed narrow column, and the sampling method and overhead are preserved.
The p95 latency from input to presentation ≤ 50 ms, and scroll frame loss rate ≤ 1% thresholds remain unchanged.
Failure reports are preserved, and auxiliary single tests or target FPS are not considered actual performance pass.

The complete regression testing and limitations for the current release are seen in
[Web Clarity and Smoothness Final Evidence](archived-evidence.en.md).
The input latency boundary is defined as from the DOM pointerup callback to the Canvas `putImageData` return, excluding
OS input queuing or screen compositor display; a zero actual FPS on static pages does not imply that input processing has stopped.

The current UI explicitly names the aforementioned software endpoints as `drawCompletedAt`, transaction completion as `transactionCompletedAt`, and no longer uses the global `lastInputAt` to associate with the next frame. Historical reports retain the original bytes.
Worker CanvasKit's independent causal diagnosis and missing compositor gatekeeping are detailed in [Input Causal Diagnostics](dual-renderer/input-causal-diagnostics.en.md); none of these auxiliary phases can claim input to screen p95 or GPU scroll drop frame rate throughput.

The actual browser settings are separately run:

```sh
node scripts/simulator-presentation-controls-smoke.mjs \
  --simulator-bin target/release/weapp-simulator \
  --out artifacts/presentation/controls-attempt1
```

The output directory must not yet exist. This script validates preferences recovery, CLI priority, headless default values, real click/touch/scroll behavior under display scaling, high-density hot updates, and automatic scaling for active preview using a separate temporary project; after completion, it closes the associated browser, services, and temporary resources, retaining JSON and screenshots. Functional results and the above performance gates are reported separately.

SSE replay up to 256 entries, totaling 2 MiB; slow clients share encoding and retain only one batch to send,
supporting up to 16 SSE connections. Send `ERR_DEV_EVENT_TOO_LARGE` when exceeding the per-event byte budget.
HTTP requests and responses always use non-blocking sockets, with each client writing up to 256 KiB per round;
network write readiness immediately advances to the next round, without additional 16 ms wait for each write budget.
Total HTTP and SSE connections capped at 64; unfinished requests and responses are closed after 5 seconds.
Slow clients do not block other requests, runtime pump, hot updates, or exit.

`GET /embed` is a directly openable Web embedding example located at
[`examples/hosts/web`](../examples/hosts/web). It shares the same origin as the simulator for
`/api/state`, `/api/snapshot`, `/api/bridge`, and `/api/events`, receives a complete RGBA snapshot via a canvas, and sends diagnostic requests in a batch envelope. A production Web host should replace this sequence with a WASM call to `container-host-web::WebWasmHost`; this page only demonstrates development-state HTTP/Canvas adaptation and does not represent CanvasKit GPU, real DevTools, or device capabilities.

`POST /api/bridge` will first return a queued response, with the actual processing result conveyed via SSE `bridge`/`state` events to maintain batch processing and avoid per-node browser roundtrips. The page defaults to connecting only to local addresses.
The canvas supports pointer input: a browser `pointerup` will send a batched `event.batch` with logical coordinates.
On desktop, a pointer move/down event is sent, a left-click release triggers a mini-program `tap`, and release of other mouse keys triggers a `pointerup`.
Desktop wheel events send `wheel` (including delta, phase, and modifiers), while keyboard events send `keydown`/`keyup` (including physical code, logical key, repeat, text, and modifiers). Keyboards lack pointer coordinates and will use the root from the most recent rendered frame as the focused target/path. The runtime performs a pointer hit-test on the current rendering tree, completes the `target`, `path`, and `dataset`, then invokes the page or component handler based on declared ownership.
The `sessionId` in `/api/state` is used by the host to construct an input envelope for the same session.
On desktop, a fixed logical viewport is used; window resize clips or blackens at a 1:1 physical pixel ratio without scaling the view; the `--viewport` flag can be used to select the startup size. Changes in window size do not alter the runtime viewport or trigger component resize.

watch build errors or invalid pack do not break the previous valid generation; diagnostics enter the same
`DevDiagnostic` stream and display as an overlay. Only validated packs can trigger reload.
WXSS, static resources, and secure WXML rendering changes use in-place replacement and preserve page data, storage, timers, and
session; JS, JSON, app configuration, routing, component relationships, or dependency graph changes will re-create the session and rotate
`sessionId` to invalidate old inputs. For packs containing WXS, changes to WXML documents, WXS source code, dependency graphs, and alias bindings of declaration files all count as restart inputs, even if the page has no custom components. `.wxs` resources and inline `<wxs>` in old packs are also checked against execution input.
Changes to `viewCompilation` compiler/version/ABI or module executable also require restart; document execution program changes when WXS state exists also trigger restart. Documents without WXS state can still be validated in-place within independent candidate sessions. Source and execution hashes participate in their respective validation and reload identity checks and cannot reuse old execution programs.
Packs containing component-scope script modules or `usingComponents` declarations will also compare changes to WXML source IR: plain text values and native built-in node attributes (`style/class/id/hidden/data-/mark-`) can be updated in-place; changes to element or sub-node structure, directives, template/import/include, component attributes, or addition/removal/decoding failure of templates trigger a full independent candidate session startup, which is only published upon success. Custom components, even if using these rendering attribute names, will be conservatively restarted as inputs. The current engine cannot rollback component stacks; this boundary prevents candidate mounting or attribute updates from failing and corrupting the previous instance; a full restart resets the page and JS state. After successful reload, the old error overlay is cleared, while trace and diagnostic history are retained. `/api/state.diagnostics` indicates the current overlay; independent `diagnosticHistory` uses schemaVersion 1, containing records, totalRecords, droppedRecords, and complete. History retains at most the last 256 entries and 512 KiB encoded diagnostics; large and evicted records are counted in droppedRecords; interface logs will indicate truncation. Asynchronous errors from startup callbacks and timers also enter the same diagnostic stream. Desktop windows retain error titles after runtime errors and only clear them upon successful build recovery.

The candidate frame for in-place updates is constructed using an immutable snapshot of the current page data and components, without loading application scripts, without executing microtasks, observers, or lifecycle methods. When a component selects a `template is` based on its own data, updates to text and styles retain that data context; if the preview detects changes in component input or instance topology, it will reject the candidate. The candidate simultaneously validates the complete manifest/blob closure, cascading styles, and the first frame; the original session accepts the same candidate and atomically publishes the manifest, resources, frame, and internal generation, without re-evaluating. Failure of a candidate does not modify the original session's frame, input permissions, selector index, or bridge trace. For `setData` calls on components that have not yet been rendered, private data and version receipts saved at the completion of normal write operations are used; the candidate only reads this record and refreshes its own component graph copy, and only publishes together upon acceptance of the first frame; the preview does not access live instance getters or `toJSON`. Components unable to generate a complete receipt must first complete normal rendering to avoid replacing the frame with stale component states.
The index for component selectors and custom events is also generated by the candidate tree and published along with private metadata transactions at the first frame; updates to `id`, `class`, dataset, and mark display do not retain old indices, nor are component preparation or lifecycle events replayed.
Skia candidates are evaluated within an isolated realm, then use the current renderer's host font provider for layout; injected portable/native fonts, Canvas/GPU owner, and density settings are not overridden by the candidate's default configuration.
Layout and decoding still first generate candidate resources, and are only published upon acceptance of the first frame; missing glyphs or rendering failures retain the previously accepted layout and target.

Browser path retains the same isolated candidate until the existing v1/v2 presentation ACK. During preparation, resource decoding, CSS, layout, and adapter processing, the runtime and simulator's accepted manifest, resources, component graph, and generation are not prematurely published; the supervisor first returns `staged` updates and only sends `PackReady` after receiving a definite ACK. The candidate is evaluated only once. In failure, the candidate is terminated; the old page, surface, native receiver incarnation, and input lifetime remain matched, and the receipt includes a recovery proof with the old key and lifetime; only after the host cleans up the candidate is the original DOM input restored. Navigation, hiding, logical resize, owner disconnection, or failure of revoked permissions do not get revived due to termination. Before permitting, the old session is first terminated; the real write of cancellation callback is retained, and if the candidate input changes, the candidate is rejected. The ready and callback errors after ACK still belong to the committed generation. These owner protocols and DOM transactions do not represent official baseline, real WebView, or WeChat DevTools full consistency acceptance.

After a frame submission, a ready hook or callback error belonging to an accepted generation: runtime returns
`render.commit`'s `committed: true` confirmation, followed by a structured error, simulator retains the new manifest
and new frame and displays overlay. Only failures before submission retain the old generation. `setData` in ready
will still be refreshed on the next pump, and will not be incorrectly marked as drawn. Embedded parties cannot replace
execution modules or configurations by directly calling `Session::replace_manifest`; a new session must be created.

packer generates independent, content-addressable `viewScripts` module graphs for WXS, and the template's `wxsModules` saves the alias → module id mapping for the file; these do not enter the AppService's `modules`. Inline WXS body is preserved as raw text and is not parsed for comparison operators, pseudo-tags, or mustache. Source blob and graph are validated.
In native QuickJS/V8 builds, the Session performs batch evaluation of WXML and declared WXS through an isolated View realm, without injecting the AppService's `wx`, lifecycle, storage, or timer into this realm. Old WXS packages without trusted module metadata still return `ERR_UNSUPPORTED_CAPABILITY`, and return `ERR_ENGINE` when the selected provider is not available.
The static graph extractor uses a lockfile-fixed version of Acorn to parse Script/ECMAScript 2020 syntax, distinguishing division, regex, comments, and strings, and parses escaped identifiers and real static `require`s within strings. Dynamic or alias-based `require`, loader rebindings, `eval`, `Function`, `with`, and import operations that cannot form input to this static graph will explicitly fail. The grammar accepted here is not the officially promised WXS dialect nor a reflection-safe sandbox; runtime still resolves each module load against the declared dependency whitelist. On first run, `pnpm install --frozen-lockfile` is executed in the root directory, and no reliance is placed on any parser that might accidentally exist in vendor code.
For example, `arguments[2]` in a factory can indirectly access the loader, but static analysis does not extract this edge; runtime rejects undeclared loads, and shared QuickJS/V8 test coverage confirms both the rejection path and the success path after explicit declaration.
WXML and WXS inputs require valid UTF-8; illegal bytes are not replaced and the build continues.
Packer also generates `viewCompilation`: `weapp-container-wxs` compiler `1.0.0`, helper ABI `1.0`, module records `id/sourceSha256/executableSha256/helper`, and document records `documentId/wxmlAst` along with per-expression `source/shorthand/executableSha256/helper`.
Original WXS bytes and WXML AST remain unchanged and are saved separately; metadata and executable hashes are included in the manifest integrity root. Mobile App embedding examples replicate and verify the full resource closure, submitting raw and compiled View bytes once in `app.init`, without relying on per-resource JNI/N-API calls.

The compiled WXS and WXML attribute reads return eight standard strings via hygienic lexical helper
`constructor`, preserving own/inherited override, getter, receiver, parameter order, and write timing.
Native prototype constructor is not replaced; Array's map/filter/slice/concat/splice continue to execute.
Direct View API without compiled metadata still uses ECMAScript attribute semantics.
Syntax that cannot be correctly lowered returns `ERR_UNSUPPORTED_WXS_SYNTAX`: lexical eval/Function, with, import, optional, async/generator, tagged template, class, destructuring, spread/rest, and for-of; this is not a complete official WXS dialect or reflection-safe sandbox.
Bare `wx:key` is the own property name of an object item; keywords and hyphens are not misinterpreted as JS; primitive bare key is null, and the item itself is used with `*this`. Dotted loop-scope expressions are still supported, but not considered official behavior.
When such candidates fail to load in development mode, the previous runnable generation continues to respond to the bridge; this is not evidence of WXS HMR or official shared-template-WXS case passing.

QuickJS/V8 now provides an independent batch `ViewEngine` execution boundary: separated runtime/isolate, lexical module binding, instance caching, parameter copying on successive calls, special value encoding, and domain recycling after timeout/cancellation.
Session retains evaluated inputs to avoid stateful WXS component discovery replay; restart is required upon timeout or untrusted receipt, with no silent fallback. Execution subsets, testing, and limitations see
[Isolated View Executor](isolated-view-engine.en.md).

`pnpm runtime:wxs-graph:smoke` bundles a raw fixture containing division, regex, and escape require operations,
validates the source code blob is not rewritten, the dependency graph has no pseudo edges generated by strings/regex, and reads the actual WXML-bound dataset in native QuickJS/V8; it does not replace official DevTools or weapp-vite build regressions.
`pnpm runtime:wxs-dialect:smoke` validates compilation identity, original/execution blob hashes, eight constructor types,
native Array methods, computed/own properties, inline/external WXS, WXML-global, and for-in writes,
and compares QuickJS/V8 actual dataset. The official constructor/datatype oracle remains `unknown`; local
checks do not serve as evidence for non-seven hosts, GPU/device, browser, or performance gate passes.

Web and desktop share the same clock pump: JS timers, `setData` in page events, and bridge
Data patch will submit a new frame upon data revision change, without waiting for build. No new snapshot or trace is generated during idle ticks; JS async exceptions enter the same diagnostic and overlay flow. The first frame uses real data from JS page startup and after `onLoad` execution. When a long-running host is injected, `Simulator::pump(now_ns)` should be called within the event loop, with parameter being nanosecond value of Unix time; `dev` automatically calls this.

Original bridge debugging or App embedding, when manifest-backed `render.commit` omits `data`, it reads the current Page's AppService data, including accepted `setData`; explicitly passing in `data` still serves as override.
Inline `style` shares the cascade with WXSS, and the same result is then used for computedStyle, layout, and rendering.
Regular inline styles cannot override stylesheet `!important` rules, and changes in size will also update click hit areas.

```bash
pnpm runtime:boundary:smoke -- --out artifacts/style-module-boundary.json
```

This independent fixture passes through the production packer and both engines. It checks initial rendering and the geometry, styles, RGBA pixels, and CommonJS/JSON module results of `setData` after a real click. It does not start existing development services or modify application projects. Temporary packs and child processes are cleaned up on exit. The report provides local runtime evidence and does not upgrade official DevTools, GPU, physical-device, or seven-host status.

Development mode Web defaults to native runtime + browser CanvasKit/WebGL2: transmits scene batches and individual image resources,
does not transmit full page RGBA for regular frames. Requires upfront preparation of fixed CanvasKit/font resources, see
[`container-simulator/README.md`](../crates/container-simulator/README.en.md#local-gpu-scene-presentation).
`--renderer-assets` or `WEAPP_CONTAINER_RENDERER_ASSETS` specifies the resource directory; failure is explicit if missing.
`--software` explicitly enables old CPU RGBA preview; headless `run/dispatch` defaults unchanged.

WebView Development Preview can be run directly:

```bash
pnpm simulator:dev -- --project examples/apps/reference-app \
  --surface web --renderer webview --web-runtime remote
```

This mode isolates the DOM document for CSS layout, while business and View logic are executed natively by QuickJS/V8; no CanvasKit resources are required. `auto` retains default and per-page configurations and prepares CanvasKit to enable page switching. A tab holds the primary preview lease, while others display read-only mirrors; "set as primary preview" first revokes the old touch and presentation authorization, and only opens input after the new layout is finally confirmed. `POST /api/preview` returns a queued receipt, and SSE returns the submission result. Invalid leases and late view request versions cannot continue operating the runtime.

DOM scaling is determined by the browser's DPR, the interface disables the Skia density selector; logical width and height, display scaling, and target update
FPS remain adjustable. Preference changes in scaling do not re-evaluate View; changes in logical dimensions trigger a resize and wait for new
browser geometry. `/api/view-resources/` transmits hash-validated encoded images with complete presentation identifiers, without transmitting full page
RGBA. Ordinary DOM rendering does not include a Skia snapshot; diagnostic screenshots must be collected from the actual browser.

Successful style/resource pack updates happen in-place; script updates trigger session restart. Build or IR preflight failure retains the current instance. CSS, component, or decode errors detectable only by the browser may still be accepted after the manifest, in which case the old view is retained and invalid input is frozen, without guaranteeing rollback of business side effects. DOM selector/observer/scroll command adaptation remains pending. The above adjustable panel belongs to remote mode. Browser mode uses the same managed runner with explicit selection `--surface web --engine quickjs --web-runtime browser`, and explicitly specifies `--renderer webview` or `--renderer skia`, providing `--browser-runtime-dir` and independent `--browser-runtime-pins`. Skia only accepts completed Worker producers whose pins set `renderer` to `canvaskit`; WebView accepts independent fixed software or CanvasKit producers. Entry validation occurs before credential creation, listener, and watcher setup, checking original byte hash, success/ready status, Worker execution mode, and stable, clean source code identity. It supports initial `--route`, object `--data-json`, and integer `--viewport` (default 375×667, no more than 4096 on each side), does not read remote saved display preferences, and does not rely on native QuickJS features. Skia supports `--render-scale auto|1|1.5|2|3|4`, defaulting to screen density read by the preview owning the instance, capped at 2×. A 2× scale of 375×667 logical viewport exports a 750×1334 physical target; scale factor does not alter the simulated device `pixelRatio`, and JS/WXS is not re-executed when layout is reused. These scale factors are startup settings; auto is sampled once when the preview starts; dynamic screen density across screens, browser real-time setting panel, and FPS adjustment have not been integrated, and thus cannot leverage the remote panel capabilities described above. WebView uses browser density and rejects explicit scaling. Current restrictions include rejection of renderer `auto`, explicit `--fps`, renderer assets and their environment overrides, custom `--wv-bin`, modern View configuration, V8, native surface, and software combination, so unsupported options are not accepted and then ignored; listener addresses support only IPv4 loopback. Each run individually retains `runs/<runId>/browser-dev-summary.json`, and sequential restarts can reuse output root. The original preview must remain open until Stop cleanup is complete; takeover after refresh or crash has not been implemented. Full command and producer preparation see [Browser Development Loop](dual-renderer/browser-dev-loop.en.md). Native `desktop|both` WebView and combinations with `--software` and WebView remain rejected. Remote protocol see [Presentation Transactions](dual-renderer/browser-presentation.en.md).

The Browser panel displays the runtime location, renderer, physical dimensions, WebGL2 surface/driver, and receipt separately.
Skia's `submitted` indicates that the local picture/flush has been submitted; `accepted` is shown only when it matches the current scheduler's accepted proof and the page, surface, and viewport; the diagnosis itself does not grant input privileges.
`physicalHardware: unknown` and `gpuCompletion: not-waited` are retained as explicit states and cannot be used to infer physical GPU, actual completion, performance, or any host involvement; measured records from the new Skia CLI path are managed separately.

Browser diagnostic panel is compatible with a single `payload.error` and the runtime's `payload.errors[]`, preserving each entry individually
owner ownership, error name, engine origin, and available plain-text stack; diagnosis does not trigger additional business calls or restarts.
Each notification can expand at most 32 entries, with overflow shown as ellipsis; message, error code/name, and stack are limited to
2048, 128, and 8192 UTF-8 bytes respectively, with a maximum of 32 historical entries. Only existing plain data fields are read; getters are not evaluated, and business data is not traversed. This fix addresses display and normalization only, without altering the engine's native exception extraction, nor does it verify actual browser exceptions or source code locations have been accepted.

Desktop development mode on macOS uses Metal; explicit error is reported when GPU is not yet available on Windows/Linux;
`--software` can choose `winit + softbuffer`. Both reuse the same supervisor and `HostSession` presenter
window; the window title includes revision, route, and error status. `--surface both` does not create a second
page state. Controlled exit (signal, window closure, watcher exit, or return of error) explicitly executes the same order:
stop and reap watch, end output reader, stop and reap pack, clean up preparation files, close Web listener,
and finally release the desktop presenter/window. A non-blocking `shutdown` SSE flush is attempted once before the listener closes;
slow clients are not guaranteed to receive the last event and cannot block exit. Incomplete builds
are not considered passed as evidence.

The default builder adapts the public API of a fixed vendor via `scripts/simulator-watch.mjs` in the repository, without modifying the vendor. If explicitly specified with `--wv-bin` and the adjacent weapp-vite installation can be located, the same adapter is used; other custom builders must implement the following receipt protocol. Without a receipt, only `BUILD_RECEIPT_REQUIRED` is reported, and outputs that are packable but not yet completed are not considered a successful generation.

Custom builder inherits the environment variables `WEAPP_CONTAINER_SIMULATOR_RECEIPT_DIR` and `WEAPP_CONTAINER_SIMULATOR_SESSION_ID`.
First write a complete snapshot to `snapshots/<unique>` in the receipt root directory, then publish it via atomic rename after freezing to `receipts/<sequence>.json`, containing:

```json
{
  "protocolVersion": "1.0",
  "sessionId": "环境变量中的会话值",
  "sequence": 1,
  "kind": "success",
  "snapshot": "snapshots/唯一快照目录"
}
```

`sequence` is a monotonically increasing positive integer. `kind` is `building`, `success`, or `error`; only `success` includes `snapshot`. Failures may include `message`. Published snapshots must remain immutable; building/error retain the previous runtime. This protocol and synchronous freeze step isolate build writes from pack reads.

`success` may be accompanied by `compilerCommit`, formatted as 40 or 64-bit lowercase hexadecimal Git commit.
The public API adapter resolves HEAD from the actual discovered weapp-vite installation directory and sends it only when the `package.json` of that directory is included in the commit; regular npm installations or installations unable to determine a Git baseline omit it.
This SHA records only the source code baseline and does not verify the worktree, dependencies, or cleanness of generated dist bytes.
The `DevConfig.compiler_commit` in the supervisor takes precedence over the receipt; when both are missing, it records `unknown`, and does not borrow a SHA from other vendors. The protocol remains `1.0`, and older custom builders without this field continue to be compatible.
The `compiler` in `/api/state` and the simulator report comes from the currently verified pack; smoke report uses `workspaceVendorCommit` / `workspaceVendorDirty` to separately record the vendor worktree beside it.

packer advances with an asynchronous subprocess owned by the supervisor, and the main loop checks completion via `try_wait`, continuing to process bridge, Web/SSE, desktop input, and runtime pump during the wait period. The absolute deadline for a single pack is 120 seconds; it terminates its owned processes upon timeout or being replaced by a subsequent build, and retains the previous running instance. On Unix, watch and pack use separate independent process groups; exit stops watch first, then pack, and cleans up temporary snapshots and staging. On Windows, suspended processes are incorporated into a separate Job Object before execution resumes; if assignment fails, an error is reported immediately with no rollback to unassigned mode. After the packaging layer exits, workers remain managed by the Job. Pack cancellation and cleanup proceed via non-blocking queries, and staging is released only after all workers have exited; an explicit shutdown provides an exit barrier.

The repository also provides an optional one-time Web smoke: it launches the same development command, waits for the first generation, temporarily modifies a WXSS file in the reference app to validate in-place updates, then modifies the app script to validate session restart, creates an invalid app.json to validate build failure, and triggers the bridge response and recovery from a previous instance:

```sh
pnpm simulator:dev:smoke -- \
  --engine quickjs --out artifacts/simulator/dev-smoke.json
```

smoke defaults to using `--port 0`, with the OS allocating a port; the `dev` command still defaults to port 5179.
The script only uses the URL announced by the current subprocess, and does not consider existing development services as evidence of a successful startup. Each round creates an independent `simulator-smoke-*` staging directory under the OS temporary directory (`weapp-simulator-smokes`) using `mkdtemp`, and only cleans up the directory and process for the current round; `--keep` can retain the directory for troubleshooting.
`--port <number>` allows explicit port specification, `--engine quickjs|v8` selects the engine to be compiled and actually run, defaulting to QuickJS; if build fails or runtime `ERR_ENGINE` occurs, the process reports failure and does not switch to another engine.

This script terminates the watcher and cleans up staging on exit. By default, it automatically selects the first `.wxss` file from the project source directory, or you can specify a source file using `--wxss pages/home/index.wxss`.
On exit, the script restores the modified WXSS, app script, and app.json files; if a file is concurrently modified by another process, it retains the later content and explicitly reports a restore conflict, without overwriting concurrent edits.
SIGINT / SIGTERM cancels pending HTTP, SSE, and browser operations, then restores the source code and closes the current resource session.
Only bridge responses with exact matches to sessionId, requestId, op, and both `ok/accepted` being true are considered valid.
The report only indicates that the Web/software surface hot-reload pipeline in the development emulator is operational, and does not indicate passage through the gateways of real DevTools, GPU, official emulator, or physical devices.

If you need to verify the real browser page (canvas, status bar, SSE hot updates, and error overlay), you can run
Playwright headless smoke. The script reuses the fixed `vendor/weapp-vite` Playwright dependencies, closes the browser, watcher, and restores the temporarily modified WXSS:

Before the first browser smoke run, use the vendor-declared Node/pnpm version to install this fixed Playwright dependency corresponding to Chromium; installing only pnpm dependencies will not prepare the browser executable files:

```sh
pnpm --dir vendor/weapp-vite exec playwright install chromium
```

Linux CI runner if still lacks browser system libraries, may instead use
`pnpm --dir vendor/weapp-vite exec playwright install --with-deps chromium`.
This smoke explicitly uses a headless browser and software RGBA surface, yet the result remains merely evidence of a development emulator.

```sh
pnpm simulator:dev:browser-smoke -- \
  --engine quickjs \
  --out artifacts/simulator/dev-browser-smoke.json \
  --screenshot artifacts/simulator/dev-browser-smoke.png
```

When testing a reference application with independent copies, add `--reference-fixture --project <copy>`.
The script will byte-by-byte verify the copy against the current submission of the reference source code before execution, rejecting any additional source code or symbolic links, and then run full text, click, component, and slot checks; no modifications to the actively developed reference project are required.

Browser smoke uses the same independent staging, announcement URL, and port assignment rules by default, also using
`--port 0` and `--engine quickjs`. Switching to `--engine v8` enables the V8 version of the same browser chain; reports record the actual engine selected, and results from one engine cannot be substituted for those from another.

The reference application will also use selector geometry to click a button, verifying the visible change of `bindtap → setData → RGBA`, and then checking that style updates retain the display; subsequently, the same tab will open `/embed` to verify diagnostic requests for the shared session.

This report still only represents the development simulator Web software surface; it will not be upgraded to DevTools, GPU, official simulator, or real device evidence.

<a id="自定义组件执行子集"></a>
## Custom Component Execution Subset

WXML evaluation ignores source code line breaks and indentation in ordinary layouts; original AST/blob remains unchanged, stable identity
Still uses original source code positions. Explicit single-line spaces, `<text>` subtrees, and line breaks generated by dynamic bindings are preserved.
Only components with explicit indentation will not block slot fallback. Automatic height unification is measured by renderer based on final content width. Block/Flex share typed layout solving, with explicit Flex defaulting to horizontal layout; percentages are retained until actual parent container dimensions are determined, and hidden or absolute/fixed nodes do not expand the parent container height.
Sizing, line breaks, alignment, and boundaries see [Layout Conventions](layout-flow.en.md). This remains a subset of the developer-facing layout.

In the manifest, `usingComponents` together with actual WXML occurrences determines the component instance; loading a component module itself does not mount a page instance. Session is responsible for the component graph, and submits creation, property updates, mounting, ready, and release operations in batches to the JS engine. Each instance has independent `data`, properties, and scope identity. When a component calls `setData`, it also causes the current page to resubmit the frame.

The simulator comes with verified `blobs` in `app.init`, enabling the detection and attachment of components before the page is pushed into the `page.onLoad` phase; the component's ready is then called after the first `render.commit`. A host that uses the bridge can also provide this optional field. Older hosts that only provide blobs in subsequent `render.commit` calls can still render, but this does not prove that the component was mounted before the page's onLoad.

Pure mustache attributes preserve JSON type through optional WXML IR `boundValues`, avoiding converting booleans, numbers, objects, or arrays to strings before being passed as component properties. Existing string `attrs` are retained for rendering and for backward compatibility with v1 consumers. Templates use the component instance's own data; content projected into slots retains declaration-side data, `usingComponents` resolution location, and event handler ownership, falling back to the receiving component's context. Internal component events use the corresponding component as `this`; page-declared slot handlers continue to use the page instance; selector component scope prevents nodes with the same name from being shared across instances.

The identity of a loop component includes the declared location, ancestor loops, and encoded key. Updates or reorders reuse existing instances; conditional deletions, page removals, or session ends release corresponding instances, after which a new instance is created upon reappearing. These semantics tie component state, rendering, and input to the same runtime lifecycle.

Managed components and declarative components without JS registration share the same occurrence/slot expander: projection nodes are parsed by the declaring party via `usingComponents`, and content that is not projected does not create instances; successful updates release evaluation caches for removed nodes.
Rendering directly before `page.push` also uses an independent session cache. The declarative path will still expand custom hosts into child nodes, without executing component JS lifecycle; this is merely a headless presentation contract.
Declarative local components return `ERR_MODULE_LOAD` when no template is provided; unsupported plugin/npm targets return `ERR_UNSUPPORTED_CAPABILITY`, and such components are no longer silently rendered as ordinary built-in nodes.

When component updates or cleanup occur without engine confirmation, the runtime retains the original error and any scope still belonging to the current page.
The managed page is marked as requiring a session restart; subsequent rendering and component lifecycle detection will not automatically replay.
Confirmation must include a complete batch of unique instances and snapshot; destruction also requires confirmation of all request scopes, including those no longer present in idempotent retries. Returning `null` or an incomplete success result is likewise considered a missing confirmation.
Scopes that have been confirmed released will not be restored due to subsequent relationship update failures. Template evaluation failures are retained with the previous frame and evaluation result, and can continue after data correction. AppService remains available for diagnosis and unloading; these rules do not rollback any JS side effects, nor freeze all AppService inputs.
The runtime independently records the original parent binding input from a successful prepare; when input changes, it first synchronizes the parent component in bulk, then discovers descendants. It does not overwrite this record with normalized properties or local `setData`, to avoid temporary reconstruction of destroyed child components during failed update recovery.

Order reference comes from the real WeChat Developer Tool `2.02.2608080` / Foundation Library `3.17.3`'s
[`component-instance-apis` observation](archived-evidence.en.md):
In this fixture, the attached of parent and child occurs before page onLoad, and ready occurs after onLoad.
This record serves as the oracle source for implementation order; the current automatic component subset has not passed through this complete official case.
Component `pageLifetimes.show/hide` integrates with page navigation and App foreground/background switching; session uniformly tracks visibility, and cached tabs, covered pages, and destroyed instances do not receive erroneous notifications. New components mounted in visible pages are only resent one show notification; if a callback throws an error, it enters a structured error flow and continues to notify other components in the same batch, and will not be called again in the next frame.
Dual engines use dedicated batch entry points, calling only pageLifetimes, without mistakenly selecting ordinary methods with the same name.
Both reLaunch entry points release active pages and components in cached tabs.
[`lifecycle-compare` observation](archived-evidence.en.md)
Confirms show/hide behavior after tab round-trip; local testing has not yet proven the exact official order across all callbacks.
There is currently no official runtime resize lifecycle message; window resize does not fabricate component resize notifications.

Page/Component's `selectComponent`, `selectAllComponents`, and nested components
`selectOwnerComponent` uses the declaration tree index of live instances; slot retains its declared owner, regular nodes also participate
First match wins; virtual `block` does not become a query node. Current support includes ID/class, descendants, descendants, and union;
export, cross-component `>>>`, tag/attribute patterns still explicitly return unsupported. The base truth of the top-level component owner
has not yet been established; these selection APIs remain partial, see details in
[`API 语义与证据边界`](api-runtime-conformance.en.md).

The `triggerEvent` of managed components uses partial `Component.triggerEvent` capability.
Events are batched and published to the selected engine before the input callback, during the session lifecycle; direct listeners and nested custom events are invoked within the same JavaScript turn, preserving local `detail` object identity without waiting for the first frame rendering or for ancestor traversal across a bridge. `capturePhase`, `bubbles`, and `composed` are disabled by default; explicit capture is independent of bubbling, and non-composed propagation stops at the boundary of the owning component, with catch blocking further propagation.
Listeners are executed according to the declared owner, and slots retain their declared-side ownership.
The saved `lifecycle-compare` truth value only overrides the priority of `bind`/`bind:` and hyphen/underscore naming, without overriding these options, detail identity, synchronous order, or event dispatching within the lifecycle.
Upstream `issue-1126-1128` includes corresponding propagation assertions, but the official case remains unknown.
`relations`, full WXS dialect, property type rules, and official component compatibility are still incomplete. Local dual-engine, rendering, and lifecycle testing do not upgrade to real DevTools or near-parity gatekeeping.

<a id="jsonl-调试脚本"></a>
## JSONL Debug Script

```sh
cargo run -p container-simulator -- dispatch \
  --pack artifacts/reference --script scripts/simulator.jsonl
```

Each non-empty line is a bridge envelope, or a complete batch containing a `messages` array;
Lines starting with `#` are ignored. Each line enters the normalized trace, and the trace simultaneously records the input envelope and the complete response batch, enabling differential comparison with DevTools, mpcore, QuickJS/V8. All API calls, errors, cancellations, and timeouts are still determined by the existing protocol/error boundary.

`run`、`dispatch` and `Simulator::from_pack_dir` default to `TraceRetention::Full`,
retaining the complete normalized trace. The development supervisor defaults to `TraceRetention::development()`:
at most 1,024 records and 8 MiB of encoded payload are retained, older records are evicted first; any single record exceeding the overall budget is not retained. Storage uses compact JSON bytes, avoiding the permanent retention of all blob bytes as expanded `serde_json::Value` on every `render.commit`. Record count also limits the metadata overhead of the queue.

`report`, `/api/state`, and `write_trace` exported `traceSummary` includes retention,
`totalRecords`, `retainedRecords`, `retainedBytes`, `droppedRecords`, `droppedBytes`,
first and last sequence numbers and `complete`. After a drop has occurred, `TRACE_HISTORY_TRUNCATED` is clearly displayed,
the web status bar also shows `history truncated`; even if later changed to Full, completeness will not be restored to true.
Truncation only affects retained history, the bridge batch, page state, and current frame returned to the caller remain intact.
Sequence and simulator request ID increment by total count and are not reused after eviction or full reload.

Rust embedder can call `simulator.set_trace_retention(...)` to adjust the policy; the `DevConfig.trace_retention` of a developer monitor can be explicitly set to Full to capture complete evidence. The full policy has no memory upper bound and should be used with independent, bounded conformance runs; truncated development histories cannot serve as complete differential evidence. These restrictions only define trace retention and do not prove that the runtime meets total RSS, GPU, or performance benchmarks.

<a id="app-植入边界"></a>
## App Implantation Boundary

The Dev supervisor provides an explicit `DevSupervisor::shutdown()`: stops its owned build resources in the order described above, after which `poll` and `pump_runtime` no longer perform work, and `run_until_exit` returns `DevError::Shutdown`.
This operation and subsequent Drop are idempotent, avoiding sending signals to a process group that has already been released and may be reusing a PID; the last effective Simulator remains readable. The host should call this barrier first, before closing its own Web/native surface.

The host application should reuse the same order:

```text
Simulator::from_pack_dir / HostSession::from_manifest_json
        │
        ├─ app.init + modules[]
        ├─ app.lifecycle(launch/show/hide/unload)
        ├─ page.push / page.pop / data.patch.batch / event.batch
        ├─ render.commit → 场景 / 原生 GPU surface → 呈现回执
        └─ render_snapshot(_json) → 显式截图或软件 surface
```

Each example uses the same JSON bridge, but actual resource entry points differ:

| Example | pack and runtime entry point |
| --- | --- |
| [`examples/apps/embed-runner`](../examples/apps/embed-runner/README.en.md) | Receives a pack directory argument, loads the manifest/blob within the application process, starts a session, and reads the complete RGBA snapshot. |
| [`examples/hosts/web`](../examples/hosts/web/README.en.md) | Development mode `/embed` reuses supervisor-validated packs and the same session; production Web host migrates to `WebWasmHost` manifest, batch module, and blob loading. |
| [`examples/hosts/android`](../examples/hosts/android/README.en.md) | Read resources from `app/src/main/assets/portable-pack`; sync using `node scripts/sync-android-portable-pack.mjs --source artifacts/reference`. |
| [`examples/hosts/harmony`](../examples/hosts/harmony/README.en.md) | Read resources from `entry/src/main/resources/rawfile`; synchronize using `node scripts/sync-harmony-pack.mjs --pack artifacts/reference`. |
| [`examples/hosts/ios`](../examples/hosts/ios/README.en.md) / [`ios-app`](../examples/hosts/ios-app/README.en.md) | Share Swift portable-pack loader to verify the manifest and all blobs in the bundle, execute real module and page startup; `ios-app` submits manifest-backed frame to UIKit/Metal surface. Build/link and device/GPU execution evidence are separately recorded, see [iOS pack integration](ios-portable-pack.en.md) for details. |

Android defaults to native build enabling `quickjs-native-android`, allowing loading of pack and executing real modules and pages;
When an uncompiled engine is requested, `ERR_ENGINE` is returned, and no automatic engine switching occurs.
[Interaction Archive](archived-evidence.en.md) retains evidence of real `weapp-vite`
pack running in the official Android emulator, including QuickJS, Skia GLES, actual touch, window changes, and foreground/background restoration.
Records of bindings explicitly listed in the submission; screenshots manually inspected to cover example content, pixel-level precision matching, and the official oracle for callback order remains `unknown`.
Official DevTools semantic accuracy, dual-engine host coverage, physical device/hardware GPU, and performance still require individual acceptance.

The business host should batch provide modules and pre-mounted blob requirements in `app.init`, then pass the scene batch to CanvasKit or an implemented native Skia GPU surface, and submit the corresponding revision's presentation receipt.
remote WebView uses `view.prepare → view.prepare.commit → view.presented`; the native WebView adapter is still pending integration. Full snapshot is only used for explicit screenshots or software surface.
No per-node JNI, N-API, or Swift round trips are allowed. The example entry and build pass do not guarantee full host compatibility.

<a id="证据边界"></a>
## Evidence Boundary

Development side and `/embed` share a batch input adapter supporting wheel and single-finger touch input; scroll state, view, hit and query are managed by the same Session. You can directly run `--project examples/apps/scroll-contract-app --viewport 240x200` to verify. State retention, errors, and current limitations are described in [Session scrolling](scrolling.en.md).

In the simulator report, `status=passed` only indicates that the fixed pack completed the requested and rendered operations in a headless session. It does not upgrade real DevTools, GPU, simulator, or physical device access restrictions; these results must still be individually recorded in the managed test and evidence ledger of the corresponding host. QuickJS is the default build feature, V8 is explicitly selected via `--engine v8` and the `v8-native` feature, and `ERR_ENGINE` must be retained in the absence of a provider.


This round of dual-rendering progress is accepted against the freeze list in [`dual-renderer/`](dual-renderer/README.en.md).
Currently, `auto|skia|webview + remote` has been integrated with the development monitor; `auto` selects either CanvasKit or isolated DOM based on the current page profile. Explicit `webview|skia + browser + web + quickjs` reuses the managed Browser runner; it requires independent producer/pins, with Skia requiring a CanvasKit producer, capability boundaries see above.
The native WebView adapter has not yet been integrated, and corresponding combinations are explicitly rejected. Remote CanvasKit presentation must first pass through the `/api/render-presented` queue, then await the `presented` SSE emitted by the runtime's owning thread; old session/generation/revision inputs will not affect the new frame. GPU submission success only indicates that the frame has been handed off to the platform presentation queue and does not claim that the display has scanned the frame; hardware and input-to-presentation performance remain separately measured.

Mixed page development returns to using real watch construction and the same session, verifying DOM click navigation to
CanvasKit, page state retention upon return, rejection of input from previous frames, and subsequent WXML hot updates:

When you need to directly develop your own hybrid pages, you can use
[`dual-renderer-app`](../examples/apps/dual-renderer-app/README.en.md). Three regular
`weapp-vite` pages demonstrate DOM → Skia → New DOM, page count retention, and shared storage and
App clock. Keep `--renderer auto --web-runtime remote` and provide fixed rendering resources;
the `container.config.json` file inside the project handles per-page selection without modifying runtime or upstream builders.

```sh
pnpm host:dual-renderer:dev-smoke --binary target/release/weapp-simulator \
  --renderer-assets artifacts/dual-renderer-dev-assets --engine quickjs \
  --out artifacts/mixed-development-quickjs
```

`--out` must be a new directory; V8 runs separately using `--engine v8` and another output directory. The script owns
an independent project copy, simulator, SSE, and a headless browser page, cleans up and saves results upon completion.
This feature return does not replace performance, physical GPU, WeChat official, or other host acceptance.
