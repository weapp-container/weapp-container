<a id="appservice-api-语义回归"></a>
# AppService API Semantic Regression

[简体中文](api-runtime-conformance.md) · **English**


`container-core` and `container-runtime` provide a
**session-scoped memory provider** when the host has no persistent storage. It is only enabled when the corresponding `wx.*` features are explicitly declared as `full` or `partial` in `ContainerManifestV1.capabilities`; the host configuration then takes the lower of the two. Thus, the result of `wx.canIUse` remains consistent with the actual dispatch gatekeeping.

<a id="存储"></a>
## Storage

`wx.setStorage`、`wx.setStorageSync`、`wx.getStorage`、
`wx.getStorageSync`、`wx.removeStorage`、`wx.removeStorageSync`、
`wx.clearStorage`、`wx.clearStorageSync`、`wx.getStorageInfo` and
`wx.getStorageInfoSync` share the same `MemoryStorage` within a session. QuickJS/V8's local storage mirror is merged into AppService via batch `storage.patch.batch` effect; a host snapshot is restored before each script execution, thus writes from bridge, module top-level writes, callback writes, and writes before exceptions are all observable.
All synchronous and asynchronous entry points check the same capability, prohibiting further writes after `canIUse` returns false.
`set`、`remove`、`clear` all produce `RuntimeEvent::StorageChanged`.

JSON values are saved using `snapshot()`; when it is necessary to preserve JavaScript `undefined`, the host should use `snapshot_state()` / `restore_state()`. This pre-versioning internal snapshot uses `values` and `undefinedKeys` to distinguish explicit `undefined`, JSON `null`, and missing keys, without exposing sentinel objects to mini-programs.

`getStorageInfo*` returns a sorted-stable `keys`, `currentSize` rounded up to KiB, and a `limitSize` of 10 MiB; currentSize is calculated in UTF-8 bytes per `[key, value]` JSON pair, and the asynchronous form also includes a `getStorageInfo:ok` envelope adhering to success/fail/complete callbacks and Promise dual form.

Synchronous reading follows the missing value convention of WeChat and `@mpcore/simulator`:
`wx.getStorageSync(key)` returns an empty string `""` when the key does not exist, and does not throw a `data not found` exception. If the caller explicitly writes `undefined`, the value remains `undefined`, thus the implementation determines missingness by the existence of the storage key rather than by the returned value.

Request example:

```json
{"name":"wx.setStorage","key":"greeting","data":{"text":"hello"}}
```

The `result` and top-level fields of the response are maintained in the batch bridge's JSON format. Asynchronous reading of a non-existent key
returns `ok: false`, `found: false`, `data: null` with structured
`ERR_INVALID_REQUEST` / `wx.getStorage:fail data not found`; JavaScript side executes
fail/complete and rejects the Promise. The `result` of synchronous read is the primitive value, and is `""` when missing.
The `result: null` for synchronous set/remove/clear indicates an undefined return value at the JSON boundary.
Explicitly saving undefined is still considered a successful read, and the bridge marks it as `found: true`, `undefined: true`,
and the JavaScript side returns the actual undefined; null and missing key are handled separately.

<a id="发布选项"></a>
## Launch options

The `launchOptions` of `app.init` will be saved as the same JSON object in the session and will be reused in App.onLaunch, subsequent App.onShow, `wx.getLaunchOptionsSync`, and `wx.getEnterOptionsSync`. Modules calling synchronous APIs during the `app.init` loading phase will also see this snapshot; repeated `app.init` calls only update it when a new object is explicitly provided. The default snapshot maintains the common WeChat structure of `{ path: "", query: {},
referrerInfo: {}, scene: 1001 }`, and non-object inputs return `ERR_INVALID_REQUEST`.

<a id="设备快照"></a>
## Device snapshot

`wx.getBatteryInfo` and `wx.getBatteryInfoSync` return `{ level, isCharging, errMsg }` via the same typed host provider at the boundary, where `level` is fixed in the range `0..100`.
The asynchronous form uses `getBatteryInfo:ok`, while the synchronous form uses `getBatteryInfoSync:ok`. The synchronous call is injected with a provider snapshot by the runtime before module evaluation and does not generate a bridge request. The default `SandboxProvider` uses a reproducible `100%` non-charging snapshot; test and host adapters can inject other states via battery configuration in the provider. Requests uniformly check deadline and cancellation at the provider entry, returning `ERR_TIMEOUT` or `ERR_CANCELLED` upon expiration or cancellation, without faking successful results. The real device provider should obtain the same fields from the system battery service and downgrade the capability negotiation result to `unsupported` when system capabilities are unavailable.

`wx.getScreenBrightness` and `wx.setScreenBrightness` share the same typed provider
state. `value` must be a finite `0..1` number; reading returns
`{ value, errMsg: "getScreenBrightness:ok" }`, writing returns
`{ errMsg: "setScreenBrightness:ok" }`. Device permissions, deadline, and cancellation
are uniformly validated at the provider entry. Sandbox defaults to brightness `1`, host can inject real display service and set capability negotiation to `unsupported` when not supported.

<a id="定时器"></a>
## Timers

`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval` usage
`TimerScheduler`. The scheduler does not create native threads and is invoked by the host in the event loop
`Session::poll_timers(now_ns)`; the returned single `event.batch` contains all expired timers
along with their `timerId`, `kind`, `firedNs`, `callbackId`. A single poll for an interval produces
only one firing and recomputes the next deadline from the current host clock to avoid unbounded catch-up batches. Clearing an unknown timer is idempotent and returns `cancelled: false`.

In real QuickJS/V8, global timers in the runtime are saved by the selected engine with a callback. The same `poll_timers` entry executes JS timers in batches based on millisecond host clock, clears microtasks, and submits storage, setData, and API effects; traces are respectively marked as `quickjs.timer` and `v8.timer`. A snapshot of the latest host storage is synchronized before the callback execution, so timers triggered immediately after bridge writes do not read the old snapshot. No empty engine timer trace is emitted when no expiry callback is present.

<a id="能力与错误合约"></a>
## Capability and error contract

`wx.canIUse` calculates the result from negotiation between manifest and host capability, returning `result: false` for unknown or `unsupported` items. Other APIs return `payload.error.code = "ERR_UNSUPPORTED_CAPABILITY"` under the same condition; they do not silently return null values.

<a id="共享"></a>
## Sharing

`wx.shareAppMessage` and `wx.shareTimeline` both pass through the same batch of provider boundaries for sharing options. QuickJS/V8 facade rejects `null`, arrays, and other non-object parameters before entering the bridge and returns `ERR_INVALID_REQUEST`; sandbox provider continues validating optional string fields, the `extraData` object, and the `menus` string array, using the shared error codes for expiry, cancellation, and explicit `share` permission denial. Successful results contain only the publicly exposed `{ errMsg: "wx.share*:ok" }` structure, and the provider additionally preserves a typed `ShareRequest` snapshot for conformance and native host adapters to read. Sandbox does not open the system sharing panel and does not consider the request as a completed share; real platform providers must integrate with the system sharing lifecycle on their own.

<a id="临时-ui-与页面控件"></a>
## Transient UI and page controls

`wx.showToast`/`hideToast`, `showLoading`/`hideLoading`, `showModal`,
`showActionSheet`, `pageScrollTo` and `setNavigationBarColor` cross the same
typed provider boundary as network and device APIs. The deterministic sandbox
records the latest overlay, scroll and navigation-bar state without opening a
native window. It validates the public option shapes and returns the documented
result envelopes (`confirm`/`cancel` for modal and `tapIndex` for action sheet),
so a host can replace the provider implementation while retaining batch bridge
semantics, deadlines, cancellation and teardown. These APIs remain `partial`
until each host supplies user-action timing, native overlay and accessibility
evidence.

<a id="选择器查询"></a>
## Selector query

QuickJS/V8 keep each `NodesRef` selection and its callbacks inside the isolate.
`boundingClientRect`, `scrollOffset`, `fields` and `node` append operations;
`select`/`selectAll` alone do not append work to an existing operation batch.
One nonempty `exec()` emits one `wx.createSelectorQuery` bridge request, rather
than one request per reference or matched node:

