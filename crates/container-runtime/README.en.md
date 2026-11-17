# container-runtime

[简体中文](README.md) · **English**


`container-runtime` owns one portable mini-program session. It validates a
supported `container-manifest` v1/v2/v3 input before startup, negotiates bridge
protocol `1.x`, and coordinates AppService, View and presentation state on its
owning thread:

- **AppService**: `container-core::ContainerRuntime` owns lifecycle, page stack,
  navigation, and batched data patches.
- **View**: `ViewState` records revisions, invalidations, and frame/event state.
- **Rendering**: `SkiaPageBackend` owns Skia preparation and candidate acceptance.
  It materializes the already evaluated `ViewDocument` without evaluating JS or
  owning presentation permissions. DOM keeps its browser CSS/geometry/ACK path.
  `SessionConfig::page_render_mode` defaults to `Raster`; the compiled renderer
  features determine software versus native Skia rasterization. External-frame
  and native-GPU modes have separate explicit presentation contracts.

The Skia page object initializes only at an explicit concrete or drawing
boundary. `renderer_if_initialized`, `page_render_mode`, `render_revision` and
`renderer_backend` observe the existing object or its validated configuration
without constructing one. Ordinary DOM loading, empty snapshot checks and
detach/reset do not initialize a page renderer. Legacy `renderer()` explicitly
initializes Skia; `renderer_mut()` also invalidates browser presentation before
exposing unrestricted concrete mutation. Neither getter grants a browser
presentation receipt, geometry authorization or input permission. Canvas2D
uses an independent `CanvasService` before page initialization, then transfers
that exact command/snapshot/font owner into the concrete renderer on first
explicit page access. Subsequent operations use the currently stored renderer;
whole-renderer replacement cannot revive the retired pre-page store.
See [the backend boundary](../../docs/dual-renderer/skia-backend-boundary.en.md).

Host bindings call `Session::dispatch` with a `container_bridge::BridgeEnvelope`.
The method always returns a `BridgeBatch`; invalid protocol, capability,
render, and cancellation failures are structured response envelopes with the
stable bridge error codes. `dispatch_result` is available to bindings that
want a fallible session-construction error boundary.

When a host includes content-addressed module bytes in `app.init` (or sends a
`module.load` batch), the selected native provider registers the declared
CommonJS/JSON modules through a session-owned named registry. Every supplied
module is verified and its factory registered before entry evaluation; module-local
`require` resolves only dependency edges declared by the manifest. Cached exports
retain object identity, including partially initialized exports in CommonJS
cycles. JSON syntax is checked using the selected engine's `JSON.parse` before
application execution, preserving ECMAScript number and UTF-16 semantics.
App, page, component and unreferenced legacy batch roots evaluate eagerly;
modules declared as dependencies evaluate when reached by `require` or an
explicit `module.call`. The bounded ESM adapter follows source declaration order
but does not implement live bindings, dynamic import, export-star or cycles
involving ESM. Unsupported syntax and ESM cycles fail explicitly.
The legacy eager `load_module_with_id` API retains atomic nested registration;
starting a new registry factory inside that transaction is unsupported and
fails with `ERR_MODULE_LOAD` before changing its cache or registrations.
Already evaluated or currently evaluating cached modules remain accessible.
The provider installs the standard
`App`, `Page`, `Component` and `getApp` registration globals before evaluation;
the first loaded `app.js` entry is followed by one `App.onLaunch` dispatch with
the supplied `launchOptions`. Repeated `app.init` handshakes are idempotent and
do not invoke `onLaunch` twice. The registration snapshot is included in the
handshake response so hosts can diagnose missing page modules without guessing.

The engine boundary exposes only the registered `wx` facade and queues host
operations as batched effects; native bindings may issue the same operations
directly through the documented `api.call` bridge. Storage, timers, navigation,
provider callbacks, and `setData` all cross that boundary in batches.
Unsupported calls reject with `ERR_UNSUPPORTED_CAPABILITY` according to the
manifest matrix.

Session-owned component occurrences receive `pageLifetimes.show/hide` when
their page visibility changes, including navigation, cached tabs and App
foreground/background events. Newly attached occurrences inherit a visible
page's state. Dedicated QuickJS/V8 batches call only pageLifetimes, isolate
throwing hooks, and deduplicate attempts before entering user code. Both
reLaunch entrypoints dispose active and cached-tab occurrences. Window resize
does not synthesize a component resize lifecycle; official cross-hook ordering
and full component API parity remain separate conformance requirements.

