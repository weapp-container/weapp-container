# AppService API 语义回归

`container-core` 和 `container-runtime` 在宿主无持久化存储时提供一个
**session-scoped memory provider**。它只在 `ContainerManifestV1.capabilities`
显式声明对应 `wx.*` 项目为 `full` 或 `partial` 时开放；宿主配置会再取两者
的较低等级。这样 `wx.canIUse` 的结果与实际 dispatch 门禁保持一致。

## Storage

`wx.setStorage`、`wx.setStorageSync`、`wx.getStorage`、
`wx.getStorageSync`、`wx.removeStorage`、`wx.removeStorageSync`、
`wx.clearStorage`、`wx.clearStorageSync`、`wx.getStorageInfo` 和
`wx.getStorageInfoSync` 共享同一个会话内
`MemoryStorage`。QuickJS/V8 的本地存储镜像通过批量
`storage.patch.batch` effect 合入 AppService；每次执行脚本前恢复宿主快照，
因此 bridge 写入、模块顶层写入、回调写入和异常前的写入都可相互观察。
所有同步和异步入口都检查同一份 capability，禁止 `canIUse` 返回 false 后继续写入。
`set`、`remove`、`clear` 都产生 `RuntimeEvent::StorageChanged`。

JSON 值使用 `snapshot()` 保存；需要保留 JavaScript `undefined` 时，宿主应使用
`snapshot_state()` / `restore_state()`。这个版本化前的内部快照用 `values` 与
`undefinedKeys` 区分显式 `undefined`、JSON `null` 和缺失 key，不把哨兵对象暴露给小程序。

`getStorageInfo*` 返回排序稳定的 `keys`、以 KiB 向上取整的 `currentSize`
和 10 MiB 的 `limitSize`；currentSize 按每个 `[key, value]` JSON pair 的
UTF-8 字节数计算，异步形式还带 `getStorageInfo:ok` envelope 并遵守
success/fail/complete 回调和 Promise 双形态。

同步读取遵循微信和 `@mpcore/simulator` 的缺失值约定：
`wx.getStorageSync(key)` 在 key 不存在时返回空字符串 `""`，不会抛出
`data not found` 异常。若调用方显式写入 `undefined`，该值仍保持
`undefined`，因此实现通过存储键存在性而不是返回值判定缺失。

请求示例：

```json
{"name":"wx.setStorage","key":"greeting","data":{"text":"hello"}}
```

响应的 `result` 和顶层字段均保持批量 bridge 的 JSON 形式。异步读取不存在的 key
返回 `ok: false`、`found: false`、`data: null` 与结构化
`ERR_INVALID_REQUEST` / `wx.getStorage:fail data not found`；JavaScript 端执行
fail/complete 并拒绝 Promise。同步读取的 `result` 是原始值，缺失时为 `""`。
同步 set/remove/clear 的 `result: null` 表示 JSON 边界上的 undefined 返回值。
显式保存 undefined 仍是成功读取，bridge 以 `found: true`、`undefined: true`
标记，JavaScript 端返回真实 undefined；null 与缺失 key 分别处理。

## Launch options

`app.init` 的 `launchOptions` 会在 session 中保存为同一份 JSON 对象，并在
App.onLaunch、后续 App.onShow、`wx.getLaunchOptionsSync` 以及
`wx.getEnterOptionsSync` 中复用。模块在
`app.init` 载入阶段调用同步 API 也会看到该快照；重复的 `app.init` 只有在显式
传入新对象时才更新它。缺省快照保持微信常见的 `{ path: "", query: {},
referrerInfo: {}, scene: 1001 }` 形状，非对象输入会返回
`ERR_INVALID_REQUEST`。

## Device snapshot

`wx.getBatteryInfo` 和 `wx.getBatteryInfoSync` 通过同一个 typed host provider
边界返回 `{ level, isCharging, errMsg }`，其中 `level` 固定在 `0..100`。
异步形式使用 `getBatteryInfo:ok`，同步形式使用 `getBatteryInfoSync:ok`，且同步
调用在模块求值前由 runtime 注入 provider 快照，不产生 bridge 请求。默认
`SandboxProvider` 使用可复现的 `100%`、非充电快照；测试和宿主适配器可以
通过 provider 的电池配置注入其他状态。请求在 provider 入口统一检查
deadline 和 cancellation，过期或取消时返回 `ERR_TIMEOUT` 或 `ERR_CANCELLED`，
不会伪造成功结果。真实设备 provider 应从系统电池服务提供同样字段，并在
没有系统能力时让 capability 协商结果降为 `unsupported`。