```json
{
  "name": "wx.createSelectorQuery",
  "queries": [
    {
      "selector": ".card",
      "target": "node",
      "all": true,
      "operation": "boundingClientRect",
      "fields": null,
      "scopeId": null
    },
    {
      "selector": "#scroll",
      "target": "node",
      "all": false,
      "operation": "scrollOffset",
      "fields": null,
      "scopeId": null
    }
  ]
}
```

The earlier direct bridge shape (`selector`, `all`, `fields`) remains accepted.
In the batched shape every result slot belongs to the operation that queued it.
Its callback runs in enqueue order, followed by the `exec` callback with the
complete array; the returned Promise resolves to that same array. Values such
as `false`, `null` and `[]` are retained rather than filtered as falsy. A callback
exception enters the engine diagnostic stream while later callbacks still run.
A provider error or malformed result-array length rejects the batch without
running success callbacks. The operation queue is consumed before dispatch,
so reuse cannot replay callbacks from an earlier failed execution. Empty
`exec()` resolves asynchronously to `[]` without a geometry request. The
portable `select(...).exec()` shorthand queues one bounding-rectangle operation
only when no explicit operation is queued; this convenience is not additional
official API evidence.

The query reads the most recent `render.commit` frame in tree order. `#id`,
`.class`, `tag`, simple combinations (`view.card`), comma-separated lists,
descendant (`view .card`), child (`view > text`), adjacent sibling (`.a + .b`)
and general sibling (`.a ~ .b`) relationships are supported. Attribute
presence/equality selectors (`[disabled]`, `[data-state=ready]`, including
quoted values) are also supported. `selectViewport()` targets the committed
viewport; `in({ scopeId })` scopes a query to the render node carrying the
matching `data-sim-scope` attribute. Unsupported pseudo-class selectors and
malformed attribute selectors are rejected with `ERR_INVALID_REQUEST`. A
missing committed frame returns `ERR_RENDER` so the
API cannot report geometry from stale or fabricated state. `all: false` returns
the first match (or `null`), and `all: true` returns an array (or `[]`). These
empty results keep their position in an `exec` batch.

A retained `NodesRef` keeps its original selection even if the query later
creates another reference. Scope belongs to the query and is captured for all
queued operations at `exec` time. The portable facade accepts a nonempty
`scopeId`/`__scopeId`/`id` on the supplied scope descriptor; `in(null)` resets
the scope. A descriptor without a usable id rejects with
`ERR_INVALID_REQUEST` and never falls back to a page-wide query. A well-formed
scope id whose render node is absent returns no node matches. This descriptor
contract does not yet prove automatic binding between a JS `Component`
instance and a `data-sim-scope` render subtree.

The `fields` projection follows the public mpcore contract: `rect`, `size`,
`scrollOffset`, `id`, `dataset`, `mark`, arbitrary component `properties`, and
requested `computedStyle` names are returned as flat fields. `node` and
`context` return portable descriptors (`canvas` nodes retain their type) at the
JSON bridge boundary. Render nodes preserve `data-*` attributes as camel-cased
`dataset` values, and `mark:*`/`mark-*` attributes as camel-cased mark values;
these are the same objects used by pointer events. Malformed properties or
style lists return `ERR_INVALID_REQUEST`. Portable node/context descriptors do
not provide native Canvas/WebGL object identity or resource ownership.

SelectorQuery remains `partial`. Effective manifest/host support controls
`wx.canIUse`. The facade checks support at `exec`, including empty executions,
and rejects unavailable work with `ERR_UNSUPPORTED_CAPABILITY` before success
callbacks or host effects. The runtime checks the same capability at direct
bridge and native-engine effect boundaries, so a manually emitted native
effect cannot bypass negotiation. Constructing a fluent object alone is not
evidence that querying is supported. Local engine/runtime fixtures cover these
distinct entry paths and the batching/projection boundary; they do not promote
real DevTools or seven-host evidence.

`event.batch` may carry `x`/`y` (or `clientX`/`clientY`) without a target/path.
The session hit-tests the last committed frame once, fills the target path and
dataset, and then runs capture/target/bubble dispatch as one batch. A pointer
event without a committed frame fails with `ERR_RENDER`. Page handlers receive
`stopPropagation`, `stopImmediatePropagation`, `preventDefault` and
`cancelBubble`; propagation control is reflected in the batched hook result and
the returned dispatch list is truncated at the handler that consumed it.
The same hit-test also projects WXML `mark:*`/`mark-*` attributes into
`event.mark`. Marks are inherited in root-to-target order and a nearer mark
replaces a value with the same key, matching the public event-mark contract;
the merged object is stable across capture, target and bubble phases.

Navigation URLs are normalized at the same boundary: `/pages/detail?id=7`
stores `pages/detail` as the route and passes string query values to `onLoad`;
percent escapes and `+` are decoded, explicit `query` keys override URL keys,
and declared manifests reject unknown routes, tab targets for `navigateTo` /
`redirectTo`, or non-tab `switchTab` targets before mutating the page stack.
Empty and whitespace-only URLs are also rejected before page hooks run.

QuickJS and V8 navigation methods now use pending `api.call` requests rather
than reporting success when a navigation effect is merely queued. The shared
runtime operation validates capability, deadline, cancellation and target,
commits page state and synchronizes `getCurrentPages()` before invoking
`success`, `complete`, and then resolving the Promise. Failures invoke `fail`,
`complete`, and reject that request; a handled failure does not discard later
requests in the same batch or emit an additional global error. Public result
`errMsg` values use `navigateTo:ok` / `navigateTo:fail ...`; structured failures
retain their `ERR_*` code and `wx.*` API name. Callback exceptions are reported
separately and cannot skip `complete` or Promise settlement.

Effect continuations drain until quiescent, with a limit of 1024 batches per
drain and the inherited host deadline. Reaching either limit emits an explicit
`ERR_TIMEOUT` event after the consumed trace. Completed work remains committed;
queued continuations wait for the next host turn. This does not mark all
Promises complete or cause exception cleanup to consume another budget.
`RequestTask.abort()` and bridge cancellation update the same session token
registry and notify the Provider, including cancellation effects queued in the
same turn as a navigation request. These are local dual-engine conformance
results; navigation remains `partial` pending official and host evidence.

`wx.setNavigationBarTitle` crosses the typed provider boundary before mutating
the current `PageEntry`. The title is persisted on that page instance and is
therefore included in page-stack responses, restored when a cached tab is
activated, and discarded after `redirectTo`, `reLaunch` or `onUnload`.
Missing current pages, non-string titles and provider deadline/cancellation
failures return structured errors without mutating page state; an empty string
is a valid title override. QuickJS and V8 facades
emit the same cloned navigation options in their batched host effects.

<a id="相交与媒体查询观察器"></a>
## Intersection and media-query observers

`wx.createIntersectionObserver` and `wx.createMediaQueryObserver` use persistent
Session-owned subscriptions in QuickJS and V8. Page and component instances
also expose `this.createIntersectionObserver(options)` and
`this.createMediaQueryObserver()`. The intersection API accepts the options-only
and `createIntersectionObserver(component, options)` overloads. Each observer
and observation has a serializable identity; callbacks stay in the isolate,
and registrations, disconnections and measurement notifications cross the
bridge in batches. Registration acknowledgement is not a measurement and does
not invoke the observation callback. Measurements are produced after a
successful `render.commit` or an actual host viewport resize. Registration
after an idle frame schedules its initial observation on the next host timer
poll, so it does not require a new `setData` or repaint. Subscriptions created
by ready/resize hooks enter the registry before that boundary is measured.

Intersection selectors resolve against the committed frame and the owning
page/component scope. An explicit component argument or `this.create*Observer`
uses the component selector scope. An implicit `wx` factory retains its
lifecycle owner for cleanup and uses page selectors. Results include `id`, `dataset`, `intersectionRatio`,
`boundingClientRect`, `intersectionRect`, `relativeRect` and `time`. Geometry
uses the world-space axis-aligned bounds of all four transformed node corners,
including inherited transform origins. `display: none` is inherited; zero
opacity does not remove layout geometry. The default non-native mode intersects
the target with the configured reference regions directly, allowing multiple
`relativeTo`/`relativeToViewport` regions whose intersection forms the root.
`nativeMode` uses an ancestor reference and clips along the ancestor path.
Margins expand or shrink the corresponding reference region. Thresholds and
`initialRatio` control notifications, so unchanged committed measurements do
not repeatedly invoke callbacks. `observeAll` selects multiple scoped targets.