`HostMetadata.displayMetrics` optionally supplies an observed display snapshot,
separate from `windowWidth/windowHeight`, which remain the only viewport sizes.
Hosts install it in `SessionConfig` before loading any modules. Later,
`Session::notify_window_metrics(HostWindowMetrics)` accepts one complete flat
JSON-compatible observation, validates it before mutation and refreshes the
synchronous `wx` cache before resize callbacks. Identical observations are
deduplicated; density, orientation, screen or inset changes alone do not replay
resize when the logical viewport is unchanged. Page data, storage, timers and
the isolate remain owned by the same session. The legacy size-only API keeps
the current display metadata. Hosts without a display snapshot retain the
historical sandbox defaults, which are auxiliary behavior rather than device
measurements.

Display density, screen extent, status-bar height and orientation feed
`getSystemInfo`/`getSystemInfoSync`; `getWindowInfo` additionally exposes the
observed `screenTop`. The runtime does not invent `windowTop` or DeviceInfo
`pixelRatio`. `safeArea` is optional: coordinates and extents are validated and
retained without rebasing, while a host that cannot establish its public
portrait-coordinate mapping omits it. Android currently records actual raw
insets and keeps that mapping unknown. Host conversion formulas and rounding
remain implementation contracts pending fixed-version official comparison.

Managed `relations` use composed component ancestry, including slot projection
and native wrappers. The shared QuickJS/V8 implementation commits reciprocal
`parent/child` or `ancestor/descendant` edges in one batch after attached hooks
converge, before page onLoad. `getRelationNodes` returns live isolate-local
instances; callers receive independent arrays. All detached hooks can still
query the old graph; both tables are then cleared before unlinked callbacks.
Behavior returns an opaque session-local string identifier. Nested behavior
membership, diamond deduplication, `hasBehavior` and relation behavior targets
share that identity registry.

Relation callbacks may call setData and trigger another render frontier.
Disposal and relation callbacks form an irreversible lifecycle boundary: a
later invalid frontier recovers the most recent committed live topology, not
an occurrence whose detached hook has already run. User JavaScript effects
are not rolled back. A declared `linkChanged` callback fails explicitly with
`ERR_UNSUPPORTED_CAPABILITY` until the view supplies physical move identities;
compacting a relation result array does not count as moving a component.
The saved DevTools 3.17.3 oracle constrains only the projected
ancestor/descendant initial, removal and restoration lifecycle sequence.
Other relation contracts and all host/device claims remain auxiliary.

Managed component `triggerEvent` uses the negotiated partial
`Component.triggerEvent` capability and one session-published event graph
inside the selected isolate. Direct listeners and nested custom emissions run
in the same JavaScript turn, retaining the local detail object's identity.
Capture, bubbling and composition are opt-in; propagation stops at component
boundaries unless composed, and catch listeners stop later handlers. The graph
is available before lifecycle/input callbacks and does not require a painted
frame. Listener aliases share the pointer-event spelling rules. The saved
fixed-SDK lifecycle-compare oracle covers alias priority and hyphen/underscore
names only; propagation options, detail identity, synchronous ordering and
lifecycle emissions remain local contracts pending official differential
evidence. See `docs/api-runtime-conformance.md` for the precise evidence scope.

Dataset and mark metadata preserve the JSON values already evaluated by WXML,
using one projection for the native tree and managed component event graph.
Selector fields, observer dataset and coordinate input read committed metadata;
identified contacts retain the touchstart snapshot through later data patches.
Literal and legacy frame strings are never parsed as JSON. See
[event metadata](../../docs/event-metadata.en.md) for the Rust/wire compatibility
change, null/presence limits and remaining official conformance work.

Host `data.patch.batch` requests update the selected live Page instance inside
the JavaScript engine before committing the same batch to AppService/View.
The concrete page id keeps repeated route instances separate. The engine
mirror does not call `setData`, observers or callbacks and does not generate
a second patch event. Dotted keys and bracketed array indices share the
core's typed path contract; malformed paths and unknown pages fail before
either mirror changes. This proves an internal bridge invariant, not official
DevTools equivalence for the protocol's `delete` operation. Template/style
manifest replacement preserves this state; a full session restart resets it.

The portable sandbox bounds every array path to a length of at most
1,048,576 elements. Both adapters and Rust reject larger indices before
allocation, including integers that JavaScript cannot represent exactly.
This resource limit is not an official WeChat compatibility claim. Engine
mirrors support ordinary writable JSON data. A preflight rejects frozen,
non-configurable, accessor or custom-prototype destinations with `ERR_ENGINE`
before any patch in the batch changes the page. Arbitrary Proxy traps and
modified JavaScript builtins are outside this transaction guarantee.