`wx.getScreenBrightness` 和 `wx.setScreenBrightness` 共享同一个 typed provider
状态。`value` 必须是有限的 `0..1` 数字；读取返回
`{ value, errMsg: "getScreenBrightness:ok" }`，写入返回
`{ errMsg: "setScreenBrightness:ok" }`。设备权限、deadline 和 cancellation
在 provider 入口统一校验，sandbox 默认亮度为 `1`，宿主可以注入真实显示服务
并在不支持时将 capability 协商为 `unsupported`。

## Timers

`setTimeout`、`setInterval`、`clearTimeout`、`clearInterval` 使用
`TimerScheduler`。调度器不创建 native 线程，由宿主在事件循环中调用
`Session::poll_timers(now_ns)`；返回的单个 `event.batch` 包含所有到期 timer
及其 `timerId`、`kind`、`firedNs`、`callbackId`。一次 poll 对 interval 只产生
一次 firing，并从当前 host clock 重新计算下一次 deadline，避免暂停后出现
无界追赶批次。清除未知 timer 是幂等的，并返回 `cancelled: false`。

真实 QuickJS/V8 中的全局定时器由所选引擎保存 callback。相同的
`poll_timers` 入口按毫秒 host clock 批量执行 JS timer，清空 microtask 并提交
storage、setData 和 API effects；trace 分别标记为 `quickjs.timer` 和 `v8.timer`。
回调执行前同步最新宿主 storage 快照，因此 bridge 写入后立即触发的定时器
不会读取旧镜像。没有到期回调时不发出空的 engine timer trace。

## Capability and error contract

`wx.canIUse` 从 manifest 与宿主 capability 的协商结果计算，未知或
`unsupported` 项返回 `result: false`。其它 API 在同一状态下返回
`payload.error.code = "ERR_UNSUPPORTED_CAPABILITY"`；不会静默返回空值。

## Sharing

`wx.shareAppMessage` 和 `wx.shareTimeline` 都通过同一批量 provider 边界传递
分享选项。QuickJS/V8 facade 在进入 bridge 前拒绝 `null`、数组和其它非对象
参数并返回 `ERR_INVALID_REQUEST`；sandbox provider 继续校验可选的字符串字段、
`extraData` 对象以及 `menus` 字符串数组，过期、取消和显式 `share` 权限拒绝
沿用统一错误码。成功结果只包含公开的 `{ errMsg: "wx.share*:ok" }` 结构，
provider 另外保存一个 typed `ShareRequest` 快照供 conformance 和 native host
适配器读取。sandbox 不打开系统分享面板，也不把请求记录当作用户已完成分享；
真实平台 provider 需要自行接入系统分享生命周期。

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

QuickJS/V8 提供 `wx.createCanvasContext` 的批量 2D 命令上下文。属性设置和
绘制方法只追加到本地命令队列；`draw(reserve?, callback?)` 才发出一个
`wx.canvas.draw` bridge 请求，携带 `canvasId`、`reserve` 和完整命令数组。
Sandbox provider 会校验命令操作名和参数形状；runtime 随后将同一批命令转换
为 `container-render-skia::CanvasFrame`，在一个 renderer 边界内重放并保存按
`canvasId` 寻址的 RGBA8 snapshot。`reserve:false` 替换该 canvas 的命令历史，
`reserve:true` 追加历史，宿主可以通过 `canvas_snapshot_json(canvasId)` 一次性
取回完整像素缓冲。软件路径支持颜色、矩形、路径、变换、文本、线帽/线连接样式
（`setLineCap`、`setLineJoin`、`setMiterLimit`）、虚线样式
（`setLineDash(pattern, offset?)`）和状态栈；奇数长度 pattern 按 Canvas 2D
规则重复一次，负数或非有限值在 provider 边界返回 `ERR_INVALID_REQUEST`，渲染器
按 dash/间隔交替生成笔画。已知但还没有资源生命周期契约的 `drawImage`、阴影和
文本对齐命令会返回明确的 `ERR_RENDER`，不会静默丢弃绘制。未声明 capability 时创建 context 立即返回
`ERR_UNSUPPORTED_CAPABILITY`，不会伪造绘制成功。

## Animation