Media queries use `width`, `minWidth`, `maxWidth`, `height`, `minHeight`,
`maxHeight` and `orientation` (`portrait` or `landscape`). They evaluate the
host's logical viewport, using the first committed frame viewport when the
host has not supplied dimensions. Initial delivery occurs at a committed
measurement boundary, then notifications report `matches` transitions;
repeated resizes with the same match result do not notify again. The current
auxiliary baseline treats equal width and height as `landscape`; this is media
query geometry rather than the physical device-orientation API.

`disconnect()` releases the observer, and page unload/component detach release
their owned subscriptions. A local disconnect also prevents a queued callback
from being delivered after cancellation. Invalid descriptors, thresholds and
selectors return `ERR_INVALID_REQUEST`; an unnegotiated capability returns
`ERR_UNSUPPORTED_CAPABILITY` and makes `wx.canIUse` return `false`. A standalone
`SandboxProvider` does not advertise or service either observer API: it returns
an explicit unsupported error instead of fabricating zero geometry or a
one-shot match. Session handles observation before provider dispatch.

Both APIs remain `partial`. Lifecycle and observer callbacks establish an owner
context; arbitrary Promise chains do not propagate implicit component ownership.
Hidden-page observation timing and dynamic target identity still need official
oracle coverage. Scroll offsets are currently metadata and do not
move painted subtrees; actual scrolling observation is not implemented. World
AABBs do not prove pixel visibility, occlusion, or exact rotated-region
clipping. The cached public typings describe initial delivery as a changed
ratio that reaches a threshold, while the headless helper ignores intersection
options and the Web helper uses browser observer rules. Exact threshold
equality/crossing, initial zero-area behavior and square-viewport orientation
therefore still require the fixed DevTools/SDK oracle. Local geometry and
subscription tests do not establish official DevTools, host GPU, emulator or
physical-device parity; those observer gates have not been run for this change.

## Canvas 2D

QuickJS/V8 provides a batch 2D command context for `wx.createCanvasContext`. Attribute settings and
drawing methods are only appended to a local command queue; `draw(reserve?, callback?)` sends a
`wx.canvas.draw` bridge request carrying `canvasId`, `reserve`, and the full command array.
Sandbox provider validates command operation names and parameter shapes; runtime then converts
the batch of commands into `container-render-skia::CanvasFrame`, replaying and saving an RGBA8 snapshot
addressed by `canvasId` within a renderer boundary. `reserve:false` replaces the command history of the canvas,
`reserve:true` appends to the history, and the host can retrieve the complete pixel buffer via `canvas_snapshot_json(canvasId)` in one go.
Software path supports colors, rectangles, paths, transformations, text, line cap/line join styles
(`setLineCap`, `setLineJoin`, `setMiterLimit`), dashed line styles (`setLineDash(pattern, offset?)`), and state stack; odd-length patterns are repeated once according to Canvas 2D rules, while negative numbers or non-finite values return `ERR_INVALID_REQUEST` at the provider boundary; the renderer alternates stroke generation based on dash/interval. Known but currently lacking resource lifecycle contracts for `drawImage`, shadows, and text alignment commands return explicit `ERR_RENDER`, and these drawing operations are not silently dropped. A context is immediately returned with `ERR_UNSUPPORTED_CAPABILITY` if the capability is not declared, and no fake drawing success is faked.

<a id="动画"></a>
## Animation

`wx.createAnimation` provides a native chainable object consistent with the `weapp-vite` WebAnimation polyfill in QuickJS and V8. Property transformations (including `opacity`, size, translation, rotation, scaling, matrix, color, and skew) are appended to the current step; `step(options)` batches the operations into `{ animates, option }`. Each exported step materializes four default WeChat options: `delay: 0`, `duration: 400`, `timingFunction: "linear"`, and `transformOrigin: "50% 50% 0"`, with caller-provided values overriding the corresponding defaults; `export()` returns `{ actions: [...] }` and clears the exported queue. `scale(x)` and `translate(x)` are respectively extended to `(x, x)` and `(x, 0)` according to WeChat behavior.

The JS semantics of this API do not generate per-operation bridge requests; the exported JSON can be passed into View/Renderer via `setData`. The capability is still marked as `partial`, as each host still needs to provide per-frame clock, CSS/Skia transformation interpolation, and evidence of animation cancellation/resource release. If the negotiation result is `unsupported`, object creation will synchronously throw `ERR_UNSUPPORTED_CAPABILITY`, and `wx.canIUse('wx.createAnimation')` will return `false`, without returning a silent empty object.

<a id="wxss-和内联样式渲染"></a>
## WXSS and inline style rendering

Inline `style` bindings and WXSS declarations enter the same IR cascade.
Importance is compared before inline/selector specificity and source order;
an author `!important` declaration therefore wins over ordinary inline style,
while an important inline declaration wins over an important stylesheet rule.
Supported shorthands contribute their longhands before comparison, retaining
declaration order instead of applying shorthand precedence after collecting a
property map. Inline parsing keeps delimiters inside quoted strings/functions
and ignores malformed declarations individually.

The final declaration map drives computed-style projection, layout, background,
foreground, opacity and z-index. A dynamic width consequently changes both the
painted area and the input hit-test tree. Supported color inheritance follows
the composed render tree; background, opacity and geometry are not inherited.
Sibling painting and hit testing share a stable z-index order, and valid
negative margin longhands retain their signed layout offsets. `computedStyle`
still exposes some winning declaration strings; full computed-value
normalization and invalid longhand filtering are not implemented.
This closes the earlier discrepancy where a query could report inline values
while layout and pixels still used the stylesheet.

`visibility` resolves after projection and is inherited through the composed
tree. Hidden nodes preserve geometry, while visible descendants keep ancestor
transform/clip/opacity and ordinary bubbling. Invalid declarations are discarded
before cascade; valid unsupported winners reject scene preparation and retain
the accepted frame. See [visibility](visibility.en.md) for the bounded grammar,
wire compatibility and CPU rendering validation.

A manifest-backed `render.commit` without an explicit `data` reads the current
Page's accepted AppService data. Explicit data, including `{}`, remains an
override; rendering does not replace the Page's stored data. Navigation selects
the current Page snapshot, so returning to a covered page cannot render a later
page's data. These are local contracts for the admitted style/expression subset,
not evidence for complete CSS/WXSS or official host parity.

Explicit `overflow`, `overflow-x` and `overflow-y` now constrain descendant
painting as well as hit testing. Software rasterization, native Skia and the
Web CanvasKit presenter share the admitted axis rules: `hidden`/`auto`/`scroll`
clip, `clip` can constrain one axis beside `visible`, and `visible` computes
to a clipping axis beside a scrolling axis. Two-axis clipping uses normalized
corner radii in the ancestor's transformed coordinate space; one-axis clipping
keeps the other axis open. Nested clips intersect and do not leak to later
siblings. A node paints its own background before applying its descendant clip.
Clipping uses the inner border edge (padding box); the node itself still
receives input on its outer rounded border. The [border contract](wxss-borders.en.md)
defines shared sizing and geometry. Full CSS overflow parity still requires
overflow-clip-margin, fixed-position escape rules,
actual scrolling and official DevTools visual comparison remain incomplete.
The `overflow-clipping` runtime fixture emits accepted frames for replay by
`scripts/overflow-clipping-browser-smoke.mjs`; browser WebGL readback does not
establish physical GPU/device or performance acceptance.

<a id="wxml-组件插槽"></a>
## WXML component slots

`container-ir::project_wxml_slots` applies the observable projection rules for
custom component templates before a host builds its render tree. Direct light
children with `slot="name"` are grouped into matching named `<slot
name="name">` outlets; children without a marker use the default outlet. An
outlet with no assigned children recursively renders its fallback subtree, and
an empty outlet is removed. The helper clones both the component template and
projected children, so one parsed component template can be reused for every
instance without leaking slot state between pages.

`project_wxml_slots_with_options(..., false)` models a component that does not
enable `multipleSlots`: all light children flow into the default slot and
`slot` markers are treated as composition metadata rather than renderable
attributes. Dynamic slot names remain literal until the caller evaluates the
component instance data; this keeps the IR helper deterministic and avoids a
per-node JavaScript bridge call.