Hosts that do not have a native view tree can submit a manifest-backed render
commit. Set `templateId` (or put it inside `frame`), provide the declared
`blobs` as SHA-256 keyed byte arrays/UTF-8 strings, and include optional
`data`, `styleIds`, `viewport`, and `frameId` fields. The session verifies each
digest, decodes and evaluates WXML, resolves the selected WXSS blobs, performs
deterministic layout, and commits one batch render tree. Missing or mismatched
blobs return `ERR_RENDER`; the explicit `frame` form remains available to
native view implementations.

Omitting `data` in a manifest-backed commit uses the current Page's AppService
data, including accepted `setData` effects. An explicit `data` value remains an
override. Inline `style` and stylesheet declarations share one cascade result:
importance, inline/selector specificity and source order determine the values
used by computed-style queries, layout, paint and hit testing. These are local
portable contracts; full WXSS and official runtime equivalence remain partial.

Layout declarations are validated and shorthands expanded before the cascade.
After typography resolves, typed Block/Flex dimensions retain containing-block
percentages and auto values for the shared renderer solver. This includes
grow/shrink/basis, wrapping, alignment, edges and min/max constraints. Legal
unsupported values reject the candidate instead of silently drawing another
layout. See [the layout contract](../../docs/layout-flow.en.md).

WXSS IR v2 preserves import sites and conditional groups. Before cascading,
the runtime expands leading local imports at each site and evaluates media
conditions against the frame's logical viewport. Matching ordinary rules
retain source order; unmatched groups never leak into element styles.
Width/height, orientation and aspect-ratio queries use the documented portable
subset. Active `@supports`, unknown at-rules and late/nested imports return
`ERR_UNSUPPORTED_CAPABILITY`. Font-face and keyframe metadata is retained but
does not implement font loading or animation. Legacy v1 imports still expand
before their owner's rules and cannot recover lost source positions or group
context. Local `.wxss` and `.css` resources use the same resolver, matching the
packer. See [the WXSS contract](../../docs/wxss-ir.en.md) for query semantics and
resource failures.

Solid WXSS borders now project independently cascaded width/style/colour edges
into the shared render model. CSS content-box is the WXSS default; explicit
border-box, padding, currentColor/inheritance and the padding-edge overflow clip
feed layout, pixels and input together. Other legal border styles reject the
candidate frame instead of pretending to draw a solid border. The previous
accepted frame survives rejection. See [the border contract](../../docs/wxss-borders.en.md)
for supported values, legacy frame defaults and remaining oracle/host gaps.

Native-enabled sessions own a second, isolated View engine for batched WXML/WXS
rendering. Verified View modules never enter AppService. Retained render tickets
prevent component discovery from replaying stateful work, and disposal releases
the exact occurrence scopes. WXS document/program edits restart the session;
style-only previews reuse cached ASTs. Legacy WXS without module metadata stays
unsupported. See [the View contract](../../docs/isolated-view-engine.en.md) for
budget, failure and dialect limitations.

Development validation tools run separately from the production runtime.
Compatibility claims require the versioned behavior and conformance evidence.

JavaScript providers are explicit Cargo features. `quickjs-native` links the
native rquickjs adapter; without it, the default QuickJS session is a
protocol-only headless boundary for manifest/conformance tests. `v8-native`
links the pinned rusty_v8 adapter and stores its isolate in the session. A V8
session built without that feature fails during construction with
`ERR_ENGINE`; it never falls back to QuickJS.

The optional `restricted-showcase` feature builds a separate demonstration
distribution. It requires an absolute `WEAPP_SHOWCASE_POLICY` path at compile
time; missing or invalid policy fails the build. The policy has exactly three
fields: `schemaVersion: 1`, a nonempty `allowedPackRoots` array of manifest
integrity roots, and a nonempty `allowedApis` array. Pack integrity is always
verified, and both runtime and SDK reject unapproved packs before execution.
The API list is a compiled ceiling that host providers cannot override.
Development diagnostics, arbitrary host method calls, pack replacement and
update authorization are disabled in this distribution. Host messages remain
available when the corresponding application APIs are allowed.