`wx.createAnimation` 在 QuickJS 和 V8 中提供与 `weapp-vite` WebAnimation polyfill
一致的本地链式对象。属性变换（包括 `opacity`、尺寸、平移、旋转、缩放、矩阵、
颜色和 skew）只追加到当前步骤；`step(options)` 将操作批量封装为
`{ animates, option }`。每个导出的 step 都会物化四个微信默认选项：
`delay: 0`、`duration: 400`、`timingFunction: "linear"` 和
`transformOrigin: "50% 50% 0"`，调用者传入的同名值会覆盖对应默认值；`export()` 返回
`{ actions: [...] }` 并清空已导出的队列。`scale(x)` 和 `translate(x)` 分别按
微信行为补齐为 `(x, x)` 和 `(x, 0)`。

该 API 的 JS 语义不产生逐操作 bridge 请求；导出的 JSON 可通过 `setData` 进入
View/Renderer。能力仍标记为 `partial`，因为各宿主还需要提供逐帧时钟、CSS/Skia
变换插值和动画取消/资源释放证据。若协商结果为 `unsupported`，创建对象会同步
抛出 `ERR_UNSUPPORTED_CAPABILITY`，并且 `wx.canIUse('wx.createAnimation')`
返回 `false`，不会返回一个静默空对象。

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
the accepted frame. See [visibility](visibility.md) for the bounded grammar,
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
receives input on its outer rounded border. The [border contract](wxss-borders.md)
defines shared sizing and geometry. Full CSS overflow parity still requires
overflow-clip-margin, fixed-position escape rules,
actual scrolling and official DevTools visual comparison remain incomplete.
The `overflow-clipping` runtime fixture emits accepted frames for replay by
`scripts/overflow-clipping-browser-smoke.mjs`; browser WebGL readback does not
establish physical GPU/device or performance acceptance.

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

See [public sources and the blocked native probe](archived-evidence.md).
The probe holds the machine lease and uses one owned native project; an
already-running DevTools host was preserved, and the attempt collected no
runtime results. Relations, complete selection/export semantics,
plugin/npm component resolution, full property rules, style isolation and
complete host semantics remain incomplete. Component/slot coverage stays
partial; no official conformance case or host gate is promoted by local tests.

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
[`lifecycle-compare.json`](archived-evidence.md):
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

## Conformance IDs