`evaluate_wxml_with_templates` also honors WXML `<import src="..." />`
declarations. The imported file contributes named `<template name="...">`
definitions to the caller's lookup scope, while the import declaration itself
is removed from the rendered tree. Import paths accept package-relative names
and the manifest's `template:<path>` blob IDs. Missing targets and recursive
import cycles are deterministic `MarkupError::InvalidSyntax` failures, even
when a data-dependent branch would not invoke the imported template; this
prevents malformed package graphs from becoming host-specific behavior.

Template lookup is package-scoped rather than a global map lookup: a template
blob that is present in the manifest but is neither declared in the current
WXML file nor reached through `<import>` is not visible and produces a
structured `WXML template target not found` error. `<include>` is treated as a
textual expansion, so named declarations in the included file become visible;
recursive include graphs are rejected before data evaluation. This prevents
unrelated manifest templates from entering the portable evaluator's lookup
scope; official differential validation of this boundary remains pending.

Template expansion and binding evaluation share the same data traversal.
Each `wx:for` occurrence installs its item/index aliases before evaluating a
same-node conditional or `<template is="..." data="...">`. Nested loops and
`<include>` retain the current aliases, and relative paths continue from the
file that declared the include. An inactive branch does not evaluate its
dynamic template name or data. The import/include graph is still validated
separately before data evaluation, so an invalid declared package graph cannot
hide behind an inactive branch. Evaluated template text and attributes are
inserted as values; a data string such as `{{secret}}` is never parsed again
as a parent-page binding. Source ASTs remain reusable between invocations.

Portable binding expressions use a Rust tokenizer and Pratt parser over the
serialized data snapshot. The pure subset includes literals, dot/computed
member access, unary `!`/`+`/`-`, arithmetic, equality/relational comparisons,
logical operators, nested conditionals and array/object literals with supported
spread forms. Parsing validates the whole expression before evaluation;
short-circuiting selects among parsed pure subexpressions. Missing values,
`undefined`, `null`, coercion and array/object identity have explicit local
semantics rather than being delegated to string splitting or a host `eval`.
This is a bounded expression subset, not a complete JavaScript or WXML/WXS
implementation: calls are rejected with `MarkupError::InvalidSyntax`, and WXS
modules, assignments and side effects are not executed. There is no fallback
that silently sends an unsupported binding to QuickJS/V8, and no per-node
JS/Rust round trip. These local contracts remain `partial` until differential
evidence covers the admitted subset and each host.

Within that subset, WXML binding expressions preserve JavaScript's
value-selection behavior for
logical operators. `a || b` evaluates to `a` when it is truthy and otherwise
to `b`; `a && b` evaluates to `b` when `a` is truthy and otherwise to `a`.
This matters for interpolation such as `{{title || 'Untitled'}}`, which must
render the selected string rather than a boolean. The portable evaluator keeps
this result deterministic for serialized data snapshots; it does not run page
methods or WXS functions to obtain a binding value.

Member expressions also support computed bracket access. For example,
`{{items[index].name}}`, `{{lookup[key]}}`, and nested forms such as
`{{matrix[row][column]}}` evaluate each bracket expression in the current WXML
scope, with quoted and numeric keys retaining JavaScript property-key
coercion. Empty or unterminated brackets are reported as deterministic
`MarkupError::InvalidSyntax` failures instead of being treated as literal
property names. This keeps dynamic list/table lookups consistent with the
QuickJS/V8 facade while preserving the portable evaluator's host-independent
behavior.

The same evaluator handles parenthesized arithmetic/comparisons and nested
conditional expressions such as
`{{ready ? (count >= 2 ? 'many' : 'few') : 'off'}}`. Delimiters are validated
before lookup, so unmatched parentheses, quotes, or member indexes produce a
structured syntax error instead of a missing-value rendering. `wx:key` remains
a directive value during attribute interpolation, which preserves the special
`*this` key form for primitive repeat items.

WXSS resolution accepts descendant and child selector chains when the renderer
supplies the root-to-parent ancestry (`.card .title` and `.card > text`). The
existing specificity/important/source-order cascade is applied after the chain
matches. The renderer now passes that ancestry while building each WXML node,
so computed styles and layout use the same selector result that selector-query
and hit-test consumers observe.

The same render-tree context supports the structural pseudo-classes
`:first-child`, `:last-child`, `:only-child`, `:nth-child(...)` (`odd`/`even` and
`an+b` forms), and `:not(<simple-selector>)`. This renderer counts element
siblings and omits formatting text and comments from those positions. The
identity-only `matches_wxss_selector` helper deliberately leaves these
pseudo-classes unmatched when no sibling context is supplied; renderer paths
use `resolve_wxss_style_for_node` with one-based child position metadata so
computed style and layout receive the same result. Dynamic state pseudo-classes
such as `:hover` remain unsupported and are not silently treated as matches.

`wx:for` expansion records an optional `key` on each repeated element. A simple
property name such as `wx:key="id"` reads that property from the object item;
explicitly alias-qualified expressions use the current loop scope. Primitive
items support `wx:key="*this"`. Evaluated-only identity metadata is omitted
from source nodes, preserving existing v1 canonical manifest bytes.

When the evaluated AST enters the renderer, `RenderNode.key` retains that
identity. Generated node identifiers incorporate the loop's source site,
ancestor loop identities and an encoded key segment, so separate source loops
can reuse a key without colliding and delimiter characters cannot form extra
path segments. Unique keys remain stable when items reorder within their source
loop; unkeyed nodes use positional identity. Session-owned managed components
use these identities for local reconciliation and reject duplicate keyed
occurrences. CanvasKit, native host and official runtime parity still require
separate evidence.

The manifest `render.commit` path now applies this projection for local static
`usingComponents` relations. A page template such as `template:pages/index/index.wxml`
looks up its owner config (`pages/index/index.json`), resolves each alias to a
content-addressed `template:<target>.wxml`, evaluates that component template,
and replaces the custom tag with the projected component tree before layout.
`multipleSlots` is carried from component JSON or a statically lexed
`Component({ options: { multipleSlots } })` registration; omitted options use
the WeChat default (`false`). Missing plugin/npm targets remain unresolved for
an explicit host/provider boundary and are not reported as rendered component
parity.

With a native QuickJS/V8 provider, the session automatically creates,
reconciles and disposes managed component occurrences in batched graph
frontiers. Each occurrence owns independent data, property defaults,
observers and lifecycle hooks. Pure mustache attributes retain JSON values in
optional IR boundValues; declared property bindings normalize dash names and
update only changed parent inputs. Component setData invalidates the frame,
and internal event handlers run on the corresponding instance. Supplying
verified blobs in app.init allows attach before page onLoad; ready follows
the first render commit. The older explicit component factory remains
available to host adapters.

Projected slot content carries declaration data, event ownership and
usingComponents lookup separately from its visual parent. Component-scoped
selector queries and internal hit-test identity separate repeated public IDs.
Keyed updates retain surviving instances; removed instances are detached and
their late patches are discarded. Safe presentation reloads preserve this
graph, while structural component edits start an isolated replacement session.

Component pageLifetimes.show/hide follow session page visibility through one
dedicated engine batch. Same-named ordinary methods cannot shadow them;
throwing hooks are reported once per transition without skipping siblings.
Cached tabs and covered pages remain hidden, and reLaunch releases cached as
well as active components. Window resize does not invent a component resize
lifecycle. The local contract does not prove every official hook ordering.
Page/Component selectComponent and selectAllComponents use a versioned,
batched declaration-tree index, including ordinary nodes. ID/class compounds,
child, descendant and union selectors return live same-page occurrences in
tree order; a first matching native node resolves to null instead of skipping
to a later custom component. Projected content retains declaration ancestry.
Named-slot projection that reorders declarations still follows render traversal
order locally; its selection-order parity remains unknown.
Nested selectOwnerComponent uses the declaration owner rather than the
physical slot receiver. This direct-Page-child owner's current null result is
an auxiliary compatibility candidate: fixed-SDK evidence is still unknown,
and the newer public glass-easel reference can return a Page owner.