Use `--distribution-profile restricted-showcase --showcase-policy /absolute/policy.json`
with `scripts/build-web-wasm.mjs` or `scripts/sdk-native-build.mjs`. These
producers require release mode with view diagnostics off, retain a canonical
policy privately and verify its identity in the compiled artifact. Reports and
archives carry `distributionProfile` and `policySha256`; consumers require an
explicit matching restricted identity, so a showcase binary cannot satisfy a
full SDK dependency. Platform archive installation accepts the same explicit
profile with `--policy-sha256`. This boundary limits the delivered capabilities;
compiled binaries still permit reverse engineering and do not provide source
encryption.

Native Skia showcase producers also require `--showcase-font /absolute/NotoSansSC.ttf`
and `--showcase-font-license /absolute/OFL.txt`. Both the producer and Rust build
script verify the fixed reviewed hashes; direct Cargo builds supply the same
inputs as `WEAPP_SHOWCASE_FONT` and `WEAPP_SHOWCASE_FONT_LICENSE`. The native
binary embeds those font bytes and installs an exclusive font provider before
the first Canvas operation or page layout. The independent Canvas owner moves
that same provider into the lazy page renderer. Windows font registration and
system CJK fonts are unnecessary for this distribution. Native receipts verify
the compiled font identity and actual font bytes; archives retain the OFL.
Full runtimes retain host fonts, and Web retains its explicit portable font.

Before evaluating a managed template, the runtime refreshes current live component
snapshots in one engine batch. This lets a JS data repair recover a previously
invalid frontier without first evaluating stale cached data. A rejected frame
keeps the previous rendered frame; already completed detached/unlinked callbacks
remain completed, and recovery retains the latest committed live topology.

`Session::accepted_page_observation()` borrows an accepted Skia frame, its
render revision, its pinned submission target and any cached pixels without
initializing a page renderer, evaluating View or cloning a buffer.
`page_render_status()` reports configuration, allocation, duration and surface
flags; `has_metal_context()` is a passive attachment query on Metal builds.
An empty backend has no accepted observation and reports zero/false runtime
status. These facts grant no current-route, input, ready or browser authority:
a retained frame can belong to a previous page.

`render_target_for_revision()` accepts only the exact current nonzero Skia
render revision, not an application frame id or DOM revision. Its target is
pinned when a page commit succeeds. Staging density, rejected commits, Canvas
draws and diagnostic snapshots cannot change that pin. The target describes
the accepted configuration/submission; it does not measure a host framebuffer
or prove GPU presentation. `render_snapshot()` is an explicit clone/diagnostic
request and retains external-frame mode's on-demand software snapshot behavior;
the borrowed observation exposes only already cached pixels. Public concrete
renderer getters remain available for compatibility and explicit legacy
initialization/mutation.

<a id="异步-sdk-宿主合约"></a>
## Asynchronous SDK host contract

`HostApiProvider::start_call` defaults to the existing synchronous `call` result.
A provider can return `ProviderStart::Pending` to publish a `HostRequest::Call`
without blocking the runtime. Drain `Session::take_host_requests()` after the
runtime turn, execute transport/business work externally, then enqueue
`complete_host_call` on the original owner thread. Never enter the session from
a transport callback while a turn is running. `api.result` accepts the same
opaque `callId` and either `result` or a serialized `ProviderError`; unknown,
duplicate and previous-generation IDs return `accepted:false`.

Register exact method names with `set_host_methods` before `app.init`.
AppService code uses `weappContainer.invoke(method, payload, {timeout})`,
`postMessage`, `onMessage` and `offMessage`; the host sends inbound messages with
`send_host_message`. Payloads are JSON values. HTTP request byte bodies and
results use `dataEncoding:"bytes"` internally and the wx facade reconstructs
ArrayBuffer results. The API typings are in `sdk/contract/types/weapp-container.d.ts`.

The default business deadline is 30 seconds and provider deadline is 60 seconds;
positive `timeout` milliseconds and earlier absolute deadlines may override it.
Hosts schedule `poll_host_timeouts` using `next_host_deadline_ns`, independently
of the presentation loop, including while hidden. Cancellation, timeout, close
and completion settle each pending call once. `cancel_host_calls` is terminal;
it discards unsent work and emits cancellation for work already delivered.
Limits are 256 pending calls, 1024 outbox entries including reserved cancellation
capacity, 64 MiB aggregate queued payloads, 1 MiB business payloads and 256 JS
message listeners. HTTP completion JSON may be at most 64 MiB.

Storage remains session-owned. `restore_storage` must precede `app.init`;
`storage_snapshot` preserves undefined separately from null and
`storage_revision` lets the SDK serialize writes. Disk persistence and durable
flush acknowledgement belong to the SDK. A replacement candidate's host outbox
and storage effects remain private until that candidate is committed.