| ID | 验证 |
| --- | --- |
| `storage-001` | set/get/remove/clear 在同一 session 内保持 JSON 值和隔离性 |
| `storage-002` | 空 key 被拒绝，未知 key 返回 `found: false` |
| `storage-003` | getStorageInfo* 返回稳定 key 列表、大小和容量 |
| `storage-004` | QuickJS/V8 与 mpcore 使用相同的 `[key,value]` UTF-8 大小计算，并保留 `getStorageInfo:ok` envelope |
| `storage-005` | QuickJS/V8、bridge 与 AppService 共享存储；模块顶层和异常前的写入保持，undefined/null 不混淆 |
| `storage-006` | 所有入口遵守 capability；禁用写入不产生 mutation，异步 fail/complete/Promise 错误一致 |
| `timer-001` | timeout 到期一次、携带 callbackId，poll 后移除 |
| `timer-002` | interval 按显式 host clock 重排 deadline |
| `timer-003` | clearTimeout/clearInterval 取消后不再产生 firing |
| `timer-004` | QuickJS/V8 通过同一 host poll 执行 callback/microtask，并提交 storage effects |
| `capability-001` | `wx.canIUse` 与 API dispatch 共享 effective capability |
| `api-unsupported-001` | 未声明或 unsupported API 返回 `ERR_UNSUPPORTED_CAPABILITY` |
| `selector-001` | `render.commit` 后按树顺序查询 id/class/tag 与 bounding geometry |
| `selector-002` | descendant/child/sibling 与属性 presence/equality 选择器命中已提交树；伪类、malformed 属性选择器和缺少 committed frame 分别返回 `ERR_INVALID_REQUEST`/`ERR_RENDER` |
| `selector-003` | `data-*` 投影为 dataset，坐标事件命中树并生成 path |
| `selector-004` | fields 的 rect/size/scrollOffset/id/dataset/mark/properties/computedStyle/node/context 投影及 malformed 参数错误 |
| `selector-005` | `selectViewport()` 与 `in({ scopeId })` 的 viewport/组件作用域查询 |
| `event-control-001` | QuickJS/V8 handler 的 stopPropagation/preventDefault/cancelBubble 控制捕获、目标和冒泡结果 |
| `event-mark-001` | `mark:*`/`mark-*` 继承、同名覆盖和 QuickJS/V8 `event.mark` 一致性 |
| `observer-intersection-001` | IntersectionObserver 配置、observe/disconnect 批量桥接及输入校验；独立 SandboxProvider 明确拒绝伪造测量 |
| `observer-intersection-002` | Session 持续订阅已提交树，覆盖 scope、world AABB、多参照区域、initialRatio、threshold transition、observeAll 和 native 祖先路径 |
| `observer-intersection-003` | disconnect、页面 unload 和组件 detach 释放订阅，已排队通知不泄露到旧实例 |
| `observer-media-001` | MediaQueryObserver descriptor 校验、page/component scope 与独立 provider 的 unsupported 边界 |
| `observer-media-002` | 首次 committed measurement 与真实 host resize 的 matches transition 去重、逻辑 viewport 和订阅释放 |
| `nav-003` | URL query 解码、显式 query 覆盖和 route/switchTab 校验 |
| `nav-004` | switchTab 逆序卸载非 tab 页面、隐藏 tab 根页面，并复用缓存的 page id 与 data |
| `nav-005` | `setNavigationBarTitle` 经过 typed provider 校验，并按页面实例保存标题；返回、替换和 tab 缓存恢复后保持正确标题 |
| `nav-006` | 双引擎导航在 runtime 提交后完成回调与 Promise；前置校验失败保留原页和同批后续请求，覆盖取消、deadline、回调异常及续传预算（`navigation_completion.rs` 与 engine 单测） |
| `canvas-001` | CanvasContext 命令在 draw 时单批跨 bridge，并由 provider 校验 |
| `canvas-002` | `setLineDash` 在 QuickJS/V8、provider 和软件 renderer 间保持 pattern、offset、奇数重复和错误语义一致 |
| `offscreen-001` | `wx.createOffscreenCanvas` 校验 2d 类型和尺寸，使用隔离 CanvasFrame 批量 draw；sandbox 可取得确定性 CPU RGBA snapshot，toDataURL/GPU 资源生命周期仍由宿主提供 |
| `animation-001` | QuickJS/V8 的动画链式操作、step 默认值、scale/translate 参数补齐和 export 后清空保持一致 |
| `api-unsupported-007` | 未协商 `wx.createAnimation` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `view-slot-001` | 默认/具名 slot 投影、fallback、嵌套 fallback 和 `multipleSlots` 关闭时的行为 |
| `style-cascade-001` | inline/WXSS importance、specificity、source order、受支持 shorthand 的 longhand 竞争和 declaration parser 边界 |
| `style-visibility-001` | QuickJS/V8 的可见性继承、显式子节点覆盖、真实像素与命中、unsupported winner 失败帧保留；software、CPU Skia 和真实 CanvasKit CPU 验证，官方 slot／GPU／七宿主门禁另计 |
| `style-overflow-001` | explicit overflow 的后代像素裁剪与坐标命中：双引擎 WXML/WXSS、独立 software/native Skia、单轴/圆角/嵌套/变换、失败帧保留；同一 accepted frame 可重放到真实 CanvasKit WebGL，官方及滚动门禁另计 |
| `style-border-001` | WXSS border shorthand/longhand 级联、content-box/border-box、四边宽色、currentColor/继承、圆角透明内孔、padding-edge overflow、变换和 setData；双原生引擎的 accepted frame 重放到 CanvasKit，未支持样式明确失败并保留旧帧；官方视觉/七宿主设备证据另计 |
| `style-render-001` | QuickJS/V8 动态 style → 真实 tap/setData → 当前 Page 数据 → 布局、computedStyle、RGBA 像素与命中范围 |
| `module-loading-001` | QuickJS/V8 CommonJS/JSON 声明依赖、缓存身份、循环 partial exports、错误、hash/graph 校验和 ESM 既有边界 |
| `module-lifecycle-001` | QuickJS/V8 加载入口模块、单次 `App.onLaunch` 与页面 onLoad/onShow/onReady/onUnload 批量回调 |
| `component-lifecycle-002` | QuickJS/V8 behavior `data()`、同名 component/behavior 生命周期顺序和 pageLifetimes payload 分发 |
| `component-page-visibility-001` | QuickJS/V8 自动 show/hide、导航与 tab 缓存、App 前后台、晚挂载、异常隔离和 reLaunch 清理；本地 Session 测试，不提升官方门禁 |
| `page-stack-001` | `getCurrentPages()` 在 QuickJS/V8 返回当前页面对象、route/options 查询快照和稳定页面栈顺序；页面替换/返回后移除失效注册 |
| `page-stack-002` | 同一路由重复 `navigateTo` 产生独立 page identity、data/setData 与 onUnload 目标，不串写相同 `Page` 定义 |
| `provider-system-001` | 系统信息由 host provider、启动选项由 app.init session state 以固定 schema 返回 |
| `provider-system-002` | getBatteryInfo 返回 level/isCharging，且遵守 deadline/cancellation |
| `provider-system-005` | getBatteryInfoSync 在 QuickJS/V8 中同步返回同一电池快照，保持 `getBatteryInfoSync:ok` envelope，且 capability 未协商时显式抛出 `ERR_UNSUPPORTED_CAPABILITY` |
| `provider-system-006` | getScreenBrightness/setScreenBrightness 共享 0..1 typed provider 状态，校验设备权限、无效值、deadline/cancellation，并在 QuickJS/V8 facade 中保持 callback/Promise 结果 envelope |
| `provider-system-007` | getSystemInfo/getSystemInfoSync 共享 typed snapshot；HostMetadata 有 displayMetrics 时采用实际屏幕、密度、状态栏与方向，windowWidth/Height 继续由独立 viewport 提供；无 displayMetrics 时保留原 sandbox snapshot。异步结果仅额外带 `getSystemInfo:ok` |
| `provider-system-008` | getDeviceInfo 使用校验过的 brand/model/ABI/CPU/memory/benchmark 快照并补入当前 host 的 platform/system，不添加未公开的 pixelRatio；getWindowInfo 另投影公开 screenTop，不添加 windowTop。宿主未确认 safeArea 坐标映射时省略 safeArea，不用 viewport 伪造；QuickJS/V8 使用相同快照 |
| `provider-system-003` | getMenuButtonBoundingClientRect 返回六个稳定几何字段；HostMetadata 可注入逻辑 CSS 像素，sandbox 无注入时返回零矩形 |
| `provider-system-004` | getSystemSetting 以同步快照返回 bluetooth/location/Wi-Fi 开关和 deviceOrientation；provider deadline/cancellation 仍在统一边界校验 |
| `provider-account-001` | getAccountInfoSync 在模块求值前注入 `{miniProgram:{appId,envVersion,version},plugin}`，sandbox provider 与 QuickJS/V8 facade 通过完整同步契约；mini-program context 使用 plugin={}；仅接受 develop/trial/release，未知 envVersion 返回 ERR_INVALID_REQUEST，facade 返回独立克隆快照；七宿主身份注入仍单独记录为 partial |
| `provider-share-001` | wx.shareAppMessage/wx.shareTimeline 在 QuickJS/V8 中保持单次批量 api.call、callback/Promise 结果和公开 `{errMsg}` envelope；sandbox 记录 typed ShareRequest 而不伪造用户完成 |
| `provider-share-002` | 分享选项类型、空 path/templateId、extraData、menus、share 权限、deadline/cancellation 在 provider 边界返回结构化错误，旧快照不会被无效请求覆盖 |
| `provider-network-001` | request/upload/download 的参数校验、seed 响应、文件落盘、超时、取消和权限错误保持结构化 |
| `provider-network-002` | connectSocket/SocketTask 的 URL 校验、OPEN/send/close 状态、确定性 socket id、权限和关闭错误保持结构化；sandbox 不伪造 inbound 消息 |
| `provider-network-003` | request/upload/download Task 的 thenable 兼容、abort 取消、headers listener 和 success/fail/complete 顺序在 QuickJS/V8 中一致；取消优先于同一 bridge turn 的 provider dispatch |
| `provider-filesystem-001` | provider 文件读写、UTF-8/base64、保存临时文件到显式或 SHA-256 内容寻址路径、删除和路径归一化 |
| `provider-filesystem-002` | getFileInfo 的 md5/sha1 摘要、getSavedFileInfo 元数据，以及 getSavedFileList 的稳定排序和保存文件生命周期 |
| `provider-filesystem-003` | QuickJS/V8 同步文件管理器读取、写入、存在性检查、删除、快照和 `api.sync` 批量变更效果 |
| `provider-filesystem-004` | QuickJS/V8 `getFileSystemManager().readdir/readdirSync` 的 dirPath 校验、目录前缀投影、稳定排序和空目录结果 |
| `provider-device-001` | 相机、媒体和定位在显式授权/拒绝时返回对应结果或错误 |
| `provider-device-003` | getLocation 校验 type/altitude，返回稳定位置结果字段，并保持权限、超时和取消错误结构 |
| `provider-device-004` | scanCode、startLocationUpdate/stopLocationUpdate 校验相机/位置权限和参数；sandbox 返回完整空扫码结果或稳定 `errMsg`，native provider 可替换资源实现 |
| `provider-media-005` | inner audio context 的 create/set/play/pause/stop/seek/destroy 状态机、属性范围和事件结果；sandbox 不伪造音频输出 |
| `provider-media-006` | audio component context 的 id 校验、setSrc/play/pause/seek 批量命令与 inner audio provider 状态一致性；sandbox 不伪造音频输出 |
| `api-unsupported-008` | 未协商 `wx.createInnerAudioContext` 或 `wx.createAudioContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-media-007` | video context 的 create/play/pause/stop/seek/playbackRate/sendDanmu/fullscreen/status-bar 状态机、参数校验和 destroy 资源释放；sandbox 不伪造视频解码或渲染 |
| `api-unsupported-009` | 未协商 `wx.createVideoContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-media-008` | camera context 的 create/takePhoto/startRecord/stopRecord/onCameraFrame 参数、权限和生命周期校验；sandbox 对获权但无设备的采集返回结构化 `ERR_UNSUPPORTED_CAPABILITY`，不伪造路径或帧 |
| `api-unsupported-010` | 未协商 `wx.createCameraContext` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `api-unsupported-011` | 未协商 `wx.getMenuButtonBoundingClientRect` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `api-unsupported-012` | 未协商 `wx.getAppAuthorizeSetting` 时同步返回 `ERR_UNSUPPORTED_CAPABILITY`，且 `wx.canIUse` 为 false |
| `provider-auth-001` | login/profile/payment/share 通过 provider 权限和 sandbox 结果 |
| `provider-auth-002` | `wx.login` 在 account permission 下建立 provider-owned session；`wx.checkSession` 在登录前返回稳定 session-expired 错误、登录后返回 `checkSession:ok`，并保持 deadline/cancel/host-restored session 语义 |
| `provider-auth-003` | `wx.getUserProfile` 在 profile permission 下要求非空 `desc`，返回完整 userInfo 与 rawData/signature/encryptedData/iv envelope；QuickJS/V8 facade 保持 desc 透传和 success/complete 顺序 |
| `provider-payment-001` | `wx.requestPayment` 在 payments permission 下校验非空 `timeStamp`/`nonceStr`/`package`/`paySign` 与 `MD5`/`HMAC-SHA256`/`RSA` signType，QuickJS/V8 facade 保持单次批量调用和 callback/Promise envelope；sandbox 记录 typed PaymentRequest，不联系支付服务或伪造用户完成 |
| `provider-device-002` | clipboard、网络类型、震动和保持屏幕常亮通过 typed provider；网络类型限定为公开枚举，keepScreenOn/震动选项校验后记录可复现设备副作用，clipboard/device 显式拒绝映射为 `ERR_PERMISSION_DENIED`；QuickJS/V8 facade 保持 battery 与 clipboard success/complete callback envelope |
| `provider-device-005` | `wx.onNetworkStatusChange`/`offNetworkStatusChange` 在 QuickJS/V8 注册、移除和批量回调；`Session::notify_network_status_change` 更新 typed provider 网络快照，并保持 `wx.getNetworkType` 与 callback payload 一致 |
| `provider-permission-001` | authorize/openSetting scope 校验、显式授权状态和稳定 `authSetting` 返回 |
| `provider-permission-002` | getAppAuthorizeSetting 将 camera/location/microphone/notification/album 状态映射为 authorized、denied 或 not determined，并遵守 deadline/cancel |
| `provider-permission-003` | `wx.getSetting`/`wx.openSetting` 校验 `withSubscriptions` 布尔值；启用时返回可注入且校验过的 `subscriptionsSetting.mainSwitch/itemSettings`，QuickJS/V8 facade 保持单次批量调用和 callback/Promise envelope |
| `ui-001` | showToast/showLoading 与对应 hide API 的参数校验、状态替换和稳定 `errMsg` |
| `ui-002` | showModal/showActionSheet/pageScrollTo/setNavigationBarColor 的返回结构、输入校验和 provider 状态记录 |

Rust 单元测试入口：

```sh
cargo test -p container-core -p container-runtime
```

这些测试验证 host-independent AppService/bridge 语义；它们不宣称官方微信
开发者工具、移动模拟器或真机渲染已经通过。