Cross-component >>>, tag/attribute patterns and targets with custom export
functions explicitly return ERR_UNSUPPORTED_CAPABILITY. Export targets never
silently expose their internal instance. All five selection methods have
partial capability entries and respect negotiated unsupported capabilities.
Property observers can change native selection metadata without changing any
component record. The accepted frontier republishes that metadata before
attached hooks, including the transition to a native-only tree.
If a new rendering frontier fails, a publication-only batch restores the
accepted reference tree without repeating observers or lifetimes; it does
not roll back arbitrary user JS effects. Disposing a page clears its entire
selection index, including native indexes first published during rollback.
Occurrences prepared in an earlier frontier and hidden by attached hooks are
detached before the final tree is accepted. The additive capability inventory and manifest golden retain
schema v1; its capability-name grammar now also accepts one Page/Component
method identifier. Rust validation, JSON schema and the packer enforce the same
namespace boundary. Older validators can explicitly reject these new keys.

See [public sources and the blocked native probe](archived-evidence.en.md).
The probe holds the machine lease and uses one owned native project; an
already-running DevTools host was preserved, and the attempt collected no
runtime results. Relations, complete selection/export semantics,
plugin/npm component resolution, full property rules, style isolation and
complete host semantics remain incomplete. Component/slot coverage stays
partial; no official conformance case or host gate is promoted by local tests.

<a id="组件自定义事件"></a>
## Component custom events

`Component.triggerEvent` is a partial, capability-gated API on session-owned
component occurrences. The session publishes a batched event graph to the
selected QuickJS/V8 isolate. `triggerEvent(name, detail, options)` resolves
listeners and calls their declaration owner in the same JavaScript turn;
custom events emitted by a listener use that same boundary. It does not send
one Rust/JS request per ancestor or serialize `detail` between local listeners.
The local contract retains the supplied JavaScript detail object's identity.
The graph is prepared before lifecycle and input callbacks, so dispatch does
not depend on a frame already having been painted.

`name` must be a nonempty string. Omitted options use an empty object;
explicit null, arrays and non-object options are invalid. Supplied
`bubbles`, `composed` and `capturePhase` values must be booleans; unknown option
keys are ignored. Invalid input and stale/disposed receivers return
`ERR_INVALID_REQUEST`. The legacy explicit component factory lacks a managed
scope and uses the same rejection rather than simulating delivery. An active
scope without a published event graph/page returns
`ERR_UNSUPPORTED_CAPABILITY`, as does an unnegotiated
`Component.triggerEvent` capability.

The isolate retains `detail` directly, including undefined, functions and
cyclic objects; event effects contain routing metadata and counts rather than
serializing that object into the bridge trace. The local lifecycle contract
allows emission from created/attached and during the detached hook while the
occurrence is still live. After detachment completes, saved references reject
new emissions. These rules describe the admitted local subset, not an
official observation of argument validation or lifecycle dispatch timing.

`triggerEvent` returns undefined. Listener exceptions enter the existing
engine diagnostic stream while later listeners still run unless propagation
has been caught. Nested emission has a local 128-level recursion bound and
fails with `ERR_ENGINE` when exceeded; this resource limit is not a WeChat
compatibility claim. The session publishes a complete page event graph only
after validation, preserving its previous graph on publication failure.

`bubbles`, `composed` and `capturePhase` default to false. The default path
invokes the direct component listener. Explicit capture is independent of
bubbling; non-composed propagation stops at the containing component boundary,
while composed propagation may continue through the outer tree. `catch` and
`capture-catch` stop later propagation. Graph ownership keeps the component
host listener on its declaration owner and projected slot handlers on their
declaration side. These propagation, detail-identity and same-turn rules are
local conformance contracts, not new official runtime observations.

Listener spelling follows the saved DevTools `2.02.2608080` / base library
`3.17.3` alias and named-event observations:

| Event name | Bare binding | Colon binding | Both on the same node |
| --- | --- | --- | --- |
| `probe` / native `tap` | `bindprobe` / `bindtap` | `bind:probe` / `bind:tap` | Bare binding wins in either attribute order |
| `probe_under` | `bindprobe_under` | `bind:probe_under` | Bare binding wins |
| `probe-hyphen` | Does not bind | `bind:probe-hyphen` | Only colon binding runs |

The reusable oracle is
[`lifecycle-compare.json`](archived-evidence.en.md):
its alias case records 13 `alias:*` checkpoints with 18 counters, and its
named-event case records 13 `named:*` checkpoints with 16 counters. Both native
and WeVu SFC component emitters are covered; the alias case also covers native
view taps. The saved `acceptance.evidence` entries contain observed
`devtools-page-frame` text, rather than only expected checkpoint definitions.
The complete original suite has 50 checkpoints, but it does not observe
custom-event detail identity, same-turn ordering, option defaults, composed
retargeting or lifecycle-time emission.

The upstream `e2e/ide/issue-1126-1128.test.ts` provides candidate assertions for
private/capture-only/local/composed events and catch behavior. Its indexed
status remains `unknown`, and no saved official run establishes those event
boundary rules. Local dual-engine tests must keep that distinction. This API
does not complete relations, WXS, plugin boundaries, all component event
semantics or any seven-host/official conformance gate.

<a id="宿主-provider-api"></a>
## Host provider APIs

The session owns one replaceable `HostApiProvider`. The default
`SandboxProvider` never touches the machine network or filesystem; it supplies
deterministic system information, request responses, in-memory files,
clipboard state and explicit permission outcomes. Native hosts replace it with
their reviewed provider through `Session::set_provider` while preserving the
same batch request and error shape.

The provider boundary covers `wx.getSystemInfo*`, `wx.request`/
`uploadFile`/`downloadFile`, filesystem operations (including `wx.saveFile`,
`wx.getFileInfo`, `wx.getSavedFileInfo`, `wx.getSavedFileList` and
`getFileSystemManager().saveFile`), clipboard and network
information, vibration/keep-screen-on, media/location, login/profile/payment
and share calls. The deterministic network sandbox accepts seeded responses by
URL. `wx.request` requires a URL and normalizes `method` exactly like the
headless runtime (omitted or empty means `GET`, otherwise trim and uppercase);
its response keeps the public `statusCode`, `header`, `cookies`, `data` and
`errMsg` fields. The returned request/upload/download object remains thenable for promise consumers and exposes `abort()`, `onHeadersReceived()` and `offHeadersReceived()`; abort before provider dispatch emits a cancellation token and suppresses later success callbacks, while `fail`/`complete` receive the stable `ERR_CANCELLED` envelope. Header listeners run once before `success` when a response contains `header`. A seeded object containing `data` is treated as a complete
response envelope, while a plain seeded value is kept as the response `data`.
`wx.uploadFile` additionally requires a `filePath` that exists in the
provider's in-memory file store and a non-empty form `name`; its success result
is restricted to the public `{ data: string, statusCode, errMsg }` shape (form
name, path, byte count, request headers and cookies stay provider diagnostics).
`wx.downloadFile` writes response bytes to the requested `filePath`, or to a
deterministic content-addressed temp path when omitted, and returns only
`{ tempFilePath, statusCode, errMsg }`.

`wx.getMenuButtonBoundingClientRect()` is a synchronous system API. The
provider returns `left`, `right`, `top`, `bottom`, `width` and `height` in
logical CSS pixels. Native hosts may inject their safe-area/menu geometry via
`HostMetadata.menuButtonRect`; the deterministic sandbox returns an explicit
zero rectangle when no host geometry is available and never fabricates a
platform-specific value.

`wx.getAppAuthorizeSetting()` is a synchronous permission snapshot. It maps
the provider's explicit permission state to the documented `authorized`,
`denied`, and `not determined` strings for camera, location, microphone,
notifications, and album access. It never prompts and an unnegotiated
capability raises `ERR_UNSUPPORTED_CAPABILITY`.

`wx.onNetworkStatusChange()` is a host-driven observer rather than a polling
fallback. A native/web adapter calls `Session::notify_network_status_change`
with the typed `NetworkType` enum; the provider snapshot used by
`wx.getNetworkType()` is updated first, then all registered callbacks receive
one cloned `{ networkType, isConnected }` payload in the same engine batch.
`wx.offNetworkStatusChange` removes one callback or clears the listener list
when no function is supplied. The sandbox never samples the machine network
and does not invent transitions.

`wx.getAccountInfoSync()` is also installed before module evaluation. The
portable provider implements the complete synchronous contract and returns a
stable `{ miniProgram: { appId, envVersion, version }, plugin }` snapshot; the
sandbox defaults to an empty app ID, `develop`, and an empty version, while
native hosts can inject the package identity through their provider.
`envVersion` is validated at the provider boundary against the documented
`develop`, `trial`, and `release` values. An invalid host snapshot returns
`ERR_INVALID_REQUEST` instead of exposing an unrecognized value as a
successful account result; the sandbox uses an empty `plugin` object in the
mini-program context; each synchronous facade call receives a cloned snapshot
so JavaScript mutations do not alter provider state. This portable full status
does not promote the seven host coverage entries, which remain partial until
each host supplies identity injection evidence.

`wx.getExtConfigSync()` is installed alongside the other synchronous provider
snapshots before module evaluation. `wx.getExtConfig()` uses the regular async
provider dispatch and callback/promise envelope. Both APIs read the same
provider-owned `{ extConfig: object }` snapshot; the deterministic sandbox
defaults to an empty `extConfig` object and exposes `with_ext_config(...)` for
conformance fixtures. The async response includes `errMsg: "getExtConfig:ok"`.

`wx.connectSocket` uses the same provider boundary. The sandbox validates a
`ws://` or `wss://` URL, allocates a deterministic `socket-N` id and resolves
the task's `onOpen` callbacks with `readyState = 1`. `SocketTask.send` records
the payload and returns `sendSocketMessage:ok`; `SocketTask.close` validates a
1000..4999 close code, transitions to `readyState = 3` and dispatches the
close code/reason. No inbound message or host network is fabricated: native
providers must supply transport, message delivery, permission and teardown
evidence before this capability can be promoted beyond `partial`.

`getFileSystemManager().access` performs an existence check against the same
in-memory file namespace used by `readFile` and `uploadFile`. Existing files
return `access:ok`; missing paths return the structured invalid-request error
`access:fail no such file or directory, access '<path>'` instead of a fabricated
success.

The synchronous manager methods (`readFileSync`, `writeFileSync`, `accessSync`,
`unlinkSync` and `readdirSync`) use a permission-scoped file snapshot installed before module
evaluation. Text and base64 reads stay in the isolate; binary reads expose an
`ArrayBuffer` when the engine provides `Uint8Array`. Writes and deletes update
the local snapshot immediately and emit one `api.sync` mutation effect for the
host provider. A provider that cannot supply a snapshot reports the stable
`ERR_UNSUPPORTED_CAPABILITY` error rather than silently using stale data.

`getFileSystemManager().readdir({ dirPath })` crosses the provider boundary in
one batch and returns `{ files, errMsg }`. The sandbox derives immediate child
names from its normalized in-memory namespace, includes directory prefixes,
sorts the result by UTF-8 order and returns an empty list for an existing or
empty directory. `readdirSync(dirPath)` applies the same projection directly
to the synchronized snapshot, so QuickJS and V8 observe identical results.

Sensitive operations require an explicit permission grant in the provider; a
denied grant produces `ERR_PERMISSION_DENIED`. Every provider operation checks
the absolute bridge deadline and cancellation token before dispatch, producing
`ERR_TIMEOUT` and `ERR_CANCELLED` consistently even for synchronous-looking
system, clipboard, observer and auth calls. An API that is present in the
manifest but has no provider implementation fails with
`ERR_UNSUPPORTED_CAPABILITY` instead of returning a fabricated `result: null`.

`wx.authorize` and `wx.openSetting` use the same provider permission state. The
sandbox validates the documented scope names, returns `authorize:ok` only for
an explicitly granted scope, and exposes a stable `authSetting` map from
`openSetting`; it never prompts or silently grants a permission.

`wx.getLocation` accepts the documented `type` values (`wgs84` and `gcj02`) and
the boolean `altitude` option. The deterministic sandbox returns zero-valued
coordinates with `latitude`, `longitude`, `speed`, `accuracy`, `altitude`,
`verticalAccuracy`, `horizontalAccuracy` and `errMsg` fields. It never exposes a
machine location; invalid options, missing permission, an expired deadline or
an active cancellation token produce the corresponding structured provider
error.

`wx.chooseMedia` and `wx.chooseImage` validate picker options before touching a
host resource: `count` must be an integer from 1 through 9, option arrays only
accept their documented values (`image`/`video`/`mix`, `album`/`camera`, or
`original`/`compressed`), and the media camera must be `front` or `back`. The
sandbox returns deterministic empty `tempFiles` and `tempFilePaths` after the
`photos/camera` permission is granted; native providers replace that selection
while preserving the same result and error shape.

`wx.createInnerAudioContext` returns a stateful context object. Property writes
(`src`, `startTime`, `autoplay`, `loop`, `volume`, `playbackRate` and
`obeyMuteSwitch`) are sent as typed `set` commands; `play`, `pause`, `stop`,
`seek` and `destroy` are batched through the `wx.innerAudioContext` provider
operation. The sandbox validates source, numeric ranges and destroyed-context
use, then reports the resulting `paused`/`currentTime` state and event name. It
does not claim to decode or output audio; a native provider owns decoder,
focus, route and resource lifetime and must preserve this result/error shape.

`wx.createVideoContext(videoId, component)` returns a component-scoped command
object. `play`, `pause`, `stop`, `seek`, `playbackRate`, `sendDanmu`,
`requestFullScreen`, `exitFullScreen`, `showStatusBar` and `hideStatusBar` are
batched through `wx.videoContext`. The sandbox validates ids, numeric ranges,
danmu text/color and fullscreen direction, then records deterministic transport
and UI state; it does not decode or render video. Native providers own decoder,
surface, orientation and resource release while preserving the same result and
error shape.

`wx.createCameraContext()` returns a context whose `takePhoto`, `startRecord`,
`stopRecord` and `onCameraFrame(...).start/stop` commands cross the
`wx.cameraContext` provider boundary. The provider validates quality, record
timeout, context lifetime and camera permission. The deterministic sandbox has
no camera device, decoder or frame source: after validation it returns a
structured `ERR_UNSUPPORTED_CAPABILITY` error, while a native provider may
replace only acquisition and resource release with real paths/frames.

<a id="模块与页面生命周期"></a>
## Module and page lifecycle

Native QuickJS/V8 sessions install `App`, `Page`, `Component` and `getApp`
registration globals before evaluating content-addressed CommonJS modules.
The host supplies one verified module batch. Factories are registered before
entry evaluation, and a shared JS registry resolves module-local `require`
through manifest-declared dependency edges without a per-dependency FFI call.
Repeated requires retain export identity; CommonJS cycles see partially
initialized exports. JSON syntax is validated by the selected engine's
`JSON.parse` before application execution, including its number and UTF-16
domain. JSON modules retain own `__proto__` properties and negative zero,
rather than using JavaScript object-literal evaluation.
Failed evaluation discards that module's export cache, while completed
dependencies retain theirs. App, page, component and unreferenced legacy batch
roots evaluate eagerly; modules declared as dependencies evaluate when reached
by `require` or an explicit `module.call`. The ESM subset uses the same registry
and evaluates dependencies in source declaration order, including re-exports.
It does not implement live bindings, dynamic import, export-star or cycles
involving ESM; unsupported syntax and ESM cycles fail explicitly. This does not add a full
Node resolution environment or access to arbitrary host files.

The standalone legacy eager loader preserves its atomic nested registration
contract. It cannot start a new registry factory inside that transaction:
the runtime rejects that mixed first evaluation with `ERR_MODULE_LOAD` before
mutating the factory cache or registration tables. Reading an already
evaluated or currently evaluating module remains supported.

When the manifest entry module is loaded, `app.init` invokes `App.onLaunch`
once with `launchOptions`. `page.push`/`page.replace` invoke the registered
page's `onLoad`, `onShow`, and first-render `onReady` in that order;
`page.pop` invokes `onUnload`. A replacement first unloads and unregisters the
old page, so delayed events or `setData` patches cannot address a disposed
registration. `reLaunch` unloads the existing page stack from top to bottom,
matching the nested page ownership order. `switchTab` unloads non-tab pages from
the top down, hides the active tab root, and retains each tab's page id, query,
and data in a session cache. Returning to a cached tab emits `onShow` without
re-running `onLoad` or allocating a new page instance. Hook return values are
carried in the same response envelope under `hooks`, so a host never needs one
FFI call per lifecycle callback. A protocol-only build reports a null hook
result and leaves execution to the selected native provider.

Each new page instance clones its registered `Page.data` and returns that
initial state to AppService in the existing page-stack batch before `onLoad`.
Defaults therefore render even when the page has no lifecycle hook or `setData`
call. Optional object `data` on `page.push`/`page.replace` shallowly overrides
those defaults once; hooks see the merged value and subsequent `setData` wins.
Existing instances are never overwritten by later stack synchronization.

Component registration also composes behavior definitions in declaration order:
`data()` factories from nested behaviors and the component are merged before
property defaults are installed, and each behavior/component `created`,
`attached`, `ready`, `moved`, `detached`, or `error` hook is retained and
invoked once in that order. `pageLifetimes` (`show`, `hide`, and `resize`) are
merged as definition records. Managed occurrences receive automatic show/hide
through the dedicated batch boundary; resize payload forwarding is tested at
the engine boundary only. This keeps behavior lifecycle hooks from being
silently replaced by a same-named component hook while preserving the existing
batch lifecycle envelope.

`getCurrentPages()` is installed as a global page-stack facade. The runtime
updates the active registration indices and each page's `route`/`options` query
snapshot before invoking a page lifecycle or event hook. Calls return the live
page objects in stack order, so `data`, `setData`, and page methods retain their
identity within the JavaScript isolate. Repeated `navigateTo` calls to the same
route receive distinct page instances (and page ids); a `setData` effect from
one instance cannot update another instance sharing the same `Page` definition.
Popped or replaced registrations are removed from the returned stack; the
protocol-only engine reports an empty stack because no JavaScript page provider
is available.

<a id="兼容性-id"></a>
## Conformance IDs

| ID | Verification |
| --- | --- |
| `storage-001` | set/get/remove/clear maintain JSON value and isolation within the same session |
| `storage-002` | Empty key is rejected, unknown key returns `found: false` |
| `storage-003` | getStorageInfo* returns a stable list of keys, size, and capacity |
| `storage-004` | QuickJS/V8 uses the same UTF-8 size calculation for `[key,value]` as mpcore, and retains the `getStorageInfo:ok` envelope |
| `storage-005` | QuickJS/V8, bridge, and AppService share storage; writes before module top level and before exception are preserved, undefined/null are not confused |
| `storage-006` | All entry points comply with capability; disable write operations that do not produce mutation, ensure async fail/complete/Promise error consistency |
| `timer-001` | timeout expires once, carries callbackId, removed after poll |
| `timer-002` | interval reschedules deadline according to explicit host clock |
| `timer-003` | clearTimeout/clearInterval stops firing after cancellation |
| `timer-004` | QuickJS/V8 executes callback/microtask through the same host poll and submits storage effects |
| `capability-001` | `wx.canIUse` shares effective capability with API dispatch |
| `api-unsupported-001` | Unsupported or undeclared API returns `ERR_UNSUPPORTED_CAPABILITY` |
| `selector-001` | Query id/class/tag and bounding geometry in tree order after `render.commit` |
| `selector-002` | descendant/child/sibling and attribute presence/equality selectors match committed tree; pseudo-classes, malformed attribute selectors, and missing committed frame respectively return `ERR_INVALID_REQUEST`/`ERR_RENDER` |
| `selector-003` | `data-*` projection to dataset, coordinate events hit the tree and generate path |
| `selector-004` | fields' rect/size/scrollOffset/id/dataset/mark/properties/computedStyle/node/context projection and malformed parameter errors |
| `selector-005` | `selectViewport()` combined with `in({ scopeId })` to query viewport/component scope |
| `event-control-001` | QuickJS/V8 handler's stopPropagation/preventDefault/cancelBubble control for capture, target, and bubbling results |
| `event-mark-001` | `mark:*`/`mark-*` inheritance, name overriding and QuickJS/V8 `event.mark` consistency |
| `observer-intersection-001` | IntersectionObserver configuration, batch bridging of observe/disconnect and input validation; independent SandboxProvider explicitly rejects forged measurements |
| `observer-intersection-002` | Session continuously subscribes to the submitted tree, covering scope, world AABB, multi-reference regions, initialRatio, threshold transition, observeAll, and native ancestor paths |
| `observer-intersection-003` | disconnect, page unload, and component detach release subscriptions, queued notifications are not leaked to old instances |
| `observer-media-001` | MediaQueryObserver descriptor validation, page/component scope and unsupported boundary with independent provider |
| `observer-media-002` | Deduplicate the first committed measurement with the real host resize matches transition, and logic viewport and subscription release |
| `nav-003` | URL query decoding, explicit query override and route/switchTab validation |
| `nav-004` | switchTab unloads non-tab pages in reverse order, hides the tab root page, and reuses cached page id and data |
| `nav-005` | `setNavigationBarTitle` passes typed provider validation, and saves the title according to the page instance; maintains the correct title upon back, replace, and tab cache restoration |
| `nav-006` | Dual-engine navigation completes callback and Promise after runtime submission; if pre-check fails, retain the original page and subsequent requests in the same batch, overriding cancellation, deadline, callback exceptions, and resumption budget (`navigation_completion.rs` and engine unit tests) |
| `canvas-001` | CanvasContext commands are batched across bridge at draw time and validated by provider |
| `canvas-002` | `setLineDash` maintains consistency of pattern, offset, odd repetition, and error semantics across QuickJS/V8, provider, and software renderer |
| `offscreen-001` | `wx.createOffscreenCanvas` validate 2d type and size, use isolated CanvasFrame for batch draw; sandbox can obtain deterministic CPU RGBA snapshot, toDataURL/GPU resource lifecycle still provided by host |
| `animation-001` | Chain operations for animations in QuickJS/V8, default value for step, complete scale/translate parameters, and clear exports to maintain consistency after export |
| `api-unsupported-007` | Failed to negotiate `wx.createAnimation` synchronously and returned `ERR_UNSUPPORTED_CAPABILITY`, and `wx.canIUse` is false |
| `view-slot-001` | Default/named slot projection, fallback, nested fallback, and behavior when `multipleSlots` is disabled |
| `style-cascade-001` | inline/WXSS importance、specificity、source order、supported shorthand's longhand competition and declaration parser boundaries |
| `style-visibility-001` | Visibility inheritance of QuickJS/V8, explicit child node override, real pixel and hit testing, unsupported winner failure frame retention; software, CPU Skia and real CanvasKit CPU validation, official slot/GPU/seven host gatekeeping separately counted |
| `style-overflow-001` | Explicit overflow descendants' pixel clipping and coordinate hit testing: dual-engine WXML/WXSS, standalone software/native Skia, single-axis/rounded/cascaded/transformed, failed frame retention; same accepted frame can be replayed onto real CanvasKit WebGL, official and scroll gatekeeping excluded |
| `style-border-001` | WXSS border shorthand/longhand cascade, content-box/border-box, border width and color for all four sides, currentColor/inheritance, transparent rounded corners with hollow center, padding-edge overflow, transformations and setData; accepted frame from dual native engines is redisplayed on CanvasKit, style explicitly failed is not supported and old frame is retained; official visual/seven host device evidence counted separately |
| `style-render-001` | QuickJS/V8 dynamic style → real tap/setData → current Page data → layout, computedStyle, RGBA pixels and hit area |
| `module-loading-001` | QuickJS/V8 CommonJS/JSON declaration dependencies, caching identity, partial exports with cycles, errors, hash/graph validation and ESM existing boundaries |
| `module-lifecycle-001` | QuickJS/V8 entry module for loading, single `App.onLaunch` and batch callback for page onLoad/onShow/onReady/onUnload |
| `component-lifecycle-002` | QuickJS/V8 behavior `data()`、same-named component/behavior lifecycle order and pageLifetimes payload distribution |
| `component-page-visibility-001` | QuickJS/V8 automatically show/hide, navigation and tab caching, app foreground/background, delayed mounting, exception isolation and reLaunch cleanup; local session testing, no elevation of official access gates |
| `page-stack-001` | `getCurrentPages()` returns the current page object, route/options query snapshot, and a stable page stack order in QuickJS/V8; invalid registrations are removed after page replacement or back navigation |
| `page-stack-002` | Same route repeatedly calling `navigateTo` generates independent page identity, data/setData, and onUnload targets, without serializing the same `Page` definition |
| `provider-system-001` | System information provided by host provider, startup options returned by app.init session state using a fixed schema |
| `provider-system-002` | getBatteryInfo returns level/isCharging, and complies with deadline/cancellation |
| `provider-system-005` | getBatteryInfoSync returns the same battery snapshot synchronously in QuickJS/V8, maintains the `getBatteryInfoSync:ok` envelope, and explicitly throws `ERR_UNSUPPORTED_CAPABILITY` when capability negotiation has not occurred |
| `provider-system-006` | getScreenBrightness/setScreenBrightness shared 0..1 typed provider state, validate device permissions, invalid values, deadline/cancellation, and maintain callback/Promise result envelope in QuickJS/V8 facade |
| `provider-system-007` | getSystemInfo/getSystemInfoSync share typed snapshot; when HostMetadata has displayMetrics, use actual screen, density, status bar, and orientation; windowWidth/Height continue to be provided by independent viewport; when no displayMetrics, retain original sandbox snapshot. Asynchronous result only additionally includes `getSystemInfo:ok` |
| `provider-system-008` | getDeviceInfo uses verified brand/model/ABI/CPU/memory/benchmark snapshot and supplements the current host's platform/system; it does not add unpublicized pixelRatio; getWindowInfo exposes screenTop from another projection, without adding windowTop. safeArea is omitted when the host has not confirmed safeArea coordinate mapping; viewport spoofing is not used; QuickJS/V8 uses the same snapshot |
| `provider-system-003` | getMenuButtonBoundingClientRect returns six stable geometric fields; HostMetadata can inject logical CSS pixels, returns zero rectangle when sandbox injection is not present |
| `provider-system-004` | getSystemSetting returns a synchronous snapshot of bluetooth/location/Wi-Fi toggle and deviceOrientation; provider deadline/cancellation is still under unified boundary validation |
| `provider-account-001` | getAccountInfoSync injected before module evaluation `{miniProgram:{appId,envVersion,version},plugin}`, sandbox provider and QuickJS/V8 facade communicate via complete synchronous contract; mini-program context uses plugin={}; accepts only develop/trial/release, returns ERR_INVALID_REQUEST for unknown envVersion, facade returns independent cloned snapshot; seven host identities injection is still recorded separately as partial |
| `provider-share-001` | wx.shareAppMessage/wx.shareTimeline keeps a single batch api.call, callback/Promise result, and public `{errMsg}` envelope in QuickJS/V8; sandbox records typed ShareRequest without faking user completion |
| `provider-share-002` | Share option type, empty path/templateId, extraData, menus, share permission, deadline/cancellation returns structured errors at the provider boundary; old snapshots are not invalidated by invalid requests |
| `provider-network-001` | validation of parameters for request/upload/download, seed response, file persistence, timeout, cancellation, and permission errors maintained in structured format |
| `provider-network-002` | validate URL, OPEN/send/close states, deterministic socket id, permissions, and close error retention in structured format; sandbox does not forge inbound messages |
| `provider-network-003` | request/upload/download Task's thenable compatibility, abort cancellation, headers listener, and success/fail/complete order are consistent between QuickJS/V8; cancellation takes precedence over the same bridge turn's provider dispatch |
| `provider-filesystem-001` | provider file read/write, UTF-8/base64, save temporary files to explicit or SHA-256 content-addressed paths, deletion and path normalization |
| `provider-filesystem-002` | md5/sha1 digest of getFileInfo, metadata of getSavedFileInfo, stable sorting and file lifecycle management of getSavedFileList |
| `provider-filesystem-003` | QuickJS/V8 synchronous file manager for reading, writing, existence checking, deletion, snapshots, and `api.sync` batch change effects |
| `provider-filesystem-004` | QuickJS/V8 `getFileSystemManager().readdir/readdirSync` directory path validation, directory prefix projection, stable sorting, and empty directory results |
| `provider-device-001` | The camera, media, and location return the corresponding result or error when explicit authorization/rejection is given |
| `provider-device-003` | validate getLocation type/altitude, return stable position result fields, and maintain permission, timeout, and cancellation error structures |
| `provider-device-004` | scanCode、startLocationUpdate/stopLocationUpdate validate camera/location permissions and parameters; sandbox returns complete empty scan result or stable `errMsg`, native provider can replace resource implementation |
| `provider-media-005` | state machine, property scope, and event outcomes for create/set/play/pause/stop/seek/destroy of inner audio context; sandbox does not spoof audio output |
| `provider-media-006` | Audio component context ID validation, batch command validation for setSrc/play/pause/seek and consistency with inner audio provider state; sandbox does not fake audio output |
| `api-unsupported-008` | Returns `ERR_UNSUPPORTED_CAPABILITY` synchronously when `wx.createInnerAudioContext` or `wx.createAudioContext` is not negotiated, and `wx.canIUse` is false |
| `provider-media-007` | video context's create/play/pause/stop/seek/playbackRate/sendDanmu/fullscreen/status-bar state machine, parameter validation, and destroy resource release; sandbox does not fake video decoding or rendering |
| `api-unsupported-009` | Returns `ERR_UNSUPPORTED_CAPABILITY` synchronously when `wx.createVideoContext` is not negotiated, and `wx.canIUse` is false |
| `provider-media-008` | camera context's create/takePhoto/startRecord/stopRecord/onCameraFrame parameter, permission, and lifecycle validation; sandbox returns a structured `ERR_UNSUPPORTED_CAPABILITY` when authorized but no device is available for capture, without faking paths or frames |
| `api-unsupported-010` | Failed to synchronously return `ERR_UNSUPPORTED_CAPABILITY` when `wx.createCameraContext` is not negotiated, and `wx.canIUse` is false |
| `api-unsupported-011` | Returns `ERR_UNSUPPORTED_CAPABILITY` synchronously when `wx.getMenuButtonBoundingClientRect` is not negotiated, and `wx.canIUse` is false |
| `api-unsupported-012` | Returns `ERR_UNSUPPORTED_CAPABILITY` synchronously when `wx.getAppAuthorizeSetting` is not negotiated, and `wx.canIUse` is false |
| `provider-auth-001` | login/profile/payment/share login/profile/payment/share through provider permissions and sandbox results |
| `provider-auth-002` | `wx.login` establishes a provider-owned session under account permission; `wx.checkSession` returns a stable session-expired error before login and `checkSession:ok` after login, and maintains the deadline/cancel/host-restored session semantics |
| `provider-auth-003` | `wx.getUserProfile` requires a non-empty `desc` under profile permission, returns complete userInfo along with rawData/signature/encryptedData/iv envelope; QuickJS/V8 facade preserves desc transparency and maintains success/complete callback order |
| `provider-payment-001` | `wx.requestPayment` validates non-empty `timeStamp`/`nonceStr`/`package`/`paySign` and `MD5`/`HMAC-SHA256`/`RSA` signType under payments permission; QuickJS/V8 facade maintains batch invocation and callback/Promise envelope; sandbox records typed PaymentRequest without contacting payment services or faking user completion |
| `provider-device-002` | clipboard, network type, vibration, and keep screen on via typed provider; network type restricted to public enum, keepScreenOn/vibration options validated and recorded to reproduce device-side side effects, clipboard/device explicitly mapped to `ERR_PERMISSION_DENIED`; QuickJS/V8 facade retains battery and clipboard success/complete callback envelope |
| `provider-device-005` | `wx.onNetworkStatusChange`/`offNetworkStatusChange` register, remove, and batch callback in QuickJS/V8; `Session::notify_network_status_change` updates the typed provider network snapshot and keeps `wx.getNetworkType` consistent with the callback payload |
| `provider-permission-001` | authorize/openSetting scope validation, explicit authorization status and stable `authSetting` return |
| `provider-permission-002` | getAppAuthorizeSetting maps the camera/location/microphone/notification/album status to authorized, denied, or not determined, and complies with deadline/cancel |
| `provider-permission-003` | `wx.getSetting`/`wx.openSetting` validates the boolean value of `withSubscriptions`; when enabled, returns injectable and validated `subscriptionsSetting.mainSwitch/itemSettings`, QuickJS/V8 facade maintains a single batch call and callback/Promise envelope |
| `ui-001` | showToast/showLoading and corresponding hide API parameter validation, state replacement, and stable `errMsg` |
| `ui-002` | showModal/showActionSheet/pageScrollTo/setNavigationBarColor return structure, input validation and provider state recording |

Rust unit test entrypoint:

```sh
cargo test -p container-core -p container-runtime
```

These tests verify the host-independent AppService/bridge semantics; they do not claim that the official WeChat Developer Tools, mobile emulator, or real device rendering has been passed.
